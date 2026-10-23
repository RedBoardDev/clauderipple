import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay, setImmediate as nextTick } from "node:timers/promises";
import { WebSocket } from "ws";
import { diffView } from "../src/diff.ts";
import { PermissionQueue } from "../src/permissions.ts";
import { FRAME_CAP } from "../src/protocol.ts";
import type { ClientMsg, DiffView, HostMsg } from "../src/protocol.ts";
import { HostServer } from "../src/server.ts";
import { Sessions } from "../src/sessions.ts";
import type { QueryFn, SdkUserMessage } from "../src/sessions.ts";

const webDir = fileURLToPath(new URL("../web", import.meta.url));
const token = "remote-test-token-not-a-real-pairing-token";

/** git in a test folder: identity from the command line, no system config, no prompts, no locks. */
function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } });
}

/** A repository with one commit holding `files`; the temp folder goes away with the test. */
function repo(t: TestContext, files: Record<string, string | Buffer>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-diff-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  gitIn(dir, "init", "-q", "-b", "main");
  write(dir, files);
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-qm", "base");
  return dir;
}

function write(dir: string, files: Record<string, string | Buffer>): void {
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
}

function byPath(view: DiffView, name: string) {
  const file = view.files.find(entry => entry.path === name);
  assert.ok(file, `${name} should be in the diff`);
  return file;
}

test("uncommitted work names every kind of change with its own status and line counts", async t => {
  const dir = repo(t, {
    "keep.txt": "a\nb\nc\n",
    "old.txt": "x\ny\nz\n",
    "del.txt": "d\n",
    "bin.dat": Buffer.from([0, 1, 2, 3]),
  });
  write(dir, { "keep.txt": "a\nB\nc\nd\ne\n" });
  gitIn(dir, "mv", "old.txt", "new.txt");
  fs.rmSync(path.join(dir, "del.txt"));
  write(dir, { "added.txt": "brand\nnew\n", "untracked.txt": "fresh\nline\n", "bin.dat": Buffer.from([0, 9, 9]) });
  gitIn(dir, "add", "added.txt");

  const view = await diffView(dir);
  assert.equal(view.scope, "uncommitted");
  assert.equal(view.base, null);
  assert.equal(view.branch, "main");
  assert.equal(view.truncated, false);

  const modified = byPath(view, "keep.txt");
  assert.equal(modified.status, "modified");
  assert.deepEqual([modified.added, modified.removed], [3, 1]);
  assert.match(modified.patch, /^\+B$/m);
  assert.match(modified.patch, /^-b$/m);

  const added = byPath(view, "added.txt");
  assert.equal(added.status, "added");
  assert.deepEqual([added.added, added.removed], [2, 0]);
  assert.match(added.patch, /\+brand/);

  const deleted = byPath(view, "del.txt");
  assert.equal(deleted.status, "deleted");
  assert.deepEqual([deleted.added, deleted.removed], [0, 1]);

  const renamed = byPath(view, "new.txt");
  assert.equal(renamed.status, "renamed");
  assert.equal(renamed.oldPath, "old.txt");
  assert.match(renamed.patch, /rename from old\.txt/);

  const untracked = byPath(view, "untracked.txt");
  assert.equal(untracked.status, "untracked");
  assert.deepEqual([untracked.added, untracked.removed], [2, 0]);
  assert.match(untracked.patch, /^diff --git a\/untracked\.txt b\/untracked\.txt/m);
  assert.match(untracked.patch, /^\+fresh$/m);
  assert.match(untracked.patch, /^\+line$/m);

  const binary = byPath(view, "bin.dat");
  assert.equal(binary.status, "binary");
  assert.deepEqual([binary.added, binary.removed], [0, 0]);
  assert.equal(binary.patch, "");
});

