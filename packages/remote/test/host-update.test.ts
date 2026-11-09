import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requestHostUpdate, readHostUpdate, refreshHostUpdate } from "../src/host-update.ts";

function fixture(t: import("node:test").TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "host-update-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test("a busy host stays durably pending, retries when idle, and completes only on the target version", async t => {
  const home = fixture(t);
  let now = 1000, busy = true, version = "1.0.0", attempts = 0;
  requestHostUpdate(home, "1.1.0");
  const deps = {
    plan: async () => busy ? "busy" as const : "restart" as const,
    apply: async () => { attempts++; version = "1.1.0"; },
    version: async () => version, now: () => now,
  };
  await refreshHostUpdate(home, "1.1.0", deps);
  assert.equal(readHostUpdate(home)?.status, "pending");
  assert.equal(attempts, 0);
  busy = false;
  await refreshHostUpdate(home, "1.1.0", deps);
  assert.equal(attempts, 0, "bounded retry interval");
  now += 60_000;
  await refreshHostUpdate(home, "1.1.0", deps);
  assert.equal(attempts, 1);
  assert.equal(readHostUpdate(home)?.status, "applied");
});

test("a host already running the target completes even when busy, without another restart", async t => {
  const home = fixture(t);
  requestHostUpdate(home, "2.0.0");
  await refreshHostUpdate(home, "2.0.0", { plan: async () => "busy", apply: async () => assert.fail("already applied"), version: async () => "2.0.0" });
  assert.equal(readHostUpdate(home)?.status, "applied");
});

test("failed refreshes and wrong versions stay pending across restart; concurrent refreshes share a lease", async t => {
  const home = fixture(t);
  let now = 0, attempts = 0;
  const finish = Promise.withResolvers<void>();
  requestHostUpdate(home, "2.0.0");
  const deps = { plan: async () => "restart" as const, apply: async () => { attempts++; await finish.promise; }, version: async () => "old", now: () => now };
  const first = refreshHostUpdate(home, "2.0.0", deps);
  await refreshHostUpdate(home, "2.0.0", deps);
  await Promise.resolve();
  assert.equal(attempts, 1);
  finish.resolve(); await first;
  assert.equal(readHostUpdate(home)?.status, "pending");
  assert.match(readHostUpdate(home)?.error ?? "", /version/);
  now += 60_000;
  await refreshHostUpdate(home, "2.0.0", { ...deps, apply: async () => { throw new Error("unavailable"); } });
  assert.match(readHostUpdate(home)?.error ?? "", /unavailable/);
  assert.equal(readHostUpdate(home)?.status, "pending");
});

test("absent and foreign services are left alone; superseded targets are never completed by an older installer", async t => {
  const home = fixture(t);
  for (const plan of ["absent", "foreign"] as const) {
    requestHostUpdate(home, "1.1.0");
    await refreshHostUpdate(home, "1.1.0", { plan: async () => plan, apply: async () => assert.fail("foreign service"), version: async () => null });
    assert.equal(readHostUpdate(home)?.status, "skipped");
  }
  requestHostUpdate(home, "2.0.0");
  await refreshHostUpdate(home, "1.1.0", { plan: async () => assert.fail("obsolete files"), apply: async () => {}, version: async () => null });
  assert.equal(readHostUpdate(home)?.version, "2.0.0");
  assert.equal(readHostUpdate(home)?.status, "pending");
});
