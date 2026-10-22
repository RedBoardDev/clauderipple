import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { EventLog } from "../src/eventlog.ts";
import { FRAME_CAP, INLINE_CAP } from "../src/protocol.ts";
import type { SessionEvent, Text } from "../src/protocol.ts";
import { posixModes } from "../../../test/capabilities.ts";

function directory(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "ripple-eventlog-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function open(t: TestContext, dir: string, segmentBytes?: number): EventLog {
  const log = EventLog.open({ dir, now: () => 1234, ...(segmentBytes === undefined ? {} : { segmentBytes }) });
  t.after(() => log.close());
  return log;
}
function seed(log: EventLog, count = 300): number[] {
  return Array.from({ length: count }, (_, i) => log.append({ kind: "user", text: `message ${i} ` + "x".repeat(120), clientMsgId: `c${i}` }).seq);
}
function bytes(events: SessionEvent[]): number {
  return events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)) + 1, 0);
}
function blobRoundTrip(log: EventLog, text: Text, original: string): void {
  assert.notEqual(typeof text, "string");
  if (typeof text === "string") throw new Error("Expected a blob");
  assert.equal(text.bytes, Buffer.byteLength(original));
  assert.equal(text.preview, original.slice(0, 400));
  assert.equal(log.blob(text.blob), original);
}

test("large edits retain counts before externalization, thinking blobs round-trip without loss", t => {
  const log = open(t, directory(t));
  const after = "new line\n".repeat(INLINE_CAP);
  const event = log.append({ kind: "assistant", msg: "m", model: "test", text: "", tools: [{ id: "e", name: "Edit", summary: "file.ts", input: JSON.stringify({ file_path: "file.ts", old_string: "old\n", new_string: after }) }] });
  assert.ok(event.kind === "assistant");
  assert.deepEqual(event.tools[0]?.changes, { added: INLINE_CAP, removed: 1 });
  assert.equal(typeof event.tools[0]?.input, "object");
  const text = "thinking ".repeat(INLINE_CAP);
  const thinking = log.append({ kind: "thinking", msg: "m", block: 0, text });
  assert.ok(thinking.kind === "thinking");
  blobRoundTrip(log, thinking.text, text);
});

test("seq and epoch survive reopen; files are private", t => {
  const dir = directory(t);
  const log = open(t, dir);
  assert.equal(log.lastSeq, 0);
  assert.deepEqual(log.tail(), { events: [], hasOlder: false });
  assert.deepEqual(log.before(1), { events: [], hasOlder: false });
  const first = log.append({ kind: "state", state: "running" });
  assert.equal(first.seq, 1);
  assert.equal(first.at, 1234);
  assert.equal(log.append({ kind: "state", state: "idle" }).seq, 2);
  log.close();
  const reopened = open(t, dir);
  assert.equal(reopened.epoch, log.epoch);
  assert.equal(reopened.lastSeq, 2);
  assert.equal(reopened.append({ kind: "state", state: "stopped" }).seq, 3);
  assert.deepEqual(reopened.readAfter(3), { events: [], more: false });
  assert.deepEqual(reopened.readAfter(999), { events: [], more: false });
  if (posixModes) {
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    for (const file of readdirSync(dir)) assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600);
  }
  reopened.close();
  assert.throws(() => reopened.append({ kind: "state", state: "idle" }), /closed/);
});

test("torn final lines, including invalid JSON with a newline, are dropped", t => {
  for (const torn of ['{"kind":"user"', '{bad json}\n', '{"seq":3,"at":1234,"kind":"state","state":"idle"}']) {
    const dir = directory(t);
    const log = open(t, dir);
    seed(log, 2);
    log.close();
    const file = join(dir, "events-000001.jsonl");
    const intact = readFileSync(file, "utf8");
    appendFileSync(file, torn);
    const reopened = open(t, dir);
    assert.equal(reopened.lastSeq, 2);
    assert.equal(readFileSync(file, "utf8"), intact);
    assert.equal(reopened.append({ kind: "state", state: "idle" }).seq, 3);
    assert.deepEqual(reopened.readAfter(0).events.map(event => event.seq), [1, 2, 3]);
  }
});

test("corrupt metadata never replaces the persisted epoch", t => {
  const dir = directory(t);
  open(t, dir).close();
  const meta = join(dir, "meta.json");
  for (const data of ["null", "not-json", '{}', '{"epoch":"invalid"}']) {
    writeFileSync(meta, data);
    assert.throws(() => EventLog.open({ dir }));
    assert.equal(readFileSync(meta, "utf8"), data);
  }
});

