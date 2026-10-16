// Offline V1.1 acceptance. Only the model response is controlled; tasks, Quiz,
// choices, submission, feedback and completion use the real authenticated app.
// The simulated student uses the synthetic key locally, never in model input.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium, expect as baseExpect } from '@playwright/test';
import { chromiumLaunchOptions } from './browser-launch.mjs';
import { studentOption } from './student-policy.mjs';

const phase = process.argv[2];
assert(['before-restart', 'after-restart', 'inspect'].includes(phase), 'completion_browser_phase_required');
const root = path.resolve(process.env.AGENT_TRIAL_DIR ?? 'output/learning-completion-v1-1-trial');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const runtime = read('runtime.json'), accounts = read('synthetic-accounts.json');
assert.equal(runtime.evidenceMode, 'offline', 'completion_browser_offline_only');
assert.equal(path.resolve(runtime.dataRoot), path.join(root, 'data'), 'completion_browser_isolated_data_required');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(runtime.base).hostname), 'completion_browser_loopback_only');
const archive = path.join(root, 'completion-runs', new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid);
fs.mkdirSync(path.join(archive, 'screenshots'), { recursive: true });
const save = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2));
const state = fs.existsSync(path.join(root, 'completion-state.json')) ? read('completion-state.json') : { tasks: {} };
const persist = () => save('completion-state.json', state);
const readonly = (filename, callback) => { const db = new Database(filename, { readonly: true }); try { return callback(db); } finally { db.close(); } };
const ledger = () => readonly(path.join(root, 'offline-provider.sqlite'), db => db.prepare('SELECT count(*) requests,coalesce(sum(actual_network_requests),0) network FROM requests').get());
const checks = [], failures = [], expect = baseExpect.configure({ timeout: 30000 });
const pass = (key, message, evidence = {}) => {
  checks.push({ key, message, ...evidence }); save(`completion-${phase}-checks.json`, checks);
  console.log(`[V1.1 ${phase} ${key}] ${checks.length} checks: ${message}; offline responses=${ledger().requests}, real Provider=${ledger().network}`);
};
const browser = await chromium.launch(chromiumLaunchOptions());

