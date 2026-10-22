// @vitest-environment node
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { LearningReviewPlanInput, LearningEvidenceProposal } from "../../src/lib/domain/learning-agent-completion";
import { composedQuizRequest } from "../../src/lib/server/learning/quiz-composition";
import { inspectQuizCandidateDelivery } from "../../src/lib/server/learning/quiz-grounding";
import { decodeReviewQuiz } from "../../src/lib/server/learning/quiz-review-purpose";
import { ReferencedGeneratedQuiz } from "../../src/lib/domain/learning-quiz";
const require = createRequire(import.meta.url), fixture = require("./offline-natural-quiz-fixtures.cjs");
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const materialId = "00000000-0000-4000-8000-000000000001", pageId = "00000000-0000-4000-8000-000000000002";
const quizId = "00000000-0000-4000-8000-000000000003", attemptId = "00000000-0000-4000-8000-000000000004";
const scope = { tool: "learning.read_scope", status: "succeeded", value: { materials: [{ materialId, title: "合成教材 · 集合、交集与并集", paragraphs: [3, 4] }] } };
const sources = [3, 4].map(number => ({ tool: "learning.read_source", status: "succeeded", value: { paragraph: { number } } }));
const payload = (results: unknown[], plan?: unknown) => ({ goal: "练习交集与并集", tools: [], observation: { completion: { plan, objectives: [] } }, results });
const planFor = (mode: string) => LearningReviewPlanInput.parse(fixture.decision(payload([scope, ...sources]), mode).args);

it("selects synthetic fault cases only through an explicit matching page/material control", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "natural-fixture-")); roots.push(root);
  expect(fixture.configuredCase(root, { tools: [], authorizedScope: { pageId }, goal: "练习交集与并集" })).toBeNull();
  writeFileSync(path.join(root, "offline-natural-quiz.json"), JSON.stringify({ version: 1, cases: [{ pageId, materialId, mode: "partial" }] }));
  expect(fixture.configuredCase(root, { tools: [], authorizedScope: { pageId } }).mode).toBe("partial");
  expect(fixture.configuredCase(root, { tools: [], authorizedScope: { pageId: "another" } })).toBeNull();
  expect(fixture.configuredCase(root, { taskContext: { reviewContext: { objectives: [{ sources: [{ materialId }] }] } }, materials: [{ material: 1 }] }).mode).toBe("partial");
  expect(fixture.configuredCase(root, { materials: [{ materialId: "another" }] })).toBeNull();
});

it.each(["partial", "all_failed", "zero_repair", "repeat_explanation", "multi_round", "diagnostic_rounds"])("%s fixture uses scope and current source results to create a strict plan", mode => {
  expect(fixture.decision(payload([]), mode).tool).toBe("learning.read_scope");
  expect(fixture.decision(payload([scope]), mode).tool).toBe("learning.read_source");
  const plan = planFor(mode);
  expect(plan.kind).toBe(mode === "repeat_explanation" ? "explanation" : mode === "multi_round" ? "targeted_review" : "diagnosis");
  const next = fixture.decision(payload([scope, ...sources], plan), mode);
  expect(next.tool).toBe(mode === "repeat_explanation" ? "learning.explain" : "learning.create_quiz");
  expect(next.args.purpose.objectiveIds).toEqual([["multi_round", "diagnostic_rounds"].includes(mode) ? "membership" : "intersection"]);
});

