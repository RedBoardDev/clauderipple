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
  applyPickerSelections: (next: Config, selections: Entry[], preserveWindows?: boolean) => Config;
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
  // A domain ladder is the general one folded into two levels: light's list for light and ordinary
  // work, plan's for hard work and plans.
  assert.deepEqual(copied, { light: original.light, standard: original.light, hard: original.plan, plan: original.plan });
  assert.notEqual(copied.light![0]!.target, original.light![0]!.target);
  rows = ui.rows();
  // Two rows only: the light level and the heavy one.
  assert.equal(find(rows, 'worker:base:ui:light:0')!.attrs['aria-label'], 'mod.domainLevel.light 1');
  assert.equal(find(rows, 'worker:base:ui:heavy:0')!.attrs['aria-label'], 'mod.domainLevel.heavy 1');
  assert.equal(find(rows, 'worker:base:ui:standard:0'), undefined);
  const select = find(rows, 'worker:base:ui:light:0')!;
  select.value = 'general-purpose+sonnet|high'; select.events.change!();
  // The light level edits light and standard; the heavy level edits hard and plan.
  for (const rung of ['light', 'standard'] as const) assert.equal(ui.state.settings.domainRules!.ui!.rungs[rung]![0]!.target.model, 'sonnet', rung);
  assert.notEqual(ui.state.settings.domainRules!.ui!.rungs.hard![0]!.target.model, 'sonnet');
  const heavy = find(ui.rows(), 'worker:base:ui:heavy:0')!;
  heavy.value = 'general-purpose+opus|high'; heavy.events.change!();
  for (const rung of ['hard', 'plan'] as const) assert.equal(ui.state.settings.domainRules!.ui!.rungs[rung]![0]!.target.model, 'opus', rung);
  for (const rung of ['light', 'standard'] as const) assert.equal(ui.state.settings.domainRules!.ui!.rungs[rung]![0]!.target.model, 'sonnet', rung);
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
    light: mode.rungs.light, standard: mode.rungs.light, hard: mode.rungs.plan, plan: mode.rungs.plan,
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

const dashboardSource = fs.readFileSync(new URL('../../ui/app.js', import.meta.url), 'utf8');
function dashboardBlock(from: string, to: string): string {
  const start = dashboardSource.indexOf(from), end = dashboardSource.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `missing dashboard block: ${from}`);
  return dashboardSource.slice(start, end);
}
const mergeBlock = dashboardBlock('function modChanges(', '/** Take the router');

