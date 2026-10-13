// Browser-only companion to a2-browser.mjs. Uses its isolated authenticated
// session and offline Provider; never starts a server or changes an answer key.
import assert from 'node:assert/strict';
import path from 'node:path';

const materialTitle = '合成教材 · 集合、交集与并集';
const extraTitle = '【离线手动回归】待删除文本';
const extraText = '【合成验收材料】这份文本仅检查保存、选择与删除，不用于出题或 Agent。';
const noteMarker = '【离线手动回归笔记】交集与并集需要分别核对元素归属。';
const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Open a real unsaved editor BEFORE another page approves an Agent proposal.
 * The caller owns the approval click and must close this companion in finally. */
export async function openUnsavedNoteDraft(h, { runtime, root, expect, task, calls }) {
  assert.equal(runtime.evidenceMode, 'offline');
  assert.equal(h.account.key, 'B'); assert.equal(task.approval?.status, 'pending');
  const response = await h.api('/framework'); assert.equal(response.status, 200);
  const matches = response.value.framework.chapters.flatMap(chapter => chapter.nodes
    .filter(node => `${chapter.title} / ${node.title}` === task.approval.target).map(node => ({ chapter, node })));
  assert.equal(matches.length, 1, 'approval_target_must_resolve_uniquely');
  const { chapter, node } = matches[0];
  const draft = [node.note, '【离线未保存草稿】这段仍由编辑器持有，不能覆盖另页已批准的笔记。'].filter(Boolean).join('\n\n');
  const other = await h.page.context().newPage();
  try {
    await other.goto(`${runtime.base}/learning/${h.account.pageId}?view=read`);
    const article = other.locator(`[id="knowledge-${node.id}"]`);
    await expect(article).toBeVisible();
    await article.getByText('更多', { exact: true }).click();
    await article.getByRole('button', { name: '编辑知识点 / 笔记', exact: true }).click();
    const edit = article.getByRole('form', { name: '编辑框架', exact: true });
    const note = edit.getByRole('textbox', { name: '个人笔记', exact: true });
    await note.fill(draft);
    await h.page.bringToFront();
    return {
      close: () => other.close(),
      async verifyAfterApproval() {
        const before = calls();
        await expect(note).toHaveValue(draft);
        await other.bringToFront(); // Existing focus refresh must retain the draft.
        await expect(note).toHaveValue(draft);
        const currentResponse = await h.api('/framework'); assert.equal(currentResponse.status, 200);
        const currentChapter = currentResponse.value.framework.chapters.find(item => item.id === chapter.id);
        const currentNode = currentChapter.nodes.find(item => item.id === node.id);
        assert(currentChapter.revision > chapter.revision); assert(currentNode.note.includes(task.approval.content));
        assert(!currentNode.note.includes('【离线未保存草稿】'));
        const pending = other.waitForResponse(result => new URL(result.url()).pathname === `/api/learning/pages/${h.account.pageId}/framework` && result.request().method() === 'PATCH');
        await edit.getByRole('button', { name: '保存修改', exact: true }).click();
        const rejected = await pending; assert.equal(rejected.status(), 409);
        assert.equal(rejected.request().postDataJSON().revision, chapter.revision);
        assert.equal((await rejected.json()).error, 'framework_edit_conflict');
        await expect(other.getByRole('region', { name: '知识框架', exact: true }).getByRole('alert')).toContainText('你的草稿仍在');
        await expect(note).toHaveValue(draft);
        const after = (await h.api('/framework')).value.framework.chapters.find(item => item.id === chapter.id);
        assert.deepEqual(after, currentChapter, 'stale_editor_must_not_overwrite_agent_note');
        assert.equal(calls(), before, 'draft_reconciliation_must_not_generate');
        await other.screenshot({ path: path.join(root, 'screenshots', 'a3-B-unsaved-draft-conflict.png'), fullPage: true });
        return { nodeId: node.id, oldRevision: chapter.revision, savedRevision: currentChapter.revision, status: 409,
          draftPreserved: true, approvedNotePreserved: true, providerRequestsDuringConflict: 0 };
      },
    };
  } catch (error) { await other.close(); throw error; }
}

