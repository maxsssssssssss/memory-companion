// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { syntheticLearningPdf } from "../../../../scripts/fixtures/learning-pdf.mjs";
import { LearningRepository } from "./repository";
import { cleanupDeletedPdfSources, ensurePdfSource, type PdfSourceConnection } from "./pdf-source-transfer";

const bytes=syntheticLearningPdf({pages:3}),sha=createHash("sha256").update(bytes).digest("hex");
const config:PdfSourceConnection={url:"https://synthetic.invalid/internal/ocr",token:"SYNTHETIC_ONLY",serviceEpoch:"e".repeat(64),instance:"session-1",
  sourceTransport:{version:"v1",upload_method:"PUT",max_bytes:67108864,max_sources:8,max_total_bytes:536870912,ttl_seconds:7200,upload_timeout_seconds:600}};
let root:string,repo:LearningRepository,pageId:string,materialId:string;
let calls:Array<{url:string;init:RequestInit|undefined}>,saved:Record<string,unknown>;
beforeEach(()=>{
  root=mkdtempSync(join(tmpdir(),"synthetic-pdf-transfer-"));repo=new LearningRepository(root,"synthetic-owner");
  pageId=repo.create({id:randomUUID(),title:"SYNTHETIC transport test"}).id;materialId=randomUUID();
  repo.saveMaterials(pageId,[{id:materialId,title:"SYNTHETIC original",kind:"pdf",filename:"synthetic.pdf",bytes,pdf:{sha256:sha,originalVersion:1,parsing:"not_parsed",pageCount:3,
    pages:[1,2,3].map(physicalPage=>({physicalPage,width:600,height:800,rotation:0,view:[0,0,600,800],userUnit:1}))}}]);
  calls=[];saved={};vi.stubGlobal("fetch",()=>{throw Error("REAL NETWORK FORBIDDEN");});
});
afterEach(()=>{vi.unstubAllGlobals();if(repo.database.open)repo.close();rmSync(root,{recursive:true,force:true});});
const options=(explicitResume=false)=>({assertOwner:()=>{repo.pdfOriginal(pageId,materialId,false);},explicitResume,now:Date.now});
const transport:typeof fetch=async(url,init)=>{
  calls.push({url:String(url),init});
  if(init?.method==="PUT"){
    const headers=new Headers(init.headers);
    expect(headers.get("Content-Length")).toBe(String(bytes.length));
    expect(headers.get("X-OCR-Document-ID")).toBe(materialId);expect(headers.get("X-OCR-SHA256")).toBe(sha);
    expect(headers.get("X-OCR-Service-Epoch")).toBe(config.serviceEpoch);expect(headers.get("X-OCR-Instance")).toBe(config.instance);
    expect(Buffer.from(init.body as Uint8Array)).toEqual(bytes);
    saved={source_id:String(url).split("/").at(-1),document_id:materialId,sha256:sha,bytes:bytes.length,physical_page_count:3,
      service_epoch:config.serviceEpoch,instance:config.instance,status:"ready",created_at:new Date().toISOString(),expires_at:new Date(Date.now()+7200000).toISOString()};
  }
  if(init?.method==="DELETE")saved={...saved,status:"deleted"};
  return Response.json(saved,{status:init?.method==="PUT"?201:200});
};
it("uploads exact binary once, persists identity before PUT and reuses it after reopening",async()=>{
  const inspect:typeof fetch=async(url,init)=>{
    if(init?.method==="PUT")expect(repo.listPdfSources(pageId,materialId)).toEqual([expect.objectContaining({sourceId:String(url).split("/").at(-1),status:"uploading"})]);
    return transport(url,init);
  };
  const id=await ensurePdfSource(repo,pageId,materialId,config,inspect,options());
  repo.close();repo=new LearningRepository(root,"synthetic-owner");
  expect(await ensurePdfSource(repo,pageId,materialId,config,inspect,options(true))).toBe(id);
  expect(calls.map(c=>c.init?.method??"GET")).toEqual(["PUT","GET"]);
  expect(JSON.stringify(repo.listPdfSources(pageId,materialId))).not.toContain(config.token);
});
it("lost upload response remains unknown and recovery queries the exact ID with no second upload",async()=>{
  const broken:typeof fetch=async(url,init)=>{await transport(url,init);throw Error("SYNTHETIC private upstream detail");};
  await expect(ensurePdfSource(repo,pageId,materialId,config,broken,options())).rejects.toThrow("pdf_source_outcome_unknown");
  const first=repo.listPdfSources(pageId,materialId)[0];expect(first.status).toBe("unknown");
  expect(await ensurePdfSource(repo,pageId,materialId,config,transport,options(true))).toBe(first.sourceId);
  expect(calls.filter(c=>c.init?.method==="PUT")).toHaveLength(1);
});
it.each(["404","truncated","wrong-material","wrong-hash","wrong-epoch","wrong-page-count"])("ambiguous/mismatched lookup stays fail closed: %s",async(mode)=>{
  await ensurePdfSource(repo,pageId,materialId,config,transport,options());
  const bad:typeof fetch=async()=> mode==="404"?Response.json({error:"source_not_found"},{status:404}):mode==="truncated"?new Response('{"source_id":'):
    Response.json({...saved,...mode==="wrong-material"?{document_id:randomUUID()}:mode==="wrong-hash"?{sha256:"f".repeat(64)}:mode==="wrong-epoch"?{service_epoch:"f".repeat(64)}:{physical_page_count:2}});
  await expect(ensurePdfSource(repo,pageId,materialId,config,bad,options(true))).rejects.toThrow("pdf_source_outcome_unknown");
  expect(repo.listPdfSources(pageId,materialId)).toHaveLength(1);
});
it("confirmed expired source needs explicit continuation and creates a separate upload identity",async()=>{
  const first=await ensurePdfSource(repo,pageId,materialId,config,transport,options());
  saved={...saved,status:"expired"};
  await expect(ensurePdfSource(repo,pageId,materialId,config,transport,options())).rejects.toThrow("pdf_source_unavailable");
  const next=await ensurePdfSource(repo,pageId,materialId,config,transport,options(true));
  expect(next).not.toBe(first);expect(repo.listPdfSources(pageId,materialId).map(s=>s.status)).toEqual(["expired","ready"]);
});
it.each(["source_deleted","source_expired"])("accepts deployed minimal 410 %s only as a terminal source, never re-PUTs its ID",async(error)=>{
  const first=await ensurePdfSource(repo,pageId,materialId,config,transport,options());
  const deleted:typeof fetch=async(url,init)=>init?.method==="PUT"?transport(url,init):Response.json({error,accepted:false},{status:410});
  await expect(ensurePdfSource(repo,pageId,materialId,config,deleted,options())).rejects.toThrow("pdf_source_unavailable");
  const next=await ensurePdfSource(repo,pageId,materialId,config,deleted,options(true));
  expect(next).not.toBe(first);expect(calls.filter(c=>c.init?.method==="PUT")).toHaveLength(2);
  expect(repo.listPdfSources(pageId,materialId).map(s=>s.status)).toEqual(["expired","ready"]);
});
it("changed endpoint/instance never bypasses an unknown upload",async()=>{
  const broken:typeof fetch=async(url,init)=>{await transport(url,init);throw Error("lost");};
  await expect(ensurePdfSource(repo,pageId,materialId,config,broken,options())).rejects.toThrow("pdf_source_outcome_unknown");
  const none=vi.fn< typeof fetch >();
  await expect(ensurePdfSource(repo,pageId,materialId,{...config,instance:"session-2"},none,options(true))).rejects.toThrow("pdf_source_outcome_unknown");
  expect(none).not.toHaveBeenCalled();
});
it("capacity refusal is recorded as a failed upload, without any page OCR submission",async()=>{
  const full=vi.fn<typeof fetch>(async()=>Response.json({error:"source_capacity_exhausted"},{status:503}));
  await expect(ensurePdfSource(repo,pageId,materialId,config,full,options())).rejects.toThrow("pdf_source_capacity_exhausted");
  expect(repo.listPdfSources(pageId,materialId)[0].status).toBe("failed");expect(full).toHaveBeenCalledTimes(1);
  expect(repo.database.prepare("SELECT count(*) n FROM learning_pdf_requests").get()).toEqual({n:0});
});
it("deletion during upload fences the late receipt and cleans only the deleted material's original",async()=>{
  const deleting:typeof fetch=async(url,init)=>{const response=await transport(url,init);if(init?.method==="PUT")repo.deleteMaterial(pageId,materialId);return response;};
  await expect(ensurePdfSource(repo,pageId,materialId,config,deleting,options())).rejects.toThrow("material_deleted");
  expect(repo.listPdfSourcesPendingCleanup(pageId,materialId)).toHaveLength(1);
  await cleanupDeletedPdfSources(repo,pageId,materialId,config,transport);
  expect(repo.listPdfSourcesPendingCleanup(pageId,materialId)).toHaveLength(0);
  expect(calls.at(-1)?.init?.method).toBe("DELETE");expect(()=>repo.pdfOriginal(pageId,materialId)).toThrow("material_deleted");
});
it("cleanup preserves intent for 404 or network failure and never targets a changed endpoint",async()=>{
  await ensurePdfSource(repo,pageId,materialId,config,transport,options());repo.deletePage(pageId);
  const missing=vi.fn<typeof fetch>(async()=>Response.json({error:"source_not_found"},{status:404}));
  await cleanupDeletedPdfSources(repo,pageId,undefined,{...config,url:"https://different.invalid"},missing);
  expect(missing).not.toHaveBeenCalled();
  await cleanupDeletedPdfSources(repo,pageId,undefined,config,missing);
  expect(repo.listPdfSourcesPendingCleanup(pageId)[0].remoteCleanup).toBe("failed");
});
