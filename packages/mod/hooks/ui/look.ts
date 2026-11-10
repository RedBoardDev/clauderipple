// The skin (2026-10-14): which pictures the desktop draws with and what colours its host Text takes.
// The deep (art.ts) is the first look: dark water on either theme, 리플이's glow, drawn controls in
// glass. Flat (flat.ts) is the app's own surfaces: a hairline card that follows the theme, the
// host's own ink, the accent only where something is on. Those two share one layout and change
// paint alone: every size is art.ts's and every cell count the same under both, so band.tsx's
// arithmetic and the blank presses laid over the pictures (kit.tsx) hold whatever the skin. The
// terminal draws text and knows nothing of skins.

import type { Skin } from '../../types'
import * as deep from './art'
import type { Glyph, Icon, PillLook, Sea, TileArt, Tone } from './art'
import { flatPictures } from './flat'
import { rippleSource } from './parts'
import type { Face } from './ripple'
import { textTone } from './theme'
import type { Appearance } from './theme'
import type { Frame } from './view'

/** Props a host Text takes for a role on a capsule: a colour of ours, or the host's own ink. */
export type Word = { color?: string; dimColor?: boolean }

/** Props a Box takes: a capsule, a tile, a control lit under the pointer. */
export type Surface = { borderStyle?: string; borderColor?: string; backgroundColor?: string; hover?: { borderColor?: string; backgroundColor?: string } }

/** The pictures a skin paints, each at art.ts's size. */
export type Paint = {
  /** Every capsule's backdrop, `width` × `height` px; '' when the skin paints none and the Box's own colour shows. */
  sea: (width: number, height: number, sea: Sea) => string
  /** The work current, `width` px wide at art.ts's CURRENT_PX tall, drawn at a capsule's bottom; '' for a skin with no water. */
  current: (width: number) => string
  plate: (width: number, height: number) => string
  switch: (on: boolean, busy?: boolean) => string
  word: (label: string, on: boolean, busy?: boolean) => { source: string; cells: number }
  extraHover: (widthPx: number) => string
  pill: (label: string, look: PillLook, tone?: Tone, glyph?: Glyph) => { source: string; cells: number }
  segmented: (labels: readonly string[], cells: readonly number[], chosen: number, tone?: Tone, colors?: readonly string[]) => string
  slider: (count: number, cellsPerStop: number, chosen: number) => string
  well: (width: number, height: number) => string
  close: (lit?: boolean) => string
  meter: (lit: number, look: 'auto' | 'manual' | 'quiet' | 'deciding') => string
  ring: (percent: number, tone: Tone | 'ink') => string
  clock: (share: number, tone: Tone | 'soft') => string
  gauge: (kind: string) => string
  icon: (icon: Icon, on: boolean, tone?: Tone) => string
  agents: (count: number, on: boolean) => string
  /** An icon with a count on its shoulder (the chat's compactions). */
  counted: (icon: Icon, count: number, on: boolean) => string
  rule: () => string
  tile: (art: TileArt) => string
  beads: (step: number, total: number) => { source: string; width: number }
}

export type Pictures = Paint & {
  /** 리플이's document at `size` px, in the skin's palette (parts.tsx `rippleSource`). */
  mascot: (face: Face, size: number, percent?: number, dim?: boolean) => string
}

export type Look = {
  skin: Skin
  /** Host Text on a capsule: bright for values, soft for names, quiet for asides. */
  ink: Word
  sub: Word
  mute: Word
  /** The text colour of a tone: a card's title in its light, a figure gone amber. */
  tone: (tone: Tone) => string
  capsule: Surface
  tile: Surface
  /** A control under the pointer (kit.tsx `lit`): its hover alone. */
  lit: Surface
  art: Pictures
}

