import { test } from "node:test";
import assert from "node:assert/strict";
import { readUpdateSeen, rememberUpdate, updateNotice, type RouterUpdate, type UpdateSeen } from "../src/update-model.ts";

const empty = (): UpdateSeen => ({ updated: [], available: [] });
const completed: RouterUpdate = { enabled: true, kind: "script", lastUpdatedFrom: "1.0.0", lastUpdatedTo: "1.1.0", lastUpdatedAt: 1000 };

test("confirmed update notifies once and relaunches only an old tray", () => {
  const notice = updateNotice("1.1.0", "1.0.0", completed, empty());
  assert.deepEqual(notice, { kind: "updated", version: "1.1.0", relaunch: true });
  const seen = readUpdateSeen(JSON.parse(JSON.stringify(rememberUpdate(empty(), notice!))));
  assert.equal(updateNotice("1.1.0", "1.0.0", completed, seen), null, "persists across app restart");
  assert.deepEqual(updateNotice("1.1.0", "1.1.0", completed, empty()), { kind: "updated", version: "1.1.0", relaunch: false });
});
test("old routers, pending attempts and stale completion records do not relaunch", () => {
  assert.equal(updateNotice("1.0.0", "1.0.0", undefined, empty()), null);
  assert.equal(updateNotice("1.0.0", "1.0.0", { running: true }, empty()), null);
  assert.equal(updateNotice("1.1.0", "1.0.0", { ...completed, running: true }, empty()), null, "wait for the installer to finish preparing the tray runtime");
  assert.equal(updateNotice("1.2.0", "1.0.0", completed, empty()), null);
  assert.equal(updateNotice("1.1.0", "1.0.0", { lastUpdatedTo: "1.1.0" }, empty()), null);
  assert.equal(updateNotice("1.1.0", "1.0.0", { ...completed, lastUpdatedFrom: "1.1.0" }, empty()), null);
});
for (const kind of ["script", "npm", "packaged", "checkout", "unknown"]) {
  test(`available notice policy for ${kind}`, () => {
    const state: RouterUpdate = { enabled: true, kind, available: "1.1.0" };
    assert.equal(updateNotice("1.0.0", "1.0.0", state, empty())?.kind ?? null, ["script", "npm"].includes(kind) ? null : "available");
    const notice = updateNotice("1.0.0", "1.0.0", { ...state, enabled: false }, empty());
    assert.deepEqual(notice, { kind: "available", version: "1.1.0" });
    const seen = readUpdateSeen(JSON.parse(JSON.stringify(rememberUpdate(empty(), notice!))));
    assert.equal(updateNotice("1.0.0", "1.0.0", { ...state, enabled: false }, seen), null);
    assert.equal(updateNotice("1.0.0", "1.0.0", { ...state, enabled: false, running: true }, empty()), null);
  });
}
test("available and completed notifications have independent version deduplication", () => {
  const seen = rememberUpdate(empty(), { kind: "available", version: "1.1.0" });
  const notice = updateNotice("1.1.0", "1.0.0", completed, seen)!;
  assert.equal(notice.kind, "updated");
  const both = rememberUpdate(seen, notice);
  assert.deepEqual(rememberUpdate(both, notice), both);
  assert.equal(updateNotice("1.1.0", "1.0.0", { enabled: false, available: "1.1.0" }, empty()), null);
});
test("malformed notification history is rejected at the file boundary", () => {
  for (const value of [null, {}, { updated: [1], available: [] }, { updated: [], available: "1.0.0" }]) assert.throws(() => readUpdateSeen(value));
});
