import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { LearningCompletionAssessment, LearningCompletionEvidence } from "@/lib/domain/learning-agent-completion";
import { LearningAgentCompletion } from "./learning-agent-completion";

afterEach(cleanup);
const source = { materialId: "material-one", paragraph: 3 };
const evidence: LearningCompletionEvidence = {
  ref: { quizId: "quiz-one", attemptId: "attempt-one", questionIndex: 2 }, objectiveId: "boundary", role: "boundary",
  submitted: true, correct: false, firstSubmittedAt: "2026-10-16T00:00:00Z", hintedBeforeSubmission: false,
  revealedBeforeSubmission: false, skipped: false, answerAvailability: "not_observed_before_submission", repetition: "not_known_repeat",
  historical: false, quality: "tentative", eligible: true, independentInApp: true, reasons: [], rationale: "本题要求判断何时不能使用规则。",
  relation: "initial", semanticProvenance: "model_proposal", priorEvidenceRefs: [], sources: [source],
};
const assessment: LearningCompletionAssessment = {
  schemaVersion: 1, taskVersion: 1, planId: "plan-one", sourceFingerprint: "synthetic", evidenceFingerprint: "saved-evidence", progressFingerprint: "observed",
  plan: { id: "plan-one", schemaVersion: 1, taskVersion: 1, sourceFingerprint: "synthetic", goal: "合成规则学习检查", proposedBy: "model", kind: "chapter_check",
    objectives: [{ id: "boundary", label: "区分规则的适用条件", sources: [source], requirements: [{ role: "boundary", description: "说明在什么条件下不能使用规则。", independent: true }] }] },
  outcome: "partial", support: "partial", objectives: [{ id: "boundary", label: "区分规则的适用条件", status: "partial", requirements: [{ role: "boundary", description: "说明在什么条件下不能使用规则。", supported: false }],
    evidence: [evidence], gaps: ["适用条件仍有反例未处理。"], unresolvedErrors: [evidence.ref], explanationResolved: false }],
  canAutoFinish: false, pending: [], headline: "部分目标已有支持，仍需巩固。", stopReason: null, limitations: ["作答关联为暂定支持，未核验题目语义。"], longTermMastery: "unverified",
};
const onReview = vi.fn(), onSource = vi.fn();
function mount(value: LearningCompletionAssessment = assessment, options: { taskVersion?: number; completed?: boolean; ended?: boolean; pdf?: boolean; historical?: boolean; unavailable?: boolean } = {}) {
  return render(<LearningAgentCompletion completion={value} taskVersion={options.taskVersion ?? 1} ended={options.ended ?? false}
    quizLinks={options.unavailable ? [] : [{ quizId: "quiz-one", attemptId: "attempt-one", completed: options.completed ?? true, historical: options.historical }]}
    materials={[{ id: "material-one", kind: options.pdf ? "pdf" : "text" }]} disabled={false} onReview={onReview} onSource={onSource} />);
}

it("shows agreed core requirements, remaining gaps and tentative evidence without turning a partial result into a pass", () => {
  mount();
  expect(screen.getByRole("heading", { name: "本轮要检查什么" })).toBeVisible();
  expect(screen.getByText("这些核心目标不代表整章全部知识。", { exact: false })).toBeVisible();
  expect(screen.getByText("适用条件仍有反例未处理。")).toBeVisible();
  expect(screen.queryByText("本轮检查通过")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("查看依据与来源", { selector: "summary" }));
  expect(screen.getByText("本题答错，可能存在需要进一步区分的问题。")).toBeVisible();
  expect(screen.getByText(/模型提出，未作独立教学核验/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "查看作答 · 题组 1 第 3 题" }));
  expect(onReview).toHaveBeenCalledWith(evidence.ref);
  fireEvent.click(screen.getByRole("button", { name: "查看目标原文 1" }));
  expect(onSource).toHaveBeenCalledWith("material-one", 3, undefined);
  expect(screen.getByRole("region", { name: "本轮目标与依据" })).not.toHaveTextContent(/预算|tokens|调用次数|已掌握/);
});

