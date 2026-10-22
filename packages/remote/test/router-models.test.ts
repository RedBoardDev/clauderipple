import { test } from "node:test";
import assert from "node:assert/strict";
import { groupModels } from "../src/router.ts";

const levels = { providers: { anthropic: { default: ["low", "medium", "high", "xhigh", "max"] }, chatgpt: { default: ["low", "high"] } } };

// A router that passes Claude straight through declares no anthropic provider, and the phone's
// picker came up empty (Discord, 2026-10-22).
test("Claude Code's own models are offered when no anthropic provider is declared", () => {
  const none = groupModels({ models: [], providers: [] }, levels);
  assert.deepEqual(none.map(g => g.label), ["Claude"]);
  assert.deepEqual(none[0]!.models.map(m => m.model), ["opus", "sonnet", "haiku"]);
  assert.deepEqual(none[0]!.models[0]!.efforts, ["low", "medium", "high", "xhigh", "max"]);

  const gpt = groupModels({ models: [{ model: "gpt-x", provider: "chatgpt", name: "GPT X", judgeOnly: false }], providers: [{ name: "chatgpt", type: "chatgpt", usable: true }] }, levels);
  assert.deepEqual(gpt.map(g => g.label), ["Claude", "ChatGPT"]);
});

test("a declared anthropic provider's own models are used instead", () => {
  const groups = groupModels({ models: [{ model: "claude-opus-5-5", provider: "anthropic", name: "Opus 5.5", judgeOnly: false }], providers: [{ name: "anthropic", type: "anthropic", usable: true }] }, levels);
  assert.deepEqual(groups.map(g => g.models.map(m => m.model)), [["claude-opus-5-5"]]);
});
