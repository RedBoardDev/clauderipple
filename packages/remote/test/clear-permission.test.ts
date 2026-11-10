import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setImmediate as tick } from "node:timers/promises";
import { bridgeFixture, bridgeId, line, approval } from "./bridge-fixture.ts";

async function flush() { for (let i = 0; i < 10; i++) await tick(); }

// /clear and /new used the mode a desktop session was imported with, so a later switch in the
// app to plan was lost and the fresh session came back as bypassPermissions.
for (const command of ["/clear", "/new"]) {
  for (const [initial, mode] of [["default", "plan"], ["default", "bypassPermissions"], ["bypassPermissions", "plan"]] as const) {
    test(`${command} keeps the desktop mode chosen after import: ${initial} -> ${mode}`, async t => {
      const f = bridgeFixture(t, { watchTranscript: () => null });
      fs.appendFileSync(f.file, line({ type: "user", uuid: "initial-mode", cwd: f.root, permissionMode: initial, message: { content: "Initial explicit choice" } }));
      f.sessions.log(bridgeId);
      await flush();
      fs.appendFileSync(f.file, line({ type: "user", uuid: "new-desktop-choice", cwd: f.root, permissionMode: mode, message: { content: "Continue in this mode" } }));
      f.advance();
      await f.sessions.pollDesktop();
      assert.equal(f.sessions.summaryOf(bridgeId)?.permissionMode, mode);
      const fresh = await f.sessions.send(bridgeId, `fresh-${initial}-${mode}`, command);
      assert.equal(f.sessions.summaryOf(fresh)?.permissionMode, mode);
    });
  }
}

test("a half-written transcript line is neither duplicated nor blocks a question card", async t => {
  const f = bridgeFixture(t, { watchTranscript: () => null });
  f.sessions.log(bridgeId);
  await flush();
  const full = line({ type: "assistant", uuid: "half-written", message: { model: "test", content: [{ type: "text", text: "paragraph" }] } });
  const split = Math.floor(full.length / 2);
  fs.appendFileSync(f.file, full.slice(0, split));
  f.emit(approval("first"));
  await flush();
  assert.equal(f.permissions.pending(bridgeId).length, 1);
  fs.appendFileSync(f.file, full.slice(split));
  f.emit(approval("second"));
  await flush();
  await f.sessions.pollDesktop();
  const events = f.sessions.log(bridgeId).readAfter(0).events;
  assert.equal(events.filter(e => e.kind === "assistant" && e.text === "paragraph").length, 1);
  assert.equal(f.permissions.pending(bridgeId).length, 2);
});
