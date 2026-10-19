import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LearningAgentPanel } from "./learning-agent-panel";
import { learningAgentApi, type LearningAgentTaskView } from "@/lib/client/learning-agent-api";
import { learningApi, LearningApiError } from "@/lib/client/learning-api";
import type { LearningAgentReviewSummary } from "@/lib/domain/learning-agent";
import type { FrameworkChapter } from "@/lib/domain/learning-framework";
import type { QuizAttemptView } from "@/lib/domain/learning-quiz";
import type { LearningCompletionAssessment } from "@/lib/domain/learning-agent-completion";

vi.mock("@/lib/client/learning-agent-api", async original => ({ ...await original<typeof import("@/lib/client/learning-agent-api")>(), learningAgentApi: { list: vi.fn(), start: vi.fn(), control: vi.fn() } }));
vi.mock("@/lib/client/learning-api", async original => ({ ...await original<typeof import("@/lib/client/learning-api")>(), learningApi: { framework: vi.fn(), quizzes: vi.fn() } }));
const quizCallbacks = vi.hoisted(() => ({ saved: undefined as ((attempt: QuizAttemptView) => void) | undefined }));
vi.mock("./learning-quiz", () => ({ LearningQuiz: ({ openQuizId, embedded, onAttemptSaved, openReview }: { openQuizId?: string; embedded?: boolean; onAttemptSaved?: (attempt: QuizAttemptView) => void; openReview?: { index: number; requestId: string } }) => {
  quizCallbacks.saved = onAttemptSaved;
  return <div data-testid="inline-quiz" data-embedded={String(embedded)} data-review-index={openReview?.index}>题组与解析 {openQuizId}</div>;
} }));
const attempt = (completed = true): QuizAttemptView => ({ id: "attempt-one", quizId: "quiz-one", title: "合成诊断", mode: "practice", revision: completed ? 2 : 1,
  completed, createdAt: "", completedAt: completed ? "2026-10-15T00:00:00Z" : null, questions: [], score: completed ? { correct: 1, total: 1, unassistedCorrect: 1, hinted: 0, revealed: 0, skipped: 0 } : null });
const savedTask = (task: LearningAgentTaskView): LearningAgentTaskView => ({ ...task, quizLinks: task.quizLinks?.map(link => ({ ...link, completed: true })) });
const materials = [
  { id: "material-one", title: "合成概率教材", kind: "text" as const, byteLength: 40, createdAt: "", filename: null, selected: true },
  { id: "material-two", title: "未选择的材料", kind: "text" as const, byteLength: 20, createdAt: "", filename: null, selected: false },
];
const chapter: FrameworkChapter = { id: "chapter-one", runId: "framework-one", revision: 1, title: "概率", explanation: "", edited: false, nodes: [
  { id: "node-one", title: "条件概率", explanation: "", supplement: null, note: "", edited: false, sources: [{ materialId: "material-one", paragraph: 1, start: 0, end: 40, originalSha256: "synthetic", paragraphSha256: "synthetic" }] },
] };
const scope = { materialIds: ["material-one"], chapterIds: [], nodeIds: [], includeHistory: false, includeNotes: false, includeSupplements: false };
const waiting: LearningAgentTaskView = { id: "task-one", goal: "检查条件概率的理解", scope, status: "waiting", wait: { kind: "quiz_submission", refId: "attempt-one", message: "请完成诊断题组后继续。" }, actions: [{ id: "action-one", tool: "learning.create_quiz", status: "succeeded", summary: "已保存诊断题组", resultRef: { kind: "learning.quiz", id: "quiz-one" } }], quizLinks: [{ quizId: "quiz-one", attemptId: "attempt-one" }] };
const saveSelection = vi.fn(), onSource = vi.fn();
function mount() { return render(<LearningAgentPanel pageId="page-one" materials={materials} selected={["material-one"]} disabled={false} saveSelection={saveSelection} onSource={onSource} />); }
beforeEach(() => {
  vi.clearAllMocks(); quizCallbacks.saved = undefined; vi.mocked(learningAgentApi.control).mockReset(); window.history.replaceState(null, "", "/learning/page-one?view=agent");
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [] });
  vi.mocked(learningApi.framework).mockResolvedValue({ framework: { chapters: [chapter], runs: [], overview: [] } });
  vi.mocked(learningApi.quizzes).mockResolvedValue({ quizzes: [] });
  vi.mocked(learningAgentApi.start).mockResolvedValue({ task: waiting });
  saveSelection.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("requires a goal and visible scope confirmation, with history, notes and supplements excluded by default", async () => {
  mount(); const start = await screen.findByRole("button", { name: "明确开始复习" });
  expect(start).toBeDisabled();
  for (const checkbox of screen.getAllByRole("checkbox")) expect(checkbox).not.toBeChecked();
  expect(screen.getByText("本次材料：合成概率教材")).toBeVisible();
  expect(learningAgentApi.start).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("复习目标"), { target: { value: "  检查条件概率的理解  " } });
  fireEvent.click(start);
  await screen.findByText("复习范围：合成概率教材");
  expect(saveSelection).toHaveBeenCalledOnce();
  expect(learningAgentApi.start).toHaveBeenCalledExactlyOnceWith("page-one", { id: expect.any(String), goal: waiting.goal, scope });
});

it("requires explicit node selection and sends only that narrow scope plus checked permissions", async () => {
  mount(); await screen.findByRole("button", { name: "明确开始复习" });
  fireEvent.change(screen.getByLabelText("复习目标"), { target: { value: "我不懂条件概率" } });
  fireEvent.change(screen.getByLabelText("复习范围"), { target: { value: "nodes" } });
  expect(screen.getByRole("button", { name: "明确开始复习" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "条件概率" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "允许读取本范围的相关作答历史" }));
  fireEvent.click(screen.getByRole("button", { name: "明确开始复习" }));
  await waitFor(() => expect(learningAgentApi.start).toHaveBeenCalledOnce());
  expect(vi.mocked(learningAgentApi.start).mock.calls[0][1].scope).toEqual({ ...scope, materialIds: [], nodeIds: ["node-one"], includeHistory: true });
  expect(saveSelection).not.toHaveBeenCalled();
});

it.each([
  { status: "ended" as const, reason: "本轮检查完成；仍需结合原文判断。", displayedReason: "本轮检查完成；仍需结合原文判断。" },
  { status: "budget_exhausted" as const, reason: "本轮复习的输入内容过长，已有内容已保留。你可以缩小范围后开始新的复习。", displayedReason: "本轮复习的输入内容过长，已有内容已保留。你可以缩小范围后开始新的复习。" },
])("restores waiting tasks without extra requests and shows a product-facing $status result after automatic saved-attempt synchronization", async ({ status, reason, displayedReason }) => {
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [waiting] });
  vi.mocked(learningAgentApi.control).mockResolvedValue({ task: { ...waiting, status, wait: null, endReason: reason, usage, budget } });
  mount(); await screen.findByTestId("inline-quiz");
  const nextStep = within(screen.getByRole("region", { name: "接下来" }));
  expect(nextStep.getByText(waiting.wait!.message)).toBeVisible();
  expect(screen.getByTestId("inline-quiz")).toHaveAttribute("data-embedded", "true");
  expect(screen.queryByRole("button", { name: "已完成作答，继续复习" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /打开题组/ })).not.toBeInTheDocument();
  for (const name of ["调整本轮复习", "取消任务"]) {
    expect(nextStep.queryByRole("button", { name })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name })).toBeEnabled();
  }
  vi.useFakeTimers(); await act(async () => { await vi.advanceTimersByTimeAsync(10000); }); vi.useRealTimers();
  expect(learningAgentApi.list).toHaveBeenCalledOnce();
  expect(learningAgentApi.start).not.toHaveBeenCalled(); expect(learningAgentApi.control).not.toHaveBeenCalled();
  await act(async () => { quizCallbacks.saved!(attempt()); });
  await screen.findByText(displayedReason);
  expect(learningAgentApi.control).toHaveBeenCalledExactlyOnceWith("page-one", { id: "task-one", action: "sync_quiz", expectedVersion: 1, eventId: expect.any(String), attemptId: "attempt-one" });
  expect(screen.queryByRole("button", { name: "取消任务" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "开始另一项复习" })).toBeEnabled();
  expect(screen.getByRole("region", { name: "复习向导" })).not.toHaveTextContent(/预算|调用|决策|tokens|已掌握/);
});

