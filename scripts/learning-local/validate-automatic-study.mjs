import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chromium,expect as baseExpect} from '@playwright/test';
import {syntheticLearningPdf} from '../fixtures/learning-pdf.mjs';
import {syntheticLearningWav} from '../fixtures/learning-audio.mjs';
const expect=baseExpect.configure({timeout:45000}),repo=process.cwd(),root=path.resolve('output/playwright/learning-automatic-study-'+Date.now()),slash=p=>p.replaceAll('\\','/');
fs.mkdirSync(root,{recursive:true});const before=fs.readFileSync('next-env.d.ts');
const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});}),base='http://127.0.0.1:'+port;
const env={};for(const[k,v]of Object.entries(process.env))if(/^(path|pathext|systemroot|windir|comspec|temp|tmp|userprofile|localappdata|appdata|homedrive|homepath)$/i.test(k))env[k]=v;
fs.writeFileSync(root+'/findings.json','[]');fs.writeFileSync(root+'/mock-control.json',JSON.stringify({pdfMode:'warning'}));fs.writeFileSync(root+'/tsconfig.json',JSON.stringify({extends:slash(repo+'/tsconfig.json'),compilerOptions:{incremental:false,baseUrl:slash(repo),paths:{'@/*':['./src/*']}},include:[slash(repo+'/src/**/*.ts'),slash(repo+'/src/**/*.tsx')],exclude:[slash(repo+'/node_modules')]}));
Object.assign(env,{APP_DATA_DIR:root+'/data',DATA_DIR:root+'/data',APP_STORAGE_MODE:'local',PIPELINE_EXECUTION_MODE:'inline',DAILY_BRIEF_INVITE_CODES:'synthetic-auto-only',DAILY_REFLECTION_UPLOAD_ENABLED:'true',WORK_REVIEW_ENABLED:'true',
  DAILY_BRIEF_E2E_DIST_DIR:slash(path.relative(repo,root+'/next')),DAILY_BRIEF_E2E_TSCONFIG:slash(path.relative(repo,root+'/tsconfig.json')),
  LEARNING_AI_PROVIDER:'tokenhub',LEARNING_AI_MODEL:'deepseek-v4-pro',LEARNING_AI_MAX_INPUT_CHARS:'48000',LEARNING_AI_MAX_OUTPUT_TOKENS:'8000',OPENAI_BASE_URL:'https://tokenhub.vision-intelligence.tech/v1',LEARNING_VALIDATION_REPO:repo,LEARNING_FRAMEWORK_MOCK_OUTPUT:root,OPENAI_API_KEY:'SYNTHETIC_FRAMEWORK_NO_REAL_KEY',
  SPEAKER_ASR_BASE_URL:'https://company-asr.synthetic.invalid',SPEAKER_ASR_AUDIO_BASE_URL:base,LEARNING_ASR_AUDIO_CAPABILITY_SECRET:'SYNTHETIC_ONLY_LEARNING_SECRET_32_CHARACTERS',
  LEARNING_PDF_SERVICE_URL:'http://127.0.0.1:9',LEARNING_PDF_SERVICE_TOKEN:'SYNTHETIC_ONLY',LEARNING_PDF_KNOWN_FINDINGS_FILE:root+'/findings.json',NEXT_TELEMETRY_DISABLED:'1',
  NODE_OPTIONS:`--max-old-space-size=8192 --require="${slash(repo+'/scripts/learning-local/automatic-browser-mock.cjs')}"`});
