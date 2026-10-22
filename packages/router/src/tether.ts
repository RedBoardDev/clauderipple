// Fail over to a phone's hotspot (iPhone or Android) when Wi-Fi has no internet, and come back to a known
// Wi-Fi later. The probe/decision loop below is shared; the OS part is a TetherBackend — macOS here,
// Windows in tether-win.ts (netsh, no elevation).
//
// What decides "no internet" is a real HTTP probe through the Wi-Fi interface, not the OS path
// status: a router with a dead uplink or a captive portal reads "satisfied" to NWPathMonitor, which
// is why Insomnia never failed over in that state (research §1.3, §3.3). Behaviour follows wifihop
// (captive.apple.com "Success" + gstatic 204, 3 of the last 5 rounds) and WiFiGuard (switch back when
// a better network returns); the code is our own.
//
//   failover  on Wi-Fi (or none), 3 of the last 5 probe rounds failed → `sudo -n networksetup
//             -setairportnetwork <dev> <hotspot>`; macOS takes the password from the System keychain.
//   return    on the hotspot, at 5, 10, 20, 30, 40, 50 and 60 min after landing and every 10 min
//             after that, only if another known Wi-Fi is visible, while no model call runs →
//             disassociate (CoreWLAN through JXA, as the
//             console user — the router is a launchd agent in the user's session) so macOS
//             auto-joins the best known network in range; probe it; if that does not give working
//             Wi-Fi within 20s, rejoin the hotspot and wait for the next point. The times are fixed
//             from landing rather than a doubling backoff (owner's decision, 2026-10-20): at most
//             ~10 min on the hotspot after arriving at a known Wi-Fi. On the move, a read-only scan
//             replaces the old blind drop (2026-10-21): no known Wi-Fi in range → no leave, no hold.
//   gap       a return still postponed RETURN_FORCE_AFTER_MS past due (calls back-to-back, so never
//             a quiet moment — 2026-10-20) makes the gap itself: new model calls are held (hold.ts:
//             they wait, they are not refused), the running ones get up to RETURN_DRAIN_WAIT_MS to
//             finish, then the return above runs and the hold is released whatever the outcome.
//
// Never more than one switch per 60s; nothing switches while the user has pinned the network.
// "On the hotspot" is read from the address, not the SSID (macOS redacts it without Location;
// Windows 11 24H2 gates the query that returns it, see tether-win.ts): an iPhone hotspot hands out
// 172.20.10.0/28, and any other phone's network is learned. An Android hotspot hands out a /24 that
// is not fixed — 192.168.43.x up to Android 10 (IpServer WIFI_HOST_IFACE_ADDR), a random /24 of
// 192.168.0.0/16 from Android 11, of 192.168.0.0/16, 172.16.0.0/12 or 10.0.0.0/8 by Android 14
// (PrivateAddressCoordinator) — so after our own join of the hotspot SSID succeeds, the subnet the
// Wi-Fi interface then has (os.networkInterfaces(): address + netmask, no process, no privilege) is
// remembered as the hotspot's network and kept in <home>/tether.json.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { TetherSettings } from "./config.ts";
import { SUDO, sudoRefused, type Activity, type Runner } from "./awake.ts";
import { HoldGate } from "./hold.ts";
import { HOTSPOT_NOT_VISIBLE_STEPS, WinTetherBackend } from "./tether-win.ts";

export const NETWORKSETUP = "/usr/sbin/networksetup";
export const OSASCRIPT = "/usr/bin/osascript";
/** wifihop's exact call (verified in its source, `mac_disassociate_js`): a zero-argument ObjC method is invoked by reading it. */
export const DISASSOCIATE_JS = 'ObjC.import("CoreWLAN"); $.CWWiFiClient.sharedWiFiClient.interface.disassociate; "ok";';
/** Read-only directed scans: a non-empty set proves visibility even if CWNetwork.ssid is redacted. */
export const SCAN_KNOWN_JS = `function run(argv) {
  ObjC.import("CoreWLAN");
  var wifi = $.CWWiFiClient.sharedWiFiClient.interfaceWithName(argv[0]);
  var names = JSON.parse(argv[1]);
  for (var n = 0; n < names.length; n++) {
    var error = Ref();
    var found = wifi.scanForNetworksWithNameError(names[n], error);
    var count = Number(found.count);
    if (!isFinite(count) || count < 0) {
      throw new Error("CoreWLAN scan unavailable: " + (ObjC.unwrap(error[0].localizedDescription) || "no result set"));
    }
    if (count > 0) return "visible";
  }
  return "none";
}`;

export const PROBE_URLS = {
  apple: "http://captive.apple.com/hotspot-detect.html",
  google: "http://connectivitycheck.gstatic.com/generate_204",
} as const;
export const PROBE_TIMEOUT_MS = 4_000;
export const MIN_SWITCH_INTERVAL_MS = 60_000;
/**
 * After a join that failed, the next try comes this much later per failure in a row (10, 20, 30 s…)
 * up to MIN_SWITCH_INTERVAL_MS. A failed join switched nothing, so the once-a-minute rule against
 * flapping does not apply: walking out of the office, the first join failed as the hotspot was only
 * just coming into range, and the Mac sat offline for the rest of the minute (2026-10-22).
 */
