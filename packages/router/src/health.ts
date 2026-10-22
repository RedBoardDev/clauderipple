// Self-healing: a long-lived process whose resolver or socket layer has gone bad
// stays bad (observed: 10h of ENOTFOUND, 11 remote-control workers lost). After N
// consecutive upstream *connect-level* failures with no success in between, exit
// with a distinctive code so the supervisor restarts a fresh process.
//
// But only when a fresh process would do better. When the counter trips, a child process (curl,
// with its own resolver and sockets) asks the internet first: if it gets through, this process is
// the broken part and it exits; if it does not, the machine itself is offline, a restart cannot
// help, and the process stays (logged once per outage; the counter re-arms). On 2026-10-20 a
// MacBook that lost Wi-Fi on the commute restarted the router 27 times in 18 minutes, and every
// restart threw away the hotspot failover's probe history before it could act (tether.ts).
// A check that cannot run (no curl) exits as before: the documented fix stays the default.

import path from "node:path";
import type { Runner } from "./awake.ts";
import { PROBE_URLS } from "./tether.ts";
import { RELAY_UPSTREAM_FAILED } from "./pool.ts";

export type ProviderExhaustion = {
  reason: "insufficient_balance" | "billing_exhausted" | "quota_exhausted";
  at: number;
  until: number;
};

/** Only definite billing/quota exhaustion, never a bare rate limit or RESOURCE_EXHAUSTED.
 * 402 is already `exhausted` in pool.ts; Codex's usage_limit_reached is named in
 * providers/chatgpt/translate.ts. Other vendors share the explicit billing vocabulary.
 * Reasons are codes, not upstream prose (which can contain credentials).
 */
export function providerExhaustion(status: number, body = "", retryMs?: number, now = Date.now()): ProviderExhaustion | undefined {
  if (status !== 402 && status !== 429) return undefined;
  // A relay's 402 for its upstream being down is not about money (pool.ts, RELAY_UPSTREAM_FAILED).
  if (RELAY_UPSTREAM_FAILED.test(body)) return undefined;
  const balance = /\b(?:insufficient[_ -]+(?:balance|credits?|funds)|(?:balance|credits?)[_ -]+(?:insufficient|exhausted|depleted))\b/i.test(body);
  const billing = /\bbilling[_ -]+(?:hard[_ -]+)?(?:limit|exhausted|quota)|\b(?:exhausted|exceeded|insufficient)[_ -]+billing\b/i.test(body);
  const quota = /\b(?:insufficient_quota|usage_limit_reached|quota[_ -]+exhausted|exhausted[_ -]+quota)\b/i.test(body);
  if (status !== 402 && !balance && !billing && !quota) return undefined;
  const reason = balance ? "insufficient_balance" : billing || status === 402 ? "billing_exhausted" : "quota_exhausted";
  const wait = retryMs !== undefined && Number.isFinite(retryMs) && retryMs > 0 ? retryMs : 30 * 60_000;
  return { reason, at: now, until: now + wait };
}

/** Per router instance, advisory only: manual traffic can prove a topped-up provider healthy. */
export class ProviderHealth {
  private readonly exhausted = new Map<string, ProviderExhaustion>();

  observe(provider: string, status: number, exhaustion?: ProviderExhaustion): void {
    if (exhaustion) this.exhausted.set(provider, exhaustion);
    else if (status >= 200 && status < 300) this.exhausted.delete(provider);
  }

  snapshot(now = Date.now()): Record<string, ProviderExhaustion> {
    for (const [name, value] of this.exhausted) if (value.until <= now) this.exhausted.delete(name);
    return Object.fromEntries(this.exhausted);
  }
}

export const EXIT_UPSTREAM_UNREACHABLE = 75;

const CONNECT_ERRORS = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
]);

export function isConnectError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && CONNECT_ERRORS.has(code);
}

/** Can a fresh process reach the internet? `unknown`: the check itself could not run. */
export type Connectivity = { result: "online" | "offline" | "unknown"; detail: string };

/** curl exits that mean "the network did not get us there" (man curl, EXIT CODES). Any other is the check failing. */
const CURL_NETWORK_EXITS = new Set([5, 6, 7, 28, 35, 52, 55, 56]);
export const CONNECTIVITY_TIMEOUT_S = 5;

