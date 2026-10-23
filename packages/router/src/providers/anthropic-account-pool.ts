// Runtime view of Claude subscription accounts: current Claude Code/Desktop login first (unless the
// user marked a stored account preferred, which then leads), followed by ClaudeRipple-owned OAuth accounts. Stored grants are refreshed just before expiry and projected as
// ordinary proxy credentials, so the shared CredentialPool supplies affinity, cooldown and retry.

import crypto from "node:crypto";
import type { Logger } from "../log.ts";
import type { Credential } from "../pool.ts";
import { redactErrorText } from "../redact.ts";
import {
  markClaudeAccountNeedsReauth,
  readClaudeAccountPoolState,
  replaceClaudeOAuthAccount,
  type ClaudeOAuthAccount,
} from "./anthropic-accounts.ts";
import {
  ClaudeCodeAuthStore,
  claudeCodeAuthToken,
  nativeAnthropicHeaders,
  observedAnthropicHeaders,
  type ClaudeCodeAuthOptions,
} from "./anthropic.ts";
import {
  CLAUDE_OAUTH,
  ClaudeOAuthTokenError,
  refreshClaudeOAuth,
  type FetchLike,
} from "./claude-oauth.ts";

export type ClaudeAccountPoolOptions = Omit<ClaudeCodeAuthOptions, "log" | "fetch"> & {
  home: string;
  log: Logger | Pick<Logger, "info" | "warn">;
  fetch?: FetchLike;
  /** Test seam for the external Claude Code/Desktop login source. */
  current?: ClaudeCodeAuthStore;
};

function credentialId(ownerId: string, ...generation: string[]): string {
  // A fresh access or refresh token must not inherit the previous generation's quarantine. The digest
  // is local runtime identity only; ownerId remains the durable account id shown by admin surfaces.
  const hash = crypto.createHash("sha256");
  for (const part of generation) hash.update(String(part.length)).update(":").update(part);
  return `${ownerId}:${hash.digest("hex").slice(0, 12)}`;
}

/** All account projections in this process share refresh work; the key contains no token material. */
const refreshing = new Map<string, Promise<void>>();

function refreshKey(home: string, account: ClaudeOAuthAccount): string {
  const generation = crypto.createHash("sha256").update(account.refreshToken).digest("hex");
  return `${home}\0${account.id}\0${generation}`;
}

export class ClaudeAccountAuthPool {
  private readonly home: string;
  private readonly now: () => number;
  private readonly log: Pick<Logger, "info" | "warn">;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly current: ClaudeCodeAuthStore;

  constructor(options: ClaudeAccountPoolOptions) {
    this.home = options.home;
    this.now = options.now ?? Date.now;
    this.log = options.log;
    this.fetchImpl = options.fetch;
    this.current = options.current ?? new ClaudeCodeAuthStore(undefined, {
      home: options.home,
      ...(options.observed ? { observed: options.observed } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.credentialReaders ? { credentialReaders: options.credentialReaders } : {}),
    });
  }

  /** Router-local inference eligibility; raw auth reads remain available to other consumers. */
  isCurrentPaused(requestToken?: string): boolean {
    const { accounts, currentPaused } = readClaudeAccountPoolState(this.home);
    if (currentPaused) return true;
    const paused = accounts.filter((account) => account.paused);
    if (paused.length === 0) return false;
    const currentToken = requestToken ?? claudeCodeAuthToken(this.current.get());
    return paused.some((account) => account.token === currentToken);
  }

  /** Refresh all due usable stored accounts, with one network request per account in this process. */
  async refreshIfNeeded(): Promise<void> {
    const { accounts, currentPaused } = readClaudeAccountPoolState(this.home);
    const due = accounts.filter((account) =>
      !account.paused && !account.needsReauth && this.now() >= account.expiresAt - CLAUDE_OAUTH.refreshLeadMs,
    );
    if (due.length === 0) return;
    const pausedAliases = accounts.filter((account) => account.paused && due.some((candidate) => candidate.token === account.token));
    const currentToken = currentPaused || pausedAliases.length > 0 ? claudeCodeAuthToken(this.current.get()) : undefined;
    const nativePaused = currentPaused || pausedAliases.some((account) => account.token === currentToken);
    await Promise.all(due.filter((account) => !(nativePaused && account.token === currentToken)).map((account) => this.refresh(account)));
  }

