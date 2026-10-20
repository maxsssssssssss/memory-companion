// Explicit synthetic browser acceptance only. A page-scoped control file selects
// faults; the user's ordinary goal is never replaced with an engineering marker.
// These choices test the real product contracts, not DS intent understanding.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { quiz: baselineQuiz, explanation } = require('./offline-fixtures.cjs');

const modes = ['partial', 'all_failed', 'repeat_explanation', 'multi_round'];
const action = (tool, args = {}) => ({ tool, args, reason: '离线验收受控选择，读取正式业务结果后推进；不代表真实模型质量。' });

function readControl(root) {
  const file = path.join(root, 'offline-natural-quiz.json');
  if (!fs.existsSync(file)) return null;
  const control = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert(control.version === 1 && Array.isArray(control.cases), 'natural_quiz_fixture_control_invalid');
  assert(control.cases.every(item => typeof item.pageId === 'string' && typeof item.materialId === 'string' && modes.includes(item.mode)), 'natural_quiz_fixture_case_invalid');
  assert(new Set(control.cases.map(item => item.pageId)).size === control.cases.length, 'natural_quiz_fixture_duplicate_page');
  return control;
}

function configuredCase(root, payload) {
  const control = readControl(root);
  if (!control) return null;
  if (payload.tools) return control.cases.find(item => item.pageId === payload.authorizedScope?.pageId) ?? null;
  const materialIds = new Set((payload.taskContext?.reviewContext?.objectives ?? []).flatMap(objective => objective.sources.map(source => source.materialId))
    .concat((payload.materials ?? []).map(material => material.materialId)).filter(Boolean));
  return control.cases.find(item => materialIds.size > 0 && materialIds.size === 1 && materialIds.has(item.materialId)) ?? null;
}

function decision(payload, mode) {
  assert(modes.includes(mode) && payload.observation?.completion && Array.isArray(payload.results), 'natural_quiz_fixture_decision_contract');
  const completion = payload.observation.completion;
  const results = payload.results.filter(result => result.status === 'succeeded');
  const scope = results.find(result => result.tool === 'learning.read_scope')?.value;
  if (!scope) return action('learning.read_scope');
  const material = scope.materials?.[0];
  assert(material?.title === '合成教材 · 集合、交集与并集', 'natural_quiz_synthetic_material_required');
  const source = paragraph => ({ materialId: material.materialId, paragraph });
  const paragraphs = mode === 'repeat_explanation' ? [3] : [3, 4];
  for (const paragraph of paragraphs) if (!results.some(result => result.tool === 'learning.read_source' && result.value.paragraph?.number === paragraph))
    return action('learning.read_source', source(paragraph));
  if (mode === 'multi_round') return multiRoundDecision(payload, results, completion, source);
  if (!completion.plan) return action('learning.establish_review_plan', {
    kind: mode === 'repeat_explanation' ? 'explanation' : 'diagnosis',
    objectives: [{ id: 'intersection', label: '先观察交集的共同归属判断', sources: [source(3)],
      requirements: mode === 'repeat_explanation' ? [] : [{ role: 'concept', description: '依据交集定义判断两个集合的共同元素', independent: false }] }],
  });
  const purpose = { objectiveIds: ['intersection'], role: 'concept', method: 'retrieval',
    purpose: '先观察交集的共同归属判断，不把这一小项当成整个材料都已检查', priorEvidenceRefs: [] };
  const explain = () => action('learning.explain', { question: '根据交集原文说明同时属于两个集合是什么意思。', sources: [source(3)],
    purpose: { ...purpose, method: 'explain', purpose: '解释交集的共同归属条件，等待用户真实反馈' } });
  const explained = results.findLast(result => result.tool === 'learning.explain');
  if (mode === 'repeat_explanation') {
    // Deliberately reproduce a repeated model choice. Product progress guards
    // must retain the first feedback opportunity while blocking regeneration.
    if (!payload.feedback) return explain();
    return action('learning.request_feedback', { question: '请告诉我是否已经讲清，或指出仍需说明的部分。' });
  }
  const failedQuiz = payload.results.findLast(result => result.tool === 'learning.create_quiz' && result.status === 'failed');
  if (failedQuiz) {
    if (!explained) return explain();
    return action('learning.request_feedback', { question: '这次没有得到可靠题目。可以先看看交集讲解，再告诉我仍不清楚的地方。' });
  }
  const receipt = results.findLast(result => result.tool === 'learning.create_quiz')?.value;
  if (!receipt) return action('learning.create_quiz', { count: 3, difficulty: 'basic', purpose });
  assert(receipt.quizId && receipt.attemptId, 'natural_quiz_actual_receipt_required');
  if (!receipt.submitted) return { wait: { kind: 'feedback', message: '请先完成已保存的练习。' } };
  const answers = results.findLast(result => result.tool === 'learning.read_answers' && result.value.attemptId === receipt.attemptId)?.value;
  if (!answers) return action('learning.read_answers', { attemptId: receipt.attemptId });
  assert(answers.quizId === receipt.quizId && answers.questions?.length === 1 && answers.score, 'natural_quiz_actual_answers_required');
  const ref = { quizId: receipt.quizId, attemptId: receipt.attemptId, questionIndex: answers.questions[0].index };
  if (!completion.objectives?.some(objective => objective.evidence.some(evidence => evidence.ref.attemptId === ref.attemptId && evidence.ref.questionIndex === ref.questionIndex)))
    return action('learning.associate_evidence', { ref, objectiveId: 'intersection', role: 'concept', relevance: 'supported',
      rationale: '本题实际要求按交集定义判断共同元素；这是离线语义关联，成绩和辅助由正式服务重读。',
      relation: 'initial', priorEvidenceRefs: [], contentStatus: 'no_known_issue' });
  return { finish: '本轮仅诊断了共同元素判断；未检查部分仍保留，不据此声称全部知识或长期掌握。' };
}

