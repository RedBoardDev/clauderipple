// What `install` registers with the supervisor, as data — so `repair` can register exactly the
// same thing and `doctor` can tell whether what is registered is still this installation's.
//
// The failure this exists for (2026-10-20): the launchd plist named a program that no longer
// existed, so launchd could not start the router, Claude Desktop and Claude Code got
// ECONNREFUSED on everything, and the dashboard — served by the router — was gone with it.

import fs from "node:fs";
import path from "node:path";
import { BUNDLE_ID, launcherPath, launcherScript, writeBundle } from "./bundle.ts";
import * as launchd from "./launchd.ts";
import * as schtasks from "./schtasks.ts";
import * as systemd from "./systemd.ts";
import type { Runtime } from "./runtime.ts";
import { installKind } from "./update.ts";
import type { AgentState } from "./supervisor.ts";

export type Registration = {
  program: string;
  args: string[];
  bundleId: string;
  env: Record<string, string>;
  /** macOS source checkout: the small .app the agent runs so Login Items says "ClaudeRipple". */
  bundle: { node: string; script: string; version: string } | null;
};

/**
 * Windows and Linux register the runtime + router script directly; so does a packaged app. A macOS
 * source checkout or npm install runs a generated bundle instead (bundle.ts). `platform` is a
 * parameter only so this pure mapping can be tested for every platform; nothing here runs anything.
 */
export function registration(rt: Runtime, home: string, version: string, platform: NodeJS.Platform = process.platform, settingsPathEnv: string | null = process.env.CLAUDE_SETTINGS_PATH ?? null): Registration {
  const settingsEnv: Record<string, string> = settingsPathEnv ? { CLAUDE_SETTINGS_PATH: settingsPathEnv } : {};
  if (rt.packaged || platform === "win32" || platform === "linux") {
    return { program: rt.node, args: [rt.router], bundleId: "com.clauderipple.app", env: { ...rt.env, ...settingsEnv }, bundle: null };
  }
  return { program: launcherPath(home), args: [], bundleId: BUNDLE_ID, env: settingsEnv, bundle: { node: rt.node, script: rt.router, version } };
}

/** The single execution contract the GUI, admin API, hooks and supervisor read (`paths.json`). */
export function writePaths(rt: Runtime, home: string): string {
  const file = path.join(home, "paths.json");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ node: rt.node, env: rt.env, cli: rt.cli, router: rt.router, hookScript: rt.hookScript, repo: rt.repo, install: installKind(rt, { stateHome: home }) }, null, 2) + "\n",
  );
  return file;
}

/** What the supervisor has registered right now, read from its definition. */
export type SupervisorView = {
  registered: boolean;
  program: string | null;
  args: string[];
  /** The program and every absolute path it is handed exist (and, for a launcher script, what it execs). */
  programExists: boolean;
  state: AgentState;
  pid: number | null;
  /** The definition is byte-for-byte what this installation would register. */
  current: boolean;
};

export type SupervisorOps = {
  inspect(): SupervisorView;
  /** Writes this installation's definition and (re)loads it. Returns the definition's path. */
  register(): string;
  start(): "already-running" | "started" | "failed";
};

/** Reads only the head of `file`: the program is often a 100MB binary, and only a script matters. */
function head(file: string): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * Whether everything the definition starts exists. A launcher script (the macOS bundle) is followed
 * one step: its `exec "node" "router"` targets are what actually went missing when node moved.
 */
export function targetsExist(program: string | null, args: string[]): boolean {
  if (!program || !fs.existsSync(program)) return false;
  const paths = args.filter((a) => path.isAbsolute(a));
  const text = head(program);
  if (text.startsWith("#!")) {
    const exec = /^exec\s+(.+)$/m.exec(text)?.[1] ?? "";
    for (const m of exec.matchAll(/"([^"]+)"|'([^']+)'/g)) {
      const p = m[1] ?? m[2]!;
      if (path.isAbsolute(p)) paths.push(p);
    }
  }
  return paths.every((p) => fs.existsSync(p));
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** ProgramArguments from a launchd plist, or [] when there are none. */
export function plistProgramArguments(xml: string): string[] {
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)?.[1];
  if (!array) return [];
  return [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unescapeXml(m[1]!));
}

