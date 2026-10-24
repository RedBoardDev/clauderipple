// Base's delegation (docs/specs/2026-10-12-worker-tiers.md "Screens"): while no mode is on, the
// eager note is Base's; a mode that is on uses its own delegation instead.
import { expect, test } from 'claude-code/testing'
import { DEFAULTS, normalizeSettings } from '../hooks/settings'
import { eagerNote, modeNote } from '../hooks/modes'
import type { Mode, Settings } from '../types'

const BASE_NOTE = 'ClaudeRipple: delegate everything except judgment and final review to ripple:auto.'

function settings(patch: Partial<Settings> = {}): Settings {
  return { ...normalizeSettings(null), ...patch }
}

const MODES: Mode[] = [
  { id: 'calm', name: 'Calm', rungs: {}, delegation: 'normal', until: 'none' },
  { id: 'burn', name: 'Burn', rungs: {}, delegation: 'eager', until: 'none' },
]

test('Base eager notes the main chat on the first prompt and on the ones after it', () => {
  const s = settings({ delegation: 'eager' })
  expect(eagerNote(s, null)).toEqual({ note: BASE_NOTE, noted: 'base' })
  // Every prompt carries it: one sent only once is buried in a long context.
  expect(eagerNote(s, 'base')).toEqual({ note: BASE_NOTE, noted: 'base' })
})

test('Base normal says nothing', () => {
  const s = settings({ delegation: 'normal' })
  expect(eagerNote(s, null)).toEqual({ noted: null })
  expect(eagerNote(s, 'base')).toEqual({ noted: null })
})

test('consecutive prompts both carry the note while eager', () => {
  const s = settings({ delegation: 'eager', modes: MODES, activeMode: 'burn', activeSince: 5 })
  // Simulate register.tsx: what the last prompt noted is handed to the next one.
  const first = eagerNote(s, null)
  const second = eagerNote(s, first.noted)
  expect(first).toEqual({ note: modeNote('Burn'), noted: 'burn@5' })
  expect(second).toEqual({ note: modeNote('Burn'), noted: 'burn@5' })
})

test("a mode's delegation wins over Base, either way", () => {
  // A normal mode on an eager Base: no note, and the earlier Base note is cleared.
  const calmOnEagerBase = normalizeSettings({ delegation: 'eager', modes: MODES, activeMode: 'calm', activeSince: 5 })
  expect(eagerNote(calmOnEagerBase, 'base')).toEqual({ noted: null })
  // An eager mode on a normal Base: the mode's note on every prompt.
  const burnOnNormalBase = normalizeSettings({ delegation: 'normal', modes: MODES, activeMode: 'burn', activeSince: 5 })
  const first = eagerNote(burnOnNormalBase, null)
  expect(first).toEqual({ note: modeNote('Burn'), noted: 'burn@5' })
  expect(eagerNote(burnOnNormalBase, first.noted)).toEqual({ note: modeNote('Burn'), noted: 'burn@5' })
})

test('normalizeSettings keeps a stored delegation and defaults anything else to normal', () => {
  expect(DEFAULTS.delegation).toBe('normal')
  expect(normalizeSettings(null).delegation).toBe('normal')
  expect(normalizeSettings({ delegation: 'loud' }).delegation).toBe('normal')
  expect(normalizeSettings({ delegation: 'eager' }).delegation).toBe('eager')
  expect(normalizeSettings(normalizeSettings({ delegation: 'eager' })).delegation).toBe('eager')
})
