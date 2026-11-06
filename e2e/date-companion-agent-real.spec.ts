import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { openDateCompanionDatabase } from '../src/lib/server/date-companion/db';
import { DateCompanionRepository } from '../src/lib/server/date-companion/repository';
import { PreparationRepository } from '../src/lib/server/date-companion/preparation-repository';
import type { PreparationView } from '../src/lib/domain/date-companion-preparation';
import { createAuthenticatedSession, SESSION_COOKIE_NAME } from '../src/lib/server/auth/session';
import { JsonStore } from '../src/lib/server/storage/json-store';

// This file has no top-level I/O. Ordinary suite discovery must never contact a provider.
const enabled = process.env.DATE_AGENT_REAL === '1';
const feedbackOnly = process.env.DATE_AGENT_REAL_FEEDBACK_ONLY === '1';
const finalReal = process.env.DATE_AGENT_FINAL_REAL === '1';
const finalRecovery = process.env.DATE_AGENT_FINAL_RECOVERY === '1';
const finalAttribution = process.env.DATE_AGENT_FINAL_ATTRIBUTION === '1';
const artifacts = process.env.DATE_AGENT_ARTIFACTS ?? '';
const dataRoot = process.env.APP_DATA_DIR ?? '';
const baseURL = process.env.DATE_AGENT_BASE_URL ?? '';
const preparePath = '/date-companion/a/prepare';
const syntheticQuote = '旅行时我更想在海边慢慢散步。';
const firstPrompt = '明天下午要见 Ta，想轻松一点。帮我查一下上次聊旅行时 Ta 的原话，告诉我是哪次记录，再给我一个可选的小准备。';
const feedback = '上次没有聊旅行。我觉得 Ta 那天工作很累，我们后来只是安静地散了会儿步。请根据这次实际情况调整一个下次见面的小建议，别替我留下。';
const discussion = '没有录音，也不用历史资料。我有点担心提起之前的分歧会让见面变尴尬，目前只想聊聊这种顾虑，不要给我准备清单或行动建议。';
const modelWaitMs = 225_000;

test.skip(!enabled, 'Requires DATE_AGENT_REAL=1 and an isolated guarded real acceptance run.');
test.describe.configure({ mode: 'default', retries: 0, timeout: 560_000 });
test.use({ serviceWorkers: 'block', trace: 'off', video: 'off' });

