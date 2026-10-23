// The context windows ClaudeRipple reports for ChatGPT-subscription models.
//
// The Codex catalogue's `context_window` is not the window Codex runs with: Codex multiplies it by
// the entry's `effective_context_window_percent` — 2026-10-23, gpt-6.1-sol: 500000 × 95% = 475000.
// ClaudeRipple copied 272000 into config once and never followed either number, so Codex ran 6.1
// Sol at 475000 while Claude Code compacted it at 258400 (272000 × 95%). The adapter records what
// the live catalogue says here whenever it reads it (`noteChatgptModelWindows`), and one resolver
// (`chatgptModelWindow`) gives those figures to bootstrap and picker ahead of any stored
// `contextWindow` and ahead of `cli.autoCompactWindow` (docs/ARCHITECTURE.md §4, 2026-10-23).
//
// Process-wide on purpose: bootstrap and picker responses are built long after the catalogue fetch,
// by code that never sees the adapter.

import type { Config, ProviderModel } from "../../config.ts";
import { declaredBy } from "../../routing.ts";

/** chatgpt model slug → effective window the live catalogue stated. */
const windows = new Map<string, number>();

/**
 * Keep the effective window of every model the catalogue just listed. Only models the catalogue
 * gave a window to are recorded; a slug it stops listing keeps the last window read for it, which
 * is still the truest figure we ever saw.
 */
export function noteChatgptModelWindows(models: ProviderModel[]): void {
  for (const model of models) {
    if (typeof model.contextWindow === "number" && model.contextWindow > 0) windows.set(model.id, model.contextWindow);
  }
}

const isChatgpt = (cfg: Config, provider: string): boolean => cfg.providers[provider]?.type === "chatgpt";

/**
 * The live catalogue's effective window for a ChatGPT-subscription model, or undefined when the
 * model is not served by a `chatgpt` provider — which leaves the caller on exactly the value it
 * used before. Undefined too before any catalogue has been read.
 *
 * `model` is what a request or a picker entry names: a model id, an `@effort` id, an alias, a
 * picker-slot key, or a prefix-rule model. A model reached through an alias, a direct prefix rule
 * or as a route's target counts as served by that provider.
 */
export function chatgptModelWindow(cfg: Config, model: string): number | undefined {
  const base = model.split("@")[0]!;
  // The same order `resolve` uses — prefix rule, then picker slot, then the provider that declares
  // the id — so the window follows the provider the request would actually go to.
  const direct = cfg.direct.find((d) => base.startsWith(d.prefix));
  if (direct) return isChatgpt(cfg, direct.provider) ? windows.get(cfg.aliases[base] ?? base) : undefined;
  const route = cfg.routes[base] ?? cfg.routes[base.replace(/-\d{8}$/, "")];
  if (route) {
    if (!isChatgpt(cfg, route.provider)) return undefined;
    const target = cfg.aliases[route.model] ?? route.model;
    return windows.get(target.split("@")[0]!);
  }
  // An alias is a marker name; the window belongs to the model it names.
  for (const id of new Set([cfg.aliases[base] ?? base, base])) {
    const owners = declaredBy(id, cfg);
    if (owners.length === 0) continue;
    // Several owners is the same ambiguity `resolve` refuses to guess at: it routes nowhere, so it
    // gets no window of ours either.
    return owners.length === 1 && isChatgpt(cfg, owners[0]!) ? windows.get(id) : undefined;
  }
  return undefined;
}
