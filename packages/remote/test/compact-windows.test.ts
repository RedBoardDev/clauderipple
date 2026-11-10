import { test } from "node:test";
import assert from "node:assert/strict";
import { RouterClient, type Fetch } from "../src/router.ts";

for (const [source, target, provider, capacity, compactWindow, expected] of [
  ["claude-opus-5-5", "claude-opus-5-5", "anthropic", 1000000, 600000, 50],
  ["claude-opus-4-7", "gpt-sol", "chatgpt", 475000, 475000, 63.2],
] as const) {
  test(`host figures use compactWindow for ${source} even when SDK reports 1M`, async () => {
    const boundary: Fetch = async url => ({ ok: true, status: 200, json: async () => url.includes("/api/requests")
      ? { requests: [{ source, target, provider, ok: true, usage: { input: 300000 } }] }
      : url.includes("/api/context-windows") ? { resolvedWindows: { [source]: { model: target, provider: provider === "anthropic" ? null : provider, contextWindow: capacity, compactWindow } } } : {} });
    const client = new RouterClient("http://router.test", boundary);
    const figures = await client.figures("session", source, 1000000);
    assert.equal(figures.contextWindow, compactWindow);
    assert.equal(figures.contextPct, expected);
  });
}

test("an older router without compactWindow keeps its capacity and provider-bound fallback rules", async () => {
  const boundary: Fetch = async url => ({ ok: true, status: 200, json: async () => url.includes("/api/requests")
    ? { requests: [{ source: "claude-opus-5-5", target: "claude-opus-5-5", provider: "anthropic", usage: { input: 300000 } }] }
    : url.includes("/api/context-windows") ? { resolvedWindows: { "claude-opus-5-5": { model: "claude-opus-5-5", provider: null, contextWindow: 1000000 } } } : {} });
  const figures = await new RouterClient("http://router.test", boundary).figures("session", "claude-opus-5-5", 1000000);
  assert.equal(figures.contextWindow, 1000000);
  assert.equal(figures.contextPct, 30);
});
