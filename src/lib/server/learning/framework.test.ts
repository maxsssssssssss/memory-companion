// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeneratedFramework } from "@/lib/domain/learning-framework";
import { LearningRepository } from "./repository";
import { LearningFrameworkRepository } from "./framework-repository";
import { organizeLearningText } from "./framework-service";
import { learningGenerationConfig, generateLearningFramework } from "./framework-generator";

let root: string;
let learning: LearningRepository;
let repo: LearningFrameworkRepository;
let pageId: string;
let materialId: string;
const opened: LearningRepository[] = [];
const config = { baseURL: "https://synthetic.invalid/v1", apiKey: "SYNTHETIC_NOT_A_KEY", model: "synthetic-model", maxInputChars: 10000, maxOutputTokens: 4000 };
const text = "[合成测试] 线性关系 linear relation。\r\n\r\n第二段：并非所有关系都是线性的。";
function add(kind: "text" | "txt" = "text", body = text) {
  const id = randomUUID(); learning.saveMaterials(pageId, [{ id, title: "[合成] 材料", kind,
    filename: kind === "txt" ? "synthetic.txt" : null, bytes: Buffer.from(body) }]); return id;
}
function result(ids = [materialId]): GeneratedFramework {
  return { overview: "[模拟模型] 本批涉及概念与边界，未核验语义。", chapters: ids.map((id) => ({ title: "[模拟模型] 关系与边界", explanation: "AI 章节概括",
    nodes: [1, 2].map((paragraph) => ({ title: `知识点 ${paragraph}`, explanation: "[模拟] 基于选定材料的解释。", supplement: paragraph === 2 ? "[模拟] 补充解释" : null,
      sources: [{ materialId: id, paragraph }] })) })) };
}
async function generated(ids = [materialId]) {
  const id = randomUUID();
  await organizeLearningText(learning, pageId, { id, materialIds: ids }, { configure: () => config, generate: vi.fn().mockResolvedValue(result(ids)) });
  return id;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "learning-framework-synthetic-"));
  learning = new LearningRepository(root, "synthetic-owner"); opened.push(learning); repo = new LearningFrameworkRepository(learning);
  pageId = randomUUID(); learning.create({ id: pageId, title: "[合成测试] 框架" }); materialId = add();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network prohibited"); }));
});
afterEach(async () => {
  for (const r of opened.splice(0)) if (r.database.open) r.close();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  await rm(root, { force: true, recursive: true });
});

it("aligns an explicit learning generation timeout with the persisted publication deadline", async () => {
  const now = Date.now(), id = randomUUID();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const generate = vi.fn(async () => {
    clock.mockReturnValue(now + 160000);
    expect(repo.view(pageId).runs.find(r => r.id === id)?.status).toBe("generating");
    return result();
  });
  await organizeLearningText(learning, pageId, { id, materialIds: [materialId] }, { configure: () => ({ ...config, requestTimeoutMs: 600000 }), generate });
  expect(repo.view(pageId).runs.find(r => r.id === id)).toMatchObject({ status: "completed", deadline: now + 630000 });
});
it("holds the publication write lock while checking the coordinator fence",async()=>{
  const other=new LearningRepository(root,"synthetic-owner");opened.push(other);other.database.pragma("busy_timeout=1");
  const guard=vi.fn(()=>{
    expect(learning.database.inTransaction).toBe(true);
    expect(()=>other.database.prepare("UPDATE learning_pages SET title='SYNTHETIC concurrent' WHERE id=?").run(pageId)).toThrow(/locked/);
  });
  const id=randomUUID();await organizeLearningText(learning,pageId,{id,materialIds:[materialId]},{configure:()=>config,generate:vi.fn().mockResolvedValue(result())},guard);
  expect(guard).toHaveBeenCalledTimes(4);expect(repo.view(pageId).runs.find(r=>r.id===id)?.status).toBe("completed");
});

