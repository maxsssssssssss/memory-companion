import { z } from "zod";
import type { QuizDeliveryReason, QuizDeliverySummary } from "@/lib/domain/learning-quiz";

export const QuizCandidateReport = z.object({
  candidates: z.number().int().min(0).max(50),
  // Local slot provenance after surplus filtering. Not supplied by the model.
  forwardedIndexes: z.array(z.number().int().min(0).max(49)).max(50).optional(),
  rejected: z.array(z.object({ index: z.number().int().min(0).max(49),
    code: z.enum(["structure_or_evidence", "option_identity", "position_dependency", "answer_contradiction",
      "repeated_focus", "equivalent_options", "answer_not_unique", "source_binding", "goal_mismatch"])
  }).strict()).max(50)
}).strict();
export type QuizCandidateReport = z.infer<typeof QuizCandidateReport>;

const labels: Record<QuizDeliveryReason, string> = {
  structure_or_evidence: "题目结构或依据不完整", option_identity: "选项标识不一致",
  position_dependency: "题目依赖选项排列或其他题目", answer_contradiction: "答案与解析矛盾",
  repeated_focus: "题目重复", equivalent_options: "存在等价选项", answer_not_unique: "不能确定唯一正确答案",
  source_binding: "引用未能与本次材料可靠对应", goal_mismatch: "题目与本轮检查目标关联不符",
  format: "生成结果格式不完整", unknown: "生成结果尚未确认", budget: "本轮可用资源已用完",
  known_failure: "这次生成未能完成"
};

/** Only local categories/counts are projected. Never display a model's raw failure
 * text, rejected question, answer, evidence excerpt or schema input to a learner. */
export function quizDeliverySummary(input: { requested: number; published: number;
  status: "completed" | "insufficient" | "failed"; failure: string | null; uncertain?: boolean;
  reports?: QuizCandidateReport[]; publicationReport?: QuizCandidateReport; validationFailed?: boolean;
  incompleteParts?: number; partialFailure?: "format" | "known_failure" | "source_binding" }): QuizDeliverySummary {
  const reports = input.reports?.flatMap(value => {
    const parsed = QuizCandidateReport.safeParse(value); return parsed.success ? [parsed.data] : [];
  });
  const counts = new Map<QuizDeliveryReason, number>();
  for (const report of reports ?? []) for (const issue of report.rejected) counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
  const publication = QuizCandidateReport.safeParse(input.publicationReport);
  if (publication.success) {
    const forwarded = (reports ?? []).flatMap(report => (report.forwardedIndexes ?? Array.from({ length: report.candidates }, (_, i) => i))
      .map(index => ({ alreadyRejected: report.rejected.some(issue => issue.index === index) })));
    for (const issue of publication.data.rejected) if (!forwarded[issue.index]?.alreadyRejected)
      counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
  }
  let failure: QuizDeliveryReason | undefined;
  if (input.incompleteParts && input.partialFailure) counts.set(input.partialFailure, (counts.get(input.partialFailure) ?? 0) + 1);
  if (input.status === "failed") {
    failure = input.uncertain || input.failure === "generation_result_unknown" ? "unknown"
      : /^agent_(?:call_limit|request_input_limit|request_output_limit|compute_limit|generation_budget_exhausted)$/.test(input.failure ?? "") ? "budget"
      : input.validationFailed ? "format"
      : ["source_changed", "quiz_grounding_invalid", "framework_invalid_source", "quiz_reading_invalid_source"].includes(input.failure ?? "") ? "source_binding"
      : "known_failure";
    counts.set(failure, (counts.get(failure) ?? 0) + 1);
  }
  const rejected = [...counts].map(([code, count]) => ({ code, count }));
  const candidates = input.incompleteParts || failure === "unknown" ? null : reports?.length ? reports.reduce((sum, report) => sum + report.candidates, 0)
    : publication.success ? publication.data.candidates : null;
  const details = rejected.map(issue => labels[issue.code]).join("、");
  const partial = input.published > 0 && input.published < input.requested;
  const message = input.published > 0
    ? partial ? `这次准备了 ${input.published} 道可作答的题，少于原计划的 ${input.requested} 道。${input.incompleteParts ? "后续一部分生成未能完成，已保留可用题目。" : details ? `其余候选中有${details}，已排除。` : "其余题目未能可靠交付。"}`
      : `已准备好 ${input.published} 道题，可以开始练习。`
    : failure === "unknown" ? "这次生成是否完成还未确认，暂时没有可作答的题目。"
      : failure === "budget" ? "本轮已无法继续生成题目，已有内容和作答会保留。"
        : `这次未能生成可靠的练习题。${details ? `检查发现${details}。` : ""}这不代表你没有掌握，也不一定是材料不足。`;
  const nextStep = input.published > 0 ? "先完成已有题目，再根据实际作答决定下一步；题量不代表目标已全部检查。"
    : failure === "unknown" ? "先检查原生成结果；未确认前不会自动再次生成。"
      : failure === "budget" ? "可以回看已有讲解或结束本轮，不会自动重置已用资源。"
        : failure === "source_binding" ? "先核对所选材料与引用，再决定是否调整本次练习或回源说明。"
          : "可以先结合原文讲清相关内容；有明确的新依据或不同检查方法时，再尝试一次小范围练习。";
  return { requested: input.requested, candidates, published: input.published, rejected, message, nextStep };
}
