import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogEntry, catalogueWindow, loadModelCatalog } from "../src/catalog.ts";

// Shapes as models.dev served them 2026-10-02.
const catalog = {
  "opencode-go": {
    npm: "@ai-sdk/openai-compatible",
    models: {
      "glm-5.3-flash": { reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }] },
      "muse-spark-1.3-contributor": { provider: { npm: "@ai-sdk/openai" }, reasoning_options: [{ type: "effort", values: ["minimal", "low", "medium", "high", "xhigh"] }], limit: { context: 1048576, output: 131072 } },
      "minimax-m3": { provider: { npm: "@ai-sdk/anthropic" }, reasoning_options: [{ type: "toggle" }] },
      "mimo-v2.6-pro": { reasoning_options: [] },
      "qwen3.8-max": { provider: { npm: "@ai-sdk/anthropic" }, reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "medium", "xhigh"] }, { type: "budget_tokens", max: 262144 }] },
      "zero-window": { reasoning: true, limit: { context: 0 } },
      "fractional-window": { reasoning: true, limit: { context: 200000.5 } },
      "listed-string-window": { reasoning: true, limit: { context: "1000000" } },
    },
  },
  opencode: {
    npm: "@ai-sdk/openai-compatible",
    models: {
      "gemini-x": { provider: { npm: "@ai-sdk/google" }, reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "high"] }] },
      "kimi-k2": { reasoning: false },
      "no-options": { reasoning: true },
    },
  },
};

test("catalogEntry reads the wire from the model's SDK, else the provider's", () => {
  assert.equal(catalogEntry(catalog, "opencode-go", "glm-5.3-flash")?.wire, "chat");
  assert.equal(catalogEntry(catalog, "opencode-go", "muse-spark-1.3-contributor")?.wire, "responses");
  assert.equal(catalogEntry(catalog, "opencode-go", "minimax-m3")?.wire, "anthropic");
  assert.equal(catalogEntry(catalog, "opencode-zen", "gemini-x")?.wire, undefined, "an SDK we do not speak names no wire");
});

test("catalogEntry takes the effort values as listed, and a toggle or budget is no effort", () => {
  assert.deepEqual(catalogEntry(catalog, "opencode-go", "glm-5.3-flash")?.effortLevels, ["low", "high", "max"]);
  assert.deepEqual(catalogEntry(catalog, "opencode-go", "qwen3.8-max")?.effortLevels, ["low", "medium", "xhigh"]);
  assert.deepEqual(catalogEntry(catalog, "opencode-go", "minimax-m3")?.effortLevels, []);
  assert.deepEqual(catalogEntry(catalog, "opencode-go", "mimo-v2.6-pro")?.effortLevels, []);
  assert.deepEqual(catalogEntry(catalog, "opencode-zen", "kimi-k2")?.effortLevels, [], "a model that does not reason takes no effort");
  assert.equal(catalogEntry(catalog, "opencode-zen", "no-options")?.effortLevels, undefined, "a reasoning model with no options leaves the ladder to measurement");
});

test("catalogEntry reads the context window from limit.context, and only when it is a positive integer", () => {
  assert.equal(catalogEntry(catalog, "opencode-go", "muse-spark-1.3-contributor")?.contextWindow, 1048576);
  assert.equal(catalogEntry(catalog, "opencode-go", "glm-5.3-flash")?.contextWindow, undefined, "an entry with no limit states no window");
  assert.equal(catalogEntry(catalog, "opencode-go", "zero-window")?.contextWindow, undefined);
  assert.equal(catalogEntry(catalog, "opencode-go", "fractional-window")?.contextWindow, undefined);
  assert.equal(catalogEntry(catalog, "opencode-go", "listed-string-window")?.contextWindow, undefined, "a window is a number, not a string");
});

test("catalogEntry says nothing for a preset without a catalogue or a model it does not list", () => {
  assert.equal(catalogEntry(catalog, "deepseek", "glm-5.3-flash"), undefined);
  assert.equal(catalogEntry(catalog, undefined, "glm-5.3-flash"), undefined);
  assert.equal(catalogEntry(catalog, "opencode-go", "brand-new"), undefined);
  assert.equal(catalogEntry(undefined, "opencode-go", "glm-5.3-flash"), undefined);
});

test("loadModelCatalog answers undefined rather than throwing when the catalogue cannot be had", async () => {
  const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  assert.equal(await loadModelCatalog(failing), undefined);
});

// The same model filed under several providers, with the spreads models.dev served on 2026-10-28:
// one reseller stating a quarter of the model's window, and the rest within rounding of 1M.
const shared = {
  "opencode-go": { models: { "deepseek-v4.1-flash": { limit: { context: 1000000 } }, "glm-5.3-flash": { limit: { context: 1000000 } } } },
  scaleway: { models: { "deepseek-v4.1-flash": { limit: { context: 256000 } } } },
  engy: { models: { "glm-5.3-flash": { limit: { context: 327680 } } } },
  deepseek: { models: {
    "deepseek-flash": { limit: { context: 1048576 } },
    "dated-20260101": { limit: { context: 512000 } },
    "zero-window": { limit: { context: 0 } },
    "fractional-window": { limit: { context: 200000.5 } },
    "string-window": { limit: { context: "1000000" } },
    "no-limit": { reasoning: true },
  } },
};

test("catalogueWindow matches a model filed under another provider by its bare id", () => {
  // Hive's ids carry the org and a build stamp (`deepseek-v4.1-flash-1017`); the catalogue's do not.
  assert.equal(catalogueWindow(shared, "deepseek-ai/deepseek-v4.1-flash-1017"), 256000);
  assert.equal(catalogueWindow(shared, "zai-org/glm-5.3-flash"), 327680);
  assert.equal(catalogueWindow(shared, "deepseek-v4.1-flash"), 256000, "a bare id needs no stripping");
  assert.equal(catalogueWindow(shared, "DeepSeek-V4.1-Flash"), 256000, "case is not a different model");
});

test("catalogueWindow takes the smallest window the entries state", () => {
  // Not the model's nominal 1M: an unknown reseller may be the one that cut it, and a window that is
  // too large overflows and loses the request, while one that is too small only compacts early.
  assert.equal(catalogueWindow(shared, "org/deepseek-v4.1-flash"), 256000);
  assert.equal(catalogueWindow(shared, "org/glm-5.3-flash"), 327680);
});

test("catalogueWindow prefers a catalogue id that already is the stamped one", () => {
  assert.equal(catalogueWindow(shared, "deepseek/deepseek-v4.1-flash"), 256000);
  assert.equal(catalogueWindow(shared, "org/dated-20260101"), 512000, "the exact id is tried before stripping");
});

test("catalogueWindow matches nothing rather than something close", () => {
  // `deepseek-flash` is a different model that exists in the catalogue, and jev-1.13 is in none.
  assert.equal(catalogueWindow(shared, "deepseek-ai/deepseek-v4.1-flash-1017-1017"), undefined);
  assert.equal(catalogueWindow(shared, "opencode/jev-1.13"), undefined);
  assert.equal(catalogueWindow(shared, "org/deepseek"), undefined, "a prefix is not a model id");
  assert.equal(catalogueWindow(shared, "org/zero-window"), undefined);
  assert.equal(catalogueWindow(shared, "org/fractional-window"), undefined);
  assert.equal(catalogueWindow(shared, "org/string-window"), undefined, "a window is a number, not a string");
  assert.equal(catalogueWindow(shared, "org/no-limit"), undefined);
  assert.equal(catalogueWindow(undefined, "org/deepseek-v4.1-flash"), undefined);
});
