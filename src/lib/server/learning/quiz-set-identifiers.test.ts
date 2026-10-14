// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SavedQuiz } from "@/lib/domain/learning-quiz";
import { LearningRepository } from "./repository";
import { LearningQuizRepository } from "./quiz-repository";
import { composedQuizRequest } from "./quiz-composition";
import { bindQuizOptionExplanation, hasQuizPositionDependency, limitReferencedQuizCandidates } from "./quiz-grounding";

let root: string, learning: LearningRepository, quiz: LearningQuizRepository, page: string, material: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "learning-set-identifiers-synthetic-"));
  learning = new LearningRepository(root, "owner"); quiz = new LearningQuizRepository(learning);
  page = randomUUID(); material = randomUUID(); learning.create({ id: page, title: "[合成] 集合" });
  learning.saveMaterials(page, [{ id: material, title: "[合成] 集合定义", kind: "text", filename: null,
    bytes: Buffer.from("[合成] 集合 A={1,2}、B={2,3} 都是非空集合，E 和 F 都是空集。A∩B 和 A∪B 分别表示交集和并集；交集为 {2}，并集为 {1,2,3}。不能直接把 A、B 的元素个数相加作为并集元素个数，因为共有元素只计一次。\n\n[合成] 集合忽略元素顺序与重复元素：{1,2}={2,1}={1,1,2}，{1,2,3,3,4}={1,2,3,4}；这些是相同集合的不同写法。") }]);
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Network prohibited"); }));
});
afterEach(async () => {
  if (learning.database.open) learning.close();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true });
});
function begin() {
  const id = randomUUID(), input = quiz.begin(page, { id, settings: { materialIds: [material], chapterIds: [], nodeIds: [],
    includeNotes: false, includeSupplements: false, count: 1, difficulty: "standard" } }, 48000)!;
  const scope = { accountId: learning.accountId, pageId: page, requestId: id, expiresAt: Date.now() + 120000 };
  const codec = composedQuizRequest(input, scope);
  const references = codec.input.materials[0].paragraphs.map(p => p.referenceId!);
  const value = { contractVersion: "references-v2", referenceScope: codec.input.taskContext.referenceScope, title: "[合成] 集合复习", reason: null,
    materialPlan: [{ material: 1, contribution: "[合成] 集合的共有元素", references }], items: [{
      scenario: null as string | null, stem: "已知集合 A={1,2}，B={2,3}，两者的交集是什么？", kind: "concept", stemEvidenceIds: references,
      correctOptionId: "A", explanationParts: [{ text: "交集只包含两者共有的元素。", evidenceIds: references }],
      options: [
        { id: "A", text: "{2}", reasonParts: [{ text: "只有元素 2 为两者共有。", evidenceIds: references }] },
        { id: "B", text: "{1,2,3}", reasonParts: [{ text: "这是并集，并非交集。", evidenceIds: references }] },
        { id: "C", text: "{1}", reasonParts: [{ text: "元素 1 并非两者共有。", evidenceIds: references }] },
        { id: "D", text: "{3}", reasonParts: [{ text: "元素 3 并非两者共有。", evidenceIds: references }] }
      ] }] };
  return { id, input, scope, codec, value };
}
function saved(id: string): SavedQuiz {
  return JSON.parse((learning.database.prepare("SELECT result_json FROM learning_quiz_runs WHERE id=?").get(id) as { result_json: string }).result_json);
}
const entities = ["A∩B 和 A∪B", "A 和 B 都是非空集合", "E 和 F 都是空集", "把 A、B 的元素个数相加", "集合 A 和 B 的共有元素"];
it.each(entities)("does not mistake the explicit set entity for an option combination: %s", text => {
  expect(hasQuizPositionDependency(text)).toBe(false);
  const options = begin().value.items[0].options;
  expect(bindQuizOptionExplanation(text, options, "A")).toBe(text);
});
it.each(["A和B都正确", "选项A和B都是非空集合", "答案E和F都是空集", "选项 A∩B", "A项和B项都正确", "以上皆是", "第二个选项正确", "第2题的A项正确", "第2题的 A∩B 和 A∪B", "A∩B 和 A∪B，所以第二个选项正确", "正确项B", "错误项A", "选项F"])("still rejects option identity, position or answer contradictions: %s", text => {
  expect(bindQuizOptionExplanation(text, begin().value.items[0].options, "A")).toBeNull();
});
it.each(["选项：A 和 B 都是非空集合", "选项中 A 和 B 都是非空集合", "答案是 A 和 B 都是非空集合", "正确项分别为 A 和 B 都是非空集合"])("does not mask mathematical prose with an explicit choice prefix: %s", text => {
  expect(hasQuizPositionDependency(text)).toBe(true);
  expect(bindQuizOptionExplanation(text, begin().value.items[0].options, "A")).toBeNull();
});
it.each(["第1题：A∩B 和 A∪B 含义不同，交集是什么？", "[合成] 第1题：交集是什么？", "第1题 已知集合的交集是什么？"])("keeps a self-contained numbered stem: %s", stem => {
  expect(hasQuizPositionDependency(stem)).toBe(false);
  const { id, scope, codec, value } = begin(); value.items[0].stem = stem;
  quiz.complete(page, id, codec.decode(value, scope));
  expect(saved(id).questions).toHaveLength(1);
  expect(saved(id).questions[0].stem).toBe(stem);
});
it.each(["根据第2题的 A∩B 和 A∪B 判断。", "第2题  的 A∩B 和 A∪B", "第1题：根据第2题的结果判断。"])("does not confuse cross-question dependence with a leading label: %s", stem => {
  expect(hasQuizPositionDependency(stem)).toBe(true);
  const { id, scope, codec, value } = begin(); value.items[0].stem = stem;
  quiz.complete(page, id, codec.decode(value, scope));
  expect(saved(id).questions).toHaveLength(0);
});
it("keeps the self-numbered stem when publication joins it after its scenario", () => {
  const { id, scope, codec, value } = begin(), q = value.items[0];
  q.scenario = "已知集合 A={1,2}，B={2,3}。";
  q.stem = "第1题：已知集合的交集是什么？";
  const fullStem = `${q.scenario}\n\n${q.stem}`;
  quiz.complete(page, id, codec.decode(value, scope));
  expect(saved(id).questions).toHaveLength(1);
  expect(saved(id).questions[0].stem).toBe(fullStem);
});
it("still rejects a cross-question dependency in the scenario before a self-numbered stem", () => {
  const { id, scope, codec, value } = begin(), q = value.items[0];
  q.scenario = "根据第2题的 A∩B 和 A∪B 判断。";
  q.stem = "第1题：集合的交集是什么？";
  quiz.complete(page, id, codec.decode(value, scope));
  expect(saved(id).questions).toHaveLength(0);
});
it("preserves source-bound set prose, stable answer/evidence and secrecy through publication and reopening", () => {
  const { id, input, scope, codec, value } = begin(), q = value.items[0];
  q.scenario = "A 和 B 都是非空集合；E 和 F 都是空集。";
  q.stem = "A∩B 和 A∪B 含义不同；根据所给集合，两者交集是什么？";
  q.options[1].text = "把 A、B 的元素个数相加";
  q.options[1].reasonParts[0].text = "不能把 A、B 的元素个数相加用作共有元素的集合。";
  q.explanationParts[0].text = "A∩B 和 A∪B 含义不同。正确项A只保留共有元素。";
  q.options.reverse();
  quiz.complete(page, id, codec.decode(value, scope));
  const original = saved(id), result = original.questions[0];
  expect(original.questions).toHaveLength(1);
  expect(result.correctOptionId).toBe("A");
  expect(result.explanation).toBe("A∩B 和 A∪B 含义不同。正确选项「{2}」只保留共有元素。");
  expect(result.options.find(o => o.id === "A")?.evidenceIds).toEqual(input.materials[0].paragraphs.map(p => p.referenceId));
  expect(result.evidence?.map(e => e.quote)).toEqual(input.materials[0].paragraphs.map(p => p.text));
  let attempt = quiz.startAttempt(page, { id: randomUUID(), quizId: id, mode: "test" });
  expect(JSON.stringify(attempt)).not.toMatch(/correctOptionId|evidenceIds|feedback|reasonParts/);
  attempt = quiz.act(page, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "choose", question: 0, optionId: "A" });
  learning.close(); learning = new LearningRepository(root, "owner"); quiz = new LearningQuizRepository(learning);
  expect(saved(id)).toEqual(original); expect(quiz.attempt(page, attempt.id)).toEqual(attempt);
  attempt = quiz.act(page, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "finish", question: 0, optionId: null });
  expect(attempt.score).toMatchObject({ correct: 1, total: 1 });
  expect(fetch).not.toHaveBeenCalled();
});
it.each([["{1,2}", "{2,1}"], ["{1,2}", "{1,1,2}"], ["{1,2,3,3,4}", "{1,2,3,4}"]])("rejects equivalent literal-set options %s and %s before selecting or publishing a single answer", (a, b) => {
  const { id, input, scope, codec, value } = begin(), q = value.items[0];
  q.stem = "哪一个是包含两个元素的集合？"; q.options[0].text = a; q.options[1].text = b;
  const decoded = codec.decode(value, scope);
  const catalog = input.materials.flatMap(m => m.paragraphs.map(p => ({ referenceId: p.referenceId, text: p.text,
    source: { kind: "material" as const, materialId: m.materialId, paragraph: p.number } })));
  expect(limitReferencedQuizCandidates(decoded, catalog, 1).items).toHaveLength(0);
  quiz.complete(page, id, decoded);
  expect(saved(id).questions).toHaveLength(0);
  expect(quiz.list(page).find(r => r.id === id)).toMatchObject({ status: "insufficient", count: 0 });
  expect(saved(id).reason).toContain("选项重复");
});
it.each(["两个集合不同", "{1,2,3,3,4} 与 {1,2,3,4} 是不同的集合", "{1,2,3,3,4} ≠ {1,2,3,4}"])("rejects a marked correct assertion that repeated elements create a different literal set: %s", answer => {
  const { id, scope, codec, value } = begin(), q = value.items[0];
  q.stem = "比较集合 {1,2,3,3,4} 与 {1,2,3,4}，哪项说法正确？";
  q.options[0].text = answer; q.options[1].text = "两个集合相同";
  quiz.complete(page, id, codec.decode(value, scope));
  expect(saved(id).questions).toHaveLength(0);
  expect(saved(id).reason).toContain("显式整数集合的相等关系矛盾");
});
it.each([false, true])("keeps a legitimate equality lesson or an explicit incorrect-statement question (negative=%s)", negative => {
  const { id, scope, codec, value } = begin(), q = value.items[0];
  q.stem = `比较集合 {1,2,3,3,4} 与 {1,2,3,4}，哪项说法${negative ? "错误" : "正确"}？`;
  q.options[0].text = negative ? "两个集合不同" : "两个集合相同";
  q.options[1].text = negative ? "两个集合相同" : "两个集合不同";
  quiz.complete(page, id, codec.decode(value, scope));
  expect(saved(id).questions).toHaveLength(1);
});
it.each(["哪一个字符串的文字与原文完全相同？", "哪一个多重集合有重复元素？", "哪一个序列保留原始顺序？", "集合的哪种字面写法与原文一致？"])("does not impose set equality on order, multiplicity or text identity: %s", stem => {
  const { id, scope, codec, value } = begin(), q = value.items[0];
  q.stem = stem; q.options[0].text = "{1,2}"; q.options[1].text = "{2,1}"; q.options[2].text = "{1,1,2}";
  quiz.complete(page, id, codec.decode(value, scope));
  expect(saved(id).questions).toHaveLength(1);
});
it("does not let the entity exemption bypass source evidence or answer contradictions", () => {
  for (const badEvidence of [false, true]) {
    const { id, scope, codec, value } = begin(), q = value.items[0];
    q.explanationParts[0].text = `A∩B 和 A∪B 是集合表达式。${badEvidence ? "" : "正确项B只保留共有元素。"}`;
    if (badEvidence) q.options[0].reasonParts[0].evidenceIds = ["r999"];
    quiz.complete(page, id, codec.decode(value, scope));
    expect(saved(id).questions).toHaveLength(0);
  }
});
