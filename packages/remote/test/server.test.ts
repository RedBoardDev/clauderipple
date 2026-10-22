import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay, setImmediate as nextTick } from "node:timers/promises";
import { WebSocket } from "ws";
import { PermissionQueue } from "../src/permissions.ts";
import { MessageReceipts } from "../src/receipts.ts";
import { FRAME_CAP, PING_MS, STALE_MS } from "../src/protocol.ts";
import type { BlobChunk, BrowseResult, ClientMsg, HostMsg, SessionEvent } from "../src/protocol.ts";
import { HostServer } from "../src/server.ts";
import type { ServerOptions } from "../src/server.ts";
import { VISIBLE_MS } from "../src/push.ts";
import { Sessions } from "../src/sessions.ts";
import type { QueryFn, SdkUserMessage } from "../src/sessions.ts";

const webDir = fileURLToPath(new URL("../web", import.meta.url));
const token = "remote-test-token-not-a-real-pairing-token";
const router = {
  status: async () => ({ ok: true, proxyEnv: { HTTPS_PROXY: "http://127.0.0.1:1" } }),
  figures: async () => ({ effort: null, cachePct: null, contextPct: null, fiveHourPct: null, fiveHourResetAt: null, workers: [], at: Date.now() }),
  models: async () => [],
};

function scriptedQuery() {
  const options: Record<string, unknown>[] = [];
  const users: SdkUserMessage[] = [];
  const spies = { interrupt: 0, setModel: [] as (string | undefined)[], close: 0 };
  const queryFn: QueryFn = params => {
    options.push(params.options);
    return {
      async *[Symbol.asyncIterator]() {
        let turn = 0;
        for await (const user of params.prompt) {
          users.push(user);
          if (turn++ === 0) yield { type: "system", subtype: "init", session_id: "sdk-1" };
          const id = `m${turn}`;
          yield { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id } } };
          yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "po" } } };
          yield { type: "assistant", parent_tool_use_id: null, message: { id, model: "x", content: [{ type: "text", text: "pong" }] } };
          yield { type: "result", subtype: "success", is_error: false, duration_ms: 5, num_turns: 1, modelUsage: { x: { contextWindow: 1000 } } };
        }
      },
      interrupt: async () => { spies.interrupt++; },
      setModel: async model => { spies.setModel.push(model); },
      setPermissionMode: async () => {},
      close: () => { spies.close++; },
    };
  };
  return { queryFn, options, users, spies };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "Timed out waiting for host or socket");
    await delay(5);
  }
  await nextTick();
}

type Frame = { msg: HostMsg; bytes: number };
type HostFrame<T extends HostMsg["t"]> = { msg: Extract<HostMsg, { t: T }>; bytes: number };

