// A google provider is a normal translated provider: the real proxy must route a declared model to
// it over CONNECT/TLS, tag the request log GOOGLE, and refuse a `thread: continue` the way the other
// threadless providers do (§4d). Drives the real proxy, the way Claude Code reaches it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

import { CertStore } from "../src/certs.ts";
import { DEFAULTS, type Config } from "../src/config.ts";
import { UpstreamHealth } from "../src/health.ts";
import { Logger } from "../src/log.ts";
import { Proxy } from "../src/proxy.ts";
import { RequestLog, type RequestRecord } from "../src/requestlog.ts";
import { createCa } from "../src/x509.ts";
import { saveGoogleAccount } from "../src/providers/google/accounts.ts";
import { PRESETS } from "../src/presets.ts";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

type Rig = { health: () => ReturnType<Proxy["credentialHealth"]>; home: string; logs: () => string; send: (body: unknown, path?: string) => Promise<{ status: number; headers: string; body: string }>; records: () => RequestRecord[]; stop: () => Promise<void>; seen: { path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] };

/** What the fake upstream answers: fixed, or decided per request (1-based) — a credential differs per key. */
type Reply = { status: number; body: string; headers?: Record<string, string> };

type RigOptions = {
  /** Sign in an Antigravity account and answer its SDK prompt with 429. */
  promptRefusal?: boolean;
  /** Which google wire the test drives: a native `google` provider, or OpenCode's folded `google` model. */
  argon?: "google" | "opencode";
  reply?: (n: number, headers: http.IncomingHttpHeaders) => Reply | undefined;
  provider?: (url: string) => Config["providers"][string];
  /** Several keys on the OpenCode provider, in configured order; `headers` mirrors the first. */
  credentials?: { id: string; label?: string; headers: Record<string, string> }[];
};

