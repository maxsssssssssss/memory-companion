import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { openDateCompanionDatabase } from '../src/lib/server/date-companion/db';
import { PreparationRepository } from '../src/lib/server/date-companion/preparation-repository';
import { afterUnlink, artifact, assistant, base, captured, correction, countCalls, data, derived, feedback,
  link, offlinePageChecks, oldPreamble, otherQuote, patch, prepUrl, quote, register, reload, reportEncounter,
  seedRecap, selected, send, shot, start, unrelatedWrites, verifyRead } from './date-companion-agent-helpers';

test.skip(process.env.DATE_AGENT_FIXTURE_PHASE !== 'p2','Requires the P2 offline runner.');
test.describe.configure({retries:0,timeout:120_000});
test.use({serviceWorkers:'block',trace:'off',video:'off'});
offlinePageChecks();

test('A selected preparation, linked recap and sourced comparison, next preparation survives reopening',async({page})=>{
  const account=await register(page);const record=seedRecap(account,'2026-11-01',quote);seedRecap(account,'2026-10-01',otherQuote);
  const baseline=unrelatedWrites(account),before=await start(page),callsBeforeLink=countCalls(before.id);
  expect(selected(before)).toHaveLength(1);expect(before.date).toBe('2026-11-06');
  const linked=await link(page,before);expect(countCalls(before.id)).toBe(callsBeforeLink);
  expect(linked.reviewLink).toMatchObject({interactionId:record.id,originalItemIds:[selected(before)[0].id]});
  expect(linked.interactionIds).toEqual([]);expect(linked.allowRetained).toBe(false);
  const reviewed=await reportEncounter(page);await verifyRead(reviewed,record);
  const reply=assistant(page);await expect(reply).toContainText(derived);await expect(reply).toContainText('还不能判断');
  expect(reviewed.messages.at(-2)).toMatchObject({text:feedback,kind:'feedback',origin:'user_reflection',sources:[]});
  await reply.locator('summary').filter({hasText:'看看来源'}).click();await expect(reply.getByText(quote,{exact:true})).toBeVisible();
  await expect(reply.getByRole('link',{name:'查看原记录'})).toHaveAttribute('href',reviewed.messages.at(-1)!.sources[0].href);
  await reply.getByRole('link',{name:'查看原记录'}).scrollIntoViewIfNeeded();
  await shot(page,'A1-reviewed-source');
  const beforeDraft=countCalls(before.id);
  await page.getByRole('button',{name:'查看已关联的相处记录',exact:true}).click();
  const linkedRecord=page.getByRole('dialog',{name:'已关联的相处记录'});
  const originalLink=linkedRecord.getByRole('link',{name:'打开原记录'});
  await expect(originalLink).toHaveAttribute('href',new RegExp(record.id));
  const recordPage=await page.context().newPage();
  const [detail]=await Promise.all([
    recordPage.waitForResponse(r=>r.request().method()==='GET' && new URL(r.url()).pathname===`/api/date-companion/interactions/${record.id}`),
    recordPage.goto(new URL((await originalLink.getAttribute('href'))!,base).href)
  ]);
  expect(detail.status()).toBe(200);
  expect((await detail.json()).interaction.id).toBe(record.id);
  await expect(recordPage.getByLabel('本次录音信息')).toContainText('合成相处记录');
  await recordPage.close();
  await linkedRecord.getByRole('button',{name:'接着准备下一次',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'想聊点什么？',exact:true})).toHaveValue(/下一次|下次/);
  expect(countCalls(before.id)).toBe(beforeDraft);
  const next=await send(page,'接着准备下一次吧，日期还没定。给我一条能留下的小建议。');
  expect(next.date).toBeNull();expect(next.constraints).toEqual([]);
  const fresh=next.items.filter(i=>i.sourceMessageId===next.messages.at(-1)?.id);expect(fresh).toHaveLength(1);expect(fresh[0].status).toBe('suggested');
  const desktop=page.viewportSize()!;
  await page.setViewportSize({width:390,height:844});
  const option=assistant(page).getByRole('group',{name:'可选准备',exact:true});
  await option.scrollIntoViewIfNeeded();
  const sendBox=await page.getByRole('button',{name:'发送',exact:true}).boundingBox();
  expect(sendBox).toBeTruthy();
  expect(sendBox!.y+sendBox!.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await shot(page,'A-mobile-next-option');
  await option.getByRole('button',{name:'改一下',exact:true}).click();
  const edit=page.getByRole('dialog');const editedText='见面时先问：“今天有什么想做的吗？”';
  await edit.getByRole('textbox',{name:'内容'}).fill(editedText);const callsBeforeEdit=countCalls(next.id);
  await patch(page,next.id,edit.getByRole('button',{name:'保存修改'}));await expect(option.locator('p')).toHaveText(editedText);
  await patch(page,next.id,option.getByRole('button',{name:'留下这条',exact:true}));
  await page.setViewportSize(desktop);
  const context=page.context();
  await page.close();
  page=await context.newPage();
  await page.goto(prepUrl());
  const restored=await reload(page,next.id);expect(countCalls(next.id)).toBe(callsBeforeEdit);
  expect(selected(restored).map(i=>[i.id,i.text])).toEqual([[selected(before)[0].id,selected(before)[0].text],[fresh[0].id,editedText]]);
  expect(selected(restored)[0].meetingId).toBe(linked.reviewLink?.originalMeetingId);expect(selected(restored)[1].meetingId).toBe(linked.reviewLink?.nextMeetingId);
  const oldGroup=page.getByRole('group',{name:'这次见面前留下的',exact:true});
  if(!await oldGroup.isVisible())await page.locator('summary').filter({hasText:'以前留下的 · 1'}).click();
  await expect(oldGroup).toContainText(selected(before)[0].text);
  await expect(page.getByRole('group',{name:'为下一次留下的',exact:true})).toContainText(editedText);
  await expect(assistant(page).getByRole('group',{name:'已选准备'})).toContainText(editedText);
  await shot(page,'A2-edited-and-reopened');expect(unrelatedWrites(account)).toEqual(baseline);
  await artifact('A-recovery',{original:before,reviewed,restored,callsBeforeEdit,callsAfter:countCalls(next.id)});console.log('[date-agent-p2] 1/3 PASS');
});

