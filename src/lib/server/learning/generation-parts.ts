import { createHash, randomUUID } from "node:crypto";
import { LearningError, type LearningRepository } from "./repository";
import { learningValidationDiagnostics, learningValidationError } from "./generation-diagnostics";

export type GenerationKind = "framework" | "quiz" | "overview";
export type GenerationProgress = { completed: number; total: number; canResume: boolean; uncertain: boolean };
type Part = { part_id: string; input_hash: string; state: string; attempts: number; token: string | null; deadline: number; result_json: string | null; failure: string | null; diagnostics_json: string | null };
const tables = { framework: "learning_framework_runs", quiz: "learning_quiz_runs", overview: "learning_overview_runs" } as const;
export const generationHash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
function partDiagnostics(value: string | null): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value ?? "null");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}
function recoverableLocalFitFailure(part: Part) {
  if (part.state !== "failed" || part.failure !== "generation_request_does_not_fit") return false;
  const diagnostics = partDiagnostics(part.diagnostics_json);
  // A missing Provider response is not proof of an unsent request. Only the
  // dedicated, local-before-transport fit error with no diagnostics qualifies.
  return part.diagnostics_json === null || (diagnostics !== null && Object.keys(diagnostics).length === 0);
}

export function generationProgress(repo: LearningRepository, pageId: string, kind: GenerationKind, runId: string): GenerationProgress | undefined {
  repo.get(pageId);
  const rows = repo.database.prepare("SELECT state,attempts,deadline,failure,diagnostics_json FROM learning_generation_parts WHERE page_id=? AND kind=? AND run_id=?").all(pageId, kind, runId) as Part[];
  if (!rows.length) return undefined;
  const uncertain = rows.some(p => p.state === "unknown" || (p.state === "running" && p.deadline <= Date.now()));
  const run=repo.database.prepare(`SELECT failure FROM ${tables[kind]} WHERE id=? AND page_id=?`).get(runId,pageId) as {failure:string|null}|undefined;
  const unfinished=rows.some(p=>p.state!=="completed");
  const saveRetry=["framework_save_failed","learning_storage_unavailable","framework_interrupted"].includes(run?.failure??"");
  return { completed: rows.filter(p => p.state === "completed").length, total: rows.length, uncertain,
    canResume: (unfinished||saveRetry) && !uncertain && !rows.some(p => p.state === "running" || (p.state === "failed" && p.attempts >= 2 && !(kind === "quiz" && recoverableLocalFitFailure(p)))) };
}

/** Checkpoints have no source text and never publish chapters or answers by themselves.
 * The parent repository still owns account/source validation and final publication. */
