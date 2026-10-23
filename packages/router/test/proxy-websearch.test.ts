// ChatGPT hosted search answers a search when cfg.webSearch names that provider, or when the search
// is routed to one. Drive the real CONNECT/TLS proxy so interception-before-routing, the routed
// path and the response shape stay covered.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

import { CertStore } from "../src/certs.ts";
import { DEFAULTS, type Config, type Provider } from "../src/config.ts";
import { UpstreamHealth } from "../src/health.ts";
import { Logger } from "../src/log.ts";
import { Proxy } from "../src/proxy.ts";
import { RequestLog, type RequestRecord } from "../src/requestlog.ts";
import { createCa } from "../src/x509.ts";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function decodeHttpResponse(raw: Buffer): { status: number; body: string } {
  const split = raw.indexOf("\r\n\r\n");
  assert.ok(split >= 0, "response has headers");
  const head = raw.subarray(0, split).toString("latin1");
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
  let body = raw.subarray(split + 4);
  if (/\r\ntransfer-encoding:\s*chunked/i.test(head)) {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < body.length) {
      const lineEnd = body.indexOf("\r\n", offset);
      assert.ok(lineEnd >= 0, "chunk has a size line");
      const length = Number.parseInt(body.subarray(offset, lineEnd).toString("ascii"), 16);
      assert.ok(Number.isFinite(length), "chunk size is hexadecimal");
      if (length === 0) break;
      const start = lineEnd + 2;
      chunks.push(body.subarray(start, start + length));
      offset = start + length + 2;
    }
    body = Buffer.concat(chunks);
  }
  return { status, body: body.toString("utf8") };
}

type SearchReply = {
  status: number;
  message: { content: { type?: string; content?: unknown }[]; usage: { server_tool_use: { web_search_requests: number } }; error?: { type?: string; message?: string } };
  seenTool: unknown;
  target: string | undefined;
  record: RequestRecord | undefined;
};

type SearchRig = {
  seen: http.IncomingHttpHeaders[];
  search: (model: string) => Promise<SearchReply>;
  replaceProviders: (providers: Config["providers"]) => void;
  stop: () => Promise<void>;
};
type BackendReply = (res: http.ServerResponse) => void;

