// Integration through the actual mods engine. Only external host boundaries are stubbed.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentSpawnInput, ModelApiError, ModelCompleteRequest, ModelUsage, On, SessionMessage, ToolCallInput, TurnStepInput } from 'claude-code'
import { MOD_SETTINGS_SCHEMA_VERSION, DEFAULTS, normalizeModes, normalizeSettings } from '../hooks/settings'
import type { Lang } from '../hooks/i18n'
import type { AgentRec, JudgeRun, ModSettingsSnapshot, Settings } from '../types'
import type { JevState } from '../hooks/ui/view'

const NOW = 1000000
const USAGE: ModelUsage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0 }
const FILES: Record<string, string> = {
  'deepseek-v4-1-flash': '---\nname: deepseek-v4-1-flash\ndescription: Executor via deepseek.\nmodel: deepseek-v4.1-flash@medium\n---\nExecute.',
  'gpt-6-1-sol': '---\nname: gpt-6-1-sol\ndescription: Executor via chatgpt.\nmodel: gpt-6.1-sol@medium\n---\nExecute.',
  'gpt-6-astra': '---\nname: gpt-6-astra\ndescription: Executor via chatgpt.\nmodel: gpt-6-astra@high\n---\nExecute.',
}
const AA = { models: [
  { model: 'gpt-6.1-sol', provider: 'chatgpt', variants: [{ effort: 'high', intelligence: 50.24, costPerTask: 0.3191 }] },
  { model: 'gpt-6-astra', provider: 'chatgpt', variants: [{ effort: 'medium', intelligence: 49.6, costPerTask: 1.541 }] },
  { model: 'claude-sonnet-5-5', provider: 'anthropic', variants: [{ effort: 'high', intelligence: 46.8, costPerTask: 0.884 }] },
  { model: 'deepseek-v4.1-flash', provider: 'deepseek', variants: [{ effort: 'max', intelligence: 39.46, costPerTask: 0.2652 }] },
] }
// GET /api/mod-options as a router of 2026-10-11 answers it: workers with ladders and billing.
const MOD_OPTIONS = {
  agents: [
    { name: 'deepseek-v4-1-flash', model: 'deepseek-v4.1-flash', provider: 'deepseek', efforts: ['low', 'high', 'max'], billing: 'payg' },
    { name: 'gpt-6-1-sol', model: 'gpt-6.1-sol', provider: 'chatgpt', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], billing: 'subscription' },
    { name: 'gpt-6-astra', model: 'gpt-6-astra', provider: 'chatgpt', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], billing: 'subscription' },
  ],
  providers: [{ name: 'deepseek', type: 'anthropic-compatible', usable: true, billing: 'payg' }, { name: 'chatgpt', type: 'chatgpt', usable: true, billing: 'subscription' }],
  claudeEfforts: ['low', 'medium', 'high', 'max'],
  scores: AA,
}
const CONFIG = { admin: { port: 9992 }, providers: { deepseek: { models: [{ id: 'deepseek-v4.1-flash' }] }, chatgpt: { models: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-astra' }] }, anthropic: { models: [{ id: 'claude-sonnet-5-5' }] } } }
const SPAWN: AgentSpawnInput = { tool_use_id: 'tool1', subagentType: 'ripple:auto', prompt: 'Rename one local variable and verify it.', description: 'Rename variable', parentModel: 'claude-opus-5-5', provider: { plugin: 'engine', tier: 'core' }, background: false, fork: false }
const MESSAGES: SessionMessage[] = [{ role: 'user', text: 'Implement the specified change and verify it.', toolUses: [] }, { role: 'assistant', text: 'The implementation is ready.', toolUses: [] }]
// The user naming the workers a test spawns by name (worker.ts userNamed).
const NAMED: SessionMessage[] = [{ role: 'user', text: 'Use Sol, Astra or DeepSeek for this.', toolUses: [] }]

function boundaries(on: On, patch: Partial<Settings> = {}, options: { config?: unknown; paths?: string[]; key?: string; envFile?: string | (() => string); language?: unknown; env?: Record<string, string>; platform?: string; browserFailure?: 'exit' | 'throw'; appleLocale?: string; appleFail?: boolean; limits?: { kind: string; percentUsed: number; resetsAt?: string }[]; agentMessages?: (agentId: string) => SessionMessage[]; messages?: SessionMessage[] } = {}) {
  const clock = mock.clock(on, { now: NOW })
  const saved = new Map<string, unknown>()
  const storeWrites: string[] = []
  const storeReads: string[] = []
  let router: ModSettingsSnapshot = { settings: normalizeSettings({ setupDone: true, ...patch }), revision: 1, stored: true }
  let offline = false
  let conflict: Settings | null = null
  let alwaysConflict = false
  const settingsRequests: { method: string; settings?: unknown; revision?: unknown; schemaVersion?: unknown }[] = []
  on('http.fetch', { url: /\/api\/mod-settings$/ }, ($, e) => {
    if (offline) throw new Error('router unavailable')
    const method = e.init?.method ?? 'GET'
    if (method === 'GET') {
      settingsRequests.push({ method })
      return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify(router) } }
    }
    const input = JSON.parse(e.init?.body ?? '{}')
    settingsRequests.push({ method, settings: input.settings, revision: input.revision, schemaVersion: input.schemaVersion })
    if (conflict) { router = { settings: conflict, revision: router.revision + 1, stored: true }; conflict = null }
    if (alwaysConflict) router = { ...router, revision: router.revision + 1 }
    const stale = input.revision !== router.revision
    if (!stale) router = { settings: normalizeSettings(input.settings), revision: router.revision + 1, stored: true }
    return { value: { ok: !stale, status: stale ? 409 : 200, headers: {}, text: JSON.stringify(router) } }
  })
  const toasts: string[] = []
  const logs: string[] = []
  const submitted: string[] = []
  const filled: string[] = []
  const panes = new Set<string>()
  let model = 'claude-opus-5-5'
  let percent = 20
  on('store.get', ($, e) => { storeReads.push(e.key); return { value: saved.get(e.key) } })
  on('store.set', ($, e) => { storeWrites.push(e.key); saved.set(e.key, e.value); return { value: undefined } })
  mock.env(on, { HOME: '/home/test', LANG: 'en_US.UTF-8', ...(options.key ? { TYPESAFE_API_KEY: options.key } : {}), ...options.env })
  let hostLanguage = options.language
  const processes: { argv: readonly string[]; timeoutMs?: number }[] = []
  on('settings.read', () => ({ value: { language: hostLanguage } }))
  let resolvedLanguage: unknown
  on('state.set', { plugin: 'ripple', key: 'lang' }, async ($, e, next) => {
    const result = await next(e)
    if ('value' in result && result.value?.isSet) resolvedLanguage = e.value
    return result
  })
  on('session.cwd', () => ({ value: '/work' }))
  on('process.run', ($, e) => {
    processes.push({ argv: e.argv, timeoutMs: e.init?.timeoutMs })
    if (['open', 'xdg-open', 'cmd'].includes(e.argv[0] ?? '') && options.browserFailure) {
      if (options.browserFailure === 'throw') throw new Error('browser unavailable')
      return { value: { exitCode: 1, stdout: '', stderr: 'browser unavailable', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === 'uname') return { value: { exitCode: 0, stdout: options.platform ?? 'Linux', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv[0] === 'defaults' && options.appleFail) return { value: { exitCode: 1, stdout: '', stderr: 'locale timed out', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 0, stdout: options.appleLocale ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const files = new Map<string, string>()
  let logFailure: 'read' | 'write' | null = null
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || e.path.endsWith('config.json') || e.path.endsWith('/.config/jev/.env') && options.envFile !== undefined }))
  on('fs.write', ($, e) => {
    if (e.path.endsWith('/worker-picks.jsonl') && logFailure === 'write') return { deny: 'worker log write denied' }
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    options.paths?.push(e.path)
    if (e.path.endsWith('/worker-picks.jsonl') && logFailure === 'read') return { deny: 'worker log read denied' }
    if (files.has(e.path)) return { value: files.get(e.path)! }
    if (e.path.endsWith('generated-agents.json')) return { value: JSON.stringify({ agents: [...Object.keys(FILES), 'claude-sonnet-5-5'] }) }
    if (e.path.endsWith('/claude-sonnet-5-5.md')) return { value: '---\nname: claude-sonnet-5-5\ndescription: Execute via anthropic.\nmodel: claude-sonnet-5-5@high\n---\nExecute.' }
    if (e.path.endsWith('config.json')) return { value: JSON.stringify(options.config ?? CONFIG) }
    if (e.path.endsWith('/.config/jev/.env')) return { value: typeof options.envFile === 'function' ? options.envFile() : options.envFile ?? '' }
    const name = e.path.split('/').pop()?.replace(/\.md$/, '') ?? ''
    return { value: FILES[name] ?? '' }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('classic.SessionStart', () => ({}))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  const registered: { name: string; prompt: string; disallowedTools?: readonly string[]; description: string }[] = []
  on('agent.register', ($, e) => { registered.push(e); return { value: { agent: 'ripple:' + e.name } } })
  on('command.list', () => ({ value: [{ name: 'clear', description: 'Clear', source: 'builtin' }, { name: 'compact', description: 'Compact', source: 'builtin' }, { name: 'model', description: 'Model', source: 'builtin' }] }))
  on('session.id', () => ({ value: 'session-test' }))
  on('session.model', () => ({ value: model }))
  on('session.messages', ($, e) => ({ value: e.agentId && options.agentMessages ? options.agentMessages(e.agentId) : options.messages ?? MESSAGES }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { percent, tokens: 40000, window: 200000 }, rateLimits: options.limits ?? [] } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('ui.panes', () => ({ value: [...panes].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.open', ($, e) => { panes.add(e.id); return { value: { isPlaced: true } } })
  on('ui.close', ($, e) => { panes.delete(e.id); return { value: undefined } })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['host drawing'] }))
  // What the model reads beside each prompt, as the hooks attached it.
  const contexts: (readonly string[])[] = []
  on('prompt.submit', ($, e) => { submitted.push(e.text); contexts.push(e.context ?? []); return { text: e.text } })
  on('turn.complete', () => ({ text: '' }))
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', ($, e) => { filled.push(e.text); return { isFilled: true } })
  return { files, failWorkerLog: (value: 'read' | 'write' | null) => { logFailure = value }, registered, clock, saved, storeWrites, storeReads, settingsRequests, router: () => router, remote: (value: ModSettingsSnapshot) => { router = value }, offline: (value: boolean) => { offline = value }, conflict: (value: Settings) => { conflict = value }, alwaysConflict: (value: boolean) => { alwaysConflict = value }, toasts, logs, panes, submitted, contexts, filled, processes, language: () => resolvedLanguage, setLanguage: (value: unknown) => { hostLanguage = value }, setModel: (id: string) => { model = id }, setPercent: (value: number) => { percent = value } }
}
function http(on: On, exhausted = false, config: unknown = CONFIG, zen?: (input: { url: string; init?: { body?: string; headers?: Readonly<Record<string, string>> } }) => void, jev?: 'ok' | 'http500' | 'badjson' | 'network') {
  const urls: string[] = []
  on('http.fetch', ($, e, next) => {
    if (e.url.endsWith('/api/mod-settings')) return next(e)
    urls.push(e.url)
    if (e.url === 'https://api.typesafe.ai/v1/systemone' && jev) {
      if (jev === 'network') throw new Error('ECONNRESET')
      if (jev === 'http500') return { value: { ok: false, status: 500, headers: {}, text: '' } }
      if (jev === 'badjson') return { value: { ok: true, status: 200, headers: {}, text: 'not json' } }
      return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ answers: { effort: { choice: 'high', confidence: 0.95 } } }) } }
    }
    if (e.url === 'https://opencode.ai/zen/v1/systemone' && zen) {
      zen(e)
      return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ model: 'jev-1.13', answers: { effort: { choice: 'high', confidence: 0.95 } }, usage: { input_tokens: 50, output_tokens: 10 } }) } }
    }
    const body = e.url.endsWith('/api/status') ? { chatgpt: { accounts: { chatgpt: [{ state: 'ready', quota: { rate_limits: { primary: { used_percent: exhausted ? 100 : 20 } } } }] } } } : e.url.endsWith('/api/config') ? config : e.url.endsWith('/api/mod-options') ? { ...MOD_OPTIONS, providers: MOD_OPTIONS.providers.map(p => p.name === 'chatgpt' ? { ...p, usable: !exhausted } : p) } : { requests: [] }
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify(body) } }
  })
  return urls
}
function judgeStub(on: On, text = '{"domain":"general","level":"light","effort":"low","sure":0.9,"why":"small rename"}') {
  const calls: ModelCompleteRequest[] = []
  on('model.complete', ($, e) => { calls.push(e); return { value: { isAnswered: true, text, usage: USAGE } } })
  return calls
}
function spawnStub(on: On) {
  const sent: AgentSpawnInput[] = []
  on('agent.spawn', ($, e) => { sent.push(e); return { model: e.model ?? 'sonnet', agentId: 'worker-1' } })
  return sent
}
function stepStub(on: On, usage: ModelUsage | null = USAGE) {
  const sent: TurnStepInput[] = []
  on('turn.step', async function* ($, e) {
    sent.push(e)
    yield { kind: 'text', index: 0, text: 'ok' }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: usage ? { ...usage, model: e.model } : null }
  })
  return sent
}
async function command($: Engine, args: string) {
  return $.command.run({ command: 'ripple', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 } })
}
async function start($: Engine) { await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true }) }
async function step($: Engine, model = 'claude-opus-5-5', effort: TurnStepInput['effort'] = 'medium', agentId?: string) {
  const stream = $.turn.step({ turnId: 'turn-1', index: 0, messageCount: 2, model, effort, ...(agentId ? { agentId } : {}) })
  let result = await stream.next()
  while (result.done !== true) result = await stream.next()
  return result.value
}
async function submit($: Engine, text = 'Implement the bounded change and verify the tests.', turnId?: string) {
  return $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false, ...(turnId ? { turnId } : {}) })
}
async function complete($: Engine, agentId?: string, answer = 'Finished.') {
  await $.turn.complete({ turnId: 'turn-1', answer, reason: 'answer', durationMs: 1000, isAborted: false, ...(agentId ? { agentId } : {}) })
}
async function band($: Engine, surface: 'terminal' | 'desktop' = 'terminal', hasSurvey = false) {
  return $.ui.mount({ plugin: 'ripple', component: 'AbovePrompt', requestId: 'band', surface,
    viewport: { columns: 140, rows: 40 }, props: { hasSurvey, isWorking: false, bodyColumns: 130, maxRows: 20, scroll: { offset: 0, bodyRows: 20 }, view: {} } })
}

test('router settings override legacy store and revision changes redraw even with the band hidden', async ($, on) => {
  const b = boundaries(on, { language: 'pt' })
  b.saved.set('settings', normalizeSettings({ language: 'ko' }))
  http(on)
  await start($)
  expectLanguage(b, 'pt')
  expect(b.storeReads).not.toContain('settings')
  await command($, 'bar')
  b.remote({ settings: normalizeSettings({ setupDone: true, language: 'ja', effortAuto: false }), revision: 2, stored: true })
  await b.clock.advance(3000)
  expectLanguage(b, 'ja')
  await command($, 'bar')
  const ui = await band($)
  expect((await ui.find({ key: 'auto' }))?.props.label).toContain('○')
  b.remote({ settings: normalizeSettings({ setupDone: true, language: 'ko' }), revision: 2, stored: true })
  await b.clock.advance(3000)
  expectLanguage(b, 'ja') // An unchanged revision does not replace the atom.
  expect(b.settingsRequests.filter(r => r.method === 'PUT').length).toBe(0)
  await ui.unmount()
})

test('an unrelated user change uses the fresh router ladder and saved modes, not a local whole snapshot', async ($, on) => {
  const b = boundaries(on)
  http(on)
  await start($)
  await command($, 'settings')
  const ui = await band($)
  const steps = [{ target: { agent: 'gpt-6-astra' }, effort: 'high' as const }, { target: { agent: 'gpt-6-1-sol' }, effort: 'medium' as const }]
  const fresh = normalizeSettings({ setupDone: true, rules: { general: { mode: 'ladder', rungs: { hard: steps } } }, modes: [{ id: 'saved', name: 'Saved', rungs: { plan: steps }, until: 'none' }], activeMode: 'saved' })
  b.remote({ settings: fresh, revision: 2, stored: true })
  await ui.press({ key: 'bias-1' }) // No poll has installed the newer router snapshot yet.
  expect(b.router().settings.rules).toEqual(fresh.rules)
  expect(b.router().settings.modes).toEqual(fresh.modes)
  expect(b.router().settings.activeMode).toBe('saved')
  const writes = b.settingsRequests.filter(r => r.method === 'PUT')
  expect(writes.length).toBe(1)
  expect(writes[0]?.revision).toBe(2)
  expect(writes[0]?.schemaVersion).toBe(MOD_SETTINGS_SCHEMA_VERSION)
  await ui.unmount()
})

