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
// "Open" takes the terminal to the agent's own view (`$.ui.view`, register.tsx). Where the host
// refuses it reads the agent's conversation (`$.session.messages({ agentId })`) and draws it here, a
// way back at its head. The desktop always refuses: its session runs headless, with no main view the
// engine can move ("no main view here", engine 2.1.308, read 2026-10-24), and no tool of the app
// opens its own agent view either. So on the desktop this pane is the only view we can give.
//
// The desktop draws both as the Claude app draws its own (2026-10-24): the list as its background
// task list, on the page, a row per agent under a blank press (the host inks a Button's Text in its
// own colour, so no Text goes in one); the conversation as its agent view, the prompt in a grey
// card, the words as paragraphs, each run of tool calls one quiet line, Claude's spark while it
// works. The agent's card keeps its capsule (kit.tsx): its words are the deep's light ink. The rest
// reads on the host's own page: Markdown takes the host's ink and no colour of ours.
//
// The commands and watches Claude left running in the background (tasks.ts) sit in the list with the
// agents, as the Claude app lists its background tasks: running with running, ended with ended.
//
// 리플이 only where nothing redraws: the empty pane. Each running agent's step and the pane's
// one-second clock redraw it, and every redraw may start a motion over; the spark's turn is one
// second long, so a restart lands where it would have been.

import { t } from '../i18n'
import type { RenderNode, SessionMessage } from 'claude-code'

import type { AgentRec, BgTask, Effort } from '../../types'
import { exitCode } from '../tasks'
import { bareTitle } from '../workers'
import { CELL_PX, METER_H, METER_W, ROW_PX, SVG_MAX_PX, esc, r, svg } from './art'
import { capsule, lift, pic, pill, press, ripple } from './kit'
import { DISPLAY, displayText } from './display'
import { lookOf } from './look'
import type { Look } from './look'
import { GREET_SIZE, canDraw, speak, textButton } from './parts'
import type { Els } from './parts'
import { chOf, clip, displayWidth, providerColor, svgDoc, textTone } from './theme'
import type { Appearance } from './theme'
import { editLines, runDiff, runSummary, toolDetail } from './tools'
import type { Place, ToolCall } from './tools'
import type { AgentEntry, AgentTalk, AgentsActions, AgentsView, Frame } from './view'
import { cachePercent, compactNumber, effortIndex, effortLabel, elapsed, modelName, promptTokens, targetLabel } from './view'

// Every `by` a pick can carry: a missing one handed t() no key, which threw and left the whole pane
// undrawn ("Nothing to show yet") once a worker ran on the session's model (2026-10-16).
const BY: Record<NonNullable<AgentRec['pick']>['by'], string> = { haiku: 'settings.haiku', jev: 'settings.jev', model: 'agents.routerModel', judge: 'settings.judge', marker: 'agents.marker', default: 'agents.default', session: 'agents.session', tier: 'toasts.yourPick', user: 'toasts.yourPick', rule: 'agents.rule' }

/** Finished agents the list shows before "more". */
export const DONE_SHOWN = 4
/**
 * Characters of the conversation drawn in all, about: a tree draws 100,000 characters (the engine's
 * cut), and the card and the page's chrome take some. The entry bound below also leaves room for
 * the nodes of unfolded tools; past either bound the oldest entries are counted as omitted.
 */
export const TALK_CHARS = 80_000
/** Short entries also consume nodes: bound an unfolded tool history before constructing its tree. */
export const TALK_ENTRIES = 512
/** Characters of a text entry drawn. */
const TEXT_MAX = 3000
const PROMPT_MAX = 2400
const ANSWER_MAX = 12000

function live(agent: AgentRec): boolean {
  return agent.state === 'running' || agent.state === 'waiting'
}

/** A row of the list: an agent, or a command or watch left in the background. */
type Item = { kind: 'agent'; agent: AgentRec } | { kind: 'task'; task: BgTask }

function itemLive(item: Item): boolean {
  return item.kind === 'agent' ? live(item.agent) : item.task.state === 'running'
}

function itemStart(item: Item): number {
  return item.kind === 'agent' ? item.agent.startedAt : item.task.startedAt
}

function itemEnd(item: Item): number {
  return (item.kind === 'agent' ? item.agent.endedAt : item.task.endedAt) ?? 0
}

/** A title without the model tag the spawn put in front of it: the card names the model itself. */
function titleOf(agent: AgentRec): string {
  return displayText(bareTitle(agent.description ?? '').trim() || agent.id)
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
  return agent.pick ? targetLabel(agent.pick.target, lang) : agent.type ?? ''
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
  if (pick.why) parts.push('“' + cut(pick.why, 240) + '”')
  return parts.join(' · ')
}

/** The card's failure detail is a preview, not an unbounded number of full-card click strips. */
function fallbackLine(frame: Frame, agent: AgentRec): string {
  const reason = agent.pick?.fallbackReason
  return reason ? t(frame.lang, 'agents.fallback', { reason: cut(reason, 240) }) : ''
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
 * call with a line of its input (tools.ts `toolDetail`: paths short against `place`), whether it
 * answered (a call's `text` is there once answered, also in a subagent's transcript, which keeps no
 * `result`; `isError` when it failed), and an edit's lines added and removed (tools.ts `editLines`).
 */
export function talkOf(messages: readonly SessionMessage[], place: Place = {}): AgentEntry[] {
  const out: AgentEntry[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.text.trim()) out.push({ kind: 'prompt', text: m.text.trim() })
      continue
    }
    if (m.text.trim()) out.push({ kind: 'text', text: m.text.trim() })
    for (const use of m.toolUses) {
      const lines = editLines(use.tool, use.input)
      out.push({ kind: 'tool', id: use.tool_use_id, tool: use.tool, detail: toolDetail(use.tool, use.input, place), state: use.isError ? 'error' : use.text === undefined && use.result === undefined ? 'running' : 'ok', ...(lines ?? {}) })
    }
  }
  return out
}

