// ClaudeRipple-owned pool of Claude subscription OAuth accounts.
//
// Secrets live only in <home>/claude-accounts.json (0600). The upstream account UUID is never
// persisted or returned: a one-way hash is enough to replace the same human account on re-login.
// The old single-account claude-auth.json is imported atomically on the first pool write so existing
// installs keep working without keeping two mutable copies of one refresh token.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withFileLock, writeJsonAtomic } from "../locked-file.ts";
import { readClaudeAuthFile, removeClaudeAuthFile } from "./anthropic-token-file.ts";

export type ClaudeOAuthAccountGrant = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /** Upstream identity used only to derive subjectHash; never written verbatim. */
  accountId?: string;
  email?: string;
};

export type ClaudeOAuthAccount = {
  /** Local opaque id. Safe to use in routes and admin actions; it is not an upstream account id. */
  id: string;
  token: string;
  refreshToken: string;
  expiresAt: number;
  createdAt: string;
  updatedAt: string;
  label: string;
  /** sha256(upstream account UUID), used only to replace a re-login instead of duplicating it. */
  subjectHash?: string;
  email?: string;
  needsReauth?: boolean;
  /**
   * Tried before the current Claude login and the other accounts. At most one account has it; with
   * none, the current login goes first. A field on the account rather than on the file, so every
   * write that spreads an account keeps it and removing the account clears it.
   */
  preferred?: boolean;
  paused?: boolean;
};

type ClaudeAccountsFile = {
  version: 1;
  accounts: ClaudeOAuthAccount[];
  /** Router-local opt-out for the external login source, independent of its token generation. */
  current?: {
    paused: boolean;
    /** Local owners linked by an exact token at pause time, so rotation or migration cannot orphan resume. */
    aliases?: string[];
  };
};

function withAccountLock<T>(home: string, mutate: () => T): T {
  return withFileLock(claudeAccountsPath(home), mutate);
}

export type ClaudeAccountSummary = {
  id: string;
  label: string;
  email?: string;
  expiresAt: number;
  needsReauth: boolean;
  preferred: boolean;
  paused: boolean;
};

export function claudeAccountsPath(home: string): string {
  return path.join(home, "claude-accounts.json");
}

function validAccount(value: unknown): value is ClaudeOAuthAccount {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const a = value as Partial<ClaudeOAuthAccount>;
  return typeof a.id === "string" && a.id.length > 0
    && typeof a.token === "string" && a.token.length > 0
    && typeof a.refreshToken === "string" && a.refreshToken.length > 0
    && typeof a.expiresAt === "number" && Number.isFinite(a.expiresAt)
    && typeof a.createdAt === "string" && typeof a.updatedAt === "string"
    && typeof a.label === "string" && a.label.length > 0
    && (a.subjectHash === undefined || (typeof a.subjectHash === "string" && /^[0-9a-f]{64}$/.test(a.subjectHash)))
    && (a.email === undefined || typeof a.email === "string")
    && (a.needsReauth === undefined || typeof a.needsReauth === "boolean")
    && (a.preferred === undefined || typeof a.preferred === "boolean")
    && (a.paused === undefined || typeof a.paused === "boolean");
}

function parseClaudeAccountsFile(home: string): ClaudeAccountsFile | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(claudeAccountsPath(home), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || !("version" in parsed) || parsed.version !== 1
      || !("accounts" in parsed) || !Array.isArray(parsed.accounts) || !parsed.accounts.every(validAccount)) return null;
    let current: ClaudeAccountsFile["current"];
    if ("current" in parsed) {
      if (!parsed.current || typeof parsed.current !== "object" || Array.isArray(parsed.current)
        || !("paused" in parsed.current) || typeof parsed.current.paused !== "boolean") return null;
      if ("aliases" in parsed.current) {
        if (!Array.isArray(parsed.current.aliases)
          || !parsed.current.aliases.every((id: unknown): id is string => typeof id === "string" && id.length > 0)) return null;
        current = { paused: parsed.current.paused, aliases: [...parsed.current.aliases] };
      } else {
        current = { paused: parsed.current.paused };
      }
    }
    const seen = new Set<string>();
    const accounts = parsed.accounts.filter((account) => !seen.has(account.id) && seen.add(account.id)).map((account) => ({ ...account }));
    return { version: 1, accounts, ...(current ? { current } : {}) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { version: 1, accounts: [] } : null;
  }
}

