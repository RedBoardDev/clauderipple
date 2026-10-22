// The phone's link and timeline, run in Node with a fake socket and a fake clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { backoff, Link, READY_MS } from "../web/conn.ts";
import type { SocketLike } from "../web/conn.ts";
import { dictionaries } from "../web/i18n.ts";
import { markdown } from "../web/md.ts";
import { pushAvailability } from "../web/pushstate.ts";
import { mergeEvents, reduce } from "../web/timeline.ts";
import { BACKOFF_CAP_MS, PING_MS, STALE_MS } from "../src/protocol.ts";
import type { EventBody, SessionEvent } from "../src/protocol.ts";

test("quoted paragraphs, line breaks, lists and code keep their structure", () => {
  assert.equal(markdown("> First line\n> Second line\n>\n> 1. First\n>    continuation\n> 2. Second\n>\n> ```\n> a\n> b\n> ```"),
    '<blockquote><p>First line<br>Second line</p><ol><li>First<br>continuation</li><li>Second</li></ol><pre class="md-code"><code>a\nb</code></pre></blockquote>');
  assert.equal(markdown("one\ntwo\n\n- alpha\n- beta"), '<p>one<br>two</p><ul><li>alpha</li><li>beta</li></ul>');
  assert.equal(markdown("<script>bad</script>"), '<p>&lt;script&gt;bad&lt;/script&gt;</p>');
});

