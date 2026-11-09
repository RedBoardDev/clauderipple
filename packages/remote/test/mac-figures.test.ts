import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Sessions } from "../src/sessions.ts";
import { PermissionQueue } from "../src/permissions.ts";
import { BridgeClient } from "../src/bridge-client.ts";
import type { DesktopProcess } from "../src/desktop.ts";
import type { Figures, SessionEvent } from "../src/protocol.ts";
import { RouterClient } from "../src/router.ts";

const id = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const line = (value: unknown): string => JSON.stringify(value) + "\n";
const user = { type: "user", uuid: "u1", cwd: "/synthetic/project", timestamp: "2026-10-12T01:00:00Z", message: { content: "First prompt" } };
const assistant = { type: "assistant", uuid: "a1", message: { id: "m1", model: "test-model", stop_reason: "end_turn", content: [{ type: "text", text: "Answer" }] } };
const figures = (over: Partial<Figures> = {}): Figures => ({
  effort: "high", cachePct: 90, contextPct: null, contextTokens: 5000, contextWindow: null,
  route: { model: "test-model", provider: "anthropic", ok: true, status: 200 },
  fiveHourPct: null, fiveHourResetAt: null, workers: [], at: 0, ...over,
});

const idleBridge = (): BridgeClient => new BridgeClient({
  auth: () => ({ accessToken: "test", organizationUuid: "org", expiresAt: Date.now() + 60_000 }),
  fetch: async (url, options) => {
    if (String(url).includes("sort_order=")) return Response.json({ data: [] });
    if (!String(url).includes("/events/stream")) return Response.json({ worker_status: "idle" });
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      options?.signal?.addEventListener("abort", () => { try { controller.close(); } catch { /* already closed */ } }, { once: true });
    } }));
  },
});

