import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay, setImmediate as nextTick } from "node:timers/promises";
import { PermissionQueue } from "../src/permissions.ts";
import { MessageReceipts } from "../src/receipts.ts";
import { reduce } from "../web/timeline.ts";
import { INLINE_CAP } from "../src/protocol.ts";
import type { Effort, SessionEvent } from "../src/protocol.ts";
import { Sessions, modelArg, nextAttention, summarize } from "../src/sessions.ts";
import { CLI_NOT_LOGGED_IN } from "../src/bridge-client.ts";
import type { CanUseTool, PermissionAnswer, QueryFn, SdkUserMessage, SessionsOptions } from "../src/sessions.ts";
import { posixPaths } from "../../../test/capabilities.ts";

const router = {
  status: async () => ({ ok: true, proxyEnv: { HTTPS_PROXY: "http://127.0.0.1:1" } }),
  figures: async () => ({ effort: null, cachePct: null, contextPct: null, fiveHourPct: null, fiveHourResetAt: null, workers: [], at: Date.now() }),
  models: async () => [],
} satisfies SessionsOptions["router"] & { models: () => Promise<never[]> };

function scriptedQuery(script: { permission?: boolean; toolOutput?: unknown; images?: boolean; thinking?: boolean; sendFile?: string; failure?: { text: string; as: "result" | "throw" } } = {}) {
  const options: Record<string, unknown>[] = [];
  const users: SdkUserMessage[] = [];
  const answers: PermissionAnswer[] = [];
  const suggestions = [{ type: "addRules" }];
  const spies = { modeError: null as Error | null, setPermissionMode: [] as import('../src/protocol.ts').PermissionMode[], interrupt: 0, setModel: [] as (string | undefined)[], close: 0 };
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
          if (script.thinking) {
            // Two streamed indices, each finalized by an SDK message with local index zero.
            for (const index of [2, 4]) {
              yield { type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "thinking" } } };
              yield { type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: `thought ${index}` } } };
              yield { type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "private signature" } } };
              yield { type: "assistant", message: { id, model: "x", content: [{ type: "thinking", thinking: `thought ${index} complete`, signature: "private signature" }] } };
            }
          }
          yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "po" } } };
          if (script.permission) {
            const fn = params.options.canUseTool;
            const abort = params.options.abortController;
            assert.equal(typeof fn, "function");
            assert.ok(abort instanceof AbortController);
            answers.push(await (fn as CanUseTool)("Bash", { command: "ls" }, { signal: abort.signal, suggestions }));
          }
          if (script.toolOutput !== undefined) {
            yield { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: script.toolOutput, is_error: false }] } };
          }
          const image = { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("sdk image").toString("base64") } };
          if (script.images) yield { type: "user", uuid: "sdk-image-user", message: { content: [image] } };
          yield { type: "assistant", parent_tool_use_id: null, message: { id, model: "x", content: [{ type: "text", text: "pong" }, ...(script.images ? [image] : []), ...(script.sendFile ? [{ type: "tool_use", id: "suf-1", name: "SendUserFile", input: { files: [script.sendFile], caption: "shot", status: "normal" } }] : [])] } };
          if (script.failure?.as === "throw") throw new Error(script.failure.text);
          if (script.failure?.as === "result") {
            yield { type: "result", subtype: "error", is_error: true, result: script.failure.text, duration_ms: 1, num_turns: 0 };
            return;
          }
          yield { type: "result", subtype: "success", is_error: false, duration_ms: 5, num_turns: 1, modelUsage: { x: { contextWindow: 1000 } } };
        }
      },
      interrupt: async () => { spies.interrupt++; },
      setModel: async model => { spies.setModel.push(model); },
      setPermissionMode: async mode => { if (spies.modeError) throw spies.modeError; spies.setPermissionMode.push(mode); },
      close: () => { spies.close++; },
    };
  };
  return { queryFn, options, users, answers, suggestions, spies };
}