export const JOIN_RETRY_MS = 10_000;
/** How long a scan that saw a known Wi-Fi stands for a return still waiting on busy calls. */
export const KNOWN_VISIBLE_TRUST_MS = 60_000;
export const RETURN_PROBE_MS = 20_000;
/**
 * When to try the way back, counted from the moment the Mac landed on the hotspot: 5, 10, 20, 30,
 * 40, 50 and 60 min, then every 10 min for as long as it stays there (owner's decision, 2026-10-20 —
 * a fixed schedule rather than a doubling one: at most ~10 min on the hotspot after arriving at a
 * known Wi-Fi). Each point scans first; without a visible known network it never drops the hotspot.
 */
export const RETURN_SCHEDULE_MINUTES = [5, 10, 20, 30, 40, 50, 60] as const;
/** After the last scheduled point, every this long. */
export const RETURN_INTERVAL_AFTER_MS = 10 * 60_000;
/** A model call this recent counts as "Claude is working": no return attempt (it drops the link for seconds). */
export const RETURN_QUIET_MS = 20_000;
/** Failover waits at most this long for an in-flight call; a dead network cannot serve it anyway. */
export const FAILOVER_IDLE_WAIT_MS = 30_000;
/** A return postponed this long past due stops waiting for a quiet moment and makes one. */
export const RETURN_FORCE_AFTER_MS = 2 * 60_000;
/**
 * With new calls held, the running ones get this long to finish before the attempt is given up.
 * With the switch after it (up to ~35s) it stays inside a held call's HOLD_MAX_MS, so no held call
 * goes ahead and refills the gap before the switch; and well under the ~180s after which Claude
 * Code gave up on a call that had no answer yet (13 Google turns closed at 182–190s, 2026-10-20).
 */
export const RETURN_DRAIN_WAIT_MS = 60_000;
/** The hold releases itself after this even if the return never comes back to release it. */
export const RETURN_HOLD_FAILSAFE_MS = RETURN_DRAIN_WAIT_MS + 3 * 60_000;
const JOIN_SETTLE_MS = 15_000;
/** States that say why the last join failed; they stay (with their hint) until the next attempt. */
const JOIN_FAILURES: ReadonlySet<string> = new Set(["hotspot-not-visible", "join-failed", "needs-setup", "no-hotspot-profile", "needs-location"]);
/** Failures a moment later can cure (the phone coming into range); setup problems wait the full minute. */
const RETRIABLE_JOIN: ReadonlySet<string> = new Set(["hotspot-not-visible", "join-failed"]);

// ---- Pure helpers -------------------------------------------------------------------------------

/** The Wi-Fi device from `networksetup -listallhardwareports` ("Hardware Port: Wi-Fi\nDevice: en0"). */
export function parseWifiDevice(text: string): string | null {
  const blocks = text.split(/\n\s*\n/);
  for (const b of blocks) {
    if (!/Hardware Port:\s*(Wi-Fi|AirPort)\s*$/m.test(b)) continue;
    const dev = /Device:\s*(\S+)/.exec(b)?.[1];
    if (dev && /^en\d+$/.test(dev)) return dev;
  }
  return null;
}

/** `networksetup -listpreferredwirelessnetworks`: preserve SSID spaces, discard only the indent. */
export function parsePreferredNetworks(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).filter((line) => line.startsWith("\t")).map((line) => line.slice(1)).filter(Boolean))];
}

/** The interface's IPv4 address, or null when it has none (not associated, or no DHCP yet). */
export function wifiIPv4(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>, device: string): string | null {
  return ifaces[device]?.find((a) => a.family === "IPv4" && !a.internal)?.address ?? null;
}