class Peer {
  readonly ws: WebSocket;
  readonly frames: Frame[] = [];
  readonly received: Frame[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private error: Error | null = null;
  private ping = 0;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.closed = new Promise(resolve => this.ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
    this.ws.on("error", error => { this.error = error; });
    this.ws.on("message", data => {
      const text = data.toString();
      const frame = { msg: JSON.parse(text) as HostMsg, bytes: Buffer.byteLength(text) };
      this.frames.push(frame);
      this.received.push(frame);
    });
  }

  async open(): Promise<void> {
    await waitFor(() => this.ws.readyState === WebSocket.OPEN || this.error !== null);
    if (this.error) throw this.error;
  }

  send(msg: ClientMsg): void { this.ws.send(JSON.stringify(msg)); }

  async take<T extends HostMsg["t"]>(kind: T, matches: (msg: Extract<HostMsg, { t: T }>) => boolean = () => true): Promise<HostFrame<T>> {
    const index = () => this.frames.findIndex(frame => frame.msg.t === kind && matches(frame.msg as Extract<HostMsg, { t: T }>));
    await waitFor(() => index() !== -1 || this.error !== null);
    if (this.error) throw this.error;
    const frame = this.frames.splice(index(), 1)[0]!;
    assert.equal(frame.msg.t, kind);
    return frame as HostFrame<T>;
  }

  async barrier(): Promise<void> {
    const n = ++this.ping;
    this.send({ t: "ping", n });
    await this.take("pong", msg => msg.n === n);
  }

  eventFrames(): HostFrame<"events">[] {
    const frames = this.frames.filter(frame => frame.msg.t === "events") as HostFrame<"events">[];
    for (let i = this.frames.length - 1; i >= 0; i--) if (this.frames[i]!.msg.t === "events") this.frames.splice(i, 1);
    return frames;
  }
}

async function fixture(t: TestContext, extra: Partial<ServerOptions> = {}, desktopProjects?: string, desktopProcesses?: () => string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-server-"));
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd);
  const permissions = PermissionQueue.open(path.join(dir, "permissions.json"));
  const fake = scriptedQuery();
  const peers: Peer[] = [];
  const diagnostics: string[] = [];
  let server: HostServer | undefined;
  let closing = false;
  const sessions = new Sessions({ dir, router, permissions, queryFn: fake.queryFn, coalesceMs: 5, ...(desktopProjects ? { desktopProjects, desktopProcesses: desktopProcesses ?? (() => ""), ...(extra.now ? { now: extra.now } : {}) } : {}),
    onEvent: session => { if (!closing) server?.onEvent(session); },
    onSessions: () => { if (!closing) server?.onSessions(); },
  });
  t.after(async () => {
    closing = true;
    for (const peer of peers) peer.ws.terminate();
    await server?.close();
    for (const session of sessions.list()) sessions.stop(session.id);
    await nextTick();
    sessions.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  server = new HostServer({ listen: "127.0.0.1", port: 0, token, webDir, sessions, router,
    hostName: "test-host", version: "test-version", recentCli: async () => [], log: line => diagnostics.push(line), ...extra,
  });
  await server.listen();
  const port = server.address().port;
  const connect = async () => {
    const peer = new Peer(`ws://127.0.0.1:${port}/ws`);
    peers.push(peer);
    await peer.open();
    return peer;
  };
  const auth = async () => {
    const peer = await connect();
    peer.send({ t: "hello", token, clientId: "test-client" });
    await peer.take("ready");
    return peer;
  };
  const create = async (clientMsgId = "create-1") => {
    const id = await sessions.create({ clientMsgId, cwd, model: "claude-test", effort: "high", text: "ping" });
    await waitFor(() => sessions.list().find(session => session.id === id)?.state === "idle");
    return id;
  };
  return { dir, cwd, sessions, fake, server, port, diagnostics, connect, auth, create };
}

test("attachment upload is chunked, checks offsets, and sends image blocks", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const peer = await f.auth();
  const data = Buffer.from('uploaded photo').toString('base64');
  peer.send({ t: 'req', reqId: 'bad-offset', op: { op: 'upload', session: id, uploadId: 'photo', offset: 4, data: data.slice(4), done: true } });
  assert.equal((await peer.take('res', m => m.reqId === 'bad-offset')).msg.ok, false);
  peer.send({ t: 'req', reqId: 'chunk-1', op: { op: 'upload', session: id, uploadId: 'photo', offset: 0, data: data.slice(0, 4), done: false } });
  assert.equal((await peer.take('res', m => m.reqId === 'chunk-1')).msg.ok, true);
  peer.send({ t: 'req', reqId: 'chunk-2', op: { op: 'upload', session: id, uploadId: 'photo', offset: 4, data: data.slice(4), done: true } });
  const response = (await peer.take('res', m => m.reqId === 'chunk-2')).msg;
  assert.ok(response.ok);
  const { blob } = response.data as { blob: string };
  assert.equal(f.sessions.log(id).blob(blob), data);
  peer.send({ t: 'send', session: id, clientMsgId: 'photo-send', text: 'look', attachments: [{ blob, name: 'photo.png', mediaType: 'image/png' }] });
  await peer.take('ack', m => m.clientMsgId === 'photo-send');
  await waitFor(() => f.fake.users.length === 2);
  assert.deepEqual(f.fake.users[1]!.message.content, [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }]);
});

test("set_mode returns correlated success/error and broadcasts the mode event", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const peer = await f.auth();
  peer.send({ t: 'attach', session: id });
  await peer.take('events');
  peer.send({ t: 'set_mode', reqId: 'mode-ok', sessionId: id, mode: 'plan' });
  assert.deepEqual((await peer.take('res', m => m.reqId === 'mode-ok')).msg, { t: 'res', reqId: 'mode-ok', ok: true, data: null });
  await peer.take('events', m => m.events.some(e => e.kind === 'mode' && e.mode === 'plan'));
  peer.send({ t: 'set_mode', reqId: 'mode-error', sessionId: 'missing', mode: 'auto' });
  assert.equal((await peer.take('res', m => m.reqId === 'mode-error')).msg.ok, false);
});

test("desktop polling runs on its own timer with no phone connected, so completion is detected", { timeout: 15_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-live-wire-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const file = path.join(project, `${id}.jsonl`);
  let now = Date.now();
  let processes = "";
  let calls = 0;
  fs.writeFileSync(file, JSON.stringify({ type: "user", cwd: project, message: { content: "synthetic prompt" } }) + "\n");
  const f = await fixture(t, { now: () => now }, root, () => { calls++; return processes; });
  const baseline = calls;
  processes = `42 claude --resume=${id}`;
  now += 3000;
  await delay(3100);
  assert.ok(calls > baseline, "no phone connected: the desktop poll still runs on its timer");
  assert.ok(f.sessions.list().some(s => s.id === id && s.state === "running"), "a Mac turn is detected with no clients");
  const peer = await f.auth();
  // A connected observer reports visibility, which intentionally restores the three-second cadence.
  peer.send({ t: "presence", visible: true });
  await peer.barrier();
  processes = "";
  now += 6000;
  await delay(3100);
  assert.ok(f.sessions.list().some(s => s.id === id && s.state === "stopped"), "completion is detected on the next visible-client poll");
  const changed = await peer.take("sessions", msg => msg.sessions.some(s => s.id === id && s.state === "stopped"));
  assert.equal(changed.msg.sessions[0]?.pending, 0);
});

