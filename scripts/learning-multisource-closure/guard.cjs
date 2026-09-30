// This batch permits only bounded TokenHub Responses calls; no OCR/ASR/network fallback.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),http=require('node:http'),https=require('node:https'),assert=require('node:assert/strict');
const {AsyncLocalStorage}=require('node:async_hooks'),{syncBuiltinESMExports}=require('node:module');
const root=process.env.LEARNING_CLOSURE_ROOT,repo=process.env.LEARNING_VALIDATION_REPO,read=fs.readFileSync,allow=new AsyncLocalStorage();
const local=h=>['localhost','127.0.0.1','::1','[::1]'].includes(h),save=(f,v,exclusive=false)=>fs.writeFileSync(root+'/'+f,JSON.stringify(v,null,2),exclusive?{flag:'wx'}:undefined);
fs.readFileSync=function(f,...args){if(typeof f==='string'&&(path.resolve(f).includes(path.sep+'review-only'+path.sep)||(path.dirname(path.resolve(f))===path.resolve(repo)&&/^\.env(?:\.|$)/.test(path.basename(f))))){const e=Error('review_or_environment_read_excluded');e.code='ENOENT';throw e;}return read.call(this,f,...args);};
const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...a){const b=Array.isArray(a[0])?a[0]:a,o=b[0],h=typeof o==='object'&&o?o.host:typeof b[1]==='string'?b[1]:'localhost';if(h&&!local(h)&&!(allow.getStore()&&h==='tokenhub.vision-intelligence.tech'))throw Error('closure_external_socket_blocked');return connect.apply(this,a);};
for(const m of[http,https])for(const k of['get','request']){const old=m[k];m[k]=function(...a){const o=a[0],h=typeof o==='string'||o instanceof URL?new URL(o).hostname:o.hostname??o.host;if(!local(h))throw Error('closure_external_http_blocked');return old.apply(this,a);};}
const real=fetch;globalThis.fetch=async(input,init)=>{const q=new Request(input,init),u=new URL(q.url),started=Date.now();
 if(/parse-pdf|non-realtime-asr/.test(u.pathname))throw Error('OCR_ASR_NOT_AUTHORIZED_IN_THIS_BATCH');
 if(local(u.hostname))return real(input,init);
 if(u.hostname==='registry.npmjs.org'&&u.pathname==='/-/package/next/dist-tags')return new Response(JSON.stringify({latest:require(path.join(repo,'node_modules/next/package.json')).version}));
 assert.equal(process.env.LEARNING_CLOSURE_LIVE,'1');assert.equal(u.href,'https://tokenhub.vision-intelligence.tech/v1/responses');assert.equal(q.method,'POST');
 assert.equal(require('node:crypto').createHash('sha256').update(read(root+'/plan.json')).digest('hex'),read(root+'/plan.sha256','utf8').trim(),'Frozen plan changed');
 const b=await q.clone().json(),catalog=JSON.parse(read(root+'/input-catalog.json','utf8'));assert.equal(b.model,'deepseek-v4-pro');assert(b.max_output_tokens<=8000);assert.equal(b.stream,true);assert.equal(b.store,false);assert(!b.tools?.length);
 const chars=b.input.reduce((n,v)=>n+v.content.length,0);assert(chars<=48000);const payload=JSON.parse(b.input.find(v=>v.role==='user').content);
 for(const m of payload.materials){const old=catalog.find(c=>c.materialId===m.materialId);assert(old);for(const p of m.paragraphs)assert.equal(p.text,old.paragraphs.find(x=>x.number===p.number)?.text,'Source text changed or review material entered');}
 const n=fs.readdirSync(root).filter(f=>/^ds-request-\d+\.json$/.test(f)).length+1;assert(n<=12);const permits=JSON.parse(read(root+'/ds-permits.json','utf8'));assert(permits.length,'Explicit manual call permit required');const step=permits.shift();assert(b.input.some(v=>v.role==='system'&&v.content.includes(step.promptMarker)),'Unexpected attached call');
 save('ds-permits.json',permits);save('ds-request-'+n+'.json',{at:new Date().toISOString(),step:step.name,inputChars:chars,body:b},true);
 const record={step:step.name,httpStatus:null,terminal:null,usage:null,text:'',durationMs:null},persist=()=>{record.durationMs=Date.now()-started;save('ds-response-'+n+'.json',record);};let r;
 try{r=await allow.run(true,()=>real(q,{redirect:'error'}));}catch(e){record.failure=e.name;persist();throw Error('closure_ds_transport_failed');}record.httpStatus=r.status;persist();if(!r.ok||!r.body)return r;
 let pending='';const decoder=new TextDecoder(),capture=s=>{for(const line of s.split(/\r?\n/)){if(!line.startsWith('data:'))continue;let e;try{e=JSON.parse(line.slice(5));}catch{continue;}if(e.type==='response.output_text.delta')record.text+=e.delta;if(['response.completed','response.incomplete','response.failed'].includes(e.type)){record.terminal=e.type;record.usage=e.response?.usage??null;record.incomplete=e.response?.incomplete_details??null;persist();}}};
 return new Response(r.body.pipeThrough(new TransformStream({transform(c,ctl){pending+=decoder.decode(c,{stream:true});const frames=pending.split(/\r?\n\r?\n/);pending=frames.pop();frames.forEach(capture);ctl.enqueue(c);},flush(){capture(pending+decoder.decode());persist();}})),{status:r.status,headers:r.headers});
};syncBuiltinESMExports();
