// Operating modes in the session (docs/specs/2026-10-12-worker-tiers.md "Operating modes"): which
// mode is on, when it ends by itself, and the eager-delegation note (Base's while no mode is on).
// Pure; register.tsx wires them.

import type { Hot, LimitItem, Mode, Settings } from '../types'

/** The mode that is on, if the settings name one that exists. */
export function activeModeOf(s: Pick<Settings, 'modes' | 'activeMode'>): Mode | undefined {
  return s.activeMode ? s.modes.find(m => m.id === s.activeMode) : undefined
}

/** One turning-on of a mode: the same mode turned off and on again is a new one. */
export function modeKey(s: Pick<Settings, 'activeMode' | 'activeSince'>): string | null {
  return s.activeMode ? `${s.activeMode}@${s.activeSince ?? 0}` : null
}

/** What the main chat reads beside the prompt while an eager mode is on. */
export function modeNote(name: string): string {
  return `ClaudeRipple mode ${name}: delegate everything except judgment and final review to ripple:auto.`
}

/** What it reads while no mode is on and Base is eager. */
const BASE_NOTE = 'ClaudeRipple: delegate everything except judgment and final review to ripple:auto.'

/**
 * The eager note for this prompt: Base's while no mode is on, the active mode's otherwise. Sent on
 * the first prompt after that turned eager (a mode turning on, or Base made eager), and again on
 * the first after a compaction (which clears `noted`), never on the turns between. When the
 * effective delegation is not eager, nothing is said and `noted` becomes null, so making it eager
 * again later sends the note afresh.
 */
export function eagerNote(s: Pick<Settings, 'modes' | 'activeMode' | 'activeSince' | 'delegation'>, noted: string | null): { note?: string; noted: string | null } {
  const mode = activeModeOf(s)
  if ((mode?.delegation ?? s.delegation) !== 'eager') return { noted: null }
  const key = mode ? modeKey(s) : 'base'
  return noted === key ? { noted } : { note: mode ? modeNote(mode.name) : BASE_NOTE, noted: key }
}

/** Modes replace the base worker set, without changing fallback, allow-list or provider policy. */
export function routingSettings(s: Settings): Settings {
  const mode = activeModeOf(s)
  return mode ? { ...s, rules: { general: { mode: 'ladder', rungs: mode.rungs } }, domainRules: mode.domainRules } : s
}

/** The provider whose quota reset ends the mode: 'anthropic' is Claude, any other a ChatGPT provider. */
export function resetProvider(mode: Pick<Mode, 'until'>): string | undefined {
  return typeof mode.until === 'object' ? mode.until.reset : undefined
}

/** Same binding limit as the band: highest percent used, input order breaking ties. */
export function claudeWindow(limit: Hot | null): QuotaWindow[] {
  const at = limit?.resetsAt ? Date.parse(limit.resetsAt) : NaN
  return Number.isFinite(at) ? [{ at }] : []
}

/** One account's quota window: when it resets next, and how long it is when known. */
export type QuotaWindow = { at: number; windowMs?: number }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * Each signed-in, unpaused ChatGPT account's known windows, from GET
 * /api/chatgpt-accounts: `quota.rate_limits.{primary,secondary}` with `reset_at` (epoch seconds,
 * or ms) or `reset_after_seconds` from the snapshot's `at`, and `window_minutes`
 * (packages/router/src/providers/chatgpt/index.ts rateLimitsFromHeaders/rateLimitsFromUsage).
 * An account whose reset is unknown is left out.
 */
