// doctor / repair / direct / app launcher.
//
// SAFETY: an earlier test run broke the user's live router. Nothing here may reach the real
// launchd, Task Scheduler, systemd, ~/.claude/settings.json, the Claude Desktop config library,
// ~/Applications or ~/.clauderipple. Every path below is redirected into a temp dir before any
// module reads it, the launchd label is a throwaway one, the supervisor is a fake or runs an
// injected launchctl, and CLAUDERIPPLE_LAUNCHCTL names a tripwire that fails loudly if the real
// default runner is ever used. process.platform is never spoofed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { posixModes, posixPaths } from "../../../test/capabilities.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-recovery-"));
const label = `com.clauderipple.check-${crypto.randomBytes(4).toString("hex")}`;
const tripwire = path.join(root, "tripwire-launchctl");
fs.writeFileSync(tripwire, `#!/bin/sh\necho "real launchctl runner used: $*" >> "${path.join(root, "tripwire.log")}"\nexit 97\n`, { mode: 0o755 });
Object.assign(process.env, {
  CLAUDERIPPLE_HOME: path.join(root, "unused-home"),
  CLAUDE_SETTINGS_PATH: path.join(root, "unused-settings.json"),
  CLAUDE_APP_SUPPORT: path.join(root, "unused-Claude-3p"),
  CLAUDERIPPLE_LAUNCHD_LABEL: label,
  CLAUDERIPPLE_TASK_NAME: `ClaudeRippleCheck${crypto.randomBytes(4).toString("hex")}`,
  CLAUDERIPPLE_SYSTEMD_UNIT: `clauderipple-check-${crypto.randomBytes(4).toString("hex")}.service`,
  CLAUDERIPPLE_LAUNCH_AGENTS_DIR: path.join(root, "LaunchAgents"),
  CLAUDERIPPLE_LAUNCHER_DIR: path.join(root, "Applications"),
  CLAUDERIPPLE_LAUNCHCTL: tripwire,
  XDG_CONFIG_HOME: path.join(root, "xdg-config"),
  XDG_DATA_HOME: path.join(root, "xdg-data"),
});
process.on("exit", () => {
  const tripped = fs.existsSync(path.join(root, "tripwire.log"));
  fs.rmSync(root, { recursive: true, force: true });
  if (tripped) {
    console.error("the default launchctl runner was used by a test");
    process.exitCode = 1;
  }
});

const { renderPlist, plistPath } = await import("../src/launchd.ts");
const { renderUnit } = await import("../src/systemd.ts");
const { renderLauncher, writeLauncher } = await import("../src/schtasks.ts");
const { removeClientIntegrations } = await import("../src/integrations.ts");
const { withCommandHelp } = await import("../src/help-gate.ts");
const { codexOn, codexEnabled } = await import("../src/codex.ts");
const { launchdSupervisor, launcherProgram, plistProgramArguments, registration, targetsExist, unitExecStart } = await import("../src/registration.ts");
const { classifyMode, cliProxyState, desktopProxyState, doctor, repair } = await import("../src/doctor.ts");
const { directOn, directOff, directStatePath } = await import("../src/direct.ts");
const { applyAppProxy, configLibraryDir, currentAppProxy } = await import("../src/picker.ts");
const { installLauncher, uninstallLauncher, LAUNCHER_BUNDLE_ID } = await import("../src/launcher.ts");
const { writeBundle } = await import("../src/bundle.ts");
type SupervisorOps = import("../src/registration.ts").SupervisorOps;
type SupervisorView = import("../src/registration.ts").SupervisorView;
type Runtime = import("../src/runtime.ts").Runtime;

let n = 0;
/** A fresh home, settings.json and Config Library for one test, all under the temp root. */
function scratch(config: Record<string, unknown> | null = { listen: { host: "127.0.0.1", port: 18791 } }): { home: string; settings: string; ca: string; proxyUrl: string } {
  const dir = path.join(root, `t${++n}`);
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
  if (config) fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(config));
  process.env.CLAUDE_SETTINGS_PATH = path.join(dir, "settings.json");
  process.env.CLAUDE_APP_SUPPORT = path.join(dir, "Claude-3p");
  process.env.CLAUDERIPPLE_LAUNCH_AGENTS_DIR = path.join(dir, "LaunchAgents");
  process.env.CLAUDERIPPLE_LAUNCHER_DIR = path.join(dir, "Applications");
  const port = (config?.listen as { port?: number } | undefined)?.port ?? 8791;
  return { home, settings: process.env.CLAUDE_SETTINGS_PATH, ca: path.join(home, "ca.pem"), proxyUrl: `http://127.0.0.1:${port}` };
}

function fakeRuntime(dir: string): Runtime {
  const router = path.join(dir, "router-index.js");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(router, "// router");
  return { node: process.execPath, env: {}, cli: path.join(dir, "cli-index.js"), router, hookScript: "", modDir: "", repo: dir, trayMain: "", packaged: true };
}

