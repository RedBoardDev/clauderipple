// The phone app: one screen at a time (pair, home, session), a docked composer, sheets for
// folder and model. State that must survive closing the app (the token, unsent messages, the
// last folder and model) lives in localStorage; everything else is rebuilt from the host.
import type { BlobChunk, BrowseResult, ClientMsg, Effort, FolderEntry, HostMsg, ProviderGroup, ReqOp, SessionEvent, SessionSummary, SubPage } from "../src/protocol.ts";
import { Link } from "./conn.ts";
import type { LinkStatus } from "./conn.ts";
import { esc, icon, patchList, setHTML } from "./dom.ts";
import { lang, pickLang, setLang, t } from "./i18n.ts";
import { browserPushEnv, currentSubscription, enablePush, sameKey } from "./notify.ts";
import { pushAvailability } from "./pushstate.ts";
import { RelaySocket, browserNacl, relayClientUrl } from "./secure.ts";
import type { RawSocket, RelayPairing } from "./secure.ts";
import { PING_MS, defaultEffort } from "../src/protocol.ts";
import { mergeEvents, reduce, timelineItems } from "./timeline.ts";
import type { TimelineItem, Outgoing, SessionView } from "./timeline.ts";
import * as V from "./views.ts";
import type { UI } from "./views.ts";

interface Cache { epoch: string | null; events: SessionEvent[]; hasOlder: boolean; loadingOlder: boolean; attached: boolean }
interface OutboxEntry extends Outgoing { session: string | null; create?: { cwd: string; model: string; effort: Effort | null } }
type Screen = { name: "pair" } | { name: "home" } | { name: "session"; id: string };

const store = {
  get<T>(key: string, fallback: T): T {
    try { const raw = localStorage.getItem(key); return raw === null ? fallback : (JSON.parse(raw) as T); } catch { return fallback; }
  },
  set(key: string, value: unknown): void {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: state lives for this visit only */ }
  },
};

/** Keep the pairing a link's fragment carries ("#pair=…"); false when it carries none. */
function savePairing(fragment: string): boolean {
  if (!fragment.startsWith("#")) return false;
  const hash = new URLSearchParams(fragment.slice(1));
  const paired = hash.get("pair");
  if (!paired) return false;
  store.set("rr.token", paired);
  // A relay pairing names the host (server id) and its key; a direct one does not, and replaces any relay pairing.
  const server = hash.get("server"), hpk = hash.get("hpk");
  store.set("rr.relay", server && hpk ? ({ url: location.origin, server, hpk } satisfies RelayPairing) : null);
  return true;
}

const uid = (): string => crypto.randomUUID();
const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

export class App {
  ui: UI;
  screen: Screen = { name: "home" };
  caches = new Map<string, Cache>();
  outbox: OutboxEntry[] = store.get<OutboxEntry[]>("rr.outbox", []);
  recentModels: string[] = store.get<string[]>("rr.recentModels", []);
  link: Link | null = null;
  pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  /** create's clientMsgId → session id, once the host acknowledged it */
  created = new Map<string, string>();
  private renderedScreen = "";
  private composerMode = "";
  private lastOpenPerm = "";
  private pinned = true;
  private tasksOpen = false;
  private timelineSize: ResizeObserver | null = null;
  private imageUrls = new Map<string, Promise<string>>();

  private clearImages(): void {
    for (const url of this.imageUrls.values()) void url.then(value => URL.revokeObjectURL(value), () => undefined);
    this.imageUrls.clear();
  }

  private hydrateImages(root: HTMLElement, session: string): void {
    for (const el of root.querySelectorAll<HTMLElement>('.conversation-image')) {
      if (el.dataset.loading) continue;
      el.dataset.loading = 'true';
      const id = el.dataset.blob!, media = el.dataset.media!;
      let loading = this.imageUrls.get(id);
      if (!loading) {
        loading = (async () => {
          let offset = 0, base64 = '';
          for (;;) {
            const chunk = await this.req<BlobChunk>({ op: 'blob', session, id, offset });
            base64 += chunk.text;
            if (chunk.next === null) break;
            offset = chunk.next;
          }
          const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
          return URL.createObjectURL(new Blob([bytes], { type: media }));
        })();
        this.imageUrls.set(id, loading);
      }
      void loading.then(url => {
        if (!el.isConnected) return;
        const image = el.querySelector('img')!;
        image.onerror = () => { image.hidden = true; el.querySelector('span')!.textContent = t('image.unavailable'); };
        image.onload = () => { el.querySelector('span')!.textContent = ''; };
        image.src = url; image.hidden = false;
      }, error => {
        if (el.isConnected) el.querySelector('span')!.textContent = t('image.unavailable');
        this.toast(t('error.generic', { text: (error as Error).message }));
      });
    }
  }

