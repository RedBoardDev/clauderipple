import { test } from "node:test";
import assert from "node:assert/strict";

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { earlyExit, installTrayRuntime, NATIVE_APP_INSTALL_HINT, openNativeApp, startTray, trayEnv } from "../src/tray.ts";

test("macOS opens the native bundle by id and reports its absence without fetching a runtime", () => {
  const calls: [string, string[]][] = [];
  const result = openNativeApp((file, args) => {
    calls.push([file, args]);
    return { status: 0 };
  });
  assert.deepEqual(calls, [["/usr/bin/open", ["-b", "com.clauderipple.mac"]]]);
  assert.equal(result.ok, true);
  for (const status of [1, null]) {
    assert.deepEqual(openNativeApp(() => ({ status })), { ok: false, message: NATIVE_APP_INSTALL_HINT });
  }
  assert.deepEqual(openNativeApp(() => { throw new Error("unavailable"); }), { ok: false, message: NATIVE_APP_INSTALL_HINT });
});

test("macOS tray start and runtime-install both delegate to the native app, including foreground starts", async () => {
  let calls = 0;
  const result = { ok: true, message: "fake native app opened" };
  const options = { platform: "darwin" as const, openApp: () => { calls++; return result; } };
  assert.deepEqual(await startTray(options), result);
  assert.deepEqual(await startTray({ ...options, detached: false }), result);
  assert.deepEqual(installTrayRuntime(options), result);
  assert.equal(calls, 3);
  const missing = { ok: false, message: NATIVE_APP_INSTALL_HINT };
  assert.deepEqual(await startTray({ ...options, openApp: () => missing }), missing);
  assert.deepEqual(installTrayRuntime({ ...options, openApp: () => missing }), missing);
});

// Issue #50: a tray that died at launch still reported "✓ tray started".
test("a tray process that exits at once is reported with its output; one that stays up is started", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-tray-"));
  try {
    const log = path.join(dir, "tray.log");
    fs.writeFileSync(log, "GPU process isn't usable. Goodbye.\n");
    const dead = spawn(process.execPath, ["-e", "process.exit(3)"], { stdio: "ignore" });
    const failed = await earlyExit(dead, log, 5_000);
    assert.equal(failed.ok, false);
    assert.match(failed.message, /exit code 3/);
    assert.match(failed.message, /Goodbye/);

    // A second tray leaves at once with 0 when one is already up.
    const duplicate = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    assert.deepEqual(await earlyExit(duplicate, log, 5_000), { ok: true, message: "✓ tray is already running" });

    const alive = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5_000)"], { stdio: "ignore" });
    try {
      assert.deepEqual(await earlyExit(alive, log, 300), { ok: true, message: "✓ tray started" });
    } finally { alive.kill(); }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the tray's environment drops ELECTRON_RUN_AS_NODE rather than emptying it (issue #8)", () => {
  // Windows Electron runs as Node whenever the variable exists, even empty (measured 2026-09-24).
  const env = trayEnv({ PATH: "/bin", ELECTRON_RUN_AS_NODE: "1", Electron_Run_As_Node: "" });
  assert.deepEqual(env, { PATH: "/bin" });
  assert.equal(Object.hasOwn(env, "ELECTRON_RUN_AS_NODE"), false);
});
