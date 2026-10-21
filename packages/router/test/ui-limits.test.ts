import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildLimitsAccount } from "../src/limits.ts";

const source = fs.readFileSync(new URL("../../ui/app.js", import.meta.url), "utf8");
const i18nSource = fs.readFileSync(new URL("../../ui/i18n.js", import.meta.url), "utf8");
const dictionaries = new Function(`${i18nSource.slice(0, i18nSource.indexOf("/** The languages offered"))}; return I18N;`)() as Record<string, Record<string, string>>;
const t = (key: string, vars: Record<string, unknown> = {}) => Object.entries(vars).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), dictionaries.en![key] ?? key);

class Element {
  children: Element[];
  style: Record<string, string> = {};
  title: string;
  id = "";
  tabIndex = 0;
  readonly tag: string;
  readonly attrs: Record<string, unknown>;
  constructor(tag: string, attrs: Record<string, unknown> = {}, children: Element[] = []) {
    this.tag = tag;
    this.attrs = attrs;
    this.children = children.filter(Boolean);
    this.title = String(attrs.title ?? "");
  }
  appendChild(child: Element) { this.children.push(child); }
  replaceChildren(...children: Element[]) { this.children = children; }
  addEventListener() {}
  set innerHTML(_value: string) { throw new Error("innerHTML is forbidden"); }
}
const el = (tag: string, attrs: Record<string, unknown> = {}, children: Element[] = []) => new Element(tag, attrs, children);
const text = (node: Element): string => [node.attrs.text, ...node.children.map(text)].filter(Boolean).join(" ");
const findAll = (node: Element, predicate: (node: Element) => boolean): Element[] => [...(predicate(node) ? [node] : []), ...node.children.flatMap((child) => findAll(child, predicate))];
const hasClass = (name: string) => (node: Element) => String(node.attrs.class ?? "").split(" ").includes(name);

function limitsUi(api: (path: string) => Promise<unknown>) {
  const box = el("div", { id: "health-providers" });
  const limits = source.slice(source.indexOf("let limitsSnapshot = null;"), source.indexOf("async function refreshHealth()"));
  const providers = source.slice(source.indexOf("function renderHealthProviders()"), source.indexOf("let statusModBusy"));
  const build = new Function("api", "el", "t", "$", "badge", "hint", `
    const currentConfig = { providers: { claude: { type: "anthropic" }, gpt: { type: "chatgpt" }, other: { type: "openai-compatible" } } }, status = { providers: {} };
    const quotaLine = (name) => "text quota " + name, credentialLine = (name) => el("span", { text: "text pool " + name });
    const providerState = () => null, chevronIcon = () => null, openProvider = () => {}, chatgptLoginButton = () => null, chatgptLoginMessage = "";
    const cell = (label, value, lines) => el("div", { class: "cell" }, [label, ...lines.filter(Boolean).map((line) => typeof line === "string" ? el("span", { text: line }) : line)]);
    ${limits}; ${providers}; return { refreshLimits, limitsAccountRow, limitsWindowRow };`) as (...args: unknown[]) => {
    refreshLimits(): Promise<void>;
    limitsAccountRow(account: unknown, now: number): Element;
    limitsWindowRow(label: string, window: unknown, pace: unknown, weekly: boolean, now: number): Element;
  };
  const ui = build(api, el, t, (selector: string) => selector === "#health-providers" ? box : null,
    (kind: string, label: string) => el("span", { class: `badge ${kind}`, text: label }), (label: string) => el("p", { text: label }));
  return { ...ui, card: box };
}