type GuardState = { maxRequests: number; sent: number; completed: number; unknown: number; active: number; halted: boolean; haltReason: string | null; evidenceMode: string; model: string };
async function readGuard() {
  const state = JSON.parse(await readFile(join(artifacts, 'state.json'), 'utf8')) as GuardState;
  if (state.evidenceMode !== 'real' || state.model !== 'deepseek-v4-pro' || state.maxRequests !== 12 || typeof state.halted !== 'boolean'
    || ![state.sent, state.completed, state.unknown, state.active].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid real acceptance guard state');
  return state;
}
function blocked(state: GuardState) {
  if (state.halted) return 'guard_halted';
  if (state.unknown || state.active || state.sent !== state.completed) return 'unknown_or_inflight';
  return state.sent < state.maxRequests ? null : 'request_budget_exhausted';
}
async function save(name: string, data: unknown) {
  await writeFile(join(artifacts, `${name}.json`), JSON.stringify(data, null, 2));
}
async function authorize(step: string) {
  const state = await readGuard();
  await save(`${step}-guard`, state);
  const reason = blocked(state);
  if (reason) { await save(`${step}-blocked`, { status: 'BLOCKED', reason }); throw new Error(`BLOCKED: ${reason}`); }
}
function verifyPaths() {
  if (!artifacts || !dataRoot || !baseURL) throw new Error('Missing isolated real-run paths');
  const origin = new URL(baseURL);
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname) || !origin.port || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('Expected a loopback Next origin');
  const child = relative(resolve(artifacts), resolve(dataRoot));
  if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('APP_DATA_DIR must be inside this acceptance artifact directory');
}
async function installBrowserGuard(context: BrowserContext) {
  const origin = new URL(baseURL).origin;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort('blockedbyclient');
    await route.continue();
  });
  await context.routeWebSocket('**/*', socket => {
    const url = new URL(socket.url());
    if (url.protocol === 'ws:' && `http://${url.host}` === origin) socket.connectToServer();
    else socket.close({ code: 1008, reason: 'loopback only' });
  });
}
async function register(context: BrowserContext, name: string) {
  const email = `date-real-${randomUUID()}@example.test`;
  const password = `${randomUUID()}Ab!`;
  const registered = await context.request.post(`${baseURL}/api/auth/register`, { data: { email, password, name, inviteCode: 'date-agent-fixture' }, maxRedirects: 0 });
  expect(registered.status()).toBe(201);
  const accountId = (await registered.json()).user.id as string;
  const loggedIn = await context.request.post(`${baseURL}/api/auth/login`, { data: { email, password }, maxRedirects: 0 });
  expect(loggedIn.status()).toBe(200);
  return accountId;
}
function seedOneConfirmedRecord(accountId: string, quote = syntheticQuote, recordingDate = '2026-11-01') {
  const db = openDateCompanionDatabase({ filePath: join(dataRoot, 'date-companion.sqlite') });
  try {
    const repo = new DateCompanionRepository(db);
    const relationship = repo.createOrGetRelationship(accountId, 'Ta').relationship;
    const uploadId = `synthetic-travel-${randomUUID()}`;
    const imported = repo.importInteraction({ userId: accountId, relationshipId: relationship.id, sourceUploadId: uploadId, recordingDate, originalName: '合成相处记录',
      participants: [{ speakerId: 'self' }, { speakerId: 'ta' }], recapCandidates: [{ kind: 'mentioned', proposedText: quote === syntheticQuote ? '谈起旅行' : '散步时的片段', sortOrder: 0,
        evidence: [{ uploadId, sourceSegmentId: 'travel-segment', speakerId: 'ta', startSeconds: 0, endSeconds: 4, quote }] }] });
    const record = repo.getRelationshipView(accountId, relationship.id).interactions.find(row => row.id === imported.interactionId)!;
    repo.updateRecap({ userId: accountId, interactionId: record.id, version: record.version, assignments: [{ speakerId: 'self', role: 'self' }, { speakerId: 'ta', role: 'companion' }],
      mutations: record.recapItems.map(item => ({ id: item.id, version: item.version, disposition: 'kept' })), finalize: true });
    const outboxCount = (db.prepare('SELECT COUNT(*) AS n FROM dc_memory_bridge_outbox').get() as { n: number }).n;
    return { interactionId: record.id, outboxCount };
  } finally { db.close(); }
}
async function screenshot(page: Page, label: string) {
  await page.screenshot({ path: join(artifacts, `${label}.png`), fullPage: true });
}
async function getView(page: Page, id: string, evidence: string) {
  const result = await page.evaluate(async preparationId => {
    const response = await fetch(`/api/date-companion/preparations/${encodeURIComponent(preparationId)}`, { cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
    return { status: response.status, body: await response.json() };
  }, id);
  expect(result.status).toBe(200);
  const view = result.body.view as PreparationView;
  await save(evidence, view);
  return view;
}
async function sendOnce(page: Page, label: string, text: string, name: string, id?: string) {
  const path = `/api/date-companion/preparations${id ? `/${id}/turns` : ''}`;
  await page.getByRole('textbox', { name: label, exact: true }).fill(text);
  await authorize(name);
  // No assertion/retry wrapper around this click or this POST. The server guard owns each SDK request.
  const [response] = await Promise.all([
    page.waitForResponse(r => r.url() === new URL(path, baseURL).href && r.request().method() === 'POST', { timeout: modelWaitMs }),
    page.getByRole('button', { name: '发送', exact: true }).click()
  ]);
  const result = await response.json();
  await save(`${name}-result`, { httpStatus: response.status(), view: result.view ?? null });
  await screenshot(page, `${name}-result`);
  expect(response.status()).toBe(200);
  const view = result.view as PreparationView;
  expect(typeof view?.id).toBe('string');
  expect(view.generationStatus).toBe('idle');
  expect(view.messages.filter(m => m.role === 'user').at(-1)?.text).toBe(text);
  expect(view.messages.at(-1)?.role).toBe('assistant');
  const reply = view.messages.at(-1)!;
  expect(Boolean(reply.text.trim()) || view.items.some(item => item.sourceMessageId === reply.id && item.status === 'suggested'), 'A reply needs visible content or its own selectable item').toBe(true);
  return view;
}
// Bind the visible action to its own assistant turn, not another suggestion elsewhere in history.
async function recordVisibleTurn(page: Page, view: PreparationView, name: string) {
  const message = view.messages.at(-1)!;
  const article = page.getByRole('article', { name: '助手回复', exact: true }).last();
  const cards = article.getByRole('group', { name: '可选准备', exact: true });
  const items = view.items.filter(item => item.sourceMessageId === message.id && item.status === 'suggested');
  await expect(article).toBeVisible();
  if (message.text.trim()) await expect(article).toContainText(message.text);
  await expect(cards).toHaveCount(items.length);
  for (const [index, item] of items.entries()) {
    await expect(cards.nth(index).locator('p')).toHaveText(item.text);
    await expect(cards.nth(index).getByRole('button', { name: '留下这条', exact: true })).toBeVisible();
  }
  const visibleDiscussion = await article.locator(':scope > p').allTextContents();
  const visibleSuggestions = await cards.locator('p').allTextContents();
  await save(name, { assistantMessageId: message.id, visibleDiscussion, visibleSuggestions, currentDate: view.date,
    savedItemIds: items.map(item => item.id), savedItemTexts: items.map(item => item.text), sources: message.sources });
  return { article, cards, visibleDiscussion, visibleSuggestions };
}
function ledger(accountId: string, preparationId: string) {
  const db = new Database(join(dataRoot, 'date-companion.sqlite'), { readonly: true, fileMustExist: true });
  try {
    const where = `t.account_id=? AND t.resource_id=? AND t.scenario='date_companion_preparation_v1'`;
    const actions = db.prepare(`SELECT t.id AS taskId,a.step,a.tool,a.status FROM agent_actions a JOIN agent_tasks t ON t.id=a.task_id WHERE ${where} ORDER BY t.created_at,a.step`).all(accountId, preparationId) as { taskId: string; step: number; tool: string; status: string }[];
    const calls = db.prepare(`SELECT c.kind,c.model,c.status,c.input_tokens,c.output_tokens FROM agent_calls c JOIN agent_tasks t ON t.id=c.task_id WHERE ${where} ORDER BY c.created_at`).all(accountId, preparationId);
    return { actions, calls };
  } finally { db.close(); }
}
function assertNoOtherWrites(outboxCount: number) {
  const db = new Database(join(dataRoot, 'date-companion.sqlite'), { readonly: true });
  try {
    expect(db.prepare('SELECT COUNT(*) AS n FROM dc_promises').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM dc_memory_bridge_outbox').get()).toEqual({ n: outboxCount });
  } finally { db.close(); }
  if (existsSync(join(dataRoot, 'memory.sqlite'))) {
    const memory = new Database(join(dataRoot, 'memory.sqlite'), { readonly: true });
    try { for (const table of ['memory_items', 'person_facts']) expect(memory.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 }); }
    finally { memory.close(); }
  }
  expect(existsSync(join(dataRoot, 'work-review.sqlite'))).toBe(false);
}
async function composerVisible(page: Page) {
  const box = await page.getByRole('button', { name: '发送', exact: true }).boundingBox();
  expect(box).toBeTruthy();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test.beforeEach(async ({ context }, info) => {
  verifyPaths();
  expect(info.config.workers, 'Real budget must be shared by one sequential worker').toBe(1);
  await installBrowserGuard(context);
});
test.afterEach(async ({ page }, info) => {
  if (!enabled || info.status === 'skipped' || !artifacts) return;
  const name = info.title.includes('@final-attribution') ? 'final-attribution' : info.title.includes('@final-recovery') ? 'final-recovery' : info.title.includes('@final') ? `final-${info.title[0]}` : ({ '1': 'history', '2': 'discussion', '3': 'independent-feedback', '4': 'independent-discussion', '5': 'independent-quote' } as Record<string,string>)[info.title[0]];
  await save(`${name}-test-status`, { status: info.status, errorCount: info.errors.length });
  if (info.status !== 'passed' && !page.isClosed()) await screenshot(page, `${name}-failure`).catch(() => undefined);
});

async function verifyFeedbackRound({ page, context, accountId, initial, oldGoal, prefix, sourceId, outboxCount }: {
  page: Page; context: BrowserContext; accountId: string; initial: PreparationView; oldGoal: string;
  prefix: 'history' | 'independent'; sourceId?: string; outboxCount: number;
}) {
  const choice = initial.items.filter(item => item.status === 'selected');
  expect(choice).toHaveLength(1);
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(`${baseURL}${preparePath}`);
  await expect(reopened.getByText('这次想记得的事 · 1', { exact: true })).toBeVisible();
  const restored = await getView(reopened, initial.id, `${prefix}-reopened`);
  expect(restored.items.filter(i => i.status === 'selected')).toEqual(choice);
  await reopened.getByRole('button', { name: '回来记一下', exact: true }).click();
  const after = await sendOnce(reopened, '后来怎么样？', feedback, `${prefix}-feedback-turn`, initial.id);
  const feedbackLedger = ledger(accountId, initial.id);
  await save(`${prefix}-feedback-ledger`, feedbackLedger);
  const responseUi = await recordVisibleTurn(reopened, after, `${prefix}-feedback-visible-turn`);
  expect(after.messages).toContainEqual(expect.objectContaining({ text: feedback, origin: 'user_reflection', role: 'user', kind: 'feedback' }));
  expect(after.items.filter(i => i.status === 'selected')).toEqual(choice);
  const added = after.items.filter(i => !restored.items.some(prior => prior.id === i.id));
  expect.soft(added).toHaveLength(1);
  expect(added.every(i => i.status === 'suggested' && i.sourceMessageId === after.messages.at(-1)?.id)).toBe(true);
  const feedbackMessage = after.messages.filter(m => m.role === 'user').at(-1)!;
  const adjustedReply = after.messages.at(-1)!;
  expect(feedbackMessage.sources).toEqual([]);
  const citations = [...adjustedReply.sources, ...added.flatMap(item => item.sources)];
  if (sourceId) {
    for (const citation of citations) expect(citation).toMatchObject({ interactionId: sourceId, quote: syntheticQuote, origin: 'direct_conversation' });
  } else expect(citations).toEqual([]);
  // Check persisted time and the specific prior stale-scheduling wording. General
  // attribution, chronology, and whether the discussion suggests an extra action
  // require independent review of the entire reply (saved alongside the UI text).
  expect.soft(after.date, 'No next date was supplied in the feedback').toBeNull();
  const nextHelp = [...responseUi.visibleDiscussion, ...responseUi.visibleSuggestions].join('\n');
  expect.soft(nextHelp).not.toMatch(/(?:^|[。！？\n])\s*明天下午(?:如果|见面|可以|不妨|你们|见到)/u);
  await save(`${prefix}-feedback-semantic-review-input`, { firstPrompt: oldGoal, feedback: feedbackMessage, originalChoice: choice,
    assistantDiscussion: adjustedReply.text, currentDate: after.date, adjustedItems: added, visibleDiscussion: responseUi.visibleDiscussion,
    visibleSuggestions: responseUi.visibleSuggestions, review: ['旧时段是否成了下次安排', '回复有没有在唯一条目外另外提方案', '是否把用户觉得工作累说成 Ta 已确认'] });
  await reopened.reload();
  await expect(reopened.getByRole('region', { name: '聊天记录' })).toContainText(feedback);
  const persisted = await getView(reopened, initial.id, `${prefix}-feedback-reloaded`);
  expect(persisted.messages).toEqual(after.messages);
  expect(persisted.items).toEqual(after.items);
  await reopened.getByRole('article', { name: '助手回复' }).last().scrollIntoViewIfNeeded();
  await screenshot(reopened, `${prefix}-feedback-reloaded`);
  if (prefix === 'independent') {
    const desktop = reopened.viewportSize()!;
    await reopened.setViewportSize({ width: 390, height: 844 });
    await reopened.getByRole('article', { name: '助手回复', exact: true }).last().scrollIntoViewIfNeeded();
    await composerVisible(reopened);
    await screenshot(reopened, `${prefix}-feedback-mobile-same-reply`);
    await reopened.setViewportSize(desktop);
  }
  // The user is now deliberately selecting the new option. Everything until this
  // point must preserve the first choice and keep the adjusted one unselected.
  expect(added.length, 'A proposed adjustment must be selectable').toBeGreaterThan(0);
  const adjustment = added[0];
  const requestCountBeforeSelection = (await readGuard()).sent;
  const reloadedUi = await recordVisibleTurn(reopened, persisted, `${prefix}-feedback-reloaded-visible-turn`);
  const card = reloadedUi.cards.filter({ has: reopened.getByText(adjustment.text, { exact: true }) }).first();
  const [selectionResponse] = await Promise.all([
    reopened.waitForResponse(r => r.request().method() === 'PATCH' && new URL(r.url()).pathname === `/api/date-companion/preparations/${initial.id}`),
    card.getByRole('button', { name: '留下这条', exact: true }).click()
  ]);
  expect(selectionResponse.status()).toBe(200);
  expect(selectionResponse.request().postDataJSON()).toMatchObject({ kind: 'select', itemId: adjustment.id });
  await expect(reopened.getByText('这次想记得的事 · 2', { exact: true })).toBeVisible();
  const selectedAfterFeedback = await getView(reopened, initial.id, `${prefix}-feedback-selected`);
  const expectedChoices = [...choice, { ...adjustment, status: 'selected' }];
  expect(selectedAfterFeedback.items.filter(item => item.status === 'selected')).toEqual(expectedChoices);
  expect(selectedAfterFeedback.messages).toEqual(persisted.messages);
  await reopened.close();
  const finalPage = await context.newPage();
  await finalPage.goto(`${baseURL}${preparePath}`);
  const pinned = finalPage.locator('details').filter({ has: finalPage.getByText('这次想记得的事 · 2', { exact: true }) });
  await expect(pinned).toBeVisible();
  for (const item of expectedChoices) await expect(pinned.getByText(item.text, { exact: true })).toBeVisible();
  const finalReply = finalPage.getByRole('article', { name: '助手回复', exact: true }).last();
  await expect(finalReply.getByRole('group', { name: '已选准备', exact: true }).getByText(adjustment.text, { exact: true })).toBeVisible();
  const finalState = await getView(finalPage, initial.id, `${prefix}-feedback-selected-reopened`);
  expect(finalState.items).toEqual(selectedAfterFeedback.items);
  expect(finalState.messages).toEqual(after.messages);
  const finalLedger = ledger(accountId, initial.id);
  await save(`${prefix}-feedback-selected-reopened-ledger`, finalLedger);
  expect(finalLedger).toEqual(feedbackLedger);
  const requestCountAfterReopen = (await readGuard()).sent;
  await save(`${prefix}-manual-selection-requests`, { before: requestCountBeforeSelection, after: requestCountAfterReopen });
  expect(requestCountAfterReopen).toBe(requestCountBeforeSelection);
  await screenshot(finalPage, `${prefix}-feedback-selected-reopened`);
  assertNoOtherWrites(outboxCount);
}

test('1 historical quote, explicit selection, reopen and adjusted feedback', async ({ page, context }) => {
  test.skip(feedbackOnly, 'Independent feedback run');
  await save('history-expected', { firstPrompt, feedback, syntheticQuote, recordingDate: '2026-11-01', expected: ['真实检索和原话读取', '原记录中的 Ta 原话', '一个轻松的可选准备', '选用跨重开保存', '反馈作为用户转述', '一个已调整且未选用的新建议', '反馈中的工作疲累是用户印象，下一次日期未知', '回复内的可选动作与同一条目正文、ID一致', '明确选用调整项后，两个选择跨关闭恢复'] });
  await authorize('history-start');
  const accountId = await register(context, '合成历史对话验收');
  const source = seedOneConfirmedRecord(accountId);
  await page.goto(`${baseURL}${preparePath}`);
  await expect(page.getByText('从你现在想说的开始。', { exact: true })).toBeVisible();
  await screenshot(page, 'history-default');
  await page.getByRole('button', { name: '资料范围', exact: true }).click();
  await page.getByLabel(/2026-11-01 ·/).check();
  await page.getByRole('button', { name: '用这些资料', exact: true }).click();
  const first = await sendOnce(page, '想聊点什么？', firstPrompt, 'history-first-turn');
  const firstLedger = ledger(accountId, first.id);
  await save('history-first-ledger', firstLedger);
  const tools = firstLedger.actions.filter(a => a.status === 'succeeded').map(a => a.tool);
  expect(tools).toEqual(expect.arrayContaining(['search_records', 'read_source', 'respond']));
  expect(firstLedger.calls.length).toBeGreaterThan(0);
  expect(first.interactionIds).toEqual([source.interactionId]);
  expect(first.allowRetained).toBe(false);
  const reply = first.messages.at(-1)!;
  const citation = reply.sources.find(s => s.valid && s.interactionId === source.interactionId && s.quote === syntheticQuote);
  expect(citation).toMatchObject({ origin: 'direct_conversation', recordingDate: '2026-11-01', speakerRole: 'companion' });
  const firstVisible = await recordVisibleTurn(page, first, 'history-first-visible-turn');
  const sourceDisclosure = firstVisible.article;
  await sourceDisclosure.locator('summary').filter({ hasText: '看看来源' }).click();
  await expect(sourceDisclosure.getByText(syntheticQuote, { exact: true })).toBeVisible();
  await expect(sourceDisclosure.getByRole('link', { name: '查看原记录' })).toHaveAttribute('href', citation!.href);
  await sourceDisclosure.getByText(syntheticQuote, { exact: true }).scrollIntoViewIfNeeded();
  await screenshot(page, 'history-verified-source');
  const suggestions = first.items.filter(i => i.status === 'suggested');
  expect(first.items.filter(i => i.status === 'selected')).toHaveLength(0);
  expect.soft(suggestions).toHaveLength(1);
  expect(suggestions.length).toBeGreaterThan(0);
  await firstVisible.cards.first().getByRole('button', { name: '留下这条', exact: true }).click();
  await expect(page.getByText('这次想记得的事 · 1', { exact: true })).toBeVisible();
  const selected = await getView(page, first.id, 'history-selected');
  const choice = selected.items.filter(i => i.status === 'selected');
  expect(choice).toHaveLength(1);
  expect(choice[0].id).toBe(suggestions[0].id);
  await screenshot(page, 'history-selected');
  await verifyFeedbackRound({ page, context, accountId, initial: selected, oldGoal: firstPrompt,
    prefix: 'history', sourceId: source.interactionId, outboxCount: source.outboxCount });
});

async function runDiscussion(page: Page, context: BrowserContext, prompt: string, prefix: string) {
  await save(`${prefix}-expected`, { discussion: prompt, expected: ['独立新账号没有录音', '资料范围为空', '不编造以前的谈话', '回应这次顾虑', '不登记准备或自动安排动作'] });
  const state = await readGuard();
  const accountId = await register(context, '合成无历史验收');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseURL}/date-companion/a`);
  await expect(page.getByText('从你现在想说的开始。', { exact: true })).toBeVisible();
  await composerVisible(page);
  await screenshot(page, `${prefix}-mobile-default`);
  const reason = blocked(state) ?? blocked(await readGuard());
  if (reason) {
    await page.setViewportSize({ width: 390, height: 480 });
    await composerVisible(page);
    await screenshot(page, `${prefix}-mobile-blocked-no-real-answer`);
    await save(`${prefix}-blocked`, { status: 'BLOCKED', reason, submitted: false, realAnswer: false });
    test.skip(true, `BLOCKED: ${reason}`);
    return;
  }
  const view = await sendOnce(page, '想聊点什么？', prompt, `${prefix}-only-turn`);
  await save(`${prefix}-ledger`, ledger(accountId, view.id));
  await recordVisibleTurn(page, view, `${prefix}-visible-turn`);
  expect(view.interactionIds).toEqual([]);
  expect(view.allowRetained).toBe(false);
  expect(view.items).toEqual([]);
  expect(view.messages.flatMap(m => m.sources)).toEqual([]);
  await expect(page.getByRole('button', { name: '留下这条', exact: true })).toHaveCount(0);
  await expect(page.getByRole('article', { name: '助手回复' }).last()).toBeVisible();
  await composerVisible(page);
  await screenshot(page, `${prefix}-mobile-reply`);
  await page.setViewportSize({ width: 390, height: 480 });
  await page.getByRole('textbox', { name: '想聊点什么？' }).focus();
  await composerVisible(page);
  await screenshot(page, `${prefix}-mobile-short-viewport`);
  await getView(page, view.id, `${prefix}-persisted`);
}

test('2 fresh account, mobile, no historical material, discussion only', async ({ page, context }) => {
  test.skip(feedbackOnly, 'Independent feedback run');
  await runDiscussion(page, context, discussion, 'discussion');
});

// Synthetic business setup only. No historical recording, imported quote, prior
// provider output, or model request is used to manufacture this starting point.
function seedSelectedPreparation(accountId: string, oldGoal: string) {
  const db = openDateCompanionDatabase({ filePath: join(dataRoot, 'date-companion.sqlite') });
  try {
    const relationship = new DateCompanionRepository(db).createOrGetRelationship(accountId, 'Ta').relationship;
    const repo = new PreparationRepository(db);
    const { id } = repo.create(accountId, relationship.id, { operationKey: randomUUID(), text: oldGoal, interactionIds: [], allowRetained: false });
    const turn = repo.begin(accountId, id, { operationKey: randomUUID(), expectedVersion: 0, text: oldGoal, kind: 'message' });
    if (!turn.generationId || turn.version === undefined) throw Error('Synthetic turn did not start');
    const prepared = repo.commit(accountId, id, { generationId: turn.generationId, version: turn.version,
      text: '你想让这次见面的气氛轻松一点。', suggestions: ['如果聊得自然，可以问问 Ta 最近有没有想去旅行的地方。'],
      date: '2026-11-06', constraints: ['下午'], sources: [] });
    const initial = repo.mutate(accountId, id, { operationKey: randomUUID(), expectedVersion: prepared.version, kind: 'select', itemId: prepared.items[0].id });
    const outboxCount = (db.prepare('SELECT COUNT(*) AS n FROM dc_memory_bridge_outbox').get() as { n: number }).n;
    return { initial, outboxCount };
  } finally { db.close(); }
}

test('3 existing preparation, new feedback @independent-feedback', async ({ page, context }) => {
  test.skip(!feedbackOnly, 'Requires the independent feedback budget continuation');
  await authorize('independent-start');
  const before = await readGuard();
  const accountId = await register(context, '合成已选准备反馈验收');
  const oldGoal = '明天下午（11 月 6 日）和 Ta 见面，想轻松聊聊旅行。';
  const { initial, outboxCount } = seedSelectedPreparation(accountId, oldGoal);
  await save('independent-preset', { provenance: 'synthetic_setup_via_business_repository', oldGoal, initial, realProviderRequestsDuringSetup: 0,
    seeded: ['初次文字表达', '合成讨论句与可选旅行话题', '用户已选用', '旧日期与下午约束'], realTurnUnderTest: feedback, historicalRetrievalTested: false });
  await page.goto(`${baseURL}${preparePath}`);
  await expect(page.getByText('这次想记得的事 · 1', { exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: '助手回复' }).last().getByRole('group', { name: '已选准备' })).toContainText(initial.items[0].text);
  await screenshot(page, 'independent-preset-selected');
  expect((await readGuard()).sent).toBe(before.sent);
  await verifyFeedbackRound({ page, context, accountId, initial, oldGoal, prefix: 'independent', outboxCount });
});

test('4 fresh account, new discussion @independent-feedback', async ({ page, context }) => {
  test.skip(!feedbackOnly, 'Requires the independent feedback budget continuation');
  const prompt = '我担心一开口会显得太认真，先陪我理理这种感觉就好，我还不想决定下一步怎么做。';
  await runDiscussion(page, context, prompt, 'independent-discussion');
});

test('5 read a previously confirmed quote @independent-feedback', async ({ page, context }) => {
  test.skip(!feedbackOnly, 'Requires the guarded continuation');
  const state = await readGuard();
  const reason = blocked(state) ?? (state.maxRequests - state.sent < 3 ? 'insufficient_budget_for_search_read_reply' : null);
  if (reason) {
    await save('independent-quote-blocked', { status: 'BLOCKED', reason, submitted: false });
    test.skip(true, reason);
    return;
  }
  const accountId = await register(context, '合成原话复核');
  const source = seedOneConfirmedRecord(accountId);
  await page.goto(`${baseURL}${preparePath}`);
  await page.getByRole('button', { name: '资料范围', exact: true }).click();
  await page.getByLabel(/2026-11-01 ·/).check();
  await page.getByRole('button', { name: '用这些资料', exact: true }).click();
  const view = await sendOnce(page, '想聊点什么？', '我只想核对上次说起旅行时 Ta 具体说了什么。帮我找原话和那天的日期，不用给建议。', 'independent-quote');
  const receipt = ledger(accountId, view.id);
  await save('independent-quote-ledger', receipt);
  expect(receipt.actions.filter(a => a.status === 'succeeded').map(a => a.tool)).toEqual(expect.arrayContaining(['search_records', 'read_source', 'respond']));
  expect(view.items).toEqual([]);
  const reply = view.messages.at(-1)!;
  expect(reply.sources).toContainEqual(expect.objectContaining({valid:true, interactionId:source.interactionId, speakerRole:'companion', quote:syntheticQuote}));
  const article = page.getByRole('article', { name: '助手回复', exact:true }).last();
  await expect(article.locator(':scope > p')).toContainText(syntheticQuote);
  await article.locator('summary').filter({hasText:'看看来源'}).click();
  await expect(article.getByRole('link', {name:'查看原记录'})).toBeVisible();
  await expect(article.getByText(syntheticQuote, {exact:true})).toBeVisible();
  await screenshot(page, 'independent-quote-verified');
  assertNoOtherWrites(source.outboxCount);
});

// This separately authorized final batch uses only live model replies. The sole
// seeded content is an explicitly synthetic, already-confirmed business record.
const finalFirstPrompt = '明天下午（11 月 7 日）见 Ta，想轻松一点。如果有自然的机会，我想聊聊旅行。只给我一条可选的小准备，先不要替我留下。';
const finalQuote = '今天想沿着河边慢慢走，在石拱桥边看看水。';
const finalRecordDate = '2026-11-07';
const finalReviewPrompt = '请读这份复盘里 Ta 的原话，对照我原来留下的准备，聊聊这份记录支持什么。旅行没有被录下来，能确定我们没有聊过吗？先聊理解，不要给下一次建议。';
const finalFeedback = '这次没聊旅行。我觉得 Ta 工作有点累，我们就在附近安静走了走。下次时间还没定，只要一条建议，别自动留下。';

async function finalPatch(page: Page, id: string, button: Locator, name: string) {
  const before = (await readGuard()).sent;
  const [response] = await Promise.all([
    page.waitForResponse(r => r.request().method() === 'PATCH' && new URL(r.url()).pathname === `/api/date-companion/preparations/${id}`),
    button.click()
  ]);
  const body = await response.json();
  await save(name, { status: response.status(), request: response.request().postDataJSON(), view: body.view });
  expect(response.status()).toBe(200);
  expect((await readGuard()).sent, 'A manual edit, association or selection must not invoke the model').toBe(before);
  return body.view as PreparationView;
}

async function finalLayout(page: Page) {
  return page.evaluate(() => {
    const pane = document.querySelector('[aria-label="聊天记录"]')!;
    const input = document.querySelector<HTMLTextAreaElement>('#companion-message')!;
    const send = input.form!.querySelector('button[type="submit"]')!.getBoundingClientRect();
    return { width: innerWidth, height: innerHeight, pageWidth: document.documentElement.scrollWidth,
      pageHeight: document.documentElement.scrollHeight, messageHeight: pane.clientHeight,
      messageScrollHeight: pane.scrollHeight, inputBottom: input.getBoundingClientRect().bottom, sendBottom: send.bottom };
  });
}

test('1 continuous preparation, linked recap, feedback and next choice @final', async ({ page, context }) => {
  test.skip(!finalReal || finalRecovery, 'Requires the initial final acceptance batch');
  await authorize('final-continuous-start');
  const accountId = await register(context, '合成最终连续使用验收');
  const source = seedOneConfirmedRecord(accountId, finalQuote, finalRecordDate);
  await save('final-continuous-expected', { provenance: 'synthetic confirmed recap; all assistant replies generated live',
    firstPrompt: finalFirstPrompt, reviewPrompt: finalReviewPrompt, feedback: finalFeedback, source,
    quote: finalQuote, recordingDate: finalRecordDate });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${baseURL}${preparePath}`);
  await expect(page.getByRole('textbox', { name: '想聊点什么？', exact: true })).toBeVisible();
  await screenshot(page, 'final-desktop-default');
  const first = await sendOnce(page, '想聊点什么？', finalFirstPrompt, 'final-first');
  const firstVisible = await recordVisibleTurn(page, first, 'final-first-visible');
  const firstOptions = first.items.filter(item => item.sourceMessageId === first.messages.at(-1)?.id && item.status === 'suggested');
  expect(firstOptions, 'Only one option was requested').toHaveLength(1);
  expect(firstOptions.length, 'The live suggestion must have a selectable business item').toBeGreaterThan(0);
  expect(first.items.filter(item => item.status === 'selected')).toEqual([]);
  expect(first.interactionIds).toEqual([]); expect(first.allowRetained).toBe(false);
  expect(first.messages.flatMap(message => message.sources)).toEqual([]);
  const initial = await finalPatch(page, first.id, firstVisible.cards.first().getByRole('button', { name: '留下这条', exact: true }), 'final-first-selected');
  const originalChoice = initial.items.find(item => item.id === firstOptions[0].id)!;
  expect(originalChoice.status).toBe('selected');
  await expect(page.getByText('这次想记得的事 · 1', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '用一份相处记录聊聊', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '选一份相处记录', exact: true });
  expect(await picker.getByRole('radio', { checked: true }).count()).toBe(0);
  await expect(picker).toContainText('关联不会开启长期记忆');
  await picker.getByRole('radio', { name: new RegExp(finalRecordDate) }).check();
  const linked = await finalPatch(page, initial.id, picker.getByRole('button', { name: '用这份记录', exact: true }), 'final-explicit-link');
  expect(linked.reviewLink).toMatchObject({ interactionId: source.interactionId, recordingDate: finalRecordDate, originalItemIds: [originalChoice.id] });
  expect(linked.interactionIds).toEqual([]); expect(linked.allowRetained).toBe(false);
  await finalReviewAndNext(page, context, accountId, initial, source, 'final', finalReviewPrompt);
});

