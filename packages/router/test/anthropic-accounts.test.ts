// Claude subscription account storage: secrets stay in one 0600 file, upstream identities are
// one-way hashed, re-login replaces rather than duplicates, and refresh writes are generation-safe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  claudeAccountsPath,
  isCurrentClaudeAccountPaused,
  legacyMigrationDurable,
  listClaudeAccounts,
  markClaudeAccountNeedsReauth,
  readClaudeAccountPoolState,
  readClaudeAccountsFile,
  readClaudeOAuthAccounts,
  removeAllClaudeAccounts,
  removeClaudeAccount,
  renameClaudeAccount,
  replaceClaudeOAuthAccount,
  saveClaudeOAuthAccount,
  setCurrentClaudeAccountPaused,
  setPreferredClaudeAccount,
  updateClaudeAccount,
} from "../src/providers/anthropic-accounts.ts";
import { readClaudeAuthFile, saveClaudeOAuthFile } from "../src/providers/anthropic-token-file.ts";
import { posixModes } from "../../../test/capabilities.ts";

function home(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cr-claude-accounts-"));
}

const grant = (suffix: string, accountId = `upstream-${suffix}`) => ({
  accessToken: `access-${suffix}`,
  refreshToken: `refresh-${suffix}`,
  expiresAt: 2_000_000,
  accountId,
  email: `${suffix}@example.test`,
});