it("multi-round controlled choices branch on saved first answers and preserve the same followup requirement", () => {
  const plan = planFor("multi_round");
  const ref = { quizId, attemptId, questionIndex: 0 };
  const receipt = { tool: "learning.create_quiz", status: "succeeded", value: { quizId, attemptId, submitted: true } };
  const answer = (correct: number) => ({ tool: "learning.read_answers", status: "succeeded", value: { quizId, attemptId, score: { correct, total: 1 }, questions: [{ index: 0 }] } });
  const make = (correct: number, associated = false) => ({ ...payload([scope, ...sources, receipt, answer(correct), ...(associated ? [{ tool: "learning.associate_evidence", status: "succeeded", value: {} }] : [])], plan),
    observation: { completion: { plan, objectives: [{ id: "membership", evidence: associated ? [{ ref }] : [] }] } } });
  const first = fixture.decision(make(0), "multi_round");
  expect(LearningEvidenceProposal.parse(first.args)).toMatchObject({ ref, role: "followup", relation: "initial", priorEvidenceRefs: [] });
  expect(fixture.decision(make(0, true), "multi_round")).toMatchObject({ tool: "learning.explain", args: { purpose: { role: "followup", method: "contrast", priorEvidenceRefs: [ref] } } });
  expect(fixture.decision(make(1, true), "multi_round").tool).toBe("learning.request_feedback");
  const afterExplanation = make(0, true);
  afterExplanation.results.push({ tool: "learning.explain", status: "succeeded", value: {} });
  expect(fixture.decision(afterExplanation, "multi_round").tool).toBe("learning.request_feedback");
  expect(fixture.decision({ ...afterExplanation, feedback: { kind: "feedback", message: "我明白了，再出题试试。" } }, "multi_round")).toMatchObject({ tool: "learning.create_quiz", args: { count: 1, purpose: { role: "boundary", priorEvidenceRefs: [ref] } } });
  expect(plan.objectives[0].requirements.map((requirement: { role: string }) => requirement.role)).toEqual(["followup", "boundary"]);
});


it("explicit two-question preference keeps fixed P2/P3/P4 sources and exercises only that generation catalog", () => {
  const withDefinition = [...sources, { tool: "learning.read_source", status: "succeeded", value: { paragraph: { number: 2 } } }];
  const plan = LearningReviewPlanInput.parse(fixture.decision(payload([scope, ...withDefinition]), "source_contract").args);
  expect(plan.objectives[0].sources.map(source => source.paragraph)).toEqual([2, 3, 4]);
  expect(fixture.decision(payload([scope, ...withDefinition], plan), "source_contract")).toMatchObject({ tool: "learning.create_quiz", args: { count: 2, purpose: { role: "concept" } } });
});

it("successful actual submission must be read before the fixture proposes evidence", () => {
  const plan = planFor("partial"), before = [scope, ...sources, { tool: "learning.create_quiz", status: "succeeded", value: { quizId, attemptId, submitted: true } }];
  expect(fixture.decision(payload(before, plan), "partial")).toMatchObject({ tool: "learning.read_answers", args: { attemptId } });
  const proposal = fixture.decision(payload([...before, { tool: "learning.read_answers", status: "succeeded", value: { quizId, attemptId, score: { correct: 0, total: 1 }, questions: [{ index: 0 }] } }], plan), "partial");
  expect(LearningEvidenceProposal.parse(proposal.args)).toMatchObject({ ref: { quizId, attemptId, questionIndex: 0 }, relation: "initial" });
  expect(proposal.args).not.toHaveProperty("correct");
});

it("known zero-publication failure changes to explanation then feedback, never blindly retries", () => {
  const plan = planFor("all_failed"), failed = { tool: "learning.create_quiz", status: "failed", value: null };
  expect(fixture.decision(payload([scope, ...sources, failed], plan), "all_failed").tool).toBe("learning.explain");
  expect(fixture.decision(payload([scope, ...sources, failed, { tool: "learning.explain", status: "succeeded", value: {} }], plan), "all_failed").tool).toBe("learning.request_feedback");
});

