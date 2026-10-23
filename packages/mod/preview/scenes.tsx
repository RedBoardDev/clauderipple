// The scenes the preview draws (render.mjs copies this in as the mod's only test). Each one is a
// renderer with fixed data, drawn on the desktop surface and printed as `@@SCENE {...}`.

import { test } from 'claude-code/testing'
import type { RenderElement, RenderPropsOf } from 'claude-code'

import type { AgentRec, LimitItem, Settings, Skin } from '../types'
import { normalizeSettings } from '../hooks/settings'
import { renderAgents, talkOf } from '../hooks/ui/agents'
import { renderAlert } from '../hooks/ui/alerts'
import { renderBand } from '../hooks/ui/band'
import { renderLog } from '../hooks/ui/log'
import { renderSettings } from '../hooks/ui/settings'
import { renderSetup } from '../hooks/ui/setup'
import type { AgentEntry, AlertView, DashboardView, Frame, SettingsView } from '../hooks/ui/view'
import type { Els } from '../hooks/ui/parts'

const LANG = 'ko'
const SKIN = 'deep'
const ONLY: string[] = []
/** The composer's width in a wide window, 768 px, in the desktop's cells. */
const WIDTH = 94
const NOW = Date.parse('2026-10-12T13:20:00')
const noop = new Proxy({}, { get: () => () => undefined }) as never

const DASH: DashboardView = {
  effort: { level: 'high', mode: 'auto', why: '여러 파일에 걸친 리팩터', by: 'jev' },
  model: 'Opus 5.5',
  context: { percent: 38, tokens: 76_000, window: 200_000 },
  cache: { expiresAt: NOW + 41 * 60_000, ttlMs: 3_600_000 },
  warm: { on: false, pings: 0, cost: 0 },
  limit: null,
  route: { model: 'gpt-6.1-sol', provider: 'chatgpt', ok: true, resent: false, status: '200', effort: 'high', cachePct: 96, seconds: 2.1 },
  notice: null,
  auto: true,
  handoff: 'off',
  agents: { live: 0, total: 0 },
  compactions: 0,
  logOpen: false,
  agentsOpen: false,
  effortMenu: false,
  swampAt: 50,
  hide: [],
  extras: ['context'],
  isWorking: false,
}

const SETTINGS: Settings = normalizeSettings({ judges: [{ kind: 'jev' }, { kind: 'model', model: 'deepseek-v4.1-flash' }, { kind: 'haiku' }], modes: [{ id: 'm1', name: 'GPT 우선' }, { id: 'm2', name: '절약' }], activeMode: 'm1' } as never)

/** Every plan window the limits row gauges: Claude's 5-hour, weekly and Fable, then two GPT accounts. */
const LIMITS: LimitItem[] = [
  { provider: 'claude', type: 'anthropic', title: 'Claude', account: 0, kind: 'five_hour', label: '', percent: 1 },
  { provider: 'claude', type: 'anthropic', title: 'Claude', account: 0, kind: 'seven_day', label: '', percent: 88, resetsAt: '2026-10-12T18:20:00' },
  { provider: 'claude', type: 'anthropic', title: 'Claude', account: 0, kind: 'scoped', label: 'Fable', percent: 2, resetsAt: '2026-10-15T10:59:59+00:00' },
  { provider: 'chatgpt', type: 'chatgpt', title: 'GPT', account: 0, kind: 'seven_day', label: '', windowMinutes: 10080, percent: 23, resetsAt: '2026-10-19T13:20:00' },
  { provider: 'chatgpt', type: 'chatgpt', title: 'GPT', account: 1, kind: 'five_hour', label: '', windowMinutes: 300, percent: 64 },
  { provider: 'chatgpt', type: 'chatgpt', title: 'GPT', account: 1, kind: 'seven_day', label: '', windowMinutes: 10080, percent: 97, resetsAt: '2026-10-19T13:20:00' },
]