function fixture(t: TestContext, script: Parameters<typeof scriptedQuery>[0] = {}, extra: Pick<SessionsOptions, "handoff" | "log"> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-sessions-"));
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd);
  const permissionsFile = path.join(dir, "permissions.json");
  const permissions = PermissionQueue.open(permissionsFile);
  const fake = scriptedQuery(script);
  const events: { session: string; event: SessionEvent }[] = [];
  const sessions = new Sessions({ dir, router, permissions, queryFn: fake.queryFn, coalesceMs: 5, ...extra,
    onEvent: (session, event) => events.push({ session, event }), onSessions: () => {},
  });
  const instances = [sessions];
  t.after(async () => {
    // Let aborted permission/iterator continuations finish before closing their logs.
    for (const instance of instances) for (const session of instance.list()) instance.stop(session.id);
    await nextTick();
    for (const instance of instances) instance.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const create = (clientMsgId = "create-1", model = "claude-test", effort: Effort | null = "high") =>
    sessions.create({ clientMsgId, cwd, model, effort, text: "ping" });
  return { dir, cwd, permissionsFile, permissions, fake, sessions, instances, events, create };
}

test("a CLI without a login is told what to do, and the raw text stays in the host's log", async t => {
  for (const how of ["result", "throw"] as const) {
    const lines: string[] = [];
    const f = fixture(t, { failure: { text: "Not logged in · Please run /login", as: how } }, { log: (line: string) => lines.push(line) });
    const id = await f.create();
    await waitFor(() => f.sessions.summaryOf(id)?.state === "error");
    const stored = f.sessions.log(id).readAfter(0).events;
    const failed = stored.filter(e => e.kind === "result");
    assert.equal(failed.length, 1, how);
    assert.equal(failed[0]!.error, CLI_NOT_LOGGED_IN, how);
    assert.ok(lines.some((l) => l.includes("Not logged in")), `the raw CLI text is kept in the host log: ${lines.join(" | ")}`);
  }
});

test("another CLI error is left exactly as it was", async t => {
  const f = fixture(t, { failure: { text: "API Error: 500 internal error", as: "result" } });
  const id = await f.create();
  await waitFor(() => f.sessions.summaryOf(id)?.state === "error");
  const stored = f.sessions.log(id).readAfter(0).events;
  const failed = stored.filter(e => e.kind === "result");
  assert.equal(failed[0]!.error, "API Error: 500 internal error");
});

test("thinking streams finalize at original block indices without exposing signatures", async t => {
  const f = fixture(t, { thinking: true });
  const id = await f.create();
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  const stored = f.sessions.log(id).readAfter(0).events;
  const thoughts = stored.filter(e => e.kind === "thinking");
  assert.deepEqual(thoughts.map(e => [e.block, e.text, e.delta === true]), [[2, "thought 2", true], [2, "thought 2 complete", false], [4, "thought 4", true], [4, "thought 4 complete", false]]);
  assert.ok(!JSON.stringify(stored).includes("private signature"));
  assert.deepEqual(reduce(stored).items.filter(i => i.type === "thinking").map(i => i.text), ["thought 2 complete", "thought 4 complete"]);
});

test("steer keeps the running query; interrupt closes it and withdraws unstarted inputs", async t => {
  const f = fixture(t, { permission: true });
  const id = await f.create();
  await waitFor(() => f.permissions.pending(id).length === 1);
  f.sessions.send(id, 'steer', 'steering');
  assert.equal(f.fake.spies.interrupt, 0);
  assert.equal(f.fake.spies.close, 0);
  await f.sessions.interrupt(id);
  await nextTick();
  assert.equal(f.fake.spies.interrupt, 1);
  assert.equal(f.fake.spies.close, 1);
  assert.equal(f.fake.users.length, 1);
  assert.equal(f.sessions.summaryOf(id)?.state, 'idle');
  await f.sessions.send(id, 'replacement', 'replace', [], 'interrupt');
  await waitFor(() => f.fake.users.length === 2);
  assert.equal(f.fake.users[1]!.message.content, 'replace');
  assert.equal(f.fake.options.length, 2);
});

test("phone images reach SDK blocks and files are written under cwd", async t => {
  const f = fixture(t);
  const id = await f.create();
  await waitFor(() => f.sessions.summaryOf(id)?.state === 'idle');
  const data = Buffer.from('photo bytes').toString('base64');
  const blob = f.sessions.log(id).image(data);
  await f.sessions.send(id, 'image-input', 'look', [{ blob, name: 'photo.png', mediaType: 'image/png' }]);
  await waitFor(() => f.fake.users.length === 2);
  assert.deepEqual(f.fake.users[1]!.message.content, [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }]);
  const fileBlob = f.sessions.log(id).image(Buffer.from('file bytes').toString('base64'));
  await f.sessions.send(id, 'file-input', 'read', [{ blob: fileBlob, name: '../../notes.txt', mediaType: 'text/plain' }]);
  await waitFor(() => f.fake.users.length === 3);
  const files = fs.readdirSync(path.join(f.cwd, '.ripple-attachments'));
  assert.equal(files.length, 1);
  assert.equal(fs.readFileSync(path.join(f.cwd, '.ripple-attachments', files[0]!), 'utf8'), 'file bytes');
  assert.match(String(f.fake.users[2]!.message.content), /Attached file:/);
  assert.throws(() => f.sessions.send(id, 'missing-file', 'read', [{ blob: 'missing', name: 'a', mediaType: 'text/plain' }]), /missing/);
});

