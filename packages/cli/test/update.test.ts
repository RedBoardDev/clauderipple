import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dropPowerShellShim, installKind, isNewer, runUpdate, updateSource } from "../src/update.ts";
import { writePaths } from "../src/registration.ts";
import { runtime } from "../src/runtime.ts";
import { posixPaths } from "../../../test/capabilities.ts";

test("a failed installer download fails the update and never starts a shell", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-download-"));
  const original = process.env.CLAUDERIPPLE_INSTALLER;
  delete process.env.CLAUDERIPPLE_INSTALLER;
  try {
    const calls: string[] = [];
    const result = runUpdate({ kind: "script", prefix: root }, { node: process.execPath, env: {}, cli: path.join(root, "unused.js") }, "clauderipple@test", {
      platform: "darwin", tempDir: root,
      run: (program) => { calls.push(program); return { status: 22 }; },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(calls, ["curl"]);
    assert.deepEqual(fs.readdirSync(root), [], "the download directory is cleaned on failure");
  } finally {
    if (original === undefined) delete process.env.CLAUDERIPPLE_INSTALLER;
    else process.env.CLAUDERIPPLE_INSTALLER = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a one-off script prefix is remembered without its original environment", { skip: !posixPaths }, () => {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "cr-prefix-"));
  const repo = path.join(prefix, "lib", "node_modules", "clauderipple");
  const rt = { ...runtime(), packaged: false, repo, cli: path.join(repo, "dist", "cli", "src", "index.js") };
  try {
    fs.writeFileSync(path.join(prefix, "clauderipple-install.json"), JSON.stringify({ kind: "script", prefix }));
    const target = installKind(rt, { platform: "darwin", env: {}, home: path.join(prefix, "unrelated-home") });
    assert.deepEqual(target, { kind: "script", prefix });
    const recorded = JSON.parse(fs.readFileSync(writePaths(rt, path.join(prefix, "state")), "utf8"));
    assert.deepEqual(recorded.install, target);
    fs.rmSync(path.join(prefix, "clauderipple-install.json"));
    assert.deepEqual(installKind(rt, { env: {}, stateHome: path.join(prefix, "state") }), target, "paths.json also retains the install method");
    const calls: string[] = [];
    if (target.kind !== "script") assert.fail("a pinned-Node wrapper must never be updated by npm");
    runUpdate(target, rt, "clauderipple@test", { platform: "darwin", tempDir: prefix, run: (program, _args, opts) => {
      calls.push(program);
      assert.equal(opts.env.CLAUDERIPPLE_PREFIX, prefix);
      return { status: 22 };
    } });
    assert.deepEqual(calls, ["curl"], "takes the installer path, never npm");
  } finally {
    fs.rmSync(prefix, { recursive: true, force: true });
  }
});

test("Windows script updates remove inherited PSModulePath after merging their environment", () => {
  const saved = process.env.PSModulePath;
  process.env.PSModulePath = "C:\\Program Files\\PowerShell\\Modules";
  try {
    let called = false;
    const result = runUpdate({ kind: "script", prefix: "C:\\Ripple" }, { node: process.execPath, env: {}, cli: "unused.js" }, "clauderipple@test", {
      platform: "win32",
      run: (program, args, options) => {
        called = true;
        assert.equal(program, "powershell.exe");
        assert.match(args.at(-1) ?? "", /^\$ErrorActionPreference = 'Stop';/);
        assert.equal(Object.keys(options.env).some(key => key.toLowerCase() === "psmodulepath"), false);
        assert.equal(options.env.CLAUDERIPPLE_PREFIX, "C:\\Ripple");
        assert.equal(options.env.CLAUDERIPPLE_PACKAGE, "clauderipple@test");
        return { status: 0 };
      },
    });
    assert.equal(called, true);
    assert.equal(result.ok, true);
  } finally {
    if (saved === undefined) delete process.env.PSModulePath;
    else process.env.PSModulePath = saved;
  }
});

test("versions compare by number, not as text", () => {
  assert.equal(isNewer("0.6.0", "0.5.1"), true);
  assert.equal(isNewer("0.10.0", "0.9.9"), true);
  assert.equal(isNewer("0.5.1", "0.5.1"), false);
  assert.equal(isNewer("0.5.0", "0.5.1"), false);
  assert.equal(isNewer("v1.0.0", "0.9.0"), true);
});

// The install scripts and `npm install -g` put the package in the same layout; only the prefix
// says which one did, and each must be updated its own way (update.ts).
test("an install is recognised by where its files are", () => {
  if (posixPaths) {
    const home = "/Users/me";
    const js = (repo: string) => ({ packaged: false, cli: `${repo}/dist/cli/src/index.js`, repo });
    assert.deepEqual(installKind(js("/Users/me/.clauderipple/lib/node_modules/clauderipple"), { platform: "darwin", env: {}, home }), { kind: "script", prefix: "/Users/me/.clauderipple" });
    assert.deepEqual(installKind(js("/opt/homebrew/lib/node_modules/clauderipple"), { platform: "darwin", env: {}, home }), { kind: "npm", prefix: "/opt/homebrew" });
    assert.deepEqual(installKind(js("/srv/cr/lib/node_modules/clauderipple"), { platform: "linux", env: { CLAUDERIPPLE_PREFIX: "/srv/cr" }, home }), { kind: "script", prefix: "/srv/cr" });
    assert.equal(installKind(js("/Users/me/project/node_modules/clauderipple"), { platform: "darwin", env: {}, home }).kind, "unknown");
    assert.equal(installKind({ packaged: false, cli: "/Users/me/src/ClaudeRipple/packages/cli/src/index.ts", repo: "/Users/me/src/ClaudeRipple" }, { platform: "darwin", env: {}, home }).kind, "checkout");
  }
  assert.equal(installKind({ packaged: true, cli: "x", repo: "y" }).kind, "packaged");

  const win = { packaged: false, cli: "C:\\Users\\me\\.clauderipple\\node_modules\\clauderipple\\dist\\cli\\src\\index.js", repo: "C:\\Users\\me\\.clauderipple\\node_modules\\clauderipple" };
  assert.deepEqual(installKind(win, { platform: "win32", env: {}, home: "C:\\Users\\ME" }), { kind: "script", prefix: "C:\\Users\\me\\.clauderipple" });
  assert.equal(installKind({ ...win, repo: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\clauderipple" }, { platform: "win32", env: {}, home: "C:\\Users\\me" }).kind, "npm");
});

// The fork must not be replaced by the published package: upstream only when asked for.
test("updates come from the fork unless upstream is asked for", () => {
  assert.equal(updateSource({}), "fork");
  assert.equal(updateSource({ CLAUDERIPPLE_UPDATE_SOURCE: "fork" }), "fork");
  assert.equal(updateSource({ CLAUDERIPPLE_UPDATE_SOURCE: "npm" }), "fork");
  assert.equal(updateSource({ CLAUDERIPPLE_UPDATE_SOURCE: "upstream" }), "upstream");
});

test("update on a fork installs nothing and says how; the check never offers one", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-update-"));
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDERIPPLE_HOME: home, CLAUDE_SETTINGS_PATH: path.join(home, "settings.json") };
  delete env.CLAUDERIPPLE_UPDATE_SOURCE;
  delete env.CLAUDERIPPLE_PACKAGE;
  delete env.NODE_OPTIONS;
  const cli = path.resolve(import.meta.dirname, "../src/index.ts");
  // A regression must fail locally, never contact the real registry.
  const noRegistry = `data:text/javascript,${encodeURIComponent('globalThis.fetch = () => { throw new Error("unexpected registry request"); };')}`;
  const run = (...flags: string[]) => spawnSync(process.execPath, ["--import", noRegistry, cli, "update", ...flags], { env, encoding: "utf8", timeout: 30_000 });
  try {
    const update = run();
    assert.equal(update.status, 1, update.stderr);
    assert.match(update.stdout, /npm install --prefix ~\/\.clauderipple\/lib .*\.tgz\n\s*clauderipple restart/);
    // The tray and the dashboard offer an update only when this says newer.
    const check = run("--check", "--json");
    assert.equal(check.status, 0, check.stderr);
    const result: unknown = JSON.parse(check.stdout);
    assert.ok(typeof result === "object" && result !== null && "current" in result);
    assert.equal(typeof result.current, "string");
    assert.deepEqual(result, { current: result.current, latest: null, newer: false, kind: "fork" });
    const textCheck = run("--check");
    assert.equal(textCheck.status, 0, textCheck.stderr);
    assert.match(textCheck.stdout, /Update it from the fork's checkout/);

    env.CLAUDERIPPLE_PACKAGE = "clauderipple@test";
    const forced = run("--force");
    assert.equal(forced.status, 1, forced.stderr);
    assert.match(forced.stdout, /does not install the published \(upstream\) version over it/);

    // Explicit opt-in reaches the upstream check, still without a network request or install.
    env.CLAUDERIPPLE_UPDATE_SOURCE = "upstream";
    const upstream = run("--check", "--json");
    assert.equal(upstream.status, 0, upstream.stderr);
    assert.deepEqual(JSON.parse(upstream.stdout), { current: result.current, latest: null, newer: true, kind: "checkout" });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// PowerShell runs npm's clauderipple.ps1 before the .cmd, and its default policy refuses it (#62).
test("install removes npm's PowerShell shim on Windows, and only there", () => {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "cr-shim-"));
  try {
    const ps1 = path.join(prefix, "clauderipple.ps1");
    fs.writeFileSync(path.join(prefix, "clauderipple.cmd"), "");
    fs.writeFileSync(ps1, "");
    assert.equal(dropPowerShellShim({ kind: "npm", prefix }, "darwin"), null);
    assert.equal(dropPowerShellShim({ kind: "checkout" }, "win32"), null);
    assert.equal(fs.existsSync(ps1), true);
    assert.equal(dropPowerShellShim({ kind: "npm", prefix }, "win32"), ps1);
    assert.equal(fs.existsSync(ps1), false);
    assert.equal(fs.existsSync(path.join(prefix, "clauderipple.cmd")), true);
    // With no .cmd beside it, the .ps1 is the only way in and stays.
    fs.rmSync(path.join(prefix, "clauderipple.cmd"));
    fs.writeFileSync(ps1, "");
    assert.equal(dropPowerShellShim({ kind: "script", prefix }, "win32"), null);
    assert.equal(fs.existsSync(ps1), true);
  } finally {
    fs.rmSync(prefix, { recursive: true, force: true });
  }
});
