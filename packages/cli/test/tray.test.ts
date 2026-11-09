import { test } from "node:test";
import assert from "node:assert/strict";

import { spawn, execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildTrayBundle,
  earlyExit,
  enclosingApp,
  ensureTrayBundle,
  installTrayRuntime,
  npmEnv,
  swapTrayRuntime,
  TRAY_BUNDLE_ID,
  trayBundleApp,
  trayBundlePlist,
  trayEnv,
  trayRuntimeMatches,
  trayRuntimeRange,
} from "../src/tray.ts";

/** What npm's Electron.app holds, cut down to what the tray's bundle changes or must keep. */
const ELECTRON_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>Electron</string>
	<key>CFBundleExecutable</key>
	<string>Electron</string>
	<key>CFBundleIconFile</key>
	<string>electron.icns</string>
	<key>CFBundleIdentifier</key>
	<string>com.github.Electron</string>
	<key>CFBundleName</key>
	<string>Electron</string>
	<key>NSHighResolutionCapable</key>
	<true/>
</dict>
</plist>
`;

function writeFakeApp(app: string): void {
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), ELECTRON_PLIST);
  fs.writeFileSync(path.join(app, "Contents", "MacOS", "Electron"), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(app, "Contents", "Resources", "electron.icns"), "electron-icon");
}

/** An npm install of Electron inside a staging folder, as `electron`'s own index.js answers it. */
function stageFakeElectron(staging: string): number {
  const app = path.join(staging, "node_modules", "electron", "dist", "Electron.app");
  writeFakeApp(app);
  const pkg = path.join(staging, "node_modules", "electron");
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "electron", main: "index.js" }));
  // The path is relative to the package, as Electron's own index.js answers it, so the staged copy
  // still resolves after the swap moves the whole folder.
  fs.writeFileSync(path.join(pkg, "index.js"), `module.exports = require("node:path").join(__dirname, "dist", "Electron.app", "Contents", "MacOS", "Electron");\n`);
  return 0;
}

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

// Issue #80: Electron's install.js runs `node install.js` through npm's shell, and on a machine
// whose only Node is the one ClaudeRipple downloaded there was no `node` on PATH — so the tray
// failed to install on exactly the machines whose router it is meant to recover.
test("npm for the tray finds the running Node first, whatever the variable is called", () => {
  const nodeDir = path.dirname(process.execPath);
  const posix = npmEnv({ PATH: "/usr/bin", KEEP: "1" });
  assert.equal(posix.PATH, `${nodeDir}${path.delimiter}/usr/bin`);
  assert.equal(posix.KEEP, "1");

  // Windows spells it Path: that is the variable the child's shell reads.
  const windows = npmEnv({ Path: "C:\\Windows\\system32" });
  assert.equal(windows.Path?.split(path.delimiter)[0], nodeDir);

  // Both spellings at once would be two variables in the child's environment block; one remains.
  const both = npmEnv({ Path: "C:\\Windows", PATH: "C:\\other" });
  const names = Object.keys(both).filter((name) => name.toUpperCase() === "PATH");
  assert.equal(names.length, 1);
  assert.equal(both[names[0]!]?.split(path.delimiter)[0], nodeDir);
});

// B15: the fetched Electron lives in the home folder, so installing a newer ClaudeRipple left the
// old runtime in place and the tray kept running it. A refresh compares the recorded range and
// swaps in a fully installed copy, keeping the working one when the move cannot be made.
test("a fetched runtime is refreshed only when it is not the one this version asks for", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-tray-runtime-"));
  try {
    assert.equal(trayRuntimeRange(dir), null);
    assert.equal(trayRuntimeMatches("^38.1.0", dir), false);
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { electron: "^38.1.0" } }));
    assert.equal(trayRuntimeRange(dir), "^38.1.0");
    assert.equal(trayRuntimeMatches("^38.1.0", dir), true);
    assert.equal(trayRuntimeMatches("^39.0.0", dir), false, "a newer version's range refreshes the old copy");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a staged runtime replaces the working one, and a locked one is left whole", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-tray-swap-"));
  try {
    const target = path.join(root, "tray-runtime");
    // No working copy yet: the staged one simply moves in.
    let staging = path.join(root, "tray-runtime.new-1");
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, "package.json"), "{}");
    assert.deepEqual(swapTrayRuntime(target, staging), { ok: true });
    assert.equal(fs.existsSync(path.join(target, "package.json")), true);
    assert.equal(fs.existsSync(staging), false);

    // A working copy is replaced, and the backup goes once the move worked.
    staging = path.join(root, "tray-runtime.new-2");
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, "package.json"), JSON.stringify({ dependencies: { electron: "^39.0.0" } }));
    assert.deepEqual(swapTrayRuntime(target, staging), { ok: true });
    assert.equal(fs.readFileSync(path.join(target, "package.json"), "utf8"), JSON.stringify({ dependencies: { electron: "^39.0.0" } }));
    assert.deepEqual(fs.readdirSync(root).sort(), ["tray-runtime"]);

    // A backup path that cannot be used (a running tray's files held open) leaves both copies as
    // they were, and says so rather than reporting a half-done replacement.
    const blocked = path.join(root, "tray-runtime.new-3");
    fs.mkdirSync(blocked);
    fs.writeFileSync(path.join(blocked, "package.json"), "{}");
    fs.writeFileSync(path.join(root, "taken"), "x");
    const failed = swapTrayRuntime(target, blocked, path.join(root, "taken"));
    assert.equal(failed.ok, false);
    assert.match(failed.ok ? "" : failed.message, /still holds/);
    assert.equal(fs.readFileSync(path.join(target, "package.json"), "utf8"), JSON.stringify({ dependencies: { electron: "^39.0.0" } }));
    assert.equal(fs.existsSync(blocked), true, "the staged copy is the caller's to clean up");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// The Dock shows a bundle's own icon while its app is not running, and npm's Electron.app is the
// atom named Electron. So the tray runs a copy named ClaudeRipple with our identifier and icon.
test("the tray's bundle takes our name, identifier and icon and keeps Electron's executable", () => {
  const plist = trayBundlePlist(ELECTRON_PLIST, true);
  assert.match(plist, /<key>CFBundleName<\/key>\s*<string>ClaudeRipple<\/string>/);
  assert.match(plist, /<key>CFBundleDisplayName<\/key>\s*<string>ClaudeRipple<\/string>/);
  assert.match(plist, new RegExp(`<key>CFBundleIdentifier</key>\\s*<string>${TRAY_BUNDLE_ID}</string>`));
  assert.match(plist, /<key>CFBundleIconFile<\/key>\s*<string>icon.icns<\/string>/);
  // The executable keeps its name: renaming it would mean touching every nested reference.
  assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>Electron<\/string>/);
  // Everything else Electron put in the plist stays.
  assert.match(plist, /<key>NSHighResolutionCapable<\/key>\s*<true\/>/);
  // Without an icon of our own, Electron's is left in place rather than the key emptied.
  assert.match(trayBundlePlist(ELECTRON_PLIST, false), /electron\.icns/);
  // The bundle an executable sits in is the one to copy.
  assert.equal(enclosingApp("/x/Electron.app/Contents/MacOS/Electron"), "/x/Electron.app");
  assert.equal(enclosingApp("/x/Electron.app/Electron"), null);
});

test("a built tray bundle carries the patched plist and icon, and is signed after both", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-tray-bundle-"));
  try {
    const source = path.join(root, "node_modules", "electron", "dist", "Electron.app");
    writeFakeApp(source);
    const icon = path.join(root, "icon.icns");
    fs.writeFileSync(icon, "our-icon");
    const app = path.join(root, "tray-runtime", "ClaudeRipple.app");
    let signed: string | null = null;
    let plistWhenSigned = "";
    const built = buildTrayBundle(
      { electron: path.join(source, "Contents", "MacOS", "Electron"), app, icon },
      { sign: (target) => { signed = target; plistWhenSigned = fs.readFileSync(path.join(target, "Contents", "Info.plist"), "utf8"); } },
    );
    assert.deepEqual(built, { ok: true, executable: path.join(app, "Contents", "MacOS", "Electron") });
    assert.equal(signed, app, "the signature is the last step, over the finished bundle");
    assert.match(plistWhenSigned, /<string>ClaudeRipple<\/string>/);
    assert.match(plistWhenSigned, new RegExp(TRAY_BUNDLE_ID));
    assert.equal(fs.readFileSync(path.join(app, "Contents", "Resources", "icon.icns"), "utf8"), "our-icon");
    // The source bundle is ClaudeRipple's copy to change, not Electron's.
    assert.match(fs.readFileSync(path.join(source, "Contents", "Info.plist"), "utf8"), /com\.github\.Electron/);
    assert.equal(fs.readFileSync(path.join(source, "Contents", "Resources", "electron.icns"), "utf8"), "electron-icon");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a bundle that could not be signed is removed instead of being left to fail at launch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-tray-bundle-fail-"));
  try {
    const source = path.join(root, "Electron.app");
    writeFakeApp(source);
    const app = path.join(root, "ClaudeRipple.app");
    const built = buildTrayBundle(
      { electron: path.join(source, "Contents", "MacOS", "Electron"), app, icon: null },
      { sign: () => { throw new Error("codesign: not signed"); } },
    );
    assert.deepEqual(built, { ok: false, message: "codesign: not signed" });
    assert.equal(fs.existsSync(app), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the tray uses its own bundle once made, builds one for an older runtime, and only on macOS", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-tray-ensure-"));
  try {
    const runtimeDir = path.join(root, "tray-runtime");
    const electron = path.join(runtimeDir, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
    const app = trayBundleApp(runtimeDir);
    writeFakeApp(app);
    fs.writeFileSync(path.join(app, "Contents", "Info.plist"), trayBundlePlist(ELECTRON_PLIST, true));
    let builds = 0;
    const existing = ensureTrayBundle(electron, {
      platform: "darwin", runtimeDir, icon: null,
      build: () => { builds += 1; return { ok: false, message: "should not build" }; },
    });
    assert.deepEqual(existing, { ok: true, executable: path.join(app, "Contents", "MacOS", "Electron") });
    assert.equal(builds, 0, "a bundle that is already there is not copied again");

    // A runtime fetched before this change has no bundle: one is built in place.
    fs.rmSync(app, { recursive: true, force: true });
    const calls: Array<{ electron: string; app: string; icon: string | null }> = [];
    const made = ensureTrayBundle(electron, {
      platform: "darwin", runtimeDir, icon: "/icons/icon.icns",
      build: (opts) => { calls.push(opts); return { ok: true, executable: "/made" }; },
    });
    assert.deepEqual(made, { ok: true, executable: "/made" });
    assert.deepEqual(calls, [{ electron, app, icon: "/icons/icon.icns" }]);

    // No Dock on Windows or Linux, and a checkout's Electron is not the runtime's to copy.
    assert.equal(ensureTrayBundle(electron, { platform: "win32", runtimeDir }), null);
    assert.equal(ensureTrayBundle(electron, { platform: "linux", runtimeDir }), null);
    assert.equal(ensureTrayBundle("/checkout/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron", { platform: "darwin", runtimeDir }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an install builds the tray's bundle inside the staging folder before the swap", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-tray-install-"));
  try {
    // Node resolves the required Electron against its real path (/private/var on macOS).
    const target = path.join(fs.realpathSync(root), "tray-runtime");
    let bundledFrom = "";
    let bundledTo = "";
    const result = installTrayRuntime({
      target, existing: null, platform: "darwin",
      install: (staging) => stageFakeElectron(staging),
      bundle: (electron, app) => { bundledFrom = electron; bundledTo = app; return { ok: true, executable: path.join(app, "Contents", "MacOS", "Electron") }; },
    });
    assert.equal(result.ok, true, result.message);
    const staging = `${target}.new-${process.pid}`;
    assert.equal(bundledTo, path.join(staging, "ClaudeRipple.app"));
    assert.equal(bundledFrom, path.join(staging, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"));
    // The staging folder became the runtime, so the bundle goes with it; nothing is left beside it.
    assert.equal(fs.existsSync(path.join(target, "node_modules", "electron", "package.json")), true);
    assert.deepEqual(fs.readdirSync(root), ["tray-runtime"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("an install that fails in staging leaves the working runtime exactly as it was", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-tray-install-fail-"));
  try {
    const target = path.join(root, "tray-runtime");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ dependencies: { electron: "^37.0.0" } }));
    fs.writeFileSync(path.join(target, "still-here"), "old");
    const result = installTrayRuntime({
      target, existing: null, refresh: true, platform: "darwin",
      install: () => 1,
      bundle: () => { throw new Error("no bundle without an Electron"); },
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /npm could not install Electron/);
    assert.equal(fs.readFileSync(path.join(target, "still-here"), "utf8"), "old");
    assert.deepEqual(fs.readdirSync(root), ["tray-runtime"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a bundle that cannot be built leaves the tray on the plain Electron, still installed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-tray-install-nobundle-"));
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (line: unknown) => { warnings.push(String(line)); };
  try {
    const target = path.join(root, "tray-runtime");
    const result = installTrayRuntime({
      target, existing: null, platform: "darwin",
      install: (staging) => stageFakeElectron(staging),
      bundle: () => ({ ok: false, message: "codesign refused" }),
    });
    assert.equal(result.ok, true, result.message);
    assert.match(warnings.join("\n"), /plain Electron: codesign refused/);
    assert.equal(fs.existsSync(path.join(target, "node_modules", "electron", "package.json")), true);
  } finally {
    console.warn = warn;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows and Linux installs build no bundle at all", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-tray-install-plain-"));
  try {
    for (const platform of ["win32", "linux"] as const) {
      const target = path.join(root, `tray-runtime-${platform}`);
      const result = installTrayRuntime({
        target, existing: null, platform,
        install: (staging) => stageFakeElectron(staging),
        bundle: () => { throw new Error(`${platform} has no bundle`); },
      });
      assert.equal(result.ok, true, result.message);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// The real command on a real Electron copy: the plist and icon change break Electron's signature,
// so the copy is signed again ad-hoc. Skipped where the checkout has no Electron to copy.
test("a real Electron.app copy signs ad-hoc and passes codesign --verify", (t) => {
  const source = path.resolve(import.meta.dirname, "../../../node_modules/electron/dist/Electron.app");
  const icon = path.resolve(import.meta.dirname, "../../app/assets/icon.icns");
  if (process.platform !== "darwin") { t.skip("macOS signer only"); return; }
  if (!fs.existsSync(path.join(source, "Contents", "MacOS", "Electron")) || !fs.existsSync(icon)) { t.skip("no Electron or icon in this checkout"); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-tray-sign-"));
  try {
    const app = path.join(root, "ClaudeRipple.app");
    const built = buildTrayBundle({ electron: path.join(source, "Contents", "MacOS", "Electron"), app, icon });
    assert.equal(built.ok, true, built.ok ? "" : built.message);
    const executable = built.ok ? built.executable : "";
    assert.equal(fs.existsSync(executable), true);
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "ignore" });
    const details = spawnSync("/usr/bin/codesign", ["-dv", app], { encoding: "utf8" });
    assert.match(details.stderr, new RegExp(`Identifier=${TRAY_BUNDLE_ID}`));
    assert.equal(fs.existsSync(path.join(app, "Contents", "Resources", "icon.icns")), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
