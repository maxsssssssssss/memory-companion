// Reviewer view: final answer only; no reasoning text or mode labels.
import fs from 'node:fs';import {root,save} from './runtime.mjs';
const label=process.argv[2],requestFile=fs.readdirSync(root).filter(f=>/^ds-request-\d+\.json$/.test(f)).find(f=>JSON.parse(fs.readFileSync(root+'/'+f)).step===label);
if(!requestFile)throw Error('No real request');const n=requestFile.match(/\d+/)[0],request=JSON.parse(fs.readFileSync(root+'/'+requestFile)),response=JSON.parse(fs.readFileSync(root+'/ds-response-'+n+'.json')),input=JSON.parse(request.body.input.find(m=>m.role==='user').content);
let final;try{final=JSON.parse(response.text);}catch{console.log(JSON.stringify({label,noParseableFinal:true,terminal:response.terminal}));process.exit(0);}
const refs=new Map(input.materials.flatMap((m,mi)=>m.paragraphs.map(p=>[p.referenceId,{location:'M'+(mi+1)+'p'+p.number,text:p.text}])));for(const e of input.extras??[])refs.set(e.referenceId,{location:e.kind,text:e.text});
const used=new Set(),loc=ids=>(ids??[]).map(id=>{used.add(id);return refs.get(id)?.location??'INVALID:'+id;});
const visible={label,title:final.title??final.summary,reason:final.reason,materials:input.materials.map((m,i)=>({alias:'M'+(i+1),materialId:m.materialId})),items:final.items.map((q,i)=>q.options?{index:i+1,scenario:q.scenario,stem:q.stem,stemSources:loc(q.stemEvidenceIds),correct:q.correctOptionId,options:q.options.map(o=>({...o,evidenceIds:loc(o.evidenceIds)})),explanation:q.explanation,explanationSources:loc(q.explanationEvidenceIds),hint:q.hint}:{index:i+1,...q}),citedParagraphs:[...used].map(id=>refs.get(id)??{location:id,text:'INVALID'})};
save('blind/'+label+'-readable.json',visible);console.log(JSON.stringify(visible,null,2));
