// Linux supervisor: a per-user systemd service that keeps the router alive. No sudo, nothing
// machine-wide. Restart=always + RestartSec=2 is launchd's KeepAlive + ThrottleInterval 2: a
// self-exit (code 75) is followed by a fresh process two seconds later, and StartLimitIntervalSec=0
// keeps systemd from giving up on it after a burst of those.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homeDir } from "../../router/src/config.ts";
import { type AgentRemove, type AgentRestart, type AgentStart, type AgentStop, type Ownership, ownerOf, unitEnvironment } from "./ownership.ts";
import { type IdentityWait, type RouterIdentity, awaitIdentity, routerIdentity } from "./router-state.ts";
import { withServiceFile } from "./service-definition.ts";

/** Whose router answers this installation's admin port. Injected in tests that must not probe. */
export type IdentityCheck = (expectedPid: number | null) => RouterIdentity;

const HEADER = "[Unit]\nDescription=ClaudeRipple local model router\n";

/** Test-only override; production always uses clauderipple.service. */
export function unitName(): string {
  const name = process.env.CLAUDERIPPLE_SYSTEMD_UNIT ?? "clauderipple.service";
  if (!/^[A-Za-z0-9_.-]+\.service$/.test(name)) throw new Error(`invalid systemd unit name: ${name}`);
  return name;
}

export function unitPath(): string {
  const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(config, "systemd", "user", unitName());
}

/**
 * One quoted unit-file word. `%` is a specifier and `$` an environment substitution in ExecStart
 * (systemd.service(5)), so a path containing either has to be escaped or it runs something else.
 */
function quote(value: string, dollar: boolean): string {
  if (/[\r\n\0]/.test(value)) throw new Error("newlines and NUL cannot appear in a systemd unit value");
  let s = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  if (dollar) s = s.replace(/\$/g, "$$$$");
  return `"${s}"`;
}

export function renderUnit(opts: { program: string; args?: string[]; home: string; env?: Record<string, string> }): string {
  if (!path.isAbsolute(opts.program)) throw new Error("the service program must be an absolute path");
  const env = { CLAUDERIPPLE_HOME: opts.home, ...(opts.env ?? {}) };
  const envLines = Object.entries(env).map(([k, v]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`invalid environment name: ${k}`);
    return `Environment=${quote(`${k}=${v}`, false)}`;
  });
  // TimeoutStopSec covers the router's 90s drain on SIGTERM (ARCHITECTURE §5) with room to spare;
  // KillMode=mixed sends that SIGTERM to the router alone and SIGKILLs only what outlives the budget.
  return `${HEADER}StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=${[opts.program, ...(opts.args ?? [])].map((a) => quote(a, true)).join(" ")}
${envLines.join("\n")}
Restart=always
RestartSec=2
KillSignal=SIGTERM
KillMode=mixed
TimeoutStopSec=120
UMask=0077

[Install]
WantedBy=default.target
`;
}

/** One `systemctl --user` invocation. Injected so tests never reach the user manager. */
export type Systemctl = (args: string[]) => { ok: boolean; out: string };

const realSystemctl: Systemctl = (args) => {
  try {
    const out = execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 150_000 });
    return { ok: true, out };
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    return { ok: false, out: err.stderr?.toString().trim() || err.message || "systemctl failed" };
  }
};

function mustSystemctl(args: string[], run: Systemctl = realSystemctl): void {
  const r = run(args);
  if (!r.ok) throw new Error(`systemctl --user ${args.join(" ")} failed: ${r.out}`);
}

/** Who the unit registered under this name belongs to (B01). */
export function unitOwnership(home: string = homeDir()): Ownership {
  let text: string;
  try {
    text = fs.readFileSync(unitPath(), "utf8");
  } catch (error) {
    // A missing unit is "absent"; anything else (permissions, I/O) is unknown, never absent: an
    // "absent" answer would let install replace a unit it could not read.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent", home: null };
    return { state: "unknown", home: null };
  }
  return ownerOf(unitEnvironment(text).CLAUDERIPPLE_HOME ?? null, home);
}

