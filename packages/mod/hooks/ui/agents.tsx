// The Agents pane: every subagent of this session as a card of its own — what it does, the model it
// ran on and at what effort, the tokens it read and wrote, its tools, how long, who picked it and
// why — and, pressed, its conversation, read in the pane. Running agents first, then the finished
// ones, newest first (the latest few, the rest a press away).
//
// The tokens are the API's own counts, summed over the agent's steps (register.tsx turn.step):
// input is uncached + cache read + cache write, with the share the cache served, and output. The
// weighted `cost` the pick log keeps disagreed with the host's task list a few lines up, so it is
// not shown (2026-10-20).
//
// The host has no call that takes the app to a subagent's own view, so "open" reads the agent's
// conversation (`$.session.messages({ agentId })`, register.tsx) and draws it here, a way back at
// its head.
//
// The desktop draws the list in one capsule (kit.tsx), each agent a tile on it, the whole tile its
// press. The conversation reads on the host's own page under its card's capsule: Markdown takes the
// host's ink and no colour of ours, so on the deep's dark water it would vanish on a light app.
//
// 리플이 only where nothing redraws: the empty pane, and the list's head while nothing runs. Each
// running agent's step and the pane's one-second clock redraw it, and every redraw starts the
// mascot's motion over; so while one runs the water holds still and no mascot is drawn.

import { t } from '../i18n'
import type { RenderNode, SessionMessage } from 'claude-code'

import type { AgentRec, Effort } from '../../types'
import { bareTitle } from '../workers'
import { CELL_PX, CONTROL_PX, METER_H, METER_W } from './art'
import { blank, capsule, pic, pill, press, ripple, rowsOf } from './kit'
import { lookOf } from './look'
import type { Look } from './look'
import { GREET_SIZE, canDraw, speak, textButton } from './parts'
import type { Els } from './parts'
import { chOf, clip, displayWidth, providerColor, textTone } from './theme'
import { runSummary, toolDetail } from './tools'
import type { Place, ToolCall } from './tools'
import type { AgentEntry, AgentTalk, AgentsActions, AgentsView, Frame } from './view'
import { cachePercent, compactNumber, effortIndex, effortLabel, elapsed, modelName, promptTokens, targetLabel } from './view'

// Every `by` a pick can carry: a missing one handed t() no key, which threw and left the whole pane
// undrawn ("Nothing to show yet") once a worker ran on the session's model (2026-10-16).
const BY: Record<NonNullable<AgentRec['pick']>['by'] | 'tier', string> = { haiku: 'settings.haiku', jev: 'settings.jev', model: 'agents.routerModel', marker: 'agents.marker', default: 'agents.default', session: 'agents.session', tier: 'toasts.yourPick' }

/** Finished agents the list shows before "more". */
export const DONE_SHOWN = 4
/**
 * Characters of the conversation drawn in all, about: a tree draws 100,000 characters (the engine's
 * cut), and the card and the page's chrome take some. Only a conversation past it loses its oldest
 * entries; any other shows whole, as the Claude app's chat does.
 */
export const TALK_CHARS = 80_000
/** Characters of a text entry drawn. */
const TEXT_MAX = 3000
const PROMPT_MAX = 2400
const ANSWER_MAX = 12000

function live(agent: AgentRec): boolean {
  return agent.state === 'running' || agent.state === 'waiting'
}

/** A title without the model tag the spawn put in front of it: the card names the model itself. */
function titleOf(agent: AgentRec): string {
  return bareTitle(agent.description)
}

/** A model id without its `@effort`. */
function base(id: string): string {
  return id.replace(/@[^@]*$/, '')
}

/** The model it ran on: what answered, else what it was started on, else the pick's target, else its type. */
export function modelOf(agent: AgentRec, lang: Frame['lang']): string {
  // A hosted id's vendor path ("deepseek-ai/") goes, as in the agent's title (workers.ts titleName).
  if (agent.answeredBy) return modelName(base(agent.answeredBy)).replace(/^.*\//, '')
  if (agent.model && agent.model !== 'inherit') return modelName(base(agent.model)).replace(/^.*\//, '')
  return agent.pick ? targetLabel(agent.pick.target, lang) : agent.type
}

/** The effort it ran at: what its last step was sent at, else the pick's, else its model id's `@effort`. */
export function effortOf(agent: AgentRec): string | undefined {
  const value = agent.effort ?? agent.pick?.effort ?? /@([a-z]+)$/.exec(agent.model ?? '')?.[1]
  return value === undefined ? undefined : String(value)
}

/** The type only when it says something the model does not (Explore, Plan, a named agent). */
function typeOf(agent: AgentRec, model: string): string {
  const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!agent.type || agent.type === 'general-purpose' || agent.type === 'ripple:auto' || flat(model).includes(flat(agent.type))) return ''
  return agent.type
}

/** Why this model: who chose it, their reason, and the measured score behind an Auto pick. */
function whyLine(frame: Frame, agent: AgentRec): string {
  const pick = agent.pick
  if (!pick) return ''
  const parts = [t(frame.lang, 'agents.by', { name: t(frame.lang, BY[pick.by]) }) + ' · ' + t(frame.lang, 'agents.domainLevel', { domain: t(frame.lang, 'workers.' + pick.domain), level: t(frame.lang, 'settings.' + pick.level) }) + (pick.rung ? ' · ' + (pick.rule ?? 'general') + '/' + t(frame.lang, 'workers.rung.' + pick.rung) : '')]
  if (pick.why) parts.push('“' + pick.why + '”')
  return parts.join(' · ')
}

/** How long it ran, or has run so far. */
function ranFor(agent: AgentRec, now: number, lang: Frame['lang']): string {
  return elapsed((live(agent) ? now : agent.endedAt ?? agent.startedAt) - agent.startedAt, lang)
}

/** What it is doing now, and for how long. */
function doing(agent: AgentRec, now: number, lang: Frame['lang']): string {
  if (agent.now) return clip(agent.now, 70) + (agent.toolSince ? ' · ' + elapsed(now - agent.toolSince, lang) : '')
  return t(lang, 'agents.thinking')
}

type Figure = { key: string; label: string; value: string; ring?: number }

/** Its numbers: input (all of the prompt), the share the cache served, output, tool calls. */
function figures(frame: Frame, agent: AgentRec): Figure[] {
  const L = frame.lang
  const out: Figure[] = []
  const u = agent.usage
  if (u) {
    out.push({ key: 'in', label: t(L, 'agents.input'), value: compactNumber(promptTokens(u)) })
    const cache = cachePercent(u)
    if (cache !== undefined) out.push({ key: 'cache', label: t(L, 'agents.cache'), value: cache + '%', ring: cache })
    out.push({ key: 'out', label: t(L, 'agents.output'), value: compactNumber(u.output) })
  }
  if (agent.tools) out.push({ key: 'tools', label: t(L, 'agents.toolsLabel'), value: String(agent.tools) })
  return out
}

/** The numbers as one line of text (the terminal's). */
function figureLine(frame: Frame, agent: AgentRec): string {
  return figures(frame, agent).map(f => f.label + ' ' + f.value).join(' · ')
}

/** All agents' input and output, for the list's head. */
function totals(frame: Frame, agents: readonly AgentRec[]): string {
  let input = 0
  let output = 0
  for (const a of agents) if (a.usage) { input += promptTokens(a.usage); output += a.usage.output }
  if (!input && !output) return ''
  return t(frame.lang, 'agents.input') + ' ' + compactNumber(input) + ' · ' + t(frame.lang, 'agents.output') + ' ' + compactNumber(output)
}

// ---- Conversation, read ----------------------------------------------------------------------

/**
 * An agent's conversation as the pane draws it: each prompt it was given, its words, and each tool
 * call with a line of its input (tools.ts `toolDetail`: paths short against `place`) and whether it
 * answered (a call's `text` is there once answered, also in a subagent's transcript, which keeps no
 * `result`; `isError` when it failed).
 */
export function talkOf(messages: readonly SessionMessage[], place: Place = {}): AgentEntry[] {
  const out: AgentEntry[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.text.trim()) out.push({ kind: 'prompt', text: m.text.trim() })
      continue
    }
    if (m.text.trim()) out.push({ kind: 'text', text: m.text.trim() })
    for (const use of m.toolUses) out.push({ kind: 'tool', id: use.tool_use_id, tool: use.tool, detail: toolDetail(use.tool, use.input, place), state: use.isError ? 'error' : use.text === undefined && use.result === undefined ? 'running' : 'ok' })
  }
  return out
}

