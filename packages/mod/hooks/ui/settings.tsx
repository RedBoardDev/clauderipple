// Quick settings in the band. Each control applies immediately; the router dashboard owns
// the full settings page. Setup reuses the judge and keep-warm controls below.
//
// The terminal draws 리플이's column (parts.tsx `speak`): one row per setting, its options as ●/○
// words, then the way out to the dashboard. The desktop draws a capsule of the deep (kit.tsx): 리플이
// at the head saying in one line what the settings do right now, the two ways out (all settings,
// close) as drawn buttons at the top right, and four tiles, each a setting with its own picture of
// how it stands and its control right there, so nothing is a tab away.

import { t } from '../i18n'
import type { RenderNode } from 'claude-code'

import type { Settings, Skin } from '../../types'
import { SKINS } from '../settings'
import { DISPLAY, displayText } from './display'
import { CELL_PX, TILE_PX } from './art'
import type { TileArt } from './art'
import { capsule, pill, pic, ripple, segmented, slider, toggle, well } from './kit'
import { lookOf } from './look'
import type { Word } from './look'
import { action, actions, canDraw, dismiss, segmented as textSegmented, speak, toggle as textToggle } from './parts'
import type { Els } from './parts'
import { chOf, displayWidth, textTone } from './theme'
import type { Frame, SettingsActions, SettingsView } from './view'
import { isRich } from './view'

/** Every name a row of quick settings or setup shows: the name column is the widest of them. */
const ROW_NAMES = ['settings.effortAuto', 'settings.lean', 'settings.judge', 'settings.key', 'settings.keepWarm', 'settings.workers', 'settings.mode', 'settings.skin', 'band.effort', 'band.cache',
  'workers.rung.light', 'workers.rung.standard', 'workers.rung.hard', 'workers.rung.plan'] as const

/** The name column's width in cells: snug to this language's names, so controls sit close to them. */
function nameCells(frame: Frame): number {
  const names = ROW_NAMES.map(key => t(frame.lang, key))
  return isRich(frame) ? Math.ceil(Math.max(...names.map(chOf))) + 1 : Math.max(...names.map(displayWidth)) + 1
}

/** A labelled row: name column, the control, an optional quiet hint. */
export function row(el: Els, frame: Frame, key: string, label: string, control: RenderNode, hint?: string): RenderNode {
  const { Box, Text } = el
  return (
    <Box key={'row-' + key} flexDirection="row" alignItems="center" columnGap={2} flexWrap="wrap">
      <Box width={nameCells(frame)} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      {control}
      {hint ? <Text dimColor wrap="wrap">{hint}</Text> : null}
    </Box>
  )
}

// ---- The lean: five stops between cheaper and smarter -------------------------------------------

const BIAS: readonly Settings['bias'][] = [-2, -1, 0, 1, 2]

/** Cheaper ○ ○ ● ○ ○ Smarter on the editor; the terminal names the stops (−2 … +2). */
function biasStops(el: Els, frame: Frame, bias: Settings['bias'], onPick: (bias: Settings['bias']) => void): RenderNode {
  const { Box, Button, Text } = el
  const name = (b: number) => (b > 0 ? '+' + b : b < 0 ? '−' + -b : '0')
  if (!isRich(frame)) return textSegmented(el, frame, 'bias', BIAS.map(b => ({ value: String(b), label: name(b) })), String(bias), picked => onPick(Number(picked) as Settings['bias']))
  return (
    <Box flexDirection="row" alignItems="center" columnGap={1}>
      <Text dimColor>{t(frame.lang, 'settings.cheaper')}</Text>
      <Box flexDirection="row">
        {BIAS.map(b => (b === bias ? <Button key={'bias-' + b} plain label="●" onPress={() => onPick(b)} /> : <Button key={'bias-' + b} plain dimColor label="○" onPress={() => onPick(b)} />))}
      </Box>
      <Text dimColor>{t(frame.lang, 'settings.smarter')}</Text>
    </Box>
  )
}

// ---- The terminal's rows (setup on the terminal lends them too) ---------------------------------

