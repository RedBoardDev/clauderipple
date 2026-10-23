// "What changed in this session's folder", for the phone's diff pane (the official app's diff view).
// Read-only git only, run through execFile with the session's own cwd: the phone names a session and
// never a path, nothing is fetched, checked out or written, and no configured external diff or
// textconv program runs. Every answer is capped so that one diff still fits one WebSocket frame —
// a huge diff comes back truncated rather than dropped in server.ts.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { FRAME_CAP } from "./protocol.ts";
import type { DiffFile, DiffView } from "./protocol.ts";

/** One file's patch; a longer one is cut and `truncated` says so. */
export const DIFF_FILE_BYTES = 200 * 1024;
/** All patches together in one answer; one WebSocket frame can carry less, so this is a ceiling. */
export const DIFF_TOTAL_BYTES = 2 * 1024 * 1024;
/** Files listed; the rest are dropped. */
export const DIFF_FILE_COUNT = 300;
/** A frame over FRAME_CAP is dropped (server.ts), so the view keeps well inside one. */
const WIRE_BYTES = FRAME_CAP - 4 * 1024;
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
/** How many per-file diffs run at once; a folder with hundreds of files must not spawn hundreds of git processes. */
const PATCH_PARALLEL = 8;
/** An untracked file larger than this is read only in part; `truncated` says so. */
const UNTRACKED_BYTES = 2 * 1024 * 1024;
/** A NUL byte in this prefix means the file is binary, as git decides it. */
const BINARY_PROBE = 8000;

/**
 * Settings that make git read only and ask nothing: no optional locks, no credential prompt. Any
 * GIT_* that would point the command at another repository is dropped rather than trusted.
 */
const GIT_ENV: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX", "GIT_EXTERNAL_DIFF"]) delete GIT_ENV[key];
/** The person's git config must not turn a read into a program run or a quoted path. */
const GIT_CONFIG_ARGS = ["-c", "core.quotepath=off", "-c", "core.fsmonitor=false"];
/** No pager, no external diff, no textconv, no colour codes in what the phone renders. */
const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv", "--no-color"];

interface GitOut { ok: boolean; stdout: Buffer; error: NodeJS.ErrnoException | null }

/** git with a fixed cwd, a bounded buffer and a time limit; the caller decides what a failure means. */
function git(root: string, args: string[], maxBuffer = GIT_MAX_BUFFER): Promise<GitOut> {
  return new Promise((resolve) => {
    execFile("git", [...GIT_CONFIG_ARGS, "-C", root, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer, env: GIT_ENV, windowsHide: true, encoding: "buffer" },
      (error, stdout) => {
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ""));
        resolve({ ok: !error, stdout: out, error: error as NodeJS.ErrnoException | null });
      });
  });
}

export interface DiffOptions {
  /** How long the whole view may take to build; patches not started by then are left out. */
  budgetMs?: number;
  now?: () => number;
}

/**
 * The changes in `cwd`'s folder, scoped to `cwd` itself when it is a subdirectory of a repository.
 * Throws "not a git repository" (the host's answer on any other failure too) when there is no
 * repository above the folder.
 */
export async function diffView(cwd: string, opts: DiffOptions = {}): Promise<DiffView> {
  const dir = path.resolve(cwd);
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? GIT_TIMEOUT_MS);
  const top = await git(dir, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) {
    if (top.error?.code === "ENOENT") throw new Error("git is not available on this host");
    throw new Error("not a git repository");
  }
  const root = top.stdout.toString("utf8").trim();
  if (!root) throw new Error("not a git repository");
  // The phone never names a path: the folder is the session's cwd, and when that is a
  // subdirectory of a repository only that subtree is this session's to report.
  const spec = await scopeSpec(root, dir);
  const branch = await currentBranch(root);
  const head = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const { entries, truncated: listed } = await changedEntries(root, spec, head.ok);
  let truncated = listed;

  if (entries.length > 0) {
    const refs = head.ok ? ["HEAD"] : [];
    const files = await assemble(root, entries, refs, !head.ok, deadline, now);
    return { scope: "uncommitted", base: null, branch, files: files.files, truncated: truncated || files.truncated };
  }

  const base = branch ? await baseRef(root, branch) : null;
  if (base) {
    const mergeBase = await git(root, ["merge-base", base.ref, "HEAD"]);
    const from = mergeBase.ok ? mergeBase.stdout.toString("utf8").trim() : "";
    const ahead = from ? await git(root, ["rev-list", "--count", `${from}..HEAD`, "--", spec]) : null;
    const count = ahead?.ok ? Number(ahead.stdout.toString("utf8").trim()) || 0 : 0;
    if (from && count > 0) {
      const branchList = await changedEntries(root, spec, true, from);
      const files = await assemble(root, branchList.entries, [from, "HEAD"], branchList.truncated, deadline, now);
      return { scope: "branch", base: base.name, branch, files: files.files, truncated: truncated || files.truncated };
    }
  }
  return { scope: "clean", base: null, branch, files: [], truncated: false };
}