/** An iPhone Personal Hotspot hands out 172.20.10.0/28 (172.20.10.0–15). */
export function isHotspotAddress(ip: string | null): boolean {
  const m = ip ? /^172\.20\.10\.(\d{1,3})$/.exec(ip) : null;
  return !!m && Number(m[1]) <= 15;
}

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function intToIpv4(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

/** "192.168.43.17" + "255.255.255.0" → "192.168.43.0/24"; null for anything else (no or a non-contiguous mask). */
export function ipv4Network(address: string, netmask: string): string | null {
  const a = ipv4ToInt(address);
  const m = ipv4ToInt(netmask);
  if (a === null || m === null) return null;
  const bits = m.toString(2).replace(/0+$/, "");
  if (m !== 0 && bits.includes("0")) return null;
  const len = m === 0 ? 0 : bits.length;
  if (len < 8 || len > 30) return null; // a /31 or /32 is no DHCP network; shorter than /8 is no hotspot
  return `${intToIpv4((a & m) >>> 0)}/${len}`;
}

/** Whether `ip` is inside `network` ("a.b.c.d/len"). */
export function inNetwork(ip: string | null, network: string | null): boolean {
  if (!ip || !network) return false;
  const [base, lenText] = network.split("/");
  const a = ipv4ToInt(ip);
  const b = base ? ipv4ToInt(base) : null;
  const len = Number(lenText);
  if (a === null || b === null || !Number.isInteger(len) || len < 0 || len > 32) return false;
  const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

/** 169.254.0.0/16: what an interface gives itself when DHCP did not answer — not a join. */
export function isLinkLocal(ip: string | null): boolean {
  return inNetwork(ip, "169.254.0.0/16");
}

export type Network = "wifi" | "hotspot" | "none";
/** The iPhone range, or the network remembered from our own join of the hotspot (`learned`). */
export function classifyNetwork(ip: string | null, learned: string | null = null): Network {
  return ip === null ? "none" : isHotspotAddress(ip) || inNetwork(ip, learned) ? "hotspot" : "wifi";
}

/** The interface's IPv4 network ("a.b.c.d/len"), from the same os.networkInterfaces() entry as wifiIPv4. */
export function wifiIPv4Network(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>, device: string): string | null {
  const a = ifaces[device]?.find((x) => x.family === "IPv4" && !x.internal);
  return a ? ipv4Network(a.address, a.netmask) : null;
}

/** What `<home>/tether.json` keeps: the network a join of `ssid` landed on, outside the iPhone range. */
export type LearnedHotspot = { ssid: string; network: string; learnedAt: string };

export function readLearnedHotspot(file: string): LearnedHotspot | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as { hotspot?: Partial<LearnedHotspot> };
    const h = j.hotspot;
    if (!h || typeof h.ssid !== "string" || typeof h.network !== "string") return null;
    const [base, len] = h.network.split("/");
    const bits = Number(len);
    // Only a canonical "network/len" this module could have written; anything else is forgotten.
    if (!base || !Number.isInteger(bits) || bits < 8 || bits > 30) return null;
    if (ipv4Network(base, intToIpv4((0xffffffff << (32 - bits)) >>> 0)) !== h.network) return null;
    return { ssid: h.ssid, network: h.network, learnedAt: String(h.learnedAt ?? "") };
  } catch {
    return null;
  }
}

export function writeLearnedHotspot(file: string, h: LearnedHotspot): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ hotspot: h }) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * The next scheduled return time at or after `now + minGapMs`, on the fixed schedule counted from
 * `landedAt` (5, 10, 20, 30, 40, 50, 60 min, then every 10). A point already passed is skipped, so a
 * long gap attempt or a slow tick never retries in the past or bursts two switches together.
 */
export function nextReturnPoint(landedAt: number, now: number, minGapMs = MIN_SWITCH_INTERVAL_MS): number {
  const floor = now + minGapMs;
  for (const minutes of RETURN_SCHEDULE_MINUTES) {
    const at = landedAt + minutes * 60_000;
    if (at >= floor) return at;
  }
  const last = landedAt + RETURN_SCHEDULE_MINUTES[RETURN_SCHEDULE_MINUTES.length - 1]! * 60_000;
  const steps = Math.max(1, Math.ceil((floor - last) / RETURN_INTERVAL_AFTER_MS));
  return last + steps * RETURN_INTERVAL_AFTER_MS;
}

/** The last five probe rounds; an outage is 3 failures among them, so a 1s blip never switches. */
export class ProbeWindow {
  private rounds: boolean[] = [];
  push(ok: boolean): void {
    this.rounds.push(ok);
    if (this.rounds.length > 5) this.rounds.shift();
  }
  failures(): number {
    return this.rounds.filter((ok) => !ok).length;
  }
  outage(): boolean {
    return this.failures() >= 3;
  }
  reset(): void {
    this.rounds = [];
  }
}

export type ProbeGet = (url: string, localAddress: string, timeoutMs: number) => Promise<{ status: number; body: string }>;

/** One HTTP GET bound to a local address (so the request leaves through that interface). */
export const httpGet: ProbeGet = (url, localAddress, timeoutMs) =>
  new Promise((resolve, reject) => {
    const req = http.get(url, { localAddress, timeout: timeoutMs, headers: { "cache-control": "no-cache" } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        if (body.length < 4096) body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("probe timed out")));
    req.on("error", reject);
  });

/** One round: both endpoints at once; the round fails only if both fail. */
export async function probeRound(localAddress: string, get: ProbeGet = httpGet): Promise<boolean> {
  const apple = get(PROBE_URLS.apple, localAddress, PROBE_TIMEOUT_MS).then((r) => r.status === 200 && r.body.includes("Success"), () => false);
  const google = get(PROBE_URLS.google, localAddress, PROBE_TIMEOUT_MS).then((r) => r.status === 204, () => false);
  const [a, g] = await Promise.all([apple, google]);
  return a || g;
}

export type JoinOutcome = "joined" | "needs-setup" | "hotspot-not-visible" | "join-failed" | "no-hotspot-profile" | "needs-location";
export type JoinFailure = Exclude<JoinOutcome, "joined">;

/**
 * `networksetup -setairportnetwork` reports failure on stdout and may still exit 0
 * ("Could not find network X." / "Failed to join network X."), so the text decides.
 */
