// The phone host is a second account-wide service, beside the router's. A main install's uninstall
// removes it only when its definition records that installation's home; a release check under its
// own home must leave the real one alone. An explicit request does not prove an unrecorded
// definition belongs to this installation (G-D01, 2026-10-25).
//
// Nothing here runs launchd, systemd or PowerShell: the definition is a string and removal is
// injected.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as windows from "../../cli/src/schtasks.ts";
import { hostServiceOwnership, installService, servicePaths, uninstallService, type HostServiceDeps } from "../src/host-service.ts";

const home = "/tmp/cr-host-install-a";
const other = "/tmp/cr-host-install-b";

const plist = (recorded: string | null): string => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>EnvironmentVariables</key>
  <dict>
${recorded === null ? "" : `    <key>CLAUDERIPPLE_HOME</key><string>${recorded}</string>`}
  </dict>
</dict>
</plist>
`;
const unit = (recorded: string | null): string => `[Unit]\nDescription=Ripple Remote host\n\n[Service]\nExecStart="/n" "/s"\n${recorded === null ? "" : `Environment="CLAUDERIPPLE_HOME=${recorded}"`}\n`;
const launcher = (recorded: string): string => `﻿# Ripple Remote host\r\n$env:CLAUDERIPPLE_HOME = '${recorded}'\r\n`;

test("macOS host removal propagates lookup and bootout failures without deleting the definition", async t => {
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), "cr-host-remove-"));
  t.after(() => fs.rmSync(userHome, { recursive: true, force: true }));
  const file = servicePaths("darwin", userHome).definition;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const failure of ["print", "bootout"]) {
    fs.writeFileSync(file, plist(home));
    await assert.rejects(uninstallService({ platform: "darwin", installationHome: home, userHome, launchctl: (_cmd, args) => ({ status: args[0] === failure ? 1 : 0, out: "permission denied" }) }), /보존했습니다/);
    assert.equal(fs.readFileSync(file, "utf8"), plist(home));
  }
});

test("host removal never treats a supervisor refusal string as success", async () => {
  let removed = false;
  await assert.rejects(uninstallService({ platform: "win32", installationHome: home, readDefinition: () => launcher(home), stop: () => "other-installation", removeDefinition: () => { removed = true; } }));
  assert.equal(removed, false);
});

test("Windows host start stop and remove consistently use the task runtime home and reject refusals", async t => {
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), "cr-host-windows-"));
  t.after(() => fs.rmSync(userHome, { recursive: true, force: true }));
  const p = servicePaths("win32", userHome);
  const spec = { node: "/node", script: "/host.ts", args: [], workingDir: userHome, log: p.log, env: { CLAUDERIPPLE_HOME: home } };
  let installed = false;
  let running = false;
  let refuse: "start" | "remove" | null = null;
  const taskDeps: windows.TaskDeps = {
    definition: () => installed ? { arguments: `-File "${path.join(p.runtime, "ClaudeRippleHost.ps1")}"` } : null,
    run: script => {
      if (script.includes(".State")) return { ok: true, out: running ? "Running" : "Ready" };
      if (script.includes("Register-ScheduledTask")) installed = true;
      if (script.includes("Start-ScheduledTask")) running = true;
      if (script.includes("Stop-ScheduledTask")) running = false;
      if (script.includes("Unregister-ScheduledTask")) installed = false;
      return { ok: true, out: "ok" };
    },
  };
  const task: NonNullable<HostServiceDeps["windows"]> = {
    ...windows,
    startAgent: (name, opts) => { assert.equal(opts?.home, p.runtime); return refuse === "start" ? "other-installation" : windows.startAgent(name, { ...opts, waitMs: 0 }); },
    stopAgent: (name, opts) => { assert.equal(opts?.home, p.runtime); return windows.stopAgent(name, opts); },
    removeAgent: (name, opts) => { assert.equal(opts?.home, p.runtime); return refuse === "remove" ? "ownership-unknown" : windows.removeAgent(name, opts); },
  };
  const deps: HostServiceDeps = { platform: "win32", installationHome: home, userHome, readDefinition: () => fs.existsSync(p.definition) ? fs.readFileSync(p.definition, "utf8") : null, windows: task, taskDeps, shutdown: async () => {}, waitForHost: async () => {} };
  await installService(spec, deps);
  assert.equal(running, true);
  await uninstallService({ ...deps, removeDefinition: () => {} });
  assert.equal(installed, false);
  refuse = "start";
  await assert.rejects(installService(spec, deps), /시작하지 못했습니다/);
  refuse = "remove";
  let removed = false;
  await assert.rejects(uninstallService({ ...deps, removeDefinition: () => { removed = true; } }), /제거하지 못했습니다/);
  assert.equal(removed, false);
});

test("host removal retains the definition replaced during asynchronous shutdown and holds its lock", async () => {
  let text = unit(home);
  let removed = false;
  let entered: (() => void) | undefined;
  let resume: (() => void) | undefined;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const release = new Promise<void>(resolve => { resume = resolve; });
  const deps: HostServiceDeps = { platform: "linux", installationHome: home, readDefinition: () => text, stop: async () => { entered?.(); await release; }, removeDefinition: () => { removed = true; } };
  const first = uninstallService(deps);
  await waiting;
  await assert.rejects(uninstallService(deps), /잠금/);
  text = unit(other);
  resume?.();
  await assert.rejects(first, /변경/);
  assert.equal(removed, false);
});

test("the host service records the installation home it was written for", () => {
  for (const [platform, text] of [["darwin", plist(home)], ["linux", unit(home)], ["win32", launcher(home)]] as const) {
    assert.equal(hostServiceOwnership(text, platform, home).state, "ours", platform);
    assert.equal(hostServiceOwnership(text, platform, other).state, "other", platform);
    assert.equal(hostServiceOwnership(text, platform, home).home, home);
  }
  // A definition that records no home is unknown, never absent: it is not this home's to remove.
  assert.equal(hostServiceOwnership(plist(null), "darwin", home).state, "unknown");
  assert.equal(hostServiceOwnership(unit(null), "linux", home).state, "unknown");
  assert.equal(hostServiceOwnership(null, "darwin", home).state, "absent");
});

test("uninstall removes this home's host service and preserves foreign or unknown definitions even when explicit", async () => {
  const calls: string[] = [];
  const deps = (text: string | null, extra: Record<string, unknown> = {}) => ({
    platform: "linux" as const,
    installationHome: home,
    readDefinition: () => text,
    stop: () => { calls.push("stop"); },
    removeDefinition: () => { calls.push("remove"); },
    ...extra,
  });
  assert.deepEqual(await uninstallService(deps(null)), ["no phone host service was installed"]);
  assert.deepEqual(calls, []);

  await assert.rejects(uninstallService(deps(unit(other))), /another ClaudeRipple installation/);
  assert.deepEqual(calls, [], "another installation's host is never stopped or removed");

  await assert.rejects(uninstallService(deps(unit(null))), /소유권/);
  assert.deepEqual(calls, [], "an unrecorded host is preserved, not guessed at");

  await assert.rejects(uninstallService({ ...deps(unit(null)), readDefinition: () => { throw new Error("permission denied"); } }), /could not be read/);
  assert.deepEqual(calls, []);

  const lines = await uninstallService(deps(unit(home)));
  assert.deepEqual(calls, ["stop", "remove"]);
  assert.match(lines[0]!, /removed .*clauderipple-host\.service/);

  calls.length = 0;
  await assert.rejects(uninstallService(deps(unit(null), { explicit: true })), /소유권/);
  assert.deepEqual(calls, [], "an explicit request is not proof of ownership");
});
