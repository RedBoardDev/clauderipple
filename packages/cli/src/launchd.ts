// macOS supervisor: a per-user launchd agent that keeps the router alive.
// KeepAlive + ThrottleInterval 2 means a self-exit (code 75) is followed by a fresh
// process two seconds later, which is the whole point of the health self-exit.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUNDLE_ID, launcherPath } from "./bundle.ts";

export const LABEL = "com.clauderipple.router";

/** Test-only override; production always uses com.clauderipple.router. */
export function launchdLabel(): string {
  return process.env.CLAUDERIPPLE_LAUNCHD_LABEL ?? LABEL;
}

/** Test-only override (CLAUDERIPPLE_LAUNCH_AGENTS_DIR); production always uses ~/Library/LaunchAgents. */
export function plistPath(): string {
  return agentPlistPath(launchdLabel());
}

function agentPlistPath(label: string): string {
  const dir = process.env.CLAUDERIPPLE_LAUNCH_AGENTS_DIR ?? path.join(os.homedir(), "Library", "LaunchAgents");
  return path.join(dir, `${label}.plist`);
}

export function trayLaunchdLabel(): string {
  return process.env.CLAUDERIPPLE_TRAY_LAUNCHD_LABEL
    ?? (process.env.CLAUDERIPPLE_LAUNCHD_LABEL ? `${launchdLabel()}.tray` : "com.clauderipple.tray");
}

export function trayPlistPath(): string {
  return agentPlistPath(trayLaunchdLabel());
}

/** macOS cannot launch an npm tray by opening its bare Electron bundle without a script. */
export function trayLoginItemDecision(opts: { platform: NodeJS.Platform; packaged: boolean; initialized: boolean; electronOpenAtLogin: boolean }): { removeElectronItem: boolean; enableAgent: boolean } | null {
  if (opts.platform !== "darwin" || opts.packaged) return null;
  return { removeElectronItem: opts.electronOpenAtLogin, enableAgent: !opts.initialized || opts.electronOpenAtLogin };
}

