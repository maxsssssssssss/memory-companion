import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentTask } from "@/lib/domain/agent";
import type { LearningAgentExplanation, LearningAgentReviewSummary } from "@/lib/domain/learning-agent";
import type { QuizAttemptView } from "@/lib/domain/learning-quiz";
import { AgentFailure, type AgentContext } from "@/lib/server/agent/types";
import { LearningError, type LearningRepository } from "./repository";
import { LearningAgentRepository, learningAgentOperationId } from "./agent-repository";
import { readLearningAgentScope } from "./agent-scope";
import { LearningQuizRepository } from "./quiz-repository";
import { assessLearningCompletion } from "./agent-completion";
import { LearningEvidenceProposal } from "@/lib/domain/learning-agent-completion";
import { evidenceRefKey } from "./agent-completion-evidence";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const terminal = new Set(["ended", "cancelled", "budget_exhausted"]);
const summaryId = (task: AgentTask) => learningAgentOperationId(`${task.id}:${task.version ?? 1}`, "review_summary");
type Topic = LearningAgentReviewSummary["topics"][number];
type Source = Topic["sources"][number];
type Scope = ReturnType<typeof readLearningAgentScope>;
type QuizSnapshot = { quizId: string; attempt: QuizAttemptView };
type TopicInput = { id: string; title: string; questions: Array<{ stem: string; selected: string; expected: string; explanation: string; selectedReason: string }>; sources: Array<{ materialId: string; paragraph: number; text: string; scopeNotice?: Scope["materials"][number]["scopeNotice"] }> };
type ReviewEvidence = { summary: LearningAgentReviewSummary; key: string; input: TopicInput[]; needsEnrichment: boolean };
type SavedReview = { evidenceKey: string; summary: LearningAgentReviewSummary };
type Exclusions = { generationIncomplete: number; generationUnknown: number; disputed: number; unavailable: number };
const sourceKey = (sources: Source[]) => sources.map(s => `${s.materialId}:${s.paragraph}`).sort().join("|");
const firstSentence = (text: string) => text.trim().split(/[。！？\n]/u).find(Boolean)?.slice(0, 160) ?? "";
const emptyStats = (): LearningAgentReviewSummary["stats"] => ({ groups: 0, total: 0, answered: 0, correct: 0, wrong: 0, unassistedCorrect: 0, hinted: 0, revealed: 0, skipped: 0, unanswered: 0, excludedGroups: 0 });

