import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openDateCompanionDatabase } from '../src/lib/server/date-companion/db';
import { DateCompanionRepository } from '../src/lib/server/date-companion/repository';
import { PreparationSources } from '../src/lib/server/date-companion/preparation-sources';
import type { PreparationView } from '../src/lib/domain/date-companion-preparation';
import { artifact, artifacts, assistant, base, captured, correction, countCalls, data, derived, feedback,
  link, offlinePageChecks, oldPreamble, patch, prepUrl, quote, register, reload, reportEncounter,
  seedRecap, selected, send, shot, sql, unrelatedWrites, verifyRead } from './date-companion-agent-helpers';

test.skip(process.env.DATE_AGENT_FIXTURE_PHASE !== 'p3', 'Requires the guarded P3 runner and synthetic account data.');
test.use({serviceWorkers:'block', trace:'off', video:'off', actionTimeout:15_000});
test.describe.configure({retries:0, timeout:90_000});
offlinePageChecks();

const firstChoice = '找个轻松的机会聊聊旅行。';
const rememberedDetail = '当时是看见了那张旧车票才想起旅行。';
const initial = '明天下午见面，我想说起旅行。';
const reflection = '那次我们只在附近走走。我觉得 Ta 有些累。';
const recall = '我最初留下的那条是什么？我当时是怎么想起来的？';
const currentGoal = '结合最近的感受，给我一条下次的建议。';
const noProgress = '暂时没有新的进展，我只想聊聊，不想做准备。';

