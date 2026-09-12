import test from "node:test";
import assert from "node:assert/strict";
import {
  secondsRemaining,
  canAnswer,
  recommendedOption,
  expiryLabel,
} from "../public/request-state.js";
import * as requestState from "../public/request-state.js";

const now = Date.parse("2026-09-10T12:00:00Z");
const item = {
  expiresAt: "2026-09-10T12:01:42Z",
  hidden: false,
  options: [{ label: "A" }, { label: "B" }],
  recommendedIndex: 1,
};
test("expiry fails closed for old and invalid timestamps", () => {
  assert.equal(secondsRemaining(item, now), 102);
  assert.equal(secondsRemaining(item, now + 103000), 0);
  assert.equal(secondsRemaining({ ...item, expiresAt: "invalid" }, now), 0);
  assert.equal(expiryLabel(item, now), "Expires in 1m 42s");
});
test("answer controls require a live, visible, unexpired request", () => {
  assert.equal(canAnswer(item, true, false, now), true);
  assert.equal(canAnswer(item, false, false, now), false);
  assert.equal(canAnswer(item, true, true, now), false);
  assert.equal(canAnswer({ ...item, hidden: true }, true, false, now), false);
  assert.equal(canAnswer(item, true, false, now + 103000), false);
  assert.equal(canAnswer(null, true, false, now), false);
});
test("recommendations must be valid indices", () => {
  assert.equal(recommendedOption(item), 1);
  for (const recommendedIndex of [-1, 2, 0.5, null, "1"]) {
    assert.equal(recommendedOption({ ...item, recommendedIndex }), null);
  }
});

test("two-question drafts require one answer per question and preserve multi-select choices", () => {
  assert.equal(typeof requestState.initialQuestionAnswers, "function",
    "the question UI needs one draft entry per Claude question");
  const request = { questions: [
    { multiSelect: false, options: [{ label: "Blue" }, { label: "Green" }], recommendedIndexes: [1] },
    { multiSelect: true, options: [{ label: "Test" }, { label: "Stage" }, { label: "Production" }], recommendedIndexes: [] },
  ] };
  const draft = requestState.initialQuestionAnswers(request);
  assert.deepEqual(draft, [
    { optionIndexes: [1], answer: "", open: false },
    { optionIndexes: [], answer: "", open: false },
  ]);
  assert.equal(requestState.questionAnswersComplete(request, draft), false);
  draft[1].optionIndexes = [0, 2];
  assert.equal(requestState.questionAnswersComplete(request, draft), true);
  assert.deepEqual(requestState.questionAnswersVerdict(request, draft), {
    action: "answers",
    answers: [{ optionIndexes: [1] }, { optionIndexes: [0, 2] }],
  });
});
