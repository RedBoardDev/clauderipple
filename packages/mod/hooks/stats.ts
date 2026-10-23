import type { AgentRec, Effort, JudgeAttempt, JudgeKind, JudgeTarget, Stats, Tier, Usage } from '../types'
import { t } from './i18n.ts'
import type { Lang } from './i18n.ts'

export function emptyStats(): Stats {
  return { prompts: 0, requests: 0, input: 0, write: 0, read: 0, out: 0, byEffort: {},
    judge: { haiku: 0, jev: 0, model: 0, ms: 0, tokens: 0 }, workers: {}, warm: { pings: 0, cost: 0 } }
}

/** Input-equivalent tokens compare real usage, not hypothetical dollars saved. */
export function weighted(usage: Usage): number {
  return (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) * 1.25 +
    (usage.cache_read_input_tokens ?? 0) * 0.1 + (usage.output_tokens ?? 0) * 5
}

/**
 * The effort a step was sent at: a routed id's `@effort` wins, since the router forces it over the
 * request's own (packages/router/src/routing.ts: "gpt-5.6-sol@medium → effort forced to medium").
 */
export function sentEffort(model: string, effort: string | number | undefined): string | number | undefined {
  return /@([a-z]+)$/.exec(model)?.[1] ?? effort
}

/**
 * An agent after one of its steps: the raw counts the API reported added to its own (what the
 * Agents pane shows, so it agrees with the host's), the weighted cost as before, the effort the step
 * was sent at and the model that answered.
 */
export function addAgentStep(agent: AgentRec, usage: Usage & { model?: string }, effort: string | number | undefined): AgentRec {
  const was = agent.usage ?? { input: 0, cached: 0, cacheWrite: 0, output: 0 }
  return {
    ...agent,
    cost: agent.cost + weighted(usage),
    usage: { input: was.input + (usage.input_tokens ?? 0), cached: was.cached + (usage.cache_read_input_tokens ?? 0), cacheWrite: was.cacheWrite + (usage.cache_creation_input_tokens ?? 0), output: was.output + (usage.output_tokens ?? 0) },
    ...(effort !== undefined ? { effort } : {}),
    ...(usage.model ? { answeredBy: usage.model } : {}),
  }
}

export function addRequest(stats: Stats, usage: Usage, effort: Effort): Stats {
  const bucket = stats.byEffort[effort] ?? { prompts: 0, cost: 0 }
  return { ...stats, requests: stats.requests + 1, input: stats.input + (usage.input_tokens ?? 0),
    write: stats.write + (usage.cache_creation_input_tokens ?? 0), read: stats.read + (usage.cache_read_input_tokens ?? 0),
    out: stats.out + (usage.output_tokens ?? 0),
    byEffort: { ...stats.byEffort, [effort]: { ...bucket, cost: bucket.cost + weighted(usage) } } }
}

export function addPrompt(stats: Stats, effort: Effort): Stats {
  const bucket = stats.byEffort[effort] ?? { prompts: 0, cost: 0 }
  return { ...stats, prompts: stats.prompts + 1,
    byEffort: { ...stats.byEffort, [effort]: { ...bucket, prompts: bucket.prompts + 1 } } }
}

export function addJudge(stats: Stats, judge: JudgeKind, ms: number, tokens: number): Stats {
  return { ...stats, judge: { ...stats.judge, [judge]: stats.judge[judge] + 1,
    ms: stats.judge.ms + ms, tokens: stats.judge.tokens + tokens } }
}

/**
 * What a chain of judge attempts amounts to: the first configured kind, the kind that answered (the
 * last one tried when none did) and the first failure, which stays even when a later judge rescued.
 */
export function judgeOutcome(configured: readonly JudgeTarget[], attempts: readonly JudgeAttempt[]): { asked: JudgeKind; by: JudgeKind; error?: string } {
  const error = attempts.find(attempt => attempt.error)?.error
  return { asked: configured[0]?.kind ?? 'haiku', by: attempts.at(-1)?.target.kind ?? configured[0]?.kind ?? 'haiku', ...(error ? { error } : {}) }
}

export function addWorker(stats: Stats, tier: Tier): Stats {
  return { ...stats, workers: { ...stats.workers, [tier]: (stats.workers[tier] ?? 0) + 1 } }
}

export function addWarm(stats: Stats, usage: Usage): Stats {
  return { ...stats, warm: { pings: stats.warm.pings + 1, cost: stats.warm.cost + weighted(usage) } }
}

export function formatStats(stats: Stats, lang: Lang): string {
  const total = weighted({ input_tokens: stats.input, cache_creation_input_tokens: stats.write,
    cache_read_input_tokens: stats.read, output_tokens: stats.out })
  const judges = stats.judge.haiku + stats.judge.jev + stats.judge.model
  const efforts = (['low', 'medium', 'high', 'xhigh', 'max'] as Effort[]).filter(level => stats.byEffort[level]).map(level => {
    const bucket = stats.byEffort[level]!
    return t(lang, 'commands.statsEffort', { effort: t(lang, 'band.' + level).toLowerCase(), prompts: bucket.prompts, cost: Math.round(bucket.cost) })
  })
  return [
    t(lang, 'commands.statsAuto', { prompts: stats.prompts, requests: stats.requests, total: Math.round(total) }),
    t(lang, 'commands.statsTokens', { input: stats.input, write: stats.write, read: stats.read, output: stats.out }),
    ...efforts,
    t(lang, 'commands.statsJudges', { ...stats.judge, avg: judges ? Math.round(stats.judge.ms / judges) : 0 }),
    t(lang, 'commands.statsWorkers', { workers: (['light', 'standard', 'deep', 'design'] as Tier[]).map(tier => `${t(lang, 'settings.' + tier).toLowerCase()} ${stats.workers[tier] ?? 0}`).join(', ') }),
    t(lang, 'commands.statsWarm', { pings: stats.warm.pings, cost: Math.round(stats.warm.cost) }),
  ].join('\n')
}
