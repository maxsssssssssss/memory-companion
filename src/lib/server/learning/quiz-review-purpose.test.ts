import { offlineQuizSemanticResponse } from "./testing/quiz-semantic-fixture";
// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LearningError, LearningRepository } from "./repository";
import { LearningQuizRepository } from "./quiz-repository";
import { generateLearningQuiz } from "./quiz-service";
import type { generateStudyJson } from "./framework-generator";
import { decodeReviewQuiz, quizReviewQuestionKey, type QuizReviewContext } from "./quiz-review-purpose";
import { ReferencedQuizEnvelope } from "@/lib/domain/learning-quiz";
import { composedQuizRequest } from "./quiz-composition";
import type { QuizCandidateIssue } from "./quiz-candidate-diagnostics";
import type { SavedQuiz } from "@/lib/domain/learning-quiz";

let root: string, learning: LearningRepository, quiz: LearningQuizRepository, page: string, material: string;
const config = { baseURL: "https://synthetic.invalid", apiKey: "SYNTHETIC", model: "synthetic-model", maxInputChars: 48000, maxOutputTokens: 16000 };
const settings = (count = 3) => ({ materialIds: [material], chapterIds: [], nodeIds: [], includeNotes: false, includeSupplements: false, count, difficulty: "standard" as const });
const context = (): QuizReviewContext => ({ planId: randomUUID(), taskVersion: 2,
  objectives: ["definition", "condition", "boundary"].map(id => ({ id, label: `[合成] ${id}`, sources: [{ materialId: material, paragraph: 1 }],
    requirements: [{ role: "concept", description: "[合成] 保留规则适用条件", independent: true }] })),
  purpose: { objectiveIds: ["definition", "condition", "boundary"], role: "concept", method: "retrieval", purpose: "[合成] 检查尚未覆盖的约定目标", priorEvidenceRefs: [] } });
type Wire = { materials: Array<{ paragraphs: Array<{ referenceId?: string; text: string }> }>;
  taskContext: { referenceScope: string; count: number; reviewContext?: QuizReviewContext } };
function response(wire: Wire, ids = ["definition", "condition", "boundary"]) {
  const ref = wire.materials[0].paragraphs[0].referenceId!;
  return { contractVersion: "references-v2", referenceScope: wire.taskContext.referenceScope,
    title: "[合成] 定向复查", reason: null, materialPlan: [{ material: 1, contribution: "[合成] 规则及适用条件", references: [ref] }],
    items: ids.map((objectiveId, index) => ({ focus: `[合成] ${objectiveId}`, scenario: null,
      stem: `[合成] 条件判断${index + 1}需要保留什么？`, kind: "concept", stemEvidenceIds: [ref],
      options: [{ id: "F", text: "保留规则及适用条件", reasonParts: [{ text: "[合成] 条件是适用前提。", evidenceIds: [ref] }] },
        { id: "C", text: "忽略适用条件", reasonParts: [{ text: "[合成] 不能省略条件。", evidenceIds: [ref] }] }], correctOptionId: "F",
      reviewCheck: { objectiveIds: [objectiveId], role: "concept", rationale: `[合成] 这一具体条件判断为${objectiveId}提供暂定线索。` } })) };
}
const stored = (id: string): SavedQuiz => JSON.parse((learning.database.prepare("SELECT result_json FROM learning_quiz_runs WHERE id=?").get(id) as { result_json: string }).result_json);
function provider(make: (wire: Wire) => unknown) {
  return vi.fn(async (_config, _label, _prompt, input) => _label === "learning_quiz_semantic_review" ? offlineQuizSemanticResponse(input, "F") : make(input as Wire)) as unknown as ReturnType<typeof vi.fn> & typeof generateStudyJson;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "learning-review-purpose-synthetic-")); learning = new LearningRepository(root, "owner"); quiz = new LearningQuizRepository(learning);
  page = randomUUID(); material = randomUUID(); learning.create({ id: page, title: "[合成] 目标关联" });
  learning.saveMaterials(page, [{ id: material, title: "[合成] 规则", kind: "text", filename: null, bytes: Buffer.from("[合成] 只有满足明确条件时才可应用规则；忽略适用条件不能推出结果。") }]);
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Network prohibited"); }));
});
afterEach(async () => { if (learning.database.open) learning.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

it.each([2, 3])("binds accepted real question indices after a middle rejection and shuffle (requested %s)", async count => {
  const id = randomUUID(), reviewContext = context();
  const generate = provider(wire => {
    expect(wire.taskContext.reviewContext).toEqual(reviewContext);
    const value = response(wire); value.items[1].options[0].reasonParts[0].evidenceIds = ["r999"];
    return value;
  });
  const rows = await generateLearningQuiz(learning, page, { id, settings: settings(count) }, { configure: () => config, generate, reviewContext });
  expect(rows[0]).toMatchObject({ status: "completed", count: 2 });
  const result = stored(id), review = quiz.review(page, id)!;
  expect(result.optionOrderVersion).toBe(1);
  expect(result.questions.map(q => q.stem)).toEqual(["[合成] 条件判断1需要保留什么？", "[合成] 条件判断3需要保留什么？"]);
  expect(review.checks.map(q => ({ index: q.questionIndex, ids: q.objectiveIds }))).toEqual([
    { index: 0, ids: ["definition"] }, { index: 1, ids: ["boundary"] }
  ]);
  expect(review.checks.every(check => check.semanticProvenance === "model_proposal")).toBe(true);
  let attempt = quiz.startAttempt(page, { id: randomUUID(), quizId: id, mode: "test" });
  expect(JSON.stringify(attempt)).not.toMatch(/correctOptionId|reviewCheck|rationale|semanticProvenance/);
  for (const question of attempt.questions) {
    expect(question.options.find(option => option.id === "F")?.text).toBe("保留规则及适用条件");
    attempt = quiz.act(page, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "choose", question: question.index, optionId: "F" });
  }
  attempt = quiz.act(page, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "finish", question: 0, optionId: null });
  expect(attempt.score).toMatchObject({ correct: 2, total: 2 });
  learning.close(); learning = new LearningRepository(root, "owner"); quiz = new LearningQuizRepository(learning);
  expect(quiz.review(page, id)).toEqual(review);
  expect(quiz.attempt(page, attempt.id)).toEqual(attempt);
  expect(generate).toHaveBeenCalledTimes(2); expect(fetch).not.toHaveBeenCalled();
});

