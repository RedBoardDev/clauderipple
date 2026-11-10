// What OpenCode itself knows about each model, read from the catalogue its own client is built on.
//
// OpenCode's docs publish an endpoint per model and no effort ladder at all, and its `/models`
// reports ids alone, so `capabilities.ts` established both by sending requests: about ten per
// model, one after another. With upstream latency swinging from 0.5s to 25s on identical one-token
// requests (glm-5.3-flash, measured 2026-10-02), three models took 2m33s.
//
// models.dev (https://models.dev/api.json, maintained by the team behind OpenCode) states three
// things for every model OpenCode serves: `reasoning_options` lists the effort values, `provider.npm`
// names the SDK the OpenCode client speaks to it with, and `limit.context` is the model's context
// window — which OpenCode's own `/models` does not report at all. It is also more accurate than
// asking on effort: a 200 only says a level was not refused, and glm-5.3-flash answered 200 to seven
// levels where the catalogue lists `low`/`high`/`max` — the rest were accepted and, as far as
// anything can tell, ignored. And muse-spark-1.3-contributor's catalogue entry omits `max` even
// though the live model takes it: measured 2026-10-14, `reasoning.effort: "max"` was answered 200
// with effort echoed "max" and 253 reasoning tokens against 134 at xhigh.
//
// The catalogue is community-maintained and a new model can arrive a day late; a model it does not
// list is measured exactly as before.

/** Which models.dev provider describes the endpoint a preset points at. Only presets whose base URL
 * is the one the catalogue entry names (`api`) are listed, so the catalogue never describes a
 * different endpoint from the one the request goes to. */
const CATALOG_PROVIDER: Record<string, string> = {
  "opencode-go": "opencode-go", // api https://opencode.ai/zen/go/v1
  "opencode-zen": "opencode", // api https://opencode.ai/zen/v1
};

export const CATALOG_URL = "https://models.dev/api.json";
const CATALOG_TIMEOUT_MS = 10_000;
/** The catalogue changes when a model is added, not minute to minute. */
const CATALOG_TTL_MS = 60 * 60 * 1000;

export type CatalogEntry = {
  /** The wire the OpenCode client speaks to this model, when its SDK names one we speak. */
  wire?: "chat" | "responses" | "anthropic";
  /** The effort values the model takes; empty when it takes none (a toggle or a token budget is not
   * an effort). Absent when the entry does not say, which leaves the ladder to measurement. */
  effortLevels?: string[];
  /** The model's context window, from `limit.context`. Absent when the entry does not state one that
   * could be a window, which leaves it to the global fallback. */
  contextWindow?: number;
};

type CatalogModel = { provider?: { npm?: unknown }; reasoning?: unknown; reasoning_options?: unknown; limit?: { context?: unknown } };
type CatalogProvider = { npm?: unknown; models?: Record<string, CatalogModel> };

/** The SDK packages that map onto a wire this router sends. Any other (`@ai-sdk/google`, …) says
 * nothing we can use, and leaves the wire to measurement. */
function wireOf(npm: unknown): CatalogEntry["wire"] {
  if (npm === "@ai-sdk/openai-compatible") return "chat";
  if (npm === "@ai-sdk/openai") return "responses";
  if (npm === "@ai-sdk/anthropic") return "anthropic";
  return undefined;
}

