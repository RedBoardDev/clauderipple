import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AwakeController, decideAwake, parseBattery, parseClamshell, parseThermal, readJournal, SLEEPNOW_SETTLE_MS, WORKING_GRACE_MS,
  type Activity, type AwakeInput, type RunResult,
} from "../src/awake.ts";
import { AWAKE_DEFAULTS, type AwakeSettings } from "../src/config.ts";

// Outputs measured on this project's Mac (macOS 27.0.1, 2026-10-20).
const BATT_AC = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=7995491)\t55%; AC attached; not charging present: true\n";
const BATT_LOW = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=7995491)\t15%; discharging; 1:02 remaining present: true\n";
const THERM_NONE = "Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\nNote: No CPU power status has been recorded\n";
// `caps`: "System Capabilities" — 15 measured in a full wake (2026-10-24); a dark wake lacks Graphics (2).
const FULL_WAKE = 15;
const DARK_WAKE = 9;
const ioreg = (lid: boolean, causesSleep: boolean, disabled: boolean, caps?: number): string =>
  `${caps === undefined ? "" : `  |   "System Capabilities" = ${caps}\n`}  |   "AppleClamshellCausesSleep" = ${causesSleep ? "Yes" : "No"}\n  |   "AppleClamshellState" = ${lid ? "Yes" : "No"}\n  |   "SleepDisabled" = ${disabled ? "Yes" : "No"}\n`;

test("battery: AC, battery, and a Mac without one", () => {
  assert.deepEqual(parseBattery(BATT_AC), { percent: 55, onBattery: false });
  assert.deepEqual(parseBattery(BATT_LOW), { percent: 15, onBattery: true });
  assert.deepEqual(parseBattery("Now drawing from 'AC Power'\n"), { percent: null, onBattery: false });
});

test("thermal: measured 'nothing recorded' is normal, a recorded level is a warning, anything else unknown", () => {
  assert.equal(parseThermal(THERM_NONE), "normal");
  assert.equal(parseThermal("Thermal warning level set to 70.\n"), "warning");
  assert.equal(parseThermal("Thermal warning level set to 0.\n"), "normal");
  assert.equal(parseThermal("something macOS 28 prints\n"), "unknown");
});

test("clamshell flags from ioreg", () => {
  assert.deepEqual(parseClamshell(ioreg(true, false, false)), { lidClosed: true, causesSleep: false, sleepDisabled: false, darkWake: null });
  assert.deepEqual(parseClamshell(""), { lidClosed: null, causesSleep: null, sleepDisabled: null, darkWake: null });
  assert.equal(parseClamshell(ioreg(false, true, true, FULL_WAKE)).darkWake, false);
  assert.equal(parseClamshell(ioreg(true, true, false, DARK_WAKE)).darkWake, true);
});

const NOW = Date.parse("2026-10-20T12:00:00Z");
const base = (over: Partial<AwakeInput> & { s?: Partial<AwakeSettings> } = {}): AwakeInput => ({
  settings: { ...AWAKE_DEFAULTS, mode: "working", ...(over.s ?? {}) },
  now: NOW,
  inFlight: 0,
  battery: { percent: 55, onBattery: false },
  thermal: "normal",
  ...over,
});