it("the bounded-repair fixture asks again only after actual failed generation, explanation and explicit feedback, preserving the fixed purpose", () => {
  const plan = planFor("zero_repair");
  const start = fixture.decision(payload([scope, ...sources], plan), "zero_repair");
  const failed = { tool: "learning.create_quiz", status: "failed", value: null };
  const explaining = payload([scope, ...sources, failed], plan);
  expect(fixture.decision(explaining, "zero_repair").tool).toBe("learning.explain");
  const explained = payload([...explaining.results, { tool: "learning.explain", status: "succeeded", value: {} }], plan);
  expect(fixture.decision(explained, "zero_repair").tool).toBe("learning.request_feedback");
  const retry = fixture.decision({ ...explained, feedback: { kind: "feedback", message: "讲解明白了，想做题确认一下。" } }, "zero_repair");
  expect(retry.tool).toBe("learning.create_quiz");
  expect(retry.args).toEqual(start.args);
  const repaired = { tool: "learning.create_quiz", status: "succeeded", value: { quizId, attemptId, submitted: true } };
  expect(fixture.decision(payload([...explained.results, repaired], plan), "zero_repair")).toMatchObject({ tool: "learning.read_answers", args: { attemptId } });
});

it("the bounded repair returns a valid candidate only when the service supplies its original rejection and purpose", () => {
  const plan = planFor("zero_repair"), purpose = fixture.decision(payload([scope, ...sources], plan), "zero_repair").args.purpose;
  const context = { planId: quizId, taskVersion: 1, objectives: plan.objectives, purpose };
  const paragraphs = [{ number: 3, text: "交集 A∩B 包含同时属于 A 和 B 的元素。若 A={1,2,3}，B={3,4}，则 A∩B={3}。", referenceId: `ref_${"1".repeat(64)}` }];
  const request = { count: 3, difficulty: "basic" as const, materials: [{ materialId, kind: "text" as const, title: "合成教材", paragraphs }], extras: [] };
  const codecScope = { accountId: "synthetic", pageId, requestId: quizId, expiresAt: Date.now() + 10000 };
  const codec = composedQuizRequest(request, codecScope);
  const wire = { ...codec.input, taskContext: { ...codec.input.taskContext, reviewContext: context } };
  const initial = fixture.quiz(wire, "zero_repair");
  const catalog = paragraphs.map(paragraph => ({ referenceId: paragraph.referenceId, source: { kind: "material" as const, materialId, paragraph: paragraph.number }, text: paragraph.text }));
  const initialDecoded = decodeReviewQuiz(initial, value => codec.decode(value, codecScope), context, catalog);
  const rejected = inspectQuizCandidateDelivery(initialDecoded, catalog);
  expect(rejected.candidates).toBe(3); expect(rejected.rejected).toHaveLength(3);
  const repaired = { ...wire, taskContext: { ...wire.taskContext, repairContext: {
    attempt: 1, previousQuizId: quizId, purpose, rejected: [{ code: "equivalent_options", count: 1 }, { code: "position_dependency", count: 1 }, { code: "repeated_focus", count: 1 }],
  } } };
  const raw = fixture.quiz(repaired, "zero_repair");
  const repairScope = { ...codecScope, requestId: "00000000-0000-4000-8000-000000000005" };
  const repairCodec = composedQuizRequest(request, repairScope);
  const decoded = decodeReviewQuiz(raw, value => repairCodec.decode(value, repairScope), context, catalog);
  expect(raw.items).toHaveLength(1);
  expect(inspectQuizCandidateDelivery(decoded, catalog)).toMatchObject({ candidates: 1, rejected: [] });
  expect(decoded.reviewCandidates?.[0].check).toMatchObject({ objectiveIds: purpose.objectiveIds, role: purpose.role });
  expect(() => fixture.quiz({ ...repaired, taskContext: { ...repaired.taskContext, repairContext: { ...repaired.taskContext.repairContext, rejected: [] } } }, "zero_repair"))
    .toThrow("zero_repair_actual_rejection_required");
});

