// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { prepareLearningUpload } from "./upload-preparation";
import { LearningError, LearningRepository } from "./repository";
import { LearningAudioRepository } from "./audio-repository";
import { transcribeLearningAudio } from "./audio-service";
import { parseLearningPdf, parseLearningPdfAutomatically } from "./pdf-parser-service";
import { syntheticLearningPdf } from "../../../../scripts/fixtures/learning-pdf.mjs";
import { syntheticLearningWav } from "../../../../scripts/fixtures/learning-audio.mjs";
let root: string, repo: LearningRepository, page: string;
let jobs: Promise<void>[];
const pdfConfig = {url: "http://127.0.0.1:1", token: "SYNTHETIC_ONLY", findings: []};
const audioConfig = {origin: "https://synthetic.invalid", secret: "SYNTHETIC_ONLY_SECRET_LONG_ENOUGH_32"};
const network = vi.fn(async () => { throw new Error("SYNTHETIC failure, no network"); });
const deps = {
  audioConfig: () => audioConfig, pdfConfig: () => pdfConfig,
  audio: ((r, p, input) => transcribeLearningAudio(r, p, input, { configure: () => audioConfig,
    prepare: async () => [{index: 0, start: 0, end: 1, bytes: Buffer.from("SYNTHETIC CHUNK")}], request: network })) as typeof transcribeLearningAudio,
  pdf: ((r,p,m,input) => parseLearningPdfAutomatically(r,p,m,{id:(input as {id:string}).id},{config:pdfConfig,fetch:network})) as typeof parseLearningPdf
};
beforeEach(() => { root=mkdtempSync(join(tmpdir(),"learning-automatic-synthetic-"));repo=new LearningRepository(root,"owner-a");page=randomUUID();repo.create({id:page,title:"SYNTHETIC"});jobs=[];network.mockClear(); });
afterEach(async () => {await Promise.all(jobs);repo.close();rmSync(root,{recursive:true,force:true});});
function pdf(count=1) {
  const id=randomUUID(),bytes=syntheticLearningPdf({pages:count});
  repo.saveMaterials(page,[{id,title:"SYNTHETIC PDF",kind:"pdf",filename:"synthetic.pdf",bytes,pdf:{sha256:createHash("sha256").update(bytes).digest("hex"),pageCount:count,originalVersion:1,parsing:"not_parsed",pages:Array.from({length:count},(_,i)=>({physicalPage:i+1,width:600,height:800,rotation:0,view:[0,0,600,800],userUnit:1}))}}]);return id;
}
function audio() {const id=randomUUID(),bytes=syntheticLearningWav();repo.saveMaterials(page,[{id,title:"SYNTHETIC AUDIO",kind:"audio",filename:"synthetic.wav",bytes,audio:{sha256:createHash("sha256").update(bytes).digest("hex"),mimeType:"audio/wav",durationSeconds:1,originalVersion:1,transcription:"not_transcribed",completedChunks:0,totalChunks:0}}]);return id;}
const run = (ids:string[],d=deps) => prepareLearningUpload(repo,page,ids,p=>jobs.push(p),d);
it("only prepares the committed batch; keeps completed/unknown work idempotent",async()=>{
  const selected=pdf(),ignored=pdf();const result=run([selected]);expect(result[0].status).toBe("started");
  expect(repo.listParsedDocuments(page,selected)[0].status).toBe("pending");expect(repo.listParsedDocuments(page,ignored)).toHaveLength(0);
  run([selected]);await Promise.all(jobs);expect(network).toHaveBeenCalledTimes(1);
  expect(run([selected])[0].status).toBe("already_started");expect(repo.listParsedDocuments(page,selected)).toHaveLength(1);
  expect(repo.pdfOriginal(page,selected).bytes!.length).toBeGreaterThan(0);
});
it("reserves the full original range for long PDFs and stops on a failed first request",async()=>{const id=pdf(31);expect(run([id])).toEqual([{materialId:id,status:"started"}]);expect(repo.listParsedDocuments(page,id)[0].requestedPages).toHaveLength(31);await Promise.all(jobs);expect(network).toHaveBeenCalledTimes(1);expect(repo.listParsedDocuments(page,id)[0].status).toBe("failed");});
it("preserves originals when configuration is missing and still reports save truthfully",()=>{
  const p=pdf(),a=audio();const d={...deps,pdfConfig:()=>{throw new LearningError(503,"pdf_parser_not_configured");},audioConfig:()=>{throw new LearningError(503,"learning_asr_not_configured");}};
  expect(run([p,a],d).every(r=>r.status==="unavailable")).toBe(true);expect(repo.get(page).materialCount).toBe(2);expect(network).not.toHaveBeenCalled();
});
it("starts audio before the response, keeps its own connection and never repeats a failed request",async()=>{
  const id=audio();run([id]);expect(repo.get(page).materials[0].audio?.transcription).toBe("processing");
  run([id]);await Promise.all(jobs);expect(network).toHaveBeenCalledTimes(1);expect(repo.get(page).materials[0].audio?.transcription).toBe("failed");
  expect(new LearningAudioRepository(repo).list(page)).toHaveLength(1);expect(run([id])[0].status).toBe("already_started");
});
it("does not resurrect a deleted queued PDF or access another account",async()=>{
  const id=pdf();run([id]);repo.deleteMaterial(page,id);await Promise.all(jobs);expect(network).not.toHaveBeenCalled();
  expect(()=>repo.pdfOriginal(page,id)).toThrow("material_deleted");expect(repo.listParsedDocuments(page,id)[0].sourceState).toBe("source_deleted");
  const other=new LearningRepository(root,"owner-b");try{expect(()=>prepareLearningUpload(other,page,[id],p=>jobs.push(p),deps)).toThrow();}finally{other.close();}
});
it("keeps the batch pending attempts readable after request repository closes",async()=>{
  const id=pdf();run([id]);repo.close();repo=new LearningRepository(root,"owner-a");await Promise.all(jobs);
  expect(repo.listParsedDocuments(page,id)[0].status).toBe("failed");expect(network).toHaveBeenCalledTimes(1);
});
it("a stale upload worker cannot clear a successor recovery lease when its parser was fenced",async()=>{
  const id=pdf();
  run([id],{...deps,pdf:async(r,p,_m,input)=>{
    const attempt=(input as {id:string}).id;r.startParsedDocument(p,attempt);
    r.database.prepare("UPDATE learning_parsed_documents SET pdf_execution_token='successor',pdf_execution_lease_until=? WHERE id=?").run(Date.now()+45000,attempt);
    throw new LearningError(409,"pdf_parser_interrupted");
  }});
  await Promise.all(jobs);
  const attempt=repo.listParsedDocuments(page,id).at(-1)!;expect(attempt.status).toBe("processing");
  expect(repo.database.prepare("SELECT pdf_execution_token FROM learning_parsed_documents WHERE id=?").get(attempt.id)).toEqual({pdf_execution_token:"successor"});
});