/** Every readable provider at once, for the general limits row: Claude, GPT, Gemini and OpenCode Go. */
const LIMITS_ALL: LimitItem[] = [
  { provider: 'anthropic', type: 'anthropic', title: 'Claude', account: 0, kind: 'five_hour', label: '', percent: 1 },
  { provider: 'anthropic', type: 'anthropic', title: 'Claude', account: 0, kind: 'seven_day', label: '', percent: 88, resetsAt: '2026-10-12T18:20:00' },
  { provider: 'anthropic', type: 'anthropic', title: 'Claude', account: 0, kind: 'scoped', label: 'Fable', percent: 2, resetsAt: '2026-10-15T10:59:59+00:00' },
  { provider: 'chatgpt', type: 'chatgpt', title: 'GPT', account: 0, kind: 'seven_day', label: '', windowMinutes: 10080, percent: 23, resetsAt: '2026-10-19T13:20:00' },
  { provider: 'google-gemini', type: 'google', title: 'Gemini', account: 0, kind: 'five_hour', label: '', windowMinutes: 300, percent: 0 },
  { provider: 'google-gemini', type: 'google', title: 'Gemini', account: 0, kind: 'seven_day', label: '', windowMinutes: 10080, percent: 2, resetsAt: '2026-10-19T13:20:00' },
  { provider: 'google-gemini', type: 'google', title: 'Gemini', account: 0, kind: 'scoped', label: '3P', windowMinutes: 10080, percent: 10, resetsAt: '2026-10-19T13:20:00' },
  { provider: 'google-gemini', type: 'google', title: 'Gemini', account: 0, kind: 'scoped', label: '3P', windowMinutes: 300, percent: 0 },
  { provider: 'opencode-go', type: 'opencode-go', title: 'Go', account: 0, kind: 'five_hour', label: '', windowMinutes: 300, percent: 3, resetsAt: '2026-10-15T05:39:48Z' },
  { provider: 'opencode-go', type: 'opencode-go', title: 'Go', account: 0, kind: 'seven_day', label: '', windowMinutes: 10080, percent: 52, resetsAt: '2026-10-19T00:00:00Z' },
  { provider: 'opencode-go', type: 'opencode-go', title: 'Go', account: 0, kind: 'window', label: '', windowMinutes: 43200, percent: 92, resetsAt: '2026-10-18T05:43:30Z' },
]
const SETTINGS_VIEW: SettingsView = { settings: SETTINGS, models: [{ value: 'deepseek-v4.1-flash', label: 'deepseek-v4.1-flash · opencode', provider: 'opencode' }, { value: 'gpt-6.1-sol', label: 'gpt-6.1-sol · chatgpt', provider: 'chatgpt' }], jev: { source: 'env', test: { state: 'idle' } } }

/** The Agents pane's width in a wide window, ~560 px, in cells; and a narrow one, ~360 px. */
const PANE = 68
const PANE_NARROW = 44

/** Two running (a Sol·high GPT worker, a DeepSeek one in a long tool), three finished (an Explore on the session model, a failed Astra, a Sonnet). */
const AGENTS: AgentRec[] = [
  {
    id: 'g1', description: 'Sol·high · 요청 로그 렌더러를 새 키트로 옮기기', type: 'gpt-6-1-sol', model: 'gpt-6.1-sol@high', provider: 'chatgpt',
    pick: { domain: 'frontend', level: 'standard', effort: 'high', sure: 0.82, why: '설계가 정해진 여러 파일 수정', target: { agent: 'gpt-6-1-sol' }, by: 'jev', rung: 'standard', ms: 640 },
    state: 'running', now: 'Edit packages/mod/hooks/ui/log.tsx', toolSince: NOW - 6000, startedAt: NOW - 192_000, cost: 0,
    effort: 'high', answeredBy: 'gpt-6.1-sol', usage: { input: 3200, cached: 182_000, cacheWrite: 9400, output: 14_200 }, tools: 23,
  },
  {
    id: 'd1', description: 'deepseek-v4.1-flash·low · 테스트 실패 원인 조사', type: 'deepseek-v4-1-flash', model: 'deepseek-v4.1-flash@low', provider: 'deepseek',
    pick: { domain: 'test', level: 'light', effort: 'low', why: '로그 한 군데만 보면 되는 조사', target: { agent: 'deepseek-v4-1-flash' }, by: 'marker', rung: 'light', ms: 0 },
    state: 'waiting', now: 'Bash npm test -- --runInBand', toolSince: NOW - 41_000, startedAt: NOW - 95_000, cost: 0,
    effort: 'low', answeredBy: 'deepseek-v4.1-flash', usage: { input: 900, cached: 41_000, cacheWrite: 2100, output: 3100 }, tools: 9,
  },
  {
    id: 'e1', description: 'Opus5.5 · 라우터 설정 파일 위치 찾기', type: 'Explore', model: 'claude-opus-5-5', provider: 'anthropic',
    state: 'done', startedAt: NOW - 700_000, endedAt: NOW - 640_000, cost: 0,
    effort: 'medium', answeredBy: 'claude-opus-5-5', usage: { input: 1200, cached: 64_000, cacheWrite: 18_000, output: 2600 }, tools: 14,
  },
  {
    id: 'a1', description: 'Astra·xhigh · 설정 마이그레이션 스크립트 작성', type: 'gpt-6-astra', model: 'gpt-6-astra@xhigh', provider: 'chatgpt',
    pick: { domain: 'backend', level: 'deep', effort: 'xhigh', sure: 0.7, why: '데이터 이전이라 실수 비용이 큼', target: { agent: 'gpt-6-astra' }, by: 'haiku', rung: 'hard', ms: 900, fallbackReason: 'gpt-6-1-sol 한도 소진' },
    state: 'failed', startedAt: NOW - 1_400_000, endedAt: NOW - 1_310_000, cost: 0,
    effort: 'xhigh', answeredBy: 'gpt-6-astra', usage: { input: 2100, cached: 12_000, cacheWrite: 30_000, output: 900 }, tools: 4,
  },
  {
    id: 's1', description: 'Sonnet5.5 · 변경 문서 요약', type: 'general-purpose', model: 'claude-sonnet-5-5', provider: 'anthropic',
    pick: { domain: 'docs', level: 'light', effort: 'medium', why: '짧은 요약', target: { agent: 'general-purpose', model: 'claude-sonnet-5-5' }, by: 'session', ms: 0 },
    state: 'done', startedAt: NOW - 2_000_000, endedAt: NOW - 1_950_000, cost: 0,
    effort: 'medium', answeredBy: 'claude-sonnet-5-5', usage: { input: 400, cached: 22_000, cacheWrite: 3000, output: 1200 }, tools: 2,
  },
]

