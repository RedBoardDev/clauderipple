// Runtime projection of Claude subscription accounts. The current Claude login stays externally
// owned; ClaudeRipple refreshes only grants in its private account file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CredentialPool } from "../src/pool.ts";
import { ClaudeAccountAuthPool } from "../src/providers/anthropic-account-pool.ts";
import {
  claudeAccountsPath,
  listClaudeAccounts,
  markClaudeAccountNeedsReauth,
  readClaudeAccountsFile,
  replaceClaudeOAuthAccount,
  saveClaudeOAuthAccount,
  setCurrentClaudeAccountPaused,
  setPreferredClaudeAccount,
  updateClaudeAccount,
} from "../src/providers/anthropic-accounts.ts";
import { ClaudeCodeAuthStore, ClaudeCodeCredentialStore, claudeCodeAuthToken } from "../src/providers/anthropic.ts";
import { ObservedClaudeCodeAuth } from "../src/providers/anthropic-observed.ts";
import { saveClaudeOAuthFile } from "../src/providers/anthropic-token-file.ts";

function home(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cr-claude-account-pool-"));
}

const log = () => {
  const info: string[] = [];
  const warn: string[] = [];
  return { info, warn, logger: { info: (line: string) => info.push(line), warn: (line: string) => warn.push(line) } };
};

const credentialReaders = { keychain: () => null, credentialsFile: () => null };

function noCurrent(dir: string, now: () => number): ClaudeCodeAuthStore {
  return new ClaudeCodeAuthStore(new ClaudeCodeCredentialStore(() => null, now), { home: dir, env: {}, now, credentialReaders });
}

function currentLogin(dir: string, now: () => number, accessToken = "current-access"): ClaudeCodeAuthStore {
  return new ClaudeCodeAuthStore(
    new ClaudeCodeCredentialStore(() => JSON.stringify({ claudeAiOauth: { accessToken, expiresAt: 9_000_000 } }), now),
    { home: dir, env: {}, now, credentialReaders },
  );
}

