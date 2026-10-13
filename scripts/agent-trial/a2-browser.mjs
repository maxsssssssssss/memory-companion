// A2 engineering acceptance: controlled offline Provider, actual authenticated
// APIs, SQLite, components and business actions. Never evidence of model quality.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { chromium, expect as baseExpect } from '@playwright/test';
import { chromiumLaunchOptions } from './browser-launch.mjs';
import { studentOption } from './student-policy.mjs';
import { verifyManualLearning, openUnsavedNoteDraft } from './manual-learning-browser.mjs';
const phase = process.argv[2];
assert(['before-restart', 'after-restart', 'faults', 'crash-before', 'crash-after', 'inspect', 'manual'].includes(phase), 'a2_browser_phase_required');
const subcase = process.env.AGENT_TRIAL_SUBCASE;
assert(subcase === undefined || subcase === 'known' && phase === 'faults' || subcase === 'draft' && ['before-restart', 'after-restart'].includes(phase), 'invalid_a2_subcase');
const cases = process.env.AGENT_TRIAL_CASES?.split(',') ?? (phase === 'manual' ? ['M'] : subcase === 'draft' ? ['B'] : subcase === 'known' ? ['F'] : ['A', 'B', 'C', 'D', 'E', 'F']);
assert(cases.length > 0 && cases.every(key => (phase === 'manual' ? ['M'] : ['A', 'B', 'C', 'D', 'E', 'F']).includes(key)), 'invalid_a2_case_filter');
assert(!subcase || cases.every(key => key === (subcase === 'draft' ? 'B' : 'F')), 'subcase_account_filter_conflict');
const bKey = subcase === 'draft' ? 'B-draft' : 'B';
const reportName = `a2-${phase}${subcase === 'draft' ? '-draft' : ''}`;
const root = path.resolve(process.env.AGENT_TRIAL_DIR ?? 'output/agent-a2-offline');
const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid;
const archive = path.join(root, 'runs', runId);
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const save = (name, value) => {
  const text = JSON.stringify(value, null, 2); fs.writeFileSync(path.join(root, name), text);
  if (name === `${reportName}-result.json` || name === `${reportName}-checks.json` || name.startsWith('a3-B-')) fs.writeFileSync(path.join(archive, name), text);
};
const runtime = read('runtime.json'), accounts = read('synthetic-accounts.json');
assert.equal(runtime.evidenceMode, 'offline', 'this_fault_acceptance_runner_is_offline_only');
assert.equal(path.resolve(runtime.dataRoot), path.join(root, 'data'));
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(runtime.base).hostname));
fs.mkdirSync(archive, { recursive: true });
for (const suffix of ['result', 'checks']) {
  const prior = path.join(root, `${reportName}-${suffix}.json`);
  if (fs.existsSync(prior)) fs.copyFileSync(prior, path.join(archive, `prior-${reportName}-${suffix}.json`));
}
const state = fs.existsSync(path.join(root, 'a2-state.json')) ? read('a2-state.json') : { tasks: {} };
const expect = baseExpect.configure({ timeout: 30000 }), checks = [], failures = [];
fs.mkdirSync(path.join(root, 'screenshots'), { recursive: true });
fs.mkdirSync(path.join(archive, 'screenshots'), { recursive: true });
const persist = () => save('a2-state.json', state);
const readDb = (filename, fn) => { const db = new Database(filename, { readonly: true }); try { return fn(db); } finally { db.close(); } };
const calls = () => readDb(path.join(root, 'offline-provider.sqlite'), db => db.prepare('SELECT count(*) n FROM requests').get().n);
const business = (account, fn) => readDb(path.join(runtime.dataRoot, 'users', account.userId, 'learning-organizer.sqlite'), fn);
const pass = (key, message) => { checks.push({ key, message }); save(`${reportName}-checks.json`, checks); console.log(`[A2 ${phase} ${key}] ${message}; simulated requests=${calls()}, real Provider=0`); };
const controlFaults = faults => save('offline-control.json', { version: 1, faults });
const browser = await chromium.launch(chromiumLaunchOptions());
async function session(key, work) {
  if (!cases.includes(key)) return;
  const account = accounts.find(account => account.key === key); assert(account, key === 'M' ? 'seed_manual_account_required_use_seed_manual' : 'seed_a2_six_accounts_required');
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === runtime.base ? route.continue() : route.abort());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const api = async (suffix = '/agent', method = 'GET', data) => page.evaluate(async ({ url, method, data }) => {
    const result = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store', ...(data === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }) });
    return { status: result.status, value: await result.json() };
  }, { url: `/api/learning/pages/${account.pageId}${suffix}`, method, data });
  const tasks = async () => { const response = await api(); assert.equal(response.status, 200); return response.value.tasks; };
  const current = async id => { const task = (await tasks()).find(task => task.id === id); assert(task); return task; };
  const panel = () => page.getByRole('region', { name: '自适应复习·试用', exact: true });
  const open = async id => {
    await page.goto(`${runtime.base}/learning/${account.pageId}?view=agent${id ? '&agent=' + id : ''}`);
    await page.getByRole('navigation', { name: '学习任务' }).getByRole('button', { name: '自适应复习·试用', exact: true }).click();
    await expect(panel()).toBeVisible();
  };
  const snapshot = label => page.screenshot({ path: path.join(root, 'screenshots', `${reportName}-${key}-${label}.png`), fullPage: true });
  const settle = async (id, predicate = task => !['ready', 'running'].includes(task.status)) => {
    const deadline = Date.now() + 120000; let marker;
    while (Date.now() < deadline) {
      const task = await current(id), next = `${task.version}:${task.status}:${task.actions.length}`;
      if (next !== marker) { console.log(`[A2 ${key}] ${id.slice(0, 8)} ${next}`); marker = next; }
      save(`a2-task-${id}.json`, task);
      if (predicate(task)) return task;
      await page.waitForTimeout(250);
    }
    throw Error('a2_task_timeout');
  };
  const scope = { materialIds: [account.materialId], chapterIds: [], nodeIds: [], includeHistory: false, includeNotes: false, includeSupplements: false };
  const start = async (name, goal, ui = false, chosenId = randomUUID()) => {
    if (state.tasks[name]) return current(state.tasks[name]);
    let result;
    if (ui) {
      await open();
      if (await panel().getByRole('button', { name: '开始另一项复习', exact: true }).isVisible()) await panel().getByRole('button', { name: '开始另一项复习', exact: true }).click();
      await panel().getByLabel('复习目标', { exact: true }).fill(goal);
      const response = page.waitForResponse(response => response.url().endsWith(`/${account.pageId}/agent`) && response.request().method() === 'POST');
      await panel().getByRole('button', { name: '明确开始复习', exact: true }).click();
      const received = await response; assert.equal(received.status(), 202); result = await received.json();
    } else { const received = await api('/agent', 'POST', { id: chosenId, goal, scope }); assert.equal(received.status, 202); result = received.value; }
    state.tasks[name] = result.task.id; persist(); return result.task;
  };
  const mutate = async (task, action, fields = {}) => api('/agent', 'PATCH', { id: task.id, action, expectedVersion: task.version, eventId: randomUUID(), ...fields });
  const approval = task => ({ approvalId: task.approval.id, fingerprint: task.approval.fingerprint, expectedVersion: task.version });
  const notes = async () => (await api('/framework')).value.framework.chapters.flatMap(chapter => chapter.nodes.map(node => ({ chapterId: chapter.id, nodeId: node.id, revision: chapter.revision, note: node.note })));
  const quiet = async (id, label) => { const before = calls(); await page.reload(); await current(id); await page.waitForTimeout(1000); assert.equal(calls(), before); pass(key, `${label}: refresh/wait uses zero Provider requests`); };
  const faultClaimed = async id => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const claimed = readDb(path.join(root, 'offline-provider.sqlite'), db => db.prepare('SELECT * FROM offline_fault_claims WHERE id=?').get(id));
      if (claimed) return claimed;
      await page.waitForTimeout(100);
    }
    throw Error('configured_fault_did_not_hit_exact_target');
  };
  try {
    assert.equal((await context.request.post(runtime.base + '/api/auth/login', { data: { email: account.email, password: account.password } })).status(), 200);
    await open();
    await work({ account, page, api, current, panel, open, snapshot, settle, start, mutate, approval, notes, quiet, faultClaimed, scope });
    assert.deepEqual(errors, []);
  } catch (error) {
    failures.push({ key, error: String(error?.message ?? error).split('Call log:')[0].slice(0, 1600) });
    console.error(`[A2 ${key}] FAIL ${failures.at(-1).error}`); await snapshot('failure').catch(() => {});
  } finally { await context.close(); }
}

