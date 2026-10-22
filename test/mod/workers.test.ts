import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { DEFAULTS, normalizeSettings } from '../../packages/mod/hooks/settings.ts'
import { rungOf } from '../../packages/mod/hooks/ladder.ts'
import type { Settings, WorkerCandidate, WorkerVerdict } from '../../packages/mod/types/index.d.ts'
registerHooks({ resolve(specifier, context, next) {
  const source = context.parentURL?.includes('/packages/mod/hooks/')
  return next(source && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/.test(specifier) ? `${specifier}.ts` : specifier, context)
} })
const { WORKER_JUDGE_SYSTEM, workerJudgeInput, parseWorkerVerdict, readMarker, agentProvider, chatgptUsable,
  ladderPick, domainVerdict, workerRule, routerModelOptions, zenJev, spawnModel, takesOver, claudeCandidates, allowed } = await import('../../packages/mod/hooks/workers.ts')
const candidates: WorkerCandidate[] = [
  { target: { agent: 'deepseek-v4-1-flash' }, model: 'deepseek-v4.1-flash', provider: 'deepseek' },
  { target: { agent: 'gpt-6-1-sol' }, model: 'gpt-6.1-sol', provider: 'chatgpt' },
  { target: { agent: 'gpt-6-astra' }, model: 'gpt-6-astra', provider: 'chatgpt' },
  { target: { agent: 'claude-sonnet-5-5' }, model: 'claude-sonnet-5-5', provider: 'zen' },
]
const verdict: WorkerVerdict = { domain: 'backend', level: 'standard', effort: 'medium', why: 'implementation' }
const pick = (s: Settings = DEFAULTS, v = verdict, workers = candidates, usable = true) => ladderPick(v, s.rules.general, s, workers, usable, 'en', s.allow)

test('judge separates domain and level, rejects mixed-tier legacy verdicts', () => {
  assert.match(WORKER_JUDGE_SYSTEM, /independent/)
  assert.equal(workerJudgeInput({ description: 'Review', prompt: 'x'.repeat(3000) + 'discard' }).includes('discard'), false)
  assert.match(WORKER_JUDGE_SYSTEM, /"kind":"plan\|do"/)
  // Deep planning is the Max worker's, and a retry after a failure reads as harder.
  assert.match(WORKER_JUDGE_SYSTEM, /Deep plan is the hardest work/)
  assert.match(WORKER_JUDGE_SYSTEM, /earlier attempt failed is one level higher/)
  assert.deepEqual(parseWorkerVerdict('```json\n{"domain":"design","level":"deep","effort":"high","sure":0.9,"why":"taste"}\n```'), { domain: 'design', level: 'deep', kind: 'do', effort: 'high', sure: 0.9, why: 'taste' })
  assert.equal(parseWorkerVerdict('{"domain":"backend","level":"deep","kind":"plan","effort":"high","sure":0.8,"why":"billing design"}')?.kind, 'plan')
  assert.equal(parseWorkerVerdict('{"domain":"backend","level":"deep","kind":"ponder","effort":"high"}')?.kind, 'do')
  for (const text of ['', '{}', '{"tier":"design","effort":"high"}', '{"domain":"bad","level":"light","effort":"low"}']) assert.equal(parseWorkerVerdict(text), undefined)
})
test('judge reserves plan for pure planning deliverables, never implementation after reading a spec', () => {
  assert.match(WORKER_JUDGE_SYSTEM, /deliverable is a decision, design, specification, or review verdict, NOT implemented code/)
  assert.match(WORKER_JUDGE_SYSTEM, /implemented code, files, builds or fixes is do/)
  for (const example of ['"implement host listing of sessions" => do', '"build an iOS app" => do', '"read the spec first, then implement it" => do']) assert.ok(WORKER_JUDGE_SYSTEM.includes(example))
  assert.match(WORKER_JUDGE_SYSTEM, /If planning and implementation are mixed, choose do/)
  assert.match(WORKER_JUDGE_SYSTEM, /Writing a design\/spec document alone remains plan/)
})

