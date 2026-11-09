// The "미전송함" the person can open for what was saved before: reading, copying and choosing a copy
// into this computer's queue (B05/B16). These are the decisions app.ts makes, one function call
// each, over the same storage shape the browser gives (getItem/setItem/keys).
import test from "node:test";
import assert from "node:assert/strict";
import {
  adopt, autoSend, autoSendable, createSend, hostIdentity, loadOutbox, outboxKey, outboxStart, OUTBOX_KEY, preserved, refuse, writeOutbox,
} from "../web/outbox.ts";
import type { OutboxEntry, OutboxStore, PreservedItem } from "../web/outbox.ts";
import { setLang } from "../web/i18n.ts";
import { recoveryCard as homeCard, sheet as drawSheet } from "../web/views.ts";
import type { Sheet, UI } from "../web/views.ts";

/** One browser origin: localStorage as the app sees it. */
function memory(): OutboxStore & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    getItem: (key) => raw.get(key) ?? null,
    setItem: (key, value) => { raw.set(key, value); },
    keys: () => [...raw.keys()],
  };
}

const RELAY = "https://relay.example";
const pairing = (server: string, hpk = "host-key-a") => ({ url: RELAY, server, hpk });
const fingerprint = async (token: string) => `stub-${token.length}-${token.slice(-1)}`;
const identity = async (server: string, hpk = "host-key-a") => {
  const found = await hostIdentity({ relay: pairing(server, hpk), origin: RELAY, token: "token" }, fingerprint);
  assert.ok(found);
  return found;
};
const entry = (over: Partial<OutboxEntry> = {}): OutboxEntry => ({
  clientMsgId: "m-1", text: "결제 웹훅 재시도를 설계해 줘", at: 1_700_000_000_000, state: "pending", session: "s-1", ...over,
});

// 1. What starts up when the stored value is damaged: the app says so, writes nothing over it, and
//    the sheet can still show the exact stored text.
test("a damaged queue is reported, never overwritten, and its raw text is reachable", async () => {
  const store = memory();
  const key = outboxKey(await identity("server-a"));
  store.setItem(key, "[{\"clientMsgId\":\"gone\"");
  const started = outboxStart(await identity("server-a"), store);
  assert.deepEqual([started.writable, started.entries, started.notice], [false, [], "unreadable"]);
  // The app keeps working from memory but cannot persist, so nothing is sent by itself.
  assert.deepEqual(autoSendable([entry()], started.writable), []);
  // The app reads its own bucket separately to show that raw text; `preserved` is for the others.
  const kept = preserved(store, key, []);
  assert.deepEqual([kept.status, kept.items, kept.raw], ["ok", [], []]);
  const own = loadOutbox(store, key);
  assert.equal(own.status, "unreadable");
  assert.equal(own.status === "unreadable" ? own.raw : "", "[{\"clientMsgId\":\"gone\"");
  assert.equal(store.getItem(key), "[{\"clientMsgId\":\"gone\"", "the stored bytes are untouched");
  assert.equal(loadOutbox(store, key).status, "unreadable", "after a reload they are still untouched");
  assert.equal(store.getItem(key), "[{\"clientMsgId\":\"gone\"");
});

// 2. The list before any pairing (rr.outbox) is the oldest case: readable, but of unknown
//    provenance, so it is offered for reading/copying and never sent from here.
test("the pre-identity list is offered as preserved messages and is never sent", async () => {
  const store = memory();
  const current = outboxKey(await identity("server-a"));
  writeOutbox(store, OUTBOX_KEY, [entry({ clientMsgId: "old-1", text: "예전에 쓰던 지시" })]);
  const kept = preserved(store, current, []);
  assert.deepEqual(kept.items.map((item) => [item.entry.clientMsgId, item.entry.text]), [["old-1", "예전에 쓰던 지시"]]);
  const [copy] = adopt([], kept.items.map((item) => item.entry)).entries;
  assert.equal(copy?.delivery, "recovered");
  assert.equal(autoSend(copy!), false, "a preserved message is never sent unless the person sends it");
  assert.equal(store.getItem(OUTBOX_KEY) !== null, true, "the original stays where it was");
});

