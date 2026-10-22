// Host supervision, independent of the router's task/unit and process lifetime.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import * as launchd from "./service.ts";
import * as windows from "../../cli/src/schtasks.ts";
import { renderUnit } from "../../cli/src/systemd.ts";
import { loadConfig, remoteHome } from "./config.ts";

export const TASK = "ClaudeRippleHost";
export const UNIT = "clauderipple-host.service";
type Spec = launchd.PlistSpec;
export const supervisorName = (platform = process.platform): string => platform === "darwin" ? "launchd agent" : platform === "win32" ? "scheduled task" : "systemd user service";
export function servicePaths(platform = process.platform, home = os.homedir()): { definition: string; log: string; runtime: string } {
  const runtime = path.join(home, ".clauderipple", "host-service");
  if (platform === "darwin") { const p = launchd.paths(home); return { definition: p.plist, log: p.log, runtime }; }
  if (platform === "win32") return { definition: path.join(runtime, `${TASK}.ps1`), log: path.join(runtime, "logs", "launcher.log"), runtime };
  return { definition: path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "systemd", "user", UNIT), log: `journalctl --user -u ${UNIT}`, runtime };
}
function systemctl(args: string[]): string {
  return execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", timeout: 150_000, stdio: ["ignore", "pipe", "pipe"] });
}
export function unit(spec: Spec): string {
  return renderUnit({ program: spec.node, args: ["--disable-warning=ExperimentalWarning", spec.script, ...spec.args], home: spec.workingDir, env: spec.env })
    .replace("Description=ClaudeRipple local model router", "Description=Ripple Remote host");
}
export function renderService(spec: Spec, platform = process.platform): string {
  if (platform === "darwin") return launchd.plist(spec);
  if (platform === "linux") return unit(spec);
  if (platform === "win32") return windows.renderLauncher({ program: spec.node, args: ["--disable-warning=ExperimentalWarning", spec.script, ...spec.args], home: servicePaths(platform).runtime, env: spec.env });
  throw new Error(`host service is unsupported on ${platform}`);
}

/** An authenticated local request, never a pairing credential or a public shutdown endpoint. */
export async function controlShutdown(dir = remoteHome()): Promise<void> {
  const cfg = loadConfig(dir, false);
  let secret: string;
  try { secret = fs.readFileSync(path.join(dir, "local.secret"), "utf8").trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const url = `http://127.0.0.1:${cfg.port}`;
  const headers = { "x-ripple-local": secret };
  // Check first: a refused secret or incompatible live host must not lead to a hard kill.
  let status: Response;
  try { status = await fetch(`${url}/local/status`, { headers, signal: AbortSignal.timeout(2000), redirect: "error" }); }
  catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    if (cause?.code === "ECONNREFUSED") return;
    throw new Error("could not check the host before shutdown");
  }
  if (!status.ok) throw new Error(`host local status refused (${status.status})`);
  await status.body?.cancel();
  const response = await fetch(`${url}/local/shutdown`, { method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`host shutdown refused (${response.status}); update the host before stopping its task`);
  await response.body?.cancel();
  for (let i = 0; i < 100; i++) {
    await delay(100);
    try {
      const probe = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(500) });
      await probe.body?.cancel();
    } catch (error) {
      if ((error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED") return;
      throw new Error("could not confirm host shutdown");
    }
  }
  throw new Error("host did not finish shutdown; its task was left alone");
}

async function waitForHost(dir = remoteHome()): Promise<void> {
  const cfg = loadConfig(dir, false);
  for (let i = 0; i < 100; i++) {
    try {
      const secret = fs.readFileSync(path.join(dir, "local.secret"), "utf8").trim();
      const response = await fetch(`http://127.0.0.1:${cfg.port}/local/status`, { headers: { "x-ripple-local": secret }, redirect: "error", signal: AbortSignal.timeout(500) });
      await response.body?.cancel();
      if (response.ok) return;
      if (response.status === 403) throw new Error("host local authentication refused");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? (error as { cause?: { code?: string } }).cause?.code;
      if (code !== "ENOENT" && code !== "ECONNREFUSED" && !(error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))) throw error;
    }
    await delay(100);
  }
  throw new Error("host service was registered but did not answer its authenticated status; check its logs");
}

