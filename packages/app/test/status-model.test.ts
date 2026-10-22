import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJsonOutput, repairDetails, restartStillOwed, routeRequest, shouldNotifyDown, tailLines, trayState, type Doctor } from "../src/status-model.ts";

const direct: Doctor = { mode: "direct", router: { responding: false }, desktop: { proxy: "none" }, cli: { proxy: "none" }, problems: [] };
const down: Doctor = { mode: "ripple", router: { responding: false }, problems: [{ code: "router-down", message: "x" }] };

test("parseJsonOutput: the last JSON object line wins over noise; non-JSON gives null", () => {
  assert.deepEqual(parseJsonOutput('warning: something\n{"mode":"direct"}\n'), { mode: "direct" });
  assert.deepEqual(parseJsonOutput('{\n  "ok": true\n}'), { ok: true });
  assert.equal(parseJsonOutput("usage: clauderipple <command>"), null);
  assert.equal(parseJsonOutput("[1,2]"), null);
  assert.equal(parseJsonOutput(""), null);
});

test("tailLines keeps the last non-empty lines", () => {
  assert.deepEqual(tailLines("a\n\nb\r\nc\n", 2), ["b", "c"]);
});

test("tray: direct gets its own mark, otherwise the health state stands", () => {
  assert.equal(trayState("down", direct), "direct");
  assert.equal(trayState("down", down), "down");
  assert.equal(trayState("ok", null), "ok");
});

test("down notification: once, after the grace, never in direct mode or while busy/updating", () => {
  const base = { downForMs: 25_000, graceMs: 20_000, alreadyNotified: false, updating: false, busy: false, mode: "ripple" as const };
  assert.equal(shouldNotifyDown(base), true);
  assert.equal(shouldNotifyDown({ ...base, downForMs: 5_000 }), false);
  assert.equal(shouldNotifyDown({ ...base, alreadyNotified: true }), false);
  assert.equal(shouldNotifyDown({ ...base, updating: true }), false);
  assert.equal(shouldNotifyDown({ ...base, busy: true }), false);
  assert.equal(shouldNotifyDown({ ...base, mode: "direct" }), false);
  assert.equal(shouldNotifyDown({ ...base, mode: null }), true);
});

test("repair details list each step; without steps the raw output tail", () => {
  assert.deepEqual(repairDetails({ ok: false, steps: [{ name: "supervisor", ok: true }, { name: "health", ok: false, detail: "no answer in 20s" }] }, ""), ["✓ supervisor", "✗ health — no answer in 20s"]);
  assert.deepEqual(repairDetails(null, "boom\nError: x"), ["boom", "Error: x"]);
});

test("ripple:// routing: /api goes to the router, files stay inside the UI folder", () => {
  assert.deepEqual(routeRequest("/api/status"), { kind: "api" });
  assert.deepEqual(routeRequest("/api/providers/measure/abc"), { kind: "api" });
  assert.deepEqual(routeRequest("/"), { kind: "file", rel: "index.html" });
  assert.deepEqual(routeRequest("/app.js"), { kind: "file", rel: "app.js" });
  assert.deepEqual(routeRequest("/favicon.ico"), { kind: "file", rel: "favicon-32.png" });
  // The dashboard routes itself, as the router's SPA fallback lets it.
  assert.deepEqual(routeRequest("/health"), { kind: "file", rel: "index.html" });
  assert.equal(routeRequest("/../main.js"), null);
  assert.equal(routeRequest("/%2e%2e/%2e%2e/etc/passwd"), null);
  assert.equal(routeRequest("/%E0%A4%A"), null);
  assert.equal(routeRequest("/x%00.js"), null);
  // /apix is a file, not the API.
  assert.deepEqual(routeRequest("/apix.js"), { kind: "file", rel: "apix.js" });
});

test("reopen Claude: owed only while the Claude that ran before the change is still running", () => {
  assert.equal(restartStillOwed(1000, 500), true);
  assert.equal(restartStillOwed(1000, 1000), true);
  assert.equal(restartStillOwed(1000, 1500), false, "reopened by hand after the change");
  assert.equal(restartStillOwed(1000, null), false, "quit: the next start picks the change up");
  assert.equal(restartStillOwed(1000, undefined), true, "unknown keeps the step");
});