/** Cuts a long text at `max` characters, saying so. */
function cut(text: string, max: number): string {
  return displayText(text, max)
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
 * read the agent's words behind it as hidden (2026-10-20). Past TALK_CHARS or TALK_ENTRIES the
 * oldest go, counted in `dropped`.
 */
function pageOf(entries: readonly AgentEntry[], finished: boolean): Page {
  const first = entries[0]?.kind === 'prompt' ? entries[0] : undefined
  let rest = first ? entries.slice(1) : [...entries]
  const last = rest.at(-1)
  const answer = finished && last?.kind === 'text' ? last.text : undefined
  if (answer !== undefined) rest = rest.slice(0, -1)
  let room = TALK_CHARS - (first ? weight(first) : 0) - Math.min(answer?.length ?? 0, ANSWER_MAX)
  let from = rest.length
  while (from > 0 && rest.length - from < TALK_ENTRIES && room - weight(rest[from - 1]!) >= 0) room -= weight(rest[--from]!)
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
 * Whether a card's four numbers take two fixed rows (in · cache / out · tools): from the pane's width
 * and its language alone, never a value that ticks. The time is the page head's, at its end, so it
 * never takes a row of its own nor cuts the model's name (2026-10-20: a whole row for one value was
 * the owner's complaint; 2026-10-24: beside the model, a narrow pane cut the name to "dee…").
 */
function narrowCard(frame: Frame, agent: AgentRec): boolean {
  const width = innerCells(frame)
  return width < NARROW_CELLS || figureCells(cardFigures(frame, agent)) > width - 2
}

/** The figures' rows: one, or two fixed ones when narrow. */
function figureRows(figs: readonly Figure[], narrow: boolean): Figure[][] {
  if (!figs.length) return []
  return narrow ? [figs.slice(0, 2), figs.slice(2)] : [[...figs]]
}

/** Cells the model's name has on its one line: the row less the mark, the dot, the effort and the type. */
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

/** Rows the open conversation's card draws, about, for the capsule's water. */
export function cardRows(frame: Frame, agent: AgentRec): number {
  const nums = figureRows(cardFigures(frame, agent), narrowCard(frame, agent)).length
  const fall = linesOf(fallbackLine(frame, agent), innerCells(frame) - 2)
  return 1.2 + nums + fall + 1.3
}

/** A state's mark and its colour: running in the accent, waiting amber, done green, failed red. */
function mark(k: Look, agent: AgentRec): { glyph: string; color: string } {
  if (agent.state === 'running') return { glyph: '●', color: k.tone('violet') }
  if (agent.state === 'waiting') return { glyph: '◐', color: k.tone('amber') }
  if (agent.state === 'done') return { glyph: '✓', color: k.tone('green') }
  return { glyph: '✕', color: k.tone('red') }
}

/**
 * The time an agent has run, "failed" before it when it failed, for the page's head: in a column as
 * wide as its widest value, so the row it ends never moves as it ticks.
 */
function timeBox(el: Els, frame: Frame, agent: AgentRec, now: number): RenderNode {
  const { Box, Text } = el
  const k = pageLook(frame)
  return (
    <Box key="time" flexDirection="row" justifyContent="flex-end" columnGap={1} flexShrink={0} width={timeCells(frame, agent)}>
      {agent.state === 'failed' ? <Text key="failed" color={k.tone('red')}>{t(frame.lang, 'agents.failed')}</Text> : null}
      <Text key="elapsed" {...(live(agent) ? k.ink : k.sub)}>{ranFor(agent, now, frame.lang)}</Text>
    </Box>
  )
}

/**
 * The open conversation's card, under the page's head that carries the title and the time: the
 * mark, the model and effort, the numbers, why. What the agent does now is the conversation's: a
 * line that changed each step made the pane jump. A list tile draws these rows under its own head,
 * which has the mark (`headed`), and may end the numbers with its time (`tail`).
 */
function cardBody(el: Els, frame: Frame, agent: AgentRec, headed = false, tail?: RenderNode): RenderNode[] {
  const { Box, Text } = el
  const k = lookOf(frame)
  const L = frame.lang
  const m = mark(k, agent)
  const model = modelOf(agent, L)
  const effort = effortOf(agent)
  // The type only while the model's name keeps room beside it.
  const { type, word, room } = modelRow(frame, agent, model)
  const nums = figureRows(cardFigures(frame, agent), narrowCard(frame, agent))
  const auto = agent.pick && ['haiku', 'jev', 'model'].includes(agent.pick.by)
  const rows: RenderNode[] = [
    // One line whatever the width: the name cut before the effort ever drops below it.
    <Box key="ident" flexDirection="row" alignItems="center" columnGap={1} minWidth={0} overflow="hidden" {...(headed ? { paddingLeft: 2 } : {})}>
      {headed ? null : (
        <Box key="mark" flexShrink={0}>
          <Text color={m.color} bold>{m.glyph}</Text>
        </Box>
      )}
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
        {last && tail ? <Box key="gap" flexGrow={1} /> : null}
        {last && tail ? tail : null}
      </Box>,
    )
  })
  if (agent.pick?.fallbackReason) {
    rows.push(
      <Box key="fallback" paddingLeft={2} minWidth={0}>
        <Text color={k.tone('amber')} wrap="wrap">{fallbackLine(frame, agent)}</Text>
      </Box>,
    )
  }
  return rows
}

/** The open conversation's tile. */
function card(el: Els, frame: Frame, agent: AgentRec): RenderNode {
  const { Box } = el
  const k = lookOf(frame)
  return (
    <Box key={'card-' + agent.id} flexDirection="column" width="100%" minWidth={0} paddingX={1.5} paddingY={0.5} {...k.tile}>
      {cardBody(el, frame, agent)}
    </Box>
  )
}

// ---- Desktop: the list's tiles -----------------------------------------------------------------
// The list keeps its capsule of tiles (2026-10-24: the owner asked for background tasks to show
// beside the agents as the app shows them, not for the tiles to become the app's plain rows).

/**
 * Cells the time needs at the end of the numbers' last row: an hour's worth ("59분 59초"). It ends the
 * row right-aligned, so a longer one only grows leftward into the row's slack; reserving 99 hours there
 * left the time a row of its own on a narrow pane (2026-10-20).
 */
function tailCells(frame: Frame, agent: AgentRec): number {
  return Math.ceil(chOf(elapsed(3_599_000, frame.lang))) + failedCells(frame, agent)
}

/**
 * How a list tile lays out, from the pane's width and its language alone, never a value that ticks.
 * Wide: the time and the chevron in a fixed column right of the title, the four numbers in a row.
 * Narrow (or when the four numbers would not fit a row): the numbers go in two fixed rows (in · cache /
 * out · tools) and the time ends the second of them; the title has its row to itself but for the
 * chevron, or, when the time does not fit by the numbers, beside the time in the head. The time never
 * takes a row of its own (2026-10-20: a whole row for one value was the owner's complaint).
 */
type TileLayout = { width: number; narrow: boolean; time: number; timeOn: 'head' | 'nums'; side: number; title: number }
function tileLayout(frame: Frame, agent: AgentRec): TileLayout {
  const width = innerCells(frame)
  const figs = cardFigures(frame, agent)
  const narrow = narrowCard(frame, agent)
  const time = timeCells(frame, agent)
  const timeOn = narrow && figs.length && figureCells(figs.slice(2)) + 2 + tailCells(frame, agent) <= width - 2 ? 'nums' : 'head'
  const side = timeOn === 'head' ? time + 2 : 1
  return { width, narrow, time, timeOn, side, title: width - 2 - (side + 1) }
}

/** Lines a tile's title takes at most; the rest is cut with an ellipsis. */
const TITLE_LINES = 2

/**
 * The title cut to two lines of `cells`: a few cells short of two full ones, as wrapping at words
 * leaves the end of a line empty.
 */
