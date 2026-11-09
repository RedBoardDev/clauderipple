// Google Antigravity / Cloud Code Assist (CCA): the wire facts, model-id resolution and the
// conversation session id this router uses. Kept apart from the account store (accounts.ts) and the
// OAuth session (login.ts) so each can be read and tested on its own.
//
// Every fact here is taken from the reference implementation opencodex (GitHub lidge-jun/opencodex,
// read 2026-10-01 as a behavioral spec — no code copied; the project rule forbids copying it). Each
// constant names its source file:line in a comment. **Nothing here is measured against a live
// Google endpoint** — this environment has no Antigravity subscription, so the whole file is
// doc/source-derived and unmeasured. That is recorded in docs/ARCHITECTURE.md §4d.

import crypto from "node:crypto";
import type { ProviderModel } from "../../config.ts";

// ── OAuth + Cloud Code Assist endpoints ─────────────────────────────────────────────────────────

/**
 * The public OAuth client embedded in the Antigravity desktop client. These are client identifiers,
 * not user secrets: opencodex ships them in the clear and they are overridable by environment there.
 * Source: opencodex `src/oauth/google-antigravity.ts:17-38`.
 */
export const GOOGLE_OAUTH = {
  clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  clientSecret: "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",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userinfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
  ],
  /** Project discovery (`loadCodeAssist`) is served by the prod host. */
  prodApi: "https://cloudcode-pa.googleapis.com",
  /** Streaming and `onboardUser` use the daily host. Source: opencodex `src/oauth/google-antigravity.ts:24-25`. */
  dailyApi: "https://daily-cloudcode-pa.googleapis.com",
  /** The two Cloud Code Assist hosts. They offer different models and count quota separately. */
  hosts: ["https://daily-cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com"] as const,
  apiVersion: "v1internal",
  /** Preferred loopback port; the callback path is fixed. Source: opencodex `src/oauth/google-antigravity.ts:34-35`. */
  port: 51121,
  callbackPath: "/callback",
  /** Refresh this long before the access token expires. Source: opencodex `REFRESH_SKEW_MS`. */
  refreshLeadMs: 5 * 60 * 1000,
  /** How long a sign-in may stay open. Same as the other sign-in flows. */
  timeoutMs: 5 * 60 * 1000,
  requestTimeoutMs: 30_000,
} as const;

/**
 * The terms warning the CLI prints once and the admin API returns in a `warning` field. Facts only:
 * Google's Antigravity terms (clause 6) and the Gemini CLI FAQ state that using these credentials
 * from a third-party client is a violation, and Google blocked a large number of accounts in
 * February 2026. ClaudeRipple is not affiliated with Google.
 */
export const ANTIGRAVITY_WARNING =
  "Google's Antigravity terms (section 6) and the Gemini CLI FAQ say that using these credentials " +
  "from a client other than Google's own is not permitted, and Google blocked a large number of " +
  "accounts used this way in February 2026. ClaudeRipple is not affiliated with Google. Sign in only " +
  "if you accept that risk.";

/** Antigravity IDE version, mirrored so the request fingerprint matches the token's client. */
export const ANTIGRAVITY_IDE_VERSION = "2.5.5";

/**
 * The User-Agent the real Antigravity IDE sends. The CCA backend gates newer agent models on the
 * `antigravity/ide/...` client family and answers 404 to CLI-shaped UAs even with a valid OAuth
 * token. Source: opencodex `src/adapters/client-fingerprint.ts:44-65`, decompiled from the 2.5.5
 * language server.
 */
export function antigravityUserAgent(): string {
  const override = process.env.CLAUDERIPPLE_ANTIGRAVITY_USER_AGENT?.trim() || process.env.GOOGLE_ANTIGRAVITY_USER_AGENT?.trim();
  if (override) return override;
  const [osType, arch] = "windows/amd64".split("/");
  return `antigravity/ide/${ANTIGRAVITY_IDE_VERSION} (os_type=${osType}; arch=${arch}; aidev_client; auth_method=oauth)`;
}

