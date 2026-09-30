// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LearningRepository } from "./repository";
import { LearningFrameworkRepository } from "./framework-repository";
import { prepareLearningUpload } from "./upload-preparation";
import { inspectLearningPdfReadiness } from "./pdf-readiness";
import { organizeLearningText } from "./framework-service";
import { updateLearningOverview } from "./study-service";
import { listLearningPreparations, recordLearningPreparation, resumeLearningPreparation, startLearningPreparation } from "./preparation-service";
import { syntheticLearningPdf } from "../../../../scripts/fixtures/learning-pdf.mjs";
import { syntheticLearningWav } from "../../../../scripts/fixtures/learning-audio.mjs";
import { LearningAudioRepository } from "./audio-repository";
import { PARSED_CONTRACT_VERSION, type ParsedDocumentResult } from "@/lib/domain/learning-parsed-document";

let root:string, repo:LearningRepository, page:string, jobs:Promise<void>[];
const prepare = vi.fn<typeof prepareLearningUpload>(() => []);
const framework = vi.fn<typeof organizeLearningText>(async (r,p,input,_deps,assertCurrent) => {
  const f = new LearningFrameworkRepository(r), v = input as {id:string;materialIds:string[]};
  const started = f.begin(p,v,120_000);
  if (started.created) { assertCurrent?.(); f.validating(p,v.id); f.complete(p,v.id,{overview:"SYNTHETIC",chapters:[{title:"SYNTHETIC",explanation:"SYNTHETIC",nodes:[{title:"SYNTHETIC",explanation:"SYNTHETIC",supplement:null,sources:v.materialIds.map(materialId=>({materialId,paragraph:1}))}]}]}); }
  return f.view(p);
});
const overview = vi.fn<typeof updateLearningOverview>(async () => ({latest:null,published:null}));
const deps = {prepare,inspect:inspectLearningPdfReadiness,framework,overview};
const keep = (p:Promise<void>) => jobs.push(p);
const latest = () => listLearningPreparations(repo,page).at(-1)!;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),"learning-preparation-synthetic-"));repo=new LearningRepository(root,"account-a");page=randomUUID();repo.create({id:page,title:"SYNTHETIC"});jobs=[];vi.clearAllMocks();});
afterEach(async()=>{await Promise.all(jobs);repo.close();rmSync(root,{recursive:true,force:true});});
function text() {const id=randomUUID();repo.saveMaterials(page,[{id,title:"SYNTHETIC",kind:"text",filename:null,bytes:Buffer.from("SYNTHETIC lesson.")}]);return id;}
function pdf(pages=1) {const id=randomUUID(),bytes=syntheticLearningPdf({pages});repo.saveMaterials(page,[{id,title:"SYNTHETIC PDF",kind:"pdf",filename:"synthetic.pdf",bytes,pdf:{sha256:createHash("sha256").update(bytes).digest("hex"),pageCount:pages,originalVersion:1,parsing:"not_parsed",pages:Array.from({length:pages},(_,i)=>({physicalPage:i+1,width:600,height:800,rotation:0,view:[0,0,600,800],userUnit:1}))}}]);return id;}
function parsedPdf(materialId:string,requestedPages=[1]) {
  const sha=repo.pdfOriginal(page,materialId).material.pdf!.sha256;
  const doc=repo.createParsedDocument(page,{id:randomUUID(),materialId,originalSha256:sha,originalVersion:1,requestedPages,parser:{name:"SYNTHETIC",version:"1"}});
  const result:ParsedDocumentResult={contract_version:PARSED_CONTRACT_VERSION,document_id:doc.id,material_id:materialId,original_sha256:sha,parse_version:doc.version,
    parser_run:{run_id:doc.id,upstream_document_id:materialId,model:"SYNTHETIC",config_summary:"NO OCR"},coverage:{requested_pages:requestedPages,succeeded_pages:requestedPages,failed_pages:[]},
    pages:requestedPages.map(physical=>{const id=randomUUID();return {physical_page:physical,printed_label:null,parser_page_index:physical-1,parse_status:"succeeded",failure_code:null,
      render:{width_px:600,height_px:800,rotation:0,crop_pdf:[0,0,600,800],frame:"displayed_pdf_crop"},issues:[],reading_order:{block_ids:[id],origin:"SYNTHETIC",reviews:[]},
      blocks:[{id,type:"text",parser_type:"synthetic-text",role:"body",content:{raw:"SYNTHETIC lesson",normalized:"SYNTHETIC lesson",format:"plain",cleaning:"none"},source_member_ids:[id],
        source_regions:[{member_id:id,physical_page:physical,bbox:[0.1,0.1,0.4,0.4],unit:"normalized",origin:"top_left",frame:"displayed_pdf_crop",parser_ref:{run_id:doc.id,page_index:physical-1,block_id:id,result_ref:"SYNTHETIC"}}],
        quality:{status:"unverified",reason:"SYNTHETIC",automatic_signals:[],text_layer_signals:[],reviews:[]}}]};})};
  repo.startParsedDocument(page,doc.id);repo.completeParsedDocument(page,doc.id,result);return doc;
}

