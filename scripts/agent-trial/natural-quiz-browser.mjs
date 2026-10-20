// Ordinary goals + controlled offline Provider; real Runtime/API/SQLite/UI.
// Uses the existing launch/seed/stop lifecycle, never another server or ledger.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium, expect as baseExpect } from '@playwright/test';
import { chromiumLaunchOptions } from './browser-launch.mjs';
import { studentOption } from './student-policy.mjs';

const phase = process.argv[2];
assert(['before-restart', 'after-restart', 'inspect'].includes(phase), 'natural_quiz_browser_phase_required');
const root = path.resolve(process.env.AGENT_TRIAL_DIR ?? 'output/natural-language-quiz/browser');
const read = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const runtime = read('runtime.json'), accounts = read('synthetic-accounts.json');
assert.equal(runtime.evidenceMode, 'offline');
assert.equal(path.resolve(runtime.dataRoot), path.join(root, 'data'));
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(runtime.base).hostname));
const archive = path.join(root, 'natural-quiz-runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
fs.mkdirSync(path.join(archive, 'screenshots'), { recursive: true });
const save = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value, null, 2));
const state = fs.existsSync(path.join(root, 'natural-quiz-state.json')) ? read('natural-quiz-state.json') : { tasks: {} };
const persist = () => save('natural-quiz-state.json', state);
const readonly = (file, fn) => { const db = new Database(file, { readonly: true }); try { return fn(db); } finally { db.close(); } };
const ledger = () => readonly(path.join(root, 'offline-provider.sqlite'), db => db.prepare('SELECT count(*) requests,coalesce(sum(actual_network_requests),0) network FROM requests').get());
const checks = [], failures = [], expect = baseExpect.configure({ timeout: 30000 });
const pass = (key, message, evidence = {}) => {
  checks.push({ key, message, ...evidence });
  save(`natural-quiz-${phase}-checks.json`, checks);
  console.log(`[natural-quiz ${phase} ${checks.length}] ${key}: ${message}; offline responses=${ledger().requests}, real Provider=${ledger().network}`);
};
const caseDefinitions = [
  { key: 'A', mode: 'partial', goal: '练习交集与并集' },
  { key: 'B', mode: 'all_failed', goal: '考考我' },
  { key: 'C', mode: 'repeat_explanation', goal: '我不理解具体的定义，帮帮我' },
  { key: 'D', mode: 'partial', goal: '我想练练这部分' },
  { key: 'E', mode: 'multi_round', goal: '我总分不清交集和并集，帮我练练' },
];
const expectedControl = { version: 1, cases: caseDefinitions.map(item => {
  const account = accounts.find(account => account.key === item.key); assert(account, 'existing_seed_accounts_required');
  return { pageId: account.pageId, materialId: account.materialId, mode: item.mode };
}) };
if (fs.existsSync(path.join(root, 'offline-natural-quiz.json'))) assert.deepEqual(read('offline-natural-quiz.json'), expectedControl, 'do_not_replace_existing_fixture_controls');
else {
  assert.equal(phase, 'before-restart', 'fixture_control_requires_initial_phase');
  save('offline-natural-quiz.json', expectedControl);
}
const browser = await chromium.launch(chromiumLaunchOptions());