/** Cuts a long text at `max` characters, saying so. */
function cut(text: string, max: number): string {
  return text.length > max ? text.slice(0, max).trimEnd() + ' …' : text
}

type Page = { first?: AgentEntry; dropped: number; shown: AgentEntry[]; answer?: string }

/** Characters an entry draws, about: its text as cut, or a tool call's line. */
function weight(entry: AgentEntry): number {
  if (entry.kind === 'tool') return (entry.detail?.length ?? 0) + 40
  return Math.min(entry.text.length, entry.kind === 'prompt' ? PROMPT_MAX : TEXT_MAX) + 40
}

/**
 * What the page shows: the first prompt always (what it was asked), every entry after it, and a
 * finished agent's last words as its answer. Every entry, with no "earlier" to press: the owner
 * read the agent's words behind it as hidden (2026-10-20). Only past TALK_CHARS do the oldest go,
 * counted in `dropped`.
 */
function pageOf(entries: readonly AgentEntry[], finished: boolean): Page {
  const first = entries[0]?.kind === 'prompt' ? entries[0] : undefined
  let rest = first ? entries.slice(1) : [...entries]
  const last = rest.at(-1)
  const answer = finished && last?.kind === 'text' ? last.text : undefined
  if (answer !== undefined) rest = rest.slice(0, -1)
  let room = TALK_CHARS - (first ? weight(first) : 0) - Math.min(answer?.length ?? 0, ANSWER_MAX)
  let from = rest.length
  while (from > 0 && room - weight(rest[from - 1]!) >= 0) room -= weight(rest[--from]!)
  return { ...(first ? { first } : {}), dropped: from, shown: rest.slice(from), ...(answer !== undefined ? { answer } : {}) }
}

// ---- Desktop: the cards ------------------------------------------------------------------------

/** Cells of text a card has across: the pane less the capsule's and the tile's air and edges. */
function innerCells(frame: Frame): number {
  return Math.max(20, frame.columns - 9)
}

/** Rows `text` takes at `width` cells, about. */
function linesOf(text: string, width: number): number {
  return text ? Math.max(1, Math.ceil(chOf(text) / Math.max(10, width))) : 0
}

// A card holds still while its agent runs (2026-10-20: the owner watched the pane jump each step).
// No row comes or goes and no row's width depends on a value that ticks: what it does now is left to
// the conversation and the host's task list, the elapsed time has a column as wide as its widest
// value, and each number a slot as wide as its widest. Only the numbers inside change.

const TIME_COLUMN = new Map<Frame['lang'], number>()

/** `ch` the elapsed time can take in `lang`: 59 seconds, 59 minutes 59, 99 hours 59. */
function timeCh(lang: Frame['lang']): number {
  let ch = TIME_COLUMN.get(lang)
  if (ch === undefined) {
    ch = Math.max(...[59_000, 3_599_000, 99 * 3_600_000 + 59 * 60_000].map(ms => chOf(elapsed(ms, lang))))
    TIME_COLUMN.set(lang, ch)
  }
  return ch
}

/** Cells "failed" takes before the time when it failed. */
function failedCells(frame: Frame, agent: AgentRec): number {
  return agent.state === 'failed' ? Math.ceil(chOf(t(frame.lang, 'agents.failed'))) + 1 : 0
}

/** Cells of the time's column: the elapsed time's widest, and "failed" before it when it failed. */
export function timeCells(frame: Frame, agent: AgentRec): number {
  return Math.ceil(timeCh(frame.lang)) + failedCells(frame, agent)
}

/**
 * Cells the time needs at the end of the numbers' last row: an hour's worth ("59분 59초"). It ends the
 * row right-aligned, so a longer one only grows leftward into the row's slack; reserving 99 hours there
 * left the time a row of its own on a narrow pane (2026-10-20).
 */
function tailCells(frame: Frame, agent: AgentRec): number {
  return Math.ceil(chOf(elapsed(3_599_000, frame.lang))) + failedCells(frame, agent)
}

/** The widest each number shows, for its slot. */
const WIDEST: Record<string, readonly string[]> = { in: ['9.9k', '999k', '99.9M'], cache: ['100%'], out: ['9.9k', '999k', '99.9M'], tools: ['999'] }

/** Cells of a number's slot. */
function slotCells(key: string): number {
  return Math.ceil(Math.max(...(WIDEST[key] ?? ['999']).map(chOf)))
}

