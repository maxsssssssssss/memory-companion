import { BeginQuizAttempt, GeneratedQuiz, ReferencedQuizEnvelope, QuizAction, StartQuiz, type QuizConfig, type QuizSource, type SavedQuiz, type QuizProgress, type QuizAttemptView, type QuizRunSummary } from "@/lib/domain/learning-quiz";
import { FRAMEWORK_DEADLINE_MS, FRAMEWORK_MAX_RESULT_BYTES } from "@/lib/domain/learning-framework";
import { LearningFrameworkRepository, frameworkHash } from "./framework-repository";
import { LearningError, type LearningRepository } from "./repository";
import { quizReferenceId, resolveReferencedQuiz, quizProceduralHint } from "./quiz-grounding";
import { quizCoverageNotice } from "./quiz-composition";
import { learningValidationDiagnostics } from "./generation-diagnostics";
import { generationProgress } from "./generation-parts";

type Run = { id: string; page_id: string; settings_json: string; binding_json: string; binding_hash: string; status: QuizRunSummary["status"] | "deleted"; created_at: string; failure: string | null; result_json: string | null };
type Attempt = { id: string; page_id: string; quiz_id: string; mode: "practice" | "test"; revision: number; progress_json: string; events_json: string; evaluation_json: string; created_at: string; completed_at: string | null };
type Evaluation = { correct: Array<boolean | null>; score: QuizAttemptView["score"] };
type Extra = { id: string; kind: "note" | "supplement"; chapterId: string; nodeId: string; text: string };
type Binding = { materials: Array<{ materialId: string; originalSha256: string; paragraphs: Array<{ parsed?: import("@/lib/domain/learning-pdf-study").ParsedTextBinding; number: number; hash: string; start: number; end: number; startSeconds?: number; endSeconds?: number }> }>; extras: QuizSource[] };
const parse = <T>(v: string): T => JSON.parse(v) as T;
const hash = (v: unknown) => frameworkHash(JSON.stringify(v));
const blank = (): QuizProgress => ({ optionId: null, submitted: false, skipped: false, hinted: false, revealed: false });
const terminal = (p: QuizProgress) => p.submitted || p.skipped || p.revealed;