export function quotaWindows(body: unknown): QuotaWindow[] {
  const accounts = record(body).accounts
  if (!Array.isArray(accounts)) return []
  return accounts.flatMap(value => {
    const account = record(value)
    if (account.state === 'paused' || account.state === 'needs-login') return []
    const quota = record(account.quota)
    const limits = record(quota.rate_limits)
    return ['primary', 'secondary'].flatMap(key => {
      const window = record(limits[key])
      const resetAt = typeof window.reset_at === 'number' ? (window.reset_at > 1e12 ? window.reset_at : window.reset_at * 1000)
        : typeof window.reset_after_seconds === 'number' && typeof quota.at === 'number' ? quota.at + window.reset_after_seconds * 1000 : undefined
      if (resetAt === undefined || !Number.isFinite(resetAt)) return []
      const minutes = window.window_minutes
      return [{ at: resetAt, ...(typeof minutes === 'number' && minutes > 0 ? { windowMs: minutes * 60_000 } : {}) }]
    })
  })
}

/**
 * End at the first known reset after activation of the mode's chosen provider (`windows` are only
 * that provider's), not after every account resets. ChatGPT's fixed window length also identifies a
 * reset when a fresh snapshot has rolled forward. Claude windows are not extrapolated: the
 * five-hour window can start lazily after idle.
 */
export function modeOver(mode: Pick<Mode, 'until'>, since: number | undefined, now: number, windows: readonly QuotaWindow[] = []): boolean {
  if (typeof mode.until === 'number') return now >= mode.until
  if (!resetProvider(mode) || since === undefined || !windows.length) return false
  const passed = (at: number) => at > since && at <= now
  return windows.some(w => passed(w.at) || (w.windowMs !== undefined && passed(w.at - w.windowMs)))
}

/** The configured providers of ChatGPT type, from GET /api/status `providers` (name → {type}). */
export function chatgptProviders(status: unknown): string[] {
  const providers = record(status).providers
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return []
  return Object.entries(providers as Record<string, unknown>)
    .filter(([, value]) => record(value).type === 'chatgpt')
    .map(([name]) => name)
}

/**
 * Every signed-in ChatGPT account's known windows as the limits row reads them, from GET
 * /api/chatgpt-accounts (`quota.rate_limits.{primary,secondary}` with `reset_at` in epoch
 * seconds or ms, or `reset_after_seconds` from the snapshot's `at`, and `window_minutes`;
 * the same shape `quotaWindows` reads). Paused and needs-login accounts are left out (and take
 * no number), and so is an account with no snapshot. `account` numbers the accounts kept, in
 * answer order. A snapshot is not aged out: the router takes it from the account's own replies,
 * so an account idle for an hour holds an hour-old figure that is still right (measured
 * 2026-10-15: 30 minutes old between uses). Only a window whose reset has passed is dropped,
 * since its figure no longer stands.
 */
export function gptLimitsFrom(body: unknown, provider: string, now: number): LimitItem[] {
  const accounts = record(body).accounts
  if (!Array.isArray(accounts)) return []
  const kept = accounts.map(record).filter(account => account.state !== 'paused' && account.state !== 'needs-login' && account.paused !== true)
  const out: LimitItem[] = []
  kept.forEach((account, index) => {
    const quota = record(account.quota)
    const at = quota.at
    if (typeof at !== 'number') return
    const limits = record(quota.rate_limits)
    for (const key of ['primary', 'secondary']) {
      const window = record(limits[key])
      const used = window.used_percent
      if (typeof used !== 'number' || !Number.isFinite(used)) continue
      const minutes = window.window_minutes
      const resetAt = typeof window.reset_at === 'number' ? (window.reset_at > 1e12 ? window.reset_at : window.reset_at * 1000)
        : typeof window.reset_after_seconds === 'number' && typeof at === 'number' ? at + window.reset_after_seconds * 1000 : NaN
      if (Number.isFinite(resetAt) && resetAt <= now) continue
      const kind = minutes === 300 ? 'five_hour' : minutes === 10080 ? 'seven_day' : 'window'
      out.push({
        provider,
        type: 'chatgpt',
        title: 'GPT',
        account: index,
        kind,
        label: '',
        ...(typeof minutes === 'number' && minutes > 0 ? { windowMinutes: minutes } : {}),
        percent: Math.round(used * 10) / 10,
        ...(Number.isFinite(resetAt) ? { resetsAt: new Date(resetAt).toISOString() } : {}),
      })
    }
  })
  return out
}
