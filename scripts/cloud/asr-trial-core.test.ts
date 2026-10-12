// @vitest-environment node
import { describe, expect, it, vi, afterEach } from 'vitest';
import { asrOrigin, boundedResponse, cleanupCos, cosAuthorization, cosConfig, cosRequest, cosUrl, guardedAsrFetch, type TrialState } from './asr-trial-core';
import { requestCompanyAsr } from '../../src/lib/server/transcription/speaker-asr-provider';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import type { Socket } from 'node:net';

const config={bucket:'synthetic-123456',region:'ap-shanghai',prefix:'cloud-asr/',secretId:'SYNTHETIC_ID',secretKey:'SYNTHETIC_KEY'};
const id='00000000-0000-4000-8000-000000000000', key=`cloud-asr/codex-asr-${id}/chunk.mp3`;
const origin='http://asr.invalid:8790', audioUrl='https://audio.invalid/synthetic.mp3?token=synthetic';
function state():TrialState {return {version:1,id,requestId:`learning_cloud_${id}`,objectKey:key,binding:'',status:'prepared',durationSeconds:10,
  chunkSha256:'a'.repeat(64),chunkBytes:42,submissions:0,queries:0,cosRequests:0,uploadIntent:false,uploadAcknowledged:false,cleanup:'not_needed'};}
const submit=(s:TrialState)=>({method:'POST',body:JSON.stringify({req_id:s.requestId,record_id:s.requestId,user_id:'cloud_synthetic_asr_trial',audio_url:audioUrl})});
const makeGuard=(s:TrialState,transport:typeof fetch,save=()=>{})=>guardedAsrFetch({origin,state:s,audioUrl,transport,save,signal:AbortSignal.timeout(2000)});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});

describe('COS signing and restricted configuration',()=>{
  // Golden vectors from integrity-verified official cos-nodejs-sdk-v5 3.0.0.
  it.each([
    ['GET','651e2a0807d05edbe40e0c4f08c9431bf8ab425b'],['HEAD','62fab88ad7dcc280d613c7fbabe7894945184d84'],
    ['PUT','46d08af686c23248b128297f3373a2db4097c9e9'],['DELETE','c00f61cc086dadd9971536791bec27938016c51b']
  ])('matches official %s signature',(method,expected)=>{
    const auth=new URLSearchParams(cosAuthorization(config,method,key,{}, {},1700000000,1700000180));
    expect(auth.get('q-signature')).toBe(expected);expect(auth.get('q-header-list')).toBe('host');
  });
  it('binds object, method, time, host and version query',()=>{
    const sign=(c=config,m='GET',k=key,q={},end=180)=>cosAuthorization(c,m,k,q,{},0,end);
    const baseline=sign();
    for(const changed of [sign(config,'HEAD'),sign({...config,bucket:'other-123456'}),sign(config,'GET',key.replace('00000000-','11111111-')),
      sign(config,'GET',key,{versionId:'version/a+b'}),sign(config,'GET',key,{},181)])expect(changed).not.toBe(baseline);
    const url=cosUrl(config,key,{versionId:'version/a+b'},sign(config,'GET',key,{versionId:'version/a+b'}));
    expect(url.protocol).toBe('https:');expect(url.searchParams.get('versionId')).toBe('version/a+b');
    expect(url.searchParams.get('q-url-param-list')).toBe('versionid');
    expect(new URLSearchParams(cosAuthorization(config,'GET',key,{versionId:'version/a+b'}, {},1700000000,1700000180)).get('q-signature'))
      .toBe('18d95306a5c4d167ca6b2640c0a993f5ca893bc2');
  });
  it.each(['../private/file','other/chunk.mp3','cloud-asr/../../file','cloud-asr/codex-asr-test/chunk.mp3'])('rejects out of scope key %s',value=>{
    expect(()=>cosAuthorization(config,'GET',value)).toThrow('object_out_of_scope');
    expect(()=>cosUrl(config,value)).toThrow('object_out_of_scope');
  });
  it('refuses excess TTL, unknown methods and invalid config',()=>{
    expect(()=>cosAuthorization(config,'GET',key,{}, {},0,301)).toThrow('signature_scope_invalid');
    expect(()=>cosAuthorization(config,'POST',key)).toThrow('signature_scope_invalid');
    expect(()=>cosConfig({})).toThrow('cos_configuration_invalid');
    expect(()=>cosConfig({DAILY_BRIEF_COS_BUCKET:config.bucket,DAILY_BRIEF_COS_REGION:config.region,DAILY_BRIEF_COS_PREFIX:'/',DAILY_BRIEF_COS_SECRET_ID:'synthetic',DAILY_BRIEF_COS_SECRET_KEY:'synthetic'})).toThrow('cos_configuration_invalid');
  });
  it('preserves ASR HTTP and port; rejects credentials and path overrides',()=>{
    expect(asrOrigin(origin)).toBe(origin);
    for(const value of ['http://user:pass@asr.invalid','http://asr.invalid/path','http://asr.invalid?x=y','file:///tmp/asr'])expect(()=>asrOrigin(value)).toThrow('asr_configuration_invalid');
  });
});