  constructor(link: LinkStatus) {
    this.ui = {
      now: Date.now(), link, host: null, home: undefined, sessions: [], models: [], sheet: null,
      draft: store.get("rr.draft", { cwd: null, model: null, effort: null }),
      expanded: new Map(), workersOpen: false, permOpen: new Set(), toast: null,
      push: null, pushLater: store.get<boolean>("rr.pushLater", false),
    };
  }

  // ---- boot --------------------------------------------------------------------------------

  start(): void {
    if (savePairing(location.hash)) history.replaceState(null, "", location.pathname);
    const token = store.get<string | null>("rr.token", null);
    if (!token) { this.screen = { name: "pair" }; this.bind(); this.render(); return; }
    this.screen = this.routeFromHash();
    window.addEventListener("hashchange", () => { this.screen = this.routeFromHash(); this.ui.sheet = null; this.render(); this.attachCurrent(); });
    const clientId = store.get<string>("rr.clientId", "") || uid();
    store.set("rr.clientId", clientId);
    // Served by the relay → through the relay, encrypted end to end; served by the host itself → straight to it.
    const relay = store.get<RelayPairing | null>("rr.relay", null);
    const viaRelay = relay !== null && relay.url === location.origin;
    const link = new Link({
      url: viaRelay ? relayClientUrl(relay) : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
      token, clientId,
      makeSocket: viaRelay
        ? (url) => new RelaySocket(new WebSocket(url) as unknown as RawSocket, relay, browserNacl())
        : (url) => new WebSocket(url) as unknown as import("./conn.ts").SocketLike,
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (id) => clearTimeout(id as number),
      isOnline: () => navigator.onLine,
    });
    this.link = link;
    link.onStatus = (s) => { this.ui.link = s; this.ui.now = Date.now(); this.renderChrome(); };
    link.onMessage = (m) => this.onHost(m);
    link.onReady = () => this.onReady();
    window.addEventListener("online", () => link.nudge());
    window.addEventListener("offline", () => link.nudge());
    document.addEventListener("visibilitychange", () => { this.sendPresence(); if (document.visibilityState === "visible") { link.foreground(); void this.refreshPush(); } });
    setInterval(() => { this.ui.now = Date.now(); this.renderChrome(); }, 1000);
    // While in front, say so every PING_MS: the host pushes nothing to a phone that is looking, and
    // stops counting one whose app froze in the background without saying "hidden".
    setInterval(() => { if (document.visibilityState === "visible") this.sendPresence(); }, PING_MS);
    if (window.isSecureContext && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.ts", { scope: "./" }).catch(() => undefined);
    }
    void this.refreshPush();
    this.bind();
    this.render();
    link.start();
  }

  private routeFromHash(): Screen {
    const m = /^#\/s\/(.+)$/.exec(location.hash);
    return m ? { name: "session", id: decodeURIComponent(m[1]!) } : { name: "home" };
  }

  go(screen: Screen): void {
    const hash = screen.name === "session" ? `#/s/${encodeURIComponent(screen.id)}` : "";
    if (location.hash !== hash) {
      if (hash) location.hash = hash; else history.pushState(null, "", location.pathname);
    }
    this.screen = screen;
    this.ui.sheet = null;
    this.render();
    this.attachCurrent();
  }

  // ---- host messages -----------------------------------------------------------------------

  private onReady(): void {
    for (const c of this.caches.values()) c.attached = false;
    this.sendPresence();
    this.attachCurrent();
    this.flushOutbox();
    if (!this.ui.models.length) void this.loadModels();
    void this.resyncPush();
  }

  // ---- presence and notifications ----------------------------------------------------------

  private sendPresence(): void {
    this.link?.send({ t: "presence", visible: document.visibilityState === "visible" });
  }

  private async refreshPush(): Promise<void> {
    const sub = await currentSubscription().catch(() => null);
    const next = pushAvailability(browserPushEnv(sub !== null));
    if (next !== this.ui.push) { this.ui.push = next; if (this.screen.name === "home") this.render(); }
  }

