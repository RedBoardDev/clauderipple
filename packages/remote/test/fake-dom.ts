// The slice of a browser the phone app touches while rendering, at its boundary: elements are
// per-selector stand-ins that remember the little the app reads and writes (text, scroll, layout),
// and storage is localStorage able to refuse a write the way a full disk does. Tests read these
// elements back to see what a person would. Nothing here re-implements the app's own decisions.
import { loadOutbox } from "../web/outbox.ts";
import type { OutboxEntry } from "../web/outbox.ts";

export const ORIGIN = "https://phone.example";
export const TOKEN = "token-for-the-tests-0123456789";

/** localStorage as a browser gives it, able to refuse writes outright or after a count. */
export class Storage {
  failWrites = false;
  failAfter: number | null = null;
  writes = 0;
  private map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void {
    if (this.failWrites || (this.failAfter !== null && this.writes >= this.failAfter)) {
      const error = new Error("full");
      error.name = "QuotaExceededError";
      throw error;
    }
    this.writes++;
    this.map.set(key, value);
  }
  keys(): string[] { return [...this.map.keys()]; }
  /** Exactly what is stored, without parsing it. */
  raw(key: string): string | null { return this.map.get(key) ?? null; }
  /** The stored queue as the app would read it after a reload. */
  stored(key: string): OutboxEntry[] {
    const load = loadOutbox(this, key);
    return load.status === "ok" || load.status === "partial" ? load.entries : [];
  }
}

export interface Box { top: number; bottom: number; left: number; right: number; width: number; height: number }

export interface Element {
  dataset: Record<string, string>;
  innerHTML: string;
  value: string;
  hidden: boolean;
  className: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  children: Element[];
  /** Where this element is on screen; a test moves it to stand for content growing around it. */
  box: Box;
  getBoundingClientRect(): Box;
}

/** The browser the app runs in, plus the elements a test reads back. */
export function install(storage: Storage): { el(key: string): Element; sheet(): Element; body(): Element; main(): Element; list(): Element; fire(key: string, type: string, ev: unknown): void } {
  const elements = new Map<string, Element>();
  const handlers = new Map<string, Record<string, ((ev: unknown) => void)[]>>();
  const el = (key: string): Element => {
    const found = elements.get(key);
    if (found) return found;
    const box: Box = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
    const listeners: Record<string, ((ev: unknown) => void)[]> = {};
    handlers.set(key, listeners);
    const made = {
      dataset: {}, innerHTML: "", value: "", hidden: false, className: "", box,
      style: {}, children: [], parentElement: null, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
      getBoundingClientRect: () => box,
      addEventListener: (type: string, fn: (ev: unknown) => void) => { (listeners[type] ??= []).push(fn); }, removeEventListener: () => undefined, append: () => undefined,
      remove: () => undefined, focus: () => undefined, setAttribute: () => undefined, replaceWith: () => undefined,
      insertBefore: () => undefined, removeChild: () => undefined, disconnect: () => undefined, observe: () => undefined,
      querySelector: () => null, querySelectorAll: () => [], getElementsByTagName: () => [],
    };
    elements.set(key, made as unknown as Element);
    return made as unknown as Element;
  };
  const define = (name: string, value: unknown): void => { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
  define("localStorage", new Proxy(storage, {
    // Browser storage exposes stored keys as enumerable own properties, not the fixture's fields.
    ownKeys: () => storage.keys(),
    getOwnPropertyDescriptor: (_target, key) => typeof key === "string" && storage.getItem(key) !== null
      ? { configurable: true, enumerable: true, value: storage.getItem(key) } : undefined,
  }));
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
  define("navigator", { languages: ["ko"], language: "ko", onLine: true });
  define("location", { hash: "", pathname: "/", search: "", origin: ORIGIN, protocol: "https:", host: "phone.example" });
  define("history", { replaceState: () => undefined, pushState: () => undefined });
  define("window", { addEventListener: () => undefined, isSecureContext: false, matchMedia: () => ({ matches: false }) });
  define("matchMedia", () => ({ matches: false }));
  define("requestAnimationFrame", (fn: () => void) => { fn(); return 0; });
  define("ResizeObserver", class { observe(): void {} disconnect(): void {} });
  // The app's own clocks are not under test and would hold the process open; Link's timers are
  // cleared by link.stop() at the end of each test.
  define("setInterval", () => 0);
  define("clearInterval", () => undefined);
  return {
    el, sheet: () => el("#sheet"), body: () => el("#worker-body"),
    main: () => el("#main"), list: () => el("#home-list"),
    fire: (key: string, type: string, ev: unknown) => { for (const fn of handlers.get(key)?.[type] ?? []) fn(ev); },
  };
}

/** An element in a list: keyed like the row it stands for, with its place on screen. */
export function row(key: string, top: number, height: number): Element {
  const box: Box = { top, bottom: top + height, left: 0, right: 0, width: 0, height };
  return {
    dataset: { key, ver: "" }, innerHTML: "", value: "", hidden: false, className: "", scrollTop: 0,
    scrollHeight: 0, clientHeight: 0, children: [], box, getBoundingClientRect: () => box,
    addEventListener: () => undefined, removeEventListener: () => undefined, append: () => undefined,
    remove: () => undefined, focus: () => undefined, setAttribute: () => undefined, replaceWith: () => undefined,
    insertBefore: () => undefined, removeChild: () => undefined, disconnect: () => undefined, observe: () => undefined,
    querySelector: () => null, querySelectorAll: () => [], getElementsByTagName: () => [],
  } as unknown as Element;
}

/** Rows laid out in a scrolling container, as a browser gives them: `top` is the row's place in the
 * content, and the box it reports moves with the container's scroll position, exactly as a real one
 * does. A test that wants content to grow around the reader changes these places. */
export function contentRows(main: Element, rows: readonly { key: string; top: number; height: number }[]): Element[] {
  return rows.map(({ key, top, height }) => {
    const made = row(key, top, height);
    made.getBoundingClientRect = () => {
      const at = top - main.scrollTop;
      return { top: at, bottom: at + height, left: 0, right: 0, width: 0, height };
    };
    return made;
  });
}
