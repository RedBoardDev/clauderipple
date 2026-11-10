import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startAdmin } from "../src/admin.ts";
import { DEFAULTS } from "../src/config.ts";
import { Logger } from "../src/log.ts";
import { RequestLog } from "../src/requestlog.ts";
import { phoneRequest } from "../src/phone.ts";
import type { PhoneDeps } from "../src/phone.ts";

async function admin(t: import("node:test").TestContext, phone: PhoneDeps) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-phone-admin-"));
  fs.writeFileSync(path.join(home, "host.json"), JSON.stringify({ port: 18797 }));
  fs.writeFileSync(path.join(home, "local.secret"), "s".repeat(43), { mode: 0o600 });
  const server = await startAdmin({
    config: () => ({ ...DEFAULTS, admin: { port: 0 } }), configFile: path.join(home, "config.json"),
    log: new Logger(null, 1_000_000, 1, false), version: "test", health: () => 0,
    stats: () => ({ inFlight: 0, messagesInFlight: 0, started: 0, completed: 0, failed: 0 }),
    requests: new RequestLog(path.join(home, "requests.jsonl")), phone: { home, ...phone },
  });
  t.after(() => { server.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${server.port}`, home };
}

test("admin proxies only allowed phone routes to the configured loopback port with the secret", async t => {
  const calls: { url: string; method: string; body: string | undefined }[] = [];
  const f = await admin(t, { fetch: async (url, init) => {
    assert.equal(new Headers(init?.headers).get("x-ripple-local"), "s".repeat(43));
    assert.equal(init?.redirect, "error");
    calls.push({ url: String(url), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    return Response.json(String(url).endsWith("status") ? { mode: "relay", phones: [] } : String(url).endsWith("pairing") ? { url: "https://relay.example/#pair=secret", svg: "<svg/>" } : { ok: true });
  } });
  const status = await fetch(`${f.base}/api/phone/status`);
  assert.equal(status.status, 200);
  assert.equal(status.headers.get("cache-control"), "no-store");
  assert.deepEqual(await status.json(), { hostRunning: true, mode: "relay", phones: [] });
  const pair = await fetch(`${f.base}/api/phone/pairing`);
  assert.equal(pair.headers.get("cache-control"), "no-store");
  assert.deepEqual(await pair.json(), { url: "https://relay.example/#pair=secret", svg: "<svg/>" });
  for (const route of ["settings", "rotate"]) assert.equal((await fetch(`${f.base}/api/phone/${route}`, { method: "POST", body: JSON.stringify({ bind: "local" }) })).status, 200);
  assert.deepEqual(calls.map(c => [c.url, c.method]), [["http://127.0.0.1:18797/local/status", "GET"], ["http://127.0.0.1:18797/local/pairing", "GET"], ["http://127.0.0.1:18797/local/settings", "POST"], ["http://127.0.0.1:18797/local/rotate", "POST"]]);
  assert.equal(calls[2]?.body, '{"bind":"local"}');
  for (const route of ["../config", "other", "settings/extra"]) await fetch(`${f.base}/api/phone/${route}`);
  assert.equal(calls.length, 4);
  assert.equal((await fetch(`${f.base}/api/phone/pairing`, { headers: { origin: "https://evil.example" } })).status, 403);
  const rebound = await new Promise<number | undefined>((resolve, reject) => {
    const request = http.get(`${f.base}/api/phone/pairing`, { headers: { host: "evil.example" } }, response => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
  });
  assert.equal(rebound, 403);
  assert.equal((await fetch(`${f.base}/api/phone/rotate`, { method: "POST", headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal(calls.length, 4);
});

test("inbox routes validate, forward only their own requests and preserve host responses", async t => {
  const calls: { url: string; method: string; body?: string }[] = [];
  const f = await admin(t, { fetch: async (url, init) => {
    assert.equal(new Headers(init?.headers).get("x-ripple-local"), "s".repeat(43));
    calls.push({ url: String(url), method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    return String(url).endsWith("/claim") ? Response.json({ error: "offer unavailable" }, { status: 409 })
      : Response.json(String(url).includes("/inbox?") ? { offers: [{ sessionId: "a &b", itemId: "one", text: "private", offeredAt: 1 }] } : { ok: true });
  } });
  const list = await fetch(`${f.base}/api/phone-inbox?session=a%20%26b`);
  assert.equal(list.headers.get("cache-control"), "no-store");
  assert.deepEqual(await list.json(), { offers: [{ sessionId: "a &b", itemId: "one", text: "private", offeredAt: 1 }] });
  const claim = await fetch(`${f.base}/api/phone-inbox/claim`, { method: "POST", body: '{"itemId":"one"}' });
  assert.equal(claim.status, 409);
  assert.deepEqual(await claim.json(), { error: "offer unavailable" });
  const result = await fetch(`${f.base}/api/phone-inbox/result`, { method: "POST", body: '{"itemId":"one","outcome":"submitted"}' });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { ok: true });
  assert.deepEqual(calls, [
    { url: "http://127.0.0.1:18797/local/inbox?session=a%20%26b", method: "GET" },
    { url: "http://127.0.0.1:18797/local/inbox/claim", method: "POST", body: '{"itemId":"one"}' },
    { url: "http://127.0.0.1:18797/local/inbox/result", method: "POST", body: '{"itemId":"one","outcome":"submitted"}' },
  ]);
  for (const query of ["", "?session=", "?session=a&session=b", `?session=${"x".repeat(201)}`]) assert.equal((await fetch(`${f.base}/api/phone-inbox${query}`)).status, 400);
  for (const [route, body] of [["claim", "{}"], ["claim", '{"itemId":"a/b"}'], ["claim", '{"itemId":"a","extra":1}'], ["result", '{"itemId":"a"}'], ["result", '{"itemId":"a","outcome":"other"}'], ["claim", "x".repeat(4097)]] as const) {
    assert.equal((await fetch(`${f.base}/api/phone-inbox/${route}`, { method: "POST", body })).status, 400);
  }
  assert.equal((await fetch(`${f.base}/api/phone-inbox/claim`)).status, 404);
  assert.equal((await fetch(`${f.base}/api/phone-inbox?session=a`, { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal(calls.length, 3);
});

test("every inbox route reports an unreachable host", async t => {
  const f = await admin(t, { fetch: async () => { throw new Error("private"); } });
  for (const [route, init] of [["?session=a", {}], ["/claim", { method: "POST", body: '{"itemId":"a"}' }], ["/result", { method: "POST", body: '{"itemId":"a","outcome":"failed"}' }]] as const) {
    const response = await fetch(`${f.base}/api/phone-inbox${route}`, init);
    assert.equal(response.status, 503);
    assert.equal((await response.text()).includes("private"), false);
  }
});

test("settings job routes validate and forward through the authenticated host boundary", async t => {
  const calls: { url: string; method: string; body?: string }[] = [];
  const f = await admin(t, { fetch: async (url, init) => {
    assert.equal(new Headers(init?.headers).get("x-ripple-local"), "s".repeat(43));
    calls.push({ url: String(url), method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    return String(url).endsWith("/claim") ? Response.json({ error: "job unavailable" }, { status: 409 }) : Response.json(String(url).includes("?exclude=") ? { jobs: [] } : { ok: true });
  } });
  const list = await fetch(`${f.base}/api/settings-jobs?exclude=local_helper`);
  assert.equal(list.headers.get("cache-control"), "no-store"); assert.deepEqual(await list.json(), { jobs: [] });
  assert.equal((await fetch(`${f.base}/api/settings-jobs/claim`, { method: "POST", body: '{"jobId":"job-1","helper":"local_helper"}' })).status, 409);
  assert.equal((await fetch(`${f.base}/api/settings-jobs/result`, { method: "POST", body: '{"jobId":"job-1","outcome":"failed","detail":"refused"}' })).status, 200);
  assert.deepEqual(calls, [
    { url: "http://127.0.0.1:18797/local/settings-jobs?exclude=local_helper", method: "GET" },
    { url: "http://127.0.0.1:18797/local/settings-jobs/claim", method: "POST", body: '{"jobId":"job-1","helper":"local_helper"}' },
    { url: "http://127.0.0.1:18797/local/settings-jobs/result", method: "POST", body: '{"jobId":"job-1","outcome":"failed","detail":"refused"}' },
  ]);
  for (const query of ["", "?exclude=a%20b", "?exclude=a&exclude=b", `?exclude=${"x".repeat(101)}`]) assert.equal((await fetch(`${f.base}/api/settings-jobs${query}`)).status, 400);
  for (const [route, body] of [["claim", "{}"], ["claim", '{"jobId":"a","helper":"bad/id"}'], ["claim", '{"jobId":"a","helper":"b","extra":1}'], ["result", '{"jobId":"a","outcome":"other"}'], ["result", JSON.stringify({ jobId: "a", outcome: "failed", detail: "x".repeat(1001) })], ["claim", "x".repeat(4097)]] as const) assert.equal((await fetch(`${f.base}/api/settings-jobs/${route}`, { method: "POST", body })).status, 400);
  assert.equal((await fetch(`${f.base}/api/settings-jobs?exclude=a`, { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await fetch(`${f.base}/api/settings-jobs/claim`)).status, 404);
  assert.equal(calls.length, 3);
});

test("all settings job routes report a stopped host", async t => {
  const f = await admin(t, { fetch: async () => { throw new Error("private"); } });
  for (const [route, init] of [["?exclude=a", {}], ["/claim", { method: "POST", body: '{"jobId":"a","helper":"b"}' }], ["/result", { method: "POST", body: '{"jobId":"a","outcome":"failed"}' }]] as const) {
    const response = await fetch(`${f.base}/api/settings-jobs${route}`, init);
    assert.equal(response.status, 503); assert.equal((await response.text()).includes("private"), false);
  }
});

test("host-down status gives the install hint; mutations fail without exposing errors or secrets", async t => {
  const f = await admin(t, { fetch: async () => { throw new Error("secret-sensitive transport details"); } });
  assert.deepEqual(await (await fetch(`${f.base}/api/phone/status`)).json(), { hostRunning: false, hint: "clauderipple remote install" });
  assert.equal((await fetch(`${f.base}/api/phone/pairing`)).status, 503);
  assert.equal((await fetch(`${f.base}/api/phone/rotate`, { method: "POST" })).status, 503);
  fs.unlinkSync(path.join(f.home, "local.secret"));
  assert.deepEqual(await (await fetch(`${f.base}/api/phone/status`)).json(), { hostRunning: false, hint: "clauderipple remote install" });
});

test("proxy preserves settings refusals, reports live incompatible hosts, and defaults to port 8797", async t => {
  let status = 400;
  const f = await admin(t, { fetch: async url => {
    assert.equal(new URL(String(url)).port, "8797");
    return Response.json({ error: "never reflect arbitrary upstream credential detail" }, { status });
  } });
  fs.unlinkSync(path.join(f.home, "host.json"));
  assert.equal((await fetch(`${f.base}/api/phone/settings`, { method: "POST", body: "{}" })).status, 400);
  status = 403;
  const denied = await fetch(`${f.base}/api/phone/status`);
  assert.equal(denied.status, 502);
  assert.equal((await denied.text()).includes("credential detail"), false);
  status = 200;
  // The byte limit is enforced before forwarding.
  assert.equal((await fetch(`${f.base}/api/phone/settings`, { method: "POST", body: "x".repeat(4097) })).status, 413);
});

test("phone vocabulary is complete in all six dashboard languages", () => {
  const source = fs.readFileSync(new URL("../../ui/i18n.js", import.meta.url), "utf8");
  const dictionaries = new Function(`${source.slice(0, source.indexOf("const LANGUAGES"))}; return I18N;`)() as Record<string, Record<string, string>>;
  const keys = Object.keys(dictionaries.en!).filter(key => key === "nav.phone" || key.startsWith("phone.")).sort();
  assert.ok(keys.length > 40);
  for (const language of ["ko", "en", "zh", "ja", "es", "pt"]) {
    const dictionary = dictionaries[language]!;
    assert.deepEqual(Object.keys(dictionary).filter(key => key === "nav.phone" || key.startsWith("phone.")).sort(), keys);
    for (const key of keys) assert.ok(dictionary[key]?.trim(), `${language}: ${key}`);
  }
});

test("QR is fetched only on reveal and late responses cannot undo hiding or leaving the view", async () => {
  const source = fs.readFileSync(new URL("../../ui/app.js", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("function hidePhoneQr()"), source.indexOf("function renderPhoneStatus("));
  type Node = { addEventListener(): void };
  type Controls = { showPhoneQr(button: { disabled: boolean }): Promise<void>; hidePhoneQr(): void; busy(value: boolean): void };
  const make = new Function("$", "api", "el", "t", "toast", `let phoneQrGeneration = 0, phoneBusy = false; ${block}; return { showPhoneQr, hidePhoneQr, busy(value) { phoneBusy = value; } };`) as
    (select: (selector: string) => unknown, api: () => Promise<{ url: string; svg: string }>, el: () => Node, t: (key: string) => string, toast: () => void) => Controls;
  let active = true;
  let children: Node[] = [];
  let calls = 0;
  let complete: (pairing: { url: string; svg: string }) => void = () => { throw new Error("no pending fetch"); };
  const controls = make(selector => selector === "#view-phone"
    ? { classList: { contains: () => active } }
    : { replaceChildren: (...nodes: Node[]) => { children = nodes; } },
  () => { calls++; return new Promise(resolve => { complete = resolve; }); },
  () => ({ addEventListener() {} }), key => key, () => assert.fail("unexpected QR error"));
  const button = { disabled: false };
  const pairing = { url: "https://relay.example/#pair=test-only", svg: "<svg/>" };
  assert.equal(calls, 0);
  controls.busy(true);
  await controls.showPhoneQr(button);
  assert.equal(calls, 0);
  controls.busy(false);
  let pending = controls.showPhoneQr(button);
  assert.equal(button.disabled, true);
  controls.hidePhoneQr();
  complete(pairing);
  await pending;
  assert.deepEqual(children, []);
  assert.equal(button.disabled, false);
  pending = controls.showPhoneQr(button);
  active = false;
  complete(pairing);
  await pending;
  assert.deepEqual(children, []);
  active = true;
  pending = controls.showPhoneQr(button);
  complete(pairing);
  await pending;
  assert.equal(children.length, 3);
  controls.hidePhoneQr();
  assert.deepEqual(children, []);
});

test("restart targets only the Mac host job or installs the Windows/Linux host service", async t => {
  const commands: [string, string[]][] = [];
  const f = await admin(t, { platform: "darwin", uid: 501, exec: async (file, args) => { commands.push([file, args]); } });
  assert.deepEqual(await (await fetch(`${f.base}/api/phone/restart`, { method: "POST" })).json(), { ok: true });
  assert.deepEqual(commands, [["launchctl", ["kickstart", "-k", "gui/501/com.clauderipple.host"]]]);
  for (const platform of ["linux", "win32"] as const) {
    commands.length = 0;
    const result = await phoneRequest("restart", "POST", undefined, { platform, exec: async (file, args) => { commands.push([file, args]); } });
    assert.deepEqual(result.body, { ok: true });
    assert.equal(commands[0]?.[0], process.execPath);
    assert.match(commands[0]?.[1][0] ?? "", /remote[/\\]src[/\\]main\.ts$/);
    assert.equal(commands[0]?.[1][1], "install");
  }
  const failed = await phoneRequest("restart", "POST", undefined, { platform: "darwin", uid: 501, exec: async () => { throw new Error("job not installed"); } });
  assert.equal(failed.status, 502);
});