test("desktop sessions use ready, history, blobs and continue through a same-session ACK", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-wire-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const lines = [{ type: "user", cwd: "/synthetic", uuid: "u1", message: { content: "Wire prompt" } }];
  let data = lines.map(r => JSON.stringify(r) + "\n").join("");
  for (let i = 0; i < 30; i++) data += JSON.stringify({ type: "assistant", uuid: `a${i}`, message: { model: "test", content: [{ type: "text", text: "a".repeat(20_000) }] } }) + "\n";
  data += JSON.stringify({ type: "assistant", uuid: "large", message: { model: "test", content: [{ type: "text", text: "z".repeat(100_000) }] } }) + "\n";
  fs.writeFileSync(path.join(project, `${id}.jsonl`), data);
  const f = await fixture(t, {}, root);
  const peer = await f.connect();
  peer.send({ t: "hello", token, clientId: "desktop-reader" });
  const ready = await peer.take("ready");
  assert.equal(ready.msg.sessions[0]?.readOnly, false);
  peer.send({ t: "attach", session: id });
  const tail = await peer.take("events");
  assert.equal(tail.msg.tail?.hasOlder, true);
  assert.ok(tail.bytes <= FRAME_CAP);
  peer.send({ t: "history", session: id, beforeSeq: tail.msg.events[0]!.seq, reqId: "older" });
  const history = await peer.take("history");
  assert.ok(history.msg.events.at(-1)!.seq < tail.msg.events[0]!.seq);
  assert.ok(history.bytes <= FRAME_CAP);
  const large = tail.msg.events.at(-1)!;
  assert.ok(large.kind === "assistant" && typeof large.text !== "string");
  peer.send({ t: "req", reqId: "blob", op: { op: "blob", session: id, id: large.text.blob } });
  const blob = await peer.take("res");
  assert.equal(blob.msg.ok && (blob.msg.data as BlobChunk).text, "z".repeat(60_000));
  peer.send({ t: "send", session: id, clientMsgId: "continue-wire", text: "continue" });
  const ack = await peer.take("ack");
  assert.equal(ack.msg.session, id);
  peer.send({ t: "attach", session: ack.msg.session });
  const continued = await peer.take("events", msg => msg.session === ack.msg.session && !!msg.tail);
  assert.ok(continued.msg.events.some(e => e.kind === "notice" && e.code === "desktop_resumed"));
  const imported = continued.msg.events.find(e => e.kind === "assistant" && e.msg === "large");
  assert.ok(imported?.kind === "assistant" && typeof imported.text !== "string");
  peer.send({ t: "req", reqId: "continued-blob", op: { op: "blob", session: ack.msg.session, id: imported.text.blob } });
  const copiedBlob = await peer.take("res", msg => msg.reqId === "continued-blob");
  assert.equal(copiedBlob.msg.ok && (copiedBlob.msg.data as BlobChunk).text, "z".repeat(60_000));
  peer.send({ t: "send", session: id, clientMsgId: "continue-wire", text: "continue" });
  assert.equal((await peer.take("ack")).msg.session, ack.msg.session);
  await waitFor(() => f.fake.users.length === 1);
  assert.equal(f.fake.options.length, 1);
  assert.equal(f.fake.options[0]?.resume, id);
  assert.equal(f.fake.options[0]?.forkSession, undefined);
  assert.equal(f.sessions.list().length, 1);
  assert.equal(fs.readFileSync(path.join(project, `${id}.jsonl`), "utf8"), data);
});

function get(port: number, target: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path: target, agent: false }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: res.headers["content-type"] ?? "", body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("HTTP test request timed out")));
  });
}

function readAll(sessions: Sessions, id: string): SessionEvent[] {
  const log = sessions.log(id);
  const events: SessionEvent[] = [];
  let cursor = 0;
  for (;;) {
    const page = log.readAfter(cursor);
    events.push(...page.events);
    if (!page.more) return events;
    assert.ok(page.events.length > 0);
    cursor = page.events.at(-1)!.seq;
  }
}

function seedLargeLog(sessions: Sessions, id: string): SessionEvent[] {
  const log = sessions.log(id);
  let bytes = 0;
  for (let i = 0; i < 120; i++) {
    const event = log.append({ kind: "tool_result", toolUseId: `tool-${i}`, ok: true, text: `${i}:` + "x".repeat(20 * 1024) });
    bytes += Buffer.byteLength(JSON.stringify(event)) + 1;
  }
  assert.ok(bytes >= 2 * 1024 * 1024, "Fixture must actually contain at least 2 MiB of inline events");
  return readAll(sessions, id);
}

