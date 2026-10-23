// The client settings ClaudeRipple writes outside its home directory: the Claude Desktop proxy and
// picker flag, the Codex CLI provider, and the CA trust. Uninstall removes them before --purge
// takes the CA and config.json they are found by.

import fs from "node:fs";
import path from "node:path";
import { configPath } from "../../router/src/config.ts";
import { certPaths } from "./certs.ts";
import { codexOff } from "./codex.ts";
import { removeAppProxy, untrustCa } from "./picker.ts";

export function setPickerEnabled(enabled: boolean, file = configPath()): void {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  raw.picker = { ...((raw.picker as Record<string, unknown> | undefined) ?? {}), enabled };
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
}

/** Best effort: one step that fails (a declined trust-removal dialog, say) does not stop the rest. */
export function removeClientIntegrations(home: string, removeTrust: (caPem: string) => boolean = untrustCa): void {
  const steps: [string, () => unknown][] = [
    ["the Claude Desktop proxy", removeAppProxy],
    ["the picker setting", () => {
      const file = path.join(home, "config.json");
      if (fs.existsSync(file)) setPickerEnabled(false, file);
    }],
    ["the Codex CLI provider", () => codexOff()],
    ["the CA trust", () => removeTrust(certPaths(home).caPem)],
  ];
  for (const [name, remove] of steps) {
    try {
      remove();
    } catch (e) {
      console.log(`  could not remove ${name}: ${(e as Error).message}`);
    }
  }
}
