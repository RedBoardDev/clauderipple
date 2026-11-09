// A read-only view of the folder a session works in. The phone may list it and read one small file
// at a time; nothing writable, and nothing outside that folder — including through a symlink. Large
// files are not read: the listing says how big they are and the app shows the full path instead.
import fs from "node:fs/promises";
import path from "node:path";
import { ATTACHMENT_CAP, type FolderFile, type FolderListing, type SessionFolderEntry } from "./protocol.ts";

const LIST_CAP = 200;
/** Base64 plus the timeline around it: above this the phone shows the path, not the file. */
export const FOLDER_READ_CAP = 1024 * 1024;

const MEDIA: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  pdf: "application/pdf", html: "text/html", htm: "text/html", md: "text/markdown", markdown: "text/markdown",
  txt: "text/plain", json: "text/plain", log: "text/plain", csv: "text/plain", ts: "text/plain", tsx: "text/plain",
  js: "text/plain", jsx: "text/plain", py: "text/plain", go: "text/plain", rs: "text/plain", css: "text/plain",
  yml: "text/plain", yaml: "text/plain", toml: "text/plain", sh: "text/plain", sql: "text/plain",
};
export function folderMediaType(name: string): string {
  return MEDIA[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

/** The real path of `requested` if it is the session folder or below it; never a sibling or parent. */
async function contained(cwd: string, requested: string | undefined): Promise<{ root: string; real: string }> {
  const root = await fs.realpath(cwd);
  const named = requested?.trim() ? requested : ".";
  if (path.isAbsolute(named)) throw new Error("Use a path inside the session folder");
  const target = path.resolve(root, named);
  const within = (p: string): boolean => p === root || p.startsWith(root + path.sep);
  if (!within(target)) throw new Error("Path is outside the session folder");
  // A symlink inside the folder may still point at the user's home; the resolved path decides.
  const real = await fs.realpath(target);
  if (!within(real)) throw new Error("Path leads outside the session folder");
  return { root, real };
}

export async function listSessionFolder(cwd: string, requested?: string): Promise<FolderListing> {
  const { root, real } = await contained(cwd, requested);
  const dirents = await fs.readdir(real, { withFileTypes: true });
  const entries: SessionFolderEntry[] = [];
  for (const dirent of dirents.slice(0, LIST_CAP * 4)) {
    if (dirent.name.startsWith(".")) continue;
    const full = path.join(real, dirent.name);
    let dir = dirent.isDirectory();
    let bytes: number | null = null;
    let blocked = false;
    try {
      const info = await fs.stat(full);
      bytes = info.isDirectory() ? null : info.size;
      if (dirent.isSymbolicLink()) {
        // Show the link, but never let a tap leave the session folder.
        const resolved = await fs.realpath(full);
        if (resolved !== root && !resolved.startsWith(root + path.sep)) blocked = true;
        else dir = (await fs.stat(resolved)).isDirectory();
      } else dir = info.isDirectory();
    } catch { blocked = true; }
    entries.push({ name: dirent.name, path: path.relative(root, full).split(path.sep).join("/"), dir, bytes, ...(blocked ? { blocked: true } : {}) });
  }
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  return {
    path: path.relative(root, real).split(path.sep).join("/") || ".",
    parent: real === root ? null : path.relative(root, path.dirname(real)).split(path.sep).join("/") || ".",
    entries: entries.slice(0, LIST_CAP),
    truncated: entries.length > LIST_CAP,
  };
}

/** One small file, base64. Larger files are refused by name and size, never truncated silently. */
export async function readSessionFolderFile(cwd: string, requested: string): Promise<FolderFile> {
  const { real } = await contained(cwd, requested);
  const info = await fs.stat(real);
  if (!info.isFile()) throw new Error("That is not a file");
  if (info.size > Math.min(ATTACHMENT_CAP, FOLDER_READ_CAP)) throw new Error("File is too large to read on the phone");
  const bytes = await fs.readFile(real);
  return { path: requested, name: path.basename(real), mediaType: folderMediaType(real), bytes: bytes.length, data: bytes.toString("base64") };
}
