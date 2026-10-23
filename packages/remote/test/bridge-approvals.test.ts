import test from "node:test";
import assert from "node:assert/strict";
import { approval, bridgeFixture, bridgeId, tick } from "./bridge-fixture.ts";

test("a card whose request left the Remote Control list closes, and a replay does not revive it", async t => {
  const f = bridgeFixture(t);
  f.sessions.log(bridgeId);
  await tick(); await tick();
  f.emit(approval("req-gone"));
  await tick();
  const pending = f.permissions.pending(bridgeId)[0]!;
  // The person answered in the desktop app: the stored events hold the request and its response,
  // so the bridge no longer lists the request as open.
  f.history.push({ source: "worker", payload: approval("req-gone") }, { source: "worker", payload: { type: "control_response", request_id: "req-gone", response: { subtype: "success" } } });
  f.advance();
  await f.sessions.syncBridge(bridgeId);
  assert.equal(f.permissions.pending(bridgeId).length, 0);
  const decided = f.sessions.log(bridgeId).tail().events.filter(e => e.kind === "permission_decided" && e.id === pending.id);
  assert.equal(decided.length, 1);
  const decision = decided[0]!;
  if (decision.kind !== "permission_decided") assert.fail("no decision event");
  assert.equal(decision.decision, "expired");
  // A stored list that still shows the request open (the server lagging) does not card it again.
  f.history.pop();
  await f.sessions.syncBridge(bridgeId);
  assert.equal(f.permissions.pending(bridgeId).length, 0);
  assert.equal(f.sessions.log(bridgeId).tail().events.filter(e => e.kind === "permission").length, 1);
});

test("a card whose request is merely missing from the Remote Control list stays open", async t => {
  const f = bridgeFixture(t);
  f.sessions.log(bridgeId);
  await tick(); await tick();
  f.emit(approval("req-live"));
  await tick();
  // The stored list does not reach this request (it holds only older events): no answer was seen,
  // so the question is still the person's to answer from the phone.
  f.history.push({ source: "worker", payload: approval("req-older") }, { source: "worker", payload: { type: "control_response", request_id: "req-older", response: { subtype: "success" } } });
  f.advance();
  await f.sessions.syncBridge(bridgeId);
  assert.deepEqual(f.permissions.pending(bridgeId).length, 1);
});

test("an answered request stays answered when a replay lists it hours later", async t => {
  const f = bridgeFixture(t);
  f.sessions.log(bridgeId);
  await tick(); await tick();
  f.emit(approval("req-answered"));
  await tick();
  const pending = f.permissions.pending(bridgeId)[0]!;
  assert.equal(await f.sessions.decide(bridgeId, pending.id, "allow"), true);
  // The Remote Control side still lists the request as open (its stored events never got the answer).
  f.history.push({ source: "worker", payload: approval("req-answered") });
  f.setNow(f.now() + 2 * 60 * 60 * 1000);
  await f.sessions.syncBridge(bridgeId);
  assert.equal(f.permissions.pending(bridgeId).length, 0);
  assert.equal(f.sessions.log(bridgeId).tail().events.filter(e => e.kind === "permission").length, 1);
});
