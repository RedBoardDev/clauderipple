// Isolated tests for the phone's outbox (B05, B16). No browser: storage is a Map, the pairing
// fingerprint is a stub, and the app's decisions are the functions app.ts calls.
import test from "node:test";
import assert from "node:assert/strict";
import { autoSend, createSend, hostIdentity, loadOutbox, outboxKey, outboxStart, OUTBOX_KEY, refuse, requeue, tokenFingerprint, writable, writeOutbox } from "../web/outbox.ts";
import type { OutboxEntry, OutboxStore } from "../web/outbox.ts";
import { setLang } from "../web/i18n.ts";
import { reduce, timelineItems } from "../web/timeline.ts";
import { item as drawItem, ARCHIVE_KEY, HOME_PAGE } from "../web/views.ts";
import type { UI } from "../web/views.ts";

/** localStorage's two calls over a Map, standing in for one browser profile. */
function memory(): OutboxStore {
  const raw = new Map<string, string>();
  return { getItem: (key) => raw.get(key) ?? null, setItem: (key, value) => { raw.set(key, value); } };
}

const RELAY = "https://relay.example";
const pairing = (server: string, hpk = "host-key-a") => ({ url: RELAY, server, hpk });
/** A stand-in for the real (async) fingerprint: deterministic, and never the token itself. */
const fingerprint = async (token: string) => `stub-${[...token].reduce((h, c) => ((h * 31) + c.charCodeAt(0)) >>> 0, 7).toString(16)}`;

async function identityOf(relay: { url: string; server: string; hpk: string } | null, origin: string, token: string) {
  const identity = await hostIdentity({ relay, origin, token }, fingerprint);
  assert.ok(identity, "a pairing always names a computer here");
  return identity;
}

const message = (over: Partial<OutboxEntry> = {}): OutboxEntry => ({
  clientMsgId: "m-1", text: "결제 웹훅 재시도를 설계해 줘", at: 1_700_000_000_000, state: "pending", session: "s-1", ...over,
});

test("a relay host is named by relay, server id and the host key; a direct one by origin and a token fingerprint", async () => {
  const A = await identityOf(pairing("server-a"), RELAY, "token-a");
  assert.deepEqual(A, { kind: "relay", relay: RELAY, server: "server-a", key: "host-key-a" });
  const direct = await identityOf(null, "https://mac.example", "token-a");
  assert.deepEqual(direct, { kind: "direct", origin: "https://mac.example", fingerprint: await fingerprint("token-a") });
  // A relay pairing only routes when the page itself is on the relay; opened on the host's own
  // address the app connects straight to that origin, and that is the computer it names.
  assert.equal((await identityOf(pairing("server-a"), "https://mac.example", "token-a")).kind, "direct");
  assert.notEqual(outboxKey(A), outboxKey(await identityOf(pairing("server-b"), RELAY, "token-a")));
});

// B05: the bug was one shared rr.outbox, so the phone's next pairing sent the previous computer's
// unsent words to a host that happened to have the same session id.
test("a message queued for one computer is never read for the other, even with the same session id", async () => {
  const store = memory();
  const A = await identityOf(pairing("server-a"), RELAY, "token-a");
  const B = await identityOf(pairing("server-b"), RELAY, "token-b");
  assert.equal(writeOutbox(store, outboxKey(A), [message()]).ok, true);
  assert.deepEqual(loadOutbox(store, outboxKey(B)), { status: "empty" }, "nothing of A's is sent to B");
  // Coming back to A restores exactly what was written, in the person's own words.
  assert.deepEqual(loadOutbox(store, outboxKey(A)), { status: "ok", entries: [message()] });
});

test("A → B → A keeps each computer's outbox apart and loses nothing", async () => {
  const store = memory();
  const A = await identityOf(pairing("server-a"), RELAY, "token-a");
  const B = await identityOf(pairing("server-b"), RELAY, "token-b");
  writeOutbox(store, outboxKey(A), [message({ clientMsgId: "a-1" })]);
  writeOutbox(store, outboxKey(B), [message({ clientMsgId: "b-1", text: "B에서 쓰던 메시지" })]);
  const fromA = loadOutbox(store, outboxKey(A));
  const fromB = loadOutbox(store, outboxKey(B));
  assert.deepEqual(fromA.status === "ok" ? fromA.entries.map((e) => e.clientMsgId) : [], ["a-1"]);
  assert.deepEqual(fromB.status === "ok" ? fromB.entries.map((e) => [e.clientMsgId, e.text]) : [], [["b-1", "B에서 쓰던 메시지"]]);
});

