import { expect, test } from 'claude-code/testing'
import type { RenderElement, RenderPropsOf } from 'claude-code'
import { renderBand, renderFooter } from '../hooks/ui/band'
import type { BandActions, DashboardView, Frame } from '../hooks/ui/view'

const noop = () => undefined
const actions: BandActions = { toggleAuto: noop, toggleWarm: noop, compact: noop, clear: noop, handoff: noop, toggleLog: noop, toggleAgents: noop, openSettings: noop, toggleEffortMenu: noop, pickEffort: noop }
const view: DashboardView = {
  effort: { level: 'high', mode: 'auto' }, model: 'Opus', context: null, cache: null,
  warm: { on: false, pings: 0, cost: 0 }, limit: null, route: null, notice: null,
  auto: true, agents: { live: 0, total: 0 }, compactions: 0,
  logOpen: false, agentsOpen: false, effortMenu: false, hide: [], extras: [], isWorking: false,
}
const props: RenderPropsOf['Pane'] = { title: 'pin', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} } as RenderPropsOf['Pane']

test('pin line and one-press release appear only while pinned in band and minimal footer', async ($, on) => {
  let releases = 0
  on('ui.render', { component: 'Pane' }, ($, e) => {
    const pinned = e.requestId?.includes('pinned')
    const frame: Frame = { surface: e.surface, columns: 100, maxRows: 12, now: 0, appearance: 'auto', skin: 'deep', lang: 'ko' }
    const state = { ...view, ...(pinned ? { delegationPin: 'Sol' } : {}) }
    const controls = { ...actions, releaseDelegationPin: () => { releases++ } }
    return (e.requestId?.includes('footer') ? renderFooter($.ui.resolve(e), frame, state, controls) : renderBand($.ui.resolve(e), frame, state, controls)) as RenderElement
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const layout of ['band', 'footer']) {
      for (const pinned of [false, true]) {
        const ui = await $.ui.mount({ plugin: 'test', surface, component: 'Pane', requestId: layout + (pinned ? '-pinned' : '-base'), props, viewport: { columns: 100, rows: 40 } })
        expect(!!await ui.find({ type: 'Text', text: /위임 고정: / })).toBe(pinned)
        expect(!!await ui.find({ type: 'Button', key: 'release-pin' })).toBe(pinned)
        if (pinned) await ui.press({ key: 'release-pin' })
        await ui.unmount()
      }
    }
  }
  expect(releases).toBe(4)
})

test('the pin line says the name and the sentence that pinned it, and drops the sentence when the band is narrow', async ($, on) => {
  on('ui.render', { component: 'Pane' }, ($, e) => {
    const columns = e.requestId?.includes('narrow') ? 36 : 100
    const state = { ...view, delegationPin: 'Sol', ...(e.requestId?.includes('said') ? { delegationSaid: '앞으로 솔로 해' } : {}) }
    return renderBand($.ui.resolve(e), { surface: e.surface, columns, maxRows: 12, now: 0, appearance: 'auto', skin: 'deep', lang: 'ko' }, state, { ...actions, releaseDelegationPin: noop }) as RenderElement
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const [id, columns, reason] of [['said', 100, /앞으로 솔로 해”라고 말씀하셔서/], ['plain', 100, /이 세션이 끝날 때까지/], ['said-narrow', 36, undefined]] as const) {
      const ui = await $.ui.mount({ plugin: 'test', surface, component: 'Pane', requestId: id, props, viewport: { columns, rows: 40 } })
      expect(await ui.find({ type: 'Text', text: /위임 고정: / })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Sol' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'release-pin' })).toBeDefined()
      if (reason) expect(await ui.find({ type: 'Text', text: reason })).toBeDefined()
      else expect(await ui.find({ type: 'Text', text: /말씀하셔서|끝날 때까지/ })).toBeUndefined()
      await ui.unmount()
    }
  }
})

test('on the desktop the pin line is the capsule\'s own first row, so nothing floats outside the band', async ($, on) => {
  on('ui.render', { component: 'Pane' }, ($, e) => renderBand($.ui.resolve(e), { surface: e.surface, columns: 100, maxRows: 12, now: 0, appearance: 'auto', skin: 'deep', lang: 'ko' }, { ...view, delegationPin: 'Sol', delegationSaid: '앞으로 솔로 해' }, actions) as RenderElement)
  const ui = await $.ui.mount({ plugin: 'test', surface: 'desktop', component: 'Pane', requestId: 'pin', props, viewport: { columns: 100, rows: 40 } })
  type N = { props?: Record<string, unknown>; children?: unknown[] }
  const find = (value: unknown, key: string, inside = false): { found: boolean; inside: boolean } => {
    if (!value || typeof value !== 'object') return { found: false, inside: false }
    if (Array.isArray(value)) { for (const child of value) { const r = find(child, key, inside); if (r.found) return r } return { found: false, inside: false } }
    const node = value as N
    if (node.props?.key === key) return { found: true, inside }
    for (const child of node.children ?? []) { const r = find(child, key, inside || node.props?.key === 'band'); if (r.found) return r }
    return { found: false, inside: false }
  }
  expect(find(await ui.drawn(), 'delegation-pin')).toEqual({ found: true, inside: true })
  await ui.unmount()
})
