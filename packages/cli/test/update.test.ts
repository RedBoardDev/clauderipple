import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installKind, isNewer, updateSource } from "../src/update.ts";

test("versions compare by number, not as text", () => {
  assert.equal(isNewer("0.6.0", "0.5.1"), true);
  assert.equal(isNewer("0.10.0", "0.9.9"), true);
  assert.equal(isNewer("0.5.1", "0.5.1"), false);
  assert.equal(isNewer("0.5.0", "0.5.1"), false);
  assert.equal(isNewer("v1.0.0", "0.9.0"), true);
});

// The install scripts and `npm install -g` put the package in the same layout; only the prefix
// says which one did, and each must be updated its own way (update.ts).
test("an install is recognised by where its files are", () => {
  const home = "/Users/me";
  const js = (repo: string) => ({ packaged: false, cli: `${repo}/dist/cli/src/index.js`, repo });
  assert.deepEqual(installKind(js("/Users/me/.clauderipple/lib/node_modules/clauderipple"), { platform: "darwin", env: {}, home }), { kind: "script", prefix: "/Users/me/.clauderipple" });
  assert.deepEqual(installKind(js("/opt/homebrew/lib/node_modules/clauderipple"), { platform: "darwin", env: {}, home }), { kind: "npm", prefix: "/opt/homebrew" });
  assert.deepEqual(installKind(js("/srv/cr/lib/node_modules/clauderipple"), { platform: "linux", env: { CLAUDERIPPLE_PREFIX: "/srv/cr" }, home }), { kind: "script", prefix: "/srv/cr" });
  assert.equal(installKind(js("/Users/me/project/node_modules/clauderipple"), { platform: "darwin", env: {}, home }).kind, "unknown");
  assert.equal(installKind({ packaged: false, cli: "/Users/me/src/ClaudeRipple/packages/cli/src/index.ts", repo: "/Users/me/src/ClaudeRipple" }, { platform: "darwin", env: {}, home }).kind, "checkout");
  assert.equal(installKind({ packaged: true, cli: "x", repo: "y" }).kind, "packaged");

  const win = { packaged: false, cli: "C:\\Users\\me\\.clauderipple\\node_modules\\clauderipple\\dist\\cli\\src\\index.js", repo: "C:\\Users\\me\\.clauderipple\\node_modules\\clauderipple" };
  assert.deepEqual(installKind(win, { platform: "win32", env: {}, home: "C:\\Users\\ME" }), { kind: "script", prefix: "C:\\Users\\me\\.clauderipple" });
  assert.equal(installKind({ ...win, repo: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\clauderipple" }, { platform: "win32", env: {}, home: "C:\\Users\\me" }).kind, "npm");
});

// The fork must not be replaced by the published package: upstream only when asked for.
test("updates come from the fork unless upstream is asked for", () => {
  assert.equal(updateSource({}), "fork");
  assert.equal(updateSource({ CLAUDERIPPLE_UPDATE_SOURCE: "fork" }), "fork");
  assert.equal(updateSource({ CLAUDERIPPLE_UPDATE_SOURCE: "npm" }), "fork");
  assert.equal(updateSource({ CLAUDERIPPLE_UPDATE_SOURCE: "upstream" }), "upstream");
});

test("update on a fork installs nothing and says how; the check never offers one", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cr-update-"));
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDERIPPLE_HOME: home, CLAUDE_SETTINGS_PATH: path.join(home, "settings.json") };
  delete env.CLAUDERIPPLE_UPDATE_SOURCE;
  delete env.NODE_OPTIONS;
  const cli = path.resolve(import.meta.dirname, "../src/index.ts");
  try {
    const update = spawnSync(process.execPath, [cli, "update"], { env, encoding: "utf8", timeout: 30_000 });
    assert.equal(update.status, 1);
    assert.match(update.stdout, /npm install --prefix ~\/\.clauderipple\/lib .*\.tgz\n\s*clauderipple restart/);
    // The tray and the dashboard offer an update only when this says newer.
    const check = spawnSync(process.execPath, [cli, "update", "--check", "--json"], { env, encoding: "utf8", timeout: 30_000 });
    assert.equal(check.status, 0);
    const result = JSON.parse(check.stdout.trim().split("\n").pop()!) as Record<string, unknown>;
    assert.deepEqual([result.latest, result.newer, result.kind], [null, false, "fork"]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
