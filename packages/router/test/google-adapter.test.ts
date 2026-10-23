import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { GoogleAdapter, googleLooksLikeAuth, googleRetryDelayMs } from "../src/providers/google/index.ts";
import { Logger } from "../src/log.ts";
import type { GoogleProvider } from "../src/config.ts";
import type { AnthropicRequest } from "../src/providers/chatgpt/translate.ts";

const seen: { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
let mode: "text" | "tool" | "cut" | "badkey" | "reflect" = "text";
const sse = (records: Record<string, unknown>[]) => records.map((record) => `data: ${JSON.stringify(record)}\n\n`).join("");

const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    seen.push({ path: req.url ?? "", headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
    if (mode === "badkey" || mode === "reflect") {
      const message = mode === "reflect"
        ? `Rejected ${req.headers["x-goog-api-key"]} and ${req.headers["x-api-key"]}`
        : "API key not valid. Please pass a valid API key.";
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: 400, message, status: "API_KEY_INVALID" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (mode === "cut") {
      // A stream that stops with no finishReason and no usage, as a stalled vendor's did (§5 muse).
      res.end(sse([{ candidates: [{ content: { parts: [{ text: "Hal" }] } }] }]));
      return;
    }
    if (mode === "tool") {
      res.end(sse([
        { candidates: [{ content: { parts: [{ text: "Let me read." }] } }] },
        { candidates: [{ content: { parts: [{ functionCall: { name: "Read", args: { file_path: "a.ts" } }, thoughtSignature: "SIG-1" }] } }], usageMetadata: { promptTokenCount: 40, cachedContentTokenCount: 30, candidatesTokenCount: 5, thoughtsTokenCount: 3 } },
        { candidates: [{ finishReason: "STOP" }] },
      ]));
      return;
    }
    const body = sse([
      { candidates: [{ content: { parts: [{ text: "Hi " }] } }] },
      { candidates: [{ content: { parts: [{ text: "there" }] } }] },
      { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 40, cachedContentTokenCount: 30, candidatesTokenCount: 5 } },
    ]);
    // Odd chunks exercise the SSE parser's frame boundaries.
    for (let at = 0; at < body.length; at += 17) res.write(body.slice(at, at + 17));
    res.end();
  });
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

const upstreamPort = await listen(upstream);
const log = new Logger(null, 1_000_000, 1, false);
const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-google-adapter-"));
let adapter = new GoogleAdapter("fake", { type: "google", auth: "api-key", apiKey: "test-key", url: `http://127.0.0.1:${upstreamPort}` }, home, log);
let authentication: Pick<GoogleProvider, "apiKey" | "headers"> | undefined;
const front = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const json = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AnthropicRequest;
    void adapter.handle(req, res, req.url ?? "/v1/messages", json, "gemini-3-pro-preview", "high", authentication);
  });
});
const frontPort = await listen(front);

function call(body: unknown, path = "/v1/messages"): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port: frontPort, method: "POST", path, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)) } }, (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(raw);
  });
}

const request: AnthropicRequest = { model: "claude", stream: true, system: "sys", messages: [{ role: "user", content: "read a" }], tools: [{ name: "Read", input_schema: { type: "object" } }] };

