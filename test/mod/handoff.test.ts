import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QUICK_PROMPT, wrapForNewChat } from '../../packages/mod/hooks/handoff.ts'

test('the handoff prompt asks for a no-tools resume note that keeps verified state and no secrets', () => {
  assert.ok(QUICK_PROMPT.includes('do not run tools') && QUICK_PROMPT.includes('forty lines'))
  assert.ok(QUICK_PROMPT.includes('verified') && QUICK_PROMPT.includes('permissions') && QUICK_PROMPT.includes('secrets'))
})

test('the note is wrapped to go on with the next action, waiting where permission or input is needed', () => {
  const text = wrapForNewChat('  state  ')
  assert.ok(text.startsWith('Resume context from the previous chat:\n\nstate\n\n'))
  assert.ok(text.includes('Continue with the justified next action'))
  assert.ok(text.includes('permission') && text.includes('wait'))
  assert.ok(!text.includes('HANDOFF.md') && !text.includes('confirmation'))
})