export function classifyJoin(r: { code: number; stdout: string; stderr: string }): JoinFailure | null {
  if (sudoRefused(r)) return "needs-setup";
  const text = `${r.stdout}\n${r.stderr}`;
  if (/could not find network/i.test(text)) return "hotspot-not-visible";
  if (r.code !== 0 || /failed|error/i.test(text)) return "join-failed";
  return null;
}

// ---- Controller ---------------------------------------------------------------------------------

export type TetherState =
  | "off" | "unsupported" | "no-wifi-device" | "watching" | "no-wifi" | "outage" | "pinned"
  | "joining-hotspot" | "on-hotspot" | "returning" | "hotspot-not-visible" | "join-failed"
  | "needs-setup" | "no-hotspot-ssid" | "no-hotspot-profile" | "needs-location";

/** What one OS does for the controller. */
export interface TetherBackend {
  /** The Wi-Fi interface, as os.networkInterfaces() names it; null when there is none. */
  findWifi(): Promise<string | null>;
  /** Asks the OS to join the hotspot. null: the request went through, and the address decides. */
  join(ssid: string): Promise<JoinFailure | null>;
  /** What a join that went through but brought no hotspot address within 15s means here. */
  readonly noAddressOutcome: JoinFailure;
  /** Leaves the current network so the OS joins its best known one. An error text, or null. */
  leave(): Promise<string | null>;
  /** Once, when leave() gave no address after a few seconds: join a known network by name. */
  joinKnown?(ssid: string): Promise<void>;
  /** Read-only check before holding calls or leaving: null ONLY if another known Wi-Fi is visible. */
  returnBlocked(ssid: string): Promise<string | null>;
  readonly hints: Partial<Record<TetherState, string>>;
}

/** Waiting this long after leave() with no address at all, a backend may join a known network itself. */
export const JOIN_KNOWN_AFTER_MS = 8_000;

export type TetherStatus = {
  enabled: boolean;
  network: Network;
  state: TetherState;
  pinned: boolean;
  hotspotSsid: string;
  lastSwitch: { at: string; to: "hotspot" | "wifi"; ok: boolean; reason: string } | null;
  lastProbe: { at: string; ok: boolean; network: Network } | null;
  hint: string | null;
};

export type TetherDeps = {
  platform: NodeJS.Platform;
  run: Runner;
  settings: () => TetherSettings;
  activity: () => Activity;
  log: { info(m: string): void; warn(m: string): void };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  interfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  /** One probe round through this local address. */
  probe?: (localAddress: string) => Promise<boolean>;
  /** Schedules the next tick after `ms`; returns a cancel. Tests pass a no-op. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** The gate the proxy and the ingress hold new model calls at; one of its own when not given. */
  hold?: HoldGate;
  /** Where the learned hotspot network is kept (`<home>/tether.json`); in memory only when not given. */
  stateFile?: string;
};

const MAC_HINTS: Partial<Record<TetherState, string>> = {
  "hotspot-not-visible": `The phone is not broadcasting its hotspot, so the Mac cannot see it. ${HOTSPOT_NOT_VISIBLE_STEPS}`,
  "needs-setup": "Run `clauderipple awake setup --ssid <hotspot name>` once: joining the hotspot needs the rule it installs (and the name must match it).",
  "no-hotspot-ssid": "Set the phone hotspot's name: `clauderipple awake setup --ssid <hotspot name>`.",
  "no-wifi": "Wi-Fi is not connected. macOS joins an iPhone hotspot by itself when no Wi-Fi is available if System Settings → Wi-Fi → \"Ask to join hotspots\" is Automatic (ClaudeRipple cannot read that setting: the file is root-only); an Android hotspot is joined like any known Wi-Fi with Auto-Join on.",
  "join-failed": "Joining the hotspot failed. Check the hotspot name, and that the Mac has joined it once before (macOS keeps its password).",
  pinned: "Switching is paused because the network was pinned.",
};

class MacTetherBackend implements TetherBackend {
  readonly noAddressOutcome = "join-failed" as const;
  readonly hints = MAC_HINTS;
  private readonly run: Runner;
  private readonly log: { info(m: string): void; warn(m: string): void };
  private device: string | null = null;

  constructor(run: Runner, log: { info(m: string): void; warn(m: string): void }) {
    this.run = run;
    this.log = log;
  }

  async findWifi(): Promise<string | null> {
    const r = await this.run(NETWORKSETUP, ["-listallhardwareports"]);
    this.device = r.code === 0 ? parseWifiDevice(r.stdout) : null;
    return this.device;
  }

  /** `sudo -n networksetup -setairportnetwork <dev> <ssid>`. */
  async join(ssid: string): Promise<JoinFailure | null> {
    const r = await this.run(SUDO, ["-n", NETWORKSETUP, "-setairportnetwork", this.device!, ssid], { timeoutMs: 30_000 });
    const failed = classifyJoin(r);
    if (failed && failed !== "needs-setup") this.log.warn(`tether: networksetup said: ${(r.stdout + r.stderr).trim().slice(0, 200)}`);
    return failed;
  }

