import type { LearningCompletionAssessment, LearningCompletionEvidence, LearningEvidenceRef } from "@/lib/domain/learning-agent-completion";
import type { LearningAgentTaskView } from "@/lib/client/learning-agent-api";
import type { LearningMaterial } from "@/lib/domain/learning";
import type { ParsedTextBinding } from "@/lib/domain/learning-pdf-study";
import styles from "./learning.module.css";
import completionStyles from "./learning-agent-completion.module.css";

const goalLabels = { explanation: "解释疑问", diagnosis: "诊断薄弱点", targeted_review: "针对性复习", chapter_check: "章节学习检查" };
const supportLabels = { supported: "已有表现支持", partial: "仍需巩固", unobserved: "尚未检查", uncertain: "暂时无法判断" };

function evidenceDescription(evidence: LearningCompletionEvidence, completed: boolean) {
  if (!completed || !evidence.submitted) return "尚未完成作答，不据此判断。";
  if (evidence.quality === "invalid" && evidence.diagnosticCode === "plan_source_mismatch") return "题目与本轮目标引用的原文未对应，暂不用于判断；这不表示你答错或尚未学会。";
  if (evidence.quality === "disputed") return "题目有疑问，已排除。";
  if (evidence.quality === "known_issue" || evidence.quality === "invalid") return "题目或来源存在问题，已排除。";
  if (evidence.quality === "uncertain" || evidence.quality === "historical_unknown") return "题目或历史信息尚不充分，暂不据此通过。";
  if (evidence.skipped) return "本题已跳过。";
  if (evidence.revealedBeforeSubmission || evidence.answerAvailability === "available_before_submission") return "作答前答案已可获得；不作为独立检查的支持。";
  if (evidence.hintedBeforeSubmission) return "使用提示后作答；不作为独立检查的支持。";
  if (evidence.repetition === "known_repeat") return "已知重复题；不能单独证明在新情境中也能运用。";
  if (evidence.answerAvailability === "unknown" || evidence.repetition === "unknown") return "此前帮助或重复情况不明，保留判断。";
  return evidence.correct ? "本题答对，应用内未记录首答前的提示或提前看答案。" : "本题答错，可能存在需要进一步区分的问题。";
}