function addAccountInChild(home: string, suffix: string): Promise<void> {
  const moduleUrl = new URL("../src/providers/anthropic-accounts.ts", import.meta.url).href;
  const script = [
    `import { saveClaudeOAuthAccount } from ${JSON.stringify(moduleUrl)};`,
    `saveClaudeOAuthAccount(${JSON.stringify(home)}, ${JSON.stringify(grant(suffix))});`,
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}: ${stderr}`)));
  });
}

test("account storage is private, exposes safe summaries, and never stores the upstream UUID", () => {
  const dir = home();
  try {
    const account = saveClaudeOAuthAccount(dir, grant("one"), "2026-09-20T00:00:00.000Z");
    if (posixModes) assert.equal(fs.statSync(claudeAccountsPath(dir)).mode & 0o777, 0o600);
    const raw = fs.readFileSync(claudeAccountsPath(dir), "utf8");
    assert.doesNotMatch(raw, /upstream-one/);
    assert.match(raw, /[0-9a-f]{64}/);
    assert.deepEqual(listClaudeAccounts(dir), [{
      id: account.id,
      label: "one@example.test",
      email: "one@example.test",
      expiresAt: 2_000_000,
      needsReauth: false,
      preferred: false,
      paused: false,
    }]);
    assert.doesNotMatch(JSON.stringify(listClaudeAccounts(dir)), /access-one|refresh-one|upstream-one/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("signing into the same upstream account replaces its grant and preserves local identity", () => {
  const dir = home();
  try {
    const first = saveClaudeOAuthAccount(dir, grant("old", "same-subject"), "2026-09-20T00:00:00.000Z");
    assert.equal(renameClaudeAccount(dir, first.id, "Work"), true);
    const second = saveClaudeOAuthAccount(dir, grant("new", "same-subject"), "2026-09-20T01:00:00.000Z");
    assert.equal(second.id, first.id);
    assert.equal(second.label, "Work");
    const stored = readClaudeAccountsFile(dir);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.token, "access-new");
    assert.equal(stored[0]!.refreshToken, "refresh-new");
    assert.equal(stored[0]!.createdAt, "2026-09-20T00:00:00.000Z");
    assert.equal(stored[0]!.updatedAt, "2026-09-20T01:00:00.000Z");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("refresh and rejection writes compare the refresh-token generation", () => {
  const dir = home();
  try {
    const account = saveClaudeOAuthAccount(dir, grant("old"));
    assert.equal(replaceClaudeOAuthAccount(dir, account.id, "wrong-generation", grant("lost")), false);
    assert.equal(readClaudeAccountsFile(dir)[0]!.token, "access-old");
    assert.equal(replaceClaudeOAuthAccount(dir, account.id, "refresh-old", grant("fresh")), true);
    assert.equal(markClaudeAccountNeedsReauth(dir, account.id, "refresh-old"), false, "an old refresh failure cannot quarantine the new login");
    assert.equal(markClaudeAccountNeedsReauth(dir, account.id, "refresh-fresh"), true);
    assert.equal(readClaudeAccountsFile(dir)[0]!.needsReauth, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent processes preserve every account mutation", async () => {
  const dir = home();
  try {
    const mutations = Array.from({ length: 8 }, (_, index) => addAccountInChild(dir, `child-${index}`));
    setCurrentClaudeAccountPaused(dir, true);
    await Promise.all(mutations);
    assert.deepEqual(
      readClaudeAccountsFile(dir).map((account) => account.email).sort(),
      Array.from({ length: 8 }, (_, index) => `child-${index}@example.test`).sort(),
    );
    assert.equal(isCurrentClaudeAccountPaused(dir), true);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes(".lock")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale process lock is recovered without leaving lock files", () => {
  const dir = home();
  try {
    const lock = `${claudeAccountsPath(dir)}.lock`;
    fs.mkdirSync(lock, { mode: 0o700 });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const account = saveClaudeOAuthAccount(dir, grant("recovered"));
    assert.equal(listClaudeAccounts(dir)[0]!.id, account.id);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes(".lock")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed pool fails closed and cannot be overwritten by a mutation", () => {
  for (const malformed of [
    "{",
    "null",
    JSON.stringify({ version: 2, accounts: [] }),
    JSON.stringify({ version: 1, accounts: [{ id: "partial", token: "secret" }] }),
    ...[null, [], {}, { paused: "false" }].map((current) => JSON.stringify({ version: 1, accounts: [], current })),
    ...[null, "legacy", {}, [null], [""], ["legacy", 7]].map((aliases) => JSON.stringify({ version: 1, accounts: [], current: { paused: true, aliases } })),
  ]) {
    const dir = home();
    try {
      saveClaudeOAuthFile(dir, { accessToken: "legacy-access", refreshToken: "legacy-refresh", expiresAt: 3_000_000 });
      fs.writeFileSync(claudeAccountsPath(dir), malformed);
      assert.deepEqual(readClaudeAccountsFile(dir), []);
      assert.deepEqual(readClaudeOAuthAccounts(dir), []);
      assert.deepEqual(readClaudeAccountPoolState(dir), { accounts: [], currentPaused: true });
      assert.equal(isCurrentClaudeAccountPaused(dir), true);
      assert.throws(() => saveClaudeOAuthAccount(dir, grant("replacement")), /refusing to overwrite/);
      assert.throws(() => setCurrentClaudeAccountPaused(dir, true), /refusing to overwrite/);
      assert.throws(() => setCurrentClaudeAccountPaused(dir, false), /refusing to overwrite/);
      assert.throws(() => removeAllClaudeAccounts(dir), /refusing to overwrite/);
      assert.equal(readClaudeAuthFile(dir)?.token, "legacy-access", "failed mutations must not remove the legacy grant");
      assert.equal(fs.readFileSync(claudeAccountsPath(dir), "utf8"), malformed);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("an unreadable existing store fails closed and refuses mutations", () => {
  const dir = home();
  try {
    fs.mkdirSync(claudeAccountsPath(dir));
    assert.equal(isCurrentClaudeAccountPaused(dir), true);
    assert.deepEqual(readClaudeOAuthAccounts(dir), []);
    assert.deepEqual(readClaudeAccountPoolState(dir), { accounts: [], currentPaused: true });
    assert.throws(() => setCurrentClaudeAccountPaused(dir, false), /refusing to overwrite/);
    assert.throws(() => removeAllClaudeAccounts(dir), /refusing to overwrite/);
    assert.equal(fs.statSync(claudeAccountsPath(dir)).isDirectory(), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("current pause defaults to false and persists in the v1 envelope without credentials", () => {
  const dir = home();
  try {
    assert.equal(isCurrentClaudeAccountPaused(dir), false);
    assert.deepEqual(readClaudeAccountPoolState(dir), { accounts: [], currentPaused: false });
    assert.equal(fs.existsSync(claudeAccountsPath(dir)), false);
    fs.writeFileSync(claudeAccountsPath(dir), JSON.stringify({ version: 1, accounts: [] }));
    assert.equal(isCurrentClaudeAccountPaused(dir), false, "existing v1 files need no migration");
    assert.deepEqual(readClaudeAccountPoolState(dir), { accounts: [], currentPaused: false });
    setCurrentClaudeAccountPaused(dir, true, "external-token-not-to-be-stored");
    assert.deepEqual(JSON.parse(fs.readFileSync(claudeAccountsPath(dir), "utf8")), { version: 1, accounts: [], current: { paused: true } });
    if (posixModes) assert.equal(fs.statSync(claudeAccountsPath(dir)).mode & 0o777, 0o600);
    assert.equal(isCurrentClaudeAccountPaused(dir), true);
    const paused = readClaudeAccountPoolState(dir);
    assert.deepEqual(paused, { accounts: [], currentPaused: true });
    setCurrentClaudeAccountPaused(dir, false);
    assert.equal(isCurrentClaudeAccountPaused(dir), false);
    assert.deepEqual(readClaudeAccountPoolState(dir), { accounts: [], currentPaused: false });
    assert.equal(paused.currentPaused, true, "each reader result is an independent snapshot");
    assert.deepEqual(listClaudeAccounts(dir), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(claudeAccountsPath(dir), "utf8")), { version: 1, accounts: [], current: { paused: false } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("current pause and resume update only exact-token stored aliases and preserve every grant", () => {
  const dir = home();
  try {
    const first = saveClaudeOAuthAccount(dir, { ...grant("alias-one"), accessToken: "current-access" });
    const second = saveClaudeOAuthAccount(dir, { ...grant("alias-two"), accessToken: "current-access" });
    const active = saveClaudeOAuthAccount(dir, grant("independent"));
    const paused = saveClaudeOAuthAccount(dir, grant("already-paused"));
    updateClaudeAccount(dir, paused.id, { paused: true, preferred: true });
    const before = readClaudeAccountsFile(dir);
    for (const pausedValue of [true, false]) {
      setCurrentClaudeAccountPaused(dir, pausedValue, "current-access");
      assert.equal(isCurrentClaudeAccountPaused(dir), pausedValue);
      const accounts = readClaudeAccountsFile(dir);
      assert.deepEqual(accounts.map((account) => [account.id, account.paused === true]), [
        [first.id, pausedValue], [second.id, pausedValue], [active.id, false], [paused.id, true],
      ]);
      assert.deepEqual(
        accounts.map(({ paused: _, updatedAt: __, ...account }) => account),
        before.map(({ paused: _, updatedAt: __, ...account }) => account),
        "tokens, identities, labels and preference stay intact",
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("updating an exact-token alias pauses and resumes the current source and every alias atomically", () => {
  const dir = home();
  try {
    const first = saveClaudeOAuthAccount(dir, { ...grant("alias-one"), accessToken: "current-access" });
    const second = saveClaudeOAuthAccount(dir, { ...grant("alias-two"), accessToken: "current-access" });
    const active = saveClaudeOAuthAccount(dir, grant("independent"));
    const paused = saveClaudeOAuthAccount(dir, grant("already-paused"));
    updateClaudeAccount(dir, paused.id, { paused: true, preferred: true });
    const before = readClaudeAccountsFile(dir);
    setCurrentClaudeAccountPaused(dir, true, "current-access");
    for (const pausedValue of [false, true, false]) {
      assert.equal(updateClaudeAccount(dir, first.id, { paused: pausedValue }, "current-access"), true);
      assert.equal(isCurrentClaudeAccountPaused(dir), pausedValue);
      const { accounts, currentPaused } = readClaudeAccountPoolState(dir);
      assert.equal(currentPaused, pausedValue);
      assert.deepEqual(accounts.map((account) => [account.id, account.paused === true]), [
        [first.id, pausedValue], [second.id, pausedValue], [active.id, false], [paused.id, true],
      ]);
      assert.deepEqual(
        accounts.map(({ paused: _, updatedAt: __, ...account }) => account),
        before.map(({ paused: _, updatedAt: __, ...account }) => account),
        "alias controls must not change any grant, identity, label or preference",
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("unproven alias updates leave native controls alone without a matching pause snapshot", () => {
  const dir = home();
  try {
    const first = saveClaudeOAuthAccount(dir, { ...grant("alias-one"), accessToken: "current-access" });
    const second = saveClaudeOAuthAccount(dir, { ...grant("alias-two"), accessToken: "current-access" });
    updateClaudeAccount(dir, first.id, { paused: true });
    updateClaudeAccount(dir, second.id, { paused: true });
    setCurrentClaudeAccountPaused(dir, true);
    assert.equal(updateClaudeAccount(dir, first.id, { label: "Work", preferred: true }, "current-access"), true);
    assert.equal(isCurrentClaudeAccountPaused(dir), true);
    assert.deepEqual(listClaudeAccounts(dir).map((account) => account.paused), [true, true]);
    assert.deepEqual(JSON.parse(fs.readFileSync(claudeAccountsPath(dir), "utf8")).current, { paused: true },
      "label and preference edits must not record an alias relationship");
    assert.equal(updateClaudeAccount(dir, "missing", { paused: false }, "current-access"), false);
    assert.equal(isCurrentClaudeAccountPaused(dir), true);
    for (const snapshot of [undefined, "unrelated-external-token"]) {
      for (const paused of [false, true]) {
        setCurrentClaudeAccountPaused(dir, !paused);
        updateClaudeAccount(dir, second.id, { paused: !paused });
        assert.equal(updateClaudeAccount(dir, first.id, { paused }, snapshot), true);
        assert.equal(isCurrentClaudeAccountPaused(dir), !paused);
        assert.deepEqual(listClaudeAccounts(dir).map((account) => [account.id, account.paused]), [
          [first.id, paused], [second.id, !paused],
        ]);
      }
    }
    assert.doesNotMatch(fs.readFileSync(claudeAccountsPath(dir), "utf8"), /unrelated-external-token/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("native resume without a source restores only recorded owners and clears their provenance", () => {
  const dir = home();
  try {
    const first = saveClaudeOAuthAccount(dir, grant("one"));
    const second = saveClaudeOAuthAccount(dir, grant("two"));
    const unrelated = saveClaudeOAuthAccount(dir, grant("unrelated"));
    updateClaudeAccount(dir, unrelated.id, { paused: true });
    setCurrentClaudeAccountPaused(dir, true, "access-one");
    setCurrentClaudeAccountPaused(dir, true, "access-two");
    assert.deepEqual(JSON.parse(fs.readFileSync(claudeAccountsPath(dir), "utf8")).current, {
      paused: true, aliases: [first.id, second.id],
    }, "only local ids of proven aliases are persisted across native token changes");
    setCurrentClaudeAccountPaused(dir, false);
    assert.deepEqual(listClaudeAccounts(dir).map((account) => [account.id, account.paused]), [
      [first.id, false], [second.id, false], [unrelated.id, true],
    ]);
    const file = JSON.parse(fs.readFileSync(claudeAccountsPath(dir), "utf8"));
    assert.deepEqual(file.current, { paused: false });
    file.current.aliases = [unrelated.id];
    fs.writeFileSync(claudeAccountsPath(dir), JSON.stringify(file));
    setCurrentClaudeAccountPaused(dir, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(claudeAccountsPath(dir), "utf8")).current, { paused: true },
      "an inactive relationship cannot authorize a new pause or resume");
    setCurrentClaudeAccountPaused(dir, false);
    assert.equal(listClaudeAccounts(dir).find((account) => account.id === unrelated.id)!.paused, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recorded alias owners survive refresh and re-login when the current snapshot is lost", () => {
  for (const mutation of ["refresh", "relogin"]) {
    const dir = home();
    try {
      const linked = saveClaudeOAuthAccount(dir, grant("linked"));
      const unrelated = saveClaudeOAuthAccount(dir, grant("unrelated"));
      updateClaudeAccount(dir, unrelated.id, { paused: true });
      setCurrentClaudeAccountPaused(dir, true, "access-linked");
      if (mutation === "refresh") {
        assert.equal(replaceClaudeOAuthAccount(dir, linked.id, "refresh-linked", grant("rotated")), true);
      } else {
        assert.equal(saveClaudeOAuthAccount(dir, grant("rotated", "upstream-linked")).id, linked.id);
      }
      assert.deepEqual(JSON.parse(fs.readFileSync(claudeAccountsPath(dir), "utf8")).current, { paused: true, aliases: [linked.id] });
      assert.equal(readClaudeAccountsFile(dir).find((account) => account.id === linked.id)!.token, "access-rotated");
      const snapshot = mutation === "refresh" ? undefined : "unrelated-external-token";
      assert.equal(updateClaudeAccount(dir, linked.id, { paused: false }, snapshot), true);
      assert.equal(isCurrentClaudeAccountPaused(dir), false);
      assert.deepEqual(listClaudeAccounts(dir).map((account) => [account.id, account.paused]), [
        [linked.id, false], [unrelated.id, true],
      ]);
      assert.deepEqual(JSON.parse(fs.readFileSync(claudeAccountsPath(dir), "utf8")).current, { paused: false });
      updateClaudeAccount(dir, linked.id, { paused: true });
      assert.equal(isCurrentClaudeAccountPaused(dir), false, "resumed relationships cannot later change native controls");
      assert.doesNotMatch(fs.readFileSync(claudeAccountsPath(dir), "utf8"), /unrelated-external-token/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("every stored-account mutation preserves the current source pause", () => {
  const dir = home();
  try {
    const first = saveClaudeOAuthAccount(dir, grant("one"));
    setCurrentClaudeAccountPaused(dir, true, "access-one");
    assert.equal(isCurrentClaudeAccountPaused(dir), true);
    const mutations = [
      () => saveClaudeOAuthAccount(dir, grant("two")),
      () => saveClaudeOAuthAccount(dir, grant("relogin", "upstream-one")),
      () => replaceClaudeOAuthAccount(dir, first.id, "refresh-relogin", grant("fresh")),
      () => markClaudeAccountNeedsReauth(dir, first.id, "refresh-fresh"),
      () => renameClaudeAccount(dir, first.id, "Work"),
      () => updateClaudeAccount(dir, first.id, { paused: true, preferred: true }),
      () => setPreferredClaudeAccount(dir, null),
      () => setPreferredClaudeAccount(dir, first.id),
      () => removeClaudeAccount(dir, first.id),
    ];
    for (const mutate of mutations) {
      assert.ok(mutate());
      assert.equal(isCurrentClaudeAccountPaused(dir), true);
      assert.deepEqual(JSON.parse(fs.readFileSync(claudeAccountsPath(dir), "utf8")).current, { paused: true, aliases: [first.id] });
    }
    assert.equal(readClaudeAccountsFile(dir).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removing all owned auth preserves a true native opt-out but clears owned grants and legacy auth", () => {
  const dir = home();
  try {
    const owned = saveClaudeOAuthAccount(dir, grant("owned"));
    setCurrentClaudeAccountPaused(dir, true, "access-owned");
    saveClaudeOAuthFile(dir, { accessToken: "stale-access", refreshToken: "stale-refresh", expiresAt: 3_000_000 });
    assert.equal(removeAllClaudeAccounts(dir), true);
    assert.equal(readClaudeAuthFile(dir), null);
    assert.deepEqual(readClaudeOAuthAccounts(dir), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(claudeAccountsPath(dir), "utf8")), { version: 1, accounts: [], current: { paused: true, aliases: [owned.id] } });
    assert.equal(removeAllClaudeAccounts(dir), false, "the native opt-out is not an owned grant to remove");
    assert.equal(isCurrentClaudeAccountPaused(dir), true);
    setCurrentClaudeAccountPaused(dir, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(claudeAccountsPath(dir), "utf8")).current, { paused: false }, "resume clears even removed alias ids");
    assert.equal(removeAllClaudeAccounts(dir), true);
    assert.equal(fs.existsSync(claudeAccountsPath(dir)), false);
    assert.equal(isCurrentClaudeAccountPaused(dir), false);
    assert.equal(removeAllClaudeAccounts(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("setting current pause as the first mutation migrates legacy OAuth without losing its grant", () => {
  const dir = home();
  try {
    saveClaudeOAuthFile(dir, { accessToken: "legacy-access", refreshToken: "legacy-refresh", expiresAt: 3_000_000 }, "2026-09-19T00:00:00.000Z");
    assert.equal(isCurrentClaudeAccountPaused(dir), false);
    const before = readClaudeOAuthAccounts(dir)[0]!;
    setCurrentClaudeAccountPaused(dir, true, "legacy-access");
    assert.equal(readClaudeAuthFile(dir), null);
    assert.equal(isCurrentClaudeAccountPaused(dir), true);
    const [account] = readClaudeAccountsFile(dir);
    assert.deepEqual(account, { ...before, paused: true, updatedAt: account!.updatedAt });
    assert.equal(JSON.parse(fs.readFileSync(claudeAccountsPath(dir), "utf8")).version, 1);
    setCurrentClaudeAccountPaused(dir, false, "legacy-access");
    assert.equal(readClaudeAccountsFile(dir)[0]!.paused, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy migration uses directory durability on POSIX and the atomic rename boundary on Windows", () => {
  assert.equal(legacyMigrationDurable(true, "darwin"), true);
  assert.equal(legacyMigrationDurable(false, "darwin"), false);
  assert.equal(legacyMigrationDurable(false, "win32"), true);
});

test("the legacy OAuth file is visible until the first pool mutation, then migrated once", () => {
  const dir = home();
  try {
    saveClaudeOAuthFile(dir, { accessToken: "legacy-access", refreshToken: "legacy-refresh", expiresAt: 3_000_000 }, "2026-09-19T00:00:00.000Z");
    assert.deepEqual(readClaudeOAuthAccounts(dir).map((account) => account.id), ["legacy"]);
    assert.deepEqual(readClaudeAccountPoolState(dir), {
      accounts: [{
        id: "legacy", token: "legacy-access", refreshToken: "legacy-refresh", expiresAt: 3_000_000,
        createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z", label: "Claude account",
      }],
      currentPaused: false,
    });
    assert.equal(fs.existsSync(claudeAccountsPath(dir)), false, "reading a pool snapshot does not migrate legacy auth");
    const added = saveClaudeOAuthAccount(dir, grant("two"));
    assert.equal(readClaudeAuthFile(dir), null, "the old mutable copy is removed only after the pool write");
    const stored = readClaudeAccountsFile(dir);
    assert.deepEqual(stored.map((account) => account.id), ["legacy", added.id]);
    saveClaudeOAuthFile(dir, { accessToken: "stale-legacy-access", refreshToken: "stale-legacy-refresh", expiresAt: 4_000_000 }, "2026-09-19T00:00:00.000Z");
    assert.deepEqual(readClaudeOAuthAccounts(dir).map((account) => account.id), ["legacy", added.id], "a retained old file cannot duplicate a migrated legacy account after token rotation");
    assert.equal(removeClaudeAccount(dir, "legacy"), true);
    assert.deepEqual(readClaudeAccountsFile(dir).map((account) => account.id), [added.id]);
    assert.deepEqual(readClaudeOAuthAccounts(dir).map((account) => account.id), [added.id], "a retained old file cannot resurrect a removed legacy account once the pool exists");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
