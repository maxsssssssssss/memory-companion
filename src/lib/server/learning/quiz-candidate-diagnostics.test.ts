// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LearningRepository } from "./repository";
import { LearningQuizRepository } from "./quiz-repository";
import { generateLearningQuiz } from "./quiz-service";
import type { generateStudyJson } from "./framework-generator";
import { quizReviewQuestionKey, type QuizReviewContext } from "./quiz-review-purpose";
import { ReferencedGeneratedQuiz, type SavedQuiz } from "@/lib/domain/learning-quiz";
import { clearQuizCandidateDiagnostics, quizCandidateDiagnostics, type QuizDiagnosticContext } from "./quiz-candidate-diagnostics";

let root: string, learning: LearningRepository, repo: LearningQuizRepository, page: string, material: string;
let context: QuizReviewContext, diagnosticContext: QuizDiagnosticContext;
const config = { baseURL: "https://unused.invalid/v1", apiKey: "synthetic-only", model: "offline", maxInputChars: 48000, maxOutputTokens: 8000 };
const settings = () => ({ materialIds: [material], chapterIds: [], nodeIds: [], includeNotes: false, includeSupplements: false, count: 2, difficulty: "basic" });
type Wire = { materials: Array<{ paragraphs: Array<{ referenceId: string }> }>; taskContext: { reviewContract: unknown } };
function response(wire: Wire) {
  const ids = [wire.materials[0].paragraphs[0].referenceId];
  return { contractVersion: "references-v2", title: "[synthetic] 交集检查", reason: null, materialPlan: [],
    items: ["已知集合 A={1,2}，B={2,3}。A∩B 是什么？", "已知集合 E={5}，F={6}。E∩F 是什么？"].map((stem, index) => ({
      focus: `判断交集${index}`, stem, scenario: null, kind: "application", stemEvidenceIds: ids,
      options: [{ id: "A", text: index ? "∅" : "{2}", reasonParts: [{ text: "交集保留共同元素。", evidenceIds: ids }] },
        { id: "B", text: "{1,2,3}", reasonParts: [{ text: "这里包含了不属于两个集合共同部分的元素。", evidenceIds: ids }] }],
      correctOptionId: "A", reviewCheck: { objectiveIds: ["intersection"], role: "boundary", rationale: "检查是否满足两个归属条件。" }
    })) };
}
function detail(id: string) {
  const row = learning.database.prepare("SELECT diagnostics_json FROM learning_generation_parts WHERE run_id=? AND part_id='questions-0'").get(id) as { diagnostics_json: string | null };
  return JSON.parse(row.diagnostics_json ?? "{}").candidateDiagnostics;
}
const generate = (make: (wire: Wire) => unknown) => vi.fn(async (_config, _name, _prompt, input) => make(input as Wire)) as unknown as typeof generateStudyJson;
async function run(make: (wire: Wire) => unknown) {
  const id = randomUUID();
  const rows = await generateLearningQuiz(learning, page, { id, settings: settings() }, { configure: () => config,
    generate: generate(make), reviewContext: context, diagnosticContext });
  return { id, run: rows.find(row => row.id === id)! };
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "quiz-private-diagnostics-")); learning = new LearningRepository(root, "owner"); repo = new LearningQuizRepository(learning);
  page = randomUUID(); material = randomUUID(); learning.create({ id: page, title: "[synthetic] 诊断" });
  learning.saveMaterials(page, [{ id: material, kind: "text", filename: null, title: "[synthetic] 集合", bytes: Buffer.from("交集包含同时属于两个集合的元素，没有共同元素时交集为空。") }]);
  context = { planId: randomUUID(), taskVersion: 2, objectives: [{ id: "intersection", label: "理解交集", sources: [{ materialId: material, paragraph: 1 }],
    requirements: [{ role: "boundary", description: "判断是否满足两个归属条件", independent: true }] }],
    purpose: { objectiveIds: ["intersection"], role: "boundary", method: "contrast", purpose: "区分只属于一个和同时属于两个", priorEvidenceRefs: [] } };
  diagnosticContext = { taskId: randomUUID(), taskVersion: 2, actionId: "synthetic-task:4" };
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Network prohibited"); }));
});
afterEach(async () => { vi.useRealTimers(); if (learning.database.open) learning.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

it("keeps precise primary/secondary rejection and the actual final candidate privately through the formal service", async () => {
  const result = await run(wire => {
    const value = response(wire);
    value.items[0].options[0].reasonParts[0].text = "选项 A/B 都正确。";
    value.items[0].reviewCheck.role = "application";
    return value;
  });
  expect(result.run).toMatchObject({ status: "completed", count: 1, delivery: { rejected: [{ code: "position_dependency", count: 1 }] } });
  const diagnostics = detail(result.id);
  expect(diagnostics).toMatchObject({ context: diagnosticContext, runId: result.id, partId: "questions-0", requestId: `${result.id}:questions:0`, truncated: false });
  expect(diagnostics.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ index: 0, stage: "composition", code: "position_dependency" }),
    expect.objectContaining({ index: 0, stage: "review", code: "annotation_role", expectedRole: "boundary", actualRole: "application" })
  ]));
  expect(diagnostics.candidates).toHaveLength(1);
  expect(diagnostics.candidates[0].candidate.options[0].reasonParts[0].text).toBe("选项 A/B 都正确。");
  const attempt = repo.startAttempt(page, { id: randomUUID(), quizId: result.id, mode: "test" });
  expect(JSON.stringify({ attempt, runs: repo.list(page) })).not.toMatch(/candidateDiagnostics|reasonParts|correctOptionId|选项 A\/B 都正确|actualRole/);
  learning.close(); learning = new LearningRepository(root, "owner"); repo = new LearningQuizRepository(learning);
  expect(detail(result.id)).toEqual(diagnostics);
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["composed", "stable"] as const)("normalizes only the explicit kind alias before identity binding in %s generation and retains its original projection", async encoding => {
  expect(ReferencedGeneratedQuiz.shape.items.element.shape.kind.safeParse("boundary").success).toBe(false);
  let raw: unknown, original: string | undefined;
  const provider = generate(wire => {
    const value = response(wire); value.items[0].kind = "boundary";
    // The stable-reference path is an existing internal evaluation interface.
    // Its raw response shape differs, but uses the same pre-binding kind policy.
    const { materialPlan: _plan, ...body } = value;
    raw = encoding === "composed" ? value : { ...body, items: value.items.map(({ focus: _focus, options, ...item }) => ({ ...item,
      explanation: options[0].reasonParts.map(part => part.text).join("\n"), explanationEvidenceIds: options[0].reasonParts.flatMap(part => part.evidenceIds), hint: null,
      options: options.map(({ reasonParts, ...option }) => ({ ...option, reason: reasonParts.map(part => part.text).join("\n"), evidenceIds: reasonParts.flatMap(part => part.evidenceIds) })) })) };
    original = JSON.stringify(raw); return raw;
  });
  const id = randomUUID();
  const rows = await generateLearningQuiz(learning, page, { id, settings: settings() }, { configure: () => config, generate: provider,
    ...(encoding === "stable" ? { referenceEncoding: "stable" } : {}), reviewContext: context, diagnosticContext });
  expect(rows.find(row => row.id === id)).toMatchObject({ status: "completed", count: 2 });
  expect(JSON.stringify(raw)).toBe(original);
  const diagnostics = detail(id);
  expect(diagnostics).toMatchObject({ context: diagnosticContext, issues: [], normalizations: [{ index: 0, stage: "normalization", code: "kind_alias",
    originalKind: "boundary", normalizedKind: "application" }], candidates: [{ index: 0, candidate: { kind: "boundary" } }] });
  const saved = JSON.parse((learning.database.prepare("SELECT result_json FROM learning_quiz_runs WHERE id=?").get(id) as { result_json: string }).result_json) as SavedQuiz;
  expect(saved.questions[0].kind).toBe("application");
  expect(quizReviewQuestionKey(saved.questions[0])).not.toBe(quizReviewQuestionKey({ ...saved.questions[0], kind: "boundary" }));
  expect(repo.review(page, id)!.checks).toEqual([0, 1].map(questionIndex => expect.objectContaining({ questionIndex,
    objectiveIds: ["intersection"], role: "boundary", semanticProvenance: "model_proposal" })));
  let attempt = repo.startAttempt(page, { id: randomUUID(), quizId: id, mode: "test" });
  expect(JSON.stringify(attempt)).not.toMatch(/correctOptionId|normalizations|originalKind|reasonParts/);
  for (let question = 0; question < attempt.questions.length; question++) attempt = repo.act(page, { id: randomUUID(), attemptId: attempt.id,
    revision: attempt.revision, action: "choose", question, optionId: "A" });
  attempt = repo.act(page, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "finish", question: 0, optionId: null });
  expect(attempt.score).toMatchObject({ correct: 2, total: 2 });
  learning.close(); learning = new LearningRepository(root, "owner"); repo = new LearningQuizRepository(learning);
  expect(detail(id)).toEqual(diagnostics); expect(repo.attempt(page, attempt.id)).toEqual(attempt);
  clearQuizCandidateDiagnostics(learning, page, { taskId: diagnosticContext.taskId, exceptVersion: 3 });
  expect(detail(id)).toBeUndefined(); expect(fetch).not.toHaveBeenCalled();
});