/** Antigravity CLI version whose User-Agent CCA serves Gemini 4 Argon to. Source: opencodex `ANTIGRAVITY_CLI_VERSION`. */
export const ANTIGRAVITY_CLI_VERSION = "1.3.4";

/**
 * The User-Agent the Antigravity CLI sends. CCA serves Gemini 4 Argon only to this client family:
 * `fetchAvailableModels` lists `gemini-4-argon-{low,medium,high}` under it and not under the IDE UA
 * (measured 2026-10-27 on both hosts, one Google AI Pro account), and opencodex measured Argon requests 404
 * under the IDE UA while `gemini-3.7-flash-tiered` and `gemini-3.1-pro-low` 404 under this one. So it
 * is used for Argon generation and the quota summary, not other models' generation. The IDE
 * override does not apply: it names the IDE header, and letting it replace this one would lock
 * Argon again. Source: opencodex
 * `src/adapters/client-fingerprint.ts antigravityCliUserAgent`.
 */
export function antigravityCliUserAgent(): string {
  const [osType, arch] = "windows/amd64".split("/");
  return `antigravity/cli/${ANTIGRAVITY_CLI_VERSION} (os_type=${osType}; arch=${arch}; aidev_client; auth_method=oauth)`;
}

/** True for the models CCA serves only to the CLI client family: Gemini 4 Argon, as a base or wire id. */
export function servedToAntigravityCli(model: string): boolean {
  return /^gemini-4-argon(?:-|$)/.test(model);
}

/** The User-Agent a generation request for `model` (a base or wire id) must carry. */
export function antigravityUserAgentFor(model: string): string {
  return servedToAntigravityCli(model) ? antigravityCliUserAgent() : antigravityUserAgent();
}

// ── Model id resolution ─────────────────────────────────────────────────────────────────────────

/**
 * Normalise a Claude Code effort onto Cloud Code Assist's three thinking levels. `xhigh`, `max` and
 * `ultra` all clamp to `high`; `none`/`minimal` to `low`. `minimal` is not itself a CCA level.
 * Source: opencodex `src/providers/antigravity-models.ts:resolveAntigravityThinkingLevel`.
 */
export function resolveAntigravityThinkingLevel(effort: string | undefined): "low" | "medium" | "high" | undefined {
  switch (effort) {
    case "none":
    case "minimal":
    case "low": return "low";
    case "medium": return "medium";
    case "high":
    case "xhigh":
    case "max":
    case "ultra": return "high";
    default: return undefined;
  }
}

/**
 * Base models whose every effort rides on a different wire id that already names the tier. Here the
 * suffix IS the effort, so no `thinkingConfig` is sent beside it. Source: opencodex
 * `ANTIGRAVITY_EFFORT_WIRE_MAP` / `ANTIGRAVITY_SUFFIX_TIER_MODELS`.
 */
const SUFFIX_TIER_MODELS: Record<string, { wire: Record<string, string>; default: string }> = {
  // High rides on the medium tier: `-high` thinks with no budget (the catalogue's thinkingBudget -1,
  // against 4000 for medium), and on 2026-10-17 the requests past 4000 output tokens took 64% of all
  // request time. The owner chose speed over the deeper tier (2026-10-20). `-high` named outright
  // still goes through as it is.
  "gemini-3.8-flash": {
    wire: { low: "gemini-3.8-flash-low", medium: "gemini-3.8-flash-medium", high: "gemini-3.8-flash-medium" },
    default: "medium",
  },
  // Medium is Argon's own default level (translate.ts, Gemini API thinking guide). Only the CLI
  // client family is served these ids (`antigravityCliUserAgent`).
  "gemini-4-argon": {
    wire: { low: "gemini-4-argon-low", medium: "gemini-4-argon-medium", high: "gemini-4-argon-high" },
    default: "medium",
  },
};

/**
 * Base models whose efforts map to wire ids but where a `thinkingConfig.thinkingLevel` also travels
 * (the high rung `gemini-pro-agent` carries no tier in its name). Source: opencodex
 * `ANTIGRAVITY_EFFORT_WIRE_MAP` / `ANTIGRAVITY_MODEL_EFFORTS`.
 */