describe('one submission and bounded queries',()=>{
  it('refuses a competing application dispatcher before the trial can lose its paid-call guard',()=>{
    vi.stubEnv('DAILY_BRIEF_CLOUD_ASR_HTTP_BASE_URL',origin);
    const s=state(),transport=vi.fn<typeof fetch>();
    expect(()=>makeGuard(s,transport)).toThrow('trial_transport_override_refused');
    expect(s.submissions).toBe(0);expect(s.queries).toBe(0);expect(transport).not.toHaveBeenCalled();
  });
  it('persists submit intent before network and forbids resubmit after lost receipt',async()=>{
    const s=state(),saved:TrialState[]=[];
    const transport=vi.fn<typeof fetch>(async()=>{expect(saved.at(-1)?.submissions).toBe(1);throw Error('lost receipt');});
    const guarded=makeGuard(s,transport,()=>saved.push({...s}));
    await expect(guarded(origin+'/api/ai/non-realtime-asr',submit(s))).rejects.toThrow('lost receipt');
    await expect(guarded(origin+'/api/ai/non-realtime-asr',submit(s))).rejects.toThrow('submit_budget_exhausted');
    expect(transport).toHaveBeenCalledTimes(1);expect(s.submissions).toBe(1);
  });
  it('never sends a POST if durable intent cannot be saved',async()=>{
    const s=state(),transport=vi.fn<typeof fetch>();
    await expect(makeGuard(s,transport,()=>{throw Error('disk failed');})(origin+'/api/ai/non-realtime-asr',submit(s))).rejects.toThrow('disk failed');
    expect(transport).not.toHaveBeenCalled();
  });
  it('allows at most 30 original-ID queries, with redirect errors and no cache',async()=>{
    const s=state();s.submissions=1;
    const transport=vi.fn<typeof fetch>(async(_,init)=>{expect(init?.redirect).toBe('error');expect(init?.cache).toBe('no-store');return Response.json({code:2});});
    const guarded=makeGuard(s,transport);
    for(let i=0;i<30;i++)await guarded(origin+'/api/ai/non-realtime-asr/query?reqid='+s.requestId);
    await expect(guarded(origin+'/api/ai/non-realtime-asr/query?reqid='+s.requestId)).rejects.toThrow('query_budget_exhausted');
    expect(s.queries).toBe(30);expect(transport).toHaveBeenCalledTimes(30);
  });
  it('refuses foreign destinations, IDs and audio replacement without network',async()=>{
    const s=state(),transport=vi.fn<typeof fetch>(),guarded=makeGuard(s,transport);
    for(const url of ['http://other.invalid/api/ai/non-realtime-asr',origin+'/other',origin+'/api/ai/non-realtime-asr/query?reqid=other'])await expect(guarded(url)).rejects.toThrow();
    await expect(guarded(origin+'/api/ai/non-realtime-asr',{...submit(s),body:submit(s).body.replace(audioUrl,'https://other.invalid/audio')})).rejects.toThrow('submission_binding_invalid');
    expect(transport).not.toHaveBeenCalled();expect(s.submissions).toBe(0);
  });
  it('runs the unchanged application transport through the budget guard',async()=>{
    const s=state();vi.stubEnv('SPEAKER_ASR_BASE_URL',origin);
    const data={asr_result:{sentences:[{text:'今天学习三角形',start:0,end:1000}]}};
    const transport=vi.fn<typeof fetch>(async()=>Response.json({code:0,data}));
    vi.stubGlobal('fetch',makeGuard(s,transport));
    const result=await requestCompanyAsr({requestId:s.requestId,materialId:s.id,userId:'cloud_synthetic_asr_trial',audioUrl,resume:false,signal:AbortSignal.timeout(1000)});
    expect(result).toEqual(data);expect(s.submissions).toBe(1);expect(s.queries).toBe(0);expect(transport).toHaveBeenCalledTimes(1);
  });
  it('bounds untrusted response bytes',async()=>{
    await expect(boundedResponse(new Response('x'.repeat(100)),10)).rejects.toThrow('response_too_large');
    expect(await (await boundedResponse(new Response('small'),10)).text()).toBe('small');
    expect((await boundedResponse(new Response(null,{status:204}))).body).toBeNull();
  });
});

