// Saved-data browser check after stopping and restarting only this local application.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium,expect as check} from '@playwright/test';
import {root,base,save,vault} from './runtime.mjs';
const secure=vault('read'),count=()=>fs.readdirSync(root).filter(f=>/^ds-request-\d+\.json$/.test(f)).length;
const before=count(),expect=check.configure({timeout:90000}),results=[];
const browser=await chromium.launch({headless:true}),ctx=await browser.newContext({viewport:{width:1440,height:1080},serviceWorkers:'block'}),tab=await ctx.newPage(),errors=[];
tab.on('pageerror',e=>errors.push(e.message));await ctx.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
const login=async()=>assert.equal((await ctx.request.post(base+'/api/auth/login',{data:{email:secure.email,password:secure.password}})).status(),200);
try{
 await login();
 for(const [label,file] of [['practice',fs.existsSync(root+'/restart-one-B1-result.json')?'restart-one-B1-result.json':'practice-open-B1-result.json'],['test','test-complete-A2-result.json']]){
  const saved=JSON.parse(fs.readFileSync(root+'/'+file)),pageId=new URL(saved.url).pathname.split('/').at(-1);
  await tab.goto(saved.url);const quiz=tab.getByRole('region',{name:'单选 Quiz',exact:true});await expect(quiz).toBeVisible();
  if(label==='test')await expect(quiz.getByLabel('本次结果',{exact:true})).toBeVisible();else await expect(quiz.getByRole('article',{name:'当前作答'})).toBeVisible();
  const read=async()=>tab.evaluate(async url=>{const r=await fetch(url);return{status:r.status,body:await r.json()};},'/api/learning/pages/'+pageId+'/quiz?attempt='+saved.attempt.id);
  const result=await read();assert.equal(result.status,200);assert.deepEqual(result.body.attempt,saved.attempt);
  await tab.screenshot({path:root+'/screenshots/restart-'+label+'.png',fullPage:true});
  if(label==='test'){
   await quiz.locator('details > summary').filter({hasText:'第 1 题'}).click();
   await quiz.getByRole('button',{name:/原材料.*第 2 段/}).first().click();
   const source=tab.getByRole('region',{name:'材料原文',exact:true});await expect(source).toBeVisible();
   await expect(source).toContainText('申请前必须同时完成排版检查并拿到教师的绿色确认卡');
   await tab.screenshot({path:root+'/screenshots/restart-text-source.png',fullPage:true});
   await tab.getByRole('button',{name:'关闭原文',exact:true}).click();
  }
  results.push({label,attemptId:saved.attempt.id,completed:saved.attempt.completed,unchanged:true});
 }
 assert.equal(count(),before);assert.deepEqual(errors,[]);save('restart-readback.json',{status:'PASS',results,dsBefore:before,dsAfter:count(),pageErrors:errors});console.log(JSON.stringify({status:'PASS',reopened:results.length,requests:count()}));
}catch(e){save('restart-failure.json',{message:String(e.message).split('Call log:')[0]});console.error('Restart browser check failed; see isolated evidence');process.exitCode=1;}
finally{await browser.close();save('restart-browser-exit.json',{exitCode:process.exitCode??0,browserClosed:true});}
