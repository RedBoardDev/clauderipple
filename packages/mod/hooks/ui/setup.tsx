// First run: three short steps (who judges, workers on the dashboard, keep warm) and a
// done card. Shown once, in the band; detailed settings live on the router dashboard.
//
// 리플이 asks each step as a card asks: the step's question is the title, the steps beside it, one
// line of why, the step's control, then Next and the quiet ways back or out. It asks who should
// judge, waits calmly, and is pleased when all is set. The terminal draws 리플이's column (parts.tsx
// `speak`); the desktop a capsule of the deep, its controls the quick settings' own tiles.

import { t } from '../i18n'
import type { RenderNode } from 'claude-code'
import { RUNGS } from '../settings'

import { CELL_PX } from './art'
import { lookOf } from './look'
import { capsule, pic, pill, ripple } from './kit'
import { GREET_SIZE, action, actions, canDraw, speak } from './parts'
import type { Els } from './parts'
import { judgeChain, judgeRows, judgeTile, keepWarmRow, row, warmTile } from './settings'
import { chOf } from './theme'
import type { Frame, SettingsActions, SettingsView, SetupActions, SetupView } from './view'
import { targetLabel } from './view'

export const STEPS = [
  { title: 'setup.judgeTitle', blurb: 'setup.judgeBlurb' },
  { title: 'setup.workersTitle', blurb: 'setup.workersNote' },
  { title: 'setup.cacheTitle', blurb: 'setup.cacheBlurb' },
] as const

/** `Sol · Astra · …`: the four workers' models, lowest first. */
export function workersSummary(lang: Frame['lang'], d: SetupView['draft']): string {
  const general = d.rules.general
  return RUNGS.map(rung => general.rungs[rung]?.map(step => targetLabel(step.target, lang)).join(' → ') || '—').join(' · ')
}

/** The steps as rings, the current one filled: ● ○ ○. */
function dots(step: number): string {
  return [1, 2, 3].map(i => (i <= step ? '●' : '○')).join(' ')
}

