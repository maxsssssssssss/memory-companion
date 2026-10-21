// Explicit synthetic browser acceptance only. A page-scoped control file selects
// faults; the user's ordinary goal is never replaced with an engineering marker.
// These choices test the real product contracts, not DS intent understanding.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { explanation } = require('./offline-fixtures.cjs');

const modes = ['partial', 'all_failed', 'repeat_explanation', 'multi_round', 'source_contract', 'diagnostic_rounds'];
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
  const paragraphs = mode === 'repeat_explanation' ? [3] : mode === 'source_contract' ? [2, 3, 4] : [3, 4];
  for (const paragraph of paragraphs) if (!results.some(result => result.tool === 'learning.read_source' && result.value.paragraph?.number === paragraph))
    return action('learning.read_source', source(paragraph));
  if (['multi_round', 'diagnostic_rounds'].includes(mode)) return multiRoundDecision(payload, results, completion, source, mode);
  if (!completion.plan) return action('learning.establish_review_plan', {
    kind: mode === 'repeat_explanation' ? 'explanation' : 'diagnosis',
    objectives: [{ id: 'intersection', label: '先观察交集的共同归属判断', sources: mode === 'source_contract' ? [source(2), source(3), source(4)] : [source(3)],
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
  if (!receipt) return action('learning.create_quiz', { count: mode === 'source_contract' ? 2 : 3, difficulty: 'basic', purpose });
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

function multiRoundDecision(payload, results, completion, source, mode) {
  const diagnosis = mode === 'diagnostic_rounds';
  const initialRole = diagnosis ? 'concept' : 'followup';
  if (!completion.plan) return action('learning.establish_review_plan', {
    kind: diagnosis ? 'diagnosis' : 'targeted_review',
    objectives: [{ id: 'membership', label: '区分交集与并集的成员归属', sources: [source(3), source(4)],
      requirements: [
        { role: initialRole, description: diagnosis ? '先观察是否按交集定义判断共同元素' : '针对混淆，后续独立判断共同元素及只属于一个集合的元素在交集、并集中的归属', independent: !diagnosis },
        { role: 'boundary', description: '判断只属于一个集合的元素能否进入交集、并集，区分条件边界', independent: true },
      ] }],
  });
  const purpose = { objectiveIds: ['membership'], role: initialRole, method: 'application',
    purpose: '先观察交集与并集的成员判断；初次观察不当作已纠正或完成复查', priorEvidenceRefs: [] };
  const receipts = results.filter(result => result.tool === 'learning.create_quiz').map(result => result.value);
  if (!receipts.length) return action('learning.create_quiz', { count: diagnosis ? 2 : 1, difficulty: 'basic', purpose });
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
  // The production evidence artifact is returned by the actual tool, not by a fixture score.
  const recorded = completion.objectives?.some(objective => objective.id === 'membership' && objective.evidence.some(evidence => evidence.ref.attemptId === ref.attemptId && evidence.ref.questionIndex === ref.questionIndex));
  const associationAction = results.filter(result => result.tool === 'learning.associate_evidence').length >= receipts.length;
  if (!(recorded && associationAction)) return action('learning.associate_evidence', { ref, objectiveId: 'membership', role: receipts.length === 1 ? initialRole : 'boundary', relevance: 'supported',
    rationale: receipts.length === 1 ? '实际首题检查交集的共同归属条件，先保留这次观察与实际错误，不把首答冒充纠正。'
      : '后续题区分只属于一个集合与同时属于两个集合的元素，针对原题共同归属混淆提供相关新观察；不是已核验的迁移或长期掌握。',
    relation: 'initial', priorEvidenceRefs: [], contentStatus: 'no_known_issue' });
  if (receipts.length > 1) return { finish: diagnosis ? '约定的共同元素与条件边界诊断均已获得实际观察；原错答保留，诊断完成不等于已经学会。' : '本轮已读取两次实际作答。后题提供边界判断线索，但原followup要求仍缺对应后续证据，先诚实交回；不能把本题重复贴成另一角色来宣称通过。' };
  // Genuine branch on the formal saved first answer, not the account name or a
  // fixture score. This acceptance simulates a wrong answer through the UI.
  if (initialAnswers.score.correct === initialAnswers.score.total)
    return action('learning.request_feedback', { question: '这次基础判断正确。你想进一步区分哪一种归属情形？' });
  if (!results.some(result => result.tool === 'learning.explain')) return action('learning.explain', {
    question: '刚才的实际交集判断有误。请结合交集与并集原文，区分同时属于两个集合与只属于一个集合的情形。',
    sources: [source(3), source(4)],
    purpose: { ...purpose, method: 'contrast', purpose: '依据刚才真实错答对比交集与并集条件，解释不当作已经纠正', priorEvidenceRefs: [initialRef] },
  });
  if (payload.feedback?.kind !== 'feedback') return action('learning.request_feedback', { question: '这次说明是否有帮助？你可以告诉我仍不清楚的地方，或者再试一道条件边界题。' });
  return action('learning.create_quiz', { count: 1, difficulty: 'basic',
    purpose: { ...purpose, role: 'boundary', method: 'boundary', purpose: '解释后用不同具体例子检查只属于一方时交集与并集的条件边界，不重复原题订正', priorEvidenceRefs: [initialRef] } });
}

function quiz(payload, mode) {
  const context = payload.taskContext?.reviewContext;
  assert(context && payload.materials?.length, 'natural_quiz_review_context_required');
  const paragraphs = payload.materials.flatMap(material => material.paragraphs);
  const intersection = paragraphs.find(paragraph => paragraph.text.includes('交集 A∩B 包含同时属于 A 和 B 的元素。'))?.referenceId;
  assert(intersection, 'natural_quiz_authorized_intersection_required');
  const annotation = rationale => ({ objectiveIds: [...context.purpose.objectiveIds], role: context.purpose.role, rationale });
  const option = (id, text, reason, evidenceIds = [intersection]) => ({ id, text, reasonParts: [{ text: reason, evidenceIds }] });
  const good = { focus: '交集要求共同归属', scenario: null,
    stem: '【离线合成题】教材中的 A={1,2,3}、B={3,4}，A∩B 是哪个集合？', kind: 'concept', stemEvidenceIds: [intersection],
    options: [option('A', '{3}', '元素3同时属于两个集合，因此交集只包含3。'),
      option('B', '{1,2,3,4}', '这包含只属于其中一个集合的元素，不符合交集的共同归属条件。'),
      option('C', '∅', '两个集合有共同元素3，因此交集不是空集。')], correctOptionId: 'A',
    reviewCheck: annotation('题目实际要求按交集定义判断共同元素；关联是离线语义提案，不是 verified。') };
  const base = { contractVersion: 'references-v2', title: '【离线受控发布验收】交集与并集',
    reason: '手工固定题目用于工程验证，不是模型生成质量证据。',
    materialPlan: [{ material: 1, contribution: '按本次固定目标检查共同归属。', references: [intersection] }] };
  if (['multi_round', 'diagnostic_rounds'].includes(mode)) {
    const first = !context.purpose.priorEvidenceRefs.length;
    assert(payload.taskContext.count === (mode === 'diagnostic_rounds' && first ? 2 : 1), 'multiround_question_count_required');
    if (first) {
      if (mode !== 'diagnostic_rounds') return { ...base, items: [good] };
      // Separate frozen synthetic near-neighbors, not edits to the seven retained Windows candidates.
      good.options[0].reasonParts[0].text = 'A和B都包含3，其他元素没有共同归属，因此交集只有3。';
      const equivalent = { ...structuredClone(good), focus: '颜色集合的共同元素',
        scenario: '假设P={红,蓝}，Q={红,蓝,绿}。', stem: '按共同归属条件，P∩Q 是哪个集合？',
        options: [option('A', '{红,蓝}', '红和蓝同时属于两个集合，交集为这两个元素。'),
          option('B', '{蓝,红,蓝}', '蓝被重复列出，因此不作为本题答案。'),
          option('C', '{绿}', '绿只属于Q，不是共同元素。')], correctOptionId: 'A' };
      return { ...base, items: [good, equivalent] };
    }
    const union = paragraphs.find(paragraph => paragraph.text.includes('并集 A∪B 包含属于 A 或属于 B 的元素'))?.referenceId;
    assert(union && context.purpose.role === 'boundary', 'multiround_authorized_boundary_required');
    const both = (id, text, reason) => option(id, text, reason, [intersection, union]);
    return { ...base, items: [{
      focus: '区分单独与共同归属的条件边界', scenario: '假设一个新案例：P={2,5}，Q={5,8}。',
      stem: '关于元素2和元素5，哪一项符合交集与并集的归属条件？', kind: 'application', stemEvidenceIds: [intersection, union],
      options: [
        both('A', '元素2只属于并集；元素5同时属于交集和并集。', '元素2只属于P，满足并集而不满足交集；元素5同时属于P和Q，两种条件均满足。'),
        both('B', '元素2和元素5都属于交集。', '元素2不属于Q，不能满足交集要求的两个归属条件。'),
        both('C', '元素5只属于交集，不属于并集。', '并集的或允许同时属于两者，不能把共同元素5排除在并集之外。'),
      ], correctOptionId: 'A',
      reviewCheck: annotation('具体判断只属于一个集合时交集条件不满足、并集条件满足的边界；不自动补记其他角色要求。'),
    }] };
  }
  assert(['partial', 'all_failed', 'source_contract'].includes(mode), 'natural_quiz_generation_mode_required');
  assert(payload.taskContext.count === (mode === 'source_contract' ? 2 : 3), 'natural_quiz_candidate_count_required');
  const equivalent = structuredClone(good);
  equivalent.focus = '空交集示例';
  equivalent.scenario = '假设C={6,7}，D={8,9}。';
  equivalent.stem = '依据共同归属条件，C∩D 是哪个集合？';
  equivalent.options = [option('A', '∅', '两个集合没有共同元素，交集为空。'),
    option('B', '{}', '两个集合没有共同元素，交集为空。'), option('C', '{6,7,8,9}', '这些元素都不同时属于两个集合。')];
  const positional = structuredClone(good);
  positional.stem += ' 正确答案是第3项。';
  return { ...base, items: mode === 'source_contract' ? [good, positional] : mode === 'partial' ? [equivalent, good, positional] : [equivalent, positional, structuredClone(equivalent)] };
}

function respond(payload, mode) {
  if (payload.tools && payload.observation && payload.results) return { kind: 'decision_fixture', value: decision(payload, mode) };
  if (payload.taskContext?.reviewContext) return { kind: 'quiz_generation_fixture', value: quiz(payload, mode) };
  if (payload.question && Array.isArray(payload.materials)) return { kind: 'explanation_generation_fixture', value: explanation(payload) };
  throw Error('natural_quiz_fixture_unexpected_request');
}

module.exports = { configuredCase, decision, quiz, respond };
