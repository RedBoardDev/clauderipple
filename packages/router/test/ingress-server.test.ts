import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { OpenAiIngress } from "../src/ingress/server.ts";
import { Logger } from "../src/log.ts";
import { ClaudeAccountAuthPool } from "../src/providers/anthropic-account-pool.ts";
import { saveClaudeOAuthAccount, setCurrentClaudeAccountPaused, updateClaudeAccount } from "../src/providers/anthropic-accounts.ts";
import { ClaudeCodeAuthStore, ClaudeCodeCredentialStore } from "../src/providers/anthropic.ts";
import { RequestLog } from "../src/requestlog.ts";
import type { Config } from "../src/config.ts";

const noClaudeCodeCredentialReaders = { keychain: () => null, credentialsFile: () => null };
const seen: { headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
const upstream = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    seen.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
    const body = seen.at(-1)!.body;
    if (body.stream === true) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":8,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":12,"cache_read_input_tokens":8,"output_tokens":2}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ].join(""));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 12, cache_read_input_tokens: 8, output_tokens: 2 } }));
  });
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

const upstreamPort = await listen(upstream);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-ingress-"));
const config: Config = {
  listen: { host: "127.0.0.1", port: 30000, openaiPort: 0 },
  upstream: "api.anthropic.com",
  providers: { local: { type: "anthropic-compatible", url: `http://127.0.0.1:${upstreamPort}`, headers: { "x-api-key": "upstream-key" } } },
  routes: { "claude-sonnet-5": { provider: "local", model: "claude-sonnet-5" } },
  direct: [], aliases: {}, effortClamp: { ultra: "max" }, cli: { extraModels: [] }, health: { maxConsecutiveUpstreamFailures: 20 }, log: { maxBytes: 1e6, keep: 1 },
};
const log = new Logger(null, 1e9, 0, false);
const requests = new RequestLog(path.join(root, "requests.jsonl"));
const ingress = new OpenAiIngress({ config: () => config, log, requests, claudeCodeCredentialReaders: noClaudeCodeCredentialReaders });
const ingressPort = await ingress.listen();

async function call(pathname: string, body?: unknown, port = ingressPort): Promise<{ status: number; text: string }> {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer local", ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}) } }, (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", reject);
    if (data) req.end(data); else req.end();
  });
}

const input = { model: "claude-sonnet-5", instructions: "system", input: "say ok", max_output_tokens: 16 };

test("models endpoint lists mapped IDs", async () => {
  const response = await call("/v1/models");
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text).data.map((model: { id: string }) => model.id), ["claude-sonnet-5"]);
});

test("Responses non-stream and stream traverse fake Anthropic-compatible provider", async () => {
  const nonstream = await call("/v1/responses", input);
  assert.equal(nonstream.status, 200);
  assert.equal(JSON.parse(nonstream.text).output[0].content[0].text, "ok");
  const stream = await call("/v1/responses", { ...input, stream: true });
  assert.equal(stream.status, 200);
  assert.match(stream.text, /event: response\.output_text\.delta/);
  assert.match(stream.text, /"cached_tokens":8/);
  assert.equal(seen.at(-1)?.headers.authorization, undefined, "local client bearer token is never forwarded");
  assert.equal(seen.at(-1)?.headers["x-api-key"], "upstream-key");
});

test("Chat Completions non-stream and stream traverse same provider", async () => {
  const body = { model: "claude-sonnet-5", messages: [{ role: "user", content: "say ok" }], tools: [{ type: "function", function: { name: "Read", description: "read", parameters: { type: "object" } } }] };
  const nonstream = await call("/v1/chat/completions", body);
  assert.equal(nonstream.status, 200);
  assert.equal(JSON.parse(nonstream.text).choices[0].message.content, "ok");
  const stream = await call("/v1/chat/completions", { ...body, stream: true });
  assert.equal(stream.status, 200);
  assert.match(stream.text, /data: \[DONE\]/);
  assert.match(stream.text, /"content":"ok"/);
  assert.equal((seen.at(-1)?.body.tools as { name?: string }[] | undefined)?.[0]?.name, "Read");
  assert.equal(requests.list(10)[0]?.note, "openai-ingress chat");
});

