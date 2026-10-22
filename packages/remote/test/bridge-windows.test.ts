// The Remote Control bridge on Windows (issue #70). The Claude desktop registry, the process
// snapshot behind it and the login the bridge sends are all injected: no Windows, no keychain,
// no PowerShell runs here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeAuthError, DESKTOP_BLOCKED, LOGIN_EXPIRED, loadBridgeAuth } from "../src/bridge-client.ts";
import { liveDesktopProcesses } from "../src/desktop.ts";
import { creationDateToFileTime, parseFileTime, ProcessSnapshot, sameFileTime } from "../src/processes.ts";
import { bridgeFixture, bridgeId } from "./bridge-fixture.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));
/** The measured pair: the registry's FILETIME and the OS's CreationDate for one process. */
const PROC_START = "134370764816580794";
const CREATED_AT = "2026-10-21T17:14:41.6580790Z";

/** A Windows process snapshot that reports the given processes, as PowerShell would. */
function windowsSnapshot(processes: { pid: number; started?: string }[]): ProcessSnapshot {
  return new ProcessSnapshot({
    platform: "win32",
    exec: () => JSON.stringify(processes.map(p => ({ ProcessId: p.pid, CommandLine: "claude.exe --model=claude-opus-5", ...(p.started ? { CreationDate: p.started } : {}) }))),
    execAsync: async () => JSON.stringify(processes.map(p => ({ ProcessId: p.pid, CommandLine: "claude.exe --model=claude-opus-5", ...(p.started ? { CreationDate: p.started } : {}) }))),
  });
}

/** A Claude desktop registry directory, as the Windows app writes it. */
function windowsRegistry(t: import("node:test").TestContext, entry: Record<string, unknown> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "win-registry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "42.json"), JSON.stringify({
    sessionId: bridgeId, pid: 42, entrypoint: "claude-desktop", status: "idle", bridgeSessionId: "bridge",
    procStart: PROC_START, pidDomain: "win32:ebd7", kind: "session", ...entry,
  }));
  return dir;
}

test("a Windows CreationDate converts to the FILETIME the desktop registry records", () => {
  const start = creationDateToFileTime(CREATED_AT)!;
  // The OS reports the instant in ISO; the registry keeps it in 100 ns ticks since 1601.
  assert.equal(start, 134370764816580790n);
  assert.equal(parseFileTime(PROC_START), 134370764816580794n);
  // The two agree to within a hair, which is why they are compared with a millisecond of slack.
  assert.equal(start - parseFileTime(PROC_START)!, -4n);
  assert.ok(sameFileTime(start, parseFileTime(PROC_START)!));
  assert.equal(creationDateToFileTime("2026-10-22T02:14:41.6580790+09:00"), start, "the same instant with an offset");
  assert.equal(creationDateToFileTime("not a date"), null);
  assert.equal(parseFileTime("not a filetime"), null);
});

test("the Windows registry keeps a session whose pid runs with the recorded start time", t => {
  const dir = windowsRegistry(t);
  const live = liveDesktopProcesses(dir, 0, "win32", windowsSnapshot([{ pid: 42, started: CREATED_AT }]));
  assert.equal(live.get(bridgeId)?.bridgeSessionId, "bridge");
  assert.equal(live.get(bridgeId)?.pid, 42);
  assert.equal(live.get(bridgeId)?.status, "idle");
});

test("the Windows registry drops a session whose pid is gone or was recycled", t => {
  const dir = windowsRegistry(t);
  // The pid is not running at all.
  assert.equal(liveDesktopProcesses(dir, 0, "win32", windowsSnapshot([{ pid: 7, started: CREATED_AT }])).size, 0);
  // The pid runs, but it started two milliseconds later: another process took the number.
  assert.equal(liveDesktopProcesses(dir, 0, "win32", windowsSnapshot([{ pid: 42, started: "2026-10-21T17:14:41.6600790Z" }])).size, 0);
  // Half a millisecond of slack is still the same process.
  assert.equal(liveDesktopProcesses(dir, 0, "win32", windowsSnapshot([{ pid: 42, started: "2026-10-21T17:14:41.6585790Z" }])).size, 1);
  // The OS cannot tell when the process started, but the pid runs.
  assert.equal(liveDesktopProcesses(dir, 0, "win32", windowsSnapshot([{ pid: 42 }])).size, 1);
});

test("the Windows registry ignores entries that are not a live desktop session", t => {
  const dir = windowsRegistry(t, { entrypoint: "sdk-cli" });
  assert.equal(liveDesktopProcesses(dir, 0, "win32", windowsSnapshot([{ pid: 42, started: CREATED_AT }])).size, 0);
});

test("the Windows registry sends a phone's message to the Claude app session", async t => {
  const dir = windowsRegistry(t);
  const registry = liveDesktopProcesses(dir, 0, "win32", windowsSnapshot([{ pid: 42, started: CREATED_AT }]));
  const f = bridgeFixture(t, { registry: () => registry });
  await f.sessions.send(bridgeId, "phone-uuid", "hello from the phone");
  assert.equal(f.posts.length, 1, "the message went through the Remote Control bridge");
});

test("the Windows process snapshot is read once and then refreshed in the background", async () => {
  let sync = 0, background = 0, now = 1_000_000;
  const snapshot = new ProcessSnapshot({
    platform: "win32", ttlMs: 5000, now: () => now,
    exec: () => { sync++; return "[]"; },
    execAsync: async () => { background++; return "[]"; },
  });
  assert.deepEqual(snapshot.current(), []);
  assert.equal(sync, 1, "the first read waits");
  snapshot.current();
  assert.equal(sync, 1, "the snapshot is served from memory");
  now += 6000;
  snapshot.current();
  assert.equal(sync, 1, "a stale snapshot is never read on the event loop again");
  assert.equal(background, 1, "the new one is read in the background");
  await tick();
  snapshot.current();
  assert.equal(background, 1);
});