/** Pure aggregation of saved attempts. Skipping/revealing is never a wrong answer. */
export function buildLearningAgentReviewSummary(task: Pick<AgentTask, "status">, snapshots: QuizSnapshot[], scope: Scope,
  explanations: LearningAgentExplanation[], excludedGroups = 0, exclusions?: Exclusions): Omit<ReviewEvidence, "key"> {
  const stats = emptyStats(); stats.groups = snapshots.length; stats.excludedGroups = excludedGroups;
  const groups = new Map<string, { topic: Topic; input: TopicInput; reused: boolean; nodeTitle?: string }>();
  for (const { quizId, attempt } of snapshots) {
    for (const q of attempt.questions) {
      stats.total++;
      const p = q.progress;
      if (p.hinted) stats.hinted++;
      if (p.revealed) stats.revealed++;
      if (p.skipped) stats.skipped++;
      if (!p.submitted && !p.revealed && !p.skipped) stats.unanswered++;
      if (!p.submitted || p.revealed || p.skipped || !p.optionId || !q.feedback) continue;
      stats.answered++;
      if (q.feedback.correct) { stats.correct++; if (!p.hinted) stats.unassistedCorrect++; continue; }
      stats.wrong++;
      const sources: Source[] = q.feedback.sources.flatMap(s => s.kind === "material" && s.state === "available" ? [{ materialId: s.materialId, paragraph: s.paragraph, ...(s.parsed ? { parsed: s.parsed } : {}) }] : []);
      const nodes = scope.navigation.flatMap(c => c.nodes).filter(n => sources.length && sources.every(s => n.sources.some(ref => ref.materialId === s.materialId && ref.paragraph === s.paragraph)));
      const node = nodes.length === 1 ? nodes[0] : undefined;
      // A reliable node or identical source span groups errors; unrelated spans
      // are not guessed into a single knowledge point from model wording.
      const key = node ? `node:${node.id}` : sources.length ? `source:${sourceKey(sources)}` : `question:${quizId}:${q.index}`;
      let group = groups.get(key);
      if (!group) {
        const id = hash(key).slice(0, 16), title = node?.title ?? `错题回顾：${q.stem.slice(0, 72)}`;
        group = { topic: { id, title, explanation: "", questionRefs: [], sources: [] }, input: { id, title, questions: [], sources: [] }, reused: false, nodeTitle: node?.title };
        groups.set(key, group);
      }
      group.topic.questionRefs.push({ quizId, attemptId: attempt.id, index: q.index });
      for (const ref of sources) if (!group.topic.sources.some(s => s.materialId === ref.materialId && s.paragraph === ref.paragraph)) {
        group.topic.sources.push(ref);
        const paragraph = scope.materials.find(m => m.materialId === ref.materialId)?.paragraphs.find(p => p.number === ref.paragraph);
        if (paragraph) group.input.sources.push({ materialId: ref.materialId, paragraph: ref.paragraph, text: paragraph.text, scopeNotice: scope.materials.find(m => m.materialId === ref.materialId)?.scopeNotice });
      }
      group.input.questions.push({ stem: q.stem, selected: q.options.find(o => o.id === p.optionId)?.text ?? "", expected: q.options.find(o => o.id === q.feedback!.correctOptionId)?.text ?? "",
        explanation: q.feedback.explanation, selectedReason: q.feedback.reasons.find(r => r.id === p.optionId)?.reason ?? "" });
    }
  }
  const reminders: string[] = [];
  for (const group of groups.values()) {
    const related = explanations.find(e => e.materialAnswer?.trim() && group.topic.sources.length && sourceKey(e.items) === sourceKey(group.topic.sources)
      && (group.input.questions.some(q => q.stem.trim() === e.question.trim()) || Boolean(group.nodeTitle && group.nodeTitle.length >= 2 && e.question.includes(group.nodeTitle))));
    if (related?.materialAnswer) { group.topic.explanation = related.materialAnswer; group.reused = true; }
    else {
      const lines = [...new Set(group.input.questions.flatMap(q => [q.selectedReason, q.explanation]).map(t => t.trim()).filter(Boolean))];
      group.topic.explanation = lines.join("\n\n");
    }
    const reminder = firstSentence(group.input.questions[0]?.selectedReason || group.topic.explanation);
    if (reminder && !reminders.includes(reminder) && reminders.length < 3) reminders.push(reminder);
  }
  const complete = task.status === "ended" && snapshots.length > 0 && snapshots.every(s => s.attempt.completed) && excludedGroups === 0;
  const independentAllCorrect = complete && stats.total > 0 && stats.unassistedCorrect === stats.total && !stats.hinted && !stats.revealed && !stats.skipped;
  let headline = stats.answered ? `本轮已作答 ${stats.answered} 题，答对 ${stats.correct} 题。` : "本轮尚无可用于判断的已提交作答，未完成学习检查。";
  if (independentAllCorrect) headline = `本轮 ${stats.total} 题均答对，应用内未记录提示或提前查看答案。`;
  else if (stats.wrong) headline += `有 ${stats.wrong} 道错题值得回顾。`;
  else if (stats.answered) headline += "本次纳入回顾的已提交作答中没有错题。";
  const notices: string[] = [];
  if (task.status === "cancelled") notices.push("本轮已提前取消，以下只回顾已保存的进度。");
  else if (task.status === "budget_exhausted") notices.push("本轮已达到单次上限，以下只回顾已保存的进度。");
  if (stats.hinted || stats.revealed || stats.skipped) notices.push(`使用提示 ${stats.hinted} 题、查看答案 ${stats.revealed} 题、跳过 ${stats.skipped} 题；这些不算独立答对，跳过与查看答案也不作为知识错误。`);
  if (stats.unanswered || snapshots.some(s => !s.attempt.completed)) notices.push("仍有题组未完成；此处只使用已经保存并可核对的作答。");
  if (exclusions?.generationIncomplete) notices.push(`有 ${exclusions.generationIncomplete} 组练习未成功发布或生成尚未完成，没有可纳入回顾的作答；这不代表用户答错或提出了疑问。`);
  if (exclusions?.generationUnknown) notices.push(`有 ${exclusions.generationUnknown} 组练习的生成结果尚未确认，不纳入回顾，也不会据此自动重发。`);
  if (exclusions?.disputed) notices.push(`有 ${exclusions.disputed} 组题存在用户疑问，已从本次回顾排除，不用于学习诊断。`);
  if (exclusions?.unavailable) notices.push(`有 ${exclusions.unavailable} 组题因当前来源、授权或记录不可用而排除，不用于学习诊断。`);
  if (excludedGroups && !exclusions) notices.push(`有 ${excludedGroups} 组题未纳入当前回顾；不能据此推断用户的知识错误。`);
  if (stats.answered) notices.push("题目与解析未额外进行语义核验；应用内未记录辅助不证明没有外部帮助。本轮表现不代表长期掌握或已覆盖全部目标。");
  return { summary: { kind: complete ? "completed" : "partial", headline, stats, topics: [...groups.values()].map(g => g.topic), reminders, notices },
    input: [...groups.values()].filter(g => !g.reused && g.input.sources.length > 0).map(g => g.input), needsEnrichment: [...groups.values()].some(g => !g.reused && g.input.sources.length > 0) };
}

