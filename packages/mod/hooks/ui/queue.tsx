// What the phone queued for this chat, drawn over the band while anything waits there.
//
// The host keeps those messages and sends them when the turn ends (packages/remote/src/queue.ts);
// the Claude app never sees them, so the Mac showed nothing queued. Asked 2026-10-22: above the
// band, only while something waits, taking none of the band's own room. The desktop draws it as a
// slim capsule of the deep lit amber (waiting, not wrong); the terminal as one line.

import { t } from '../i18n'
import type { RenderNode } from 'claude-code'

import { CELL_PX, ROW_PX } from './art'
import { displayText } from './display'
import { capsule } from './kit'
import { lookOf } from './look'
import type { Els } from './parts'
import type { Frame } from './view'
import { isRich } from './view'

export type PhoneQueue = { count: number; first: string }

/** Rows the strip takes above the band, so the band's own budget can give them up. */
export const PHONE_QUEUE_ROWS = 1

export function renderPhoneQueue(el: Els, frame: Frame, queue: PhoneQueue): RenderNode {
  const { Box, Text } = el
  const title = t(frame.lang, 'band.phoneQueue', { count: queue.count })
  const first = displayText(queue.first.replace(/\s+/g, ' ').trim())
  const when = t(frame.lang, 'band.phoneQueueWhen')
  if (!isRich(frame) || !('Svg' in el)) {
    return (
      <Box key="phone-queue" flexDirection="row" columnGap={1} minWidth={0} height={1} overflow="hidden">
        <Box flexShrink={0}><Text color="warning">{'◷ ' + title}</Text></Box>
        {first ? <Box flexShrink={1} minWidth={0}><Text dimColor wrap="truncate">{first}</Text></Box> : null}
        <Box flexShrink={0}><Text dimColor>{'· ' + when}</Text></Box>
      </Box>
    )
  }
  const k = lookOf(frame)
  const amber = k.tone('amber')
  return capsule(el, frame, {
    key: 'phone-queue',
    // The light sits on the clock mark at the strip's start.
    sea: { tone: 'amber', ripples: 'calm', reach: 60, at: { x: 1.5 * CELL_PX + CELL_PX / 2, y: ROW_PX * 0.6 } },
    rows: 1.1,
    paddingY: 0.25,
    children: [
      <Box key="phone-queue-row" flexDirection="row" alignItems="center" columnGap={1} width="100%" minWidth={0}>
        <Box flexShrink={0}><Text color={amber}>◷</Text></Box>
        <Box flexShrink={0}><Text color={amber}>{title}</Text></Box>
        {first ? <Box flexShrink={1} minWidth={0}><Text {...k.sub} wrap="truncate">{first}</Text></Box> : null}
        <Box flexGrow={1} />
        <Box flexShrink={0}><Text {...k.mute}>{when}</Text></Box>
      </Box>,
    ],
  })
}
