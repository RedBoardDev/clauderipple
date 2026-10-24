// How much of each Claude subscription account's limits is used, for the dashboard and the tray.
//
// Response headers would only describe the account that last answered, so an idle second account
// would never show a number. Claude Code's own `/usage` asks `GET /api/oauth/usage` with the
// account's OAuth headers instead, and so does this. Shape measured 2026-09-28 (CLI 2.1.281):
//   {"five_hour": {"utilization": 14.0, "resets_at": "2026-09-28T08:30:00.581181+00:00", …},
//    "seven_day": {"utilization": 10.0, "resets_at": "…"}, "seven_day_opus": null, …}
// `utilization` is a percentage. It is mapped onto the Codex snapshot shape
// (`rate_limits.primary/secondary` with `used_percent`, `window_minutes`, `reset_at` in seconds)
// so the GUI and the tray read one format for every account.

import type { Credential } from "../pool.ts";

type Window = { utilization?: unknown; resets_at?: unknown } | null | undefined;

/** One entry of the `/api/oauth/usage` body's `limits` array (shape measured 2026-10-15). */
type ScopedEntry = {
  kind?: unknown;
  group?: unknown;
  percent?: unknown;
  resets_at?: unknown;
  scope?: { model?: { id?: unknown; display_name?: unknown } | null } | null;
} | null | undefined;

const FIVE_HOURS = 5 * 60;
const WEEK = 7 * 24 * 60;

export function claudeUsageFromBody(body: unknown): Record<string, unknown> | null {
  const b = body as { five_hour?: Window; seven_day?: Window; limits?: unknown } | null;
  const win = (w: Window, minutes: number): Record<string, number> | null => {
    if (!w || typeof w.utilization !== "number" || !Number.isFinite(w.utilization)) return null;
    const out: Record<string, number> = { used_percent: w.utilization, window_minutes: minutes };
    const at = typeof w.resets_at === "string" ? Date.parse(w.resets_at) : NaN;
    if (Number.isFinite(at)) out.reset_at = Math.round(at / 1000);
    return out;
  };
  const primary = win(b?.five_hour, FIVE_HOURS);
  const secondary = win(b?.seven_day, WEEK);
  if (!primary && !secondary) return null;
  const scoped = scopedFromLimits(b?.limits);
  return {
    type: "claude.usage",
    rate_limits: { primary: primary ?? secondary, secondary: primary ? secondary : null },
    ...(scoped.length ? { scoped } : {}),
    at: Date.now(),
  };
}

/**
 * Per-model weekly windows from the same body: entries of `limits` with kind `weekly_scoped`
 * carry the model in `scope.model.display_name` (measured 2026-10-15:
 * `{"kind":"weekly_scoped","group":"weekly","percent":2,…,"scope":{"model":{"id":null,
 * "display_name":"Fable"},"surface":null},"is_active":false}`). They ride beside
 * `rate_limits` (which the GUI and the tray read) so those readers keep working unchanged.
 */
function scopedFromLimits(limits: unknown): Record<string, number | string>[] {
  if (!Array.isArray(limits)) return [];
  const out: Record<string, number | string>[] = [];
  for (const entry of limits as ScopedEntry[]) {
    if (!entry || typeof entry !== "object" || entry.kind !== "weekly_scoped") continue;
    const name = entry.scope?.model?.display_name;
    const percent = entry.percent;
    if (typeof name !== "string" || !name || typeof percent !== "number" || !Number.isFinite(percent)) continue;
    const w: Record<string, number | string> = { name, used_percent: percent, window_minutes: WEEK };
    const at = typeof entry.resets_at === "string" ? Date.parse(entry.resets_at) : NaN;
    if (Number.isFinite(at)) w.reset_at = Math.round(at / 1000);
    out.push(w);
  }
  return out;
}

type UsageSource = { credentials(): Promise<Credential[]> };
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type UsageOptions = {
  /** The Anthropic API host (`config.upstream`). */
  upstream: () => string;
  fetch?: FetchLike;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
  warn?: (message: string) => void;
};