/** The pathspec for the session's own folder: "." at the repository root, the subtree below it.
 * Both sides are resolved first: a temp or /var path is a symlink on macOS, and a comparison of the
 * un-resolved forms would put the folder "outside" its own repository. */
async function scopeSpec(root: string, dir: string): Promise<string> {
  let realRoot = root;
  let realDir = dir;
  try {
    realRoot = await fs.realpath(root);
    realDir = await fs.realpath(dir);
  } catch { return "."; }
  const rel = path.relative(realRoot, realDir);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return ".";
  return rel.split(path.sep).join("/");
}

/** The branch HEAD is on, or null on a detached HEAD (or in a repository with no commit yet). */
async function currentBranch(root: string): Promise<string | null> {
  const out = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return out.ok ? out.stdout.toString("utf8").trim() || null : null;
}

interface BaseRef { ref: string; name: string }

/**
 * The branch this one is measured against: what origin/HEAD points at, else `main`, else `master`.
 * Null when none exists, and null when the current branch IS that branch — a branch is never
 * "ahead of itself", so a clean `main` is clean.
 */
async function baseRef(root: string, branch: string): Promise<BaseRef | null> {
  const originHead = await git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const candidates: BaseRef[] = [];
  const origin = originHead.ok ? originHead.stdout.toString("utf8").trim() : "";
  if (origin) candidates.push({ ref: origin, name: origin });
  for (const name of ["main", "master"]) candidates.push({ ref: `refs/heads/${name}`, name });
  for (const candidate of candidates) {
    const exists = await git(root, ["rev-parse", "--verify", "--quiet", `${candidate.ref}^{commit}`]);
    if (!exists.ok) continue;
    const short = candidate.name.slice(candidate.name.lastIndexOf("/") + 1);
    return short === branch ? null : candidate;
  }
  return null;
}

interface Entry {
  /** path from the repository root, as git prints it */
  path: string;
  oldPath?: string;
  status: DiffFile["status"];
  added: number;
  removed: number;
  /** read from disk instead of `git diff` (untracked, or a file in a repository with no commit) */
  fresh: boolean;
  /** named on the final `git diff` command line: the old path too, so a rename keeps its header */
  paths: string[];
}

interface Listed { entries: Entry[]; truncated: boolean }

/**
 * What changed, from three read-only commands: numstat (line counts, binary, renames), name-status
 * (how each file changed) and ls-files (untracked, minus what .gitignore excludes).
 */
async function changedEntries(root: string, spec: string, hasHead: boolean, from?: string): Promise<Listed> {
  const others = await git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", spec]);
  const untracked = others.ok ? segments(others.stdout).filter(Boolean) : [];
  if (!hasHead) {
    // No commit yet: every file in the folder is new work, whether staged or not.
    const cached = await git(root, ["ls-files", "--cached", "-z", "--", spec]);
    const staged = cached.ok ? segments(cached.stdout).filter(Boolean) : [];
    const entries: Entry[] = [
      ...staged.map(name => ({ path: name, status: "added" as const, added: 0, removed: 0, fresh: true, paths: [] as string[] })),
      ...untracked.map(name => ({ path: name, status: "untracked" as const, added: 0, removed: 0, fresh: true, paths: [] as string[] })),
    ];
    return { entries, truncated: !others.ok || !cached.ok };
  }
  const refs = from ? [from, "HEAD"] : ["HEAD"];
  const [numstat, names] = await Promise.all([
    git(root, ["diff", ...DIFF_FLAGS, "--numstat", "-z", "-M", ...refs, "--", spec]),
    git(root, ["diff", ...DIFF_FLAGS, "--name-status", "-z", "-M", ...refs, "--", spec]),
  ]);
  if (!names.ok) throw new Error("the folder's git history could not be read");
  const counts = numstat.ok ? parseNumstat(segments(numstat.stdout)) : new Map<string, Counts>();
  const entries: Entry[] = parseNameStatus(segments(names.stdout)).map(({ path: name, oldPath, code }) => {
    const count = counts.get(name);
    const binary = count?.binary ?? false;
    const paths = oldPath ? [oldPath, name] : [name];
    return {
      path: name,
      ...(oldPath ? { oldPath } : {}),
      status: binary ? "binary" : statusOf(code),
      added: count?.added ?? 0,
      removed: count?.removed ?? 0,
      fresh: false,
      paths,
    };
  });
  for (const name of untracked) entries.push({ path: name, status: "untracked", added: 0, removed: 0, fresh: true, paths: [] });
  // A numstat that did not fit its buffer leaves counts at zero; say so rather than show a wrong zero.
  return { entries, truncated: !numstat.ok || !others.ok };
}