/**
 * The card's numbers: all four, each in its slot, once there is any (a running agent always, its
 * figures a dash until its first step reports them), so the row neither appears mid-run nor wraps
 * differently as a figure grows.
 */
function cardFigures(frame: Frame, agent: AgentRec): Figure[] {
  const got = figures(frame, agent)
  if (!got.length && !live(agent)) return []
  const L = frame.lang
  const of = (key: string, label: string): Figure => got.find(f => f.key === key) ?? { key, label, value: key === 'tools' ? String(agent.tools ?? 0) : '–' }
  return [of('in', t(L, 'agents.input')), of('cache', t(L, 'agents.cache')), of('out', t(L, 'agents.output')), of('tools', t(L, 'agents.toolsLabel'))]
}

/** Cells a row of figures takes in one line: each figure's ring slot, label and number slot, the gaps. */
function figureCells(figs: readonly Figure[]): number {
  return figs.reduce((n, f) => n + (f.key === 'cache' ? 3 : 0) + Math.ceil(chOf(f.label)) + 1 + slotCells(f.key), 0) + 2 * Math.max(0, figs.length - 1)
}

/** Below this many cells across a card, the narrow layout. */
const NARROW_CELLS = 44

/**
 * How a card lays out, from the pane's width and its language alone, never a value that ticks.
 * Wide: the time and the chevron in a fixed column right of the title, the four numbers in a row.
 * Narrow (or when the four numbers would not fit a row): the numbers go in two fixed rows (in · cache /
 * out · tools) and the time ends the second of them; the title has its row to itself but for the
 * chevron, or, when the time does not fit by the numbers, beside the time in the head. The time never
 * takes a row of its own (2026-10-20: a whole row for one value was the owner's complaint).
 */
type CardLayout = { width: number; narrow: boolean; time: number; timeOn: 'head' | 'nums'; side: number; title: number }
function layoutOf(frame: Frame, agent: AgentRec, pressable: boolean): CardLayout {
  const width = innerCells(frame)
  const figs = cardFigures(frame, agent)
  const narrow = width < NARROW_CELLS || figureCells(figs) > width - 2
  const time = timeCells(frame, agent)
  const timeOn = narrow && figs.length && figureCells(figs.slice(2)) + 2 + tailCells(frame, agent) <= width - 2 ? 'nums' : 'head'
  const side = timeOn === 'head' ? time + (pressable ? 2 : 0) : pressable ? 1 : 0
  return { width, narrow, time, timeOn, side, title: width - 2 - (side ? side + 1 : 0) }
}

/** The figures' rows: one, or two fixed ones when narrow. */
function figureRows(figs: readonly Figure[], narrow: boolean): Figure[][] {
  if (!figs.length) return []
  return narrow ? [figs.slice(0, 2), figs.slice(2)] : [[...figs]]
}

/** Cells the model's name has on its one line: the row less the dot, the effort and the type. */
function modelRoom(frame: Frame, agent: AgentRec, type: string, word: boolean): number {
  const effort = effortOf(agent)
  const effortCells = effort ? 1 + Math.ceil(METER_W / CELL_PX) + 1 + (word ? Math.ceil(chOf(effortLabel(effort, frame.lang))) + 1 : 0) : 0
  return innerCells(frame) - 2 - (agent.provider ? 2 : 0) - effortCells - (type ? Math.ceil(chOf('· ' + type)) + 1 : 0)
}

/**
 * What the model row shows beside the name: the type while the name keeps room, and the effort's
 * word while the whole name fits with it (its bars stay, and say the level). Fixed per agent and
 * width, so the row never changes between ticks.
 */
function modelRow(frame: Frame, agent: AgentRec, model: string): { type: string; word: boolean; room: number } {
  const full = typeOf(agent, model)
  const type = modelRoom(frame, agent, full, true) >= 8 ? full : ''
  const word = modelRoom(frame, agent, type, true) >= chOf(model)
  return { type, word, room: modelRoom(frame, agent, type, word) }
}

/** Lines a card's title takes at most; the rest is cut with an ellipsis. */
const TITLE_LINES = 2

/**
 * The title cut to two lines of `cells`: a few cells short of two full ones, as wrapping at words
 * leaves the end of a line empty.
 */
function cardTitle(agent: AgentRec, cells: number): string {
  return clipCh(titleOf(agent), TITLE_LINES * Math.max(10, cells) - 4)
}

/** Rows a card draws, about: for the presses laid over it and the capsule's water. */
export function cardRows(frame: Frame, agent: AgentRec, pressable = true): number {
  const layout = layoutOf(frame, agent, pressable)
  const head = Math.min(TITLE_LINES, linesOf(cardTitle(agent, layout.title), layout.title))
  const nums = figureRows(cardFigures(frame, agent), layout.narrow).length
  const fall = agent.pick?.fallbackReason ? linesOf(t(frame.lang, 'agents.fallback', { reason: agent.pick.fallbackReason }), layout.width - 2) : 0
  return head + 1.2 + nums + fall + 1.3
}

/** A state's mark and its colour: running in the accent, waiting amber, done green, failed red. */
function mark(k: Look, agent: AgentRec): { glyph: string; color: string } {
  if (agent.state === 'running') return { glyph: '●', color: k.tone('violet') }
  if (agent.state === 'waiting') return { glyph: '◐', color: k.tone('amber') }
  if (agent.state === 'done') return { glyph: '✓', color: k.tone('green') }
  return { glyph: '✕', color: k.tone('red') }
}

/** The blank presses over a card, one a row: the host's button is one line high, a card several. */
function cardPress(el: Els, frame: Frame, key: string, rows: number, onPress: () => void): RenderNode {
  const { Box, Button } = el
  const label = blank((frame.columns - 4) * CELL_PX)
  const strips: RenderNode[] = []
  for (let i = 0; i < Math.ceil(rows) + 1; i++) {
    strips.push(
      <Box key={'strip-' + i} height={1} flexShrink={0} alignItems="center" justifyContent="center" overflow="hidden">
        <Button key={key + '-' + i} plain label={label} onPress={() => onPress()} />
      </Box>,
    )
  }
  return (
    <Box position="absolute" top={0} bottom={0} left={0} right={0} flexDirection="column" overflow="hidden">
      {strips}
    </Box>
  )
}

/**
 * A card's rows: the head (mark, title, time), the model and effort, the numbers, why. What it does
 * now is the conversation's (and the terminal's): a line that changed each step made the list jump.
 */
