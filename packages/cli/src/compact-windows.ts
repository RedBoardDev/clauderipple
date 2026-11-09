// Per-model compaction settings share settings.json's lock and installation ownership store.
import fs from "node:fs";
import { withFileLock, writeJsonAtomic } from "../../router/src/locked-file.ts";
import { claimsOf, ownerHomeKey, ownersPath, readOwners, setClaims, type OwnerStore } from "./owners.ts";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function tokens(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}
export function readCompactSettings(file: string): Record<string, unknown> {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  const value: unknown = text.trim() ? JSON.parse(text) : {};
  if (!object(value)) throw new Error("settings.json is not a JSON object; left untouched");
  return value;
}
function entry(settings: Record<string, unknown>, id: string): Record<string, unknown> {
  const models = object(settings.modelSettings) ? settings.modelSettings : {};
  return object(models[id]) ? models[id] : {};
}
function managed(store: OwnerStore, id: string, value: unknown): boolean {
  return Object.values(store.homes).some(claim => claim.compactWindows?.[id] === value && value !== undefined);
}

/** Generated values are not user preferences: otherwise lowering then raising the global sticks. */
export function effectiveCompactWindow(id: string, capacity: number | null, settings: Record<string, unknown>, store: OwnerStore): number | null {
  if (capacity === null) return null;
  const value = entry(settings, id).autoCompactWindow;
  const own = managed(store, id, value) ? null : tokens(value);
  return Math.min(capacity, own ?? tokens(settings.autoCompactWindow) ?? capacity);
}

/** Caller holds the settings lock. Also used by uninstall before releasing the other claims. */
export function reconcileCompactWindows(file: string, home: string, windows: Record<string, number>): boolean {
  const settings = readCompactSettings(file);
  const record = readOwners(file);
  if (record.error) throw new Error(record.error);
  const mine = claimsOf(record.store, home);
  if (settings.modelSettings !== undefined && !object(settings.modelSettings)) throw new Error("modelSettings is not an object; left untouched");
  const models = { ...(object(settings.modelSettings) ? settings.modelSettings : {}) };
  const nextClaims: Record<string, number> = {};
  const ids = new Set([...Object.keys(mine.compactWindows ?? {}), ...Object.keys(windows)]);
  for (const id of ids) {
    const current = entry(settings, id);
    const value = current.autoCompactWindow;
    const ours = value !== undefined && mine.compactWindows?.[id] === value;
    const elsewhere = Object.entries(record.store.homes).some(([key, claim]) => key !== ownerHomeKey(home) && claim.compactWindows?.[id] === value && value !== undefined);
    // Another installation or a hand edit wins. Do not adopt even an identical hand-written value.
    if (elsewhere || value !== undefined && !ours) continue;
    if (models[id] !== undefined && !object(models[id])) continue;
    const capacity = windows[id];
    const window = capacity === undefined ? null : effectiveCompactWindow(id, capacity, settings, record.store);
    // Claude Code ignores values outside 100K–1M; such a model keeps Claude Code's own default
    // rather than stopping every other model's entry from being written.
    if (window !== null && window >= 100_000 && window <= 1_000_000) {
      models[id] = { ...current, autoCompactWindow: window };
      nextClaims[id] = window;
    } else if (ours) {
      const { autoCompactWindow: _owned, ...rest } = current;
      if (Object.keys(rest).length) models[id] = rest;
      else delete models[id];
    }
  }
  const next = { ...settings };
  if (JSON.stringify(models) !== JSON.stringify(settings.modelSettings ?? {})) {
    if (Object.keys(models).length) next.modelSettings = models;
    else delete next.modelSettings;
  }
  const changed = JSON.stringify(next) !== JSON.stringify(settings);
  if (changed && fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.bak-clauderipple-compact`);
    fs.chmodSync(`${file}.bak-clauderipple-compact`, 0o600);
  }
  // Record first, matching settings.ts: a crash must not leave a written value with no owner.
  setClaims(record.store, home, { ...mine, compactWindows: nextClaims });
  if (JSON.stringify(record.store) !== JSON.stringify(readOwners(file).store)) {
    if (Object.keys(record.store.homes).length) writeJsonAtomic(ownersPath(file), record.store);
    else fs.rmSync(ownersPath(file), { force: true });
  }
  if (changed) writeJsonAtomic(file, next);
  return changed;
}

export function syncCompactWindows(file: string, home: string, windows: Record<string, number>): boolean {
  return withFileLock(file, () => reconcileCompactWindows(file, home, windows));
}
