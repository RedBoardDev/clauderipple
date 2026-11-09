// The changes pane at its two boundaries: the markup a person reads (views.ts), and the app that
// asks the host for one comparison, opens a file and puts them back where they were.
import test from "node:test";
import assert from "node:assert/strict";
import * as V from "../web/views.ts";
import type { UI } from "../web/views.ts";
import type { DiffView } from "../src/protocol.ts";

const ORIGIN = "https://phone.example";
const TOKEN = "token-for-the-tests-0123456789";

const patchOf = (lines: string[]): string => ["diff --git a/x b/x", "index 111..222 100644", "--- a/x", "+++ b/x", "@@ -1,1 +1,1 @@", ...lines, ""].join("\n");
const longPatch = patchOf(Array.from({ length: 900 }, (_, i) => `+line ${i + 1}`));

const change: DiffView = {
  scope: "uncommitted",
  base: null,
  branch: "feature",
  files: [
    { path: "src/long.txt", status: "modified", added: 900, removed: 0, patch: longPatch },
    { path: "src/cut.txt", status: "modified", added: 4000, removed: 0, patch: patchOf(["+first"]), cut: true },
    { path: "src/logo.png", status: "binary", added: 0, removed: 0, patch: "" },
  ],
  truncated: true,
};

function uiWith(sheet: UI["sheet"], capabilities: { sessionFiles: boolean; diffScope?: boolean } | undefined): UI {
  return {
    now: 1_700_000_000_000, link: { state: "open", attempt: 0, nextAt: null, lastRx: 1, downSince: null },
    host: capabilities === undefined ? null : { name: "Mac", version: "t", routerOk: true, capabilities },
    home: "/Users/me", sessions: [], models: [], sheet,
    draft: { cwd: null, model: null, effort: null }, expanded: new Map(), workersOpen: false, permOpen: new Set(), toast: null, pins: [], folded: [], query: "", homeLimit: 40,
  };
}

test("the changes list offers both comparisons, names partial files, and opens every line", () => {
  const sheet = (over: Partial<Extract<UI["sheet"], { kind: "diff" }>> = {}) =>
    ({ kind: "diff" as const, view: change, scope: "auto" as const, loading: false, error: "", open: null, scroll: 0, ...over });
  const list = V.sheet(uiWith(sheet(), { sessionFiles: true, diffScope: true }));
  assert.ok(list.includes('data-act="diff-scope" data-scope="uncommitted"'), "uncommitted work is one of the two");
  assert.ok(list.includes('data-act="diff-scope" data-scope="branch"'), "the branch is the other");
  assert.ok(list.includes("feature 브랜치"), "the branch the answer is on is named");
  assert.ok(list.includes("커밋하지 않은 변경"), "and so is what is being shown");
  assert.ok(list.includes("파일 3개"));
  assert.ok(list.includes("일부"), "a file whose patch was cut says so in its own row");
  assert.ok(list.includes("변경이 커서 일부만 표시합니다"), "the view says it left something out");
  assert.ok(list.includes('data-act="diff-file" data-id="src/long.txt"'));

  // A host that does not know the scope takes no switch: the pane shows its one answer.
  const older = V.sheet(uiWith(sheet(), undefined));
  assert.ok(!older.includes("diff-scope"));

  // A file opens to its whole patch: the old 800-line cut is gone, and the place is walkable.
  const file = V.sheet(uiWith(sheet({ open: "src/long.txt" }), { sessionFiles: true, diffScope: true }));
  assert.ok(file.includes("line 900"), "the ninetieth screenful is in the original text");
  assert.ok(file.includes("line 1<"), "and so is the first");
  assert.ok(file.includes('data-act="diff-back"'));
  assert.ok(file.includes('aria-label="이전 파일" disabled'), "the first file has no previous");
  assert.ok(file.includes('data-act="diff-step" data-index="1" aria-label="다음 파일">'), "the next file is offered");
  assert.ok(file.includes("1/3"));
  assert.ok(!file.includes("앞부분만"), "a complete patch claims nothing was cut");

  // A cut file says only its start arrived, instead of looking complete.
  const cut = V.sheet(uiWith(sheet({ open: "src/cut.txt" }), { sessionFiles: true }));
  assert.ok(cut.includes("앞부분만 받았습니다"), "the file itself says it was cut");
  // A binary has no patch, so its row is not a way in, and nothing claims lines to read.
  assert.ok(!list.includes('data-act="diff-file" data-id="src/logo.png"'));
  const binary = V.sheet(uiWith(sheet({ open: "src/logo.png" }), { sessionFiles: true }));
  assert.ok(!binary.includes('data-act="diff-copy"'), "copy is offered only where there is a patch");
});

test("an empty answer names the comparison that was asked for", () => {
  const empty = (scope: "auto" | "uncommitted" | "branch"): DiffView => ({ scope: "clean", base: null, branch: "feature", files: [], truncated: false });
  const ask = (chosen: "auto" | "uncommitted" | "branch") => V.sheet(uiWith({ kind: "diff", view: empty(chosen), scope: chosen, loading: false, error: "", open: null, scroll: 0 }, { sessionFiles: true, diffScope: true }));
  assert.ok(ask("uncommitted").includes("커밋하지 않은 변경이 없습니다"));
  assert.ok(ask("branch").includes("이 브랜치에는 기준 브랜치와 다른 커밋이 없습니다"));
  assert.ok(ask("auto").includes("변경 사항이 없습니다"));
  const notGit = V.sheet(uiWith({ kind: "diff", view: null, scope: "auto", loading: false, error: "not a git repository", open: null, scroll: 0 }, { sessionFiles: true }));
  assert.ok(notGit.includes("git 저장소가 아니어서"));
  assert.ok(notGit.includes('data-act="diff-retry"'), "a failure always offers the way back in");
});