type Model = { id: string; name?: string; contextWindow?: number };
type SavedProvider = {
  type: string; url?: string; models: Model[]; headers?: Record<string, string>;
  caps?: Record<string, unknown>; credentials?: { id: string; headers: Record<string, string> }[];
};
type SavedRoute = { provider: string; model: string; effort?: string; fallbacks?: { provider: string; model: string }[]; contextWindow?: number };
type SavedConfig = {
  providers: Record<string, SavedProvider>; routes: Record<string, SavedRoute>;
  cli: { extraModels: { model: string; name?: string; contextWindow?: number }[] };
  direct: { prefix: string; provider: string }[]; configRevision?: string; autoUpdate?: boolean;
};
function saveFixture(): SavedConfig {
  return {
    providers: { p: { type: 'openai-compatible', url: 'https://example.test/v1', models: [{ id: 'one' }, { id: 'two' }], headers: { authorization: 'Bearer original' } } },
    routes: {}, cli: { extraModels: [{ model: 'one' }, { model: 'two' }] }, direct: [],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// A small DOM boundary; the actual checklist, provider form and its save/list handlers run below.
type UiEvent = { key: string; isComposing: boolean; preventDefault(): void; stopPropagation(): void };
class SaveNode {
  children: SaveNode[] = [];
  parent: SaveNode | null = null;
  value: string;
  checked: boolean;
  disabled = false;
  textContent = '';
  placeholder: string;
  type: string;
  dataset: Record<string, string> = {};
  listeners = new Map<string, ((event: UiEvent) => unknown)[]>();
  readonly tag: string;
  readonly attrs: Record<string, unknown>;
  constructor(tag: string, attrs: Record<string, unknown> = {}, children: SaveNode[] = []) {
    this.tag = tag; this.attrs = attrs;
    this.value = String(attrs.value ?? ''); this.checked = Boolean(attrs.checked); this.type = String(attrs.type ?? ''); this.placeholder = String(attrs.placeholder ?? '');
    for (const [key, fn] of Object.entries(attrs)) if (key.startsWith('on') && typeof fn === 'function') this.addEventListener(key.slice(2), fn as (event: UiEvent) => unknown);
    this.append(...children);
  }
  addEventListener(name: string, fn: (event: UiEvent) => unknown) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]); }
  async emit(name: string) {
    for (const fn of this.listeners.get(name) ?? []) await fn({ key: '', isComposing: false, preventDefault() {}, stopPropagation() {} });
    if (name === 'change' && this.parent) await this.parent.emit(name);
  }
  append(...nodes: SaveNode[]) { for (const node of nodes.filter(Boolean)) { node.parent = this; this.children.push(node); } }
  appendChild(node: SaveNode) { this.append(node); return node; }
  replaceChildren(...nodes: SaveNode[]) { this.children = []; this.append(...nodes); }
  replaceWith(node: SaveNode) {
    assert.ok(this.parent); const index = this.parent.children.indexOf(this);
    this.parent.children[index] = node; node.parent = this.parent;
  }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  get readOnly(): boolean { return this.attrs.readonly !== undefined; }
  get childElementCount(): number { return this.children.length; }
  querySelector(selector: string): SaveNode | undefined {
    return this.find(node => selector.startsWith('.') ? String(node.attrs.class ?? '').split(' ').includes(selector.slice(1)) : node.tag === selector);
  }
  find(predicate: (node: SaveNode) => boolean): SaveNode | undefined {
    if (predicate(this)) return this;
    for (const child of this.children) { const found = child.find(predicate); if (found) return found; }
    return undefined;
  }
}
type ProbeResult = { ok: boolean; models: Model[] };
function providerSaveHarness(initial = saveFixture(), probe: Promise<ProbeResult> = Promise.resolve({ ok: true, models: [] })) {
  const h = { initial: structuredClone(initial), latest: structuredClone(initial), writes: [] as SavedConfig[], probes: [] as SavedProvider[], root: null as SaveNode | null, probe, errors: [] as string[] };
  const make = new Function('h', 'el', `
    let currentConfig = clone(h.initial), selectedProviderName, providerDetailTab, slotsLoaded, providersLoaded, clientsLoaded;
    const t = key => key, hint = text => el('small', {text}), selectOption = (value, text) => el('option', {value, text});
    const CHATGPT_MODELS = [], presetById = () => undefined;
    ${dashboardBlock('function modelsOf(', 'function presetById(')}
    ${dashboardBlock('function isKeyProvider(', '/** A key\'s header set:')}
    ${dashboardBlock('function effortSelect(', 'function routeFromTarget(')}
    ${dashboardBlock('function allKnownModelIds(', 'function updateSlotSummary(')}
    ${dashboardBlock('function inputRow(', 'function anthropicSourceText(')}
    const effortLevelsFor = () => ['low', 'high'], fallbackEffortLevels = () => [], hasModelEffortData = () => false, modelEffortTag = () => '';
    const pickerModeOn = () => true, probeProvider = (name, draft) => { h.probes.push(clone(draft)); return h.probe; }, api = () => h.probe;
    const setTimeout = () => 0, startChatgptLogin = () => {}, closeModal = () => {};
    const showModal = form => { h.root = form; }, toast = (message, error) => { if (error) h.errors.push(message); };
    const document = { createTextNode: text => el('text', {text}) };
    const latestConfig = async () => clone(h.latest), configRequest = async next => { h.writes.push(clone(next)); };
    const loadProviders = async () => {}, offerPickerOn = async () => {}, startMeasurement = () => {};
    const confirm = () => true, closeProviderDetail = () => {}, renderProviderWorkspace = () => {};
    ${dashboardBlock('async function removeProvider(', 'function providerTabs(')}
    ${dashboardBlock('function openProviderForm(', '// ---- ClaudeRipple mod')}
    return { open: () => openProviderForm({name:'p', provider:h.initial.providers.p}), remove: () => removeProvider('p', h.initial.providers.p) };
  `);
  const ui = make(h, (tag: string, attrs?: Record<string, unknown>, children?: SaveNode[]) => new SaveNode(tag, attrs, children)) as { open(): void; remove(): Promise<void> };
  const button = (text: string) => { const node = h.root?.find(node => node.tag === 'button' && node.attrs.text === text); assert.ok(node, text); return node; };
  return { h, open: ui.open, remove: ui.remove, button, save: () => button('common.save').emit('click') };
}

