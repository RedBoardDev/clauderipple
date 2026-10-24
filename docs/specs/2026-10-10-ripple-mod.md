# Ripple mod — design (2026-10-10)

The status mod in `packages/mod` grows into ClaudeRipple's in-session control surface: it picks
the reasoning effort for every prompt, picks the worker for every delegated task, can keep the
prompt cache warm, and carries the session tools a heavy Claude Code user needs (context, cache,
limits, compact). The open-source mod "effortless" (HeyCubit, MIT) proved most of the
main-chat ideas; it is a **behavioral reference only** — no code is copied from it, as with the
other reference implementations (project CLAUDE.md).

## Measured before design (2026-10-10, Claude Code 2.1.293 from the desktop app bundle, `-p`)

| Question | Result |
|---|---|
| A mod registers an agent type and swaps it at spawn | `$.agent.register({name:'auto',…})` → `ripplespike:auto`; `agent.spawn` rewriting `subagentType` to `deepseek-v4-1-flash` and `model` to `deepseek-v4.1-flash@low` ran the worker on that id. |
| `$.model.complete` with a router model id | `deepseek-v4.1-flash` answered in 1.9 s through the router; `claude-haiku-5-5` in 0.96 s. |
| `$.model.fork` reads the session's cache | fork of a 46k-token chat: `cache_read_input_tokens` 46,301, cache write 60, output 4. The fork fires `turn.step` with no `agentId` (looks like a main request). |
| `turn.step` effort rewrite keeps the cache (Sonnet 5.5) | three resumed turns at medium → low → high: cache read 46.9k / 47.0k / 47.0k, writes 66–97; the router recorded effort low/high. |

