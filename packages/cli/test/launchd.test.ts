import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installTrayAgent, removeTrayAgent, renderPlist, renderTrayPlist, trayLaunchdLabel, trayPlistPath } from "../src/launchd.ts";
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
  assert.equal(removeTrayAgent(), false);
  assert.equal(installTrayAgent(home), file);
  assert.equal(fs.readFileSync(file, "utf8"), renderTrayPlist(home));
  assert.equal(fs.statSync(path.join(home, "logs")).isDirectory(), true);
  assert.equal(installTrayAgent(home), file);
  assert.equal(removeTrayAgent(), true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(removeTrayAgent(), false);
});