test('an older provider form leaves the latest auth key and first pooled credential intact unless a key is typed', async () => {
  const fixture = saveFixture();
  fixture.providers.p!.credentials = [{ id: 'first', headers: { authorization: 'Bearer original' } }, { id: 'second', headers: { authorization: 'Bearer second' } }];
  const ui = providerSaveHarness(fixture); ui.open();
  ui.h.latest.providers.p!.headers = { authorization: 'Bearer rotated' };
  ui.h.latest.providers.p!.credentials![0]!.headers = { authorization: 'Bearer rotated' };
  await ui.save();
  assert.deepEqual(ui.h.writes[0]!.providers.p!.headers, { authorization: 'Bearer rotated' });
  assert.deepEqual(ui.h.writes[0]!.providers.p!.credentials, ui.h.latest.providers.p!.credentials);
  ui.h.root!.find(node => node.type === 'password')!.value = 'replacement';
  await ui.save();
  const saved = ui.h.writes[1]!.providers.p!;
  assert.deepEqual(saved.headers, { authorization: 'Bearer replacement' });
  assert.deepEqual(saved.credentials![0]!.headers, saved.headers);
  assert.deepEqual(saved.credentials![1], fixture.providers.p!.credentials![1]);
  assert.deepEqual(ui.h.errors, []);
});

test('saving a compatible provider keeps its latest unedited capability fields', async () => {
  const ui = providerSaveHarness(); ui.open();
  ui.h.latest.providers.p!.caps = { effortLevels: ['low', 'high'], reasoning: 'effort', images: true, custom: { keep: true } };
  await ui.save();
  assert.deepEqual(ui.h.writes[0]!.providers.p!.caps, ui.h.latest.providers.p!.caps);
});

test('capitalized auth headers survive a save and remain available to the connection probe', async () => {
  for (const [header, value, type] of [['Authorization', 'Bearer mixed', 'openai-compatible'], ['X-API-Key', 'mixed', 'anthropic-compatible']]) {
    const fixture = saveFixture(); fixture.providers.p!.type = type!; fixture.providers.p!.headers = { [header!]: value! };
    const ui = providerSaveHarness(fixture); ui.open();
    assert.equal(ui.h.root!.find(node => node.type === 'password')!.placeholder, 'providers.keySaved');
    await ui.button('providers.check').emit('click');
    assert.deepEqual(ui.h.probes[0]!.headers, { [header!]: value! });
    await ui.save();
    assert.deepEqual(ui.h.writes[0]!.providers.p!.headers, { [header!]: value! });
  }
});

test('provider saves preserve a picker-only context window instead of its catalogue default', async () => {
  const fixture = saveFixture(); fixture.cli.extraModels[0]!.contextWindow = 345678;
  fixture.providers.p!.models[0]!.contextWindow = 100000;
  const ui = providerSaveHarness(fixture); ui.open(); await ui.save();
  assert.equal(ui.h.writes[0]!.cli.extraModels.find(entry => entry.model === 'one')!.contextWindow, 345678);
  // The Clients editor can still explicitly clear an override.
  assert.equal(apply(fixture, [{ id: 'one', provider: 'p' }]).cli!.extraModels![0]!.contextWindow, undefined);
});

test('late compatible and ChatGPT model listings respect checkboxes changed while they were in flight', async () => {
  for (const type of ['openai-compatible', 'chatgpt']) {
    const fixture = saveFixture(); fixture.providers.p!.type = type;
    const pending = deferred<ProbeResult>(), ui = providerSaveHarness(fixture, pending.promise); ui.open();
    const checking = type === 'chatgpt' ? Promise.resolve() : ui.button('providers.check').emit('click');
    const checkbox = ui.h.root!.find(node => node.type === 'checkbox' && node.dataset.model === 'one')!;
    checkbox.checked = false; await checkbox.emit('change');
    pending.resolve({ ok: true, models: [{ id: 'one' }, { id: 'two' }, { id: 'new' }] });
    await checking; await new Promise<void>(resolve => setImmediate(resolve));
    await ui.save();
    assert.deepEqual(ui.h.writes[0]!.providers.p!.models.map(model => model.id), ['two'], type);
  }
});