  async returnBlocked(ssid: string): Promise<string | null> {
    const preferred = await this.run(NETWORKSETUP, ["-listpreferredwirelessnetworks", this.device!]);
    if (preferred.code !== 0) throw new Error(`preferred Wi-Fi list failed: ${(preferred.stderr || preferred.stdout).trim().slice(0, 200) || `exit ${preferred.code}`}`);
    const names = parsePreferredNetworks(preferred.stdout).filter((name) => name !== ssid);
    if (!names.length) return "no known Wi-Fi in range";
    const r = await this.run(OSASCRIPT, ["-l", "JavaScript", "-e", SCAN_KNOWN_JS, this.device!, JSON.stringify(names)], { timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(`CoreWLAN scan failed: ${(r.stderr || r.stdout).trim().slice(0, 200) || `exit ${r.code}`}`);
    if (r.stdout.trim() === "visible") return null;
    if (r.stdout.trim() === "none") return "no known Wi-Fi in range";
    throw new Error("CoreWLAN scan returned an unsupported result");
  }

  async leave(): Promise<string | null> {
    const r = await this.run(OSASCRIPT, ["-l", "JavaScript", "-e", DISASSOCIATE_JS], { timeoutMs: 15_000 });
    return r.code === 0 ? null : (r.stderr || r.stdout).trim().slice(0, 200);
  }
}

export class TetherController {
  private readonly deps: TetherDeps;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly interfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  private readonly probe: (localAddress: string) => Promise<boolean>;
  private readonly backend: TetherBackend | null;
  private readonly window = new ProbeWindow();
  private device: string | null = null;
  private network: Network = "none";
  private state: TetherState = "off";
  private pinned = false;
  private lastSwitchAt = 0;
  /** Hotspot joins that failed in a row; the retry gap grows with it (JOIN_RETRY_MS). */
  private joinFailures = 0;
  /** When a scan last saw a known Wi-Fi other than the hotspot. */
  private knownVisibleAt = -Infinity;
  private lastSwitch: TetherStatus["lastSwitch"] = null;
  private lastProbe: TetherStatus["lastProbe"] = null;
  /** When the Mac landed on the hotspot (ours or by hand); null off the hotspot. The schedule counts from here. */
  private landedOnHotspotAt: number | null = null;
  private nextReturnAt = 0;
  private busy: Promise<void> | null = null;
  private cancel: (() => void) | null = null;
  private lastLogged = "";
  private readonly hold: HoldGate;
  /** True while this controller has the gate engaged (stop() releases it). */
  private holding = false;
  private stopped = false;
  /** The hotspot's network learned from our own join (outside the iPhone range); see learn(). */
  private learned: LearnedHotspot | null;
  /** The subnet last watched as ordinary Wi-Fi: a join landing on it cannot be told apart from it. */
  private lastWifiNetwork: string | null = null;

  constructor(deps: TetherDeps) {
    this.deps = deps;
    this.learned = deps.stateFile ? readLearnedHotspot(deps.stateFile) : null;
    this.hold = deps.hold ?? new HoldGate();
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.interfaces = deps.interfaces ?? os.networkInterfaces;
    this.probe = deps.probe ?? ((addr) => probeRound(addr));
    this.backend =
      deps.platform === "darwin" ? new MacTetherBackend(deps.run, deps.log) : deps.platform === "win32" ? new WinTetherBackend(deps.run, deps.log) : null;
    if (!this.backend) this.state = "unsupported";
  }

  get supported(): boolean {
    return this.backend !== null;
  }

  start(): void {
    if (!this.supported) return;
    this.stopped = false;
    this.loop();
  }

  /** Stops the loop; a hold this controller engaged is released now (a return in progress gives up). */
  stop(): void {
    this.stopped = true;
    this.cancel?.();
    this.cancel = null;
    if (this.holding) this.releaseHold("the controller stopped");
  }

  /** Run a tick soon (after the settings changed) without waiting for it. */
  kick(): void {
    if (this.supported) void this.tick();
  }

  setPin(on: boolean): void {
    if (this.pinned === on) return;
    this.pinned = on;
    this.deps.log.info(`tether: network ${on ? "pinned; switching paused" : "unpinned; switching resumes"}`);
    if (on) this.state = "pinned";
    this.window.reset();
  }

  status(): TetherStatus {
    const s = this.deps.settings();
    return {
      enabled: s.enabled,
      network: this.network,
      state: this.state,
      pinned: this.pinned,
      hotspotSsid: s.hotspotSsid,
      lastSwitch: this.lastSwitch,
      lastProbe: this.lastProbe,
      hint: this.backend?.hints[this.state] ?? null,
    };
  }

  private loop(): void {
    const schedule = this.deps.schedule ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref();
      return () => clearTimeout(t);
    });
    const every = Math.max(5, this.deps.settings().probeEverySec) * 1000;
    this.cancel = schedule(() => {
      void this.tick().finally(() => {
        if (this.cancel) this.loop();
      });
    }, every);
  }

  tick(): Promise<void> {
    if (!this.supported) return Promise.resolve();
    if (!this.busy) this.busy = this.evaluate().catch((e: Error) => this.deps.log.warn(`tether: ${e.message}`)).finally(() => (this.busy = null));
    return this.busy;
  }

