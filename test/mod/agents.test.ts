import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import ts from 'typescript'
import type { AgentRec } from '../../packages/mod/types/index.d.ts'
import type { Frame } from '../../packages/mod/hooks/ui/view.ts'

// The engine's JSX factory is an external boundary. Keep its plain tree here; the matching
// packages/mod/tests/agents-boundary.test.tsx mounts these cases through the actual engine too.
type Tree = { type: string; props: Record<string, unknown>; children: (Tree | string)[] }
function h(type: string, props: Record<string, unknown> | null, ...children: unknown[]): Tree {
  const flatten = (value: unknown): (Tree | string)[] => {
    if (Array.isArray(value)) return value.flatMap(flatten)
    if (value === null || value === undefined || typeof value === 'boolean') return []
    return [typeof value === 'number' ? String(value) : value as Tree | string]
  }
  return { type, props: props ?? {}, children: children.flatMap(flatten) }
}
Object.assign(globalThis, { h })
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes('/packages/mod/hooks/') && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/.test(specifier)) {
      const url = new URL(specifier, context.parentURL)
      return next(specifier + (existsSync(new URL(url.href + '.tsx')) ? '.tsx' : '.ts'), context)
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (!url.endsWith('.tsx')) return next(url, context)
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React, jsxFactory: 'h' },
    }).outputText }
  },
})
const { cardRows, renderAgents, renderAgentsFallback, TALK_ENTRIES } = await import('../../packages/mod/hooks/ui/agents.tsx')
const el = { Box: 'Box', Text: 'Text', Button: 'Button', Markdown: 'Markdown', Svg: 'Svg' } as Parameters<typeof renderAgents>[0]
const frame: Frame = { surface: 'desktop', columns: 40, maxRows: 30, now: 1_000_000, skin: 'deep', appearance: 'auto', lang: 'ko' }
const actions = { open: (_id: string) => {}, back: () => {}, toggleDone: () => {}, toggleRun: (_id: string) => {} }
const base: AgentRec = {
  id: 'worker', description: '워크트리 격리 검토 · 재개된 에이전트', type: 'ripple:auto', model: 'gpt-6.1-sol@high',
  state: 'running', startedAt: 1, cost: 0, provider: 'chatgpt', effort: 'high', tools: 500,
  usage: { input: 100_000, cached: 900_000, cacheWrite: 1000, output: 50_000 },
}
function nodes(tree: unknown): Tree[] {
  const out: Tree[] = []
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object' || !('type' in value)) return
    const node = value as Tree
    out.push(node)
    node.children.forEach(visit)
  }
  visit(tree)
  return out
}
function textOf(tree: unknown): string {
  return nodes(tree).flatMap(n => [n.props.text ?? '', ...n.children.filter(c => typeof c === 'string')]).join('\n')
}

test('long fallback reasons do not create an unbounded SVG sea or thousands of card press strips', () => {
  const agent: AgentRec = { ...base, pick: { domain: 'general', level: 'standard', effort: 'high', by: 'session', why: '', target: { agent: 'general-purpose' }, rule: 'general', ms: 0, fallbackReason: '사용 한도를 초과했습니다. '.repeat(1000) } }
  assert.ok(cardRows(frame, agent) < 50)
  const records = Array.from({ length: 48 }, (_, i) => ({ ...agent, id: 'w' + i }))
  const tree = renderAgents(el, frame, { agents: records, now: frame.now, showDone: true }, actions)
  const all = nodes(tree)
  assert.ok(all.length < 10_000)
  assert.ok(all.filter(n => n.type === 'Button').length < 2000)
  const chars = all.reduce((n, node) => n + node.children.reduce((sum, child) => sum + (typeof child === 'string' ? child.length : 0), 0) + ['label', 'text', 'alt'].reduce((sum, key) => sum + (typeof node.props[key] === 'string' ? node.props[key].length : 0), 0), 0)
  assert.ok(chars < 90_000, 'rendered characters including blank press strips: ' + chars)
  // The list row holds the model and tokens only (the Claude app's task list); the reason is on
  // the open conversation's card, cut.
  const opened = renderAgents(el, frame, { agents: records, now: frame.now, showDone: true, open: { id: 'w0', talk: { entries: [] } } }, actions)
  assert.ok(textOf(opened).includes('사용 한도를 초과했습니다.'))
  assert.ok(!textOf(opened).includes(agent.pick!.fallbackReason!))
  assert.ok(!textOf(tree).includes(agent.pick!.fallbackReason!))
  for (const svg of all.filter(n => n.type === 'Svg')) {
    assert.ok(Number(svg.props.width) <= 4096)
    assert.ok(Number(svg.props.height) <= 4096)
    assert.ok(String(svg.props.source).length <= 131_072)
  }
})