async function finalReviewAndNext(page: Page, context: BrowserContext, accountId: string, first: PreparationView,
  source: { interactionId: string; outboxCount: number }, prefix: 'final' | 'final-recovery', reviewPrompt: string) {
  const originalChoice = first.items.find(item => item.status === 'selected')!;
  expect(originalChoice).toBeTruthy();
  const reviewed = await sendOnce(page, '想聊点什么？', reviewPrompt, `${prefix}-review`, first.id);
  const reviewLedger = ledger(accountId, first.id);
  await save(`${prefix}-review-ledger`, reviewLedger);
  const tools = reviewLedger.actions.filter(action => action.status === 'succeeded').map(action => action.tool);
  expect(tools).toContain('read_source');
  expect(tools.some(tool => ['list_review_sources', 'search_records'].includes(tool))).toBe(true);
  const reviewedMessage = reviewed.messages.at(-1)!;
  expect(reviewedMessage.sources).toContainEqual(expect.objectContaining({ valid: true, interactionId: source.interactionId,
    recordingDate: finalRecordDate, quote: finalQuote, origin: 'direct_conversation', speakerRole: 'companion' }));
  expect(reviewed.items.filter(item => item.sourceMessageId === reviewedMessage.id), 'The review asked for discussion only').toEqual([]);
  const reviewUi = await recordVisibleTurn(page, reviewed, `${prefix}-review-visible`);
  await reviewUi.article.locator('summary').filter({ hasText: '看看来源' }).click();
  await expect(reviewUi.article.getByText(finalQuote, { exact: true })).toBeVisible();
  const originalLink = reviewUi.article.getByRole('link', { name: '查看原记录', exact: true });
  await expect(originalLink).toBeVisible();
  await originalLink.scrollIntoViewIfNeeded();
  await screenshot(page, `${prefix}-desktop-verified-source`);
  const recap = await context.newPage();
  await recap.goto(new URL((await originalLink.getAttribute('href'))!, baseURL).href);
  await expect(recap.getByLabel('本次录音信息')).toContainText('合成相处记录');
  const raw = recap.locator('details').filter({ has: recap.getByText(finalQuote, { exact: false }) }).last();
  if (!await raw.evaluate(element => element.hasAttribute('open'))) await raw.locator('summary').first().click();
  await expect(raw).toContainText(finalQuote);
  await recap.close();

  await page.getByRole('button', { name: '回来记一下', exact: true }).click();
  const after = await sendOnce(page, '后来怎么样？', finalFeedback, `${prefix}-feedback`, first.id);
  const afterUi = await recordVisibleTurn(page, after, `${prefix}-feedback-visible`);
  const nextMessage = after.messages.at(-1)!;
  const options = after.items.filter(item => item.sourceMessageId === nextMessage.id && item.status === 'suggested');
  expect(options, 'Exactly one next suggestion, with no automatic adoption').toHaveLength(1);
  expect(options.length).toBeGreaterThan(0);
  expect(after.items.filter(item => item.status === 'selected')).toEqual([originalChoice]);
  expect(after.messages).toContainEqual(expect.objectContaining({ role: 'user', text: finalFeedback, kind: 'feedback', origin: 'user_reflection', sources: [] }));
  expect.soft(after.date, 'The next meeting is unscheduled').toBeNull();
  expect(options[0].meetingId).toBe(after.currentMeetingId);
  expect(originalChoice.meetingId).not.toBe(after.currentMeetingId);
  await save(`${prefix}-quality-review`, { originalChoice, firstDate: first.date, currentDate: after.date,
    reviewText: reviewedMessage.text, reviewSources: reviewedMessage.sources,
    feedback: after.messages.filter(message => message.role === 'user').at(-1),
    nextDiscussion: nextMessage.text, nextSuggestions: options,
    visibleDiscussion: afterUi.visibleDiscussion, visibleSuggestions: afterUi.visibleSuggestions,
    reviewRequired: ['数量', '旧时间没有顺延', '用户觉得累保留主观归因', '未记录不能推出未发生', '无额外重复前言或另一条行动'] });

  await page.setViewportSize({ width: 390, height: 844 });
  await afterUi.cards.first().scrollIntoViewIfNeeded();
  await composerVisible(page);
  await screenshot(page, `${prefix}-mobile-next-option`);
  const originalSuggestion = options[0];
  const editedText = `${originalSuggestion.text.replace(/[。\s]+$/u, '')}。如果当时不想聊，也可以先放下。`;
  await afterUi.cards.first().getByRole('button', { name: '改一下', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '改一下这条', exact: true });
  await edit.getByRole('textbox', { name: '内容', exact: true }).fill(editedText);
  await screenshot(page, `${prefix}-mobile-edit`);
  const edited = await finalPatch(page, first.id, edit.getByRole('button', { name: '保存修改', exact: true }), `${prefix}-edited`);
  expect(edited.items.find(item => item.id === originalSuggestion.id)).toMatchObject({ text: editedText, status: 'suggested' });
  await expect(afterUi.cards.first().locator('p')).toHaveText(editedText);
  const selected = await finalPatch(page, first.id, afterUi.cards.first().getByRole('button', { name: '留下这条', exact: true }), `${prefix}-next-selected`);
  expect(selected.items.filter(item => item.status === 'selected').map(item => item.id)).toEqual([originalChoice.id, originalSuggestion.id]);
  await expect(page.getByText('这次想记得的事 · 1', { exact: true })).toBeVisible();
  const mobile = await finalLayout(page);
  await page.setViewportSize({ width: 390, height: 480 });
  await page.getByRole('textbox', { name: '想聊点什么？', exact: true }).focus();
  await composerVisible(page);
  const shortMobile = await finalLayout(page);
  await screenshot(page, `${prefix}-mobile-small-viewport`);

  const callsBeforeReopen = (await readGuard()).sent;
  const url = page.url(); await page.close();
  const reopened = await context.newPage();
  await reopened.setViewportSize({ width: 1280, height: 720 });
  await reopened.goto(url);
  await expect(reopened.getByText('这次想记得的事 · 1', { exact: true })).toBeVisible();
  const restored = await getView(reopened, first.id, `${prefix}-closed-reopened`);
  expect(restored.items).toEqual(selected.items);
  expect(restored.messages).toEqual(selected.messages);
  expect(restored.events).toEqual(selected.events);
  expect(restored.reviewLink).toEqual(selected.reviewLink);
  expect(restored.date).toBeNull();
  const current = reopened.locator('details').filter({ has: reopened.getByText('这次想记得的事 · 1', { exact: true }) });
  await expect(current.getByText(editedText, { exact: true })).toBeVisible();
  const old = reopened.locator('details').filter({ has: reopened.locator('summary').filter({ hasText: '以前留下的' }) }).first();
  await expect(old).not.toHaveAttribute('open', '');
  await old.locator('summary').first().click();
  await expect(old.getByText(originalChoice.text, { exact: true })).toBeVisible();
  await old.locator('summary').first().click();
  const finalReply = reopened.getByRole('article', { name: '助手回复', exact: true }).last();
  await expect(finalReply.getByRole('group', { name: '已选准备', exact: true }).locator('p')).toHaveText(editedText);
  await finalReply.scrollIntoViewIfNeeded();
  const desktop = await finalLayout(reopened);
  expect(desktop.pageHeight).toBeLessThanOrEqual(desktop.height + 2);
  await composerVisible(reopened);
  await screenshot(reopened, `${prefix}-desktop-reopened`);
  await save(`${prefix}-continuous-layout-and-identity`, { desktop, mobile, shortMobile, originalChoiceId: originalChoice.id,
    nextChoiceId: originalSuggestion.id, generatedText: originalSuggestion.text, editedAndSavedText: editedText,
    requestsBeforeReopen: callsBeforeReopen, requestsAfterReopen: (await readGuard()).sent,
    trueDeviceKeyboard: 'NOT RUN: browser viewport simulation only' });
  expect((await readGuard()).sent).toBe(callsBeforeReopen);
  await save(`${prefix}-complete-ledger`, ledger(accountId, first.id));
  assertNoOtherWrites(source.outboxCount);
  console.log(`[date-agent-final-real] ${prefix === 'final' ? '1/2' : 'recovered 1/1'} continuous flow complete`);
}

