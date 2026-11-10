// Independent evidence for migrating a Desktop entry written before installationHome existed.
// A matching proxy URL alone must never authorize adoption of an account-wide client setting.
import path from "node:path";
import os from "node:os";
import { ConfigStore } from "../../router/src/config.ts";
import * as launchd from "./launchd.ts";
import * as systemd from "./systemd.ts";
import * as schtasks from "./schtasks.ts";
import { routerIdentity, type StatusProbe, type ListenPids } from "./router-state.ts";
import { withServiceFile, withServiceLock, assertGeneration, definitionGeneration } from "./service-definition.ts";

export type DesktopServiceDeps = {
  platform?: NodeJS.Platform;
  launchctl?: launchd.Launchctl;
  systemctl?: systemd.Systemctl;
  task?: schtasks.TaskDeps;
  probe?: StatusProbe;
  listenPids?: ListenPids;
};

export function verifiedDesktopService(home: string, proxyUrl: string, deps: DesktopServiceDeps = {}): boolean {
  const cfg = new ConfigStore(path.join(home, "config.json")).get();
  if (proxyUrl !== `http://127.0.0.1:${cfg.listen.port}`) return false;
  const identity = (pid: number | null) => pid !== null && routerIdentity(home, { expectedPid: pid, ...deps }) === "ours";
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    const read = () => schtasks.existingTaskDefinition(undefined, deps.task);
    return withServiceLock(path.join(os.homedir(), ".clauderipple", "service-locks", encodeURIComponent(schtasks.taskName().toLowerCase())), () => {
      const generation = definitionGeneration(read());
      if (schtasks.taskOwnership(home, deps.task).state !== "ours") return false;
      const verified = identity(schtasks.taskRouterPid(undefined, { home, ...(deps.task ? { deps: deps.task } : {}) }));
      assertGeneration(read, generation);
      return verified;
    });
  }
  const file = platform === "linux" ? systemd.unitPath() : launchd.plistPath();
  if (platform === "linux") return withServiceFile(file, () => systemd.agentPid(deps.systemctl), guard => {
    if (systemd.unitOwnership(home).state !== "ours") return false;
    const verified = identity(guard.run());
    guard.check();
    return verified;
  });
  return withServiceFile(file, deps.launchctl ?? launchd.launchctl, guard => {
    if (launchd.agentOwnership(home).state !== "ours") return false;
    const verified = identity(launchd.agentPid(guard.run));
    guard.check();
    return verified;
  });
}
