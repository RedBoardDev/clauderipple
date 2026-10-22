// The host reads the router's admin API like any client: models and effort ladders for the
// picker, the proxy settings a spawned CLI needs, and per-session request records for the
// mod's figures. Read-only; the host never writes router state.
import type { Effort, Figures, ProviderGroup, RippleLimit, RippleStatus } from "./protocol.ts";

const EFFORTS: readonly Effort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const LABELS: Record<string, string> = {
  chatgpt: "ChatGPT", anthropic: "Claude", openrouter: "OpenRouter", deepseek: "DeepSeek",
  "opencode-go": "OpenCode Go", "opencode-zen": "OpenCode Zen", "google-gemini": "Google Gemini",
};

interface ModOptions {
  models: { model: string; provider: string; name: string; judgeOnly: boolean }[];
  providers: { name: string; type: string; usable: boolean }[];
  claudeEfforts?: string[];
}
/**
 * Claude Code's own aliases for the current Opus, Sonnet and Haiku: the CLI resolves them, so this
 * list never names a model version that goes stale.
 */
const CLAUDE_ALIASES = [{ model: "opus", name: "Opus" }, { model: "sonnet", name: "Sonnet" }, { model: "haiku", name: "Haiku" }];
interface EffortLevels { providers: Record<string, { default: string[]; models?: Record<string, string[]> }> }
interface RequestRecord { source?: string; target?: string; provider?: string; effort?: string; ok?: boolean; status?: number; at?: string; usage?: { input?: number; cached?: number; cacheWrite?: number; output?: number } }
interface Window { used_percent?: number; window_minutes?: number; reset_at?: number }

export interface RouterStatus { ok: boolean; problem?: string; proxyEnv: Record<string, string> }

export type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const toEffort = (s: string | undefined): Effort | null => (s && (EFFORTS as readonly string[]).includes(s) ? (s as Effort) : null);
const base = (id: string): string => id.split("@")[0]!.replace(/-\d{8}$/, "");

export class RouterClient {
  private adminUrl: string;
  private fetch: Fetch;

  constructor(adminUrl: string, fetchImpl: Fetch = globalThis.fetch as unknown as Fetch) {
    this.adminUrl = adminUrl.replace(/\/$/, "");
    this.fetch = fetchImpl;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetch(this.adminUrl + path, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`router ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /** Every chat model the router routes, grouped by provider, judge-only models left out (ARCHITECTURE §3b). */
  async models(): Promise<ProviderGroup[]> {
    const [opts, levels] = await Promise.all([this.get<ModOptions>("/api/mod-options"), this.get<EffortLevels>("/api/effort-levels")]);
    return groupModels(opts, levels);
  }

  /** The router's own `GET /api/limits` body, unvalidated: `rippleStatus` reads it at the boundary. */
  async limits(): Promise<unknown> { return this.get<unknown>("/api/limits"); }

  /** The router's own `GET /api/mod-settings` body, unvalidated: `rippleStatus` reads it at the boundary. */
  async modSettings(): Promise<unknown> { return this.get<unknown>("/api/mod-settings"); }

  /** What a spawned CLI needs to go through the router: the same two keys `~/.claude/settings.json` carries (ARCHITECTURE §1). */
  async status(): Promise<RouterStatus> {
    try {
      const s = await this.get<{ settings?: { HTTPS_PROXY?: string; NODE_EXTRA_CA_CERTS?: string }; listen?: { host: string; port: number }; home?: string; readiness?: { ready: boolean; problems?: string[] } }>("/api/status");
      const proxyEnv: Record<string, string> = {};
      const proxy = s.settings?.HTTPS_PROXY ?? (s.listen ? `http://${s.listen.host}:${s.listen.port}` : undefined);
      if (proxy) proxyEnv.HTTPS_PROXY = proxy;
      if (s.settings?.NODE_EXTRA_CA_CERTS) proxyEnv.NODE_EXTRA_CA_CERTS = s.settings.NODE_EXTRA_CA_CERTS;
      // Readiness problems name one provider needing attention (measured: "provider:opencode-go"
      // while that provider still answered); they are not "the router is down", so they do not turn the banner on.
      return { ok: true, proxyEnv };
    } catch (e) {
      return { ok: false, problem: (e as Error).message, proxyEnv: {} };
    }
  }