test('removing a provider keeps shared picker models owned by a different provider', async () => {
  const fixture = saveFixture();
  fixture.providers.q = { type: 'openai-compatible', models: [{ id: 'one' }] };
  fixture.direct = [{ prefix: 'one', provider: 'q' }];
  const ui = providerSaveHarness(fixture); await ui.remove();
  assert.deepEqual(ui.h.writes[0]!.cli.extraModels, [{ model: 'one' }]);
  assert.deepEqual(ui.h.writes[0]!.direct, [{ prefix: 'one', provider: 'q' }]);
  assert.equal(ui.h.writes[0]!.providers.p, undefined);
});

async function pickerWindowHarness(catalogWindows: Record<string, number>) {
  const config = saveFixture();
  config.providers.p = { type: 'chatgpt', models: [{ id: 'gpt-6.1-sol', contextWindow: 272000 }] };
  config.providers.q = { type: 'openai-compatible', models: [{ id: 'other', contextWindow: 800000 }] };
  config.cli.extraModels = [{ model: 'gpt-6.1-sol', contextWindow: 272000 }, { model: 'other', contextWindow: 700000 }];
  const h = { config, catalogWindows, requests: [] as string[], box: new SaveNode('div'), card: new SaveNode('div') };
  const ui = new Function('h', 'el', `
    let currentConfig, pickerContextWindows = {catalogWindows:{}}, clientsLoaded, status = {};
    const t = key => key;
    const CHATGPT_MODELS = [], CSS = {escape: value => value};
    const $ = selector => selector === '#client-picker-models-card' ? h.card : selector === '#client-picker-models' ? h.box
      : h.box.find(node => node.attrs.class === 'model-window' && node.dataset.model === /data-model="([^"]+)"/.exec(selector)?.[1]);
    const $all = () => h.box.children.flatMap(row => row.children[0].children.filter(node => node.type === 'checkbox' && node.checked));
    const hint = text => el('small', {text}), saveClientPickerModels = () => {};
    ${dashboardBlock('function modelsOf(', 'function presetById(')}
    ${dashboardBlock('function discoveredContextWindow(', 'let currentConfig =')}
    ${dashboardBlock('function renderClientPickerModels(', '// Claude Code picks these')}
    ${dashboardBlock('function clientPickerSelections(', 'async function saveClientPickerModels(')}
    const loadCatalogs = async () => {}, renderClients = () => renderClientPickerModels(true);
    const api = async url => { h.requests.push(url); return url === '/api/config' ? h.config : {windows:h.catalogWindows,catalogWindows:h.catalogWindows}; };
    const toast = message => { throw new Error(message); };
    ${dashboardBlock('async function loadClients(', 'async function loadProviders(')}
    return {load:loadClients, selections:clientPickerSelections};
  `)(h, (tag: string, attrs?: Record<string, unknown>, children?: SaveNode[]) => new SaveNode(tag, attrs, children)) as { load(): Promise<void>; selections(): Entry[] };
  await ui.load();
  const field = (model: string) => h.box.find(node => node.attrs.class === 'model-window' && node.dataset.model === model)!;
  return { h, field, selections: ui.selections };
}

test('the picker loads the resolved Codex window, makes it read-only and never saves its display as an override', async () => {
  const ui = await pickerWindowHarness({ 'gpt-6.1-sol': 475000 });
  assert.deepEqual(ui.h.requests, ['/api/config', '/api/context-windows']);
  const field = ui.field('gpt-6.1-sol');
  assert.equal(field.value, '475000');
  assert.equal(field.readOnly, true);
  assert.equal(field.attrs.title, 'slots.windowCodex');
  assert.ok(ui.h.box.find(node => node.tag === 'small' && node.attrs.text === 'slots.windowCodex'), 'visible catalogue note');
  field.value = '500000'; // Even a programmatic change is not an editable override.
  assert.equal(ui.selections().find(entry => entry.id === 'gpt-6.1-sol')?.contextWindow, 272000, 'keep existing stored fallback unchanged');
  ui.h.config.cli.extraModels[0] = { model: 'gpt-6.1-sol' };
  assert.equal(ui.selections().find(entry => entry.id === 'gpt-6.1-sol')?.contextWindow, undefined, 'no new stored override');
  const other = ui.field('other');
  assert.equal(other.value, '700000');
  assert.equal(other.readOnly, false, 'another provider stays editable');
  other.value = '900000';
  assert.equal(ui.selections().find(entry => entry.id === 'other')?.contextWindow, 900000);
});