test("a live SDK SendUserFile image joins the assistant event through the blob transport", async t => {
  const f = fixture(t, { sendFile: "shot.png" });
  const bytes = Buffer.from("live shot bytes");
  fs.writeFileSync(path.join(f.cwd, "shot.png"), bytes);
  const id = await f.create();
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  const assistant = f.sessions.log(id).readAfter(0).events.filter(e => e.kind === "assistant").at(-1);
  assert.ok(assistant?.kind === "assistant");
  const image = assistant.images?.[0];
  assert.ok(image?.blob);
  assert.equal(image.mediaType, "image/png");
  assert.equal(f.sessions.log(id).blob(image.blob!), bytes.toString("base64"));
  assert.equal(assistant.tools.find(tool => tool.name === "SendUserFile")?.summary, "shot.png, shot");
});

test("clear and new create an empty fresh session with identical settings", async t => {
  const f = fixture(t);
  const id = await f.sessions.create({ clientMsgId: 'original', cwd: f.cwd, model: 'routed', effort: 'high', permissionMode: 'plan', text: 'ping' });
  await waitFor(() => f.sessions.summaryOf(id)?.state === 'idle');
  for (const command of ['/clear', '/new']) {
    const fresh = await f.sessions.send(id, command, command);
    assert.notEqual(fresh, id);
    const s = f.sessions.summaryOf(fresh)!;
    assert.deepEqual([s.cwd, s.model, s.effort, s.permissionMode, s.state], [f.cwd, 'routed', 'high', 'plan', 'idle']);
    assert.equal(f.sessions.log(fresh).before(Number.MAX_SAFE_INTEGER).events.some(e => e.kind === 'user'), false);
    assert.equal(await f.sessions.send(id, command, command), fresh);
  }
});

test("creation carries permission mode, enables bypass explicitly, and defaults to auto", async t => {
  const f = fixture(t);
  for (const mode of [undefined, 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'] as const) {
    const id = await f.sessions.create({ clientMsgId: `mode-${mode}`, cwd: f.cwd, model: 'test', effort: null, text: 'ping', ...(mode ? { permissionMode: mode } : {}) });
    await waitFor(() => f.fake.options.length > 0 && f.sessions.summaryOf(id)?.state === 'idle');
    const options = f.fake.options.at(-1)!;
    assert.equal(options.permissionMode, mode ?? 'auto');
    assert.equal(options.allowDangerouslySkipPermissions, mode === 'bypassPermissions' ? true : undefined);
    assert.equal(f.sessions.summaryOf(id)?.permissionMode, mode ?? 'auto');
  }
});

test("set_mode applies during a turn and stores mode for a stopped session", async t => {
  const f = fixture(t, { permission: true });
  const id = await f.create();
  await waitFor(() => f.permissions.pending(id).length === 1);
  await f.sessions.setMode(id, 'plan');
  assert.deepEqual(f.fake.spies.setPermissionMode, ['plan']);
  assert.equal(f.sessions.summaryOf(id)?.permissionMode, 'plan');
  assert.ok(f.events.some(e => e.event.kind === 'mode' && e.event.mode === 'plan'));
  f.sessions.stop(id);
  await nextTick();
  await f.sessions.setMode(id, 'acceptEdits');
  f.sessions.send(id, 'resume-mode', 'again');
  await waitFor(() => f.fake.options.length === 2);
  assert.equal(f.fake.options[1]!.permissionMode, 'acceptEdits');
});

for (const original of ['auto', 'bypassPermissions'] as const) test(`plan implementation returns from ${original}`, async t => {
  const f = fixture(t);
  const id = await f.sessions.create({ clientMsgId: 'plan', cwd: f.cwd, model: 'test', effort: null, text: 'ping', permissionMode: original });
  await waitFor(() => f.fake.options.length === 1);
  await f.sessions.setMode(id, 'plan');
  const callback = f.fake.options[0]!.canUseTool as CanUseTool;
  const answer = callback('ExitPlanMode', { plan: '# Plan\nImplement it' }, { signal: new AbortController().signal });
  const pending = f.permissions.pending(id)[0]!;
  assert.ok(f.events.some(e => e.event.kind === 'permission' && e.event.requestKind === 'plan' && e.event.input === '# Plan\nImplement it'));
  assert.equal(await f.sessions.decide(id, pending.id, 'allow'), true);
  assert.equal((await answer).behavior, 'allow');
  assert.equal(f.fake.spies.setPermissionMode.at(-1), original === 'bypassPermissions' ? 'bypassPermissions' : 'acceptEdits');
});

test("mode and plan approval failures stay visible and leave the permission pending", async t => {
  const f = fixture(t);
  const id = await f.create();
  await waitFor(() => f.fake.options.length === 1);
  f.fake.spies.modeError = new Error('mode rejected');
  await assert.rejects(f.sessions.setMode(id, 'plan'), /mode rejected/);
  assert.equal(f.sessions.summaryOf(id)?.permissionMode, 'auto');
  f.fake.spies.modeError = null;
  await f.sessions.setMode(id, 'plan');
  const callback = f.fake.options[0]!.canUseTool as CanUseTool;
  const answer = callback('ExitPlanMode', { plan: 'Work' }, { signal: new AbortController().signal });
  const pending = f.permissions.pending(id)[0]!;
  f.fake.spies.modeError = new Error('mode rejected');
  await assert.rejects(Promise.resolve(f.sessions.decide(id, pending.id, 'allow')), /mode rejected/);
  assert.equal(f.permissions.get(pending.id)?.state, 'pending');
  assert.equal(f.sessions.summaryOf(id)?.permissionMode, 'plan');
  await f.sessions.decide(id, pending.id, 'deny', 'Revise the plan');
  assert.deepEqual(await answer, { behavior: 'deny', message: 'Revise the plan' });
});

test("AskUserQuestion passes answers keyed by question text in updatedInput", async t => {
  const f = fixture(t);
  const id = await f.create();
  await waitFor(() => f.fake.options.length === 1);
  const callback = f.fake.options[0]!.canUseTool as CanUseTool;
  const input = { questions: [{ question: 'Which?', header: 'Choice', multiSelect: true, options: [{ label: 'A', description: 'first' }, { label: 'B', description: 'second' }] }] };
  const answer = callback('AskUserQuestion', input, { signal: new AbortController().signal });
  const pending = f.permissions.pending(id)[0]!;
  assert.throws(() => f.sessions.decide(id, pending.id, 'allow'), /Answer every question/);
  const answers = { 'Which?': 'A, B, custom' };
  assert.equal(await f.sessions.decide(id, pending.id, 'allow', undefined, answers), true);
  assert.deepEqual(await answer, { behavior: 'allow', updatedInput: { ...input, answers } });
});

test("a new SDK message denies pending approvals before delivering the message", async t => {
  const f = fixture(t, { permission: true });
  const id = await f.create();
  await waitFor(() => f.permissions.pending(id).length === 1);
  f.sessions.send(id, 'supersede', 'new instructions');
  await waitFor(() => f.fake.users.length === 2);
  assert.deepEqual(f.fake.answers[0], { behavior: 'deny', message: 'superseded by a new message from the user' });
  assert.equal(f.fake.users[1]!.message.content, 'new instructions');
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "Timed out waiting for scripted query");
    await delay(5);
  }
  await nextTick();
}