test('2 no history and discussion only @final', async ({ page, context }) => {
  test.skip(!finalReal || finalRecovery, 'Requires the initial final acceptance batch');
  await runDiscussion(page, context, discussion, 'final-discussion');
  const body = JSON.parse(await readFile(join(artifacts, 'final-discussion-only-turn-result.json'), 'utf8')) as { view: PreparationView };
  const saved = body.view;
  await page.reload();
  await expect(page.getByRole('region', { name: '聊天记录', exact: true })).toContainText(discussion);
  const reopened = await getView(page, saved.id, 'final-discussion-reopened');
  expect(reopened.messages).toEqual(saved.messages); expect(reopened.items).toEqual([]);
  const db = new Database(join(dataRoot, 'date-companion.sqlite'), { readonly: true });
  try {
    expect(db.prepare('SELECT COUNT(*) AS n FROM dc_promises').get()).toEqual({ n: 0 });
    const owner = db.prepare('SELECT user_id FROM dc_preparations WHERE id=?').get(saved.id) as { user_id: string };
    expect(db.prepare('SELECT COUNT(*) AS n FROM dc_memory_bridge_outbox WHERE user_id=?').get(owner.user_id)).toEqual({ n: 0 });
  } finally { db.close(); }
  expect(existsSync(join(dataRoot, 'work-review.sqlite'))).toBe(false);
  await page.setViewportSize({ width: 1280, height: 720 });
  await composerVisible(page);
  await screenshot(page, 'final-discussion-desktop-reopened');
  console.log('[date-agent-final-real] 2/2 no-history discussion complete');
});