test('markers and frontmatter provider retain existing parsing semantics', () => {
  assert.deepEqual(readMarker('context\n[[ ripple : GPT-6.1-SOL @ HIGH ]]'), { name: 'gpt-6.1-sol', level: 'high' })
  assert.equal(agentProvider('---\ndescription: Executor via chatgpt.\n---\n'), 'chatgpt')
  assert.equal(agentProvider('description: via chatgpt.'), undefined)
})
test('account readiness and all windows decide availability; unknown is not exhaustion', () => {
  const status = (accounts: unknown[]) => ({ chatgpt: { accounts: { chatgpt: accounts } } })
  const ready = { state: 'ready', paused: false, needsReauth: false }
  assert.equal(chatgptUsable(status([ready])), true)
  assert.equal(chatgptUsable(status([])), false)
  for (const account of [{ ...ready, paused: true }, { ...ready, needsReauth: true }, { ...ready, quota: { rate_limits: { secondary: { used_percent: 100 } } } }]) assert.equal(chatgptUsable(status([account])), false)
  assert.equal(chatgptUsable({}), true)
})
test('router catalogue includes every declared model, including Anthropic and nongenerated Jev', () => {
  const config = { providers: { anthropic: { models: [{ id: 'claude-sonnet-5-5' }] }, 'opencode-zen': { models: [{ id: 'jev-1.13' }, { id: 'un-generated' }], headers: { authorization: 'Bearer exact' } } } }
  assert.deepEqual(routerModelOptions(config).map(m => m.label), ['claude-sonnet-5-5 · anthropic', 'jev-1.13 · opencode-zen', 'un-generated · opencode-zen'])
  assert.deepEqual(zenJev(config), { authorization: 'Bearer exact', model: 'jev-1.13' })
  assert.deepEqual(zenJev({}), { model: 'jev-latest' })
})
test('every field uses the general ladder and a missing level climbs', () => {
  assert.equal(pick().target?.agent, 'gpt-6-1-sol')
  assert.equal(pick(DEFAULTS, { ...verdict, domain: 'design', level: 'deep' }).target?.agent, 'gpt-6-astra')
  assert.equal(pick(DEFAULTS, { ...verdict, level: 'light' }, candidates.slice(1)).target?.agent, 'gpt-6-1-sol')
})
test('domain ladders select UI for design/frontend, backend separately, otherwise this set\'s general', () => {
  const s = normalizeSettings({ domainRules: {
    ui: { mode: 'ladder', rungs: { standard: { target: { agent: 'deepseek-v4-1-flash' }, effort: 'max' } } },
    backend: { mode: 'ladder', rungs: { standard: { target: { agent: 'gpt-6-astra' }, effort: 'high' } } },
  } })
  for (const domain of ['design', 'frontend', 'backend', 'general', 'docs', 'research', 'ops'] as const) {
    const { rule, ladder } = workerRule(domain, s)
    const expected = domain === 'design' || domain === 'frontend' ? 'ui' : domain === 'backend' ? 'backend' : 'general'
    assert.equal(rule, expected)
    assert.equal(ladder, expected === 'general' ? s.rules.general : s.domainRules![expected])
    const resolved = ladderPick({ ...verdict, domain }, ladder, s, candidates, true, 'en')
    assert.equal(resolved.target?.agent, expected === 'ui' ? 'deepseek-v4-1-flash' : expected === 'backend' ? 'gpt-6-astra' : 'gpt-6-1-sol')
  }
  assert.deepEqual(workerRule('backend', { ...s, domainRules: { ui: s.domainRules!.ui } }), { rule: 'general', ladder: s.rules.general })
  // Unavailable domain rungs climb only within that ladder, not into the general one.
  const blocked = ladderPick(verdict, s.domainRules!.backend!, s, candidates, false, 'en')
  assert.deepEqual(blocked.target, { agent: 'general-purpose' })
})

test('design under the ui ladder takes the heavy level whatever its difficulty; nothing else is raised', () => {
  const s = normalizeSettings({ domainRules: {
    ui: { mode: 'ladder', rungs: { standard: [{ target: { agent: 'deepseek-v4-1-flash' }, effort: 'low' }], plan: [{ target: { agent: 'gpt-6-astra' }, effort: 'high' }] } },
  } })
  const design: WorkerVerdict = { ...verdict, domain: 'design' }
  const levels: [Partial<WorkerVerdict>, boolean][] = [
    [{ level: 'light' }, true], [{ level: 'standard' }, true], [{ level: 'standard', kind: 'plan' }, false],
    [{ level: 'deep' }, false], [{ level: 'deep', kind: 'plan' }, false],
    // An unsure light verdict (standard rung) is raised too; an unsure standard one is already hard.
    [{ level: 'light', sure: 0.2 }, true], [{ level: 'standard', sure: 0.2 }, false],
  ]
  for (const [change, raise] of levels) {
    const given = { ...design, ...change }
    const out = domainVerdict(given, 'ui')
    if (!raise) { assert.equal(out.verdict, given); assert.equal(out.raised, undefined); continue }
    const { sure: _sure, ...rest } = given
    assert.deepEqual(out, { verdict: { ...rest, level: 'deep', kind: 'do' }, raised: 'design' })
    assert.equal(rungOf(out.verdict), 'hard')
    assert.equal(ladderPick(out.verdict, s.domainRules!.ui!, s, candidates, true, 'en').target?.agent, 'gpt-6-astra')
  }
  // The same light design verdict, unraised, would have run the light pair.
  assert.equal(ladderPick(design, s.domainRules!.ui!, s, candidates, true, 'en').target?.agent, 'deepseek-v4-1-flash')
  // frontend, backend and the general ladder keep the verdict's own level.
  for (const [domain, rule] of [['frontend', 'ui'], ['backend', 'backend'], ['design', 'general'], ['docs', 'general']] as const) {
    const given: WorkerVerdict = { ...verdict, domain, level: 'light' }
    assert.deepEqual(domainVerdict(given, rule), { verdict: given })
  }
})

