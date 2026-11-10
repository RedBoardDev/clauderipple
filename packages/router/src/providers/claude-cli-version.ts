// Claude Code names its own version in `user-agent` (`claude-cli/<version>`) and Anthropic refuses
// a model to a client below a floor it raises over time ("Claude Code 2.1.266 does not support this
// model; version 2.1.280 or newer is required", issue #103). The fallback headers therefore take
// the newest version this machine can vouch for instead of a constant that ages:
//   1. a real Claude Code request observed within the snapshot's TTL,
//   2. the newest CLI the Desktop app has cached (directory names only, no child process),
//   3. CLAUDE_CLI_FALLBACK_VERSION.
// The directory scan is cached because the headers are built on the request path.

import fs from "node:fs";
import { desktopClaudeCodeDirs } from "../../../cli/src/claude-auth.ts";

/** Last resort when nothing newer is available. Check `claude --version` when cutting a release. */
export const CLAUDE_CLI_FALLBACK_VERSION = "2.1.304";

const INSTALLED_VERSION_TTL_MS = 5 * 60_000;
const installed = new Map<string, { value: string | null; at: number }>();

/** A bare version or a `claude-cli/<version> (external, cli)` user-agent; anything else is null. */
export function parseClaudeCliVersion(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  const match = /^claude-cli\/(\d+\.\d+\.\d+)(?:\s|$)/i.exec(text) ?? /^(\d+\.\d+\.\d+)$/.exec(text);
  return match?.[1] ?? null;
}

export function claudeCliUserAgent(version: string): string {
  return `claude-cli/${version} (external, cli)`;
}

/** Newest CLI the Desktop app has cached on this machine. Read-only directory names, no child process. */
export function installedClaudeCliVersion(directories: readonly string[] = desktopClaudeCodeDirs(), now = Date.now()): string | null {
  const key = directories.join("\0");
  const cached = installed.get(key);
  if (cached && now >= cached.at && now - cached.at < INSTALLED_VERSION_TTL_MS) return cached.value;
  const versions: string[] = [];
  for (const directory of directories) {
    try {
      versions.push(...fs.readdirSync(directory).filter((entry) => /^\d+\.\d+\.\d+$/.test(entry)));
    } catch {
      // Not this platform's layout, or no Desktop app: the next source answers.
    }
  }
  versions.sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const value = versions.at(-1) ?? null;
  installed.set(key, { value, at: now });
  return value;
}

export type ClaudeCliVersionSources = {
  /** `user-agent` (or bare version) of a real Claude Code request still inside its observation TTL. */
  observed?: string | null;
  /** Newest CLI installed on this machine. Defaults to the Desktop app's cached versions. */
  installed?: () => string | null;
};

/** Observed request first, then this machine's CLI, then the constant. */
export function claudeCliVersion(sources: ClaudeCliVersionSources = {}): string {
  return parseClaudeCliVersion(sources.observed)
    ?? parseClaudeCliVersion((sources.installed ?? installedClaudeCliVersion)())
    ?? CLAUDE_CLI_FALLBACK_VERSION;
}
