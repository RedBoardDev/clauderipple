// Sessions are the host's. Each one is a Claude Code process driven through the Agent SDK in
// a folder and on a model the phone chose, sent through the router like any CLI (ARCHITECTURE
// §1: HTTPS_PROXY + NODE_EXTRA_CA_CERTS — not ANTHROPIC_BASE_URL, which the router's proxy port
// answers 405; measured 2026-10-11, docs/specs/2026-10-11-ripple-remote-ux.md). Everything a
// phone may need later goes into the session's event log before it goes to any socket.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EventLog } from "./eventlog.ts";
import type { PushContext } from "./push-content.ts";
import type { PushEvent } from "./protocol.ts";
import { attachmentContent, fileImages, messageContent, sessionFileTool, type InputBlock } from "./images.ts";
import { ATTACHMENT_CAP, ATTACHMENT_COUNT, type Attachment, type ImagePart, type SessionFile, type SendBehavior } from "./protocol.ts";
import { DesktopSessions, type DesktopProcess, type TurnWrapUp } from "./desktop.ts";
import { firstSentence, STATUS_CAP } from "./wrap-up.ts";
import { DesktopSidebar, PHONE_GROUP, type SidebarOptions } from "./sidebar.ts";
import { BridgeAuthError, BridgeClient, bridgeWriteUnknown, CLI_NOT_LOGGED_IN, DESKTOP_BLOCKED, isCliNotLoggedIn, object, permissionSuppression, slashCommands, type BridgeFrame } from "./bridge-client.ts";
import type { HandoffRunner } from "./handoff.ts";
import { isDirectory, macConsent, readableFolder } from "./folders.ts";
import { readJson, writeFileAtomic } from "./fsutil.ts";
import { createWorktree } from "./worktree.ts";
import { MessageReceipts, OutcomeUnknownError } from "./receipts.ts";
import { SessionSettings, sessionPermissionRules } from "./session-controls.ts";
import type { BridgePermissionRequest } from "./bridge-client.ts";
import type { SessionControls, SettingsResult } from "./protocol.ts";

interface BridgePending {
  id: string; input: Record<string, unknown>; toolUseId: string;
  rules: ReturnType<typeof sessionPermissionRules>;
}
import { SendQueue, type QueueItem } from "./queue.ts";
import type { Decision, PermissionQueue } from "./permissions.ts";
import { PERMISSION_MODES, type AlertBody, type Attention, type AttentionReason, type PermissionMode, type Question, type Effort, type EventBody, type Figures, type Isolation, type SessionEvent, type SessionState, type SessionSummary, type ToolCall } from "./protocol.ts";
import type { RouterClient } from "./router.ts";

// ---- the slice of the Agent SDK this file relies on (typed loosely so tests can fake it) ----

export interface SdkUserMessage { type: "user"; message: { role: "user"; content: string | InputBlock[] }; parent_tool_use_id: null; session_id: string; uuid?: string; origin?: { kind: "human" } }
export interface SdkQuery extends AsyncIterable<Record<string, unknown>> {
  interrupt(): Promise<unknown>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  close(): void;
  /** The launcher resolves this only after the transcript writer has exited. */
  processExited?: Promise<void>;
}
export type PermissionAnswer =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: "deny"; message: string; interrupt?: boolean };
export type CanUseTool = (tool: string, input: Record<string, unknown>, opts: { signal: AbortSignal; suggestions?: unknown[]; suppressAlwaysAllowRule?: boolean; title?: string; decisionReason?: string; toolUseID?: string }) => Promise<PermissionAnswer>;
export type QueryFn = (params: { prompt: AsyncIterable<SdkUserMessage>; options: Record<string, unknown> }) => SdkQuery;

interface SessionRecord {
  id: string;
  sdkSessionId: string | null;
  cwd: string;
  model: string;
  effort: Effort | null;
  permissionMode?: PermissionMode;
  prePlanMode?: PermissionMode;
  /** The initial launch allowance is immutable; mode changes must not add a bypass flag. */
  bypassAllowed?: boolean;
  /** Confirmed next-turn settings outrank historical assistant/user transcript metadata. */
  confirmedSettings?: Omit<SettingsResult, "status" | "errors">;
  title: string;
  createdAt: number;
  updatedAt: number;
  state: SessionState;
  createdBy: string;
  contextWindow: number | null;
  /** Missing on older host records; desktop continuations are explicitly excluded. */
  desktopHandoff?: "pending" | "attempted" | "failed" | "excluded";
  desktopHandoffAttempts?: number;
  desktopHandoffError?: string;
  desktopBridge?: boolean;
  transcriptOffset?: number;
}

interface Live {
  query: SdkQuery;
  ready: Promise<void>;
  input: Inbox;
  abort: AbortController;
  /** Text deltas waiting to be written (coalesced, ~80 ms). */
  buffer: { msg: string; text: string; thinking?: { block: number; text: string } } | null;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Content blocks of the API message being streamed, merged across the SDK's per-block messages. */
  current: { msg: string; text: string; images?: ImagePart[]; files?: SessionFile[]; tools: ToolCall[]; model: string; thinkingBlocks: number[]; nextThinkingBlock: number } | null;
  /** Task/Agent tool ids → their subagent while it runs */
  subs: Map<string, { description: string; model: string | null; steps: number }>;
  turnStart: number;
  restartAfterTurn: boolean;
  retried: boolean;
  interrupted: boolean;
  /** Inputs still owed a result, including ones the SDK already read into its own queue. */
  pendingMessages: SdkUserMessage[];
}

export interface SessionsOptions {
  dir: string;
  router: Pick<RouterClient, "status" | "figures">;
  permissions: PermissionQueue;
  queryFn: QueryFn;
  claudePath?: string;
  handoff?: HandoffRunner;
  log?: (line: string) => void;
  onEvent: (session: string, event: SessionEvent) => void;
  onSessions: () => void;
  /** A turn finished/failed, or an approval is waiting, on a Mac session the host is not tailing.
   * Fired only while `away`, and never appended to a log (main sends it to the pushes). */
  onAlert?: (session: string, body: AlertBody) => void;
  /** Whether the Mac is away (screen locked, or no input for a while). Missing: never alert. */
  away?: () => Promise<boolean>;
  /** Claude app sessions became unreachable for the whole host (the Mac's Claude login), or reachable again (null). */
  onDesktopProblem?: (problem: string | null) => void;
  now?: () => number;
  coalesceMs?: number;
  /** Enabled by main; tests can use an isolated synthetic projects directory. */
  desktopProjects?: string;
  desktopSidebar?: SidebarOptions;
  desktopProcesses?: () => string;
  desktopRegistry?: () => Map<string, DesktopProcess>;
  bridgeClient?: BridgeClient;
  /** Optional file-notification boundary; polling remains authoritative when unavailable. */
  watchTranscript?: (id: string, changed: () => void, failed: (error: unknown) => void) => (() => void) | null;
}

/** An async iterable the SDK reads user messages from; a session's query lives as long as it. */
class Inbox implements AsyncIterable<SdkUserMessage> {
  private queue: SdkUserMessage[] = [];
  private waiting: ((r: IteratorResult<SdkUserMessage>) => void) | null = null;
  private done = false;
  push(m: SdkUserMessage): void {
    if (this.done) return;
    if (this.waiting) { const w = this.waiting; this.waiting = null; w({ value: m, done: false }); } else this.queue.push(m);
  }
  close(): void {
    this.queue = [];
    this.done = true;
    if (this.waiting) { const w = this.waiting; this.waiting = null; w({ value: undefined, done: true }); }
  }
  [Symbol.asyncIterator](): AsyncIterator<SdkUserMessage> {
    return {
      next: () => {
        const m = this.queue.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { this.waiting = resolve; });
      },
    };
  }
}

/** Routed models take their effort as `model@level`, which the router reads (ARCHITECTURE §3a); Claude models take the SDK's own option. */
function isClaudeModel(model: string): boolean { return model.startsWith("claude-") || /^(opus|sonnet|haiku)(\[1m\])?$/.test(model); }

