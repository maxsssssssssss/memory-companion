import type { AgentDecisionInput, AgentDecisionProvider } from "@/lib/server/agent/types";
import { agentDecisionRequest, createAgentDecisionProvider, type AgentModelConfig } from "@/lib/server/agent/model";
import { agentModelConfig } from "./agent-decision-config";

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
