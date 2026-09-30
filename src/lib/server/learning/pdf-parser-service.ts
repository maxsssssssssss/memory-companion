import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LearningId, LEARNING_PDF_MAX_PAGES, LEARNING_PDF_PARSE_MAX_PAGES } from "@/lib/domain/learning";
import type { ParsedDocumentResult } from "@/lib/domain/learning-parsed-document";
import { adaptPaddleServiceResponse, type PaddleServiceFinding } from "./paddle-parsed-adapter";
import { LearningError, type LearningRepository } from "./repository";

export const ParsePdfRequest = z.object({ id:LearningId, physicalPages:z.array(z.number().int().positive().max(200)).min(1).max(LEARNING_PDF_PARSE_MAX_PAGES)
  .refine(p=>new Set(p).size===p.length), resumeFrom:LearningId.optional() }).strict();
const AutomaticPdfRequest = z.object({ id: LearningId, resumeFrom: LearningId.optional() }).strict();
const ResumeAutomaticPdfRequest = ParsePdfRequest.extend({
  physicalPages: z.array(z.number().int().positive().max(LEARNING_PDF_MAX_PAGES))
    .min(LEARNING_PDF_PARSE_MAX_PAGES + 1).max(LEARNING_PDF_MAX_PAGES).refine(p => new Set(p).size === p.length),
  resumeFrom: LearningId
});
type PdfParserDependencies = { fetch?: typeof fetch; config?: ReturnType<typeof pdfParserConfig>; resourceWaitMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> };
type Checkpoint = { physical_page:number; request_id:string; status:"pending"|"submitted"|"completed"|"failed"|"unknown"|"waiting_resource"; response_json:string|null; request_context_json:string|null };
type RequestContext = { instance?: string; serviceEpoch?: string; issue?:string; wait?: { reason:"resource_wait"|"busy"; retryAfterSeconds:number; retryAt:string; expiresAt:string } };
const safeIdentity = z.string().regex(/^[a-zA-Z0-9_.:-]{1,200}$/);
const serviceEpoch=z.string().regex(/^[a-f0-9]{64}$/),serviceInstance=z.string().regex(/^session-[1-9][0-9]*$/);
const NotAccepted = z.object({ request_id: safeIdentity, status:z.literal("not_accepted"),accepted:z.literal(false),reason:z.enum(["resource_wait","busy","instance_changed","budget_exhausted","session_expired"]),
  retry_after_seconds:z.number().int().min(1).max(300).optional(),instance:serviceInstance,service_epoch:serviceEpoch,document_id:LearningId,
  sha256:z.string().regex(/^[a-f0-9]{64}$/),pages:z.array(z.number().int().positive()).length(1) });
const contextOf = (row: Pick<Checkpoint,"request_context_json">): RequestContext => row.request_context_json ? JSON.parse(row.request_context_json) as RequestContext : {};
const PDF_LEASE_MS = 45_000;
const Finding = z.object({originalSha256:z.string().regex(/^[a-f0-9]{64}$/u),physicalPage:z.number().int().positive(),serviceVersion:z.literal("ocr-pdf-trial-0.1"),
  model:z.string().min(1),code:z.string().min(1).max(500),message:z.string().min(1).max(500),evidenceRef:z.string().min(1).max(500),severity:z.enum(["warning","blocked"])}).strict();