test("decision table: modes, the working window, until, and the guards", () => {
  const rows: [string, AwakeInput, boolean, RegExp][] = [
    ["off is never awake", base({ s: { mode: "off" }, inFlight: 3 }), false, /^off$/],
    ["on", base({ s: { mode: "on" } }), true, /^on$/],
    ["on until later", base({ s: { mode: "on", until: "2026-10-20T13:00:00Z" } }), true, /^on$/],
    ["on until passed", base({ s: { mode: "on", until: "2026-10-20T11:59:00Z" } }), false, /until .* has passed/],
    ["working with a call running", base({ inFlight: 2 }), true, /2 model calls running/],
    ["working, last call 5 min ago", base({ lastActivityAt: NOW - 5 * 60_000 }), true, /last model call 300s ago/],
    ["working, last call just over 10 min ago", base({ lastActivityAt: NOW - WORKING_GRACE_MS - 1 }), false, /idle/],
    ["working, never active", base(), false, /idle/],
    ["a call in a dark wake takes no hold", base({ inFlight: 1, darkWake: true }), false, /^asleep: /],
    ["a hold already taken is kept in a dark wake", base({ inFlight: 1, darkWake: true, held: true }), true, /1 model call running/],
    ["on is kept in a dark wake", base({ s: { mode: "on" }, darkWake: true }), true, /^on$/],
    ["battery under the floor on battery", base({ s: { mode: "on" }, battery: { percent: 15, onBattery: true } }), false, /battery 15% is below 20%/],
    ["battery under the floor on AC is fine", base({ s: { mode: "on" }, battery: { percent: 15, onBattery: false } }), true, /^on$/],
    ["floor is configurable", base({ s: { mode: "on", batteryFloorPercent: 10 }, battery: { percent: 15, onBattery: true } }), true, /^on$/],
    ["thermal warning", base({ s: { mode: "on" }, thermal: "warning" }), false, /thermal warning/],
    ["unknown thermal output does not switch it off", base({ s: { mode: "on" }, thermal: "unknown" }), true, /^on$/],
    ["a failed guard read", base({ s: { mode: "on" }, error: "pmset -g batt failed (1)" }), false, /^error: /],
  ];
  for (const [name, input, wanted, reason] of rows) {
    const d = decideAwake(input);
    assert.equal(d.wanted, wanted, name);
    assert.match(d.reason, reason, name);
  }
});

// ---- Controller with a fake Mac -----------------------------------------------------------------

type FakeMac = {
  calls: string[];
  sleepDisabled: boolean;
  lid: boolean;
  causesSleepWhenReleased: boolean;
  batt: string;
  battCode: number;
  sudo: "ok" | "refused";
  sleepnowUnprivileged: boolean;
  caps: number;
};

function fakeMac(over: Partial<FakeMac> = {}): FakeMac & { run: (f: string, a: string[]) => Promise<RunResult> } {
  const m: FakeMac = { calls: [], sleepDisabled: false, lid: false, causesSleepWhenReleased: true, batt: BATT_AC, battCode: 0, sudo: "ok", sleepnowUnprivileged: true, caps: FULL_WAKE, ...over };
  const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
  return Object.assign(m, {
    run: async (file: string, args: string[]): Promise<RunResult> => {
      const line = [file, ...args].join(" ");
      m.calls.push(line);
      if (line === "/usr/bin/pmset -g batt") return { code: m.battCode, stdout: m.battCode === 0 ? m.batt : "", stderr: "" };
      if (line === "/usr/bin/pmset -g therm") return ok(THERM_NONE);
      if (line.startsWith("/usr/sbin/ioreg")) return ok(ioreg(m.lid, m.lid && !m.sleepDisabled && m.causesSleepWhenReleased, m.sleepDisabled, m.caps));
      if (line.startsWith("/usr/bin/sudo -n /usr/bin/pmset -a disablesleep ")) {
        if (m.sudo === "refused") return { code: 1, stdout: "", stderr: "sudo: a password is required\n" };
        m.sleepDisabled = line.endsWith(" 1");
        return ok();
      }
      if (line === "/usr/bin/pmset sleepnow") return m.sleepnowUnprivileged ? ok("Sleeping now...\n") : { code: 1, stdout: "", stderr: "must be root" };
      if (line === "/usr/bin/sudo -n /usr/bin/pmset sleepnow") return ok();
      throw new Error(`unexpected command: ${line}`);
    },
  });
}

function controller(mac: ReturnType<typeof fakeMac>, o: { settings: () => AwakeSettings; activity?: () => Activity; journalFile?: string; platform?: NodeJS.Platform; clock?: { t: number } }) {
  const clock = o.clock ?? { t: NOW };
  const journalFile = o.journalFile ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cr-awake-")), "awake.json");
  const lines: string[] = [];
  const c = new AwakeController({
    platform: o.platform ?? "darwin",
    run: mac.run,
    settings: o.settings,
    activity: o.activity ?? (() => ({ inFlight: 0 })),
    journalFile,
    log: { info: (m) => lines.push(m), warn: (m) => lines.push(`WARN ${m}`) },
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; },
    fileExists: () => true,
    schedule: () => () => {},
  });
  return { c, clock, journalFile, lines };
}