/** A launchctl that records calls and keeps one job's state; bootstrap "starts" it. */
function fakeLaunchctl(opts: { loaded?: boolean; running?: boolean } = {}) {
  const calls: string[][] = [];
  let loaded = opts.loaded ?? false;
  let running = opts.running ?? false;
  const run = (args: string[]) => {
    calls.push(args);
    switch (args[0]) {
      case "print":
        return loaded ? { ok: true, out: `state = ${running ? "running" : "waiting"}\n${running ? "\tpid = 4242\n" : ""}` } : { ok: false, out: "Could not find service" };
      case "bootout":
        loaded = running = false;
        return { ok: true, out: "" };
      case "bootstrap":
        loaded = running = true;
        return { ok: true, out: "" };
      case "kickstart":
        if (!loaded) return { ok: false, out: "Could not find service" };
        running = true;
        return { ok: true, out: "" };
      default:
        return { ok: false, out: "unexpected" };
    }
  };
  return { run, calls, isRunning: () => running };
}

function fakeSupervisor(view: Partial<SupervisorView>, opts: { start?: "already-running" | "started" | "failed"; register?: () => string } = {}) {
  const calls: string[] = [];
  const ops: SupervisorOps = {
    inspect: () => ({ registered: true, program: process.execPath, args: [], programExists: true, state: "running", pid: 1, current: true, ...view }),
    register: () => {
      calls.push("register");
      return opts.register ? opts.register() : "/fake/definition";
    },
    start: () => {
      calls.push("start");
      return opts.start ?? "started";
    },
  };
  return { ops, calls };
}

const answering = (version = "9.9.9") => async () => ({ version });
const silent = async () => null;
const noSleep = async () => {};

test("--help and -h prevent dispatch for every command, including destructive arguments", async (t) => {
  const print = t.mock.method(console, "log", () => {});
  const usage = () => console.log("usage");
  const commands = ["install", "uninstall", "status", "doctor", "repair", "direct", "app", "start", "stop", "restart", "logs", "remote", "config", "ui", "tray", "update", "login", "logout", "claude-login", "claude-logout", "google-login", "google-logout", "image", "picker", "codex", "agent-title", "mod", "awake", "tether", "power"];
  let dispatched = 0;
  for (const command of commands) {
    for (const help of ["--help", "-h"]) {
      const before = print.mock.callCount();
      await withCommandHelp([command, "on", "--purge", help], async () => { dispatched++; }, usage);
      assert.ok(print.mock.callCount() > before, `${command} prints usage`);
    }
  }
  assert.equal(dispatched, 0);
  await withCommandHelp(["status"], async () => { dispatched++; }, usage);
  assert.equal(dispatched, 1, "ordinary commands still dispatch");
});

test("uninstall clears picker and Codex settings before purge, even if trust removal fails", () => {
  const ctx = scratch();
  const oldHome = process.env.CLAUDERIPPLE_HOME;
  const oldCodex = process.env.CODEX_HOME;
  process.env.CLAUDERIPPLE_HOME = ctx.home;
  process.env.CODEX_HOME = path.join(ctx.home, "codex");
  applyAppProxy(ctx.proxyUrl);
  codexOn(18793);
  try {
    let untrusted = false;
    removeClientIntegrations(ctx.home, (ca) => {
      assert.equal(ca, ctx.ca);
      untrusted = true;
      throw new Error("confirmation declined");
    });
    assert.equal(currentAppProxy().egressProxyUrl, null);
    assert.equal(codexEnabled(), false);
    assert.equal(fs.existsSync(path.join(process.env.CODEX_HOME, "clauderipple.config.toml")), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.home, "config.json"), "utf8")).picker.enabled, false);
    assert.equal(untrusted, true);
  } finally {
    if (oldHome === undefined) delete process.env.CLAUDERIPPLE_HOME;
    else process.env.CLAUDERIPPLE_HOME = oldHome;
    if (oldCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodex;
  }
});

// ---- parsing and classification --------------------------------------------------------

test("definitions parse back into the program and arguments they were rendered from", () => {
  const program = "/opt/a&b/node";
  const args = ["/opt/x y/router/src/index.js"];
  assert.deepEqual(plistProgramArguments(renderPlist({ program, args, home: "/h", stdoutLog: "/h/l" })), [program, ...args]);
  assert.deepEqual(unitExecStart(renderUnit({ program: "/opt/100%/node", args: ['/tmp/$USER/q".js'], home: "/h" })), ["/opt/100%/node", '/tmp/$USER/q".js']);
  assert.deepEqual(launcherProgram(renderLauncher({ program: "C:\\Program Files\\node.exe", args: ["C:\\it's\\index.js"], home: "C:\\h" })), ["C:\\Program Files\\node.exe", "C:\\it's\\index.js"]);
});