async function rig(options: RigOptions = {}): Promise<Rig> {
  const { promptRefusal = false, argon, credentials } = options;
  const seen: Rig["seen"] = [];
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ path: req.url ?? "", headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
      const answer = options.reply?.(seen.length, req.headers);
      if (answer) {
        res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
        res.end(answer.body);
        return;
      }
      if (promptRefusal && JSON.stringify(seen.at(-1)!.body).includes("You are a Claude agent, built on Anthropic's Claude Agent SDK.")) {
        res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: {
          code: 429, status: "RESOURCE_EXHAUSTED", message: "Resource has been exhausted (e.g. check quota).",
        } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        [
          { candidates: [{ content: { parts: [{ text: "Hi" }] } }] },
          { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 } },
        ]
          .map((record) => `data: ${JSON.stringify(record)}\n\n`)
          .join(""),
      );
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-proxy-google-"));
  if (promptRefusal) saveGoogleAccount(home, {
    accessToken: "test-google-token", projectId: "test-project", email: "test@example.test", expiresAt: Date.now() + 3_600_000,
  });
  const ca = createCa({ cn: "clauderipple google test" });
  fs.writeFileSync(path.join(home, "ca.pem"), ca.certPem);
  fs.writeFileSync(path.join(home, "ca.key"), ca.keyPem);
  const proxyPort = await freePort();
  const go = PRESETS.find(p => p.id === "opencode-go")!;
  const argonModel = go.fallbackModels.find(m => m.id === "gemini-4-argon-contributor")!;
  const cfg: Config = {
    ...DEFAULTS,
    listen: { host: "127.0.0.1", port: proxyPort },
    providers: argon === "opencode" ? { "opencode-go": {
      type: "openai-compatible", preset: go.id, ...(go.wire ? { wire: go.wire } : {}),
      url: `http://127.0.0.1:${upstreamPort}/zen/go/v1`, headers: credentials ? credentials[0]!.headers : { authorization: "Bearer test-key" },
      ...(credentials ? { credentials } : {}),
      ...(go.sessionHeader ? { sessionHeader: go.sessionHeader } : {}),
      models: [{ ...argonModel, url: `http://127.0.0.1:${upstreamPort}/inference/go/google`, effortLevels: ["low", "medium", "high"] }],
    } } : { google: { type: "google", auth: promptRefusal ? "antigravity" : "api-key", apiKey: "test-key", url: `http://127.0.0.1:${upstreamPort}`, models: [{ id: argon ? "gemini-4-argon" : "gemini-3-pro-preview" }] } },
    routes: {},
    direct: [],
    aliases: {},
  };
  if (options.provider) cfg.providers = { google: options.provider(`http://127.0.0.1:${upstreamPort}`) };
  const requests = new RequestLog(path.join(home, "requests.jsonl"));
  const proxy = new Proxy({
    config: () => cfg,
    log: new Logger(path.join(home, "router.log"), 1e6, 1, false),
    certs: new CertStore(home),
    health: new UpstreamHealth(() => 100, () => {}),
    home,
    requests,
    agentDir: path.join(home, "agents"),
  });
  await proxy.listen();
  if (promptRefusal) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async input => {
      assert.match(String(input), /:retrieveUserQuotaSummary$/);
      return Response.json({ groups: [{ displayName: "Gemini Models", buckets: ["5h", "weekly"].map(window => ({
        bucketId: `gemini-${window}`, displayName: window, window, remainingFraction: 0.9,
        resetTime: new Date(Date.now() + 3_600_000).toISOString(),
      })) }] });
    };
    try { await proxy.googleUsage("google"); }
    finally { globalThis.fetch = originalFetch; }
  }

  const send = async (body: unknown, pathName = "/v1/messages"): Promise<{ status: number; headers: string; body: string }> => {
    const sock = net.connect(proxyPort, "127.0.0.1");
    await new Promise<void>((r) => sock.once("connect", () => r()));
    sock.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n");
    await new Promise<void>((r) => sock.once("data", () => r()));
    const secure = tls.connect({ socket: sock, servername: "api.anthropic.com", ca: ca.certPem });
    await new Promise<void>((r) => secure.once("secureConnect", () => r()));
    const raw = JSON.stringify(body);
    secure.write(
      `POST ${pathName} HTTP/1.1\r\nHost: api.anthropic.com\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(raw)}\r\n\r\n${raw}`,
    );
    // Anthropic streams chunked; wait for the terminal message_stop (or a short settle) so the whole
    // SSE body is present before we assert on it.
    const text = await new Promise<string>((resolve, reject) => {
      let received = "";
      let settle: NodeJS.Timeout | undefined;
      secure.on("data", (d: Buffer) => {
        received += d.toString("latin1");
        if (/message_stop|"type":"error"/.test(received)) return resolve(received);
        if (settle) clearTimeout(settle);
        settle = setTimeout(() => resolve(received), 150);
      });
      secure.once("error", reject);
    });
    secure.destroy();
    const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0);
    const split = text.indexOf("\r\n\r\n");
    const head = split >= 0 ? text.slice(0, split) : "";
    let raw2 = split >= 0 ? text.slice(split + 4) : "";
    if (/\r\ntransfer-encoding:\s*chunked/i.test(head)) {
      let out = "";
      let offset = 0;
      while (offset < raw2.length) {
        const lineEnd = raw2.indexOf("\r\n", offset);
        if (lineEnd < 0) break;
        const length = Number.parseInt(raw2.slice(offset, lineEnd), 16);
        if (!Number.isFinite(length) || length === 0) break;
        const start = lineEnd + 2;
        out += raw2.slice(start, start + length);
        offset = start + length + 2;
      }
      raw2 = out;
    }
    return { status, headers: head, body: raw2 };
  };

  return {
    home,
    health: () => proxy.credentialHealth(),
    logs: () => fs.readFileSync(path.join(home, "router.log"), "utf8"),
    send,
    records: () => requests.list(20),
    seen,
    stop: async () => {
      proxy.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

test("an Antigravity SDK refusal is logged as an upstream request failure without disabling compatible requests", async () => {
  const r = await rig({ promptRefusal: true });
  try {
    const body = { model: "gemini-3-pro-preview", max_tokens: 16, stream: true,
      system: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", messages: [{ role: "user", content: "hi" }] };
    const refused = await r.send(body);
    assert.equal(refused.status, 400);
    assert.match(refused.body, /invalid_request_error/);
    const record = r.records().find(row => row.status === 400)!;
    assert.ok(record);
    assert.equal(record.provider, "google");
    assert.equal(record.refusal, "prompt-incompatible");
    assert.equal(record.ok, false);
    assert.equal(record.upstreamCalled, undefined);
    assert.match(record.note!, /upstream 429/);
    assert.equal(r.seen.length, 1);
    const compatible = await r.send({ ...body, system: "Ordinary system instructions." });
    assert.equal(compatible.status, 200);
    assert.equal(r.seen.length, 2);
    assert.equal(r.seen[1]!.headers.authorization, r.seen[0]!.headers.authorization);
  } finally {
    await r.stop();
  }
});

// Claude Code retries a plain 429 ten times over ~2.5 minutes. Google's monthly spending cap is not
// a rate limit — no retry inside that window can succeed — so the answer says not to (#89).
test("a Google spending-cap 429 says not to retry; a bare 429 rate limit does not", async () => {
  const request = { model: "gemini-3-pro-preview", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] };
  const capped = await rig({ reply: () => ({
    status: 429,
    headers: { "retry-after": "120" },
    body: JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Your project has exceeded its monthly spending cap." } }),
  }) });
  try {
    const res = await capped.send(request);
    assert.equal(res.status, 429);
    assert.match(res.headers, /x-should-retry: false/i);
    assert.match(res.headers, /retry-after: 120/i);
    assert.match(res.body, /monthly spending cap/, "the status and body are unchanged");
  } finally {
    await capped.stop();
  }

  const rate = await rig({ reply: () => ({
    status: 429,
    headers: { "retry-after": "2" },
    body: JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Resource has been exhausted (e.g. check quota)." } }),
  }) });
  try {
    const res = await rate.send(request);
    assert.equal(res.status, 429);
    assert.doesNotMatch(res.headers, /x-should-retry/i);
  } finally {
    await rate.stop();
  }
});

test("a declared google model is routed to the provider over TLS and logged GOOGLE", async () => {
  const r = await rig();
  try {
    const { status, body } = await r.send({ model: "gemini-3-pro-preview", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] });
    assert.equal(status, 200);
    assert.match(body, /"stop_reason":"end_turn"/);
    const sent = r.seen.at(-1)!;
    assert.equal(sent.path, "/v1beta/models/gemini-3-pro-preview:streamGenerateContent?alt=sse");
    assert.equal(sent.headers["x-goog-api-key"], "test-key");
    assert.equal(sent.body.model, undefined, "the model is in the path, not the body");
    const rec = r.records().find((x) => x.kind === "messages")!;
    assert.equal(rec.provider, "google");
    assert.equal(rec.target, "gemini-3-pro-preview");
    assert.equal(rec.ok, true);
  } finally {
    await r.stop();
  }
});

for (const provider of ["google", "opencode"] as const) {
  test(`Gemini 4 Argon @high reaches the ${provider} upstream as a thinkingLevel`, async () => {
    const r = await rig({ argon: provider });
    try {
      const model = provider === "google" ? "gemini-4-argon" : "gemini-4-argon-contributor";
      const response = await r.send({ model: `${model}@high`, max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] });
      assert.equal(response.status, 200);
      assert.equal(r.seen.length, 1);
      const sent = r.seen[0]!;
      const prefix = provider === "google" ? "" : "/inference/go/google";
      assert.equal(sent.path, `${prefix}/v1beta/models/${model}:streamGenerateContent?alt=sse`);
      assert.deepEqual(sent.body.generationConfig, { maxOutputTokens: 16, thinkingConfig: { thinkingLevel: "high" } });
      assert.equal(sent.body.reasoning_effort, undefined, "this model uses Google's wire even on OpenCode");
      assert.equal(sent.headers["x-goog-api-key"], "test-key");
      assert.equal(sent.headers.authorization, undefined);
      if (provider === "opencode") assert.ok(sent.headers["x-opencode-session"]);
    } finally { await r.stop(); }
  });
}