it("rejects a missing association in new Agent generation instead of publishing unusable goal evidence", async () => {
  const id = randomUUID(), generate = provider(wire => {
    const value = response(wire, ["definition"]);
    return { ...value, items: value.items.map(({ reviewCheck: _check, ...question }) => question) };
  });
  const rows = await generateLearningQuiz(learning, page, { id, settings: settings(1) }, { configure: () => config, generate, reviewContext: context() });
  expect(rows[0]).toMatchObject({ status: "insufficient", count: 0, delivery: { rejected: [{ code: "annotation_missing", count: 1 }] } });
  expect(quiz.review(page, id)).toBeNull();
});

it.each(["unknown-objective", "wrong-role", "extra-verdict"])("rejects invalid agent annotations without weakening the canonical codec: %s", async bad => {
  const id = randomUUID(), generate = provider(wire => {
    const value = response(wire, ["definition"]);
    if (bad === "unknown-objective") value.items[0].reviewCheck.objectiveIds = ["not-authorized"];
    if (bad === "wrong-role") value.items[0].reviewCheck.role = "boundary";
    if (bad === "extra-verdict") Object.assign(value.items[0].reviewCheck, { verified: true });
    return value;
  });
  const rows = await generateLearningQuiz(learning, page, { id, settings: settings(1) }, { configure: () => config, generate, reviewContext: context() });
  expect(rows[0]).toMatchObject({ status: "insufficient", count: 0 }); expect(quiz.review(page, id)).toBeNull();
});

it.each([false, true])("keeps manual requests and their strict fields unchanged, annotation=%s", async annotation => {
  const id = randomUUID(), generate = provider(wire => {
    expect(wire.taskContext).not.toHaveProperty("reviewContext");
    const value = response(wire, ["definition"]);
    return annotation ? value : { ...value, items: value.items.map(({ reviewCheck: _check, ...question }) => question) };
  });
  const rows = await generateLearningQuiz(learning, page, { id, settings: settings(1) }, { configure: () => config, generate });
  expect(rows[0]).toMatchObject({ status: annotation ? "insufficient" : "completed", count: annotation ? 0 : 1 });
  expect(quiz.review(page, id)).toBeNull();
  expect(generate.mock.calls[0][2]).not.toContain("taskContext.reviewContext");
});