export function pdfParserConfig(env:Readonly<Record<string,string|undefined>>=process.env) {
  let endpoint=env.LEARNING_PDF_SERVICE_URL,token=env.LEARNING_PDF_SERVICE_TOKEN;
  const connectionFile=env.LEARNING_PDF_SERVICE_CONFIG_FILE,tokenFile=env.LEARNING_PDF_SERVICE_TOKEN_FILE;
  const readConfigFile=(file:string,maxBytes:number)=>{
    if(!isAbsolute(file))throw new Error("absolute_path_required");
    const fd=openSync(file,"r");
    try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size>maxBytes)throw new Error("invalid_file");
      const bytes=readFileSync(fd);if(bytes.length>maxBytes)throw new Error("invalid_file");return bytes.toString("utf8");
    }finally{closeSync(fd);}
  };
  try{
    if(connectionFile){
      // One connection authority: never pair one host with another config's key.
      if(endpoint||token||tokenFile)throw new Error("mixed_connection_configuration");
      const client=z.object({base_url:z.string().min(1),authentication:z.literal("Bearer"),token_file:z.string().min(1),
        tls_verify:z.literal(true),automatic_request_retries:z.literal(0),instance_binding_required:z.literal(true)}).strict()
        .parse(JSON.parse(readConfigFile(connectionFile,16*1024)));
      endpoint=client.base_url;token=readConfigFile(client.token_file,4096).trim();
      if(!endpoint.startsWith("https://"))throw new Error("https_required");
    }else if(tokenFile){if(token)throw new Error("mixed_token_configuration");token=readConfigFile(tokenFile,4096).trim();}
  }catch{throw new LearningError(503,"pdf_parser_config_invalid");}
  if(!endpoint||!token)throw new LearningError(503,"pdf_parser_not_configured");
  // Reject invalid header bytes before any page can be marked submitted.
  if(token.length>4096||!/^[\x21-\x7e]+$/u.test(token))throw new LearningError(503,"pdf_parser_config_invalid");
  let url:URL;
  try{url=new URL(endpoint);}catch{throw new LearningError(503,"pdf_parser_config_invalid");}
  // Administrator-owned server configuration only. HTTPS supports direct
  // application-server -> OCR-server traffic; loopback HTTP is local compatibility.
  // Validate the raw path before URL can normalize dot segments or backslashes.
  const rawMatch=/^https?:\/\/[^/?#\\]+(\/[^?#\\]*)?$/u.exec(endpoint);
  const rawPath=rawMatch?(rawMatch[1]??"/"):null;
  const prefix=rawPath?.replace(/\/$/u,"");
  const segments=prefix?prefix.slice(1).split("/"):[];
  if(!(url.protocol==="https:"||(url.protocol==="http:"&&url.hostname==="127.0.0.1"))
    ||url.username||url.password||url.search||url.hash||rawPath===null
    ||segments.some(s=>!s||s==="."||s===".."||!/^[a-zA-Z0-9._~-]+$/u.test(s)))throw new LearningError(503,"pdf_parser_config_invalid");
  let findings:PaddleServiceFinding[]=[];
  if(!env.LEARNING_PDF_KNOWN_FINDINGS_FILE)throw new LearningError(503,"pdf_parser_findings_invalid");
  if(env.LEARNING_PDF_KNOWN_FINDINGS_FILE) {
    try { const bytes=readFileSync(env.LEARNING_PDF_KNOWN_FINDINGS_FILE);if(bytes.length>256*1024)throw new Error();findings=z.array(Finding).max(500).parse(JSON.parse(bytes.toString("utf8"))); }
    catch { throw new LearningError(503,"pdf_parser_findings_invalid"); }
  }
  const epoch=env.LEARNING_PDF_SERVICE_EPOCH,instance=env.LEARNING_PDF_SERVICE_INSTANCE;
  if ((epoch||instance) && (!serviceEpoch.safeParse(epoch).success||!serviceInstance.safeParse(instance).success)) throw new LearningError(503,"pdf_parser_config_invalid");
  return {url:url.origin+(prefix??""),token,findings,...epoch&&instance?{serviceEpoch:epoch,instance}:{},...url.protocol==="https:"?{discoverInstance:true}:{}};
}
export function pdfParseProgress(repo:LearningRepository,pageId:string,documentId:string) {
  repo.getParsedDocument(pageId,documentId);
  return (repo.database.prepare("SELECT physical_page,request_id,status,request_context_json FROM learning_pdf_requests WHERE document_id=? ORDER BY physical_page").all(documentId) as Checkpoint[])
    .map(row=>({physical_page:row.physical_page,request_id:row.request_id,status:row.status,...row.status==="waiting_resource"&&contextOf(row).wait?{wait:contextOf(row).wait}:{},...contextOf(row).issue?{issue:contextOf(row).issue}:{}}));
}
/** New public/manual requests retain the thirty-page selection limit. An
 * explicit resume may reuse a persisted full automatic range, never enlarge it. */
