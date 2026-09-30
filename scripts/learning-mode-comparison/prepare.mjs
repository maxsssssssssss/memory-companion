import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash,randomUUID,randomInt} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import Database from 'better-sqlite3';
import {LearningRepository} from '../../src/lib/server/learning/repository.ts';
const old=path.resolve('output/learning-multisource-closure-20260923'),root=path.resolve('output/learning-mode-comparison-20260923');
const hash=b=>createHash('sha256').update(b).digest('hex'),write=(p,v)=>fs.writeFileSync(root+'/'+p,JSON.stringify(v,null,2));
assert(!fs.existsSync(root+'/baseline.json'),'Never overwrite an experiment');
for(const p of ['review-only','screenshots','blind','before'])fs.mkdirSync(root+'/'+p,{recursive:true});
const session=JSON.parse(fs.readFileSync(old+'/session.json','utf8')),dir='/data/users/'+session.userId;
fs.mkdirSync(root+dir,{recursive:true});const original=old+dir+'/learning-organizer.sqlite';
const db=new Database(original,{readonly:true});try{assert.equal(db.pragma('integrity_check',{simple:true}),'ok');await db.backup(root+dir+'/learning-organizer.sqlite');}finally{db.close();}
for(const p of ['data/users/'+session.userId+'.json','session.json'])fs.copyFileSync(old+'/'+p,root+'/'+p);
fs.mkdirSync(root+'/data/users-by-email',{recursive:true});for(const f of fs.readdirSync(old+'/data/users-by-email'))if(fs.readFileSync(old+'/data/users-by-email/'+f,'utf8').includes(session.userId))fs.copyFileSync(old+'/data/users-by-email/'+f,root+'/data/users-by-email/'+f);
const tables=['learning_materials','learning_parsed_documents','learning_audio_runs','learning_audio_chunks','learning_audio_transcripts','learning_framework_runs','learning_framework_chapters','learning_overview_runs','learning_node_conversations','learning_node_turns','learning_answer_notes','learning_quiz_runs','learning_quiz_attempts'];
const snap=new Database(root+dir+'/learning-organizer.sqlite',{readonly:true});try{write('old-rows.json',Object.fromEntries(tables.map(t=>[t,snap.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()])));}finally{snap.close();}
const files=['src/lib/server/learning/framework-generator.ts','src/lib/server/learning/quiz-service.ts','src/lib/server/learning/study-service.ts','src/lib/server/learning/model-input.ts','src/lib/server/learning/quiz-grounding.ts','src/lib/server/learning/quiz-repository.ts','src/lib/server/learning/study-repository.ts','src/lib/server/openai/structured-json.ts'];
for(const f of files){fs.mkdirSync(path.dirname(root+'/before/'+f),{recursive:true});fs.copyFileSync(f,root+'/before/'+f);}
const git={};for(const [k,args]of Object.entries({branch:['branch','--show-current'],head:['rev-parse','HEAD'],status:['status','--short'],staged:['diff','--cached','--name-only']})){const r=spawnSync('git',args,{encoding:'utf8',windowsHide:true});assert.equal(r.status,0);git[k]=r.stdout.trim();}
write('baseline.json',{at:new Date().toISOString(),source:old,session,git,originalDatabaseSha256:hash(fs.readFileSync(original)),snapshotMethod:'SQLite online backup',files:files.map(f=>({file:f,sha256:hash(fs.readFileSync(f))})),historicalActual:{model:'deepseek-v4-pro',reasoning:{effort:'none'},maxOutputTokens:8000,transportTimeoutMs:120000,publicationDeadlineMs:150000,stream:true,serverSchema:false}});
const text=`【合成课程】色卡借阅角。以下规则只适用于这个虚构课堂，不是现实借阅标准。青盒中的实体色卡供同学轮流借阅，登记条只记录申请，不代表已经领到色卡。

借卡前须完成样张比对并交回比对单。未完成比对不能申请，即使盒内有很多卡。完成比对只取得申请资格，不保证立即领到卡。

每次申请需要三张色卡；同一时点能借出的张数为盒内当前可用张数，不含尚未归还的卡。只有当前可用张数不少于三张，且申请者已完成比对，才能一次领取三张。不拆分一次申请。正好三张可以领取，领取后剩零；不表示开始时有余量。

如果已完成比对但只有两张可用，只能等待归还；不能降低一次领取数或把他人未归还的卡当作可用。若尚未完成比对且盒内只有两张，两项障碍同时存在；先完成比对也不会凭空增加可用张数。

松果组完成比对，盒内恰有三张且没有其他已准许的领取，可一次领走三张。羽毛组尚未完成比对，盒内有六张，它仍不能申请。贝壳组已完成比对但只有两张可用，须等归还。

若两个符合资格的组同时申请，而仅有三张可用，本课未规定谁先领。可以判断不足以同时满足两次申请，不能凭名称、叙述顺序或猜测到达时间指定优先者。`;
const learning=new LearningRepository(root+dir,session.userId);let course,control;
try{course=learning.get(session.pageId);control={pageId:randomUUID(),materialId:randomUUID()};learning.create({id:control.pageId,title:'合成对照 · 色卡借阅角'});learning.saveMaterials(control.pageId,[{id:control.materialId,title:'色卡借阅角课堂规则',kind:'txt',filename:'色卡借阅角.txt',bytes:Buffer.from(text)}]);const catalog=learning.list().flatMap(p=>learning.get(p.id).materials.map(m=>{const s=learning.source(p.id,m.id);return{pageId:p.id,materialId:m.id,kind:m.kind,title:m.title,paragraphs:s.paragraphs,scopeNotice:s.scopeNotice};}));write('input-catalog.json',catalog);}finally{learning.close();}
fs.writeFileSync(root+'/control-material.txt',text);
const common={chapterIds:[],nodeIds:[],includeNotes:false,includeSupplements:false,difficulty:'challenging'};
const tasks={
 A:{kind:'quiz',pageId:session.pageId,settings:{...common,materialIds:course.materials.map(m=>m.id),count:4},purpose:'容量、等号边界、共同障碍和未指定先后关系；按实际结果逐项记录覆盖，不能换题凑正例'},
 B:{kind:'overview',pageId:session.pageId,purpose:'现有Window与旧章节的真实跨批次关系'},
 C:{kind:'quiz',pageId:session.pageId,settings:{...common,materialIds:[],nodeIds:['54bc904c-24e1-434c-ac4b-60eac4917d38'],includeNotes:true,count:2},purpose:'所选个人笔记独有的两栏学习方法或明确教学假设应实际贡献；只引用原材料不能算本任务完成，不将笔记冲突洗成课程规则'},
 D:{kind:'quiz',pageId:control.pageId,settings:{...common,materialIds:[control.materialId],count:3},purpose:'未参与旧Prompt修改的短合成文本应用；无框架直接Quiz'}
};
const blindMap={},runs=[];for(const [task,v]of Object.entries(tasks)){const efforts=randomInt(2)?['high','none']:['none','high'];for(let i=0;i<2;i++){const label=task+(i+1);blindMap[label]=efforts[i];runs.push({label,task,id:randomUUID(),...v});}}
write('review-only/mode-map.json',blindMap);
write('review-only/standards.json',{method:'Codex先读无模式标签的正文和实际发布结果，固定审阅后才揭示对应模式；不称专家核验',A:['逐时段两组等号=已满但未超额','前提未满足与下一站已满可同时存在','材料未给出优先级时不推定先后','原ASR16组/时间隔不无说明纠正或当确定数字','每选项理由需对应条件与案例段'],B:['Window由两个相邻Slot组成；记录粒度不改变旧前提和容量','19分钟与5分钟规则不可被归为已对齐','只跨批真实章节；每条完整必要引用'],C:['必须至少一题真正依赖note reference；笔记独有两栏法不是课程新规则','家长回执/车辆座位类比中的风险不能当课堂规则或已知唯一先后'],D:['未比对不可申请，完成比对不保证领取','恰好三张够一次且领后零；不声称原有余量','两项障碍可并存；先完成比对不新增卡','两组合格三张不能同时满足且无法确定谁先'],all:['逐题读题干、正确答案和全部错误理由','引用可达、充分、语义正确、覆盖和提示分别评分','统计被拒题和原始坏题，不能只审已发布','不将更长当更好、不写verified']});
write('plan.json',{batch:'mode-comparison-20260923',provider:'TokenHub Responses',model:'deepseek-v4-pro',maxRequests:12,pairedRequests:8,maxInputChars:48000,maxOutputTokens:16000,requestTimeoutMs:120000,publicationDeadlineMs:150000,promptPolicy:'Unmodified product prompts and input serializer, same per pair, no extra task instruction injected',budgetAccounting:'SDK documents output cap including reasoning and final tokens; TokenHub accounting verified only from returned usage; absent details unknown',candidate:'reasoning.effort=high; outbound mutation only in isolated guard, not product defaults',fallback:'No probe. If channel explicitly rejects high, stop and document before selecting any evidence-backed alternative.',runs,reserve:'Up to four named calls after blind review only for evidenced correction/application regression',ocr:0,asr:0,remoteStarts:0});
fs.writeFileSync(root+'/plan.sha256',hash(fs.readFileSync(root+'/plan.json')));write('ds-permits.json',[]);
console.log(JSON.stringify({prepared:true,root,materials:course.materials.length+1,pairedTasks:4,requests:0,control}));