// 3. A replaced host key leaves a whole bucket behind: it must be findable, and the computer it
//    belonged to must never be able to receive this computer's queue.
test("a bucket left by a replaced host key is listed, and only as a source of copies", async () => {
  const store = memory();
  const before = outboxKey(await identity("server-a", "host-key-old"));
  const after = outboxKey(await identity("server-a", "host-key-new"));
  writeOutbox(store, before, [entry({ clientMsgId: "orphan-1" })]);
  writeOutbox(store, after, [entry({ clientMsgId: "mine-1" })]);
  const started = outboxStart(await identity("server-a", "host-key-new"), store);
  assert.deepEqual(started.entries.map((e) => e.clientMsgId), ["mine-1"], "the new key's own queue");
  const kept = preserved(store, after, started.entries);
  assert.deepEqual(kept.items.map((item) => item.entry.clientMsgId), ["orphan-1"]);
  const { entries, added, conflicts } = adopt(started.entries, kept.items.map((item) => item.entry));
  assert.deepEqual([added, conflicts.length], [1, 0]);
  const copy = entries.find((e) => e.clientMsgId === "orphan-1")!;
  assert.equal(copy.session, null, "a session id from the other bucket is never adopted");
  assert.equal(copy.delivery, "recovered");
  assert.deepEqual(autoSendable(entries, true).map((e) => e.clientMsgId), ["mine-1"], "only the queued one may go on its own");
  assert.ok(!kept.items[0]!.key.includes("server"), "the handle says nothing about the bucket");
});

// 4. Two buckets can hold the same id with different words. They are two separate choices with two
//    handles, and a copy never takes the other one's text.
test("same id, different words: separate items, separate copies", () => {
  const store = memory();
  writeOutbox(store, `${OUTBOX_KEY}.relay:https://relay.example|server-a|host-key-a`, [entry({ text: "가 쪽 본문" })]);
  writeOutbox(store, `${OUTBOX_KEY}.relay:https://relay.example|server-b|host-key-b`, [entry({ text: "나 쪽 본문" })]);
  const kept = preserved(store, "rr.outbox.direct:https://elsewhere|stub", []);
  assert.equal(kept.items.length, 2, "both texts are offered");
  const [first, second] = kept.items;
  assert.ok(first && second);
  assert.notEqual(first.key, second.key, "each item is its own handle");
  assert.deepEqual([first.entry.text, second.entry.text], ["가 쪽 본문", "나 쪽 본문"]);
  const picked = adopt([], [second.entry]);
  assert.deepEqual(picked.entries.map((e) => [e.clientMsgId, e.text]), [["m-1", "나 쪽 본문"]], "the chosen one, never the first");
});

test("a current message id never hides different preserved words from the recovery screen", () => {
  const store = memory();
  const original = entry({ text: "다른 컴퓨터에 남긴 원문" });
  writeOutbox(store, OUTBOX_KEY, [original]);
  const current = [entry({ text: "현재 컴퓨터의 별도 원문" })];
  const kept = preserved(store, "rr.outbox.current", current);
  assert.deepEqual(kept.items.map(item => item.entry.text), [original.text]);
  assert.deepEqual(adopt(current, kept.items.map(item => item.entry)).conflicts, [original]);
  assert.deepEqual(preserved(store, "rr.outbox.current", [original]).items, [], "only an identical copy is hidden");
});

test("the same id and the same words in two buckets is one item", () => {
  const store = memory();
  writeOutbox(store, `${OUTBOX_KEY}.relay:https://relay.example|server-a|host-key-a`, [entry()]);
  writeOutbox(store, `${OUTBOX_KEY}.relay:https://relay.example|server-b|host-key-b`, [entry()]);
  assert.equal(preserved(store, "rr.outbox.direct:https://elsewhere|stub", []).items.length, 1);
});