/** ExecStart's words from a systemd unit, undoing the quoting renderUnit applies. */
export function unitExecStart(unit: string): string[] {
  const line = /^ExecStart=(.*)$/m.exec(unit)?.[1];
  if (!line) return [];
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) =>
    m[1] !== undefined ? m[1].replace(/\$\$/g, "$").replace(/%%/g, "%").replace(/\\(.)/g, "$1") : m[2]!,
  );
}

/** Program and arguments from the Windows launcher script renderLauncher writes. */
export function launcherProgram(ps1: string): string[] {
  const program = /-FilePath '((?:[^']|'')*)'/.exec(ps1)?.[1]?.replace(/''/g, "'");
  if (!program) return [];
  const list = /^\$routerArgs = @\((.*)\)$/m.exec(ps1)?.[1] ?? "";
  const args = [...list.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replace(/''/g, "'").replace(/^"(.*)"$/, "$1"));
  return [program, ...args];
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function view(definition: string[], registered: boolean, current: boolean, state: AgentState, pid: number | null): SupervisorView {
  const [program = null, ...args] = definition;
  return { registered, program, args, programExists: targetsExist(program, args), state, pid, current };
}

/** launchd, with an injectable launchctl so tests never reach the real one. */
export function launchdSupervisor(reg: Registration, home: string, run: launchd.Launchctl = launchd.launchctl): SupervisorOps {
  const stdoutLog = path.join(home, "logs", "launchd.log");
  const opts = { program: reg.program, args: reg.args, bundleId: reg.bundleId, home, env: reg.env };
  return {
    inspect() {
      const text = readText(launchd.plistPath());
      const bundleCurrent = !reg.bundle || readText(launcherPath(home)) === launcherScript({ home, node: reg.bundle.node, script: reg.bundle.script });
      const current = text !== null && text === launchd.renderPlist({ ...opts, stdoutLog }) && bundleCurrent;
      return view(text ? plistProgramArguments(text) : [], text !== null, current, launchd.agentState(run), launchd.agentPid(run));
    },
    register() {
      if (reg.bundle) writeBundle({ home, node: reg.bundle.node, script: reg.bundle.script, version: reg.bundle.version });
      return launchd.installAgent(opts, run);
    },
    start: () => launchd.startAgent(run),
  };
}

export function systemdSupervisor(reg: Registration, home: string): SupervisorOps {
  const opts = { program: reg.program, args: reg.args, home, env: reg.env };
  return {
    inspect() {
      const text = readText(systemd.unitPath());
      return view(text ? unitExecStart(text) : [], text !== null, text === systemd.renderUnit(opts), systemd.agentState(), systemd.agentPid());
    },
    register: () => systemd.installAgent(opts),
    start: () => systemd.startAgent(),
  };
}

export function schtasksSupervisor(reg: Registration, home: string): SupervisorOps {
  const opts = { program: reg.program, args: reg.args, home, env: reg.env };
  const launcher = path.join(home, "clauderipple-router.ps1");
  return {
    inspect() {
      const text = readText(launcher);
      const registered = schtasks.existingTaskDefinition() !== null;
      return view(text ? launcherProgram(text) : [], registered, registered && text === schtasks.renderLauncher(opts), schtasks.agentState(), schtasks.agentPid());
    },
    // installAgent keeps an existing task whose whole definition already matches (issue #9).
    register: () => schtasks.installAgent(opts),
    start: () => schtasks.startAgent(),
  };
}

/** This machine's supervisor. Chosen by the real platform, never a spoofed one. */
export function nativeSupervisor(reg: Registration, home: string): SupervisorOps {
  if (process.platform === "win32") return schtasksSupervisor(reg, home);
  if (process.platform === "linux") return systemdSupervisor(reg, home);
  return launchdSupervisor(reg, home);
}
