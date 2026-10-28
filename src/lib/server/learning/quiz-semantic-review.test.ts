// @vitest-environment node
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import fixture from "./fixtures/quiz-practice-real-20261027.json";
import { ReferencedGeneratedQuiz } from "@/lib/domain/learning-quiz";
import { LearningRepository } from "./repository";
import { LearningQuizRepository } from "./quiz-repository";
import { AgentFailure } from "../agent/types";
import { generateLearningQuiz } from "./quiz-service";
import { inspectQuizAnswerContract, inspectQuizCandidateDelivery, type QuizReference } from "./quiz-grounding";
import { judgeQuizSemantics, quizSemanticInput, QuizSemanticResponse } from "./quiz-semantic-review";
import { offlineQuizSemanticResponse } from "./testing/quiz-semantic-fixture";
import type { generateStudyJson } from "./framework-generator";
import { composedQuizRequest } from "./quiz-composition";
import { decodeReviewQuiz, scopeQuizReviewRequest, QuizReviewContext } from "./quiz-review-purpose";

let root: string, learning: LearningRepository, quizzes: LearningQuizRepository, page: string, material: string;
const config = { baseURL: "https://offline.invalid", apiKey: "SYNTHETIC", model: "offline", maxInputChars: 47000, maxOutputTokens: 8000 };
const saved = JSON.parse(fixture.quiz.result_json);
// Projection removes persistence-only fields; every original content/answer/
// reason/source ID is retained. The raw response and original saved JSON remain.
const originals = saved.questions.map((q: any) => ReferencedGeneratedQuiz.shape.items.element.parse({ stem: q.stem, kind: q.kind,
  options: q.options, correctOptionId: q.correctOptionId, explanation: q.explanation, hint: q.hint,
  stemEvidenceIds: q.stemEvidenceIds, explanationEvidenceIds: q.explanationEvidenceIds }));
const originalCatalog: QuizReference[] = [...new Map<string, QuizReference>(saved.questions.flatMap((q: any) => q.evidence.map((e: any) =>
  [e.referenceId, { referenceId: e.referenceId, text: e.quote, source: e.source }]))).values()];
const settings = (count = 2) => ({ materialIds: [material], chapterIds: [], nodeIds: [], includeNotes: false, includeSupplements: false, count, difficulty: "basic" });
function response(input: any) {
  const refs = input.materials[0].paragraphs.map((p: any) => p.referenceId);
  return { contractVersion: "references-v2", title: "[合成] 前提判断", reason: null,
    items: ["必要条件不满足时可以应用规则吗？", "假设一个新案例：小林没有满足前提，应如何判断？"].map(stem => ({ stem, kind: "concept", scenario: null,
      options: [{ id: "A", text: "不能直接应用规则", reason: "规则需要前提成立。", evidenceIds: refs },
        { id: "B", text: "可以直接应用规则", reason: "此判断忽略了前提。", evidenceIds: refs }],
      correctOptionId: "A", explanation: "先判断前提。", hint: null, stemEvidenceIds: refs, explanationEvidenceIds: refs })) };
}
function provider(review: (input: any) => unknown = offlineQuizSemanticResponse) {
  return vi.fn(async (_config, name, _prompt, input, _schema, _signal, diagnostic) => {
    diagnostic?.({ responseStatus: "completed", inputTokens: name === "learning_quiz" ? 50 : 40, outputTokens: 20 });
    return name === "learning_quiz_semantic_review" ? review(input) : response(input);
  }) as unknown as ReturnType<typeof vi.fn<typeof generateStudyJson>>;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "quiz-quality-offline-")); learning = new LearningRepository(root, "owner"); quizzes = new LearningQuizRepository(learning);
  page = randomUUID(); material = randomUUID(); learning.create({ id: page, title: "[离线合成]" });
  learning.saveMaterials(page, [{ id: material, title: "[合成] 前提", kind: "text", filename: null, bytes: Buffer.from("规则只能在必要前提成立时应用。前提不满足，不能应用规则。") }]);
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("network_forbidden"); }));
});
afterEach(async () => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.restoreAllMocks(); learning.close(); await rm(root, { recursive: true, force: true }); });

