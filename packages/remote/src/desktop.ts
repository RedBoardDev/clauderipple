// Claude Code's top-level transcripts are a read-only source. Discovery is bounded;
// only opening a timeline scans the transcript, into the same capped event log as host sessions.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { EventLog } from "./eventlog.ts";
import { creationDateToFileTime, parseFileTime, processCommands, processSnapshot, sameFileTime, type ProcessSnapshot } from "./processes.ts";
import { messageContent, sendUserFileImages, type ImageSink } from "./images.ts";
import { PERMISSION_MODES, type BackgroundTask, type EventBody, type Figures, type PermissionMode, type SessionSummary, type ToolCall } from "./protocol.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WINDOW = 256 * 1024;
const RECENT_MS = 14 * 24 * 60 * 60 * 1000;
type RecordValue = Record<string, unknown>;
type Summarize = (tool: string, input: RecordValue, cwd: string) => string;
interface Source { file: string; size: number; mtime: number; unfinished: boolean; summary: SessionSummary }
interface Imported { size: number; mtime: number; log: EventLog; dir: string }
export interface DesktopProcess { sessionId: string; pid: number; status: "busy" | "shell" | "idle" | "waiting"; bridgeSessionId?: string }

/**
 * pid → the start time `ps` reported for it. A pid's start time never changes while it lives, and
 * a recycled pid gets a new registry procStart, so one synchronous `ps` per process is enough;
 * running it for every registry entry on every poll blocked the host (2026-10-12).
 */
const verifiedStarts = new Map<number, string>();
let snapshot: { dir: string; platform: string; at: number; result: Map<string, DesktopProcess> } | null = null;

/**
 * Is this pid the process the registry recorded? On macOS the start time comes from `ps`.
 */
function darwinAlive(): (pid: number, procStart: unknown) => boolean {
  return (pid, procStart) => {
    try {
      process.kill(pid, 0);
      if (typeof procStart === "string" && verifiedStarts.get(pid) !== procStart) {
        const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "ignore"] }).trim();
        if (started !== procStart) return false;
        verifiedStarts.set(pid, started);
      }
      return true;
    } catch { return false; } // Dead or recycled process, not a live desktop writer.
  };
}

/**
 * Is this pid the process the registry recorded? Windows has no `ps -o lstart=`: the registry's
 * procStart is a FILETIME (100 ns ticks since 1601) and the OS reports the same instant as a
 * CreationDate. A pid alone proves nothing there — Windows recycles pids — so the start times
 * are compared (issue #70).
 */
function windowsAlive(processes: ProcessSnapshot): (pid: number, procStart: unknown) => boolean {
  const running = new Set<number>();
  const starts = new Map<number, bigint>();
  for (const p of processes.current()) {
    running.add(p.pid);
    const start = typeof p.started === "string" ? creationDateToFileTime(p.started) : null;
    if (start !== null) starts.set(p.pid, start);
  }
  return (pid, procStart) => {
    if (!running.has(pid)) return false;
    const started = starts.get(pid);
    const recorded = parseFileTime(procStart);
    if (started === undefined || recorded === null) return true; // Nothing to compare: the pid runs.
    return sameFileTime(started, recorded);
  };
}

/**
 * Registry identity is authoritative; ps flags remain a legacy fallback only. Cached for 1 s.
 * The Windows snapshot behind it is read in the background, so this never waits for PowerShell
 * more than once (see ProcessSnapshot).
 */
export function liveDesktopProcesses(dir: string, maxAgeMs = 1000, platform = process.platform, processes: ProcessSnapshot = processSnapshot): Map<string, DesktopProcess> {
  if (platform !== "darwin" && platform !== "win32") return new Map();
  const now = Date.now();
  if (snapshot && snapshot.dir === dir && snapshot.platform === platform && now - snapshot.at < maxAgeMs) return snapshot.result;
  const result = new Map<string, DesktopProcess>();
  snapshot = { dir, platform, at: now, result };
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (error) { if (missing(error)) return result; throw error; }
  const candidates: { pid: number; procStart: unknown; entry: DesktopProcess }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^\d+\.json$/.test(entry.name)) continue;
    const pid = Number(entry.name.slice(0, -5));
    let value: RecordValue | null;
    try { value = record(fs.readFileSync(path.join(dir, entry.name), "utf8")); }
    catch (error) { if (missing(error)) continue; throw error; }
    if (!value || value.entrypoint !== "claude-desktop" || typeof value.sessionId !== "string" || !UUID.test(value.sessionId) || pid <= 1 || (value.pid !== undefined && value.pid !== pid)) continue;
    if (!["busy", "shell", "idle", "waiting"].includes(str(value.status))) continue;
    const status = value.status as DesktopProcess["status"];
    candidates.push({ pid, procStart: value.procStart, entry: { sessionId: value.sessionId, pid, status, ...(typeof value.bridgeSessionId === "string" ? { bridgeSessionId: value.bridgeSessionId } : {}) } });
  }
  if (!candidates.length) return result;
  const alive = platform === "win32" ? windowsAlive(processes) : darwinAlive();
  for (const candidate of candidates) {
    if (!alive(candidate.pid, candidate.procStart)) continue;
    result.set(candidate.entry.sessionId, candidate.entry);
  }
  return result;
}
export interface DesktopOptions {
  projects?: string;
  now?: () => number;
  summarize: Summarize;
  excluded: () => Set<string>;
  processes?: () => string;
  registry?: () => Map<string, DesktopProcess>;
  sidebarIds?: () => Set<string>;
  /** The latest figures the host read for a session. A snapshot is rebuilt from the transcript
   * whenever it grows, so the figures are put back at the end of every rebuild. */
  figures?: (id: string) => Figures | undefined;
}

