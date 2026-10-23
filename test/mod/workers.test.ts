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
  ladderPick, markerDomain, workerRule, routerModelOptions, zenJev, spawnModel, takesOver, claudeCandidates, allowed } = await import('../../packages/mod/hooks/workers.ts')
const { rivalProviders, userNamed } = await import('../../packages/mod/hooks/worker.ts')
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

test('under a domain ladder only light work takes the light row; ordinary work takes the heavy one', () => {
  const s = normalizeSettings({ domainRules: {
    ui: { mode: 'ladder', rungs: { light: [{ target: { agent: 'deepseek-v4-1-flash' }, effort: 'low' }], plan: [{ target: { agent: 'gpt-6-astra' }, effort: 'high' }] } },
  } })
  for (const domain of ['design', 'frontend'] as const) {
    const at = (change: Partial<WorkerVerdict>) => ladderPick({ ...verdict, domain, ...change }, s.domainRules!.ui!, s, candidates, true, 'en').target?.agent
    assert.equal(at({ level: 'light' }), 'deepseek-v4-1-flash')
    for (const change of [{ level: 'standard' }, { level: 'deep' }, { level: 'deep', kind: 'plan' }] as const) assert.equal(at(change), 'gpt-6-astra')
  }
})

test('a tier marker\'s domain word picks the ladder; no word is general', () => {
  assert.deepEqual(readMarker('[[ripple: standard ui]]\nWork.'), { name: 'standard', domain: 'ui' })
  assert.deepEqual(readMarker('[[ripple: hard  backend ]]\nWork.'), { name: 'hard', domain: 'backend' })
  assert.deepEqual(readMarker('[[ripple: gemini-3-8-flash@high]]'), { name: 'gemini-3-8-flash', level: 'high' })
  for (const [word, domain] of [['ui', 'frontend'], ['frontend', 'frontend'], ['design', 'design'], ['backend', 'backend'], ['server', 'backend'], [undefined, 'general'], ['docs', 'general']] as const) {
    assert.equal(markerDomain(word), domain)
    assert.equal(workerRule(markerDomain(word), normalizeSettings({ domainRules: { ui: DEFAULTS.rules.general, backend: DEFAULTS.rules.general } })).rule, domain === 'frontend' || domain === 'design' ? 'ui' : domain)
  }
})

test('a model counts as named only when the user said it lately, in English or Korean', () => {
  const user = (text: string) => ({ role: 'user' as const, text })
  const said = (...texts: string[]) => texts.map(user)
  assert.equal(userNamed('gemini-3-8-flash', said('제미나이한테 교정안 받아 와')), true)
  assert.equal(userNamed('gemini-3-8-flash', said('ask Gemini for a review')), true)
  assert.equal(userNamed('gpt-6-1-sol', said('솔한테 맡겨')), true)
  assert.equal(userNamed('gpt-6-1-sol', said('솔직히 이건 어려운 일이야')), false, 'a word that only starts with the name')
  assert.equal(userNamed('gpt-6-1-sol', said('GPT로 돌려')), true)
  assert.equal(userNamed('sonnet', said('소넷이 낫겠다')), true)
  assert.equal(userNamed('claude-opus-5-5', said('오푸스로 해')), true)
  assert.equal(userNamed('deepseek-v4.1-flash', said('flash 모델로')), false, 'a generic word names nothing')
  // Only the last two messages from the user: an older request does not cover later work.
  assert.equal(userNamed('gemini-3-8-flash', said('제미나이한테 시켜', '반영해', '이제 서버 고쳐')), false)
  // Tool results, notices and summaries are not the user.
  assert.equal(userNamed('gemini-3-8-flash', [user('일 해'), { role: 'user', text: 'gemini output', toolResults: [{}] }, user('<task-notification>gemini done</task-notification>')]), false)
  assert.equal(userNamed('gemini-3-8-flash', said('일 해', '<local-command-stdout>gemini</local-command-stdout>', 'This session is being continued … gemini')), false)
  // A reply the app quotes is the user's: it opens on an HTML comment, not a tag.
  assert.equal(userNamed('gemini-3-8-flash', said('<!-- reply 1 -->\n> 어느 모델로 할까요?\n\n제미나이로 해')), true)
  assert.equal(userNamed('gemini-3-8-flash', said('제미나이로 해', '<!-- reply 1 -->\n> 진행할까요?\n\n아니 그건 됐고 다른 거 해')), true, 'the quoted reply is one of the last two, the earlier message still counts')
  // A prompt typed while a turn ran is absorbed into that turn and never a user message: the prompts
  // as submitted are heard too (2026-10-23: "솔한테 돌려" mid-turn went by tier).
  assert.equal(userNamed('gpt-6-1-sol', said('에이전트 창이 비어', '버그 고쳐'), ['솔한테 버그탐지 돌려']), true)
  assert.equal(userNamed('gpt-6-1-sol', said('에이전트 창이 비어'), ['이것도 고쳐']), false)
  // A short "go" approves the answer it replies to.
  const proposal = [user('정리해'), { role: 'assistant' as const, text: '제미나이에게 맡기겠습니다. 진행할까요?' }, user('ㄱㄱ')]
  assert.equal(userNamed('gemini-3-8-flash', proposal), true)
  assert.equal(userNamed('gemini-3-8-flash', [...proposal.slice(0, 2), user('아니 다른 걸로 해 줘 이번엔')]), false)
})

