// @vitest-environment node
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterEach, it, expect, vi } from "vitest";
import { LearningFrameworkRepository } from "./framework-repository";
import { LearningQuizRepository } from "./quiz-repository";
import { LearningRepository } from "./repository";
import { inspectLearningPdf } from "./pdf-inspect";
import { parseLearningPdf, pdfParseProgress, pdfParserConfig } from "./pdf-parser-service";
import { adaptPaddleServiceResponse } from "./paddle-parsed-adapter";

// Actual delivered HTTP evidence, replayed offline. NOT a new HTTP/OCR success.
const base="C:/Codex/learning-ocr-handoff/20260921-171314/examples/success";
const bytes=readFileSync(join(base,"source.pdf"));
const delivered=JSON.parse(readFileSync(join(base,"response.json"),"utf8"));
let metadata:Awaited<ReturnType<typeof inspectLearningPdf>>;
beforeAll(async()=>{metadata=await inspectLearningPdf(bytes);},30000);
let root:string,repo:LearningRepository,page:string,material:string;
const config={url:"http://127.0.0.1:12345",token:"SYNTHETIC_NOT_A_KEY",findings:[]};
beforeEach(async()=>{root=mkdtempSync(join(tmpdir(),"learning-real-handoff-replay-"));repo=new LearningRepository(root,"isolated-a");page=randomUUID();material=randomUUID();repo.create({id:page,title:"OFFLINE HANDOFF REPLAY"});
  const pdf=metadata;repo.saveMaterials(page,[{id:material,title:"Delivered public PDF",kind:"pdf",filename:"source.pdf",bytes,pdf}]);});
