// Synthetic metamorphic and formal publication regressions, separate from the
// unchanged seven Windows candidates in the portable evidence replay.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedQuiz } from "@/lib/domain/learning-quiz";
import { composedQuizRequest } from "./quiz-composition";
import { inspectQuizCandidateDelivery } from "./quiz-grounding";
import { LearningQuizRepository } from "./quiz-repository";
import { LearningRepository } from "./repository";
import { parseFiniteSetAtoms, inspectLiteralSetCardinality, findFiniteSetLiterals, finiteSetLiteralKey } from "./quiz-set-cardinality";

describe("synthetic finite literal metamorphisms", () => {
  it.each([
    ["{红,蓝,绿}", "{ 绿，红 、 蓝，蓝 }"],
    ["{北京,上海,广州}", "{ 广州,北京,上海,北京 }"],
    ["{甲,乙,丙}", "{乙,丙,甲,甲}"],
    ["{a,B,01}", "{ +1, B, a,1}"],
    ["∅", "{ }"],
  ])("keeps reordering, spaces and repetitions equivalent: %s / %s", (left, right) => {
    expect(parseFiniteSetAtoms(left)).not.toBeNull();
    expect(parseFiniteSetAtoms(right)).toEqual(parseFiniteSetAtoms(left));
  });
  it.each([
    ["{红}", "{红色}"], ["{一}", "{1}"], ["{a}", "{A}"],
    ["{北,京}", "{北京}"], ["{红,蓝}", "{红蓝}"],
  ])("preserves atom identity without synonyms or character splitting: %s / %s", (left, right) => {
    expect(parseFiniteSetAtoms(left)).not.toBeNull();
    expect(parseFiniteSetAtoms(right)).not.toBeNull();
    expect(parseFiniteSetAtoms(left)).not.toEqual(parseFiniteSetAtoms(right));
  });
  it.each(["{红 色,蓝}", "{红+蓝,绿}", "{x|x>0}", "{{红},蓝}", "{'红','蓝'}", "{alpha,b}", "{1.0,2}", "[红,蓝]", "{红,}"])("keeps unsupported syntax undecided: %s", text => {
    expect(parseFiniteSetAtoms(text)).toBeNull();
  });
  it("scans complete outer literal spans without accepting nested or unsupported inner expressions", () => {
    const text = "{红,蓝} 与 {{a},b}、{x|x>0}、{a+1,b}、∅、{北京，上海}";
    expect(findFiniteSetLiterals(text).map(value => ({ ...value, index: undefined }))).toEqual([
      { index: undefined, text: "{红,蓝}", atoms: parseFiniteSetAtoms("{红,蓝}") },
      { index: undefined, text: "∅", atoms: [] },
      { index: undefined, text: "{北京，上海}", atoms: parseFiniteSetAtoms("{北京,上海}") },
    ]);
    for (const span of findFiniteSetLiterals(text)) expect(text.slice(span.index, span.index + span.text.length)).toBe(span.text);
    expect(finiteSetLiteralKey("{红,蓝,蓝}")).toBe(finiteSetLiteralKey("{蓝,红}"));
    expect(finiteSetLiteralKey("{{红},蓝}")).toBeNull();
  });
  it("uses the same literal identity in the existing bounded cardinality check", () => {
    expect(inspectLiteralSetCardinality("集合{红,蓝}与哪个集合元素个数相同？", [
      { id: "A", text: "{北京,上海}" }, { id: "B", text: "{甲,乙,乙}" }, { id: "C", text: "{}" },
    ], "A")).toMatchObject({ status: "invalid", code: "multiple_answers", targetCount: 2, matchingOptionIds: ["A", "B"] });
  });
});

