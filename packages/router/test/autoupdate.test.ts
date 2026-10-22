import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutoUpdater, UPDATE_TIMING as T, type AutoUpdateDeps, type UpdateClock } from "../src/autoupdate.ts";
import { ConfigStore, DEFAULTS, validate, type Config } from "../src/config.ts";
import type { Activity } from "../src/awake.ts";
import type { CliResult, UpdateCheck } from "../src/cli-control.ts";

class Clock implements UpdateClock {
  time = 1_000_000;
  jitter = 0.5;
  tasks: { at: number; fn: () => void }[] = [];
  now = () => this.time;
  random = () => this.jitter;
  later(fn: () => void, ms: number): () => void {
    const task = { at: this.time + ms, fn };
    this.tasks.push(task);
    return () => { this.tasks = this.tasks.filter((t) => t !== task); };
  }
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      this.tasks.sort((a, b) => a.at - b.at);
      const next = this.tasks[0];
      if (!next || next.at > end) break;
      this.tasks.shift(); this.time = next.at; next.fn();
      await this.flush();
    }
    this.time = end;
    await this.flush();
  }
  async flush(): Promise<void> { for (let i = 0; i < 8; i++) await Promise.resolve(); }
}
function fixture(t: TestContext, kind = "script") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-auto-update-"));
  const file = path.join(home, "auto-update.json");
  const clock = new Clock();
  const logs: string[] = [];
  const f = {
    home, file, clock, logs, enabled: true, activity: { inFlight: 0 } as Activity,
    check: { current: "1.0.0", latest: "1.1.0", newer: true, kind } as UpdateCheck,
    checks: 0, launches: 0, fail: false, settle: (_result: CliResult) => {},
  };
  const deps: AutoUpdateDeps = {
    home, version: "1.0.0", enabled: () => f.enabled, activity: () => f.activity,
    clock, log: { info: (message) => logs.push(message) }, alive: () => false,
    runCli: async (args, timeout) => {
      assert.deepEqual(args, ["update", "--check", "--json"]); assert.equal(timeout, 30_000);
      f.checks++; return { ok: true, output: JSON.stringify(f.check) };
    },
    startCliDetached: (args, log, env) => {
      assert.deepEqual(args, ["update"]); assert.equal(log, path.join(home, "logs", "update.log"));
      assert.equal(env?.CLAUDERIPPLE_PACKAGE, `clauderipple@${f.check.latest}`);
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(saved.pending.to, f.check.latest, "intent is durable before launch");
      assert.equal(saved.pending.from, "1.0.0");
      f.launches++;
      if (f.fail) throw new Error("installer failed");
      return { pid: 1234, completion: new Promise<CliResult>((resolve) => { f.settle = resolve; }) };
    },
  };
  const updater = new AutoUpdater(deps);
  t.after(() => { updater.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  return { ...f, f, deps, updater };
}

for (const kind of ["script", "npm", "packaged", "checkout", "unknown"]) {
  test(`auto-update install policy: ${kind}`, async (t) => {
    const { updater, f } = fixture(t, kind);
    updater.start();
    await f.clock.advance(T.first - 1); assert.equal(f.checks, 0);
    await f.clock.advance(1);
    assert.equal(f.checks, 1);
    assert.equal(f.launches, kind === "script" || kind === "npm" ? 1 : 0);
    assert.equal(updater.status().available, "1.1.0");
  });
}
test("waits for both in-flight work and ten quiet minutes after it ends", async (t) => {
  const { updater, f } = fixture(t);
  f.activity.inFlight = 1; updater.start();
  await f.clock.advance(T.first); assert.equal(f.launches, 0);
  f.activity = { inFlight: 0, lastStartedAt: f.clock.now(), lastEndedAt: f.clock.now() };
  await f.clock.advance(T.poll); assert.equal(f.launches, 0);
  await f.clock.advance(T.poll); assert.equal(f.launches, 1);
  assert.throws(() => updater.install(f.check), /already running/);
});
test("hot opt-out cancels idle waiting but continues availability checks", async (t) => {
  const { updater, f } = fixture(t);
  f.activity.inFlight = 1; updater.start(); await f.clock.advance(T.first);
  f.enabled = false; f.activity.inFlight = 0;
  await f.clock.advance(T.poll);
  assert.equal(f.launches, 0); assert.equal(updater.status().enabled, false);
  await f.clock.advance(T.interval); assert.equal(f.checks, 2); assert.equal(f.launches, 0);
  f.enabled = true; await f.clock.advance(T.interval); assert.equal(f.launches, 1);
});
test("gives up after 24 hours, then starts a fresh cycle", async (t) => {
  const { updater, f } = fixture(t);
  f.activity.inFlight = 1; updater.start(); await f.clock.advance(T.first + T.backoff);
  assert.equal(f.checks, 1); assert.equal(f.launches, 0);
  assert.ok(f.logs.some((l) => l.includes("gave up")));
  f.activity.inFlight = 0; await f.clock.advance(T.interval); assert.equal(f.launches, 1);
});
test("failed version backs off across restart, and retries after 24 hours", async (t) => {
  const { updater, f, deps } = fixture(t);
  f.fail = true; updater.start(); await f.clock.advance(T.first);
  assert.equal(f.launches, 1); assert.match(updater.status().lastError!, /installer failed/);
  updater.stop();
  const restarted = new AutoUpdater(deps); t.after(() => restarted.stop()); restarted.start();
  await f.clock.advance(T.first + T.interval); assert.equal(f.launches, 1);
  await f.clock.advance(T.interval); assert.equal(f.launches, 2);
});
test("nonzero detached exit persists failure; successful exit alone is not completion", async (t) => {
  const { updater, f } = fixture(t);
  updater.start(); await f.clock.advance(T.first);
  f.settle({ ok: false, output: "exit 1" }); await f.clock.flush();
  assert.match(updater.status().lastError!, /exit 1/); assert.equal(updater.status().running, false);
  f.check.latest = "1.2.0"; await f.clock.advance(T.interval); assert.equal(f.launches, 2);
  f.settle({ ok: true, output: "ok" }); await f.clock.flush();
  assert.equal(updater.status().lastUpdatedFrom, undefined);
  await f.clock.advance(T.interval); assert.equal(f.launches, 2);
  assert.match(updater.status().lastError!, /did not restart/);
});
test("only a router running the exact recorded target confirms completion", async (t) => {
  const { updater, f, deps } = fixture(t);
  updater.install(f.check);
  assert.equal(updater.status().lastUpdatedAt, undefined);
  const successor = new AutoUpdater({ ...deps, version: "1.1.0" });
  assert.equal(successor.status().lastUpdatedFrom, "1.0.0");
  assert.equal(successor.status().lastUpdatedTo, "1.1.0");
  assert.equal(successor.status().lastUpdatedAt, f.clock.now());
  assert.equal(successor.status().available, undefined);
  assert.deepEqual(new AutoUpdater({ ...deps, version: "1.1.0" }).status(), successor.status());
});
test("the target router waits for the surviving installer before allowing tray replacement or another install", (t) => {
  const { updater, f, deps } = fixture(t);
  updater.install(f.check);
  let installerAlive = true;
  const successor = new AutoUpdater({ ...deps, version: "1.1.0", alive: () => installerAlive });
  assert.equal(successor.status().lastUpdatedTo, "1.1.0");
  assert.equal(successor.status().running, true);
  assert.throws(() => successor.install({ ...f.check, latest: "1.2.0" }), /already running/);
  installerAlive = false;
  assert.equal(successor.status().running, false);
  installerAlive = true; // A reused PID cannot revive the retired installer.
  assert.equal(successor.status().running, false);
});
test("old-version restart with a dead installer becomes a backed-off failure", async (t) => {
  const { updater, f, deps } = fixture(t);
  updater.install(f.check);
  const successor = new AutoUpdater(deps); t.after(() => successor.stop());
  assert.equal(successor.status().lastUpdatedTo, undefined);
  assert.match(successor.status().lastError!, /previous update/);
  successor.start(); await f.clock.advance(T.first); assert.equal(f.launches, 1);
});
test("a surviving detached installer blocks another install across restart", async (t) => {
  const { updater, f, deps } = fixture(t);
  updater.install(f.check);
  const successor = new AutoUpdater({ ...deps, alive: () => true }); t.after(() => successor.stop());
  successor.start(); await f.clock.advance(T.first + T.interval); assert.equal(f.launches, 1);
  assert.equal(successor.status().running, true);
});
test("jitter bounds, idempotent start and stop", async (t) => {
  const { updater, f } = fixture(t, "checkout");
  f.clock.jitter = 0; updater.start(); updater.start(); await f.clock.advance(T.first);
  assert.equal(f.clock.tasks[0]!.at - f.clock.now(), T.interval - T.jitter);
  f.clock.jitter = 1; await f.clock.advance(T.interval - T.jitter);
  assert.equal(f.clock.tasks[0]!.at - f.clock.now(), T.interval + T.jitter);
  updater.stop(); await f.clock.advance(T.interval * 2); assert.equal(f.checks, 2);
});
test("check errors are visible and do not launch an installer", async (t) => {
  const { f, deps } = fixture(t);
  const updater = new AutoUpdater({ ...deps, runCli: async () => ({ ok: false, output: "network unavailable" }) });
  t.after(() => updater.stop()); updater.start(); await f.clock.advance(T.first);
  assert.equal(f.launches, 0); assert.match(updater.status().lastError!, /network unavailable/);
});
test("unreadable saved state fails closed without overwriting it", (t) => {
  const { f, deps } = fixture(t);
  fs.writeFileSync(f.file, "broken");
  const updater = new AutoUpdater(deps);
  assert.throws(() => updater.install(f.check), /unreadable/);
  assert.equal(fs.readFileSync(f.file, "utf8"), "broken"); assert.equal(f.launches, 0);
});
test("a PID journal failure never clears the already-running install or allows another", async (t) => {
  const { f, deps } = fixture(t);
  const updater = new AutoUpdater({ ...deps, startCliDetached: (...args) => {
    const child = deps.startCliDetached(...args);
    fs.rmSync(f.file); fs.mkdirSync(f.file); // Force the post-launch atomic rename to fail.
    return child;
  } });
  updater.install(f.check);
  assert.equal(updater.status().running, true);
  assert.throws(() => updater.install(f.check), /refusing to install/);
  assert.equal(f.launches, 1);
  f.settle({ ok: false, output: "failed too" }); await f.clock.flush();
  assert.ok(f.logs.some((l) => l.includes("cannot persist failure")));
});
test("stopping or opting out during a pending check prevents automatic installation", async (t) => {
  const { f, deps } = fixture(t);
  let resolve: (r: CliResult) => void = () => {};
  const updater = new AutoUpdater({ ...deps, runCli: () => new Promise<CliResult>((r) => { resolve = r; }) });
  t.after(() => updater.stop()); updater.start(); await f.clock.advance(T.first);
  f.enabled = false;
  resolve({ ok: true, output: JSON.stringify(f.check) }); await f.clock.flush();
  assert.equal(f.launches, 0);
  f.enabled = true; await f.clock.advance(T.interval); updater.stop();
  resolve({ ok: true, output: JSON.stringify(f.check) }); await f.clock.flush();
  assert.equal(f.launches, 0); assert.equal(f.clock.tasks.length, 0);
});
test("autoUpdate validates booleans and hot-reloads with default-on omission", (t) => {
  const { f } = fixture(t);
  for (const autoUpdate of [true, false]) assert.deepEqual(validate({ ...DEFAULTS, autoUpdate }), []);
  for (const autoUpdate of [null, 0, "false", {}]) {
    const config: Config = JSON.parse(JSON.stringify({ ...DEFAULTS, autoUpdate }));
    assert.ok(validate(config).includes("autoUpdate must be true or false"));
  }
  const file = path.join(f.home, "config.json"); fs.writeFileSync(file, "{}");
  const store = new ConfigStore(file); assert.notEqual(store.get().autoUpdate, false);
  fs.writeFileSync(file, '{"autoUpdate":false}'); fs.utimesSync(file, 5000, 5000);
  assert.equal(store.get().autoUpdate, false);
  fs.writeFileSync(file, '{}'); fs.utimesSync(file, 6000, 6000);
  assert.notEqual(store.get().autoUpdate, false);
});