// Explicit historical wire shapes. No contemporary writer fills in the missing P1 fields.
function seedDiscussion(account:string, shape:'p1'|'p2', recordId?:string, long=false) {
  const db=openDateCompanionDatabase({filePath:join(data,'date-companion.sqlite')});
  try {
    const relationshipId=new DateCompanionRepository(db).createOrGetRelationship(account,'Ta').relationship.id;
    const id=randomUUID(), choiceId=randomUUID(), nextMeeting=randomUUID(), grant=randomUUID();
    const events: PreparationView['events']=[], messages:PreparationView['messages']=[];
    const event=(kind:string,text:string,metadata:Record<string,unknown>={})=>{
      const row={id:randomUUID(),kind,text,ordinal:events.length,
        createdAt:new Date(Date.UTC(2026,9,10,12,events.length)).toISOString(),data:metadata};
      events.push(row);return row;
    };
    const message=(role:'assistant'|'user',text:string,kind:'message'|'feedback',meetingId:string,
      sources:PreparationView['items'][number]['sources']=[],reviewLinkId?:string)=>{
      const ownership=shape==='p2'?{meetingId,...(reviewLinkId?{reviewLinkId}:{})}:{};
      const origin=role==='user'?'user_reflection':'assistant';
      const row=event(role==='assistant'?'assistant_message':kind,text,role==='assistant'
        ? {sourceIds:sources.map(s=>s.id),...ownership,...(shape==='p2'?{contextChecked:true}:{})}
        : {origin,...ownership});
      messages.push({id:row.id,createdAt:row.createdAt,role,kind,text,origin,sources,...ownership});return row;
    };
    message('user', initial,'message',id);
    const suggestion=message('assistant','','message',id);
    const items:PreparationView['items']=[{id:choiceId,text:firstChoice,status:'selected',sources:[],
      sourceMessageId:suggestion.id,createdAt:suggestion.createdAt,...(shape==='p2'?{meetingId:id}:{})}];
    event('select',firstChoice,{itemId:choiceId,status:'selected'});
    message('user',rememberedDetail,'message',id);
    let reviewLink:PreparationView['reviewLink']=null;
    if(recordId) {
      const at=event('review_linked','已关联这次相处的复盘。',{reviewLinkId:grant,interactionId:recordId,
        recordingDate:'2026-11-01',originalMeetingId:id,nextMeetingId:nextMeeting,originalItemIds:[choiceId]});
      reviewLink={id:grant,interactionId:recordId,recordingDate:'2026-11-01',linkedAt:at.createdAt,
        available:true,originalMeetingId:id,nextMeetingId:nextMeeting,originalItemIds:[choiceId]};
    }
    const reflected=message('user',reflection,'feedback',nextMeeting);
    if(recordId) {
      const sources=new PreparationSources(db).reviewSources(account,relationshipId,recordId);
      expect(sources).toHaveLength(1);
      message('assistant',derived+'。','message',nextMeeting,sources,grant);
    } else {
      const follow=message('assistant',oldPreamble,'message',nextMeeting);
      items.push({id:randomUUID(),sourceMessageId:follow.id,text:'见面时问候一下。',sources:[],
        createdAt:follow.createdAt,status:'suggested'});
    }
    if(long) {
      for(let i=0;i<9;i++){
        message('user',`第${i+1}段补充，我想再说说自己的感受。`,'message',nextMeeting);
        message('assistant','愿意的话，可以接着说。','message',nextMeeting);
      }
    }
    const body={id,relationshipId,title:initial,intent:shape==='p1'?initial:reflection,
      date:shape==='p1'?'2026-10-11':null,constraints:shape==='p1'?['下午']:[],
      interactionIds:[],allowRetained:false,status:'active',version:events.length,generationStatus:'idle',
      createdAt:events[0].createdAt,updatedAt:events.at(-1)!.createdAt,messages,items,events,
      ...(shape==='p2'?{currentMeetingId:nextMeeting,planningAfterFeedback:reflected.id,reviewLink}:{})};
    db.prepare('INSERT INTO dc_preparations(id,user_id,relationship_id,body_json,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(id,account,relationshipId,JSON.stringify(body),body.createdAt,body.updatedAt);
    return {id,choiceId,events:events.map(e=>e.id),grant};
  } finally {db.close();}
}

async function reopen(page:Page,id:string) {
  const url=page.url(),context=page.context();
  await page.close();const next=await context.newPage();await next.goto(url);
  return {page:next,view:await reload(next,id)};
}
async function layout(page:Page) {
  return page.evaluate(()=>{
    const messages=document.querySelector('[aria-label="聊天记录"]')!;
    const input=document.querySelector<HTMLTextAreaElement>('#companion-message')!;
    const send=input.form!.querySelector('button[type="submit"]')!.getBoundingClientRect();
    return {width:innerWidth,height:innerHeight,pageWidth:document.documentElement.scrollWidth,
      pageHeight:document.documentElement.scrollHeight,scroll:messages.scrollHeight,pane:messages.clientHeight,
      inputBottom:input.getBoundingClientRect().bottom,sendBottom:send.bottom};
  });
}

test('A old entries, saved P1 JSON, linked source and editable choice reopen together',async({page})=>{
  const account=await register(page);
  await page.goto(new URL('/date-companion/a',base).href);
  await expect(page.getByRole('textbox',{name:'想聊点什么？'})).toBeVisible();
  await shot(page,'A-first-visit');
  await page.getByRole('button',{name:'从相处录音开始'}).click();
  await page.locator('summary').filter({hasText:'上传这次相处的录音'}).click();
  await expect(page.getByRole('form',{name:'上传相处录音'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'从玩偶选择这次相处'})).toBeVisible();
  const record=seedRecap(account,'2026-11-01',quote), legacy=seedDiscussion(account,'p1');
  const promise='我答应把那张车票带来。';
  const promisedRecord=seedRecap(account,'2026-10-12',promise,'promise');
  const baseline=unrelatedWrites(account);
  expect(baseline.promises).toBe(1);
  await page.reload();
  await page.getByRole('link',{name:/回看准备卡/}).click();
  await expect(page.getByRole('region',{name:'见面前准备卡'})).toBeVisible();
  await page.locator('summary').filter({hasText:'你答应过'}).click();
  // The legacy card only projects long-term eligible sources, even though the
  // confirmed single recap already has an authoritative open Promise.
  await expect(page.getByText('目前没有待完成的约定')).toBeVisible();
  await expect(page.getByText(promise,{exact:true})).toHaveCount(0);
  const perRecord=await page.context().newPage();
  await perRecord.goto(new URL('/date-companion/a/recap?interaction='+promisedRecord.id,base).href);
  await perRecord.locator('summary').filter({hasText:'更多可能有用的内容'}).click();
  await expect(perRecord.getByText(promise,{exact:true}).first()).toBeVisible();
  await perRecord.close();
  await page.getByRole('link',{name:'回到相处讨论'}).click();
  await expect(page.getByRole('region',{name:'聊天记录'})).toContainText(reflection);
  const before=await reload(page,legacy.id);
  expect(before.reviewLink).toBeNull();expect(before.interactionIds).toEqual([]);expect(before.allowRetained).toBe(false);
  expect(before.messages.find(m=>m.text===reflection)?.origin).toBe('user_reflection');
  expect(before.date).toBeNull();expect(selected(before)[0].id).toBe(legacy.choiceId);
  expect(before.messages.some(m=>m.text.includes(oldPreamble))).toBe(false);
  await link(page,before);const reviewed=await reportEncounter(page);await verifyRead(reviewed,record);
  const latest=assistant(page);
  await latest.locator('summary').filter({hasText:'看看来源'}).click();
  await expect(latest.getByText(quote,{exact:true})).toBeVisible();
  await latest.getByRole('link',{name:'查看原记录'}).scrollIntoViewIfNeeded();
  await shot(page,'A-linked-source');
  const original=await page.context().newPage();
  await original.goto(new URL((await latest.getByRole('link',{name:'查看原记录'}).getAttribute('href'))!,base).href);
  await expect(original.getByLabel('本次录音信息')).toContainText('合成相处记录');
  const source=original.locator('details').filter({has:original.getByText(quote,{exact:false})}).last();
  if(!await source.evaluate((element)=>element.hasAttribute('open')))await source.locator('summary').first().click();
  await expect(source).toContainText(quote);await expect(original.getByRole('button',{name:'修改',exact:true})).toHaveCount(0);
  await original.goto(new URL('/date-companion/a/person',base).href);
  await expect(original.getByRole('button',{name:'标为已完成'})).toHaveCount(0);
  await original.getByRole('link',{name:/返回人物/}).first().click();
  await expect(original.getByText('还没有已确认的人物')).toBeVisible();
  await original.locator('#trust-controls > summary').click();
  await expect(original.getByRole('heading',{name:'允许未来使用已确认内容'})).toBeVisible();
  await original.close();
  const next=await send(page,'接着准备下一次，只要一条。');
  const option=assistant(page).getByRole('group',{name:'可选准备'});
  await option.getByRole('button',{name:'改一下'}).click();
  const edit=page.getByRole('dialog',{name:'改一下这条'});
  const text='见面时先听听 Ta 想聊什么。';await edit.getByRole('textbox',{name:'内容'}).fill(text);
  await patch(page,next.id,edit.getByRole('button',{name:'保存修改'}));
  await patch(page,next.id,option.getByRole('button',{name:'留下这条'}));
  const recovered=await reopen(page,next.id);
  expect(recovered.view.reviewLink?.interactionId).toBe(record.id);
  expect(selected(recovered.view).map(i=>i.text)).toEqual([firstChoice,text]);
  expect(recovered.view.events.slice(0,legacy.events.length).map(e=>e.id)).toEqual(legacy.events);
  expect(recovered.view.messages.some(m=>m.text===reflection)).toBe(true);
  expect(unrelatedWrites(account)).toEqual(baseline);
  await artifact('A-compatible',{legacyEvents:legacy.events.length,view:recovered.view,baseline});
  console.log('[date-agent-p3] 1/3 old data and entries passed');
});

test('B long discussion recalls early history, respects a changed plan and saves one current choice',async({page})=>{
  const account=await register(page);
  await page.goto(new URL('/date-companion/a',base).href);
  const first=await send(page,noProgress);
  await expect(page).toHaveURL(new RegExp('/prepare\\?preparation='+first.id+'$'));
  expect((await reload(page,first.id)).items).toEqual([]);
  const seed=seedDiscussion(account,'p1',undefined,true);
  await page.goto(prepUrl()+'?preparation='+seed.id);
  await send(page,correction);
  await send(page,recall);
  await expect(assistant(page)).toContainText(firstChoice);await expect(assistant(page)).toContainText('旧车票');
  const view=await send(page,currentGoal);
  const exchanges=await captured(view.id,recall);
  const recent=exchanges[0].payload.observation.messages as unknown[];
  expect(recent.length).toBeLessThan(view.messages.length);
  expect(JSON.stringify(recent)).not.toContain(rememberedDetail);
  const page0=exchanges.at(-1)!.payload.results.find(r=>r.tool==='read_progress')!.value;
  expect(JSON.stringify(page0.events)).toContain(firstChoice);expect(JSON.stringify(page0)).toContain(rememberedDetail);
  for(const call of exchanges) {
    expect(JSON.stringify(call.inputMessages)).not.toContain(oldPreamble);
    expect(call.payload.observation).toMatchObject({date:null,constraints:[]});
    expect(JSON.stringify(call.payload.observation.latestCorrection)).toContain(correction);
  }
  const fresh=view.items.filter(i=>i.sourceMessageId===view.messages.at(-1)!.id);
  expect(fresh).toHaveLength(1);expect(view.messages.at(-1)!.text).toBe('');expect(view.date).toBeNull();
  await page.setViewportSize({width:390,height:844});
  const option=assistant(page).getByRole('group',{name:'可选准备'});await option.scrollIntoViewIfNeeded();
  const mobile=await layout(page);expect(mobile.pageWidth).toBe(mobile.width);expect(mobile.sendBottom).toBeLessThanOrEqual(844);
  expect(mobile.scroll).toBeGreaterThan(mobile.pane);await shot(page,'B-mobile-option');
  const edited='在路口碰头后问问 Ta 想往哪边走。';
  await option.getByRole('button',{name:'改一下'}).click();
  await page.getByRole('textbox',{name:'内容'}).fill(edited);
  await patch(page,view.id,page.getByRole('button',{name:'保存修改'}));
  await expect(option.locator('p')).toHaveText(edited);
  const saved=await patch(page,view.id,option.getByRole('button',{name:'留下这条'}));
  await page.setViewportSize({width:390,height:480});
  await expect.poll(async()=> (await layout(page)).sendBottom).toBeLessThanOrEqual(480);
  const shortMobile=await layout(page);
  const turns=countCalls(view.id);
  const recovered=await reopen(page,view.id);page=recovered.page;
  expect(recovered.view.items).toEqual(saved.items);
  expect(recovered.view.items.find(i=>i.id===seed.choiceId)?.meetingId).not.toBe(recovered.view.currentMeetingId);
  expect(recovered.view.items.find(i=>i.id===fresh[0].id)).toMatchObject({status:'selected',meetingId:recovered.view.currentMeetingId,text:edited});
  expect(countCalls(view.id)).toBe(turns);
  await expect(page.locator('summary').filter({hasText:'以前留下的'}).locator('..')).not.toHaveAttribute('open','');
  await page.setViewportSize({width:1280,height:720});
  await page.getByRole('region',{name:'聊天记录'}).evaluate(el=>{el.scrollTop=el.scrollHeight;});
  await shot(page,'B-desktop-reopened');
  const desktop=await layout(page);expect(desktop.pageHeight).toBeLessThanOrEqual(desktop.height+2);
  await page.locator('summary').filter({hasText:'以前留下的'}).click();
  await expect(page.locator('details[open]').filter({has:page.getByText(firstChoice,{exact:true})}).first()).toBeVisible();
  const noAction=await send(page,noProgress);
  expect(noAction.items).toEqual(saved.items);expect(noAction.messages.at(-1)!.text).toContain('先放在这里');
  const changed=await send(page,'我改主意了，这条不用了，只想再聊聊。');
  expect(changed.items.find(i=>i.id===fresh[0].id)).toMatchObject({status:'removed',text:edited});
  expect(changed.events).toEqual(expect.arrayContaining([expect.objectContaining({kind:'select',data:expect.objectContaining({itemId:fresh[0].id})})]));
  const calls=countCalls(view.id);await page.getByRole('button',{name:'更多操作'}).click();
  const paused=await patch(page,view.id,page.getByRole('button',{name:'这次先不聊',exact:true}));
  expect(paused.status).toBe('paused');expect((await reload(page,view.id)).status).toBe('paused');expect(countCalls(view.id)).toBe(calls);
  await artifact('B-continuity',{messages:recovered.view.messages.length,events:recovered.view.events.length,
    firstPage:page0,choiceIds:selected(saved).map(i=>i.id),mobile,shortMobile,desktop});
  console.log('[date-agent-p3] 2/3 long conversation passed');
});

test('C P2 grant is withdrawn while an older answer is in flight, including paged model input',async({page})=>{
  const account=await register(page),record=seedRecap(account,'2026-11-01',quote);
  const seed=seedDiscussion(account,'p2',record.id);
  await page.goto(prepUrl());
  const before=await reload(page,seed.id);expect(before.reviewLink?.id).toBe(seed.grant);
  await send(page,correction);
  const delayed='我想再慢慢说，这份记录里有什么值得聊的？';
  await page.getByRole('textbox',{name:'想聊点什么？'}).fill(delayed);
  const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/turns'));
  await page.getByRole('button',{name:'发送',exact:true}).click();
  const marker=join(artifacts,'delayed-'+seed.id);
  await expect.poll(()=>existsSync(marker+'.started')).toBe(true);
  const other=await page.context().newPage();await other.goto(prepUrl());
  await other.getByRole('button',{name:'查看已关联的相处记录'}).click();
  const unlinked=await patch(other,seed.id,other.getByRole('button',{name:'取消关联'}));
  expect(unlinked.reviewLink).toBeNull();
  await writeFile(marker+'.release','release after the committed PATCH');
  await response;
  const fenced=await reload(other,seed.id);
  expect(fenced.version).toBe(unlinked.version);
  expect(JSON.stringify(fenced)).not.toContain('本应丢弃');
  const prompt='我想继续聊之前的紧张，只聊天就好。';
  const after=await send(other,prompt),actual=await captured(seed.id,prompt);
  expect(after.messages.some(m=>m.text===reflection)).toBe(true);expect(after.items[0]).toMatchObject({id:seed.choiceId,text:firstChoice,status:'selected'});
  expect(after.messages.find(m=>m.text===correction)?.origin).toBe('user_reflection');
  expect(actual.at(-1)!.payload.results.filter(r=>r.tool==='read_progress'&&(r.value.events?.length??0)>0)).toHaveLength(2);
  for(const row of actual)for(const stale of [derived,quote,oldPreamble,'本应丢弃'])expect(JSON.stringify(row.inputMessages)).not.toContain(stale);
  const generation=await readFile(marker+'.started','utf8');
  const task=sql<{id:string;status:string}>('SELECT id,status FROM agent_tasks WHERE resource_id=? AND goal=?',seed.id,delayed)[0];
  expect(task.status).toBe('cancelled');
  const calls=sql<{id:string;status:string}>('SELECT id,status FROM agent_calls WHERE task_id=?',task.id);
  expect(calls).toHaveLength(3);
  expect(calls.filter(call=>call.status==='succeeded').length).toBeGreaterThanOrEqual(2);
  await shot(other,'C-after-withdrawal');
  await artifact('C-fence',{generation,task,calls,versionBeforeRelease:unlinked.version,versionAfterRelease:fenced.version,
    retainedFeedback:after.messages.filter(m=>m.kind==='feedback'||m.kind==='correction'),requestIds:actual.map(r=>r.requestId)});
  console.log('[date-agent-p3] 3/3 withdrawal and late response passed');
});