async function session(key, work) {
  const account = accounts.find(value => value.key === key); assert(account, 'seed_synthetic_accounts_first');
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, serviceWorkers: 'block' });
  const external = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === runtime.base) return route.continue();
    external.push(new URL(route.request().url()).origin); return route.abort();
  });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const login = async () => assert.equal((await context.request.post(runtime.base + '/api/auth/login', { data: { email: account.email, password: account.password } })).status(), 200);
  const api = async suffix => page.evaluate(async url => {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    return { status: response.status, value: await response.json() };
  }, `/api/learning/pages/${account.pageId}${suffix}`);
  const current = async id => {
    const response = await api('/agent'); assert.equal(response.status, 200);
    const task = response.value.tasks.find(value => value.id === id); assert(task, 'saved_task_required');
    save(`completion-task-${id}.json`, task); return task;
  };
  const panel = () => page.getByRole('region', { name: '复习向导', exact: true });
  const open = async id => {
    await page.goto(`${runtime.base}/learning/${account.pageId}?view=agent${id ? '&agent=' + id : ''}`);
    await page.getByRole('navigation', { name: '学习任务' }).getByRole('button', { name: '复习向导', exact: true }).click();
    await expect(panel()).toBeVisible();
  };
  const snapshot = label => page.screenshot({ path: path.join(archive, 'screenshots', `${key}-${label}.png`), fullPage: true });
  const settle = async (id, predicate = task => !['ready', 'running'].includes(task.status)) => {
    const deadline = Date.now() + 120000; let last;
    while (Date.now() < deadline) {
      const task = await current(id), progress = `${task.status}:${task.actions.length}:${task.completion?.outcome}`;
      if (last !== progress) { console.log(`[V1.1 ${key}] ${id.slice(0, 8)} ${progress}`); last = progress; }
      if (predicate(task)) return task;
      if (['needs_attention', 'cancelled'].includes(task.status)) throw Error(`completion_task_interrupted_${task.status}_${task.recovery?.kind}`);
      await page.waitForTimeout(250);
    }
    throw Error('completion_browser_task_timeout');
  };
  const start = async goal => {
    if (state.tasks[key]) return current(state.tasks[key]);
    await open();
    if (await panel().getByRole('button', { name: '开始另一项复习', exact: true }).isVisible()) await panel().getByRole('button', { name: '开始另一项复习', exact: true }).click();
    await panel().getByLabel('复习目标', { exact: true }).fill(goal);
    const response = page.waitForResponse(value => value.url().endsWith(`/${account.pageId}/agent`) && value.request().method() === 'POST');
    await panel().getByRole('button', { name: '明确开始复习', exact: true }).click();
    const created = await response; assert.equal(created.status(), 202);
    const task = (await created.json()).task; state.tasks[key] = task.id; persist(); return task;
  };
  const quiet = async (id, label) => {
    const before = ledger(); await page.reload(); await current(id); await page.waitForTimeout(700);
    assert.deepEqual(ledger(), before, 'waiting_reload_must_not_call_provider');
    assert.equal((await context.request.post(runtime.base + '/api/auth/logout')).status(), 200);
    await context.clearCookies(); await login(); await open(id); await current(id); await page.waitForTimeout(700);
    assert.deepEqual(ledger(), before, 'waiting_relogin_must_not_call_provider');
    pass(key, `${label}: refresh and logout/login made zero additional model requests`, { requests: before.requests });
  };
  try {
    await login(); await open(state.tasks[key]);
    await work({ account, page, api, current, panel, open, snapshot, settle, start, quiet });
    assert.deepEqual(errors, [], 'browser_console_errors'); assert.deepEqual(external, [], 'browser_external_requests');
  } catch (error) {
    const failure = { key, error: String(error?.message ?? error).split('Call log:')[0].slice(0, 1600) };
    failures.push(failure); console.error(`[V1.1 ${key}] FAIL ${failure.error}`); await snapshot('failure').catch(() => {});
  } finally { await context.close(); }
}