class Clock {
  now = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private next = 1;
  set = (fn: () => void, ms: number): number => { const id = this.next++; this.timers.push({ at: this.now + ms, fn, id }); return id; };
  clear = (id: unknown): void => { this.timers = this.timers.filter((t) => t.id !== id); };
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const t = this.timers[0];
      if (!t || t.at > end) break;
      this.timers.shift();
      this.now = t.at;
      t.fn();
    }
    this.now = end;
  }
}

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(data: string): void { this.sent.push(data); }
  close(): void { if (this.closed) return; this.closed = true; this.onclose?.({}); }
  open(): void { this.readyState = 1; this.onopen?.({}); }
  recv(msg: unknown): void { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

function setup(online = { value: true }) {
  const clock = new Clock();
  const sockets: FakeSocket[] = [];
  const link = new Link({
    url: "ws://h/ws", token: "tok", clientId: "c",
    makeSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    now: () => clock.now, setTimer: clock.set, clearTimer: clock.clear, isOnline: () => online.value,
  });
  let readies = 0;
  link.onReady = () => { readies++; };
  return { clock, sockets, link, readies: () => readies };
}

const ready = { t: "ready", host: { name: "m", version: "0", routerOk: true }, sessions: [] };

test("backoff is attempt × 1 s, capped at 30 s, never zero", () => {
  assert.equal(backoff(0), 1000);
  assert.equal(backoff(3), 3000);
  assert.equal(backoff(1000), BACKOFF_CAP_MS);
});

test("hello carries the token; ready opens the link", () => {
  const { sockets, link, readies } = setup();
  link.start();
  sockets[0]!.open();
  assert.deepEqual(JSON.parse(sockets[0]!.sent[0]!), { t: "hello", token: "tok", clientId: "c" });
  sockets[0]!.recv(ready);
  assert.equal(link.status.state, "open");
  assert.equal(readies(), 1);
});

test("a dropped link retries forever with capped backoff and recovers", () => {
  const { clock, sockets, link, readies } = setup();
  link.start();
  for (let i = 0; i < 60; i++) {
    sockets[sockets.length - 1]!.close();
    assert.equal(link.status.state, "waiting");
    const wait = link.status.nextAt! - clock.now;
    assert.ok(wait > 0 && wait <= BACKOFF_CAP_MS);
    clock.advance(wait);
  }
  assert.equal(sockets.length, 61, "one new socket per attempt, none skipped");
  assert.ok(link.status.downSince !== null);
  sockets[60]!.open();
  sockets[60]!.recv(ready);
  assert.equal(link.status.state, "open");
  assert.equal(link.status.attempt, 0);
  assert.equal(link.status.downSince, null);
  assert.equal(readies(), 1);
});

test("a half-open socket is dropped by the app-level ping after STALE_MS of silence", () => {
  const { clock, sockets, link } = setup();
  link.start();
  sockets[0]!.open();
  sockets[0]!.recv(ready);
  clock.advance(PING_MS);
  assert.ok(sockets[0]!.sent.some((s) => JSON.parse(s).t === "ping"));
  clock.advance(STALE_MS - PING_MS);
  assert.equal(sockets[0]!.closed, false, "not stale at exactly 30 s");
  clock.advance(PING_MS);
  assert.equal(sockets[0]!.closed, true);
  assert.equal(link.status.state, "waiting");
  clock.advance(1000);
  assert.equal(sockets.length, 2);
});

test("a connect that never opens nor closes is abandoned after READY_MS and retried", () => {
  const { clock, sockets, link } = setup();
  link.start();
  clock.advance(READY_MS + 1);
  assert.equal(sockets[0]!.closed, true);
  assert.equal(link.status.state, "waiting");
  clock.advance(1000);
  assert.equal(sockets.length, 2);
});

test("pongs keep a quiet link alive", () => {
  const { clock, sockets, link } = setup();
  link.start();
  sockets[0]!.open();
  sockets[0]!.recv(ready);
  for (let i = 0; i < 10; i++) { clock.advance(PING_MS); sockets[0]!.recv({ t: "pong", n: i }); }
  assert.equal(sockets[0]!.closed, false);
  assert.equal(link.status.state, "open");
});

test("a socket that opens but never says ready is abandoned after READY_MS", () => {
  const { clock, sockets, link } = setup();
  link.start();
  sockets[0]!.open();
  clock.advance(READY_MS + 1);
  assert.equal(sockets[0]!.closed, true);
  assert.equal(link.status.state, "waiting");
});

test("a refused token stops retrying and says so", () => {
  const { clock, sockets, link } = setup();
  link.start();
  sockets[0]!.open();
  sockets[0]!.recv({ t: "denied", reason: "token" });
  assert.equal(link.status.state, "denied");
  clock.advance(10 * BACKOFF_CAP_MS);
  assert.equal(sockets.length, 1);
  link.nudge();
  assert.equal(sockets.length, 1);
});

test("offline waits without opening sockets, and nudge reconnects at once when back", () => {
  const online = { value: false };
  const { clock, sockets, link } = setup(online);
  link.start();
  assert.equal(link.status.state, "offline");
  clock.advance(5000);
  assert.equal(sockets.length, 0);
  online.value = true;
  link.nudge();
  assert.equal(sockets.length, 1);
  assert.equal(link.status.state, "connecting");
});

test("send() refuses while not open, so the outbox keeps the message", () => {
  const { sockets, link } = setup();
  link.start();
  assert.equal(link.send({ t: "ping", n: 1 }), false);
  sockets[0]!.open();
  sockets[0]!.recv(ready);
  assert.equal(link.send({ t: "ping", n: 1 }), true);
});

// ---- timeline ---------------------------------------------------------------------------------

const ev = (bodies: EventBody[]): SessionEvent[] => bodies.map((b, i) => ({ ...b, seq: i + 1, at: i } as SessionEvent));

test("streamed deltas become one message, replaced by the final assistant event", () => {
  const events = ev([
    { kind: "user", text: "hi", clientMsgId: "c1" },
    { kind: "state", state: "running" },
    { kind: "delta", msg: "m", text: "Hel" },
    { kind: "delta", msg: "m", text: "lo" },
  ]);
  let v = reduce(events);
  const a = v.items.find((i) => i.type === "assistant");
  assert.ok(a && a.type === "assistant" && a.text === "Hello" && a.streaming);
  v = reduce([...events, ...ev([{ kind: "assistant", msg: "m", model: "x", text: "Hello!", tools: [{ id: "t", name: "Bash", summary: "ls" }] }]).map((e) => ({ ...e, seq: 5 })),
    { kind: "tool_result", toolUseId: "t", ok: false, text: "nope", seq: 6, at: 6 } as SessionEvent]);
  const items = v.items.filter((i) => i.type === "assistant");
  assert.equal(items.length, 1);
  assert.ok(items[0]!.type === "assistant" && items[0]!.text === "Hello!" && items[0]!.tools[0]!.result?.ok === false);
});

test("permissions: open until decided, then recorded with the decision", () => {
  const base = ev([{ kind: "permission", id: "p", tool: "Bash", title: "", summary: "ls", input: "ls", canAlways: false }]);
  assert.equal(reduce(base).open.length, 1);
  const decided = [...base, { kind: "permission_decided", id: "p", decision: "expired", reason: "host_restarted", seq: 2, at: 2 } as SessionEvent];
  const v = reduce(decided);
  assert.equal(v.open.length, 0);
  const p = v.items.find((i) => i.type === "permission");
  assert.ok(p && p.type === "permission" && p.decision === "expired" && p.reason === "host_restarted");
});

test("an unacknowledged message shows as queued until the host echoes it", () => {
  const events = ev([{ kind: "user", text: "a", clientMsgId: "c1" }]);
  const out = [{ clientMsgId: "c1", text: "a", at: 0, state: "sending" as const }, { clientMsgId: "c2", text: "b", at: 1, state: "pending" as const }];
  const users = reduce(events, out).items.filter((i) => i.type === "user");
  assert.equal(users.length, 2);
  assert.equal(users[0]!.type === "user" && users[0]!.queued, undefined);
  assert.equal(users[1]!.type === "user" && users[1]!.queued, "pending");
});

test("mergeEvents is idempotent over overlapping pages", () => {
  const all = ev(Array.from({ length: 10 }, (_, i): EventBody => ({ kind: "notice", code: "resumed", text: String(i) })));
  let held = mergeEvents([], all.slice(5));
  held = mergeEvents(held, all.slice(0, 7));
  held = mergeEvents(held, all.slice(3, 10));
  assert.deepEqual(held.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("every Korean key has an English twin and the same placeholders", () => {
  const ko = dictionaries.ko;
  const en = dictionaries.en;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ko).sort());
  const vars = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort();
  for (const k of Object.keys(ko) as (keyof typeof ko)[]) assert.deepEqual(vars(en[k]), vars(ko[k]), k);
});

test("notifications: what the phone can do decides the card — https first, then the iPhone Home Screen rule", () => {
  const base = { secure: true, hasServiceWorker: true, hasPush: true, ios: false, standalone: false, permission: "default" as const, subscribed: false };
  assert.equal(pushAvailability({ ...base, secure: false }), "insecure");
  assert.equal(pushAvailability({ ...base, ios: true, hasPush: false }), "install", "iOS Safari tab: add to Home Screen, not 'unsupported'");
  assert.equal(pushAvailability({ ...base, ios: true, standalone: true }), "off");
  assert.equal(pushAvailability({ ...base, hasPush: false }), "unsupported");
  assert.equal(pushAvailability({ ...base, permission: "denied" }), "denied");
  assert.equal(pushAvailability({ ...base, permission: "granted", subscribed: true }), "on");
  assert.equal(pushAvailability({ ...base, permission: "granted", subscribed: false }), "off", "granted but no subscription yet: offer the button");
});

test("a Mac session's working time runs from the person's last message, not from when the host saw it running", () => {
  // Measured 2026-10-13 on 클로드리플: the app said 50 min (from the 23:31 message), the phone 11 min (from the host's first poll).
  const events: SessionEvent[] = [
    { kind: "user", text: "first", clientMsgId: "a", seq: 1, at: 100 },
    { kind: "user", text: "second", clientMsgId: "b", seq: 2, at: 500 },
    { kind: "state", state: "running", seq: 3, at: 3000 },
    { kind: "state", state: "stopped", seq: 4, at: 4000 },
    { kind: "state", state: "running", seq: 5, at: 4100 },
  ];
  assert.equal(reduce(events).turnStartedAt, 500);
  const idle: SessionEvent[] = [...events, { kind: "state", state: "idle", seq: 6, at: 5000 }];
  assert.equal(reduce(idle).turnStartedAt, null);
  assert.equal(reduce([...idle, { kind: "state", state: "running", seq: 7, at: 6000 }]).turnStartedAt, 6000, "woken without a message: from when it started");
});

// Coming back from another app counted the time spent there as the computer's silence (Discord,
// 2026-10-22): the banner said "no answer for 4 minutes" the moment the app returned.
test("the time spent in the background does not count as the computer's silence", () => {
  const { clock, sockets, link } = setup();
  link.start();
  sockets[0]!.open();
  sockets[0]!.recv(ready);
  sockets[0]!.close();
  const lostAt = link.status.downSince!;
  clock.advance(4 * 60_000);
  link.foreground();
  assert.equal(link.status.downSince, lostAt + 4 * 60_000);
  sockets.at(-1)!.open();
  sockets.at(-1)!.recv(ready);
  assert.equal(link.status.downSince, null);
});
