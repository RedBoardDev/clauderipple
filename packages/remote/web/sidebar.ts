import type { SessionSummary } from "../src/protocol.ts";
import { lang, t } from "./i18n.ts";

export function sidebarLabel(name: string): string {
  if (name === "sidebar:ungrouped") return lang() === "ko" ? "그룹 없음" : "No group";
  if (name === "sidebar:phone") return lang() === "ko" ? "휴대폰에서 시작" : "Started on phone";
  if (name === "sidebar:routines") return lang() === "ko" ? "예약 작업" : "Scheduled tasks";
  if (name === "sidebar:pinned") return lang() === "ko" ? "고정됨" : "Pinned";
  if (name === "sidebar:recent") return lang() === "ko" ? "최근" : "Recent";
  return name;
}
const RECENT_MS = 60 * 60_000;

/** Needs a look now: working, waiting, background work, unread, or talked to in the last hour. */
export function isRecent(s: SessionSummary, now: number): boolean {
  return sidebarState(s) !== "read" || now - s.updatedAt < RECENT_MS;
}

/**
 * The app's groups in the app's order, with a 최근 section on top that the app lacks: the
 * sessions that need a look now (isRecent), newest first. Those leave their group so nothing
 * is listed twice.
 */
export function sidebarSections(sessions: SessionSummary[], groups?: string[], now = Date.now()): { name: string; sessions: SessionSummary[] }[] {
  const recent = sessions.filter(s => isRecent(s, now)).sort((a, b) => b.updatedAt - a.updatedAt);
  const rest = sessions.filter(s => !isRecent(s, now));
  const groupOf = (s: SessionSummary) => s.group ?? (s.origin === "desktop" ? "sidebar:ungrouped" : "sidebar:phone");
  const names = [...new Set([...(groups ?? []), ...rest.map(groupOf)])];
  return [{ name: sidebarLabel("sidebar:recent"), sessions: recent }, ...names.map(name => ({ name: sidebarLabel(name), sessions: rest.filter(s => groupOf(s) === name)
    .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || b.updatedAt - a.updatedAt) }))].filter(g => g.sessions.length > 0);
}
/**
 * The app sidebar's rule (checked against live sessions 2026-10-12): unread outranks working,
 * and working is one state whether the main turn or only subagents run. Opening the phone never
 * changes Claude's read state. The transcript task count is not used here: tasks whose end was
 * never recorded linger in it, which made long-idle sessions blink.
 */
export function sidebarState(s: SessionSummary): string {
  if (s.pending > 0 || s.state === "waiting") return "waiting";
  if (s.state === "error") return "error";
  if (s.unread) return "unread";
  if (s.state === "running" || s.state === "starting" || s.background) return "running";
  return "read";
}

// ---- the phone's session list: grouped by status (or folder), newest change first --------------

/** The list's five buckets, in the order they stack from the top. */
export type SessionGroup = "input" | "failed" | "review" | "working" | "done";
export const GROUP_ORDER: readonly SessionGroup[] = ["input", "failed", "review", "working", "done"];

/**
 * The bucket a session belongs to. A permission request (open or waiting) or a Claude app turn that
 * stopped on a question outranks everything — both need the person's input; the last turn's error
 * outranks a lingering finished flag; a turn that finished and nobody has looked at yet (its
 * `attention`) is 검토 대기; running/starting/background is 작업 중; the rest is 완료.
 */
export function sessionGroup(s: SessionSummary): SessionGroup {
  if (s.pending > 0 || s.state === "waiting" || s.attention?.reason === "question") return "input";
  if (s.state === "error") return "failed";
  if (s.attention?.reason === "finished") return "review";
  if (s.state === "running" || s.state === "starting" || s.background) return "working";
  return "done";
}

export function groupLabel(group: SessionGroup): string {
  return t(`group.${group}` as Parameters<typeof t>[0]);
}

export type GroupMode = "status" | "folder";

/** Newest state change first: the host stamps `updatedAt` when a state changes, so this is that time. */
function byRecency(a: SessionSummary, b: SessionSummary): number {
  return b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
}

/** The last path segment, the way a folder is named in speech. `~` for the home folder. */
function folderLabel(p: string, home?: string): string {
  if (home && p === home) return "~";
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "/";
}

/** The folder's most recently changed session, for ordering folder sections. */
function folderRecency(sessions: SessionSummary[]): number {
  return sessions.reduce((max, s) => Math.max(max, s.updatedAt), 0);
}

/**
 * The list in the order the phone shows it. `status` (default) stacks the five buckets; `folder`
 * groups by working directory instead. Archived sessions are hidden unless `includeArchived`,
 * because archiving only sets a flag — the transcripts and files stay. Within a section, newest
 * state change first.
 */
export function groupSessions(sessions: SessionSummary[], mode: GroupMode = "status", opts: { includeArchived?: boolean; home?: string } = {}): { key: string; name: string; sessions: SessionSummary[] }[] {
  const list = opts.includeArchived ? sessions.slice() : sessions.filter(s => !s.archived);
  if (mode === "folder") {
    const byFolder = new Map<string, SessionSummary[]>();
    for (const s of list) { const bucket = byFolder.get(s.cwd); if (bucket) bucket.push(s); else byFolder.set(s.cwd, [s]); }
    return [...byFolder.entries()]
      .sort((a, b) => folderRecency(b[1]) - folderRecency(a[1]) || a[0].localeCompare(b[0]))
      .map(([cwd, group]) => ({ key: `folder:${cwd}`, name: folderLabel(cwd, opts.home), sessions: group.sort(byRecency) }));
  }
  return GROUP_ORDER
    .map(group => ({ key: `group:${group}`, name: groupLabel(group), sessions: list.filter(s => sessionGroup(s) === group).sort(byRecency) }))
    .filter(section => section.sessions.length > 0);
}