test('reload discards old-format pending overwrites and migration even at the same stored revision', async ($, on) => {
  const b = boundaries(on)
  http(on)
  const original = b.router().settings
  let oldState = true
  let installed: unknown
  on('state.get', { plugin: 'ripple', key: 'settingsSync' }, ($, e, next) => oldState ? { value: { value: { revision: 1, pending: [{ path: ['rules'], value: {} }, { path: ['modes'], value: [] }], migrationChecked: true, migration: normalizeSettings(null) }, version: 0 } } : next(e))
  on('state.set', { plugin: 'ripple', key: 'settingsSync' }, async ($, e, next) => {
    const result = await next(e)
    oldState = false
    installed = e.value
    return result
  })
  await start($)
  expect(b.settingsRequests.filter(r => r.method === 'PUT').length).toBe(0)
  expect(b.router().settings).toEqual(original)
  expect(installed).toMatchObject({ schemaVersion: MOD_SETTINGS_SCHEMA_VERSION, pending: [], migration: null })
})

test('saving the already-selected setting sends no normalization-only PUT', async ($, on) => {
  const b = boundaries(on)
  http(on)
  await start($)
  await command($, 'settings')
  const ui = await band($)
  await ui.press({ key: 'bias-0' })
  expect(b.settingsRequests.filter(r => r.method === 'PUT').length).toBe(0)
  expect(b.router().revision).toBe(1)
  await ui.unmount()
})

test('empty router uses defaults without writing when there is no legacy store', async ($, on) => {
  const b = boundaries(on)
  b.remote({ settings: normalizeSettings(null), revision: 0, stored: false })
  http(on)
  await start($)
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: 'Welcome to ClaudeRipple' })).toBeDefined()
  expect(b.settingsRequests.filter(r => r.method === 'PUT').length).toBe(0)
  await ui.unmount()
})

// 2026-10-20: a stray test router took the live router's launchd label for five minutes and answered
// with nothing stored; every chat took its defaults, opened setup and asked for the Jev key again,
// and kept asking after the real router came back.
test('a router that lost its settings gets this chat\'s back instead of opening setup', async ($, on) => {
  const b = boundaries(on)
  b.remote({ settings: normalizeSettings({ setupDone: true, language: 'pt', keepWarm: true }), revision: 7, stored: true })
  http(on)
  await start($)
  expectLanguage(b, 'pt')
  b.remote({ settings: normalizeSettings(null), revision: 0, stored: false })
  await b.clock.advance(3000)
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: 'Welcome to ClaudeRipple' })).toBeUndefined()
  expectLanguage(b, 'pt')
  expect(b.router()).toMatchObject({ stored: true, settings: { setupDone: true, language: 'pt', keepWarm: true } })
  await ui.unmount()
})

test('a setup card left open closes once the router says setup is done', async ($, on) => {
  const b = boundaries(on)
  b.remote({ settings: normalizeSettings(null), revision: 0, stored: false })
  http(on)
  await start($)
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: 'Welcome to ClaudeRipple' })).toBeDefined()
  b.remote({ settings: normalizeSettings({ setupDone: true }), revision: 3, stored: true })
  await b.clock.advance(3000)
  expect(await ui.find({ type: 'Text', text: 'Welcome to ClaudeRipple' })).toBeUndefined()
  await ui.unmount()
})

test('legacy settings and setup completion migrate once; unrelated store keys survive', async ($, on) => {
  const b = boundaries(on)
  b.remote({ settings: normalizeSettings(null), revision: 0, stored: false })
  b.saved.set('settings', { language: 'pt', keepWarm: true, tiers: { light: { agent: 'old-worker' } } })
  b.saved.set('setupDone', true)
  b.saved.set('handoffChoice', { kind: 'full', after: 'copy' })
  http(on)
  await start($)
  expect(b.router().settings).toMatchObject({ language: 'pt', keepWarm: true, setupDone: true, rules: { general: { mode: 'ladder', rungs: { light: [{ target: { agent: 'old-worker' } }] } } } })
  expect(b.settingsRequests.filter(r => r.method === 'PUT').length).toBe(1)
  expect(b.settingsRequests.find(r => r.method === 'PUT')?.revision).toBe(0)
  b.saved.set('settings', { language: 'ko' })
  await b.clock.advance(3000)
  await $.classic.SessionStart({ source: 'clear' })
  expectLanguage(b, 'pt')
  expect(b.storeReads.filter(key => key === 'settings').length).toBe(1)
  expect(b.storeWrites).not.toContain('settings')
  expect(b.saved.get('handoffChoice')).toEqual({ kind: 'full', after: 'copy' })
})

test('a quick change retries a stale revision once and preserves remote sibling fields', async ($, on) => {
  const b = boundaries(on)
  http(on)
  await start($)
  await command($, 'settings')
  const ui = await band($)
  b.conflict(normalizeSettings({ setupDone: true, ceiling: 'high', language: 'pt', allow: ['remote'] }))
  await ui.press({ key: 'bias-1' })
  const writes = b.settingsRequests.filter(r => r.method === 'PUT')
  expect(writes.map(r => r.revision)).toEqual([1, 2])
  expect(b.router().settings).toMatchObject({ bias: 1, ceiling: 'high', language: 'pt', allow: ['remote'] })
  expectLanguage(b, 'pt')
  expect(b.storeWrites).not.toContain('settings')
  await ui.unmount()
})

test('two conflicts stop the save retry and retain the edit for the next poll', async ($, on) => {
  const b = boundaries(on)
  http(on)
  await start($)
  await command($, 'settings')
  const ui = await band($)
  b.alwaysConflict(true)
  await ui.press({ key: 'bias-1' })
  expect(b.settingsRequests.filter(r => r.method === 'PUT').length).toBe(2)
  expect(b.router().settings.bias).toBe(0)
  // Opening the panel syncs first, which tries the kept edit again (two more conflicts).
  await command($, 'settings')
  expect((await ui.find({ key: 'bias-1' }))?.props.label).toBe('● +1')
  expect(b.settingsRequests.filter(r => r.method === 'PUT').length).toBe(4)
  b.alwaysConflict(false)
  await b.clock.advance(3000)
  expect(b.router().settings.bias).toBe(1)
  expect(b.settingsRequests.filter(r => r.method === 'PUT').length).toBe(5)
  await ui.unmount()
})

test('migration loses a first-write race without overwriting existing server settings', async ($, on) => {
  const b = boundaries(on)
  b.remote({ settings: normalizeSettings(null), revision: 0, stored: false })
  b.saved.set('settings', { language: 'pt' })
  b.conflict(normalizeSettings({ setupDone: true, language: 'ja', keepWarm: true }))
  http(on)
  await start($)
  expectLanguage(b, 'ja')
  expect(b.settingsRequests.filter(r => r.method === 'PUT').length).toBe(1)
  expect(b.router().settings).toMatchObject({ language: 'ja', keepWarm: true })
  await b.clock.advance(3000)
  expect(b.storeReads.filter(key => key === 'settings').length).toBe(1)
})

test('offline startup recovers and migrates legacy settings only after reaching an empty router', async ($, on) => {
  const b = boundaries(on)
  b.remote({ settings: normalizeSettings(null), revision: 0, stored: false })
  b.saved.set('settings', { language: 'pt', setupDone: true })
  b.offline(true)
  http(on)
  await start($)
  expect(b.storeReads).not.toContain('settings')
  b.offline(false)
  await b.clock.advance(3000)
  expectLanguage(b, 'pt')
  expect(b.router().stored).toBe(true)
  expect(b.settingsRequests.filter(r => r.method === 'PUT').length).toBe(1)
})

test('an open quick panel follows newer settings and saves only the next change', async ($, on) => {
  const b = boundaries(on)
  http(on)
  await start($)
  await command($, 'settings')
  const ui = await band($)
  b.remote({ settings: normalizeSettings({ setupDone: true, bias: -1, ceiling: 'high', keepWarmHours: 8 }), revision: 2, stored: true })
  await b.clock.advance(3000)
  expect((await ui.find({ key: 'bias--1' }))?.props.label).toBe('● −1')
  await ui.press({ key: 'bias-1' })
  expect(b.router().settings).toMatchObject({ bias: 1, ceiling: 'high', keepWarmHours: 8 })
  expect(b.settingsRequests.filter(r => r.method === 'PUT').map(r => r.revision)).toEqual([2])
  await ui.unmount()
})

test('offline quick changes stay local, show router notice and retry on next poll', async ($, on) => {
  const b = boundaries(on)
  http(on)
  await start($)
  await command($, 'settings')
  const ui = await band($)
  b.offline(true)
  await ui.press({ key: 'bias-1' })
  expect(b.router().settings.bias).toBe(0)
  await command($, 'settings')
  expect((await ui.find({ key: 'bias-1' }))?.props.label).toBe('● +1')
  expect(b.toasts.some(text => text.includes('router not answering'))).toBe(true)
  expect(b.toasts).not.toContain('Settings saved')
  expect(b.storeWrites).not.toContain('settings')
  b.remote({ settings: normalizeSettings({ setupDone: true, ceiling: 'high' }), revision: 2, stored: true })
  b.offline(false)
  await b.clock.advance(3000)
  expect(b.router().settings).toMatchObject({ bias: 1, ceiling: 'high' })
  expect(b.settingsRequests.filter(r => r.method === 'PUT').map(r => r.revision)).toEqual([2])
  await ui.unmount()
})

function expectLanguage(boundary: ReturnType<typeof boundaries>, language: Lang): void {
  expect(boundary.language()).toBe(language)
}

test('explicit mod language wins over host settings and locale', async ($, on) => {
  const b = boundaries(on, { language: 'pt' }, { language: 'Korean', env: { LANG: 'ja_JP', LC_ALL: 'es_ES' } })
  http(on)
  await start($)
  expectLanguage(b, 'pt')
  expect(b.processes).toEqual([])
})

test('auto prefers Claude Code language over LANG and LC_ALL', async ($, on) => {
  const b = boundaries(on, {}, { language: '한국어', env: { LANG: 'ja_JP', LC_ALL: 'es_ES' } })
  http(on)
  await start($)
  expectLanguage(b, 'ko')
  expect(b.processes).toEqual([])
})

test('off macOS, auto checks LANG then LC_ALL when the host setting is unsupported', async ($, on) => {
  const b = boundaries(on, {}, { language: 12, env: { LANG: 'zh-Hans', LC_ALL: 'pt_BR' } })
  http(on)
  await start($)
  expectLanguage(b, 'zh')
  expect(b.processes).toEqual([{ argv: ['uname', '-s'], timeoutMs: 2000 }])
})

// The desktop app can start a session with LANG=en_US on a Mac set to Korean (2026-10-10).
test('on macOS the system language wins over LANG', async ($, on) => {
  const b = boundaries(on, {}, { env: { LANG: 'en_US.UTF-8' }, platform: 'Darwin', appleLocale: 'ko_KR\n' })
  http(on)
  await start($)
  expectLanguage(b, 'ko')
})

test('auto accepts LC_ALL after an unsupported LANG', async ($, on) => {
  const b = boundaries(on, {}, { env: { LANG: 'C.UTF-8', LC_ALL: 'es_ES' } })
  http(on)
  await start($)
  expectLanguage(b, 'es')
  expect(b.processes).toEqual([{ argv: ['uname', '-s'], timeoutMs: 2000 }])
})

test('auto reads AppleLocale only on macOS with a two-second timeout', async ($, on) => {
  const b = boundaries(on, {}, { env: { LANG: 'C', LC_ALL: '' }, platform: 'Darwin', appleLocale: 'ja_JP\n' })
  http(on)
  await start($)
  expectLanguage(b, 'ja')
  expect(b.processes).toEqual([{ argv: ['uname', '-s'], timeoutMs: 2000 }, { argv: ['defaults', 'read', '-g', 'AppleLocale'], timeoutMs: 2000 }])
})

test('auto defaults to English off macOS', async ($, on) => {
  const b = boundaries(on, {}, { env: { LANG: 'C', LC_ALL: '' } })
  http(on)
  await start($)
  expectLanguage(b, 'en')
  expect(b.processes.length).toBe(1)
})

test('a failed macOS locale lookup logs the failure and falls back without preventing startup', async ($, on) => {
  const b = boundaries(on, {}, { env: { LANG: 'C', LC_ALL: '' }, platform: 'Darwin', appleFail: true })
  http(on)
  await start($)
  expectLanguage(b, 'en')
  expect(b.logs.some(log => log.includes('locale timed out'))).toBe(true)
  expect((await command($, 'stats')).text).toContain('Auto:')
})

test('dashboard language changes re-resolve auto from current host settings', async ($, on) => {
  const b = boundaries(on, { language: 'pt' }, { language: 'Korean' })
  http(on)
  await start($)
  b.remote({ settings: normalizeSettings({ setupDone: true, language: 'auto' }), revision: 2, stored: true })
  await b.clock.advance(3000)
  expectLanguage(b, 'ko')
  b.setLanguage('Japanese')
  await command($, 'settings')
  const ui = await band($)
  await ui.press({ key: 'bias-1' })
  expectLanguage(b, 'ja')
  expect(b.router().settings.language).toBe('auto')
  await ui.unmount()
})

test('ripple:auto is judged and rewritten to the light rung\'s agent at the rung\'s effort, and the pick is logged', async ($, on) => {
  const b = boundaries(on)
  const urls = http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  const result = await $.agent.spawn(SPAWN)
  expect(result.agentId).toBe('worker-1')
  // The default ladder runs light work on DeepSeek at max, whatever effort the judge named.
  expect(sent[0]).toMatchObject({ subagentType: 'deepseek-v4-1-flash', model: 'deepseek-v4.1-flash@max' })
  expect(judges[0]?.model).toBe('claude-haiku-5-5')
  expect(urls).toContain('http://127.0.0.1:9992/api/status')
  // The only debug line is the pick itself: no error was reported on the way.
  expect(b.logs.length).toBe(1)
  expect(b.logs[0]!.startsWith('ClaudeRipple worker pick: ')).toBe(true)
  expect(JSON.parse(b.logs[0]!.slice('ClaudeRipple worker pick: '.length))).toEqual({
    task: 'Rename variable', domain: 'general', level: 'light', kind: 'do', sure: 0.9, rule: 'general', rung: 'light', position: 1, skipped: [],
    target: { agent: 'deepseek-v4-1-flash' }, model: 'deepseek-v4.1-flash@max', effort: 'max', by: 'haiku',
  })
  const persisted = b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!
  expect(persisted.endsWith('\n')).toBe(true)
  expect(persisted.trim().split('\n').length).toBe(1)
  const row = JSON.parse(persisted)
  expect(typeof row.id).toBe('string')
  expect(row).toEqual({
    ...JSON.parse(b.logs[0]!.slice('ClaudeRipple worker pick: '.length)),
    type: 'pick', id: row.id, at: new Date(NOW).toISOString(), by: 'judge', judge: 'haiku', ms: 0, promptChars: SPAWN.prompt.length, attempts: [{ target: { kind: 'haiku' }, ms: 0 }],
    verdict: { domain: 'general', level: 'light', kind: 'do', effort: 'low', sure: 0.9, why: 'small rename' },
  })
  const stats = await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'stats' })
  expect(stats.text).toContain('light 1')
})

test('worker pick persistence keeps the last 3,000 lines and concurrent marker picks, never the prompt', async ($, on) => {
  const b = boundaries(on, {}, { env: { CLAUDERIPPLE_HOME: '/custom/ripple' }, messages: NAMED })
  http(on)
  const judges = judgeStub(on)
  spawnStub(on)
  const path = '/custom/ripple/logs/worker-picks.jsonl'
  b.files.set(path, Array.from({ length: 3005 }, (_, n) => JSON.stringify({ old: n })).join('\n') + '\n')
  await start($)
  await Promise.all(['first', 'second'].map(label => $.agent.spawn({ ...SPAWN, description: label + 'x'.repeat(220), prompt: '[[ripple: gpt-6-1-sol@xhigh]]\nPRIVATE_TASK_PROMPT' })))
  const text = b.files.get(path)!
  const rows = text.trim().split('\n').map(line => JSON.parse(line))
  expect(rows.length).toBe(3000)
  expect(rows[0]).toEqual({ old: 7 })
  expect(rows.slice(-2).map(row => row.task).sort()).toEqual(['first' + 'x'.repeat(195), 'second' + 'x'.repeat(194)])
  for (const row of rows.slice(-2)) expect(row).toMatchObject({ by: 'marker', verdict: null, judge: null, ms: 0, model: 'gpt-6.1-sol@xhigh', effort: 'xhigh' })
  expect(text).not.toContain('PRIVATE_TASK_PROMPT')
  expect(b.logs.join('\n')).not.toContain('PRIVATE_TASK_PROMPT')
  expect(judges.length).toBe(0)
})

for (const failure of ['read', 'write'] as const) test(`worker log ${failure} failure reports without changing the spawn and later recovers`, async ($, on) => {
  const b = boundaries(on)
  http(on)
  judgeStub(on)
  const sent = spawnStub(on)
  const path = '/home/test/.clauderipple/logs/worker-picks.jsonl'
  const previous = JSON.stringify({ previous: true }) + '\n'
  b.files.set(path, previous)
  b.failWorkerLog(failure)
  await start($)
  expect((await $.agent.spawn(SPAWN)).agentId).toBe('worker-1')
  expect(sent[0]).toMatchObject({ subagentType: 'deepseek-v4-1-flash', model: 'deepseek-v4.1-flash@max' })
  expect(b.logs.some(log => log.includes('worker pick log') && log.includes(`worker log ${failure} denied`))).toBe(true)
  expect(b.files.get(path)).toBe(previous)
  b.failWorkerLog(null)
  await $.agent.spawn(SPAWN)
  expect(b.files.get(path)!.trim().split('\n').length).toBe(2)
})

