// Run the dashboard's actual account renderers and async button handlers with a local DOM/API boundary.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../../ui/app.js", import.meta.url), "utf8");
function block(from: string, to: string): string {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `missing dashboard block: ${from}`);
  return source.slice(start, end);
}

class AccountNode {
  children: AccountNode[];
  disabled = false;
  hidden = false;
  textContent: string;
  listeners = new Map<string, (() => unknown)[]>();
  readonly tag: string;
  readonly attrs: Record<string, unknown>;
  constructor(tag: string, attrs: Record<string, unknown> = {}, children: AccountNode[] = []) {
    this.tag = tag;
    this.attrs = attrs;
    this.children = children.filter(Boolean);
    this.textContent = String(attrs.text ?? "");
  }
  addEventListener(name: string, callback: () => unknown) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]);
  }
  async emit(name: string) {
    for (const callback of this.listeners.get(name) ?? []) await callback();
  }
  replaceChildren(...children: AccountNode[]) { this.children = children.filter(Boolean); }
  find(predicate: (node: AccountNode) => boolean): AccountNode | undefined {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const found = child.find(predicate);
      if (found) return found;
    }
    return undefined;
  }
}

type Account = {
  id: string; label: string; paused: boolean; preferred: boolean; state: string; inUse: boolean;
  source?: string; external?: boolean; cooldownSeconds?: number; sameAsCurrent?: boolean; expiresAt?: number;
};
type AccountData = { current: Account | null; accounts: Account[] };
type Request = { path: string; method: string; body?: Record<string, unknown> };

function currentAccount(change: Partial<Account> = {}): Account {
  return { id: "current", label: "Current Claude login", source: "claude-code", external: true, paused: false, preferred: false, state: "ready", inUse: true, ...change };
}
function storedAccount(change: Partial<Account> = {}): Account {
  return { id: "stored", label: "Stored account", paused: false, preferred: false, state: "ready", inUse: false, expiresAt: Date.now() + 3_600_000, ...change };
}

function accountHarness(initial: AccountData = { current: currentAccount(), accounts: [] }) {
  const h = {
    data: structuredClone(initial), requests: [] as Request[], errors: [] as unknown[][],
    failPatch: false, rows: new AccountNode("div"), count: new AccountNode("span"), note: new AccountNode("p"),
  };
  const api = async (path: string, options?: { method?: string; body?: string }) => {
    const method = options?.method ?? "GET";
    const body = options?.body ? JSON.parse(options.body) as Record<string, unknown> : undefined;
    h.requests.push({ path, method, ...(body ? { body } : {}) });
    if (method === "GET") {
      assert.equal(path, "/api/claude-accounts");
      return structuredClone(h.data);
    }
    if (method === "PATCH") {
      if (h.failPatch) throw new Error("Account update failed");
      const id = decodeURIComponent(path.slice("/api/claude-accounts/".length));
      const account = id === "current" ? h.data.current : h.data.accounts.find(row => row.id === id);
      assert.ok(account);
      assert.ok(body);
      if (typeof body.paused === "boolean") account.paused = body.paused;
      if (body.clearCooldown === true) delete account.cooldownSeconds;
      account.state = account.paused ? "paused" : account.cooldownSeconds ? "cooling" : "ready";
      account.inUse = !account.paused && account.state === "ready";
      return { ok: true };
    }
    assert.equal(method, "PUT");
    assert.equal(path, "/api/claude-accounts");
    assert.deepEqual(body, { preferred: null });
    for (const account of h.data.accounts) account.preferred = false;
    return { ok: true };
  };
  const make = new Function("h", "el", "api", `
    const providerDetailGeneration = 1, selectedProviderName = 'claude', providerDetailTab = 'accounts';
    const t = key => key, hint = text => el('small', {text}), anthropicSourceText = source => source;
    const toast = (...args) => h.errors.push(args);
    const $ = selector => selector === '#claude-account-rows' ? h.rows : selector === '#claude-account-count' ? h.count : selector === '#claude-account-prefer' ? h.note : null;
    const confirm = () => { throw new Error('Unexpected destructive account action'); };
    ${block("function claudeAccountLabel(", "function anthropicAccountsPanel(")}
    ${block("function chatgptQuotaText(", "async function patchChatgptAccount(")}
    return () => renderClaudeAccountRows(h.rows, h.data, 'claude', 1);
  `);
  const render = make(h, (tag: string, attrs?: Record<string, unknown>, children?: AccountNode[]) => new AccountNode(tag, attrs, children), api) as () => void;
  render();
  const row = (label: string) => {
    const node = h.rows.children.find(card => card.find(child => child.tag === "strong" && child.textContent === label));
    assert.ok(node, `missing account row: ${label}`);
    return node;
  };
  const current = () => row("providers.anthropicCurrentLogin");
  const button = (card: AccountNode, key: string) => {
    const node = card.find(child => child.tag === "button" && child.textContent === key);
    assert.ok(node, `missing button: ${key}`);
    return node;
  };
  return { h, current, row, button };
}

