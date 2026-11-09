// Flat (2026-10-14): the desktop's second skin, the app's own surfaces. Nothing is painted behind a
// capsule: it is a Box of the host's, a hairline edge and a tint of the page, so it follows the
// app's light or dark theme as the panes do, and every host Text on it is the host's own ink. The
// pictures paint with the palette variables of theme.ts (svgDoc), which follow the theme through
// `prefers-color-scheme` as the deep's well does, and the accent marks what is on, chosen or the one
// thing to press: nothing else has a hue of its own, and amber, red and green keep their meanings.
// No gradient, glow, water or weather; 리플이 keeps its life. Every size is art.ts's, so the presses
// laid over the pictures line up (kit.tsx). Pure: SVG only, so node tests can load it.

import { CELL_PX, CLOSE_PX, CONTROL_PX, countedWidth, FLAME, GLYPH, ICON, ICON_PX, METER_H, METER_W, SWITCH_H, SWITCH_W, TILE_PX, esc, labelPx, r } from './art.ts'
import type { Icon, Tone } from './art.ts'
import type { Paint } from './look.ts'
import { svgDoc } from './theme.ts'
import type { Appearance } from './theme.ts'

const INK = 'var(--ink)'
const MUTED = 'var(--muted)'
const FAINT = 'var(--faint)'
const FILL = 'var(--fill)'
const STROKE = 'var(--stroke)'
const ACCENT = 'var(--accent)'
const WASH = 'var(--accentWash)'
const LINE = 'var(--accentLine)'
const PRIMARY = 'var(--primary)'

/** The corners of a drawn control: the host's own buttons are about this round. */
const RX = 6

const STILL = '@media (prefers-reduced-motion:reduce){*{animation:none!important}}'

/** A tone's colour: amber, red and green mean what they mean; every other tone is the accent. */
function toneVar(tone: Tone): string {
  return tone === 'amber' || tone === 'ember' ? 'var(--warn)' : tone === 'red' ? 'var(--bad)' : tone === 'green' ? 'var(--ok)' : ACCENT
}

/** The 44 px flame of the keep-warm tile (the deep's path). */
const TILE_FLAME = 'M22 35.5c6.4 0 10-4.2 10-9.6 0-6-5.2-9-6.1-15.4-3.6 2.4-5.6 6-5.4 9.3-2.2-.9-3.3-3-3.5-4.9-3 2.9-4.4 6.4-4.4 11.3 0 5.4 3.6 9.3 9.4 9.3z'

/**
 * A text's colour as a style: svgDoc's `text{fill:var(--ink)}` rule beats a `fill` attribute, so an
 * attribute left every label and the agents' count in ink (black on the accent, 2026-10-16).
 */
function fillOf(fill: string): string {
  return ' style="fill:' + fill + '"'
}

/** A label drawn at 12 px, centred on `cx`, on a control `h` high. */
function label(text: string, cx: number, h: number, fill: string, weight: number): string {
  return '<text x="' + r(cx) + '" y="' + r(h / 2 + 12 * 0.36) + '" text-anchor="middle" font-size="12" font-weight="' + weight + '"' + fillOf(fill) + '>' + esc(text) + '</text>'
}

