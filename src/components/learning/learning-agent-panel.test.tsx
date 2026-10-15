import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LearningAgentPanel } from "./learning-agent-panel";
import { learningAgentApi, type LearningAgentTaskView } from "@/lib/client/learning-agent-api";
import { learningApi, LearningApiError } from "@/lib/client/learning-api";
import type { FrameworkChapter } from "@/lib/domain/learning-framework";

vi.mock("@/lib/client/learning-agent-api", async original => ({ ...await original<typeof import("@/lib/client/learning-agent-api")>(), learningAgentApi: { list: vi.fn(), start: vi.fn(), control: vi.fn() } }));
vi.mock("@/lib/client/learning-api", async original => ({ ...await original<typeof import("@/lib/client/learning-api")>(), learningApi: { framework: vi.fn(), quizzes: vi.fn() } }));
const materials = [
  { id: "material-one", title: "合成概率教材", kind: "text" as const, byteLength: 40, createdAt: "", filename: null, selected: true },
  { id: "material-two", title: "未选择的材料", kind: "text" as const, byteLength: 20, createdAt: "", filename: null, selected: false },
];
const chapter: FrameworkChapter = { id: "chapter-one", runId: "framework-one", revision: 1, title: "概率", explanation: "", edited: false, nodes: [
  { id: "node-one", title: "条件概率", explanation: "", supplement: null, note: "", edited: false, sources: [{ materialId: "material-one", paragraph: 1, start: 0, end: 40, originalSha256: "synthetic", paragraphSha256: "synthetic" }] },
] };
const scope = { materialIds: ["material-one"], chapterIds: [], nodeIds: [], includeHistory: false, includeNotes: false, includeSupplements: false };
const waiting: LearningAgentTaskView = { id: "task-one", goal: "检查条件概率的理解", scope, status: "waiting", wait: { kind: "quiz_submission", refId: "attempt-one", message: "请完成诊断题组后继续。" }, actions: [{ id: "action-one", tool: "learning.create_quiz", status: "succeeded", summary: "已保存诊断题组", resultRef: { kind: "learning.quiz", id: "quiz-one" } }], quizLinks: [{ quizId: "quiz-one", attemptId: "attempt-one" }] };
const saveSelection = vi.fn(), onQuiz = vi.fn(), onSource = vi.fn();
function mount() { return render(<LearningAgentPanel pageId="page-one" materials={materials} selected={["material-one"]} disabled={false} saveSelection={saveSelection} onQuiz={onQuiz} onSource={onSource} />); }
beforeEach(() => {
  vi.clearAllMocks(); window.history.replaceState(null, "", "/learning/page-one?view=agent");
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
  { status: "budget_exhausted" as const, reason: "本任务预算已用完，调用和决策步数达到上限。", displayedReason: "本轮复习已达到单次上限，已有内容已保留。你可以开始新的复习。" },
])("restores waiting tasks without extra requests and shows a product-facing $status result after saved-attempt feedback", async ({ status, reason, displayedReason }) => {
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [waiting] });
  vi.mocked(learningAgentApi.control).mockResolvedValue({ task: { ...waiting, status, wait: null, endReason: reason, usage, budget } });
  mount(); await screen.findByRole("button", { name: "已完成作答，继续复习" });
  const nextStep = within(screen.getByRole("region", { name: "接下来" }));
  expect(nextStep.getByText(waiting.wait!.message)).toBeVisible();
  expect(nextStep.getByRole("button", { name: "打开题组 1" })).toBeVisible();
  expect(nextStep.getByRole("button", { name: "已完成作答，继续复习" })).toBeEnabled();
  for (const name of ["调整本轮复习", "取消任务"]) {
    expect(nextStep.queryByRole("button", { name })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name })).toBeEnabled();
  }
  vi.useFakeTimers(); await act(async () => { await vi.advanceTimersByTimeAsync(10000); }); vi.useRealTimers();
  expect(learningAgentApi.list).toHaveBeenCalledOnce();
  expect(learningAgentApi.start).not.toHaveBeenCalled(); expect(learningAgentApi.control).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "打开题组 1" })); expect(onQuiz).toHaveBeenCalledExactlyOnceWith("quiz-one");
  fireEvent.click(screen.getByRole("button", { name: "已完成作答，继续复习" }));
  await screen.findByText(displayedReason);
  expect(learningAgentApi.control).toHaveBeenCalledExactlyOnceWith("page-one", { id: "task-one", action: "feedback", expectedVersion: 1, eventId: expect.any(String), attemptId: "attempt-one" });
  expect(screen.queryByRole("button", { name: "取消任务" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "开始另一项复习" })).toBeEnabled();
  expect(screen.getByRole("region", { name: "复习向导" })).not.toHaveTextContent(/预算|调用|决策|tokens|已掌握/);
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
  vi.mocked(learningAgentApi.control).mockResolvedValue({ task: waiting, scheduled: true });
  mount(); await screen.findByRole("button", { name: "已完成作答，继续复习" });
  vi.useFakeTimers();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "已完成作答，继续复习" })); });
  expect(screen.getByText("反馈已受理，正在读取任务进度…")).toBeVisible();
  expect(screen.getByRole("button", { name: "已完成作答，继续复习" })).toBeDisabled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(screen.getByRole("status")).toHaveTextContent("正在复习");
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(screen.getByText("现在还有哪里不清楚？")).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(learningAgentApi.list).toHaveBeenCalledTimes(3);
  expect(learningAgentApi.control).toHaveBeenCalledOnce();
});

