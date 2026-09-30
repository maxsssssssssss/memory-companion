import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chromium,expect as baseExpect} from '@playwright/test';
import {syntheticLearningPdf} from '../fixtures/learning-pdf.mjs';
import {syntheticLearningWav} from '../fixtures/learning-audio.mjs';
const expect=baseExpect.configure({timeout:45000}),repo=process.cwd(),root=path.resolve('output/playwright/learning-upload-auto-'+Date.now()),slash=p=>p.replaceAll('\\','/');
fs.mkdirSync(root,{recursive:true});const before=fs.readFileSync('next-env.d.ts');
const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});}),base='http://127.0.0.1:'+port;
const env={};for(const[k,v]of Object.entries(process.env))if(/^(path|pathext|systemroot|windir|comspec|temp|tmp|userprofile|localappdata|appdata|homedrive|homepath)$/i.test(k))env[k]=v;
fs.writeFileSync(root+'/findings.json','[]');fs.writeFileSync(root+'/tsconfig.json',JSON.stringify({extends:slash(repo+'/tsconfig.json'),compilerOptions:{incremental:false,baseUrl:slash(repo),paths:{'@/*':['./src/*']}},include:[slash(repo+'/src/**/*.ts'),slash(repo+'/src/**/*.tsx')],exclude:[slash(repo+'/node_modules')]}));
Object.assign(env,{APP_DATA_DIR:root+'/data',DATA_DIR:root+'/data',APP_STORAGE_MODE:'local',PIPELINE_EXECUTION_MODE:'inline',DAILY_BRIEF_INVITE_CODES:'synthetic-auto-only',DAILY_REFLECTION_UPLOAD_ENABLED:'true',WORK_REVIEW_ENABLED:'true',
  DAILY_BRIEF_E2E_DIST_DIR:slash(path.relative(repo,root+'/next')),DAILY_BRIEF_E2E_TSCONFIG:slash(path.relative(repo,root+'/tsconfig.json')),
  LEARNING_VALIDATION_REPO:repo,LEARNING_FRAMEWORK_MOCK_OUTPUT:root,OPENAI_API_KEY:'SYNTHETIC_FRAMEWORK_NO_REAL_KEY',
  SPEAKER_ASR_BASE_URL:'https://company-asr.synthetic.invalid',SPEAKER_ASR_AUDIO_BASE_URL:base,LEARNING_ASR_AUDIO_CAPABILITY_SECRET:'SYNTHETIC_ONLY_LEARNING_SECRET_32_CHARACTERS',
  LEARNING_PDF_SERVICE_URL:'http://127.0.0.1:9',LEARNING_PDF_SERVICE_TOKEN:'SYNTHETIC_ONLY',LEARNING_PDF_KNOWN_FINDINGS_FILE:root+'/findings.json',NEXT_TELEMETRY_DISABLED:'1',
  NODE_OPTIONS:`--max-old-space-size=8192 --require="${slash(repo+'/scripts/learning-local/upload-browser-mock.cjs')}"`});