function tileTitle(agent: AgentRec, cells: number): string {
  return clipCh(titleOf(agent), TITLE_LINES * Math.max(10, cells) - 4)
}

/** Rows a list tile draws, about, for the capsule's water. */
function tileRows(frame: Frame, agent: AgentRec): number {
  const layout = tileLayout(frame, agent)
  const head = Math.min(TITLE_LINES, linesOf(tileTitle(agent, layout.title), layout.title))
  const nums = figureRows(cardFigures(frame, agent), layout.narrow).length
  const fall = linesOf(fallbackLine(frame, agent), layout.width - 2)
  return head + 1.2 + nums + fall + 1.3
}

/**
 * A list tile: the head (mark, title, time, chevron) under one blank press, the model and effort, the
 * numbers, why. The title is our own Text: a host Button around it painted it in the button's ink,
 * dark on the deep's water (claude.ai, 2026-10-24).
 */
function tile(el: Els, frame: Frame, agent: AgentRec, now: number, onPress: () => void): RenderNode {
  const { Box, Text } = el
  const k = lookOf(frame)
  const L = frame.lang
  const m = mark(k, agent)
  const layout = tileLayout(frame, agent)
  // In the head a column as wide as its widest value; at the end of the numbers, right-aligned in
  // the row's slack (tileLayout), as wide as it is.
  const time = (
    <Box key="time" flexDirection="row" justifyContent="flex-end" columnGap={1} flexShrink={0} {...(layout.timeOn === 'head' ? { width: layout.time } : {})}>
      {agent.state === 'failed' ? <Text key="failed" color={k.tone('red')}>{t(L, 'agents.failed')}</Text> : null}
      <Text key="elapsed" {...(live(agent) ? k.ink : k.sub)}>{ranFor(agent, now, L)}</Text>
    </Box>
  )
  const head = (
    <Box key="head" flexDirection="row" alignItems="flex-start" columnGap={1} width="100%" minWidth={0}>
      <Box key="mark" flexShrink={0}>
        <Text color={m.color} bold>{m.glyph}</Text>
      </Box>
      <Box key="title" flexGrow={1} flexShrink={1} minWidth={0}>
        <Text bold {...k.ink} wrap="wrap">{tileTitle(agent, layout.title)}</Text>
      </Box>
      <Box key="side" flexDirection="row" justifyContent="flex-end" columnGap={1} flexShrink={0} width={layout.side}>
        {layout.timeOn === 'head' ? time : null}
        <Text key="chev" {...k.mute}>›</Text>
      </Box>
      {press(el, 'open-' + agent.id, (frame.columns - 2) * CELL_PX, onPress)}
    </Box>
  )
  // The model, numbers and why are the open conversation's card's own rows, less its mark (the head
  // has it), with the time at the end of the numbers when the layout puts it there.
  const body = cardBody(el, frame, agent, true, layout.timeOn === 'nums' ? time : undefined)
  return (
    <Box key={'card-' + agent.id} flexDirection="column" width="100%" minWidth={0} paddingX={1.5} paddingY={0.5} {...k.tile}>
      {[head, ...body]}
    </Box>
  )
}

// ---- Desktop: a background task's tile ---------------------------------------------------------
// A command or a watch has a tile as an agent does, less what only an agent has (a model, tokens, a
// conversation to open): its mark, what it does and its time, and under them what it runs.

/** A task's mark: running in the accent, done green, failed red, stopped quiet. */
function taskMark(k: Look, task: BgTask): { glyph: string; word: Look['ink'] } {
  if (task.state === 'running') return { glyph: '●', word: { color: k.tone('violet') } }
  if (task.state === 'done') return { glyph: '✓', word: { color: k.tone('green') } }
  if (task.state === 'failed') return { glyph: '✕', word: { color: k.tone('red') } }
  return { glyph: '■', word: k.mute }
}

/** How long a task ran, or has run so far. */
function taskRanFor(task: BgTask, now: number, lang: Frame['lang']): string {
  return elapsed((task.state === 'running' ? now : task.endedAt ?? task.startedAt) - task.startedAt, lang)
}

/** The word before a task's time when it did not end well. */
function taskEndWord(frame: Frame, task: BgTask): string {
  return task.state === 'failed' ? t(frame.lang, 'agents.failed') : task.state === 'stopped' ? t(frame.lang, 'agents.stopped') : ''
}

/** Cells of a task's time column: the elapsed time's widest, its end word before it. */
function taskTimeCells(frame: Frame, task: BgTask): number {
  const word = taskEndWord(frame, task)
  return Math.ceil(timeCh(frame.lang)) + (word ? Math.ceil(chOf(word)) + 1 : 0)
}

/**
 * Cells right of a task's time, where an agent's tile has its chevron: the times of both line up.
 */
const CHEVRON_CELLS = 2

/** Cells a task's title has on a line: the row less its mark, its time and the chevron's room. */
function taskTitleCells(frame: Frame, task: BgTask): number {
  return innerCells(frame) - 2 - (taskTimeCells(frame, task) + CHEVRON_CELLS + 1)
}

/** What a task runs, when its title is not that already. */
function taskCommand(task: BgTask): string | undefined {
  return task.command && task.command !== task.title ? task.command : undefined
}

/** A failed command's exit code in words, when its notification named one. */
function taskCode(frame: Frame, task: BgTask): string {
  const code = task.state === 'failed' ? exitCode(task.summary) : undefined
  return code === undefined ? '' : t(frame.lang, 'agents.exitCode', { code })
}

/** Rows a task's tile draws, about, for the capsule's water. */
function taskRows(frame: Frame, task: BgTask): number {
  const cells = taskTitleCells(frame, task)
  return Math.min(TITLE_LINES, linesOf(clipCh(task.title, TITLE_LINES * Math.max(10, cells) - 4), cells)) + 1.2 + 1.3
}