/** Read-only projection. Quiz services remain the authority for answers and scores. */
export function LearningAgentCompletion({ completion, taskVersion, ended, quizLinks, materials, disabled, onReview, onSource }: {
  completion: LearningCompletionAssessment; taskVersion: number; ended: boolean;
  quizLinks: NonNullable<LearningAgentTaskView["quizLinks"]>; disabled: boolean;
  materials: Array<Pick<LearningMaterial, "id" | "kind">>;
  onReview: (ref: LearningEvidenceRef) => void;
  onSource: (id: string, paragraph: number, parsed?: ParsedTextBinding) => void;
}) {
  const stale = completion.outcome === "stale" || completion.taskVersion !== taskVersion
    || (completion.plan && completion.plan.taskVersion !== taskVersion);
  if (stale) return <section className={styles.agentReviewSummary} aria-label="本轮目标与依据"><h4>本轮判断需要更新</h4><p>复习目标、授权或来源已变化，旧结论不再作为本轮依据。请先核对当前范围。</p></section>;
  if (completion.outcome === "legacy") return <p className={styles.muted}>这项历史复习没有逐项目标判断，原作答与回顾仍保留。</p>;
  if (!completion.plan) return null;
  const { plan } = completion;
  return <section className={completionStyles.completion} aria-label="本轮目标与依据">
    <div className={completionStyles.heading}><h4>本轮要检查什么</h4><span className={styles.muted}>{goalLabels[plan.kind]}</span></div>
    {completion.technicalBlocker ? <div className={styles.agentNotice} role="status"><strong>{completion.technicalBlocker.kind === "plan_requirement_unobservable" ? "先明确可检查的知识表现" : "先核对目标与来源"}</strong><p>{completion.technicalBlocker.message}</p></div> : null}
    {completion.historyReview && (completion.historyReview.pending.length || completion.historyReview.blocked) ? <div className={styles.agentNotice} role="status"><strong>先核对相关作答</strong><p>{completion.historyReview.notice}</p></div> : null}
    <p className={styles.muted}>以下是本轮约定的目标。{plan.kind === "chapter_check" ? "这些核心目标不代表整章全部知识。" : "需要更改时，可调整本轮复习。"}</p>
    <ol className={completionStyles.objectives}>{plan.objectives.map(objective => {
      const assessed = completion.objectives.find(item => item.id === objective.id);
      return <li key={objective.id} className={completionStyles.objective}>
        <div className={completionStyles.heading}><h5>{objective.label}</h5><span className={completionStyles.support}>{assessed ? supportLabels[assessed.status] : "尚未检查"}</span></div>
        {objective.requirements.length ? <ul className={completionStyles.requirements}>{objective.requirements.map(requirement => <li key={requirement.role}>{requirement.description}</li>)}</ul> : <p className={styles.muted}>有对应讲解后，由你明确确认疑问是否已解决。</p>}
        {assessed?.gaps.length ? <ul className={completionStyles.gaps} aria-label={`${objective.label}的待完成部分`}>{assessed.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul> : null}
        {assessed?.explanationResolved ? <p className={styles.muted}>你已明确确认这项疑问得到解决。</p> : null}
        <details className={completionStyles.evidence}><summary>查看依据与来源</summary>
          {assessed?.evidence.length ? <ul className={completionStyles.evidenceList}>{assessed.evidence.map((evidence, index) => {
            const group = quizLinks.findIndex(link => link.quizId === evidence.ref.quizId && link.attemptId === evidence.ref.attemptId);
            const completed = group >= 0 ? Boolean(quizLinks[group].completed) : evidence.submitted;
            const canOpen = group >= 0 && completed;
            return <li key={`${evidence.ref.attemptId}:${evidence.ref.questionIndex}:${index}`}>
              <p>{evidenceDescription(evidence, completed)}</p>
              <button type="button" disabled={disabled || !canOpen} onClick={() => onReview(evidence.ref)}>{group < 0 ? "原题组当前不可打开" : quizLinks[group].historical ? `查看历史作答 · 第 ${evidence.ref.questionIndex + 1} 题` : `查看作答 · 题组 ${group + 1} 第 ${evidence.ref.questionIndex + 1} 题`}</button>
              {completed && evidence.submitted && evidence.responseMode === "single_choice" ? <p className={styles.muted}>本题记录为选择作答，不代表独立组织语言作答。</p> : null}
              {completed && evidence.submitted && evidence.rationale ? <p className={styles.muted}>关联说明：{evidence.rationale}（模型提出，未作独立教学核验）</p> : null}
            </li>;
          })}</ul> : <p className={styles.muted}>{assessed?.explanationResolved ? "依据是你对本轮讲解的明确反馈。"
            : plan.kind === "explanation" ? completion.technicalBlocker?.kind === "plan_source_mismatch" ? "讲解已保留，但它与本轮目标的来源关联需要先核对，暂不能记录为疑问已解决。"
              : assessed?.explanationState === "missing" ? "本轮还没有相关讲解。可以先说明困惑，再结合原文解释，不要求先完成练习。"
              : assessed?.explanationState === "needs_review" ? "讲解中有需要核对的内容，暂不能作为疑问已解决的依据。原文和讲解均保留供核对。"
              : "等待对本轮相关讲解的明确反馈，不要求先完成练习。"
              : "暂未关联可用于判断的已保存作答。"}</p>}
          {objective.sources.length ? <div className={styles.sources}>{objective.sources.map((source, index) => {
            const material = materials.find(item => item.id === source.materialId);
            const parsed = assessed?.evidence.flatMap(item => item.sources).find(item => item.materialId === source.materialId && item.paragraph === source.paragraph && item.parsed)?.parsed;
            const materialOnly = material?.kind === "pdf" && !parsed;
            return <button type="button" key={`${source.materialId}:${source.paragraph}`} disabled={!material}
              onClick={() => onSource(source.materialId, parsed?.physicalPage ?? (materialOnly ? 1 : source.paragraph), parsed)}>{materialOnly ? "查看来源材料" : "查看目标原文"} {index + 1}</button>;
          })}</div> : null}
        </details>
      </li>;
    })}</ol>
    <section className={completionStyles.result} aria-label="本轮判断">
      <h5>{ended ? completion.headline : completion.outcome === "check_passed" ? "当前作答已有支持" : completion.headline}</h5>
      {ended && completion.stopReason ? <p>停止原因：{completion.stopReason}</p> : null}
      {completion.limitations.length ? <ul className={completionStyles.requirements}>{completion.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul> : null}
      <p className={styles.muted}>结论仅限本轮约定目标；题目与目标的关联包含模型判断，长期掌握尚未验证。</p>
    </section>
  </section>;
}