test("mid-file corruption is not silently discarded", t => {
  const dir = directory(t);
  const log = open(t, dir);
  seed(log, 2);
  log.close();
  const file = join(dir, "events-000001.jsonl");
  const lines = readFileSync(file, "utf8").split("\n");
  writeFileSync(file, `${lines[0]}\nnot-json\n${lines[1]}\n`);
  assert.throws(() => EventLog.open({ dir }), SyntaxError);
});

test("readAfter pages are bounded, complete and resume is idempotent", t => {
  const log = open(t, directory(t));
  seed(log);
  const cap = 2048;
  assert.deepEqual(log.readAfter(42, cap), log.readAfter(42, cap));
  let cursor = 42;
  const seen: number[] = [];
  let pages = 0;
  while (true) {
    const page = log.readAfter(cursor, cap);
    assert.ok(bytes(page.events) <= cap);
    assert.ok(page.events.length > 0);
    seen.push(...page.events.map(event => event.seq));
    cursor = page.events.at(-1)!.seq;
    pages++;
    if (!page.more) break;
  }
  assert.ok(pages > 5);
  assert.deepEqual(seen, Array.from({ length: 258 }, (_, i) => i + 43));
  assert.equal(new Set(seen).size, seen.length);
});

test("tail and repeated before walk the complete history once in chronological order", t => {
  const log = open(t, directory(t));
  const expected = seed(log);
  const cap = 2048;
  let page = log.tail(cap);
  let seen: number[] = [];
  while (true) {
    assert.ok(bytes(page.events) <= cap);
    assert.ok(page.events.length > 0);
    seen = [...page.events.map(event => event.seq), ...seen];
    if (!page.hasOlder) break;
    page = log.before(page.events[0]!.seq, cap);
  }
  assert.deepEqual(seen, expected);
  assert.equal(new Set(seen).size, expected.length);
  assert.deepEqual(log.before(1), { events: [], hasOlder: false });
  assert.deepEqual(log.before(1000, cap), log.tail(cap));
});

test("all pages skip finalized deltas but keep unfinalized ones across reopen", t => {
  const dir = directory(t);
  const log = open(t, dir);
  log.append({ kind: "delta", msg: "done", text: "one" });
  log.append({ kind: "delta", msg: "live", text: "two" });
  log.append({ kind: "delta", msg: "done", text: "three" });
  log.append({ kind: "assistant", msg: "done", text: "final", model: "m", tools: [] });
  log.append({ kind: "delta", msg: "done", text: "late delta" });
  function check(current: EventLog): void {
    assert.deepEqual(current.readAfter(0).events.map(event => event.seq), [2, 4]);
    assert.deepEqual(current.tail().events.map(event => event.seq), [2, 4]);
    assert.deepEqual(current.before(4).events.map(event => event.seq), [2]);
    assert.deepEqual(current.readAfter(4), { events: [], more: false });
    assert.deepEqual(current.before(2), { events: [], hasOlder: false });
    assert.deepEqual(current.readAfter(0, 1).events.map(event => event.seq), [2]);
    assert.equal(current.readAfter(0, 1).more, true);
    assert.equal(current.tail(1).hasOlder, true);
  }
  check(log);
  log.close();
  check(open(t, dir));
});

test("large text fields externalize and round-trip, and blob ids cannot escape", t => {
  const dir = directory(t);
  const log = open(t, dir);
  const original = "界".repeat(INLINE_CAP + 1);
  const body = { kind: "assistant" as const, msg: "m1", model: "m", text: original, tools: [{ id: "t1", name: "Bash", summary: "run", input: original }] };
  const assistant = log.append(body);
  assert.equal(body.text, original);
  assert.equal(body.tools[0]!.input, original);
  assert.equal(assistant.kind, "assistant");
  if (assistant.kind !== "assistant") throw new Error("Wrong event kind");
  blobRoundTrip(log, assistant.text, original);
  blobRoundTrip(log, assistant.tools[0]!.input!, original);
  const result = log.append({ kind: "tool_result", toolUseId: "t1", ok: true, text: original });
  if (result.kind !== "tool_result") throw new Error("Wrong event kind");
  blobRoundTrip(log, result.text, original);
  const permission = log.append({ kind: "permission", id: "p1", tool: "Bash", title: "run", summary: "run", input: original, canAlways: true });
  if (permission.kind !== "permission") throw new Error("Wrong event kind");
  blobRoundTrip(log, permission.input, original);
  const small = log.append({ kind: "tool_result", toolUseId: "t2", ok: true, text: "a".repeat(INLINE_CAP) });
  if (small.kind !== "tool_result") throw new Error("Wrong event kind");
  assert.equal(typeof small.text, "string");
  assert.equal(log.blob("../x"), null);
  assert.equal(log.blob("00000000-0000-0000-0000-000000000000"), null);
  if (posixModes) {
    assert.equal(statSync(join(dir, "blobs")).mode & 0o777, 0o700);
    for (const file of readdirSync(join(dir, "blobs"))) assert.equal(statSync(join(dir, "blobs", file)).mode & 0o777, 0o600);
  }
  log.close();
  const reopened = open(t, dir);
  blobRoundTrip(reopened, assistant.text, original);
  assert.deepEqual(reopened.readAfter(0).events[0], assistant);
});

