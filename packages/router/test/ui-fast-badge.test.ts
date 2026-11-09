// A request made on the Fast tier is marked FAST in the dashboard's recent-requests table, and its
// expanded detail shows the requested and the served tier side by side (#97). The mark follows the
// requested tier: the ChatGPT sign-in often serves `default` for a request made on `priority` (#54).
// The dashboard is a classic script, so its row and detail builders are evaluated straight from the
// source text, as the other UI tests do, on a minimal stand-in for the DOM they build with.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../ui");

type FakeNode = { tag: string; className: string; textContent: string; attrs: Record<string, string>; children: FakeNode[] };
type Record_ = { id: string; at: string; ms: number; kind: string; source: string; target: string; provider: string; ok: boolean; status: number; requestedTier?: string; servedTier?: string; effort?: string };
type Builders = { requestRow: (record: Record_) => FakeNode; requestDetail: (record: Record_) => FakeNode };

function sourceBetween(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `app.js no longer contains ${from} through ${to}`);
  return source.slice(start, end);
}

function loadI18n(): Record<string, Record<string, string>> {
  const source = fs.readFileSync(path.join(uiDir, "i18n.js"), "utf8");
  const start = source.indexOf("const I18N = {");
  const end = source.indexOf("\n};", start);
  assert.ok(start > 0 && end > start, "i18n.js no longer contains the dictionary");
  return new Function(`${source.slice(start, end + 3)}; return I18N;`)() as Record<string, Record<string, string>>;
}

function load(): Builders {
  const app = fs.readFileSync(path.join(uiDir, "app.js"), "utf8");
  const i18n = loadI18n();
  const code = [
    sourceBetween(app, "function el(", "// Inside the ClaudeRipple app"),
    sourceBetween(app, "function totalInputOf", "function renderRequests"),
  ].join("\n");
  class Node_ {
    tag: string; className = ""; textContent = ""; attrs: Record<string, string> = {}; children: Node_[] = [];
    constructor(tag: string) { this.tag = tag; }
    setAttribute(key: string, value: string): void { this.attrs[key] = String(value); }
    addEventListener(): void {}
    append(...nodes: Node_[]): void { this.children.push(...nodes); }
    appendChild(node: Node_): Node_ { this.children.push(node); return node; }
  }
  const document = { createElement: (tag: string) => new Node_(tag), createTextNode: (text: string) => Object.assign(new Node_("#text"), { textContent: text }) };
  const t = (key: string, vars?: Record<string, string | number>) => (i18n.en![key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name]));
  const stubs = {
    t, document, Node: Node_,
    timeOf: () => "12:00", formatSeconds: () => "1s", formatNumber: (n: number) => String(n),
    providerClass: () => "provider-chatgpt", providerLabel: (name: string) => name,
    renderRequests: () => undefined, requestRows: [], expandedRequestId: null,
  };
  return new Function(...Object.keys(stubs), `${code}; return { requestRow, requestDetail };`)(...Object.values(stubs)) as Builders;
}

function walk(node: FakeNode, visit: (n: FakeNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}
function texts(node: FakeNode): string[] {
  const out: string[] = [];
  walk(node, (n) => { if (n.textContent) out.push(n.textContent); });
  return out;
}
function tags(node: FakeNode): FakeNode[] {
  const out: FakeNode[] = [];
  walk(node, (n) => { if (n.className === "fast-tag") out.push(n); });
  return out;
}

const BASE: Record_ = { id: "req-1", at: "2026-10-26T00:00:00Z", ms: 1200, kind: "messages", source: "gpt-6.1-sol", target: "gpt-6.1-sol", provider: "chatgpt", ok: true, status: 200, effort: "high" };

test("a request made on the priority tier carries a FAST badge beside its provider", () => {
  const { requestRow } = load();
  const row = requestRow({ ...BASE, requestedTier: "priority" });
  const found = tags(row);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.textContent, "FAST");
  assert.ok(found[0]!.attrs.title, "the badge explains itself in a tooltip");
  const models = row.children.find((cell) => cell.className === "c-model")!.children[0]!;
  assert.deepEqual(models.children.map((n) => n.className).slice(-2), ["provider-badge provider-chatgpt", "fast-tag"]);
});

test("the badge follows the requested tier, not the served one", () => {
  const { requestRow } = load();
  assert.equal(tags(requestRow({ ...BASE, requestedTier: "priority", servedTier: "default" })).length, 1);
  assert.equal(tags(requestRow({ ...BASE, servedTier: "priority" })).length, 0);
});

test("a request without the priority tier has no FAST badge", () => {
  const { requestRow } = load();
  assert.equal(tags(requestRow(BASE)).length, 0);
  assert.equal(tags(requestRow({ ...BASE, requestedTier: "flex", servedTier: "default" })).length, 0);
});

test("the expanded detail shows the requested and the served tier together", () => {
  const { requestDetail } = load();
  const shown = texts(requestDetail({ ...BASE, requestedTier: "priority", servedTier: "default" }));
  assert.ok(shown.includes("Requested tier / Served tier"));
  assert.ok(shown.includes("priority / default"));
  // Only one of the two known: the other reads as none, not as a blank or `undefined`.
  assert.ok(texts(requestDetail({ ...BASE, requestedTier: "priority" })).includes("priority / None"));
});

test("a request that reports no tier has no tier line in its detail", () => {
  const { requestDetail } = load();
  assert.ok(!texts(requestDetail(BASE)).includes("Requested tier / Served tier"));
});

test("every dashboard language words the badge's tooltip and the tier line", () => {
  const i18n = loadI18n();
  for (const [lang, dict] of Object.entries(i18n)) {
    assert.ok(dict["logs.fastHelp"], `${lang}: logs.fastHelp`);
    assert.ok(dict["logs.detail.tier"], `${lang}: logs.detail.tier`);
  }
  assert.equal(i18n.ko!["logs.detail.tier"], "요청 등급 / 실제 등급");
});