/** Match session flags, not UUIDs appearing in a prompt or another flag's value. */
export function processHasSession(output: string, id: string): boolean {
  if (!UUID.test(id)) return false;
  return output.split("\n").some(line => {
    const args = line.trim().split(/\s+/).map(arg => arg.replace(/^"|"$/g, ""));
    return args.some((arg, i) => arg === `--resume=${id}` || arg === `--session-id=${id}` ||
      ((arg === "--session-id" || arg === "--resume") && args[i + 1] === id));
  });
}

function object(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}
const str = (value: unknown): string => typeof value === "string" ? value : "";
/** A transcript's top-level permissionMode, only when it names a mode the host knows. */
const permissionMode = (value: unknown): PermissionMode | null =>
  typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value) ? value as PermissionMode : null;
function record(line: string): RecordValue | null {
  try { return object(JSON.parse(line)); } catch { return null; } // Untrusted JSONL boundary.
}
function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap(value => {
    const block = object(value);
    return block?.type === "text" ? [str(block.text)] : block?.type === "image" ? ["[image]"] : [];
  }).join("\n\n");
}
function prompt(r: RecordValue): string {
  if (r.type !== "user" || r.isSidechain === true || r.isMeta === true) return "";
  const message = object(r.message);
  const body = text(message?.content).trim();
  // CLI-generated command/context messages are not the person's first prompt.
  return /^(<local-command-|<command-name>|<system-reminder>|\[Request interrupted)/.test(body) ? "" : body;
}
function title(value: string): string { return value.trim().replace(/\s+/g, " ").slice(0, 160); }

/** A subagent's running state while its parent transcript is converted; `input` lets a terminal
 * event re-resolve its model once its own transcript has written one. */
export interface SubagentState { description: string; model: string | null; steps: number; input: RecordValue }
/** How to convert one transcript. Omitting it is the top-level session: sidechain records are skipped
 * and no subagent events are produced. The sub pass reads a subagent's own transcript instead. */
export interface SubagentContext {
  /** Read sidechain records (a subagent's own transcript) rather than skipping them. */
  allowSidechain?: boolean;
  /** toolUseId → what is known about it; kept across a scan, and across polls for a live tail. */
  state?: Map<string, SubagentState>;
  /** What a subagent's own transcript reports: the model that answered, its steps, its description
   * (meta.json), and whether it stopped on its own answer (`ended`). */
  resolve?: (toolUseId: string, input: RecordValue) => { model: string | null; steps: number; description: string; ended: boolean };
}

/** Unknown records and malformed block shapes never become events. */
export function transcriptEvents(line: string, cwd: string, summarize: Summarize, sink?: ImageSink, subs?: SubagentContext): { at: number | null; bodies: EventBody[] } {
  const r = record(line);
  const bodies: EventBody[] = [];
  if (!r) return { at: null, bodies };
  const sidechain = r.isSidechain === true;
  if (sidechain && !subs?.allowSidechain) return { at: null, bodies };
  const state = subs?.state;
  const resolve = subs?.resolve;
  const time = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
  const at = Number.isFinite(time) ? time : null;
  const message = object(r.message);
  // A notification that arrives mid-turn is queued, not written as a user line (BackgroundTasks.accept).
  const queued = r.type === "attachment" && object(r.attachment)?.type === "queued_command" ? str(object(r.attachment)?.prompt) : "";
  if (r.type === "user" || queued) {
    const p = queued || (sidechain ? text(message?.content).trim() : prompt(r));
    const notification = /^<task-notification>[\s\S]*<\/task-notification>$/.test(p);
    if (notification) {
      const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(p)?.[1];
      const result = /<result>([\s\S]*)<\/result>/.exec(p)?.[1];
      const status = /<status>([^<]+)<\/status>/.exec(p)?.[1];
      // A notification without its tool call has nothing to attach to; it is not the user's words.
      if (toolUseId) {
        bodies.push({ kind: "tool_result", toolUseId, ok: status === "completed", text: result ?? p });
        const running = state?.get(toolUseId);
        if (running && resolve) {
          const info = resolve(toolUseId, running.input);
          bodies.push({ kind: "subagent", toolUseId, sub: `sub-${toolUseId}`, description: running.description, model: info.model ?? running.model, status: status === "completed" ? "done" : "failed", steps: info.steps });
        }
        state?.delete(toolUseId);
      }
    } else if (p && r.type === "user") {
      const converted = messageContent(message?.content, sink);
      bodies.push({ kind: "user", ...converted, clientMsgId: str(r.uuid) });
    }
    for (const value of Array.isArray(message?.content) ? message.content : []) {
      const b = object(value);
      if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
        const converted = messageContent(b.content, sink);
        bodies.push({ kind: "tool_result", toolUseId: b.tool_use_id, ok: b.is_error !== true, ...converted });
        // A synchronous worker finishes at its tool result; an async one only launches here and ends at its notification.
        const running = state?.get(b.tool_use_id);
        const launched = object(r.toolUseResult)?.isAsync === true || /(?:launched asynchronously|async(?: agent)? launched)/i.test(typeof converted.text === "string" ? converted.text : "");
        if (running && resolve && !launched) {
          const info = resolve(b.tool_use_id, running.input);
          bodies.push({ kind: "subagent", toolUseId: b.tool_use_id, sub: `sub-${b.tool_use_id}`, description: running.description, model: info.model ?? running.model, status: b.is_error === true ? "failed" : "done", steps: info.steps });
          state?.delete(b.tool_use_id);
        }
      }
    }
  } else if (r.type === "assistant" && message && Array.isArray(message.content)) {
    const tools: ToolCall[] = [];
    const msg = str(r.uuid) || str(message.id);
    message.content.forEach((value, index) => {
      const block = object(value);
      if (block?.type === "thinking" && typeof block.thinking === "string") bodies.push({ kind: "thinking", msg, block: index, text: block.thinking });
    });
    for (const value of message.content) {
      const b = object(value);
      if (b?.type !== "tool_use" || typeof b.id !== "string" || typeof b.name !== "string") continue;
      const input = object(b.input) ?? {};
      const worker = b.name === "Agent" || b.name === "Task";
      const summary = summarize(b.name, input, cwd);
      tools.push({ id: b.id, name: b.name,
        summary: worker ? [summary || str(input.subagent_type) || b.name, str(input.model)].filter(Boolean).join(" · ") : summary,
        input: JSON.stringify(input, null, 2) });
      // Only a top-level worker opens its own log; sidechain records never carry their own subagent event.
      if (worker && !sidechain && state && resolve) {
        const info = resolve(b.id, input);
        const running: SubagentState = { description: info.description || summary || str(input.subagent_type) || b.name, model: info.model, steps: info.steps, input };
        state.set(b.id, running);
        bodies.push({ kind: "subagent", toolUseId: b.id, sub: `sub-${b.id}`, description: running.description, model: running.model, status: "running", steps: running.steps });
      }
    }
    const body = messageContent(message.content, sink);
    body.images.push(...sendUserFileImages(message.content, cwd, sink));
    if (body.text || body.images.length || tools.length) bodies.push({ kind: "assistant", msg: str(r.uuid) || str(message.id), model: str(message.model), ...body, tools });
  } else if (r.type === "result") {
    const ok = r.subtype === "success" && r.is_error !== true;
    bodies.push({ kind: "result", ok, ...(!ok ? { error: str(r.result) || str(r.subtype) } : {}), ms: typeof r.duration_ms === "number" ? r.duration_ms : 0, turns: typeof r.num_turns === "number" ? r.num_turns : 0 });
  } else if (r.type === "system" && r.subtype === "turn_duration" && typeof r.durationMs === "number") {
    bodies.push({ kind: "result", ok: true, ms: r.durationMs, turns: 1 });
  }
  return { at, bodies };
}

