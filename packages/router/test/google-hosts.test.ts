// Cloud Code Assist runs on two hosts (daily and prod). They offer different models and count
// quota separately (measured 2026-10-20), so the router merges their catalogues, routes each model
// to a host that offers it, and reads the quota of the hosts the selected models live on.
// No live call: a fake fetch answers for both hosts.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { GoogleAdapter } from "../src/providers/google/index.ts";
import { buildHostMap, fetchAvailableModels, hostForModel, parseHostCatalogue } from "../src/providers/google/antigravity.ts";
import { saveGoogleAccount } from "../src/providers/google/accounts.ts";
import { ThoughtSignatureStore } from "../src/providers/google/thoughtSignatures.ts";
import { Logger } from "../src/log.ts";
import type { AnthropicRequest } from "../src/providers/chatgpt/translate.ts";

const log = new Logger(null, 1e9, 0, false);
const tempHome = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "cr-google-hosts-"));
const DAILY = "https://daily-cloudcode-pa.googleapis.com";
const PROD = "https://cloudcode-pa.googleapis.com";

// Distinct catalogues: prod lists Pro models daily does not; both list gemini-3.8-flash.
const dailyCatalogue = {
  models: {
    "gemini-3.8-flash-low": { maxTokens: 1_048_576 },
    "gemini-3.8-flash-medium": { maxTokens: 1_048_576 },
    "gemini-3.8-flash-high": { maxTokens: 1_048_576 },
  },
  agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-high"] }] }],
};
const prodCatalogue = {
  models: {
    "gemini-3.1-pro-low": { maxTokens: 1_048_576, displayName: "Gemini 3.1 Pro (Low)" },
    "gemini-3.1-pro-high": { maxTokens: 1_048_576, displayName: "Gemini 3.1 Pro (High)" },
    "gemini-pro-agent": { maxTokens: 1_048_576, displayName: "Gemini 3.1 Pro (High)" },
    "gemini-3.8-flash-low": { maxTokens: 1_048_576 },
    "gemini-3.8-flash-medium": { maxTokens: 1_048_576 },
  },
  agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.1-pro-low", "gemini-3.1-pro-high", "gemini-pro-agent"] }, { modelIds: ["gemini-3.8-flash-low", "gemini-3.8-flash-medium"] }] }],
};

test("the two hosts' catalogues merge, and the host map records who offers what", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    seen.push(url);
    if (url.startsWith(`${DAILY}/`)) return Response.json(dailyCatalogue);
    if (url.startsWith(`${PROD}/`)) return Response.json(prodCatalogue);
    return new Response("no", { status: 404 });
  }) as unknown as typeof fetch;
  const merged = await fetchAvailableModels("tok", "proj", { fetchImpl });
  assert.ok(merged);
  assert.equal(seen.length, 4, "both hosts are asked, once per client family (IDE and CLI)");
  const ids = merged.models.map((m) => m.id);
  assert.deepEqual(ids.filter((id) => id.startsWith("gemini-3.1-pro")), ["gemini-3.1-pro"], "prod's Pro tiers collapse to one row");
  assert.equal(ids.filter((id) => id.startsWith("gemini-3.8-flash")).length, 1, "a shared model is listed once");
  const gemini = merged.models.find((m) => m.id === "gemini-3.8-flash")!;
  assert.equal(gemini.name, undefined, "the preferred (daily) host's row wins the merge");

  // Shared model: daily first. Prod-only model: prod. An unknown model: no entry, caller's fallback.
  assert.deepEqual(merged.hosts.get("gemini-3.8-flash"), [DAILY, PROD], "a shared base id lists daily first, the preference");
  assert.deepEqual(merged.hosts.get("gemini-3.8-flash-high"), [DAILY], "a wire id alone is enough to place a model");
  assert.deepEqual(merged.hosts.get("gemini-3.1-pro"), [PROD]);
  assert.deepEqual(merged.hosts.get("gemini-pro-agent"), [PROD]);
  assert.equal(merged.hosts.get("gemini-9-unknown"), undefined);
  assert.equal(hostForModel(merged.hosts, "gemini-3.8-flash", "gemini-3.8-flash-high", DAILY), DAILY);
  assert.equal(hostForModel(merged.hosts, "gemini-3.1-pro", "gemini-3.1-pro-low", DAILY), PROD);
  assert.equal(hostForModel(merged.hosts, "gemini-9-unknown", "gemini-9-unknown", DAILY), DAILY, "an unknown model goes to the default host");
});