test("hello denies and closes a wrong token, and returns ready with sessions for the right token", { timeout: 4500 }, async t => {
  const f = await fixture(t);
  const id = await f.create();
  const wrong = await f.connect();
  wrong.send({ t: "hello", token: "wrong", clientId: "wrong-client" });
  assert.deepEqual((await wrong.take("denied")).msg, { t: "denied", reason: "token" });
  assert.deepEqual(await wrong.closed, { code: 4003, reason: "denied" });
  const right = await f.connect();
  right.send({ t: "hello", token, clientId: "right-client" });
  const ready = (await right.take("ready")).msg;
  assert.deepEqual(ready.host, { name: "test-host", version: "test-version", routerOk: true });
  assert.deepEqual(ready.sessions, f.sessions.list());
  assert.equal(ready.sessions[0]?.id, id);
});

test("static serves HTML, strips app TypeScript, exposes only the shared protocol and rejects traversal", { timeout: 4500 }, async t => {
  const f = await fixture(t);
  const index = await get(f.port, "/");
  assert.equal(index.status, 200);
  assert.match(index.type, /^text\/html/);
  assert.match(index.body, /<!doctype html>/i);
  const source = fs.readFileSync(path.join(webDir, "app.ts"), "utf8");
  assert.ok(source.includes("submit(text: string): void"), "Known TypeScript signature must exist in the source");
  const app = await get(f.port, "/app.ts");
  assert.equal(app.status, 200);
  assert.match(app.type, /^text\/javascript/);
  assert.match(app.body, /submit\(text\s*\)\s*\{/);
  assert.ok(!app.body.includes("submit(text: string): void"));
  assert.ok(!app.body.includes(": string"));
  const protocol = await get(f.port, "/src/protocol.ts");
  assert.equal(protocol.status, 200);
  assert.match(protocol.type, /^text\/javascript/);
  assert.match(protocol.body, /export const FRAME_CAP/);
  assert.ok(!protocol.body.includes("export interface"));
  // The relay's encryption and tweetnacl are the other shared files; the service worker is an app file.
  assert.match((await get(f.port, "/src/e2ee.ts")).body, /export function phoneHello/);
  const naclJs = await get(f.port, "/vendor/nacl-fast.min.js");
  assert.equal(naclJs.status, 200);
  assert.match(naclJs.type, /^text\/javascript/);
  const sw = await get(f.port, "/sw.ts");
  assert.match(sw.type, /^text\/javascript/);
  assert.match(sw.body, /showNotification/);
  assert.ok(!sw.body.includes("interface SwScope"));
  // node:http preserves the literal path; fetch/URL would normalize ../ before sending it.
  for (const target of ["/../src/sessions.ts", "/src/sessions.ts", "/%2e%2e%2fsrc/sessions.ts"]) {
    assert.equal((await get(f.port, target)).status, 404, target);
  }
});

test("presence: a phone that reported visible within 30 s counts as looking; hidden, gone or silent does not", { timeout: 4500 }, async t => {
  let now = 1_000_000;
  const subscribed: { clientId: string; endpoint: string; lang: string }[] = [];
  const unsubscribed: string[] = [];
  const native: { clientId: string; token: string; lang: string }[] = [];
  const nativeRemoved: string[] = [];
  const f = await fixture(t, {
    now: () => now,
    push: { publicKey: "BPUBLICKEY", subscribe: (clientId, sub, lang) => { subscribed.push({ clientId, endpoint: sub.endpoint, lang }); }, unsubscribe: (id) => { unsubscribed.push(id); } },
    expoPush: { subscribe: (clientId, token, lang) => { native.push({ clientId, token, lang }); }, unsubscribe: id => { nativeRemoved.push(id); } },
  });
  const looking = (): boolean => f.server.someoneLooking();
  const peer = await f.auth();
  assert.equal(looking(), false, "connected is not looking");
  peer.send({ t: "presence", visible: true });
  await peer.barrier();
  assert.equal(looking(), true);
  now += VISIBLE_MS - 1;
  assert.equal(looking(), true);
  now += 2;
  assert.equal(looking(), false, "no fresh report: the app may be frozen in the background");
  peer.send({ t: "presence", visible: true });
  await peer.barrier();
  peer.send({ t: "presence", visible: false });
  await peer.barrier();
  assert.equal(looking(), false, "hidden");
  peer.send({ t: "presence", visible: true });
  await peer.barrier();
  // Push requests carry the device id from hello.
  peer.send({ t: "req", reqId: "k", op: { op: "push_key" } });
  assert.deepEqual((await peer.take("res", m => m.reqId === "k")).msg, { t: "res", reqId: "k", ok: true, data: { publicKey: "BPUBLICKEY" } });
  peer.send({ t: "req", reqId: "s", op: { op: "push_subscribe", subscription: { endpoint: "https://push.example/1", keys: { p256dh: "p", auth: "a" } }, lang: "ko" } });
  await peer.take("res", m => m.reqId === "s");
  assert.deepEqual(subscribed, [{ clientId: "test-client", endpoint: "https://push.example/1", lang: "ko" }]);
  peer.send({ t: "req", reqId: "u", op: { op: "push_unsubscribe" } });
  await peer.take("res", m => m.reqId === "u");
  assert.deepEqual(unsubscribed, ["test-client"]);
  peer.send({ t: "req", reqId: "native", op: { op: "expo_push_subscribe", token: "ExpoPushToken[test]", lang: "en" } });
  assert.equal((await peer.take("res", m => m.reqId === "native")).msg.ok, true);
  assert.deepEqual(native, [{ clientId: "test-client", token: "ExpoPushToken[test]", lang: "en" }]);
  peer.send({ t: "req", reqId: "native-off", op: { op: "expo_push_unsubscribe" } });
  await peer.take("res", m => m.reqId === "native-off");
  assert.deepEqual(nativeRemoved, ["test-client"]);
  peer.ws.close();
  await waitFor(() => !looking());
});

test("WebSocket upgrade refuses an evil Origin", { timeout: 4500 }, async t => {
  const f = await fixture(t);
  await new Promise<void>((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port: f.port, path: "/ws", agent: false,
      headers: { Origin: "http://evil.example", Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": Buffer.alloc(16).toString("base64") },
    });
    t.after(() => req.destroy());
    req.on("upgrade", (_res, socket) => { socket.destroy(); reject(new Error("Cross-origin upgrade was accepted")); });
    req.on("response", res => { res.resume(); reject(new Error(`Expected refused upgrade, received HTTP ${res.statusCode}`)); });
    req.on("error", error => {
      if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") { reject(error); return; }
      resolve();
    });
    req.setTimeout(2000, () => req.destroy(new Error("Upgrade test timed out")));
    req.end();
  });
});

