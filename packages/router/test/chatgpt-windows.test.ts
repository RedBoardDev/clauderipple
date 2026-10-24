// A ChatGPT-subscription model's window is the live catalogue's effective window, everywhere
// ClaudeRipple reports one to Claude Code — ahead of any stored contextWindow and of
// cli.autoCompactWindow — while every other provider keeps the fallback it had (ARCHITECTURE §4,
// 2026-10-23). The map is process-wide and fed by the adapter, so this file reads it directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, type Config } from "../src/config.ts";
import { parseCodexCatalog } from "../src/providers/chatgpt/catalog.ts";
import { chatgptModelWindow, noteChatgptModelWindows } from "../src/providers/chatgpt/windows.ts";
import { CLI_WINDOW_MAX, injectBootstrap } from "../src/bootstrap.ts";
import { chatPickerModels, injectPickerModels, providerModelWindow } from "../src/picker.ts";

const cfg: Config = {
  ...DEFAULTS,
  providers: {
    // The stored values are the ones a config.json carries today: 272000 everywhere.
    chatgpt: { type: "chatgpt", models: [{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", contextWindow: 272000 }] },
    deepseek: { type: "anthropic-compatible", url: "https://api.deepseek.com/anthropic", models: [{ id: "deepseek-v4.1-flash", name: "DeepSeek" }] },
  },
  routes: {
    "claude-opus-4-7": { provider: "chatgpt", model: "gpt-6.1-sol" },
    "claude-sonnet-5": { provider: "deepseek", model: "deepseek-v4.1-flash" },
  },
  direct: [{ prefix: "gpt-", provider: "chatgpt" }],
  aliases: { sol: "gpt-6.1-sol" },
  cli: { extraModels: [{ model: "gpt-6.1-sol", name: "GPT-6.1 Sol", contextWindow: 272000 }], autoCompactWindow: 258400 },
};

/** The catalogue as measured 2026-10-23: gpt-6.1-sol at 500000 × 95%. */
const catalogue = (contextWindow: number, percent?: number) =>
  parseCodexCatalog({
    models: [{ slug: "gpt-6.1-sol", visibility: "list", context_window: contextWindow, ...(percent === undefined ? {} : { effective_context_window_percent: percent }) }],
  });

const boot = (c: Config) =>
  JSON.parse(injectBootstrap(Buffer.from("{}"), c, []).toString()) as { auto_compact_windows: Record<string, number> };

test("a route alias follows the live catalogue once it has been read, and today's value before", () => {
  assert.equal(chatgptModelWindow(cfg, "claude-opus-4-7"), undefined, "no catalogue read yet");
  assert.equal(boot(cfg).auto_compact_windows["claude-opus-4-7"], 258400, "today's global fallback");
  noteChatgptModelWindows(catalogue(500000, 95));
  assert.equal(boot(cfg).auto_compact_windows["claude-opus-4-7"], 475000, "the route's target is a catalogue model");
});

test("a stored 272000 on the provider model and on the picker entry loses to the catalogue", () => {
  noteChatgptModelWindows(catalogue(500000, 95));
  assert.equal(providerModelWindow(cfg, "gpt-6.1-sol"), 475000);
  assert.equal(providerModelWindow(cfg, "gpt-6.1-sol@high"), 475000, "the @effort suffix does not change the window");
  assert.equal(providerModelWindow(cfg, "sol"), 475000, "nor does the alias");
  assert.equal(providerModelWindow(cfg, "claude-opus-4-7"), 475000, "nor a route key");

  const entries = chatPickerModels(cfg);
  assert.equal(entries.find((e) => e.model === "gpt-6.1-sol")?.contextWindow, 475000);
  assert.equal(boot(cfg).auto_compact_windows["gpt-6.1-sol"], 475000, "the cli.extraModels path too");

  const json = { model_selector_config: [{ id: "code", models: [{ id: "claude-opus-4-8", name: "Opus 4.8" }], context_window_by_model: {} as Record<string, number> }] };
  injectPickerModels(json, entries, cfg.cli.autoCompactWindow);
  assert.equal(json.model_selector_config[0]!.context_window_by_model["gpt-6.1-sol"], 475000);
});

test("a non-chatgpt route keeps the global fallback", () => {
  noteChatgptModelWindows(catalogue(500000, 95));
  assert.equal(chatgptModelWindow(cfg, "claude-sonnet-5"), undefined);
  assert.equal(providerModelWindow(cfg, "claude-sonnet-5"), undefined);
  assert.equal(boot(cfg).auto_compact_windows["claude-sonnet-5"], 258400);
});

test("an explicit route window still wins over the catalogue", () => {
  noteChatgptModelWindows(catalogue(500000, 95));
  const explicit: Config = {
    ...cfg,
    routes: { ...cfg.routes, "claude-opus-4-7": { provider: "chatgpt", model: "gpt-6.1-sol", contextWindow: 1_000_000 } },
  };
  assert.equal(boot(explicit).auto_compact_windows["claude-opus-4-7"], 1_000_000);
});

// Claude Code drops a per-model window over its 1M ceiling whole, and the model then compacts at
// the session's own setting: Gemini's 1,048,576 never applied (2026-10-24).
test("a window over Claude Code's ceiling is sent at the ceiling, on the picker entry and on a route", () => {
  const over: Config = {
    ...cfg,
    routes: { ...cfg.routes, "claude-sonnet-5": { provider: "deepseek", model: "deepseek-v4.1-flash", contextWindow: 2_000_000 } },
    cli: { ...cfg.cli, extraModels: [...cfg.cli.extraModels, { model: "gemini-3.8-flash", name: "Gemini", contextWindow: 1_048_576 }] },
  };
  assert.equal(boot(over).auto_compact_windows["gemini-3.8-flash"], CLI_WINDOW_MAX);
  assert.equal(boot(over).auto_compact_windows["claude-sonnet-5"], CLI_WINDOW_MAX);
  assert.equal(CLI_WINDOW_MAX, 1_000_000);
});
