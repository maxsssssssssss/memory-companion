// @vitest-environment node
// Synthetic regression built from the phrases supplied in Windows repair 2.
// This is not a replay of the three original responses: that evidence package
// was not supplied with these fixtures. Do not relabel these as the 12 originals.
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

const abDefinition = "已知集合 A={1,2,3}，B={3,4}。";
const efDefinition = "已知集合 E={5}，F={6}。";
const suppliedPhrases = [
  { text: "同时属于 A 和 B", definition: abDefinition },
  { text: "属于 A 或 B", definition: abDefinition },
  { text: "E 和 F 分别含元素 5 和 6", definition: efDefinition },
  { text: "E 和 F 都非空", definition: efDefinition },
  { text: "元素 3 同时属于 A 和 B，应在 A∩B 中，与该选项说 3 不属于 A∩B 相反。", definition: abDefinition },
  { text: "E 和 F 分别含元素 5 和 6，它们没有共同元素才导致交集为空，而不是因为集合本身为空。", definition: efDefinition },
];
let root: string, learning: LearningRepository, quiz: LearningQuizRepository, page: string, material: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "learning-set-context-synthetic-"));
  learning = new LearningRepository(root, "owner"); quiz = new LearningQuizRepository(learning);
  page = randomUUID(); material = randomUUID(); learning.create({ id: page, title: "[合成] 集合语境回归" });
  learning.saveMaterials(page, [{ id: material, title: "[合成] 集合语境与去重", kind: "text", filename: null,
    bytes: Buffer.from(`[合成] ${abDefinition}交集只包含同时属于 A 和 B 的元素，因此 A∩B={3}；并集包含属于 A 或 B 的元素，因此 A∪B={1,2,3,4}。\n\n[合成] ${efDefinition}E 和 F 分别含元素 5 和 6，E 和 F 都非空；它们没有共同元素，因此 E∩F=∅，E∪F={5,6}。\n\n[合成] 集合忽略元素顺序与重复：{a,a,b}={b,a}={a,a,a,b}={a,b,b}，这些集合均含两个元素；{a,c}也含两个元素但不是前面的集合。{1,2,3,4}={1,2,3,3,4}。`) }]);
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Network prohibited"); }));
});
afterEach(async () => {
  if (learning.database.open) learning.close();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true });
});
function begin(definition = abDefinition) {
  const id = randomUUID(), input = quiz.begin(page, { id, settings: { materialIds: [material], chapterIds: [], nodeIds: [],
    includeNotes: false, includeSupplements: false, count: 1, difficulty: "standard" } }, 48000)!;
  const scope = { accountId: learning.accountId, pageId: page, requestId: id, expiresAt: Date.now() + 120000 };
  const codec = composedQuizRequest(input, scope), references = codec.input.materials[0].paragraphs.map(p => p.referenceId!);
  const isEf = definition === efDefinition;
  const texts = isEf ? ["E∩F=∅，E∪F={5,6}", "E∩F={5,6}，E∪F=∅", "E∩F=∅，E∪F={5}", "E∩F=∅，E∪F={6}"] : ["{3}", "{1,2}", "{1,2,3,4}", "∅"];
  const reasons = isEf ? ["没有共同元素，所有元素合并后为 {5,6}。", "没有共同元素不代表集合本身为空。", "并集中不能漏掉元素 6。", "并集中不能漏掉元素 5。"]
    : ["只有元素 3 同时属于两个集合。", "所列元素不是两个集合共有的元素，并且漏掉共有元素 3。", "这是并集，包含仅属于其中一个集合的元素。", "两者共有元素 3，交集并非空集。"];
  const value = { contractVersion: "references-v2", referenceScope: codec.input.taskContext.referenceScope, title: "[合成] 语境回归题组", reason: null,
    materialPlan: [{ material: 1, contribution: "[合成] 集合的归属与表示", references }], items: [{
      scenario: null as string | null, stem: `${definition}${isEf ? "交集和并集分别是什么？" : "交集是什么？"}`, kind: "concept", stemEvidenceIds: references,
      correctOptionId: "A", explanationParts: [{ text: reasons[0], evidenceIds: references }],
      options: texts.map((text, index) => ({ id: String.fromCharCode(65 + index), text, reasonParts: [{ text: reasons[index], evidenceIds: references }] }))
    }] };
  return { id, input, scope, codec, value };
}
function saved(id: string): SavedQuiz {
  return JSON.parse((learning.database.prepare("SELECT result_json FROM learning_quiz_runs WHERE id=?").get(id) as { result_json: string }).result_json);
}
function catalog(input: ReturnType<typeof begin>["input"]) {
  return input.materials.flatMap(m => m.paragraphs.map(p => ({ referenceId: p.referenceId, text: p.text,
    source: { kind: "material" as const, materialId: m.materialId, paragraph: p.number } })));
}

