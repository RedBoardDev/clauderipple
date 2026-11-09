import test from "node:test";
import assert from "node:assert/strict";
import { bridgeFixture, bridgeId, tick } from "./bridge-fixture.ts";

const plan = { type: "control_request", request_id: "plan-1", request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", tool_use_id: "tool-plan", input: { plan: "# Plan\nImplement it" } } };

test("a Remote Control plan cards as a plan and its feedback is the denial", async t => {
  const f = bridgeFixture(t);
  f.sessions.log(bridgeId);
  await tick(); await tick();
  f.emit(plan);
  await tick();
  const pending = f.permissions.pending(bridgeId)[0]!;
  const card = f.sessions.log(bridgeId).tail().events.find(e => e.kind === "permission" && e.id === pending.id);
  if (!card || card.kind !== "permission") assert.fail("the request was not carded");
  assert.equal(card.requestKind, "plan");
  assert.equal(await f.sessions.decide(bridgeId, pending.id, "deny", "Use two tests instead."), true);
  const posted = f.posts.at(-1) as { events: { payload: { response: { response: { behavior: string; message?: string } } } }[] };
  assert.equal(posted.events[0]!.payload.response.response.behavior, "deny");
  assert.equal(posted.events[0]!.payload.response.response.message, "Use two tests instead.");
});
