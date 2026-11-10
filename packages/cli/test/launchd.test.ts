import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type IdentityCheck, type Launchctl, installTrayAgent, plistPath, removeTrayAgent, renderPlist, renderTrayPlist, restartAgent, trayLaunchdLabel, trayPlistPath } from "../src/launchd.ts";
import type { RouterIdentity } from "../src/router-state.ts";
import { BUNDLE_ID, launcherPath } from "../src/bundle.ts";
import { plistProgramArguments } from "../src/registration.ts";

const base = { program: "/opt/ClaudeRipple.app/Contents/MacOS/ClaudeRipple", home: "/tmp/home", stdoutLog: "/tmp/home/logs/launchd.log" };

test("the agent starts at login and is kept alive", () => {
  const plist = renderPlist(base);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
});

test("ProcessType is Interactive, not throttled", () => {
  // Background (and an unset ProcessType) throttle CPU and I/O — launchd.plist(5). Claude Desktop
  // cannot reach anything at all until this proxy listens, so it must not be a throttled job.
  const plist = renderPlist(base);
  assert.match(plist, /<key>ProcessType<\/key><string>Interactive<\/string>/);
  assert.doesNotMatch(plist, /<string>Background<\/string>/);
});

test("program arguments and environment are escaped", () => {
  const plist = renderPlist({ ...base, args: ["/tmp/a&b.ts"], env: { X: "<y>" } });
  assert.match(plist, /<string>\/tmp\/a&amp;b\.ts<\/string>/);
  assert.match(plist, /<key>X<\/key><string>&lt;y&gt;<\/string>/);
  assert.match(plist, /<key>CLAUDERIPPLE_HOME<\/key><string>\/tmp\/home<\/string>/);
});

test("tray plist runs the shared signed bundle once in the Aqua session", () => {
  const home = "/isolated/a&b <state>";
  const plist = renderTrayPlist(home);
  assert.deepEqual(plistProgramArguments(plist), [launcherPath(home), "tray"]);
  assert.doesNotMatch(plist, /<key>KeepAlive<\/key>|<key>ThrottleInterval<\/key>/);
  if (process.platform === "darwin") {
    const data = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], { input: plist, encoding: "utf8" }));
    assert.deepEqual(data, {
      Label: trayLaunchdLabel(),
      ProgramArguments: [launcherPath(home), "tray"],
      AssociatedBundleIdentifiers: [BUNDLE_ID],
      EnvironmentVariables: { CLAUDERIPPLE_HOME: home },
      RunAtLoad: true,
      LimitLoadToSessionType: "Aqua",
      StandardOutPath: path.join(home, "logs", "launcher.log"),
      StandardErrorPath: path.join(home, "logs", "launcher.log"),
    });
  }
});

test("tray toggle only writes/removes the plist in the overridden directory and honors label overrides", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-tray-agent-"));
  const keys = ["CLAUDERIPPLE_LAUNCH_AGENTS_DIR", "CLAUDERIPPLE_LAUNCHD_LABEL", "CLAUDERIPPLE_TRAY_LAUNCHD_LABEL"] as const;
  const previous = keys.map(key => [key, process.env[key]] as const);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.CLAUDERIPPLE_LAUNCH_AGENTS_DIR = path.join(root, "LaunchAgents");
  process.env.CLAUDERIPPLE_LAUNCHD_LABEL = "com.clauderipple.isolated";
  delete process.env.CLAUDERIPPLE_TRAY_LAUNCHD_LABEL;
  assert.equal(trayLaunchdLabel(), "com.clauderipple.isolated.tray");
  process.env.CLAUDERIPPLE_TRAY_LAUNCHD_LABEL = "com.clauderipple.tray-test";
  const file = path.join(root, "LaunchAgents", "com.clauderipple.tray-test.plist");
  const home = path.join(root, "home");
  assert.equal(trayPlistPath(), file);
  assert.equal(removeTrayAgent(home), "absent");
  assert.equal(installTrayAgent(home), file);
  assert.equal(fs.readFileSync(file, "utf8"), renderTrayPlist(home));
  assert.equal(fs.statSync(path.join(home, "logs")).isDirectory(), true);
  assert.equal(installTrayAgent(home), file);
  assert.equal(removeTrayAgent(home), "removed");
  assert.equal(fs.existsSync(file), false);
  assert.equal(removeTrayAgent(home), "absent");
});

