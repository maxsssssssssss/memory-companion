// Opens only this retained local snapshot; credentials never leave the process.
import fs from 'node:fs';import assert from 'node:assert/strict';import {chromium} from '@playwright/test';import {root,base,vault} from './runtime.mjs';
const secure=vault('read'),session=JSON.parse(fs.readFileSync(root+'/session.json','utf8'));
const selection=process.argv[2]??'B1';assert(['A2','B1','course'].includes(selection),'Use A2, B1 or course');const target=selection==='course'?base+'/learning/'+session.pageId:JSON.parse(fs.readFileSync(root+'/'+(selection==='A2'?'test-complete-A2-result.json':'resume-B1.json'),'utf8')).url;
const browser=await chromium.launch({headless:false}),ctx=await browser.newContext({viewport:null,serviceWorkers:'block'});
try{assert.equal((await ctx.request.post(base+'/api/auth/login',{data:{email:secure.email,password:secure.password}})).status(),200);const tab=await ctx.newPage();await tab.goto(target);console.log('Input scope snapshot opened. Close this browser when finished.');await new Promise(r=>browser.on('disconnected',r));}
catch{await browser.close();console.error('Start the closure runtime first; secure credentials were not printed.');process.exitCode=1;}