test('quota/off never chooses the blocked provider: the ladder moves up, then to the session model', () => {
  // Standard (Sol) and the rung above (Astra) are both ChatGPT: out of quota, the session model runs.
  const out = pick(DEFAULTS, verdict, candidates, false)
  assert.deepEqual(out.target, { agent: 'general-purpose' })
  assert.equal(out.effort, 'medium')
  assert.match(out.fallbackReason ?? '', /ChatGPT/)
  // Light (DeepSeek) switched off moves up to Standard, never down.
  const off = normalizeSettings({ providers: { deepseek: false } })
  const up = pick(off, { ...verdict, level: 'light' })
  assert.equal(up.target?.agent, 'gpt-6-1-sol')
  assert.equal(up.rung, 'standard')
  assert.equal(up.effort, 'medium')
  assert.match(up.fallbackReason ?? '', /deepseek is switched off/)
  // A model of a switched-off provider named on Claude's own agent does not run either.
  const pinnedModel = normalizeSettings({ ...DEFAULTS, providers: { chatgpt: false }, rules: { general: { mode: 'ladder', rungs: { standard: { target: { agent: 'general-purpose', model: 'gpt-6.1-sol' }, effort: 'medium' } } } } })
  assert.deepEqual(pick(pinnedModel).target, { agent: 'general-purpose' })
})

test('spawn suffix and takeover retain named-worker and fork boundaries', () => {
  assert.equal(spawnModel({ agent: 'sol' }, 'max', 'gpt-6.1-sol@medium'), 'gpt-6.1-sol@max')
  assert.equal(spawnModel({ agent: 'general-purpose', model: 'sonnet' }, 'high'), 'sonnet')
  assert.equal(takesOver({ subagentType: 'ripple:auto', fork: false }, DEFAULTS), true)
  assert.equal(takesOver({ subagentType: 'ripple:auto', fork: true }, DEFAULTS), false)
  // The tier agents are gone (2026-10-12): a stale session's ripple:low runs as Claude Code spawns it.
  assert.equal(takesOver({ subagentType: 'ripple:low', fork: false }, DEFAULTS), false)
  assert.equal(takesOver({ subagentType: 'general-purpose', fork: false }, { ...DEFAULTS, agentAuto: 'all' }), true)
  assert.equal(takesOver({ subagentType: 'general-purpose', model: 'sonnet', fork: false }, { ...DEFAULTS, agentAuto: 'all' }), false)
})

test('allow-lists pick by worker agent, so one model from two providers is told apart; provider names still match', () => {
  const twins: WorkerCandidate[] = [
    { target: { agent: 'deepseek-flash' }, model: 'deepseek-v4.1-flash', provider: 'deepseek' },
    { target: { agent: 'deepseek-v4-1-flash' }, model: 'deepseek-v4.1-flash', provider: 'opencode-go' },
    ...candidates.slice(1),
  ]
  assert.equal(allowed(twins[1]!, ['opencode-go']), true)
  assert.equal(allowed(twins[0]!, ['opencode-go']), false)
  assert.equal(allowed(twins[0]!, []), true)
  // Claude's own models are ticked as general-purpose:<model>.
  assert.equal(allowed(claudeCandidates()[1]!, ['general-purpose:sonnet']), true)
  assert.equal(allowed(claudeCandidates()[1]!, ['gpt-6-1-sol']), false)
})

test('the ticked models bound the ladder: an unticked rung model falls to the next rung up, and the quick-settings choices list only the ticked', async () => {
  const { ladderOptionsFrom } = await import('../../packages/mod/hooks/workers.ts')
  // Sol is not ticked: Standard (Sol) moves up to Hard (Astra) and says so.
  const ticked = { ...DEFAULTS, allow: ['gpt-6-astra', 'general-purpose:opus', 'deepseek-v4-1-flash'] }
  const result = pick(ticked)
  assert.deepEqual([result.target?.agent, result.rung], ['gpt-6-astra', 'hard'])
  assert.match(result.fallbackReason ?? '', /not a candidate/)
  const raw = { providers: [{ name: 'chatgpt', usable: true }, { name: 'deepseek', usable: true }], agents: [
    { name: 'gpt-6-1-sol', model: 'gpt-6.1-sol', provider: 'chatgpt', billing: 'subscription', efforts: ['low', 'high'] },
    { name: 'gpt-6-astra', model: 'gpt-6-astra', provider: 'chatgpt', billing: 'subscription', efforts: ['low', 'high'] },
  ], claudeEfforts: ['low', 'high'] }
  assert.deepEqual(ladderOptionsFrom(raw, 0).choices.map(c => c.target.agent + (c.target.model ? ':' + c.target.model : '')), ['gpt-6-1-sol', 'gpt-6-astra', 'general-purpose:haiku', 'general-purpose:sonnet', 'general-purpose:opus', 'general-purpose:fable'])
  assert.deepEqual(ladderOptionsFrom(raw, 0, ['gpt-6-astra', 'general-purpose:opus']).choices.map(c => c.target.agent + (c.target.model ? ':' + c.target.model : '')), ['gpt-6-astra', 'general-purpose:opus'])
  assert.equal(Object.hasOwn(ladderOptionsFrom(raw, 0), 'presets'), false)
})