test("a launcher script counts as present only when what it execs exists", () => {
  const dir = path.join(root, "targets");
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, "launcher");
  fs.writeFileSync(script, `#!/bin/sh\nexport X=1\nexec "${process.execPath}" "${path.join(dir, "gone.js")}"\n`);
  assert.equal(targetsExist(script, []), false);
  fs.writeFileSync(path.join(dir, "gone.js"), "");
  assert.equal(targetsExist(script, []), true);
  assert.equal(targetsExist(path.join(dir, "nope"), []), false);
  assert.equal(targetsExist(process.execPath, [path.join(dir, "missing.js")]), false);
});

test("registration mirrors install: packaged/Windows/Linux run node + router, a macOS checkout runs the bundle", () => {
  const rt = { ...fakeRuntime(path.join(root, "rt-reg")), packaged: false, env: { A: "1" } };
  const linux = registration(rt, "/h", "1.0.0", "linux", null);
  assert.deepEqual(linux, { program: rt.node, args: [rt.router], bundleId: "com.clauderipple.app", env: { A: "1" }, bundle: null });
  const mac = registration(rt, "/h", "1.0.0", "darwin", "/s.json");
  if (posixPaths) assert.equal(mac.program, "/h/ClaudeRipple.app/Contents/MacOS/ClaudeRipple");
  assert.deepEqual(mac.env, { CLAUDE_SETTINGS_PATH: "/s.json" });
  assert.deepEqual(mac.bundle, { node: rt.node, script: rt.router, version: "1.0.0" });
});

test("mode: Ripple, direct and mixed", () => {
  assert.equal(classifyMode("ripple", "ripple", true), "ripple");
  assert.equal(classifyMode("ripple", "none", false), "ripple"); // picker mode off: Desktop itself is not routed
  assert.equal(classifyMode("ripple", "none", true), "mixed");
  assert.equal(classifyMode("none", "ripple", false), "mixed");
  assert.equal(classifyMode("none", "none", true), "direct");
  assert.equal(classifyMode("other", "other", true), "direct");
});

test("a proxy is stale only when it is ours on another port", () => {
  const ca = "/h/ca.pem";
  assert.deepEqual(cliProxyState({}, "http://127.0.0.1:8791", ca), { proxy: "none", url: null, stale: false });
  assert.equal(cliProxyState({ HTTPS_PROXY: "http://127.0.0.1:8791" }, "http://127.0.0.1:8791", ca).proxy, "ripple");
  assert.deepEqual(cliProxyState({ HTTPS_PROXY: "http://127.0.0.1:9000", NODE_EXTRA_CA_CERTS: ca }, "http://127.0.0.1:8791", ca), { proxy: "other", url: "http://127.0.0.1:9000", stale: true });
  assert.equal(cliProxyState({ HTTPS_PROXY: "http://127.0.0.1:9000", NODE_EXTRA_CA_CERTS: "/corp.pem" }, "http://127.0.0.1:8791", ca).stale, false);
  assert.equal(desktopProxyState({ appliedId: "a", egressProxyUrl: "http://127.0.0.1:9000", ours: true }, "http://127.0.0.1:8791").stale, true);
  assert.equal(desktopProxyState({ appliedId: "a", egressProxyUrl: "http://corp:3128", ours: false }, "http://127.0.0.1:8791").stale, false);
  assert.equal(desktopProxyState({ appliedId: "a", egressProxyUrl: null, ours: false }, "http://127.0.0.1:8791").proxy, "none");
});

// ---- doctor ------------------------------------------------------------------------------

test("doctor: a plist whose program no longer exists is named, with the router down (2026-10-20)", async () => {
  const { home } = scratch();
  const gone = path.join(root, "old-install", "bin", "node");
  fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
  fs.writeFileSync(plistPath(), renderPlist({ program: gone, args: ["/old/router/src/index.js"], home, stdoutLog: path.join(home, "logs", "launchd.log") }));
  const reg = registration(fakeRuntime(path.join(root, "rt-doc")), home, "1.0.0");
  const lc = fakeLaunchctl({ loaded: true, running: false });
  const d = await doctor({ home, version: "1.0.0", supervisor: launchdSupervisor(reg, home, lc.run), routerStatus: silent, remoteHostInstalled: () => false });
  assert.equal(d.supervisor.registered, true);
  assert.equal(d.supervisor.program, gone);
  assert.equal(d.supervisor.programExists, false);
  assert.equal(d.supervisor.state, "loaded");
  assert.equal(d.router.responding, false);
  const codes = d.problems.map((p) => p.code);
  assert.ok(codes.includes("supervisor-program-missing"), codes.join());
  assert.ok(codes.includes("router-down"));
  assert.ok(codes.includes("supervisor-not-running"));
  assert.ok(lc.calls.every((c) => c[0] === "print" && c[1]!.endsWith(`/${label}`)), "doctor only reads launchd, and only the throwaway label");
});