test('before a Codex window has been read the picker retains its stored editable fallback', async () => {
  const ui = await pickerWindowHarness({});
  const field = ui.field('gpt-6.1-sol');
  assert.equal(field.value, '272000');
  assert.equal(field.readOnly, false);
  assert.equal(ui.h.box.find(node => node.attrs.text === 'slots.windowCodex'), undefined);
  field.value = '300000';
  assert.equal(ui.selections().find(entry => entry.id === 'gpt-6.1-sol')?.contextWindow, 300000);
});

type SlotItem = { id: string; route: { provider: string; model: string } | null; effort: string };
function slotsSaveHarness(config: SavedConfig, rows: SlotItem[], put = async (_next: SavedConfig) => {}) {
  const h = { config, rows, put, writes: [] as SavedConfig[] };
  const ui = new Function('h', `
    const clone = value => JSON.parse(JSON.stringify(value));
    let currentConfig = h.config, slotsLoaded = true;
    const $all = () => h.rows.map(item => ({_get: () => clone(item)}));
    const $ = () => ({classList:{toggle(){}},textContent:''}), t = key => key, updateSlotSummary = () => {};
    const clearTimeout = () => {}, setTimeout = () => 1, effortLevelsFor = () => ['low','high'];
    const latestConfig = async () => h.config;
    const configRequest = async next => { h.writes.push(clone(next)); await h.put(next); h.config = clone(next); };
    ${dashboardBlock('let slotsSaveTimer =', '// ---- Providers')}
    return {saveSlots, scheduleSlotsSave};
  `)(h) as { saveSlots(): Promise<void>; scheduleSlotsSave(): void };
  return { h, ...ui };
}

test('mapping edits preserve fallbacks and context windows on both edited and untouched routes', async () => {
  const fixture = saveFixture();
  fixture.routes = {
    a: { provider: 'p', model: 'one', effort: 'high', fallbacks: [{ provider: 'p', model: 'two' }], contextWindow: 123456 },
    b: { provider: 'p', model: 'two', effort: 'high', contextWindow: 234567, fallbacks: [] },
  };
  const ui = slotsSaveHarness(fixture, [
    { id: 'a', route: { provider: 'p', model: 'one' }, effort: 'low' },
    { id: 'b', route: { provider: 'p', model: 'two' }, effort: 'high' },
  ]);
  await ui.saveSlots();
  assert.deepEqual(ui.h.writes[0]!.routes, { a: { ...fixture.routes.a, effort: 'low' }, b: fixture.routes.b });
});

test('a mapping changed during its previous PUT is saved again without another user action', async () => {
  const pending = deferred<void>();
  let writes = 0;
  const ui = slotsSaveHarness(saveFixture(), [{ id: 'a', route: { provider: 'p', model: 'one' }, effort: 'high' }], async () => { if (++writes === 1) await pending.promise; });
  const saving = ui.saveSlots();
  await new Promise<void>(resolve => setImmediate(resolve));
  ui.h.rows[0]!.route = { provider: 'p', model: 'two' }; ui.scheduleSlotsSave();
  // Even an already scheduled debounce firing while PUT is pending must enqueue, not disappear.
  await ui.saveSlots(); pending.resolve(); await saving;
  assert.equal(ui.h.writes.length, 2);
  assert.equal(ui.h.writes[0]!.routes.a!.model, 'one');
  assert.equal(ui.h.writes[1]!.routes.a!.model, 'two');
});