export async function verifyManualLearning(h, { runtime, expect, pass, save, calls, state, persist }) {
  assert.equal(runtime.evidenceMode, 'offline', 'manual_regression_is_offline_only');
  assert.equal(h.account.key, 'M', 'dedicated_manual_account_required');
  const { page, account, api } = h;
  const saved = state.manual ??= { steps: [], requests: [], initialCalls: calls() };
  persist();
  const url = query => `${runtime.base}/learning/${account.pageId}?${query}`;
  const nav = () => page.getByRole('navigation', { name: '学习任务' });
  const quiz = () => page.getByRole('region', { name: '单选 Quiz', exact: true });
  const reader = () => page.getByRole('region', { name: '知识框架', exact: true });
  const node = () => reader().getByRole('article', { name: '交集与并集的归属条件', exact: true });
  const data = async suffix => { const result = await api(suffix); assert.equal(result.status, 200); return result.value; };
  const pageData = async () => (await data('')).page;
  const framework = async () => (await data('/framework')).framework;
  const nodeData = async () => (await framework()).chapters.flatMap(chapter => chapter.nodes).find(item => item.id === account.nodeIds[0]);
  const attempt = async id => (await data('/quiz?attempt=' + id)).attempt;
  const actResponse = async (suffix, method, action) => {
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === `/api/learning/pages/${account.pageId}${suffix}` && response.request().method() === method);
    await action(); const response = await pending;
    saved.requests.push({ path: suffix, method, status: response.status() }); persist();
    assert(response.ok(), `manual_${method}_${suffix}_${response.status()}`);
    return { value: await response.json(), input: method === 'POST' && suffix === '/materials' ? null : response.request().postDataJSON() };
  };
  const closeSource = async () => {
    const dialog = page.getByRole('dialog', { name: '材料原文', exact: true });
    await expect(dialog).toBeVisible(); await expect(dialog.getByText(/交集 A∩B 包含同时属于 A 和 B/)).toBeVisible();
    await dialog.getByRole('button', { name: '关闭原文', exact: true }).click();
  };
  const step = async (name, work) => {
    if (saved.steps.includes(name)) { pass(`preserved ${name}: already verified in this retained manual run`); return; }
    await work(); saved.steps.push(name); persist(); await h.snapshot('manual-' + name); pass(name);
  };
  await step('material_selection_and_save', async () => {
    await page.goto(url('view=materials')); await nav().getByRole('button', { name: '材料', exact: true }).click();
    const original = page.getByRole('checkbox', { name: new RegExp('^' + escaped(materialTitle)) });
    await expect(original).toBeChecked();
    await actResponse('', 'PATCH', () => original.uncheck());
    assert.equal((await pageData()).materials.find(item => item.id === account.materialId).selected, false);
    await page.reload(); await expect(original).not.toBeChecked();
    await actResponse('', 'PATCH', () => original.check());
    assert.equal((await pageData()).materials.find(item => item.id === account.materialId).selected, true);
    let extra = (await pageData()).materials.find(item => item.title === extraTitle);
    if (!extra) {
      await page.getByText('粘贴文本或笔记', { exact: true }).click();
      await page.getByRole('textbox', { name: '文本标题', exact: true }).fill(extraTitle);
      await page.getByRole('textbox', { name: '粘贴文本', exact: true }).fill(extraText);
      await page.getByRole('button', { name: '加入本次材料', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '材料与进度', exact: true });
      await dialog.getByText('其他整理方式', { exact: true }).click();
      await dialog.getByRole('combobox', { name: '完成后', exact: true }).selectOption('save');
      await actResponse('/materials', 'POST', () => dialog.getByRole('button', { name: '只保存 · 1 份', exact: true }).click());
      await page.keyboard.press('Escape');
      extra = (await pageData()).materials.find(item => item.title === extraTitle);
    }
    assert(extra); saved.extraMaterialId = extra.id; persist();
    const extraCheckbox = page.getByRole('checkbox', { name: new RegExp('^' + escaped(extraTitle)) });
    if (await extraCheckbox.isChecked()) await actResponse('', 'PATCH', () => extraCheckbox.uncheck());
    assert.deepEqual((await pageData()).materials.filter(item => item.selected).map(item => item.id), [account.materialId]);
    assert.equal(calls(), saved.initialCalls, 'material_operations_must_not_generate');
  });
  await step('framework_source_and_personal_note', async () => {
    await page.goto(url('view=read')); await expect(node()).toBeVisible();
    saved.originalNode ??= await nodeData(); persist();
    await expect(node().getByText(saved.originalNode.explanation, { exact: true })).toBeVisible();
    await node().locator('details').filter({ has: page.locator('summary').filter({ hasText: /^引用 · / }) }).locator('summary').click();
    await node().getByRole('button', { name: materialTitle + ' · 第 3 段', exact: true }).click();
    await closeSource();
    if (!(await nodeData()).note.includes(noteMarker)) {
      await node().getByText('更多', { exact: true }).click();
      await node().getByRole('button', { name: '编辑知识点 / 笔记', exact: true }).click();
      const edit = node().getByRole('form', { name: '编辑框架', exact: true });
      await edit.getByRole('textbox', { name: '个人笔记', exact: true }).fill([saved.originalNode.note, noteMarker].filter(Boolean).join('\n\n'));
      await actResponse('/framework', 'PATCH', () => edit.getByRole('button', { name: '保存修改', exact: true }).click());
    }
    const current = await nodeData(); assert(current.note.includes(noteMarker));
    assert.equal(current.explanation, saved.originalNode.explanation); assert.deepEqual(current.sources, saved.originalNode.sources);
    await page.reload(); await expect(node().getByText(noteMarker, { exact: true })).toBeVisible();
    assert.equal(calls(), saved.initialCalls, 'reading_and_note_edit_must_not_generate');
  });
  await step('manual_followup_explicit_note_and_history', async () => {
    await page.goto(url('view=read')); await node().getByRole('button', { name: '没看懂 / 继续追问', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '没看懂 / 继续追问', exact: true });
    const conversation = () => dialog.getByRole('region', { name: '知识点对话', exact: true });
    const query = `/node-qa?chapter=${account.chapterId}&node=${account.nodeIds[0]}`;
    let conversations = (await data(query)).conversations;
    let turn = conversations.flatMap(item => item.turns).find(item => item.question === '【离线手动追问】共同元素为什么也在并集中？');
    if (!turn) {
      const beforeNote = (await nodeData()).note;
      await conversation().getByRole('textbox', { name: '继续追问', exact: true }).fill('【离线手动追问】共同元素为什么也在并集中？');
      await actResponse('/node-qa', 'POST', () => conversation().getByRole('button', { name: '发送问题', exact: true }).click());
      await expect(conversation().getByText('材料内容 · AI 解释', { exact: true })).toBeVisible();
      assert.equal((await nodeData()).note, beforeNote, 'ordinary_answer_must_not_write_note');
      conversations = (await data(query)).conversations;
      turn = conversations.flatMap(item => item.turns).find(item => item.question === '【离线手动追问】共同元素为什么也在并集中？');
    }
    assert.equal(turn?.status, 'completed'); assert(turn.answer?.materialAnswer && turn.answer.items.length);
    saved.manualTurnId = turn.id; saved.manualAnswer = turn.answer.materialAnswer; persist();
    if (!turn.savedSections.includes(-1)) await actResponse('/node-qa', 'PATCH', () => conversation().getByRole('button', { name: '将材料解释存为笔记', exact: true }).click());
    await expect(conversation().getByRole('button', { name: '已存为笔记', exact: true })).toBeDisabled();
    const updated = await nodeData(); assert(updated.note.includes(noteMarker)); assert(updated.note.includes(saved.manualAnswer));
    assert.equal(updated.explanation, saved.originalNode.explanation);
    await conversation().locator('details').filter({ has: page.locator('summary').filter({ hasText: /^引用 · / }) }).locator('summary').click();
    await conversation().getByRole('button', { name: new RegExp('^' + escaped(materialTitle) + ' · 第 ') }).first().click();
    await closeSource();
    const beforeReload = calls(); await page.reload(); await node().getByRole('button', { name: '没看懂 / 继续追问', exact: true }).click();
    await expect(conversation().getByText(saved.manualAnswer, { exact: true })).toBeVisible();
    await expect(conversation().getByRole('button', { name: '已存为笔记', exact: true })).toBeDisabled();
    assert.equal(calls(), beforeReload, 'reopening_manual_history_must_not_generate');
    await page.keyboard.press('Escape');
  });
  const quizRound = async mode => {
    const record = saved[mode] ??= {}; persist();
    if (!record.quizId) {
      await page.goto(url('view=quiz')); await expect(quiz().getByRole('button', { name: '生成 Quiz', exact: true })).toBeVisible();
      await quiz().getByRole('spinbutton', { name: '题量', exact: true }).fill('2');
      await quiz().getByRole('combobox', { name: '难度', exact: true }).selectOption('basic');
      expect(await quiz().getByRole('checkbox', { name: '纳入所选范围的个人笔记', exact: true }).isChecked()).toBe(false);
      const generated = await actResponse('/quiz', 'POST', () => quiz().getByRole('button', { name: '生成 Quiz', exact: true }).click());
      record.quizId = generated.input.id; persist();
    } else await page.goto(url('view=quiz&quiz=' + record.quizId));
    if (!record.attemptId) {
      await expect(quiz().getByRole('button', { name: '开始作答', exact: true })).toBeVisible();
      await quiz().getByRole('radio', { name: mode === 'practice' ? /^练习/ : /^测验/ }).check();
      const started = await actResponse('/quiz', 'PATCH', () => quiz().getByRole('button', { name: '开始作答', exact: true }).click());
      record.attemptId = started.value.attempt.id; persist();
    }
    let current = await attempt(record.attemptId); assert.equal(current.mode, mode); assert.equal(current.questions.length, 2);
    const answer = () => quiz().getByRole('article', { name: '当前作答', exact: true });
    for (let index = 0; index < 2 && !current.completed; index++) {
      await page.goto(url(`view=quiz&attempt=${record.attemptId}&question=${index}`));
      await expect(answer()).toBeVisible(); current = await attempt(record.attemptId);
      if (mode === 'test') {
        for (const question of current.questions) assert.equal(question.feedback, undefined, 'test_answer_leaked_before_finish');
        assert.equal(await answer().getByRole('button', { name: '看答案', exact: true }).count(), 0);
        assert.equal(await answer().getByText(/正确选项/).count(), 0);
      }
      const question = current.questions[index];
      if (question.progress.submitted || question.progress.skipped || question.progress.revealed) continue;
      if (mode === 'practice' && index === 0 && !question.progress.hinted) await actResponse('/quiz', 'PATCH', () => answer().getByRole('button', { name: '提示', exact: true }).click());
      if (index === 0) {
        if (!question.progress.optionId) {
          // Quiz radios are controlled by the saved API response. Playwright's
          // check() expects an immediate local toggle, before that response.
          const choice = answer().getByRole('radio').first();
          await actResponse('/quiz', 'PATCH', () => choice.click());
          await expect(choice).toBeChecked();
        } else await expect(answer().locator(`input[value="${question.progress.optionId}"]`)).toBeChecked();
        if (mode === 'practice') {
          await actResponse('/quiz', 'PATCH', () => answer().getByRole('button', { name: '确认答案', exact: true }).click());
          await expect(answer().getByRole('heading', { name: /正确选项/ })).toBeVisible();
          await answer().getByLabel('解析引用', { exact: true }).locator('summary').click();
          await answer().getByRole('button', { name: /^原材料 · 第 / }).first().click(); await closeSource();
        }
      } else await actResponse('/quiz', 'PATCH', () => answer().getByRole('button', { name: mode === 'practice' ? '看答案' : '跳过本题', exact: true }).click());
      current = await attempt(record.attemptId);
    }
    if (!current.completed) await actResponse('/quiz', 'PATCH', () => answer().getByRole('button', { name: '交卷并查看结果', exact: true }).click());
    current = await attempt(record.attemptId); assert.equal(current.completed, true); assert.equal(current.score.total, 2);
    if (mode === 'practice') { assert.equal(current.score.hinted, 1); assert.equal(current.score.revealed, 1); }
    else assert.equal(current.score.skipped, 1);
    record.completed = true; record.score = current.score; persist();
    await page.goto(url('view=quiz&attempt=' + record.attemptId));
    await expect(quiz().getByLabel('本次结果', { exact: true })).toBeVisible();
    const beforeHistory = calls();
    await quiz().getByRole('button', { name: '题组与历史', exact: true }).click();
    const runs = (await data('/quiz')).quizzes, row = quiz().getByRole('listitem').nth(runs.findIndex(item => item.id === record.quizId));
    await row.getByRole('button', { name: '续做 / 查看记录', exact: true }).click();
    await expect(quiz().getByLabel('本次结果', { exact: true })).toBeVisible();
    assert.equal(calls(), beforeHistory, 'quiz_history_must_not_generate');
    assert.equal((await attempt(record.attemptId)).completed, true);
  };
  await step('independent_quiz_practice_and_sources', () => quizRound('practice'));
  await step('independent_quiz_test_answers_hidden_and_history', () => quizRound('test'));
  await step('scoped_deletions_preserve_other_learning', async () => {
    const beforeNote = await nodeData();
    await page.goto(url('view=quiz')); await quiz().getByRole('button', { name: '题组与历史', exact: true }).click();
    let runs = (await data('/quiz')).quizzes;
    if (runs.some(item => item.id === saved.practice.quizId)) {
      const row = quiz().getByRole('listitem').nth(runs.findIndex(item => item.id === saved.practice.quizId));
      await row.getByRole('button', { name: /^删除题组 / }).click();
      let dialog = page.getByRole('dialog', { name: /^删除「/ });
      await expect(dialog.getByText(/全部作答记录/)).toBeVisible(); await dialog.getByRole('button', { name: '取消', exact: true }).click();
      assert((await data('/quiz')).quizzes.some(item => item.id === saved.practice.quizId));
      await row.getByRole('button', { name: /^删除题组 / }).click(); dialog = page.getByRole('dialog', { name: /^删除「/ });
      await actResponse('/quiz', 'DELETE', () => dialog.getByRole('button', { name: '删除题组与记录', exact: true }).click());
    }
    runs = (await data('/quiz')).quizzes; assert(!runs.some(item => item.id === saved.practice.quizId)); assert(runs.some(item => item.id === saved.test.quizId));
    const deleted = await api('/quiz?attempt=' + saved.practice.attemptId); assert([404, 410].includes(deleted.status));
    assert.equal((await attempt(saved.test.attemptId)).completed, true);
    await nav().getByRole('button', { name: '材料', exact: true }).click();
    if ((await pageData()).materials.some(item => item.id === saved.extraMaterialId)) {
      await page.getByRole('button', { name: '删除材料 ' + extraTitle, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '删除「' + extraTitle + '」？', exact: true });
      await actResponse('/materials/' + saved.extraMaterialId, 'DELETE', () => dialog.getByRole('button', { name: '删除这份材料', exact: true }).click());
    }
    assert(!(await pageData()).materials.some(item => item.id === saved.extraMaterialId));
    assert((await pageData()).materials.some(item => item.id === account.materialId));
    assert.deepEqual(await nodeData(), beforeNote);
  });
  assert.deepEqual((await data('/agent')).tasks, [], 'manual_learning_must_not_create_agent_tasks');
  saved.completed = true; saved.finalCalls = calls(); persist();
  save('manual-learning-result.json', { status: 'PASS', evidence: 'offline_fixed_provider_actual_manual_learning_components_and_apis',
    pageId: account.pageId, account: 'M', steps: saved.steps, requests: saved.requests, simulatedStudent: true,
    simulatedProviderRequests: saved.finalCalls - saved.initialCalls, actualProviderNetworkRequests: 0,
    remainingQuizId: saved.test.quizId, remainingAttemptId: saved.test.attemptId, deletedQuizId: saved.practice.quizId,
    manualTurnId: saved.manualTurnId, agentTasks: 0 });
}