test("a clean branch ahead of its base is shown from the merge base, naming the base", async t => {
  const dir = repo(t, { "a.txt": "one\n" });
  gitIn(dir, "switch", "-q", "-c", "feature");
  write(dir, { "a.txt": "one\ntwo\n" });
  gitIn(dir, "commit", "-qam", "work");

  const view = await diffView(dir);
  assert.equal(view.scope, "branch");
  assert.equal(view.base, "main");
  assert.equal(view.branch, "feature");
  assert.deepEqual(view.files.map(file => file.path), ["a.txt"]);
  assert.deepEqual([view.files[0]!.added, view.files[0]!.removed], [1, 0]);
  assert.match(view.files[0]!.patch, /^\+two$/m);

  // origin/HEAD is the base when it exists, and wins over the local branch of the same name.
  gitIn(dir, "update-ref", "refs/remotes/origin/main", "main");
  gitIn(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const withOrigin = await diffView(dir);
  assert.equal(withOrigin.scope, "branch");
  assert.equal(withOrigin.base, "origin/main");
});

test("a clean folder that is not ahead of the base is clean", async t => {
  const dir = repo(t, { "a.txt": "one\n" });
  const view = await diffView(dir);
  assert.deepEqual(view, { scope: "clean", base: null, branch: "main", files: [], truncated: false });
});

test("a folder that is not a git repository is refused", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-plain-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  await assert.rejects(diffView(dir), /not a git repository/);
});

test("a patch past the per-file limit is cut and says so", async t => {
  const dir = repo(t, { "big.txt": "small\n" });
  write(dir, { "big.txt": `${"x".repeat(300 * 1024)}\n` });
  const view = await diffView(dir);
  assert.equal(view.scope, "uncommitted");
  assert.equal(view.truncated, true);
  const big = byPath(view, "big.txt");
  // Counts come from numstat, before the patch is cut.
  assert.deepEqual([big.added, big.removed], [1, 1]);
  assert.ok(Buffer.byteLength(big.patch) <= 200 * 1024, `patch is ${Buffer.byteLength(big.patch)} bytes`);
  assert.ok(Buffer.byteLength(JSON.stringify(view)) < FRAME_CAP, "the whole view must still fit one frame");
});

test("more files than the listing allows are dropped, and the counts are still complete", async t => {
  const dir = repo(t, { "base.txt": "base\n" });
  const names: Record<string, string> = {};
  for (let i = 0; i < 301; i++) names[`f${String(i).padStart(3, "0")}.txt`] = "base\n";
  write(dir, names);
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-qm", "files");
  const changed: Record<string, string> = {};
  for (const name of Object.keys(names)) changed[name] = "base\nmore\n";
  write(dir, changed);

  const view = await diffView(dir);
  assert.equal(view.scope, "uncommitted");
  assert.equal(view.files.length, 300);
  assert.equal(view.truncated, true);
  assert.deepEqual([view.files[0]!.added, view.files[0]!.removed], [1, 0]);
});

test("an untracked symlink's target is never read, only the link's own text", async t => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const secret = path.join(outside, "secret.txt");
  fs.writeFileSync(secret, "TOP-SECRET-CONTENT\n");
  const dir = repo(t, { "a.txt": "one\n" });
  fs.symlinkSync(secret, path.join(dir, "link.txt"));

  const view = await diffView(dir);
  const link = byPath(view, "link.txt");
  assert.equal(link.status, "untracked");
  assert.equal(link.added, 1);
  assert.ok(link.patch.includes(secret), "the link's own target text is what git would store");
  assert.ok(!JSON.stringify(view).includes("TOP-SECRET-CONTENT"), "the file behind the link must not be read");
});

test("a repository with no commit yet reports its files as new work", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-fresh-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  gitIn(dir, "init", "-q", "-b", "main");
  write(dir, { "staged.txt": "one\n", "loose.txt": "two\n" });
  gitIn(dir, "add", "staged.txt");

  const view = await diffView(dir);
  assert.equal(view.scope, "uncommitted");
  assert.equal(byPath(view, "staged.txt").status, "added");
  assert.deepEqual([byPath(view, "staged.txt").added, byPath(view, "staged.txt").removed], [1, 0]);
  assert.equal(byPath(view, "loose.txt").status, "untracked");
});