/** The first-run setup in the band. */
export function renderSetup(el: Els, frame: Frame, view: SetupView, a: SetupActions): RenderNode {
  const { Text } = el
  // Setup lends the same small controls its draft and handlers.
  const asSettings: SettingsView = { settings: view.draft, jev: view.jev, ...(view.models ? { models: view.models } : {}) }
  const asActions: SettingsActions = { ...a, close: () => undefined }
  const d = view.draft
  const done = view.step === 4
  const step = done ? null : STEPS[view.step - 1]!
  const body: RenderNode[] = done
    ? [
        row(el, frame, 'sum-effort', t(frame.lang, 'band.effort'), <Text wrap="wrap">{t(frame.lang, 'setup.effortSummary', { state: t(frame.lang, d.effortAuto ? 'band.on' : 'band.off').toLowerCase(), judge: judgeChain(frame.lang, d.judges) })}</Text>),
        row(el, frame, 'sum-workers', t(frame.lang, 'settings.workers'), <Text wrap="wrap">{workersSummary(frame.lang, d)}</Text>),
        row(el, frame, 'sum-cache', t(frame.lang, 'band.cache'), <Text wrap="wrap">{d.keepWarm ? t(frame.lang, 'setup.cacheSummary', { hours: d.keepWarmHours }) : t(frame.lang, 'setup.cacheOff')}</Text>),
      ]
    : view.step === 1
      ? judgeRows(el, frame, asSettings, asActions)
      : view.step === 2
        ? [] // Its line says it all: workers start on Auto, the rest is on the dashboard.
        : [keepWarmRow(el, frame, view.draft, asActions)]
  const { Box } = el
  const buttons = done
    ? [action(el, frame, 'finish', t(frame.lang, 'setup.start'), a.finish, { hotkey: 'g', primary: true }), action(el, frame, 'back', t(frame.lang, 'setup.back'), a.back, { hotkey: 'b' })]
    : [
        action(el, frame, 'next', view.step === 3 ? t(frame.lang, 'setup.finish') : t(frame.lang, 'setup.next'), a.next, { hotkey: 'n', primary: true }),
        view.step === 2 ? action(el, frame, 'all-settings', t(frame.lang, 'settings.openAll'), a.openAllSettings, { hotkey: 's' }) : '',
        view.step > 1 ? action(el, frame, 'back', t(frame.lang, 'setup.back'), a.back, { hotkey: 'b' }) : '',
        action(el, frame, 'skip', t(frame.lang, 'setup.skip'), a.skip, { hotkey: 'k' }),
      ]
  const face = done ? 'pleased' : view.step === 1 ? 'asking' : 'calm'
  // It greets first; the first step's question is its one row (who judges).
  const title = done ? t(frame.lang, 'setup.ready') : view.step === 1 ? t(frame.lang, 'setup.welcome') : t(frame.lang, step!.title)
  const line = done ? t(frame.lang, 'setup.changeDashboard') : t(frame.lang, step!.blurb)
  if (canDraw(el, frame)) {
    // The desktop: a capsule of the deep, the step's control the quick settings' own tile (who
    // judges, keep warm), what was chosen when done, Next lit and the rest ghost buttons.
    const L = frame.lang
    const k = lookOf(frame)
    const beads = k.art.beads(view.step, 3)
    const summary = done
      ? [
          [t(L, 'band.effort'), t(L, 'setup.effortSummary', { state: t(L, d.effortAuto ? 'band.on' : 'band.off').toLowerCase(), judge: judgeChain(L, d.judges) })],
          [t(L, 'settings.workers'), workersSummary(L, d)],
          [t(L, 'band.cache'), d.keepWarm ? t(L, 'setup.cacheSummary', { hours: d.keepWarmHours }) : t(L, 'setup.cacheOff')],
        ]
      : []
    const nameCells = Math.ceil(Math.max(0, ...summary.map(([name]) => chOf(name!)))) + 1
    const content = done
      ? [
          <Box key="summary" flexDirection="column" rowGap={1} paddingLeft={Math.ceil(GREET_SIZE / CELL_PX) + 2}>
            {summary.map(([name, value], i) => (
              <Box key={'sum-' + i} flexDirection="row" columnGap={2} alignItems="flex-start">
                <Box width={nameCells} flexShrink={0}><Text {...k.mute}>{name}</Text></Box>
                <Text {...k.ink} wrap="wrap">{value}</Text>
              </Box>
            ))}
          </Box>,
        ]
      : view.step === 1 || view.step === 3
        ? [
            <Box key="step-tile" flexDirection="row" width="100%" minWidth={0}>
              {view.step === 1 ? judgeTile(el, frame, asSettings, asActions) : warmTile(el, frame, asSettings, asActions)}
            </Box>,
          ]
        : []
    const next = done ? pill(el, frame, 'finish', t(L, 'setup.start'), 'primary', a.finish, 'green', 'next') : pill(el, frame, 'next', view.step === 3 ? t(L, 'setup.finish') : t(L, 'setup.next'), 'primary', a.next, 'violet', 'next')
    return capsule(el, frame, {
      key: 'setup',
      sea: { tone: done ? 'green' : 'violet', ripples: 'calm', reach: 170, motes: true, wave: 19 * 0.5 + GREET_SIZE + 9, ...(done ? { tick: true, weather: 'sparkles' as const } : {}), at: { x: 1.5 * CELL_PX + GREET_SIZE / 2, y: 19 * 0.5 + GREET_SIZE / 2 } },
      rows: 8 + (done ? 6 : view.step === 1 ? 12 + 2 * (d.judges.length - 1) : view.step === 3 ? 8 : 0) + (frame.columns < 70 ? 4 : 0),
      paddingY: 1,
      gap: 1,
      children: [
        <Box key="setup-head" flexDirection="row" alignItems="center" columnGap={2} width="100%" minWidth={0}>
          {ripple(el, frame, 'setup', face, title, GREET_SIZE)}
          <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            <Box flexDirection="row" alignItems="center" columnGap={2} flexWrap="wrap">
              <Text bold {...(done ? { color: k.tone('green') } : k.ink)} wrap="wrap">{title}</Text>
              {done ? null : pic(el, 'setup-beads', beads.source, view.step + ' / 3', beads.width, 16)}
            </Box>
            <Text {...k.sub} wrap="wrap">{line}</Text>
          </Box>
        </Box>,
        ...content,
        <Box key="actions" flexDirection="row" alignItems="center" columnGap={1} flexWrap="wrap" rowGap={1}>
          {next}
          {!done && view.step === 2 ? pill(el, frame, 'all-settings', t(L, 'settings.openAll'), 'ghost', a.openAllSettings, 'violet', 'open') : null}
          {done || view.step > 1 ? pill(el, frame, 'back', t(L, 'setup.back'), 'ghost', a.back, 'violet', 'back') : null}
          {done ? null : pill(el, frame, 'skip', t(L, 'setup.skip'), 'ghost', a.skip)}
        </Box>,
      ],
    })
  }
  return speak(el, frame, {
    key: 'setup',
    face,
    // It greets here, the first thing a new session shows: at its greeting size.
    size: GREET_SIZE,
    title,
    aside: done ? '' : dots(view.step),
    line,
    blocks: [
      body.length ? (
        <Box key="body" flexDirection="column">
          {body}
        </Box>
      ) : '',
      actions(el, frame, buttons),
    ],
  })
}
