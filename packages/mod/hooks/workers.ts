import type { Billing, Domain, Effort, LadderChoice, LadderOptions, Level, ModelScore, RouterModel, Rule, Rung, Settings, TierTarget, WorkerCandidate, WorkerPick, WorkerVerdict } from '../types'
import { CLAUDE_WORKERS, DOMAINS, EFFORTS, LEVELS, candidateKey, isAllowed } from './settings'
import { MARKER } from './worker'
import { t } from './i18n'
import type { Lang } from './i18n'
import { kindOf, parseEffortVerdict, verdictObject } from './judge'
import { claudeChoices, rungAbove, rungOf, tickedChoices } from './ladder'

/** The one agent the main chat delegates to; the judge picks the worker (docs/specs/2026-10-12-worker-tiers.md). */
// The description line: a chat that had seen other workers' "Sol·high · " titles wrote one here
// too, and the app's running-agent row showed "Sol·high" while Sonnet ran (2026-10-22). The row
// shows the call as written; only the task list gets the mod's corrected title.
export const AUTO_DESCRIPTION = 'Delegate any task here; ClaudeRipple picks the model. If a worker fails or returns nothing usable, delegate again here once and say the earlier attempt failed. ' +
  'Write the Agent description as the task alone, with no model or effort in front: ClaudeRipple puts the model it picks there. ' +
  'If you know how hard the task is, put [[ripple: light]], [[ripple: standard]], [[ripple: hard]] or [[ripple: max]] on the prompt\'s first line: ' +
  'light = lookups, mechanical edits, one small fix; standard = carry out a designed change (even across several files), research, summarize, read-only review; ' +
  'hard = subtle debugging, security review, or work where a wrong call is costly; max = planning, design or architecture where the deliverable is the decision itself. ' +
  'Size, file count or the brief\'s warnings do not by themselves make a task hard. Leave the marker out when unsure, and ClaudeRipple judges it. ' +
  'To run one particular model instead (the user asked for it, or a comparison needs it), name it on the first line: [[ripple: opus@high]] for a Claude model (opus, sonnet, haiku), or [[ripple: <worker agent name>@<effort>]]. ' +
  'It runs as named, past every ClaudeRipple rule, and still shows in the agents panel; never start a model another way, such as claude -p, to get around the rules. ' +
  'A brief states the scope, what must not be touched, the done criteria and how to verify them. Read the report for whether it did what was asked before using it. ' +
  'Continue a worker with SendMessage only within 5 minutes of its last reply; later its cache has lapsed, so start a new one with a summary of what is done and what is left.'

/**
 * The tier markers the main chat may write on a ripple:auto prompt, as the judge's verdict they
 * stand for (`rungOf` gives light, standard, hard, plan). The main chat knows the whole
 * conversation, the judge one brief: re-judging 62 delegations (2026-10-15), the judge sent 32 to
 * hard, Opus under this description 18. Not model names, so never routed as one.
 */
export const TIER_MARKERS: Readonly<Record<string, Pick<WorkerVerdict, 'level' | 'kind'>>> = {
  light: { level: 'light', kind: 'do' },
  standard: { level: 'standard', kind: 'do' },
  hard: { level: 'deep', kind: 'do' },
  max: { level: 'deep', kind: 'plan' },
}
/** The tier a marker names, if it is one. */
export function tierOf(marker: { name: string } | null): string | null {
  return marker && Object.hasOwn(TIER_MARKERS, marker.name) ? marker.name : null
}