test("a spent key on the google wire retries the next key before anything is written (#112)", async () => {
  // OpenCode Go answers a Gemini model on its own go/google path, keyed per workspace. Its keys share
  // one provider, so the google wire must use that provider's pool the way every other wire does:
  // pick by configured order, and on a spent key go to the next one inside the same turn.
  const r = await rig({
    argon: "opencode",
    credentials: [
      { id: "main", label: "메인", headers: { authorization: "Bearer key-main" } },
      { id: "sub", label: "서브 1", headers: { authorization: "Bearer key-sub" } },
    ],
    reply: (n) => n === 1
      ? {
          status: 429,
          body: JSON.stringify({ type: "error", error: { type: "GoUsageLimitError", message: "Go usage limit exceeded" }, metadata: { workspace: "org_main", limitName: "weekly" } }),
        }
      : {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: [
            { candidates: [{ content: { parts: [{ text: "Hi" }] } }] },
            { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 } },
          ].map((record) => `data: ${JSON.stringify(record)}\n\n`).join(""),
        },
  });
  const turn = { model: "gemini-4-argon-contributor", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] };
  try {
    const first = await r.send(turn);
    assert.equal(first.status, 200, "the second key answered the very first ask");
    assert.deepEqual(r.seen.map((row) => row.headers["x-goog-api-key"]), ["key-main", "key-sub"]);
    assert.deepEqual(r.seen.map((row) => row.headers.authorization), [undefined, undefined], "the key is sent once, on the wire's own header");
    const record = r.records().find((row) => row.kind === "messages" && row.ok)!;
    assert.equal(record.credential, "서브 1", "the record names the key that answered, not the one it started on");
    const logs = r.logs();
    assert.match(logs, /KEY opencode-go credential=메인 .* reason=configured-order candidates=\[메인:ready, 서브 1:ready\]/);
    assert.match(logs, /RETRY opencode-go: 메인 answered 429, trying 서브 1/);
    assert.match(logs, /KEY opencode-go credential=서브 1 .* reason=retry candidates=\[메인:cooling, 서브 1:ready\]/, "the spent key is rested");
    for (const text of [logs, fs.readFileSync(path.join(r.home, "requests.jsonl"), "utf8")]) assert.doesNotMatch(text, /key-(?:main|sub)/);

    // The conversation's next turn stays on the key that answered.
    assert.equal((await r.send(turn)).status, 200);
    assert.deepEqual(r.seen.map((row) => row.headers["x-goog-api-key"]), ["key-main", "key-sub", "key-sub"]);
  } finally {
    await r.stop();
  }
});

