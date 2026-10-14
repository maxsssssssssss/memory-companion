// @vitest-environment node
// Synthetic formal-service regressions for comprehensive Windows findings F1-F5.
// Original 12-response replay remains a separate, byte-preserving evidence run.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReferencedGeneratedQuiz, type SavedQuiz } from "@/lib/domain/learning-quiz";
import { LearningRepository } from "./repository";
import { LearningQuizRepository } from "./quiz-repository";
import { composedQuizRequest } from "./quiz-composition";
import { bindQuizOptionExplanation, hasQuizPositionDependency, limitReferencedQuizCandidates } from "./quiz-grounding";

const setStem = "已知集合 A={1,2,3}，B={3,4}。A∩B 是什么？";
const setTexts = ["{1,2}", "{1,2,3,4}", "{3}", "∅"];
let root: string, learning: LearningRepository, quiz: LearningQuizRepository, page: string, material: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "learning-option-identity-synthetic-"));
  learning = new LearningRepository(root, "identity-owner"); quiz = new LearningQuizRepository(learning);
  page = randomUUID(); material = randomUUID();
  learning.create({ id: page, title: "[合成] 选项身份边界" });
  learning.saveMaterials(page, [{ id: material, title: "[合成] 实体、字母与顺序", kind: "text", filename: null,
    bytes: Buffer.from("[合成] 集合 A={1,2,3}，B={3,4}，共有元素只有3，A∩B={3}。缩写 M、S、T 以及 A、B、C 均含三个不同字母。A组有10人，B组有20人，较少人数为10。数列1,2,3的第二项为2，第三个元素为3。方案 A 成本10元，方案 B 成本20元。") }]);
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Network prohibited"); }));
});
afterEach(async () => {
  if (learning.database.open) learning.close();
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true });
});
function begin(stem = setStem, texts = setTexts) {
  const id = randomUUID();
  const input = quiz.begin(page, { id, settings: { materialIds: [material], chapterIds: [], nodeIds: [],
    includeNotes: false, includeSupplements: false, count: 1, difficulty: "standard" } }, 48000)!;
  const scope = { accountId: learning.accountId, pageId: page, requestId: id, expiresAt: Date.now() + 120000 };
  const codec = composedQuizRequest(input, scope), refs = codec.input.materials[0].paragraphs.map(p => p.referenceId!);
  const value = { contractVersion: "references-v2", referenceScope: codec.input.taskContext.referenceScope,
    title: "[合成] 身份检查", reason: null, materialPlan: [{ material: 1, contribution: "实体与显示身份边界", references: refs }],
    items: [{ scenario: null, stem, kind: "concept", stemEvidenceIds: refs, correctOptionId: "C",
      options: texts.map((text, index) => ({ id: String.fromCharCode(65 + index), text,
        reasonParts: [{ text: index === 2 ? "根据题干给定条件，该内容符合所问结果。" : "该内容不符合题干所问结果。", evidenceIds: refs }] })) }] };
  const catalog = input.materials.flatMap(m => m.paragraphs.map(p => ({ referenceId: p.referenceId, text: p.text,
    source: { kind: "material" as const, materialId: m.materialId, paragraph: p.number } })));
  return { id, input, scope, codec, value, catalog };
}
function saved(id: string): SavedQuiz {
  return JSON.parse((learning.database.prepare("SELECT result_json FROM learning_quiz_runs WHERE id=?").get(id) as { result_json: string }).result_json);
}
function complete(state: ReturnType<typeof begin>) {
  const decoded = state.codec.decode(state.value, state.scope);
  const limited = limitReferencedQuizCandidates(decoded, state.catalog, 1);
  quiz.complete(page, state.id, limited);
  return { decoded, limited, stored: saved(state.id) };
}