function multiRoundDecision(payload, results, completion, source) {
  if (!completion.plan) return action('learning.establish_review_plan', {
    kind: 'targeted_review',
    objectives: [{ id: 'membership', label: '区分交集与并集的成员归属', sources: [source(3), source(4)],
      requirements: [{ role: 'followup', description: '针对混淆，后续独立判断共同元素及只属于一个集合的元素在交集、并集中的归属', independent: true }] }],
  });
  const purpose = { objectiveIds: ['membership'], role: 'followup', method: 'application',
    purpose: '先观察交集与并集的成员判断；初次观察不当作已纠正或完成复查', priorEvidenceRefs: [] };
  const receipts = results.filter(result => result.tool === 'learning.create_quiz').map(result => result.value);
  if (!receipts.length) return action('learning.create_quiz', { count: 1, difficulty: 'basic', purpose });
  const latest = receipts.at(-1);
  assert(latest.quizId && latest.attemptId, 'multiround_requires_actual_quiz');
  if (!latest.submitted) return { wait: { kind: 'feedback', message: '先完成已准备的这道练习。' } };
  const answers = results.findLast(result => result.tool === 'learning.read_answers' && result.value.attemptId === latest.attemptId)?.value;
  if (!answers) return action('learning.read_answers', { attemptId: latest.attemptId });
  assert(answers.score && answers.questions?.length === 1, 'multiround_requires_saved_actual_answer');
  const ref = { quizId: latest.quizId, attemptId: latest.attemptId, questionIndex: answers.questions[0].index };
  const initialAnswers = results.find(result => result.tool === 'learning.read_answers' && result.value.attemptId === receipts[0].attemptId)?.value;
  assert(initialAnswers?.questions?.length === 1 && initialAnswers.score, 'multiround_initial_answer_required');
  const initialRef = { quizId: receipts[0].quizId, attemptId: receipts[0].attemptId, questionIndex: initialAnswers.questions[0].index };
  const associated = completion.objectives?.some(objective => objective.id === 'membership' && objective.evidence.some(evidence => evidence.ref.attemptId === ref.attemptId && evidence.ref.questionIndex === ref.questionIndex));
  if (!associated) return action('learning.associate_evidence', { ref, objectiveId: 'membership', role: 'followup', relevance: 'supported',
    rationale: receipts.length === 1 ? '实际首题检查交集的共同归属条件，先保留这次观察与实际错误，不把首答冒充纠正。'
      : '后续题区分只属于一个集合与同时属于两个集合的元素，针对原题共同归属混淆提供相关新观察；不是已核验的迁移或长期掌握。',
    relation: receipts.length === 1 ? 'initial' : 'followup', priorEvidenceRefs: receipts.length === 1 ? [] : [initialRef], contentStatus: 'no_known_issue' });
  if (receipts.length > 1) return { finish: '本轮已读取两次实际作答并关联；仅按程序当前证据说明结果，不继续凑题或宣称长期掌握。' };
  // Genuine branch on the formal saved first answer, not the account name or a
  // fixture score. This acceptance simulates a wrong answer through the UI.
  if (initialAnswers.score.correct === initialAnswers.score.total)
    return action('learning.request_feedback', { question: '这次基础判断正确。你想进一步区分哪一种归属情形？' });
  if (!results.some(result => result.tool === 'learning.explain')) return action('learning.explain', {
    question: '刚才的实际交集判断有误。请结合交集与并集原文，区分同时属于两个集合与只属于一个集合的情形。',
    sources: [source(3), source(4)],
    purpose: { ...purpose, method: 'contrast', purpose: '依据刚才真实错答对比交集与并集条件，解释不当作已经纠正', priorEvidenceRefs: [initialRef] },
  });
  return action('learning.create_quiz', { count: 1, difficulty: 'basic',
    purpose: { ...purpose, purpose: '解释后用不同具体例子复查共同元素和单独元素的归属，不重复原题订正', priorEvidenceRefs: [initialRef] } });
}

