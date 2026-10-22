// Quitting and reopening Claude Desktop, which is how it picks up a changed connection. The caller
// asks the user first: quitting ends whatever is open in the app.

import { execFile } from "node:child_process";

const MAC_BUNDLE_ID = "com.anthropic.claudefordesktop";
const QUIT_WAIT_MS = 20_000;

function run(file: string, args: string[], timeoutMs = 30_000): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout) }));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True once Claude Desktop is running again. */
export async function reopenClaude(): Promise<boolean> {
  if (process.platform === "darwin") return reopenMac();
  if (process.platform === "win32") return reopenWindows();
  return false;
}

async function macRunning(): Promise<boolean> {
  // `is running` asks without launching the app.
  const r = await run("osascript", ["-e", `application id "${MAC_BUNDLE_ID}" is running`], 10_000);
  return r.ok && r.stdout.trim() === "true";
}

/**
 * When the running Claude Desktop started (epoch ms), `null` when it is not running, `undefined`
 * when that cannot be told here. Reopening it by hand applies a changed connection just as the
 * window's button does, and this is how the window notices.
 */
export async function claudeStartedAt(): Promise<number | null | undefined> {
  if (process.platform === "darwin") {
    // `lstart` is the local start time ("Tue Oct 20 22:13:48 2026"), which Date.parse reads as local.
    const r = await run("ps", ["-axo", "lstart=,comm="], 10_000);
    if (!r.ok) return undefined;
    const line = r.stdout.split("\n").find((l) => l.trimEnd().endsWith(".app/Contents/MacOS/Claude"));
    if (!line) return null;
    const at = Date.parse(line.trim().split(/\s+/).slice(0, 5).join(" "));
    return Number.isFinite(at) ? at : undefined;
  }
  if (process.platform === "win32") {
    const script = "$p = Get-Process -Name claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }";
    const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 15_000);
    if (!r.ok) return undefined;
    const text = r.stdout.trim();
    if (!text) return null;
    const at = Date.parse(text);
    return Number.isFinite(at) ? at : undefined;
  }
  return undefined;
}

async function reopenMac(): Promise<boolean> {
  if (await macRunning()) {
    await run("osascript", ["-e", `tell application id "${MAC_BUNDLE_ID}" to quit`]);
    const deadline = Date.now() + QUIT_WAIT_MS;
    while (Date.now() < deadline && (await macRunning())) await sleep(500);
    // Opening it while the old one is still on its way out would only bring that one forward.
    if (await macRunning()) return false;
  }
  const opened = await run("open", ["-b", MAC_BUNDLE_ID]);
  return opened.ok || (await run("open", ["-a", "Claude"])).ok;
}

/**
 * Claude Desktop is the claude.exe that owns a window; Claude Code's own claude.exe (terminal
 * sessions, the copy Desktop caches) has none and must not be touched. Closing the window asks it
 * to quit; whatever of that same executable is left after a few seconds is ended, then it is
 * started again from the same path.
 */
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$main = Get-Process -Name claude | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path } | Select-Object -First 1
if ($main) {
  $exe = $main.Path
  Get-Process -Name claude | Where-Object { $_.Path -eq $exe } | ForEach-Object { [void]$_.CloseMainWindow() }
  $deadline = (Get-Date).AddSeconds(8)
  while ((Get-Process -Name claude | Where-Object { $_.Path -eq $exe }) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  Get-Process -Name claude | Where-Object { $_.Path -eq $exe } | Stop-Process -Force
  Start-Sleep -Milliseconds 500
} else {
  $exe = Join-Path $env:LOCALAPPDATA 'AnthropicClaude\claude.exe'
  if (-not (Test-Path $exe)) { exit 1 }
}
Start-Process -FilePath $exe
if (-not $?) { exit 1 }
`;

async function reopenWindows(): Promise<boolean> {
  const r = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_SCRIPT], 40_000);
  return r.ok;
}