it.each([undefined, null, "", "本任务预算耗尽，已停止；等待用户的时间不计入计算预算。"])("keeps a legacy execution limit honest when the saved reason is %s", async endReason => {
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [{ ...waiting, status: "budget_exhausted", wait: null, endReason, usage, budget }] });
  mount();
  expect(await screen.findByText("本轮复习因执行限制停止，旧记录未保存具体原因。已有内容已保留，你可以开始新的复习。")).toBeVisible();
  expect(screen.getByRole("button", { name: "开始另一项复习" })).toBeEnabled();
  expect(screen.getByRole("region", { name: "复习向导" })).not.toHaveTextContent(/单次上限|次数已用完|500|计算预算/);
  expect(learningAgentApi.start).not.toHaveBeenCalled();
  expect(learningAgentApi.control).not.toHaveBeenCalled();
});

it("reuses an uncertain control receipt and prevents an unrelated action until it is reconciled", async () => {
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [waiting] });
  vi.mocked(learningAgentApi.control).mockRejectedValueOnce(new LearningApiError(503, "request_failed")).mockResolvedValueOnce({ task: { ...waiting, status: "paused" } });
  mount(); fireEvent.click(await screen.findByRole("button", { name: "暂停任务" }));
  await screen.findByRole("button", { name: "核对本次任务操作" });
  expect(screen.getByRole("button", { name: "取消任务" })).toBeDisabled();
  const first = vi.mocked(learningAgentApi.control).mock.calls[0][1];
  fireEvent.click(screen.getByRole("button", { name: "核对本次任务操作" }));
  await screen.findByRole("button", { name: "继续任务" });
  expect(vi.mocked(learningAgentApi.control).mock.calls[1][1]).toEqual(first);
  expect(screen.getByRole("status")).toHaveTextContent("已暂停");
});

it("polls read-only after a scheduled waiting response, observes execution, then stops at the next wait", async () => {
  const running = { ...waiting, status: "running" as const, wait: null };
  const next = { ...waiting, wait: { kind: "feedback", message: "现在还有哪里不清楚？" }, actions: [...waiting.actions, { id: "action-two", tool: "learning.read_answers", status: "succeeded", summary: "已读回实际保存的作答与评分。" }] };
  vi.mocked(learningAgentApi.list).mockResolvedValueOnce({ tasks: [waiting] }).mockResolvedValueOnce({ tasks: [running] }).mockResolvedValue({ tasks: [next] });
  vi.mocked(learningAgentApi.control).mockResolvedValue({ task: savedTask(waiting), scheduled: true });
  mount(); await screen.findByTestId("inline-quiz");
  vi.useFakeTimers();
  await act(async () => { quizCallbacks.saved!(attempt()); });
  expect(screen.getByText("反馈已受理，正在读取任务进度…")).toBeVisible();
  expect(screen.queryByRole("button", { name: "已完成作答，继续复习" })).not.toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(screen.getByText("正在复习", { exact: true })).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(screen.getByText("现在还有哪里不清楚？")).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(learningAgentApi.list).toHaveBeenCalledTimes(3);
  expect(learningAgentApi.control).toHaveBeenCalledOnce();
});

it("lets the user dispute a pending question without injecting scores or changing saved quiz answers", async () => {
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [waiting] });
  vi.mocked(learningAgentApi.control).mockResolvedValue({ task: { ...waiting, status: "paused", wait: null, quizLinks: [{ quizId: "quiz-one", attemptId: "attempt-one", disputed: true }] } });
  mount(); await screen.findByLabelText("说明题目疑问");
  const question = screen.getByLabelText("说明题目疑问");
  expect(question).not.toBeVisible();
  fireEvent.click(screen.getByText("这组题有疑问", { selector: "summary" }));
  expect(question).toBeVisible(); expect(question).toBeEnabled();
  expect(screen.getByRole("button", { name: "提交疑问并暂停" })).toBeDisabled();
  fireEvent.change(question, { target: { value: "第一题似乎漏了前提，请先核对原文。" } });
  fireEvent.click(screen.getByRole("button", { name: "提交疑问并暂停" }));
  await screen.findByText("这组题已标记为有疑问，不再用它的成绩判断薄弱点。已有作答保持原样。");
  expect(learningAgentApi.control).toHaveBeenCalledExactlyOnceWith("page-one", { id: "task-one", action: "dispute_quiz", expectedVersion: 1, eventId: expect.any(String), attemptId: "attempt-one", feedback: "第一题似乎漏了前提，请先核对原文。" });
  expect(screen.getByRole("status")).toHaveTextContent("已暂停");
});

it("shows task explanations as task content and sends subsequent feedback without saving a personal note", async () => {
  const explain: LearningAgentTaskView = { ...waiting, wait: { kind: "feedback", message: "这个解释是否有帮助？" }, quizLinks: [], explanations: [{ id: "explanation-one", text: "[合成解释] 条件概率限定了当前样本空间。", sources: [{ materialId: "material-one", paragraph: 1 }] }] };
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [explain] });
  vi.mocked(learningAgentApi.control).mockResolvedValue({ task: { ...explain, status: "cancelled", endReason: "用户取消", wait: null } });
  mount(); await screen.findByText(explain.explanations![0].text);
  expect(screen.getByText("本轮讲解 1", { selector: "summary" })).toBeVisible();
  expect(screen.getByText("本轮讲解根据本轮授权材料生成，随本轮保存，不会自动写入个人笔记；材料外补充会明确标注。")).toBeVisible();
  expect(screen.queryByText(/任务内解释/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "批准追加到个人笔记" })).not.toBeInTheDocument();
  expect(learningAgentApi.control).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "查看引用原文 1" })); expect(onSource).toHaveBeenCalledExactlyOnceWith("material-one", 1, undefined);
  fireEvent.change(screen.getByLabelText("你的反馈"), { target: { value: "明白了，这轮先结束" } });
  fireEvent.click(screen.getByRole("button", { name: "提交反馈并继续" }));
  await screen.findByText("用户取消");
  expect(learningAgentApi.control).toHaveBeenCalledExactlyOnceWith("page-one", { id: "task-one", action: "feedback", expectedVersion: 1, eventId: expect.any(String), feedback: "明白了，这轮先结束" });
  expect(screen.queryByText(/已经学会/)).not.toBeInTheDocument();
});

it("clears private task content when authentication is lost during a refresh", async () => {
  vi.mocked(learningAgentApi.list).mockResolvedValueOnce({ tasks: [waiting] }).mockRejectedValueOnce(new LearningApiError(401, "unauthenticated"));
  mount(); await screen.findByRole("heading", { name: waiting.goal });
  fireEvent.click(screen.getByRole("button", { name: "刷新任务" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("heading", { name: waiting.goal })).not.toBeInTheDocument();
  expect(screen.queryByText("已保存诊断题组")).not.toBeInTheDocument();
});

it("opens a PDF explanation reference at its physical page with the original parsed binding", async () => {
  const parsed = { documentId: "parsed-one", version: 1, blockId: "block-one", physicalPage: 2, sourceHash: "synthetic" };
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [{ ...waiting, wait: { kind: "feedback", message: "查看原页核对解释。" },
    explanations: [{ id: "pdf-explanation", text: "合成 PDF 解释", sources: [{ materialId: "material-one", paragraph: 17, parsed }] }] }] });
  mount(); fireEvent.click(await screen.findByRole("button", { name: "查看引用原文 1" }));
  expect(onSource).toHaveBeenCalledExactlyOnceWith("material-one", 2, parsed);
});

