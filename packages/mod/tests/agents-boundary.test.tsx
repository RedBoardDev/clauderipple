import { expect, mock, test } from 'claude-code/testing'
import type { RenderElement, RenderPropsOf } from 'claude-code'
import type { AgentRec } from '../types'
import { normalizeSettings } from '../hooks/settings'
import { renderAgents } from '../hooks/ui/agents'
import type { Frame } from '../hooks/ui/view'

const NOW = 1_000_000
const SETTINGS = normalizeSettings({ setupDone: true, language: 'ko' })
const PROPS: RenderPropsOf['Pane'] = { title: '리플 에이전트', isFocused: true, bodyColumns: 40, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} }
const FRAME: Frame = { surface: 'desktop', columns: 40, maxRows: 30, now: NOW, lang: 'ko', skin: 'deep', appearance: 'auto' }
const ACTIONS = { open: () => {}, back: () => {}, toggleDone: () => {}, toggleRun: () => {} }
const RECORDS: AgentRec[] = Array.from({ length: 48 }, (_, i) => ({
  id: 'worker-' + i, description: '워크트리 격리 · SendMessage 재개 검토 ' + i + ' 긴 한국어 설명'.repeat(200),
  type: i < 31 ? 'ripple:auto' : 'general-purpose', model: i % 2 ? 'gpt-6.1-sol@high' : 'deepseek-v4.1-flash@max',
  provider: i % 2 ? 'chatgpt' : 'deepseek', state: i < 31 ? 'running' : 'done', startedAt: 1, endedAt: NOW - i,
  cost: 0, tools: 500, effort: 'high', usage: { input: 100_000, cached: 999_999, cacheWrite: 10_000, output: 50_000 },
}))

test('agents fallback survives an unavailable settings boundary and recovers on the next render', async ($, on) => {
  mock.clock(on, { now: NOW })
  let unavailable = true
  let selected: string | null = RECORDS[0]!.id
  let closed = 0
  const settings = { value: SETTINGS, version: 0 }
  on('state.get', { plugin: 'ripple', key: 'settings' }, () => unavailable ? { deny: 'settings unavailable' } : { value: settings })
  on('state.get', { plugin: 'ripple', key: 'lang' }, () => ({ value: { value: 'ko', version: 0 } }))
  on('state.get', { plugin: 'ripple', key: 'agents' }, () => ({ value: { value: RECORDS, version: 0 } }))
  on('state.get', { plugin: 'ripple', key: 'agentOpen' }, () => ({ value: { value: selected, version: 0 } }))
  on('session.messages', () => ({ value: { deny: '대화 기록을 읽을 수 없습니다.' } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.close', () => { closed++; return { value: undefined } })
  for (const surface of ['desktop', 'terminal'] as const) {
    unavailable = true
    selected = RECORDS[0]!.id
    const failed = await $.ui.mount({ plugin: 'ripple', surface, component: 'Pane', requestId: 'ripple-agents', props: PROPS })
    expect(await failed.find({ type: 'Text', text: 'settings unavailable' })).toBeDefined()
    expect(await failed.find({ type: 'Text', text: '검토 47' })).toBeDefined()
    expect(await failed.findAll({ type: 'Svg' })).toHaveLength(0)
    await failed.press({ key: 'close' })
    await failed.unmount()
    unavailable = false
    selected = null
    const recovered = await $.ui.mount({ plugin: 'ripple', surface, component: 'Pane', requestId: 'ripple-agents', props: PROPS })
    // The desktop's row keeps its title to one line, as the Claude app's task list does.
    expect(await recovered.find({ type: 'Text', text: '검토 0' }) ?? await recovered.find({ key: 'row-' + RECORDS[0]!.id })).toBeDefined()
    expect(await recovered.find({ key: 'close' })).toBeUndefined()
    await recovered.unmount()
  }
  expect(closed).toBe(2)
})

test('48 workers with long fallback reasons and an unfolded short-call conversation validate on every surface', async ($, on) => {
  const fallback: NonNullable<AgentRec['pick']> = { domain: 'general', level: 'standard', effort: 'high', by: 'session', why: '', target: { agent: 'general-purpose' }, rule: 'general', ms: 0, fallbackReason: '사용 한도를 초과했습니다. '.repeat(1000) }
  const records = RECORDS.map(a => ({ ...a, pick: fallback }))
  const entries = Array.from({ length: 1800 }, (_, i) => ({ kind: 'tool' as const, id: 't' + i, tool: 'Bash', detail: 'pwd', state: 'ok' as const }))
  on('ui.render', { component: 'Pane', requestId: 'bounded-list' }, ($, e) => renderAgents($.ui.resolve(e), { ...FRAME, surface: e.surface }, { agents: records, now: NOW, showDone: true }, ACTIONS) as RenderElement)
  on('ui.render', { component: 'Pane', requestId: 'bounded-talk' }, ($, e) => renderAgents($.ui.resolve(e), { ...FRAME, surface: e.surface }, { agents: records, now: NOW, showDone: true, open: { id: records[0]!.id, talk: { entries }, runsOpen: ['t0', 't1288'] } }, ACTIONS) as RenderElement)
  for (const surface of ['desktop', 'terminal', 'vscode', 'mobile'] as const) {
    const list = await $.ui.mount({ plugin: 'test', surface, component: 'Pane', requestId: 'bounded-list', props: PROPS })
    expect(await list.find({ type: 'Text', text: '검토 47' }) ?? await list.find({ key: 'row-worker-47' }), surface + ' last list card').toBeDefined()
    expect((await list.findAll({ type: 'Button' })).length < 2000).toBe(true)
    for (const svg of await list.findAll({ type: 'Svg' })) {
      expect(Number(svg.props.width) <= 4096 && Number(svg.props.height) <= 4096).toBe(true)
      expect(String(svg.props.source).length <= 131_072).toBe(true)
    }
    await list.unmount()
    const talk = await $.ui.mount({ plugin: 'test', surface, component: 'Pane', requestId: 'bounded-talk', props: PROPS })
    expect(await talk.find({ key: 'tool-t1799' }), surface + ' last talk call').toBeDefined()
    expect(await talk.find({ key: 'tool-t0' })).toBeUndefined()
    await talk.unmount()
  }
})