for (const error of ['api-error (503)', 'api-error (no response)', 'aborted'] as const) test(`failed worker judge persists defaults with ${error}`, async ($, on) => {
  const b = boundaries(on)
  http(on)
  on('model.complete', async ($, e) => {
    expect(e.timeoutMs).toBe(6000)
    if (error === 'aborted') await b.clock.advance(6000)
    return { value: error === 'aborted' ? { isAnswered: false, reason: 'aborted', usage: USAGE } : { isAnswered: false, reason: 'api-error', status: error === 'api-error (no response)' ? null : 503, error: 'overloaded', usage: USAGE } }
  })
  const sent = spawnStub(on)
  await start($)
  expect((await $.agent.spawn(SPAWN)).agentId).toBe('worker-1')
  const row = JSON.parse(b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!)
  expect(row).toMatchObject({ by: 'default', verdict: null, judge: null, error, ms: error === 'aborted' ? 12000 : 0, rung: 'standard', model: 'gpt-6.1-sol@medium', effort: 'medium', position: 1, skipped: [] })
  expect(sent[0]).toMatchObject({ subagentType: 'gpt-6-1-sol', model: 'gpt-6.1-sol@medium' })
})

// The main chat only delegates; the judge picks among all four workers (2026-10-12 revision).
for (const prefix of ['ripple:', '']) for (const [level, kind, rung, agent, model, effort] of [
  ['light', 'do', 'light', 'deepseek-v4-1-flash', 'deepseek-v4.1-flash@max', 'max'],
  ['standard', 'do', 'standard', 'gpt-6-1-sol', 'gpt-6.1-sol@medium', 'medium'],
  ['deep', 'do', 'hard', 'gpt-6-astra', 'gpt-6-astra@high', 'high'],
  ['deep', 'plan', 'plan', 'general-purpose', 'opus', 'high'],
] as const) test(`${prefix}auto: a ${level} ${kind} verdict runs the ${rung} rung`, async ($, on) => {
  const b = boundaries(on)
  http(on)
  const judges = judgeStub(on, JSON.stringify({ domain: 'general', level, kind, effort: 'low', sure: 0.9, why: 'judged' }))
  const sent = spawnStub(on)
  const steps = stepStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, subagentType: prefix + 'auto' })
  expect(judges.length).toBe(1)
  expect(sent[0]).toMatchObject({ subagentType: agent, model })
  expect(JSON.parse(b.logs.find(log => log.startsWith('ClaudeRipple worker pick: '))!.slice('ClaudeRipple worker pick: '.length))).toMatchObject({ level, kind, rung, by: 'haiku', effort })
  // Named workers carry effort in their model suffix; Claude's own agent gets it on turn.step.
  if (agent === 'general-purpose') {
    await step($, 'claude-opus-5-5', 'low', 'worker-1')
    expect(steps[0]?.effort).toBe(effort)
  }
})

// The main chat names the tier itself; the judge is not asked (its shadow rating ended 2026-10-22).
for (const [tier, rung, agent, model] of [
  ['light', 'light', 'deepseek-v4-1-flash', 'deepseek-v4.1-flash@max'],
  ['standard', 'standard', 'gpt-6-1-sol', 'gpt-6.1-sol@medium'],
  ['hard', 'hard', 'gpt-6-astra', 'gpt-6-astra@high'],
  ['max', 'plan', 'general-purpose', 'opus'],
] as const) test(`a [[ripple: ${tier}]] marker runs the ${rung} rung without asking the judge`, async ($, on) => {
  const b = boundaries(on)
  http(on)
  const judges = judgeStub(on, JSON.stringify({ domain: 'backend', level: 'deep', kind: 'do', effort: 'high', sure: 0.8, why: 'judged' }))
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, prompt: `[[ripple: ${tier}]]\nRename one local variable and verify it.` })
  await b.clock.settle()
  // The tier marker is the main chat's to the mod, never a model name the router would see.
  expect(sent[0]).toMatchObject({ subagentType: agent, model, prompt: 'Rename one local variable and verify it.' })
  const rows = b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!.trim().split('\n').map(line => JSON.parse(line))
  const pick = rows.find(row => row.type === 'pick')
  expect(pick).toMatchObject({ by: 'session', tier, rung, domain: 'general', judge: null, verdict: null })
  expect(judges.length).toBe(0)
  expect(rows.some(row => row.type === 'shadow')).toBe(false)
  // The worker's end joins the same pick.
  await complete($, 'worker-1', 'Renamed and tested.')
  const after = b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!.trim().split('\n').map(line => JSON.parse(line))
  expect(after.find(row => row.type === 'outcome')).toMatchObject({ pick: pick.id, agent: 'worker-1', reason: 'answer', aborted: false, ms: 1000, answerChars: 19 })
  // Once: a second completion of the same agent writes no second outcome.
  await complete($, 'worker-1')
  expect(b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!.trim().split('\n').filter(line => line.includes('"outcome"')).length).toBe(1)
})

for (const domain of ['design', 'frontend', 'backend', 'docs'] as const) test(`auto selects the ${domain} task's domain ladder or its own general fallback`, async ($, on) => {
  const b = boundaries(on, { domainRules: {
    ui: { mode: 'ladder', rungs: { light: [{ target: { agent: 'gpt-6-astra' }, effort: 'high' }], hard: [{ target: { agent: 'gpt-6-1-sol' }, effort: 'high' }] } },
    backend: { mode: 'ladder', rungs: { light: [{ target: { agent: 'gpt-6-1-sol' }, effort: 'medium' }] } },
  } })
  http(on)
  judgeStub(on, JSON.stringify({ domain, level: 'light', kind: 'do', effort: 'low', sure: 0.9, why: 'domain' }))
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn(SPAWN)
  const rule = domain === 'design' || domain === 'frontend' ? 'ui' : domain === 'backend' ? 'backend' : 'general'
  // Light work takes a domain ladder's light row, design included.
  expect(sent[0]?.subagentType).toBe(rule === 'ui' ? 'gpt-6-astra' : rule === 'backend' ? 'gpt-6-1-sol' : 'deepseek-v4-1-flash')
  const row = JSON.parse(b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!)
  expect(row).toMatchObject({ rule, domain, level: 'light', rung: 'light' })
  expect(row.raised).toBeUndefined()
})

// The ladder a tier marker reaches is the one its domain word names; the judge is never asked.
for (const [prompt, agent, rule, rung] of [
  ['[[ripple: light ui]]\nTweak a color.', 'gpt-6-astra', 'ui', 'light'],
  ['[[ripple: standard ui]]\nBuild the settings screen.', 'gpt-6-1-sol', 'ui', 'standard'],
  ['[[ripple: standard backend]]\nAdd the endpoint.', 'gpt-6-astra', 'backend', 'standard'],
  ['[[ripple: standard]]\nRewrite strings in the dictionary, app and server.', 'gpt-6-1-sol', 'general', 'standard'],
] as const) test(`${prompt.split('\n')[0]} runs the ${rule} ladder's ${rung} rung`, async ($, on) => {
  const b = boundaries(on, { domainRules: {
    ui: { mode: 'ladder', rungs: { light: [{ target: { agent: 'gpt-6-astra' }, effort: 'high' }], hard: [{ target: { agent: 'gpt-6-1-sol' }, effort: 'high' }] } },
    backend: { mode: 'ladder', rungs: { light: [{ target: { agent: 'deepseek-v4-1-flash' }, effort: 'high' }], plan: [{ target: { agent: 'gpt-6-astra' }, effort: 'high' }] } },
  } })
  http(on)
  const judges = judgeStub(on, JSON.stringify({ domain: 'frontend', level: 'deep', kind: 'plan', effort: 'max', sure: 0.6, why: 'judged' }))
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, prompt })
  expect(sent[0]).toMatchObject({ subagentType: agent, prompt: prompt.split('\n')[1] })
  expect(judges.length).toBe(0)
  const row = JSON.parse(b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!.trim())
  expect(row).toMatchObject({ by: 'session', rule, rung, verdict: null })
})

test('a mode without domain rules sends a ui-marked task to its general ladder; explicit model markers still bypass the judge', async ($, on) => {
  const b = boundaries(on, { domainRules: { ui: DEFAULTS.rules.general }, modes: [{ id: 'plain', name: 'Plain', rungs: DEFAULTS.rules.general.rungs, delegation: 'normal', until: 'none' }], activeMode: 'plain' }, { messages: NAMED })
  http(on)
  const judges = judgeStub(on, '{"domain":"frontend","level":"light","effort":"low","sure":0.9}')
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, prompt: '[[ripple: light ui]]\nWork.' })
  await b.clock.settle()
  const rows = b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!.trim().split('\n').map(line => JSON.parse(line))
  expect(rows.find(row => row.type === 'pick')).toMatchObject({ domain: 'frontend', rule: 'general', mode: 'Plain', verdict: null })
  // Turn Base on, so its domain override is effective for this explicit marker.
  b.remote({ settings: normalizeSettings({ setupDone: true, domainRules: { ui: DEFAULTS.rules.general } }), revision: 2, stored: true })
  await b.clock.advance(3000)
  await $.agent.spawn({ ...SPAWN, prompt: '[[ripple: gpt-6-astra@max]]\nWork.' })
  expect(judges.length).toBe(0)
  expect(sent[1]).toMatchObject({ subagentType: 'gpt-6-astra', model: 'gpt-6-astra@max' })
})

test('the limits row shows Claude\'s plan on a chat that runs on another provider', async ($, on) => {
  const b = boundaries(on, { extras: ['limits'] })
  b.setModel('muse-spark-1.3-contributor')
  // The unified `/api/limits` body: Claude's plan regardless of the chat's routed provider.
  const limits = { providers: [{ provider: 'claude', type: 'anthropic', title: 'Claude', accounts: [{ account: 0, at: NOW, windows: [
    { kind: 'five_hour', used_percent: 1, window_minutes: 300, reset_at: (NOW + 3_600_000) / 1000 },
    { kind: 'seven_day', used_percent: 88, window_minutes: 10080, reset_at: (NOW + 7_200_000) / 1000 },
    { kind: 'scoped', label: 'Fable', used_percent: 2, window_minutes: 10080 },
  ] }] }] }
  on('http.fetch', ($, e, next) => {
    if (e.url.endsWith('/api/mod-settings')) return next(e)
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify(e.url.endsWith('/api/limits') ? limits : { requests: [] }) } }
  })
  await start($)
  await b.clock.advance(15000)
  const ui = await band($, 'desktop')
  for (const text of [/^Claude$/, /^88%$/, /^Fable$/]) expect(await ui.find({ type: 'Text', text }), String(text)).toBeDefined()
  await ui.unmount()
})

test('a failed first limits read is tried again at the next tick, not a minute later', async ($, on) => {
  const b = boundaries(on, { extras: ['limits'] })
  const limits = { providers: [{ provider: 'claude', type: 'anthropic', title: 'Claude', accounts: [{ account: 0, at: NOW, windows: [
    { kind: 'seven_day', used_percent: 88, window_minutes: 10080, reset_at: (NOW + 7_200_000) / 1000 },
  ] }] }] }
  let reads = 0
  on('http.fetch', ($, e, next) => {
    if (e.url.endsWith('/api/mod-settings')) return next(e)
    if (e.url.endsWith('/api/limits') && ++reads === 1) return { value: { ok: false, status: 503, headers: {}, text: '' } }
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify(e.url.endsWith('/api/limits') ? limits : { requests: [] }) } }
  })
  await start($)
  await b.clock.advance(15000)
  expect(reads).toBeGreaterThan(1)
  const ui = await band($, 'desktop')
  expect(await ui.find({ type: 'Text', text: /^88%$/ })).toBeDefined()
  await ui.unmount()
})

test('a tier marker on a worker other than ripple:auto is dropped, not routed as a model', async ($, on) => {
  boundaries(on)
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, subagentType: 'Explore', prompt: '[[ripple: hard]]\nFind the router entry point.' })
  expect(judges.length).toBe(0)
  expect(sent[0]).toMatchObject({ subagentType: 'Explore', prompt: 'Find the router entry point.' })
  expect(sent[0]?.model).toBeUndefined()
})

test('a judged spawn uses the default general ladder when general is inherit', async ($, on) => {
  boundaries(on, { rules: normalizeSettings({ rules: { general: { mode: 'inherit' } } }).rules })
  http(on)
  const judges = judgeStub(on, '{"domain":"backend","level":"standard","effort":"low","sure":0.9,"why":"implementation"}')
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn(SPAWN)
  expect(sent[0]).toMatchObject({ subagentType: 'gpt-6-1-sol', model: 'gpt-6.1-sol@medium' })
  expect(judges.length).toBe(1)
})

test('a judged spawn uses the configured general ladder, then one rung up on a missing worker', async ($, on) => {
  const rules = normalizeSettings({ rules: { general: { mode: 'ladder', rungs: {
    light: { target: { agent: 'missing-worker' }, effort: 'low' },
    standard: { target: { agent: 'gpt-6-astra' }, effort: 'xhigh' },
  } } } }).rules
  const b = boundaries(on, { rules })
  http(on)
  judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn(SPAWN)
  expect(sent[0]).toMatchObject({ subagentType: 'gpt-6-astra', model: 'gpt-6-astra@xhigh' })
  expect(b.toasts.some(text => text.includes('missing-worker'))).toBe(true)
  expect(JSON.parse(b.logs[0]!.slice('ClaudeRipple worker pick: '.length))).toMatchObject({ level: 'light', rung: 'standard', by: 'haiku' })
  const persisted = JSON.parse(b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!)
  expect(persisted).toMatchObject({ verdict: { level: 'light', effort: 'low' }, rung: 'standard', model: 'gpt-6-astra@xhigh', effort: 'xhigh', by: 'judge' })
  expect(persisted.skipped.length).toBeGreaterThan(0)
  expect(persisted.fallbackReason).toContain('missing-worker')
})

test('exhaustion falls to the session after only one rung up; a plan verdict never moves down', async ($, on) => {
  const rules = normalizeSettings({ rules: { general: { mode: 'ladder', rungs: {
    standard: { target: { agent: 'gpt-6-1-sol' }, effort: 'medium' },
    hard: { target: { agent: 'gpt-6-astra' }, effort: 'high' },
    plan: { target: { agent: 'missing-max' }, effort: 'xhigh' },
  } } } }).rules
  const b = boundaries(on, { rules })
  http(on, true)
  const verdicts = [
    '{"domain":"backend","level":"standard","kind":"do","effort":"low","sure":0.9,"why":"implementation"}',
    '{"domain":"general","level":"deep","kind":"plan","effort":"high","sure":0.9,"why":"architecture"}',
  ]
  on('model.complete', () => ({ value: { isAnswered: true, text: verdicts.shift() ?? verdicts[0] ?? '', usage: USAGE } }))
  const sent = spawnStub(on)
  await start($)
  for (let i = 0; i < 2; i++) await $.agent.spawn(SPAWN)
  expect(sent.map(e => [e.subagentType, e.model])).toEqual([['general-purpose', undefined], ['general-purpose', undefined]])
  expect(b.toasts.some(text => text.includes('ChatGPT'))).toBe(true)
  expect(b.toasts.some(text => text.includes('missing-max'))).toBe(true)
})

for (const agentAuto of ['off', 'auto', 'all'] as const) test('only ripple:auto is registered, and takeover respects agentAuto ' + agentAuto, async ($, on) => {
  const { registered } = boundaries(on, { agentAuto })
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  expect([...new Set(registered.map(e => e.name))]).toEqual(agentAuto === 'off' ? [] : ['auto'])
  for (const entry of registered) {
    expect(entry.description).toContain('[[ripple: standard]]')
    expect(entry.disallowedTools).toEqual(['Agent'])
  }
  await $.agent.spawn(SPAWN)
  expect(sent[0]?.subagentType).toBe(agentAuto === 'off' ? 'ripple:auto' : 'deepseek-v4-1-flash')
  // A tier agent from a session started before 2026-10-12 is no longer taken over.
  await $.agent.spawn({ ...SPAWN, subagentType: 'ripple:max' })
  expect(sent[1]?.subagentType).toBe('ripple:max')
  await $.agent.spawn({ ...SPAWN, fork: true })
  expect(sent[2]?.subagentType).toBe('ripple:auto')
  expect(judges.length).toBe(agentAuto === 'off' ? 0 : 1)
})

test('a rung\'s stored backup is dropped on load: ChatGPT exhaustion moves up, it does not run the backup', async ($, on) => {
  const rules = normalizeSettings({ rules: { general: { mode: 'ladder', rungs: {
    standard: { target: { agent: 'gpt-6-1-sol' }, effort: 'high', backup: { agent: 'general-purpose', model: 'opus' } },
    hard: { target: { agent: 'gpt-6-astra' }, effort: 'xhigh' },
  } } } }).rules
  const b = boundaries(on, { rules })
  http(on, true)
  judgeStub(on, '{"domain":"backend","level":"standard","effort":"low","why":"implementation"}')
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn(SPAWN)
  expect(sent[0]).toMatchObject({ subagentType: 'general-purpose' })
  expect(sent[0]?.model).toBeUndefined()
  expect(b.toasts.some(t => t.includes('ChatGPT') && t.includes("the session's model"))).toBe(true)
})