const settings = (s: Partial<AwakeSettings>) => () => ({ ...AWAKE_DEFAULTS, ...s });

test("off this Mac: nothing runs and the state says unsupported", async () => {
  const mac = fakeMac();
  const { c } = controller(mac, { settings: settings({ mode: "on" }), platform: "linux" });
  await c.start();
  await c.tick();
  assert.deepEqual(mac.calls, []);
  assert.equal(c.status().setup, "unsupported");
});

test("mode off with nothing applied runs no command at all", async () => {
  const mac = fakeMac();
  const { c } = controller(mac, { settings: settings({ mode: "off" }) });
  await c.start();
  assert.deepEqual(mac.calls, []);
  assert.equal(c.status().applied, false);
});

test("working: a running call disables sleep (journal first), going idle re-enables it", async () => {
  const mac = fakeMac();
  let activity: Activity = { inFlight: 1 };
  const { c, clock, journalFile } = controller(mac, { settings: settings({ mode: "working" }), activity: () => activity });
  await c.tick();
  assert.ok(mac.calls.includes("/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 1"));
  assert.equal(c.status().applied, true);
  assert.equal(readJournal(journalFile)?.applied, true);
  // The call ends; 9 minutes later still inside the window.
  activity = { inFlight: 0, lastStartedAt: NOW, lastEndedAt: NOW + 1000 };
  clock.t = NOW + 9 * 60_000;
  await c.tick();
  assert.equal(c.status().applied, true);
  clock.t = NOW + 11 * 60_000;
  mac.calls.length = 0;
  await c.tick();
  assert.ok(mac.calls.includes("/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0"));
  assert.equal(c.status().applied, false);
  assert.equal(readJournal(journalFile)?.applied, false);
  assert.ok(!mac.calls.some((l) => l.includes("sleepnow")), "lid open: no sleepnow");
});

test("releasing with the lid closed and nothing else holding it puts the Mac to sleep", async () => {
  const mac = fakeMac({ lid: true });
  let mode: AwakeSettings["mode"] = "on";
  const { c, clock } = controller(mac, { settings: () => ({ ...AWAKE_DEFAULTS, mode }) });
  await c.tick();
  assert.equal(c.status().applied, true);
  mode = "off";
  const before = clock.t;
  await c.tick();
  const i0 = mac.calls.indexOf("/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0");
  const i1 = mac.calls.indexOf("/usr/bin/pmset sleepnow");
  assert.ok(i0 >= 0 && i1 > i0, "clear first, then sleep");
  assert.equal(clock.t - before, SLEEPNOW_SETTLE_MS, "waits for the lid state to settle before reading it");
});

test("a call in a dark wake takes no hold; the lid opening takes it, and a dark-wake reading keeps it", async () => {
  // 2026-10-24 01:09: keep-warm pings in a maintenance dark wake held a closed lid awake for 72 min.
  const mac = fakeMac({ lid: true, caps: DARK_WAKE });
  const { c, lines } = controller(mac, { settings: settings({ mode: "working" }), activity: () => ({ inFlight: 1 }) });
  await c.tick();
  assert.ok(!mac.calls.some((l) => l.includes("disablesleep")), "no hold in a dark wake");
  assert.equal(c.status().applied, false);
  assert.match(c.status().reason, /^asleep: /);
  assert.ok(lines.includes(`awake: ${c.status().reason}`));
  mac.lid = false;
  mac.caps = FULL_WAKE;
  await c.tick();
  assert.equal(c.status().applied, true);
  mac.lid = true;
  mac.caps = DARK_WAKE;
  mac.calls.length = 0;
  await c.tick();
  assert.equal(c.status().applied, true);
  assert.ok(!mac.calls.some((l) => l.includes("disablesleep 0")));
});

test("closed lid on an external display (closed-display mode) is never put to sleep", async () => {
  const mac = fakeMac({ lid: true, causesSleepWhenReleased: false });
  let mode: AwakeSettings["mode"] = "on";
  const { c } = controller(mac, { settings: () => ({ ...AWAKE_DEFAULTS, mode }) });
  await c.tick();
  mode = "off";
  await c.tick();
  assert.ok(mac.calls.includes("/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0"));
  assert.ok(!mac.calls.some((l) => l.includes("sleepnow")));
});

