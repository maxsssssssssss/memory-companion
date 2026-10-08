import { createHash, randomUUID } from "node:crypto";
import type { LearningPreparationMaterial, LearningPreparationRun } from "@/lib/domain/learning-preparation";
import { ResumeLearningPreparation } from "@/lib/domain/learning-preparation";
import type { PdfStudySelection } from "@/lib/domain/learning-pdf-study";
import { LearningError, LearningRepository } from "./repository";
import { prepareLearningUpload, resumeLearningPdfPreparation } from "./upload-preparation";
import { inspectLearningPdfReadiness } from "./pdf-readiness";
import { organizeLearningText } from "./framework-service";
import { updateLearningOverview } from "./study-service";
import { generationProgress } from "./generation-parts";
import { LearningFrameworkRepository } from "./framework-repository";
import { LearningStudyRepository } from "./study-repository";

type Binding = { materialId: string; fingerprint: string; initialScope: string | null; documentId: string | null; included?: boolean };
type Row = { id: string; page_id: string; binding_json: string; run_json: string; allow_partial: number; lease_token: string | null; lease_until: number };
const LEASE_MS = 90_000;
const active = (status: LearningPreparationRun["status"]) => status === "preparing" || status === "generating";
const defaults = { prepare: prepareLearningUpload, inspect: inspectLearningPdfReadiness, framework: organizeLearningText, overview: updateLearningOverview, resumePdf: resumeLearningPdfPreparation };
type Dependencies = Omit<typeof defaults,"resumePdf"> & Partial<Pick<typeof defaults,"resumePdf">>;
const safeError = (error: unknown) => error instanceof LearningError ? error.code : "learning_preparation_failed";
function bindings(repo: LearningRepository, pageId: string, ids: string[]): Binding[] {
  const page = repo.get(pageId);
  return [...ids].sort().map(materialId => {
    const material = page.materials.find(m => m.id === materialId);
    if (!material) throw new LearningError(404, "material_not_found");
    const row = repo.database.prepare("SELECT fingerprint FROM learning_materials WHERE id=? AND page_id=? AND deleted_at IS NULL").get(materialId, pageId) as { fingerprint: string };
    const scope = repo.database.prepare("SELECT selection_json FROM learning_pdf_scopes WHERE material_id=? AND page_id=?").get(materialId, pageId) as { selection_json: string } | undefined;
    return { materialId, fingerprint: row.fingerprint, initialScope: scope?.selection_json ?? null,
      documentId: material.pdf ? repo.listParsedDocuments(pageId,materialId).at(-1)?.id ?? null : null };
  });
}
function idFor(repo: LearningRepository, pageId: string, bound: Binding[], intent: LearningPreparationRun["intent"]) {
  const h = createHash("sha256").update(JSON.stringify(["learning-organize-v1", repo.accountId, pageId, intent, bound.map(({materialId,fingerprint}) => ({materialId,fingerprint}))])).digest("hex");
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
function rowFor(repo: LearningRepository, pageId: string, id: string): Row {
  repo.get(pageId);
  const row = repo.database.prepare("SELECT * FROM learning_preparation_runs WHERE page_id=? AND id=?").get(pageId, id) as Row | undefined;
  if (!row) throw new LearningError(404, "preparation_not_found");
  return row;
}
function assertBindings(repo: LearningRepository, row: Row) {
  const expected = JSON.parse(row.binding_json) as Binding[];
  const current = bindings(repo, row.page_id, expected.map(b => b.materialId));
  if (expected.some((b,i) => b.fingerprint !== current[i].fingerprint || b.documentId !== current[i].documentId)) throw new LearningError(409, "source_changed");
}
function assertPublishable(repo:LearningRepository,row:Row,token:string) {
  assertBindings(repo,row);
  const claim = rowFor(repo,row.page_id,row.id);
  if (claim.lease_token!==token || claim.lease_until<=Date.now()) throw new LearningError(409,"preparation_interrupted");
}
function inspect(repo: LearningRepository, pageId: string, ids: string[], deps: Dependencies) {
  const page = repo.get(pageId), selections = new Map<string, PdfStudySelection>();
  const materials: LearningPreparationMaterial[] = ids.map(materialId => {
    const m = page.materials.find(m => m.id === materialId);
    if (!m) throw new LearningError(410, "material_deleted");
    const base = { materialId, title: m.title, kind: m.kind };
    if (m.pdf) {
      if (m.pdfStudy) {
        try {
          repo.source(pageId,materialId);
          return { ...base,status:"ready",completed:m.pdfStudy.physicalPages.length,total:m.pdfStudy.physicalPages.length,
            issues:[`沿用已保存的 ${m.pdfStudy.physicalPages.length} 页学习范围与排除项；解析内容仍未核实。`] };
        } catch { return { ...base,status:"blocked",completed:0,total:m.pdfStudy.physicalPages.length,issues:["已保存学习范围当前不可用，请先检查材料范围。"] }; }
      }
      const ready = deps.inspect(repo, pageId, materialId);
      if (ready.selection) selections.set(materialId, ready.selection);
      const issues = [...ready.limitations];
      return { ...base, status: ready.status, completed: ready.completedPages.length, total: ready.totalPages, issues, ...(ready.processing ? {processing:ready.processing} : {}) };
    }
    if (m.audio && m.audio.transcription !== "completed") return { ...base,
      status: m.audio.transcription === "processing" ? "waiting" : "blocked",
      completed: m.audio.completedChunks, total: Math.max(1,m.audio.totalChunks),
      issues: [m.audio.transcription === "processing" ? "录音转写尚未完成；未知结果不会自动重新提交。" : "这份录音尚无可用转写，可保留原件稍后处理。"] };
    try {
      repo.source(pageId, materialId);
      return { ...base, status: "ready", completed: m.audio?.totalChunks || 1, total: m.audio?.totalChunks || 1, issues: [] };
    } catch { return { ...base, status: "blocked", completed: 0, total: 1, issues: ["这份材料目前没有可用于整理的正文。"] }; }
  });
  return { materials, selections };
}
function summary(run: LearningPreparationRun, materials: LearningPreparationMaterial[]) {
  return { ...run, materials, completed: materials.filter(m=>m.status==="ready").length, total: materials.length };
}
function exclusionNotes(row:Row,materials:LearningPreparationMaterial[]) {
  const excluded = new Set((JSON.parse(row.binding_json) as Binding[]).filter(b=>b.included===false).map(b=>b.materialId));
  return materials.map(m=>excluded.has(m.materialId) ? {...m,issues:[...m.issues,"本次按你的选择跳过；原件保留，未纳入当前学习范围。"]} : m);
}
function publicRun(row: Row): LearningPreparationRun {
  const run = JSON.parse(row.run_json) as LearningPreparationRun;
  if (active(run.status) && row.lease_until <= Date.now()) return { ...run, status: "interrupted", error: "learning_preparation_interrupted", canResume: true };
  return run;
}
/** Read-only status: refreshing never starts or retries any Provider. */
export function listLearningPreparations(repo: LearningRepository, pageId: string): LearningPreparationRun[] {
  repo.get(pageId);
  return (repo.database.prepare("SELECT * FROM learning_preparation_runs WHERE page_id=? ORDER BY rowid").all(pageId) as Row[]).map(row => {
    let run = publicRun(row);
    if (active(run.status)) {
      try { run = summary(run, exclusionNotes(row,inspect(repo,pageId,run.materialIds,defaults).materials)); } catch { /* Preserve the durable receipt. */ }
    }
    const progress=generationProgress(repo,pageId,run.frameworkPublished?"overview":"framework",run.id);
    return {...run,...(progress?{generation:progress,canResume:!active(run.status)&&run.status!=="completed"&&progress.canResume}: {})};
  });
}
function save(repo: LearningRepository, row: Row, token: string, run: LearningPreparationRun, terminal = false, checkBindings = true) {
  if (checkBindings) assertBindings(repo,row);
  else repo.get(row.page_id);
  const result = repo.database.prepare(`UPDATE learning_preparation_runs SET run_json=?,lease_until=?,lease_token=?
    WHERE id=? AND page_id=? AND lease_token=? AND lease_until>?`).run(JSON.stringify({ ...run, updatedAt: new Date().toISOString() }),
      terminal ? 0 : Date.now()+LEASE_MS, terminal ? null : token, row.id,row.page_id,token,Date.now());
  if (!result.changes) throw new LearningError(409,"preparation_interrupted");
}
async function execute(repo: LearningRepository, row: Row, token: string, deps: Dependencies, resumePdfs=false) {
  let run = JSON.parse(row.run_json) as LearningPreparationRun;
  const heartbeat = setInterval(() => {
    try { repo.database.prepare("UPDATE learning_preparation_runs SET lease_until=? WHERE id=? AND lease_token=? AND lease_until>?").run(Date.now()+LEASE_MS,row.id,token,Date.now()); }
    catch { /* The fenced next write will reject a closed/deleted claim. */ }
  }, 15_000);
  try {
    // Keep request setup synchronous; all follow-up work owns this connection.
    await Promise.resolve();
    assertBindings(repo,row);
    // Expire the old owner before deciding whether a restart can resume saved parts.
    new LearningFrameworkRepository(repo).view(row.page_id);
    const existing = repo.database.prepare("SELECT status,failure FROM learning_framework_runs WHERE page_id=? AND id=?").get(row.page_id,row.id) as {status:string;failure:string|null}|undefined;
    if(existing?.status==="failed" && generationProgress(repo,row.page_id,"framework",row.id)?.canResume){
      const prior=new LearningFrameworkRepository(repo).existing(row.page_id,{id:row.id,materialIds:run.materialIds.filter(id=>(JSON.parse(row.binding_json) as Binding[]).find(b=>b.materialId===id)?.included!==false)});
      if(prior)await deps.framework(repo,row.page_id,{id:row.id,materialIds:prior.materialIds,resume:true},undefined,()=>assertPublishable(repo,row,token));
    }
    if (!existing) {
      if(resumePdfs&&!row.allow_partial&&deps.resumePdf) {
        for(const binding of JSON.parse(row.binding_json) as Binding[]) {
          if(binding.included===false||binding.documentId===null)continue;
          assertPublishable(repo,row,token);
          const resumed=await deps.resumePdf(repo,row.page_id,binding.materialId);
          if(!resumed)continue;
          // Only this explicit resume may replace its expected parser attempt.
          // User scope edits or another parser version remain conflicts.
          const current=bindings(repo,row.page_id,run.materialIds), prior=JSON.parse(row.binding_json) as Binding[];
          if(current.some((b,i)=>b.fingerprint!==prior[i].fingerprint||b.initialScope!==prior[i].initialScope
            ||b.documentId!==(b.materialId===binding.materialId?resumed.document.id:prior[i].documentId)))throw new LearningError(409,"source_changed");
          row.binding_json=JSON.stringify(prior.map((b,i)=>({...b,documentId:current[i].documentId})));
          if(!repo.database.prepare("UPDATE learning_preparation_runs SET binding_json=? WHERE id=? AND lease_token=? AND lease_until>?")
            .run(row.binding_json,row.id,token,Date.now()).changes)throw new LearningError(409,"preparation_interrupted");
        }
      }
      const jobs: Promise<void>[] = [];
      const materials = repo.get(row.page_id).materials;
      const accepted = new Set((JSON.parse(row.binding_json) as Binding[]).filter(b=>b.included!==false).map(b=>b.materialId));
      // Recombining saved materials into a new batch is not permission to replay
      // an earlier audio attempt (including one whose outcome is unknown).
      const unsubmitted = run.materialIds.filter(id => accepted.has(id) && (!materials.find(m=>m.id===id)?.audio
        || !repo.database.prepare("SELECT id FROM learning_audio_runs WHERE page_id=? AND EXISTS (SELECT 1 FROM json_each(scope_json) WHERE value=?)").get(row.page_id,id)));
      const preparation = deps.prepare(repo,row.page_id,unsubmitted,work => jobs.push(work));
      // prepareLearningUpload reserves a new PDF attempt synchronously. Bind its
      // identity before awaiting, so a later parser version cannot enter this run.
      const reserved = bindings(repo,row.page_id,run.materialIds), prior = JSON.parse(row.binding_json) as Binding[];
      if (prior.some((b,i)=>b.documentId!==null && b.documentId!==reserved[i].documentId)) throw new LearningError(409,"source_changed");
      row.binding_json = JSON.stringify(prior.map((b,i)=>({...b,documentId:reserved[i].documentId})));
      repo.database.prepare("UPDATE learning_preparation_runs SET binding_json=? WHERE id=? AND lease_token=?").run(row.binding_json,row.id,token);
      await Promise.all(jobs);
      assertBindings(repo,row);
      const originalScopes = JSON.parse(row.binding_json) as Binding[];
      for (const binding of originalScopes) {
        const current = repo.database.prepare("SELECT selection_json FROM learning_pdf_scopes WHERE material_id=? AND page_id=?").get(binding.materialId,row.page_id) as {selection_json:string}|undefined;
        if ((current?.selection_json??null)!==binding.initialScope) throw new LearningError(409,"source_changed");
      }
      const ready = inspect(repo,row.page_id,run.materialIds,deps);
      // The preparation adapter returns application error codes, never a raw
      // Provider body. Keep missing configuration and busy reasons per material.
      const issues = new Map(preparation.filter(p=>p.status==="unavailable" && p.error).map(p=>[p.materialId,p.error!]));
      run = summary(run,exclusionNotes(row,ready.materials.map(m=>issues.has(m.materialId)
        ? {...m,issues:[...m.issues,issues.get(m.materialId)!]} : m)));
      const usable = ready.materials.filter(m => accepted.has(m.materialId) && (m.status === "ready" || m.status === "partial")).map(m => m.materialId);
      const incomplete = ready.materials.some(m => m.status !== "ready");
      if (!usable.length || (incomplete && !row.allow_partial)) {
        run = { ...run, status: "needs_attention", canContinue: usable.length>0, canResume: true,
          error: "learning_materials_need_attention" };
        save(repo,row,token,run,true); return;
      }
      // A scope changed by the user while parsing is never silently overwritten.
      const bound = JSON.parse(row.binding_json) as Binding[];
      for (const id of usable) {
        const selection = ready.selections.get(id);
        if (!selection) continue;
        const current = repo.database.prepare("SELECT selection_json FROM learning_pdf_scopes WHERE material_id=? AND page_id=?").get(id,row.page_id) as {selection_json:string}|undefined;
        if ((current?.selection_json ?? null) !== bound.find(b => b.materialId===id)!.initialScope
          && current?.selection_json !== JSON.stringify(selection)) throw new LearningError(409,"source_changed");
        repo.selectPdfStudy(row.page_id,id,selection,repo.get(row.page_id).revision);
      }
      row.binding_json = JSON.stringify(bindings(repo,row.page_id,run.materialIds).map(b=>({...b,included:accepted.has(b.materialId)})));
      repo.database.prepare("UPDATE learning_preparation_runs SET binding_json=? WHERE id=? AND lease_token=?").run(row.binding_json,row.id,token);
      if (run.intent === "prepare") {
        save(repo,row,token,{...run,status:"completed",error:null,canContinue:false,canResume:false},true); return;
      }
      run = { ...run,status:"generating",frameworkRunId:row.id,error:null,canContinue:false,canResume:false };
      save(repo,row,token,run);
      // Match the manual framework path's overview exclusion without changing it.
      if (repo.database.prepare("SELECT id FROM learning_overview_runs WHERE page_id=? AND status='generating' AND deadline>?").get(row.page_id,Date.now())) throw new LearningError(409,"overview_busy");
      await deps.framework(repo,row.page_id,{id:row.id,materialIds:usable},undefined,()=>assertPublishable(repo,row,token));
    }
    assertBindings(repo,row);
    const framework = repo.database.prepare("SELECT status,failure FROM learning_framework_runs WHERE page_id=? AND id=?").get(row.page_id,row.id) as {status:string;failure:string|null}|undefined;
    if (framework?.status !== "completed") {
      run = { ...run,status: framework?.status === "failed" ? "failed" : "interrupted",frameworkRunId:framework ? row.id : null,
        error:framework?.failure ?? "framework_interrupted",canContinue:false,canResume:!framework };
      save(repo,row,token,run,true); return;
    }
    run = { ...run,status:"generating",frameworkRunId:row.id,frameworkPublished:true,error:null,canContinue:false,canResume:false };
    save(repo,row,token,run);
    // Existing overview receipts are never resubmitted. First batch is a no-op.
    new LearningStudyRepository(repo).overview(row.page_id);
    const oldOverview = repo.database.prepare("SELECT status,failure FROM learning_overview_runs WHERE page_id=? AND id=?").get(row.page_id,row.id) as {status:string;failure:string|null}|undefined;
    if (!oldOverview || (oldOverview.status==="failed" && generationProgress(repo,row.page_id,"overview",row.id)?.canResume)) await deps.overview(repo,row.page_id,{id:row.id,...(oldOverview?{resume:true}: {})},undefined,()=>assertPublishable(repo,row,token));
    const overview = repo.database.prepare("SELECT status,failure FROM learning_overview_runs WHERE page_id=? AND id=?").get(row.page_id,row.id) as {status:string;failure:string|null}|undefined;
    run = { ...run,status: overview && overview.status !== "completed" ? "failed" : "completed",error:overview && overview.status !== "completed" ? overview.failure ?? "framework_interrupted" : null };
    save(repo,row,token,run,true);
  } catch (error) {
    // Public errors are codes only. Deletion removes this receipt, so late work cannot restore it.
    const code = safeError(error);
    const safeResume = ["learning_generation_not_configured","framework_busy","overview_busy","pdf_parser_outcome_unknown","pdf_parser_resource_wait","pdf_parser_service_changed","pdf_parser_busy","pdf_parser_interrupted","pdf_parser_unavailable","pdf_source_transport_unavailable"].includes(code)
      && !repo.database.prepare("SELECT id FROM learning_framework_runs WHERE id=? AND page_id=?").get(row.id,row.page_id);
    try { save(repo,row,token,{ ...run,status:safeResume?"needs_attention":"failed",error:code,canContinue:false,canResume:safeResume },true,false); } catch { /* Deleted or fenced. */ }
  } finally { clearInterval(heartbeat); repo.close(); }
}
function schedule(repo: LearningRepository, pageId: string, id: string, allowPartial: boolean, keepAlive: (work: Promise<void>) => void, deps: Dependencies, resumePdfs=false) {
  const claimed = repo.database.transaction(() => {
    const row = rowFor(repo,pageId,id); let run = publicRun(row);
    const canResume=generationProgress(repo,pageId,run.frameworkPublished?"overview":"framework",run.id)?.canResume;
    if (run.status === "completed" || (run.status === "failed"&&!canResume) || (active(run.status) && row.lease_until > Date.now())) return null;
    if (allowPartial && !run.canContinue) throw new LearningError(409,"learning_materials_need_attention");
    assertBindings(repo,row);
    if (allowPartial) {
      const current = inspect(repo,pageId,run.materialIds,deps);
      const usable = new Set(current.materials.filter(m=>m.status==="ready"||m.status==="partial").map(m=>m.materialId));
      if (!usable.size) throw new LearningError(409,"learning_materials_need_attention");
      const excluded = new Set(run.materialIds.filter(id=>!usable.has(id)));
      const page=repo.get(pageId);
      // This is the explicit partial-consent action, inside its immediate claim
      // transaction. Later asynchronous completion never changes the selection.
      repo.select(pageId,{revision:page.revision,materialIds:page.materials.filter(m=>m.selected&&!excluded.has(m.id)).map(m=>m.id)});
      row.binding_json=JSON.stringify((JSON.parse(row.binding_json) as Binding[]).map(b=>({...b,included:usable.has(b.materialId)})));
      repo.database.prepare("UPDATE learning_preparation_runs SET binding_json=? WHERE id=? AND page_id=?").run(row.binding_json,id,pageId);
      run=summary(run,exclusionNotes(row,current.materials));
    }
    const token = randomUUID();
    const next = { ...run,status:"preparing" as const,error:null,canResume:false,canContinue:false };
    repo.database.prepare("UPDATE learning_preparation_runs SET lease_token=?,lease_until=?,allow_partial=?,run_json=? WHERE id=? AND page_id=?")
      .run(token,Date.now()+LEASE_MS,allowPartial || row.allow_partial ? 1 : 0,JSON.stringify(next),id,pageId);
    return { row:rowFor(repo,pageId,id),token };
  }).immediate();
  if (claimed) {
    const owned = new LearningRepository(repo.accountDataRoot,repo.accountId);
    const work = execute(owned,claimed.row,claimed.token,deps,resumePdfs);
    keepAlive(work);
  }
  return publicRun(rowFor(repo,pageId,id));
}
/** Called inside the material save transaction, before any Provider is started. */
export function recordLearningPreparation(repo: LearningRepository,pageId:string,materialIds:string[],intent:LearningPreparationRun["intent"]="organize",requestedId?:string) {
  if (!materialIds.length || new Set(materialIds).size!==materialIds.length) throw new LearningError(400,"invalid_input");
  const bound = bindings(repo,pageId,materialIds), id = requestedId ?? idFor(repo,pageId,bound,intent), now = new Date().toISOString();
  const existing = repo.database.prepare("SELECT * FROM learning_preparation_runs WHERE id=?").get(id) as Row|undefined;
  if (existing) {
    const prior = JSON.parse(existing.run_json) as LearningPreparationRun;
    if (existing.page_id!==pageId || prior.intent!==intent || JSON.stringify(prior.materialIds)!==JSON.stringify(bound.map(b=>b.materialId))) throw new LearningError(409,"submission_conflict");
    assertBindings(repo,existing); return publicRun(existing);
  }
  const initial: LearningPreparationRun = { id,pageId,materialIds:bound.map(b=>b.materialId),intent,status:"interrupted",materials:[],completed:0,total:materialIds.length,
    frameworkRunId:null,frameworkPublished:false,error:null,createdAt:now,updatedAt:now,canContinue:false,canResume:true };
  repo.database.prepare("INSERT OR IGNORE INTO learning_preparation_runs(id,page_id,binding_json,run_json) VALUES(?,?,?,?)").run(id,pageId,JSON.stringify(bound),JSON.stringify(initial));
  const saved = rowFor(repo,pageId,id), receipt=JSON.parse(saved.run_json) as LearningPreparationRun;
  if (receipt.intent!==intent || JSON.stringify(receipt.materialIds)!==JSON.stringify(initial.materialIds)) throw new LearningError(409,"submission_conflict");
  assertBindings(repo,saved); return publicRun(saved);
}
export function startLearningPreparation(repo: LearningRepository,pageId:string,materialIds:string[],keepAlive:(work:Promise<void>)=>void,deps:Dependencies=defaults,intent:LearningPreparationRun["intent"]="organize") {
  const run = recordLearningPreparation(repo,pageId,materialIds,intent);
  return schedule(repo,pageId,run.id,false,keepAlive,deps);
}
export function resumeLearningPreparation(repo: LearningRepository,pageId:string,input:unknown,keepAlive:(work:Promise<void>)=>void,deps:Dependencies=defaults) {
  const value = ResumeLearningPreparation.parse(input);
  repo.get(pageId);
  const existing = repo.database.prepare("SELECT id FROM learning_preparation_runs WHERE page_id=? AND id=?").get(pageId,value.id);
  if (!existing && value.materialIds && !value.continueWithAvailable) repo.database.transaction(()=>{
    recordLearningPreparation(repo,pageId,value.materialIds!,value.intent??"organize",value.id);
    const page=repo.get(pageId);
    repo.select(pageId,{revision:page.revision,materialIds:[...new Set([...page.materials.filter(m=>m.selected).map(m=>m.id),...value.materialIds!])]});
  }).immediate();
  const row = rowFor(repo,pageId,value.id);
  if (value.intent && value.intent!==(JSON.parse(row.run_json) as LearningPreparationRun).intent) throw new LearningError(409,"submission_conflict");
  if (value.materialIds && JSON.stringify([...value.materialIds].sort())!==JSON.stringify((JSON.parse(row.run_json) as LearningPreparationRun).materialIds)) throw new LearningError(409,"submission_conflict");
  return schedule(repo,pageId,value.id,Boolean(value.continueWithAvailable),keepAlive,deps,!value.continueWithAvailable);
}
