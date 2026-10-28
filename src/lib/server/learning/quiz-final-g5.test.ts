// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import fixture from "./testing/final-g5-3c34ced.fixture.json";
import { replayFinalG5Publication } from "./testing/final-g5-3c34ced-replay";
import { inspectQuizOptionExplanation } from "./quiz-grounding";
import { inspectLiteralSetMembership } from "./quiz-set-membership";

let directory: string;
let result: Awaited<ReturnType<typeof replayFinalG5Publication>>;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "final-g5-publication-"));
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Real Provider prohibited"); }));
  result = await replayFinalG5Publication(directory);
});
afterAll(async () => { vi.unstubAllGlobals(); if (directory) await rm(directory, { recursive: true, force: true }); });

it.each([0, 1, 2, 3])("replays unchanged original G5 candidate index %i through codec and publication", index => {
  expect(result.matrix[index]).toMatchObject({ index, composition: index < 3 ? "accepted" : "answer_not_unique",
    publication: index < 3 ? "published" : "answer_not_unique", savedIndex: index < 3 ? index : null });
});
it("keeps three actual questions, stable-ID grades and objectives; rejected question has no student evidence", () => {
  expect(result.score).toMatchObject({ correct: 3, total: 3 });
  expect(result.readAnswerIndexes).toEqual([0, 1, 2]);
  expect(result.objectiveAssessment.objectives[0].evidence.map(e => e.ref.questionIndex)).toEqual([0, 1, 2]);
  expect(result.rejectedQuestionSubmission).toContain("zero events");
  expect(result.rejectedQuestionEvidence).toContain("zero proposals");
  expect(result).toMatchObject({ originalInputUnchanged: true, duplicateSubmit: "PASS", restart: "PASS", dispute: "PASS", sqliteIntegrity: "ok", realProviderCalls: 0 });
  expect(fetch).not.toHaveBeenCalled();
});
it("retains exact failed candidate diagnostics and partial delivery from one offline generation", () => {
  expect(result.generation).toEqual({ published: 3, offlineResponses: 1, semanticReviewResponses: 1, issues: [{ index: 3, stage: "composition", code: "answer_not_unique" }] });
});

const question = fixture.decoded.items[3], fullStem = `${question.scenario}\n${question.stem}`;
it("finds both A and D from unchanged finite declarations independently of self-rejecting prose", () => {
  expect(inspectLiteralSetMembership(fullStem, question.options, question.correctOptionId)).toEqual({ status: "invalid", code: "multiple_answers", matchingOptionIds: ["A", "D"] });
});
it.each([
  ["该选项与 A 会出现多解，因此本题不能采用这个选项组合。", "answer_not_unique"],
  ["本题存在多个正确答案。", "answer_not_unique"],
  ["本题的答案不唯一。", "answer_not_unique"],
  ["如果选项重复，本题会出现多解。", null],
  ["本题不会出现多解。", null],
  ["方程存在多解，但本题只问解的个数。", null],
  ["该选项错误地认为交集有多个元素。", null],
] as const)("synthetic contrast: current-question admission versus ordinary discussion: %s", (text, expected) => {
  expect(inspectQuizOptionExplanation(text, question.options, question.correctOptionId, fullStem).issue).toBe(expected);
});
it("synthetic: preserves unique positive membership and detects an incorrect stable answer ID", () => {
  const first = fixture.decoded.items[0];
  expect(inspectLiteralSetMembership(`${first.scenario}\n${first.stem}`, first.options, first.correctOptionId)).toMatchObject({ status: "consistent", matchingOptionIds: ["A"] });
  expect(inspectLiteralSetMembership(`${first.scenario}\n${first.stem}`, first.options, "B")).toMatchObject({ status: "invalid", code: "incorrect_answer", matchingOptionIds: ["A"] });
});
it.each([
  `字符串逐字比较：${fullStem}`,
  `${fullStem}请另外判断数量是否相同。`,
  fullStem.replace("P∩Q", "P∩R"),
  fullStem.replace("{2,5,7,9}", "{x|x>0}"),
])("synthetic: does not infer unsupported membership context: %s", stem => {
  expect(inspectLiteralSetMembership(stem, question.options, "A")).toEqual({ status: "not_applicable" });
});