const EFFORT_WIRE_MODELS: Record<string, { wire: Record<string, string>; default: string }> = {
  "gemini-3.1-pro": { wire: { low: "gemini-3.1-pro-low", high: "gemini-pro-agent" }, default: "high" },
};

/**
 * Base models whose effort rides on a single `-tiered` wire id via `thinkingLevel`. Source:
 * opencodex `ANTIGRAVITY_THINKING_LEVEL_MODELS` / `ANTIGRAVITY_PICKER_TO_WIRE`.
 */
const THINKING_LEVEL_MODELS: Record<string, { wire: string; default: string }> = {
  "gemini-3.7-flash": { wire: "gemini-3.7-flash-tiered", default: "medium" },
};

export type AntigravityWireModel = {
  /** The id the CCA envelope's `model` field must carry. */
  wire: string;
  /** The thinking level to place on `request.generationConfig.thinkingConfig`, when this model takes one. */
  thinkingLevel?: "low" | "medium" | "high";
  /** True when this base id is one this module knows; an unknown id is forwarded verbatim and untouched. */
  known: boolean;
};

/**
 * Resolve a Claude Code model id onto the Cloud Code Assist wire id and thinking level. A base id
 * (`gemini-3.8-flash`) resolves to its tier wire id; an id already naming a tier is forwarded as it
 * is. Unknown ids pass through untouched so a model Google adds tomorrow is still directly routable.
 */
export function resolveAntigravityWireModel(model: string, effort: string | undefined): AntigravityWireModel {
  const level = resolveAntigravityThinkingLevel(effort);
  const suffix = SUFFIX_TIER_MODELS[model];
  if (suffix) {
    const wire = (level && suffix.wire[level]) || suffix.wire[suffix.default]!;
    // The suffix names the tier; sending `thinkingLevel` beside it would state the effort twice.
    return { wire, known: true };
  }
  const mapped = EFFORT_WIRE_MODELS[model];
  if (mapped) {
    const wire = (level && mapped.wire[level]) || mapped.wire[mapped.default]!;
    return { wire, ...(level ? { thinkingLevel: level } : {}), known: true };
  }
  const tiered = THINKING_LEVEL_MODELS[model];
  if (tiered) {
    return { wire: tiered.wire, thinkingLevel: (level ?? tiered.default) as "low" | "medium" | "high", known: true };
  }
  // Claude models on Antigravity take effort through thinkingConfig only, no suffix — CCA validates
  // the field against Google's ThinkingLevel enum. Source: opencodex rule 4.
  if (/^claude-/.test(model)) return { wire: model, ...(level ? { thinkingLevel: level } : {}), known: true };
  return { wire: model, known: false };
}

/**
 * The conversation's Cloud Code Assist session id. The real client puts one stable id on every turn
 * of a conversation so provider-side replay can associate a thoughtSignature with the call that
 * produced it; an unstable id loses that association. We derive it from `conversationKey`, which the
 * router already keeps stable per conversation (and identical to the prompt-cache key), and shape it
 * as the numeric string the wire carries — `sha256(key)` → BigEndian uint64 masked to 63 bits, with a
 * leading "-". Source: opencodex `antigravitySessionId` (CLIProxyAPI `generateStableSessionID`).
 */
export function antigravitySessionId(conversationKey: string): string {
  const digest = crypto.createHash("sha256").update(conversationKey, "utf8").digest();
  const masked = digest.readBigUInt64BE(0) & 0x7fffffffffffffffn;
  return `-${masked.toString()}`;
}

/** A fresh per-request id, as the envelope's `requestId`. Source: opencodex `agent-${uuid}`. */
export function antigravityRequestId(): string {
  return `agent-${crypto.randomUUID()}`;
}

// ── Model catalogue ─────────────────────────────────────────────────────────────────────────────

/**
 * Context windows per model, from CCA's own `maxTokens` for the wire ids. Source: opencodex
 * `ANTIGRAVITY_WIRE_MODEL_CONTEXT_WINDOWS`.
 */