afterEach(()=>{repo.close();rmSync(root,{recursive:true,force:true});});
function transport(edit?:(v:any)=>void){return vi.fn(async(_url:unknown,init?:RequestInit)=>{if(init?.method==="DELETE")return Response.json({deleted:true});const request=JSON.parse(init!.body as string),v=structuredClone(delivered);v.request_id=request.request_id;v.document.document_id=material;edit?.(v);return Response.json(v);}) as unknown as typeof fetch;}
async function parse(deps:Parameters<typeof parseLearningPdf>[4]={config,fetch:transport()}){return parseLearningPdf(repo,page,material,{id:randomUUID(),physicalPages:[17]},deps);}
function select(doc:any,excluded:string[]=[]){return repo.selectPdfStudy(page,material,{documentId:doc.id,physicalPages:[17],excludedBlockIds:excluded,acknowledgeUnverified:true,acknowledgeWarnings:true},repo.get(page).revision);}
it("reads actual original, maps original physical 17/index16, stores nine blocks and all rendered regions; never verifies",async()=>{const r=await parse();expect(r.document.status).toBe("completed");expect(r.document.pages![0].blocks).toHaveLength(9);
  expect(r.document.coverage).toMatchObject({succeeded_pages:[17],whole_document_processed:false});expect(r.document.pages![0].parser_page_index).toBe(16);
  r.document.pages![0].blocks.forEach((b,i)=>{expect(b.content.raw).toBe(delivered.pages[0].blocks[i].raw_content);expect(b.source_regions).toHaveLength(delivered.pages[0].blocks[i].sources.length);expect(b.quality.status).not.toBe("verified");});
  const b=r.document.pages![0].blocks[0],s=repo.parsedBlockSource(page,r.document.id,b.id);expect(s.state).toBe("available");if(s.state==="available")expect(s.source.source_regions[0].normalized_bbox).toEqual(b.source_regions[0].bbox.map((n,i)=>n/(i%2?810:1440)));
  repo.close();repo=new LearningRepository(root,"isolated-a");expect(repo.getParsedDocument(page,r.document.id)).toEqual(r.document);
});
it("requires explicit blank-image exclusion and records incomplete scope; historical references survive scope/version changes",async()=>{const {document:d}=await parse();expect(()=>select(d)).toThrow("pdf_scope_missing_content");const excluded=d.pages![0].blocks.filter(b=>!b.content.normalized?.trim()).map(b=>b.id);select(d,excluded);
  const source=repo.source(page,material);expect(source.paragraphs).toHaveLength(8);expect(source.scopeNotice).toMatchObject({excludedBlockIds:excluded,contentVerified:false});const binding=source.paragraphs[0].parsed!;
  const newer=await parse();select(newer.document,newer.document.pages![0].blocks.filter(b=>!b.content.normalized?.trim()).map(b=>b.id));expect(repo.source(page,material,binding).paragraphs[0].parsed).toEqual(binding);
});
it("does not let block exclusions bypass page-level known negative evidence",async()=>{const finding={originalSha256:delivered.document.sha256,physicalPage:17,serviceVersion:"ocr-pdf-trial-0.1",model:delivered.parser.model,code:"SYNTHETIC_NEGATIVE_SCOPE",message:"SYNTHETIC page omission",evidenceRef:"synthetic-only",severity:"blocked" as const};
  const {document:d}=await parse({config:{...config,findings:[finding]},fetch:transport()});expect(repo.inspectParsedScope(page,d.id).conditions.has_blocked).toBe(true);expect(()=>select(d,d.pages![0].blocks.map(b=>b.id))).toThrow("pdf_scope_blocked");
});
it("guards duplicate submission and never retries unknown network outcome",async()=>{const f=vi.fn(async()=>{throw new Error("SYNTHETIC timeout");}),input={id:randomUUID(),physicalPages:[17]};const r=await parseLearningPdf(repo,page,material,input,{config,fetch:f});expect(r.document.status).toBe("failed");
  await parseLearningPdf(repo,page,material,input,{config,fetch:f});expect(f).toHaveBeenCalledTimes(1);expect(pdfParseProgress(repo,page,input.id)[0].status).toBe("unknown");
  await expect(parseLearningPdf(repo,page,material,{...input,id:randomUUID(),resumeFrom:input.id},{config,fetch:f})).rejects.toThrow("pdf_parser_outcome_unknown");
});
it("rejects altered physical index/identity without publishing fake content",async()=>{const r=await parse({config,fetch:transport(v=>v.pages[0].page_index=0)});expect(r.document.status).toBe("failed");expect(repo.pdfOriginal(page,material).bytes!.equals(bytes)).toBe(true);});
it("rejects cross-account and clears raw checkpoints on material delete; late response cannot restore",async()=>{const other=new LearningRepository(root,"isolated-b");try{expect(()=>other.get(page)).toThrow();}finally{other.close();}
  const f=transport();const {document:d}=await parse({config,fetch:f});repo.deleteMaterial(page,material);expect(repo.getParsedDocument(page,d.id).sourceState).toBe("source_deleted");expect(repo.database.prepare("SELECT count(*) n FROM learning_pdf_requests").get()).toEqual({n:0});
});
it("fences a response that arrives after deletion",async()=>{const f=transport();const wrapped:typeof fetch=async(u,i)=>{repo.deleteMaterial(page,material);return f(u,i);};await expect(parse({config,fetch:wrapped})).rejects.toThrow("material_deleted");expect(repo.database.prepare("SELECT count(*) n FROM learning_pdf_requests").get()).toEqual({n:0});});
it("requires explicit server configuration and rejects insecure non-loopback endpoints without echoing credentials",()=>{
  expect(()=>pdfParserConfig({})).toThrow("pdf_parser_not_configured");
  for(const url of ["http://example.com","http://10.0.0.8","not a url","https://name:SYNTHETIC_SECRET@example.com","https://example.com/internal/../ocr","https://example.com/?token=secret","https://example.com/#private"])
    expect(()=>pdfParserConfig({LEARNING_PDF_SERVICE_URL:url,LEARNING_PDF_SERVICE_TOKEN:"SYNTHETIC"})).toThrow("pdf_parser_config_invalid");
});
it("requires a paired validated epoch and instance for protected request recovery while preserving legacy parse configuration",()=>{
  const findings=join(root,"synthetic-findings.json");writeFileSync(findings,"[]");
  const env={LEARNING_PDF_SERVICE_URL:config.url,LEARNING_PDF_SERVICE_TOKEN:config.token,LEARNING_PDF_KNOWN_FINDINGS_FILE:findings};
  expect(pdfParserConfig(env).serviceEpoch).toBeUndefined();
  expect(()=>pdfParserConfig({...env,LEARNING_PDF_SERVICE_EPOCH:"a".repeat(64)})).toThrow("pdf_parser_config_invalid");
  expect(()=>pdfParserConfig({...env,LEARNING_PDF_SERVICE_EPOCH:"short",LEARNING_PDF_SERVICE_INSTANCE:"session-1"})).toThrow("pdf_parser_config_invalid");
  expect(()=>pdfParserConfig({...env,LEARNING_PDF_SERVICE_EPOCH:"a".repeat(64),LEARNING_PDF_SERVICE_INSTANCE:"session-0"})).toThrow("pdf_parser_config_invalid");
  expect(pdfParserConfig({...env,LEARNING_PDF_SERVICE_EPOCH:"a".repeat(64),LEARNING_PDF_SERVICE_INSTANCE:"session-2"})).toMatchObject({serviceEpoch:"a".repeat(64),instance:"session-2"});
});
it("keeps completed page checkpoints and explicit resume processes only failed pages",async()=>{
  const posts:number[]=[];let failing=true;
  const f:typeof fetch=async(_u,i)=>{if(i?.method==="DELETE")return Response.json({deleted:true});const req=JSON.parse(i!.body as string),p=req.page_range.start;posts.push(p);
    if(p===18&&failing)return Response.json({request_id:req.request_id,status:"failed"},{status:503});
    // SYNTHETIC second-page mapping: validates mechanics, not actual page18 OCR.
    const v=structuredClone(delivered);v.request_id=req.request_id;v.document.document_id=material;v.document.selected_physical_pages=[p];const page=v.pages[0];page.physical_page=p;page.page_index=p-1;page.pdf_geometry.physical_page=p;for(const b of page.blocks)for(const s of b.sources)s.physical_page=p;return Response.json(v);
  };
  const first=await parseLearningPdf(repo,page,material,{id:randomUUID(),physicalPages:[17,18]},{config,fetch:f});expect(first.document.coverage).toMatchObject({succeeded_pages:[17],failed_pages:[18],whole_document_processed:false});
  expect(repo.inspectParsedScope(page,first.document.id,[18]).conditions.has_blocked).toBe(true);failing=false;
  const second=await parseLearningPdf(repo,page,material,{id:randomUUID(),physicalPages:[17,18],resumeFrom:first.document.id},{config,fetch:f});expect(second.document.coverage?.succeeded_pages).toEqual([17,18]);expect(posts).toEqual([17,18,18]);expect(repo.getParsedDocument(page,first.document.id).coverage?.failed_pages).toEqual([18]);
  repo.deletePage(page);expect(repo.database.prepare("SELECT count(*) n FROM learning_pdf_requests").get()).toEqual({n:0});
});
it("maps untouched delivered BERTology response and accepts float32 box precision only",async()=>{
  const input=JSON.parse(readFileSync('C:/Codex/learning-ocr-handoff/20260921-171314/examples/quality/dc02-png-response.json','utf8'));
  const originalBytes=readFileSync('C:/Codex/learning-parsed-handoff/20260920-115054/round4-real-teaching-20260918/sources/bertology.pdf');const original=await inspectLearningPdf(originalBytes),id=randomUUID();
  repo.saveMaterials(page,[{id,title:'Delivered BERTology offline',kind:'pdf',filename:'bertology.pdf',bytes:originalBytes,pdf:original}]);const d=repo.createParsedDocument(page,{id:randomUUID(),materialId:id,originalSha256:original.sha256,originalVersion:1,requestedPages:[2],parser:{name:'PaddleOCR',version:'ocr-pdf-trial-0.1'}});repo.startParsedDocument(page,d.id);
  const binding={attempt:d,original,requestId:input.request_id,upstreamDocumentId:input.document.document_id,physicalPages:[2]};
  const result=adaptPaddleServiceResponse(input,binding);const saved=repo.completeParsedDocument(page,d.id,result);expect(saved.parserRun?.upstream_document_id).toBe(input.document.document_id);expect(saved.pages![0].blocks.map(b=>b.content.raw)).toEqual(input.pages[0].blocks.map((b:any)=>b.raw_content));
  input.pages[0].pdf_geometry.cropbox_pt[2]+=0.01;expect(()=>adaptPaddleServiceResponse(input,binding)).toThrow('paddle_page_geometry_mismatch');
},30000);
it("cannot expose blocked pixels through a duplicate/merged unverified region",async()=>{
  const r=await parse({config,fetch:transport(v=>{const p=v.pages[0];p.blocks[0].quality.warnings=['formula_unverified'];p.blocks[1].bbox=[...p.blocks[0].bbox];p.blocks[1].sources[0].bbox=[...p.blocks[0].bbox];p.raw_paddle.prunedResult.parsing_res_list[1].block_bbox=[...p.blocks[0].bbox];})});
  const excluded=r.document.pages![0].blocks.filter((b,i)=>i===0||!b.content.normalized?.trim()).map(b=>b.id);expect(()=>select(r.document,excluded)).toThrow('pdf_scope_blocked');
});
it("changing active parsed version fences pending framework and quiz publication without changing old text",async()=>{
  const old=(await parse()).document;select(old,old.pages![0].blocks.filter(b=>!b.content.normalized?.trim()).map(b=>b.id));
  const f=new LearningFrameworkRepository(repo),q=new LearningQuizRepository(repo),fid=randomUUID(),qid=randomUUID();f.begin(page,{id:fid,materialIds:[material]},48000);q.begin(page,{id:qid,settings:{materialIds:[material],chapterIds:[],nodeIds:[],includeNotes:false,includeSupplements:false,count:1,difficulty:'basic'}},48000);
  const next=(await parse()).document;select(next,next.pages![0].blocks.filter(b=>!b.content.normalized?.trim()).map(b=>b.id));f.validating(page,fid);
  expect(()=>f.complete(page,fid,{overview:'SYNTHETIC',chapters:[{title:'SYNTHETIC',explanation:'SYNTHETIC',nodes:[{title:'SYNTHETIC',explanation:'SYNTHETIC',supplement:null,sources:[{materialId:material,paragraph:1}]}]}]})).toThrow('source_changed');
  expect(()=>q.complete(page,qid,{title:'SYNTHETIC',reason:null,items:[{stem:'SYNTHETIC',kind:'concept',options:[{id:'A',text:'A',reason:'A'},{id:'B',text:'B',reason:'B'}],correctOptionId:'A',explanation:'SYNTHETIC',hint:null,sources:[{kind:'material',materialId:material,paragraph:1}]}]})).toThrow('source_changed');
  expect(repo.getParsedDocument(page,old.id).pages![0].blocks.map(b=>b.content)).toEqual(old.pages![0].blocks.map(b=>b.content));
});

