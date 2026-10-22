import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { browse, windowsDrives } from "../src/folders.ts";

// A browse that starts in C:\Users could not reach a project on E: (Discord, 2026-10-22): a drive
// root has no parent, so the other drives are listed there instead.
test("a drive root lists the other drives first; a folder below it does not", async () => {
  const root = path.parse(process.cwd()).root;
  const drives = async () => [root, "E:\\", "F:\\"];
  const top = await browse(root, false, root, drives);
  assert.equal(top.parent, null);
  assert.deepEqual(top.entries.slice(0, 2), [{ path: "E:\\", name: "E:\\" }, { path: "F:\\", name: "F:\\" }]);
  assert.equal(top.entries.some(e => e.path === root), false);

  const below = await browse(process.cwd(), false, root, drives);
  assert.equal(below.entries.some(e => e.path === "E:\\"), false);
});

test("drives are only looked up on Windows", async () => {
  assert.deepEqual(await windowsDrives("darwin"), []);
  assert.deepEqual(await windowsDrives("linux"), []);
});
