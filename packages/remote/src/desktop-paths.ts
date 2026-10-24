// Read-only discovery of the packaged Windows Desktop profile shared by CLI and sidebar.
import fs from "node:fs";
import path from "node:path";

/** No preference between accounts/installations: multiple complete profiles are ambiguous. */
export function windowsDesktopRoots(localAppData = process.env.LOCALAPPDATA): string[] {
  if (!localAppData) return [];
  const parent = path.join(localAppData, "Claude-Data");
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(parent, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const roots = entries.filter(entry => entry.isDirectory() && /^claude_/i.test(entry.name)).map(entry => path.join(parent, entry.name))
    .filter(root => ["config.json", "claude_desktop_config.json", "claude-code-sessions", path.join("Local Storage", "leveldb")].every(name => fs.existsSync(path.join(root, name))));
  return roots;
}

export function windowsDesktopRoot(localAppData = process.env.LOCALAPPDATA): string | undefined {
  const roots = windowsDesktopRoots(localAppData);
  return roots.length === 1 ? roots[0] : undefined;
}