export async function parseLearningPdf(repo:LearningRepository,pageId:string,materialId:string,input:unknown,
  dependencies:PdfParserDependencies={}) {
  const manual=ParsePdfRequest.safeParse(input);
  if(manual.success)return parseLearningPdfPages(repo,pageId,materialId,manual.data,dependencies);
  const resume=ResumeAutomaticPdfRequest.safeParse(input);
  if(!resume.success)throw manual.error;
  const value=resume.data, pages=[...value.physicalPages].sort((a,b)=>a-b);
  const original=repo.pdfOriginal(pageId,materialId,false).material.pdf!;
  const prior=repo.getParsedDocument(pageId,value.resumeFrom);
  if(prior.materialId!==materialId||prior.originalSha256!==original.sha256||prior.originalVersion!==original.originalVersion
    ||prior.parser.name!=="PaddleOCR"||prior.parser.version!=="ocr-pdf-trial-0.1"
    ||!["completed","failed","processing"].includes(prior.status)||pages.length!==original.pageCount||pages.some((p,i)=>p!==i+1)
    ||JSON.stringify(prior.requestedPages)!==JSON.stringify(pages))throw new LearningError(409,"source_changed");
  // Imported output or an unstarted reservation is not authorization to submit
  // a larger public job. Every member of this range must already have a receipt.
  const progress=pdfParseProgress(repo,pageId,prior.id);
  if(progress.length!==pages.length||progress.some((p,i)=>p.physical_page!==pages[i]))throw new LearningError(409,"source_changed");
  return parseLearningPdfPages(repo,pageId,materialId,value,dependencies);
}
/** Upload coordination only: select the full bounded original, using the same
 * sequential one-page HTTP requests and durable claims as the manual path.
 * This does not enlarge a service request, retry a failure or start a service. */
