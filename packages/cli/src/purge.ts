// Home removal is a separate boundary so it can be exercised without a supervisor or user settings.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { windowsPowerShellEnv } from "./windows-powershell.ts";

export type PurgeResult = { status: "removed" } | { status: "deferred"; resultFile: string };

/** A running Windows image cannot be deleted. Pending is NOT a successful purge (CLI exits 2).
 * The external cleaner records its final exit code after this process has released node.exe. */
export async function purgeHome(home: string): Promise<PurgeResult> {
  const target = path.resolve(home);
  if (target === path.parse(target).root || path.relative(os.homedir(), target) === "") throw new Error("사용자 홈이나 드라이브 전체는 삭제할 수 없습니다.");
  const relative = path.relative(target, process.execPath);
  const self = process.platform === "win32" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  if (self) return deferPurge(target);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  return { status: "removed" };
}

async function deferPurge(home: string): Promise<PurgeResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clauderipple-purge-"));
  const relative = path.relative(home, dir);
  if (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error("설치 폴더 외부의 임시 폴더가 필요합니다. TEMP를 변경한 뒤 다시 시도해 주세요.");
  }
  const resultFile = path.join(dir, "result.json");
  fs.writeFileSync(resultFile, JSON.stringify({ status: "pending" }));
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  // cmd's rd does not traverse directory junctions. The target is expanded exactly once from
  // the environment, never interpolated into command syntax (%, &, ! and quotes stay data).
  const script = [
    "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'",
    `$result=${quote(resultFile)}; $target=${quote(home)}`,
    `@{status='running'; parent=${process.pid}} | ConvertTo-Json -Compress | Set-Content -LiteralPath $result -Encoding ASCII`,
    "try {",
    `  Wait-Process -Id ${process.pid} -Timeout 120 -ErrorAction SilentlyContinue`,
    `  if(Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { throw 'uninstall process has not exited' }`,
    "  $env:CR_PURGE_TARGET=$target; $errorText='directory is still present'",
    "  for($i=0;$i -lt 30;$i++) {",
    "    $ErrorActionPreference='Continue'; & $env:ComSpec /d /v:off /c 'rd /s /q \"%CR_PURGE_TARGET%\"' 2>&1 | Out-Null; $ErrorActionPreference='Stop'",
    "    if(-not [System.IO.Directory]::Exists($target)) { '{\"exitCode\":0}' | Set-Content -LiteralPath $result -Encoding ASCII; exit 0 }",
    "    Start-Sleep -Milliseconds 200",
    "  }",
    "  throw $errorText",
    "} catch {",
    "  [System.IO.File]::WriteAllText($result, (@{exitCode=1; error=$_.Exception.Message} | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false))); exit 1",
    "}",
  ].join("\r\n");
  const program = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const scriptFile = path.join(dir, "cleanup.ps1");
  fs.writeFileSync(scriptFile, "\ufeff" + script);
  try {
    // Windows PowerShell exits without executing when launched as a console-less detached
    // process. Start-Process is the same independent Windows launch used by our supervisor.
    const launch = `$ErrorActionPreference='Stop'; Start-Process -FilePath ${quote(program)} -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${quote(`"${scriptFile}"`)}) -WindowStyle Hidden -RedirectStandardOutput ${quote(path.join(dir, "cleanup.log"))} -RedirectStandardError ${quote(path.join(dir, "cleanup.err.log"))} | Out-Null`;
    execFileSync(program, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(launch, "utf16le").toString("base64")], { cwd: os.tmpdir(), env: windowsPowerShellEnv(), stdio: "ignore", windowsHide: true, timeout: 10_000 });
    for (let i = 0; i < 50; i++) {
      if (fs.readFileSync(resultFile, "utf8").includes('"running"')) return { status: "deferred", resultFile };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("외부 정리 프로세스가 시작을 확인하지 않았습니다.");
  } catch (error) {
    throw new Error(`외부 정리를 시작하지 못했습니다. 기록: ${dir}`, { cause: error });
  }
}
