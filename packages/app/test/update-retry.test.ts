import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { readUpdateSeen, rememberUpdate, updateNotice, TrayReplacement } from "../src/update-model.ts";

// Execute the real Electron orchestration, replacing only the OS/CLI/notification boundaries.
const main = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const source = main.slice(main.indexOf("let updateSeen:"), main.indexOf("async function checkForUpdate"));
export function updateHarness(sourceText: string, home: string) {
  const boundary = { calls: 0, notifications: 0, quits: 0, locks: 0, fail: true };
  const create = new Function("deps", `
    const { fs, path, home, readUpdateSeen, rememberUpdate, updateNotice, TrayReplacement, boundary } = deps;
    let updating = false, routerUpdateUntil = 0, updateNotification = null, availableUpdate = null;
    const app = { getVersion: () => '1.0.0', releaseSingleInstanceLock() {}, requestSingleInstanceLock() { boundary.locks++; return true; }, quit() { boundary.quits++; } };
    const runCliResult = async () => { boundary.calls++; return { ok: !boundary.fail, output: 'launch refused' }; };
    const Notification = class { static isSupported() { return true; } on() {} show() { boundary.notifications++; } };
    const L = { autoUpdated: v => v, autoAvailable: v => v }, notifyIcon = () => undefined;
    ${stripTypeScriptTypes(sourceText)}
    return handleRouterUpdate;
  `);
  const handle = create({ fs, path, home, readUpdateSeen, rememberUpdate, updateNotice, TrayReplacement, boundary }) as (status: object) => Promise<void>;
  return { handle, boundary };
}

test("real tray polling retries failed replacement without duplicating notification or completing before launch", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tray-retry-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { handle, boundary } = updateHarness(source, home);
  const status = { version: "1.1.0", autoUpdate: { kind: "script", lastUpdatedFrom: "1.0.0", lastUpdatedTo: "1.1.0", lastUpdatedAt: 1000 } };
  await assert.rejects(handle(status), /launch refused/);
  assert.equal(boundary.calls, 1);
  assert.equal(boundary.quits, 0);
  assert.equal(boundary.locks, 1);
  assert.equal(boundary.notifications, 1);
  await handle(status);
  assert.equal(boundary.calls, 1);
  t.mock.timers.tick(60_000);
  boundary.fail = false;
  await handle(status);
  assert.equal(boundary.calls, 2);
  assert.equal(boundary.quits, 1);
  assert.equal(boundary.notifications, 1);
});