/** One model as the catalogue describes it, or nothing when the preset has no catalogue or the model is not in it. */
export function catalogEntry(catalog: unknown, preset: string | undefined, modelId: string): CatalogEntry | undefined {
  const providerId = preset ? CATALOG_PROVIDER[preset] : undefined;
  if (!providerId || !catalog || typeof catalog !== "object") return undefined;
  const provider = (catalog as Record<string, CatalogProvider>)[providerId];
  const model = provider?.models?.[modelId];
  if (!model || typeof model !== "object") return undefined;
  // A model with no SDK of its own is spoken to with the provider's.
  const wire = wireOf(model.provider?.npm ?? provider?.npm);
  let effortLevels: string[] | undefined;
  if (Array.isArray(model.reasoning_options)) {
    const effort = (model.reasoning_options as { type?: unknown; values?: unknown }[]).find((option) => option?.type === "effort" && Array.isArray(option.values));
    effortLevels = effort ? (effort.values as unknown[]).filter((value): value is string => typeof value === "string") : [];
  } else if (model.reasoning === false) {
    effortLevels = [];
  }
  // The catalogue's own window, which OpenCode's `/models` does not carry. A fractional or
  // non-positive `context` is not a window we would hand Claude Code, so it is left unstated.
  const context = model.limit?.context;
  const contextWindow = typeof context === "number" && Number.isInteger(context) && context > 0 ? context : undefined;
  return {
    ...(wire ? { wire } : {}),
    ...(effortLevels ? { effortLevels } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

/**
 * The window the catalogue states for a model under its canonical id, for a provider the catalogue
 * has no entry of its own for — a hand-entered `openai-compatible` endpoint (Hive) whose `/models`
 * lists ids and nothing else. `catalogEntry` cannot answer there: it reads one provider's block, and
 * an unknown endpoint has no block.
 *
 * models.dev files the same model under every provider that serves it, and a reseller may state a
 * smaller window than the model was built with (2026-10-28: `deepseek-v4.1-flash` is 1,000,000 on
 * most entries and 256,000 on Scaleway's; `glm-5.3-flash` is 1,000,000 on most and 262,144 on
 * AMD's, 327,680 on Engy's). The endpoint we are filling a blank for is an unknown reseller, so the
 * smallest stated window is the only value every entry agrees is safe: too small compacts early and
 * costs room, too large overflows and loses the request.
 *
 * Matching is narrow on purpose. The org prefix (`deepseek-ai/`) is dropped from *our* id, and that
 * must equal a catalogue id exactly; only when there is no such id is a trailing build stamp or
 * release date (`-1017`, `-20240101`) also dropped and the result required to equal one exactly.
 * `deepseek-flash` is not `deepseek-v4.1-flash`, and a near miss is no match.
 */
export function catalogueWindow(catalog: unknown, modelId: string): number | undefined {
  if (!catalog || typeof catalog !== "object") return undefined;
  const index = windowIndex(catalog as Record<string, CatalogProvider>);
  const bare = bareModelId(modelId);
  const exact = index.get(bare);
  if (exact !== undefined) return exact;
  return index.get(bare.replace(/[-_](?:\d{8}|\d{4})$/, ""));
}

/** Our id without the org prefix. Case is folded: no two models differ by case alone, so a case
 * difference is not a different model. */
function bareModelId(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  return (slash >= 0 ? modelId.slice(slash + 1) : modelId).toLowerCase();
}

const windowIndexes = new WeakMap<object, Map<string, number>>();

/** Every catalogue model id, case folded, against the smallest `limit.context` any provider states
 * for it. Built once per catalogue object: one download backs every model of every provider, and
 * re-walking 5,000+ entries per model would be the slow part of a start-up pass. */
function windowIndex(catalog: Record<string, CatalogProvider>): Map<string, number> {
  const cached = windowIndexes.get(catalog);
  if (cached) return cached;
  const index = new Map<string, number>();
  for (const provider of Object.values(catalog)) {
    const models = provider?.models;
    if (!models || typeof models !== "object") continue;
    for (const [id, model] of Object.entries(models)) {
      const context = model?.limit?.context;
      if (typeof context !== "number" || !Number.isInteger(context) || context <= 0) continue;
      const key = id.toLowerCase();
      const seen = index.get(key);
      if (seen === undefined || context < seen) index.set(key, context);
    }
  }
  windowIndexes.set(catalog, index);
  return index;
}

let cached: { at: number; catalog: unknown } | undefined;

/**
 * The catalogue, fetched at most once an hour. Undefined when it cannot be had: the caller measures
 * instead, so a catalogue outage costs time and never a wrong answer.
 */
export async function loadModelCatalog(fetchImpl: typeof fetch = fetch): Promise<unknown> {
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.catalog;
  try {
    const response = await fetchImpl(CATALOG_URL, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
    if (!response.ok) return cached?.catalog;
    const catalog = await response.json() as unknown;
    cached = { at: Date.now(), catalog };
    return catalog;
  } catch {
    return cached?.catalog;
  }
}
