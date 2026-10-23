// Native Anthropic account rotation through the real TLS proxy. No request translation is involved:
// only the OAuth identity changes when one account is rate-limited or rejected.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

import { CertStore } from "../src/certs.ts";
import { DEFAULTS, type Config } from "../src/config.ts";
import { UpstreamHealth } from "../src/health.ts";
import { Logger } from "../src/log.ts";
import { ObservedClaudeCodeAuth } from "../src/providers/anthropic-observed.ts";
import { readClaudeAccountsFile, saveClaudeOAuthAccount, setCurrentClaudeAccountPaused, updateClaudeAccount } from "../src/providers/anthropic-accounts.ts";
import { Proxy } from "../src/proxy.ts";
import { RequestLog } from "../src/requestlog.ts";
import { createCa, createLeaf } from "../src/x509.ts";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

type Seen = { authorization?: string; apiKey?: string; currentOnly?: string; beta?: string; body: Record<string, unknown> };
type Reply = { status: number; headers?: Record<string, string>; body?: string };

async function nativeRig(reply: (seen: Seen, attempt: number) => Reply) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-native-account-proxy-"));
  const ca = createCa({ cn: "clauderipple native account test" });
  const leaf = createLeaf({ host: "localhost", caCertPem: ca.certPem, caKeyPem: ca.keyPem });
  fs.writeFileSync(path.join(home, "ca.pem"), ca.certPem);
  fs.writeFileSync(path.join(home, "ca.key"), ca.keyPem);

  const seen: Seen[] = [];
  const upstream = https.createServer({ cert: leaf.certPem, key: leaf.keyPem }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const item = {
        ...(typeof req.headers.authorization === "string" ? { authorization: req.headers.authorization } : {}),
        ...(typeof req.headers["x-api-key"] === "string" ? { apiKey: req.headers["x-api-key"] } : {}),
        ...(typeof req.headers["anthropic-client-current-only"] === "string" ? { currentOnly: req.headers["anthropic-client-current-only"] } : {}),
        ...(typeof req.headers["anthropic-beta"] === "string" ? { beta: req.headers["anthropic-beta"] } : {}),
        body,
      };
      seen.push(item);
      const response = reply(item, seen.length);
      res.writeHead(response.status, { "content-type": "application/json", ...(response.headers ?? {}) });
      res.end(response.body ?? JSON.stringify({ id: "msg", type: "message", role: "assistant", model: body.model, content: [], usage: {} }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;

  const observed = new ObservedClaudeCodeAuth();
  observed.observe([
    "authorization", "Bearer current-token",
    "anthropic-version", "2023-06-01",
    "anthropic-client-current-only", "current-fingerprint",
  ]);
  const stored = saveClaudeOAuthAccount(home, {
    accessToken: "stored-token",
    refreshToken: "stored-refresh",
    expiresAt: Date.now() + 3_600_000,
    accountId: "stored-upstream-uuid",
    email: "stored@example.test",
  });
  saveClaudeOAuthAccount(home, {
    accessToken: "third-token",
    refreshToken: "third-refresh",
    expiresAt: Date.now() + 3_600_000,
    accountId: "third-upstream-uuid",
    email: "third@example.test",
  });

  const proxyPort = await freePort();
  const cfg: Config = {
    ...DEFAULTS,
    upstream: "localhost",
    listen: { host: "127.0.0.1", port: proxyPort },
    providers: {
      claude: {
        type: "anthropic",
        auth: "claude-code",
        accountPool: true,
        models: [{ id: "claude-opus-5" }],
      },
    },
    routes: { "claude-opus-4-8": { provider: "claude", model: "claude-opus-5" } },
    direct: [],
  };
  const requests = new RequestLog(path.join(home, "requests.jsonl"));
  const proxy = new Proxy({
    config: () => cfg,
    log: new Logger(path.join(home, "router.log"), 1e6, 1, false),
    certs: new CertStore(home),
    health: new UpstreamHealth(() => 100, () => {}),
    home,
    requests,
    agentDir: path.join(home, "agents"),
    observedClaudeCodeAuth: observed,
    claudeCodeCredentialReaders: { keychain: () => null, credentialsFile: () => null },
    upstreamPort,
    upstreamAgent: new https.Agent({ ca: ca.certPem }),
  });
  await proxy.listen();

  const sendRequest = async (conversation = "conversation-1", options: { path?: string; model?: string; authorization?: string | null; apiKey?: string } = {}): Promise<{ status: number; text: string }> => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write("CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n");
    await new Promise<void>((resolve) => socket.once("data", resolve));
    const secure = tls.connect({ socket, servername: "localhost", ca: ca.certPem });
    await new Promise<void>((resolve) => secure.once("secureConnect", resolve));
    const body = JSON.stringify({
      model: options.model ?? "claude-opus-4-8",
      max_tokens: 32,
      metadata: { user_id: conversation },
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
      tool_choice: { type: "tool", name: "web_search" },
      messages: [{ role: "user", content: "find this" }],
    });
    secure.write(
      `POST ${options.path ?? "/v1/messages"} HTTP/1.1\r\n` +
      "Host: localhost\r\n" +
      "content-type: application/json\r\n" +
      (options.authorization === null ? "" : `authorization: ${options.authorization ?? "Bearer caller-token"}\r\n`) +
      (options.apiKey ? `x-api-key: ${options.apiKey}\r\n` : "") +
      "anthropic-client-current-only: caller-fingerprint\r\n" +
      "anthropic-beta: claude-code-20250219,prompt-caching-scope-2026-01-05\r\n" +
      `content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    const first = await new Promise<Buffer>((resolve) => secure.once("data", (chunk: Buffer) => setTimeout(() => resolve(chunk), 30)));
    secure.destroy();
    const response = first.toString("utf8");
    return { status: Number(/^HTTP\/1\.1 (\d{3})/.exec(response)?.[1] ?? 0), text: response.slice(response.indexOf("\r\n\r\n") + 4) };
  };

  return {
    home,
    cfg,
    stored,
    seen,
    requests,
    sendRequest,
    send: async (conversation = "conversation-1") => (await sendRequest(conversation)).status,
    stop: async () => {
      proxy.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test("pausing native and stored accounts removes sticky choices until explicitly resumed", async () => {
  const rig = await nativeRig(() => ({ status: 200 }));
  try {
    assert.equal(await rig.send("pause-conversation"), 200);
    setCurrentClaudeAccountPaused(rig.home, true, "current-token");
    assert.equal(await rig.send("pause-conversation"), 200);
    assert.deepEqual(rig.seen.map((item) => item.authorization), ["Bearer current-token", "Bearer stored-token"]);
    updateClaudeAccount(rig.home, rig.stored.id, { paused: true });
    assert.equal(await rig.send("pause-conversation"), 200);
    assert.equal(rig.seen.at(-1)?.authorization, "Bearer third-token");
    for (const account of readClaudeAccountsFile(rig.home)) updateClaudeAccount(rig.home, account.id, { paused: true });
    const unavailable = await rig.sendRequest("pause-conversation");
    assert.equal(unavailable.status, 401);
    assert.match(unavailable.text, /no usable Claude account/i);
    assert.equal(rig.seen.length, 3, "all-paused must not fall back to the caller's headers");
    assert.equal(rig.requests.list(1)[0]?.refusal, "no-account");
    assert.equal(rig.requests.list(1)[0]?.upstreamCalled, false);
    setCurrentClaudeAccountPaused(rig.home, false, "current-token");
    assert.equal(await rig.send("pause-conversation"), 200);
    assert.equal(rig.seen.at(-1)?.authorization, "Bearer current-token");
  } finally {
    await rig.stop();
  }
});

for (const mode of ["rotation-off", "unconfigured"] as const) {
  test(`native pause blocks Messages and count_tokens passthrough (${mode}), not Remote Control`, async () => {
    const rig = await nativeRig(() => ({ status: 200 }));
    try {
      if (mode === "unconfigured") {
        rig.cfg.providers = {};
        rig.cfg.routes = {};
      } else {
        const provider = rig.cfg.providers.claude!;
        assert.equal(provider.type, "anthropic");
        if (provider.type === "anthropic") provider.accountPool = false;
      }
      setCurrentClaudeAccountPaused(rig.home, true, "current-token");
      for (const requestPath of ["/v1/messages", "/v1/messages/count_tokens"]) {
        const refused = await rig.sendRequest("paused-passthrough", { path: requestPath });
        assert.equal(refused.status, 401);
        assert.match(refused.text, /paused.*resume/i);
        assert.equal(rig.requests.list(1)[0]?.upstreamCalled, false);
        assert.equal(rig.requests.list(1)[0]?.refusal, "no-account");
      }
      assert.equal(rig.seen.length, 0);
      assert.equal((await rig.sendRequest("bridge", { path: "/v1/environments/bridge" })).status, 200);
      assert.equal(rig.seen.length, 1, "non-inference traffic retains its external authentication");
      setCurrentClaudeAccountPaused(rig.home, false, "current-token");
      assert.equal(await rig.send("paused-passthrough"), 200);
      assert.equal(rig.seen.at(-1)?.authorization, "Bearer caller-token");
    } finally {
      await rig.stop();
    }
  });
}

test("native count_tokens checks the caller's paused grant instead of another current login", async () => {
  const rig = await nativeRig(() => ({ status: 200 }));
  try {
    rig.cfg.providers = {};
    rig.cfg.routes = {};
    updateClaudeAccount(rig.home, rig.stored.id, { paused: true }, "current-token");
    const refused = await rig.sendRequest("paused-count-token", { path: "/v1/messages/count_tokens", authorization: "Bearer stored-token" });
    assert.equal(refused.status, 401);
    assert.match(refused.text, /paused.*resume/i);
    assert.equal(rig.seen.length, 0, "a different observed login cannot authorize the caller's paused token");
    assert.equal(rig.requests.list(1)[0]?.upstreamCalled, false);
  } finally {
    await rig.stop();
  }
});

test("native OAuth pause leaves an independent API-key passthrough untouched", async () => {
  const rig = await nativeRig(() => ({ status: 200 }));
  try {
    rig.cfg.providers = {};
    rig.cfg.routes = {};
    setCurrentClaudeAccountPaused(rig.home, true, "current-token");
    for (const requestPath of ["/v1/messages", "/v1/messages/count_tokens"]) {
      assert.equal((await rig.sendRequest("independent-api-key", { path: requestPath, authorization: null, apiKey: "independent-test-key" })).status, 200);
    }
    assert.deepEqual(rig.seen.map((item) => [item.authorization, item.apiKey]), [
      [undefined, "independent-test-key"], [undefined, "independent-test-key"],
    ]);
  } finally {
    await rig.stop();
  }
});

test("native retries skip an account paused while the first response is pending", async () => {
  let home = "";
  let nextId = "";
  const rig = await nativeRig((_seen, attempt) => {
    if (attempt !== 1) return { status: 200 };
    updateClaudeAccount(home, nextId, { paused: true });
    return { status: 429, headers: { "retry-after": "300" }, body: "{}" };
  });
  home = rig.home;
  nextId = rig.stored.id;
  try {
    assert.equal(await rig.send("pause-before-retry"), 200);
    assert.deepEqual(rig.seen.map((item) => item.authorization), ["Bearer current-token", "Bearer third-token"]);
  } finally {
    await rig.stop();
  }
});

test("pausing the native login does not block an explicitly routed compatible provider", async () => {
  let compatibleCalls = 0;
  const compatible = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      compatibleCalls++;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_routed", type: "message", role: "assistant", content: [], usage: {} }));
    });
  });
  await new Promise<void>((resolve) => compatible.listen(0, "127.0.0.1", resolve));
  const port = (compatible.address() as net.AddressInfo).port;
  const rig = await nativeRig(() => ({ status: 200 }));
  try {
    rig.cfg.providers.other = { type: "anthropic-compatible", url: `http://127.0.0.1:${port}`, headers: { "x-api-key": "compatible-test-key" } };
    rig.cfg.routes["claude-routed"] = { provider: "other", model: "other-model" };
    setCurrentClaudeAccountPaused(rig.home, true, "current-token");
    assert.equal((await rig.sendRequest("routed", { model: "claude-routed" })).status, 200);
    assert.equal(compatibleCalls, 1);
    assert.equal(rig.seen.length, 0);
  } finally {
    await rig.stop();
    await new Promise<void>((resolve) => compatible.close(() => resolve()));
  }
});

test("a native Claude turn survives 429, keeps the replacement account, and preserves server tools", async () => {
  const rig = await nativeRig((_seen, attempt) => attempt === 1
    ? { status: 429, headers: { "retry-after": "300" }, body: JSON.stringify({ type: "error", error: { type: "rate_limit_error" } }) }
    : { status: 200 });
  try {
    assert.equal(await rig.send(), 200, "the first client request survives the first account's limit");
    assert.equal(await rig.send(), 200, "the conversation remains on the account that answered");
    assert.deepEqual(rig.seen.map((item) => item.authorization), ["Bearer current-token", "Bearer stored-token", "Bearer stored-token"]);
    assert.equal(rig.seen[0]!.currentOnly, "current-fingerprint");
    assert.equal(rig.seen[1]!.currentOnly, undefined, "the previous identity's fingerprint header is removed on retry");
    assert.equal(rig.seen[2]!.currentOnly, undefined, "a stored account chosen on the next request does not inherit the caller fingerprint");
    assert.equal(rig.seen[1]!.body.model, "claude-opus-5");
    assert.deepEqual(rig.seen[1]!.body.tools, [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }]);
    assert.deepEqual(rig.seen[1]!.body.tool_choice, { type: "tool", name: "web_search" });
    const logs = JSON.stringify(rig.requests.list(20));
    assert.doesNotMatch(logs, /current-token|stored-token|stored-refresh|stored-upstream-uuid|stored@example\.test/);
    const runtimeDigest = crypto.createHash("sha256").update("stored-refresh").digest("hex").slice(0, 12);
    assert.doesNotMatch(fs.readFileSync(path.join(rig.home, "router.log"), "utf8"), new RegExp(runtimeDigest));
  } finally {
    await rig.stop();
  }
});

