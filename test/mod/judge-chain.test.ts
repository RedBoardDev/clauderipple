import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judgeOutcome } from '../../packages/mod/hooks/stats.ts'

const haiku = { kind: 'haiku' } as const
const jev = { kind: 'jev' } as const
const a = { kind: 'model', model: 'router-a' } as const
const b = { kind: 'model', model: 'router-b' } as const

test('a rescued run is asked by the first configured kind, answered by the last tried, and keeps the first error', () => {
  assert.deepEqual(judgeOutcome([jev, haiku], [{ target: jev, ms: 5, error: 'Jev key missing' }, { target: haiku, ms: 7 }]), { asked: 'jev', by: 'haiku', error: 'Jev key missing' })
})

test('an exhausted chain reports the last tried kind and the first failure', () => {
  assert.deepEqual(judgeOutcome([a, b], [{ target: a, ms: 1, error: 'one' }, { target: b, ms: 2, error: 'two' }]), { asked: 'model', by: 'model', error: 'one' })
})

test('a first answer has no error, and an empty attempt list falls back to the configured or Haiku', () => {
  assert.deepEqual(judgeOutcome([a, haiku], [{ target: a, ms: 3 }]), { asked: 'model', by: 'model' })
  assert.deepEqual(judgeOutcome([], []), { asked: 'haiku', by: 'haiku' })
})