/** Learning-only immutable question groups, answer-free public views and CAS attempt progress. */
export class LearningQuizRepository {
  constructor(private learning: LearningRepository) {}
  private get db() { return this.learning.database; }
  private page(pageId: string) {
    this.learning.get(pageId);
    this.db.prepare("UPDATE learning_quiz_runs SET status='failed',failure='framework_interrupted' WHERE page_id=? AND status='generating' AND deadline<=?").run(pageId, Date.now());
  }
  private run(pageId: string, id: string) {
    this.page(pageId);
    const r = this.db.prepare("SELECT * FROM learning_quiz_runs WHERE id=? AND page_id=?").get(id, pageId) as Run | undefined;
    if (!r) throw new LearningError(404, "quiz_not_found");
    if (r.status === "deleted") throw new LearningError(410, "quiz_deleted");
    return r;
  }
  private originalHash(pageId: string, materialId: string) {
    const r = this.db.prepare("SELECT original FROM learning_materials WHERE id=? AND page_id=? AND deleted_at IS NULL").get(materialId, pageId) as { original: Buffer } | undefined;
    if (!r?.original) throw new LearningError(410, "material_deleted"); return frameworkHash(r.original);
  }
  private extra(pageId: string, ref: { id: string; kind: "note" | "supplement"; nodeId: string; chapterId: string }): Extra {
    const chapter = new LearningFrameworkRepository(this.learning).view(pageId).chapters.find(c => c.id === ref.chapterId);
    const node = chapter?.nodes.find(n => n.id === ref.nodeId);
    const text = ref.kind === "note" ? node?.note : node?.supplement;
    if (!node || !text || ref.id !== `${node.id}:${ref.kind}`) throw new LearningError(409, "source_changed");
    return { ...ref, text };
  }
  private snapshot(pageId: string, settings: QuizConfig) {
    this.page(pageId);
    const framework = new LearningFrameworkRepository(this.learning), view = framework.view(pageId);
    const selected = new Map<string, Set<number> | null>();
    for (const id of settings.materialIds) selected.set(id, null);
    for (const id of settings.chapterIds) if (!view.chapters.some(c => c.id === id)) throw new LearningError(404, "framework_not_found");
    for (const id of settings.nodeIds) if (!view.chapters.some(c => c.nodes.some(n => n.id === id))) throw new LearningError(404, "framework_not_found");
    const chosenNodes = view.chapters.flatMap(c => c.nodes.filter(n => settings.chapterIds.includes(c.id) || settings.nodeIds.includes(n.id)).map(n => ({ c, n })));
    for (const { c, n } of chosenNodes) for (let i = 0; i < n.sources.length; i++) {
      const ref = n.sources[i]; framework.source(pageId, c.id, n.id, i);
      const current = this.learning.source(pageId,ref.materialId).paragraphs.find(p=>p.number===ref.paragraph);
      if(!current || JSON.stringify(current.parsed)!==JSON.stringify(ref.parsed))throw new LearningError(409,"source_changed"); // Validate original bindings, never substitute a changed source.
      if (!selected.has(ref.materialId)) selected.set(ref.materialId, new Set());
      selected.get(ref.materialId)?.add(ref.paragraph);
    }
    const extras: Extra[] = [];
    for (const c of view.chapters) for (const n of c.nodes) {
      if (!chosenNodes.some(x => x.n.id === n.id) && !n.sources.some(s => settings.materialIds.includes(s.materialId))) continue;
      if (settings.includeNotes && n.note) extras.push({ id: `${n.id}:note`, kind: "note", chapterId: c.id, nodeId: n.id, text: n.note });
      if (settings.includeSupplements && n.supplement) extras.push({ id: `${n.id}:supplement`, kind: "supplement", chapterId: c.id, nodeId: n.id, text: n.supplement });
    }
    const bindings: Binding["materials"] = [];
    const documents = new Map<string, ReturnType<LearningRepository["getParsedDocument"]>>();
    const sourceContext = (p: import("@/lib/domain/learning").LearningParagraph) => {
      if (!p.parsed) return {};
      const document = documents.get(p.parsed.documentId) ?? this.learning.getParsedDocument(pageId, p.parsed.documentId);
      documents.set(document.id, document);
      const page = document.pages?.find(page => page.physical_page === p.parsed!.physicalPage);
      const block = page?.blocks.find(block => block.id === p.parsed!.blockId);
      if (!page?.render || !block) throw new LearningError(409, "source_changed");
      return { sourceContext: { kind: "pdf", physicalPage: page.physical_page, role: block.role, type: block.type,
        renderSize: [page.render.width_px, page.render.height_px], regions: block.source_regions.map(r => ({ bbox: r.bbox, unit: r.unit, origin: r.origin })),
        note: "Parser layout only; not a verified heading hierarchy or semantic relationship" } };
    };
    const materials = [...selected.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, numbers]) => {
      const source = this.learning.source(pageId, id); // Reject unparsed PDFs/untranscribed audio as a whole, not silent omission.
      const paragraphs = source.paragraphs.filter(p => numbers === null || numbers.has(p.number));
      if (!paragraphs.length) throw new LearningError(409, "source_changed");
      bindings.push({ materialId: id, originalSha256: this.originalHash(pageId, id), paragraphs: paragraphs.map(p => ({ number: p.number, hash: frameworkHash(p.text), start: p.start, end: p.end,
        ...(p.parsed ? { parsed: p.parsed } : {}),
        ...(p.startSeconds === undefined ? {} : { startSeconds: p.startSeconds, endSeconds: p.endSeconds }) })) });
      return { materialId: id, title: source.material.title, kind: source.material.kind, ...(source.scopeNotice ? { scopeNotice: source.scopeNotice } : {}), paragraphs: paragraphs.map(p => ({ number: p.number, text: p.text, ...sourceContext(p),
        referenceId: quizReferenceId({ materialId: id, originalSha256: bindings.at(-1)!.originalSha256, paragraph: bindings.at(-1)!.paragraphs.find(b => b.number === p.number) }) })) };
    });
    const binding: Binding = { materials: bindings, extras: extras.map(({ text, ...e }) => ({ ...e, sha256: frameworkHash(text) })) };
    // No framework body, overview or chat history enters the quiz input.
    return { binding, input: { materials, extras: extras.map(e => ({ ...e, referenceId: quizReferenceId({ ...e, sha256: frameworkHash(e.text) }) })), count: settings.count, difficulty: settings.difficulty } };
  }
  list(pageId: string): QuizRunSummary[] {
    this.page(pageId);
    return (this.db.prepare("SELECT * FROM learning_quiz_runs WHERE page_id=? AND status<>'deleted' ORDER BY rowid DESC").all(pageId) as Array<Run & { status: QuizRunSummary["status"] }>).map(r => {
      const result = r.result_json ? parse<SavedQuiz>(r.result_json) : null;
      const attempt = this.db.prepare("SELECT id FROM learning_quiz_attempts WHERE quiz_id=?").get(r.id) as { id: string } | undefined;
      const progress=generationProgress(this.learning,pageId,"quiz",r.id);
      let failure = r.failure;
      // Older pre-reading failures used the final-question error codes. Derive
      // their display from the failed stage without rewriting stored diagnostics.
      if (r.status === "failed" && ["quiz_invalid_result", "quiz_grounding_invalid"].includes(failure ?? "")) {
        const reading = this.db.prepare("SELECT failure,diagnostics_json FROM learning_generation_parts WHERE page_id=? AND kind='quiz' AND run_id=? AND part_id LIKE 'reading-%' AND state='failed'")
          .all(pageId, r.id) as Array<{ failure: string | null; diagnostics_json: string | null }>;
        if (reading.length) {
          const invalidSource = reading.some(part => {
            if (part.failure === "quiz_grounding_invalid") return true;
            try {
              const issues = learningValidationDiagnostics(JSON.parse(part.diagnostics_json ?? "null")).validationIssues;
              return Array.isArray(issues) && issues.some(issue => /^items\[\d+\]\.references(?:\[\d+\])?$/.test(issue.path));
            } catch { return false; }
          });
          failure = invalidSource ? "quiz_reading_invalid_source" : "quiz_reading_restart_required";
          if (progress) progress.canResume = false;
        }
      }
      if (r.status === "failed" && failure === "quiz_reading_restart_required" && progress) progress.canResume = false;
      return { id: r.id, createdAt: r.created_at, status: r.status, failure, settings: parse<QuizConfig>(r.settings_json), title: result?.title ?? null,
        count: result?.questions.length ?? 0, reason: result?.reason ?? null, attemptId: attempt?.id ?? null,
        ...(progress ? {progress} : {}) };
    });
  }
  /** Remove the group and all attempts/checkpoints atomically. The cleared run
   * retains only its identity so a delayed generation receipt cannot recreate it. */
  delete(pageId: string, id: string): void {
    this.db.transaction(() => {
      this.page(pageId);
      const row = this.db.prepare("SELECT status FROM learning_quiz_runs WHERE id=? AND page_id=?").get(id, pageId) as { status: Run["status"] } | undefined;
      if (!row) throw new LearningError(404, "quiz_not_found");
      if (row.status === "deleted") return;
      this.db.prepare("DELETE FROM learning_quiz_attempts WHERE quiz_id=? AND page_id=?").run(id, pageId);
      this.db.prepare("DELETE FROM learning_generation_parts WHERE kind='quiz' AND run_id=? AND page_id=?").run(id, pageId);
      this.db.prepare("UPDATE learning_quiz_runs SET status='deleted',settings_json='{}',binding_json='{}',binding_hash='',result_json=NULL,diagnostics_json=NULL,failure=NULL,deadline=0 WHERE id=? AND page_id=?")
        .run(id, pageId);
    }).immediate();
  }
  begin(pageId: string, input: unknown, limit: number, deadlineMs = FRAMEWORK_DEADLINE_MS) {
    if (!Number.isInteger(deadlineMs) || deadlineMs < 31_000 || deadlineMs > 630_000) throw new LearningError(503, "learning_generation_not_configured");
    const v = StartQuiz.parse(input);
    return this.db.transaction(() => {
      this.page(pageId);
      const old = this.db.prepare("SELECT * FROM learning_quiz_runs WHERE id=?").get(v.id) as Run | undefined;
      if (old) {
        if (old.page_id !== pageId) throw new LearningError(409, "submission_conflict");
        if (old.status === "deleted") throw new LearningError(410, "quiz_deleted");
        if (old.settings_json !== JSON.stringify(v.settings)) throw new LearningError(409, "submission_conflict");
        if (!(v.resume && old.status === "failed" && generationProgress(this.learning,pageId,"quiz",v.id)?.canResume)) return null;
      }
      if (this.db.prepare("SELECT id FROM learning_quiz_runs WHERE page_id=? AND status='generating'").get(pageId)) throw new LearningError(409, "quiz_busy");
      const snapshot = this.snapshot(pageId, v.settings);
      if (old) {
        if(hash(snapshot.binding)!==old.binding_hash)throw new LearningError(409,"source_changed");
        this.db.prepare("UPDATE learning_quiz_runs SET status='generating',failure=NULL,deadline=? WHERE id=? AND page_id=?").run(Date.now()+deadlineMs,v.id,pageId);
        return snapshot.input;
      }
      this.db.prepare("INSERT INTO learning_quiz_runs(id,page_id,settings_json,binding_json,binding_hash,status,created_at,deadline) VALUES(?,?,?,?,?,'generating',?,?)")
        .run(v.id, pageId, JSON.stringify(v.settings), JSON.stringify(snapshot.binding), hash(snapshot.binding), new Date().toISOString(), Date.now() + deadlineMs);
      return snapshot.input;
    }).immediate();
  }
  assertSources(pageId:string,id:string) {
    const row=this.run(pageId,id);
    if(hash(this.snapshot(pageId,parse<QuizConfig>(row.settings_json)).binding)!==row.binding_hash)throw new LearningError(409,"source_changed");
  }
  complete(pageId: string, id: string, value: unknown) {
    if (Buffer.byteLength(JSON.stringify(value)) > FRAMEWORK_MAX_RESULT_BYTES) throw new LearningError(422, "quiz_invalid_result");
    this.db.transaction(() => {
      const r = this.run(pageId, id); if (r.status !== "generating") throw new LearningError(409, "framework_terminal");
      const settings = parse<QuizConfig>(r.settings_json), current = this.snapshot(pageId, settings);
      if (hash(current.binding) !== r.binding_hash) throw new LearningError(409, "source_changed");
      const referenced = typeof value === "object" && value !== null && "contractVersion" in value;
      const parsed = referenced ? resolveReferencedQuiz(ReferencedQuizEnvelope.parse(value), [
        ...current.input.materials.flatMap(m => m.paragraphs.map(p => ({ referenceId: p.referenceId, text: p.text, source: { kind: "material" as const, materialId: m.materialId, paragraph: p.number } }))),
        ...current.input.extras.map(e => ({ referenceId: e.referenceId, text: e.text, source: { kind: e.kind, id: e.id } }))
      ]) : GeneratedQuiz.parse(value);
      const quiz = { title: parsed.title, reason: parsed.reason, questions: parsed.items };
      if (quiz.questions.length > settings.count || (quiz.questions.length < settings.count && !quiz.reason)
        || new Set(quiz.questions.map(q => q.stem.replace(/\s/g, "").toLowerCase())).size !== quiz.questions.length) throw new LearningError(422, "quiz_invalid_result");
      quiz.reason = [quiz.reason, quizCoverageNotice(current.input.materials, parsed.items)].filter(Boolean).join("\n") || null;
      for(const q of quiz.questions)if(q.evidence){
        for(const e of q.evidence){
          if(!q.sources.some(s=>JSON.stringify(s)===JSON.stringify(e.source)))throw new LearningError(422,"quiz_grounding_invalid");
          const source=e.source;
          const text=source.kind==="material"?current.input.materials.find(m=>m.materialId===source.materialId)?.paragraphs.find(p=>p.number===source.paragraph)?.text:current.input.extras.find(x=>x.id===source.id&&x.kind===source.kind)?.text;
          if(!text?.includes(e.quote))throw new LearningError(422,"quiz_grounding_invalid");
        }
        if(!referenced && q.options.some(o=>!o.evidenceIndexes?.length||o.evidenceIndexes.some(i=>!q.evidence![i])))throw new LearningError(422,"quiz_grounding_invalid");
        // Only new grounded groups use this non-answer-bearing procedural hint.
        if(q.hint)q.hint=quizProceduralHint(q.kind);
      }
      const saved: SavedQuiz = { ...quiz, ...(referenced ? { optionOrderVersion: 1 as const } : {}), questions: quiz.questions.map(q => ({ ...q, sources: q.sources.map(ref => {
        if (ref.kind !== "material") {
          const extra = current.binding.extras.find(e => e.kind === ref.kind && "id" in e && e.id === ref.id);
          if (!extra) throw new LearningError(422, "framework_invalid_source"); return extra;
        }
        const material = current.binding.materials.find(m => m.materialId === ref.materialId);
        if (!material?.paragraphs.some(p => p.number === ref.paragraph)) throw new LearningError(422, "framework_invalid_source");
        const p = this.learning.source(pageId, ref.materialId).paragraphs.find(p => p.number === ref.paragraph)!;
        return { ...ref, start: p.start, end: p.end, originalSha256: material.originalSha256, paragraphSha256: frameworkHash(p.text),
          ...(p.parsed ? { parsed: p.parsed } : {}),
        ...(p.startSeconds === undefined ? {} : { startSeconds: p.startSeconds, endSeconds: p.endSeconds }) };
      }) })) };
      const resultJson = JSON.stringify(saved);
      if (Buffer.byteLength(resultJson) > FRAMEWORK_MAX_RESULT_BYTES) throw new LearningError(422, "quiz_invalid_result");
      this.db.prepare("UPDATE learning_quiz_runs SET status=?,result_json=? WHERE id=?").run(saved.questions.length ? "completed" : "insufficient", resultJson, id);
    }).immediate();
  }
  fail(pageId: string, id: string, code: string) {
    this.learning.get(pageId);
    this.db.prepare("UPDATE learning_quiz_runs SET status='failed',failure=? WHERE id=? AND page_id=? AND status='generating'").run(code, id, pageId);
  }
  /** Freeze only transport scheduling, not content. A larger runtime allowance
   * must not rebind already saved question/reading checkpoints on explicit resume. */
  planning(pageId:string,id:string,config:{maxInputChars:number;maxOutputTokens:number}) {
    this.page(pageId);
    return this.db.transaction(()=>{
      const row=this.db.prepare("SELECT diagnostics_json FROM learning_quiz_runs WHERE id=? AND page_id=? AND status='generating'").get(id,pageId) as {diagnostics_json:string|null}|undefined;
      if(!row)throw new LearningError(409,"framework_terminal");
      const d=JSON.parse(row.diagnostics_json??"{}");
      if(d.quizPlanning)return d.quizPlanning as {inputChars:number;perGroup:number;legacy:boolean;legacyLarge?:boolean};
      const existing=this.db.prepare("SELECT part_id FROM learning_generation_parts WHERE page_id=? AND kind='quiz' AND run_id=?").all(pageId,id) as {part_id:string}[];
      const legacy=existing.length>0;
      const inputChars=legacy&&Number.isInteger(d.maxInputChars)?d.maxInputChars:config.maxInputChars;
      const output=legacy&&Number.isInteger(d.maxOutputTokens)?d.maxOutputTokens:config.maxOutputTokens;
      const plan={inputChars,perGroup:Math.max(1,Math.min(12,Math.floor(output/900))),legacy,
        ...(legacy?{legacyLarge:existing.some(p=>p.part_id.startsWith("reading-"))}:{})};
      this.db.prepare("UPDATE learning_quiz_runs SET diagnostics_json=json_patch(coalesce(diagnostics_json,'{}'),?) WHERE id=? AND page_id=? AND status='generating'")
        .run(JSON.stringify({quizPlanning:plan}),id,pageId);
      return plan;
    }).immediate();
  }
  diagnostics(pageId: string, id: string, value: object) {
    this.learning.get(pageId);
    const safe = { ...Object.fromEntries(Object.entries(value).filter(([k, v]) => ["model", "maxInputChars", "maxOutputTokens", "requestTimeoutMs", "inputTokens", "outputTokens", "reasoningTokens", "reasoningEffort", "totalTokens", "totalDurationMs", "responseStatus", "parseResult", "validationResult"].includes(k) && (typeof v === "string" || typeof v === "number"))),
      ...learningValidationDiagnostics(value) };
    this.db.prepare("UPDATE learning_quiz_runs SET diagnostics_json=json_patch(coalesce(diagnostics_json,'{}'),?) WHERE id=? AND page_id=? AND status='generating'").run(JSON.stringify(safe), id, pageId);
  }
  startAttempt(pageId: string, input: unknown) {
    const v = BeginQuizAttempt.parse(input);
    return this.db.transaction(() => {
      const r = this.run(pageId, v.quizId);
      const old = this.db.prepare("SELECT * FROM learning_quiz_attempts WHERE id=? OR quiz_id=?").get(v.id, v.quizId) as Attempt | undefined;
      if (old) { if (old.page_id !== pageId || old.id !== v.id || old.quiz_id !== v.quizId || old.mode !== v.mode) throw new LearningError(409, "submission_conflict"); return this.attempt(pageId, old.id); }
      if (r.status !== "completed") throw new LearningError(409, "quiz_not_ready");
      const quiz = parse<SavedQuiz>(r.result_json!);
      this.db.prepare("INSERT INTO learning_quiz_attempts(id,page_id,quiz_id,mode,progress_json,events_json,evaluation_json,created_at) VALUES(?,?,?,?,?,'[]',?,?)")
        .run(v.id, pageId, v.quizId, v.mode, JSON.stringify(quiz.questions.map(blank)), JSON.stringify({ correct: quiz.questions.map(() => null), score: null }), new Date().toISOString());
      return this.attempt(pageId, v.id);
    }).immediate();
  }
  private attemptRow(pageId: string, id: string) {
    this.page(pageId);
    const a = this.db.prepare("SELECT * FROM learning_quiz_attempts WHERE id=? AND page_id=?").get(id, pageId) as Attempt | undefined;
    if (!a) throw new LearningError(404, "quiz_not_found"); return a;
  }
  private source(pageId: string, ref: QuizSource) {
    if (ref.kind !== "material") {
      const e = this.extra(pageId, ref);
      if (frameworkHash(e.text) !== ref.sha256) throw new LearningError(409, "source_changed");
      return { kind: e.kind, text: e.text };
    }
    const source = this.learning.source(pageId, ref.materialId, ref.parsed), p = source.paragraphs.find(p => p.number === ref.paragraph);
    if (!p || p.start !== ref.start || p.end !== ref.end || frameworkHash(p.text) !== ref.paragraphSha256 || this.originalHash(pageId, ref.materialId) !== ref.originalSha256
      || p.startSeconds !== ref.startSeconds || p.endSeconds !== ref.endSeconds || JSON.stringify(p.parsed) !== JSON.stringify(ref.parsed)) throw new LearningError(409, "source_changed");
    return { kind: "material" as const, materialId: ref.materialId, title: source.material.title, paragraph: p };
  }
  attempt(pageId: string, id: string): QuizAttemptView {
    const a = this.attemptRow(pageId, id), quiz = parse<SavedQuiz>(this.run(pageId, a.quiz_id).result_json!);
    const progress = parse<QuizProgress[]>(a.progress_json), completed = Boolean(a.completed_at);
    const evaluation = parse<Evaluation>(a.evaluation_json);
    return { id: a.id, quizId: a.quiz_id, title: quiz.title, mode: a.mode, revision: a.revision, completed, createdAt: a.created_at, completedAt: a.completed_at,
      questions: quiz.questions.map((q, index) => {
        const p = progress[index], reveal = completed || (a.mode === "practice" && terminal(p));
        return { index, stem: q.stem, kind: q.kind, options: q.options.map(({ id, text }, i) => ({ id, text,
          ...(quiz.optionOrderVersion === 1 ? { label: String.fromCharCode(65 + i) } : {}) })), progress: p,
          ...(p.hinted ? { hint: q.hint } : {}), ...(reveal ? { feedback: { correct: evaluation.correct[index] === true, correctOptionId: q.correctOptionId,
            explanation: q.explanation, reasons: q.options.map(({ id, reason }) => ({ id, reason })), sources: q.sources.map(s => {
              let state = "available"; try { this.source(pageId, s); } catch (e) { state = e instanceof LearningError ? e.code : "source_changed"; }
              return { ...s, state };
            }) } } : {}) };
      }), score: completed ? evaluation.score : null };
  }
  act(pageId: string, input: unknown) {
    const v = QuizAction.parse(input);
    return this.db.transaction(() => {
      const a = this.attemptRow(pageId, v.attemptId), events = parse<Array<{ id: string; hash: string; action: string; question: number; optionId: string | null; at: string }>>(a.events_json);
      const old = events.find(e => e.id === v.id);
      if (old) { if (old.hash !== hash(v)) throw new LearningError(409, "submission_conflict"); return this.attempt(pageId, a.id); }
      if (a.revision !== v.revision) throw new LearningError(409, "quiz_edit_conflict");
      if (a.completed_at) throw new LearningError(409, "quiz_attempt_complete");
      const quiz = parse<SavedQuiz>(this.run(pageId, a.quiz_id).result_json!), progress = parse<QuizProgress[]>(a.progress_json);
      const p = progress[v.question], q = quiz.questions[v.question];
      if (!p || !q) throw new LearningError(400, "invalid_input");
      if (v.action !== "finish") {
        if (terminal(p)) throw new LearningError(409, "quiz_question_complete");
        if (v.action === "choose") { if (!q.options.some(o => o.id === v.optionId)) throw new LearningError(400, "invalid_input"); p.optionId = v.optionId; }
        if (v.action === "submit") { if (!p.optionId) throw new LearningError(400, "quiz_choose_first"); p.submitted = true; }
        if (v.action === "hint") p.hinted = true;
        if (v.action === "skip") p.skipped = true;
        if (v.action === "reveal") { if (a.mode !== "practice") throw new LearningError(409, "quiz_answers_hidden"); p.revealed = true; }
      } else for (const item of progress) { if (!terminal(item)) { if (item.optionId) item.submitted = true; else item.skipped = true; } }
      const complete = v.action === "finish" || progress.every(terminal);
      const evaluation = parse<Evaluation>(a.evaluation_json);
      for (let i = 0; i < progress.length; i++) if (evaluation.correct[i] === null && terminal(progress[i])) {
        const p = progress[i]; evaluation.correct[i] = p.submitted && !p.revealed && p.optionId === quiz.questions[i].correctOptionId;
      }
      if (complete) evaluation.score = { correct: evaluation.correct.filter(Boolean).length, total: progress.length,
        unassistedCorrect: progress.filter((p, i) => evaluation.correct[i] && !p.hinted).length, hinted: progress.filter(p => p.hinted).length,
        revealed: progress.filter(p => p.revealed).length, skipped: progress.filter(p => p.skipped).length };
      events.push({ id: v.id, hash: hash(v), action: v.action, question: v.question, optionId: v.optionId, at: new Date().toISOString() });
      this.db.prepare("UPDATE learning_quiz_attempts SET progress_json=?,events_json=?,evaluation_json=?,revision=revision+1,completed_at=? WHERE id=? AND revision=?")
        .run(JSON.stringify(progress), JSON.stringify(events), JSON.stringify(evaluation), complete ? new Date().toISOString() : null, a.id, v.revision);
      return this.attempt(pageId, a.id);
    }).immediate();
  }
  readSource(pageId: string, attemptId: string, question: number, index: number) {
    const view = this.attempt(pageId, attemptId), ref = view.questions[question]?.feedback?.sources[index];
    if (!ref) throw new LearningError(403, "quiz_answers_hidden");
    return this.source(pageId, ref);
  }
}
