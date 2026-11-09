// Copying an answer from the browser remote: the words that leave are the whole answer, including
// one the host moved into a blob, and the control is there while the answer is still arriving.
import test from "node:test";
import assert from "node:assert/strict";
import * as V from "../web/views.ts";
import type { UI } from "../web/views.ts";

const ORIGIN = "https://phone.example";
const TOKEN = "token-for-the-tests-0123456789";
const copied: string[] = [];

function ui(): UI {
  return {
    now: 1_700_000_000_000, link: { state: "open", attempt: 0, nextAt: null, lastRx: 1, downSince: null },
    host: { name: "Mac", version: "t", routerOk: true }, home: "/Users/me", sessions: [], models: [], sheet: null,
    draft: { cwd: null, model: null, effort: null }, expanded: new Map(), workersOpen: false, permOpen: new Set(), toast: null, pins: [], folded: [], query: "", homeLimit: 40,
  };
}

const answer = (text: unknown, streaming = false) => ({ type: "assistant" as const, key: "a1", ver: "d1", text, streaming, tools: [], model: "model", at: 1 }) as never;

test("the copy control sits under an answer, streaming or finished, and names what it copies", () => {
  const done = V.item(answer("첫 문장입니다."), ui());
  assert.ok(done.includes('data-act="copy-answer" data-key="a1"'));
  assert.ok(done.includes('aria-label="답변 복사"'), "the control says what it does for a screen reader");
  assert.ok(done.includes(">복사<"), "and for the eye");
  const live = V.item(answer("아직 오는 중", true), ui());
  assert.ok(live.includes('data-act="copy-answer"'), "a streaming answer can be copied too");
  // Nothing to copy, nothing offered.
  assert.ok(!V.item(answer("   "), ui()).includes('data-act="copy-answer"'));
});

class Storage {
  private map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  keys(): string[] { return [...this.map.keys()]; }
}

class Socket {
  static latest: Socket | null = null;
  static respond: ((op: Record<string, unknown>) => unknown) | null = null;
  readyState = 0;
  frames: string[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) { this.url = url; Socket.latest = this; }
  send(data: string): void {
    this.frames.push(data);
    const msg = JSON.parse(data) as { t?: string; reqId?: string; op?: Record<string, unknown> };
    if (msg.t !== "req" || !msg.reqId) return;
    const reqId = msg.reqId;
    void Promise.resolve().then(() => Socket.respond ? Socket.respond(msg.op ?? {}) : null).then(
      value => this.deliver({ t: "res", reqId, ok: true, data: value }),
      error => this.deliver({ t: "res", reqId, ok: false, error: String(error) }),
    );
  }
  open(): void { this.readyState = 1; this.onopen?.(); }
  deliver(msg: unknown): void { this.onmessage?.({ data: JSON.stringify(msg) }); }
  close(): void { this.readyState = 3; this.onclose?.(); }
}

interface Element { dataset: Record<string, string>; innerHTML: string; value: string; hidden: boolean; scrollTop: number }