  private decide(line: string): void {
    if (line === this.lastLogged) return;
    this.lastLogged = line;
    this.deps.log.info(`tether: ${line}`);
  }

  private currentIp(): string | null {
    return this.device ? wifiIPv4(this.interfaces(), this.device) : null;
  }

  private currentNetwork(): string | null {
    return this.device ? wifiIPv4Network(this.interfaces(), this.device) : null;
  }

  /** The learned network, while it belongs to the hotspot name configured now. */
  private learnedNetwork(): string | null {
    return this.learned && this.learned.ssid === this.deps.settings().hotspotSsid ? this.learned.network : null;
  }

  private onHotspot(ip: string | null): boolean {
    return classifyNetwork(ip, this.learnedNetwork()) === "hotspot";
  }

  private idle(): boolean {
    const a = this.deps.activity();
    return a.inFlight === 0 && (a.lastStartedAt === undefined || this.now() - a.lastStartedAt >= RETURN_QUIET_MS);
  }

  private async evaluate(): Promise<void> {
    const settings = this.deps.settings();
    if (!settings.enabled) {
      if (this.state !== "off") this.decide("disabled");
      this.state = "off";
      this.landedOnHotspotAt = null;
      this.window.reset();
      return;
    }
    if (!this.device) {
      this.device = await this.backend!.findWifi();
      if (!this.device) {
        this.state = "no-wifi-device";
        this.decide("no Wi-Fi interface found");
        return;
      }
    }
    const ip = this.currentIp();
    this.network = classifyNetwork(ip, this.learnedNetwork());
    if (this.network === "wifi") this.lastWifiNetwork = this.currentNetwork();
    const ok = ip ? await this.probe(ip) : false;
    this.window.push(ok);
    this.lastProbe = { at: new Date(this.now()).toISOString(), ok, network: this.network };
    if (this.pinned) {
      this.state = "pinned";
      return;
    }
    if (this.network === "hotspot") {
      // Landed here by our own failover or by hand: either way, plan the way back from here.
      this.joinFailures = 0;
      if (this.landedOnHotspotAt === null) {
        this.landedOnHotspotAt = this.now();
        this.nextReturnAt = nextReturnPoint(this.landedOnHotspotAt, this.now());
      }
      if (this.state !== "on-hotspot") this.decide(`on the hotspot; next try for Wi-Fi in ${Math.round((this.nextReturnAt - this.now()) / 1000)}s`);
      this.state = "on-hotspot";
      if (this.now() >= this.nextReturnAt) await this.tryReturn(settings);
      return;
    }
    // On Wi-Fi (or none): the way back is no longer pending, and landing again starts the schedule over.
    this.landedOnHotspotAt = null;
    if (!this.window.outage()) {
      if (this.network === "wifi") this.joinFailures = 0;
      this.state = this.network === "wifi" ? "watching" : "no-wifi";
      if (this.network === "wifi") this.decide(`watching Wi-Fi (${5 - this.window.failures()}/5 recent probes ok)`);
      else this.decide("Wi-Fi has no address");
      return;
    }
    await this.failover(settings);
  }

  private async failover(settings: TetherSettings): Promise<void> {
    const why = this.network === "wifi" ? "Wi-Fi has no internet (3 of the last 5 probes failed)" : "Wi-Fi is not connected";
    if (!settings.hotspotSsid) {
      this.state = "no-hotspot-ssid";
      this.decide(`${why}, but no hotspot name is set`);
      return;
    }
    const since = this.now() - this.lastSwitchAt;
    const retrying = this.joinFailures > 0 && RETRIABLE_JOIN.has(this.state);
    const gap = retrying ? Math.min(MIN_SWITCH_INTERVAL_MS, JOIN_RETRY_MS * this.joinFailures) : MIN_SWITCH_INTERVAL_MS;
    if (since < gap) {
      // A failed join keeps saying why (and its hint) until the next attempt.
      if (!JOIN_FAILURES.has(this.state)) this.state = "outage";
      this.decide(`${why}; waiting ${Math.ceil((gap - since) / 1000)}s (${retrying ? "trying the hotspot again" : "at most one switch per minute"})`);
      return;
    }
    // A call in flight on a dead network cannot finish anyway; give it a short chance, no more.
    const waitUntil = this.now() + FAILOVER_IDLE_WAIT_MS;
    while (this.deps.activity().inFlight > 0 && this.now() < waitUntil) await this.sleep(1_000);
    this.state = "joining-hotspot";
    this.lastSwitchAt = this.now();
    this.decide(`${why}: joining hotspot "${settings.hotspotSsid}"`);
    const outcome = await this.join(settings.hotspotSsid);
    this.recordSwitch("hotspot", outcome === "joined", outcome === "joined" ? why : outcome);
    this.joinFailures = outcome === "joined" ? 0 : this.joinFailures + 1;
    if (outcome === "joined" && !this.onHotspot(this.currentIp())) {
      // Joined, but on a network that could not be remembered (see learn()): it reads as Wi-Fi.
      this.window.reset();
      this.network = "wifi";
      this.state = "watching";
      this.decide("joined the hotspot, but its network cannot be told apart from Wi-Fi; watching it as Wi-Fi (no way back is planned)");
    } else if (outcome === "joined") {
      this.window.reset();
      this.network = "hotspot";
      this.state = "on-hotspot";
      this.landedOnHotspotAt = this.now();
      this.nextReturnAt = nextReturnPoint(this.landedOnHotspotAt, this.now());
      this.decide(`joined the hotspot; next try for Wi-Fi in ${Math.round((this.nextReturnAt - this.now()) / 1000)}s`);
    } else {
      this.state = outcome;
      this.decide(`could not join the hotspot: ${outcome}`);
    }
  }

