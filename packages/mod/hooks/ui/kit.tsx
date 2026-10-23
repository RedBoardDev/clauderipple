// The desktop's capsules and drawn controls, put together: a picture from the skin's pictures
// (look.ts: art.ts for the deep, flat.ts for flat), the host's text in the skin's colours beside
// it, and a blank native button laid over both to take the press. Desktop and the editor only (an
// Svg in the table); the terminal keeps the text controls of parts.tsx.
//
// Host facts this is built on (2026-10):
// - A Box drawn `position: "absolute"` is painted over every sibling that is not itself positioned,
//   whatever comes after it in the tree (CSS stacking). The 2026-10-12 surfaces put their backdrop in
//   such a Box and their words in plain ones: in the app the backdrop hid the panel's title, its ×
//   and every row's name, and only the controls with a press laid over them showed. The app does
//   not take `position: "relative"` from a Box either: it positions a Box only when one of its own
//   children is absolute. So a capsule paints its sea first, absolute, and holds everything else in
//   one layer after it that starts with an empty absolute Box (`lift`), which makes it positioned.
// - A blank button's label is no-break spaces (U+00A0): the host sets a button's label
//   `white-space: nowrap`, which would fold ordinary spaces into one. It is sized a little short of
//   the drawing (an ellipsis would show) and sits in an absolute Box over the control, clipped to it.
// - A plain Button's label takes the host's ink, which a dark capsule would swallow; nothing on a
//   capsule is a labelled host Button. A keyed Box's `hover` lights a control on our own terms.
// - A skin that has no backdrop (flat) is the Box's own `backgroundColor` and `borderStyle`, which
//   the host paints with the theme.

import type { RenderNode } from 'claude-code'

import type { Els } from './parts'
import type { Face } from './ripple'
import type { Frame } from './view'
import { CELL_PX, CLOSE_PX, CONTROL_PX, ROW_PX, SVG_MAX_PX, SWITCH_H, SWITCH_W, WELL_PX, labelPx } from './art'
import type { Glyph, PillLook, Sea, Tone } from './art'
import { lookOf } from './look'
import { chOf } from './theme'

/** Width of one U+00A0 in the host's 12 px button font, px, taken a little wide. */
const NBSP_PX = 3.6
/** The host's padding either side of a plain Button's label, px. */
const BUTTON_PAD = 6

/**
 * The props that light a Box under the pointer the way `lit` lights a control: the skin's light
 * (a transparent round edge at rest, so the box does not move when lit), joined to `scope`.
 */
export function hoverLight(frame: Frame, scope?: string): Record<string, unknown> {
  const look = lookOf(frame).lit
  return { ...look, hover: { ...look.hover, ...(scope ? { scope } : {}) } }
}

/** Cells a run of px takes, rounded up. */
function cellsOf(px: number): number {
  return Math.ceil(px / CELL_PX)
}

/** Rows a run of px takes, unrounded (the host takes fractions of a row). */
export function rowsOf(px: number): number {
  return Math.round((px / ROW_PX) * 1000) / 1000
}

/** A no-break space, spelled by its code: the bare character is invisible in source and was once lost. */
const NBSP = String.fromCharCode(0xa0)

/** A blank label as wide as a button over `px` should be. */
export function blank(px: number): string {
  return NBSP.repeat(Math.max(1, Math.floor((px - BUTTON_PAD * 2) / NBSP_PX)))
}

/** The blank button over a control `px` wide: last child of a `position: relative` Box. */
export function press(el: Els, key: string, px: number, onPress: () => void): RenderNode {
  const { Box, Button } = el
  return (
    <Box position="absolute" top={0} bottom={0} left={0} right={0} alignItems="center" justifyContent="center" overflow="hidden">
      <Button key={key} plain label={blank(px)} onPress={() => onPress()} />
    </Box>
  )
}

/**
 * An empty absolute Box: the first child of a Box that must paint above an absolute picture laid
 * before it. The app does not take a Box's own `position: "relative"`; it positions a Box only
 * when one of its children is absolute (seen 2026-10-13: every capsule's words, tiles and 리플이
 * lay under the water, and only controls with a press laid over them showed).
 */
export function lift(el: Els): RenderNode {
  const { Box } = el
  return <Box position="absolute" top={0} left={0} />
}

