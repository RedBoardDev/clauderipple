import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { GoogleAdapter } from "../src/providers/google/index.ts";
import { saveGoogleAccount } from "../src/providers/google/accounts.ts";
import { Logger } from "../src/log.ts";
import { RequestLog } from "../src/requestlog.ts";
import type { AnthropicRequest } from "../src/providers/chatgpt/translate.ts";

// Synthetic credentials; no external services are contacted.
for (const auth of ["antigravity", "api-key"] as const) {
  for (const stream of [false, true]) {
    test(`${auth} HTTP-200 ${stream ? "SSE" : "JSON"} errors mask credentials in client, note and logs`, async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-google-redaction-"));
      const secret = `synthetic-${auth}-token`;
      let upstreamCalls = 0;
      const upstream = http.createServer((req, res) => {
        req.resume();
        upstreamCalls++;
        assert.equal(auth === "antigravity" ? req.headers.authorization : req.headers["x-goog-api-key"], auth === "antigravity" ? `Bearer ${secret}` : secret);
        const payload = { error: { status: "RESOURCE_EXHAUSTED", message: `Rejected credential ${secret}` } };
        res.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" });
        res.end(stream ? `data: ${JSON.stringify(payload)}\n\n` : JSON.stringify(payload));
      });
      upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
      const address = upstream.address();
      if (!address || typeof address === "string") throw new Error("missing upstream port");
      if (auth === "antigravity") saveGoogleAccount(home, { accessToken: secret, projectId: "test", email: "test@example.test", expiresAt: Date.now() + 3_600_000 });
      const adapter = new GoogleAdapter("test", { type: "google", auth, apiKey: secret, url: `http://127.0.0.1:${address.port}` }, home, new Logger(path.join(home, "router.log"), 1e6, 1, false));
      const requests = new RequestLog(path.join(home, "requests.jsonl"));
      let note = "";
      const front = http.createServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const outcome = await adapter.handle(req, res, req.url ?? "/v1/messages", JSON.parse(raw) as AnthropicRequest, "gemini-3.8-flash", "high");
        note = outcome.note ?? "";
        requests.add({ id: "test", at: new Date().toISOString(), ms: 0, kind: "messages", source: "test", target: "test", provider: "test", stream, ok: false, status: outcome.status, note });
      });
      front.listen(0, "127.0.0.1"); await once(front, "listening");
      const frontAddress = front.address();
      if (!frontAddress || typeof frontAddress === "string") throw new Error("missing front port");
      const call = async (endpoint: string) => {
        const response = await fetch(`http://127.0.0.1:${frontAddress.port}${endpoint}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gemini-3.8-flash", max_tokens: 64, stream, messages: [{ role: "user", content: "Hello" }] }), signal: AbortSignal.timeout(5000) });
        return { status: response.status, text: await response.text() };
      };
      try {
        assert.equal((await call("/v1/messages/count_tokens")).status, 200);
        assert.equal(upstreamCalls, 0);
        const result = await call("/v1/messages");
        assert.equal(result.status, stream ? 200 : 429);
        assert.match(result.text, /rate_limit_error/);
        assert.ok(!result.text.includes(secret), "client credential leak");
        assert.ok(!note.includes(secret), "outcome note credential leak");
        for (const file of ["requests.jsonl", "router.log"]) {
          if (fs.existsSync(path.join(home, file))) assert.ok(!fs.readFileSync(path.join(home, file), "utf8").includes(secret), `${file} credential leak`);
        }
      } finally {
        for (const server of [front, upstream]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  }
}
