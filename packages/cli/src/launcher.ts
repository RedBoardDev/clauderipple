// `clauderipple app --install|--uninstall`: something to double-click that opens the menu-bar app.
//
// On macOS the separately installed native app owns its bundle and login item; --install opens
// it by bundle id instead of creating an Electron launcher. --uninstall only removes a legacy
// com.clauderipple.launcher bundle, never the native app, and does not quit any running app.
// Elsewhere the launcher runs `clauderipple tray --ensure`: fetch Electron once if missing,
// then start the tray that offers recovery even when the router is down.
//
//   macOS   com.clauderipple.mac (native app); legacy launcher removal in ~/Applications
//   Windows Start Menu and Desktop shortcuts (.lnk, WScript.Shell) to a hidden PowerShell launcher
//   Linux   ~/.local/share/applications/clauderipple.desktop
//
// CLAUDERIPPLE_LAUNCHER_DIR replaces every target directory (tests, or a custom location).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Runtime } from "./runtime.ts";
import { windowsPowerShellEnv } from "./windows-powershell.ts";
import { openNativeApp, type TrayStart } from "./tray.ts";

export const LAUNCHER_BUNDLE_ID = "com.clauderipple.launcher";
const APP_NAME = "ClaudeRipple";
const DESKTOP_MARK = "X-ClaudeRipple-Launcher=1";

export type LauncherResult = { ok: boolean; paths: string[]; detail: string };

type Opts = { rt: Runtime; home: string; version: string; platform?: NodeJS.Platform; powershell?: (script: string) => string; openApp?: () => TrayStart };

function overrideDir(): string | null {
  return process.env.CLAUDERIPPLE_LAUNCHER_DIR ?? null;
}

export function macAppPath(): string {
  return path.join(overrideDir() ?? path.join(os.homedir(), "Applications"), `${APP_NAME}.app`);
}

export function desktopEntryPath(): string {
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(overrideDir() ?? path.join(data, "applications"), "clauderipple.desktop");
}

export function windowsTrayLauncherPath(home: string): string {
  return path.join(home, "clauderipple-tray.ps1");
}

/** PowerShell single-quoted literal; the only escape inside one is a doubled quote. */
function ps(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** A desktop-entry Exec argument (freedesktop Desktop Entry spec, "The Exec key"). */
function execArg(value: string): string {
  return `"${value.replace(/([\\"`$])/g, "\\$1").replace(/%/g, "%%")}"`;
}

function launchEnv(rt: Runtime, home: string): Record<string, string> {
  return { CLAUDERIPPLE_HOME: home, ...rt.env };
}

