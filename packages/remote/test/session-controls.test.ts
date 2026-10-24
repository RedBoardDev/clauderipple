import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { approval, bridgeFixture, bridgeId, line, tick, type BridgeFixture } from "./bridge-fixture.ts";
import { SessionSettings, sessionPermissionRules } from "../src/session-controls.ts";
import { BridgeClient } from "../src/bridge-client.ts";
import type { SettingsResult } from "../src/protocol.ts";
import { reduce } from "../web/timeline.ts";
import { Sessions } from "../src/sessions.ts";
import { PermissionQueue } from "../src/permissions.ts";
import { OutcomeUnknownError } from "../src/receipts.ts";

interface ControlPayload { type: string; request_id: string; request: Record<string, unknown> }
async function posted(f: BridgeFixture, index = 0): Promise<ControlPayload> {
  await tick(); await tick();
  assert.ok(f.posts[index], `missing POST ${index}`);
  return (f.posts[index] as { events: { payload: ControlPayload }[] }).events[0]!.payload;
}
const reply = (id: string, subtype = "success", extra = {}) => ({ type: "control_response", response: { request_id: id, subtype, response: {}, ...extra } });
const suggestions = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "git status:*" }], behavior: "allow", destination: "userSettings" }];
const safe = { permission_suggestions: suggestions, suppress_always_allow_rule: false };

test("model success and effort rejection report partial, without confusing approval or client replies", async t => {
  const f = bridgeFixture(t);
  f.sessions.log(bridgeId);
  await tick(); await tick();
  f.emit(approval("approval"));
  await tick();
  const permission = f.permissions.pending(bridgeId)[0]!;
  const changing = f.sessions.setModel(bridgeId, "claude-sonnet-test", "high", "model-partial");
  const model = await posted(f);
  assert.deepEqual(model.request, { subtype: "set_model", model: "claude-sonnet-test" });
  f.emit(reply(model.request_id), "client");
  f.emit(reply("another-settings-request"));
  await tick();
  assert.equal(f.posts.length, 1);
  assert.equal(f.permissions.pending(bridgeId).length, 1);
  f.emit(reply(model.request_id));
  const effort = await posted(f, 1);
  assert.deepEqual(effort.request, { subtype: "apply_flag_settings", settings: { effortLevel: "high" } });
  f.emit(reply(effort.request_id, "error", { error: "effort overridden" }));
  assert.deepEqual(await changing, { status: "partial", model: "claude-sonnet-test", errors: { effort: "effort overridden" } });
  assert.equal(f.permissions.get(permission.id)?.state, "pending");
  const event = f.sessions.log(bridgeId).tail().events.filter(e => e.kind === "settings").at(-1)!;
  assert.equal(event.status, "partial");
  // A late old assistant model cannot overwrite a confirmed next-turn choice.
  fs.appendFileSync(f.file, line({ type: "assistant", uuid: "old-turn", message: { model: "old-model", content: [{ type: "text", text: "old answer" }] } }));
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.summaryOf(bridgeId)?.model, "claude-sonnet-test");
  f.emit(reply("approval"), "client");
  await tick();
  assert.equal(f.permissions.pending(bridgeId).length, 0);
});

test("15 seconds means unknown; verdict_pending is not applied and a late worker response is persisted", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = bridgeFixture(t);
  const changing = f.sessions.setModel(bridgeId, "gpt-test", "max", "late-model");
  const model = await posted(f);
  assert.deepEqual(model.request, { subtype: "set_model", model: "gpt-test@max" });
  f.emit(reply(model.request_id, "success", { response: { verdict_pending: true } }));
  await tick();
  t.mock.timers.tick(15_001);
  assert.deepEqual(await changing, { status: "unknown" });
  assert.notEqual(f.sessions.summaryOf(bridgeId)?.model, "gpt-test");
  assert.deepEqual(await f.sessions.setModel(bridgeId, "gpt-test", "max", "late-model"), { status: "unknown" });
  assert.equal(f.posts.length, 1);
  f.emit(reply(model.request_id));
  await tick(); await tick();
  const results = f.sessions.log(bridgeId).tail().events.filter(e => e.kind === "settings").filter(e => e.reqId === "late-model");
  assert.deepEqual(results.map(e => e.status), ["unknown", "applied"]);
  assert.equal(f.sessions.summaryOf(bridgeId)?.effort, "max");
  assert.equal(f.posts.length, 1, "routed effort has no separate Claude flag request");
  assert.deepEqual(await f.sessions.setModel(bridgeId, "gpt-test", "max", "late-model"), { status: "applied", model: "gpt-test", effort: "max" });
});