// 5. A copy whose id already waits here is never doubled; a copy whose id waits here with other
//    words is a conflict, and nothing is imported over either text.
test("a repeated import adds nothing, and a conflicting id imports nothing at all", () => {
  const waiting = [entry({ clientMsgId: "mine-1", text: "원래 여기 있던 지시" })];
  const same = adopt(waiting, [entry({ clientMsgId: "mine-1", text: "원래 여기 있던 지시" })]);
  assert.deepEqual([same.added, same.conflicts.length], [0, 0], "same words: already here");
  const twice = adopt(adopt(waiting, [entry({ clientMsgId: "p-1" })]).entries, [entry({ clientMsgId: "p-1" })]);
  assert.equal(twice.added, 0);
  const clash = adopt(waiting, [entry({ clientMsgId: "mine-1", text: "다른 본문" }), entry({ clientMsgId: "p-1" })]);
  assert.deepEqual(clash.conflicts.map((e) => e.text), ["다른 본문"], "the conflict is reported, not silently preferred");
  assert.equal(clash.entries.some((e) => e.text === "다른 본문"), false, "nothing overwrites the waiting message");
});

test("an imported create keeps its folder and model, so it can be sent here on purpose", () => {
  const create = entry({ clientMsgId: "c-1", session: null, create: { cwd: "/Users/me/code/app", model: "gpt-6.1-sol", effort: "high" } });
  const [copy] = adopt([], [create]).entries;
  assert.deepEqual(copy?.create, { cwd: "/Users/me/code/app", model: "gpt-6.1-sol", effort: "high" });
  assert.equal(copy?.delivery, "recovered");
});

// 6. After an import the messages survive a reload as recovered, and still nothing sends them.
test("recovered messages are still waiting, not sent, after a reload", async () => {
  const store = memory();
  const key = outboxKey(await identity("server-a"));
  const kept = adopt([], [entry({ clientMsgId: "p-1" })]).entries;
  assert.equal(writeOutbox(store, key, kept).ok, true);
  const reloaded = outboxStart(await identity("server-a"), store);
  assert.deepEqual(reloaded.entries.map((e) => [e.clientMsgId, e.delivery]), [["p-1", "recovered"]]);
  assert.deepEqual(autoSendable(reloaded.entries, true), [], "a reconnect sends nothing imported");
  assert.deepEqual(autoSendable(reloaded.entries, false), [], "and nothing at all when storage is not keeping");
});

// 7. Editing a refused create: the host may have saved the session, so the words are held.
test("editing a refused create is held with a reason the sheet can show", () => {
  const refused = refuse([entry({ clientMsgId: "c-1", session: null, text: "테스트 고쳐 줘" })], "c-1", "create", "not a folder: /nope");
  assert.equal(refused[0]!.delivery, "held");
  assert.equal(refused[0]!.hold, "maybe_created");
  assert.deepEqual(createSend(refused[0], "다른 지시", () => "new-1"), { kind: "held" });
  assert.deepEqual(createSend(refused[0], "테스트 고쳐 줘", () => "new-1"), { kind: "retry", clientMsgId: "c-1" });
});

// 8. Enumeration itself failing is reported, not hidden behind an empty list.
test("a browser that cannot list its own keys says storage is unavailable", () => {
  const blocked: OutboxStore = { getItem: () => null, setItem: () => undefined, keys: () => { throw new Error("blocked"); } };
  assert.deepEqual(preserved(blocked, null), { status: "unavailable", items: [], raw: [] });
  const noList: OutboxStore = { getItem: () => null, setItem: () => undefined };
  assert.equal(preserved(noList, null).status, "unavailable");
});

// The sheet itself: full words (no truncation), the approved wording, and a host name that is text.
function ui(sheet: Sheet | null): UI {
  return {
    now: 1_700_000_100_000, link: { state: "open", attempt: 0, nextAt: null, lastRx: 0, downSince: null },
    host: { name: "<img src=x onerror=alert(1)>", version: "t", routerOk: true }, home: undefined,
    sessions: [], models: [], sheet, draft: { cwd: null, model: null, effort: null },
    expanded: new Map(), workersOpen: false, permOpen: new Set(), toast: null,
    pins: [], folded: ["archive"], query: "", homeLimit: 40,
  };
}

const item = (over: Partial<OutboxEntry> = {}, key = "k-1"): PreservedItem => ({ key, entry: entry(over) });

const recoverySheet = (over: Partial<Extract<Sheet, { kind: "recovery" }>> = {}): Sheet => ({
  kind: "recovery", step: "list", candidates: [], recovered: [], held: [], raw: [], picked: new Set(), shown: null, unavailable: false, ...over,
});

