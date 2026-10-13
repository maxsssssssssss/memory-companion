// A2 acceptance-only deterministic policy. Never loaded by product code.
const assert = require('node:assert/strict');
const { decision: baseline } = require('./offline-fixtures.cjs');
const action = (tool, args = {}) => ({ tool, args, reason: 'A2离线工程验收固定策略，使用本轮实际业务结果。' });
function decision(payload) {
  const marker = /^\[A2:([a-z_-]+)\]/.exec(payload.goal ?? '')?.[1];
  if (!marker) return baseline(payload);
  const rejectedNote = payload.results.find(result => result.tool === 'learning.append_note' && result.status === 'failed');
  if (marker === 'note' && rejectedNote)
    return { wait: { kind: 'feedback', message: '离线策略已读到笔记提案未执行；不再重复提案，等待用户选择。' } };
  if (payload.results.some(result => result.tool === 'learning.explain' && result.status === 'failed'))
    return { wait: { kind: 'feedback', message: '离线策略已读到解释明确失败；等待用户检查原操作并明确决定是否重试。' } };
  const results = payload.results.filter(result => result.status === 'succeeded');
  const scope = results.find(result => result.tool === 'learning.read_scope');
  if (!scope) return action('learning.read_scope');
  const material = scope.value.materials?.[0];
  assert(material?.title === '合成教材 · 集合、交集与并集', 'a2_offline_synthetic_material_required');
  const navigation = results.find(result => result.tool === 'learning.read_navigation');
  if (!navigation) return action('learning.read_navigation');
  if (marker === 'no_progress') return action('learning.read_source', { materialId: material.materialId, paragraph: material.paragraphs[0] });
  if (marker === 'budget') {
    const reads = results.filter(result => result.tool === 'learning.read_source').length;
    return action('learning.read_source', { materialId: material.materialId, paragraph: material.paragraphs[reads % material.paragraphs.length] });
  }
  if (marker === 'quiz_receipt') {
    const quiz = results.find(result => result.tool === 'learning.create_quiz');
    return quiz ? { wait: { kind: 'feedback', message: '离线验收已读回原有题组回执，不再创建题组。' } } : action('learning.create_quiz', { count: 2, difficulty: 'basic' });
  }
  const paragraph = material.paragraphs.includes(3) ? 3 : material.paragraphs[0];
  if (!results.some(result => result.tool === 'learning.read_source')) return action('learning.read_source', { materialId: material.materialId, paragraph });
  const explanation = results.find(result => result.tool === 'learning.explain');
  if (!explanation) return action('learning.explain', {
    question: '请根据当前明确授权的原文解释这个学习概念。', sources: [{ materialId: material.materialId, paragraph }],
  });
  if (marker === 'note') {
    const note = results.find(result => result.tool === 'learning.append_note');
    if (note) return { finish: '离线验收已读回用户批准后的笔记追加结果，交回用户。' };
    const target = navigation.value.chapters?.flatMap(chapter => chapter.nodes.map(node => ({ chapter, node }))).find(({ node }) =>
      explanation.value.items.every(ref => node.sources.some(source => source.materialId === ref.materialId && source.paragraph === ref.paragraph)));
    assert(target && explanation.value.id, 'a2_offline_note_target_required');
    return action('learning.append_note', { explanationId: explanation.value.id, chapterId: target.chapter.id, nodeId: target.node.id });
  }
  return action('learning.request_feedback', { question: 'A2离线策略已按当前版本范围保存解释，请查看或调整本轮复习。' });
}
module.exports = { decision };
