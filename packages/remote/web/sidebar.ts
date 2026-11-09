import type { SessionSummary } from "../src/protocol.ts";
import { lang, t } from "./i18n.ts";

/** Use the same folder fallback as the conversation header, also for blank metadata. */
export function sessionTitle(s: Pick<SessionSummary, "title" | "cwd">): string {
  return s.title.trim() || folderName(s.cwd);
}

/** The host's own star group: sessions pinned in the Desktop app's sidebar. */
export const PINNED_GROUP = "sidebar:pinned";
/** The web list's own top group; not a host group name. */
export const RECENT_GROUP = "sidebar:recent";
/** Summaries as they come; read-only so a search or a fold never sorts the caller's array in place. */
export type SessionList = readonly SessionSummary[];

/** Pinned: the Desktop app's star (the host reports its `sidebar:pinned` group) or a pin on this device. */
export function isPinned(s: Pick<SessionSummary, "id" | "group">, pins: readonly string[] = []): boolean {
  return s.group === PINNED_GROUP || pins.includes(s.id);
}

/** A section's stable handle: what folding remembers across launches (a host group name or a bucket). */
export interface ListSection { key: string; name: string; sessions: SessionSummary[]; folded: boolean }

export function sidebarLabel(name: string): string {
  if (name === "sidebar:ungrouped") return lang() === "ko" ? "그룹 없음" : "No group";
  if (name === "sidebar:phone") return lang() === "ko" ? "휴대폰에서 시작" : "Started on phone";
  if (name === "sidebar:routines") return lang() === "ko" ? "예약 작업" : "Scheduled tasks";
  if (name === PINNED_GROUP) return lang() === "ko" ? "고정됨" : "Pinned";
  if (name === RECENT_GROUP) return lang() === "ko" ? "최근" : "Recent";
  return name;
}
const RECENT_MS = 60 * 60_000;

/** Needs a look now: working, waiting, background work, unread, or talked to in the last hour. */
export function isRecent(s: SessionSummary, now: number): boolean {
  return sidebarState(s) !== "read" || now - s.updatedAt < RECENT_MS;
}

/**
 * The sidebar's groups in the sidebar's order: pinned first (the Desktop app's stars and this
 * device's pins), then a 최근 section the app lacks — the sessions that need a look now (isRecent),
 * newest first — then the host's groups. A session is listed once.
 */
export function sidebarSections(sessions: SessionList, groups?: string[], now = Date.now(), opts: { pins?: readonly string[]; folded?: readonly string[] } = {}): ListSection[] {
  const folded = opts.folded ?? [];
  const live = sessions.filter(s => !s.archived);
  const pinned = live.filter(s => isPinned(s, opts.pins)).sort((a, b) => b.updatedAt - a.updatedAt);
  const unpinned = live.filter(s => !isPinned(s, opts.pins));
  const recent = unpinned.filter(s => isRecent(s, now)).sort((a, b) => b.updatedAt - a.updatedAt);
  const rest = unpinned.filter(s => !isRecent(s, now));
  const groupOf = (s: SessionSummary) => s.group ?? (s.origin === "desktop" ? "sidebar:ungrouped" : "sidebar:phone");
  const names = [...new Set([...(groups ?? []), ...rest.map(groupOf)])].filter(name => name !== PINNED_GROUP);
  const section = (key: string, list: SessionSummary[]): ListSection => ({ key, name: sidebarLabel(key), sessions: list, folded: folded.includes(key) });
  return [
    ...(pinned.length ? [section(PINNED_GROUP, pinned)] : []),
    section(RECENT_GROUP, recent),
    ...names.map(name => section(name, rest.filter(s => groupOf(s) === name)
      .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || b.updatedAt - a.updatedAt))),
  ].filter(g => g.sessions.length > 0);
}

/** One glyph rule for the home list, conversation switcher and web sidebar. */
export function sidebarState(s: SessionSummary): string {
  switch (sessionGroup(s)) {
    case "input": return "waiting";
    case "failed": return "error";
    case "review": return "unread";
    case "working": return s.state === "running" || s.state === "starting" ? "running" : "background";
    case "done": return "read";
  }
}

// ---- the phone's session list: grouped by status (or folder), newest change first --------------

/** The list's five buckets, in the order they stack from the top. */
export type SessionGroup = "input" | "failed" | "review" | "working" | "done";
export const GROUP_ORDER: readonly SessionGroup[] = ["input", "failed", "review", "working", "done"];