it.each([0, 1, 2])("rejects original real bad question %i unchanged; independent controlled verdict also finds multiple answers", index => {
  const q = originals[index], before = JSON.stringify(q);
  expect(inspectQuizAnswerContract(q)).toBe("answer_contradiction");
  const report = inspectQuizCandidateDelivery({ contractVersion: "references-v2", title: saved.title, reason: null, items: [q] }, originalCatalog);
  expect(report.rejected).toEqual([{ index: 0, code: "answer_contradiction" }]);
  const input = quizSemanticInput([q], originalCatalog), blind = JSON.stringify(input);
  for (const key of ["correctOptionId", "explanation", '"reason"', '"hint"']) expect(blind).not.toContain(key);
  const judged = offlineQuizSemanticResponse(input);
  for (const option of judged.items[0].options) option.verdict = fixture.expectedTrueIds[index].includes(option.optionId) ? "holds" : "does_not_hold";
  expect(judgeQuizSemantics(judged, [q], originalCatalog).items[0]).toMatchObject({ accepted: false, rejection: "answer_not_unique" });
  expect(JSON.stringify(q)).toBe(before); // original content never repaired by the reviewer
});
it("replays all three through final repository publication and keeps original material/answers intact", () => {
  learning.create({ id: fixture.material.pageId, title: "[合成原始证据回放]" });
  learning.saveMaterials(fixture.material.pageId, [{ id: fixture.material.materialId, title: fixture.material.title, kind: "text", filename: null, bytes: Buffer.from(fixture.course) }]);
  expect(createHash("sha256").update(fixture.course).digest("hex")).toBe(fixture.material.sourceSha256);
  const id = randomUUID(), config = { ...settings(3), materialIds: [fixture.material.materialId] };
  quizzes.begin(fixture.material.pageId, { id, settings: config }, 47000);
  quizzes.complete(fixture.material.pageId, id, { contractVersion: "references-v2", title: saved.title, reason: null, items: originals });
  expect(quizzes.list(fixture.material.pageId)[0]).toMatchObject({ status: "insufficient", count: 0,
    delivery: { rejected: [{ code: "answer_contradiction", count: 3 }] } });
  expect(() => quizzes.startAttempt(fixture.material.pageId, { id: randomUUID(), quizId: id, mode: "test" })).toThrow();
  const rawId = randomUUID(), raw = JSON.parse(fixture.rawText), review = QuizReviewContext.parse(saved.review.context);
  const request = scopeQuizReviewRequest(quizzes.begin(fixture.material.pageId, { id: rawId, settings: config }, 47000)!, review);
  const scope = { accountId: "owner", pageId: fixture.material.pageId, requestId: rawId, expiresAt: Date.now() + 60_000 }, codec = composedQuizRequest(request, scope);
  expect(codec.input.materials.map(m => m.paragraphs.map(p => p.text))).toEqual(fixture.wire.materials.map(m => m.paragraphs.map(p => p.text)));
  const issues: Array<{ index: number; code: string }> = [];
  const decoded = decodeReviewQuiz(raw, value => codec.decode(value, scope, issue => issues.push(issue)), review, originalCatalog);
  expect(issues.filter(issue => issue.code === "answer_contradiction").map(issue => issue.index)).toEqual([0, 1, 2]);
  const { reviewCandidates: _checks, ...envelope } = decoded;
  quizzes.complete(fixture.material.pageId, rawId, envelope);
  expect(quizzes.list(fixture.material.pageId).find(run => run.id === rawId)).toMatchObject({ status: "insufficient", count: 0 });
  expect(JSON.stringify(raw)).toBe(JSON.stringify(JSON.parse(fixture.rawText)));
});
it("negative and case questions pass the same mandatory service review when exactly one option satisfies the stem", async () => {
  const generate = vi.fn(async (_config, name, _prompt, input) => {
    if (name === "learning_quiz_semantic_review") return offlineQuizSemanticResponse(input, "B");
    const value = response(input);
    value.items[0].stem = "以下哪项是不正确的？";
    value.items[1].stem = "假设一个新案例：小林未满足前提，以下哪项判断是错误的？";
    for (const q of value.items) { q.correctOptionId = "B"; q.options[0].reason = "该表述与原文一致：规则需要前提成立。题干询问不正确的判断。"; }
    return value;
  }) as unknown as typeof generateStudyJson;
  await generateLearningQuiz(learning, page, { id: randomUUID(), settings: settings() }, { configure: () => config, generate, referenceEncoding: "stable" });
  expect(quizzes.list(page)[0]).toMatchObject({ status: "completed", count: 2 });
});
it.each([
  ["以下哪项是不正确的？", "该表述与原文一致：这是合法的非答案真命题。"],
  ["以下哪项正确？", "该表述与原文不一致：否定不能当肯定。"],
  ["以下哪项正确？", "如果该表述与原文一致，就需要进一步核对；实际不成立。"],
  ["以下哪项正确？", "“该表述与原文一致”是被反驳的说法。"],
  ["以下哪项正确？", "该表述与原文中的错误主张一致，但作者随后反驳了这一主张。"],
  ["以下哪项正确？", "该表述与原文一致，但不满足本题的特定条件。"],
  ["假设对象未满足前提，哪项符合条件？", "原文肯定另一种场景，本案例不适用。"]
])("does not keyword-reject negative/quoted/conditional reasons: %s / %s", (stem, reason) => {
  expect(inspectQuizAnswerContract({ stem, explanation: "需按题干判断。", correctOptionId: "A",
    options: [{ id: "A", text: "甲", reason: "符合题干。" }, { id: "B", text: "乙", reason }] })).toBeNull();
});
it("publishes reviewed good candidates while rejecting ambiguous ones, hides diagnostics and preserves scoring/reopen", async () => {
  const generate = provider(input => {
    const result = offlineQuizSemanticResponse(input); result.items[1].options[1].verdict = "holds"; return result;
  });
  const id = randomUUID(); await generateLearningQuiz(learning, page, { id, settings: settings() }, { configure: () => config, generate, referenceEncoding: "stable" });
  expect(quizzes.list(page)[0]).toMatchObject({ status: "completed", count: 1, delivery: { rejected: [{ code: "answer_not_unique", count: 1 }] } });
  expect(generate.mock.calls.map(call => call[1])).toEqual(["learning_quiz", "learning_quiz_semantic_review"]);
  let a = quizzes.startAttempt(page, { id: randomUUID(), quizId: id, mode: "test" });
  expect(JSON.stringify(a)).not.toContain("independent_model_judgment"); expect(JSON.stringify(a)).not.toContain("correctOptionId");
  a = quizzes.act(page, { id: randomUUID(), attemptId: a.id, revision: a.revision, action: "choose", question: 0, optionId: "B" });
  const finish = { id: randomUUID(), attemptId: a.id, revision: a.revision, action: "finish", question: 0, optionId: null };
  a = quizzes.act(page, finish); expect(a.score).toMatchObject({ correct: 0, total: 1 }); expect(quizzes.act(page, finish)).toEqual(a);
  learning.close(); learning = new LearningRepository(root, "owner"); quizzes = new LearningQuizRepository(learning);
  expect(quizzes.attempt(page, a.id)).toEqual(a);
  await generateLearningQuiz(learning, page, { id, settings: settings() }, { configure: () => config, generate });
  expect(generate).toHaveBeenCalledTimes(2);
  const parts = learning.database.prepare("SELECT part_id,state,attempts,diagnostics_json FROM learning_generation_parts WHERE run_id=? ORDER BY part_id").all(id) as any[];
  expect(parts.map(p => [p.part_id, p.state, p.attempts])).toEqual([["questions-0", "completed", 1], ["semantic-0-0", "completed", 1]]);
  expect(JSON.parse(parts[1].diagnostics_json)).toMatchObject({ inputTokens: 40, outputTokens: 20 });
});
it.each(["multiple", "uncertain", "different", "none"])("rejects semantic verdict %s without rewriting answer", async mode => {
  const generate = provider(input => { const r = offlineQuizSemanticResponse(input); for (const q of r.items) {
    q.options[0].verdict = ["different", "none"].includes(mode) ? "does_not_hold" : "holds";
    q.options[1].verdict = mode === "uncertain" ? "uncertain" : mode === "none" ? "does_not_hold" : "holds";
  } return r; });
  await generateLearningQuiz(learning, page, { id: randomUUID(), settings: settings() }, { configure: () => config, generate, referenceEncoding: "stable" });
  expect(quizzes.list(page)[0]).toMatchObject({ status: "insufficient", count: 0 });
});
it.each(["unknown", "known_failure", "invalid"])("review %s cannot publish or automatically resend", async mode => {
  const generate = provider(() => { if (mode === "invalid") return { items: [] }; throw new AgentFailure(mode as "unknown" | "known_failure", "synthetic_review_failure"); });
  const id = randomUUID(); await generateLearningQuiz(learning, page, { id, settings: settings() }, { configure: () => config, generate, referenceEncoding: "stable" });
  expect(quizzes.list(page)[0]).toMatchObject({ status: "failed", count: 0, progress: { uncertain: mode === "unknown" } });
  await generateLearningQuiz(learning, page, { id, settings: settings() }, { configure: () => config, generate });
  if (mode === "unknown") expect((await generateLearningQuiz(learning, page, { id, settings: settings(), resume: true }, { configure: () => config, generate }))[0]).toMatchObject({ status: "failed", progress: { uncertain: true } });
  expect(generate).toHaveBeenCalledTimes(2);
});
it("final publication refuses missing review proof; independent schema enforces exact candidates/options and sources", () => {
  const id = randomUUID(), request = quizzes.begin(page, { id, settings: settings() }, 47000)!;
  quizzes.requireSemanticReview(page, id);
  const value = response(request); expect(() => quizzes.complete(page, id, value)).toThrow("quiz_semantic_review_required");
  const catalog = request.materials.flatMap(m => m.paragraphs.map(p => ({ referenceId: p.referenceId, text: p.text, source: { kind: "material" as const, materialId: m.materialId, paragraph: p.number } })));
  const q = ReferencedGeneratedQuiz.parse(value).items, input = quizSemanticInput(q, catalog);
  for (const mutation of ["missing", "duplicate", "unknown-source"]) {
    const result = offlineQuizSemanticResponse(input);
    if (mutation === "missing") result.items.pop();
    if (mutation === "duplicate") result.items[0].options[1].optionId = "A";
    if (mutation === "unknown-source") result.items[0].options[0].evidenceIds = [`ref_${"0".repeat(64)}`];
    expect(() => judgeQuizSemantics(result, q, catalog)).toThrow();
  }
  expect(QuizSemanticResponse.safeParse({ items: [] }).success).toBe(false);
});
it.each(["answer", "option", "reason"])("completed review cannot authorize a changed %s at publication", async field => {
  const complete = LearningQuizRepository.prototype.complete;
  vi.spyOn(LearningQuizRepository.prototype, "complete").mockImplementation(function(this: LearningQuizRepository, pageId, id, value, review) {
    const altered = structuredClone(value) as ReturnType<typeof response>;
    if (field === "answer") altered.items[0].correctOptionId = "B";
    if (field === "option") altered.items[0].options[0].text = "完全不同的判断";
    if (field === "reason") altered.items[0].options[0].reason = "事后更换的理由";
    return complete.call(this, pageId, id, altered, review);
  });
  await generateLearningQuiz(learning, page, { id: randomUUID(), settings: settings() }, { configure: () => config, generate: provider(), referenceEncoding: "stable" });
  expect(quizzes.list(page)[0]).toMatchObject({ status: "failed", count: 0, failure: "quiz_semantic_review_required" });
});
it("source deletion during independent review fences its late judgment without publication", async () => {
  const generate = provider(input => { const result = offlineQuizSemanticResponse(input); learning.deleteMaterial(page, material); return result; });
  await generateLearningQuiz(learning, page, { id: randomUUID(), settings: settings() }, { configure: () => config, generate, referenceEncoding: "stable" });
  expect(quizzes.list(page).some(run => run.status === "completed")).toBe(false);
});