// ---- the app ----------------------------------------------------------------------------------

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
      answer => this.deliver({ t: "res", reqId, ok: true, data: answer }),
      error => this.deliver({ t: "res", reqId, ok: false, error: String(error) }),
    );
  }
  open(): void { this.readyState = 1; this.onopen?.(); }
  deliver(msg: unknown): void { this.onmessage?.({ data: JSON.stringify(msg) }); }
  close(): void { this.readyState = 3; this.onclose?.(); }
}

interface Element { dataset: Record<string, string>; innerHTML: string; value: string; hidden: boolean; scrollTop: number }

function install(storage: Storage): { sheet(): Element; diff(): Element } {
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
  return { sheet: () => el("#sheet"), diff: () => el("#diff-body") };
}
const copied: string[] = [];

/** The app as its buttons call it. app.ts is browser code, type-checked by the web project (its
 * import specifier is a variable on purpose, so this Node program does not type-check it). */
interface AppBoundary {
  start(): Promise<void>;
  go(screen: { name: "home" } | { name: "session"; id: string }): void;
  act(name: string, el: { dataset: Record<string, string> }): Promise<void>;
  ui: {
    models: unknown[];
    sheet: { kind: string; open?: string | null; scroll?: number; scope?: string; view?: DiffView | null } | null;
  };
  link: { stop(): void } | null;
}
type AppCtor = new (status: unknown) => AppBoundary;
let AppClass: AppCtor | null = null;

async function launch(): Promise<{ app: AppBoundary; socket: Socket; sheet: () => Element; diff: () => Element }> {
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
  socket.deliver({ t: "ready", host: { name: "Mac", version: "t", routerOk: true, capabilities: { sessionFiles: true, diffScope: true } }, sessions: [] });
  return { app, socket, sheet: elements.sheet, diff: elements.diff };
}

test("the app asks for one comparison at a time and keeps both reading positions", async () => {
  const running = await launch();
  const requests: Record<string, unknown>[] = [];
  Socket.respond = op => {
    requests.push(op);
    if (op.op !== "diff") return null;
    if (op.scope === "branch") return { ...change, scope: "branch", base: "main", files: [change.files[0]!] };
    if (op.scope === "uncommitted") return change;
    return change;
  };
  try {
    running.app.go({ name: "session", id: "s1" });
    await running.app.act("diff", { dataset: {} });
    assert.deepEqual(requests.at(-1), { op: "diff", session: "s1" }, "the first answer asks for no scope, as an older host would understand");
    assert.ok(running.sheet().innerHTML.includes('data-act="diff-file" data-id="src/long.txt"'));
    assert.ok(running.sheet().innerHTML.includes('data-act="diff-scope"'));

    await running.app.act("diff-scope", { dataset: { scope: "branch" } });
    assert.deepEqual(requests.at(-1), { op: "diff", session: "s1", scope: "branch" });
    assert.ok(running.sheet().innerHTML.includes("main 이후 브랜치의 변경"));
    await running.app.act("diff-scope", { dataset: { scope: "uncommitted" } });
    assert.equal(requests.at(-1)?.scope, "uncommitted");

    // A file opens over the list; coming back restores the list, and the file reopens where it was.
    running.diff().scrollTop = 0;
    await running.app.act("diff-file", { dataset: { id: "src/long.txt" } });
    assert.equal(running.app.ui.sheet?.open, "src/long.txt");
    assert.ok(running.sheet().innerHTML.includes("line 900"), "the whole patch is drawn");
    running.diff().scrollTop = 128;
    await running.app.act("diff-step", { dataset: { index: "1" } });
    assert.equal(running.app.ui.sheet?.open, "src/cut.txt", "the next file opens in place");
    assert.ok(running.sheet().innerHTML.includes("앞부분만 받았습니다"));
    running.diff().scrollTop = 0;
    await running.app.act("diff-back", { dataset: {} });
    assert.equal(running.app.ui.sheet?.open, null);
    await running.app.act("diff-file", { dataset: { id: "src/long.txt" } });
    assert.equal(running.diff().scrollTop, 128, "the file reopens where it was left");

    // Copy takes the lines as read, without git's own headers.
    await running.app.act("diff-copy", { dataset: { id: "src/long.txt" } });
    assert.ok(copied.at(-1)?.includes("+line 900"), "every line is copied");
    assert.ok(!copied.at(-1)?.includes("diff --git"), "the headers stay out");
    assert.equal(V.patchLines(longPatch).at(0), "@@ -1,1 +1,1 @@", "a hunk header stays, so the change’s place is visible");

    // Closing the pane keeps nothing stale behind it.
    await running.app.act("close-sheet", { dataset: {} });
    assert.equal(running.app.ui.sheet, null);
  } finally { running.app.link?.stop(); }
});