/**
 * As the owner's pane showed them at ~260 px (2026-10-20): a hosted DeepSeek worker picked on the
 * session's rung, its id with a vendor path; a finished Explore; the failed Astra.
 */
const HOSTED: AgentRec = {
  id: 'h1', description: 'deepseek-v4.1-flash-1017 · 안드로이드 core 파서 테스트 실패 원인 찾아 고치기', type: 'deepseek-ai-deepseek-v4-1-flash-1017', model: 'deepseek-ai/deepseek-v4.1-flash-1017@medium', provider: 'deepseek',
  pick: { domain: 'general', level: 'standard', effort: 'medium', why: '메인 대화가 정한 등급: standard', target: { agent: 'deepseek-ai-deepseek-v4-1-flash-1017' }, by: 'session', ms: 0 },
  state: 'running', now: 'Bash cd /Users/pbj/Documents/tabripple/android && ./gradlew :core:test -q', toolSince: NOW - 7000, startedAt: NOW - 1_287_000, cost: 0,
  effort: 'medium', answeredBy: 'deepseek-ai/deepseek-v4.1-flash-1017', usage: { input: 2100, cached: 410_000, cacheWrite: 12_000, output: 18_400 }, tools: 81,
}
const CARDS: AgentRec[] = [HOSTED, AGENTS[2]!, AGENTS[3]!]
/** The hosted worker at 9분 59초, and a second on at 10분 00초: the card must not move. */
const at = (ms: number): AgentRec[] => [{ ...HOSTED, startedAt: NOW - ms }]

/** One running agent and eight finished: the list shows the latest four and "more". */
const MANY: AgentRec[] = [AGENTS[0]!, ...Array.from({ length: 8 }, (_, i): AgentRec => ({ ...AGENTS[i % 2 ? 2 : 4]!, id: 'm' + i, description: ['문서 링크 점검', '타입 오류 정리', 'i18n 키 대조', '빌드 로그 요약', '테스트 이름 정리', '캐시 적중률 확인', '라우터 로그 검색', '설정 스키마 비교'][i]!, endedAt: NOW - 60_000 * (i + 1), startedAt: NOW - 60_000 * (i + 2) }))]