/** Conversation records, not trailing bridge/cost/title bookkeeping, determine turn completion.
 * Desktop tails (2026-10-12): assistant.message.stop_reason=end_turn; user tool_result
 * blocks carry tool_use_id; system stop_hook_summary follows the final assistant.
 * A tool result finishes a tool, not the turn: the model still owes its next reply.
 */
function unfinishedTurn(lines: string[]): boolean {
  let unfinished = false;
  for (const line of lines) {
    const r = record(line);
    if (!r || r.isSidechain === true || r.isMeta === true) continue;
    if (r.type === "result" || (r.type === "system" && r.subtype === "turn_duration")) {
      unfinished = false;
    } else if (r.type === "system" && r.subtype === "stop_hook_summary") {
      unfinished = r.preventedContinuation === true;
    } else if (r.type === "user") {
      const content = object(r.message)?.content;
      if (typeof content === "string" && /^\[Request interrupted/.test(content)) unfinished = false;
      else if (prompt(r) || (Array.isArray(content) && content.some(b => object(b)?.type === "tool_result"))) unfinished = true;
    } else if (r.type === "assistant") {
      const message = object(r.message);
      if (!message || !Array.isArray(message.content)) continue;
      unfinished = message.content.some(b => object(b)?.type === "tool_use") ||
        (message.stop_reason !== "end_turn" && message.stop_reason !== "stop_sequence" &&
          ("stop_reason" in message || !message.content.some(b => object(b)?.type === "text")));
    }
  }
  return unfinished;
}

/** Complete lines only: a partial head/tail record must not be interpreted. */
function windowLines(fd: number, size: number, tail: boolean): string[] {
  const start = tail ? Math.max(0, size - WINDOW) : 0;
  const buffer = Buffer.alloc(Math.min(size - start, WINDOW));
  const n = fs.readSync(fd, buffer, 0, buffer.length, start);
  let data = buffer.toString("utf8", 0, n);
  if (start > 0) data = data.slice(data.indexOf("\n") + 1);
  if (start + n < size || !data.endsWith("\n")) data = data.slice(0, Math.max(0, data.lastIndexOf("\n")));
  return data.split("\n");
}
/** Whether a subagent transcript's last record is an answer that ends the agent's loop. */
export function agentEnded(file: string): boolean {
  let fd: number;
  try { fd = fs.openSync(file, "r"); } catch { return false; }
  try {
    const last = windowLines(fd, fs.fstatSync(fd).size, true).filter(Boolean).at(-1);
    const r = last ? record(last) : null;
    const message = object(r?.message);
    const content = message?.content;
    return r?.type === "assistant" && ["end_turn", "stop_sequence"].includes(str(message?.stop_reason)) &&
      !(Array.isArray(content) && content.some(b => object(b)?.type === "tool_use"));
  } finally { fs.closeSync(fd); }
}
function missing(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "");
}
/** A meta.json or subagent transcript that is not there yet is simply unknown, never fatal. */
function safeRead(file: string): string {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}
const SUB_META = /^agent-([\w-]+)\.meta\.json$/;
/** A hook prefixes a subagent's stored description with "Model·effort · ", shown separately as `model`. */
function stripModelPrefix(description: string): string {
  return description.replace(/^\S*·\S* · /, "");
}
/** The model without its `@effort` suffix (`gpt-6.1-sol@medium` → `gpt-6.1-sol`). */
function withoutEffort(model: string): string {
  return model.replace(/@[^@]*$/, "");
}