for (const converted of [false, true]) {
  for (const endpoint of ["responses", "chat/completions"]) {
    test(`${endpoint} respects compatible credential controls${converted ? " after per-model wire/auth conversion" : ""}`, async () => {
      const compatibleSeen: { headers: http.IncomingHttpHeaders; pathname: string | undefined }[] = [];
      let originStatus = 200;
      const origin = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          compatibleSeen.push({ headers: req.headers, pathname: req.url });
          res.writeHead(originStatus, { "content-type": "application/json" }).end(JSON.stringify(originStatus === 200
            ? { id: "msg_compatible_controls", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }
            : { error: { message: "test origin rate limit" } }));
        });
      });
      const originPort = await listen(origin);
      const url = `http://127.0.0.1:${originPort}`;
      const keyHeaders = (key: string): Record<string, string> => converted
        ? { authorization: `Bearer ${key}`, "x-credential": key }
        : { "x-api-key": key, "x-credential": key };
      const first = { id: "a", headers: keyHeaders("ingress-key-A"), paused: true };
      const available = { id: "c", headers: keyHeaders("ingress-key-C"), paused: false };
      const preferred = { id: "b", headers: keyHeaders("ingress-key-B"), preferred: true, paused: false };
      const credentials = [first, available, preferred];
      const compatibleConfig: Config = {
        ...config,
        providers: { local: converted
          ? { type: "openai-compatible", url: `${url}/openai-wire`, headers: first.headers, credentials, models: [{ id: input.model, wire: "anthropic", url: `${url}/anthropic-wire`, authHeader: "x-api-key" }] }
          : { type: "anthropic-compatible", url: `${url}/anthropic-wire`, headers: first.headers, credentials } },
      };
      const compatibleIngress = new OpenAiIngress({ config: () => compatibleConfig, log, requests, claudeCodeCredentialReaders: noClaudeCodeCredentialReaders });
      const port = await compatibleIngress.listen();
      const body = endpoint === "responses" ? input : { model: input.model, messages: [{ role: "user", content: "say ok" }] };
      const invoke = () => call(`/v1/${endpoint}`, body, port);
      const assertKeys = (expected: string[]): void => {
        assert.deepEqual(compatibleSeen.map(({ headers }) => headers["x-api-key"]), expected);
        assert.deepEqual(compatibleSeen.map(({ headers }) => headers["x-credential"]), expected, "the complete selected header set is used");
        assert.ok(compatibleSeen.every(({ headers, pathname }) => headers.authorization === undefined && pathname === "/anthropic-wire/v1/messages"), "only transformed provider auth reaches the model's Anthropic endpoint");
      };
      try {
        assert.equal((await invoke()).status, 200);
        assertKeys(["ingress-key-B"]);
        preferred.paused = true;
        assert.equal((await invoke()).status, 200);
        assertKeys(["ingress-key-B", "ingress-key-C"]);
        available.paused = true;
        const refused = await invoke();
        assert.equal(refused.status, 503);
        const error = JSON.parse(refused.text).error;
        assert.equal(error.type, "server_error");
        assert.equal(error.param, null);
        assert.equal(error.code, null);
        assert.match(error.message, /resume.*paused/i);
        assert.equal(compatibleSeen.length, 2, "all paused means no origin call, not the mirrored first key");
        first.paused = false;
        assert.equal((await invoke()).status, 200);
        assertKeys(["ingress-key-B", "ingress-key-C", "ingress-key-A"]);
        available.paused = false;
        originStatus = 429;
        assert.equal((await invoke()).status, 429);
        assertKeys(["ingress-key-B", "ingress-key-C", "ingress-key-A", "ingress-key-A"]);
        assert.equal(compatibleSeen.length, 4, "a turn never retries on another available credential");
      } finally {
        await compatibleIngress.drain(1);
        await new Promise<void>((resolve) => origin.close(() => resolve()));
      }
    });
  }
}

test("Responses reject previous_response_id to remain stateless", async () => {
  const response = await call("/v1/responses", { ...input, previous_response_id: "resp_old" });
  assert.equal(response.status, 400);
  assert.match(response.text, /previous_response_id unsupported/);
});