  private refresh(account: ClaudeOAuthAccount): Promise<void> {
    const key = refreshKey(this.home, account);
    const running = refreshing.get(key);
    if (running) return running;
    const task = refreshClaudeOAuth(account.refreshToken, {
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
      now: this.now,
    }).then(
      (grant) => {
        if (replaceClaudeOAuthAccount(this.home, account.id, account.refreshToken, grant)) {
          this.log.info(`claude account ${account.id.slice(0, 8)}: token refreshed, valid until ${new Date(grant.expiresAt).toISOString()}`);
        }
      },
      (error: Error) => {
        // Only a definitive refresh-token rejection asks the user to sign in again. Network and 5xx
        // failures leave the account recoverable; if its access token expires it simply drops out.
        if (error instanceof ClaudeOAuthTokenError && error.needsReauth) {
          markClaudeAccountNeedsReauth(this.home, account.id, account.refreshToken);
          this.log.warn(`claude account ${account.id.slice(0, 8)}: refresh rejected; sign-in required`);
        } else {
          const detail = redactErrorText(error.message, [account.token, account.refreshToken], 300);
          this.log.warn(`claude account ${account.id.slice(0, 8)}: refresh failed: ${detail}`);
        }
      },
    ).finally(() => refreshing.delete(key));
    refreshing.set(key, task);
    return task;
  }

  /** Fresh credentials for one turn. No token leaves this return value except as an HTTP header. */
  async credentials(): Promise<Credential[]> {
    const ready = this.peekCredentials();
    const refreshing = this.refreshIfNeeded();
    // A due-but-unexpired access token remains usable while its refresh runs. Do not turn the
    // five-minute refresh lead into request latency; wait only when no credential can be sent now.
    if (ready.length > 0) {
      void refreshing.catch((error: Error) => this.log.warn(`claude account refresh task failed: ${error.message}`));
      return ready;
    }
    await refreshing;
    return this.peekCredentials();
  }

  /** Current projection without network I/O; metadata callers can retain paused credentials. */
  peekCredentials(includePaused = false): Credential[] {
    const out: Credential[] = [];
    const { accounts, currentPaused } = readClaudeAccountPoolState(this.home);
    if (!includePaused && currentPaused && !accounts.some((account) => !account.paused && !account.needsReauth && this.now() < account.expiresAt)) return [];
    const current = this.current.get();
    const currentToken = claudeCodeAuthToken(current);
    const nativePaused = currentPaused || accounts.some((account) => account.paused && account.token === currentToken);
    if (!(current instanceof Error) && currentToken && (includePaused || !nativePaused)) {
      if (current.source === "observed") {
        out.push({
          id: credentialId("current", currentToken),
          ownerId: "current",
          label: "Current Claude session",
          paused: nativePaused,
          headers: observedAnthropicHeaders(current.observed),
        });
      } else {
        out.push({
          id: credentialId("current", currentToken),
          ownerId: "current",
          label: "Current Claude login",
          paused: nativePaused,
          headers: nativeAnthropicHeaders({ type: "anthropic", auth: "claude-code" }, current.credentials),
        });
      }
    }
    const currentAccount = accounts.find((account) => account.token === currentToken);
    if (currentAccount && out[0]) out[0].preferred = currentAccount.preferred === true;
    for (const account of accounts) {
      if ((!includePaused && account.paused) || account.needsReauth || this.now() >= account.expiresAt) continue;
      const sameAsCurrent = account.token === currentToken;
      // The legacy file may also be current. Deduplicate inference tokens, but keep paused aliases
      // in metadata so each owner's controls and runtime health remain visible.
      if (sameAsCurrent && !(includePaused && nativePaused)) continue;
      const credential: Credential = {
        id: credentialId(account.id, account.token, account.refreshToken),
        ownerId: account.id,
        label: account.label,
        preferred: account.preferred === true,
        paused: account.paused === true || (sameAsCurrent && nativePaused),
        headers: nativeAnthropicHeaders(
          { type: "anthropic", auth: "claude-code" },
          { accessToken: account.token, expiresAt: account.expiresAt },
        ),
      };
      // The pool tries credentials in this order, so the account the user chose goes ahead of the
      // current login. A conversation already held by another account stays there (its cache).
      if (account.preferred) out.unshift(credential);
      else out.push(credential);
    }
    return out;
  }

  /** Runtime owner aliases for cooldown clearing; a legacy/current duplicate shares one token. */
  cooldownOwners(ownerId: string): string[] {
    const account = readClaudeAccountPoolState(this.home).accounts.find((account) => account.id === ownerId);
    if (!account) return [ownerId];
    const token = claudeCodeAuthToken(this.current.get());
    return account.token === token ? [ownerId, "current"] : [ownerId];
  }

  /** Persist a rejected stored account as requiring re-login. The current CLI account stays external. */
  reject(id: string): void {
    const ownerId = id.split(":", 1)[0]!;
    if (ownerId === "current") return;
    const account = readClaudeAccountPoolState(this.home).accounts.find((candidate) => candidate.id === ownerId);
    // The 401 belongs to the token generation that made the request. A refresh or re-login may have
    // replaced it while the request was in flight; never quarantine that newer grant for an old 401.
    if (!account || credentialId(ownerId, account.token, account.refreshToken) !== id) return;
    markClaudeAccountNeedsReauth(this.home, ownerId, account.refreshToken);
  }
}
