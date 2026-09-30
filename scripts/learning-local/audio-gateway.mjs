import http from 'node:http';
import {createHmac,timingSafeEqual} from 'node:crypto';

// The public tunnel terminates here, never at the application. The application
// additionally checks live task ownership and deletion before returning bytes.
export function learningAudioGateway({base,secret,event=()=>{}}) {
  return http.createServer(async(req,res)=>{
    const u=new URL(req.url,'http://localhost');
    const m=u.pathname.match(/^\/api\/learning\/asr-audio\/([A-Za-z0-9_-]+)\/([a-f0-9-]{36})\/([a-f0-9-]{36})\/([a-f0-9-]{36})\/(\d+)$/);
    const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
    const deny=(status,reason)=>{res.writeHead(status,headers);res.end();event({status,reason});};
    if(!m||!['GET','HEAD'].includes(req.method))return deny(404,'route_denied');
    const [,user,page,run,material,index]=m,expires=Number(u.searchParams.get('expires')),cap=u.searchParams.get('capability')??'',now=Math.floor(Date.now()/1000);
    const expected=createHmac('sha256',secret).update(['v1','transcription',user,`learning:${page}:${run}:${material}`,index,String(expires)].join('\0')).digest('base64url');
    const supplied=Buffer.from(cap),expectedBytes=Buffer.from(expected);
    if(u.searchParams.get('purpose')!=='transcription'||!Number.isSafeInteger(expires)||expires<=now||expires>now+300||Number(index)>24||supplied.length!==expectedBytes.length||!timingSafeEqual(supplied,expectedBytes))return deny(401,'invalid_capability');
    try {
      const result=await fetch(base+u.pathname+u.search,{method:req.method,headers:req.headers.range?{range:req.headers.range}:{},redirect:'error',signal:AbortSignal.timeout(90000)});
      // Company ASR chunks are bounded at 3 MiB by the learning repository.
      const bytes=Buffer.from(await result.arrayBuffer());
      if(bytes.length>3*1024*1024)return deny(502,'oversized_chunk');
      res.writeHead(result.status,{...headers,...Object.fromEntries(['content-type','content-length','accept-ranges'].flatMap(k=>result.headers.has(k)?[[k,result.headers.get(k)]]:[]))});res.end(bytes);
      event({status:result.status,userId:user,pageId:page,runId:run,materialId:material,index:Number(index),bytes:bytes.length});
    }catch{deny(502,'upstream_unavailable');}
  });
}