test('Korean Argon and provider names preserve an explicit worker without authorizing its other provider', () => {
  const providers = ['google-gemini', 'opencode-go', 'chatgpt']
  const named = (model: string, provider: string, text: string, prompts: string[] = []) => userNamed(model, [{ role: 'user', text }], prompts, { provider, providers })
  for (const model of ['gemini-4-argon', 'gemini-4-argon-contributor']) {
    assert.equal(named(model, model.endsWith('contributor') ? 'opencode-go' : 'google-gemini', '아르곤한테 맡겨'), true)
  }
  for (const text of ['아르곤 api 지금 한도 꽉 차서 안될걸? 오픈코드쪽으로 써', '아르곤 API 대신 오픈코드', 'use OpenCode for Argon', 'opencode-go로 해', '오픈코드로 해']) {
    assert.equal(named('gemini-4-argon-contributor', 'opencode-go', text), true, text)
    assert.equal(named('gemini-4-argon', 'google-gemini', text), false, text)
  }
  for (const text of ['구글로 아르곤 돌려', 'google-gemini로 해']) {
    assert.equal(named('gemini-4-argon', 'google-gemini', text), true, text)
    assert.equal(named('gemini-4-argon-contributor', 'opencode-go', text), false, text)
  }
  assert.equal(named('gemini-4-argon-contributor', 'opencode-go', '버그 고쳐', ['오픈코드쪽으로 써']), true)
  assert.equal(named('gemini-4-argon', 'google-gemini', '버그 고쳐', ['오픈코드쪽으로 써']), false)
  assert.equal(named('gemini-4-argon', 'google-gemini', '아르곤처럼 생겼네'), false)
  assert.equal(named('gemini-4-argon-contributor', 'opencode-go', 'opencoded example'), false)
  assert.equal(userNamed('gemini-4-argon-contributor', [{ role: 'user', text: '<task-notification>오픈코드</task-notification>' }], [], { provider: 'opencode-go', providers }), false)
})

test('a model name shared with a provider is not a source restriction on other explicitly named models', () => {
  const source = { provider: 'chatgpt', providers: ['chatgpt', 'deepseek', 'google-gemini', 'opencode-go'] }
  assert.equal(userNamed('gpt-6.1-sol', [{ role: 'user', text: 'Use Sol, Astra or DeepSeek for this.' }], [], source), true)
  assert.equal(userNamed('gpt-6.1-sol', [{ role: 'user', text: '솔과 제미나이에게 각각 검토시켜' }], [], source), true)
  for (const provider of ['google-gemini', 'opencode-go']) {
    assert.equal(userNamed('gemini-4-argon', [{ role: 'user', text: '제미나이로 해' }], [], { ...source, provider }), true)
  }
})

test('only a rival source is chosen by naming a provider, and only in the user\'s own words', () => {
  const sources = [
    { model: 'gemini-4-argon', provider: 'google-gemini' }, { model: 'gemini-4-argon-contributor', provider: 'opencode-go' },
    { model: 'gpt-6.1-sol', provider: 'chatgpt' }, { model: 'deepseek-v4.1-flash', provider: 'opencode-go' },
  ]
  assert.deepEqual(rivalProviders('gemini-4-argon', sources).sort(), ['google-gemini', 'opencode-go'])
  assert.deepEqual(rivalProviders('gpt-6.1-sol', sources), ['chatgpt'])
  // Naming OpenCode for DeepSeek says nothing about which source runs Sol.
  const sol = { provider: 'chatgpt', providers: rivalProviders('gpt-6.1-sol', sources) }
  assert.equal(userNamed('gpt-6.1-sol', [{ role: 'user', text: '솔은 구현, 딥시크는 오픈코드로' }], [], sol), true)
  // The answer a short "go" replies to mentions a provider in passing; that is not the user's choice.
  const argon = { provider: 'google-gemini', providers: rivalProviders('gemini-4-argon', sources) }
  const answer = [{ role: 'user' as const, text: '아르곤으로 해' }, { role: 'assistant' as const, text: 'OpenCode 쪽 한도도 확인했습니다. 아르곤으로 진행할까요?' }, { role: 'user' as const, text: 'ㄱㄱ' }]
  assert.equal(userNamed('gemini-4-argon', answer, [], argon), true)
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