/** A picture, `width` × `height` px, in a Box of its own that never shrinks. */
export function pic(el: Els, key: string, source: string, alt: string, width: number, height: number): RenderNode {
  if (!('Svg' in el)) return ''
  const { Box, Svg } = el
  if (width > SVG_MAX_PX || height > SVG_MAX_PX) {
    // Crop the same drawing, not separately generated seas: gradients, corners and motion retain
    // their original coordinates on either side of every join, in either skin and theme.
    const root = /^<svg\b[^>]*>/.exec(source)?.[0]
    const view = root && /viewBox="([^"]+)"/.exec(root)?.[1]?.trim().split(/\s+/).map(Number)
    if (!root || !view || view.length !== 4 || !view.every(Number.isFinite)) throw new Error('A tiled picture needs an SVG viewBox')
    const [vx, vy, vw, vh] = view as [number, number, number, number]
    const rows: RenderNode[] = []
    for (let y = 0; y < height; y += SVG_MAX_PX) {
      const tileHeight = Math.min(SVG_MAX_PX, height - y)
      const tiles: RenderNode[] = []
      for (let x = 0; x < width; x += SVG_MAX_PX) {
        const w = Math.min(SVG_MAX_PX, width - x)
        const cropped = root.replace(/\bwidth="[^"]*"/, 'width="' + w + '"')
          .replace(/\bheight="[^"]*"/, 'height="' + tileHeight + '"')
          .replace(/viewBox="[^"]*"/, 'viewBox="' + [vx + x * vw / width, vy + y * vh / height, w * vw / width, tileHeight * vh / height].join(' ') + '"')
        tiles.push(<Svg key={key + '-' + x + '-' + y} source={cropped + source.slice(root.length)} alt={x === 0 && y === 0 ? alt : ''} width={w} height={tileHeight} />)
      }
      rows.push(<Box key={'row-' + y} flexDirection="row" flexShrink={0} columnGap={0} alignItems="flex-start">{tiles}</Box>)
    }
    // Let images supply the pixel heights directly. Rounding a tile to host rows leaves seams.
    return <Box key={'pic-' + key} flexDirection="column" flexShrink={0} rowGap={0} alignItems="flex-start">{rows}</Box>
  }
  return (
    <Box key={'pic-' + key} flexShrink={0} alignItems="center">
      <Svg source={source} alt={alt} width={width} height={height} />
    </Box>
  )
}

/**
 * 리플이 on a capsule: its face drawn in the skin's palette (the deep's dark one, the theme's for
 * flat), a plain image in a Box of its own that never shrinks. `percent`
 * fills a gauge face's ring.
 */
export function ripple(el: Els, frame: Frame, key: string, face: Face, alt: string, size: number, percent?: number, dim = false): RenderNode {
  if (!('Svg' in el)) return ''
  const { Box, Svg } = el
  return (
    <Box key={'ripple-' + key} flexShrink={0}>
      <Svg source={lookOf(frame).art.mascot(face, size, percent, dim)} alt={alt} width={size} height={size} />
    </Box>
  )
}

/**
 * A control that lights under the pointer: a keyed, positioned Box with the skin's light as its
 * hover, holding what it shows and, last, its press. `scope` joins a hover group, so pointing at
 * the control also shows what it does elsewhere (the band's tip).
 */
export function lit(el: Els, frame: Frame, key: string, cells: number, children: RenderNode[], paddingX = 0.5, scope?: string): RenderNode {
  const { Box } = el
  const look = lookOf(frame).lit
  return (
    <Box key={'hv-' + key} position="relative" flexDirection="row" alignItems="center" columnGap={1} paddingX={paddingX} paddingY={0} width={cells} flexShrink={0} {...look} hover={{ ...look.hover, ...(scope ? { scope } : {}) }}>
      {children}
    </Box>
  )
}

/** The drawn light over `cells`, in absolute Boxes of whole cells each. */
function extraHover(el: Els, frame: Frame, cells: number): RenderNode[] {
  const { Box } = el
  const parts: RenderNode[] = []
  for (let i = 0; i < cells; i++) parts.push(<Box key={'extra-' + i} position="absolute" top={0} bottom={0} left={i} width={1}>{pic(el, 'extra-' + i, lookOf(frame).art.extraHover(CELL_PX), '', CELL_PX, CONTROL_PX)}</Box>)
  return parts
}

/**
 * A capsule: a Box in the skin's edge and colour, the skin's backdrop (the deep's sea; flat has
 * none) painted behind it from its top left, and everything it holds in one positioned layer above
 * that. `rows` is about how tall it draws; the backdrop is taken taller and wider than that, and
 * the capsule clips it.
 */