function cardBody(el: Els, frame: Frame, agent: AgentRec, now: number, pressable: boolean): RenderNode[] {
  const { Box, Text } = el
  const k = lookOf(frame)
  const L = frame.lang
  const m = mark(k, agent)
  const model = modelOf(agent, L)
  const effort = effortOf(agent)
  const layout = layoutOf(frame, agent, pressable)
  // The type only while the model's name keeps room beside it.
  const { type, word, room } = modelRow(frame, agent, model)
  const nums = figureRows(cardFigures(frame, agent), layout.narrow)
  const auto = agent.pick && ['haiku', 'jev', 'model'].includes(agent.pick.by)
  // In the head a column as wide as its widest value; at the end of the numbers, right-aligned in
  // the row's slack (layoutOf), as wide as it is.
  const time = (
    <Box key="time" flexDirection="row" justifyContent="flex-end" columnGap={1} flexShrink={0} {...(layout.timeOn === 'head' ? { width: layout.time } : {})}>
      {agent.state === 'failed' ? <Text key="failed" color={k.tone('red')}>{t(L, 'agents.failed')}</Text> : null}
      <Text key="elapsed" {...(live(agent) ? k.ink : k.sub)}>{ranFor(agent, now, L)}</Text>
    </Box>
  )
  const rows: RenderNode[] = [
    <Box key="head" flexDirection="row" alignItems="flex-start" columnGap={1} width="100%" minWidth={0}>
      <Box key="mark" flexShrink={0}>
        <Text color={m.color} bold>{m.glyph}</Text>
      </Box>
      <Box key="title" flexGrow={1} flexShrink={1} minWidth={0}>
        <Text bold {...k.ink} wrap="wrap">{cardTitle(agent, layout.title)}</Text>
      </Box>
      {layout.side ? (
        <Box key="side" flexDirection="row" justifyContent="flex-end" columnGap={1} flexShrink={0} width={layout.side}>
          {layout.timeOn === 'head' ? time : null}
          {pressable ? <Text key="chev" {...k.mute}>›</Text> : null}
        </Box>
      ) : null}
    </Box>,
    // One line whatever the width: the name cut before the effort ever drops below it.
    <Box key="ident" flexDirection="row" alignItems="center" columnGap={1} paddingLeft={2} minWidth={0} overflow="hidden">
      {agent.provider ? <Box key="dot" flexShrink={0}><Text color={providerColor(agent.provider)}>●</Text></Box> : null}
      <Box key="model" flexShrink={1} minWidth={0} overflow="hidden">
        <Text {...k.ink}>{clipCh(model, Math.max(4, room))}</Text>
      </Box>
      {effort ? (
        <Box key="effort" flexDirection="row" alignItems="center" columnGap={1} flexShrink={0} paddingLeft={1}>
          {pic(el, 'meter-' + agent.id, k.art.meter(effortIndex(effort as Effort) + 1, auto ? 'auto' : 'manual'), t(L, 'band.effort'), METER_W, METER_H)}
          {word ? <Text key="effort-word" {...k.sub}>{effortLabel(effort, L)}</Text> : null}
        </Box>
      ) : null}
      {type ? <Box key="type" flexShrink={0}><Text {...k.mute}>{'· ' + type}</Text></Box> : null}
    </Box>,
  ]
  nums.forEach((row, i) => {
    const last = i === nums.length - 1
    rows.push(
      <Box key={'nums-' + i} flexDirection="row" alignItems="center" columnGap={2} paddingLeft={2} minWidth={0}>
        {row.map(f => (
          <Box key={'n-' + f.key} flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
            {f.key === 'cache' ? (
              <Box key="ring" width={2} flexShrink={0} alignItems="center">
                {f.ring !== undefined ? pic(el, 'ring-' + agent.id, k.art.ring(f.ring, 'ink'), f.label, 16, 16) : null}
              </Box>
            ) : null}
            <Text key="label" {...k.mute}>{f.label}</Text>
            <Box key="value" width={slotCells(f.key)} flexShrink={0}>
              <Text {...k.ink}>{f.value}</Text>
            </Box>
          </Box>
        ))}
        {last && layout.timeOn === 'nums' ? <Box key="gap" flexGrow={1} /> : null}
        {last && layout.timeOn === 'nums' ? time : null}
      </Box>,
    )
  })
  if (agent.pick?.fallbackReason) {
    rows.push(
      <Box key="fallback" paddingLeft={2} minWidth={0}>
        <Text color={k.tone('amber')} wrap="wrap">{t(L, 'agents.fallback', { reason: agent.pick.fallbackReason })}</Text>
      </Box>,
    )
  }
  return rows
}

/** One agent's tile; pressed, its conversation. */
function card(el: Els, frame: Frame, agent: AgentRec, now: number, onPress?: () => void): RenderNode {
  const { Box } = el
  const k = lookOf(frame)
  return (
    <Box key={'card-' + agent.id} flexDirection="column" width="100%" minWidth={0} paddingX={1.5} paddingY={0.5} {...k.tile}>
      {cardBody(el, frame, agent, now, !!onPress)}
      {onPress ? cardPress(el, frame, 'open-' + agent.id, cardRows(frame, agent), onPress) : null}
    </Box>
  )
}

