// One HTTP server: the PWA's files, and one WebSocket that carries everything else. Keeping all
// traffic on the socket is the relay seam: a relay later forwards this one stream (encrypted)
// and nothing about the app changes.
import fs from "node:fs";
import http from "node:http";
import module from "node:module";
import path from "node:path";
import { WebSocketServer } from "ws";
import { tokenMatches } from "./config.ts";
import type { Phone } from "./local-control.ts";
import { browse, macConsent, makeFolder, recentFolders } from "./folders.ts";
import type { RecentSource } from "./folders.ts";
import { gitInfo } from "./worktree.ts";
import { ATTACHMENT_CAP, FRAME_CAP, PING_MS, STALE_MS } from "./protocol.ts";
import type { BlobChunk, ClientMsg, HostInfo, HostMsg, ProviderGroup, ReqOp, RippleStatus } from "./protocol.ts";
import { SEEN_MS, VISIBLE_MS } from "./push.ts";
import type { Notifier } from "./push.ts";
import { OutcomeUnknownError } from "./receipts.ts";
import { rippleStatus } from "./router.ts";
import type { RouterClient } from "./router.ts";
import type { Sessions } from "./sessions.ts";

/** Stop writing to a client whose socket has this much queued; its pump resumes when it drains. */
const HIGH_WATER = 1024 * 1024;
/** A reconnecting client further behind than this many frames gets the tail instead of a replay. */
const CATCHUP_FRAMES = 4;
/** `/api/limits` makes the router read each provider's quota; once a minute is plenty for percentages. */
const LIMITS_MS = 60_000;
const BLOB_CHUNK_CHARS = 60_000;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".ts": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json",
};

export const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";
const require = module.createRequire(import.meta.url);
/** Published path → file, for what the PWA loads from outside web/. The relay's build serves the same paths. */
export const SHARED: Record<string, (pkgDir: string) => string> = {
  "src/protocol.ts": (pkg) => path.join(pkg, "src", "protocol.ts"),
  "src/tool-details.ts": (pkg) => path.join(pkg, "src", "tool-details.ts"),
  "src/e2ee.ts": (pkg) => path.join(pkg, "src", "e2ee.ts"),
  "vendor/nacl-fast.min.js": () => require.resolve("tweetnacl/nacl-fast.min.js"),
};

export interface ServerOptions {
  listen: string;
  port: number;
  token: string;
  webDir: string;
  sessions: Sessions;
  /** `limits` and `modSettings` feed `HostInfo.ripple`; a router without them just leaves it out. */
  router: Pick<RouterClient, "models" | "status"> & Partial<Pick<RouterClient, "limits" | "modSettings">>;
  hostName: string;
  version: string;
  recentCli: () => Promise<RecentSource[]>;
  log?: (line: string) => void;
  push?: Pick<Notifier, "subscribe" | "unsubscribe"> & { publicKey: string };
  expoPush?: { subscribe(clientId: string, token: string, lang: "ko" | "en", platform?: "ios" | "android", key?: string): void; unsubscribe(clientId: string): void };
  local?: { handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> };
  pushDevices?: () => string[];
  clearPush?: () => void;
  now?: () => number;
}

/**
 * A phone connection: a `ws` socket on the direct path, or a decrypted channel through the relay
 * (relay.ts). Both carry the same JSON frames, so everything below is the same for either.
 */
export interface Peer {
  readonly readyState: number;
  readonly OPEN: number;
  readonly bufferedAmount: number;
  send(text: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "message" | "close" | "error", fn: (data?: unknown) => void): unknown;
}

interface Client {
  ws: Peer;
  authed: boolean;
  /** the phone's own id from hello: one push subscription per device */
  clientId: string;
  /** last time this client said the app is visible; 0 once it said hidden */
  visibleAt: number;
  lastRx: number;
  /** session → last seq sent to this client */
  attached: Map<string, number>;
  pumping: Set<string>;
}

export class HostServer {
  private opts: ServerOptions;
  private http: http.Server;
  private wss: WebSocketServer;
  private clients = new Set<Client>();
  private localHttp: http.Server | null = null;
  private lastSeen = new Map<string, number>();