it("repeat-explanation fault intentionally repeats before feedback but a generic thanks never claims resolution", () => {
  const plan = planFor("repeat_explanation"), input = payload([scope, ...sources, { tool: "learning.explain", status: "succeeded", value: {} }], plan);
  expect(fixture.decision(input, "repeat_explanation").tool).toBe("learning.explain");
  expect(fixture.decision({ ...input, feedback: { kind: "feedback", message: "谢谢" } }, "repeat_explanation").tool).toBe("learning.request_feedback");
});

it.each(["partial", "all_failed"])("%s candidate fixture retains exact bad content for official publication fences", mode => {
  const plan = planFor(mode), purpose = fixture.decision(payload([scope, ...sources], plan), mode).args.purpose;
  const reviewContext = { planId: quizId, taskVersion: 1, objectives: plan.objectives, purpose };
  const paragraphs = [
    "交集 A∩B 包含同时属于 A 和 B 的元素。若 A={1,2,3}，B={3,4}，则 A∩B={3}。",
    "并集 A∪B 包含属于 A 或属于 B 的元素，这里的或允许同时属于二者。若 A={1,2,3}，B={3,4}，则 A∪B={1,2,3,4}。",
  ].map((text, index) => ({ number: index + 3, text, referenceId: `ref_${String(index + 1).padStart(64, "0")}` }));
  const request = { count: 3, difficulty: "basic" as const, materials: [{ materialId, kind: "text" as const, title: "合成教材", paragraphs }], extras: [] };
  const codecScope = { accountId: "synthetic", pageId, requestId: quizId, expiresAt: Date.now() + 10000 };
  const codec = composedQuizRequest(request, codecScope);
  const raw = fixture.quiz({ ...codec.input, taskContext: { ...codec.input.taskContext, reviewContext } }, mode);
  expect(raw.items).toHaveLength(3);
  expect(raw.items[0].options[0].text).toBe("∅");
  expect(raw.items[0].options[1].text).toBe("{}");
  expect(raw.items.some((item: { stem: string }) => item.stem.includes("正确答案是第3项"))).toBe(true);
  const result = decodeReviewQuiz(raw, value => codec.decode(value, codecScope), reviewContext, paragraphs.map(paragraph => ({ referenceId: paragraph.referenceId, source: { kind: "material", materialId, paragraph: paragraph.number } })));
  expect(result.reviewCandidates).toHaveLength(mode === "partial" ? 2 : 1);
  expect(result.reviewCandidates?.every(candidate => candidate.check.role === purpose.role && candidate.check.objectiveIds.includes("intersection"))).toBe(true);
  // Composition removes the positional item (and exact repeated focus in the
  // all-failed fixture); publication later rejects equivalent options.
  // Decoded slots are not relabelled as published questions.
  expect(result.items.filter(item => ReferencedGeneratedQuiz.shape.items.element.safeParse(item).success).length).toBe(mode === "partial" ? 2 : 1);
  expect(result.items).toContainEqual({ compositionRejected: true, rejectionReason: "position_dependency" });
  if (mode === "all_failed") expect(result.items).toContainEqual({ compositionRejected: true, rejectionReason: "repeated_focus" });
});