test("attach tails without a cursor, replays exactly after epoch/seq, and tails for a wrong epoch", { timeout: 4500 }, async t => {
  const f = await fixture(t);
  const id = await f.create();
  const first = await f.auth();
  first.send({ t: "attach", session: id });
  const tail = (await first.take("events")).msg;
  assert.deepEqual(tail.tail, { hasOlder: false });
  assert.deepEqual(tail.events, readAll(f.sessions, id));
  const afterSeq = tail.events.at(-1)!.seq;
  f.sessions.send(id, "next-user", "second turn");
  await waitFor(() => f.fake.users.length === 2 && f.sessions.list()[0]?.state === "idle");
  await first.barrier();
  const live = first.eventFrames().flatMap(frame => frame.msg.events);
  assert.ok(live.some(event => event.kind === "user" && event.clientMsgId === "next-user"));
  assert.equal(new Set(live.map(event => event.seq)).size, live.length);

  const second = await f.auth();
  second.send({ t: "attach", session: id, epoch: tail.epoch, afterSeq });
  await second.barrier();
  const replay = second.eventFrames();
  assert.ok(replay.length > 0);
  assert.ok(replay.every(frame => !Object.hasOwn(frame.msg, "tail")));
  const expected = readAll(f.sessions, id).filter(event => event.seq > afterSeq);
  assert.deepEqual(replay.flatMap(frame => frame.msg.events), expected);
  const seqs = replay.flatMap(frame => frame.msg.events.map(event => event.seq));
  assert.equal(new Set(seqs).size, seqs.length);
  assert.ok(seqs.every(seq => seq > afterSeq));
  second.send({ t: "detach", session: id });
  second.send({ t: "attach", session: id, epoch: "wrong-epoch", afterSeq });
  const wrongEpoch = (await second.take("events")).msg;
  assert.equal(wrongEpoch.epoch, tail.epoch);
  assert.deepEqual(wrongEpoch.tail, { hasOlder: false });
  assert.deepEqual(wrongEpoch.events, readAll(f.sessions, id));
});

test("history pages a >=2 MiB log back to seq 1 with bounded frames and every visible seq exactly once", { timeout: 4500 }, async t => {
  const f = await fixture(t);
  const id = await f.create();
  const expected = seedLargeLog(f.sessions, id);
  const peer = await f.auth();
  peer.send({ t: "attach", session: id });
  const tail = await peer.take("events");
  assert.ok(tail.bytes <= FRAME_CAP);
  assert.ok(tail.msg.tail?.hasOlder);
  let events = tail.msg.events;
  let hasOlder: boolean = tail.msg.tail.hasOlder;
  let seen = events.slice();
  let pages = 0;
  while (hasOlder) {
    assert.ok(++pages < 100, "History cursor must advance");
    assert.ok(events.length > 0);
    const beforeSeq = events[0]!.seq;
    const reqId = `history-${pages}`;
    peer.send({ t: "history", session: id, beforeSeq, reqId });
    const frame = await peer.take("history", msg => msg.reqId === reqId);
    assert.ok(frame.bytes <= FRAME_CAP, `History frame has ${frame.bytes} bytes`);
    assert.equal(frame.msg.session, id);
    assert.ok(frame.msg.events.every(event => event.seq < beforeSeq));
    events = frame.msg.events;
    seen = [...events, ...seen];
    hasOlder = frame.msg.hasOlder;
  }
  assert.ok(pages > 4);
  assert.equal(seen[0]?.seq, 1);
  assert.deepEqual(seen, expected);
  assert.equal(new Set(seen.map(event => event.seq)).size, seen.length);
  assert.ok(peer.received.every(frame => frame.bytes <= FRAME_CAP));
  assert.deepEqual(f.diagnostics, []);
});

