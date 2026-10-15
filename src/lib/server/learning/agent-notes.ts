import { z } from "zod";
import { LearningId } from "@/lib/domain/learning";
import type { LearningAgentExplanation, LearningAgentNotePreview } from "@/lib/domain/learning-agent";
import type { AgentTask } from "@/lib/domain/agent";
import { AgentFailure, type AgentContext, type AgentTool } from "@/lib/server/agent/types";
import { LearningError, type LearningRepository } from "./repository";
import { LearningFrameworkRepository, frameworkHash } from "./framework-repository";
import { LearningStudyRepository } from "./study-repository";
import { LearningAgentRepository, learningAgentOperationId } from "./agent-repository";
import { freezeLearningAgentScope, readLearningAgentScope } from "./agent-scope";

export const AppendLearningAgentNote = z.object({ explanationId: LearningId, chapterId: LearningId, nodeId: LearningId }).strict();
type TaskIdentity = Pick<AgentTask, "id" | "accountId" | "resourceId" | "scope"> & { version?: number };
type NoteBody = { preview: LearningAgentNotePreview; written?: { nodeId: string; chapterId: string; revision: number; contentHash: string; noteHash: string; sourceFingerprint: string } };
const taskVersion = (task: TaskIdentity) => task.version ?? 1;

function currentTarget(learning: LearningRepository, task: TaskIdentity, chapterId: string, nodeId: string, existingPreview = false) {
  if (task.accountId !== learning.accountId) throw new AgentFailure("forbidden", "agent_account_forbidden");
  const scope = readLearningAgentScope(learning, task.resourceId, task.scope);
  const framework = new LearningFrameworkRepository(learning), chapter = framework.view(task.resourceId).chapters.find(c => c.id === chapterId), node = chapter?.nodes.find(n => n.id === nodeId);
  if (!chapter || !node) {
    if (existingPreview) throw new AgentFailure("source_changed", "agent_note_target_changed");
    throw new AgentFailure("known_failure", "agent_note_target_invalid", undefined,
      "agent_note_target_invalid：笔记目标地址无效，尚未创建提案或写入笔记。请调用 learning.read_navigation 获取当前授权范围内真实的 chapterId/nodeId；不能把材料 ID 当作章节或知识点 ID。无可靠目标时请等待用户选择或取消。");
  }
  if (!scope.navigation.some(chapter => chapter.id === chapterId && chapter.nodes.some(node => node.id === nodeId))) throw new AgentFailure("forbidden", "agent_note_target_forbidden");
  for (const index of node.sources.keys()) framework.source(task.resourceId, chapterId, nodeId, index);
  return { scope, chapter, node };
}

function previewRow(learning: LearningRepository, task: TaskIdentity, proposalId: string) {
  if (task.accountId !== learning.accountId) throw new AgentFailure("forbidden", "agent_account_forbidden");
  const row = new LearningAgentRepository(learning).get(task.resourceId, task.id, proposalId);
  if (!row || row.kind !== "note_proposal" || row.task_version !== taskVersion(task) || !row.body_json || !["reserved", "completed"].includes(row.state)) throw new AgentFailure("forbidden", "agent_note_preview_unavailable");
  return { row, body: JSON.parse(row.body_json) as NoteBody };
}

/** Full confirmation snapshot for the authenticated task UI. It does not include
 * the existing private note; read permission never becomes write permission. */
export function readLearningAgentNotePreview(learning: LearningRepository, task: TaskIdentity, proposalId: string) {
  const { body } = previewRow(learning, task, proposalId), preview = body.preview;
  const current = currentTarget(learning, task, preview.chapterId, preview.nodeId, true);
  if (!body.written && (current.chapter.revision !== preview.targetRevision || frameworkHash(current.node.note) !== preview.noteHash)) throw new AgentFailure("source_changed", "agent_note_preview_changed");
  if (preview.taskVersion !== taskVersion(task) || !preview.sources.length
    || preview.sources.some(ref => !current.node.sources.some(source => source.materialId === ref.materialId && source.paragraph === ref.paragraph))) throw new AgentFailure("source_changed", "agent_note_target_changed");
  return preview;
}

