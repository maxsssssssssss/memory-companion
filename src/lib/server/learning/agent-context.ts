import type { AgentDecisionInput, AgentDecisionProvider } from "@/lib/server/agent/types";
import { agentDecisionRequest, createAgentDecisionProvider, type AgentModelConfig } from "@/lib/server/agent/model";
import { agentModelConfig } from "./agent-decision-config";
import type { LearningRepository } from "./repository";
import { acknowledgeLearningFeedback, assessLearningCompletion, hasPendingLearningFeedback } from "./agent-completion";

type Result = AgentDecisionInput["results"][number];
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
/** Only Learning knows which facts remain useful without the original text.
 * This is an ephemeral view of freshly authorized reads, never stored memory. */
function earlierResult(result: Result): Result {
  if (result.status !== "succeeded") return result;
  const value = record(result.value);
  if (!value || value.detailsOmitted || value.supersededBy) return result;
  if (result.tool === "learning.read_answers" && typeof value.attemptId === "string" && Array.isArray(value.questions)) {
    return { ...result, value: {
      attemptId: value.attemptId, quizId: value.quizId, submitted: value.submitted ?? true, disputed: value.disputed === true,
      ...(value.disputed ? {} : { score: value.score }),
      questions: value.questions.map(question => { const q = record(question) ?? {}; return {
        index: q.index, ...(value.disputed ? {} : { selectedOptionId: q.selectedOptionId, progress: q.progress })
      }; }),
      detailsOmitted: true, readDetails: { tool: "learning.read_answers", args: { attemptId: value.attemptId } },
      notice: "仅保留已保存的作答状态，题干和解析未发送。具体诊断需按需读取详情；有争议的题组不得用于诊断，分数不证明掌握。"
    } };
  }
  if (result.tool === "learning.explain" && typeof value.id === "string") {
    return { ...result, value: { id: value.id, taskId: value.taskId, taskVersion: value.taskVersion,
      question: value.question, items: value.items, detailsOmitted: true,
      includesSupplement: Array.isArray(value.supplements) && value.supplements.length > 0,
      notice: "较早讲解正文未发送，不能据此推断具体讲解内容或用户掌握情况。完整讲解仍保存在任务中；笔记提案会重新读取完整内容并请求用户确认。"
    } };
  }
  if (result.tool === "learning.read_source" && typeof value.materialId === "string") {
    const paragraph = record(value.paragraph);
    if (typeof paragraph?.number !== "number") return result;
    return { ...result, value: { materialId: value.materialId, title: value.title, scopeNotice: value.scopeNotice,
      paragraph: { number: paragraph.number, parsed: paragraph.parsed }, detailsOmitted: true,
      readDetails: { tool: "learning.read_source", args: { materialId: value.materialId, paragraph: paragraph.number } },
      notice: "较早原文正文未发送，本条只提供位置，不是正文依据；引用或解释前须按需重新读取。"
    } };
  }
  return result;
}

export function fitLearningAgentDecisionInput(input: AgentDecisionInput, maxInputChars: number): AgentDecisionInput {
  if (agentDecisionRequest(input).inputChars <= maxInputChars) return input;
  const results = [...input.results];
  const fitted = { ...input, results };
  // Preserve the latest action and latest detailed answers/explanation. Older
  // bodies are replaced whole by factual summaries, never sliced text or JSON.
  const protectedIds = new Set<string>();
  if (results.length) protectedIds.add(results[results.length - 1].actionId);
  for (const tool of ["learning.read_answers", "learning.explain"]) {
    const latest = [...results].reverse().find(result => result.tool === tool && result.status === "succeeded" && !record(result.value)?.supersededBy);
    if (latest) protectedIds.add(latest.actionId);
  }
  for (let i = 0; i < results.length; i++) {
    if (protectedIds.has(results[i].actionId)) continue;
    const compact = earlierResult(results[i]);
    if (JSON.stringify(compact).length >= JSON.stringify(results[i]).length) continue;
    results[i] = compact;
    if (agentDecisionRequest(fitted).inputChars <= maxInputChars) break;
  }
  // If the required context itself is too large, the original final transport
  // check stops before network with the specific input-limit reason.
  return fitted;
}

export function createLearningAgentDecisionProvider(configure: () => AgentModelConfig = agentModelConfig): AgentDecisionProvider {
  return async (input, ctx) => {
    const config = configure();
    const bounded = { ...config, maxInputChars: Math.min(config.maxInputChars, input.task.budget.maxInputChars) };
    return createAgentDecisionProvider(() => bounded)(fitLearningAgentDecisionInput(input, bounded.maxInputChars), ctx);
  };
}

/** Both real and offline decisions use the same Learning-owned fact gate. It
 * never turns the shared ended state into a mastery claim. Prepared actions
 * also recheck inside their tool, since a checkpoint can bypass this decision. */
export function withLearningCompletionDecision(learning: LearningRepository, decide: AgentDecisionProvider): AgentDecisionProvider {
  return async (input, ctx) => {
    await ctx.assertActive();
    const completion = assessLearningCompletion(learning, ctx.task, ctx.event);
    // Do not spend another decision/generation call on a plan-source mismatch.
    // The existing feedback tool gives this handback a persistent round while
    // retaining the user's existing versioned adjustment and cancel controls.
    if (completion.technicalBlocker) return { tool: "learning.request_feedback", args: { question: completion.technicalBlocker.message }, reason: "等待核对本轮目标与资料关联。" };
    if (completion.canAutoFinish && !hasPendingLearningFeedback(learning, ctx.task, ctx.event)) return { finish: completion.headline };
    const observation = record(input.observation) ?? {};
    const decision = await decide({ ...input, observation: { ...observation, completion } }, ctx);
    // A Learning feedback tool supplies a stable persisted round identity. Keep
    // the public structured_action_v1 wait choice, while using the existing
    // business tool internally so later answers can revise an earlier round.
    if ("wait" in decision && (ctx.task.scope as { completionVersion?: number })?.completionVersion === 1
      && decision.wait.kind === "feedback" && !decision.wait.refId) {
      return { tool: "learning.request_feedback", args: { question: decision.wait.message }, reason: "等待用户反馈。" };
    }
    if ("wait" in decision || "finish" in decision) acknowledgeLearningFeedback(learning, ctx);
    return decision;
  };
}
