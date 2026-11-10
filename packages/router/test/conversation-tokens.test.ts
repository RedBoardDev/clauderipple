import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RequestLog, requestConversationKey, type RequestRecord } from "../src/requestlog.ts";
import { UsageHistory } from "../src/usage-history.ts";

const HOUR = 3_600_000;
const START = Date.parse("2026-10-20T10:00:00Z");
const key = (agent: string) => requestConversationKey({}, "shared-session", agent)!;
function record(id: string, at: number, overrides: Partial<RequestRecord> = {}): RequestRecord {
  return { id, at: new Date(at).toISOString(), ms: 10, status: 200, ok: true, kind: "messages", source: "source", target: "model", provider: "provider", stream: true, session: "shared-session", ...overrides };
}
function withLog(fn: (log: RequestLog, file: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-conversation-tokens-"));
  const file = path.join(dir, "requests.jsonl");
  try { fn(new RequestLog(file), file); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("keys prefer agent headers, hash whole first messages and ignore moving cache breakpoints", () => {
  const body = { messages: [{ role: "user", content: [{ type: "text", text: "private task", cache_control: { type: "ephemeral" } }] }] };
  const first = requestConversationKey(body, "session");
  assert.match(first!, /^[a-f0-9]{32}$/);
  assert.equal(first, requestConversationKey({ messages: [{ role: "user", content: [{ type: "text", text: "private task" }] }] }, "session"));
  assert.notEqual(first, requestConversationKey(body, "another-session"));
  assert.notEqual(first, requestConversationKey(body, "session", "agent"));
  assert.equal(requestConversationKey(body, "session", "agent"), requestConversationKey({}, "session", "agent"));
  assert.notEqual(requestConversationKey(body, "session", "agent"), requestConversationKey(body, "session", "agent2"));
  const long = "x".repeat(5000);
  assert.notEqual(requestConversationKey({ messages: [{ role: "user", content: long + "a" }] }, "s"), requestConversationKey({ messages: [{ role: "user", content: long + "b" }] }, "s"));
  assert.equal(requestConversationKey({}, "session"), undefined);
  assert.equal(requestConversationKey(body), undefined, "unidentified clients must not be merged across sessions");
});

test("latest prompt (not largest or latest completion) + every output, across hours/models/providers and restarts", () => {
  withLog((log, file) => {
    const conversation = key("worker");
    log.add(record("early", START, { conversation, usage: { input: 2, cacheWrite: 1000, cached: 9000, output: 11 } }));
    log.add(record("new", START + HOUR, { conversation, target: "new-model", provider: "new-provider", usage: { input: 100, cached: 0, output: 13 } }));
    // This older, long-running request finishes after the latest request, and must not win.
    log.add(record("late", START + 1000, { conversation, usage: { input: 20000, cached: 0, output: 17 } }));
    log.add(record("failed", START + HOUR + 1000, { conversation, ok: false, status: 500 }));
    for (const current of [log, new RequestLog(file), new RequestLog(file)]) {
      const result = current.usage(START, START + 2 * HOUR);
      assert.equal(result.total.conversationTokens, 100 + 11 + 13 + 17);
      assert.equal(result.total.ungroupedRequests, 0);
      assert.equal(result.providers.provider!.conversationTokens, 20000 + 11 + 17);
      assert.equal(result.providers["new-provider"]!.conversationTokens, 113);
      assert.equal(result.total.input, 20102);
      assert.equal(current.usage(START + HOUR, START + 2 * HOUR).total.conversationTokens, 113, "only outputs in the selected period count");
      assert.equal(current.summary(START).total.conversationTokens, 141);
    }
  });
});

test("main and two workers in one session are separate; legacy, side and image usage remain independent", () => {
  withLog((log) => {
    const conversation = requestConversationKey({ messages: [{ role: "user", content: "same task" }] }, "shared-session")!;
    for (const [i, c] of [conversation, key("one"), key("two")].entries()) {
      log.add(record(`first-${i}`, START, { conversation: c, usage: { input: 100, cached: 1000, output: 10 } }));
      log.add(record(`last-${i}`, START + 1000, { conversation: c, usage: { input: 2, cacheWrite: 20, cached: 2000, output: 30 } }));
    }
    for (const overrides of [{}, { conversation, purpose: "auto-mode-classifier" as const }, { conversation, kind: "image" as const }]) {
      log.add(record(`independent-${log.list(100).length}`, START + 2000, { ...overrides, usage: { input: 5, cacheWrite: 7, cached: 11, output: 13 } }));
    }
    assert.equal(log.usage(START, START + HOUR).total.conversationTokens, 3 * (2022 + 40) + 3 * 36);
    assert.equal(log.usage(START, START + HOUR).total.ungroupedRequests, 3);
    assert.deepEqual(log.summary(START).total, log.usage(START, START + HOUR).total);
    assert.equal(log.usage(START + HOUR, START + 2 * HOUR).total.conversationTokens, 0);
  });
});

test("old hourly history reports independent-request fallback and merges with new keyed usage", () => {
  withLog((_log, file) => {
    fs.writeFileSync(path.join(path.dirname(file), "usage-hourly.jsonl"), JSON.stringify({ h: START / HOUR, p: "provider", m: "model", count: 3, ok: 3, failed: 0, input: 10, cached: 20, cacheWrite: 30, output: 40, ms: 10 }) + "\n");
    const log = new RequestLog(file);
    log.add(record("new", START + 1, { conversation: key("new"), usage: { input: 2, cached: 50, output: 3 } }));
    log.add(record("flush", START + HOUR));
    for (const current of [log, new RequestLog(file)]) {
      const result = current.usage(START, START + HOUR);
      assert.equal(result.total.conversationTokens, 155);
      assert.equal(result.total.ungroupedRequests, 3);
    }
  });
});

// Numeric usage only, extracted from completed subagent transcripts on 2026-10-26.
// No messages, headers, session IDs or user data are retained. Tuple: uncached, cache write, cache read, output.
const fixtures: { name: string; turns: number[][]; expected: number }[] = [
  { name: "a27b2d4a84993df7c", expected: 44351, turns: [
    [16453,0,0,259],[9420,0,16463,1440],[2846,0,24518,100],[2959,0,25314,94],
    [2694,0,27459,84],[2596,0,30152,82],[2758,0,32748,97],[3913,0,33460,4822],
  ] },
  { name: "a63ba0b2467cbd0ff", expected: 35832, turns: [
    [16434,0,0,170],[7531,0,16512,95],[164,0,24064,459],[5508,0,24576,708],[1978,0,30592,1830],
  ] },
  // Exact six-request slice around the lost cache in agent-a84e20714aeb2b185.
  // The uncached prompt jumps from 352 to 356049, then falls to 188 on the next request.
  { name: "a84e20714aeb2b185-cache-break", expected: 361478, turns: [
    [405,0,355072,270],[352,0,355456,565],[356049,0,384,303],
    [188,0,356608,147],[237,0,356736,226],[367,0,356864,2736],
  ] },
];

for (const fixture of fixtures) {
  test(`transcript usage matches the Agents card exactly: ${fixture.name}`, () => {
    withLog((log) => {
      const conversation = key(fixture.name);
      for (const [i, u] of fixture.turns.entries()) {
        log.add(record(String(i), START + i * 1000, { conversation, usage: { input: u[0]!, cacheWrite: u[1]!, cached: u[2]!, output: u[3]! } }));
      }
      const last = fixture.turns.at(-1)!;
      const card = last[0]! + last[1]! + last[2]! + fixture.turns.reduce((sum, u) => sum + u[3]!, 0);
      assert.equal(card, fixture.expected);
      assert.equal(log.usage(START, START + HOUR).total.conversationTokens, card);
      assert.equal(log.summary(START).total.conversationTokens, card);
    });
  });
}

// Optional local evidence test: replay the complete original transcripts, not just the portable
// numeric fixtures. Explicit opt-in keeps CI independent of the user's private home directory.
const transcriptDir = process.env.CR_TOKEN_TRANSCRIPT_DIR;
for (const [agent, expected] of [["a27b2d4a84993df7c", 44351], ["a63ba0b2467cbd0ff", 35832], ["a84e20714aeb2b185", 596958]] as const) {
  test(`complete local transcript matches Agents card: ${agent}`, { skip: !transcriptDir }, () => {
    type TranscriptLine = { type?: string; message?: { id?: string; usage?: { input_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens: number } } };
    const lines = fs.readFileSync(path.join(transcriptDir!, `agent-${agent}.jsonl`), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as TranscriptLine);
    const requests = new Map<string, NonNullable<NonNullable<TranscriptLine["message"]>["usage"]>>();
    // Streaming assistant entries may repeat a message ID: keep its final usage snapshot.
    for (const line of lines) if (line.type === "assistant" && line.message?.id && line.message.usage) requests.set(line.message.id, line.message.usage);
    withLog((log) => {
      const usages = [...requests.values()];
      for (const [i, u] of usages.entries()) {
        log.add(record(String(i), START + i * 1000, { conversation: key(agent), usage: { input: u.input_tokens, cacheWrite: u.cache_creation_input_tokens ?? 0, cached: u.cache_read_input_tokens ?? 0, output: u.output_tokens } }));
      }
      const last = usages.at(-1)!;
      const card = last.input_tokens + (last.cache_creation_input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0) + usages.reduce((n, u) => n + u.output_tokens, 0);
      assert.equal(card, expected);
      assert.equal(log.usage(START, START + HOUR).total.conversationTokens, card);
    });
  });
}

test("50,000 requests compact to hour/model/conversation states and summarize without a request-sized scan", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-conversation-scale-"));
  try {
    const history = new UsageHistory(path.join(dir, "usage-hourly.jsonl"));
    const conversationKeys = Array.from({ length: 5000 }, (_, i) => key(String(i)));
    const start = performance.now();
    for (let i = 0; i < 50000; i++) history.add(record(String(i), START + i * 10, { conversation: conversationKeys[i % 5000]!, usage: { input: 2, cached: 10000, output: 3 } }));
    const addedMs = performance.now() - start;
    const summaryStart = performance.now();
    const result = history.summary(START, START + HOUR);
    const summaryMs = performance.now() - summaryStart;
    assert.equal(result.total.conversationTokens, 5000 * 10002 + 50000 * 3);
    assert.equal(result.total.ungroupedRequests, 0);
    history.add(record("flush", START + HOUR));
    const bytes = fs.statSync(path.join(dir, "usage-hourly.jsonl")).size;
    assert.ok(bytes < 1_000_000, `hourly state unexpectedly grew to ${bytes} bytes`);
    assert.ok(summaryMs < 5000, `summary stalled for ${summaryMs}ms`);
    console.log(JSON.stringify({ requests: 50000, conversations: 5000, addedMs: Math.round(addedMs), summaryMs: Math.round(summaryMs), persistedBytes: bytes }));
    assert.equal(new UsageHistory(path.join(dir, "usage-hourly.jsonl")).summary(START, START + HOUR).total.conversationTokens, result.total.conversationTokens);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