test("the current Claude login is first and stored accounts follow without exposing refresh tokens", () => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    saveClaudeOAuthAccount(dir, { accessToken: "stored-access", refreshToken: "stored-refresh", expiresAt: 9_000_000, accountId: "stored-id" });
    const current = new ClaudeCodeAuthStore(
      new ClaudeCodeCredentialStore(() => JSON.stringify({ claudeAiOauth: { accessToken: "current-access", expiresAt: 9_000_000 } }), now),
      { home: dir, env: {}, now, credentialReaders },
    );
    const pool = new ClaudeAccountAuthPool({ home: dir, now, current, log: log().logger });
    const credentials = pool.peekCredentials();
    const stored = readClaudeAccountsFile(dir)[0]!;
    assert.match(credentials[0]!.id, /^current:/);
    assert.equal(credentials[0]!.ownerId, "current");
    assert.match(credentials[1]!.id, new RegExp(`^${stored.id}:`));
    assert.equal(credentials[1]!.ownerId, stored.id);
    assert.equal(credentials[0]!.headers.authorization, "Bearer current-access");
    assert.equal(credentials[1]!.headers.authorization, "Bearer stored-access");
    assert.doesNotMatch(JSON.stringify(credentials), /stored-refresh/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("current pause checks skip native auth when persisted controls decide eligibility", (t) => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    const readers = { keychain: t.mock.fn(() => null), credentialsFile: t.mock.fn(() => null) };
    const current = new ClaudeCodeAuthStore(undefined, { home: dir, env: {}, now, credentialReaders: readers });
    const get = t.mock.method(current, "get");
    const pool = new ClaudeAccountAuthPool({ home: dir, now, current, log: log().logger });
    assert.equal(pool.isCurrentPaused(), false, "an empty pool has no paused alias to resolve");
    const stored = saveClaudeOAuthAccount(dir, { accessToken: "stored-access", refreshToken: "stored-refresh", expiresAt: 9_000_000 });
    assert.equal(pool.isCurrentPaused(), false, "unpaused accounts cannot exclude the native login");
    updateClaudeAccount(dir, stored.id, { paused: true });
    setCurrentClaudeAccountPaused(dir, true);
    assert.equal(pool.isCurrentPaused(), true, "native pause needs no current token, even with a paused stored account");
    fs.writeFileSync(claudeAccountsPath(dir), "{");
    assert.equal(pool.isCurrentPaused(), true, "an unreadable store fails closed without resolving auth");
    assert.equal(get.mock.callCount(), 0);
    assert.equal(readers.keychain.mock.callCount(), 0);
    assert.equal(readers.credentialsFile.mock.callCount(), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("current pause checks use a supplied request token instead of the raw current login", (t) => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    const account = saveClaudeOAuthAccount(dir, { accessToken: "request-access", refreshToken: "request-refresh", expiresAt: 9_000_000 });
    updateClaudeAccount(dir, account.id, { paused: true });
    const current = currentLogin(dir, now, "raw-current-access");
    const get = t.mock.method(current, "get");
    const pool = new ClaudeAccountAuthPool({ home: dir, now, current, log: log().logger });
    assert.equal(pool.isCurrentPaused("request-access"), true, "an unobserved request may carry the paused stored token");
    assert.equal(pool.isCurrentPaused("raw-current-access"), false);
    assert.equal(pool.isCurrentPaused(""), false, "an explicit empty override must not resolve another token");
    assert.equal(get.mock.callCount(), 0);
    assert.equal(pool.isCurrentPaused(), false, "without an override the raw current login still decides");
    assert.equal(get.mock.callCount(), 1);
    setCurrentClaudeAccountPaused(dir, true);
    assert.equal(pool.isCurrentPaused("raw-current-access"), true, "a persisted native pause excludes every request token");
    assert.equal(get.mock.callCount(), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a persisted native pause avoids auth reads when no stored grant is inference-eligible", async (t) => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    const readers = { keychain: t.mock.fn(() => null), credentialsFile: t.mock.fn(() => null) };
    const current = new ClaudeCodeAuthStore(undefined, { home: dir, env: {}, now, credentialReaders: readers });
    const get = t.mock.method(current, "get");
    const refresh = t.mock.fn(async () => { throw new Error("unexpected refresh"); });
    const pool = new ClaudeAccountAuthPool({ home: dir, now, current, fetch: refresh, log: log().logger });
    setCurrentClaudeAccountPaused(dir, true);
    assert.deepEqual(await pool.credentials(), []);
    const paused = saveClaudeOAuthAccount(dir, { accessToken: "paused-access", refreshToken: "paused-refresh", expiresAt: now() - 1 });
    updateClaudeAccount(dir, paused.id, { paused: true });
    const rejected = saveClaudeOAuthAccount(dir, { accessToken: "rejected-access", refreshToken: "rejected-refresh", expiresAt: 9_000_000 });
    markClaudeAccountNeedsReauth(dir, rejected.id, "rejected-refresh");
    assert.deepEqual(await pool.credentials(), []);
    assert.equal(get.mock.callCount(), 0);
    assert.equal(readers.keychain.mock.callCount(), 0);
    assert.equal(readers.credentialsFile.mock.callCount(), 0);
    assert.equal(refresh.mock.callCount(), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("metadata projection keeps paused current and valid stored credentials without selecting them", () => {
  for (const source of ["stored", "observed"]) {
    const dir = home();
    try {
      const now = () => 1_000_000;
      const alias = saveClaudeOAuthAccount(dir, { accessToken: "current-access", refreshToken: "alias-refresh", expiresAt: 9_000_000 });
      const paused = saveClaudeOAuthAccount(dir, { accessToken: "paused-access", refreshToken: "paused-refresh", expiresAt: 9_000_000 });
      updateClaudeAccount(dir, paused.id, { paused: true, preferred: true });
      const ready = saveClaudeOAuthAccount(dir, { accessToken: "ready-access", refreshToken: "ready-refresh", expiresAt: 9_000_000 });
      saveClaudeOAuthAccount(dir, { accessToken: "expired-access", refreshToken: "expired-refresh", expiresAt: now() });
      const rejected = saveClaudeOAuthAccount(dir, { accessToken: "rejected-access", refreshToken: "rejected-refresh", expiresAt: 9_000_000 });
      markClaudeAccountNeedsReauth(dir, rejected.id, "rejected-refresh");
      // Older native metadata did not necessarily copy the pause onto the exact-token stored alias.
      fs.writeFileSync(claudeAccountsPath(dir), JSON.stringify({ version: 1, accounts: readClaudeAccountsFile(dir), current: { paused: true } }));
      const observed = new ObservedClaudeCodeAuth();
      observed.observe(["authorization", "Bearer current-access"], now());
      const current = source === "observed"
        ? new ClaudeCodeAuthStore(undefined, { home: dir, env: {}, now, credentialReaders, observed })
        : currentLogin(dir, now);
      const pool = new ClaudeAccountAuthPool({ home: dir, now, current, log: log().logger });
      assert.deepEqual(pool.peekCredentials().map((credential) => credential.ownerId), [ready.id], source);
      const metadata = pool.peekCredentials(true);
      assert.deepEqual(metadata.map((credential) => [credential.ownerId, credential.paused]), [
        [paused.id, true], ["current", true], [alias.id, true], [ready.id, false],
      ], source);
      assert.equal(metadata[0]!.preferred, true);
      const reports = new CredentialPool({ now }).report("claude", metadata);
      assert.deepEqual(reports.filter((row) => row.inUse).map((row) => metadata.find((credential) => credential.id === row.id)!.ownerId), [ready.id]);
      assert.equal(reports.some((row) => row.paused && row.inUse), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("metadata projection marks exact-token native exclusions paused and preserves unpaused deduplication", () => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    const alias = saveClaudeOAuthAccount(dir, { accessToken: "current-access", refreshToken: "alias-refresh", expiresAt: 9_000_000 });
    setPreferredClaudeAccount(dir, alias.id);
    const pool = new ClaudeAccountAuthPool({ home: dir, now, current: currentLogin(dir, now), log: log().logger });
    assert.deepEqual(pool.peekCredentials().map((credential) => credential.ownerId), ["current"]);
    assert.deepEqual(pool.peekCredentials(true).map((credential) => credential.ownerId), ["current"]);
    assert.equal(pool.peekCredentials(true)[0]!.preferred, true);
    updateClaudeAccount(dir, alias.id, { paused: true });
    assert.deepEqual(pool.peekCredentials(), []);
    const metadata = pool.peekCredentials(true);
    assert.deepEqual(metadata.map((credential) => [credential.ownerId, credential.paused]), [[alias.id, true], ["current", true]]);
    assert.equal(new CredentialPool({ now }).pick("claude", metadata), null);
    assert.equal(new CredentialPool({ now }).report("claude", metadata).some((row) => row.inUse), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a persisted native pause still refreshes and projects an expired independent stored grant", async (t) => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    const account = saveClaudeOAuthAccount(dir, { accessToken: "expired-access", refreshToken: "stored-refresh", expiresAt: now() - 1 });
    setCurrentClaudeAccountPaused(dir, true);
    const refresh = t.mock.fn(async () => new Response(JSON.stringify({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 7200 }), { status: 200 }));
    const pool = new ClaudeAccountAuthPool({ home: dir, now, current: currentLogin(dir, now), fetch: refresh, log: log().logger });
    const credentials = await pool.credentials();
    assert.equal(refresh.mock.callCount(), 1);
    assert.deepEqual(credentials.map((credential) => [credential.ownerId, credential.headers.authorization]), [[account.id, "Bearer fresh-access"]]);
    assert.equal(pool.isCurrentPaused(), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stored refresh skips native auth without due accounts or possible paused aliases", async (t) => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    const readers = { keychain: t.mock.fn(() => null), credentialsFile: t.mock.fn(() => null) };
    const current = new ClaudeCodeAuthStore(undefined, { home: dir, env: {}, now, credentialReaders: readers });
    const get = t.mock.method(current, "get");
    const refresh = t.mock.fn(async () => new Response(JSON.stringify({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 7200 }), { status: 200 }));
    const pool = new ClaudeAccountAuthPool({ home: dir, now, current, fetch: refresh, log: log().logger });
    await pool.refreshIfNeeded();
    saveClaudeOAuthAccount(dir, { accessToken: "not-due-access", refreshToken: "not-due-refresh", expiresAt: 9_000_000 });
    await pool.refreshIfNeeded();
    const paused = saveClaudeOAuthAccount(dir, { accessToken: "paused-access", refreshToken: "paused-refresh", expiresAt: now() + 1_000 });
    updateClaudeAccount(dir, paused.id, { paused: true });
    const rejected = saveClaudeOAuthAccount(dir, { accessToken: "rejected-access", refreshToken: "rejected-refresh", expiresAt: now() + 1_000 });
    markClaudeAccountNeedsReauth(dir, rejected.id, "rejected-refresh");
    setCurrentClaudeAccountPaused(dir, true);
    await pool.refreshIfNeeded();
    assert.equal(refresh.mock.callCount(), 0);
    assert.equal(get.mock.callCount(), 0, "native pause is irrelevant when nothing can refresh");
    setCurrentClaudeAccountPaused(dir, false);
    saveClaudeOAuthAccount(dir, { accessToken: "due-access", refreshToken: "due-refresh", expiresAt: now() + 1_000 });
    await pool.refreshIfNeeded();
    assert.equal(refresh.mock.callCount(), 1);
    assert.equal(get.mock.callCount(), 0, "an unrelated stored pause cannot exclude the due grant");
    assert.equal(readers.keychain.mock.callCount(), 0);
    assert.equal(readers.credentialsFile.mock.callCount(), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("credential projection reads one combined account snapshot per phase", async (t) => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    saveClaudeOAuthAccount(dir, { accessToken: "stored-access", refreshToken: "stored-refresh", expiresAt: 9_000_000 });
    const pool = new ClaudeAccountAuthPool({ home: dir, now, current: currentLogin(dir, now), log: log().logger });
    const reads = t.mock.method(fs, "readFileSync");
    const credentials = await pool.credentials();
    assert.equal(credentials.length, 2);
    assert.equal(reads.mock.calls.filter((call) => call.arguments[0] === claudeAccountsPath(dir)).length, 2,
      "one snapshot projects credentials and one checks for due refreshes");
    assert.equal(pool.peekCredentials(true).length, 2);
    assert.equal(reads.mock.calls.filter((call) => call.arguments[0] === claudeAccountsPath(dir)).length, 3,
      "metadata projection also reads only one fresh combined snapshot");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("only a paused current-token alias excludes an otherwise due stored grant", async (t) => {
  for (const currentToken of ["shared-access", "independent-current"]) {
    const dir = home();
    try {
      const now = () => 1_000_000;
      const paused = saveClaudeOAuthAccount(dir, { accessToken: "shared-access", refreshToken: "paused-refresh", expiresAt: 9_000_000 });
      updateClaudeAccount(dir, paused.id, { paused: true });
      saveClaudeOAuthAccount(dir, { accessToken: "shared-access", refreshToken: "due-refresh", expiresAt: now() + 1_000 });
      const current = currentLogin(dir, now, currentToken);
      const get = t.mock.method(current, "get");
      const refresh = t.mock.fn(async () => new Response(JSON.stringify({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 7200 }), { status: 200 }));
      const pool = new ClaudeAccountAuthPool({ home: dir, now, current, fetch: refresh, log: log().logger });
      await pool.refreshIfNeeded();
      assert.equal(get.mock.callCount(), 1, "only auth can tell whether the paused alias is current");
      assert.equal(refresh.mock.callCount(), currentToken === "shared-access" ? 0 : 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a persisted current pause excludes only the native login and its exact-token aliases", async () => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    saveClaudeOAuthAccount(dir, { accessToken: "current-access", refreshToken: "alias-refresh", expiresAt: now() + 1_000 });
    const other = saveClaudeOAuthAccount(dir, { accessToken: "other-access", refreshToken: "other-refresh", expiresAt: 9_000_000 });
    // Older metadata may not have copied the pause to aliases; even then no refresh may bypass it.
    fs.writeFileSync(claudeAccountsPath(dir), JSON.stringify({ version: 1, accounts: readClaudeAccountsFile(dir), current: { paused: true } }));
    let calls = 0;
    const pool = new ClaudeAccountAuthPool({
      home: dir, now, current: currentLogin(dir, now), log: log().logger,
      fetch: async () => { calls += 1; throw new Error("unexpected refresh"); },
    });
    assert.equal(pool.isCurrentPaused(), true);
    assert.deepEqual(pool.peekCredentials().map((credential) => credential.ownerId), [other.id]);
    assert.deepEqual((await pool.credentials()).map((credential) => credential.ownerId), [other.id]);
    await pool.refreshIfNeeded();
    assert.equal(calls, 0);
    assert.equal(readClaudeAccountsFile(dir)[0]!.token, "current-access");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a paused due account is not refreshed or reintroduced as the current login", async () => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    const account = saveClaudeOAuthAccount(dir, { accessToken: "current-access", refreshToken: "paused-refresh", expiresAt: now() + 1_000 });
    updateClaudeAccount(dir, account.id, { paused: true });
    const current = new ClaudeCodeAuthStore(
      new ClaudeCodeCredentialStore(() => JSON.stringify({ claudeAiOauth: { accessToken: "current-access", expiresAt: 9_000_000 } }), now),
      { home: dir, env: {}, now, credentialReaders },
    );
    let calls = 0;
    const pool = new ClaudeAccountAuthPool({
      home: dir, now, current, log: log().logger,
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 7200 }), { status: 200 });
      },
    });
    assert.equal(pool.isCurrentPaused(), true, "an exact-token stored pause suppresses native inference too");
    assert.deepEqual(await pool.credentials(), []);
    assert.equal(calls, 0);
    assert.equal(readClaudeAccountsFile(dir)[0]!.token, "current-access");
    assert.deepEqual(pool.peekCredentials(), []);
    updateClaudeAccount(dir, account.id, { paused: false });
    assert.equal(pool.isCurrentPaused(), false);
    assert.equal(pool.peekCredentials()[0]!.ownerId, "current");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("native source pause survives fresh auth stores and token replacement until explicit resume", async () => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    const stored = saveClaudeOAuthAccount(dir, { accessToken: "other-access", refreshToken: "other-refresh", expiresAt: now() + 1_000 });
    updateClaudeAccount(dir, stored.id, { paused: true });
    const current = currentLogin(dir, now);
    let calls = 0;
    const options = {
      home: dir, now, current, log: log().logger,
      fetch: async () => { calls += 1; throw new Error("unexpected refresh"); },
    };
    const pool = new ClaudeAccountAuthPool(options);
    assert.equal(pool.isCurrentPaused(), false);
    assert.equal(pool.peekCredentials()[0]!.ownerId, "current");
    setCurrentClaudeAccountPaused(dir, true, "current-access");
    assert.equal(pool.isCurrentPaused(), true);
    assert.deepEqual(await pool.credentials(), []);
    assert.deepEqual(current.get(), { source: "stored", credentials: { accessToken: "current-access", expiresAt: 9_000_000 } });

    const replacedCurrent = currentLogin(dir, now, "external-replacement");
    const reloaded = new ClaudeAccountAuthPool({ ...options, current: replacedCurrent });
    assert.equal(reloaded.isCurrentPaused(), true);
    assert.deepEqual(await reloaded.credentials(), []);
    setCurrentClaudeAccountPaused(dir, false, "external-replacement");
    assert.equal(reloaded.isCurrentPaused(), false);
    assert.deepEqual((await reloaded.credentials()).map((credential) => [credential.ownerId, credential.headers.authorization]), [
      ["current", "Bearer external-replacement"],
    ]);
    assert.equal(readClaudeAccountsFile(dir)[0]!.paused, true, "resuming native does not resume an independent stored grant");
    assert.deepEqual(replacedCurrent.get(), { source: "stored", credentials: { accessToken: "external-replacement", expiresAt: 9_000_000 } });
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("current pause and resume apply to an observed session without mutating raw auth", () => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    const observed = new ObservedClaudeCodeAuth();
    observed.observe(["authorization", "Bearer observed-current", "anthropic-version", "2023-06-01"], now());
    const current = new ClaudeCodeAuthStore(undefined, { home: dir, env: {}, credentialReaders, now, observed });
    const pool = new ClaudeAccountAuthPool({ home: dir, env: {}, credentialReaders, now, observed, log: log().logger });
    const before = current.get();
    assert.equal(pool.isCurrentPaused(), false);
    assert.equal(pool.peekCredentials()[0]!.headers.authorization, "Bearer observed-current");
    setCurrentClaudeAccountPaused(dir, true, "observed-current");
    assert.equal(pool.isCurrentPaused(), true);
    assert.deepEqual(pool.peekCredentials(), []);
    assert.deepEqual(current.get(), before);
    assert.equal(current.describeSource(), "observed");
    observed.observe(["authorization", "Bearer observed-replacement"], now());
    assert.deepEqual(pool.peekCredentials(), [], "a new observed token does not resume the source");
    setCurrentClaudeAccountPaused(dir, false, "observed-replacement");
    assert.equal(pool.isCurrentPaused(), false);
    assert.equal(pool.peekCredentials()[0]!.headers.authorization, "Bearer observed-replacement");
    assert.equal(current.describeSource(), "observed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("native pause and resume restore inference when legacy OAuth is the only current source", () => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    saveClaudeOAuthFile(dir, { accessToken: "legacy-access", refreshToken: "legacy-refresh", expiresAt: 9_000_000 });
    const current = new ClaudeCodeAuthStore(undefined, { home: dir, env: {}, now, credentialReaders });
    const pool = new ClaudeAccountAuthPool({ home: dir, now, current, log: log().logger });
    assert.deepEqual(current.get(), { source: "token-file", credentials: { accessToken: "legacy-access", expiresAt: 9_000_000 } });
    assert.deepEqual(pool.peekCredentials().map((credential) => credential.headers.authorization), ["Bearer legacy-access"]);
    setCurrentClaudeAccountPaused(dir, true, claudeCodeAuthToken(current.get()));
    assert.equal(pool.isCurrentPaused(), true);
    assert.deepEqual(pool.peekCredentials(), []);
    setCurrentClaudeAccountPaused(dir, false, claudeCodeAuthToken(current.get()));
    assert.equal(pool.isCurrentPaused(), false);
    assert.deepEqual(pool.peekCredentials().map((credential) => credential.headers.authorization), ["Bearer legacy-access"],
      "resuming the native source must restore its only legacy OAuth credential");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("current pause and resume suppress all exact-token stored aliases without losing auth", () => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    const alias = saveClaudeOAuthAccount(dir, { accessToken: "current-access", refreshToken: "alias-refresh", expiresAt: 9_000_000 });
    const current = currentLogin(dir, now);
    const pool = new ClaudeAccountAuthPool({ home: dir, now, current, log: log().logger });
    const before = pool.peekCredentials()[0]!;
    setCurrentClaudeAccountPaused(dir, true, "current-access");
    assert.equal(readClaudeAccountsFile(dir)[0]!.paused, true);
    assert.equal(pool.isCurrentPaused(), true);
    assert.deepEqual(pool.peekCredentials(), []);
    setCurrentClaudeAccountPaused(dir, false, "current-access");
    assert.equal(readClaudeAccountsFile(dir)[0]!.paused, false);
    const [resumed] = pool.peekCredentials();
    assert.equal(resumed!.id, before.id);
    assert.equal(resumed!.headers.authorization, "Bearer current-access");
    assert.equal(readClaudeAccountsFile(dir)[0]!.id, alias.id);
    assert.equal(readClaudeAccountsFile(dir)[0]!.refreshToken, "alias-refresh");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pause and resume during shared refresh preserve the latest alias controls across token rotation", async () => {
  for (const paused of [true, false]) {
    const dir = home();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const refreshes: Promise<void>[] = [];
    try {
      const now = () => 1_000_000;
      const alias = saveClaudeOAuthAccount(dir, { accessToken: "current-access", refreshToken: "alias-refresh", expiresAt: now() - 1 });
      let calls = 0;
      const options = {
        home: dir, now, current: currentLogin(dir, now), log: log().logger,
        fetch: async () => {
          calls += 1;
          await held;
          return new Response(JSON.stringify({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 7200 }), { status: 200 });
        },
      };
      const firstPool = new ClaudeAccountAuthPool(options);
      const secondPool = new ClaudeAccountAuthPool({ ...options, current: currentLogin(dir, now) });
      refreshes.push(firstPool.refreshIfNeeded(), secondPool.refreshIfNeeded());
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 1);
      setCurrentClaudeAccountPaused(dir, true, "current-access");
      assert.deepEqual(firstPool.peekCredentials(), []);
      assert.deepEqual(secondPool.peekCredentials(), []);
      updateClaudeAccount(dir, alias.id, { paused }, "current-access");
      assert.equal(firstPool.isCurrentPaused(), paused);
      release();
      await Promise.all(refreshes);
      const stored = readClaudeAccountsFile(dir).find((account) => account.id === alias.id)!;
      assert.equal(stored.token, "rotated-access");
      assert.equal(stored.refreshToken, "rotated-refresh");
      assert.equal(stored.paused, paused, "refresh CAS must spread the latest pause or resume written after it started");
      const expectedOwners = paused ? [] : ["current", alias.id];
      assert.deepEqual((await firstPool.credentials()).map((credential) => credential.ownerId), expectedOwners);
      assert.deepEqual((await secondPool.credentials()).map((credential) => credential.ownerId), expectedOwners);
      assert.equal(firstPool.isCurrentPaused(), paused);
      assert.equal(calls, 1);
      const reloaded = new ClaudeAccountAuthPool({ ...options, current: currentLogin(dir, now) });
      assert.deepEqual(reloaded.peekCredentials().map((credential) => credential.ownerId), expectedOwners);
    } finally {
      release();
      await Promise.all(refreshes);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("corrupt account storage suppresses native inference without changing raw auth", async () => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    const current = currentLogin(dir, now);
    const raw = current.get();
    fs.writeFileSync(claudeAccountsPath(dir), "{");
    let calls = 0;
    const pool = new ClaudeAccountAuthPool({
      home: dir, now, current, log: log().logger,
      fetch: async () => { calls += 1; throw new Error("unexpected refresh"); },
    });
    assert.equal(pool.isCurrentPaused(), true);
    assert.deepEqual(pool.peekCredentials(), []);
    assert.deepEqual(await pool.credentials(), []);
    assert.equal(calls, 0);
    assert.deepEqual(current.get(), raw);
    assert.equal(fs.readFileSync(claudeAccountsPath(dir), "utf8"), "{");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a preferred stored account leads the current login, and clearing it hands first place back", () => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    const first = saveClaudeOAuthAccount(dir, { accessToken: "a-access", refreshToken: "a-refresh", expiresAt: 9_000_000, accountId: "a" });
    const second = saveClaudeOAuthAccount(dir, { accessToken: "b-access", refreshToken: "b-refresh", expiresAt: 9_000_000, accountId: "b" });
    const current = new ClaudeCodeAuthStore(
      new ClaudeCodeCredentialStore(() => JSON.stringify({ claudeAiOauth: { accessToken: "current-access", expiresAt: 9_000_000 } }), now),
      { home: dir, env: {}, now, credentialReaders },
    );
    const pool = new ClaudeAccountAuthPool({ home: dir, now, current, log: log().logger });
    const order = () => pool.peekCredentials().map((c) => c.ownerId);
    assert.deepEqual(order(), ["current", first.id, second.id]);

    assert.equal(setPreferredClaudeAccount(dir, second.id), true);
    assert.deepEqual(order(), [second.id, "current", first.id]);
    assert.equal(setPreferredClaudeAccount(dir, first.id), true);
    assert.deepEqual(order(), [first.id, "current", second.id], "only one account is preferred at a time");
    assert.deepEqual(listClaudeAccounts(dir).map((a) => a.preferred), [true, false]);

    // A refresh rewrites the account; the choice survives it.
    replaceClaudeOAuthAccount(dir, first.id, "a-refresh", { accessToken: "a2", refreshToken: "a2-refresh", expiresAt: 9_000_000 });
    assert.equal(order()[0], first.id);

    assert.equal(setPreferredClaudeAccount(dir, "missing"), false);
    assert.equal(setPreferredClaudeAccount(dir, null), true);
    assert.deepEqual(order(), ["current", first.id, second.id]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a changed current Claude login gets a fresh runtime identity", () => {
  const dir = home();
  try {
    let time = 1_000_000;
    let accessToken = "current-old";
    const now = () => time;
    const current = new ClaudeCodeAuthStore(
      new ClaudeCodeCredentialStore(
        () => JSON.stringify({ claudeAiOauth: { accessToken, expiresAt: 9_000_000 } }),
        now,
      ),
      { home: dir, env: {}, now, credentialReaders },
    );
    const pool = new ClaudeAccountAuthPool({ home: dir, now, current, log: log().logger });
    const before = pool.peekCredentials()[0]!;

    accessToken = "current-new";
    time += 60_000;
    const after = pool.peekCredentials()[0]!;

    assert.equal(before.ownerId, "current");
    assert.equal(after.ownerId, "current");
    assert.notEqual(after.id, before.id);
    assert.equal(after.headers.authorization, "Bearer current-new");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent callers share one refresh and persist the rotated grant", async () => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    const account = saveClaudeOAuthAccount(dir, { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: now() - 1, accountId: "one" });
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = async (_url: string, init: RequestInit): Promise<Response> => {
      calls += 1;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.equal(body.refresh_token, "old-refresh");
      await held;
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 7200 }), { status: 200 });
    };
    const lines = log();
    const pool = new ClaudeAccountAuthPool({ home: dir, now, current: noCurrent(dir, now), fetch: fetchImpl, log: lines.logger });
    const first = pool.credentials();
    const second = pool.credentials();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a[0]!.headers.authorization, "Bearer new-access");
    assert.equal(b[0]!.headers.authorization, "Bearer new-access");
    const stored = readClaudeAccountsFile(dir).find((candidate) => candidate.id === account.id)!;
    assert.equal(stored.refreshToken, "new-refresh");
    assert.equal(stored.expiresAt, now() + 7_200_000);
    assert.ok(lines.info.some((line) => /token refreshed/.test(line)));
    assert.doesNotMatch(lines.info.join("\n"), /old-refresh|new-refresh|old-access|new-access/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("separate account-pool projections share one refresh for the same grant generation", async () => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    saveClaudeOAuthAccount(dir, { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: now() - 1, accountId: "one" });
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = async (): Promise<Response> => {
      calls += 1;
      await held;
      return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 7200 }), { status: 200 });
    };
    const options = { home: dir, now, current: noCurrent(dir, now), fetch: fetchImpl, log: log().logger };
    const proxyProjection = new ClaudeAccountAuthPool(options);
    const ingressProjection = new ClaudeAccountAuthPool(options);

    const first = proxyProjection.credentials();
    const second = ingressProjection.credentials();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a[0]!.headers.authorization, "Bearer new-access");
    assert.equal(b[0]!.headers.authorization, "Bearer new-access");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a slow refresh does not block an independent current login", async () => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    saveClaudeOAuthAccount(dir, { accessToken: "due-access", refreshToken: "due-refresh", expiresAt: now() + 1_000, accountId: "due" });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const current = new ClaudeCodeAuthStore(
      new ClaudeCodeCredentialStore(() => JSON.stringify({ claudeAiOauth: { accessToken: "current-access", expiresAt: 9_000_000 } }), now),
      { home: dir, env: {}, now, credentialReaders },
    );
    const pool = new ClaudeAccountAuthPool({
      home: dir,
      now,
      current,
      log: log().logger,
      fetch: async () => {
        await held;
        return new Response(JSON.stringify({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 7200 }), { status: 200 });
      },
    });
    const race = await Promise.race([
      pool.credentials().then((credentials) => credentials[0]!.headers.authorization),
      new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ]);
    assert.equal(race, "Bearer current-access");
    release();
    await pool.refreshIfNeeded();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a refreshed or re-signed-in grant gets a new runtime identity without changing its owner id", async () => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    const first = saveClaudeOAuthAccount(dir, { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 9_000_000, accountId: "same" });
    const pool = new ClaudeAccountAuthPool({ home: dir, now, current: noCurrent(dir, now), log: log().logger });
    const before = pool.peekCredentials()[0]!;
    const second = saveClaudeOAuthAccount(dir, { accessToken: "new-access", refreshToken: "old-refresh", expiresAt: 9_000_000, accountId: "same" });
    const afterAccessOnly = pool.peekCredentials()[0]!;
    assert.equal(second.id, first.id);
    assert.equal(before.ownerId, first.id);
    assert.equal(afterAccessOnly.ownerId, first.id);
    assert.notEqual(afterAccessOnly.id, before.id, "an access-token-only rotation is a new runtime generation");
    saveClaudeOAuthAccount(dir, { accessToken: "newer-access", refreshToken: "new-refresh", expiresAt: 9_000_000, accountId: "same" });
    const afterBoth = pool.peekCredentials()[0]!;
    assert.equal(afterBoth.ownerId, first.id);
    assert.notEqual(afterBoth.id, afterAccessOnly.id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a 401 from an old runtime generation cannot quarantine a refreshed grant", () => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    const account = saveClaudeOAuthAccount(dir, { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 9_000_000, accountId: "same" });
    const pool = new ClaudeAccountAuthPool({ home: dir, now, current: noCurrent(dir, now), log: log().logger });
    const oldRuntimeId = pool.peekCredentials()[0]!.id;
    saveClaudeOAuthAccount(dir, { accessToken: "new-access", refreshToken: "new-refresh", expiresAt: 9_000_000, accountId: "same" });
    pool.reject(oldRuntimeId);
    const stored = readClaudeAccountsFile(dir).find((candidate) => candidate.id === account.id)!;
    assert.notEqual(stored.needsReauth, true);
    assert.equal(pool.peekCredentials()[0]!.headers.authorization, "Bearer new-access");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("refresh transport errors cannot reflect account secrets into logs", async () => {
  const dir = home();
  try {
    const now = () => 1_000_000;
    saveClaudeOAuthAccount(dir, { accessToken: "opaque-access-secret", refreshToken: "opaque-refresh-secret", expiresAt: now() + 1_000, accountId: "secret-error" });
    const lines = log();
    const pool = new ClaudeAccountAuthPool({
      home: dir,
      now,
      current: noCurrent(dir, now),
      log: lines.logger,
      fetch: async () => { throw new Error("opaque-access-secret\nrefresh_token=opaque-refresh-secret"); },
    });
    await pool.refreshIfNeeded();
    assert.doesNotMatch(lines.warn.join("\n"), /opaque-(?:access|refresh)-secret/);
    assert.doesNotMatch(lines.warn.join("\n"), /\n/);
    assert.match(lines.warn.join("\n"), /\[REDACTED\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid_grant requires reauthentication, while a transient endpoint failure does not", async () => {
  for (const scenario of [
    { name: "rejected", status: 400, body: { error: "invalid_grant" }, needsReauth: true },
    { name: "transient", status: 503, body: { error: "unavailable" }, needsReauth: false },
  ]) {
    const dir = home();
    try {
      const now = () => 1_000_000;
      const account = saveClaudeOAuthAccount(dir, { accessToken: `${scenario.name}-access`, refreshToken: `${scenario.name}-refresh`, expiresAt: now() + 1_000, accountId: scenario.name });
      const lines = log();
      const pool = new ClaudeAccountAuthPool({
        home: dir,
        now,
        current: noCurrent(dir, now),
        log: lines.logger,
        fetch: async () => new Response(JSON.stringify(scenario.body), { status: scenario.status }),
      });
      await pool.refreshIfNeeded();
      const stored = readClaudeAccountsFile(dir).find((candidate) => candidate.id === account.id)!;
      assert.equal(stored.needsReauth === true, scenario.needsReauth, scenario.name);
      assert.equal(pool.peekCredentials().length, scenario.needsReauth ? 0 : 1, scenario.name);
      assert.doesNotMatch(lines.warn.join("\n"), new RegExp(`${scenario.name}-(?:access|refresh)`));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
