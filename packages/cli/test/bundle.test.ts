import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundlePath, launcherPath, launcherScript, writeBundle } from "../src/bundle.ts";
import { targetsExist } from "../src/registration.ts";

function snapshot(dir: string) {
  return Object.fromEntries(fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const file = path.join(entry.parentPath, entry.name);
    const stat = fs.statSync(file, { bigint: true });
    return [path.relative(dir, file), { bytes: fs.readFileSync(file).toString("base64"), mtime: stat.mtimeNs, ctime: stat.ctimeNs, mode: stat.mode, inode: stat.ino }];
  }));
}

test("bundle is unchanged and not re-signed on identical writes or package version updates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-bundle-"));
  try {
    const script = path.join(root, "package", "dist", "router", "src", "index.js");
    const icon = path.join(root, "package", "dist", "app", "assets", "icon.icns");
    fs.mkdirSync(path.dirname(icon), { recursive: true });
    fs.writeFileSync(icon, "test icns bytes");
    const opts = { home: path.join(root, "home"), node: process.execPath, script, version: "1.0.0" };
    const signed: string[] = [];
    const sign = (app: string) => {
      signed.push(app);
      fs.mkdirSync(path.join(app, "Contents", "_CodeSignature"), { recursive: true });
      fs.writeFileSync(path.join(app, "Contents", "_CodeSignature", "CodeResources"), `signature-${signed.length}`);
    };
    assert.equal(writeBundle(opts, sign), launcherPath(opts.home));
    assert.deepEqual(signed, [bundlePath(opts.home)]);
    const contents = path.join(bundlePath(opts.home), "Contents");
    const plist = fs.readFileSync(path.join(contents, "Info.plist"), "utf8");
    assert.doesNotMatch(plist, /CFBundleVersion|CFBundleShortVersionString/);
    assert.match(plist, /<key>CFBundleIconFile<\/key><string>icon.icns<\/string>/);
    assert.deepEqual(fs.readFileSync(path.join(contents, "Resources", "icon.icns")), fs.readFileSync(icon));
    const first = snapshot(bundlePath(opts.home));
    writeBundle(opts, sign);
    writeBundle({ ...opts, version: "2.0.0" }, sign);
    assert.equal(signed.length, 1);
    assert.deepEqual(snapshot(bundlePath(opts.home)), first);
    fs.writeFileSync(icon, "new icon bytes");
    writeBundle(opts, sign);
    assert.equal(signed.length, 2, "changed icon requires signing");
    const updated = snapshot(bundlePath(opts.home));
    writeBundle(opts, sign);
    assert.equal(signed.length, 2);
    assert.deepEqual(snapshot(bundlePath(opts.home)), updated);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher runs the router by default and the sibling CLI in tray mode, safely quoting paths", { skip: process.platform === "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-launcher-"));
  try {
    const repo = path.join(root, "a space's $HOME `literal`");
    const script = path.join(repo, "packages", "router", "src", "index.js");
    const cli = path.join(repo, "packages", "cli", "src", "index.js");
    for (const [file, kind] of [[script, "router"], [cli, "cli"]]) {
      fs.mkdirSync(path.dirname(file!), { recursive: true });
      fs.writeFileSync(file!, `console.log(JSON.stringify({ kind: ${JSON.stringify(kind)}, args: process.argv.slice(2), home: process.env.CLAUDERIPPLE_HOME }));`);
    }
    const opts = { home: path.join(repo, "state"), node: process.execPath, script };
    fs.mkdirSync(opts.home, { recursive: true });
    const launcher = path.join(root, "launcher");
    fs.writeFileSync(launcher, launcherScript(opts), { mode: 0o755 });
    const run = (...args: string[]) => JSON.parse(execFileSync("/bin/sh", [launcher, ...args], { encoding: "utf8" }));
    assert.deepEqual(run(), { kind: "router", args: [], home: opts.home });
    assert.deepEqual(run("tray"), { kind: "cli", args: ["tray", "--at-login"], home: opts.home });
    const plainRouter = path.join(root, "router.js");
    fs.writeFileSync(plainRouter, "");
    fs.writeFileSync(launcher, launcherScript({ ...opts, script: plainRouter }));
    assert.equal(targetsExist(launcher, []), true);
    fs.unlinkSync(plainRouter);
    assert.equal(targetsExist(launcher, []), false, "doctor still follows the router exec, not the tray branch");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
