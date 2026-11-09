import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf, SessionMessage, SessionReceiveInput } from 'claude-code'
import type { AgentRec } from '../types'
import { normalizeSettings } from '../hooks/settings'

const PROPS: RenderPropsOf['Pane'] = { title: 'Agents', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} }
const ROWS: SessionMessage[] = [{ role: 'user', text: 'Initial brief', toolUses: [] }, { role: 'assistant', text: 'Before instruction', toolUses: [] }]
const AGENTS: AgentRec[] = ['a', 'b'].map(id => ({ id, description: id, state: 'running', startedAt: 0, cost: 0 }))

function boundaries(on: On) {
  mock.clock(on, { now: 1000 })
  let rows = [...ROWS]
  let agents = AGENTS.map(a => ({ ...a }))
  let version = 0
  let failWrite = false
  let pause: { entered: () => void; wait: Promise<void> } | undefined
  on('state.get', { plugin: 'ripple', key: 'settings' }, () => ({ value: { value: normalizeSettings({ setupDone: true, language: 'en' }), version: 0 } }))
  on('state.get', { plugin: 'ripple', key: 'lang' }, () => ({ value: { value: 'en', version: 0 } }))
  on('state.get', { plugin: 'ripple', key: 'agentOpen' }, () => ({ value: { value: 'a', version: 0 } }))
  on('state.get', { plugin: 'ripple', key: 'agents' }, () => ({ value: { value: agents, version } }))
  on('state.set', { plugin: 'ripple', key: 'agents' }, ($, e) => {
    if (failWrite) return { deny: 'agent state unavailable' }
    agents = e.value
    return { value: { isSet: true, version: ++version } }
  })
  let fail = false
  let failLog = false
  const passed: SessionReceiveInput[] = []
  const logs: string[] = []
  on('session.messages', async () => {
    if (fail) throw new Error('transcript unavailable')
    const snapshot = rows
    if (pause) { pause.entered(); await pause.wait }
    return { value: snapshot }
  })
  on('session.receive', ($, e) => { passed.push(e); return { text: e.text } })
  on('session.cwd', () => ({ value: '/work' }))
  on('env.get', () => ({ value: '/home/test' }))
  on('ui.log', ($, e) => { if (failLog) throw new Error('logger unavailable'); logs.push(e.text); return { value: undefined } })
  on('ui.scroll', () => ({ deny: 'no scroll in test' }))
  on('ui.view', () => ({ value: {} }))
  on('classic.SessionStart', () => ({}))
  on('http.fetch', () => ({ value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ settings: normalizeSettings({ setupDone: true }), revision: 1, stored: true }) } }))
  return { passed, logs, records: () => agents, remove: (id: string) => { agents = agents.filter(a => a.id !== id); version++ }, rows: (value: SessionMessage[]) => { rows = value }, fail: (value: boolean, log = false) => { fail = value; failLog = log }, failWrite: (value: boolean) => { failWrite = value },
    hold: () => {
      let entered!: () => void
      let release!: () => void
      const started = new Promise<void>(resolve => { entered = resolve })
      const wait = new Promise<void>(resolve => { release = resolve })
      pause = { entered, wait }
      return { started, release: () => { pause = undefined; release() } }
    },
  }
}
/** The receipt is recorded after the message has gone on; let that recording finish. */
async function settle(): Promise<void> {
  // The mod's types carry no timer globals; the test runtime has them.
  const later = (globalThis as unknown as { setTimeout: (done: () => void, ms: number) => void }).setTimeout
  for (let i = 0; i < 10; i++) await new Promise<void>(resolve => later(resolve, 0))
}
async function receive($: Engine, text: string, agentId = 'a', kind: 'coordinator' | 'peer' | 'task-notification' = 'coordinator') {
  const origin: SessionReceiveInput['origin'] = kind === 'task-notification' ? { kind } : { kind }
  const result = await $.session.receive({ text, origin, agentId })
  await settle()
  return result
}