/**
 * Classify only signals the host actually supplies. Desktop's local sidebar gives live approval
 * and active work precedence over unread completion (ion-dist shared-11 xC → shared-26 Kj,
 * checked 2026-10-25). An old wrap_up cannot block a new main turn. Background work alone does
 * not answer a blocked question. `review` here means unread output, NOT Desktop's PR-ready
 * bucket: PR/merge and completed-ack metadata are not part of this protocol.
 * A transcript task count is not liveness evidence; only `background` is.
 */
export function sessionGroup(s: SessionSummary): SessionGroup {
  if (s.pending > 0 || s.state === "waiting") return "input";
  if (s.state === "error") return "failed";
  if (s.state === "running" || s.state === "starting") return "working";
  if (s.attention?.reason === "question") return "input";
  if (s.background) return "working";
  if (s.attention?.reason === "finished" || s.unread) return "review";
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

/** One separator for both platforms: a Windows host sends backslashes, a Linux/macOS host slashes. */
const pathForm = (value: string): string => value.replace(/\\/g, "/").replace(/\/+$/, "");
/** Drive letters are case-insensitive on Windows; a POSIX path keeps its case. */
const pathFold = (value: string): string => /^[A-Za-z]:/.test(pathForm(value)) ? pathForm(value).toLowerCase() : pathForm(value);

/** The last path segment, the way a folder is named in speech. `~` for the home folder. */
export function folderName(p: string, home?: string): string {
  if (home && pathFold(home) && pathFold(p) === pathFold(home)) return "~";
  const parts = pathForm(p).split("/").filter(Boolean);
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
 *
 * Passing `pins` puts the pinned sessions in a 고정됨 section of their own, first: the person's own
 * pins on this device (ids) and the sessions the Desktop app already stars. They leave their bucket
 * so nothing is listed twice. `folded` names the sections the person has closed on this device.
 */
export function groupSessions(sessions: SessionList, mode: GroupMode = "status", opts: { includeArchived?: boolean; home?: string; pins?: readonly string[]; folded?: readonly string[] } = {}): ListSection[] {
  const list = opts.includeArchived ? sessions.slice() : sessions.filter(s => !s.archived);
  const folded = opts.folded ?? [];
  const pins = opts.pins ?? [];
  const pinned = opts.pins ? list.filter(s => isPinned(s, pins)) : [];
  const rest = opts.pins ? list.filter(s => !isPinned(s, pins)) : list;
  const section = (key: string, name: string, group: SessionSummary[]): ListSection => ({ key, name, sessions: group, folded: folded.includes(key) });
  const top = pinned.length ? [section(PINNED_GROUP, t("home.pinned"), pinned.sort(byRecency))] : [];
  if (mode === "folder") {
    const byFolder = new Map<string, SessionSummary[]>();
    for (const s of rest) { const bucket = byFolder.get(s.cwd); if (bucket) bucket.push(s); else byFolder.set(s.cwd, [s]); }
    return top.concat([...byFolder.entries()]
      .sort((a, b) => folderRecency(b[1]) - folderRecency(a[1]) || a[0].localeCompare(b[0]))
      .map(([cwd, group]) => section(`folder:${cwd}`, folderName(cwd, opts.home), group.sort(byRecency))));
  }
  return top.concat(GROUP_ORDER
    .map(group => section(`group:${group}`, groupLabel(group), rest.filter(s => sessionGroup(s) === group).sort(byRecency)))
    .filter(section => section.sessions.length > 0));
}

/** What a search can say. "No results" is only ever said about a list that arrived. */
export type SessionSearch =
  | { kind: "idle" }
  /** The list has never arrived (nothing is paired, the link never came up): searching would be a guess. */
  | { kind: "unavailable" }
  | { kind: "results"; sessions: SessionSummary[] }
  | { kind: "none" };

/**
 * Search by what a person names a session: its title, its project (every segment of the working
 * directory, so "ClaudeRipple remote" reaches a folder several levels down), and the Claude app's
 * own sidebar line. Every word must appear somewhere, in any order; case and spacing do not count.
 * Archived sessions are searched too — a search looks through everything the host sent.
 */
export function searchSessions(sessions: SessionList, query: string, opts: { listKnown?: boolean } = {}): SessionSearch {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { kind: "idle" };
  if (opts.listKnown === false) return { kind: "unavailable" };
  const found = sessions.filter(s => {
    const hay = `${sessionTitle(s)}\n${s.cwd}\n${s.status ?? ""}`.toLocaleLowerCase();
    return words.every(word => hay.includes(word));
  });
  return found.length ? { kind: "results", sessions: found.slice().sort(byRecency) } : { kind: "none" };
}