const child=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','-p',String(port)],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
for(const s of[child.stdout,child.stderr])s.on('data',b=>fs.appendFileSync(root+'/next.log',String(b)));
let browser,code=0;const checks=[],errors=[];
const record=(f,v)=>fs.writeFileSync(root+'/'+f,JSON.stringify(v,null,2));
const pass=s=>{checks.push(s);console.log(`${checks.length}/8 ${s}`);};
const count=f=>fs.existsSync(root+'/'+f)?fs.readFileSync(root+'/'+f,'utf8').trim().split('\n').length:0;
try {
  const until=Date.now()+180000;let ready=false;
  while(Date.now()<until){assert(child.exitCode===null);try{ready=(await fetch(base+'/api/auth/me',{signal:AbortSignal.timeout(2000)})).status===401;if(ready)break;}catch{}await new Promise(r=>setTimeout(r,300));}assert(ready);
  browser=await chromium.launch({headless:true});const ctx=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'}),page=await ctx.newPage();page.setDefaultTimeout(45000);page.on('pageerror',e=>errors.push(e.message));
  const email='automatic-'+randomUUID()+'@synthetic.invalid',password='SYNTHETIC-only-pass-123';
  assert.equal((await ctx.request.post(base+'/api/auth/register',{data:{email,password,inviteCode:'synthetic-auto-only'}})).status(),201);
  await page.goto(base+'/');for(const title of['约会陪伴','日常复盘','工作复盘','学习整理'])await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();pass('four product entries reachable');
  await page.goto(base+'/learning');await page.getByLabel('学习页名称').fill('[合成自动处理验收]');await page.getByRole('button',{name:'创建学习页',exact:true}).click();
  await page.getByRole('button',{name:'材料',exact:true}).click();const pageId=new URL(page.url()).pathname.split('/').at(-1),url=base+'/learning/'+pageId+'?view=materials';
  await page.getByLabel('添加已有录音').setInputFiles({name:'SYNTHETIC-auto.wav',mimeType:'audio/wav',buffer:syntheticLearningWav()});
  await page.getByLabel('添加 PDF',{exact:true}).setInputFiles({name:'SYNTHETIC-auto.pdf',mimeType:'application/pdf',buffer:syntheticLearningPdf()});
  await expect(page.getByLabel('保存后自动解析 PDF、转写录音')).toBeChecked();
  await page.getByRole('button',{name:'上传并处理 · 2 份'}).click();await expect(page.getByText(/已保存：2\/2/)).toBeVisible();
  await expect(page.getByRole('region',{name:'录音转写'})).toContainText('转写已保存');
  await expect(page.locator('summary').filter({hasText:'PDF 解析与学习范围 · SYNTHETIC-auto'})).toContainText('解析未完成');
  assert.equal(count('asr-mock-calls.jsonl'),1);assert.equal(count('pdf-mock-calls.jsonl'),1);pass('one confirmation starts ASR and PDF; mock failure keeps original');
  await page.screenshot({path:root+'/automatic-desktop.png',fullPage:true});
  const stored=(await(await ctx.request.get(base+'/api/learning/pages/'+pageId)).json()).page;
  const pdf=stored.materials.find(m=>m.kind==='pdf');assert.equal((await ctx.request.get(`${base}/api/learning/pages/${pageId}/materials/${pdf.id}/pdf`)).status(),200);
  const form=new FormData();form.set('prepare','yes');form.set('materials',JSON.stringify(stored.materials.map(({id,title,kind})=>({id,title,kind}))));
  for(const m of stored.materials)form.append('files',new Blob([m.kind==='pdf'?syntheticLearningPdf():syntheticLearningWav()]),m.filename);
  const cookie=(await ctx.cookies()).map(c=>c.name+'='+c.value).join(';');assert.equal((await fetch(base+'/api/learning/pages/'+pageId+'/materials',{method:'POST',headers:{cookie,origin:base},body:form})).status,200);
  assert.equal(count('asr-mock-calls.jsonl'),1);assert.equal(count('pdf-mock-calls.jsonl'),1);pass('retrying saved batch does not repeat provider requests');
  await page.getByLabel('添加已有录音').setInputFiles({name:'SYNTHETIC-save-only.wav',mimeType:'audio/wav',buffer:syntheticLearningWav()});await page.getByLabel('保存后自动解析 PDF、转写录音').uncheck();await page.getByRole('button',{name:'只保存 · 1 份'}).click();await expect(page.getByText('已保存：1/1',{exact:true})).toBeVisible();assert.equal(count('asr-mock-calls.jsonl'),1);pass('explicit save-only has no provider request');
  await page.getByLabel('添加 PDF',{exact:true}).setInputFiles({name:'SYNTHETIC-31-pages.pdf',mimeType:'application/pdf',buffer:syntheticLearningPdf({pages:31})});await page.getByLabel('保存后自动解析 PDF、转写录音').check();await page.getByRole('button',{name:'上传并处理 · 1 份'}).click();await expect(page.getByText(/SYNTHETIC-31-pages：已保存，请在下方选择/)).toBeVisible();assert.equal(count('pdf-mock-calls.jsonl'),1);pass('31 pages saved with explicit range requirement, no silent truncation');
  await page.reload();await expect(page.getByRole('region',{name:'录音转写'})).toContainText('转写已保存');await page.getByRole('button',{name:'查看原文 SYNTHETIC-auto.wav',exact:true}).click();await expect(page.getByText(/0–0.4 秒/)).toBeVisible();await page.getByRole('button',{name:'关闭原文'}).click();
  await ctx.request.post(base+'/api/auth/logout');await ctx.request.post(base+'/api/auth/login',{data:{email,password}});await page.goto(url);await expect(page.getByRole('region',{name:'录音转写'})).toContainText('转写已保存');pass('refresh and relogin preserve transcript and sources without new calls');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:root+'/automatic-mobile.png',fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));pass('mobile controls fit');
  await ctx.request.delete(base+'/api/learning/pages/'+pageId);assert.equal((await ctx.request.get(`${base}/api/learning/pages/${pageId}/materials/${pdf.id}/pdf`)).status(),410);
  assert.equal(count('asr-mock-calls.jsonl'),1);assert.equal(count('pdf-mock-calls.jsonl'),1);assert.equal(count('mock-calls.jsonl'),0);assert.deepEqual(errors,[]);pass('isolated deletion; no generation or real Provider calls');
}catch(e){code=1;record('failure.json',{message:e.message,stack:e.stack,errors});console.error(e.message);}
finally{await browser?.close();if(child.exitCode===null)spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});if(fs.readFileSync('next-env.d.ts','utf8').includes('learning-upload-auto-'))fs.writeFileSync('next-env.d.ts',before);record('result.json',{code,checks,errors,asrMock:count('asr-mock-calls.jsonl'),pdfFailureMock:count('pdf-mock-calls.jsonl'),realProviders:0});console.log(root);process.exitCode=code;}