describe("text framework isolated persistence and generation (mock only)", () => {
  it("persists schema failure paths in both the run and checkpoint without response content", async () => {
    const id = randomUUID();
    const output = { overview: "PRIVATE_SYNTHETIC_BODY", chapters: [{ title: "PRIVATE_TITLE", explanation: "PRIVATE_TEXT", nodes: [
      { title: "PRIVATE_NODE", sources: ["r1"] }
    ] }] };
    const fetch = vi.fn(async () => new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
      status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(output) }] }]
    } })}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetch);
    const view = await organizeLearningText(learning, pageId, { id, materialIds: [materialId] }, { configure: () => config, generate: generateLearningFramework });
    expect(view.runs[0]).toMatchObject({ status: "failed", failure: "framework_invalid_result" });
    expect(view.chapters).toEqual([]);
    for (const table of ["learning_framework_runs", "learning_generation_parts"]) {
      const row = learning.database.prepare(`SELECT diagnostics_json FROM ${table} WHERE ${table === "learning_framework_runs" ? "id" : "run_id"}=?`).get(id) as { diagnostics_json: string };
      expect(JSON.parse(row.diagnostics_json)).toMatchObject({ validationIssueCount: 1,
        validationIssues: [{ path: "chapters[0].nodes[0].explanation", code: "missing_field" }] });
      expect(row.diagnostics_json).not.toMatch(/PRIVATE|SYNTHETIC_NOT_A_KEY|rawResponse|apiKey/);
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(learning.source(pageId, materialId).text).toBe(text);
  });
  it("persists adopted request settings and reported usage without raw Provider diagnostics", async () => {
    const id = randomUUID();
    await organizeLearningText(learning, pageId, { id, materialIds: [materialId] }, {
      configure: () => config, generate: vi.fn().mockImplementation(async (_c, _i, _s, observe) => {
        observe({ responseStatus: "completed", responseTextLength: 123, inputTokens: 10, outputTokens: 20, totalTokens: 30,
          parseResult: "success", validationResult: "success", validationIssues: [{ path: "SECRET_BODY", code: "SECRET", message: "PRIVATE_CONTENT" }] });
        return result();
      })
    });
    const row = learning.database.prepare("SELECT diagnostics_json FROM learning_framework_runs WHERE id=?").get(id) as { diagnostics_json: string };
    expect(JSON.parse(row.diagnostics_json)).toMatchObject({ model: config.model, maxOutputTokens: config.maxOutputTokens, inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    expect(row.diagnostics_json).not.toMatch(/PRIVATE|SECRET|apiKey|baseURL/);
  });
  it("publishes the selected text/TXT batch together and reopens exact paragraph-bound results", async () => {
    const txt = add("txt"); const ignored = add();
    const generator = vi.fn().mockImplementation(async (_config, inputs) => {
      expect(inputs.map((i: { materialId: string }) => i.materialId).sort()).toEqual([materialId, txt].sort());
      expect(JSON.stringify(inputs)).not.toContain(ignored);
      expect(repo.view(pageId).chapters).toEqual([]);
      expect(repo.view(pageId).runs[0].status).toBe("generating");
      return result([materialId, txt]);
    });
    const view = await organizeLearningText(learning, pageId, { id: randomUUID(), materialIds: [txt, materialId] }, { configure: () => config, generate: generator });
    expect(generator).toHaveBeenCalledTimes(1); expect(view.chapters).toHaveLength(2);
    expect(view.overview.map((c) => c.title)).toEqual(view.chapters.map((c) => c.title));
    const c = view.chapters[0]; const source = repo.source(pageId, c.id, c.nodes[1].id, 0);
    expect(source.paragraph).toMatchObject({ number: 2, start: text.indexOf("第二段"), text: "第二段：并非所有关系都是线性的。" });
    expect(c.nodes[1].sources[0].originalSha256).toMatch(/^[a-f0-9]{64}$/u);
    learning.close(); learning = new LearningRepository(root, "synthetic-owner"); opened.push(learning); repo = new LearningFrameworkRepository(learning);
    expect(repo.view(pageId)).toEqual(view); expect(learning.source(pageId, materialId).text).toBe(text);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("has no product model fallback and makes no attempt when learning config is missing", async () => {
    expect(() => learningGenerationConfig({ OPENAI_API_KEY: "SHOULD_NOT_USE", OPENAI_BASE_URL: "https://other.invalid", WORK_REVIEW_MODEL: "other" })).toThrow("learning_generation_not_configured");
    await expect(organizeLearningText(learning, pageId, { id: randomUUID(), materialIds: [materialId] }, {
      configure: () => learningGenerationConfig({}), generate: vi.fn()
    })).rejects.toThrow("learning_generation_not_configured");
    expect(repo.view(pageId).runs).toHaveLength(0); expect(fetch).not.toHaveBeenCalled();
    expect(() => learningGenerationConfig({ LEARNING_AI_BASE_URL: "https://user:pass@invalid", LEARNING_AI_API_KEY: "x", LEARNING_AI_MODEL: "x" })).toThrow();
  });
  it("does not reuse a request ID or busy page for additional calls, including after failure", async () => {
    const id = randomUUID(); let resolve!: (r: GeneratedFramework) => void;
    const generate = vi.fn(() => new Promise<GeneratedFramework>((r) => { resolve = r; }));
    const dependencies = { configure: () => config, generate };
    const first = organizeLearningText(learning, pageId, { id, materialIds: [materialId] }, dependencies);
    const duplicate = await organizeLearningText(learning, pageId, { id, materialIds: [materialId] }, dependencies);
    expect(duplicate.runs[0].status).toBe("generating");
    await expect(organizeLearningText(learning, pageId, { id: randomUUID(), materialIds: [materialId] }, dependencies)).rejects.toThrow("framework_busy");
    resolve(result()); await first;
    await organizeLearningText(learning, pageId, { id, materialIds: [materialId] }, dependencies);
    expect(generate).toHaveBeenCalledTimes(1); expect(repo.view(pageId).chapters).toHaveLength(1);
    const other = add(); expect(() => repo.existing(pageId, { id, materialIds: [other] })).toThrow("submission_conflict");
  });
  it.each(["invalid_source", "missing_material", "invalid_result", "provider"])("keeps previous results and sources on %s failure", async (mode) => {
    await generated(); const before = repo.view(pageId).chapters; const second = add();
    const bad = result();
    if (mode === "invalid_source") bad.chapters[0].nodes[0].sources[0].paragraph = 999;
    const generate = mode === "provider" ? vi.fn().mockRejectedValue(new Error("SECRET_PROVIDER_BODY"))
      : vi.fn().mockResolvedValue(mode === "invalid_result" ? { unexpected: "SECRET_RAW_TEXT" } : bad);
    const view = await organizeLearningText(learning, pageId, { id: randomUUID(), materialIds: mode === "missing_material" ? [materialId, second] : [materialId] }, { configure: () => config, generate });
    expect(view.chapters).toEqual(before); expect(view.runs.at(-1)?.status).toBe("failed");
    expect(JSON.stringify(view)).not.toContain("SECRET"); expect(learning.source(pageId, materialId).text).toBe(text);
    const count = generate.mock.calls.length;
    await organizeLearningText(learning, pageId, { id: view.runs.at(-1)!.id, materialIds: view.runs.at(-1)!.materialIds }, { configure: () => config, generate });
    expect(generate).toHaveBeenCalledTimes(count);
  });
  it("rejects scope outside the page, unsupported PDF and overflow without truncation or generation", async () => {
    const otherPage = learning.create({ id: randomUUID(), title: "[合成] 其他页" });
    expect(() => repo.begin(otherPage.id, { id: randomUUID(), materialIds: [materialId] }, 10000)).toThrow("material_not_found");
    const accepted=repo.begin(pageId, { id: randomUUID(), materialIds: [materialId] }, 10);
    expect(accepted.inputs[0].paragraphs.map(p=>p.text)).toEqual(learning.source(pageId,materialId).paragraphs.map(p=>p.text));
    repo.fail(pageId,accepted.run.id,"synthetic_stop");
    learning.database.prepare("UPDATE learning_materials SET kind='pdf' WHERE id=?").run(materialId);
    expect(() => repo.begin(pageId, { id: randomUUID(), materialIds: [materialId] }, 10000)).toThrow("pdf_not_parsed");
    expect(repo.view(pageId).runs).toHaveLength(1);
  });
  it("preserves edits, notes and immutable AI original while appending a new batch and updating overview", async () => {
    await generated(); const c = repo.view(pageId).chapters[0];
    repo.edit(pageId, { kind: "node", chapterId: c.id, revision: 0, nodeId: c.nodes[0].id, title: "用户标题", explanation: "用户解释", note: "我的笔记" });
    repo.edit(pageId, { kind: "chapter", chapterId: c.id, revision: 1, title: "用户章节", explanation: "用户章节说明" });
    const before = repo.view(pageId).chapters[0];
    await generated([add("txt")]);
    const view = repo.view(pageId); expect(view.chapters[0]).toEqual(before); expect(view.overview[0].title).toBe("用户章节"); expect(view.overview).toHaveLength(2);
    const original = learning.database.prepare("SELECT original_json FROM learning_framework_chapters WHERE id=?").get(c.id) as { original_json: string };
    expect(original.original_json).not.toContain("我的笔记"); expect(original.original_json).toContain("模拟");
  });
  it("keeps AI and personal-note provenance distinct when only a note changes", async () => {
    await generated(); const chapter = repo.view(pageId).chapters[0]; const node = chapter.nodes[0];
    repo.edit(pageId, { kind: "node", chapterId: chapter.id, revision: 0, nodeId: node.id,
      title: node.title, explanation: node.explanation, note: "只加个人笔记" });
    expect(repo.view(pageId).chapters[0].nodes[0]).toMatchObject({ edited: false, note: "只加个人笔记", sources: node.sources });
  });
  it("rejects concurrent stale edits and moves, moves notes and sources together without changing originals", async () => {
    await generated([materialId, add()]);
    const [a, b] = repo.view(pageId).chapters;
    repo.edit(pageId, { kind: "node", chapterId: a.id, revision: a.revision, nodeId: a.nodes[0].id, title: "新标题", explanation: "新解释", note: "不会丢失" });
    const second = new LearningRepository(root, "synthetic-owner"); opened.push(second);
    expect(() => new LearningFrameworkRepository(second).edit(pageId, { kind: "chapter", chapterId: a.id, revision: 0, title: "冲突", explanation: "冲突" })).toThrow("framework_edit_conflict");
    expect(() => repo.edit(pageId, { kind: "move", chapterId: a.id, revision: 1, nodeId: a.nodes[0].id, targetChapterId: b.id, targetRevision: 100, position: 0 })).toThrow("framework_edit_conflict");
    repo.edit(pageId, { kind: "move", chapterId: a.id, revision: 1, nodeId: a.nodes[0].id, targetChapterId: b.id, targetRevision: 0, position: 0 });
    const view = repo.view(pageId); expect(view.chapters[1].nodes[0]).toMatchObject({ id: a.nodes[0].id, note: "不会丢失", sources: a.nodes[0].sources });
    expect(view.chapters[0].nodes).toHaveLength(1);
    repo.edit(pageId, { kind: "move", chapterId: b.id, revision: 1, nodeId: a.nodes[0].id, targetChapterId: b.id, targetRevision: 1, position: 2 });
    expect(repo.view(pageId).chapters[1].nodes[2].id).toBe(a.nodes[0].id);
  });
  it("rejects foreign account reads, mutations, generation, and source access even in the same database", async () => {
    await generated(); const c = repo.view(pageId).chapters[0];
    const stranger = new LearningRepository(root, "synthetic-stranger"); opened.push(stranger); const other = new LearningFrameworkRepository(stranger);
    for (const read of [() => other.view(pageId), () => other.source(pageId, c.id, c.nodes[0].id, 0), () => other.begin(pageId, { id: randomUUID(), materialIds: [materialId] }, 10000),
      () => other.edit(pageId, { kind: "chapter", chapterId: c.id, revision: 0, title: "攻击", explanation: "攻击" })]) expect(read).toThrow("page_not_found");
  });
  it.each(["material", "page"])("fences late %s writes from another connection and follows deletion retention", async (mode) => {
    await generated(); const before = repo.view(pageId).chapters;
    let resolve!: (r: GeneratedFramework) => void;
    const pending = organizeLearningText(learning, pageId, { id: randomUUID(), materialIds: [materialId] }, { configure: () => config,
      generate: () => new Promise((r) => { resolve = r; }) });
    const other = new LearningRepository(root, "synthetic-owner"); opened.push(other);
    if (mode === "material") other.deleteMaterial(pageId, materialId); else other.deletePage(pageId);
    resolve(result());
    if (mode === "page") { await expect(pending).rejects.toThrow("page_deleted"); expect(learning.database.prepare("SELECT count(*) n FROM learning_framework_chapters").get()).toEqual({ n: 0 }); }
    else { await pending; expect(repo.view(pageId).chapters).toEqual(before); expect(() => repo.source(pageId, before[0].id, before[0].nodes[0].id, 0)).toThrow("material_deleted");
      expect(learning.database.prepare("SELECT original FROM learning_materials WHERE id=?").get(materialId)).toEqual({ original: null }); }
  });
  it("expires unknown work without automatic replay and rejects changed source bindings", async () => {
    const id = randomUUID(); repo.begin(pageId, { id, materialIds: [materialId] }, 10000);
    learning.database.prepare("UPDATE learning_framework_runs SET deadline=0 WHERE id=?").run(id);
    expect(repo.view(pageId).runs[0]).toMatchObject({ status: "failed", failure: "framework_interrupted" });
    expect(repo.begin(pageId, { id, materialIds: [materialId] }, 10000).created).toBe(false);
    const second = randomUUID(); repo.begin(pageId, { id: second, materialIds: [materialId] }, 10000); repo.validating(pageId, second);
    learning.database.prepare("UPDATE learning_materials SET original=? WHERE id=?").run(Buffer.from("[合成] changed"), materialId);
    expect(() => repo.complete(pageId, second, result())).toThrow("source_changed"); expect(repo.view(pageId).chapters).toHaveLength(0);
  });
  it("rolls back a batch on storage failure; migration 3->4 preserves prior material bytes", async () => {
    learning.database.exec("CREATE TRIGGER fail_framework BEFORE INSERT ON learning_framework_chapters BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END");
    await generated(); expect(repo.view(pageId).runs[0]).toMatchObject({ status: "failed", failure: "framework_save_failed" }); expect(repo.view(pageId).chapters).toHaveLength(0);
    learning.database.exec("DROP TRIGGER fail_framework; DROP TABLE learning_framework_chapters; DROP TABLE learning_framework_runs; PRAGMA user_version=3");
    learning.close(); learning = new LearningRepository(root, "synthetic-owner"); opened.push(learning); repo = new LearningFrameworkRepository(learning);
    expect(learning.database.pragma("user_version", { simple: true })).toBe(11); expect(learning.source(pageId, materialId).text).toBe(text);
    expect(repo.view(pageId)).toEqual({ runs: [], chapters: [], overview: [] });
    learning.close(); const db = new Database(join(root, "learning-organizer.sqlite"));
    db.exec("DROP TABLE learning_framework_chapters; DROP TABLE learning_framework_runs; PRAGMA user_version=3; CREATE VIEW learning_framework_runs AS SELECT 1"); db.close();
    expect(() => new LearningRepository(root, "synthetic-owner")).toThrow();
    const check = new Database(join(root, "learning-organizer.sqlite")); expect(check.pragma("user_version", { simple: true })).toBe(3); check.close();
  });
});