/** A task's tile: the mark, its title and time, then what kind it is and what it runs. Nothing to open. */
function taskTile(el: Els, frame: Frame, task: BgTask, now: number): RenderNode {
  const { Box, Text } = el
  const k = lookOf(frame)
  const L = frame.lang
  const m = taskMark(k, task)
  const end = taskEndWord(frame, task)
  const kind = t(L, task.kind === 'shell' ? 'agents.shell' : 'agents.monitor')
  const command = taskCommand(task)
  const code = taskCode(frame, task)
  const room = innerCells(frame) - 2 - Math.ceil(chOf(kind)) - 1 - (code ? Math.ceil(chOf(code)) + 1 : 0)
  return (
    <Box key={'task-' + task.id} flexDirection="column" width="100%" minWidth={0} paddingX={1.5} paddingY={0.5} {...k.tile}>
      <Box key="head" flexDirection="row" alignItems="flex-start" columnGap={1} width="100%" minWidth={0}>
        <Box key="mark" flexShrink={0}>
          <Text {...m.word} bold>{m.glyph}</Text>
        </Box>
        <Box key="title" flexGrow={1} flexShrink={1} minWidth={0}>
          <Text bold {...k.ink} wrap="wrap">{clipCh(task.title, TITLE_LINES * Math.max(10, taskTitleCells(frame, task)) - 4)}</Text>
        </Box>
        <Box key="time" flexDirection="row" justifyContent="flex-end" columnGap={1} flexShrink={0} width={taskTimeCells(frame, task) + CHEVRON_CELLS} paddingRight={CHEVRON_CELLS}>
          {end ? <Text key="end" {...(task.state === 'failed' ? { color: k.tone('red') } : k.mute)}>{end}</Text> : null}
          <Text key="elapsed" {...(task.state === 'running' ? k.ink : k.sub)}>{taskRanFor(task, now, L)}</Text>
        </Box>
      </Box>
      <Box key="runs" flexDirection="row" alignItems="center" columnGap={1} paddingLeft={2} minWidth={0} overflow="hidden">
        <Box key="kind" flexShrink={0}>
          <Text {...k.mute}>{kind}</Text>
        </Box>
        {command ? (
          <Box key="command" flexShrink={1} minWidth={0} overflow="hidden">
            <Text {...k.sub} wrap="truncate-end">{clipCh(command, Math.max(8, room))}</Text>
          </Box>
        ) : null}
        {code ? <Box key="code" flexShrink={0}><Text {...k.sub}>{code}</Text></Box> : null}
      </Box>
    </Box>
  )
}