test("a reconnect recovers the worker result without resending an id; settings share one session lane", async t => {
  const f = bridgeFixture(t);
  const first = f.sessions.setModel(bridgeId, "gpt-first", "high", "same-id");
  const duplicate = f.sessions.setModel(bridgeId, "gpt-first", "high", "same-id");
  const second = f.sessions.setMode(bridgeId, "acceptEdits", "later-mode");
  const model = await posted(f);
  assert.equal(f.posts.length, 1, "neither a duplicate nor the later change is posted");
  f.closeStream();
  f.history.push({ source: "client", payload: reply(model.request_id) });
  await f.sessions.syncBridge(bridgeId);
  assert.equal(f.posts.length, 1, "a client echo is not confirmation");
  f.history.push({ source: "worker", payload: reply(model.request_id) });
  await f.sessions.syncBridge(bridgeId);
  assert.deepEqual(await first, await duplicate);
  const mode = await posted(f, 1);
  assert.deepEqual(mode.request, { subtype: "set_permission_mode", mode: "acceptEdits" });
  // Replaying reads is allowed while the stream is reconnecting.
  f.history.push({ source: "worker", payload: reply(mode.request_id) });
  await f.sessions.syncBridge(bridgeId);
  assert.deepEqual(await second, { status: "applied", permissionMode: "acceptEdits" });
  fs.appendFileSync(f.file, line({ type: "user", uuid: "historical", permissionMode: "plan", message: { content: "past turn" } }));
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.summaryOf(bridgeId)?.permissionMode, "acceptEdits");
  assert.equal(f.posts.length, 2);
  await assert.rejects(f.sessions.setModel(bridgeId, "different", null, "same-id"), /another settings change/);
});

for (const phase of ["model", "effort", "mode"] as const) test(`worker replacement ends an unconfirmed ${phase} request as unknown and releases the settings lane`, async t => {
  const f = bridgeFixture(t);
  const first = phase === "mode" ? f.sessions.setMode(bridgeId, "plan", "replaced-setting")
    : f.sessions.setModel(bridgeId, phase === "effort" ? "claude-sonnet-test" : "gpt-test", "high", "replaced-setting");
  let pending = await posted(f);
  if (phase === "effort") {
    f.emit(reply(pending.request_id));
    pending = await posted(f, 1);
    assert.equal(pending.request.subtype, "apply_flag_settings");
  }
  const before = f.posts.length;
  const next = f.sessions.setMode(bridgeId, "acceptEdits", "after-replacement");
  f.registry.set(bridgeId, { sessionId: bridgeId, pid: 43, status: "idle", bridgeSessionId: "replacement" });
  await f.sessions.pollDesktop();
  const mode = await posted(f, before);
  assert.deepEqual(mode.request, { subtype: "set_permission_mode", mode: "acceptEdits" });
  assert.equal(f.posts[before]?.session_id, "replacement");
  assert.deepEqual(await first, { status: "unknown" });
  const oldResults = () => f.sessions.log(bridgeId).tail().events.filter(e => e.kind === "settings").filter(e => e.reqId === "replaced-setting");
  assert.deepEqual(oldResults().map(e => e.status), ["unknown"]);
  // An old response cannot turn the unconfirmed outcome into a success on the new worker.
  f.emit(reply(pending.request_id));
  f.emit(reply(mode.request_id));
  assert.deepEqual(await next, { status: "applied", permissionMode: "acceptEdits" });
  assert.deepEqual(await (phase === "mode" ? f.sessions.setMode(bridgeId, "plan", "replaced-setting")
    : f.sessions.setModel(bridgeId, phase === "effort" ? "claude-sonnet-test" : "gpt-test", "high", "replaced-setting")), { status: "unknown" });
  assert.deepEqual(oldResults().map(e => e.status), ["unknown"]);
  assert.equal(f.posts.length, before + 1, "the replaced write must never be submitted again");
});

