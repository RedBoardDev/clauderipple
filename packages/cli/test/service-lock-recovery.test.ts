import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { withServiceLock } from "../src/service-definition.ts";

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-lock-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, key: path.join(root, "service") };
}

test("service lock recovers after its owner exits without finally", t => {
  const { root, key } = fixture(t);
  const module = new URL("../src/service-definition.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import { withServiceLock } from ${JSON.stringify(module)}; withServiceLock(process.argv[1], () => process.exit(73), () => 'child-start');`, key], { env: { ...process.env, HOME: root }, encoding: "utf8" });
  assert.equal(result.status, 73, result.stderr);
  let entered = false;
  withServiceLock(key, () => { entered = true; }, pid => pid === process.pid ? "parent-start" : null);
  assert.equal(entered, true);
  assert.equal(fs.existsSync(`${key}.operation-lock`), false);
});

test("service lock recovers a reused PID only when its start identity differs", t => {
  const { key } = fixture(t);
  fs.mkdirSync(`${key}.operation-lock`);
  fs.writeFileSync(path.join(`${key}.operation-lock`, `${process.pid}-${"0".repeat(64)}.owner`), "");
  let entered = false;
  withServiceLock(key, () => { entered = true; }, pid => pid === process.pid ? "parent-start" : null);
  assert.equal(entered, true);
});

test("service lock never expires a live owner and preserves unknown locks", t => {
  const { key } = fixture(t);
  const lookup = () => "live-start";
  withServiceLock(key, () => {
    const ancient = new Date(0);
    fs.utimesSync(`${key}.operation-lock`, ancient, ancient);
    assert.throws(() => withServiceLock(key, () => assert.fail("live lock stolen"), lookup), { code: "ELOCKED" });
  }, lookup);
  fs.mkdirSync(`${key}.operation-lock`);
  assert.throws(() => withServiceLock(key, () => assert.fail("unknown lock stolen"), lookup), { code: "ELOCKED" });
});

test("service lock preserves a recorded owner when its process lookup fails", t => {
  const { key } = fixture(t);
  const lock = `${key}.operation-lock`;
  fs.mkdirSync(lock);
  const owner = path.join(lock, `4242-${"0".repeat(64)}.owner`);
  fs.writeFileSync(owner, "");
  assert.throws(() => withServiceLock(key, () => assert.fail("unknown owner stolen"), pid => pid === process.pid ? "self" : undefined), { code: "ELOCKED" });
  assert.equal(fs.existsSync(owner), true);
});

for (const damaged of [false, true]) {
  test(`service lock gives manual recovery guidance for ${damaged ? "damaged" : "empty legacy or interrupted"} locks`, t => {
    const { key } = fixture(t);
    const lock = `${key}.operation-lock`;
    fs.mkdirSync(lock);
    if (damaged) fs.writeFileSync(path.join(lock, "broken.owner"), "unreadable identity");
    const before = fs.readdirSync(lock);
    assert.throws(() => withServiceLock(key, () => assert.fail("unproven lock stolen"), () => "self"), error => {
      assert.equal((error as NodeJS.ErrnoException).code, "ELOCKED");
      assert.equal((error as Error).message, `서비스 작업 잠금의 소유자를 확인할 수 없습니다. 다른 ClaudeRipple 설치, 제거, 재시작 작업이 실행 중이 아니라면 이 잠금 폴더를 삭제한 뒤 다시 시도해 주세요. (${lock})`);
      return true;
    });
    assert.deepEqual(fs.readdirSync(lock), before);
  });
}

test("service lock is visible only with its owner file already inside", t => {
  const { key } = fixture(t);
  const lock = `${key}.operation-lock`;
  withServiceLock(key, () => {
    const entries = fs.readdirSync(lock);
    assert.equal(entries.length, 1);
    assert.match(entries[0]!, /^\d+-[a-f0-9]{64}\.owner$/);
  }, () => "start");
  assert.deepEqual(fs.readdirSync(path.dirname(key)), [], "the release leaves no staging directory behind");
});

test("a staging directory from an interrupted acquisition never blocks the next writer", t => {
  const { key } = fixture(t);
  const staging = `${key}.operation-lock.new-4242-deadbeef`;
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(staging, `4242-${"0".repeat(64)}.owner`), "");
  let entered = false;
  withServiceLock(key, () => { entered = true; }, () => "start");
  assert.equal(entered, true);
  assert.equal(fs.existsSync(`${key}.operation-lock`), false);
  assert.equal(fs.existsSync(staging), true, "another writer's staging directory is not ours to delete");
});

test("service lock never replaces a legacy empty lock claimed at the filesystem boundary", t => {
  const { key } = fixture(t);
  const lock = `${key}.operation-lock`;
  const mkdir = fs.mkdirSync.bind(fs);
  const lstat = fs.lstatSync.bind(fs);
  let legacyClaimed = false;
  const claim = () => { if (!legacyClaimed) { mkdir(lock); legacyClaimed = true; } };
  // Old implementation: the legacy writer wins immediately after the absence check.
  t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
    try { return lstat(...args); } catch (error) {
      if (args[0] === lock && (error as NodeJS.ErrnoException).code === "ENOENT") claim();
      throw error;
    }
  });
  // mkdir implementation: the same writer wins just before the atomic claim.
  t.mock.method(fs, "mkdirSync", (...args: Parameters<typeof fs.mkdirSync>) => {
    if (args[0] === lock) claim();
    return mkdir(...args);
  });
  let entered = false;
  assert.throws(() => withServiceLock(key, () => { entered = true; }, () => "self"), { code: "ELOCKED" });
  assert.equal(entered, false);
  assert.equal(legacyClaimed, true);
  assert.deepEqual(fs.readdirSync(lock), [], "the legacy writer's lock survives unchanged");
});
