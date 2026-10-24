import test from "node:test";
import assert from "node:assert/strict";
import { approval, bridgeFixture, bridgeId, tick } from "./bridge-fixture.ts";
import { summarize } from "../src/sessions.ts";
import { pushContent } from "../src/push-content.ts";

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
  assert.equal(card.summary, 'Which runner?');
  f.history.push({ source: 'worker', payload: question });
  const context = await f.sessions.pushContext(bridgeId, { kind: 'permission' });
  assert.equal(context.tool, 'AskUserQuestion');
  assert.equal(context.summary, 'Which runner?');
  assert.equal(pushContent({ kind: 'permission' }, 'ko', context, '').body, '답변이 필요합니다 · Which runner?');
  for (const lang of ['ko', 'en'] as const) {
    assert.equal(pushContent(card, lang, {}, '').body, `${lang === 'ko' ? '답변이 필요합니다' : 'Answer needed'} · Which runner?`);
  }
});

test('special tool summaries never serialize metadata, options or permission schemas', () => {
  assert.equal(summarize('AskUserQuestion', { metadata: { source: 'modhotreload' }, ...input }, ''), 'Which runner?');
  assert.equal(summarize('AskUserQuestion', { questions: [] }, ''), '');
  assert.equal(summarize('ExitPlanMode', { allowedPrompts: [{ tool: 'Bash', prompt: 'npm test' }], plan: '# Ship the fix\n\nDetails' }, ''), '# Ship the fix');
  assert.equal(summarize('ExitPlanMode', { allowedPrompts: [] }, ''), '');
  assert.equal(summarize('EnterPlanMode', { metadata: { source: 'modhotreload' } }, ''), '');
});

test('permission alerts and card events use localized question and plan copy within the push limit', () => {
  for (const lang of ['ko', 'en'] as const) {
    const context = { tool: 'AskUserQuestion', summary: 'Which runner?' };
    assert.equal(pushContent({ kind: 'permission' }, lang, context, '').body, `${lang === 'ko' ? '답변이 필요합니다' : 'Answer needed'} · Which runner?`);
    assert.equal(pushContent({ kind: 'permission' }, lang, { tool: 'AskUserQuestion', summary: '' }, '').body, lang === 'ko' ? '답변이 필요합니다' : 'Answer needed');
    assert.equal(pushContent({ kind: 'permission' }, lang, { tool: 'ExitPlanMode', summary: '' }, '').body, lang === 'ko' ? '계획 검토가 필요합니다' : 'Plan review needed');
    const long = pushContent({ kind: 'permission' }, lang, { tool: 'AskUserQuestion', summary: '질문😀'.repeat(100) }, '');
    assert.equal(Array.from(long.body).length, 180);
    assert.ok(!long.body.includes('�'));
  }
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