test("the native Claude account pauses and resumes through PATCH and a real GET rerender", async () => {
  const ui = accountHarness();
  await ui.button(ui.current(), "providers.chatgptPause").emit("click");
  assert.deepEqual(ui.h.requests, [
    { path: "/api/claude-accounts/current", method: "PATCH", body: { paused: true } },
    { path: "/api/claude-accounts", method: "GET" },
  ]);
  assert.ok(ui.current().find(node => node.textContent === "providers.chatgptPaused"));
  assert.equal(ui.current().find(node => node.textContent === "providers.chatgptPause"), undefined);
  await ui.button(ui.current(), "providers.chatgptResume").emit("click");
  assert.deepEqual(ui.h.requests.slice(2), [
    { path: "/api/claude-accounts/current", method: "PATCH", body: { paused: false } },
    { path: "/api/claude-accounts", method: "GET" },
  ]);
  assert.ok(ui.current().find(node => node.textContent === "providers.chatgptInUse"));
  assert.equal(ui.current().find(node => node.textContent === "providers.chatgptPaused"), undefined);
  assert.ok(ui.button(ui.current(), "providers.chatgptPause"));
});

test("the paused native Claude account clears cooldown without resuming", async () => {
  const ui = accountHarness({ current: currentAccount({ paused: true, state: "paused", inUse: false, cooldownSeconds: 120 }), accounts: [] });
  await ui.button(ui.current(), "providers.chatgptClearCooldown").emit("click");
  assert.deepEqual(ui.h.requests, [
    { path: "/api/claude-accounts/current", method: "PATCH", body: { clearCooldown: true } },
    { path: "/api/claude-accounts", method: "GET" },
  ]);
  assert.equal(ui.h.data.current?.paused, true);
  assert.ok(ui.current().find(node => node.textContent === "providers.chatgptPaused"));
  assert.ok(ui.button(ui.current(), "providers.chatgptResume"));
  assert.equal(ui.current().find(node => node.textContent === "providers.chatgptClearCooldown"), undefined);
});

test("native Claude Use first keeps PUT null without native rename or removal controls", async () => {
  const ui = accountHarness({ current: currentAccount(), accounts: [storedAccount({ preferred: true })] });
  assert.equal(ui.current().find(node => node.textContent === "common.edit" || node.textContent === "common.remove" || node.textContent === "providers.preferClear"), undefined);
  await ui.button(ui.current(), "providers.preferAction").emit("click");
  assert.deepEqual(ui.h.requests, [
    { path: "/api/claude-accounts", method: "PUT", body: { preferred: null } },
    { path: "/api/claude-accounts", method: "GET" },
  ]);
  assert.equal(ui.current().find(node => node.tag === "button" && node.textContent === "providers.preferAction"), undefined);
  assert.ok(ui.current().find(node => node.textContent === "providers.preferBadge"));
});