test('without a backup, ChatGPT exhaustion moves one rung up, then to the session model', async ($, on) => {
  const b = boundaries(on)
  http(on, true)
  judgeStub(on, '{"domain":"backend","level":"standard","effort":"high","why":"implementation"}')
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn(SPAWN)
  // Standard is Sol and Hard is Astra, both ChatGPT: the subagent runs on the session's model.
  expect(sent[0]?.subagentType).toBe('general-purpose')
  expect(sent[0]?.model).toBeUndefined()
  expect(b.toasts.some(t => t.includes('ChatGPT') && t.includes("the session's model"))).toBe(true)
})

test('each spawn refreshes provider health before picking and toasts the exhaustion reason', async ($, on) => {
  const b = boundaries(on, { language: 'ko' })
  let exhausted = false
  let reads = 0
  on('http.fetch', { url: /\/api\/mod-options$/ }, () => {
    reads++
    const providers = MOD_OPTIONS.providers.map(p => p.name === 'deepseek' ? { ...p, usable: !exhausted, ...(exhausted ? { reason: 'insufficient_balance', exhaustedUntil: NOW + 1_800_000 } : {}) } : p)
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ ...MOD_OPTIONS, providers }) } }
  })
  http(on)
  judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn(SPAWN)
  expect(sent[0]?.subagentType).toBe('deepseek-v4-1-flash')
  const before = reads
  exhausted = true
  await $.agent.spawn(SPAWN)
  expect(reads).toBeGreaterThan(before)
  expect(sent[1]?.subagentType).toBe('gpt-6-1-sol')
  expect(b.toasts.some(text => text.includes('deepseek: 잔액 부족'))).toBe(true)
  exhausted = false
  await $.agent.spawn(SPAWN)
  expect(sent[2]?.subagentType).toBe('deepseek-v4-1-flash')
})

test('explicit generated worker preserves the old dropped-model and misplaced-marker fix', async ($, on) => {
  const b = boundaries(on, {}, { messages: NAMED })
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, subagentType: 'deepseek-v4-1-flash', model: 'sonnet', prompt: 'Context\n[[ripple: deepseek-v4-1-flash@max]]\nDo the work.' })
  expect(judges.length).toBe(0)
  expect(sent[0]?.model).toBe('deepseek-v4.1-flash@max')
  expect(sent[0]?.prompt).not.toContain('[[ripple:')
  expect(b.toasts.some(t => t.includes('own model') && t.includes('sonnet'))).toBe(true)
})

test('an explicit marker on ripple:auto bypasses its judge', async ($, on) => {
  boundaries(on, {}, { messages: NAMED })
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, prompt: '[[ripple: gpt-6-1-sol@xhigh]]\nReview this.' })
  expect(judges.length).toBe(0)
  expect(sent[0]).toMatchObject({ subagentType: 'gpt-6-1-sol', model: 'gpt-6.1-sol@xhigh' })
})

// 2026-10-22: asked twice for Gemini proofreading, a session went on to give Gemini an implementation
// task on its own. A model the user did not name is ignored and the tier decides.
test('an explicit marker the user did not name is dropped; the judge decides, or a tier marker under it', async ($, on) => {
  const b = boundaries(on)
  http(on)
  const judges = judgeStub(on, JSON.stringify({ domain: 'general', level: 'light', kind: 'do', effort: 'low', sure: 0.9, why: 'judged' }))
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, prompt: '[[ripple: gpt-6-1-sol@xhigh]]\nReview this.' })
  expect(judges.length).toBe(1)
  expect(sent[0]).toMatchObject({ subagentType: 'deepseek-v4-1-flash', prompt: 'Review this.' })
  expect(b.toasts.some(text => text.includes('gpt-6-1-sol') && text.includes('by tier'))).toBe(true)
  const row = JSON.parse(b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!.trim())
  expect(row.by).not.toBe('marker')
})

for (const [label, spawn] of [
  ['a worker agent called directly', { subagentType: 'gpt-6-1-sol', prompt: '[[ripple: hard]]\nFix the race.' }],
  ['general-purpose given a model', { subagentType: 'general-purpose', model: 'sonnet', prompt: '[[ripple: hard]]\nFix the race.' }],
  ['a model marker on another agent', { subagentType: 'general-purpose', prompt: '[[ripple: gpt-6-1-sol@high]]\n[[ripple: hard]]\nFix the race.' }],
] as const) test(`${label}, not named by the user, goes through the ladder`, async ($, on) => {
  const b = boundaries(on, { agentAuto: 'auto' })
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, ...spawn })
  expect(judges.length).toBe(0)
  expect(sent[0]).toMatchObject({ subagentType: 'gpt-6-astra', model: 'gpt-6-astra@high', prompt: 'Fix the race.' })
  expect(b.toasts.some(text => text.includes('by tier'))).toBe(true)
  expect(JSON.parse(b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!.trim())).toMatchObject({ by: 'session', tier: 'hard', rung: 'hard' })
})

test("a Workflow's ripple:auto whose marker names a worker runs on that worker's model; a tier marker or none is left alone", async ($, on) => {
  // 2026-10-23: 31 Workflow workers sent as ripple:auto with [[ripple: gpt-6-1-sol@medium]] ran on Sol
  // through the router but showed as Opus 5.5, and their later turns lost the marker.
  boundaries(on, {}, { messages: MESSAGES })
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  const WORKFLOW = { ...SPAWN, workflow: true } as AgentSpawnInput
  await $.agent.spawn({ ...WORKFLOW, prompt: "[[ripple: gpt-6-1-sol@medium]]\nWrite the review." })
  // The engine keeps a workflow agent's type and description; its model is what can change.
  expect(sent[0]).toMatchObject({ subagentType: "ripple:auto", prompt: "Write the review.", model: "gpt-6.1-sol@medium", description: "Rename variable" })
  await $.agent.spawn({ ...WORKFLOW, prompt: "[[ripple: hard]]\nWrite the review." })
  expect(sent[1]?.model).toBeUndefined()
  await $.agent.spawn({ ...WORKFLOW, prompt: "Write the review." })
  expect(sent[2]?.model).toBeUndefined()
  expect(judges.length).toBe(0)
})

test('a worker the user named in their last message runs as called, after a short go-ahead too', async ($, on) => {
  boundaries(on, {}, { messages: [
    { role: 'user', text: '이 문구들 다듬어 줘', toolUses: [] },
    { role: 'assistant', text: '솔에게 교정안을 받겠습니다. 진행할까요?', toolUses: [] },
    { role: 'user', text: 'ㄱㄱ', toolUses: [] },
  ] })
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, subagentType: 'gpt-6-1-sol', prompt: 'Propose fixes.' })
  expect(judges.length).toBe(0)
  expect(sent[0]).toMatchObject({ subagentType: 'gpt-6-1-sol', prompt: 'Propose fixes.' })
})

test('failed worker judge uses the standard rung; a missing worker moves up to the next rung', async ($, on) => {
  const rules = normalizeSettings({ rules: { general: { mode: 'ladder', rungs: {
    standard: { target: { agent: 'missing-worker' }, effort: 'medium' }, hard: { target: { agent: 'general-purpose', model: 'sonnet' }, effort: 'high' },
  } } } }).rules
  boundaries(on, { rules })
  http(on, true)
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage: USAGE } }))
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn(SPAWN)
  expect(sent[0]).toMatchObject({ subagentType: 'general-purpose', model: 'sonnet' })
  const debug = await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'debug' })
  expect(debug.text).toContain('"effort": "high"')
  expect(debug.text).toContain('"rung": "hard"')
  expect(debug.text).toContain('"by": "default"')
})

test('Zen Jev uses the exact config authorization and first Jev model with CLAUDERIPPLE_HOME', async ($, on) => {
  const paths: string[] = []
  const config = { ...CONFIG, providers: { ...CONFIG.providers, 'opencode-zen': { headers: { authorization: 'Bearer zen-config-key' }, models: [{ id: 'other' }, { id: 'jev-1.13' }, { id: 'jev-latest' }] } } }
  boundaries(on, { judges: [{ kind: 'jev' }, { kind: 'haiku' }], jevSource: 'zen' }, { env: { CLAUDERIPPLE_HOME: '/custom/ripple' }, config, paths })
  const sent: { url: string; body?: string; headers?: Readonly<Record<string, string>> }[] = []
  http(on, false, config, e => sent.push({ url: e.url, body: e.init?.body, headers: e.init?.headers }))
  const haiku = judgeStub(on)
  await start($)
  await submit($)
  expect(sent.length).toBe(1)
  expect(sent[0]?.headers?.authorization).toBe('Bearer zen-config-key')
  expect(JSON.parse(sent[0]!.body!)).toMatchObject({ model: 'jev-1.13', questions: { effort: { type: 'choice' } } })
  expect(haiku.length).toBe(0)
  expect(paths).toContain('/custom/ripple/config.json')
  await command($, 'settings')
  const ui = await band($)
  expect(await ui.find({ key: 'jev-key' })).toBeUndefined()
  expect(await ui.find({ key: 'jev-test' })).toBeUndefined()
  // The source choice is drawn whenever Jev is in the chain; with Zen's key found there is no key field or Test.
  expect(await ui.find({ key: 'jev-source-zen' })).toBeDefined()
  await ui.unmount()
})

test('Zen without a key explains the missing key and falls back to Haiku', async ($, on) => {
  const b = boundaries(on, { judges: [{ kind: 'jev' }, { kind: 'haiku' }], jevSource: 'zen' })
  const urls = http(on)
  const haiku = judgeStub(on, '{"effort":"medium","why":"fallback"}')
  await start($)
  await submit($)
  expect(haiku.length).toBe(1)
  expect(urls.some(url => url.includes('opencode.ai'))).toBe(false)
  expect(b.toasts.some(text => text.includes('No OpenCode Zen authorization key'))).toBe(true)
})

test('provider off refuses named workers and every-provider-off refuses automatic spawning', async ($, on) => {
  boundaries(on, { providers: { chatgpt: false, deepseek: false, anthropic: false } }, { messages: NAMED })
  http(on)
  judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  const explicit = await $.agent.spawn({ ...SPAWN, subagentType: 'gpt-6-1-sol' })
  expect(explicit.deny).toContain('switched off')
  const automatic = await $.agent.spawn(SPAWN)
  expect(automatic.deny).toContain('No enabled worker')
  expect(sent.length).toBe(0)
})

test('a subagent may not start a worker; the main chat still delegates', async ($, on) => {
  boundaries(on)
  http(on)
  const judges = judgeStub(on)
  const sent = spawnStub(on)
  await start($)
  const nested = await $.agent.spawn({ ...SPAWN, parentAgentId: 'agent-7' })
  expect(nested.deny).toContain('may not start another subagent')
  const named = await $.agent.spawn({ ...SPAWN, subagentType: 'gpt-6-1-sol', parentAgentId: 'agent-7' })
  expect(named.deny).toContain('may not start another subagent')
  expect(judges.length).toBe(0)
  expect(sent.length).toBe(0)
  expect((await $.agent.spawn(SPAWN)).agentId).toBe('worker-1')
})

test('prompt judge rewrites every Opus 5.5 main step, not subagent effort', async ($, on) => {
  boundaries(on)
  http(on)
  const calls = judgeStub(on, '{"effort":"high","sure":0.9,"why":"multi step"}')
  const sent = stepStub(on)
  await start($)
  await submit($)
  await step($)
  await step($)
  await step($, 'claude-opus-5-5', 'low', 'untracked')
  expect(calls.length).toBe(1)
  expect(sent.map(s => s.effort)).toEqual(['high', 'high', 'low'])
  const stats = await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'stats' })
  expect(stats.text).toContain('Auto: 1 prompts, 2 requests')
})

test('Fable pauses without paying a judge or rewriting effort', async ($, on) => {
  const b = boundaries(on)
  b.setModel('claude-fable-5-1')
  http(on)
  const calls = judgeStub(on)
  const sent = stepStub(on)
  await start($)
  await submit($)
  await step($, 'claude-fable-5-1', 'max')
  expect(calls.length).toBe(0)
  expect(sent[0]?.effort).toBe('max')
  const debug = await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'debug' })
  expect(debug.text).toContain('"paused": true')
})

test('a later person app-effort change turns Auto off and wins', async ($, on) => {
  const b = boundaries(on)
  http(on)
  judgeStub(on, '{"effort":"high","why":"scope"}')
  const sent = stepStub(on)
  await start($)
  await submit($)
  await step($, 'claude-opus-5-5', 'medium')
  await step($, 'claude-opus-5-5', 'low')
  expect(sent.map(s => s.effort)).toEqual(['high', 'low'])
  expect(b.router().settings).toMatchObject({ effortAuto: false })
  expect(b.toasts.some(t => t.includes('turned Auto off'))).toBe(true)
})

test('lower mid-turn pick waits until turn.complete', async ($, on) => {
  boundaries(on)
  http(on)
  let judges = 0
  on('model.complete', () => ({ value: { isAnswered: true, text: JSON.stringify({ effort: ++judges === 1 ? 'high' : 'low', why: 'scope' }), usage: USAGE } }))
  const sent = stepStub(on)
  await start($)
  await submit($)
  await step($)
  await submit($, 'This is a simpler separate task now.', 'turn-1')
  await step($)
  await complete($)
  await step($)
  expect(sent.map(s => s.effort)).toEqual(['high', 'high', 'low'])
})

test('short followups retain the pick; host slash commands are not judged', async ($, on) => {
  boundaries(on)
  http(on)
  const judges = judgeStub(on, '{"effort":"high","why":"scope"}')
  stepStub(on)
  await start($)
  await submit($)
  await submit($, 'go')
  await submit($, '/clear')
  expect(judges.length).toBe(1)
  const result = await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'stats' })
  expect(result.text).toContain('Auto: 2 prompts')
})

test('keep-warm forks near expiry, refreshes the memo and stops once on a null fork', async ($, on) => {
  const b = boundaries(on, { keepWarm: true })
  http(on)
  judgeStub(on)
  stepStub(on)
  let forks = 0
  // null is a measured legacy failure; current declarations exclude it, so this boundary stub
  // deliberately returns it through an unchecked value (not a cast in production code).
  on('model.fork', () => ({ value: ++forks === 1 ? { isAnswered: true, text: 'ok', usage: USAGE } : JSON.parse('null') }))
  await start($)
  await step($)
  await complete($)
  await b.clock.advance(3375000)
  expect(forks).toBe(1)
  const first = await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'debug' })
  expect(first.text).toContain('"pings": 1')
  await b.clock.advance(3375000)
  expect(forks).toBe(2)
  await b.clock.advance(120000)
  expect(forks).toBe(2)
  expect(b.toasts.filter(t => t.includes('Keep warm stopped')).length).toBe(1)
  const stats = await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'stats' })
  expect(stats.text).toContain('Warm: 1 pings')
})

test('a cache-reading ping keeps the card, a real reply and /clear drop it, and the demo draws it', async ($, on) => {
  const b = boundaries(on, { keepWarm: true })
  http(on)
  judgeStub(on)
  stepStub(on)
  on('model.fork', () => ({ value: { isAnswered: true, text: 'ok', usage: USAGE } }))
  await start($)
  await step($)
  await complete($)
  await b.clock.advance(3375000)
  // The ping read 40000 cache tokens: the card tells it, with the memo's minutes left.
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /held 40k tokens in cache/ })).toBeDefined()
  await ui.unmount()
  // A prompt counts as having seen the card; the next is a real reply, which clears the count.
  await submit($)
  await step($)
  await complete($)
  const after = await band($)
  expect(await after.find({ type: 'Text', text: /held 40k tokens in cache/ })).toBeUndefined()
  await after.unmount()
  await b.clock.advance(3375000)
  await b.clock.settle()
  const again = await band($)
  expect(await again.find({ type: 'Text', text: /held 40k tokens in cache/ })).toBeDefined()
  await again.unmount()
  await $.classic.SessionStart({ source: 'clear' })
  const cleared = await band($)
  expect(await cleared.find({ type: 'Text', text: /held 40k tokens in cache/ })).toBeUndefined()
  await cleared.unmount()
  // The demo shows the card with sample values, whatever the state.
  await command($, 'kept')
  const demo = await band($)
  expect(await demo.find({ type: 'Text', text: /held 312k tokens in cache/ })).toBeDefined()
})

test('fork turn.step is not effort-steered, busy or main-request cost', async ($, on) => {
  const b = boundaries(on, { keepWarm: true })
  http(on)
  judgeStub(on, '{"effort":"high","why":"scope"}')
  const sent = stepStub(on)
  let forks = 0
  on('model.fork', async () => {
    forks++
    await step($, 'claude-opus-5-5', 'medium')
    return { value: { isAnswered: true, text: 'ok', usage: USAGE } }
  })
  await start($)
  await submit($)
  await step($)
  await complete($)
  await b.clock.advance(3375000)
  expect(forks).toBe(1)
  expect(sent.map(s => s.effort)).toEqual(['high', 'medium'])
  const stats = await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'stats' })
  expect(stats.text).toContain('Auto: 1 prompts, 1 requests')
  expect(stats.text).toContain('Warm: 1 pings')
})

test('the flame turns keep-warm off for this chat only; Settings stay as they are', async ($, on) => {
  const b = boundaries(on, { keepWarm: true })
  http(on)
  judgeStub(on, '{"effort":"high","why":"scope"}')
  stepStub(on)
  let forks = 0
  on('model.fork', async () => { forks++; return { value: { isAnswered: true, text: 'ok', usage: USAGE } } })
  await start($)
  await submit($)
  await step($)
  await complete($)
  await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'warm' })
  await b.clock.advance(3375000)
  expect(forks).toBe(0)
  expect(b.router().settings.keepWarm).toBe(true)
})