/** Top-level task lifecycle only; synchronous workers and nested subagents are not background tasks.
 * Also the main turn's start as the app counts it: the person's last message (origin "human"; compaction
 * summaries and task notifications are not), until the model ends its turn or the person interrupts. */
export class BackgroundTasks {
  private tools = new Map<string, { name: string; background: boolean; label: string }>();
  private active = new Map<string, BackgroundTask>();
  private terminal = new Set<string>();
  get count(): number { return this.active.size; }
  get list(): BackgroundTask[] { return Array.from(this.active.values()); }
  turnStartedAt: number | null = null;

  accept(line: string): void {
    const r = record(line);
    if (!r || r.isSidechain === true) return;
    const content = object(r.message)?.content;
    const at = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
    if (r.type === "user" && object(r.origin)?.kind === "human" && Number.isFinite(at)) this.turnStartedAt = at;
    else if (r.type === "user" && typeof content === "string" && /^\[Request interrupted/.test(content)) this.turnStartedAt = null;
    else if (r.type === "assistant" && Array.isArray(content) && !content.some(b => object(b)?.type === "tool_use") &&
      ["end_turn", "stop_sequence"].includes(str(object(r.message)?.stop_reason))) this.turnStartedAt = null;
    // A notification that arrives mid-turn is queued, not written as a user line: the transcript has it
    // only as a queued_command attachment (and the queue's own enqueue record), seen 2026-10-16.
    const queued = r.type === "attachment" && object(r.attachment)?.type === "queued_command" ? str(object(r.attachment)?.prompt) : "";
    const notification = queued || (r.type === "user" ? text(content) : "");
    if (notification.startsWith("<task-notification>")) {
      const id = /<task-id>([^<]+)<\/task-id>/.exec(notification)?.[1];
      if (id && /<status>(completed|killed|failed|stopped)<\/status>/.test(notification)) this.end(id);
      return;
    }
    for (const value of Array.isArray(content) ? content : []) {
      const b = object(value);
      if (r.type === "assistant" && b?.type === "tool_use" && typeof b.id === "string") {
        const name = str(b.name);
        const input = object(b.input);
        if (["Agent", "Task", "Bash"].includes(name)) this.tools.set(b.id, { name, background: input?.run_in_background === true, label: str(input?.description) || str(input?.command) || name });
        // A task stopped with TaskStop gets no notification at all (seen 2026-10-16: a shell "running" four hours).
        if (name === "TaskStop") this.tools.set(b.id, { name, background: false, label: str(input?.task_id) || str(input?.shell_id) });
      }
      if (r.type !== "user" || b?.type !== "tool_result" || b.is_error === true) continue;
      const tool = this.tools.get(str(b.tool_use_id));
      if (!tool) continue;
      if (tool.name === "TaskStop") {
        if (tool.label) this.end(tool.label);
        this.tools.delete(str(b.tool_use_id));
        continue;
      }
      const result = object(r.toolUseResult);
      const body = text(b.content);
      let id = "";
      if (tool.name === "Bash") {
        id = str(result?.backgroundTaskId) || (tool.background ? /(?:ID|id):\s*([\w-]+)/.exec(body)?.[1] ?? "" : "");
      } else if (result?.isAsync === true || /(?:launched asynchronously|async(?: agent)? launched)/i.test(body)) {
        id = str(result?.agentId) || str(result?.taskId) || /(?:agentId|task[_ -]?id):\s*([\w-]+)/i.exec(body)?.[1] || "";
      }
      if (id && !this.terminal.has(id)) this.active.set(id, { id, kind: tool.name === "Bash" ? "shell" : "agent", label: tool.label, startedAt: Number.isFinite(at) ? at : null });
      this.tools.delete(str(b.tool_use_id));
    }
  }

  private end(id: string): void {
    this.active.delete(id);
    this.terminal.add(id);
  }
}

export class DesktopSessions {
  private opts: DesktopOptions;
  private projects: string;
  private sources = new Map<string, Source>();
  private imported = new Map<string, Imported>();
  private subImports = new Map<string, Imported>();
  private tasks = new Map<string, { file: string; offset: number; tracker: BackgroundTasks }>();
  /** Per-session subagent state for an incremental tail (a bridged session), so a tool_result in a
   * later poll still closes the worker its tool_use opened in an earlier one. */
  private tailSubs = new Map<string, Map<string, SubagentState>>();
  /** session → toolUseId → agentId, rebuilt when the subagents directory changes. */
  private agentMaps = new Map<string, { at: number; map: Map<string, string> }>();
  private temp: string | null = null;
  private scannedAt = -Infinity;
  private checkedAt = -Infinity;

  constructor(opts: DesktopOptions) {
    this.opts = opts;
    this.projects = path.resolve(opts.projects ?? path.join(os.homedir(), ".claude", "projects"));
  }

  list(): SessionSummary[] {
    this.refresh();
    this.updateLive();
    const excluded = this.opts.excluded();
    return Array.from(this.sources.values()).filter(s => !excluded.has(s.summary.id)).map(s => {
      // Unfinished-looking tasks linger in old transcripts; only a busy process can have any running.
      const live = this.liveProcess(s.summary.id);
      if (live?.bridgeSessionId) {
        const working = live.status === "busy" || live.status === "shell";
        const taskList = working ? this.backgroundTaskList(s.summary.id) : [];
        s.summary = { ...s.summary, tasks: taskList.length, taskList, turnStartedAt: working ? this.turnStartedAt(s.summary.id) : null };
      }
      const cached = this.imported.get(s.summary.id);
      return cached && cached.size === s.size && cached.mtime === s.mtime
        ? { ...s.summary, lastSeq: cached.log.lastSeq, epoch: cached.log.epoch } : s.summary;
    });
  }

