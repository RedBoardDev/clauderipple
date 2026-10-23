import test from "node:test";
import assert from "node:assert/strict";
import { groupSessions, sessionGroup, groupLabel, GROUP_ORDER } from "../web/sidebar.ts";
import type { AttentionReason, SessionSummary } from "../src/protocol.ts";

function s(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return { id, title: id, cwd: `/home/projects/${id}`, model: "m", effort: null, state: "idle", pending: 0, createdAt: 1, updatedAt: 1, lastSeq: 0, epoch: "", ...over };
}
const keys = (list: SessionSummary[]): string[] => groupSessions(list).map(g => g.key);

test("the five buckets stack in order: input, failed, review, working, done", () => {
  const input = s("a", { pending: 1 });
  const failed = s("b", { state: "error" });
  const review = s("c", { attention: { reason: "finished", at: 5 } });
  const working = s("d", { state: "running" });
  const done = s("e", {});
  assert.deepEqual(keys([done, working, review, failed, input]), ["group:input", "group:failed", "group:review", "group:working", "group:done"]);
  // A `waiting` state with no pending row still counts as input.
  assert.equal(sessionGroup(s("f", { state: "waiting" })), "input");
  assert.equal(sessionGroup(s("g", { background: true })), "working");
});

test("precedence: a pending request beats an error; an error beats a lingering finished flag", () => {
  assert.equal(sessionGroup(s("x", { state: "error", pending: 2 })), "input");
  assert.equal(sessionGroup(s("x", { state: "error", attention: { reason: "finished", at: 9 } })), "failed");
  // A failed attention does not by itself make a non-error session "failed".
  assert.equal(sessionGroup(s("x", { state: "idle", attention: { reason: "failed", at: 9 } })), "done");
});

test("within a bucket the newest state change is first", () => {
  const older = s("older", { pending: 1, updatedAt: 10 });
  const newer = s("newer", { pending: 1, updatedAt: 30 });
  assert.deepEqual(groupSessions([older, newer])[0]?.sessions.map(x => x.id), ["newer", "older"]);
});

test("archived sessions are hidden unless asked for", () => {
  const kept = s("kept", { updatedAt: 2 });
  const hidden = s("hidden", { archived: true, updatedAt: 3 });
  assert.deepEqual(groupSessions([kept, hidden]).flatMap(g => g.sessions.map(x => x.id)), ["kept"]);
  const shown = groupSessions([kept, hidden], "status", { includeArchived: true }).flatMap(g => g.sessions.map(x => x.id));
  assert.deepEqual(shown.sort(), ["hidden", "kept"]);
});

test("folder mode groups by working directory, most recently changed folder first", () => {
  const a = s("a", { cwd: "/home/one", updatedAt: 50 });
  const b = s("b", { cwd: "/home/two", updatedAt: 20 });
  const c = s("c", { cwd: "/home/one", updatedAt: 10 });
  const sections = groupSessions([a, b, c], "folder");
  assert.deepEqual(sections.map(g => g.key), ["folder:/home/one", "folder:/home/two"]);
  assert.deepEqual(sections[0]?.sessions.map(x => x.id), ["a", "c"]);
  assert.equal(sections[0]?.name, "one");
});

test("a Claude app question counts as input needed; a reason this build does not know is no review", () => {
  assert.equal(sessionGroup(s("q", { attention: { reason: "question", at: 1 } })), "input");
  // An older client only compares the reasons it knows, so an unknown one must fall through, not throw.
  assert.equal(sessionGroup(s("x", { attention: { reason: "mystery" as AttentionReason, at: 1 } })), "done");
});

test("bucket labels are localized and cover every bucket", () => {
  assert.deepEqual(GROUP_ORDER, ["input", "failed", "review", "working", "done"]);
  assert.equal(groupLabel("input"), "입력 필요");
  assert.equal(groupLabel("failed"), "실패");
  assert.equal(groupLabel("review"), "검토 대기");
  assert.equal(groupLabel("working"), "작업 중");
  assert.equal(groupLabel("done"), "완료");
});