function quiz(payload, mode) {
  if (mode === 'multi_round') {
    assert(payload.taskContext?.count === 1 && payload.taskContext.reviewContext, 'multiround_one_question_required');
    const base = baselineQuiz(payload);
    if (!payload.taskContext.reviewContext.purpose.priorEvidenceRefs.length) return base;
    const paragraphs = payload.materials.flatMap(material => material.paragraphs);
    const intersection = paragraphs.find(paragraph => paragraph.text.includes('交集 A∩B 包含同时属于 A 和 B 的元素。')).referenceId;
    const union = paragraphs.find(paragraph => paragraph.text.includes('并集 A∪B 包含属于 A 或属于 B 的元素')).referenceId;
    const option = (id, text, reason) => ({ id, text, reasonParts: [{ text: reason, evidenceIds: [intersection, union] }] });
    return { ...base, items: [{
      focus: '区分单独与共同归属', scenario: '假设一个新案例：P={2,5}，Q={5,8}。',
      stem: '关于元素2和元素5，哪一项符合交集与并集的归属条件？', kind: 'application', stemEvidenceIds: [intersection, union],
      options: [
        option('A', '元素2只属于并集；元素5同时属于交集和并集。', '元素2只属于P，满足并集而不满足交集；元素5同时属于P和Q，两种条件均满足。'),
        option('B', '元素2和元素5都属于交集。', '元素2不属于Q，不能满足交集要求的两个归属条件。'),
        option('C', '元素5只属于交集，不属于并集。', '并集的或允许同时属于两者，不能把共同元素5排除在并集之外。'),
      ], correctOptionId: 'A',
    }] };
  }
  assert(mode === 'partial' || mode === 'all_failed', 'natural_quiz_generation_mode_required');
  assert(payload.taskContext?.count === 3 && payload.taskContext.reviewContext, 'natural_quiz_three_candidates_required');
  const base = baselineQuiz({ ...payload, taskContext: { ...payload.taskContext, count: 2 } });
  const good = structuredClone(base.items[0]);
  const equivalent = structuredClone(base.items[1]);
  equivalent.options[1].text = '{1,2,3,3,4}';
  equivalent.options[1].reasonParts = structuredClone(equivalent.options[0].reasonParts);
  const positional = structuredClone(base.items[0]);
  positional.stem += ' 正确答案是第3项。';
  // Omit optional reviewCheck deliberately: a usable question must not receive
  // invented goal coverage. The next real action reads and associates its score.
  return { ...base, title: '【离线受控发布验收】交集与并集',
    items: mode === 'partial' ? [equivalent, good, positional] : [equivalent, positional, structuredClone(equivalent)] };
}

function respond(payload, mode) {
  if (payload.tools && payload.observation && payload.results) return { kind: 'decision_fixture', value: decision(payload, mode) };
  if (payload.taskContext?.reviewContext) return { kind: 'quiz_generation_fixture', value: quiz(payload, mode) };
  if (payload.question && Array.isArray(payload.materials)) return { kind: 'explanation_generation_fixture', value: explanation(payload) };
  throw Error('natural_quiz_fixture_unexpected_request');
}

module.exports = { configuredCase, decision, quiz, respond };