it.each(suppliedPhrases)("recognizes supplied set phrase without rewriting it: $text", ({ text, definition }) => {
  const options = begin(definition).value.items[0].options;
  expect(hasQuizPositionDependency(text)).toBe(false);
  expect(hasQuizPositionDependency(text, definition)).toBe(false);
  expect(bindQuizOptionExplanation(text, options, "A")).toBe(text);
  expect(bindQuizOptionExplanation(text, options, "A", definition)).toBe(text);
});
it.each([abDefinition, efDefinition])("uses explicit definitions only for same-question bare entity context: %s", definition => {
  const phrase = definition === abDefinition ? "元素 3 在 A 和 B 中" : "元素 5 不同时在 E 和 F 中";
  const options = begin(definition).value.items[0].options;
  expect(hasQuizPositionDependency(phrase)).toBe(true);
  expect(bindQuizOptionExplanation(phrase, options, "A")).toBeNull();
  expect(hasQuizPositionDependency(phrase, definition)).toBe(false);
  expect(bindQuizOptionExplanation(phrase, options, "A", definition)).toBe(phrase);
});
it("does not import unrelated entity definitions into the current question", () => {
  expect(hasQuizPositionDependency("元素 5 不同时在 E 和 F 中", abDefinition)).toBe(true);
  expect(bindQuizOptionExplanation("元素 5 不同时在 E 和 F 中", begin().value.items[0].options, "A", abDefinition)).toBeNull();
});
it.each(["A和B都正确", "选项 A 和 B", "选项 A 和 B 都非空", "答案是 E 和 F 都非空", "答案属于 A 或 B", "答案只能属于 A 或 B", "正确答案应当属于 A 和 B", "选项中只有 A 和 B 都非空", "以上皆是", "第二个选项正确", "第2题中的 A 和 B", "正确项B", "错误项A"])("preserves identity, cross-question, ordinal and contradiction rejection: %s", text => {
  expect(bindQuizOptionExplanation(text, begin().value.items[0].options, "A", `${abDefinition}${efDefinition}`)).toBeNull();
});
it("keeps a reason about set membership even when it discusses an incorrect option", () => {
  const text = "该选项忽略了元素 3 同时属于 A 和 B。";
  const { id, scope, codec, value } = begin();
  expect(hasQuizPositionDependency(text, abDefinition)).toBe(false);
  expect(bindQuizOptionExplanation(text, value.items[0].options, "A", abDefinition)).toBe(text);
  value.items[0].options[1].reasonParts[0].text = text;
  quiz.complete(page, id, codec.decode(value, scope));
  expect(saved(id).questions).toHaveLength(1);
  expect(saved(id).questions[0].options.find(o => o.id === "B")?.reason).toBe(text);
});