it.each([
  "选项 A/B 都正确。",
  "选项 C/A 都正确。",
  "选项 C／A 都正确。",
  "选项 C/A/B 都正确。",
  "选项 C、A 都正确。",
  "选项 C 和 A 都正确。",
  "正确答案是第3项。",
  "第二项正确。",
  "正确项 C，正确答案是第3项。",
])("rejects a complete combination/ordinal before partial binding and SQLite publication: %s", phrase => {
  const state = begin(), q = state.value.items[0];
  q.options[2].reasonParts[0].text = phrase;
  expect(hasQuizPositionDependency(phrase, q.stem)).toBe(true);
  expect(bindQuizOptionExplanation(phrase, q.options, "C", q.stem)).toBeNull();
  const { decoded, limited, stored } = complete(state);
  expect(decoded.reason).toContain("位置依赖");
  expect(limited.items).toHaveLength(0);
  expect(stored.questions).toHaveLength(0);
  expect(stored.reason).toContain("位置依赖");
  expect(quiz.list(page).find(r => r.id === state.id)).toMatchObject({ status: "insufficient", count: 0 });
});

it("does not exempt an illegal ordinal clause after legitimate group names", () => {
  const state = begin("A组有10人，B组有20人。较少人数是多少？", ["20", "30", "10", "40"]);
  const q = state.value.items[0], phrase = "A组和B组人数不同，故第二项正确。";
  q.options[2].reasonParts[0].text = phrase;
  expect(hasQuizPositionDependency("A组和B组人数不同", q.stem)).toBe(false);
  expect(hasQuizPositionDependency(phrase, q.stem)).toBe(true);
  expect(bindQuizOptionExplanation(phrase, q.options, "C", q.stem)).toBeNull();
  const { stored } = complete(state);
  expect(stored.questions).toHaveLength(0);
  expect(stored.reason).toContain("位置依赖");
});

it.each([
  { phrase: "选项 A/B 都正确。", stem: setStem, texts: setTexts },
  { phrase: "正确答案是第3项。", stem: setStem, texts: setTexts },
  { phrase: "第二项正确。", stem: setStem, texts: setTexts },
  { phrase: "A组和B组人数不同，故第二项正确。", stem: "A组有10人，B组有20人。较少人数是多少？", texts: ["20", "30", "10", "40"] },
])("rejects supplied positional prose at direct stable-reference repository publication: $phrase", ({ phrase, stem, texts }) => {
  const state = begin(stem, texts);
  const decoded = state.codec.decode(state.value, state.scope);
  expect(decoded.items).toHaveLength(1);
  // Simulate the existing stable-reference generator route after valid reference
  // restoration. Only this synthetic response is changed; no original evidence
  // or stored rows are edited. Deliberately bypass composition and candidate
  // rejection so the repository's final publication fence must reject it.
  const question = ReferencedGeneratedQuiz.shape.items.element.parse(decoded.items[0]);
  question.explanation = phrase;
  question.options.find(option => option.id === "C")!.reason = phrase;
  expect(ReferencedGeneratedQuiz.shape.items.element.safeParse(question).success).toBe(true);
  quiz.complete(page, state.id, { ...decoded, items: [question] });
  const stored = saved(state.id);
  expect(stored.questions).toHaveLength(0);
  expect(stored.reason).toContain("位置依赖");
  expect(stored.reason).not.toContain("题目结构");
  expect(quiz.list(page).find(run => run.id === state.id)).toMatchObject({ status: "insufficient", count: 0 });
});

it.each(["stem", "option"])("rejects an ordinal identity at the %s precheck", target => {
  const state = begin(), q = state.value.items[0];
  if (target === "stem") q.stem += "正确答案是第3项。";
  else q.options[0].text = "第二项正确。";
  const { decoded, stored } = complete(state);
  expect(decoded.reason).toContain("位置依赖");
  expect(stored.questions).toHaveLength(0);
  expect(stored.reason).toContain("位置依赖");
});