// A reused server id or a replaced host config must not inherit the previous host's queue: the key
// from the pairing QR is what proves which computer answered.
test("one server id with another host key is another computer", async () => {
  const before = await identityOf(pairing("server-a", "host-key-a"), RELAY, "token-a");
  const after = await identityOf(pairing("server-a", "host-key-b"), RELAY, "token-a");
  assert.notEqual(outboxKey(before), outboxKey(after));
  const store = memory();
  writeOutbox(store, outboxKey(before), [message()]);
  assert.deepEqual(loadOutbox(store, outboxKey(after)), { status: "empty" });
});

test("a direct host is told apart by its token fingerprint, which is never the token", async () => {
  const one = await identityOf(null, "https://mac.example", "token-a");
  const two = await identityOf(null, "https://mac.example", "token-b");
  assert.notEqual(outboxKey(one), outboxKey(two), "a different token at one address is another pairing");
  const store = memory();
  writeOutbox(store, outboxKey(one), [message()]);
  assert.deepEqual(loadOutbox(store, outboxKey(two)), { status: "empty" });
  assert.ok(!outboxKey(one).includes("token-a"), "the pairing token itself never reaches the key");
});

test("without WebCrypto nothing is persisted, rather than guessing which computer this is", async () => {
  const failing = async (_token: string): Promise<string> => { throw new Error("no WebCrypto"); };
  assert.equal(await hostIdentity({ relay: null, origin: "http://mac.example", token: "t" }, failing), null);
  // A relay pairing needs no fingerprint, so it still names its computer.
  assert.ok(await hostIdentity({ relay: pairing("server-a"), origin: RELAY, token: "t" }, failing));
});

test("the real fingerprint is a hex digest, not the token", async () => {
  const fp = await tokenFingerprint("0123456789abcdef", globalThis.crypto.subtle);
  assert.match(fp, /^[0-9a-f]{64}$/);
  assert.ok(!fp.includes("0123456789abcdef"));
  assert.equal(fp, await tokenFingerprint("0123456789abcdef", globalThis.crypto.subtle), "stable for one token");
});

// Entries saved before hosts were told apart have no provenance. They are the person's words, so
// they must stay in storage; they must also never be sent, because which computer they were meant
// for cannot be known.
test("the pre-identity outbox is kept untouched and never read for sending", async () => {
  const store = memory();
  const legacy = JSON.stringify([message({ clientMsgId: "old-1", text: "예전에 쓰던 메시지", session: "s-1" })]);
  store.setItem(OUTBOX_KEY, legacy);
  for (const identity of [await identityOf(pairing("server-a"), RELAY, ""), await identityOf(pairing("server-b"), RELAY, ""), await identityOf(null, "https://mac.example", "t")]) {
    assert.notEqual(outboxKey(identity), OUTBOX_KEY);
    assert.deepEqual(loadOutbox(store, outboxKey(identity)), { status: "empty" });
  }
  writeOutbox(store, outboxKey(await identityOf(pairing("server-a"), RELAY, "")), [message({ clientMsgId: "new-1" })]);
  assert.equal(store.getItem(OUTBOX_KEY), legacy, "writing this computer's queue does not touch the old one");
});

test("a long message survives storage byte for byte, never summarized or cut", async () => {
  const store = memory();
  const key = outboxKey(await identityOf(pairing("server-a"), RELAY, "token-a"));
  const text = `첫 줄\n\n${"가".repeat(40_000)}\n${JSON.stringify({ nested: "값\"과 \\ 이스케이프" })}`;
  writeOutbox(store, key, [message({ text })]);
  const loaded = loadOutbox(store, key);
  assert.equal(loaded.status === "ok" ? loaded.entries[0]!.text : "", text);
});

// B05/B16: a stored value that cannot be read back whole is the person's words too. It stays where
// it is and is never written over; the app works from memory and says so.
test("an empty queue, a refused read and an unreadable list are told apart", () => {
  const store = memory();
  const key = "rr.outbox.direct:https://mac.example|fp:x";
  assert.deepEqual(loadOutbox(store, key), { status: "empty" });
  assert.equal(writable({ status: "empty" }), true);

  const throwing: OutboxStore = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.deepEqual(loadOutbox(throwing, key), { status: "unavailable" });
  assert.equal(writable({ status: "unavailable" }), false);

  store.setItem(key, "{not json");
  assert.deepEqual(loadOutbox(store, key), { status: "unreadable", raw: "{not json" });
  store.setItem(key, JSON.stringify({ entries: [] }));
  assert.equal(loadOutbox(store, key).status, "unreadable");
  assert.equal(writable({ status: "unreadable", raw: "" }), false);
});