test("a paused stored copy of the current Claude login stays visible and resumes by its own id", async () => {
  const ui = accountHarness({ current: currentAccount(), accounts: [storedAccount({ sameAsCurrent: true, paused: true, state: "paused" })] });
  await ui.button(ui.row("Stored account"), "providers.chatgptResume").emit("click");
  assert.deepEqual(ui.h.requests, [
    { path: "/api/claude-accounts/stored", method: "PATCH", body: { paused: false } },
    { path: "/api/claude-accounts", method: "GET" },
  ]);
  assert.equal(ui.h.data.current?.paused, false);
  assert.equal(ui.h.rows.children.length, 1, "both unpaused copies merge again after resuming");
});

test("stored Claude duplicates remain visible while the current login is paused", () => {
  for (const paused of [false, true]) {
    const ui = accountHarness({ current: currentAccount({ paused: true, state: "paused", inUse: false }), accounts: [storedAccount({ sameAsCurrent: true, paused, state: paused ? "paused" : "ready" })] });
    assert.equal(ui.h.rows.children.length, 2);
    assert.ok(ui.button(ui.row("Stored account"), paused ? "providers.chatgptResume" : "providers.chatgptPause"));
    assert.equal(ui.current().find(node => node.textContent === "providers.anthropicRemoveOld"), undefined);
  }
});

test("a failed native Claude pause keeps the rendered state and re-enables its button", async () => {
  const ui = accountHarness();
  ui.h.failPatch = true;
  const current = ui.current();
  const pause = ui.button(current, "providers.chatgptPause");
  const pending = pause.emit("click");
  assert.equal(pause.disabled, true);
  await pending;
  assert.equal(pause.disabled, false);
  assert.equal(ui.current(), current, "failure must not replace the ready row");
  assert.equal(ui.h.data.current?.paused, false);
  assert.equal(current.find(node => node.textContent === "providers.chatgptPaused"), undefined);
  assert.deepEqual(ui.h.requests, [{ path: "/api/claude-accounts/current", method: "PATCH", body: { paused: true } }]);
  assert.deepEqual(ui.h.errors, [["common.actionFailed", true, "Account update failed"]]);
});

test("stored Claude accounts retain their existing pause and preference controls", async () => {
  const ui = accountHarness({ current: null, accounts: [storedAccount()] });
  const card = ui.row("Stored account");
  assert.ok(ui.button(card, "providers.preferAction"));
  await ui.button(card, "providers.chatgptPause").emit("click");
  assert.deepEqual(ui.h.requests, [
    { path: "/api/claude-accounts/stored", method: "PATCH", body: { paused: true } },
    { path: "/api/claude-accounts", method: "GET" },
  ]);
  assert.ok(ui.button(ui.row("Stored account"), "providers.chatgptResume"));
});

test("every dashboard language explains native Claude local pause and supplies account control labels", () => {
  const dictionarySource = fs.readFileSync(new URL("../../ui/i18n.js", import.meta.url), "utf8");
  const start = dictionarySource.indexOf("const I18N = {"), end = dictionarySource.indexOf("\n};", start);
  assert.ok(start >= 0 && end > start);
  const dictionaries = new Function(`${dictionarySource.slice(start, end + 3)}; return I18N;`)() as Record<string, Record<string, string>>;
  assert.equal(Object.keys(dictionaries).length, 6);
  for (const [language, dictionary] of Object.entries(dictionaries)) {
    for (const key of ["providers.currentAccountHelp", "providers.chatgptPause", "providers.chatgptResume", "providers.chatgptPaused", "providers.chatgptClearCooldown"]) {
      assert.ok(dictionary[key], `${language}: ${key}`);
    }
    for (const product of ["ClaudeRipple", "Claude Code", "Claude Desktop"]) assert.ok(dictionary["providers.currentAccountHelp"]!.includes(product), `${language}: local ownership hint mentions ${product}`);
  }
  const english = dictionaries.en!["providers.currentAccountHelp"]!;
  assert.match(english, /Pausing only stops ClaudeRipple from using this login/);
  assert.match(english, /does not sign out or change Claude Code or Claude Desktop/);
  assert.match(english, /cannot remove/);
  assert.match(english, /Separately added OAuth grants have their own pause controls/);
});
