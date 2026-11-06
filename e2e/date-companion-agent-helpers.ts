import { expect, test, type Page, type Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDateCompanionDatabase } from '../src/lib/server/date-companion/db';
import { DateCompanionRepository } from '../src/lib/server/date-companion/repository';
import type { PreparationView } from '../src/lib/domain/date-companion-preparation';

export const artifacts=process.env.DATE_AGENT_ARTIFACTS!;
export const base=process.env.DATE_AGENT_BASE_URL!;
export const data=process.env.APP_DATA_DIR!, prepare='/date-companion/a/prepare';
export const initialPrompt='明天（11月6日）下午见 Ta，想轻松点聊旅行。会前给我一个小准备。';
export const feedback='我觉得 Ta 那天工作有点累，我们后来只在附近安静走了一会儿。我想对照这份记录，看看当时有没有聊到旅行。';
export const quote='今天想沿着河边慢慢走，在石拱桥边看看水。';
export const excludedQuote='不保留的蓝莓冰沙原话';
export const otherQuote='未关联的黄铜风铃原话';
export const derived='这段能核对的是散步的话题';
export const oldPreamble='本身就是照顾到 Ta 累了的相处方式';
export const correction='纠正一下，是我自己当时有点紧张，并不确定 Ta 怎么想。';
export const afterUnlink='那我们回头理一理我自己的想法，只讨论就好。';
export const artifact=(name:string,value:unknown)=>writeFile(join(artifacts,`${name}.json`),JSON.stringify(value,null,2));
export const shot=(page:Page,name:string)=>page.screenshot({path:join(artifacts,`${name}.png`),fullPage:true});
export const prepUrl=()=>new URL(prepare,base).href;
export const assistant=(page:Page)=>page.getByRole('article',{name:'助手回复',exact:true}).last();
export const selected=(view:PreparationView)=>view.items.filter(item=>item.status==='selected');
export function offlinePageChecks() {
test.beforeEach(async({context})=>{
  expect(new URL(base).hostname).toBe('127.0.0.1');
  await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort('blockedbyclient'));
  await context.routeWebSocket('**/*',socket=>{
    const url=new URL(socket.url());
    if(`http://${url.host}`===base)socket.connectToServer();else socket.close();
  });
});
}

export async function register(page:Page) {
  const email=`fixture-${randomUUID()}@example.test`,password=`${randomUUID()}Aa!`;
  const registered=await page.request.post(new URL('/api/auth/register',base).href,{data:{email,password,name:'合成相处回顾',inviteCode:'date-agent-fixture'}});
  expect(registered.status()).toBe(201);
  const accountId=(await registered.json()).user.id as string;
  expect((await page.request.post(new URL('/api/auth/login',base).href,{data:{email,password}})).status()).toBe(200);
  return accountId;
}

export function seedRecap(userId:string,recordingDate:string,text:string,kind:'mentioned'|'promise'='mentioned') {
  const db=openDateCompanionDatabase({filePath:join(data,'date-companion.sqlite')});
  try {
    const repo=new DateCompanionRepository(db),relationshipId=repo.createOrGetRelationship(userId,'Ta').relationship.id;
    const uploadId=randomUUID();
    const imported=repo.importInteraction({userId,relationshipId,sourceUploadId:uploadId,recordingDate,
      originalName:'合成相处记录',participants:[{speakerId:'ta'}],recapCandidates:[text,excludedQuote].map((q,i)=>({
        kind,proposedText:kind==='promise'?q:`片段 ${i+1}`,sortOrder:i,evidence:[{uploadId,sourceSegmentId:`seg-${i}`,speakerId:'ta',startSeconds:i*4,endSeconds:i*4+2,quote:q}]
      }))});
    const item=repo.getInteractionDetail(userId,relationshipId,imported.interactionId);
    repo.updateRecap({userId,interactionId:item.id,version:item.version,assignments:[{speakerId:'ta',role:kind==='promise'?'self':'companion'}],mutations:item.recapItems.map((r,i)=>({id:r.id,version:r.version,disposition:i===0?'kept':'excluded'})),finalize:true});
    return {id:item.id,evidenceId:item.recapItems[0].evidence[0].id};
  } finally {db.close();}
}

