import { createHash, randomUUID } from "node:crypto";
import {
  EditLearningFramework, GeneratedLearningFramework, StartLearningFramework,
  FRAMEWORK_DEADLINE_MS, FRAMEWORK_MAX_INPUT_CHARS, FRAMEWORK_MAX_RESULT_BYTES,
  type FrameworkChapter, type FrameworkRun, type FrameworkView, type FrameworkSource
} from "@/lib/domain/learning-framework";
import { LearningError, type LearningRepository } from "./repository";
import { generationProgress } from "./generation-parts";
import { learningValidationDiagnostics } from "./generation-diagnostics";

export const frameworkHash = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
type Binding = { materialId: string; sha256: string; sourceSha256?: string };
type RunRow = {
  id: string; page_id: string; scope_json: string; status: FrameworkRun["status"];
  created_at: string; deadline: number; failure: string | null; overview: string | null;
};
type ChapterRow = { id: string; run_id: string; revision: number; current_json: string };
export type FrameworkInput = { materialId: string; title: string; kind?: string; scopeNotice?: import("@/lib/domain/learning").LearningSource["scopeNotice"]; paragraphs: Array<{ number: number; text: string }> };
const runView = (r: RunRow): FrameworkRun => ({ id: r.id, status: r.status,
  materialIds: (JSON.parse(r.scope_json) as Binding[]).map((b) => b.materialId), createdAt: r.created_at,
  deadline: r.deadline, failure: r.failure, overview: r.overview });
const chapterView = (r: ChapterRow): FrameworkChapter => ({ ...JSON.parse(r.current_json), id: r.id, runId: r.run_id, revision: r.revision });

