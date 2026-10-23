import test from "node:test";
import assert from "node:assert/strict";
import { approval, bridgeFixture, bridgeId, tick } from "./bridge-fixture.ts";

const input = {
  questions: [
    { question: "Which runner?", header: "Runner", multiSelect: false, options: [
      { label: "node:test", description: "the built-in one" },
      { label: "vitest", description: "the other one" },
    ] },
    { question: "Which files?", header: "Files", multiSelect: true, options: [
      { label: "src", description: "the sources" },
      { label: "tests", description: "the tests" },
    ] },
  ],
};
const question = { type: "control_request", request_id: "q1", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", tool_use_id: "tool-q1", input } };

/** The permission card the phone is shown for the first pending request. */
function shownCard(f: ReturnType<typeof bridgeFixture>) {
  const pending = f.permissions.pending(bridgeId)[0];
  const card = pending && f.sessions.log(bridgeId).tail().events.find(e => e.kind === "permission" && e.id === pending.id);
  return card;
}

test("a Remote Control AskUserQuestion cards as a question, not a JSON tool approval", async t => {
  const f = bridgeFixture(t);
  f.sessions.log(bridgeId);
  await tick(); await tick();
  f.emit(question);
  await tick();
  const card = shownCard(f);
  if (!card || card.kind !== "permission") assert.fail("the request was not carded");
  assert.equal(card.tool, "AskUserQuestion");
  assert.equal(card.requestKind, "question");
  assert.deepEqual(card.questions, input.questions);
});

test("the phone's answers reach the tool input the Remote Control side runs", async t => {
  const f = bridgeFixture(t);
  f.sessions.log(bridgeId);
  await tick(); await tick();
  f.emit(question);
  await tick();
  const pending = f.permissions.pending(bridgeId)[0]!;
  const answers = { "Which runner?": "vitest", "Which files?": "src, tests" };
  assert.equal(await f.sessions.decide(bridgeId, pending.id, "allow", undefined, answers), true);
  const posted = f.posts.at(-1) as { events: { payload: { response: { subtype: string; request_id: string; response: unknown } } }[] };
  const response = posted.events[0]!.payload.response;
  assert.equal(response.subtype, "success");
  assert.equal(response.request_id, "q1");
  assert.deepEqual(response.response, { behavior: "allow", updatedInput: { ...input, answers }, toolUseID: "tool-q1" });
});

test("a bridged question is not allowed without every answer", async t => {
  const f = bridgeFixture(t);
  f.sessions.log(bridgeId);
  await tick(); await tick();
  f.emit(question);
  await tick();
  const pending = f.permissions.pending(bridgeId)[0]!;
  await assert.rejects(async () => f.sessions.decide(bridgeId, pending.id, "allow", undefined, { "Which runner?": "vitest" }), /Answer every question/);
  assert.equal(f.posts.length, 0);
  assert.equal(f.permissions.pending(bridgeId).length, 1);
});
