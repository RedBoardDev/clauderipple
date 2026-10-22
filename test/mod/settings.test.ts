import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLAUDE_WORKERS, DEFAULTS, applySettingsChanges, allowedWorkers, candidateKey, hadRetiredRouting, isAllowed, normalizeSettings, settingsChanges, twoLevelRungs } from '../../packages/mod/hooks/settings.ts'
import type { Step } from '../../packages/mod/types/index.d.ts'

const ALLOW_WORKERS = [
  { name: 'gpt-6-1-sol', provider: 'chatgpt' },
  { name: 'general-purpose:sonnet', provider: 'anthropic' },
]

test('defaults hold one ladder', () => {
  assert.equal(DEFAULTS.judge, 'haiku')
  assert.equal(DEFAULTS.jevSource, 'typesafe')
  // The spec's "Claude + GPT" example ladder; the four workers replaced the field rules, so every field follows it.
  assert.deepEqual(DEFAULTS.rules, { general: { mode: 'ladder', rungs: {
    light: [{ target: { agent: 'deepseek-v4-1-flash' }, effort: 'max' }], standard: [{ target: { agent: 'gpt-6-1-sol' }, effort: 'medium' }],
    hard: [{ target: { agent: 'gpt-6-astra' }, effort: 'high' }], plan: [{ target: { agent: 'general-purpose', model: 'opus' }, effort: 'high' }],
  } } })
  assert.deepEqual(DEFAULTS.allow, [])
  for (const key of ['tiers', 'preference', 'autoFloors', 'autoTieBand']) assert.equal(Object.hasOwn(DEFAULTS, key), false, key)
})
test('rebasing settings preserves remote siblings and deletes only locally removed fields', () => {
  const before = normalizeSettings({ providers: { old: true }, fallback: { agent: 'general-purpose', model: 'sonnet' }, allow: ['old'] })
  const after = normalizeSettings({ ...before, providers: { local: false }, fallback: { agent: 'custom' }, allow: ['local'] })
  const remote = normalizeSettings({ ...before, language: 'ja', providers: { ...before.providers, remote: false }, allow: ['remote'] })
  const rebased = applySettingsChanges(remote, settingsChanges(before, after))
  assert.deepEqual(rebased.providers, { local: false, remote: false })
  // A list is replaced whole: the ticks this side made win over the other side's.
  assert.deepEqual(rebased.allow, ['local'])
  assert.deepEqual(rebased.fallback, after.fallback)
  assert.equal(rebased.language, 'ja')
  assert.deepEqual(remote.providers, { old: true, remote: false })
})
test('a rung changed here is rebased onto the other side, and an unchanged draft changes nothing', () => {
  const before = normalizeSettings(null)
  const general = before.rules.general
  const after = normalizeSettings({ ...before, rules: { general: { mode: 'ladder', rungs: { ...general.rungs, light: { target: { agent: 'general-purpose', model: 'haiku' }, effort: 'low' } } } } })
  const remote = normalizeSettings({ ...before, language: 'ko' })
  const rebased = applySettingsChanges(remote, settingsChanges(before, after))
  assert.deepEqual(rebased.rules.general, after.rules.general)
  assert.equal(rebased.language, 'ko')
  assert.deepEqual(settingsChanges(before, normalizeSettings(before)), [])
})
test('the skin is deep unless a stored one is deep or flat', () => {
  assert.equal(normalizeSettings(null).skin, 'deep')
  assert.equal(normalizeSettings({ skin: 'flat' }).skin, 'flat')
  assert.equal(normalizeSettings({ skin: 'matrix' }).skin, 'deep')
  assert.equal(normalizeSettings({ skin: 'glass' }).skin, 'deep')
  assert.equal(normalizeSettings({ skin: 2 }).skin, 'deep')
})

