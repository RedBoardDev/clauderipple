import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startAdmin } from "../src/admin.ts";
import { AutoUpdater, type AutoUpdateStatus } from "../src/autoupdate.ts";
import { ConfigStore, DEFAULTS, type Config } from "../src/config.ts";
import { Logger } from "../src/log.ts";
import { RequestLog } from "../src/requestlog.ts";

test("status, hot config and manual POST share the router's automatic-update coordinator", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-auto-api-"));
  const oldHome = process.env.CLAUDERIPPLE_HOME;
  const oldSettings = process.env.CLAUDE_SETTINGS_PATH;
  process.env.CLAUDERIPPLE_HOME = home;
  process.env.CLAUDE_SETTINGS_PATH = path.join(home, "settings.json");
  t.after(() => {
    if (oldHome === undefined) delete process.env.CLAUDERIPPLE_HOME; else process.env.CLAUDERIPPLE_HOME = oldHome;
    if (oldSettings === undefined) delete process.env.CLAUDE_SETTINGS_PATH; else process.env.CLAUDE_SETTINGS_PATH = oldSettings;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const configFile = path.join(home, "config.json");
  fs.writeFileSync(configFile, JSON.stringify({ ...DEFAULTS, admin: { port: 0 } }));
  const store = new ConfigStore(configFile);
  const log = new Logger(null, 1_000_000, 1, false);
  const check = { current: "1.0.0", latest: "1.1.0", newer: true, kind: "npm" };
  let launches = 0;
  const runCli = async () => ({ ok: true, output: JSON.stringify(check) });
  const updater = new AutoUpdater({ home, version: "1.0.0", enabled: () => store.get().autoUpdate !== false,
    activity: () => ({ inFlight: 0 }), log, runCli,
    startCliDetached: () => { launches++; }, alive: () => false,
  });
  const admin = await startAdmin({ config: () => store.get(), configFile, log,
    stats: () => ({ inFlight: 0, messagesInFlight: 0, started: 0, completed: 0, failed: 0 }),
    health: () => 0, version: "1.0.0", requests: new RequestLog(path.join(home, "requests.jsonl")), runCli, autoUpdater: updater,
  });
  try {
    const url = `http://127.0.0.1:${admin.port}`;
    const status = async () => ((await (await fetch(`${url}/api/status`)).json()) as { autoUpdate: AutoUpdateStatus }).autoUpdate;
    assert.equal((await status()).enabled, true);
    const config = (await (await fetch(`${url}/api/config`)).json()) as Config;
    const put = await fetch(`${url}/api/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...config, autoUpdate: false }) });
    assert.equal(put.status, 200); assert.equal((await status()).enabled, false);
    await fetch(`${url}/api/update`);
    assert.equal((await status()).available, "1.1.0");
    // Manual updates remain available with autoUpdate off, but concurrent launches are serialized.
    const requests = await Promise.all([fetch(`${url}/api/update`, { method: "POST" }), fetch(`${url}/api/update`, { method: "POST" })]);
    assert.deepEqual(requests.map((r) => r.status).sort(), [202, 409]);
    assert.equal(launches, 1); assert.equal((await status()).running, true);
    assert.throws(() => updater.install(check), /already running/);
    assert.equal((await status()).lastUpdatedFrom, undefined, "intent is not a completion notice");
    const successor = new AutoUpdater({ home, version: "1.1.0", enabled: () => false, activity: () => ({ inFlight: 0 }), log, runCli, startCliDetached: () => assert.fail("must not launch") });
    assert.equal(successor.status().lastUpdatedFrom, "1.0.0");
    assert.equal(successor.status().lastUpdatedTo, "1.1.0");
  } finally { admin.close(); }
});
