// Events → what the timeline shows. Pure, so the same reduction runs in tests and in the app.
import type { PermissionContent, Effort, Figures, ImagePart, SessionEvent, SessionState, Text, ToolCall } from "../src/protocol.ts";
import { WRAP_TOOL, wrapUpFields, type WrapUpReply } from "../src/wrap-up.ts";

export interface ToolView extends ToolCall { result?: { ok: boolean; text: Text; images?: ImagePart[] } }

export type Item =
  | { type: "user"; key: string; ver: string; text: string; images?: ImagePart[]; at: number; queued?: "pending" | "sending" }
  | { type: "assistant"; key: string; ver: string; text: Text; images?: ImagePart[]; streaming: boolean; tools: ToolView[]; model: string; at: number }
  | { type: "thinking"; key: string; ver: string; text: Text; streaming: boolean; msg: string; at: number }
  | { type: "subagent"; key: string; ver: string; toolUseId: string; sub: string; description: string; model: string | null; status: "running" | "done" | "failed"; steps: number }
  | (PermissionContent & { type: "permission"; key: string; ver: string; id: string; tool: string; title: string; summary: string; input: Text; canAlways: boolean; decision: null | "allow" | "allow_always" | "deny" | "expired"; reason?: string; at: number })
  | { type: "result"; key: string; ver: string; ok: boolean; error?: string; ms: number; model: string; effort: Effort | null }
  | { type: "notice"; key: string; ver: string; code: string; text?: string }
  | { type: "start"; key: string; ver: string };

export interface SessionView {
  items: Item[];
  state: SessionState | null;
  figures: Figures | null;
  model: string | null;
  effort: Effort | null;
  /** open permission requests, oldest first */
  open: Extract<Item, { type: "permission" }>[];
  /** when the current turn began, for the "working for" line */
  turnStartedAt: number | null;
  lastSeq: number;
}

export interface Outgoing { clientMsgId: string; text: string; at: number; state: "pending" | "sending" }

/**
 * Reduce a session's loaded events (ascending seq; gaps allowed, duplicates ignored) and the
 * messages this phone has not seen acknowledged yet.
 */
