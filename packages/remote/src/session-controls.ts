// Durable settings writes. A timed-out caller stops waiting, not the serialized operation.
// Orphans after a restart are read as unknown and are NEVER submitted again.
import { readJson, writeFileAtomic } from "./fsutil.ts";
import type { SettingsResult } from "./protocol.ts";
import { OutcomeUnknownError } from "./receipts.ts";

interface Operation {
  session: string;
  reqId: string;
  fingerprint: string;
  field: "model" | "permissionMode";
  result?: SettingsResult;
  error?: string;
}

export class SessionSettings {
  private records = new Map<string, Operation>();
  private waiting = new Map<string, Promise<SettingsResult>>();
  private file: string;
  private timeoutMs: number;

  constructor(file: string, timeoutMs = 15_000) {
    this.file = file;
    this.timeoutMs = timeoutMs;
    const saved = readJson<Operation[]>(file) ?? [];
    if (!Array.isArray(saved)) throw new Error("Invalid session settings journal");
    for (const record of saved) {
      if (!record || typeof record.session !== "string" || typeof record.reqId !== "string" || typeof record.fingerprint !== "string" || !["model", "permissionMode"].includes(record.field)) throw new Error("Invalid settings operation");
      const key = this.key(record.session, record.reqId);
      if (this.records.has(key)) throw new Error("Duplicate settings operation");
      this.records.set(key, record);
    }
  }

  private key(session: string, reqId: string): string { return JSON.stringify([session, reqId]); }

  private save(key: string, record: Operation): void {
    const next = new Map(this.records);
    next.set(key, record);
    writeFileAtomic(this.file, JSON.stringify([...next.values()]));
    this.records = next;
  }

  /** The host replays these as unknown after a restart, without replaying any write. */
  unresolved(): { session: string; reqId: string }[] {
    return [...this.records.values()].filter(r => !r.result && !r.error).map(({ session, reqId }) => ({ session, reqId }));
  }

  /** A transcript rebase cannot erase host-owned outcomes (including orphaned writes). */
  replay(session: string): ({ reqId: string } & SettingsResult)[] {
    return [...this.records.values()].filter(r => r.session === session).map(r => ({ reqId: r.reqId,
      ...(r.result ?? { status: "unknown" as const, ...(r.error ? { errors: { [r.field]: r.error } } : {}) }) }));
  }

  run(session: string, reqId: string, fingerprint: string, field: "model" | "permissionMode", work: () => Promise<SettingsResult>, publish: (result: SettingsResult) => void): Promise<SettingsResult> {
    if (!/^[\w-]{1,100}$/.test(reqId)) return Promise.reject(new Error("Invalid settings request id"));
    const key = this.key(session, reqId);
    const old = this.records.get(key);
    if (old) {
      if (old.fingerprint !== fingerprint) return Promise.reject(new Error("Request id already belongs to another settings change"));
      const waiting = this.waiting.get(key);
      if (waiting) return waiting;
      if (old.error) return Promise.reject(new Error(old.error));
      return Promise.resolve(old.result ?? { status: "unknown" });
    }
    const record: Operation = { session, reqId, fingerprint, field };
    this.save(key, record); // Before entering the lane, let alone sending a write.
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout>;
    const unknown = new Promise<SettingsResult>(resolve => {
      timer = setTimeout(() => {
        timedOut = true;
        const result: SettingsResult = { status: "unknown" };
        publish(result);
        resolve(result);
      }, this.timeoutMs);
    });
    const finished = Promise.resolve().then(work).catch((error: unknown) => {
      if (error instanceof OutcomeUnknownError) return { status: "unknown" } satisfies SettingsResult;
      const message = error instanceof Error ? error.message : String(error);
      this.save(key, { ...record, error: message });
      if (timedOut) publish({ status: "unknown", errors: { [field]: message } });
      throw error;
    }).then(result => {
      this.save(key, { ...record, result });
      if (!timedOut || result.status !== "unknown") publish(result);
      return result;
    }).finally(() => { clearTimeout(timer); this.waiting.delete(key); });
    const response = Promise.race([finished, unknown]);
    this.waiting.set(key, response);
    return response;
  }
}

/** Only complete, conditional CLI addRules suggestions may become session-local allow rules.
 * Unknown update/rule fields are rejected, never stripped (stripping can broaden a condition).
 * Missing suppression metadata is unknown, not permission to offer Always Allow.
 */
export function sessionPermissionRules(tool: string, suggestions: unknown, suppressed: unknown): { type: "addRules"; rules: { toolName: string; ruleContent: string }[]; behavior: "allow"; destination: "session" }[] {
  if (suppressed !== false || tool === "ExitPlanMode" || tool === "AskUserQuestion" || !Array.isArray(suggestions) || suggestions.length > 8) return [];
  const updates: ReturnType<typeof sessionPermissionRules> = [];
  for (const value of suggestions) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const update = value as Record<string, unknown>;
    if (Object.keys(update).some(k => !["type", "rules", "behavior", "destination"].includes(k)) || update.type !== "addRules" || update.behavior !== "allow" || !Array.isArray(update.rules) || !update.rules.length || update.rules.length > 16) return [];
    const rules: { toolName: string; ruleContent: string }[] = [];
    for (const value of update.rules) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const rule = value as Record<string, unknown>;
      if (Object.keys(rule).some(k => k !== "toolName" && k !== "ruleContent") || rule.toolName !== tool || typeof rule.ruleContent !== "string" || !rule.ruleContent.trim() || rule.ruleContent.length > 1000 || /^[*\s]+$/.test(rule.ruleContent)) return [];
      rules.push({ toolName: tool, ruleContent: rule.ruleContent });
    }
    updates.push({ type: "addRules", rules, behavior: "allow", destination: "session" });
  }
  // Keep the exact conditions displayable in the phone's confirmation; never truncate them.
  if (updates.reduce((size, update) => size + update.rules.reduce((n, rule) => n + rule.toolName.length + rule.ruleContent.length + 3, 0), 0) > 4000) return [];
  return updates;
}
