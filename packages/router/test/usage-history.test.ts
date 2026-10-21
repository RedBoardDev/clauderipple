import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RequestLog, type RequestRecord } from "../src/requestlog.ts";

const HOUR = 3_600_000;

function record(id: string, at: string, overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    id,
    at,
    ms: 100,
    status: 200,
    ok: true,
    kind: "messages",
    source: "claude-opus",
    target: "gpt-test",
    provider: "chatgpt",
    stream: true,
    ...overrides,
  };
}

function usage(input: number, cached: number, output: number, cacheWrite?: number): NonNullable<RequestRecord["usage"]> {
  return { input, cached, output, ...(cacheWrite === undefined ? {} : { cacheWrite }) };
}

function withDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-usage-history-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("usage aggregates hours, providers and models, and matches the in-memory summary", () => {
  withDir((dir) => {
    const log = new RequestLog(path.join(dir, "requests.jsonl"));
    // Hour 10: two ChatGPT requests on two models, one failure without usage.
    log.add(record("a", "2026-10-20T10:05:00.000Z", { ms: 100, usage: usage(20, 80, 9) }));
    log.add(record("b", "2026-10-20T10:20:00.000Z", { ms: 300, target: "gpt-other", usage: usage(50, 0, 7, 10) }));
    log.add(record("c", "2026-10-20T10:40:00.000Z", { ms: 200, ok: false, status: 500 }));
    // Hour 11: another provider.
    log.add(record("d", "2026-10-20T11:10:00.000Z", { ms: 400, provider: "anthropic", target: "claude-test", usage: usage(2, 98, 1) }));
    // Hour 12 stays open in memory.
    log.add(record("e", "2026-10-20T12:00:30.000Z", { ms: 50, target: "gpt-other", usage: usage(5, 5, 2) }));

    const from = Date.parse("2026-10-20T09:00:00.000Z");
    const to = Date.parse("2026-10-20T13:00:00.000Z");
    const usageSummary = log.usage(from, to);
    const memory = log.summary(from);
    assert.deepEqual(usageSummary.total, memory.total);
    assert.deepEqual(usageSummary.providers, memory.providers);
    assert.deepEqual(
      usageSummary.models.map((m) => [m.provider, m.model, m.count, m.input, m.cached, m.cacheWrite, m.output]),
      memory.models.map((m) => [m.provider, m.model, m.count, m.input, m.cached, m.cacheWrite, m.output]),
    );
    assert.equal(usageSummary.total.count, 5);
    assert.equal(usageSummary.total.failed, 1);
    assert.equal(usageSummary.models.length, 3);
    // Most tokens read first (input + cached + cacheWrite), then the busiest: gpt-test and
    // claude-test tie at 100, and gpt-test has two records against one.
    assert.deepEqual(usageSummary.models.map((m) => `${m.provider}/${m.model}`), ["chatgpt/gpt-test", "anthropic/claude-test", "chatgpt/gpt-other"]);
    assert.equal(usageSummary.earliest, "2026-10-20T10:00:00.000Z");
  });
});

test("usage range boundaries are whole hours, and to is exclusive", () => {
  withDir((dir) => {
    const log = new RequestLog(path.join(dir, "requests.jsonl"));
    log.add(record("h10", "2026-10-20T10:59:59.000Z", { usage: usage(1, 0, 0) }));
    log.add(record("h11", "2026-10-20T11:00:00.000Z", { usage: usage(10, 0, 0) }));
    log.add(record("h12", "2026-10-20T12:00:00.000Z", { usage: usage(100, 0, 0) }));

    const at11 = Date.parse("2026-10-20T11:00:00.000Z");
    const at12 = Date.parse("2026-10-20T12:00:00.000Z");
    assert.deepEqual(log.usage(at11, at12).total.input, 10);
    // A from inside hour 11 still takes all of hour 11.
    assert.deepEqual(log.usage(at11 + 30 * 60_000, at12).total.input, 10);
    // A to inside hour 12 leaves hour 12 out.
    assert.deepEqual(log.usage(at12 - 1, at12).total.input, 10);
    assert.deepEqual(log.usage(at11, at12 + 1).total.input, 110);
    assert.deepEqual(log.usage(Date.parse("2026-10-20T10:00:00.000Z"), at11).total.input, 1);
    assert.equal(log.usage(at12, at12).total.count, 0);
  });
});