export function effortRows(el: Els, frame: Frame, d: Settings, a: SettingsActions): RenderNode[] {
  const out = [row(el, frame, 'auto', t(frame.lang, 'settings.effortAuto'), textToggle(el, frame, 'set-auto', d.effortAuto ? t(frame.lang, 'band.on') : t(frame.lang, 'band.off'), d.effortAuto, () => a.patch({ effortAuto: !d.effortAuto })), t(frame.lang, 'settings.autoHint'))]
  if (d.effortAuto) out.push(row(el, frame, 'bias', t(frame.lang, 'settings.lean'), biasStops(el, frame, d.bias, bias => a.patch({ bias })), t(frame.lang, 'settings.leanHint')))
  return out
}

/** The Jev key field and its test, when TypeSafe's Jev judges and no key is known. */
export function needsKey(view: SettingsView): boolean {
  return view.settings.judge === 'jev' && view.settings.jevSource === 'typesafe' && !['env', 'file', 'pasted'].includes(view.jev.source ?? '')
}

export function judgeRows(el: Els, frame: Frame, view: SettingsView, a: SettingsActions): RenderNode[] {
  const d = view.settings
  const tone = textTone(frame.appearance)
  const { Box, Text } = el
  const out: RenderNode[] = [
    row(
      el,
      frame,
      'judge',
      t(frame.lang, 'settings.judge'),
      textSegmented(
        el,
        frame,
        'judge',
        [
          { value: 'haiku', label: t(frame.lang, 'settings.haiku') },
          { value: 'jev', label: t(frame.lang, 'settings.jev') },
          { value: 'model', label: t(frame.lang, 'settings.routerModel') },
        ] as const,
        d.judge,
        judge => a.patch({ judge }),
      ),
    ),
  ]
  if (needsKey(view)) {
    const jev = view.jev
    const placeholder = t(frame.lang, 'settings.keyPaste')
    const field = 'Input' in el ? (
      <el.Input key="jev-key" placeholder={placeholder} value="" submitLabel={t(frame.lang, 'settings.saveKey')} onSubmit={(key: string) => a.jevKey(key)} />
    ) : (
      <Text dimColor>{placeholder}</Text>
    )
    const result =
      jev.test.state === 'testing' ? (
        <Text dimColor>{t(frame.lang, 'settings.testing')}</Text>
      ) : jev.test.state === 'ok' ? (
        <Text color={tone.ok} wrap="wrap">{'✓ ' + displayText(jev.test.message ?? t(frame.lang, 'settings.keyWorks'))}</Text>
      ) : jev.test.state === 'fail' ? (
        <Text color={tone.bad} wrap="wrap">{'✕ ' + displayText(jev.test.message ?? t(frame.lang, 'settings.keyRejected'))}</Text>
      ) : null
    out.push(
      row(
        el,
        frame,
        'jev-key',
        t(frame.lang, 'settings.key'),
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1} rowGap={1}>
          {field}
          {action(el, frame, 'jev-test', t(frame.lang, 'settings.test'), a.testJev, { hotkey: 't' })}
          {result}
        </Box>,
      ),
    )
  }
  return out
}

/**
 * The active saved worker set: Base followed by user-named modes. Rungs are edited on the dashboard.
 */
export function modeRows(el: Els, frame: Frame, d: Settings, a: SettingsActions): RenderNode[] {
  const { Text } = el
  const items = modeItems(frame, d)
  const current = d.activeMode ?? ''
  const control = 'Select' in el && a.setMode
    ? <el.Select key="mode" options={items} value={current} onSelect={(value: string) => a.setMode!(value)} />
    : <Text>{items.find(item => item.value === current)?.label ?? '—'}</Text>
  return [row(el, frame, 'mode', t(frame.lang, 'settings.mode'), control)]
}

export function keepWarmRow(el: Els, frame: Frame, d: Settings, a: SettingsActions): RenderNode {
  return row(el, frame, 'warm', t(frame.lang, 'settings.keepWarm'), textToggle(el, frame, 'set-warm', d.keepWarm ? t(frame.lang, 'band.on') : t(frame.lang, 'band.off'), d.keepWarm, () => a.patch({ keepWarm: !d.keepWarm })), t(frame.lang, 'settings.keepWarmHint'))
}

export function modeItems(frame: Frame, d: Settings): { value: string; label: string }[] {
  return [{ value: '', label: t(frame.lang, 'settings.modeNone') }, ...d.modes.map(m => ({ value: m.id, label: displayText(m.name, DISPLAY.name) }))]
}

