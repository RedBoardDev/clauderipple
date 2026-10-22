// Running the host day to day: its own launchd agent (spec: `com.clauderipple.host`, KeepAlive,
// ProcessType Interactive; not inside the router, which must not restart to ship host changes).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeBinary, claudeLoginHint, type ClaudeCodeLogin } from "../../cli/src/claude-auth.ts";

export const LABEL = "com.clauderipple.host";

// ---- where things are --------------------------------------------------------------------------

/** The user's own CLI when there is one: it is the version the router's measurements and the ripple mod are kept current with. */
export function findClaude(configured: string | undefined, exists: (p: string) => boolean = fs.existsSync,
  opts: { platform?: NodeJS.Platform; home?: string; pathValue?: string } = {}): string | undefined {
  if (configured) return configured;
  const platform = opts.platform ?? process.platform;
  const p = platform === "win32" ? path.win32 : path.posix;
  const home = opts.home ?? os.homedir();
  const names = platform === "win32" ? ["claude.exe", "claude.cmd", "claude.bat"] : ["claude"];
  const dirs = [p.join(home, ".local", "bin"), ...(platform === "win32" ? [p.join(process.env.APPDATA ?? p.join(home, "AppData", "Roaming"), "npm")] : ["/opt/homebrew/bin", "/usr/local/bin"]),
    ...(opts.pathValue ?? process.env.PATH ?? process.env.Path ?? "").split(platform === "win32" ? ";" : ":")];
  for (const dir of dirs.filter(Boolean)) for (const name of names) {
    const candidate = p.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  // Shared discovery also covers both AppData roots and Desktop's version/hash cache layout.
  return platform === process.platform && exists === fs.existsSync ? claudeBinary() ?? undefined : undefined;
}

/**
 * The one line `remote install` prints when the Claude Code CLI has no login of its own: the host
 * starts Claude Code through the Agent SDK and passes no credential, so every phone turn would
 * fail at once with the CLI's own "Not logged in" (issue #71). Null when there is a login.
 */
export function cliLoginWarning(login: ClaudeCodeLogin, binary: string | null): string | null {
  if (login.ok) return null;
  return `Claude Code has no login on this computer, so phone sessions will fail until it has one. ${claudeLoginHint(binary)}`;
}

// ---- launchd ------------------------------------------------------------------------------------

export interface PlistSpec {
  node: string;
  script: string;
  args: string[];
  workingDir: string;
  log: string;
  env: Record<string, string>;
}

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function plist(spec: PlistSpec): string {
  const program = [spec.node, "--disable-warning=ExperimentalWarning", spec.script, ...spec.args];
  const env = Object.entries(spec.env).map(([k, v]) => `\t\t<key>${xml(k)}</key>\n\t\t<string>${xml(v)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
${program.map((a) => `\t\t<string>${xml(a)}</string>`).join("\n")}
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${xml(spec.workingDir)}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
${env}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<key>ProcessType</key>
\t<string>Interactive</string>
\t<key>StandardOutPath</key>
\t<string>${xml(spec.log)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(spec.log)}</string>
</dict>
</plist>
`;
}

/** PATH for the agent: launchd starts it with almost nothing, and the SDK spawns `claude`, which spawns git, rg, node… */
export function agentPath(claudePath: string | undefined, nodePath: string): string {
  if (process.platform !== "darwin") return [...new Set([...(claudePath ? [path.dirname(claudePath)] : []), path.dirname(nodePath), ...((process.env.PATH ?? process.env.Path ?? "").split(path.delimiter))])].join(path.delimiter);
  const dirs = [
    ...(claudePath ? [path.dirname(claudePath)] : []),
    path.dirname(nodePath),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
  ];
  return Array.from(new Set(dirs)).join(":");
}

export interface Paths { home: string; plist: string; log: string }
export function paths(home = os.homedir()): Paths {
  return { home, plist: path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`), log: path.join(home, ".clauderipple", "logs", "host.log") };
}

export function specFor(opts: { script: string; claudePath: string | undefined; node?: string; home?: string; remoteHome?: string }): PlistSpec {
  const node = opts.node ?? process.execPath;
  const p = paths(opts.home);
  return {
    node,
    script: opts.script,
    // installCmd already persists the selected bind in host.json. Repeating it here would
    // overwrite a dashboard change every time launchd restarts the host.
    args: [],
    // The checkout, so relative paths in logs read naturally; modules resolve from the script itself.
    workingDir: path.resolve(path.dirname(opts.script), "..", "..", ".."),
    log: p.log,
    env: {
      PATH: agentPath(opts.claudePath, node),
      HOME: p.home,
      ...(process.platform === "win32" ? { USERPROFILE: p.home } : {}),
      CLAUDERIPPLE_HOME: process.env.CLAUDERIPPLE_HOME ?? path.join(p.home, ".clauderipple"),
      ...(opts.remoteHome ? { RIPPLE_REMOTE_HOME: opts.remoteHome } : {}),
    },
  };
}

type Run = (cmd: string, args: string[]) => { status: number; out: string };
const runSync: Run = (cmd, args) => {
  try { return { status: 0, out: execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
};

const domain = (): string => `gui/${process.getuid?.() ?? 501}`;

export function install(spec: PlistSpec, run: Run = runSync, p: Paths = paths()): string[] {
  const done: string[] = [];
  fs.mkdirSync(path.dirname(p.plist), { recursive: true });
  fs.mkdirSync(path.dirname(spec.log), { recursive: true, mode: 0o700 });
  // A loaded agent keeps its old plist until it is booted out; replace it, do not stack a second one.
  if (run("/bin/launchctl", ["print", `${domain()}/${LABEL}`]).status === 0) {
    run("/bin/launchctl", ["bootout", `${domain()}/${LABEL}`]);
    done.push("stopped the running agent");
  }
  fs.writeFileSync(p.plist, plist(spec), { mode: 0o644 });
  done.push(`wrote ${p.plist}`);
  // Right after a bootout, launchd may still be tearing the old agent down and answers
  // "Bootstrap failed: 5: Input/output error"; the host then stayed down. Give it a few seconds.
  let r = run("/bin/launchctl", ["bootstrap", domain(), p.plist]);
  for (let tries = 1; r.status === 5 && tries < 10; tries++) {
    run("/bin/sleep", ["0.5"]);
    r = run("/bin/launchctl", ["bootstrap", domain(), p.plist]);
  }
  if (r.status !== 0) throw new Error(`launchctl bootstrap failed (${r.status}): ${r.out.trim()}`);
  done.push(`loaded ${LABEL}; logs in ${spec.log}`);
  return done;
}

export function uninstall(run: Run = runSync, p: Paths = paths()): string[] {
  const done: string[] = [];
  if (run("/bin/launchctl", ["print", `${domain()}/${LABEL}`]).status === 0) {
    const r = run("/bin/launchctl", ["bootout", `${domain()}/${LABEL}`]);
    done.push(r.status === 0 ? `stopped ${LABEL}` : `launchctl bootout said (${r.status}): ${r.out.trim()}`);
  } else done.push(`${LABEL} was not loaded`);
  if (fs.existsSync(p.plist)) { fs.rmSync(p.plist); done.push(`removed ${p.plist}`); }
  return done;
}

/** `launchctl print` is not a stable interface; only the two lines a person needs are read, and the raw state is shown as is. */
export function parseLaunchctlPrint(out: string): { state: string | null; pid: number | null; lastExit: string | null } {
  const m = (re: RegExp): string | null => re.exec(out)?.[1]?.trim() ?? null;
  const pid = m(/^\s*pid = (\d+)/m);
  return { state: m(/^\s*state = (.+)$/m), pid: pid ? Number(pid) : null, lastExit: m(/^\s*last exit code = (.+)$/m) };
}

export function agentStatus(run: Run = runSync, p: Paths = paths()): { installed: boolean; loaded: boolean; state: string | null; pid: number | null; lastExit: string | null } {
  const r = run("/bin/launchctl", ["print", `${domain()}/${LABEL}`]);
  const parsed = r.status === 0 ? parseLaunchctlPrint(r.out) : { state: null, pid: null, lastExit: null };
  return { installed: fs.existsSync(p.plist), loaded: r.status === 0, ...parsed };
}
