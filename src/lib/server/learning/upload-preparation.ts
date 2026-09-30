import { createHash, randomUUID } from "node:crypto";
import { type LearningUploadPreparation } from "@/lib/domain/learning";
import { LearningAudioRepository } from "./audio-repository";
import { learningAsrConfig, transcribeLearningAudio } from "./audio-service";
import { parseLearningPdf, parseLearningPdfAutomatically, pdfParseProgress, pdfParserConfig } from "./pdf-parser-service";
import { LearningError, LearningRepository } from "./repository";

// Serialize automatic PDF work within this local process. Durable attempts and
// per-page claims remain the existing repository's authority, not this promise.
let pdfTail: Promise<void> = Promise.resolve();
function preparationId(account: string, page: string, ids: string[]) {
  const hex = createHash("sha256").update(JSON.stringify(["learning-upload-v1", account, page, [...ids].sort()])).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const defaults = { audioConfig: learningAsrConfig, pdfConfig: pdfParserConfig, audio: transcribeLearningAudio,
  pdf: (repo: LearningRepository, pageId: string, materialId: string, input: { id: string; physicalPages: number[] }) =>
    parseLearningPdfAutomatically(repo, pageId, materialId, { id: input.id }) };

/** Explicit Continue only. Reuse the original requested range and completed
 * pages; the parser alone decides whether an unknown request can be recovered. */
export async function resumeLearningPdfPreparation(repo:LearningRepository,pageId:string,materialId:string,
  parse:typeof parseLearningPdf=parseLearningPdf) {
  const prior=repo.listParsedDocuments(pageId,materialId).at(-1);
  if(!prior?.requestedPages?.length)return null;
  const progress=pdfParseProgress(repo,pageId,prior.id);
  if(!progress.length||(prior.status==="completed"&&progress.every(p=>p.status==="completed")))return null;
  return parse(repo,pageId,materialId,{id:randomUUID(),physicalPages:prior.requestedPages,resumeFrom:prior.id});
}

/** Called only after the complete upload transaction, for precisely that batch. */
export function prepareLearningUpload(repository: LearningRepository, pageId: string, materialIds: string[],
  keepAlive: (work: Promise<void>) => void, dependencies = defaults): LearningUploadPreparation[] {
  const page = repository.get(pageId);
  const materials = materialIds.map(id => {
    const material = page.materials.find(m => m.id === id);
    if (!material) throw new LearningError(404, "material_not_found");
    return material;
  });
  const results: LearningUploadPreparation[] = [];
  const jobs: Array<() => Promise<void>> = [];
  const audios = materials.filter(m => m.audio);
  const failure = (error: unknown, fallback: string) => error instanceof LearningError ? error.code : fallback;
  if (audios.length) {
    const ids = audios.map(m => m.id), id = preparationId(repository.accountId, pageId, ids);
    try {
      const runs = new LearningAudioRepository(repository).list(pageId);
      const existing = runs.some(r => r.id === id) || audios.every(m => m.audio!.transcription === "completed");
      if (!existing) {
        dependencies.audioConfig();
        if (runs.some(r => r.status === "processing")) throw new LearningError(409, "audio_busy");
        // The async service claims the run synchronously before its first I/O.
        // Own its connection beyond the upload request's repository lifetime.
        const owned = new LearningRepository(repository.accountDataRoot, repository.accountId);
        const work = dependencies.audio(owned, pageId, { id, materialIds: ids })
          .then(() => {}).catch(() => {}).finally(() => owned.close());
        keepAlive(work);
      }
      results.push(...ids.map(materialId => ({ materialId, status: existing ? "already_started" as const : "started" as const })));
    } catch (error) {
      results.push(...ids.map(materialId => ({ materialId, status: "unavailable" as const, error: failure(error, "audio_transcription_failed") })));
    }
  }
  for (const material of materials.filter(m => m.pdf)) {
    const id = preparationId(repository.accountId, pageId, [material.id]);
    try {
      const prior = repository.listParsedDocuments(pageId, material.id);
      if (prior.some(d => d.id === id && d.status !== "pending") || prior.some(d => d.id !== id)) {
        results.push({ materialId: material.id, status: "already_started" }); continue;
      }
      dependencies.pdfConfig();
      const physicalPages = Array.from({ length: material.pdf!.pageCount }, (_, i) => i + 1);
      repository.createParsedDocument(pageId, { id, materialId: material.id, originalSha256: material.pdf!.sha256,
        originalVersion: material.pdf!.originalVersion, requestedPages: physicalPages, parser: { name: "PaddleOCR", version: "ocr-pdf-trial-0.1" } });
      jobs.push(async () => {
        const owned = new LearningRepository(repository.accountDataRoot, repository.accountId);
        try { await dependencies.pdf(owned, pageId, material.id, { id, physicalPages }); }
        catch {
          // The parser owns any claimed attempt. A stale upload worker must not
          // clear a successor's execution lease or overwrite recoverable receipts.
          try { owned.database.transaction(()=>{
            const unclaimed=owned.database.prepare("SELECT status,pdf_execution_lease_until FROM learning_parsed_documents WHERE id=?").get(id) as {status:string;pdf_execution_lease_until:number}|undefined;
            if(unclaimed?.status==="pending"&&unclaimed.pdf_execution_lease_until===0)owned.failParsedDocument(pageId,id,"parser_error");
          }).immediate(); } catch { /* Deleted sources stay deleted. */ }
        }
        finally { owned.close(); }
      });
      results.push({ materialId: material.id, status: "started" });
    } catch (error) { results.push({ materialId: material.id, status: "unavailable", error: failure(error, "pdf_parser_not_configured") }); }
  }
  if (jobs.length) {
    pdfTail = pdfTail.catch(() => {}).then(async () => { for (const job of jobs) await job(); });
    keepAlive(pdfTail);
  }
  return results;
}
