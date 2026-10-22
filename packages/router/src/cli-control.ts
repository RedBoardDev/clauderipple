// Process boundary shared by dashboard actions and the router-owned updater.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { homeDir } from "./config.ts";

export type CliResult = { ok: boolean; output: string };
export type DetachedCli = { pid?: number; completion: Promise<CliResult> };
export type UpdateCheck = { current: string; latest: string | null; newer: boolean; kind: string };

/** Only the final CLI output line is the machine-readable answer. */
export function parseUpdateCheck(output: string): UpdateCheck | null {
  try {
    const check = JSON.parse(output.trim().split("\n").pop() ?? "") as Partial<UpdateCheck> | null;
    if (!check || typeof check.current !== "string" || typeof check.newer !== "boolean" || typeof check.kind !== "string") return null;
    return { current: check.current, latest: typeof check.latest === "string" ? check.latest : null, newer: check.newer, kind: check.kind };
  } catch {
    return null; // An invalid external CLI response is reported by the caller.
  }
}

/** paths.json is written by install; a checkout has no such file. */
function cliInvocation(): { node: string; cli: string; env: NodeJS.ProcessEnv } {
  let node = process.execPath;
  const here = path.dirname(fileURLToPath(import.meta.url));
  let cli = path.resolve(here, `../../cli/src/index${path.extname(fileURLToPath(import.meta.url))}`);
  let runtimeEnv: Record<string, string> = {};
  try {
    const p = JSON.parse(fs.readFileSync(path.join(homeDir(), "paths.json"), "utf8")) as { node?: string; env?: Record<string, string>; cli?: string };
    if (p.node) node = p.node;
    if (p.env) runtimeEnv = p.env;
    if (p.cli) cli = p.cli;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { node, cli, env: { ...process.env, ...runtimeEnv, CLAUDERIPPLE_HOME: homeDir() } };
}

export function runCli(args: string[], timeout = 180_000): Promise<CliResult> {
  return new Promise((resolve) => {
    const { node, cli, env } = cliInvocation();
    execFile(node, [cli, ...args], { env, timeout }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout}${stderr}${error ? `\n${error.message}` : ""}`.trim() });
    });
  });
}

/** Separate process group: launchd must not kill the installer when it drains this router. */
export function startCliDetached(args: string[], log: string, extraEnv: NodeJS.ProcessEnv = {}): DetachedCli {
  const { node, cli, env } = cliInvocation();
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const out = fs.openSync(log, "w");
  try {
    const child = spawn(node, [cli, ...args], { env: { ...env, ...extraEnv }, detached: true, stdio: ["ignore", out, out], windowsHide: true });
    const completion = new Promise<CliResult>((resolve) => {
      child.once("error", (error) => resolve({ ok: false, output: error.message }));
      child.once("exit", (code, signal) => resolve({ ok: code === 0, output: `update exited ${code ?? signal}; see ${log}` }));
    });
    child.unref();
    return { ...(child.pid === undefined ? {} : { pid: child.pid }), completion };
  } finally {
    fs.closeSync(out);
  }
}
