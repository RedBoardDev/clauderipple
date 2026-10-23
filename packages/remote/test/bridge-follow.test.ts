import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { bridgeFixture, bridgeId, line, tick } from "./bridge-fixture.ts";
import type { DesktopProcess } from "../src/desktop.ts";
import type { QueryFn, SdkUserMessage } from "../src/sessions.ts";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for the session");
    await delay(5);
  }
  await tick();
}

/** A query that behaves like the SDK's: one result per message, then it waits for the next turn. */
function idleQuery(): { queryFn: QueryFn; users: SdkUserMessage[] } {
  const users: SdkUserMessage[] = [];
  const queryFn: QueryFn = params => ({
    async *[Symbol.asyncIterator]() {
      for await (const user of params.prompt) {
        users.push(user);
        yield { type: "result", subtype: "success", is_error: false, duration_ms: 1, num_turns: 1 };
      }
    },
    interrupt: async () => {},
    setModel: async () => {},
    setPermissionMode: async () => {},
    close() {},
  });
  return { queryFn, users };
}

const appTurn = (uuid: string, question: string, answer: string): string =>
  line({ type: "user", uuid, message: { content: question } }) + line({ type: "assistant", message: { model: "m", content: [{ type: "text", text: answer }] } });

test("the phone follows a conversation the Claude app takes back while the host's query is idle", async t => {
  const registry = new Map<string, DesktopProcess>();
  const query = idleQuery();
  const f = bridgeFixture(t, { registry: () => registry, query: query.queryFn });
  // The phone resumes the Mac session, so the host drives it with its own SDK query.
  await f.sessions.send(bridgeId, "phone-1", "hello");
  await waitFor(() => f.sessions.summaryOf(bridgeId)?.state === "idle");
  assert.equal(query.users.length, 1);
  assert.equal(f.sessions.summaryOf(bridgeId)!.desktopBridge, undefined);
  // The person opens the same conversation in the Claude app with Remote Control on.
  registry.set(bridgeId, { sessionId: bridgeId, pid: 42, status: "idle", bridgeSessionId: "bridge" });
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.summaryOf(bridgeId)!.desktopBridge, true);
  // A turn the app runs now reaches the phone.
  fs.appendFileSync(f.file, appTurn("from-app", "sent in the app", "answered in the app"));
  f.advance();
  await f.sessions.pollDesktop();
  const events = f.sessions.log(bridgeId).tail().events;
  assert.ok(events.some(e => e.kind === "user" && e.text === "sent in the app"));
  assert.ok(events.some(e => e.kind === "assistant" && e.text === "answered in the app"));
});

test("a host query still owed a turn is not cut when the app takes the conversation back", async t => {
  const registry = new Map<string, DesktopProcess>();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  const queryFn: QueryFn = params => ({
    async *[Symbol.asyncIterator]() {
      for await (const _user of params.prompt) {
        if (first) { first = false; await gate; } // the turn is still running
        yield { type: "result", subtype: "success", is_error: false, duration_ms: 1, num_turns: 1 };
      }
    },
    interrupt: async () => {},
    setModel: async () => {},
    setPermissionMode: async () => {},
    close() { release(); },
  });
  const f = bridgeFixture(t, { registry: () => registry, query: queryFn });
  await f.sessions.send(bridgeId, "phone-1", "hello");
  assert.equal(f.sessions.summaryOf(bridgeId)!.state, "running");
  registry.set(bridgeId, { sessionId: bridgeId, pid: 42, status: "busy", bridgeSessionId: "bridge" });
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.summaryOf(bridgeId)!.desktopBridge, undefined, "the turn in flight is not cut");
  release();
  await waitFor(() => f.sessions.summaryOf(bridgeId)?.state === "idle");
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.summaryOf(bridgeId)!.desktopBridge, true);
});

test("a conversation's folder follows the app registry, including a move after the record was made", async t => {
  const registry = new Map<string, DesktopProcess>([[bridgeId, { sessionId: bridgeId, pid: 42, status: "idle", bridgeSessionId: "bridge", cwd: "/started/here" }]]);
  const f = bridgeFixture(t, { registry: () => registry });
  f.sessions.log(bridgeId);
  assert.equal(f.sessions.summaryOf(bridgeId)!.cwd, "/started/here");
  registry.get(bridgeId)!.cwd = "/moved/there";
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.summaryOf(bridgeId)!.cwd, "/moved/there");
});