it("retains the same start identity after an unknown response without changing the original selected permissions", async () => {
  vi.mocked(learningAgentApi.start).mockRejectedValueOnce(new Error("network outcome unknown")).mockResolvedValueOnce({ task: waiting });
  mount(); await screen.findByRole("button", { name: "明确开始复习" });
  fireEvent.change(screen.getByLabelText("复习目标"), { target: { value: waiting.goal } });
  fireEvent.click(screen.getByRole("button", { name: "明确开始复习" }));
  await screen.findByRole("button", { name: "核对本次任务是否已开始" });
  expect(screen.getByLabelText("复习目标")).toBeDisabled();
  const input = vi.mocked(learningAgentApi.start).mock.calls[0][1];
  fireEvent.click(screen.getByRole("button", { name: "核对本次任务是否已开始" }));
  await screen.findByRole("heading", { name: waiting.goal });
  expect(vi.mocked(learningAgentApi.start).mock.calls[1][1]).toEqual(input);
  expect(within(screen.getByRole("region", { name: "复习向导" })).getByText(/不代表已经掌握/)).toBeVisible();
});

it("reports a missing decision configuration as a known blocker without locking the form behind an unknown receipt", async () => {
  vi.mocked(learningAgentApi.start).mockRejectedValueOnce(new LearningApiError(503, "agent_not_configured"));
  mount(); await screen.findByRole("button", { name: "明确开始复习" });
  fireEvent.change(screen.getByLabelText("复习目标"), { target: { value: waiting.goal } });
  fireEvent.click(screen.getByRole("button", { name: "明确开始复习" }));
  await screen.findByText("复习向导暂时不可用，你仍可阅读材料或自行练习。");
  expect(screen.getByLabelText("复习目标")).toBeEnabled();
  expect(screen.queryByRole("button", { name: "核对本次任务是否已开始" })).not.toBeInTheDocument();
  expect(learningAgentApi.start).toHaveBeenCalledOnce();
});

const usage = { calls: 7, inputTokens: 120, outputTokens: 80, unknownUsageCalls: 1, computeMs: 4000, steps: 4 };
const budget = { maxCalls: 12, maxInputChars: 48000, maxOutputTokens: 8000, maxComputeMs: 60000, maxSteps: 9, maxNoProgress: 2 };
const approval: NonNullable<LearningAgentTaskView["approval"]> = {
  id: "approval-one", actionId: "note-action", taskVersion: 2, tool: "learning.append_note", status: "pending", createdAt: "",
  title: "确认追加个人笔记", summary: "仅追加这条合成解释。", target: "概率 / 条件概率", content: "[合成笔记] 条件概率缩小了考察范围。",
  sourceFingerprint: "synthetic-source", fingerprint: "synthetic-confirmation", sources: [{ materialId: "material-one", paragraph: 1 }], includesSupplement: false,
};
const confirming: LearningAgentTaskView = { ...waiting, version: 2, quizLinks: [], approval, wait: { kind: "confirmation", refId: approval.id, message: "请确认这项笔记提议。" }, usage, budget };

it("previews the exact scope changes before sending one versioned adjustment without displaying execution metadata", async () => {
  const original = { ...waiting, version: 2, usage: { ...usage, computeEstimated: true }, budget, scope: { ...scope, includeHistory: true, includeNotes: true, includeSupplements: true } };
  const revisedScope = { ...scope, materialIds: ["material-two"], chapterIds: ["chapter-one"], nodeIds: ["node-one"] };
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [original] });
  vi.mocked(learningAgentApi.control).mockResolvedValue({ task: { ...original, version: 3, goal: "只复习新的明确范围", scope: revisedScope, status: "paused" } });
  mount(); fireEvent.click(await screen.findByRole("button", { name: "调整本轮复习" }));
  fireEvent.change(screen.getByLabelText("新的复习目标"), { target: { value: "只复习新的明确范围" } });
  for (const name of ["合成概率教材", "未选择的材料", "概率", "条件概率", "允许读取本范围的相关作答历史", "纳入本范围的个人笔记", "允许本范围的材料外补充解释"]) {
    fireEvent.click(screen.getByRole("checkbox", { name }));
  }
  expect(screen.queryByRole("button", { name: "确认调整本轮复习" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "取消任务" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "预览本轮调整" }));
  const preview = screen.getByRole("region", { name: "调整前后预览" });
  expect(within(preview).getByRole("region", { name: "调整前" })).toHaveTextContent("材料：合成概率教材");
  const after = within(preview).getByRole("region", { name: "调整后" });
  expect(after).toHaveTextContent("材料：未选择的材料");
  expect(after).toHaveTextContent("相关历史：不读取；个人笔记：未纳入；材料外补充：不允许");
  expect(preview).not.toHaveTextContent(/版本|预算|调用|决策|计算时间|步数/);
  expect(learningAgentApi.control).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认调整本轮复习" }));
  await screen.findByRole("heading", { name: "只复习新的明确范围" });
  expect(learningAgentApi.control).toHaveBeenCalledExactlyOnceWith("page-one", { id: waiting.id, action: "adjust", expectedVersion: 2, eventId: expect.any(String), goal: "只复习新的明确范围", scope: revisedScope });
  expect(screen.getByRole("status")).toHaveTextContent("已暂停");
  expect(screen.getByRole("region", { name: "复习向导" })).not.toHaveTextContent(/试用|预算|调用|决策|tokens|模型请求|本轮版本|行动记录|结果 ID|learning\.create_quiz/i);
  expect(screen.queryByText(waiting.actions[0].summary)).not.toBeInTheDocument();
  expect(screen.queryByLabelText("新的复习目标")).not.toBeInTheDocument();
});

it("keeps a stale adjustment draft and requires a fresh before/after comparison after a version conflict", async () => {
  vi.mocked(learningAgentApi.list).mockResolvedValueOnce({ tasks: [waiting] }).mockResolvedValue({ tasks: [{ ...waiting, version: 2, goal: "另一窗口的新目标" }] });
  vi.mocked(learningAgentApi.control).mockRejectedValueOnce(new LearningApiError(409, "agent_version_conflict")).mockResolvedValueOnce({ task: { ...waiting, version: 3, goal: "我尚未提交的草稿", status: "paused" } });
  mount(); fireEvent.click(await screen.findByRole("button", { name: "调整本轮复习" }));
  fireEvent.change(screen.getByLabelText("新的复习目标"), { target: { value: "我尚未提交的草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "预览本轮调整" }));
  fireEvent.click(screen.getByRole("button", { name: "确认调整本轮复习" }));
  await screen.findByText(/你的调整草稿已保留/);
  expect(screen.getByLabelText("新的复习目标")).toHaveValue("我尚未提交的草稿");
  fireEvent.click(screen.getByRole("button", { name: "刷新并保留草稿" }));
  await screen.findByText("本轮复习已在其他地方更新。请先核对最新目标和范围，再提交你的调整。");
  expect(screen.getByLabelText("新的复习目标")).toHaveValue("我尚未提交的草稿");
  expect(screen.getByRole("button", { name: "确认调整本轮复习" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "按最新内容重新比对" }));
  expect(screen.queryByRole("button", { name: "确认调整本轮复习" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "预览本轮调整" }));
  expect(screen.getByRole("region", { name: "调整前" })).toHaveTextContent("目标：另一窗口的新目标");
  expect(screen.getByRole("region", { name: "调整后" })).toHaveTextContent("目标：我尚未提交的草稿");
  fireEvent.click(screen.getByRole("button", { name: "确认调整本轮复习" }));
  await screen.findByRole("heading", { name: "我尚未提交的草稿" });
  expect(vi.mocked(learningAgentApi.control).mock.calls[1][1]).toMatchObject({ action: "adjust", expectedVersion: 2, goal: "我尚未提交的草稿" });
});

it("restores the exact pending note for review without approval calls and reconciles an unknown approval using one receipt", async () => {
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [confirming] });
  vi.mocked(learningAgentApi.control).mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce({ task: { ...confirming, status: "ended", wait: null, approval: undefined, endReason: "已按确认内容追加个人笔记。" } });
  mount(); const proposal = await screen.findByRole("region", { name: "待确认笔记" });
  expect(proposal).toHaveTextContent(approval.target); expect(proposal).toHaveTextContent(approval.content);
  expect(proposal).toHaveTextContent("材料外补充：不包含");
  expect(screen.queryByLabelText("你的反馈")).not.toBeInTheDocument();
  expect(learningAgentApi.control).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "查看笔记引用原文 1" }));
  expect(onSource).toHaveBeenCalledExactlyOnceWith("material-one", 1, undefined);
  fireEvent.click(screen.getByRole("button", { name: "批准追加到个人笔记" }));
  await screen.findByRole("button", { name: "核对本次任务操作" });
  expect(screen.getByRole("button", { name: "拒绝这项笔记提议" })).toBeDisabled();
  const input = vi.mocked(learningAgentApi.control).mock.calls[0][1];
  expect(input).toEqual({ id: waiting.id, action: "approval", expectedVersion: 2, approvalId: approval.id, fingerprint: approval.fingerprint, decision: "approve", eventId: expect.any(String) });
  fireEvent.click(screen.getByRole("button", { name: "核对本次任务操作" }));
  await screen.findByText("已按确认内容追加个人笔记。");
  expect(vi.mocked(learningAgentApi.control).mock.calls[1][1]).toEqual(input);
  expect(screen.queryByRole("region", { name: "待确认笔记" })).not.toBeInTheDocument();
});

