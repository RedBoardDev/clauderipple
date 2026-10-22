// The GUI decides what the Claude app picker offers. The function runs in a browser as a classic
// script, so the test evaluates it straight from the source text and hands it a stub for the one
// helper it calls. What is fixed here: a model no provider offers any more must not survive, since
// nothing in the interface can uncheck it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Entry = { id: string; name?: string; provider: string; contextWindow?: number };
type Config = {
  providers: Record<string, { type?: string; accountPool?: boolean; models?: { id: string; name?: string }[] }>;
  cli?: { extraModels?: { model: string; name?: string; contextWindow?: number }[] };
  direct?: { prefix: string; provider: string }[];
};

type PickerBlock = {
  applyPickerSelections: (next: Config, selections: Entry[]) => Config;
  pickerSelectionsExcept: (config: Config, providerName: string) => Entry[];
};

function loadPickerBlock(): PickerBlock {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../ui/app.js");
  const source = fs.readFileSync(file, "utf8");
  const start = source.indexOf("function allKnownModelIds");
  const end = source.indexOf("function updateSlotSummary");
  assert.ok(start > 0 && end > start, "app.js no longer contains the picker-selection block");
  const make = new Function(
    "groupedModels",
    `${source.slice(start, end)}; return { applyPickerSelections, pickerSelectionsExcept };`,
  ) as (groupedModels: unknown) => PickerBlock;
  // The real helper groups a config's providers; only the model ids matter here.
  return make((config: Config) =>
    Object.entries(config.providers).map(([name, p]) => ({ name, models: p.models ?? [] })),
  );
}

function loadGroupedModels(): (config: Config) => { name: string }[] {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../ui/app.js");
  const source = fs.readFileSync(file, "utf8");
  const start = source.indexOf("function modelsOf");
  const end = source.indexOf("function presetById");
  assert.ok(start > 0 && end > start, "app.js no longer contains the provider-grouping block");
  return new Function(`${source.slice(start, end)}; return groupedModels;`)() as (config: Config) => { name: string }[];
}

test("live provider exhaustion beats a green connection probe and disappears after recovery", () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../ui/app.js");
  const source = fs.readFileSync(file, "utf8");
  const start = source.indexOf("function providerConnection(");
  const end = source.indexOf("function providerState(");
  const status: { providers: Record<string, { reachable: boolean; exhaustion?: { reason: string; until: number } }> } = { providers: { p: { reachable: true, exhaustion: { reason: 'insufficient_balance', until: Date.now() + 60_000 } } } };
  const make = new Function('status', 'stateFor', 'probeIsStale', 't', `${source.slice(start, end)}; return providerConnection;`) as (status: unknown, state: () => unknown, stale: () => boolean, t: (s: string) => string) => (name: string) => { level: string; text: string };
  const connection = make(status, () => ({ ok: true }), () => false, key => key);
  assert.equal(connection('p').level, 'warn');
  assert.match(connection('p').text, /insufficient balance/);
  delete status.providers.p!.exhaustion;
  assert.equal(connection('p').level, 'ok');
});

test("mode reset needs a known future timestamp; Claude uses its binding window", () => {
  const source = fs.readFileSync(new URL('../../ui/app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function modQuotaKnown('), source.indexOf('async function modLoadResets('));
  const known = new Function(`${code}; return modQuotaKnown;`)() as (accounts: unknown[], binding?: boolean) => boolean;
  const window = (used_percent: number, seconds: number) => ({ used_percent, reset_at: Date.now() / 1000 + seconds });
  assert.equal(known([{ state: 'ready', quota: null }]), false);
  assert.equal(known([{ state: 'paused', quota: { rate_limits: { primary: window(90, 600) } } }]), false);
  const accounts = [{ quota: { rate_limits: { primary: window(90, -10), secondary: window(20, 600) } } }];
  assert.equal(known(accounts), true);
  assert.equal(known(accounts, true), false);
  accounts[0]!.quota.rate_limits.primary = window(90, 600);
  assert.equal(known(accounts, true), true);
});