try {
  if (phase === 'manual') {
    await session('M', h => verifyManualLearning(h, { runtime, root, expect, pass: message => pass('M', message), save, calls, state, persist }));
  } else if (phase === 'before-restart') {
    await session('A', async h => {
      let task = await h.start('A', read('frozen-inputs.json').goals.A, true);
      task = await h.settle(task.id);
      const link = task.quizLinks[0] ?? state.A;
      assert(link?.quizId && link?.attemptId, 'A_quiz_operation_required');
      state.A = { ...(state.A ?? {}), quizId: link.quizId, attemptId: link.attemptId }; persist();
      if (task.wait?.kind === 'quiz_submission') {
      await h.open(task.id); await h.panel().getByRole('button', { name: '打开题组 1', exact: true }).click();
      const answer = h.page.getByRole('article', { name: '当前作答', exact: true });
      const stored = business(h.account, db => JSON.parse(db.prepare('SELECT result_json FROM learning_quiz_runs WHERE id=?').get(link.quizId).result_json));
      let attempt = (await h.api('/quiz?attempt=' + link.attemptId)).value.attempt;
      if (!attempt.completed) {
      await expect(answer).toBeVisible();
      while (await answer.getByRole('button', { name: '上一题', exact: true }).isVisible()) await answer.getByRole('button', { name: '上一题', exact: true }).click();
      for (let i = 0; i < attempt.questions.length; i++) {
        const q = attempt.questions[i], option = studentOption('A', q, stored.questions[i]);
        const radio = answer.locator(`input[value="${option}"]`);
        if (q.progress.optionId) assert.equal(q.progress.optionId, option);
        else { const saved = h.page.waitForResponse(r => r.url().endsWith('/quiz') && r.request().method() === 'PATCH'); await radio.click(); assert.equal((await saved).status(), 200); }
        await expect(radio).toBeChecked(); await expect(answer.getByRole('status')).toContainText('选择已保存');
        if (i < attempt.questions.length - 1) await answer.getByRole('button', { name: '下一题', exact: true }).click();
      }
      await answer.getByRole('button', { name: '交卷并查看结果', exact: true }).click();
      await expect(h.page.getByText('本次答对 0/2 题', { exact: true })).toBeVisible();
      }
      attempt = (await h.api('/quiz?attempt=' + link.attemptId)).value.attempt; assert.equal(attempt.score.correct, 0);
      await h.open(task.id);
      const feedback = h.page.waitForResponse(r => r.url().endsWith('/agent') && r.request().method() === 'PATCH');
      await h.panel().getByRole('button', { name: '已完成作答，继续复习', exact: true }).click(); assert.equal((await feedback).status(), 202);
      task = await h.settle(task.id, t => t.status === 'waiting' && t.explanations.length > 0);
      }
      assert.equal((await h.api('/quiz?attempt=' + link.attemptId)).value.attempt.score.correct, 0);
      assert.equal(task.status, 'waiting'); assert(task.explanations.length > 0);
      if (task.version === 1) {
      const beforeVersion = task.version, beforeCalls = task.usage.calls; await h.open(task.id);
      await h.panel().getByRole('button', { name: '调整本轮复习', exact: true }).click();
      const adjust = h.panel().getByRole('region', { name: '调整本轮复习', exact: true });
      await adjust.getByRole('textbox', { name: '新的复习目标', exact: true }).fill('[A2:adjusted] 只重新解释交集与并集归属条件，暂不扩大范围。');
      await adjust.getByRole('group', { name: '本页材料', exact: true }).getByRole('checkbox').uncheck();
      await adjust.getByRole('group', { name: '本页知识点', exact: true }).getByRole('checkbox', { name: '交集与并集的归属条件', exact: true }).check();
      await adjust.getByRole('button', { name: '预览本轮调整', exact: true }).click(); await expect(adjust.getByRole('region', { name: '调整前后预览' })).toBeVisible(); await h.snapshot('adjust-preview');
      await adjust.getByRole('button', { name: '确认调整本轮复习', exact: true }).click();
      task = await h.settle(task.id, t => t.version === beforeVersion + 1 && t.status === 'waiting');
      assert(task.usage.calls > beforeCalls);
      }
      assert.equal(task.version, 2); assert.deepEqual(task.scope.materialIds, []); assert.deepEqual(task.scope.nodeIds, [h.account.nodeIds[0]]);
      assert.equal((await h.api('/quiz?attempt=' + link.attemptId)).value.attempt.score.correct, 0);
      await h.quiet(task.id, 'A adjusted scope wait'); await h.snapshot('adjusted');
      state.A = { version: task.version, quizId: link.quizId, attemptId: link.attemptId }; persist();
      pass('A', 'actual UI quiz scoring → read-back explanation → preview/confirm narrower goal+scope; same task/versioned budget retained');
    });
    await session('B', async h => {
      const before = state[bKey]?.notes ?? await h.notes();
      let task = await h.start(bKey, '[A2:note] 请解释交集概念，再提出追加个人笔记的建议；等待我批准。', true);
      task = await h.settle(task.id); assert.equal(task.approval?.status, 'pending');
      await h.open(task.id); await expect(h.panel().getByRole('region', { name: '待确认笔记', exact: true })).toBeVisible();
      assert.deepEqual(await h.notes(), before, 'unapproved_proposal_must_not_change_existing_notes');
      state[bKey] = { approval: task.approval, notes: before, process: { childPid: runtime.childPid, startedAt: runtime.startedAt } }; persist();
      await h.quiet(task.id, 'B approval waiting'); await h.snapshot('approval-before-restart');
      pass('B', 'proposed note displayed exact target/content; unapproved note untouched; ready for external process restart');
    });
  } else if (phase === 'after-restart') {
    await session('B', async h => {
      const saved = state[bKey]; assert(saved); assert.notEqual(runtime.childPid, saved.process.childPid); assert.notEqual(runtime.startedAt, saved.process.startedAt);
      let task = await h.current(state.tasks[bKey]); assert.equal(task.approval?.id, saved.approval.id); assert.deepEqual(await h.notes(), saved.notes);
      await h.open(task.id); await h.quiet(task.id, 'B approval persisted across restart');
      await h.open(task.id);
      const draft = await openUnsavedNoteDraft(h, { runtime, root: archive, expect, task, calls });
      try {
      const response = h.page.waitForResponse(r => r.url().endsWith('/agent') && r.request().method() === 'PATCH');
      await h.panel().getByRole('button', { name: '批准追加到个人笔记', exact: true }).click();
      const accepted = await response; assert.equal(accepted.status(), 202); const event = accepted.request().postDataJSON();
      task = await h.settle(task.id, t => t.status === 'ended' && t.actions.some(action => action.tool === 'learning.append_note' && action.status === 'succeeded'));
      const written = await h.notes();
      assert.equal(written.length, saved.notes.length);
      const changed = written.filter(node => node.note !== saved.notes.find(prior => prior.nodeId === node.nodeId)?.note);
      assert.equal(changed.length, 1, 'approval_must_append_to_exactly_one_existing_node');
      const target = changed[0], original = saved.notes.find(node => node.nodeId === target.nodeId); assert(original);
      assert.equal(target.note, [original.note, saved.approval.content].filter(Boolean).join('\n\n'));
      assert.equal(target.revision, original.revision + 1);
      assert.deepEqual(written.map(node => ({ ...node, revision: saved.notes.find(prior => prior.nodeId === node.nodeId)?.revision, note: node.nodeId === target.nodeId ? original.note : node.note })), saved.notes);
      const before = calls(); assert.equal((await h.api('/agent', 'PATCH', event)).status, 202); await h.page.waitForTimeout(300);
      assert.deepEqual(await h.notes(), written); assert.equal(calls(), before); await h.snapshot('approved-once');
      pass('B', 'normal restart kept pending approval; actual UI approve appended once; duplicate event preserved exact note/revision');
      const proof = await draft.verifyAfterApproval(); save(`a3-${bKey}-unsaved-draft.json`, proof);
      pass('B', 'actual second-page unsaved note draft survived Agent approval; stale save returned 409 without overwriting approved note');
      } finally { await draft.close(); }
    });
  } else if (phase === 'faults') {
    await session('C', async h => {
      for (const variant of ['reject', 'version', 'source']) {
        let task = await h.start('C-' + variant, `[A2:note] 合成验证${variant}时旧审批不能写笔记。`); task = await h.settle(task.id); assert.equal(task.approval?.status, 'pending');
        const before = await h.notes(), approve = { id: task.id, action: 'approval', decision: 'approve', eventId: randomUUID(), ...h.approval(task) };
        if (variant === 'reject') { await h.open(task.id); await h.panel().getByRole('button', { name: '拒绝这项笔记提议', exact: true }).click(); await h.settle(task.id, t => t.approval?.id !== approve.approvalId || t.approval?.status !== 'pending'); }
        if (variant === 'version') { assert.equal((await h.mutate(task, 'adjust', { goal: '[A2:adjusted] 仅重读当前知识点。', scope: { ...h.scope, materialIds: [], nodeIds: [h.account.nodeIds[0]] } })).status, 202); await h.settle(task.id, t => t.version > task.version && t.status === 'waiting'); }
        if (variant === 'source') assert.equal((await h.api('/materials/' + h.account.materialId, 'DELETE')).status, 200);
        const rejected = await h.api('/agent', 'PATCH', approve); assert([409, 410].includes(rejected.status), `${variant}_old_approval_was_not_rejected`);
        assert.deepEqual(await h.notes(), before); pass('C', `${variant}: stale approval rejected; existing notes byte-for-byte unchanged`);
      }
    });
    await session('D', async h => {
      for (const variant of ['cancel', 'adjust']) {
        const faultId = randomUUID(); controlFaults([{ id: faultId, point: 'provider', kind: 'explanation_generation_fixture', effect: 'delay', delayMs: 5000 }]);
        let task = await h.start('D-' + variant, '[A2:late] 合成延迟结果发布检查。'); await h.faultClaimed(faultId); task = await h.current(task.id);
        const fields = variant === 'adjust' ? { goal: '[A2:adjusted] 撤销原交集定义范围，仅复习空交集与并集去重计数。', scope: { ...h.scope, materialIds: [], nodeIds: [h.account.nodeIds[1]] } } : {};
        assert.equal((await h.mutate(task, variant, fields)).status, 202);
        await h.page.waitForTimeout(5500); task = await h.settle(task.id);
        if (variant === 'cancel') { assert.equal(task.status, 'cancelled'); assert.equal(task.explanations.length, 0); }
        else {
          assert.equal(task.version, 2); assert.equal(task.scope.materialIds.length, 0); assert.deepEqual(task.scope.nodeIds, [h.account.nodeIds[1]]);
          assert.equal(task.explanations.length, 1); assert(task.explanations.every(item => item.sources.every(source => [6, 7].includes(source.paragraph))));
          assert(task.actions.filter(action => action.version === 1).every(action => !action.resultRef && !action.reason));
        }
        pass('D', `${variant}: response delivered late; old authorization produced no published explanation`);
      }
      controlFaults([]);
    });
    await session('E', async h => {
      const id = randomUUID(), faultId = randomUUID();
      const previousGroups = (await h.api('/quiz')).value.quizzes;
      controlFaults([{ id: faultId, point: 'receipt', effect: 'throw_once', accountId: h.account.userId, taskId: id, version: 1, refKind: 'learning.quiz' }]);
      let task = await h.start('E-receipt', '[A2:quiz_receipt] 保存题组后模拟共享回执丢失。', false, id); await h.faultClaimed(faultId); task = await h.settle(task.id);
      const groups = (await h.api('/quiz')).value.quizzes;
      assert.equal(groups.filter(group => group.status === 'completed' && !previousGroups.some(prior => prior.id === group.id)).length, 1);
      const before = calls(), event = { id: task.id, action: 'recover', mode: 'inspect', expectedVersion: task.version, eventId: randomUUID() };
      const receipts = await Promise.all([h.api('/agent', 'PATCH', event), h.api('/agent', 'PATCH', event)]); assert(receipts.every(r => [202, 409].includes(r.status)));
      task = await h.settle(task.id, t => t.status === 'waiting'); assert.equal(calls(), before); assert.deepEqual((await h.api('/quiz')).value.quizzes.map(group => group.id), groups.map(group => group.id));
      pass('E', 'real Quiz write survived missing shared receipt; concurrent recover read the original operation without new generation');
      const unknownId = randomUUID(); controlFaults([{ id: unknownId, point: 'provider', kind: 'explanation_generation_fixture', effect: 'unknown' }]);
      task = await h.start('E-unknown', '[A2:late] 模拟外部生成结果未知。'); await h.faultClaimed(unknownId); task = await h.settle(task.id);
      assert.equal(task.recovery?.kind, 'unknown'); assert(!task.recovery.allowedControls.includes('retry'));
      const unknownBefore = calls(); await h.mutate(task, 'recover', { mode: 'inspect' }); assert.equal((await h.mutate(task, 'recover', { mode: 'retry' })).status, 409);
      await h.quiet(task.id, 'unknown inspection'); assert.equal(calls(), unknownBefore); controlFaults([]);
      pass('E', 'unknown result offered inspection only; explicit retry rejected with zero resend');
    });
    await session('F', async h => {
      for (const marker of subcase === 'known' ? [] : ['no_progress', 'budget']) {
        let task = await h.start('F-' + marker, `[A2:${marker}] 合成停止条件验收。`); task = await h.settle(task.id); assert.equal(task.status, 'budget_exhausted');
        await h.quiet(task.id, marker); pass('F', `${marker}: stopped with honest budget/no-progress outcome, refresh invoked zero model requests`);
      }
      const fresh = !state.tasks['F-known'];
      const id = fresh ? randomUUID() : undefined;
      if (fresh) { state.FKnownFault = id; persist(); controlFaults([{ id, point: 'provider', kind: 'explanation_generation_fixture', effect: 'known_failure' }]); }
      let task = await h.start('F-known', '[A2:late] 合成明确生成失败。');
      if (fresh) await h.faultClaimed(id);
      task = await h.settle(task.id);
      const failed = task.actions.find(action => action.tool === 'learning.explain' && action.status === 'failed'); assert(failed);
      const operation = business(h.account, db => db.prepare("SELECT id,action_id FROM learning_agent_artifacts WHERE task_id=? AND kind='explanation'").get(task.id));
      assert.equal(operation.action_id, failed.id);
      await h.open(task.id);
      if (task.status === 'waiting') {
        const paused = h.page.waitForResponse(response => response.url().endsWith('/agent') && response.request().method() === 'PATCH');
        await h.panel().getByRole('button', { name: '暂停任务', exact: true }).click(); assert.equal((await paused).status(), 202);
        task = await h.settle(task.id, value => value.status === 'paused'); await h.open(task.id);
      }
      const inspected = h.page.waitForResponse(response => response.url().endsWith('/agent') && response.request().method() === 'PATCH');
      await h.panel().getByRole('button', { name: '核对原操作结果', exact: true }).click(); assert.equal((await inspected).status(), 202);
      task = await h.settle(task.id, value => value.status === 'needs_attention' && value.recovery?.kind === 'known_failed');
      assert.equal(task.recovery?.kind, 'known_failed'); await h.quiet(task.id, 'known failure'); controlFaults([]);
      await h.open(task.id); const previousCalls = calls();
      const retried = h.page.waitForResponse(response => response.url().endsWith('/agent') && response.request().method() === 'PATCH');
      await h.panel().getByRole('button', { name: '重试明确失败的操作', exact: true }).click(); assert.equal((await retried).status(), 202);
      task = await h.settle(task.id, value => value.status === 'waiting' && value.explanations.length === 1); assert(calls() > previousCalls);
      assert.equal(task.explanations[0].id, operation.id); assert(task.actions.some(action => action.id === failed.id && action.status === 'succeeded'));
      await h.quiet(task.id, 'explicit known-failure retry completed');
      pass('F', 'known_failed waits make zero calls; explicit retry reused its operation and saved a real explanation before waiting');
    });
  } else if (phase === 'crash-before') {
    await session('E', async h => {
      assert(!state.tasks['E-crash'], 'crash_case_already_started_inspect_or_run_crash_after');
      const id = randomUUID(), faultId = randomUUID();
      const previousGroups = (await h.api('/quiz')).value.quizzes.map(group => group.id);
      controlFaults([{ id: faultId, point: 'receipt', effect: 'exit_once', accountId: h.account.userId, taskId: id, version: 1, refKind: 'learning.quiz' }]);
      const task = await h.start('E-crash', '[A2:quiz_receipt] 在真实题组写入后、共享回执之前终止应用进程。', false, id);
      await h.faultClaimed(faultId);
      const deadline = Date.now() + 30000;
      while (!fs.existsSync(path.join(root, 'offline-fault-exit.json')) && Date.now() < deadline) await h.page.waitForTimeout(100);
      const exit = read('offline-fault-exit.json'); assert.equal(exit.faultId, faultId); assert.equal(exit.taskId, task.id); assert.equal(exit.exitCode, 86);
      let alive = true;
      while (alive && Date.now() < deadline) { try { process.kill(exit.pid, 0); } catch { alive = false; } if (alive) await h.page.waitForTimeout(100); }
      assert.equal(alive, false, 'injected_application_process_did_not_exit');
      const receipt = business(h.account, db => db.prepare("SELECT id,state,body_json FROM learning_agent_artifacts WHERE task_id=? AND kind='quiz'").get(task.id));
      assert.equal(receipt.state, 'completed'); assert.equal(receipt.id, exit.ref.id);
      state.crash = { taskId: task.id, faultId, exitedPid: exit.pid, quizId: receipt.id, previousGroups, calls: calls() }; persist();
      pass('E', 'actual application process exited after business Quiz commit and before Agent receipt; no task state/lease was edited');
    });
  } else if (phase === 'crash-after') {
    await session('E', async h => {
      assert(state.crash, 'run_crash_before_and_restart_first');
      let task = await h.current(state.crash.taskId);
      assert.equal(calls(), state.crash.calls, 'restart_must_not_automatically_regenerate');
      if (task.status === 'running') {
        assert.equal((await h.mutate(task, 'pause')).status, 202);
        task = await h.current(task.id); assert.equal(task.status, 'paused');
      }
      const event = { id: task.id, action: 'recover', mode: 'inspect', expectedVersion: task.version, eventId: randomUUID() };
      const recovered = await Promise.all([h.api('/agent', 'PATCH', event), h.api('/agent', 'PATCH', event)]);
      assert(recovered.every(response => [202, 409].includes(response.status)));
      task = await h.settle(task.id, value => value.status === 'waiting' && value.wait?.kind === 'quiz_submission');
      assert.deepEqual(task.quizLinks.map(link => link.quizId), [state.crash.quizId]); assert.equal(calls(), state.crash.calls);
      assert.deepEqual(new Set((await h.api('/quiz')).value.quizzes.map(group => group.id)), new Set([...state.crash.previousGroups, state.crash.quizId]));
      await h.open(task.id); await h.quiet(task.id, 'crashed operation recovered'); await h.snapshot('crash-recovered'); controlFaults([]);
      pass('E', 'restart → authenticated pause revoked old lease → concurrent inspect reused the original Quiz ID with zero resend');
    });
  } else for (const key of ['A', 'B', 'C', 'D', 'E', 'F']) await session(key, async h => { save(`a2-inspect-${key}.json`, (await h.api()).value); await h.snapshot('inspect'); });
} finally {
  await browser.close(); process.exitCode = failures.length ? 1 : 0;
  save(`${reportName}-result.json`, { runId, phase, subcase, status: process.exitCode ? 'FAIL' : 'PASS', evidence: 'offline_fixed_provider_real_business_sqlite_api_browser', cases, checks, failures, simulatedRequests: calls(), actualProviderNetworkRequests: 0, exitCode: process.exitCode });
}