it.each([
  { stem: "缩写 M、S、T 含三个字母。有多少个不同字母？", reason: "M、S、T 三个字母各不相同。" },
  { stem: "缩写 A、B、C 含三个字母。有多少个不同字母？", reason: "A、B、C 三个字母各不相同。" },
])("publishes a typed letter enumeration without confusing it with choice IDs: $stem", ({ stem, reason }) => {
  const state = begin(stem, ["1", "2", "3", "4"]), q = state.value.items[0];
  q.options[2].reasonParts[0].text = reason;
  expect(hasQuizPositionDependency(stem, stem)).toBe(false);
  expect(hasQuizPositionDependency(reason, stem)).toBe(false);
  expect(bindQuizOptionExplanation(reason, q.options, "C", stem)).toBe(reason);
  const { decoded, stored } = complete(state);
  expect(decoded.items).toHaveLength(1);
  expect(stored.questions).toHaveLength(1);
  expect(quiz.list(page).find(r => r.id === state.id)).toMatchObject({ status: "completed", count: 1 });
  const question = stored.questions[0];
  expect(question.stem).toBe(stem);
  expect(question.correctOptionId).toBe("C");
  expect(question.options.find(o => o.id === "C")).toMatchObject({ text: "3", reason });
  expect(question.evidence?.map(e => e.quote)).toEqual(state.input.materials[0].paragraphs.map(p => p.text));
  let attempt = quiz.startAttempt(page, { id: randomUUID(), quizId: state.id, mode: "test" });
  expect(JSON.stringify(attempt)).not.toMatch(/correctOptionId|evidenceIds|reasonParts/);
  attempt = quiz.act(page, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "choose", question: 0, optionId: "C" });
  attempt = quiz.act(page, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "finish", question: 0, optionId: null });
  expect(attempt.score).toMatchObject({ correct: 1, total: 1 });
  learning.close(); learning = new LearningRepository(root, "identity-owner"); quiz = new LearningQuizRepository(learning);
  expect(saved(state.id)).toEqual(stored);
  expect(quiz.attempt(page, attempt.id)).toEqual(attempt);
});

it.each([
  "选项 A、B、C 三个字母。",
  "选项 M、S、T 三个字母。",
  "选择 A、B、C 三个字母。",
])("does not use letter-entity masking to exempt an explicit selection: %s", phrase => {
  const state = begin("缩写 A、B、C 含三个字母。有多少个不同字母？", ["1", "2", "3", "4"]), q = state.value.items[0];
  q.options[2].reasonParts[0].text = phrase;
  expect(hasQuizPositionDependency(phrase, q.stem)).toBe(true);
  expect(bindQuizOptionExplanation(phrase, q.options, "C", q.stem)).toBeNull();
  expect(complete(state).stored.questions).toHaveLength(0);
});

it.each([
  { stem: setStem, texts: setTexts, reason: "元素3在A和B中，所以正确项 C。", fragment: "正确选项「{3}」" },
  { stem: setStem, texts: setTexts, reason: "选项 A 只含1和2，漏掉3。", fragment: "选项「{1,2}」" },
  { stem: "A组有10人，B组有20人。较少人数是多少？", texts: ["20", "30", "10", "40"], reason: "A组和B组人数不同，较少人数为10。", fragment: "A组和B组人数不同" },
  { stem: "数列1,2,3中，第二项的值是什么？", texts: ["1", "3", "2", "0"], reason: "数列第二项为2。", fragment: "数列第二项为2。" },
])("keeps typed entities, non-choice ordinals and complete stable-ID binding: $reason", ({ stem, texts, reason, fragment }) => {
  const state = begin(stem, texts), q = state.value.items[0];
  q.options[2].reasonParts[0].text = reason;
  const bound = bindQuizOptionExplanation(reason, q.options, "C", stem);
  expect(bound).not.toBeNull();
  expect(bound).toContain(fragment);
  const { stored } = complete(state);
  expect(stored.questions).toHaveLength(1);
  expect(stored.questions[0].correctOptionId).toBe("C");
  expect(stored.questions[0].options.find(o => o.id === "C")?.reason).toBe(bound);
  expect(new Map(stored.questions[0].options.map(o => [o.id, o.text]))).toEqual(new Map(q.options.map(o => [o.id, o.text])));
});

it.each([
  { phrase: "选项 E 正确。", expected: "选项身份" },
  { phrase: "正确项 A。", expected: "答案" },
])("distinguishes identity and answer errors from ordinal diagnostics: $phrase", ({ phrase, expected }) => {
  const state = begin(), q = state.value.items[0];
  q.options[2].reasonParts[0].text = phrase;
  const { decoded, stored } = complete(state);
  expect(stored.questions).toHaveLength(0);
  expect(decoded.reason).toContain(expected);
  expect(decoded.reason).not.toContain("位置依赖");
});