  /**
   * Asks the OS to join, then waits for the hotspot's address: one in the iPhone range or the learned
   * network, or else — after a join the OS accepted — any new address that is not link-local, whose
   * network is then learned. Neither OS lets us read the SSID without Location (macOS redacts it;
   * Windows 24H2 gates `netsh wlan show interfaces`), so "the OS accepted a join of this SSID, and
   * the address changed" is the strongest evidence there is.
   */
  private async join(ssid: string): Promise<JoinOutcome> {
    const before = this.currentIp();
    const wifiBefore = [before && !this.onHotspot(before) ? this.currentNetwork() : null, this.lastWifiNetwork];
    const failed = await this.backend!.join(ssid);
    if (failed) return failed;
    const deadline = this.now() + JOIN_SETTLE_MS;
    for (;;) {
      const ip = this.currentIp();
      if (this.onHotspot(ip)) return "joined";
      if (ip && ip !== before && !isLinkLocal(ip)) {
        this.learn(ssid, ip, wifiBefore);
        return "joined";
      }
      if (this.now() >= deadline) return this.backend!.noAddressOutcome;
      await this.sleep(1_000);
    }
  }

  /**
   * Remembers the network our join of `ssid` landed on. Only a join we made replaces it, and never
   * with a network just watched as ordinary Wi-Fi: that one would read as the hotspot from then on.
   */
  private learn(ssid: string, ip: string, wifiBefore: (string | null)[]): void {
    const network = this.currentNetwork();
    if (!network) {
      this.step(`joined "${ssid}" at ${ip}, but its netmask could not be read; its network is not remembered`);
      return;
    }
    if (wifiBefore.includes(network)) {
      this.step(`joined "${ssid}", but its network ${network} is the one watched as Wi-Fi before; not remembering it (the two could not be told apart)`);
      return;
    }
    if (this.learned?.ssid === ssid && this.learned.network === network) return;
    const was = this.learned?.ssid === ssid ? ` (was ${this.learned.network})` : "";
    this.learned = { ssid, network, learnedAt: new Date(this.now()).toISOString() };
    this.step(`remembering ${network} as hotspot "${ssid}"'s network${was}`);
    if (!this.deps.stateFile) return;
    try {
      writeLearnedHotspot(this.deps.stateFile, this.learned);
    } catch (e) {
      this.deps.log.warn(`tether: could not save the hotspot's network: ${(e as Error).message}`);
    }
  }

