// One durable host-application record, distinct from the router's own running version.
import path from "node:path";
import { withFileLock, writeJsonAtomic } from "../../router/src/locked-file.ts";
import { readJson } from "./fsutil.ts";
import type { RefreshPlan } from "./host-service.ts";

export interface HostUpdate { version: string; status: "pending" | "applied" | "skipped"; retryAt: number; error?: string }
const file = (home: string): string => path.join(home, "host-update.json");
export function readHostUpdate(home: string): HostUpdate | null {
  const value = readJson<HostUpdate>(file(home));
  if (value && (typeof value.version !== "string" || !["pending", "applied", "skipped"].includes(value.status) ||
      !Number.isFinite(value.retryAt) || (value.error !== undefined && typeof value.error !== "string"))) throw new Error("invalid host update state");
  return value;
}
export function requestHostUpdate(home: string, version: string): void {
  withFileLock(file(home), () => {
    const previous = readHostUpdate(home);
    if (previous?.version === version && previous.status === "pending") return;
    writeJsonAtomic(file(home), { version, status: "pending", retryAt: 0 } satisfies HostUpdate);
  });
}

export interface HostRefreshDeps {
  plan(): Promise<RefreshPlan>;
  /** Must reserve the idle host against new turns before replacing or exiting it. */
  apply(): Promise<void>;
  version(): Promise<string | null>;
  now?: () => number;
}
export async function refreshHostUpdate(home: string, version: string, deps: HostRefreshDeps): Promise<HostUpdate | null> {
  const now = deps.now ?? Date.now;
  const claim = withFileLock(file(home), () => {
    const state = readHostUpdate(home);
    if (!state || state.version !== version || state.status !== "pending" || now() < state.retryAt) return null;
    const next = { ...state, retryAt: now() + 60_000 };
    writeJsonAtomic(file(home), next);
    return next;
  });
  if (!claim) return readHostUpdate(home);
  let next: HostUpdate = claim;
  try {
    const plan = await deps.plan();
    if (plan === "absent" || plan === "foreign") next = { ...claim, status: "skipped" };
    else {
      const current = await deps.version();
      if (current === version) next = { ...claim, status: "applied" };
      else if (plan !== "busy") {
        await deps.apply();
        if (await deps.version() !== version) throw new Error("host did not start the target version");
        next = { ...claim, status: "applied" };
      }
      if (next.status === "applied") delete next.error;
    }
  } catch (error) { next = { ...claim, error: error instanceof Error ? error.message : String(error) }; }
  withFileLock(file(home), () => {
    const current = readHostUpdate(home);
    if (current?.version === claim.version && current.retryAt === claim.retryAt) writeJsonAtomic(file(home), next);
  });
  return readHostUpdate(home);
}