it("rejects a proposed supplement without sending text or a note write and hides stale approvals", async () => {
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [{ ...confirming, approval: { ...approval, includesSupplement: true } }] });
  vi.mocked(learningAgentApi.control).mockResolvedValue({ task: { ...confirming, status: "paused", approval: undefined,
    endReason: "用户已拒绝这项提案；原行动不会作为生成失败重试。" } });
  mount(); await screen.findByText("材料外补充：包含，已明确标注。");
  fireEvent.click(screen.getByRole("button", { name: "拒绝这项笔记提议" }));
  await screen.findByText("你已拒绝这项笔记建议，可以调整复习或结束本轮。");
  expect(screen.getByRole("region", { name: "复习向导" })).not.toHaveTextContent("生成失败重试");
  await waitFor(() => expect(screen.queryByRole("region", { name: "待确认笔记" })).not.toBeInTheDocument());
  expect(learningAgentApi.control).toHaveBeenCalledExactlyOnceWith("page-one", { id: waiting.id, action: "approval", expectedVersion: 2, approvalId: approval.id, fingerprint: approval.fingerprint, decision: "reject", eventId: expect.any(String) });
  expect(screen.queryByRole("region", { name: "待确认笔记" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("你的反馈")).not.toBeInTheDocument();
});

it("offers readback, not business replay, for an unknown result even if retry is accidentally advertised", async () => {
  const unknown: LearningAgentTaskView = { ...waiting, version: 4, status: "needs_attention", wait: null, recovery: { kind: "unknown", message: "请求结果未知。", actionId: "action-one", allowedControls: ["inspect", "retry", "cancel"] } };
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [unknown] });
  vi.mocked(learningAgentApi.control).mockResolvedValue({ task: unknown });
  mount(); await screen.findByText("结果未知，先核对原操作");
  expect(screen.queryByRole("button", { name: /重试|执行尚未开始|继续已核对/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "继续任务" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "核对原操作结果" }));
  await waitFor(() => expect(learningAgentApi.control).toHaveBeenCalledExactlyOnceWith("page-one", { id: waiting.id, action: "recover", expectedVersion: 4, mode: "inspect", eventId: expect.any(String) }));
  expect(learningAgentApi.start).not.toHaveBeenCalled();
});

it.each([
  ["known_failed", "重试明确失败的操作"], ["not_started", "执行尚未开始的操作"],
] as const)("uses the permitted recovery for %s with the current version", async (kind, label) => {
  const blocked: LearningAgentTaskView = { ...waiting, version: 2, status: "needs_attention", wait: null, recovery: { kind, message: "合成可核对的中断。", allowedControls: ["inspect", "retry", "cancel"] } };
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [blocked] });
  vi.mocked(learningAgentApi.control).mockResolvedValue({ task: { ...blocked, status: "paused" } });
  mount(); fireEvent.click(await screen.findByRole("button", { name: label }));
  await waitFor(() => expect(learningAgentApi.control).toHaveBeenCalledExactlyOnceWith("page-one", { id: waiting.id, action: "recover", expectedVersion: 2, mode: "retry", eventId: expect.any(String) }));
});

it("lets a changed source be explicitly removed before reconfirmation and never offers replay", async () => {
  const invalid: LearningAgentTaskView = { ...waiting, version: 2, scope: { ...scope, materialIds: ["removed-material"] }, status: "needs_attention", wait: null, recovery: { kind: "source_invalid", message: "已删除一个来源。", allowedControls: ["adjust", "cancel"] } };
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [invalid] });
  mount(); fireEvent.click(await screen.findByRole("button", { name: "重新确认本轮范围" }));
  expect(screen.queryByRole("button", { name: /重试明确失败/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", { name: "已不可用的来源（取消勾选以撤销授权）" }));
  expect(screen.getByRole("button", { name: "预览本轮调整" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "条件概率" }));
  fireEvent.click(screen.getByRole("button", { name: "预览本轮调整" }));
  expect(screen.getByRole("region", { name: "调整后" })).toHaveTextContent("知识点：条件概率");
  expect(learningAgentApi.control).not.toHaveBeenCalled();
});

it("requires an explicit continue after an inspected result returns ready", async () => {
  const ready: LearningAgentTaskView = { ...waiting, version: 3, status: "ready", wait: null, recovery: undefined };
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [ready] });
  vi.mocked(learningAgentApi.control).mockResolvedValue({ task: { ...waiting, version: 3 } });
  mount(); await screen.findByRole("button", { name: "继续任务" });
  expect(learningAgentApi.control).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "继续任务" }));
  await screen.findByText(waiting.wait!.message);
  expect(screen.getByTestId("inline-quiz")).toHaveTextContent("quiz-one");
  expect(learningAgentApi.control).toHaveBeenCalledExactlyOnceWith("page-one", { id: waiting.id, action: "resume", expectedVersion: 3, eventId: expect.any(String) });
  expect(screen.queryByRole("button", { name: "继续任务" })).not.toBeInTheDocument();
});

it("does not advance incomplete or unrelated saves and synchronizes a completed attempt only once across rereads and refreshes", async () => {
  vi.mocked(learningAgentApi.list).mockResolvedValueOnce({ tasks: [waiting] }).mockResolvedValue({ tasks: [savedTask(waiting)] });
  vi.mocked(learningAgentApi.control).mockResolvedValue({ task: savedTask(waiting) });
  mount(); await screen.findByTestId("inline-quiz");
  await act(async () => { quizCallbacks.saved!(attempt(false)); quizCallbacks.saved!({ ...attempt(), id: "unrelated-attempt" }); });
  expect(learningAgentApi.control).not.toHaveBeenCalled();
  await act(async () => { quizCallbacks.saved!(attempt()); });
  await waitFor(() => expect(learningAgentApi.control).toHaveBeenCalledOnce());
  await act(async () => { quizCallbacks.saved!(attempt()); quizCallbacks.saved!(attempt()); });
  fireEvent.click(screen.getByRole("button", { name: "刷新任务" }));
  await waitFor(() => expect(learningAgentApi.list).toHaveBeenCalledTimes(2));
  expect(learningAgentApi.control).toHaveBeenCalledOnce();
  expect(vi.mocked(learningAgentApi.control).mock.calls[0][1]).toMatchObject({ action: "sync_quiz", attemptId: "attempt-one", expectedVersion: 1 });
  expect(screen.getByTestId("inline-quiz")).toHaveTextContent("quiz-one");
  expect(screen.queryByRole("button", { name: /已完成作答|返回复习向导/ })).not.toBeInTheDocument();
});

it("reconciles a restored server-completed attempt automatically without waiting for another quiz save", async () => {
  const completed = savedTask(waiting);
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [completed] });
  vi.mocked(learningAgentApi.control).mockResolvedValue({ task: completed });
  mount(); await waitFor(() => expect(learningAgentApi.control).toHaveBeenCalledOnce());
  expect(learningAgentApi.control).toHaveBeenCalledExactlyOnceWith("page-one", { id: waiting.id, action: "sync_quiz", expectedVersion: 1, attemptId: "attempt-one", eventId: expect.any(String) });
  fireEvent.click(screen.getByRole("button", { name: "刷新任务" }));
  await waitFor(() => expect(learningAgentApi.list).toHaveBeenCalledTimes(2));
  expect(learningAgentApi.control).toHaveBeenCalledOnce();
});

