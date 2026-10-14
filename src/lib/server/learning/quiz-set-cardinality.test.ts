import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedQuiz } from "@/lib/domain/learning-quiz";
import { composedQuizRequest } from "./quiz-composition";
import { bindQuizOptionExplanation, hasQuizPositionDependency, limitReferencedQuizCandidates } from "./quiz-grounding";
import { LearningQuizRepository } from "./quiz-repository";
import { LearningRepository } from "./repository";
import { inspectLiteralSetCardinality, parseFiniteSetAtoms } from "./quiz-set-cardinality";

const stem = "集合{a,b}与哪个集合元素个数相同？";
const options = (texts: string[]) => texts.map((text, index) => ({ id: String.fromCharCode(65 + index), text }));
const unique = ["{c}", "{a,b,c}", "{b,a}", "{}"];

describe("bounded literal set counting", () => {
  it.each([
    { text: "正确答案是 {A,B}。", choice: "{A,B}", question: "集合{A,B,B}与哪个集合元素个数相同？" },
    { text: "选项 {a,b} 含两个元素。", choice: "{a,b}", question: stem },
  ])("retains complete literal choice content without claiming semantic verification: $text", ({ text, choice, question }) => {
    expect(hasQuizPositionDependency(text, question)).toBe(false);
    expect(bindQuizOptionExplanation(text, options(["{1}", "{}", choice]), "C", question)).toBe(text);
  });
  it.each([
    ["{a,a,b}", ["letter:97", "letter:98"]],
    ["{A,a}", ["letter:65", "letter:97"]],
    ["{-0,+00,01,1,a}", ["integer:0", "integer:1", "letter:97"]],
    ["{}", []], ["{ }", []], ["∅", []],
  ])("parses supported complete set %s", (text, expected) => {
    expect(parseFiniteSetAtoms(text as string)).toEqual(expected);
  });
  it.each(["{a+1,b}", "{x|x>0}", "{1.0,2}", "{{a},b}", "{alpha,b}", "{a,b}∪{c}", "集合{a,b}"])("does not partially parse %s", text => {
    expect(parseFiniteSetAtoms(text)).toBeNull();
  });
  it.each([
    { name: "F6: three distinct but equinumerous sets", texts: ["{c,d}", "{a,c}", "{b,a}", "{}"], correct: "C", code: "multiple_answers", ids: ["A", "B", "C"] },
    { name: "no matching answer", texts: ["{c}", "{a,b,c}", "{d}", "{}"], correct: "C", code: "no_answer", ids: [] },
    { name: "wrong stable answer ID", texts: unique, correct: "A", code: "incorrect_answer", ids: ["C"] },
  ])("rejects $name", ({ texts, correct, code, ids }) => {
    expect(inspectLiteralSetCardinality(stem, options(texts), correct)).toEqual({ status: "invalid", code, targetCount: 2, matchingOptionIds: ids });
  });
  it.each([
    stem,
    "集合 {a,a,b} 与哪个集合含有相同数量的元素？",
    "下列哪个集合与集合{a,b}元素个数相同？",
    "与集合 {a,b} 元素个数相同的集合是哪个？",
  ])("keeps one actual answer for %s", question => {
    expect(inspectLiteralSetCardinality(question, options(unique).reverse(), "C")).toEqual({ status: "consistent", targetCount: 2, matchingOptionIds: ["C"] });
  });
  it("counts repeated integer atoms and keeps stable IDs", () => {
    expect(inspectLiteralSetCardinality("集合{+0,-0,1,01}与哪个集合元素个数相同？", options(["{1}", "{}", "{+1,2,02}"]), "C"))
      .toEqual({ status: "consistent", targetCount: 2, matchingOptionIds: ["C"] });
  });
  it("handles an explicitly empty target", () => {
    expect(inspectLiteralSetCardinality("集合∅与哪个集合元素个数相同？", options(["{a}", "{}", "{b,c}"]), "B"))
      .toEqual({ status: "consistent", targetCount: 0, matchingOptionIds: ["B"] });
  });
  it.each([
    "集合{a,b}等于哪个集合？",
    "集合{a,b}与哪个集合元素个数不相同？",
    "找出错误结论：集合{a,b}与哪个集合元素个数相同？",
    "集合{a,b}含两个元素。哪个选项正确？",
    "集合{a,b}和{c,d}与哪个集合元素个数相同？",
    "多重集{a,a,b}与哪个集合元素个数相同？",
    "字符串{a,b}与哪个集合元素个数相同？",
    "若a=b，集合{a,b}与哪个集合元素个数相同？",
    "集合{a+1,b}与哪个集合元素个数相同？",
    "集合{1 2}与哪个集合元素个数相同？",
    "集合{a,b}与哪个集合元素个数相同，且不含a？",
  ])("leaves unsupported question undecided: %s", question => {
    expect(inspectLiteralSetCardinality(question, options(unique), "C")).toEqual({ status: "not_applicable" });
  });
  it("does not decide when even one option is unsupported", () => {
    expect(inspectLiteralSetCardinality(stem, options(["{a}", "{a,b,c}", "{b,a}", "{x|x>0}"]), "C")).toEqual({ status: "not_applicable" });
  });
  it.each([
    { choices: [{ id: "A", text: "{a}" }, { id: "A", text: "{a,b}" }], id: "A" },
    { choices: options(unique), id: "Z" },
    { choices: options(["{a,b}"]), id: "A" },
  ])("leaves invalid identities to the structural gate", ({ choices, id }) => {
    expect(inspectLiteralSetCardinality(stem, choices, id)).toEqual({ status: "not_applicable" });
  });
});

