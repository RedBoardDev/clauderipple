import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionQueue } from "../src/permissions.ts";
import type { PermissionRecord } from "../src/permissions.ts";
import { readJson, writeFileAtomic } from "../src/fsutil.ts";
import { posixModes } from "../../../test/capabilities.ts";

function file(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "ripple-permissions-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "private", "permissions.json");
}
const request = { session: "s1", tool: "Bash", title: "Run command", summary: "pwd", input: { command: "pwd" } };
function saved(path: string): PermissionRecord[] { return JSON.parse(readFileSync(path, "utf8")) as PermissionRecord[]; }

test("request and decision are persisted before the promise resolves", async t => {
  const path = file(t);
  let now = 100;
  const queue = PermissionQueue.open(path, () => now);
  const { record, decision } = queue.request(request);
  assert.equal(record.createdAt, 100);
  assert.equal(record.state, "pending");
  assert.match(record.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(saved(path), [record]);
  now = 200;
  const decided = queue.decide(record.id, "allow_always");
  assert.equal(decided?.state, "allow_always");
  assert.equal(decided?.decidedAt, 200);
  await decision.then(answer => {
    assert.deepEqual(answer, { decision: "allow_always" });
    assert.deepEqual(saved(path), [decided]);
  });
  assert.deepEqual(queue.pending(), []);
  assert.deepEqual(PermissionQueue.open(path, () => now).get(record.id), decided);
  if (posixModes) {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(path, "..")).mode & 0o777, 0o700);
  }
});

test("deciding a settled or unknown id is a no-op", async t => {
  const path = file(t);
  const queue = PermissionQueue.open(path);
  const { record, decision } = queue.request(request);
  queue.decide(record.id, "deny");
  assert.deepEqual(await decision, { decision: "deny" });
  const contents = readFileSync(path, "utf8");
  assert.equal(queue.decide(record.id, "allow"), null);
  assert.equal(queue.decide("unknown", "allow"), null);
  assert.equal(queue.expire(record.id, "late"), null);
  assert.equal(readFileSync(path, "utf8"), contents);
});

test("pending is oldest first, filters sessions and returned records do not mutate state", t => {
  const path = file(t);
  let now = 300;
  const queue = PermissionQueue.open(path, () => now);
  const third = queue.request(request).record;
  now = 100;
  const first = queue.request({ ...request, session: "s2" }).record;
  now = 200;
  const second = queue.request(request).record;
  assert.deepEqual(queue.pending().map(record => record.id), [first.id, second.id, third.id]);
  assert.deepEqual(queue.pending("s1").map(record => record.id), [second.id, third.id]);
  assert.deepEqual(queue.pending("unknown"), []);
  assert.equal(queue.get("unknown"), undefined);
  third.state = "deny";
  queue.pending()[0]!.state = "allow";
  queue.get(second.id)!.state = "expired";
  assert.equal(queue.get(third.id)?.state, "pending");
  assert.equal(queue.get(first.id)?.state, "pending");
  assert.equal(queue.get(second.id)?.state, "pending");
});

test("abort expires requests, including an already aborted signal", async t => {
  const path = file(t);
  const queue = PermissionQueue.open(path, () => 100);
  const controller = new AbortController();
  const { record, decision } = queue.request(request, controller.signal);
  controller.abort();
  assert.deepEqual(await decision, { decision: "expired", reason: "aborted" });
  assert.equal(queue.get(record.id)?.state, "expired");
  assert.equal(saved(path)[0]?.reason, "aborted");
  const alreadyAborted = queue.request(request, controller.signal);
  assert.equal(alreadyAborted.record.state, "expired");
  assert.deepEqual(await alreadyAborted.decision, { decision: "expired", reason: "aborted" });
  const active = new AbortController();
  const allowed = queue.request(request, active.signal);
  queue.decide(allowed.record.id, "allow");
  active.abort();
  assert.deepEqual(await allowed.decision, { decision: "allow" });
  assert.equal(queue.get(allowed.record.id)?.state, "allow");
});

test("reopen expires pending records as host_restarted and persists recovery", async t => {
  const path = file(t);
  const queue = PermissionQueue.open(path, () => 100);
  const pending = queue.request(request).record;
  const decided = queue.request({ ...request, session: "s2" });
  queue.decide(decided.record.id, "allow");
  await decided.decision;
  const reopened = PermissionQueue.open(path, () => 200);
  assert.equal(reopened.expiredOnOpen.length, 1);
  assert.deepEqual(reopened.expiredOnOpen[0], { ...pending, state: "expired", decidedAt: 200, reason: "host_restarted" });
  assert.deepEqual(reopened.get(pending.id), reopened.expiredOnOpen[0]);
  assert.deepEqual(reopened.pending(), []);
  assert.deepEqual(saved(path), [reopened.get(pending.id), reopened.get(decided.record.id)]);
  const again = PermissionQueue.open(path, () => 300);
  assert.deepEqual(again.expiredOnOpen, []);
  assert.equal(again.get(pending.id)?.decidedAt, 200);
});