const DEEP_PAINT: Paint = {
  sea: deep.seaArt, current: deep.currentArt, plate: deep.plateArt, switch: deep.switchArt, word: deep.wordArt, extraHover: deep.extraHoverArt,
  pill: deep.pillArt, segmented: deep.segmentedArt, slider: deep.sliderArt, well: deep.wellArt, close: deep.closeArt,
  meter: deep.meterArt, ring: deep.ringArt, clock: deep.clockArt, gauge: deep.gaugeArt, icon: deep.iconArt,
  agents: deep.agentsArt, counted: deep.countedArt, rule: deep.ruleArt, tile: deep.tileArt, beads: deep.beadsArt,
}

/** The deep: the capsule's edge a warm grey that reads on a light page and a dark one alike, lights white on the water. */
const DEEP: Look = {
  skin: 'deep',
  ink: { color: deep.INK },
  sub: { color: deep.SUB },
  mute: { color: deep.MUTE },
  tone: tone => deep.TONE[tone].text,
  capsule: { borderStyle: 'round', borderColor: 'rgba(128,124,116,0.55)' },
  tile: { borderStyle: 'round', borderColor: 'rgba(255,255,255,0.1)', backgroundColor: 'rgba(255,255,255,0.045)', hover: { borderColor: 'rgba(255,255,255,0.26)', backgroundColor: 'rgba(255,255,255,0.075)' } },
  lit: { borderStyle: 'round', borderColor: 'rgba(0,0,0,0)', hover: { backgroundColor: 'rgba(255,255,255,0.09)', borderColor: 'rgba(255,255,255,0.16)' } },
  // 리플이 drawn for the deep: the dark palette, light ink and lavender tone, whatever the theme.
  art: { ...DEEP_PAINT, mascot: (face, size, percent, dim) => rippleSource(face, size, 'dark', percent, dim) },
}

/**
 * Flat: the capsule painted in the app's own surface (flat.ts `sea`, white on a light app as its
 * prompt box is), edged in a grey that sits on either theme, the host's own ink for values and the
 * app's quiet text colour for names and asides, and the pictures in the theme's palette. The
 * host's `dimColor` was too faint to read on a light page (2026-10-16). The engine takes a theme
 * key, a name or hex here (not the app's CSS variables) and does not say which theme is on, so
 * with appearance auto the quiet words are a mid tone between the app's two. One per appearance.
 */
const FLATS = new Map<Appearance, Look>()

/** The app's quiet text (text-400, read from its stylesheet 2026-10-16) per theme, and between them. */
const QUIET: Record<Appearance, string> = { light: '#73726c', dark: '#9c9a92', auto: '#86847d' }

function flat(appearance: Appearance): Look {
  let look = FLATS.get(appearance)
  if (look) return look
  const text = textTone(appearance)
  look = {
    skin: 'flat',
    ink: {},
    sub: { color: QUIET[appearance] },
    mute: { color: QUIET[appearance] },
    // One accent: the deep's decorative tones (the judge's teal, the mode's amber) are the accent
    // here, and amber, red and green stay what they mean.
    tone: tone => (tone === 'amber' || tone === 'ember' ? text.warn : tone === 'red' ? text.bad : tone === 'green' ? text.ok : text.accent),
    capsule: { borderStyle: 'round', borderColor: 'rgba(128,124,116,0.3)' },
    tile: { borderStyle: 'round', borderColor: 'rgba(128,124,116,0.22)', backgroundColor: 'rgba(128,124,116,0.04)', hover: { borderColor: 'rgba(128,124,116,0.4)', backgroundColor: 'rgba(128,124,116,0.08)' } },
    lit: { borderStyle: 'round', borderColor: 'rgba(0,0,0,0)', hover: { backgroundColor: 'rgba(128,124,116,0.12)', borderColor: 'rgba(0,0,0,0)' } },
    art: { ...flatPictures(appearance), mascot: (face, size, percent, dim) => rippleSource(face, size, appearance, percent, dim) },
  }
  FLATS.set(appearance, look)
  return look
}

/**
 * The look a frame draws in: flat's own surfaces for flat, the deep for everything else.
 */
export function lookOf(frame: Frame): Look {
  return frame.skin === 'flat' ? flat(frame.appearance) : DEEP
}