it.each(["stale", "version"])("hides prior conclusions, objective text and source controls when %s invalidates the projection", mode => {
  mount({ ...assessment, outcome: mode === "stale" ? "stale" : "check_passed", headline: "本轮检查通过" }, { taskVersion: mode === "version" ? 2 : 1 });
  expect(screen.getByText("本轮判断需要更新")).toBeVisible();
  expect(screen.queryByText("本轮检查通过")).not.toBeInTheDocument();
  expect(screen.queryByText("区分规则的适用条件")).not.toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("does not infer a current goal verdict for legacy tasks", () => {
  mount({ ...assessment, outcome: "legacy", plan: null, objectives: [] });
  expect(screen.getByText("这项历史复习没有逐项目标判断，原作答与回顾仍保留。")).toBeVisible();
  expect(screen.queryByRole("heading", { name: "本轮要检查什么" })).not.toBeInTheDocument();
});

it("does not expose result or semantic explanation before the quiz has been submitted", () => {
  mount(assessment, { completed: false });
  fireEvent.click(screen.getByText("查看依据与来源", { selector: "summary" }));
  expect(screen.getByText("尚未完成作答，不据此判断。")).toBeVisible();
  expect(screen.queryByText(evidence.rationale, { exact: false })).not.toBeInTheDocument();
  expect(screen.queryByText("本题答错", { exact: false })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "查看作答 · 题组 1 第 3 题" })).toBeDisabled();
});

it.each([
  { change: { hintedBeforeSubmission: true }, expected: "使用提示后作答；不作为独立检查的支持。" },
  { change: { answerAvailability: "available_before_submission" as const }, expected: "作答前答案已可获得；不作为独立检查的支持。" },
  { change: { repetition: "known_repeat" as const }, expected: "已知重复题；不能单独证明在新情境中也能运用。" },
  { change: { answerAvailability: "unknown" as const }, expected: "此前帮助或重复情况不明，保留判断。" },
  { change: { quality: "disputed" as const }, expected: "题目有疑问，已排除。" },
])("distinguishes assistance, repetition, unknowns and disputes: $expected", ({ change, expected }) => {
  mount({ ...assessment, objectives: [{ ...assessment.objectives[0], evidence: [{ ...evidence, correct: true, ...change }] }] });
  fireEvent.click(screen.getByText("查看依据与来源", { selector: "summary" }));
  expect(screen.getByText(expected)).toBeVisible();
  expect(screen.queryByText("本题答对，应用内未记录首答前的提示或提前看答案。")).not.toBeInTheDocument();
});

it("keeps stopping reason separate from current support and long-term mastery", () => {
  mount({ ...assessment, stopReason: "用户主动结束本轮。" }, { ended: true });
  const result = within(screen.getByRole("region", { name: "本轮判断" }));
  expect(result.getByText("部分目标已有支持，仍需巩固。")).toBeVisible();
  expect(result.getByText("停止原因：用户主动结束本轮。")).toBeVisible();
  expect(result.getByText(/长期掌握尚未验证/)).toBeVisible();
});

it("opens actual parsed source binding at its physical page and never treats a PDF text paragraph as page number", () => {
  const parsed = { documentId: "document-one", version: 1, blockId: "block-one", physicalPage: 8, sourceHash: "synthetic" };
  const bound = { ...assessment, objectives: [{ ...assessment.objectives[0], evidence: [{ ...evidence, sources: [{ ...source, parsed }] }] }] };
  const view = mount(bound, { pdf: true });
  fireEvent.click(screen.getByText("查看依据与来源", { selector: "summary" }));
  fireEvent.click(screen.getByRole("button", { name: "查看目标原文 1" }));
  expect(onSource).toHaveBeenLastCalledWith("material-one", 8, parsed);
  view.unmount();
  mount(assessment, { pdf: true });
  fireEvent.click(screen.getByText("查看依据与来源", { selector: "summary" }));
  expect(screen.queryByRole("button", { name: "查看目标原文 1" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "查看来源材料 1" }));
  expect(onSource).toHaveBeenLastCalledWith("material-one", 1, undefined);
});

it("opens authorized history as history, without claiming a missing link means the student never submitted", () => {
  const view = mount(assessment, { historical: true });
  fireEvent.click(screen.getByText("查看依据与来源", { selector: "summary" }));
  fireEvent.click(screen.getByRole("button", { name: "查看历史作答 · 第 3 题" }));
  expect(onReview).toHaveBeenLastCalledWith(evidence.ref);
  view.unmount();
  mount(assessment, { unavailable: true });
  fireEvent.click(screen.getByText("查看依据与来源", { selector: "summary" }));
  expect(screen.getByText("本题答错，可能存在需要进一步区分的问题。")).toBeVisible();
  expect(screen.queryByText("尚未完成作答，不据此判断。")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "原题组当前不可打开" })).toBeDisabled();
});