test("large catch-up from afterSeq=1 sends a tail rather than replaying a >=2 MiB log", { timeout: 4500 }, async t => {
  const f = await fixture(t);
  const id = await f.create();
  seedLargeLog(f.sessions, id);
  const log = f.sessions.log(id);
  const peer = await f.auth();
  peer.send({ t: "attach", session: id, epoch: log.epoch, afterSeq: 1 });
  await peer.barrier();
  const frames = peer.eventFrames();
  assert.equal(frames.length, 1);
  const frame = frames[0]!;
  assert.ok(frame.bytes <= FRAME_CAP);
  assert.deepEqual(frame.msg.tail, { hasOlder: true });
  assert.equal(frame.msg.more, false);
  assert.deepEqual(frame.msg.events, log.tail().events);
  assert.ok(frame.msg.events[0]!.seq > 2);
});

test("sequential socket create retries ack the same session and start one query", { timeout: 4500 }, async t => {
  const f = await fixture(t);
  const peer = await f.auth();
  const request: ClientMsg = { t: "create", clientMsgId: "socket-create", cwd: f.cwd, model: "claude-test", effort: "high", text: "ping" };
  peer.send(request);
  const first = (await peer.take("ack")).msg;
  peer.send(request);
  const second = (await peer.take("ack")).msg;
  assert.equal(first.clientMsgId, "socket-create");
  assert.deepEqual(second, first);
  await waitFor(() => f.sessions.list()[0]?.state === "idle");
  assert.equal(f.sessions.list().length, 1);
  assert.equal(f.fake.options.length, 1);
});

test("concurrent socket create retries ack the same session and start one query", {
  timeout: 4500,
}, async t => {
  const f = await fixture(t);
  const peer = await f.auth();
  const request: ClientMsg = { t: "create", clientMsgId: "socket-create", cwd: f.cwd, model: "claude-test", effort: "high", text: "ping" };
  peer.send(request);
  peer.send(request);
  const first = (await peer.take("ack")).msg;
  const second = (await peer.take("ack")).msg;
  assert.deepEqual(second, first);
  await waitFor(() => f.sessions.list()[0]?.state === "idle");
  assert.equal(f.sessions.list().length, 1);
  assert.equal(f.fake.options.length, 1);
});

test("a send resend of a completed id acks without re-running; an orphaned one answers outcome_unknown", { timeout: 4500 }, async t => {
  const f = await fixture(t);
  const id = await f.create();
  const peer = await f.auth();
  peer.send({ t: "send", session: id, clientMsgId: "socket-send", text: "again" });
  const first = (await peer.take("ack")).msg;
  assert.equal(first.clientMsgId, "socket-send");
  await waitFor(() => f.fake.users.length === 2);
  peer.send({ t: "send", session: id, clientMsgId: "socket-send", text: "again" });
  assert.deepEqual((await peer.take("ack")).msg, first);
  assert.equal(f.fake.users.length, 2, "completed resend acks without running again");
});

