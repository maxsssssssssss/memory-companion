import { createHash } from "node:crypto";
import { createAsrHttpForwardTransport } from "../../src/lib/server/transcription/speaker-asr-transport";

/** Cloud-only synthetic validation; never imported by an application route. */
import { cosConfig, cosHost, sha256, cosAuthorization as signCos, cosUrl as signedCosUrl,
  type CosConfig } from "../../src/lib/server/learning/audio-cos-client";
export { cosConfig, cosHost, sha256, type CosConfig };
function assertTrialKey(key: string) {
  if (!/^cloud-asr\/codex-asr-[0-9a-f-]{36}\/chunk\.mp3$/.test(key)) throw Error("object_out_of_scope");
}
export function cosAuthorization(...args: Parameters<typeof signCos>) { assertTrialKey(args[2]); return signCos(...args); }
export function cosUrl(...args: Parameters<typeof signedCosUrl>) { assertTrialKey(args[1]); return signedCosUrl(...args); }
export function asrOrigin(value: string | undefined): string {
  let url: URL; try { url = new URL(value ?? ""); } catch { throw Error("asr_configuration_missing"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw Error("asr_configuration_invalid");
  return url.origin; // Preserve the explicitly configured HTTP protocol and port.
}
export async function boundedResponse(response: Response, maxBytes = 128 * 1024): Promise<Response> {
  const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let length=0;
  try { if(reader) for(;;) { const next=await reader.read(); if(next.done) break;
    length+=next.value.length; if(length>maxBytes){await reader.cancel();throw Error("response_too_large");} chunks.push(next.value); }
  } finally { reader?.releaseLock(); }
  return new Response([204,205,304].includes(response.status) || !reader ? null : new Uint8Array(Buffer.concat(chunks)),
    {status:response.status,headers:response.headers});
}
/** Reuse the application transport with the synthetic trial's own byte cap. */
export const asrHttpTransport = (origin: string): typeof fetch => createAsrHttpForwardTransport(origin, 128 * 1024);
export type TrialState = {
  version: 1; id: string; requestId: string; objectKey: string; binding: string;
  status: string; durationSeconds: number; chunkSha256: string; chunkBytes: number;
  submissions: number; queries: number; cosRequests: number; uploadIntent: boolean;
  uploadAcknowledged: boolean; versionId?: string; cleanup: "not_needed"|"pending"|"confirmed"|"unknown";
};
/** The single application ASR call runs in a dedicated CLI process. The guard
 * persists counts before I/O, validates the exact ID/audio URL and refuses all
 * other traffic/redirects. A lost submit receipt never earns another POST. */
export function guardedAsrFetch(options: { origin: string; state: TrialState; audioUrl: string;
  save: () => void; transport: typeof fetch; signal: AbortSignal }): typeof fetch {
  // This standalone trial owns fetch for its strict paid-call counter. Refuse
  // the application's independent dispatcher if invoked outside our launcher.
  if (process.env.DAILY_BRIEF_CLOUD_ASR_HTTP_BASE_URL) throw Error("trial_transport_override_refused");
  return async (input, init) => {
    const url = new URL(String(input)); const method=(init?.method ?? "GET").toUpperCase();
    if(url.origin!==options.origin || url.username || url.password || url.hash) throw Error("asr_destination_blocked");
    if(method==="POST" && url.pathname==="/api/ai/non-realtime-asr" && !url.search) {
      if(options.state.submissions!==0) throw Error("submit_budget_exhausted");
      let body: Record<string,unknown>; try{body=JSON.parse(String(init?.body));}catch{throw Error("submission_body_invalid");}
      if(body.req_id!==options.state.requestId || body.audio_url!==options.audioUrl
        || body.user_id!=="cloud_synthetic_asr_trial" || body.record_id!==options.state.requestId) throw Error("submission_binding_invalid");
      options.state.submissions++; options.state.status="submission_intent";
    } else if(method==="GET" && url.pathname==="/api/ai/non-realtime-asr/query"
      && url.searchParams.size===1 && url.searchParams.get("reqid")===options.state.requestId) {
      if(options.state.submissions!==1 || options.state.queries>=30) throw Error("query_budget_exhausted");
      options.state.queries++;
    } else throw Error("asr_operation_blocked");
    options.save(); // Must succeed before sending a potentially billable request.
    const signal=AbortSignal.any([options.signal,AbortSignal.timeout(15000),...(init?.signal ? [init.signal] : [])]);
    return boundedResponse(await options.transport(url,{...init,signal,redirect:"error",cache:"no-store"}));
  };
}
export async function cosRequest(config: CosConfig, state: TrialState, save: () => void, transport: typeof fetch,
  method: string, body?: Buffer, query: Record<string,string> = {}) {
  countCosRequest(state,save);
  const headers: Record<string,string> = body ? { "Content-Type":"audio/mpeg", "Cache-Control":"private, no-store",
    "Content-MD5":createHash("md5").update(body).digest("base64"), "x-cos-acl":"private" } : {};
  const auth=cosAuthorization(config,method,state.objectKey,query,headers);
  return boundedResponse(await transport(cosUrl(config,state.objectKey,query),{method,headers:{...headers,Authorization:auth},
    ...(body ? {body:new Uint8Array(body)} : {}),redirect:"error",cache:"no-store",signal:AbortSignal.timeout(15000)}),3*1024*1024+1024);
}
export function countCosRequest(state: TrialState, save: () => void) {
  if(state.cosRequests>=16) throw Error("cos_request_budget_exhausted");
  state.cosRequests++; save();
}
export async function cleanupCos(config: CosConfig, state: TrialState, save: () => void, transport: typeof fetch) {
  if(!state.uploadIntent) return;
  state.cleanup="pending"; save();
  try {
    const query: Record<string,string> = state.versionId ? {versionId:state.versionId} : {};
    const removed=await cosRequest(config,state,save,transport,"DELETE",undefined,query);
    const absent=await cosRequest(config,state,save,transport,"HEAD",undefined,query);
    // A missing object can still be followed by a late, unacknowledged PUT.
    state.cleanup=[200,204].includes(removed.status) && absent.status===404 && state.uploadAcknowledged ? "confirmed" : "unknown";
  } catch {state.cleanup="unknown";}
  save();
}
