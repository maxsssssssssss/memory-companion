// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReferencedGeneratedQuiz, type SavedQuiz } from "@/lib/domain/learning-quiz";
import fixture from "./testing/final-g5-0b28c3e.fixture.json";
import { inspectQuizAnswerContract, inspectQuizCandidateDelivery } from "./quiz-grounding";
import { compactQuizRequest } from "./quiz-compact";
import { composedQuizRequest } from "./quiz-composition";
import { QuizReviewPublication, scopeQuizReviewRequest, quizReviewQuestionKey } from "./quiz-review-purpose";
import { LearningRepository } from "./repository";
import { LearningQuizRepository } from "./quiz-repository";
import { generateLearningQuiz } from "./quiz-service";
import type { generateStudyJson } from "./framework-generator";

const { reviewCandidates, ...body } = fixture.decoded;
const original = ReferencedGeneratedQuiz.parse(body);
const review = QuizReviewPublication.parse({ context: fixture.reviewContext, candidates: reviewCandidates });
const bad = original.items[1];
const originalSnapshot = JSON.stringify(fixture);
let directory: string, learning: LearningRepository, quizzes: LearningQuizRepository;
const accountId = "synthetic-set-operation", page = fixture.source.page_id;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "set-operation-result-"));
  learning = new LearningRepository(directory, accountId); quizzes = new LearningQuizRepository(learning);
  learning.create({ id: page, title: "[离线原题] FINAL-G5-2" });
  learning.saveMaterials(page, [{ id: fixture.source.id, title: fixture.source.title, kind: "text", filename: null, bytes: Buffer.from(fixture.source.original) }]);
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Real Provider prohibited"); }));
});
afterEach(async () => {
  expect(JSON.stringify(fixture)).toBe(originalSnapshot);
  expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals();
  if (learning.database.open) learning.close();
  await rm(directory, { recursive: true, force: true });
});

function begin() {
  const id = randomUUID(), request = scopeQuizReviewRequest(quizzes.begin(page, { id, settings: fixture.settings }, 48000)!, review.context);
  const scope = { accountId, pageId: page, requestId: id, expiresAt: Date.now() + 120000 };
  const catalog = request.materials.flatMap(m => m.paragraphs.map(p => ({ referenceId: p.referenceId, text: p.text,
    source: { kind: "material" as const, materialId: m.materialId, paragraph: p.number } })));
  const short = (ids: string[]) => ids.map(id => { const index = catalog.findIndex(r => r.referenceId === id); expect(index).toBeGreaterThanOrEqual(0); return `r${index + 1}`; });
  const compact = compactQuizRequest(request, scope);
  const items = original.items.map(q => ({ ...q, stemEvidenceIds: short(q.stemEvidenceIds), explanationEvidenceIds: short(q.explanationEvidenceIds),
    options: q.options.map(o => ({ ...o, evidenceIds: short(o.evidenceIds) })) }));
  const decoded = compact.decode({ ...original, referenceScope: compact.input.taskContext.referenceScope, items }, scope);
  expect(decoded.items).toEqual(original.items);
  const wire = { contractVersion: "references-v2", title: original.title, reason: original.reason, items: items.map(q => {
    const { explanation, explanationEvidenceIds, options, ...rest } = q;
    return { ...rest, explanationParts: [{ text: explanation, evidenceIds: explanationEvidenceIds }],
      options: options.map(({ reason, evidenceIds, ...option }) => ({ ...option, reasonParts: [{ text: reason, evidenceIds }] })) };
  }) };
  return { id, scope, request, catalog, decoded, wire };
}

it("rejects the unchanged two true equations at BOTH composition and final publication, preserving good neighbours", () => {
  const { id, scope, request, catalog, decoded, wire } = begin();
  expect(inspectQuizAnswerContract(bad)).toBe("answer_not_unique");
  const issues: unknown[] = [];
  const composed = composedQuizRequest(request, scope).decode(wire, scope, issue => issues.push(issue));
  expect(issues).toEqual([{ index: 1, stage: "composition", code: "answer_not_unique" }]);
  expect(composed.items[0]).toEqual(original.items[0]); expect(composed.items[2]).toEqual(original.items[2]);
  expect(inspectQuizCandidateDelivery(decoded, catalog).rejected).toEqual([{ index: 1, code: "answer_not_unique" }]);
  quizzes.complete(page, id, decoded, review);
  const row = learning.database.prepare("SELECT result_json FROM learning_quiz_runs WHERE id=?").get(id) as { result_json: string };
  const saved = JSON.parse(row.result_json) as SavedQuiz;
  expect(saved.questions).toHaveLength(2);
  const sort = <T extends { id: string }>(options: T[]) => [...options].sort((a, b) => a.id.localeCompare(b.id));
  for (const [index, originalIndex] of [0, 2].entries()) {
    const q = saved.questions[index], old = fixture.saved.questions[originalIndex];
    expect({ ...q, options: sort(q.options) }).toEqual({ ...old, options: sort(old.options) });
  }
  const checks = quizzes.review(page, id)!.checks;
  expect(checks.map(c => c.questionIndex)).toEqual([0, 1]);
  expect(saved.questions.map(quizReviewQuestionKey)).not.toContain(quizReviewQuestionKey(bad));
  expect(checks).toEqual([0, 2].map((originalIndex, questionIndex) => ({ ...review.candidates[originalIndex].check,
    questionIndex, semanticProvenance: "model_proposal" })));
  let attempt = quizzes.startAttempt(page, { id: randomUUID(), quizId: id, mode: "test" });
  expect(JSON.stringify(attempt)).not.toMatch(/correctOptionId|reasonParts/);
  expect(() => quizzes.act(page, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "choose", question: 2, optionId: "B" })).toThrow(/invalid_input/);
  expect(quizzes.attempt(page, attempt.id).revision).toBe(0);
  for (const [index, q] of saved.questions.entries()) attempt = quizzes.act(page, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "choose", question: index, optionId: q.correctOptionId });
  const finish = { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "finish", question: 0, optionId: null };
  attempt = quizzes.act(page, finish); expect(attempt.score).toMatchObject({ correct: 2, total: 2 });
  expect(quizzes.act(page, finish)).toEqual(attempt);
  learning.close(); learning = new LearningRepository(directory, accountId); quizzes = new LearningQuizRepository(learning);
  expect(quizzes.act(page, finish)).toEqual(attempt);
  expect(learning.database.pragma("integrity_check", { simple: true })).toBe("ok");
});

