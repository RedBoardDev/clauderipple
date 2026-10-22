# Worker tiers — design (2026-10-12)

Status: **built 2026-10-12 (commits d231fde, ba4d1a8, 7160945, 9b3529e).** Supersedes docs/specs/2026-10-11-worker-ladder.md (presets, field
overrides and "더 세밀하게" go away; the four rungs survive under new names).

Revised 2026-10-12: the main chat no longer names a tier. It only decides whether to delegate, and
always to `ripple:auto`; the judge picks among all four tiers, `max` included (deep + plan). The
four tier agents (`ripple:low/medium/high/max`) are no longer registered.

## Why

The ladder was still too much to set: presets, four rungs × model × effort × backup, two field
overrides, nine hidden fields. Community survey (2026-10-12, eight research workers; second-hand
claims) agreed on three points:

- People fix one model per role and leave it. Praised UIs are one switch (Cline: separate plan/act
  model) or one dial (Amp: mode).
- Auto-routing is disliked when it hides which model worked, or misjudges difficulty from the
  prompt alone.
- Better signals than prompt text: the orchestrator choosing, and stepping up on failure.

The main chat already knows the whole conversation; the judge sees one description. The first
build therefore had the **main chat name the tier**. Revised 2026-10-12: the main chat only
decides **whether** to delegate; the judge names the tier and the mod decides **which model**
serves it. A failed attempt reaches the judge as part of the next task's prompt.

## Model

Four workers, named by the effort words AI users already know (Claude Code effort, OpenAI
reasoning effort):

| Worker | Rung | Judge verdict | Use for |
|---|---|---|---|
| 로우 워커 | light | light | finding files, single lookups, skimming logs, mechanical edits |
| 미디움 워커 | standard | standard | specified implementation, refactors, summaries, drafts |
| 하이 워커 | hard | deep + do | hard debugging, multi-file changes, independent review and rebuttal |
| 맥스 워커 | plan | deep + plan | the best result available: planning, design, architecture, design decisions |

The workers are rungs, not agents (2026-10-12 revision): the only agent is `ripple:auto`, and the
judge picks one of the four (`ladder.ts` `rungOf`). An unsure verdict (`sure` < 0.5) moves up one
rung, low → medium → high; it never reaches max, which only a deep planning verdict does.

**Who decides what**

- Main chat: only whether to delegate, always to `ripple:auto`. Nothing in the user's CLAUDE.md;
  the agent's `description` (shipped in the plugin, always visible in the Agent tool list) says so.
  Distributable as is.
- Judge: how hard the task is — one of low/medium/high/max (light / standard / deep + do /
  deep + plan).
- Mod: which model and effort serve the tier, from the models the user ticked; skips providers
  that are off, out of quota or failing (402/429/5xx) and says so (existing `fallbackReason`);
  respects billing class.
- **Failure re-delegates once:** when a worker errors or returns no usable result, the main chat
  delegates to `ripple:auto` once more and says the earlier attempt failed (the `auto`
  description asks for this). The judge reads that as one level harder.
- Always visible: the task list label shows the model ("Astra·high · …"); every pick is logged as
  now (`worker pick:`, with its rung).

**Revised 2026-10-15: the main chat may name the tier.** The judge overcalled: of 64 delegations
(2026-10-12..15) it sent 48 to hard, because a brief's warnings ("read-only", "do not restart")
read as high stakes. Re-judged with tighter level wording (`judge.ts` `levelCriteria`) it gave
32; Opus, shown each delegation's recent conversation and brief under the description below,
gave 18 (light 1, standard 43, max 0).

- `ripple:auto`'s description (`workers.ts` `AUTO_DESCRIPTION`, still no CLAUDE.md needed) asks
  for `[[ripple: light|standard|hard|max]]` on the prompt's first line when the main chat knows,
  and to leave it out when unsure. `TIER_MARKERS` maps them to the verdicts `rungOf` reads; the
  marker is stripped before the worker or the router sees it (on any other worker it is just
  dropped, never routed as a model).
- With a marker the spawn does not wait for the judge. The judge still rates the same brief
  (`shadowJudge`), only into the log.
- No marker: the judge decides, as before.