  poll(): boolean {
    const fingerprint = () => JSON.stringify(Array.from(this.sources.values())
      .filter(s => !this.opts.excluded().has(s.summary.id))
      .map(s => [s.summary.id, s.summary.state, s.summary.updatedAt, s.summary.title, s.summary.tasks, s.summary.taskList?.map(t => t.id).join(), s.summary.turnStartedAt]));
    const before = fingerprint();
    this.list();
    return before !== fingerprint();
  }

  has(id: string): boolean {
    if (!UUID.test(id) || this.opts.excluded().has(id)) return false;
    this.refresh();
    return this.sources.has(id);
  }

  liveProcess(id: string): DesktopProcess | undefined {
    return (this.opts.registry?.() ?? liveDesktopProcesses(path.join(path.dirname(this.projects), "sessions"))).get(id);
  }

  isOpen(id: string): boolean {
    return !!this.liveProcess(id) || processHasSession(this.opts.processes?.() ?? processCommands(), id);
  }

  /** Tail complete transcript lines into an existing host log; never write the transcript. */
  tail(id: string, offset: number, visit: (body: EventBody) => void, sink?: ImageSink): number {
    const source = this.sources.get(id);
    if (!source) return offset;
    const fd = this.open(source.file);
    try {
      const size = fs.fstatSync(fd).size;
      if (size < offset) throw new Error("Desktop transcript was truncated.");
      let state = this.tailSubs.get(id);
      if (!state) { state = new Map(); this.tailSubs.set(id, state); }
      const resolve = (toolUseId: string, input: RecordValue) => this.subInfo(id, toolUseId, input);
      const next = scanLines(fd, size, line => {
        for (const body of transcriptEvents(line, source.summary.cwd, this.opts.summarize, sink, { state, resolve }).bodies) visit(body);
      }, offset);
      // A worker's meta file, which names its model, is often written just after the line that
      // started it: say the model once it is known instead of only when the worker ends.
      for (const [toolUseId, running] of state) {
        if (running.model) continue;
        const info = resolve(toolUseId, running.input);
        if (!info.model || info.ended) continue;
        running.model = info.model;
        visit({ kind: "subagent", toolUseId, sub: `sub-${toolUseId}`, description: running.description, model: running.model, status: "running", steps: info.steps });
      }
      return next;
    } finally { fs.closeSync(fd); }
  }

  backgroundTasks(id: string): number { return this.backgroundTaskList(id).length; }
  /** A background agent whose own transcript ends on its final answer is done, notification or not:
   * one read through TaskOutput, or finished before a compaction, never gets a <task-notification> line
   * in the session's transcript and otherwise stays "running" for good (seen 2026-10-14, five hours). */
  backgroundTaskList(id: string): BackgroundTask[] {
    const list = this.scan(id)?.list ?? [];
    const source = this.sources.get(id);
    if (!source) return list;
    const dir = this.subagentsDir(source);
    return list.filter(task => task.kind !== "agent" || !agentEnded(path.join(dir, `agent-${task.id}.jsonl`)));
  }
  turnStartedAt(id: string): number | null { return this.scan(id)?.turnStartedAt ?? null; }

  /** A subagent transcript lives beside its session file: `<projects>/<proj>/<id>/subagents/agent-<agentId>.jsonl`. */
  private subagentsDir(source: Source): string {
    return path.join(path.dirname(source.file), path.basename(source.file, ".jsonl"), "subagents");
  }

  /** toolUseId → agentId, from the `agent-*.meta.json` files a worker writes when it starts. */
  private agentMap(id: string): Map<string, string> {
    const empty = new Map<string, string>();
    const source = this.sources.get(id);
    if (!source) return empty;
    const dir = this.subagentsDir(source);
    let at: number;
    try { at = fs.statSync(dir).mtimeMs; } catch { return empty; }
    const cached = this.agentMaps.get(id);
    if (cached && cached.at === at) return cached.map;
    const map = new Map<string, string>();
    try {
      for (const name of fs.readdirSync(dir)) {
        const match = SUB_META.exec(name);
        if (!match) continue;
        const meta = record(safeRead(path.join(dir, name)));
        const toolUseId = str(meta?.toolUseId);
        if (toolUseId) map.set(toolUseId, match[1]!);
      }
    } catch (error) { if (!missing(error)) throw error; }
    this.agentMaps.set(id, { at, map });
    return map;
  }

  /** What a worker's own transcript reports, for its parent's subagent events. */
  private subInfo(id: string, toolUseId: string, input: RecordValue): { model: string | null; steps: number; description: string; ended: boolean } {
    const source = this.sources.get(id);
    const agentId = source ? this.agentMap(id).get(toolUseId) : undefined;
    let model = "", steps = 0, ended = false, description = "";
    if (source && agentId) {
      const dir = this.subagentsDir(source);
      const meta = record(safeRead(path.join(dir, `agent-${agentId}.meta.json`)));
      if (meta) {
        model = withoutEffort(str(meta.model));
        description = stripModelPrefix(str(meta.description));
      }
      const read = this.readSubTranscript(path.join(dir, `agent-${agentId}.jsonl`));
      model = read.model || model;
      steps = read.steps;
      ended = read.ended;
    }
    return { model: model || str(input.model) || null, steps, description, ended };
  }