export function reduce(events: readonly SessionEvent[], outbox: readonly Outgoing[] = [], atStart = false): SessionView {
  const items: Item[] = [];
  const byKey = new Map<string, number>();
  const toolOwner = new Map<string, { item: number; tool: number }>();
  const seenUser = new Set<string>();
  let state: SessionState | null = null;
  let figures: Figures | null = null;
  let model: string | null = null;
  let effort: Effort | null = null;
  let turnStartedAt: number | null = null;
  let lastSeq = 0;
  const put = (item: Item): void => {
    const at = byKey.get(item.key);
    if (at === undefined) { byKey.set(item.key, items.length); items.push(item); }
    else items[at] = item;
  };
  if (atStart) put({ type: "start", key: "start", ver: "1" });
  for (const e of events) {
    if (e.seq <= lastSeq) continue;
    lastSeq = e.seq;
    switch (e.kind) {
      case "user":
        seenUser.add(e.clientMsgId);
        // The app counts "working for" from the person's message; Mac sessions have no turn event to say so.
        turnStartedAt = e.at;
        put({ type: "user", key: `u${e.clientMsgId}`, ver: `u${e.seq}`, text: e.text, ...(e.images ? { images: e.images } : {}), at: e.at });
        break;
      case "turn":
        model = e.model; effort = e.effort; turnStartedAt = e.at;
        break;
      case "thinking": {
        const key = `h${e.msg}:${e.block}`;
        const prev = byKey.has(key) ? items[byKey.get(key)!] : undefined;
        const text = e.delta ? (prev?.type === "thinking" && typeof prev.text === "string" ? prev.text : "") + (typeof e.text === "string" ? e.text : e.text.preview) : e.text;
        put({ type: "thinking", key, ver: `h${e.seq}`, msg: e.msg, text, streaming: e.delta === true, at: e.at });
        break;
      }
      case "delta": {
        const key = `a${e.msg}`;
        const prev = byKey.has(key) ? items[byKey.get(key)!] : undefined;
        const text = (prev?.type === "assistant" && typeof prev.text === "string" ? prev.text : "") + e.text;
        put({ type: "assistant", key, ver: `d${e.seq}`, text, streaming: true, tools: prev?.type === "assistant" ? prev.tools : [], model: model ?? "", at: e.at });
        break;
      }
      case "assistant": {
        const key = `a${e.msg}`;
        const previous = byKey.has(key) ? items[byKey.get(key)!] : undefined;
        const results = new Map(previous?.type === "assistant" ? previous.tools.map(tc => [tc.id, tc.result]) : []);
        const tools: ToolView[] = e.tools.map(tc => ({ ...tc, ...(results.get(tc.id) ? { result: results.get(tc.id)! } : {}) }));
        put({ type: "assistant", key, ver: `f${e.seq}`, text: e.text, ...(e.images ? { images: e.images } : {}), streaming: false, tools, model: e.model, at: e.at });
        const idx = byKey.get(key)!;
        tools.forEach((tc, i) => toolOwner.set(tc.id, { item: idx, tool: i }));
        break;
      }
      case "tool_result": {
        const owner = toolOwner.get(e.toolUseId);
        const item = owner ? items[owner.item] : undefined;
        if (owner && item?.type === "assistant") {
          const tools = item.tools.slice();
          tools[owner.tool] = { ...tools[owner.tool]!, result: { ok: e.ok, text: e.text, ...(e.images ? { images: e.images } : {}) } };
          items[owner.item] = { ...item, tools, ver: `${item.ver}r${e.seq}` };
        }
        break;
      }
      case "subagent":
        put({ type: "subagent", key: `s${e.toolUseId}`, ver: `${e.seq}`, toolUseId: e.toolUseId, sub: e.sub, description: e.description, model: e.model, status: e.status, steps: e.steps });
        break;
      case "permission":
        put({ type: "permission", key: `p${e.id}`, ver: `${e.seq}`, id: e.id, tool: e.tool, title: e.title, summary: e.summary, input: e.input, canAlways: e.canAlways, ...(e.requestKind ? { requestKind: e.requestKind } : {}), ...(e.questions ? { questions: e.questions } : {}), decision: null, at: e.at });
        break;
      case "permission_decided": {
        const at = byKey.get(`p${e.id}`);
        const item = at === undefined ? undefined : items[at];
        if (item?.type === "permission") items[at!] = { ...item, decision: e.decision, ...(e.reason ? { reason: e.reason } : {}), ver: `${item.ver}d${e.seq}` };
        break;
      }
      case "result":
        // A queued next turn can already be running in the final snapshot.
        // Completion belongs to this point in the log, not only to the final state.
        for (const item of items) if ((item.type === "thinking" || item.type === "assistant") && item.streaming) { item.streaming = false; item.ver += "s"; }
        put({ type: "result", key: `r${e.seq}`, ver: "1", ok: e.ok, ...(e.error ? { error: e.error } : {}), ms: e.ms, model: model ?? "", effort });
        turnStartedAt = null;
        break;
      case "state":
        state = e.state;
        // Idle ends a Mac session's turn (it has no result event); "stopped" is a host restart's blip, not an end.
        if (e.state === "idle" || e.state === "error") turnStartedAt = null;
        else if (e.state === "running" && turnStartedAt === null) turnStartedAt = e.at;
        break;
      case "figures":
        figures = e.figures;
        break;
      case "notice":
        put({ type: "notice", key: `n${e.seq}`, ver: "1", code: e.code, ...(e.text ? { text: e.text } : {}) });
        break;
    }
  }
  for (const o of outbox) {
    if (seenUser.has(o.clientMsgId)) continue;
    put({ type: "user", key: `u${o.clientMsgId}`, ver: o.state, text: o.text, at: o.at, queued: o.state });
  }
  for (const it of items) if ((it.type === "assistant" || it.type === "thinking") && it.streaming && state !== "running" && state !== "starting" && state !== "waiting") { it.streaming = false; it.ver += "s"; }
  const open = items.filter((i): i is Extract<Item, { type: "permission" }> => i.type === "permission" && i.decision === null);
  return { items, state, figures, model, effort, open, turnStartedAt, lastSeq };
}

export type ActivityRow = { type: "tool"; tool: ToolView } | (Extract<Item, { type: "subagent" }> & { call?: ToolView });
export interface ToolGroup {
  type: "toolGroup"; key: string; ver: string; rows: ActivityRow[];
  tools: number; workers: number; running: boolean; latest: string;
}
/** A reply button in a turn's closing box: `label` on the button, `message` what a tap sends. */
export type { WrapUpReply };
/** The Code tab's closing box (its wrap_up tool): drawn only when the turn leaves the person a question. */
export interface WrapUp { type: "wrapUp"; key: string; ver: string; recap: string; ask: string; replies: WrapUpReply[]; blocked: boolean; answered: boolean }
/** The Code tab's chapter mark (its mark_chapter tool): a divider where the work moved to a new phase. */
export interface Chapter { type: "chapter"; key: string; ver: string; title: string; summary: string }
export type TimelineItem = Item | ToolGroup | WrapUp | Chapter;

/** A tool call that draws a "visualize" widget rather than doing work: `show_widget` or `…__show_widget`. */
export const isWidgetTool = (name: string): boolean => name === "show_widget" || name.endsWith("__show_widget");

// The Claude app's Code-tab tools, which draw something of their own there (only its sessions call them).
const PLAN_TOOL = "mcp__ccd_turn__update_plan";
const CHAPTER_TOOL = "mcp__ccd_session__mark_chapter";

function inputOf(tool: ToolView): Record<string, unknown> | null {
  if (typeof tool.input !== "string") return null;
  try {
    const value: unknown = JSON.parse(tool.input);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; } // Untrusted model input.
}
const words = (value: unknown, max: number): string => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

/** The closing box a wrap_up call draws, with the Claude app's limits (wrap-up.ts, which the host
 * reads its pushes and status line from too); null when it has no question (the app draws no box
 * then), undefined when its input cannot be read (it stays a tool row). */
