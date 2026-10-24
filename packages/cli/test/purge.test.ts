import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { purgeHome } from "../src/purge.ts";

function scratch(t: import("node:test").TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-purge-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  return root;
}

test("purge removes an ordinary home and propagates a deletion failure", async t => {
  const root = scratch(t), home = path.join(root, "home");
  fs.mkdirSync(home); fs.writeFileSync(path.join(home, "config.json"), "{}");
  await purgeHome(home);
  assert.equal(fs.existsSync(home), false);
  const rm = fs.rmSync;
  const mock = t.mock.method(fs, "rmSync", (...args: Parameters<typeof fs.rmSync>) => {
    if (args[0] === home) throw Object.assign(new Error("locked"), { code: "EPERM" });
    return rm(...args);
  });
  await assert.rejects(() => purgeHome(home), /locked/);
  mock.mock.restore();
});

test("Windows self-purge waits for its Node process to exit, reports pending nonzero, then records success", { skip: process.platform !== "win32" }, async t => {
  const root = scratch(t), home = path.join(root, "a space's 한글 & %USERPROFILE%! home");
  const outside = path.join(root, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "keep.txt"), "preserve");
  fs.mkdirSync(home);
  const node = path.join(home, "node.exe");
  fs.copyFileSync(process.execPath, node);
  fs.symlinkSync(outside, path.join(home, "junction"), "junction");
  const module = pathToFileURL(path.resolve(import.meta.dirname, "../src/purge.ts")).href;
  const source = `import {purgeHome} from ${JSON.stringify(module)}; const result=await purgeHome(${JSON.stringify(home)}); console.log(JSON.stringify(result)); if(result?.status==='deferred') process.exitCode=2;`;
  const child = spawnSync(node, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 30_000 });
  assert.equal(child.status, 2, child.stderr || child.stdout);
  const result = JSON.parse(child.stdout.trim()) as { status: string; resultFile: string };
  assert.equal(result.status, "deferred");
  t.after(() => fs.rmSync(path.dirname(result.resultFile), { recursive: true, force: true }));
  let receipt: { exitCode?: number } = {};
  for (let i = 0; i < 150; i++) {
    if (fs.existsSync(result.resultFile)) receipt = JSON.parse(fs.readFileSync(result.resultFile, "utf8"));
    if (receipt.exitCode !== undefined) break;
    await delay(100);
  }
  assert.equal(receipt.exitCode, 0, JSON.stringify({ receipt, log: fs.readFileSync(path.join(path.dirname(result.resultFile), "cleanup.log"), "utf8") }));
  assert.equal(fs.existsSync(home), false);
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "preserve");
});

test("Windows purge reports a different process's locked executable as failure", { skip: process.platform !== "win32" }, async t => {
  const root = scratch(t), home = path.join(root, "held");
  fs.mkdirSync(home);
  const node = path.join(home, "node.exe"); fs.copyFileSync(process.execPath, node);
  const held = spawn(node, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { held.once("spawn", resolve); held.once("error", reject); });
  try { await assert.rejects(() => purgeHome(home), /EPERM|EBUSY|EACCES/); }
  finally { held.kill(); await new Promise<void>(resolve => held.once("exit", () => resolve())); }
});

test("the deferred cleaner records failure instead of success when another process keeps Node locked", { skip: process.platform !== "win32" }, async t => {
  const root = scratch(t), home = path.join(root, "held-after-exit");
  fs.mkdirSync(home);
  const node = path.join(home, "node.exe"); fs.copyFileSync(process.execPath, node);
  const held = spawn(node, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { held.once("spawn", resolve); held.once("error", reject); });
  try {
    const module = pathToFileURL(path.resolve(import.meta.dirname, "../src/purge.ts")).href;
    const source = `import {purgeHome} from ${JSON.stringify(module)}; console.log(JSON.stringify(await purgeHome(${JSON.stringify(home)}))); process.exitCode=2;`;
    const child = spawnSync(node, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 30_000 });
    assert.equal(child.status, 2, child.stderr);
    const result = JSON.parse(child.stdout.trim()) as { resultFile: string };
    t.after(() => fs.rmSync(path.dirname(result.resultFile), { recursive: true, force: true, maxRetries: 3 }));
    let receipt: { exitCode?: number; error?: string } = {};
    for (let i = 0; i < 150; i++) {
      receipt = JSON.parse(fs.readFileSync(result.resultFile, "utf8"));
      if (receipt.exitCode !== undefined) break;
      await delay(100);
    }
    assert.equal(receipt.exitCode, 1);
    assert.ok(receipt.error);
    assert.equal(fs.existsSync(node), true);
  } finally {
    held.kill(); await new Promise<void>(resolve => held.once("exit", () => resolve()));
  }
});