function judgeName(frame: Frame, judge: Settings['judge']): string {
  return t(frame.lang, judge === 'haiku' ? 'settings.haiku' : judge === 'jev' ? 'settings.jev' : 'settings.routerModel')
}

// ---- Desktop: the deep's tiles -------------------------------------------------------------------
//
// A tile is a setting: its picture (art.ts `tileArt`, how the setting stands, alive while on), its
// name in bright ink with its switch at the right when it has one, one line on what it does, then
// its control. The pictures replace the old line icons, which said nothing at 15 px.

/** The least a tile takes, in cells: two side by side from about 84 cells, one a row below. */
const TILE_MIN = 40

/** Tiles side by side: two when the frame holds two at their least, else one a row. */
function tilesAcross(frame: Frame): 1 | 2 {
  return frame.columns >= 2 * TILE_MIN + 6 ? 2 : 1
}

/** Cells a tile's words and controls have beside its picture, about. */
function tileInner(frame: Frame): number {
  const tile = tilesAcross(frame) === 2 ? Math.floor((frame.columns - 5) / 2) : frame.columns - 4
  return Math.max(18, tile - 3 - Math.ceil(TILE_PX / CELL_PX) - 3)
}

type Tile = { id: string; art: TileArt; title: string; head?: RenderNode; line: string; body: RenderNode[] }

/** A tile in the skin's edge and glass (look.ts `tile`). */
function tile(el: Els, frame: Frame, x: Tile): RenderNode {
  const { Box, Text } = el
  const k = lookOf(frame)
  return (
    <Box key={'tile-' + x.id} position="relative" flexDirection="row" alignItems="flex-start" columnGap={2} flexGrow={1} width={0} minWidth={TILE_MIN} paddingX={1.5} paddingY={1} {...k.tile}>
      {pic(el, 'tile-art-' + x.id, k.art.tile(x.art), x.title, TILE_PX, TILE_PX)}
      <Box key={'tile-body-' + x.id} flexDirection="column" rowGap={1} flexGrow={1} flexShrink={1} minWidth={0}>
        <Box flexDirection="row" alignItems="center" columnGap={1} width="100%" minWidth={0}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text bold {...k.ink} wrap="wrap">{x.title}</Text>
          </Box>
          {x.head ?? null}
        </Box>
        <Text {...k.sub} wrap="wrap">{x.line}</Text>
        {x.body}
      </Box>
    </Box>
  )
}

/** A quiet line under a control. */
function note(el: Els, frame: Frame, key: string, text: string, word?: Word): RenderNode {
  const { Text } = el
  return <Text key={key} {...(word ?? lookOf(frame).mute)} wrap="wrap">{text}</Text>
}

/** Automatic effort: its switch, and while on the lean between cheaper and smarter. */
export function effortTile(el: Els, frame: Frame, view: SettingsView, a: SettingsActions): RenderNode {
  const { Box, Text } = el
  const L = frame.lang
  const d = view.settings
  const k = lookOf(frame)
  const body = d.effortAuto
    ? [
        <Box key="lean" flexDirection="row" alignItems="center" columnGap={1} flexWrap="wrap">
          <Text {...k.mute}>{t(L, 'settings.cheaper')}</Text>
          {slider(el, frame, 'bias', BIAS, d.bias, bias => a.patch({ bias }), 3)}
          <Text {...k.mute}>{t(L, 'settings.smarter')}</Text>
        </Box>,
        note(el, frame, 'lean-note', t(L, 'settings.leanHint')),
      ]
    : [note(el, frame, 'auto-off', t(L, 'settings.autoOffNote'))]
  return tile(el, frame, {
    id: 'effort',
    art: { kind: 'effort', on: d.effortAuto },
    title: t(L, 'settings.effortAuto'),
    head: toggle(el, frame, 'set-auto', d.effortAuto, t(L, d.effortAuto ? 'band.on' : 'band.off'), () => a.patch({ effortAuto: !d.effortAuto })),
    line: t(L, 'settings.autoLine'),
    body,
  })
}