test("sleepnow falls back to the sudoers rule when it needs root", async () => {
  const mac = fakeMac({ lid: true, sleepnowUnprivileged: false });
  let mode: AwakeSettings["mode"] = "on";
  const { c } = controller(mac, { settings: () => ({ ...AWAKE_DEFAULTS, mode }) });
  await c.tick();
  mode = "off";
  await c.tick();
  assert.ok(mac.calls.includes("/usr/bin/pmset sleepnow"));
  assert.ok(mac.calls.includes("/usr/bin/sudo -n /usr/bin/pmset sleepnow"));
});

test("on start, a bit the last process set is cleared when it is no longer wanted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-awake-"));
  const journalFile = path.join(dir, "awake.json");
  fs.writeFileSync(journalFile, JSON.stringify({ applied: true, since: "2026-10-20T10:00:00Z", reason: "on" }));
  const mac = fakeMac({ sleepDisabled: true });
  const { c } = controller(mac, { settings: settings({ mode: "off" }), journalFile });
  await c.start();
  assert.ok(mac.calls.includes("/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0"));
  assert.equal(readJournal(journalFile)?.applied, false);
});

test("a restart in working mode keeps the Mac awake: the exit leaves the bit, the journal carries the window", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-awake-"));
  const journalFile = path.join(dir, "awake.json");
  const mac = fakeMac({ lid: true });
  const clock = { t: NOW };
  const first = controller(mac, { settings: settings({ mode: "working" }), activity: () => ({ inFlight: 1, lastStartedAt: NOW }), journalFile, clock });
  await first.c.tick();
  assert.equal(mac.sleepDisabled, true);
  mac.calls.length = 0;
  first.c.beforeExit();
  assert.equal(mac.calls.length, 0, "the exit path runs no command");
  assert.equal(readJournal(journalFile)?.applied, true);
  // The successor has no in-memory activity; 30s later its first tick must not release a closed lid.
  clock.t += 30_000;
  const second = controller(mac, { settings: settings({ mode: "working" }), activity: () => ({ inFlight: 0 }), journalFile, clock });
  await second.c.start();
  assert.ok(!mac.calls.some((l) => l.includes("disablesleep 0") || l.includes("sleepnow")));
  assert.equal(second.c.status().applied, true);
  assert.match(second.c.status().reason, /^working: last model call/);
});

test("a journal that says applied after a reboot (bit reads cleared) re-applies when wanted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-awake-"));
  const journalFile = path.join(dir, "awake.json");
  fs.writeFileSync(journalFile, JSON.stringify({ applied: true, since: "x", reason: "on" }));
  const mac = fakeMac({ sleepDisabled: false });
  const { c } = controller(mac, { settings: settings({ mode: "on" }), journalFile });
  await c.tick();
  assert.ok(mac.calls.includes("/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 1"));
  assert.equal(mac.sleepDisabled, true);
});

test("sudo -n refused: needs-setup, nothing recorded as applied, no prompt", async () => {
  const mac = fakeMac({ sudo: "refused" });
  const { c, journalFile } = controller(mac, { settings: settings({ mode: "on" }) });
  await c.tick();
  const s = c.status();
  assert.equal(s.setup, "needs-setup");
  assert.equal(s.applied, false);
  assert.match(s.reason, /awake setup/);
  assert.equal(readJournal(journalFile)?.applied, false);
});

test("guards release a held Mac: battery under the floor, and a failed battery read", async () => {
  const mac = fakeMac();
  const { c } = controller(mac, { settings: settings({ mode: "on" }) });
  await c.tick();
  assert.equal(c.status().applied, true);
  mac.batt = BATT_LOW;
  await c.tick();
  assert.equal(c.status().applied, false);
  assert.match(c.status().reason, /battery 15%/);
  mac.batt = BATT_AC;
  await c.tick();
  assert.equal(c.status().applied, true);
  mac.battCode = 1;
  await c.tick();
  assert.equal(c.status().applied, false);
  assert.match(c.status().reason, /^error: pmset -g batt failed/);
});
