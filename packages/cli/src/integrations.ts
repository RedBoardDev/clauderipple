// The client settings ClaudeRipple writes outside its home directory: the Claude Desktop proxy and
// picker flag, the Codex CLI provider, and the CA trust. Uninstall removes them before --purge
// takes the CA and config.json they are found by.
//
// They are shared by every install on the account, so each goes only when it is this home's: the
// proxy and the Codex provider when they point at this router's port, the CA by its fingerprint,
// and worker files the default home does not also record. A release check installed under its own
// CLAUDERIPPLE_HOME then took the real install's Desktop proxy, Codex provider and CA with it on
// uninstall (2026-10-24; that time the real install used none of them).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configPath } from "../../router/src/config.ts";
import { certPaths } from "./certs.ts";
import { codexOff, codexPort } from "./codex.ts";
import { proxyUrlFor } from "./doctor.ts";
import { removeAppProxy, untrustCa } from "./picker.ts";
import { defaultAgentDir, removeGeneratedAgentFiles } from "../../router/src/agents.ts";
import { setAgentTitleHook, setStatusMod } from "./settings.ts";
import { runtime } from "./runtime.ts";

/** The home an install without CLAUDERIPPLE_HOME uses: the one whose leftovers are swept. */
export function defaultHome(): string {
  return path.join(os.homedir(), ".clauderipple");
}

function listenPort(home: string): number | undefined {
  try {
    const port = (JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")) as { listen?: { port?: unknown } }).listen?.port;
    return typeof port === "number" ? port : undefined;
  } catch {
    return undefined;
  }
}

export function setPickerEnabled(enabled: boolean, file = configPath()): void {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  raw.picker = { ...((raw.picker as Record<string, unknown> | undefined) ?? {}), enabled };
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
}

/** Best effort: one step that fails (a declined trust-removal dialog, say) does not stop the rest. */
export function removeClientIntegrations(
  home: string,
  removeTrust: (caPem: string, opts: { sweep?: boolean }) => boolean = untrustCa,
  opts: { modDir?: string; agentDir?: string; port?: number; defaultHome?: string } = {},
): boolean {
  const rt = runtime();
  const main = opts.defaultHome ?? defaultHome();
  const isDefault = path.resolve(home) === path.resolve(main);
  const port = opts.port ?? listenPort(home);
  // The default home removes what it finds, as before; another home only what points at its port.
  const ours = (pointsAt: number | null | undefined): boolean => isDefault || (port !== undefined && pointsAt === port);
  const steps: [string, () => unknown][] = [
    ["the status mod", () => {
      setStatusMod(false, opts.modDir ?? rt.modDir);
      setStatusMod(false, path.join(home, "mod"));
    }],
    ["the agent-title hook", () => setAgentTitleHook(false, { node: rt.node, script: rt.hookScript })],
    ["generated worker files", () => removeGeneratedAgentFiles(opts.agentDir ?? defaultAgentDir(), path.join(home, "generated-agents.json"), isDefault ? undefined : path.join(main, "generated-agents.json"))],
    ["the Claude Desktop proxy", () => isDefault ? removeAppProxy() : port !== undefined && removeAppProxy(proxyUrlFor(port))],
    ["the picker setting", () => {
      const file = path.join(home, "config.json");
      if (fs.existsSync(file)) setPickerEnabled(false, file);
    }],
    ["the Codex CLI provider", () => ours(codexPort()) && codexOff()],
    ["the CA trust", () => removeTrust(certPaths(home).caPem, { sweep: isDefault })],
  ];
  let ok = true;
  for (const [name, remove] of steps) {
    try {
      remove();
    } catch (e) {
      ok = false;
      console.log(`  could not remove ${name}: ${(e as Error).message}`);
    }
  }
  return ok;
}
