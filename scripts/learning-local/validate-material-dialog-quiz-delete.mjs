import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chromium,expect as baseExpect} from '@playwright/test';
import {syntheticLearningPdf} from '../fixtures/learning-pdf.mjs';
import {syntheticLearningWav} from '../fixtures/learning-audio.mjs';
const expect=baseExpect.configure({timeout:45000}),repo=process.cwd(),root=path.resolve('output/playwright/learning-dialog-quiz-delete-'+Date.now()),slash=p=>p.replaceAll('\\','/');
fs.mkdirSync(root,{recursive:true});const before=fs.readFileSync('next-env.d.ts');
const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});}),base='http://127.0.0.1:'+port;
const env={};for(const[k,v]of Object.entries(process.env))if(/^(path|pathext|systemroot|windir|comspec|temp|tmp|userprofile|localappdata|appdata|homedrive|homepath)$/i.test(k))env[k]=v;
fs.writeFileSync(root+'/findings.json','[]');fs.writeFileSync(root+'/mock-control.json',JSON.stringify({pdfMode:'warning'}));fs.writeFileSync(root+'/tsconfig.json',JSON.stringify({extends:slash(repo+'/tsconfig.json'),compilerOptions:{incremental:false,baseUrl:slash(repo),paths:{'@/*':['./src/*']}},include:[slash(repo+'/src/**/*.ts'),slash(repo+'/src/**/*.tsx')],exclude:[slash(repo+'/node_modules')]}));
Object.assign(env,{APP_DATA_DIR:root+'/data',DATA_DIR:root+'/data',APP_STORAGE_MODE:'local',PIPELINE_EXECUTION_MODE:'inline',DAILY_BRIEF_INVITE_CODES:'synthetic-auto-only',DAILY_REFLECTION_UPLOAD_ENABLED:'true',WORK_REVIEW_ENABLED:'true',
  DAILY_BRIEF_E2E_DIST_DIR:slash(path.relative(repo,process.env.LEARNING_DIALOG_BROWSER_CACHE||root+'/next')),DAILY_BRIEF_E2E_TSCONFIG:slash(path.relative(repo,root+'/tsconfig.json')),
  LEARNING_AI_PROVIDER:'tokenhub',LEARNING_AI_MODEL:'deepseek-v4-pro',LEARNING_AI_MAX_INPUT_CHARS:'48000',LEARNING_AI_MAX_OUTPUT_TOKENS:'8000',OPENAI_BASE_URL:'https://tokenhub.vision-intelligence.tech/v1',LEARNING_VALIDATION_REPO:repo,LEARNING_FRAMEWORK_MOCK_OUTPUT:root,OPENAI_API_KEY:'SYNTHETIC_FRAMEWORK_NO_REAL_KEY',
  SPEAKER_ASR_BASE_URL:'https://company-asr.synthetic.invalid',SPEAKER_ASR_AUDIO_BASE_URL:base,LEARNING_ASR_AUDIO_CAPABILITY_SECRET:'SYNTHETIC_ONLY_LEARNING_SECRET_32_CHARACTERS',
  LEARNING_PDF_SERVICE_URL:'http://127.0.0.1:9',LEARNING_PDF_SERVICE_TOKEN:'SYNTHETIC_ONLY',LEARNING_PDF_KNOWN_FINDINGS_FILE:root+'/findings.json',NEXT_TELEMETRY_DISABLED:'1',
  NODE_OPTIONS:`--max-old-space-size=8192 --require="${slash(repo+'/scripts/learning-local/automatic-browser-mock.cjs')}"`});
