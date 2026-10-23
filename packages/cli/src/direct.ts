// `clauderipple direct on|off` — "use Claude's default connection" and back.
//
// on:  takes Claude Code (settings.json env) and Claude Desktop (our Config Library entry) off the
//      router, removing only values that are ours, and keeps what it removed in <home>/direct.json.
//      The router, CA trust, agent files and the status mod are left alone, so `off` is instant.
// off: puts back exactly what direct.json kept. A proxy someone set in the meantime is refused
//      unless forced, and a router that is not answering is repaired first: pointing Claude at a
//      dead router is the failure this command exists to get out of.
//
// Both need Claude restarted: Desktop reads its proxy at start, Claude Code sessions at start.

import fs from "node:fs";
import path from "node:path";
import { ConfigStore, adminPort, type Config } from "../../router/src/config.ts";
import { certPaths } from "./certs.ts";
import { classifyMode, cliProxyState, desktopProxyState, fetchRouterStatus, proxyUrlFor, repair, type Mode, type RecoveryDeps } from "./doctor.ts";
import { applyAppProxy, currentAppProxy, removeAppProxy } from "./picker.ts";
import { MODEL_SLOT_ENV, editSettingsEnv, settingsEnv } from "./settings.ts";

export type DirectResult = { ok: boolean; mode: Mode; restartClaude: true; detail: string };

/** What `direct on` removed, so `direct off` can put back exactly that. */
export type DirectState = {
  at: string;
  /** settings.json env keys and the values they had. */
  cli: Record<string, string>;
  /** Our Config Library entry's proxy, and which entry was applied once ours was gone. */
  desktop: { egressProxyUrl: string; appliedAfter: string | null } | null;
};

export function directStatePath(home: string): string {
  return path.join(home, "direct.json");
}

function readState(home: string): DirectState | null {
  try {
    const s = JSON.parse(fs.readFileSync(directStatePath(home), "utf8")) as DirectState;
    return s && typeof s.cli === "object" ? s : null;
  } catch {
    return null;
  }
}

function config(home: string): Config {
  return new ConfigStore(path.join(home, "config.json")).get();
}

/** A model name Claude answers itself. Anything else in a slot only works through the router. */
const CLAUDE_MODEL = /claude|opus|sonnet|haiku|fable|mythos|^default$/i;

function currentMode(home: string): Mode {
  const cfg = config(home);
  const proxyUrl = proxyUrlFor(cfg.listen.port);
  const cli = cliProxyState(settingsEnv(), proxyUrl, certPaths(home).caPem);
  const desktop = desktopProxyState(currentAppProxy(), proxyUrl);
  return classifyMode(cli.proxy, desktop.proxy, cfg.picker?.enabled === true);
}

