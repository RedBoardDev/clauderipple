// Tray-side view of /api/status. Fields stay optional for routers predating automatic updates.
export type RouterUpdate = {
  enabled?: boolean;
  running?: boolean;
  hostUpdate?: { version: string; status: "pending" | "applied" | "skipped"; error?: string };
  kind?: string;
  available?: string;
  lastUpdatedFrom?: string;
  lastUpdatedTo?: string;
  lastUpdatedAt?: number;
  lastError?: string;
};
export type UpdateSeen = { updated: string[]; available: string[] };
export type UpdateNotice = { kind: "updated"; version: string; relaunch: boolean } | { kind: "available"; version: string };

export function readUpdateSeen(value: unknown): UpdateSeen {
  if (!value || typeof value !== "object") throw new Error("invalid update notification state");
  const s = value as Partial<UpdateSeen>;
  if (!Array.isArray(s.updated) || !Array.isArray(s.available)
    || [...s.updated, ...s.available].some((v) => typeof v !== "string")) throw new Error("invalid update notification versions");
  return { updated: s.updated, available: s.available };
}

/** No I/O or Electron: only confirmed completion is a reason to replace a running tray. */
export function updateNotice(routerVersion: string, trayVersion: string, state: RouterUpdate | undefined, seen: UpdateSeen): UpdateNotice | null {
  if (!state) return null;
  if (!state.running && state.lastUpdatedTo === routerVersion && state.lastUpdatedFrom && state.lastUpdatedFrom !== routerVersion
    && typeof state.lastUpdatedAt === "number" && Number.isFinite(state.lastUpdatedAt) && !seen.updated.includes(routerVersion)) {
    return { kind: "updated", version: routerVersion, relaunch: trayVersion !== routerVersion && (state.kind === "script" || state.kind === "npm") };
  }
  const version = state.available;
  const automatic = state.enabled !== false && (state.kind === "script" || state.kind === "npm");
  if (version && version !== routerVersion && !state.running && !automatic && !seen.available.includes(version)) {
    return { kind: "available", version };
  }
  return null;
}
/** Replacement completion is not notification history. Failed launches back off, even on the same target. */
export class TrayReplacement {
  private active = false;
  private target = "";
  private completed = "";
  private retryAt = 0;
  private failures = 0;
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  async reconcile(routerVersion: string, trayVersion: string, state: RouterUpdate | undefined, replace: () => Promise<void>): Promise<void> {
    const notice = updateNotice(routerVersion, trayVersion, state, { updated: [], available: [] });
    if (notice?.kind !== "updated" || !notice.relaunch || this.active || this.completed === routerVersion) return;
    if (this.target !== routerVersion) { this.target = routerVersion; this.retryAt = 0; this.failures = 0; }
    if (this.now() < this.retryAt) return;
    this.active = true;
    try { await replace(); this.completed = routerVersion; }
    catch (error) {
      this.retryAt = this.now() + Math.min(15 * 60_000, 60_000 * 2 ** this.failures++);
      throw error;
    } finally { this.active = false; }
  }
}

export function rememberUpdate(seen: UpdateSeen, notice: UpdateNotice): UpdateSeen {
  return { ...seen, [notice.kind]: [...new Set([...seen[notice.kind], notice.version])] };
}
