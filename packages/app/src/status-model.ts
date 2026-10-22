// The tray's reading of what `clauderipple doctor` / `repair` / `direct` answer. Pure: no Electron,
// no I/O, so `node --test` runs it as it is. What the dashboard draws from the same answers lives in
// packages/ui/app.js (the connection card); this is only what the main process decides itself.

/** `clauderipple doctor --json`. Every field may be missing from a CLI older or newer than this app. */
export type Doctor = {
  mode?: "ripple" | "direct" | "mixed";
  router?: { responding?: boolean; version?: string | null; pid?: number | null; url?: string; adminUrl?: string };
  supervisor?: { registered?: boolean; program?: string | null; programExists?: boolean; state?: string | null };
  desktop?: { proxy?: "ripple" | "none" | "other"; url?: string | null };
  cli?: { proxy?: "ripple" | "none" | "other"; url?: string | null };
  problems?: { code?: string; message?: string }[];
};

/** `clauderipple repair --json`. */
export type RepairOutput = { ok?: boolean; steps?: { name?: string; ok?: boolean; detail?: string }[]; doctor?: Doctor };
/** `clauderipple direct on|off --json`. */
export type DirectOutput = { ok?: boolean; mode?: string; restartClaude?: boolean; detail?: string };

export type Action = "repair" | "direct-on" | "direct-off" | "restart-claude";
export type Busy = Action | "checking" | null;

/** What the last action ended with; `details` are lines for the dashboard's "Details" fold. */
export type ActionResult = { action: Action; ok: boolean; timedOut?: boolean; details: string[]; at: number };

/** What the dashboard's connection card is drawn from (sent over the preload bridge). */
export type AppState = {
  doctor: Doctor | null;
  /** The CLI could not be run, or said something that is not JSON. */
  doctorFailed: boolean;
  /** The tray's own poll of the admin API: fresher than doctor. Null before the first answer. */
  routerAnswering: boolean | null;
  busy: Busy;
  result: ActionResult | null;
  /** A switch was made and Claude Desktop has not been reopened since. */
  restartClaude: boolean;
  loginItem: boolean;
  appVersion: string;
  platform: string;
};

/**
 * The CLI prints one JSON object on stdout. Anything else on stdout (a warning a dependency printed,
 * a stray blank line) must not lose it, so the last line that parses as an object wins, and failing
 * that the whole text.
 */
export function parseJsonOutput<T extends object>(stdout: string): T | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = tryObject(lines[i]!);
    if (parsed) return parsed as T;
  }
  const whole = tryObject(stdout.trim());
  return whole ? (whole as T) : null;
}

function tryObject(text: string): object | null {
  if (!text.startsWith("{")) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** The last `count` non-empty lines of a log's tail. */
export function tailLines(text: string, count: number): string[] {
  return text.split(/\r?\n/).filter((l) => l.trim().length > 0).slice(-count);
}

/** The tray icon: the direct mode is a choice, not an outage, and gets its own mark. */
export function trayState(health: "ok" | "warn" | "down", doctor: Doctor | null): "ok" | "warn" | "down" | "direct" {
  if (doctor?.mode === "direct") return "direct";
  return health;
}

/**
 * Whether the "Ripple is not responding" notification should go out now. Once per outage (the
 * caller clears `alreadyNotified` when the router answers again), not while an update or one of our
 * own actions restarts it on purpose, and never in the direct mode, where the router being off is
 * the point.
 */
export function shouldNotifyDown(o: { downForMs: number; graceMs: number; alreadyNotified: boolean; updating: boolean; busy: boolean; mode: Doctor["mode"] | null }): boolean {
  return !o.alreadyNotified && !o.updating && !o.busy && o.downForMs >= o.graceMs && o.mode !== "direct";
}

/**
 * Whether the "reopen Claude" step is still owed after a connection change at `changedAt`. Claude
 * picks the change up on its next start, whoever restarts it: a Claude that is not running, or one
 * that started after the change, owes nothing. Only an unknown start time keeps the step — the
 * button used to be the only way to clear it, so reopening by hand left it on screen for good.
 */
export function restartStillOwed(changedAt: number, claudeStartedAt: number | null | undefined): boolean {
  if (claudeStartedAt === undefined) return true;
  return claudeStartedAt !== null && claudeStartedAt <= changedAt;
}

/** Lines for the "Details" fold after a repair: each step as ✓/✗ with what it said. */
export function repairDetails(out: RepairOutput | null, raw: string): string[] {
  if (!out?.steps?.length) return raw ? tailLines(raw, 12) : [];
  return out.steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.name ?? "?"}${s.detail ? ` — ${s.detail}` : ""}`);
}

/**
 * Where a ripple:// request goes: the dashboard's own files, or the router's admin API. Returns
 * null for a path that would leave the UI folder.
 */
export function routeRequest(pathname: string): { kind: "api" } | { kind: "file"; rel: string } | null {
  if (pathname === "/api" || pathname.startsWith("/api/")) return { kind: "api" };
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const rel = decoded === "/" || decoded === "" ? "index.html" : decoded === "/favicon.ico" ? "favicon-32.png" : decoded.replace(/^\/+/, "");
  const parts = rel.split(/[\\/]+/);
  if (parts.some((p) => p === ".." || p === "")) return null;
  // A path with no extension is the dashboard routing itself (as the router serves it).
  if (!/\.[a-z0-9]+$/i.test(rel)) return { kind: "file", rel: "index.html" };
  return { kind: "file", rel };
}