test('language accepts only auto and the six supported choices', () => {
  for (const language of ['auto', 'ko', 'en', 'zh', 'ja', 'es', 'pt']) assert.equal(normalizeSettings({ language }).language, language)
  for (const language of [undefined, null, '', 'Korean', 'ko_KR', 'fr', true, 1]) assert.equal(normalizeSettings({ language }).language, 'auto')
})
test('defaults are deeply independent after normalization', () => {
  for (const value of [undefined, null, false, 'bad', 7, [], {}]) assert.deepEqual(normalizeSettings(value), DEFAULTS)
  const first = normalizeSettings(null)
  first.hide.push('timer'); first.providers.chatgpt = false
  first.rules.general.rungs.light![0]!.target.agent = 'changed'
  first.allow.push('changed'); first.fallback.agent = 'changed'
  assert.deepEqual(normalizeSettings(null), DEFAULTS)
})
test('old tiers migrate the general ladder once, explicit new rules win, the design pin is dropped', () => {
  const migrated = normalizeSettings({ tiers: { light: { agent: ' custom ' }, design: { agent: 'general-purpose', model: 'haiku' } } })
  assert.equal(Object.hasOwn(migrated, 'tiers'), false)
  assert.deepEqual(migrated.rules.general, { mode: 'ladder', rungs: {
    light: [{ target: { agent: 'custom' }, effort: 'low' }], standard: [{ target: { agent: 'gpt-6-1-sol' }, effort: 'medium' }],
    hard: [{ target: { agent: 'gpt-6-astra' }, effort: 'high' }], plan: [{ target: { agent: 'gpt-6-astra' }, effort: 'xhigh' }],
  } })
  assert.deepEqual(Object.keys(migrated.rules), ['general'])
  const current = normalizeSettings({ ...migrated, tiers: { light: { agent: 'obsolete' } } })
  assert.deepEqual(current, migrated)
})
test('only the general ladder survives loading: Auto is a ladder to fill, field rules, backups and Auto\'s fields are dropped', () => {
  const s = normalizeSettings({ jevSource: 'zen', rules: { general: { mode: 'inherit' }, backend: { mode: 'auto', allow: ['chatgpt'], effortOffset: 2 }, docs: { mode: 'pin', targets: { light: { agent: 'worker' } } },
    design: { mode: 'ladder', rungs: { light: { target: { agent: 'general-purpose', model: 'haiku' }, effort: 'low' } } } }, providers: { chatgpt: false, deepseek: 'false' }, preference: ['gpt-6.1-sol', 'chatgpt', 'chatgpt', null], autoFloors: { light: 0, standard: -1, deep: 53 }, autoTieBand: 0 })
  assert.equal(s.jevSource, 'zen')
  assert.deepEqual(s.rules, { general: DEFAULTS.rules.general })
  assert.deepEqual(s.providers, { chatgpt: false })
  for (const key of ['preference', 'autoFloors', 'autoTieBand']) assert.equal(Object.hasOwn(s, key), false, key)
  // Auto becomes a ladder with no rung set, and its candidates become the ticked models.
  const auto = normalizeSettings({ rules: { general: { mode: 'auto', allow: [' sol ', 'sol', 1, 'gpt-6-astra'], floor: 'high' } } })
  assert.deepEqual(auto.rules.general, { mode: 'ladder', rungs: {} })
  assert.deepEqual(auto.allow, ['sol', 'gpt-6-astra'])
  // A rung keeps its model and effort; its backup is dropped, and a rung with no model stays empty.
  const backed = normalizeSettings({ rules: { general: { mode: 'ladder', rungs: { light: { target: { agent: 'a' }, effort: 'high', backup: { agent: 'b' } }, standard: { effort: 'low' } } } } })
  assert.deepEqual(backed.rules.general, { mode: 'ladder', rungs: { light: [{ target: { agent: 'a' }, effort: 'high' }] } })
  // The ticks written on a ladder are kept as they are.
  assert.deepEqual(normalizeSettings({ allow: ['gpt-6-1-sol', 'gpt-6-1-sol', 3], rules: { general: { mode: 'auto', allow: ['ignored'] } } }).allow, ['gpt-6-1-sol'])
})
test('unrelated valid settings survive and invalid values retain defaults', () => {
  const s = normalizeSettings({ effortAuto: false, judge: 'jev', judgeModel: ' custom ', bias: 2, floor: 'max', ceiling: 'low', agentAuto: 'all', keepWarmHours: 8, handoffSkill: ' /handoff ', hide: ['route', 'bogus', 'timer', 'route', 4], fallback: { agent: 'custom', model: ' opus ' } })
  assert.equal(s.effortAuto, false); assert.equal(s.judgeModel, 'custom'); assert.equal(s.handoffSkill, 'handoff')
  assert.deepEqual(s.hide, ['route', 'timer']); assert.deepEqual(s.fallback, { agent: 'custom', model: 'opus' })
  assert.deepEqual(normalizeSettings({ bias: '2', jevSource: 'bad', rules: [], providers: [], autoTieBand: -1 }), DEFAULTS)
  for (const n of [-1, 101, NaN, Infinity]) assert.equal(normalizeSettings({ swampAt: n }).swampAt, 50)
})
test('allow-lists name workers; provider names from old settings migrate to that provider\'s workers', async () => {
  const { allowedWorkers, migrateAllow, toggleAllow } = await import('../../packages/mod/hooks/settings.ts')
  const workers = [
    { name: 'deepseek-flash', provider: 'deepseek' },
    { name: 'deepseek-v4-1-flash', provider: 'opencode-go' },
    { name: 'glm-5-3-flash', provider: 'opencode-go' },
    { name: 'gpt-6-1-sol', provider: 'chatgpt' },
  ]
  assert.deepEqual(migrateAllow(['opencode-go', 'gpt-6-1-sol', 'gone-worker'], workers), ['deepseek-v4-1-flash', 'glm-5-3-flash', 'gpt-6-1-sol', 'gone-worker'])
  const old = { rules: { general: { mode: 'auto', allow: ['chatgpt'] } } }
  assert.deepEqual(normalizeSettings(old).allow, ['chatgpt'])
  const migrated = normalizeSettings(old, workers)
  assert.deepEqual(migrated.allow, ['gpt-6-1-sol'])
  assert.deepEqual(normalizeSettings(migrated, workers), migrated)
  assert.deepEqual(allowedWorkers([], workers), workers.map(w => w.name))
  assert.deepEqual(allowedWorkers(['opencode-go'], workers), ['deepseek-v4-1-flash', 'glm-5-3-flash'])
  // [] is everything; switching one off lists the rest, all on again is [], the last one stays on.
  assert.deepEqual(toggleAllow([], 'deepseek-flash', workers), ['deepseek-v4-1-flash', 'glm-5-3-flash', 'gpt-6-1-sol'])
  assert.deepEqual(toggleAllow(['deepseek-v4-1-flash', 'glm-5-3-flash', 'gpt-6-1-sol'], 'deepseek-flash', workers), [])
  assert.deepEqual(toggleAllow(['gpt-6-1-sol'], 'gpt-6-1-sol', workers), ['gpt-6-1-sol'])
  assert.deepEqual(toggleAllow(['opencode-go'], 'glm-5-3-flash', workers), ['deepseek-v4-1-flash'])
})

