// ripple://app/ — the dashboard drawn from this app's own copy of packages/ui, with /api/* passed
// on to the router's admin port. The router used to serve the page too, so when it died the
// dashboard died with it, exactly when it was needed (2026-10-20). Now only the data needs the
// router; a router that does not answer gives a 503 the dashboard reads as "Ripple is down".

import { protocol } from "electron";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";

import { routeRequest } from "./status-model";

export const SCHEME = "ripple";
export const ORIGIN = `${SCHEME}://app`;

/** Before app ready: a standard, secure scheme gets an origin, localStorage, fetch and the page's CSP 'self'. */
export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

/** Bound connection setup separately from waiting for approval, a login or a provider probe. */
const CONNECT_TIMEOUT_MS = 4_000;
const IDLE_TIMEOUT_MS = 180_000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export function routerDownResponse(): Response {
  return json(503, { error: "ClaudeRipple is not running", routerDown: true });
}

/**
 * The admin API, asked as the CLI and the tray ask it: no Origin header (the router turns away a
 * cross-site Origin on writes, and a custom scheme's would be one) and a Host it accepts.
 */
async function forward(request: Request, admin: URL): Promise<Response> {
  const url = new URL(request.url);
  const body = request.method === "GET" || request.method === "HEAD" ? null : Buffer.from(await request.arrayBuffer());
  const headers: Record<string, string> = { host: `127.0.0.1:${admin.port}`, accept: request.headers.get("accept") ?? "*/*" };
  const type = request.headers.get("content-type");
  if (type) headers["content-type"] = type;
  if (body) headers["content-length"] = String(body.length);
  return new Promise((resolve) => {
    let settled = false;
    const done = (response: Response) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    const req = http.request(
      // A connection of its own per request: the idle timer below is set on the socket, and on a
      // pooled socket those timers piled up (MaxListenersExceededWarning, measured here).
      { host: admin.hostname, port: admin.port, method: request.method, path: `${url.pathname}${url.search}`, headers, agent: false },
      (res) => {
        const out = new Headers();
        for (const name of ["content-type", "cache-control", "content-disposition"]) {
          const value = res.headers[name];
          if (typeof value === "string") out.set(name, value);
        }
        const status = res.statusCode ?? 502;
        const nullBody = status === 204 || status === 304 || request.method === "HEAD";
        if (nullBody) res.resume();
        done(new Response(nullBody ? null : (Readable.toWeb(res) as unknown as ReadableStream), { status, headers: out }));
      },
    );
    const connectTimer = setTimeout(() => {
      req.destroy();
      done(routerDownResponse());
    }, CONNECT_TIMEOUT_MS);
    req.once("socket", (socket) => {
      if (socket.connecting) socket.once("connect", () => clearTimeout(connectTimer));
      else clearTimeout(connectTimer);
    });
    // ClientRequest starts the socket idle timeout after connecting, including the wait for
    // response headers. Certificate approval can legitimately take more than four seconds.
    req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy());
    req.once("close", () => clearTimeout(connectTimer));
    req.on("error", () => {
      clearTimeout(connectTimer);
      done(routerDownResponse());
    });
    if (body) req.write(body);
    req.end();
  });
}

async function serveFile(root: string, rel: string): Promise<Response> {
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return json(400, { error: "invalid path" });
  try {
    const data = await fs.promises.readFile(full);
    return new Response(data, { status: 200, headers: { "content-type": MIME[path.extname(full).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-cache" } });
  } catch {
    return json(404, { error: "not found" });
  }
}

/** After app ready. `admin` is read per request, so a port changed in config.json is followed. */
export function handleScheme(uiRoot: string, admin: () => string): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== "app") return json(404, { error: "not found" });
    const route = routeRequest(url.pathname);
    if (!route) return json(400, { error: "invalid path" });
    if (route.kind === "api") return forward(request, new URL(admin()));
    return serveFile(uiRoot, route.rel);
  });
}