it("persists one exact batch intent and completes framework plus overview once",async()=>{
  const a=text(),ignored=text();const run=startLearningPreparation(repo,page,[a],keep,deps);
  expect(startLearningPreparation(repo,page,[a],keep,deps).id).toBe(run.id);
  await Promise.all(jobs);
  expect(latest()).toMatchObject({status:"completed",materialIds:[a],frameworkRunId:run.id,completed:1,total:1});
  expect(framework).toHaveBeenCalledTimes(1);expect(overview).toHaveBeenCalledTimes(1);
  expect(new LearningFrameworkRepository(repo).view(page).runs[0].materialIds).not.toContain(ignored);
  resumeLearningPreparation(repo,page,{id:run.id},keep,deps);await Promise.all(jobs);expect(framework).toHaveBeenCalledTimes(1);
});
it("read-only GET survives a closed request and never starts a persisted intent",()=>{
  const id=text();const run=recordLearningPreparation(repo,page,[id]);repo.close();repo=new LearningRepository(root,"account-a");
  const before=repo.database.prepare("SELECT run_json FROM learning_preparation_runs WHERE id=?").get(run.id);
  expect(latest()).toMatchObject({id:run.id,status:"interrupted",canResume:true});
  expect(repo.database.prepare("SELECT run_json FROM learning_preparation_runs WHERE id=?").get(run.id)).toEqual(before);
  expect(prepare).not.toHaveBeenCalled();expect(framework).not.toHaveBeenCalled();
});
it("pauses failed material and generates only usable batch material after explicit consent",async()=>{
  const a=text(),b=pdf();const unavailable=vi.fn<typeof prepareLearningUpload>(()=>[{materialId:b,status:"unavailable",error:"pdf_parser_not_configured"}]);
  const run=startLearningPreparation(repo,page,[a,b],keep,{...deps,prepare:unavailable});await Promise.all(jobs);
  expect(latest()).toMatchObject({status:"needs_attention",canContinue:true});expect(framework).not.toHaveBeenCalled();
  expect(latest().materials.find(m=>m.materialId===b)?.issues).toContain("pdf_parser_not_configured");
  expect(latest().materials.find(m=>m.materialId===a)?.issues).not.toContain("pdf_parser_not_configured");
  expect(unavailable).toHaveBeenCalledTimes(1);
  resumeLearningPreparation(repo,page,{id:run.id,continueWithAvailable:true},keep,deps);await Promise.all(jobs);
  expect(latest().status).toBe("completed");expect(new LearningFrameworkRepository(repo).view(page).runs[0].materialIds).toEqual([a]);
  expect(repo.get(page).materials.map(m=>m.id)).toContain(b);
});
it("does not claim an unparsed 31-page PDF was covered or generate with no usable text",async()=>{
  const id=pdf(31);startLearningPreparation(repo,page,[id],keep,deps);await Promise.all(jobs);
  expect(latest()).toMatchObject({status:"needs_attention",completed:0,total:1,canContinue:false});
  expect(latest().materials[0].total).toBe(31);
  expect(latest().materials[0].issues.join(" ")).toContain("尚未解析");expect(framework).not.toHaveBeenCalled();
});
it("prevents foreign-account status/start/resume and conflicting batch replay",async()=>{
  const a=text(),b=text(),run=recordLearningPreparation(repo,page,[a]);
  const foreign=new LearningRepository(root,"account-b");
  try {expect(()=>listLearningPreparations(foreign,page)).toThrow("page_not_found");expect(()=>startLearningPreparation(foreign,page,[a],keep,deps)).toThrow("page_not_found");expect(()=>resumeLearningPreparation(foreign,page,{id:run.id},keep,deps)).toThrow("page_not_found");}finally{foreign.close();}
  expect(()=>resumeLearningPreparation(repo,page,{id:run.id,materialIds:[b]},keep,deps)).toThrow("submission_conflict");
});
it("deletion while awaiting preparation clears its intent and prevents late framework",async()=>{
  const a=text();let release!:()=>void;const waiting=new Promise<void>(r=>release=r);
  const d={...deps,prepare:vi.fn<typeof prepareLearningUpload>((_r,_p,_i,k)=>{k(waiting);return [];})};
  startLearningPreparation(repo,page,[a],keep,d);await Promise.resolve();repo.deleteMaterial(page,a);release();await Promise.all(jobs);
  expect(listLearningPreparations(repo,page)).toEqual([]);expect(framework).not.toHaveBeenCalled();
  expect(repo.get(page).materials).toHaveLength(0);
});
it("source version/fingerprint changes during preparation fail closed",async()=>{
  const a=text();let release!:()=>void;const waiting=new Promise<void>(r=>release=r);
  startLearningPreparation(repo,page,[a],keep,{...deps,prepare:((_r,_p,_i,k)=>{k(waiting);return [];})});
  await Promise.resolve();repo.database.prepare("UPDATE learning_materials SET fingerprint='SYNTHETIC_CHANGED' WHERE id=?").run(a);release();await Promise.all(jobs);
  expect(latest()).toMatchObject({status:"failed",error:"source_changed",canResume:false});expect(framework).not.toHaveBeenCalled();
});
it("expired process lease is visibly interrupted and explicit resume continues unsubmitted work",async()=>{
  const id=text(),run=recordLearningPreparation(repo,page,[id]);const stored={...run,status:"preparing"};
  repo.database.prepare("UPDATE learning_preparation_runs SET run_json=?,lease_token='SYNTHETIC',lease_until=1 WHERE id=?").run(JSON.stringify(stored),run.id);
  expect(latest()).toMatchObject({status:"interrupted",canResume:true});
  resumeLearningPreparation(repo,page,{id:run.id},keep,deps);await Promise.all(jobs);
  expect(latest().status).toBe("completed");expect(framework).toHaveBeenCalledTimes(1);
});
it("failed framework receipts remain failed and never retry the same provider id",async()=>{
  const id=text(),run=recordLearningPreparation(repo,page,[id]),f=new LearningFrameworkRepository(repo);
  f.begin(page,{id:run.id,materialIds:[id]},120_000);f.fail(page,run.id,"framework_provider_failed");
  resumeLearningPreparation(repo,page,{id:run.id},keep,deps);await Promise.all(jobs);
  expect(latest()).toMatchObject({status:"failed",error:"framework_provider_failed",canResume:false});
  expect(framework).not.toHaveBeenCalled();expect(overview).not.toHaveBeenCalled();
});
it("unexpected provider error bodies are not exposed and old chapters remain",async()=>{
  const a=text();startLearningPreparation(repo,page,[a],keep,deps);await Promise.all(jobs);
  const old=new LearningFrameworkRepository(repo).view(page).chapters;
  const b=text();startLearningPreparation(repo,page,[b],keep,{...deps,framework:async()=>{throw new Error("SECRET PROVIDER BODY");}});await Promise.all(jobs);
  expect(latest()).toMatchObject({status:"failed",error:"learning_preparation_failed"});
  expect(JSON.stringify(latest())).not.toContain("SECRET");expect(new LearningFrameworkRepository(repo).view(page).chapters).toEqual(old);
});
it("page deletion removes the new table and never recreates it after a late response",async()=>{
  const a=text();let release!:()=>void;const waiting=new Promise<void>(r=>release=r);
  startLearningPreparation(repo,page,[a],keep,{...deps,prepare:((_r,_p,_i,k)=>{k(waiting);return [];})});
  await Promise.resolve();repo.deletePage(page);release();await Promise.all(jobs);
  expect(repo.database.prepare("SELECT count(*) AS n FROM learning_preparation_runs").get()).toEqual({n:0});
  expect(()=>repo.get(page)).toThrow("page_deleted");expect(framework).not.toHaveBeenCalled();
});
it("explicit POST may prepare saved material for direct Quiz without framework or overview",async()=>{
  const id=text(),requestId=randomUUID();
  resumeLearningPreparation(repo,page,{id:requestId,materialIds:[id],intent:"prepare"},keep,deps);await Promise.all(jobs);
  expect(latest()).toMatchObject({id:requestId,intent:"prepare",status:"completed",frameworkRunId:null,frameworkPublished:false});
  expect(framework).not.toHaveBeenCalled();expect(overview).not.toHaveBeenCalled();
  expect(repo.get(page).materials[0].selected).toBe(true);
  expect(()=>resumeLearningPreparation(repo,page,{id:requestId,materialIds:[id],intent:"organize"},keep,deps)).toThrow("submission_conflict");
});
it("prepare-only establishes automatic unverified PDF scope usable by direct Quiz",async()=>{
  const id=pdf();const doc=parsedPdf(id);
  startLearningPreparation(repo,page,[id],keep,deps,"prepare");await Promise.all(jobs);
  expect(latest()).toMatchObject({status:"completed",frameworkPublished:false});
  expect(repo.get(page).materials[0].pdfStudy).toMatchObject({documentId:doc.id,physicalPages:[1],authorization:"automatic"});
  expect(repo.source(page,id).scopeNotice?.contentVerified).toBe(false);expect(framework).not.toHaveBeenCalled();
});
it("partial PDF scope is saved only after consent and an existing manual range stays unchanged",async()=>{
  const id=pdf(2);parsedPdf(id,[1]);const run=startLearningPreparation(repo,page,[id],keep,deps,"prepare");await Promise.all(jobs);
  expect(latest()).toMatchObject({status:"needs_attention",canContinue:true});expect(repo.get(page).materials[0].pdfStudy).toBeUndefined();
  resumeLearningPreparation(repo,page,{id:run.id,continueWithAvailable:true},keep,deps);await Promise.all(jobs);
  expect(latest().status).toBe("completed");const selected=repo.get(page).materials[0].pdfStudy!;
  expect(selected).toMatchObject({physicalPages:[1],authorization:"automatic"});
  const {authorization:_auto,...manual}=selected;repo.selectPdfStudy(page,id,manual,repo.get(page).revision);
  resumeLearningPreparation(repo,page,{id:randomUUID(),materialIds:[id],intent:"prepare"},keep,deps);await Promise.all(jobs);
  expect(repo.get(page).materials[0].pdfStudy).toEqual(manual);expect(framework).not.toHaveBeenCalled();
});
it("binds the parser attempt before waiting and rejects a newer parser version",async()=>{
  const a=text(),p=pdf(),original=repo.pdfOriginal(page,p).material.pdf!;
  const make=()=>repo.createParsedDocument(page,{id:randomUUID(),materialId:p,originalSha256:original.sha256,originalVersion:1,requestedPages:[1],parser:{name:"SYNTHETIC",version:"1"}});
  const initial=make();let release!:()=>void;const waiting=new Promise<void>(r=>release=r);
  startLearningPreparation(repo,page,[a,p],keep,{...deps,prepare:((_r,_p,_i,k)=>{k(waiting);return [];})});await Promise.resolve();
  repo.failParsedDocument(page,initial.id,"parser_error");make();release();await Promise.all(jobs);
  expect(latest()).toMatchObject({status:"failed",error:"source_changed",frameworkPublished:false});expect(framework).not.toHaveBeenCalled();
});
it("a publication fence rejects a late source version change before any chapter commits",async()=>{
  const a=text();let release!:()=>void;const waiting=new Promise<void>(r=>release=r);
  const d={...deps,framework:(async(r,p,input,_config,guard)=>{
    await waiting;return framework(r,p,input,undefined,guard);
  }) as typeof organizeLearningText};
  startLearningPreparation(repo,page,[a],keep,d);await Promise.resolve();await Promise.resolve();
  repo.database.prepare("UPDATE learning_materials SET fingerprint='SYNTHETIC_NEW' WHERE id=?").run(a);release();await Promise.all(jobs);
  expect(new LearningFrameworkRepository(repo).view(page).chapters).toHaveLength(0);
  expect(latest()).toMatchObject({status:"failed",error:"source_changed",frameworkPublished:false});
});
it("a new mixed batch never replays an existing failed or unknown audio attempt",async()=>{
  const audio=randomUUID(),bytes=syntheticLearningWav();
  repo.saveMaterials(page,[{id:audio,title:"SYNTHETIC",kind:"audio",filename:"synthetic.wav",bytes,audio:{sha256:createHash("sha256").update(bytes).digest("hex"),mimeType:"audio/wav",durationSeconds:1,originalVersion:1,transcription:"not_transcribed",completedChunks:0,totalChunks:0}}]);
  const prior=new LearningAudioRepository(repo),id=randomUUID();prior.begin(page,{id,materialIds:[audio]});
  prior.savePlan(page,id,audio,[{index:0,start:0,end:1,bytes:Buffer.from("SYNTHETIC")}]);prior.claimChunk(page,id,audio,0);prior.fail(page,id,"audio_transcription_failed");
  const fresh=text();startLearningPreparation(repo,page,[audio,fresh],keep,deps);await Promise.all(jobs);
  expect(prepare.mock.calls[0][2]).toEqual([fresh]);expect(latest()).toMatchObject({status:"needs_attention",canContinue:true});
  expect(prior.chunks(page,audio)[0].state).toBe("submitted");expect(framework).not.toHaveBeenCalled();
});
it("explicit partial consent removes only excluded batch selections and never overwrites a later choice",async()=>{
  const usable=text(),blocked=pdf(),unrelated=text(),run=recordLearningPreparation(repo,page,[usable,blocked],"prepare");
  repo.select(page,{revision:repo.get(page).revision,materialIds:[usable,blocked,unrelated]});
  resumeLearningPreparation(repo,page,{id:run.id},keep,deps);await Promise.all(jobs);
  resumeLearningPreparation(repo,page,{id:run.id,continueWithAvailable:true},keep,deps);
  expect(repo.get(page).materials.filter(m=>m.selected).map(m=>m.id).sort()).toEqual([usable,unrelated].sort());
  // This represents a later user action. Background completion cannot undo it.
  repo.select(page,{revision:repo.get(page).revision,materialIds:[usable,blocked]});await Promise.all(jobs);
  expect(repo.get(page).materials.filter(m=>m.selected).map(m=>m.id).sort()).toEqual([usable,blocked].sort());
  expect(latest().materials.find(m=>m.materialId===blocked)?.issues.join(" ")).toContain("本次按你的选择跳过");
  expect(latest()).toMatchObject({status:"completed",intent:"prepare"});
});