/** The curl the OS ships: macOS/Linux /usr/bin/curl, Windows 10 1803+ %SystemRoot%\System32\curl.exe. */
export function curlPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === "win32") return path.win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", "curl.exe");
  return "/usr/bin/curl";
}

type Probe = "ok" | "fail" | "error";

async function curlProbe(run: Runner, curl: string, url: string, ok: (status: number, body: string) => boolean): Promise<{ probe: Probe; detail: string }> {
  // -q first: no ~/.curlrc. --noproxy: the answer must be the network's, never a proxy's (ours included).
  const r = await run(curl, ["-q", "-s", "--noproxy", "*", "-m", String(CONNECTIVITY_TIMEOUT_S), "-w", "\n%{http_code}", url], { timeoutMs: (CONNECTIVITY_TIMEOUT_S + 5) * 1000 });
  if (r.code === 0) {
    const at = r.stdout.lastIndexOf("\n");
    const status = Number(r.stdout.slice(at + 1).trim());
    const body = at >= 0 ? r.stdout.slice(0, at) : "";
    // Anything but the exact answer (a captive portal's page, a redirect) is not the internet either.
    return ok(status, body) ? { probe: "ok", detail: `HTTP ${status}` } : { probe: "fail", detail: `unexpected HTTP ${status}` };
  }
  if (CURL_NETWORK_EXITS.has(r.code)) return { probe: "fail", detail: `curl exit ${r.code}` };
  return { probe: "error", detail: `curl could not run (${r.code}: ${r.stderr.trim().slice(0, 120)})` };
}

/** The same two endpoints as the hotspot probe (tether.ts), asked by a child process. Never throws. */
export async function checkConnectivity(run: Runner, platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): Promise<Connectivity> {
  const curl = curlPath(platform, env);
  const [apple, google] = await Promise.all([
    curlProbe(run, curl, PROBE_URLS.apple, (s, b) => s === 200 && b.includes("Success")),
    curlProbe(run, curl, PROBE_URLS.google, (s) => s === 204),
  ]);
  const detail = `captive.apple.com: ${apple.detail}, gstatic: ${google.detail}`;
  if (apple.probe === "ok" || google.probe === "ok") return { result: "online", detail };
  if (apple.probe === "error" || google.probe === "error") return { result: "unknown", detail };
  return { result: "offline", detail };
}

export type UpstreamHealthOptions = {
  /** Asked when the counter trips. Without it, a trip always calls onTrip (the original rule). */
  connectivity?: () => Promise<Connectivity>;
  /** The machine itself is offline: called once per outage instead of onTrip. */
  onOffline?: (n: number, c: Connectivity) => void;
};

export class UpstreamHealth {
  private consecutive = 0;
  private tripped = false;
  /** An offline verdict was logged and no success has been seen since. */
  private offline = false;
  /** Bumped by every success, so a check that raced one does not exit a process that works. */
  private successes = 0;
  private readonly limit: () => number;
  private readonly onTrip: (n: number, c?: Connectivity) => void;
  private readonly opts: UpstreamHealthOptions;

  constructor(limit: () => number, onTrip: (n: number, c?: Connectivity) => void, opts: UpstreamHealthOptions = {}) {
    this.limit = limit;
    this.onTrip = onTrip;
    this.opts = opts;
  }

  success(): void {
    this.consecutive = 0;
    this.offline = false;
    this.successes++;
  }

  failure(e: unknown): void {
    if (!isConnectError(e)) return;
    this.consecutive++;
    if (this.tripped || this.consecutive < this.limit()) return;
    this.tripped = true;
    if (!this.opts.connectivity) this.onTrip(this.consecutive);
    else void this.confirm(this.opts.connectivity);
  }

  private async confirm(check: () => Promise<Connectivity>): Promise<void> {
    const before = this.successes;
    let c: Connectivity;
    try {
      c = await check();
    } catch (e) {
      c = { result: "unknown", detail: `check failed: ${(e as Error).message}` };
    }
    if (this.successes !== before) {
      // An upstream call got through while we asked: this process works. Re-arm.
      this.tripped = false;
      return;
    }
    if (c.result !== "offline") {
      this.onTrip(this.consecutive, c);
      return;
    }
    if (!this.offline) {
      this.offline = true;
      this.opts.onOffline?.(this.consecutive, c);
    }
    this.consecutive = 0;
    this.tripped = false;
  }

  get consecutiveFailures(): number {
    return this.consecutive;
  }
}
