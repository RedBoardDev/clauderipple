// A subagent's tool calls as the Agents pane words them: one short line of each call's input, and a
// run of calls headed in one line the way the Claude app heads it ("실행됨 명령 7개, 편집함 파일
// 1개"), with the lines its edits added and removed. Pure, so the tests can call it.
//
// The head follows the Claude desktop app's own (its transcript bundle, read 2026-10-24): a verb and
// what it acted on per kind, kinds in the order they first appear but the tools it has no kind for
// ("사용함 도구 N개") always last, a file or page counted once, every kind shown (the line is cut at
// the pane's edge), the first word capitalised. Ours put the unnamed tools wherever they first came
// and read differently from the app's view beside it. The phone app words a run by the same rules
// (packages/remote/src/tool-details.ts `activitySummary`); the mod cannot import it, as Claude Code
// loads the mod as its own folder (dist/mod in an npm install, scripts/build-npm.mjs).

import { t } from '../i18n.ts'
import type { Lang } from '../i18n.ts'

/** Where the session runs and the user's home, to say paths short: relative to the one, `~` for the other. */
export type Place = { cwd?: string; home?: string }

/** One tool call as the pane holds it (view.ts AgentEntry's tool kind); an edit's lines added and removed. */
export type ToolCall = { id: string; tool: string; detail: string; state: 'running' | 'ok' | 'error'; added?: number; removed?: number }

type Activity = 'command' | 'read' | 'write' | 'edit' | 'notebook' | 'grep' | 'glob' | 'browse' | 'fetch' | 'agent' | 'todo' | 'other'

/**
 * A call's kind, as the app sorts it. A Write is "created": a subagent's transcript keeps no result
 * to tell a file it replaced, as the app's own view has none either.
 */
function activityOf(tool: string): Activity {
  if (['Bash', 'BashOutput', 'KillShell'].includes(tool)) return 'command'
  if (tool === 'Read') return 'read'
  if (tool === 'Write') return 'write'
  if (['Edit', 'MultiEdit'].includes(tool)) return 'edit'
  if (tool === 'NotebookEdit') return 'notebook'
  if (tool === 'Grep') return 'grep'
  if (tool === 'Glob') return 'glob'
  if (tool === 'WebSearch') return 'browse'
  if (tool === 'WebFetch') return 'fetch'
  if (['Task', 'Agent'].includes(tool)) return 'agent'
  if (tool === 'TodoWrite') return 'todo'
  return 'other'
}

/** Kinds counted by what they acted on (a file, a page), not by call. */
const BY_TARGET: ReadonlySet<Activity> = new Set(['read', 'write', 'edit', 'notebook', 'fetch'])
/** Kinds the app words with no count ("검색함 코드"). */
const UNCOUNTED: ReadonlySet<Activity> = new Set(['grep', 'glob', 'browse', 'todo'])

/** A directory without its trailing slash; nothing for one that cannot shorten a path (`/`, `~`). */
function dir(path: string | undefined): string | undefined {
  const bare = path?.replace(/\/+$/, '')
  return bare && bare.startsWith('/') ? bare : undefined
}

/** A path relative to the session's folder, else under `~`, else as given. */
export function shortPath(path: string, place: Place): string {
  const cwd = dir(place.cwd)
  const home = dir(place.home)
  if (cwd) {
    if (path === cwd) return '.'
    if (path.startsWith(cwd + '/')) return path.slice(cwd.length + 1)
  }
  if (home) {
    if (path === home) return '~'
    if (path.startsWith(home + '/')) return '~' + path.slice(home.length)
  }
  return path
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Every absolute path in a command said short, as shortPath says one. */
function shortPaths(text: string, place: Place): string {
  let out = text
  const cwd = dir(place.cwd)
  const home = dir(place.home)
  if (cwd) out = out.replace(new RegExp(escape(cwd) + '(/|(?![\\w.-]))', 'g'), (_m, slash: string) => slash ? '' : '.')
  if (home) out = out.replace(new RegExp(escape(home) + '(?=/|(?![\\w.-]))', 'g'), '~')
  return out
}

/** A `cd <dir> &&` (or `;`, or a line of its own) at the head of a command: it says nothing about what it does. */
const CD = /^\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;|\n)\s*/

/** A command as a line: without the `cd` it opens with, its first line only, its paths short. */
export function commandLine(command: string, place: Place = {}): string {
  let rest = command
  for (let i = 0; i < 3 && CD.test(rest); i++) rest = rest.replace(CD, '')
  const first = rest.split('\n').find(line => line.trim()) ?? ''
  return shortPaths(first.trim(), place)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value)
}

function firstLine(value: string): string {
  return (value.split('\n').find(line => line.trim()) ?? '').trim()
}