/** The list on the desktop: one capsule, its head, the running agents' tiles, then the finished. */
function listDrawn(el: Els, frame: Frame, view: AgentsView, actions: AgentsActions, running: AgentRec[], done: AgentRec[]): RenderNode {
  const { Box, Text } = el
  const k = lookOf(frame)
  const L = frame.lang
  const idle = running.length === 0
  const shownDone = view.showDone ? done : done.slice(0, DONE_SHOWN)
  const total = totals(frame, view.agents)
  const face = 32
  // The head says what all of them took; each group's count heads the group.
  const head = (
    <Box key="agents-head" flexDirection="row" alignItems="center" columnGap={2} width="100%" minWidth={0}>
      {idle ? ripple(el, frame, 'agents', 'calm', t(L, 'band.brand'), face) : null}
      <Box key="agents-say" flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
        <Box flexDirection="row" alignItems="center" columnGap={1} flexWrap="wrap">
          <Text bold {...k.ink}>{t(L, 'agents.title')}</Text>
          <Text {...k.mute}>{t(L, 'band.brand')}</Text>
        </Box>
        {total ? (
          <Box flexDirection="row" columnGap={1} flexWrap="wrap">
            <Text {...k.mute}>{t(L, 'agents.total')}</Text>
            <Text {...k.sub}>{total}</Text>
          </Box>
        ) : null}
      </Box>
    </Box>
  )
  const section = (key: string, label: string) => (
    <Box key={'section-' + key} paddingLeft={0.5} paddingTop={0.5}>
      <Text {...k.mute}>{label}</Text>
    </Box>
  )
  const children: RenderNode[] = [head]
  if (running.length) children.push(section('live', t(L, 'agents.liveCount', { count: running.length })))
  for (const a of running) children.push(card(el, frame, a, view.now, () => actions.open(a.id)))
  if (done.length) children.push(section('done', t(L, 'agents.doneCount', { count: done.length })))
  for (const a of shownDone) children.push(card(el, frame, a, view.now, () => actions.open(a.id)))
  if (done.length > DONE_SHOWN) {
    children.push(
      <Box key="more-row" flexDirection="row" justifyContent="center" width="100%">
        {view.showDone
          ? pill(el, frame, 'done', t(L, 'agents.less'), 'ghost', actions.toggleDone, 'violet', 'back')
          : pill(el, frame, 'done', t(L, 'agents.more', { count: done.length - DONE_SHOWN }), 'ghost', actions.toggleDone, 'violet', 'next')}
      </Box>,
    )
  }
  const rows = 3 + [...running, ...shownDone].reduce((n, a) => n + cardRows(frame, a) + 0.6, 0) + (done.length > DONE_SHOWN ? 2 : 0) + 3
  return capsule(el, frame, {
    key: 'agents',
    // While nothing runs 리플이 floats at the head in calm water; while one runs the water holds
    // still, its light where the title is (the pane redraws each second then).
    sea: idle
      ? { tone: 'violet', ripples: 'calm', motes: true, reach: 110, at: { x: 1.5 * CELL_PX + face / 2, y: 9.5 + face / 2 } }
      : { tone: 'violet', reach: 120, at: { x: 1.5 * CELL_PX + 18, y: 20 } },
    rows,
    paddingY: 1,
    gap: 1,
    children,
  })
}

// ---- Desktop: the conversation -----------------------------------------------------------------

/** The page's own words for the conversation: the host's ink, and its quiet text colour for asides. */
function pageLook(frame: Frame): Look {
  return lookOf({ ...frame, skin: 'flat' })
}

type Mark = 'ok' | 'error' | 'running' | 'unknown'

/** How a call stands: a call still open on an agent that has ended is not running, only unanswered. */
function callMark(call: ToolCall, agentLive: boolean): Mark {
  return call.state === 'running' && !agentLive ? 'unknown' : call.state
}

/** How a run stands: running while one of its calls runs, failed when one failed, done when all answered. */
function runMark(calls: readonly ToolCall[], agentLive: boolean): Mark {
  const marks = calls.map(call => callMark(call, agentLive))
  if (marks.includes('running')) return 'running'
  if (marks.includes('error')) return 'error'
  return marks.every(m => m === 'ok') ? 'ok' : 'unknown'
}

const GLYPH: Record<Mark, string> = { ok: '✓', error: '✕', running: '◌', unknown: '·' }

/** The conversation's entries with each run of consecutive tool calls taken as one. */
type Part = Exclude<AgentEntry, { kind: 'tool' }> | { kind: 'run'; calls: ToolCall[] }
function partsOf(entries: readonly AgentEntry[]): Part[] {
  const out: Part[] = []
  for (const entry of entries) {
    const last = out.at(-1)
    if (entry.kind !== 'tool') out.push(entry)
    else if (last?.kind === 'run') last.calls.push(entry)
    else out.push({ kind: 'run', calls: [entry] })
  }
  return out
}

/**
 * The calls a run shows under its head: every one when it is unfolded, else only the one the agent
 * is in now. A run of a single call is that call's own line, with no head.
 */
function shownCalls(calls: readonly ToolCall[], open: boolean, inFlight: AgentEntry | undefined): readonly ToolCall[] {
  if (calls.length === 1 || open) return calls
  return calls.filter(call => call === inFlight)
}

/** Cells left for a call's input on a line `cells` wide, after its mark, its name and its time. */
function detailRoom(cells: number, call: ToolCall, since: string | undefined): number {
  return Math.max(8, cells - 2 - displayWidth(call.tool) - 1 - (since ? displayWidth(since) + 1 : 0))
}

/**
 * `text` cut to `room` of the desktop's `ch` (theme.ts chOf), an ellipsis where it was cut: the
 * sans draws most characters narrower than a cell, so a cut by cells left a third of the line empty.
 */
function clipCh(text: string, room: number): string {
  if (chOf(text) <= room) return text
  let out = ''
  let used = 0
  for (const char of text) {
    used += chOf(char)
    if (used > room - 1) break
    out += char
  }
  return out.trimEnd() + '…'
}

/**
 * A tool call's row: its mark, its name, its input, on one line however long the input (cut with
 * an ellipsis at the pane's edge; a wrapped command was most of the wall of 2026-10-20).
 */
function toolRow(el: Els, frame: Frame, entry: ToolCall, agentLive: boolean, indent: number, since?: string): RenderNode {
  const { Box, Text } = el
  const k = pageLook(frame)
  const state = callMark(entry, agentLive)
  const color = state === 'ok' ? k.tone('green') : state === 'error' ? k.tone('red') : state === 'running' ? k.tone('violet') : undefined
  return (
    <Box key={'tool-' + entry.id} flexDirection="row" alignItems="center" columnGap={1} paddingLeft={indent} minWidth={0} overflow="hidden">
      <Box key="mark" flexShrink={0}>
        <Text {...(color ? { color } : k.mute)}>{GLYPH[state]}</Text>
      </Box>
      <Box key="name" flexShrink={0}>
        <Text bold {...k.ink}>{entry.tool}</Text>
      </Box>
      {entry.detail ? (
        <Box key="detail" flexShrink={1} minWidth={0} overflow="hidden">
          <Text {...k.sub} wrap="truncate-end">{clipCh(entry.detail, detailRoom(frame.columns - indent - 3, entry, since))}</Text>
        </Box>
      ) : null}
      {since ? <Box key="since" flexShrink={0}><Text color={k.tone('violet')}>{since}</Text></Box> : null}
    </Box>
  )
}

/**
 * A run of tool calls on the page: its head ("명령어 7개 실행함, 파일 1개를 편집함", its mark, how many
 * failed), pressed to unfold it call by call; folded, the call the agent is in now still shows
 * under it. A single call is its own line.
 */
