// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LearningPdfMetadata } from "@/lib/domain/learning";
import type { ParsedDocument, ParsedDocumentResult } from "@/lib/domain/learning-parsed-document";
import { syntheticLearningPdf } from "../../../../scripts/fixtures/learning-pdf.mjs";
import { LearningRepository } from "./repository";
import { parseLearningPdf, parseLearningPdfAutomatically, pdfParseProgress } from "./pdf-parser-service";
import { resumeLearningPdfPreparation } from "./upload-preparation";
import { listLearningPreparations, resumeLearningPreparation, startLearningPreparation } from "./preparation-service";
import { inspectLearningPdfReadiness } from "./pdf-readiness";

// Synthetic parser contract isolates execution checkpoints from OCR quality.
// It never reads user PDFs or reaches a service.
vi.mock("./paddle-parsed-adapter", () => ({ adaptPaddleServiceResponse: (input: { invalid?: boolean }, binding: { attempt: ParsedDocument; physicalPages: number[] }): ParsedDocumentResult => {
  if (input.invalid) throw new Error("SYNTHETIC invalid mapping");
  const doc = binding.attempt, page = binding.physicalPages[0], id = randomUUID();
  return { contract_version: "learning-parsed-document/2", document_id: doc.id, material_id: doc.materialId,
    original_sha256: doc.originalSha256!, parse_version: doc.version,
    parser_run: { run_id: doc.id, upstream_document_id: doc.materialId, model: "SYNTHETIC", config_summary: "NO OCR" },
    coverage: { requested_pages: [page], succeeded_pages: [page], failed_pages: [] }, pages: [{ physical_page: page, printed_label: null,
      parser_page_index: page - 1, parse_status: "succeeded", failure_code: null,
      render: { width_px: 600, height_px: 800, rotation: 0, crop_pdf: [0, 0, 600, 800], frame: "displayed_pdf_crop" },
      issues: [], reading_order: { block_ids: [id], origin: "SYNTHETIC", reviews: [] }, blocks: [{ id, type: "text", parser_type: "synthetic", role: "body",
        content: { raw: "SYNTHETIC", normalized: "SYNTHETIC", format: "plain", cleaning: "none" }, source_member_ids: [id],
        source_regions: [{ member_id: id, physical_page: page, bbox: [0.1, 0.1, 0.5, 0.5], unit: "normalized", origin: "top_left", frame: "displayed_pdf_crop",
          parser_ref: { run_id: doc.id, page_index: page - 1, block_id: id, result_ref: "SYNTHETIC" } }],
        quality: { status: "unverified", reason: "SYNTHETIC", automatic_signals: [], text_layer_signals: [], reviews: [] } }] }] };
} }));
const bytes = syntheticLearningPdf({ pages: 3 }), sha = createHash("sha256").update(bytes).digest("hex");
const metadata: LearningPdfMetadata = { sha256: sha, originalVersion: 1, parsing: "not_parsed", pageCount: 3,
  pages: [1, 2, 3].map(physicalPage => ({ physicalPage, width: 600, height: 800, rotation: 0, view: [0, 0, 600, 800], userUnit: 1 })) };
const config = { url: "http://127.0.0.1:1", token: "SYNTHETIC", findings: [] };
let root: string, repo: LearningRepository, pageId: string, materialId: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "synthetic-learning-pdf-progress-")); repo = new LearningRepository(root, "synthetic-owner");
  pageId = randomUUID(); materialId = randomUUID(); repo.create({ id: pageId, title: "SYNTHETIC" });
  repo.saveMaterials(pageId, [{ id: materialId, title: "SYNTHETIC", kind: "pdf", filename: "synthetic.pdf", bytes, pdf: metadata }]);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("External I/O forbidden"); }));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); repo.close(); rmSync(root, { recursive: true, force: true }); });