it("accepts administrator HTTPS origins with fresh discovery and no browser-owned endpoint",()=>{
  const findings=join(root,"https-findings.json");writeFileSync(findings,"[]");
  const value=pdfParserConfig({LEARNING_PDF_SERVICE_URL:"https://ocr.synthetic.invalid:9443",LEARNING_PDF_SERVICE_TOKEN:"SYNTHETIC",
    LEARNING_PDF_KNOWN_FINDINGS_FILE:findings});
  expect(value).toMatchObject({url:"https://ocr.synthetic.invalid:9443",discoverInstance:true});
  expect(value.serviceEpoch).toBeUndefined();
});
const directConfig={...config,url:"https://ocr.synthetic.invalid/internal/ocr",discoverInstance:true};
const directHealth=(epoch="a".repeat(64),instance="session-1")=>({service_version:"ocr-pdf-trial-0.1",resource_policy_version:"learning-ocr-resource-v1",ready:true,service_epoch:epoch,instance});
it("discovers a fresh server identity per new attempt, persists before POST and does not mutate old versions",async()=>{
  let epoch="a".repeat(64),instance="session-1",posts=0,healthReads=0;
  const request:typeof fetch=async(url,init)=>{
    expect(String(url).startsWith(directConfig.url+"/")).toBe(true);
    const suffix=String(url).slice(directConfig.url.length);
    expect(suffix).toMatch(/^\/(health|parse-pdf|results\/[a-zA-Z0-9_-]+)$/u);
    expect(init?.redirect).toBe("error");expect((init?.headers as Record<string,string>).Authorization).toBe("Bearer "+config.token);
    if(String(url).endsWith("/health")){healthReads++;return Response.json(directHealth(epoch,instance));}
    if(init?.method==="DELETE")return Response.json({deleted:true});
    posts++;const body=JSON.parse(init?.body as string);
    expect(body).toMatchObject({expected_service_epoch:epoch,expected_instance:instance});
    const row=repo.database.prepare("SELECT request_context_json FROM learning_pdf_requests WHERE request_id=?").get(body.request_id) as {request_context_json:string};
    expect(JSON.parse(row.request_context_json)).toMatchObject({serviceEpoch:epoch,instance});
    expect(init?.body).not.toContain(config.token);
    const value=structuredClone(delivered);Object.assign(value,{request_id:body.request_id,service_epoch:epoch,instance});value.document.document_id=material;
    return Response.json(value);
  };
  const first=await parse({config:directConfig,fetch:request});const saved=repo.getParsedDocument(page,first.document.id);
  epoch="b".repeat(64);instance="session-2";
  const next=await parse({config:{...directConfig,serviceEpoch:"a".repeat(64),instance:"session-1"},fetch:request});
  expect(next.document.status).toBe("completed");expect(posts).toBe(2);expect(healthReads).toBe(2);
  expect(repo.getParsedDocument(page,first.document.id)).toEqual(saved);
});
it.each(["not-ready","invalid-epoch","wrong-contract","oversized","network","redirect"])("does not upload a PDF when authenticated server health is %s",async(kind)=>{
  const request=vi.fn(async(_url:unknown,init?:RequestInit)=>{
    expect(init?.redirect).toBe("error");expect(init?.method??"GET").toBe("GET");
    if(kind==="network")throw Error("SYNTHETIC_UNEXPOSED_FAILURE");
    if(kind==="redirect")return new Response(null,{status:302,headers:{location:"https://other.synthetic.invalid"}});
    if(kind==="oversized")return Response.json({...directHealth(),extra:"x".repeat(70*1024)});
    return Response.json({...directHealth(),...kind==="not-ready"?{ready:false}:kind==="invalid-epoch"?{service_epoch:"bad"}:{service_version:"unknown"}});
  });
  await expect(parse({config:directConfig,fetch:request})).rejects.toThrow("pdf_parser_unavailable");
  expect(request).toHaveBeenCalledTimes(1);
  const attempts=repo.listParsedDocuments(page,material);expect(attempts).toHaveLength(1);expect(attempts[0].status).toBe("failed");
  expect(pdfParseProgress(repo,page,attempts[0].id).map(p=>p.status)).toEqual(["pending"]);
});
it("rejects mismatched success identity without deleting the server receipt or rebinding unknown work after restart",async()=>{
  let epoch="a".repeat(64),instance="session-1";const methods:string[]=[];
  const request:typeof fetch=async(url,init)=>{
    methods.push(init?.method??"GET");
    if(String(url).endsWith("/health"))return Response.json(directHealth(epoch,instance));
    const body=JSON.parse(init?.body as string),value=structuredClone(delivered);
    Object.assign(value,{request_id:body.request_id,service_epoch:"c".repeat(64),instance:"session-3"});value.document.document_id=material;
    return Response.json(value);
  };
  const first=await parse({config:directConfig,fetch:request});
  expect(first.document.status).toBe("failed");expect(first.progress[0].status).toBe("unknown");expect(methods).toEqual(["GET","POST"]);
  const before=repo.database.prepare("SELECT request_context_json FROM learning_pdf_requests WHERE document_id=?").get(first.document.id);
  epoch="b".repeat(64);instance="session-2";
  await expect(parseLearningPdf(repo,page,material,{id:randomUUID(),physicalPages:[17],resumeFrom:first.document.id},{config:directConfig,fetch:request})).rejects.toThrow("pdf_parser_outcome_unknown");
  expect(methods).toEqual(["GET","POST","GET"]);
  expect(repo.database.prepare("SELECT request_context_json FROM learning_pdf_requests WHERE document_id=?").get(first.document.id)).toEqual(before);
});

it("explicitly resumes a direct-server health failure without an unknown request or repeated processing",async()=>{
  let ready=false,posts=0;
  const request:typeof fetch=async(url,init)=>{
    if(String(url).endsWith("/health"))return Response.json({...directHealth(),ready});
    if(init?.method==="DELETE")return Response.json({deleted:true});
    posts++;const body=JSON.parse(init?.body as string),value=structuredClone(delivered);
    Object.assign(value,{request_id:body.request_id,service_epoch:"a".repeat(64),instance:"session-1"});value.document.document_id=material;return Response.json(value);
  };
  await expect(parse({config:directConfig,fetch:request})).rejects.toThrow("pdf_parser_unavailable");
  const first=repo.listParsedDocuments(page,material)[0];expect(posts).toBe(0);ready=true;
  const resumed=await parseLearningPdf(repo,page,material,{id:randomUUID(),physicalPages:[17],resumeFrom:first.id},{config:directConfig,fetch:request});
  expect(resumed.document.status).toBe("completed");expect(posts).toBe(1);expect(repo.getParsedDocument(page,first.id).status).toBe("failed");
});