function runDrawn(el: Els, frame: Frame, calls: readonly ToolCall[], agentLive: boolean, open: boolean, inFlight: AgentEntry | undefined, since: string | undefined, onToggle: (id: string) => void): RenderNode {
  const { Box, Text } = el
  const k = pageLook(frame)
  const id = calls[0]!.id
  const rows = shownCalls(calls, open, inFlight).map(call => toolRow(el, frame, call, agentLive, calls.length === 1 ? 0 : 2, call === inFlight ? since : undefined))
  if (calls.length === 1) return <Box key={'run-' + id} flexDirection="column" paddingLeft={1} minWidth={0}>{rows}</Box>
  const summary = runSummary(calls, frame.lang)
  const state = runMark(calls, agentLive)
  const color = state === 'ok' ? k.tone('green') : state === 'error' ? k.tone('red') : state === 'running' ? k.tone('violet') : undefined
  return (
    <Box key={'run-' + id} flexDirection="column" paddingLeft={1} minWidth={0}>
      <Box key="head" flexDirection="row" alignItems="center" columnGap={1} minWidth={0}>
        <Box key="mark" flexShrink={0}>
          <Text {...(color ? { color } : k.mute)}>{GLYPH[state]}</Text>
        </Box>
        <Box key="what" flexShrink={1} minWidth={0} overflow="hidden">
          <Text {...k.sub} wrap="truncate-end">{summary.text}</Text>
        </Box>
        {summary.failed ? (
          <Box key="failed" flexShrink={0}>
            <Text color={k.tone('red')}>{t(frame.lang, 'agents.act.failed', { count: summary.failed })}</Text>
          </Box>
        ) : null}
        <Box key="chev" flexShrink={0}>
          <Text {...k.mute}>{open ? '⌄' : '›'}</Text>
        </Box>
        {press(el, 'run-' + id, (frame.columns - 2) * CELL_PX, () => onToggle(id))}
      </Box>
      {rows}
    </Box>
  )
}

/** A boxed block on the page: the task it was given, or its answer (edged in its result's colour). */
function block(el: Els, frame: Frame, key: string, label: RenderNode, text: string, edge = 'rgba(128,124,116,0.32)'): RenderNode {
  const { Box, Markdown } = el
  return (
    <Box key={key} flexDirection="column" rowGap={0.5} width="100%" minWidth={0} paddingX={1.5} paddingY={0.5} borderStyle="round" borderColor={edge} backgroundColor="rgba(128,124,116,0.06)">
      {label}
      <Markdown key={key + '-text'} text={text} />
    </Box>
  )
}

/** The conversation under the card: the task, the latest entries, the answer, what it does now. */
function talkDrawn(el: Els, frame: Frame, view: AgentsView, agent: AgentRec, talk: AgentTalk, actions: AgentsActions): RenderNode {
  const { Box, Markdown, Text } = el
  const k = pageLook(frame)
  const L = frame.lang
  if ('deny' in talk) {
    return (
      <Box key="talk" paddingX={1}>
        <Text {...k.sub} wrap="wrap">{t(L, 'agents.deny', { reason: talk.deny })}</Text>
      </Box>
    )
  }
  const page = pageOf(talk.entries, !live(agent))
  const items: RenderNode[] = []
  if (page.first?.kind === 'prompt') items.push(block(el, frame, 'task', <Text key="task-label" bold {...k.sub}>{t(L, 'agents.task')}</Text>, cut(page.first.text, PROMPT_MAX)))
  if (page.dropped > 0) {
    items.push(
      <Box key="dropped" flexDirection="row" justifyContent="center">
        <Text {...k.mute}>{t(L, 'agents.dropped', { count: page.dropped })}</Text>
      </Box>,
    )
  }
  // The call it is in now carries its time; with none in flight a last line says what it does.
  const inFlight = live(agent) ? page.shown.findLast(e => e.kind === 'tool' && e.state === 'running') : undefined
  const since = agent.toolSince ? elapsed(view.now - agent.toolSince, L) : undefined
  // Tool calls in a run fold into one line, as the Claude app shows them ("명령어 9개 실행함, 파일
  // 2개 읽음 ›"), and unfold call by call when pressed. Listed whole, a worker's dozens of commands
  // read as a wall (2026-10-20).
  const opened = view.open?.runsOpen ?? []
  for (const part of partsOf(page.shown)) {
    if (part.kind === 'run') items.push(runDrawn(el, frame, part.calls, live(agent), opened.includes(part.calls[0]!.id), inFlight, since, actions.toggleRun))
    else if (part.kind === 'prompt') items.push(block(el, frame, 'prompt-' + items.length, <Text key="label" bold {...k.sub}>{t(L, 'agents.task')}</Text>, cut(part.text, PROMPT_MAX)))
    else items.push(<Box key={'text-' + items.length} paddingX={1} minWidth={0}><Markdown text={cut(part.text, TEXT_MAX)} /></Box>)
  }
  if (page.answer !== undefined) {
    const ok = agent.state === 'done'
    items.push(block(el, frame, 'answer', (
      <Box key="answer-label" flexDirection="row" columnGap={1}>
        <Text color={ok ? k.tone('green') : k.tone('red')} bold>{ok ? '✓' : '✕'}</Text>
        <Text bold {...k.ink}>{t(L, 'agents.answer')}</Text>
      </Box>
    ), cut(page.answer, ANSWER_MAX), ok ? 'rgba(46,170,100,0.55)' : 'rgba(220,60,60,0.5)'))
  }
  if (live(agent) && !inFlight) {
    items.push(
      <Box key="now" flexDirection="row" columnGap={1} paddingLeft={1} minWidth={0}>
        <Text color={k.tone('violet')}>▸</Text>
        <Box flexShrink={1} minWidth={0}>
          <Text {...k.sub} wrap="wrap">{doing(agent, view.now, L)}</Text>
        </Box>
      </Box>,
    )
  }
  if (!talk.entries.length) items.push(<Box key="nothing" paddingX={1}><Text {...k.sub}>{t(L, 'agents.nothingYet')}</Text></Box>)
  return (
    <Box key="talk" flexDirection="column" rowGap={1} width="100%" minWidth={0}>
      {items}
    </Box>
  )
}