test("a send orphaned by a host restart answers outcome_unknown over the socket without running", { timeout: 4500 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-restart-wire-"));
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd);
  const permissionsFile = path.join(dir, "permissions.json");
  const fake = scriptedQuery();
  const peers: Peer[] = [];
  let sessions = new Sessions({ dir, router, permissions: PermissionQueue.open(permissionsFile), queryFn: fake.queryFn, coalesceMs: 5, onEvent: () => {}, onSessions: () => {} });
  let server: HostServer | undefined;
  t.after(async () => {
    for (const peer of peers) peer.ws.terminate();
    await server?.close();
    for (const session of sessions.list()) sessions.stop(session.id);
    await nextTick();
    sessions.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const id = await sessions.create({ clientMsgId: "restart-1", cwd, model: "claude-test", effort: "high", text: "ping" });
  await waitFor(() => sessions.list()[0]?.state === "idle");
  // The first attempt wrote pending, then the host died before completing it.
  MessageReceipts.open(path.join(dir, "receipts.json")).begin(`send:${id}:lost-1`, id);
  sessions.shutdown();
  sessions = new Sessions({ dir, router, permissions: PermissionQueue.open(permissionsFile), queryFn: fake.queryFn, coalesceMs: 5, onEvent: () => {}, onSessions: () => {} });
  server = new HostServer({ listen: "127.0.0.1", port: 0, token, webDir, sessions, router, hostName: "test-host", version: "test-version", recentCli: async () => [], log: () => {} });
  await server.listen();
  const peer = new Peer(`ws://127.0.0.1:${server.address().port}/ws`);
  peers.push(peer);
  await peer.open();
  peer.send({ t: "hello", token, clientId: "restart-client" });
  await peer.take("ready");
  peer.send({ t: "send", session: id, clientMsgId: "lost-1", text: "lost turn" });
  const unknown = await peer.take("error", m => m.clientMsgId === "lost-1");
  assert.equal(unknown.msg.code, "outcome_unknown");
  assert.equal(unknown.msg.message, "전송 결과를 확인할 수 없음");
  assert.equal(fake.users.length, 1, "the orphaned turn never reached the SDK again");
  peer.send({ t: "send", session: id, clientMsgId: "fresh-1", text: "new turn" });
  await peer.take("ack", m => m.clientMsgId === "fresh-1");
  await waitFor(() => fake.users.length === 2);
});

test("answering the same approval twice resolves once; the second answer gets 이미 처리됨", { timeout: 4500 }, async t => {
  const f = await fixture(t);
  await f.create();
  const peer = await f.auth();
  peer.send({ t: "decide", session: "missing", id: "unknown", decision: "allow", reqId: "twice-1" });
  assert.deepEqual((await peer.take("res", m => m.reqId === "twice-1")).msg, { t: "res", reqId: "twice-1", ok: false, error: "이미 처리됨" });
  peer.send({ t: "decide", session: "missing", id: "unknown", decision: "allow" });
  const error = await peer.take("error");
  assert.equal(error.msg.code, "permission");
  assert.equal(error.msg.message, "이미 처리됨");
});

test("a looked-at session suppresses push for 180 s; other sessions are unaffected", { timeout: 4500 }, async t => {
  let now = 1_000_000;
  const f = await fixture(t, { now: () => now });
  const id = await f.create();
  const peer = await f.auth();
  assert.equal(f.server.sessionSeenRecently(id), false);
  peer.send({ t: "attach", session: id });
  await peer.take("events");
  await peer.barrier();
  assert.equal(f.server.sessionSeenRecently(id), true);
  now += 179_000;
  assert.equal(f.server.sessionSeenRecently(id), true);
  now += 2_000;
  assert.equal(f.server.sessionSeenRecently(id), false, "180 s with no look: push goes out");
  peer.send({ t: "presence", visible: true });
  await peer.barrier();
  assert.equal(f.server.sessionSeenRecently(id), true, "visible presence while attached refreshes the look");
  assert.equal(f.server.sessionSeenRecently("other-session"), false);
});

test("a client silent after hello is terminated after STALE_MS using virtual Date and intervals", { timeout: 4500 }, async t => {  // Node's public timer mocks cover both Date.now() and the host's periodic reaper;
  // network I/O and the test's promise-based deadlines still use real time.
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000_000 });
  const f = await fixture(t);
  const peer = await f.auth();
  t.mock.timers.tick(STALE_MS - 1);
  await nextTick();
  assert.equal(peer.ws.readyState, WebSocket.OPEN);
  t.mock.timers.tick(PING_MS + 2);
  const closed = await peer.closed;
  assert.equal(closed.code, 1006);
  assert.equal(peer.ws.readyState, WebSocket.CLOSED);
});

test("blob req chunks round-trip full Unicode output with next offsets until null", { timeout: 4500 }, async t => {
  const f = await fixture(t);
  const id = await f.create();
  const text = "界😀\n".repeat(45_000);
  const event = f.sessions.log(id).append({ kind: "tool_result", toolUseId: "large-output", ok: true, text });
  assert.ok(event.kind === "tool_result" && typeof event.text !== "string");
  const peer = await f.auth();
  let offset: number | null = 0;
  let combined = "";
  let chunks = 0;
  while (offset !== null) {
    assert.ok(++chunks < 20, "Blob cursor must advance");
    const reqId = `blob-${chunks}`;
    peer.send({ t: "req", reqId, op: { op: "blob", session: id, id: event.text.blob, offset } });
    const frame = await peer.take("res", msg => msg.reqId === reqId);
    assert.ok(frame.bytes <= FRAME_CAP);
    assert.equal(frame.msg.ok, true);
    const chunk = frame.msg.data as BlobChunk;
    assert.equal(chunk.offset, offset);
    assert.equal(chunk.bytes, Buffer.byteLength(text));
    assert.ok(chunk.text.length > 0);
    combined += chunk.text;
    if (chunk.next !== null) assert.equal(chunk.next, offset + chunk.text.length);
    offset = chunk.next;
  }
  assert.ok(chunks > 1);
  assert.equal(combined, text);
});

