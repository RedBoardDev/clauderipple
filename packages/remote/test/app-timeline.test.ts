// The timeline's two edges, through the real App: the page before the oldest one the phone holds,
// and the place each conversation was left at. The browser under it is the shared stand-in from
// fake-dom.ts, so what a person would see is read back from the elements the app writes.
import test from "node:test";
import assert from "node:assert/strict";
import { Storage, contentRows, install } from "./fake-dom.ts";
import type { Element } from "./fake-dom.ts";

interface FakeLink { sent: Record<string, unknown>[]; send(message: unknown): boolean; stop(): void; nudge(): void }
/** The app's own surface, untyped on purpose: app.ts is browser code, checked by the web project. */
interface AppBoundary {
  go(screen: { name: "home" } | { name: "session"; id: string }): void;
  onHost(message: unknown): void;
  loadOlder(retry?: boolean): void;
  ui: { link: { state: string }; models: unknown[] };
  link: FakeLink;
  caches: Map<string, { scroll: "bottom" | { key: string; inset: number } | null; epoch: string | null; events: { seq: number; text: string }[]; hasOlder: boolean }>;
  /** Where the reader is: at the newest message, or reading above it. */
  pinned: boolean;
}
type AppCtor = new (status: unknown) => AppBoundary;
let AppClass: AppCtor | null = null;

const link = (): FakeLink => {
  const made: FakeLink = { sent: [], send(message) { made.sent.push(message as Record<string, unknown>); return true; }, stop() {}, nudge() {} };
  return made;
};

/** The app on a screen talking to no computer: the socket only records what the app says. The import
 * is untyped on purpose — app.ts is browser code, type-checked by the web project, not by this one. */
async function start(): Promise<AppBoundary> {
  if (AppClass === null) {
    const specifier = "../web/app.ts";
    AppClass = ((await import(specifier)) as { App: AppCtor }).App;
  }
  const app = new AppClass({ state: "open", attempt: 0, nextAt: null, lastRx: null, downSince: null });
  app.ui.models = [{ provider: "test", label: "Test", usable: true, models: [{ model: "m", name: "M", provider: "test", efforts: [], usable: true }] }];
  app.link = link();
  return app;
}

const event = (seq: number, body: Record<string, unknown>) => ({ seq, at: seq, ...body });
const words = (seq: number) => event(seq, { kind: "user", clientMsgId: `c${seq}`, text: `words ${seq}` });
const asks = (app: AppBoundary) => app.link.sent.filter(message => message.t === "history");

test("the oldest loaded page is asked for one at a time, and a page that failed offers its own retry", async () => {
  const browser = install(new Storage());
  const app = await start();
  app.go({ name: "session", id: "s1" });
  const tail = (hasOlder: boolean) => app.onHost({ t: "events", session: "s1", epoch: "e", events: [words(5)], more: false, tail: { hasOlder } });

  tail(false);
  app.loadOlder();
  assert.deepEqual(asks(app), [], "a fully loaded conversation asks for nothing older");

  tail(true);
  app.loadOlder();
  assert.equal(asks(app).length, 1, "reading to the top asks for the page before it");
  assert.equal(asks(app)[0]!.beforeSeq, 5, "for the page before the oldest event held");
  assert.match(browser.el("#older").innerHTML, /이전 대화 불러오는 중/, "the edge says the page is coming");

  // A second scroll to the top while the page is on its way asks nothing more.
  app.loadOlder();
  assert.equal(asks(app).length, 1, "one page at a time");

  // The host refuses it: the edge says so, and only the person's tap asks again.
  app.onHost({ t: "res", reqId: asks(app)[0]!.reqId, ok: false, error: "host_updating" });
  assert.match(browser.el("#older").innerHTML, /이전 대화를 불러오지 못했습니다/, "the failure is said plainly");
  assert.match(browser.el("#older").innerHTML, /data-act="older"/, "the retry is offered");
  app.loadOlder();
  assert.equal(asks(app).length, 1, "scrolling never retries a failed page by itself");
  app.loadOlder(true);
  assert.equal(asks(app).length, 2, "the person's retry asks again");

  // A page with nothing in it is the end of the conversation: nothing older is asked for again.
  app.onHost({ t: "history", session: "s1", reqId: asks(app)[1]!.reqId, events: [], hasOlder: true });
  assert.equal(browser.el("#older").hidden, true, "an empty page leaves no edge");
  app.loadOlder();
  assert.equal(asks(app).length, 2);
});