it.each(["paused", "cancelled", "version_changed"] as const)("does not let an old quiz callback advance a task after %s", async status => {
  const updated: LearningAgentTaskView = status === "version_changed"
    ? { ...waiting, version: 2, goal: "已调整的目标" }
    : { ...waiting, status, wait: null };
  vi.mocked(learningAgentApi.list).mockResolvedValueOnce({ tasks: [waiting] }).mockResolvedValue({ tasks: [updated] });
  vi.mocked(learningAgentApi.control).mockResolvedValue({ task: updated });
  mount(); await screen.findByTestId("inline-quiz"); const oldCallback = quizCallbacks.saved!;
  fireEvent.click(screen.getByRole("button", { name: status === "paused" ? "暂停任务" : status === "cancelled" ? "取消任务" : "刷新任务" }));
  if (status === "version_changed") await screen.findByRole("heading", { name: updated.goal });
  else await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(status === "paused" ? "已暂停" : "用户已取消"));
  await act(async () => { oldCallback(attempt()); });
  expect(vi.mocked(learningAgentApi.control).mock.calls.filter(([, input]) => input.action === "sync_quiz")).toHaveLength(0);
  expect(learningAgentApi.control).toHaveBeenCalledTimes(status === "version_changed" ? 0 : 1);
});

it("keeps completed explanations visible when a next quiz arrives until the user switches it", async () => {
  const next: LearningAgentTaskView = { ...savedTask(waiting), wait: { kind: "quiz_submission", refId: "attempt-two", message: "下一组练习已生成。" },
    quizLinks: [...savedTask(waiting).quizLinks!, { quizId: "quiz-two", attemptId: "attempt-two", completed: false }] };
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [waiting] });
  vi.mocked(learningAgentApi.control).mockResolvedValue({ task: next });
  mount(); await screen.findByTestId("inline-quiz");
  await act(async () => { quizCallbacks.saved!(attempt()); });
  await screen.findByText("下一组练习已准备好，可在本轮练习中切换查看。");
  expect(screen.getByTestId("inline-quiz")).toHaveTextContent("quiz-one");
  expect(screen.getByRole("button", { name: "查看题组 1" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "查看题组 2" }));
  expect(screen.getByTestId("inline-quiz")).toHaveTextContent("quiz-two");
  expect(learningAgentApi.control).toHaveBeenCalledOnce();
});

it("retains the saved quiz and retries the original synchronization receipt after a lost response", async () => {
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [waiting] });
  vi.mocked(learningAgentApi.control).mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce({ task: { ...savedTask(waiting), status: "running", wait: null } });
  mount(); await screen.findByTestId("inline-quiz");
  await act(async () => { quizCallbacks.saved!(attempt()); });
  await screen.findByText("作答已保存，自动衔接尚未确认。可以核对衔接状态，无需重新作答。");
  expect(screen.getByTestId("inline-quiz")).toHaveTextContent("quiz-one");
  expect(screen.getByRole("button", { name: "暂停任务" })).toBeDisabled();
  const receipt = vi.mocked(learningAgentApi.control).mock.calls[0][1];
  await act(async () => { quizCallbacks.saved!(attempt()); });
  expect(learningAgentApi.control).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "核对本次任务操作" }));
  await screen.findByText("作答已保存，复习向导正在根据这次结果准备下一步。解析会继续保留。");
  expect(vi.mocked(learningAgentApi.control).mock.calls[1][1]).toEqual(receipt);
  expect(screen.queryByText("作答已保存，自动衔接尚未确认。可以核对衔接状态，无需重新作答。")).not.toBeInTheDocument();
});

it("offers an explicit synchronization retry with the same event after a known conflict instead of an automatic loop", async () => {
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [waiting] });
  vi.mocked(learningAgentApi.control).mockRejectedValueOnce(new LearningApiError(409, "agent_busy")).mockResolvedValueOnce({ task: { ...savedTask(waiting), status: "running", wait: null } });
  mount(); await screen.findByTestId("inline-quiz");
  await act(async () => { quizCallbacks.saved!(attempt()); });
  const retry = await screen.findByRole("button", { name: "核对作答衔接" });
  const receipt = vi.mocked(learningAgentApi.control).mock.calls[0][1];
  expect(learningAgentApi.control).toHaveBeenCalledOnce();
  fireEvent.click(retry);
  await waitFor(() => expect(learningAgentApi.control).toHaveBeenCalledTimes(2));
  expect(vi.mocked(learningAgentApi.control).mock.calls[1][1]).toEqual(receipt);
});

it.each(["running", "ended"] as const)("keeps the completed quiz dispute available after automatic advancement reaches %s", async status => {
  const current: LearningAgentTaskView = { ...savedTask(waiting), status, wait: null };
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [current] });
  vi.mocked(learningAgentApi.control).mockResolvedValue({ task: { ...current, status: "paused", quizLinks: current.quizLinks!.map(link => ({ ...link, disputed: true })) } });
  mount(); fireEvent.click(await screen.findByText("这组题有疑问", { selector: "summary" }));
  fireEvent.change(screen.getByLabelText("说明题目疑问"), { target: { value: "第二个选项也成立，请核对。" } });
  fireEvent.click(screen.getByRole("button", { name: "提交疑问并暂停" }));
  await screen.findByText("这组题已标记为有疑问，不再用它的成绩判断薄弱点。已有作答保持原样。");
  expect(learningAgentApi.control).toHaveBeenCalledExactlyOnceWith("page-one", { id: waiting.id, action: "dispute_quiz", expectedVersion: 1, attemptId: "attempt-one", eventId: expect.any(String), feedback: "第二个选项也成立，请核对。" });
});

it("does not let a late incomplete task read overwrite a saved completion even when synchronization needs recovery", async () => {
  let finishRead!: (value: { tasks: LearningAgentTaskView[] }) => void;
  vi.mocked(learningAgentApi.list).mockResolvedValueOnce({ tasks: [waiting] }).mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
  vi.mocked(learningAgentApi.control).mockRejectedValueOnce(new LearningApiError(409, "agent_busy"));
  mount(); await screen.findByTestId("inline-quiz");
  fireEvent.click(screen.getByRole("button", { name: "刷新任务" }));
  await waitFor(() => expect(learningAgentApi.list).toHaveBeenCalledTimes(2));
  await act(async () => { quizCallbacks.saved!(attempt()); finishRead({ tasks: [waiting] }); await Promise.resolve(); });
  await screen.findByRole("button", { name: "核对作答衔接" });
  expect(learningAgentApi.control).toHaveBeenCalledExactlyOnceWith("page-one", { id: waiting.id, action: "sync_quiz", expectedVersion: 1, attemptId: "attempt-one", eventId: expect.any(String) });
  expect(screen.getByText("作答已保存，自动衔接尚未确认。可以核对衔接状态，无需重新作答。")).toBeVisible();
  expect(screen.getByTestId("inline-quiz")).toHaveTextContent("quiz-one");
});

const reviewSummary: LearningAgentReviewSummary = {
  kind: "completed", headline: "本轮完成 2 组练习，交集与并集还值得再区分一下。",
  stats: { groups: 2, total: 10, answered: 10, correct: 8, wrong: 2, unassistedCorrect: 8, hinted: 0, revealed: 0, skipped: 0, unanswered: 0, excludedGroups: 0 },
  topics: [{ id: "intersection", title: "交集与并集", explanation: "交集要求同时属于两个集合，并集只需属于其中一个。",
    questionRefs: [{ quizId: "quiz-one", attemptId: "attempt-one", index: 1 }], sources: [{ materialId: "material-one", paragraph: 3 }] }],
  reminders: ["先分清同时满足还是至少满足一个。", "列出集合元素后去重。"], notices: [],
};
const reviewedTask = (): LearningAgentTaskView => ({ ...savedTask(waiting), status: "ended", wait: null, reviewSummary,
  quizLinks: [{ quizId: "quiz-one", attemptId: "attempt-one", completed: true }, { quizId: "quiz-two", attemptId: "attempt-two", completed: true }] });

