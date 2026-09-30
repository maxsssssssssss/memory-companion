// Explicit local manual trial launcher; credentials remain in process memory.
import fs from 'node:fs';import assert from 'node:assert/strict';import {chromium} from '@playwright/test';
import {root,vault} from './trial.mjs';
const {base}=JSON.parse(fs.readFileSync(root+'/runtime.json','utf8')),session=JSON.parse(fs.readFileSync(root+'/session.json','utf8'));
assert.equal(new URL(base).hostname,'127.0.0.1');const secure=vault('read');
const browser=await chromium.launch({headless:false}),context=await browser.newContext({viewport:null,serviceWorkers:'block'});
try{const r=await context.request.post(base+'/api/auth/login',{data:{email:secure.email,password:secure.password}});assert.equal(r.status(),200,'Start this course runtime before opening');const page=await context.newPage();await page.goto(base+'/learning/'+session.pageId);console.log('Isolated synthetic course opened. Close the browser when finished.');await new Promise(resolve=>browser.on('disconnected',resolve));}
catch{await browser.close();console.error('Unable to open local course. Check trial.mjs status; credentials were not printed.');process.exitCode=1;}