describe("cardinality publication through the existing codec and SQLite", () => {
  let root: string, learning: LearningRepository, quiz: LearningQuizRepository, page: string, material: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "quiz-cardinality-offline-"));
    learning = new LearningRepository(root, "owner"); quiz = new LearningQuizRepository(learning);
    page = randomUUID(); material = randomUUID();
    learning.create({ id: page, title: "[合成] 有限集合计数" });
    learning.saveMaterials(page, [{ id: material, title: "[合成] 去重计数", kind: "text", filename: null,
      bytes: Buffer.from("[合成] 有限集合中重复书写的元素只计一次。{a,b}、{c,d}、{a,c}、{b,a}都含两个元素，成员不同的集合仍可有相同元素个数。空集合没有元素。") }]);
    vi.stubGlobal("fetch", vi.fn(() => { throw Error("Network prohibited"); }));
  });
  afterEach(async () => {
    if (learning.database.open) learning.close();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true });
  });
  function prepare(texts: string[], correctOptionId = "C") {
    const id = randomUUID();
    const input = quiz.begin(page, { id, settings: { materialIds: [material], chapterIds: [], nodeIds: [], includeNotes: false,
      includeSupplements: false, count: 1, difficulty: "standard" } }, 48000)!;
    const scope = { accountId: learning.accountId, pageId: page, requestId: id, expiresAt: Date.now() + 120000 };
    const codec = composedQuizRequest(input, scope);
    const refs = codec.input.materials[0].paragraphs.map(p => p.referenceId!);
    const raw = { contractVersion: "references-v2", referenceScope: codec.input.taskContext.referenceScope,
      title: "[合成] 元素个数", reason: null, materialPlan: [{ material: 1, contribution: "有限集合计数", references: refs }],
      items: [{ scenario: null, stem, kind: "concept", stemEvidenceIds: refs, correctOptionId,
        options: options(texts).map(option => ({ ...option, reasonParts: [{ text: "根据本题给定集合逐项比较。", evidenceIds: refs }] })) }] };
    const catalog = input.materials.flatMap(m => m.paragraphs.map(p => ({ referenceId: p.referenceId, text: p.text,
      source: { kind: "material" as const, materialId: m.materialId, paragraph: p.number } })));
    return { id, raw, codec, scope, catalog };
  }
  function saved(id: string): SavedQuiz {
    return JSON.parse((learning.database.prepare("SELECT result_json FROM learning_quiz_runs WHERE id=?").get(id) as { result_json: string }).result_json);
  }
  it.each([
    { name: "F6 distinct equinumerous choices", texts: ["{c,d}", "{a,c}", "{b,a}", "{}"], correct: "C" },
    { name: "no correct choice", texts: ["{c}", "{a,b,c}", "{d}", "{}"], correct: "C" },
    { name: "incorrect stable ID", texts: unique, correct: "A" },
  ])("rejects $name after binding and at candidate/publication fences", ({ texts, correct }) => {
    const { id, raw, codec, scope, catalog } = prepare(texts, correct);
    const decoded = codec.decode(raw, scope);
    expect(decoded.items[0]).toMatchObject({ stem, correctOptionId: correct });
    expect(decoded.items[0]).not.toHaveProperty("compositionRejected");
    const selected = limitReferencedQuizCandidates(decoded, catalog, 1);
    expect(selected.items).toHaveLength(0);
    expect(selected.reason).toMatch(/元素个数/);
    expect(selected.reason).not.toMatch(/解析选项引用不明确|身份不完整|选项重复/);
    quiz.complete(page, id, decoded);
    expect(saved(id).questions).toHaveLength(0);
    expect(saved(id).reason).toMatch(/元素个数/);
    expect(quiz.list(page).find(row => row.id === id)).toMatchObject({ status: "insufficient", count: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps distinct unique choice, source identities, shuffled IDs and official scoring across reopen", () => {
    const { id, raw, codec, scope, catalog } = prepare(unique);
    raw.items[0].options.reverse();
    const decoded = codec.decode(raw, scope);
    expect(limitReferencedQuizCandidates(decoded, catalog, 1).items).toHaveLength(1);
    quiz.complete(page, id, decoded);
    const value = saved(id), question = value.questions[0];
    expect(question.correctOptionId).toBe("C");
    expect(question.options.find(option => option.id === "C")?.text).toBe("{b,a}");
    expect(question.evidence?.map(e => e.quote)).toEqual(catalog.map(e => e.text));
    expect(quiz.list(page).find(row => row.id === id)).toMatchObject({ status: "completed", count: 1 });
    let attempt = quiz.startAttempt(page, { id: randomUUID(), quizId: id, mode: "test" });
    expect(JSON.stringify(attempt)).not.toMatch(/correctOptionId|evidenceIds|reasonParts/);
    attempt = quiz.act(page, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "choose", question: 0, optionId: "C" });
    learning.close(); learning = new LearningRepository(root, "owner"); quiz = new LearningQuizRepository(learning);
    expect(saved(id)).toEqual(value); expect(quiz.attempt(page, attempt.id)).toEqual(attempt);
    attempt = quiz.act(page, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "finish", question: 0, optionId: null });
    expect(attempt.score).toMatchObject({ correct: 1, total: 1 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