/** A Mac session the host only reads, with a router that records what it was asked for figures. */
function fixture(t: TestContext, opts: { status?: DesktopProcess["status"]; bridgeId?: string; windows?: Record<string, number>; reply?: () => Figures | Promise<Figures> } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mac-figures-"));
  const project = path.join(root, "projects", "project");
  fs.mkdirSync(project, { recursive: true });
  const transcript = path.join(project, `${id}.jsonl`);
  fs.writeFileSync(transcript, line(user) + line(assistant));
  if (opts.windows) { fs.mkdirSync(path.join(root, "host"), { recursive: true }); fs.writeFileSync(path.join(root, "host", "context-windows.json"), JSON.stringify(opts.windows)); }
  const registry = new Map<string, DesktopProcess>([[id, { sessionId: id, pid: 42, status: opts.status ?? "busy", ...(opts.bridgeId ? { bridgeSessionId: opts.bridgeId } : {}) }]]);
  const asked: { session: string; model: string; window: number | null }[] = [];
  const events: { session: string; event: SessionEvent }[] = [];
  let now = Date.now();
  const sessions = new Sessions({
    dir: path.join(root, "host"), now: () => now,
    desktopProjects: path.join(root, "projects"), desktopRegistry: () => registry, desktopProcesses: () => "",
    permissions: PermissionQueue.open(path.join(root, "permissions.json")), bridgeClient: idleBridge(),
    router: { status: async () => ({ ok: true, proxyEnv: {} }), figures: async (session, model, window) => { asked.push({ session, model, window }); return (opts.reply ?? figures)(); } },
    queryFn: () => { throw new Error("no SDK is spawned for a Mac session"); },
    log: () => {}, onEvent: (session, event) => events.push({ session, event }), onSessions: () => {},
  });
  t.after(async () => {
    sessions.shutdown();
    await new Promise(resolve => setImmediate(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    registry, sessions, asked, events, transcript,
    setStatus: (status: DesktopProcess["status"]) => { registry.get(id)!.status = status; },
    advance: (ms = 4000) => { now += ms; },
    poll: async () => { await sessions.pollDesktop(); await new Promise(resolve => setImmediate(resolve)); },
    figureEvents: () => sessions.log(id).tail().events.filter(e => e.kind === "figures"),
  };
}

test("a Mac session's figures are read when first seen, every 15 s while its turn runs, and once when it ends", async t => {
  const f = fixture(t);
  await f.poll();
  assert.deepEqual(f.asked, [{ session: id, model: "test-model", window: null }], "first sight asks once, with the CLI id the router logs");
  for (let i = 0; i < 3; i++) { f.advance(); await f.poll(); }
  assert.equal(f.asked.length, 1, "12 s into the turn is inside the throttle");
  f.advance(); await f.poll();
  assert.equal(f.asked.length, 2, "16 s on, a running turn reads again");
  f.advance(); f.setStatus("idle"); await f.poll();
  assert.equal(f.asked.length, 3, "the turn ending forces one more read");
  for (let i = 0; i < 3; i++) { f.advance(); await f.poll(); }
  assert.equal(f.asked.length, 3, "an idle session is left alone");
});

test("the figures reach the session's log, once per change, and survive the snapshot being rebuilt", async t => {
  const f = fixture(t);
  await f.poll();
  const first = f.figureEvents();
  assert.equal(first.length, 1);
  assert.equal(first[0]!.kind === "figures" && first[0]!.figures.contextTokens, 5000);
  f.advance(16_000); await f.poll();
  assert.equal(f.figureEvents().length, 1, "the same figures are not appended twice");
  // The transcript grows: the next snapshot is built again from it, and still carries the figures.
  fs.appendFileSync(f.transcript, line({ type: "user", uuid: "u2", cwd: "/synthetic/project", timestamp: "2026-10-12T01:01:00Z", message: { content: "Second prompt" } }));
  f.advance(); await f.poll();
  assert.equal(f.figureEvents().length, 1);
  assert.ok(f.sessions.log(id).tail().events.some(e => e.kind === "user" && e.text === "Second prompt"));
});

test("a phone reading the snapshot is told when new figures arrive", async t => {
  let tokens = 5000;
  const f = fixture(t, { reply: () => figures({ contextTokens: tokens }) });
  await f.poll();
  f.sessions.log(id);
  tokens = 9000;
  f.advance(16_000); await f.poll();
  const seen = f.events.filter(e => e.session === id && e.event.kind === "figures");
  assert.equal(seen.length, 1, "the snapshot did not exist at first sight, so only the change after it is announced");
  assert.equal(f.figureEvents().length, 2);
});

test("a session the router has no record of says nothing", async t => {
  const f = fixture(t, { reply: () => figures({ effort: null, route: null, contextTokens: null, cachePct: null }) });
  await f.poll();
  assert.equal(f.asked.length, 1);
  assert.equal(f.figureEvents().length, 0);
});

test("the window learned for a model is passed along; an unknown model gets none", async t => {
  const f = fixture(t, { windows: { "test-model": 123_456, other: 1 } });
  await f.poll();
  assert.equal(f.asked[0]!.window, 123_456);
  const g = fixture(t, { windows: { other: 1 } });
  await g.poll();
  assert.equal(g.asked[0]!.window, null, "no window is guessed");
});

test("a Mac session the host tails over Remote Control gets its figures in its own log", async t => {
  const f = fixture(t, { bridgeId: "bridge" });
  f.sessions.log(id); // opening it from the phone makes the record
  await f.poll();
  assert.deepEqual(f.asked.map(a => a.session), [id]);
  assert.equal(f.figureEvents().length, 1);
  assert.ok(f.events.some(e => e.session === id && e.event.kind === "figures"), "a live log announces it");
});

test("catalogue values outrank SDK caches and a [1m] name alone proves no window", async () => {
  let windowReads = 0;
  const fetchStub = async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/api/context-windows") { windowReads++; return { ok: true, status: 200, json: async () => ({ windows: { "claude-opus-5-5": 400_000 } }) }; }
    if (path === "/api/requests") return { ok: true, status: 200, json: async () => ({ requests: [{ at: "2026-10-19T00:00:00Z", source: "claude-opus-5-5", target: "claude-opus-5-5", provider: "anthropic", ok: true, status: 200, usage: { input: 2, cached: 99_998, cacheWrite: 0 } }] }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const router = new RouterClient("http://127.0.0.1:1", fetchStub);
  const known = await router.figures("s", "claude-opus-5-5", null);
  assert.equal(known.contextWindow, 400_000);
  assert.equal(known.contextPct, 25);
  assert.equal((await router.figures("s", "claude-opus-5-5[1m]", null)).contextWindow, null);
  assert.equal((await router.figures("s", "other-model", null)).contextWindow, null);
  assert.equal((await router.figures("s", "claude-opus-5-5", 200_000)).contextWindow, 400_000);
  assert.equal(windowReads, 4, "a model-only cache must not hide a changed route/window");
});

test("Astra figures use the resolved window over a cached million-token SDK/native alias", async () => {
  let source = "gpt-6-astra@high";
  let target = "gpt-6-astra";
  let provider = "chatgpt";
  let body: unknown = {};
  const router = new RouterClient("http://fixture.invalid", async url => ({ ok: true, status: 200, json: async () => {
    if (new URL(url).pathname === "/api/context-windows") return body;
    if (new URL(url).pathname === "/api/requests") return { requests: [{ source, target, provider, at: "2026-10-25T00:00:00Z", ok: true, status: 200, usage: { input: 8400, cached: 250000 } }] };
    return {};
  } }));
  const resolution = (window: number | null) => ({ model: "gpt-6-astra", provider: "chatgpt", contextWindow: window });
  body = { windows: { "gpt-6-astra": 272000 }, resolvedWindows: { "gpt-6-astra": resolution(258400) } };
  let f = await router.figures("s", source, 1_000_000);
  assert.deepEqual([f.contextTokens, f.contextWindow, f.contextPct], [258400, 258400, 100]);
  body = { resolvedWindows: { "gpt-6-astra": resolution(272000) } };
  assert.equal((await router.figures("s", source, 1_000_000)).contextWindow, 272000, "same model reads a changed window immediately");
  source = "claude-opus-4-8[1m]";
  body = { windows: { [source]: 1_000_000, "gpt-6-astra": 272000 }, resolvedWindows: { [source]: { model: source, provider: null, contextWindow: 1_000_000 }, "gpt-6-astra": resolution(258400) } };
  f = await router.figures("s", source, 1_000_000);
  assert.equal(f.contextWindow, 258400, "native alias window cannot override the actual request target");
  body = { resolvedWindows: { [source]: resolution(200000), "gpt-6-astra": resolution(258400) } };
  assert.equal((await router.figures("s", source, 1_000_000)).contextWindow, 200000, "a matching explicit route override remains first");
  target = "unresolved-model";
  f = await router.figures("s", source, 1_000_000);
  assert.deepEqual([f.contextWindow, f.contextPct], [null, null], "a fallback cannot inherit the original route's capacity");
  target = "gpt-6-astra";
  provider = "other";
  assert.equal((await router.figures("s", source, 1_000_000)).contextWindow, null, "a same-id model on another provider is not the same resolution");
  provider = "chatgpt";
  for (const window of [null, 0, -1, Infinity, NaN]) {
    body = { windows: { [source]: 1_000_000 }, resolvedWindows: { "gpt-6-astra": resolution(window) } };
    f = await router.figures("s", source, 1_000_000);
    assert.deepEqual([f.contextWindow, f.contextPct], [null, null]);
  }
  body = { windows: { [source]: 1_000_000, "gpt-6-astra": 272000 } };
  assert.equal((await router.figures("s", source, 1_000_000)).contextWindow, 272000, "old router compatibility uses the actual target, not the source");
  body = null;
  assert.equal((await router.figures("s", source, 1_000_000)).contextWindow, null, "unavailable router metadata does not revive a cached million");
});

test("an idle same-model session refreshes figures after its snapshot epoch changes", async t => {
  const f = fixture(t, { status: "idle" });
  await f.poll();
  const oldEpoch = f.sessions.log(id).epoch;
  await f.poll(); // binds the first materialized snapshot
  fs.appendFileSync(f.transcript, line({ ...user, uuid: "u2", message: { content: "Next epoch" } }));
  f.advance(); await f.poll();
  assert.notEqual(f.sessions.log(id).epoch, oldEpoch);
  await f.poll();
  assert.equal(f.asked.length, 2, "idle state and the 15-second throttle do not suppress an epoch refresh");
  assert.equal(f.figureEvents().at(-1)?.kind, "figures");
});

test("an old figures read cannot overwrite the same model's new epoch", async t => {
  const pending = Promise.withResolvers<Figures>();
  let reads = 0;
  const f = fixture(t, { status: "idle", reply: () => ++reads === 1 ? pending.promise : figures({ contextWindow: 258400 }) });
  const original = f.sessions.log(id).epoch;
  await f.poll();
  fs.appendFileSync(f.transcript, line({ ...user, uuid: "u2", message: { content: "Replacement snapshot" } }));
  f.advance(); await f.poll();
  assert.notEqual(f.sessions.log(id).epoch, original);
  await f.poll();
  pending.resolve(figures({ contextWindow: 1_000_000 }));
  await new Promise(resolve => setImmediate(resolve));
  const events = f.figureEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind === "figures" && events[0].figures.contextWindow, 258400);
});