test("doctor: shape, mode and proxies on a healthy install", async () => {
  const { home, proxyUrl, settings } = scratch({ listen: { host: "127.0.0.1", port: 18791 }, picker: { enabled: true } });
  fs.writeFileSync(settings, JSON.stringify({ env: { HTTPS_PROXY: proxyUrl, NODE_EXTRA_CA_CERTS: path.join(home, "ca.pem") } }));
  applyAppProxy(proxyUrl);
  const { ops } = fakeSupervisor({ pid: 77 });
  const d = await doctor({ home, version: "9.9.9", supervisor: ops, routerStatus: answering("9.9.9"), remoteHostInstalled: () => false });
  assert.deepEqual(d, {
    mode: "ripple",
    router: { responding: true, version: "9.9.9", pid: 77, url: proxyUrl, adminUrl: "http://127.0.0.1:18792" },
    supervisor: { registered: true, program: process.execPath, programExists: true, state: "running" },
    desktop: { proxy: "ripple", url: proxyUrl },
    cli: { proxy: "ripple", url: proxyUrl },
    problems: [],
  });
});

test("doctor: a phone host whose Claude Code CLI has no login is named, with the fix (issue #71)", async () => {
  const { home, proxyUrl, settings } = scratch({ listen: { host: "127.0.0.1", port: 18791 } });
  fs.writeFileSync(settings, JSON.stringify({ env: { HTTPS_PROXY: proxyUrl } }));
  const { ops } = fakeSupervisor({});
  const noLogin = async () => ({ ok: false, where: "no Claude Code login" });
  const d = await doctor({ home, version: "1.0.0", supervisor: ops, routerStatus: answering("1.0.0"), remoteHostInstalled: () => true, claudeLogin: noLogin });
  const problem = d.problems.find((p) => p.code === "cli-not-logged-in");
  assert.ok(problem, d.problems.map((p) => p.code).join());
  assert.match(problem!.message, /\/login/);

  // With a login of its own, nothing is said about one.
  const loggedIn = await doctor({ home, version: "1.0.0", supervisor: ops, routerStatus: answering("1.0.0"), remoteHostInstalled: () => true, claudeLogin: async () => ({ ok: true, where: "the macOS keychain" }) });
  assert.equal(loggedIn.problems.some((p) => p.code === "cli-not-logged-in"), false);

  // Without the phone host, a missing CLI login is nobody's problem.
  const noHost = await doctor({ home, version: "1.0.0", supervisor: ops, routerStatus: answering("1.0.0"), remoteHostInstalled: () => false, claudeLogin: noLogin });
  assert.equal(noHost.problems.some((p) => p.code === "cli-not-logged-in"), false);
});

// ---- repair ------------------------------------------------------------------------------

test("repair re-registers a plist whose program is gone, starts it and waits for it to answer; settings untouched", async () => {
  const { home, settings, proxyUrl } = scratch();
  const original = JSON.stringify({ env: { HTTPS_PROXY: proxyUrl, NODE_EXTRA_CA_CERTS: path.join(home, "ca.pem"), KEEP: "1" }, model: "opus" });
  fs.writeFileSync(settings, original);
  fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
  fs.writeFileSync(plistPath(), renderPlist({ program: "/gone/node", args: ["/gone/index.js"], home, stdoutLog: path.join(home, "logs", "launchd.log") }));
  const rt = fakeRuntime(path.join(root, "rt-repair"));
  const reg = registration(rt, home, "1.0.0");
  const lc = fakeLaunchctl({ loaded: true, running: false });
  const deps = {
    home,
    version: "1.0.0",
    supervisor: launchdSupervisor(reg, home, lc.run),
    routerStatus: async () => (lc.isRunning() ? { version: "1.0.0" } : null),
    sleep: noSleep,
    healthBudgetMs: 2_000,
    remoteHostInstalled: () => false,
  };
  const r = await repair(deps);
  assert.deepEqual(r.steps.map((s) => [s.name, s.ok]), [["supervisor", true], ["start", true], ["health", true]]);
  assert.equal(r.ok, true);
  assert.deepEqual(plistProgramArguments(fs.readFileSync(plistPath(), "utf8")), [rt.node, rt.router]);
  assert.ok(lc.calls.some((c) => c[0] === "bootstrap" && c[2] === plistPath()));
  assert.ok(plistPath().startsWith(root) && plistPath().endsWith(`${label}.plist`));
  assert.equal(r.doctor.router.responding, true);
  assert.equal(r.doctor.supervisor.programExists, true);
  assert.deepEqual(r.doctor.problems, []);
  assert.equal(fs.readFileSync(settings, "utf8"), original);

  // Idempotent: a second run registers nothing.
  const before = lc.calls.length;
  const again = await repair(deps);
  assert.equal(again.ok, true);
  assert.equal(again.steps[0]!.detail, "already registered for this installation");
  assert.ok(lc.calls.slice(before).every((c) => c[0] === "print"));
});