  private async tryReturn(settings: TetherSettings): Promise<void> {
    if (this.now() - this.lastSwitchAt < MIN_SWITCH_INTERVAL_MS) return;
    // A return postponed for busy calls comes back every tick; one scan that saw a known Wi-Fi is
    // trusted for a minute rather than repeated each time (a scan takes seconds on the radio).
    if (this.now() - this.knownVisibleAt >= KNOWN_VISIBLE_TRUST_MS) {
      let blocked: string | null;
      try {
        blocked = await this.backend!.returnBlocked(settings.hotspotSsid);
      } catch (e) {
        blocked = `known Wi-Fi scan failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (blocked) {
        this.backOff(blocked);
        return;
      }
      this.knownVisibleAt = this.now();
    }
    // A scan is asynchronous: a pin/stop/settings change or an OS join meanwhile cancels the return.
    const current = this.deps.settings();
    if (this.stopped || this.pinned || !current.enabled || current.hotspotSsid !== settings.hotspotSsid || !this.onHotspot(this.currentIp())) return;
    const idle = this.idle();
    if (!idle && (this.now() - this.nextReturnAt < RETURN_FORCE_AFTER_MS || this.hold.closed)) {
      this.decide(`Wi-Fi return postponed: a model call is running or just started (after ${RETURN_FORCE_AFTER_MS / 1000}s of this, new calls are held to make a gap)`);
      return;
    }
    if (idle) await this.leaveHotspot(settings);
    else await this.returnWithGap(settings);
  }

  /**
   * Calls never stop (Claude and subagents back-to-back), so make the quiet moment: hold new model
   * calls, let the running ones finish, go back to Wi-Fi, release. The hold is released on every
   * path out of here, a thrown error included.
   */
  private async returnWithGap(settings: TetherSettings): Promise<void> {
    const late = Math.round((this.now() - this.nextReturnAt) / 1000);
    if (!this.hold.engage("going back to Wi-Fi", RETURN_HOLD_FAILSAFE_MS)) return;
    this.holding = true;
    try {
      const running = this.deps.activity().inFlight;
      this.step(`Wi-Fi return postponed ${late}s past due while model calls keep running: holding new model calls to make a gap (waiting up to ${RETURN_DRAIN_WAIT_MS / 1000}s for ${running} running)`);
      const started = this.now();
      const until = started + RETURN_DRAIN_WAIT_MS;
      while (!this.stopped && !this.pinned && this.deps.activity().inFlight > 0 && this.now() < until) await this.sleep(1_000);
      // stop() already released; a pin made meanwhile pauses switching, so the attempt is dropped.
      if (this.stopped || this.pinned) return;
      const left = this.deps.activity().inFlight;
      if (left > 0) {
        this.backOff(`${left} model call${left === 1 ? "" : "s"} still running after ${Math.round((this.now() - started) / 1000)}s; held calls released`);
        return;
      }
      this.step(`running model calls finished after ${Math.round((this.now() - started) / 1000)}s; ${this.hold.waiting} held`);
      await this.leaveHotspot(settings);
    } finally {
      this.releaseHold();
    }
  }

  private releaseHold(why?: string): void {
    if (!this.holding) return;
    this.holding = false;
    const n = this.hold.release();
    this.step(`hold released${why ? ` (${why})` : ""}; ${n} held model call${n === 1 ? "" : "s"} going ahead`);
  }

  /** A one-off step: always logged, and the next state line is logged again after it. */
  private step(line: string): void {
    this.lastLogged = "";
    this.deps.log.info(`tether: ${line}`);
  }

  /** Leave the hotspot so the OS joins its best known network; keep it only if it has internet. */
  private async leaveHotspot(settings: TetherSettings): Promise<void> {
    const backend = this.backend!;
    this.state = "returning";
    this.lastSwitchAt = this.now();
    this.decide(`trying to go back to Wi-Fi: leaving the hotspot so ${this.deps.platform === "win32" ? "Windows" : "macOS"} joins the best known network`);
    const left = await backend.leave();
    if (left !== null) {
      this.deps.log.warn(`tether: leaving the hotspot failed: ${left}`);
      this.state = "on-hotspot";
      this.backOff("leaving the hotspot failed");
      return;
    }
    // Back on Wi-Fi only after two good probes through it (one could be a lucky blip).
    let good = 0;
    let askedKnown = false;
    const started = this.now();
    const deadline = started + RETURN_PROBE_MS;
    while (this.now() < deadline) {
      await this.sleep(2_000);
      const ip = this.currentIp();
      if (!ip && !askedKnown && backend.joinKnown && this.now() - started >= JOIN_KNOWN_AFTER_MS) {
        askedKnown = true;
        await backend.joinKnown(settings.hotspotSsid);
      }
      if (ip && !this.onHotspot(ip) && (await this.probe(ip))) {
        if (++good >= 2) break;
      } else good = 0;
    }
    this.window.reset();
    if (good >= 2) {
      this.network = "wifi";
      this.state = "watching";
      this.landedOnHotspotAt = null;
      this.recordSwitch("wifi", true, "a known Wi-Fi with internet was in range");
      this.decide("back on Wi-Fi with internet");
      return;
    }
    const ip = this.currentIp();
    let reason: string;
    const osName = this.deps.platform === "win32" ? "Windows" : "macOS";
    let rejoined = false;
    if (this.onHotspot(ip)) reason = `${osName} rejoined the hotspot (no better network in range)`;
    else {
      reason = ip ? `the Wi-Fi ${osName} chose has no internet` : "no network was joined";
      const outcome = await this.join(settings.hotspotSsid);
      rejoined = outcome === "joined";
      if (!rejoined) reason += `; rejoining the hotspot failed: ${outcome}`;
    }
    this.network = classifyNetwork(this.currentIp(), this.learnedNetwork());
    this.recordSwitch("wifi", false, reason);
    if (this.network !== "hotspot" && rejoined) {
      // Rejoined, but on a network that could not be remembered (see learn()): it reads as Wi-Fi.
      this.state = "watching";
      this.landedOnHotspotAt = null;
      this.step(`${reason}; rejoined the hotspot, but its network cannot be told apart from Wi-Fi; watching it as Wi-Fi`);
      return;
    }
    this.state = this.network === "hotspot" ? "on-hotspot" : "join-failed";
    this.backOff(reason);
  }

  /**
   * Stay on the hotspot until the next scheduled point (never doubling; see RETURN_SCHEDULE_MINUTES).
   * A point already passed — a slow tick, a long gap attempt — is skipped for the next one at least
   * MIN_SWITCH_INTERVAL_MS out, so a failed try never lands on top of the one just made.
   */
  private backOff(reason: string): void {
    const landed = this.landedOnHotspotAt ?? this.now();
    this.nextReturnAt = nextReturnPoint(landed, this.now());
    this.lastLogged = "";
    this.decide(`staying on the hotspot: ${reason}; next try in ${Math.round((this.nextReturnAt - this.now()) / 1000)}s`);
  }

  private recordSwitch(to: "hotspot" | "wifi", ok: boolean, reason: string): void {
    this.lastSwitch = { at: new Date(this.now()).toISOString(), to, ok, reason };
  }
}