const input = () => ({ id: randomUUID(), physicalPages: [1, 2, 3] });
const epochConfig={...config,serviceEpoch:"e".repeat(64),instance:"session-1"};
const readyHealth=()=>Response.json({service_epoch:epochConfig.serviceEpoch,instance:epochConfig.instance,ready:true,admission:{accepting:true},active_request:null});
function notAccepted(request: {request_id:string;document_id:string;sha256:string;page_range:{start:number}}) {
  return {request_id:request.request_id,document_id:request.document_id,sha256:request.sha256,pages:[request.page_range.start],
    status:"not_accepted",accepted:false,reason:"resource_wait",retry_after_seconds:1,instance:epochConfig.instance,service_epoch:epochConfig.serviceEpoch};
}
it("waits only after a bound non-admission receipt, keeps the same request ID, and duplicate starts cannot own its lease",async()=>{
  let clock=Date.now(),waiting=false;const request=input(),posts:string[]=[];
  const transport:typeof fetch=async(_url,init)=>{
    if(init?.method==="DELETE")return Response.json({deleted:true});
    if(!init?.method)return readyHealth();
    const body=JSON.parse(init!.body as string);posts.push(body.request_id);
    if(body.page_range.start===2&&!waiting){waiting=true;return Response.json(notAccepted(body),{status:503});}
    return Response.json({});
  };
  const sleep=vi.fn(async(ms:number)=>{
    expect(pdfParseProgress(repo,pageId,request.id)[1]).toMatchObject({status:"waiting_resource",wait:{reason:"resource_wait"}});
    expect(JSON.stringify(pdfParseProgress(repo,pageId,request.id))).not.toContain("synthetic-epoch");
    expect((await parseLearningPdf(repo,pageId,materialId,request,{config:epochConfig,fetch:transport,now:()=>clock})).document.status).toBe("processing");
    expect((await parseLearningPdf(repo,pageId,materialId,{...input(),resumeFrom:request.id},{config:epochConfig,fetch:transport,now:()=>clock})).document.id).toBe(request.id);
    clock+=ms;
  });
  const result=await parseLearningPdf(repo,pageId,materialId,request,{config:epochConfig,fetch:transport,now:()=>clock,sleep,resourceWaitMs:5000});
  expect(posts).toEqual([`${request.id}_1`,`${request.id}_2`,`${request.id}_2`,`${request.id}_3`]);
  expect(sleep).toHaveBeenCalledTimes(1);expect(result.document.coverage?.succeeded_pages).toEqual([1,2,3]);
  expect(repo.database.prepare("SELECT pdf_execution_token,pdf_execution_lease_until FROM learning_parsed_documents WHERE id=?").get(request.id)).toEqual({pdf_execution_token:null,pdf_execution_lease_until:0});
});
it("bounds resource waiting, persists it separately from OCR content and resumes the exact original page after reopen",async()=>{
  const request=input();let body:ReturnType<typeof notAccepted>|undefined;
  const transport:typeof fetch=async(_url,init)=>{const wire=JSON.parse(init!.body as string);body=notAccepted(wire);return Response.json(body,{status:503});};
  const first=await parseLearningPdf(repo,pageId,materialId,request,{config:epochConfig,fetch:transport,resourceWaitMs:0});
  expect(first.progress.map(p=>p.status)).toEqual(["waiting_resource","pending","pending"]);
  expect(repo.database.prepare("SELECT response_json FROM learning_pdf_requests WHERE document_id=? AND physical_page=1").get(request.id)).toEqual({response_json:null});
  repo.close();repo=new LearningRepository(root,"synthetic-owner");let clock=Date.now();const posts:string[]=[];
  const resumed=await parseLearningPdf(repo,pageId,materialId,{...input(),resumeFrom:request.id},{config:epochConfig,now:()=>clock,sleep:async ms=>{clock+=ms;},fetch:async(_u,init)=>{
    if(!init?.method)return readyHealth();
    if(init?.method!=="DELETE")posts.push(JSON.parse(init!.body as string).request_id);return Response.json({});
  }});
  expect(posts[0]).toBe(body!.request_id);expect(posts).toHaveLength(3);expect(resumed.document.version).toBe(2);
  expect(pdfParseProgress(repo,pageId,request.id)[0].status).toBe("waiting_resource");
});
it.each(["bare503","accepted","wrongRequest","wrongHash","wrongPage"])("does not retry %s as resource waiting",async kind=>{
  const sleep=vi.fn(),transport=vi.fn(async(_u:unknown,init?:RequestInit)=>{
    const body=notAccepted(JSON.parse(init!.body as string));
    const changed=kind==="bare503"?{error:"busy"}:kind==="accepted"?{...body,accepted:true}:kind==="wrongRequest"?{...body,request_id:"other"}:kind==="wrongHash"?{...body,sha256:"a".repeat(64)}:{...body,pages:[2]};
    return Response.json(changed,{status:503});
  });
  const result=await parseLearningPdf(repo,pageId,materialId,input(),{config:epochConfig,fetch:transport,sleep});
  expect(result.progress[0].status).toBe("unknown");expect(transport).toHaveBeenCalledTimes(1);expect(sleep).not.toHaveBeenCalled();
});
it("binds admission to the expected service instance and refuses a changed-instance receipt without retry",async()=>{
  const calls:RequestInit[]=[];
  const result=await parseLearningPdf(repo,pageId,materialId,input(),{config:epochConfig,fetch:async(_u,init)=>{
    calls.push(init!);const body=JSON.parse(init!.body as string);
    expect(body).toMatchObject({expected_service_epoch:epochConfig.serviceEpoch,expected_instance:epochConfig.instance});
    return Response.json({...notAccepted(body),reason:"instance_changed",service_epoch:"d".repeat(64),instance:"session-2"},{status:409});
  }});
  expect(calls).toHaveLength(1);expect(result.progress[0]).toMatchObject({status:"failed",issue:"pdf_parser_service_changed"});
});
it("a non-admission response without a bounded retry delay remains unknown",async()=>{
  const sleep=vi.fn(),transport=vi.fn(async(_u:unknown,init?:RequestInit)=>{
    const {retry_after_seconds:_delay,...body}=notAccepted(JSON.parse(init!.body as string));return Response.json(body,{status:503});
  });
  const result=await parseLearningPdf(repo,pageId,materialId,input(),{config:epochConfig,fetch:transport,sleep});
  expect(result.progress[0].status).toBe("unknown");expect(transport).toHaveBeenCalledTimes(1);expect(sleep).not.toHaveBeenCalled();
});
it.each(["budget_exhausted","session_expired"])("keeps confirmed %s separate from resource waiting and never resubmits",async reason=>{
  const request=input(),sleep=vi.fn(),transport=vi.fn(async(_u:unknown,init?:RequestInit)=>{
    const {retry_after_seconds:_delay,...receipt}=notAccepted(JSON.parse(init!.body as string));
    return Response.json({...receipt,reason},{status:503});
  });
  const result=await parseLearningPdf(repo,pageId,materialId,request,{config:epochConfig,fetch:transport,sleep});
  expect(result.progress.map(p=>p.status)).toEqual(["failed","pending","pending"]);
  expect(result.progress[0]).toMatchObject({issue:`pdf_parser_${reason}`});expect(result.progress[0].wait).toBeUndefined();
  await parseLearningPdf(repo,pageId,materialId,request,{config:epochConfig,fetch:transport,sleep});
  expect(transport).toHaveBeenCalledTimes(1);expect(sleep).not.toHaveBeenCalled();

  // A lightweight health read may finish a previously proven unaccepted wait.
  // It never grants permission to retransmit this now terminal request.
  let clock=Date.now(),posts=0,reads=0;
  const waiting=await parseLearningPdf(repo,pageId,materialId,input(),{config:epochConfig,now:()=>clock,sleep:async ms=>{clock+=ms;},fetch:async(_u,init)=>{
    if(init?.method==="POST"){posts++;return Response.json(notAccepted(JSON.parse(init.body as string)),{status:503});}
    reads++;return Response.json({service_epoch:epochConfig.serviceEpoch,instance:epochConfig.instance,ready:true,admission:{accepting:false,reason},active_request:null});
  }});
  expect(posts).toBe(1);expect(reads).toBe(1);expect(waiting.progress[0]).toMatchObject({status:"failed",issue:`pdf_parser_${reason}`});
  expect(waiting.progress[0].wait).toBeUndefined();
});
it("keeps the remote cache recoverable when HTTP200 response bytes stop before a complete JSON receipt",async()=>{
  const transport=vi.fn(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"incomplete":'));controller.error(new Error("SYNTHETIC connection closed"));}}),{status:200}));
  const result=await parseLearningPdf(repo,pageId,materialId,input(),{config:epochConfig,fetch:transport});
  expect(result.progress[0].status).toBe("unknown");expect(transport).toHaveBeenCalledTimes(1);
  expect(repo.database.prepare("SELECT response_json,remote_cleanup FROM learning_pdf_requests WHERE document_id=? AND physical_page=1").get(result.document.id)).toEqual({response_json:null,remote_cleanup:null});
});
it("a fenced owner receiving a full late response cannot delete the remote receipt required for recovery",async()=>{
  const request=input(),methods:string[]=[];
  await expect(parseLearningPdf(repo,pageId,materialId,request,{config:epochConfig,fetch:async(_u,init)=>{
    methods.push(init?.method??"GET");
    repo.database.prepare("UPDATE learning_parsed_documents SET pdf_execution_token='replacement-owner',pdf_execution_lease_until=? WHERE id=?").run(Date.now()+45000,request.id);
    return Response.json({request_id:`${request.id}_1`,service_epoch:epochConfig.serviceEpoch,instance:epochConfig.instance});
  }})).rejects.toThrow("pdf_parser_interrupted");
  expect(methods).toEqual(["POST"]);expect(pdfParseProgress(repo,pageId,request.id)[0].status).toBe("submitted");
  expect(repo.database.prepare("SELECT response_json FROM learning_pdf_requests WHERE document_id=? AND physical_page=1").get(request.id)).toEqual({response_json:null});
});
it("deletion while waiting cancels further submission and never restores the page",async()=>{
  const transport=vi.fn(async(_u:unknown,init?:RequestInit)=>Response.json(notAccepted(JSON.parse(init!.body as string)),{status:503}));
  await expect(parseLearningPdf(repo,pageId,materialId,input(),{config:epochConfig,fetch:transport,sleep:async()=>{repo.deleteMaterial(pageId,materialId);}})).rejects.toThrow("material_deleted");
  expect(transport).toHaveBeenCalledTimes(1);expect(repo.database.prepare("SELECT * FROM learning_pdf_requests").all()).toEqual([]);
});
it("an expired waiting owner cannot resume or publish after another process takes over",async()=>{
  const request=input();let wake!:()=>void,waiting=false;const posts:string[]=[];
  const transport:typeof fetch=async(_u,init)=>{
    if(!init?.method)return readyHealth();
    if(init?.method==="DELETE")return Response.json({});const body=JSON.parse(init!.body as string);posts.push(body.request_id);
    if(!waiting){waiting=true;return Response.json(notAccepted(body),{status:503});}return Response.json({});
  };
  const old=parseLearningPdf(repo,pageId,materialId,request,{config:epochConfig,fetch:transport,sleep:()=>new Promise(resolve=>{wake=resolve;})});
  await vi.waitFor(()=>expect(wake).toBeTypeOf("function"));
  repo.database.prepare("UPDATE learning_parsed_documents SET pdf_execution_lease_until=0 WHERE id=?").run(request.id);
  let clock=Date.now();const takeover=await parseLearningPdf(repo,pageId,materialId,{...input(),resumeFrom:request.id},{config:epochConfig,fetch:transport,now:()=>clock,sleep:async ms=>{clock+=ms;}});
  wake();await expect(old).rejects.toThrow("pdf_parser_interrupted");
  expect(takeover.document.coverage?.succeeded_pages).toEqual([1,2,3]);expect(posts).toHaveLength(4);
});
it("polls bounded health without resending PDF bytes while resource admission is closed",async()=>{
  let clock=Date.now(),posts=0,healthReads=0;
  const result=await parseLearningPdf(repo,pageId,materialId,input(),{config:epochConfig,now:()=>clock,sleep:async ms=>{clock+=ms;},resourceWaitMs:3500,fetch:async(_u,init)=>{
    if(init?.method==="POST"){posts++;return Response.json(notAccepted(JSON.parse(init.body as string)),{status:503});}
    healthReads++;return Response.json({service_epoch:epochConfig.serviceEpoch,instance:epochConfig.instance,ready:true,admission:{accepting:false},active_request:null});
  }});
  expect(posts).toBe(1);expect(healthReads).toBe(3);expect(result.progress[0].status).toBe("waiting_resource");
});
it("stops a waiting unaccepted request if the health service epoch changes without resending",async()=>{
  let clock=Date.now(),posts=0;
  const result=await parseLearningPdf(repo,pageId,materialId,input(),{config:epochConfig,now:()=>clock,sleep:async ms=>{clock+=ms;},fetch:async(_u,init)=>{
    if(init?.method==="POST"){posts++;return Response.json(notAccepted(JSON.parse(init.body as string)),{status:503});}
    return Response.json({service_epoch:"a".repeat(64),instance:"session-2",ready:true,admission:{accepting:true},active_request:null});
  }});
  expect(posts).toBe(1);expect(result.progress[0]).toMatchObject({status:"waiting_resource",issue:"pdf_parser_service_changed"});
});
it("queries only the original epoch-bound unknown request, recovers its complete result and continues unsent pages",async()=>{
  const request=input();await parseLearningPdf(repo,pageId,materialId,request,{config:epochConfig,fetch:async()=>{throw Error("SYNTHETIC transport loss");}});
  const calls:string[]=[];
  const transport:typeof fetch=async(url,init)=>{
    calls.push(`${init?.method??"GET"} ${String(url).split("http://127.0.0.1:1")[1]}`);
    if(String(url).endsWith("/result"))return Response.json({request_id:`${request.id}_1`,service_epoch:epochConfig.serviceEpoch,instance:epochConfig.instance});
    if((init?.method??"GET")==="GET")return Response.json({request_id:`${request.id}_1`,service_epoch:epochConfig.serviceEpoch,instance:epochConfig.instance,document_id:materialId,sha256:sha,pages:[1],status:"completed",publishable:true});
    return Response.json({});
  };
  const second=await parseLearningPdf(repo,pageId,materialId,{...input(),resumeFrom:request.id},{config:epochConfig,fetch:transport});
  expect(second.document.coverage?.succeeded_pages).toEqual([1,2,3]);
  expect(calls.filter(c=>c.startsWith("GET"))).toEqual([`GET /requests/${request.id}_1`,`GET /requests/${request.id}_1/result`]);
  expect(calls.filter(c=>c.startsWith("POST"))).toHaveLength(2);
});
it.each(["missing","changedEpoch","changedHash","processing"])("keeps unknown %s results fenced without another POST",async kind=>{
  const request=input();await parseLearningPdf(repo,pageId,materialId,request,{config:epochConfig,fetch:async()=>{throw Error("SYNTHETIC loss");}});
  const transport=vi.fn(async()=>Response.json({request_id:`${request.id}_1`,service_epoch:kind==="changedEpoch"?"other":epochConfig.serviceEpoch,instance:epochConfig.instance,document_id:materialId,
    sha256:kind==="changedHash"?"a".repeat(64):sha,pages:[1],status:kind==="processing"?"processing":"completed",publishable:true},{status:kind==="missing"?404:200}));
  await expect(parseLearningPdf(repo,pageId,materialId,{...input(),resumeFrom:request.id},{config:epochConfig,fetch:transport})).rejects.toThrow("pdf_parser_outcome_unknown");
  expect(transport).toHaveBeenCalledTimes(1);expect(repo.listParsedDocuments(pageId,materialId)).toHaveLength(1);
  expect(pdfParseProgress(repo,pageId,request.id)[0].status).toBe("unknown");
});
it("keeps the HTTPS gateway prefix on original-request recovery, continuation and result cleanup",async()=>{
  const gateway={...epochConfig,url:"https://ocr.synthetic.invalid/internal/ocr",discoverInstance:true};
  const health={service_version:"ocr-pdf-trial-0.1",resource_policy_version:"learning-ocr-resource-v1",ready:true,service_epoch:gateway.serviceEpoch,instance:gateway.instance};
  const request=input();
  await parseLearningPdf(repo,pageId,materialId,request,{config:gateway,fetch:async(url)=>{
    if(String(url)===gateway.url+"/health")return Response.json(health);throw Error("SYNTHETIC unknown POST");
  }});
  const calls:string[]=[];
  const transport:typeof fetch=async(url,init)=>{
    expect(String(url).startsWith(gateway.url+"/")).toBe(true);expect(init?.redirect).toBe("error");
    expect((init?.headers as Record<string,string>).Authorization).toBe("Bearer "+gateway.token);
    const suffix=String(url).slice(gateway.url.length);calls.push(`${init?.method??"GET"} ${suffix}`);
    if(suffix==="/health")return Response.json(health);
    const identity={request_id:`${request.id}_1`,service_epoch:gateway.serviceEpoch,instance:gateway.instance};
    if(suffix.endsWith("/result"))return Response.json(identity);
    if((init?.method??"GET")==="GET")return Response.json({...identity,document_id:materialId,sha256:sha,pages:[1],status:"completed",publishable:true});
    if(init?.method==="DELETE")return Response.json({deleted:true});
    const body=JSON.parse(init!.body as string);return Response.json({...identity,request_id:body.request_id});
  };
  const result=await parseLearningPdf(repo,pageId,materialId,{...input(),resumeFrom:request.id},{config:gateway,fetch:transport});
  expect(result.document.coverage?.succeeded_pages).toEqual([1,2,3]);
  expect(calls.filter(c=>c.startsWith("GET"))).toEqual(["GET /health",`GET /requests/${request.id}_1`,`GET /requests/${request.id}_1/result`]);
  expect(calls.filter(c=>c.startsWith("POST"))).toEqual(["POST /parse-pdf","POST /parse-pdf"]);
  expect(calls.filter(c=>c.startsWith("DELETE /results/"))).toHaveLength(2);
});
it("a newer parse created during unknown recovery fences the stale resume before any new POST",async()=>{
  const request=input();await parseLearningPdf(repo,pageId,materialId,request,{config:epochConfig,fetch:async()=>{throw Error("SYNTHETIC loss");}});
  const calls:string[]=[];
  const transport:typeof fetch=async(url,init)=>{
    calls.push(init?.method??"GET");
    if(String(url).endsWith("/result")){
      repo.createParsedDocument(pageId,{id:randomUUID(),materialId,originalSha256:sha,originalVersion:1,requestedPages:[1,2,3],parser:{name:"PaddleOCR",version:"ocr-pdf-trial-0.1"}});
      return Response.json({request_id:`${request.id}_1`,service_epoch:epochConfig.serviceEpoch,instance:epochConfig.instance});
    }
    return Response.json({request_id:`${request.id}_1`,service_epoch:epochConfig.serviceEpoch,instance:epochConfig.instance,document_id:materialId,sha256:sha,pages:[1],status:"completed",publishable:true});
  };
  await expect(parseLearningPdf(repo,pageId,materialId,{...input(),resumeFrom:request.id},{config:epochConfig,fetch:transport})).rejects.toThrow("source_changed");
  expect(calls).toEqual(["GET","GET"]);expect(repo.listParsedDocuments(pageId,materialId)).toHaveLength(2);
});
it("keeps attempted failure and later pending pages distinct, then resumes only unfinished pages", async () => {
  const posts: number[] = []; let failing = true;
  const transport: typeof fetch = async (_url, init) => {
    if (init?.method === "DELETE") return Response.json({ deleted: true });
    const request = JSON.parse(init!.body as string); posts.push(request.page_range.start);
    return request.page_range.start === 2 && failing ? Response.json({ request_id: request.request_id, status: "failed" }, { status: 503 }) : Response.json({});
  };
  const first = await parseLearningPdf(repo, pageId, materialId, input(), { config, fetch: transport });
  expect(first.progress.map(p => p.status)).toEqual(["completed", "failed", "pending"]);
  expect(first.document.coverage).toMatchObject({ succeeded_pages: [1], failed_pages: [2, 3] });
  failing = false;
  const second = await parseLearningPdf(repo, pageId, materialId, { ...input(), resumeFrom: first.document.id }, { config, fetch: transport });
  expect(second.progress.map(p => p.status)).toEqual(["completed", "completed", "completed"]);
  expect(posts).toEqual([1, 2, 2, 3]);
  expect(pdfParseProgress(repo, pageId, first.document.id).map(p => p.status)).toEqual(["completed", "failed", "pending"]);
});
it("primary Continue resumes the original range, rebinds only its new parser version, and never reparses completed pages",async()=>{
  const posts:number[]=[];let failed=true;
  const transport:typeof fetch=async(_u,init)=>{
    if(init?.method==="DELETE")return Response.json({});const body=JSON.parse(init!.body as string);posts.push(body.page_range.start);
    return failed&&body.page_range.start===2?Response.json({request_id:body.request_id,status:"failed"},{status:503}):Response.json({});
  };
  const first=await parseLearningPdf(repo,pageId,materialId,input(),{config,fetch:transport});
  const jobs:Promise<void>[]=[],keep=(job:Promise<void>)=>jobs.push(job),framework=vi.fn(),overview=vi.fn();
  const resumePdf=vi.fn((r:LearningRepository,p:string,m:string)=>resumeLearningPdfPreparation(r,p,m,(r,p,m,input)=>parseLearningPdf(r,p,m,input,{config,fetch:transport})));
  const deps={prepare:()=>[],inspect:inspectLearningPdfReadiness,framework,overview,resumePdf};
  const run=startLearningPreparation(repo,pageId,[materialId],keep,deps,"prepare");await Promise.all(jobs);
  expect(listLearningPreparations(repo,pageId).at(-1)?.status).toBe("needs_attention");expect(resumePdf).not.toHaveBeenCalled();
  failed=false;resumeLearningPreparation(repo,pageId,{id:run.id},keep,deps);resumeLearningPreparation(repo,pageId,{id:run.id},keep,deps);await Promise.all(jobs);
  expect(posts).toEqual([1,2,2,3]);expect(resumePdf).toHaveBeenCalledTimes(1);
  expect(listLearningPreparations(repo,pageId).at(-1)).toMatchObject({status:"completed",completed:1,total:1});
  const latest=repo.listParsedDocuments(pageId,materialId).at(-1)!;expect(latest.id).not.toBe(first.document.id);
  expect(repo.get(pageId).materials[0].pdfStudy?.documentId).toBe(latest.id);expect(repo.source(pageId,materialId).paragraphs).toHaveLength(3);
  expect(framework).not.toHaveBeenCalled();expect(overview).not.toHaveBeenCalled();
  repo.close();repo=new LearningRepository(root,"synthetic-owner");expect(listLearningPreparations(repo,pageId).at(-1)?.status).toBe("completed");expect(posts).toHaveLength(4);
});
it("explicit available-parts consent does not turn into an OCR resume",async()=>{
  await parseLearningPdf(repo,pageId,materialId,input(),{config,fetch:async(_u,init)=>{
    if(init?.method==="DELETE")return Response.json({});const body=JSON.parse(init!.body as string);
    return body.page_range.start===2?Response.json({request_id:body.request_id,status:"failed"},{status:503}):Response.json({});
  }});
  const jobs:Promise<void>[]=[],keep=(job:Promise<void>)=>jobs.push(job),resumePdf=vi.fn();
  const deps={prepare:()=>[],inspect:inspectLearningPdfReadiness,framework:vi.fn(),overview:vi.fn(),resumePdf};
  const run=startLearningPreparation(repo,pageId,[materialId],keep,deps,"prepare");await Promise.all(jobs);
  resumeLearningPreparation(repo,pageId,{id:run.id,continueWithAvailable:true},keep,deps);await Promise.all(jobs);
  expect(resumePdf).not.toHaveBeenCalled();expect(repo.get(pageId).materials[0].pdfStudy?.physicalPages).toEqual([1]);
});
it("reopens an additive old schema without losing originals, completed pages or material ownership",async()=>{
  const result=await parseLearningPdf(repo,pageId,materialId,input(),{config,fetch:async()=>Response.json({})});
  const original=repo.pdfOriginal(pageId,materialId).bytes;
  repo.database.exec("ALTER TABLE learning_pdf_requests DROP COLUMN request_context_json; ALTER TABLE learning_parsed_documents DROP COLUMN pdf_execution_token; ALTER TABLE learning_parsed_documents DROP COLUMN pdf_execution_lease_until;");
  repo.close();repo=new LearningRepository(root,"synthetic-owner");
  expect(repo.getParsedDocument(pageId,result.document.id)).toEqual(result.document);expect(repo.pdfOriginal(pageId,materialId).bytes).toEqual(original);
  expect(pdfParseProgress(repo,pageId,result.document.id).map(p=>p.status)).toEqual(["completed","completed","completed"]);
  expect(repo.database.prepare("SELECT pdf_execution_token,pdf_execution_lease_until FROM learning_parsed_documents WHERE id=?").get(result.document.id)).toEqual({pdf_execution_token:null,pdf_execution_lease_until:0});
});
it("marks a full response rejected by adaptation failed instead of falsely completed", async () => {
  const calls: string[] = [];
  const transport: typeof fetch = async (_url, init) => { calls.push(init!.method!); return Response.json(init?.method === "DELETE" ? { deleted: true } : { invalid: true }); };
  const result = await parseLearningPdf(repo, pageId, materialId, input(), { config, fetch: transport });
  expect(result.document.status).toBe("failed");
  expect(result.progress.map(p => p.status)).toEqual(["failed", "pending", "pending"]);
  expect(repo.database.prepare("SELECT response_json FROM learning_pdf_requests WHERE document_id=? AND physical_page=1").get(result.document.id)).toEqual({ response_json: JSON.stringify({ invalid: true }) });
  expect(calls).toEqual(["POST", "DELETE"]);
});
it("keeps network outcome unknown and never replays the request or allows an unsafe resume", async () => {
  const transport = vi.fn(async () => { throw new Error("SYNTHETIC transport timeout"); }), request = input();
  const result = await parseLearningPdf(repo, pageId, materialId, request, { config, fetch: transport });
  expect(result.progress.map(p => p.status)).toEqual(["unknown", "pending", "pending"]);
  await parseLearningPdf(repo, pageId, materialId, request, { config, fetch: transport });
  await expect(parseLearningPdf(repo, pageId, materialId, { ...input(), resumeFrom: request.id }, { config, fetch: transport })).rejects.toThrow("pdf_parser_outcome_unknown");
  expect(transport).toHaveBeenCalledTimes(1);
});
it("fences deletion before checkpoint publication and never restores a late response", async () => {
  const transport: typeof fetch = async (_url, init) => { if (init?.method === "POST") repo.deleteMaterial(pageId, materialId); return Response.json({}); };
  await expect(parseLearningPdf(repo, pageId, materialId, input(), { config, fetch: transport })).rejects.toThrow("material_deleted");
  expect(repo.database.prepare("SELECT count(*) n FROM learning_pdf_requests").get()).toEqual({ n: 0 });
  expect(repo.get(pageId).materialCount).toBe(0);
});

function largePdf(pageCount = 31) {
  const largeBytes = syntheticLearningPdf({ pages: pageCount }), id = randomUUID();
  const pdf: LearningPdfMetadata = { ...metadata, sha256: createHash("sha256").update(largeBytes).digest("hex"), pageCount,
    pages: Array.from({ length: pageCount }, (_, i) => ({ ...metadata.pages[0], physicalPage: i + 1 })) };
  repo.saveMaterials(pageId, [{ id, title: "SYNTHETIC LARGE", kind: "pdf", filename: "synthetic-large.pdf", bytes: largeBytes, pdf }]);
  return id;
}
it("automatically completes 31 pages in order using one document and one-page service requests; replay makes no requests", async () => {
  const large = largePdf(), request = { id: randomUUID() }, posts: number[] = [], cleanups: string[] = [];
  let active = 0, peak = 0;
  const transport: typeof fetch = async (url, init) => {
    if (init?.method === "DELETE") { cleanups.push(String(url)); return Response.json({ deleted: true }); }
    active++; peak = Math.max(peak, active);
    const body = JSON.parse(init!.body as string);
    expect(body.document_id).toBe(large);
    expect(body.page_range.start).toBe(body.page_range.end);
    expect(body.page_range.start).toBeGreaterThanOrEqual(1);
    expect(body.page_range.end).toBeLessThanOrEqual(31);
    expect(body.request_id).toBe(`${request.id}_${body.page_range.start}`);
    posts.push(body.page_range.start);
    await Promise.resolve(); active--;
    return Response.json({});
  };
  const result = await parseLearningPdfAutomatically(repo, pageId, large, request, { config, fetch: transport });
  expect(posts).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
  expect(peak).toBe(1); expect(cleanups).toHaveLength(31);
  expect(result.document.coverage).toMatchObject({ whole_document_processed: true, failed_pages: [] });
  expect(result.progress).toHaveLength(31);
  expect(result.progress.every(p => p.status === "completed")).toBe(true);
  await parseLearningPdfAutomatically(repo, pageId, large, request, { config, fetch: transport });
  expect(posts).toHaveLength(31); expect(cleanups).toHaveLength(31);
  expect(repo.listParsedDocuments(pageId, large)).toHaveLength(1);
});
it("stops a 31-page automatic run at its first known failure and explicitly resumes only failed or unattempted pages", async () => {
  const large = largePdf(), posts: number[] = []; let failing = true;
  const transport: typeof fetch = async (_url, init) => {
    if (init?.method === "DELETE") return Response.json({ deleted: true });
    const body = JSON.parse(init!.body as string), page = body.page_range.start;
    expect(body.page_range.end).toBe(page); posts.push(page);
    return page === 19 && failing ? Response.json({ request_id: body.request_id, status: "failed" }, { status: 503 }) : Response.json({});
  };
  const first = await parseLearningPdfAutomatically(repo, pageId, large, { id: randomUUID() }, { config, fetch: transport });
  expect(posts).toHaveLength(19);
  expect(first.progress.filter(p => p.status === "completed")).toHaveLength(18);
  expect(first.progress.filter(p => p.status === "failed").map(p => p.physical_page)).toEqual([19]);
  expect(first.progress.filter(p => p.status === "pending").map(p => p.physical_page)).toEqual(Array.from({ length: 12 }, (_, i) => i + 20));
  await parseLearningPdfAutomatically(repo, pageId, large, { id: first.document.id }, { config, fetch: transport });
  expect(posts).toHaveLength(19);
  failing = false;
  const second = await parseLearningPdfAutomatically(repo, pageId, large, { id: randomUUID(), resumeFrom: first.document.id }, { config, fetch: transport });
  expect(posts).toEqual([...Array.from({ length: 19 }, (_, i) => i + 1), ...Array.from({ length: 13 }, (_, i) => i + 19)]);
  expect(second.document.coverage?.whole_document_processed).toBe(true);
  expect(pdfParseProgress(repo, pageId, first.document.id).filter(p => p.status === "pending")).toHaveLength(12);
});
it("accepts the advanced UI's explicit full-range resume after an automatic 31-page failure", async () => {
  const large = largePdf(), posts: number[] = []; let failing = true;
  const transport: typeof fetch = async (_url, init) => {
    if (init?.method === "DELETE") return Response.json({ deleted: true });
    const body = JSON.parse(init!.body as string), physical = body.page_range.start;
    expect(body.page_range.end).toBe(physical); posts.push(physical);
    return physical === 19 && failing ? Response.json({ request_id: body.request_id, status: "failed" }, { status: 503 }) : Response.json({});
  };
  const first = await parseLearningPdfAutomatically(repo, pageId, large, { id: randomUUID() }, { config, fetch: transport });
  failing = false;
  // This is exactly the request shape produced by LearningPdfStudy.parse(true).
  const uiRequest = { id: randomUUID(), physicalPages: first.document.requestedPages!, resumeFrom: first.document.id };
  const resumed = await parseLearningPdf(repo, pageId, large, uiRequest, { config, fetch: transport });
  expect(resumed.document.coverage?.whole_document_processed).toBe(true);
  expect(posts).toEqual([...Array.from({ length: 19 }, (_, i) => i + 1), ...Array.from({ length: 13 }, (_, i) => i + 19)]);
  await parseLearningPdf(repo, pageId, large, uiRequest, { config, fetch: transport });
  expect(posts).toHaveLength(32);
  expect(pdfParseProgress(repo, pageId, first.document.id).filter(p => p.status === "pending")).toHaveLength(12);
});
it("rejects forged, expanded, reduced, foreign and receipt-free public resumes without submitting work", async () => {
  const large = largePdf(32);
  const failure: typeof fetch = async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    return Response.json({ request_id: body.request_id, status: "failed" }, { status: 503 });
  };
  const first = await parseLearningPdfAutomatically(repo, pageId, large, { id: randomUUID() }, { config, fetch: failure });
  const transport = vi.fn(async () => Response.json({})), base = { id: randomUUID(), resumeFrom: first.document.id, physicalPages: first.document.requestedPages! };
  await expect(parseLearningPdf(repo, pageId, large, { ...base, resumeFrom: randomUUID() }, { config, fetch: transport })).rejects.toThrow("parsed_document_not_found");
  await expect(parseLearningPdf(repo, pageId, large, { ...base, physicalPages: [...base.physicalPages, 33] }, { config, fetch: transport })).rejects.toThrow("source_changed");
  await expect(parseLearningPdf(repo, pageId, large, { ...base, physicalPages: base.physicalPages.slice(1) }, { config, fetch: transport })).rejects.toThrow("source_changed");
  await expect(parseLearningPdf(repo, pageId, materialId, base, { config, fetch: transport })).rejects.toThrow("source_changed");
  const original = repo.pdfOriginal(pageId, large, false).material.pdf!;
  const unstarted = repo.createParsedDocument(pageId, { id: randomUUID(), materialId: large, originalSha256: original.sha256, originalVersion: 1,
    requestedPages: base.physicalPages, parser: { name: "PaddleOCR", version: "ocr-pdf-trial-0.1" } });
  repo.failParsedDocument(pageId, unstarted.id, "parser_error");
  await expect(parseLearningPdf(repo, pageId, large, { ...base, resumeFrom: unstarted.id }, { config, fetch: transport })).rejects.toThrow("source_changed");
  expect(transport).not.toHaveBeenCalled();
  expect(repo.listParsedDocuments(pageId, large)).toHaveLength(2);
});
it("does not replay an unknown outcome in a 31-page automatic run, including a new resume id", async () => {
  const large = largePdf(), request = { id: randomUUID() }, posts: number[] = [];
  const transport: typeof fetch = async (_url, init) => {
    if (init?.method === "DELETE") return Response.json({ deleted: true });
    const body = JSON.parse(init!.body as string), page = body.page_range.start; posts.push(page);
    if (page === 2) throw new Error("SYNTHETIC unknown transport result");
    return Response.json({});
  };
  const first = await parseLearningPdfAutomatically(repo, pageId, large, request, { config, fetch: transport });
  expect(first.progress[1].status).toBe("unknown");
  expect(first.progress.filter(p => p.status === "pending")).toHaveLength(29);
  await parseLearningPdfAutomatically(repo, pageId, large, request, { config, fetch: transport });
  await expect(parseLearningPdfAutomatically(repo, pageId, large, { id: randomUUID(), resumeFrom: request.id }, { config, fetch: transport })).rejects.toThrow("pdf_parser_outcome_unknown");
  await expect(parseLearningPdf(repo, pageId, large, { id: randomUUID(), physicalPages: first.document.requestedPages!, resumeFrom: request.id }, { config, fetch: transport })).rejects.toThrow("pdf_parser_outcome_unknown");
  expect(posts).toEqual([1, 2]); expect(repo.listParsedDocuments(pageId, large)).toHaveLength(1);
});
it("keeps public parsing capped at 30 pages and automatic scope limited to the authorized original", async () => {
  const large = largePdf(), transport = vi.fn(async () => Response.json({}));
  await expect(parseLearningPdf(repo, pageId, large, { id: randomUUID(), physicalPages: Array.from({ length: 31 }, (_, i) => i + 1) }, { config, fetch: transport })).rejects.toThrow();
  await expect(parseLearningPdfAutomatically(repo, pageId, large, { id: randomUUID(), physicalPages: [1] }, { config, fetch: transport })).rejects.toThrow();
  const other = new LearningRepository(root, "synthetic-other");
  try { await expect(parseLearningPdfAutomatically(other, pageId, large, { id: randomUUID() }, { config, fetch: transport })).rejects.toThrow("page_not_found"); } finally { other.close(); }
  repo.deleteMaterial(pageId, large);
  await expect(parseLearningPdfAutomatically(repo, pageId, large, { id: randomUUID() }, { config, fetch: transport })).rejects.toThrow("material_deleted");
  expect(transport).not.toHaveBeenCalled();
});
