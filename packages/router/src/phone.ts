// Admin → host control bridge. Never forwards arbitrary URLs, headers or redirects.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { DEFAULT_PORT, remoteHome } from "../../remote/src/config.ts";
import { fileURLToPath } from "node:url";

export interface PhoneDeps {
  home?: string;
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  uid?: number;
  exec?: (file: string, args: string[]) => Promise<void>;
}
export interface PhoneResponse { status: number; body: unknown }
const INSTALL_HINT = "clauderipple remote install";

function target(dir: string): { port: number; secret: string } {
  let port = DEFAULT_PORT;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(dir, "host.json"), "utf8")) as { port?: unknown };
    if (config.port !== undefined) {
      if (typeof config.port !== "number" || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error("invalid host port");
      port = config.port;
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const secret = fs.readFileSync(path.join(dir, "local.secret"), "utf8").trim();
  if (secret.length < 32 || !/^[\w-]+$/.test(secret)) throw new Error("invalid local secret");
  return { port, secret };
}

function execute(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile(file, args, { timeout: 150_000, windowsHide: true }, error => error ? reject(error) : resolve()));
}

export async function phoneRequest(route: string, method: string, body: string | undefined, deps: PhoneDeps = {}, session?: string): Promise<PhoneResponse> {
  if (route === "restart" && method === "POST") {
    const uid = deps.uid ?? process.getuid?.();
    const command = uid === undefined ? "npm run remote -- install" : `launchctl kickstart -k gui/${uid}/com.clauderipple.host`;
    if ((deps.platform ?? process.platform) !== "darwin") {
      const script = fileURLToPath(new URL(`../../remote/src/main${path.extname(import.meta.url)}`, import.meta.url));
      try {
        await (deps.exec ?? execute)(process.execPath, [script, "install"]);
        return { status: 200, body: { ok: true } };
      } catch { return { status: 502, body: { error: "host service install/restart failed", command: INSTALL_HINT } }; }
    }
    if (uid === undefined) return { status: 500, body: { error: "host restart unavailable" } };
    try {
      await (deps.exec ?? execute)("launchctl", ["kickstart", "-k", `gui/${uid}/com.clauderipple.host`]);
      return { status: 200, body: { ok: true } };
    } catch { return { status: 502, body: { error: "host restart failed", command } }; }
  }
  const inbox = route === "inbox" || route === "inbox/claim" || route === "inbox/result" || route === "settings-jobs" || route === "settings-jobs/claim" || route === "settings-jobs/result";
  if (!((method === "GET" && (route === "status" || route === "pairing" || (route === "inbox" || route === "settings-jobs") && typeof session === "string" && session.length > 0 && session.length <= 200)) || (method === "POST" && (route === "settings" || route === "rotate" || route === "inbox/claim" || route === "inbox/result" || route === "settings-jobs/claim" || route === "settings-jobs/result")))) {
    return { status: 404, body: { error: "unknown phone endpoint or method" } };
  }
  let response: Response;
  try {
    const { port, secret } = target(deps.home ?? remoteHome());
    const query = route === "inbox" ? `?session=${encodeURIComponent(session!)}` : route === "settings-jobs" ? `?exclude=${encodeURIComponent(session!)}` : "";
    response = await (deps.fetch ?? fetch)(`http://127.0.0.1:${port}/local/${route}${query}`, {
      method, headers: { "x-ripple-local": secret, "content-type": "application/json" },
      ...(body !== undefined ? { body } : {}), redirect: "error", signal: AbortSignal.timeout(5000),
    });
  } catch {
    return route === "status"
      ? { status: 200, body: { hostRunning: false, hint: INSTALL_HINT } }
      : { status: 503, body: { error: "phone host unavailable", hint: INSTALL_HINT } };
  }
  // A live old host or rejected local secret is not a stopped host. Report the boundary failure.
  if (!response.ok && !inbox) return { status: response.status === 400 ? 400 : 502, body: { error: `host control HTTP ${response.status}; update the host if its local API is unavailable` } };
  try {
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid host response");
    return { status: inbox ? response.status : 200, body: route === "status" ? { ...data, hostRunning: true } : data };
  } catch { return { status: 502, body: { error: "invalid host control response" } }; }
}