test("doctor and repair accept the shared router/tray launcher after a package version update", async () => {
  const { home } = scratch();
  const rt = { ...fakeRuntime(path.join(root, "rt-shared-bundle")), packaged: false };
  const reg = registration(rt, home, "1.0.0", "darwin", null);
  assert.ok(reg.bundle);
  let signed = 0;
  writeBundle({ home, ...reg.bundle }, () => { signed++; });
  fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
  fs.writeFileSync(plistPath(), renderPlist({ ...reg, home, stdoutLog: path.join(home, "logs", "launchd.log") }));
  const lc = fakeLaunchctl({ loaded: true, running: true });
  const updated = registration(rt, home, "2.0.0", "darwin", null);
  const supervisor = launchdSupervisor(updated, home, lc.run);
  assert.equal(supervisor.inspect().current, true);
  assert.equal(supervisor.inspect().programExists, true);
  const result = await repair({ home, version: "2.0.0", supervisor, routerStatus: answering("2.0.0"), sleep: noSleep, remoteHostInstalled: () => false });
  assert.equal(result.ok, true);
  assert.equal(result.steps[0]!.detail, "already registered for this installation");
  assert.ok(lc.calls.every(call => call[0] === "print"));
  assert.equal(signed, 1);
});

test("repair leaves a router that answers alone even when its entry names another installation", async () => {
  const { home } = scratch();
  const { ops, calls } = fakeSupervisor({ current: false, program: process.execPath });
  const r = await repair({ home, version: "1.0.0", supervisor: ops, routerStatus: answering("1.0.0"), sleep: noSleep, remoteHostInstalled: () => false });
  assert.deepEqual(calls, []);
  assert.equal(r.ok, true);
  assert.match(r.steps[0]!.detail, /left as it is/);
});

test("repair reports a router that never comes up, and a supervisor that cannot register", async () => {
  const { home } = scratch();
  const { ops } = fakeSupervisor({ registered: false, state: "not-loaded" }, { register: () => { throw new Error("launchctl bootstrap failed: 5"); }, start: "failed" });
  const r = await repair({ home, version: "1.0.0", supervisor: ops, routerStatus: silent, sleep: noSleep, healthBudgetMs: 0, remoteHostInstalled: () => false });
  assert.equal(r.ok, false);
  assert.deepEqual(r.steps.map((s) => [s.name, s.ok]), [["supervisor", false], ["start", false], ["health", false]]);
  assert.match(r.steps[0]!.detail, /bootstrap failed/);
});

test("repair without an installation says so and does nothing", async () => {
  const { home } = scratch(null);
  const { ops, calls } = fakeSupervisor({ registered: false });
  const r = await repair({ home, version: "1.0.0", supervisor: ops, routerStatus: silent, sleep: noSleep, remoteHostInstalled: () => false });
  assert.equal(r.ok, false);
  assert.deepEqual(r.steps.map((s) => s.name), ["config"]);
  assert.deepEqual(calls, []);
  assert.ok(r.doctor.problems.some((p) => p.code === "not-installed"));
});

test("repair moves Claude settings that are ours on an old port, and only those", async () => {
  const { home, settings, proxyUrl, ca } = scratch();
  fs.writeFileSync(settings, JSON.stringify({ env: { HTTPS_PROXY: "http://127.0.0.1:9999", NODE_EXTRA_CA_CERTS: ca, KEEP: "1" }, model: "opus" }));
  applyAppProxy("http://127.0.0.1:9999");
  const { ops } = fakeSupervisor({});
  const r = await repair({ home, version: "1.0.0", supervisor: ops, routerStatus: answering("1.0.0"), sleep: noSleep, remoteHostInstalled: () => false });
  assert.ok(r.steps.some((s) => s.name === "cli-proxy" && s.ok));
  assert.ok(r.steps.some((s) => s.name === "desktop-proxy" && s.ok));
  const s = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.deepEqual(s, { env: { HTTPS_PROXY: proxyUrl, NODE_EXTRA_CA_CERTS: ca, KEEP: "1" }, model: "opus" });
  assert.equal(currentAppProxy().egressProxyUrl, proxyUrl);

  // A proxy with someone else's CA is not ours, whatever its port.
  const foreign = JSON.stringify({ env: { HTTPS_PROXY: "http://127.0.0.1:3128", NODE_EXTRA_CA_CERTS: "/corp.pem" } });
  fs.writeFileSync(settings, foreign);
  const r2 = await repair({ home, version: "1.0.0", supervisor: ops, routerStatus: answering("1.0.0"), sleep: noSleep, remoteHostInstalled: () => false });
  assert.equal(fs.readFileSync(settings, "utf8"), foreign);
  assert.ok(r2.doctor.problems.some((p) => p.code === "cli-foreign-proxy"));
});

// ---- direct on / off ---------------------------------------------------------------------

function meta(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(configLibraryDir(), "_meta.json"), "utf8"));
}

