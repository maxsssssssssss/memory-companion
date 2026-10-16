// V1.1 controlled engineering responses. These are deliberately small fixture
// policies, not evidence of autonomous model choices or teaching effectiveness.
// No expected score or browser-student answer key enters the decision payload.
const assert = require('node:assert/strict');
const { quiz: baselineQuiz } = require('./offline-fixtures.cjs');
const action = (tool, args = {}) => ({ tool, args, reason: 'V1.1离线固定策略，依据当前真实业务返回验证目标与证据机制。' });
const marker = payload => /^\[V1\.1:(explanation|check)\]/.exec(payload.goal ?? '')?.[1];
const applies = payload => Boolean(marker(payload) || payload.observation?.completion && payload.observation.completion.outcome !== 'legacy');

function decision(payload) {
  const mode = marker(payload) ?? (/我不理解|解释|不懂|疑问/.test(payload.goal ?? '') ? 'explanation' : 'check');
  assert(applies(payload) && payload.observation?.completion && Array.isArray(payload.results), 'completion_fixture_contract_required');
  const completion = payload.observation.completion;
  const results = payload.results.filter(result => result.status === 'succeeded');
  const failed = payload.results.findLast(result => result.status === 'failed');
  if (failed) return { wait: { kind: 'feedback', message: '离线验收已读到明确失败，保留原操作并交回，不自动重试。' } };
  const scope = results.find(result => result.tool === 'learning.read_scope');
  if (!scope) return action('learning.read_scope');
  const material = scope.value.materials?.[0];
  if (!material) return { wait: { kind: 'feedback', message: '当前授权材料为空，请明确选择材料。' } };
  assert(material.title === '合成教材 · 集合、交集与并集', 'completion_fixture_synthetic_material_required');
  const paragraphs = mode === 'explanation' ? [3] : [3, 4];
  assert(paragraphs.every(paragraph => material.paragraphs.includes(paragraph)), 'completion_fixture_source_required');
  const source = paragraph => ({ materialId: material.materialId, paragraph });
  for (const paragraph of paragraphs) if (!results.some(result => result.tool === 'learning.read_source' && result.value.paragraph?.number === paragraph))
    return action('learning.read_source', source(paragraph));
  if (!completion.plan) return action('learning.establish_review_plan', {
    kind: mode === 'explanation' ? 'explanation' : 'chapter_check',
    objectives: paragraphs.map(paragraph => ({ id: paragraph === 3 ? 'intersection' : 'union', label: paragraph === 3 ? '交集的共同归属条件' : '并集的至少一个归属条件',
      sources: [source(paragraph)], requirements: mode === 'explanation' ? [] : [{ role: 'concept', description: paragraph === 3 ? '依据定义判断共同元素组成的交集' : '依据定义判断至少属于一个集合的并集', independent: true }] })),
  });
  const purpose = { objectiveIds: completion.plan.objectives.map(objective => objective.id), role: 'concept',
    method: mode === 'explanation' ? 'explain' : 'retrieval', purpose: mode === 'explanation' ? '解释当前明确疑问，等待用户确认是否解决' : '检查本轮约定的交集和并集两个归属判断', priorEvidenceRefs: [] };
  if (mode === 'explanation') {
    if (!results.some(result => result.tool === 'learning.explain')) return action('learning.explain', {
      question: '请根据已授权的交集定义解释共同归属条件，不安排考试。', sources: [source(3)], purpose,
    });
    // A generic thanks, a reload or silence is never a resolved signal here.
    return action('learning.request_feedback', { question: '请阅读讲解，并明确选择“疑问已解决”或“仍需说明”。' });
  }
  const receipt = results.findLast(result => result.tool === 'learning.create_quiz')?.value;
  if (!receipt) return action('learning.create_quiz', { count: 2, difficulty: 'basic', purpose });
  assert(receipt.quizId && receipt.attemptId, 'completion_fixture_actual_quiz_receipt_required');
  if (!receipt.submitted) return { wait: { kind: 'feedback', message: '请先提交本轮题组，离线策略不伪造作答。' } };
  const answers = results.findLast(result => result.tool === 'learning.read_answers' && result.value.attemptId === receipt.attemptId)?.value;
  if (!answers) return action('learning.read_answers', { attemptId: receipt.attemptId });
  assert(answers.quizId === receipt.quizId && Array.isArray(answers.questions) && answers.score, 'completion_fixture_saved_answers_required');
  for (const question of answers.questions) {
    const objectiveId = question.stem.includes('A∩B') ? 'intersection' : question.stem.includes('A∪B') ? 'union' : null;
    assert(objectiveId && completion.plan.objectives.some(objective => objective.id === objectiveId), 'completion_fixture_question_mapping_required');
    const ref = { quizId: receipt.quizId, attemptId: receipt.attemptId, questionIndex: question.index };
    const associated = completion.objectives?.some(objective => objective.id === objectiveId && objective.evidence.some(evidence => evidence.ref.attemptId === ref.attemptId && evidence.ref.questionIndex === ref.questionIndex));
    if (!associated) return action('learning.associate_evidence', { ref, objectiveId, role: 'concept',
      rationale: '固定合成题要求根据已授权定义判断对应集合运算，关联是离线语义提案，实际作答由业务服务重读。',
      relevance: 'supported', relation: 'initial', priorEvidenceRefs: [], contentStatus: 'no_known_issue' });
  }
  // Failure to satisfy the requirements must not cause unbounded generation.
  // Successful completion is intercepted by the product's zero-call gate.
  return { finish: '离线工程轨迹已关联实际作答；如证据不足则诚实交回，不增加题组或声称掌握。' };
}

function quiz(payload) {
  const context = payload.taskContext?.reviewContext;
  assert(context?.planId && context.purpose?.role === 'concept', 'completion_fixture_generation_purpose_required');
  const result = baselineQuiz(payload);
  return { ...result, items: result.items.map(item => {
    const objectiveId = item.stem.includes('A∩B') ? 'intersection' : 'union';
    assert(context.purpose.objectiveIds.includes(objectiveId), 'completion_fixture_generation_objective_required');
    return { ...item, reviewCheck: { objectiveIds: [objectiveId], role: context.purpose.role,
      rationale: '固定合成题分别检查交集与并集的归属条件；关联不代表已核验或已通过。' } };
  }) };
}

module.exports = { marker, applies, decision, quiz };
