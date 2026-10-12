import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync, realpathSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { inspectLearningAudio, prepareLearningAudio } from '../../src/lib/server/learning/audio-files';
import { companyTimedText } from '../../src/lib/server/learning/audio-service';
import { requestCompanyAsr } from '../../src/lib/server/transcription/speaker-asr-provider';
import { asrOrigin, asrHttpTransport, cosConfig, cosAuthorization, cosUrl, cosRequest, cleanupCos, guardedAsrFetch, boundedResponse, countCosRequest, sha256, type TrialState } from './asr-trial-core';

const mode=process.argv[2], repo=process.cwd(), root=path.join(repo,'output/codex-cloud/asr-trial');
const stateFile=path.join(root,'state.json'), audioFile=path.join(root,'chunk.mp3'), lock=path.join(root,'lock');
const text='今天学习三角形。面积等于底乘高除以二。';
const started=performance.now();
const State=z.object({version:z.literal(1),id:z.string().uuid(),requestId:z.string().regex(/^learning_cloud_[0-9a-f-]{36}$/),
  objectKey:z.string(),binding:z.string(),status:z.string(),durationSeconds:z.number().positive().max(12),chunkSha256:z.string().regex(/^[a-f0-9]{64}$/),chunkBytes:z.number().int().positive().max(3*1024*1024),
  submissions:z.number().int().min(0).max(1),queries:z.number().int().min(0).max(30),cosRequests:z.number().int().min(0).max(16),uploadIntent:z.boolean(),uploadAcknowledged:z.boolean(),versionId:z.string().optional(),
  cleanup:z.enum(['not_needed','pending','confirmed','unknown'])}).strict();
function load():TrialState {const state=State.parse(JSON.parse(readFileSync(stateFile,'utf8')));
  if(state.requestId!==`learning_cloud_${state.id}`||state.objectKey!==`cloud-asr/codex-asr-${state.id}/chunk.mp3`) throw Error('state_binding_invalid');return state;}