test("a replacement releases a timed-out settings lane without publishing unknown twice", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = bridgeFixture(t);
  const first = f.sessions.setModel(bridgeId, "gpt-test", null, "timed-out-worker");
  await posted(f);
  t.mock.timers.tick(15_001);
  assert.deepEqual(await first, { status: "unknown" });
  const next = f.sessions.setMode(bridgeId, "acceptEdits", "after-timeout");
  f.registry.set(bridgeId, { sessionId: bridgeId, pid: 43, status: "idle", bridgeSessionId: "replacement" });
  await f.sessions.pollDesktop();
  const mode = await posted(f, 1);
  f.emit(reply(mode.request_id));
  assert.deepEqual(await next, { status: "applied", permissionMode: "acceptEdits" });
  assert.deepEqual(f.sessions.log(bridgeId).tail().events.filter(e => e.kind === "settings").filter(e => e.reqId === "timed-out-worker").map(e => e.status), ["unknown"]);
  assert.equal(f.posts.length, 2);
});

test("closing one worker's controls preserves other sessions and cannot resend an old request id", async () => {
  let writes = 0;
  const client = new BridgeClient({ auth: () => ({ accessToken: "fixture", organizationUuid: "org", expiresAt: Date.now() + 60_000 }), fetch: async () => { writes++; return Response.json({}); } });
  const request = { subtype: "set_model", model: "gpt-test" } as const;
  const first = client.control("old-worker", "same-request", request);
  let otherFinished = false;
  const other = client.control("other-worker", "same-request", request).then(() => { otherFinished = true; });
  const unknown = assert.rejects(first, OutcomeUnknownError);
  client.closeControls("old-worker");
  await unknown;
  await tick();
  assert.equal(otherFinished, false);
  await assert.rejects(client.control("old-worker", "same-request", request), OutcomeUnknownError);
  // A late durable answer belongs to the retired promise, not to the other session.
  assert.equal(client.controlResponse("old-worker", "worker", reply("same-request")), true);
  await assert.rejects(first, OutcomeUnknownError);
  client.controlResponse("other-worker", "worker", reply("same-request"));
  await other;
  assert.equal(writes, 2);
  client.closeControls();
});

test("reopening a failed stream to the same worker preserves unconfirmed control requests", async t => {
  let bodyless = true;
  const f = bridgeFixture(t, { streamBodyless: () => bodyless });
  const first = f.sessions.setModel(bridgeId, "gpt-test", null, "same-worker");
  const model = await posted(f);
  bodyless = false;
  await f.sessions.pollDesktop();
  await tick(); await tick();
  assert.equal(f.posts.length, 1);
  f.emit(reply(model.request_id));
  assert.deepEqual(await first, { status: "applied", model: "gpt-test", effort: null });
  assert.equal(f.posts.length, 1);
});

for (const code of ["bypass_restricted", "bypass_disabled", "bypass_not_launched"]) test(`CLI ${code} reaches the caller, without spawning or changing flags`, async t => {
  const f = bridgeFixture(t);
  const changing = f.sessions.setMode(bridgeId, "bypassPermissions", `mode-${code}`);
  const control = await posted(f);
  f.emit(reply(control.request_id, "error", { error: code }));
  await assert.rejects(changing, { message: code });
  assert.notEqual(f.sessions.summaryOf(bridgeId)?.permissionMode, "bypassPermissions");
  assert.equal(f.posts.length, 1);
});

for (const replay of [false, true]) test(`safe CLI permission suggestions are session-only (${replay ? "replay" : "live"}), and POST means sent, not confirmed`, async t => {
  const f = bridgeFixture(t);
  const request = approval("safe-approval", safe);
  if (replay) f.history.push({ source: "worker", payload: request });
  f.sessions.log(bridgeId);
  await tick(); await tick();
  if (!replay) { f.emit(request); await tick(); }
  const permission = f.permissions.pending(bridgeId)[0]!;
  const card = f.sessions.log(bridgeId).tail().events.find(e => e.kind === "permission" && e.id === permission.id);
  assert.ok(card?.kind === "permission");
  assert.equal(card.canAlways, true);
  assert.deepEqual(card.alwaysAllow, { scope: "session", summary: "Bash(git status:*)" });
  const first = f.sessions.decide(bridgeId, permission.id, "allow_always", undefined, undefined, "decide-safe");
  const duplicate = f.sessions.decide(bridgeId, permission.id, "allow_always", undefined, undefined, "decide-safe");
  assert.equal(await first, true);
  assert.equal(await duplicate, true);
  await tick();
  assert.equal(f.posts.length, 1);
  const response = (f.posts[0] as { events: { payload: { response: { response: Record<string, unknown> } } }[] }).events[0]!.payload.response.response;
  assert.equal(response.behavior, "allow");
  assert.deepEqual(response.updatedInput, { command: "true" });
  assert.deepEqual(response.updatedPermissions, [{ ...suggestions[0], destination: "session" }]);
  assert.equal(suggestions[0]!.destination, "userSettings", "the CLI suggestion itself is not mutated");
  const decided = f.sessions.log(bridgeId).tail().events.find(e => e.kind === "permission_decided" && e.id === permission.id);
  assert.ok(decided?.kind === "permission_decided");
  assert.equal(decided.ruleStatus, "sent");
  assert.equal(await f.sessions.decide(bridgeId, permission.id, "allow_always", undefined, undefined, "decide-safe"), true);
  assert.equal(await f.sessions.decide(bridgeId, permission.id, "allow_always", undefined, undefined, "new-phone-id"), true);
  assert.equal(f.posts.length, 1);
});