/** A local hosted-search backend, reached through the real CONNECT/TLS proxy. */
async function searchRig(cfgFor: (backendUrl: string) => Partial<Config>, reply?: BackendReply): Promise<SearchRig> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-proxy-websearch-"));
  const ca = createCa({ cn: "clauderipple web-search test" });
  fs.writeFileSync(path.join(home, "ca.pem"), ca.certPem);
  fs.writeFileSync(path.join(home, "ca.key"), ca.keyPem);
  fs.writeFileSync(path.join(home, "chatgpt-auth.json"), JSON.stringify({
    accessToken: "tok_test",
    accountId: "acct_test",
    expiresAt: Date.now() + 3600_000,
    source: "own",
  }));

  let seenTool: unknown;
  const seen: http.IncomingHttpHeaders[] = [];
  const backend = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tools?: unknown[] };
      seenTool = body.tools?.[0];
      seen.push(req.headers);
      if (reply) { reply(res); return; }
      const events = [
        { type: "response.output_text.delta", delta: "Node.js 24 is current." },
        { type: "response.output_text.annotation.added", annotation: { type: "url_citation", title: "Node.js", url: "https://nodejs.org/en/download" } },
        { type: "response.completed", response: { tool_usage: { web_search: { num_requests: 1 } } } },
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    });
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const backendPort = (backend.address() as net.AddressInfo).port;
  const proxyPort = await freePort();
  let cfg: Config = {
    ...DEFAULTS,
    listen: { host: "127.0.0.1", port: proxyPort },
    ...cfgFor(`http://127.0.0.1:${backendPort}`),
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
    claudeCodeCredentialReaders: { keychain: () => null, credentialsFile: () => null },
  });
  await proxy.listen();

  const search: SearchRig["search"] = async (model) => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n");
    await new Promise<void>((resolve, reject) => {
      socket.once("data", () => resolve());
      socket.once("error", reject);
    });
    const secure = tls.connect({ socket, servername: "api.anthropic.com", ca: ca.certPem });
    await new Promise<void>((resolve, reject) => {
      secure.once("secureConnect", resolve);
      secure.once("error", reject);
    });
    const body = JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: "user", content: "Perform a web search for the query: latest Node.js 24 release" }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8, allowed_domains: ["nodejs.org"] }],
      tool_choice: { type: "auto" },
    });
    const response = await new Promise<Buffer>((resolve, reject) => {
      let received = Buffer.alloc(0);
      let settle: NodeJS.Timeout | undefined;
      secure.on("data", (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        if (settle) clearTimeout(settle);
        settle = setTimeout(() => resolve(received), 50);
      });
      secure.once("error", reject);
      secure.write(
        "POST /v1/messages HTTP/1.1\r\n" +
        "Host: api.anthropic.com\r\n" +
        "content-type: application/json\r\n" +
        `content-length: ${Buffer.byteLength(body)}\r\n\r\n` +
        body,
      );
    });
    secure.destroy();
    const decoded = decodeHttpResponse(response);
    return {
      status: decoded.status,
      message: JSON.parse(decoded.body) as SearchReply["message"],
      seenTool,
      target: requests.list(10).find((entry) => entry.kind === "messages")?.target,
      record: requests.list(10).find((entry) => entry.kind === "messages"),
    };
  };
  return {
    seen, search,
    replaceProviders: (providers) => { cfg = { ...cfg, providers }; },
    stop: async () => {
      proxy.close();
      backend.closeAllConnections();
      await new Promise<void>((resolve) => backend.close(() => resolve()));
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

/** One `WebSearch` side request for `model`, through a real proxy whose ChatGPT backend is local. */
async function searchThrough(model: string, cfgFor: (backendUrl: string) => Partial<Config>): Promise<SearchReply> {
  const rig = await searchRig(cfgFor);
  try {
    const reply = await rig.search(model);
    assert.equal(reply.status, 200);
    return reply;
  } finally { await rig.stop(); }
}

function assertSearched(reply: SearchReply, target: string): void {
  const result = reply.message.content.find((block) => block.type === "web_search_tool_result");
  assert.deepEqual(result?.content, [{ type: "web_search_result", title: "Node.js", url: "https://nodejs.org/en/download" }]);
  assert.equal(reply.message.usage.server_tool_use.web_search_requests, 1);
  assert.deepEqual(reply.seenTool, {
    type: "web_search",
    search_context_size: "low",
    external_web_access: true,
    filters: { allowed_domains: ["nodejs.org"] },
  });
  assert.equal(reply.target, target);
  assert.equal(reply.record?.purpose, "web-search");
  assert.equal(reply.record?.provider, "chatgpt");
  assert.equal(reply.record?.upstreamCalled, undefined);
  assert.equal(reply.record?.refusal, undefined);
}

test("the proxy serves a configured ChatGPT hosted search before model routing", async () => {
  const reply = await searchThrough("claude-haiku-4-5", (url) => ({
    providers: { chatgpt: { type: "chatgpt", auth: "own", url } },
    webSearch: { provider: "chatgpt", model: "gpt-5.6-terra", maxResults: 3 },
  }));
  assertSearched(reply, "chatgpt/gpt-5.6-terra");
});

// A `smallFast` slot pointed at a ChatGPT model sends every search there. With no `webSearch` set,
// the router refused them all as a provider without server tools (2026-10-07).
test("a search routed to a ChatGPT provider is served by its own search without webSearch", async () => {
  const reply = await searchThrough("gpt-6-luna@low", (url) => ({
    providers: { chatgpt: { type: "chatgpt", auth: "own", url, models: [{ id: "gpt-6-luna" }] } },
  }));
  assertSearched(reply, "chatgpt/gpt-6-luna");
});

// OpenCode Go serves its DeepSeek models on Chat Completions, which has no search, and its Anthropic
// endpoint returns no `web_search_tool_result` hits either (2026-10-21; a 2026-10-07 claim that it
// searched was wrong). The preset's `anthropicSearch` list is empty, so a search routed there must be
// refused — never sent to a backend that answers with nothing.
test("a search routed to OpenCode Go's DeepSeek is refused, since the plan does not search", async (t) => {
  const real = globalThis.fetch;
  let contacted = false;
  t.after(() => { globalThis.fetch = real; });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).startsWith("https://opencode.ai/")) contacted = true;
    return real(input, init);
  }) as typeof fetch;
  const reply = await searchThrough("deepseek-v4.1-flash@high", () => ({
    providers: {
      "opencode-go": {
        type: "openai-compatible",
        url: "https://opencode.ai/zen/go/v1",
        preset: "opencode-go",
        wire: "responses",
        sessionHeader: "x-opencode-session",
        headers: { authorization: "Bearer go-key" },
        models: [{ id: "deepseek-v4.1-flash", wire: "chat" }],
      },
    },
  }));
  const result = reply.message.content.find((block) => block.type === "web_search_tool_result");
  assert.deepEqual(result?.content, { type: "web_search_tool_result_error", error_code: "unavailable" });
  assert.equal(reply.message.usage.server_tool_use.web_search_requests, 0);
  assert.equal(contacted, false, "nothing was sent to the relay");
  assert.equal(reply.record?.refusal, "web-search-unsupported");
});

