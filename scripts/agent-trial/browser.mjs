/** Actual application acceptance: application APIs and business storage are never mocked.
 * Default offline mode uses explicitly labelled decision/generation fixtures at
 * the Provider transport; authorized Windows real mode uses the real model.
 * Run before-restart, stop/start the application externally, then after-restart.
 * Only the simulated student's selections use a private, read-only answer key. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium, expect as baseExpect } from '@playwright/test';
import { studentOption } from './student-policy.mjs';
import { chromiumLaunchOptions } from './browser-launch.mjs';

const phase = process.argv[2];
assert(['before-restart', 'after-restart', 'inspect'].includes(phase), 'phase_required: before-restart | after-restart | inspect');
const root = path.resolve(process.env.AGENT_TRIAL_DIR ?? 'output/agent-a0-a1-offline');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const save = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2));
const runtime = read('runtime.json'), accounts = read('synthetic-accounts.json'), frozen = read('frozen-inputs.json');
assert(['offline', 'real'].includes(runtime.evidenceMode), 'explicit_launcher_evidence_mode_required');
const offline = runtime.evidenceMode === 'offline';
const decisionLabel = offline ? 'offline fixed decision fixture' : 'real decision model';
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(runtime.base).hostname), 'loopback_only');
assert.equal(path.resolve(runtime.dataRoot), path.join(root, 'data'), 'isolated_data_required');
fs.mkdirSync(path.join(root, 'screenshots'), { recursive: true });
const state = fs.existsSync(path.join(root, 'browser-state.json')) ? read('browser-state.json') : { version: 1, accounts: {} };
const expect = baseExpect.configure({ timeout: 60000 });
const checks = [], failures = [], errors = [], denied = [];
const record = (key, message) => { checks.push({ key, message, at: new Date().toISOString() }); save(`browser-${phase}-checks.json`, checks); console.log(`[${phase} ${key}] ${message}; ${offline ? 'simulated' : 'real'} Provider requests=${requestCount()}`); };
const safeError = error => String(error?.message ?? error).split('Call log:')[0].replace(/daily_brief_session=[^\s"\\]+/g, 'daily_brief_session=[REDACTED]').slice(0, 1200);
const persist = () => save('browser-state.json', state);
function requestCount() {
  const filename = path.join(root, offline ? 'offline-provider.sqlite' : 'network-ledger.sqlite');
  if (!fs.existsSync(filename)) return 0;
  const db = new Database(filename, { readonly: true });
  try { return db.prepare('SELECT count(*) n FROM requests').get().n; } finally { db.close(); }
}
function savedQuiz(account, quizId) {
  assert(account.userId && !account.userId.includes('/') && !account.userId.includes('..'), 'unsafe_fixture_user');
  const db = new Database(path.join(runtime.dataRoot, 'users', account.userId, 'learning-organizer.sqlite'), { readonly: true });
  try {
    const row = db.prepare('SELECT result_json FROM learning_quiz_runs WHERE id=? AND page_id=? AND status=\'completed\'').get(quizId, account.pageId);
    assert(row?.result_json, 'quiz_not_saved');
    const value = JSON.parse(row.result_json), sha256 = createHash('sha256').update(row.result_json).digest('hex');
    // Kept separate from task/model input. This is for the simulated student and
    // human review of the generated questions, never proof of question quality.
    const filename = `private-generated-quiz-${account.key}-${quizId}.json`;
    if (fs.existsSync(path.join(root, filename))) assert.equal(read(filename).sha256, sha256, 'frozen_quiz_changed');
    else save(filename, { evidence: offline ? 'offline_hand_authored_generation_fixture_saved_by_real_business_service' : 'real_generated_quiz_for_separate_content_review', sha256, value });
    return { value, sha256 };
  } finally { db.close(); }
}

const browser = await chromium.launch(chromiumLaunchOptions());
try {
  for (const account of accounts) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, serviceWorkers: 'block' });
    // Egress firewall only. Allowed application requests run unmodified.
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== runtime.base || (url.pathname.startsWith('/api/') && !/^\/api\/(auth|learning)\//.test(url.pathname))) {
        denied.push(url.origin + url.pathname); return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push({ key: account.key, error: safeError(error) }));
    const snapshot = name => page.screenshot({ path: path.join(root, 'screenshots', `${phase}-${account.key}-${name}.png`), fullPage: true });
    const api = async (suffix = '/agent', method = 'GET', data, foreignPageId) => page.evaluate(async ({ url, method, data }) => {
      const response = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store', ...(data === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }) });
      return { status: response.status, value: await response.json() };
    }, { url: `/api/learning/pages/${foreignPageId ?? account.pageId}${suffix}`, method, data });
    const tasks = async () => { const response = await api(); assert.equal(response.status, 200); return response.value.tasks; };
    const current = async () => {
      const task = (await tasks()).find(item => item.id === state.accounts[account.key]?.taskId);
      assert(task, 'persisted_task_missing'); return task;
    };
    const panel = () => page.getByRole('region', { name: '复习向导', exact: true });
    const openAgent = async () => { await page.getByRole('navigation', { name: '学习任务' }).getByRole('button', { name: '复习向导', exact: true }).click(); await expect(panel()).toBeVisible(); };
    const refresh = async () => { await panel().getByRole('button', { name: '刷新任务', exact: true }).click(); };
    async function settle(label, afterActions = -1, skipStatuses = []) {
      const deadline = Date.now() + 12 * 60_000; let previous;
      while (Date.now() < deadline) {
        const task = await current();
        const marker = `${task.status}:${task.actions.length}:${task.currentAction ?? ''}`;
        if (marker !== previous) { console.log(`[${phase} ${account.key}] ${label}: ${marker}; requests=${requestCount()}`); previous = marker; }
        save(`trajectory-${account.key}-latest.json`, task);
        if (!['ready', 'running', ...skipStatuses].includes(task.status) && !(task.status === 'waiting' && task.actions.length <= afterActions)) { await refresh(); return task; }
        await page.waitForTimeout(1500);
      }
      throw Error('task_settle_timeout_no_automatic_retry');
    }
    async function waitIsQuiet(task, label) {
      assert.equal(task.status, 'waiting', label);
      const before = requestCount();
      await page.reload(); await openAgent(); await refresh();
      await page.waitForTimeout(2500);
      const reread = await current(); assert.equal(reread.status, 'waiting');
      assert.equal(reread.actions.length, task.actions.length); assert.equal(requestCount(), before, 'waiting_made_model_request');
      record(account.key, `${label}: refresh and read-back preserved waiting; zero Provider requests`);
    }
    try {
      const login = await context.request.post(runtime.base + '/api/auth/login', { data: { email: account.email, password: account.password } });
      assert.equal(login.status(), 200, 'fixture_login_failed');
      await page.goto(`${runtime.base}/learning/${account.pageId}`); await openAgent();
      const peer = accounts.find(item => item.key !== account.key);
      assert.equal((await api('/agent', 'GET', undefined, peer.pageId)).status, 404, 'foreign_page_task_visible');
      record(account.key, 'authenticated browser opened synthetic course; other account task read denied');

      if (phase === 'before-restart') {
        const prior = await tasks();
        if (!state.accounts[account.key]?.taskId) {
          // A retry may reconcile an already-created task, never starts a second
          // task to manufacture a desired decision trajectory.
          const existing = prior.find(task => task.goal === frozen.goals[account.key]);
          if (existing) state.accounts[account.key] = { taskId: existing.id };
          else {
            if (prior.length) await panel().getByRole('button', { name: '开始另一项复习', exact: true }).click();
            await expect(panel().getByLabel('复习目标', { exact: true })).toBeVisible();
            await panel().getByLabel('复习目标', { exact: true }).fill(frozen.goals[account.key]);
            for (const label of ['允许读取本范围的相关作答历史', '纳入本范围的个人笔记', '允许本范围的材料外补充解释']) await expect(panel().getByLabel(label, { exact: true })).not.toBeChecked();
            await snapshot('confirmed-scope');
            const response = page.waitForResponse(response => response.url().endsWith(`/pages/${account.pageId}/agent`) && response.request().method() === 'POST');
            await panel().getByRole('button', { name: '明确开始复习', exact: true }).click();
            const created = await response; assert.equal(created.status(), 202);
            const payload = await created.json(); state.accounts[account.key] = { taskId: payload.task.id };
          }
          persist();
        }
        let task = await settle('initial-model-actions');
        const initial = task; save(`trajectory-${account.key}-initial.json`, task);
        if (account.key === 'B' && task.status === 'waiting' && task.wait?.kind === 'feedback' && !task.quizLinks?.length) {
          assert(task.explanations?.length, 'B_did_not_explain_before_feedback');
          await expect(panel().locator('summary').filter({ hasText: '任务内解释 1' })).toBeVisible();
          await snapshot('explanation-before-quiz');
          await waitIsQuiet(task, 'explanation feedback wait');
          await panel().getByLabel('你的反馈', { exact: true }).fill(frozen.feedbackAfterExplanation);
          await panel().getByRole('button', { name: '提交反馈并继续', exact: true }).click();
          task = await settle('after-explanation-feedback', task.actions.length);
        }
        assert.equal(task.status, 'waiting', `expected_quiz_wait_got_${task.status}`);
        assert(task.quizLinks?.length, 'model_did_not_create_real_quiz');
        assert(['quiz', 'quiz_attempt', 'attempt', 'quiz_submission'].includes(task.wait?.kind), 'expected_quiz_submission_wait');
        const tools = task.actions.map(action => action.tool), quizIndex = tools.indexOf('learning.create_quiz');
        assert(quizIndex >= 0, 'missing_real_quiz_action');
        if (account.key === 'B') assert(tools.indexOf('learning.explain') >= 0 && tools.indexOf('learning.explain') < quizIndex, 'B_not_explanation_first');
        if (account.key === 'A') assert(!tools.includes('learning.explain') || quizIndex < tools.indexOf('learning.explain'), 'A_not_diagnostic_first');
        const link = task.quizLinks.at(-1), privateQuiz = savedQuiz(account, link.quizId);
        Object.assign(state.accounts[account.key], { quizId: link.quizId, attemptId: link.attemptId, quizSha256: privateQuiz.sha256, beforeActions: task.actions.length, initialTools: initial.actions.map(action => action.tool), applicationBeforeRestart: { childPid: runtime.childPid, startedAt: runtime.startedAt } }); persist();
        const attempt = (await api('/quiz?attempt=' + link.attemptId)).value.attempt;
        assert.equal(attempt.completed, false); assert.equal(attempt.score, null);
        assert(attempt.questions.every(question => !question.feedback), 'answers_leaked_before_submission');
        await waitIsQuiet(task, 'quiz submission wait');
        const calls = requestCount();
        await panel().getByRole('button', { name: '暂停任务', exact: true }).click();
        await expect(panel().getByRole('button', { name: '继续任务', exact: true })).toBeVisible();
        assert.equal((await current()).status, 'paused'); await snapshot('paused');
        await panel().getByRole('button', { name: '继续任务', exact: true }).click();
        const resumed = await settle('resume-without-new-answer', -1, ['paused']);
        assert.equal(resumed.status, 'waiting'); assert.equal(requestCount(), calls, 'resume_wait_called_model');
        save(`trajectory-${account.key}-before-restart.json`, resumed); await snapshot('waiting-before-restart');
        record(account.key, `${decisionLabel} produced a saved business quiz; pause/resume kept waiting without requests; ready for external stop/restart`);
      } else if (phase === 'after-restart') {
        const saved = state.accounts[account.key]; assert(saved?.quizId && saved?.taskId, 'run_before_restart_first');
        assert(saved.applicationBeforeRestart?.startedAt && runtime.startedAt, 'launcher_restart_evidence_missing');
        assert.notEqual(runtime.startedAt, saved.applicationBeforeRestart.startedAt, 'application_was_not_restarted');
        assert.notEqual(runtime.childPid, saved.applicationBeforeRestart.childPid, 'application_process_did_not_change');
        let task = await current(); assert.equal(task.status, 'waiting'); assert.equal(task.actions.length, saved.beforeActions);
        await waitIsQuiet(task, 'application restarted with persisted task');
        const beforeLogin = requestCount();
        assert.equal((await page.evaluate(async () => (await fetch('/api/auth/logout', { method: 'POST' })).status)), 200);
        assert.equal((await api()).status, 401, 'logout_did_not_revoke');
        const relogin = await context.request.post(runtime.base + '/api/auth/login', { data: { email: account.email, password: account.password } });
        assert.equal(relogin.status(), 200); await page.reload(); await openAgent();
        assert.equal((await current()).id, saved.taskId); assert.equal(requestCount(), beforeLogin);
        record(account.key, 'browser logout denied task API; relogin reopened persisted task with zero model calls');
        await panel().getByRole('button', { name: `打开题组 ${task.quizLinks.findIndex(link => link.quizId === saved.quizId) + 1}`, exact: true }).click();
        const quiz = page.getByRole('region', { name: '单选 Quiz', exact: true });
        const answer = quiz.getByRole('article', { name: '当前作答', exact: true });
        if (await quiz.getByRole('button', { name: '开始作答', exact: true }).isVisible()) await quiz.getByRole('button', { name: '开始作答', exact: true }).click();
        await expect(answer).toBeVisible();
        const privateQuiz = savedQuiz(account, saved.quizId); assert.equal(privateQuiz.sha256, saved.quizSha256);
        let attempt = (await api('/quiz?attempt=' + saved.attemptId)).value.attempt;
        assert.equal(attempt.completed, false, 'attempt_already_completed_do_not_rewrite');
        while (await answer.getByRole('button', { name: '上一题', exact: true }).isVisible())
          await answer.getByRole('button', { name: '上一题', exact: true }).click();
        for (let index = 0; index < attempt.questions.length; index++) {
          const question = attempt.questions[index], optionId = studentOption(account.key, question, privateQuiz.value.questions[index]);
          await expect(answer.getByText(new RegExp(`第 ${index + 1}/${attempt.questions.length} 题`))).toBeVisible();
          const radio = answer.locator(`input[type="radio"][value="${optionId}"]`);
          if (question.progress.optionId !== null) {
            assert.equal(question.progress.optionId, optionId, 'saved_choice_conflicts_with_frozen_student_policy');
          } else {
            const response = page.waitForResponse(response => {
              if (!response.url().endsWith(`/pages/${account.pageId}/quiz`) || response.request().method() !== 'PATCH') return false;
              const body = response.request().postDataJSON();
              return body?.kind === 'act' && body.value?.attemptId === attempt.id && body.value.action === 'choose' && body.value.question === index;
            });
            // The controlled radio updates only after the server saves choose.
            // Playwright.check() requires an immediate DOM toggle and races that
            // contract. Click normally, await the real receipt, then assert it.
            await radio.click();
            assert.equal((await response).status(), 200);
          }
          await expect(radio).toBeChecked();
          await expect(answer.getByRole('status')).toContainText('选择已保存');
          if (attempt.mode === 'practice') {
            await answer.getByRole('button', { name: '确认答案', exact: true }).click();
            await expect(answer.getByRole('status')).toContainText('已确认');
          }
          if (index < attempt.questions.length - 1) await answer.getByRole('button', { name: '下一题', exact: true }).click();
        }
        await snapshot('simulated-student-before-submit');
        await answer.getByRole('button', { name: '交卷并查看结果', exact: true }).click();
        await expect(quiz.getByText(new RegExp(`本次答对 ${account.key === 'A' ? 0 : attempt.questions.length}/${attempt.questions.length} 题`))).toBeVisible();
        attempt = (await api('/quiz?attempt=' + saved.attemptId)).value.attempt;
        assert.equal(attempt.completed, true); assert.equal(attempt.score.correct, account.key === 'A' ? 0 : attempt.questions.length);
        assert.equal(attempt.score.hinted, 0); assert.equal(attempt.score.skipped, 0); assert.equal(attempt.score.revealed, 0);
        save(`simulated-student-${account.key}-result.json`, { evidence: 'simulated_student_through_real_quiz_UI_and_API', policy: frozen.studentPolicy[account.key], quizId: saved.quizId, attemptId: attempt.id, score: attempt.score, completedAt: attempt.completedAt, quizSha256: privateQuiz.sha256 });
        assert.equal(requestCount(), beforeLogin, 'answer_UI_called_model'); await snapshot('actual-saved-score');
        await openAgent(); await refresh();
        const feedbackResponse = page.waitForResponse(response => response.url().endsWith(`/pages/${account.pageId}/agent`) && response.request().method() === 'PATCH');
        await panel().getByRole('button', { name: '已完成作答，继续复习', exact: true }).click();
        const firstEventResponse = await feedbackResponse; assert.equal(firstEventResponse.status(), 202);
        const feedbackEvent = firstEventResponse.request().postDataJSON();
        task = await settle('after-real-saved-answer', saved.beforeActions);
        assert(task.actions.length > saved.beforeActions, 'saved_answer_did_not_resume_decision');
        const after = task.actions.slice(saved.beforeActions); assert(after.some(action => action.tool !== 'learning.read_scope' && action.tool !== 'learning.read_navigation'), 'no_feedback_based_business_action');
        save(`trajectory-${account.key}-after-answer.json`, task);
        const afterCount = requestCount(), quizCount = (await api('/quiz')).value.quizzes.length, actionCount = task.actions.length;
        const duplicate = await api('/agent', 'PATCH', feedbackEvent); assert.equal(duplicate.status, 202);
        await page.waitForTimeout(1000); assert.equal(requestCount(), afterCount); assert.equal((await current()).actions.length, actionCount); assert.equal((await api('/quiz')).value.quizzes.length, quizCount);
        record(account.key, `simulated student submitted actual ${attempt.score.correct}/${attempt.score.total}; ${decisionLabel} resumed; duplicate event made no new action or request`);
        Object.assign(saved, { afterTools: after.map(action => action.tool), afterStatus: task.status, score: attempt.score, feedbackEvent }); persist();
        await snapshot('after-feedback');
        if (task.status === 'waiting') await waitIsQuiet(task, 'post-feedback wait');
        else assert.equal(task.status, 'ended', `trajectory_not_completed_${task.status}`);
        // Keep A available to continue. If B is still waiting, exercise the real
        // cancellation UI while retaining its already-saved quiz and answers.
        if (account.key === 'B' && task.status === 'waiting') {
          const beforeCancel = requestCount();
          await panel().getByRole('button', { name: '取消任务', exact: true }).click();
          await expect(panel().getByRole('status')).toContainText('用户已取消');
          assert.equal((await current()).status, 'cancelled');
          assert.equal((await api('/quiz?attempt=' + saved.attemptId)).value.attempt.completed, true);
          assert.equal(requestCount(), beforeCancel); await snapshot('cancelled-preserved-results');
          record(account.key, 'browser cancellation stopped the waiting task and retained actual saved quiz/answers without Provider calls');
        } else if (account.key === 'B') record(account.key, 'browser cancellation NOT RUN: model already ended/stopped this task; deterministic cancellation tests are separate evidence');
        await page.getByRole('navigation', { name: '学习任务' }).getByRole('button', { name: '阅读框架', exact: true }).click();
        await expect(page.getByRole('navigation', { name: '章节目录' })).toBeVisible();
        await page.getByRole('navigation', { name: '学习任务' }).getByRole('button', { name: 'Quiz 练习', exact: true }).click();
        await expect(quiz).toBeVisible();
        record(account.key, 'existing framework and manual Quiz remain reachable after Agent use');
      } else {
        const list = await tasks(); save(`inspect-${account.key}.json`, list); await snapshot('inspect');
        record(account.key, `read-only browser inspection: ${list.length} saved tasks`);
      }
    } catch (error) {
      failures.push({ key: account.key, error: safeError(error) });
      console.error(`[${phase} ${account.key}] FAIL ${safeError(error)}`);
      await snapshot('failure').catch(() => {});
    } finally { await context.close(); }
  }
  if (phase === 'after-restart' && accounts.every(account => state.accounts[account.key]?.afterTools)) {
    const a = state.accounts.A.afterTools, b = state.accounts.B.afterTools;
    try { assert.notDeepEqual(a, b, 'feedback_paths_did_not_diverge'); record('A+B', `${decisionLabel} selected different post-answer action sequences from the actual saved scores`); }
    catch (error) { failures.push({ key: 'A+B', error: safeError(error) }); }
  }
  if (errors.length) failures.push({ key: 'browser', error: 'uncaught_browser_errors', errors });
  if (denied.length) failures.push({ key: 'browser', error: 'unexpected_browser_egress', denied });
} finally {
  await browser.close();
  process.exitCode = failures.length ? 1 : 0;
  save(`browser-${phase}-result.json`, { status: process.exitCode ? 'FAIL' : 'PASS', evidence: offline ? 'offline_decision_and_generation_fixtures_real_business_sqlite_api_browser' : 'real_application_and_real_decision_model_with_simulated_student', evidenceMode: runtime.evidenceMode, checks, failures, errors, denied, requests: requestCount(), actualProviderNetworkRequests: offline ? 0 : requestCount(), exitCode: process.exitCode, browserClosed: true });
}