test("SDK user, assistant and tool-result image blocks retain chunked blob references", async t => {
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("sdk image").toString("base64") } };
  const f = fixture(t, { images: true, toolOutput: [image] });
  const id = await f.create();
  await waitFor(() => f.sessions.list()[0]?.state === "idle");
  const events = f.sessions.log(id).readAfter(0).events.filter(e => e.images?.length);
  assert.deepEqual(events.map(e => e.kind).sort(), ["assistant", "tool_result", "user"]);
  for (const event of events) assert.equal(f.sessions.log(id).blob(event.images![0]!.blob!), image.source.data);
});

function eventLabels(events: SessionEvent[]): string[] {
  return events.filter(event => event.kind !== "figures").map(event => event.kind === "state" ? `state ${event.state}` : event.kind);
}

for (const { model, effort, expected } of [
  { model: "claude-test", effort: "high" as const, expected: { model: "claude-test", effort: "high" } },
  { model: "gpt-test", effort: "max" as const, expected: { model: "gpt-test@max" } },
  { model: "opus", effort: "high" as const, expected: { model: "opus", effort: "high" } },
]) {
  test(`create uses cwd, proxy env and modelArg for ${model}, and emits an ordered turn`, { timeout: 4500 }, async t => {
    const f = fixture(t);
    const id = await f.create("create-1", model, effort);
    await waitFor(() => f.sessions.list().find(session => session.id === id)?.state === "idle");
    assert.equal(f.fake.options.length, 1);
    const options = f.fake.options[0]!;
    assert.equal(options.cwd, f.cwd);
    assert.equal(options.model, expected.model);
    if ("effort" in expected) assert.equal(options.effort, expected.effort);
    else assert.ok(!Object.hasOwn(options, "effort"));
    assert.deepEqual(modelArg(model, effort), expected);
    const env = options.env;
    assert.ok(env !== null && typeof env === "object");
    assert.equal(Reflect.get(env, "HTTPS_PROXY"), "http://127.0.0.1:1");
    assert.ok(!Object.hasOwn(env, "ANTHROPIC_BASE_URL"));
    assert.ok(!Object.hasOwn(options, "resume"));
    assert.deepEqual(eventLabels(f.events.filter(row => row.session === id).map(row => row.event)), [
      "state starting", "user", "turn", "state running", "delta", "assistant", "result", "state idle",
    ]);
    const delta = f.events.find(row => row.event.kind === "delta")?.event;
    assert.ok(delta?.kind === "delta");
    assert.equal(delta.text, "po");
    const stored = f.sessions.log(id).readAfter(0).events;
    const assistant = stored.find(event => event.kind === "assistant");
    assert.ok(assistant?.kind === "assistant");
    assert.equal(assistant.text, "pong");
    assert.deepEqual(stored.find(event => event.kind === "result"), {
      kind: "result", ok: true, ms: 5, turns: 1, seq: stored.find(event => event.kind === "result")!.seq,
      at: stored.find(event => event.kind === "result")!.at,
    });
    assert.equal(f.fake.users[0]?.message.content, "ping");
  });
}

