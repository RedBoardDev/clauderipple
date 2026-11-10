import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readModRoutingSettings, readModSettings } from "../src/mod-settings.ts";

test("worker settings reads cost one stat and never read compaction or ownership files", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-worker-settings-cache-"));
  const file = path.join(home, "mod-settings.json");
  fs.writeFileSync(file, JSON.stringify({ revision: 1, settings: {} }));
  const read = fs.readFileSync;
  const stat = fs.statSync;
  let reads = 0;
  let stats = 0;
  let denyStat = false;
  let denyRead = false;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    assert.equal(args[0], file, "worker lookup must not read any other settings file");
    if (denyRead) throw Object.assign(new Error("read denied"), { code: "EACCES" });
    reads++;
    return read(...args);
  });
  t.mock.method(fs, "statSync", (...args: Parameters<typeof fs.statSync>) => {
    assert.equal(args[0], file);
    if (denyStat) throw Object.assign(new Error("unreadable"), { code: "EACCES" });
    stats++;
    return stat(...args);
  });
  try {
    for (let i = 0; i < 6; i++) assert.equal(readModRoutingSettings(home).stored, true);
    assert.equal(reads, 1);
    assert.equal(stats, 6);
    denyStat = true;
    assert.throws(() => readModRoutingSettings(home), /unreadable/);
    denyStat = false;
    // A changed file's read failing also invalidates the warm cache.
    fs.writeFileSync(file, JSON.stringify({ revision: 2, settings: {} }));
    denyRead = true;
    assert.throws(() => readModRoutingSettings(home), /read denied/);
    denyRead = false;
    assert.equal(readModRoutingSettings(home).revision, 2);
  } finally {
    t.mock.restoreAll();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("unchanged mod settings are parsed once, with isolated returned snapshots", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ripple-mod-cache-"));
  const file = path.join(home, "mod-settings.json");
  fs.writeFileSync(file, JSON.stringify({ revision: 1, settings: {} }));
  const read = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === file) reads++;
    return read(...args);
  });
  try {
    const first = readModSettings(home);
    for (let i = 0; i < 5; i++) assert.deepEqual(readModSettings(home), first);
    assert.equal(reads, 1, "warm requests must not reread or reparse the settings file");
    first.settings.providers.example = false;
    assert.equal(readModSettings(home).settings.providers.example, undefined);
    fs.writeFileSync(file, JSON.stringify({ revision: 2, settings: { providers: { example: false } } }));
    assert.equal(readModSettings(home).revision, 2);
    assert.equal(reads, 2);
    fs.writeFileSync(file, "{broken");
    assert.throws(() => readModSettings(home));
    assert.throws(() => readModSettings(home), "corruption must never reuse the last good settings");
    fs.rmSync(file);
    assert.equal(readModSettings(home).stored, false);
    fs.mkdirSync(file);
    assert.throws(() => readModSettings(home), "unreadable storage must not use cached authority");
  } finally {
    t.mock.restoreAll();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
