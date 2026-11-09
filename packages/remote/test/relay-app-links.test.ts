// The relay's app-link files: iOS Universal Links (apple-app-site-association) and Android App
// Links (assetlinks.json). The app claims https://<relay>/#pair=…, so both must come from the
// worker itself — HTTPS, application/json, 200, no redirect — and must leave the sockets alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../relay/worker.ts";

const RELAY = "https://ripple-relay.clauderipple.workers.dev";

function env(android?: string) {
  const seen: string[] = [];
  const e = {
    ROOM: {
      idFromName: (name: string) => name,
      get: (id: unknown) => ({ fetch: async () => new Response(`room ${String(id)}`) }),
    },
    ASSETS: {
      fetch: async (req: Request): Promise<Response> => {
        seen.push(new URL(req.url).pathname);
        return new Response("asset", { status: 200, headers: { "content-type": "text/html" } });
      },
    },
    ...(android !== undefined ? { ANDROID_CERT_SHA256: android } : {}),
  };
  return { env: e, assets: seen };
}

async function get(path: string, init: RequestInit = {}, android?: string) {
  const { env: e, assets } = env(android);
  const res = await worker.fetch(new Request(`${RELAY}${path}`, init), e);
  return { res, assets };
}

test("apple-app-site-association: the pairing URL's root path, as application/json, 200, no redirect", async () => {
  const { res, assets } = await get("/.well-known/apple-app-site-association");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.equal(res.headers.get("location"), null);
  assert.deepEqual(JSON.parse(await res.text()), {
    applinks: {
      details: [{
        appIDs: ["QL9967JLCR.com.clauderipple.remote"],
        components: [{ "/": "/" }],
      }],
    },
  });
  assert.deepEqual(assets, [], "served by the worker, not the static assets");
  // A query string does not matter (the QR's parameters live in the fragment, which never arrives).
  const again = await get("/.well-known/apple-app-site-association?pair=1");
  assert.equal(again.res.status, 200);
});

test("assetlinks.json: the signing certificate comes from the variable, comma-separated and trimmed", async () => {
  const { res, assets } = await get(
    "/.well-known/assetlinks.json",
    {},
    " AA:BB:CC , DD:EE:FF ,",
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.equal(res.headers.get("location"), null);
  assert.deepEqual(JSON.parse(await res.text()), [{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: "com.clauderipple.remote",
      sha256_cert_fingerprints: ["AA:BB:CC", "DD:EE:FF"],
    },
  }]);
  assert.deepEqual(assets, []);
});

test("assetlinks.json: without a fingerprint it is a plain 404, never an empty or invalid file", async () => {
  for (const value of [undefined, "", " ", ","]) {
    const { res } = await get("/.well-known/assetlinks.json", {}, value);
    assert.equal(res.status, 404, `value ${JSON.stringify(value)}`);
    assert.notEqual(res.headers.get("content-type"), "application/json", "no half-valid file");
  }
});

test("app links: HEAD answers 200 with the type and no body; other methods are refused", async () => {
  const head = await get("/.well-known/apple-app-site-association", { method: "HEAD" });
  assert.equal(head.res.status, 200);
  assert.equal(head.res.headers.get("content-type"), "application/json");
  assert.equal(await head.res.text(), "");
  const post = await get("/.well-known/assetlinks.json", { method: "POST" }, "AA:BB");
  assert.equal(post.res.status, 405);
  assert.equal(post.res.headers.get("allow"), "GET, HEAD");
});

test("the sockets and the asset fallback are untouched", async () => {
  // A plain fetch on a socket path is still a websocket-only 426, before any room work.
  const client = await get("/ws/client?server=server-id-0123456789");
  assert.equal(client.res.status, 426);
  const bad = await get("/ws/host?server=short", { headers: { upgrade: "websocket" } });
  assert.equal(bad.res.status, 400);
  // Anything else still goes to the PWA's static assets.
  const page = await get("/");
  assert.equal(await page.res.text(), "asset");
  assert.deepEqual(page.assets, ["/"]);
  const lookalike = await get("/.well-known/something-else");
  assert.equal(await lookalike.res.text(), "asset");
});