test("one unreadable entry makes the whole list partial, which is never written over", () => {
  const store = memory();
  const key = "rr.outbox.relay:https://relay.example|server-a|host-key-a";
  const raw = JSON.stringify([message(), { clientMsgId: "broken" }, "nope", { ...message(), clientMsgId: "m-2", state: "sent" }]);
  store.setItem(key, raw);
  const load = loadOutbox(store, key);
  assert.equal(load.status, "partial");
  assert.equal(load.status === "partial" ? load.raw : "", raw, "the stored text is carried out for a recovery view");
  assert.deepEqual(load.status === "partial" ? load.entries.map((e) => e.clientMsgId) : [], ["m-1"]);
  assert.equal(writable(load), false);
});

test("a write the browser refuses says so instead of pretending the message is kept", () => {
  const throwing: OutboxStore = {
    getItem: () => null,
    setItem: () => { const error = new Error("full"); error.name = "QuotaExceededError"; throw error; },
  };
  assert.deepEqual(writeOutbox(throwing, "k", [message()]), { ok: false, error: "QuotaExceededError" });
  assert.deepEqual(writeOutbox(memory(), "k", [message()]), { ok: true });
});

// B16: the host refusing a send used to delete the outbox entry, and with it the words. The entry
// now stays, with the host's own reason, and does not leave again on its own.
test("a refused send keeps its words and id, and waits for the person", () => {
  const after = refuse([message()], "m-1", "send", "no such session");
  assert.equal(after[0]!.text, "결제 웹훅 재시도를 설계해 줘");
  assert.equal(after[0]!.clientMsgId, "m-1", "the id is what makes a retry idempotent");
  assert.equal(after[0]!.error, "no such session");
  assert.equal(autoSend(after[0]!), false, "a refused message is not auto-sent again");
});

test("a refused create is kept and held: the host may already have saved its session", () => {
  const create = message({ clientMsgId: "c-1", session: null, create: { cwd: "/Users/me/code/app", model: "gpt-6.1-sol", effort: "high" } });
  const after = refuse([create], "c-1", "create", "not a folder: /Users/me/code/ap");
  assert.equal(after[0]!.error, "not a folder: /Users/me/code/ap");
  assert.deepEqual(after[0]!.create, { cwd: "/Users/me/code/app", model: "gpt-6.1-sol", effort: "high" });
  assert.equal(after[0]!.text, create.text);
  assert.equal(after[0]!.delivery, "held");
  assert.equal(after[0]!.hold, "maybe_created");
});

test("a refused send can simply be retried: it is kept with the host's words and not sent by itself", () => {
  const after = refuse([message()], "m-1", "send", "no such session");
  assert.equal(after[0]!.error, "no such session");
  assert.equal(after[0]!.delivery, "queued");
  assert.equal(autoSend(after[0]!), false);
});

test("host_updating goes back to queued so the reconnect after the update sends it", () => {
  const after = refuse([message({ state: "sending" })], "m-1", "host_updating", "호스트 업데이트 중입니다");
  assert.equal(after[0]!.state, "pending");
  assert.equal(after[0]!.error, undefined);
  assert.equal(after[0]!.delivery, "queued");
  assert.equal(autoSend(after[0]!), true);
});

test("outcome_unknown keeps the words and waits: nothing re-addresses it by itself", () => {
  const sending = [message({ state: "sending" })];
  const after = refuse(sending, "m-1", "outcome_unknown", "전송 결과를 확인할 수 없음");
  assert.notEqual(after, sending, "the entry is marked held, so a reload still holds it");
  assert.equal(after[0]!.clientMsgId, "m-1", "the id is what makes a same-id retry idempotent");
  assert.equal(after[0]!.text, sending[0]!.text);
  assert.equal(after[0]!.state, "sending");
  assert.equal(after[0]!.delivery, "held");
  assert.equal(after[0]!.hold, "unknown_outcome");
  assert.equal(autoSend(after[0]!), false);
});

test("a refusal never touches another message, and an unknown id changes nothing", () => {
  const entries = [message({ clientMsgId: "m-1" }), message({ clientMsgId: "m-2", text: "둘째" })];
  const after = refuse(entries, "m-2", "send", "세션이 중단되었습니다");
  assert.deepEqual(after[0], entries[0]);
  assert.equal(after[1]!.error, "세션이 중단되었습니다");
  assert.equal(refuse(entries, "m-9", "send", "x"), entries);
});

