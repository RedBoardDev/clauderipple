import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessageReceipts, OutcomeUnknownError } from "../src/receipts.ts";
import { posixModes } from "../../../test/capabilities.ts";

function file(t: import("node:test").TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-receipts-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "receipts.json");
}

test("begin writes pending to disk, complete marks it completed", t => {
  const f = file(t);
  const receipts = MessageReceipts.open(f);
  assert.equal(receipts.status("send:s:m1"), null);
  receipts.begin("send:s:m1", "s");
  assert.equal(receipts.status("send:s:m1"), "pending");
  assert.equal(receipts.inFlight("send:s:m1"), true);
  const stored = JSON.parse(fs.readFileSync(f, "utf8")) as { key: string; state: string }[];
  assert.deepEqual(stored.map(r => [r.key, r.state]), [["send:s:m1", "pending"]]);
  if (posixModes) assert.equal((fs.statSync(f).mode & 0o777), 0o600);
  receipts.complete("send:s:m1", "s");
  assert.equal(receipts.status("send:s:m1"), "completed");
  assert.equal(receipts.inFlight("send:s:m1"), false);
  assert.equal(receipts.sessionOf("send:s:m1"), "s");
  assert.deepEqual((JSON.parse(fs.readFileSync(f, "utf8")) as { state: string }[]).map(r => r.state), ["completed"]);
});

test("a pending receipt orphaned by a restart reads as pending with nothing in flight", t => {
  const f = file(t);
  MessageReceipts.open(f).begin("send:s:m1", "s");
  // Simulated restart: a new instance over the same home, no live attempt.
  const reopened = MessageReceipts.open(f);
  assert.equal(reopened.status("send:s:m1"), "pending");
  assert.equal(reopened.inFlight("send:s:m1"), false);
  assert.equal(new OutcomeUnknownError().message, "전송 결과를 확인할 수 없음");
});

test("beginning a new id prunes orphaned pending entries older than the retention window", t => {
  const f = file(t);
  let now = 1_000_000;
  MessageReceipts.open(f, () => now).begin("send:s:crashed", "s");
  const afterRestart = MessageReceipts.open(f, () => now);
  assert.equal(afterRestart.status("send:s:crashed"), "pending");
  // The phone resends the same text under a new id; beginning it drops the old orphan.
  now += 8 * 24 * 60 * 60 * 1000;
  afterRestart.begin("send:s:retry", "s");
  assert.equal(afterRestart.status("send:s:crashed"), null);
  assert.equal(afterRestart.status("send:s:retry"), "pending");
  const stored = JSON.parse(fs.readFileSync(f, "utf8")) as { key: string }[];
  assert.deepEqual(stored.map(r => r.key), ["send:s:retry"]);
});

test("pruning never drops the same key being begun", t => {
  const f = file(t);
  let now = 1_000_000;
  MessageReceipts.open(f, () => now).begin("send:s:m1", "s");
  const afterRestart = MessageReceipts.open(f, () => now);
  // A resend of the same orphaned id checks status first (outcome_unknown) and never reaches
  // here; if it did, begin must keep its own pending entry even past the window.
  now += 8 * 24 * 60 * 60 * 1000;
  afterRestart.begin("send:s:m1", "s");
  assert.equal(afterRestart.status("send:s:m1"), "pending");
});

test("abandoned attempts run fresh on resend; completed ones survive a reopen", t => {
  const f = file(t);
  const receipts = MessageReceipts.open(f);
  receipts.begin("send:s:m1", "s");
  receipts.abandon("send:s:m1");
  assert.equal(receipts.status("send:s:m1"), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), []);
  receipts.begin("send:s:m1", "s");
  receipts.complete("send:s:m1", "s");
  const reopened = MessageReceipts.open(f);
  assert.equal(reopened.status("send:s:m1"), "completed");
  assert.equal(reopened.sessionOf("send:s:m1"), "s");
});

test("corrupt receipts never read as an empty queue", t => {
  const f = file(t);
  fs.writeFileSync(f, "[{\"id\":\"bad\"}]");
  assert.throws(() => MessageReceipts.open(f), /Invalid message receipt/);
});