test("native ingress uses one added Claude account without enabling failover", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-ingress-claude-account-"));
  const nativeSeen: http.IncomingHttpHeaders[] = [];
  const native = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      nativeSeen.push(req.headers);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_native", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const nativePort = await listen(native);
  saveClaudeOAuthAccount(home, { accessToken: "added-access", refreshToken: "added-refresh", expiresAt: Date.now() + 3_600_000, accountId: "added-account" });
  const now = Date.now;
  const noCurrent = new ClaudeCodeAuthStore(new ClaudeCodeCredentialStore(() => null, now), { home, env: {}, now });
  const claudeAccounts = new ClaudeAccountAuthPool({ home, current: noCurrent, log });
  const nativeConfig: Config = {
    ...config,
    providers: { claude: { type: "anthropic", auth: "claude-code", accountPool: true, models: [{ id: "claude-sonnet-5" }] } },
    routes: { "claude-sonnet-5": { provider: "claude", model: "claude-sonnet-5" } },
  };
  const nativeIngress = new OpenAiIngress({ config: () => nativeConfig, log, requests, home, claudeAccounts, nativeUpstream: `http://127.0.0.1:${nativePort}` });
  const nativeIngressPort = await nativeIngress.listen();
  try {
    const response = await call("/v1/responses", input, nativeIngressPort);
    assert.equal(response.status, 200);
    assert.equal(nativeSeen.length, 1);
    assert.equal(nativeSeen[0]!.authorization, "Bearer added-access");
  } finally {
    await nativeIngress.drain(1);
    await new Promise<void>((resolve) => native.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("native ingress respects persistent pauses in both Responses and Chat Completions", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-ingress-native-pause-"));
  const nativeSeen: http.IncomingHttpHeaders[] = [];
  const native = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      nativeSeen.push(req.headers);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_native_pause", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const nativePort = await listen(native);
  const added = saveClaudeOAuthAccount(home, { accessToken: "added-pause-test", refreshToken: "added-pause-refresh", expiresAt: Date.now() + 3_600_000, accountId: "added-pause-account" });
  const current = new ClaudeCodeAuthStore(new ClaudeCodeCredentialStore(() => JSON.stringify({ claudeAiOauth: { accessToken: "current-pause-test", expiresAt: Date.now() + 3_600_000 } })), { home, env: {}, credentialReaders: noClaudeCodeCredentialReaders });
  const claudeAccounts = new ClaudeAccountAuthPool({ home, current, log });
  const nativeConfig: Config = {
    ...config,
    providers: { claude: { type: "anthropic", auth: "claude-code", accountPool: false } },
    routes: { "claude-sonnet-5": { provider: "claude", model: "claude-sonnet-5" } },
  };
  const nativeIngress = new OpenAiIngress({ config: () => nativeConfig, log, requests, home, claudeAccounts, nativeUpstream: `http://127.0.0.1:${nativePort}`, claudeCodeCredentialReaders: noClaudeCodeCredentialReaders });
  const port = await nativeIngress.listen();
  const calls = [
    { pathname: "/v1/responses", body: input },
    { pathname: "/v1/chat/completions", body: { model: input.model, messages: [{ role: "user", content: "say ok" }] } },
  ];
  try {
    for (const request of calls) assert.equal((await call(request.pathname, request.body, port)).status, 200);
    assert.deepEqual(nativeSeen.map((headers) => headers.authorization), ["Bearer current-pause-test", "Bearer current-pause-test"]);
    setCurrentClaudeAccountPaused(home, true, "current-pause-test");
    for (const request of calls) assert.equal((await call(request.pathname, request.body, port)).status, 200);
    assert.deepEqual(nativeSeen.slice(2).map((headers) => headers.authorization), ["Bearer added-pause-test", "Bearer added-pause-test"]);
    updateClaudeAccount(home, added.id, { paused: true });
    for (const request of calls) {
      const refused = await call(request.pathname, request.body, port);
      assert.equal(refused.status, 401);
      assert.match(refused.text, /resume a paused/i);
    }
    assert.equal(nativeSeen.length, 4, "neither endpoint falls back to the ingress bearer token");
    setCurrentClaudeAccountPaused(home, false, "current-pause-test");
    for (const request of calls) assert.equal((await call(request.pathname, request.body, port)).status, 200);
    assert.deepEqual(nativeSeen.slice(4).map((headers) => headers.authorization), ["Bearer current-pause-test", "Bearer current-pause-test"]);
  } finally {
    await nativeIngress.drain(1);
    await new Promise<void>((resolve) => native.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("cleanup", async () => {
  await ingress.drain(1);
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});