it.each([false, true])("retains the purpose in checkpoint identity and recovers a saved response without generation, change=%s", async change => {
  const id = randomUUID(), reviewContext = context(), generate = provider(wire => response(wire, ["definition"]));
  const complete = vi.spyOn(LearningQuizRepository.prototype, "complete").mockImplementationOnce(() => { throw new LearningError(503, "learning_storage_unavailable"); });
  const first = await generateLearningQuiz(learning, page, { id, settings: settings(1) }, { configure: () => config, generate, reviewContext });
  expect(first[0]).toMatchObject({ status: "failed", failure: "learning_storage_unavailable", progress: { canResume: true } });
  complete.mockRestore();
  const second = await generateLearningQuiz(learning, page, { id, settings: settings(1), resume: true }, { configure: () => config, generate,
    reviewContext: change ? { ...reviewContext, purpose: { ...reviewContext.purpose, purpose: "[合成] 已变化的目的不能重放旧生成" } } : reviewContext });
  expect(second[0]).toMatchObject(change ? { status: "failed", failure: "source_changed" } : { status: "completed", count: 1 });
  if (!change) expect(quiz.review(page, id)?.checks[0]).toMatchObject({ questionIndex: 0, objectiveIds: ["definition"] });
  expect(generate).toHaveBeenCalledTimes(2);
});

it("rechecks source deletion and account isolation before reading saved check provenance", async () => {
  const id = randomUUID(), generate = provider(wire => response(wire, ["definition"]));
  await generateLearningQuiz(learning, page, { id, settings: settings(1) }, { configure: () => config, generate, reviewContext: context() });
  const other = new LearningRepository(root, "other");
  try { expect(() => new LearningQuizRepository(other).review(page, id)).toThrow(); } finally { other.close(); }
  expect(quiz.review(page, id)?.checks).toHaveLength(1);
  learning.deleteMaterial(page, material);
  expect(() => quiz.review(page, id)).toThrow(); expect(generate).toHaveBeenCalledTimes(2);
});

it("also preserves associations through the stable reference codec without widening its question schema", async () => {
  const id = randomUUID(), generate = provider(wire => {
    const { referenceScope: _binding, materialPlan: _plan, ...value } = response(wire, ["definition"]);
    return { ...value, items: value.items.map(({ focus: _focus, options, ...question }) => ({ ...question, hint: null,
      explanation: "[合成] 适用前提不能省略。", explanationEvidenceIds: question.stemEvidenceIds,
      options: options.map(({ reasonParts, ...option }) => ({ ...option, reason: reasonParts[0].text, evidenceIds: reasonParts[0].evidenceIds })) })) };
  });
  const rows = await generateLearningQuiz(learning, page, { id, settings: settings(1) }, { configure: () => config, generate, referenceEncoding: "stable", reviewContext: context() });
  expect(rows[0]).toMatchObject({ status: "completed", count: 1 });
  expect(quiz.review(page, id)?.checks[0]).toMatchObject({ questionIndex: 0, objectiveIds: ["definition"] });
  expect(stored(id).questions[0].stemEvidenceIds?.[0]).toMatch(/^ref_[a-f0-9]{64}$/);
});

it("carries the same purpose into real reading, source selection and question requests for a large selected scope", async () => {
  learning.deleteMaterial(page, material); material = randomUUID();
  learning.saveMaterials(page, [{ id: material, title: "[合成] 多段规则", kind: "text", filename: null,
    bytes: Buffer.from(Array.from({ length: 20 }, (_, index) => `[合成] 规则${index}。${"适用条件与明确例外。".repeat(250)}`).join("\n\n")) }]);
  const reviewContext = context(), stages: string[] = [];
  reviewContext.objectives.forEach(objective => { objective.sources = Array.from({ length: 20 }, (_, i) => ({ materialId: material, paragraph: i + 1 })); });
  const generate = vi.fn(async (_config, label, _prompt, input: unknown) => {
    if (label === "learning_quiz_semantic_review") return offlineQuizSemanticResponse(input, "F");
    stages.push(label);
    const wire = input as Wire & { windows: Array<{ id: string }> };
    expect(wire.taskContext.reviewContext).toEqual(reviewContext);
    if (label === "learning_quiz_reading") return { items: [{ title: "[合成] 适用条件", context: "[合成] 仅在前提成立时适用。" }], limitation: null };
    if (label === "learning_quiz_selection") return { items: [{ windows: [wire.windows[0].id], count: 1 }] };
    return response(wire, ["definition"]);
  }) as unknown as typeof generateStudyJson;
  const id = randomUUID(), rows = await generateLearningQuiz(learning, page, { id, settings: settings(1) }, { configure: () => config, generate, reviewContext });
  expect(rows[0]).toMatchObject({ status: "completed", count: 1 });
  expect(stages).toContain("learning_quiz_reading"); expect(stages).toContain("learning_quiz_selection"); expect(stages.at(-1)).toBe("learning_quiz");
  expect(quiz.review(page, id)?.checks).toHaveLength(1); expect(fetch).not.toHaveBeenCalled();
});