test("only the session's own folder is reported, and an untracked binary stays binary", async t => {
  const dir = repo(t, { "inside/a.txt": "one\n", "outside.txt": "one\n" });
  write(dir, { "inside/a.txt": "one\ntwo\n", "outside.txt": "one\ntwo\n", "inside/blob.bin": Buffer.from([0, 7]) });
  const view = await diffView(path.join(dir, "inside"));
  assert.deepEqual(view.files.map(file => file.path), ["inside/a.txt", "inside/blob.bin"]);
  assert.equal(view.files[0]!.status, "modified");
  assert.equal(byPath(view, "inside/blob.bin").status, "binary");
  assert.equal(byPath(view, "inside/blob.bin").patch, "");
});

// ---- over the socket ------------------------------------------------------------------------

const router = {
  status: async () => ({ ok: true, proxyEnv: { HTTPS_PROXY: "http://127.0.0.1:1" } }),
  figures: async () => ({ effort: null, cachePct: null, contextPct: null, fiveHourPct: null, fiveHourResetAt: null, workers: [], at: Date.now() }),
  models: async () => [],
};

/** The same scripted turn the server tests use: one user message in, one assistant turn out. */
function scriptedQuery(): QueryFn {
  const users: SdkUserMessage[] = [];
  const queryFn: QueryFn = params => {
    return {
      async *[Symbol.asyncIterator]() {
        let turn = 0;
        for await (const user of params.prompt) {
          users.push(user);
          if (turn++ === 0) yield { type: "system", subtype: "init", session_id: "sdk-diff" };
          yield { type: "result", subtype: "success", is_error: false, duration_ms: 5, num_turns: 1 };
        }
      },
      interrupt: async () => {},
      setModel: async () => {},
      setPermissionMode: async () => {},
      close: () => {},
    };
  };
  return queryFn;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "Timed out waiting for the host");
    await delay(5);
  }
  await nextTick();
}

test("the diff op answers through the server for the session's own folder", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-diff-wire-"));
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd);
  gitIn(cwd, "init", "-q", "-b", "main");
  write(cwd, { "a.txt": "one\n" });
  gitIn(cwd, "add", "-A");
  gitIn(cwd, "commit", "-qm", "base");
  write(cwd, { "a.txt": "one\ntwo\n", "fresh.txt": "new\n" });

  const permissions = PermissionQueue.open(path.join(dir, "permissions.json"));
  const sessions = new Sessions({
    dir, router, permissions, queryFn: scriptedQuery(), coalesceMs: 5,
    onEvent: () => {}, onSessions: () => {},
  });
  const server = new HostServer({
    listen: "127.0.0.1", port: 0, token, webDir, sessions, router,
    hostName: "test-host", version: "test-version", recentCli: async () => [],
  });
  const frames: HostMsg[] = [];
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await server.close();
    for (const session of sessions.list()) sessions.stop(session.id);
    await nextTick();
    sessions.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await server.listen();
  const id = await sessions.create({ clientMsgId: "diff-1", cwd, model: "claude-test", effort: "high", text: "ping" });

  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
  sockets.push(socket);
  socket.on("message", data => frames.push(JSON.parse(String(data)) as HostMsg));
  await new Promise<void>(resolve => socket.once("open", () => resolve()));
  const send = (msg: ClientMsg) => socket.send(JSON.stringify(msg));
  send({ t: "hello", token, clientId: "diff-client" });
  await waitFor(() => frames.some(frame => frame.t === "ready"));

  send({ t: "req", reqId: "d1", op: { op: "diff", session: id } });
  await waitFor(() => frames.some(frame => frame.t === "res" && frame.reqId === "d1"));
  const answer = frames.find(frame => frame.t === "res" && frame.reqId === "d1");
  assert.ok(answer && answer.t === "res");
  assert.equal(answer.ok, true);
  const view = answer.data as DiffView;
  assert.equal(view.scope, "uncommitted");
  assert.equal(view.branch, "main");
  assert.deepEqual(view.files.map(file => [file.path, file.status]), [["a.txt", "modified"], ["fresh.txt", "untracked"]]);
  assert.match(view.files[0]!.patch, /^\+two$/m);

  send({ t: "req", reqId: "d2", op: { op: "diff", session: "no-such-session" } });
  await waitFor(() => frames.some(frame => frame.t === "res" && frame.reqId === "d2"));
  const missing = frames.find(frame => frame.t === "res" && frame.reqId === "d2");
  assert.ok(missing && missing.t === "res");
  assert.equal(missing.ok, false);
});