const CONTEXT_WINDOWS: Record<string, number> = {
  "gemini-4-argon": 1_048_576,
  "gemini-3.8-flash": 1_048_576,
  "gemini-3.7-flash": 1_048_576,
  "gemini-3.1-pro": 1_048_576,
  "gemini-3.1-flash-image": 1_048_576,
  "claude-sonnet-4-6": 250_000,
  "claude-opus-4-6-thinking": 250_000,
  "gpt-oss-120b-medium": 131_072,
};

/**
 * The effort ladder per collapsed base model, for the GUI. The suffix-tier model's rungs are wire
 * ids, so the GUI shows them as one entry with a ladder rather than three rows (opencodex does the
 * same collapsing). Source: opencodex `ANTIGRAVITY_MODEL_EFFORTS`.
 */
const EFFORT_LEVELS: Record<string, string[]> = {
  "gemini-4-argon": ["low", "medium", "high"],
  "gemini-3.8-flash": ["low", "medium", "high"],
  "gemini-3.7-flash": ["low", "medium", "high"],
  "gemini-3.1-pro": ["low", "high"],
  "claude-sonnet-4-6": ["low", "medium", "high"],
  "claude-opus-4-6-thinking": ["low", "medium", "high"],
};

/** The collapsed base models the CCA backend serves. Source: opencodex `ANTIGRAVITY_MODELS`. */
export const ANTIGRAVITY_BASE_MODELS = [
  // First stays a model every account is served under the IDE UA: the verification recheck pings
  // the first static model when the provider lists none.
  "gemini-3.8-flash",
  "gemini-4-argon",
  "gemini-3.7-flash",
  "gemini-3.1-pro",
  "gemini-3.1-flash-image",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
] as const;

/** The static fallback list, used when `:fetchAvailableModels` cannot be read. */
export function staticAntigravityModels(): ProviderModel[] {
  return ANTIGRAVITY_BASE_MODELS.map((id) => ({
    id,
    ...(CONTEXT_WINDOWS[id] ? { contextWindow: CONTEXT_WINDOWS[id] } : {}),
    ...(EFFORT_LEVELS[id] ? { effortLevels: [...EFFORT_LEVELS[id]] } : {}),
  }));
}

function isBaseModel(id: string): boolean {
  return (ANTIGRAVITY_BASE_MODELS as readonly string[]).includes(id);
}

/**
 * Collapse a wire id back to the collapsed base id the picker shows, when it names a known tier. The
 * collapsed id is what the static catalogue lists and what `resolveAntigravityWireModel` maps back to
 * a wire id, so the picker shows one row per model and routing is the same whether the list came from
 * discovery or the fallback.
 */
function collapseWireId(wireId: string): string {
  if (isBaseModel(wireId)) return wireId;
  const tiered = wireId.endsWith("-tiered") ? wireId.slice(0, -"-tiered".length) : undefined;
  if (tiered && isBaseModel(tiered)) return tiered;
  const match = /^(.*)-(low|medium|high|max|minimal)$/.exec(wireId);
  if (match && isBaseModel(match[1]!)) return match[1]!;
  return wireId;
}

/** One host's catalogue: the picker rows and the wire ids they were collapsed from. */
export type ParsedHostCatalogue = { models: ProviderModel[]; wireIds: string[] };

/**
 * Parse one host's `POST {host}/v1internal:fetchAvailableModels`. The body groups agent-callable
 * models under `agentModelSorts[].groups[].modelIds`, with tiered Flash ids under
 * `tieredModelIds.flash`, and describes each in `models[wireId]` (`maxTokens`). Source: opencodex
 * `parseAntigravityAvailableModels` (src/providers/antigravity-models.ts:489-560).
 *
 * Returns null when the shape is unreadable, so the caller falls back instead of showing nothing.
 * The wire ids are kept so per-model host routing can match an exact wire id as well as a base id.
 */