function install(storage: Storage): { sheet(): Element; toast(): Element } {
  const elements = new Map<string, Element>();
  const el = (key: string): Element => {
    const found = elements.get(key);
    if (found) return found;
    const made = {
      dataset: {}, innerHTML: "", value: "", hidden: false, style: {}, children: [], parentElement: null,
      scrollTop: 0, scrollHeight: 0, clientHeight: 0,
      addEventListener: () => undefined, removeEventListener: () => undefined, append: () => undefined,
      remove: () => undefined, focus: () => undefined, setAttribute: () => undefined, replaceWith: () => undefined,
      insertBefore: () => undefined, removeChild: () => undefined, disconnect: () => undefined, observe: () => undefined,
      querySelector: () => null, querySelectorAll: () => [], getElementsByTagName: () => [],
    };
    elements.set(key, made);
    return made;
  };
  const define = (name: string, value: unknown): void => { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
  define("localStorage", new Proxy(storage, {
    ownKeys: () => storage.keys(),
    getOwnPropertyDescriptor: (_target, key) => typeof key === "string" && storage.getItem(key) !== null
      ? { configurable: true, enumerable: true, value: storage.getItem(key) } : undefined,
  }));
  define("WebSocket", Socket);
  define("document", {
    documentElement: { lang: "", dataset: {} as Record<string, string> },
    visibilityState: "visible",
    querySelector: (sel: string) => el(sel),
    querySelectorAll: () => [],
    getElementById: (id: string) => el(`#${id}`),
    createElement: (tag: string) => tag === "template" ? { innerHTML: "", content: { firstElementChild: el("template-child") } } : el(`<${tag}>`),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  define("navigator", { languages: ["ko"], language: "ko", onLine: true, clipboard: { writeText: async (value: string) => { copied.push(value); } } });
  define("location", { hash: "", pathname: "/", search: "", origin: ORIGIN, protocol: "https:", host: "phone.example" });
  define("history", { replaceState: () => undefined, pushState: () => undefined });
  define("window", { addEventListener: () => undefined, isSecureContext: false, matchMedia: () => ({ matches: false }) });
  define("matchMedia", () => ({ matches: false }));
  define("requestAnimationFrame", (fn: () => void) => { fn(); return 0; });
  define("ResizeObserver", class { observe(): void {} disconnect(): void {} });
  define("setInterval", () => 0);
  define("clearInterval", () => undefined);
  return { sheet: () => el("#sheet"), toast: () => el("#toast") };
}

interface AppBoundary {
  start(): Promise<void>;
  go(screen: { name: "home" } | { name: "session"; id: string }): void;
  act(name: string, el: { dataset: Record<string, string> }): Promise<void>;
  ui: { models: unknown[] };
  link: { stop(): void } | null;
}
type AppCtor = new (status: unknown) => AppBoundary;
let AppClass: AppCtor | null = null;

async function launch(): Promise<{ app: AppBoundary; socket: Socket; sheet: () => Element; toast: () => Element }> {
  const storage = new Storage();
  const elements = install(storage);
  Socket.respond = null;
  storage.setItem("rr.token", JSON.stringify(TOKEN));
  if (AppClass === null) {
    storage.setItem("rr.token", JSON.stringify(""));
    const specifier = "../web/app.ts";
    const module: { App: AppCtor } = await import(specifier);
    AppClass = module.App;
    storage.setItem("rr.token", JSON.stringify(TOKEN));
  }
  const app = new AppClass({ state: "connecting", attempt: 0, nextAt: null, lastRx: null, downSince: null });
  app.ui.models = [];
  await app.start();
  const socket = Socket.latest;
  assert.ok(socket);
  socket.open();
  socket.deliver({ t: "ready", host: { name: "Mac", version: "t", routerOk: true }, sessions: [] });
  return { app, socket, sheet: elements.sheet, toast: elements.toast };
}

// The blob transport's own page size is the host's; this test only needs more than one page.
const PAGES = ["첫 페이지의 문장입니다. ", "둘째 페이지까지 이어집니다."];

test("copy takes the whole answer, including one the host keeps in a blob", async () => {
  const running = await launch();
  Socket.respond = op => op.op === "blob"
    // Two pages, the second ending the read: the copy must join both, not stop at the preview.
    ? (op.offset === 0 ? { text: PAGES[0], offset: 0, next: PAGES[0]!.length, bytes: 0 } : { text: PAGES[1], offset: PAGES[0]!.length, next: null, bytes: 0 })
    : null;
  try {
    running.app.go({ name: "session", id: "s1" });
    running.socket.deliver({ t: "events", session: "s1", epoch: "e", events: [
      { seq: 1, at: 1, kind: "assistant", msg: "m1", model: "model", text: "짧은 답변", tools: [] },
      { seq: 2, at: 2, kind: "assistant", msg: "m2", model: "model", text: { blob: "b1", bytes: 100, preview: "미리보기만…" }, tools: [] },
    ] });
    await running.app.act("copy-answer", { dataset: { key: "am1" } });
    assert.equal(copied.at(-1), "짧은 답변", "an answer held in the page is copied whole");

    await running.app.act("copy-answer", { dataset: { key: "am2" } });
    assert.equal(copied.at(-1), PAGES.join(""), "a blob is read to its last page and copied whole");
    assert.ok(!copied.at(-1)!.includes("미리보기만"), "the preview is never what leaves the phone");
  } finally { running.app.link?.stop(); }
});

test("a refused clipboard says so instead of pretending the copy happened", async () => {
  const running = await launch();
  const clipboard = (globalThis as unknown as { navigator: { clipboard: { writeText(value: string): Promise<void> } } }).navigator.clipboard;
  const before = copied.length;
  clipboard.writeText = async () => { const error = new Error("denied"); error.name = "NotAllowedError"; throw error; };
  try {
    running.app.go({ name: "session", id: "s2" });
    running.socket.deliver({ t: "events", session: "s2", epoch: "e", events: [
      { seq: 1, at: 1, kind: "assistant", msg: "m1", model: "model", text: "답변", tools: [] },
    ] });
    await running.app.act("copy-answer", { dataset: { key: "am1" } });
    assert.equal(copied.length, before, "nothing was copied");
    assert.ok(running.toast().innerHTML.includes("NotAllowedError"), "the browser's own refusal is shown");
  } finally { running.app.link?.stop(); }
});