  /** The model that answered (its last assistant record) and how far it got. Tail-bounded read. */
  private readSubTranscript(file: string): { model: string; steps: number; ended: boolean } {
    let fd: number;
    try { fd = this.openUnder(file); } catch { return { model: "", steps: 0, ended: false }; }
    try {
      let model = "", steps = 0;
      let last: RecordValue | null = null;
      scanLines(fd, fs.fstatSync(fd).size, line => {
        const r = record(line);
        if (!r) return;
        last = r;
        if (r.type === "assistant") {
          steps++;
          const m = object(r.message);
          if (typeof m?.model === "string") model = m.model;
        }
      });
      const ending = last as RecordValue | null;
      const message = object(ending?.message);
      const content = message?.content;
      const ended = ending?.type === "assistant" && ["end_turn", "stop_sequence"].includes(str(message?.stop_reason)) &&
        !(Array.isArray(content) && content.some(b => object(b)?.type === "tool_use"));
      return { model, steps, ended };
    } finally { fs.closeSync(fd); }
  }

  /** A Mac session's worker log: the subagent transcript converted to events, cached like the main one.
   * Unknown session or unknown worker → null, which the `sub` op turns into "no such subagent". */
  subLog(id: string, sub: string): EventLog | null {
    const match = /^sub-([\w-]{1,80})$/.exec(sub);
    if (!match) return null;
    const source = this.sources.get(id);
    if (!source) return null;
    const agentId = this.agentMap(id).get(match[1]!);
    if (!agentId) return null;
    const file = path.join(this.subagentsDir(source), `agent-${agentId}.jsonl`);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(file); } catch (error) { if (!missing(error)) throw error; return null; }
    if (!stat.isFile()) return null;
    const key = `${id}::${sub}`;
    const cached = this.subImports.get(key);
    if (cached && cached.size === stat.size && cached.mtime === stat.mtimeMs) return cached.log;
    if (cached) { this.dispose(cached); this.subImports.delete(key); }
    this.temp ??= fs.mkdtempSync(path.join(os.tmpdir(), "ripple-desktop-"));
    const dir = fs.mkdtempSync(path.join(this.temp, "sub-"));
    const log = this.importSub(id, file, dir);
    this.subImports.set(key, { size: stat.size, mtime: stat.mtimeMs, log, dir });
    return log;
  }

  private importSub(id: string, file: string, dir: string): EventLog {
    const source = this.sources.get(id)!;
    const fd = this.openUnder(file);
    let at = source.summary.createdAt;
    const log = EventLog.open({ dir, now: () => at });
    try {
      scanLines(fd, fs.fstatSync(fd).size, line => {
        const parsed = transcriptEvents(line, source.summary.cwd, this.opts.summarize, data => log.image(data), { allowSidechain: true });
        at = parsed.at ?? at;
        for (const body of parsed.bodies) log.append(body.kind === "user" && !body.clientMsgId ? { ...body, clientMsgId: `desktop-${log.lastSeq + 1}` } : body);
      });
      return log;
    } catch (error) { log.close(); throw error; }
    finally { fs.closeSync(fd); }
  }

  private scan(id: string): BackgroundTasks | null {
    const source = this.sources.get(id);
    if (!source) return null;
    const fd = this.open(source.file);
    try {
      const size = fs.fstatSync(fd).size;
      let cached = this.tasks.get(id);
      if (!cached || cached.file !== source.file || size < cached.offset) {
        cached = { file: source.file, offset: 0, tracker: new BackgroundTasks() };
        this.tasks.set(id, cached);
      }
      cached.offset = scanLines(fd, size, line => cached!.tracker.accept(line), cached.offset);
      return cached.tracker;
    } finally { fs.closeSync(fd); }
  }

  transcriptSize(id: string): number { return this.sources.get(id)?.size ?? 0; }

  /** Whether the transcript's newest turn ended ok, from the tail window; null when it holds no
   * result record at all. A Mac session the host is not tailing offers no other word on how its
   * turn ended, so this is what turns an alert's "finished" into "failed"; anything unreadable
   * stays null and the caller says ok. */
  turnOutcome(id: string): boolean | null {
    const source = this.sources.get(id);
    if (!source) return null;
    let fd: number;
    try { fd = this.open(source.file); } catch (error) { if (missing(error)) return null; throw error; }
    try {
      let outcome: boolean | null = null;
      for (const line of windowLines(fd, fs.fstatSync(fd).size, true)) {
        const r = record(line);
        if (!r || r.isSidechain === true || r.isMeta === true) continue;
        if (r.type === "result") outcome = r.subtype === "success" && r.is_error !== true;
        else if (r.type === "system" && r.subtype === "turn_duration") outcome = true;
      }
      return outcome;
    } finally { fs.closeSync(fd); }
  }

  /** Private notification context from a bounded, read-only tail; never imports a session log. */
  pushContext(id: string): { text: string; error: string } {
    const source = this.sources.get(id);
    if (!source) return { text: "", error: "" };
    const fd = this.open(source.file);
    try {
      let answer = "", error = "";
      for (const line of windowLines(fd, fs.fstatSync(fd).size, true)) {
        const r = record(line);
        if (!r || r.isSidechain === true || r.isMeta === true) continue;
        if (prompt(r)) { answer = ""; error = ""; }
        if (r.type === "assistant") {
          const content = object(r.message)?.content;
          const value = Array.isArray(content) ? content.flatMap(b => {
            const block = object(b);
            return block?.type === "text" ? [str(block.text)] : [];
          }).join("\n") : "";
          if (value.trim()) answer = value;
        }
        if (r.type === "result" && (r.subtype !== "success" || r.is_error === true)) error = str(r.result) || str(r.subtype);
      }
      return { text: answer, error };
    } finally { fs.closeSync(fd); }
  }