export function createLearningAgentNoteTool(learning: LearningRepository): AgentTool {
  const artifacts = new LearningAgentRepository(learning);
  function buildPreview(args: z.infer<typeof AppendLearningAgentNote>, ctx: AgentContext) {
    const target = currentTarget(learning, ctx.task, args.chapterId, args.nodeId);
    const explanation = artifacts.get(ctx.task.resourceId, ctx.task.id, args.explanationId);
    if (!explanation || explanation.kind !== "explanation" || explanation.state !== "completed" || explanation.task_version !== taskVersion(ctx.task)) throw new AgentFailure("forbidden", "agent_explanation_forbidden");
    const answer = JSON.parse(explanation.body_json!) as LearningAgentExplanation;
    if (!answer.items.length || answer.items.some(ref => !target.node.sources.some(source => source.materialId === ref.materialId && source.paragraph === ref.paragraph))) throw new AgentFailure("known_failure", "agent_note_target_unreliable", undefined,
      "agent_note_target_unreliable：目标知识点未覆盖解释的全部来源，尚未创建提案或写入笔记。请从 learning.read_navigation 重新选择覆盖解释来源的授权知识点；无可靠目标时请等待用户选择或取消。");
    if (answer.supplements.length && !target.scope.scope.selection.includeSupplements) throw new AgentFailure("forbidden", "agent_supplements_not_authorized");
    const sourceLabels = answer.items.map(ref => {
      const material = target.scope.materials.find(m => m.materialId === ref.materialId);
      if (!material?.paragraphs.some(p => p.number === ref.paragraph)) throw new AgentFailure("source_changed", "agent_note_source_changed");
      return `《${material.title}》第 ${ref.paragraph} 段`;
    });
    const content = [answer.materialAnswer ? `来自复习向导（根据材料生成的 AI 解释，请结合原文核对）\n${answer.materialAnswer}` : null,
      ...answer.supplements.map(s => `补充${s.kind === "example" ? "例子" : "解释"}（材料外）\n${s.text}`),
      `来源：${sourceLabels.join("；")}`].filter(Boolean).join("\n\n");
    if (target.node.note.length + content.length + 2 > 20000) throw new LearningError(413, "note_too_large");
    const preview: LearningAgentNotePreview = {
      id: learningAgentOperationId(ctx.actionId, "note"), taskId: ctx.task.id, taskVersion: taskVersion(ctx.task), explanationId: args.explanationId,
      chapterId: args.chapterId, nodeId: args.nodeId, targetLabel: `${target.chapter.title} / ${target.node.title}`, content,
      sources: answer.items, includesSupplement: answer.supplements.length > 0, targetRevision: target.chapter.revision,
      noteHash: frameworkHash(target.node.note), sourceFingerprint: ""
    };
    preview.sourceFingerprint = frameworkHash(JSON.stringify({ ...preview, sourceFingerprint: undefined, scope: target.scope.fingerprint, sources: target.node.sources }));
    return preview;
  }
  async function confirmation(args: unknown, ctx: AgentContext) {
    await ctx.assertActive();
    const value = AppendLearningAgentNote.parse(args), id = learningAgentOperationId(ctx.actionId, "note");
    const old = artifacts.get(ctx.task.resourceId, ctx.task.id, id);
    if (!old) {
      const preview = buildPreview(value, ctx);
      learning.database.transaction(() => {
        artifacts.reserve({ id, taskId: ctx.task.id, taskVersion: taskVersion(ctx.task), pageId: ctx.task.resourceId, kind: "note_proposal", actionId: ctx.actionId,
          binding: (ctx.task.scope as { fingerprint: string }).fingerprint, materialIds: [...new Set(preview.sources.map(ref => ref.materialId))] });
        artifacts.savePreview(ctx.task.resourceId, ctx.task.id, id, { preview });
      }).immediate();
    }
    const preview = readLearningAgentNotePreview(learning, ctx.task, id);
    if (preview.explanationId !== value.explanationId || preview.chapterId !== value.chapterId || preview.nodeId !== value.nodeId) throw new AgentFailure("invalid_action", "agent_note_preview_conflict");
    return { title: "确认追加个人笔记", summary: "仅将下列解释追加到所选知识点；不会覆盖已有笔记。", target: preview.targetLabel,
      content: preview.content, sourceFingerprint: preview.sourceFingerprint };
  }
  const receipt = (id: string) => ({ ref: { kind: "learning.note", id }, summary: "已按确认内容追加个人笔记，旧笔记和框架正文保持原样。",
    handoff: "已完成本次明确确认的个人笔记追加，复习任务现交回用户；这不代表学习检查通过。继续复习请新建任务并确认目标与范围。" });
  return {
    description: "建议把本任务当前版本的一条解释追加到可靠知识点的个人笔记。先展示固定预览并等待用户明确确认，读取笔记的授权不代表可写入。目标不可靠时请求用户选择或取消。",
    parameters: AppendLearningAgentNote, confirmation,
    execute: async (args, ctx) => {
      await ctx.assertActive();
      const id = learningAgentOperationId(ctx.actionId, "note"), { row, body } = previewRow(learning, ctx.task, id);
      if (body.written && row.state === "completed") return receipt(id);
      const approval = ctx.task.approval;
      if (!approval || approval.status !== "approved" || approval.actionId !== ctx.actionId || approval.taskVersion !== taskVersion(ctx.task)) throw new AgentFailure("forbidden", "agent_note_confirmation_required");
      const expected = await confirmation(args, ctx);
      // Shared approval stores only its content hash. The full immutable content
      // remains in this product-owned preview, covered by sourceFingerprint.
      if (approval.sourceFingerprint !== expected.sourceFingerprint || approval.target !== expected.target) throw new AgentFailure("forbidden", "agent_note_confirmation_changed");
      await ctx.assertActive();
      learning.database.transaction(() => {
        const preview = readLearningAgentNotePreview(learning, ctx.task, id);
        const framework = new LearningStudyRepository(learning).appendNote(ctx.task.resourceId, {
          chapterId: preview.chapterId, nodeId: preview.nodeId, revision: preview.targetRevision, text: preview.content
        });
        const chapter = framework.chapters.find(c => c.id === preview.chapterId)!, node = chapter.nodes.find(n => n.id === preview.nodeId)!;
        const changedScope = freezeLearningAgentScope(learning, ctx.task.resourceId, (ctx.task.scope as { selection: unknown }).selection);
        artifacts.complete(ctx.task.resourceId, ctx.task.id, id, { preview,
          written: { chapterId: preview.chapterId, nodeId: preview.nodeId, revision: chapter.revision, contentHash: frameworkHash(preview.content),
            noteHash: frameworkHash(node.note), sourceFingerprint: changedScope.fingerprint } } satisfies NoteBody);
      }).immediate();
      return receipt(id);
    },
    validateResult: async (result, ctx) => {
      if (!result.ref || result.ref.kind !== "learning.note") throw new AgentFailure("forbidden", "agent_note_receipt_missing");
      const { row, body } = previewRow(learning, ctx.task, result.ref.id), written = body.written;
      if (!written || row.state !== "completed" || row.action_id !== ctx.actionId || row.binding_hash !== (ctx.task.scope as { fingerprint: string }).fingerprint) throw new AgentFailure("forbidden", "agent_note_receipt_invalid");
      const scope = freezeLearningAgentScope(learning, ctx.task.resourceId, (ctx.task.scope as { selection: unknown }).selection);
      const chapter = new LearningFrameworkRepository(learning).view(ctx.task.resourceId).chapters.find(c => c.id === written.chapterId), node = chapter?.nodes.find(n => n.id === written.nodeId);
      if (scope.fingerprint !== written.sourceFingerprint || chapter?.revision !== written.revision || !node || frameworkHash(node.note) !== written.noteHash
        || written.contentHash !== frameworkHash(body.preview.content)) throw new AgentFailure("source_changed", "agent_note_result_changed");
    },
    readResult: async (action, ctx) => {
      const { row, body } = previewRow(learning, ctx.task, action.resultRef!.id);
      if (row.state !== "completed" || !body.written) return { confirmed: false, written: false };
      return { written: true, chapterId: body.written.chapterId, nodeId: body.written.nodeId, notice: "已追加用户确认的内容；这不是来源证据或掌握结论。" };
    },
    recover: async (actionId, ctx) => {
      if (ctx.task.accountId !== learning.accountId) throw new AgentFailure("forbidden", "agent_account_forbidden");
      const id = learningAgentOperationId(actionId, "note"), row = artifacts.get(ctx.task.resourceId, ctx.task.id, id);
      if (!row || row.task_version !== taskVersion(ctx.task) || row.state !== "completed" || !row.body_json) return null;
      const body = JSON.parse(row.body_json) as NoteBody;
      return body.written ? receipt(id) : null;
    }
  };
}