/** The app icon (icon.icns / icon.png / icon.ico), committed in the app's assets and shipped in the npm package beside the tray. */
function findIcon(rt: Runtime, file: string): string | null {
  for (const dir of [path.join(rt.repo, "packages", "app", "assets"), path.join(rt.repo, "dist", "app", "assets")]) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function desktopEntry(rt: Runtime, home: string): string {
  const env = Object.entries(launchEnv(rt, home)).map(([k, v]) => execArg(`${k}=${v}`));
  const icon = findIcon(rt, "icon.png");
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${APP_NAME}`,
    "Comment=ClaudeRipple menu-bar app: router status, repair, and Claude's default connection",
    `Exec=env ${env.join(" ")} ${execArg(rt.node)} ${execArg(rt.cli)} tray --ensure`,
    ...(icon ? [`Icon=${icon}`] : []),
    "Terminal=false",
    "Categories=Utility;Development;",
    DESKTOP_MARK,
    "",
  ].join("\n");
}

export function windowsTrayLauncher(rt: Runtime, home: string): string {
  const log = path.join(home, "logs", "launcher.log");
  return [
    ...Object.entries(launchEnv(rt, home)).map(([k, v]) => `$env:${k} = ${ps(v)}`),
    `New-Item -ItemType Directory -Force -Path ${ps(path.dirname(log))} | Out-Null`,
    `& ${ps(rt.node)} ${ps(rt.cli)} tray --ensure *>> ${ps(log)}`,
  ].join("\r\n") + "\r\n";
}

/**
 * Creates (or, with `remove`, deletes) the shortcuts and prints each path. Without an override the
 * folders are the user's own Start Menu programs and Desktop, as Windows names them.
 */
export function windowsShortcutScript(launcher: string, iconSource: string, dir: string | null, remove = false): string {
  const targets = dir
    ? `@(${ps(path.join(dir, "Start Menu", `${APP_NAME}.lnk`))}, ${ps(path.join(dir, "Desktop", `${APP_NAME}.lnk`))})`
    : `@((Join-Path ([Environment]::GetFolderPath('Programs')) '${APP_NAME}.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) '${APP_NAME}.lnk'))`;
  if (remove) {
    return [`$ErrorActionPreference = 'Stop'`, `foreach ($p in ${targets}) { if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force; $p } }`].join("; ");
  }
  // conhost --headless: started directly, PowerShell gets a console from the default terminal and
  // a window stays on screen (#49, the same reason the router's scheduled task uses it).
  const args = `--headless powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${launcher}"`;
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$ws = New-Object -ComObject WScript.Shell`,
    `foreach ($p in ${targets}) { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $p) | Out-Null; $s = $ws.CreateShortcut($p); $s.TargetPath = (Join-Path $env:SystemRoot 'System32\\conhost.exe'); $s.Arguments = ${ps(args)}; $s.IconLocation = ${ps(`${iconSource},0`)}; $s.Description = 'ClaudeRipple menu-bar app'; $s.Save(); $p }`,
  ].join("; ");
}

function runPowerShell(script: string): string {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: windowsPowerShellEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 30_000,
  }).toString();
}

/** Bundle id of an existing .app, or null when it has none we can read. */
function bundleIdOf(app: string): string | null {
  try {
    const plist = fs.readFileSync(path.join(app, "Contents", "Info.plist"), "utf8");
    return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function installLauncher(opts: Opts): LauncherResult {
  const platform = opts.platform ?? process.platform;
  if (platform === "darwin") {
    // The native app owns its bundle and login item. Never overwrite it with a shell launcher.
    const result = (opts.openApp ?? openNativeApp)();
    return { ok: result.ok, paths: [], detail: result.message };
  }
  if (opts.rt.packaged) return { ok: true, paths: [], detail: "This is the standalone ClaudeRipple app, which opens the menu-bar app itself; no launcher needed." };
  if (platform === "linux") {
    const file = desktopEntryPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, desktopEntry(opts.rt, opts.home), { mode: 0o755 });
    return { ok: true, paths: [file], detail: `${APP_NAME} is in your applications menu.` };
  }
  if (platform === "win32") {
    const launcher = windowsTrayLauncherPath(opts.home);
    fs.mkdirSync(opts.home, { recursive: true });
    fs.writeFileSync(launcher, windowsTrayLauncher(opts.rt, opts.home));
    const out = (opts.powershell ?? runPowerShell)(windowsShortcutScript(launcher, findIcon(opts.rt, "icon.ico") ?? opts.rt.node, overrideDir()));
    const paths = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return { ok: true, paths, detail: `${APP_NAME} is in the Start Menu and on the Desktop.` };
  }
  return { ok: false, paths: [], detail: `no launcher for ${platform}; start the menu-bar app with: clauderipple tray` };
}

export function uninstallLauncher(opts: Opts): LauncherResult {
  const platform = opts.platform ?? process.platform;
  const removed: string[] = [];
  if (platform === "darwin") {
    const app = macAppPath();
    if (fs.existsSync(app)) {
      if (bundleIdOf(app) !== LAUNCHER_BUNDLE_ID) return { ok: false, paths: [], detail: `${app} is not ClaudeRipple's launcher; left it alone.` };
      fs.rmSync(app, { recursive: true, force: true });
      removed.push(app);
    }
  } else if (platform === "linux") {
    const file = desktopEntryPath();
    if (fs.existsSync(file)) {
      if (!fs.readFileSync(file, "utf8").includes(DESKTOP_MARK)) return { ok: false, paths: [], detail: `${file} is not ClaudeRipple's launcher; left it alone.` };
      fs.rmSync(file);
      removed.push(file);
    }
  } else if (platform === "win32") {
    const out = (opts.powershell ?? runPowerShell)(windowsShortcutScript(windowsTrayLauncherPath(opts.home), opts.rt.node, overrideDir(), true));
    removed.push(...out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    fs.rmSync(windowsTrayLauncherPath(opts.home), { force: true });
  }
  return { ok: true, paths: removed, detail: removed.length ? "launcher removed" : "no launcher was installed" };
}
