import fs from 'node:fs';
const root='output/learning-input-scope-20260924';
for(const label of process.argv.slice(2)){
 const f=fs.readdirSync(root).filter(f=>/^ds-request-\d+\.json$/.test(f)).find(f=>JSON.parse(fs.readFileSync(root+'/'+f)).step===label);if(!f)continue;
 const n=f.match(/\d+/)[0],req=JSON.parse(fs.readFileSync(root+'/'+f)),res=JSON.parse(fs.readFileSync(root+'/ds-response-'+n+'.json')),wire=JSON.parse(req.body.input.find(x=>x.role==='user').content),refs=new Map();
 for(const[midx,m]of wire.materials.entries())for(const [pidx,p] of m.paragraphs.entries())refs.set(p.referenceId,{ref:`M${midx+1}P${p.number??pidx+1}`,text:p.text,materialId:m.materialId});
 for(const[eidx,e]of(wire.extras??[]).entries())refs.set(e.referenceId,{ref:'E'+(eidx+1),text:e.text,kind:e.kind});
 let raw;try{raw=JSON.parse(res.text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}catch{console.log(JSON.stringify({label,unparsedFinal:res.text}));continue;}
 const used=new Set();const replacer=(k,v)=>{if(typeof v==='string'&&refs.has(v)){const r=refs.get(v);used.add(v);return r.ref;}return v;};
 console.log(JSON.stringify({label,raw},replacer,2));
 console.log('CITED PARAGRAPHS '+JSON.stringify([...used].map(id=>refs.get(id)),null,2));
 const saved=JSON.parse(fs.readFileSync(root+'/'+label+'-stored.json'));console.log(JSON.stringify({label,published:saved.status,savedCount:saved.result_json?JSON.parse(saved.result_json).questions.length:0,publicationReason:saved.result_json?JSON.parse(saved.result_json).reason:null}));
}