  /** The mod's figures for one Claude Code session, from the router's own request records. */
  async figures(sessionId: string, mainModel: string, contextWindow: number | null): Promise<Figures> {
    const [reqs, status, window] = await Promise.all([
      this.get<{ requests: RequestRecord[] }>(`/api/requests?kind=messages&n=400&session=${encodeURIComponent(sessionId)}`).catch(() => ({ requests: [] })),
      this.get<{ claude?: { accounts?: { quota?: { rate_limits?: { primary?: Window; secondary?: Window } } }[] } }>("/api/status").catch(() => ({})),
      contextWindow ?? this.catalogWindow(mainModel),
    ]);
    return computeFigures(reqs.requests, mainModel, window, status, Date.now());
  }

  private windows: { at: number; map: Record<string, number> } | null = null;

  /**
   * The router's catalogue window for a model (`GET /api/context-windows`), for a session whose CLI
   * never told us one: a Claude app session. Read at most every 10 minutes; unknown or an older
   * router without the endpoint is null.
   */
  private async catalogWindow(model: string): Promise<number | null> {
    // Claude Code's own suffix: "[1m]" is the million-token variant of the same model.
    if (/\[1m\]$/i.test(model)) return 1_000_000;
    if (!this.windows || Date.now() - this.windows.at > 10 * 60_000) {
      const body = await this.get<{ windows?: unknown }>("/api/context-windows").catch(() => null);
      const raw = body?.windows && typeof body.windows === "object" ? body.windows as Record<string, unknown> : null;
      // A failed read is not cached: the next refresh asks again.
      if (raw) {
        const map: Record<string, number> = {};
        for (const [id, value] of Object.entries(raw)) if (typeof value === "number" && value > 0) map[id] = value;
        this.windows = { at: Date.now(), map };
      }
    }
    const map = this.windows?.map ?? {};
    const id = model.replace(/\[[^\]]*\]$/, "");
    return map[model] ?? map[id] ?? map[base(id)] ?? null;
  }
}

export function groupModels(opts: ModOptions, levels: EffortLevels): ProviderGroup[] {
  const usable = new Map(opts.providers.map((p) => [p.name, p.usable]));
  const groups = new Map<string, ProviderGroup>();
  for (const m of opts.models) {
    if (m.judgeOnly) continue;
    const ladder = levels.providers[m.provider];
    const efforts = (ladder?.models?.[m.model] ?? ladder?.default ?? []).map(toEffort).filter((e): e is Effort => e !== null && e !== "none" && e !== "minimal");
    const ok = usable.get(m.provider) ?? false;
    let g = groups.get(m.provider);
    if (!g) { g = { provider: m.provider, label: LABELS[m.provider] ?? m.provider, usable: ok, models: [] }; groups.set(m.provider, g); }
    g.models.push({ model: m.model, name: m.name, provider: m.provider, efforts, usable: ok });
  }
  // A router that passes Claude straight through declares no anthropic provider, so Claude was
  // missing from the phone's picker, and with no other provider the picker came up empty
  // (Discord, 2026-10-22). Claude Code runs its own models with its own login either way.
  if (!opts.providers.some((p) => p.type === "anthropic")) {
    const efforts = (levels.providers.anthropic?.default ?? opts.claudeEfforts ?? []).map(toEffort).filter((e): e is Effort => e !== null && e !== "none" && e !== "minimal");
    const models = CLAUDE_ALIASES.map(({ model, name }) => ({ model, name, provider: "claude-code", efforts, usable: true }));
    return [{ provider: "claude-code", label: "Claude", usable: true, models }, ...groups.values()];
  }
  return Array.from(groups.values());
}

/**
 * Cache % is read over all input of the session's main-model requests; context % is the latest
 * main request's input over the window the CLI reported for the model. Unknown stays null.
 * `route` is where that same latest request went (the router's target, not the model asked for).
 */
