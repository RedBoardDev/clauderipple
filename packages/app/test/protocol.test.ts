import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import { Readable } from "node:stream";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { routeRequest } from "../src/status-model.ts";

// Run the whole protocol module, but never load Electron or touch an installed router.
const source = fs.readFileSync(new URL("../src/protocol.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
type Handler = (request: Request) => Promise<Response>;
function harness(admin: string, transport: object = http, timers: object = { setTimeout, clearTimeout }): Handler {
  let handler: Handler | undefined;
  const exports: { handleScheme?: (root: string, admin: () => string) => void } = {};
  const modules: Record<string, object> = {
    electron: { protocol: { handle: (_scheme: string, callback: Handler) => { handler = callback; } } },
    "node:fs": { promises: { readFile: () => { throw new Error("Unexpected file access"); } } },
    "node:http": transport, "node:path": path, "node:stream": { Readable }, "./status-model": { routeRequest },
  };
  runInNewContext(compiled, {
    exports, require: (id: string) => { assert.ok(id in modules, id); return modules[id]; },
    URL, Request, Response, Headers, Buffer, ...timers,
  });
  assert.ok(exports.handleScheme);
  exports.handleScheme("/tmp/unused-ripple-ui", () => admin);
  assert.ok(handler);
  return handler;
}

class PendingRequest extends EventEmitter {
  destroyed = false;
  idleMs = 0;
  socket = Object.assign(new EventEmitter(), { connecting: true });
  end() { queueMicrotask(() => this.emit("socket", this.socket)); }
  write() {}
  setTimeout(ms: number, callback: () => void) { this.idleMs = ms; this.on("timeout", callback); return this; }
  destroy() { this.destroyed = true; this.emit("error", new Error("connection closed")); this.emit("close"); return this; }
}
function pendingHarness() {
  const req = new PendingRequest();
  const timers = new Map<number, () => void>();
  const handle = harness("http://127.0.0.1:1/", { request: () => req }, {
    setTimeout: (callback: () => void, ms: number) => { timers.set(ms, callback); return ms; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  return { req, timers, handle };
}

test("a connection that never completes still returns routerDown after four seconds", async () => {
  const { req, timers, handle } = pendingHarness();
  const response = handle(new Request("ripple://app/api/status"));
  await Promise.resolve();
  assert.ok(timers.has(4000));
  timers.get(4000)!();
  assert.equal(req.destroyed, true);
  assert.equal((await response).status, 503);
  assert.equal((await (await response).json()).routerDown, true);
  assert.equal(timers.size, 0);
});

test("connection completion ends the four-second deadline and leaves a 180-second response idle timeout", async () => {
  const { req, timers, handle } = pendingHarness();
  const response = handle(new Request("ripple://app/api/status"));
  await Promise.resolve();
  req.socket.connecting = false;
  req.socket.emit("connect");
  try {
    assert.equal(timers.has(4000), false);
    assert.equal(req.idleMs, 180_000);
    assert.equal(req.destroyed, false);
    req.emit("timeout");
    assert.equal(req.destroyed, true);
    assert.equal((await response).status, 503);
  } finally { req.destroy(); }
});

test("connection errors clear the deadline and return routerDown", async () => {
  const { req, timers, handle } = pendingHarness();
  const response = handle(new Request("ripple://app/api/status"));
  req.destroy();
  assert.equal((await response).status, 503);
  assert.equal(timers.size, 0);
});

test("loopback API approval taking longer than four seconds preserves its response and request", { timeout: 10_000 }, async t => {
  let received: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string } | undefined;
  let delay: ReturnType<typeof setTimeout> | undefined;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
    delay = setTimeout(() => {
      res.writeHead(201, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ approved: true }));
    }, 4200);
  });
  t.after(async () => { clearTimeout(delay); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const handle = harness(`http://127.0.0.1:${address.port}/`);
  const response = await handle(new Request("ripple://app/api/picker?enabled=1", {
    method: "POST", headers: { "content-type": "application/json", origin: "ripple://app" }, body: '{"on":true}',
  }));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { approved: true });
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(received?.method, "POST");
  assert.equal(received?.url, "/api/picker?enabled=1");
  assert.equal(received?.body, '{"on":true}');
  assert.equal(received?.headers.origin, undefined);
  assert.equal(received?.headers.host, `127.0.0.1:${address.port}`);
});

for (const headersSent of [false, true]) {
  test(`loopback idle timeout closes a stalled ${headersSent ? "response body" : "wait for headers"}`, { timeout: 3000 }, async t => {
    const server = http.createServer((_req, res) => {
      if (headersSent) { res.writeHead(200, { "content-type": "text/plain" }); res.flushHeaders(); }
    });
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    let idleMs = 0;
    const handle = harness(`http://127.0.0.1:${address.port}/`, {
      request: (options: http.RequestOptions, callback: (res: http.IncomingMessage) => void) => {
        const req = http.request(options, callback);
        const setIdle = req.setTimeout.bind(req);
        // Accelerate only the HTTP boundary's idle clock; connection setup and I/O stay real.
        req.setTimeout = (ms, callback) => { idleMs = ms; return setIdle(50, callback); };
        return req;
      },
    });
    const response = await handle(new Request("ripple://app/api/stalled"));
    assert.equal(idleMs, 180_000);
    if (headersSent) {
      assert.equal(response.status, 200);
      await assert.rejects(response.text(), /aborted|closed|reset/i);
    } else {
      assert.equal(response.status, 503);
      assert.equal((await response.json()).routerDown, true);
    }
  });
}

test("loopback HTTP errors and bodyless responses keep their original status", async t => {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/empty") { res.writeHead(204); res.end(); return; }
    res.writeHead(409, { "content-type": "application/json" });
    res.end('{"error":"conflict"}');
  });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const handle = harness(`http://127.0.0.1:${address.port}/`);
  const conflict = await handle(new Request("ripple://app/api/conflict"));
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: "conflict" });
  const empty = await handle(new Request("ripple://app/api/empty"));
  assert.equal(empty.status, 204);
  assert.equal(empty.body, null);
});