test("a third account does not regain the first session's identity headers", async () => {
  const rig = await nativeRig((_seen, attempt) => attempt < 3
    ? { status: 429, headers: { "retry-after": "300" }, body: "{}" }
    : { status: 200 });
  try {
    assert.equal(await rig.send("three-account-conversation"), 200);
    assert.deepEqual(rig.seen.map((item) => item.authorization), ["Bearer current-token", "Bearer stored-token", "Bearer third-token"]);
    assert.deepEqual(rig.seen.map((item) => item.currentOnly), ["current-fingerprint", undefined, undefined]);
  } finally {
    await rig.stop();
  }
});

test("every account keeps the client's beta flags alongside its own OAuth flags (issue #15)", async () => {
  const rig = await nativeRig((_seen, attempt) => attempt === 1
    ? { status: 429, headers: { "retry-after": "300" }, body: "{}" }
    : { status: 200 });
  try {
    assert.equal(await rig.send("beta-conversation"), 200);
    assert.equal(await rig.send("beta-conversation"), 200);
    assert.equal(rig.seen[0]!.beta, "claude-code-20250219,prompt-caching-scope-2026-01-05", "an observed session without its own flags sends the client's");
    for (const item of rig.seen.slice(1)) {
      assert.equal(item.authorization, "Bearer stored-token");
      assert.equal(item.beta, "claude-code-20250219,prompt-caching-scope-2026-01-05,oauth-2025-04-20", "stored account: client flags plus OAuth, no duplicates");
    }
  } finally {
    await rig.stop();
  }
});

test("a native Claude request error does not consume another account", async () => {
  const rig = await nativeRig(() => ({
    status: 400,
    body: JSON.stringify({ type: "error", error: { type: "invalid_request_error" } }),
  }));
  try {
    assert.equal(await rig.send(), 400);
    assert.deepEqual(rig.seen.map((item) => item.authorization), ["Bearer current-token"]);
  } finally {
    await rig.stop();
  }
});

test("a stored Claude account rejected with 401 is persisted as needing reauthentication", async () => {
  const rig = await nativeRig((seen) => seen.authorization === "Bearer current-token"
    ? { status: 429, headers: { "retry-after": "300" }, body: "{}" }
    : { status: 401, body: JSON.stringify({ type: "error", error: { type: "authentication_error" } }) });
  try {
    assert.equal(await rig.send(), 401);
    const stored = readClaudeAccountsFile(rig.home).find((account) => account.id === rig.stored.id)!;
    assert.equal(stored.needsReauth, true);
  } finally {
    await rig.stop();
  }
});
