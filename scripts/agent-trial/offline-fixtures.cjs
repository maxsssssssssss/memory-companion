// Explicit engineering fixtures. These deterministic choices are NOT evidence of
// model autonomy, generated-content quality, or a real Provider integration.
const assert = require('node:assert/strict');
const action = (tool, args = {}) => ({ tool, args, reason: '离线工程验收固定策略；依据当前真实业务返回执行。' });

function decision(payload) {
  assert(payload.observation && Array.isArray(payload.results) && Array.isArray(payload.tools), 'offline_decision_contract');
  const results = payload.results.filter(result => result.status === 'succeeded');
  const scope = results.find(result => result.tool === 'learning.read_scope');
  if (!scope) return action('learning.read_scope');
  const material = scope.value.materials?.[0];
  if (!material) return { wait: { kind: 'feedback', message: '离线验收：当前授权范围没有可用教材，请补充材料。' } };
  assert(material.title === '合成教材 · 集合、交集与并集', 'offline_synthetic_course_only');
  if (!results.some(result => result.tool === 'learning.read_navigation')) return action('learning.read_navigation');
  const source = paragraph => ({ materialId: material.materialId, paragraph });
  const quizIndex = results.findIndex(result => result.tool === 'learning.create_quiz');
  if (quizIndex < 0) {
    if (String(payload.goal).includes('我不理解')) {
      for (const paragraph of [3, 4]) if (!results.some(result => result.tool === 'learning.read_source' && result.value.paragraph?.number === paragraph))
        return action('learning.read_source', source(paragraph));
      if (!results.some(result => result.tool === 'learning.explain')) return action('learning.explain', {
        question: '请根据交集与并集定义，解释同时属于两个集合的元素是否属于并集。', sources: [source(3), source(4)],
      });
      if (payload.feedback?.kind !== 'feedback') return action('learning.request_feedback', { question: '离线固定策略：已保存原文解释；是否进行一组练习？' });
    }
    return action('learning.create_quiz', { count: 2, difficulty: 'basic' });
  }
  const quiz = results[quizIndex].value;
  assert(quiz.quizId && quiz.attemptId, 'offline_requires_actual_quiz_receipt');
  if (!quiz.submitted) return { wait: { kind: 'feedback', message: '请先完成已有题组。离线策略不伪造作答。' } };
  const afterQuiz = results.slice(quizIndex + 1), answers = afterQuiz.find(result => result.tool === 'learning.read_answers');
  if (!answers) return action('learning.read_answers', { attemptId: quiz.attemptId });
  assert(answers.value.attemptId === quiz.attemptId && answers.value.score, 'offline_requires_actual_saved_score');
  const score = answers.value.score;
  if (payload.feedback?.kind === 'feedback') return { finish: '离线工程检查已读回本次反馈，交回用户；不代表长期掌握或真实模型验收。' };
  // This is intentionally a fixed TEST strategy. The branch is driven by the
  // score actually returned by the business tool, never by the account or goal.
  if (score.correct < score.total) {
    if (!afterQuiz.some(result => result.tool === 'learning.read_source')) return action('learning.read_source', source(6));
    if (!afterQuiz.some(result => result.tool === 'learning.explain')) return action('learning.explain', {
      question: '请用指定原文解释空交集并不代表两个集合本身为空。', sources: [source(6)],
    });
    return action('learning.request_feedback', { question: '离线固定策略：实际作答有错题，已回源并保存解释。请说明仍不理解的部分。' });
  }
  return action('learning.request_feedback', { question: '离线固定策略：本次保存作答全部正确。是否结束本轮？这不代表长期掌握。' });
}

function quiz(payload) {
  const paragraphs = payload.materials?.flatMap(material => material.paragraphs) ?? [];
  const ref = text => {
    const paragraph = paragraphs.find(paragraph => paragraph.text.includes(text));
    assert(paragraph?.referenceId, 'offline_fixture_source_missing');
    return paragraph.referenceId;
  };
  const intersection = ref('交集 A∩B 包含同时属于 A 和 B 的元素。');
  const union = ref('并集 A∪B 包含属于 A 或属于 B 的元素');
  const option = (id, text, reason, evidenceIds) => ({ id, text, reasonParts: [{ text: reason, evidenceIds }] });
  const items = [
    { focus: '交集要求共同归属', scenario: null, stem: '【离线合成题】教材中的 A={1,2,3}、B={3,4}，A∩B 是哪个集合？', kind: 'concept', stemEvidenceIds: [intersection],
      options: [option('A', '{3}', '元素 3 同时属于两个集合，因此交集只包含 3。', [intersection]), option('B', '{1,2,3,4}', '这包含只属于其中一个集合的元素，不符合交集的共同归属条件。', [intersection, union]), option('C', '∅', '两个集合有共同元素 3，因此交集不是空集。', [intersection])], correctOptionId: 'A' },
    { focus: '并集包含共同元素且不重复', scenario: null, stem: '【离线合成题】教材中的 A={1,2,3}、B={3,4}，A∪B 是哪个集合？', kind: 'relationship', stemEvidenceIds: [union],
      options: [option('A', '{1,2,3,4}', '并集包含至少属于一个集合的元素，共同元素 3 也在其中且只计一次。', [union]), option('B', '{3}', '这只保留共同元素，漏掉并集中的 1、2、4。', [intersection, union]), option('C', '{1,2,4}', '并集允许同时属于两个集合的元素，因此不能排除共同元素 3。', [union])], correctOptionId: 'A' },
  ];
  const count = payload.taskContext?.count ?? payload.count;
  assert(Number.isInteger(count) && count > 0 && count <= 2, 'offline_fixture_two_questions_only');
  assert(payload.taskContext?.referenceScope, 'offline_reference_scope_required');
  return { contractVersion: 'references-v2', referenceScope: payload.taskContext.referenceScope,
    title: '【离线合成题组】交集与并集', reason: '手工固定题目用于工程验证，不是模型生成质量证据。',
    materialPlan: [{ material: 1, contribution: '手工固定的交集与并集两个考点。', references: [intersection, union] }], items: items.slice(0, count) };
}

function explanation(payload) {
  assert(payload.materials?.length && payload.materials.every(material => typeof material.text === 'string'), 'offline_explanation_sources_required');
  return { materialAnswer: '【离线固定解释，非模型生成】\n' + payload.materials.map(material => material.text).join('\n'), supplements: [],
    items: payload.materials.map(material => ({ materialId: material.materialId, paragraph: material.paragraph })) };
}

function respond(payload) {
  if (payload.tools && payload.observation && payload.results) return { kind: 'decision_fixture', value: decision(payload) };
  if (payload.taskContext?.count || payload.count) return { kind: 'quiz_generation_fixture', value: quiz(payload) };
  if (payload.question && Array.isArray(payload.materials)) return { kind: 'explanation_generation_fixture', value: explanation(payload) };
  throw Error('offline_unexpected_provider_request_no_network_fallback');
}
module.exports = { decision, quiz, explanation, respond };