it("uses only frozen purpose sources and exposes concrete boundary role, objective IDs, requirements and wire references", async () => {
  learning.deleteMaterial(page, material); material = randomUUID();
  learning.saveMaterials(page, [{ id: material, title: "[合成] 多目标", kind: "text", filename: null,
    bytes: Buffer.from("[合成] 交集要求两个归属条件同时成立。\n\n[合成] 并集只需满足至少一个归属条件。\n\n[合成] 本次未约定的基数公式。") }]);
  const reviewContext = context();
  reviewContext.objectives = [{ id: "boundary", label: "归属边界", sources: [{ materialId: material, paragraph: 1 }],
    requirements: [{ role: "boundary", description: "只属于一个集合时不能进入交集", independent: true }] }];
  reviewContext.purpose = { objectiveIds: ["boundary"], role: "boundary", method: "contrast", purpose: "区别同时属于与只属于一个", priorEvidenceRefs: [] };
  const generate = provider(wire => {
    expect(wire.materials.flatMap(m => m.paragraphs.map(p => p.text))).toEqual(["[合成] 交集要求两个归属条件同时成立。"]);
    expect(wire.taskContext).toMatchObject({ reviewContract: {
      requiredRole: "boundary", allowedObjectiveIds: ["boundary"],
      objectives: [{ objectiveId: "boundary", requirement: { role: "boundary", description: "只属于一个集合时不能进入交集" }, sourceReferenceIds: ["r1"] }],
      annotationSchema: { required: ["objectiveIds", "role", "rationale"], properties: { role: { const: "boundary" }, objectiveIds: { items: { enum: ["boundary"] } } } }
    } });
    const result = response(wire, ["boundary"]); result.items[0].reviewCheck.role = "boundary"; return result;
  });
  const id = randomUUID(), rows = await generateLearningQuiz(learning, page, { id, settings: settings(1) }, { configure: () => config, generate, reviewContext });
  expect(rows[0]).toMatchObject({ status: "completed", count: 1 });
  expect(stored(id).questions[0].sources).toMatchObject([{ kind: "material", materialId: material, paragraph: 1 }]);
  expect(quiz.review(page, id)?.checks[0]).toMatchObject({ objectiveIds: ["boundary"], role: "boundary", semanticProvenance: "model_proposal" });
  expect(reviewContext.objectives[0].sources).toEqual([{ materialId: material, paragraph: 1 }]);
});

it("rejects a candidate assigned to the other objective's source before publication, retaining the valid remainder and exact mapping", async () => {
  learning.deleteMaterial(page, material); material = randomUUID();
  learning.saveMaterials(page, [{ id: material, title: "[合成] 分离依据", kind: "text", filename: null,
    bytes: Buffer.from("[合成] 规则一只有条件成立时适用。\n\n[合成] 规则二只有范围明确时适用。") }]);
  const reviewContext = context(); reviewContext.objectives = reviewContext.objectives.slice(0, 2);
  reviewContext.objectives[1].sources[0].paragraph = 2; reviewContext.purpose.objectiveIds = ["definition", "condition"];
  const generate = provider(wire => {
    const result = response(wire, ["condition", "definition"]);
    // Both candidates use first-paragraph r1; only definition may claim it.
    return result;
  });
  const id = randomUUID(), rows = await generateLearningQuiz(learning, page, { id, settings: settings(2) }, { configure: () => config, generate, reviewContext });
  expect(rows[0]).toMatchObject({ status: "completed", count: 1, delivery: { rejected: [{ code: "review_source_mismatch", count: 1 }] } });
  expect(stored(id).questions[0].stem).toBe("[合成] 条件判断2需要保留什么？");
  expect(quiz.review(page, id)?.checks).toMatchObject([{ questionIndex: 0, objectiveIds: ["definition"] }]);
  const attempt = quiz.startAttempt(page, { id: randomUUID(), quizId: id, mode: "test" });
  expect(JSON.stringify(attempt)).not.toMatch(/correctOptionId|rationale|reviewCheck/);
});