test("operator pause: failed hosted search re-reads credentials before ordinary fallback", async () => {
  let providers: Config["providers"] = {};
  const rig = await searchRig((url) => {
    providers = {
      search: { type: "openai-compatible", url, headers: { authorization: "Bearer hosted-search-test-key" } },
      answer: {
        type: "anthropic-compatible", url, caps: { serverTools: true },
        headers: { "x-api-key": "fallback-test-key" },
        credentials: [{ id: "default", headers: { "x-api-key": "fallback-test-key" } }],
      },
    };
    return { providers, routes: { "claude-haiku-4-5": { provider: "answer", model: "search-model" } }, webSearch: { provider: "search", model: "search-model" } };
  }, (res) => {
    if (res.req.headers.authorization === "Bearer hosted-search-test-key") {
      const answer = providers.answer!;
      assert.equal(answer.type, "anthropic-compatible");
      if (answer.type === "anthropic-compatible") {
        rig.replaceProviders({ ...providers, answer: { ...answer, credentials: answer.credentials!.map((credential) => ({ ...credential, paused: true })) } });
      }
      res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "local hosted search unavailable" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_unexpected", type: "message", role: "assistant", content: [], usage: {} }));
  });
  try {
    const reply = await rig.search("claude-haiku-4-5");
    assert.equal(reply.status, 503);
    assert.equal(rig.seen.length, 1, "the newly paused fallback key must not reach an origin");
    assert.equal(reply.record?.refusal, "no-account");
    assert.notEqual(reply.record?.upstreamCalled, false, "the failed hosted search already contacted an origin");
  } finally { await rig.stop(); }
});

test("failed hosted search checks the replacement provider's actual server-tool capability", async () => {
  let providers: Config["providers"] = {};
  let destination = "";
  const rig = await searchRig((url) => {
    destination = url;
    providers = {
      search: { type: "openai-compatible", url, headers: { authorization: "Bearer capability-search-key" } },
      answer: { type: "anthropic-compatible", url, headers: { "x-api-key": "old-capability-key" }, caps: { serverTools: true } },
    };
    return { providers, routes: { "claude-haiku-4-5": { provider: "answer", model: "search-model" } }, webSearch: { provider: "search", model: "search-model" } };
  }, (res) => {
    if (res.req.headers.authorization === "Bearer capability-search-key") {
      rig.replaceProviders({ ...providers, answer: { type: "openai-compatible", url: destination, headers: { authorization: "Bearer replacement-key" } } });
      res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "hosted search unavailable" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" }).end('data: {"choices":[{"delta":{"content":"INVENTED_SEARCH"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  try {
    const reply = await rig.search("claude-haiku-4-5");
    assert.equal(reply.status, 200);
    assert.equal(rig.seen.length, 1, "the replacement that cannot search must not receive an ordinary inference");
    assert.equal(reply.record?.refusal, "web-search-unsupported");
    assert.equal(reply.record?.purpose, "web-search");
    assert.doesNotMatch(JSON.stringify(reply.message), /INVENTED_SEARCH/);
    assert.ok(reply.message.content.some((block) => block.type === "web_search_tool_result"));
    assert.notEqual(reply.record?.upstreamCalled, false, "the failed hosted search did contact its origin");
  } finally { await rig.stop(); }
});

for (const type of ["openai-compatible", "anthropic-compatible"] as const) {
  test(`operator pause: configured ${type} WebSearch uses only eligible credentials`, async (t) => {
    const header = type === "openai-compatible" ? "authorization" : "x-api-key";
    const key = (name: string): string => type === "openai-compatible" ? `Bearer search-${name}` : `search-${name}`;
    const credentials = [
      { id: "default", headers: { [header]: key("a") }, paused: true, preferred: false },
      { id: "second", headers: { [header]: key("b") }, paused: false, preferred: true },
    ];
    const hit = { type: "web_search_result", title: "Node.js", url: "https://nodejs.org/en/download" };
    const r = await searchRig((url) => {
      const common = { url, headers: credentials[0]!.headers, credentials, models: [{ id: "search-model" }] };
      const provider: Provider = type === "anthropic-compatible"
        ? { type, ...common, caps: { serverTools: true } }
        : { type, ...common };
      return {
        providers: { p: provider },
        routes: { "claude-haiku-4-5": { provider: "p", model: "search-model" } },
        webSearch: { provider: "p", model: "search-model" },
      };
    }, (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(type === "openai-compatible"
        ? { choices: [{ message: { content: "Found Node.js.", annotations: [{ type: "url_citation", url_citation: { title: hit.title, url: hit.url } }] } }] }
        : { content: [{ type: "web_search_tool_result", content: [hit] }] }));
    });
    try {
      await t.test("a paused mirror key cannot displace the available preferred key", async () => {
        const reply = await r.search("claude-haiku-4-5");
        assert.equal(reply.status, 200);
        assert.deepEqual(reply.message.content.find((block) => block.type === "web_search_tool_result")?.content, [hit]);
        assert.deepEqual(r.seen.map((headers) => headers[header]), [key("b")]);
      });
      await t.test("all paused returns explicit unavailability without an origin request", async () => {
        credentials[1]!.paused = true;
        const before = r.seen.length;
        const reply = await r.search("claude-haiku-4-5");
        assert.equal(r.seen.length, before, "no paused key may reach the search backend");
        assert.equal(reply.status, 503);
        assert.equal(reply.message.error?.type, "overloaded_error");
        assert.match(reply.message.error?.message ?? "", /paused|일시 중지/iu);
        assert.equal(reply.record?.refusal, "no-account");
        assert.equal(reply.record?.upstreamCalled, false);
      });
      await t.test("resuming the first key restores its eligibility without restarting", async () => {
        credentials[0]!.paused = false;
        credentials[0]!.preferred = true;
        credentials[1]!.preferred = false;
        const before = r.seen.length;
        const reply = await r.search("claude-haiku-4-5");
        assert.equal(reply.status, 200);
        assert.deepEqual(r.seen.slice(before).map((headers) => headers[header]), [key("a")]);
      });
    } finally { await r.stop(); }
  });
}