test("one failing host does not hide the other's models", async () => {
  const fetchImpl = (async (url: string) => {
    if (url.startsWith(`${DAILY}/`)) return new Response("boom", { status: 500 });
    return Response.json(prodCatalogue);
  }) as unknown as typeof fetch;
  const merged = await fetchAvailableModels("tok", "proj", { fetchImpl });
  assert.ok(merged);
  const ids = merged.models.map((m) => m.id);
  assert.ok(ids.includes("gemini-3.1-pro"), "prod's models survive daily's failure");
  assert.equal(merged.hosts.get("gemini-3.1-pro")?.[0], PROD);
  // A host that throws is the same as one that answers an error.
  const throwing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  assert.equal(await fetchAvailableModels("tok", "proj", { fetchImpl: throwing }), null, "no host answered");
  const half = (async (url: string) => (url.startsWith(`${DAILY}/`) ? Response.json(dailyCatalogue) : new Response("x", { status: 503 }))) as unknown as typeof fetch;
  const dailyOnly = await fetchAvailableModels("tok", "proj", { fetchImpl: half });
  assert.deepEqual(dailyOnly?.models.map((m) => m.id), ["gemini-3.8-flash"]);
  assert.equal(dailyOnly?.hosts.get("gemini-3.8-flash")?.[0], DAILY);
});

test("a pinned url disables the second host", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    seen.push(url);
    return Response.json(dailyCatalogue);
  }) as unknown as typeof fetch;
  const merged = await fetchAvailableModels("tok", "proj", { hosts: ["https://example.test"], fetchImpl });
  assert.deepEqual(seen, ["https://example.test/v1internal:fetchAvailableModels", "https://example.test/v1internal:fetchAvailableModels"], "the pinned host only, once per client family");
  assert.deepEqual(merged?.hosts.get("gemini-3.8-flash"), ["https://example.test"]);
});