test('1 recover the same selected and linked discussion @final-recovery', async ({ page, context }) => {
  test.skip(!finalReal || !finalRecovery, 'Requires an explicit same-ledger recovery launch');
  await authorize('final-recovery-start');
  const failure = JSON.parse(await readFile(join(artifacts, 'final-review-result.json'), 'utf8')) as { view: PreparationView };
  const initial = JSON.parse(await readFile(join(artifacts, 'final-first-selected.json'), 'utf8')) as { view: PreparationView };
  const expected = JSON.parse(await readFile(join(artifacts, 'final-continuous-expected.json'), 'utf8')) as {
    source: { interactionId: string; outboxCount: number }; firstPrompt: string; quote: string; recordingDate: string;
  };
  expect(failure.view.generationStatus).toBe('failed');
  expect(failure.view.id).toBe(initial.view.id);
  expect(expected.firstPrompt).toBe(finalFirstPrompt);
  expect(expected.quote).toBe(finalQuote); expect(expected.recordingDate).toBe(finalRecordDate);
  expect(failure.view.reviewLink?.interactionId).toBe(expected.source.interactionId);
  expect(initial.view.items.filter(item => item.status === 'selected')).toHaveLength(1);

  // Only restore authentication for this verified synthetic account. This uses
  // the formal session writer; no password reset or existing session rewrite.
  const db = new Database(join(dataRoot, 'date-companion.sqlite'), { readonly: true, fileMustExist: true });
  let accountId: string;
  try {
    const row = db.prepare('SELECT user_id,body_json FROM dc_preparations WHERE id=?').get(failure.view.id) as { user_id: string; body_json: string } | undefined;
    expect(row).toBeTruthy();
    const stored = JSON.parse(row!.body_json) as PreparationView;
    expect(stored.generationStatus).toBe('failed'); expect(stored.version).toBe(failure.view.version);
    expect(stored.items).toEqual(failure.view.items);
    accountId = row!.user_id;
  } finally { db.close(); }
  const store = new JsonStore(dataRoot);
  const user = await store.read<{ id: string; email: string; name: string }>('users', accountId!);
  expect(user).toMatchObject({ id: accountId!, name: '合成最终连续使用验收' });
  expect(user!.email).toMatch(/^date-real-[0-9a-f-]+@example\.test$/u);
  const restoredSession = await createAuthenticatedSession(accountId!, store);
  await context.addCookies([{ name: SESSION_COOKIE_NAME, value: restoredSession.token, url: baseURL,
    httpOnly: true, sameSite: 'Lax', expires: Date.parse(restoredSession.expiresAt) / 1000 }]);
  const me = await context.request.get(`${baseURL}/api/auth/me`, { maxRedirects: 0 });
  expect(me.status()).toBe(200); expect((await me.json()).user.id).toBe(accountId!);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${baseURL}${preparePath}?preparation=${encodeURIComponent(failure.view.id)}`);
  await expect(page.getByRole('region', { name: '聊天记录', exact: true })).toContainText(finalReviewPrompt);
  await expect(page.getByText('你说的话已保存，这次没有完整回复。可以补充新想法继续聊。', { exact: true })).toBeVisible();
  const before = await getView(page, failure.view.id, 'final-recovery-restored-before');
  expect(before.items).toEqual(failure.view.items); expect(before.reviewLink).toEqual(failure.view.reviewLink);
  expect(before.messages).toEqual(failure.view.messages); expect(before.events).toEqual(failure.view.events);
  await save('final-recovery-auth-proof', { syntheticAccountId: accountId!, preparationId: before.id,
    sessionRestoredVia: 'createAuthenticatedSession', authMeMatched: true,
    preservedVersion: before.version, originalFailureEvidence: 'final-review-result.json',
    priorChoiceIds: before.items.filter(item => item.status === 'selected').map(item => item.id),
    sameDatabase: true, passwordChanged: false, modelRepliesSeeded: false });
  await screenshot(page, 'final-recovery-before');
  await finalReviewAndNext(page, context, accountId!, initial.view, expected.source, 'final-recovery',
    `刚才没有完整回复，请继续。${finalReviewPrompt}`);
});

test('1 correct source attribution in the same discussion @final-attribution', async ({ page, context }) => {
  test.skip(!finalReal || !finalAttribution, 'Requires the explicitly bounded attribution recheck');
  await authorize('final-attribution-start');
  const previous = JSON.parse(await readFile(join(artifacts, 'final-recovery-closed-reopened.json'), 'utf8')) as PreparationView;
  expect(previous.generationStatus).toBe('idle');
  expect(previous.items.filter(item => item.status === 'selected')).toHaveLength(2);
  expect(previous.reviewLink?.available).toBe(true);
  const db = new Database(join(dataRoot, 'date-companion.sqlite'), { readonly: true, fileMustExist: true });
  let accountId: string;
  try {
    const row = db.prepare('SELECT user_id,body_json FROM dc_preparations WHERE id=?').get(previous.id) as { user_id: string; body_json: string } | undefined;
    expect(row).toBeTruthy();
    const stored = JSON.parse(row!.body_json) as PreparationView;
    expect(stored.version).toBe(previous.version); expect(stored.items).toEqual(previous.items);
    expect(stored.generationStatus).toBe('idle'); accountId = row!.user_id;
  } finally { db.close(); }
  const store = new JsonStore(dataRoot);
  const user = await store.read<{ id: string; email: string; name: string }>('users', accountId!);
  expect(user).toMatchObject({ id: accountId!, name: '合成最终连续使用验收' });
  expect(user!.email).toMatch(/^date-real-[0-9a-f-]+@example\.test$/u);
  const session = await createAuthenticatedSession(accountId!, store);
  await context.addCookies([{ name: SESSION_COOKIE_NAME, value: session.token, url: baseURL,
    httpOnly: true, sameSite: 'Lax', expires: Date.parse(session.expiresAt) / 1000 }]);
  const me = await context.request.get(`${baseURL}/api/auth/me`, { maxRedirects: 0 });
  expect(me.status()).toBe(200); expect((await me.json()).user.id).toBe(accountId!);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${baseURL}${preparePath}?preparation=${encodeURIComponent(previous.id)}`);
  await expect(page.getByRole('region', { name: '聊天记录', exact: true })).toBeVisible();
  const before = await getView(page, previous.id, 'final-attribution-before');
  expect(before.items).toEqual(previous.items); expect(before.messages).toEqual(previous.messages);
  expect(before.reviewLink).toEqual(previous.reviewLink);
  const earlierTasks = new Set(ledger(accountId!, before.id).actions.map(action => action.taskId));
  const correction = '刚才说这份记录支持我当时有准备，这里似乎混在一起了。请重新核对原话，分别说明我之前选用的准备和这份录音各自支持什么。只解释，不新增建议。';
  const after = await sendOnce(page, '想聊点什么？', correction, 'final-attribution-turn', before.id);
  const receipt = ledger(accountId!, before.id);
  const newActions = receipt.actions.filter(action => !earlierTasks.has(action.taskId));
  await save('final-attribution-new-task-ledger', { newActions, allCalls: receipt.calls });
  expect(new Set(newActions.map(action => action.taskId)).size).toBe(1);
  const tools = newActions.filter(action => action.status === 'succeeded').map(action => action.tool);
  expect(tools).toContain('read_source'); expect(tools).toContain('respond');
  expect(tools.some(tool => ['list_review_sources', 'search_records'].includes(tool))).toBe(true);
  expect(after.items).toEqual(before.items); expect(after.reviewLink).toEqual(before.reviewLink);
  expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
  expect(after.events.slice(0, before.events.length)).toEqual(before.events);
  expect(after.date).toBeNull();
  const reply = after.messages.at(-1)!;
  expect(reply.sources).toContainEqual(expect.objectContaining({ quote: finalQuote, valid: true,
    interactionId: before.reviewLink!.interactionId, recordingDate: finalRecordDate, origin: 'direct_conversation' }));
  await recordVisibleTurn(page, after, 'final-attribution-visible');
  await save('final-attribution-quality-review', { correction, reply, selectedItems: after.items.filter(item => item.status === 'selected'),
    preservedFeedback: after.messages.filter(message => message.kind === 'feedback'),
    reviewRequired: ['原来准备来自用户选用而非录音', '录音仅支持原话所表达的愿望', '用户反馈保留主观归因', '未记录不推出未发生'] });
  await page.getByRole('article', { name: '助手回复', exact: true }).last().scrollIntoViewIfNeeded();
  await screenshot(page, 'final-attribution-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await composerVisible(page); await screenshot(page, 'final-attribution-mobile');
  await page.reload();
  await expect(page.getByRole('region', { name: '聊天记录', exact: true })).toContainText(correction);
  const restored = await getView(page, after.id, 'final-attribution-reloaded');
  expect(restored.items).toEqual(after.items); expect(restored.messages).toEqual(after.messages);
  expect(restored.reviewLink).toEqual(after.reviewLink);
  const seed = JSON.parse(await readFile(join(artifacts, 'final-continuous-expected.json'), 'utf8')) as { source: { outboxCount: number } };
  assertNoOtherWrites(seed.source.outboxCount);
  console.log('[date-agent-final-real] attribution recheck 1/1 complete');
});
