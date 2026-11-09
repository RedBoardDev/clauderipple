import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { bridgeFixture, bridgeId, line, tick } from "./bridge-fixture.ts";
import { Notifier } from "../src/push.ts";
import type { EventBody } from "../src/protocol.ts";

test("a Mac rename reaches the session list and the next push", async t => {
  const f = bridgeFixture(t);
  f.sessions.log(bridgeId);
  await tick(); await tick();
  assert.equal(f.sessions.summaryOf(bridgeId)?.title, "old prompt");

  // The rename on the Mac lands in the transcript as a custom-title line (read-only).
  fs.appendFileSync(f.file, line({ type: "custom-title", customTitle: "New Name" }));
  await f.sessions.pollDesktop();

  assert.equal(f.sessions.summaryOf(bridgeId)?.title, "New Name");
  assert.equal(f.sessions.list().find(s => s.id === bridgeId)?.title, "New Name");

  const sent: { payload: string }[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rename-push-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const notifier = new Notifier({
    dir,
    send: async (_sub, payload) => { sent.push({ payload }); },
    seenRecently: () => false,
    summary: (sid) => f.sessions.summaryOf(sid),
  });
  const event: EventBody = { kind: "permission", id: "p", tool: "Bash", title: "", summary: "ls", input: "ls", canAlways: false };
  notifier.subscribe("phone-1", { endpoint: "https://push.example.com/push", keys: { p256dh: "x", auth: "y" } }, "en");
  await notifier.onEvent(bridgeId, event);
  assert.equal(sent.length, 1);
  assert.equal((JSON.parse(sent[0]!.payload) as { title: string }).title, "New Name");

  const before = fs.readFileSync(f.file, "utf8");
  const fresh = await f.sessions.send(bridgeId, "clear-renamed", "/clear");
  assert.notEqual(fresh, bridgeId);
  assert.equal(f.sessions.summaryOf(fresh)?.title, "New Name");
  assert.equal(f.sessions.summaryOf(fresh)?.state, "idle");
  assert.equal(f.sessions.log(fresh).tail().events.some(e => e.kind === "user"), false);
  assert.equal(fs.readFileSync(f.file, "utf8"), before, "a phone clear never changes the original desktop transcript");
  assert.equal(f.posts.length, 0, "no clear command is sent to the user's desktop worker");
});
