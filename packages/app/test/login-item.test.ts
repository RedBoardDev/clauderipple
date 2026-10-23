import { test } from "node:test";
import assert from "node:assert/strict";
import { trayLoginItemDecision } from "../../cli/src/launchd.ts";

test("npm macOS tray migrates its bare Electron item, including an already initialized installation", () => {
  for (const initialized of [false, true]) {
    assert.deepEqual(trayLoginItemDecision({ platform: "darwin", packaged: false, initialized, electronOpenAtLogin: true }), { removeElectronItem: true, enableAgent: true });
  }
});

test("npm macOS tray defaults on once and preserves an existing off choice afterwards", () => {
  assert.deepEqual(trayLoginItemDecision({ platform: "darwin", packaged: false, initialized: false, electronOpenAtLogin: false }), { removeElectronItem: false, enableAgent: true });
  assert.deepEqual(trayLoginItemDecision({ platform: "darwin", packaged: false, initialized: true, electronOpenAtLogin: false }), { removeElectronItem: false, enableAgent: false });
});

test("packaged macOS and Windows/Linux keep the native login item path", () => {
  for (const platform of ["darwin", "win32", "linux"] as const) {
    for (const packaged of [false, true]) {
      if (platform === "darwin" && !packaged) continue;
      assert.equal(trayLoginItemDecision({ platform, packaged, initialized: false, electronOpenAtLogin: true }), null);
    }
  }
});