/** Read only the multi-account file. Malformed secret storage fails closed as an empty pool. */
export function readClaudeAccountsFile(home: string): ClaudeOAuthAccount[] {
  return parseClaudeAccountsFile(home)?.accounts ?? [];
}

/** An unreadable store cannot silently resume an external login the operator may have paused. */
export function isCurrentClaudeAccountPaused(home: string): boolean {
  const file = parseClaudeAccountsFile(home);
  return file === null || file.current?.paused === true;
}

function applyCurrentPause(file: ClaudeAccountsFile, paused: boolean, currentToken: string | undefined): void {
  const aliases = new Set(file.current?.paused ? file.current.aliases : []);
  for (const account of file.accounts) {
    if (account.token === currentToken) aliases.add(account.id);
  }
  file.current = { paused, ...(paused && aliases.size > 0 ? { aliases: [...aliases] } : {}) };
  const now = new Date().toISOString();
  for (const account of file.accounts) {
    if (!aliases.has(account.id)) continue;
    // Set the alias before an in-flight refresh rotates it; its CAS keeps the latest pause.
    account.paused = paused;
    account.updatedAt = now;
  }
}

export function setCurrentClaudeAccountPaused(home: string, paused: boolean, currentToken?: string): void {
  withAccountLock(home, () => {
    const file = readClaudeOAuthAccountsForMutation(home);
    applyCurrentPause(file, paused, currentToken);
    writeClaudeAccountsFile(home, file);
  });
}

/**
 * Read the pool plus a virtual import of the old single OAuth file. The legacy file is left alone on
 * reads; the next mutation writes it into the pool first and only then removes the old copy.
 */
function withLegacyOAuthAccount(home: string, accounts: ClaudeOAuthAccount[]): ClaudeOAuthAccount[] {
  const legacy = readClaudeAuthFile(home);
  if (legacy?.source !== "oauth") return accounts;
  // If a previous migration wrote the legacy account but crashed before unlinking, do not duplicate
  // it. The refresh token may already have rotated in the new pool, so the durable local id wins.
  if (accounts.some((account) => account.id === "legacy" || account.refreshToken === legacy.refreshToken)) return accounts;
  return [
    ...accounts,
    {
      id: "legacy",
      token: legacy.token,
      refreshToken: legacy.refreshToken,
      expiresAt: legacy.expiresAt,
      createdAt: legacy.createdAt,
      updatedAt: legacy.createdAt,
      label: "Claude account",
    },
  ];
}

/** Fresh account and operator-control snapshot; unreadable storage excludes the native source too. */
export function readClaudeAccountPoolState(home: string): { accounts: ClaudeOAuthAccount[]; currentPaused: boolean } {
  const file = parseClaudeAccountsFile(home);
  if (file === null) return { accounts: [], currentPaused: true };
  // Once a valid pool file exists it is the single source of truth. A retained legacy file (for
  // example where directory fsync is unavailable) must not resurrect an account removed from it.
  return {
    accounts: fs.existsSync(claudeAccountsPath(home)) ? file.accounts : withLegacyOAuthAccount(home, file.accounts),
    currentPaused: file.current?.paused === true,
  };
}

export function readClaudeOAuthAccounts(home: string): ClaudeOAuthAccount[] {
  return readClaudeAccountPoolState(home).accounts;
}

function readClaudeOAuthAccountsForMutation(home: string): ClaudeAccountsFile {
  const file = parseClaudeAccountsFile(home);
  if (file === null) throw new Error("Claude account store is unreadable; refusing to overwrite it");
  if (!fs.existsSync(claudeAccountsPath(home))) file.accounts = withLegacyOAuthAccount(home, file.accounts);
  return file;
}

/** Windows has no directory fsync, so a flushed file plus successful atomic rename completes migration there. */
export function legacyMigrationDurable(directoryDurable: boolean, platform = process.platform): boolean {
  return directoryDurable || platform === "win32";
}