/** The conversation on the desktop: its card in the capsule with the way back, then what it said. */
function openDrawn(el: Els, frame: Frame, view: AgentsView, actions: AgentsActions, agent: AgentRec | undefined, talk: AgentTalk): RenderNode {
  const { Box, Text } = el
  const k = lookOf(frame)
  const L = frame.lang
  const back = pill(el, frame, 'back', t(L, 'agents.back'), 'ghost', actions.back, 'violet', 'back')
  if (!agent) {
    return capsule(el, frame, {
      key: 'agent-open',
      sea: { tone: 'violet', reach: 100 },
      rows: 4,
      paddingY: 1,
      gap: 1,
      children: [
        <Box key="open-head" flexDirection="row" alignItems="center" columnGap={2} width="100%" minWidth={0}>
          {back}
          <Box flexShrink={1} minWidth={0}>
            <Text {...k.sub} wrap="wrap">{t(L, 'agents.gone')}</Text>
          </Box>
        </Box>,
      ],
    })
  }
  const head = capsule(el, frame, {
    key: 'agent-open',
    sea: { tone: 'violet', reach: 120, at: { x: 1.5 * CELL_PX + 30, y: 20 } },
    rows: rowsOf(CONTROL_PX) + cardRows(frame, agent, false) + 3,
    paddingY: 1,
    gap: 1,
    children: [
      <Box key="open-head" flexDirection="row" alignItems="center" columnGap={2} width="100%" minWidth={0}>
        {back}
        <Box flexGrow={1} />
        <Text key="open-brand" {...k.mute}>{t(L, 'agents.title')}</Text>
      </Box>,
      card(el, frame, agent, view.now),
    ],
  })
  // Scrolled past the head, the way back floats at the window's top: the engine asks again with the
  // new offset on each scroll, so a box placed at that row stays put while the conversation moves
  // under it. Scrolling back up to leave was the owner's complaint (2026-10-20).
  const offset = frame.offset ?? 0
  return (
    <Box position="relative" flexDirection="column" rowGap={1} width="100%" minWidth={0}>
      {head}
      {talkDrawn(el, frame, view, agent, talk, actions)}
      {offset >= FLOAT_AFTER ? (
        <Box key="float-back" position="absolute" top={offset} left={0} flexDirection="row" paddingLeft={1}>
          {pill(el, frame, 'back-float', t(L, 'agents.back'), 'primary', actions.back, 'violet', 'back')}
        </Box>
      ) : null}
    </Box>
  )
}

/** Rows scrolled before the way back floats: about where the head's own leaves the window. */
const FLOAT_AFTER = 3

// ---- Terminal ----------------------------------------------------------------------------------

/** The model line as text: the model, its effort, its type when that says more. */
function modelLine(frame: Frame, agent: AgentRec): string {
  const model = modelOf(agent, frame.lang)
  const effort = effortOf(agent)
  return [model, effort ? effortLabel(effort, frame.lang) : '', typeOf(agent, model)].filter(Boolean).join(' · ')
}

/** A terminal card: the dot and title, the model, why, and what it does with its time and tokens. */
function liveLines(el: Els, frame: Frame, agent: AgentRec, now: number, hotkey: string | undefined, onOpen: () => void): RenderNode {
  const { Box, Text } = el
  const tone = textTone(frame.appearance)
  const waiting = agent.state === 'waiting'
  const why = whyLine(frame, agent)
  const nums = figureLine(frame, agent)
  return (
    <Box key={'agent-' + agent.id} flexDirection="column">
      <Box key="title" flexDirection="row" alignItems="center" columnGap={1}>
        <Text color={waiting ? undefined : tone.accent} dimColor={waiting}>{waiting ? '○' : '●'}</Text>
        <Text bold wrap="wrap">{titleOf(agent)}</Text>
        {textButton(el, 'open-' + agent.id, t(frame.lang, 'agents.open'), onOpen, hotkey)}
      </Box>
      <Box key="model" flexDirection="row" flexWrap="wrap" columnGap={1} paddingLeft={2}>
        <Text>{modelLine(frame, agent)}</Text>
      </Box>
      {why ? (
        <Box key="why" paddingLeft={2}>
          <Text dimColor wrap="wrap">{why}</Text>
        </Box>
      ) : null}
      {agent.pick?.fallbackReason ? (
        <Box key="fallback" paddingLeft={2}>
          <Text color={tone.warn} wrap="wrap">{t(frame.lang, 'agents.fallback', { reason: agent.pick.fallbackReason })}</Text>
        </Box>
      ) : null}
      <Box key="doing" flexDirection="row" flexWrap="wrap" columnGap={2} paddingLeft={2}>
        <Text color={waiting ? undefined : tone.accent} dimColor={waiting} wrap="wrap">{'▸ ' + (waiting ? t(frame.lang, 'agents.waiting') + ' · ' : '') + doing(agent, now, frame.lang)}</Text>
        <Text dimColor>{ranFor(agent, now, frame.lang)}</Text>
        {nums ? <Text dimColor>{nums}</Text> : null}
      </Box>
    </Box>
  )
}

function doneLine(el: Els, frame: Frame, agent: AgentRec, now: number, hotkey: string | undefined, onOpen: () => void): RenderNode {
  const { Box, Text } = el
  const tone = textTone(frame.appearance)
  const ok = agent.state === 'done'
  const nums = figureLine(frame, agent)
  return (
    <Box key={'done-' + agent.id} flexDirection="row" flexWrap="wrap" columnGap={1} paddingLeft={1}>
      <Text color={ok ? tone.ok : tone.bad}>{ok ? '✓' : '✕'}</Text>
      <Text wrap="wrap">{titleOf(agent)}</Text>
      <Text dimColor>{modelLine(frame, agent)}</Text>
      <Text dimColor>{ranFor(agent, now, frame.lang)}</Text>
      {nums ? <Text dimColor>{nums}</Text> : null}
      {textButton(el, 'open-' + agent.id, t(frame.lang, 'agents.open'), onOpen, hotkey)}
    </Box>
  )
}

function listText(el: Els, frame: Frame, view: AgentsView, actions: AgentsActions, running: AgentRec[], done: AgentRec[]): RenderNode {
  const { Box, Text } = el
  const shownDone = view.showDone ? done : done.slice(0, DONE_SHOWN)
  // The first nine a digit each, in the order drawn.
  let n = 0
  const key = () => (++n <= 9 ? String(n) : undefined)
  return (
    <Box flexDirection="column" rowGap={1} width="100%">
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Text bold>{running.length ? t(frame.lang, 'agents.liveCount', { count: running.length }) : t(frame.lang, 'agents.noneRunning')}</Text>
        {done.length ? <Text dimColor>{t(frame.lang, 'agents.doneCount', { count: done.length })}</Text> : null}
      </Box>
      {running.map(agent => liveLines(el, frame, agent, view.now, key(), () => actions.open(agent.id)))}
      {shownDone.length ? (
        <Box flexDirection="column">
          {shownDone.map(agent => doneLine(el, frame, agent, view.now, key(), () => actions.open(agent.id)))}
        </Box>
      ) : null}
      {done.length > DONE_SHOWN ? (
        <Box flexDirection="row">
          {textButton(el, 'done', view.showDone ? t(frame.lang, 'agents.less') : t(frame.lang, 'agents.more', { count: done.length - DONE_SHOWN }), actions.toggleDone, 'f')}
        </Box>
      ) : null}
    </Box>
  )
}