  phones(): Phone[] {
    const push = new Set(this.opts.pushDevices?.() ?? []);
    const phones = new Map<string, Phone>([...push].map(clientId => [clientId, { clientId, connected: false, lastSeen: this.lastSeen.get(clientId) ?? null, push: true }]));
    for (const c of this.clients) {
      if (!c.authed || !c.clientId || c.ws.readyState !== c.ws.OPEN) continue;
      const prior = phones.get(c.clientId);
      phones.set(c.clientId, { clientId: c.clientId, connected: true, lastSeen: Math.max(prior?.lastSeen ?? 0, c.lastRx), push: push.has(c.clientId) });
    }
    return [...phones.values()];
  }

  rotateToken(token: string): void {
    this.opts.token = token;
    for (const c of this.clients) {
      if (!c.authed) continue;
      c.authed = false;
      c.attached.clear();
      c.ws.terminate();
      this.clients.delete(c);
    }
    this.uploads.clear();
    this.seenAt.clear();
    this.lastSeen.clear();
    this.opts.clearPush?.();
  }
  private stripped = new Map<string, { mtime: number; body: string }>();
  private models: { at: number; data: ProviderGroup[] } | null = null;
  private uploads = new Map<string, { data: string; at: number }>();
  private hostInfo: HostInfo;
  private limitsBody: unknown = null;
  private limitsAt = -Infinity;
  private timers: ReturnType<typeof setInterval>[] = [];
  private sessionsTimer: ReturnType<typeof setTimeout> | null = null;
  /** session → last time a connected phone looked at it (attach, or visible presence while
   * attached). Push goes out only when nobody looked in the last SEEN_MS (Paseo's
   * agent-attention-policy PRESENCE_THRESHOLD_MS, 180 s). */
  private seenAt = new Map<string, number>();

