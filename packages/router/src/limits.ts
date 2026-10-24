// Pure per-account limits projection. Legacy windows stay an array for the mod and remote clients.

export type LimitsWindow = { kind: "five_hour" | "seven_day" | "scoped" | "window"; label?: string; used_percent: number; window_minutes?: number; reset_at?: number };
export type UsageWindow = {
  usedPercent: number;
  windowMinutes: number;
  /** Epoch milliseconds (the legacy window's reset_at remains epoch seconds). */
  resetAt?: number;
};
export type WeeklyPace = { expectedPercent: number; paceDelta: number };
export type AccountDetails = {
  id: string;
  label: string;
  preferred: boolean;
  active: boolean;
  /** pausedUntil, like resetAt and fetchedAt, is epoch milliseconds. */
  health: { state: string; pausedUntil?: number };
};
export type LimitsAccount = {
  account: number;
  windows: LimitsWindow[];
  at: number;
} & Partial<AccountDetails & {
  /** Named windows are additive: windows remains the legacy array used by mod/remote. */
  usageWindows: { fiveHour?: UsageWindow; weekly?: UsageWindow };
  unknown: boolean;
  stale: boolean;
  /** Last successful quota fetch, epoch milliseconds; null before the first snapshot. */
  fetchedAt: number | null;
  weeklyPace: WeeklyPace | null;
}>;

/** Clamp elapsed time, not usage: purchased credits may legitimately take usage above 100%. */
export function weeklyPace(weekly: UsageWindow | undefined, now: number): WeeklyPace | null {
  if (!weekly || weekly.resetAt === undefined || !Number.isFinite(weekly.resetAt) || !Number.isFinite(weekly.usedPercent)) return null;
  const week = 7 * 24 * 60 * 60_000;
  const expectedPercent = Math.max(0, Math.min(1, (now - (weekly.resetAt - week)) / week)) * 100;
  return { expectedPercent, paceDelta: weekly.usedPercent - expectedPercent };
}

/** Build both the compatible wire view and the dashboard's named windows without I/O. */
export function buildLimitsAccount(details: AccountDetails, account: number, windows: LimitsWindow[], quota: Record<string, unknown> | null | undefined, now: number, ttlMs: number): LimitsAccount {
  const usageWindows: { fiveHour?: UsageWindow; weekly?: UsageWindow } = {};
  for (const window of windows) {
    const key = window.window_minutes === 300 ? "fiveHour" : window.window_minutes === 10080 && window.kind !== "scoped" ? "weekly" : null;
    if (!key) continue;
    usageWindows[key] = {
      usedPercent: window.used_percent,
      windowMinutes: window.window_minutes ?? (key === "fiveHour" ? 300 : 10080),
      ...(window.reset_at !== undefined ? { resetAt: window.reset_at * 1000 } : {}),
    };
  }
  const fetchedAt = typeof quota?.at === "number" && Number.isFinite(quota.at) ? quota.at : null;
  const unknown = Object.keys(usageWindows).length === 0;
  const state = details.health.state;
  return {
    account, windows, at: fetchedAt ?? 0, ...details,
    health: { ...details.health, state: state === "cooling" ? "paused-until" : state === "quarantined" ? "needs-login" : state },
    usageWindows, fetchedAt, unknown,
    stale: unknown || fetchedAt === null || now - fetchedAt >= ttlMs || quota?.stale === true,
    weeklyPace: weeklyPace(usageWindows.weekly, now),
  };
}