/** The conversation as plain text: the way back, the agent, then each entry in a line or a few. */
function openText(el: Els, frame: Frame, view: AgentsView, actions: AgentsActions, agent: AgentRec | undefined, talk: AgentTalk): RenderNode {
  const { Box, Text } = el
  const tone = textTone(frame.appearance)
  const L = frame.lang
  const back = textButton(el, 'back', t(L, 'agents.back'), actions.back, 'b')
  if (!agent) {
    return (
      <Box flexDirection="column" rowGap={1} width="100%">
        {back}
        <Text dimColor wrap="wrap">{t(L, 'agents.gone')}</Text>
      </Box>
    )
  }
  const lines: RenderNode[] = []
  if ('deny' in talk) lines.push(<Text key="deny" dimColor wrap="wrap">{t(L, 'agents.deny', { reason: talk.deny })}</Text>)
  else {
    const page = pageOf(talk.entries, !live(agent))
    if (page.first?.kind === 'prompt') lines.push(<Box key="task" flexDirection="column"><Text dimColor>{t(L, 'agents.task')}</Text><Text wrap="wrap">{cut(page.first.text, 600)}</Text></Box>)
    if (page.dropped > 0) lines.push(<Box key="dropped"><Text dimColor>{t(L, 'agents.dropped', { count: page.dropped })}</Text></Box>)
    // A run of calls folds into one line here too; a single call, and the one in flight, stay lines.
    const inFlight = live(agent) ? page.shown.findLast(e => e.kind === 'tool' && e.state === 'running') : undefined
    const opened = view.open?.runsOpen ?? []
    const markColor = (m: Mark) => m === 'ok' ? tone.ok : m === 'error' ? tone.bad : m === 'running' ? tone.accent : undefined
    const callLine = (call: ToolCall, indent: number) => {
      const state = callMark(call, live(agent))
      return (
        <Box key={'tool-' + call.id} flexDirection="row" columnGap={1} paddingLeft={indent}>
          <Text color={markColor(state)} dimColor={state === 'unknown'}>{GLYPH[state]}</Text>
          <Text bold>{call.tool}</Text>
          {call.detail ? <Text dimColor wrap="truncate-end">{clip(call.detail, detailRoom(frame.columns - indent, call, undefined))}</Text> : null}
        </Box>
      )
    }
    partsOf(page.shown).forEach((part, i) => {
      if (part.kind === 'run') {
        const id = part.calls[0]!.id
        const open = opened.includes(id)
        const rows = shownCalls(part.calls, open, inFlight).map(call => callLine(call, part.calls.length === 1 ? 1 : 3))
        if (part.calls.length === 1) { lines.push(<Box key={'e' + i} flexDirection="column">{rows}</Box>); return }
        const summary = runSummary(part.calls, L)
        const state = runMark(part.calls, live(agent))
        lines.push(
          <Box key={'e' + i} flexDirection="column">
            <Box key="head" flexDirection="row" columnGap={1} paddingLeft={1}>
              <Text color={markColor(state)} dimColor={state === 'unknown'}>{GLYPH[state]}</Text>
              {textButton(el, 'run-' + id, summary.text + (open ? ' ⌄' : ' ›'), () => actions.toggleRun(id))}
              {summary.failed ? <Text color={tone.bad}>{t(L, 'agents.act.failed', { count: summary.failed })}</Text> : null}
            </Box>
            {rows}
          </Box>,
        )
      } else if (part.kind === 'prompt') lines.push(<Box key={'e' + i} flexDirection="column"><Text dimColor>{t(L, 'agents.task')}</Text><Text wrap="wrap">{cut(part.text, 600)}</Text></Box>)
      else lines.push(<Text key={'e' + i} wrap="wrap">{cut(part.text, 1500)}</Text>)
    })
    if (page.answer !== undefined) lines.push(<Box key="answer" flexDirection="column"><Text bold color={agent.state === 'done' ? tone.ok : tone.bad}>{t(L, 'agents.answer')}</Text><Text wrap="wrap">{cut(page.answer, 4000)}</Text></Box>)
    if (!talk.entries.length) lines.push(<Text key="nothing" dimColor>{t(L, 'agents.nothingYet')}</Text>)
  }
  const nums = figureLine(frame, agent)
  return (
    <Box flexDirection="column" rowGap={1} width="100%">
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {back}
        <Text bold wrap="wrap">{titleOf(agent)}</Text>
      </Box>
      <Box flexDirection="column">
        <Text dimColor wrap="wrap">{[modelLine(frame, agent), ranFor(agent, view.now, L)].join(' · ')}</Text>
        {nums ? <Text dimColor wrap="wrap">{nums}</Text> : null}
        {live(agent) ? <Text color={tone.accent} wrap="wrap">{'▸ ' + doing(agent, view.now, L)}</Text> : null}
      </Box>
      {lines}
    </Box>
  )
}

// ---- The pane ----------------------------------------------------------------------------------

/** The Agents pane body: the list, or one agent's conversation. */
export function renderAgents(el: Els, frame: Frame, view: AgentsView, actions: AgentsActions): RenderNode {
  const drawn = canDraw(el, frame)
  if (view.open) {
    const agent = view.agents.find(a => a.id === view.open!.id)
    return drawn ? openDrawn(el, frame, view, actions, agent, view.open.talk) : openText(el, frame, view, actions, agent, view.open.talk)
  }
  // Empty, the pane has nothing to redraw it, so 리플이 can live out its idle loops here.
  if (view.agents.length === 0) return speak(el, frame, { key: 'agents', face: 'calm', size: GREET_SIZE, title: t(frame.lang, 'agents.emptyTitle'), line: t(frame.lang, 'agents.emptyBody') })
  const running = view.agents.filter(live).sort((a, b) => a.startedAt - b.startedAt)
  const done = view.agents.filter(a => !live(a)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  return drawn ? listDrawn(el, frame, view, actions, running, done) : listText(el, frame, view, actions, running, done)
}