test('Haiku compaction returns replacement messages and forwards the keep note', async ($, on) => {
  boundaries(on)
  http(on)
  const calls = judgeStub(on, 'Verified continuation summary. '.repeat(20))
  let engine = 0
  on('session.compact', () => { engine++; return { messages: MESSAGES } })
  await start($)
  const out = await $.session.compact({ trigger: 'manual', messages: MESSAGES, instructions: 'Keep file paths.' })
  expect(calls[0]).toMatchObject({ model: 'claude-haiku-5-5', maxTokens: 16000, timeoutMs: 240000, effort: 'medium' })
  expect(calls[0]?.prompt).toContain('Keep file paths.')
  expect(out.messages?.[0]?.text.includes('Continuation record')).toBe(true)
  expect(engine).toBe(0)
})

test('failed Haiku compaction falls back; precompute skips; subagent stays with engine', async ($, on) => {
  const b = boundaries(on)
  http(on)
  const calls = judgeStub(on, 'too short')
  let engine = 0
  on('session.compact', () => { engine++; return { messages: MESSAGES } })
  await start($)
  await $.session.compact({ trigger: 'manual', messages: MESSAGES })
  const skipped = await $.session.compact({ trigger: 'precompute', messages: MESSAGES })
  await $.session.compact({ trigger: 'auto', messages: MESSAGES, agentId: 'worker' })
  expect(engine).toBe(2)
  expect(calls.length).toBe(1)
  expect('skip' in skipped).toBe(true)
  expect(b.toasts.some(t => t.includes('session compactor'))).toBe(true)
})

test('the Compact icon counts the main chat\'s finished compactions; /clear zeroes it', async ($, on) => {
  boundaries(on, { compactWith: 'session' })
  http(on)
  on('session.compact', () => ({ messages: MESSAGES }))
  await start($)
  const alt = async (ui: Awaited<ReturnType<typeof band>>) => {
    const box = await ui.find({ key: 'pic-compact' })
    return (box?.children[0] as { props?: { alt?: unknown } } | undefined)?.props?.alt
  }
  let ui = await band($, 'desktop')
  expect(await alt(ui)).toBe('Compact')
  await ui.unmount()
  await $.session.compact({ trigger: 'manual', messages: MESSAGES })
  await $.session.compact({ trigger: 'auto', messages: MESSAGES })
  // Neither a subagent's own compaction nor the ahead-of-time precompute is the chat's.
  await $.session.compact({ trigger: 'auto', messages: MESSAGES, agentId: 'worker' })
  await $.session.compact({ trigger: 'precompute', messages: MESSAGES })
  ui = await band($, 'desktop')
  expect(await alt(ui)).toBe('Compact 2')
  await ui.unmount()
  await $.classic.SessionStart({ source: 'clear' })
  ui = await band($, 'desktop')
  expect(await alt(ui)).toBe('Compact')
  await ui.unmount()
})

// ---- Operating modes (docs/specs/2026-10-12-worker-tiers.md "Operating modes") -----------------

const BURN = normalizeModes([{ id: 'burn', name: 'Burn GPT', rungs: { ...DEFAULTS.rules.general.rungs, light: [{ target: { agent: 'gpt-6-1-sol' }, effort: 'low' }] }, delegation: 'eager' }])

test('an eager mode notes the main chat once, and again after a compaction; its tiers route spawns and each pick names it', async ($, on) => {
  const b = boundaries(on, { modes: BURN, activeMode: 'burn', activeSince: NOW, compactWith: 'session' })
  http(on)
  judgeStub(on)
  const sent = spawnStub(on)
  on('session.compact', () => ({ messages: MESSAGES }))
  await start($)
  await submit($)
  await submit($)
  // A slash command is not the user's prompt: no note, and the turn after it is still noted.
  await submit($, '/model')
  await $.session.compact({ trigger: 'auto', messages: MESSAGES })
  // A subagent's compaction is not the main chat's.
  await submit($)
  await $.session.compact({ trigger: 'auto', messages: MESSAGES, agentId: 'worker' })
  await submit($)
  const note = 'ClaudeRipple mode Burn GPT: delegate everything except judgment and final review to ripple:auto.'
  expect(b.contexts).toEqual([[note], [], [], [note], []])
  // Prefer ChatGPT: Low leaves DeepSeek for the cheaper of Sol and Astra (AA cost), at Low's effort.
  await $.agent.spawn(SPAWN)
  expect(sent[0]).toMatchObject({ subagentType: 'gpt-6-1-sol', model: 'gpt-6.1-sol@low' })
  const pick = b.logs.find(text => text.startsWith('ClaudeRipple worker pick: '))!
  expect(JSON.parse(pick.slice('ClaudeRipple worker pick: '.length))).toMatchObject({ level: 'light', rung: 'light', mode: 'Burn GPT' })
  // The band names the mode.
  const ui = await band($, 'desktop')
  expect(await ui.find({ type: 'Text', text: 'Burn GPT' })).toBeDefined()
})

test('with no mode on, nothing is attached and picks name none', async ($, on) => {
  const b = boundaries(on, { modes: BURN })
  http(on)
  judgeStub(on)
  spawnStub(on)
  await start($)
  await submit($)
  await $.agent.spawn(SPAWN)
  expect(b.contexts).toEqual([[]])
  expect(JSON.parse(b.logs.find(text => text.startsWith('ClaudeRipple worker pick: '))!.slice('ClaudeRipple worker pick: '.length)).mode).toBeUndefined()
})

test('a mode ends at its time and says so once; quick settings turn one on and off', async ($, on) => {
  const modes = normalizeModes([{ id: 'hour', name: 'One minute', targets: ['chatgpt'], until: NOW + 60_000 }, ...BURN])
  const b = boundaries(on, { modes, activeMode: 'hour', activeSince: NOW })
  http(on)
  await start($)
  await b.clock.advance(30_000)
  expect(b.router().settings.activeMode).toBe('hour')
  await b.clock.advance(40_000)
  expect(b.router().settings.activeMode).toBeUndefined()
  expect(b.router().settings.modes).toEqual(modes)
  expect(b.toasts.filter(text => text === 'The One minute mode has ended.').length).toBe(1)
  await b.clock.advance(9000)
  expect(b.toasts.filter(text => text === 'The One minute mode has ended.').length).toBe(1)
  // The quick settings' one mode control (the desktop's Mode tile, a drawn segment each): none,
  // then each mode.
  await command($, 'settings')
  const ui = await band($, 'desktop')
  const drawn = String((await ui.findAll({ type: 'Svg' })).map(svg => svg.props.alt).find(alt => String(alt).includes('Burn GPT')))
  for (const label of ['Base', 'One minute', 'Burn GPT']) expect(drawn, label).toContain(label)
  await ui.press({ key: 'mode-burn' })
  expect([b.router().settings.activeMode, b.router().settings.activeSince]).toEqual(['burn', NOW + 79_000])
  await ui.press({ key: 'mode-' })
  expect(Object.hasOwn(b.router().settings, 'activeMode')).toBe(false)
})

test('a mode ends at the first ChatGPT reset after activation', async ($, on) => {
  const modes = normalizeModes([{ id: 'burn', name: 'Burn GPT', rungs: { light: [{ target: { agent: 'gpt-6-astra' }, effort: 'high' }] }, until: { reset: 'chatgpt' } }])
  const b = boundaries(on, { modes, activeMode: 'burn', activeSince: NOW })
  const asked: string[] = []
  on('http.fetch', { url: /\/api\/chatgpt-accounts/ }, ($, e) => {
    asked.push(e.url)
    const accounts = [{ state: 'ready', quota: { at: NOW, rate_limits: { primary: { used_percent: 10, window_minutes: 300, reset_at: (NOW + 30_000) / 1000 }, secondary: { used_percent: 60, window_minutes: 10080, reset_at: (NOW + 150_000) / 1000 } } } }]
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ provider: 'chatgpt', accounts }) } }
  })
  http(on)
  await start($)
  await b.clock.advance(20_000)
  expect(b.router().settings.activeMode).toBe('burn')
  await b.clock.advance(20_000)
  expect(b.router().settings.activeMode).toBeUndefined()
  expect(b.toasts).toContain('The Burn GPT mode has ended.')
  // The quota is read at most once a minute, for the provider the target model belongs to.
  expect(asked.length).toBeLessThanOrEqual(4)
  expect(asked.every(url => url.endsWith('/api/chatgpt-accounts?provider=chatgpt'))).toBe(true)
})

for (const binding of ['five_hour', 'seven_day']) test('reset mode follows the band binding Claude limit: ' + binding, async ($, on) => {
  // A ChatGPT worker in the lists does not make ChatGPT's earlier reset end a Claude-reset mode.
  const rungs = { light: [{ target: { agent: 'gpt-6-astra' }, effort: 'high' }, { target: { agent: 'general-purpose', model: 'opus' }, effort: 'high' }] }
  const modes = normalizeModes([{ id: 'claude', name: 'Claude work', rungs, until: { reset: 'anthropic' } }])
  const limits = ['five_hour', 'seven_day'].map(kind => ({ kind, percentUsed: kind === binding ? 90 : 20, resetsAt: new Date(NOW + (kind === binding ? 30_000 : 10_000)).toISOString() }))
  const b = boundaries(on, { modes, activeMode: 'claude', activeSince: NOW }, { limits })
  const asked: string[] = []
  on('http.fetch', { url: /\/api\/chatgpt-accounts/ }, ($, e) => {
    asked.push(e.url)
    const accounts = [{ state: 'ready', quota: { at: NOW, rate_limits: { primary: { used_percent: 10, window_minutes: 300, reset_at: (NOW + 5_000) / 1000 } } } }]
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ provider: 'chatgpt', accounts }) } }
  })
  http(on)
  await start($)
  await b.clock.advance(20_000)
  expect(b.router().settings.activeMode).toBe('claude')
  await b.clock.advance(20_000)
  expect(b.router().settings.activeMode).toBeUndefined()
  expect(b.toasts.filter(text => text === 'The Claude work mode has ended.').length).toBe(1)
  expect(asked).toEqual([])
})

test('/ripple stats returns plain measured text', async ($, on) => {
  boundaries(on)
  const out = await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'stats' })
  expect(out.text).toContain('Auto: 0 prompts, 0 requests; 0 weighted tokens')
  expect(out.text).toContain('Workers: light 0, standard 0, deep 0, design 0')
})

for (const surface of ['terminal', 'desktop'] as const) test('quick controls save immediately on ' + surface + ' and Close keeps the changes', async ($, on) => {
  const b = boundaries(on)
  const urls = http(on)
  await start($)
  const ui = await band($, surface)
  expect(await ui.find({ type: 'Text', text: 'ClaudeRipple' })).toBeUndefined()
  await ui.press({ key: 'settings' })
  expect(await ui.find({ type: 'Text', text: 'Quick settings' })).toBeDefined()
  expect(await ui.find({ key: 'save' })).toBeUndefined()
  const puts = () => b.settingsRequests.filter(r => r.method === 'PUT').length
  let count = puts()
  await ui.press({ key: 'bias-2' })
  expect(b.router().settings.bias).toBe(2)
  expect(puts()).toBe(++count)
  await ui.press({ key: 'set-auto' })
  expect(b.router().settings.effortAuto).toBe(false)
  expect(puts()).toBe(++count)
  expect(await ui.find({ key: 'bias-2' })).toBeUndefined()
  await ui.press({ key: 'set-auto' })
  expect(b.router().settings.effortAuto).toBe(true)
  expect(puts()).toBe(++count)
  await ui.press({ key: 'judge-add-jev' })
  expect(b.router().settings.judges).toEqual([{ kind: 'haiku' }, { kind: 'jev' }])
  expect(puts()).toBe(++count)
  await ui.press({ key: 'judge-remove-haiku' })
  expect(b.router().settings.judges).toEqual([{ kind: 'jev' }])
  expect(puts()).toBe(++count)
  await ui.press({ key: 'set-warm' })
  expect(b.router().settings.keepWarm).toBe(true)
  expect(puts()).toBe(++count)
  await ui.press({ key: 'close' })
  expect(puts()).toBe(count)
  expect(b.router().settings).toMatchObject({ bias: 2, effortAuto: true, judges: [{ kind: 'jev' }], keepWarm: true })
  // Opening the panel reads the rung choices once, so a model ticked on the dashboard is offered.
  expect(urls.filter(url => url.endsWith('/api/mod-options')).length).toBe(1)
  await ui.press({ key: 'hide' })
  expect(b.saved.get('bandHidden')).toBe(true)
  await $.command.run({ command: 'ripple-bar', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: '' })
  expect(b.saved.get('bandHidden')).toBe(false)
  await ui.unmount()
})

test('ripple-bar says where the line is when the layout is minimal', async ($, on) => {
  const b = boundaries(on, { layout: 'minimal' })
  http(on)
  await start($)
  const run = () => $.command.run({ command: 'ripple-bar', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: '' })
  expect((await run()).text).toContain('hidden')
  expect(b.saved.get('bandHidden')).toBe(true)
  expect((await run()).text).toContain('Minimal')
})

for (const surface of ['terminal', 'desktop'] as const) test('quick settings select a saved mode, never edit rungs, on ' + surface, async ($, on) => {
  const b = boundaries(on, { modes: BURN })
  http(on)
  await start($)
  const ui = await band($, surface)
  await ui.press({ key: 'settings' })
  // The terminal's Select; the desktop's Mode tile, a drawn segment per mode.
  if (surface === 'desktop') {
    const modes = String((await ui.findAll({ type: 'Svg' })).map(svg => svg.props.alt).find(alt => String(alt).includes('Burn GPT')))
    for (const label of ['Base', 'Burn GPT']) expect(modes, label).toContain(label)
    for (const value of ['', 'burn']) expect(await ui.find({ type: 'Button', key: 'mode-' + value }), value).toBeDefined()
  } else {
    const control = await ui.find({ key: 'mode' })
    expect(control?.type).toBe('Select')
    expect((control?.props.options as { label: string }[]).map(o => o.label)).toEqual(['Base', 'Burn GPT'])
  }
  for (const rung of ['light', 'standard', 'hard', 'plan']) expect(await ui.find({ key: 'rung-' + rung })).toBeUndefined()
  const pick = (value: string) => surface === 'desktop' ? ui.press({ key: 'mode-' + value }) : ui.select({ key: 'mode', value })
  await pick('burn')
  expect(b.router().settings.activeMode).toBe('burn')
  expect(b.router().settings.rules).toEqual(DEFAULTS.rules)
  await pick('')
  expect(b.router().settings.activeMode).toBeUndefined()
  await ui.unmount()
})

test('quick settings show Base even before any mode is saved', async ($, on) => {
  boundaries(on)
  http(on)
  await start($)
  const ui = await band($)
  await ui.press({ key: 'settings' })
  const mode = await ui.find({ key: 'mode' })
  expect((mode?.props.options as { label: string }[]).map(o => o.label)).toEqual(['Base'])
  await ui.unmount()
})

for (const platform of ['Darwin', 'Windows_NT', 'Linux'] as const) test('all settings opens the mod dashboard on ' + platform, async ($, on) => {
  const b = boundaries(on, { language: 'en' }, { platform, env: platform === 'Windows_NT' ? { OS: 'Windows_NT' } : {} })
  http(on)
  await start($)
  await command($, 'settings')
  const ui = await band($)
  await ui.press({ key: 'all-settings' })
  const url = 'http://127.0.0.1:9992/#mod'
  const argv = platform === 'Darwin' ? ['open', url] : platform === 'Windows_NT' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url]
  expect(b.processes.map(p => p.argv)).toEqual(platform === 'Windows_NT' ? [argv] : [['uname', '-s'], argv])
  expect(b.toasts).toEqual([])
  expect(b.settingsRequests.filter(r => r.method === 'PUT').length).toBe(0)
  await ui.unmount()
})

for (const failure of ['exit', 'throw'] as const) test('a browser ' + failure + ' failure toasts the dashboard URL', async ($, on) => {
  const b = boundaries(on, { language: 'en' }, { platform: 'Darwin', browserFailure: failure })
  http(on)
  await start($)
  await command($, 'settings')
  const ui = await band($)
  await ui.press({ key: 'all-settings' })
  expect(b.toasts).toContain('http://127.0.0.1:9992/#mod')
  expect(b.logs.some(log => log.includes('open mod settings'))).toBe(true)
  await ui.unmount()
})

test('host survey wins; minimal layout renders through SessionMode', async ($, on) => {
  boundaries(on, { layout: 'minimal' })
  http(on)
  await start($)
  const survey = await band($, 'terminal', true)
  expect(await survey.find({ type: 'Text', text: 'host drawing' })).toBeDefined()
  await survey.unmount()
  const above = await band($)
  expect(await above.find({ key: 'auto' })).toBeUndefined()
  const footer = await $.ui.mount({ plugin: 'ripple', component: 'SessionMode', requestId: 'footer', surface: 'terminal', props: { modes: ['plan'] }, viewport: { columns: 140, rows: 40 } })
  expect(await footer.find({ key: 'auto' })).toBeDefined()
  expect(await footer.find({ type: 'Text', text: 'host drawing' })).toBeDefined()
})

test('log queries by session and reopening follows engine panes, not stale atoms', async ($, on) => {
  const b = boundaries(on)
  const urls = http(on)
  await start($)
  await $.command.run({ command: 'ripple-log', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: '' })
  expect(urls.some(url => url.includes('session=session-test'))).toBe(true)
  expect(b.panes.has('ripple-log')).toBe(true)
  b.panes.clear() // Host reload closed the pane without ui.close.
  await $.command.run({ command: 'ripple-log', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: '' })
  expect(b.panes.has('ripple-log')).toBe(true)
})