function writeClaudeAccountsFile(home: string, file: ClaudeAccountsFile): void {
  const { directoryDurable } = writeJsonAtomic(claudeAccountsPath(home), file);
  // POSIX keeps the legacy refresh token unless the directory entry is durable; Windows has no
  // directory fsync, so the flushed file + rename is its durability boundary and must complete
  // migration rather than resurrect a removed legacy account.
  const legacy = readClaudeAuthFile(home);
  if (legacyMigrationDurable(directoryDurable) && legacy?.source === "oauth") removeClaudeAuthFile(home);
}

/**
 * The one-way stand-in for an upstream account UUID. It is what identifies "the same human account"
 * across a re-login, both for the pool and for telling the dashboard that a stored account is the
 * current Claude login (anthropic-identity.ts).
 */
export function subjectHash(accountId: string | undefined): string | undefined {
  return accountId ? crypto.createHash("sha256").update(accountId).digest("hex") : undefined;
}

function defaultLabel(accounts: readonly ClaudeOAuthAccount[], email?: string): string {
  if (email) return email;
  return `Claude account ${accounts.length + 1}`;
}

/** Add a distinct account, or atomically replace the same upstream account after re-login. */
export function saveClaudeOAuthAccount(home: string, grant: ClaudeOAuthAccountGrant, now = new Date().toISOString()): ClaudeAccountSummary {
  return withAccountLock(home, () => {
    const file = readClaudeOAuthAccountsForMutation(home);
    const { accounts } = file;
    const hash = subjectHash(grant.accountId);
    const index = hash ? accounts.findIndex((account) => account.subjectHash === hash) : -1;
    const previous = index >= 0 ? accounts[index] : undefined;
    const account: ClaudeOAuthAccount = {
      id: previous?.id ?? crypto.randomUUID(),
      token: grant.accessToken,
      refreshToken: grant.refreshToken,
      expiresAt: grant.expiresAt,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      label: previous?.label ?? defaultLabel(accounts, grant.email),
      ...(previous?.preferred ? { preferred: true } : {}),
      ...(previous?.paused ? { paused: true } : {}),
      ...(hash ? { subjectHash: hash } : previous?.subjectHash ? { subjectHash: previous.subjectHash } : {}),
      ...(grant.email ? { email: grant.email } : previous?.email ? { email: previous.email } : {}),
    };
    if (index >= 0) accounts[index] = account;
    else accounts.push(account);
    writeClaudeAccountsFile(home, file);
    return summarize(account);
  });
}

/** Compare-and-swap a refreshed grant so an older concurrent refresh cannot overwrite a newer one. */
export function replaceClaudeOAuthAccount(
  home: string,
  id: string,
  expectedRefreshToken: string,
  grant: ClaudeOAuthAccountGrant,
  now = new Date().toISOString(),
): boolean {
  return withAccountLock(home, () => {
    const file = readClaudeOAuthAccountsForMutation(home);
    const { accounts } = file;
    const index = accounts.findIndex((account) => account.id === id && account.refreshToken === expectedRefreshToken);
    if (index < 0) return false;
    const previous = accounts[index]!;
    accounts[index] = {
      ...previous,
      token: grant.accessToken,
      refreshToken: grant.refreshToken,
      expiresAt: grant.expiresAt,
      updatedAt: now,
      needsReauth: false,
      ...(grant.email ? { email: grant.email } : {}),
    };
    writeClaudeAccountsFile(home, file);
    return true;
  });
}

/** Mark only the generation that actually failed; a simultaneous successful login wins. */
export function markClaudeAccountNeedsReauth(home: string, id: string, expectedRefreshToken: string): boolean {
  return withAccountLock(home, () => {
    const file = readClaudeOAuthAccountsForMutation(home);
    const { accounts } = file;
    const index = accounts.findIndex((account) => account.id === id && account.refreshToken === expectedRefreshToken);
    if (index < 0) return false;
    accounts[index] = { ...accounts[index]!, needsReauth: true, updatedAt: new Date().toISOString() };
    writeClaudeAccountsFile(home, file);
    return true;
  });
}