test("sequential create and send retries with the same clientMsgId are idempotent", { timeout: 4500 }, async t => {
  const f = fixture(t);
  const id = await f.create();
  assert.equal(await f.create(), id);
  await waitFor(() => f.sessions.list()[0]?.state === "idle");
  assert.equal(f.fake.options.length, 1);
  f.sessions.send(id, "send-1", "again");
  f.sessions.send(id, "send-1", "again");
  await waitFor(() => f.fake.users.length === 2 && f.sessions.list()[0]?.state === "idle");
  const users = f.sessions.log(id).readAfter(0).events.filter(event => event.kind === "user");
  assert.deepEqual(users.map(event => event.clientMsgId), ["create-1", "send-1"]);
  assert.deepEqual(f.fake.users.map(user => user.message.content), ["ping", "again"]);
  assert.equal(f.fake.options.length, 1);
});

test("concurrent create retries with the same clientMsgId start only one query", {
  timeout: 4500,
}, async t => {
  const f = fixture(t);
  const ids = await Promise.all([f.create(), f.create()]);
  await waitFor(() => f.fake.options.length > 0);
  assert.equal(ids[0], ids[1]);
  assert.equal(f.sessions.list().length, 1);
  assert.equal(f.fake.options.length, 1);
});

for (const decision of ["allow", "allow_always", "deny"] as const) {
  test(`permission ${decision} waits, rejects another session and returns the SDK answer`, { timeout: 4500 }, async t => {
    const f = fixture(t, { permission: true });
    const id = await f.create();
    const otherId = await f.create("other-session");
    await waitFor(() => f.permissions.pending(id).length === 1 && f.permissions.pending(otherId).length === 1);
    const pending = f.permissions.pending(id)[0]!;
    const permission = f.events.find(row => row.session === id && row.event.kind === "permission")?.event;
    assert.ok(permission?.kind === "permission");
    assert.equal(permission.id, pending.id);
    assert.equal(permission.tool, "Bash");
    assert.equal(permission.input, "ls");
    assert.equal(permission.canAlways, true);
    assert.equal(f.sessions.list().find(session => session.id === id)?.state, "waiting");
    const labels = eventLabels(f.events.filter(row => row.session === id).map(row => row.event));
    assert.deepEqual(labels.slice(-3), ["delta", "permission", "state waiting"]);
    assert.equal(f.sessions.decide(otherId, pending.id, decision), false);
    assert.equal(f.permissions.pending(id).length, 1);
    assert.equal(f.sessions.decide(id, pending.id, decision), true);
    await waitFor(() => f.sessions.list().find(session => session.id === id)?.state === "idle");
    assert.equal(f.sessions.decide(id, pending.id, decision), false);
    const decided = f.sessions.log(id).readAfter(0).events.find(event => event.kind === "permission_decided");
    assert.ok(decided?.kind === "permission_decided");
    assert.equal(decided.id, pending.id);
    assert.equal(decided.decision, decision);
    const answer = f.fake.answers[0]!;
    assert.equal(answer.behavior, decision === "deny" ? "deny" : "allow");
    if (answer.behavior === "allow") {
      assert.deepEqual(answer.updatedInput, { command: "ls" });
      if (decision === "allow_always") assert.deepEqual(answer.updatedPermissions, f.fake.suggestions);
      else assert.ok(!Object.hasOwn(answer, "updatedPermissions"));
    } else assert.match(answer.message, /denied/);
    // Resolve the unrelated query too, so shutdown cannot race a permission continuation.
    assert.equal(f.sessions.decide(otherId, f.permissions.pending(otherId)[0]!.id, "deny"), true);
    await waitFor(() => f.sessions.list().every(session => session.state === "idle"));
  });
}

