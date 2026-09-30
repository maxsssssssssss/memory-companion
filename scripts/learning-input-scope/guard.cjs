// This batch authorizes only explicit one-shot generation permits; no OCR/ASR.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),http=require('node:http'),https=require('node:https'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {AsyncLocalStorage}=require('node:async_hooks'),{syncBuiltinESMExports}=require('node:module');
const root=process.env.LEARNING_CLOSURE_ROOT,repo=process.env.LEARNING_VALIDATION_REPO,read=fs.readFileSync,allow=new AsyncLocalStorage(),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const local=h=>['localhost','127.0.0.1','::1','[::1]'].includes(h),save=(f,v,exclusive=false)=>fs.writeFileSync(root+'/'+f,JSON.stringify(v,null,2),exclusive?{flag:'wx'}:undefined);
fs.readFileSync=function(f,...args){if(typeof f==='string'&&(path.resolve(f).includes(path.sep+'review-only'+path.sep)||(path.dirname(path.resolve(f))===path.resolve(repo)&&/^\.env(?:\.|$)/.test(path.basename(f))))){const e=Error('review_or_environment_read_excluded');e.code='ENOENT';throw e;}return read.call(this,f,...args);};
const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...a){const b=Array.isArray(a[0])?a[0]:a,o=b[0],h=typeof o==='object'&&o?o.host:typeof b[1]==='string'?b[1]:'localhost';if(h&&!local(h)&&!(allow.getStore()&&h==='tokenhub.vision-intelligence.tech'))throw Error('compact_external_socket_blocked');return connect.apply(this,a);};
for(const m of[http,https])for(const k of['get','request']){const old=m[k];m[k]=function(...a){const o=a[0],h=typeof o==='string'||o instanceof URL?new URL(o).hostname:o.hostname??o.host;if(!local(h))throw Error('compact_external_http_blocked');return old.apply(this,a);};}
function canonical(body){const b=structuredClone(body),user=JSON.parse(b.input.find(x=>x.role==='user').content);b.input.find(x=>x.role==='user').content=JSON.stringify({materials:user.materials.map(m=>m.paragraphs.map(p=>({text:p.text,referenceId:p.referenceId}))),extras:user.extras,count:user.taskContext.count,difficulty:user.taskContext.difficulty,learningGoal:user.taskContext.learningGoal});return b;}
const real=fetch;globalThis.fetch=async(input,init)=>{const q=new Request(input,init),u=new URL(q.url),started=Date.now();
 if(/parse-pdf|non-realtime-asr/.test(u.pathname))throw Error('OCR_ASR_NOT_AUTHORIZED_IN_THIS_BATCH');
 if(local(u.hostname))return real(input,init);
 if(u.hostname==='registry.npmjs.org'&&u.pathname==='/-/package/next/dist-tags')return new Response(JSON.stringify({latest:require(path.join(repo,'node_modules/next/package.json')).version}));
 assert.equal(process.env.LEARNING_CLOSURE_LIVE,'1');assert.equal(u.href,'https://tokenhub.vision-intelligence.tech/v1/responses');assert.equal(q.method,'POST');
 assert.equal(hash(read(root+'/plan.json')),read(root+'/plan.sha256','utf8').trim(),'Frozen plan changed');
 const b=await q.clone().json(),plan=JSON.parse(read(root+'/plan.json')),permits=JSON.parse(read(root+'/ds-permits.json'));assert.equal(permits.length,1);const step=permits[0];
 const frozen=plan.runs.find(x=>x.label===step.label);assert(frozen);assert.equal(b.model,'deepseek-v4-pro');assert.equal(b.reasoning.effort,'none');assert.equal(b.max_output_tokens,16000);assert.equal(b.stream,true);assert.equal(b.store,false);assert(!b.tools?.length);
 const chars=b.input.reduce((n,v)=>n+(typeof v.content==='string'?v.content.length:JSON.stringify(v.content).length),0);assert(chars<=48000);
 {const payload=JSON.parse(b.input.find(v=>v.role==='user').content),catalog=JSON.parse(read(root+'/input-catalog.json'));
  const expected=frozen.materialIds.slice().sort().map(id=>catalog.find(c=>c.materialId===id));assert(expected.every(Boolean));
  assert.deepEqual(payload.materials.map(m=>m.paragraphs.map(p=>p.text)),expected.map(m=>m.paragraphs.map(p=>p.text)),'Material changed, truncated, or review entered');
  if(frozen.kind==='quiz'){
   assert(payload.taskContext.referenceScope);assert.equal(payload.taskContext.learningGoal,frozen.goal);
   assert.deepEqual((payload.extras??[]).map(e=>({kind:e.kind,text:e.text})),frozen.note?[{kind:'note',text:plan.personalNote}]:[],'Unexpected user extras');
   const digest=hash(JSON.stringify(canonical(b))),p='pair-'+frozen.pair+'.json';if(fs.existsSync(root+'/'+p))assert.equal(JSON.parse(read(root+'/'+p)).normalizedHash,digest,'PAIR CHANGED beyond declared control view');else save(p,{normalizedHash:digest,first:step.label});
  }
  assert(!b.text,'No structured output parameter experiment');
 }
 const n=fs.readdirSync(root).filter(f=>/^ds-request-\d+\.json$/.test(f)).length+1;assert(n<=12);assert(!fs.readdirSync(root).filter(f=>/^ds-request-\d+\.json$/.test(f)).some(f=>JSON.parse(read(root+'/'+f)).step===step.label),'No replay');
 save('ds-permits.json',[]);save('ds-request-'+n+'.json',{at:new Date().toISOString(),step:step.label,inputChars:chars,body:b},true);
 const record={step:step.label,httpStatus:null,terminal:null,usage:null,returnedReasoning:null,returnedModel:null,text:'',durationMs:null,eventCounts:{},firstFinalTextMs:null},persist=()=>{record.durationMs=Date.now()-started;save('ds-response-'+n+'.json',record);};let r;
 q.signal.addEventListener('abort',()=>{record.abortedAtMs=Date.now()-started;persist();},{once:true});
 try{r=await allow.run(true,()=>real(q,{redirect:'error'}));}catch(e){record.failure=e.name;record.failureCode=e.code??e.cause?.code??null;persist();throw Error('compact_transport_failed');}record.httpStatus=r.status;persist();
 if(!r.ok||!r.body){record.failure='http_failure';record.errorBody=await r.text();if(process.env.OPENAI_API_KEY)record.errorBody=record.errorBody.replaceAll(process.env.OPENAI_API_KEY,'[REDACTED]');persist();return new Response(record.errorBody,{status:r.status,headers:r.headers});}
 let pending='';const decoder=new TextDecoder(),capture=s=>{for(const line of s.split(/\r?\n/)){if(!line.startsWith('data:'))continue;let e;try{e=JSON.parse(line.slice(5));}catch{continue;}record.eventCounts[e.type]=(record.eventCounts[e.type]??0)+1;
  if(e.type==='response.output_text.delta'){record.firstFinalTextMs??=Date.now()-started;record.text+=e.delta;}
  if(['response.completed','response.incomplete','response.failed'].includes(e.type)){record.terminal=e.type;record.usage=e.response?.usage??null;record.returnedReasoning=e.response?.reasoning?{effort:e.response.reasoning.effort}:null;record.returnedModel=e.response?.model??null;record.returnedTextFormat=e.response?.text??null;record.incomplete=e.response?.incomplete_details??null;record.responseId=e.response?.id??null;const final=e.response?.output?.filter(i=>i.type==='message'&&i.role==='assistant').flatMap(i=>i.content??[]).filter(c=>c.type==='output_text').map(c=>c.text).join('');if(final)record.text=final;persist();}
 }};
 // Never persist reasoning deltas/items or raw SSE. Keep complete final answer,
 // protocol status/usage and event counts only; business parser receives original stream.
 return new Response(r.body.pipeThrough(new TransformStream({transform(c,ctl){pending+=decoder.decode(c,{stream:true});const frames=pending.split(/\r?\n\r?\n/);pending=frames.pop();frames.forEach(capture);ctl.enqueue(c);},flush(){capture(pending+decoder.decode());persist();}})),{status:r.status,headers:r.headers});
};syncBuiltinESMExports();
