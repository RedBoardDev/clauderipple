// End-to-end fallback through the real mod engine; only host/API boundaries are stubbed.
import { expect, mock, test } from 'claude-code/testing'
import { normalizeSettings } from '../hooks/settings'

for (const [name, compactWindow, rawMaxTokens, expected] of [
  ['native Claude uses 600k instead of its 1M capacity', 600000, null, 600000],
  ['routed GPT uses 475k despite a global 600k', 475000, null, 475000],
  ['the running CLI breakdown outranks router settings', 475000, 400000, 400000],
] as const) {
  test(name, async ($, on) => {
    const clock = mock.clock(on, { now: 1000000 })
    mock.env(on, { HOME: '/isolated-test', LANG: 'en_US.UTF-8' })
    const settings = normalizeSettings({ setupDone: true, effortAuto: false, agentAuto: 'off', keepWarm: false, language: 'en' })
    on('http.fetch', ($, e) => {
      const body = e.url.endsWith('/api/context-windows') ? { resolvedWindows: { 'claude-opus-4-7': { compactWindow } } }
        : e.url.endsWith('/api/mod-settings') ? { settings, stored: true, revision: 1, compactAt: 600000 } : { requests: [] }
      return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify(body) } }
    })
    on('fs.read', () => ({ value: '{}' }))
    on('fs.exists', () => ({ value: false }))
    on('store.get', () => ({ value: undefined }))
    on('settings.read', () => ({ value: { language: 'en' } }))
    on('session.start', () => ({ cwd: '/isolated-test' }))
    on('session.model', () => ({ value: 'claude-opus-4-7' }))
    on('session.id', () => ({ value: 'isolated-session' }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('ui.status', () => ({ value: undefined }))
    on('ui.log', () => ({ value: undefined }))
    on('ui.panes', () => ({ value: [] }))
    on('session.usage', ($, e) => ({ value: {
      startedAt: 1000000, rateLimits: [], context: { window: 1000000, tokens: 300000,
        ...(e.breakdown && rawMaxTokens ? { breakdown: {
          categories: [], totalTokens: 300000, maxTokens: rawMaxTokens, rawMaxTokens,
          autocompactSource: 'clientdata' as const, percentage: 75, gridRows: [], model: 'claude-opus-4-7',
          memoryFiles: [], mcpTools: [], agents: [], isAutoCompactEnabled: true, apiUsage: null,
        } } : {}),
      },
    } }))
    let context: unknown
    on('state.set', { plugin: 'ripple', key: 'context' }, async ($, e, next) => { context = e.value; return next(e) })
    await $.session.start({ cwd: '/isolated-test', surface: 'terminal', isInteractive: true })
    await clock.advance(15000)
    expect(context).toEqual({ window: expected, tokens: 300000, basis: 300000, percent: rawMaxTokens ? 75 : 300000 / expected * 100 })
  })
}