  constructor(opts: ServerOptions) {
    this.opts = opts;
    const desktopProblem = opts.sessions.desktopProblem?.();
    this.hostInfo = { name: opts.hostName, version: opts.version, routerOk: true, ...(desktopProblem ? { desktopProblem } : {}) };
    this.http = http.createServer((req, res) => this.serve(req, res));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: FRAME_CAP });
    this.http.on("upgrade", (req, socket, head) => {
      if (new URL(req.url ?? "/", "http://x").pathname !== "/ws" || !this.sameOrigin(req)) { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.connected(ws));
    });
  }

  /** A page on another origin in this machine's browser must not drive the socket, token or not. */
  private sameOrigin(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  /** True while a connected phone reported the app visible within VISIBLE_MS: then nobody needs a push. */
  someoneLooking(): boolean {
    const now = this.now();
    for (const c of this.clients) if (c.authed && c.visibleAt > 0 && now - c.visibleAt < VISIBLE_MS && c.ws.readyState === c.ws.OPEN) return true;
    return false;
  }

  /** True while a connected phone looked at this session in the last SEEN_MS: then it needs no push. */
  sessionSeenRecently(session: string): boolean {
    return this.now() - (this.seenAt.get(session) ?? 0) < SEEN_MS;
  }

  private markSeen(c: Client, session: string): void {
    if (!c.authed) return;
    this.seenAt.set(session, this.now());
    if (this.seenAt.size > 500) {
      const cutoff = this.now() - SEEN_MS;
      for (const [id, at] of this.seenAt) if (at < cutoff) this.seenAt.delete(id);
    }
  }

  private now(): number { return (this.opts.now ?? Date.now)(); }

  private desktopTicks = 0;

  private pollDesktop(): void {
    // The desktop poll runs on its own timer even with no phone connected, so a Mac session that
    // finishes while nobody watches still appends its result — and the push for it goes out. Each
    // tick also asks Remote Control for every live Mac session's state over the network, so with no
    // phone looking it runs every fifth tick (15 s) rather than every 3 s, around the clock.
    if (!this.someoneLooking() && this.desktopTicks++ % 5 !== 0) return;
    void this.opts.sessions.pollDesktop().catch(error => {
      this.opts.log?.(`desktop poll failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.opts.port, this.opts.listen, () => {
        this.http.off("error", reject);
        this.timers.push(setInterval(() => this.reapStale(), PING_MS));
        this.timers.push(setInterval(() => void this.checkRouter(), 15_000));
        this.timers.push(setInterval(() => this.pollDesktop(), 3000));
        void this.checkRouter();
        resolve();
      });
    });
    // A specific LAN/Tailscale/IPv6 bind does not receive 127.0.0.1 traffic. Keep its public
    // interface unchanged and add only a loopback control listener on the same port.
    if (this.opts.local && this.opts.listen !== "127.0.0.1" && this.opts.listen !== "localhost" && this.opts.listen !== "0.0.0.0" && this.opts.listen !== "::") {
      const local = http.createServer((req, res) => {
        try {
          const pathname = new URL(req.url ?? "/", "http://local").pathname;
          if (!pathname.startsWith("/local/")) { res.writeHead(404).end(); return; }
        } catch { res.writeHead(400).end(); return; }
        this.serve(req, res);
      });
      this.localHttp = local;
      try {
        await new Promise<void>((resolve, reject) => {
          local.once("error", reject);
          local.listen(this.address().port, "127.0.0.1", () => { local.off("error", reject); resolve(); });
        });
      } catch (error) { await this.close(); throw error; }
    }
  }

  close(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    if (this.sessionsTimer) clearTimeout(this.sessionsTimer);
    this.sessionsTimer = null;
    for (const c of this.clients) c.ws.terminate();
    return Promise.all([this.http, this.localHttp].filter((server): server is http.Server => server !== null)
      .map(server => new Promise<void>(resolve => server.close(() => resolve())))).then(() => {});
  }

  address(): { port: number } { return this.http.address() as { port: number }; }

  // ---- session events in, frames out ---------------------------------------------------------

  /** Called for every appended event: push it to every client attached to that session. */
  onEvent(session: string): void {
    for (const c of this.clients) if (c.authed && c.attached.has(session)) this.pump(c, session);
  }

  /** Session list changed (state, pending count, a new one). Coalesced; lists are small but frequent. */
  onSessions(): void {
    if (this.sessionsTimer) return;
    this.sessionsTimer = setTimeout(() => {
      this.sessionsTimer = null;
      try {
        const msg: HostMsg = { t: "sessions", sessions: this.opts.sessions.list(), groups: this.opts.sessions.groups() };
        for (const c of this.clients) if (c.authed) this.send(c, msg);
      } catch (error) {
        this.opts.log?.(`session list failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 150);
  }

  private pump(c: Client, session: string): void {
    if (c.pumping.has(session)) return;
    c.pumping.add(session);
    try {
      const log = this.opts.sessions.log(session);
      for (;;) {
        const after = c.attached.get(session);
        if (after === undefined || after >= log.lastSeq) break;
        if (c.ws.bufferedAmount > HIGH_WATER) { setTimeout(() => this.pump(c, session), 200); break; }
        const page = log.readAfter(after);
        // Skipped (superseded) deltas can leave a page empty; the cursor still moves to the end.
        const last = page.events.length ? page.events[page.events.length - 1]!.seq : log.lastSeq;
        c.attached.set(session, page.more ? last : Math.max(last, log.lastSeq));
        if (page.events.length) this.send(c, { t: "events", session, epoch: log.epoch, events: page.events, more: page.more });
        if (!page.more) break;
      }
    } finally {
      c.pumping.delete(session);
    }
  }

  private attach(c: Client, session: string, epoch: string | undefined, afterSeq: number | undefined): void {
    if (!this.opts.sessions.has(session)) { this.send(c, { t: "error", code: "no_session", message: "no such session", session }); return; }
    this.markSeen(c, session);
    // A Mac session may already have approvals waiting from before this attach (or before the
    // host's Remote Control stream connected): fetch them so no approval card is missed.
    void this.opts.sessions.syncBridge(session).catch(error => {
      this.opts.log?.(`bridge sync failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    const log = this.opts.sessions.log(session);
    if (epoch === log.epoch && afterSeq !== undefined && afterSeq > 0 && afterSeq <= log.lastSeq) {
      // Resume by seq, unless the gap is so large that replaying it would be slower than starting from the tail.
      let cursor = afterSeq;
      let frames = 0;
      for (; frames < CATCHUP_FRAMES; frames++) {
        const page = log.readAfter(cursor);
        if (!page.more) break;
        cursor = page.events.length ? page.events[page.events.length - 1]!.seq : log.lastSeq;
      }
      if (frames < CATCHUP_FRAMES) {
        c.attached.set(session, afterSeq);
        this.pump(c, session);
        return;
      }
    }
    const tail = log.tail();
    c.attached.set(session, log.lastSeq);
    this.send(c, { t: "events", session, epoch: log.epoch, events: tail.events, more: false, tail: { hasOlder: tail.hasOlder } });
  }

  // ---- sockets --------------------------------------------------------------------------------

  /** A phone connected, directly or through the relay; it must say hello with the token within 10 s. */
  connected(ws: Peer): void {
    const c: Client = { ws, authed: false, clientId: "", visibleAt: 0, lastRx: Date.now(), attached: new Map(), pumping: new Set() };
    this.clients.add(c);
    const helloTimer = setTimeout(() => { if (!c.authed) ws.close(4001, "hello"); }, 10_000);
    ws.on("message", (data) => {
      c.lastRx = Date.now();
      let msg: ClientMsg;
      try { msg = JSON.parse(String(data)) as ClientMsg; } catch { return; }
      void this.onClient(c, msg).catch((e: Error) => this.send(c, { t: "error", code: "internal", message: e.message }));
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (c.authed && c.clientId) this.lastSeen.set(c.clientId, c.lastRx);
      this.clients.delete(c);
    });
    ws.on("error", () => { /* close follows */ });
  }

  private reapStale(): void {
    const now = Date.now();
    for (const c of this.clients) if (now - c.lastRx > STALE_MS) c.ws.terminate();
  }

  private send(c: Client, msg: HostMsg): void {
    if (c.ws.readyState !== c.ws.OPEN) return;
    const text = JSON.stringify(msg);
    if (Buffer.byteLength(text) > FRAME_CAP) {
      // The log caps events and pages, so this means a bug; say so rather than kill the socket (Paseo #2610).
      this.opts.log?.(`frame over cap dropped: ${msg.t} ${Buffer.byteLength(text)} bytes`);
      if (msg.t !== "error") this.send(c, { t: "error", code: "too_large", message: `${msg.t} frame over ${FRAME_CAP} bytes` });
      return;
    }
    c.ws.send(text);
  }

  private async onClient(c: Client, msg: ClientMsg): Promise<void> {
    if (msg.t === "ping") { this.send(c, { t: "pong", n: msg.n }); return; }
    if (!c.authed) {
      if (msg.t === "hello" && tokenMatches(this.opts.token, msg.token)) {
        const clientId = typeof msg.clientId === "string" ? msg.clientId : "";
        if (clientId && !/^[A-Za-z0-9_-]{1,100}$/.test(clientId)) {
          this.send(c, { t: "denied", reason: "token" });
          c.ws.close(4003, "denied");
          return;
        }
        c.authed = true;
        c.clientId = clientId;
        this.send(c, { t: "ready", host: this.hostInfo, sessions: this.opts.sessions.list(), groups: this.opts.sessions.groups() });
      } else {
        this.send(c, { t: "denied", reason: "token" });
        c.ws.close(4003, "denied");
      }
      return;
    }
    const s = this.opts.sessions;
    switch (msg.t) {
      case "hello": return;
      case "attach": this.attach(c, msg.session, msg.epoch, msg.afterSeq); return;
      case "detach": c.attached.delete(msg.session); return;
      case "seen": if (s.has(msg.session)) s.markSeen(msg.session); return;
      case "archive":
        try { s.setArchived(msg.session, msg.archived === true); }
        catch (e) { this.send(c, { t: "error", code: "archive", message: (e as Error).message, session: msg.session }); }
        return;
      case "unread":
        try { s.markUnread(msg.session); }
        catch (e) { this.send(c, { t: "error", code: "unread", message: (e as Error).message, session: msg.session }); }
        return;
      case "history": {
        if (!s.has(msg.session)) return;
        const page = s.log(msg.session).before(msg.beforeSeq);
        this.send(c, { t: "history", session: msg.session, reqId: msg.reqId, events: page.events, hasOlder: page.hasOlder });
        return;
      }
      case "create":
        try {
          const id = await s.create(msg);
          this.send(c, { t: "ack", clientMsgId: msg.clientMsgId, session: id });
        } catch (e) {
          if (e instanceof OutcomeUnknownError) {
            this.send(c, { t: "error", code: "outcome_unknown", message: e.message, clientMsgId: msg.clientMsgId });
          } else {
            this.send(c, { t: "error", code: "create", message: (e as Error).message, clientMsgId: msg.clientMsgId });
          }
        }
        return;
      case "send":
        try {
          const desktop = s.list().some(session => session.id === msg.session && session.origin === "desktop");
          const id = await s.send(msg.session, msg.clientMsgId, msg.text, msg.attachments, msg.behavior);
          this.send(c, { t: "ack", clientMsgId: msg.clientMsgId, session: id });
          if (desktop && id === msg.session) this.attach(c, id, undefined, undefined);
        } catch (e) {
          if (e instanceof OutcomeUnknownError) {
            this.send(c, { t: "error", code: "outcome_unknown", message: e.message, clientMsgId: msg.clientMsgId, session: msg.session });
          } else {
            this.send(c, { t: "error", code: "send", message: (e as Error).message, clientMsgId: msg.clientMsgId, session: msg.session });
          }
        }
        return;
      case "decide":
        try {
          if (msg.decision !== "allow" && msg.decision !== "allow_always" && msg.decision !== "deny") throw new Error("invalid decision");
          if (!await s.decide(msg.session, msg.id, msg.decision, msg.message, msg.answers)) throw new Error("이미 처리됨");
          if (msg.reqId) this.send(c, { t: "res", reqId: msg.reqId, ok: true, data: null });
        } catch (e) {
          if (msg.reqId) this.send(c, { t: "res", reqId: msg.reqId, ok: false, error: (e as Error).message });
          else this.send(c, { t: "error", code: "permission", message: (e as Error).message, session: msg.session });
        }
        return;
      case "set_mode":
        try {
          await s.setMode(msg.sessionId, msg.mode);
          this.send(c, { t: "res", reqId: msg.reqId, ok: true, data: null });
        } catch (e) {
          this.send(c, { t: "res", reqId: msg.reqId, ok: false, error: (e as Error).message });
        }
        return;
      case "interrupt":
      case "set_model":
        try {
          if (msg.t === "interrupt") await s.interrupt(msg.session);
          else await s.setModel(msg.session, msg.model, msg.effort);
          if (msg.reqId) this.send(c, { t: "res", reqId: msg.reqId, ok: true, data: null });
        } catch (e) {
          if (msg.reqId) this.send(c, { t: "res", reqId: msg.reqId, ok: false, error: (e as Error).message });
          else this.send(c, { t: "error", code: msg.t, session: msg.session, message: (e as Error).message });
        }
        return;
      case "presence": c.visibleAt = msg.visible === true ? this.now() : 0; if (msg.visible === true) for (const session of c.attached.keys()) this.markSeen(c, session); return;
      case "req":
        try {
          this.send(c, { t: "res", reqId: msg.reqId, ok: true, data: await this.request(msg.op, c) });
        } catch (e) {
          this.send(c, { t: "res", reqId: msg.reqId, ok: false, error: (e as Error).message });
        }
        return;
    }
  }

  private async request(op: ReqOp, c: Client): Promise<unknown> {
    const s = this.opts.sessions;
    switch (op.op) {
      case "upload": {
        if (!s.has(op.session) || !/^[\w-]{1,100}$/.test(op.uploadId) || typeof op.data !== "string" || op.data.length > BLOB_CHUNK_CHARS || !/^[A-Za-z0-9+/=]*$/.test(op.data)) throw new Error("Invalid attachment chunk.");
        for (const [key, value] of this.uploads) if (this.now() - value.at > 300_000) this.uploads.delete(key);
        const key = `${c.clientId}/${op.session}/${op.uploadId}`;
        if (!this.uploads.has(key) && this.uploads.size >= 16) throw new Error("Too many unfinished uploads. Try again later.");
        const previous = op.offset === 0 ? "" : this.uploads.get(key)?.data;
        if (previous === undefined || previous.length !== op.offset) throw new Error("Upload offset mismatch. Retry the attachment.");
        const data = previous + op.data;
        if (data.length > Math.ceil(ATTACHMENT_CAP / 3) * 4) { this.uploads.delete(key); throw new Error("Attachment exceeds 8 MB."); }
        if (!op.done) { this.uploads.set(key, { data, at: this.now() }); return null; }
        this.uploads.delete(key);
        if (!data || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data) || Buffer.from(data, "base64").length > ATTACHMENT_CAP) throw new Error("Invalid attachment bytes.");
        return { blob: s.log(op.session).image(data) };
      }
      case "models": {
        if (!this.models || Date.now() - this.models.at > 30_000) this.models = { at: Date.now(), data: await this.opts.router.models() };
        return this.models.data;
      }
      case "folders": {
        const cli = await this.opts.recentCli().catch(() => []);
        return recentFolders([...s.recentSources(), ...cli]);
      }
      case "browse": return browse(op.path, op.hidden ?? false);
      case "mkdir": return { path: await makeFolder(op.parent, op.name) };
      case "git": return macConsent(op.path, () => gitInfo(op.path));
      case "commands": return s.commands(op.session);
      case "blob": {
        if (!s.has(op.session)) throw new Error("no such session");
        const text = s.log(op.session).blob(op.id);
        if (text === null) throw new Error("no such blob");
        const offset = Math.max(0, op.offset ?? 0);
        const end = Math.min(text.length, offset + BLOB_CHUNK_CHARS);
        const chunk: BlobChunk = { text: text.slice(offset, end), offset, next: end < text.length ? end : null, bytes: Buffer.byteLength(text) };
        return chunk;
      }
      case "sub": {
        const log = s.subLog(op.session, op.sub);
        if (!log) throw new Error("no such subagent");
        return log.readAfter(op.afterSeq ?? 0);
      }
      case "expo_push_subscribe":
        if (!this.opts.expoPush) throw new Error("native push is off on this host");
        if (!c.clientId) throw new Error("no device id");
        this.opts.expoPush.subscribe(c.clientId, op.token, op.lang, op.platform, op.key);
        return { ok: true };
      case "expo_push_unsubscribe":
        if (c.clientId) this.opts.expoPush?.unsubscribe(c.clientId);
        return { ok: true };
      case "push_key":
        if (!this.opts.push) throw new Error("push is off on this host");
        return { publicKey: this.opts.push.publicKey };
      case "push_subscribe":
        if (!this.opts.push) throw new Error("push is off on this host");
        if (!c.clientId) throw new Error("no device id");
        this.opts.push.subscribe(c.clientId, op.subscription, op.lang);
        return { ok: true };
      case "push_unsubscribe":
        if (c.clientId) this.opts.push?.unsubscribe(c.clientId);
        return { ok: true };
    }
  }

  private async checkRouter(): Promise<void> {
    const st = await this.opts.router.status();
    const next: HostInfo = { ...this.hostInfo, routerOk: st.ok, ...(st.problem ? { routerProblem: st.problem } : {}) };
    if (!st.problem) delete next.routerProblem;
    const ripple = st.ok ? await this.readRipple() : undefined;
    if (ripple) next.ripple = ripple; else delete next.ripple;
    // `at` moves on every read; only a change a phone could see is worth a message.
    const shown = (r: RippleStatus | undefined): string => JSON.stringify(r && { ...r, at: 0 });
    if (next.routerOk === this.hostInfo.routerOk && next.routerProblem === this.hostInfo.routerProblem && shown(next.ripple) === shown(this.hostInfo.ripple)) return;
    this.setHostInfo(next);
  }

  /**
   * The mod's mode and effort range every check, the provider limits at most once a minute (the
   * router asks each provider's own API for them). A failed limits read keeps the last good body;
   * without mod settings there is nothing to say and `ripple` is left out.
   */
  private async readRipple(): Promise<RippleStatus | undefined> {
    const { limits, modSettings } = this.opts.router;
    if (!limits || !modSettings) return undefined;
    const now = (this.opts.now ?? Date.now)();
    if (now - this.limitsAt >= LIMITS_MS) {
      this.limitsAt = now;
      try { this.limitsBody = await limits.call(this.opts.router); } catch { /* keep the last good body */ }
    }
    try { return rippleStatus(this.limitsBody, await modSettings.call(this.opts.router), now); } catch { return undefined; }
  }

  /** Sessions says Claude app sessions became unreachable (the Mac's login) or reachable again. */
  setDesktopProblem(problem: string | null): void {
    if ((problem ?? undefined) === this.hostInfo.desktopProblem) return;
    const next: HostInfo = { ...this.hostInfo, ...(problem ? { desktopProblem: problem } : {}) };
    if (!problem) delete next.desktopProblem;
    this.setHostInfo(next);
  }

  private setHostInfo(next: HostInfo): void {
    this.hostInfo = next;
    for (const c of this.clients) if (c.authed) this.send(c, { t: "host", host: next });
  }

  // ---- the PWA --------------------------------------------------------------------------------

  /** Never throws: a malformed path is a 400, anything else unexpected a logged 500. */
  private serve(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      this.serveInner(req, res);
    } catch (error) {
      this.opts.log?.(`http serve failed: ${error instanceof Error ? error.message : String(error)}`);
      try { res.writeHead(500).end(); } catch { /* the socket is already gone */ }
    }
  }

  private serveInner(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname.startsWith("/local/")) {
      if (!this.opts.local) { res.writeHead(404).end(); return; }
      void this.opts.local.handle(req, res).catch(() => {
        // Never log a local request, body or exception: pairing responses contain credentials.
        if (!res.headersSent) res.writeHead(500).end();
        else res.destroy();
      });
      return;
    }
    if (url.pathname === "/healthz") { res.writeHead(200, { "content-type": "application/json" }).end(`{"ok":true}`); return; }
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
    let rel: string;
    try {
      rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    } catch { res.writeHead(400).end(); return; }
    if (rel.includes("\0")) { res.writeHead(400).end(); return; }
    // Files from outside web/ the client loads: the shared protocol and encryption, and tweetnacl.
    const shared = SHARED[rel];
    const file = shared ? shared(path.dirname(this.opts.webDir)) : path.resolve(this.opts.webDir, rel);
    const ext = path.extname(file);
    if ((!shared && !file.startsWith(this.opts.webDir + path.sep)) || !TYPES[ext]) { res.writeHead(404).end(); return; }
    let stat: fs.Stats;
    try { stat = fs.statSync(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      res.writeHead(404).end();
      return;
    }
    let body: string | Buffer;
    if (ext === ".ts") {
      const hit = this.stripped.get(file);
      if (hit && hit.mtime === stat.mtimeMs) body = hit.body;
      else {
        // The client is TypeScript like the rest of the product; Node strips the types, no build step.
        body = module.stripTypeScriptTypes(fs.readFileSync(file, "utf8"), { mode: "strip" });
        this.stripped.set(file, { mtime: stat.mtimeMs, body });
      }
    } else body = fs.readFileSync(file);
    res.writeHead(200, {
      "content-type": TYPES[ext]!,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...(ext === ".html" ? { "content-security-policy": CSP } : {}),
    });
    res.end(req.method === "HEAD" ? undefined : body);
  }
}