test("adapter streams text, carries the API key, and maps usage", async () => {
  mode = "text";
  adapter = new GoogleAdapter("fake", { type: "google", auth: "api-key", apiKey: "test-key", url: `http://127.0.0.1:${upstreamPort}` }, home, log);
  const response = await call(request);
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"] ?? "", /text\/event-stream/);
  const sent = seen.at(-1)!;
  assert.equal(sent.path, "/v1beta/models/gemini-3-pro-preview:streamGenerateContent?alt=sse");
  assert.equal(sent.headers["x-goog-api-key"], "test-key");
  // Plain AI Studio requests are unchanged: no relay session header and no ClaudeRipple User-Agent.
  assert.equal(sent.headers["x-opencode-session"], undefined);
  assert.doesNotMatch(String(sent.headers["user-agent"] ?? ""), /^clauderipple\//);
  assert.equal(sent.body.model, undefined, "the model goes in the path, not the body");
  assert.deepEqual((sent.body.contents as { role: string }[]).map((c) => c.role), ["user"]);
  assert.match(response.text, /"text":"Hi "/);
  assert.match(response.text, /"text":"there"/);
  assert.match(response.text, /"cache_read_input_tokens":30/);
  assert.match(response.text, /"stop_reason":"end_turn"/);
});

// OpenCode Go's Gemini endpoint refuses a request without `x-opencode-session` (400
// MissingSessionID), and its docs ask clients for a distinctive User-Agent. The key still travels
// on `x-goog-api-key`, never as a bearer.
test("a session header, the provider's own headers and a client user-agent ride on the api-key wire", async () => {
  mode = "text";
  adapter = new GoogleAdapter("opencode", {
    type: "google", auth: "api-key", apiKey: "test-key", url: `http://127.0.0.1:${upstreamPort}`,
    sessionHeader: "x-opencode-session", headers: { "x-extra": "kept" },
  }, home, log);
  await call(request);
  const first = seen.at(-1)!;
  assert.equal(first.path, "/v1beta/models/gemini-3-pro-preview:streamGenerateContent?alt=sse");
  assert.equal(first.headers["x-goog-api-key"], "test-key");
  assert.equal(first.headers.authorization, undefined, "this wire never carries a bearer");
  assert.equal(first.headers["x-extra"], "kept");
  assert.match(String(first.headers["user-agent"]), /^clauderipple\/\d+\.\d+\.\d+$/);
  const session = String(first.headers["x-opencode-session"]);
  assert.match(session, /^[0-9a-f]{32}$/, "a stable conversation id, not a per-request random");

  // The same conversation keeps the same value; a different one gets a different value.
  await call(request);
  assert.equal(seen.at(-1)!.headers["x-opencode-session"], session);
  await call({ ...request, metadata: { user_id: "another-conversation" }, messages: [{ role: "user", content: "another conversation" }] });
  assert.notEqual(seen.at(-1)!.headers["x-opencode-session"], session);

  // Leave the following tests on the plain AI Studio adapter.
  adapter = new GoogleAdapter("fake", { type: "google", auth: "api-key", apiKey: "test-key", url: `http://127.0.0.1:${upstreamPort}` }, home, log);
});

test("per-call authentication replaces the key and headers without changing the configured authentication", async () => {
  mode = "text";
  adapter = new GoogleAdapter("opencode", {
    type: "google", auth: "api-key", apiKey: "configured-key-a", url: `http://127.0.0.1:${upstreamPort}`,
    sessionHeader: "x-opencode-session",
    headers: { "x-account-id": "account-a", "x-extra": "configured", "x-config-only": "configured-only", authorization: "Bearer configured-token" },
  }, home, log);
  authentication = {
    apiKey: "selected-key-b",
    headers: { "x-account-id": "account-b", "x-extra": "selected", "x-selected-only": "kept", "x-goog-api-key": "shadowed-key" },
  };
  try {
    const selected = await call(request);
    assert.equal(selected.status, 200);
    const first = seen.at(-1)!;
    assert.equal(first.headers["x-goog-api-key"], "selected-key-b");
    assert.equal(first.headers["x-account-id"], "account-b");
    assert.equal(first.headers["x-extra"], "selected");
    assert.equal(first.headers["x-selected-only"], "kept");
    assert.equal(first.headers["x-config-only"], undefined);
    assert.equal(first.headers.authorization, undefined);
    assert.equal(first.path, "/v1beta/models/gemini-3-pro-preview:streamGenerateContent?alt=sse");
    assert.match(String(first.headers["user-agent"]), /^clauderipple\/\d+\.\d+\.\d+$/);
    const session = String(first.headers["x-opencode-session"]);
    assert.match(session, /^[0-9a-f]{32}$/);

    authentication = undefined;
    const configured = await call(request);
    assert.equal(configured.status, 200);
    const next = seen.at(-1)!;
    assert.equal(next.headers["x-goog-api-key"], "configured-key-a");
    assert.equal(next.headers["x-account-id"], "account-a");
    assert.equal(next.headers["x-extra"], "configured");
    assert.equal(next.headers["x-config-only"], "configured-only");
    assert.equal(next.headers.authorization, "Bearer configured-token");
    assert.equal(next.headers["x-selected-only"], undefined);
    assert.equal(next.headers["x-opencode-session"], session);
  } finally {
    authentication = undefined;
  }
});

test("per-call authentication without headers never reuses configured identity headers", async () => {
  mode = "text";
  adapter = new GoogleAdapter("fake", {
    type: "google", auth: "api-key", apiKey: "configured-key-a", url: `http://127.0.0.1:${upstreamPort}`,
    headers: { authorization: "Bearer configured-token", "x-account-id": "account-a", "x-config-only": "configured-only" },
  }, home, log);
  authentication = { apiKey: "selected-key-b" };
  try {
    const response = await call(request);
    assert.equal(response.status, 200);
    const sent = seen.at(-1)!;
    assert.equal(sent.headers.authorization, undefined);
    assert.equal(sent.headers["x-account-id"], undefined);
    assert.equal(sent.headers["x-config-only"], undefined);
    assert.equal(sent.headers["x-goog-api-key"], "selected-key-b");
  } finally {
    authentication = undefined;
  }
});

test("per-call authentication without a key never reuses the configured key", async () => {
  mode = "text";
  adapter = new GoogleAdapter("fake", {
    type: "google", auth: "api-key", apiKey: "configured-key-a", url: `http://127.0.0.1:${upstreamPort}`,
  }, home, log);
  authentication = { headers: { "x-account-id": "account-b" } };
  const before = seen.length;
  try {
    const response = await call(request);
    assert.equal(response.status, 401);
    assert.match(response.text, /no API key/);
    assert.equal(seen.length, before, "a missing selected key must not send the configured one");
  } finally {
    authentication = undefined;
  }
});

test("reflected errors redact the selected key and selected credential headers", async (t) => {
  mode = "reflect";
  const warnings: string[] = [];
  t.mock.method(log, "warn", (message: string) => { warnings.push(message); });
  adapter = new GoogleAdapter("fake", {
    type: "google", auth: "api-key", apiKey: "configured-key-a", url: `http://127.0.0.1:${upstreamPort}`,
  }, home, log);
  authentication = { apiKey: "selected-opaque-value-b", headers: { "x-api-key": "selected-header-value" } };
  try {
    const response = await call(request);
    assert.equal(response.status, 401);
    assert.equal(seen.at(-1)!.headers["x-goog-api-key"], "selected-opaque-value-b");
    assert.equal(seen.at(-1)!.headers["x-api-key"], "selected-header-value");
    assert.equal(warnings.length, 1);
    for (const text of [response.text, ...warnings]) {
      assert.match(text, /\[REDACTED\]/);
      assert.ok(!text.includes("selected-opaque-value-b"));
      assert.ok(!text.includes("selected-header-value"));
    }
  } finally {
    authentication = undefined;
  }
});

test("a function call carries its signature into the store and it is replayed on the next turn", async () => {
  mode = "tool";
  adapter = new GoogleAdapter("fake", { type: "google", auth: "api-key", apiKey: "test-key", url: `http://127.0.0.1:${upstreamPort}` }, home, log);
  const response = await call(request);
  assert.match(response.text, /"type":"tool_use"/);
  const id = /"id":"(toolu_[0-9a-f]+)"/.exec(response.text)?.[1];
  assert.ok(id, "the tool_use id is minted as toolu_…");
  assert.equal(adapter.signatureCount, 1, "SIG-1 was remembered against the minted id");

  // The next turn replays that call from Claude Code's history; the signature must ride back on it.
  const replay: AnthropicRequest = {
    ...request,
    messages: [
      { role: "user", content: "read a" },
      { role: "assistant", content: [{ type: "tool_use", id: id!, name: "Read", input: { file_path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: id!, content: "ok" }] },
    ],
  };
  await call(replay);
  const contents = seen.at(-1)!.body.contents as { role: string; parts: { functionCall?: { name?: string }; thoughtSignature?: string }[] }[];
  const modelTurn = contents.find((c) => c.role === "model")!;
  // The signature is a sibling of functionCall on the same part, not a field inside functionCall.
  assert.equal(modelTurn.parts[0]?.thoughtSignature, "SIG-1");
});

test("a stream cut off with no finishReason ends in a retryable overloaded_error", async () => {
  mode = "cut";
  adapter = new GoogleAdapter("fake", { type: "google", auth: "api-key", apiKey: "test-key", url: `http://127.0.0.1:${upstreamPort}` }, home, log);
  const response = await call(request);
  assert.match(response.text, /"type":"overloaded_error"/);
  assert.doesNotMatch(response.text, /message_stop/);
});

test("a 400 with API_KEY_INVALID maps to an Anthropic authentication_error", async () => {
  mode = "badkey";
  adapter = new GoogleAdapter("fake", { type: "google", auth: "api-key", apiKey: "test-key", url: `http://127.0.0.1:${upstreamPort}` }, home, log);
  const response = await call(request);
  assert.equal(response.status, 401);
  assert.equal((JSON.parse(response.text) as { error: { type: string } }).error.type, "authentication_error");
  // 401 and a body that names the key are auth; a bare 403 is a permission/region/policy problem.
  assert.equal(googleLooksLikeAuth(401, ""), true);
  assert.equal(googleLooksLikeAuth(400, JSON.stringify({ error: { status: "API_KEY_INVALID" } })), true);
  assert.equal(googleLooksLikeAuth(400, JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "bad field" } })), false);
  assert.equal(googleLooksLikeAuth(403, JSON.stringify({ error: { status: "PERMISSION_DENIED" } })), true);
  assert.equal(googleLooksLikeAuth(403, ""), false, "a bare 403 is a permission problem, not a bad key");
});

test("a Google 429 states its wait in a RetryInfo detail, not a header", () => {
  const body = JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "37.2s" }] } });
  assert.equal(googleRetryDelayMs(body), 37_200);
  assert.equal(googleRetryDelayMs(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } })), undefined);
});

test("count tokens is local and an antigravity provider with no account says so by name", async () => {
  const before = seen.length;
  const response = await call(request, "/v1/messages/count_tokens");
  assert.equal(response.status, 200);
  assert.ok((JSON.parse(response.text) as { input_tokens: number }).input_tokens > 0);
  assert.equal(seen.length, before, "no upstream call for a local count");

  const restore = adapter;
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "cr-google-empty-"));
  adapter = new GoogleAdapter("ag", { type: "google", auth: "antigravity" }, emptyHome, log);
  const refused = await call(request);
  adapter = restore;
  assert.equal(refused.status, 401);
  assert.match(refused.text, /no Google account: run `clauderipple google-login`/);
});

test("cleanup", () => {
  front.close();
  upstream.close();
});
