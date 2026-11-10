// The pieces every drawing is made of: the element table, 리플이, the way it speaks (its face on
// the left, what it says in one column beside it), and the controls of the cards and panels.
//
// These are the terminal's pieces and 리플이 everywhere; the desktop's drawn surfaces and controls
// (2026-10-12) are art.ts and kit.tsx, which build on the facts below.
// Engine and host facts (Claude Code 2.1.293, the desktop app's assets, 2026-10-10):
// - The desktop draws every answer as a new DOM tree, each Svg a new element. What blinked was the
//   interactive Svg: isInteractive makes it a sandboxed <iframe srcdoc>, which the host rebuilds
//   blank on every redraw. A plain Svg is an <img> of a data URL; it does not blink across
//   redraws, and CSS @keyframes inside the SVG run in it (seen in the owner's desktop app on
//   2026-10-11 at commit 8d43b97: 리플이 moving in the band and the quick settings with no
//   flicker; Effortless animates its band the same way). So 리플이 is always a plain image, never
//   interactive. A redraw still starts its motion over, so every loop opens on a natural pose
//   (ripple.ts).
// - A Button's label is text only and its colours are the host's. A drawn control takes its press
//   from a blank native button laid over it, and that blank label has to be sized a little short
//   of the drawing and made of no-break spaces, or the host cuts it to an ellipsis or folds it to
//   nothing (seen 2026-10-10 as "자동 (권장) …"); kit.tsx `blank` does both.
// - A plain Button under the pointer turns full ink on a ghost fill, dimmed or not, so a state told
//   by dimness alone looks the same on and off right after the click. A chosen option therefore
//   says so in its shape: ● chosen, ○ not (the terminal's marks too), the unchosen also dimmed.
// - `role="dismiss"` is drawn by the desktop as its native close control at the site's trailing
//   edge (the band's × is one), the label its accessible name; the terminal draws a Button.
// - An Svg needs alt, width and height (an interactive one without both falls back to ~300×150).
//   Its CSS animations run without isInteractive (the 2026-10-10 reading that they need it was
//   wrong); what isInteractive adds is the frame, and with it the blink.

import type { ElementTable, RenderNode } from 'claude-code'

import { CELL_PX, SVG_MAX_PX } from './art'
import type { Frame } from './view'
import { isRich } from './view'
import { GAUGE_FACES, GRID, detailOf, gaugeStep, rippleBody, rippleCss } from './ripple'
import type { Face } from './ripple'
import { svgDoc } from './theme'
import type { Appearance } from './theme'

export type Els = ElementTable

/** 리플이's size on a card (alerts, quick settings), px: the sheet's card badge. */
export const FACE_SIZE = 44
/** Where it greets or waits with nothing else to show (setup, empty panes), px: a bigger presence. */
export const GREET_SIZE = 56

const sources = new Map<string, string>()

/**
 * 리플이's SVG document: `face` at `size` px (the mini drawing below 34 px), the gauge in its 5%
 * steps, dimmed or not. One fixed string per state, built once: the host is handed the same
 * source until the state changes.
 */
export function rippleSource(face: Face, size: number, appearance: Appearance, percent?: number, dim = false): string {
  const step = percent !== undefined && GAUGE_FACES.includes(face) ? gaugeStep(percent) : undefined
  const key = [face, size, appearance, step ?? '', dim ? 'dim' : ''].join('|')
  let source = sources.get(key)
  if (!source) {
    const detail = detailOf(size)
    source = svgDoc(size, size, appearance, rippleBody(face, step, detail), rippleCss(face, step, detail) + (dim ? 'svg>g{opacity:.5}' : ''), '0 0 ' + GRID + ' ' + GRID)
    sources.set(key, source)
  }
  return source
}

/**
 * 리플이 with one of its faces (ripple.ts), `size` px square, alive: a plain image whose CSS motion
 * runs inside it and survives redraws without a blink (never isInteractive, see above). `percent`
 * fills the ring of a gauge face. Desktop and the editor only.
 */
