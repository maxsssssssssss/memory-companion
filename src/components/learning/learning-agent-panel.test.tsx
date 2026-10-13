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
  await screen.findByText("固定范围：合成概率教材");
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

it("restores durable waiting tasks with read-only requests and resumes only after explicit saved-attempt feedback", async () => {
  vi.mocked(learningAgentApi.list).mockResolvedValue({ tasks: [waiting] });
  vi.mocked(learningAgentApi.control).mockResolvedValue({ task: { ...waiting, status: "ended", wait: null, endReason: "本轮检查完成；仍需结合原文判断。" } });
  mount(); await screen.findByRole("button", { name: "已完成作答，继续复习" });
  vi.useFakeTimers(); await act(async () => { await vi.advanceTimersByTimeAsync(10000); }); vi.useRealTimers();
  expect(learningAgentApi.list).toHaveBeenCalledOnce();
  expect(learningAgentApi.start).not.toHaveBeenCalled(); expect(learningAgentApi.control).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "打开题组 1" })); expect(onQuiz).toHaveBeenCalledExactlyOnceWith("quiz-one");
  fireEvent.click(screen.getByRole("button", { name: "已完成作答，继续复习" }));
  await screen.findByText("本轮检查完成；仍需结合原文判断。");
  expect(learningAgentApi.control).toHaveBeenCalledExactlyOnceWith("page-one", { id: "task-one", action: "feedback", eventId: expect.any(String), attemptId: "attempt-one" });
  expect(screen.queryByRole("button", { name: "取消任务" })).not.toBeInTheDocument();
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
  fireEvent.change(screen.getByLabelText("这道题有疑问"), { target: { value: "第一题似乎漏了前提，请先核对原文。" } });
  fireEvent.click(screen.getByRole("button", { name: "提交疑问并继续" }));
  await screen.findByText("反馈已受理，正在读取任务进度…");
  expect(learningAgentApi.control).toHaveBeenCalledExactlyOnceWith("page-one", { id: "task-one", action: "feedback", eventId: expect.any(String), attemptId: "attempt-one", feedback: "第一题似乎漏了前提，请先核对原文。" });
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
  expect(learningAgentApi.control).toHaveBeenCalledExactlyOnceWith("page-one", { id: "task-one", action: "feedback", eventId: expect.any(String), feedback: "明白了，这轮先结束" });
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
  expect(within(screen.getByRole("region", { name: "自适应复习·试用" })).getByText(/不代表已经掌握/)).toBeVisible();
});

it("reports a missing decision configuration as a known blocker without locking the form behind an unknown receipt", async () => {
  vi.mocked(learningAgentApi.start).mockRejectedValueOnce(new LearningApiError(503, "agent_not_configured"));
  mount(); await screen.findByRole("button", { name: "明确开始复习" });
  fireEvent.change(screen.getByLabelText("复习目标"), { target: { value: waiting.goal } });
  fireEvent.click(screen.getByRole("button", { name: "明确开始复习" }));
  await screen.findByText("复习决策模型尚未配置。已保存材料与手动学习仍可使用。");
  expect(screen.getByLabelText("复习目标")).toBeEnabled();
  expect(screen.queryByRole("button", { name: "核对本次任务是否已开始" })).not.toBeInTheDocument();
  expect(learningAgentApi.start).toHaveBeenCalledOnce();
});