interface Counts { added: number; removed: number; oldPath?: string; binary: boolean }

function segments(buf: Buffer): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) continue;
    out.push(buf.toString("utf8", start, i));
    start = i + 1;
  }
  if (start < buf.length) out.push(buf.toString("utf8", start));
  return out;
}

/** `added\tremoved\tpath\0`; a rename is `added\tremoved\t\0old\0new\0` and a binary is `-\t-`. */
function parseNumstat(fields: string[]): Map<string, Counts> {
  const out = new Map<string, Counts>();
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (!field) continue;
    const first = field.indexOf("\t");
    const second = field.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    const rawAdded = field.slice(0, first);
    const rawRemoved = field.slice(first + 1, second);
    let name = field.slice(second + 1);
    let oldPath: string | undefined;
    if (!name) { oldPath = fields[++i]; name = fields[++i] ?? ""; }
    if (!name) continue;
    const binary = rawAdded === "-" || rawRemoved === "-";
    out.set(name, {
      added: binary ? 0 : Number(rawAdded) || 0,
      removed: binary ? 0 : Number(rawRemoved) || 0,
      ...(oldPath ? { oldPath } : {}),
      binary,
    });
  }
  return out;
}

/** `M\0path\0`; a rename or copy is `R100\0old\0new\0`. */
function parseNameStatus(fields: string[]): { path: string; oldPath?: string; code: string }[] {
  const out: { path: string; oldPath?: string; code: string }[] = [];
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i]!;
    if (!code) continue;
    const letter = code[0]!;
    if (letter === "R" || letter === "C") {
      const oldPath = fields[++i] ?? "";
      const name = fields[++i] ?? "";
      if (name) out.push({ path: name, ...(oldPath ? { oldPath } : {}), code: letter });
    } else {
      const name = fields[++i] ?? "";
      if (name) out.push({ path: name, code: letter });
    }
  }
  return out;
}

function statusOf(code: string): DiffFile["status"] {
  if (code === "R") return "renamed";
  if (code === "D") return "deleted";
  if (code === "A" || code === "C") return "added";
  return "modified";
}

interface Assembled { files: DiffFile[]; truncated: boolean }

/**
 * Line counts and patches for at most DIFF_FILE_COUNT entries, in order. Fresh entries are read from
 * disk (never through a symlink), tracked ones come from `git diff` for that path alone.
 */
async function assemble(root: string, entries: Entry[], refs: string[], cut: boolean, deadline: number, now: () => number): Promise<Assembled> {
  const kept = entries.slice(0, DIFF_FILE_COUNT);
  let truncated = cut || entries.length > kept.length;
  const patches: string[] = new Array(kept.length).fill("");
  const pending: number[] = [];
  for (let i = 0; i < kept.length; i++) if (!kept[i]!.fresh && kept[i]!.status !== "binary") pending.push(i);
  await mapLimit(pending, PATCH_PARALLEL, async (index) => {
    const entry = kept[index]!;
    if (now() >= deadline) { truncated = true; return; }
    const out = await git(root, ["diff", ...DIFF_FLAGS, "-M", ...refs, "--", ...entry.paths]);
    if (!out.ok) { truncated = true; return; }
    patches[index] = out.stdout.toString("utf8");
  });
  // Fresh files carry their content as added lines. Read them together; each read is bounded.
  const fresh = kept.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.fresh);
  await mapLimit(fresh, PATCH_PARALLEL, async ({ entry, index }) => {
    try {
      const read = await freshFile(root, entry.path);
      if (read.cut) truncated = true;
      // A file the folder no longer has, or whose bytes are not text, says so; otherwise the listing's
      // own word stands ("added" for a staged file in a repository with no commit, else "untracked").
      if (read.deleted) entry.status = "deleted";
      else if (read.binary) entry.status = "binary";
      entry.added = read.added;
      entry.removed = read.removed;
      patches[index] = read.patch;
    } catch { truncated = true; }
  });

  const files: DiffFile[] = [];
  const budget = Math.min(DIFF_TOTAL_BYTES, WIRE_BYTES);
  let spent = 0;
  for (let i = 0; i < kept.length; i++) {
    const entry = kept[i]!;
    const full = capBytes(patches[i] ?? "", DIFF_FILE_BYTES);
    if (full.cut) truncated = true;
    // The whole answer must fit a frame: a patch past the remaining budget is left out (its counts stay).
    const cost = Buffer.byteLength(JSON.stringify(full.text)) + Buffer.byteLength(entry.path) + 240;
    let text = full.text;
    if (spent + cost > budget) {
      if (text) truncated = true;
      text = "";
    } else {
      spent += cost;
    }
    files.push({
      path: entry.path,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      status: entry.status,
      added: entry.added,
      removed: entry.removed,
      patch: text,
    });
  }
  // Last guard, for what the per-file estimate cannot see (escaping, long paths): drop patches from
  // the end until the answer fits. A phone never receives a frame the server would refuse to send.
  for (let i = files.length - 1; i >= 0 && Buffer.byteLength(JSON.stringify(files)) > budget; i--) {
    if (!files[i]!.patch) continue;
    files[i]!.patch = "";
    truncated = true;
  }
  return { files, truncated };
}