test("a prod-only model is sent to prod, a shared model to daily, through the adapter", async () => {
  const home = tempHome();
  saveGoogleAccount(home, { accessToken: "tok", refreshToken: "rt", projectId: "proj", email: "a@example.test", expiresAt: Date.now() + 3_600_000 });
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes(":fetchAvailableModels")) {
      casts.push(url);
      if (url.startsWith(`${DAILY}/`)) return Response.json(dailyCatalogue);
      if (url.startsWith(`${PROD}/`)) return Response.json(prodCatalogue);
      return new Response("no", { status: 404 });
    }
    if (url.includes(":streamGenerateContent") || url.includes(":generateContent")) {
      calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      const frame = { response: { candidates: [{ content: { parts: [{ text: "Hi" }] } }, { finishReason: "STOP" }] } };
      return new Response(`data: ${JSON.stringify(frame)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const casts: string[] = [];
  const adapter = new GoogleAdapter("ag", { type: "google", auth: "antigravity", models: [{ id: "gemini-3.8-flash" }, { id: "gemini-3.1-pro" }] }, home, log);
  try {
    const front = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const json = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AnthropicRequest;
        const model = (req.headers["x-test-model"] as string | undefined) ?? "gemini-3.8-flash";
        const effort = (req.headers["x-test-effort"] as string | undefined) ?? "high";
        void adapter.handle(req, res, "/v1/messages", json, model, effort);
      });
    });
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
    const send = (model: string, effort: string): Promise<void> => new Promise((resolve, reject) => {
      const raw = JSON.stringify({ model, stream: true, max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
      const req = http.request({ host: "127.0.0.1", port: (front.address() as { port: number }).port, method: "POST", path: "/v1/messages",
        headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)), "x-test-model": model, "x-test-effort": effort } }, (res) => {
        res.resume();
        res.on("end", resolve);
      });
      req.on("error", reject);
      req.end(raw);
    });
    try {
      await send("gemini-3.8-flash", "high");
      assert.equal(calls.length, 1);
      assert.match(calls[0]!.url, /^https:\/\/daily-cloudcode-pa\.googleapis\.com\//, "a model both hosts offer stays on daily");
      assert.equal(calls[0]!.body.model, "gemini-3.8-flash-medium");
      await send("gemini-3.1-pro", "low");
      assert.equal(calls.length, 2);
      assert.match(calls[1]!.url, /^https:\/\/cloudcode-pa\.googleapis\.com\//, "a prod-only model goes to prod");
      assert.equal(calls[1]!.body.model, "gemini-3.1-pro-low");
      assert.deepEqual(casts, [`${DAILY}/v1internal:fetchAvailableModels`, `${DAILY}/v1internal:fetchAvailableModels`, `${PROD}/v1internal:fetchAvailableModels`, `${PROD}/v1internal:fetchAvailableModels`], "the catalogue is fetched once per host and client family, not per turn");
    } finally {
      front.close();
    }
  } finally {
    globalThis.fetch = original;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("quota is read from the hosts the selected models live on, and a pinned url only from its host", async () => {
  const home = tempHome();
  saveGoogleAccount(home, { accessToken: "tok", refreshToken: "rt", projectId: "proj", email: "a@example.test", expiresAt: Date.now() + 3_600_000 });
  const quotas: string[] = [];
  const quotaBody = { groups: [{ displayName: "Gemini Models", buckets: [
    { bucketId: "gemini-5h", displayName: "5h", window: "5h", remainingFraction: 0.9, resetTime: new Date(Date.now() + 3_600_000).toISOString() },
    { bucketId: "gemini-weekly", displayName: "Weekly", window: "weekly", remainingFraction: 0.9, resetTime: new Date(Date.now() + 3_600_000).toISOString() },
  ] }] };
  const fetchImpl = (async (url: string) => {
    if (url.includes(":fetchAvailableModels")) {
      if (url.startsWith(`${DAILY}/`)) return Response.json(dailyCatalogue);
      if (url.startsWith(`${PROD}/`)) return Response.json(prodCatalogue);
      return new Response("no", { status: 404 });
    }
    if (url.includes(":retrieveUserQuotaSummary")) {
      quotas.push(url);
      return Response.json(quotaBody);
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const shared = new GoogleAdapter("shared", { type: "google", auth: "antigravity", models: [{ id: "gemini-3.8-flash" }] }, home, log, undefined, fetchImpl);
    await shared.usageSnapshot();
    assert.deepEqual(quotas, [`${DAILY}/v1internal:retrieveUserQuotaSummary`], "a daily model reads daily only");
    quotas.length = 0;
    const pro = new GoogleAdapter("pro", { type: "google", auth: "antigravity", models: [{ id: "gemini-3.1-pro" }] }, home, log, undefined, fetchImpl);
    await pro.usageSnapshot();
    assert.deepEqual(quotas, [`${PROD}/v1internal:retrieveUserQuotaSummary`], "a prod-only model reads prod only");
    quotas.length = 0;
    const pinned = new GoogleAdapter("pinned", { type: "google", auth: "antigravity", url: "https://example.test", models: [{ id: "gemini-3.1-pro" }] }, home, log, undefined, fetchImpl);
    await pinned.usageSnapshot();
    assert.deepEqual(quotas, ["https://example.test/v1internal:retrieveUserQuotaSummary"], "a pinned host is the only host");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the catalogue parser keeps wire ids so routing can match a resolved tier", () => {
  const parsed = parseHostCatalogue(prodCatalogue);
  assert.deepEqual(parsed?.wireIds, ["gemini-3.1-pro-low", "gemini-3.1-pro-high", "gemini-pro-agent", "gemini-3.8-flash-low", "gemini-3.8-flash-medium"]);
  const map = buildHostMap(new Map<string, NonNullable<typeof parsed>>([
    [DAILY, parseHostCatalogue(dailyCatalogue)!],
    [PROD, parsed!],
  ]));
  assert.deepEqual(map.get("gemini-3.8-flash-medium"), [DAILY, PROD], "both hosts are remembered in preference order");
  assert.deepEqual(map.get("gemini-3.8-flash"), [DAILY, PROD], "a shared base id prefers daily, the first host");
});

test("thought signatures stay per host: a signature from daily is not replayed to prod", () => {
  const store = new ThoughtSignatureStore();
  const daily = store.scope(DAILY);
  const prod = store.scope(PROD);
  daily.set("toolu_1", "SIG-DAILY");
  assert.equal(daily.get("toolu_1"), "SIG-DAILY");
  assert.equal(prod.get("toolu_1"), undefined, "the other host must not see it");
  prod.set("toolu_1", "SIG-PROD");
  assert.equal(daily.get("toolu_1"), "SIG-DAILY", "each host keeps its own");
  assert.equal(store.size, 2, "the store's LRU bound spans both views");
});
