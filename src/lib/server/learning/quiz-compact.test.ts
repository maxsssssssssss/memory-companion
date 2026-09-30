// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LearningRepository } from "./repository";
import { LearningQuizRepository } from "./quiz-repository";
import { compactQuizRequest, compactQuizPrompt } from "./quiz-compact";
import { LEARNING_QUIZ_PROMPT, generateLearningQuiz } from "./quiz-service";
import { learningModelInput } from "./model-input";

let root: string, learning: LearningRepository, quiz: LearningQuizRepository, page: string, material: string;
const settings = () => ({ materialIds: [material], chapterIds: [], nodeIds: [], includeNotes: false, includeSupplements: false, count: 2, difficulty: "standard" });
const begin = () => {
  const id = randomUUID(), input = quiz.begin(page, { id, settings: settings() }, 48000)!;
  const scope = { accountId: learning.accountId, pageId: page, requestId: id, expiresAt: Date.now() + 120000 };
  return { id, input, scope, codec: compactQuizRequest(input, scope) };
};
function output(codec: ReturnType<typeof compactQuizRequest>) {
  const refs = codec.input.materials[0].paragraphs.map(p => p.referenceId);
  return { contractVersion: "references-v2", referenceScope: codec.input.taskContext.referenceScope, title: "[合成] 短引用", reason: null as string | null,
    items: [1, 2].map(n => ({ scenario: null, stem: `[合成] 判断${n}`, kind: "concept", stemEvidenceIds: [...refs], explanationEvidenceIds: [...refs],
      options: [{ id: "A", text: "有前提", reason: "[合成] 原文有前提", evidenceIds: [...refs] }, { id: "B", text: "无前提", reason: "[合成] 原文并非无前提", evidenceIds: [refs[0]] }], correctOptionId: "A", explanation: "[合成] 条件成立时适用", hint: null })) };
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "learning-compact-synthetic-")); learning = new LearningRepository(root, "owner"); quiz = new LearningQuizRepository(learning);
  page = randomUUID(); material = randomUUID(); learning.create({ id: page, title: "[合成]" });
  learning.saveMaterials(page, [{ id: material, title: "[合成]", kind: "txt", filename: "synthetic.txt", bytes: Buffer.from("[合成] 规则有前提。\n\n[合成] 未满足时不能应用规则。") }]);
});
afterEach(async () => { if (learning.database.open) learning.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });

it("round trips every evidence occurrence, leaves source text intact and saves stable IDs only", () => {
  const { id, input, scope, codec } = begin(), wire = learningModelInput(input);
  expect(codec.input.materials[0].paragraphs.map(p => p.text)).toEqual(wire.materials[0].paragraphs.map(p => p.text));
  expect(codec.input.taskContext.materialCatalog[0]).toMatchObject({ material: 1, displayTitle: wire.taskContext.materialCatalog[0].displayTitle });
  expect(JSON.stringify(codec.input)).not.toContain("ref_");
  const out = codec.decode(output(codec), scope); quiz.complete(page, id, out);
  const saved = JSON.parse((learning.database.prepare("SELECT result_json FROM learning_quiz_runs WHERE id=?").get(id) as { result_json: string }).result_json);
  expect(saved.questions).toHaveLength(2);
  expect(saved.questions[0].stemEvidenceIds).toEqual(input.materials[0].paragraphs.map(p => p.referenceId));
  expect(saved.questions[0].sources).toHaveLength(2);
  expect(saved.questions[0].options.find((o: { id: string }) => o.id === "B").evidenceIds).toEqual([input.materials[0].paragraphs[0].referenceId]);
  expect(JSON.stringify(saved)).not.toContain("referenceScope");
  const attempt = quiz.startAttempt(page, { id: randomUUID(), quizId: id, mode: "test" });
  learning.close(); learning = new LearningRepository(root, "owner"); quiz = new LearningQuizRepository(learning);
  expect(quiz.attempt(page, attempt.id)).toEqual(attempt);
});
it("resolves display references by field while preserving literal names from material", () => {
  const { input, scope } = begin(); input.materials[0].paragraphs[0].text += "变量 r1 表示半径。";
  const codec = compactQuizRequest(input, scope), v = output(codec);
  v.reason = "未采用 r2 的争议结论；r1 是材料中的变量。";
  v.items[0].explanation = "依据 r2，变量 r1 不作改写。";
  const decoded = codec.decode(v, scope);
  expect(decoded.reason).toContain("《[合成]》第 2 段"); expect(decoded.reason).toContain("r1 是材料中的变量");
  expect(decoded.items[0]).toMatchObject({ explanation: "依据 〔《[合成]》第 2 段〕，变量 r1 不作改写。" });
});
it("rejects undeclared prose evidence rather than guessing or widening a question's sources", () => {
  const { id, scope, codec } = begin(), v = output(codec);
  v.items[0].options[1].reason = "依据 r2 判断"; // This option explicitly selected only r1.
  quiz.complete(page, id, codec.decode(v, scope)); expect(quiz.list(page)[0]).toMatchObject({count:1});
});
it("does not reinterpret names explicitly defined in a hypothetical question", () => {
  const { scope, codec } = begin(), v = output(codec);
  v.items[0].stem = "假设新案例，令 r1 = 3，如何判断？"; v.items[0].explanation = "r1 的值为 3。";
  expect(codec.decode(v, scope).items[0]).toMatchObject({stem:v.items[0].stem,explanation:v.items[0].explanation});
});
it("rejects an unknown alias in group notes and retains non-token substrings", () => {
  const { input, scope } = begin(), codec = compactQuizRequest(input, scope), v = output(codec);
  v.reason = "未采用 r999"; expect(() => codec.decode(v, scope)).toThrow("quiz_grounding_invalid");
  const fresh = compactQuizRequest(input, scope), good = output(fresh); good.reason = "parameter_r1 与 error2 是文本";
  expect(fresh.decode(good,scope).reason).toBe(good.reason);
});
it("rejects unknown/out-of-range/full IDs as whole questions while retaining independent valid questions", () => {
  for (const invalid of ["r999", "r01", "ref_" + "a".repeat(64), "r1 r2"]) {
    const { id, scope, codec } = begin(), v = output(codec); v.items[0].options[0].evidenceIds.push(invalid);
    quiz.complete(page, id, codec.decode(v, scope));
    expect(quiz.list(page)[0]).toMatchObject({ status: "completed", count: 1 });
    expect(quiz.list(page)[0].reason).toContain("第 1 题");
  }
});
it("rejects cross-account, page, request, stale bindings and replay without guessing", () => {
  const { input, scope, codec } = begin();
  for (const other of [{ ...scope, accountId: "other" }, { ...scope, pageId: randomUUID() }, { ...scope, requestId: randomUUID() }])
    expect(() => codec.decode(output(codec), other)).toThrow("source_changed");
  const next = compactQuizRequest(input, { ...scope, requestId: randomUUID() });
  expect(() => next.decode(output(codec), { ...scope, requestId: "wrong" })).toThrow();
  const bad = output(codec); bad.referenceScope = "a".repeat(64);
  expect(() => codec.decode(bad, scope)).toThrow("quiz_grounding_invalid");
  expect(() => codec.decode(output(codec), scope)).toThrow("source_changed");
  const expired = compactQuizRequest(input, { ...scope, expiresAt: Date.now() - 1 });
  expect(() => expired.decode(output(expired), { ...scope, expiresAt: Date.now() - 1 })).toThrow();
});
it("changed source versions or explicit extras produce distinct bindings even when alias names coincide", () => {
  const { input, scope, codec } = begin();
  const changed = structuredClone(input); changed.materials[0].paragraphs[0].referenceId = "ref_" + "b".repeat(64);
  const other = compactQuizRequest(changed, scope);
  expect(() => other.decode(output(codec), scope)).toThrow("quiz_grounding_invalid");
  const duplicate = structuredClone(input); duplicate.materials[0].paragraphs[1].referenceId = duplicate.materials[0].paragraphs[0].referenceId;
  expect(() => compactQuizRequest(duplicate, scope)).toThrow("quiz_grounding_invalid");
});
it("preserves repository account, source mutation, material deletion and page deletion fencing", () => {
  const { id, scope, codec } = begin(), value = codec.decode(output(codec), scope);
  const other = new LearningRepository(root, "other");
  try { expect(() => new LearningQuizRepository(other).complete(page, id, value)).toThrow(); } finally { other.close(); }
  learning.deleteMaterial(page, material);
  expect(() => quiz.complete(page, id, value)).toThrow();
  learning.deletePage(page); expect(() => quiz.complete(page, id, value)).toThrow();
});
it("rejects a late response after the immutable original hash changes", () => {
  const { id, scope, codec } = begin(), value = codec.decode(output(codec), scope);
  learning.database.prepare("UPDATE learning_materials SET original=? WHERE id=?").run(Buffer.from("[合成] 新版本"), material);
  expect(() => quiz.complete(page, id, value)).toThrow();
  expect(quiz.list(page)[0].count).toBe(0);
});
it("preserves selected note content while omitting computable internal node IDs on the wire", () => {
  const { input, scope } = begin();
  input.extras.push({ id: "synthetic:note", kind: "note", chapterId: randomUUID(), nodeId: randomUUID(), text: "[合成笔记] 独有方法", referenceId: "ref_" + "e".repeat(64) });
  const codec = compactQuizRequest(input, scope), value = output(codec);
  expect(codec.input.extras[0]).toEqual({ kind: "note", text: "[合成笔记] 独有方法", referenceId: "r3" });
  value.items[0].options[0].evidenceIds.push("r3");
  expect(codec.decode(value, scope).items[0]).toMatchObject({ options: [{ evidenceIds: expect.arrayContaining([input.extras[0].referenceId]) }, expect.anything()] });
});
it("does not reinterpret full-ID legacy results or change prompt semantics outside reference transport", () => {
  const { input, scope, codec } = begin(), v = output(codec), decoded = codec.decode(v, scope);
  expect(decoded).not.toHaveProperty("referenceScope");
  expect(decoded.items[0]).toMatchObject({ explanation: v.items[0].explanation });
  expect(compactQuizPrompt(LEARNING_QUIZ_PROMPT)).toContain("原样回传taskContext.referenceScope");
  expect(compactQuizPrompt(LEARNING_QUIZ_PROMPT)).toContain("引用存在名称/数量歧义的ASR措辞时保留引号");
  expect(input.extras).toEqual([]);
});
it("uses the real service and transport with a synthetic final reply, never leaking reasoning or publishing missing scope", async () => {
  const config = { baseURL: "https://tokenhub.vision-intelligence.tech/v1", apiKey: "SYNTHETIC", model: "deepseek-v4-pro", maxInputChars: 48000, maxOutputTokens: 16000 };
  const fetch = vi.fn(async (_url, init) => {
    const b = JSON.parse(init.body); const wire = JSON.parse(b.input.find((i: { role: string }) => i.role === "user").content);
    const legacy = output({ input: wire } as ReturnType<typeof compactQuizRequest>);
    const v = { ...legacy, materialPlan: [{ material: 1, contribution: "[模拟] 规则与条件", references: wire.materials[0].paragraphs.map((p: { referenceId: string }) => p.referenceId) }],
      items: legacy.items.map(({ explanation, explanationEvidenceIds, ...q }, i) => ({ ...q, focus: `[模拟] 考点${i}`,
        explanationParts: [{ text: explanation, evidenceIds: explanationEvidenceIds }],
        options: q.options.map(({ reason, evidenceIds, ...o }) => ({ ...o, reasonParts: [{ text: reason, evidenceIds }] })) })) };
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "reasoning", content: [{ text: "PRIVATE" }] }, { type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(v) }] }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  vi.stubGlobal("fetch", fetch);
  const id = randomUUID(), result = await generateLearningQuiz(learning, page, { id, settings: settings() }, { configure: () => config, generate: (await import("./framework-generator")).generateStudyJson });
  expect(result[0]).toMatchObject({ status: "completed", count: 2 }); expect(fetch).toHaveBeenCalledTimes(1);
});