/**
 * A tool call's input in one line: a command's own description when it gave one, else the command;
 * a file's path; a search's pattern (and where). Paths short, multi-line input its first line.
 */
export function toolDetail(tool: string, input: Readonly<Record<string, unknown>>, place: Place = {}): string {
  if (tool === 'Bash') {
    const description = firstLine(text(input.description))
    if (description) return description
    return commandLine(text(input.command), place)
  }
  if (tool === 'Grep' || tool === 'Glob') {
    const where = text(input.path)
    return [firstLine(text(input.pattern)), where ? shortPath(where, place) : ''].filter(Boolean).join(' · ')
  }
  const path = text(input.file_path ?? input.notebook_path ?? input.path)
  if (path) return shortPath(firstLine(path), place)
  const detail = input.command ?? input.pattern ?? input.query ?? input.url ?? input.description ?? input.prompt ?? ''
  return shortPaths(firstLine(text(detail)), place)
}

/** A text's lines, a newline that ends it closing the last rather than opening another. */
function linesOfText(value: unknown): string[] {
  const body = typeof value === 'string' ? value : ''
  if (!body) return []
  const lines = body.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * Lines `after` adds and `before` loses, as the phone app's diff counts them: walk both, and where
 * they part, skip to the nearest line they share again (fewest lines skipped on both sides).
 */
function changed(before: unknown, after: unknown): { added: number; removed: number } {
  const a = linesOfText(before)
  const b = linesOfText(after)
  const where = new Map<string, number[]>()
  b.forEach((line, at) => { const list = where.get(line); if (list) list.push(at); else where.set(line, [at]) })
  let i = 0
  let j = 0
  let added = 0
  let removed = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue }
    let best: { i: number; j: number; skip: number } | undefined
    for (let k = i; k < a.length; k++) {
      if (best && k - i > best.skip) break
      const list = where.get(a[k]!)
      if (!list) continue
      // The first place at or past j: a repeated line may occur thousands of times.
      let lo = 0
      let hi = list.length
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (list[mid]! < j) lo = mid + 1; else hi = mid }
      const next = list[lo]
      if (next === undefined) continue
      const skip = k - i + next - j
      if (!best || skip < best.skip) best = { i: k, j: next, skip }
    }
    if (!best) break
    removed += best.i - i
    added += best.j - j
    i = best.i
    j = best.j
  }
  return { added: added + b.length - j, removed: removed + a.length - i }
}

/**
 * Lines an edit adds and removes, from what the model sent it (a subagent's transcript keeps no
 * result to read a patch from): an Edit's old and new text, a MultiEdit's every pair, a Write's
 * whole content as added. Nothing for any other tool.
 */
export function editLines(tool: string, input: Readonly<Record<string, unknown>>): { added: number; removed: number } | undefined {
  if (tool === 'Edit') return changed(input.old_string, input.new_string)
  if (tool === 'Write') return { added: linesOfText(input.content).length, removed: 0 }
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    let added = 0
    let removed = 0
    for (const edit of input.edits) {
      if (!edit || typeof edit !== 'object') continue
      const one = changed((edit as Record<string, unknown>).old_string, (edit as Record<string, unknown>).new_string)
      added += one.added
      removed += one.removed
    }
    return { added, removed }
  }
  return undefined
}

/** The lines a run's answered edits added and removed; nothing when it changed none. */
export function runDiff(run: readonly ToolCall[]): { added: number; removed: number } | undefined {
  let added = 0
  let removed = 0
  for (const call of run) {
    if (call.state !== 'ok') continue
    added += call.added ?? 0
    removed += call.removed ?? 0
  }
  return added || removed ? { added, removed } : undefined
}

/** A run's head in one line, and how many of its calls failed. */
export function runSummary(run: readonly ToolCall[], lang: Lang): { text: string; failed: number } {
  const targets = new Map<Activity, Set<string>>()
  for (const call of run) {
    const kind = activityOf(call.tool)
    const seen = targets.get(kind) ?? new Set<string>()
    seen.add(BY_TARGET.has(kind) && call.detail ? call.detail : call.id)
    targets.set(kind, seen)
  }
  // A stable sort: the named kinds keep the order they came in, the unnamed tools go after them.
  const kinds = [...targets.keys()].sort((a, b) => Number(a === 'other') - Number(b === 'other'))
  const text = kinds.map(kind => {
    const count = targets.get(kind)!.size
    return t(lang, 'agents.act.' + kind + (UNCOUNTED.has(kind) || count !== 1 ? '' : 'One'), { count })
  }).join(', ')
  return {
    text: text.charAt(0).toLocaleUpperCase(lang) + text.slice(1),
    failed: run.filter(call => call.state === 'error').length,
  }
}
