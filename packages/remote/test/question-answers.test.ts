import test from "node:test";
import assert from "node:assert/strict";
import { emptyQuestionDraft, freeAnswer, questionAnswers, questionsComplete, toggleOption } from "../web/question-answers.ts";
import type { Question } from "../src/protocol.ts";

const single: Question = { question: "첫 질문?", header: "첫째", multiSelect: false, options: [{ label: "A", description: "A preview" }, { label: "B", description: "B preview" }] };
const multiple: Question = { question: "둘째 질문?", header: "둘째", multiSelect: true, options: [{ label: "X", description: "X preview" }, { label: "Y", description: "Y preview" }] };

test("all questions must be answered and a single choice is exclusive with free input", () => {
  let draft = emptyQuestionDraft();
  assert.equal(questionsComplete([], draft), false);
  assert.equal(questionsComplete([single, multiple], draft), false);
  draft = toggleOption(draft, single, 0);
  assert.equal(questionsComplete([single, multiple], draft), false);
  draft = toggleOption(draft, single, 1);
  assert.deepEqual(draft.selected[single.question], ["B"]);
  draft = freeAnswer(draft, single, "  원문\n둘째 줄  ");
  assert.deepEqual(draft.selected[single.question], []);
  assert.equal(questionAnswers([single], draft)[single.question], "  원문\n둘째 줄  ");
  draft = toggleOption(draft, single, 0);
  assert.equal(draft.free[single.question], "");
  assert.equal(questionAnswers([single], draft)[single.question], "A");
  assert.equal(toggleOption(draft, single, 99), draft);
});

test("multiple selections coexist with exact free input and retain the SDK string-answer contract", () => {
  let draft = toggleOption(emptyQuestionDraft(), single, 0);
  draft = toggleOption(draft, multiple, 0);
  draft = toggleOption(draft, multiple, 1);
  draft = freeAnswer(draft, multiple, "직접 입력\n둘째 줄");
  assert.equal(questionsComplete([single, multiple], draft), true);
  assert.deepEqual(questionAnswers([single, multiple], draft), { "첫 질문?": "A", "둘째 질문?": "X, Y, 직접 입력\n둘째 줄" });
  draft = toggleOption(draft, multiple, 0);
  assert.equal(questionAnswers([multiple], draft)[multiple.question], "Y, 직접 입력\n둘째 줄");
  assert.equal(questionAnswers([{ ...multiple, options: [] }], { ...draft, free: {} })[multiple.question], "", "removed options must not satisfy a changed question");
});
