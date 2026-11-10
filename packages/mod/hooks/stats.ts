import type { AgentRec, Effort, JudgeKind, Stats, Tier, Usage } from '../types'
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
 * An agent after one of its steps: its last step's raw counts (not summed — each step re-sends the
 * whole conversation, so the last prompt is the conversation's size), the step's output added to the
 * running output total, the weighted cost as before, the effort the step was sent at and the model
 * that answered. The Claude app counts an agent's tokens this way, and so does the Agents pane
 * (`agentTokens`).
 */
export function addAgentStep(agent: AgentRec, usage: Usage & { model?: string }, effort: string | number | undefined): AgentRec {
  return {
    ...agent,
    cost: agent.cost + weighted(usage),
    usage: { input: usage.input_tokens ?? 0, cached: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0, output: usage.output_tokens ?? 0 },
    outputTotal: (agent.outputTotal ?? 0) + (usage.output_tokens ?? 0),
    ...(effort !== undefined ? { effort } : {}),
    ...(usage.model ? { answeredBy: usage.model } : {}),
  }
}

/**
 * The tokens the Claude app's task list counts for an agent: its last response's whole prompt
 * (uncached + cache write + cache read) plus every response's output. A finished agent takes the
 * larger of that and its last response's prompt and output, as the app does; the max only bites on
 * a record whose running output total lags its last step. Undefined before a step reports anything.
 */
export function agentTokens(agent: AgentRec): number | undefined {
  const usage = agent.usage
  if (!usage) return undefined
  const prompt = usage.input + usage.cached + (usage.cacheWrite ?? 0)
  const counted = prompt + (agent.outputTotal ?? usage.output)
  const ended = agent.state === 'done' || agent.state === 'failed' || agent.state === 'killed'
  return ended ? Math.max(counted, prompt + usage.output) : counted
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