  /** The mode the Claude app last ran this session in, from the transcript's newest user prompt. */
  permissionMode(id: string): PermissionMode | undefined { return this.sources.get(id)?.summary.permissionMode; }

  /** The transcript's current title (a Mac rename lands as a custom-title line), without liveness checks. Read-only. */
  titleOf(id: string): string | null {
    const source = this.sources.get(id);
    if (!source) return null;
    let stat: fs.Stats;
    try { stat = fs.lstatSync(source.file); } catch (error) { if (!missing(error)) throw error; return null; }
    if (!stat.isFile()) return null;
    return this.readSummary(id, source.file, stat)?.summary.title ?? null;
  }

  continuation(id: string): { summary: SessionSummary; open: boolean } {
    if (!this.has(id)) throw new Error("no such session");
    const source = this.sources.get(id)!;
    const fd = this.open(source.file);
    try {
      const stat = fs.fstatSync(fd);
      const current = this.readSummary(id, source.file, stat);
      if (!current) throw new Error("transcript has no working folder");
      return { summary: current.summary, open: this.isOpen(id) };
    } finally { fs.closeSync(fd); }
  }

  /** Convert directly into the durable host log, preserving timestamps and externalized blobs. */
  importInto(id: string, dir: string, now: () => number): EventLog {
    if (!this.has(id)) throw new Error("no such session");
    const source = this.sources.get(id)!;
    const fd = this.open(source.file);
    let at = source.summary.createdAt;
    let importing = true;
    const state = new Map<string, SubagentState>();
    const resolve = (toolUseId: string, input: RecordValue) => this.subInfo(id, toolUseId, input);
    const log = EventLog.open({ dir, now: () => importing ? at : now() });
    try {
      source.size = scanLines(fd, fs.fstatSync(fd).size, line => {
        const parsed = transcriptEvents(line, source.summary.cwd, this.opts.summarize, data => log.image(data), { state, resolve });
        at = parsed.at ?? at;
        for (const body of parsed.bodies) log.append(body.kind === "user" && !body.clientMsgId ? { ...body, clientMsgId: `desktop-${log.lastSeq + 1}` } : body);
      });
      // A worker whose own transcript ended on its answer, but whose notification never landed in
      // the parent, is done: without this it would read "running" for good.
      for (const [toolUseId, running] of state) {
        const info = resolve(toolUseId, running.input);
        if (info.ended) log.append({ kind: "subagent", toolUseId, sub: `sub-${toolUseId}`, description: running.description, model: info.model ?? running.model, status: "done", steps: info.steps });
      }
      importing = false;
      const figures = this.opts.figures?.(id);
      if (figures) log.append({ kind: "figures", figures });
      return log;
    } catch (error) { log.close(); throw error; }
    finally { fs.closeSync(fd); }
  }

  /** One ps snapshot and stats of the capped list; unchanged files are never reread. */
  private updateLive(): void {
    const now = (this.opts.now ?? Date.now)();
    if (now - this.checkedAt < 3000) return;
    const registry = this.opts.registry?.() ?? liveDesktopProcesses(path.join(path.dirname(this.projects), "sessions"));
    const processes = this.sources.size ? this.opts.processes?.() ?? processCommands() : "";
    for (const [id, previous] of this.sources) {
      let stat: fs.Stats;
      try { stat = fs.lstatSync(previous.file); }
      catch (error) { if (!missing(error)) throw error; this.sources.delete(id); continue; }
      if (!stat.isFile()) { this.sources.delete(id); continue; }
      const source = previous.size === stat.size && previous.mtime === stat.mtimeMs
        ? previous : this.readSummary(id, previous.file, stat);
      if (!source) { this.sources.delete(id); continue; }
      const live = registry.get(id);
      source.summary = { ...source.summary, state: live ? live.status === "waiting" ? "waiting" : live.status === "idle" ? "idle" : "running" : processHasSession(processes, id) &&
        (now - source.mtime <= 10_000 || source.unfinished) ? "running" : "stopped" };
      this.sources.set(id, source);
    }
    this.checkedAt = now;
  }

