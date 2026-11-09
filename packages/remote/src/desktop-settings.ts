// Claude Desktop's session records are read-only; never infer a target from a prior CLI id.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { object } from "./bridge-client.ts";
import { settingsId } from "./settings-jobs.ts";

export interface AppSettings { appSessionId: string; model: string | undefined; effort: string | undefined }

export class DesktopSettings {
  private root: string;
  private at = -Infinity;
  private current = new Map<string, AppSettings>();
  private now: () => number;
  constructor(root = path.join(os.homedir(), "Library", "Application Support", "Claude"), now: () => number = Date.now) {
    this.now = now;
    this.root = path.join(root, "claude-code-sessions");
  }

  appSessionIdFor(cliSessionId: string): string | undefined { return this.appSettingsFor(cliSessionId)?.appSessionId; }

  appSettingsFor(cliSessionId: string): AppSettings | undefined {
    if (this.now() - this.at >= 3000) this.refresh();
    const value = this.current.get(cliSessionId);
    return value && { ...value };
  }

  private directories(dir: string): string[] {
    try { return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && settingsId(entry.name)).map(entry => path.join(dir, entry.name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }

  /** One record the app is mid-write on, or two records naming one CLI id, leaves that record (or id)
   * out rather than failing every lookup: an ambiguous id is never guessed at. */
  private refresh(): void {
    const next = new Map<string, AppSettings>();
    const ambiguous = new Set<string>();
    for (const account of this.directories(this.root)) for (const scope of this.directories(account)) {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(scope, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      for (const entry of entries) {
        if (!entry.isFile() || !/^local_[\w-]{1,94}\.json$/.test(entry.name)) continue;
        const file = path.join(scope, entry.name);
        let raw: string;
        try {
          const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          try { raw = fs.readFileSync(fd, "utf8"); } finally { fs.closeSync(fd); }
        } catch { continue; }
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { continue; }
        const row = object(parsed), appSessionId = entry.name.slice(0, -5);
        if (!row || !settingsId(row.cliSessionId)) continue;
        if (row.sessionId !== undefined && row.sessionId !== appSessionId) continue;
        if (next.has(row.cliSessionId)) { ambiguous.add(row.cliSessionId); continue; }
        next.set(row.cliSessionId, { appSessionId, model: typeof row.model === "string" ? row.model : undefined, effort: typeof row.effort === "string" ? row.effort : undefined });
      }
    }
    for (const id of ambiguous) next.delete(id);
    this.current = next; this.at = this.now();
  }
}
