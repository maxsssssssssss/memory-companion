// Experiment-only, one request. Avoid Node fetch's fixed idle/headers timer while
// retaining the caller's bounded AbortSignal. No redirect or retry implementation.
const http=require('node:http'),https=require('node:https'),{Readable}=require('node:stream');
const requestHttp=http.request,requestHttps=https.request;
exports.nativeFetch=async function nativeFetch(input,onStreamError=()=>{}){
 const q=input instanceof Request?input:new Request(input),u=new URL(q.url);
 if(!(u.protocol==='https:'&&u.hostname==='tokenhub.vision-intelligence.tech'&&u.pathname==='/v1/responses')&&!(u.protocol==='http:'&&u.hostname==='127.0.0.1'))throw Error('native_experiment_destination_rejected');
 const body=['GET','HEAD'].includes(q.method)?null:Buffer.from(await q.arrayBuffer());
 return new Promise((resolve,reject)=>{
  const headers=Object.fromEntries(q.headers);headers['accept-encoding']='identity';if(body)headers['content-length']=String(body.length);
  const req=(u.protocol==='https:'?requestHttps:requestHttp)(u,{method:q.method,headers,signal:q.signal},res=>{
   res.on('error',e=>onStreamError({name:e.name,code:e.code??null}));
   const responseHeaders=new Headers();for(const [k,v]of Object.entries(res.headers))if(v!==undefined)responseHeaders.set(k,Array.isArray(v)?v.join(', '):v);
   resolve(new Response(Readable.toWeb(res),{status:res.statusCode,headers:responseHeaders}));
  });req.once('error',reject);req.end(body);
 });
};