  private refresh(): void {
    const now = (this.opts.now ?? Date.now)();
    if (now - this.scannedAt < 30_000) return; // Discovery is slower than the cheap live-state poll.
    this.scannedAt = now;
    const candidates: { id: string; file: string; stat: fs.Stats }[] = [];
    const excluded = this.opts.excluded();
    const sidebar = this.opts.sidebarIds?.();
    try {
      for (const project of fs.readdirSync(this.projects, { withFileTypes: true })) {
        if (!project.isDirectory()) continue; // Never follow project symlinks or recurse.
        const dir = path.join(this.projects, project.name);
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const id = entry.name.slice(0, -6);
          if (!entry.isFile() || !entry.name.endsWith(".jsonl") || !UUID.test(id) || excluded.has(id)) continue;
          const file = path.join(dir, entry.name);
          const stat = fs.lstatSync(file);
          if (stat.isFile() && (sidebar?.size ? sidebar.has(id) : stat.mtimeMs >= now - RECENT_MS)) candidates.push({ id, file, stat });
        }
      }
    } catch (error) { if (!missing(error)) throw error; }
    candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    const next = new Map<string, Source>();
    for (const { id, file, stat } of candidates) {
      if (!sidebar?.size && next.size >= 50) break;
      if (next.has(id)) continue;
      const cached = this.sources.get(id);
      const source = cached?.file === file && cached.size === stat.size && cached.mtime === stat.mtimeMs
        ? cached : this.readSummary(id, file, stat);
      if (source) next.set(id, source);
    }
    this.sources = next;
    for (const id of this.tasks.keys()) if (!next.has(id)) this.tasks.delete(id);
    for (const id of this.tailSubs.keys()) if (!next.has(id)) this.tailSubs.delete(id);
    for (const id of this.agentMaps.keys()) if (!next.has(id)) this.agentMaps.delete(id);
    for (const [id, cached] of this.imported) if (!next.has(id)) { this.dispose(cached); this.imported.delete(id); }
    for (const [key, cached] of this.subImports) if (!next.has(key.slice(0, key.indexOf("::")))) { this.dispose(cached); this.subImports.delete(key); }
  }

  /** Resolve both directories and the file; a replaced symlink may not escape projects/. */
  private open(file: string): number {
    const root = fs.realpathSync(this.projects);
    const real = fs.realpathSync(file);
    if (!real.startsWith(root + path.sep) || path.relative(root, real).split(path.sep).length !== 2) throw new Error("transcript outside projects");
    return fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  }

  /** A subagent transcript sits deeper than the two-segment session file; only projects/ matters. */
  private openUnder(file: string): number {
    const root = fs.realpathSync(this.projects);
    const real = fs.realpathSync(file);
    if (!real.startsWith(root + path.sep)) throw new Error("transcript outside projects");
    return fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  }

  private readSummary(id: string, file: string, stat: fs.Stats): Source | null {
    let fd: number;
    try { fd = this.open(file); } catch (error) { if (missing(error)) return null; throw error; }
    try {
      let cwd = "", model = "", ownTitle = "", firstPrompt = "";
      let mode: PermissionMode | null = null;
      let createdAt = stat.birthtimeMs;
      const tail = windowLines(fd, stat.size, true);
      for (const line of [...windowLines(fd, stat.size, false), ...tail]) {
        const r = record(line);
        if (!r || r.isSidechain === true) continue;
        if (!cwd && typeof r.cwd === "string") cwd = r.cwd;
        if (!firstPrompt) firstPrompt = title(prompt(r));
        // Only a person's prompt carries the top-level mode; later user lines without one (tool
        // results) keep the last seen mode, so the newest prompt's mode wins.
        if (r.type === "user") { const named = permissionMode(r.permissionMode); if (named) mode = named; }
        if (r.type === "custom-title" && typeof r.customTitle === "string") ownTitle = title(r.customTitle);
        if (r.type === "summary" && typeof r.summary === "string" && !ownTitle) ownTitle = title(r.summary);
        const m = object(r.message);
        if (r.type === "assistant" && typeof m?.model === "string") model = m.model;
        const at = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
        if (Number.isFinite(at)) createdAt = Math.min(createdAt, at);
      }
      if (!cwd) return null;
      return { file, size: stat.size, mtime: stat.mtimeMs, unfinished: unfinishedTurn(tail), summary: { id, title: ownTitle || firstPrompt || id, cwd, model, ...(mode ? { permissionMode: mode } : {}), effort: null, state: "stopped", pending: 0, createdAt, updatedAt: stat.mtimeMs, lastSeq: 0, epoch: "", origin: "desktop", readOnly: false } };
    } finally { fs.closeSync(fd); }
  }

  log(id: string): EventLog {
    if (!this.has(id)) throw new Error("no such session");
    const source = this.sources.get(id)!;
    const fd = this.open(source.file);
    try {
      const stat = fs.fstatSync(fd);
      const cached = this.imported.get(id);
      if (cached && cached.size === stat.size && cached.mtime === stat.mtimeMs) return cached.log;
      if (cached) { this.dispose(cached); this.imported.delete(id); }
      this.temp ??= fs.mkdtempSync(path.join(os.tmpdir(), "ripple-desktop-"));
      const dir = fs.mkdtempSync(path.join(this.temp, "snapshot-"));
      const log = this.importInto(id, dir, this.opts.now ?? Date.now);
      this.imported.set(id, { size: stat.size, mtime: stat.mtimeMs, log, dir });
      return log;
    } finally { fs.closeSync(fd); }
  }

  /** The snapshot a phone may be reading, only while it still matches the transcript. Never builds one. */
  snapshot(id: string): EventLog | null {
    const cached = this.imported.get(id);
    const source = this.sources.get(id);
    if (!cached || !source) return null;
    try {
      const stat = fs.statSync(source.file);
      return cached.size === stat.size && cached.mtime === stat.mtimeMs ? cached.log : null;
    } catch { return null; }
  }

  private dispose(cached: Imported): void { cached.log.close(); fs.rmSync(cached.dir, { recursive: true, force: true }); }
  close(): void {
    for (const cached of this.imported.values()) this.dispose(cached);
    this.imported.clear();
    for (const cached of this.subImports.values()) this.dispose(cached);
    this.subImports.clear();
    this.tailSubs.clear();
    this.agentMaps.clear();
    if (this.temp) fs.rmSync(this.temp, { recursive: true, force: true });
    this.temp = null;
  }
}

// Streaming chunks, not readFileSync: no full-file buffer, even for a multi-GB transcript.
function scanLines(fd: number, size: number, visit: (line: string) => void, from = 0): number {
  const buffer = Buffer.alloc(WINDOW);
  let carry = Buffer.alloc(0);
  for (let offset = from; offset < size;) {
    const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!n) break;
    offset += n;
    const data = Buffer.concat([carry, buffer.subarray(0, n)]);
    let start = 0;
    for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
      visit(data.toString("utf8", start, end));
      start = end + 1;
    }
    carry = Buffer.from(data.subarray(start));
  }
  // An in-flight unterminated append is ignored until the next snapshot.
  return size - carry.length;
}