/** Only learning-owned rows in the existing account database. No cached source text. */
export class LearningFrameworkRepository {
  constructor(private readonly learning: LearningRepository) {}
  private get db() { return this.learning.database; }
  private expire(pageId: string) {
    this.db.prepare(`UPDATE learning_framework_runs SET status='failed', failure='framework_interrupted'
      WHERE page_id=? AND status IN ('generating','validating') AND deadline <= ?`).run(pageId, Date.now());
  }
  private run(pageId: string, id: string): RunRow {
    this.learning.get(pageId);
    this.expire(pageId);
    const row = this.db.prepare("SELECT * FROM learning_framework_runs WHERE id=? AND page_id=?").get(id, pageId) as RunRow | undefined;
    if (!row) throw new LearningError(404, "framework_not_found");
    return row;
  }
  view(pageId: string): FrameworkView {
    return this.db.transaction(() => {
      this.learning.get(pageId); this.expire(pageId);
      const runs = (this.db.prepare("SELECT * FROM learning_framework_runs WHERE page_id=? ORDER BY rowid").all(pageId) as RunRow[]).map(r => {
        const progress = generationProgress(this.learning, pageId, "framework", r.id);
        return { ...runView(r), ...(progress ? { progress } : {}) };
      });
      const chapters = (this.db.prepare("SELECT * FROM learning_framework_chapters WHERE page_id=? ORDER BY rowid").all(pageId) as ChapterRow[]).map(chapterView);
      return { runs, chapters, overview: chapters.map(({ id, title, explanation }) => ({ id, title, explanation })) };
    }).immediate();
  }
  existing(pageId: string, input: unknown): FrameworkRun | undefined {
    const value = StartLearningFramework.parse(input);
    return this.db.transaction(() => {
      this.learning.get(pageId); this.expire(pageId);
      const row = this.db.prepare("SELECT * FROM learning_framework_runs WHERE id=?").get(value.id) as RunRow | undefined;
      if (!row) return undefined;
      if (row.page_id !== pageId || JSON.stringify(runView(row).materialIds) !== JSON.stringify([...value.materialIds].sort())) throw new LearningError(409, "submission_conflict");
      return runView(row);
    }).immediate();
  }
  begin(pageId: string, input: unknown, maxInputChars: number, deadlineMs = FRAMEWORK_DEADLINE_MS): { created: boolean; run: FrameworkRun; inputs: FrameworkInput[] } {
    if (!Number.isInteger(deadlineMs) || deadlineMs < 31_000 || deadlineMs > 630_000) throw new LearningError(503, "learning_generation_not_configured");
    const value = StartLearningFramework.parse(input);
    return this.db.transaction(() => {
      const existing = this.existing(pageId, value);
      if (existing && !(value.resume && existing.status === "failed" && generationProgress(this.learning, pageId, "framework", value.id)?.canResume)) return { created: false, run: existing, inputs: [] };
      if (this.db.prepare("SELECT id FROM learning_framework_runs WHERE page_id=? AND status IN ('generating','validating')").get(pageId)) throw new LearningError(409, "framework_busy");
      const inputs: FrameworkInput[] = [];
      const scope: Binding[] = [];
      for (const materialId of [...value.materialIds].sort()) {
        const source = this.learning.source(pageId, materialId); // Auth, page ownership, PDF and tombstone checks.
        const original = this.db.prepare("SELECT original FROM learning_materials WHERE id=? AND page_id=?").get(materialId, pageId) as { original: Buffer };
        scope.push({ materialId, sha256: frameworkHash(original.original), sourceSha256: frameworkHash(JSON.stringify(source.paragraphs)) });
        inputs.push({ materialId, title: source.material.title, kind: source.material.kind, ...(source.scopeNotice ? { scopeNotice: source.scopeNotice } : {}), paragraphs: source.paragraphs.map(({ number, text }) => ({ number, text })) });
      }
      // maxInputChars schedules individual requests; it is not an admission cap.
      if (existing) {
        this.assertSources(pageId, value.id);
        this.db.prepare("UPDATE learning_framework_runs SET status='generating',failure=NULL,deadline=? WHERE id=? AND page_id=?").run(Date.now()+deadlineMs,value.id,pageId);
        return { created: true, run: runView(this.run(pageId,value.id)), inputs };
      }
      const now = new Date().toISOString();
      this.db.prepare(`INSERT INTO learning_framework_runs(id,page_id,scope_json,status,created_at,deadline)
        VALUES(?,?,?,'generating',?,?)`).run(value.id, pageId, JSON.stringify(scope), now, Date.now() + deadlineMs);
      return { created: true, run: runView(this.run(pageId, value.id)), inputs };
    }).immediate();
  }
  assertSources(pageId: string, id: string) {
    const row = this.run(pageId,id);
    for (const b of JSON.parse(row.scope_json) as Binding[]) {
      const source = this.learning.source(pageId,b.materialId);
      const original = this.db.prepare("SELECT original FROM learning_materials WHERE id=? AND page_id=? AND deleted_at IS NULL").get(b.materialId,pageId) as {original:Buffer}|undefined;
      if (!original || frameworkHash(original.original)!==b.sha256 || (b.sourceSha256 && frameworkHash(JSON.stringify(source.paragraphs))!==b.sourceSha256)) throw new LearningError(409,"source_changed");
    }
  }
  validating(pageId: string, id: string) {
    this.db.transaction(() => {
      const row = this.run(pageId, id);
      if (row.status !== "generating") throw new LearningError(409, "framework_terminal");
      this.db.prepare("UPDATE learning_framework_runs SET status='validating' WHERE id=?").run(id);
    }).immediate();
  }
  complete(pageId: string, id: string, result: unknown, partitioned=false): void {
    if (!partitioned && Buffer.byteLength(JSON.stringify(result), "utf8") > FRAMEWORK_MAX_RESULT_BYTES) throw new LearningError(422, "framework_invalid_result");
    const schema=partitioned ? GeneratedLearningFramework.extend({chapters:GeneratedLearningFramework.shape.chapters.element.array().min(1)}) : GeneratedLearningFramework;
    const parsed = schema.safeParse(result);
    if (!parsed.success) throw new LearningError(422, "framework_invalid_result");
    if(parsed.data.chapters.some(c=>Buffer.byteLength(JSON.stringify(c))>FRAMEWORK_MAX_RESULT_BYTES))throw new LearningError(422,"framework_invalid_result");
    this.db.transaction(() => {
      const row = this.run(pageId, id);
      if (row.status !== "validating") throw new LearningError(409, "framework_terminal");
      const scope = JSON.parse(row.scope_json) as Binding[];
      const sources = new Map(scope.map((b) => {
        const source = this.learning.source(pageId, b.materialId);
        const stored = this.db.prepare("SELECT original FROM learning_materials WHERE id=? AND page_id=?").get(b.materialId, pageId) as { original: Buffer };
        if (frameworkHash(stored.original) !== b.sha256 || (b.sourceSha256 && b.sourceSha256 !== frameworkHash(JSON.stringify(source.paragraphs)))) throw new LearningError(409, "source_changed");
        return [b.materialId, { source, binding: b }];
      }));
      const used = new Set<string>();
      const chapters = parsed.data.chapters.map((chapter): FrameworkChapter => ({
        id: randomUUID(), runId: id, revision: 0, title: chapter.title, explanation: chapter.explanation, edited: false,
        nodes: chapter.nodes.map((node) => ({ ...node, id: randomUUID(), note: "", edited: false,
          sources: node.sources.map((ref): FrameworkSource => {
            const bound = sources.get(ref.materialId);
            const paragraph = bound?.source.paragraphs.find((p) => p.number === ref.paragraph);
            if (!bound || !paragraph) throw new LearningError(422, "framework_invalid_source");
            used.add(ref.materialId);
            return { ...ref, start: paragraph.start, end: paragraph.end,
              originalSha256: bound.binding.sha256, paragraphSha256: frameworkHash(paragraph.text),
              ...(paragraph.parsed ? { parsed: paragraph.parsed } : {}),
              ...(paragraph.startSeconds === undefined ? {} : { startSeconds: paragraph.startSeconds, endSeconds: paragraph.endSeconds }) };
          })
        }))
      }));
      if (scope.some((b) => !used.has(b.materialId))) throw new LearningError(422, "framework_missing_material");
      for (const chapter of chapters) {
        const body = JSON.stringify(chapter);
        this.db.prepare(`INSERT INTO learning_framework_chapters(id,page_id,run_id,revision,original_json,current_json)
          VALUES(?,?,?,0,?,?)`).run(chapter.id, pageId, id, body, body);
      }
      this.db.prepare("UPDATE learning_framework_runs SET status='completed',overview=?,failure=NULL WHERE id=?").run(parsed.data.overview, id);
    }).immediate();
  }
  fail(pageId: string, id: string, code: string) {
    this.db.transaction(() => {
      const row = this.run(pageId, id);
      if (row.status === "completed" || row.status === "failed") return;
      this.db.prepare("UPDATE learning_framework_runs SET status='failed',failure=? WHERE id=?").run(code, id);
    }).immediate();
  }
  diagnostics(pageId: string, id: string, input: import("@/lib/server/openai/structured-json").StructuredJsonDiagnostics) {
    this.db.transaction(() => {
      const row = this.run(pageId, id);
      if (!["generating", "validating"].includes(row.status)) return;
      const previous = this.db.prepare("SELECT diagnostics_json FROM learning_framework_runs WHERE id=?").get(id) as { diagnostics_json: string | null };
      const safe: Record<string, unknown> = previous.diagnostics_json ? JSON.parse(previous.diagnostics_json) : {};
      for (const key of ["inputTokens", "outputTokens", "totalTokens", "reasoningTokens", "totalDurationMs", "responseTextLength"] as const) {
        const value = input[key]; if (typeof value === "number" && Number.isFinite(value) && value >= 0) safe[key] = value;
      }
      if (["completed", "failed", "incomplete", "cancelled"].includes(input.responseStatus ?? "")) safe.status = input.responseStatus!;
      safe.parse = input.parseResult; safe.validation = input.validationResult;
      Object.assign(safe, learningValidationDiagnostics(input));
      this.db.prepare("UPDATE learning_framework_runs SET diagnostics_json=? WHERE id=?").run(JSON.stringify(safe), id);
    }).immediate();
  }
  recordConfig(pageId: string, id: string, config: import("./framework-generator").LearningGenerationConfig) {
    this.db.transaction(() => {
      const row = this.run(pageId, id); if (row.status !== "generating") throw new LearningError(409, "framework_terminal");
      this.db.prepare("UPDATE learning_framework_runs SET diagnostics_json=? WHERE id=?").run(JSON.stringify({
        provider: "tokenhub", model: config.model, transport: "responses-stream", maxInputChars: config.maxInputChars, maxOutputTokens: config.maxOutputTokens, requestTimeoutMs: config.requestTimeoutMs ?? 120_000
      }), id);
    }).immediate();
  }
  edit(pageId: string, input: unknown): FrameworkView {
    const value = EditLearningFramework.parse(input);
    return this.db.transaction(() => {
      const view = this.view(pageId);
      const chapter = view.chapters.find((c) => c.id === value.chapterId);
      if (!chapter) throw new LearningError(404, "framework_not_found");
      if (chapter.revision !== value.revision) throw new LearningError(409, "framework_edit_conflict");
      const write = (c: FrameworkChapter) => {
        this.db.prepare("UPDATE learning_framework_chapters SET revision=revision+1,current_json=? WHERE id=? AND page_id=? AND revision=?")
          .run(JSON.stringify(c), c.id, pageId, c.revision);
      };
      if (value.kind === "chapter") {
        chapter.title = value.title; chapter.explanation = value.explanation; chapter.edited = true;
      } else {
        const index = chapter.nodes.findIndex((n) => n.id === value.nodeId);
        if (index < 0) throw new LearningError(404, "framework_not_found");
        if (value.kind === "node") {
          const node = chapter.nodes[index];
          Object.assign(node, { title: value.title, explanation: value.explanation, note: value.note,
            edited: node.edited || node.title !== value.title || node.explanation !== value.explanation });
        } else {
          const target = view.chapters.find((c) => c.id === value.targetChapterId);
          if (!target) throw new LearningError(404, "framework_not_found");
          if (target.revision !== value.targetRevision) throw new LearningError(409, "framework_edit_conflict");
          const [node] = chapter.nodes.splice(index, 1);
          if (value.position > target.nodes.length) throw new LearningError(400, "invalid_input");
          target.nodes.splice(value.position, 0, node);
          if (target.id !== chapter.id) write(target);
        }
      }
      write(chapter);
      return this.view(pageId);
    }).immediate();
  }
  source(pageId: string, chapterId: string, nodeId: string, index: number) {
    const chapter = this.view(pageId).chapters.find((c) => c.id === chapterId);
    const ref = chapter?.nodes.find((n) => n.id === nodeId)?.sources[index];
    if (!ref) throw new LearningError(404, "framework_not_found");
    const original = this.learning.source(pageId, ref.materialId, ref.parsed);
    const paragraph = original.paragraphs.find((p) => p.number === ref.paragraph);
    const bytes = this.db.prepare("SELECT original FROM learning_materials WHERE id=? AND page_id=?").get(ref.materialId, pageId) as { original: Buffer };
    if (!paragraph || paragraph.start !== ref.start || paragraph.end !== ref.end || frameworkHash(paragraph.text) !== ref.paragraphSha256
      || frameworkHash(bytes.original) !== ref.originalSha256 || paragraph.startSeconds !== ref.startSeconds || paragraph.endSeconds !== ref.endSeconds || JSON.stringify(paragraph.parsed) !== JSON.stringify(ref.parsed)) throw new LearningError(409, "source_changed");
    return { materialId: ref.materialId, title: original.material.title, paragraph };
  }
}
