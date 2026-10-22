// `clauderipple doctor` and `clauderipple repair`: what is wrong with the chain Claude depends on,
// and the idempotent fix. Both serve the menu-bar app, which has to work when the router — and
// with it the dashboard — is down: Claude Desktop and Claude Code send everything to 127.0.0.1
// and fail with ECONNREFUSED, and nothing the router serves can explain why (2026-10-20).
//
// Everything that reaches the machine is a dependency (`RecoveryDeps`), so tests run with a fake
// supervisor and temp files and never touch launchd, the user's settings or the live router.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigStore, adminPort, type Config } from "../../router/src/config.ts";
import { certPaths } from "./certs.ts";
import { claudeBinary, claudeCodeLogin, claudeLoginHint, type ClaudeCodeLogin } from "./claude-auth.ts";
import { applyAppProxy, currentAppProxy } from "./picker.ts";
import { applyProxyEnv, settingsEnv } from "./settings.ts";
import type { AgentState } from "./supervisor.ts";
import type { SupervisorOps, SupervisorView } from "./registration.ts";

export type Mode = "ripple" | "direct" | "mixed";
export type ProxyState = "ripple" | "none" | "other";
export type Problem = { code: string; message: string };

export type DoctorReport = {
  mode: Mode;
  router: { responding: boolean; version: string | null; pid: number | null; url: string; adminUrl: string };
  supervisor: { registered: boolean; program: string | null; programExists: boolean; state: AgentState };
  desktop: { proxy: ProxyState; url: string | null };
  cli: { proxy: ProxyState; url: string | null };
  problems: Problem[];
};

export type RepairStep = { name: string; ok: boolean; detail: string };
export type RepairReport = { ok: boolean; steps: RepairStep[]; doctor: DoctorReport };

export type RouterStatus = { version: string | null };

export type RecoveryDeps = {
  home: string;
  /** This CLI's version, to compare with the running router's. */
  version: string;
  supervisor: SupervisorOps;
  /** GET /api/status on the admin port; null when the router does not answer within `timeoutMs`. */
  routerStatus?: (adminUrl: string, timeoutMs: number) => Promise<RouterStatus | null>;
  sleep?: (ms: number) => Promise<void>;
  /** How long repair waits for the router to answer after starting it. */
  healthBudgetMs?: number;
  /** Whether the phone host's background service is installed on this machine. */
  remoteHostInstalled?: () => boolean | Promise<boolean>;
  /** Whether the Claude Code CLI itself has a login (the phone host's sessions need one). */
  claudeLogin?: () => Promise<ClaudeCodeLogin>;
};