test('clear reloads router settings and resume restores cache age', async ($, on) => {
  const b = boundaries(on, { effortAuto: false })
  http(on)
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 120, prompt_cache_likely_expired: false, model: 'claude-opus-5-5' })
  const out = await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'debug' })
  expect(out.text).toContain('"lastReplyAt": 880000')
  await $.classic.SessionStart({ source: 'clear' })
  const ui = await band($)
  expect((await ui.find({ key: 'auto' }))?.props.label).toContain('○')
  expect(b.logs).toEqual([])
})

test('Save caps a high judge pick until the reported limit resets', async ($, on) => {
  const b = boundaries(on, {}, { limits: [{ kind: 'five_hour', percentUsed: 86, resetsAt: new Date(NOW + 60000).toISOString() }] })
  http(on)
  judgeStub(on, '{"effort":"max","sure":0.9,"why":"hard"}')
  const sent = stepStub(on)
  await start($)
  await b.clock.advance(1)
  await command($, 'save')
  await submit($)
  await step($)
  await complete($)
  await b.clock.advance(60000)
  await submit($)
  await step($)
  expect(sent.map(s => s.effort)).toEqual(['medium', 'max'])
})

test('an unsure Jev still decides: no Haiku call, no alert, key only to TypeSafe', async ($, on) => {
  const b = boundaries(on, { judges: [{ kind: 'jev' }, { kind: 'haiku' }] }, { key: 'test-secret' })
  const judges = judgeStub(on, '{"effort":"high","why":"fallback"}')
  const sent = stepStub(on)
  const destinations: string[] = []
  on('http.fetch', ($, e, next) => {
    if (e.url.endsWith('/api/mod-settings')) return next(e)
    if (e.init?.headers?.authorization) destinations.push(e.url)
    if (e.url === 'https://api.typesafe.ai/v1/systemone') {
      expect(e.init?.headers?.authorization).toBe('Bearer test-secret')
      const body = JSON.parse(e.init?.body ?? '{}')
      expect(body.questions.effort.type).toBe('choice')
      return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ answers: { effort: { choice: 'low', confidence: 0.2 } } }) } }
    }
    return { value: { ok: true, status: 200, headers: {}, text: '{"requests":[]}' } }
  })
  await start($)
  await submit($)
  await step($)
  expect(judges.length).toBe(0)
  // Torn at 0.2 with no odds given, the session keeps the effort it runs at.
  expect(sent[0]?.effort).toBe('medium')
  expect(destinations).toEqual(['https://api.typesafe.ai/v1/systemone'])
  // An unsure answer is not a judge failure: no toast, no alert card.
  expect(b.toasts).toEqual([])
  expect(await (await band($)).find({ type: 'Text', text: /not answering/ })).toBeUndefined()
})

test('Jev times out at five seconds without blocking the person prompt, and says so only the second time running', async ($, on) => {
  const b = boundaries(on, { judges: [{ kind: 'jev' }, { kind: 'haiku' }] }, { key: 'test-secret' })
  const judges = judgeStub(on, '{"effort":"medium","why":"fallback"}')
  on('http.fetch', async ($, e, next) => {
    if (e.url.endsWith('/api/mod-settings')) return next(e)
    if (e.url.includes('typesafe.ai')) await b.clock.sleep(6000)
    return { value: { ok: true, status: 200, headers: {}, text: '{"requests":[]}' } }
  })
  await start($)
  const pending = submit($)
  await b.clock.settle()
  await b.clock.advance(5000)
  const out = await pending
  expect(out.text).toContain('Implement')
  expect(judges.length).toBe(1)
  // One slow answer is a bad moment: Haiku covered it and nothing is said.
  expect(b.toasts.some(t => t.includes('timed out'))).toBe(false)
  const again = submit($, 'Refactor the parser across three files and verify.')
  await b.clock.settle()
  await b.clock.advance(5000)
  await again
  expect(b.toasts.some(t => t.includes('timed out'))).toBe(true)
})

test('a dropped Jev connection says it in plain words, and only the second time running', async ($, on) => {
  const b = boundaries(on, { judges: [{ kind: 'jev' }, { kind: 'haiku' }] }, { key: 'test-secret' })
  const judges = judgeStub(on, '{"effort":"medium","why":"fallback"}')
  on('http.fetch', ($, e, next) => {
    if (e.url.endsWith('/api/mod-settings')) return next(e)
    if (e.url.includes('typesafe.ai')) throw new Error('ripple: $.http.fetch(https://api.typesafe.ai/v1/systemone) failed: ECONNRESET: The socket connection was closed unexpectedly.')
    return { value: { ok: true, status: 200, headers: {}, text: '{"requests":[]}' } }
  })
  await start($)
  await submit($)
  expect(judges.length).toBe(1)
  expect(b.toasts).toEqual([])
  await submit($, 'Refactor the parser across three files and verify.')
  expect(b.toasts.some(t => t.includes('network unavailable'))).toBe(true)
  expect(b.toasts.some(t => t.includes('ECONNRESET'))).toBe(false)
  // The card blames the connection, not the judge.
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /connection is unsteady/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /not answering/ })).toBeUndefined()
})

test('router judge falls back and Haiku retries its alias when unanswered', async ($, on) => {
  boundaries(on, { judges: [{ kind: 'model', model: 'test-router-model' }, { kind: 'haiku' }] })
  http(on)
  const models: string[] = []
  on('model.complete', ($, e) => {
    models.push(e.model)
    return { value: e.model === 'haiku' ? { isAnswered: true, text: '{"effort":"low","why":"simple"}', usage: USAGE } : { isAnswered: false, reason: 'empty-reply', usage: USAGE } }
  })
  const sent = stepStub(on)
  await start($)
  await submit($)
  await step($)
  expect(models).toEqual(['test-router-model', 'claude-haiku-5-5', 'haiku'])
  expect(sent[0]?.effort).toBe('low')
})

// ---- Ordered judge chains: only the configured targets run, in order, until one answers ------------

const GOOD = '{"effort":"low","why":"simple"}'
function modelStub(on: On, answers: Record<string, string | undefined>) {
  const models: string[] = []
  on('model.complete', ($, e) => {
    models.push(e.model)
    const text = answers[e.model]
    return { value: text === undefined ? { isAnswered: false, reason: 'empty-reply', usage: USAGE } : { isAnswered: true, text, usage: USAGE } }
  })
  return models
}
function judgeDiagnostics(on: On) {
  let runs: JudgeRun[] = []
  let tested: JevState['test'] = { state: 'idle' }
  on('state.set', { plugin: 'ripple', key: 'judgeRuns' }, async ($, e, next) => {
    const result = await next(e)
    runs = e.value as JudgeRun[]
    return result
  })
  on('state.set', { plugin: 'ripple', key: 'jev' }, async ($, e, next) => {
    const result = await next(e)
    tested = (e.value as JevState).test
    return result
  })
  return { runs: () => runs, test: () => tested }
}
const SYNTHETIC_DIAGNOSTIC = 'SYNTHETIC'
for (const position of ['primary', 'secondary'] as const) for (const kind of ['model', 'haiku'] as const) test(`judge privacy: ${position} ${kind} api-error keeps only safe diagnostics`, async ($, on) => {
  const target: Settings['judges'][number] = kind === 'model' ? { kind, model: 'router-b' } : { kind }
  const preceding: Settings['judges'] = position === 'secondary' ? [{ kind: 'model', model: 'router-a' }] : []
  // The unreachable Jev entry keeps the existing missing-key Test control available.
  const b = boundaries(on, { judges: [...preceding, target, { kind: 'model', model: 'router-c' }, { kind: 'jev' }] })
  const diagnostics = judgeDiagnostics(on)
  http(on)
  const models: string[] = []
  on('model.complete', ($, e) => {
    models.push(e.model)
    if (e.model === 'router-a') return { value: { isAnswered: false, reason: 'empty-reply', usage: USAGE } }
    if (e.model === 'router-c') return { value: { isAnswered: true, text: '{"domain":"general","level":"light","effort":"low","why":"safe verdict"}', usage: USAGE } }
    // CLI 2.1.293 can return raw error text; 2.1.299 types promise categories instead.
    return { value: { isAnswered: false, reason: 'api-error', status: e.model === 'haiku' ? 429 : 503, error: SYNTHETIC_DIAGNOSTIC.repeat(1000) as ModelApiError, usage: USAGE } }
  })
  const steps = stepStub(on)
  const spawns = spawnStub(on)
  await start($)
  await submit($)
  await step($)
  await $.agent.spawn(SPAWN)
  expect(steps[0]?.effort).toBe('low')
  expect(spawns[0]).toMatchObject({ subagentType: 'deepseek-v4-1-flash', model: 'deepseek-v4.1-flash@max' })
  const safe = 'api-error (503)'
  const first = position === 'secondary' ? 'empty-reply' : safe
  const attempts = [...preceding.map(target => ({ target, ms: 0, error: 'empty-reply' })), { target, ms: 0, error: safe }, { target: { kind: 'model', model: 'router-c' }, ms: 0 }]
  const runs = diagnostics.runs()
  expect(runs.map(run => run.for)).toEqual(['prompt', 'worker'])
  expect(JSON.stringify(runs)).not.toContain(SYNTHETIC_DIAGNOSTIC)
  for (const run of runs) expect(run).toMatchObject({ by: 'model', error: first, attempts })
  const persisted = b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!
  expect(persisted).not.toContain(SYNTHETIC_DIAGNOSTIC)
  expect(JSON.parse(persisted)).toMatchObject({ by: 'judge', judge: 'model', error: first, attempts, verdict: { level: 'light' } })
  await command($, 'settings')
  const ui = await band($)
  await ui.press({ key: 'jev-test' })
  const tested = diagnostics.test()
  expect(tested).toMatchObject({ state: 'fail' })
  expect(tested?.message).toContain(first)
  expect(JSON.stringify(tested)).not.toContain(SYNTHETIC_DIAGNOSTIC)
  expect(JSON.stringify(await ui.findAll({ type: 'Text' }))).not.toContain(SYNTHETIC_DIAGNOSTIC)
  expect(b.toasts.join('\n')).toContain(first)
  expect(b.toasts.join('\n')).not.toContain(SYNTHETIC_DIAGNOSTIC)
  expect(b.logs.join('\n')).not.toContain(SYNTHETIC_DIAGNOSTIC)
  const oneRun = [...preceding.map(target => target.kind === 'model' ? target.model : target.kind), ...(kind === 'model' ? ['router-b'] : ['claude-haiku-5-5', 'haiku']), 'router-c']
  expect(models).toEqual([...oneRun, ...oneRun, ...oneRun])
  await ui.unmount()
})

for (const position of ['primary', 'secondary'] as const) test(`judge privacy: ${position} Jev HTTP 200 non-JSON never exposes the response body`, async ($, on) => {
  const preceding: Settings['judges'] = position === 'secondary' ? [{ kind: 'model', model: 'router-a' }] : []
  let keyAvailable = true
  const b = boundaries(on, { judges: [...preceding, { kind: 'jev' }, { kind: 'model', model: 'router-c' }] }, { envFile: () => keyAvailable ? 'TYPESAFE_API_KEY=test-secret' : '' })
  const diagnostics = judgeDiagnostics(on)
  on('http.fetch', { url: 'https://api.typesafe.ai/v1/systemone' }, () => ({ value: { ok: true, status: 200, headers: {}, text: SYNTHETIC_DIAGNOSTIC } }))
  http(on)
  const models = modelStub(on, { 'router-c': '{"domain":"general","level":"light","effort":"low","why":"safe verdict"}' })
  const steps = stepStub(on)
  const spawns = spawnStub(on)
  await start($)
  await submit($)
  await step($)
  await $.agent.spawn(SPAWN)
  expect(steps[0]?.effort).toBe('low')
  expect(spawns[0]?.subagentType).toBe('deepseek-v4-1-flash')
  const first = position === 'secondary' ? 'empty-reply' : 'invalid-response'
  const attempts = [...preceding.map(target => ({ target, ms: 0, error: 'empty-reply' })), { target: { kind: 'jev' }, ms: 0, error: 'invalid-response' }, { target: { kind: 'model', model: 'router-c' }, ms: 0 }]
  const runs = diagnostics.runs()
  expect(runs.map(run => run.for)).toEqual(['prompt', 'worker'])
  expect(JSON.stringify(runs)).not.toContain(SYNTHETIC_DIAGNOSTIC)
  for (const run of runs) expect(run).toMatchObject({ by: 'model', error: first, attempts })
  const persisted = b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!
  expect(persisted).not.toContain(SYNTHETIC_DIAGNOSTIC)
  expect(JSON.parse(persisted)).toMatchObject({ by: 'judge', judge: 'model', error: first, attempts })
  // Open Test while the key is missing, then supply the fixture key for that call.
  keyAvailable = false
  await command($, 'settings')
  const ui = await band($)
  keyAvailable = true
  await ui.press({ key: 'jev-test' })
  const tested = diagnostics.test()
  expect(tested).toMatchObject({ state: 'fail' })
  expect(tested?.message).toContain(first)
  expect(JSON.stringify(tested)).not.toContain(SYNTHETIC_DIAGNOSTIC)
  expect(JSON.stringify(await ui.findAll({ type: 'Text' }))).not.toContain(SYNTHETIC_DIAGNOSTIC)
  expect(b.toasts.join('\n')).toContain(first)
  expect(b.toasts.join('\n')).not.toContain(SYNTHETIC_DIAGNOSTIC)
  expect(b.logs.join('\n')).not.toContain(SYNTHETIC_DIAGNOSTIC)
  const oneRun = [...preceding.map(target => target.kind === 'model' ? target.model : target.kind), 'router-c']
  expect(models).toEqual([...oneRun, ...oneRun, ...oneRun])
  await ui.unmount()
})

test('judge privacy: an unreadable TypeSafe key still falls back to configured Zen without exposing the failure', async ($, on) => {
  const path = '/home/test/.config/jev/.env'
  let denied = false
  on('fs.read', { path }, ($, e, next) => denied ? { deny: SYNTHETIC_DIAGNOSTIC } : next(e))
  const config = { ...CONFIG, providers: { ...CONFIG.providers, 'opencode-zen': { headers: { authorization: 'Bearer zen-test' }, models: [{ id: 'jev-1.13' }] } } }
  const b = boundaries(on, { judges: [{ kind: 'jev' }], jevSource: 'typesafe' }, { config })
  b.files.set(path, 'TYPESAFE_API_KEY=test-secret')
  const diagnostics = judgeDiagnostics(on)
  const zen: { body?: string; headers?: Readonly<Record<string, string>> }[] = []
  http(on, false, config, input => { zen.push(input.init ?? {}) })
  const models = modelStub(on, {})
  const steps = stepStub(on)
  await start($)
  denied = true
  await submit($)
  await step($)
  expect(zen.length).toBe(1)
  expect(zen[0]?.headers?.authorization).toBe('Bearer zen-test')
  expect(JSON.parse(zen[0]?.body ?? '{}')).toMatchObject({ model: 'jev-1.13' })
  expect(models).toEqual([])
  expect(steps[0]?.effort).toBe('high')
  expect(diagnostics.runs()).toMatchObject([{ by: 'jev', effort: 'high', attempts: [{ target: { kind: 'jev' } }] }])
  expect(diagnostics.runs()[0]?.error).toBeUndefined()
  expect(JSON.stringify(diagnostics.runs())).not.toContain(SYNTHETIC_DIAGNOSTIC)
  expect(b.toasts.join('\n')).not.toContain(SYNTHETIC_DIAGNOSTIC)
  expect(b.logs.join('\n')).not.toContain(SYNTHETIC_DIAGNOSTIC)
})

for (const failure of ['config', 'file'] as const) test(`judge privacy: Jev ${failure} failure uses a fixed diagnostic and still falls back`, async ($, on) => {
  const path = '/home/test/.config/jev/.env'
  let denied = false
  on('fs.read', { path }, ($, e, next) => denied ? { deny: SYNTHETIC_DIAGNOSTIC } : next(e))
  const b = boundaries(on, { judges: [{ kind: 'jev' }, { kind: 'model', model: 'router-c' }], jevSource: failure === 'config' ? 'zen' : 'typesafe' })
  if (failure === 'file') b.files.set(path, 'TYPESAFE_API_KEY=test-secret')
  const diagnostics = judgeDiagnostics(on)
  http(on)
  const models = modelStub(on, { 'router-c': GOOD })
  const steps = stepStub(on)
  await start($)
  if (failure === 'config') b.files.set('/home/test/.clauderipple/config.json', SYNTHETIC_DIAGNOSTIC)
  else denied = true
  await submit($)
  await step($)
  expect(models).toEqual(['router-c'])
  expect(steps[0]?.effort).toBe('low')
  expect(diagnostics.runs()).toMatchObject([{ error: 'judge-failed', attempts: [{ target: { kind: 'jev' }, error: 'judge-failed' }, { target: { kind: 'model', model: 'router-c' } }] }])
  expect(JSON.stringify(diagnostics.runs())).not.toContain(SYNTHETIC_DIAGNOSTIC)
  expect(b.toasts.join('\n')).toContain('judge-failed')
  expect(b.toasts.join('\n')).not.toContain(SYNTHETIC_DIAGNOSTIC)
  expect(b.logs.join('\n')).not.toContain(SYNTHETIC_DIAGNOSTIC)
})

