// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LearningRepository } from "./repository";
import { LearningQuizRepository } from "./quiz-repository";
import { composedQuizRequest, composedQuizPrompt } from "./quiz-composition";
import { generateLearningQuiz, LEARNING_QUIZ_PROMPT } from "./quiz-service";
import { generateStudyJson } from "./framework-generator";
import type { SavedQuiz } from "@/lib/domain/learning-quiz";

let root: string, learning: LearningRepository, quiz: LearningQuizRepository, page: string, materials: string[];
const settings = () => ({ materialIds: materials, chapterIds: [], nodeIds: [], includeNotes: false, includeSupplements: false, count: 2, difficulty: "standard" });
const begin = () => {
  const id = randomUUID(), input = quiz.begin(page, { id, settings: settings() }, 48000)!;
  const scope = { accountId: learning.accountId, pageId: page, requestId: id, expiresAt: Date.now() + 120000 };
  return { id, input, scope, codec: composedQuizRequest(input, scope) };
};
type Wire = { materials: Array<{ paragraphs: Array<{ text: string; referenceId?: string }> }>; taskContext: { referenceScope: string } };
function response(wire: Wire, count = 2) {
  const refs = wire.materials.map(m => m.paragraphs.map(p => p.referenceId!));
  return { contractVersion: "references-v2", referenceScope: wire.taskContext.referenceScope, title: "[合成] 材料联合练习", reason: null as string | null,
    materialPlan: refs.map((r, i) => ({ material: i + 1, contribution: `[合成] 材料${i + 1}独有考点`, references: r })),
    items: Array.from({ length: count }, (_, i) => {
      const r = i === 0 ? refs[0] : refs.slice(1).flat();
      return { focus: `[合成] 不同考点${i + 1}`, scenario: null, stem: `[合成] 问题${i + 1}`, kind: "relationship",
        stemEvidenceIds: [r[0]], options: [
          { id: "A", text: "同时保留规则与条件", reasonParts: [{ text: "[合成] 规则依据。", evidenceIds: [r[0]] }, { text: "[合成] 另一条件依据。", evidenceIds: [r.at(-1)!] }] },
          { id: "B", text: "不需要条件", reasonParts: [{ text: "[合成] 条件不能省略。", evidenceIds: [r.at(-1)!] }] }
        ], correctOptionId: "A", explanationParts: [{ text: "[合成] 结合相应材料。", evidenceIds: r }], hint: "PRIVATE_MODEL_HINT_WITH_ANSWER" };
    }) };
}
const saved = (id: string): SavedQuiz => JSON.parse((learning.database.prepare("SELECT result_json FROM learning_quiz_runs WHERE id=?").get(id) as { result_json: string }).result_json);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "learning-composition-synthetic-")); learning = new LearningRepository(root, "owner"); quiz = new LearningQuizRepository(learning);
  page = randomUUID(); learning.create({ id: page, title: "[合成] 引用与覆盖" });
  materials = [0, 1, 2].map(i => { const id = randomUUID(); learning.saveMaterials(page, [{ id, title: `[合成] 材料${i + 1}`, kind: "text", filename: null,
    bytes: Buffer.from(`[合成] 第${i + 1}份的独有规则。\n\n[合成] 第${i + 1}份的适用条件与例外。`) }]); return id; });
  vi.stubGlobal("fetch", vi.fn(() => { throw Error("Network prohibited"); }));
});
afterEach(async () => { if (learning.database.open) learning.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

it("joins every reason fragment and its explicit evidence while retaining all input text", () => {
  const { id, input, scope, codec } = begin(), value = response(codec.input);
  expect(codec.input.materials.map(m => m.paragraphs.map(p => p.text))).toEqual(input.materials.map(m => m.paragraphs.map(p => p.text)));
  const decoded = codec.decode(value, scope); quiz.complete(page, id, decoded);
  const q = saved(id).questions[0], option = q.options.find(o => o.id === "A")!;
  expect(option.reason).toBe("[合成] 规则依据。\n[合成] 另一条件依据。");
  expect(option.evidenceIds).toEqual(input.materials[0].paragraphs.map(p => p.referenceId));
  expect(q.evidence!.map(e => e.source)).toEqual(input.materials[0].paragraphs.map(p => ({ kind: "material", materialId: input.materials[0].materialId, paragraph: p.number })));
  expect(saved(id).reason).toBeNull();
  expect(JSON.stringify(saved(id))).not.toMatch(/materialPlan|referenceScope|reasonParts|PRIVATE_MODEL_HINT/);
});
it.each(["missing", "unknown", "extra"])("rejects a whole question with %s fragment evidence, never drops the inconvenient clause", mode => {
  const { id, scope, codec } = begin(), value = response(codec.input);
  if (mode === "missing") value.items[0].options[0].reasonParts[1].evidenceIds = [];
  if (mode === "unknown") value.items[0].options[0].reasonParts[1].evidenceIds = ["r999"];
  if (mode === "extra") Object.assign(value.items[0].options[0], { reason: "[合成] 未绑定解释", evidenceIds: ["r1"] });
  quiz.complete(page, id, codec.decode(value, scope));
  expect(saved(id).questions).toHaveLength(1);
  expect(saved(id).questions[0].stem).toBe(value.items[1].stem);
  expect(saved(id).reason).toContain("第 1 题");
});
it("uses actual published sources for coverage rather than trusting a full material plan", () => {
  const { id, input, scope, codec } = begin(), value = response(codec.input);
  value.items[1] = { ...structuredClone(value.items[0]), stem: "[合成] 第二个独立问题", focus: "[合成] 另一个判断" };
  quiz.complete(page, id, codec.decode(value, scope));
  expect(saved(id).questions).toHaveLength(2);
  expect(saved(id).reason).toContain("1/3 份所选材料");
  expect(saved(id).reason).toContain(`《${input.materials[1].title}》`);
  expect(saved(id).reason).toContain(`《${input.materials[2].title}》`);
  expect(saved(id).reason).not.toContain("没有价值");
});
it("recomputes coverage after rejecting a question and allows honest limited coverage", () => {
  const { id, scope, codec } = begin(), value = response(codec.input);
  value.items[1].options[0].reasonParts[0].evidenceIds = ["r999"];
  quiz.complete(page, id, codec.decode(value, scope));
  expect(saved(id).questions).toHaveLength(1);
  expect(saved(id).reason).toContain("1/3 份所选材料");
});
it("does not turn a bad or missing coverage plan into a bad-source question or success without a caveat", () => {
  const { id, scope, codec } = begin(), value = response(codec.input);
  value.materialPlan[0].references = value.materialPlan[1].references;
  quiz.complete(page, id, codec.decode(value, scope));
  expect(saved(id).questions).toHaveLength(2);
  expect(saved(id).reason).toContain("材料考查安排不完整");
  expect(saved(id).reason).not.toContain("未引用"); // All three have actual references; not a claim of semantic coverage.
});
it("drops exact repeated declared objectives for the same scenario and basis, without rejecting other valid questions", () => {
  const { id, scope, codec } = begin(), value = response(codec.input);
  value.items[1] = { ...structuredClone(value.items[0]), stem: "[合成] 改一种问法" };
  quiz.complete(page, id, codec.decode(value, scope));
  expect(saved(id).questions).toHaveLength(1);
  expect(saved(id).reason).toContain("考点和情境重复");
});
it("does not claim to detect paraphrased semantic duplication or sufficient citation from an ID", () => {
  const { id, scope, codec } = begin(), value = response(codec.input);
  value.items[1] = { ...structuredClone(value.items[0]), stem: "[合成] 近义改问", focus: "[合成] 换个名字描述相同判断" };
  value.items[0].options[0].reasonParts[1].evidenceIds = ["r1"]; // Deliberately insufficient support remains a semantic issue.
  quiz.complete(page, id, codec.decode(value, scope));
  expect(saved(id).questions).toHaveLength(2);
  expect(JSON.stringify(saved(id))).not.toContain("verified");
});
it("keeps fixed option identity/order, test secrecy, autosave and history after reopen", () => {
  const { id, scope, codec } = begin(); quiz.complete(page, id, codec.decode(response(codec.input), scope));
  const original = saved(id);
  let attempt = quiz.startAttempt(page, { id: randomUUID(), quizId: id, mode: "test" });
  expect(JSON.stringify(attempt)).not.toMatch(/correctOptionId|reasonParts|evidenceIds|PRIVATE_MODEL_HINT|feedback/);
  attempt = quiz.act(page, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "choose", question: 0, optionId: "A" });
  learning.close(); learning = new LearningRepository(root, "owner"); quiz = new LearningQuizRepository(learning);
  expect(quiz.attempt(page, attempt.id)).toEqual(attempt); expect(saved(id)).toEqual(original);
  attempt = quiz.act(page, { id: randomUUID(), attemptId: attempt.id, revision: attempt.revision, action: "finish", question: 0, optionId: null });
  expect(attempt.score?.correct).toBe(1);
  expect(attempt.questions[0].feedback?.reasons.find(o => o.id === "A")?.reason).toBe(original.questions[0].options.find(o => o.id === "A")?.reason);
  expect(fetch).not.toHaveBeenCalled();
});
it("keeps request binding, live source-version checks, deletion fencing and retained historical results", () => {
  const first = begin(); quiz.complete(page, first.id, first.codec.decode(response(first.codec.input), first.scope));
  const original = saved(first.id), next = begin(), pending = response(next.codec.input);
  expect(() => next.codec.decode(pending, { ...next.scope, accountId: "other" })).toThrow("source_changed");
  const decoded = next.codec.decode(pending, next.scope);
  learning.deleteMaterial(page, materials[0]);
  expect(() => quiz.complete(page, next.id, decoded)).toThrow();
  expect(saved(first.id)).toEqual(original);
  const attempt = quiz.startAttempt(page, { id: randomUUID(), quizId: first.id, mode: "practice" });
  expect(attempt.questions).toHaveLength(2);
  learning.deletePage(page);
  expect(() => quiz.complete(page, next.id, decoded)).toThrow();
});
it("changes the wire format without leaving the conflicting old output example", () => {
  const prompt = composedQuizPrompt(LEARNING_QUIZ_PROMPT);
  expect(prompt.match(/仅输出JSON：/g)).toHaveLength(1);
  expect(prompt).toContain("materialPlan"); expect(prompt).toContain("reasonParts");
  expect(prompt).not.toContain('"reason":"此项为何正确或错误');
  expect(begin().codec.input.taskContext.coverageInstruction).toContain("不按文件平均配题");
  const example = prompt.split("仅输出JSON：")[1].split("。\n")[0];
  expect(example).not.toMatch(/explanationParts|"hint"/);
  expect(prompt).toContain("程序复用它作为总解析");
});

it("delivers five questions by binding explicit explanation IDs, regardless of the model option-array order", () => {
  const id = randomUUID(), input = quiz.begin(page, { id, settings: { ...settings(), count: 5 } }, 48000)!;
  const scope = { accountId: learning.accountId, pageId: page, requestId: id, expiresAt: Date.now() + 120000 }, codec = composedQuizRequest(input, scope);
  const value = response(codec.input), base = value.items[0];
  const phrases = ["正确项A符合这一限定。", "A项正确，因为前提仍需保留。", "A项所述判断保留条件。", "A项准确概括规则。", "选项A保留条件；错误项B省略条件。"];
  value.items = phrases.map((text, i) => ({ ...structuredClone(base), focus: `[合成] 判断${i}`, stem: `[合成] 判断${i}是什么？`,
    options: [...structuredClone(base.options)].reverse(), explanationParts: [{ text, evidenceIds: base.stemEvidenceIds }] }));
  const untouched = JSON.stringify(value), decoded = codec.decode(value, scope);
  quiz.complete(page, id, decoded);
  const result = saved(id);
  expect(result.questions).toHaveLength(5);
  expect(JSON.stringify(value)).toBe(untouched);
  for (const q of result.questions) {
    expect(q.explanation).toContain("选项「同时保留规则与条件」");
    expect(q.explanation).not.toMatch(/正确项A|A项|选项A/);
    expect(q.correctOptionId).toBe("A");
    expect(q.options.find(o => o.id === "A")!.evidenceIds).toEqual(input.materials[0].paragraphs.map(p => p.referenceId));
  }
  expect(result.questions[4].explanation).toContain("错误选项「不需要条件」");
  learning.close(); learning = new LearningRepository(root, "owner"); quiz = new LearningQuizRepository(learning);
  expect(saved(id)).toEqual(result);
  expect(fetch).not.toHaveBeenCalled();
});

it.each([undefined, null, []])("derives the summary and exact evidence from the correct reason when optional summary is %s", explanationParts => {
  const { id, input, scope, codec } = begin(), value = response(codec.input);
  Object.assign(value.items[0], { explanationParts, hint: undefined, scenario: "" });
  value.items[0].stemEvidenceIds.push(value.items[0].stemEvidenceIds[0]);
  quiz.complete(page, id, codec.decode(value, scope));
  const q = saved(id).questions[0], correct = q.options.find(o => o.id === q.correctOptionId)!;
  expect(q.explanation).toBe(correct.reason);
  expect(q.explanationEvidenceIds).toEqual(correct.evidenceIds);
  expect(q.stemEvidenceIds).toEqual([input.materials[0].paragraphs[0].referenceId]);
  expect(q.hint).toContain("关系两端");
});

it.each(["正确项B符合条件。", "错误项A忽略条件。", "选项F的解释。", "选项G正确。", "答案G", "答案A、G字母均正确。", "第2题的A项正确。", "A项和B项都正确。", "选项A和B均正确。", "以上全部成立。", "第二个选项正确。"])("rejects ambiguous/contradictory references: %s", text => {
  const { id, scope, codec } = begin(), value = response(codec.input);
  value.items[0].explanationParts[0].text = text;
  quiz.complete(page, id, codec.decode(value, scope));
  expect(saved(id).questions).toHaveLength(1);
  expect(saved(id).questions[0].stem).toBe(value.items[1].stem);
});

it("preserves material entity names, and does not normalize answer references into pre-feedback fields", () => {
  for (const field of ["stem", "scenario", "option"] as const) {
    const { id, scope, codec } = begin(), value = response(codec.input);
    if (field === "option") value.items[0].options[0].text = "A和B都正确";
    else Object.assign(value.items[0], { [field]: "正确项A符合条件" });
    quiz.complete(page, id, codec.decode(value, scope));
    expect(saved(id).questions).toHaveLength(1);
  }
  const { id, scope, codec } = begin(), value = response(codec.input);
  const text = "方案A与B是材料名称，A组和B组均需保留条件；PEAS与Balance不是选项字母。";
  value.items[0].explanationParts[0].text = text;
  quiz.complete(page, id, codec.decode(value, scope));
  expect(saved(id).questions[0].explanation).toBe(text);
});

it.each(["只要把P、E、A、S四个字母写全，就完成了PEAS分析。", "把Q、A、D三个字母抄全就是理解。"])('retains an explicit material-letter enumeration, without excusing option combinations: %s', text => {
  const { id, scope, codec } = begin(), value = response(codec.input);
  value.items[0].options[1].text = text;
  value.items[0].options[1].reasonParts[0].text = "B项只抄写字母，没有核对条件。";
  quiz.complete(page, id, codec.decode(value, scope));
  expect(saved(id).questions).toHaveLength(2);
  expect(saved(id).questions[0].options.find(o => o.id === "B")!.text).toBe(text);
  expect(saved(id).questions[0].options.find(o => o.id === "B")!.reason).toBe(`选项「${text}」只抄写字母，没有核对条件。`);
});

it("retains extra explanations and their evidence instead of silently replacing them with the correct option", () => {
  const { id, input, scope, codec } = begin(), value = response(codec.input);
  value.items[0].explanationParts = [{ text: "A项符合第一条规则。", evidenceIds: ["r1"] }, { text: "[合成] 必须保留另一条例外。", evidenceIds: ["r2"] }];
  quiz.complete(page, id, codec.decode(value, scope));
  expect(saved(id).questions[0].explanation).toContain("必须保留另一条例外");
  expect(saved(id).questions[0].explanationEvidenceIds).toEqual(input.materials[0].paragraphs.map(p => p.referenceId));
  const next = begin(), bad = response(next.codec.input);
  bad.items[0].explanationParts = [{ text: "A项符合条件。", evidenceIds: ["r1", "r999"] }];
  quiz.complete(page, next.id, next.codec.decode(bad, next.scope));
  expect(saved(next.id).questions).toHaveLength(1);
  expect(saved(id).questions).toHaveLength(2);
});

it("resolves sparse stable IDs instead of array positions, and preserves source-bound material names", () => {
  const { id, scope, codec } = begin(), value = response(codec.input);
  Object.assign(value.items[0].options[0], { id: "F", reasonParts: [{ text: "F项保留适用前提。", evidenceIds: ["r1", "r2"] }] });
  Object.assign(value.items[0].options[1], { id: "C", reasonParts: [{ text: "C项省略条件。", evidenceIds: ["r2"] }] });
  value.items[0].correctOptionId = "F";
  value.items[0].options.reverse();
  value.items[0].explanationParts[0].text = "正确项F符合条件，方案A与B和A组是材料名称。";
  quiz.complete(page, id, codec.decode(value, scope));
  const q = saved(id).questions[0];
  expect(q.correctOptionId).toBe("F");
  expect(q.explanation).toBe("正确选项「同时保留规则与条件」符合条件，方案A与B和A组是材料名称。");
  expect(q.options.find(o => o.id === "C")!.reason).toBe("选项「不需要条件」省略条件。");
});

it.each(["practice", "test"] as const)("completes a full five-question %s with stable feedback, resume and no generation while answering", mode => {
  const id = randomUUID(), input = quiz.begin(page, { id, settings: { ...settings(), count: 5 } }, 48000)!;
  const scope = { accountId: learning.accountId, pageId: page, requestId: id, expiresAt: Date.now() + 120000 }, codec = composedQuizRequest(input, scope);
  const value = response(codec.input, 5);
  for (const q of value.items) q.explanationParts[0].text = "正确项A保留前提与条件。";
  quiz.complete(page, id, codec.decode(value, scope));
  const initial = saved(id);
  let a = quiz.startAttempt(page, { id: randomUUID(), quizId: id, mode });
  expect(a.questions.every(q => q.feedback === undefined)).toBe(true);
  const act = (action: "choose" | "submit" | "hint" | "skip" | "finish", question: number, optionId: string | null = null) => {
    a = quiz.act(page, { id: randomUUID(), attemptId: a.id, revision: a.revision, action, question, optionId });
  };
  act("choose", 0, "A");
  if (mode === "practice") act("submit", 0);
  expect(Boolean(a.questions[0].feedback)).toBe(mode === "practice");
  learning.close(); learning = new LearningRepository(root, "owner"); quiz = new LearningQuizRepository(learning);
  expect(quiz.attempt(page, a.id)).toEqual(a); expect(saved(id)).toEqual(initial);
  act("hint", 1); expect(a.questions[1].hint).not.toContain("同时保留规则");
  for (const index of [1, 2, 3]) { act("choose", index, "A"); if (mode === "practice") act("submit", index); }
  act("skip", 4);
  if (!a.completed) act("finish", 4);
  expect(a.completed).toBe(true); expect(a.score).toMatchObject({ correct: 4, total: 5, hinted: 1, skipped: 1, unassistedCorrect: 3 });
  for (const q of a.questions) {
    expect(q.feedback!.correctOptionId).toBe("A");
    expect(q.feedback!.explanation).toContain("正确选项「同时保留规则与条件」");
    expect(q.feedback!.reasons.find(o => o.id === "B")!.reason).toContain("条件不能省略");
  }
  expect(saved(id)).toEqual(initial); expect(fetch).not.toHaveBeenCalled();
});
it.each(["exact", "surplus", "surplus-invalid-first"] as const)("executes one actual application generation path with %s synthetic SSE, no extra planning or retry request", async variant => {
  const config = { baseURL: "https://synthetic.invalid/v1", apiKey: "SYNTHETIC", model: "synthetic-model", maxInputChars: 48000, maxOutputTokens: 16000 };
  const fetch = vi.fn(async (_url, init) => {
    const request = JSON.parse(init.body), wire = JSON.parse(request.input.find((m: { role: string }) => m.role === "user").content);
    expect(request.input.filter((m: { role: string }) => m.role === "system").map((m: { content: string }) => m.content).join("\n")).toContain("reasonParts");
    const prior = response(wire, variant === "exact" ? 5 : 6), compact = { ...prior, items: prior.items.map(({ explanationParts: _summary, hint: _hint, ...item }) => item) };
    if (variant === "surplus-invalid-first") compact.items[0].options[0].reasonParts[0].evidenceIds = ["r999"];
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [
      { type: "reasoning", content: [{ text: "PRIVATE_REASONING" }] }, { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(compact) }] }
    ] } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  vi.stubGlobal("fetch", fetch);
  const id = randomUUID(), result = await generateLearningQuiz(learning, page, { id, settings: { ...settings(), count: 5 } }, { configure: () => config, generate: generateStudyJson });
  expect(result[0]).toMatchObject({ status: "completed", count: 5 }); expect(fetch).toHaveBeenCalledTimes(1);
  if (variant !== "exact") expect(result[0].reason).toContain("候选题，本组按设置保留 5 题");
  if (variant === "surplus-invalid-first") expect(saved(id).questions.map(q => q.stem)).not.toContain("[合成] 问题1");
  expect(JSON.stringify(saved(id))).not.toContain("PRIVATE_REASONING");
});