/**
 * Per-account snapshots, fetched at most once per `ttlMs` per account. The GUI polls the status
 * every five seconds and the tray as often; a limit that moves by a percent in minutes does not
 * need more. A failed lookup keeps the last good numbers rather than blanking them.
 */
export class ClaudeUsage {
  private readonly last = new Map<string, Record<string, unknown>>();
  private inFlight: Promise<Record<string, Record<string, unknown>>> | null = null;
  private nextFetchAt = Number.NEGATIVE_INFINITY;
  private readonly schedule = new Map<string, { at: number; retrying: boolean }>();
  private sourceRetrying = false;
  private readonly source: UsageSource;
  private readonly opts: UsageOptions;

  constructor(source: UsageSource, opts: UsageOptions) {
    this.source = source;
    this.opts = opts;
  }

  /** Snapshots by account owner id ("current" for the Claude Code login). */
  snapshot(force = false): Promise<Record<string, Record<string, unknown>>> {
    if (this.inFlight) return this.inFlight;
    const now = (this.opts.now ?? Date.now)();
    if (!force && now < this.nextFetchAt) return Promise.resolve(Object.fromEntries(this.last));
    this.inFlight = this.fetchAll(force).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async fetchAll(force: boolean): Promise<Record<string, Record<string, unknown>>> {
    const now = this.opts.now ?? Date.now;
    const ttl = this.opts.ttlMs ?? 5 * 60_000;
    let credentials: Credential[];
    try {
      credentials = await this.source.credentials();
      this.sourceRetrying = false;
    } catch (e) {
      this.opts.warn?.(`claude usage: no credentials: ${(e as Error).message}`);
      this.sourceRetrying = force || !this.sourceRetrying;
      this.nextFetchAt = now() + (this.sourceRetrying ? 15_000 : ttl);
      for (const [owner, snapshot] of this.last) this.last.set(owner, { ...snapshot, stale: true });
      return Object.fromEntries(this.last);
    }
    await Promise.all(credentials.map(async (credential) => {
      const owner = credential.ownerId ?? credential.id;
      const previousSchedule = this.schedule.get(owner);
      if (!force && previousSchedule && now() < previousSchedule.at) return;
      const snapshot = await this.fetchOne(credential);
      // Only the failed owner retries: a healthy account retains its full five-minute TTL.
      const retrying = !snapshot && (force || !previousSchedule?.retrying);
      this.schedule.set(owner, { at: now() + (retrying ? 15_000 : ttl), retrying });
      if (snapshot) this.last.set(owner, { ...snapshot, at: now() });
      else {
        const previous = this.last.get(owner);
        if (previous) this.last.set(owner, { ...previous, stale: true });
      }
    }));
    // An account that was removed must not keep its old numbers on the screen.
    const owners = new Set(credentials.map((c) => c.ownerId ?? c.id));
    for (const owner of this.last.keys()) if (!owners.has(owner)) this.last.delete(owner);
    for (const owner of this.schedule.keys()) if (!owners.has(owner)) this.schedule.delete(owner);
    this.nextFetchAt = this.schedule.size ? Math.min(...Array.from(this.schedule.values(), (s) => s.at)) : now() + ttl;
    return Object.fromEntries(this.last);
  }

  private async fetchOne(credential: Credential): Promise<Record<string, unknown> | null> {
    const owner = (credential.ownerId ?? credential.id).slice(0, 8);
    try {
      const res = await (this.opts.fetch ?? fetch)(`https://${this.opts.upstream()}/api/oauth/usage`, {
        method: "GET",
        headers: { ...credential.headers, accept: "application/json" },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
      });
      if (!res.ok) {
        // The status alone: the body of an auth failure is not worth the risk of echoing.
        this.opts.warn?.(`claude usage ${owner}: HTTP ${res.status}`);
        return null;
      }
      return claudeUsageFromBody(await res.json());
    } catch (e) {
      this.opts.warn?.(`claude usage ${owner}: ${(e as Error).message}`);
      return null;
    }
  }
}
