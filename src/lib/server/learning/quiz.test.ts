import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningRepository } from "./repository";
import { LearningFrameworkRepository } from "./framework-repository";
import { LearningQuizRepository } from "./quiz-repository";
import { generateLearningQuiz } from "./quiz-service";
import type { QuizConfig, QuizAttemptView, QuizActionInput } from "@/lib/domain/learning-quiz";

let root: string, learning: LearningRepository, quiz: LearningQuizRepository, page: string, material: string;
const config = { baseURL: "https://tokenhub.vision-intelligence.tech/v1", apiKey: "SYNTHETIC", model: "deepseek-v4-pro", maxInputChars: 24000, maxOutputTokens: 6000 };
const settings = (extra: Partial<QuizConfig> = {}): QuizConfig => ({ materialIds: [material], chapterIds: [], nodeIds: [], includeNotes: false, includeSupplements: false, count: 2, difficulty: "standard", ...extra });
const model = (count = 2) => ({ title: "[合成] 条件判断", reason: count < 2 ? "[合成] 本范围仅足以支持这些题，不凑数。" : null, items: Array.from({ length: count }, (_, i) => ({ stem: `[合成] 第${i + 1}题：没有满足前提时如何判断？`, kind: "application", options: [{ id: "A", text: "不能应用规则", reason: "[合成] 正确原因 SECRET_REASON" }, { id: "B", text: "规则判定未达标", reason: "[合成] 未满足前提不同于判定失败" }], correctOptionId: "A", explanation: "SECRET_EXPLANATION", hint: "[合成] 先思考判断步骤。", sources: [{ kind: "material", materialId: material, paragraph: 1 }, { kind: "material", materialId: material, paragraph: 2 }] })) });
// Service mocks implement the current provider wire contract; legacy repository
// fixtures above remain unchanged to cover historical stored objects.
const compactModel = async (_config: unknown, _name: unknown, _prompt: unknown, input: unknown) => {
  const wire = input as { taskContext: { referenceScope: string }; materials: Array<{ paragraphs: Array<{ referenceId: string }> }> };
  const refs = wire.materials[0].paragraphs.map(p => p.referenceId);
  return { contractVersion: "references-v2", referenceScope: wire.taskContext.referenceScope, title: model().title, reason: null,
    materialPlan: [{ material: 1, contribution: "[模拟] 规则与前提", references: refs }],
    items: model().items.map(({ sources: _sources, explanation, ...q }, i) => ({ ...q, focus: `[模拟] 考点${i}`, stemEvidenceIds: refs,
      explanationParts: [{ text: explanation, evidenceIds: refs }],
      options: q.options.map(({ reason, ...o }) => ({ ...o, reasonParts: [{ text: reason, evidenceIds: refs }] })) })) };
};
function publish(count = 2) { const id = randomUUID(); quiz.begin(page, { id, settings: settings() }, 24000); quiz.complete(page, id, model(count)); return id; }
function start(mode: "practice" | "test" = "practice", quizId = publish()) { return quiz.startAttempt(page, { id: randomUUID(), quizId, mode }); }
function act(a: QuizAttemptView, action: QuizActionInput["action"], question = 0, optionId: string | null = null) { return quiz.act(page, { id: randomUUID(), attemptId: a.id, revision: a.revision, action, question, optionId }); }
function framework() {
  const f = new LearningFrameworkRepository(learning), id = randomUUID(); f.begin(page, { id, materialIds: [material] }, 24000); f.validating(page, id);
  f.complete(page, id, { overview: "[合成]", chapters: [{ title: "[合成]", explanation: "EXCLUDED_FRAMEWORK_BODY", nodes: [{ title: "[合成]", explanation: "EXCLUDED_NODE_BODY", supplement: "[合成补充] conjunction 指所有条件同时成立。", sources: [{ materialId: material, paragraph: 1 }] }] }] });
  const c = f.view(page).chapters[0]; f.edit(page, { kind: "node", chapterId: c.id, nodeId: c.nodes[0].id, revision: c.revision, title: c.nodes[0].title, explanation: "EXCLUDED_EDITED_BODY", note: "[合成笔记] 私人补充标记" }); return f.view(page).chapters[0];
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "learning-quiz-synthetic-")); learning = new LearningRepository(root, "owner"); quiz = new LearningQuizRepository(learning); page = randomUUID(); material = randomUUID(); learning.create({ id: page, title: "[合成 Quiz 测试]" }); learning.saveMaterials(page, [{ id: material, title: "[合成]", kind: "text", filename: null, bytes: Buffer.from("[合成] 规则只在前提成立时适用。\n\n[合成] 反例不满足前提，不能应用规则。") }]); vi.stubGlobal("fetch", vi.fn(() => { throw Error("Network forbidden"); })); });
afterEach(async () => { if (learning.database.open) learning.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

it("migrates schema6 additively, preserving text and framework exactly", () => {
  framework(); const before = new LearningFrameworkRepository(learning).view(page), source = learning.source(page, material);
  learning.database.exec("DROP TABLE learning_quiz_attempts; DROP TABLE learning_quiz_runs; PRAGMA user_version=6"); learning.close();
  learning = new LearningRepository(root, "owner"); expect(learning.database.pragma("user_version", { simple: true })).toBe(11);
  expect(new LearningFrameworkRepository(learning).view(page)).toEqual(before); expect(learning.source(page, material)).toEqual(source); expect(learning.database.pragma("foreign_key_check")).toEqual([]);
});
it("generates directly without framework, saves/reopens, no extra Provider request for answers", async () => {
  const generate = vi.fn(compactModel), id = randomUUID();
  const runs = await generateLearningQuiz(learning, page, { id, settings: settings() }, { configure: () => config, generate });
  expect(runs[0].status).toBe("completed"); expect(new LearningFrameworkRepository(learning).view(page).chapters).toEqual([]);
  let a = start("practice", id); a = act(a, "choose", 0, "A"); a = act(a, "submit");
  expect(a.questions[0].feedback?.correct).toBe(true); learning.close(); learning = new LearningRepository(root, "owner"); quiz = new LearningQuizRepository(learning);
  expect(quiz.attempt(page, a.id)).toEqual(a); expect(generate).toHaveBeenCalledTimes(1); expect(globalThis.fetch).not.toHaveBeenCalled();
});
it("keeps all answer fields and sources off the wire before allowed feedback; test reveal is forbidden", () => {
  let a = start("test"); const hidden = (v: unknown) => { const text = JSON.stringify(v); for (const s of ["correctOptionId", "SECRET_REASON", "SECRET_EXPLANATION", "paragraphSha256", "feedback"]) expect(text).not.toContain(s); };
  hidden(quiz.list(page)); hidden(a); expect(() => quiz.readSource(page, a.id, 0, 0)).toThrow("quiz_answers_hidden"); expect(() => act(a, "reveal")).toThrow("quiz_answers_hidden");
  a = act(a, "choose", 0, "A"); a = act(a, "submit"); hidden(a); expect(a.score).toBeNull();
  a = act(a, "skip", 1); expect(a.completed).toBe(true); expect(a.questions[0].feedback?.correctOptionId).toBe("A"); expect(a.score?.correct).toBe(1);
});
it("records hints, reveals and skips without claiming unassisted correct", () => {
  let a = start(); a = act(a, "hint"); a = act(a, "choose", 0, "A"); a = act(a, "submit"); a = act(a, "reveal", 1);
  expect(a.score).toEqual({ correct: 1, total: 2, unassistedCorrect: 0, hinted: 1, revealed: 1, skipped: 0 });
  expect(quiz.readSource(page, a.id, 0, 0)).toMatchObject({ kind: "material", paragraph: { number: 1 } });
});
it("saves each selection and safely finalizes unanswered questions", () => {
  let a = start("test"); a = act(a, "choose", 0, "B"); expect(quiz.attempt(page, a.id).questions[0].progress.optionId).toBe("B");
  a = act(a, "finish"); expect(a.score).toEqual({ correct: 0, total: 2, unassistedCorrect: 0, hinted: 0, revealed: 0, skipped: 1 });
  expect(() => act(a, "choose", 0, "A")).toThrow("quiz_attempt_complete");
});
it("duplicate generation/attempt/action receipts do not replay, and concurrent edits are fenced", async () => {
  const id = randomUUID(), generate = vi.fn(compactModel), v = { id, settings: settings() };
  await generateLearningQuiz(learning, page, v, { configure: () => config, generate }); await generateLearningQuiz(learning, page, v, { configure: () => config, generate }); expect(generate).toHaveBeenCalledTimes(1);
  expect(() => quiz.begin(page, { ...v, settings: settings({ count: 3 }) }, 24000)).toThrow("submission_conflict");
  const begin = { id: randomUUID(), quizId: id, mode: "practice" }; const a = quiz.startAttempt(page, begin); expect(quiz.startAttempt(page, begin)).toEqual(a);
  const event = { id: randomUUID(), attemptId: a.id, revision: a.revision, action: "choose", question: 0, optionId: "A" };
  const next = quiz.act(page, event); expect(quiz.act(page, event)).toEqual(next); expect(() => quiz.act(page, { ...event, optionId: "B" })).toThrow("submission_conflict"); expect(() => act(a, "skip")).toThrow("quiz_edit_conflict");
  expect(() => quiz.startAttempt(page, { ...begin, id: randomUUID() })).toThrow("submission_conflict");
});
it("uses selected chapter/node paragraphs, never edited framework, and only opted-in extras", () => {
  const c = framework(), base = settings({ materialIds: [], chapterIds: [c.id] });
  const i = quiz.begin(page, { id: randomUUID(), settings: base }, 24000)!;
  expect(i.materials[0].paragraphs.map(p => p.number)).toEqual([1]); expect(JSON.stringify(i)).not.toContain("EXCLUDED"); expect(i.extras).toEqual([]);
  quiz.fail(page, quiz.list(page)[0].id, "synthetic");
  const id = randomUUID(), v = settings({ materialIds: [], nodeIds: [c.nodes[0].id], includeNotes: true, includeSupplements: true });
  const opted = quiz.begin(page, { id, settings: v }, 24000)!; expect(opted.extras.map(e => e.kind)).toEqual(["note", "supplement"]);
  const m = model(1); m.items[0].sources = [{ kind: "note", id: opted.extras[0].id }] as never; quiz.complete(page, id, m);
  const a = act(start("practice", id), "reveal"); expect(quiz.readSource(page, a.id, 0, 0)).toEqual({ kind: "note", text: c.nodes[0].note });
});
it("new groups preserve old questions, grades and original source identities", () => {
  let a = start(); a = act(a, "choose", 0, "A"); a = act(a, "finish"); const before = quiz.attempt(page, a.id); publish();
  expect(quiz.attempt(page, a.id)).toEqual(before); expect(quiz.list(page)).toHaveLength(2);
});
it("deletes only the chosen group and its attempts/checkpoints, retaining a replay tombstone after reopen", () => {
  framework();
  const originalFramework = new LearningFrameworkRepository(learning).view(page), originalMaterial = learning.source(page, material);
  const deleted = publish(), kept = publish(), attempt = start("practice", deleted), otherAttempt = start("test", kept);
  learning.database.prepare("INSERT INTO learning_generation_parts(page_id,kind,run_id,part_id,input_hash,material_ids,state,result_json) VALUES(?,'quiz',?,'questions-0','synthetic',?,'completed',?)")
    .run(page, deleted, JSON.stringify([material]), JSON.stringify(model()));
  quiz.delete(page, deleted); quiz.delete(page, deleted);
  expect(quiz.list(page).map(q => q.id)).toEqual([kept]);
  expect(() => quiz.attempt(page, attempt.id)).toThrow("quiz_not_found");
  expect(quiz.attempt(page, otherAttempt.id)).toEqual(otherAttempt);
  expect(new LearningFrameworkRepository(learning).view(page)).toEqual(originalFramework);
  expect(learning.source(page, material)).toEqual(originalMaterial);
  expect(learning.database.prepare("SELECT * FROM learning_generation_parts WHERE run_id=?").all(deleted)).toEqual([]);
  expect(learning.database.prepare("SELECT status,settings_json,binding_json,binding_hash,result_json,diagnostics_json,failure,deadline FROM learning_quiz_runs WHERE id=?").get(deleted))
    .toEqual({ status: "deleted", settings_json: "{}", binding_json: "{}", binding_hash: "", result_json: null, diagnostics_json: null, failure: null, deadline: 0 });
  learning.close(); learning = new LearningRepository(root, "owner"); quiz = new LearningQuizRepository(learning);
  expect(quiz.list(page).map(q => q.id)).toEqual([kept]);
  expect(() => quiz.begin(page, { id: deleted, settings: settings() }, 24000)).toThrow("quiz_deleted");
  expect(() => quiz.begin(page, { id: deleted, settings: settings({ count: 3 }), resume: true }, 24000)).toThrow("quiz_deleted");
  expect(() => start("test", deleted)).toThrow("quiz_deleted");
  learning.deletePage(page);
  expect(learning.database.prepare("SELECT * FROM learning_quiz_runs WHERE page_id=?").all(page)).toEqual([]);
});
it("group deletion fences stale answer writes from another connection and rejects other account/page deletion", () => {
  const attempt = start(), second = randomUUID(); learning.create({ id: second, title: "[合成] 其他学习页" });
  const intruder = new LearningRepository(root, "intruder"), stale = new LearningRepository(root, "owner");
  try {
    expect(() => new LearningQuizRepository(intruder).delete(page, attempt.quizId)).toThrow("page_not_found");
    expect(() => quiz.delete(second, attempt.quizId)).toThrow("quiz_not_found");
    expect(() => quiz.delete(page, randomUUID())).toThrow("quiz_not_found");
    expect(new LearningQuizRepository(stale).attempt(page, attempt.id)).toEqual(attempt);
    quiz.delete(page, attempt.quizId);
    expect(() => new LearningQuizRepository(stale).act(page, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "choose", question: 0, optionId: "A" })).toThrow("quiz_not_found");
    expect(() => quiz.readSource(page, attempt.id, 0, 0)).toThrow("quiz_not_found");
    expect(learning.database.prepare("SELECT * FROM learning_quiz_attempts WHERE quiz_id=?").all(attempt.quizId)).toEqual([]);
  } finally { intruder.close(); stale.close(); }
});
it("group delete failure rolls back both content and attempts", () => {
  const attempt = start(), groups = quiz.list(page);
  learning.database.exec("CREATE TRIGGER synthetic_delete_failure BEFORE UPDATE ON learning_quiz_runs WHEN NEW.status='deleted' BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END");
  expect(() => quiz.delete(page, attempt.quizId)).toThrow("synthetic disk failure");
  expect(quiz.list(page)).toEqual(groups); expect(quiz.attempt(page, attempt.id)).toEqual(attempt);
});
it("deleting an in-flight group prevents late publication, checkpoint resurrection and duplicate generation", async () => {
  let done!: (value: unknown) => void;
  const id = randomUUID(), request = { id, settings: settings() }, generate = vi.fn((_config: unknown, _name: unknown, _prompt: unknown, _input: unknown) => new Promise(resolve => { done = resolve; }));
  const pending = generateLearningQuiz(learning, page, request, { configure: () => config, generate });
  await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
  const lateResponse = await compactModel(...generate.mock.calls[0]);
  quiz.delete(page, id);
  done(lateResponse); expect(await pending).toEqual([]);
  expect(() => quiz.complete(page, id, model())).toThrow("quiz_deleted");
  await expect(generateLearningQuiz(learning, page, request, { configure: () => config, generate })).rejects.toThrow("quiz_deleted");
  expect(generate).toHaveBeenCalledTimes(1);
  expect(learning.database.prepare("SELECT * FROM learning_generation_parts WHERE run_id=?").all(id)).toEqual([]);
  expect(learning.database.prepare("SELECT status,result_json FROM learning_quiz_runs WHERE id=?").get(id)).toEqual({ status: "deleted", result_json: null });
  expect(() => publish()).not.toThrow();
});
it("honestly represents insufficient count and refuses empty attempts, duplicate stems and invalid sources", () => {
  const id = publish(0); expect(quiz.list(page)[0]).toMatchObject({ status: "insufficient", count: 0 }); expect(() => start("practice", id)).toThrow("quiz_not_ready");
  const small = publish(1); expect(quiz.list(page).find(r => r.id === small)?.reason).toBeTruthy();
  for (const mutate of [(m: ReturnType<typeof model>) => { m.items[1].stem = m.items[0].stem; }, (m: ReturnType<typeof model>) => { m.items[0].sources[0].paragraph = 999; }, (m: ReturnType<typeof model>) => { m.items[0].options[1].id = "A"; }]) {
    const run = randomUUID(); quiz.begin(page, { id: run, settings: settings() }, 24000); const m = model(); mutate(m); expect(() => quiz.complete(page, run, m)).toThrow(); quiz.fail(page, run, "synthetic_invalid");
  }
});
it("provider or validation failure preserves old groups and sources; unknown IDs are not retried", async () => {
  const old = publish(), id = randomUUID(), generate = vi.fn(async () => { throw Error("secret response body"); });
  await generateLearningQuiz(learning, page, { id, settings: settings() }, { configure: () => config, generate });
  await generateLearningQuiz(learning, page, { id, settings: settings() }, { configure: () => config, generate });
  expect(generate).toHaveBeenCalledTimes(1); expect(quiz.list(page).find(q => q.id === old)?.status).toBe("completed"); expect(quiz.list(page)[0].failure).toBe("framework_provider_failed"); expect(JSON.stringify(quiz.list(page))).not.toContain("secret"); expect(learning.source(page, material).paragraphs).toHaveLength(2);
});
it("publication storage failure rolls back the new group; expires abandoned requests without replay", async () => {
  const old = publish(), id = randomUUID();
  learning.database.exec("CREATE TRIGGER synthetic_quiz_write_failure BEFORE UPDATE ON learning_quiz_runs WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END");
  await generateLearningQuiz(learning, page, { id, settings: settings() }, { configure: () => config, generate: vi.fn(compactModel) });
  expect(quiz.list(page).find(r => r.id === id)).toMatchObject({ status: "failed", failure: "learning_storage_unavailable", count: 0 });
  expect(quiz.list(page).find(r => r.id === old)?.status).toBe("completed"); learning.database.exec("DROP TRIGGER synthetic_quiz_write_failure");
  const late = randomUUID(); quiz.begin(page, { id: late, settings: settings() }, 24000); learning.database.prepare("UPDATE learning_quiz_runs SET deadline=0 WHERE id=?").run(late);
  expect(() => quiz.complete(page, late, model())).toThrow("framework_terminal"); expect(quiz.list(page).find(r => r.id === late)?.status).toBe("failed");
});
it("scope changes or opted-in note edits fence generation, while old saved answers remain readable", () => {
  const c = framework(), id = randomUUID(); quiz.begin(page, { id, settings: settings({ includeNotes: true }) }, 24000);
  new LearningFrameworkRepository(learning).edit(page, { kind: "node", chapterId: c.id, nodeId: c.nodes[0].id, revision: c.revision, title: c.nodes[0].title, explanation: c.nodes[0].explanation, note: "[合成] 改变" });
  expect(() => quiz.complete(page, id, model())).toThrow("source_changed"); quiz.fail(page, id, "source_changed");
  const next = randomUUID(); quiz.begin(page, { id: next, settings: settings() }, 24000); learning.database.prepare("UPDATE learning_materials SET original=? WHERE id=?").run(Buffer.from("[合成] 内容变化"), material); expect(() => quiz.complete(page, next, model())).toThrow("source_changed");
});
it("delete material retains outcomes but invalidates source access and late publication", () => {
  let a = start(); const id = randomUUID(); quiz.begin(page, { id, settings: settings() }, 24000); learning.deleteMaterial(page, material);
  expect(() => quiz.complete(page, id, model())).toThrow("framework_terminal"); a = act(a, "reveal"); expect(a.questions[0].feedback?.sources[0].state).toBe("material_deleted"); expect(() => quiz.readSource(page, a.id, 0, 0)).toThrow("material_deleted");
  expect(() => quiz.begin(page, { id: randomUUID(), settings: settings() }, 24000)).toThrow("material_deleted");
  expect((learning.database.prepare("SELECT original FROM learning_materials WHERE id=?").get(material) as { original: null }).original).toBeNull();
});
it("delete page clears all quiz objects and rejects late generation or answer writes", () => {
  const a = start(), id = randomUUID(); quiz.begin(page, { id, settings: settings() }, 24000); learning.deletePage(page);
  for (const table of ["learning_quiz_runs", "learning_quiz_attempts"]) expect((learning.database.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n).toBe(0);
  expect(() => quiz.complete(page, id, model())).toThrow("page_deleted"); expect(() => act(a, "hint")).toThrow("page_deleted");
});
it("cross-account and cross-page reads/writes/sources fail", () => {
  const a = start(), other = new LearningRepository(root, "intruder"), q = new LearningQuizRepository(other);
  try { expect(() => q.list(page)).toThrow("page_not_found"); expect(() => q.attempt(page, a.id)).toThrow("page_not_found"); expect(() => q.readSource(page, a.id, 0, 0)).toThrow("page_not_found"); expect(() => q.startAttempt(page, { id: randomUUID(), quizId: a.quizId, mode: "test" })).toThrow("page_not_found"); } finally { other.close(); }
  const second = randomUUID(); learning.create({ id: second, title: "[合成] 第二页" }); expect(() => quiz.attempt(second, a.id)).toThrow("quiz_not_found"); expect(() => quiz.begin(second, { id: randomUUID(), settings: settings() }, 24000)).toThrow("material_not_found");
});
it("never ignores unparsed PDF or missing transcription; source budgets reject before any request", () => {
  learning.database.prepare("UPDATE learning_materials SET kind='pdf' WHERE id=?").run(material);
  expect(() => quiz.begin(page, { id: randomUUID(), settings: settings() }, 24000)).toThrow("pdf_not_parsed");
  learning.database.prepare("UPDATE learning_materials SET kind='audio' WHERE id=?").run(material);
  expect(() => quiz.begin(page, { id: randomUUID(), settings: settings() }, 24000)).toThrow("audio_not_transcribed");
  learning.database.prepare("UPDATE learning_materials SET kind='text' WHERE id=?").run(material);
  const accepted=quiz.begin(page, { id: randomUUID(), settings: settings() }, 5);
  expect(accepted?.materials[0].paragraphs.map(p=>p.text)).toEqual(learning.source(page,material).paragraphs.map(p=>p.text));expect(quiz.list(page)).toHaveLength(1);
});
it("transcript sources preserve time positions and replacement invalidates old source links", () => {
  const hash = learning.database.prepare("SELECT original FROM learning_materials WHERE id=?").get(material) as { original: Buffer };
  const source = learning.source(page, material); learning.database.prepare("UPDATE learning_materials SET kind='audio' WHERE id=?").run(material);
  const { createHash } = require("node:crypto"); const sha = createHash("sha256").update(hash.original).digest("hex");
  const paragraphs = source.paragraphs.map((p, i) => ({ ...p, startSeconds: i * 10, endSeconds: i * 10 + 5 }));
  learning.database.prepare("INSERT INTO learning_audio_transcripts(material_id,original_sha256,text,paragraphs_json) VALUES(?,?,?,?)").run(material, sha, source.text, JSON.stringify(paragraphs));
  const a = act(start(), "reveal"); expect(a.questions[0].feedback?.sources[1]).toMatchObject({ startSeconds: 10, endSeconds: 15 });
  paragraphs[1].startSeconds = 11; learning.database.prepare("UPDATE learning_audio_transcripts SET paragraphs_json=? WHERE material_id=?").run(JSON.stringify(paragraphs), material);
  expect(() => quiz.readSource(page, a.id, 0, 1)).toThrow("source_changed");
});
it("checks exact option evidence against selected paragraphs and uses non-answer-bearing hints only for new groups",()=>{
  const id=randomUUID();quiz.begin(page,{id,settings:settings()},24000);const generated=model();
  const grounded={...generated,items:generated.items.map(q=>({...q,evidence:[{source:q.sources[0],quote:learning.source(page,material).paragraphs[0].text}],options:q.options.map(o=>({...o,evidenceIndexes:[0]})),hint:"A 是答案，不能应用规则"}))};
  grounded.items[0].evidence[0].quote="未提供且已变义的文字";expect(()=>quiz.complete(page,id,grounded)).toThrow("quiz_grounding_invalid");
  grounded.items[0].evidence[0].quote=learning.source(page,material).paragraphs[0].text;
  const originalSources=grounded.items[0].sources;
  grounded.items[0].sources=[originalSources[1]];
  expect(()=>quiz.complete(page,id,grounded)).toThrow("quiz_grounding_invalid");
  grounded.items[0].sources=originalSources;
  quiz.complete(page,id,grounded);
  let a=start("practice",id);expect(JSON.stringify(a)).not.toContain("evidenceIndexes");a=act(a,"hint");expect(a.questions[0].hint).not.toContain("A 是答案");expect(a.questions[0].hint).toContain("适用前提");
});