export class GenerationParts {
  constructor(private repo: LearningRepository, private pageId: string, private kind: GenerationKind,
    private runId: string, private materialIds: string[], private assertCurrent: () => void, private timeoutMs: number) {}
  private part(id: string) { return this.repo.database.prepare("SELECT * FROM learning_generation_parts WHERE page_id=? AND kind=? AND run_id=? AND part_id=?").get(this.pageId, this.kind, this.runId, id) as Part | undefined; }
  private assertActive() {
    this.assertCurrent();
    const run = this.repo.database.prepare(`SELECT status,deadline FROM ${tables[this.kind]} WHERE id=? AND page_id=?`).get(this.runId,this.pageId) as {status:string;deadline:number}|undefined;
    if (!run || run.status !== "generating" || run.deadline <= Date.now()) throw new LearningError(409,"framework_interrupted");
  }
  plan(parts: Array<{ id: string; input: unknown }>) {
    this.repo.database.transaction(() => {
      this.assertActive();
      for (const p of parts) {
        const old = this.part(p.id), fingerprint = generationHash(p.input);
        if (old && old.input_hash !== fingerprint) throw new LearningError(409, "source_changed");
        this.repo.database.prepare("INSERT OR IGNORE INTO learning_generation_parts(page_id,kind,run_id,part_id,input_hash,material_ids,state) VALUES(?,?,?,?,?,?,'pending')")
          .run(this.pageId, this.kind, this.runId, p.id, fingerprint, JSON.stringify(this.materialIds));
      }
    }).immediate();
  }
  async execute<T>(id: string, operation: (diagnostics: (v: object) => void) => Promise<unknown>, validate: (v: unknown) => T,
    /** Synchronous local checks only; no requests or writes before the claim. */
    preflight?: () => void): Promise<T> {
    const token = randomUUID();
    const claimed = this.repo.database.transaction(() => {
      this.assertActive();
      const row = this.part(id);
      if (!row) throw new LearningError(409, "generation_plan_changed");
      if (row.state === "completed") return { saved: JSON.parse(row.result_json!) as T };
      if (row.state === "unknown" || row.state === "running") throw new LearningError(409, "generation_result_unknown");
      const recoverLocalFit = this.kind === "quiz" && Boolean(preflight) && recoverableLocalFitFailure(row);
      if (row.attempts >= 2 && !recoverLocalFit) throw new LearningError(409, "generation_part_failed");
      preflight?.();
      // Legacy local fit failures used the request counter. Correct it only when
      // an explicitly resumed run is active and this same request now fits.
      // Keep that evidence separately, including through later diagnostics.
      const diagnostics = partDiagnostics(row.diagnostics_json);
      const history = recoverLocalFit ? { attempts: row.attempts, failure: row.failure }
        : diagnostics?.localPreflightRecovery;
      const preservedDiagnostics = history === undefined ? {} : { localPreflightRecovery: history };
      const deadline = Date.now() + this.timeoutMs + 30_000;
      this.repo.database.prepare("UPDATE learning_generation_parts SET state='running',token=?,deadline=?,attempts=?,failure=NULL,diagnostics_json=? WHERE page_id=? AND kind=? AND run_id=? AND part_id=?")
        .run(token, deadline, recoverLocalFit ? 1 : row.attempts + 1,
          recoverLocalFit ? JSON.stringify(preservedDiagnostics) : row.diagnostics_json, this.pageId, this.kind, this.runId, id);
      this.repo.database.prepare(`UPDATE ${tables[this.kind]} SET deadline=? WHERE id=? AND page_id=? AND status='generating'`).run(deadline, this.runId, this.pageId);
      return { saved: undefined, preservedDiagnostics };
    }).immediate();
    if (claimed.saved !== undefined) return claimed.saved;
    let received = false, terminalKnown=false;
    try {
      const raw = await operation(value => {
        const diagnostic=value as {responseStatus?:string};
        if(["completed","incomplete","failed","cancelled"].includes(diagnostic.responseStatus??""))terminalKnown=true;
        const safe = { ...claimed.preservedDiagnostics,
          ...Object.fromEntries(Object.entries(value).filter(([k, v]) => ["inputTokens", "outputTokens", "totalTokens", "totalDurationMs", "responseStatus", "parseResult", "validationResult"].includes(k) && ["number", "string"].includes(typeof v))),
          ...learningValidationDiagnostics(value) };
        this.repo.database.prepare("UPDATE learning_generation_parts SET diagnostics_json=? WHERE page_id=? AND kind=? AND run_id=? AND part_id=? AND token=? AND state='running'")
          .run(JSON.stringify(safe), this.pageId, this.kind, this.runId, id, token);
      });
      received = true;
      const result = validate(raw);
      this.repo.database.transaction(() => {
        this.assertActive();
        const changed = this.repo.database.prepare("UPDATE learning_generation_parts SET state='completed',result_json=?,token=NULL WHERE page_id=? AND kind=? AND run_id=? AND part_id=? AND token=? AND state='running' AND deadline>?")
          .run(JSON.stringify(result), this.pageId, this.kind, this.runId, id, token, Date.now());
        if (!changed.changes) throw new LearningError(409, "source_changed");
      }).immediate();
      return result;
    } catch (e) {
      const issues = learningValidationError(e);
      if (Object.keys(issues).length) {
        const current = this.repo.database.prepare("SELECT diagnostics_json FROM learning_generation_parts WHERE page_id=? AND kind=? AND run_id=? AND part_id=? AND token=? AND state='running'")
          .get(this.pageId, this.kind, this.runId, id, token) as { diagnostics_json: string | null } | undefined;
        if (current) this.repo.database.prepare("UPDATE learning_generation_parts SET diagnostics_json=? WHERE page_id=? AND kind=? AND run_id=? AND part_id=? AND token=? AND state='running'")
          .run(JSON.stringify({ ...(current.diagnostics_json ? JSON.parse(current.diagnostics_json) : {}), validationResult: "failed", ...issues }), this.pageId, this.kind, this.runId, id, token);
      }
      // No automatic retry. Unknown transport outcomes cannot be replayed on resume.
      const known = received || terminalKnown || (e instanceof LearningError && (e.status < 500 || e.code==="generation_request_does_not_fit"));
      this.repo.database.prepare("UPDATE learning_generation_parts SET state=?,failure=?,token=NULL WHERE page_id=? AND kind=? AND run_id=? AND part_id=? AND token=? AND state='running'")
        .run(known ? "failed" : "unknown", e instanceof LearningError ? e.code : known ? "generation_part_failed" : "generation_result_unknown", this.pageId, this.kind, this.runId, id, token);
      throw e;
    }
  }
}