test("Providers carries each subscription account's limits and marks retained figures stale on failure", async () => {
  const now = Date.now();
  const current = buildLimitsAccount({ id: "current", label: "Current Claude login", active: true, preferred: false, health: { state: "ready" } }, 0,
    [{ kind: "seven_day", used_percent: 125, window_minutes: 10080, reset_at: (now + 3.5 * 86400_000) / 1000 }, { kind: "five_hour", used_percent: 23, window_minutes: 300, reset_at: (now + 134 * 60_000) / 1000 }], { at: now }, now, 300_000);
  const other = buildLimitsAccount({ id: "other", label: "<img src=x onerror=alert(1)>", active: false, preferred: true, health: { state: "cooling", pausedUntil: now + 60_000 } }, 1, [], null, now, 300_000);
  const paths: string[] = [];
  let fail = false;
  const ui = limitsUi(async (path) => {
    paths.push(path);
    if (fail) throw new Error("offline");
    return { providers: [{ type: "anthropic", provider: "claude", accounts: [current, other] }, { type: "chatgpt", provider: "gpt", accounts: [{ ...other, id: "gpt" }] }] };
  });
  await ui.refreshLimits();
  assert.deepEqual(paths, ["/api/limits"]);
  const rows = findAll(ui.card, hasClass("cell"));
  assert.equal(rows.length, 3, "one row per provider, no separate Limits card");
  assert.equal(findAll(rows[0]!, hasClass("limits-account")).length, 2);
  assert.equal(findAll(rows[1]!, hasClass("limits-account")).length, 1);
  assert.doesNotMatch(text(rows[0]!), /text quota|text pool/, "gauges replace the text lines");
  assert.match(text(rows[2]!), /text quota other/, "a provider without limits keeps its text lines");
  assert.match(text(ui.card), /Active/);
  assert.match(text(ui.card), /Preferred/);
  assert.match(text(ui.card), /Paused until/);
  assert.match(text(ui.card), /Unknown/);
  assert.match(text(ui.card), /125%/);
  assert.match(text(ui.card), /ahead by 75 pts/);
  assert.equal(findAll(ui.card, hasClass("limits-pace-tick")).length, 1);
  assert.equal(findAll(ui.card, (n) => n.tag === "img").length, 0, "labels remain text, never HTML");
  assert.match(text(ui.card), /<img src=x/);
  fail = true;
  await ui.refreshLimits();
  assert.match(text(ui.card), /125%/, "last figures remain visible");
  assert.equal(findAll(ui.card, (n) => n.attrs.text === "Stale").length, 3);
});

test("window bars expose the true percentage, named reset times and pace without guessing missing data", () => {
  const ui = limitsUi(async () => ({}));
  const now = Date.parse("2026-10-21T12:00:00Z");
  const five = ui.limitsWindowRow("5 hours", { usedPercent: 23, resetAt: now + 134 * 60_000 }, null, false, now);
  assert.match(text(five), /resets in 2h 14m/);
  const weekly = ui.limitsWindowRow("Weekly", { usedPercent: 125, resetAt: now + 86400_000 }, { expectedPercent: 50, paceDelta: 75 }, true, now);
  const bar = findAll(weekly, (node) => node.attrs.role === "progressbar")[0]!;
  assert.equal(bar.attrs["aria-valuenow"], 100);
  assert.match(String(bar.attrs["aria-valuetext"]), /125%/);
  assert.equal(findAll(weekly, hasClass("limits-fill"))[0]?.style.width, "100%");
  assert.equal(findAll(weekly, hasClass("limits-pace-tick"))[0]?.style.left, "50%");
  assert.match(text(weekly), /resets /);
  const missing = ui.limitsWindowRow("Weekly", { usedPercent: 5 }, null, true, now);
  assert.match(text(missing), /Reset time unknown/);
  assert.equal(findAll(missing, hasClass("limits-pace-tick")).length, 0);
});

test("Status shows Claude usage after reload without config or a fresh observed sign-in source", () => {
  const box = el("div");
  const code = source.slice(source.indexOf("function renderHealthProviders()"), source.indexOf("let statusModBusy"));
  const render = new Function("box", "el", `
    const currentConfig = null, status = {providers: {claude: {type: 'anthropic', authSource: null}}, claude: {accounts: [{id: 'current', label: 'Current', quota: {}}]}};
    const $ = () => box, hint = () => null, t = key => key, quotaLine = () => null, credentialLine = () => null, providerLimits = () => null;
    const chatgptQuotaText = () => '5h 23%', claudeAccountLabel = account => account.label;
    const providerState = () => null, chevronIcon = () => null, cell = (label, value, lines) => el('div', {}, [label, ...lines]);
    ${code}; renderHealthProviders();
  `);
  render(box, el);
  assert.match(text(box), /Current · 5h 23%/);
  assert.match(source.slice(source.indexOf("async function refreshHealth()"), source.indexOf("let updateState")), /refreshLimits\(\)/);
  assert.match(source, /setInterval\(refreshHealth, 5000\)/);
});

test("all locales have Limits vocabulary and ready never means in use", () => {
  const old = new Set(["in use", "사용 중", "使用中", "en uso", "em uso"]);
  for (const locale of Object.values(dictionaries)) {
    assert.ok(locale["pool.ready"] && !old.has(locale["pool.ready"]));
    for (const key of Object.keys(dictionaries.en!).filter((key) => key.startsWith("limits."))) assert.ok(locale[key], key);
  }
});
