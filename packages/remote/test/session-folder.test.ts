import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listSessionFolder, readSessionFolderFile, FOLDER_READ_CAP } from "../src/session-folder.ts";

function fixture(t: import("node:test").TestContext): { root: string; outside: string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ripple-folder-")));
  const root = path.join(dir, "project");
  const outside = path.join(dir, "secret");
  fs.mkdirSync(root); fs.mkdirSync(outside);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "app.ts"), "export const x = 1;\n");
  fs.writeFileSync(path.join(root, "README.md"), "# read me\n");
  fs.writeFileSync(path.join(root, ".hidden"), "dotfiles stay out of the listing\n");
  fs.writeFileSync(path.join(outside, "private.txt"), "not for the phone\n");
  fs.symlinkSync(outside, path.join(root, "escape"));
  fs.symlinkSync(path.join(root, "src"), path.join(root, "inside-link"));
  fs.writeFileSync(path.join(root, "big.bin"), Buffer.alloc(FOLDER_READ_CAP + 1));
  fs.unlinkSync(path.join(outside, "private.txt")); // keep the escape target existing but empty
  fs.writeFileSync(path.join(outside, "private.txt"), "not for the phone\n");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { root, outside };
}

test("the session folder lists folders first, without dotfiles, and marks an escaping symlink", async t => {
  const { root } = fixture(t);
  const listing = await listSessionFolder(root);
  assert.equal(listing.path, ".");
  assert.equal(listing.parent, null);
  assert.deepEqual(listing.entries.map(e => e.name), ["inside-link", "src", "big.bin", "escape", "README.md"]);
  assert.equal(listing.entries.find(e => e.name === "escape")?.blocked, true);
  assert.equal(listing.entries.find(e => e.name === "inside-link")?.dir, true);
  assert.equal(listing.entries.find(e => e.name === "big.bin")?.dir, false);
  assert.equal(listing.entries.find(e => e.name === "big.bin")?.bytes, FOLDER_READ_CAP + 1);
  assert.equal(listing.entries.some(e => e.name === ".hidden"), false);
  assert.equal(listing.truncated, false);
});

test("walking down and back up stays inside the session folder", async t => {
  const { root } = fixture(t);
  const down = await listSessionFolder(root, "src");
  assert.equal(down.path, "src");
  assert.equal(down.parent, ".");
  assert.deepEqual(down.entries.map(e => e.name), ["app.ts"]);
  const up = await listSessionFolder(root, down.parent ?? ".");
  assert.equal(up.path, ".");
});

test("a path outside the folder, absolute or through a symlink, is refused", async t => {
  const { root, outside } = fixture(t);
  for (const requested of ["..", "../secret", path.join(outside, "private.txt"), "/etc", "escape", "inside-link/../../secret"]) {
    await assert.rejects(listSessionFolder(root, requested), /outside the session folder|inside the session folder/, requested);
    await assert.rejects(readSessionFolderFile(root, requested), /outside the session folder|inside the session folder|not a file/, requested);
  }
});

test("one small file reads back with its media type; a large one is refused, not truncated", async t => {
  const { root } = fixture(t);
  const file = await readSessionFolderFile(root, "src/app.ts");
  assert.equal(file.name, "app.ts");
  assert.equal(file.mediaType, "text/plain");
  assert.equal(Buffer.from(file.data, "base64").toString("utf8"), "export const x = 1;\n");
  await assert.rejects(readSessionFolderFile(root, "big.bin"), /too large to read on the phone/);
  await assert.rejects(readSessionFolderFile(root, "src"), /not a file/);
  // A symlink that stays inside is allowed; the resolved target is what is read.
  const linked = await readSessionFolderFile(root, "inside-link/app.ts");
  assert.equal(Buffer.from(linked.data, "base64").toString("utf8"), "export const x = 1;\n");
});
