import type { z } from "zod";
import { AskLearningNode, GeneratedNodeAnswer, GeneratedOverview, ReferencedOverview, ReferencedOverviewItem, SaveAnswerNote, type NodeAnswer, type NodeConversation, type NodeTurn, type OverviewResult, type OverviewView, type StudyStatus, type OverviewValidation } from "@/lib/domain/learning-study";
import { FRAMEWORK_DEADLINE_MS, FRAMEWORK_MAX_RESULT_BYTES, type FrameworkSource } from "@/lib/domain/learning-framework";
import { LearningFrameworkRepository, frameworkHash, type FrameworkInput } from "./framework-repository";
import { LearningError, type LearningRepository } from "./repository";
import { generationProgress } from "./generation-parts";

type Run = { id: string; page_id: string; status: StudyStatus; failure: string | null; binding_hash: string; binding_json: string; result_json: string | null };
type Conversation = { id: string; page_id: string; chapter_id: string; node_id: string; binding_hash: string; binding_json: string };
type Turn = { id: string; conversation_id: string; question: string; action: string; created_at: string; status: StudyStatus; failure: string | null; answer_json: string | null; context_ids: string; omitted_turns: number };
const hash = (v: unknown) => frameworkHash(JSON.stringify(v));
const parsed = <T>(s: string): T => JSON.parse(s) as T;
function bounded(value: unknown) { if (Buffer.byteLength(JSON.stringify(value)) > FRAMEWORK_MAX_RESULT_BYTES) throw new LearningError(422, "framework_invalid_result"); }