function wrapUpOf(tool: ToolView, ver: string): WrapUp | null | undefined {
  const input = inputOf(tool);
  if (!input) return undefined;
  const { recap, ask, replies, blocked } = wrapUpFields(input);
  if (!ask && !replies.length) return null;
  return { type: "wrapUp", key: `w${tool.id}`, ver, recap, ask, replies, blocked, answered: false };
}

/** Presentation only: text, permissions and turn boundaries separate consecutive activity. */
export function timelineItems(view: Pick<SessionView, "items" | "state">): TimelineItem[] {
  const result: TimelineItem[] = [];
  const workers = new Map(view.items.flatMap(i => i.type === "subagent" ? [[i.toolUseId, i] as const] : []));
  const owned = new Set(view.items.flatMap(i => i.type === "assistant" ? i.tools.map(t => t.id) : []));
  let group: ToolGroup | null = null;
  const add = (row: ActivityRow, key: string, ver: string): void => {
    if (!group) {
      group = { type: "toolGroup", key: `g${key}`, ver: "", rows: [], tools: 0, workers: 0, running: false, latest: "" };
      result.push(group);
    }
    group.rows.push(row);
    group.ver += ver;
    if (row.type === "tool") {
      if (row.tool.name === "Agent" || row.tool.name === "Task") group.workers++;
      else group.tools++;
      group.latest = row.tool.summary || row.tool.name;
    }
    else { group.workers++; group.latest = row.description; }
  };
  // The closing box sits under whatever the turn says after it, as in the Claude app: it is held until
  // the turn ends (its result, or the person's next message).
  let wrap: WrapUp | null = null;
  const flushWrap = (): void => { if (wrap) { group = null; result.push(wrap); wrap = null; } };
  for (const item of view.items) {
    if (item.type === "subagent") {
      if (!owned.has(item.toolUseId)) add(item, item.key, item.ver);
      continue;
    }
    if (item.type === "assistant") {
      if (typeof item.text !== "string" || item.text.trim() || item.images?.length || item.streaming) {
        group = null;
        result.push({ ...item, tools: [] });
      }
      for (const tool of item.tools) {
        // The dock shows the task list; the closing box and chapters draw themselves.
        if (tool.name === PLAN_TOOL) continue;
        if (tool.name === WRAP_TOOL) {
          const box = wrapUpOf(tool, item.ver);
          if (box !== undefined) { if (box) wrap = box; continue; }
        }
        const chapter = tool.name === CHAPTER_TOOL ? inputOf(tool) : null;
        if (chapter && words(chapter.title, 80)) {
          group = null;
          result.push({ type: "chapter", key: `c${tool.id}`, ver: item.ver, title: words(chapter.title, 80), summary: words(chapter.summary, 300) });
          continue;
        }
        // A widget is something to look at, not activity: it stands on its own instead of folding away.
        if (isWidgetTool(tool.name)) {
          group = null;
          result.push({ ...item, key: `${item.key}:${tool.id}`, text: "", images: [], streaming: false, tools: [tool] });
          continue;
        }
        const worker = workers.get(tool.id);
        if (worker) add({ ...worker, call: tool }, worker.key, `${worker.ver}:${item.ver}`);
        else add({ type: "tool", tool }, tool.id, item.ver);
      }
      continue;
    }
    // As in the Claude app's default view, thinking is not drawn and does not split a run (most of it
    // has its text withheld anyway). Only thinking still streaming at the very end shows, as a live line.
    if (item.type === "thinking") continue;
    if (item.type === "user" || item.type === "result") flushWrap();
    group = null;
    result.push(item);
  }
  flushWrap();
  // A box the person has answered (a message of theirs follows it) keeps its words but not its buttons.
  let answered = false;
  for (let i = result.length - 1; i >= 0; i--) {
    const it = result[i]!;
    if (it.type === "user") answered = true;
    else if (it.type === "wrapUp" && answered) result[i] = { ...it, answered: true, ver: `${it.ver}a` };
  }
  const tail = view.items.at(-1);
  if (tail?.type === "thinking" && tail.streaming) result.push(tail);
  // Only the final activity run of the active turn spins, even between tool results.
  const last = result.at(-1);
  if (last?.type === "toolGroup" && (view.state === "running" || view.state === "starting" || view.state === "waiting")) {
    last.running = true;
    last.ver += "running";
  }
  return result;
}

/** Merge a page into a sorted event list without duplicates (pages may overlap after a reconnect). */
export function mergeEvents(into: SessionEvent[], page: readonly SessionEvent[]): SessionEvent[] {
  if (page.length === 0) return into;
  const first = page[0]!.seq;
  const last = page[page.length - 1]!.seq;
  const head = into.length ? into[0]!.seq : Infinity;
  const tail = into.length ? into[into.length - 1]!.seq : -Infinity;
  if (first > tail) return into.concat(page);
  if (last < head) return page.concat(into);
  const map = new Map<number, SessionEvent>();
  for (const e of into) map.set(e.seq, e);
  for (const e of page) map.set(e.seq, e);
  return Array.from(map.values()).sort((a, b) => a.seq - b.seq);
}
