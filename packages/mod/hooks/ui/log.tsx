// The request log pane: the router's records of model requests, newest first, one entry each with
// what matters (model, provider, effort, tokens, cache, time, result). Moved here unchanged in
// content from register.tsx's own drawing.

import { t } from '../i18n'
import type { RenderNode } from 'claude-code'

import type { JudgeRun, JudgeTarget, StatusRequest } from '../../types'
import { GREET_SIZE, action, actions as actions_, speak } from './parts'
import type { Els } from './parts'
import { cacheTone, providerColor, textTone } from './theme'
import type { Frame, LogActions, LogView } from './view'
import { cachePercent, clockTime, effortLabel, modelOf, promptTokens, seconds } from './view'

function entry(el: Els, frame: Frame, record: StatusRequest, mineOnly: boolean): RenderNode {
  const { Box, Text } = el
  const tone = textTone(frame.appearance)
  const cache = cachePercent(record.usage)
  return (
    <Box key={record.at + '-' + record.target} flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {mineOnly ? null : (
          <Text color={record.mine ? tone.accent : undefined} dimColor={!record.mine}>
            {record.mine ? '●' : '○'}
          </Text>
        )}
        <Text dimColor>{clockTime(record.at)}</Text>
        <Text bold wrap="wrap">
          {modelOf(record)}
        </Text>
        <Text color={providerColor(record.provider)}>{record.provider}</Text>
        {record.resent ? (
          <Text dimColor>{t(frame.lang, 'log.resent', { status: String(record.status) })}</Text>
        ) : (
          <Text color={record.ok ? tone.ok : tone.bad} bold={!record.ok}>
            {record.ok ? '✓' : '✕ ' + String(record.status)}
          </Text>
        )}
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Text dimColor>{record.effort ? effortLabel(record.effort, frame.lang) : '-'}</Text>
        {record.usage ? <Text dimColor>{t(frame.lang, 'log.input', { tokens: tokens(promptTokens(record.usage)) })}</Text> : null}
        {cache !== undefined ? <Text color={tone[cacheTone(cache)]}>{t(frame.lang, 'band.cachePercent', { percent: cache })}</Text> : null}
        {record.usage ? <Text dimColor>{t(frame.lang, 'log.output', { tokens: tokens(record.usage.output) })}</Text> : null}
        <Text dimColor>{seconds(record.ms / 1000, frame.lang)}</Text>
      </Box>
      {!record.ok && record.note ? (
        <Text color={record.resent ? undefined : tone.bad} dimColor={record.resent} wrap="wrap">
          {record.note}
        </Text>
      ) : null}
    </Box>
  )
}

const JUDGE_NAME = { haiku: 'settings.haiku', jev: 'settings.jev', model: 'agents.routerModel' } as const

/** A target by its model when it is a router model (two of them can take turns), else by its kind. */
function targetName(frame: Frame, target: JudgeTarget): string {
  return target.kind === 'model' ? target.model : t(frame.lang, JUDGE_NAME[target.kind])
}

/**
 * A verdict of this session's judge: who answered, in how long, what it chose, or why it fell back.
 * A run from an older mod has no attempts: it still shows its asked and answering kinds.
 */
function judgeEntry(el: Els, frame: Frame, run: JudgeRun): RenderNode {
  const { Box, Text } = el
  const tone = textTone(frame.appearance)
  const attempts = run.attempts ?? []
  const answered = run.effort !== undefined
  const first = attempts[0]?.target
  const failed = attempts.find(attempt => attempt.error)
  const last = attempts.at(-1)?.target
  // Exhausted: nothing answered after more than one try, or the only one failed.
  const exhausted = attempts.length > 0 && !answered
  const recovered = attempts.length > 1 && answered
  const fell = attempts.length ? exhausted || recovered : run.by !== run.asked
  const who = exhausted
    ? t(frame.lang, 'log.judgeExhausted', { judges: attempts.map(a => targetName(frame, a.target)).join(' → ') })
    : recovered && first && last
      ? t(frame.lang, 'log.judgeFell', { asked: attempts.filter(a => a.error).map(a => targetName(frame, a.target)).join(' → ') || targetName(frame, first), by: targetName(frame, last) })
      : attempts.length ? targetName(frame, last!)
        : fell ? t(frame.lang, 'log.judgeFell', { asked: t(frame.lang, JUDGE_NAME[run.asked]), by: t(frame.lang, JUDGE_NAME[run.by]) }) : t(frame.lang, JUDGE_NAME[run.by])
  const verdict = run.effort ? effortLabel(run.effort, frame.lang) + (run.sure !== undefined ? ' · ' + t(frame.lang, 'log.sure', { percent: Math.round(run.sure * 100) }) : '') : t(frame.lang, 'toasts.noVerdict')
  return (
    <Box key={'judge-' + run.at} flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Text dimColor>{clockTime(run.at)}</Text>
        <Text bold>{t(frame.lang, run.for === 'worker' ? 'log.judgeWorker' : 'log.judge')}</Text>
        <Text color={fell ? tone.warn : tone.accent}>{who}</Text>
        <Text dimColor>{'→ ' + verdict}</Text>
        <Text dimColor>{seconds(run.ms / 1000, frame.lang)}</Text>
      </Box>
      {attempts.length > 1 ? attempts.filter(a => a.error).map((a, at) => (
        <Text key={'attempt-' + at} color={tone.warn} wrap="wrap">
          {targetName(frame, a.target) + ' · ' + seconds(a.ms / 1000, frame.lang) + ' · ' + a.error}
        </Text>
      )) : run.error ? (
        <Text color={tone.warn} wrap="wrap">
          {failed?.target.kind === 'model' ? failed.target.model + ': ' + run.error : run.error}
        </Text>
      ) : null}
    </Box>
  )
}

/** The log pane body: this session's verdicts in time order among its requests. */
export function renderLog(el: Els, frame: Frame, view: LogView, actions: LogActions): RenderNode {
  const { Box, Text } = el
  const judges = view.mineOnly ? (view.judges ?? []) : []
  const items = [...view.rows.map(record => ({ at: Date.parse(record.at), node: () => entry(el, frame, record, view.mineOnly) })), ...judges.map(run => ({ at: run.at, node: () => judgeEntry(el, frame, run) }))].sort((a, b) => b.at - a.at)
  const scopeName = view.mineOnly ? t(frame.lang, 'log.thisSession') : t(frame.lang, 'log.allSessions')
  const scope = action(el, frame, 'scope', view.mineOnly ? t(frame.lang, 'log.showAll') : t(frame.lang, 'log.onlySession'), actions.toggleScope, { hotkey: 'a' })
  const legend = !view.mineOnly ? <Text key="legend" dimColor wrap="wrap">{t(frame.lang, 'log.legend')}</Text> : ''
  // Empty, the pane has nothing to redraw it, so 리플이 can live out its idle loops here; with
  // requests every poll redraws it and would start its motion over, so the list has no picture.
  if (items.length === 0) return speak(el, frame, { key: 'log', face: 'calm', size: GREET_SIZE, title: scopeName, line: t(frame.lang, 'log.empty'), blocks: [legend, actions_(el, frame, [scope])] })
  return (
    <Box flexDirection="column" gap={1} width="100%">
      <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2}>
        <Text bold>{scopeName}</Text>
        {scope}
      </Box>
      {legend}
      {items.map(item => item.node())}
    </Box>
  )
}

// The log keeps one decimal at every size (12.3k), as it always has.
function tokens(n: number): string {
  return n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
}