test('B no recordings and no consent: feedback remains a discussion',async({page})=>{
  const account=await register(page);await page.setViewportSize({width:390,height:844});await page.goto(prepUrl());
  const first=await send(page,'没有可用录音，也不用历史。我只想聊聊见面前的不安。');
  await page.getByRole('button',{name:'回来记一下',exact:true}).click();
  const text='后来见面时还是有点拿不准。我只想聊聊，不想准备行动。';
  const view=await send(page,text,'后来怎么样？'),again=await reload(page,view.id);
  expect(again.id).toBe(first.id);expect(again.messages).toEqual(view.messages);expect(again.messages.at(-2)).toMatchObject({text,origin:'user_reflection',kind:'feedback'});
  expect(again.items).toEqual([]);expect(again.date).toBeNull();expect(again.constraints).toEqual([]);expect(again.reviewLink??null).toBeNull();
  expect(again.messages.flatMap(m=>m.sources)).toEqual([]);expect((await captured(view.id)).every(r=>r.payload.results.length===0)).toBe(true);
  await expect(page.getByRole('button',{name:'留下这条',exact:true})).toHaveCount(0);await expect(page.getByRole('textbox',{name:'想聊点什么？',exact:true})).toBeVisible();
  expect(unrelatedWrites(account)).toEqual({promises:0,bridge:0,memory:0,people:0,todos:0});
  await shot(page,'B-discussion-mobile');await artifact('B-reopened',again);console.log('[date-agent-p2] 2/3 PASS');
});

test('C corrected interpretation and withdrawn record stay out of later model inputs and paged progress',async({page})=>{
  const account=await register(page),record=seedRecap(account,'2026-11-01',quote),baseline=unrelatedWrites(account),before=await start(page);
  // Old P1 used an uncited assistant preamble. Insert that exact kind of saved
  // business turn; do not overwrite history or fabricate a recording source.
  const db=openDateCompanionDatabase({filePath:join(data,'date-companion.sqlite')});
  try {
    const repo=new PreparationRepository(db),begun=repo.begin(account,before.id,{operationKey:randomUUID(),expectedVersion:before.version,text:'我想起之前的那次散步。',kind:'feedback'});
    const seeded=repo.commit(account,before.id,{generationId:begun.generationId!,version:begun.version!,text:`那天安静地散会儿步，${oldPreamble}。`,suggestions:['下次见面前，问问 Ta 想不想散步。'],sources:[]});
    expect(seeded.messages.at(-1)?.text).toContain(oldPreamble);
  } finally {db.close();}
  const legacy=await reload(page,before.id);expect(legacy.messages.some(m=>m.text.includes(oldPreamble))).toBe(false);
  await link(page,legacy);const review=await reportEncounter(page);await verifyRead(review,record);
  const corrected=await send(page,correction);expect(corrected.messages.at(-2)).toMatchObject({kind:'correction',text:correction});
  const probe='现在还是想说说我的紧张。';await send(page,probe);
  const correctionCalls=await captured(before.id,probe);expect(JSON.stringify(correctionCalls.at(-1)!.payload.observation)).toContain('自己当时有点紧张');
  await page.getByRole('button',{name:'查看已关联的相处记录',exact:true}).click();
  const unlinked=await patch(page,before.id,page.getByRole('dialog',{name:'已关联的相处记录'}).getByRole('button',{name:'取消关联',exact:true}));
  expect(unlinked.reviewLink??null).toBeNull();const final=await send(page,afterUnlink);
  const turns=await captured(before.id,afterUnlink),progress=turns.at(-1)!.payload.results.filter(r=>r.tool==='read_progress');
  expect(progress).toHaveLength(2);expect(progress[0].value.events?.length).toBeGreaterThan(0);expect(progress[1].value.events?.length).toBeGreaterThan(0);
  for(const exchange of turns){for(const withdrawn of [quote,derived,oldPreamble])expect(JSON.stringify(exchange.inputMessages)).not.toContain(withdrawn);}
  expect(JSON.stringify(turns.at(-1)!.payload.results)).toContain('自己当时有点紧张');
  expect(selected(final).map(i=>i.text)).toEqual(selected(before).map(i=>i.text));expect(final.messages.find(m=>m.text===feedback)).toMatchObject({origin:'user_reflection',kind:'feedback'});
  expect(unrelatedWrites(account)).toEqual(baseline);await shot(page,'C-withdrawn-record');await artifact('C-fencing',{final,sourceFingerprint:review.messages.at(-1)!.sources[0].fingerprint,requestIds:turns.map(r=>r.requestId),verifiedProgressPages:progress.length});console.log('[date-agent-p2] 3/3 PASS');
});