export async function fetchRouterStatus(adminUrl: string, timeoutMs: number): Promise<RouterStatus | null> {
  try {
    const res = await fetch(`${adminUrl}/api/status`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return { version: typeof body.version === "string" ? body.version : null };
  } catch {
    return null;
  }
}

const sleepDefault = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const LOOPBACK_PROXY = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/?$/;

export function proxyUrlFor(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * Claude Code's proxy, from settings.json env. `stale` is a proxy that is ours — our CA beside a
 * loopback URL — on a port the config no longer listens on: the one case repair may rewrite.
 */
export function cliProxyState(env: Record<string, string>, proxyUrl: string, caPath: string): { proxy: ProxyState; url: string | null; stale: boolean } {
  const url = env.HTTPS_PROXY || null;
  if (!url) return { proxy: "none", url: null, stale: false };
  if (url === proxyUrl) return { proxy: "ripple", url, stale: false };
  return { proxy: "other", url, stale: env.NODE_EXTRA_CA_CERTS === caPath && LOOPBACK_PROXY.test(url) };
}

/** Claude Desktop's proxy, from the applied Config Library entry. An entry with no proxy is "none". */
export function desktopProxyState(ap: ReturnType<typeof currentAppProxy>, proxyUrl: string): { proxy: ProxyState; url: string | null; stale: boolean } {
  const url = ap.egressProxyUrl;
  if (!url) return { proxy: "none", url: null, stale: false };
  if (url === proxyUrl) return { proxy: "ripple", url, stale: false };
  return { proxy: "other", url, stale: ap.ours };
}

/**
 * Claude Code always goes through the router in Ripple mode; Claude Desktop itself only when picker
 * mode is on (the Code tab's sessions read settings.json either way). Nothing through us is
 * "direct"; anything in between is "mixed".
 */
export function classifyMode(cli: ProxyState, desktop: ProxyState, pickerEnabled: boolean): Mode {
  const cliRipple = cli === "ripple";
  const desktopRipple = desktop === "ripple";
  if (cliRipple && (desktopRipple || !pickerEnabled)) return "ripple";
  if (!cliRipple && !desktopRipple) return "direct";
  return "mixed";
}

type Snapshot = {
  report: DoctorReport;
  installed: boolean;
  cfg: Config;
  view: SupervisorView;
  caPath: string;
  cliStale: boolean;
  desktopStale: boolean;
};

function configFile(home: string): string {
  return path.join(home, "config.json");
}

/**
 * Whether the phone host's own background service is installed here (a launchd agent, a scheduled
 * task, a systemd user unit). The host package owns that path, so it is asked for it; a host that
 * is not installed cannot need a CLI login of its own.
 */
async function remoteHostInstalled(): Promise<boolean> {
  try {
    const { servicePaths } = await import("../../remote/src/host-service.ts");
    return fs.existsSync(servicePaths(process.platform, os.homedir()).definition);
  } catch {
    // A host package that cannot be read is a host that is not installed here.
    return false;
  }
}

async function snapshot(deps: RecoveryDeps): Promise<Snapshot> {
  const installed = fs.existsSync(configFile(deps.home));
  const cfg = new ConfigStore(configFile(deps.home)).get();
  const proxyUrl = proxyUrlFor(cfg.listen.port);
  const adminUrl = `http://127.0.0.1:${adminPort(cfg)}`;
  const caPath = certPaths(deps.home).caPem;
  const status = await (deps.routerStatus ?? fetchRouterStatus)(adminUrl, 4_000);
  const view = deps.supervisor.inspect();
  const cli = cliProxyState(settingsEnv(), proxyUrl, caPath);
  const desktop = desktopProxyState(currentAppProxy(), proxyUrl);
  const pickerEnabled = cfg.picker?.enabled === true;
  const mode = classifyMode(cli.proxy, desktop.proxy, pickerEnabled);

  const problems: Problem[] = [];
  const add = (code: string, message: string): void => void problems.push({ code, message });
  if (!installed) add("not-installed", `ClaudeRipple is not installed here (no ${configFile(deps.home)}). Run: clauderipple install`);
  if (!view.registered) add("supervisor-missing", "The router is not registered to start at login, so nothing starts it. Repair registers it again.");
  else if (!view.programExists) add("supervisor-program-missing", `The router's startup entry points at a program that no longer exists (${view.program ?? "none"}). Repair points it at this installation.`);
  else if (!view.current) add("supervisor-other-install", `The router's startup entry belongs to another ClaudeRipple installation (${view.program}).`);
  if (!status) {
    add("router-down", `The router is not answering on ${adminUrl}. ${mode === "direct" ? "Claude is on its default connection, so it is not affected." : "Claude Desktop and Claude Code cannot connect while it is down."}`);
    if (view.registered && view.state !== "running") add("supervisor-not-running", "The router's background service is not running.");
  } else if (status.version && status.version !== deps.version) {
    add("router-version-mismatch", `The running router is ${status.version}; this ClaudeRipple is ${deps.version}.`);
  }
  if (cli.stale) add("cli-port-mismatch", `Claude Code is set to a ClaudeRipple port that is no longer used (${cli.url}; the router listens on ${proxyUrl}).`);
  else if (cli.proxy === "other") add("cli-foreign-proxy", `Claude Code goes through another proxy (${cli.url}), not ClaudeRipple.`);
  if (desktop.stale) add("desktop-port-mismatch", `Claude Desktop is set to a ClaudeRipple port that is no longer used (${desktop.url}; the router listens on ${proxyUrl}).`);
  else if (desktop.proxy === "other") add("desktop-foreign-proxy", `Claude Desktop goes through another proxy (${desktop.url}), not ClaudeRipple.`);
  if (mode === "mixed") add("mixed-mode", `Claude Code ${cli.proxy === "ripple" ? "goes" : "does not go"} through ClaudeRipple, Claude Desktop ${desktop.proxy === "ripple" ? "does" : "does not"}.`);
  // The phone host starts Claude Code through the Agent SDK and passes no credential of its own, so
  // without a login of the CLI's own every turn fails at once (issue #71).
  if (await (deps.remoteHostInstalled ?? remoteHostInstalled)()) {
    const login = await (deps.claudeLogin ?? (() => claudeCodeLogin()))();
    if (!login.ok) add("cli-not-logged-in", `Claude Code has no login on this computer, so the phone host's sessions fail at once. ${claudeLoginHint(claudeBinary())}`);
  }

  return {
    report: {
      mode,
      router: { responding: status !== null, version: status?.version ?? null, pid: view.pid, url: proxyUrl, adminUrl },
      supervisor: { registered: view.registered, program: view.program, programExists: view.programExists, state: view.state },
      desktop: { proxy: desktop.proxy, url: desktop.url },
      cli: { proxy: cli.proxy, url: cli.url },
      problems,
    },
    installed,
    cfg,
    view,
    caPath,
    cliStale: cli.stale,
    desktopStale: desktop.stale,
  };
}

export async function doctor(deps: RecoveryDeps): Promise<DoctorReport> {
  return (await snapshot(deps)).report;
}

/**
 * Fixes what doctor finds, in order, and is safe to run again: re-register the supervisor for this
 * installation, start it, wait for it to answer, and correct a Claude proxy setting that is ours but
 * names an old port. It never switches between Ripple and direct mode (that is `direct on|off`) and
 * never touches a proxy setting that is not ours.
 */
export async function repair(deps: RecoveryDeps): Promise<RepairReport> {
  const sleep = deps.sleep ?? sleepDefault;
  const status = deps.routerStatus ?? fetchRouterStatus;
  const steps: RepairStep[] = [];
  const before = await snapshot(deps);
  if (!before.installed) {
    steps.push({ name: "config", ok: false, detail: `no ${configFile(deps.home)}; run \`clauderipple install\` first` });
    return { ok: false, steps, doctor: before.report };
  }
  const responding = before.report.router.responding;
  const view = before.view;

  // A working router is never cut off for a definition that merely differs: re-registering unloads
  // the running job, which drains it and drops every Claude connection (ARCHITECTURE §5).
  const mustRegister = !view.registered || !view.programExists || (!view.current && !responding);
  if (mustRegister) {
    try {
      const where = deps.supervisor.register();
      steps.push({ name: "supervisor", ok: true, detail: `registered for this installation: ${where}` });
    } catch (e) {
      steps.push({ name: "supervisor", ok: false, detail: (e as Error).message });
    }
  } else {
    steps.push({
      name: "supervisor",
      ok: true,
      detail: view.current ? "already registered for this installation" : `left as it is: the router answers, and its entry names another installation (${view.program}); run \`clauderipple install\` to move it`,
    });
  }

  if (responding) {
    steps.push({ name: "start", ok: true, detail: "the router is already answering" });
  } else {
    const started = deps.supervisor.start();
    steps.push({ name: "start", ok: started !== "failed", detail: started === "failed" ? "the supervisor could not start the router" : started === "already-running" ? "the supervisor reports it running" : "started" });
    const adminUrl = before.report.router.adminUrl;
    const budget = deps.healthBudgetMs ?? 20_000;
    const t0 = Date.now();
    let up = false;
    while (!up) {
      up = (await status(adminUrl, 3_000)) !== null;
      if (up || Date.now() - t0 >= budget) break;
      await sleep(1_000);
    }
    steps.push({ name: "health", ok: up, detail: up ? `answering on ${adminUrl} after ${Math.round((Date.now() - t0) / 100) / 10}s` : `still not answering on ${adminUrl} after ${Math.round(budget / 1000)}s; see ${path.join(deps.home, "logs", "router.log")}` });
  }

  const proxyUrl = proxyUrlFor(before.cfg.listen.port);
  if (before.cliStale) {
    try {
      // Ours by our CA beside a loopback URL (cliProxyState), so replacing it is not overriding anyone.
      const edit = applyProxyEnv({ proxyUrl, caPath: before.caPath, force: true });
      steps.push({ name: "cli-proxy", ok: true, detail: `Claude Code now points at ${proxyUrl}${edit.backup ? ` (backup: ${edit.backup})` : ""}` });
    } catch (e) {
      steps.push({ name: "cli-proxy", ok: false, detail: (e as Error).message });
    }
  }
  if (before.desktopStale) {
    try {
      applyAppProxy(proxyUrl);
      steps.push({ name: "desktop-proxy", ok: true, detail: `Claude Desktop now points at ${proxyUrl} (quit and reopen it to apply)` });
    } catch (e) {
      steps.push({ name: "desktop-proxy", ok: false, detail: (e as Error).message });
    }
  }

  const after = await doctor(deps);
  return { ok: steps.every((s) => s.ok) && after.router.responding, steps, doctor: after };
}