function directSetup() {
  const ctx = scratch({ listen: { host: "127.0.0.1", port: 18791 }, picker: { enabled: true }, cli: { extraModels: [], models: { smallFast: "deepseek-v4.1-flash" } } });
  // An entry the user had before picker mode, which our entry replaced and remembered.
  fs.mkdirSync(configLibraryDir(), { recursive: true });
  fs.writeFileSync(path.join(configLibraryDir(), "prev.json"), JSON.stringify({ egressProxyUrl: "http://corp:3128" }));
  fs.writeFileSync(path.join(configLibraryDir(), "_meta.json"), JSON.stringify({ appliedId: "prev", other: true }));
  applyAppProxy(ctx.proxyUrl);
  const settingsObj = {
    env: { HTTPS_PROXY: ctx.proxyUrl, NODE_EXTRA_CA_CERTS: ctx.ca, ANTHROPIC_SMALL_FAST_MODEL: "deepseek-v4.1-flash", ANTHROPIC_MODEL: "claude-opus-5-5", CLAUDE_CODE_PLUGIN_DIRS: "/mod", KEEP: "1" },
    model: "opus",
    hooks: { PreToolUse: [{ matcher: "Agent|Task", _clauderipple: "agent-title" }] },
  };
  fs.writeFileSync(ctx.settings, JSON.stringify(settingsObj, null, 2));
  return { ...ctx, settingsObj };
}

test("direct on then off: only our values leave, other keys stay, and everything comes back exactly", async () => {
  const ctx = directSetup();
  const ourEntry = currentAppProxy().appliedId;
  const on = directOn(ctx.home);
  assert.equal(on.ok, true);
  assert.equal(on.restartClaude, true);
  assert.equal(on.mode, "direct");
  const s = JSON.parse(fs.readFileSync(ctx.settings, "utf8"));
  // Claude's own model choice, the mod and unrelated keys stay; the routed slot goes with the proxy.
  assert.deepEqual(s, { ...ctx.settingsObj, env: { ANTHROPIC_MODEL: "claude-opus-5-5", CLAUDE_CODE_PLUGIN_DIRS: "/mod", KEEP: "1" } });
  assert.equal(meta().appliedId, "prev", "the entry picker mode replaced is applied again");
  assert.equal(meta().other, true);
  assert.equal(fs.existsSync(path.join(configLibraryDir(), `${ourEntry}.json`)), false);
  const saved = JSON.parse(fs.readFileSync(directStatePath(ctx.home), "utf8"));
  assert.deepEqual(saved.cli, { HTTPS_PROXY: ctx.proxyUrl, NODE_EXTRA_CA_CERTS: ctx.ca, ANTHROPIC_SMALL_FAST_MODEL: "deepseek-v4.1-flash" });
  assert.deepEqual(saved.desktop, { egressProxyUrl: ctx.proxyUrl, appliedAfter: "prev" });

  // Twice is harmless and keeps what the first one saved.
  const again = directOn(ctx.home);
  assert.match(again.detail, /already/);
  assert.deepEqual(JSON.parse(fs.readFileSync(directStatePath(ctx.home), "utf8")).cli, saved.cli);

  const { ops, calls } = fakeSupervisor({});
  const off = await directOff({ home: ctx.home, version: "1.0.0", supervisor: ops, routerStatus: answering("1.0.0"), sleep: noSleep, remoteHostInstalled: () => false });
  assert.equal(off.ok, true, off.detail);
  assert.equal(off.mode, "ripple");
  assert.deepEqual(calls, [], "a router that answers is not repaired");
  assert.deepEqual(JSON.parse(fs.readFileSync(ctx.settings, "utf8")), ctx.settingsObj);
  const ap = currentAppProxy();
  assert.equal(ap.ours, true);
  assert.equal(ap.egressProxyUrl, ctx.proxyUrl);
  assert.equal((meta().clauderipple as { previousAppliedId: string }).previousAppliedId, "prev");
  assert.equal(fs.existsSync(directStatePath(ctx.home)), false);
});

test("direct off restores the current configured port, not the saved port", async () => {
  const ctx = directSetup();
  directOn(ctx.home);
  const file = path.join(ctx.home, "config.json");
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  cfg.listen.port = 19991;
  fs.writeFileSync(file, JSON.stringify(cfg));
  const { ops } = fakeSupervisor({});
  const checked: string[] = [];
  const result = await directOff({ home: ctx.home, version: "1.0.0", supervisor: ops, routerStatus: async (url) => { checked.push(url); return { version: "1.0.0" }; } });
  assert.equal(result.ok, true, result.detail);
  assert.deepEqual(checked, ["http://127.0.0.1:19992"]);
  assert.equal(JSON.parse(fs.readFileSync(ctx.settings, "utf8")).env.HTTPS_PROXY, "http://127.0.0.1:19991");
  assert.equal(currentAppProxy().egressProxyUrl, "http://127.0.0.1:19991");
});