test('Claude models are candidates keyed general-purpose:<model>', () => {
  assert.deepEqual(CLAUDE_WORKERS.map(w => w.name), ['general-purpose:haiku', 'general-purpose:sonnet', 'general-purpose:opus', 'general-purpose:fable'])
  assert.deepEqual(CLAUDE_WORKERS.map(w => w.model), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1'])
  for (const w of CLAUDE_WORKERS) assert.equal(candidateKey(w.target), w.name)
  assert.equal(candidateKey({ agent: 'gpt-6-1-sol' }), 'gpt-6-1-sol')
})

test('a model is ticked by its key or, in old settings, its provider; an empty list ticks every model', () => {
  assert.equal(isAllowed('gpt-6-1-sol', 'chatgpt', []), true)
  assert.equal(isAllowed('gpt-6-1-sol', 'chatgpt', ['gpt-6-1-sol']), true)
  assert.equal(isAllowed('gpt-6-astra', 'chatgpt', ['gpt-6-1-sol']), false)
  assert.equal(isAllowed('gpt-6-astra', 'chatgpt', ['chatgpt']), true)
  assert.equal(isAllowed('general-purpose:opus', 'anthropic', ['general-purpose:opus']), true)
})

test('a worker the allow-list never saw ticks on; one it saw but unticked stays off; pre-known settings read strictly (#56)', () => {
  const old = ['gpt-6-1-sol', 'general-purpose:sonnet'], fresh = 'new-worker'
  // A key the writer never knew is ticked on; a known unticked one stays off.
  assert.equal(isAllowed(fresh, 'chatgpt', old, old), true)
  assert.equal(isAllowed('gpt-6-astra', 'chatgpt', old, [...old, 'gpt-6-astra']), false)
  assert.equal(isAllowed(fresh, 'chatgpt', old), false, 'no known list reads strict')
  const workers = [...ALLOW_WORKERS, { name: fresh, provider: 'chatgpt' }]
  assert.deepEqual(allowedWorkers(old, workers, old), [...ALLOW_WORKERS.map(w => w.name), fresh])
  assert.deepEqual(allowedWorkers(old, workers), ALLOW_WORKERS.map(w => w.name))
  // Legacy settings (an empty know-list) keep today's strict behaviour.
  assert.deepEqual(normalizeSettings({ allow: old }).allowKnown, [])
  assert.deepEqual(normalizeSettings({ allow: old, allowKnown: ['gone'] }).allowKnown, ['gone'])
})

test('stored settings that still held Auto or a field rule say so, once; the design ladder every save stored does not count', () => {
  const retiredDesign = { mode: 'ladder', rungs: {
    light: { target: { agent: 'general-purpose', model: 'sonnet' }, effort: 'medium' }, standard: { target: { agent: 'general-purpose', model: 'sonnet' }, effort: 'high' },
    hard: { target: { agent: 'general-purpose', model: 'opus' }, effort: 'high' }, plan: { target: { agent: 'general-purpose', model: 'opus' }, effort: 'high' },
  } }
  assert.equal(hadRetiredRouting(null), false)
  assert.equal(hadRetiredRouting({ rules: { general: DEFAULTS.rules.general, design: retiredDesign, frontend: { mode: 'inherit' } } }), false)
  assert.equal(hadRetiredRouting({ rules: { general: { mode: 'auto', allow: [] } } }), true)
  assert.equal(hadRetiredRouting({ rules: { backend: { mode: 'auto', allow: [] } } }), true)
  assert.equal(hadRetiredRouting({ rules: { docs: { mode: 'pin', targets: {} } } }), true)
  assert.equal(hadRetiredRouting({ rules: { design: { ...retiredDesign, rungs: { ...retiredDesign.rungs, light: { target: { agent: 'general-purpose', model: 'haiku' }, effort: 'low' } } } } }), true)
  // A saved copy of the new settings holds nothing retired.
  assert.equal(hadRetiredRouting(normalizeSettings({ rules: { general: { mode: 'auto', allow: [] }, backend: { mode: 'auto', allow: [] } } })), false)
})

test('a domain ladder folds into two levels: the upper rung of each pair wins, an empty upper falls back to the lower', () => {
  const light: Step[] = [{ target: { agent: 'light' }, effort: 'low' }]
  const standard: Step[] = [{ target: { agent: 'standard' }, effort: 'medium' }]
  const hard: Step[] = [{ target: { agent: 'hard' }, effort: 'high' }]
  const plan: Step[] = [{ target: { agent: 'plan' }, effort: 'high' }]
  // The upper rung of each pair wins: standard for the light pair, plan for the heavy one.
  assert.deepEqual(twoLevelRungs({ light, standard, hard, plan }), { light: standard, standard, hard: plan, plan })
  // An empty upper rung falls back to the lower one.
  assert.deepEqual(twoLevelRungs({ light, hard }), { light, standard: light, hard, plan: hard })
  // A pair with nothing in it stays empty.
  assert.deepEqual(twoLevelRungs({}), {})
  assert.deepEqual(twoLevelRungs({ light, standard }), { light: standard, standard })
  // The lists are copies, not aliases: editing one pair never touches the other.
  const folded = twoLevelRungs({ light, standard })
  folded.light![0]!.target.agent = 'changed'
  assert.equal(folded.standard![0]!.target.agent, 'standard')
})

test('optional domain ladders normalize independently, round-trip and never count as retired routing', () => {
  const s = normalizeSettings({ domainRules: {
    ui: { mode: 'ladder', rungs: { light: [{ target: { agent: ' ui ' }, effort: 'bad' }, null, { effort: 'high' }], standard: { target: { agent: 'second' }, effort: 'high' } } },
    backend: { mode: 'ladder', rungs: {} }, docs: { mode: 'ladder', rungs: {} },
  } })
  // The domain ladder is folded on the way in: standard's list is the light pair's.
  assert.deepEqual(s.domainRules, {
    ui: { mode: 'ladder', rungs: { light: [{ target: { agent: 'second' }, effort: 'high' }], standard: [{ target: { agent: 'second' }, effort: 'high' }] } },
    backend: { mode: 'ladder', rungs: {} },
  })
  assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(s))), s)
  assert.equal(hadRetiredRouting(s), false)
  for (const raw of [null, [], 'bad', { ui: { mode: 'auto' }, backend: { mode: 'pin' } }, { ui: {}, backend: false }]) {
    assert.equal(Object.hasOwn(normalizeSettings({ domainRules: raw }), 'domainRules'), false)
  }
  const removed = normalizeSettings({ ...s, domainRules: undefined })
  assert.deepEqual(applySettingsChanges(s, settingsChanges(s, removed)), removed)
  const copy = normalizeSettings(s)
  copy.domainRules!.ui!.rungs.light![0]!.target.agent = 'changed'
  assert.equal(s.domainRules!.ui!.rungs.light![0]!.target.agent, 'second')
})

