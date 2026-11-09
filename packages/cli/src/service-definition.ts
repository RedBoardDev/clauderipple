// Service definitions are account-wide, not installation-local. Every writer/controller takes
// this lock; uncooperative/older writers are detected by a generation check around external work.
// Never expire a live lock: synchronous supervisor calls can outlast a lease/heartbeat. Recovery
// requires evidence that its exact process (PID + start identity) has ended, not elapsed time.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** null = definitely absent; undefined = lookup failed. Injectable without querying real processes. */
export type ProcessStartLookup = (pid: number) => string | null | undefined;

/** No signals, including signal 0. */
function processStart(pid: number): string | null | undefined {
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
    }
  }
  const windows = process.platform === "win32";
  const result = windows
    ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; $p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop; if ($p) { if (!$p.CreationDate) { throw 'process start unavailable' }; $p.CreationDate.ToUniversalTime().Ticks } else { 'absent' }`], { encoding: "utf8", windowsHide: true })
    : spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  if (!windows && result.status === 1 && !result.stdout?.trim() && !result.stderr?.trim()) return null;
  if (result.status !== 0) return undefined;
  const value = result.stdout.trim();
  return windows && value === "absent" ? null : value || undefined;
}

function recoverServiceLock(lock: string, lookup: ProcessStartLookup): boolean {
  const files = fs.readdirSync(lock);
  if (files.length !== 1) throw lockHeld(lock, true); // Uninitialized, legacy or damaged: never guess.
  const file = files[0]!;
  const match = /^(\d+)-([a-f0-9]{64})\.owner$/.exec(file);
  if (!match) throw lockHeld(lock, true);
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw lockHeld(lock, true);
  const start = lookup(pid);
  if (start === undefined || (start !== null && definitionGeneration(start) === match[2])) return false;
  // Only the reaper that unlinks this exact owner may remove the now-empty directory. A second
  // reaper must not rmdir a fresh lock in the mkdir -> owner-file initialization window.
  try { fs.unlinkSync(path.join(lock, file)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  fs.rmdirSync(lock);
  return true;
}

function lockHeld(lock: string, ownerUnknown = false): Error {
  const message = ownerUnknown
    ? `서비스 작업 잠금의 소유자를 확인할 수 없습니다. 다른 ClaudeRipple 설치, 제거, 재시작 작업이 실행 중이 아니라면 이 잠금 폴더를 삭제한 뒤 다시 시도해 주세요. (${lock})`
    : `서비스 작업 잠금이 걸려 있어 작업을 중단했습니다. 다른 작업이 완료되었는지 확인해 주세요. (${lock})`;
  return Object.assign(new Error(message), { code: "ELOCKED" });
}

/** mkdir is the atomic claim shared with older writers. Never rename over an existing lock. */
function claimServiceLock(lock: string, lookup: ProcessStartLookup): void {
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (!recoverServiceLock(lock, lookup)) throw lockHeld(lock);
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw lockHeld(lock);
    throw error;
  }
}

function acquireServiceLock(key: string, lookup: ProcessStartLookup): () => void {
  const lock = `${key}.operation-lock`;
  const start = lookup(process.pid);
  if (!start) throw new Error("서비스 작업 프로세스의 시작 정보를 확인하지 못했습니다. 다시 시도해 주세요.");
  const ownerName = `${process.pid}-${definitionGeneration(start)}.owner`;
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  claimServiceLock(lock, lookup);
  const owner = path.join(lock, ownerName);
  // If initialization fails or the process exits here, preserve the ownerless lock for manual
  // recovery: neither age nor absence of an owner proves that a legacy writer has finished.
  fs.writeFileSync(owner, "", { flag: "wx", mode: 0o600 });
  return () => { fs.unlinkSync(owner); fs.rmdirSync(lock); };
}

export function withServiceLock<T>(key: string, body: () => T, lookup: ProcessStartLookup = processStart): T {
  const release = acquireServiceLock(key, lookup);
  try { return body(); } finally { release(); }
}

export async function withServiceLockAsync<T>(key: string, body: () => Promise<T>, lookup: ProcessStartLookup = processStart): Promise<T> {
  const release = acquireServiceLock(key, lookup);
  try { return await body(); } finally { release(); }
}

/** Stable content generation, including the distinct absent generation. Never logs the contents. */
export function definitionGeneration(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
}

export function assertGeneration(read: () => unknown, expected: string): void {
  if (definitionGeneration(read()) !== expected) throw new Error("서비스 정의가 작업 도중 변경되어 작업을 중단했습니다. 현재 설치의 서비스 상태를 다시 확인해 주세요.");
}

/** Inspect errors are not absence, and a symlink is not a definition this installation may replace. */
export function readServiceFile(file: string): string | null {
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error(`서비스 정의가 일반 파일이 아니므로 보존했습니다. (${file})`);
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function writeServiceFile(file: string, text: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.new-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    const fd = fs.openSync(tmp, "wx", mode);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

type FileGuard<Args extends unknown[], Result> = { run: (...args: Args) => Result; check: () => void; write: (text: string, mode?: number) => void; remove: () => void };

export function withServiceFile<Args extends unknown[], Result, T>(file: string, run: (...args: Args) => Result, body: (guard: FileGuard<Args, Result>) => T): T {
  return withServiceLock(file, () => {
    const read = () => readServiceFile(file);
    let generation = definitionGeneration(read());
    const check = () => assertGeneration(read, generation);
    const guard: FileGuard<Args, Result> = {
      check,
      run: (...args) => {
        check();
        const result = run(...args);
        check();
        return result;
      },
      write: (text, mode) => {
        check();
        writeServiceFile(file, text, mode);
        generation = definitionGeneration(text);
      },
      remove: () => {
        check();
        fs.rmSync(file, { force: true });
        generation = definitionGeneration(null);
      },
    };
    const result = body(guard);
    check();
    return result;
  });
}
