import { expect, request, test, type Page } from '@playwright/test';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { openDateCompanionDatabase } from '../src/lib/server/date-companion/db';
import { DateCompanionRepository } from '../src/lib/server/date-companion/repository';
import type { PreparationView } from '../src/lib/domain/date-companion-preparation';

const baseURL=process.env.DATE_AGENT_BASE_URL!, artifacts=process.env.DATE_AGENT_ARTIFACTS!;
test.describe.configure({mode:'serial',timeout:120000});
let cookies: Awaited<ReturnType<import('@playwright/test').APIRequestContext['storageState']>>['cookies'];
let userId:string, preparationId:string, sourceId:string;
let baselineBridgeEvents:number;
const results:string[]=[];
test.beforeAll(async()=>{
 const api=await request.newContext({baseURL});
 const email=`date-agent-${Date.now()}@example.test`,password='DateAgentFixture!2026';
 const registered=await api.post('/api/auth/register',{data:{email,password,name:'约会离线合成验收',inviteCode:'date-agent-fixture'}});
 expect(registered.status()).toBe(201);userId=(await registered.json()).user.id;
 expect((await api.post('/api/auth/login',{data:{email,password}})).status()).toBe(200);
 cookies=(await api.storageState()).cookies;await api.dispose();
 const db=openDateCompanionDatabase({filePath:join(process.env.APP_DATA_DIR!,'date-companion.sqlite')});
 const repo=new DateCompanionRepository(db),relationship=repo.createOrGetRelationship(userId,'Ta').relationship;
 const upload='synthetic-date-agent-travel';
 const imported=repo.importInteraction({userId,relationshipId:relationship.id,sourceUploadId:upload,recordingDate:'2026-11-01',originalName:'合成旅行记录',participants:[{speakerId:'self'},{speakerId:'ta'}],recapCandidates:[{kind:'mentioned',proposedText:'聊过旅行',sortOrder:0,evidence:[{uploadId:upload,sourceSegmentId:'travel-segment',speakerId:'ta',startSeconds:0,endSeconds:4,quote:'旅行时我更想在海边慢慢散步。'}]}]});
 const interaction=repo.getRelationshipView(userId,relationship.id).interactions[0];sourceId=imported.interactionId;
 repo.updateRecap({userId,interactionId:sourceId,version:interaction.version,assignments:[{speakerId:'self',role:'self'},{speakerId:'ta',role:'companion'}],mutations:interaction.recapItems.map(i=>({id:i.id,version:i.version,disposition:'kept'})),finalize:true});
 baselineBridgeEvents=(db.prepare('SELECT COUNT(*) n FROM dc_memory_bridge_outbox').get() as {n:number}).n;
 db.close();
});
test.beforeEach(async({context})=>{
 await context.addCookies(cookies);
 await context.route('**/*',async route=>{const u=new URL(route.request().url());if(['http:','https:','ws:','wss:'].includes(u.protocol)&&!['localhost','127.0.0.1'].includes(u.hostname))throw Error('External browser request');await route.continue();});
});
test.afterAll(async()=>{await writeFile(join(artifacts,'scenarios.json'),JSON.stringify({passed:results,realProviderRequests:0},null,2));});
async function send(page:Page,text:string,label='想聊点什么？'){
 await page.getByLabel(label,{exact:true}).fill(text);
 const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes('/api/date-companion/preparations'));
 await page.getByRole('button',{name:'发送',exact:true}).click();
 const r=await response;expect(r.status()).toBe(200);return (await r.json()).view as PreparationView;
}
async function get(page:Page,id:string){return page.evaluate(async id=>(await(await fetch(`/api/date-companion/preparations/${id}`,{cache:'no-store'})).json()).view,id) as Promise<PreparationView>;}
async function visibleComposer(page:Page){
 const box=await page.getByRole('button',{name:'发送',exact:true}).boundingBox();expect(box).not.toBeNull();expect(box!.y+box!.height).toBeLessThanOrEqual(page.viewportSize()!.height+1);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
}
test('1 history, real tool retrieval, selection, reopen and feedback',async({page})=>{
 await page.goto(`${baseURL}/date-companion/a/prepare`);
 await expect(page.getByLabel('想聊点什么？',{exact:true})).toBeVisible();
 await expect(page.getByText('从你现在想说的开始。',{exact:true})).toBeVisible();
 await page.screenshot({path:join(artifacts,'01-default-desktop.png'),fullPage:true});
 await page.getByRole('button',{name:'资料范围',exact:true}).click();
 await page.getByLabel(/2026-11-01 ·/).check();
 await page.getByRole('button',{name:'用这些资料',exact:true}).click();
 let view=await send(page,'明天下午见 Ta，想轻松一点。帮我找找上次有没有聊过旅行。');preparationId=view.id;
 expect(view.items.filter(i=>i.status==='selected')).toHaveLength(0);
 await expect(page.getByRole('region',{name:'聊天记录'})).toContainText('海边');
 await page.getByRole('button',{name:'留下这条',exact:true}).first().click();
 await expect(page.getByText('这次想记得的事 · 1',{exact:true})).toBeVisible();
 view=await get(page,preparationId);expect(view.items.filter(i=>i.status==='selected')).toHaveLength(1);
 const originalChoice=view.items.filter(i=>i.status==='selected');
 await page.getByText(/看看来源 ·/).first().click();
 await expect(page.getByText('旅行时我更想在海边慢慢散步。',{exact:true}).first()).toBeVisible();
 await page.screenshot({path:join(artifacts,'02-selected-source.png'),fullPage:true});
 await page.goto('about:blank');await page.goto(`${baseURL}/date-companion/a/prepare`);
 await expect(page.getByText('这次想记得的事 · 1',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'回来记一下',exact:true}).click();
 const feedbackText='上次没有聊旅行。我觉得 Ta 那天工作很累，我们后来只是安静地散了会儿步。请根据这次实际情况调整一个下次见面的小建议，别替我留下。';
 view=await send(page,feedbackText,'后来怎么样？');
 expect(view.messages.some(m=>m.kind==='feedback'&&m.origin==='user_reflection'&&m.text.includes('工作很累'))).toBe(true);
 expect(view.items.filter(i=>i.status==='selected')).toHaveLength(1);
 expect(view.messages.at(-1)?.text).toBe('');
 expect(view.date).toBeNull();
 const returned = page.getByRole('article',{name:'助手回复',exact:true}).last();
 await expect(returned.locator(':scope > p')).toHaveCount(0);
 await expect(returned.getByRole('group',{name:'可选准备'})).toHaveCount(1);
 if (process.env.DATE_AGENT_REPLAY_FEEDBACK) {
   const sample = JSON.parse(await readFile(process.env.DATE_AGENT_REPLAY_FEEDBACK,'utf8'));
   const {args} = JSON.parse(sample.finalAssistantText);
   expect(view.items.filter(i=>i.sourceMessageId===view.messages.at(-1)?.id).map(i=>i.text)).toEqual(args.suggestions);
   await expect(returned).not.toContainText(args.reply);
 }
 await page.reload();await expect(page.getByRole('region',{name:'聊天记录'})).toContainText('工作很累');
 await page.getByText('以前留下的 · 1',{exact:true}).click();
 await page.getByLabel('助手回复',{exact:true}).last().scrollIntoViewIfNeeded();
 await page.screenshot({path:join(artifacts,'03-feedback-desktop.png'),fullPage:true});
 if (process.env.DATE_AGENT_REPLAY_FEEDBACK) {
   const desktop = page.viewportSize()!;
   await page.setViewportSize({ width:390, height:844 });
   await returned.scrollIntoViewIfNeeded();
   await visibleComposer(page);
   await page.screenshot({path:join(artifacts,'03-feedback-mobile-replay.png'),fullPage:true});
   await page.setViewportSize(desktop);
 }
 const feedbackReply = view.messages.at(-1)!;
 const adjustment = view.items.filter(item => item.sourceMessageId === feedbackReply.id);
 expect(adjustment).toHaveLength(1);
 expect(adjustment[0].status).toBe('suggested');
 expect(view.items.filter(item => item.status === 'selected')).toEqual(originalChoice);
 const feedbackArticle = page.getByRole('article', {name:'助手回复',exact:true}).last();
 const feedbackOption = feedbackArticle.getByRole('group',{name:'可选准备',exact:true});
 await expect(feedbackOption).toHaveCount(1);
 await expect(feedbackOption.locator('p')).toHaveText(adjustment[0].text);
 const beforeSelect = await readFile(join(artifacts,'synthetic-calls.jsonl'),'utf8');
 const [patch] = await Promise.all([
   page.waitForResponse(r=>r.request().method()==='PATCH' && new URL(r.url()).pathname===`/api/date-companion/preparations/${preparationId}`),
   feedbackOption.getByRole('button',{name:'留下这条',exact:true}).click()
 ]);
 expect(patch.status()).toBe(200);
 expect(patch.request().postDataJSON()).toMatchObject({kind:'select',itemId:adjustment[0].id});
 await expect(page.getByText('这次想记得的事 · 1',{exact:true})).toBeVisible();
 await expect(page.getByText('以前留下的 · 1',{exact:true})).toBeVisible();
 await page.goto('about:blank'); await page.goto(`${baseURL}/date-companion/a/prepare`);
 await expect(page.getByText('这次想记得的事 · 1',{exact:true})).toBeVisible();
 await expect(page.getByText('以前留下的 · 1',{exact:true})).toBeVisible();
 const persisted = await get(page,preparationId);
 expect(persisted.items.filter(item=>item.status==='selected')).toEqual([...originalChoice, {...adjustment[0],status:'selected'}]);
 expect(persisted.messages).toEqual(view.messages);
 await expect(page.getByRole('article',{name:'助手回复',exact:true}).last().getByRole('group',{name:'已选准备',exact:true})).toContainText(adjustment[0].text);
 expect(await readFile(join(artifacts,'synthetic-calls.jsonl'),'utf8')).toBe(beforeSelect);

 const db=openDateCompanionDatabase({filePath:join(process.env.APP_DATA_DIR!,'date-companion.sqlite')});
 const tools=db.prepare("SELECT tool FROM agent_actions").all() as {tool:string}[];
 expect(tools.some(r=>r.tool==='search_records')).toBe(true);expect(tools.some(r=>r.tool==='read_source')).toBe(true);
 expect((db.prepare('SELECT COUNT(*) count FROM dc_promises').get() as {count:number}).count).toBe(0);
 expect((db.prepare('SELECT COUNT(*) count FROM dc_memory_bridge_outbox').get() as {count:number}).count).toBe(baselineBridgeEvents);db.close();
 const memoryPath=join(process.env.APP_DATA_DIR!,'memory.sqlite');
 if(existsSync(memoryPath)){const memory=new Database(memoryPath,{readonly:true});expect(memory.prepare('SELECT COUNT(*) n FROM memory_items').get()).toEqual({n:0});expect(memory.prepare('SELECT COUNT(*) n FROM person_facts').get()).toEqual({n:0});memory.close();}
 expect(existsSync(join(process.env.APP_DATA_DIR!,'work-review.sqlite'))).toBe(false);
 results.push('1/3 history-selection-reopen-feedback');console.log('[date-agent] 1/3 PASS');
});
test('2 no history, discussion only, mobile and long scrolling',async({page,browser})=>{
 const fresh=await request.newContext({baseURL});const email=`date-agent-empty-${Date.now()}@example.test`,password='DateAgentFixture!2026';
 expect((await fresh.post('/api/auth/register',{data:{email,password,name:'无录音合成账号',inviteCode:'date-agent-fixture'}})).status()).toBe(201);
 expect((await fresh.post('/api/auth/login',{data:{email,password}})).status()).toBe(200);
 const emptyContext=await browser.newContext({storageState:await fresh.storageState()});
 await emptyContext.route('**/*',async route=>{const url=new URL(route.request().url());if(['http:','https:'].includes(url.protocol)&&url.hostname!=='127.0.0.1')throw Error('External fresh-browser request');await route.continue();});
 const emptyPage=await emptyContext.newPage();await emptyPage.goto(`${baseURL}/date-companion/a`);
 await expect(emptyPage.getByText('从你现在想说的开始。',{exact:true})).toBeVisible();
 const empty=await send(emptyPage,'没有录音，只想聊聊，不做准备。');expect(empty.items).toHaveLength(0);expect(empty.interactionIds).toEqual([]);
 await emptyContext.close();await fresh.dispose();
 await page.setViewportSize({width:390,height:844});await page.goto(`${baseURL}/date-companion/a/prepare`);
 await page.getByRole('button',{name:'聊过的',exact:true}).click();await page.getByRole('button',{name:'聊点新的',exact:true}).click();
 let view=await send(page,'这次不用历史资料，我不确定要不要提那件事，只想聊聊，不做准备。');
 expect(view.interactionIds).toEqual([]);expect(view.items).toHaveLength(0);
 await expect(page.getByRole('region',{name:'聊天记录'})).toContainText('只聊聊');
 for(let i=0;i<5;i++)view=await send(page,`继续只讨论 ${i+1}：${'我更想轻松相处，不急着作决定。'.repeat(8)}`);
 const log=page.getByRole('region',{name:'聊天记录'});expect(await log.evaluate(n=>n.scrollHeight>n.clientHeight)).toBe(true);
 await log.evaluate(n=>{n.scrollTop=0;n.dispatchEvent(new Event('scroll'));});
 await visibleComposer(page);await page.screenshot({path:join(artifacts,'04-mobile-long-chat.png'),fullPage:true});
 await page.setViewportSize({width:390,height:480});await visibleComposer(page);
 await page.screenshot({path:join(artifacts,'05-mobile-compact-viewport.png'),fullPage:true});
 await page.getByRole('button',{name:'更多操作',exact:true}).click();await page.getByRole('button',{name:'这次先不聊',exact:true}).click();
 await expect(page.getByText(/这次先聊到这里/)).toBeVisible();
 results.push('2/3 no-history-discussion-mobile');console.log('[date-agent] 2/3 PASS');
});
test('3 revoke source and correct, retained decisions remain',async({page})=>{
 await page.goto(`${baseURL}/date-companion/a/prepare`);await page.getByRole('button',{name:'聊过的',exact:true}).click();
 await page.getByRole('button',{name:/明天下午见 Ta/}).click();
 await page.getByRole('button',{name:'资料范围',exact:true}).click();await page.getByRole('button',{name:'这次不用历史资料',exact:true}).click();await page.getByRole('button',{name:'用这些资料',exact:true}).click();
 const view=await send(page,'纠正一下，这次不聊旅行。撤回旧资料，只根据当前表达，想安静一点。');
 expect(view.interactionIds).toEqual([]);expect(view.items.filter(i=>i.status==='selected')).toHaveLength(2);
 await expect(page.getByRole('region',{name:'聊天记录'})).toContainText('按你现在的想法');
 const calls=(await readFile(join(artifacts,'fixture-inputs.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 const last=calls.at(-1);expect(JSON.stringify(last)).not.toContain('旅行时我更想在海边慢慢散步');
 await page.reload();expect((await get(page,preparationId)).messages.some(m=>m.text.includes('撤回旧资料'))).toBe(true);
 results.push('3/3 revoke-correct-persist');console.log('[date-agent] 3/3 PASS');
});