export function parseHostCatalogue(payload: unknown, limit = 200): ParsedHostCatalogue | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const body = payload as Record<string, unknown>;
  const models = body.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) return null;
  const known = models as Record<string, unknown>;
  const available = new Set(Object.keys(known));

  // Collapse each wire id to its base id first, then take the context window and display name from
  // the first wire id that carried that base. A collapsed id is what routing understands.
  const collapsed = new Map<string, string>();
  const wireIds: string[] = [];
  const add = (wireId: string): void => {
    if (typeof wireId !== "string" || !available.has(wireId)) return;
    const id = collapseWireId(wireId);
    wireIds.push(wireId);
    if (!collapsed.has(id)) collapsed.set(id, wireId);
  };
  const sorts = Array.isArray(body.agentModelSorts) ? body.agentModelSorts : [];
  for (const sort of sorts) {
    const groups = sort && typeof sort === "object" ? (sort as { groups?: unknown }).groups : undefined;
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const ids = group && typeof group === "object" ? (group as { modelIds?: unknown }).modelIds : undefined;
      if (Array.isArray(ids)) for (const id of ids) add(id as string);
    }
  }
  const tiered = body.tieredModelIds && typeof body.tieredModelIds === "object" ? (body.tieredModelIds as { flash?: unknown }).flash : undefined;
  if (Array.isArray(tiered)) for (const id of tiered) add(id as string);

  if (collapsed.size === 0) return null;
  const out: ProviderModel[] = [];
  for (const [id, wireId] of collapsed) {
    const info = known[wireId] && typeof known[wireId] === "object" ? (known[wireId] as { maxTokens?: unknown; displayName?: unknown }) : undefined;
    const contextWindow = typeof info?.maxTokens === "number" && Number.isFinite(info.maxTokens) && info.maxTokens > 0 ? Math.floor(info.maxTokens) : CONTEXT_WINDOWS[id];
    out.push({
      id,
      ...(typeof info?.displayName === "string" && info.displayName ? { name: info.displayName } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(EFFORT_LEVELS[id] ? { effortLevels: [...EFFORT_LEVELS[id]] } : {}),
    });
    if (out.length >= limit) break;
  }
  return out.length > 0 ? { models: out, wireIds } : null;
}

/** The picker rows of one host's body, or null when the shape is unreadable. */
export function parseAvailableModels(payload: unknown, limit = 200): ProviderModel[] | null {
  return parseHostCatalogue(payload, limit)?.models ?? null;
}

/**
 * Which hosts offer each model id. A model's own id or any of its collapsed wire ids may name it,
 * because a host's catalogue lists wire ids (`gemini-3.8-flash-high`) while routing resolves a base
 * id (`gemini-3.8-flash`). Daily comes first in the list, so it is the preferred host.
 */
export type HostMap = Map<string, string[]>;

/** Build the per-model host map from each host's catalogue; a host with no catalogue contributes nothing. */
export function buildHostMap(cataloguesByHost: ReadonlyMap<string, ParsedHostCatalogue>): HostMap {
  const map: HostMap = new Map();
  for (const [host, catalogue] of cataloguesByHost) {
    const names = new Set<string>([...catalogue.models.map((m) => m.id), ...catalogue.wireIds]);
    for (const name of names) {
      const hosts = map.get(name) ?? [];
      if (!hosts.includes(host)) hosts.push(host);
      map.set(name, hosts);
    }
  }
  return map;
}

// ── Project discovery ───────────────────────────────────────────────────────────────────────────

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function extractProjectId(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") return (value as { id: string }).id;
  }
  return undefined;
}

function signalFor(outer?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(GOOGLE_OAUTH.requestTimeoutMs);
  return outer ? AbortSignal.any([outer, timeout]) : timeout;
}

/**
 * Discover the account's Cloud Code Assist project: `loadCodeAssist` on the prod host, then
 * `onboardUser` polling on the daily host when the account has none yet. Returns undefined when
 * neither yields one. Source: opencodex `loadCodeAssistProject` / `onboardProject`.
 */