const poolKeys = ["synthetic-pool-first", "synthetic-pool-second"];
const poolTurn = { model: "gemini-3-pro-preview", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] };
const limited: Reply = { status: 429, body: JSON.stringify({ error: { message: "rate limit" } }) };
const pooledGoogle: NonNullable<RigOptions["provider"]> = url => ({
  type: "google", auth: "api-key", apiKey: "synthetic-provider-key", url,
  headers: { Authorization: "Bearer synthetic-base-auth", "X-Goog-Api-Key": "synthetic-base-google", "X-Vendor": "keep" },
  credentials: poolKeys.map((key, i) => ({ id: `key-${i}`, headers: { "X-Api-Key": key } })),
  models: [{ id: poolTurn.model }],
});

for (const stream of [true, false]) {
  test(`Google ${stream ? "SSE" : "buffered"} errors redact every attempted key and provider secret (#112)`, async () => {
    const secrets = [...poolKeys, "synthetic-provider-key", "synthetic-base-auth", "synthetic-base-google"];
    const error = { error: { status: "RESOURCE_EXHAUSTED", message: `rejected ${secrets.join(" and ")}` } };
    const r = await rig({ provider: pooledGoogle, reply: n => n === 1 ? limited : {
      status: 200, headers: { "content-type": stream ? "text/event-stream" : "application/json" },
      body: stream ? `data: ${JSON.stringify(error)}\n\n` : JSON.stringify(error),
    } });
    try {
      const result = await r.send({ ...poolTurn, stream });
      assert.equal(result.status, stream ? 200 : 429);
      assert.match(result.body, /rate_limit_error/);
      assert.equal(r.seen.length, 2, "a committed error must not rotate again");
      for (const text of [result.body, r.logs(), fs.readFileSync(path.join(r.home, "requests.jsonl"), "utf8")]) {
        for (const secret of secrets) assert.ok(!text.includes(secret), `leaked ${secret}`);
      }
      assert.equal(r.records()[0]!.ok, false);
    } finally { await r.stop(); }
  });
}

