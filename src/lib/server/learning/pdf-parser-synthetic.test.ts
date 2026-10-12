// @vitest-environment node
// Generated protocol fixture only: never a replacement for delivered OCR evidence.
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LearningPdfMetadata } from "@/lib/domain/learning";
import { syntheticLearningPdf } from "../../../../scripts/fixtures/learning-pdf.mjs";
import { LearningRepository } from "./repository";
import { adaptPaddleServiceResponse, type PaddleServiceFinding } from "./paddle-parsed-adapter";
import { parseLearningPdf } from "./pdf-parser-service";

const bytes=syntheticLearningPdf({pages:1}), sha=createHash("sha256").update(bytes).digest("hex");
const original:LearningPdfMetadata={sha256:sha,originalVersion:1,parsing:"not_parsed",pageCount:1,
  pages:[{physicalPage:1,width:600,height:800,rotation:0,view:[0,0,600,800],userUnit:1}]};
const parser={paddleocr:"synthetic-1",paddlex:"synthetic-2",model:"SYNTHETIC_MODEL",backend:"SYNTHETIC_NATIVE",
  profile:{recognition_profile:"png_nested_formulas",options:{synthetic:true,version:1}}};
let root:string,repo:LearningRepository,page:string,material:string;
beforeEach(()=>{
  root=mkdtempSync(join(tmpdir(),"learning-ocr-synthetic-"));repo=new LearningRepository(root,"synthetic-ocr-owner");
  page=repo.create({id:randomUUID(),title:"Synthetic OCR contract"}).id;material=randomUUID();
  repo.saveMaterials(page,[{id:material,kind:"pdf",title:"Generated PDF",filename:"synthetic.pdf",bytes,pdf:original}]);
  vi.stubGlobal("fetch",vi.fn(()=>{throw Error("External OCR forbidden");}));
});
afterEach(()=>{expect(fetch).not.toHaveBeenCalled();vi.unstubAllGlobals();repo.close();rmSync(root,{recursive:true,force:true});});
function response(requestId:string){
  const text="SYNTHETIC CONTRACT TEXT (NOT OCR OUTPUT)",bbox=[40,40,300,80];
  return {service_version:"ocr-pdf-trial-0.1",request_id:requestId,status:"completed",publishable:true,
    document:{document_id:material,sha256:sha,physical_page_count:1,selected_physical_pages:[1],selected_pdf_sha256:sha},
    pages:[{physical_page:1,page_index:0,selection_index:0,render_size:{width:600,height:800},
      pdf_geometry:{physical_page:1,mediabox_pt:[0,0,600,800],cropbox_pt:[0,0,600,800],rotation_degrees:0,display_size_pt:[600,800]},
      blocks:[{block_id:0,type:"text",raw_content:text,content:text,bbox,order:0,polygon_points:null,
        sources:[{document_sha256:sha,physical_page:1,bbox}],quality:{status:"unverified",warnings:[]}}],
      coverage:{detected_regions:1,output_blocks:1,vl_requests:0,semantic_completeness:"unverified",issues:[]},
      raw_paddle:{prunedResult:{parsing_res_list:[{block_id:0,block_content:text,block_label:"text",block_bbox:bbox}]}},
      status:"completed",quality_status:"unverified"}],
    coverage:{requested_pages:1,completed_pages:1,partial:false,failures:[],semantic_completeness:"unverified"},parser,authorization:"SYNTHETIC_ONLY"};
}
function finding():PaddleServiceFinding{
  const {model,...parserScope}=structuredClone(parser);
  return {originalSha256:sha,physicalPage:1,serviceVersion:"ocr-pdf-trial-0.1",model,parserScope,
    code:"synthetic_visual_warning",message:"Synthetic review, not historic evidence",evidenceRef:"synthetic-review.json#/0",severity:"warning"};
}
function adapt(findings:PaddleServiceFinding[]){
  const attempt=repo.createParsedDocument(page,{id:randomUUID(),materialId:material,originalSha256:sha,originalVersion:1,requestedPages:[1],parser:{name:"PaddleOCR",version:"ocr-pdf-trial-0.1"}});
  return adaptPaddleServiceResponse(response("synthetic-request"),{attempt,original,requestId:"synthetic-request",physicalPages:[1],findings});
}
it("keeps ordinary text unverified when a list is empty",()=>{
  const result=adapt([]);expect(result.pages[0].issues).toEqual([]);
  expect(result.pages[0].blocks[0].quality).toMatchObject({status:"unverified",reviews:[]});
});
it("matches reviewed original/page/service/model plus exact parser scope, independently of JSON key order",()=>{
  const f=finding();f.parserScope!.profile={options:{version:1,synthetic:true},recognition_profile:"png_nested_formulas"};
  const result=adapt([f]);expect(result.pages[0].issues).toEqual([expect.objectContaining({code:f.code,origin:"prior_visual_review",evidence_refs:[f.evidenceRef]})]);
  expect(result.pages[0].blocks[0].quality.status).toBe("unverified");
});
it.each(["originalSha256","physicalPage","serviceVersion","model","backend","paddleocr","paddlex","profile"])("does not apply a finding from different %s",field=>{
  const f=finding();
  if(field==="originalSha256")f.originalSha256="b".repeat(64);
  if(field==="physicalPage")f.physicalPage=2;
  if(field==="serviceVersion")f.serviceVersion="other-service";
  if(field==="model")f.model="OTHER_MODEL";
  if(field==="backend")f.parserScope!.backend="SYNTHETIC_VLLM";
  if(field==="paddleocr")f.parserScope!.paddleocr="different";
  if(field==="paddlex")f.parserScope!.paddlex="different";
  if(field==="profile")f.parserScope!.profile={recognition_profile:"other"};
  expect(adapt([f]).pages[0].issues).toEqual([]);
});
it("retains legacy review-list behavior without treating it as proof of backend applicability",()=>{
  const f=finding();delete f.parserScope;expect(adapt([f]).pages[0].issues).toHaveLength(1);
});
it("persists identities before single PUT/POST, discovers the instance, adapts and cleans through a prefixed mock gateway",async()=>{
  const url="https://ocr.synthetic.invalid/internal/ocr",id=randomUUID(),epoch="e".repeat(64),instance="session-7";
  const calls:string[]=[],config={url,token:"SYNTHETIC_TOKEN",findings:[finding()],discoverInstance:true};
  let receipt:Record<string,unknown>|undefined;
  const transport:typeof fetch=async(input,init)=>{
    const target=new URL(String(input)),method=init?.method??"GET",path=target.pathname;
    expect(target.origin).toBe("https://ocr.synthetic.invalid");expect(path.startsWith("/internal/ocr/")).toBe(true);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer SYNTHETIC_TOKEN");
    expect(init?.redirect).toBe("error");calls.push(`${method} ${path}`);
    if(path.endsWith("/health"))return Response.json({ready:true,service_epoch:epoch,instance,service_version:"ocr-pdf-trial-0.1",resource_policy_version:"learning-ocr-resource-v1",
      pdf_source_transport:{version:"v1",upload_method:"PUT",max_bytes:67108864,max_sources:8,max_total_bytes:536870912,ttl_seconds:7200,upload_timeout_seconds:600}});
    if(path.includes("/pdf-sources/")&&method==="PUT"){
      const sourceId=path.split("/").at(-1)!;
      expect(repo.listPdfSources(page,material)).toEqual([expect.objectContaining({sourceId,status:"uploading"})]);
      expect(Buffer.from(await new Response(init!.body).arrayBuffer())).toEqual(bytes);
      expect(new Headers(init?.headers).get("Content-Length")).toBe(String(bytes.length));
      receipt={source_id:sourceId,document_id:material,sha256:sha,bytes:bytes.length,physical_page_count:1,service_epoch:epoch,instance,status:"ready",
        created_at:new Date().toISOString(),expires_at:new Date(Date.now()+7200000).toISOString()};return Response.json(receipt);
    }
    if(path.endsWith("/parse-pdf")){
      const body=JSON.parse(String(init?.body));expect(method).toBe("POST");
      expect(body).toMatchObject({request_id:`${id}_1`,source_id:receipt!.source_id,expected_service_epoch:epoch,expected_instance:instance,recognition_profile:"png_nested_formulas"});
      expect(repo.database.prepare("SELECT request_id,status FROM learning_pdf_requests WHERE document_id=?").get(id)).toEqual({request_id:body.request_id,status:"submitted"});
      return Response.json({...response(body.request_id),service_epoch:epoch,instance});
    }
    if(path.includes("/results/")&&method==="DELETE")return Response.json({deleted:true});
    if(path.includes("/pdf-sources/")&&method==="DELETE")return Response.json({...receipt,status:"deleted"});
    throw Error("Unexpected mock OCR operation");
  };
  const result=await parseLearningPdf(repo,page,material,{id,physicalPages:[1]},{config,fetch:transport});
  expect(result.document.status).toBe("completed");expect(result.progress).toMatchObject([{status:"completed",request_id:`${id}_1`}]);
  expect(calls.filter(c=>c.startsWith("PUT "))).toHaveLength(1);expect(calls.filter(c=>c.startsWith("POST "))).toHaveLength(1);
  expect(calls.filter(c=>c.startsWith("DELETE "))).toHaveLength(2);
  const count=calls.length;await parseLearningPdf(repo,page,material,{id,physicalPages:[1]},{config,fetch:transport});expect(calls).toHaveLength(count);
});