export function installAgent(opts: { program: string; args?: string[]; home: string; env?: Record<string, string> }, run: Systemctl = realSystemctl, identity: IdentityCheck = expectedPid => routerIdentity(opts.home, { expectedPid })): string {
  return withServiceFile(unitPath(), run, guard => {
    run = guard.run;
    // No user manager (an ssh login without lingering, a container) means nothing would ever start
    // the router: fail here, before any file is written.
    mustSystemctl(["show-environment"], run);
    const file = unitPath();
    if (fs.existsSync(file)) {
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch (error) {
        throw new Error(`${file} could not be read (${(error as Error).message}); refusing to replace it`);
      }
      if (!text.startsWith(HEADER)) {
        throw new Error(`${file} exists and is not ClaudeRipple's; refusing to replace it`);
      }
    }
    const owner = unitOwnership(opts.home);
    if (owner.state === "other") {
      throw new Error(`${file} belongs to another ClaudeRipple installation (${owner.home}); remove it with that installation's uninstall, or use its own unit name for this one`);
    }
    if (owner.state === "unknown") {
      throw new Error(`${file} does not record an installation, so it cannot be identified; refusing to replace it`);
    }
    if (owner.state === "ours") {
      const pid = agentPid(run);
      if (pid !== null && identity(pid) !== "ours") throw new Error("running systemd instance identity is unknown; unit left untouched");
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    guard.write(renderUnit(opts));
    mustSystemctl(["daemon-reload"], run);
    mustSystemctl(["enable", unitName()], run);
    return file;
  });
}

export function removeAgent(home: string = homeDir(), run: Systemctl = realSystemctl, identity: IdentityCheck = (expectedPid) => routerIdentity(home, { expectedPid })): AgentRemove {
  return withServiceFile(unitPath(), run, guard => {
    run = guard.run;
    const file = unitPath();
    const owner = unitOwnership(home);
    if (owner.state === "absent") return "absent";
    if (owner.state === "other") return "other-installation";
    if (owner.state === "unknown") return "ownership-unknown";
    // `disable --now` terminates the unit's process. The unit file can have been replaced under a
    // running instance, so a running unit is only stopped when its own id proves it is ours.
    const pid = agentPid(run);
    if (pid !== null) {
      const who = identity(pid);
      if (who === "other") return "other-installation";
      if (who !== "ours") return "identity-unknown";
    }
    const definition = fs.readFileSync(file, "utf8");
    mustSystemctl(["disable", "--now", unitName()], run);
    if (unitOwnership(home).state !== "ours" || fs.readFileSync(file, "utf8") !== definition) return "ownership-unknown";
    guard.remove();
    mustSystemctl(["daemon-reload"], run);
    return "removed";
  });
}

export function agentState(run: Systemctl = realSystemctl): "running" | "loaded" | "not-loaded" {
  const r = run(["show", unitName(), "--property=ActiveState", "--value"]);
  if (!r.ok) throw new Error(`systemd state lookup failed: ${r.out}`);
  if (r.out.trim() === "active") return "running";
  return fs.existsSync(unitPath()) ? "loaded" : "not-loaded";
}

export function agentPid(run: Systemctl = realSystemctl): number | null {
  const r = run(["show", unitName(), "--property=MainPID", "--value"]);
  const text = r.out.trim();
  if (!r.ok || !/^\d+$/.test(text)) throw new Error(`systemd PID lookup failed: ${r.out}; no control operation performed`);
  const pid = Number(text);
  if (!Number.isSafeInteger(pid)) throw new Error(`invalid systemd PID: ${text}`);
  return pid > 0 ? pid : null;
}

/**
 * Idempotent, like launchd's: a running router is left alone (ARCHITECTURE §5, "Start Router").
 * `systemctl start` returns once the unit is activated — a service that exits at once is still
 * "started" at that point — so the MainPID is waited for, as on Windows (#80).
 */
export function startAgent(home: string = homeDir(), opts: { waitMs?: number } = {}, run: Systemctl = realSystemctl): AgentStart {
  return withServiceFile(unitPath(), run, guard => {
    run = guard.run;
    const owner = unitOwnership(home);
    if (owner.state === "other") return "other-installation";
    if (owner.state === "unknown") return "ownership-unknown";
    if (agentState(run) === "running") return "already-running";
    if (!run(["start", unitName()]).ok) return "failed";
    return waitForPid(opts.waitMs ?? START_BUDGET_MS, run) ? "started" : "failed";
  });
}

export function stopAgent(home: string = homeDir(), opts: Record<string, never> = {}, run: Systemctl = realSystemctl, identity: IdentityCheck = (expectedPid) => routerIdentity(home, { expectedPid })): AgentStop {
  return withServiceFile(unitPath(), run, guard => {
    run = guard.run;
    const owner = unitOwnership(home);
    if (owner.state === "absent") return "not-loaded";
    if (owner.state === "other") return "other-installation";
    if (owner.state === "unknown") return "ownership-unknown";
    // Stopping terminates the unit's process; require the running instance to prove it is ours.
    const pid = agentPid(run);
    if (pid !== null) {
      const who = identity(pid);
      if (who === "other") return "other-installation";
      if (who !== "ours") return "identity-unknown";
    }
    return run(["stop", unitName()]).ok ? "stopped" : "not-loaded";
  });
}

/**
 * systemd sends the SIGTERM, waits for the process to exit (up to TimeoutStopSec) and then starts
 * a new one, so the drain is never cut the way `launchctl kickstart -k` cut it.
 */
export function restartAgent(home: string = homeDir(), opts: { waitMs?: number; onProgress?: (msg: string) => void; identityWait?: IdentityWait } = {}, run: Systemctl = realSystemctl, identity: IdentityCheck = (expectedPid) => routerIdentity(home, { expectedPid })): AgentRestart {
  return withServiceFile(unitPath(), run, guard => {
    run = guard.run;
    const owner = unitOwnership(home);
    if (owner.state === "other") return "other-installation";
    if (owner.state === "unknown") return "ownership-unknown";
    // `systemctl restart` stops the running unit first: a running instance must prove it is ours.
    const pid = agentPid(run);
    if (pid !== null) {
      const who = identity(pid);
      if (who === "other") return "other-installation";
      if (who !== "ours") return "identity-unknown";
    }
    opts.onProgress?.("waiting for in-flight model calls to finish (up to 120s)…");
    if (!run(["restart", unitName()]).ok) return "failed";
    // The restart command returned; the successor still has to appear. A unit that cannot start
    // answers "failed" here rather than being reported as a restart (2026-10-22, #80).
    if (!waitForPid(START_BUDGET_MS, run)) return "failed";
    const again = unitOwnership(home);
    if (again.state === "other") return "other-installation";
    if (again.state !== "ours") return "ownership-unknown";
    const successor = agentPid(run);
    if (successor === null) return "identity-unknown";
    // The successor has only just started and may not answer yet: wait for its answer instead of
    // reporting the restart as unverifiable (the launchd defect of 2026-10-26, same code path).
    const answer = awaitIdentity(identity, successor, () => agentPid(run), opts.identityWait);
    return answer.state === "ours" ? "drained" : answer.state === "other" ? "other-installation" : "identity-unknown";
  });
}

/** How long a unit systemd accepted is given to produce a process before it counts as a failure. */
const START_BUDGET_MS = 15_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForPid(budgetMs: number, run: Systemctl = realSystemctl, pollMs = 500): boolean {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (agentPid(run) !== null) return true;
    sleepSync(pollMs);
  }
  return agentPid(run) !== null;
}