test("single-key Google stream errors are redacted without changing outbound authentication (#112)", async () => {
  const r = await rig({ provider: url => ({
    type: "google", auth: "api-key", url, apiKey: "synthetic-single-key",
    headers: { Authorization: "Bearer synthetic-extra-auth", "X-Vendor": "keep" }, models: [{ id: poolTurn.model }],
  }), reply: () => ({ status: 200, headers: { "content-type": "text/event-stream" },
    body: `data: ${JSON.stringify({ error: { message: "rejected synthetic-single-key synthetic-extra-auth", status: "UNAVAILABLE" } })}\n\n`,
  }) });
  try {
    const result = await r.send(poolTurn);
    assert.equal(r.seen[0]!.headers["x-goog-api-key"], "synthetic-single-key");
    assert.equal(r.seen[0]!.headers.authorization, "Bearer synthetic-extra-auth", "same headers as before pooling");
    assert.equal(r.seen[0]!.headers["x-vendor"], "keep");
    for (const text of [result.body, r.logs(), JSON.stringify(r.records())]) {
      assert.ok(!text.includes("synthetic-single-key"));
      assert.ok(!text.includes("synthetic-extra-auth"));
    }
  } finally { await r.stop(); }
});

test("Google header-parser exceptions and retry diagnostics redact all attempted credentials (#112)", async () => {
  const invalid = "synthetic-invalid\ncredential-value";
  const r = await rig({ provider: url => ({ ...pooledGoogle(url), credentials: [
    { id: "first", headers: { "x-api-key": poolKeys[0]! } },
    { id: "second", headers: { "x-api-key": invalid } },
  ] }), reply: () => limited });
  try {
    const result = await r.send(poolTurn);
    assert.equal(result.status, 502);
    assert.equal(r.seen.length, 1);
    assert.match(r.logs(), /retrying/);
    for (const text of [result.body, r.logs(), fs.readFileSync(path.join(r.home, "requests.jsonl"), "utf8")]) {
      for (const secret of [poolKeys[0]!, invalid, invalid.replace(/\s+/g, " "), JSON.stringify(invalid).slice(1, -1)]) assert.ok(!text.includes(secret));
    }
  } finally { await r.stop(); }
});

test("a pooled Google credential replaces base authentication without duplicate header values (#112)", async () => {
  const r = await rig({ provider: pooledGoogle, reply: n => n === 1 ? limited : undefined });
  try {
    assert.equal((await r.send(poolTurn)).status, 200);
    assert.deepEqual(r.seen.map(row => row.headers["x-goog-api-key"]), poolKeys);
    for (const row of r.seen) {
      assert.equal(row.headers.authorization, undefined);
      assert.equal(row.headers["x-api-key"], undefined);
      assert.equal(row.headers["x-vendor"], "keep");
    }
  } finally { await r.stop(); }
});

test("folded Google credentials replace case-varied vendor headers (#112)", async () => {
  const r = await rig({ argon: "opencode", credentials: [
    { id: "a", headers: { Authorization: `Bearer ${poolKeys[0]}`, "X-Workspace": "workspace-a" } },
    { id: "b", headers: { authorization: `Bearer ${poolKeys[1]}`, "x-workspace": "workspace-b" } },
  ], reply: n => n === 1 ? limited : undefined });
  try {
    assert.equal((await r.send({ ...poolTurn, model: "gemini-4-argon-contributor" })).status, 200);
    assert.deepEqual(r.seen.map(row => row.headers["x-workspace"]), ["workspace-a", "workspace-b"]);
    assert.deepEqual(r.seen.map(row => row.headers["x-goog-api-key"]), poolKeys);
  } finally { await r.stop(); }
});

test("pooled Google headers replace a case-varied generated session header (#112)", async () => {
  const r = await rig({ provider: url => ({ ...pooledGoogle(url), sessionHeader: "X-Session", credentials: [
    { id: "one", headers: { "x-api-key": poolKeys[0]!, "x-session": "credential-session" } },
  ] }) });
  try {
    assert.equal((await r.send(poolTurn)).status, 200);
    assert.equal(r.seen[0]!.headers["x-session"], "credential-session");
  } finally { await r.stop(); }
});