describe('owned object cleanup',()=>{
  it.each([true,false])('requires acknowledged upload to prove cleanup (%s)',async(ack)=>{
    const s=state();s.uploadIntent=true;s.uploadAcknowledged=ack;s.versionId='version/synthetic';
    const transport=vi.fn<typeof fetch>(async(input,init)=>{
      const url=new URL(String(input));expect(url.pathname).toBe('/'+key);expect(url.searchParams.get('versionId')).toBe(s.versionId);
      return new Response(null,{status:init?.method==='DELETE'?204:404});
    });
    await cleanupCos(config,s,()=>{},transport);expect(s.cleanup).toBe(ack?'confirmed':'unknown');expect(s.cosRequests).toBe(2);
  });
  it('retains unknown state after deletion failure and never lists the bucket',async()=>{
    const s=state();s.uploadIntent=true;s.uploadAcknowledged=true;
    const transport=vi.fn<typeof fetch>(async()=>{throw Error('network');});
    await cleanupCos(config,s,()=>{},transport);expect(s.cleanup).toBe('unknown');expect(transport).toHaveBeenCalledTimes(1);
  });
  it('does nothing before upload intent; caps COS calls without corrupting counters',async()=>{
    const s=state(),transport=vi.fn<typeof fetch>();await cleanupCos(config,s,()=>{},transport);expect(transport).not.toHaveBeenCalled();
    s.cosRequests=16;await expect(cosRequest(config,s,()=>{},transport,'HEAD')).rejects.toThrow('cos_request_budget_exhausted');
    expect(s.cosRequests).toBe(16);expect(transport).not.toHaveBeenCalled();
  });
});

it('plain HTTP ASR uses an absolute-form proxy request without CONNECT, rejects redirects and oversized bodies',async()=>{
  const methods:string[]=[];let connects=0;const sockets=new Set<Socket>();
  const proxy=createServer((req,res)=>{
    methods.push(req.method!);
    if(!req.url?.startsWith(origin+'/')){res.writeHead(400);res.end();return;}
    const url=new URL(req.url);
    if(url.pathname==='/redirect'){res.writeHead(302,{location:'http://other.invalid'});res.end();return;}
    if(url.pathname==='/large'){res.end('x'.repeat(128*1024+1));return;}
    if(req.method==='HEAD'){res.writeHead(405);res.end();return;}
    const chunks:Buffer[]=[];req.on('data',(c:Buffer)=>chunks.push(c));
    req.on('end',()=>{
      if(req.method==='POST'){
        const body=JSON.parse(Buffer.concat(chunks).toString());
        if(body.req_id!==`learning_cloud_${id}`||body.record_id!==body.req_id||body.audio_url!==audioUrl){res.writeHead(400);res.end();return;}
        res.end(JSON.stringify({code:0}));
      }else res.end(JSON.stringify({code:0,data:{asr_result:{sentences:[{text:'三角形',start:0,end:1000}]}}}));
    });
  });
  proxy.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
  proxy.on('connect',(_,socket)=>{connects++;socket.destroy();});
  await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  const address=proxy.address();if(!address||typeof address==='string')throw Error('test proxy unavailable');
  const script=`
    const a=require('node:assert/strict');
    const {asrHttpTransport,guardedAsrFetch}=require('./scripts/cloud/asr-trial-core.ts');
    const {requestCompanyAsr}=require('./src/lib/server/transcription/speaker-asr-provider.ts');
    (async()=>{
      const transport=asrHttpTransport(${JSON.stringify(origin)}),state=${JSON.stringify(state())};
      a.equal((await transport(${JSON.stringify(origin)}+'/api/ai/non-realtime-asr',{method:'HEAD'})).status,405);
      await a.rejects(transport(${JSON.stringify(origin)}+'/redirect'),/asr_redirect_blocked/);
      await a.rejects(transport(${JSON.stringify(origin)}+'/large'),/response_too_large/);
      globalThis.fetch=guardedAsrFetch({origin:${JSON.stringify(origin)},state,audioUrl:${JSON.stringify(audioUrl)},save:()=>{},transport,signal:AbortSignal.timeout(5000)});
      const result=await requestCompanyAsr({requestId:state.requestId,materialId:state.id,userId:'cloud_synthetic_asr_trial',audioUrl:${JSON.stringify(audioUrl)},resume:false,signal:AbortSignal.timeout(5000)});
      a.equal(result.asr_result.sentences[0].text,'三角形');a.equal(state.submissions,1);a.equal(state.queries,1);
    })().catch(()=>process.exit(1));`;
  try {
    await new Promise<void>((resolve,reject)=>{
      const child=spawn(process.execPath,['--use-env-proxy','--import','tsx','-e',script],{
        cwd:process.cwd(),env:{PATH:process.env.PATH,NODE_ENV:'test',HTTP_PROXY:`http://127.0.0.1:${address.port}`,HTTPS_PROXY:`http://127.0.0.1:${address.port}`,
          NO_PROXY:'localhost,127.0.0.1,::1',SPEAKER_ASR_BASE_URL:origin},stdio:'ignore',timeout:8000});
      child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('synthetic proxy child failed')));
    });
    expect(connects).toBe(0);expect(methods).toEqual(['HEAD','GET','GET','POST','GET']);
  }finally{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>proxy.close(()=>resolve()));}
},10000);