The terminal CLI on this Mac is 2.1.278, below the 2.1.287 mods minimum; the desktop app runs
2.1.293. API facts not measured here come from the official mods docs
(code.claude.com/docs/en/plugins/mods/*) and the generated declarations in
`packages/mod/.claude-plugin/types/claude-code/index.d.ts` (written by 2.1.293), which win over
prose when they disagree.

## Identity

- Plugin name becomes `ripple` (agent type `ripple:auto`, command `/ripple`). `packages/cli/src/settings.ts`
  recognises both `ripple` and the old `clauderipple-status` when it adds or removes the plugin dir.
- `/ripple-log` and `/ripple-bar` stay as aliases.

## Engine rules every file must follow

- `$` may be used only inside `hooks/register.tsx` (the engine follows `$` only into functions of
  the file that holds the hooks, and refuses passing `$` to imported helpers). Everything else is
  pure: plain functions, data in, data out, unit-tested with `node --test`.
- No Node APIs in mod code. Imports: relative files and `claude-code` only.
- Module variables die on reload; `$.state` atoms survive reload but not `/clear`; `$.store` is shared by
  every session on the machine (4 MiB). Settings live in the store; per-chat things in atoms.
- `$` calls after a hook returns are refused: background work runs from `$.clock.every` timers
  started in `session.start`.
- Hooks budget 10 s of own time; a failing hook before `next` fails open. Every hook wraps its own
  work so a bug never blocks a prompt, a spawn or a request.

## 1. Effort Auto (main chat)

- **When:** `prompt.submit` from a person (origin composer/bridge/sdk). Skipped for host slash
  commands, for short follow-ups (≤ 12 chars and ≤ 2 words, no attachment, previous assistant tail
  has no `?`) which keep the current pick, and while Auto is off.
- **Judge input:** model family + current effort, last user message (400 chars), last assistant
  tail (2,000 chars), next message (2,000; Jev 4,000), attachment counts, context %. Mid-turn
  submissions are marked as steering of the running work.
- **Judges:** `haiku` (default; `$.model.complete` `claude-haiku-5-5`, effort low, 160 tokens, 6 s,
  one retry on alias `haiku`), `jev` (TypeSafe, §4; falls back to Haiku on failure, > 3 s, or
  confidence < 0.5), `model` (any router model id via `$.model.complete`, e.g. `deepseek-v4.1-flash`;
  falls back to Haiku). Output `{effort, sure, why}`; `why` ≤ 6 words in the user's language.
- **Verdict → effort:** bias −2..2 tips only close calls (|bias| 1: sure < 0.65; 2: sure < 0.85) by
  one step; then floor/ceiling (ceiling below floor = floor); then Save mode caps at medium.
  A lower effort chosen mid-turn waits for the turn to end.
- **Apply:** `turn.step`, main requests only (`agentId` undefined, not our own fork), rewriting
  `effort` for every request of the prompt. Only on cache-safe models: ids matching
  `(opus|sonnet|haiku)-5-5`. Everything else (Fable, older, non-Claude main models) shows
  `Paused` — unmeasured there, and Fable 5.1 lost 56–100 % of its cache per effortless.
- **Person wins:** the first effort seen on a main request is the app's; a later differing app
  effort means the person changed it → Auto off, toast, pass through. Manual effort buttons set a
  manual pick and fill `/effort <level>` in an empty prompt so the app's own control follows.

## 2. Worker Auto (subagents) — new

- `session.start` registers `ripple:auto`: description tells the main model to delegate any task
  through it and that the mod picks the model and effort (this replaces the worker table people
  keep in CLAUDE.md). Its prompt is the generated workers' shared executor prompt.
- `agent.spawn` with `subagentType` `ripple:auto` (or, with setting `agentAuto: all`, also
  `general-purpose` without an explicit `model`): judge the task, then rewrite `subagentType` and
  `model`. Explicit choices are respected: a named worker or an explicit `[[ripple: x@y]]` marker
  skips the judge (the existing `worker.ts` fixes still apply).
- **Two independent axes:** the judge returns `{domain, level, effort, sure, why}`. Domain is
  `design | frontend | backend | infra | data | test | docs | research | general`; level is
  `light | standard | deep`. Design means visual taste, not every frontend implementation.
  Jev asks separate `domain`, `level` and `effort` choice questions. Failure defaults to
  `general / standard / high`. Judge input remains description + first 3,000 prompt characters.
- **Rules, not a mixed tier table:** `rules: Record<Domain, Rule>`; Rule is a Pin with
  `targets: Partial<Record<Level, TierTarget>>`, an Auto with `allow: string[]` (generated worker
  agent names, empty = all), or `{mode:'inherit'}` (use general). Allow names workers, not
  providers, because one model can come from two providers (deepseek-v4.1-flash via the DeepSeek
  API and via OpenCode Go) and a person wants one of them. Settings saved before this named
  providers: resolution still matches a provider name against a candidate's provider, and
  `normalizeSettings(raw, workers)` with the worker list known turns each provider name into that
  provider's workers (unknown names are kept); the mod's Save stores the migrated list. General itself cannot inherit;
  invalid general-inherit normalizes to the default Pin. Pin/Auto may carry effort calibration
  (`effortOffset: -2..2`, `floor`, `ceiling`). `TierTarget` remains `{agent, model?}`.
- Defaults: general Pin light → `deepseek-v4-1-flash`, standard → `gpt-6-1-sol`, deep →
  `gpt-6-astra`; design Pin light/standard → `general-purpose + sonnet`, deep →
  `general-purpose + opus`; every other domain inherits general. Old stored `tiers` migrate into
  general's targets and old `tiers.design` into all three design levels; explicit new rules win.
- **Availability:** sample generated agent files and `/api/status` at spawn. Known ChatGPT
  accounts must be ready and below 100% in every quota window; unknown availability is not
  exhaustion. `providers: Record<string,boolean>` defaults to `{}` (unspecified = on). Off is
  absolute for automatic picks, Pins, configured/built-in fallbacks and explicit named/marker
  selections; an explicit disabled choice or no enabled target refuses the spawn with a reason.
- **Effort:** Pins apply offset steps then floor/ceiling (floor wins an inverted ceiling).
  Router workers get `@effort` on the file's exact model id; built-in Claude agents get their
  effort through `turn.step` for that agent id. Explicit enabled markers bypass classification.
- **Jev sources:** `jevSource:'typesafe'|'zen'` (default TypeSafe). Zen POSTs the identical choice
  body to `https://opencode.ai/zen/v1/systemone`, with `model` the first id containing `jev` in
  `providers['opencode-zen'].models`, else `jev-latest`. Read the authorization header verbatim
  with `$.fs.read` from `<CLAUDERIPPLE_HOME or ~/.clauderipple>/config.json`; never retain it in an
  atom or fetch it from the admin API. Both sources time out at 3s and fall back to Haiku on
  failure or confidence < .5. Zen has no key input; missing-key text and Test use the same path.
- **Judge model list:** GET `<admin>/api/config`, every provider's declared `models[].id`, native
  Anthropic included, displayed as `model · provider`; it is not limited to generated workers.
- WorkerPick records domain, level, target, actual effort, why, judge, latency and fallback reason;
  Auto additionally records selected `aa:{intelligence,costPerTask}` and `runnerUp` target/effort/
  intelligence/cost. Stats count by level; old design counts remain readable.

### 2a. Resolution and controls (implemented 2026-10-10)

> Superseded 2026-10-11 for Pin and the Workers card by docs/specs/2026-10-11-worker-ladder.md
> (built; ARCHITECTURE §3b). Pin is gone (stored pins become ladders); Auto below stays, labelled
> experimental.

- There is no global `workerMode`. `rules.general` is the **main choice** (Auto or Fixed = Pin);
  every other domain whose rule is not `inherit` is an **exception**. Design defaults to an
  exception (Fixed: Claude Sonnet, deep → Opus) because AA does not measure taste, but can
  explicitly opt into Auto.
- **Pin:** resolve inheritance; use the selected level's target, walking upwards for missing
  files/empty targets. Quota exhaustion or an off provider does not silently choose a dearer
  pinned level: try usable entries named in `preference: string[]` (provider/model ids, first
  wins; generated-agent names also accepted), then configured `fallback`, built-in Sonnet,
  finally another enabled generated worker. If none can run, refuse. Apply the resolved rule's
  effort offset, floor and ceiling. A usable explicit Pin wins over preference.
- **Auto:** removed 2026-10-12, together with field rules and `/api/model-scores`. Routing is
  the four workers — see docs/specs/2026-10-12-worker-tiers.md.
- **UI (revised 2026-10-10; the router's web page uses the same structure):** Workers settings
  and setup step 2 share one card.
  1. *How workers are picked*: **Auto (recommended)** / **Fixed** — the main choice.
  2. Auto → *Candidates*: one switch row per generated worker from GET `<admin>/api/mod-options`
     `agents` (`{name, model, provider}`), title = model id, quiet second line = provider and the
     AA variant Auto would use for standard work (cheapest at or above the standard floor, else
     the strongest): `opencode-go · 39.5 · $0.27 at max`, or `no AA data`. All on by default
     (`allow: []`); switching one off stores the others by name, all on again stores `[]`, the
     last one cannot go off. The list and its scores are cached in a session atom for 10 minutes
     like the scores; without the router's answer the readable worker files on the router's
     catalogue stand in. Index floors, tie band and effort calibration sit behind a collapsed
     *Auto details* switch, with `cheapest above index N · Data: Artificial Analysis
     (artificialanalysis.ai)`.
  3. Fixed → light / standard / deep Selects of workers labelled `model · provider` (Claude's own
     as `Claude Sonnet`); *More options* holds the fallback and effort calibration.
  4. *Exceptions by field*: only the fields that differ from the main choice, each a button
     (`Design · Fixed`) that opens it in place of the main choice, with Back and Remove
     exception. *Add exception…* picks a field; it starts from the field's own default (Design:
     Claude) or a copy of the main choice, then Fixed per difficulty or Auto limited to chosen
     candidates.
  The Providers on/off and Preference sections are gone from the panel; `providers`,
  `preference` and `fallback` keep working as settings for compatibility. Rows past the band's
  budget page. Agents show domain/level and `index 50.2 · $0.32/task (next: …)` with the same
  attribution.
- **Desktop pill widths:** labels are drawn in SVG sized from `textWidth` before layout, so the
  estimate errs wide: East Asian wide characters (Hangul, kana, CJK, fullwidth, emoji) count
  1.04 em, Latin lower case 0.58 em (Chromium 2026-10-10 at 12px/500: Hangul 0.87 em). A
  pressable chip never shrinks (`flexShrink: 0`): an overflow-hidden flex item may otherwise be
  squeezed below its picture and cut the label.
- **Data:** a daily GitHub Action (`.github/workflows/aa-data.yml`, secret `AA_API_KEY`) reads the
  AA API (index, prices per variant) and each tracked variant's model page (its embedded record's
  `intelligenceIndexCostPerTask.cost.total`; the free API has no cost per task), and force-pushes
  one `aa-models.json` to the orphan branch `data`. Routers fetch that file at most daily (the
  `/api/model-scores` endpoint was removed 2026-10-12 with Auto); users need no AA key. Attribution "Data: Artificial Analysis" shows
  wherever the numbers do. Measured 2026-10-10: GPT-6.1 Sol high — index 50.2, $0.319/task; GPT-6
  Astra medium — 49.6 with 5× Sol's output price.

## 3. Keep warm — new, off by default

- Toggle on the band and in settings; `keepWarmHours` 1/2/4/8 (default 2) bounds how long after the
  last real reply it keeps going; `keepWarmMinTokens` (default 30k) skips small chats.
- Timer every 15 s: when the main chat is idle, its cache is warm, context ≥ min tokens, the
  cache would expire within 4 min (1 h TTL) or 60 s (5 min TTL), and the bound is not reached →
  `$.model.fork({prompt: 'Reply with just: ok'})`. Success with `cache_read_input_tokens > 0`
  restarts the countdown; null / no cache read → stop and say so once.
- A fork's own `turn.step` is not user activity: a module flag set around the fork keeps it out of
  effort Auto, busy state and stats (its usage counts as keep-warm cost instead).
- Each ping costs one cache read of the whole chat (~10 % of its input price, and the same share
  of a subscription's limits); the band shows pings and their total.

## 4. Jev (TypeSafe)

- `POST https://api.typesafe.ai/v1/systemone`, `authorization: Bearer <key>`, body
  `{model:'jev-latest', state:{task, current_model, current_effort, recent_conversation, next_message},
  questions:{<name>:{type:'choice', instructions, criteria:{<option>:<text>}}}}`; answers at
  `answers` or `result.answers`, each `{choice, confidence?, probabilities?}`; `usage.input_tokens`
  + `output_tokens`. 401/403 key rejected, 402 out of credits, 429 rate limited.
- Key: `TYPESAFE_API_KEY` env, else `~/.config/jev/.env` (`TYPESAFE_API_KEY=`), else the key pasted
  in settings, which is written to that file (mode 600). Sent to TypeSafe only. Prompts sent to
  Jev leave the machine — the settings card says so.

## 5. Session tools

- **Cache countdown:** TTL from the last main response's `usage.cache_creation` (1 h vs 5 m; default
  1 h), expiry = last main response + TTL; restored after reload from an atom; resumed chats use
  `classic.SessionStart.seconds_since_last_response` / `prompt_cache_likely_expired`.
- **Context:** `$.session.usage().context` (percent, tokens, window); unknown shows nothing.
- **Limits:** `rateLimits` `five_hour` / `seven_day` (max shown); ≥ 80 % shows the hot band with
  Save mode (caps Auto at medium until the window resets).
- **Bands** (priority): settings → compact note → setup → judge down → hot →
  result cards → cold (cache expired on a ≥ 150k chat) → swamp (context at or past 80 % of the
  compaction window) → dashboard. Each alert dismisses until it worsens.
- **Compaction:** `session.compact` for the main chat (not subagents, not `precompute`, which is
  skipped): serialize the transcript (last 6 messages' tool I/O 20k chars, older inputs
  400 / results 2k; 2.4M char budget, then tighter, then engine fallback), run the summary on
  `compactModel` (default Claude Haiku 5.5, 16k tokens, 240 s; `'session'` means the engine's own
  compactor; a router model id runs by name, with an optional `@effort` split off); success needs
  > 200 chars; failure falls back to the engine's own compaction with a toast. The context share
  and the heavy band are measured against the compaction window: Claude Code's own
  `autoCompactWindow` (settings.json, the same value `/autocompact` writes) when it is below the
  model's window, else the model's window. The dashboard's Compaction card picks the model
  (the app's compactor / Claude Haiku·Sonnet·Opus / router models by provider) and the point
  (400k / 500k / 600k / a typed value in k / model default).
- **Handoff (restored 2026-10-24, one button):** the band's Handoff has the session's own model
  write a resume note in a fork (nothing is sent to this chat; it is never cleared), then opens a
  new Code session in the same folder with the note in its prompt box (`claude://code/new`, which
  fills the box and waits for Enter). A note past 12k characters goes to
  `~/.clauderipple/handoffs/` and the box says to read it; no link → clipboard; a failed fork →
  a failed card. Why: app changes reach only new sessions (a `/clear` keeps the old one), so moving
  on is a routine step. The advice judge, choices and settings removed in 8480bae stay removed.
- **Stats** (`/ripple stats`): Auto-steered prompts by effort, weighted cost (input 1, write 1.25,
  read 0.1, output 5), judge counts/time/tokens, worker picks by tier, keep-warm pings and cost.

## 6. Interface

- **Band (desktop, SVG-drawn):** effort (Deciding glow / Paused / Off) · model · context ring ·
  cache countdown (with a keep-warm mark) · limits · last route (provider colour, cache hit) ·
  Handoff · Auto · Warm · Compact · Log · Agents · ⚙. Terminal: the same in text with hotkeys.
  Minimal layout: footer controls only.
- **Panes:** Log (existing request log) and Agents (each subagent: tier/agent/effort/why, state,
  current tool, elapsed, cost).
- **Settings panel** (cards): Effort · Workers (tier → agent selects, fallback, agentAuto) · Judge
  (Haiku / Jev with key + Test / router model) · Cache (keep warm, hours, min tokens) · Compaction
  (model, compaction window) · Look (dashboard/minimal, appearance auto/dark/light).
- **First run:** a short setup (judge, worker tiers, keep warm) opens once.
- Colours: ClaudeRipple accent `#6a56d6` (from packages/ui), provider hues from the existing
  `providerColor`; status green/amber/red stay semantic.

## Left out on purpose

- Per-prompt cheaper-model routing of the main chat: each model has its own cache, so a move in a
  warm chat costs ~5–10× staying (effortless measured; it ships off by default too).
- effortless's self-update card and uninstall: the mod ships inside ClaudeRipple, which updates it.
- Terminal pixel art and sounds (inactive in effortless as well). Revisit after the rest lands.

## Tests

- Pure modules: `packages/mod/test/*.test.ts`, run by `npm test` (`node --test`).
- Hooks and drawings: `packages/mod/tests/*.test.ts(x)` with `claude-code/testing`, run by
  `claude plugin test packages/mod` on ≥ 2.1.293.
- Live: desktop Code tab session with the mod loaded — band, a delegated task through
  `ripple:auto`, keep-warm ping visible in the router log.