test("direct off refuses a proxy set in the meantime unless forced", async () => {
  const ctx = directSetup();
  directOn(ctx.home);
  const s = JSON.parse(fs.readFileSync(ctx.settings, "utf8"));
  s.env.HTTPS_PROXY = "http://corp:8080";
  const foreign = JSON.stringify(s);
  fs.writeFileSync(ctx.settings, foreign);
  const { ops } = fakeSupervisor({});
  const deps = { home: ctx.home, version: "1.0.0", supervisor: ops, routerStatus: answering("1.0.0"), sleep: noSleep, remoteHostInstalled: () => false };
  const refused = await directOff(deps);
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /http:\/\/corp:8080.*--force/);
  assert.equal(fs.readFileSync(ctx.settings, "utf8"), foreign);
  assert.equal(fs.existsSync(directStatePath(ctx.home)), true);

  const forced = await directOff(deps, { force: true });
  assert.equal(forced.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(ctx.settings, "utf8")).env.HTTPS_PROXY, ctx.proxyUrl);
});

test("direct off refuses a Claude Desktop proxy entry applied in the meantime", async () => {
  const ctx = directSetup();
  directOn(ctx.home);
  fs.writeFileSync(path.join(configLibraryDir(), "vpn.json"), JSON.stringify({ egressProxyUrl: "http://vpn:1080" }));
  fs.writeFileSync(path.join(configLibraryDir(), "_meta.json"), JSON.stringify({ ...meta(), appliedId: "vpn" }));
  const { ops } = fakeSupervisor({});
  const r = await directOff({ home: ctx.home, version: "1.0.0", supervisor: ops, routerStatus: answering("1.0.0"), sleep: noSleep, remoteHostInstalled: () => false });
  assert.equal(r.ok, false);
  assert.match(r.detail, /vpn:1080/);
  assert.equal(meta().appliedId, "vpn");
});

test("direct off repairs a router that is down first, and changes nothing when it stays down", async () => {
  const ctx = directSetup();
  directOn(ctx.home);
  const afterOn = fs.readFileSync(ctx.settings, "utf8");
  const { ops, calls } = fakeSupervisor({ state: "loaded" }, { start: "started" });
  const r = await directOff({ home: ctx.home, version: "1.0.0", supervisor: ops, routerStatus: silent, sleep: noSleep, healthBudgetMs: 0 });
  assert.equal(r.ok, false);
  assert.match(r.detail, /not answering even after a repair/);
  assert.deepEqual(calls, ["start"]);
  assert.equal(fs.readFileSync(ctx.settings, "utf8"), afterOn);
  assert.equal(meta().appliedId, "prev");

  let up = false;
  const { ops: ops2 } = fakeSupervisor({ state: "loaded" }, { start: "started" });
  const r2 = await directOff({ home: ctx.home, version: "1.0.0", supervisor: { ...ops2, start: () => ((up = true), "started") }, routerStatus: async () => (up ? { version: "1.0.0" } : null), sleep: noSleep });
  assert.equal(r2.ok, true, r2.detail);
  assert.match(r2.detail, /repaired it first/);
  assert.deepEqual(JSON.parse(fs.readFileSync(ctx.settings, "utf8")), ctx.settingsObj);
});

test("Windows PowerShell launcher files carry a UTF-8 BOM and preserve Korean paths", () => {
  const { home } = scratch();
  const rt = { ...fakeRuntime(path.join(root, "홍길동", "runtime")), packaged: false };
  const router = writeLauncher({ home, program: rt.node, args: [rt.router] });
  installLauncher({ rt, home, version: "1", platform: "win32", powershell: () => "" });
  for (const file of [router, path.join(home, "clauderipple-tray.ps1")]) {
    const bytes = fs.readFileSync(file);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.ok(bytes.subarray(3).toString("utf8").includes("홍길동"));
  }
});

// ---- app launcher ------------------------------------------------------------------------

test("macOS launcher: a minimal bundle in the overridden Applications dir that runs `tray --ensure`", () => {
  const { home } = scratch();
  const rt = { ...fakeRuntime(path.join(root, "rt-app")), packaged: false };
  const r = installLauncher({ rt, home, version: "1.2.3", platform: "darwin" });
  assert.equal(r.ok, true);
  const app = path.join(process.env.CLAUDERIPPLE_LAUNCHER_DIR!, "ClaudeRipple.app");
  assert.deepEqual(r.paths, [app]);
  const plist = fs.readFileSync(path.join(app, "Contents", "Info.plist"), "utf8");
  assert.match(plist, new RegExp(`<key>CFBundleIdentifier</key><string>${LAUNCHER_BUNDLE_ID.replace(/\./g, "\\.")}</string>`));
  assert.doesNotMatch(plist, /com\.clauderipple\.router/);
  const exe = path.join(app, "Contents", "MacOS", "ClaudeRipple");
  if (posixModes) assert.equal(fs.statSync(exe).mode & 0o111, 0o111);
  const script = fs.readFileSync(exe, "utf8");
  assert.match(script, /^#!\/bin\/sh/);
  assert.ok(script.includes(`export CLAUDERIPPLE_HOME='${home}'`));
  assert.ok(script.includes(`'${rt.node}' '${rt.cli}' tray --ensure`));

  // Someone else's bundle under the same name is never written into or removed.
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), "<key>CFBundleIdentifier</key><string>com.clauderipple.app</string>");
  assert.equal(installLauncher({ rt, home, version: "1.2.3", platform: "darwin" }).ok, false);
  assert.equal(uninstallLauncher({ rt, home, version: "1.2.3", platform: "darwin" }).ok, false);
  assert.ok(fs.existsSync(app));
  fs.rmSync(app, { recursive: true });

  installLauncher({ rt, home, version: "1.2.3", platform: "darwin" });
  assert.deepEqual(uninstallLauncher({ rt, home, version: "1.2.3", platform: "darwin" }).paths, [app]);
  assert.equal(fs.existsSync(app), false);
});