for (const [status, diagnostic] of [
  [200, 'Jev returned no verdict'],
  [401, 'Jev key rejected'],
  [402, 'Jev out of credits'],
  [403, 'Jev key rejected'],
  [429, 'Jev rate limited'],
  [503, 'Jev request failed (503)'],
] as const) test(`judge privacy: Jev preserves fixed guidance for HTTP ${status}`, async ($, on) => {
  const b = boundaries(on, { judges: [{ kind: 'jev' }, { kind: 'model', model: 'router-c' }] }, { key: 'test-secret' })
  const diagnostics = judgeDiagnostics(on)
  on('http.fetch', { url: 'https://api.typesafe.ai/v1/systemone' }, () => ({ value: { ok: status === 200, status, headers: {}, text: JSON.stringify({ echo: SYNTHETIC_DIAGNOSTIC }) } }))
  http(on)
  const models = modelStub(on, { 'router-c': GOOD })
  await start($)
  await submit($)
  expect(models).toEqual(['router-c'])
  expect(diagnostics.runs()).toMatchObject([{ error: diagnostic, attempts: [{ target: { kind: 'jev' }, error: diagnostic }, { target: { kind: 'model', model: 'router-c' } }] }])
  expect(JSON.stringify(diagnostics.runs())).not.toContain(SYNTHETIC_DIAGNOSTIC)
  expect(b.toasts.join('\n')).toContain(diagnostic)
  expect(b.toasts.join('\n')).not.toContain(SYNTHETIC_DIAGNOSTIC)
})

test('chain: Haiku fails (exact id and alias), then Jev answers; the run keeps both attempts and the first error', async ($, on) => {
  const b = boundaries(on, { judges: [{ kind: 'haiku' }, { kind: 'jev' }] }, { key: 'test-secret' })
  http(on, false, CONFIG, undefined, 'ok')
  const models = modelStub(on, {})
  const sent = stepStub(on)
  await start($)
  await submit($)
  await step($)
  expect(models).toEqual(['claude-haiku-5-5', 'haiku'])
  expect(sent[0]?.effort).toBe('high')
  const debug = await command($, 'stats')
  expect(debug.text).toContain('haiku 2, jev 1')
  expect(b.toasts.length).toBe(1)
})

test('chain: Jev fails on HTTP 500, then a router model answers; Haiku is never asked', async ($, on) => {
  boundaries(on, { judges: [{ kind: 'jev' }, { kind: 'model', model: 'router-a' }] }, { key: 'test-secret' })
  http(on, false, CONFIG, undefined, 'http500')
  const models = modelStub(on, { 'router-a': GOOD })
  const sent = stepStub(on)
  await start($)
  await submit($)
  await step($)
  expect(models).toEqual(['router-a'])
  expect(sent[0]?.effort).toBe('low')
})

test('chain: two different router models take turns; the first valid verdict stops the chain', async ($, on) => {
  boundaries(on, { judges: [{ kind: 'model', model: 'router-a' }, { kind: 'model', model: 'router-b' }, { kind: 'model', model: 'router-c' }] })
  http(on)
  const models = modelStub(on, { 'router-a': 'no json at all', 'router-b': GOOD, 'router-c': GOOD })
  const sent = stepStub(on)
  await start($)
  await submit($)
  await step($)
  expect(models).toEqual(['router-a', 'router-b'])
  expect(sent[0]?.effort).toBe('low')
  const stats = await command($, 'stats')
  expect(stats.text).toContain('model 2')
})

test('chain: a valid first verdict makes no further call', async ($, on) => {
  boundaries(on, { judges: [{ kind: 'model', model: 'router-a' }, { kind: 'haiku' }, { kind: 'jev' }] }, { key: 'test-secret' })
  const urls = http(on)
  const models = modelStub(on, { 'router-a': GOOD })
  stepStub(on)
  await start($)
  await submit($)
  expect(models).toEqual(['router-a'])
  expect(urls.some(url => url.includes('typesafe'))).toBe(false)
})

test('chain: an explicit list without Haiku never gets one; exhausted keeps the effort, and the toast does not promise Haiku', async ($, on) => {
  const b = boundaries(on, { judges: [{ kind: 'model', model: 'router-a' }, { kind: 'model', model: 'router-b' }] })
  http(on)
  const models = modelStub(on, {})
  const sent = stepStub(on)
  await start($)
  await submit($)
  await step($)
  expect(models).toEqual(['router-a', 'router-b'])
  expect(sent[0]?.effort).toBe('medium')
  expect(b.toasts.some(text => text.includes('Haiku'))).toBe(false)
})

test('chain: exhausted worker judge uses the default standard rung and logs every attempt without prompts', async ($, on) => {
  const b = boundaries(on, { judges: [{ kind: 'model', model: 'router-a' }, { kind: 'jev' }] })
  http(on, false, CONFIG, undefined, 'badjson')
  const models = modelStub(on, { 'router-a': undefined })
  const sent = spawnStub(on)
  await start($)
  await $.agent.spawn(SPAWN)
  expect(models).toEqual(['router-a'])
  expect(sent.length).toBe(1)
  const row = JSON.parse(b.files.get('/home/test/.clauderipple/logs/worker-picks.jsonl')!.trim())
  expect(row).toMatchObject({ by: 'default', judge: null, verdict: null })
  expect(row.attempts.map((a: { target: unknown }) => a.target)).toEqual([{ kind: 'model', model: 'router-a' }, { kind: 'jev' }])
  expect(row.attempts.every((a: { error?: string }) => typeof a.error === 'string')).toBe(true)
  expect(row.error).toBe(row.attempts[0].error)
  expect(JSON.stringify(row.attempts)).not.toContain('Rename')
})

test('chain: a missing Jev key, a dropped connection and malformed output each continue to the next target', async ($, on) => {
  boundaries(on, { judges: [{ kind: 'jev' }, { kind: 'model', model: 'router-a' }] })
  http(on)
  const models = modelStub(on, { 'router-a': GOOD })
  stepStub(on)
  await start($)
  await submit($)
  expect(models).toEqual(['router-a'])
})

test('chain: only a run that asked Jev moves its blip count', async ($, on) => {
  const b = boundaries(on, { judges: [{ kind: 'jev' }, { kind: 'model', model: 'router-a' }] }, { key: 'test-secret' })
  http(on, false, CONFIG, undefined, 'network')
  modelStub(on, { 'router-a': GOOD })
  stepStub(on)
  await start($)
  await submit($)
  expect(b.toasts).toEqual([])
  await submit($, 'Refactor the parser across three files and verify.')
  expect(b.toasts.some(text => text.includes('network unavailable'))).toBe(true)
})

test('chain: a different failing model is said again even when the reason text matches', async ($, on) => {
  const b = boundaries(on, { judges: [{ kind: 'model', model: 'router-a' }, { kind: 'haiku' }] })
  http(on)
  modelStub(on, { 'claude-haiku-5-5': GOOD })
  stepStub(on)
  await start($)
  await submit($)
  expect(b.toasts.length).toBe(1)
  expect(b.toasts[0]).toContain('router-a')
})

test('chain: Test stays strict when the primary failed though a later model answered', async ($, on) => {
  boundaries(on, { judges: [{ kind: 'jev' }, { kind: 'model', model: 'router-a' }] })
  http(on)
  const models = modelStub(on, { 'router-a': GOOD })
  await start($)
  await command($, 'settings')
  const ui = await band($)
  await ui.press({ key: 'jev-test' })
  expect(models).toEqual(['router-a'])
  expect(await ui.find({ type: 'Text', text: /· low · Jev key missing/ })).toBeDefined()
  await ui.unmount()
})

test('chain: the log pane names the model that failed and the one that answered', async ($, on) => {
  boundaries(on, { judges: [{ kind: 'model', model: 'router-a' }, { kind: 'model', model: 'router-b' }] })
  http(on)
  modelStub(on, { 'router-b': GOOD })
  stepStub(on)
  await start($)
  await submit($)
  await $.command.run({ command: 'ripple-log', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: '' })
  const ui = await $.ui.mount({ plugin: 'ripple', component: 'Pane', requestId: 'ripple-log', surface: 'terminal', props: { title: 'Log', isFocused: true, bodyColumns: 120, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} } })
  await ui.press({ key: 'scope' })
  expect(await ui.find({ type: 'Text', text: /router-a failed → router-b/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /router-a · .* · empty-reply/ })).toBeDefined()
  await ui.unmount()
})

test('Jev key input preserves other env lines and chmods the file 600', async ($, on) => {
  let readingForSave = false
  const b = boundaries(on, { judges: [{ kind: 'jev' }, { kind: 'haiku' }] }, { envFile: () => readingForSave ? 'OTHER=keep\nTYPESAFE_API_KEY=old\nTAIL=yes\n' : '' })
  http(on)
  const path = '/home/test/.config/jev/.env'
  await start($)
  await command($, 'settings')
  const ui = await band($)
  readingForSave = true
  await ui.input({ key: 'jev-key', text: 'new-$&-$$-key' })
  expect(await ui.find({ key: 'jev-key' })).toBeUndefined()
  expect(await ui.find({ key: 'jev-test' })).toBeUndefined()
  expect(b.files.get(path)).toBe('OTHER=keep\nTYPESAFE_API_KEY=new-$&-$$-key\nTAIL=yes\n')
  expect(b.processes.at(-1)?.argv).toEqual(['chmod', '600', path])
})

test('Jev Test displays latency and a missing-key result', async ($, on) => {
  boundaries(on, { judges: [{ kind: 'jev' }, { kind: 'haiku' }] })
  http(on)
  judgeStub(on, '{"effort":"low","why":"fallback"}')
  await start($)
  await command($, 'settings')
  const ui = await band($)
  await ui.press({ key: 'jev-test' })
  expect(await ui.find({ type: 'Text', text: /0 ms · low · Jev key missing/ })).toBeDefined()
  await ui.unmount()
})

test('known agents show waiting after an eight-second tool and finish with cost', async ($, on) => {
  const b = boundaries(on)
  http(on)
  judgeStub(on)
  spawnStub(on)
  stepStub(on)
  on('tool.call', async () => { await b.clock.sleep(30000); return { result: 'ok' } })
  await start($)
  await $.agent.spawn(SPAWN)
  await step($, 'deepseek-v4.1-flash@low', 'low', 'worker-1')
  const input: ToolCallInput = { tool: 'Bash', command: 'npm test', agentId: 'worker-1', tool_use_id: 'tool-long' }
  const tool = $.tool.call(input)
  await b.clock.settle()
  await b.clock.advance(15000)
  const ui = await $.ui.mount({ plugin: 'ripple', component: 'Pane', requestId: 'ripple-agents', surface: 'terminal', props: { title: 'Agents', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} } })
  expect(await ui.find({ type: 'Text', text: /waiting/ })).toBeDefined()
  await b.clock.advance(15000)
  await tool
  await complete($, 'worker-1')
  expect(await ui.find({ type: 'Text', text: 'Rename variable' })).toBeDefined()
  // The API's own counts (100 + 40000 cached in, 10 out), not the weighted cost.
  expect(await ui.find({ type: 'Text', text: 'in 40k · cache 100% · out 10 · tools 1' })).toBeDefined()
})

test('an agent keeps the API\'s token counts, its tools and the effort it was sent at; its card opens its conversation and goes back', async ($, on) => {
  const reads: string[] = []
  boundaries(on, {}, { agentMessages: id => {
    reads.push(id)
    return [{ role: 'user', text: 'Rename one local variable and verify it.', toolUses: [] }, { role: 'assistant', text: 'Renamed it.', toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'npm test' }, text: 'ok' }] }]
  } })
  http(on)
  judgeStub(on)
  spawnStub(on)
  stepStub(on, { input_tokens: 300, output_tokens: 50, cache_read_input_tokens: 9000, cache_creation_input_tokens: 700 })
  on('tool.call', () => ({ result: 'ok' }))
  let written: AgentRec[] = []
  on('state.set', { plugin: 'ripple', key: 'agents' }, async ($, e, next) => {
    const result = await next(e)
    written = e.value as AgentRec[]
    return result
  })
  await start($)
  await $.agent.spawn(SPAWN)
  // The routed id's @low is what the router sends, whatever the request's own effort says.
  await step($, 'deepseek-v4.1-flash@low', 'high', 'worker-1')
  await step($, 'deepseek-v4.1-flash@low', 'high', 'worker-1')
  const input: ToolCallInput = { tool: 'Bash', command: 'npm test', agentId: 'worker-1', tool_use_id: 'tool-a' }
  await $.tool.call(input)
  const rec = written.find(a => a.id === 'worker-1')
  expect(rec?.usage).toEqual({ input: 600, cached: 18_000, cacheWrite: 1400, output: 100 })
  expect(rec?.tools).toBe(1)
  expect(rec?.effort).toBe('low')
  expect(rec?.answeredBy).toBe('deepseek-v4.1-flash@low')
  expect(rec?.provider).toBe('deepseek')
  const ui = await $.ui.mount({ plugin: 'ripple', component: 'Pane', requestId: 'ripple-agents', surface: 'terminal', props: { title: 'Agents', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} } })
  expect(await ui.find({ type: 'Text', text: /in 20k · cache 90% · out 100 · tools 1/ })).toBeDefined()
  expect(reads).toEqual([])
  await ui.press({ key: 'open-worker-1' })
  expect(reads).toContain('worker-1')
  expect(await ui.find({ type: 'Text', text: 'Renamed it.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'npm test' })).toBeDefined()
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: 'Renamed it.' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'open-worker-1' })).toBeDefined()
})

test('an agent\'s run of tool calls unfolds on press, its paths short against the session folder, and folds again once the pane goes back', async ($, on) => {
  boundaries(on, {}, { agentMessages: () => [
    { role: 'user', text: 'Run the tests.', toolUses: [] },
    { role: 'assistant', text: 'Running.', toolUses: [
      { tool_use_id: 'c1', tool: 'Bash', input: { command: 'cd /work/android && ./gradlew test' }, text: 'ok' },
      { tool_use_id: 'c2', tool: 'Read', input: { file_path: '/work/core/A.kt' }, text: 'ok' },
    ] },
  ] })
  http(on)
  judgeStub(on)
  spawnStub(on)
  stepStub(on)
  const runs: unknown[] = []
  on('state.set', { plugin: 'ripple', key: 'agentRunsOpen' }, async ($, e, next) => {
    runs.push(e.value)
    return next(e)
  })
  await start($)
  await $.agent.spawn(SPAWN)
  const ui = await $.ui.mount({ plugin: 'ripple', component: 'Pane', requestId: 'ripple-agents', surface: 'terminal', props: { title: 'Agents', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} } })
  await ui.press({ key: 'open-worker-1' })
  expect(await ui.find({ type: 'Button', text: /^Ran 1 command, Read 1 file/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: './gradlew test' })).toBeUndefined()
  await ui.press({ key: 'run-c1' })
  expect(await ui.find({ type: 'Text', text: /^\.\/gradlew test$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^core\/A\.kt$/ })).toBeDefined()
  await ui.press({ key: 'run-c1' })
  expect(await ui.find({ type: 'Text', text: './gradlew test' })).toBeUndefined()
  await ui.press({ key: 'run-c1' })
  expect(runs.at(-1)).toEqual(['c1'])
  await ui.press({ key: 'back' })
  // Back on the list, the unfolded run is forgotten.
  expect(runs.at(-1)).toEqual([])
  await ui.press({ key: 'open-worker-1' })
  expect(await ui.find({ type: 'Text', text: './gradlew test' })).toBeUndefined()
})

/** The claude:// link a handoff opened, and its query. */
function opened(b: { processes: { argv: readonly string[] }[] }): URLSearchParams | undefined {
  const link = b.processes.map(p => p.argv.at(-1) ?? '').find(arg => arg.startsWith('claude://code/new?'))
  return link ? new URLSearchParams(link.slice('claude://code/new?'.length)) : undefined
}

// 2026-10-13: "Confirm first" cleared the chat at once (it only told the new chat to wait), and
// the owner lost the chat to it. A handoff now never clears: it opens a new session in the folder.
test('full handoff with Ask first stops on a card, then opens a new session in the folder without clearing', async ($, on) => {
  const b = boundaries(on, { handoffSkill: 'custom-handoff', handoffAfter: 'confirm' })
  http(on)
  const commands: string[] = []
  on('command.run', { command: 'custom-handoff' }, () => { commands.push('skill'); return {} })
  on('command.run', { command: 'clear' }, () => { commands.push('clear'); return {} })
  await start($)
  await command($, 'handoff full')
  await b.clock.advance(15000)
  expect(commands).toEqual(['skill'])
  await complete($, undefined, 'Saved /work/HANDOFF.md; verify the pending tests.')
  await b.clock.advance(15000)
  expect(opened(b)).toBeUndefined()
  const ui = await band($, 'desktop')
  expect(await ui.find({ type: 'Text', text: 'Handoff ready' })).toBeDefined()
  await ui.press({ key: 'open-new' })
  const query = opened(b)
  expect(query?.get('folder')).toBe('/work')
  expect(query?.get('q')).toContain('First read the saved handoff files')
  expect(query?.get('q')).toContain('verify the pending tests')
  expect(commands).toEqual(['skill'])
  // Nothing is sent here: the continuation waits in the new session's prompt box.
  expect(b.submitted).toEqual([])
})

