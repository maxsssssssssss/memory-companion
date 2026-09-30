import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createCanvas} from '@napi-rs/canvas';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
const root=path.resolve('output/learning-synthetic-course-20260923'),h='C:/Codex/learning-ocr-handoff/20260921-171314';
const hash=b=>createHash('sha256').update(b).digest('hex'),json=(f,v)=>fs.writeFileSync(root+'/'+f,JSON.stringify(v,null,2));
assert(!fs.existsSync(root+'/frozen.sha256'),'Already frozen');
const manifest=JSON.parse(fs.readFileSync(h+'/file-manifest.json','utf8'));
const files=manifest.files.map(f=>({path:f.path,pass:hash(fs.readFileSync(h+'/'+f.path))===f.sha256&&fs.statSync(h+'/'+f.path).size===f.bytes}));
assert(files.every(f=>f.pass));assert.equal(files.length,70);
assert.equal(hash(fs.readFileSync(h+'/service-handoff.json')),'5b9bc6eccde6b3c595c7b3269635422252159186c28364abae251b7142261453');
json('handoff-preflight.json',{files:files.length,allMatch:true,manifestSha256:hash(fs.readFileSync(h+'/file-manifest.json')),manifestPresent:true,serviceHashCorrect:true,bytesVerified:true});
const inputFiles=[];
for(const name of fs.readdirSync(root+'/inputs')){
 const bytes=fs.readFileSync(root+'/inputs/'+name),item={name,bytes:bytes.length,sha256:hash(bytes)};
 if(name.endsWith('.pdf')){
  const loading=getDocument({data:new Uint8Array(bytes),isEvalSupported:false,useSystemFonts:true});const doc=await loading.promise;item.pages=doc.numPages;
  const mini=createCanvas(600,Math.ceil(doc.numPages/3)*283),ctx=mini.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,mini.width,mini.height);
  const text=[];
  for(let n=1;n<=doc.numPages;n++){
   const p=await doc.getPage(n),v=p.getViewport({scale:1.25}),c=createCanvas(Math.ceil(v.width),Math.ceil(v.height));
   await p.render({canvasContext:c.getContext('2d'),viewport:v}).promise;fs.writeFileSync(root+'/screenshots/pdf-'+name+'-'+n+'.png',c.toBuffer('image/png'));
   ctx.drawImage(c,((n-1)%3)*200,Math.floor((n-1)/3)*283,200,283);
   text.push({physicalPage:n,text:(await p.getTextContent()).items.map(x=>x.str??'').join(' ')});
  }
  fs.writeFileSync(root+'/screenshots/contact-'+name+'.png',mini.toBuffer('image/png'));
  json('review-only/pdf-text-'+name+'.json',text);await loading.destroy();
 }
 inputFiles.push(item);
}
const meta=JSON.parse(fs.readFileSync(root+'/review-only/audio-metadata.json','utf8'));
const duration=Number(meta.format.duration);assert(duration>=480&&duration<=600);
const checkpoints={
 scope:'Synthetic rules and synthetic voice, not industry standards; review-only, MUST NOT enter product input',
 pdfUnique:[{pages:[2,3],facts:'展项/主题/线索；方向先于折痕比较；前置不等于空间相邻'},{pages:[4,5],facts:'分区同时需要共同问题和无干扰；表格3/4/5/4分钟；纸桥仅观察'},{pages:[6,7],facts:'三站单组同讲解者且不返回；T=讲解+4+3；3+4+5→19<=22；返回属于不适用，不是超时'},{pages:[8,9],facts:'Slot=5分钟，最多2组，必须完成本站才能申请；不叠加移动2分钟；比较不能泛化'}],
 audioUnique:[{scriptParagraph:2,facts:'深折痕不能单独推出用力更大'},{scriptParagraph:4,facts:'3+4+4+4+3=18，通过22分钟检查但不保证教学效果'},{scriptParagraph:5,facts:'额外准备4分钟→22刚好通过；5分钟→23超时'},{scriptParagraph:7,facts:'已预约1组，松果和海星均完成，先松果后海星；依课件2组容量只松果进入，但容量冲突不能静默裁定'},{scriptParagraph:8,facts:'石榴未完成，风铃已完成，即使下一站空2位也只有风铃可申请'}],
 textUnique:[{paragraph:2,facts:'凸起方向箭头卡；听音敏感组的替代，跳过听音不等于未学术语'},{paragraph:3,facts:'待确认3组与课件2组冲突，教师未确认；不得以容量冲突出唯一答案'},{paragraph:4,facts:'纸桥最牢没有承重测量依据'}],
 multiSource:[{question:'石榴组为什么不能因下一站空位进入？',answer:'录音未完成本站事实+PDF第8页完成前提；不是容量超额'},{question:'听音敏感组可用什么学习方向？',answer:'录音暂停不推断态度+TXT凸起箭头卡+PDF方向术语，不证明效果'}],
 secondBatch:[{pages:[1,2],facts:'Window连续2格，同组每格占1位置，不扩容量；第3/4格，第4格结束再申请；不改变22分钟规则'},{textParagraph:1,facts:'不同组不能拼接连续观察记录，需重新安排'}],
 rubric:['检查三源独有贡献和多源联合，非机械三源每题','条件/否定/对象/数字保留，冲突并列','所有选项理由忠实，唯一合理答案，提示不泄题','逐节点/逐题依据充分与可达分别判断','OCR/ASR疑似错词不静默修正，仍unverified','基础补充有帮助但不是老师原话','旧成果与个人笔记不变，新增成果独立','来源为实际OCR/ASR/TXT，不读取制作源码/讲稿/本标准']
};
json('review-only/checkpoints.json',checkpoints);
const plan={version:1,createdAt:new Date().toISOString(),course:'合成课程：纸上展览工坊',inputFiles,audio:{seconds:duration,codec:meta.streams[0],chunks:[{index:0,start:0,end:300},{index:1,start:300,end:Math.round(duration*1000)/1000}],strategy:'existing product 300-second normalization; no change'},budgets:{ds:24,inputChars:48000,outputTokens:8000,asrRecordings:2,asrSeconds:900,asrQueries:240,ocrStarts:4,ocrPages:30,ocrRegions:500},steps:[
 {id:'direct-quiz',kind:'quiz',scope:'first batch all 3 materials',count:4,difficulty:'standard',notes:false,supplements:false,mode:'practice',precondition:'no framework'},
 {id:'framework-1',kind:'framework',scope:'first batch all 3'},
 {id:'node-question-1',kind:'ask',scope:'actual selected multi-source knowledge node',purpose:'clarify condition vs result'},
 {id:'node-question-2',kind:'example',scope:'same node and saved conversation',purpose:'helpful labelled hypothetical example; manually save note'},
 {id:'joint-quiz',kind:'quiz',scope:'all 3 with explicitly selected notes/supplements',count:4,difficulty:'challenging',notes:true,supplements:true,mode:'test'},
 {id:'framework-2',kind:'framework',scope:'second batch PDF + TXT only'},
 {id:'overview-2',kind:'automatic overview',scope:'both batches actual sources'},
 {id:'cross-batch-quiz',kind:'quiz',scope:'all 5 materials',count:4,difficulty:'challenging',notes:false,supplements:false,mode:'test',retainIncompleteForRestart:true}
 ],repairPolicy:'at most 2 evidence-driven revisions, no automatic retries, 24 total including attached calls',sourceTruth:'OCR and ASR runtime output only; no authored source substitutions',reviewOnlyHashes:Object.fromEntries(['合成讲稿.txt','checkpoints.json','authoring.json'].map(n=>[n,hash(fs.readFileSync(root+'/review-only/'+n))]))};
json('frozen.json',plan);fs.writeFileSync(root+'/frozen.sha256',hash(fs.readFileSync(root+'/frozen.json')));
for(const [name,args] of [['branch',['branch','--show-current']],['head',['rev-parse','HEAD']],['status',['status','--short']],['staged',['diff','--cached','--stat']]]){
 const r=spawnSync('git',args,{encoding:'utf8',windowsHide:true});fs.writeFileSync(root+'/baseline-'+name+'.txt',r.stdout??'');assert.equal(r.status,0);
}
json('ledger.json',{batch:'learning-synthetic-course-20260923',ds:[],asrSubmissions:[],asrQueries:[],ocr:[],ocrStarts:[],createdAt:new Date().toISOString()});
json('known-findings.json',[]);
console.log(JSON.stringify({frozen:true,files:inputFiles.map(x=>({name:x.name,bytes:x.bytes,pages:x.pages})),audioSeconds:duration,plannedChunks:2,handoffFiles:71,starts:0,providerRequests:0}));