it.each(["unrecognized", "missing-source", "wrong-role", "duplicate-option-id"])("kind normalization does not repair %s or weaken independent publication gates", async invalid => {
  const result = await run(wire => {
    const value = response(wire); value.items[0].kind = invalid === "unrecognized" ? "boundary_conditions" : "boundary";
    if (invalid === "missing-source") value.items[0].options[0].reasonParts[0].evidenceIds = ["r999"];
    if (invalid === "wrong-role") value.items[0].reviewCheck.role = "concept";
    if (invalid === "duplicate-option-id") value.items[0].options[1].id = "A";
    return value;
  });
  expect(result.run).toMatchObject({ status: "completed", count: 1 });
  const diagnostics = detail(result.id);
  if (invalid === "unrecognized") {
    expect(diagnostics.normalizations).toBeUndefined();
    expect(diagnostics.issues[0]).toMatchObject({ stage: "composition", code: "structure_or_evidence", validationIssues: [{ path: "kind", code: "invalid_enum_value" }] });
  } else expect(diagnostics.normalizations).toHaveLength(1);
  expect(diagnostics.issues.map((issue: { code: string }) => issue.code)).toContain(invalid === "missing-source" ? "source_binding"
    : invalid === "wrong-role" ? "annotation_role" : invalid === "duplicate-option-id" ? "option_identity" : "structure_or_evidence");
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["schema", "role", "objective"])("distinguishes %s contract failure without calling it semantic irrelevance", async type => {
  const result = await run(wire => {
    const value = response(wire);
    if (type === "schema") Object.assign(value.items[0].reviewCheck, { objectiveIds: "intersection" });
    if (type === "role") value.items[0].reviewCheck.role = "concept";
    if (type === "objective") value.items[0].reviewCheck.objectiveIds = ["another_goal"];
    return value;
  });
  const expected = `annotation_${type}`;
  expect(result.run).toMatchObject({ status: "completed", count: 1, delivery: { rejected: [{ code: expected, count: 1 }] } });
  const issue = detail(result.id).issues.find((x: { code: string }) => x.code === expected);
  if (type === "schema") expect(issue.validationIssues).toContainEqual({ code: "invalid_type", path: "reviewCheck.objectiveIds" });
  if (type === "objective") expect(issue).toMatchObject({ expectedObjectiveIds: ["intersection"], actualObjectiveIds: ["another_goal"] });
});

it("clears private text on source/quiz removal, explicit version adjustment and expiry while retaining useful counts", async () => {
  const make = (wire: Wire) => { const value = response(wire); value.items[0].reviewCheck.role = "concept"; return value; };
  const first = await run(make);
  clearQuizCandidateDiagnostics(learning, page, { taskId: diagnosticContext.taskId, exceptVersion: 3 });
  expect(detail(first.id)).toBeUndefined(); expect(repo.list(page)[0].delivery!.rejected[0].code).toBe("annotation_role");
  const second = await run(make);
  const other = new LearningRepository(root, "another-owner");
  try { expect(() => clearQuizCandidateDiagnostics(other, page, { taskId: diagnosticContext.taskId })).toThrow(); }
  finally { other.close(); }
  expect(detail(second.id)).toBeDefined();
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
  repo.list(page); expect(detail(second.id)).toBeUndefined(); vi.useRealTimers();
  const third = await run(make); repo.delete(page, third.id);
  expect(learning.database.prepare("SELECT count(*) AS n FROM learning_generation_parts WHERE run_id=?").get(third.id)).toEqual({ n: 0 });
  const fourth = await run(make); learning.deleteMaterial(page, material);
  expect(learning.database.prepare("SELECT count(*) AS n FROM learning_generation_parts WHERE run_id=?").get(fourth.id)).toEqual({ n: 0 });
});

it("scrubs only the fenced version on a late result and removes source-stale diagnostic prose", async () => {
  const make = (wire: Wire) => { const value = response(wire); value.items[0].reviewCheck.role = "concept"; return value; };
  const previous = await run(make);
  diagnosticContext = { ...diagnosticContext, taskVersion: 3 };
  const current = await run(make);
  clearQuizCandidateDiagnostics(learning, page, { taskId: diagnosticContext.taskId, exactVersion: 2 });
  expect(detail(previous.id)).toBeUndefined(); expect(detail(current.id)).toBeDefined();
  // Explicit offline source-corruption injection, not an edit of a score/status.
  learning.database.prepare("UPDATE learning_materials SET original=? WHERE id=?").run(Buffer.from("[synthetic] replaced source"), material);
  expect(() => repo.assertSources(page, current.id)).toThrow("source_changed");
  expect(detail(current.id)).toBeUndefined();
});

it("does not parse or rewrite malformed legacy diagnostics during expiry or version cleanup", async () => {
  const result = await run(wire => { const value = response(wire); value.items[0].reviewCheck.role = "concept"; return value; });
  // Existing malformed legacy field, injected without changing business state.
  learning.database.prepare("UPDATE learning_generation_parts SET diagnostics_json='not-json' WHERE run_id=?").run(result.id);
  expect(() => clearQuizCandidateDiagnostics(learning, page)).not.toThrow();
  expect(() => clearQuizCandidateDiagnostics(learning, page, { taskId: diagnosticContext.taskId, exceptVersion: 3 })).not.toThrow();
  expect(() => repo.list(page)).not.toThrow();
  expect(learning.database.prepare("SELECT diagnostics_json FROM learning_generation_parts WHERE run_id=?").get(result.id))
    .toEqual({ diagnostics_json: "not-json" });
});

it("bounds and allowlists the stored projection, strips secrets and never keeps private reasoning or input material fields", () => {
  const secret = "sk-syntheticSecretOnly123456789";
  const raw = { items: Array.from({ length: 50 }, () => ({ stem: "x".repeat(10000), correctOptionId: "A", privateReasoning: "private-thought",
    sourceText: "unneeded-source", apiKey: secret, reviewCheck: { role: `Bearer ${secret}`, objectiveIds: ["intersection"] } })) };
  const result = quizCandidateDiagnostics(raw, [{ index: -1, stage: "envelope", code: "structure_or_evidence" }], {
    runId: randomUUID(), partId: "questions-0", requestId: "synthetic", context: diagnosticContext });
  expect(result.truncated).toBe(true); expect(result.candidates).toHaveLength(12); expect(result.omittedCandidates).toBe(38);
  expect(JSON.stringify(result).length).toBeLessThan(54000);
  expect(JSON.stringify(result)).not.toMatch(/private-thought|unneeded-source|syntheticSecretOnly|apiKey|privateReasoning|sourceText/);
});