test("a final Google HTTP error redacts all attempted and provider credentials (#112)", async () => {
  const secrets = [...poolKeys, "synthetic-provider-key", "synthetic-base-auth", "synthetic-base-google"];
  const r = await rig({ provider: pooledGoogle, reply: () => ({ status: 429,
    body: JSON.stringify({ error: { message: `rejected ${secrets.join(" and ")}` } }),
  }) });
  try {
    const result = await r.send(poolTurn);
    assert.equal(result.status, 429);
    assert.equal(r.seen.length, 2);
    for (const text of [result.body, r.logs(), fs.readFileSync(path.join(r.home, "requests.jsonl"), "utf8")]) {
      for (const secret of secrets) assert.ok(!text.includes(secret));
    }
  } finally { await r.stop(); }
});

for (const error of [
  { status: "API_KEY_INVALID" },
  { status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] },
  { status: "PERMISSION_DENIED" },
  { status: "INVALID_ARGUMENT", message: "malformed request" },
  { status: "INVALID_ARGUMENT", message: "request text mentions API_KEY_INVALID and PERMISSION_DENIED" },
]) {
  const auth = error.status !== "INVALID_ARGUMENT" || "details" in error;
  test(`Google HTTP 400 ${JSON.stringify(error)} ${auth ? "rotates" : "does not rotate"} (#112)`, async () => {
    const r = await rig({ provider: pooledGoogle, reply: n => n === 1 ? { status: 400, body: JSON.stringify({ error }) } : undefined });
    try {
      // The client-facing status of a refusal is mapHttpError's call (it reads text loosely); what
      // this pins is whether the pool rotated.
      const status = (await r.send(poolTurn)).status;
      if (auth) assert.equal(status, 200);
      else assert.notEqual(status, 200);
      assert.equal(r.seen.length, auth ? 2 : 1);
      assert.equal(r.health().google![0]!.state, auth ? "quarantined" : "ready");
    } finally { await r.stop(); }
  });
}

for (const refusal of [
  { status: 429, headers: { "retry-after": "3600" }, body: JSON.stringify({ error: { message: "rate limit" } }) },
  { status: 400, body: JSON.stringify({ error: { type: "server_error", message: "Upstream request failed: This Go model requires Global regions" } }) },
]) {
  test(`the final Google ${refusal.status} preserves upstream cooldown evidence (#112)`, async () => {
    const r = await rig({ provider: pooledGoogle, reply: () => refusal });
    try {
      assert.equal((await r.send(poolTurn)).status, refusal.status);
      assert.equal(r.seen.length, 2);
      for (const key of r.health().google!) {
        assert.equal(key.state, "cooling");
        assert.ok(key.cooldownSeconds! >= (refusal.status === 429 ? 3590 : 50));
      }
    } finally { await r.stop(); }
  });
}

test("a google model is refused a web_search side request, not sent upstream", async () => {
  const r = await rig();
  try {
    const before = r.seen.length;
    const { status, body } = await r.send({
      model: "gemini-3-pro-preview",
      max_tokens: 16,
      stream: true,
      messages: [{ role: "user", content: "Perform a web search for the query: latest Node.js 24 release" }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
      tool_choice: { type: "auto" },
    });
    // Answered with a visible "unavailable" result, not prose shaped like an answer, and nothing sent.
    assert.equal(status, 200);
    assert.equal(r.seen.length, before, "nothing was sent upstream");
    const rec = r.records().find((x) => x.kind === "messages")!;
    assert.match(rec.note ?? "", /web search refused/);
  } finally {
    await r.stop();
  }
});

test("a thread: continue to a google provider is refused 400, not forwarded", async () => {
  const r = await rig();
  try {
    const before = r.seen.length;
    const { status, body } = await r.send({
      model: "gemini-3-pro-preview",
      max_tokens: 16,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
      thread: { type: "continue", id: "t1" },
    });
    assert.equal(status, 400);
    assert.match(body, /without server-side threads/);
    assert.equal(r.seen.length, before, "nothing was sent upstream");
  } finally {
    await r.stop();
  }
});