test('quick handoff with New session now opens the new session at once, this chat kept', async ($, on) => {
  const b = boundaries(on, { handoffAfter: 'continue' })
  http(on)
  const commands: string[] = []
  on('command.run', { command: 'clear' }, () => { commands.push('clear'); return {} })
  on('model.fork', () => ({ value: { isAnswered: true, text: 'Resume: the band fix is half done.', usage: { input_tokens: 1, output_tokens: 1 } } }) as never)
  await start($)
  await command($, 'handoff')
  await b.clock.advance(15000)
  expect(opened(b)?.get('q')).toContain('the band fix is half done')
  expect(commands).toEqual([])
})

test('failed quick fork uses an ordinary summary turn and copy falls back to prompt fill', async ($, on) => {
  const b = boundaries(on, { handoffAfter: 'copy' })
  http(on)
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }))
  on('ui.copy', () => ({ value: { isCopied: false, reason: 'no-clipboard' } }))
  await start($)
  await command($, 'handoff')
  await b.clock.advance(15000)
  expect(b.submitted[0]).toContain('Prepare a concise resume note')
  await complete($, undefined, 'The pending work is in /work.')
  await b.clock.advance(15000)
  expect(b.filled[0]).toContain('The pending work is in /work.')
  expect(b.toasts.some(t => t.includes('clipboard unavailable'))).toBe(true)
})

test('a restored manual pick yields to the first app effort, but a fresh manual pick applies', async ($, on) => {
  const b = boundaries(on, { effortAuto: false })
  b.saved.set('pick', { effort: 'max', by: 'manual', why: 'old chat', at: 0 })
  http(on)
  const sent = stepStub(on)
  await start($)
  await step($, 'claude-opus-5-5', 'medium')
  expect(sent[0]?.effort).toBe('medium')
  await complete($)
  const ui = await band($)
  await ui.press({ key: 'effort' })
  await ui.press({ key: 'pick-high' })
  await step($, 'claude-opus-5-5', 'medium')
  expect(sent[1]?.effort).toBe('high')
})

test('first-run setup finishes once and keeps its saved choices', async ($, on) => {
  const b = boundaries(on, { setupDone: false })
  http(on)
  await start($)
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: 'Welcome to ClaudeRipple' })).toBeDefined()
  await ui.press({ key: 'next' })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'set-warm' })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'finish' })
  expect(b.router().settings).toMatchObject({ setupDone: true, keepWarm: true })
  expect(b.storeWrites).not.toContain('settings')
  expect(b.storeWrites).not.toContain('setupDone')
})

test('saving unrelated settings cannot revive stopped keep-warm; toggling it can', async ($, on) => {
  const b = boundaries(on, { keepWarm: true })
  http(on)
  stepStub(on)
  let forks = 0
  on('model.fork', () => { forks++; return { value: { isAnswered: false, reason: 'nothing-to-fork' } } })
  await start($)
  await step($)
  await complete($)
  await b.clock.advance(3375000)
  expect(forks).toBe(1)
  await command($, 'settings')
  const ui = await band($)
  await ui.press({ key: 'bias-1' })
  await b.clock.advance(15000)
  expect(forks).toBe(1)
  await command($, 'warm')
  await command($, 'warm')
  await b.clock.advance(15000)
  expect(forks).toBe(2)
})

test('Save caps an existing high pick without another judge and records sent effort', async ($, on) => {
  const b = boundaries(on, {}, { limits: [{ kind: 'five_hour', percentUsed: 86, resetsAt: new Date(NOW + 60000).toISOString() }] })
  http(on)
  judgeStub(on, '{"effort":"high","why":"scope"}')
  const sent = stepStub(on)
  await start($)
  await b.clock.advance(1)
  await submit($)
  await step($)
  await command($, 'save')
  await step($)
  expect(sent.map(s => s.effort)).toEqual(['high', 'medium'])
  expect((await command($, 'stats')).text).toContain('medium 0 prompts / 4150 weighted')
})

test('fork aggregate usage wins over the last step without main cost contamination', async ($, on) => {
  const b = boundaries(on, { handoffAfter: 'copy' })
  http(on)
  stepStub(on)
  on('model.fork', async () => {
    await step($)
    await step($)
    return { value: { isAnswered: true, text: 'Resume the verified work.', usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 80000, cache_creation_input_tokens: 0 } } }
  })
  on('ui.copy', () => ({ value: { isCopied: true } }))
  await start($)
  await command($, 'handoff')
  await b.clock.advance(15000)
  const out = await command($, 'stats')
  expect(out.text).toContain('Auto: 0 prompts, 0 requests')
  expect(out.text).toContain('Warm: 1 pings, 8300 weighted tokens')
})

test('handoff advice counts eligible prompts, not short followups', async ($, on) => {
  const b = boundaries(on, { effortAuto: false })
  b.setPercent(35)
  http(on)
  const calls = judgeStub(on, '{"handoff":"A different task starts now"}')
  await start($)
  await b.clock.advance(1)
  await submit($)
  await complete($)
  await submit($, 'go')
  await complete($)
  await b.clock.advance(15000)
  expect(calls.length).toBe(0)
  await submit($, 'Start the separate implementation task next.')
  await complete($)
  await b.clock.advance(15000)
  expect(calls.length).toBe(1)
  const ui = await band($)
  expect(await ui.find({ key: 'handoff' })).toBeDefined()
})

test('quick handoff runs on the timer and copies without clearing', async ($, on) => {
  const b = boundaries(on, { handoffAfter: 'copy' })
  http(on)
  let copied = ''
  let forks = 0
  on('model.fork', () => { forks++; return { value: { isAnswered: true, text: 'Pending: verify the changed files.', usage: USAGE } } })
  on('ui.copy', ($, e) => { copied = e.text; return { value: { isCopied: true } } })
  await start($)
  await $.command.run({ command: 'ripple', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 140 }, args: 'handoff' })
  expect(forks).toBe(0)
  await b.clock.advance(15000)
  expect(forks).toBe(1)
  expect(copied).toContain('Pending: verify the changed files.')
  expect(copied).toContain('Continue with the justified next action')
})

// ---- Regressions of 2026-10-10 (setup step 2, the band) ----------------------------------------

test('setup step 2 opens the dashboard; its draft preserves edits and follows remote worker settings', async ($, on) => {
  const b = boundaries(on, { setupDone: false })
  http(on)
  await start($)
  const ui = await band($)
  await ui.press({ key: 'judge-add-jev' })
  expect(b.settingsRequests.filter(r => r.method === 'PUT').length).toBe(0)
  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Text', text: 'Workers start on the ladder; set it up on the dashboard.' })).toBeDefined()
  await ui.press({ key: 'all-settings' })
  expect(b.processes.at(-1)?.argv).toEqual(['xdg-open', 'http://127.0.0.1:9992/#mod'])
  // Changes on the dashboard reach setup without replacing the person's judge edit.
  const general = DEFAULTS.rules.general
  const light = { target: { agent: 'general-purpose', model: 'haiku' }, effort: 'low' }
  b.remote({ settings: normalizeSettings({ setupDone: false, rules: { general: { ...general, rungs: { ...(general.mode === 'ladder' ? general.rungs : {}), light } } }, keepWarmHours: 8 }), revision: 2, stored: true })
  await b.clock.advance(3000)
  await ui.press({ key: 'next' })
  await ui.press({ key: 'set-warm' })
  await ui.press({ key: 'next' })
  expect(await ui.find({ type: 'Text', text: 'Claude Haiku · gpt-6-1-sol · gpt-6-astra · Claude Opus' })).toBeDefined()
  await ui.press({ key: 'finish' })
  expect(b.router().settings).toMatchObject({ judges: [{ kind: 'haiku' }, { kind: 'jev' }], keepWarm: true, keepWarmHours: 8, setupDone: true })
  const saved = b.router().settings.rules.general
  expect(saved.mode === 'ladder' && saved.rungs.light).toEqual([light])
  expect(b.settingsRequests.filter(r => r.method === 'PUT').map(r => r.revision)).toEqual([2])
  await ui.unmount()
})

test('a poll that finds nothing new writes no state, and the band draws the same pictures', async ($, on) => {
  const b = boundaries(on)
  http(on)
  const writes: string[] = []
  let counting = false
  on('state.set', { plugin: 'ripple' }, async ($, e, next) => { if (counting) writes.push(e.key); return next(e) })
  await start($)
  const ui = await band($, 'desktop')
  await b.clock.advance(3000)
  const before = JSON.stringify(await ui.drawn())
  counting = true
  await b.clock.advance(3000)
  await b.clock.advance(3000)
  expect(writes).toEqual([])
  expect(JSON.stringify(await ui.drawn())).toBe(before)
  await ui.unmount()
})

test('an idle band is asked again only when the minute it shows changes', async ($, on) => {
  // Each ask is a new answer the desktop draws afresh; idle, only the countdown may cause one.
  const b = boundaries(on)
  http(on)
  judgeStub(on)
  stepStub(on)
  const writes: string[] = []
  const invalidates: number[] = []
  let counting = false
  on('state.set', { plugin: 'ripple' }, async ($, e, next) => { if (counting) writes.push(e.key); return next(e) })
  on('ui.invalidate', ($, e, next) => { if (counting) invalidates.push(b.clock.now()); return next(e) })
  await start($)
  await submit($)
  await step($)
  await complete($)
  const replied = b.clock.now()
  const ui = await band($, 'desktop')
  await b.clock.advance(20_000)
  const before = JSON.stringify(await ui.drawn())
  expect(before).toMatch(/"\d+m"/)
  counting = true
  // Three minutes of polls (3 s) and ticks (15 s).
  for (let i = 0; i < 12; i++) await b.clock.advance(15_000)
  expect(writes).toEqual([])
  expect(invalidates).toEqual([replied + 60_000, replied + 120_000, replied + 180_000])
  const after = JSON.stringify(await ui.drawn())
  expect(after).not.toBe(before)
  // Only the countdown moved: its minutes (value and tip) and the clock of its share.
  const countdownless = (tree: string) => tree.replace(/"handle":\d+/g, '').replace(/\b\d+m\b/g, 'm').replace(/[●◕◑◔○]/g, 'o').replace(/"source":"(?:[^"\\]|\\.)*","alt":"Cache"/g, '"alt":"Cache"')
  expect(countdownless(after)).toBe(countdownless(before))
  await ui.unmount()
})

test('the judge says a failure once per reason, and Jev without a TypeSafe key asks Zen', async ($, on) => {
  const b = boundaries(on, { judges: [{ kind: 'jev' }, { kind: 'haiku' }] }, { config: { ...CONFIG, providers: { ...CONFIG.providers, 'opencode-zen': { headers: { authorization: 'zen-key' }, models: [{ id: 'jev-1.13' }] } } } })
  const sent: string[] = []
  http(on, false, { ...CONFIG, providers: { ...CONFIG.providers, 'opencode-zen': { headers: { authorization: 'zen-key' }, models: [{ id: 'jev-1.13' }] } } }, e => { sent.push(e.init?.headers?.authorization ?? '') })
  judgeStub(on)
  stepStub(on)
  await start($)
  await submit($)
  expect(sent).toEqual(['zen-key'])
  expect(b.toasts.filter(t => t.startsWith('Judge'))).toEqual([])
})

test('a judge failing for the same reason is said once in a session', async ($, on) => {
  const b = boundaries(on, { judges: [{ kind: 'jev' }, { kind: 'haiku' }] })
  http(on)
  judgeStub(on)
  stepStub(on)
  await start($)
  await submit($)
  await complete($)
  await submit($, 'Implement the next bounded change and verify the tests again.')
  expect(b.toasts.filter(text => text.includes('next configured judge')).length, JSON.stringify(b.toasts)).toBe(1)
})

// 2026-10-11: on the desktop a toggle was told only by dimness, which the host's hover undoes, so a
// click showed nothing. Each control must change what is drawn next, and a toggle's state must be in
// the drawing itself (the picture's own `on` / `off` on the desktop, ● / ○ on the terminal).
test('every band control changes the next drawing, and a toggle says its state outright', async ($, on) => {
  const b = boundaries(on)
  on('http.fetch', { url: /\/api\/requests/ }, () => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ requests: [{ at: '2026-10-10T13:19:10', source: 'gpt-6-1-sol@high', target: 'gpt-6.1-sol', provider: 'chatgpt', status: 200, ok: true, ms: 2140, session: 'session-test' }] }) } }))
  http(on)
  await start($)
  await b.clock.advance(3000)
  // The terminal says it in the label (● / ○); the desktop in the control's drawing: a lit icon,
  // a lit word, each picture marked `on` or `off` at its root.
  const desktopState = (n: unknown) => {
    const drawing = JSON.stringify(n ?? '')
    return /<svg[^>]* class=\\"on\\"/.test(drawing) ? 'on' : /<svg[^>]* class=\\"off\\"/.test(drawing) ? 'off' : 'other'
  }
  const state = async (ui: Awaited<ReturnType<typeof band>>, key: string, surface: string) =>
    surface === 'desktop'
      ? desktopState(await ui.find({ type: 'Box', key: key === 'auto' ? 'word-on-auto' : 'hv-' + key }) ?? await ui.find({ type: 'Box', key: 'ghost-' + key }))
      : (n => /●/.test(String(n?.props.label)) ? 'on' : /○/.test(String(n?.props.label)) ? 'off' : 'other')(await ui.find({ type: 'Button', key }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band($, surface)
    const drawn = async () => JSON.stringify(await ui.drawn()).replace(/"handle":\d+/g, '')
    for (const key of surface === 'terminal' ? ['auto', 'warm', 'log', 'agents'] : ['auto', 'warm', 'agents']) {
      const before = await state(ui, key, surface)
      expect(before, surface + ' ' + key).not.toBe('other')
      const tree = await drawn()
      await ui.press({ key })
      expect(await drawn(), surface + ' ' + key).not.toBe(tree)
      expect(await state(ui, key, surface), surface + ' ' + key).toBe(before === 'on' ? 'off' : 'on')
      await ui.press({ key })
      expect(await state(ui, key, surface), surface + ' ' + key + ' again').toBe(before)
    }
    // The effort opens its row of levels (the terminal's `e: Effort`, the desktop's level itself).
    expect(await ui.find({ key: 'pick-low' })).toBeUndefined()
    await ui.press({ key: 'effort' })
    expect(await ui.find({ type: 'Button', key: 'pick-low' }), surface).toBeDefined()
    await ui.press({ key: 'effort' })
    expect(await ui.find({ key: 'pick-low' })).toBeUndefined()
    if (surface === 'desktop') {
      // The route opens the log, shown as on at once.
      expect(await ui.find({ type: 'Text', text: 'gpt-6.1-sol' })).toBeDefined()
      await ui.press({ key: 'route' })
      expect(b.panes.has('ripple-log')).toBe(true)
      await ui.press({ key: 'route' })
      expect(b.panes.has('ripple-log')).toBe(false)
    }
    await ui.unmount()
  }
})

// 2026-10-14: the band's Clear icon asks before it runs /clear; Cancel leaves the chat alone.
test('the band Clear asks first, and confirming runs the clear once', async ($, on) => {
  const b = boundaries(on)
  http(on)
  const commands: string[] = []
  on('command.run', { command: 'clear' }, () => { commands.push('clear'); return {} })
  await start($)
  const ui = await band($, 'desktop')
  expect(await ui.find({ key: 'clear' })).toBeDefined()
  await ui.press({ key: 'clear' })
  expect(commands).toEqual([])
  expect(await ui.find({ type: 'Text', text: 'Start this conversation over?' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /context is emptied/ })).toBeDefined()
  // Cancel keeps the conversation and closes the card.
  await ui.press({ key: 'dismiss' })
  expect(commands).toEqual([])
  expect(await ui.find({ type: 'Text', text: 'Start this conversation over?' })).toBeUndefined()
  // The main action runs the clear once.
  await ui.press({ key: 'clear' })
  await ui.press({ key: 'clear-go' })
  await b.clock.advance(3000)
  expect(commands).toEqual(['clear'])
  expect(await ui.find({ type: 'Text', text: 'Start this conversation over?' })).toBeUndefined()
  await ui.unmount()
})

// The host keeps what the phone queued (packages/remote/src/queue.ts); the band reads its file and
// floats a strip over itself while this chat has something waiting, then lets it go.
for (const surface of ['terminal', 'desktop'] as const) test(`the phone queue strip shows over the ${surface} band only while this chat has something queued`, async ($, on) => {
  const b = boundaries(on)
  http(on)
  const file = '/home/test/.clauderipple/remote/queue.json'
  b.files.set(file, JSON.stringify({ other: { items: [{ id: 'x', text: 'not this chat', attachments: [], at: 1 }], held: false } }))
  await start($)
  const ui = await band($, surface)
  await b.clock.advance(3000)
  expect(JSON.stringify(await ui.drawn())).not.toContain('Phone queue')
  b.files.set(file, JSON.stringify({ phone: { desktopId: 'session-test', items: [{ id: 'a', text: 'fix the header', attachments: [], at: 1 }, { id: 'b', text: 'then the footer', attachments: [], at: 2 }], held: false } }))
  await b.clock.advance(3000)
  const shown = JSON.stringify(await ui.drawn())
  expect(shown).toContain('Phone queue 2')
  expect(shown).toContain('fix the header')
  b.files.set(file, JSON.stringify({}))
  await b.clock.advance(3000)
  expect(JSON.stringify(await ui.drawn())).not.toContain('Phone queue')
  await ui.unmount()
})