test("recover expires persisted permissions, stops a mid-turn session and resumes sdk-1", { timeout: 4500 }, async t => {
  const f = fixture(t);
  const id = await f.create();
  await waitFor(() => f.sessions.list()[0]?.state === "idle");
  f.sessions.stop(id);
  await nextTick();
  const file = path.join(f.dir, "sessions.json");
  const records = JSON.parse(fs.readFileSync(file, "utf8")) as { id: string; state: string; sdkSessionId: string | null }[];
  assert.equal(records[0]?.sdkSessionId, "sdk-1");
  fs.writeFileSync(file, JSON.stringify(records.map(record => ({ ...record, state: "running" }))));
  f.sessions.log(id).append({ kind: "state", state: "running" });
  const pending = f.permissions.request({ session: id, tool: "Bash", title: "", summary: "ls", input: { command: "ls" } });
  f.sessions.log(id).append({ kind: "permission", id: pending.record.id, tool: "Bash", title: "", summary: "ls", input: "ls", canAlways: true });
  const epoch = f.sessions.log(id).epoch;
  const before = f.sessions.log(id).lastSeq;
  f.sessions.shutdown();

  const permissions = PermissionQueue.open(f.permissionsFile);
  const fake = scriptedQuery();
  const recovered = new Sessions({ dir: f.dir, router, permissions, queryFn: fake.queryFn, coalesceMs: 5, onEvent: () => {}, onSessions: () => {} });
  f.instances.push(recovered);
  recovered.recover();
  assert.equal(recovered.log(id).epoch, epoch);
  assert.equal(permissions.pending().length, 0);
  assert.deepEqual(recovered.log(id).readAfter(before).events.map(({ seq: _seq, at: _at, ...event }) => event), [
    { kind: "permission_decided", id: pending.record.id, decision: "expired", reason: "host_restarted" },
    { kind: "notice", code: "host_restarted", text: "호스트가 다시 시작되어 이 턴이 중단되었습니다" },
    { kind: "state", state: "stopped" },
  ]);
  assert.equal(recovered.list()[0]?.state, "stopped");
  recovered.send(id, "after-restart", "continue");
  await waitFor(() => recovered.list()[0]?.state === "idle");
  assert.equal(fake.options.length, 1);
  assert.equal(fake.options[0]?.resume, "sdk-1");
  assert.equal(fake.options[0]?.cwd, f.cwd);
  assert.equal(fake.users[0]?.session_id, "sdk-1");
});

test("large SDK tool output is stored as a BlobRef and round-trips in full", { timeout: 4500 }, async t => {
  const text = "界😀\n".repeat(INLINE_CAP);
  const f = fixture(t, { toolOutput: text });
  const id = await f.create();
  await waitFor(() => f.sessions.list()[0]?.state === "idle");
  const result = f.sessions.log(id).readAfter(0).events.find(event => event.kind === "tool_result");
  assert.ok(result?.kind === "tool_result");
  assert.equal(result.toolUseId, "tool-1");
  assert.equal(result.ok, true);
  assert.ok(typeof result.text !== "string");
  assert.equal(result.text.bytes, Buffer.byteLength(text));
  assert.equal(result.text.preview, text.slice(0, 400));
  assert.equal(f.sessions.log(id).blob(result.text.blob), text);
});

test("desktop handoff waits for idle, holds new input, persists once and names the SDK session", async t => {
  const calls: { sessionId: string; title: string; cwd: string }[] = [];
  let finish: (() => void) | undefined;
  const logs: string[] = [];
  const f = fixture(t, { permission: true }, {
    handoff: async request => { calls.push(request); await new Promise<void>(resolve => { finish = resolve; }); return "opened"; },
    log: line => logs.push(line),
  });
  const id = await f.create();
  await waitFor(() => f.permissions.pending(id).length === 1);
  assert.equal(calls.length, 0);
  f.sessions.decide(id, f.permissions.pending(id)[0]!.id, "allow");
  await waitFor(() => calls.length === 1);
  assert.deepEqual(calls[0], { sessionId: "sdk-1", title: "ping", cwd: f.cwd });
  assert.equal(f.fake.options[0]?.title, "ping");
  f.sessions.send(id, "during-handoff", "again");
  await nextTick();
  assert.equal(f.fake.users.length, 1);
  finish!();
  await waitFor(() => f.permissions.pending(id).length === 1);
  f.sessions.decide(id, f.permissions.pending(id)[0]!.id, "allow");
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  assert.equal(f.fake.users.length, 2);
  assert.equal(calls.length, 1);
  assert.match(logs[0]!, /opened/);
  f.sessions.shutdown();
  const recovered = new Sessions({ dir: f.dir, router, permissions: f.permissions, queryFn: f.fake.queryFn,
    handoff: async request => { calls.push(request); return "opened"; }, onEvent: () => {}, onSessions: () => {} });
  f.instances.push(recovered);
  recovered.send(id, "after-handoff-restart", "continue");
  await waitFor(() => f.permissions.pending(id).length === 1);
  recovered.decide(id, f.permissions.pending(id)[0]!.id, "allow");
  await waitFor(() => recovered.summaryOf(id)?.state === "idle");
  assert.equal(calls.length, 1);
});