export function directOn(home: string): DirectResult {
  const cfg = config(home);
  const proxyUrl = proxyUrlFor(cfg.listen.port);
  const caPath = certPaths(home).caPem;
  const removedCli: Record<string, string> = {};
  const notes: string[] = [];

  const edit = editSettingsEnv((env) => {
    const proxy = cliProxyState(env, proxyUrl, caPath);
    if (proxy.proxy === "ripple" || proxy.stale) {
      removedCli.HTTPS_PROXY = env.HTTPS_PROXY!;
      delete env.HTTPS_PROXY;
    } else if (env.HTTPS_PROXY) notes.push(`left HTTPS_PROXY=${env.HTTPS_PROXY} (not ClaudeRipple's)`);
    if (env.NODE_EXTRA_CA_CERTS === caPath) {
      removedCli.NODE_EXTRA_CA_CERTS = env.NODE_EXTRA_CA_CERTS;
      delete env.NODE_EXTRA_CA_CERTS;
    }
    // A slot naming a routed model makes every request on it fail once the router is out of the
    // path (Anthropic answers 404), so those go too — but only when Claude Code is now direct.
    if (!env.HTTPS_PROXY) {
      for (const [slot, name] of Object.entries(MODEL_SLOT_ENV)) {
        const value = env[name];
        if (value === undefined) continue;
        const ours = value === cfg.cli.models?.[slot as keyof typeof MODEL_SLOT_ENV] || !CLAUDE_MODEL.test(value);
        if (!ours) continue;
        removedCli[name] = value;
        delete env[name];
      }
    }
    return Object.keys(removedCli).length > 0;
  });

  let desktop: DirectState["desktop"] = null;
  const ap = currentAppProxy();
  if (ap.ours && ap.egressProxyUrl) {
    removeAppProxy();
    desktop = { egressProxyUrl: ap.egressProxyUrl, appliedAfter: currentAppProxy().appliedId };
  } else if (ap.egressProxyUrl === proxyUrl) notes.push(`Claude Desktop's applied configuration ${ap.appliedId} points at ClaudeRipple but was not written by it; left as it is`);

  const changed = edit.changed || desktop !== null;
  if (changed) {
    // Merged with an earlier direct.json: running `direct on` twice must not forget the first.
    const previous = readState(home);
    const state: DirectState = { at: new Date().toISOString(), cli: { ...(previous?.cli ?? {}), ...removedCli }, desktop: desktop ?? previous?.desktop ?? null };
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(directStatePath(home), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  }
  const removed = [
    ...Object.keys(removedCli).map((k) => `settings.json env.${k}`),
    ...(desktop ? ["Claude Desktop's proxy entry"] : []),
  ];
  const detail = changed
    ? `Claude now connects directly. Removed: ${removed.join(", ")}. Saved in ${directStatePath(home)}.${edit.backup ? ` settings.json backup: ${edit.backup}.` : ""}`
    : "Claude was already on its default connection; nothing of ClaudeRipple's was in its settings.";
  return { ok: true, mode: currentMode(home), restartClaude: true, detail: [detail, ...notes].join(" ") };
}

export async function directOff(deps: RecoveryDeps, opts: { force?: boolean } = {}): Promise<DirectResult> {
  const home = deps.home;
  const cfg = config(home);
  const proxyUrl = proxyUrlFor(cfg.listen.port);
  const saved = readState(home);
  // No direct.json (it was removed, or Claude was taken off by hand): what `install` and
  // `picker on` would have written is the closest thing to "exactly as before".
  const cli: Record<string, string> = saved ? { ...saved.cli, ...(saved.cli.HTTPS_PROXY ? { HTTPS_PROXY: proxyUrl } : {}) } : {
    HTTPS_PROXY: proxyUrl,
    NODE_EXTRA_CA_CERTS: certPaths(home).caPem,
    ...Object.fromEntries(Object.entries(MODEL_SLOT_ENV).flatMap(([slot, name]) => {
      const model = cfg.cli.models?.[slot as keyof typeof MODEL_SLOT_ENV];
      return model ? [[name, model]] : [];
    })),
  };
  const desktopUrl = (saved ? saved.desktop : cfg.picker?.enabled) ? proxyUrl : null;
  const fail = (detail: string): DirectResult => ({ ok: false, mode: currentMode(home), restartClaude: true, detail });

  // Something set since `direct on` is someone else's choice, and replacing it needs saying so.
  const env = settingsEnv();
  if (!opts.force && cli.HTTPS_PROXY && env.HTTPS_PROXY && env.HTTPS_PROXY !== cli.HTTPS_PROXY) {
    return fail(`settings.json now sets HTTPS_PROXY=${env.HTTPS_PROXY}, which is not ClaudeRipple's; left everything as it is. Run \`clauderipple direct off --force\` to replace it.`);
  }
  const ap = currentAppProxy();
  const desktopChanged = ap.appliedId !== (saved?.desktop?.appliedAfter ?? ap.appliedId);
  if (!opts.force && desktopUrl && ap.egressProxyUrl && ap.egressProxyUrl !== desktopUrl && (desktopChanged || !saved)) {
    return fail(`Claude Desktop now uses another proxy (${ap.egressProxyUrl}); left everything as it is. Run \`clauderipple direct off --force\` to replace it.`);
  }

  const notes: string[] = [];
  if ((await (deps.routerStatus ?? fetchRouterStatus)(`http://127.0.0.1:${adminPort(cfg)}`, 4_000)) === null) {
    const fixed = await repair(deps);
    if (!fixed.doctor.router.responding) {
      const failed = fixed.steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.detail}`).join("; ");
      return fail(`the router is not answering even after a repair (${failed || "no step failed, it just did not come up"}), so Claude stays on its default connection.`);
    }
    notes.push("The router was not answering; repaired it first.");
  }

  const restoredKeys: string[] = [];
  const edit = editSettingsEnv((current) => {
    for (const [k, v] of Object.entries(cli)) {
      if (current[k] !== v) {
        current[k] = v;
        restoredKeys.push(k);
      }
    }
    return restoredKeys.length > 0;
  });
  let desktopApplied = false;
  if (desktopUrl) {
    const now = currentAppProxy();
    if (!(now.ours && now.egressProxyUrl === desktopUrl)) {
      applyAppProxy(desktopUrl);
      desktopApplied = true;
    }
  }
  fs.rmSync(directStatePath(home), { force: true });
  const restored = [...restoredKeys.map((k) => `settings.json env.${k}`), ...(desktopApplied ? ["Claude Desktop's proxy entry"] : [])];
  const detail = restored.length > 0 ? `Claude goes through ClaudeRipple again. Restored: ${restored.join(", ")}.${edit.backup ? ` settings.json backup: ${edit.backup}.` : ""}` : "Claude already went through ClaudeRipple; nothing to restore.";
  return { ok: true, mode: currentMode(home), restartClaude: true, detail: [...notes, detail].join(" ") };
}
