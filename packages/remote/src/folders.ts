// Folders the phone can start a session in: recent ones first (this host's sessions, then the
// folders Claude Code itself has worked in), then plain browsing. A token holder can already run
// any command through a session, so browsing is not a boundary; it only lists directories.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowseResult, FolderEntry } from "./protocol.ts";

const BROWSE_CAP = 300;
/** Scratch and worktree folders are noise in a "recent" list a person picks from. */
const NOISE = [/\/\.claude\/worktrees\//i, /^\/private\/tmp\//, /^\/tmp\//, /^\/var\/folders\//, /\/node_modules\//i];
export function noisyFolder(folder: string, temp = os.tmpdir()): boolean {
  const normalized = folder.replace(/\\/g, "/").replace(/\/$/, "") + "/";
  const tempRoot = temp.replace(/\\/g, "/").replace(/\/$/, "") + "/";
  return normalized.toLowerCase().startsWith(tempRoot.toLowerCase()) || NOISE.some(r => r.test(normalized));
}

export interface RecentSource { path: string; lastUsed: number; model?: string }

export async function isDirectory(p: string): Promise<boolean> {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}

export const MAC_CONSENT_PENDING = "Mac에 폴더 접근 허용 창이 떠 있습니다. 컴퓨터에서 '허용'을 누른 뒤 다시 시도해 주세요.";
export const MAC_CONSENT_DENIED = "macOS가 이 폴더 접근을 막았습니다. Mac의 시스템 설정 → 개인정보 보호 및 보안 → 파일 및 폴더에서 허용해 주세요.";

/** Where macOS asks the person before a process first reads: Desktop, Documents, Downloads, iCloud Drive, other volumes. */
export function macProtected(p: string, home = os.homedir()): boolean {
  const abs = path.resolve(p);
  const under = (root: string): boolean => abs === root || abs.startsWith(root + path.sep);
  return ["Desktop", "Documents", "Downloads", path.join("Library", "Mobile Documents")].some(d => under(path.join(home, d))) || under("/Volumes");
}

/**
 * A read of a macOS-protected folder waits on the Mac's "would like to access" dialog, so from the
 * phone a folder never opened before looked like nothing happening, then "did not answer in time"
 * (2026-10-22). One that has not answered in `wait` ms is reported as that dialog; one refused
 * (EPERM) says where to allow it. The read itself goes on, so the dialog stays up to be answered.
 */
export async function macConsent<T>(p: string, work: () => Promise<T>, o: { platform?: NodeJS.Platform; home?: string; wait?: number } = {}): Promise<T> {
  if ((o.platform ?? process.platform) !== "darwin" || !macProtected(p, o.home)) return work();
  const running = work();
  running.catch(() => { /* answered after the phone was told; nobody waits on it */ });
  let timer: NodeJS.Timeout | undefined;
  const asking = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(MAC_CONSENT_PENDING)), o.wait ?? 2000); });
  try { return await Promise.race([running, asking]); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") throw new Error(MAC_CONSENT_DENIED);
    throw error;
  } finally { clearTimeout(timer); }
}

/** A folder this process can list: false when it is missing or not a folder; a refusal is thrown. */
export async function readableFolder(p: string): Promise<boolean> {
  try { await fs.readdir(p); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/** One path segment: no separators, control characters or the reserved names "." and "..". */
const FOLDER_NAME = /^[^/\\\u0000-\u001f]{1,100}$/;

/** Make a folder directly inside `parent`, returning its path. The name is one segment and must
 * not already exist; nothing outside `parent` can be reached. */
export async function makeFolder(parent: string, name: string): Promise<string> {
  const dir = path.resolve(parent || os.homedir());
  if (!(await isDirectory(dir))) throw new Error("That parent folder can't be opened");
  const segment = name.trim();
  if (!segment || segment === "." || segment === ".." || !FOLDER_NAME.test(segment)) throw new Error("Invalid folder name");
  const target = path.join(dir, segment);
  await fs.mkdir(target);
  return target;
}

export async function recentFolders(sources: RecentSource[], limit = 12): Promise<FolderEntry[]> {
  const best = new Map<string, RecentSource>();
  for (const s of sources) {
    if (!path.isAbsolute(s.path) || noisyFolder(s.path)) continue;
    const prev = best.get(s.path);
    if (!prev || s.lastUsed > prev.lastUsed) {
      // Keep the model the host knows about even when the CLI's own record is newer.
      const model = s.model ?? prev?.model;
      best.set(s.path, { path: s.path, lastUsed: s.lastUsed, ...(model ? { model } : {}) });
    } else if (s.model && !prev.model) best.set(s.path, { ...prev, model: s.model });
  }
  const sorted = Array.from(best.values()).sort((a, b) => b.lastUsed - a.lastUsed);
  const out: FolderEntry[] = [];
  // A recent folder whose check waits on the Mac's access dialog stays listed, and the protected ones
  // after it go unchecked rather than each holding the list; picking one reports the dialog (Sessions.createNew).
  let asking = false;
  for (const s of sorted) {
    if (out.length >= limit) break;
    const protectedHere = process.platform === "darwin" && macProtected(s.path);
    if (!(asking && protectedHere)) {
      try { if (!(await macConsent(s.path, () => isDirectory(s.path), { wait: 500 }))) continue; }
      catch { asking = true; }
    }
    out.push({ path: s.path, name: path.basename(s.path) || s.path, lastUsed: s.lastUsed, ...(s.model ? { model: s.model } : {}) });
  }
  return out;
}

/**
 * The drive roots this Windows machine answers for (`C:\`, `E:\`, …). A: and B: are floppy letters
 * that can stall; a mapped drive that does not answer within a second is left out.
 */
export async function windowsDrives(platform: NodeJS.Platform = process.platform): Promise<string[]> {
  if (platform !== "win32") return [];
  const roots = "CDEFGHIJKLMNOPQRSTUVWXYZ".split("").map(letter => `${letter}:\\`);
  const found = await Promise.all(roots.map(root => Promise.race([
    isDirectory(root).then(ok => (ok ? root : null)),
    new Promise<null>(resolve => setTimeout(resolve, 1000, null).unref()),
  ])));
  return found.filter((root): root is string => root !== null);
}

export async function browse(target: string | undefined, hidden = false, home = os.homedir(), drives: () => Promise<string[]> = windowsDrives): Promise<BrowseResult> {
  const dir = path.resolve(target && target.trim() ? target : home);
  const dirents = await macConsent(dir, () => fs.readdir(dir, { withFileTypes: true }), { home });
  const names: string[] = [];
  for (const d of dirents) {
    if (!hidden && d.name.startsWith(".")) continue;
    if (d.isDirectory()) names.push(d.name);
    else if (d.isSymbolicLink() && (await isDirectory(path.join(dir, d.name)))) names.push(d.name);
  }
  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
  const parent = path.dirname(dir);
  // A drive root has no parent to go up to, so on Windows the other drives are listed first: a
  // project on E: was out of reach from a browse that starts in C:\Users (Discord, 2026-10-22).
  const others = parent === dir ? (await drives()).filter(root => root.toLowerCase() !== dir.toLowerCase()) : [];
  const entries = [...others.map(root => ({ path: root, name: root })), ...names.slice(0, BROWSE_CAP).map((name) => ({ path: path.join(dir, name), name }))];
  return { path: dir, parent: parent === dir ? null : parent, home, entries, truncated: names.length > BROWSE_CAP };
}
