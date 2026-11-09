import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { renderUnit, unitName, unitPath, unitOwnership, installAgent, startAgent, restartAgent, stopAgent, removeAgent, agentState } from "../src/systemd.ts";
import { desktopClaudeCodeDirs, latestDesktopClaude } from "../src/claude-auth.ts";
import { configLibraryDir } from "../src/picker.ts";

const cli = path.resolve(import.meta.dirname, "../src/index.ts");
// A parent can spoof process.platform for cross-platform tests, but execFile starts a native
// child: on macOS that would run the real launchd installer against the user's live agent.
const notLinux = os.type() !== "Linux";
const onWindows = process.platform === "win32";

/** Runs `fn` with XDG_CONFIG_HOME in a scratch dir and a fake `systemctl` first on PATH, then puts everything back. */
async function withFakeSystemd(script: string, fn: (ctx: { root: string; calls: () => string[][] }) => Promise<void> | void): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-systemd-"));
  const keys = ["XDG_CONFIG_HOME", "CLAUDERIPPLE_SYSTEMD_UNIT", "PATH", "CR_TEST_CALLS", "CR_TEST_STATE"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "systemctl"), `#!${process.execPath}\n${script}`, { mode: 0o755 });
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  process.env.CR_TEST_CALLS = path.join(root, "calls.jsonl");
  process.env.CR_TEST_STATE = path.join(root, "state");
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ""}`;
  delete process.env.CLAUDERIPPLE_SYSTEMD_UNIT;
  try {
    const calls = () =>
      fs.existsSync(process.env.CR_TEST_CALLS!)
        ? fs.readFileSync(process.env.CR_TEST_CALLS!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[])
        : [];
    await fn({ root, calls });
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// A user manager that records every call and keeps "active" in a state file.
const WORKING_SYSTEMCTL = `const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CR_TEST_CALLS, JSON.stringify(args) + "\\n");
if (args[0] !== "--user") process.exit(90);
const up = fs.existsSync(process.env.CR_TEST_STATE);
if (args[1] === "show") console.log(args.includes("--property=MainPID") ? (up ? "4242" : "0") : up ? "active" : "inactive");
if (args[1] === "start" || args[1] === "restart") fs.writeFileSync(process.env.CR_TEST_STATE, "up");
if (args[1] === "stop" || args[1] === "disable") fs.rmSync(process.env.CR_TEST_STATE, { force: true });
`;

test("the unit keeps arguments intact and escapes what systemd would expand", () => {
  const unit = renderUnit({ program: "/opt/Claude Ripple/node", args: ['/tmp/100%/$USER/q".ts'], home: "/tmp/state dir", env: { ELECTRON_RUN_AS_NODE: "1" } });
  // %U is a specifier and $USER an environment substitution in ExecStart; both must reach the router literally.
  assert.ok(unit.includes('ExecStart="/opt/Claude Ripple/node" "/tmp/100%%/$$USER/q\\".ts"'), unit);
  assert.match(unit, /^Environment="CLAUDERIPPLE_HOME=\/tmp\/state dir"$/m);
  assert.match(unit, /^Environment="ELECTRON_RUN_AS_NODE=1"$/m);
  assert.throws(() => renderUnit({ program: "node", home: "/tmp" }), /absolute/);
  assert.throws(() => renderUnit({ program: "/node", home: "/tmp\nExecStart=/evil" }), /newlines/);
  assert.throws(() => renderUnit({ program: "/node", home: "/tmp", env: { "A B": "1" } }), /environment name/);
});

test("the unit restarts a self-exit forever and gives SIGTERM the whole drain", () => {
  const unit = renderUnit({ program: "/usr/bin/node", home: "/tmp" });
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^RestartSec=2$/m);
  assert.match(unit, /^StartLimitIntervalSec=0$/m);
  assert.match(unit, /^KillMode=mixed$/m);
  // The router drains for up to 90s on SIGTERM (ARCHITECTURE §5); systemd's default is 90s flat.
  assert.match(unit, /^TimeoutStopSec=120$/m);
  assert.match(unit, /^WantedBy=default.target$/m);
});

test("the unit name override cannot leave the user unit directory", () => {
  const saved = process.env.CLAUDERIPPLE_SYSTEMD_UNIT;
  try {
    process.env.CLAUDERIPPLE_SYSTEMD_UNIT = "../foreign.service";
    assert.throws(unitName, /invalid/);
  } finally {
    if (saved === undefined) delete process.env.CLAUDERIPPLE_SYSTEMD_UNIT;
    else process.env.CLAUDERIPPLE_SYSTEMD_UNIT = saved;
  }
});

test("per-user lifecycle: start is idempotent, restart is one systemctl restart, uninstall removes the unit", { skip: onWindows }, () =>
  withFakeSystemd(WORKING_SYSTEMCTL, ({ calls }) => {
    const file = installAgent({ program: process.execPath, args: ["/tmp/router.ts"], home: "/tmp/home" });
    assert.equal(file, unitPath());
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(agentState(), "loaded");
    assert.equal(startAgent("/tmp/home"), "started");
    assert.equal(startAgent("/tmp/home"), "already-running");
    // A running unit is only stopped when its own id proves it is this installation's.
    const ours = () => "ours" as const;
    assert.equal(restartAgent("/tmp/home", {}, undefined, ours), "drained");
    assert.equal(stopAgent("/tmp/home", {}, undefined, ours), "stopped");
    assert.equal(removeAgent("/tmp/home", undefined, ours), "removed");
    assert.equal(fs.existsSync(file), false);
    assert.equal(removeAgent("/tmp/home"), "absent");
    const verbs = calls().map((a) => a.slice(1).join(" "));
    assert.ok(calls().every((a) => a[0] === "--user"), "never the system manager");
    assert.equal(verbs.filter((v) => v === "start clauderipple.service").length, 1);
    assert.ok(verbs.includes("enable clauderipple.service"));
    assert.ok(verbs.includes("disable --now clauderipple.service"));
  }));

test("install refuses to overwrite a unit that is not ClaudeRipple's", { skip: onWindows }, () =>
  withFakeSystemd(WORKING_SYSTEMCTL, () => {
    fs.mkdirSync(path.dirname(unitPath()), { recursive: true });
    fs.writeFileSync(unitPath(), "[Unit]\nDescription=something else\n");
    assert.throws(() => installAgent({ program: process.execPath, home: "/tmp/home" }), /not ClaudeRipple's/);
    assert.equal(fs.readFileSync(unitPath(), "utf8"), "[Unit]\nDescription=something else\n");
  }));

test("an unreadable unit is unknown, so install refuses to replace it", { skip: onWindows }, () =>
  withFakeSystemd(WORKING_SYSTEMCTL, () => {
    fs.mkdirSync(path.dirname(unitPath()), { recursive: true });
    fs.writeFileSync(unitPath(), renderUnit({ program: process.execPath, home: "/tmp/other" }), { mode: 0o600 });
    fs.chmodSync(unitPath(), 0o000);
    try {
      assert.deepEqual(unitOwnership("/tmp/home"), { state: "unknown", home: null });
      assert.throws(() => installAgent({ program: process.execPath, home: "/tmp/home" }, () => ({ ok: true, out: "" })), /EACCES|읽지 못해/);
    } finally {
      fs.chmodSync(unitPath(), 0o600);
      fs.rmSync(unitPath(), { force: true });
    }
  }));

test("the replacement is waited for before its identity is judged", { skip: onWindows }, () =>
  // The same race as launchd's 2026-10-26 report: `systemctl restart` returns before the new
  // MainPID has opened its admin port, so a single probe answered "absent".
  withFakeSystemd(WORKING_SYSTEMCTL, () => {
    installAgent({ program: process.execPath, args: ["/tmp/router.ts"], home: "/tmp/home" });
    assert.equal(startAgent("/tmp/home"), "started");
    const restartWith = (answers: Array<"ours" | "other" | "absent">, budgetMs: number) => {
      const pending = [...answers];
      let clock = 0;
      return restartAgent("/tmp/home", { identityWait: { budgetMs, pollMs: 10, now: () => clock, sleep: (ms) => { clock += ms; } } }, undefined, () => (pending.length > 1 ? pending.shift()! : pending[0]!));
    };
    // "ours" before the drain, then the successor is still starting, then it answers.
    assert.equal(restartWith(["ours", "absent", "absent", "ours"], 1_000), "drained");
    assert.equal(restartWith(["ours", "absent"], 20), "identity-unknown");
    assert.equal(restartWith(["ours", "other", "ours"], 1_000), "other-installation");
  }));

test("Linux finds the Desktop-cached CLI and the Config Library under XDG_CONFIG_HOME", { skip: notLinux }, () =>
  withFakeSystemd(WORKING_SYSTEMCTL, ({ root }) => {
    const config = path.join(root, "config");
    assert.equal(unitPath(), path.join(config, "systemd", "user", "clauderipple.service"));
    assert.equal(configLibraryDir(), path.join(config, "Claude-3p", "configLibrary"));
    const [dir] = desktopClaudeCodeDirs();
    assert.equal(dir, path.join(config, "Claude", "claude-code"));
    for (const v of ["2.1.9", "2.1.280"]) {
      fs.mkdirSync(path.join(dir!, v), { recursive: true });
      fs.writeFileSync(path.join(dir!, v, "claude"), "", { mode: 0o755 });
    }
    assert.equal(latestDesktopClaude(), path.join(dir!, "2.1.280", "claude"));
  }));

async function freePort(): Promise<number> {
  const s = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

/** Runs `clauderipple install` against scratch state; resolves with the exit code and output. */
async function runInstall(root: string, settings: string, port: number): Promise<{ code: number; out: string }> {
  if (notLinux) throw new Error("systemd install tests require a Linux host; refusing to touch the native supervisor");
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDERIPPLE_HOME: path.join(root, "ripple"), CLAUDE_SETTINGS_PATH: settings, CLAUDERIPPLE_LAUNCHER_DIR: path.join(root, "launcher") };
  delete env.NODE_OPTIONS;
  try {
    const r = await promisify(execFile)(process.execPath, [cli, "install", "--port", String(port)], { env, timeout: 60_000 });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const ORIGINAL_SETTINGS = '{"env":{"KEEP_ME":"keep"},"model":"opus"}\n';

test("a non-Linux host cannot launch the systemd installer", { skip: !notLinux }, async () => {
  await assert.rejects(runInstall("/unused", "/unused/settings.json", 1), /require a Linux host/);
});

test("no user manager: install fails before registering anything and settings.json is untouched", { skip: notLinux }, () =>
  withFakeSystemd(`process.stderr.write("Failed to connect to bus: No medium found\\n"); process.exit(1);`, async ({ root }) => {
    const settings = path.join(root, "settings.json");
    fs.writeFileSync(settings, ORIGINAL_SETTINGS);
    const r = await runInstall(root, settings, await freePort());
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /No medium found/);
    assert.equal(fs.readFileSync(settings, "utf8"), ORIGINAL_SETTINGS);
    assert.equal(fs.existsSync(unitPath()), false);
  }));

test("router never answers: install exits 1 and leaves settings.json exactly as it was", { skip: notLinux, timeout: 60_000 }, () =>
  // The fake manager "starts" the service without running anything, so the probe finds nothing listening.
  withFakeSystemd(WORKING_SYSTEMCTL, async ({ root }) => {
    const settings = path.join(root, "settings.json");
    fs.writeFileSync(settings, ORIGINAL_SETTINGS);
    const r = await runInstall(root, settings, await freePort());
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /probe failed/);
    assert.match(r.out, /was left as it was/);
    assert.equal(fs.readFileSync(settings, "utf8"), ORIGINAL_SETTINGS);
    assert.equal(fs.readdirSync(root).filter((f) => f.includes(".bak-clauderipple")).length, 0, "not even a backup was needed");
  }));