/** The Sol worker's conversation so far: its task, its words, its tools, one still running. */
const TALK: AgentEntry[] = [
  { kind: 'prompt', text: '요청 로그 렌더러(`hooks/ui/log.tsx`)를 새 키트로 옮겨 주세요.\n\n- 내용은 그대로 두고 그리는 방식만 바꿉니다\n- 터미널 표면은 손대지 않습니다\n- `claude plugin test packages/mod`로 확인합니다' },
  { kind: 'text', text: '먼저 지금 렌더러와 키트의 **capsule**, `lift()` 쓰임새를 읽겠습니다.' },
  { kind: 'tool', id: 't1', tool: 'Read', detail: 'packages/mod/hooks/ui/log.tsx', state: 'ok' },
  { kind: 'tool', id: 't2', tool: 'Read', detail: 'packages/mod/hooks/ui/kit.tsx', state: 'ok' },
  { kind: 'tool', id: 't3', tool: 'Grep', detail: 'renderLog', state: 'ok' },
  { kind: 'text', text: '로그 항목은 한 줄 머리와 숫자 줄로 나뉩니다. 머리는 그대로 두고 숫자 줄만 타일 안으로 옮기겠습니다.' },
  { kind: 'tool', id: 't4', tool: 'Edit', detail: 'packages/mod/hooks/ui/log.tsx', state: 'ok' },
  { kind: 'tool', id: 't5', tool: 'Bash', detail: 'claude plugin test packages/mod', state: 'error' },
  { kind: 'text', text: '테스트 하나가 `dimColor`를 기대해서 실패했습니다. 캡슐 위 글자는 명시 색을 쓰도록 테스트를 고칩니다.' },
  { kind: 'tool', id: 't6', tool: 'Edit', detail: 'packages/mod/hooks/ui/log.tsx', state: 'running' },
]

/** The Explore agent's finished conversation, its answer last. */
const TALK_DONE: AgentEntry[] = [
  { kind: 'prompt', text: '라우터 설정 파일이 어디서 읽히는지 찾아 주세요.' },
  { kind: 'tool', id: 'u1', tool: 'Grep', detail: 'config.json', state: 'ok' },
  { kind: 'tool', id: 'u2', tool: 'Read', detail: 'packages/router/src/config.ts', state: 'ok' },
  { kind: 'text', text: '설정은 `packages/router/src/config.ts`의 `loadConfig`가 읽습니다.\n\n- 경로: `~/.clauderipple/config.json`\n- 환경변수 `CLAUDERIPPLE_HOME`이 있으면 그 아래를 봅니다' },
]

/**
 * A worker's run as the owner saw it (2026-10-20): eight gradle and grep commands, each behind a
 * `cd` into the project, one failing, then an edit; a word, then two more commands, the last running.
 * Read through talkOf, so the commands lose their `cd` and the paths go short as in the app.
 */
const GRADLE = 'cd /Users/pbj/Documents/tabripple/android && '
const PARSER = '/Users/pbj/Documents/tabripple/android/core/src/main/kotlin/com/tabripple/core/TabParser.kt'
const bash = (id: string, command: string, text?: string, isError?: boolean) => ({ tool_use_id: id, tool: 'Bash', input: { command }, ...(text !== undefined ? { text } : {}), ...(isError ? { isError } : {}) })
const TALK_TOOLS: AgentEntry[] = talkOf([
  { role: 'user', text: 'tabripple 안드로이드 core 모듈의 파서 테스트가 깨진 원인을 찾아 고쳐 주세요. `./gradlew :core:test`로 확인합니다.', toolUses: [] },
  { role: 'assistant', text: '먼저 core 모듈 테스트를 돌려 어디서 깨지는지 보겠습니다.', toolUses: [
    bash('r1', GRADLE + './gradlew :core:test -q 2>&1 | grep -vE "^(w:|warning:)" | tail -60', 'ok'),
    bash('r2', GRADLE + './gradlew :core:test --tests "*TabParserTest*" -q 2>&1 | tail -80', 'ok'),
    bash('r3', GRADLE + 'grep -rn "parseMeasure" core/src/main/kotlin | head -20', 'ok'),
    bash('r4', GRADLE + './gradlew :core:compileKotlin -q 2>&1 | grep -E "^e:" | head -30', 'e: unresolved reference', true),
    bash('r5', 'cd /Users/pbj/Documents/tabripple/android; git diff --stat HEAD~3 -- core/', 'ok'),
    bash('r6', GRADLE + 'sed -n 120,180p core/src/main/kotlin/com/tabripple/core/TabParser.kt', 'ok'),
    bash('r7', GRADLE + './gradlew :core:test --tests "*MeasureTest*" -q 2>&1 | tail -40', 'ok'),
    bash('r8', GRADLE + 'git log --oneline -5 -- core/src/main/kotlin/com/tabripple/core/TabParser.kt', 'ok'),
    { tool_use_id: 'r9', tool: 'Edit', input: { file_path: PARSER, old_string: 'a', new_string: 'b' }, text: 'ok' },
  ] },
  { role: 'assistant', text: '마디 경계의 빈 줄을 건너뛰지 않아 인덱스가 하나씩 밀렸습니다. 고친 뒤 전체 테스트를 다시 돌립니다.', toolUses: [
    bash('s1', GRADLE + './gradlew :core:compileKotlin -q 2>&1 | grep -E "^e:" | head -30', 'ok'),
    bash('s2', GRADLE + './gradlew :core:test -q 2>&1 | grep -vE "^(w:|warning:)" | tail -60'),
  ] },
], { cwd: '/Users/pbj/Documents/tabripple', home: '/Users/pbj' })