test("retrying a refused or held message reuses its id and rejoins the normal queue", () => {
  const refused = refuse([message()], "m-1", "send", "no such session");
  const again = requeue(refused, "m-1");
  assert.equal(again[0]!.clientMsgId, "m-1", "same id: the host acknowledges a repeat instead of running twice");
  assert.equal(again[0]!.state, "pending");
  assert.equal(again[0]!.error, undefined);
  assert.equal(again[0]!.delivery, "queued");
  assert.equal(autoSend(again[0]!), true);
  assert.equal(requeue(again, "m-1"), again, "retrying a message that was not refused changes nothing");
  assert.equal(requeue(refused, "other"), refused);
  const held = refuse([message({ clientMsgId: "h-1", state: "sending" })], "h-1", "outcome_unknown", "x");
  assert.equal(requeue(held, "h-1")[0]!.delivery, "queued", "a same-id retry is allowed for a held message too");
  assert.equal(requeue(held, "h-1")[0]!.hold, undefined);
});

// B16: a send from a screen that is still waiting on its create. Same words keep the id (a retry
// cannot start a second session); edited words are a new message only when nothing can have run;
// anything that may already have run is held for the person.
test("same words keep the create's id, edited words get a new one when nothing was sent", () => {
  let n = 0;
  const newId = () => `new-${++n}`;
  const queued = message({ clientMsgId: "c-1", session: null, text: "테스트 고쳐 줘" });
  assert.deepEqual(createSend(queued, "테스트 고쳐 줘", newId), { kind: "retry", clientMsgId: "c-1" });
  assert.deepEqual(createSend(queued, "  테스트 고쳐 줘  ", newId), { kind: "retry", clientMsgId: "c-1" }, "whitespace is not an edit");
  assert.deepEqual(createSend(queued, "테스트 고치고 커밋해 줘", newId), { kind: "new", clientMsgId: "new-1" });
  assert.deepEqual(createSend(undefined, "첫 지시", newId), { kind: "new", clientMsgId: "new-2" });
});

// The host saves a session and appends its first events before it hands the text to the SDK
// (sessions.ts createNew), so a refused create is not proof no session exists: a new id could start
// a second one, and the same id with other words would drop them (the host answers a repeated
// create id with the session it already has). The person decides, with the retry still on screen.
test("edited words after a refusal are held, not re-addressed and not overwritten", () => {
  const newId = () => "new-1";
  const refused = message({ clientMsgId: "c-1", session: null, text: "테스트 고쳐 줘", error: "not a folder: /nope" });
  assert.deepEqual(createSend(refused, "테스트 고쳐 줘", newId), { kind: "retry", clientMsgId: "c-1" });
  assert.deepEqual(createSend(refused, "다른 지시", newId), { kind: "held" });
});

test("a create the host sent back as updating may be edited and re-addressed: it never ran", () => {
  const newId = () => "new-1";
  // host_updating clears the refusal, because the host answered before running anything.
  const updating = refuse([message({ clientMsgId: "c-1", session: null, text: "테스트 고쳐 줘", state: "sending" })], "c-1", "host_updating", "호스트 업데이트 중입니다");
  assert.equal(updating[0]!.error, undefined);
  assert.deepEqual(createSend(updating[0], "테스트 고치고 커밋해 줘", newId), { kind: "new", clientMsgId: "new-1" });
});

test("a create that may already have run is held for the person, not reused", () => {
  const newId = () => "new-1";
  const sending = message({ clientMsgId: "c-1", session: null, state: "sending", text: "테스트 고쳐 줘" });
  assert.deepEqual(createSend(sending, "테스트 고쳐 줘", newId), { kind: "retry", clientMsgId: "c-1" }, "the same words under the same id cannot run twice");
  assert.deepEqual(createSend(sending, "다른 지시", newId), { kind: "held" });
});