export const WORKER_JUDGE_SYSTEM = `Choose a domain, capability level, kind of work and the cheapest effort that still does this delegated task well. Evaluate actual scope and risk, not prompt length.
Domains: design (visual taste, composition, brand), frontend (UI implementation), backend (APIs and server logic), infra (deployment and operations), data (queries and processing), test (verification), docs (writing), research (investigation), general (other or cross-domain).
Levels are independent of domain: light (chores, repeated edits, simple lookups, one small fix), standard (carry out a designed change, even across several files; research, summarize, read-only review), deep (subtle debugging, security review, or architecture where a wrong call is costly; size, file count, or warnings and prohibitions in the brief do not by themselves make work deep). A task that says an earlier attempt failed is one level higher than it would otherwise be.
Kind is determined by the deliverable, not preparatory steps. plan = pure planning: the deliverable is a decision, design, specification, or review verdict, NOT implemented code. do = carry out work: implement, fix, run, look up, write. Any task whose deliverable includes implemented code, files, builds or fixes is do, even if it says "read the spec/design first" or requires architecture/design reasoning before implementation. Writing a design/spec document alone remains plan; producing implementation files is do. Examples: "implement host listing of sessions" => do; "build an iOS app" => do; "read the spec first, then implement it" => do; "decide the session-listing architecture; do not implement" => plan. If planning and implementation are mixed, choose do. Deep plan is the hardest work, which runs on the strongest model, reserved for pure architecture, system design or consequential design decisions.
Effort choices are low, medium, high, xhigh, max; reserve the last two for exceptionally hard work. Return only JSON {"domain":"design|frontend|backend|infra|data|test|docs|research|general","level":"light|standard|deep","kind":"plan|do","effort":"low|medium|high|xhigh|max","sure":0.0,"why":"brief reason"}. Confidence is zero to one and is about the level; explain in the user's language in at most six words.`

export function workerJudgeInput(input: { description: string; prompt: string }): string {
  return `Task: ${input.description}\n\nInstructions:\n${input.prompt.slice(0, 3000)}`
}
/**
 * A kind the judge leaves out or garbles reads as do: the verdict's level still stands, and losing
 * it over the kind would send the task to the default instead.
 */
