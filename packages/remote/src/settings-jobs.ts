import type { Effort } from "./protocol.ts";

export interface SettingsJob { jobId: string; appSessionId: string; cliSessionId: string; model?: string; effort?: Effort; createdAt: number }
export type SettingsJobOutcome = "applied" | "failed" | "pending" | "no-helper";
export interface SettingsJobStatus { jobId: string; outcome: SettingsJobOutcome; detail?: string }

export const settingsId = (value: unknown): value is string => typeof value === "string" && /^[\w-]{1,100}$/.test(value);
export const settingsModel = (value: unknown): value is string => typeof value === "string" && /^[\w.\-\[\]@:]{1,100}$/.test(value);
export const settingsEffort = (value: unknown): value is Effort => typeof value === "string" && ["low", "medium", "high", "xhigh", "max"].includes(value);

export type SettingsJobAction = { jobId: string; helper: string } | { jobId: string; outcome: "applied" | "failed"; detail?: string };
export function validSettingsJobAction(raw: unknown, result: boolean): raw is SettingsJobAction {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const body = raw as Record<string, unknown>;
  if (!settingsId(body.jobId)) return false;
  if (result) return Object.keys(body).every(key => ["jobId", "outcome", "detail"].includes(key)) &&
    (body.outcome === "applied" || body.outcome === "failed") && (body.detail === undefined || typeof body.detail === "string" && body.detail.length <= 1000);
  return Object.keys(body).every(key => ["jobId", "helper"].includes(key)) && settingsId(body.helper);
}

type State = { job: SettingsJob; claimed: boolean; timer: ReturnType<typeof setTimeout> };

/** One active writer per app session; a newer unclaimed request supersedes only the queued job. */
export class SettingsJobs {
  private jobs = new Map<string, State>();
  private outcomes = new Map<string, SettingsJobStatus>();
  private resultMs: number;
  private expiryMs: number;
  private onFinish: ((job: SettingsJob, outcome: SettingsJobOutcome) => void) | undefined;
  constructor(resultMs = 30_000, expiryMs = 600_000, onFinish?: (job: SettingsJob, outcome: SettingsJobOutcome) => void) { this.resultMs = resultMs; this.expiryMs = expiryMs; this.onFinish = onFinish; }

  hasPending(appSessionId: string): boolean {
    return [...this.jobs.values()].some(state => state.job.appSessionId === appSessionId);
  }

  request(job: SettingsJob): void {
    if (!settingsId(job.jobId) || !settingsId(job.appSessionId) || !settingsId(job.cliSessionId) ||
        job.model === undefined && job.effort === undefined || job.model !== undefined && !settingsModel(job.model) ||
        job.effort !== undefined && !settingsEffort(job.effort) || !Number.isFinite(job.createdAt) || this.jobs.has(job.jobId)) throw new Error("invalid settings job");
    for (const [id, state] of this.jobs) if (state.job.appSessionId === job.appSessionId && !state.claimed) {
      clearTimeout(state.timer); this.jobs.delete(id);
    }
    const timer = setTimeout(() => this.finish(job.jobId, "no-helper"), this.expiryMs);
    timer.unref();
    this.jobs.set(job.jobId, { job: { ...job }, claimed: false, timer });
    this.outcomes.set(job.appSessionId, { jobId: job.jobId, outcome: "pending" });
  }

  pending(excludeAppSessionId: string): SettingsJob[] {
    const busy = new Set([...this.jobs.values()].filter(state => state.claimed).map(state => state.job.appSessionId));
    return [...this.jobs.values()].filter(state => !state.claimed && state.job.appSessionId !== excludeAppSessionId && !busy.has(state.job.appSessionId)).map(state => ({ ...state.job }));
  }

  claim(jobId: string, helperAppSessionId: string): boolean {
    const state = this.jobs.get(jobId);
    if (!settingsId(helperAppSessionId) || !state || state.claimed || state.job.appSessionId === helperAppSessionId ||
        [...this.jobs.values()].some(other => other.claimed && other.job.appSessionId === state.job.appSessionId)) return false;
    clearTimeout(state.timer);
    state.claimed = true;
    state.timer = setTimeout(() => this.finish(jobId, "failed", "helper result timed out"), this.resultMs);
    state.timer.unref();
    return true;
  }

  result(jobId: string, outcome: "applied" | "failed", detail?: string): boolean {
    if (!this.jobs.get(jobId)?.claimed || !validSettingsJobAction({ jobId, outcome, ...(detail === undefined ? {} : { detail }) }, true)) return false;
    this.finish(jobId, outcome, detail);
    return true;
  }

  status(appSessionId: string): SettingsJobStatus | undefined {
    const status = this.outcomes.get(appSessionId);
    return status && { ...status };
  }

  private finish(jobId: string, outcome: SettingsJobOutcome, detail?: string): void {
    const state = this.jobs.get(jobId);
    if (!state) return;
    clearTimeout(state.timer); this.jobs.delete(jobId);
    if (this.outcomes.get(state.job.appSessionId)?.jobId === jobId) this.outcomes.set(state.job.appSessionId, { jobId, outcome, ...(detail === undefined ? {} : { detail }) });
    this.onFinish?.(state.job, outcome);
  }

  close(): void { for (const state of this.jobs.values()) clearTimeout(state.timer); this.jobs.clear(); }
}