test("mode editor keeps reset disabled with an adjacent reason, and enabled controls omit disabled", () => {
  const source = fs.readFileSync(new URL('../../ui/app.js', import.meta.url), 'utf8');
  type Node = { tag: string; attrs: Record<string, unknown>; children: Node[]; value: string; addEventListener: () => void; appendChild: (child: Node) => void; setAttribute: (key: string, value: string) => void; querySelector: (selector: string) => Node | undefined };
  const find = (node: Node, key: string): Node | undefined => node.attrs['data-key'] === key ? node : node.children.map(child => find(child, key)).find(Boolean);
  const el = (tag: string, attrs: Record<string, unknown> = {}, children: Node[] = []): Node => ({ tag, attrs, children, value: '', addEventListener() {}, appendChild(child) { this.children.push(child); }, setAttribute(key, value) { this.attrs[key] = value; }, querySelector(selector) { return find(this, /data-key="([^"]+)"/.exec(selector)?.[1] ?? ''); } });
  const segment = source.slice(source.indexOf('function modSegmented('), source.indexOf('/** A pop-up menu.'));
  const section = source.slice(source.indexOf('function modModeSection('), source.indexOf('function modWorkersCard('));
  const build = new Function('el', 'known', 'until', `
    const t = (key, vars) => vars ? key + JSON.stringify(vars) : key, modState = {settings:{}};
    const modResetProviders = known ? ['chatgpt', 'anthropic'] : [], modWorkerRows = () => [];
    const modResetLabel = provider => provider === 'anthropic' ? 'Claude' : 'ChatGPT', modResetDefault = () => modResetProviders[0];
    const modSelect = (key, items, value, label) => el('select', { 'data-key': key, items, value, 'aria-label': label });
    const modUpdateMode = () => {}, modSetActive = () => {}, modRemoveMode = () => {}, modLocalTime = () => '';
    const cell = (label, controls, help) => el('cell', { help }, Array.isArray(controls) ? controls : [controls]);
    const modSection = (title, rows) => el('section', {}, rows);
    ${segment}\n${section}\nreturn modModeSection({id:'test',name:'Test',rungs:{},until:until ?? 'none',delegation:'normal'});
  `) as (make: typeof el, known: boolean, until?: unknown) => Node;
  const disabled = build(el, false);
  const reset = find(disabled, 'mode-until:reset')!;
  assert.equal(Object.hasOwn(reset.attrs, 'disabled'), true);
  assert.equal(reset.attrs['aria-describedby'], 'mode-reset-reason');
  const until = disabled.children.find(row => row.children.some(control => control.children.some(child => child.attrs.role === 'radiogroup' && child.attrs['aria-label'] === 'mod.modeUntil')))!;
  const group = until.children[0]!.children[0]!;
  assert.equal(group.children.at(-1)?.attrs.id, 'mode-reset-reason');
  assert.equal(group.children.at(-1)?.attrs.text, 'mod.modeResetUnknown');
  assert.equal(Object.hasOwn(find(disabled, 'mode-until:time')!.attrs, 'disabled'), false);
  assert.equal(Object.hasOwn(find(build(el, true), 'mode-until:reset')!.attrs, 'disabled'), false);
  assert.equal(find(build(el, true), 'mode-until-reset'), undefined);
  // Reset names its provider: a menu of the known ones, and the line under 종료 시점 names the chosen one.
  const claude = build(el, true, { reset: 'anthropic' });
  const select = find(claude, 'mode-until-reset')!;
  assert.equal(select.attrs.value, 'anthropic');
  assert.deepEqual((select.attrs.items as { value: string; label: string }[]).map(item => [item.value, item.label]), [
    ['chatgpt', 'mod.modeUntilResetOf{"provider":"ChatGPT"}'], ['anthropic', 'mod.modeUntilResetOf{"provider":"Claude"}'],
  ]);
  const help = (node: Node): unknown => node.attrs.help ?? node.children.map(help).find(Boolean);
  assert.equal(help(claude), 'mod.modeResetHelp{"provider":"Claude"}');
  // A saved provider whose reset is not known now stays chosen, marked unavailable.
  const gone = find(build(el, false, { reset: 'chatgpt' }), 'mode-until-reset')!;
  assert.deepEqual((gone.attrs.items as { value: string; label: string }[]).map(item => [item.value, item.label]), [['chatgpt', 'mod.modeUntilResetOf{"provider":"ChatGPT"}mod.unavailable']]);
});

test("domain editors copy, edit and remove only the selected set's rule; new modes deep-copy Base", () => {
  const source = fs.readFileSync(new URL('../../ui/app.js', import.meta.url), 'utf8');
  const block = (from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to));
  type Node = { attrs: Record<string, unknown>; children: Node[]; value: string; checked: boolean; events: Record<string, () => void>; addEventListener: (name: string, fn: () => void) => void; appendChild: (node: Node) => void };
  const el = (_tag: string, attrs: Record<string, unknown> = {}, children: Node[] = []): Node => {
    const node: Node = { attrs, children: children.filter(Boolean), value: String(attrs.value ?? ''), checked: !!attrs.checked, events: {}, addEventListener(name, fn) { this.events[name] = fn; }, appendChild(child) { this.children.push(child); } };
    for (const [key, value] of Object.entries(attrs)) if (key.startsWith('on') && typeof value === 'function') node.events[key.slice(2)] = value as () => void;
    return node;
  };
  const cell = (_label: unknown, controls: Node | Node[], help: unknown) => el('cell', { help }, Array.isArray(controls) ? controls : [controls]);
  const build = new Function('el', 'cell', `
    const t = key => key, clone = value => JSON.parse(JSON.stringify(value));
    const MOD_EFFORTS = ['low','medium','high','xhigh','max'];
    ${block('const MOD_CLAUDE_MODELS', '// `base` is the router')}
    const modState = { settings: clone(MOD_DEFAULTS), options: null };
    let modModeTab = '', modSaveTimer = null;
    const modRefresh = () => {}, modStatus = () => {}, setTimeout = () => 1, clearTimeout = () => {};
    const toast = message => { throw new Error(message); };
    ${block('function modCap(', '/** Rebuild a region')}
    ${block('function modSwitch(', 'function modCard(')}
    ${block('function modPatch(', 'async function saveMod(')}
    ${block('function modChoices(', '// ---- The four workers: a meaning')}
    ${block('function modRungs(', '/** Said once after settings')}
    ${block('function modUpdateMode(', 'function modSetActive(')}
    ${block('function modNewMode(', '/** A datetime-local')}
    return { state: modState, rows: modWorkerRows, create: modNewMode };
  `) as (el: unknown, cell: unknown) => { state: { settings: import('../../mod/types/index.d.ts').Settings }; rows: (mode?: import('../../mod/types/index.d.ts').Mode) => Node[]; create: () => Node };
  const ui = build(el, cell);
  const find = (nodes: Node[], key: string): Node | undefined => {
    for (const node of nodes) { if (node.attrs['data-key'] === key) return node; const found = find(node.children, key); if (found) return found; }
    return undefined;
  };
  const click = (nodes: Node[], key: string) => find(nodes, key)!.events.click!();
  const toggle = (nodes: Node[], key: string, checked: boolean) => { const input = find(nodes, key)!; input.checked = checked; input.events.change!(); };
  // The general tab keeps its four rungs.
  const general = ui.rows();
  for (const rung of ['light', 'standard', 'hard', 'plan']) assert.ok(find(general, `worker:base:general:${rung}:0`), rung);
  click(ui.rows(), 'worker-domain:base:ui');
  let rows = ui.rows();
  assert.equal(rows[1]!.attrs.help, 'mod.domainFollowsGeneral');
  assert.equal(find(rows, 'worker:base:ui:light:0'), undefined);
  toggle(rows, 'worker-separate:base:ui', true);
  const original = ui.state.settings.rules.general.rungs;
  const copied = ui.state.settings.domainRules!.ui!.rungs;
  // A domain ladder is the general one folded into two levels: standard's list for the light pair, plan's for the heavy one.
  assert.deepEqual(copied, { light: original.standard, standard: original.standard, hard: original.plan, plan: original.plan });
  assert.notEqual(copied.light![0]!.target, original.light![0]!.target);
  rows = ui.rows();
  // Two rows only: the light level and the heavy one.
  assert.equal(find(rows, 'worker:base:ui:light:0')!.attrs['aria-label'], 'mod.domainLevel.light 1');
  assert.equal(find(rows, 'worker:base:ui:heavy:0')!.attrs['aria-label'], 'mod.domainLevel.heavy 1');
  assert.equal(find(rows, 'worker:base:ui:standard:0'), undefined);
  const select = find(rows, 'worker:base:ui:light:0')!;
  select.value = 'general-purpose+sonnet|high'; select.events.change!();
  // The light level edits the whole light pair.
  assert.equal(ui.state.settings.domainRules!.ui!.rungs.light![0]!.target.model, 'sonnet');
  assert.equal(ui.state.settings.domainRules!.ui!.rungs.standard![0]!.target.model, 'sonnet');
  assert.equal(original.light![0]!.target.agent, 'deepseek-v4-1-flash');
  // New-mode creation is the actual form handler, not a reconstructed copy operation.
  const form = ui.create();
  find([form], 'mode-new-name')!.value = 'New';
  click([form], 'mode-create');
  const mode = ui.state.settings.modes[0]!;
  assert.deepEqual(mode.domainRules, ui.state.settings.domainRules);
  assert.notEqual(mode.domainRules!.ui!.rungs.light![0]!.target, ui.state.settings.domainRules!.ui!.rungs.light![0]!.target);
  click(ui.rows(mode), `worker-domain:${mode.id}:backend`);
  toggle(ui.rows(mode), `worker-separate:${mode.id}:backend`, true);
  // The mode's own domain ladder is the mode's general rungs, folded the same way.
  assert.deepEqual(ui.state.settings.modes[0]!.domainRules!.backend!.rungs, {
    light: mode.rungs.standard, standard: mode.rungs.standard, hard: mode.rungs.plan, plan: mode.rungs.plan,
  });
  assert.equal(ui.state.settings.domainRules!.backend, undefined);
  toggle(ui.rows(), 'worker-separate:base:ui', false);
  assert.equal(ui.state.settings.domainRules, undefined);
  assert.ok(ui.state.settings.modes[0]!.domainRules!.ui);
  const current = ui.state.settings.modes[0]!;
  toggle(ui.rows(current), `worker-separate:${mode.id}:backend`, false);
  assert.equal(ui.state.settings.modes[0]!.domainRules!.backend, undefined);
  assert.ok(ui.state.settings.modes[0]!.domainRules!.ui);
});

const { applyPickerSelections: apply, pickerSelectionsExcept: except } = loadPickerBlock();
const groups = loadGroupedModels();

function baseConfig(): Config {
  return {
    providers: { openrouter: { models: [{ id: "z-ai/glm-5.3-flash", name: "GLM" }] }, chatgpt: { models: [{ id: "gpt-5.6-terra", name: "Terra" }] } },
    cli: {
      extraModels: [
        { model: "nvidia/nemotron-3.5-lightning:free", name: "Nemotron" },
        { model: "nvidia/nemotron-3.5-lightning:free", name: "Nemotron" },
        { model: "z-ai/glm-5.3-flash", name: "GLM" },
      ],
    },
    direct: [
      { prefix: "gpt-", provider: "chatgpt" },
      { prefix: "nvidia/nemotron-3.5-lightning:free", provider: "openrouter" },
      { prefix: "z-ai/glm-5.3-flash", provider: "openrouter" },
    ],
  };
}

test("only an opted-in native Claude account pool appears in model mapping", () => {
  const config: Config = {
    providers: {
      ingress: { type: "anthropic", models: [{ id: "claude-opus-5" }] },
      pooled: { type: "anthropic", accountPool: true, models: [{ id: "claude-sonnet-5" }] },
      other: { type: "anthropic-compatible", models: [{ id: "deepseek-v4-pro" }] },
    },
  };
  assert.deepEqual(groups(config).map((group) => group.name), ["pooled", "other"]);
});

test("a model no provider offers any more leaves the picker, and takes its direct rule with it", () => {
  const next = apply(baseConfig(), [{ id: "z-ai/glm-5.3-flash", name: "GLM", provider: "openrouter" }]);
  assert.deepEqual(next.cli?.extraModels, [{ model: "z-ai/glm-5.3-flash", name: "GLM" }]);
  assert.deepEqual(next.direct, [
    // Not a model id, so not an orphan: the legacy prefix rule is kept on purpose. The rule for the
    // ticked model is gone with it — one provider offers it, so the router resolves it unaided.
    { prefix: "gpt-", provider: "chatgpt" },
  ]);
});

test("ticking a model no longer writes a rule: one provider offering it is already the answer", () => {
  const next = apply(baseConfig(), [
    { id: "gpt-5.6-terra", name: "Terra", provider: "chatgpt" },
    { id: "gpt-5.6-terra", name: "Terra", provider: "chatgpt" },
  ]);
  assert.deepEqual(next.cli?.extraModels, [{ model: "gpt-5.6-terra", name: "Terra" }], "the same model chosen twice is written once");
  assert.equal(next.direct?.some((rule) => rule.prefix === "gpt-5.6-terra"), false);
});

// The one case the router refuses to guess through, so the one case a rule is still the answer.
function ambiguousConfig(): Config {
  return {
    providers: {
      deepseek: { models: [{ id: "deepseek-v4-pro", name: "DeepSeek Pro" }] },
      "opencode-go": { models: [{ id: "deepseek-v4-pro", name: "DeepSeek Pro" }, { id: "kimi-k3", name: "Kimi" }] },
    },
    cli: { extraModels: [] },
    direct: [{ prefix: "deepseek-v4-pro", provider: "deepseek" }],
  };
}

test("an id two providers offer keeps its rule even though nothing ticked it", () => {
  // It is in no picker list, and dropping it because of that would stop it routing entirely.
  const next = apply(ambiguousConfig(), [{ id: "kimi-k3", name: "Kimi", provider: "opencode-go" }]);
  assert.deepEqual(next.direct, [{ prefix: "deepseek-v4-pro", provider: "deepseek" }]);
  assert.equal(next.direct?.some((rule) => rule.prefix === "kimi-k3"), false, "the unambiguous one needs nothing");
});

test("ticking an ambiguous model writes the rule that says which provider was meant", () => {
  const next = apply(ambiguousConfig(), [{ id: "deepseek-v4-pro", name: "DeepSeek Pro", provider: "opencode-go" }]);
  assert.equal(next.direct?.length, 1);
  assert.equal(next.direct?.[0]?.provider, "deepseek", "an existing rule is the operator's answer and is not overwritten by a tick");
});

test("unchecking every model empties the picker list", () => {
  const next = apply(baseConfig(), []);
  assert.deepEqual(next.cli?.extraModels, []);
  assert.deepEqual(next.direct, [{ prefix: "gpt-", provider: "chatgpt" }]);
});

// The list is rebuilt from the checkboxes on every change, so a window that is not carried through
// would be wiped by the next click on an unrelated model.
test("a model's own context window survives the rebuild; a missing or unusable one is left out", () => {
  const next = apply(baseConfig(), [
    { id: "z-ai/glm-5.3-flash", name: "GLM", provider: "openrouter", contextWindow: 400000 },
    { id: "gpt-5.6-terra", name: "Terra", provider: "chatgpt" },
  ]);
  assert.deepEqual(next.cli?.extraModels, [
    { model: "z-ai/glm-5.3-flash", name: "GLM", contextWindow: 400000 },
    { model: "gpt-5.6-terra", name: "Terra" },
  ]);
});

// What one save of an unrelated provider must leave alone. The rebuild is fed the entries of every
// OTHER provider, because no checkbox on that form can speak for them.
function savedConfig(): Config {
  return {
    providers: {
      chatgpt: { models: [{ id: "gpt-5.6-terra", name: "Terra" }] },
      "opencode-go": { models: [{ id: "deepseek-v4.1-flash" }, { id: "muse-spark-1.3-contributor" }] },
      openrouter: { models: [{ id: "z-ai/glm-5.3-flash", name: "GLM" }] },
    },
    cli: {
      extraModels: [
        { model: "gpt-5.6-terra", name: "Terra" },
        { model: "deepseek-v4.1-flash", name: "deepseek-v4.1-flash", contextWindow: 200000 },
        { model: "muse-spark-1.3-contributor", name: "muse-spark-1.3-contributor" },
        { model: "z-ai/glm-5.3-flash", name: "GLM" },
      ],
    },
    // The legacy prefix, and nothing else: rules stopped being written for unambiguous ids.
    direct: [{ prefix: "gpt-", provider: "chatgpt" }],
  };
}

test("saving one provider leaves every other provider's picker entries standing", () => {
  // The regression this replaces asked `direct` who owned each entry. Only the `gpt-` prefix still
  // matched anything, so saving openrouter emptied the picker of deepseek and muse as well.
  const kept = except(savedConfig(), "openrouter");
  assert.deepEqual(kept.map((entry) => [entry.id, entry.provider]), [
    ["gpt-5.6-terra", "chatgpt"],
    ["deepseek-v4.1-flash", "opencode-go"],
    ["muse-spark-1.3-contributor", "opencode-go"],
  ]);
  assert.equal(kept.find((entry) => entry.id === "deepseek-v4.1-flash")?.contextWindow, 200000, "the window travels with the entry");
});

test("the saved provider's own entries are left to its checkboxes", () => {
  const kept = except(savedConfig(), "opencode-go");
  assert.deepEqual(kept.map((entry) => entry.id), ["gpt-5.6-terra", "z-ai/glm-5.3-flash"]);
});

test("a model the save just unticked is already undeclared, and is not carried back in", () => {
  // The caller updates `next.providers` first, so an unticked model no longer appears anywhere.
  const config = savedConfig();
  config.providers["opencode-go"]!.models = [{ id: "muse-spark-1.3-contributor" }];
  assert.equal(except(config, "chatgpt").some((entry) => entry.id === "deepseek-v4.1-flash"), false);
});

test("an id two providers offer is owned by the rule that says which deal was meant", () => {
  const config = savedConfig();
  config.providers.openrouter!.models = [{ id: "z-ai/glm-5.3-flash", name: "GLM" }, { id: "deepseek-v4.1-flash" }];
  config.direct!.push({ prefix: "deepseek-v4.1-flash", provider: "openrouter" });
  assert.equal(except(config, "chatgpt").find((entry) => entry.id === "deepseek-v4.1-flash")?.provider, "openrouter");
});

test("a Grok form's check keeps what is ticked now; only a new provider's first listing ticks everything", () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../ui/app.js"), "utf8");
  const start = source.indexOf("function grokTickedAfterCheck");
  const end = source.indexOf("}", start) + 1;
  assert.ok(start > 0, "app.js no longer contains grokTickedAfterCheck");
  const ticked = new Function(`${source.slice(start, end)}; return grokTickedAfterCheck;`)() as (first: boolean, tickedIds: string[], listedIds: string[]) => Set<string>;
  const listing = ["grok-4.7", "grok-4.7-fast", "grok-4.6", "grok-4.5"];
  assert.deepEqual([...ticked(true, [], listing)], listing, "a new provider starts with every model");
  // The user unticked two models; a re-check — of a new or a saved provider — leaves them unticked.
  assert.deepEqual([...ticked(false, ["grok-4.7", "grok-4.5"], listing)], ["grok-4.7", "grok-4.5"]);
  assert.deepEqual([...ticked(false, [], listing)], [], "all unticked stays all unticked");
  assert.deepEqual([...ticked(false, ["my-custom"], listing)], ["my-custom"], "a custom model the user added stays ticked");
});