export function unavailableLearningAgentReviewSummary(): LearningAgentReviewSummary {
  return { kind: "partial", headline: "本轮进度已保留；当前来源或授权已变化，旧作答不再用于学习诊断。", stats: emptyStats(), topics: [], reminders: [], notices: ["请重新确认当前学习页范围。原题组与作答记录按原有访问规则保留。"] };
}

function readEvidence(learning: LearningRepository, task: AgentTask, disputedAttempts: readonly string[] = []): ReviewEvidence {
  if (task.accountId !== learning.accountId) throw new LearningError(404, "agent_not_found");
  const scope = readLearningAgentScope(learning, task.resourceId, task.scope), artifacts = new LearningAgentRepository(learning);
  const allRows = artifacts.list(task.resourceId, task.id), version = task.version ?? 1;
  const rows = allRows.filter(r => r.task_version === version);
  const quizzes = new LearningQuizRepository(learning), snapshots: QuizSnapshot[] = [], explanations: LearningAgentExplanation[] = [];
  const exclusions: Exclusions = { generationIncomplete: 0, generationUnknown: 0, disputed: 0, unavailable: 0 };
  const sourcesAllowed = (attempt: QuizAttemptView) => attempt.questions.every(q => !q.feedback || q.feedback.sources.every(s => s.state === "available" && (s.kind === "material"
    ? scope.materials.some(m => m.materialId === s.materialId && m.paragraphs.some(p => p.number === s.paragraph && JSON.stringify(p.parsed) === JSON.stringify(s.parsed)))
    : s.kind === "note" ? scope.scope.selection.includeNotes : scope.scope.selection.includeSupplements)));
  for (const row of rows) {
    if (row.kind === "quiz") {
      if (row.state !== "completed" || !row.body_json) {
        const run = learning.database.prepare("SELECT status FROM learning_quiz_runs WHERE id=? AND page_id=?").get(row.id, task.resourceId) as { status: string } | undefined;
        if (row.state === "unknown") exclusions.generationUnknown++;
        else if (["failed", "reserved"].includes(row.state) && run && ["failed", "generating", "insufficient"].includes(run.status)) exclusions.generationIncomplete++;
        else exclusions.unavailable++;
        continue;
      }
      const ref = JSON.parse(row.body_json) as { attemptId: string; disputed?: boolean };
      if (ref.disputed || disputedAttempts.includes(ref.attemptId)) { exclusions.disputed++; continue; }
      try {
        quizzes.assertSources(task.resourceId, row.id);
        const attempt = quizzes.attempt(task.resourceId, ref.attemptId);
        if (attempt.quizId !== row.id || row.binding_hash !== scope.fingerprint) throw new LearningError(409, "source_changed");
        if (!sourcesAllowed(attempt)) throw new LearningError(403, "agent_scope_forbidden");
        snapshots.push({ quizId: row.id, attempt });
      } catch (error) { if (!(error instanceof LearningError)) throw error; exclusions.unavailable++; }
    } else if (row.kind === "explanation" && row.state === "completed" && row.body_json && row.binding_hash === scope.fingerprint) {
      const value = JSON.parse(row.body_json) as LearningAgentExplanation;
      if (value.items.every(s => scope.materials.some(m => m.materialId === s.materialId && m.paragraphs.some(p => p.number === s.paragraph)))) explanations.push(value);
    }
  }
  // History permission alone is not a request to summarize every old score.
  // Reuse the completion authority's current checks, and require this version's
  // actual answer read plus an explicit association. Include only those exact
  // questions; another question in the same old group remains outside scope.
  let historicalQuestions = 0;
  let historyPending = false;
  if (scope.scope.selection.includeHistory) {
    const assessment = assessLearningCompletion(learning, task);
    historyPending = Boolean(assessment.historyReview?.blocked || assessment.historyReview?.pending.length);
    const explicit = new Set(rows.filter(row => row.kind === "evidence_proposal" && row.state === "completed" && row.body_json && row.binding_hash === scope.fingerprint)
      .flatMap(row => { const parsed = LearningEvidenceProposal.safeParse(JSON.parse(row.body_json!)); return parsed.success ? [evidenceRefKey(parsed.data.ref)] : []; }));
    const historical = new Map<string, Set<number>>();
    for (const evidence of assessment.objectives.flatMap(objective => objective.evidence)) {
      if (!evidence.historical || !evidence.submitted || !evidence.eligible || !explicit.has(evidenceRefKey(evidence.ref))
        || !task.actions.some(action => (action.version ?? 1) === version && action.status === "succeeded"
          && action.tool === "learning.read_answers" && action.resultRef?.kind === "learning.answers" && action.resultRef.id === evidence.ref.attemptId)) continue;
      const row = allRows.find(item => item.kind === "quiz" && item.id === evidence.ref.quizId && item.task_version < version && item.state === "completed" && item.body_json);
      if (!row || JSON.parse(row.body_json!).attemptId !== evidence.ref.attemptId) continue;
      const indices = historical.get(evidence.ref.attemptId) ?? new Set<number>();
      indices.add(evidence.ref.questionIndex); historical.set(evidence.ref.attemptId, indices);
    }
    for (const [attemptId, indices] of historical) {
      if (disputedAttempts.includes(attemptId)) { exclusions.disputed++; continue; }
      try {
        const attempt = quizzes.attempt(task.resourceId, attemptId);
        quizzes.assertSources(task.resourceId, attempt.quizId);
        const selected = { ...attempt, questions: attempt.questions.filter(question => indices.has(question.index)) };
        if (!attempt.completed || !sourcesAllowed(selected)) throw new LearningError(403, "agent_scope_forbidden");
        snapshots.push({ quizId: attempt.quizId, attempt: selected }); historicalQuestions += selected.questions.length;
      } catch (error) { if (!(error instanceof LearningError)) throw error; exclusions.unavailable++; }
    }
  }
  const excluded = Object.values(exclusions).reduce((total, count) => total + count, 0);
  const built = buildLearningAgentReviewSummary(task, snapshots, scope, explanations, excluded, exclusions);
  built.summary.notices.push(historicalQuestions
    ? `回顾范围：本版本题组，以及已明确授权、重新读取并关联到本轮目标的 ${historicalQuestions} 道历史题目。其他历史作答未纳入，旧成绩保持原样。`
    : "回顾范围：仅本版本可核对的题组；未经本版本授权、读取及关联的历史作答未纳入，不能据此认定此前没有困难。");
  if (historyPending) built.summary.notices.push("仍有已授权历史作答需要读取或重新关联；本次回顾不代表相关历史困难已解决。");
  return { ...built, key: hash({ version, scope: scope.fingerprint, snapshots, explanations, exclusions, historicalQuestions, historyPending }) };
}