interface FreshRead { binary: boolean; deleted: boolean; added: number; removed: number; patch: string; cut: boolean }

/** What lstat says about one file; taken from the call itself so no extra fs type import is needed. */
type StatInfo = Awaited<ReturnType<typeof fs.lstat>>;

/**
 * One file that git does not have in HEAD, read from disk. A symlink is never followed: only the
 * link's own text is shown, which is all git would store anyway. A binary is `binary` with no patch.
 */
async function freshFile(root: string, name: string): Promise<FreshRead> {
  const abs = path.join(root, name);
  let info: StatInfo;
  try { info = await fs.lstat(abs); }
  catch { return { binary: false, deleted: true, added: 0, removed: 0, patch: "", cut: false }; }
  if (info.isSymbolicLink()) {
    let target = "";
    try { target = await fs.readlink(abs); } catch { /* a link whose text cannot be read has no content to show */ }
    const patch = capBytes(newFilePatch(name, target, "120000"), DIFF_FILE_BYTES);
    return { binary: false, deleted: false, added: target ? 1 : 0, removed: 0, patch: patch.text, cut: patch.cut };
  }
  if (!info.isFile()) return { binary: true, deleted: false, added: 0, removed: 0, patch: "", cut: false };
  const want = Math.max(0, Math.min(info.size, UNTRACKED_BYTES));
  const handle = await fs.open(abs, "r");
  let data: Buffer;
  try {
    const buffer = Buffer.alloc(want);
    const { bytesRead } = await handle.read(buffer, 0, want, 0);
    data = buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
  if (data.subarray(0, BINARY_PROBE).includes(0)) return { binary: true, deleted: false, added: 0, removed: 0, patch: "", cut: info.size > UNTRACKED_BYTES };
  const text = data.toString("utf8");
  const added = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  const mode = (info.mode & 0o111) !== 0 ? "100755" : "100644";
  const patch = capBytes(newFilePatch(name, text, mode), DIFF_FILE_BYTES);
  return { binary: false, deleted: false, added, removed: 0, patch: patch.text, cut: patch.cut || info.size > UNTRACKED_BYTES };
}

/** A unified diff for a file git has no version of, built the way git would print one. */
function newFilePatch(name: string, text: string, mode: string): string {
  const lines = text === "" ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  const body = lines.map(line => `+${line}`).join("\n") + (lines.length && !text.endsWith("\n") ? "\n\\ No newline at end of file" : "");
  return [
    `diff --git a/${name} b/${name}`,
    `new file mode ${mode}`,
    "--- /dev/null",
    `+++ b/${name}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
  ].join("\n").replace(/\n?$/, "\n");
}

interface Capped { text: string; cut: boolean }

/** At most `max` UTF-8 bytes, cut back to a line boundary so a patch never ends mid-line. */
function capBytes(text: string, max: number): Capped {
  if (Buffer.byteLength(text) <= max) return { text, cut: false };
  let low = 0;
  let high = Math.min(text.length, max);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid)) <= max) low = mid;
    else high = mid - 1;
  }
  const sliced = text.slice(0, low);
  const newline = sliced.lastIndexOf("\n");
  return { text: newline > 0 ? sliced.slice(0, newline + 1) : sliced, cut: true };
}

/** Run `work` over `items`, at most `limit` at a time, keeping every result. */
async function mapLimit<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await work(items[index]!);
    }
  });
  await Promise.all(workers);
}