// ---- restart: the relaunched router answers a moment later (2026-10-26) ---------------------
//
// `clauderipple restart` reported "! not restarted: the running instance could not be verified as
// this installation's" for a restart that had worked: the old pid drained, launchd started a new
// one, and the one probe taken as soon as that pid appeared landed before the admin port answered.
// Every path here stays inside a temp LaunchAgents dir with an injected launchctl and identity.

/** The pid of a router the test may signal: its own process, reparented so its exit is observed. */
function shortLivedRouter(): number {
  const script = 'const c = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { detached: true, stdio: "ignore" }); c.unref(); console.log(c.pid)';
  return Number(execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }).trim());
}

/** The pid launchd reports after the drain. Never signalled: only its identity is asked. */
const RELAUNCHED_PID = 4_194_303;

async function relaunched(t: TestContext, answers: RouterIdentity[], budgetMs: number): Promise<{ result: string; asked: Array<number | null> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-relaunch-"));
  const keys = ["CLAUDERIPPLE_LAUNCH_AGENTS_DIR", "CLAUDERIPPLE_LAUNCHD_LABEL"] as const;
  const saved = keys.map((key) => [key, process.env[key]] as const);
  process.env.CLAUDERIPPLE_LAUNCH_AGENTS_DIR = path.join(dir, "LaunchAgents");
  process.env.CLAUDERIPPLE_LAUNCHD_LABEL = `com.clauderipple.relaunch-${crypto.randomBytes(4).toString("hex")}`;
  const home = path.join(dir, "home");
  fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
  fs.writeFileSync(plistPath(), renderPlist({ program: process.execPath, home, stdoutLog: path.join(home, "launchd.log") }));
  const draining = shortLivedRouter();
  t.after(() => {
    try { process.kill(draining, "SIGKILL"); } catch { /* already exited */ }
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // launchd reports the drained pid while it lives and the replacement once it is gone.
  const running = (): number => {
    try { process.kill(draining, 0); return draining; }
    catch { return RELAUNCHED_PID; }
  };
  const asked: Array<number | null> = [];
  const pending = [...answers];
  let clock = 0;
  const run: Launchctl = (args) => {
    assert.equal(args[0], "print", "an unverified restart never reaches a control operation");
    return { ok: true, out: `state = running\n\tpid = ${running()}\n` };
  };
  const identity: IdentityCheck = (expectedPid) => {
    asked.push(expectedPid);
    if (expectedPid === draining) return "ours";
    return pending.length > 1 ? pending.shift()! : pending[0]!;
  };
  // A virtual clock: the budget is spent by the sleeps, never by the test.
  const result = restartAgent(home, { waitMs: 5_000, identityWait: { budgetMs, pollMs: 10, now: () => clock, sleep: (ms) => { clock += ms; } } }, run, identity);
  return { result, asked };
}

const askedAboutRelaunched = (asked: Array<number | null>): number => asked.filter((pid) => pid === RELAUNCHED_PID).length;

test("restart waits for the relaunched router to answer instead of calling it unverifiable", async (t) => {
  const { result, asked } = await relaunched(t, ["absent", "absent", "ours"], 1_000);
  assert.equal(result, "drained");
  assert.equal(askedAboutRelaunched(asked), 3, "the two 'absent' answers were retried, then believed");
});

test("a relaunched router that never answers still is not this installation's", async (t) => {
  const { result, asked } = await relaunched(t, ["absent"], 30);
  assert.equal(result, "identity-unknown");
  assert.ok(askedAboutRelaunched(asked) > 1, "the budget was spent retrying");
});

test("another installation answering for the relaunched pid is refused without waiting", async (t) => {
  const { result, asked } = await relaunched(t, ["other", "ours"], 1_000);
  assert.equal(result, "other-installation");
  assert.equal(askedAboutRelaunched(asked), 1);
});