/** A read never generates or persists a summary. Historical terminal tasks get
 * a deterministic view; cached text is used only for the exact current evidence. */
export function projectLearningAgentReviewSummary(learning: LearningRepository, task: AgentTask, disputedAttempts: readonly string[] = []) {
  if (!terminal.has(task.status) && task.recovery?.kind !== "unknown") return undefined;
  let evidence: ReviewEvidence;
  try { evidence = readEvidence(learning, task, disputedAttempts); }
  catch (error) { if (error instanceof LearningError && task.accountId === learning.accountId) return unavailableLearningAgentReviewSummary(); throw error; }
  const saved = new LearningAgentRepository(learning).get(task.resourceId, task.id, summaryId(task));
  // Task-level uncertainty may concern a decision or a different generation.
  // Only this version's actual summary operation can establish summary doubt.
  const summaryUnconfirmed = saved && saved.task_version === (task.version ?? 1) && ["unknown", "reserved"].includes(saved.state)
    ? ["专项归纳的结果尚未确认；这里仅回顾已保存的作答与解析，不会自动重新生成。"] : [];
  if (saved?.state === "completed" && saved.body_json) {
    const value = JSON.parse(saved.body_json) as SavedReview;
    if (value.evidenceKey === evidence.key) return { ...value.summary, kind: evidence.summary.kind, headline: evidence.summary.headline, stats: evidence.summary.stats,
      notices: [...new Set([...evidence.summary.notices, ...value.summary.notices.filter(n => n.startsWith("专项归纳暂未完成")),
        ...summaryUnconfirmed])] };
  }
  const summary = evidence.summary;
  // A plain ended state can also mean explicit user handoff. Only the saved
  // finish artifact establishes a normal completed review summary.
  return { ...summary, kind: "partial" as const,
    headline: summary.headline,
    notices: [...summary.notices, ...summaryUnconfirmed] };
}