/** Who judges: Haiku, Jev or a router model; Jev's key field when it needs one. */
export function judgeTile(el: Els, frame: Frame, view: SettingsView, a: SettingsActions): RenderNode {
  const { Box, Text } = el
  const L = frame.lang
  const d = view.settings
  const k = lookOf(frame)
  const body: RenderNode[] = [
    segmented(el, frame, 'judge', [
      { value: 'haiku', label: t(L, 'settings.haiku') },
      { value: 'jev', label: t(L, 'settings.jev') },
      { value: 'model', label: t(L, 'settings.routerModel') },
    ] as const, d.judge, judge => a.patch({ judge }), 'teal'),
  ]
  if (d.judge === 'model' && d.judgeModel) body.push(note(el, frame, 'judge-model-name', t(L, 'settings.routerModel') + ' · ' + displayText(d.judgeModel, DISPLAY.name)))
  if (needsKey(view)) {
    const jev = view.jev
    const placeholder = t(L, 'settings.keyPaste')
    const field = 'Input' in el
      ? well(el, frame, 'jev-key', tileInner(frame), <el.Input key="jev-key" placeholder={placeholder} value="" submitLabel={t(L, 'settings.saveKey')} onSubmit={(key: string) => a.jevKey(key)} />, placeholder)
      : <Text {...k.mute}>{placeholder}</Text>
    const result =
      jev.test.state === 'testing' ? <Text {...k.sub}>{t(L, 'settings.testing')}</Text>
        : jev.test.state === 'ok' ? <Text color={k.tone('green')} wrap="wrap">{'✓ ' + displayText(jev.test.message ?? t(L, 'settings.keyWorks'))}</Text>
          : jev.test.state === 'fail' ? <Text color={k.tone('red')} wrap="wrap">{'✕ ' + displayText(jev.test.message ?? t(L, 'settings.keyRejected'))}</Text>
            : null
    body.push(
      field,
      <Box key="jev-row" flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1} rowGap={1}>
        {pill(el, frame, 'jev-test', t(L, 'settings.test'), 'ghost', a.testJev, 'teal')}
        {result}
      </Box>,
    )
  }
  return tile(el, frame, { id: 'judge', art: { kind: 'judge', judge: d.judge }, title: t(L, 'settings.judge'), line: t(L, 'settings.judgeLine'), body })
}

/** The worker set that is on: Base or a named mode. */
export function modeTile(el: Els, frame: Frame, view: SettingsView, a: SettingsActions): RenderNode {
  const L = frame.lang
  const d = view.settings
  const items = modeItems(frame, d)
  const current = d.activeMode ?? ''
  const control = items.length <= 5 || !('Select' in el)
    ? segmented(el, frame, 'mode', items, current, id => a.setMode?.(id), 'amber')
    : <el.Select key="mode" options={items} value={current} onSelect={(value: string) => a.setMode?.(value)} />
  return tile(el, frame, { id: 'mode', art: { kind: 'mode', on: current !== '' }, title: t(L, 'settings.mode'), line: t(L, 'settings.modeLine'), body: [control] })
}

/** Keep warm: its switch, and what each ping costs. */
export function warmTile(el: Els, frame: Frame, view: SettingsView, a: SettingsActions): RenderNode {
  const L = frame.lang
  const d = view.settings
  return tile(el, frame, {
    id: 'warm',
    art: { kind: 'warm', on: d.keepWarm },
    title: t(L, 'settings.keepWarm'),
    head: toggle(el, frame, 'set-warm', d.keepWarm, t(L, d.keepWarm ? 'band.on' : 'band.off'), () => a.patch({ keepWarm: !d.keepWarm })),
    line: t(L, 'settings.warmLine'),
    body: [note(el, frame, 'warm-cost', t(L, 'settings.warmCostShort'))],
  })
}

/** The two skins by name, in the order they are offered. */
function skinOptions(frame: Frame): { value: Skin; label: string }[] {
  return SKINS.map(skin => ({ value: skin, label: t(frame.lang, skin === 'deep' ? 'settings.skinDeep' : 'settings.skinFlat') }))
}

/**
 * The skin: how the desktop draws the band and the cards (look.ts), picked here or on the
 * dashboard's Look card. Only the desktop shows it: the terminal draws text whatever it is.
 */
export function skinTile(el: Els, frame: Frame, view: SettingsView, a: SettingsActions): RenderNode {
  const L = frame.lang
  const d = view.settings
  return tile(el, frame, {
    id: 'skin',
    art: { kind: 'skin', skin: d.skin },
    title: t(L, 'settings.skin'),
    line: t(L, 'settings.skinLine'),
    body: [segmented(el, frame, 'skin', skinOptions(frame), d.skin, skin => a.patch({ skin }))],
  })
}