export async function discoverProject(accessToken: string, fetchImpl: FetchLike = fetch, signal?: AbortSignal, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<string | undefined> {
  const loaded = await loadCodeAssistProject(accessToken, fetchImpl, signal);
  if (loaded) return loaded;
  return onboardProject(accessToken, fetchImpl, signal, sleep);
}

async function loadCodeAssistProject(accessToken: string, fetchImpl: FetchLike, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetchImpl(`${GOOGLE_OAUTH.prodApi}/${GOOGLE_OAUTH.apiVersion}:loadCodeAssist`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, accept: "*/*", "content-type": "application/json", "user-agent": antigravityUserAgent() },
      body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
      signal: signalFor(signal),
    });
    if (!response.ok) return undefined;
    return extractProjectId((await response.json().catch(() => undefined)) as Record<string, unknown> | undefined);
  } catch {
    return undefined;
  }
}

const ONBOARD_ATTEMPTS = 5;
const ONBOARD_POLL_MS = 2_000;

async function onboardProject(accessToken: string, fetchImpl: FetchLike, signal: AbortSignal | undefined, sleep: (ms: number) => Promise<void>): Promise<string | undefined> {
  for (let attempt = 0; attempt < ONBOARD_ATTEMPTS; attempt++) {
    if (signal?.aborted) return undefined;
    let response: Response;
    try {
      response = await fetchImpl(`${GOOGLE_OAUTH.dailyApi}/${GOOGLE_OAUTH.apiVersion}:onboardUser`, {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, accept: "*/*", "content-type": "application/json", "user-agent": antigravityUserAgent() },
        body: JSON.stringify({ tier_id: "free-tier", metadata: { ide_type: "ANTIGRAVITY", ide_name: "antigravity", ide_version: ANTIGRAVITY_IDE_VERSION } }),
        signal: signalFor(signal),
      });
    } catch {
      return undefined;
    }
    if (!response.ok) {
      // A transient refusal (429/5xx) is worth polling through; a hard 4xx will not change.
      if (response.status === 429 || response.status >= 500) {
        await sleep(ONBOARD_POLL_MS);
        continue;
      }
      return undefined;
    }
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (data.done === true) return extractProjectId(data.response as Record<string, unknown> | undefined);
    await sleep(ONBOARD_POLL_MS);
  }
  return undefined;
}

/** The account email from Google's pinned userinfo endpoint. Never persisted as a token. */
export async function fetchUserEmail(accessToken: string, fetchImpl: FetchLike = fetch, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetchImpl(GOOGLE_OAUTH.userinfoUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: signalFor(signal),
    });
    if (!response.ok) return undefined;
    const body = (await response.json().catch(() => undefined)) as { email?: unknown } | undefined;
    return typeof body?.email === "string" && body.email.length > 0 ? body.email.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** `failed` hears why a null came back: the status, or the error's name or code, never a body or message. */
async function fetchHostCatalogueAs(userAgent: string, accessToken: string, projectId: string, host: string, fetchImpl: FetchLike, signal?: AbortSignal, failed?: (reason: string) => void): Promise<ParsedHostCatalogue | null> {
  try {
    const response = await fetchImpl(`${host}/${GOOGLE_OAUTH.apiVersion}:fetchAvailableModels`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, accept: "*/*", "content-type": "application/json", "user-agent": userAgent },
      body: JSON.stringify({ project: projectId }),
      signal: signalFor(signal),
    });
    if (!response.ok) {
      failed?.(`HTTP ${response.status}`);
      return null;
    }
    const parsed = parseHostCatalogue(await response.json().catch(() => undefined));
    if (!parsed) failed?.("unreadable answer");
    return parsed;
  } catch (error) {
    failed?.(signal?.aborted ? "cut off" : ((error as NodeJS.ErrnoException).code ?? (error as Error).name ?? "error"));
    return null;
  }
}

/** How long the CLI ask may still run once the IDE answer is in. Both normally answer together. */
export const CLI_CATALOGUE_GRACE_MS = 3_000;

/**
 * One host's catalogue, or null when the endpoint cannot be read. Never throws. Each model is listed
 * from the answer to the User-Agent it will be called with: the IDE answer gives every model as
 * before, and a second ask under the CLI UA adds only the CLI-served ones (Gemini 4 Argon). An
 * unreadable IDE answer is null as before, so a CLI-only list never replaces the static fallback.
 * The CLI ask is optional, so a stalled one is cut off `cliGraceMs` after the IDE answer instead of
 * holding the first turn after a restart for the full request timeout. Because the IDE catalogue
 * still answers, a failed CLI ask is otherwise silent while Argon drops out of the list:
 * `cliFailed` hears it, once the IDE answer is in.
 */