function persist(state:TrialState) {State.parse(state);const tmp=stateFile+'.new';writeFileSync(tmp,JSON.stringify(state,null,2)+'\n',{mode:0o600,flush:true});renameSync(tmp,stateFile);}
const report:Record<string,unknown>={mode,syntheticOnly:true,productionChanged:false,llmCalls:0};
let ownedLock=false;
function safeFailure(error:unknown) {
  const allowed=new Set(['cos_configuration_invalid','asr_configuration_missing','asr_configuration_invalid','trial_already_prepared','trial_already_attempted','trial_busy',
    'state_binding_invalid','audio_hash_mismatch','asr_preflight_failed','storage_preflight_failed','upload_failed','public_object_detected','download_mismatch','response_too_large',
    'submit_budget_exhausted','query_budget_exhausted','asr_destination_blocked','asr_operation_blocked','asr_redirect_blocked','submission_binding_invalid','submission_body_invalid','trial_transport_override_refused',
    'cos_request_budget_exhausted','speaker_asr_submit_http','speaker_asr_query_http','speaker_asr_query_failed','speaker_asr_query_timeout','speaker_asr_empty_transcript','speaker_asr_aborted',
    'audio_invalid_timestamps','audio_empty_transcript','invalid_audio','audio_tools_unavailable','audio_resource_limit',
    'fixture_duration_out_of_budget','fixture_plan_invalid','state_config_changed','unsafe_output_path']);
  const candidate=error && typeof error==='object' ? ('code' in error ? String(error.code) : error instanceof Error ? error.message : '') : '';
  return allowed.has(candidate)?candidate:'trial_operation_failed';
}
async function main() {
  if(process.env.DAILY_BRIEF_CLOUD_ASR_HTTP_BASE_URL)throw Error('trial_transport_override_refused');
  mkdirSync(root,{recursive:true,mode:0o700});
  if(lstatSync(root).isSymbolicLink()||!realpathSync(root).startsWith(realpathSync(repo)+path.sep))throw Error('unsafe_output_path');
  if(mode==='status'){const state=load();console.log(JSON.stringify({status:state.status,submissions:state.submissions,queries:state.queries,cosRequests:state.cosRequests,cleanup:state.cleanup}));return;}
  try{mkdirSync(lock);ownedLock=true;}catch{throw Error('trial_busy');}
  if(mode==='prepare') {
    if(existsSync(stateFile)||existsSync(audioFile))throw Error('trial_already_prepared');
    report.phase='offline_synthesis';
    const tts=path.resolve(repo,'../.cloud-tools/asr-tts');
    // espeak's stdout WAV uses streaming length placeholders. Write a completed
    // WAV so the application's strict FFmpeg validation stays unchanged.
    const wavFile=path.join(root,`synthetic-${randomUUID()}.wav`);
    let wav:Buffer;
    try {
      execFileSync(path.join(tts,'usr/bin/espeak-ng'),['--path='+path.join(tts,'usr/lib/x86_64-linux-gnu'),'-v','cmn','-s','100','-w',wavFile,text],
        {env:{PATH:process.env.PATH,LANG:'C.UTF-8',NODE_ENV:'test',LD_LIBRARY_PATH:path.join(tts,'usr/lib/x86_64-linux-gnu')},stdio:['ignore','pipe','pipe'],maxBuffer:2*1024*1024,timeout:15000});
      wav=readFileSync(wavFile);
    } finally {rmSync(wavFile,{force:true});}
    report.phase='audio_validation';
    const meta=await inspectLearningAudio(wav,'synthetic.wav','audio/wav');
    if(meta.durationSeconds>12)throw Error('fixture_duration_out_of_budget');
    report.phase='audio_normalization';
    const id=randomUUID(),chunks=await prepareLearningAudio(wav,meta,id,AbortSignal.timeout(30000));
    if(chunks.length!==1||chunks[0].index!==0||chunks[0].start!==0||chunks[0].bytes.length>3*1024*1024)throw Error('fixture_plan_invalid');
    const chunk=chunks[0];writeFileSync(audioFile,chunk.bytes,{flag:'wx',mode:0o600});
    const state:TrialState={version:1,id,requestId:`learning_cloud_${id}`,objectKey:`cloud-asr/codex-asr-${id}/chunk.mp3`,binding:'',status:'prepared',
      durationSeconds:chunk.end,chunkSha256:sha256(chunk.bytes),chunkBytes:chunk.bytes.length,submissions:0,queries:0,cosRequests:0,uploadIntent:false,uploadAcknowledged:false,cleanup:'not_needed'};
    persist(state);Object.assign(report,{phase:'complete',status:'prepared',synthesis:'espeak-ng/cmn offline',expectedText:text,durationSeconds:state.durationSeconds,chunkBytes:state.chunkBytes,
      originalSha256:sha256(wav),chunkSha256:state.chunkSha256,asrRequests:0});return;
  }
  const state=load(), config=cosConfig(process.env), origin=asrOrigin(process.env.SPEAKER_ASR_BASE_URL);
  const binding=sha256(JSON.stringify([config.bucket,config.region,config.prefix,origin]));
  if(state.binding && state.binding!==binding)throw Error('state_config_changed');
  const save=()=>persist(state), transport=globalThis.fetch;
  const asrTransport=origin.startsWith('http:')?asrHttpTransport(origin):transport;
  if(mode==='cleanup') {await cleanupCos(config,state,save,transport);if(state.cleanup==='confirmed')rmSync(audioFile,{force:true});
    Object.assign(report,{status:'cleanup',cleanup:state.cleanup,submissions:state.submissions,queries:state.queries,cosRequests:state.cosRequests});
    if(state.cleanup==='unknown')process.exitCode=1;return;}
  if(mode!=='run'||process.argv[3]!=='--submit-budget=1'||process.argv[4]!=='--query-budget=30')throw Error('trial_operation_failed');
  if(state.status!=='prepared'||state.submissions||state.uploadIntent)throw Error('trial_already_attempted');
  const bytes=readFileSync(audioFile);if(sha256(bytes)!==state.chunkSha256||bytes.length!==state.chunkBytes)throw Error('audio_hash_mismatch');
  state.binding=binding;save();
  // Non-submitting HEAD happens before any upload or billable ASR POST.
  report.phase='asr_preflight';
  const ready=await asrTransport(origin+'/api/ai/non-realtime-asr',{method:'HEAD',redirect:'error',signal:AbortSignal.timeout(10000)})
    .catch(()=>{throw Error('asr_preflight_failed');});
  report.asrPreflightStatus=ready.status;await ready.body?.cancel();if(![200,405].includes(ready.status))throw Error('asr_preflight_failed');
  let audioUrl:string|undefined;
  try {
    report.phase='private_storage';
    if((await cosRequest(config,state,save,transport,'HEAD')).status!==404)throw Error('storage_preflight_failed');
    state.uploadIntent=true;state.cleanup='pending';state.status='upload_intent';save();
    const uploaded=await cosRequest(config,state,save,transport,'PUT',bytes);
    const versionId=uploaded.headers.get('x-cos-version-id');if(versionId&&versionId!=='null')state.versionId=versionId;
    state.uploadAcknowledged=uploaded.status===200;save();if(!state.uploadAcknowledged)throw Error('upload_failed');
    const query:Record<string,string>=state.versionId?{versionId:state.versionId}:{};
    countCosRequest(state,save);
    const anonymous=await transport(cosUrl(config,state.objectKey,query),{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000)});
    await anonymous.body?.cancel();if(anonymous.status!==403)throw Error('public_object_detected');
    audioUrl=cosUrl(config,state.objectKey,query,cosAuthorization(config,'GET',state.objectKey,query)).toString();
    countCosRequest(state,save);
    const downloaded=await boundedResponse(await transport(audioUrl,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000)}),3*1024*1024);
    if(downloaded.status!==200||sha256(new Uint8Array(await downloaded.arrayBuffer()))!==state.chunkSha256)throw Error('download_mismatch');
    report.phase='asr_submit_and_query';
    globalThis.fetch=guardedAsrFetch({origin,state,audioUrl,save,transport:asrTransport,signal:AbortSignal.timeout(60000)});
    const result=await requestCompanyAsr({requestId:state.requestId,materialId:state.id,userId:'cloud_synthetic_asr_trial',audioUrl,resume:false,signal:AbortSignal.timeout(60000)});
    const sentences=companyTimedText(result,0,state.durationSeconds);
    const transcript=sentences.map(s=>s.text).join('');
    const expectedKeywords=['三角形','面积','除以二'];
    Object.assign(report,{asrReturnedTranscript:true,timestampsValid:true,sentenceCount:sentences.length,
      expectedKeywords:expectedKeywords.map(word=>({word,recognized:transcript.includes(word)})),
      ...(transcript.length<=200&&/^[\u3400-\u9fff\s，。！？、；：,.!?0-9]+$/u.test(transcript)?{syntheticTranscript:transcript}:{transcriptCharacters:transcript.length})});
    state.status='asr_completed';
    report.phase='complete';
  } catch(error) {state.status=state.submissions?'asr_outcome_unconfirmed':'storage_failed';report.failure=safeFailure(error);process.exitCode=1;}
  finally {
    globalThis.fetch=transport;save();await cleanupCos(config,state,save,transport);
    if(state.cleanup==='confirmed'&&audioUrl) {
      try {
        countCosRequest(state,save);const old=await transport(audioUrl,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000)});
        report.oldSignedUrlStatus=old.status;await old.body?.cancel();if(old.status!==404)state.cleanup='unknown';
      } catch {state.cleanup='unknown';}
      save();
    }
    if(state.cleanup==='confirmed')rmSync(audioFile,{force:true});
    else if(state.uploadIntent)process.exitCode=1;
    Object.assign(report,{status:state.status,submissions:state.submissions,queries:state.queries,cosRequests:state.cosRequests,cleanup:state.cleanup,
      localAudioRemoved:!existsSync(audioFile),durationSeconds:state.durationSeconds});
  }
}
main().catch(error=>{
  report.failure=safeFailure(error);process.exitCode=1;
  try {const state=load();Object.assign(report,{status:state.status,submissions:state.submissions,queries:state.queries,cosRequests:state.cosRequests,cleanup:state.cleanup});}catch{/* No valid journal yet. */}
}).finally(()=>{
  if(ownedLock)rmSync(lock,{recursive:true,force:true});
  if(mode!=='status'){
    report.durationMs=Math.round(performance.now()-started);const serialized=JSON.stringify(report,null,2);
    if(['DAILY_BRIEF_COS_SECRET_ID','DAILY_BRIEF_COS_SECRET_KEY'].some(k=>process.env[k]&&serialized.includes(process.env[k]!))) {
      console.error('[asr trial] report withheld because sensitive data was detected');process.exitCode=1;return;
    }
    if(existsSync(root))writeFileSync(path.join(root,mode+'-result.json'),serialized+'\n',{mode:0o600});
    console.log(serialized);
  }
});