it("rejects source-mismatching saved generation at the final repository fence without rewriting the frozen plan or dropping valid siblings", () => {
  learning.deleteMaterial(page, material); material = randomUUID();
  learning.saveMaterials(page, [{ id: material, title: "[合成] 两段", kind: "text", filename: null,
    bytes: Buffer.from("[合成] 只有条件成立时才能使用规则。\n\n[合成] 另一个尚未约定的知识点。") }]);
  const id = randomUUID(), request = quiz.begin(page, { id, settings: settings(2) }, 48000)!, reviewContext = context();
  const codecScope = { accountId: learning.accountId, pageId: page, requestId: id, expiresAt: Date.now() + 10000 };
  const codec = composedQuizRequest(request, codecScope), value = response({ materials: codec.input.materials, taskContext: { referenceScope: String(codec.input.taskContext.referenceScope), count: request.count } }, ["definition", "definition"]);
  const mismatched = value.items[0]; mismatched.stemEvidenceIds = ["r2"];
  mismatched.options.forEach(option => { option.reasonParts[0].evidenceIds = ["r2"]; });
  const decoded = codec.decode({ ...value, items: value.items.map(({ reviewCheck: _check, ...question }) => question) }, codecScope);
  const candidates = decoded.items.map((raw, index) => ({ questionKey: quizReviewQuestionKey(raw as Parameters<typeof quizReviewQuestionKey>[0]), check: value.items[index].reviewCheck as import("./quiz-review-purpose").QuizReviewCheck }));
  const before = JSON.stringify(reviewContext);
  quiz.complete(page, id, decoded, { context: reviewContext, candidates });
  expect(quiz.list(page)[0]).toMatchObject({ status: "completed", count: 1, delivery: { rejected: [{ code: "review_source_mismatch", count: 1 }] } });
  expect(stored(id).questions[0].stem).toBe("[合成] 条件判断2需要保留什么？");
  expect(JSON.stringify(reviewContext)).toBe(before);
});

it("keeps a codec rejection primary and records a separate exact annotation error without overwriting it", () => {
  const id = randomUUID(), request = quiz.begin(page, { id, settings: settings(1) }, 48000)!, reviewContext = context();
  const scope = { accountId: learning.accountId, pageId: page, requestId: id, expiresAt: Date.now() + 10000 };
  const codec = composedQuizRequest(request, scope), value = response({ materials: codec.input.materials, taskContext: { referenceScope: String(codec.input.taskContext.referenceScope), count: request.count } }, ["definition"]);
  value.items[0].stem = "正确答案是第3项。";
  value.items[0].reviewCheck.role = "boundary";
  const issues: QuizCandidateIssue[] = [];
  const decoded = decodeReviewQuiz(value, raw => codec.decode(raw, scope, issue => issues.push(issue)), reviewContext,
    request.materials.flatMap(m => m.paragraphs.map(p => ({ referenceId: p.referenceId, source: { kind: "material", materialId: m.materialId, paragraph: p.number } }))), issue => issues.push(issue));
  const { reviewCandidates: _candidates, ...envelope } = decoded;
  expect(ReferencedQuizEnvelope.parse(envelope)).toMatchObject({ items: [{ compositionRejected: true, rejectionReason: "position_dependency" }] });
  expect(issues).toEqual(expect.arrayContaining([
    { index: 0, stage: "composition", code: "position_dependency" },
    { index: 0, stage: "review", code: "annotation_role", expectedRole: "concept", actualRole: "boundary" }
  ]));
  expect(decoded.reviewCandidates).toEqual([]);
});


it("terminalizes an objective/input source mismatch before any request and preserves the immutable plan", async () => {
  const reviewContext = context(); reviewContext.objectives[1].sources[0].paragraph = 99;
  const before = JSON.stringify(reviewContext), generate = provider(wire => response(wire));
  const id = randomUUID(), rows = await generateLearningQuiz(learning, page, { id, settings: settings(1) }, { configure: () => config, generate, reviewContext });
  expect(rows[0]).toMatchObject({ status: "failed", failure: "quiz_review_source_mismatch", count: 0 });
  expect(generate).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  expect(JSON.stringify(reviewContext)).toBe(before);
  expect(learning.database.prepare("SELECT count(*) as count FROM learning_generation_parts WHERE run_id=?").get(id)).toEqual({ count: 0 });
});