export function renameClaudeAccount(home: string, id: string, label: string): boolean {
  return updateClaudeAccount(home, id, { label });
}

export function updateClaudeAccount(home: string, id: string, change: { label?: string; paused?: boolean; preferred?: boolean }, currentToken?: string): boolean {
  const clean = change.label?.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 80);
  if (change.label !== undefined && !clean) return false;
  return withAccountLock(home, () => {
    const file = readClaudeOAuthAccountsForMutation(home);
    const { accounts } = file;
    const index = accounts.findIndex((account) => account.id === id);
    if (index < 0) return false;
    if (change.preferred === true) for (const account of accounts) account.preferred = false;
    accounts[index] = {
      ...accounts[index]!,
      ...(clean ? { label: clean } : {}),
      ...(change.paused !== undefined ? { paused: change.paused } : {}),
      ...(change.preferred !== undefined ? { preferred: change.preferred } : {}),
      updatedAt: new Date().toISOString(),
    };
    if (change.paused !== undefined && (accounts[index]!.token === currentToken
      || (file.current?.paused && file.current.aliases?.includes(id)))) {
      applyCurrentPause(file, change.paused, currentToken);
    }
    writeClaudeAccountsFile(home, file);
    return true;
  });
}

/**
 * Make one stored account the first one tried, or with `null` hand first place back to the current
 * Claude login. False when the id names no stored account.
 */
export function setPreferredClaudeAccount(home: string, id: string | null): boolean {
  return withAccountLock(home, () => {
    const file = readClaudeOAuthAccountsForMutation(home);
    const { accounts } = file;
    if (id !== null && !accounts.some((account) => account.id === id)) return false;
    let changed = false;
    const next = accounts.map((account) => {
      const want = account.id === id;
      if ((account.preferred === true) === want) return account;
      changed = true;
      const { preferred: _, ...rest } = account;
      return want ? { ...rest, preferred: true } : rest;
    });
    if (changed) writeClaudeAccountsFile(home, { ...file, accounts: next });
    return true;
  });
}

export function removeClaudeAccount(home: string, id: string): boolean {
  return withAccountLock(home, () => {
    const file = readClaudeOAuthAccountsForMutation(home);
    const { accounts } = file;
    const next = accounts.filter((account) => account.id !== id);
    if (next.length === accounts.length) return false;
    writeClaudeAccountsFile(home, { ...file, accounts: next });
    return true;
  });
}

export function removeAllClaudeAccounts(home: string): boolean {
  return withAccountLock(home, () => {
    const file = readClaudeOAuthAccountsForMutation(home);
    let removed = removeClaudeAuthFile(home);
    if (file.current?.paused) {
      if (file.accounts.length > 0) {
        writeClaudeAccountsFile(home, { ...file, accounts: [] });
        removed = true;
      }
      return removed;
    }
    try {
      fs.unlinkSync(claudeAccountsPath(home));
      removed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return removed;
  });
}

export function summarize(account: ClaudeOAuthAccount): ClaudeAccountSummary {
  return {
    id: account.id,
    label: account.label,
    ...(account.email ? { email: account.email } : {}),
    expiresAt: account.expiresAt,
    needsReauth: account.needsReauth === true,
    preferred: account.preferred === true,
    paused: account.paused === true,
  };
}

export function listClaudeAccounts(home: string): ClaudeAccountSummary[] {
  return readClaudeOAuthAccounts(home).map(summarize);
}

export type ClaudeAccountSummaryWithSubject = ClaudeAccountSummary & {
  /** The same one-way id the pool stores. Only ever compared; the GUI is never shown it. */
  subjectHash?: string;
};

/** `listClaudeAccounts` plus `subjectHash`, for deciding whether a stored account is the current login. */
export function listClaudeAccountsWithSubject(home: string): ClaudeAccountSummaryWithSubject[] {
  return readClaudeOAuthAccounts(home).map((account) => ({
    ...summarize(account),
    ...(account.subjectHash ? { subjectHash: account.subjectHash } : {}),
  }));
}