export function mascot(el: Els, frame: Frame, key: string, face: Face, alt: string, size = FACE_SIZE, percent?: number): RenderNode {
  if (!('Svg' in el)) return ''
  // In a Box of its own that never shrinks: beside a column of text it keeps its size.
  return filled(el, 'ripple-' + key, rippleSource(face, size, frame.appearance, percent), alt, size)
}

/**
 * How far past its own width a picture may stretch to fill the cells laid out for it. A picture is
 * drawn for a cell of CELL_PX, but a cell is what the host's type makes it: under the desktop's
 * newer type (2026-10-25, ~8.8 px) pictures drawn to the pixel fell short of their cells, so the
 * band's sea ended before its right edge and its icons sat in wide gaps.
 */
const STRETCH = 2

/**
 * A picture drawn `width` px wide for a cell of CELL_PX, in a Box `key` of its own that never
 * shrinks: `width / CELL_PX` cells wide, which the picture fills at its own proportions (asked wider
 * than that, the host's `max-width: 100%` holds it to the Box). So it keeps its place among the
 * host's cells whatever px a cell is, and is exactly its own size where a cell is CELL_PX.
 */
export function filled(el: Els, key: string, source: string, alt: string, width: number): RenderNode {
  if (!('Svg' in el)) return ''
  const { Box, Svg } = el
  return (
    <Box key={key} flexShrink={0} alignItems="center" width={width / CELL_PX}>
      <Svg source={source} alt={alt} width={Math.min(SVG_MAX_PX, Math.ceil(width * STRETCH))} />
    </Box>
  )
}

/** True where 리플이 can be drawn: the desktop and the editor, with an Svg in the table. */
export function canDraw(el: Els, frame: Frame): boolean {
  return isRich(frame) && 'Svg' in el
}

export type Speech = {
  key: string
  face: Face
  /** What it says: one short sentence, bold. */
  title: string
  /** Quiet words on the title's line after it (a step count, a panel's name). */
  aside?: string
  /** Colour of the title on the terminal, where there is no face to carry it. */
  titleColor?: string
  /** One line of why, dim. */
  line?: string
  /** The ring as a gauge (a percent). */
  percent?: number
  /** 리플이's size, px (FACE_SIZE unless it greets or waits: GREET_SIZE). */
  size?: number
  /** What follows, each block a row apart: fields, options, the actions. */
  blocks?: RenderNode[]
  /** The site's close control (desktop: the host's native ×; terminal: in the last block). */
  dismiss?: RenderNode
}

/**
 * 리플이 speaks: on the desktop its face on the left and beside it one column, the title and its
 * line of why held together, then each block a row apart. The terminal draws the same column
 * without the face. Every card and panel uses this, so they share one rhythm.
 */
export function speak(el: Els, frame: Frame, s: Speech): RenderNode {
  const { Box, Text } = el
  const rich = isRich(frame)
  const head = (
    <Box key="say" flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={2} alignItems="center">
        <Text bold color={rich ? undefined : s.titleColor} wrap="wrap">{s.title}</Text>
        {s.aside ? <Text dimColor>{s.aside}</Text> : null}
      </Box>
      {s.line ? <Text dimColor wrap="wrap">{s.line}</Text> : null}
    </Box>
  )
  const blocks = (s.blocks ?? []).filter(b => b !== '' && b !== null && b !== undefined)
  const column = (
    // The text takes the width the face leaves and wraps in it (a row that wraps sizes its items
    // to their whole line, which ran a body past the card: seen 2026-10-10).
    <Box key="column" flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} rowGap={rich ? 1 : 0}>
      {head}
      {blocks}
    </Box>
  )
  if (!canDraw(el, frame)) {
    return (
      <Box key={'say-' + s.key} flexDirection="column" width="100%">
        {column}
        {s.dismiss ?? null}
      </Box>
    )
  }
  return (
    <Box key={'say-' + s.key} flexDirection="row" alignItems="flex-start" columnGap={2} width="100%">
      {mascot(el, frame, s.key, s.face, s.title, s.size ?? FACE_SIZE, s.percent)}
      {column}
      {s.dismiss ?? null}
    </Box>
  )
}

