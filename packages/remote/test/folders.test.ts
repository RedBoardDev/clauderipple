import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { browse, windowsDrives } from "../src/folders.ts";
import { sheet as drawSheet } from "../web/views.ts";
import type { UI } from "../web/views.ts";

// A browse that starts in C:\Users could not reach a project on E: (Discord, 2026-10-22); the
// drive was only listed once the browse sat at a drive root. The choice belongs on the screen the
// folder is picked on (Discord, 2026-10-25), so every Windows browse starts with the drives.
test("every Windows browse lists the drives first, except the drive being browsed", async () => {
  const root = path.parse(process.cwd()).root;
  const drives = async () => [root, "E:\\", "F:\\"];
  const top = await browse(root, false, root, drives);
  assert.equal(top.parent, null);
  assert.deepEqual(top.entries.slice(0, 2), [{ path: "E:\\", name: "E:\\" }, { path: "F:\\", name: "F:\\" }]);
  assert.equal(top.entries.some(e => e.path === root), false);

  const below = await browse(process.cwd(), false, root, drives);
  assert.deepEqual(below.entries.slice(0, 3), [{ path: root, name: root }, { path: "E:\\", name: "E:\\" }, { path: "F:\\", name: "F:\\" }]);
  assert.ok(below.entries.length > 3, "and the folders it holds still follow");
});

test("drives are only looked up on Windows", async () => {
  assert.deepEqual(await windowsDrives("darwin"), []);
  assert.deepEqual(await windowsDrives("linux"), []);
});

test("a path that does not exist is an error, not an empty folder", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browse-missing-"));
  try {
    await assert.rejects(() => browse(path.join(root, "gone"), false, root, async () => []), /ENOENT/);
    await assert.rejects(() => browse(root, false, root, async () => []).then(() => browse(path.join(root, "gone", "deeper"), false, root, async () => [])), /ENOENT/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The folder sheet draws a path field of its own, so a drive or a folder nobody has visited can be
// opened without walking down from C:\ (Discord, 2026-10-25).
test("the folder sheet draws a path field and marks the drives", () => {
  const ui = {
    home: "/Users/pbj",
    now: 0,
    draft: { cwd: "/Users/pbj/code", model: null, effort: null },
    sessions: [],
    sheet: {
      kind: "folder",
      recent: [],
      filter: "",
      loading: false,
      browse: {
        path: "/Users/pbj/code",
        parent: "/Users/pbj",
        home: "/Users/pbj",
        entries: [{ path: "E:\\", name: "E:\\" }, { path: "/Users/pbj/code/app", name: "app" }],
        truncated: false,
      },
    },
  } as unknown as UI;
  const html = drawSheet(ui);
  assert.match(html, /<input id="folder-path" value="\/Users\/pbj\/code"/);
  assert.match(html, /data-act="browse-path"/, "a Go button sends what was typed");
  assert.match(html, /data-path="E:\\"/, "a drive is an entry like any folder");
  assert.match(html, /data-path="E:\\">.*?<rect/, "a drive draws the drive icon, not a folder");

  const typed = drawSheet({ ...ui, sheet: { ...ui.sheet, pathDraft: "D:\\work" } } as unknown as UI);
  assert.match(typed, /<input id="folder-path" value="D:\\work"/, "a half-typed path survives a redraw");
});
