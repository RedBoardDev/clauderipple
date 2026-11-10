// The home list as markup: what a section fold leaves behind, what a search says when the list has
// not arrived versus when it holds nothing, and how many rows one page draws. The real views
// module renders these, so these are the strings the app ships.
import test from "node:test";
import assert from "node:assert/strict";
import { HOME_PAGE, homeList, homeMain, sheet } from "../web/views.ts";
import type { Sheet, UI } from "../web/views.ts";
import type { LinkStatus } from "../web/conn.ts";
import type { SessionSummary } from "../src/protocol.ts";

const LINK: LinkStatus = { state: "open", attempt: 0, nextAt: null, lastRx: null, downSince: null };

function session(over: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    title: `세션 ${over.id}`, cwd: "/Users/pbj/Documents/ClaudeRipple", model: "sol", effort: null, state: "idle",
    pending: 0, createdAt: 1, updatedAt: 1, lastSeq: 0, epoch: "e", ...over,
  };
}

function ui(over: Partial<UI> = {}): UI {
  const base: UI = {
    now: 10_000, link: LINK, host: null, home: undefined, sessions: [], models: [], sheet: null,
    draft: { cwd: null, model: null, effort: null },
    expanded: new Map(), workersOpen: false, permOpen: new Set(), toast: null,
    pins: [], folded: ["archive"], query: "", homeLimit: HOME_PAGE,
  };
  return { ...base, ...over };
}

/** The ids the list actually drew, in order. */
function drawn(html: string): string[] {
  return [...html.matchAll(/<button class="row" data-act="open" data-id="([^"]+)"/g)].map(m => m[1]!);
}

test('a section folds to its name and count, and folds back', () => {
  const sessions = [session({ id: "a", title: "첫 세션", updatedAt: 3 }), session({ id: "b", title: "둘째 세션", updatedAt: 2 })];
  const openHtml = homeList(ui({ sessions }));
  assert.deepEqual(drawn(openHtml), ["a", "b"]);
  assert.match(openHtml, /<button class="sec" data-act="fold" data-key="sidebar:recent" aria-expanded="true"/);
  const foldedHtml = homeList(ui({ sessions, folded: ["sidebar:recent"] }));
  assert.deepEqual(drawn(foldedHtml), []);
  assert.match(foldedHtml, /aria-expanded="false"[^>]*>최근<span class="count">2<\/span>/);
});

test('a search over a project path lists results once, and says plainly when there is nothing to search', () => {
  const sessions = [
    session({ id: "remote", title: "세션 목록", cwd: "/Users/pbj/Documents/ClaudeRipple/apps/ripple-remote", updatedAt: 2 }),
    session({ id: "docs", title: "글 다듬기", cwd: "/Users/pbj/Documents/ClaudeRipple/docs", updatedAt: 3 }),
  ];
  const found = homeList(ui({ sessions, query: "ripple-remote" }));
  assert.deepEqual(drawn(found), ["remote"]);
  assert.match(found, /검색 결과/);
  assert.match(found, /<span class="count">1<\/span>/);
  // Two words must both match one session; case does not count.
  assert.deepEqual(drawn(homeList(ui({ sessions, query: "CLAUDERIPPLE 세션" }))), ["remote"]);
  // Nothing found is a different sentence from nothing to search.
  const none = homeList(ui({ sessions, query: "없는이름" }));
  assert.match(none, /일치하는 세션이 없습니다\./);
  assert.doesNotMatch(none, /세션 목록을 아직 받지 못했습니다/);
  const unsearchable = homeList(ui({ sessions: [], query: "무엇이든", link: { ...LINK, state: "connecting" } }));
  assert.match(unsearchable, /세션 목록을 아직 받지 못했습니다\. 연결되면 다시 검색할 수 있습니다\./);
  assert.doesNotMatch(unsearchable, /일치하는 세션이 없습니다\./);
  // Results from a list received earlier still say where they came from.
  const stale = homeList(ui({ sessions, query: "ripple-remote", link: { ...LINK, state: "connecting" } }));
  assert.match(stale, /마지막으로 받은 목록에서 찾았습니다\./);
});

test('one page of rows is drawn, with how many are still waiting, and the next page follows', () => {
  const many = Array.from({ length: 100 }, (_, i) => session({ id: `s${i}`, updatedAt: i }));
  const first = homeList(ui({ sessions: many }));
  assert.equal(drawn(first).length, HOME_PAGE, "a hundred sessions draw one page");
  assert.match(first, /data-act="home-more"/);
  assert.match(first, /60개 더 보기/, "the rest is counted, not drawn");
  const second = homeList(ui({ sessions: many, homeLimit: HOME_PAGE * 2 }));
  assert.equal(drawn(second).length, HOME_PAGE * 2);
  assert.match(second, /20개 더 보기/);
  // Folded sections cost nothing, and the budget goes to the rows that are drawn.
  const folded = homeList(ui({ sessions: many, folded: ["sidebar:recent"] }));
  assert.equal(drawn(folded).length, 0);
  assert.doesNotMatch(folded, /data-act="home-more"/, "a folded section hides nothing worth paging to");
});