it.each(suppliedPhrases.map((phrase, index) => ({ ...phrase, contextInScenario: index % 2 === 0 })))("publishes supplied phrase with explicit same-question context (scenario=$contextInScenario): $text", ({ text, definition, contextInScenario }) => {
  const { id, scope, codec, value } = begin(definition), q = value.items[0];
  if (contextInScenario) { q.scenario = definition; q.stem = definition === efDefinition ? "交集和并集分别是什么？" : "交集是什么？"; }
  // The user-supplied full sentences explain an incorrect option. Keep the
  // exact sentence bytes and bind to that option; do not edit it to force PASS.
  q.options[1].reasonParts[0].text = text;
  quiz.complete(page, id, codec.decode(value, scope));
  expect(saved(id).questions).toHaveLength(1);
  expect(saved(id).questions[0].options.find(o => o.id === "B")?.reason).toBe(text);
});
it.each([
  { definition: abDefinition, phrase: "元素 3 在 A 和 B 中", contextInScenario: false },
  { definition: abDefinition, phrase: "元素 3 在 A 和 B 中", contextInScenario: true },
  { definition: efDefinition, phrase: "元素 5 不同时在 E 和 F 中", contextInScenario: false },
  { definition: efDefinition, phrase: "元素 5 不同时在 E 和 F 中", contextInScenario: true },
])("passes same-question definitions through codec and publication (scenario=$contextInScenario): $phrase", ({ definition, phrase, contextInScenario }) => {
  const { id, scope, codec, value } = begin(definition), q = value.items[0];
  if (contextInScenario) { q.scenario = definition; q.stem = definition === efDefinition ? "交集和并集分别是什么？" : "交集是什么？"; }
  q.explanationParts[0].text = phrase;
  quiz.complete(page, id, codec.decode(value, scope));
  expect(saved(id).questions).toHaveLength(1);
  expect(saved(id).questions[0].explanation).toBe(phrase);
});
it("does not borrow definitions from another candidate in the same response or from source text", () => {
  const { id, input, scope, codec, value } = begin(efDefinition);
  const second = structuredClone(value.items[0]);
  second.stem = `${abDefinition}交集是什么？`;
  second.options.forEach((option, index) => {
    option.text = ["{3}", "{1,2}", "{1,2,3,4}", "∅"][index];
    option.reasonParts[0].text = "按集合的共有元素判断。";
  });
  // E/F are in the first question and selected material but not this question.
  second.explanationParts[0].text = "元素 5 不同时在 E 和 F 中";
  value.items.push(second);
  const decoded = codec.decode(value, scope);
  expect(limitReferencedQuizCandidates(decoded, catalog(input), 2).items).toHaveLength(1);
  quiz.complete(page, id, decoded);
  expect(saved(id).questions).toHaveLength(1);
  expect(saved(id).questions[0].stem).toContain(efDefinition);
  expect(saved(id).reason).toContain("解析选项引用不明确");
});
it("retains supplied explanation, original IDs, source evidence and answer secrecy through submit and SQLite reopen", () => {
  const { id, input, scope, codec, value } = begin(), q = value.items[0];
  const originalReason = suppliedPhrases[4].text;
  q.options[1].reasonParts[0].text = originalReason;
  q.options.reverse();
  quiz.complete(page, id, codec.decode(value, scope));
  const original = saved(id), question = original.questions[0];
  expect(original.questions).toHaveLength(1);
  expect(question.correctOptionId).toBe("A");
  expect(question.options.find(o => o.id === "B")?.reason).toBe(originalReason);
  expect(question.options.find(o => o.id === "B")?.evidenceIds).toEqual(input.materials[0].paragraphs.map(p => p.referenceId));
  expect(question.evidence?.map(e => e.quote)).toEqual(input.materials[0].paragraphs.map(p => p.text));
  let attempt = quiz.startAttempt(page, { id: randomUUID(), quizId: id, mode: "test" });
  expect(JSON.stringify(attempt)).not.toMatch(/correctOptionId|evidenceIds|feedback|reasonParts|同时属于/);
  attempt = quiz.act(page, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "choose", question: 0, optionId: "A" });
  learning.close(); learning = new LearningRepository(root, "owner"); quiz = new LearningQuizRepository(learning);
  expect(saved(id)).toEqual(original); expect(quiz.attempt(page, attempt.id)).toEqual(attempt);
  attempt = quiz.act(page, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "finish", question: 0, optionId: null });
  expect(attempt.score).toMatchObject({ correct: 1, total: 1 });
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  { name: "symbol sets from the supplied counterexample", stem: "集合 {a,a,b} 与哪个集合含有相同数量的元素？", options: ["{b,a}", "{a,a,a,b}", "{a,b,b}", "{a,c}"], reason: "这个集合也含两个不同的元素，与题干集合的元素个数相同。" },
  { name: "integer sets from the supplied counterexample", stem: "与集合 {1,2,3,4} 相同的集合是哪个？", options: ["{1,2,3,4}", "{1,2,3,3,4}", "{1,2}", "{3,4}"], reason: "去除重复元素后得到 {1,2,3,4}，与题干集合相同。" },
])("rejects equivalent options independently of letter-position heuristics: $name", ({ stem, options, reason }) => {
  const { id, input, scope, codec, value } = begin(), q = value.items[0];
  q.stem = stem; q.explanationParts[0].text = reason;
  q.options.forEach((o, index) => { o.text = options[index]; o.reasonParts[0].text = index < 2 ? reason : "按材料中的集合定义检查不同元素。"; });
  for (const text of [q.stem, reason, ...options]) expect(hasQuizPositionDependency(text)).toBe(false);
  const decoded = codec.decode(value, scope);
  expect(limitReferencedQuizCandidates(decoded, catalog(input), 1).items).toHaveLength(0);
  quiz.complete(page, id, decoded);
  expect(saved(id).questions).toHaveLength(0);
  expect(saved(id).reason).toContain("选项重复");
  expect(saved(id).reason).not.toContain("解析选项引用不明确");
  expect(quiz.list(page).find(r => r.id === id)).toMatchObject({ status: "insufficient", count: 0 });
});
it("keeps a single-answer cardinality question with distinct finite literal sets", () => {
  const { id, scope, codec, value } = begin(), q = value.items[0];
  q.stem = "集合 {a,a,b} 与哪个集合含有相同数量的元素？";
  const texts = ["{b,a}", "{a}", "{a,b,c}", "{}"], reasons = ["这个集合恰有两个不同元素。", "这个集合只有一个元素。", "这个集合有三个不同元素。", "空集没有元素。"];
  q.explanationParts[0].text = reasons[0];
  q.options.forEach((o, index) => { o.text = texts[index]; o.reasonParts[0].text = reasons[index]; });
  quiz.complete(page, id, codec.decode(value, scope));
  expect(saved(id).questions).toHaveLength(1);
});
it("does not confuse equal cardinalities of different sets with duplicate set values", () => {
  const { id, scope, codec, value } = begin(), q = value.items[0];
  q.stem = "与集合 {a,b} 相等的集合是哪个？";
  const texts = ["{b,a}", "{a,c}", "{b,c}", "{c,d}"];
  q.explanationParts[0].text = "集合相等需要包含完全相同的元素，元素个数相同并不充分。";
  q.options.forEach((o, index) => { o.text = texts[index]; o.reasonParts[0].text = index === 0 ? "成员完全相同，仅顺序不同。" : "成员与题干集合不同。"; });
  quiz.complete(page, id, codec.decode(value, scope));
  expect(saved(id).questions).toHaveLength(1);
});
it.each(["foreign evidence", "wrong correct identity"])("does not let valid set context bypass publication gates: %s", failure => {
  const { id, scope, codec, value } = begin(), q = value.items[0];
  q.options[1].reasonParts[0].text = suppliedPhrases[4].text;
  if (failure === "foreign evidence") q.options[1].reasonParts[0].evidenceIds = ["r999"];
  else q.explanationParts[0].text = "同时属于 A 和 B 的元素在交集中，因此正确项B。";
  quiz.complete(page, id, codec.decode(value, scope));
  expect(saved(id).questions).toHaveLength(0);
});