test("desktop handoff waits until already queued turns finish", async t => {
  const counts: number[] = [];
  const f = fixture(t, { permission: true }, { handoff: async () => { counts.push(f.fake.users.length); return "opened"; }, log: () => {} });
  const id = await f.create();
  await waitFor(() => f.permissions.pending(id).length === 1);
  f.sessions.send(id, "queued", "second turn");
  assert.equal(f.permissions.pending(id).length, 0);
  await waitFor(() => f.fake.users.length === 2 && f.permissions.pending(id).length === 1);
  assert.deepEqual(counts, []);
  f.sessions.decide(id, f.permissions.pending(id)[0]!.id, "allow");
  await waitFor(() => counts.length === 1);
  assert.deepEqual(counts, [2]);
});

test("desktop handoff failure is logged and never retried", async t => {
  let calls = 0;
  const logs: string[] = [];
  const f = fixture(t, {}, { handoff: async () => { calls++; throw new Error("timeout"); }, log: line => logs.push(line) });
  const id = await f.create();
  await waitFor(() => logs.length === 1);
  f.sessions.send(id, "retry-turn", "again");
  await waitFor(() => f.fake.users.length === 2 && f.sessions.summaryOf(id)?.state === "idle");
  assert.equal(calls, 1);
  assert.match(logs[0]!, /failed: timeout/);
});

test("attention: a permission request is set, survives `seen`, and clears when the approval is answered", async t => {
  const f = fixture(t, { permission: true });
  const id = await f.create();
  await waitFor(() => f.permissions.pending(id).length === 1);
  assert.equal(f.sessions.summaryOf(id)?.attention?.reason, "permission");
  // Looking at the session (seen) must NOT clear a permission request.
  assert.equal(f.sessions.markSeen(id), false);
  assert.equal(f.sessions.summaryOf(id)?.attention?.reason, "permission");
  // Answering it clears the permission attention; the turn then finishes unseen, so "finished" appears.
  await f.sessions.decide(id, f.permissions.pending(id)[0]!.id, "allow");
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  assert.notEqual(f.sessions.summaryOf(id)?.attention?.reason, "permission");
});

test("attention: a finished turn is marked unseen, cleared by seen, and restorable", async t => {
  const f = fixture(t);
  const id = await f.create();
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  assert.equal(f.sessions.summaryOf(id)?.attention?.reason, "finished");
  assert.equal(f.sessions.markSeen(id), true);
  assert.equal(f.sessions.summaryOf(id)?.attention, null);
  assert.equal(f.sessions.markUnread(id).reason, "finished");
  assert.equal(f.sessions.summaryOf(id)?.attention?.reason, "finished");
});

test("nextAttention maps a state change to the right reason", () => {
  const at = 100;
  assert.deepEqual(nextAttention(null, "running", "waiting", at), { reason: "permission", at });
  assert.deepEqual(nextAttention(null, "starting", "error", at), { reason: "failed", at });
  assert.deepEqual(nextAttention(null, "running", "idle", at), { reason: "finished", at });
  assert.equal(nextAttention(null, "starting", "idle", at), null); // a fresh session that never ran
  assert.equal(nextAttention({ reason: "finished", at }, "idle", "running", at), null);
  assert.equal(nextAttention({ reason: "permission", at }, "waiting", "idle", at)?.reason, "finished");
  // No transition keeps what is there.
  assert.deepEqual(nextAttention({ reason: "failed", at }, "error", "error", at), { reason: "failed", at });
});

test("archive: the flag round-trips, /exit archives, and nothing is deleted", async t => {
  const f = fixture(t);
  const id = await f.create();
  await waitFor(() => f.sessions.summaryOf(id)?.state === "idle");
  assert.equal(f.sessions.summaryOf(id)?.archived, undefined);
  const seq = f.sessions.log(id).lastSeq;
  assert.equal(f.sessions.setArchived(id, true), true);
  assert.equal(f.sessions.summaryOf(id)?.archived, true);
  assert.equal(f.sessions.list().find(x => x.id === id)?.archived, true);
  assert.equal(f.sessions.setArchived(id, true), false, "archiving twice changes nothing");
  assert.equal(f.sessions.log(id).lastSeq, seq, "archiving touches no log");
  assert.equal(f.sessions.setArchived(id, false), true);
  assert.equal(f.sessions.summaryOf(id)?.archived, undefined);
  // /exit is the composer's archive path: it sets the flag and sends no turn.
  f.sessions.send(id, "exit-1", "/exit");
  assert.equal(f.sessions.summaryOf(id)?.archived, true);
  assert.equal(f.sessions.log(id).lastSeq, seq, "no turn is sent for /exit");
  // Durable: the flag is in list-state.json, so a restart keeps it.
  assert.ok((JSON.parse(fs.readFileSync(path.join(f.dir, "list-state.json"), "utf8")) as { archived: string[] }).archived.includes(id));
});