**Added 2026-10-22: the description also names the explicit-model marker.** A session that wanted
Opus for a server review, where the backend ladder's hard rung is Sol, started seven `claude -p
--model claude-opus-5-5` processes from Bash: they ran, but outside the agents panel and the pick
log. `[[ripple: opus@high]]` on `ripple:auto` already did this (`requestPick`'s `explicit` branch:
no judge, no ladder, no mode, `by: "marker"`; measured 2026-10-22, `opus@low` ran on
`claude-opus-5-5` at effort low and was logged), but nothing told the main chat. The description
now does, and says not to start a model another way. It also carries what any delegator wants and
had kept in a personal CLAUDE.md: what a brief states, checking the report did what was asked, and
continuing a worker only within 5 minutes (after an 8-minute wait, three resumes rewrote 300k,
338k and 377k uncached tokens, 2026-09-28). Leftover files are the worker body's rule already
(`router/src/agents.ts`).

**The pick log decides whether the judge stays.** `~/.clauderipple/logs/worker-picks.jsonl`,
3,000 lines, three line types joined by the pick's `id`:

| `type` | written | fields |
|---|---|---|
| `pick` | at spawn | `by` (`session`/`haiku`/`jev`/`model`/`marker`/`default`), `tier`, `verdict` (with Jev's per-question `odds`), `rung`, `model`, `effort`, `promptChars` |
| `shadow` | after a session-tiered spawn | the judge's `verdict`, its `rung`, `judge`, `ms` |
| `outcome` | when the worker's turn completes | `reason` (`answer`/`aborted`/`refusal`/`error`), `aborted`, `ms`, `answerChars`, `cost` (weighted tokens) |

Lines before 2026-10-15 have no `type` (picks only). The brief itself is never logged; to re-judge
a pick, take its brief from the session transcript under the same description. A re-delegation
("the earlier attempt failed") is a later pick whose brief says so: the clearest sign the tier
was too low.

## Filling the tiers

The shared ticked-model list supplies every worker set. Each rung is an ordered `Step[]`, each
step `{target, effort}`. An empty rung is filled with one model by `fillLadder`'s existing
`claudeGpt` rule. Existing lists, including unticked or unavailable entries, are kept unchanged.
At dispatch, try each entry in order; skip missing, unticked, switched-off, quota-exhausted or
runtime-exhausted providers. Only when the whole list fails, try the list one rung up, then the
session model (never down or two rungs up). The pick log records its 1-based position and every
skipped model/reason; the fallback toast names the skipped model and reason.

## Operating modes

A mode is a saved worker set, not a prefer/avoid policy. **No mode is built in**. The user supplies
its name; `기본` (Base) means the base worker set, not a saved mode.

- **Name** — user-typed, up to 40 characters.
- **Rungs** — its own light/standard/hard/plan ordered lists (로우/미디움/하이/맥스), the same
  `Step[]` shape and ticked-model/effort options as Base. New modes copy Base, without aliasing it.
- **Delegation** — `normal` or `eager` (보통 / 적극 — 메인 대화는 지휘만). The main chat may run on
  any model, so no string names Claude as the one directing. Eager adds the existing
  hidden `prompt.submit` context note: "Delegate everything except judgment and final review to
  ripple:auto." First prompt after activation and after main-chat compaction only.
- **End** — `until: 'none' | number | { reset: '<provider>' }`: until turned off, epoch-ms time,
  or the named provider's first known quota reset **after activation** (끄기 전까지 / 시각 지정 /
  한도 초기화 때). Only that provider's reset counts, whatever the rung lists use.
  `'anthropic'` is Claude: the mod's received `SessionRateLimit.resetsAt`, the five-hour or
  seven-day window with the highest `percentUsed`, exactly as the band chooses its binding limit
  (input order breaks ties); do not extrapolate Claude's lazily started five-hour windows. Any
  other name is a ChatGPT provider: its signed-in, unpaused accounts' primary/secondary windows
  from `/api/chatgpt-accounts?provider=<name>`. Previously observed deadlines are checked before
  replacing a rolled-forward snapshot. Unknown resets never end a mode. Stored `'reset'` (before
  2026-10-12: any used provider's) loads as `{ reset: 'chatgpt' }` when any rung entry is a worker
  rather than Claude's own, else `{ reset: 'anthropic' }` — settings carry no worker provider, and
  ChatGPT is the only worker provider with a known reset.
  The dashboard: choosing 한도 초기화 때 shows a provider menu of only the providers whose future
  reset is known now (ChatGPT ones, then Claude), labelled "ChatGPT 한도 초기화 때" / "Claude 한도
  초기화 때"; the line under 종료 시점 names the chosen provider. It starts on a known provider the
  mode's workers use, else the first known. With none known, the choice remains visible but
  disabled, with the reason directly beside it, not a floating note.

Only one mode is active. Its lists replace Base's for routing; the same ordered fallback applies.
Explicit markers remain explicit. The band and every worker-pick log show the active mode name.
Time/reset expiration clears activation and displays one toast; the saved worker set remains.

## Screens

**Dashboard `#mod` → Workers card:**
1. 적용 대상 (off / ripple workers / all subagents) — as now.
2. Tabs: `[기본] [user mode names…] [+ 새 모드]`. The active set is marked independently of
   the tab being edited. The ticked-model list lives only on Base and is shared by every tab.
3. Every tab has four worker rows, each an ordered list of model·effort selects, ↑/↓ reorder,
   remove (minimum one), and `+ 모델 추가`.
4. A saved-mode tab also has editable name, delegation, end, delete and an explicit
   `이 모드 켜기/끄기` control. Creating a mode asks for a name and copies Base's lists.