const child=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','-p',String(port)],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
for(const s of[child.stdout,child.stderr])s.on('data',b=>fs.appendFileSync(root+'/next.log',String(b)));
let browser,code=0;const checks=[],errors=[];
const record=(f,v)=>fs.writeFileSync(root+'/'+f,JSON.stringify(v,null,2));
const pass=s=>{checks.push(s);console.log(`${checks.length}/${process.argv.includes('--full')?10:1} ${s}`);};
const count=f=>fs.existsSync(root+'/'+f)?fs.readFileSync(root+'/'+f,'utf8').trim().split('\n').length:0;
const processingCounts=()=>['mock-calls.jsonl','asr-mock-calls.jsonl','pdf-mock-calls.jsonl'].map(count);
try {
 const until=Date.now()+180000; let ready=false;
 while(Date.now()<until){assert(child.exitCode===null);try{ready=(await fetch(base+'/api/auth/me',{signal:AbortSignal.timeout(2000)})).status===401;if(ready)break;}catch{}await new Promise(r=>setTimeout(r,300));}assert(ready);
 browser=await chromium.launch({headless:true});const ctx=await browser.newContext({viewport:{width:1280,height:580},serviceWorkers:'block'}),page=await ctx.newPage();page.setDefaultTimeout(90000);page.setDefaultNavigationTimeout(180000);page.on('pageerror',e=>errors.push(e.message));
 const email='dialog-'+randomUUID()+'@synthetic.invalid',password='SYNTHETIC-only-pass-123';assert.equal((await ctx.request.post(base+'/api/auth/register',{data:{email,password,inviteCode:'synthetic-auto-only'}})).status(),201);
 const id=randomUUID();assert.equal((await ctx.request.post(base+'/api/learning/pages',{data:{id,title:'[合成测试] 材料进度滚动'}})).status(),200);await page.goto(`${base}/learning/${id}?view=materials`,{waitUntil:'domcontentloaded'});
 await page.getByLabel('添加文件',{exact:true}).setInputFiles(Array.from({length:13},(_,i)=>({name:`合成测试第${i+1}份材料_条件与案例说明.txt`,mimeType:'text/plain',buffer:Buffer.from('[合成测试] 满足适用前提时才可应用规则。')})));
 const dialog=page.getByRole('dialog',{name:'材料与进度',exact:true});await expect(dialog).toBeVisible();const metrics=[];
 for(const size of[{width:1280,height:580},{width:390,height:640}]){
  await page.setViewportSize(size);
  for(const beforeStyle of[true,false]){
   await dialog.evaluate((d,before)=>{d.style.gridTemplateRows=before?'none':'auto minmax(0, 1fr)';const b=d.querySelector(':scope > header + div');b.style.scrollbarGutter=before?'auto':'stable';b.style.overscrollBehavior=before?'auto':'contain';b.scrollTop=0;},beforeStyle);
   const before=await dialog.evaluate(d=>{const b=d.querySelector(':scope > header + div'),r=d.getBoundingClientRect(),br=b.getBoundingClientRect();return{dialog:{height:r.height,bottom:r.bottom,clientHeight:d.clientHeight,scrollHeight:d.scrollHeight,rows:getComputedStyle(d).gridTemplateRows},body:{height:br.height,bottom:br.bottom,clientHeight:b.clientHeight,scrollHeight:b.scrollHeight,overflowY:getComputedStyle(b).overflowY},pageY:scrollY};});
   const box=await dialog.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,6000);await page.waitForTimeout(400);
   const after=await dialog.evaluate(d=>{const b=d.querySelector(':scope > header + div');return{scrollTop:b.scrollTop,clientHeight:b.clientHeight,scrollHeight:b.scrollHeight,lastBottom:b.lastElementChild.getBoundingClientRect().bottom,bodyBottom:b.getBoundingClientRect().bottom,pageY:scrollY};});
   metrics.push({size,beforeStyle,before,after});record('scroll-metrics.json',metrics);console.log(JSON.stringify(metrics.at(-1)));await page.screenshot({path:root+`/draft-${size.width}-${beforeStyle?'before-style-replay':'current'}.png`,fullPage:true});
  }
 }
 record('identities.json',{id});pass('before-style versus current desktop/mobile actual wheel and dimensions measured; no processing started');
 if(process.argv.includes('--full')) {
  for(const metric of metrics.filter(m=>!m.beforeStyle)){assert(metric.after.scrollTop>0);assert(metric.after.scrollTop+metric.after.clientHeight>=metric.after.scrollHeight-2);assert(metric.after.lastBottom<=metric.before.dialog.bottom+1);}
  await page.setViewportSize({width:1280,height:580});await dialog.getByRole('button',{name:'开始整理 · 13 份',exact:true}).click();
  const read=async(url)=>{const response=await ctx.request.get(base+url);assert(response.ok(),await response.text());return response.json();};
  const courseUrl=`/api/learning/pages/${id}`;
  await expect.poll(async()=>(await read(courseUrl+'/preparation')).runs.at(-1)?.status,{timeout:90000}).toBe('completed');
  await expect(dialog.getByText('本次整理已完成',{exact:true})).toBeVisible();
  for(const size of[{width:1280,height:580},{width:390,height:640}]){
   await page.setViewportSize(size);await dialog.evaluate(d=>d.querySelector(':scope > header + div').scrollTop=0);const box=await dialog.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,6000);await page.waitForTimeout(400);
   const bounds=await dialog.evaluate(d=>{const b=d.querySelector(':scope > header + div');return{dialogBottom:d.getBoundingClientRect().bottom,scrollTop:b.scrollTop,clientHeight:b.clientHeight,scrollHeight:b.scrollHeight,lastBottom:b.lastElementChild.getBoundingClientRect().bottom};});
   assert(bounds.scrollTop>0);assert(bounds.scrollTop+bounds.clientHeight>=bounds.scrollHeight-2);assert(bounds.lastBottom<=bounds.dialogBottom+1);record(`saved-progress-${size.width}.json`,bounds);await page.screenshot({path:root+`/saved-progress-${size.width}.png`,fullPage:true});
  }pass('saved long progress list reaches bottom at desktop/mobile');
  await page.keyboard.press('Escape');await expect(dialog).toBeHidden();await page.getByRole('button',{name:/^材料进度/}).click();await expect(dialog.getByText('本次整理已完成',{exact:true})).toBeVisible();await page.keyboard.press('Escape');pass('close/reopen retains saved progress');
  await page.setViewportSize({width:1280,height:800});await page.getByRole('button',{name:'Quiz 练习',exact:true}).click();
  const groups=async()=>(await read(courseUrl+'/quiz')).quizzes;
  const generate=async mode=>{
   const ids=new Set((await groups()).map(q=>q.id));await page.getByLabel('题量',{exact:true}).fill('3');await page.getByRole('button',{name:'生成 Quiz',exact:true}).click();await expect(page.getByRole('button',{name:'开始作答',exact:true})).toBeVisible();
   if(mode==='test')await page.getByRole('radio',{name:/测验/}).check();await page.getByRole('button',{name:'开始作答',exact:true}).click();await expect(page.getByRole('article',{name:'当前作答'})).toBeVisible();await page.locator('input[type=radio][value]').first().click();await expect(page.locator('input[type=radio][value]').first()).toBeChecked();await expect(page.getByText('选择已保存',{exact:true})).toBeVisible();const group=(await groups()).find(q=>!ids.has(q.id));assert(group?.attemptId);return group;
  };
  const target=await generate('practice');await page.getByRole('button',{name:'题组与历史',exact:true}).click();await page.getByRole('button',{name:'生成另一组',exact:true}).click();const keep=await generate('test');
  const keepBefore=await read(courseUrl+'/quiz?attempt='+keep.attemptId),courseBefore=await read(courseUrl),frameworkBefore=await read(courseUrl+'/framework'),calls=count('mock-calls.jsonl');pass('two actual saved groups/attempts generated only by labelled in-memory mock');
  await page.getByRole('button',{name:'题组与历史',exact:true}).click();const rows=()=>page.locator('section[aria-label="单选 Quiz"] ul > li');
  const openTarget=async()=>{const index=(await groups()).findIndex(q=>q.id===target.id);assert(index>=0);await rows().nth(index).getByRole('button',{name:/^删除题组 /}).click();};
  await openTarget();let dd=page.getByRole('dialog',{name:/删除「/});await expect(dd.getByText(/全部作答记录/)).toBeVisible();await dd.getByRole('button',{name:'取消',exact:true}).click();assert.equal((await groups()).length,2);assert.equal((await ctx.request.get(base+courseUrl+'/quiz?attempt='+target.attemptId)).status(),200);pass('cancel retains group and attempt');
  let injected=0;await page.route('**'+courseUrl+'/quiz',r=>{if(r.request().method()==='DELETE'&&injected++===0)return r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'learning_storage_unavailable'})});return r.continue();});
  await openTarget();dd=page.getByRole('dialog',{name:/删除「/});await dd.getByRole('button',{name:'删除题组与记录',exact:true}).click();await expect(dd.getByRole('alert')).toBeVisible();assert.equal((await groups()).length,2);assert.equal((await ctx.request.get(base+courseUrl+'/quiz?attempt='+target.attemptId)).status(),200);await page.screenshot({path:root+'/delete-fault-injection.png',fullPage:true});pass('503 fault injection keeps data and retry dialog');
  await dd.getByRole('button',{name:'删除题组与记录',exact:true}).click();await expect(dd).toBeHidden();await expect(page.getByText('题组及其作答记录已删除。',{exact:true})).toBeVisible();assert.equal((await groups()).length,1);assert.equal((await groups())[0].id,keep.id);assert([404,410].includes((await ctx.request.get(base+courseUrl+'/quiz?attempt='+target.attemptId)).status()));assert.deepEqual(await read(courseUrl+'/quiz?attempt='+keep.attemptId),keepBefore);assert.deepEqual(await read(courseUrl),courseBefore);assert.deepEqual(await read(courseUrl+'/framework'),frameworkBefore);pass('confirmed deletion removes group/attempt and preserves other attempt/materials/framework');
  await page.reload({waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'题组与历史',exact:true}).click();await expect(rows()).toHaveCount(1);await ctx.request.post(base+'/api/auth/logout');assert.equal((await ctx.request.get(base+courseUrl+'/quiz')).status(),401);assert.equal((await ctx.request.post(base+'/api/auth/login',{data:{email,password}})).status(),200);await page.goto(`${base}/learning/${id}?view=quiz`,{waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'题组与历史',exact:true}).click();await expect(rows()).toHaveCount(1);assert.equal((await groups())[0].id,keep.id);assert([404,410].includes((await ctx.request.get(base+courseUrl+'/quiz?attempt='+target.attemptId)).status()));pass('refresh/relogin cannot revive removed group and attempt');
  await page.setViewportSize({width:390,height:640});await page.getByRole('button',{name:/^删除题组 /}).click();await expect(page.getByRole('button',{name:'删除题组与记录',exact:true})).toBeVisible();await page.screenshot({path:root+'/delete-confirm-mobile.png',fullPage:true});await page.getByRole('button',{name:'取消',exact:true}).click();pass('mobile consequence and delete actions visible');
  assert.equal(count('mock-calls.jsonl'),calls);assert.equal(count('asr-mock-calls.jsonl'),0);assert.equal(count('pdf-mock-calls.jsonl'),0);assert.deepEqual(errors,[]);pass('actions/delete/retry produce zero additional model/ASR/OCR calls');record('identities.json',{id,targetQuizId:target.id,targetAttemptId:target.attemptId,keptQuizId:keep.id,keptAttemptId:keep.attemptId});
 }
}catch(e){code=1;record('failure.json',{message:e.message,stack:e.stack,errors});console.error(e.message);}
finally{await browser?.close();if(child.exitCode===null)spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});if(fs.readFileSync('next-env.d.ts','utf8').includes('learning-dialog-quiz-delete-'))fs.writeFileSync('next-env.d.ts',before);record('result.json',{code,checks,errors,realProviders:0});console.log(root);process.exitCode=code;}