test("a late record (started in an earlier hour) is written at once and counted once", () => {
  withDir((dir) => {
    const file = path.join(dir, "requests.jsonl");
    const log = new RequestLog(file);
    log.add(record("h11", "2026-10-20T11:05:00.000Z", { usage: usage(10, 0, 0) }));
    log.add(record("h12", "2026-10-20T12:05:00.000Z", { usage: usage(100, 0, 0) }));
    // A long request started at 10:58 and finished during hour 12.
    log.add(record("late", "2026-10-20T10:58:00.000Z", { ms: 600_000, usage: usage(1, 0, 0) }));

    const from = Date.parse("2026-10-20T10:00:00.000Z");
    const to = Date.parse("2026-10-20T13:00:00.000Z");
    assert.equal(log.usage(from, to).total.input, 111);
    const hourly = fs.readFileSync(path.join(dir, "usage-hourly.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { h: number });
    assert.equal(hourly.filter((b) => b.h === Math.floor(Date.parse("2026-10-20T10:00:00.000Z") / HOUR)).length, 1);

    // A restart must not count the late line again.
    const reloaded = new RequestLog(file);
    assert.equal(reloaded.usage(from, to).total.input, 111);
    assert.equal(reloaded.usage(from, to).total.count, 3);
  });
});

test("a restart preserves every hour, including the open one, without double counting", () => {
  withDir((dir) => {
    const file = path.join(dir, "requests.jsonl");
    const first = new RequestLog(file);
    for (let hour = 0; hour < 3; hour++) {
      first.add(record(`h${hour}`, new Date(Date.UTC(2026, 9, 20, 10 + hour, 5)).toISOString(), { usage: usage(10, 20, 3) }));
    }
    const from = Date.parse("2026-10-20T00:00:00.000Z");
    const to = Date.parse("2026-10-21T00:00:00.000Z");
    const before = first.usage(from, to);
    assert.equal(before.total.count, 3);

    for (let restart = 0; restart < 2; restart++) {
      const reloaded = new RequestLog(file);
      const after = reloaded.usage(from, to);
      assert.deepEqual(after.total, before.total);
      assert.deepEqual(after.providers, before.providers);
      assert.deepEqual(after.models, before.models);
    }

    // Adding more to the open hour after a restart still counts once.
    const continued = new RequestLog(file);
    continued.add(record("h2b", "2026-10-20T12:30:00.000Z", { usage: usage(1, 1, 1) }));
    assert.equal(continued.usage(from, to).total.count, 4);
    const final = new RequestLog(file);
    assert.equal(final.usage(from, to).total.count, 4);
    assert.equal(final.usage(from, to).total.input, 31);
  });
});

test("the first run backfills both requests.jsonl.1 and requests.jsonl", () => {
  withDir((dir) => {
    const file = path.join(dir, "requests.jsonl");
    fs.writeFileSync(`${file}.1`, [
      record("old-1", "2026-10-18T09:10:00.000Z", { usage: usage(1, 0, 0) }),
      record("old-2", "2026-10-18T10:10:00.000Z", { usage: usage(2, 0, 0) }),
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    fs.writeFileSync(file, [
      record("new-1", "2026-10-19T09:10:00.000Z", { usage: usage(4, 0, 0) }),
      record("new-2", "2026-10-20T09:10:00.000Z", { usage: usage(8, 0, 0) }),
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");

    const log = new RequestLog(file);
    const summary = log.usage(Date.parse("2026-10-01T00:00:00.000Z"), Date.parse("2026-10-25T00:00:00.000Z"));
    assert.equal(summary.total.count, 4);
    assert.equal(summary.total.input, 15);
    assert.equal(summary.earliest, "2026-10-18T09:00:00.000Z");

    // The backfilled history is now on disk, so a restart is not needed to answer.
    assert.ok(fs.existsSync(path.join(dir, "usage-hourly.jsonl")));
    const reloaded = new RequestLog(file);
    assert.equal(reloaded.usage(Date.parse("2026-10-01T00:00:00.000Z"), Date.parse("2026-10-25T00:00:00.000Z")).total.count, 4);
  });
});

test("a restart replays requests.jsonl.1 when a long request straddled the rotation", () => {
  withDir((dir) => {
    const file = path.join(dir, "requests.jsonl");
    const history = path.join(dir, "usage-hourly.jsonl");
    // Hour 10 is on disk; hour 11 was the open hour when the file rotated.
    fs.writeFileSync(history, JSON.stringify({ h: Math.floor(Date.parse("2026-10-20T10:00:00.000Z") / HOUR), p: "chatgpt", m: "gpt-test", count: 1, ok: 1, failed: 0, input: 1, cached: 0, cacheWrite: 0, output: 0, ms: 100 }) + "\n");
    fs.writeFileSync(`${file}.1`, JSON.stringify(record("open-hour", "2026-10-20T11:10:00.000Z", { usage: usage(2, 0, 0) })) + "\n");
    const rotatedAt = new Date("2026-10-20T11:20:00.000Z");
    fs.utimesSync(`${file}.1`, rotatedAt, rotatedAt);
    // The first record after the rotation started in hour 10, before everything left in `.1`.
    fs.writeFileSync(file, [
      record("straddler", "2026-10-20T10:50:00.000Z", { usage: usage(4, 0, 0) }),
      record("after", "2026-10-20T11:30:00.000Z", { usage: usage(8, 0, 0) }),
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");

    const log = new RequestLog(file);
    const hour11 = log.usage(Date.parse("2026-10-20T11:00:00.000Z"), Date.parse("2026-10-20T12:00:00.000Z"));
    assert.equal(hour11.total.count, 2);
    assert.equal(hour11.total.input, 10);
  });
});

test("usage-hourly.jsonl is readable by its owner only, even one written before that rule", () => {
  withDir((dir) => {
    const file = path.join(dir, "requests.jsonl");
    const history = path.join(dir, "usage-hourly.jsonl");
    fs.writeFileSync(history, "", { mode: 0o644 });
    const log = new RequestLog(file);
    log.add(record("h11", "2026-10-20T11:05:00.000Z", { usage: usage(10, 0, 0) }));
    // A record in the next hour closes hour 11, which appends it.
    log.add(record("h12", "2026-10-20T12:05:00.000Z", { usage: usage(1, 0, 0) }));
    assert.ok(fs.readFileSync(history, "utf8").length > 0);
    assert.equal(fs.statSync(history).mode & 0o777, 0o600);
  });
});

test("malformed usage-history lines are skipped and good ones still count", () => {
  withDir((dir) => {
    const file = path.join(dir, "requests.jsonl");
    const history = path.join(dir, "usage-hourly.jsonl");
    fs.writeFileSync(history, [
      JSON.stringify({ h: 493_000, p: "chatgpt", m: "gpt-test", count: 1, ok: 1, failed: 0, input: 10, cached: 0, cacheWrite: 0, output: 1, ms: 100 }),
      "{not json",
      JSON.stringify({ h: "not-a-number" }),
      "",
      JSON.stringify({ h: 493_001, p: "chatgpt", m: "gpt-test", count: 1, ok: 0, failed: 1, input: 5, cached: 0, cacheWrite: 0, output: 0, ms: 200 }),
    ].join("\n") + "\n");
    const log = new RequestLog(file);
    const summary = log.usage(0, Date.parse("2026-10-25T00:00:00.000Z"));
    assert.equal(summary.total.count, 2);
    assert.equal(summary.total.input, 15);
    assert.equal(summary.total.failed, 1);
    assert.equal(summary.total.avgMs, 150);
  });
});

test("an unwritable history path never throws from add", () => {
  withDir((dir) => {
    // A regular file where the directory should be makes mkdir/append fail.
    const blocker = path.join(dir, "logs");
    fs.writeFileSync(blocker, "");
    const file = path.join(blocker, "requests.jsonl");
    const log = new RequestLog(file);
    assert.doesNotThrow(() => {
      log.add(record("a", "2026-10-20T10:05:00.000Z", { usage: usage(1, 0, 0) }));
      log.add(record("b", "2026-10-20T11:05:00.000Z", { usage: usage(2, 0, 0) }));
    });
    assert.equal(log.list(10).length, 2);
  });
});