it("shows authoritative whole-task review and opens a specific earlier wrong question inside the guide without generating or changing answers", async () => {
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [reviewedTask()] });
  mount(); const summary = await screen.findByRole("region", { name: "本轮复习总结" });
  expect(summary).toHaveTextContent("已记录 2 组练习 · 已作答 10/10 题");
  expect(summary).toHaveTextContent("答对 8 题（其中 8 题未使用提示或提前看答案） · 答错 2 题");
  expect(within(summary).getByRole("region", { name: "专项讲解" })).toHaveTextContent(reviewSummary.topics[0].explanation);
  expect(within(summary).getAllByRole("listitem")).toHaveLength(2);
  await waitFor(() => expect(screen.getByTestId("inline-quiz")).toHaveTextContent("quiz-two"));
  fireEvent.click(within(summary).getByRole("button", { name: "查看错题 · 题组 1 第 2 题" }));
  expect(screen.getByTestId("inline-quiz")).toHaveTextContent("quiz-one");
  expect(screen.getByTestId("inline-quiz")).toHaveAttribute("data-review-index", "1");
  expect(screen.getByRole("region", { name: "本轮练习" })).toHaveFocus();
  expect(new URLSearchParams(window.location.search).get("view")).toBe("agent");
  fireEvent.click(within(summary).getByRole("button", { name: "查看原文 · 交集与并集" }));
  expect(onSource).toHaveBeenCalledExactlyOnceWith("material-one", 3, undefined);
  expect(learningAgentApi.start).not.toHaveBeenCalled(); expect(learningAgentApi.control).not.toHaveBeenCalled();
});

it("keeps an all-independent-correct review brief and refreshes it with read-only requests", async () => {
  const praise: LearningAgentReviewSummary = { ...reviewSummary, headline: "本轮 10 题全部独立答对，做得不错！", stats: { ...reviewSummary.stats, correct: 10, wrong: 0, unassistedCorrect: 10 }, topics: [], reminders: [] };
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [{ ...reviewedTask(), reviewSummary: praise }] });
  mount(); const summary = await screen.findByRole("region", { name: "本轮复习总结" });
  expect(summary).toHaveTextContent(praise.headline);
  expect(summary.querySelectorAll("p")).toHaveLength(1);
  expect(within(summary).queryByRole("region", { name: "专项讲解" })).not.toBeInTheDocument();
  expect(within(summary).queryByRole("button")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "刷新任务" }));
  await waitFor(() => expect(learningAgentApi.list).toHaveBeenCalledTimes(2));
  expect(learningAgentApi.start).not.toHaveBeenCalled(); expect(learningAgentApi.control).not.toHaveBeenCalled();
});

it.each(["cancelled", "budget_exhausted", "ended"] as const)("shows a progress review for %s without inventing successful completion or praise", async status => {
  const progress: LearningAgentReviewSummary = { ...reviewSummary, kind: "partial", headline: "本轮尚无可用于回顾的作答，已有内容已保留。", stats: { groups: 0, total: 0, answered: 0, correct: 0, wrong: 0, unassistedCorrect: 0, hinted: 0, revealed: 0, skipped: 0, unanswered: 0, excludedGroups: 0 }, topics: [], reminders: [], notices: ["本轮尚未完成复习目标。"] };
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [{ ...reviewedTask(), status, reviewSummary: progress }] });
  mount(); const summary = await screen.findByRole("region", { name: "本轮进度回顾" });
  expect(summary).toHaveTextContent(progress.headline); expect(summary).toHaveTextContent(progress.notices[0]);
  expect(summary).not.toHaveTextContent(/做得不错|全部独立答对|已经掌握/);
  expect(screen.queryByRole("region", { name: "本轮复习总结" })).not.toBeInTheDocument();
  expect(learningAgentApi.control).not.toHaveBeenCalled();
});

it("shows supported assistance and exclusion statistics without treating them as wrong answers", async () => {
  const summary: LearningAgentReviewSummary = { ...reviewSummary, kind: "partial", headline: "已保存这次练习的作答情况。", stats: { groups: 1, total: 5, answered: 2, correct: 2, wrong: 0, unassistedCorrect: 1, hinted: 1, revealed: 1, skipped: 1, unanswered: 1, excludedGroups: 1 }, topics: [], reminders: [], notices: ["1 组存在疑问的题目未用于诊断。"] };
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [{ ...reviewedTask(), reviewSummary: summary }] });
  mount(); const region = await screen.findByRole("region", { name: "本轮进度回顾" });
  expect(region).toHaveTextContent("答对 2 题（其中 1 题未使用提示或提前看答案） · 答错 0 题");
  expect(region).toHaveTextContent("使用提示 1 题 · 看答案 1 题 · 跳过 1 题 · 未完成 1 题");
  expect(region).toHaveTextContent(summary.notices[0]);
  expect(within(region).queryByRole("region", { name: "专项讲解" })).not.toBeInTheDocument();
});

it("replaces the old diagnosis with the authoritative post-dispute summary after the round ended", async () => {
  const before = reviewedTask();
  const after: LearningAgentTaskView = { ...before, quizLinks: before.quizLinks!.map(link => ({ ...link, disputed: true })), reviewSummary: { ...reviewSummary, kind: "partial", headline: "题目疑问已记录，本轮暂不据此判断薄弱点。", topics: [], reminders: [], notices: ["有疑问题组的成绩已从总结中排除。"] } };
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [before] }); vi.mocked(learningAgentApi.control).mockResolvedValue({ task: after });
  mount(); await screen.findByRole("region", { name: "本轮复习总结" });
  fireEvent.click(await screen.findByText("这组题有疑问", { selector: "summary" }));
  fireEvent.change(screen.getByLabelText("说明题目疑问"), { target: { value: "选项可能不唯一。" } });
  fireEvent.click(screen.getByRole("button", { name: "提交疑问并暂停" }));
  const summary = await screen.findByRole("region", { name: "本轮进度回顾" });
  expect(summary).toHaveTextContent(after.reviewSummary!.headline);
  expect(screen.queryByText(reviewSummary.topics[0].explanation)).not.toBeInTheDocument();
  expect(within(summary).queryByRole("button", { name: /查看错题/ })).not.toBeInTheDocument();
  expect(learningAgentApi.control).toHaveBeenCalledOnce();
});

it("preserves parsed source identity and disables unmatched historical question links", async () => {
  const parsed = { documentId: "doc-one", version: 2, blockId: "block-one", physicalPage: 4, sourceHash: "binding-one" };
  const summary: LearningAgentReviewSummary = { ...reviewSummary, topics: [{ ...reviewSummary.topics[0], questionRefs: [{ quizId: "old-group", attemptId: "old-attempt", index: 0 }], sources: [{ materialId: "material-one", paragraph: 12, parsed }] }] };
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [{ ...reviewedTask(), reviewSummary: summary }] });
  mount(); const region = await screen.findByRole("region", { name: "本轮复习总结" });
  expect(within(region).getByRole("button", { name: "原题组不可用" })).toBeDisabled();
  fireEvent.click(within(region).getByRole("button", { name: "查看原文 · 交集与并集" }));
  expect(onSource).toHaveBeenCalledExactlyOnceWith("material-one", 4, parsed);
});

it("does not carry a previous version summary into the adjusted round", async () => {
  vi.mocked(learningAgentApi.list).mockResolvedValueOnce({ tasks: [reviewedTask()] }).mockResolvedValue({ tasks: [{ ...waiting, version: 2, goal: "新的复习范围", quizLinks: [] }] });
  mount(); await screen.findByRole("region", { name: "本轮复习总结" });
  fireEvent.click(screen.getByRole("button", { name: "刷新任务" }));
  await screen.findByRole("heading", { name: "新的复习范围" });
  expect(screen.queryByRole("region", { name: "本轮复习总结" })).not.toBeInTheDocument();
  expect(screen.queryByText(reviewSummary.topics[0].explanation)).not.toBeInTheDocument();
  expect(learningAgentApi.control).not.toHaveBeenCalled();
});

