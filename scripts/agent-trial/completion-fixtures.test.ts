// @vitest-environment node
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { LearningEvidenceProposal, LearningReviewPlanInput } from "../../src/lib/domain/learning-agent-completion";
import { ReferencedGeneratedQuiz } from "../../src/lib/domain/learning-quiz";
import { composedQuizRequest } from "../../src/lib/server/learning/quiz-composition";
import { decodeReviewQuiz } from "../../src/lib/server/learning/quiz-review-purpose";

const require = createRequire(import.meta.url), fixture = require("./offline-completion-fixtures.cjs");
const materialId = "00000000-0000-4000-8000-000000000001";
const quizId = "00000000-0000-4000-8000-000000000002", attemptId = "00000000-0000-4000-8000-000000000003";
const scope = { tool: "learning.read_scope", status: "succeeded", value: { materials: [{ materialId, title: "合成教材 · 集合、交集与并集", paragraphs: [3, 4] }] } };
const sources = [3, 4].map(number => ({ tool: "learning.read_source", status: "succeeded", value: { paragraph: { number } } }));
const input = (mode: string, results: unknown[], completion: Record<string, unknown> = {}) => ({ goal: `[V1.1:${mode}] 合成验收`, observation: { completion }, results, tools: [] });
const plan = (mode: string) => LearningReviewPlanInput.parse(fixture.decision(input(mode, [scope, ...sources])).args);

it("explicit completion markers leave legacy fixtures unselected and empty scope cannot fabricate a plan", () => {
  expect(fixture.marker({ goal: "[A2:note] 原有笔记" })).toBeUndefined();
  expect(fixture.applies({ goal: "原有复习", observation: { completion: { outcome: "legacy" } } })).toBe(false);
  expect(fixture.applies({ goal: "普通复习", observation: { completion: { outcome: "insufficient" } } })).toBe(true);
  expect(fixture.decision({ ...input("check", [scope, ...sources]), goal: "我不理解交集，请解释。" })).toHaveProperty("args.kind", "explanation");
  expect(fixture.decision(input("explanation", [])).tool).toBe("learning.read_scope");
  expect(fixture.decision(input("check", [{ ...scope, value: { materials: [] } }]))).toHaveProperty("wait.kind", "feedback");
  expect(() => fixture.decision(input("check", [{ ...scope, value: { materials: [{ ...scope.value.materials[0], paragraphs: [3] }] } }]))).toThrow("completion_fixture_source_required");
});

it.each(["explanation", "check"])("%s fixture establishes a schema-valid purpose from real scope and passes it to generation", mode => {
  const reviewPlan = plan(mode);
  const next = fixture.decision(input(mode, [scope, ...sources], { plan: reviewPlan }));
  expect(reviewPlan.kind).toBe(mode === "explanation" ? "explanation" : "chapter_check");
  expect(next.tool).toBe(mode === "explanation" ? "learning.explain" : "learning.create_quiz");
  expect(next.args.purpose.objectiveIds).toEqual(reviewPlan.objectives.map(objective => objective.id));
});

it("generic feedback after an explanation remains a wait; only product-validated explicit feedback can auto-stop", () => {
  const payload = input("explanation", [scope, ...sources, { tool: "learning.explain", status: "succeeded", value: { id: "saved" } }], { plan: plan("explanation") });
  expect(fixture.decision({ ...payload, feedback: { kind: "feedback", message: "谢谢" } })).toHaveProperty("tool", "learning.request_feedback");
});

it("evidence proposals use the actual receipt and submitted business question, never injected fixture scores", () => {
  const receipt = { tool: "learning.create_quiz", status: "succeeded", value: { quizId, attemptId, submitted: true } };
  const before = [scope, ...sources, receipt], completion = { plan: plan("check"), objectives: [] };
  expect(fixture.decision(input("check", before, completion))).toMatchObject({ tool: "learning.read_answers", args: { attemptId } });
  const answer = { tool: "learning.read_answers", status: "succeeded", value: { quizId, attemptId, score: { correct: 0, total: 1 }, questions: [{ index: 0, stem: "A∩B 是什么？" }] } };
  const proposal = fixture.decision(input("check", [...before, answer], completion));
  expect(proposal.tool).toBe("learning.associate_evidence");
  expect(LearningEvidenceProposal.parse(proposal.args)).toMatchObject({ ref: { quizId, attemptId, questionIndex: 0 }, objectiveId: "intersection" });
  expect(proposal.args).not.toHaveProperty("correct");
  const associated = { ...completion, objectives: [{ id: "intersection", evidence: [{ ref: proposal.args.ref }] }] };
  expect(fixture.decision(input("check", [...before, answer], associated))).toHaveProperty("finish");
});

it("agent fixture annotations pass the formal composed codec while preserving actual stable candidate identities", () => {
  const paragraphs = [
    "交集 A∩B 包含同时属于 A 和 B 的元素。若 A={1,2,3}，B={3,4}，则 A∩B={3}。",
    "并集 A∪B 包含属于 A 或属于 B 的元素，这里的或允许同时属于二者。若 A={1,2,3}，B={3,4}，则 A∪B={1,2,3,4}。",
  ].map((text, index) => ({ number: index + 3, text, referenceId: `ref_${String(index + 1).padStart(64, "0")}` }));
  const reviewPlan = plan("check"), purpose = fixture.decision(input("check", [scope, ...sources], { plan: reviewPlan })).args.purpose;
  const reviewContext = { planId: "00000000-0000-4000-8000-000000000004", taskVersion: 1, objectives: reviewPlan.objectives, purpose };
  const request = { count: 2, difficulty: "basic" as const, materials: [{ materialId, kind: "text" as const, title: "合成教材", paragraphs }], extras: [] };
  const codecScope = { accountId: "synthetic", pageId: "page", requestId: "request", expiresAt: Date.now() + 10000 };
  const codec = composedQuizRequest(request, codecScope);
  const raw = fixture.quiz({ ...codec.input, taskContext: { ...codec.input.taskContext, reviewContext } });
  const decoded = decodeReviewQuiz(raw, value => codec.decode(value, codecScope), reviewContext);
  const { reviewCandidates: _reviewCandidates, ...officialQuiz } = decoded;
  expect(ReferencedGeneratedQuiz.parse(officialQuiz).items).toHaveLength(2);
  expect(decoded.reviewCandidates?.map(candidate => candidate.check.objectiveIds)).toEqual([["intersection"], ["union"]]);
});

it("known failed actions yield bounded user handoff, with no implicit repeated generation", () => {
  expect(fixture.decision(input("check", [{ tool: "learning.create_quiz", status: "failed", value: {} }]))).toHaveProperty("wait.kind", "feedback");
});
