import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LearningRepository } from "./repository";
import { LearningQuizRepository } from "./quiz-repository";
import type { QuizConfig } from "@/lib/domain/learning-quiz";

let root: string, learning: LearningRepository, quiz: LearningQuizRepository, page: string, material: string;
const tempPrefix = join(tmpdir(), "learning-quiz-failure-synthetic-");
beforeEach(async () => {
  root = await mkdtemp(tempPrefix);
  learning = new LearningRepository(root, "owner"); quiz = new LearningQuizRepository(learning);
  page = randomUUID(); material = randomUUID();
  learning.create({ id: page, title: "[合成] 预读失败展示" });
  learning.saveMaterials(page, [{ id: material, title: "[合成] 材料", kind: "text", filename: null, bytes: Buffer.from("[合成] 规则须满足前提。") }]);
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Network forbidden"); }));
});
afterEach(async () => {
  if (learning.database.open) learning.close();
  vi.unstubAllGlobals();
  if (!resolve(root).startsWith(resolve(tempPrefix))) throw Error("Unexpected synthetic test directory");
  await rm(root, { recursive: true, force: true });
});
function begin() {
  const id = randomUUID();
  const settings: QuizConfig = { materialIds: [material], chapterIds: [], nodeIds: [], includeNotes: false, includeSupplements: false, count: 1, difficulty: "standard" };
  quiz.begin(page, { id, settings }, 24000);
  return id;
}
function part(runId: string, partId: string, state = "failed", failure = "generation_part_failed", diagnostics: string | null = null, attempts = 1, kind = "quiz") {
  learning.database.prepare("INSERT INTO learning_generation_parts(page_id,kind,run_id,part_id,input_hash,material_ids,state,attempts,failure,diagnostics_json,result_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(page, kind, runId, partId, "synthetic-old-hash", JSON.stringify([material]), state, attempts, failure, diagnostics,
      state === "completed" ? '{ "items": [], "limitation": "[合成] 已读" }' : null);
}
function stored() {
  return JSON.stringify({ runs: learning.database.prepare("SELECT * FROM learning_quiz_runs ORDER BY rowid").all(),
    parts: learning.database.prepare("SELECT * FROM learning_generation_parts ORDER BY rowid").all() });
}

it("derives the legacy reference failure and disables unsafe resume without rewriting rows or diagnostic bytes", () => {
  const old = begin();
  quiz.complete(page, old, { title: "[合成] 已有题组", reason: null, items: [{ stem: "[合成] 何时应用规则？", kind: "concept",
    options: [{ id: "A", text: "前提满足时", reason: "[合成] 满足前提" }, { id: "B", text: "任意时候", reason: "[合成] 忽略前提" }],
    correctOptionId: "A", explanation: "[合成] 规则须满足前提。", hint: "[合成] 查看前提", sources: [{ kind: "material", materialId: material, paragraph: 1 }] }] });
  const oldView = quiz.list(page)[0], source = learning.source(page, material);
  const id = begin();
  const diagnostics = '{ "validationResult": "failed", "validationIssues": [{"path":"items[4].references[10]","code":"invalid_string"}], "validationIssueCount": 1 }';
  part(id, "reading-0", "completed"); part(id, "reading-1", "failed", "generation_part_failed", diagnostics); part(id, "reading-2", "pending");
  quiz.fail(page, id, "quiz_invalid_result");
  const before = stored();
  expect(quiz.list(page).find(r => r.id === id)).toMatchObject({ status: "failed", failure: "quiz_reading_invalid_source", count: 0,
    progress: { completed: 1, total: 3, canResume: false, uncertain: false } });
  expect(quiz.list(page).find(r => r.id === old)).toEqual(oldView);
  expect(stored()).toBe(before); expect(learning.source(page, material)).toEqual(source);
  expect(JSON.stringify(quiz.list(page))).not.toContain("items[4].references[10]");
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it.each([null, "not-json", '{"validationResult":"failed","validationIssues":[{"path":"items[0].title","code":"too_big"}]}'])(
  "asks to restart legacy reading with unavailable or non-reference diagnostics: %s", diagnostics => {
    const id = begin(); part(id, "reading-0", "failed", "generation_part_failed", diagnostics); quiz.fail(page, id, "quiz_invalid_result");
    const before = stored();
    expect(quiz.list(page)[0]).toMatchObject({ failure: "quiz_reading_restart_required", progress: { canResume: false } });
    expect(stored()).toBe(before);
  });

it("recognizes legacy grounding failures only from the failed pre-reading part", () => {
  const id = begin(); part(id, "reading-0", "failed", "quiz_grounding_invalid"); quiz.fail(page, id, "quiz_grounding_invalid");
  expect(quiz.list(page)[0]).toMatchObject({ failure: "quiz_reading_invalid_source", progress: { canResume: false } });
});

it.each([
  ["quiz_invalid_result", "questions-0", "failed", "quiz", true],
  ["quiz_grounding_invalid", "questions-0", "failed", "quiz", true],
  ["quiz_invalid_result", "reading-0", "completed", "quiz", false],
  ["quiz_invalid_result", "reading-0", "failed", "framework", undefined],
  ["source_changed", "reading-0", "failed", "quiz", true],
  ["quiz_reading_invalid_result", "reading-0", "failed", "quiz", true],
  ["quiz_selection_invalid_result", "selection-0", "failed", "quiz", true],
  ["quiz_reading_restart_required", "reading-0", "failed", "quiz", false],
] as const)("preserves the distinct failure %s in %s/%s/%s", (failure, partId, state, kind, canResume) => {
  const id = begin(); part(id, partId, state, "generation_part_failed", null, 1, kind); quiz.fail(page, id, failure);
  const before = stored(), result = quiz.list(page)[0];
  expect(result.failure).toBe(failure); expect(result.progress?.canResume).toBe(canResume); expect(stored()).toBe(before);
});

it("keeps the retry ceiling for a new reading failure", () => {
  const id = begin(); part(id, "reading-0", "failed", "quiz_reading_invalid_result", null, 2); quiz.fail(page, id, "quiz_reading_invalid_result");
  expect(quiz.list(page)[0]).toMatchObject({ failure: "quiz_reading_invalid_result", progress: { canResume: false } });
});