test("a new epoch tail replaces the old timeline and its older pages remain accessible", async () => {
  install(new Storage());
  const app = await start();
  app.go({ name: "session", id: "s1" });
  app.onHost({ t: "events", session: "s1", epoch: "old", events: [words(100)], more: false, tail: { hasOlder: false } });
  app.go({ name: "home" });
  app.go({ name: "session", id: "s1" });
  assert.deepEqual(app.link.sent.filter(message => message.t === "attach").at(-1), { t: "attach", session: "s1", epoch: "old", afterSeq: 100 });

  app.onHost({ t: "events", session: "s1", epoch: "new", events: [words(101), words(120)], more: false, tail: { hasOlder: true } });
  const cache = app.caches.get("s1")!;
  assert.equal(cache.epoch, "new");
  assert.deepEqual(cache.events.map(item => item.seq), [101, 120]);
  assert.equal(cache.hasOlder, true);
  app.loadOlder();
  const request = asks(app).at(-1)!;
  assert.equal(request.beforeSeq, 101);
  app.onHost({ t: "history", session: "s1", reqId: request.reqId, events: [words(1), words(100)], hasOlder: false });
  assert.deepEqual(cache.events.map(item => item.seq), [1, 100, 101, 120]);
  assert.equal(cache.hasOlder, false);
});

test("late history cannot cross an epoch or satisfy a newer request", async () => {
  install(new Storage());
  const app = await start();
  app.go({ name: "session", id: "s1" });
  app.onHost({ t: "events", session: "s1", epoch: "A", events: [words(764)], more: false, tail: { hasOlder: true } });
  app.loadOlder();
  const old = asks(app).at(-1)!;
  assert.equal(old.epoch, "A");
  app.onHost({ t: "events", session: "s1", epoch: "B", events: [words(1264), words(1500)], more: false, tail: { hasOlder: true } });
  app.loadOlder();
  const current = asks(app).at(-1)!;
  assert.notEqual(current.reqId, old.reqId);
  app.onHost({ t: "history", session: "s1", reqId: old.reqId, epoch: "A", events: [words(763)], hasOlder: true });
  app.onHost({ t: "history", session: "s1", reqId: current.reqId, epoch: "A", events: [words(763)], hasOlder: true });
  assert.deepEqual(app.caches.get("s1")!.events.map(e => e.seq), [1264, 1500]);
  app.onHost({ t: "history", session: "s1", reqId: current.reqId, epoch: "B", events: [words(1263)], hasOlder: true });
  assert.deepEqual(app.caches.get("s1")!.events.map(e => e.seq), [1263, 1264, 1500]);
});

test("same epoch overlapping or adjacent tails retain loaded history; gaps replace it", async () => {
  install(new Storage());
  const app = await start();
  app.go({ name: "session", id: "s1" });
  const tail = (events: ReturnType<typeof words>[], hasOlder: boolean) => app.onHost({ t: "events", session: "s1", epoch: "e", events, more: false, tail: { hasOlder } });
  tail([words(764), words(765)], true);
  app.loadOlder();
  const req = asks(app).at(-1)!;
  app.onHost({ t: "history", session: "s1", reqId: req.reqId, epoch: "e", events: [words(527), words(763)], hasOlder: true });
  tail([words(764), words(765), words(766)], true);
  assert.deepEqual(app.caches.get("s1")!.events.map(e => e.seq), [527, 763, 764, 765, 766]);
  tail([words(767)], true);
  assert.equal(app.caches.get("s1")!.events[0]!.seq, 527);
  tail([words(900)], true);
  assert.deepEqual(app.caches.get("s1")!.events.map(e => e.seq), [900]);
});