for (const [name, extra] of [
  ["missing suppression", { permission_suggestions: suggestions }],
  ["suppressed", { ...safe, suppress_always_allow_rule: true }],
  ["conflicting suppression", { ...safe, suppressAlwaysAllowRule: true }],
  ["no suggestions", { suppressAlwaysAllowRule: false }],
  ["unconditional rule", { ...safe, permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow" }] }],
  ["different tool", { ...safe, permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Write", ruleContent: "/project/*" }], behavior: "allow" }] }],
  ["plan", { ...safe, tool_name: "ExitPlanMode", input: { plan: "plan" } }],
  ["question", { ...safe, tool_name: "AskUserQuestion", input: { questions: [] } }],
] as const) test(`Always Allow is hidden and refused for ${name}`, async t => {
  const f = bridgeFixture(t);
  f.sessions.log(bridgeId);
  await tick(); await tick();
  f.emit(approval("unsafe", extra));
  await tick();
  const permission = f.permissions.pending(bridgeId)[0]!;
  const card = f.sessions.log(bridgeId).tail().events.find(e => e.kind === "permission" && e.id === permission.id);
  assert.ok(card?.kind === "permission");
  assert.equal(card.canAlways, false);
  assert.equal(card.alwaysAllow, undefined);
  assert.throws(() => f.sessions.decide(bridgeId, permission.id, "allow_always"), /안전한 세션 허용 규칙/);
  assert.equal(f.posts.length, 0);
});

test("rule validation never drops unknown conditions or fabricates an all-tool allow", () => {
  for (const rules of [[{ toolName: "Bash", ruleContent: "*" }], [{ toolName: "Bash", ruleContent: "git status:*", extraCondition: "required" }]]) {
    assert.deepEqual(sessionPermissionRules("Bash", [{ type: "addRules", rules, behavior: "allow" }], false), []);
  }
  assert.deepEqual(sessionPermissionRules("Bash", [{ type: "setMode", mode: "bypassPermissions" }], false), []);
  assert.deepEqual(sessionPermissionRules("Bash", [{ type: "addRules", rules: Array.from({ length: 4 }, () => ({ toolName: "Bash", ruleContent: "a".repeat(1000) })), behavior: "allow" }], false), [], "oversize confirmation is refused, never truncated");
});

test("an orphaned durable settings write is unknown after restart and is never submitted again", async t => {
  const f = bridgeFixture(t);
  const file = path.join(f.root, "journal-test.json");
  const original = new SessionSettings(file);
  const finish = Promise.withResolvers<SettingsResult>();
  const running = original.run(bridgeId, "orphan", "model-choice", "model", () => finish.promise, () => {});
  await tick();
  const recovered = new SessionSettings(file);
  let writes = 0;
  const result = await recovered.run(bridgeId, "orphan", "model-choice", "model", async () => { writes++; return { status: "applied" }; }, () => {});
  assert.deepEqual(result, { status: "unknown" });
  assert.equal(writes, 0);
  assert.deepEqual(recovered.unresolved(), [{ session: bridgeId, reqId: "orphan" }]);
  finish.resolve({ status: "applied", model: "gpt-test", effort: null });
  await running;
  const again = new SessionSettings(file);
  assert.deepEqual(again.replay(bridgeId), [{ reqId: "orphan", status: "applied", model: "gpt-test", effort: null }]);
});

test("timeline retains session rule scope and sent status, and replaces an unknown setting with its late result", () => {
  const view = reduce([
    { seq: 1, at: 1, kind: "permission", id: "p", tool: "Bash", title: "", summary: "git status", input: "git status", canAlways: true, requestKind: "tool", alwaysAllow: { scope: "session", summary: "Bash(git status:*)" } },
    { seq: 2, at: 2, kind: "permission_decided", id: "p", decision: "allow_always", ruleStatus: "sent" },
    { seq: 3, at: 3, kind: "settings", reqId: "s", status: "unknown" },
    { seq: 4, at: 4, kind: "settings", reqId: "s", status: "partial", model: "claude-new", errors: { effort: "overridden" } },
  ]);
  const permission = view.items.find(i => i.type === "permission");
  assert.ok(permission?.type === "permission");
  assert.deepEqual(permission.alwaysAllow, { scope: "session", summary: "Bash(git status:*)" });
  assert.equal(permission.ruleStatus, "sent");
  assert.equal(view.open.length, 0);
  assert.deepEqual(view.items.filter(i => i.type === "notice").map(i => i.code), ["settings_partial"]);
});

test("host restart cannot repeat an ambiguous approval under a new card or phone request id", async t => {
  const f = bridgeFixture(t, { failSend: true });
  f.sessions.log(bridgeId);
  await tick(); await tick();
  f.emit(approval("durable-cli-id", safe));
  await tick();
  const old = f.permissions.pending(bridgeId)[0]!;
  await assert.rejects(async () => f.sessions.decide(bridgeId, old.id, "allow_always", undefined, undefined, "old-phone-id"), /전송 결과를 확인할 수 없음/);
  assert.equal(f.posts.length, 1);
  f.sessions.shutdown();
  await tick();
  let writes = 0;
  const client = new BridgeClient({ auth: () => ({ accessToken: "fixture", organizationUuid: "org", expiresAt: Date.now() + 60_000 }), fetch: async (url, options) => {
    if (options?.method === "POST") { writes++; return Response.json({}); }
    if (String(url).includes("sort_order=asc")) return Response.json({ data: [{ source: "worker", payload: approval("durable-cli-id", safe) }] });
    if (String(url).includes("sort_order=desc")) return Response.json({ data: [] });
    return new Response(new ReadableStream({ start(controller) { options?.signal?.addEventListener("abort", () => controller.close(), { once: true }); } }));
  } });
  const permissions = PermissionQueue.open(path.join(f.root, "permissions.json"));
  const restored = new Sessions({ dir: path.join(f.root, "host"), desktopProjects: path.join(f.root, "projects"), desktopRegistry: () => f.registry, desktopProcesses: () => "", bridgeClient: client, permissions,
    router: { status: async () => ({ ok: true, proxyEnv: {} }), figures: async () => { throw new Error("unused"); } },
    queryFn: () => { throw new Error("must not spawn SDK"); }, onEvent() {}, onSessions() {}, log() {} });
  try {
    restored.recover();
    restored.log(bridgeId);
    await restored.syncBridge(bridgeId);
    await tick(); await tick();
    const card = permissions.pending(bridgeId)[0]!;
    assert.ok(card);
    assert.notEqual(card.id, old.id);
    assert.throws(() => restored.decide(bridgeId, card.id, "allow_always", undefined, undefined, "new-phone-id"), /전송 결과를 확인할 수 없음/);
    assert.equal(writes, 0);
  } finally { restored.shutdown(); await tick(); }
});

for (const status of [0, 500, 503]) test(`ambiguous POST (${status}) is not repeated and a durable worker answer still settles it`, async () => {
  let calls = 0;
  const client = new BridgeClient({ auth: () => ({ accessToken: "fixture", organizationUuid: "org", expiresAt: Date.now() + 60_000 }), fetch: async () => { calls++; if (status) return new Response("error", { status }); throw new Error("reset after writing"); } });
  const first = client.control("bridge", "uuid", { subtype: "set_model", model: "gpt-test" });
  const duplicate = client.control("bridge", "uuid", { subtype: "set_model", model: "gpt-test" });
  await tick();
  assert.equal(calls, 1);
  assert.equal(client.controlResponse("bridge", "client", reply("uuid")), false);
  assert.equal(client.controlResponse("bridge", "worker", reply("uuid")), true);
  await Promise.all([first, duplicate]);
});