5. Base also has Delegation (2026-10-21), used while no mode is on; a mode's own replaces it.

**In-session quick settings:** active mode select (Base + saved modes) only for worker settings;
individual workers are edited on the dashboard. Existing effort/judge/cache controls stay.

## Migration

- Ladder rungs Light/Standard/Hard/Plan → low/medium/high/max, models and efforts kept.
- A stored single Step loads as a one-item list, in Base and every mode.
- Old target/action modes copy the current normalized Base ladder on load, dropping target/action;
  name, delegation and end survive. Existing saved lists remain independent of later Base edits.
- Field overrides and "더 세밀하게" rules are dropped; the card shows a one-time line saying so.
- Auto (experimental, AA floors) is removed; `ripple:auto` uses the judge + tiers above.

## Optional domain ladders (2026-10-21)

Each worker set (Base or a saved mode) may store `domainRules: { ui?: Rule; backend?: Rule }`
next to its general ladder, never inside `settings.rules`. `design` and `frontend` verdicts use
`ui`; `backend` uses `backend`; other domains use general. An absent override uses **that set's**
general ladder. An active mode replaces both general and domain rules completely: a missing mode
override never inherits Base's. New modes deep-copy Base's general and optional domain ladders;
existing modes gain no overrides on load. Normalization keeps only valid optional ladders and
reuses ordered-step validation, then folds them into two levels (below). Retired per-field
pin/Auto rules remain retired.

A tier marker still owns the rung. **Only when the effective set has a domain override** does the
spawn await its existing shadow judge, taking only its domain and reusing the same result for the
shadow log. This conditional wait is necessary because the domain determines which ladder to
consult; the judge cannot replace the marker's level/kind/confidence or promote its rung. Judge
failure/timeout uses general. Without domain overrides, the shadow judge remains unawaited and
does not affect dispatch or its latency. Explicit model markers keep their existing priority.
Every `WorkerPick` and pick log records `rule: 'ui' | 'backend' | 'general'` beside the rung.
Availability, ticked models, provider policy and within-ladder fallback are unchanged.

The dashboard adds `전체 | 프론트엔드·디자인 | 백엔드` above the worker rows in every set tab.
An optional domain has a `따로 정하기` switch: off shows that it follows general; on deep-copies
that set's current general rungs and opens the same ordered-list editor. Turning it off deletes
the override. The router fills empty rungs in existing Base and mode domain ladders using the
same `fillLadder` as general, without creating absent overrides. All six UI languages cover the
controls. The shared model checklist stays on Base.

**A domain ladder has two levels, not four (2026-10-21).** The stored shape keeps the four rungs,
so `ladderPick` and `rungOf` are untouched, but the two pairs are equal: `light` and `standard`
hold one list, `hard` and `plan` another. Normalization folds every domain ladder (`ui`,
`backend`, in Base and in each saved mode) with `twoLevelRungs`: the upper rung of each pair wins
— `standard`'s list for the light pair, `plan`'s for the heavy one — and an empty upper rung
falls back to the lower. The general ladder is **not** folded: it keeps four distinct rungs.

Why: in practice a domain does not have four different tiers. The four general rungs are four
models of the same ladder, and a domain ladder with four lists mostly sent trivial CSS edits to
the design model — the mistake the domain ladder itself was meant to prevent. Two levels keep the
choice the user actually makes ("this domain's cheap work" vs "this domain's hard work"), while
the router still climbs rung by rung inside a level.

**Design always takes the heavy level (2026-10-21).** Under the `ui` ladder a `design` verdict on the light or standard rung is raised to the hard rung (`domainVerdict` in `workers.ts`, logged as `raised: 'design'` beside `rule`); This holds past a tier marker too, the one exception to the marker owning the rung: the main chat tiers by difficulty, and by that measure design is `standard`. `frontend`, the `backend` ladder, the general ladder and explicit model markers keep their rung. Why: a store-screenshot redesign was judged `design`/`standard` and ran on the light pair; the main chat stopped it and resent it as `hard` (pick log, 2026-10-21). Visual design depends on the model's taste, not on difficulty.

The dashboard shows the two levels instead of four rows: `가벼운 작업` edits the light pair
(the same list is written to `light` and `standard`), `무거운 작업` edits the heavy pair (`hard`
and `plan`). Each row shows the pair's upper rung. Switching `따로 정하기` on copies the set's
general rungs folded the same way (light pair ← `general.standard`, heavy pair ← `general.plan`).
The router fills a domain ladder and folds it again, so the pairs stay equal after the fill.

## Acceptance

Ten-task probe (as 2026-10-11) dispatched by the main chat to `ripple:auto` without hints: the
judge lands each on a sensible tier, a planning/architecture task on max; every pick logged with
rung + model; a forced 402 on the low model steps to the next available model and shows the
reason; a failed task is re-delegated to `ripple:auto` once, saying the earlier attempt failed,
and the judge lands it one level up.
