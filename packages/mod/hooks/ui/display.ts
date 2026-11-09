import type { RenderNode } from 'claude-code'

// External values become display text here, never in persisted state or action arguments.
// Limits count UTF-16 units, as the engine's shared 100,000-character tree budget does.
export const DISPLAY = { name: 120, preview: 240, detail: 600, conversation: 12_000, log: 60_000 } as const

/** Strip terminal escapes (including OSC/DCS payloads), then controls the engine refuses. */
export function displayText(value: string, max: number = DISPLAY.preview): string {
  const clean = value
    .replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ud800-\udfff\u{10eeee}]/gu, '')
  if (clean.length <= max) return clean
  if (max <= 0) return ''
  // Never split a supplementary code point at the preview boundary.
  let end = Math.max(0, max - 1)
  if (/[\ud800-\udbff]/.test(clean.charAt(end - 1))) end--
  return clean.slice(0, end).trimEnd() + '…'
}

/** Count content before returning it to the engine, including labels and image alts. */
export function displayChars(node: RenderNode): number {
  if (typeof node === 'string') return node.length
  let count = 0
  if (node.type === 'Button') count += node.props.label.length
  if (node.type === 'Svg') count += node.props.alt.length
  if (node.type === 'Markdown') count += node.props.text.length
  if (node.type === 'Code') count += node.props.source.length
  if ('children' in node) for (const child of node.children ?? []) count += displayChars(child)
  return count
}