test('a mode conflict retries only that mode, preserving another window\'s edit, additions and deletions', async () => {
  const base = { modes: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'deleted', name: 'Delete' }] };
  const h = { state: { base, settings: { modes: [{ id: 'a', name: 'Local A' }, { id: 'b', name: 'B' }, { id: 'new', name: 'New' }] }, revision: 1 }, writes: [] as { settings: typeof base; revision: number }[] };
  await new Function('h', `
    const clone = value => JSON.parse(JSON.stringify(value));
    const modState = h.state, modNormalize = clone;
    let modSaving = false, modSaveAgain = false, modSaveTimer = null, modWrites = 0;
    const modRefresh = () => {}, modStatus = () => {}, t = key => key, toast = () => {}, clearTimeout = () => {};
    ${dashboardBlock('function modChanges(', 'function modCap(')}
    const api = async (url, options) => {
      const sent = JSON.parse(options.body); h.writes.push(sent);
      if (h.writes.length === 1) { const error = new Error('conflict'); error.status = 409; error.body = { revision:2, settings:{modes:[{id:'b',name:'Remote B'},{id:'deleted',name:'Remote deleted'},{id:'a',name:'A'},{id:'remote',name:'Remote'}]} }; throw error; }
      return {settings:sent.settings,revision:3};
    };
    ${dashboardBlock('async function saveMod(', 'async function loadMod(')}
    return saveMod();
  `)(h);
  assert.equal(h.writes[1]!.revision, 2);
  assert.deepEqual(h.writes[1]!.settings.modes, [{ id: 'b', name: 'Remote B' }, { id: 'a', name: 'Local A' }, { id: 'remote', name: 'Remote' }, { id: 'new', name: 'New' }]);
});

test('config revision conflicts re-read and reapply only this save; legacy routers keep raw PUTs', async () => {
  for (const versioned of [true, false]) {
    const original = saveFixture(); if (versioned) original.configRevision = 'revision-1';
    const fresh = structuredClone(original); fresh.providers.p!.headers = { Authorization: 'Bearer rotated' }; fresh.configRevision = 'revision-2';
    fresh.providers.p!.models[0]!.contextWindow = 456789;
    fresh.cli.extraModels[1]!.contextWindow = 234567;
    fresh.providers.q = { type: 'openai-compatible', models: [{ id: 'remote' }] };
    fresh.cli.extraModels.push({ model: 'remote', name: 'Remote' });
    const h = { original, fresh, reads: 0, writes: [] as SavedConfig[] };
    const saved = await new Function('h', `
      const clone = value => JSON.parse(JSON.stringify(value)); let currentConfig;
      const toast = () => {};
      const fetch = async (url, options) => {
        if (!options || options.method !== 'PUT') { h.reads++; return {ok:true,text:async()=>JSON.stringify(h.reads === 1 ? h.original : h.fresh)}; }
        const next = JSON.parse(options.body); h.writes.push(next);
        if (h.original.configRevision && h.writes.length === 1) return {ok:false,status:409,text:async()=>JSON.stringify({error:'conflict',config:h.fresh})};
        return {ok:true,text:async()=>JSON.stringify(h.original.configRevision ? {configRevision:'revision-3'} : {ok:true})};
      };
      ${mergeBlock}
      ${dashboardBlock('const configSnapshots =', 'function modelsOf(')}
      return (async () => { const next = clone(await latestConfig()); next.autoUpdate = false; next.cli.extraModels[0].name = 'Local one'; next.providers.p.models[0].name = 'Local model'; await configRequest(next); return next; })();
    `)(h) as SavedConfig;
    assert.equal(saved.autoUpdate, false);
    assert.equal(h.writes.length, versioned ? 2 : 1);
    if (versioned) {
      assert.equal(h.reads, 2);
      assert.deepEqual(h.writes[1]!.providers.p!.headers, fresh.providers.p!.headers);
      assert.deepEqual(h.writes[1]!.providers.p!.models[0], { id: 'one', contextWindow: 456789, name: 'Local model' });
      assert.deepEqual(h.writes[1]!.cli.extraModels, [{ model: 'one', name: 'Local one' }, { model: 'two', contextWindow: 234567 }, { model: 'remote', name: 'Remote' }]);
      assert.equal(h.writes[1]!.configRevision, 'revision-2');
      assert.equal(saved.configRevision, 'revision-3');
    } else assert.equal(Object.hasOwn(h.writes[0]!, 'configRevision'), false);
  }
});
