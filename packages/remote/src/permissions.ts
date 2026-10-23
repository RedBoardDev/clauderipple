import { randomUUID } from "node:crypto";
import { readJson, writeFileAtomic } from "./fsutil.ts";

export type Decision = "allow" | "allow_always" | "deny" | "expired";
export interface PermissionRecord {
  id: string;
  session: string;
  tool: string;
  title: string;
  summary: string;
  input: unknown;
  createdAt: number;
  state: "pending" | Decision;
  decidedAt?: number;
  reason?: string;
}

type Request = Pick<PermissionRecord, "session" | "tool" | "title" | "summary" | "input">;
type Answer = { decision: Decision; reason?: string; answers?: Record<string, string> };
interface Waiter { resolve: (answer: Answer) => void; cleanup: () => void }
const WEEK = 7 * 24 * 60 * 60 * 1000;

export class PermissionQueue {
  readonly expiredOnOpen: PermissionRecord[];
  private file: string;
  private now: () => number;
  private records = new Map<string, PermissionRecord>();
  private waiters = new Map<string, Waiter>();

  private constructor(file: string, now: () => number, expired: PermissionRecord[]) {
    this.file = file;
    this.now = now;
    this.expiredOnOpen = structuredClone(expired);
  }

  /** Construct without reading or rewriting another host's pending requests before bind. */
  static deferred(file: string, now: () => number = Date.now): PermissionQueue {
    return new PermissionQueue(file, now, []);
  }

  static open(file: string, now: () => number = Date.now): PermissionQueue {
    const queue = PermissionQueue.deferred(file, now);
    queue.open();
    return queue;
  }

  open(): void {
    // A JSON array is the complete snapshot; malformed state is never an empty queue.
    const saved = readJson<PermissionRecord[]>(this.file) ?? [];
    if (!Array.isArray(saved)) throw new Error("Invalid permission queue");
    const at = this.now();
    const expired: PermissionRecord[] = [];
    const records = new Map<string, PermissionRecord>();
    for (const record of saved) {
      if (!validRecord(record) || records.has(record.id)) throw new Error("Invalid permission record");
      if (record.state === "pending") {
        record.state = "expired";
        record.reason = "host_restarted";
        record.decidedAt = at;
        expired.push(record);
      }
      records.set(record.id, record);
    }
    this.persist(records, at);
    this.expiredOnOpen.push(...structuredClone(expired));
  }

  private persist(records: Map<string, PermissionRecord>, at: number): void {
    const kept = new Map([...records].filter(([, record]) => record.state === "pending" || record.decidedAt! >= at - WEEK));
    writeFileAtomic(this.file, JSON.stringify([...kept.values()]));
    // Memory and promises must not get ahead of durable state when a write fails.
    this.records = kept;
  }

  request(r: Request, signal?: AbortSignal): { record: PermissionRecord; decision: Promise<Answer> } {
    const at = this.now();
    const record: PermissionRecord = { ...structuredClone(r), id: randomUUID(), createdAt: at, state: "pending" };
    const records = new Map(this.records);
    records.set(record.id, record);
    this.persist(records, at);
    const decision = new Promise<Answer>(resolve => {
      const abort = () => { this.expire(record.id, "aborted"); };
      this.waiters.set(record.id, { resolve, cleanup: () => signal?.removeEventListener("abort", abort) });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    return { record: structuredClone(this.records.get(record.id)!), decision };
  }

  private finish(ids: string[], decision: Decision, reason?: string, answers?: Record<string, string>): PermissionRecord[] {
    const at = this.now();
    const records = new Map(this.records);
    const changed: PermissionRecord[] = [];
    for (const id of ids) {
      const record = records.get(id);
      if (record?.state !== "pending") continue;
      const next: PermissionRecord = { ...record, state: decision, decidedAt: at };
      if (reason !== undefined) next.reason = reason;
      records.set(id, next);
      changed.push(next);
    }
    if (!changed.length) return [];
    this.persist(records, at);
    for (const record of changed) {
      const waiter = this.waiters.get(record.id);
      if (!waiter) continue;
      this.waiters.delete(record.id);
      waiter.cleanup();
      const answer: Answer = { decision };
      if (reason !== undefined) answer.reason = reason;
      if (answers !== undefined) answer.answers = answers;
      waiter.resolve(answer);
    }
    return structuredClone(changed);
  }

  decide(id: string, decision: "allow" | "allow_always" | "deny", reason?: string, answers?: Record<string, string>): PermissionRecord | null {
    // The type says the union, but a phone frame is runtime data: anything else would corrupt the
    // record (a forged "expired" would close a card without answering it).
    if (decision !== "allow" && decision !== "allow_always" && decision !== "deny") throw new Error("invalid decision");
    return this.finish([id], decision, reason, answers)[0] ?? null;
  }

  denySession(session: string, reason: string): PermissionRecord[] {
    return this.finish(this.pending(session).map(record => record.id), "deny", reason);
  }

  expire(id: string, reason: string): PermissionRecord | null {
    return this.finish([id], "expired", reason)[0] ?? null;
  }

  expireSession(session: string, reason: string): PermissionRecord[] {
    return this.finish(this.pending(session).map(record => record.id), "expired", reason);
  }

  pending(session?: string): PermissionRecord[] {
    return structuredClone([...this.records.values()]
      .filter(record => record.state === "pending" && (session === undefined || record.session === session))
      .sort((a, b) => a.createdAt - b.createdAt));
  }

  get(id: string): PermissionRecord | undefined {
    const record = this.records.get(id);
    return record === undefined ? undefined : structuredClone(record);
  }
}

function validRecord(record: PermissionRecord): boolean {
  return record !== null && typeof record === "object"
    && [record.id, record.session, record.tool, record.title, record.summary].every(value => typeof value === "string")
    && Number.isFinite(record.createdAt)
    && ["pending", "allow", "allow_always", "deny", "expired"].includes(record.state)
    && (record.state === "pending" || Number.isFinite(record.decidedAt))
    && (record.reason === undefined || typeof record.reason === "string");
}
