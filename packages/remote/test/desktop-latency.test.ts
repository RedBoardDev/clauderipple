import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { bridgeFixture, bridgeId, line, tick } from "./bridge-fixture.ts";
import type { SessionEvent } from "../src/protocol.ts";

const answer = (id: string) => line({ type: "assistant", uuid: id, message: { model: "test", content: [{ type: "text", text: id }] } });
async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 1500;
  while (!predicate()) { assert.ok(performance.now() < deadline, "notification arrived before the 3 s poll"); await delay(10); }
}

test("accepted bridge send pushes running immediately and masks cached/eventually consistent idle", async t => {
  const f = bridgeFixture(t);
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.summaryOf(bridgeId)?.state, "idle");
  const calls = f.onSessions(), reads = f.stateReads();
  await f.sessions.send(bridgeId, "latency", "hello");
  assert.equal(f.sessions.summaryOf(bridgeId)?.state, "running");
  assert.equal(f.stateReads(), reads, "no poll needed to show running");
  assert.ok(f.onSessions() > calls);
  f.advance();
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.summaryOf(bridgeId)?.state, "running", "fresh but not yet consistent idle is masked too");
  f.advance();
  f.status("running");
  await f.sessions.pollDesktop();
  f.advance();
  f.status("idle");
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.summaryOf(bridgeId)?.state, "idle", "confirmed turn can finish normally");
});

test("an idle read started before the send cannot revert accepted running", async t => {
  let resolve!: (response: Response) => void;
  const f = bridgeFixture(t, { stateResponse: () => new Promise(r => { resolve = r; }) });
  const poll = f.sessions.pollDesktop();
  await tick();
  await f.sessions.send(bridgeId, "inflight", "hello");
  resolve(Response.json({ worker_status: "idle" }));
  await poll;
  assert.equal(f.sessions.summaryOf(bridgeId)?.state, "running");
  f.setNow(f.now() + 9001);
  assert.equal(f.sessions.summaryOf(bridgeId)?.state, "idle", "optimism is bounded");
});

test("another accepted bridge send never synthesizes idle or loses optimism on stream reconnect", async t => {
  let bodyless = false;
  const events: SessionEvent[] = [];
  const f = bridgeFixture(t, { streamBodyless: () => bodyless, onEvent: (_id, event) => events.push(event) });
  await f.sessions.pollDesktop();
  await f.sessions.send(bridgeId, "first", "hello");
  await tick();
  f.closeStream();
  // A terminal stream error marks the connection failed, so the next send reconnects it.
  bodyless = true;
  // Closing a healthy SSE stream itself reconnects internally; a bodyless reconnect is terminal.
  await delay(1050);
  f.advance();
  await f.sessions.pollDesktop();
  assert.equal(f.sessions.summaryOf(bridgeId)?.state, "running", "permission-stream reconnect preserves accepted running");
  events.length = 0;
  await f.sessions.send(bridgeId, "second", "hello again");
  await tick();
  assert.equal(f.sessions.summaryOf(bridgeId)?.state, "running");
  assert.equal(events.some(e => e.kind === "state" && e.state === "idle"), false);
});

test("failed bridge send leaves no optimistic running", async t => {
  const f = bridgeFixture(t, { failSend: true });
  await f.sessions.pollDesktop();
  await assert.rejects(async () => f.sessions.send(bridgeId, "failed", "hello"));
  assert.equal(f.sessions.summaryOf(bridgeId)?.state, "idle");
});

test("real fs.watch tails a bridge transcript without polling", async t => {
  const events: SessionEvent[] = [];
  const f = bridgeFixture(t, { onEvent: (_id, event) => events.push(event) });
  f.sessions.log(bridgeId);
  f.sessions.watchAttached(new Set([bridgeId]));
  const reads = f.stateReads();
  fs.appendFileSync(f.file, answer("watched"));
  await until(() => events.some(e => e.kind === "assistant" && e.msg === "watched"));
  assert.equal(f.stateReads(), reads);
  assert.equal(events.filter(e => e.kind === "assistant" && e.msg === "watched").length, 1);
});

test("detach closes watcher and cancels pending tail; polling still recovers missed lines", async t => {
  let changed = () => {}, closed = 0;
  const events: SessionEvent[] = [];
  const f = bridgeFixture(t, { watchTranscript: (_id, notify) => { changed = notify; return () => { closed++; }; }, onEvent: (_id, e) => events.push(e) });
  f.sessions.log(bridgeId);
  f.sessions.watchAttached(new Set([bridgeId]));
  fs.appendFileSync(f.file, answer("detached"));
  changed();
  f.sessions.watchAttached(new Set());
  assert.equal(closed, 1);
  changed();
  await delay(120);
  assert.equal(events.some(e => e.kind === "assistant" && e.msg === "detached"), false);
  await f.sessions.pollDesktop();
  assert.equal(events.some(e => e.kind === "assistant" && e.msg === "detached"), true);
});

test("watch failures fall back to polling; shutdown closes active watchers", async t => {
  let failed = (_error: unknown) => {}, closed = 0;
  const f = bridgeFixture(t, { watchTranscript: (_id, _notify, onError) => { failed = onError; return () => { closed++; }; } });
  f.sessions.log(bridgeId);
  f.sessions.watchAttached(new Set([bridgeId]));
  failed(new Error("unsupported watcher"));
  assert.equal(closed, 1);
  fs.appendFileSync(f.file, answer("fallback"));
  await f.sessions.pollDesktop();
  assert.ok(f.sessions.log(bridgeId).tail().events.some(e => e.kind === "assistant" && e.msg === "fallback"));
  f.sessions.shutdown();
  assert.equal(closed, 2, "poll retried a watcher and shutdown closed it");
});

test("a terminated bridge process closes its transcript watcher", async t => {
  let closed = 0;
  const f = bridgeFixture(t, { watchTranscript: () => () => { closed++; } });
  f.sessions.log(bridgeId);
  f.registry.clear();
  await f.sessions.pollDesktop();
  assert.equal(closed, 1);
  f.sessions.shutdown();
  assert.equal(closed, 1, "shutdown does not retain or close a terminated watch twice");
});

test("attached read-only desktop snapshots notify without polling and detach closes watcher", async t => {
  const events: SessionEvent[] = [];
  let changed = () => {}, closed = 0;
  const f = bridgeFixture(t, { registry: () => new Map(), watchTranscript: (_id, notify) => { changed = notify; return () => { closed++; }; }, onEvent: (_id, e) => events.push(e) });
  const before = f.sessions.log(bridgeId).epoch;
  f.sessions.watchAttached(new Set([bridgeId]));
  fs.appendFileSync(f.file, answer("tail-only"));
  changed();
  await until(() => events.some(e => e.kind === "assistant" && e.msg === "tail-only"));
  assert.notEqual(f.sessions.log(bridgeId).epoch, before);
  f.sessions.watchAttached(new Set());
  assert.equal(closed, 1);
});