test("Linux launcher: a desktop entry; Windows: shortcuts through a hidden PowerShell launcher", () => {
  const { home } = scratch();
  const rt = { ...fakeRuntime(path.join(root, "rt-app2")), packaged: false };
  const linux = installLauncher({ rt, home, version: "1", platform: "linux" });
  const entry = fs.readFileSync(linux.paths[0]!, "utf8");
  assert.ok(linux.paths[0]!.startsWith(root));
  assert.match(entry, /^Exec=env "CLAUDERIPPLE_HOME=.*" ".*" ".*cli-index\.js" tray --ensure$/m);
  assert.equal(uninstallLauncher({ rt, home, version: "1", platform: "linux" }).paths.length, 1);

  const scripts: string[] = [];
  const powershell = (s: string) => {
    scripts.push(s);
    return `${path.join(process.env.CLAUDERIPPLE_LAUNCHER_DIR!, "Start Menu", "ClaudeRipple.lnk")}\r\n`;
  };
  const win = installLauncher({ rt, home, version: "1", platform: "win32", powershell });
  assert.equal(win.ok, true);
  assert.match(scripts[0]!, /WScript\.Shell/);
  assert.match(scripts[0]!, /conhost\.exe/);
  assert.ok(scripts[0]!.includes(path.join(process.env.CLAUDERIPPLE_LAUNCHER_DIR!, "Desktop", "ClaudeRipple.lnk")));
  assert.match(fs.readFileSync(path.join(home, "clauderipple-tray.ps1"), "utf8"), /tray --ensure/);

  assert.deepEqual(installLauncher({ rt: { ...rt, packaged: true }, home, version: "1", platform: "darwin" }).paths, []);
});

// ---- the CLI itself, end to end (macOS only: a fake launchctl stands in for launchd) -------

test("CLI: doctor, direct on/off and app print one JSON object each and exit 0", { skip: os.type() !== "Darwin" }, async () => {
  const ctx = directSetup();
  const calls = path.join(root, "e2e-launchctl.log");
  const fake = path.join(root, "e2e-launchctl");
  fs.writeFileSync(fake, `#!/bin/sh\necho "$*" >> "${calls}"\nexit 113\n`, { mode: 0o755 });
  // A stand-in for the admin API on a free port, so direct off finds a router and repairs nothing.
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ version: "0.0.0-test" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const adminPort = (server.address() as { port: number }).port;
  const cfg = JSON.parse(fs.readFileSync(path.join(ctx.home, "config.json"), "utf8"));
  fs.writeFileSync(path.join(ctx.home, "config.json"), JSON.stringify({ ...cfg, admin: { port: adminPort } }));
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDERIPPLE_HOME: ctx.home, CLAUDERIPPLE_LAUNCHCTL: fake };
  delete env.NODE_OPTIONS;
  const cli = path.resolve(import.meta.dirname, "../src/index.ts");
  const run = async (...a: string[]) => {
    const r = await promisify(execFile)(process.execPath, [cli, ...a, "--json"], { env, timeout: 60_000 });
    return JSON.parse(r.stdout) as Record<string, unknown>;
  };
  try {
    const d = await run("doctor");
    assert.equal(d.mode, "ripple");
    assert.equal((d.router as { responding: boolean }).responding, true);
    assert.equal((d.supervisor as { registered: boolean }).registered, false);
    const on = await run("direct", "on");
    assert.deepEqual([on.ok, on.mode, on.restartClaude], [true, "direct", true]);
    const off = await run("direct", "off");
    assert.deepEqual([off.ok, off.mode], [true, "ripple"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(ctx.settings, "utf8")), ctx.settingsObj);
    const app = await run("app", "--install");
    assert.equal(app.ok, true);
    assert.ok((app.paths as string[]).every((p) => p.startsWith(root)));
  } finally {
    server.close();
  }
  const used = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n") : [];
  assert.ok(used.length > 0 && used.every((l) => l.startsWith("print ") && l.endsWith(`/${label}`)), used.join("\n"));
});