export function sql<T>(query:string,...params:unknown[]):T[] {
  const db=new Database(join(data,'date-companion.sqlite'),{readonly:true,fileMustExist:true});
  try {return db.prepare(query).all(...params) as T[];} finally {db.close();}
}
export function unrelatedWrites(accountId:string) {
  const counts={promises:sql<{n:number}>('SELECT COUNT(*) n FROM dc_promises WHERE user_id=?',accountId)[0].n,
    bridge:sql<{n:number}>('SELECT COUNT(*) n FROM dc_memory_bridge_outbox WHERE user_id=?',accountId)[0].n,
    memory:0,people:0,todos:0};
  const m=join(data,'memory.sqlite');
  if(existsSync(m)){const db=new Database(m,{readonly:true});try{counts.memory=(db.prepare('SELECT count(*) n FROM memory_items').get() as {n:number}).n;counts.people=(db.prepare('SELECT count(*) n FROM person_entities').get() as {n:number}).n;}finally{db.close();}}
  const w=join(data,'work-review.sqlite');
  if(existsSync(w)){const db=new Database(w,{readonly:true});try{counts.todos=(db.prepare('SELECT count(*) n FROM wr_todos').get() as {n:number}).n;}finally{db.close();}}
  return counts;
}
export function countCalls(id:string) {return sql<{n:number}>('SELECT COUNT(*) n FROM agent_calls c JOIN agent_tasks t ON c.task_id=t.id WHERE t.resource_id=?',id)[0].n;}
type Captured={requestId:string;inputMessages:unknown[];payload:{authorizedScope:{preparationId:string};goal:string;observation:Record<string,unknown>;results:{tool:string;value:{sources?:{id:string;quote?:string}[];events?:unknown[]}}[]}};
export async function captured(id:string,goal?:string) {
  const rows=(await readFile(join(artifacts,'fixture-inputs.jsonl'),'utf8')).trim().split('\n').map(s=>JSON.parse(s) as Captured).filter(r=>r.payload.authorizedScope.preparationId===id&&(!goal||r.payload.goal===goal));
  expect(rows.length).toBeGreaterThan(0);
  for(const row of rows)expect(sql<{status:string}>('SELECT status FROM agent_calls WHERE id=?',row.requestId)).toEqual([{status:'succeeded'}]);
  return rows;
}

export async function send(page:Page,text:string,label='想聊点什么？') {
  await page.getByRole('textbox',{name:label,exact:true}).fill(text);
  const [result]=await Promise.all([page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.startsWith('/api/date-companion/preparations')),
    page.getByRole('button',{name:'发送',exact:true}).click()]);
  expect(result.status()).toBe(200);const view=(await result.json()).view as PreparationView;
  expect(view.generationStatus).toBe('idle');expect(view.messages.at(-1)?.role).toBe('assistant');
  return view;
}
export async function patch(page:Page,id:string,button:Locator) {
  const [result]=await Promise.all([page.waitForResponse(r=>r.request().method()==='PATCH'&&new URL(r.url()).pathname===`/api/date-companion/preparations/${id}`),button.click()]);
  expect(result.status()).toBe(200);return (await result.json()).view as PreparationView;
}
export async function reload(page:Page,id:string) {
  await page.reload();
  await expect(page.getByRole('region',{name:'聊天记录'})).toBeVisible();
  const result=await page.evaluate(async preparationId=>{
    const response=await fetch(`/api/date-companion/preparations/${encodeURIComponent(preparationId)}`,{cache:'no-store',credentials:'same-origin',redirect:'error'});
    return {status:response.status,body:await response.json()};
  },id);
  expect(result.status).toBe(200);
  expect(result.body.view.id).toBe(id);
  return result.body.view as PreparationView;
}
export async function start(page:Page) {
  await page.goto(prepUrl());
  const view=await send(page,initialPrompt),option=assistant(page).getByRole('group',{name:'可选准备',exact:true});
  return patch(page,view.id,option.getByRole('button',{name:'留下这条',exact:true}));
}
export async function link(page:Page,view:PreparationView) {
  await page.getByRole('button',{name:'用一份相处记录聊聊',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'选一份相处记录'});
  expect(await dialog.getByRole('radio',{checked:true}).count()).toBe(0);
  await dialog.getByRole('radio',{name:/2026-11-01/}).check();
  return patch(page,view.id,dialog.getByRole('button',{name:'用这份记录',exact:true}));
}
export async function reportEncounter(page:Page) {
  if(!await page.getByRole('textbox',{name:'后来怎么样？',exact:true}).isVisible())await page.getByRole('button',{name:'回来记一下',exact:true}).click();
  return send(page,feedback,'后来怎么样？');
}
export async function verifyRead(view:PreparationView,record:{id:string;evidenceId:string}) {
  const message=view.messages.at(-1)!;
  expect(message.sources).toHaveLength(1);expect(message.sources[0]).toMatchObject({interactionId:record.id,recordingDate:'2026-11-01',origin:'direct_conversation',speakerRole:'companion',valid:true,quote});
  const rows=await captured(view.id,feedback);
  const read=rows.at(-1)!.payload.results.find(r=>r.tool==='read_source');
  expect(read?.value.sources?.[0]).toMatchObject({quote});
  const located=rows.at(-1)!.payload.results.find(r=>r.tool==='list_review_sources');
  expect(located?.value.sources?.map(s=>s.id)).toEqual([record.evidenceId]);
  expect(JSON.stringify(located)).not.toContain(quote);
  for(const excluded of [excludedQuote,otherQuote])expect(JSON.stringify(rows)).not.toContain(excluded);
}