// ---- Controls ----------------------------------------------------------------------------------

/** A terminal (or mobile) control: `k: Label` with a hotkey, the label alone without one. */
export function textButton(el: Els, key: string, label: string, onPress: () => void, hotkey?: string, primary?: boolean): RenderNode {
  const { Button } = el
  // A bracketed button hides its hotkey on the terminal, so one with a hotkey stays plain (`s: Save`).
  if (primary && !hotkey) return <Button key={key} variant="primary" label={label} onPress={() => onPress()} />
  return hotkey ? <Button key={key} plain hotkey={hotkey} label={label} onPress={() => onPress()} /> : <Button key={key} plain label={label} onPress={() => onPress()} />
}

/**
 * A button. The one main action of a card or panel is the host's primary button on the desktop;
 * every other action is quiet, dim text until the pointer is on it. The terminal keeps its hotkeys.
 */
export function action(el: Els, frame: Frame, key: string, label: string, onPress: () => void, opts: { hotkey?: string; primary?: boolean } = {}): RenderNode {
  const { Button } = el
  if (isRich(frame)) {
    return opts.primary ? <Button key={key} variant="primary" label={label} onPress={() => onPress()} /> : <Button key={key} plain dimColor label={label} onPress={() => onPress()} />
  }
  return textButton(el, key, label, onPress, opts.hotkey, opts.primary)
}

/** The site's close control: the desktop's native ×, named `label`; a button on the terminal. */
export function dismiss(el: Els, frame: Frame, key: string, label: string, onPress: () => void, hotkey?: string): RenderNode {
  const { Button } = el
  if (isRich(frame)) return <Button key={key} plain role="dismiss" label={label} onPress={() => onPress()} />
  return textButton(el, key, label, onPress, hotkey)
}

/** The main action, then the quiet ones, in one row that wraps whole buttons. */
export function actions(el: Els, frame: Frame, buttons: RenderNode[]): RenderNode {
  const { Box } = el
  const shown = buttons.filter(b => b !== '' && b !== null && b !== undefined)
  if (!shown.length) return ''
  return (
    <Box key="actions" flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={isRich(frame) ? 1 : 2}>
      {shown}
    </Box>
  )
}

/** One option of several: `● Label` chosen, `○ Label` dim otherwise, on every surface. */
export function option(el: Els, key: string, label: string, chosen: boolean, onPress: () => void, hotkey?: string): RenderNode {
  const { Button } = el
  const text = (chosen ? '● ' : '○ ') + label
  if (hotkey) return <Button key={key} plain hotkey={hotkey} dimColor={!chosen} label={text} onPress={() => onPress()} />
  return <Button key={key} plain dimColor={!chosen} label={text} onPress={() => onPress()} />
}

/** A row of options, one chosen. */
export function segmented<T extends string>(
  el: Els,
  frame: Frame,
  key: string,
  options: readonly { value: T; label: string; hotkey?: string }[],
  value: T,
  onPick: (value: T) => void,
): RenderNode {
  const { Box } = el
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={isRich(frame) ? 1 : 2}>
      {options.map(o => option(el, key + '-' + o.value, o.label, o.value === value, () => onPick(o.value), isRich(frame) ? undefined : o.hotkey))}
    </Box>
  )
}

/** A two-state switch: one button that says its state (`● On` / `○ Off`) and flips it. */
export function toggle(el: Els, frame: Frame, key: string, label: string, on: boolean, onPress: () => void, hotkey?: string): RenderNode {
  return option(el, key, label, on, onPress, isRich(frame) ? undefined : hotkey)
}