test("what start() holds for a pairing: key, messages, whether it may write, what to say", async () => {
  const store = memory();
  const key = outboxKey(await identityOf(pairing("server-a"), RELAY, "token-a"));
  assert.deepEqual(outboxStart(null, store), { key: null, entries: [], writable: false, notice: "no-identity" });
  assert.deepEqual(outboxStart(await identityOf(pairing("server-b"), RELAY, "token-b"), store), { key: outboxKey(await identityOf(pairing("server-b"), RELAY, "token-b")), entries: [], writable: true, notice: null });
  writeOutbox(store, key, [message()]);
  const ok = outboxStart(await identityOf(pairing("server-a"), RELAY, "token-a"), store);
  assert.equal(ok.writable, true);
  assert.equal(ok.notice, null);
  assert.deepEqual(ok.entries, [message()]);
  store.setItem(key, JSON.stringify([message(), { clientMsgId: "broken" }]));
  const partial = outboxStart(await identityOf(pairing("server-a"), RELAY, "token-a"), store);
  assert.deepEqual([partial.writable, partial.notice, partial.entries.length], [false, "partial", 1]);
  store.setItem(key, "garbage");
  assert.equal(outboxStart(await identityOf(pairing("server-a"), RELAY, "token-a"), store).notice, "unreadable");
  const throwing: OutboxStore = { getItem: () => { throw new Error("blocked"); }, setItem: () => undefined };
  assert.equal(outboxStart(await identityOf(pairing("server-a"), RELAY, "token-a"), throwing).notice, "unavailable");
});

// The words saved before this split are the only copy of those messages: nothing here may delete or
// rewrite them, whatever the phone does for its current computer.
test("writes for any number of computers leave the old shared outbox byte for byte", async () => {
  const store = memory();
  const legacy = JSON.stringify([message({ clientMsgId: "old-1", text: "예전에 쓰던 메시지" })]);
  store.setItem(OUTBOX_KEY, legacy);
  const A = await identityOf(pairing("server-a"), RELAY, "token-a");
  const B = await identityOf(null, "https://mac.example", "token-b");
  writeOutbox(store, outboxKey(A), [message({ clientMsgId: "a-1" })]);
  assert.equal(store.getItem(OUTBOX_KEY), legacy);
  writeOutbox(store, outboxKey(A), []);
  writeOutbox(store, outboxKey(B), [message({ clientMsgId: "b-1" })]);
  assert.equal(store.getItem(OUTBOX_KEY), legacy);
  assert.equal(loadOutbox(store, outboxKey(B)).status, "ok");
});

test("what is refused is written down, so a reload still shows it instead of dropping it", async () => {
  const store = memory();
  const key = outboxKey(await identityOf(pairing("server-a"), RELAY, "token-a"));
  writeOutbox(store, key, refuse([message()], "m-1", "send", "no such session"));
  const loaded = loadOutbox(store, key);
  assert.equal(loaded.status, "ok");
  const entry = loaded.status === "ok" ? loaded.entries[0]! : undefined;
  assert.equal(entry?.error, "no such session");
  assert.equal(entry?.text, "결제 웹훅 재시도를 설계해 줘");
});

// What the person sees for B16: their whole message, the host's own reason, and a control that acts
// on that entry's id (retry keeps the id).
function ui(): UI {
  return {
    now: 0, link: { state: "open", attempt: 0, nextAt: null, lastRx: 0, downSince: null }, host: null, home: undefined,
    sessions: [], models: [], sheet: null, draft: { cwd: null, model: null, effort: null },
    expanded: new Map(), workersOpen: false, permOpen: new Set(), toast: null,
    pins: [], folded: [ARCHIVE_KEY], query: "", homeLimit: HOME_PAGE,
  };
}

test("a refused message is drawn with its words, the host's reason and a retry that keeps its id", () => {
  setLang("ko");
  const text = `줄 하나\n${"가".repeat(4_000)}`;
  const [row] = timelineItems(reduce([], refuse([message({ text })], "m-1", "send", "세션이 중단되었습니다")));
  assert.equal(row?.type, "user");
  const html = drawItem(row!, ui());
  assert.ok(html.includes(text), "the whole message is drawn, not a summary of it");
  assert.ok(html.includes("세션이 중단되었습니다"), "the reason is the host's own words");
  assert.ok(html.includes('data-act="retry-send" data-id="m-1"'), "retry sends the same id again");
  assert.ok(html.includes('data-act="edit-send" data-id="m-1"'));
  assert.ok(html.includes('aria-label="메시지 수정"'), "the edit control is named for what it does");
  assert.ok(!html.includes("이어서 입력"), "and never with the reply copy");
  assert.ok(!html.includes("보내는 중"), "a refused message is not drawn as on its way");
});

test("a message still on its way keeps the existing queue wording", () => {
  setLang("ko");
  for (const state of ["pending", "sending"] as const) {
    const [row] = timelineItems(reduce([], [message({ state })]));
    const html = drawItem(row!, ui());
    assert.ok(html.includes(state === "pending" ? "연결 시 전송" : "보내는 중"), state);
    assert.ok(!html.includes('data-act="retry-send"'));
  }
});