export const GeneratedLearningReview = z.object({ items: z.array(z.object({ id: z.string().min(1).max(32), explanation: z.string().trim().min(1).max(2400), reminder: z.string().trim().min(1).max(180) }).strict()).min(1).max(30) }).strict();
export type LearningReviewEnrichment = (input: TopicInput[]) => Promise<z.infer<typeof GeneratedLearningReview>>;

/** At most one optional generation per task version. Repeated finish/refresh
 * reuses saved facts; uncertain generations retain the runtime's unknown state. */
export async function saveLearningAgentReviewSummary(learning: LearningRepository, ctx: AgentContext, enrich?: LearningReviewEnrichment) {
  await ctx.assertActive();
  const scope = readLearningAgentScope(learning, ctx.task.resourceId, ctx.task.scope);
  const task = { ...ctx.task, status: "ended" as const }, evidence = readEvidence(learning, task), artifacts = new LearningAgentRepository(learning), id = summaryId(task);
  const previous = artifacts.reserve({ id, taskId: task.id, taskVersion: task.version ?? 1, pageId: task.resourceId, kind: "review_summary",
    actionId: `review-summary:${task.id}:${task.version ?? 1}`, binding: scope.fingerprint, materialIds: scope.materials.map(m => m.materialId) });
  if (previous) {
    if (previous.state === "completed" && previous.body_json) {
      const saved = JSON.parse(previous.body_json) as SavedReview;
      return saved.evidenceKey === evidence.key ? saved.summary : evidence.summary;
    }
    if (["unknown", "reserved"].includes(previous.state)) throw new AgentFailure("unknown", "agent_review_summary_unknown");
    return evidence.summary;
  }
  let summary = evidence.summary;
  try {
    if (evidence.needsEnrichment && enrich) {
      try {
        const result = GeneratedLearningReview.parse(await enrich(evidence.input));
        const ids = new Set(result.items.map(item => item.id));
        if (ids.size !== evidence.input.length || result.items.length !== evidence.input.length || result.items.some(item => !evidence.input.some(topic => topic.id === item.id)
          || /(?:已经|完全|彻底).{0,6}掌握|掌握率|通过核验/u.test(item.explanation + item.reminder))) throw new AgentFailure("known_failure", "agent_review_summary_invalid");
        summary = { ...summary, topics: summary.topics.map(topic => ({ ...topic, explanation: result.items.find(item => item.id === topic.id)?.explanation ?? topic.explanation })), reminders: [...new Set([...result.items.map(item => item.reminder), ...summary.reminders])].slice(0, 3) };
      } catch (error) {
        if (error instanceof AgentFailure && ["unknown", "inactive", "forbidden", "source_changed"].includes(error.code)) throw error;
        if (error instanceof LearningError && ["source_changed", "material_deleted", "page_deleted", "agent_scope_forbidden", "agent_account_forbidden"].includes(error.code)) throw error;
        if (!(error instanceof AgentFailure) && !(error instanceof LearningError) && !(error instanceof z.ZodError)) throw new AgentFailure("unknown", "agent_review_summary_unknown");
        summary = { ...summary, notices: [...summary.notices, "专项归纳暂未完成，以下保留已保存的逐题解析与具体提醒。"] };
      }
    }
    await ctx.assertActive();
    // Re-read source, attempt and dispute facts after generation before saving.
    const latest = readEvidence(learning, task);
    if (latest.key !== evidence.key) throw new AgentFailure("source_changed", "agent_review_evidence_changed");
    artifacts.complete(task.resourceId, task.id, id, { evidenceKey: evidence.key, summary } satisfies SavedReview);
    return summary;
  } catch (error) {
    artifacts.fail(task.resourceId, task.id, id, error instanceof AgentFailure && error.code === "unknown");
    throw error;
  }
}