it("publishes only the two good originals through one formal generation and cannot start an attempt on the rejected-only group", async () => {
  const { id, decoded, wire } = begin();
  quizzes.complete(page, id, { ...decoded, items: [bad] }, { ...review, candidates: [review.candidates[1]] });
  expect(quizzes.list(page).find(q => q.id === id)).toMatchObject({ status: "insufficient", count: 0 });
  expect(() => quizzes.startAttempt(page, { id: randomUUID(), quizId: id, mode: "test" })).toThrow();
  const generate = vi.fn(async () => ({ ...wire, items: wire.items.map((q, i) => ({ ...q, reviewCheck: reviewCandidates[i].check })) })) as unknown as ReturnType<typeof vi.fn<typeof generateStudyJson>>;
  const runId = randomUUID();
  const runs = await generateLearningQuiz(learning, page, { id: runId, settings: fixture.settings }, {
    configure: () => ({ baseURL: "https://unused.invalid/v1", apiKey: "synthetic-only", model: "offline", maxInputChars: 48000, maxOutputTokens: 8000 }),
    generate, reviewContext: review.context });
  expect(runs.find(q => q.id === runId)).toMatchObject({ status: "completed", count: 2, delivery: { rejected: [{ code: "answer_not_unique", count: 1 }] } });
  expect(generate).toHaveBeenCalledTimes(1);
});

it.each([
  [bad, "answer_not_unique"],
  [{ ...bad, options: bad.options.map(o => o.id === "B" ? { ...o, text: "A∪B={1,2,4}。" } : o) }, null],
  [{ ...bad, correctOptionId: "C", options: bad.options.map(o => o.id === "B" ? { ...o, text: "A∪B={1,2,4}。" } : o) }, "answer_contradiction"],
  [{ ...bad, options: bad.options.map(o => ({ ...o, text: "A∩B={9}。" })) }, "answer_not_unique"],
] as const)("bounded literal truth check respects uniqueness and the saved answer ID: %#", (q, expected) => {
  expect(inspectQuizAnswerContract(q)).toBe(expected);
});

it.each([
  ["设 E={红、蓝}，F={蓝,绿}。下列集合运算结果正确的是？", ["E∩F={蓝}", "F∪E={绿,蓝,红,蓝}", "E∩F={红}"]],
  ["设 X={a,b}，Y={b,c}。下列集合运算结果正确的是？", ["X∩Y={b}", "Y∪X={c,a,b,b}", "X∩Y={a}"]],
  ["设 A={}，B={1}。下列集合运算结果正确的是？", ["A∩B=∅", "A∪B={1,1}", "A∩B={1}"]],
] as const)("handles duplicate/order/name changes without equating distinct true statements: %s", (stem, texts) => {
  expect(inspectQuizAnswerContract({ ...bad, stem, options: texts.map((text, i) => ({ id: String.fromCharCode(65 + i), text, reason: "合成理由" })) })).toBe("answer_not_unique");
});

it.each([
  { stem: `字符串逐字比较：${bad.stem}` },
  { stem: bad.stem.replace("正确", "错误") },
  { stem: `${bad.stem}另有一个未列出的限制。` },
  { stem: bad.stem.replace("{1,2,3}", "{x|x>0}") },
  { options: bad.options.map(o => o.id === "B" ? { ...o, text: "A∪C={1,2,3,4}" } : o) },
  { options: bad.options.map(o => o.id === "B" ? { ...o, text: "A∪B={1,2,3,4}，且满足额外条件" } : o) },
])("does not infer a truth value from unsupported or partial prose: %#", patch => {
  expect(inspectQuizAnswerContract({ ...bad, ...patch })).toBeNull();
});