export async function parseLearningPdfAutomatically(repo:LearningRepository,pageId:string,materialId:string,input:unknown,
  dependencies:PdfParserDependencies={}) {
  const value=AutomaticPdfRequest.parse(input);
  const original=repo.pdfOriginal(pageId,materialId,false);
  const pageCount=z.number().int().positive().max(LEARNING_PDF_MAX_PAGES).parse(original.material.pdf!.pageCount);
  return parseLearningPdfPages(repo,pageId,materialId,{...value,physicalPages:Array.from({length:pageCount},(_,i)=>i+1)},dependencies);
}
async function boundedParserJson(response: Response,maxBytes=8*1024*1024): Promise<unknown> {
  const reader=response.body?.getReader();if(!reader)throw new Error("empty_response");
  let length=0;const chunks:Uint8Array[]=[];
  try {while(true){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>maxBytes){await reader.cancel();throw new Error("oversized_response");}chunks.push(next.value);}}finally{reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
/** Resolve fresh identity only for direct server connections. No material is
 * uploaded here; an unhealthy/invalid gateway never authorizes a parse request. */
async function resolvePdfParserInstance(config:ReturnType<typeof pdfParserConfig>,transport:typeof fetch) {
  try{
    const response=await transport(`${config.url}/health`,{headers:{Authorization:`Bearer ${config.token}`},
      redirect:"error",cache:"no-store",signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw new Error("health_unavailable");
    const health=z.object({service_version:z.literal("ocr-pdf-trial-0.1"),resource_policy_version:z.literal("learning-ocr-resource-v1"),
      ready:z.literal(true),service_epoch:serviceEpoch,instance:serviceInstance}).parse(await boundedParserJson(response,64*1024));
    return {...config,serviceEpoch:health.service_epoch,instance:health.instance};
  }catch{throw new LearningError(503,"pdf_parser_unavailable");}
}
/** Explicit resume only. Query an already submitted request under its persisted
 * service epoch; a missing, changed or unfinished result never authorizes POST. */
async function recoverPdfRequests(repo:LearningRepository,pageId:string,materialId:string,documentId:string,rows:Checkpoint[],
  config:ReturnType<typeof pdfParserConfig>,transport:typeof fetch,now:()=>number) {
  const unresolved=rows.filter(r=>r.status==="submitted"||r.status==="unknown");
  if(unresolved.some(r=>{const c=contextOf(r);return !c.serviceEpoch||!c.instance||c.serviceEpoch!==config.serviceEpoch||c.instance!==config.instance;}))return false;
  const token=randomUUID(),claimed=repo.database.prepare("UPDATE learning_parsed_documents SET pdf_execution_token=?,pdf_execution_lease_until=? WHERE id=? AND page_id=? AND invalidated_at IS NULL AND pdf_execution_lease_until<=?")
    .run(token,now()+PDF_LEASE_MS,documentId,pageId,now()).changes;
  if(!claimed)return false;
  const original=repo.pdfOriginal(pageId,materialId,false).material.pdf!, attempt=repo.getParsedDocument(pageId,documentId);
  const assertCurrent=()=>{
    repo.pdfOriginal(pageId,materialId,false);
    const active=repo.database.prepare("SELECT pdf_execution_token,pdf_execution_lease_until FROM learning_parsed_documents WHERE id=?").get(documentId) as {pdf_execution_token:string|null;pdf_execution_lease_until:number};
    if(active?.pdf_execution_token!==token||active.pdf_execution_lease_until<=now()||repo.listParsedDocuments(pageId,materialId).at(-1)?.id!==documentId)throw new LearningError(409,"source_changed");
    repo.database.prepare("UPDATE learning_parsed_documents SET pdf_execution_lease_until=? WHERE id=? AND pdf_execution_token=?").run(now()+PDF_LEASE_MS,documentId,token);
  };
  try {
    for(const row of unresolved){
      assertCurrent();
      const init={headers:{Authorization:`Bearer ${config.token}`},redirect:"error" as const,cache:"no-store" as const,signal:AbortSignal.timeout(10_000)};
      let response:Response,status:unknown;
      try {response=await transport(`${config.url}/requests/${row.request_id}`,init);status=await boundedParserJson(response);}catch{return false;}
      const s=status as {request_id?:string;service_epoch?:string;instance?:string;document_id?:string;sha256?:string;pages?:number[];status?:string;publishable?:boolean};
      if(!response.ok||s.request_id!==row.request_id||s.service_epoch!==config.serviceEpoch||s.instance!==config.instance||s.document_id!==materialId
        ||s.sha256!==original.sha256||JSON.stringify(s.pages)!==JSON.stringify([row.physical_page])||s.status!=="completed"||s.publishable!==true)return false;
      let raw:unknown;
      try {const result=await transport(`${config.url}/requests/${row.request_id}/result`,{...init,signal:AbortSignal.timeout(10_000)});if(!result.ok)return false;raw=await boundedParserJson(result);}catch{return false;}
      const identity=raw as {request_id?:string;service_epoch?:string;instance?:string};
      if(identity.request_id!==row.request_id||identity.service_epoch!==config.serviceEpoch||identity.instance!==config.instance)return false;
      adaptPaddleServiceResponse(raw,{attempt,original,requestId:row.request_id,physicalPages:[row.physical_page],findings:config.findings});
      repo.database.transaction(()=>{assertCurrent();repo.database.prepare("UPDATE learning_pdf_requests SET status='completed',response_json=? WHERE document_id=? AND physical_page=? AND status IN ('submitted','unknown')")
        .run(JSON.stringify(raw),documentId,row.physical_page);}).immediate();
    }
    return true;
  }finally{repo.database.prepare("UPDATE learning_parsed_documents SET pdf_execution_token=NULL,pdf_execution_lease_until=0 WHERE id=? AND pdf_execution_token=?").run(documentId,token);}
}
/** One durable claim per physical page; a transport error is unknown, never a retry instruction. */
async function parseLearningPdfPages(repo:LearningRepository,pageId:string,materialId:string,value:z.infer<typeof ParsePdfRequest>,
  dependencies:PdfParserDependencies) {
  const original=repo.pdfOriginal(pageId,materialId);
  const configured=dependencies.config??pdfParserConfig(), transport=dependencies.fetch??fetch;
  const pages=[...value.physicalPages].sort((a,b)=>a-b);
  const now=dependencies.now??Date.now, sleep=dependencies.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
  const waitMs=dependencies.resourceWaitMs??10*60*1000;
  if(!Number.isFinite(waitMs)||waitMs<0||waitMs>10*60*1000)throw new LearningError(400,"invalid_input");
  const token=randomUUID();
  const old=repo.listParsedDocuments(pageId,materialId).find(d=>d.id===value.id);
  if(old) {
    if(JSON.stringify(old.requestedPages)!==JSON.stringify(pages))throw new LearningError(409,"submission_conflict");
    // Upload preparation reserves a pending attempt before returning. It can be
    // claimed once, including after a local process restart; submitted work is never replayed.
    const progress=pdfParseProgress(repo,pageId,old.id);
    if(old.status!=="pending"||progress.length) return {document:repo.getParsedDocument(pageId,old.id),progress};
  }
  // A fresh attempt first records pending pages, so a health failure remains
  // explicitly resumable without pretending any PDF was submitted.
  let config=value.resumeFrom&&configured.discoverInstance?await resolvePdfParserInstance(configured,transport):configured;
  let resume:Checkpoint[]=[];
  if(value.resumeFrom) {
    const prior=repo.getParsedDocument(pageId,value.resumeFrom);
    if(prior.materialId!==materialId||prior.originalSha256!==original.material.pdf!.sha256||JSON.stringify(prior.requestedPages)!==JSON.stringify(pages))throw new LearningError(409,"source_changed");
    if(repo.listParsedDocuments(pageId,materialId).at(-1)?.id!==prior.id)throw new LearningError(409,"source_changed");
    const live=repo.database.prepare("SELECT pdf_execution_lease_until FROM learning_parsed_documents WHERE id=?").get(prior.id) as {pdf_execution_lease_until:number};
    if(live.pdf_execution_lease_until>now())return {document:prior,progress:pdfParseProgress(repo,pageId,prior.id)};
    resume=repo.database.prepare("SELECT * FROM learning_pdf_requests WHERE document_id=?").all(prior.id) as Checkpoint[];
    if(resume.some(r=>r.status==="submitted"||r.status==="unknown")) {
      // A user explicitly continuing may query the original request. A status
      // read never creates a request, and 404 is not evidence of non-execution.
      const resolved=await recoverPdfRequests(repo,pageId,materialId,prior.id,resume,config,transport,now);
      if(!resolved)throw new LearningError(409,"pdf_parser_outcome_unknown");
      resume=repo.database.prepare("SELECT * FROM learning_pdf_requests WHERE document_id=?").all(prior.id) as Checkpoint[];
    }
  }
  const attempt=repo.database.transaction(()=>{
    const live=repo.database.prepare("SELECT id FROM learning_parsed_documents WHERE material_id=? AND pdf_execution_lease_until>?").get(materialId,now());
    if(live)throw new LearningError(409,"pdf_parser_busy");
    if(value.resumeFrom){
      // Another process may have resumed while the status/result HTTP query was
      // in flight. Re-read the authority under the write lock, never its snapshot.
      const prior=repo.getParsedDocument(pageId,value.resumeFrom), current=repo.pdfOriginal(pageId,materialId,false).material.pdf!;
      if(repo.listParsedDocuments(pageId,materialId).at(-1)?.id!==prior.id||prior.materialId!==materialId
        ||prior.originalSha256!==current.sha256||prior.originalVersion!==current.originalVersion
        ||JSON.stringify(prior.requestedPages)!==JSON.stringify(pages))throw new LearningError(409,"source_changed");
      resume=repo.database.prepare("SELECT * FROM learning_pdf_requests WHERE document_id=?").all(prior.id) as Checkpoint[];
    }
    const unresolved=repo.database.prepare("SELECT physical_page FROM learning_pdf_requests WHERE material_id=? AND status IN ('submitted','unknown')").all(materialId) as Array<{physical_page:number}>;
    if(unresolved.some(r=>pages.includes(r.physical_page)))throw new LearningError(409,"pdf_parser_outcome_unknown");
    const attempt=repo.createParsedDocument(pageId,{id:value.id,materialId,originalSha256:original.material.pdf!.sha256,originalVersion:1,requestedPages:pages,parser:{name:"PaddleOCR",version:"ocr-pdf-trial-0.1"}});
    for(const physical of pages){const saved=resume.find(r=>r.physical_page===physical&&["completed","waiting_resource"].includes(r.status));
      repo.database.prepare("INSERT INTO learning_pdf_requests(document_id,material_id,page_id,physical_page,request_id,status,response_json,request_context_json) VALUES(?,?,?,?,?,?,?,?)")
        .run(attempt.id,materialId,pageId,physical,saved?.request_id??`${attempt.id}_${physical}`,saved?.status??"pending",saved?.response_json??null,saved?.request_context_json??null);
    }
    const started=repo.startParsedDocument(pageId,attempt.id);
    repo.database.prepare("UPDATE learning_parsed_documents SET pdf_execution_token=?,pdf_execution_lease_until=? WHERE id=?").run(token,now()+PDF_LEASE_MS,attempt.id);
    return started;
  }).immediate();
  const assertOwner=()=>{
    repo.pdfOriginal(pageId,materialId,false);
    const row=repo.database.prepare("SELECT pdf_execution_token,pdf_execution_lease_until FROM learning_parsed_documents WHERE id=?").get(attempt.id) as {pdf_execution_token:string|null;pdf_execution_lease_until:number};
    if(row.pdf_execution_token!==token||row.pdf_execution_lease_until<=now())throw new LearningError(409,"pdf_parser_interrupted");
    if(repo.listParsedDocuments(pageId,materialId).at(-1)?.id!==attempt.id)throw new LearningError(409,"source_changed");
    if(!repo.database.prepare("UPDATE learning_parsed_documents SET pdf_execution_lease_until=? WHERE id=? AND pdf_execution_token=? AND pdf_execution_lease_until>?")
      .run(now()+PDF_LEASE_MS,attempt.id,token,now()).changes)throw new LearningError(409,"pdf_parser_interrupted");
  };
  const heartbeat=setInterval(()=>{try{repo.database.prepare("UPDATE learning_parsed_documents SET pdf_execution_lease_until=? WHERE id=? AND pdf_execution_token=? AND pdf_execution_lease_until>?").run(now()+PDF_LEASE_MS,attempt.id,token,now());}catch{/* Fenced at the next operation. */}},15_000);
  const parts:ParsedDocumentResult[]=[];
  let failure=false, resourceDeadline:number|undefined;
  try {
  if(configured.discoverInstance&&!value.resumeFrom){
    try{config=await resolvePdfParserInstance(configured,transport);}
    catch(error){assertOwner();repo.failParsedDocument(pageId,attempt.id,"parser_error");throw error;}
  }
  for(const physical of pages) {
    // Recheck ownership/tombstones between pages, and again before each persisted response.
    assertOwner();
    const row=repo.database.prepare("SELECT * FROM learning_pdf_requests WHERE document_id=? AND physical_page=?").get(attempt.id,physical) as Checkpoint;
    let raw:unknown; let receivedComplete=false, checkpointSaved=false;
    try {
      if(row.status==="completed"&&row.response_json)raw=JSON.parse(row.response_json);
      else {
        let context=contextOf(row);
        if(context.serviceEpoch&&config.serviceEpoch&&(context.serviceEpoch!==config.serviceEpoch||context.instance!==config.instance)) {
          repo.database.prepare("UPDATE learning_pdf_requests SET status='failed',request_context_json=? WHERE document_id=? AND physical_page=?")
            .run(JSON.stringify({...context,issue:"pdf_parser_service_changed"}),attempt.id,physical);
          throw new LearningError(409,"pdf_parser_service_changed");
        }
        context={...context,...config.serviceEpoch?{serviceEpoch:config.serviceEpoch,instance:config.instance}:{}};
        const deadline=resourceDeadline??(now()+waitMs);
        for(;;) {
        assertOwner();
        if(context.wait){
          const delay=Math.min(Math.max(0,Date.parse(context.wait.retryAt)-now()),Math.max(0,deadline-now()));
          if(delay>0)await sleep(delay);
          assertOwner();
          if(now()>=deadline)throw new LearningError(409,"pdf_parser_resource_wait");
          // A small admission snapshot avoids repeatedly sending the original
          // PDF while this explicitly unaccepted request is waiting for resources.
          let health:{service_epoch?:string;instance?:string;ready?:boolean;admission?:{accepting?:boolean;reason?:string};active_request?:unknown}|undefined;
          try{
            const response=await transport(`${config.url}/health`,{headers:{Authorization:`Bearer ${config.token}`},redirect:"error",cache:"no-store",signal:AbortSignal.timeout(5000)});
            if(response.ok)health=await boundedParserJson(response,64*1024) as typeof health;
          }catch{/* A health read failure cannot authorize resubmission. */}
          assertOwner();
          if(now()>=deadline)throw new LearningError(409,"pdf_parser_resource_wait");
          if(health?.service_epoch&&health.instance&&(health.service_epoch!==context.serviceEpoch||health.instance!==context.instance)){
            repo.database.prepare("UPDATE learning_pdf_requests SET request_context_json=? WHERE document_id=? AND physical_page=?")
              .run(JSON.stringify({...context,issue:"pdf_parser_service_changed"}),attempt.id,physical);
            throw new LearningError(409,"pdf_parser_service_changed");
          }
          if(health?.service_epoch===context.serviceEpoch&&health?.instance===context.instance&&["budget_exhausted","session_expired"].includes(health?.admission?.reason??"")){
            const issue=`pdf_parser_${health!.admission!.reason}`;
            repo.database.prepare("UPDATE learning_pdf_requests SET status='failed',request_context_json=? WHERE document_id=? AND physical_page=? AND status='waiting_resource'")
              .run(JSON.stringify({serviceEpoch:context.serviceEpoch,instance:context.instance,issue}),attempt.id,physical);
            throw new LearningError(409,issue);
          }
          if(!health||health.service_epoch!==context.serviceEpoch||health.instance!==context.instance||health.ready!==true||health.admission?.accepting!==true||health.active_request!==null){
            context={...context,wait:{...context.wait,retryAt:new Date(now()+context.wait.retryAfterSeconds*1000).toISOString()}};
            repo.database.prepare("UPDATE learning_pdf_requests SET request_context_json=? WHERE document_id=? AND physical_page=?")
              .run(JSON.stringify(context),attempt.id,physical);
            continue;
          }
        }
        const claimed=repo.database.prepare("UPDATE learning_pdf_requests SET status='submitted',request_context_json=? WHERE document_id=? AND physical_page=? AND status IN ('pending','waiting_resource')").run(JSON.stringify(context),attempt.id,physical).changes;
        if(!claimed)throw new LearningError(409,"pdf_parser_outcome_unknown");
        const response=await transport(`${config.url}/parse-pdf`,{method:"POST",redirect:"error",cache:"no-store",signal:AbortSignal.timeout(4*60*1000),
          headers:{Authorization:`Bearer ${config.token}`,"Content-Type":"application/json"},body:JSON.stringify({request_id:row.request_id,document_id:materialId,
            pdf_base64:original.bytes!.toString("base64"),sha256:original.material.pdf!.sha256,page_range:{start:physical,end:physical},recognition_profile:"png_nested_formulas",
            ...context.serviceEpoch?{expected_service_epoch:context.serviceEpoch,expected_instance:context.instance}:{}})});
        // Bound response memory. No returned error body is exposed or logged.
        raw=await boundedParserJson(response);
        // Headers alone are not a complete receipt. Keep the server result
        // available for explicit recovery when the response body was interrupted.
        // Direct server requests must finish under the identity saved before
        // upload. A mismatched success is unknown, not a receipt safe to publish/delete.
        if(response.ok&&config.discoverInstance){
          const identity=raw as {request_id?:string;service_epoch?:string;instance?:string};
          if(identity.request_id!==row.request_id||identity.service_epoch!==context.serviceEpoch||identity.instance!==context.instance)
            throw new LearningError(409,"pdf_parser_outcome_unknown");
        }
        receivedComplete=response.ok;
        assertOwner();
        const deferred=NotAccepted.safeParse(raw);
        if(!response.ok&&deferred.success&&deferred.data.request_id===row.request_id&&deferred.data.document_id===materialId
          &&deferred.data.sha256===original.material.pdf!.sha256&&deferred.data.pages[0]===physical) {
          const d=deferred.data;
          if(d.reason==="instance_changed"||(context.serviceEpoch&&(context.serviceEpoch!==d.service_epoch||context.instance!==d.instance))) {
            repo.database.prepare("UPDATE learning_pdf_requests SET status='failed',request_context_json=? WHERE document_id=? AND physical_page=?")
              .run(JSON.stringify({...context,issue:"pdf_parser_service_changed"}),attempt.id,physical);
            throw new LearningError(409,"pdf_parser_service_changed");
          }
          if(d.reason==="budget_exhausted"||d.reason==="session_expired"){
            const issue=`pdf_parser_${d.reason}`;
            repo.database.prepare("UPDATE learning_pdf_requests SET status='failed',request_context_json=? WHERE document_id=? AND physical_page=? AND status='submitted'")
              .run(JSON.stringify({serviceEpoch:d.service_epoch,instance:d.instance,issue}),attempt.id,physical);
            throw new LearningError(409,issue);
          }
          if(!d.retry_after_seconds)throw new Error("missing_retry_delay");
          resourceDeadline??=deadline;
          context={serviceEpoch:d.service_epoch,instance:d.instance,wait:{reason:d.reason,retryAfterSeconds:d.retry_after_seconds,
            retryAt:new Date(now()+d.retry_after_seconds*1000).toISOString(),expiresAt:new Date(deadline).toISOString()}};
          repo.database.prepare("UPDATE learning_pdf_requests SET status='waiting_resource',request_context_json=? WHERE document_id=? AND physical_page=? AND status='submitted'")
            .run(JSON.stringify(context),attempt.id,physical);
          continue;
        }
        repo.database.transaction(()=>{
          assertOwner();
          const result=raw as {request_id?:string;status?:string};
          if(!response.ok){
            const known=result.request_id===row.request_id&&["failed","cancelled"].includes(result.status??"");
            repo.database.prepare("UPDATE learning_pdf_requests SET status=? WHERE document_id=? AND physical_page=?").run(known?"failed":"unknown",attempt.id,physical);
            return;
          }
          repo.database.prepare("UPDATE learning_pdf_requests SET status='completed',response_json=? WHERE document_id=? AND physical_page=?").run(JSON.stringify(raw),attempt.id,physical);
        }).immediate();
        if(!response.ok)throw new Error("parser_failure");
        checkpointSaved=true;
        break;
        }
      }
      parts.push(adaptPaddleServiceResponse(raw,{attempt,original:original.material.pdf!,requestId:row.request_id,physicalPages:[physical],findings:config.findings}));
    }catch(error){
      // Never resurrect deleted materials or continue consuming remote budget after failure.
      assertOwner();
      // A full response rejected by local adaptation is a known unusable result,
      // not a completed page. Later pages retain pending; transport uncertainty
      // remains unknown and must never become an automatic retry instruction.
      repo.database.prepare("UPDATE learning_pdf_requests SET status='failed' WHERE document_id=? AND physical_page=? AND status='completed'").run(attempt.id,physical);
      repo.database.prepare("UPDATE learning_pdf_requests SET status='unknown' WHERE document_id=? AND physical_page=? AND status='submitted'").run(attempt.id,physical);
      failure=true;break;
    }finally{
      // A fenced/expired owner may not remove the receipt needed by its successor.
      // Cleanup follows durable local storage, or an explicit source tombstone.
      let sourceDeleted=false;
      if(receivedComplete&&!checkpointSaved){try{repo.pdfOriginal(pageId,materialId,false);}catch(error){sourceDeleted=error instanceof LearningError&&["material_deleted","page_deleted"].includes(error.code);}}
      if(checkpointSaved||(receivedComplete&&sourceDeleted)) {
        let cleanup="failed";
        try {const response=await transport(`${config.url}/results/${row.request_id}`,{method:"DELETE",redirect:"error",cache:"no-store",signal:AbortSignal.timeout(5000),headers:{Authorization:`Bearer ${config.token}`}});if(response.ok)cleanup="deleted";}catch{/* No retry or raw error logging. */}
        repo.database.prepare("UPDATE learning_pdf_requests SET remote_cleanup=? WHERE document_id=? AND physical_page=?").run(cleanup,attempt.id,physical);
      }
    }
  }
  // ParsedDocument v2 partitions requested pages into usable and unavailable
  // output. Execution truth (failed / pending / unknown) stays in checkpoints.
  const success=parts.flatMap(p=>p.pages), succeeded=success.map(p=>p.physical_page), failed=pages.filter(p=>!succeeded.includes(p));
  assertOwner();
  if(success.length){
    const first=parts[0];
    repo.completeParsedDocument(pageId,attempt.id,{...first,coverage:{requested_pages:pages,succeeded_pages:succeeded,failed_pages:failed},pages:[...success,...failed.map(p=>({physical_page:p,printed_label:null,parser_page_index:p-1,parse_status:"failed",failure_code:"parser_error",render:null,issues:[],reading_order:{block_ids:[],origin:"No successful response",reviews:[]},blocks:[]}))]});
  }else repo.failParsedDocument(pageId,attempt.id,failure?"parser_error":"invalid_output");
  return {document:repo.getParsedDocument(pageId,attempt.id),progress:pdfParseProgress(repo,pageId,attempt.id)};
  } finally {
    clearInterval(heartbeat);
    repo.database.prepare("UPDATE learning_parsed_documents SET pdf_execution_token=NULL,pdf_execution_lease_until=0 WHERE id=? AND pdf_execution_token=?").run(attempt.id,token);
  }
}
