// Which installation a per-user service definition belongs to.
//
// Every install of an account shares one launchd label, one systemd unit and one Windows task
// name, so a definition is not proof of ownership by itself. Each one records the home it was
// written for (`CLAUDERIPPLE_HOME` in the plist/unit; the launcher path in a task's arguments);
// removing, stopping, restarting or replacing it is allowed only when that record is this home.
// Anything unreadable is "unknown" and is left alone (B01, 2026-10-25).
//
// Pure: parses text and compares paths. It never runs a service manager and never writes.

import fs from "node:fs";
import path from "node:path";

/** What a service definition says about its installation. */
export type Ownership = { state: "absent" | "ours" | "other" | "unknown"; home: string | null };

/** Results of an ownership-gated operation; `"ours"` is not a result because ours acts. */
export type AgentStart = "already-running" | "started" | "failed" | "other-installation" | "ownership-unknown";
/** `identity-unknown`: a process seems to run, but it cannot be proven to be this installation's. */
export type AgentStop = "stopped" | "not-loaded" | "failed" | "other-installation" | "ownership-unknown" | "identity-unknown";
export type AgentRemove = "removed" | "absent" | "other-installation" | "ownership-unknown" | "identity-unknown";
export type AgentRestart = "drained" | "kickstarted" | "direct" | "failed" | "other-installation" | "ownership-unknown" | "identity-unknown";

/** A home as one string: absolute, without a trailing separator, symlinks resolved when it exists. */
export function normalizeHome(home: string): string {
  // A Windows path is compared the way Windows compares it, on any host a test runs on.
  if (/^[A-Za-z]:[\\/]/.test(home) || home.includes("\\")) {
    return path.win32.resolve(home).replace(/\\+$/, "").toLowerCase();
  }
  const resolved = path.resolve(home);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function sameHome(a: string, b: string): boolean {
  return normalizeHome(a) === normalizeHome(b);
}

/**
 * Whether `candidate` is `home` itself or lies under it. Containment alone is not ownership:
 * an installation can contain a nested independent installation.
 */
export function insideHome(candidate: string, home: string): boolean {
  const windows = home.includes("\\") || /^[A-Za-z]:[\\/]/.test(home);
  const resolve = windows ? path.win32.resolve : path.resolve;
  const within = windows ? resolve(candidate).toLowerCase() : resolve(candidate);
  // The home may itself be reached through a symlink (/tmp -> /private/tmp), and the candidate need
  // not exist, so both spellings of the home are compared.
  for (const base of new Set([resolve(home), normalizeHome(home)].map((value) => (windows ? value.toLowerCase() : value)))) {
    if (within === base) return true;
    const separator = windows || base.includes("\\") ? "\\" : "/";
    if (within.startsWith(base + separator)) return true;
  }
  return false;
}

/**
 * Legacy client entries need an exact generated path, not arbitrary containment. A nested config
 * or home marker (including at the candidate itself) disqualifies it. Inspection errors preserve.
 */
export function legacyIntegrationPath(candidate: string, home: string, generated: readonly string[]): boolean {
  if (!generated.some(relative => sameHome(candidate, path.join(home, relative)))) return false;
  const base = normalizeHome(home);
  const resolved = normalizeHome(candidate);
  if (!insideHome(resolved, base) || sameHome(resolved, base)) return false;
  let cursor = resolved;
  while (!sameHome(cursor, base)) {
    for (const marker of ["config.json", "CLAUDERIPPLE_HOME"]) {
      try {
        fs.lstatSync(path.join(cursor, marker));
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") return false;
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
  return true;
}

/** The ownership a definition's recorded home implies. `null` means it recorded none. */
export function ownerOf(recorded: string | null, home: string): Ownership {
  if (!recorded) return { state: "unknown", home: null };
  return { state: sameHome(recorded, home) ? "ours" : "other", home: recorded };
}

function unescapeXml(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/**
 * The `EnvironmentVariables` dict of a launchd plist. Only the first dict after the key is read:
 * renderPlist writes one flat string dict there, so key/string pairs are all it holds.
 */
export function plistEnvironment(xml: string): Record<string, string> {
  const at = xml.indexOf("<key>EnvironmentVariables</key>");
  if (at < 0) return {};
  const open = xml.indexOf("<dict>", at);
  if (open < 0) return {};
  const close = xml.indexOf("</dict>", open);
  const body = xml.slice(open + "<dict>".length, close < 0 ? undefined : close);
  const out: Record<string, string> = {};
  for (const match of body.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g)) {
    out[unescapeXml(match[1]!)] = unescapeXml(match[2]!);
  }
  return out;
}

/** One `Environment=` value of a systemd unit, unquoted the way renderUnit quoted it. */
function unquoteSystemd(value: string): string {
  const inner = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === "%" && inner[i + 1] === "%") {
      out += "%";
      i++;
    } else if (ch === "\\" && (inner[i + 1] === '"' || inner[i + 1] === "\\")) {
      out += inner[i + 1];
      i++;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Every `Environment=` line of a systemd unit. */
export function unitEnvironment(unit: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of unit.matchAll(/^Environment=(.*)$/gm)) {
    const line = match[1]!.trim();
    const inner = line.startsWith('"') ? line.slice(1, -1) : line;
    const eq = inner.indexOf("=");
    if (eq <= 0) continue;
    out[unquoteSystemd(inner.slice(0, eq))] = unquoteSystemd(inner.slice(eq + 1));
  }
  return out;
}

function parentOfFile(file: string): string {
  return /^[A-Za-z]:[\\/]/.test(file) || file.includes("\\") ? path.win32.dirname(file) : path.dirname(file);
}

/**
 * The home a Windows task's action arguments point at: the launcher it runs lives inside that
 * home (`<home>\clauderipple-router.ps1`). `renderLauncher` writes it there, so its parent is the
 * installation's home. Anything else is null — the caller treats that as "unknown", not "ours".
 */
export function launcherHome(argumentsText: string | null | undefined): string | null {
  if (!argumentsText) return null;
  const match = /-File\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(argumentsText);
  const file = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!file) return null;
  // A path relative to whatever directory the task happens to start in says nothing about a home.
  if (!path.isAbsolute(file) && !/^[A-Za-z]:[\\/]/.test(file) && !file.startsWith("\\\\")) return null;
  return parentOfFile(file);
}