const AGENT_ACTIONS = { toggleDone: () => undefined, open: () => undefined, back: () => undefined, earlier: () => undefined, toggleRun: () => undefined }

/** The AbovePrompt site as register.tsx composes it on the desktop: the band, its × inside. */
function site(el: Els, frame: Frame, view: DashboardView): RenderElement {
  return renderBand(el, frame, view, noop) as RenderElement
}

type Scene = { name: string; columns?: number; skin?: Skin; draw: (el: Els, frame: Frame) => unknown }

const alert = (a: AlertView) => (el: Els, frame: Frame) => renderAlert(el, frame, a, noop)

const SCENES: Scene[] = [
  { name: 'band', draw: (el, f) => site(el, f, DASH) },
  { name: 'band-deciding', draw: (el, f) => site(el, f, { ...DASH, effort: { level: null, mode: 'deciding', since: NOW - 500 } }) },
  { name: 'band-working-handoff', draw: (el, f) => site(el, f, { ...DASH, isWorking: true, handoff: 'advised', warm: { on: true, pings: 2, cost: 9000 }, agents: { live: 2, total: 3 }, context: { percent: 64, tokens: 128_000, window: 200_000 }, mode: 'GPT 우선' }) },
  { name: 'band-compacted', draw: (el, f) => site(el, f, { ...DASH, agents: { live: 1, total: 1 }, compactions: 3 }) },
  { name: 'band-drowsy-off', draw: (el, f) => site(el, f, { ...DASH, auto: false, effort: { level: 'medium', mode: 'off' }, cache: { expiresAt: NOW + 60_000, ttlMs: 3_600_000 }, limit: { kind: 'five_hour', percent: 86, resetsAt: '2026-10-12T15:40:00', save: false }, extras: ['context', 'limits'] }) },
  { name: 'band-warm-here', draw: (el, f) => site(el, f, { ...DASH, warm: { on: false, pings: 0, cost: 0, here: true } }) },
  { name: 'band-asleep', draw: (el, f) => site(el, f, { ...DASH, cache: { expiresAt: NOW - 1, ttlMs: 3_600_000 } }) },
  { name: 'band-menu', draw: (el, f) => site(el, f, { ...DASH, effortMenu: true, effort: { level: 'xhigh', mode: 'manual' } }) },
  { name: 'band-narrow', columns: 70, draw: (el, f) => site(el, f, DASH) },
  { name: 'band-700-busy', columns: 79, draw: (el, f) => site(el, f, { ...DASH, effort: { level: 'xhigh', mode: 'manual' }, handoff: 'advised', agents: { live: 2, total: 3 }, warm: { on: true, pings: 3, cost: 0 } }) },
  // The band's two real widths, at its new maximum (2026-10-14): everything on — context, limits, a
  // limit, Handoff advised, a route and every control — must hold at both.
  { name: 'band-94-full', columns: 94, draw: (el, f) => site(el, f, { ...DASH, limit: { kind: 'seven_day', percent: 42, resetsAt: '2026-10-15T15:40:00', save: false }, handoff: 'advised', extras: ['context', 'limits'] }) },
  { name: 'band-100-full', columns: 100, draw: (el, f) => site(el, f, { ...DASH, limit: { kind: 'seven_day', percent: 42, resetsAt: '2026-10-15T15:40:00', save: false }, handoff: 'advised', extras: ['context', 'limits'] }) },
  // The limits row (2026-10-15): every plan window gauges the second row, and the first row's
  // limit fact steps aside for the route. Narrow, the GPT accounts go first, then Fable.
  { name: 'band-limits-94', columns: 94, draw: (el, f) => site(el, f, { ...DASH, limit: { kind: 'seven_day', percent: 88, resetsAt: '2026-10-12T18:20:00', save: false }, handoff: 'advised', extras: ['context', 'limits'], limits: LIMITS }) },
  { name: 'band-limits-100', columns: 100, draw: (el, f) => site(el, f, { ...DASH, limit: { kind: 'seven_day', percent: 88, resetsAt: '2026-10-12T18:20:00', save: false }, handoff: 'advised', extras: ['context', 'limits'], limits: LIMITS }) },
  { name: 'band-limits-70', columns: 70, draw: (el, f) => site(el, f, { ...DASH, limit: { kind: 'seven_day', percent: 88, resetsAt: '2026-10-12T18:20:00', save: false }, handoff: 'advised', extras: ['context', 'limits'], limits: LIMITS }) },
  // Every readable provider (2026-10-15): Claude, GPT, Gemini and OpenCode Go in one row, at the
  // two real widths. Narrow, the scoped windows go first, then a later provider's group.
  { name: 'band-limits-all-100', columns: 100, draw: (el, f) => site(el, f, { ...DASH, limit: { kind: 'seven_day', percent: 88, resetsAt: '2026-10-12T18:20:00', save: false }, handoff: 'advised', extras: ['context', 'limits'], limits: LIMITS_ALL }) },
  { name: 'band-limits-all-140', columns: 140, draw: (el, f) => site(el, f, { ...DASH, limit: { kind: 'seven_day', percent: 88, resetsAt: '2026-10-12T18:20:00', save: false }, handoff: 'advised', extras: ['context', 'limits'], limits: LIMITS_ALL }) },
  { name: 'band-limits-all-94', columns: 94, draw: (el, f) => site(el, f, { ...DASH, limit: { kind: 'seven_day', percent: 88, resetsAt: '2026-10-12T18:20:00', save: false }, handoff: 'advised', extras: ['context', 'limits'], limits: LIMITS_ALL }) },
  { name: 'settings', draw: (el, f) => renderSettings(el, f, SETTINGS_VIEW, noop) },
  { name: 'settings-off', draw: (el, f) => renderSettings(el, f, { ...SETTINGS_VIEW, settings: { ...SETTINGS, effortAuto: false, judges: [{ kind: 'haiku' }], keepWarm: true, activeMode: undefined } }, noop) },
  { name: 'settings-key', draw: (el, f) => renderSettings(el, f, { settings: { ...SETTINGS, jevSource: 'typesafe', judges: [{ kind: 'jev' }] }, jev: { source: null, test: { state: 'fail', message: 'key rejected (401)' } } }, noop) },
  { name: 'settings-router', columns: 70, draw: (el, f) => renderSettings(el, f, { ...SETTINGS_VIEW, settings: { ...SETTINGS, judges: [{ kind: 'model', model: 'deepseek-v4.1-flash' }, { kind: 'haiku' }], bias: 1 } }, noop) },
  { name: 'alert-cold', draw: alert({ kind: 'cold', tokens: 182_000, idleMinutes: 74 }) },
  { name: 'alert-kept', draw: alert({ kind: 'kept', pings: 2, tokens: 312_000, minutesLeft: 47 }) },
  { name: 'alert-swamp', draw: alert({ kind: 'swamp', percent: 63, tokens: 126_000 }) },
  { name: 'alert-hot', draw: alert({ kind: 'hot', limitKind: 'five_hour', percent: 86, resetsAt: '2026-10-12T15:40:00', save: false }) },
  { name: 'alert-judge', draw: alert({ kind: 'judgeDown', judge: 'jev', reason: 'key rejected (401)' }) },
  { name: 'alert-compact', draw: alert({ kind: 'compactNote', draft: '' }) },
  { name: 'alert-handoff', draw: alert({ kind: 'handoffChoice', handoffKind: 'quick', after: 'continue' }) },
  { name: 'alert-handing', draw: alert({ kind: 'result', stage: 'handingOff', handoffKind: 'full' }) },
  { name: 'alert-ready', draw: alert({ kind: 'result', stage: 'handoffReady', handoffKind: 'quick' }) },
  { name: 'alert-compacted', draw: alert({ kind: 'result', stage: 'compacted' }) },
  { name: 'setup', draw: (el, f) => renderSetup(el, f, { step: 1, draft: SETTINGS, jev: { source: null, test: { state: 'idle' } } }, noop) },
  { name: 'setup-2', draw: (el, f) => renderSetup(el, f, { step: 2, draft: SETTINGS, jev: { source: 'env', test: { state: 'idle' } } }, noop) },
  { name: 'setup-3', draw: (el, f) => renderSetup(el, f, { step: 3, draft: SETTINGS, jev: { source: 'env', test: { state: 'idle' } } }, noop) },
  { name: 'setup-done', draw: (el, f) => renderSetup(el, f, { step: 4, draft: SETTINGS, jev: { source: 'env', test: { state: 'idle' } } }, noop) },
  // The flat skin (look.ts), on the band, the quick settings, a card and a setup step.
  { name: 'flat-band', skin: 'flat', draw: (el, f) => site(el, f, { ...DASH, warm: { on: true, pings: 2, cost: 9000 }, agents: { live: 2, total: 3 }, extras: ['context', 'limits'], limit: { kind: 'five_hour', percent: 42, resetsAt: '2026-10-12T15:40:00', save: false } }) },
  { name: 'flat-band-menu', skin: 'flat', draw: (el, f) => site(el, f, { ...DASH, effortMenu: true, effort: { level: 'xhigh', mode: 'manual' } }) },
  { name: 'flat-settings', skin: 'flat', draw: (el, f) => renderSettings(el, f, SETTINGS_VIEW, noop) },
  { name: 'flat-settings-key', skin: 'flat', draw: (el, f) => renderSettings(el, f, { settings: { ...SETTINGS, jevSource: 'typesafe', judges: [{ kind: 'jev' }], effortAuto: false, keepWarm: true }, jev: { source: null, test: { state: 'fail', message: 'key rejected (401)' } } }, noop) },
  { name: 'flat-alert-swamp', skin: 'flat', draw: (el, f) => renderAlert(el, f, { kind: 'swamp', percent: 63, tokens: 126_000 }, noop) },
  { name: 'flat-alert-handoff', skin: 'flat', draw: (el, f) => renderAlert(el, f, { kind: 'handoffChoice', handoffKind: 'quick', after: 'continue' }, noop) },
  { name: 'flat-setup', skin: 'flat', draw: (el, f) => renderSetup(el, f, { step: 1, draft: SETTINGS, jev: { source: null, test: { state: 'idle' } } }, noop) },
  { name: 'agents', columns: 90, draw: (el, f) => renderAgents(el, f, { agents: [], now: NOW, showDone: false }, noop) },
  { name: 'agents-empty', columns: PANE, draw: (el, f) => renderAgents(el, f, { agents: [], now: NOW, showDone: false }, AGENT_ACTIONS) },
  { name: 'agents-live', columns: PANE, draw: (el, f) => renderAgents(el, f, { agents: AGENTS, now: NOW, showDone: false }, AGENT_ACTIONS) },
  { name: 'agents-live-narrow', columns: PANE_NARROW, draw: (el, f) => renderAgents(el, f, { agents: AGENTS, now: NOW, showDone: false }, AGENT_ACTIONS) },
  { name: 'agents-idle', columns: PANE, draw: (el, f) => renderAgents(el, f, { agents: AGENTS.slice(2), now: NOW, showDone: false }, AGENT_ACTIONS) },
  { name: 'agents-many', columns: PANE, draw: (el, f) => renderAgents(el, f, { agents: MANY, now: NOW, showDone: false }, AGENT_ACTIONS) },
  { name: 'agents-talk', columns: PANE, draw: (el, f) => renderAgents(el, f, { agents: AGENTS, now: NOW, showDone: false, open: { id: 'g1', talk: { entries: TALK }, earlier: 0 } }, AGENT_ACTIONS) },
  { name: 'agents-talk-narrow', columns: PANE_NARROW, draw: (el, f) => renderAgents(el, f, { agents: AGENTS, now: NOW, showDone: false, open: { id: 'g1', talk: { entries: TALK }, earlier: 0 } }, AGENT_ACTIONS) },
  { name: 'agents-talk-done', columns: PANE, draw: (el, f) => renderAgents(el, f, { agents: AGENTS, now: NOW, showDone: false, open: { id: 'e1', talk: { entries: TALK_DONE }, earlier: 0 } }, AGENT_ACTIONS) },
  { name: 'agents-talk-deny', columns: PANE, draw: (el, f) => renderAgents(el, f, { agents: AGENTS, now: NOW, showDone: false, open: { id: 'g1', talk: { deny: 'agent g1 has no saved transcript' }, earlier: 0 } }, AGENT_ACTIONS) },
  // Cards that hold still and read at narrow widths (2026-10-20): ~260 px and ~360 px, running and
  // done; and one card a second apart across 9분 59초 → 10분 00초.
  { name: 'cards-260', columns: 33, draw: (el, f) => renderAgents(el, f, { agents: CARDS, now: NOW, showDone: false }, AGENT_ACTIONS) },
  { name: 'cards-360', columns: PANE_NARROW, draw: (el, f) => renderAgents(el, f, { agents: CARDS, now: NOW, showDone: false }, AGENT_ACTIONS) },
  { name: 'cards-560', columns: PANE, draw: (el, f) => renderAgents(el, f, { agents: CARDS, now: NOW, showDone: false }, AGENT_ACTIONS) },
  { name: 'cards-tick-959', columns: PANE_NARROW, draw: (el, f) => renderAgents(el, f, { agents: at(599_000), now: NOW, showDone: false }, AGENT_ACTIONS) },
  { name: 'cards-tick-1000', columns: PANE_NARROW, draw: (el, f) => renderAgents(el, f, { agents: at(600_000), now: NOW, showDone: false }, AGENT_ACTIONS) },
  { name: 'cards-tick-959-wide', columns: 56, draw: (el, f) => renderAgents(el, f, { agents: at(599_000), now: NOW, showDone: false }, AGENT_ACTIONS) },
  { name: 'cards-tick-1000-wide', columns: 56, draw: (el, f) => renderAgents(el, f, { agents: at(600_000), now: NOW, showDone: false }, AGENT_ACTIONS) },
  // A worker's run of commands, folded to its head and unfolded call by call (2026-10-20).
  { name: 'agents-tools', columns: PANE, draw: (el, f) => renderAgents(el, f, { agents: AGENTS, now: NOW, showDone: false, open: { id: 'g1', talk: { entries: TALK_TOOLS }, earlier: 0 } }, AGENT_ACTIONS) },
  { name: 'agents-tools-open', columns: PANE, draw: (el, f) => renderAgents(el, f, { agents: AGENTS, now: NOW, showDone: false, open: { id: 'g1', talk: { entries: TALK_TOOLS }, earlier: 0, runsOpen: ['r1', 's1'] } }, AGENT_ACTIONS) },
  { name: 'agents-tools-narrow', columns: PANE_NARROW, draw: (el, f) => renderAgents(el, f, { agents: AGENTS, now: NOW, showDone: false, open: { id: 'g1', talk: { entries: TALK_TOOLS }, earlier: 0 } }, AGENT_ACTIONS) },
  { name: 'agents-tools-open-narrow', columns: PANE_NARROW, draw: (el, f) => renderAgents(el, f, { agents: AGENTS, now: NOW, showDone: false, open: { id: 'g1', talk: { entries: TALK_TOOLS }, earlier: 0, runsOpen: ['r1', 's1'] } }, AGENT_ACTIONS) },
  { name: 'flat-agents-live', columns: PANE, skin: 'flat', draw: (el, f) => renderAgents(el, f, { agents: AGENTS, now: NOW, showDone: false }, AGENT_ACTIONS) },
  { name: 'flat-agents-talk', columns: PANE, skin: 'flat', draw: (el, f) => renderAgents(el, f, { agents: AGENTS, now: NOW, showDone: false, open: { id: 'g1', talk: { entries: TALK }, earlier: 0 } }, AGENT_ACTIONS) },
  { name: 'log', columns: 90, draw: (el, f) => renderLog(el, f, { rows: [], mineOnly: true }, noop) },
]

test('scenes', async ($, on) => {
  const shown = SCENES.filter(scene => !ONLY.length || ONLY.includes(scene.name))
  for (const scene of shown) {
    const columns = scene.columns ?? WIDTH
    on('ui.render', { component: 'Pane', requestId: scene.name }, ($, e) => {
      const frame: Frame = { surface: 'desktop', columns, maxRows: 12, now: NOW, appearance: 'auto', skin: scene.skin ?? SKIN, lang: LANG }
      const tree = scene.draw($.ui.resolve(e), frame)
      console.log('@@SCENE ' + JSON.stringify({ name: scene.name, columns, tree }))
      return tree as RenderElement
    })
  }
  for (const scene of shown) {
    const columns = scene.columns ?? WIDTH
    const props = { title: 'ui', isFocused: true, bodyColumns: columns, placement: 'inline', scroll: { offset: 0, bodyRows: 30 }, view: {} } as RenderPropsOf['Pane']
    const ui = await $.ui.mount({ plugin: 'test', surface: 'desktop', component: 'Pane', requestId: scene.name, props, viewport: { columns, rows: 40 } })
    await ui.unmount()
  }
})