export function computeFigures(records: RequestRecord[], mainModel: string, contextWindow: number | null, status: { claude?: { accounts?: { quota?: { rate_limits?: { primary?: Window; secondary?: Window } } }[] } }, now: number): Figures {
  const main = base(mainModel);
  let read = 0, all = 0;
  let effort: Effort | null = null;
  let latest = -Infinity;
  let lastInput: number | null = null;
  let route: Figures["route"] = null;
  const workers = new Map<string, { model: string; provider: string; requests: number }>();
  for (const r of records) {
    const target = r.target ?? r.source ?? "";
    if (base(target) === main || base(r.source ?? "") === main) {
      const u = r.usage ?? {};
      read += u.cached ?? 0;
      all += (u.input ?? 0) + (u.cached ?? 0) + (u.cacheWrite ?? 0);
      const at = r.at ? Date.parse(r.at) : 0;
      const input = (u.input ?? 0) + (u.cached ?? 0) + (u.cacheWrite ?? 0);
      // A request still streaming has no usage yet; it would read as an empty context (measured: 0% mid-turn).
      if (at > latest && input > 0) {
        latest = at; effort = toEffort(r.effort) ?? effort; lastInput = input;
        route = { model: target.replace(/@[^@]*$/, ""), provider: r.provider ?? "", ok: r.ok === true, status: typeof r.status === "number" ? r.status : null };
      }
    } else if (target) {
      const key = base(target);
      const w = workers.get(key) ?? { model: key, provider: r.provider ?? "", requests: 0 };
      w.requests++;
      workers.set(key, w);
    }
  }
  const windows = status.claude?.accounts?.[0]?.quota?.rate_limits;
  const five = [windows?.primary, windows?.secondary].find((w) => w?.window_minutes === 300);
  return {
    effort,
    cachePct: all > 0 ? Math.round((read / all) * 1000) / 10 : null,
    contextPct: contextWindow && lastInput !== null ? Math.min(100, Math.round((lastInput / contextWindow) * 1000) / 10) : null,
    contextTokens: lastInput,
    contextWindow: contextWindow && contextWindow > 0 ? contextWindow : null,
    route,
    fiveHourPct: typeof five?.used_percent === "number" ? five.used_percent : null,
    fiveHourResetAt: typeof five?.reset_at === "number" ? five.reset_at * 1000 : null,
    workers: Array.from(workers.values()).sort((a, b) => b.requests - a.requests),
    at: now,
  };
}

// ---- the mod's host-wide status -----------------------------------------------------------------

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const WINDOW_KINDS = ["five_hour", "seven_day", "scoped", "window"] as const;

/**
 * What the ClaudeRipple mod is set to, from the router's `GET /api/mod-settings` and `GET /api/limits`.
 * Both bodies are read at the boundary: a malformed piece is dropped, never thrown on. The
 * flattening follows the mod's own `routerLimitItems` (packages/mod/hooks/session.ts): a window
 * whose reset has passed is gone, a reset under 1e12 is epoch seconds, Claude's windows lead and the
 * other providers keep the router's order.
 */
export function rippleStatus(limitsJson: unknown, modSettingsJson: unknown, now: number): RippleStatus {
  const settings = obj(obj(modSettingsJson).settings);
  const modes = Array.isArray(settings.modes) ? settings.modes.map(obj) : [];
  const active = typeof settings.activeMode === "string" ? modes.find((m) => m.id === settings.activeMode) : undefined;
  const mode = active && typeof active.id === "string" && typeof active.name === "string"
    ? { id: active.id, name: active.name, since: typeof settings.activeSince === "number" && Number.isFinite(settings.activeSince) ? settings.activeSince : null }
    : null;

  const providers = Array.isArray(obj(limitsJson).providers) ? (obj(limitsJson).providers as unknown[]).map(obj) : [];
  const limits: RippleLimit[] = [];
  const claude: RippleLimit[] = [];
  for (const p of providers) {
    const provider = typeof p.provider === "string" ? p.provider : "";
    if (!provider || !Array.isArray(p.accounts)) continue;
    const title = typeof p.title === "string" && p.title ? p.title : LABELS[provider] ?? provider;
    const accounts = p.accounts.map(obj).filter((a) => Array.isArray(a.windows));
    const into = p.type === "anthropic" ? claude : limits;
    accounts.forEach((a, index) => {
      for (const w of (a.windows as unknown[]).map(obj)) {
        const kind = WINDOW_KINDS.find((k) => k === w.kind);
        if (!kind || typeof w.used_percent !== "number" || !Number.isFinite(w.used_percent)) continue;
        const resetAt = typeof w.reset_at === "number" && Number.isFinite(w.reset_at) ? w.reset_at * (w.reset_at < 1e12 ? 1000 : 1) : null;
        if (resetAt !== null && resetAt <= now) continue;
        into.push({
          provider, title,
          ...(accounts.length > 1 ? { account: `#${(typeof a.account === "number" ? a.account : index) + 1}` } : {}),
          kind,
          label: (kind === "scoped" || kind === "window") && typeof w.label === "string" ? w.label : null,
          usedPct: Math.round(w.used_percent * 10) / 10,
          windowMinutes: typeof w.window_minutes === "number" && w.window_minutes > 0 ? w.window_minutes : null,
          resetAt,
        });
      }
    });
  }
  return {
    mode,
    effortAuto: settings.effortAuto === true,
    effortFloor: toEffort(typeof settings.floor === "string" ? settings.floor : undefined),
    effortCeiling: toEffort(typeof settings.ceiling === "string" ? settings.ceiling : undefined),
    limits: [...claude, ...limits],
    at: now,
  };
}