test("large image blobs round-trip in capped frames without inlining bytes in events", async t => {
  const f = await fixture(t);
  const id = await f.create();
  const bytes = Buffer.alloc(700_000, 173);
  const data = bytes.toString("base64");
  const blob = f.sessions.log(id).image(data);
  const event = f.sessions.log(id).append({ kind: "user", text: "", clientMsgId: "image-user", images: [{ type: "image", blob, mediaType: "image/png" }] });
  assert.ok(Buffer.byteLength(JSON.stringify(event)) < 1024);
  const peer = await f.auth();
  let offset: number | null = 0, combined = "", chunks = 0;
  while (offset !== null) {
    const reqId = `image-${++chunks}`;
    peer.send({ t: "req", reqId, op: { op: "blob", session: id, id: blob, offset } });
    const frame = await peer.take("res", msg => msg.reqId === reqId);
    assert.ok(frame.bytes <= FRAME_CAP);
    assert.ok(frame.msg.ok);
    const chunk = frame.msg.data as BlobChunk;
    assert.equal(chunk.offset, offset);
    combined += chunk.text; offset = chunk.next;
  }
  assert.ok(chunks > 10);
  assert.deepEqual(Buffer.from(combined, "base64"), bytes);
});

test("browse req lists only visible subdirectories in sorted order", { timeout: 4500 }, async t => {
  const f = await fixture(t);
  const dir = path.join(f.dir, "browse");
  fs.mkdirSync(dir);
  for (const name of ["zeta", "folder10", "Alpha", "folder2", ".hidden"]) fs.mkdirSync(path.join(dir, name));
  fs.writeFileSync(path.join(dir, "not-a-directory.txt"), "file");
  const peer = await f.auth();
  peer.send({ t: "req", reqId: "browse", op: { op: "browse", path: dir } });
  const response = (await peer.take("res", msg => msg.reqId === "browse")).msg;
  assert.equal(response.ok, true);
  const result = response.data as BrowseResult;
  assert.equal(result.path, dir);
  assert.equal(result.parent, f.dir);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.entries, ["Alpha", "folder2", "folder10", "zeta"].map(name => ({ name, path: path.join(dir, name) })));
});

test("host info carries the mod's status, refreshes limits once a minute, and reaches connected phones when it changes", { timeout: 6000 }, async t => {
  let clock = 1_792_380_000_000;
  const calls = { limits: 0, settings: 0 };
  let activeMode = "m1", failLimits = false, routerOk = true;
  const limits = () => ({ providers: [{ provider: "anthropic", type: "anthropic", title: "Claude", accounts: [{ account: 0, windows: [{ kind: "five_hour", used_percent: 38, window_minutes: 300, reset_at: Math.round((clock + 600_000) / 1000) }] }] }] });
  const modRouter = {
    ...router,
    status: async () => ({ ok: routerOk, ...(routerOk ? {} : { problem: "down" }), proxyEnv: {} }),
    limits: async () => { calls.limits++; if (failLimits) throw new Error("limits down"); return limits(); },
    modSettings: async () => { calls.settings++; return { settings: { activeMode, effortAuto: true, floor: "low", ceiling: "max", modes: [{ id: "m1", name: "Saver" }, { id: "m2", name: "Maxing" }] } }; },
  };
  const f = await fixture(t, { router: modRouter, now: () => clock });
  const check = () => (f.server as unknown as { checkRouter(): Promise<void> }).checkRouter();
  await check();
  const peer = await f.auth();
  const ready = peer.received.find(frame => frame.msg.t === "ready")!.msg as Extract<HostMsg, { t: "ready" }>;
  assert.equal(ready.host.ripple?.mode?.name, "Saver", "ready carries the status");
  assert.deepEqual(ready.host.ripple?.limits.map(l => [l.provider, l.usedPct]), [["anthropic", 38]]);

  const limitsBefore = calls.limits;
  clock += 20_000; await check(); await peer.barrier();
  assert.equal(calls.limits, limitsBefore, "limits are not read again inside a minute");
  assert.equal(peer.frames.filter(frame => frame.msg.t === "host").length, 0, "nothing changed, so nothing is sent (the `at` moving is not a change)");

  activeMode = "m2";
  clock += 20_000; await check();
  const changed = (await peer.take("host")).msg;
  assert.equal(changed.host.ripple?.mode?.name, "Maxing", "a changed mode reaches a connected phone without reconnecting");

  clock += 61_000; failLimits = true; await check();
  assert.equal(calls.limits, limitsBefore + 1, "a minute on, limits are read again");
  assert.equal(peer.frames.filter(frame => frame.msg.t === "host").length, 0, "a failed read keeps the last good limits, so nothing changes");
  await peer.barrier();
  clock += 600_000; await check();
  const expired = (await peer.take("host")).msg;
  assert.deepEqual(expired.host.ripple?.limits, [], "the kept window's reset has passed by now and it is dropped");

  routerOk = false; await check();
  const down = (await peer.take("host")).msg;
  assert.equal(down.host.routerOk, false);
  assert.equal("ripple" in down.host, false, "with the router down there is no status to show");
});

test("the context window the SDK reports for a model is kept for Mac sessions on that model", { timeout: 4500 }, async t => {
  const f = await fixture(t);
  await f.create();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir, "context-windows.json"), "utf8")), { x: 1000 });
});