test('normalization folds the domain ladders only: the general ladder keeps its four rungs', () => {
  const s = normalizeSettings({
    rules: { general: { mode: 'ladder', rungs: {
      light: [{ target: { agent: 'l' }, effort: 'low' }], standard: [{ target: { agent: 's' }, effort: 'medium' }],
      hard: [{ target: { agent: 'h' }, effort: 'high' }], plan: [{ target: { agent: 'p' }, effort: 'high' }],
    } } },
    domainRules: { ui: { mode: 'ladder', rungs: { light: [{ target: { agent: 'u' }, effort: 'low' }] } } },
  })
  assert.deepEqual(s.rules.general.rungs, {
    light: [{ target: { agent: 'l' }, effort: 'low' }], standard: [{ target: { agent: 's' }, effort: 'medium' }],
    hard: [{ target: { agent: 'h' }, effort: 'high' }], plan: [{ target: { agent: 'p' }, effort: 'high' }],
  })
  // The domain ladder's light pair holds one list, the empty lower rung takes the upper one's.
  assert.deepEqual(s.domainRules!.ui!.rungs, { light: [{ target: { agent: 'u' }, effort: 'low' }], standard: [{ target: { agent: 'u' }, effort: 'low' }] })
})

test('the heavy-context band and optional chips are off unless switched on', () => {
  assert.equal(DEFAULTS.swampAlert, false)
  assert.deepEqual(DEFAULTS.extras, [])
  assert.equal(normalizeSettings({ swampAt: 50 }).swampAlert, false)
  assert.deepEqual(normalizeSettings({ swampAlert: true, extras: ['context', 'bogus', 'context'] }), { ...DEFAULTS, swampAlert: true, extras: ['context'] })
})