test('coordinator instructions appear between receipt-time rows on desktop and terminal, without truncation', async ($, on) => {
  const b = boundaries(on)
  const long = '  Full instruction\n' + '계속 확인해 주세요. '.repeat(1100) + '\nEND  '
  await receive($, long)
  b.rows([...ROWS, { role: 'assistant', text: 'Between instructions', toolUses: [] }])
  await receive($, 'Second instruction')
  b.rows([...ROWS, { role: 'assistant', text: 'Between instructions', toolUses: [] }, { role: 'assistant', text: 'After instructions', toolUses: [] }])
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'ripple', component: 'Pane', requestId: 'ripple-agents', surface, props: PROPS })
    const nodes = await ui.findAll({ type: surface === 'desktop' ? 'Markdown' : 'Text' })
    const texts = nodes.map(node => surface === 'desktop' ? node.props.text : node.children?.join(''))
    const ordered = ['Initial brief', 'Before instruction', long, 'Between instructions', 'Second instruction', 'After instructions']
    const positions = ordered.map(text => texts.indexOf(text))
    expect(positions.every((at, i) => at >= 0 && (i === 0 || at > positions[i - 1]!))).toBe(true)
    if (surface === 'desktop') {
      expect(await ui.find({ key: 'receipt:1-more' })).toBeDefined()
      await ui.press({ key: 'receipt:1-more' })
      expect((await ui.find({ key: 'receipt:1-text' }))?.props.text).toBe(long)
    }
    await ui.unmount()
  }
  expect(b.passed.map(e => e.text)).toEqual([long, 'Second instruction'])
})

test('only coordinator deliveries to the selected agent enter its conversation', async ($, on) => {
  const b = boundaries(on)
  await receive($, 'Peer metadata', 'a', 'peer')
  await receive($, 'Task metadata', 'a', 'task-notification')
  await $.session.receive({ text: 'Main metadata', origin: { kind: 'coordinator' } })
  await receive($, 'Other agent instruction', 'b')
  await receive($, 'Own instruction')
  const saved = b.records()
  expect(saved?.find(a => a.id === 'a')?.instructions?.map(i => i.text)).toEqual(['Own instruction'])
  expect(saved?.find(a => a.id === 'b')?.instructions?.map(i => i.text)).toEqual(['Other agent instruction'])
  const ui = await $.ui.mount({ plugin: 'ripple', component: 'Pane', requestId: 'ripple-agents', surface: 'desktop', props: PROPS })
  expect(await ui.find({ type: 'Markdown', text: 'Own instruction' })).toBeDefined()
  for (const text of ['Peer metadata', 'Task metadata', 'Main metadata', 'Other agent instruction']) expect(await ui.find({ type: 'Markdown', text })).toBeUndefined()
  expect(b.passed.length).toBe(5)
})

test('receive passes the unchanged event exactly once even when transcript and diagnostic logging throw', async ($, on) => {
  const b = boundaries(on)
  for (const failLog of [false, true]) {
    b.fail(true, failLog)
    const event: SessionReceiveInput = { text: 'Do not lose this', agentId: 'a', origin: { kind: 'coordinator' } }
    expect(await $.session.receive(event)).toEqual({ text: event.text })
    expect(b.passed.at(-1)).toEqual(event)
    await settle()
  }
  expect(b.passed.length).toBe(2)
  expect(b.logs.length > 0).toBe(true)
  b.fail(false)
  await receive($, 'Recovered instruction')
  expect((b.records())?.[0]?.instructions?.map(i => i.text)).toEqual(['Recovered instruction'])
})

test('a denied receipt state write still queues the original instruction and the next receive recovers', async ($, on) => {
  const b = boundaries(on)
  b.failWrite(true)
  expect(await receive($, 'State failure instruction')).toEqual({ text: 'State failure instruction' })
  expect(b.records()[0]?.instructions).toBeUndefined()
  b.failWrite(false)
  await receive($, 'State recovered')
  expect(b.passed.map(e => e.text)).toEqual(['State failure instruction', 'State recovered'])
  expect(b.records()[0]?.instructions?.map(i => i.text)).toEqual(['State recovered'])
})

test('a receipt waiting on the transcript neither holds back its delivery nor lands after a clear', async ($, on) => {
  const b = boundaries(on)
  const held = b.hold()
  // Delivered while the transcript read is still held: the message never waits for the record.
  expect(await $.session.receive({ text: 'Before clear', origin: { kind: 'coordinator' }, agentId: 'a' })).toEqual({ text: 'Before clear' })
  expect(b.passed.length).toBe(1)
  await held.started
  await $.classic.SessionStart({ source: 'clear' })
  held.release()
  await settle()
  expect(b.records().map(a => a.id)).toEqual(['a', 'b'])
  expect(b.records()[0]?.instructions).toBeUndefined()
})

test('receipts keep the newest twenty in order and disappear with their agent', async ($, on) => {
  const b = boundaries(on)
  await Promise.all(Array.from({ length: 23 }, (_, i) => receive($, 'Instruction ' + i)))
  await settle()
  const instructions = (b.records())?.[0]?.instructions
  expect(instructions?.map(i => i.text)).toEqual(Array.from({ length: 20 }, (_, i) => 'Instruction ' + (i + 3)))
  expect(instructions?.every(i => i.after === 2)).toBe(true)
  b.remove('a')
  await receive($, 'Removed agent must not reappear')
  expect((b.records())?.map(a => a.id)).toEqual(['b'])
})