const child=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','-p',String(port)],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
for(const s of[child.stdout,child.stderr])s.on('data',b=>fs.appendFileSync(root+'/next.log',String(b)));
let browser,code=0;const checks=[],errors=[];
const record=(f,v)=>fs.writeFileSync(root+'/'+f,JSON.stringify(v,null,2));
const pass=s=>{checks.push(s);console.log(`${checks.length}/17 ${s}`);};
const count=f=>fs.existsSync(root+'/'+f)?fs.readFileSync(root+'/'+f,'utf8').trim().split('\n').length:0;
const processingCounts=()=>['mock-calls.jsonl','asr-mock-calls.jsonl','pdf-mock-calls.jsonl'].map(count);
try {
  const until=Date.now()+180000;let ready=false;
  while(Date.now()<until){assert(child.exitCode===null);try{ready=(await fetch(base+'/api/auth/me',{signal:AbortSignal.timeout(2000)})).status===401;if(ready)break;}catch{}await new Promise(r=>setTimeout(r,300));}assert(ready);
  browser=await chromium.launch({headless:true});const ctx=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'}),page=await ctx.newPage();page.setDefaultTimeout(45000);page.on('pageerror',e=>errors.push(e.message));
  const email='automatic-'+randomUUID()+'@synthetic.invalid',password='SYNTHETIC-only-pass-123';
  assert.equal((await ctx.request.post(base+'/api/auth/register',{data:{email,password,inviteCode:'synthetic-auto-only'}})).status(),201);
  await page.goto(base+'/');for(const title of['约会陪伴','日常复盘','工作复盘','学习整理'])await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();pass('four entries preserved');
  const newPage=async title=>{const id=randomUUID();assert.equal((await ctx.request.post(base+'/api/learning/pages',{data:{id,title}})).status(),200);return id;};
  const materialDialog=()=>page.getByRole('dialog',{name:'材料与进度',exact:true});
  const reopenMaterials=async()=>{await page.getByRole('button',{name:/^材料进度/}).click();await expect(materialDialog()).toBeVisible();};
  const fitsViewport=async()=>assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
  const keyboardDialog=async()=>{
    await materialDialog().getByRole('button',{name:'关闭',exact:true}).focus();
    for(let step=0;step<24;step++){await page.keyboard.press('Tab');assert(await materialDialog().evaluate(dialog=>dialog.contains(document.activeElement)),'Tab must remain in the material dialog');}
    await page.keyboard.press('Escape');await expect(materialDialog()).toBeHidden();await expect(page.getByRole('button',{name:/^材料进度/})).toBeFocused();await reopenMaterials();
  };
  let chooserVerified=false;
  const upload=async(id,files,intent='organize')=>{
    await page.goto(`${base}/learning/${id}?view=materials`);
    await expect(page.getByRole('heading',{name:'让材料，连成知识',exact:true})).toBeVisible();
    if(!chooserVerified)await page.screenshot({path:root+'/material-welcome-desktop.png',fullPage:true});
    const beforeCalls=processingCounts();
    const beforeMaterials=(await(await ctx.request.get(`${base}/api/learning/pages/${id}`)).json()).page.materials.length;
    await page.getByLabel('添加文件',{exact:true}).setInputFiles(files);
    await expect(materialDialog()).toBeVisible();
    await expect(materialDialog().getByRole('heading',{name:`等待确认 · ${files.length} 份材料`,exact:true})).toBeVisible();
    assert.deepEqual(processingCounts(),beforeCalls);
    assert.equal((await(await ctx.request.get(`${base}/api/learning/pages/${id}`)).json()).page.materials.length,beforeMaterials);
    await page.keyboard.press('Escape');await expect(materialDialog()).toBeHidden();
    await reopenMaterials();
    await expect(materialDialog().getByRole('heading',{name:`等待确认 · ${files.length} 份材料`,exact:true})).toBeVisible();
    if(!chooserVerified){
      await keyboardDialog();
      await page.screenshot({path:root+'/material-chooser-desktop.png',fullPage:true});
      await page.setViewportSize({width:390,height:844});await fitsViewport();await page.screenshot({path:root+'/material-chooser-mobile.png',fullPage:true});
      await page.setViewportSize({width:1440,height:1000});chooserVerified=true;
      pass('file selection opens confirmation; close/reopen retains drafts without save, OCR, ASR or generation');
    }
    if(intent!=='organize'){await page.locator('summary').filter({hasText:'其他整理方式'}).click();await page.getByLabel('完成后',{exact:true}).selectOption(intent);}
    await page.getByRole('button',{name:`${intent==='organize'?'开始整理':intent==='save'?'只保存':'准备材料'} · ${files.length} 份`,exact:true}).click();
    await expect(page.getByText(new RegExp(`已保存：${files.length}/${files.length}`))).toBeVisible();
  };
  const runs=async id=>(await(await ctx.request.get(`${base}/api/learning/pages/${id}/preparation`)).json()).runs;
  const waitRun=async(id,status)=>{await expect.poll(async()=>(await runs(id)).at(-1)?.status,{timeout:90000}).toBe(status);return (await runs(id)).at(-1);};
  const textFile={name:'合成学习材料.txt',mimeType:'text/plain',buffer:Buffer.from('[合成测试] 磁性并非所有金属共有。\n\n[合成测试] 满足适用条件才可使用规则。')};
  const first=await newPage('[合成测试] 自动学习');await upload(first,[textFile]);
  await waitRun(first,'completed');const firstFramework=(await(await ctx.request.get(`${base}/api/learning/pages/${first}/framework`)).json()).framework;assert(firstFramework.chapters.length>0);assert.equal(count('mock-calls.jsonl'),1);
  await page.goto(`${base}/learning/${first}?view=read`);await expect(page.getByRole('heading',{name:'知识框架',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'[模拟生成] 第 1 段知识点',exact:true})).toBeVisible();await page.screenshot({path:root+'/framework-desktop.png',fullPage:true});pass('one upload confirmation publishes framework without scope or second generate click');
  await page.reload();await ctx.request.post(base+'/api/auth/logout');await ctx.request.post(base+'/api/auth/login',{data:{email,password}});await page.goto(`${base}/learning/${first}?view=read`);await expect(page.getByRole('heading',{name:'[模拟生成] 第 1 段知识点',exact:true})).toBeVisible();assert.equal(count('mock-calls.jsonl'),1);pass('refresh and relogin read saved framework without regenerating');
  const mixed=await newPage('[合成测试] 局部缺失');await upload(mixed,[textFile,{name:'合成课件.pdf',mimeType:'application/pdf',buffer:syntheticLearningPdf({pages:3})},{name:'合成录音.wav',mimeType:'audio/wav',buffer:syntheticLearningWav()}]);
  await expect(materialDialog().getByText('正在准备学习材料',{exact:true})).toBeVisible();
  await page.keyboard.press('Escape');await expect(materialDialog()).toBeHidden();
  const pending=await waitRun(mixed,'needs_attention');assert.equal(count('mock-calls.jsonl'),1);assert(pending.materials.some(m=>m.kind==='audio'&&m.status==='ready'));assert(pending.materials.some(m=>m.kind==='pdf'&&m.status==='partial'));
  await expect(page.getByRole('button',{name:/^材料进度.*需要处理$/})).toBeVisible();await reopenMaterials();
  await keyboardDialog();
  pass('closing active progress keeps background work and polling; attention status reopens the same run');
  await expect(page.getByRole('button',{name:'先整理可用部分',exact:true})).toBeVisible();await expect(materialDialog().getByText(/转写完成/)).toBeVisible();await page.screenshot({path:root+'/partial-desktop.png',fullPage:true});pass('mixed preparation exposes partial coverage and completed audio; no premature generation');
  const actionColors=await materialDialog().getByRole('button',{name:'先整理可用部分',exact:true}).evaluate(primary=>({primary:getComputedStyle(primary).backgroundColor,secondary:getComputedStyle([...primary.parentElement.querySelectorAll('button')].find(button=>button.textContent==='继续处理')).backgroundColor}));assert.notEqual(actionColors.primary,actionColors.secondary);
  await page.setViewportSize({width:390,height:844});await fitsViewport();await page.screenshot({path:root+'/partial-mobile.png',fullPage:true});await page.setViewportSize({width:1440,height:1000});
  pass('partial decision has distinct primary and secondary actions; progress dialog fits 390px');
  await page.getByRole('button',{name:'先整理可用部分',exact:true}).click();await waitRun(mixed,'completed');assert.equal(count('mock-calls.jsonl'),2);const mixedPage=(await(await ctx.request.get(`${base}/api/learning/pages/${mixed}`)).json()).page;const pdf=mixedPage.materials.find(m=>m.kind==='pdf');assert.deepEqual(pdf.pdfStudy.physicalPages,[1]);assert.equal(pdf.pdfStudy.authorization,'automatic');
  const mixedFramework=(await(await ctx.request.get(`${base}/api/learning/pages/${mixed}/framework`)).json()).framework;assert.equal(new Set(mixedFramework.chapters.flatMap(c=>c.nodes.flatMap(n=>n.sources.map(s=>s.materialId)))).size,3);pass('single partial decision prepares scope and jointly organizes all three synthetic sources');
  await page.goto(`${base}/learning/${mixed}?view=read`);await expect(page.locator('section[aria-label="知识框架"] article:visible').first()).toBeVisible();await page.screenshot({path:root+'/mixed-framework.png',fullPage:true});
  const source=mixedFramework.chapters.flatMap(c=>c.nodes).flatMap(n=>n.sources).find(s=>s.parsed);assert.equal(source.parsed.physicalPage,1);assert.equal((await ctx.request.get(`${base}/api/learning/pages/${mixed}/materials/${pdf.id}/parsed?document=${source.parsed.documentId}&block=${source.parsed.blockId}`)).status(),200);assert.equal((await ctx.request.get(`${base}/api/learning/pages/${mixed}/materials/${pdf.id}/pdf`)).status(),200);
  const pdfChapter=mixedFramework.chapters.findIndex(c=>c.nodes.some(n=>n.sources.some(s=>s.parsed)));await page.getByRole('navigation',{name:'章节目录',exact:true}).getByRole('button').nth(pdfChapter).click();await page.locator('section[aria-label="知识框架"] article:visible').first().locator('summary').filter({hasText:/^引用/}).click();await page.getByRole('button',{name:/第 1 物理页 · 来源区域/}).filter({visible:true}).first().click();await expect(page.locator('canvas[data-physical-page="1"]')).toHaveAttribute('data-ready','true');await page.screenshot({path:root+'/pdf-source.png',fullPage:true});await page.getByRole('button',{name:'关闭原文',exact:true}).click();pass('source drawer renders stored PDF physical page and region with private original access');
  const direct=await newPage('[合成测试] 直接练习');await upload(direct,[textFile],'prepare');await waitRun(direct,'completed');assert.equal((await(await ctx.request.get(`${base}/api/learning/pages/${direct}/framework`)).json()).framework.chapters.length,0);const beforeQuiz=count('mock-calls.jsonl');
  await page.goto(`${base}/learning/${direct}?view=quiz`);await page.getByRole('button',{name:'生成 Quiz',exact:true}).click();await expect(page.getByRole('button',{name:'开始作答',exact:true})).toBeVisible();assert.equal(count('mock-calls.jsonl'),beforeQuiz+1);pass('prepare-only keeps framework absent and direct Quiz independent');
  await page.getByRole('button',{name:'开始作答',exact:true}).click();await page.getByRole('button',{name:'提示',exact:true}).click();await page.getByRole('button',{name:'跳过本题',exact:true}).click();const attemptUrl=page.url();await page.reload();await expect(page.getByRole('heading',{name:'练习',exact:true})).toBeVisible();await page.screenshot({path:root+'/quiz-resume.png',fullPage:true});assert.equal(count('mock-calls.jsonl'),beforeQuiz+1);pass('practice actions and refresh resume do not regenerate');
  await page.getByRole('button',{name:'题组与历史',exact:true}).click();await page.getByRole('button',{name:'生成另一组',exact:true}).click();await page.getByRole('button',{name:'生成 Quiz',exact:true}).click();await expect(page.getByRole('button',{name:'开始作答',exact:true})).toBeVisible();await page.getByRole('radio',{name:/测验/}).check();await page.getByRole('button',{name:'开始作答',exact:true}).click();
  await expect(page.getByRole('heading',{name:'测验',exact:true})).toBeVisible();
  for(let question=0;question<3;question++){await expect(page.getByText(new RegExp(`第 ${question+1}/3 题`))).toBeVisible();const option=page.locator('input[type="radio"][value]').first();await option.click();await expect(option).toBeChecked();await expect(page.getByText('选择已保存',{exact:true})).toBeVisible();await expect(page.getByText('各选项说明',{exact:true})).toHaveCount(0);if(question<2)await page.getByRole('button',{name:'下一题',exact:true}).click();}
  await page.getByRole('button',{name:'交卷并查看结果',exact:true}).click();await expect(page.getByRole('heading',{name:'本次结果',exact:true})).toBeVisible();await page.reload();await ctx.request.post(base+'/api/auth/logout');await ctx.request.post(base+'/api/auth/login',{data:{email,password}});await page.goto(page.url());await expect(page.getByText(/本次答对 \d\/3 题/)).toBeVisible();assert.equal(count('mock-calls.jsonl'),beforeQuiz+2);await page.screenshot({path:root+'/test-results.png',fullPage:true});pass('multi-question test hides answers until finish and keeps results after relogin');
  const reviews=page.locator('details[aria-label$="题回顾"]');await expect(reviews).toHaveCount(3);assert.deepEqual(await reviews.evaluateAll(items=>items.map(item=>item.open)),[false,false,false]);
  await expect(page.getByText('你的选择',{exact:true}).first()).toBeHidden();await reviews.first().locator(':scope > summary').click();
  await expect(reviews.first().getByText('你的选择',{exact:true})).toBeVisible();await expect(reviews.first().getByText('[合成测试 1] 不满足规则的适用前提时，应如何判断？',{exact:true}).last()).toBeVisible();
  assert.deepEqual(await reviews.first().locator('details').evaluateAll(items=>items.map(item=>item.open)),[false,false]);
  await reviews.first().locator('summary').filter({hasText:/引用/}).click();await expect(reviews.first().getByRole('button',{name:/第 .*段/}).first()).toBeVisible();
  await page.screenshot({path:root+'/test-results-expanded-desktop.png',fullPage:true});pass('results default to compact closed rows; expanded review keeps full stem and separately folded explanation and sources');
  await page.setViewportSize({width:390,height:844});await fitsViewport();await page.screenshot({path:root+'/test-results-expanded-mobile.png',fullPage:true});await reviews.first().locator(':scope > summary').click();await page.screenshot({path:root+'/test-results-collapsed-mobile.png',fullPage:true});await page.setViewportSize({width:1440,height:1000});
  assert.equal(count('mock-calls.jsonl'),beforeQuiz+2);pass('mobile result rows fit; expanding answers and sources makes no model request');
  const saveOnly=await newPage('[合成测试] 只保存');const beforeSave=count('mock-calls.jsonl');await upload(saveOnly,[textFile],'save');assert.equal((await runs(saveOnly)).length,0);assert.equal(count('mock-calls.jsonl'),beforeSave);pass('explicit save-only creates no processing or generation intent');
  await page.keyboard.press('Escape');
  await page.locator('summary').filter({hasText:'粘贴文本或笔记'}).click();
  await page.getByLabel('文本标题',{exact:true}).fill('[合成测试] 待保存课堂笔记');await page.getByLabel('粘贴文本',{exact:true}).fill('[合成测试] 暂存在页面内的笔记，不应触发生成。');
  const beforePasted=processingCounts();await page.getByRole('button',{name:'加入本次材料',exact:true}).click();await expect(materialDialog()).toBeVisible();
  await page.keyboard.press('Escape');await reopenMaterials();await expect(materialDialog().getByText('[合成测试] 待保存课堂笔记',{exact:true})).toBeVisible();assert.deepEqual(processingCounts(),beforePasted);
  await materialDialog().getByRole('button',{name:'移除待保存材料 [合成测试] 待保存课堂笔记',exact:true}).click();await page.keyboard.press('Escape');
  pass('pasted notes open the same confirmation dialog and retain unsaved draft only in this page');
  await page.setViewportSize({width:390,height:844});await page.goto(`${base}/learning/${mixed}?view=read`);await expect(page.locator('section[aria-label="知识框架"] article:visible').first()).toBeVisible();await page.screenshot({path:root+'/framework-mobile.png',fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
  await ctx.request.delete(`${base}/api/learning/pages/${mixed}/materials/${pdf.id}`);assert.equal((await ctx.request.get(`${base}/api/learning/pages/${mixed}/materials/${pdf.id}/pdf`)).status(),410);assert.equal((await(await ctx.request.get(`${base}/api/learning/pages/${mixed}/framework`)).json()).framework.chapters.length,mixedFramework.chapters.length);assert.deepEqual(errors,[]);pass('mobile fits; source deletion keeps saved learning results and invalidates original');
  record('identities.json',{first,mixed,direct,saveOnly,attemptUrl});
}catch(e){code=1;record('failure.json',{message:e.message,stack:e.stack,errors});console.error(e.message);}
finally{await browser?.close();if(child.exitCode===null)spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});if(fs.readFileSync('next-env.d.ts','utf8').includes('learning-automatic-study-'))fs.writeFileSync('next-env.d.ts',before);record('result.json',{code,checks,errors,asrMock:count('asr-mock-calls.jsonl'),pdfMock:count('pdf-mock-calls.jsonl'),generationMock:count('mock-calls.jsonl'),realProviders:0});console.log(root);process.exitCode=code;}