describe("synthetic finite literal identity through codec, publication, SQLite and scoring", () => {
  let root: string, learning: LearningRepository, quiz: LearningQuizRepository, page: string, material: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "quiz-finite-literals-"));
    learning = new LearningRepository(root, "owner"); quiz = new LearningQuizRepository(learning);
    page = randomUUID(); material = randomUUID(); learning.create({ id: page, title: "[合成] 集合与表示形式" });
    learning.saveMaterials(page, [{ id: material, title: "[合成] 有限集合", kind: "text", filename: null,
      bytes: Buffer.from("[合成] 集合的成员身份不受书写顺序和重复次数影响。M={红,蓝}，N={蓝,绿}，M∪N={红,蓝,绿}。城市、字母和整数也可以作为字面元素。字符串、列表、序列和多重集使用不同的比较规则，不能当作集合去重。") }]);
    vi.stubGlobal("fetch", vi.fn(() => { throw Error("Network prohibited"); }));
  });
  afterEach(async () => {
    expect(fetch).not.toHaveBeenCalled();
    if (learning.database.open) learning.close();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true });
  });
  function complete(stem: string, texts: string[]) {
    const id = randomUUID(), input = quiz.begin(page, { id, settings: { materialIds: [material], chapterIds: [], nodeIds: [],
      includeNotes: false, includeSupplements: false, count: 1, difficulty: "standard" } }, 48000)!;
    const scope = { accountId: learning.accountId, pageId: page, requestId: id, expiresAt: Date.now() + 120000 };
    const codec = composedQuizRequest(input, scope), references = codec.input.materials[0].paragraphs.map(p => p.referenceId!);
    const raw = { contractVersion: "references-v2", referenceScope: codec.input.taskContext.referenceScope,
      title: "[合成] 字面身份", reason: null, materialPlan: [{ material: 1, contribution: "有限集合与表示形式", references }],
      items: [{ scenario: null, stem, kind: "concept", stemEvidenceIds: references, correctOptionId: "A",
        options: texts.map((text, index) => ({ id: String.fromCharCode(65 + index), text,
          reasonParts: [{ text: "按题干指定的比较规则判断。", evidenceIds: references }] })) }] };
    const before = JSON.stringify(raw), decoded = codec.decode(raw, scope);
    const catalog = input.materials.flatMap(m => m.paragraphs.map(p => ({ referenceId: p.referenceId, text: p.text,
      source: { kind: "material" as const, materialId: m.materialId, paragraph: p.number } })));
    const inspection = inspectQuizCandidateDelivery(decoded, catalog);
    quiz.complete(page, id, decoded);
    expect(JSON.stringify(raw)).toBe(before);
    const saved = JSON.parse((learning.database.prepare("SELECT result_json FROM learning_quiz_runs WHERE id=?").get(id) as { result_json: string }).result_json) as SavedQuiz;
    return { id, raw, decoded, inspection, saved };
  }
  it.each([
    ["集合 M={红,蓝}，N={蓝,绿}。M∪N 等于什么？", ["{红,蓝,绿}", "{红,蓝,蓝,绿}", "{红,绿}", "{}"]],
    ["集合 X={北京,上海}，Y={上海,广州}。X∪Y 等于什么？", ["{北京,上海,广州}", "{ 广州，北京、上海、北京 }", "{北京,广州}", "{}"]],
    ["集合 A={a,B}，C={B,1}。A∪C 等于什么？", ["{a,B,1}", "{+01,B,a,1}", "{a,1}", "{}"]],
    ["集合 M={红}，N={蓝}。M∩N 等于什么？", ["∅", "{}", "{红}", "{蓝}"]],
  ])("rejects actual equivalent choices at the publication layer: %s", (stem, texts) => {
    const result = complete(stem as string, texts as string[]);
    expect(result.decoded.items[0]).not.toHaveProperty("compositionRejected");
    expect(result.inspection.rejected).toEqual([{ index: 0, code: "equivalent_options" }]);
    expect(result.saved.questions).toHaveLength(0);
    expect(quiz.list(page).find(run => run.id === result.id)).toMatchObject({ status: "insufficient", count: 0 });
  });
  it.each(["字符串", "列表", "序列", "多重集", "表示法"])("does not reinterpret %s as an unordered set", kind => {
    const stem = `本题读取${kind}的原样书写，目标文本为 {红,蓝}。哪个选项与目标文本逐字相同？此处不判断集合相等。`;
    const result = complete(stem, ["{红,蓝}", "{蓝,红}", "{红,蓝,蓝}", "{}"]);
    expect(result.inspection.rejected).toEqual([]);
    expect(result.saved.questions).toHaveLength(1);
    expect(result.saved.questions[0].options.find(option => option.id === "A")?.text).toBe("{红,蓝}");
  });
  it("preserves a unique literal answer, stable IDs, hidden answers and formal score across reopen", () => {
    const result = complete("集合 M={红,蓝}，N={蓝,绿}。M∪N 等于什么？", ["{红,蓝,绿}", "{红,绿}", "{蓝}", "{}"]);
    expect(result.inspection.rejected).toEqual([]);
    expect(result.saved.questions).toHaveLength(1);
    let attempt = quiz.startAttempt(page, { id: randomUUID(), quizId: result.id, mode: "test" });
    expect(JSON.stringify(attempt)).not.toMatch(/correctOptionId|reasonParts|evidenceIds/);
    attempt = quiz.act(page, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "choose", question: 0, optionId: "A" });
    learning.close(); learning = new LearningRepository(root, "owner"); quiz = new LearningQuizRepository(learning);
    expect(quiz.attempt(page, attempt.id)).toEqual(attempt);
    attempt = quiz.act(page, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "finish", question: 0, optionId: null });
    expect(attempt.score).toMatchObject({ correct: 1, total: 1 });
  });
});