export function capsule(el: Els, frame: Frame, c: { key: string; sea: Omit<Sea, 'at'> & { at?: Sea['at'] }; rows: number; paddingX?: number; paddingY?: number; gap?: number; children: RenderNode[] }): RenderNode {
  const { Box } = el
  const look = lookOf(frame)
  const padX = c.paddingX ?? 1.5
  const padY = c.paddingY ?? 0.5
  const width = Math.max(40, frame.columns) * CELL_PX + 48
  // Taken well past the estimate: a capsule taller than its sea would show the page beneath.
  const visible = Math.round(c.rows * ROW_PX)
  const height = visible + 220
  const at = c.sea.at ?? { x: padX * CELL_PX + 12, y: padY * ROW_PX * 0.5 + 13 }
  const sea = look.art.sea(width, height, { ...c.sea, at, visible })
  return (
    <Box key={c.key} position="relative" flexDirection="column" paddingX={0} paddingY={0} overflow="hidden" width="100%" minWidth={0} {...look.capsule}>
      {sea ? (
        <Box key={c.key + '-sea'} position="absolute" top={0} left={0}>
          {pic(el, c.key + '-sea', sea, 'ClaudeRipple', width, height)}
        </Box>
      ) : null}
      <Box key={c.key + '-layer'} position="relative" flexDirection="column" rowGap={c.gap ?? 0} paddingX={padX} paddingY={padY} width="100%" minWidth={0}>
        {lift(el)}
        {c.children}
      </Box>
    </Box>
  )
}

/**
 * A drawn button with its label in it: `primary` the one thing to press, `ghost` a quiet one. Its
 * Box key starts `pill-` or `ghost-`, its press is `key`.
 */
export function pill(el: Els, frame: Frame, key: string, label: string, look: PillLook, onPress: () => void, tone: Tone = 'violet', glyph?: Glyph): RenderNode {
  const { Box } = el
  const art = lookOf(frame).art.pill(label, look, tone, glyph)
  return (
    <Box key={(look === 'primary' ? 'pill-' : 'ghost-') + key} position="relative" width={art.cells} height={rowsOf(CONTROL_PX)} flexShrink={0} alignItems="center" justifyContent="center">
      {pic(el, key, art.source, label, art.cells * CELL_PX, CONTROL_PX)}
      {press(el, key, art.cells * CELL_PX, onPress)}
    </Box>
  )
}

/** Cells the way out takes. */
export const CLOSE_CELLS = cellsOf(CLOSE_PX + 4)

/**
 * The way out: a soft disc with a ×, `label` its name for a reader that cannot see it. The disc is
 * its own light under the pointer: `lit`'s rounded box around it read as a second button
 * (2026-10-14).
 */
export function closeButton(el: Els, frame: Frame, key: string, label: string, onPress: () => void, scope?: string): RenderNode {
  const { Box } = el
  const art = lookOf(frame).art
  return (
    <Box key={'hv-' + key} position="relative" flexDirection="row" alignItems="center" justifyContent="center" width={CLOSE_CELLS} flexShrink={0} {...(scope ? { hover: { scope } } : {})}>
      {pic(el, key, art.close(), label, CLOSE_PX, CLOSE_PX)}
      <Box position="absolute" top={0} bottom={0} left={0} right={0} alignItems="center" justifyContent="center" display="none" hover={{ display: 'flex' }}>
        {pic(el, key + '-lit', art.close(true), label, CLOSE_PX, CLOSE_PX)}
      </Box>
      {press(el, key, CLOSE_CELLS * CELL_PX, onPress)}
    </Box>
  )
}

/** Cells a switch and its word take, their hover's air included. */
export function toggleCells(label: string): number {
  return Math.ceil((SWITCH_W + CELL_PX + chOf(label) * CELL_PX * 1.1) / CELL_PX) + 1
}

/** Cells the Auto word takes as its own control: its picture's width (the pill's own air drawn in). */
export function wordCells(frame: Frame, label: string): number {
  return lookOf(frame).art.word(label, true).cells
}

/**
 * The Auto word as the control itself (the skin's `word`): lit while Auto is on, a quiet ghost
 * while off, pulsing while the judge decides; the whole pressable.
 */
export function word(el: Els, frame: Frame, key: string, on: boolean, label: string, onPress: () => void, busy = false, scope?: string): RenderNode {
  const { Box } = el
  const art = lookOf(frame).art.word(label, on, busy)
  return (
    <Box key={(on ? 'word-on-' : 'ghost-') + key} position="relative" width={art.cells} height={rowsOf(CONTROL_PX)} flexShrink={0} alignItems="center" justifyContent="center">
      {pic(el, key, art.source, label, art.cells * CELL_PX, CONTROL_PX)}
      <Box position="absolute" top={0} bottom={0} left={0} right={0} display="none" hover={{ scope }}>
        {lift(el)}
        {extraHover(el, frame, art.cells)}
      </Box>
      {press(el, key, art.cells * CELL_PX, onPress)}
    </Box>
  )
}