test('a pinned session is listed once and first, and the archive waits at the foot with its count', () => {
  const sessions = [
    session({ id: "starred", title: "별표 세션", group: "sidebar:pinned", updatedAt: 5 }),
    session({ id: "pinned", title: "고정한 세션", updatedAt: 4 }),
    session({ id: "plain", title: "일반 세션", updatedAt: 1 }),
    session({ id: "old", title: "보관한 세션", archived: true, updatedAt: 3 }),
  ];
  // Long past the hour, so the unpinned session sits in its group rather than in 최근.
  const html = homeList(ui({ sessions, pins: ["pinned"], now: 10_000_000 }));
  assert.deepEqual(drawn(html), ["starred", "pinned", "plain"], "the archive is folded by default; newest pin first");
  assert.ok(html.indexOf("고정됨") < html.indexOf("휴대폰에서 시작"), "pinned comes first");
  assert.equal(html.split('data-id="pinned"').length - 1, 2, "one row and one menu button, not a second row");
  assert.match(html, /data-key="archive" aria-expanded="false"[^>]*>보관됨<span class="count">1<\/span>/);
  const opened = homeList(ui({ sessions, pins: ["pinned"], now: 10_000_000, folded: [] }));
  assert.deepEqual(drawn(opened), ["starred", "pinned", "plain", "old"]);
});

test('every row has its own menu button beside it, with a name a screen reader can read', () => {
  const html = homeList(ui({ sessions: [session({ id: "a" }), session({ id: "b", updatedAt: 2 })] }));
  assert.equal([...html.matchAll(/data-act="row-menu"/g)].length, 2);
  assert.match(html, /<div class="rowwrap"><button class="row" data-act="open" data-id="a">/);
  assert.match(html, /<button class="row-more" data-act="row-menu" data-id="a" aria-label="세션 메뉴" aria-haspopup="dialog">/);
});

test('the session sheet puts the frequent action first and is honest when the computer is away', () => {
  const sessions = [session({ id: "a", title: "정리할 세션" }), session({ id: "starred", group: "sidebar:pinned" }), session({ id: "read", title: "다 읽은 세션", unread: true })];
  const open = (id: string, over: Partial<UI> = {}): string => sheet(ui({ sessions, sheet: { kind: "session", id } satisfies Sheet, ...over }));
  const html = open("a");
  const order = [(text: string) => text.indexOf(">보관<"), (text: string) => text.indexOf(">고정<"), (text: string) => text.indexOf(">안 읽음으로 표시<")].map(f => f(html));
  assert.ok(order.every(at => at > -1), "archive, pin and the unread mark are all there");
  assert.deepEqual(order, [...order].sort((x, y) => x - y), "frequent first: archive, then pin, then unread");
  assert.match(html, /role="dialog" aria-modal="true" aria-label="세션 메뉴"/);
  // A pinned row offers the way back out; a Desktop star is not this phone's to remove.
  assert.match(open("a", { pins: ["a"] }), />고정 해제</);
  assert.doesNotMatch(open("starred"), />고정</);
  // Unread sessions have nothing to mark; read ones have.
  assert.doesNotMatch(open("read"), />안 읽음으로 표시</);
  // Away from the computer the actions are disabled, and the sheet says why instead of failing silently.
  const away = open("a", { link: { ...LINK, state: "connecting" } });
  assert.match(away, /<button class="opt" data-act="archive-toggle" data-id="a" disabled>/);
  assert.match(away, /컴퓨터에 연결된 뒤에 바꿀 수 있습니다\./);
});

test('the search field sits outside the list region so typing never rebuilds it', () => {
  const html = homeMain(ui({ sessions: [session({ id: "a" })], query: "세" }));
  const field = html.indexOf('id="home-search"');
  const list = html.indexOf('id="home-list"');
  assert.ok(field > -1 && field < list, "the field comes before the list it filters");
  assert.equal([...html.matchAll(/id="home-search"/g)].length, 1);
  // With nothing stored there is nothing to search, so no field is drawn at all — unless a query is
  // still there, and then the field stays under it with the sentence about the missing list.
  assert.doesNotMatch(homeMain(ui()), /id="home-search"/);
  const orphan = homeMain(ui({ query: "무엇이든", link: { ...LINK, state: "denied" } }));
  assert.match(orphan, /id="home-search"/);
  assert.match(orphan, /세션 목록을 아직 받지 못했습니다\./);
});

test('a hundred and a thousand sessions cost the same page, and the page is what is built', () => {
  const make = (count: number): SessionSummary[] => Array.from({ length: count }, (_, i) => session({
    id: `s${i}`,
    title: `작업 ${i}`,
    cwd: `/Users/pbj/Documents/${i % 3 === 0 ? "ClaudeRipple" : "기타"}/project-${i % 20}`,
    state: i % 4 === 2 ? "error" : i % 4 === 1 ? "running" : i % 4 === 3 ? "waiting" : "idle",
    updatedAt: i + 1,
  }));
  const time = (sessions: SessionSummary[]): { ms: number; html: string } => {
    const at = performance.now();
    const html = homeList(ui({ sessions, now: 1_000 }));
    return { ms: performance.now() - at, html };
  };
  const hundred = make(100), thousand = make(1000);
  time(hundred); time(thousand); // warm the shapes first
  const h100 = Math.min(time(hundred).ms, time(hundred).ms, time(hundred).ms);
  const h1000 = Math.min(time(thousand).ms, time(thousand).ms, time(thousand).ms);
  const big = time(thousand).html;
  // The DOM is one page whatever the list holds, which is what keeps a thousand sessions cheap.
  assert.equal(drawn(big).length, HOME_PAGE);
  assert.ok(big.length < 80_000, `one page is ${big.length} characters`);
  assert.ok(h1000 < 50, `a thousand sessions cost ${h1000.toFixed(2)}ms to lay out`);
  console.log(`home page: 100 sessions ${h100.toFixed(2)}ms, 1000 sessions ${h1000.toFixed(2)}ms (${HOME_PAGE} rows, ${big.length} chars)`);
});