export function parseWorkerVerdict(text: string): WorkerVerdict | undefined {
  const verdict = parseEffortVerdict(text)
  const raw = verdictObject(text)
  if (!verdict || !DOMAINS.includes(raw?.domain as Domain) || !LEVELS.includes(raw?.level as Level)) return undefined
  return { ...verdict, domain: raw!.domain as Domain, level: raw!.level as Level, kind: kindOf(raw!.kind) ?? 'do' }
}
export function readMarker(prompt: string): { name: string; level?: string } | null {
  const marker = MARKER.exec(prompt)
  return marker ? { name: marker[1]!.toLowerCase(), ...(marker[2] ? { level: marker[2].toLowerCase() } : {}) } : null
}
export function agentProvider(agentFileText: string): string | undefined {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(agentFileText)?.[1]
  const description = head && /^description:\s*(.*)$/m.exec(head)?.[1]
  return description ? /\bvia\s+([A-Za-z0-9_-]+)\./.exec(description)?.[1]?.toLowerCase() : undefined
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
const baseModel = (model: string): string => model.replace(/@[^@]*$/, '')

/** Unknown availability is not exhaustion; known accounts must pass every quota window. */
export function chatgptUsable(status: unknown): boolean {
  const accounts = record(record(record(status).chatgpt).accounts).chatgpt
  if (!Array.isArray(accounts)) return true
  return accounts.some(value => {
    const account = record(value)
    if (account.state !== 'ready' || account.paused || account.needsReauth) return false
    const limits = record(record(account.quota).rate_limits)
    return ['primary', 'secondary'].every(name => {
      const window = record(limits[name])
      return typeof window.used_percent !== 'number' || window.used_percent < 100
    })
  })
}
/** Config is the router's catalogue, including native Anthropic declarations. Never retain headers. */
export function routerModelOptions(config: unknown): RouterModel[] {
  const out: RouterModel[] = []
  for (const [provider, value] of Object.entries(record(record(config).providers))) {
    for (const model of list(record(value).models)) {
      const { id, name } = record(model)
      if (typeof id === 'string' && id) out.push({ value: id, label: `${id} · ${provider}`, provider, ...(typeof name === 'string' && name.trim() ? { name } : {}) })
    }
  }
  return out
}
export function zenJev(config: unknown): { authorization?: string; model: string } {
  const provider = record(record(record(config).providers)['opencode-zen'])
  const key = record(provider.headers).authorization
  const model = list(provider.models).map(m => record(m).id).find(id => typeof id === 'string' && id.toLowerCase().includes('jev'))
  return { ...(typeof key === 'string' && key.trim() ? { authorization: key } : {}), model: typeof model === 'string' ? model : 'jev-latest' }
}
/** Validate HTTP score data at the boundary; malformed entries are not selectable measurements. */
export function scoreModels(raw: unknown): ModelScore[] {
  return list(record(raw).models).flatMap(value => {
    const model = record(value)
    if (typeof model.model !== 'string' || typeof model.provider !== 'string') return []
    const variants = list(model.variants).flatMap(v => {
      const variant = record(v)
      if (variant.effort !== null && !EFFORTS.includes(variant.effort as Effort)) return []
      const valid = (n: unknown): n is number | null => n === null || typeof n === 'number' && Number.isFinite(n) && n >= 0
      if (!valid(variant.intelligence) || !valid(variant.costPerTask)) return []
      return [{ effort: variant.effort as Effort | null, intelligence: variant.intelligence, costPerTask: variant.costPerTask }]
    })
    return [{ model: model.model, provider: model.provider, variants }]
  })
}
/**
 * Allow-lists name worker agents, and Claude's own models as `general-purpose:<model>`; provider
 * names from settings saved before 2026-10-10 still match.
 */
export function allowed(candidate: WorkerCandidate, allow: readonly string[], known: readonly string[] = []): boolean {
  return isAllowed(candidateKey(candidate.target), candidate.provider, allow, known)
}
/** Claude's own models as candidates: general-purpose on each. */
export function claudeCandidates(): WorkerCandidate[] {
  return CLAUDE_WORKERS.map(w => ({ target: { ...w.target }, model: w.model, provider: w.provider }))
}
const BILLINGS: readonly Billing[] = ['free', 'payg', 'subscription']
/**
 * The router's rung choices (GET /api/mod-options), validated at the boundary: its workers whose
 * provider can run now, with ladders, billing and cheapest measured cost, then Claude's own
 * models; only the ticked ones (`allow`, empty for every model).
 */
export function ladderOptionsFrom(raw: unknown, until: number, allow: readonly string[] = [], allowKnown: readonly string[] = []): LadderOptions {
  const root = record(raw)
  const efforts = (value: unknown): Effort[] => list(value).filter((e): e is Effort => EFFORTS.includes(e as Effort))
  const usable = new Set(list(root.providers).flatMap(p => { const v = record(p); return typeof v.name === 'string' && v.usable !== false ? [v.name] : [] }))
  const catalogue = list(root.providers).length > 0
  const scores = scoreModels(root.scores)
  const choices: LadderChoice[] = list(root.agents).flatMap(value => {
    const a = record(value)
    if (typeof a.name !== 'string' || !a.name || typeof a.model !== 'string' || typeof a.provider !== 'string') return []
    if (catalogue && !usable.has(a.provider)) return []
    const costs = (scores.find(s => s.model === a.model && s.provider === a.provider)?.variants ?? []).flatMap(v => v.costPerTask === null ? [] : [v.costPerTask])
    const billing = BILLINGS.includes(a.billing as Billing) ? a.billing as Billing : 'payg'
    return [{ target: { agent: a.name }, model: a.model, provider: a.provider, billing, efforts: efforts(a.efforts), ...(costs.length ? { cost: Math.min(...costs) } : {}) }]
  })
  const providers = Object.fromEntries(list(root.providers).flatMap(value => {
    const p = record(value)
    if (typeof p.name !== 'string' || typeof p.usable !== 'boolean') return []
    return [[p.name, { usable: p.usable, ...(typeof p.reason === 'string' ? { reason: p.reason } : {}), ...(typeof p.exhaustedUntil === 'number' ? { exhaustedUntil: p.exhaustedUntil } : {}) }]]
  }))
  return { until, choices: tickedChoices([...choices, ...claudeChoices(efforts(root.claudeEfforts))], allow, allowKnown), providers }
}
export function candidateUsable(candidate: WorkerCandidate, settings: Settings, chatgpt: boolean, providers: NonNullable<LadderOptions['providers']> = {}): boolean {
  const live = providers[candidate.provider]
  return settings.providers[candidate.provider] !== false && (live ? live.usable : candidate.provider !== 'chatgpt' || chatgpt)
}
function unavailableReason(provider: string, providers: NonNullable<LadderOptions['providers']>, lang: Lang): string {
  const reason = providers[provider]?.reason
  if (!reason && provider === 'chatgpt') return t(lang, 'toasts.providerQuota')
  const labels: Record<string, string> = lang === 'ko'
    ? { insufficient_balance: '잔액 부족', billing_exhausted: '결제 한도 소진', quota_exhausted: '사용량 한도 소진' }
    : { insufficient_balance: 'insufficient balance', billing_exhausted: 'billing exhausted', quota_exhausted: 'quota exhausted' }
  return `${provider}: ${reason && labels[reason] || (lang === 'ko' ? '현재 사용 불가' : 'currently unavailable')}`
}
function sameTarget(a: TierTarget, b: TierTarget): boolean { return a.agent === b.agent && a.model === b.model }
function candidateOf(target: TierTarget, candidates: readonly WorkerCandidate[]): WorkerCandidate | undefined {
  return candidates.find(c => sameTarget(c.target, target)) ?? (target.agent === 'general-purpose' ? { target, model: target.model ?? 'sonnet', provider: candidates.find(c => c.model === baseModel(target.model ?? 'sonnet'))?.provider ?? 'anthropic' } : undefined)
}
/** Domain overrides belong to the effective worker set; a missing override uses its general ladder. */
export function workerRule(domain: Domain, settings: Settings): { rule: WorkerPick['rule']; ladder: Rule } {
  const key = domain === 'design' || domain === 'frontend' ? 'ui' : domain === 'backend' ? 'backend' : 'general'
  const ladder = key === 'general' ? undefined : settings.domainRules?.[key]
  return ladder ? { rule: key, ladder } : { rule: 'general', ladder: settings.rules.general }
}

/**
 * Visual design depends on the model's taste, not on how hard the task is (2026-10-21: a store
 * screenshot redesign judged "design, standard" ran on the light pair). Under the ui ladder a design
 * verdict on the light or standard rung is raised to the hard rung; frontend, other ladders and
 * verdicts already on hard or plan are untouched.
 */
export function domainVerdict(verdict: WorkerVerdict, rule: WorkerPick['rule']): { verdict: WorkerVerdict; raised?: 'design' } {
  if (rule !== 'ui' || verdict.domain !== 'design') return { verdict }
  const rung = rungOf(verdict)
  if (rung !== 'light' && rung !== 'standard') return { verdict }
  const { sure: _sure, ...rest } = verdict
  return { verdict: { ...rest, ...TIER_MARKERS.hard! }, raised: 'design' }
}

export type Resolution = { target?: TierTarget; effort: Effort; rung?: Rung; position?: number; skipped?: { rung: Rung; position: number; model: string; reason: string }[]; fallbackReason?: string }

/** Claude Code's own agent with no model: the subagent runs on the session's model. */
export const SESSION_MODEL: TierTarget = { agent: 'general-purpose' }

/**
 * The ladder: the verdict's rung, else one rung up, else the session model, never down. Whatever
 * ran instead says why (the fallback toast).
 */
export function ladderPick(verdict: WorkerVerdict, rule: Rule, settings: Settings, candidates: readonly WorkerCandidate[], chatgpt: boolean, lang: Lang, allow: readonly string[] = [], providers: NonNullable<LadderOptions['providers']> = {}, known: readonly string[] = []): Resolution {
  const wanted = rungOf(verdict)
  const skipped: NonNullable<Resolution['skipped']> = []
  const reasons: string[] = []
  for (const rung of [wanted, rungAbove(wanted)]) {
    if (!rung) continue
    const steps = rule.rungs[rung] ?? []
    if (!steps.length) reasons.push(t(lang, 'workers.rungEmpty', { rung: t(lang, 'workers.rung.' + rung) }))
    for (const [index, step] of steps.entries()) {
      const target = step.target
      const candidate = candidateOf(target, candidates)
      const ticked = target.agent === 'general-purpose' && !target.model || candidate && allowed(candidate, allow, known)
      if (candidate && candidateUsable(candidate, settings, chatgpt, providers) && ticked) {
        return { target: { ...target }, effort: step.effort, rung, position: index + 1, skipped, ...(reasons.length ? { fallbackReason: reasons.join('; ') } : {}) }
      }
      const reason = !candidate ? t(lang, 'toasts.workerMissing', { name: target.agent }) : settings.providers[candidate.provider] === false ? t(lang, 'workers.disabled', { provider: candidate.provider }) : !ticked ? t(lang, 'workers.notCandidate', { name: candidate.model }) : providers[candidate.provider]?.usable === false ? unavailableReason(candidate.provider, providers, lang) : t(lang, 'toasts.providerQuota')
      const model = candidate?.model ?? target.model ?? target.agent
      skipped.push({ rung, position: index + 1, model, reason })
      reasons.push(`${model}: ${reason}`)
    }
  }
  const effort = rule.rungs[wanted]?.[0]?.effort ?? verdict.effort
  // The session's model is Claude's: with Anthropic switched off nothing is left to run it.
  if (settings.providers.anthropic === false) return { effort, rung: wanted, skipped, fallbackReason: t(lang, 'workers.none') }
  return { target: { ...SESSION_MODEL }, effort, rung: wanted, skipped, fallbackReason: reasons.join('; ') || t(lang, 'workers.none') }
}

export function spawnModel(target: TierTarget, effort: Effort, fileModel?: string): string | undefined {
  return fileModel && target.agent !== 'general-purpose' ? `${baseModel(fileModel)}@${effort}` : target.model
}
/** A prefix this mod (or the retired agent-title hook) put on a title: "Sol·high · ". */
const TITLE_PREFIX = /^[^\s·]+(?:·[a-z]+)? · /

/**
 * The model a title names: a Claude id or alias as its family and version ("Opus5.5"), a routed id
 * as its configured name's last word ("GPT-6.1 Sol" → "Sol"), else a gpt-* id's last part, else
 * the id.
 */
export function titleName(model: string, models: readonly RouterModel[] = []): string {
  const id = baseModel(model).replace(/\[.*?\]/g, '')
  const claude = /^(?:claude-)?(opus|sonnet|haiku|fable|mythos)(?:-(\d+)(?:-(\d{1,2}))?)?/i.exec(id)
  if (claude) return claude[1]!.charAt(0).toUpperCase() + claude[1]!.slice(1).toLowerCase() + (claude[2] ? claude[2] + (claude[3] ? '.' + claude[3] : '') : '')
  // A hosted id's vendor path ("deepseek-ai/") is dropped: the title has room for the model only.
  const named = models.find(m => m.value.toLowerCase() === id.toLowerCase())?.name
  if (named) return named.trim().split(/\s+/).pop()!.replace(/^.*\//, '')
  const gpt = /^gpt-[\d.]+-([a-z]+)$/i.exec(id)
  return gpt ? gpt[1]!.charAt(0).toUpperCase() + gpt[1]!.slice(1) : id.replace(/^.*\//, '')
}

/**
 * The background-task title with the model that really runs it in front: "Sol·medium · Fix X".
 * The app names only Claude models, and for a routed one shows the parent's; the mod is the one
 * that knows, since it picks. A prefix already there (the parent's guess) is replaced.
 */
export function spawnTitle(description: string, model: string, effort: string | undefined, models: readonly RouterModel[] = []): string {
  const tag = titleName(model, models) + (effort ? '·' + effort : '')
  return `${tag} · ${bareTitle(description)}`
}

/** A title without the model tag spawnTitle put in front ("Sol·high · Port it" → "Port it"). */
export function bareTitle(description: string): string {
  const bare = description.replace(TITLE_PREFIX, '')
  return bare.trim() ? bare : description
}

export function takesOver(spawn: { subagentType: string; model?: string; fork: boolean }, settings: Settings): boolean {
  if (spawn.fork || settings.agentAuto === 'off') return false
  return ['ripple:auto', 'auto'].includes(spawn.subagentType) || (settings.agentAuto === 'all' && spawn.subagentType === 'general-purpose' && spawn.model === undefined)
}