test('48 mixed workers including 31 Workflow workers keep their rows, Korean titles and SVG bounds', () => {
  const agents = Array.from({ length: 48 }, (_, i): AgentRec => ({ ...base, id: 'w' + i, description: '검토 ' + i + ' · 긴 한국어 설명'.repeat(200), state: i < 31 ? 'running' : 'done', endedAt: frame.now - i }))
  for (const skin of ['deep', 'flat'] as const) for (const appearance of ['light', 'dark'] as const) {
    const tree = renderAgents(el, { ...frame, skin, appearance }, { agents, now: frame.now, showDone: true }, actions)
    const all = nodes(tree)
    assert.equal(all.filter(n => n.props.key === 'card-w0').length, 1)
    assert.equal(all.filter(n => n.props.key === 'card-w47').length, 1)
    assert.ok(textOf(tree).includes('검토 47'))
    for (const svg of all.filter(n => n.type === 'Svg')) {
      assert.ok(Number(svg.props.width) <= 4096)
      assert.ok(Number(svg.props.height) <= 4096)
    }
  }
})

test('background tasks sit with the agents, running with running and ended with ended, on either surface', () => {
  const tasks = [
    { id: 'b-dev', kind: 'shell' as const, title: '개발 서버 실행', command: 'npm run dev', state: 'running' as const, startedAt: 2 },
    { id: 'b-test', kind: 'shell' as const, title: 'npm test', command: 'npm test', state: 'failed' as const, startedAt: 3, endedAt: frame.now - 1, summary: 'Background command "npm test" failed with exit code 1' },
  ]
  const done: AgentRec = { ...base, id: 'old', state: 'done', endedAt: frame.now - 5 }
  for (const surface of ['desktop', 'terminal'] as const) {
    const tree = renderAgents(el, { ...frame, surface }, { agents: [base, done], tasks, now: frame.now, showDone: true }, actions)
    const keys = nodes(tree).map(n => String(n.props.key))
    const text = textOf(tree)
    assert.ok(text.includes('2개 실행 중') && text.includes('2개 완료'), text)
    assert.ok(keys.indexOf('task-b-dev') > keys.indexOf(surface === 'desktop' ? 'card-worker' : 'agent-worker'))
    assert.ok(keys.indexOf('task-b-test') < keys.indexOf(surface === 'desktop' ? 'card-old' : 'done-old'))
    assert.ok(text.includes('npm run dev') && text.includes('종료 코드 1') && text.includes('실패'))
  }
  // Tasks alone are a list, not the empty pane.
  assert.ok(textOf(renderAgents(el, frame, { agents: [], tasks, now: frame.now, showDone: false }, actions)).includes('개발 서버 실행'))
})

test('unfolded short tool histories are bounded by entries as well as characters and keep the latest calls', () => {
  const entries = Array.from({ length: 1800 }, (_, i) => ({ kind: 'tool' as const, id: 't' + i, tool: 'Bash', detail: 'pwd', state: 'ok' as const }))
  const first = entries.length - TALK_ENTRIES
  const tree = renderAgents(el, frame, { agents: [base], now: frame.now, showDone: false, open: { id: base.id, talk: { entries }, runsOpen: ['t' + first] } }, actions)
  const all = nodes(tree)
  assert.equal(all.filter(n => n.props.key === 'tool-t1799').length, 1)
  assert.equal(all.filter(n => n.props.key === 'tool-t0').length, 0)
  assert.equal(all.filter(n => String(n.props.key).startsWith('tool-t')).length, TALK_ENTRIES)
  assert.ok(textOf(tree).includes(String(first)))
  assert.ok(all.length < 10_000)
})

test('diagnostic fallback keeps safe text, opens the original agent id, and offers back and close', () => {
  const opened: string[] = []
  const tree = renderAgentsFallback(el, frame, [{ ...base, description: '검토\u001b̅' }], '오류\u0000', { ...actions, open: id => { opened.push(id) }, close: () => {} }, true)
  const all = nodes(tree)
  assert.equal(all.some(n => n.type === 'Svg'), false)
  assert.ok(all.some(n => n.props.key === 'back'))
  assert.ok(all.some(n => n.props.key === 'close'))
  assert.ok(!/[\u0000\u001b̅]/u.test(textOf(tree)))
  const press = all.find(n => n.props.key === 'fallback-open-0')?.props.onPress
  assert.equal(typeof press, 'function')
  if (typeof press === 'function') press()
  assert.deepEqual(opened, [base.id])
})