test("the sheet shows kept messages whole, with their reasons", () => {
  setLang("ko");
  const text = `줄 하나\n${"가".repeat(2_000)}`;
  const html = drawSheet(ui(recoverySheet({
    candidates: [item({ clientMsgId: "p-1", text }, "handle-1")],
    recovered: [entry({ clientMsgId: "r-1", text: "가져온 메시지", delivery: "recovered" })],
    held: [entry({ clientMsgId: "h-1", text: "결과 미확인 메시지", delivery: "held", hold: "unknown_outcome" })],
    raw: ["{broken"],
  })));
  assert.ok(html.includes(text), "the whole message is on screen, not a shortened row");
  assert.ok(html.includes("보관된 미전송 메시지"));
  assert.ok(html.includes("가져온 메시지는 직접 전송하기 전까지 미전송함에 보관됩니다."));
  assert.ok(html.includes("요청 처리 결과를 확인할 수 없습니다."));
  assert.ok(html.includes("저장된 미전송함을 읽지 못했습니다."));
  assert.ok(html.includes('data-act="recovery-pick" data-id="handle-1"'), "selection is by the opaque handle");
  assert.ok(html.includes('data-act="recovery-copy" data-id="handle-1"'), "a preserved original remains copyable even when its id conflicts");
  assert.ok(!html.includes('data-act="recovery-pick" data-id="p-1"'), "never by the message id, which two buckets can share");
  assert.ok(!html.includes("{broken"), "the raw value is shown only when asked for");
});

test("the confirmation names the host as text, even when its name is markup", () => {
  setLang("ko");
  const html = drawSheet(ui(recoverySheet({ step: "confirm", candidates: [item()], picked: new Set(["k-1"]) })));
  assert.ok(html.includes("선택한 메시지를 &lt;img src=x onerror=alert(1)&gt;의 미전송함에 복사합니다."), "host name is escaped, no template left");
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("원본은 유지되며 자동으로 전송되지 않습니다."));
  assert.ok(html.includes("가져온 메시지는 직접 전송하기 전까지 미전송함에 보관됩니다."));
  assert.ok(html.includes('data-act="recovery-import"'));
});

test("the raw text is shown when the person asks, whole and escaped", () => {
  setLang("ko");
  const raw = `[{"text":"${"나".repeat(500)}","html":"<b>x</b>"`;
  const hidden = drawSheet(ui(recoverySheet({ raw: [raw] })));
  assert.ok(!hidden.includes("&lt;b&gt;x&lt;/b&gt;"));
  const shown = drawSheet(ui(recoverySheet({ raw: [raw], shown: 0 })));
  assert.ok(shown.includes("&lt;b&gt;x&lt;/b&gt;"), "the stored text is shown as text, escaped");
  assert.ok(shown.includes("나".repeat(500)), "and it is not cut");
});

test("storage that cannot be reached is said plainly in the sheet", () => {
  setLang("ko");
  const html = drawSheet(ui(recoverySheet({ unavailable: true })));
  assert.ok(html.includes("저장소에 접근할 수 없습니다."));
  assert.ok(!html.includes('data-act="recovery-import"'), "there is nothing to import from");
});

test("the home card appears only while something is kept, and counts it", () => {
  setLang("ko");
  const bare = ui(null);
  assert.equal(homeCard(bare), "", "nothing kept: no card");
  assert.ok(homeCard({ ...bare, recovery: { messages: 2, raw: 1, unavailable: false } }).includes("보관된 미전송 메시지"));
  assert.ok(homeCard({ ...bare, recovery: { messages: 2, raw: 1, unavailable: false } }).includes("3건 대기"));
  assert.ok(homeCard({ ...bare, recovery: { messages: 0, raw: 0, unavailable: true } }).includes("저장소에 접근할 수 없습니다."));
});

test("importing is offered only once something is chosen", () => {
  setLang("ko");
  const none = drawSheet(ui(recoverySheet({ candidates: [item()] })));
  assert.ok(none.includes('data-act="recovery-import" disabled'), "nothing picked: no import");
  const picked = drawSheet(ui(recoverySheet({ candidates: [item()], picked: new Set(["k-1"]) })));
  assert.ok(!picked.includes('data-act="recovery-import" disabled'));
});