async function session(key, work) {
  const account = accounts.find(account => account.key === key), definition = caseDefinitions.find(item => item.key === key);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, serviceWorkers: 'block' });
  const errors = [], external = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === runtime.base) return route.continue();
    external.push(new URL(route.request().url()).origin); return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const login = async () => assert.equal((await context.request.post(runtime.base + '/api/auth/login', { data: { email: account.email, password: account.password } })).status(), 200);
  const api = async (suffix = '/agent', method = 'GET', data) => page.evaluate(async ({ url, method, data }) => {
    const response = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store',
      ...(data === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }) });
    return { status: response.status, value: await response.json() };
  }, { url: `/api/learning/pages/${account.pageId}${suffix}`, method, data });
  const current = async id => {
    const response = await api(); assert.equal(response.status, 200);
    const task = response.value.tasks.find(task => task.id === id); assert(task);
    fs.writeFileSync(path.join(archive, `task-${key}.json`), JSON.stringify(task, null, 2)); return task;
  };
  const panel = () => page.getByRole('region', { name: '复习向导', exact: true });
  const open = async id => {
    await page.goto(`${runtime.base}/learning/${account.pageId}?view=agent${id ? '&agent=' + id : ''}`);
    await page.getByRole('navigation', { name: '学习任务' }).getByRole('button', { name: '复习向导', exact: true }).click();
    await expect(panel()).toBeVisible();
    await expect(panel().getByText('正在读取复习任务…', { exact: true })).toBeHidden();
    if (id) await expect(panel()).toContainText(definition.goal);
  };
  const snapshot = async name => {
    await expect(panel().getByText('正在读取复习任务…', { exact: true })).toBeHidden();
    await page.screenshot({ path: path.join(archive, 'screenshots', `${key}-${name}.png`), fullPage: true });
  };
  const settle = async (id, predicate = task => !['ready', 'running'].includes(task.status)) => {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const task = await current(id);
      if (predicate(task)) return task;
      await page.waitForTimeout(250);
    }
    throw Error('natural_quiz_browser_task_timeout');
  };
  const start = async () => {
    if (state.tasks[key]) return current(state.tasks[key]);
    await open();
    if (await panel().getByRole('button', { name: '开始另一项复习', exact: true }).isVisible()) await panel().getByRole('button', { name: '开始另一项复习', exact: true }).click();
    await panel().getByLabel('复习目标', { exact: true }).fill(definition.goal);
    const response = page.waitForResponse(response => response.url().endsWith(`/${account.pageId}/agent`) && response.request().method() === 'POST');
    await panel().getByRole('button', { name: '明确开始复习', exact: true }).click();
    const created = await response; assert.equal(created.status(), 202);
    const task = (await created.json()).task;
    assert.equal(task.goal, definition.goal, 'ordinary_user_input_must_not_be_rewritten');
    state.tasks[key] = task.id; persist(); return task;
  };
  const quiet = async (id, label) => {
    const before = ledger(); await page.reload(); await current(id); await page.waitForTimeout(600);
    assert.deepEqual(ledger(), before);
    await context.request.post(runtime.base + '/api/auth/logout'); await context.clearCookies();
    assert.equal((await context.request.get(`${runtime.base}/api/learning/pages/${account.pageId}/agent`)).status(), 401);
    await login(); await open(id); await current(id); await page.waitForTimeout(600);
    assert.deepEqual(ledger(), before); pass(key, `${label}: refresh/logout/relogin adds no model requests`);
  };
  const submitOne = async (link, policy) => {
    const stored = readonly(path.join(runtime.dataRoot, 'users', account.userId, 'learning-organizer.sqlite'), db =>
      JSON.parse(db.prepare('SELECT result_json FROM learning_quiz_runs WHERE id=?').get(link.quizId).result_json));
    const before = (await api('/quiz?attempt=' + link.attemptId)).value.attempt;
    assert.equal(before.completed, false); assert.equal(before.questions.length, 1);
    const article = page.getByRole('article', { name: '当前作答', exact: true }); await expect(article).toBeVisible();
    const option = studentOption(policy, before.questions[0], stored.questions[0]);
    const chosen = page.waitForResponse(response => response.url().endsWith('/quiz') && response.request().method() === 'PATCH');
    await article.locator(`input[value="${option}"]`).click(); assert.equal((await chosen).status(), 200);
    await expect(article.getByRole('status')).toContainText('选择已保存');
    const finished = page.waitForResponse(response => response.url().endsWith('/quiz') && response.request().method() === 'PATCH'
      && response.request().postDataJSON()?.value?.action === 'finish');
    await article.getByRole('button', { name: '交卷并查看结果', exact: true }).click();
    const response = await finished; assert.equal(response.status(), 200);
    return { event: response.request().postDataJSON(), attempt: (await api('/quiz?attempt=' + link.attemptId)).value.attempt };
  };
  try {
    await login(); await open(state.tasks[key]);
    await work({ account, page, api, current, panel, open, snapshot, settle, start, quiet, submitOne });
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
  } catch (error) {
    const item = { key, message: String(error?.message ?? error).split('Call log:')[0].slice(0, 1800) };
    failures.push(item); console.error(`[natural-quiz ${key}] FAIL ${item.message}`); await snapshot('failure').catch(() => {});
  } finally { await context.close(); }
}