/** A switch and its word (On / Off), the whole pressable; lit while on. */
export function toggle(el: Els, frame: Frame, key: string, on: boolean, label: string, onPress: () => void, busy = false, scope?: string): RenderNode {
  const { Text } = el
  const look = lookOf(frame)
  const cells = toggleCells(label)
  return lit(el, frame, key, cells, [
    pic(el, key, look.art.switch(on, busy), label, SWITCH_W, SWITCH_H),
    <Text key={key + '-word'} {...(on ? look.ink : look.sub)} bold={on}>{label}</Text>,
    press(el, key, cells * CELL_PX, onPress),
  ], 0.5, scope)
}

/**
 * A field's well: a native field (Input) on a plate of the app's own page colour, light or dark as
 * the app is (the skin's `well`), so the host's own text colour reads in it on either theme. The
 * field sits in a positioned layer above the plate.
 */
export function well(el: Els, frame: Frame, key: string, cells: number, field: RenderNode, alt: string): RenderNode {
  const { Box } = el
  const w = cells * CELL_PX
  return (
    <Box key={'well-' + key} position="relative" flexDirection="row" alignItems="center" width={cells} flexShrink={1} minWidth={16} height={rowsOf(WELL_PX)} paddingX={1} overflow="hidden">
      <Box position="absolute" top={0} left={0}>
        {pic(el, 'well-' + key, lookOf(frame).art.well(w, WELL_PX), alt, w, WELL_PX)}
      </Box>
      <Box key={'well-field-' + key} position="relative" flexGrow={1} flexShrink={1} minWidth={0}>
        {lift(el)}
        {field}
      </Box>
    </Box>
  )
}

export type SegmentOption<T extends string> = { value: T; label: string }

/** Each segment's cells: its label drawn at 12 px with air either side, at least five cells. */
function segmentCells(labels: readonly string[]): number[] {
  return labels.map(label => Math.max(5, Math.ceil((labelPx(label, 12) + 26) / CELL_PX)))
}

/**
 * A segmented control drawn whole (the skin's `segmented`), the chosen segment lit, each segment
 * the press of its own option (`key-value`). `colors` lights the chosen one in its own colour (the
 * efforts' depths) where the skin takes colours.
 */
export function segmented<T extends string>(el: Els, frame: Frame, key: string, options: readonly SegmentOption<T>[], value: T | null, onPick: (value: T) => void, tone: Tone = 'violet', colors?: readonly string[]): RenderNode {
  const { Box } = el
  const labels = options.map(o => o.label)
  const cells = segmentCells(labels)
  const total = cells.reduce((n, c) => n + c, 0)
  const chosen = options.findIndex(o => o.value === value)
  const alt = labels.map((label, i) => (i === chosen ? '[' + label + ']' : label)).join(' · ')
  return (
    <Box key={'seg-' + key} position="relative" flexDirection="row" width={total} height={rowsOf(CONTROL_PX)} flexShrink={0}>
      <Box position="absolute" top={0} left={0}>
        {pic(el, 'seg-' + key, lookOf(frame).art.segmented(labels, cells, chosen, tone, colors), alt, total * CELL_PX, CONTROL_PX)}
      </Box>
      {options.map((o, i) => (
        <Box key={'sg-' + key + '-' + o.value} position="relative" width={cells[i]} height={rowsOf(CONTROL_PX)} flexShrink={0}>
          {press(el, key + '-' + o.value, cells[i]! * CELL_PX, () => onPick(o.value))}
        </Box>
      ))}
    </Box>
  )
}

/**
 * A stepped slider: `values` as stops on one drawn track, the chosen one lit, each stop the press of
 * an equal part of the track (`key-value`).
 */
export function slider<T extends string | number>(el: Els, frame: Frame, key: string, values: readonly T[], value: T, onPick: (value: T) => void, cellsPerStop = 4): RenderNode {
  const { Box } = el
  const chosen = Math.max(0, values.indexOf(value))
  const total = values.length * cellsPerStop
  return (
    <Box key={'sl-' + key} position="relative" flexDirection="row" width={total} height={rowsOf(CONTROL_PX)} flexShrink={0} alignItems="center">
      <Box position="absolute" top={0} bottom={0} left={0} alignItems="center" justifyContent="center">
        {pic(el, 'sl-' + key, lookOf(frame).art.slider(values.length, cellsPerStop, chosen), String(value), total * CELL_PX, 22)}
      </Box>
      {values.map(v => (
        <Box key={'st-' + key + '-' + v} position="relative" width={cellsPerStop} height={rowsOf(CONTROL_PX)} flexShrink={0}>
          {press(el, key + '-' + v, cellsPerStop * CELL_PX, () => onPick(v))}
        </Box>
      ))}
    </Box>
  )
}