test("a failed first read never blocks the event loop again", async () => {
  let sync = 0, background = 0;
  const errors: unknown[] = [];
  const snapshot = new ProcessSnapshot({
    platform: "win32",
    exec: () => { sync++; throw new Error("CIM unavailable"); },
    execAsync: async () => { background++; throw new Error("CIM unavailable"); },
    onError: error => errors.push(error),
  });
  assert.deepEqual(snapshot.current(), [], "the first read waits and fails");
  assert.equal(sync, 1);
  snapshot.current();
  assert.equal(sync, 1, "a failed snapshot is never read on the event loop again");
  await tick();
  assert.equal(background, 1, "it is read again in the background");
  assert.equal(errors.length, 1);
});

test("a failed background read keeps the snapshot and is reported once", async () => {
  let now = 1_000_000, background = 0;
  const errors: unknown[] = [];
  const snapshot = new ProcessSnapshot({
    platform: "win32", ttlMs: 1000, now: () => now,
    exec: () => JSON.stringify([{ ProcessId: 42, CommandLine: "claude.exe", CreationDate: CREATED_AT }]),
    execAsync: async () => { background++; throw new Error("CIM unavailable"); },
    onError: error => errors.push(error),
  });
  assert.equal(snapshot.current().length, 1, "the first read waits and works");
  now += 2000;
  snapshot.current();
  await tick();
  now += 2000;
  snapshot.current();
  await tick();
  assert.equal(background, 2, "a stale snapshot is read again");
  assert.equal(errors.length, 1, "a run of failures is reported once");
  assert.equal(snapshot.current().length, 1, "the last good snapshot is still served");
});

/** A home directory with the files the bridge reads. */
function home(t: import("node:test").TestContext, files: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "win-home-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(dir, ...name.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  }
  return dir;
}

test("the Windows bridge login comes from the CLI's credentials file, then from the observed login", t => {
  const now = 1_700_000_000_000;
  const dir = home(t, {
    ".claude.json": { oauthAccount: { organizationUuid: "org-1" } },
    ".claude/.credentials.json": { claudeAiOauth: { accessToken: "cli-token", expiresAt: now + 3_600_000 } },
  });
  const read = (file: string) => fs.readFileSync(file, "utf8");
  // The CLI's own login while it is good.
  assert.deepEqual(loadBridgeAuth({ platform: "win32", userHome: dir, now, readFile: read, observed: () => ({ accessToken: "observed-token", expiresAt: now + 3_600_000 }) }),
    { accessToken: "cli-token", organizationUuid: "org-1", expiresAt: now + 3_600_000 });
  // The app's own login stands in for the CLI's expired one.
  fs.writeFileSync(path.join(dir, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "stale-token", expiresAt: now - 1 } }));
  assert.deepEqual(loadBridgeAuth({ platform: "win32", userHome: dir, now, readFile: read, observed: () => ({ accessToken: "observed-token", expiresAt: now + 3_600_000 }) }),
    { accessToken: "observed-token", organizationUuid: "org-1", expiresAt: now + 3_600_000 });
  // Neither is there: the expired one is handed back, so the phone is told the login expired.
  assert.deepEqual(loadBridgeAuth({ platform: "win32", userHome: dir, now, readFile: read, observed: () => null }),
    { accessToken: "stale-token", organizationUuid: "org-1", expiresAt: now - 1 });
});

test("the Windows bridge login without any login says the login expired", t => {
  const now = 1_700_000_000_000;
  const dir = home(t, { ".claude.json": { oauthAccount: { organizationUuid: "org-1" } } });
  assert.throws(() => loadBridgeAuth({ platform: "win32", userHome: dir, now, readFile: file => fs.readFileSync(file, "utf8"), observed: () => null }),
    (error: Error) => error instanceof BridgeAuthError && error.message === LOGIN_EXPIRED);
  // The organization is what the bridge sends; without it the login cannot be read at all.
  const bare = home(t, { ".claude/.credentials.json": { claudeAiOauth: { accessToken: "t", expiresAt: now + 3_600_000 } } });
  assert.throws(() => loadBridgeAuth({ platform: "win32", userHome: bare, now, readFile: file => fs.readFileSync(file, "utf8"), observed: () => null }),
    (error: Error) => error instanceof BridgeAuthError && error.message !== LOGIN_EXPIRED);
});

test("macOS keeps its keychain login and other platforms stay blocked", t => {
  const now = 1_700_000_000_000;
  const dir = home(t, { ".claude.json": { oauthAccount: { organizationUuid: "org-1" } } });
  let read: string[] = [];
  const auth = loadBridgeAuth({
    platform: "darwin", userHome: dir, now,
    readFile: file => { read.push(file); return fs.readFileSync(file, "utf8"); },
    cli: () => ({ accessToken: "keychain-token", expiresAt: now + 3_600_000 }),
    observed: () => null,
  });
  assert.deepEqual(auth, { accessToken: "keychain-token", organizationUuid: "org-1", expiresAt: now + 3_600_000 });
  assert.deepEqual(read.map(file => path.basename(file)), [".claude.json"], "macOS does not read a credentials file");
  assert.throws(() => loadBridgeAuth({ platform: "linux", userHome: dir, now }), new RegExp(DESKTOP_BLOCKED.slice(0, 10)));
});
