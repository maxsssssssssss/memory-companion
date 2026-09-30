import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {randomUUID,createHash} from 'node:crypto';import Database from 'better-sqlite3';
import {LearningRepository} from '../../src/lib/server/learning/repository.ts';
const old=path.resolve('output/learning-mode-comparison-20260923'),root=path.resolve('output/learning-compact-generation-20260923');
const hash=b=>createHash('sha256').update(b).digest('hex'),save=(f,v)=>fs.writeFileSync(root+'/'+f,JSON.stringify(v,null,2),{flag:'wx'});
assert(!fs.existsSync(root+'/plan.json'),'Never overwrite frozen plans');
for(const d of['data/users','data/users-by-email','review-only','blind','screenshots','empty-env'])fs.mkdirSync(root+'/'+d,{recursive:true});
const session=JSON.parse(fs.readFileSync(old+'/session.json')),dir='/data/users/'+session.userId;fs.mkdirSync(root+dir,{recursive:true});
const original=old+dir+'/learning-organizer.sqlite',db=new Database(original,{readonly:true});
try{assert.equal(db.pragma('integrity_check',{simple:true}),'ok');await db.backup(root+dir+'/learning-organizer.sqlite');}finally{db.close();}
for(const p of['data/users/'+session.userId+'.json','session.json'])fs.copyFileSync(old+'/'+p,root+'/'+p);
for(const f of fs.readdirSync(old+'/data/users-by-email'))if(fs.readFileSync(old+'/data/users-by-email/'+f,'utf8').includes(session.userId))fs.copyFileSync(old+'/data/users-by-email/'+f,root+'/data/users-by-email/'+f);
const snap=new Database(root+dir+'/learning-organizer.sqlite',{readonly:true});
try{save('old-rows.json',Object.fromEntries(snap.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'learning_%'").all().map(({name})=>[name,snap.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()])));}finally{snap.close();}
save('data-baseline.json',{source:original,sha256:hash(fs.readFileSync(original)),snapshotMethod:'SQLite online backup'});
const text=`【合成课程】展签印制课。本材料描述虚构的课堂印制规则，不是真实行业标准。任务是用一台印制机制作展签（caption card）。每张展签消耗两枚印制点数；点数用于登记当次工作量，不是金钱。

申请前必须同时完成排版检查并拿到教师的绿色确认卡。只有完成检查而没有绿卡，仍不具备申请资格；有绿卡而没有完成检查也不能申请。具备申请资格不保证立即印制，还要检查点数。机器和纸张在本课所有案例中均正常、足量，不另设隐藏条件。

一次申请印制三张展签，必须整批完成，不接受少印一张或借用未来点数。当前可用点数不少于六枚，且两个申请前提均满足，才可执行本次印制。恰好六枚时可以执行，执行后剩零；这称为恰好用完，不能称为仍有余量。仅已登记申请不表示已经印出展签。

若具备申请资格但当前只有四枚，只能等待点数补入。不能把每张两枚改为一枚，也不能把三张拆成两张先印。若既缺绿卡又只有四枚，资格障碍与点数不足同时存在；补拿绿卡不能凭空增加点数，补足点数也不能替代绿卡。

岩桂组完成排版检查，持有效绿卡，当前六枚点数，尚未印制，且没有其他占用：它可印三张，印后为零。涟漪组完成检查但没有绿卡，当前四枚点数，尚未印制：它同时缺少两项条件。风铃组完成检查且有绿卡，当前八枚点数，已实际印完三张：它剩两枚，不能立即再印下一批。

若两组合格申请者同时提出申请，共享当前六枚点数，本课没有规定先后或分配优先级。只能判断这六枚不足以同时满足两批，不能凭材料中的叙述顺序、组名或猜测到达时刻决定先给哪一组。申请资格、是否已执行和可用点数是三个不同判断。`;
const learning=new LearningRepository(root+dir,session.userId);let course,normal;
try{course=learning.get(session.pageId);normal={pageId:randomUUID(),materialId:randomUUID()};learning.create({id:normal.pageId,title:'合成对照 · 展签印制课'});learning.saveMaterials(normal.pageId,[{id:normal.materialId,title:'展签印制规则',kind:'txt',filename:'展签印制.txt',bytes:Buffer.from(text)}]);
 save('input-catalog.json',learning.list().flatMap(p=>learning.get(p.id).materials.map(m=>{const s=learning.source(p.id,m.id);return{pageId:p.id,materialId:m.id,kind:m.kind,title:m.title,paragraphs:s.paragraphs,scopeNotice:s.scopeNotice};})));
}finally{learning.close();}
fs.writeFileSync(root+'/normal-material.txt',text,{flag:'wx'});
const common={chapterIds:[],nodeIds:[],includeNotes:false,includeSupplements:false,difficulty:'challenging'};
const tasks={N:{pageId:normal.pageId,settings:{...common,materialIds:[normal.materialId],count:3}},X:{pageId:session.pageId,settings:{...common,materialIds:course.materials.map(m=>m.id),count:4}},P:{pageId:session.pageId,settings:{...common,materialIds:[],nodeIds:['54bc904c-24e1-434c-ac4b-60eac4917d38'],includeNotes:true,count:2}}};
const runs=[],add=(label,task,encoding,model,pair)=>runs.push({label,task,...tasks[task],kind:'quiz',id:randomUUID(),encoding,model,pair});
add('R1','N','stable','deepseek-v4-pro','refs-N');add('R2','N','compact','deepseek-v4-pro','refs-N');add('R3','X','compact','deepseek-v4-pro','refs-X');add('R4','X','stable','deepseek-v4-pro','refs-X');
for(const [task,models]of[['N',['gpt-5.5','deepseek-v4-pro']],['X',['deepseek-v4-pro','gpt-5.5']],['P',['gpt-5.5','deepseek-v4-pro']]])for(const model of models)add('M'+(runs.length-3),task,'compact',model,'models-'+task);
save('plan.json',{batch:'compact-generation-20260923',maxRequests:16,plannedMain:10,endpoint:'https://tokenhub.vision-intelligence.tech/v1/responses',reasoning:'none',maxInputChars:48000,maxOutputTokens:16000,requestTimeoutMs:240000,transport:'same SDK fetch for all; no automatic retry or fallback',outputAccounting:'reasoning and visible output share max_output_tokens; inspect returned details, missing usage unknown',runs,capabilityPlan:[{label:'F1',model:'deepseek-v4-pro',format:'json_schema',purpose:'adversarial constant not disclosed in input; check enforcement evidence, not semantic generation'},{label:'F2',model:'deepseek-v4-pro',format:'json_object',purpose:'JSON mode acceptance; does not prove schema enforcement'}],reserve:'4 maximum, named reason and standards unchanged',candidate:{model:'gpt-5.5',authorizationBasis:'User explicitly authorizes one previously adopted channel; current OPENAI_TEXT_MODEL/QA_MODEL and existing benchmark plus current catalog agree',upstreamVersion:'UNKNOWN - gateway alias only',billing:'TokenHub rate not supplied by catalog; official reference input $5 / cached $0.50 / output $30 per 1M is not this account bill'},ocr:0,asr:0,servers:0});
save('review-only/standards.json',{method:'Codex reads mode-hidden final answers and actual published items; not expert verified',N:['Two explicit prerequisites required; neither sufficient alone','six points permits batch then zero; no remaining margin','green card and points shortages coexist','executed vs reserved; no imaginary priority','all case conditions in stem and sources'],X:['all five actual materials unchanged, OCR/ASR reused','per-Slot capacity; equality full but not exceeded','coexisting barriers; no made-up sequence','16组/时间隔 ambiguity retained, not asserted as certain count/name','title attribution and every option reason need actual paragraph support'],P:['at least one question genuinely requires selected personal note two-column method','bus analogy has unprovided order/capacity assumptions; do not make it course rule','no selected edited framework or chat content'],all:['read every wrong option reason','reference valid vs sufficient separate','count all rejected/unpublished items','condition/quantity/object/version consistency','no hint answer leaks'],sampleLimitations:['Old 色卡借阅角 was inconsistent about return slip; not reused','Existing personal-note analogy is questionable; frozen, not silently corrected'],normalSha256:hash(text)});
fs.writeFileSync(root+'/plan.sha256',hash(fs.readFileSync(root+'/plan.json')));save('ds-permits.json',[]);
console.log(JSON.stringify({prepared:true,normal,planned:10,max:16,requests:0}));