test("summarize uses Bash's first line, cwd-relative Read paths and Grep pattern plus path", () => {
  const cwd = path.resolve(os.tmpdir(), "summary-project");
  assert.equal(summarize("Bash", { command: "ls -la\npwd" }, cwd), "ls -la");
  assert.equal(summarize("Bash", { command: "\n\nls\npwd" }, cwd), "ls");
  assert.equal(summarize("Read", { file_path: path.join(cwd, "src", "index.ts") }, cwd), path.join("src", "index.ts"));
  if (!posixPaths) {
    const forward = path.join(cwd, "src", "index.ts").replaceAll("\\", "/");
    const drive = forward[0]!;
    const otherDriveCase = (drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()) + forward.slice(1);
    assert.equal(summarize("Read", { file_path: otherDriveCase }, cwd), path.join("src", "index.ts"));
  }
  assert.equal(summarize("Read", { file_path: cwd }, cwd), ".");
  const outside = `${cwd}-other/file.ts`;
  assert.equal(summarize("Read", { file_path: outside }, cwd), outside);
  assert.equal(summarize("Grep", { pattern: "needle", path: path.join(cwd, "src") }, cwd), "needle  src");
  assert.equal(summarize("Grep", { pattern: "needle" }, cwd), "needle");
});

test("receipts go pending to completed on disk, and a completed resend never re-runs", { timeout: 4500 }, async t => {
  const f = fixture(t);
  const id = await f.create();
  await waitFor(() => f.sessions.list()[0]?.state === "idle");
  const stored = JSON.parse(fs.readFileSync(path.join(f.dir, "receipts.json"), "utf8")) as { key: string; state: string }[];
  assert.ok(stored.some(r => r.key === "create:create-1" && r.state === "completed"), "create receipt completed on disk");
  assert.ok(stored.some(r => r.key === `send:${id}:create-1` && r.state === "completed"), "send receipt completed on disk");
  const users = f.fake.users.length;
  assert.equal(await f.sessions.send(id, "create-1", "ping"), id);
  f.sessions.send(id, "send-1", "again");
  await waitFor(() => f.fake.users.length === users + 1);
  assert.equal(await f.sessions.send(id, "send-1", "again"), id);
  await waitFor(() => f.sessions.list()[0]?.state === "idle");
  assert.equal(f.fake.users.length, users + 1, "completed resends ack without running again");
});

function reopen(t: TestContext, f: ReturnType<typeof fixture>) {
  const permissions = PermissionQueue.open(f.permissionsFile);
  const fake = scriptedQuery();
  const recovered = new Sessions({ dir: f.dir, router, permissions, queryFn: fake.queryFn, coalesceMs: 5, onEvent: () => {}, onSessions: () => {} });
  f.instances.push(recovered);
  return { permissions, fake, recovered };
}

test("a send resend orphaned by a restart answers outcome_unknown without running", { timeout: 4500 }, async t => {
  const f = fixture(t);
  const id = await f.create();
  await waitFor(() => f.sessions.list()[0]?.state === "idle");
  // The first attempt wrote pending, then the host died before completing it.
  MessageReceipts.open(path.join(f.dir, "receipts.json")).begin(`send:${id}:orphan-1`, id);
  f.sessions.shutdown();
  const { fake, recovered } = reopen(t, f);
  assert.throws(() => recovered.send(id, "orphan-1", "lost turn"), /전송 결과를 확인할 수 없음/);
  assert.equal(fake.users.length, 0, "nothing reached the SDK");
  assert.equal(fake.options.length, 0);
  assert.equal(recovered.log(id).readAfter(0).events.filter(e => e.kind === "user" && e.clientMsgId === "orphan-1").length, 0);
});

test("a create resend orphaned by a restart answers outcome_unknown", { timeout: 4500 }, async t => {
  const f = fixture(t);
  const id = await f.create();
  await waitFor(() => f.sessions.list()[0]?.state === "idle");
  MessageReceipts.open(path.join(f.dir, "receipts.json")).begin("create:orphan-create", "");
  f.sessions.shutdown();
  const { fake, recovered } = reopen(t, f);
  assert.throws(() => recovered.create({ clientMsgId: "orphan-create", cwd: f.cwd, model: "x", effort: null, text: "lost session" }), /전송 결과를 확인할 수 없음/);
  assert.equal(fake.options.length, 0);
  assert.equal(recovered.list().length, 1, "no duplicate session was started");
  void id;
});