it("the second controlled Quiz carries the actual boundary contract without relabeling it as followup", () => {
  const plan = planFor("multi_round");
  const purpose = { objectiveIds: ["membership"], role: "boundary" as const, method: "boundary" as const,
    purpose: "检查只属于一个集合时交集与并集的条件边界", priorEvidenceRefs: [{ quizId, attemptId, questionIndex: 0 }] };
  const context = { planId: quizId, taskVersion: 1, objectives: plan.objectives, purpose };
  const paragraphs = [
    "交集 A∩B 包含同时属于 A 和 B 的元素。若 A={1,2,3}，B={3,4}，则 A∩B={3}。",
    "并集 A∪B 包含属于 A 或属于 B 的元素，这里的或允许同时属于二者。若 A={1,2,3}，B={3,4}，则 A∪B={1,2,3,4}。",
  ].map((text, i) => ({ number: i + 3, text, referenceId: `ref_${String(i + 1).padStart(64, "0")}` }));
  const request = { count: 1, difficulty: "basic" as const, materials: [{ materialId, kind: "text" as const, title: "合成教材", paragraphs }], extras: [] };
  const scope = { accountId: "synthetic", pageId, requestId: quizId, expiresAt: Date.now() + 10000 };
  const codec = composedQuizRequest(request, scope);
  const raw = fixture.quiz({ ...codec.input, taskContext: { ...codec.input.taskContext, reviewContext: context } }, "multi_round");
  const result = decodeReviewQuiz(raw, value => codec.decode(value, scope), context,
    paragraphs.map(paragraph => ({ referenceId: paragraph.referenceId, source: { kind: "material", materialId, paragraph: paragraph.number } })));
  expect(result.reviewCandidates).toHaveLength(1);
  expect(result.reviewCandidates?.[0].check).toMatchObject({ objectiveIds: ["membership"], role: "boundary" });
  expect(ReferencedGeneratedQuiz.shape.items.element.safeParse(result.items[0]).success).toBe(true);
  expect(plan.objectives[0].requirements.map((requirement: { role: string }) => requirement.role)).toEqual(["followup", "boundary"]);
});


it("two-round G3 fixture fixes observable diagnosis requirements before the first two-candidate request", () => {
  const plan = planFor("diagnostic_rounds");
  expect(plan.kind).toBe("diagnosis");
  expect(plan.objectives[0].requirements.map((requirement: { role: string }) => requirement.role)).toEqual(["concept", "boundary"]);
  expect(fixture.decision(payload([scope, ...sources], plan), "diagnostic_rounds")).toMatchObject({ tool: "learning.create_quiz", args: { count: 2, purpose: { role: "concept", objectiveIds: ["membership"] } } });
});


it("the separate G3 browser fixture retains its mathematical pair and rejects only the duplicated Chinese-name set", () => {
  const plan = planFor("diagnostic_rounds");
  const purpose = fixture.decision(payload([scope, ...sources], plan), "diagnostic_rounds").args.purpose;
  const context = { planId: quizId, taskVersion: 1, objectives: plan.objectives, purpose };
  const paragraphs = [
    "交集 A∩B 包含同时属于 A 和 B 的元素。若 A={1,2,3}，B={3,4}，则 A∩B={3}。",
    "并集 A∪B 包含属于 A 或属于 B 的元素，这里的或允许同时属于二者。",
  ].map((text, i) => ({ number: i + 3, text, referenceId: `ref_${String(i + 1).padStart(64, "0")}` }));
  const request = { count: 2, difficulty: "basic" as const, materials: [{ materialId, kind: "text" as const, title: "合成教材", paragraphs }], extras: [] };
  const codecScope = { accountId: "synthetic", pageId, requestId: quizId, expiresAt: Date.now() + 10000 };
  const codec = composedQuizRequest(request, codecScope);
  const raw = fixture.quiz({ ...codec.input, taskContext: { ...codec.input.taskContext, reviewContext: context } }, "diagnostic_rounds");
  expect(raw.items[0].options[0].reasonParts[0].text).toBe("A和B都包含3，其他元素没有共同归属，因此交集只有3。");
  expect(raw.items[1].options.map((option: { text: string }) => option.text)).toEqual(["{红,蓝}", "{蓝,红,蓝}", "{绿}"]);
  const catalog = paragraphs.map(paragraph => ({ referenceId: paragraph.referenceId, source: { kind: "material" as const, materialId, paragraph: paragraph.number }, text: paragraph.text }));
  const result = decodeReviewQuiz(raw, value => codec.decode(value, codecScope), context, catalog);
  expect(inspectQuizCandidateDelivery(result, catalog)).toMatchObject({ candidates: 2, rejected: [{ index: 1, code: "equivalent_options" }] });
});
