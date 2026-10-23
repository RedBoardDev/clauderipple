import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, DEFAULT_JUDGE_MODEL, MOD_SETTINGS_SCHEMA_VERSION, applySettingsChanges, judgeTargetKey, normalizeJudgeTargets, normalizeSettings, settingsChanges } from '../../packages/mod/hooks/settings.ts'
import type { JudgeTarget } from '../../packages/mod/types/index.d.ts'

const chain: JudgeTarget[] = [{ kind: 'haiku' }, { kind: 'jev' }, { kind: 'model', model: 'router-first' }, { kind: 'model', model: 'router-second' }]

test('legacy single judges expose their existing Haiku fallback exactly once', () => {
  assert.deepEqual(normalizeSettings({ judge: 'haiku' }).judges, [{ kind: 'haiku' }])
  assert.deepEqual(normalizeSettings({ judge: 'jev', jevSource: 'zen' }).judges, [{ kind: 'jev' }, { kind: 'haiku' }])
  assert.deepEqual(normalizeSettings({ judge: 'model', judgeModel: ' custom ' }).judges, [{ kind: 'model', model: 'custom' }, { kind: 'haiku' }])
  for (const judgeModel of [undefined, '', '  ', false, 7]) {
    assert.deepEqual(normalizeSettings({ judge: 'model', judgeModel }).judges, [{ kind: 'model', model: DEFAULT_JUDGE_MODEL }, { kind: 'haiku' }])
  }
  assert.equal(normalizeSettings({ judge: 'jev', jevSource: 'zen' }).jevSource, 'zen')
  for (const judge of [undefined, null, '', 'unknown', false, {}, []]) assert.deepEqual(normalizeSettings({ judge }).judges, DEFAULTS.judges)
  const migrated = normalizeSettings({ judge: 'model', judgeModel: 'custom' })
  assert.equal(Object.hasOwn(migrated, 'judge'), false)
  assert.equal(Object.hasOwn(migrated, 'judgeModel'), false)
  assert.deepEqual(normalizeSettings(migrated), migrated)
  assert.equal(MOD_SETTINGS_SCHEMA_VERSION, 2)
})

test('an explicit chain owns order and never gains a hidden Haiku or legacy model', () => {
  assert.deepEqual(normalizeSettings({ judges: chain }).judges, chain)
  const explicit: JudgeTarget[] = [{ kind: 'model', model: 'unavailable-now' }, { kind: 'jev' }]
  const settings = normalizeSettings({ judges: explicit, judge: 'model', judgeModel: 'stale-model', jevSource: 'zen' })
  assert.deepEqual(settings.judges, explicit)
  assert.equal(settings.jevSource, 'zen')
  assert.deepEqual(normalizeSettings({ judges: [{ kind: 'jev' }] }).judges, [{ kind: 'jev' }])
  assert.deepEqual(normalizeSettings(JSON.parse(JSON.stringify(settings))), settings)
})

test('targets validate at the boundary and deduplicate by concrete identity, not judge kind', () => {
  const targets = normalizeJudgeTargets([
    null, 'haiku', [], {}, { kind: 'unknown' }, { kind: 'model' }, { kind: 'model', model: '  ' }, { kind: 'model', model: 1 },
    { kind: 'model', model: ' first ', ignored: true }, { kind: 'haiku', model: 'irrelevant' }, { kind: 'jev', source: 'irrelevant' },
    { kind: 'model', model: 'second' }, { kind: 'model', model: 'first' }, { kind: 'haiku' }, { kind: 'jev' },
  ])
  assert.deepEqual(targets, [{ kind: 'model', model: 'first' }, { kind: 'haiku' }, { kind: 'jev' }, { kind: 'model', model: 'second' }])
  assert.equal(new Set(targets.map(judgeTargetKey)).size, targets.length)
  assert.notEqual(judgeTargetKey({ kind: 'haiku' }), judgeTargetKey({ kind: 'model', model: 'haiku' }))
  assert.deepEqual(normalizeJudgeTargets(targets), targets)
})

test('invalid explicit stored data has a defensive read default, never resurrects old selections', () => {
  for (const judges of [undefined, null, false, 'jev', {}, [], [null, { kind: 'model', model: '' }]]) {
    assert.deepEqual(normalizeJudgeTargets(judges), [])
    assert.deepEqual(normalizeSettings({ judges, judge: 'jev', judgeModel: 'old' }).judges, DEFAULTS.judges)
  }
})

test('normalized chains own their array and every target, including defaults and legacy migration', () => {
  const raw = { judges: chain.map(target => ({ ...target })) }
  const first = normalizeSettings(raw)
  first.judges.reverse()
  const target = first.judges[0]
  assert.equal(target?.kind, 'model')
  if (target?.kind === 'model') target.model = 'changed'
  assert.deepEqual(raw.judges, chain)
  assert.deepEqual(normalizeSettings(raw).judges, chain)
  const defaults = normalizeSettings(null)
  defaults.judges[0]!.kind = 'jev'
  defaults.judges.push({ kind: 'model', model: 'extra' })
  assert.deepEqual(normalizeSettings(null), DEFAULTS)
  const legacy = normalizeSettings({ judge: 'jev' })
  legacy.judges.pop()
  assert.deepEqual(normalizeSettings({ judge: 'jev' }).judges, [{ kind: 'jev' }, { kind: 'haiku' }])
})

test('a reordered judge chain rebases atomically without erasing unrelated remote settings', () => {
  const before = normalizeSettings({ judges: chain, language: 'en' })
  const reordered = [chain[2]!, chain[0]!, chain[1]!, chain[3]!]
  const after = normalizeSettings({ ...before, judges: reordered })
  const changes = settingsChanges(before, after)
  assert.deepEqual(changes, [{ path: ['judges'], value: reordered }])
  const remote = normalizeSettings({ ...before, judges: [{ kind: 'model', model: 'remote' }], language: 'ja', providers: { anthropic: false }, jevSource: 'zen' })
  const merged = applySettingsChanges(remote, changes)
  assert.deepEqual(merged.judges, reordered)
  assert.equal(merged.language, 'ja')
  assert.equal(merged.jevSource, 'zen')
  assert.deepEqual(merged.providers, { anthropic: false })
  assert.deepEqual(remote.judges, [{ kind: 'model', model: 'remote' }])
  merged.judges.pop()
  assert.deepEqual(after.judges, reordered)
  assert.deepEqual(before.judges, chain)
})

test('an unchanged migrated chain does not overwrite a concurrently edited remote chain', () => {
  const before = normalizeSettings({ judge: 'jev', language: 'en' })
  const after = normalizeSettings({ ...before, language: 'ko' })
  const remote = normalizeSettings({ judges: [{ kind: 'model', model: 'remote' }], language: 'en' })
  assert.deepEqual(applySettingsChanges(remote, settingsChanges(before, after)).judges, remote.judges)
  assert.deepEqual(settingsChanges(before, normalizeSettings(before)), [])
})