test("expireSession affects only that session and resolves all its waiters", async t => {
  const path = file(t);
  const queue = PermissionQueue.open(path, () => 100);
  const a = queue.request(request);
  const b = queue.request(request);
  const c = queue.request({ ...request, session: "other" });
  const settled = queue.request(request);
  queue.decide(settled.record.id, "deny");
  const expired = queue.expireSession("s1", "session_closed");
  assert.deepEqual(expired.map(record => record.id), [a.record.id, b.record.id]);
  assert.deepEqual(await a.decision, { decision: "expired", reason: "session_closed" });
  assert.deepEqual(await b.decision, { decision: "expired", reason: "session_closed" });
  assert.deepEqual(queue.pending().map(record => record.id), [c.record.id]);
  assert.deepEqual(queue.expireSession("s1", "again"), []);
  queue.expire(c.record.id, "closed");
  assert.deepEqual(await c.decision, { decision: "expired", reason: "closed" });
  await settled.decision;
});

test("retention uses decidedAt, prunes on writes and open, and never prunes pending", async t => {
  const path = file(t);
  const day = 24 * 60 * 60 * 1000;
  let now = 0;
  const queue = PermissionQueue.open(path, () => now);
  const old = queue.request(request);
  const longPending = queue.request(request);
  queue.decide(old.record.id, "allow");
  await old.decision;
  now = day;
  const boundary = queue.request(request);
  queue.decide(boundary.record.id, "deny");
  await boundary.decision;
  now = 8 * day;
  const recent = queue.request(request);
  assert.equal(queue.get(old.record.id), undefined);
  assert.equal(queue.get(boundary.record.id)?.state, "deny");
  assert.equal(queue.get(longPending.record.id)?.state, "pending");
  assert.ok(!saved(path).some(record => record.id === old.record.id));
  now++;
  const reopened = PermissionQueue.open(path, () => now);
  assert.equal(reopened.get(boundary.record.id), undefined);
  assert.equal(reopened.get(longPending.record.id)?.reason, "host_restarted");
  assert.equal(reopened.get(recent.record.id)?.reason, "host_restarted");
  assert.equal(reopened.expiredOnOpen.length, 2);
  assert.equal(saved(path).length, 2);
});

test("failed persistence leaves pending state and promise unsettled", async t => {
  const path = file(t);
  const queue = PermissionQueue.open(path, () => 100);
  const { record, decision } = queue.request(request);
  let resolved = false;
  void decision.then(() => { resolved = true; });
  rmSync(path);
  mkdirSync(path);
  assert.throws(() => queue.decide(record.id, "allow"));
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.equal(queue.get(record.id)?.state, "pending");
  assert.deepEqual(readdirSync(join(path, "..")), ["permissions.json"]);
  rmSync(path, { recursive: true });
  queue.decide(record.id, "deny");
  assert.deepEqual(await decision, { decision: "deny" });
});

test("atomic helpers create private files; missing JSON is null but corrupt state throws", t => {
  const path = file(t);
  assert.equal(readJson(path), null);
  writeFileAtomic(path, '{"value":1}');
  assert.deepEqual(readJson<{ value: number }>(path), { value: 1 });
  writeFileAtomic(path, '{"value":2}');
  assert.deepEqual(readJson<{ value: number }>(path), { value: 2 });
  assert.ok(existsSync(path));
  assert.deepEqual(readdirSync(join(path, "..")), ["permissions.json"]);
  writeFileSync(path, "broken");
  assert.throws(() => readJson(path), SyntaxError);
  assert.throws(() => PermissionQueue.open(path), SyntaxError);
  writeFileSync(path, 'null');
  assert.throws(() => readJson(path), /Null JSON state/);
  assert.throws(() => PermissionQueue.open(path), /Null JSON state/);
  writeFileSync(path, '{}');
  assert.throws(() => PermissionQueue.open(path), /Invalid permission queue/);
  writeFileSync(path, '[{"id":"bad"}]');
  assert.throws(() => PermissionQueue.open(path), /Invalid permission record/);
});

test("decide rejects forged decision strings instead of corrupting the record", t => {
  const path = file(t);
  const queue = PermissionQueue.open(path);
  const { record } = queue.request(request);
  assert.throws(() => queue.decide(record.id, "expired" as never), /invalid decision/);
  assert.equal(queue.pending("s1").length, 1);
  assert.deepEqual(saved(path).map(r => r.state), ["pending"]);
  assert.equal(queue.decide(record.id, "deny")?.state, "deny");
});