it("lets the user dispute a pending question without injecting scores or changing saved quiz answers", async () => {
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [waiting] });
  vi.mocked(learningAgentApi.control).mockResolvedValue({ task: waiting, scheduled: true });
  mount(); await screen.findByLabelText("这道题有疑问");
  const question = screen.getByLabelText("这道题有疑问");
  expect(question).not.toBeVisible();
  expect(screen.getByRole("button", { name: "提交疑问并继续" })).not.toBeVisible();
  fireEvent.click(screen.getByText("这道题有疑问", { selector: "summary" }));
  expect(question).toBeVisible();
  expect(question).toBeEnabled();
  expect(screen.getByRole("button", { name: "提交疑问并继续" })).toBeDisabled();
  fireEvent.change(question, { target: { value: "第一题似乎漏了前提，请先核对原文。" } });
  fireEvent.click(screen.getByRole("button", { name: "提交疑问并继续" }));
  await screen.findByText("反馈已受理，正在读取任务进度…");
  expect(learningAgentApi.control).toHaveBeenCalledExactlyOnceWith("page-one", { id: "task-one", action: "feedback", expectedVersion: 1, eventId: expect.any(String), attemptId: "attempt-one", feedback: "第一题似乎漏了前提，请先核对原文。" });
  expect(screen.getByText(/已有答案与成绩保持原样/)).toBeVisible();
});

it("shows task explanations as task content and sends subsequent feedback without saving a personal note", async () => {
  const explain: LearningAgentTaskView = { ...waiting, wait: { kind: "feedback", message: "这个解释是否有帮助？" }, quizLinks: [], explanations: [{ id: "explanation-one", text: "[合成解释] 条件概率限定了当前样本空间。", sources: [{ materialId: "material-one", paragraph: 1 }] }] };
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [explain] });
  vi.mocked(learningAgentApi.control).mockResolvedValue({ task: { ...explain, status: "cancelled", endReason: "用户取消", wait: null } });
  mount(); await screen.findByText(explain.explanations![0].text);
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
  await screen.findByRole("button", { name: "已完成作答，继续复习" });
  expect(learningAgentApi.control).toHaveBeenCalledExactlyOnceWith("page-one", { id: waiting.id, action: "resume", expectedVersion: 3, eventId: expect.any(String) });
  expect(screen.queryByRole("button", { name: "继续任务" })).not.toBeInTheDocument();
});