test("oversize display strings are truncated to the line cap; one event still fits a tiny page", t => {
  const log = open(t, directory(t));
  const user = log.append({ kind: "user", text: "😀\n\"".repeat(40000), clientMsgId: "keep-me" });
  if (user.kind !== "user") throw new Error("Wrong event kind");
  assert.equal(user.clientMsgId, "keep-me");
  assert.ok(user.text.endsWith("…"));
  assert.ok(bytes([user]) <= 64 * 1024);
  const assistant = log.append({ kind: "assistant", msg: "m", model: "m", text: "done", tools: Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, name: "Bash", summary: "界".repeat(20000), input: "x".repeat(20000) })) });
  assert.ok(bytes([assistant]) <= 64 * 1024);
  const sub = log.append({ kind: "subagent", toolUseId: "t", sub: "s", description: "x".repeat(100000), model: null, status: "done", steps: 1 });
  assert.ok(bytes([sub]) <= 64 * 1024);
  assert.deepEqual(log.readAfter(0, 1), { events: [user], more: true });
  assert.deepEqual(log.tail(0), { events: [sub], hasOlder: true });
  assert.deepEqual(log.before(2, 1), { events: [user], hasOlder: false });
  assert.ok(bytes(log.tail().events) <= FRAME_CAP - 4096);
  const seq = log.lastSeq;
  assert.throws(() => log.append({ kind: "turn", model: "x".repeat(100000), effort: null }), RangeError);
  assert.equal(log.lastSeq, seq);
});

test("segment rotation preserves reads and appends across reopen", t => {
  const dir = directory(t);
  const log = open(t, dir, 512);
  seed(log, 50);
  const expected = log.readAfter(0).events;
  const names = readdirSync(dir).filter(name => name.endsWith(".jsonl"));
  assert.ok(names.length > 5);
  for (const name of names) assert.ok(statSync(join(dir, name)).size <= 512);
  log.close();
  const reopened = open(t, dir, 512);
  assert.equal(reopened.lastSeq, 50);
  assert.deepEqual(reopened.readAfter(0).events, expected);
  assert.equal(reopened.append({ kind: "state", state: "idle" }).seq, 51);
  assert.deepEqual(reopened.before(51).events, expected);
  assert.deepEqual(reopened.tail().events.slice(0, -1), expected);
});

test("opening 200k events rebuilds the index in under 3 seconds", t => {
  const dir = directory(t);
  const initial = open(t, dir);
  initial.close();
  const count = 200000;
  const perSegment = 50000;
  for (let segment = 0; segment < count / perSegment; segment++) {
    const lines = Array.from({ length: perSegment }, (_, i) => JSON.stringify({ kind: "delta", msg: "live", text: "small", seq: segment * perSegment + i + 1, at: 1234 }) + "\n");
    writeFileSync(join(dir, `events-${String(segment + 1).padStart(6, "0")}.jsonl`), lines.join(""), { mode: 0o600 });
  }
  const start = performance.now();
  const log = EventLog.open({ dir });
  const elapsed = performance.now() - start;
  t.after(() => log.close());
  t.diagnostic(`200k-event open: ${elapsed.toFixed(1)} ms`);
  assert.equal(log.lastSeq, count);
  assert.ok(elapsed < 3000, `Opening took ${elapsed.toFixed(1)} ms`);
  assert.equal(log.tail(2048).events.at(-1)!.seq, count);
  assert.equal(log.readAfter(count - 2).events[0]!.seq, count - 1);
});
