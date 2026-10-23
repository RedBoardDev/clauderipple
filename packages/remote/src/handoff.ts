import { execFile, spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { batchCommand } from "./sdk-launcher.ts";

export interface HandoffRequest { sessionId: string; title: string; cwd: string }
export type HandoffRunner = (request: HandoffRequest) => Promise<string>;

/** macOS keeps script; Windows uses the OS's headless console (no visible window).
 * Measured on CLI 2.1.304: redirected stdout is rejected, even without --print.
 * --name is incompatible with --desktop; the persisted SDK title is read instead. */
export function desktopHandoff(claudePath: string, timeoutMs = 30_000, platform = process.platform): HandoffRunner | undefined {
  if (platform !== "darwin" && platform !== "win32") return undefined;
  return ({ sessionId, cwd }) => new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const args = ["--desktop", "--resume", sessionId];
    const batch = platform === "win32" && /\.(cmd|bat)$/i.test(claudePath);
    const command = platform === "darwin" ? "/usr/bin/script" : "conhost.exe";
    const cli = batch ? [`"${process.env.ComSpec ?? "cmd.exe"}"`, "/d", "/c", "call", batchCommand(claudePath, args)] : [claudePath, ...args];
    const child = spawn(command, platform === "darwin" ? ["-q", "/dev/null", claudePath, ...args] : ["--headless", ...cli], {
      // An ignored/closed stdin makes conhost exit before launching its child. Keep the pipe open.
      cwd, env, detached: platform === "darwin", windowsHide: true, windowsVerbatimArguments: batch,
      stdio: [platform === "darwin" ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let output = "", timedOut = false;
    const collect = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-4000); };
    child.stdout!.on("data", collect);
    child.stderr!.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      if (!child.pid) return;
      if (platform === "win32") {
        // Include a batch launcher's descendants; negative process-group PIDs are POSIX-only.
        execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 }, error => {
          if (error && child.exitCode === null) {
            child.kill();
            reject(new Error(`timed out; taskkill failed: ${error.message}`));
          }
        });
      } else {
        // Kill the PTY wrapper and its CLI, not just the wrapper.
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") reject(error); }
      }
    }, timeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const detail = (platform === "win32" ? stripVTControlCharacters(output) : output).replace(/\s+/g, " ").trim();
      if (timedOut || code !== 0) reject(new Error(`${timedOut ? "timed out" : `exit ${code ?? signal}`} ${detail}`));
      // conhost returns 0 even when the CLI fails (including unsupported Windows ARM64).
      // Only the CLI's positive acknowledgement counts, never the wrapper's exit code alone.
      else if (platform === "win32" && !/Opening session\b.*\bin Claude Desktop\b/i.test(detail)) reject(new Error(detail || "desktop CLI exited without confirming handoff"));
      else resolve(detail || "opened");
    });
  });
}