export function modelArg(model: string, effort: Effort | null): { model: string; effort?: Effort } {
  // Claude Code's own aliases (router.ts offers them when no anthropic provider is declared) are
  // Claude models too: `opus@high` would reach Anthropic as a model nobody has.
  if (isClaudeModel(model)) return effort && ["low", "medium", "high", "xhigh", "max"].includes(effort) ? { model, effort } : { model };
  return { model: effort ? `${model}@${effort}` : model };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const oneLine = (s: string, n = 200): string => { const l = s.split("\n").find((x) => x.trim()) ?? ""; return l.length > n ? l.slice(0, n - 1) + "…" : l; };

function relativeToCwd(file: string, cwd: string): string {
  if (!file || !path.isAbsolute(file)) return file;
  const relative = path.relative(cwd, file);
  if (!relative) return ".";
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? relative : file;
}

/** One line a person reads to know what a tool call does. */
export function summarize(tool: string, input: Record<string, unknown>, cwd: string): string {
  const rel = (file: string): string => relativeToCwd(file, cwd);
  switch (tool) {
    case "Bash": return oneLine(str(input.command));
    case "Read": case "Write": case "Edit": case "MultiEdit": return rel(str(input.file_path));
    case "NotebookEdit": return rel(str(input.notebook_path));
    case "Glob": return str(input.pattern);
    case "Grep": return `${str(input.pattern)}${input.path ? "  " + rel(str(input.path)) : ""}`;
    case "WebFetch": return str(input.url);
    case "WebSearch": return str(input.query);
    case "Task": case "Agent": return oneLine(str(input.description));
    case "SendUserFile": {
      const files = (Array.isArray(input.files) ? input.files : []).filter((f): f is string => typeof f === "string").map(rel);
      return oneLine([...files, str(input.caption)].filter(Boolean).join(", "));
    }
    case "AskUserQuestion": return oneLine(str(object(Array.isArray(input.questions) ? input.questions[0] : null)?.question));
    case "ExitPlanMode": return oneLine(str(input.plan));
    case "EnterPlanMode": return "";
    case "TodoWrite": return Array.isArray(input.todos) ? `${input.todos.length}` : "";
    default: {
      const first = Object.values(input).find((v) => typeof v === "string") as string | undefined;
      return first ? oneLine(first) : oneLine(JSON.stringify(input), 120);
    }
  }
}

/** What the permission card shows in full: the command, the change, or the arguments. */
export function permissionDetail(tool: string, input: Record<string, unknown>, cwd: string): string {
  if (tool === "Bash") return str(input.command);
  if (tool === "Edit") return `${summarize(tool, input, cwd)}\n- ${str(input.old_string).split("\n").join("\n- ")}\n+ ${str(input.new_string).split("\n").join("\n+ ")}`;
  if (tool === "Write") return `${summarize(tool, input, cwd)}\n+ ${str(input.content).split("\n").join("\n+ ")}`;
  if (tool === "MultiEdit" && Array.isArray(input.edits)) return input.edits.map(edit => permissionDetail("Edit", { ...object(edit), file_path: input.file_path }, cwd)).join("\n\n");
  if (tool === "ExitPlanMode") return str(input.plan);
  return JSON.stringify(input, null, 2);
}

function questionInputs(input: Record<string, unknown>): Question[] {
  if (!Array.isArray(input.questions)) throw new Error("Invalid AskUserQuestion input");
  return input.questions.map(value => {
    const q = object(value);
    if (!q || typeof q.question !== "string" || typeof q.header !== "string" || typeof q.multiSelect !== "boolean" || !Array.isArray(q.options)) throw new Error("Invalid AskUserQuestion question");
    const options = q.options.map(value => {
      const option = object(value);
      if (!option || typeof option.label !== "string" || typeof option.description !== "string") throw new Error("Invalid AskUserQuestion option");
      return { label: option.label, description: option.description };
    });
    return { question: q.question, header: q.header, multiSelect: q.multiSelect, options };
  });
}

/**
 * The card a Remote Control request deserves: a plan, a question the phone can answer, or a plain
 * tool approval — the same split the host's own canUseTool makes. A question input the phone cannot
 * render stays a tool card (the request is still answerable) rather than failing the stream.
 */
function bridgeRequest(tool: string, input: Record<string, unknown>): { requestKind: "tool" | "plan" | "question"; questions?: Question[] } {
  if (tool === "ExitPlanMode") return { requestKind: "plan" };
  if (tool !== "AskUserQuestion") return { requestKind: "tool" };
  try { return { requestKind: "question", questions: questionInputs(input) }; } catch { return { requestKind: "tool" }; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A stable v4-shaped UUID for a phone message id. */
function uuidFrom(text: string): string {
  const h = createHash("sha256").update(text).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The list-level state the host keeps outside any session's log: who wants a look, and what is archived. */
export interface ListState { attention: Record<string, Attention>; archived: string[] }

/**
 * The attention a state change should leave behind, or null when it should leave none.
 *   waiting  → permission (a person must answer; opening the session does not clear it)
 *   error    → failed     (the last turn errored)
 *   idle, after a turn that ran → finished (the turn ended and nobody has looked yet)
 *   running/starting/stopped   → none (work (re)started, or the pending turn is gone)
 * Any other transition keeps what is already there.
 */
export function nextAttention(current: Attention | null, from: SessionState, to: SessionState, at: number): Attention | null {
  if (from === to) return current;
  if (to === "waiting") return current?.reason === "permission" ? current : { reason: "permission", at };
  if (to === "error") return current?.reason === "failed" ? current : { reason: "failed", at };
  if (to === "idle" && (from === "running" || from === "waiting")) return { reason: "finished", at };
  if (to === "running" || to === "starting" || to === "stopped") return null;
  return current;
}

/** Mac sessions the host asks the router about for the first time in one desktop poll. */
const FIRST_SIGHTS_PER_POLL = 4;
/** A turn is under way: a queued message waits. */
const BUSY = new Set<SessionState>(["starting", "running", "waiting"]);
/** The SDK's model key without the `@effort` a routed model carries. */
const windowKey = (model: string): string => model.replace(/@[^@]*$/, "");

export class Sessions {
  private opts: SessionsOptions;
  private records = new Map<string, SessionRecord>();
  /** Unreadable sessions stay on disk but cannot participate in this host's work. */
  private skippedRecords = new Map<string, SessionRecord>();
  private logs = new Map<string, EventLog>();
  private live = new Map<string, Live>();
  /** Slash commands per session (its init event), and the latest seen anywhere for sessions with none yet. */
  private commandLists = new Map<string, { at: number; list: string[] }>();
  private lastCommands: string[] = [];
  private figuresAt = new Map<string, number>();
  private lastFigures = new Map<string, string>();
  /** model → the context window the SDK reported for it (`modelUsage`), learned from host sessions and
   * reused for Mac sessions on the same model, which never report one. Kept in `context-windows.json`. */
  private windows = new Map<string, number>();
  private windowsFile: string;
  /** Mac sessions with no record here: the latest figures read, put back into the snapshot a phone reads. */
  private desktopFigures = new Map<string, Figures>();
  /** Mac session → whether a turn was running at the last poll; absent until the session is first seen. */
  private macTurns = new Map<string, boolean>();
  private creating = new Map<string, Promise<string>>();
  private handingOff = new Map<string, { messages: SdkUserMessage[] }>();
  private shuttingDown = false;
  private file: string;
  /** Attention per session id, and archived session ids; kept outside the logs so both survive a restart. */
  private attention = new Map<string, Attention>();
  private archived = new Set<string>();
  private listFile: string;
  private now: () => number;
  private receipts: MessageReceipts;
  private settings: SessionSettings;
  private permissionRules = new Map<string, ReturnType<typeof sessionPermissionRules>>();
  private sendQueue: SendQueue;
  /** In-flight turns keyed by receipt key, so a concurrent resend rides the first attempt. */
  private sending = new Map<string, Promise<string>>();
  private desktop: DesktopSessions | null;
  private sidebar: DesktopSidebar | null;
  private sidebarFingerprint = "";
  private desktopModels = new Map<string, { model: string; effort: Effort | null }>();
  private bridge: BridgeClient;
  private bridgeStates = new Map<string, { at: number; state?: SessionState; pending?: Promise<void> }>();
  /** Ignore cached/in-flight idle and eventual-consistency idle after an accepted send. A fresh
   * running/waiting read or transcript result settles it. The 9 s bound covers the 3 s cache,
   * 3 s poll and one scheduling margin, without leaving a never-started turn running forever. */
  private bridgeRunning = new Map<string, number>();
  private attached = new Set<string>();
  private detachedWatches = new Set<string>();
  private transcriptWatches = new Map<string, { close: (() => void) | null; timer: ReturnType<typeof setTimeout> | null }>();
  /** The last state seen per non-bridged Mac session, for the away-alert transitions. The first
   * sight of a session only seeds it: a host start must not push for turns that ended before it. */
  private macStates = new Map<string, { state: SessionState; permission: boolean }>();
  /** Claude app sessions: the status line read from the transcript at `size`. Recomputed only when
   * that file grew, so a poll never rereads a transcript it has already read (a 256 KB window). */
  private statuses = new Map<string, { size: number; status: string }>();
  /** The wrap_up whose blocked question the person was already told about, per session, so a later
   * poll that still finds the same question (or a phone that cleared it) raises it only once. */
  private askedWrapUps = new Map<string, string>();

  /** The registry says busy (it counts background work) while the main turn itself is not running. */
  private background(process: DesktopProcess): boolean {
    const state = this.bridgeState(process);
    return (process.status === "busy" || process.status === "shell") && state !== "running" && state !== "waiting";
  }

  private bridgeState(process: DesktopProcess): SessionState {
    const id = process.bridgeSessionId;
    const sent = id ? this.bridgeRunning.get(id) : undefined;
    if (sent !== undefined && this.now() - sent < 9000) return "running";
    if (id) this.bridgeRunning.delete(id);
    const cached = id ? this.bridgeStates.get(id)?.state : undefined;
    return cached ?? (process.status === "waiting" ? "waiting" : process.status === "idle" ? "idle" : "running");
  }

  private pollBridgeState(id: string): Promise<void> {
    const cached = this.bridgeStates.get(id);
    if (cached?.pending) return cached.pending;
    if (cached && this.now() - cached.at < 3000) return Promise.resolve();
    const entry: { at: number; state?: SessionState; pending?: Promise<void> } = { at: this.now(), ...(cached?.state ? { state: cached.state } : {}) };
    this.bridgeStates.set(id, entry);
    let changed = false;
    entry.pending = this.bridge.session(id).then(session => {
      this.noteBridge(id, null);
      const next: SessionState = session.worker_status === "requires_action" ? "waiting" : session.worker_status;
      const sent = this.bridgeRunning.get(id);
      // A request started before the send cannot confirm the new turn, even if it resolves later.
      if (sent !== undefined && entry.at > sent && next !== "idle") this.bridgeRunning.delete(id);
      // Phones are told only when the state actually moved; every desktop poll re-reads this.
      if (entry.state !== next) { entry.state = next; changed = true; }
    }).catch(error => {
      if (entry.state !== undefined) { delete entry.state; changed = true; } // The registry is the fallback only on a failed read.
      this.noteBridge(id, error, "desktop state");
    }).finally(() => { delete entry.pending; if (changed) this.opts.onSessions(); });
    return entry.pending;
  }

  /** Why Claude app sessions cannot be reached at all right now (the Mac's Claude login), or null. */
  private bridgeProblem: string | null = null;
  /** The last error logged per Remote Control session, so a poll that keeps failing logs once. */
  private bridgeErrors = new Map<string, string>();

  desktopProblem(): string | null { return this.bridgeProblem; }

  /**
   * Record how a Remote Control request went. Every poll re-asks, so the log gets a line when
   * something changes, not per request (an expired login wrote one every few seconds per session,
   * 2026-10-15). A login problem is the host's, not a session's: phones are told through
   * onDesktopProblem, and it clears on the first request that succeeds.
   */
  private noteBridge(bridgeId: string, error: unknown, label = "desktop state"): void {
    const log = this.opts.log ?? console.error;
    if (error === null) {
      this.bridgeErrors.delete(bridgeId);
      if (this.bridgeProblem === null) return;
      this.bridgeProblem = null;
      log("[desktop] Claude app sessions answer again");
      this.opts.onDesktopProblem?.(null);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof BridgeAuthError) {
      if (this.bridgeProblem === message) return;
      this.bridgeProblem = message;
      log(`[desktop] Claude app sessions cannot be reached: ${message}`);
      this.opts.onDesktopProblem?.(message);
      return;
    }
    if (this.bridgeErrors.get(bridgeId) === message) return;
    this.bridgeErrors.set(bridgeId, message);
    if (this.bridgeErrors.size > 200) this.bridgeErrors.delete(this.bridgeErrors.keys().next().value!);
    log(`[${label}] ${bridgeId}: ${message}`);
  }
  private bridges = new Map<string, { bridgeId: string; abort: AbortController; failed: boolean; permissions: Map<string, BridgePending> }>();
  private bridgeSends = new Map<string, Promise<string>>();
  /** uuids of prompts sent over Remote Control, so their transcript echo is not shown twice. */
  private bridgeEchoes = new Set<string>();
  /** Cap for bridgeEchoes: prompts are answered or superseded long before this many pile up. */
  private static readonly ECHO_CAP = 500;
  /** Bridge requestIds already answered or withdrawn (`${session}/${requestId}` → noted at),
   * so a replay that still lists them skips them instead of reviving the card. Never forgotten with
   * time: a Remote Control session can keep listing a request the desktop app answered (the answer
   * may never reach its stored events), and a replay an hour later revived the card (issue #82). */
  private answeredBridge = new Map<string, number>();
  private static readonly ANSWERED_CAP = 2_000;
  /** Recent phone message ids per session, so resend checks skip the log scan while warm. */
  private seenIds = new Map<string, Set<string>>();
  private static readonly SEEN_INDEX_CAP = 200;
  /** Transcript size when a bridged record's title was last refreshed (a Mac rename appends). */
  private bridgeTitleSize = new Map<string, number>();
  private bridgeDecisions = new Map<string, Promise<boolean>>();

  constructor(opts: SessionsOptions) {
    this.opts = opts;
    this.bridge = opts.bridgeClient ?? new BridgeClient();
    this.now = opts.now ?? Date.now;
    this.file = path.join(opts.dir, "sessions.json");
    this.listFile = path.join(opts.dir, "list-state.json");
    this.windowsFile = path.join(opts.dir, "context-windows.json");
    try {
      for (const [model, window] of Object.entries(readJson<Record<string, unknown>>(this.windowsFile) ?? {})) if (typeof window === "number" && window > 0) this.windows.set(model, window);
    } catch { /* a damaged file only means the windows are learned again */ }
    this.receipts = MessageReceipts.open(path.join(opts.dir, "receipts.json"), this.now);
    this.settings = new SessionSettings(path.join(opts.dir, "settings-operations.json"));
    this.sendQueue = SendQueue.open(opts.dir);
    for (const r of readJson<SessionRecord[]>(this.file) ?? []) this.records.set(r.id, r);
    const listState = readJson<ListState>(this.listFile);
    for (const [id, attention] of Object.entries(listState?.attention ?? {})) if (attention?.reason) this.attention.set(id, attention);
    for (const id of listState?.archived ?? []) this.archived.add(id);
    this.sidebar = opts.desktopSidebar ? new DesktopSidebar({ ...opts.desktopSidebar, now: this.now,
      onError: error => (opts.log ?? console.error)(`[desktop sidebar] ${error instanceof Error ? error.message : String(error)}`),
    }) : null;
    this.desktop = opts.desktopProjects === undefined ? null : new DesktopSessions({
      ...(this.sidebar ? { sidebarIds: () => new Set(this.sidebar!.read().sessions.keys()) } : {}),
      projects: opts.desktopProjects, now: this.now, summarize, figures: id => this.desktopFigures.get(id), ...(opts.desktopProcesses ? { processes: opts.desktopProcesses } : {}),
      ...(opts.desktopRegistry ? { registry: opts.desktopRegistry } : {}),
      // Only transcripts the host is writing right now, or a phone session not yet handed to the
      // desktop app, are hidden; any other one may be open in the app and must stay reachable
      // (a record the host once resumed is rebased onto Remote Control from here).
      excluded: () => new Set(Array.from(this.records.values()).filter(r => !r.desktopBridge && (this.live.has(r.id) || r.desktopHandoff === "pending" || r.desktopHandoff === "failed")).flatMap(r => r.sdkSessionId ? [r.id, r.sdkSessionId] : [r.id])),
    });
  }

  /** After a host restart: no query survived, so say so in every session that was mid-turn, and close what it was asking. */
  recover(): void {
    // Validate even idle sessions: listing one also opens its log. Isolate failures before
    // recovery appends anything, and retain their records when healthy sessions are saved.
    for (const r of this.records.values()) {
      try { this.log(r.id); }
      catch (error) {
        this.skippedRecords.set(r.id, r);
        this.records.delete(r.id);
        (this.opts.log ?? console.error)(`[session recovery] skipped ${r.id}: ${error instanceof Error ? error.message : String(error)}; session files preserved at ${path.join(this.opts.dir, "sessions", r.id)}`);
      }
    }
    for (const operation of this.settings.unresolved()) {
      if (this.has(operation.session)) this.append(operation.session, { kind: "settings", reqId: operation.reqId, status: "unknown" }, false);
    }
    for (const p of this.opts.permissions.expiredOnOpen) {
      if (this.records.has(p.session)) this.append(p.session, { kind: "permission_decided", id: p.id, decision: "expired", reason: "host_restarted" });
    }
    for (const r of this.records.values()) {
      if (r.state === "running" || r.state === "starting" || r.state === "waiting") {
        this.append(r.id, { kind: "notice", code: "host_restarted", text: "호스트가 다시 시작되어 이 턴이 중단되었습니다" }, false);
        this.setState(r, "stopped", undefined, false);
      }
    }
  }

  list(): SessionSummary[] {
    const host = Array.from(this.records.values()).sort((a, b) => b.updatedAt - a.updatedAt).map((r) => this.summary(r));
    const hostCliIds = new Set([...this.records.values(), ...this.skippedRecords.values()].flatMap(r => r.sdkSessionId ? [r.id, r.sdkSessionId] : [r.id]));
    const sessions = [...host, ...(this.desktop?.list() ?? []).filter(s => !this.records.has(s.id) && !hostCliIds.has(s.id)).map(s => {
      const process = this.desktop?.liveProcess(s.id);
      const status = this.statusLine(s.id);
      return { ...s, ...this.desktopModels.get(s.id), controls: this.sessionControls(s.id), ...(process?.bridgeSessionId ? { state: this.bridgeState(process), desktopBridge: true, background: this.background(process) } : {}), ...(this.archived.has(s.id) ? { archived: true } : {}), attention: this.attention.get(s.id) ?? null, ...(status ? { status } : {}), ...this.sendQueue.summary(s.id) };
    })];
    return this.sidebar?.join(sessions, id => this.records.get(id)?.sdkSessionId ?? id) ?? sessions;
  }

  groups(): string[] | undefined {
    return this.sidebar ? [...this.sidebar.read().groups.map(g => g.name), PHONE_GROUP] : undefined;
  }

  async pollDesktop(): Promise<void> {
    if (this.shuttingDown) return;
    if (this.desktop?.poll()) this.opts.onSessions();
    this.refreshStatuses();
    const sessions = this.list();
    this.pollMacAlerts(sessions);
    if (this.sidebar) {
      const fingerprint = JSON.stringify([this.groups(), sessions]);
      if (fingerprint !== this.sidebarFingerprint) { this.sidebarFingerprint = fingerprint; this.opts.onSessions(); }
    }
    const ids = new Set(sessions.flatMap(s => {
      const process = this.desktop?.liveProcess(this.records.get(s.id)?.sdkSessionId ?? s.id);
      return process?.bridgeSessionId ? [process.bridgeSessionId] : [];
    }));
    const reads = [...ids].map(id => this.pollBridgeState(id));
    for (const id of this.bridgeStates.keys()) if (!ids.has(id)) this.bridgeStates.delete(id);
    for (const r of this.records.values()) {
      if (!this.desktop) continue;
      const desktopProcess = r.sdkSessionId ? this.desktop.liveProcess(r.sdkSessionId) : undefined;
      // The Claude app worker has Remote Control on for a conversation the host is still driving
      // (a phone session, or one the phone resumed): the app is the writer now. Stop our own query
      // and follow the app's transcript (#82) — together they would append to one transcript and
      // the phone would follow neither. A query still owed a turn finishes first: stopping it would
      // drop messages the phone already had acked.
      if (!r.desktopBridge && r.sdkSessionId && desktopProcess?.bridgeSessionId) {
        const live = this.live.get(r.id);
        if (this.sdkIdle(r, live)) {
          this.stop(r.id);
          // The app already has this conversation, so a pending handoff would only open it again.
          if (r.desktopHandoff === "pending" || r.desktopHandoff === "failed") {
            r.desktopHandoff = "attempted";
            delete r.desktopHandoffError;
            this.save();
          }
          if (this.desktop.has(r.sdkSessionId)) {
            try { this.rebaseDesktop(r); } catch (error) { this.bridgeFailure(r.id, error); continue; }
          }
        }
      }
      if (!r.desktopBridge) continue;
      try {
        this.tailBridge(r);
        // A folder move shows only in the app's registry, not as transcript growth: check every poll.
        this.refreshBridgeMeta(r);
        const process = this.desktop.liveProcess(r.sdkSessionId ?? r.id);
        this.setState(r, process ? this.bridgeState(process) : "stopped", undefined, !!process);
        if (process?.bridgeSessionId) this.ensureBridge(r.id, process.bridgeSessionId);
        else this.closeBridge(r.id);
      } catch (error) { this.bridgeFailure(r.id, error); }
    }
    await Promise.all(reads);
    if (this.shuttingDown) return;
    for (const r of this.records.values()) {
      if (!r.desktopBridge) continue;
      const process = this.desktop?.liveProcess(r.sdkSessionId ?? r.id);
      this.setState(r, process ? this.bridgeState(process) : "stopped", undefined, !!process);
    }
    for (const id of this.attached) {
      this.watchDesktop(id);
      if (!this.records.get(id)?.desktopBridge) this.tailDesktop(id);
    }
    this.pollMacFigures(sessions);
    this.drainQueues();
  }

  /** The server supplies the union across phones; one phone detaching must not close another's watch. */
  watchAttached(ids: Set<string>): void {
    for (const id of this.attached) if (!ids.has(id)) { this.detachedWatches.add(id); this.unwatchDesktop(id); }
    this.attached = new Set(ids);
    for (const id of ids) { this.detachedWatches.delete(id); this.watchDesktop(id); }
  }

  private watchDesktop(id: string): void {
    const record = this.records.get(id);
    const desktopId = record?.sdkSessionId ?? id;
    if (this.shuttingDown || this.detachedWatches.has(id) || this.transcriptWatches.has(id) || (record && !record.desktopBridge) || !this.desktop?.has(desktopId)) return;
    if (record?.desktopBridge && !this.desktop.liveProcess(desktopId)?.bridgeSessionId) return;
    const entry = { close: null as (() => void) | null, timer: null as ReturnType<typeof setTimeout> | null };
    this.transcriptWatches.set(id, entry);
    const changed = () => {
      if (this.transcriptWatches.get(id) !== entry || entry.timer) return;
      // Fixed window rather than a trailing debounce: continuous writes cannot starve delivery.
      entry.timer = setTimeout(() => {
        entry.timer = null;
        try { this.tailDesktop(id); }
        catch (error) { (this.opts.log ?? console.error)(`[desktop tail] ${id}: ${String(error)}`); }
      }, 80);
    };
    const failed = (error: unknown) => {
      (this.opts.log ?? console.error)(`[desktop watch] ${id}: ${String(error)}; polling continues`);
      this.unwatchDesktop(id);
    };
    entry.close = this.opts.watchTranscript
      ? this.opts.watchTranscript(desktopId, changed, failed)
      : this.desktop.watch(desktopId, changed, failed);
    if (!entry.close) this.unwatchDesktop(id);
  }

  private unwatchDesktop(id: string): void {
    const entry = this.transcriptWatches.get(id);
    if (!entry) return;
    this.transcriptWatches.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.close?.();
  }

  private tailDesktop(id: string): void {
    const r = this.records.get(id);
    if (r?.desktopBridge) { this.tailBridge(r); return; }
    if (r || !this.desktop?.has(id)) return;
    const before = this.desktop.snapshot(id);
    const log = this.desktop.log(id);
    if (before === log) return;
    // Read-only desktop snapshots get a new epoch when rebuilt; the server sends a fresh tail.
    const last = log.tail().events.at(-1);
    if (last) this.opts.onEvent(id, last);
    this.opts.onSessions();
  }

  private tailBridge(r: SessionRecord): void {
    if (!this.desktop) return;
    const desktopId = r.sdkSessionId ?? r.id;
    const before = r.transcriptOffset ?? 0;
    r.transcriptOffset = this.desktop.tail(desktopId, before, body => {
      if (body.kind === "result") {
        const bridgeId = this.desktop?.liveProcess(desktopId)?.bridgeSessionId;
        if (bridgeId) this.bridgeRunning.delete(bridgeId);
      }
      // Our own Remote Control echo: drop it from the bounded set and skip it, once.
      if (body.kind === "user" && this.bridgeEchoes.delete(body.clientMsgId)) return;
      if (body.kind !== "user" || !this.seen(r.id, body.clientMsgId)) {
        if (body.kind === "user") this.rememberClientMsgId(r.id, body.clientMsgId);
        this.append(r.id, body);
      }
    }, data => this.log(r.id).image(data));
    if (r.transcriptOffset !== before) {
      this.save();
      this.refreshBridgeMeta(r);
      const process = this.desktop.liveProcess(desktopId);
      this.setState(r, process ? this.bridgeState(process) : "stopped", undefined, !!process);
    }
  }

  /**
   * The mod's figures for Claude app sessions, which no SDK query of ours drives: once when a session
   * is first seen, at most every 15 s while its turn runs, and once more when the turn ends. The
   * first sights are spread over polls so a host start does not ask the router about every old session at once.
   */
  private pollMacFigures(sessions: SessionSummary[]): void {
    if (!this.desktop) return;
    const seen = new Set<string>();
    let firstSights = 0;
    for (const s of sessions) {
      const record = this.records.get(s.id);
      if (record ? !record.desktopBridge : s.origin !== "desktop") continue;
      if (s.archived || !s.model) continue;
      seen.add(s.id);
      const running = s.state === "running" || s.state === "waiting" || s.state === "starting";
      const wasRunning = this.macTurns.get(s.id);
      if (wasRunning === undefined && firstSights >= FIRST_SIGHTS_PER_POLL) continue;
      this.macTurns.set(s.id, running);
      if (wasRunning === undefined) firstSights++;
      if (wasRunning === undefined || wasRunning || running) {
        const forced = wasRunning === undefined || (wasRunning && !running);
        void this.readFigures(s.id, record?.sdkSessionId ?? s.id, s.model, record?.contextWindow ?? null, forced, true);
      }
    }
    for (const id of this.macTurns.keys()) {
      if (seen.has(id)) continue;
      this.macTurns.delete(id);
      if (this.records.has(id)) continue;
      this.figuresAt.delete(id); this.lastFigures.delete(id); this.desktopFigures.delete(id);
    }
  }

  /**
   * The Claude app's own sidebar line for each of its sessions: the last wrap_up's recap, first
   * sentence only. Read from the transcript's tail window, and only when that file grew; the list is
   * re-sent only when a line actually changed, so an idle poll costs nothing.
   */
  private refreshStatuses(): void {
    if (!this.desktop) return;
    let changed = false;
    const seen = new Set<string>();
    for (const s of this.desktop.list()) {
      const record = this.records.get(s.id);
      if (record ? !record.desktopBridge : s.origin !== "desktop") continue;
      if (this.archived.has(s.id)) continue;
      seen.add(s.id);
      const size = this.desktop.transcriptSize(s.id);
      const cached = this.statuses.get(s.id);
      if (cached && cached.size === size) continue;
      const wrap = this.desktop.wrapUp(s.id);
      const status = wrap ? firstSentence(wrap.recap, STATUS_CAP) : "";
      this.statuses.set(s.id, { size, status });
      if ((cached?.status ?? "") !== status) changed = true;
    }
    for (const id of this.statuses.keys()) if (!seen.has(id)) this.statuses.delete(id);
    if (changed) this.opts.onSessions();
  }

  private statusLine(id: string): string | null { return this.statuses.get(id)?.status || null; }

  /** The wrap_up a Claude app session's newest turn left; null for any session the app does not own. */
  private desktopWrapUp(id: string): TurnWrapUp | null {
    const desktopId = this.records.get(id)?.sdkSessionId ?? id;
    return this.desktop?.has(desktopId) ? this.desktop.wrapUp(desktopId) : null;
  }

  /**
   * The attention a Claude app turn that stopped on a blocked question leaves: the person's answer is
   * what resumes it. Raised once per wrap_up — a phone's `seen` clears it, and a poll that still
   * finds the same question does not put it back. `wrap` is a reading the caller already has.
   */
  private questionAttention(id: string, from: SessionState, to: SessionState, wrap?: TurnWrapUp | null): Attention | null {
    if (to !== "idle" || (from !== "running" && from !== "waiting")) return null;
    const found = wrap === undefined ? this.desktopWrapUp(id) : wrap;
    if (!found?.ask || !found.blocked || this.askedWrapUps.get(id) === found.key) return null;
    this.askedWrapUps.set(id, found.key);
    return { reason: "question", at: this.now() };
  }

  /** The person sent this session a message: the previous turn's status line is over, and a question
   * that turn left is answered by whatever they typed. The size stays, so the still-unchanged
   * transcript is not read again for a recap the person has already moved past. */
  private personMessage(id: string): void {
    this.askedWrapUps.delete(id);
    let changed = false;
    const cached = this.statuses.get(id);
    if (cached?.status) { this.statuses.set(id, { size: cached.size, status: "" }); changed = true; }
    if (this.attention.get(id)?.reason === "question") { this.attention.delete(id); this.saveListState(); changed = true; }
    if (changed) this.opts.onSessions();
  }

  /** What the pushes should say about an event: a Claude app turn that closed on a question pushes
   * the question instead of that it finished. */
  pushEvent(id: string, event: PushEvent): PushEvent {
    if (event.kind !== "result" || !this.records.get(id)?.desktopBridge) return event;
    const wrap = this.desktopWrapUp(id);
    return wrap?.ask ? { kind: "question", ask: wrap.ask, blocked: wrap.blocked } : event;
  }

  private learnWindow(model: string, window: number): void {
    const key = windowKey(model);
    if (!(window > 0) || this.windows.get(key) === window) return;
    this.windows.set(key, window);
    try { writeFileAtomic(this.windowsFile, JSON.stringify(Object.fromEntries(this.windows))); }
    catch (error) { (this.opts.log ?? console.error)(`[context windows] not saved: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /**
   * Alerts for Mac sessions the host is not tailing: a bridged record already pushes through its
   * own appended events, so this path is for the ones only the list knows. A turn that was running
   * and is now idle finished — on a question the Claude app's wrap_up left, which is what the push
   * says instead, or otherwise ok/failed as the transcript's result reports. A session that newly
   * waits for approval asks. The first sight of a session only seeds its state.
   */
  private pollMacAlerts(sessions: SessionSummary[]): void {
    if (!this.desktop) return;
    const seen = new Set<string>();
    for (const s of sessions) {
      if (s.origin !== "desktop" || this.records.has(s.id) || this.archived.has(s.id)) continue;
      seen.add(s.id);
      const permission = s.state === "waiting" || s.attention?.reason === "permission";
      const previous = this.macStates.get(s.id);
      this.macStates.set(s.id, { state: s.state, permission });
      if (!previous) continue;
      if (permission && !previous.permission) this.alert(s.id, { kind: "permission" });
      else if (previous.state === "running" && s.state === "idle") {
        const wrap = this.desktop.wrapUp(s.id);
        if (!wrap?.ask) this.alert(s.id, { kind: "result", ok: this.desktop.turnOutcome(s.id) ?? true });
        else {
          // A blocked question keeps the session on "someone must answer" until they do.
          const question = this.questionAttention(s.id, "running", "idle", wrap);
          if (question) { this.setAttention(s.id, question); this.opts.onSessions(); }
          this.alert(s.id, { kind: "question", ask: wrap.ask, blocked: wrap.blocked });
        }
      }
    }
    for (const id of this.macStates.keys()) if (!seen.has(id)) this.macStates.delete(id);
  }

  /** Hand an alert to the pushes, but only when the Mac is away: the person at the desk sees it already. */
  private alert(id: string, body: AlertBody): void {
    const { onAlert, away } = this.opts;
    if (!onAlert || !away) return;
    void away().then(awayNow => { if (awayNow) onAlert(id, body); })
      .catch(error => (this.opts.log ?? console.error)(`[alert] ${id}: ${error instanceof Error ? error.message : String(error)}`));
  }

  has(id: string): boolean { return !this.skippedRecords.has(id) && (this.records.has(id) || (this.desktop?.has(id) ?? false)); }

  /** Archive/unarchive: only a flag. Transcripts and files are never deleted, just hidden by default. */
  setArchived(id: string, archived: boolean): boolean {
    if (!this.has(id)) throw new Error("no such session");
    const changed = archived ? !this.archived.has(id) : this.archived.has(id);
    if (changed) { if (archived) this.archived.add(id); else this.archived.delete(id); this.saveListState(); this.opts.onSessions(); }
    return changed;
  }

  /** The phone is looking at this session: clear its attention — except a permission request, which
   * only clears when the approval is answered. Reports whether anything changed. */
  markSeen(id: string): boolean {
    const current = this.attention.get(id);
    if (!current || current.reason === "permission") return false;
    this.attention.delete(id);
    this.saveListState();
    this.opts.onSessions();
    return true;
  }

  /** "Mark unread": put the attention back, guessed from what the session is doing now. */
  markUnread(id: string): Attention {
    const s = this.list().find(x => x.id === id);
    if (!s) throw new Error("no such session");
    const reason: AttentionReason = s.pending > 0 || s.state === "waiting" ? "permission" : s.state === "error" ? "failed" : "finished";
    const attention: Attention = { reason, at: this.now() };
    this.setAttention(id, attention);
    this.opts.onSessions();
    return attention;
  }

  /** An approval was answered; a permission attention clears once nothing else is still open. */
  private clearPermissionAttention(id: string): void {
    if (this.attention.get(id)?.reason !== "permission") return;
    if (this.opts.permissions.pending(id).length > 0) return;
    this.attention.delete(id);
    this.saveListState();
    this.opts.onSessions();
  }

  /** The slash commands the phone offers after "/": a Mac session's from its Remote Control init (re-read
   * after five minutes), a host session's from its own init; otherwise the latest list seen anywhere. */
  async commands(id: string): Promise<string[]> {
    if (!this.has(id)) throw new Error("no such session");
    const cached = this.commandLists.get(id);
    const bridgeId = this.desktop?.liveProcess(this.records.get(id)?.sdkSessionId ?? id)?.bridgeSessionId;
    if (bridgeId && (!cached || this.now() - cached.at > 300_000)) {
      try {
        const list = await this.bridge.commands(bridgeId);
        if (list) { this.commandLists.set(id, { at: this.now(), list }); this.lastCommands = list; return list; }
      } catch (error) { (this.opts.log ?? console.error)(`[commands] ${error instanceof Error ? error.message : String(error)}`); }
    }
    return cached?.list ?? this.lastCommands;
  }

  private continueDesktop(id: string, clientMsgId: string, bridgeMode = false): SessionRecord {
    if (!this.desktop) throw new Error("no such session");
    const { summary: s, open } = this.desktop.continuation(id);
    if (open && !bridgeMode) throw new Error(DESKTOP_BLOCKED);
    const log = this.desktop.importInto(id, path.join(this.opts.dir, "sessions", id), this.now);
    // The app's registry records the folder the conversation runs in now; the transcript's first
    // line keeps the one it started in (a conversation moved folders, issue #82).
    const cwd = this.desktop.liveProcess(id)?.cwd ?? s.cwd;
    const r: SessionRecord = { id, sdkSessionId: id, cwd, model: s.model, effort: s.effort, title: s.title, createdAt: s.createdAt, updatedAt: this.now(), state: "stopped", createdBy: clientMsgId, contextWindow: null, desktopHandoff: "excluded" };
    if (bridgeMode) { r.desktopBridge = true; r.transcriptOffset = this.desktop.transcriptSize(id); }
    Object.assign(r, this.desktopModels.get(id));
    this.desktopModels.delete(id);
    this.logs.set(id, log);
    this.records.set(id, r);
    this.save();
    this.append(id, { kind: "notice", code: bridgeMode ? "desktop_bridge" : "desktop_resumed" });
    this.opts.onSessions();
    return r;
  }

  /** Includes accepted work whose running state is not recorded yet. */
  busy(): boolean {
    if (this.creating.size || this.sending.size || this.draining.size || this.handingOff.size) return true;
    for (const r of this.records.values()) if (BUSY.has(r.state)) return true;
    return false;
  }

  /** Reserve idle synchronously; deferred desktop/queue callbacks may not start another turn. */
  prepareRefresh(): boolean {
    if (this.shuttingDown || this.busy()) return false;
    this.shuttingDown = true;
    this.closeQueueWatch();
    return true;
  }

  summaryOf(id: string): SessionSummary | undefined {
    const r = this.records.get(id);
    if (r) return this.summary(r);
    // A Mac session the host is not tailing has no record: its push (onAlert) still needs a title.
    return this.desktop?.has(id) ? this.list().find(s => s.id === id) : undefined;
  }

  /** Only the encrypted native push path asks for private turn context. */
  async pushContext(id: string, event: PushEvent): Promise<PushContext> {
    const summary = this.summaryOf(id);
    const record = this.records.get(id);
    const context: PushContext = summary ? { title: summary.title === id ? "" : summary.title, cwd: summary.cwd } : {};
    if (event.kind === "result") {
      if (record) {
        // onEvent fires immediately after append, before a later turn can change this cursor.
        const log = this.log(id);
        const seq = "seq" in event && typeof event.seq === "number" ? event.seq : log.lastSeq;
        context.text = log.lastAssistantText(seq);
      } else Object.assign(context, this.desktop?.pushContext(id));
    }
    if (event.kind === "permission" && !("tool" in event)) {
      const bridgeId = this.desktop?.liveProcess(record?.sdkSessionId ?? id)?.bridgeSessionId;
      if (bridgeId) {
        const request = (await this.bridge.openRequests(bridgeId))?.[0];
        if (request) { context.tool = request.tool; context.summary = summarize(request.tool, request.input, summary?.cwd ?? ""); }
      }
    }
    return context;
  }

  private sessionControls(id: string): SessionControls {
    const r = this.records.get(id);
    const desktopId = r?.sdkSessionId ?? id;
    const process = this.desktop?.liveProcess(desktopId);
    const desktop = r?.desktopBridge || this.desktop?.isOpen(desktopId);
    const enabled = !desktop || !!process?.bridgeSessionId && !this.bridgeProblem && !this.bridges.get(id)?.failed;
    return { model: enabled, effort: enabled, permissionModes: enabled ? [...PERMISSION_MODES] : [] };
  }

  private summary(r: SessionRecord): SessionSummary {
    const log = this.log(r.id);
    const process = r.desktopBridge ? this.desktop?.liveProcess(r.sdkSessionId ?? r.id) : undefined;
    const state = process ? this.bridgeState(process) : r.desktopBridge ? "stopped" : r.state;
    // The transcript keeps tasks whose end was never recorded; only a process the registry calls
    // busy can have any running, so an idle one reports none.
    const working = process?.status === "busy" || process?.status === "shell";
    const taskList = working ? this.desktop?.backgroundTaskList(r.sdkSessionId ?? r.id) ?? [] : [];
    const turnStartedAt = working ? this.desktop?.turnStartedAt(r.sdkSessionId ?? r.id) ?? null : null;
    const plan = working ? this.desktop?.plan(r.sdkSessionId ?? r.id) ?? [] : [];
    // A desktop session's mode is the Claude app's; it lives in the transcript, not the record.
    const mode = r.confirmedSettings?.permissionMode ?? (r.desktopBridge ? this.desktop?.permissionMode(r.sdkSessionId ?? r.id) : (r.permissionMode ?? "auto"));
    const status = r.desktopBridge ? this.statusLine(r.id) : null;
    return { ...(r.desktopBridge ? { desktopBridge: true, tasks: taskList.length, taskList, turnStartedAt, plan, ...(process ? { background: this.background(process) } : {}) } : {}), origin: "host", readOnly: false, controls: this.sessionControls(r.id), id: r.id, title: r.title, cwd: r.cwd, model: r.model, effort: r.effort, ...(mode ? { permissionMode: mode } : {}), ...(status ? { status } : {}), state, pending: this.opts.permissions.pending(r.id).length, ...this.sendQueue.summary(r.id), ...(this.archived.has(r.id) ? { archived: true } : {}), attention: this.attention.get(r.id) ?? null, createdAt: r.createdAt, updatedAt: r.updatedAt, lastSeq: log.lastSeq, epoch: log.epoch };
  }

  log(id: string): EventLog {
    if (this.skippedRecords.has(id)) throw new Error("Session log is unreadable; session skipped during recovery");
    if (!this.records.has(id)) {
      const process = this.desktop?.liveProcess(id);
      if (process?.bridgeSessionId && this.desktop?.has(id)) {
        this.continueDesktop(id, "", true);
        this.ensureBridge(id, process.bridgeSessionId);
        return this.logs.get(id)!;
      }
      if (this.desktop?.has(id)) return this.desktop.log(id);
      throw new Error("no such session");
    }
    let log = this.logs.get(id);
    if (!log) { log = EventLog.open({ dir: path.join(this.opts.dir, "sessions", id), now: this.now }); this.logs.set(id, log); }
    return log;
  }

  subLog(id: string, sub: string): EventLog | null {
    if (!/^sub-[\w-]{1,80}$/.test(sub)) return null;
    const record = this.records.get(id);
    // A Mac (Claude app) session's worker log lives beside its transcript, not under the host's dir.
    // Only a session the host itself drives (a resumed record) keeps the host's own sub log, so a
    // live SDK worker is written and read in the same place.
    const desktopId = record?.sdkSessionId ?? id;
    if ((!record || record.desktopBridge) && this.desktop?.has(desktopId)) return this.desktop.subLog(desktopId, sub);
    if (!this.records.has(id)) return null;
    const key = `${id}/${sub}`;
    let log = this.logs.get(key);
    if (!log) { log = EventLog.open({ dir: path.join(this.opts.dir, "sessions", id, sub), now: this.now }); this.logs.set(key, log); }
    return log;
  }

  /** The wire's blob operation is scoped to one session, including its workers and editing draft. */
  blob(id: string, blob: string): string | null {
    const data = this.log(id).blob(blob);
    if (data !== null) return data;
    const desktopId = this.records.get(id)?.sdkSessionId ?? id;
    return this.desktop?.workerBlob(desktopId, blob) ?? this.sendQueue.editingBlob(id, blob);
  }

  recentSources(): { path: string; lastUsed: number; model: string }[] {
    return Array.from(this.records.values()).map((r) => ({ path: r.cwd, lastUsed: r.updatedAt, model: r.model }));
  }

  private save(): void {
    writeFileAtomic(this.file, JSON.stringify([...this.records.values(), ...this.skippedRecords.values()], null, 1));
  }

  private saveListState(): void {
    writeFileAtomic(this.listFile, JSON.stringify({ attention: Object.fromEntries(this.attention), archived: [...this.archived] } satisfies ListState));
  }

  /** Set/clear a session's attention, persisting only when it actually changed. */
  private setAttention(id: string, next: Attention | null): void {
    const current = this.attention.get(id) ?? null;
    if (current?.reason === next?.reason && current?.at === next?.at) return;
    if (next) this.attention.set(id, next); else this.attention.delete(id);
    this.saveListState();
  }

  /** `touch` false: the host noticing a session is no longer live is not the session being used (a restart moved every old one to "now"). */
  private append(id: string, body: EventBody, touch = true): SessionEvent {
    const event = this.log(id).append(body);
    const r = this.records.get(id);
    if (r && touch) r.updatedAt = this.now();
    this.opts.onEvent(id, event);
    return event;
  }

  private setState(r: SessionRecord, state: SessionState, detail?: string, touch = true): void {
    if (r.state === state && !detail) return;
    const from = r.state;
    r.state = state;
    // A bridged session's turn can end on a question the person must answer; that outranks "finished".
    const question = r.desktopBridge ? this.questionAttention(r.id, from, state) : null;
    this.setAttention(r.id, question ?? nextAttention(this.attention.get(r.id) ?? null, from, state, this.now()));
    this.append(r.id, { kind: "state", state, ...(detail ? { detail } : {}) }, touch);
    this.save();
    this.opts.onSessions();
    if (!BUSY.has(state) && this.sendQueue.items(r.id).length) setImmediate(() => void this.drainQueue(r.id));
  }

  // ---- the queue: messages a phone left for when the turn ends (queue.ts) ---------------------

  /** Queue a message; a session that is not busy takes it at once. */
  enqueue(id: string, clientMsgId: string, text: string, attachments: Attachment[] = []): void {
    if (!this.has(id)) throw new Error("no such session");
    if (!/^[\w-]{1,100}$/.test(clientMsgId)) throw new Error("Invalid message id.");
    if (typeof text !== "string" || (!text.trim() && !attachments.length)) throw new Error("Nothing to queue.");
    if (!Array.isArray(attachments) || attachments.length > ATTACHMENT_COUNT) throw new Error(`At most ${ATTACHMENT_COUNT} attachments.`);
    // The bytes are copied out of the session's blobs now: a desktop rebase deletes those.
    const files = attachments.map(a => {
      const data = a && typeof a.blob === "string" ? this.blob(id, a.blob) : null;
      if (!data || typeof a.name !== "string" || typeof a.mediaType !== "string") throw new Error("Attachment missing or too large (8 MB limit).");
      return { name: a.name, mediaType: a.mediaType, data };
    });
    if (!this.sendQueue.add(id, { id: clientMsgId, text, attachments: files }, this.now(), this.records.get(id)?.sdkSessionId ?? id)) return;
    this.watchQueueRegistry();
    this.opts.onSessions();
    void this.drainQueue(id);
  }

  /** Take text and upload-shaped attachments back to the composer's editing draft. */
  removeQueued(id: string, itemId: string): { text: string; attachments: Attachment[] } | null {
    const item = this.sendQueue.items(id).find(item => item.id === itemId);
    if (!item) return null;
    const attachments = this.restoreQueuedAttachments(id, item);
    this.sendQueue.remove(id, itemId, attachments);
    this.opts.onSessions();
    return { text: item.text, attachments };
  }

  private restoreQueuedAttachments(id: string, item: QueueItem): Attachment[] {
    return item.attachments.map(a => {
      const data = this.sendQueue.data(a);
      if (data === null) throw new Error("Attachment missing.");
      return { blob: this.log(id).image(data), name: a.name, mediaType: a.mediaType };
    });
  }

  /** Send one queued message now, into the running turn like a steer. */
  async sendQueued(id: string, itemId: string): Promise<string> {
    const item = this.sendQueue.items(id).find(queued => queued.id === itemId);
    if (!item) throw new Error("That message is no longer queued.");
    this.sendQueue.resume(id);
    return this.dispatchQueued(id, item, false);
  }

  resumeQueue(id: string): void {
    if (this.sendQueue.resume(id)) { this.opts.onSessions(); void this.drainQueue(id); }
  }

  /** The phone's Stop: what is queued waits for the person instead of going on its own. */
  holdQueue(id: string): void {
    if (this.sendQueue.hold(id)) this.opts.onSessions();
  }

  private draining = new Set<string>();
  /** Every session with something queued, from the desktop poll: Mac sessions change state without a record. */
  drainQueues(): void {
    for (const id of this.sendQueue.sessions()) void this.drainQueue(id);
  }

  /** A cheap queue-only tick: registry idle wins over a stale Remote Control state cache. */
  pollQueued(): void {
    if (this.shuttingDown) return;
    const ids = this.sendQueue.sessions();
    if (!ids.length) { this.closeQueueWatch(); return; }
    this.watchQueueRegistry();
    for (const id of ids) {
      if (this.sendQueue.held(id) || this.draining.has(id)) continue;
      const r = this.records.get(id);
      if (r && !r.desktopBridge) { void this.drainQueue(id); continue; }
      const process = this.desktop?.liveProcess(r?.sdkSessionId ?? id);
      if (process?.status === "idle") void this.drainQueue(id, true);
    }
  }

  private queueWatch: (() => void) | null = null;
  private queueWatchAttempted = false;
  private queueWatchTimer: ReturnType<typeof setTimeout> | null = null;

  private watchQueueRegistry(): void {
    if (!this.desktop || this.queueWatchAttempted || this.shuttingDown) return;
    this.queueWatchAttempted = true;
    this.queueWatch = this.desktop.watchRegistry(() => {
      if (this.shuttingDown || this.queueWatchTimer) return;
      this.queueWatchTimer = setTimeout(() => { this.queueWatchTimer = null; this.pollQueued(); }, 25);
    }, error => (this.opts.log ?? console.error)(`[queue registry watch] ${String(error)}; one-second polling continues`));
  }

  private closeQueueWatch(): void {
    this.queueWatch?.();
    this.queueWatch = null;
    this.queueWatchAttempted = false;
    if (this.queueWatchTimer) clearTimeout(this.queueWatchTimer);
    this.queueWatchTimer = null;
  }

  private async drainQueue(id: string, registryIdle = false): Promise<void> {
    if (this.shuttingDown || this.draining.has(id) || this.sendQueue.held(id)) return;
    const head = this.sendQueue.items(id)[0];
    if (!head) return;
    if (!registryIdle) {
      const summary = this.has(id) ? this.summaryOf(id) : undefined;
      if (!summary || BUSY.has(summary.state)) return;
    }
    const awaiting = this.sendQueue.awaiting(id);
    if (awaiting && !this.sendQueue.settle(id, this.eventsAfter(id, awaiting.seq), this.now())) return;
    this.draining.add(id);
    try { await this.dispatchQueued(id, head, true); }
    catch { /* recorded on the item by dispatchQueued */ }
    finally { this.draining.delete(id); }
  }

  private eventsAfter(id: string, seq: number): SessionEvent[] {
    const out: SessionEvent[] = [];
    try {
      const log = this.log(id);
      for (let after = seq; after < log.lastSeq;) {
        const page = log.readAfter(after);
        out.push(...page.events);
        if (!page.more || !page.events.length) break;
        after = page.events[page.events.length - 1]!.seq;
      }
    } catch { /* a session with no log yet has nothing after */ }
    return out;
  }

  private async dispatchQueued(id: string, item: QueueItem, fromQueue: boolean): Promise<string> {
    const attachments: Attachment[] = [];
    for (const a of item.attachments) {
      const data = this.sendQueue.data(a);
      if (!data) { this.sendQueue.fail(id, item.id, "Attachment missing."); this.opts.onSessions(); throw new Error("Attachment missing."); }
      attachments.push({ blob: this.log(id).image(data), name: a.name, mediaType: a.mediaType });
    }
    let before = 0;
    try { before = this.log(id).lastSeq; } catch { /* the send below creates it */ }
    try {
      const sent = await this.send(id, item.id, item.text, attachments, "steer");
      this.sendQueue.remove(id, item.id);
      // Only a message sent from here waits for its own turn; one sent now rides the running turn.
      if (fromQueue) this.sendQueue.sent(id, before, this.now());
      this.opts.onSessions();
      return sent;
    } catch (error) {
      this.sendQueue.fail(id, item.id, error instanceof Error ? error.message : String(error));
      this.opts.onSessions();
      throw error;
    }
  }

  // ---- what the phone asks for --------------------------------------------------------------

  /** Idempotent on clientMsgId: a phone that resends after a dropped ack gets the same session.
   * A resend that finds a pending receipt left from before a host restart throws
   * OutcomeUnknownError instead of running again: the first attempt may or may not have run. */
  create(req: { clientMsgId: string; cwd: string; model: string; effort: Effort | null; text: string; permissionMode?: PermissionMode; isolation?: Isolation; baseBranch?: string }): Promise<string> {
    for (const r of this.records.values()) if (r.createdBy === req.clientMsgId) return Promise.resolve(r.id);
    const key = `create:${req.clientMsgId}`;
    if (this.receipts.status(key) === "completed") {
      const session = this.receipts.sessionOf(key);
      if (session && this.records.has(session)) return Promise.resolve(session);
      if (session) return Promise.resolve(session);
    }
    if (this.receipts.status(key) === "pending") {
      // A resend can arrive while the first create is still checking the folder; both get the one session.
      const riding = this.creating.get(req.clientMsgId);
      if (riding) return riding;
      throw new OutcomeUnknownError();
    }
    this.receipts.begin(key, "");
    // A resend can arrive while the first create is still checking the folder; both get the one session.
    let pending = this.creating.get(req.clientMsgId);
    if (!pending) {
      pending = this.createNew(req).then(
        id => { this.receipts.complete(key, id); return id; },
        (error: unknown) => { this.receipts.abandon(key); throw error; },
      ).finally(() => this.creating.delete(req.clientMsgId));
      this.creating.set(req.clientMsgId, pending);
    }
    return pending;
  }

  private async createNew(req: { clientMsgId: string; cwd: string; model: string; effort: Effort | null; text: string; permissionMode?: PermissionMode; isolation?: Isolation; baseBranch?: string }): Promise<string> {
    const mode = req.permissionMode ?? "auto";
    if (!PERMISSION_MODES.includes(mode)) throw new Error("invalid permission mode");
    const isolation = req.isolation ?? "local";
    if (isolation !== "local" && isolation !== "worktree") throw new Error("invalid isolation");
    // Read first, so a folder macOS guards says so now rather than holding the session at "starting".
    await macConsent(path.resolve(req.cwd), () => readableFolder(path.resolve(req.cwd)));
    // A worktree session runs in a fresh branch under the repo's parent; the picked folder itself is
    // never modified. The host validates everything (worktree.ts), refusing a folder that is not a repo.
    const cwd = isolation === "worktree"
      ? (await createWorktree({ cwd: path.resolve(req.cwd), text: req.text, ...(req.baseBranch ? { baseBranch: req.baseBranch } : {}), now: this.now })).dir
      : path.resolve(req.cwd);
    if (!(await isDirectory(cwd))) throw new Error(`not a folder: ${cwd}`);
    const now = this.now();
    const r: SessionRecord = { id: randomUUID(), sdkSessionId: null, cwd, model: req.model, effort: req.effort, permissionMode: mode, title: oneLine(req.text, 80), createdAt: now, updatedAt: now, state: "starting", createdBy: req.clientMsgId, contextWindow: null, desktopHandoff: "pending" };
    this.records.set(r.id, r);
    this.save();
    this.append(r.id, { kind: "state", state: "starting" });
    if (req.text.trim()) await this.send(r.id, req.clientMsgId, req.text);
    else this.setState(r, "idle");
    this.opts.onSessions();
    return r.id;
  }

  /** Idempotent on clientMsgId. Starts (or resumes) the query when none is live.
   * The receipt is written pending before the input reaches the SDK and completed once the SDK
   * has accepted it; a resend of a completed id returns without running again, and a resend that
   * finds a pending receipt from before a host restart throws OutcomeUnknownError. */
  send(id: string, clientMsgId: string, text: string, attachments: Attachment[] = [], behavior: SendBehavior = "steer"): string | Promise<string> {
    if (behavior !== "steer" && behavior !== "interrupt") throw new Error("Invalid send behavior.");
    const key = `send:${id}:${clientMsgId}`;
    if (this.receipts.status(key) === "completed") return id;
    if (this.receipts.status(key) === "pending") {
      const riding = this.sending.get(key) ?? this.bridgeSends.get(`${id}/${clientMsgId}`);
      if (riding) return riding;
      throw new OutcomeUnknownError();
    }
    if (this.seen(id, clientMsgId)) return id;
    // Delegated turns own their own receipts; this wrapper only forwards them.
    if (/^\/(clear|new)\s*$/.test(text) && !attachments.length) {
      const s = this.list().find(s => s.id === id);
      if (!s) throw new Error("no such session");
      return this.create({ clientMsgId, cwd: s.cwd, model: s.model, effort: s.effort, permissionMode: s.permissionMode ?? "auto", text: "" });
    }
    // The composer's /exit archives the session (phase 2): a flag, not a close — nothing is deleted.
    if (/^\/exit\s*$/.test(text)) { this.setArchived(id, true); return id; }
    if (behavior === "interrupt") return this.interrupt(id).then(() => this.send(id, clientMsgId, text, attachments, "steer"));
    this.receipts.begin(key, id);
    try {
      return this.trackReceipt(key, this.sendAccepted(id, clientMsgId, text, attachments));
    } catch (error) {
      this.receipts.abandon(key);
      throw error;
    }
  }

  /** Complete the receipt once the SDK accepted the input; abandon it when the attempt never got there. */
  private trackReceipt(key: string, work: string | Promise<string>): string | Promise<string> {
    if (typeof work === "string") { this.receipts.complete(key); return work; }
    const tracked = work.then(
      session => { this.receipts.complete(key, session); return session; },
      (error: unknown) => { this.receipts.abandon(key); throw error; },
    );
    this.sending.set(key, tracked);
    void tracked.finally(() => { if (this.sending.get(key) === tracked) this.sending.delete(key); }).catch(() => {});
    return tracked;
  }

  private sendAccepted(id: string, clientMsgId: string, text: string, attachments: Attachment[]): string | Promise<string> {
    const existing = this.records.get(id);
    const desktopId = existing?.sdkSessionId ?? id;
    if (this.desktop && !this.live.has(id) && !this.handingOff.has(id) && (existing?.sdkSessionId || this.desktop.has(id))) {
      const process = this.desktop.liveProcess(desktopId);
      if (process?.bridgeSessionId) {
        const key = `${id}/${clientMsgId}`;
        const pending = this.bridgeSends.get(key);
        if (pending) return pending;
        const sending = this.sendBridge(id, clientMsgId, text, attachments, process.bridgeSessionId).finally(() => this.bridgeSends.delete(key));
        this.bridgeSends.set(key, sending);
        return sending;
      }
      if (process || this.desktop.isOpen(desktopId)) throw new Error(DESKTOP_BLOCKED);
      if (existing?.desktopBridge) { this.closeBridge(id); existing.desktopBridge = false; this.save(); }
    }
    const r = this.records.get(id) ?? this.continueDesktop(id, clientMsgId);
    id = r.id;
    if (this.seen(id, clientMsgId)) return id;
    this.personMessage(id);
    const converted = attachmentContent(r.cwd, text, attachments, blob => this.blob(id, blob), data => this.log(id).image(data));
    this.opts.permissions.denySession(id, "superseded by a new message from the user");
    this.append(id, { kind: "user", text, clientMsgId, images: converted.images });
    this.rememberClientMsgId(id, clientMsgId);
    let live = this.live.get(id);
    const handoff = this.handingOff.get(id);
    if (!live && !handoff) live = this.start(r);
    // A message sent while a turn runs is queued by the CLI and starts no turn of its own yet.
    if (r.state !== "running" && r.state !== "waiting") {
      if (live) live.turnStart = this.now();
      this.append(id, { kind: "turn", model: r.model, effort: r.effort });
      this.setState(r, "running");
    }
    const message: SdkUserMessage = { type: "user", uuid: uuidFrom(clientMsgId), message: { role: "user", content: converted.content }, parent_tool_use_id: null, session_id: r.sdkSessionId ?? "", origin: { kind: "human" } };
    if (handoff) handoff.messages.push(message);
    else if (live) { live.pendingMessages.push(message); live.input.push(message); }
    this.sendQueue.releaseEditing(id);
    return id;
  }

  private async sendBridge(id: string, clientMsgId: string, text: string, attachments: Attachment[], bridgeId: string): Promise<string> {
    if (attachments.some(a => !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(a?.mediaType))) {
      throw new Error("Only photos can be attached to Claude app sessions for now.");
    }
    const r = this.records.get(id) ?? this.continueDesktop(id, clientMsgId, true);
    // Rebase deletes this log's blobs too: validate and retain the bytes before it can run.
    const converted = attachmentContent(r.cwd, text, attachments, blob => this.blob(id, blob), data => this.log(id).image(data));
    if (Array.isArray(converted.content)) {
      const blocks = converted.content;
      const images = blocks.filter(block => block.type === "image");
      if (images.reduce((size, block) => size + block.source.data.length, 0) > ATTACHMENT_COUNT * ATTACHMENT_CAP) {
        throw new Error("Photo payload is too large.");
      }
      converted.content = [...images, ...blocks.filter(block => block.type === "text")];
    }
    if (!r.desktopBridge) this.rebaseDesktop(r);
    if (this.seen(id, clientMsgId)) return id;
    this.personMessage(id);
    // Re-store in the current epoch; the local event must never point at deleted upload blobs.
    if (Array.isArray(converted.content)) {
      let index = 0;
      for (const block of converted.content) {
        if (block.type === "image") converted.images[index++]!.blob = this.log(id).image(block.source.data);
      }
    }
    const prior = this.bridges.get(id);
    if (prior?.bridgeId === bridgeId && prior.permissions.size) this.supersedeBridge(id, prior);
    // The stream only carries permission prompts; sending does not depend on it.
    this.ensureBridge(id, bridgeId);
    // The API takes only a UUID; phones send short random ids. Derived, not random, so a retry of
    // the same message is the same event; the transcript echoes it under this uuid.
    const uuid = UUID_RE.test(clientMsgId) ? clientMsgId : uuidFrom(clientMsgId);
    while (this.bridgeEchoes.size >= Sessions.ECHO_CAP) this.bridgeEchoes.delete(this.bridgeEchoes.values().next().value!);
    this.bridgeEchoes.add(uuid);
    try { await this.bridge.send(bridgeId, uuid, converted.content); }
    catch (error) {
      this.noteBridge(bridgeId, error, "bridge send");
      throw new Error(error instanceof Error ? error.message : DESKTOP_BLOCKED);
    }
    this.noteBridge(bridgeId, null);
    this.bridgeRunning.set(bridgeId, this.now());
    // The durable user event also deduplicates the desktop transcript's echo by uuid.
    this.append(id, { kind: "user", text, clientMsgId, images: converted.images });
    this.rememberClientMsgId(id, clientMsgId);
    // A new turn event and running event reset the phone's clock even if the previous record
    // was still running. Never synthesize idle between them: that also flashes a finished turn.
    this.append(id, { kind: "turn", model: r.model, effort: r.effort });
    if (r.state === "running") this.append(id, { kind: "state", state: "running" });
    else this.setState(r, "running");
    this.opts.onSessions();
    this.sendQueue.releaseEditing(id);
    return id;
  }

  /**
   * A record the host once drove (resume) becomes a Remote Control one: its log stops where the
   * host stopped, so it is rebuilt from the transcript instead of tailing from "now" and
   * skipping everything the desktop app said in between. The new epoch makes phones refetch.
   */
  private rebaseDesktop(r: SessionRecord): void {
    if (!this.desktop) return;
    const dir = path.join(this.opts.dir, "sessions", r.id);
    this.logs.get(r.id)?.close();
    this.logs.delete(r.id);
    // The log is rebuilt from the transcript: ids the old log held may be gone, so the
    // duplicate index must not claim them as seen or a resend would be dropped unsent.
    this.seenIds.delete(r.id);
    fs.rmSync(dir, { recursive: true, force: true });
    this.logs.set(r.id, this.desktop.importInto(r.sdkSessionId ?? r.id, dir, this.now));
    for (const outcome of this.settings.replay(r.id)) this.append(r.id, { kind: "settings", ...outcome });
    r.desktopBridge = true;
    r.transcriptOffset = this.desktop.transcriptSize(r.sdkSessionId ?? r.id);
    this.save();
    this.opts.onSessions();
  }

  /**
   * A rename on the Mac lands in the transcript as a custom-title line, and a conversation moved to
   * another folder updates the app's registry rather than the transcript's first line. The session
   * list, pushes and relative paths read the record, so refresh both when they change. Read-only:
   * never writes the transcript, and a failed read only logs.
   */
  private refreshBridgeMeta(r: SessionRecord): void {
    if (!this.desktop) return;
    try {
      const transcript = r.sdkSessionId ?? r.id;
      const cwd = this.desktop.liveProcess(transcript)?.cwd;
      if (cwd && cwd !== r.cwd) { r.cwd = cwd; this.save(); this.opts.onSessions(); }
      const size = this.desktop.transcriptSize(transcript);
      if (size === this.bridgeTitleSize.get(r.id)) return;
      this.bridgeTitleSize.set(r.id, size);
      const meta = this.desktop.metadataOf(transcript);
      if (meta && (meta.title !== r.title || meta.model && meta.model !== r.model)) {
        r.title = meta.title;
        if (meta.model && !r.confirmedSettings?.model) r.model = meta.model;
        this.save();
        this.opts.onSessions();
      }
    } catch (error) {
      (this.opts.log ?? console.error)(`[bridge meta] ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private ensureBridge(id: string, bridgeId: string) {
    const previous = this.bridges.get(id);
    // A failed stream is retried on the next poll or send rather than blocking the session for good.
    if (previous?.bridgeId === bridgeId && !previous.failed) { this.watchDesktop(id); return previous; }
    this.closeBridge(id, previous?.bridgeId === bridgeId);
    const connection = { bridgeId, abort: new AbortController(), failed: false, permissions: new Map<string, BridgePending>() };
    this.bridges.set(id, connection);
    const replay = (): void => {
      // After every stream (re)connect, re-read approvals already waiting: the stream starts at
      // the newest event, so anything requested before it connected would otherwise never card.
      void this.syncBridgeApprovals(id, bridgeId).catch(error => this.noteBridge(bridgeId, error, "bridge replay"));
    };
    void this.bridge.stream(bridgeId, connection.abort.signal, frame => this.bridgeFrame(id, frame), replay).catch(error => {
      if (!connection.abort.signal.aborted) this.bridgeFailure(id, error);
    });
    replay();
    this.watchDesktop(id);
    return connection;
  }

  private closeBridge(id: string, preserveRunning = false): void {
    this.unwatchDesktop(id);
    const connection = this.bridges.get(id);
    if (!connection) return;
    // A stream reconnect is still the same worker: durable replies may settle its writes later.
    // A replacement/removal cannot confirm the old worker's writes and must release its lane.
    if (!preserveRunning) {
      this.bridgeRunning.delete(connection.bridgeId);
      this.bridge.closeControls(connection.bridgeId);
    }
    connection.abort.abort();
    this.opts.permissions.expireSession(id, "aborted");
    this.bridges.delete(id);
    // With nothing pending, a permission attention would otherwise stick: markSeen skips it and
    // decide on an expired record returns false, so clear it the way answering does.
    this.clearPermissionAttention(id);
  }

  private bridgeFailure(id: string, error: unknown): void {
    const connection = this.bridges.get(id);
    if (connection) { connection.failed = true; connection.abort.abort(); }
    this.opts.permissions.expireSession(id, "aborted");
    this.clearPermissionAttention(id);
    // Logged, not shown: a dropped permission stream reconnects on the next poll and says nothing
    // new to the user — unless the login is the cause, which noteBridge tells phones once.
    this.noteBridge(connection?.bridgeId ?? id, error, "remote control stream");
  }

  private bridgeFrame(id: string, frame: BridgeFrame): void {
    if (frame.event !== "client_event") return;
    const payload = object(frame.data.payload);
    const connection = this.bridges.get(id);
    if (!payload || !connection) return;
    // Worker setting replies never settle approval cards; client echoes never apply settings.
    if (this.bridge.controlResponse(connection.bridgeId, frame.data.source, payload)) return;
    // Responses from another client close a pending card during replay or live delivery.
    if (payload.type === "control_response") {
      const response = object(payload.response);
      if (typeof response?.request_id !== "string") return;
      const pending = connection.permissions.get(response.request_id);
      if (pending) this.opts.permissions.expire(pending.id, "cancelled");
      connection.permissions.delete(response.request_id);
      this.rememberAnsweredBridge(id, response.request_id);
      return;
    }
    // Only the server's worker channel may ask for authorization or withdraw a request.
    if (frame.data.source !== "worker" || typeof payload.request_id !== "string") return;
    const requestId = payload.request_id;
    if (payload.type === "control_cancel_request") {
      const pending = connection.permissions.get(requestId);
      if (pending) this.opts.permissions.expire(pending.id, "cancelled");
      connection.permissions.delete(requestId);
      this.rememberAnsweredBridge(id, requestId);
      return;
    }
    const request = object(payload.request);
    const input = object(request?.input);
    if (payload.type !== "control_request" || request?.subtype !== "can_use_tool" || typeof request.tool_name !== "string" || !input || typeof request.tool_use_id !== "string" || connection.permissions.has(requestId)) return;
    const r = this.records.get(id);
    if (!r) return;
    this.openBridgePermission(id, connection, r, { requestId, tool: request.tool_name, input, toolUseId: request.tool_use_id,
      permissionSuggestions: request.permission_suggestions, suppressAlwaysAllowRule: permissionSuppression(request) });
  }

  /** A permission prompt from Remote Control, live or replayed: one record, one card, one decision. */
  private openBridgePermission(id: string, connection: { bridgeId: string; abort: AbortController; failed: boolean; permissions: Map<string, BridgePending> }, r: SessionRecord, req: BridgePermissionRequest): void {
    if (connection.permissions.has(req.requestId) || this.wasAnsweredBridge(id, req.requestId)) return;
    const { record, decision } = this.opts.permissions.request({ session: id, tool: req.tool, title: "", summary: summarize(req.tool, req.input, r.cwd), input: req.input }, connection.abort.signal);
    const rules = sessionPermissionRules(req.tool, req.permissionSuggestions, req.suppressAlwaysAllowRule);
    this.permissionRules.set(record.id, rules);
    connection.permissions.set(req.requestId, { id: record.id, input: req.input, toolUseId: req.toolUseId, rules });
    // Remote Control's can_use_tool carries the same input the host path gets, so a question or a
    // plan is carded as one here too (a JSON tool approval cannot answer either, issue #82).
    const card = bridgeRequest(req.tool, req.input);
    this.append(id, { kind: "permission", id: record.id, tool: record.tool, title: "", summary: record.summary, input: permissionDetail(record.tool, req.input, r.cwd), canAlways: rules.length > 0, ...(rules.length ? { alwaysAllow: { scope: "session" as const, summary: rules.flatMap(update => update.rules.map(rule => `${rule.toolName}(${rule.ruleContent})`)).join("\n") } } : {}), requestKind: card.requestKind, ...(card.questions ? { questions: card.questions } : {}) });
    this.setState(r, "waiting");
    void decision.then(answer => {
      // Shutdown expires every open request after its logs are closed; there is nobody left to read it.
      if (this.shuttingDown) return;
      this.append(id, { kind: "permission_decided", id: record.id, decision: answer.decision, ...(answer.decision === "allow_always" ? { ruleStatus: "sent" as const } : {}), ...(answer.reason ? { reason: answer.reason } : {}) });
      this.permissionRules.delete(record.id);
      if (answer.decision === "expired") connection.permissions.delete(req.requestId);
      this.clearPermissionAttention(id);
      this.opts.onSessions();
    });
  }

  /** Re-read approvals already waiting on a Mac session (phone attach and every stream
   * reconnect), so no approval card is missed. Reads the session's events from the start cursor
   * (BridgeClient.events, `sort_order=asc`) instead of the stream's newest-event cursor. */
  async syncBridge(id: string): Promise<void> {
    const bridgeId = this.bridges.get(id)?.bridgeId
      ?? this.desktop?.liveProcess(this.records.get(id)?.sdkSessionId ?? id)?.bridgeSessionId;
    if (!bridgeId) return;
    // A Mac session the host never opened has no record yet: import it (bridge mode) first.
    if (!this.records.has(id)) {
      try { this.log(id); } catch { return; }
    }
    this.ensureBridge(id, bridgeId);
    await this.syncBridgeApprovals(id, bridgeId);
  }

  private async syncBridgeApprovals(id: string, bridgeId: string): Promise<void> {
    const connection = this.bridges.get(id);
    const r = this.records.get(id);
    if (!connection || connection.bridgeId !== bridgeId || !r) return;
    // Cards opened after this read began may belong to a request the snapshot predates, so only
    // cards that already existed are closed on its word.
    const startedAt = this.now();
    let requests;
    try { requests = await this.bridge.requests(bridgeId); }
    catch (error) { this.bridgeFailure(id, error); return; }
    if (requests === null) return;
    if (this.bridges.get(id) !== connection) return;
    const { open, closed } = requests;
    // A card whose request this read saw answered or withdrawn was settled somewhere else — the
    // person used the Claude app. Leaving it pending kept a question on the phone that the app had
    // already closed, and the next replay carded it again (issue #82). A request merely missing from
    // the list proves nothing: the list may not reach it, and closing on that would take a live
    // question away from the phone.
    for (const [requestId, pending] of [...connection.permissions]) {
      if (!closed.has(requestId)) continue;
      const record = this.opts.permissions.get(pending.id);
      if (record?.state === "pending" && record.createdAt >= startedAt) continue;
      connection.permissions.delete(requestId);
      this.rememberAnsweredBridge(id, requestId);
      this.opts.permissions.expire(pending.id, "cancelled"); // its decision handler writes the event
    }
    for (const req of open) this.openBridgePermission(id, connection, r, req);
  }

  /**
   * Remember a bridge requestId as answered, so a replay that still lists it (the server records
   * the control_response after we do, or never records an answer made in the desktop app) skips it
   * instead of reviving an answered card. Bounded to the most recent ANSWERED_CAP entries; a
   * requestId is never reused, so an entry needs no other expiry.
   */
  private rememberAnsweredBridge(id: string, requestId: string): void {
    this.answeredBridge.set(`${id}/${requestId}`, this.now());
    while (this.answeredBridge.size > Sessions.ANSWERED_CAP) this.answeredBridge.delete(this.answeredBridge.keys().next().value!);
  }

  private wasAnsweredBridge(id: string, requestId: string): boolean {
    return this.answeredBridge.has(`${id}/${requestId}`);
  }

  /** Remember a phone message id so later resend checks hit memory instead of the log. Bounded. */
  private rememberClientMsgId(id: string, clientMsgId: string): void {
    let set = this.seenIds.get(id);
    if (!set) { set = new Set(); this.seenIds.set(id, set); }
    set.add(clientMsgId);
    while (set.size > Sessions.SEEN_INDEX_CAP) set.delete(set.values().next().value!);
  }

  private seen(id: string, clientMsgId: string): boolean {
    // Warm index (this process appended every user event in it): absence means absent, no scan.
    if (this.seenIds.get(id)?.has(clientMsgId)) return true;
    if (this.seenIds.has(id)) return false;
    // Cold index (after a restart): scan from the end, where a resend's original is, and warm
    // the index with the ids the scan passes over.
    const log = this.log(id);
    const collected: string[] = [];
    let before = log.lastSeq + 1;
    for (let pages = 0; pages < 8 && before > 1; pages++) {
      const page = log.before(before);
      for (const e of page.events) {
        if (e.kind !== "user" || !e.clientMsgId) continue;
        if (collected.length < Sessions.SEEN_INDEX_CAP) collected.push(e.clientMsgId);
        if (e.clientMsgId === clientMsgId) { this.rememberClientMsgId(id, clientMsgId); return true; }
      }
      if (!page.hasOlder || !page.events.length) break;
      before = page.events[0]!.seq;
    }
    this.seenIds.set(id, new Set(collected));
    return false;
  }

  decide(id: string, permId: string, decision: "allow" | "allow_always" | "deny", message?: string, answers?: Record<string, string>, reqId?: string): boolean | Promise<boolean> {
    // The CLI request id survives host/card recreation. Neither a new phone reqId nor a
    // new local permission id may repeat a write whose first outcome remains unknown.
    const localKey = `decide:${id}:${permId}`;
    if (this.receipts.status(localKey) === "completed") return reqId !== undefined;
    const connection = this.bridges.get(id);
    const request = connection && [...connection.permissions].find(([, value]) => value.id === permId);
    const key = request ? JSON.stringify(["decide_bridge", id, connection!.bridgeId, request[0]]) : localKey;
    if (this.receipts.status(key) === "completed") {
      this.opts.permissions.expire(permId, "cancelled");
      return reqId !== undefined;
    }
    if (this.receipts.status(key) === "pending") {
      const pending = this.bridgeDecisions.get(permId);
      if (pending) return pending;
      throw new OutcomeUnknownError();
    }
    const result = this.decideOnce(id, permId, decision, message, answers, key);
    return result;
  }

  private decideOnce(id: string, permId: string, decision: "allow" | "allow_always" | "deny", message: string | undefined, answers: Record<string, string> | undefined, key: string): boolean | Promise<boolean> {
    if (decision !== "allow" && decision !== "allow_always" && decision !== "deny") throw new Error("invalid decision");
    if (decision === "allow_always" && !this.permissionRules.get(permId)?.length) throw new Error("이 요청에는 안전한 세션 허용 규칙이 없습니다");
    const connection = this.bridges.get(id);
    const pending = connection && [...connection.permissions].find(([, value]) => value.id === permId);
    if (connection && pending) {
      const sending = this.bridgeDecisions.get(permId);
      if (sending) return sending;
      const answer = this.decideBridge(id, permId, decision, pending[0], pending[1], key, message, answers)
        .then(ok => {
          if (ok) { this.receipts.complete(key); this.receipts.complete(`decide:${id}:${permId}`, id); this.clearPermissionAttention(id); }
          else this.receipts.abandon(key);
          return ok;
        })
        .finally(() => this.bridgeDecisions.delete(permId));
      this.bridgeDecisions.set(permId, answer);
      return answer;
    }
    const p = this.opts.permissions.get(permId);
    if (!p || p.session !== id || p.state !== "pending") return false;
    if (p.tool === "ExitPlanMode" && decision !== "deny") return this.implementPlan(id, permId).then(ok => { if (ok) this.receipts.complete(key, id); return ok; });
    if (p.tool === "AskUserQuestion" && decision !== "deny") {
      const questions = questionInputs(object(p.input) ?? {});
      if (!answers || !questions.length || questions.some(q => typeof answers[q.question] !== "string" || !answers[q.question]!.trim())) throw new Error("Answer every question before submitting.");
      if (Object.values(answers).some(value => typeof value !== "string")) throw new Error("Invalid question answers.");
    }
    const decided = this.opts.permissions.decide(permId, decision, message, answers) !== null;
    if (decided) { this.receipts.complete(key, id); this.clearPermissionAttention(id); }
    return decided;
  }

  private planDecisions = new Map<string, Promise<boolean>>();

  private implementPlan(id: string, permId: string): Promise<boolean> {
    const pending = this.planDecisions.get(permId);
    if (pending) return pending;
    const change = this.scheduleModeChange(id, async () => {
      if (this.opts.permissions.get(permId)?.state !== "pending") return false;
      const r = this.records.get(id)!;
      const previousMode = r.permissionMode ?? "auto";
      const previousPrePlanMode = r.prePlanMode;
      await this.changeMode(id, r.prePlanMode === "bypassPermissions" || r.permissionMode === "bypassPermissions" ? "bypassPermissions" : "acceptEdits");
      let approved = false;
      try {
        approved = this.opts.permissions.decide(permId, "allow") !== null;
        if (approved) this.clearPermissionAttention(id);
        return approved;
      } finally {
        if (!approved) {
          // Cancellation/expiry or a failed durable decision can win during the SDK request.
          // Roll back in this lane before a later user mode change runs.
          await this.changeMode(id, previousMode);
          if (previousPrePlanMode === undefined) delete r.prePlanMode;
          else r.prePlanMode = previousPrePlanMode;
          this.save();
        }
      }
    });
    this.planDecisions.set(permId, change);
    void change.finally(() => this.planDecisions.delete(permId)).catch(() => {});
    return change;
  }

  /** The control_response the Remote Control side accepts for a permission answer (bridge-client.ts post). */
  private bridgeDecisionPayload(requestId: string, pending: { input: Record<string, unknown>; toolUseId: string }, decision: "allow" | "deny", message?: string, updatedInput: Record<string, unknown> = pending.input, rules?: ReturnType<typeof sessionPermissionRules>): Record<string, unknown> {
    return { type: "control_response", uuid: randomUUID(), response: { subtype: "success", request_id: requestId, response: { behavior: decision, updatedInput, toolUseID: pending.toolUseId, ...(rules?.length ? { updatedPermissions: rules } : {}), ...(message ? { message } : {}) } } };
  }

  private async decideBridge(id: string, permId: string, decision: "allow" | "allow_always" | "deny", requestId: string, pending: BridgePending, receiptKey: string, message?: string, answers?: Record<string, string>): Promise<boolean> {
    const connection = this.bridges.get(id);
    if (!connection || connection.failed || this.opts.permissions.get(permId)?.state !== "pending") return false;
    if (decision === "allow_always" && !pending.rules.length) throw new Error("이 요청에는 안전한 세션 허용 규칙이 없습니다");
    // The phone answers AskUserQuestion the way the host path does: every question filled in, and
    // the answers merged into the tool input the Remote Control side is told to run (#82).
    const record = this.opts.permissions.get(permId);
    let questions: Question[] | null = null;
    if (record?.tool === "AskUserQuestion" && decision !== "deny") {
      try { questions = questionInputs(object(record.input) ?? {}); } catch { questions = null; }
      if (questions) {
        if (!answers || !questions.length || questions.some(q => typeof answers[q.question] !== "string" || !answers[q.question]!.trim())) throw new Error("Answer every question before submitting.");
        if (Object.values(answers).some(value => typeof value !== "string")) throw new Error("Invalid question answers.");
      }
    }
    const updatedInput = answers ? { ...pending.input, answers } : pending.input;
    // A plan card's "keep planning" sends the person's feedback as the denial, as the host path does.
    const denial = message || "The user denied this from their phone.";
    this.receipts.begin(receiptKey, id);
    try {
      await this.bridge.post(connection.bridgeId, this.bridgeDecisionPayload(requestId, pending, decision === "deny" ? "deny" : "allow", decision === "deny" ? denial : undefined, updatedInput, decision === "allow_always" ? pending.rules : undefined));
    } catch (error) {
      this.bridgeFailure(id, error);
      if (bridgeWriteUnknown(error)) throw new OutcomeUnknownError();
      this.receipts.abandon(receiptKey);
      throw error;
    }
    connection.permissions.delete(requestId);
    this.rememberAnsweredBridge(id, requestId);
    return this.opts.permissions.decide(permId, decision, undefined, answers) !== null;
  }

  /**
   * A new message from the phone supersedes waiting Mac approvals, as host sessions do
   * (parity doc phase 1: "승인 대기 중에 새 메시지 → 대기 승인 거부"). Each open request gets
   * the deny control_response the Remote Control side accepts, and the local record resolves
   * denied the same way the host path's denySession resolves it.
   */
  private supersedeBridge(id: string, connection: { bridgeId: string; abort: AbortController; failed: boolean; permissions: Map<string, BridgePending> }): void {
    const reason = "superseded by a new message from the user";
    for (const [requestId, pending] of [...connection.permissions]) {
      connection.permissions.delete(requestId);
      this.rememberAnsweredBridge(id, requestId);
      void this.bridge.post(connection.bridgeId, this.bridgeDecisionPayload(requestId, pending, "deny", "The user superseded this with a new message."))
        .catch(error => this.bridgeFailure(id, error));
      this.opts.permissions.decide(pending.id, "deny", reason);
    }
    this.clearPermissionAttention(id);
  }

  async interrupt(id: string): Promise<void> {
    const bridgeId = this.desktop?.liveProcess(this.records.get(id)?.sdkSessionId ?? id)?.bridgeSessionId;
    if (!this.bridges.has(id) && bridgeId) { this.log(id); this.ensureBridge(id, bridgeId); }
    const connection = this.bridges.get(id);
    if (connection) {
      if (connection.failed) throw new Error(DESKTOP_BLOCKED);
      try { await this.bridge.interrupt(connection.bridgeId); }
      catch (error) { this.bridgeFailure(id, error); throw error; }
      this.append(id, { kind: "notice", code: "interrupted" });
      return;
    }
    const live = this.live.get(id);
    if (!live) return;
    // Open requests resolve as expired; their canUseTool continuation writes the event.
    this.opts.permissions.expireSession(id, "aborted");
    const r = this.records.get(id);
    // Only a running turn can be stopped; a flag set while idle would swallow the next real result.
    if (!r || (r.state !== "running" && r.state !== "waiting")) return;
    live.interrupted = true;
    live.input.close();
    const handoff = this.handingOff.get(id);
    if (handoff) handoff.messages = [];
    await live.ready;
    try { if (this.live.get(id) === live) await live.query.interrupt(); }
    finally {
      // A result may have retired this query and another send may already have started one.
      // A late interrupt completion owns only its original query, never the replacement.
      if (this.live.get(id) === live) {
        this.stop(id, live);
        this.setState(r, "idle");
      }
    }
    this.append(id, { kind: "notice", code: "interrupted" });
  }

  private modeChanges = new Map<string, Promise<unknown>>();

  setMode(id: string, mode: PermissionMode, reqId: string = randomUUID()): Promise<SettingsResult> {
    if (!this.has(id)) return Promise.reject(new Error("no such session"));
    return this.settings.run(id, reqId, JSON.stringify(["mode", mode]), "permissionMode", () => this.scheduleModeChange(id, async () => {
      await this.changeMode(id, mode);
      return { status: "applied", permissionMode: mode };
    }), result => { if (!this.shuttingDown) this.append(id, { kind: "settings", reqId, ...result }); });
  }

  /** Import the desktop log before controlling it, but never start or restart its worker. */
  private settingsBridge(id: string): string | null {
    if (this.shuttingDown) throw new OutcomeUnknownError();
    // Adoption waits for the SDK's accepted turns to finish (pollDesktop). A settings
    // change cannot rebase its log out from under that still-active transcript writer.
    if (this.live.has(id) || this.handingOff.has(id)) return null;
    const r = this.records.get(id);
    const desktopId = r?.sdkSessionId ?? id;
    const bridgeId = this.desktop?.liveProcess(desktopId)?.bridgeSessionId;
    if (bridgeId) {
      this.log(id);
      if (r && !r.desktopBridge) this.rebaseDesktop(r);
      this.ensureBridge(id, bridgeId);
      return bridgeId;
    }
    if (r?.desktopBridge || this.desktop?.isOpen(desktopId)) throw new Error(DESKTOP_BLOCKED);
    return null;
  }

  private scheduleModeChange<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.modeChanges.get(id) ?? Promise.resolve();
    const change = previous.catch(() => {}).then(work);
    this.modeChanges.set(id, change);
    void change.finally(() => { if (this.modeChanges.get(id) === change) this.modeChanges.delete(id); }).catch(() => {});
    return change;
  }

  private async changeMode(id: string, mode: PermissionMode): Promise<void> {
    if (!PERMISSION_MODES.includes(mode)) throw new Error("invalid permission mode");
    const bridgeId = this.settingsBridge(id);
    const r = this.records.get(id) ?? this.continueDesktop(id, "");
    if (bridgeId) {
      await this.bridge.control(bridgeId, randomUUID(), { subtype: "set_permission_mode", mode });
      if (this.shuttingDown) throw new OutcomeUnknownError();
      this.recordMode(r, mode);
      return;
    }
    const live = this.live.get(id);
    if (!live && mode === "bypassPermissions" && !(r.bypassAllowed ?? r.permissionMode === "bypassPermissions")) throw new Error("bypass_not_launched");
    if (live) {
      await live.ready;
      if (this.live.get(id) !== live) throw new Error("The session stopped before its mode changed. Try again.");
      await live.query.setPermissionMode(mode);
    }
    this.recordMode(r, mode);
  }

  private recordMode(r: SessionRecord, mode: PermissionMode): void {
    if (mode === "plan" && r.permissionMode !== "plan") r.prePlanMode = r.permissionMode ?? "auto";
    if (mode !== "plan") delete r.prePlanMode;
    r.bypassAllowed ??= r.permissionMode === "bypassPermissions";
    r.permissionMode = mode;
    r.confirmedSettings = { ...r.confirmedSettings, permissionMode: mode };
    this.save();
    this.append(r.id, { kind: "mode", mode });
    this.opts.onSessions();
  }

  setModel(id: string, model: string, effort: Effort | null, reqId: string = randomUUID()): Promise<SettingsResult> {
    if (!this.has(id)) return Promise.reject(new Error("no such session"));
    if (typeof model !== "string" || !model.trim() || model.length > 300 || /[@\s]/.test(model)) return Promise.reject(new Error("Invalid model"));
    if (effort !== null && !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)) return Promise.reject(new Error("Invalid effort"));
    return this.settings.run(id, reqId, JSON.stringify(["model", model, effort]), "model", () => this.scheduleModeChange(id, () => this.changeModel(id, model, effort)),
      result => { if (!this.shuttingDown) this.append(id, { kind: "settings", reqId, ...result }); });
  }

  private async changeModel(id: string, model: string, effort: Effort | null): Promise<SettingsResult> {
    const bridgeId = this.settingsBridge(id);
    const m = modelArg(model, effort);
    if (bridgeId) {
      const r = this.records.get(id)!;
      await this.bridge.control(bridgeId, randomUUID(), { subtype: "set_model", model: m.model });
      if (this.shuttingDown) throw new OutcomeUnknownError();
      r.model = model;
      r.confirmedSettings = { ...r.confirmedSettings, model };
      this.save();
      this.opts.onSessions();
      // Claude's effort is a distinct CLI setting, never a thinking-token budget. Routed
      // models carry it ONLY in modelArg, so there cannot be a second conflicting setting.
      if (isClaudeModel(model)) {
        try { await this.bridge.control(bridgeId, randomUUID(), { subtype: "apply_flag_settings", settings: { effortLevel: effort } }); }
        catch (error) {
          if (error instanceof OutcomeUnknownError) throw error;
          return { status: "partial", model, errors: { effort: error instanceof Error ? error.message : String(error) } };
        }
      }
      if (this.shuttingDown) throw new OutcomeUnknownError();
      r.effort = effort;
      r.confirmedSettings = { ...r.confirmedSettings, effort };
      this.save();
      this.opts.onSessions();
      return { status: "applied", model, effort };
    }
    if (isClaudeModel(model) && effort !== null && m.effort === undefined) throw new Error("이 SDK 경로에서는 해당 Claude 추론 강도를 지원하지 않습니다");
    if (!this.records.has(id) && this.desktop?.has(id)) {
      this.desktopModels.set(id, { model, effort });
      this.opts.onSessions();
      return { status: "applied", model, effort };
    }
    const r = this.records.get(id);
    if (!r) throw new Error("no such session");
    const changedModel = r.model !== model;
    const changedEffort = r.effort !== effort;
    const live = this.live.get(id);
    if (live && (changedModel || changedEffort && !isClaudeModel(model))) {
      await live.ready;
      if (this.live.get(id) !== live) throw new Error("The session stopped before its model changed. Try again.");
      await live.query.setModel(m.model);
    }
    r.model = model;
    r.effort = effort;
    this.save();
    this.append(id, { kind: "notice", code: "model_changed", text: effort ? `${model} · ${effort}` : model });
    if (live) {
      // Even when the model also changed, Claude's effort must reach a fresh SDK query.
      if ((changedModel || changedEffort) && isClaudeModel(model)) live.restartAfterTurn = true;
      if (live.restartAfterTurn && (r.state === "idle" || r.state === "error")) this.restartSettings(r, live);
    }
    this.opts.onSessions();
    return { status: "applied", model, effort };
  }

  stop(id: string, expected?: Live): void {
    const live = this.live.get(id);
    if (!live || (expected && live !== expected)) return;
    this.live.delete(id);
    live.input.close();
    live.abort.abort();
    try { live.query.close(); } catch { /* already ended */ }
  }

  shutdown(): void {
    this.shuttingDown = true;
    this.closeQueueWatch();
    for (const id of this.transcriptWatches.keys()) this.unwatchDesktop(id);
    this.bridgeRunning.clear();
    this.bridge.closeControls();
    for (const id of Array.from(this.live.keys())) this.stop(id);
    for (const id of this.bridges.keys()) this.closeBridge(id);
    for (const log of this.logs.values()) log.close();
    this.desktop?.close();
  }

  // ---- the query ----------------------------------------------------------------------------

  private start(r: SessionRecord): Live {
    if (r.sdkSessionId && this.desktop?.isOpen(r.sdkSessionId)) throw new Error(DESKTOP_BLOCKED);
    const abort = new AbortController();
    const input = new Inbox();
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    delete env.ANTHROPIC_BASE_URL;
    delete env.CLAUDECODE;
    const m = modelArg(r.model, r.effort);
    const options: Record<string, unknown> = {
      cwd: r.cwd,
      ...(!r.sdkSessionId ? { title: r.title } : {}),
      model: m.model,
      ...(m.effort ? { effort: m.effort } : {}),
      includePartialMessages: true,
      settingSources: ["user", "project", "local"],
      permissionMode: r.permissionMode ?? "auto",
      ...((r.bypassAllowed ?? r.permissionMode === "bypassPermissions") ? { allowDangerouslySkipPermissions: true } : {}),
      abortController: abort,
      env,
      canUseTool: this.canUseTool(r.id),
      stderr: (line: string) => { if (!line.includes("unrecognized_model")) process.stderr.write(`[session ${r.id.slice(0, 8)}] ${line}`); },
      ...(r.sdkSessionId ? { resume: r.sdkSessionId } : {}),
      ...(this.opts.claudePath ? { pathToClaudeCodeExecutable: this.opts.claudePath } : {}),
    };
    const live: Live = { query: null as unknown as SdkQuery, ready: Promise.resolve(), input, abort, buffer: null, flushTimer: null, current: null, subs: new Map(), turnStart: this.now(), restartAfterTurn: false, retried: false, interrupted: false, pendingMessages: [] };
    this.live.set(r.id, live);
    live.ready = this.opts.router.status().then((s) => {
      // The router's own word on where its proxy and CA are wins over whatever this process inherited.
      Object.assign(env, s.proxyEnv);
    }).finally(() => {
      if (this.live.get(r.id) !== live) return;
      live.query = this.opts.queryFn({ prompt: input, options });
      void this.consume(r, live);
    });
    return live;
  }

  private async consume(r: SessionRecord, live: Live): Promise<void> {
    let failure: string | null = null;
    try {
      for await (const msg of live.query) {
        if (this.live.get(r.id) !== live) break;
        this.handle(r, live, msg);
      }
    } catch (e) {
      if (!live.abort.signal.aborted) failure = (e as Error).message;
    }
    if (this.live.get(r.id) !== live) return;
    this.flush(r.id, live);
    this.live.delete(r.id);
    this.opts.permissions.expireSession(r.id, "aborted");
    if (failure) {
      const text = this.failureText(r.id, failure);
      this.append(r.id, { kind: "result", ok: false, error: text, ms: this.now() - live.turnStart, turns: 0 });
      this.setState(r, "error", text.slice(0, 300));
    } else if (r.state !== "idle" && r.state !== "error") this.setState(r, "stopped");
  }

  /**
   * The CLI's own words for "no login" become the host's, so a phone reads what to do about it.
   * The raw text stays in the host's own log line, where the exact CLI wording belongs.
   */
  private failureText(id: string, raw: string): string {
    if (!isCliNotLoggedIn(raw)) return raw;
    (this.opts.log ?? console.error)(`[session ${id.slice(0, 8)}] Claude Code CLI: ${raw.trim()}`);
    return CLI_NOT_LOGGED_IN;
  }

  private handle(r: SessionRecord, live: Live, msg: Record<string, unknown>): void {
    const parent = (msg.parent_tool_use_id as string | null | undefined) ?? null;
    switch (msg.type) {
      case "system": {
        const mode = PERMISSION_MODES.find(mode => mode === msg.permissionMode);
        if (!parent && mode && mode !== r.permissionMode && (msg.subtype === "init" || msg.subtype === "status")) this.recordMode(r, mode);
        if (msg.subtype === "init") {
          const list = slashCommands(msg);
          if (list) { this.commandLists.set(r.id, { at: this.now(), list }); this.lastCommands = list; }
        }
        if (msg.subtype === "init" && typeof msg.session_id === "string" && r.sdkSessionId !== msg.session_id) {
          r.sdkSessionId = msg.session_id;
          this.save();
          this.opts.onSessions();
        }
        if (msg.subtype === "api_retry" && !live.retried) { live.retried = true; this.append(r.id, { kind: "notice", code: "api_retry" }); }
        return;
      }
      case "stream_event": {
        if (parent) return;
        const ev = msg.event as { type?: string; index?: number; message?: { id?: string }; content_block?: { type?: string }; delta?: { type?: string; text?: string; thinking?: string } } | undefined;
        if (ev?.type === "message_start" && ev.message?.id) {
          this.flush(r.id, live);
          live.current = { msg: ev.message.id, text: "", tools: [], model: r.model, thinkingBlocks: [], nextThinkingBlock: 0 };
        } else if (ev?.type === "content_block_start" && ev.content_block?.type === "thinking" && live.current) {
          const index = ev.index ?? 0;
          if (!live.current.thinkingBlocks.includes(index)) live.current.thinkingBlocks.push(index);
        } else if (ev?.type === "content_block_delta" && live.current) {
          const thinking = ev.delta?.type === "thinking_delta" ? ev.delta.thinking : undefined;
          const text = ev.delta?.type === "text_delta" ? ev.delta.text : undefined;
          if (!thinking && !text) return;
          const block = ev.index ?? 0;
          if (thinking && !live.current.thinkingBlocks.includes(block)) live.current.thinkingBlocks.push(block);
          if (live.buffer && (text && live.buffer.thinking || thinking && (!live.buffer.thinking || live.buffer.thinking.block !== block))) this.flush(r.id, live);
          if (!live.buffer) live.buffer = { msg: live.current.msg, text: "" };
          if (thinking) {
            if (!live.buffer.thinking) live.buffer.thinking = { block, text: "" };
            live.buffer.thinking.text += thinking;
          } else if (text) live.buffer.text += text;
          if (!live.flushTimer) live.flushTimer = setTimeout(() => this.flush(r.id, live), this.opts.coalesceMs ?? 80);
        }
        return;
      }
      case "assistant": {
        const message = msg.message as { id?: string; model?: string; content?: { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: Record<string, unknown> }[] } | undefined;
        if (!message) return;
        if (parent) { this.subAssistant(r, live, parent, message); return; }
        this.flush(r.id, live);
        const id = message.id ?? randomUUID();
        if (!live.current || live.current.msg !== id) live.current = { msg: id, text: "", tools: [], model: message.model ?? r.model, thinkingBlocks: [], nextThinkingBlock: 0 };
        const cur = live.current;
        (message.content ?? []).forEach((block, index) => {
          if (block.type !== "thinking" || typeof block.thinking !== "string") return;
          // SDK assistant messages can contain just one completed block: local index 0
          // is not necessarily the block's index in the original stream.
          const streamedIndex = cur.thinkingBlocks[cur.nextThinkingBlock++] ?? index;
          this.append(r.id, { kind: "thinking", msg: id, block: streamedIndex, text: block.thinking });
        });
        const converted = messageContent(message.content, data => this.log(r.id).image(data), { cwd: r.cwd, ...(r.sdkSessionId ? { sessionId: r.sdkSessionId } : {}) });
        if (converted.text) cur.text += (cur.text ? "\n\n" : "") + converted.text;
        cur.images = [...(cur.images ?? []), ...converted.images];
        cur.files = [...(cur.files ?? []), ...converted.files];
        for (const b of message.content ?? []) {
          if (b.type === "tool_use" && b.id && b.name) {
            const input = b.input ?? {};
            const tool: ToolCall = { id: b.id, name: b.name, summary: summarize(b.name, input, r.cwd), input: JSON.stringify(input, null, 2), ...sessionFileTool(b.name, input, { cwd: r.cwd, ...(r.sdkSessionId ? { sessionId: r.sdkSessionId } : {}) }, data => this.log(r.id).image(data)) };
            cur.tools.push(tool);
            cur.images.push(...fileImages(tool.files ?? []));
            if (b.name === "Task" || b.name === "Agent") {
              const sub = { description: summarize(b.name, input, r.cwd), model: typeof input.model === "string" ? input.model : null, steps: 0 };
              live.subs.set(b.id, sub);
              this.append(r.id, { kind: "subagent", toolUseId: b.id, sub: `sub-${b.id}`, description: sub.description, model: sub.model, status: "running", steps: 0 });
            }
          }
        }
        if (message.model) cur.model = message.model;
        // Thinking-only SDK block completions must not reserve the answer's position
        // before subsequent thinking blocks have arrived.
        if (cur.text || cur.images.length || cur.files.length || cur.tools.length) this.append(r.id, { kind: "assistant", msg: cur.msg, model: cur.model, text: cur.text, images: cur.images, files: cur.files, tools: cur.tools });
        return;
      }
      case "user": {
        const message = msg.message as { content?: unknown } | undefined;
        const blocks = Array.isArray(message?.content) ? (message!.content as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]) : [];
        const converted = messageContent(message?.content, data => this.log(r.id).image(data), { cwd: r.cwd, ...(r.sdkSessionId ? { sessionId: r.sdkSessionId } : {}) });
        // SDK user echoes normally already have a phone event; retain attachment-bearing echoes only.
        if (converted.images.length || converted.files.length) {
          const body: EventBody = { kind: "user", ...converted, clientMsgId: typeof msg.uuid === "string" ? msg.uuid : randomUUID() };
          if (parent) this.subLog(r.id, `sub-${parent}`)?.append(body);
          else this.append(r.id, body);
        }
        for (const b of blocks) {
          if (b.type !== "tool_result" || !b.tool_use_id) continue;
          const body: EventBody = { kind: "tool_result", toolUseId: b.tool_use_id, ok: !b.is_error, ...messageContent(b.content, data => this.log(r.id).image(data), { cwd: r.cwd, ...(r.sdkSessionId ? { sessionId: r.sdkSessionId } : {}) }) };
          if (parent) { this.subLog(r.id, `sub-${parent}`)?.append(body); continue; }
          this.append(r.id, body);
          const sub = live.subs.get(b.tool_use_id);
          if (sub) {
            live.subs.delete(b.tool_use_id);
            this.append(r.id, { kind: "subagent", toolUseId: b.tool_use_id, sub: `sub-${b.tool_use_id}`, description: sub.description, model: sub.model, status: b.is_error ? "failed" : "done", steps: sub.steps });
          }
        }
        return;
      }
      case "result": {
        live.pendingMessages.shift();
        this.flush(r.id, live);
        live.current = null;
        live.retried = false;
        if (live.interrupted) {
          // The person pressed Stop; the "interrupted" notice already says so. A failed-turn line would not be true.
          this.stop(r.id, live);
          this.setState(r, "idle");
          return;
        }
        const ok = msg.subtype === "success" && msg.is_error !== true;
        const usage = msg.modelUsage as Record<string, { contextWindow?: number }> | undefined;
        const win = usage ? Object.values(usage).map((u) => u.contextWindow ?? 0).find((w) => w > 0) : undefined;
        if (win) r.contextWindow = win;
        for (const [model, u] of Object.entries(usage ?? {})) if (typeof u.contextWindow === "number") this.learnWindow(model, u.contextWindow);
        const error = ok ? undefined : this.failureText(r.id, String(msg.result ?? (Array.isArray(msg.errors) ? msg.errors.join("; ") : msg.subtype ?? "error"))).slice(0, 500);
        this.append(r.id, { kind: "result", ok, ...(error ? { error } : {}), ms: typeof msg.duration_ms === "number" ? msg.duration_ms : this.now() - live.turnStart, turns: typeof msg.num_turns === "number" ? msg.num_turns : 0 });
        if (live.restartAfterTurn) this.restartSettings(r, live);
        this.setState(r, live.pendingMessages.length > 0 ? "running" : ok ? "idle" : "error");
        if (live.pendingMessages.length === 0) this.handoff(r, live);
        void this.refreshFigures(r, true);
        return;
      }
      default:
        return;
    }
  }

  /** A settings restart shares the handoff inbox: preserve even prefetched accepted inputs,
   * and do not create another transcript writer until the old process has actually exited. */
  private restartSettings(r: SessionRecord, live: Live): void {
    const transfer = { messages: live.pendingMessages };
    this.handingOff.set(r.id, transfer);
    this.stop(r.id, live);
    void Promise.resolve(live.query.processExited).then(async () => {
      this.handingOff.delete(r.id);
      if (this.shuttingDown) return;
      if (transfer.messages.length) await this.resumeAfterHandoff(r, transfer.messages);
      else this.handoff(r, live);
    }).catch(error => {
      this.handingOff.delete(r.id);
      if (this.shuttingDown) return;
      const text = error instanceof Error ? error.message : String(error);
      this.append(r.id, { kind: "result", ok: false, error: text, ms: 0, turns: 0 });
      this.setState(r, "error", text);
    });
  }

  /** Shared with app-bridge adoption: never stop a query still owed an accepted turn. */
  private sdkIdle(r: SessionRecord, live = this.live.get(r.id)): boolean {
    return !this.handingOff.has(r.id) && !BUSY.has(r.state) && (!live || live.pendingMessages.length === 0);
  }

  private handoff(r: SessionRecord, live: Live): void {
    const runner = this.opts.handoff;
    if (!runner || !r.sdkSessionId || r.desktopBridge || !this.sdkIdle(r, live) || this.handingOff.has(r.id)) return;
    if (r.desktopHandoff !== "pending" && r.desktopHandoff !== "failed") return;
    if ((r.desktopHandoffAttempts ?? 0) >= 3) return;
    r.desktopHandoff = "attempted";
    r.desktopHandoffAttempts = (r.desktopHandoffAttempts ?? 0) + 1;
    this.save();
    const transfer = { messages: [] as SdkUserMessage[] };
    this.handingOff.set(r.id, transfer);
    // Reserve the send lane now, then let the SDK finish its result continuation.
    void new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      if (this.shuttingDown) { this.handingOff.delete(r.id); return; }
      try {
        this.stop(r.id, live);
        // close() and iterator completion alone do not prove the writer has stopped.
        // The SDK owns the graceful-exit/kill deadline; never launch another writer before exit.
        await live.query.processExited;
        if (this.shuttingDown || r.desktopBridge) return;
        const result = await runner({ sessionId: r.sdkSessionId!, title: r.title, cwd: r.cwd });
        delete r.desktopHandoffError;
        this.save();
        (this.opts.log ?? console.error)(`[desktop handoff ${r.id}] ${result}`);
      } catch (error) {
        r.desktopHandoff = "failed";
        r.desktopHandoffError = error instanceof Error ? error.message : String(error);
        this.save();
        (this.opts.log ?? console.error)(`[desktop handoff ${r.id}] failed: ${r.desktopHandoffError} (attempt ${r.desktopHandoffAttempts}/3)`);
      } finally {
        this.handingOff.delete(r.id);
        if (transfer.messages.length && !this.shuttingDown) await this.resumeAfterHandoff(r, transfer.messages);
      }
    });
  }

  private async resumeAfterHandoff(r: SessionRecord, messages: SdkUserMessage[]): Promise<void> {
    try {
      this.desktop?.poll();
      const bridgeId = this.desktop?.liveProcess(r.sdkSessionId!)?.bridgeSessionId;
      if (bridgeId) {
        // The app is now the writer. Use the existing send path, never resume a second SDK.
        if (!r.desktopBridge) this.rebaseDesktop(r);
        for (const message of messages) {
          const content = messageContent(message.message.content, data => this.log(r.id).image(data));
          await this.sendBridge(r.id, message.uuid!, content.text, content.images.map(image => ({ blob: image.blob!, name: "photo", mediaType: image.mediaType })), bridgeId);
        }
        return;
      }
      const writer = this.live.get(r.id) ?? this.start(r);
      writer.pendingMessages.push(...messages);
      for (const message of messages) writer.input.push(message);
    } catch (error) {
      // Accepted inputs must get a visible failure if the app is open but not reachable yet.
      const text = error instanceof Error ? error.message : String(error);
      (this.opts.log ?? console.error)(`[desktop handoff ${r.id}] queued input failed: ${text}`);
      this.append(r.id, { kind: "result", ok: false, error: text, ms: 0, turns: 0 });
      this.setState(r, "error", text);
    }
  }

  private subAssistant(r: SessionRecord, live: Live, parent: string, message: { id?: string; model?: string; content?: { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: Record<string, unknown> }[] }): void {
    const log = this.subLog(r.id, `sub-${parent}`);
    if (!log) return;
    (message.content ?? []).forEach((block, index) => {
      if (block.type === "thinking" && typeof block.thinking === "string") log.append({ kind: "thinking", msg: message.id ?? parent, block: index, text: block.thinking });
    });
    const converted = messageContent(message.content, data => this.log(r.id).image(data), { cwd: r.cwd, ...(r.sdkSessionId ? { sessionId: r.sdkSessionId } : {}) });
    const tools = (message.content ?? []).filter((b) => b.type === "tool_use" && b.id && b.name).map((b): ToolCall => ({ id: b.id!, name: b.name!, summary: summarize(b.name!, b.input ?? {}, r.cwd), input: JSON.stringify(b.input ?? {}, null, 2), ...sessionFileTool(b.name!, b.input ?? {}, { cwd: r.cwd, ...(r.sdkSessionId ? { sessionId: r.sdkSessionId } : {}) }, data => log.image(data)) }));
    converted.images.push(...fileImages(tools.flatMap(tool => tool.files ?? [])));
    log.append({ kind: "assistant", msg: message.id ?? randomUUID(), model: message.model ?? "", ...converted, tools });
    const sub = live.subs.get(parent);
    if (!sub) return;
    sub.steps++;
    // A named worker is spawned without a `model` argument, so its row had no model until it
    // finished; its first answer says which model ran it.
    if (message.model && sub.model !== message.model) {
      const first = sub.model === null;
      sub.model = message.model;
      if (first) this.append(r.id, { kind: "subagent", toolUseId: parent, sub: `sub-${parent}`, description: sub.description, model: sub.model, status: "running", steps: sub.steps });
    }
  }

  private flush(id: string, live: Live): void {
    if (live.flushTimer) { clearTimeout(live.flushTimer); live.flushTimer = null; }
    const b = live.buffer;
    live.buffer = null;
    if (b?.thinking?.text) this.append(id, { kind: "thinking", msg: b.msg, block: b.thinking.block, text: b.thinking.text, delta: true });
    if (b && b.text) this.append(id, { kind: "delta", msg: b.msg, text: b.text });
    const r = this.records.get(id);
    if (r && r.state === "running") void this.refreshFigures(r, false);
  }

  private canUseTool(id: string): CanUseTool {
    return async (tool, input, opts) => {
      const r = this.records.get(id)!;
      const live = this.live.get(id);
      if (live) this.flush(id, live);
      let detail = permissionDetail(tool, input, r.cwd);
      if (tool === "Write" && typeof input.file_path === "string") {
        // What the write replaces, when it is a readable file of a size worth showing on a phone; any
        // failure keeps the plain listing rather than failing the approval itself.
        try {
          const file = path.resolve(r.cwd, input.file_path);
          if ((await fs.promises.stat(file)).size <= 256 * 1024) {
            const before = await fs.promises.readFile(file, "utf8");
            detail = permissionDetail("Edit", { file_path: input.file_path, old_string: before, new_string: input.content }, r.cwd);
          }
        } catch { /* new file, unreadable or gone: the plain listing stands */ }
      }
      const questions = tool === "AskUserQuestion" ? questionInputs(input) : undefined;
      const { record, decision } = this.opts.permissions.request({ session: id, tool, title: opts.title ?? "", summary: summarize(tool, input, r.cwd), input }, opts.signal);
      const rules = sessionPermissionRules(tool, opts.suggestions, opts.suppressAlwaysAllowRule);
      this.permissionRules.set(record.id, rules);
      this.append(id, { kind: "permission", id: record.id, tool, title: opts.title ?? "", summary: record.summary, input: detail, canAlways: rules.length > 0, ...(rules.length ? { alwaysAllow: { scope: "session" as const, summary: rules.flatMap(update => update.rules.map(rule => `${rule.toolName}(${rule.ruleContent})`)).join("\n") } } : {}), requestKind: tool === "ExitPlanMode" ? "plan" : tool === "AskUserQuestion" ? "question" : "tool", ...(questions ? { questions } : {}) });
      this.setState(r, "waiting");
      const answer = await decision;
      this.append(id, { kind: "permission_decided", id: record.id, decision: answer.decision, ...(answer.decision === "allow_always" ? { ruleStatus: "sent" as const } : {}), ...(answer.reason ? { reason: answer.reason } : {}) });
      this.permissionRules.delete(record.id);
      if (this.live.has(id) && this.opts.permissions.pending(id).length === 0) this.setState(r, "running");
      else this.opts.onSessions();
      if (answer.decision === "allow") return { behavior: "allow", updatedInput: answer.answers ? { ...input, answers: answer.answers } : input };
      if (answer.decision === "allow_always") return { behavior: "allow", updatedInput: answer.answers ? { ...input, answers: answer.answers } : input, ...(rules.length ? { updatedPermissions: rules } : {}) };
      if (answer.decision === "deny") return { behavior: "deny", message: answer.reason ?? "The user denied this from their phone." };
      return { behavior: "deny", message: "This permission request expired before anyone answered.", interrupt: true };
    };
  }

  /** The mod's figures as events in the same log, so a phone that reconnects sees what it missed. Throttled to one read per 15 s while a turn runs. */
  private async refreshFigures(r: SessionRecord, force: boolean): Promise<void> {
    if (!r.sdkSessionId) return;
    await this.readFigures(r.id, r.sdkSessionId, r.model, r.contextWindow, force, false);
  }

  /**
   * One read of the router's records for a session, appended when it changed. `id` is the host's id
   * for it, `cliId` the id Claude Code sends the router (`X-Claude-Code-Session-Id`). A Mac session
   * has no window of its own, so the one learned for its model stands; none known stays null.
   * `mac`: a session the router has no record of yet (an old one, from before it started) says nothing.
   */
  private async readFigures(id: string, cliId: string, model: string, contextWindow: number | null, force: boolean, mac: boolean): Promise<void> {
    const last = this.figuresAt.get(id) ?? 0;
    if (!force && this.now() - last < 15_000) return;
    this.figuresAt.set(id, this.now());
    let figures: Figures;
    try { figures = await this.opts.router.figures(cliId, model, contextWindow ?? this.windows.get(windowKey(model)) ?? null); } catch { return; }
    if (mac && !figures.route && !figures.effort && !figures.workers.length) return;
    const { at: _at, ...rest } = figures;
    const key = JSON.stringify(rest);
    if (this.lastFigures.get(id) === key) return;
    this.lastFigures.set(id, key);
    if (this.records.has(id)) { this.append(id, { kind: "figures", figures }); return; }
    // No record, so no live log: the snapshot a phone is reading gets the event now, and every later snapshot is built with it.
    this.desktopFigures.set(id, figures);
    const snapshot = this.desktop?.snapshot(id);
    if (snapshot) this.opts.onEvent(id, snapshot.append({ kind: "figures", figures }));
  }
}