const explanationCompletion: LearningCompletionAssessment = {
  schemaVersion: 1, taskVersion: 1, planId: "plan-one", sourceFingerprint: "synthetic", evidenceFingerprint: "none", progressFingerprint: "awaiting-feedback",
  plan: { schemaVersion: 1, taskVersion: 1, sourceFingerprint: "synthetic", goal: "解释条件概率", proposedBy: "model", id: "plan-one", kind: "explanation",
    objectives: [{ id: "conditional", label: "解释条件概率如何缩小样本空间", sources: [{ materialId: "material-one", paragraph: 1 }], requirements: [] }] },
  outcome: "insufficient", support: "insufficient", objectives: [{ id: "conditional", label: "解释条件概率如何缩小样本空间", status: "unobserved", requirements: [], evidence: [],
    gaps: ["等待你确认疑问是否解决。"], unresolvedErrors: [], explanationResolved: false }], canAutoFinish: false, pending: ["feedback"],
  headline: "等待对本轮讲解的明确反馈。", stopReason: null, limitations: [], longTermMastery: "unverified",
};
const explanationTask = (): LearningAgentTaskView => ({ ...waiting, quizLinks: [], completion: explanationCompletion,
  wait: { kind: "feedback", message: "现在能区分条件概率了吗？" }, explanations: [{ id: "explanation-one", text: "合成讲解：条件概率先缩小样本空间。", sources: [{ materialId: "material-one", paragraph: 1 }] }] });

it.each(["quiz_submission", "feedback"] as const)("offers adjustment instead of more practice for a source association problem during %s", async kind => {
  const completion: LearningCompletionAssessment = { ...explanationCompletion,
    plan: { ...explanationCompletion.plan!, kind: "chapter_check" },
    headline: "本轮目标与题目的来源关联需要核对，不据此判断是否学会。",
    technicalBlocker: { kind: "plan_source_mismatch", objectiveIds: ["conditional"], message: "题目引用的原文与目标未对应，请调整本轮复习核对。" } };
  const current: LearningAgentTaskView = { ...waiting, completion,
    wait: { kind, refId: kind === "quiz_submission" ? "attempt-one" : "feedback:association", message: "旧等待说明" } };
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [current] });
  mount(); await screen.findByTestId("inline-quiz");
  const next = within(screen.getByRole("region", { name: "接下来" }));
  expect(next.getByRole("heading", { name: "先核对本轮复习" })).toBeVisible();
  expect(next.queryByRole("heading", { name: "完成练习，再继续复习" })).not.toBeInTheDocument();
  expect(next.queryByLabelText("你的反馈")).not.toBeInTheDocument();
  expect(next.getByRole("button", { name: "结束本轮复习" })).toBeEnabled();
  expect(screen.getByText(/已有题组与作答保持原样/)).toBeVisible();
  expect(learningAgentApi.control).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "调整本轮复习" }));
  expect(screen.getByRole("region", { name: "调整本轮复习" })).toBeVisible();
  expect(screen.getByLabelText("新的复习目标")).toHaveValue(current.goal);
  expect(learningAgentApi.control).not.toHaveBeenCalled();
});

it.each([
  { button: "疑问已解决", outcome: "resolved", message: "" },
  { button: "仍需说明", outcome: "needs_clarification", message: "分母为何变化仍不明白。" },
] as const)("records explicit explanation feedback via $button with its current explanation and version", async ({ button, outcome, message }) => {
  const current = explanationTask();
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [current] });
  vi.mocked(learningAgentApi.control).mockResolvedValue({ task: { ...current, status: outcome === "resolved" ? "ended" : "running", wait: null, endReason: outcome === "resolved" ? "你已确认本轮疑问得到解决。" : null } });
  mount(); await screen.findByRole("button", { name: button });
  expect(screen.queryByTestId("inline-quiz")).not.toBeInTheDocument();
  expect(learningAgentApi.control).not.toHaveBeenCalled();
  if (message) fireEvent.change(screen.getByLabelText("你的反馈"), { target: { value: message } });
  fireEvent.click(screen.getByRole("button", { name: button }));
  await waitFor(() => expect(learningAgentApi.control).toHaveBeenCalledExactlyOnceWith("page-one", { id: current.id,
    action: "explanation_feedback", eventId: expect.any(String), expectedVersion: 1, explanationId: "explanation-one", outcome,
    ...(message ? { message } : {}) }));
  expect(learningAgentApi.start).not.toHaveBeenCalled();
  if (outcome === "resolved") expect(screen.getByRole("button", { name: "开始另一项复习" })).toBeEnabled();
});

it("keeps a mismatched explanation readable but replaces invalid resolution controls with explicit adjustment", async () => {
  const current = explanationTask();
  current.completion = { ...explanationCompletion, technicalBlocker: { kind: "plan_source_mismatch", objectiveIds: ["conditional"],
    message: "讲解与本轮目标引用的原文未对应，请调整本轮复习核对。" } };
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [current] });
  mount(); await screen.findByRole("heading", { name: "先核对本轮复习" });
  expect(screen.queryByRole("button", { name: "疑问已解决" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "仍需说明" })).not.toBeInTheDocument();
  expect(screen.queryByLabelText("你的反馈")).not.toBeInTheDocument();
  expect(screen.getByText(/调整后将重新读取原文并核对关联/)).toBeVisible();
  expect(screen.getByText("合成讲解：条件概率先缩小样本空间。")).toBeInTheDocument();
  expect(learningAgentApi.control).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "调整本轮复习" }));
  expect(screen.getByRole("region", { name: "调整本轮复习" })).toBeVisible();
  expect(screen.getByLabelText("新的复习目标")).toHaveValue(current.goal);
  expect(learningAgentApi.control).not.toHaveBeenCalled();
});

it("sends explanation resolution only for the explicitly adjusted version and its new related explanation", async () => {
  const current = explanationTask();
  current.version = 2;
  current.completion = { ...explanationCompletion, taskVersion: 2,
    plan: { ...explanationCompletion.plan!, taskVersion: 2, id: "adjusted-plan" } };
  current.explanations = [{ ...current.explanations![0], id: "new-related-explanation" }];
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [current] });
  vi.mocked(learningAgentApi.control).mockResolvedValue({ task: { ...current, status: "ended", wait: null } });
  mount(); fireEvent.click(await screen.findByRole("button", { name: "疑问已解决" }));
  await waitFor(() => expect(learningAgentApi.control).toHaveBeenCalledExactlyOnceWith("page-one", {
    id: current.id, action: "explanation_feedback", eventId: expect.any(String), expectedVersion: 2,
    explanationId: "new-related-explanation", outcome: "resolved",
  }));
  expect(learningAgentApi.start).not.toHaveBeenCalled();
  expect(screen.queryByTestId("inline-quiz")).not.toBeInTheDocument();
});

it("does not infer resolution from thanks, refresh or ordinary feedback", async () => {
  const current = explanationTask();
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [current] });
  vi.mocked(learningAgentApi.control).mockResolvedValue({ task: current });
  mount(); await screen.findByRole("button", { name: "疑问已解决" });
  fireEvent.click(screen.getByRole("button", { name: "刷新任务" }));
  await waitFor(() => expect(learningAgentApi.list).toHaveBeenCalledTimes(2));
  expect(learningAgentApi.control).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("你的反馈"), { target: { value: "谢谢" } });
  fireEvent.click(screen.getByRole("button", { name: "提交其他反馈" }));
  await waitFor(() => expect(learningAgentApi.control).toHaveBeenCalledExactlyOnceWith("page-one", { id: current.id,
    action: "feedback", eventId: expect.any(String), expectedVersion: 1, feedback: "谢谢" }));
  expect(screen.getByRole("button", { name: "疑问已解决" })).toBeEnabled();
});

it("does not show resolution controls for a stale plan or reuse a previous version conclusion", async () => {
  const current = explanationTask();
  vi.mocked(learningAgentApi.list).mockResolvedValueOnce({ tasks: [current] }).mockResolvedValue({ tasks: [{ ...current, version: 2, goal: "解释新的概念" }] });
  mount(); await screen.findByRole("button", { name: "疑问已解决" });
  fireEvent.click(screen.getByRole("button", { name: "刷新任务" }));
  await screen.findByRole("heading", { name: "解释新的概念" });
  expect(screen.queryByRole("button", { name: "疑问已解决" })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "本轮判断需要更新" })).toBeVisible();
  expect(screen.queryByText("解释条件概率如何缩小样本空间")).not.toBeInTheDocument();
  expect(learningAgentApi.control).not.toHaveBeenCalled();
});

