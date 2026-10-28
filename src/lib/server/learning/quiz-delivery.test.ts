import { offlineQuizSemanticResponse } from "./testing/quiz-semantic-fixture";
// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SavedQuiz } from "@/lib/domain/learning-quiz";
import { AgentFailure } from "@/lib/server/agent/types";
import { LearningRepository } from "./repository";
import { LearningQuizRepository } from "./quiz-repository";
import { composedQuizRequest, composedQuizPrompt } from "./quiz-composition";
import { compactQuizRequest } from "./quiz-compact";
import { generateLearningQuiz, LEARNING_QUIZ_PROMPT } from "./quiz-service";
import type { generateStudyJson } from "./framework-generator";
import { quizDeliverySummary } from "./quiz-delivery";
import type { QuizReviewContext } from "./quiz-review-purpose";

let root: string, learning: LearningRepository, quizzes: LearningQuizRepository, page: string, material: string;
const config = { baseURL: "https://unused.invalid/v1", apiKey: "synthetic-only", model: "offline",
  maxInputChars: 48000, maxOutputTokens: 8000 };
const settings = (count = 3) => ({ materialIds: [material], chapterIds: [], nodeIds: [], includeNotes: false,
  includeSupplements: false, count, difficulty: "basic" });
type Wire = { materials: Array<{ paragraphs: Array<{ referenceId: string }> }>; taskContext: { referenceScope: string } };
function response(input: Wire, review = false) {
  const refs = [input.materials[0].paragraphs[0].referenceId];
  return { contractVersion: "references-v2", title: "[合成] 集合练习", reason: null,
    materialPlan: [{ material: 1, contribution: "交集、并集与空集", references: refs }],
    items: [
      ["已知集合 A={1,2,3}，B={3,4}。A∩B 是什么？", "{3}", "{1,2,3,4}"],
      ["已知集合 A={1,2,3}，B={3,4}。A∪B 是什么？", "{1,2,3,4}", "{3}"],
      ["已知集合 E={5}，F={6}。E∩F 是什么？", "∅", "{5,6}"]
    ].map(([stem, correct, wrong], index) => ({ focus: `集合判断${index}`, stem, scenario: null, kind: "application", stemEvidenceIds: refs,
      options: [{ id: "F", text: correct, reasonParts: [{ text: index === 0 ? "元素3同时属于 A 和 B，交集只保留共有元素。"
        : index === 1 ? "并集包含至少属于一个集合的元素，重复元素只计一次。" : "E 和 F 分别含元素 5 和 6，没有共同元素，所以交集为空。", evidenceIds: refs }] },
      { id: "A", text: wrong, reasonParts: [{ text: "这与所问运算的定义不同。", evidenceIds: refs }] }],
      correctOptionId: "F", ...(review ? { reviewCheck: { objectiveIds: [`goal${index}`], role: "application", rationale: `检查集合判断${index}` } } : {}) }))
  };
}
function context(): QuizReviewContext {
  return { planId: randomUUID(), taskVersion: 1,
    objectives: [0, 1, 2].map(i => ({ id: `goal${i}`, label: `集合判断${i}`, sources: [{ materialId: material, paragraph: 1 }],
      requirements: [{ role: "application", description: "判断所问集合运算的实际结果", independent: true }] })),
    purpose: { objectiveIds: ["goal0", "goal1", "goal2"], role: "application", method: "retrieval",
      purpose: "检查三个集合运算判断", priorEvidenceRefs: [] } };
}
const provider = (build: (wire: Wire) => unknown) => vi.fn(async (_config, _name, _prompt, input) => _name === "learning_quiz_semantic_review" ? offlineQuizSemanticResponse(input, "F") : build(input as Wire)) as unknown as typeof generateStudyJson;
const saved = (id: string): SavedQuiz => JSON.parse((learning.database.prepare("SELECT result_json FROM learning_quiz_runs WHERE id=?").get(id) as { result_json: string }).result_json);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "quiz-delivery-synthetic-")); learning = new LearningRepository(root, "owner"); quizzes = new LearningQuizRepository(learning);
  page = randomUUID(); material = randomUUID(); learning.create({ id: page, title: "[合成] 可靠交付" });
  learning.saveMaterials(page, [{ id: material, kind: "text", filename: null, title: "[合成] 集合", bytes: Buffer.from(
    "交集包含同时属于两个集合的元素；并集包含至少属于一个集合的元素，集合内重复写元素不增加元素个数。没有共同元素时交集为空。") }]);
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Network prohibited"); }));
});
afterEach(async () => { if (learning.database.open) learning.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

it.each([3, 2, 1, 0])("publishes only the %i reliable candidates with actual source, stable identity and review mapping", async retained => {
  const id = randomUUID(), generate = provider(wire => {
    const value = response(wire, true);
    // Remove the middle candidate first: a later accepted item's goal must not shift.
    for (const index of [1, 2, 0].slice(0, 3 - retained)) {
      if (index === 1) value.items[index].options[1].text = value.items[index].options[0].text;
      else value.items[index].options[0].reasonParts[0].text = "选项 F/A 都正确。";
    }
    return value;
  });
  const rows = await generateLearningQuiz(learning, page, { id, settings: settings() }, { configure: () => config, generate, reviewContext: context() });
  const run = rows.find(r => r.id === id)!;
  expect(run).toMatchObject({ status: retained ? "completed" : "insufficient", count: retained,
    delivery: { requested: 3, candidates: 3, published: retained } });
  expect(run.delivery!.rejected.reduce((sum, issue) => sum + issue.count, 0)).toBe(3 - retained);
  expect(JSON.stringify(run.delivery)).not.toMatch(/correctOptionId|reasonParts|goal\d|元素3|∩|F\/A/);
  expect(generate).toHaveBeenCalledTimes(retained ? 2 : 1); expect(fetch).not.toHaveBeenCalled();
  if (!retained) {
    expect(() => quizzes.startAttempt(page, { id: randomUUID(), quizId: id, mode: "test" })).toThrow("quiz_not_ready");
    expect(run.delivery!.message).toContain("未能生成可靠"); expect(run.delivery!.message).not.toContain("依据不足");
    return;
  }
  const expectedGoals = retained === 3 ? ["goal0", "goal1", "goal2"] : retained === 2 ? ["goal0", "goal2"] : ["goal0"];
  expect(quizzes.review(page, id)!.checks.map(check => [check.questionIndex, check.objectiveIds[0]]))
    .toEqual(expectedGoals.map((goal, index) => [index, goal]));
  let attempt = quizzes.startAttempt(page, { id: randomUUID(), quizId: id, mode: "test" });
  expect(JSON.stringify(attempt)).not.toMatch(/correctOptionId|feedback|rationale/);
  const original = saved(id);
  for (const q of attempt.questions) attempt = quizzes.act(page, { id: randomUUID(), attemptId: attempt.id,
    revision: attempt.revision, action: "choose", question: q.index, optionId: "F" });
  const event = { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "finish", question: 0, optionId: null };
  attempt = quizzes.act(page, event); expect(attempt.score?.correct).toBe(retained);
  expect(quizzes.act(page, event)).toEqual(attempt);
  learning.close(); learning = new LearningRepository(root, "owner"); quizzes = new LearningQuizRepository(learning);
  expect(saved(id)).toEqual(original); expect(quizzes.attempt(page, attempt.id)).toEqual(attempt);
  expect(quizzes.list(page).find(r => r.id === id)!.delivery).toEqual(run.delivery);
});

it.each(["bad-format", "wrong-binding", "null", "unknown-reference"])("never repairs an explicitly invalid binding or evidence: %s", async mode => {
  const id = randomUUID(), generate = provider(wire => {
    const value = response(wire);
    if (mode === "unknown-reference") value.items.forEach(q => { q.stemEvidenceIds = ["r999"]; });
    else Object.assign(value, { referenceScope: mode === "bad-format" ? "not-a-binding" : mode === "null" ? null : "f".repeat(64) });
    return value;
  });
  const rows = await generateLearningQuiz(learning, page, { id, settings: settings() }, { configure: () => config, generate });
  const run = rows[0];
  expect(run).toMatchObject({ status: mode === "unknown-reference" ? "insufficient" : "failed", count: 0 });
  expect(run.delivery!.published).toBe(0);
  expect(run.delivery!.candidates).toBe(mode === "unknown-reference" ? 3 : null);
  expect(run.delivery!.rejected[0].code).toBe(mode === "wrong-binding" || mode === "unknown-reference" ? "source_binding" : "format");
  expect(JSON.stringify(run.delivery)).not.toContain("not-a-binding"); expect(generate).toHaveBeenCalledTimes(1);
});

it.each(["omit", "valid"])("binds composed requests on the server with %s echo, keeping account/page/request/expiry/replay guards", mode => {
  const id = randomUUID(), input = quizzes.begin(page, { id, settings: settings() }, 48000)!;
  const scope = { accountId: learning.accountId, pageId: page, requestId: id, expiresAt: Date.now() + 120000 };
  const codec = composedQuizRequest(input, scope), value = response(codec.input);
  if (mode === "valid") Object.assign(value, { referenceScope: codec.input.taskContext.referenceScope });
  for (const field of ["accountId", "pageId", "requestId"] as const) expect(() => codec.decode(value, { ...scope, [field]: randomUUID() })).toThrow("source_changed");
  const decoded = codec.decode(value, scope);
  expect(() => codec.decode(value, scope)).toThrow("source_changed");
  quizzes.complete(page, id, decoded); expect(saved(id).questions).toHaveLength(3);
  const expired = composedQuizRequest(input, { ...scope, expiresAt: 0 });
  expect(() => expired.decode(response(expired.input), { ...scope, expiresAt: 0 })).toThrow("source_changed");
  const directCompact = compactQuizRequest(input, scope);
  const { materialPlan: _plan, ...compactEnvelope } = value;
  expect(directCompact.schema.safeParse(compactEnvelope).success).toBe(mode === "valid");
  const prompt = composedQuizPrompt(LEARNING_QUIZ_PROMPT);
  expect(prompt).toContain("referenceScope是应用已绑定"); expect(prompt).not.toContain('"referenceScope":"原样回传');
});

it("rechecks deletion before publishing even without a model-echoed digest", () => {
  const id = randomUUID(), input = quizzes.begin(page, { id, settings: settings() }, 48000)!;
  const scope = { accountId: learning.accountId, pageId: page, requestId: id, expiresAt: Date.now() + 120000 };
  const codec = composedQuizRequest(input, scope), decoded = codec.decode(response(codec.input), scope);
  learning.deleteMaterial(page, material);
  expect(() => quizzes.complete(page, id, decoded)).toThrow("framework_terminal");
  expect(quizzes.list(page).find(run => run.id === id)!.count).toBe(0);
});

it("keeps explicit known failure, budget and true unknown distinct without automatic retries", async () => {
  for (const code of ["known_failure", "budget", "unknown"] as const) {
    const id = randomUUID(), generate = provider(() => { throw new AgentFailure(code, code === "budget" ? "agent_call_limit" : "synthetic_failure"); });
    const rows = await generateLearningQuiz(learning, page, { id, settings: settings() }, { configure: () => config, generate });
    expect(rows[0]).toMatchObject({ status: "failed", count: 0, delivery: { candidates: null,
      rejected: [{ code: code === "known_failure" ? "known_failure" : code, count: 1 }] } });
    expect(generate).toHaveBeenCalledTimes(1);
    if (code === "unknown") {
      await generateLearningQuiz(learning, page, { id, settings: settings(), resume: true }, { configure: () => config, generate });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(quizzes.list(page)[0].progress?.uncertain).toBe(true);
    }
  }
});

it("does not invent candidate count or failure cause for old insufficient rows", () => {
  const result = quizDeliverySummary({ requested: 3, published: 0, status: "insufficient", failure: null });
  expect(result.candidates).toBeNull(); expect(result.rejected).toEqual([]);
  expect(result.message).not.toContain("材料不足导致"); expect(result.message).not.toContain("掌握了");
});

it.each(["format", "budget", "unknown"])("handles a later %s part without losing failure identity or reissuing it", async failure => {
  const id = randomUUID(); let calls = 0;
  const generate = provider(wire => {
    calls++;
    if (calls === 1) return { ...response(wire), items: response(wire).items.slice(0, 2) };
    if (failure === "format") return { ...response(wire), referenceScope: "broken" };
    throw new AgentFailure(failure === "budget" ? "budget" : "unknown", failure === "budget" ? "agent_call_limit" : "synthetic_unknown");
  });
  const rows = await generateLearningQuiz(learning, page, { id, settings: settings() },
    { configure: () => ({ ...config, maxOutputTokens: 1800 }), generate });
  const run = rows[0];
  expect(calls).toBe(2);
  expect(run).toMatchObject(failure === "format" ? { status: "completed", count: 2,
    delivery: { requested: 3, published: 2, candidates: null, rejected: [{ code: "format", count: 1 }] },
    progress: { completed: 3, total: 4, canResume: false, uncertain: false } }
    : { status: "failed", count: 0, progress: { canResume: false, uncertain: failure === "unknown" } });
  if (failure === "format") {
    expect(run.delivery!.message).toContain("已保留可用题目");
    const attempt = quizzes.startAttempt(page, { id: randomUUID(), quizId: id, mode: "test" });
    expect(attempt.questions).toHaveLength(2); expect(JSON.stringify(attempt)).not.toContain("correctOptionId");
    const part = learning.database.prepare("SELECT state,failure FROM learning_generation_parts WHERE run_id=? AND part_id='questions-1'").get(id);
    expect(part).toEqual({ state: "failed", failure: "generation_part_failed" });
    await generateLearningQuiz(learning, page, { id, settings: settings(), resume: true }, { configure: () => config, generate });
    expect(calls).toBe(2);
  }
});

it("counts different rejected candidates across surplus filtering and final cross-part duplicate checks once each", () => {
  const summary = quizDeliverySummary({ requested: 3, published: 1, status: "completed", failure: null,
    reports: [
      { candidates: 2, rejected: [{ index: 0, code: "repeated_focus" }], forwardedIndexes: [1] },
      { candidates: 1, rejected: [], forwardedIndexes: [0] }
    ],
    publicationReport: { candidates: 2, rejected: [{ index: 1, code: "repeated_focus" }] } });
  expect(summary).toMatchObject({ candidates: 3, published: 1, rejected: [{ code: "repeated_focus", count: 2 }] });
});

it.each([1, 0])("uses actual counts when a short response has %i candidates and omits a shortage reason", async count => {
  const id = randomUUID(), generate = provider(wire => ({ ...response(wire), items: response(wire).items.slice(0, count) }));
  const rows = await generateLearningQuiz(learning, page, { id, settings: settings() }, { configure: () => config, generate });
  expect(rows[0]).toMatchObject({ status: count ? "completed" : "insufficient", count,
    delivery: { requested: 3, candidates: count, published: count, rejected: [] } });
  expect(rows[0].reason).toContain("未提供减少原因");
  expect(generate).toHaveBeenCalledTimes(count ? 2 : 1);
  if (count) expect(quizzes.startAttempt(page, { id: randomUUID(), quizId: id, mode: "test" }).questions).toHaveLength(1);
});

it.each(["all-invalid", "partial"])("rejects equivalent empty-set choices through codec and SQLite publication (%s)", async mode => {
  const id = randomUUID(), generate = provider(wire => {
    const value = response(wire);
    // The browser's unchanged candidate used these two spellings for the same
    // mathematical empty set. Stable identities must not make it single-answer.
    value.items[2].options[1].text = "{}";
    return { ...value, items: mode === "all-invalid" ? [value.items[2]] : value.items };
  });
  const rows = await generateLearningQuiz(learning, page, { id, settings: settings(mode === "all-invalid" ? 1 : 3) }, { configure: () => config, generate });
  expect(rows[0]).toMatchObject({ status: mode === "all-invalid" ? "insufficient" : "completed", count: mode === "all-invalid" ? 0 : 2,
    delivery: { rejected: [{ code: "equivalent_options", count: 1 }] } });
  const original = saved(id);
  if (mode === "all-invalid") expect(() => quizzes.startAttempt(page, { id: randomUUID(), quizId: id, mode: "test" })).toThrow("quiz_not_ready");
  else {
    expect(original.questions.map(q => q.correctOptionId)).toEqual(["F", "F"]);
    expect(original.questions.map(q => q.stem)).toEqual(["已知集合 A={1,2,3}，B={3,4}。A∩B 是什么？", "已知集合 A={1,2,3}，B={3,4}。A∪B 是什么？"]);
    expect(quizzes.startAttempt(page, { id: randomUUID(), quizId: id, mode: "test" }).questions).toHaveLength(2);
  }
  learning.close(); learning = new LearningRepository(root, "owner"); quizzes = new LearningQuizRepository(learning);
  expect(saved(id)).toEqual(original); expect(generate).toHaveBeenCalledTimes(mode === "partial" ? 2 : 1); expect(fetch).not.toHaveBeenCalled();
});

it.each(["字符串", "表示法"])("does not collapse distinct empty-set spellings when the question concerns %s", async topic => {
  learning.deleteMaterial(page, material); material = randomUUID();
  learning.saveMaterials(page, [{ id: material, kind: "text", filename: null, title: "[合成] 表示",
    bytes: Buffer.from("集合的表示法中，∅使用一个数学符号，{}使用左右两个花括号。作为字符串，两者的字符数量不同。") }]);
  const id = randomUUID(), generate = provider(wire => {
    const value = response(wire), item = value.items[2];
    item.stem = `讨论集合的${topic}，哪一种写法只包含一个字符？`;
    item.options[1].text = "{}";
    item.options[0].reasonParts[0].text = "空集符号只包含一个字符。";
    item.options[1].reasonParts[0].text = "左右花括号是两个字符。";
    return { ...value, items: [item] };
  });
  const rows = await generateLearningQuiz(learning, page, { id, settings: settings(1) }, { configure: () => config, generate });
  expect(rows[0]).toMatchObject({ status: "completed", count: 1, delivery: { rejected: [] } });
  expect(saved(id).questions[0].options.map(option => option.text).sort()).toEqual(["{}", "∅"].sort());
  const attempt = quizzes.startAttempt(page, { id: randomUUID(), quizId: id, mode: "test" });
  expect(JSON.stringify(attempt)).not.toContain("correctOptionId"); expect(fetch).not.toHaveBeenCalled();
});