export async function fetchHostCatalogue(accessToken: string, projectId: string, host: string, fetchImpl: FetchLike = fetch, signal?: AbortSignal, cliGraceMs = CLI_CATALOGUE_GRACE_MS, cliFailed?: (reason: string) => void): Promise<ParsedHostCatalogue | null> {
  const cliAbort = new AbortController();
  const cliSignal = signal ? AbortSignal.any([signal, cliAbort.signal]) : cliAbort.signal;
  let cliFailure: string | undefined;
  const pendingCli = fetchHostCatalogueAs(antigravityCliUserAgent(), accessToken, projectId, host, fetchImpl, cliSignal, (reason) => { cliFailure = reason; });
  const ide = await fetchHostCatalogueAs(antigravityUserAgent(), accessToken, projectId, host, fetchImpl, signal);
  if (!ide) {
    cliAbort.abort();
    return null;
  }
  const grace = setTimeout(() => cliAbort.abort(), cliGraceMs);
  const cli = await pendingCli;
  clearTimeout(grace);
  if (!cli) {
    if (cliFailure && !signal?.aborted) cliFailed?.(cliFailure);
    return ide;
  }
  const ids = new Set(ide.models.map((m) => m.id));
  const models = [...ide.models, ...cli.models.filter((m) => servedToAntigravityCli(m.id) && !ids.has(m.id))];
  const wireIds = [...ide.wireIds, ...cli.wireIds.filter((id) => servedToAntigravityCli(id) && !ide.wireIds.includes(id))];
  return { models, wireIds };
}

/** The merged catalogue of every host that answered, and which hosts offer which model. */
export type MergedCatalogue = {
  models: ProviderModel[];
  /** Model id (or any collapsed wire id) → the hosts that offer it, preferred host first. */
  hosts: HostMap;
  /** The per-host catalogues that were readable. */
  byHost: Map<string, ParsedHostCatalogue>;
};

/**
 * The models a CCA account can reach, asked on every host that offers them (measured 2026-10-20:
 * the prod host lists Gemini Pro models the daily host does not, and vice versa for some Flash
 * tiers). Models are merged with the preferred host's row winning, and the returned host map is
 * what routing uses to send a model to a host that actually offers it. Null when no host answered.
 */
export async function fetchAvailableModels(
  accessToken: string,
  projectId: string,
  opts: { hosts?: readonly string[]; fetchImpl?: FetchLike; signal?: AbortSignal; cliFailed?: (host: string, reason: string) => void } = {},
): Promise<MergedCatalogue | null> {
  const hosts = opts.hosts ?? GOOGLE_OAUTH.hosts;
  const results = await Promise.all(hosts.map(async (host) => [host, await fetchHostCatalogue(accessToken, projectId, host, opts.fetchImpl ?? fetch, opts.signal, CLI_CATALOGUE_GRACE_MS, opts.cliFailed && ((reason) => opts.cliFailed!(host, reason)))] as const));
  const byHost = new Map<string, ParsedHostCatalogue>();
  for (const [host, catalogue] of results) if (catalogue) byHost.set(host, catalogue);
  if (byHost.size === 0) return null;
  // Host order is preference order (daily first), so the first host to list a model keeps its row
  // and a failing host simply contributes nothing to the merge.
  const models: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const catalogue of byHost.values()) {
    for (const model of catalogue.models) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
    }
  }
  return { models, hosts: buildHostMap(byHost), byHost };
}

/**
 * The host a model's request should go to: the first host in `hosts` that offers the resolved wire
 * id or the base id, else `fallback`. An unknown model is not hidden — it goes to the default only.
 */
export function hostForModel(hosts: ReadonlyMap<string, readonly string[]>, model: string, wire: string, fallback: string): string {
  return hosts.get(wire)?.[0] ?? hosts.get(model)?.[0] ?? fallback;
}