it("reconciles uncertain explanation feedback with the same receipt and does not send a second decision", async () => {
  const current = explanationTask();
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [current] });
  vi.mocked(learningAgentApi.control).mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce({ task: { ...current, status: "ended", wait: null } });
  mount(); fireEvent.click(await screen.findByRole("button", { name: "疑问已解决" }));
  await screen.findByRole("button", { name: "核对本次任务操作" });
  const receipt = vi.mocked(learningAgentApi.control).mock.calls[0][1];
  expect(screen.getByRole("button", { name: "仍需说明" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "核对本次任务操作" }));
  await waitFor(() => expect(learningAgentApi.control).toHaveBeenCalledTimes(2));
  expect(vi.mocked(learningAgentApi.control).mock.calls[1][1]).toEqual(receipt);
});

it("keeps the current quiz selected ahead of authorized history and does not expose current-task dispute controls for old attempts", async () => {
  const historical: LearningAgentTaskView = { ...waiting, quizLinks: [
    ...waiting.quizLinks!, { quizId: "historical-quiz", attemptId: "historical-attempt", historical: true, completed: true },
  ] };
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [historical] });
  mount(); await screen.findByTestId("inline-quiz");
  expect(screen.getByTestId("inline-quiz")).toHaveTextContent("quiz-one");
  fireEvent.click(screen.getByRole("button", { name: "查看历史作答 2" }));
  expect(screen.getByTestId("inline-quiz")).toHaveTextContent("historical-quiz");
  expect(screen.getByRole("region", { name: "相关历史作答" })).toHaveTextContent("原题、作答与成绩保持不变");
  expect(screen.queryByText("这组题有疑问", { selector: "summary" })).not.toBeInTheDocument();
  expect(learningAgentApi.control).not.toHaveBeenCalled();
});

it("selects the most recent current task quiz when no quiz is waiting, before a historical evidence link", async () => {
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [{ ...waiting, status: "ended", wait: null, quizLinks: [
    { quizId: "quiz-one", attemptId: "attempt-one", completed: true }, { quizId: "quiz-two", attemptId: "attempt-two", completed: true },
    { quizId: "historical-quiz", attemptId: "historical-attempt", historical: true, completed: true },
  ] }] });
  mount(); await screen.findByTestId("inline-quiz");
  expect(screen.getByTestId("inline-quiz")).toHaveTextContent("quiz-two");
  expect(screen.getByRole("button", { name: "查看题组 2" })).toHaveAttribute("aria-pressed", "true");
  expect(learningAgentApi.control).not.toHaveBeenCalled();
});

it("distinguishes missing current explanation from confirmation while allowing necessary information feedback", async () => {
  const current = explanationTask();
  current.explanations = [];
  current.completion = { ...explanationCompletion, objectives: explanationCompletion.objectives.map(objective => ({ ...objective, explanationState: "missing" })) };
  current.wait = { kind: "feedback", message: "请说明最想先澄清的区别。" };
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [current] });
  vi.mocked(learningAgentApi.control).mockResolvedValue({ task: current });
  mount(); await screen.findByText("本轮还没有相关讲解。你可以先补充困惑或需要核对的材料。");
  expect(screen.queryByRole("button", { name: "疑问已解决" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "仍需说明" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("你的反馈"), { target: { value: "先解释为什么要缩小样本空间。" } });
  fireEvent.click(screen.getByRole("button", { name: "提交反馈并继续" }));
  await waitFor(() => expect(learningAgentApi.control).toHaveBeenCalledExactlyOnceWith("page-one", {
    id: current.id, action: "feedback", eventId: expect.any(String), expectedVersion: 1, feedback: "先解释为什么要缩小样本空间。",
  }));
});

it("retains a known contradictory explanation and source links, blocks resolution, and permits clarification", async () => {
  const current = explanationTask();
  const text = "交集为 {3}。元素 3 同时属于两个集合，所以不满足交集的双条件。";
  current.explanations = [{ ...current.explanations![0], text, sources: [{ materialId: "material-one", paragraph: 1 }], contentIssue: { status: "known_issue", issues: [{ code: "intersection_membership_contradiction", start: 8, end: text.length }] } }];
  current.completion = { ...explanationCompletion,
    objectives: explanationCompletion.objectives.map(objective => ({ ...objective, explanationState: "needs_review" })),
    contentIssues: [{ explanationId: "explanation-one", objectiveIds: ["conditional"], codes: ["intersection_membership_contradiction"], message: "这段讲解存在内容矛盾。" }],
  };
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [current] });
  vi.mocked(learningAgentApi.control).mockResolvedValue({ task: current });
  mount(); await screen.findByRole("alert");
  expect(screen.getByText(text)).toBeVisible();
  expect(screen.queryByRole("button", { name: "疑问已解决" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "提交其他反馈" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "查看引用原文 1" }));
  expect(onSource).toHaveBeenCalledWith("material-one", 1, undefined);
  fireEvent.change(screen.getByLabelText("你的反馈"), { target: { value: "这里的结论与前文矛盾，请先重新核对。" } });
  fireEvent.click(screen.getByRole("button", { name: "仍需说明" }));
  await waitFor(() => expect(learningAgentApi.control).toHaveBeenCalledExactlyOnceWith("page-one", {
    id: current.id, action: "explanation_feedback", eventId: expect.any(String), expectedVersion: 1,
    explanationId: "explanation-one", outcome: "needs_clarification", message: "这里的结论与前文矛盾，请先重新核对。",
  }));
});

it("does not block feedback on an available explanation merely because another objective still lacks one", async () => {
  const current = explanationTask();
  current.completion = { ...explanationCompletion,
    plan: { ...explanationCompletion.plan!, objectives: [...explanationCompletion.plan!.objectives,
      { id: "other", label: "另一项尚待说明的疑问", requirements: [], sources: [{ materialId: "material-one", paragraph: 1 }] }] },
    objectives: [
      { ...explanationCompletion.objectives[0], explanationState: "available" },
      { ...explanationCompletion.objectives[0], id: "other", label: "另一项尚待说明的疑问", explanationState: "missing" },
    ],
  };
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [current] });
  vi.mocked(learningAgentApi.control).mockResolvedValue({ task: current });
  mount(); fireEvent.click(await screen.findByRole("button", { name: "疑问已解决" }));
  await waitFor(() => expect(learningAgentApi.control).toHaveBeenCalledExactlyOnceWith("page-one", {
    id: current.id, action: "explanation_feedback", eventId: expect.any(String), expectedVersion: 1,
    explanationId: "explanation-one", outcome: "resolved",
  }));
  expect(screen.queryByText("本轮检查通过")).not.toBeInTheDocument();
});

it("keeps an older content warning visible without blocking explicit feedback on the newer valid explanation", async () => {
  const current = explanationTask();
  current.explanations = [{ id: "old-bad", text: "[离线历史反例] 元素3同时属于两个集合，所以不满足交集的双条件。",
    contentIssue: { status: "known_issue", issues: [{ code: "intersection_membership_contradiction", start: 9, end: 36 }] } }, ...current.explanations!];
  current.completion = { ...explanationCompletion,
    objectives: explanationCompletion.objectives.map(objective => ({ ...objective, explanationState: "available" })),
    contentIssues: [{ explanationId: "old-bad", objectiveIds: ["conditional"], codes: ["intersection_membership_contradiction"], message: "旧讲解保留供核对。", active: false }],
  };
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [current] });
  vi.mocked(learningAgentApi.control).mockResolvedValue({ task: current });
  mount(); await screen.findByRole("alert");
  expect(screen.getByText(current.explanations[0].text)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "疑问已解决" }));
  await waitFor(() => expect(learningAgentApi.control).toHaveBeenCalledExactlyOnceWith("page-one", {
    id: current.id, action: "explanation_feedback", eventId: expect.any(String), expectedVersion: 1,
    explanationId: "explanation-one", outcome: "resolved",
  }));
});
