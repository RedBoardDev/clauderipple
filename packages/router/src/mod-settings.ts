// Persistence and normalization have one source each: the router's locked store
// and the mod's pure schema (no claude-code runtime dependency).
import fs from "node:fs";
import path from "node:path";
import { homeDir } from "./config.ts";
import { withFileLock, writeJsonAtomic } from "./locked-file.ts";
import { MOD_SETTINGS_SCHEMA_VERSION, hadRetiredRouting, normalizeJudgeTargets, normalizeSettings } from "../../mod/hooks/settings.ts";
import type { ModSettingsSnapshot } from "../../mod/types/index.d.ts";

export const MAX_MOD_SETTINGS_BYTES = 64 * 1024;
export type { ModSettingsSnapshot };

export class ModSettingsInputError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * A field that holds a credential: its last word is key, token, secret, password or the like
 * (`apiKey`, `access_token`, `typesafeKey`). The last word decides, so a count such as
 * `keepWarmMinTokens` — a setting the mod has — is not mistaken for one.
 */
function isSecretName(key: string): boolean {
  const last = key.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean).at(-1)?.toLowerCase() ?? "";
  return ["key", "apikey", "token", "secret", "password", "passwd", "authorization", "credential", "credentials", "bearer"].includes(last);
}

/** Iterative traversal also checks objects nested in arrays, without a recursion limit. */
function hasSecretKey(settings: Record<string, unknown>): boolean {
  const pending: unknown[] = [settings];
  while (pending.length) {
    const value = pending.pop();
    if (Array.isArray(value)) pending.push(...value);
    else if (object(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (isSecretName(key)) return true;
        pending.push(child);
      }
    }
  }
  return false;
}

export function validateSettings(settings: unknown): asserts settings is Record<string, unknown> {
  if (!object(settings)) throw new ModSettingsInputError("settings must be a JSON object");
  if (Buffer.byteLength(JSON.stringify(settings), "utf8") > MAX_MOD_SETTINGS_BYTES) throw new ModSettingsInputError("settings exceeds 64 KiB", 413);
  if (hasSecretKey(settings)) throw new ModSettingsInputError("settings must not contain credential fields (key, token, secret, password)");
  // An explicit chain cannot silently become Haiku; malformed persisted chains are corruption too.
  if (Object.hasOwn(settings, "judges") && !normalizeJudgeTargets(settings.judges).length) throw new ModSettingsInputError("judges must contain at least one valid target");
}

export function readModSettings(home = homeDir()): ModSettingsSnapshot {
  let text: string;
  try { text = fs.readFileSync(path.join(home, "mod-settings.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings: normalizeSettings(null), revision: 0, stored: false };
    throw error;
  }
  // Corruption is not an empty store: fail rather than silently overwrite it.
  const stored: unknown = JSON.parse(text);
  if (!object(stored) || !revision(stored.revision) || stored.revision < 1) throw new Error("invalid mod settings store");
  validateSettings(stored.settings);
  // Auto and field rules are gone: the dashboard says so once, until the next save drops them.
  return { settings: normalizeSettings(stored.settings), revision: stored.revision, stored: true, ...(hadRetiredRouting(stored.settings) ? { legacy: true } : {}) };
}

/** Reject old writers before normalization/fill can erase evidence of their format. */
export function validateSettingsSchema(body: unknown): void {
  if (!object(body)) throw new ModSettingsInputError("body must be a JSON object");
  if (body.schemaVersion !== MOD_SETTINGS_SCHEMA_VERSION) throw new ModSettingsInputError("settings schema unsupported; reload ClaudeRipple before saving", 426);
}

/** Exact previous bytes, not the normalized read view; backup failure aborts the write. */
function backupModSettings(file: string, previousRevision: number): void {
  const backup = `${file}.bak-${previousRevision}`;
  fs.copyFileSync(file, backup);
  fs.chmodSync(backup, 0o600);
  // Windows refuses to flush a read-only handle (EPERM, #53), so the backup is opened for writing.
  const fd = fs.openSync(backup, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const backups = fs.readdirSync(path.dirname(file)).filter(name => /^mod-settings\.json\.bak-\d+$/.test(name))
    .sort((a, b) => Number(b.split("-").at(-1)) - Number(a.split("-").at(-1)));
  for (const name of backups.slice(10)) fs.unlinkSync(path.join(path.dirname(file), name));
}

export type ModSettingsWrite = { stale: boolean; current: ModSettingsSnapshot };

/** Compare-and-swap and revision increment share the account stores' cross-process lock. */
export function writeModSettings(body: unknown, home = homeDir()): ModSettingsWrite {
  if (!object(body)) throw new ModSettingsInputError("body must be a JSON object");
  validateSettingsSchema(body);
  validateSettings(body.settings);
  if (body.revision !== undefined && !revision(body.revision)) throw new ModSettingsInputError("revision must be a non-negative safe integer");
  const settings = normalizeSettings(body.settings);
  validateSettings(settings);
  const expected = body.revision;
  const file = path.join(home, "mod-settings.json");
  return withFileLock(file, () => {
    const current = readModSettings(home);
    if (expected !== undefined && expected !== current.revision) return { stale: true, current };
    if (current.revision === Number.MAX_SAFE_INTEGER) throw new Error("mod settings revision exhausted");
    const next: ModSettingsSnapshot = { settings, revision: current.revision + 1, stored: true };
    if (current.stored) backupModSettings(file, current.revision);
    writeJsonAtomic(file, next);
    return { stale: false, current: next };
  });
}