/** What 리플이 says the settings do right now, in a sentence or two. */
export function settingsSay(frame: Frame, d: Settings): string {
  const L = frame.lang
  const effort = d.effortAuto ? t(L, 'settings.sayAuto', { judge: judgeName(frame, d.judge) }) : t(L, 'settings.sayManual')
  return d.keepWarm ? effort + ' ' + t(L, 'settings.sayWarm') : effort
}

/** Rows the quick settings take on the desktop, about: for the sea's height (five tiles, three rows of two or five of one). */
function panelRows(frame: Frame, view: SettingsView): number {
  return (tilesAcross(frame) === 2 ? 30 : 45) + (needsKey(view) ? 4 : 0)
}

function settingsDrawn(el: Els, frame: Frame, view: SettingsView, a: SettingsActions): RenderNode {
  const { Box, Text } = el
  const L = frame.lang
  const d = view.settings
  const k = lookOf(frame)
  const face = 48
  const head = (
    <Box key="settings-head" flexDirection="row" alignItems="center" columnGap={2} width="100%" minWidth={0}>
      {ripple(el, frame, 'settings', d.effortAuto ? 'calm' : 'drowsy', t(L, 'band.brand'), face)}
      <Box key="settings-say" flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
        <Box flexDirection="row" alignItems="center" columnGap={1} flexWrap="wrap">
          <Text bold {...k.ink}>{t(L, 'settings.quick')}</Text>
          <Text {...k.mute}>{t(L, 'band.brand')}</Text>
        </Box>
        <Text {...k.sub} wrap="wrap">{settingsSay(frame, d)}</Text>
      </Box>
      <Box key="settings-exits" flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
        {pill(el, frame, 'all-settings', t(L, 'settings.openAll'), 'ghost', a.openAllSettings, 'violet', 'open')}
        {pill(el, frame, 'close', t(L, 'settings.close'), 'ghost', a.close, 'violet', 'close')}
      </Box>
    </Box>
  )
  const tiles = (
    <Box key="settings-tiles" flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1} width="100%" minWidth={0}>
      {effortTile(el, frame, view, a)}
      {judgeTile(el, frame, view, a)}
      {modeTile(el, frame, view, a)}
      {warmTile(el, frame, view, a)}
      {skinTile(el, frame, view, a)}
    </Box>
  )
  return capsule(el, frame, {
    key: 'settings',
    // 리플이 floats on the surface: the wave runs just under the head, the tiles below it.
    sea: { tone: 'violet', ripples: 'calm', reach: 170, motes: true, wave: 19 * 0.5 + face + 9, at: { x: 1.5 * CELL_PX + face / 2, y: 19 * 0.5 + face / 2 } },
    rows: panelRows(frame, view),
    paddingY: 1,
    gap: 1,
    children: [head, tiles],
  })
}

// ---- The panel ---------------------------------------------------------------------------------

/** Session-time controls only; the full settings live on the router dashboard. */
export function renderSettings(el: Els, frame: Frame, view: SettingsView, a: SettingsActions): RenderNode {
  if (canDraw(el, frame)) return settingsDrawn(el, frame, view, a)
  const { Box } = el
  const rich = isRich(frame)
  const close = dismiss(el, frame, 'close', t(frame.lang, 'settings.close'), a.close, 'x')
  return speak(el, frame, {
    key: 'settings',
    face: 'calm',
    title: t(frame.lang, 'band.brand'),
    aside: t(frame.lang, 'settings.quick'),
    blocks: [
      <Box key="controls" flexDirection="column" rowGap={rich ? 1 : 0}>
        {effortRows(el, frame, view.settings, a)}
        {judgeRows(el, frame, view, a)}
        {modeRows(el, frame, view.settings, a)}
        {keepWarmRow(el, frame, view.settings, a)}
      </Box>,
      actions(el, frame, [action(el, frame, 'all-settings', t(frame.lang, 'settings.openAll'), a.openAllSettings, { hotkey: 's', primary: true }), rich ? '' : close]),
    ],
    ...(rich ? { dismiss: close } : {}),
  })
}