  /** A host may have dropped the subscription (a 410 it saw) or changed its key: tell it again on every connect. */
  private async resyncPush(): Promise<void> {
    try {
      const sub = await currentSubscription();
      if (!sub || Notification.permission !== "granted") return;
      const { publicKey } = await this.req<{ publicKey: string }>({ op: "push_key" });
      if (!sameKey(sub, publicKey)) { await sub.unsubscribe(); await this.refreshPush(); return; }
      await this.registerPush(sub.toJSON());
    } catch { /* tried again on the next connect */ }
  }

  private async registerPush(json: PushSubscriptionJSON): Promise<void> {
    if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error("subscription without keys");
    await this.req({ op: "push_subscribe", subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } }, lang: lang() });
  }

  private async turnOnPush(): Promise<void> {
    try {
      const r = await enablePush(async () => (await this.req<{ publicKey: string }>({ op: "push_key" })).publicKey, (json) => this.registerPush(json));
      if (r === "on") this.toast(t("push.done"));
    } catch (e) { this.toast(t("push.failed", { text: (e as Error).message })); }
    await this.refreshPush();
  }

  onHost(m: HostMsg): void {
    switch (m.t) {
      case "ready":
        this.ui.host = m.host; this.ui.sessions = m.sessions; this.ui.groups = m.groups; this.render(); break;
      case "host":
        this.ui.host = m.host; this.renderChrome(); break;
      case "sessions":
        this.ui.sessions = m.sessions; this.ui.groups = m.groups; if (this.screen.name === "home") this.render(); else this.renderChrome(); break;
      case "events": {
        const c = this.cache(m.session);
        if (m.tail || (c.epoch && c.epoch !== m.epoch)) { c.events = []; c.hasOlder = m.tail?.hasOlder ?? false; }
        c.epoch = m.epoch;
        c.events = mergeEvents(c.events, m.events);
        for (const e of m.events) if (e.kind === "user") this.dropOutbox(e.clientMsgId);
        if (this.isCurrent(m.session)) this.renderSession();
        break;
      }
      case "history": {
        const c = this.cache(m.session);
        c.loadingOlder = false;
        c.hasOlder = m.hasOlder;
        const main = $("main");
        const before = main ? main.scrollHeight - main.scrollTop : 0;
        c.events = mergeEvents(c.events, m.events);
        if (this.isCurrent(m.session)) { this.renderSession(); if (main) main.scrollTop = main.scrollHeight - before; }
        break;
      }
      case "ack": {
        const entry = this.outbox.find((o) => o.clientMsgId === m.clientMsgId);
        if (entry && entry.session && entry.session !== m.session && this.isCurrent(entry.session)) this.go({ name: "session", id: m.session });
        if (entry?.create) {
          this.created.set(m.clientMsgId, m.session);
          if (this.screen.name === "session" && this.screen.id === `local:${m.clientMsgId}`) {
            history.replaceState(null, "", `#/s/${encodeURIComponent(m.session)}`);
            this.screen = { name: "session", id: m.session };
            this.renderedScreen = "";
          }
        }
        this.cache(m.session).attached = false;
        this.dropOutbox(m.clientMsgId);
        this.attachCurrent();
        this.render();
        break;
      }
      case "res": {
        const p = this.pending.get(m.reqId);
        this.pending.delete(m.reqId);
        if (p) { if (m.ok) p.resolve(m.data); else p.reject(new Error(m.error)); }
        break;
      }
      case "error":
        // outcome_unknown: the host restarted mid-send and cannot say whether the first attempt
        // ran. Keep the typed text in the outbox (it flushes again on reconnect) and say so.
        if (m.clientMsgId && m.code !== "outcome_unknown") this.dropOutbox(m.clientMsgId);
        this.toast(t("error.generic", { text: m.message }));
        break;
      default:
        break;
    }
  }

  private isCurrent(session: string): boolean {
    return this.screen.name === "session" && this.screen.id === session;
  }

  cache(id: string): Cache {
    let c = this.caches.get(id);
    if (!c) { c = { epoch: null, events: [], hasOlder: false, loadingOlder: false, attached: false }; this.caches.set(id, c); }
    return c;
  }

  private attachCurrent(): void {
    if (this.screen.name !== "session" || this.screen.id.startsWith("local:") || this.ui.link.state !== "open") return;
    const c = this.cache(this.screen.id);
    if (c.attached) return;
    const last = c.events.length ? c.events[c.events.length - 1]!.seq : 0;
    const msg: ClientMsg = c.epoch && last ? { t: "attach", session: this.screen.id, epoch: c.epoch, afterSeq: last } : { t: "attach", session: this.screen.id };
    if (this.link?.send(msg)) c.attached = true;
  }

  req<T>(op: ReqOp): Promise<T> {
    const reqId = uid();
    return new Promise<T>((resolve, reject) => {
      if (!this.link?.send({ t: "req", reqId, op })) { reject(new Error("offline")); return; }
      this.pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject });
      setTimeout(() => { if (this.pending.delete(reqId)) reject(new Error("timeout")); }, 15_000);
    });
  }

  private async loadModels(): Promise<void> {
    try {
      this.ui.models = await this.req<ProviderGroup[]>({ op: "models" });
      const d = this.ui.draft;
      const all = this.ui.models.flatMap((g) => g.models);
      if (!d.model || !all.some((m) => m.model === d.model)) {
        const first = all.find((m) => m.usable);
        if (first) { d.model = first.model; d.effort = first.efforts.includes("high") ? "high" : first.efforts[0] ?? null; store.set("rr.draft", d); }
      }
      this.render();
    } catch { /* retried on the next ready */ }
  }

  // ---- outbox: nothing a person typed is dropped; nothing shows as sent before the host says so ----

  private saveOutbox(): void { store.set("rr.outbox", this.outbox); }

  private dropOutbox(id: string): void {
    const before = this.outbox.length;
    this.outbox = this.outbox.filter((o) => o.clientMsgId !== id);
    if (this.outbox.length !== before) this.saveOutbox();
  }

  private flushOutbox(): void {
    for (const o of this.outbox) {
      const session = o.session ?? null;
      const sent = o.create && !session
        ? this.link?.send({ t: "create", clientMsgId: o.clientMsgId, cwd: o.create.cwd, model: o.create.model, effort: o.create.effort, text: o.text })
        : session ? this.link?.send({ t: "send", session, clientMsgId: o.clientMsgId, text: o.text }) : false;
      o.state = sent ? "sending" : "pending";
    }
    this.saveOutbox();
    this.render();
  }

  submit(text: string): void {
    const body = text.trim();
    if (!body || (this.screen.name === "session" && this.summary(this.screen.id)?.readOnly)) return;
    const clientMsgId = uid();
    if (this.screen.name === "home" || (this.screen.name === "session" && this.screen.id.startsWith("local:"))) {
      const d = this.ui.draft;
      if (!d.cwd) { this.openFolderSheet(); return; }
      if (!d.model) { this.openModelSheet(null); return; }
      const entry: OutboxEntry = { clientMsgId, text: body, at: Date.now(), state: "pending", session: null, create: { cwd: d.cwd, model: d.model, effort: d.effort } };
      this.outbox.push(entry);
      this.rememberModel(d.model);
      this.flushOutbox();
      this.go({ name: "session", id: `local:${clientMsgId}` });
      return;
    }
    if (this.screen.name !== "session") return;
    const session = this.screen.id;
    this.outbox.push({ clientMsgId, text: body, at: Date.now(), state: "pending", session });
    this.flushOutbox();
    this.scrollToBottom();
  }

  private rememberModel(id: string): void {
    this.recentModels = [id, ...this.recentModels.filter((m) => m !== id)].slice(0, 5);
    store.set("rr.recentModels", this.recentModels);
  }

  // ---- rendering -----------------------------------------------------------------------------

  view(id: string): SessionView {
    const c = this.cache(id);
    const out = this.outbox.filter((o) => o.session === id || (id.startsWith("local:") && o.clientMsgId === id.slice(6)) || (o.create && this.created.get(o.clientMsgId) === id));
    const view = reduce(c.events, out, c.events.length > 0 && !c.hasOlder);
    const summary = this.summary(id);
    if (summary?.desktopBridge) view.state = summary.state;
    return view;
  }

  summary(id: string): SessionSummary | undefined {
    const s = this.ui.sessions.find((x) => x.id === id);
    if (s || !id.startsWith("local:")) return s?.origin === "desktop" ? { ...s, readOnly: false } : s;
    const o = this.outbox.find((x) => x.clientMsgId === id.slice(6));
    if (!o?.create) return undefined;
    return { id, title: o.text, cwd: o.create.cwd, model: o.create.model, effort: o.create.effort, state: "starting", pending: 0, createdAt: o.at, updatedAt: o.at, lastSeq: 0, epoch: "" };
  }

  render(): void {
    const root = $("#app");
    const key = this.screen.name === "session" ? `s:${this.screen.id}` : this.screen.name;
    if (key !== this.renderedScreen) {
      this.clearImages();
      this.renderedScreen = key;
      this.pinned = true;
      this.composerMode = "";
      root.dataset.screen = this.screen.name;
      root.innerHTML = this.screen.name === "pair"
        ? `<main class="scroll">${V.pairScreen()}</main>`
        : `<header class="top" id="top"></header><div id="pre"></div><main class="scroll" id="main">${this.screen.name === "session" ? `<div class="loading-older" id="older" hidden>${t("history.loading")}</div><div class="tl" id="tl"></div>` : ""}</main><footer class="dock"><div id="dock-extra"></div><div id="dock-input"></div></footer><div id="sheet"></div><div id="toast"></div>`;
      this.timelineSize?.disconnect();
      if (this.screen.name === "session") {
        this.timelineSize = new ResizeObserver(() => { if (this.pinned) this.scrollToBottom(); });
        this.timelineSize.observe($("#tl"));
        this.timelineSize.observe($("main"));
        requestAnimationFrame(() => { if (this.pinned) this.scrollToBottom(); });
      }
    }
    if (this.screen.name === "pair") return;
    if (this.screen.name === "home") {
      setHTML($("#top"), V.homeTop(this.ui));
      setHTML($("#pre"), "");
      setHTML($("#main"), V.homeMain(this.ui));
      setHTML($("#dock-extra"), V.chips(this.ui));
      this.renderComposer(t("composer.new"), "send");
    } else {
      this.renderSession();
    }
    this.renderSheet();
    this.renderToast();
  }

  /** Only what changes every second: the link pill, banners, countdowns, "working for". */
  renderChrome(): void {
    if (this.screen.name === "pair") return;
    if (this.screen.name === "home") {
      setHTML($("#top"), V.homeTop(this.ui));
      const main = $("#main");
      if (main) { const y = main.scrollTop; setHTML(main, V.homeMain(this.ui)); main.scrollTop = y; }
      return;
    }
    this.renderSession(true);
  }

  renderSession(chromeOnly = false): void {
    if (this.screen.name !== "session") return;
    const id = this.screen.id;
    const view = this.view(id);
    const s = this.summary(id);
    const top = $("#top");
    if (!top) return;
    setHTML(top, V.sessionTop(this.ui, s, view));
    setHTML($("#pre"), V.band(this.ui, view) + V.banner(this.ui));
    const perm = s?.readOnly ? "" : V.permCard(view, this.ui);
    setHTML($("#dock-extra"), s?.readOnly ? `<div class="foot">${esc(t("session.readOnly", { host: V.hostName(this.ui) }))}</div>` : perm + (perm ? "" : V.workingLine(view, this.ui, s)) + V.tasks(this.ui, s, this.tasksOpen));
    // Stop only when the host can hear it; offline the button sends (queues) instead.
    const running = view.state === "running" || view.state === "starting" || id.startsWith("local:");
    if (s?.readOnly) {
      setHTML($("#dock-input"), "");
      this.composerMode = "read-only";
    } else this.renderComposer(t("composer.reply"), running && !perm && this.ui.link.state === "open" ? "stop" : "send");
    const openId = view.open[0]?.id ?? "";
    if (openId && openId !== this.lastOpenPerm) navigator.vibrate?.(30);
    this.lastOpenPerm = openId;
    if (chromeOnly) return;
    const main = $("main");
    const stick = this.pinned;
    patchList<TimelineItem>($("#tl"), timelineItems(view), (it) => V.item(it, this.ui));
    this.hydrateImages($("#tl"), id);
    const c = this.cache(id);
    $("#older").hidden = !c.loadingOlder;
    if (stick) this.scrollToBottom();
  }

  private renderComposer(placeholder: string, mode: "send" | "stop"): void {
    const key = `${placeholder}|${mode}`;
    const host = $("#dock-input");
    if (!host || key === this.composerMode) return;
    const prev = (document.getElementById("input") as HTMLTextAreaElement | null)?.value ?? store.get<string>(`rr.typed.${this.renderedScreen}`, "");
    host.innerHTML = V.composer(placeholder, mode, prev);
    this.composerMode = key;
    this.fitInput();
  }

  renderSheet(): void {
    const el = $("#sheet");
    setHTML(el, V.sheet(this.ui));
  }

  private renderToast(): void {
    const el = $("#toast");
    if (el) el.innerHTML = this.ui.toast ? `<div class="toast" role="status">${this.ui.toast.replace(/[<>&]/g, "")}</div>` : "";
  }

  toast(text: string): void {
    this.ui.toast = text;
    this.renderToast();
    setTimeout(() => { if (this.ui.toast === text) { this.ui.toast = null; this.renderToast(); } }, 3500);
  }

  scrollToBottom(): void {
    const main = $("main");
    if (main) main.scrollTop = main.scrollHeight;
  }

  private fitInput(): void {
    const ta = document.getElementById("input") as HTMLTextAreaElement | null;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
    const send = ta.parentElement?.querySelector<HTMLButtonElement>("button[data-act=send]");
    if (send) send.disabled = !ta.value.trim();
  }

  // ---- sheets --------------------------------------------------------------------------------

  async openFolderSheet(): Promise<void> {
    this.ui.sheet = { kind: "folder", recent: [], browse: null, filter: "", loading: true };
    this.renderSheet();
    try {
      const [recent, browse] = await Promise.all([this.req<FolderEntry[]>({ op: "folders" }), this.req<BrowseResult>({ op: "browse", ...(this.ui.draft.cwd ? { path: this.ui.draft.cwd } : {}) })]);
      if (this.ui.sheet?.kind !== "folder") return;
      this.ui.home = browse.home;
      this.ui.sheet = { ...this.ui.sheet, recent, browse, loading: false };
      this.renderSheet();
    } catch (e) { this.toast(t("error.generic", { text: (e as Error).message })); }
  }

  async browse(path: string): Promise<void> {
    try {
      const browse = await this.req<BrowseResult>({ op: "browse", path });
      if (this.ui.sheet?.kind !== "folder") return;
      this.ui.sheet = { ...this.ui.sheet, browse, filter: "" };
      this.renderSheet();
    } catch { this.toast(t("error.cwd")); }
  }

  openModelSheet(forSession: string | null): void {
    const s = forSession ? this.summary(forSession) : undefined;
    if (s?.readOnly) return;
    const v = forSession ? this.view(forSession) : null;
    const model = (v?.model ?? s?.model) ?? this.ui.draft.model;
    const effort = (v?.effort ?? s?.effort) ?? this.ui.draft.effort;
    this.ui.sheet = { kind: "model", groups: this.ui.models, recent: this.recentModels, model, effort, forSession };
    this.renderSheet();
    if (!this.ui.models.length) void this.loadModels().then(() => { if (this.ui.sheet?.kind === "model") { this.ui.sheet.groups = this.ui.models; this.renderSheet(); } });
  }

  // ---- input -----------------------------------------------------------------------------------

  private bind(): void {
    const root = $("#app");
    root.addEventListener("click", (ev) => {
      const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]");
      if (!el) return;
      void this.act(el.dataset.act!, el);
    });
    root.addEventListener("input", (ev) => {
      const el = ev.target as HTMLElement;
      if (el.id === "input") { this.fitInput(); store.set(`rr.typed.${this.renderedScreen}`, (el as HTMLTextAreaElement).value); }
      if (el.id === "folder-filter" && this.ui.sheet?.kind === "folder") {
        this.ui.sheet.filter = (el as HTMLInputElement).value;
        const pos = (el as HTMLInputElement).selectionStart;
        this.renderSheet();
        const again = document.getElementById("folder-filter") as HTMLInputElement | null;
        again?.focus();
        if (again && pos !== null) again.setSelectionRange(pos, pos);
      }
    });
    root.addEventListener("keydown", (ev) => {
      const el = ev.target as HTMLElement;
      // Enter sends on a hardware keyboard; on a phone the return key makes a new line unless enterkeyhint says send.
      if (el.id === "input" && ev.key === "Enter" && !ev.shiftKey && !ev.isComposing && matchMedia("(pointer: fine)").matches) {
        ev.preventDefault();
        void this.act("send", el);
      }
    });
    root.addEventListener("scroll", (ev) => {
      const main = ev.target as HTMLElement;
      if (main.id !== "main" || this.screen.name !== "session") return;
      this.pinned = main.scrollHeight - main.scrollTop - main.clientHeight < 80;
      if (main.scrollTop > 240) return;
      const c = this.cache(this.screen.id);
      if (!c.hasOlder || c.loadingOlder || !c.events.length) return;
      if (this.link?.send({ t: "history", session: this.screen.id, beforeSeq: c.events[0]!.seq, reqId: uid() })) { c.loadingOlder = true; $("#older").hidden = false; }
    }, true);
  }

  async act(act: string, el: HTMLElement): Promise<void> {
    const id = el.dataset.id ?? "";
    const session = this.screen.name === "session" ? this.screen.id : "";
    if (session && this.summary(session)?.readOnly && ["send", "stop", "allow", "deny", "always", "pick-model-session"].includes(act)) return;
    switch (act) {
      case "image": {
        const image = el.querySelector('img');
        if (!image?.src || image.hidden) break;
        const viewer = document.createElement('div');
        viewer.className = 'image-viewer'; viewer.setAttribute('role', 'dialog'); viewer.setAttribute('aria-modal', 'true');
        const close = document.createElement('button'); close.textContent = t('a11y.close');
        const full = document.createElement('img'); full.src = image.src; full.alt = t('image.view');
        viewer.append(close, full); $("#app").append(viewer);
        const dismiss = () => { viewer.remove(); document.removeEventListener('keydown', key); el.focus(); };
        const key = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
        close.onclick = dismiss; document.addEventListener('keydown', key); close.focus();
        break;
      }
      case "retry": this.link?.nudge(); break;
      case "pair-link": {
        // A Home Screen app keeps its own storage, apart from Safari's: the pairing a scanned QR
        // left in Safari never reaches it, so the link is pasted here instead.
        const value = (document.getElementById("pair-link") as HTMLInputElement | null)?.value ?? "";
        if (savePairing(value.slice(value.indexOf("#")))) location.reload();
        else this.toast(t("pair.badLink"));
        break;
      }
      case "home": this.go({ name: "home" }); break;
      case "open": this.go({ name: "session", id }); break;
      case "toggle-tasks": this.tasksOpen = !this.tasksOpen; this.renderSession(true); break;
      case "send": {
        const ta = document.getElementById("input") as HTMLTextAreaElement | null;
        if (!ta) return;
        const text = ta.value;
        ta.value = "";
        store.set(`rr.typed.${this.renderedScreen}`, "");
        this.fitInput();
        this.submit(text);
        break;
      }
      case "stop": if (session && !session.startsWith("local:")) this.link?.send({ t: "interrupt", session }); break;
      case "allow": case "deny": case "always":
        if (session) {
          const decision = act === "always" ? "allow_always" : act;
          const permission = reduce(this.cache(session).events).open.find(p => p.id === id);
          const answers: Record<string, string> = {};
          if (decision !== "deny" && permission?.requestKind === "question") {
            for (const q of permission.questions ?? []) {
              const answer = window.prompt(`${q.question}\n${q.options.map(o => `${o.label}: ${o.description}`).join("\n")}\n${q.multiSelect ? "Separate multiple answers with commas." : "Choose one or type your own answer."}`);
              if (!answer?.trim()) return;
              answers[q.question] = answer.trim();
            }
          }
          if (!this.link?.send({ t: "decide", session, id, decision, ...(permission?.requestKind === "question" && decision !== "deny" ? { answers } : {}) })) this.toast(t("queue.pending"));
        }
        break;
      case "perm-more": this.ui.permOpen.add(id); this.renderSession(true); break;
      case "workers": this.ui.workersOpen = !this.ui.workersOpen; this.renderSession(true); break;
      case "tool-group":
        if (this.ui.expanded.has(id)) this.ui.expanded.delete(id);
        else this.ui.expanded.set(id, null);
        this.rerenderItems();
        break;
      case "tool": await this.toggleTool(id); break;
      case "sub": await this.openSub(id); break;
      case "pick-folder": await this.openFolderSheet(); break;
      case "pick-model": this.openModelSheet(null); break;
      case "pick-model-session": if (session && !session.startsWith("local:")) this.openModelSheet(session); break;
      case "close-sheet": this.ui.sheet = null; this.renderSheet(); break;
      case "browse": await this.browse(el.dataset.path ?? ""); break;
      case "choose-folder":
        this.ui.draft.cwd = el.dataset.path ?? null;
        store.set("rr.draft", this.ui.draft);
        this.ui.sheet = null;
        this.render();
        break;
      case "choose-model": if (this.ui.sheet?.kind === "model") {
        const m = this.ui.models.flatMap((g) => g.models).find((x) => x.model === el.dataset.model);
        this.ui.sheet.model = m?.model ?? null;
        if (m) { const saved = store.get<Effort | null>(`rr.effort.${m.model}`, null); this.ui.sheet.effort = saved && m.efforts.includes(saved) ? saved : defaultEffort(m.efforts); }
        if (m && !m.efforts.length) this.ui.sheet.effort = null;
        this.renderSheet();
      } break;
      case "choose-effort": if (this.ui.sheet?.kind === "model") { this.ui.sheet.effort = (el.dataset.effort as Effort) ?? null; this.renderSheet(); } break;
      case "model-done": if (this.ui.sheet?.kind === "model" && this.ui.sheet.model) {
        const { model, effort, forSession } = this.ui.sheet;
        if (forSession) this.link?.send({ t: "set_model", session: forSession, model, effort });
        else { this.ui.draft.model = model; this.ui.draft.effort = effort; store.set("rr.draft", this.ui.draft); }
        this.rememberModel(model);
        store.set(`rr.effort.${model}`, effort);
        this.ui.sheet = null;
        this.render();
      } break;
      case "settings": this.toggleLang(); break;
      // No await before this: the permission prompt has to come from the tap itself.
      case "push-on": await this.turnOnPush(); break;
      case "push-later": store.set("rr.pushLater", true); this.ui.pushLater = true; this.render(); break;
    }
  }

  private toggleLang(): void {
    const next = (store.get<string | null>("rr.lang", null) ?? (document.documentElement.lang || "ko")) === "ko" ? "en" : "ko";
    store.set("rr.lang", next);
    setLang(next);
    document.documentElement.lang = next;
    this.renderedScreen = "";
    this.render();
  }

  private async toggleTool(id: string): Promise<void> {
    if (this.ui.expanded.has(id)) { this.ui.expanded.delete(id); this.rerenderItems(); return; }
    this.ui.expanded.set(id, null);
    this.rerenderItems();
    if (this.screen.name !== "session") return;
    const view = this.view(this.screen.id);
    const tool = view.items.flatMap((i) => (i.type === "assistant" ? i.tools : [])).find((x) => x.id === id);
    const session = this.screen.id;
    const values = [tool?.input, tool?.result?.text].filter((v) => v !== undefined);
    if (!values.some(v => typeof v !== "string")) return;
    try {
      const parts: string[] = [];
      for (const value of values) {
        if (typeof value === "string") { parts.push(value); continue; }
        let offset = 0, text = "";
        for (;;) {
          const chunk = await this.req<BlobChunk>({ op: "blob", session, id: value.blob, offset });
          text += chunk.text;
          if (chunk.next === null) break;
          offset = chunk.next;
        }
        parts.push(text);
      }
      if (this.ui.expanded.has(id)) this.ui.expanded.set(id, parts.filter(Boolean).join("\n\n────\n\n"));
    } catch (e) { this.toast(t("error.generic", { text: (e as Error).message })); }
    if (this.isCurrent(session)) this.rerenderItems();
  }

  private rerenderItems(): void {
    // Expanded state is UI-only; bump versions by re-rendering the list wholesale.
    const tl = document.getElementById("tl");
    if (tl) for (const child of Array.from(tl.children) as HTMLElement[]) child.dataset.ver = "";
    this.renderSession();
  }

  private async openSub(sub: string): Promise<void> {
    if (this.screen.name !== "session") return;
    try {
      const page = await this.req<SubPage>({ op: "sub", session: this.screen.id, sub });
      const view = reduce(page.events);
      const html = timelineItems(view).map((i) => V.item(i, this.ui)).join("");
      setHTML($("#sheet"), `<div class="scrim" data-act="close-sheet"></div><div class="sheet" role="dialog"><div class="grab"></div><div class="sh"><b>${esc(t("sub.worker"))}</b><button class="icon-btn" data-act="close-sheet" aria-label="${esc(t("a11y.close"))}">${icon.x(20)}</button></div><div class="sbody"><div class="tl">${html}</div></div></div>`);
      this.hydrateImages($("#sheet"), this.screen.id);
    } catch (e) { this.toast(t("error.generic", { text: (e as Error).message })); }
  }
}

export function boot(): void {
  const lang = pickLang(navigator.languages ?? [navigator.language], store.get<string | null>("rr.lang", null));
  setLang(lang);
  document.documentElement.lang = lang;
  const params = new URLSearchParams(location.search);
  const demo = params.get("demo");
  if (demo) { void import("./demo.ts").then((d) => d.runDemo(demo, params)); return; }
  new App({ state: "connecting", attempt: 0, nextAt: null, lastRx: null, downSince: null }).start();
}

boot();
