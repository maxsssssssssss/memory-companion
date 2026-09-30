// Non-production course process only. Durable budgets; no fabricated responses.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),http=require('node:http'),https=require('node:https');
const {AsyncLocalStorage}=require('node:async_hooks'),{createHash}=require('node:crypto'),{syncBuiltinESMExports}=require('node:module');
const assert=require('node:assert/strict'),root=process.env.LEARNING_TRIAL_ROOT,repo=process.env.LEARNING_VALIDATION_REPO;
const read=fs.readFileSync,sha=b=>createHash('sha256').update(b).digest('hex');
const frozen=JSON.parse(read(root+'/frozen.json','utf8'));assert.equal(sha(read(root+'/frozen.json')),read(root+'/frozen.sha256','utf8').trim());
const company=new URL(process.env.SPEAKER_ASR_BASE_URL),allowed=new AsyncLocalStorage(),local=h=>['localhost','127.0.0.1','::1','[::1]'].includes(h);
const save=(f,o,exclusive=false)=>fs.writeFileSync(root+'/'+f,JSON.stringify(o,null,2),exclusive?{flag:'wx'}:undefined);
fs.readFileSync=function(f,...a){if(typeof f==='string'&&(path.resolve(f).startsWith(path.resolve(root,'review-only')+path.sep)||(path.dirname(path.resolve(f))===path.resolve(repo)&&/^\.env(?:\.|$)/.test(path.basename(f))))){const e=Error('trial_input_excluded');e.code='ENOENT';throw e;}return read.call(this,f,...a);};
const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...a){const b=Array.isArray(a[0])?a[0]:a,o=b[0],h=typeof o==='object'&&o?o.host:typeof b[1]==='string'?b[1]:'localhost';if(h&&!local(h)&&!(allowed.getStore()===true&&[company.hostname,'tokenhub.vision-intelligence.tech'].includes(h)))throw Error('blocked_external_socket');return connect.apply(this,a);};
for(const m of[http,https])for(const k of['request','get']){const orig=m[k];m[k]=function(...a){const x=a[0],h=typeof x==='string'||x instanceof URL?new URL(x).hostname:x.hostname??x.host;if(!local(h))throw Error('blocked_external_http');return orig.apply(this,a);};}
const count=p=>fs.readdirSync(root).filter(n=>p.test(n)).length;
const redact=s=>{for(const k of['OPENAI_API_KEY','LEARNING_ASR_AUDIO_CAPABILITY_SECRET','LEARNING_PDF_SERVICE_TOKEN'])if(process.env[k])s=s.replaceAll(process.env[k],'[REDACTED]');return s.replace(/https?:[^\s"<>]+(?:capability=)[^\s"<>]*/g,'[signed URL omitted]');};
const real=fetch;globalThis.fetch=async(input,init)=>{
 const q=new Request(input,init),u=new URL(q.url),start=Date.now();
 if(process.env.LEARNING_PDF_SERVICE_URL&&u.origin===process.env.LEARNING_PDF_SERVICE_URL&&u.pathname==='/parse-pdf'){
  assert.equal(process.env.LEARNING_TRIAL_LIVE,'1');const b=await q.clone().json();assert.equal(q.method,'POST');
  const f=frozen.inputFiles.find(f=>f.sha256===b.sha256&&f.name.endsWith('.pdf'));assert(f);assert.equal(sha(Buffer.from(b.pdf_base64,'base64')),f.sha256);
  assert(b.page_range.start>=1&&b.page_range.end<=f.pages&&b.page_range.start===b.page_range.end);
  assert(count(/^ocr-claim-.*\.json$/)<30);save('ocr-claim-'+b.request_id+'.json',{at:new Date().toISOString(),request:{...b,pdf_base64:'[original bytes omitted; input hash retained]'}},true);
  let r;try{r=await real(q,{redirect:'error'});}catch(e){save('ocr-response-'+b.request_id+'.json',{failure:e.name,durationMs:Date.now()-start});throw Error('ocr_transport_failed');}
  const text=await r.text();save('ocr-response-'+b.request_id+'.json',{httpStatus:r.status,durationMs:Date.now()-start,response:JSON.parse(text)});return new Response(text,{status:r.status,headers:r.headers});
 }
 if(local(u.hostname))return real(input,init);
 if(u.hostname==='registry.npmjs.org'&&u.pathname==='/-/package/next/dist-tags')return new Response(JSON.stringify({latest:require(path.join(repo,'node_modules/next/package.json')).version}));
 assert.equal(process.env.LEARNING_TRIAL_LIVE,'1','Live calls disabled for read-only restart');
 if(u.origin===company.origin&&['/api/ai/non-realtime-asr','/api/ai/non-realtime-asr/query'].includes(u.pathname)){
  let name,meta;
  if(q.method==='POST'&&u.pathname==='/api/ai/non-realtime-asr'){
   const b=await q.clone().json(),a=JSON.parse(read(root+'/authorized-materials.json','utf8')),audio=new URL(b.audio_url),parts=audio.pathname.split('/');
   assert.equal(parts[2],'learning');assert.equal(parts[3],'asr-audio');const material=a.find(s=>s.materialId===parts[7]);assert(material);
   assert.equal(b.user_id,material.userId);assert.equal(parts[4],material.userId);assert.equal(parts[5],material.pageId);assert.equal(b.req_id,b.record_id);
   assert.equal(audio.origin,process.env.SPEAKER_ASR_AUDIO_BASE_URL);assert.equal(audio.searchParams.get('purpose'),'transcription');
   const planned=frozen.audio.chunks.find(c=>c.index===Number(parts[8]));assert(planned);assert.equal(material.sha256,frozen.inputFiles.find(x=>x.name.endsWith('.wav')).sha256);
   const prior=fs.readdirSync(root).filter(n=>/^asr-submit-.*\.json$/.test(n)&&!n.includes('-result-')).map(n=>JSON.parse(read(root+'/'+n,'utf8')));assert(!prior.some(p=>p.materialId===material.materialId&&p.index===planned.index));assert(prior.length<2);
   meta={requestId:b.req_id,userId:b.user_id,pageId:material.pageId,materialId:material.materialId,index:planned.index,sourcePath:audio.pathname,expires:Number(audio.searchParams.get('expires')),capabilitySha256:sha(audio.searchParams.get('capability')??''),at:new Date().toISOString(),status:'claimed_before_network'};
   save('asr-submit-'+b.req_id+'.json',meta,true);name='asr-submit-result-'+b.req_id+'.json';
  }else{
   assert.equal(q.method,'GET');const id=u.searchParams.get('reqid');assert(fs.existsSync(root+'/asr-submit-'+id+'.json'));const n=count(/^asr-query-\d+\.json$/)+1;assert(n<=240);name='asr-query-'+n+'.json';meta={requestId:id,at:new Date().toISOString()};save(name,{...meta,status:'claimed_before_network'},true);
  }
  let r;try{r=await allowed.run(true,()=>real(q,{redirect:'error'}));}catch(e){save(name,{...meta,durationMs:Date.now()-start,failure:e.name});throw Error('company_asr_transport_failed');}
  const text=await r.text();let value;try{value=JSON.parse(redact(text));}catch{value={invalidJson:true,bytes:Buffer.byteLength(text)};}
  save(name,{...meta,httpStatus:r.status,durationMs:Date.now()-start,response:value});return new Response(text,{status:r.status,headers:r.headers});
 }
 assert.equal(u.href,'https://tokenhub.vision-intelligence.tech/v1/responses');assert.equal(q.method,'POST');
 const b=await q.clone().json();assert.equal(b.model,'deepseek-v4-pro');assert(b.max_output_tokens<=8000);assert.equal(b.stream,true);assert.equal(b.store,false);assert(!b.tools?.length);
 const chars=b.input.reduce((n,i)=>n+i.content.length,0);assert(chars<=48000);const ordinal=count(/^ds-request-\d+\.json$/)+1;assert(ordinal<=24);
 const permit=JSON.parse(read(root+'/ds-permits.json','utf8'));assert(permit.length,'Explicit planned DS step required');const step=permit.shift();
 const prompt=b.input.find(i=>i.role==='system'&&i.content.includes(step.promptMarker));assert(prompt,'Unplanned attached call');
 save('ds-permits.json',permit);save('ds-request-'+ordinal+'.json',{step:step.name,at:new Date().toISOString(),inputChars:chars,body:b},true);
 const record={step:step.name,httpStatus:null,terminal:null,usage:null,text:'',durationMs:null},persist=()=>{record.durationMs=Date.now()-start;save('ds-response-'+ordinal+'.json',record);};
 let r;try{r=await allowed.run(true,()=>real(q,{redirect:'error'}));}catch(e){record.failure=e.name;persist();throw Error('ds_transport_failed');}record.httpStatus=r.status;persist();if(!r.ok||!r.body)return r;
 const decoder=new TextDecoder();let pending='';const capture=s=>{for(const line of s.split(/\r?\n/)){if(!line.startsWith('data:'))continue;let e;try{e=JSON.parse(line.slice(5));}catch{continue;}if(e.type==='response.output_text.delta')record.text+=e.delta;if(['response.completed','response.incomplete','response.failed'].includes(e.type)){record.terminal=e.type;record.usage=e.response?.usage??null;record.incomplete=e.response?.incomplete_details??null;persist();}}};
 return new Response(r.body.pipeThrough(new TransformStream({transform(c,ctl){pending+=decoder.decode(c,{stream:true});const parts=pending.split(/\r?\n\r?\n/);pending=parts.pop();parts.forEach(capture);ctl.enqueue(c);},flush(){pending+=decoder.decode();capture(pending);persist();}})),{status:r.status,headers:r.headers});
};syncBuiltinESMExports();