/** Product-owned relation snapshots and node conversations; source bytes stay in materials. */
export class LearningStudyRepository {
  private framework: LearningFrameworkRepository;
  constructor(private learning: LearningRepository) { this.framework = new LearningFrameworkRepository(learning); }
  private get db() { return this.learning.database; }
  private page(pageId: string) {
    this.learning.get(pageId);
    for (const table of ["learning_overview_runs", "learning_node_turns"]) this.db.prepare(`UPDATE ${table} SET status='failed',failure='framework_interrupted' WHERE page_id=? AND status='generating' AND deadline<=?`).run(pageId, Date.now());
  }
  private source(pageId: string, ref: FrameworkSource) {
    const original = this.learning.source(pageId, ref.materialId, ref.parsed);
    const p = original.paragraphs.find(p => p.number === ref.paragraph);
    const row = this.db.prepare("SELECT original FROM learning_materials WHERE id=? AND page_id=?").get(ref.materialId, pageId) as { original: Buffer };
    if (!p || p.start !== ref.start || p.end !== ref.end || frameworkHash(p.text) !== ref.paragraphSha256 || frameworkHash(row.original) !== ref.originalSha256
      || p.startSeconds !== ref.startSeconds || p.endSeconds !== ref.endSeconds || JSON.stringify(p.parsed) !== JSON.stringify(ref.parsed)) throw new LearningError(409, "source_changed");
    return { materialId: ref.materialId, title: original.material.title, paragraph: p };
  }
  private inputs(pageId: string, refs: FrameworkSource[]) {
    const materials: FrameworkInput[] = [...new Set(refs.map(r => r.materialId))].sort().map(id => {
      const source = this.learning.source(pageId, id);
      const row = this.db.prepare("SELECT original FROM learning_materials WHERE id=? AND page_id=?").get(id,pageId) as {original:Buffer};
      const originalSha256 = frameworkHash(row.original), paragraphs = new Map(source.paragraphs.map(p=>[p.number,p]));
      // One material read inside this transaction, with every original fence retained.
      // Re-reading a whole parsed document for every node reference made real overviews stall.
      for (const ref of refs.filter(r=>r.materialId===id)) {
        const p = paragraphs.get(ref.paragraph);
        if (!p || p.start!==ref.start || p.end!==ref.end || frameworkHash(p.text)!==ref.paragraphSha256 || originalSha256!==ref.originalSha256
          || p.startSeconds!==ref.startSeconds || p.endSeconds!==ref.endSeconds || JSON.stringify(p.parsed)!==JSON.stringify(ref.parsed)) throw new LearningError(409,"source_changed");
      }
      return { materialId: id, title: source.material.title, ...(source.scopeNotice ? { scopeNotice: source.scopeNotice } : {}), paragraphs: source.paragraphs.map(({ number, text }) => ({ number, text })) };
    });
    return materials;
  }
  private modelMaterials(pageId: string, materials: FrameworkInput[]) {
    const kinds = new Map(this.learning.get(pageId).materials.map(m => [m.id, m.kind]));
    // Presentation metadata is not added to historical content/version hashes.
    return materials.map(m => ({ ...m, kind: kinds.get(m.materialId) }));
  }
  private bind(pageId: string, refs: Array<{ materialId: string; paragraph: number }>, materialIds: string[]): FrameworkSource[] {
    return refs.map(ref => {
      if (!materialIds.includes(ref.materialId)) throw new LearningError(422, "framework_invalid_source");
      const source = this.learning.source(pageId, ref.materialId), p = source.paragraphs.find(p => p.number === ref.paragraph);
      if (!p) throw new LearningError(422, "framework_invalid_source");
      const row = this.db.prepare("SELECT original FROM learning_materials WHERE id=? AND page_id=?").get(ref.materialId, pageId) as { original: Buffer };
      return { ...ref, start: p.start, end: p.end, originalSha256: frameworkHash(row.original), paragraphSha256: frameworkHash(p.text),
        ...(p.parsed ? { parsed: p.parsed } : {}),
        ...(p.startSeconds === undefined ? {} : { startSeconds: p.startSeconds, endSeconds: p.endSeconds }) };
    });
  }
  private overviewSnapshot(pageId: string) {
    const view = this.framework.view(pageId);
    const chapters = view.chapters.map(c => ({ id: c.id, runId: c.runId, title: c.title, explanation: c.explanation, edited: c.edited,
      nodes: c.nodes.map(n => ({ id: n.id, title: n.title, explanation: n.explanation, edited: n.edited, sources: n.sources })) }));
    const sources = chapters.flatMap(c => c.nodes.flatMap(n => n.sources));
    const materials = this.inputs(pageId, sources);
    // Hashes, byte offsets and parser bindings remain in the persisted fence above.
    // The model only needs exact paragraph addresses to join nodes to the full material text.
    const batches = [...new Set(chapters.map(c => c.runId))];
    return { binding: { chapters, sources, materialsHash: hash(materials) }, input: {
      chapters: chapters.map((c,i) => ({ ref: `c${i+1}`, batch: `b${batches.indexOf(c.runId)+1}`, title: c.title,
        nodes: c.nodes.map(n => ({ title: n.title, sources: n.sources.map(({materialId,paragraph}) => ({materialId,paragraph})) })) })),
      materials: this.modelMaterials(pageId, materials) } };
  }
  overview(pageId: string): OverviewView {
    return this.db.transaction(() => {
      this.page(pageId);
      const latest = this.db.prepare("SELECT * FROM learning_overview_runs WHERE page_id=? ORDER BY rowid DESC LIMIT 1").get(pageId) as Run | undefined;
      const saved = this.db.prepare("SELECT * FROM learning_overview_runs WHERE page_id=? AND status='completed' ORDER BY rowid DESC LIMIT 1").get(pageId) as Run | undefined;
      let stale = false, sourceState = "available";
      if (saved) try { stale = hash(this.overviewSnapshot(pageId).binding) !== saved.binding_hash; }
      catch (e) { stale = true; sourceState = e instanceof LearningError ? e.code : "source_changed"; }
      const validation = latest?.result_json ? parsed<OverviewResult>(latest.result_json).validation : undefined;
      return { latest: latest ? { id: latest.id, status: latest.status, failure: latest.failure, ...(validation ? { validation } : {}) } : null,
        published: saved ? { id: saved.id, result: parsed<OverviewResult>(saved.result_json!), stale, sourceState } : null };
    }).immediate();
  }
  assertOverviewSources(pageId:string,id:string) {
    this.page(pageId);
    const row=this.db.prepare("SELECT binding_hash FROM learning_overview_runs WHERE id=? AND page_id=?").get(id,pageId) as {binding_hash:string}|undefined;
    if(!row || hash(this.overviewSnapshot(pageId).binding)!==row.binding_hash)throw new LearningError(409,"study_content_changed");
  }
  beginOverview(pageId: string, id: string, limit: number, deadlineMs = FRAMEWORK_DEADLINE_MS, resume=false) {
    if (!Number.isInteger(deadlineMs) || deadlineMs < 31_000 || deadlineMs > 630_000) throw new LearningError(503, "learning_generation_not_configured");
    return this.db.transaction(() => {
      this.page(pageId);
      const old = this.db.prepare("SELECT page_id,status FROM learning_overview_runs WHERE id=?").get(id) as { page_id: string;status:string } | undefined;
      if (old) { if (old.page_id !== pageId) throw new LearningError(409, "submission_conflict");
        if(!(resume&&old.status==="failed"&&generationProgress(this.learning,pageId,"overview",id)?.canResume))return null; }
      if (new Set(this.framework.view(pageId).chapters.map(c => c.runId)).size < 2) return null;
      if (this.db.prepare("SELECT id FROM learning_overview_runs WHERE page_id=? AND status='generating'").get(pageId)) throw new LearningError(409, "overview_busy");
      const snapshot = this.overviewSnapshot(pageId);
      if(old){this.assertOverviewSources(pageId,id);this.db.prepare("UPDATE learning_overview_runs SET status='generating',failure=NULL,deadline=? WHERE id=? AND page_id=?").run(Date.now()+deadlineMs,id,pageId);return snapshot.input;}
      this.db.prepare("INSERT INTO learning_overview_runs(id,page_id,binding_hash,binding_json,status,deadline,created_at) VALUES(?,?,?,?,'generating',?,?)")
        .run(id, pageId, hash(snapshot.binding), JSON.stringify(snapshot.binding), Date.now() + deadlineMs, new Date().toISOString());
      return snapshot.input;
    }).immediate();
  }
  completeOverview(pageId: string, id: string, result: unknown, partitioned=false) {
    if(!partitioned)bounded(result);
    const referenced = typeof result === "object" && result !== null && "contractVersion" in result;
    const value = referenced ? (partitioned ? ReferencedOverview.extend({items:ReferencedOverview.shape.items.element.array()}) : ReferencedOverview).parse(result) : GeneratedOverview.parse(result);
    this.db.transaction(() => {
      this.page(pageId);
      const run = this.db.prepare("SELECT * FROM learning_overview_runs WHERE id=? AND page_id=?").get(id, pageId) as Run | undefined;
      if (!run || run.status !== "generating") throw new LearningError(409, "framework_terminal");
      const current = this.overviewSnapshot(pageId);
      if (hash(current.binding) !== run.binding_hash) throw new LearningError(409, "study_content_changed");
      const items: OverviewResult["items"] = [], validation: OverviewValidation = { submitted: value.items.length, accepted: 0, rejected: [] };
      for (const [index, raw] of value.items.entries()) {
        bounded(raw);
        const checked = referenced ? ReferencedOverviewItem.safeParse(raw) : GeneratedOverview.shape.items.element.safeParse(raw);
        if (!checked.success) { validation.rejected.push({ index, reason: "invalid_structure" }); continue; }
        const v = checked.data;
        const chapterIds = "chapterRefs" in v ? v.chapterRefs.map(ref => {
          const i = current.input.chapters.findIndex(c => c.ref === ref); return current.binding.chapters[i]?.id;
        }) : v.chapterIds;
        const chapters = chapterIds.map(id => current.binding.chapters.find(c => c.id === id));
        let reason: string | undefined;
        if (chapters.some(c => !c)) reason = "unknown_chapter";
        else if (new Set(chapterIds).size !== chapterIds.length) reason = "duplicate_chapter";
        else if (new Set(chapters.map(c => c!.runId)).size < 2) reason = "same_batch";
        if (reason) { validation.rejected.push({ index, reason }); continue; }
        let sources: FrameworkSource[];
        try { sources = this.bind(pageId, v.sources, current.input.materials.map(m => m.materialId)); }
        catch (e) { if (e instanceof LearningError && e.code === "framework_invalid_source") { validation.rejected.push({index,reason:"source_outside_scope"}); continue; } throw e; }
        if (chapters.some(c => !c!.nodes.some(n => n.sources.some(r => sources.some(s => s.materialId === r.materialId && s.paragraph === r.paragraph))))) {
          validation.rejected.push({ index, reason: "chapter_evidence_missing" }); continue;
        }
        items.push({ kind: v.kind, title: v.title, explanation: v.explanation, chapterIds: chapterIds as string[], sources });
      }
      validation.accepted = items.length;
      const allInvalid = value.items.length > 0 && items.length === 0;
      const stored: OverviewResult = { summary: validation.rejected.length ? `本次保留 ${items.length} 条通过来源与批次检查的关系，另有 ${validation.rejected.length} 条未发布；范围不完整，请按下列条目查看。` : value.summary,
        items, validation, ...(validation.rejected.length ? { generatedSummary: value.summary } : {}) };
      this.db.prepare("UPDATE learning_overview_runs SET status=?,failure=?,result_json=? WHERE id=?").run(allInvalid ? "failed" : "completed", allInvalid ? "overview_no_valid_relations" : null, JSON.stringify(stored), id);
    }).immediate();
  }
  private node(pageId: string, chapterId: string, nodeId: string) {
    const c = this.framework.view(pageId).chapters.find(c => c.id === chapterId), n = c?.nodes.find(n => n.id === nodeId);
    if (!c || !n) throw new LearningError(404, "framework_not_found");
    return { chapter: c, node: n };
  }
  private nodeSnapshot(pageId: string, chapterId: string, nodeId: string) {
    const { chapter, node: n } = this.node(pageId, chapterId, nodeId);
    const node = { chapterId, chapterTitle: chapter.title, nodeId, title: n.title, explanation: n.explanation, edited: n.edited, supplement: n.supplement };
    const materials = this.inputs(pageId, n.sources);
    const binding = { node, sources: n.sources, materialsHash: hash(materials) };
    return { binding, input: { node, materials: this.modelMaterials(pageId, materials) } };
  }
  private conversation(pageId: string, id: string): Conversation {
    this.page(pageId);
    const row = this.db.prepare("SELECT * FROM learning_node_conversations WHERE id=? AND page_id=?").get(id, pageId) as Conversation | undefined;
    if (!row) throw new LearningError(404, "conversation_not_found"); return row;
  }
  private conversationState(row: Conversation) {
    try { return hash(this.nodeSnapshot(row.page_id, row.chapter_id, row.node_id).binding) === row.binding_hash ? "current" : "study_content_changed"; }
    catch (e) { return e instanceof LearningError ? e.code : "source_changed"; }
  }
  conversations(pageId: string, chapterId: string, nodeId: string): NodeConversation[] {
    return this.db.transaction(() => {
      this.page(pageId); this.node(pageId, chapterId, nodeId);
      const rows = this.db.prepare("SELECT * FROM learning_node_conversations WHERE page_id=? AND node_id=? ORDER BY rowid").all(pageId, nodeId) as Conversation[];
      return rows.map(row => ({ id: row.id, title: parsed<{ node: { title: string } }>(row.binding_json).node.title, state: this.conversationState(row),
        turns: (this.db.prepare("SELECT * FROM learning_node_turns WHERE conversation_id=? ORDER BY rowid").all(row.id) as Turn[]).map(t => ({
          id: t.id, question: t.question, action: t.action, createdAt: t.created_at, status: t.status, failure: t.failure,
          answer: t.answer_json ? parsed<NodeAnswer>(t.answer_json) : null, contextTurnIds: parsed<string[]>(t.context_ids), omittedTurns: t.omitted_turns,
          savedSections: (this.db.prepare("SELECT section FROM learning_answer_notes WHERE turn_id=?").all(t.id) as { section: number }[]).map(r => r.section)
        } satisfies NodeTurn)) }));
    }).immediate();
  }
  beginAnswer(pageId: string, input: z.infer<typeof AskLearningNode>, limit: number, deadlineMs = FRAMEWORK_DEADLINE_MS) {
    if (!Number.isInteger(deadlineMs) || deadlineMs < 31_000 || deadlineMs > 630_000) throw new LearningError(503, "learning_generation_not_configured");
    return this.db.transaction(() => {
      this.page(pageId);
      const old = this.db.prepare("SELECT *,page_id FROM learning_node_turns WHERE id=?").get(input.id) as (Turn & { page_id: string }) | undefined;
      if (old) {
        const c = this.conversation(pageId, old.conversation_id);
        if (old.page_id !== pageId || old.conversation_id !== input.conversationId || old.action !== input.action || old.question !== input.question || c.chapter_id !== input.chapterId || c.node_id !== input.nodeId) throw new LearningError(409, "submission_conflict");
        return null;
      }
      const snapshot = this.nodeSnapshot(pageId, input.chapterId, input.nodeId);
      const existing = this.db.prepare("SELECT * FROM learning_node_conversations WHERE id=?").get(input.conversationId) as Conversation | undefined;
      if (existing && (existing.page_id !== pageId || existing.chapter_id !== input.chapterId || existing.node_id !== input.nodeId || existing.binding_hash !== hash(snapshot.binding))) throw new LearningError(409, "study_content_changed");
      if (!existing) this.db.prepare("INSERT INTO learning_node_conversations(id,page_id,chapter_id,node_id,binding_hash,binding_json,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(input.conversationId, pageId, input.chapterId, input.nodeId, hash(snapshot.binding), JSON.stringify(snapshot.binding), new Date().toISOString());
      if (this.db.prepare("SELECT id FROM learning_node_turns WHERE conversation_id=? AND status='generating'").get(input.conversationId)) throw new LearningError(409, "node_qa_busy");
      const history = this.db.prepare("SELECT * FROM learning_node_turns WHERE conversation_id=? AND status='completed' ORDER BY rowid DESC").all(input.conversationId) as Turn[];
      const request = { ...snapshot.input, action: input.action, question: input.question, history: [] as Array<{ id: string; question: string; answer: NodeAnswer }>, omittedTurns: history.length };
      if (JSON.stringify(request).length > limit) throw new LearningError(413, "node_context_too_large");
      for (const turn of history) {
        const next = { id: turn.id, question: turn.question, answer: parsed<NodeAnswer>(turn.answer_json!) };
        const candidate = { ...request, history: [next, ...request.history], omittedTurns: request.omittedTurns - 1 };
        if (JSON.stringify(candidate).length > limit) break;
        request.history = candidate.history; request.omittedTurns = candidate.omittedTurns;
      }
      this.db.prepare("INSERT INTO learning_node_turns(id,page_id,conversation_id,action,question,status,deadline,created_at,context_ids,omitted_turns) VALUES(?,?,?,?,?,'generating',?,?,?,?)")
        .run(input.id, pageId, input.conversationId, input.action, input.question, Date.now() + deadlineMs, new Date().toISOString(), JSON.stringify(request.history.map(t => t.id)), request.omittedTurns);
      return request;
    }).immediate();
  }
  completeAnswer(pageId: string, id: string, result: unknown) {
    bounded(result); const value = GeneratedNodeAnswer.parse(result);
    this.db.transaction(() => {
      this.page(pageId);
      const turn = this.db.prepare("SELECT * FROM learning_node_turns WHERE id=? AND page_id=?").get(id, pageId) as Turn | undefined;
      if (!turn || turn.status !== "generating") throw new LearningError(409, "framework_terminal");
      const c = this.conversation(pageId, turn.conversation_id);
      if (this.conversationState(c) !== "current") throw new LearningError(409, "study_content_changed");
      const snapshot = this.nodeSnapshot(pageId, c.chapter_id, c.node_id);
      const answer = { ...value, items: this.bind(pageId, value.items, snapshot.input.materials.map(m => m.materialId)) };
      this.db.prepare("UPDATE learning_node_turns SET status='completed',answer_json=? WHERE id=?").run(JSON.stringify(answer), id);
    }).immediate();
  }
  fail(pageId: string, kind: "overview" | "answer", id: string, code: string) {
    this.learning.get(pageId);
    this.db.prepare(`UPDATE ${kind === "overview" ? "learning_overview_runs" : "learning_node_turns"} SET status='failed',failure=? WHERE id=? AND page_id=? AND status='generating'`).run(code, id, pageId);
  }
  diagnostics(pageId: string, kind: "overview" | "answer", id: string, value: object) {
    this.learning.get(pageId);
    const safe = Object.fromEntries(Object.entries(value).filter(([k,v]) => ["model","maxInputChars","maxOutputTokens","requestTimeoutMs","inputTokens","outputTokens","reasoningTokens","reasoningEffort","totalTokens","totalDurationMs","responseStatus","parseResult","validationResult"].includes(k) && (typeof v === "number" || typeof v === "string")));
    const table = kind === "overview" ? "learning_overview_runs" : "learning_node_turns";
    this.db.prepare(`UPDATE ${table} SET diagnostics_json=json_patch(coalesce(diagnostics_json,'{}'),?) WHERE id=? AND page_id=? AND status='generating'`).run(JSON.stringify(safe), id, pageId);
  }
  readSource(pageId: string, kind: "overview" | "answer", id: string, item: number, index: number) {
    this.page(pageId); let ref: FrameworkSource | undefined;
    if (kind === "overview") {
      const row = this.db.prepare("SELECT result_json FROM learning_overview_runs WHERE id=? AND page_id=? AND status='completed'").get(id, pageId) as { result_json: string } | undefined;
      ref = row ? parsed<OverviewResult>(row.result_json).items[item]?.sources[index] : undefined;
    } else {
      const row = this.db.prepare("SELECT answer_json FROM learning_node_turns WHERE id=? AND page_id=? AND status='completed'").get(id, pageId) as { answer_json: string } | undefined;
      ref = row ? parsed<NodeAnswer>(row.answer_json).items[index] : undefined;
    }
    if (!ref) throw new LearningError(404, "framework_not_found"); return this.source(pageId, ref);
  }
  saveNote(pageId: string, input: unknown) {
    const v = SaveAnswerNote.parse(input);
    return this.db.transaction(() => {
      this.page(pageId); const current = this.node(pageId, v.chapterId, v.nodeId);
      const t = this.db.prepare("SELECT * FROM learning_node_turns WHERE id=? AND page_id=? AND status='completed'").get(v.turnId, pageId) as Turn | undefined;
      if (!t || this.conversation(pageId, t.conversation_id).node_id !== v.nodeId) throw new LearningError(404, "conversation_not_found");
      if (this.db.prepare("SELECT 1 FROM learning_answer_notes WHERE turn_id=? AND section=?").get(v.turnId, v.section)) return this.framework.view(pageId);
      const answer = parsed<NodeAnswer>(t.answer_json!);
      const text = v.section === -1 ? answer.materialAnswer : answer.supplements[v.section]?.text;
      if (!text) throw new LearningError(400, "invalid_input");
      const note = [current.node.note, `从知识点对话存入（${v.section === -1 ? "材料内容的 AI 解释" : "补充解释/例子·材料外"}）\n${text}`].filter(Boolean).join("\n\n");
      if (note.length > 20000) throw new LearningError(413, "note_too_large");
      const result = this.framework.edit(pageId, { kind: "node", chapterId: v.chapterId, nodeId: v.nodeId, revision: v.revision,
        title: current.node.title, explanation: current.node.explanation, note });
      this.db.prepare("INSERT INTO learning_answer_notes(turn_id,section,page_id) VALUES(?,?,?)").run(v.turnId, v.section, pageId);
      return result;
    }).immediate();
  }
}