try {
  if (phase === 'before-restart') {
    await session('A', async h => {
      let task = await h.start('[V1.1:explanation] 我不理解交集为什么要求同时属于两个集合，请只解释这个疑问，不强制考试。');
      task = await h.settle(task.id);
      assert.equal(task.status, 'waiting'); assert.equal(task.wait.kind, 'feedback');
      assert.equal(task.completion.plan.kind, 'explanation'); assert.equal(task.completion.support, 'insufficient');
      assert.equal(task.quizLinks.length, 0); assert.equal(task.explanations.length, 1);
      await h.open(task.id); await expect(h.panel().getByRole('button', { name: '疑问已解决', exact: true })).toBeVisible();
      await expect(h.panel().getByRole('region', { name: '本轮目标与依据', exact: true })).toBeVisible();
      await h.quiet(task.id, 'explanation awaiting explicit resolution'); await h.snapshot('explanation-waiting');
      state.A = { version: task.version, explanationId: task.explanations[0].id }; persist();
      pass('A', 'UI start → source-bound plan → actual saved explanation → explicit-feedback wait; no Quiz', { taskId: task.id });
    });
    await session('B', async h => {
      let task = await h.start('[V1.1:check] 本轮只检查交集与并集的两个归属条件，各取得一次本轮应用内未使用提示的作答即可，不代表整章或长期掌握。');
      task = await h.settle(task.id);
      assert.equal(task.status, 'waiting'); assert.equal(task.wait.kind, 'quiz_submission');
      assert.equal(task.completion.plan.kind, 'chapter_check'); assert.equal(task.quizLinks.length, 1);
      assert.equal(task.completion.objectives.length, 2);
      assert(task.completion.objectives.every(objective => objective.status === 'unobserved'));
      assert(!JSON.stringify(task).includes('correctOptionId'), 'task_api_must_not_leak_answer_key');
      const link = task.quizLinks[0], response = await h.api('/quiz?attempt=' + link.attemptId);
      assert.equal(response.status, 200); assert.equal(response.value.attempt.completed, false);
      assert(response.value.attempt.questions.every(question => !question.feedback), 'unsubmitted_attempt_must_not_reveal_explanations');
      await h.open(task.id); await expect(h.page.getByRole('article', { name: '当前作答', exact: true })).toBeVisible();
      await h.quiet(task.id, 'saved Quiz awaiting real UI submission'); await h.snapshot('quiz-waiting');
      state.B = { version: task.version, quizId: link.quizId, attemptId: link.attemptId }; persist();
      pass('B', 'UI start → two visible objectives → actual published Quiz → persistent wait; task/API protected answers', { taskId: task.id, quizId: link.quizId });
    });
    state.processBeforeRestart = { childPid: runtime.childPid, startedAt: runtime.startedAt, requests: ledger().requests }; persist();
  } else if (phase === 'after-restart') {
    assert(state.processBeforeRestart, 'run_before_restart_first');
    assert.notEqual(runtime.childPid, state.processBeforeRestart.childPid, 'restart_must_have_a_new_owned_child');
    assert.notEqual(runtime.startedAt, state.processBeforeRestart.startedAt, 'restart_timestamp_must_change');
    assert.equal(ledger().requests, state.processBeforeRestart.requests, 'server_restart_must_not_call_model_while_waiting');
    await session('A', async h => {
      let task = await h.current(state.tasks.A); assert(['waiting', 'ended'].includes(task.status)); assert.equal(task.version, state.A.version);
      const reusedCompleted = task.status === 'ended';
      assert.equal(task.explanations[0].id, state.A.explanationId);
      await h.quiet(task.id, `restart retained same explanation and ${reusedCompleted ? 'already completed' : 'waiting'} task`);
      const before = ledger();
      if (!reusedCompleted) {
        const response = h.page.waitForResponse(value => value.url().endsWith('/agent') && value.request().method() === 'PATCH');
        await h.panel().getByRole('button', { name: '疑问已解决', exact: true }).click();
        assert.equal((await response).status(), 202);
      }
      task = await h.settle(task.id, value => value.status === 'ended');
      assert.equal(task.completion.outcome, 'explanation_resolved'); assert.equal(task.completion.longTermMastery, 'unverified');
      assert.equal(task.quizLinks.length, 0); assert.deepEqual(ledger(), before, 'resolved_explanation_must_end_without_model_call');
      await h.open(task.id); await expect(h.panel().getByRole('region', { name: '本轮判断', exact: true })).toContainText('长期掌握');
      await h.snapshot('resolved'); await h.quiet(task.id, 'ended explanation remains read-only');
      pass('A', reusedCompleted ? 'read-only recheck retained the previously submitted explicit resolution and zero-call/no-Quiz completion'
        : 'after normal restart, explicit UI resolution ended automatically with zero model calls and no Quiz', { outcome: task.completion.outcome, reusedCompleted });
    });
    await session('B', async h => {
      let task = await h.current(state.tasks.B); assert(['waiting', 'ended'].includes(task.status)); assert.equal(task.version, state.B.version);
      const reusedCompleted = task.status === 'ended';
      assert.equal(task.quizLinks[0].quizId, state.B.quizId);
      await h.quiet(task.id, 'restart retained same Quiz and attempt');
      const before = ledger(), saved = readonly(path.join(runtime.dataRoot, 'users', h.account.userId, 'learning-organizer.sqlite'), db =>
        JSON.parse(db.prepare('SELECT result_json FROM learning_quiz_runs WHERE id=?').get(state.B.quizId).result_json));
      const attempt = (await h.api('/quiz?attempt=' + state.B.attemptId)).value.attempt;
      assert.equal(attempt.completed, reusedCompleted);
      if (!reusedCompleted) {
        const article = h.page.getByRole('article', { name: '当前作答', exact: true }); await expect(article).toBeVisible();
        for (let index = 0; index < attempt.questions.length; index++) {
          const question = attempt.questions[index], option = studentOption('B', question, saved.questions[index]);
          const response = h.page.waitForResponse(value => value.url().endsWith('/quiz') && value.request().method() === 'PATCH');
          const radio = article.locator(`input[value="${option}"]`); await radio.click(); assert.equal((await response).status(), 200);
          await expect(radio).toBeChecked(); await expect(article.getByRole('status')).toContainText('选择已保存');
          if (index < attempt.questions.length - 1) await article.getByRole('button', { name: '下一题', exact: true }).click();
        }
        await article.getByRole('button', { name: '交卷并查看结果', exact: true }).click();
      }
      await expect(h.page.getByText('本次答对 2/2 题', { exact: true })).toBeVisible();
      task = await h.settle(task.id, value => value.status === 'ended');
      const storedAttempt = (await h.api('/quiz?attempt=' + state.B.attemptId)).value.attempt;
      assert.equal(storedAttempt.score.correct, 2); assert.equal(storedAttempt.completed, true);
      assert.equal(task.completion.outcome, 'check_passed'); assert.equal(task.completion.longTermMastery, 'unverified');
      assert.equal(task.quizLinks.length, 1, 'sufficient_evidence_must_not_create_another_quiz');
      assert(task.completion.objectives.every(objective => objective.status === 'supported' && objective.evidence.some(evidence => evidence.ref.attemptId === storedAttempt.id && evidence.submitted && evidence.independentInApp)));
      assert(task.completion.objectives.every(objective => objective.evidence.every(evidence => evidence.semanticProvenance === 'model_proposal')));
      // These frozen candidates already carry per-question semantic proposals.
      // The program now rereads the actual saved answers and source bindings;
      // requiring another model decision here would contradict prompt stopping.
      assert.equal(ledger().requests - before.requests, 0, 'sufficient_published_mappings_and_saved_answers_must_stop_without_decision_call');
      await h.open(task.id); await expect(h.panel().getByRole('region', { name: '本轮判断', exact: true })).toContainText('本轮约定目标检查通过');
      await h.snapshot('check-completed'); await h.quiet(task.id, 'completed check remains read-only');
      pass('B', reusedCompleted ? 'read-only recheck retained previously UI-submitted answers and the same evidence-based completion; no duplicate Quiz, submission or model call'
        : 'simulated student used actual UI choose/finish → persisted score → program reread actual answer facts against per-question proposals → zero-call stop, no extra Quiz',
        { outcome: task.completion.outcome, quizId: state.B.quizId, questionCount: storedAttempt.questions.length, reusedCompleted });
    });
  } else {
    for (const key of ['A', 'B']) await session(key, async h => {
      const task = await h.current(state.tasks[key]); await h.quiet(task.id, 'inspection'); await h.snapshot('inspection');
      pass(key, 'existing task inspected through current authenticated API without altering results', { status: task.status, outcome: task.completion?.outcome });
    });
  }
} finally {
  await browser.close();
  const result = { status: failures.length ? 'FAIL' : 'PASS', phase, evidence: 'controlled_offline_provider_and_simulated_student', checks: checks.length, failures,
    modelQualityValidated: false, longTermMasteryValidated: false, provider: ledger(), archive, tasks: state.tasks };
  save(`completion-${phase}-result.json`, result);
  fs.writeFileSync(path.join(archive, 'result.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(archive, 'checks.json'), JSON.stringify(checks, null, 2));
  assert.equal(result.provider.network, 0, 'real_provider_requests_forbidden');
  if (failures.length) process.exitCode = 1;
  console.log(JSON.stringify(result, null, 2));
}