test("a page whose request cursor no longer matches the first event is not merged", async () => {
  const browser = install(new Storage());
  const app = await start();
  app.go({ name: "session", id: "s1" });
  app.onHost({ t: "events", session: "s1", epoch: "e", events: [words(100), words(101)], more: false, tail: { hasOlder: true } });
  app.loadOlder();
  const request = asks(app).at(-1)!;
  app.onHost({ t: "events", session: "s1", epoch: "e", events: [words(99), words(100), words(101)], more: false, tail: { hasOlder: true } });
  app.onHost({ t: "history", session: "s1", reqId: request.reqId, epoch: "e", events: [words(50)], hasOlder: true });
  assert.deepEqual(app.caches.get("s1")!.events.map(e => e.seq), [99, 100, 101]);
  assert.match(browser.el("#older").innerHTML, /이전 대화를 불러오지 못했습니다/);
  app.loadOlder(true);
  const retry = asks(app).at(-1)!;
  assert.equal(retry.beforeSeq, 99);
  app.onHost({ t: "history", session: "s1", reqId: retry.reqId, epoch: "e", events: [words(98)], hasOlder: true });
  assert.deepEqual(app.caches.get("s1")!.events.map(e => e.seq), [98, 99, 100, 101]);
});

test("a conversation opens where the reader left it, and at its newest message when they left it there", async () => {
  const browser = install(new Storage());
  const app = await start();
  const main = browser.el("main"), tl = browser.el("#tl");
  main.clientHeight = 600;
  main.scrollHeight = 2000;
  app.go({ name: "session", id: "s1" });
  app.onHost({ t: "events", session: "s1", epoch: "e", events: [words(1), words(2), words(3)], more: false, tail: { hasOlder: false } });

  // The reader is partway through the second row: its start is 20 pt above the top edge.
  main.scrollTop = 300;
  tl.children = contentRows(main, [{ key: "k1", top: 180, height: 100 }, { key: "k2", top: 280, height: 200 }, { key: "k3", top: 480, height: 120 }]);
  app.pinned = false;
  app.go({ name: "session", id: "s2" });
  assert.deepEqual(app.caches.get("s1")!.scroll, { key: "k2", inset: -20 }, "the row under the top edge is remembered");

  // Coming back: the list was rebuilt, and three new messages pushed every row 200 pt further down.
  tl.children = contentRows(main, [{ key: "k1", top: 380, height: 100 }, { key: "k2", top: 480, height: 200 }, { key: "k3", top: 680, height: 120 }]);
  app.go({ name: "session", id: "s1" });
  assert.equal(main.scrollTop, 500, "the same words stay under the same thumb");

  // Left at the newest message: coming back shows the newest message, wherever the content went.
  main.scrollTop = 1400;
  app.pinned = true;
  app.go({ name: "session", id: "s2" });
  assert.equal(app.caches.get("s1")!.scroll, "bottom", "the newest message is a place too");
  main.scrollHeight = 2600;
  app.go({ name: "session", id: "s1" });
  assert.equal(main.scrollTop, 2600, "a conversation left at its end opens at its end");

  // The remembered row is no longer in the conversation: start again from the newest words.
  main.scrollTop = 300;
  app.pinned = false;
  tl.children = contentRows(main, [{ key: "k1", top: 180, height: 100 }, { key: "k2", top: 280, height: 200 }, { key: "k3", top: 480, height: 120 }]);
  app.go({ name: "session", id: "s2" });
  tl.children = contentRows(main, [{ key: "k1", top: 380, height: 100 }, { key: "k3", top: 680, height: 120 }]);
  app.go({ name: "session", id: "s1" });
  assert.equal(main.scrollTop, 2600, "a row that is gone falls back to the newest message");
});