/**
 * What an update does to the phone host. Updating replaces the files but not the running process, so
 * without a restart the host kept the old code until the machine rebooted (2026-10-22, a Windows
 * user on 0.12.4 still got 0.12.3's "cannot send"). Only a host this installation registered is
 * restarted — one run from a source checkout is someone else's — and never one mid-turn.
 */
export type RefreshPlan = "absent" | "foreign" | "busy" | "restart";
export function refreshPlan(o: { installed: boolean; definition: string | null; script: string; busy: boolean | undefined }): RefreshPlan {
  if (!o.installed || o.definition === null) return "absent";
  const xml = o.script.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (![o.script, xml, o.script.replace(/'/g, "''")].some(form => o.definition!.includes(form))) return "foreign";
  // An older host does not report it; its update came while the router sat idle, so most likely idle too.
  return o.busy ? "busy" : "restart";
}

/** The running host's own answer; undefined when it does not answer or predates the field. */
export async function hostBusy(dir = remoteHome()): Promise<boolean | undefined> {
  try {
    const cfg = loadConfig(dir, false);
    const secret = fs.readFileSync(path.join(dir, "local.secret"), "utf8").trim();
    const response = await fetch(`http://127.0.0.1:${cfg.port}/local/status`, { headers: { "x-ripple-local": secret }, redirect: "error", signal: AbortSignal.timeout(2000) });
    if (!response.ok) { await response.body?.cancel(); return undefined; }
    const body = await response.json() as { busy?: unknown };
    return typeof body.busy === "boolean" ? body.busy : undefined;
  } catch { return undefined; }
}

export async function installService(spec: Spec): Promise<string[]> {
  const platform = process.platform;
  if (platform === "darwin") return launchd.install(spec);
  const p = servicePaths();
  if (platform === "win32") {
    await controlShutdown();
    windows.stopAgent(TASK);
    windows.installAgent({ name: TASK, program: spec.node, args: ["--disable-warning=ExperimentalWarning", spec.script, ...spec.args], home: p.runtime, env: spec.env });
    if (windows.startAgent(TASK) === "failed") throw new Error("could not start the host scheduled task");
  } else if (platform === "linux") {
    systemctl(["show-environment"]); // Fail before writing when there is no user manager.
    if (fs.existsSync(p.definition) && !fs.readFileSync(p.definition, "utf8").startsWith("[Unit]\nDescription=Ripple Remote host\n")) throw new Error("refusing to replace a foreign host unit");
    fs.mkdirSync(path.dirname(p.definition), { recursive: true });
    fs.writeFileSync(p.definition, unit(spec), { mode: 0o600 });
    systemctl(["daemon-reload"]);
    systemctl(["enable", UNIT]);
    systemctl(["restart", UNIT]);
  } else throw new Error(`host service is unsupported on ${platform}`);
  await waitForHost();
  return [`installed and started ${p.definition}`, `logs: ${p.log}`];
}
export async function uninstallService(): Promise<string[]> {
  if (process.platform === "darwin") return launchd.uninstall();
  const p = servicePaths();
  if (process.platform === "win32") {
    await controlShutdown();
    windows.stopAgent(TASK);
    if (windows.agentState(TASK) !== "not-loaded" && !windows.removeAgent(TASK)) throw new Error("could not remove the host scheduled task");
  } else if (process.platform === "linux") {
    systemctl(["disable", "--now", UNIT]);
  } else throw new Error(`host service is unsupported on ${process.platform}`);
  fs.rmSync(p.definition, { force: true });
  if (process.platform === "linux") systemctl(["daemon-reload"]);
  return [`removed ${p.definition}`];
}
export function serviceStatus(): ReturnType<typeof launchd.agentStatus> {
  if (process.platform === "darwin") return launchd.agentStatus();
  const p = servicePaths();
  if (process.platform === "win32") {
    const state = windows.agentState(TASK);
    return { installed: state !== "not-loaded", loaded: state !== "not-loaded", state, pid: null, lastExit: null };
  }
  let state = "not-loaded", pid: number | null = null;
  if (process.platform === "linux" && fs.existsSync(p.definition)) {
    state = systemctl(["show", UNIT, "--property=ActiveState", "--value"]).trim();
    pid = Number(systemctl(["show", UNIT, "--property=MainPID", "--value"]).trim()) || null;
  }
  return { installed: fs.existsSync(p.definition), loaded: state !== "not-loaded", state, pid, lastExit: null };
}