export function renderTrayPlist(home: string): string {
  const log = path.join(home, "logs", "launcher.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(trayLaunchdLabel())}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(launcherPath(home))}</string>
    <string>tray</string>
  </array>
  <key>AssociatedBundleIdentifiers</key>
  <array><string>${BUNDLE_ID}</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>CLAUDERIPPLE_HOME</key><string>${esc(home)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
</dict>
</plist>
`;
}

/** Next login only: never bootstrap, bootout or kickstart the tray's one-shot agent. */
export function installTrayAgent(home: string): string {
  const file = trayPlistPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.join(home, "logs"), { recursive: true });
  fs.writeFileSync(file, renderTrayPlist(home));
  return file;
}

export function removeTrayAgent(): boolean {
  try {
    fs.unlinkSync(trayPlistPath());
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderPlist(opts: { program: string; args?: string[]; bundleId?: string; home: string; stdoutLog: string; env?: Record<string, string> }): string {
  const args = opts.args ?? [];
  const env = { CLAUDERIPPLE_HOME: opts.home, ...(opts.env ?? {}) };
  const bundle = opts.bundleId
    ? `  <key>AssociatedBundleIdentifiers</key>
  <array>
    <string>${esc(opts.bundleId)}</string>
  </array>
`
    : "";
  const environment = Object.entries(env)
    .map(([key, value]) => `    <key>${esc(key)}</key><string>${esc(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${launchdLabel()}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(opts.program)}</string>
${args.map((arg) => `    <string>${esc(arg)}</string>`).join("\n")}
  </array>
${bundle}  <key>EnvironmentVariables</key>
  <dict>
${environment}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>2</integer>
  <key>ExitTimeOut</key><integer>120</integer>
  <!-- Interactive, not Background: launchd.plist(5) says Background jobs get their CPU and I/O
       bandwidth throttled, and an unset ProcessType still gets "light resource limits". In picker
       mode Claude Desktop sends *all* of its traffic through this proxy, so until it listens the
       app cannot reach anything at all — its responsiveness depends on us, which is exactly the
       case the man page reserves Interactive for. (2026-09-14: 26s from exec to listening after
       a reboot, with the app showing ERR_PROXY_CONNECTION_FAILED the whole time.) -->
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${esc(opts.stdoutLog)}</string>
  <key>StandardErrorPath</key><string>${esc(opts.stdoutLog)}</string>
</dict>
</plist>
`;
}

/** One launchctl invocation. Injectable so recovery tests never reach the real launchd. */
export type Launchctl = (args: string[]) => { ok: boolean; out: string };

/**
 * The real launchctl, with a timeout: the menu-bar app runs doctor/repair and must get an answer.
 * CLAUDERIPPLE_LAUNCHCTL is a test-only override naming a fake binary for end-to-end CLI tests.
 */
export const launchctl: Launchctl = (args) => {
  try {
    // bootout waits for the router to exit, and a router drains for up to 90s (ExitTimeOut 120):
    // that one call keeps a budget the drain fits in, so `stop` never reports a drain as a failure.
    const timeout = args[0] === "bootout" ? 150_000 : 20_000;
    const out = execFileSync(process.env.CLAUDERIPPLE_LAUNCHCTL ?? "launchctl", args, { stdio: ["ignore", "pipe", "pipe"], timeout }).toString();
    return { ok: true, out };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
    return { ok: false, out: `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`.trim() || (err.message ?? "launchctl failed") };
  }
};

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

export function installAgent(opts: { program: string; args?: string[]; bundleId?: string; home: string; env?: Record<string, string> }, run: Launchctl = launchctl): string {
  const file = plistPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stdoutLog = path.join(opts.home, "logs", "launchd.log");
  fs.mkdirSync(path.dirname(stdoutLog), { recursive: true });
  fs.writeFileSync(file, renderPlist({ ...opts, stdoutLog }));
  run(["bootout", domain(), file]); // ignore result: may not be loaded
  const r = run(["bootstrap", domain(), file]);
  if (!r.ok) throw new Error(`launchctl bootstrap failed: ${r.out}`);
  return file;
}

export function removeAgent(run: Launchctl = launchctl): boolean {
  const file = plistPath();
  if (!fs.existsSync(file)) return false;
  run(["bootout", domain(), file]);
  fs.unlinkSync(file);
  return true;
}

export function agentState(run: Launchctl = launchctl): "running" | "loaded" | "not-loaded" {
  const r = run(["print", `${domain()}/${launchdLabel()}`]);
  if (!r.ok) return "not-loaded";
  return /state = running/.test(r.out) ? "running" : "loaded";
}

/** `force` adds -k, which SIGKILLs a running instance ~5s after SIGTERM. Only restart wants that. */
export function kickstart(opts: { force?: boolean } = {}, run: Launchctl = launchctl): boolean {
  const args = ["kickstart", ...(opts.force ? ["-k"] : []), `${domain()}/${launchdLabel()}`];
  return run(args).ok;
}

/**
 * Idempotent start. A router that is already up (or still coming up) is left alone: `kickstart -k`
 * used to be the "Start Router" path, so pressing it while launchd was still bringing the router
 * up killed it and started the wait over (observed 2026-09-14: three runs in the four minutes
 * after login). Re-bootstraps the plist when the agent was unloaded by `clauderipple stop`.
 *
 * `kickstart` succeeding only means launchd accepted the request; a plist whose program is gone
 * fails after that, silently. So the pid is waited for, as on Windows (#80).
 */
export function startAgent(run: Launchctl = launchctl, opts: { waitMs?: number } = {}): "already-running" | "started" | "failed" {
  if (agentState(run) === "running") return "already-running";
  const budget = opts.waitMs ?? START_BUDGET_MS;
  if (kickstart({}, run)) return waitForPid(run, budget) ? "started" : "failed";
  const file = plistPath();
  if (fs.existsSync(file) && run(["bootstrap", domain(), file]).ok && waitForPid(run, budget)) return "started";
  return "failed";
}

export function agentPid(run: Launchctl = launchctl): number | null {
  const r = run(["print", `${domain()}/${launchdLabel()}`]);
  if (!r.ok) return null;
  const m = /^\s*pid = (\d+)/m.exec(r.out);
  return m ? Number(m[1]) : null;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** How long a job launchd accepted is given to produce a process before it counts as a failure. */
const START_BUDGET_MS = 15_000;

function waitForPid(run: Launchctl, budgetMs: number, pollMs = 250): boolean {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (agentPid(run) !== null) return true;
    sleepSync(pollMs);
  }
  return agentPid(run) !== null;
}

/**
 * Graceful restart. `launchctl kickstart -k` SIGKILLs about 5s after its SIGTERM (measured
 * 2026-09-13: the drain was cut and two in-flight model calls died), so instead we send
 * SIGTERM ourselves, let the router drain (up to 90s), wait for the process to exit, and let
 * launchd's KeepAlive relaunch it. Falls back to kickstart only if there is no pid or the
 * process ignores SIGTERM for longer than the drain budget.
 */
export function restartAgent(opts: { waitMs?: number; onProgress?: (msg: string) => void } = {}): "drained" | "kickstarted" | "failed" {
  const pid = agentPid();
  if (pid === null) return kickstart({ force: true }) && waitForPid(launchctl, START_BUDGET_MS) ? "kickstarted" : "failed";
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return kickstart({ force: true }) && waitForPid(launchctl, START_BUDGET_MS) ? "kickstarted" : "failed";
  }
  const t0 = Date.now();
  const deadline = t0 + (opts.waitMs ?? 120_000);
  let lastTick = 0;
  let exited = false;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      exited = true;
      break;
    }
    const s = Math.floor((Date.now() - t0) / 1000);
    if (s >= 5 && s !== lastTick && s % 5 === 0) {
      lastTick = s;
      opts.onProgress?.(`draining… ${s}s (waiting for in-flight model calls)`);
    }
    sleepSync(250);
  }
  if (!exited) return kickstart({ force: true }) && waitForPid(launchctl, START_BUDGET_MS) ? "kickstarted" : "failed";
  // KeepAlive relaunches it; ThrottleInterval is 2s.
  const upBy = Date.now() + 15_000;
  while (Date.now() < upBy) {
    if (agentState() === "running" && agentPid() !== pid) return "drained";
    sleepSync(250);
  }
  return kickstart({ force: true }) && waitForPid(launchctl, START_BUDGET_MS) ? "kickstarted" : "failed";
}

export function stopAgent(): boolean {
  const file = plistPath();
  return launchctl(["bootout", domain(), file]).ok;
}