try {
  if (phase === 'before-restart') {
    for (const key of ['A', 'D']) await session(key, async h => {
      let task = await h.start(); task = await h.settle(task.id);
      assert.equal(task.status, 'waiting'); assert.equal(task.wait.kind, 'quiz_submission');
      assert.equal(task.quizLinks.length, 1); assert.equal(task.completion.plan.kind, 'diagnosis');
      const link = task.quizLinks[0], attempt = (await h.api('/quiz?attempt=' + link.attemptId)).value.attempt;
      assert.equal(attempt.questions.length, 1); assert.equal(attempt.completed, false);
      assert(attempt.questions.every(question => !question.feedback));
      assert(!JSON.stringify(task).includes('correctOptionId'));
      const delivery = task.quizDeliveries.find(item => item.quizId === link.quizId)?.delivery;
      assert(delivery, 'actual_partial_delivery_required');
      assert.equal(delivery.published, 1); assert.equal(delivery.requested, 3);
      assert(task.completion.objectives.every(objective => objective.status === 'unobserved'));
      state[key] = { ...link, version: task.version }; persist();
      await h.open(task.id); await expect(h.page.getByRole('article', { name: '当前作答', exact: true })).toBeVisible();
      await h.snapshot('one-valid-question'); await h.quiet(task.id, 'one of three candidates remains answerable');
      pass(key, 'ordinary goal → diagnosis → 3 candidates/1 real published question; no invented coverage or answer leakage', { taskId: task.id, quizId: link.quizId });
    });
    await session('B', async h => {
      let task = await h.start(); task = await h.settle(task.id);
      assert.equal(task.status, 'waiting'); assert.equal(task.wait.kind, 'feedback'); assert.equal(task.quizLinks.length, 0);
      assert.equal(task.explanations.length, 1);
      assert.equal(task.actions.filter(action => action.tool === 'learning.create_quiz').length, 1);
      assert.notEqual(task.completion.outcome, 'check_passed');
      assert(task.quizDeliveries.some(item => item.delivery.published === 0));
      await h.open(task.id);
      await expect(h.panel()).toContainText('可靠题目');
      await h.snapshot('zero-publication-feedback'); await h.quiet(task.id, 'all candidates rejected without repeated generation');
      pass('B', 'all invalid candidates remain unpublished; user sees failed practice delivery and can respond to the actual explanation');
    });
    await session('C', async h => {
      let task = await h.start(); task = await h.settle(task.id);
      assert.equal(task.status, 'waiting'); assert.equal(task.wait.kind, 'feedback');
      assert.equal(task.explanations.length, 1); assert.equal(task.quizLinks.length, 0);
      assert.equal(task.completion.outcome, 'insufficient');
      await h.open(task.id); await expect(h.panel().getByRole('button', { name: '疑问已解决', exact: true })).toBeVisible();
      const before = ledger();
      await h.panel().getByLabel('你的反馈', { exact: true }).fill('谢谢');
      const response = h.page.waitForResponse(response => response.url().endsWith('/agent') && response.request().method() === 'PATCH');
      await h.panel().getByRole('button', { name: '提交其他反馈', exact: true }).click();
      assert.equal((await response).status(), 202);
      task = await h.settle(task.id, value => value.status === 'waiting' && value.actions.length > task.actions.length);
      assert.notEqual(task.completion.outcome, 'explanation_resolved'); assert.equal(task.explanations.length, 1);
      state.C = { version: task.version, explanationId: task.explanations[0].id }; persist();
      await h.open(task.id); await expect(h.panel().getByRole('button', { name: '疑问已解决', exact: true })).toBeVisible();
      await h.snapshot('first-feedback-retained'); await h.quiet(task.id, 'first explicit explanation feedback remains available');
      pass('C', 'duplicate explanation blocked without terminal lockout; ordinary thanks leaves resolution unconfirmed', { requestsForThanks: ledger().requests - before.requests });
    });
    await session('E', async h => {
      let task = await h.start(); task = await h.settle(task.id);
      assert.equal(task.status, 'waiting'); assert.equal(task.quizLinks.length, 1);
      assert.equal(task.completion.plan.kind, 'targeted_review');
      assert.equal(task.completion.plan.objectives[0].requirements[0].role, 'followup');
      const first = task.quizLinks[0];
      await h.open(task.id);
      const { attempt: wrong } = await h.submitOne(first, 'A');
      assert.equal(wrong.score.correct, 0); assert.equal(wrong.score.total, 1);
      task = await h.settle(task.id, value => value.status === 'waiting' && value.quizLinks.length === 2);
      assert.equal(task.wait.kind, 'quiz_submission');
      assert.equal(task.explanations.length, 1);
      assert(task.actions.some(action => action.tool === 'learning.read_answers' && action.status === 'succeeded'));
      assert(task.actions.some(action => action.tool === 'learning.associate_evidence' && action.status === 'succeeded'));
      const objective = task.completion.objectives.find(objective => objective.id === 'membership');
      assert.equal(objective.unresolvedErrors.length, 1);
      assert(objective.evidence.some(evidence => evidence.ref.attemptId === first.attemptId && evidence.correct === false && evidence.relation === 'initial'));
      assert.notEqual(task.completion.outcome, 'check_passed');
      const second = task.quizLinks.find(link => link.attemptId !== first.attemptId);
      assert(second && !second.completed);
      const pending = (await h.api('/quiz?attempt=' + second.attemptId)).value.attempt;
      assert.equal(pending.completed, false); assert.equal(pending.questions.length, 1);
      assert(pending.questions.every(question => !question.feedback));
      assert.notEqual(pending.questions[0].stem, wrong.questions[0].stem);
      assert(task.usage.calls <= 16, 'existing_task_budget_must_remain_unchanged');
      state.E = { first, second, version: task.version, callsBeforeSecondAnswer: task.usage.calls, plan: task.completion.plan }; persist();
      await h.open(task.id);
      await expect(h.page.getByRole('article', { name: '当前作答', exact: true })).toBeVisible();
      await expect(h.panel()).toContainText(task.explanations[0].text);
      await h.snapshot('wrong-explained-followup-waiting');
      await h.quiet(task.id, 'actual error preserved while second related question awaits submission');
      pass('E', 'ordinary difficulty → actual first Quiz → UI wrong answer → read_answers/association → targeted explanation → distinct followup Quiz', {
        firstQuizId: first.quizId, secondQuizId: second.quizId, firstScore: wrong.score, taskCalls: task.usage.calls,
      });
    });
    state.processBeforeRestart = { childPid: runtime.childPid, startedAt: runtime.startedAt, requests: ledger().requests }; persist();
  } else if (phase === 'after-restart') {
    assert(state.processBeforeRestart);
    assert.notEqual(runtime.childPid, state.processBeforeRestart.childPid);
    assert.notEqual(runtime.startedAt, state.processBeforeRestart.startedAt);
    assert.equal(ledger().requests, state.processBeforeRestart.requests, 'restart_waiting_adds_zero_calls');
    await session('A', async h => {
      let task = await h.current(state.tasks.A);
      assert.equal(task.version, state.A.version); assert.equal(task.status, 'waiting');
      assert.equal(task.quizLinks[0].quizId, state.A.quizId); await h.quiet(task.id, 'same saved question survived normal restart');
      const stored = readonly(path.join(runtime.dataRoot, 'users', h.account.userId, 'learning-organizer.sqlite'), db =>
        JSON.parse(db.prepare('SELECT result_json FROM learning_quiz_runs WHERE id=?').get(state.A.quizId).result_json));
      const attempt = (await h.api('/quiz?attempt=' + state.A.attemptId)).value.attempt;
      const article = h.page.getByRole('article', { name: '当前作答', exact: true }); await expect(article).toBeVisible();
      const option = studentOption('B', attempt.questions[0], stored.questions[0]);
      const chosen = h.page.waitForResponse(response => response.url().endsWith('/quiz') && response.request().method() === 'PATCH');
      await article.locator(`input[value="${option}"]`).click(); assert.equal((await chosen).status(), 200);
      await expect(article.getByRole('status')).toContainText('选择已保存');
      const submitted = h.page.waitForResponse(response => response.url().endsWith('/quiz') && response.request().method() === 'PATCH'
        && response.request().postDataJSON()?.value?.action === 'finish');
      await article.getByRole('button', { name: '交卷并查看结果', exact: true }).click();
      const received = await submitted; assert.equal(received.status(), 200); const originalFinish = received.request().postDataJSON();
      task = await h.settle(task.id, value => value.status === 'ended');
      const saved = (await h.api('/quiz?attempt=' + state.A.attemptId)).value.attempt;
      assert.equal(saved.completed, true); assert.equal(saved.score.correct, 1); assert.equal(saved.score.total, 1);
      assert.equal(task.completion.outcome, 'diagnosis_complete'); assert.equal(task.completion.longTermMastery, 'unverified');
      assert(task.actions.some(action => action.tool === 'learning.read_answers' && action.status === 'succeeded'));
      assert(task.actions.some(action => action.tool === 'learning.associate_evidence' && action.status === 'succeeded'));
      assert.equal(task.quizLinks.length, 1);
      const before = ledger(); assert.equal((await h.api('/quiz', 'PATCH', originalFinish)).status, 200);
      await h.page.waitForTimeout(600); assert.deepEqual(ledger(), before);
      assert.deepEqual((await h.api('/quiz?attempt=' + state.A.attemptId)).value.attempt, saved);
      await h.open(task.id); await h.snapshot('diagnosis-complete'); await h.quiet(task.id, 'finished diagnosis stays read-only');
      pass('A', 'real component submission → saved 1/1 → read_answers/association → bounded diagnosis completion; exact duplicate submit has zero writes/calls');
    });
    await session('C', async h => {
      let task = await h.current(state.tasks.C); assert.equal(task.status, 'waiting'); assert.equal(task.explanations[0].id, state.C.explanationId);
      const before = ledger();
      const response = h.page.waitForResponse(response => response.url().endsWith('/agent') && response.request().method() === 'PATCH');
      await h.panel().getByRole('button', { name: '疑问已解决', exact: true }).click();
      const received = await response; assert.equal(received.status(), 202); const event = received.request().postDataJSON();
      task = await h.settle(task.id, value => value.status === 'ended');
      assert.equal(task.completion.outcome, 'explanation_resolved'); assert.equal(task.quizLinks.length, 0); assert.deepEqual(ledger(), before);
      assert.equal((await h.api('/agent', 'PATCH', event)).status, 202);
      await h.page.waitForTimeout(600); assert.deepEqual(ledger(), before); assert.equal((await h.current(task.id)).explanations.length, 1);
      await h.open(task.id); await h.snapshot('resolved-once');
      pass('C', 'after normal restart, first explicit resolution ends with no model call; duplicate event neither writes nor generates');
    });
    await session('E', async h => {
      let task = await h.current(state.tasks.E);
      assert.equal(task.status, 'waiting'); assert.equal(task.version, state.E.version);
      assert.deepEqual(task.completion.plan, state.E.plan, 'fixed_plan_must_not_be_relaxed_for_completion');
      assert.equal(task.quizLinks.length, 2); assert.equal(task.explanations.length, 1);
      assert.equal(task.completion.objectives[0].unresolvedErrors.length, 1);
      const beforeSubmission = ledger();
      const { attempt: followup, event } = await h.submitOne(state.E.second, 'B');
      assert.equal(followup.score.correct, 1); assert.equal(followup.score.total, 1);
      task = await h.settle(task.id, value => value.status === 'ended');
      assert.equal(task.completion.outcome, 'check_passed');
      assert.equal(task.completion.longTermMastery, 'unverified');
      const objective = task.completion.objectives.find(objective => objective.id === 'membership');
      assert.equal(objective.status, 'supported'); assert.equal(objective.unresolvedErrors.length, 0);
      const old = objective.evidence.find(evidence => evidence.ref.attemptId === state.E.first.attemptId);
      const later = objective.evidence.find(evidence => evidence.ref.attemptId === state.E.second.attemptId);
      assert.equal(old.correct, false); assert.equal(old.relation, 'initial');
      assert.equal(later.correct, true); assert.equal(later.relation, 'followup'); assert.equal(later.independentInApp, true);
      assert(later.priorEvidenceRefs.some(ref => ref.attemptId === old.ref.attemptId && ref.questionIndex === old.ref.questionIndex));
      assert.equal((await h.api('/quiz?attempt=' + state.E.first.attemptId)).value.attempt.score.correct, 0);
      assert.equal(task.quizLinks.length, 2); assert(task.usage.calls <= 16);
      assert.deepEqual(task.completion.plan, state.E.plan);
      assert.equal(ledger().requests - beforeSubmission.requests, 2, 'only_read_answers_and_associate_decisions_before_evidence_is_sufficient_no_extra_finish_call');
      const reads = task.actions.filter(action => action.tool === 'learning.read_answers' && action.status === 'succeeded');
      assert.equal(reads.length, 2);
      const before = ledger(); assert.equal((await h.api('/quiz', 'PATCH', event)).status, 200);
      await h.page.waitForTimeout(600); assert.deepEqual(ledger(), before);
      await h.open(task.id); await expect(h.panel()).toContainText(task.completion.headline);
      await h.snapshot('two-round-supported-stop'); await h.quiet(task.id, 'evidence-supported stop does not generate a third group');
      pass('E', 'second actual UI answer → second read_answers/association → supported followup clears only linked error → zero-extra-call stop; initial wrong score retained', {
        firstScore: { correct: 0, total: 1 }, secondScore: followup.score, taskCalls: task.usage.calls, outcome: task.completion.outcome,
      });
    });
    await session('D', async h => {
      let task = await h.current(state.tasks.D); const before = ledger();
      assert.equal((await h.api('/materials/' + h.account.materialId, 'DELETE')).status, 200);
      const exposed = await h.api('/quiz?attempt=' + state.D.attemptId + '&question=0&source=0');
      const deletedSource = await h.api('/materials/' + h.account.materialId);
      fs.writeFileSync(path.join(archive, 'D-source-http.json'), JSON.stringify({ attemptSource: exposed, deletedSource }, null, 2));
      assert.deepEqual(exposed, { status: 403, value: { error: 'quiz_answers_hidden' } }, 'unsubmitted_attempt_still_hides_answers_before_source_lookup');
      assert.deepEqual(deletedSource, { status: 410, value: { error: 'material_deleted' } }, 'deleted_material_original_text_is_unavailable');
      task = await h.current(task.id);
      assert.equal(task.quizLinks.length, 0); assert.equal(task.explanations.length, 0); assert.equal(task.quizDeliveries.length, 0);
      assert.deepEqual(ledger(), before);
      await h.open(task.id); await h.snapshot('source-deleted');
      pass('D', 'deleted source blocks original reads and removes stale task artifacts/delivery details without model calls');
    });
  } else {
    for (const key of ['A', 'B', 'C', 'D', 'E']) await session(key, async h => {
      const task = await h.current(state.tasks[key]); await h.quiet(task.id, 'read-only inspection');
      await h.snapshot('retained-final-state');
      if (key === 'E') {
        const before = ledger();
        const attempts = await Promise.all([state.E.first, state.E.second].map(async link => {
          const response = await h.api('/quiz?attempt=' + link.attemptId);
          assert.equal(response.status, 200); assert.equal(response.value.attempt.completed, true);
          return response.value.attempt;
        }));
        fs.writeFileSync(path.join(archive, 'E-two-round-business-facts.json'), JSON.stringify({
          evidence: 'controlled_offline_model_real_ui_submissions_simulated_student',
          taskId: task.id, taskVersion: task.version, plan: task.completion.plan,
          attempts, completion: task.completion, usage: task.usage, actions: task.actions,
        }, null, 2));
        assert.deepEqual(ledger(), before);
      }
      pass(key, 'saved synthetic task retained for later inspection', { status: task.status, outcome: task.completion?.outcome });
    });
  }
} catch (error) {
  failures.push({ key: 'lifecycle', message: String(error?.message ?? error).slice(0, 1800) });
} finally {
  await browser.close();
  const integrity = accounts.flatMap(account => {
    const folder = path.join(runtime.dataRoot, 'users', account.userId);
    return fs.readdirSync(folder).filter(file => file.endsWith('.sqlite')).map(file =>
      ({ account: account.key, database: file, result: readonly(path.join(folder, file), db => db.pragma('integrity_check')) }));
  });
  if (!integrity.every(item => item.result.every(row => row.integrity_check === 'ok')))
    failures.push({ key: 'integrity', message: 'One or more synthetic SQLite integrity checks failed' });
  if (ledger().network !== 0) failures.push({ key: 'network', message: 'Unexpected real Provider request' });
  const result = { status: failures.length ? 'FAIL' : 'PASS', phase, checks: checks.length, failures, provider: ledger(),
    evidence: 'controlled_offline_model_real_runtime_api_sqlite_components_simulated_student',
    modelQualityValidated: false, longTermMasteryValidated: false, tasks: state.tasks, integrity, archive };
  save(`natural-quiz-${phase}-result.json`, result);
  fs.writeFileSync(path.join(archive, 'result.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(archive, 'checks.json'), JSON.stringify(checks, null, 2));
  assert.equal(result.provider.network, 0);
  assert(integrity.every(item => item.result.every(row => row.integrity_check === 'ok')));
  if (failures.length) process.exitCode = 1;
  console.log(JSON.stringify(result, null, 2));
}