/** The list on the desktop: one capsule, its head, the running agents' and tasks' tiles, then the ended. */
function listDrawn(el: Els, frame: Frame, view: AgentsView, actions: AgentsActions, running: Item[], done: Item[]): RenderNode {
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
  const drawn = (item: Item) => item.kind === 'agent' ? tile(el, frame, item.agent, view.now, () => actions.open(item.agent.id)) : taskTile(el, frame, item.task, view.now)
  const children: RenderNode[] = [head]
  if (running.length) children.push(section('live', t(L, 'agents.liveCount', { count: running.length })))
  for (const item of running) children.push(drawn(item))
  if (done.length) children.push(section('done', t(L, 'agents.doneCount', { count: done.length })))
  for (const item of shownDone) children.push(drawn(item))
  if (done.length > DONE_SHOWN) {
    children.push(
      <Box key="more-row" flexDirection="row" justifyContent="center" width="100%">
        {view.showDone
          ? pill(el, frame, 'done', t(L, 'agents.less'), 'ghost', actions.toggleDone, 'violet', 'back')
          : pill(el, frame, 'done', t(L, 'agents.more', { count: done.length - DONE_SHOWN }), 'ghost', actions.toggleDone, 'violet', 'next')}
      </Box>,
    )
  }
  const rows = 3 + [...running, ...shownDone].reduce((n, item) => n + (item.kind === 'agent' ? tileRows(frame, item.agent) : taskRows(frame, item.task)) + 0.6, 0) + (done.length > DONE_SHOWN ? 2 : 0) + 3
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

// ---- Desktop: the conversation's pictures ------------------------------------------------------
//
// The conversation reads on the host's own page, so what is drawn there takes the page's colours,
// whatever the skin: fixed for a light or dark appearance, else following the app's theme through
// `prefers-color-scheme` (the pictures are images; the host's Text knows its theme on its own).

/** `light` on a light app, `dark` on a dark one, by the appearance setting or the app's theme. */
function themed(appearance: Appearance, light: string, dark: string): string {
  return appearance === 'dark' ? dark : appearance === 'light' ? light : light + '@media (prefers-color-scheme:dark){' + dark + '}'
}

/**
 * The page's surfaces: the pane's own (white on a light app, as flat.ts paints the app's surface)
 * and a prompt's card a step darker, as the Claude app sets the prompt it delegated (#f3f3f3 on
 * white, read from the app 2026-10-24).
 */
const SURFACE = { page: ['#ffffff', '#30302e'], card: ['#f3f3f3', '#262624'] } as const

/** A plain rectangle of the page's `surface`, laid behind a Box that clips it. */
export function plateArt(width: number, height: number, appearance: Appearance, surface: keyof typeof SURFACE): string {
  const [light, dark] = SURFACE[surface]
  return svg(width, height, '<rect class="p" width="' + r(width) + '" height="' + r(height) + '"/>', themed(appearance, '.p{fill:' + light + '}', '.p{fill:' + dark + '}'))
}

/** Px of the fade over a folded prompt's last lines. */
const FADE_PX = 30

/** The card's colour rising from clear to whole, over the last lines of a folded prompt. */
export function fadeArt(width: number, appearance: Appearance): string {
  const [light, dark] = SURFACE.card
  const stops = (color: string) => '.f0{stop-color:' + color + ';stop-opacity:0}.f1{stop-color:' + color + ';stop-opacity:1}'
  return svg(width, FADE_PX,
    '<defs><linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="f0"/><stop offset=".8" class="f1"/></linearGradient></defs><rect width="' + r(width) + '" height="' + FADE_PX + '" fill="url(#f)"/>',
    themed(appearance, stops(light), stops(dark)))
}

/** Px of the diff chip. */
export const DIFF_H = 18
const MONO = "ui-monospace,'SF Mono',Menlo,Consolas,monospace"
const MONO_PX = 11.5
/** A monospace digit's width, a little wide: 0.6 em. */
const MONO_CH = MONO_PX * 0.62
const DIFF_PAD = 5

/**
 * The lines a run's edits added and removed, as the Claude app shows them after a run's words: one
 * chip, "+52" on soft green and "−380" on soft pink, in a monospace. Its width, px, with it.
 */
export function diffArt(added: number, removed: number, appearance: Appearance): { source: string; width: number } {
  const plus = '+' + added
  const minus = '−' + removed
  const left = Math.ceil(plus.length * MONO_CH + DIFF_PAD * 2)
  const right = Math.ceil(minus.length * MONO_CH + DIFF_PAD * 2)
  const width = left + right
  const y = r(DIFF_H / 2 + MONO_PX * 0.36)
  const body =
    '<clipPath id="c"><rect width="' + width + '" height="' + DIFF_H + '" rx="4"/></clipPath>' +
    '<g clip-path="url(#c)"><rect class="ga" width="' + left + '" height="' + DIFF_H + '"/><rect class="ra" x="' + left + '" width="' + right + '" height="' + DIFF_H + '"/></g>' +
    '<text class="gt" x="' + r(left / 2) + '" y="' + y + '" text-anchor="middle">' + esc(plus) + '</text>' +
    '<text class="rt" x="' + r(left + right / 2) + '" y="' + y + '" text-anchor="middle">' + esc(minus) + '</text>'
  const css = 'text{font-family:' + MONO + ';font-size:' + MONO_PX + 'px;font-weight:500}' + themed(appearance,
    '.ga{fill:#dbebdb}.gt{fill:#3f8f3c}.ra{fill:#f2d6dd}.rt{fill:#bd3456}',
    '.ga{fill:#57ab5a;fill-opacity:.2}.gt{fill:#86d083}.ra{fill:#e5536f;fill-opacity:.22}.rt{fill:#f2899e}')
  return { source: svg(width, DIFF_H, body, css), width }
}

/** The back chevron at the head of the page, in the page's ink. */
export function chevronArt(appearance: Appearance): string {
  return svgDoc(16, 16, appearance, '<path d="M10 3.2L5.2 8l4.8 4.8" fill="none" stroke="var(--ink)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>')
}

/** Claude's terracotta, the colour of the spark its app draws while it works. */
const SPARK_COLOR = '#d97757'
/** The spark's side, px. */
export const SPARK_PX = 18

/**
 * The spark under a conversation while its agent works, as the Claude app draws its own: twelve
 * rays round a heart, turning by one ray's step and breathing in once a second. The document never
 * changes, so a redraw finds the same picture under the same key and the host keeps it moving; and
 * should a redraw start it over, the pane redraws each second (register.tsx agentsClock), where a
 * turn of the motion ends just as it began.
 */
export const SPARK_ART = ((): string => {
  const c = SPARK_PX / 2
  let rays = ''
  for (let i = 0; i < 12; i++) {
    const a = (i * Math.PI) / 6
    rays += '<line x1="' + r(c + Math.cos(a) * 2.2) + '" y1="' + r(c + Math.sin(a) * 2.2) + '" x2="' + r(c + Math.cos(a) * 7.9) + '" y2="' + r(c + Math.sin(a) * 7.9) + '"/>'
  }
  const body = '<g class="sb"><g class="st" stroke="' + SPARK_COLOR + '" stroke-width="1.75" stroke-linecap="round">' + rays + '</g><circle cx="' + c + '" cy="' + c + '" r="2.6" fill="' + SPARK_COLOR + '"/></g>'
  const css =
    '.sb{transform-origin:' + c + 'px ' + c + 'px;animation:sb 1s ease-in-out infinite}@keyframes sb{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(.72);opacity:.55}}' +
    '.st{transform-origin:' + c + 'px ' + c + 'px;animation:st 1s linear infinite}@keyframes st{to{transform:rotate(30deg)}}'
  return svg(SPARK_PX, SPARK_PX, body, css)
})()

// ---- Desktop: the conversation's parts ---------------------------------------------------------

/** Rows of a folded prompt; a prompt longer than FOLD_AFTER rows folds. */
const FOLD_ROWS = 5
const FOLD_AFTER = 7

/** Rows a prompt's text takes in its card, about: each line wrapped, a blank line a little under one. */
function promptRows(text: string, frame: Frame): number {
  const cells = Math.max(10, frame.columns - 5)
  let rows = 0
  for (const line of text.split('\n')) rows += line.trim() ? linesOf(line, cells) : 0.4
  return rows
}

/**
 * A prompt the agent was given, as the Claude app sets the one it delegated: a light grey card, a
 * long one folded to its first lines under a fade with "Show more" to unfold it (and "Show less" to
 * fold it again). The card is a picture laid behind the words, clipped to the Box, so the fade over
 * the last lines is the card's own colour on either theme.
 */
function promptCard(el: Els, frame: Frame, key: string, text: string, open: boolean, onToggle: () => void): RenderNode {
  const { Box, Markdown, Text } = el
  const k = pageLook(frame)
  const folds = promptRows(text, frame) > FOLD_AFTER
  const folded = folds && !open
  const width = Math.max(40, frame.columns) * CELL_PX + 48
  // Taken well past the card: a card taller than its plate would show the page beneath.
  const height = Math.round(((folded ? FOLD_ROWS : promptRows(text, frame)) + 2) * ROW_PX) + 220
  const label = t(frame.lang, open ? 'agents.showLess' : 'agents.showMore')
  return (
    <Box key={key} position="relative" flexDirection="column" width="100%" minWidth={0} overflow="hidden" borderStyle="round" borderColor="rgba(0,0,0,0)">
      <Box key={key + '-plate'} position="absolute" top={0} left={0}>
        {pic(el, key + '-plate', plateArt(width, height, frame.appearance, 'card'), '', width, height)}
      </Box>
      <Box key={key + '-layer'} position="relative" flexDirection="column" rowGap={0.5} paddingX={1.5} width="100%" minWidth={0}>
        {lift(el)}
        <Box key={key + '-body'} flexDirection="column" minWidth={0} {...(folded ? { height: FOLD_ROWS, overflow: 'hidden' } : {})}>
          <Markdown key={key + '-text'} text={text} />
          {folded ? (
            <Box key={key + '-fade'} position="absolute" left={0} bottom={0}>
              {pic(el, key + '-fade', fadeArt(width, frame.appearance), '', width, FADE_PX)}
            </Box>
          ) : null}
        </Box>
        {folds ? (
          <Box key={key + '-more'} flexDirection="row" minWidth={0}>
            <Box key="more" flexShrink={0} paddingRight={1}>
              <Text {...k.ink}>{label}</Text>
              {press(el, key + '-more', Math.ceil(chOf(label) + 1) * CELL_PX, onToggle)}
            </Box>
          </Box>
        ) : null}
      </Box>
    </Box>
  )
}

/** Cells of the back chevron's press. */
const BACK_CELLS = 3

/**
 * The page's head, as the Claude app heads an agent's view: a chevron back to the list at the left,
 * then the title on one line, and `end` (the agent's time, `cells` wide) at the right. A drawn chevron
 * under a blank press (the host inks a Button's Text in its own colour, so no Text goes inside one).
 */
type HeadEnd = { node: RenderNode; cells: number }
function pageHead(el: Els, frame: Frame, key: string, pressKey: string, title: string, onBack: () => void, end?: HeadEnd): RenderNode {
  const { Box, Text } = el
  const k = pageLook(frame)
  return (
    <Box key={key} flexDirection="row" alignItems="center" columnGap={0.5} width="100%" minWidth={0}>
      <Box key={key + '-back'} width={BACK_CELLS} flexShrink={0} alignItems="center" justifyContent="center">
        {pic(el, pressKey + '-chev', chevronArt(frame.appearance), t(frame.lang, 'agents.back'), 16, 16)}
        {press(el, pressKey, BACK_CELLS * CELL_PX, onBack)}
      </Box>
      <Box key={key + '-title'} flexShrink={1} minWidth={0} overflow="hidden">
        <Text {...k.ink} wrap="truncate-end">{clipCh(title, frame.columns - BACK_CELLS - 1 - (end ? end.cells + 2 : 0))}</Text>
      </Box>
      {end ? <Box key={key + '-gap'} flexGrow={1} /> : null}
      {end ? <Box key={key + '-end'} flexShrink={0} paddingRight={0.5}>{end.node}</Box> : null}
    </Box>
  )
}

/**
 * The head again, at the window's top once the page scrolls (the engine asks again with the new
 * offset on each scroll, so a box placed at that row stays put): on the pane's own surface, so the
 * words scrolling under it do not show through. A pill floating over the words hid them (2026-10-24).
 */
function floatingHead(el: Els, frame: Frame, offset: number, title: string, onBack: () => void, end?: HeadEnd): RenderNode {
  const { Box } = el
  const width = Math.max(40, frame.columns) * CELL_PX + 48
  const height = 3 * ROW_PX
  return (
    <Box key="float-head" position="absolute" top={offset} left={0} right={0} flexDirection="column" overflow="hidden">
      <Box key="float-plate" position="absolute" top={0} left={0}>
        {pic(el, 'float-plate', plateArt(width, height, frame.appearance, 'page'), '', width, height)}
      </Box>
      <Box key="float-layer" position="relative" flexDirection="column" paddingY={0.5} width="100%" minWidth={0}>
        {lift(el)}
        {pageHead(el, frame, 'float-row', 'back-float', title, onBack, end)}
      </Box>
    </Box>
  )
}

/**
 * A tool call's row in an unfolded run: its name, its input, on one line however long the input
 * (cut with an ellipsis at the pane's edge; a wrapped command was most of the wall of 2026-10-20).
 * No mark on a call that answered, as in the Claude app; a failed one keeps its red ✕ and the one
 * in flight its ring, in a column of their own so the names line up.
 */
function toolRow(el: Els, frame: Frame, entry: ToolCall, agentLive: boolean, indent: number, since?: string): RenderNode {
  const { Box, Text } = el
  const k = pageLook(frame)
  const state = callMark(entry, agentLive)
  const color = state === 'error' ? k.tone('red') : state === 'running' ? k.tone('violet') : undefined
  return (
    <Box key={'tool-' + entry.id} flexDirection="row" alignItems="center" columnGap={1} paddingLeft={indent} minWidth={0} overflow="hidden">
      <Box key="mark" width={1} flexShrink={0}>
        {color ? <Text color={color}>{GLYPH[state]}</Text> : null}
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
 * A run of tool calls on the page, as the Claude app draws one: a single quiet line in its words
 * ("실행됨 명령 7개, 편집함 파일 9개"), the lines its edits added and removed in a chip after it, and
 * a chevron; pressed, it unfolds call by call. No mark and no failure count on the line (the
 * owner's ask, 2026-10-24): a failed call shows red when the run is unfolded. A single call is a run
 * of one.
 */
function runDrawn(el: Els, frame: Frame, calls: readonly ToolCall[], agentLive: boolean, open: boolean, inFlight: AgentEntry | undefined, since: string | undefined, onToggle: (id: string) => void): RenderNode {
  const { Box, Text } = el
  const k = pageLook(frame)
  const id = calls[0]!.id
  const summary = runSummary(calls, frame.lang)
  const diff = runDiff(calls)
  const chip = diff ? diffArt(diff.added, diff.removed, frame.appearance) : undefined
  const chev = open ? '⌄' : '›'
  // The words take what the chip and the chevron leave, cut by the desktop's own measure.
  const room = frame.columns - 1 - (chip ? Math.ceil(chip.width / CELL_PX) + 1 : 0) - 2
  // The words and the chevron sit in unkeyed Boxes: a keyed Box is a hover scope of its own, and the
  // press laid over the row is on `head`, so only `head` sees the pointer anywhere along the line.
  return (
    <Box key={'run-' + id} flexDirection="column" rowGap={0.5} minWidth={0}>
      <Box key="head" flexDirection="row" alignItems="center" columnGap={1} minWidth={0}>
        <Box flexShrink={1} minWidth={0} overflow="hidden">
          <Text {...k.sub} hover={RUN_HOVER} wrap="truncate-end">{clipCh(summary.text, room)}</Text>
        </Box>
        {chip && diff ? <Box key="diff" flexShrink={0}>{pic(el, 'diff-' + id, chip.source, t(frame.lang, 'agents.diff', { added: diff.added, removed: diff.removed }), chip.width, DIFF_H)}</Box> : null}
        <Box flexShrink={0}>
          <Text {...k.mute} hover={RUN_HOVER}>{chev}</Text>
        </Box>
        {press(el, 'run-' + id, (frame.columns - 2) * CELL_PX, () => onToggle(id))}
      </Box>
      {open ? <Box key="calls" flexDirection="column" minWidth={0}>{shownCalls(calls, open, inFlight).map(call => toolRow(el, frame, call, agentLive, 1, call === inFlight ? since : undefined))}</Box> : null}
    </Box>
  )
}

/**
 * A run's line under the pointer, as the app lights its own (`text-muted-as-secondary
 * hover:text-primary`, its bundle 2026-10-24): the quiet words take the page's own ink, no light
 * behind them. `inherit` is that ink on either theme; a theme key would follow the terminal's
 * theme, not the app's, and a surface that takes neither leaves the words quiet.
 */
const RUN_HOVER = { color: 'inherit' }

/** A boxed block on the page: its answer, edged in its result's colour. */
function block(el: Els, frame: Frame, key: string, label: RenderNode, text: string, edge = 'rgba(128,124,116,0.32)'): RenderNode {
  const { Box, Markdown } = el
  return (
    <Box key={key} flexDirection="column" rowGap={0.5} width="100%" minWidth={0} paddingX={1.5} paddingY={0.5} borderStyle="round" borderColor={edge} backgroundColor="rgba(128,124,116,0.06)">
      {label}
      <Markdown key={key + '-text'} text={text} />
    </Box>
  )
}

/**
 * The conversation under the card, as the Claude app reads an agent's: the prompt it was given in
 * a card, its words as paragraphs, each run of tool calls one quiet line, the answer, and while it
 * works the spark at the foot.
 */
function talkDrawn(el: Els, frame: Frame, view: AgentsView, agent: AgentRec, talk: AgentTalk, actions: AgentsActions): RenderNode {
  const { Box, Markdown, Text } = el
  const k = pageLook(frame)
  const L = frame.lang
  if ('deny' in talk) {
    return (
      <Box key="talk" paddingX={0.5}>
        <Text {...k.sub} wrap="wrap">{t(L, 'agents.deny', { reason: talk.deny })}</Text>
      </Box>
    )
  }
  const page = pageOf(talk.entries, !live(agent))
  const items: RenderNode[] = []
  // Runs unfolded by their first call's id, long prompts by `prompt:<n>` (the first `prompt:first`).
  const opened = view.open?.runsOpen ?? []
  const prompt = (key: string, id: string, text: string) => promptCard(el, frame, key, cut(text, PROMPT_MAX), opened.includes(id), () => actions.toggleRun(id))
  if (page.first?.kind === 'prompt') items.push(prompt('task', 'prompt:first', page.first.text))
  if (page.dropped > 0) {
    items.push(
      <Box key="dropped" flexDirection="row" justifyContent="center">
        <Text {...k.mute}>{t(L, 'agents.dropped', { count: page.dropped })}</Text>
      </Box>,
    )
  }
  // Unfolded, the call it is in now carries its time.
  const inFlight = live(agent) ? page.shown.findLast(e => e.kind === 'tool' && e.state === 'running') : undefined
  const since = agent.toolSince ? elapsed(view.now - agent.toolSince, L) : undefined
  // Tool calls in a run fold into one line, as the Claude app shows them ("실행됨 명령 9개, 읽음
  // 파일 2개 ›"), and unfold call by call when pressed. Listed whole, a worker's dozens of commands
  // read as a wall (2026-10-20). A later prompt is named by its place among all the entries, so it
  // keeps its name as the conversation grows.
  const at = new Map(page.shown.map((entry, i) => [entry, page.dropped + i + 1]))
  for (const part of partsOf(page.shown)) {
    if (part.kind === 'run') items.push(runDrawn(el, frame, part.calls, live(agent), opened.includes(part.calls[0]!.id), inFlight, since, actions.toggleRun))
    else if (part.kind === 'prompt') items.push(prompt('prompt-' + at.get(part), 'prompt:' + at.get(part), part.text))
    else items.push(<Box key={'text-' + items.length} minWidth={0}><Markdown text={cut(part.text, TEXT_MAX)} /></Box>)
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
  if (!talk.entries.length) items.push(<Box key="nothing"><Text {...k.sub}>{t(L, 'agents.nothingYet')}</Text></Box>)
  // While it works, Claude's spark at the foot, under one key and one document (SPARK_ART).
  if (live(agent)) items.push(<Box key="spark" flexDirection="row" paddingLeft={0.25}>{pic(el, 'spark', SPARK_ART, t(L, 'agents.working'), SPARK_PX, SPARK_PX)}</Box>)
  return (
    <Box key="talk" flexDirection="column" rowGap={1} width="100%" minWidth={0}>
      {items}
    </Box>
  )
}

/**
 * The conversation on the desktop, as the Claude app shows an agent's: the head (a chevron back to
 * the list, the title, the time), the agent's card in its capsule (its model, effort and numbers, which
 * the app's view does not have), then what it said. Scrolled, the head stays at the window's top on
 * the pane's own surface: scrolling back up to leave was the owner's complaint (2026-10-20), and a
 * pill floating over the words hid them (2026-10-24).
 */
function openDrawn(el: Els, frame: Frame, view: AgentsView, actions: AgentsActions, agent: AgentRec | undefined, talk: AgentTalk): RenderNode {
  const { Box, Text } = el
  const k = pageLook(frame)
  const L = frame.lang
  if (!agent) {
    return (
      <Box flexDirection="column" rowGap={1} width="100%" minWidth={0}>
        {pageHead(el, frame, 'open-head', 'back', t(L, 'agents.title'), actions.back)}
        <Box key="gone" paddingX={0.5} minWidth={0}>
          <Text {...k.sub} wrap="wrap">{t(L, 'agents.gone')}</Text>
        </Box>
      </Box>
    )
  }
  const title = titleOf(agent)
  const stats = capsule(el, frame, {
    key: 'agent-open',
    sea: { tone: 'violet', reach: 120, at: { x: 1.5 * CELL_PX + 30, y: 20 } },
    rows: cardRows(frame, agent) + 1,
    paddingY: 0.5,
    children: [card(el, frame, agent)],
  })
  const end = (): HeadEnd => ({ node: timeBox(el, frame, agent, view.now), cells: timeCells(frame, agent) })
  const offset = frame.offset ?? 0
  return (
    <Box position="relative" flexDirection="column" rowGap={1} width="100%" minWidth={0}>
      {pageHead(el, frame, 'open-head', 'back', title, actions.back, end())}
      {stats}
      {talkDrawn(el, frame, view, agent, talk, actions)}
      {offset > 0 ? floatingHead(el, frame, offset, title, actions.back, end()) : null}
    </Box>
  )
}

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
        <Text bold wrap="wrap">{cut(titleOf(agent), 240)}</Text>
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
          <Text color={tone.warn} wrap="wrap">{fallbackLine(frame, agent)}</Text>
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
      <Text wrap="wrap">{cut(titleOf(agent), 240)}</Text>
      <Text dimColor>{modelLine(frame, agent)}</Text>
      <Text dimColor>{ranFor(agent, now, frame.lang)}</Text>
      {nums ? <Text dimColor>{nums}</Text> : null}
      {textButton(el, 'open-' + agent.id, t(frame.lang, 'agents.open'), onOpen, hotkey)}
    </Box>
  )
}

/** A background task in a line: its mark, title, kind, what it runs, how it ended and its time. */
function taskLine(el: Els, frame: Frame, task: BgTask, now: number): RenderNode {
  const { Box, Text } = el
  const tone = textTone(frame.appearance)
  const L = frame.lang
  const glyph = task.state === 'running' ? '●' : task.state === 'done' ? '✓' : task.state === 'failed' ? '✕' : '■'
  const color = task.state === 'running' ? tone.accent : task.state === 'done' ? tone.ok : task.state === 'failed' ? tone.bad : undefined
  const command = taskCommand(task)
  const rest = [t(L, task.kind === 'shell' ? 'agents.shell' : 'agents.monitor'), command ? clip(command, 80) : '', taskEndWord(frame, task), taskCode(frame, task), taskRanFor(task, now, L)]
  return (
    <Box key={'task-' + task.id} flexDirection="row" flexWrap="wrap" columnGap={1} paddingLeft={task.state === 'running' ? 0 : 1}>
      <Text color={color} dimColor={task.state === 'stopped'}>{glyph}</Text>
      <Text wrap="wrap">{cut(task.title, 240)}</Text>
      <Text dimColor>{rest.filter(Boolean).join(' · ')}</Text>
    </Box>
  )
}

function listText(el: Els, frame: Frame, view: AgentsView, actions: AgentsActions, running: Item[], done: Item[]): RenderNode {
  const { Box, Text } = el
  const shownDone = view.showDone ? done : done.slice(0, DONE_SHOWN)
  // The first nine agents a digit each, in the order drawn; a task has nothing to open.
  let n = 0
  const key = () => (++n <= 9 ? String(n) : undefined)
  return (
    <Box flexDirection="column" rowGap={1} width="100%">
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Text bold>{running.length ? t(frame.lang, 'agents.liveCount', { count: running.length }) : t(frame.lang, 'agents.noneRunning')}</Text>
        {done.length ? <Text dimColor>{t(frame.lang, 'agents.doneCount', { count: done.length })}</Text> : null}
      </Box>
      {running.map(item => item.kind === 'agent' ? liveLines(el, frame, item.agent, view.now, key(), () => actions.open(item.agent.id)) : taskLine(el, frame, item.task, view.now))}
      {shownDone.length ? (
        <Box flexDirection="column">
          {shownDone.map(item => item.kind === 'agent' ? doneLine(el, frame, item.agent, view.now, key(), () => actions.open(item.agent.id)) : taskLine(el, frame, item.task, view.now))}
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
        <Text bold wrap="wrap">{cut(titleOf(agent), 240)}</Text>
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

/** Diagnostic rows must themselves survive the text that caused the original tree to be refused. */
function diagnostic(text: string, max: number): string {
  return JSON.stringify(cut(text, max)).slice(1, -1).replace(/[\x7f-\x9f\u{2800}\u{10eeee}\p{M}]/gu, char => '\\u{' + char.codePointAt(0)!.toString(16).toUpperCase() + '}')
}

/** The render boundary's last resort: no artwork, model metadata or conversation to fail again. */
export function renderAgentsFallback(el: Els, frame: Frame, records: readonly AgentRec[], error: string, actions: AgentsActions & { close: () => void }, wasOpen: boolean): RenderNode {
  const { Box, Text, Button } = el
  const L = frame.lang
  return (
    <Box flexDirection="column" rowGap={1} width="100%">
      <Box flexDirection="row" columnGap={2}>
        <Text bold>{t(L, 'agents.title')}</Text>
        {wasOpen ? textButton(el, 'back', t(L, 'agents.back'), actions.back, 'b') : null}
        <Button key="close" plain role="dismiss" label={t(L, 'settings.close')} onPress={actions.close} />
      </Box>
      <Text dimColor wrap="truncate-end">{diagnostic(error, 240)}</Text>
      {records.slice(-40).map((agent, i) => (
        <Box key={'fallback-' + i} flexDirection="row" columnGap={1}>
          <Text>{agent.state === 'running' ? '●' : agent.state === 'waiting' ? '◐' : agent.state === 'done' ? '✓' : '✕'}</Text>
          <Text wrap="wrap">{diagnostic(agent.description ?? agent.id, 160)}</Text>
          {textButton(el, 'fallback-open-' + i, t(L, 'agents.open'), () => actions.open(agent.id))}
        </Box>
      ))}
    </Box>
  )
}

/** The Agents pane body: the list, or one agent's conversation. */
function agentsTree(el: Els, frame: Frame, view: AgentsView, actions: AgentsActions): RenderNode {
  const drawn = canDraw(el, frame)
  if (view.open) {
    const agent = view.agents.find(a => a.id === view.open!.id)
    return drawn ? openDrawn(el, frame, view, actions, agent, view.open.talk) : openText(el, frame, view, actions, agent, view.open.talk)
  }
  const items: Item[] = [...view.agents.map((agent): Item => ({ kind: 'agent', agent })), ...(view.tasks ?? []).map((task): Item => ({ kind: 'task', task }))]
  // Empty, the pane has nothing to redraw it, so 리플이 can live out its idle loops here.
  if (items.length === 0) return speak(el, frame, { key: 'agents', face: 'calm', size: GREET_SIZE, title: t(frame.lang, 'agents.emptyTitle'), line: t(frame.lang, 'agents.emptyBody') })
  const running = items.filter(itemLive).sort((a, b) => itemStart(a) - itemStart(b))
  const done = items.filter(i => !itemLive(i)).sort((a, b) => itemEnd(b) - itemEnd(a))
  return drawn ? listDrawn(el, frame, view, actions, running, done) : listText(el, frame, view, actions, running, done)
}

/**
 * Check the engine's data-dependent cuts before returning: its FINAL tree validation can bypass a
 * hook's .catch. Keep an invalid agent/conversation on our error path, not the engine placeholder.
 * The static element/prop shapes remain the engine harness's responsibility.
 */
export function renderAgents(el: Els, frame: Frame, view: AgentsView, actions: AgentsActions): RenderNode {
  view = {
    ...view,
    agents: view.agents.map(agent => ({ ...agent,
      ...(agent.type ? { type: displayText(agent.type, DISPLAY.name) } : {}),
      ...(agent.model ? { model: displayText(agent.model, DISPLAY.name) } : {}),
      ...(agent.answeredBy ? { answeredBy: displayText(agent.answeredBy, DISPLAY.name) } : {}),
      ...(agent.effort ? { effort: displayText(String(agent.effort), DISPLAY.name) } : {}),
      ...(agent.now ? { now: displayText(agent.now) } : {}),
      ...(agent.pick ? { pick: { ...agent.pick, why: displayText(agent.pick.why), ...(agent.pick.fallbackReason ? { fallbackReason: displayText(agent.pick.fallbackReason) } : {}) } } : {}),
    })),
    ...(view.tasks ? { tasks: view.tasks.map(task => ({ ...task, title: displayText(task.title, DISPLAY.name), ...(task.command ? { command: displayText(task.command) } : {}), ...(task.summary ? { summary: displayText(task.summary) } : {}) })) } : {}),
    ...(view.open ? { open: { ...view.open, talk: 'deny' in view.open.talk ? { deny: displayText(view.open.talk.deny) } : { entries: view.open.talk.entries.map(entry => entry.kind === 'tool' ? { ...entry, tool: displayText(entry.tool, DISPLAY.name), detail: displayText(entry.detail) } : { ...entry, text: displayText(entry.text, DISPLAY.conversation) }) } } } : {}),
  }
  const tree = agentsTree(el, frame, view, actions)
  let nodes = 0
  const text = (value: string) => {
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ud800-\udfff\u{10eeee}]/u.test(value)) throw new Error('에이전트 내용에 표시할 수 없는 제어 문자가 있습니다.')
    // The engine reserves a subset of combining marks for image cells; fail safely for this shape.
    if (/^\p{M}|\u{2800}\p{M}/u.test(value)) throw new Error('에이전트 내용에 이미지 표시와 충돌하는 결합 문자가 있습니다.')
  }
  const visit = (node: RenderNode, depth: number): void => {
    if (++nodes > 20_000 || depth > 32) throw new Error('에이전트 화면이 노드 20,000개 또는 중첩 깊이 32단계 제한을 초과했습니다.')
    if (typeof node === 'string') { text(node); return }
    if (node.type === 'Svg') {
      if (node.props.source.length > 131_072) throw new Error('에이전트 이미지가 SVG 소스 131,072자 제한을 초과했습니다.')
      for (const side of [node.props.width, node.props.height]) if (side !== undefined && (!Number.isFinite(side) || side <= 0 || side > SVG_MAX_PX)) throw new Error('에이전트 이미지의 가로·세로 크기는 0보다 크고 4,096픽셀 이하여야 합니다.')
      text(node.props.alt)
    }
    if (node.type === 'Button') text(node.props.label)
    if (node.type === 'Markdown') {
      text(node.props.text)
      if ((node.props.key?.length ?? 0) > 10_000) throw new Error('에이전트 대화의 식별자가 10,000자 제한을 초과했습니다.')
    }
    if ('children' in node) for (const child of node.children ?? []) visit(child, depth + 1)
  }
  visit(tree, 0)
  return tree
}