/** The pictures of the flat skin for one appearance: the theme's palette, fixed or following the app. */
export function flatPictures(appearance: Appearance): Paint {
  const doc = (w: number, h: number, body: string, css = ''): string => svgDoc(w, h, appearance, body, STILL + css)
  /** A rule for `sel` that follows the theme: `light` on a light app, `dark` on a dark one. */
  const themed = (sel: string, light: string, dark: string): string =>
    appearance === 'dark' ? sel + '{' + dark + '}' : appearance === 'light' ? sel + '{' + light + '}' : sel + '{' + light + '}@media (prefers-color-scheme:dark){' + sel + '{' + dark + '}}'
  /** A control's icon with a count in an accent disc on its shoulder, one width whatever the count. */
  const counted = (icon: Icon, count: number, on: boolean): string => {
    const text = count > 9 ? '9+' : String(count)
    const badge = count > 0
      ? '<circle cx="19.2" cy="4.8" r="4.8" fill="' + ACCENT + '"/><text x="19.2" y="7.6" text-anchor="middle" font-size="' + (text.length > 1 ? 6 : 7.8) + '" font-weight="750"' + fillOf('#fff') + '>' + text + '</text>'
      : ''
    return doc(countedWidth(count), 16, '<g transform="translate(0 .5)" fill="none" stroke="' + (on ? ACCENT : MUTED) + '" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round">' + ICON[icon] + '</g>' + badge)
  }

  return {
    // The capsule is the app's own surface, as its prompt box is: white on a light app, its dark
    // surface on a dark one (the app's bg-000, read from its stylesheet 2026-10-16). A grey tint
    // over the host's slot read as a dark block beside the prompt box.
    sea: (width, height) => doc(width, height, '<rect class="s" width="' + r(width) + '" height="' + r(height) + '" rx="9"/>', themed('.s', 'fill:#ffffff', 'fill:#30302e')),

    // Flat has no water and so no current: work reads from 리플이's face and the band's own words.
    current: () => '',

    // The capsule's own surface: it hides the words beneath a tip.
    plate: (width, height) => doc(width, height, '<rect class="p" width="' + r(width) + '" height="' + r(height) + '"/>', themed('.p', 'fill:#ffffff', 'fill:#30302e')),

    // On: the accent's track and a white knob at the right; off: an outline and a quiet knob at the left.
    switch: (on, busy = false) =>
      doc(SWITCH_W, SWITCH_H, on
        ? '<rect x="2" y="2" width="32" height="18" rx="9" fill="' + ACCENT + '"/><circle class="' + (busy ? 'pu' : '') + '" cx="25" cy="11" r="6" fill="#fff"/>'
        : '<rect x="2.5" y="2.5" width="31" height="17" rx="8.5" fill="none" stroke="' + MUTED + '"/><circle cx="11" cy="11" r="5" fill="' + MUTED + '"/>',
      '.pu{animation:pu 1.3s ease-in-out infinite}@keyframes pu{50%{opacity:.5}}'),

    // The Auto word: on, the accent's wash with the word in the accent; off, a quiet outline.
    word: (text, on, busy = false) => {
      const cells = Math.ceil((labelPx(text, 12) + 22) / CELL_PX)
      const w = cells * CELL_PX
      const h = CONTROL_PX
      const frame = '<rect class="' + (busy && on ? 'pu' : '') + '" x="1" y="1" width="' + r(w - 2) + '" height="' + (h - 2) + '" rx="' + RX + '" fill="' + (on ? WASH : FILL) + '" stroke="' + (on ? LINE : STROKE) + '"/>'
      return { source: doc(w, h, frame + label(text, w / 2, h, on ? ACCENT : MUTED, on ? 650 : 500), '.pu{animation:pu 1.3s ease-in-out infinite}@keyframes pu{50%{stroke-opacity:.25}}'), cells }
    },

    extraHover: widthPx => doc(widthPx, CONTROL_PX, '<rect x="0" y="1" width="' + r(widthPx) + '" height="' + (CONTROL_PX - 2) + '" fill="' + INK + '" fill-opacity=".06"/>'),

    // A ghost button is the page's tint with a hairline; the one thing to press is the accent's fill.
    pill: (text, look, _tone, glyph) => {
      const gw = glyph ? 18 : 0
      const cells = (labelPx(text, 12) + 20 + gw) / CELL_PX
      const w = cells * CELL_PX
      const h = CONTROL_PX
      const ink = look === 'primary' ? '#fff' : INK
      let body = look === 'primary'
        ? '<rect x="1" y="1" width="' + r(w - 2) + '" height="' + (h - 2) + '" rx="' + RX + '" fill="' + PRIMARY + '"/>'
        : '<rect x="1" y="1" width="' + r(w - 2) + '" height="' + (h - 2) + '" rx="' + RX + '" fill="' + FILL + '" stroke="' + STROKE + '"/>'
      const textW = labelPx(text, 12)
      const x0 = (w - textW - gw) / 2
      if (glyph) body += '<g transform="translate(' + r(x0) + ' ' + (h / 2 - 6) + ')" fill="none" stroke="' + ink + '" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' + GLYPH[glyph] + '</g>'
      body += label(text, x0 + gw + textW / 2, h, ink, look === 'primary' ? 650 : 550)
      return { source: doc(w, h, body), cells }
    },

    // One track, the chosen segment a lozenge in the accent's wash, named in the accent.
    segmented: (labels, cells, chosen) => {
      const h = CONTROL_PX
      const w = cells.reduce((n, c) => n + c, 0) * CELL_PX
      let body = '<rect x=".5" y=".5" width="' + r(w - 1) + '" height="' + (h - 1) + '" rx="' + (RX + 1) + '" fill="' + FILL + '" stroke="' + STROKE + '"/>'
      let x = 0
      const starts = cells.map(c => {
        const at = x
        x += c * CELL_PX
        return at
      })
      for (let i = 1; i < labels.length; i++) {
        if (i === chosen || i - 1 === chosen) continue
        body += '<rect x="' + r(starts[i]! - 0.5) + '" y="7" width="1" height="' + (h - 14) + '" fill="' + STROKE + '"/>'
      }
      if (chosen >= 0 && chosen < labels.length) {
        body += '<rect x="' + r(starts[chosen]! + 3) + '" y="3" width="' + r(cells[chosen]! * CELL_PX - 6) + '" height="' + (h - 6) + '" rx="' + (RX - 1) + '" fill="' + WASH + '" stroke="' + LINE + '"/>'
      }
      labels.forEach((text, i) => {
        const lit = i === chosen
        body += label(text, starts[i]! + (cells[i]! * CELL_PX) / 2, h, lit ? ACCENT : MUTED, lit ? 650 : 500)
      })
      return doc(w, h, body)
    },

    // A quiet track, the stretch from the middle to the chosen stop in the accent, the knob the accent.
    slider: (count, cellsPerStop, chosen) => {
      const part = cellsPerStop * CELL_PX
      const w = count * part
      const h = 22
      const at = (i: number) => part * (i + 0.5)
      const y = h / 2
      const mid = Math.floor(count / 2)
      const lo = Math.min(mid, chosen)
      const hi = Math.max(mid, chosen)
      let body = '<rect x="' + r(at(0)) + '" y="' + (y - 1.5) + '" width="' + r(at(count - 1) - at(0)) + '" height="3" rx="1.5" fill="' + FAINT + '"/>'
      if (hi > lo) body += '<rect x="' + r(at(lo)) + '" y="' + (y - 1.5) + '" width="' + r(at(hi) - at(lo)) + '" height="3" rx="1.5" fill="' + ACCENT + '"/>'
      for (let i = 0; i < count; i++) {
        if (i === chosen) continue
        body += i === mid
          ? '<rect x="' + r(at(i) - 1) + '" y="' + (y - 5) + '" width="2" height="10" rx="1" fill="' + MUTED + '"/>'
          : '<circle cx="' + r(at(i)) + '" cy="' + y + '" r="2.2" fill="' + MUTED + '" fill-opacity=".6"/>'
      }
      const c = at(chosen)
      body += '<circle cx="' + r(c) + '" cy="' + y + '" r="6.5" fill="' + ACCENT + '"/><circle cx="' + r(c) + '" cy="' + y + '" r="2.4" fill="#fff" fill-opacity=".95"/>'
      return doc(w, h, body)
    },

    well: (width, height) => doc(width, height, '<rect class="w" x=".5" y=".5" width="' + r(width - 1) + '" height="' + r(height - 1) + '" rx="' + RX + '"/>', themed('.w', 'fill:#fdfcfa;stroke:#a8a49b;stroke-opacity:.7', 'fill:#262624;stroke:#a8a49b;stroke-opacity:.45')),

    close: (lit = false) =>
      doc(CLOSE_PX, CLOSE_PX, (lit ? '<circle cx="11" cy="11" r="10" fill="' + FILL + '" stroke="' + STROKE + '"/>' : '') +
        '<path d="M7.6 7.6l6.8 6.8M14.4 7.6l-6.8 6.8" stroke="' + (lit ? INK : MUTED) + '" stroke-width="1.6" stroke-linecap="round"/>'),

    // Five bars: the accent when Auto chose, ink when the person did, quiet when Auto is off.
    meter: (lit, look) => {
      let bars = ''
      for (let i = 0; i < 5; i++) {
        const bh = 5 + i * 2.75
        const on = look === 'deciding' || i < lit
        const fill = !on ? FAINT : look === 'manual' ? INK : look === 'quiet' ? MUTED : ACCENT
        const wave = look === 'deciding' ? ' class="wa" style="animation-delay:' + r(i * 0.13) + 's"' : ''
        bars += '<rect x="' + r(i * 4.8 + 0.5) + '" y="' + r(METER_H - bh) + '" width="3.4" height="' + r(bh) + '" rx="1.2" fill="' + fill + '"' + wave + '/>'
      }
      return doc(METER_W, METER_H, bars, '.wa{animation:wa 1.15s ease-in-out infinite;opacity:.3}@keyframes wa{0%,100%{opacity:.25}40%{opacity:1}}')
    },

    ring: (percent, tone) => {
      const rad = 6
      const c = 2 * Math.PI * rad
      const share = Math.max(0, Math.min(1, percent / 100))
      const dash = r((c * Math.round(share * 100)) / 100)
      return doc(16, 16,
        '<circle cx="8" cy="8" r="' + rad + '" fill="none" stroke="' + FAINT + '" stroke-width="2.4"/>' +
        '<circle cx="8" cy="8" r="' + rad + '" fill="none" stroke="' + (tone === 'ink' ? INK : toneVar(tone)) + '" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="' + dash + ' ' + r(c) + '" transform="rotate(-90 8 8)"/>')
    },

    clock: (share, tone) => {
      const c = 8
      const rad = 6.4
      const left = Math.max(0, Math.min(1, share))
      const fill = tone === 'soft' ? MUTED : toneVar(tone)
      const pr = rad - 1.8
      let pie = ''
      if (left >= 0.999) pie = '<circle cx="' + c + '" cy="' + c + '" r="' + r(pr) + '" fill="' + fill + '"/>'
      else if (left > 0.001) {
        const a = (2 * Math.PI * Math.round(left * 12)) / 12
        pie = '<path d="M' + c + ' ' + c + 'V' + r(c - pr) + 'A' + r(pr) + ' ' + r(pr) + ' 0 ' + (a > Math.PI ? 1 : 0) + ' 1 ' + r(c + pr * Math.sin(a)) + ' ' + r(c - pr * Math.cos(a)) + 'Z" fill="' + fill + '"/>'
      }
      return doc(16, 16, '<circle cx="' + c + '" cy="' + c + '" r="' + rad + '" fill="none" stroke="' + fill + '" stroke-opacity=".75" stroke-width="1.3"/>' + pie)
    },

    gauge: kind =>
      doc(16, 16,
        '<path d="M1.8 11.4A6.2 6.2 0 0 1 14.2 11.4" fill="none" stroke="' + MUTED + '" stroke-opacity=".8" stroke-width="1.3" stroke-linecap="round"/>' +
        '<path d="' + (kind === 'seven_day' ? 'M8 11.4L11.4 7.6' : 'M8 11.4L8 6.5') + '" fill="none" stroke="' + MUTED + '" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11.4" r="1.2" fill="' + MUTED + '"/>'),

    // Quiet ink at rest, the accent when on: the lit flame is filled, still.
    icon: (icon, on) => {
      if (icon === 'flame' && on) return doc(ICON_PX, ICON_PX, '<path fill="' + ACCENT + '" d="' + FLAME + '"/>')
      return doc(ICON_PX, ICON_PX, '<g fill="none" stroke="' + (on ? ACCENT : MUTED) + '" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round">' + ICON[icon] + '</g>')
    },

    agents: (count, on) => counted('agents', count, on),
    counted: (icon, count, on) => counted(icon, count, on),

    rule: () => doc(9, 16, '<rect x="4" y="1" width="1" height="14" rx=".5" fill="' + STROKE + '"/>'),

    // A tile's picture: a rounded square of the page's tint, the setting drawn in the accent while it
    // is on (or chosen), in quiet ink while it is off. Still.
    tile: art => {
      const s = TILE_PX
      const square = '<rect x="1" y="1" width="' + (s - 2) + '" height="' + (s - 2) + '" rx="11" fill="' + FILL + '" stroke="' + STROKE + '"/>'
      if (art.kind === 'effort') {
        let bars = ''
        for (let i = 0; i < 5; i++) {
          const bh = 7 + i * 4.2
          bars += '<rect x="' + r(9.2 + i * 5.4) + '" y="' + r(34 - bh) + '" width="3.6" height="' + r(bh) + '" rx="1.4" fill="' + (art.on ? ACCENT : MUTED) + '" fill-opacity="' + (art.on ? 1 : 0.5) + '"/>'
        }
        return doc(s, s, square + bars)
      }
      if (art.kind === 'judge') {
        const mark = art.judge === 'model'
          ? '<g fill="none" stroke="' + ACCENT + '" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="29" r="3.2"/><circle cx="31" cy="15" r="3.2"/><path d="M16 27.5c6-1.5 4-9 12-11"/></g>'
          : '<text x="22" y="29.5" text-anchor="middle" font-size="21" font-weight="760"' + fillOf(ACCENT) + '>' + (art.judge === 'haiku' ? 'H' : 'J') + '</text>'
        return doc(s, s, square + mark)
      }
      if (art.kind === 'mode') {
        const card = (y: number, top: boolean) =>
          '<rect x="11" y="' + y + '" width="22" height="9" rx="2.6" fill="' + (top && art.on ? WASH : 'none') + '" stroke="' + (top && art.on ? ACCENT : MUTED) + '" stroke-opacity="' + (top && art.on ? 1 : 0.55) + '" stroke-width="1.4"/>'
        const face = art.on ? '<circle cx="15.5" cy="19.5" r="1.4" fill="' + ACCENT + '"/><rect x="19" y="18.6" width="10" height="1.8" rx=".9" fill="' + ACCENT + '" fill-opacity=".7"/>' : ''
        return doc(s, s, square + card(28, false) + card(21.5, false) + card(15, true) + face)
      }
      if (art.kind === 'skin') {
        return doc(s, s, square +
          '<rect x="10.5" y="12.5" width="23" height="19" rx="3.5" fill="' + WASH + '" stroke="' + ACCENT + '" stroke-width="1.6"/>' +
          '<circle cx="16" cy="18.5" r="2" fill="' + ACCENT + '"/>' +
          '<path d="M20.5 18.5h8M15 24h12M15 27.5h8" fill="none" stroke="' + ACCENT + '" stroke-width="1.6" stroke-linecap="round"/>')
      }
      if (art.on) return doc(s, s, square + '<path d="' + TILE_FLAME + '" fill="' + ACCENT + '"/>')
      const arm = (a: number) => '<g transform="rotate(' + a + ' 22 22)"><path d="M22 9v26M22 13l-3-3M22 13l3-3M22 31l-3 3M22 31l3 3"/></g>'
      return doc(s, s, square + '<g fill="none" stroke="' + MUTED + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + arm(0) + arm(60) + arm(120) + '</g>')
    },

    beads: (step, total) => {
      const gap = 16
      const w = gap * (total - 1) + 16
      let body = '<rect x="8" y="7.4" width="' + (w - 16) + '" height="1.2" rx=".6" fill="' + FAINT + '"/>'
      for (let i = 1; i <= total; i++) {
        const cx = 8 + (i - 1) * gap
        if (i < step) body += '<circle cx="' + cx + '" cy="8" r="3.6" fill="' + ACCENT + '"/>'
        else if (i === step) body += '<circle cx="' + cx + '" cy="8" r="7" fill="' + WASH + '"/><circle cx="' + cx + '" cy="8" r="4.2" fill="' + ACCENT + '"/>'
        else body += '<circle cx="' + cx + '" cy="8" r="3.4" fill="' + FILL + '" stroke="' + STROKE + '"/>'
      }
      return { source: doc(w, 16, body), width: w }
    },
  }
}
