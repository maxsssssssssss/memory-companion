import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LearningPreparationRun } from "@/lib/domain/learning-preparation";
import { LearningPreparation } from "./learning-preparation";
import { learningApi, LearningApiError } from "@/lib/client/learning-api";
vi.mock("@/lib/client/learning-api", async original => ({ ...await original<typeof import("@/lib/client/learning-api")>(), learningApi: { preparation: vi.fn(), resumePreparation: vi.fn() } }));
const props = { pageId: "p", refreshKey: 0, onUpdated: vi.fn(), onActive: vi.fn(), onMaterials: vi.fn(), onRead: vi.fn(), onQuiz: vi.fn(), saveSelection: vi.fn(), onBusy: vi.fn() };
function run(overrides: Partial<LearningPreparationRun> = {}): LearningPreparationRun {
  return { id: "r", pageId: "p", materialIds: ["m"], intent: "organize", status: "preparing", materials: [{ materialId: "m", title: "合成课件", kind: "pdf", status: "waiting", completed: 0, total: 2, issues: [] }], completed: 0, total: 1, frameworkRunId: null, frameworkPublished: false, error: null, createdAt: "2026-09-24T00:00:00Z", updatedAt: "2026-09-24T00:00:00Z", canContinue: false, canResume: false, ...overrides };
}
beforeEach(() => { vi.clearAllMocks(); props.saveSelection.mockResolvedValue(undefined); props.onUpdated.mockReset(); vi.mocked(learningApi.preparation).mockResolvedValue({ runs: [] }); });
afterEach(cleanup);
it("reads existing history without automatically posting a resume or starting work", async () => {
  render(<LearningPreparation {...props} />);
  await waitFor(() => expect(learningApi.preparation).toHaveBeenCalledTimes(1));
  expect(learningApi.resumePreparation).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("整理进度")).not.toBeInTheDocument();
});
it("refreshes completed content without navigating away from reading", async () => {
  vi.mocked(learningApi.preparation).mockResolvedValueOnce({ runs: [run()] });
  const ui = render(<LearningPreparation {...props} />);
  await screen.findByText("正在准备学习材料");
  vi.mocked(learningApi.preparation).mockResolvedValueOnce({ runs: [run({ status: "completed", completed: 1, updatedAt: "2026-09-24T00:01:00Z", frameworkRunId: "f" })] });
  ui.rerender(<LearningPreparation {...props} refreshKey={1} />);
  await screen.findByText("本次整理已完成");
  expect(props.onUpdated).toHaveBeenCalledTimes(2); expect(props.onRead).not.toHaveBeenCalled(); expect(props.onQuiz).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "阅读框架" })); expect(props.onRead).toHaveBeenCalledTimes(1);
});
it("requires an explicit action for partial scope and keeps its consequences visible", async () => {
  const partial = run({ status: "needs_attention", canContinue: true, materials: [{ materialId: "m", title: "合成课件", kind: "pdf", status: "partial", completed: 1, total: 2, issues: ["第 2 页缺少可用文字", "第 2 页缺少可用文字"] }] });
  vi.mocked(learningApi.preparation).mockResolvedValue({ runs: [partial] });
  vi.mocked(learningApi.resumePreparation).mockResolvedValue({ run: { ...partial, status: "completed", completed: 1, updatedAt: "2026-09-24T00:02:00Z" } });
  const onStatus = vi.fn();
  render(<LearningPreparation {...props} onStatus={onStatus} />);
  await screen.findByText("部分材料需要处理");
  fireEvent.click(screen.getByText("本次材料 · 1 份"));
  expect(screen.getAllByText("第 2 页缺少可用文字")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "继续处理" })).not.toBeInTheDocument();
  expect(learningApi.resumePreparation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "先整理可用部分" }));
  await waitFor(() => expect(learningApi.resumePreparation).toHaveBeenCalledWith("p", "r", { continueWithAvailable: true }));
  await screen.findByText("已按可用范围整理");
  expect(onStatus).toHaveBeenLastCalledWith("部分完成");
});
it("offers explicit recovery only for a resumable run and labels prepare-only completion honestly", async () => {
  vi.mocked(learningApi.preparation).mockResolvedValueOnce({ runs: [run({ status: "interrupted", canResume: true })] });
  vi.mocked(learningApi.resumePreparation).mockResolvedValueOnce({ run: run({ intent: "prepare", status: "completed", completed: 1, updatedAt: "2026-09-24T00:02:00Z" }) });
  render(<LearningPreparation {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "继续处理" }));
  await screen.findByText("材料已准备，可以开始练习");
  expect(learningApi.resumePreparation).toHaveBeenCalledWith("p", "r", {});
  fireEvent.click(screen.getByRole("button", { name: "开始练习" })); expect(props.onQuiz).toHaveBeenCalledTimes(1);
});
it("shows resource waiting and exact completed pages, then continues only after the user's action", async () => {
  const waiting = run({ status: "needs_attention", canResume: true, canContinue: true, error: "pdf_parser_resource_wait",
    materials: [{ materialId: "m", title: "合成课件", kind: "pdf", status: "partial", processing: "waiting_resource", completed: 2, total: 5, issues: [] }] });
  const resumed = run({ updatedAt: "2026-09-24T00:01:00Z", materials: [{ ...waiting.materials[0], status: "waiting", processing: "resuming" }] });
  vi.mocked(learningApi.preparation).mockResolvedValue({ runs: [waiting] });
  vi.mocked(learningApi.resumePreparation).mockResolvedValue({ run: resumed });
  const onStatus = vi.fn(), ui = render(<LearningPreparation {...props} onStatus={onStatus} />);
  await screen.findByText("等待解析资源 · 已完成 2/5 页");
  expect(screen.queryByText("本次整理未完成")).not.toBeInTheDocument();
  await waitFor(() => expect(onStatus).toHaveBeenLastCalledWith("等待解析资源"));
  ui.rerender(<LearningPreparation {...props} refreshKey={1} onStatus={onStatus} />);
  await waitFor(() => expect(learningApi.preparation).toHaveBeenCalledTimes(2));
  fireEvent.focus(window);
  await waitFor(() => expect(learningApi.preparation).toHaveBeenCalledTimes(3));
  expect(learningApi.resumePreparation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "继续处理" }));
  await screen.findByText("正在继续未完成页 · 已完成 2/5 页");
  expect(learningApi.resumePreparation).toHaveBeenCalledExactlyOnceWith("p", "r", {});
  expect(props.saveSelection).not.toHaveBeenCalled();
});
it("retains partial-scope completion after the user chooses available pages instead of claiming full coverage", async () => {
  vi.mocked(learningApi.preparation).mockResolvedValue({ runs: [run({ status: "completed", materials: [{ materialId: "m", title: "合成课件", kind: "pdf", status: "partial", processing: "waiting_resource", completed: 2, total: 5, issues: ["3 页未覆盖"] }] })] });
  const onStatus = vi.fn(); render(<LearningPreparation {...props} onStatus={onStatus} />);
  await screen.findByText("已按可用范围整理");
  expect(onStatus).toHaveBeenLastCalledWith("部分完成");
  expect(screen.getByText("3 页未覆盖")).toBeVisible();
  expect(learningApi.resumePreparation).not.toHaveBeenCalled();
});
it.each([
  ["budget_exhausted", "本轮解析额度已用完"], ["session_expired", "本轮解析会话已结束"]
] as const)("distinguishes %s from waiting and preserves completed pages without a new request", async (processing, label) => {
  vi.mocked(learningApi.preparation).mockResolvedValue({ runs: [run({ status: "needs_attention", materials: [{ materialId: "m", title: "合成课件", kind: "pdf", status: "partial", processing, completed: 2, total: 5, issues: [`pdf_parser_${processing}`] }] })] });
  const onStatus = vi.fn(); render(<LearningPreparation {...props} onStatus={onStatus} />);
  await screen.findByText(`${label} · 已完成 2/5 页`);
  expect(onStatus).toHaveBeenLastCalledWith(label);
  expect(screen.getByText(/已完成页和原件仍保留，未完成页不会自动重试/)).toBeVisible();
  expect(screen.queryByText("等待解析资源")).not.toBeInTheDocument();
  expect(learningApi.resumePreparation).not.toHaveBeenCalled();
});
it("does not update or restore progress from a response arriving after unmount", async () => {
  let resolve!: (value: { runs: LearningPreparationRun[] }) => void;
  vi.mocked(learningApi.preparation).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const ui = render(<LearningPreparation {...props} />); ui.unmount(); resolve({ runs: [run()] });
  await Promise.resolve(); expect(props.onActive).not.toHaveBeenCalled(); expect(props.onUpdated).not.toHaveBeenCalled();
});

it("waits for current selection to save before confirming partial scope", async () => {
  const partial = run({ status: "needs_attention", canContinue: true });
  vi.mocked(learningApi.preparation).mockResolvedValue({ runs: [partial] });
  vi.mocked(learningApi.resumePreparation).mockResolvedValue({ run: { ...partial, status: "preparing", updatedAt: "2026-09-24T00:02:00Z" } });
  let saved!: () => void;
  props.saveSelection.mockReturnValueOnce(new Promise<void>(resolve => { saved = resolve; }));
  render(<LearningPreparation {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "先整理可用部分" }));
  expect(props.onBusy).toHaveBeenLastCalledWith(true);
  expect(learningApi.resumePreparation).not.toHaveBeenCalled();
  saved();
  await waitFor(() => expect(learningApi.resumePreparation).toHaveBeenCalledWith("p", "r", { continueWithAvailable: true }));
  await waitFor(() => expect(props.onBusy).toHaveBeenLastCalledWith(false));
});
it("retains selection save errors without submitting partial scope or clearing the error with a read", async () => {
  vi.mocked(learningApi.preparation).mockResolvedValue({ runs: [run({ status: "needs_attention", canContinue: true })] });
  props.saveSelection.mockRejectedValueOnce(new LearningApiError(409, "source_changed"));
  render(<LearningPreparation {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "先整理可用部分" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("其他操作中改变");
  expect(learningApi.resumePreparation).not.toHaveBeenCalled();
  expect(learningApi.preparation).toHaveBeenCalledTimes(1);
  expect(props.onBusy).toHaveBeenLastCalledWith(false);
  expect(screen.getByRole("button", { name: "先整理可用部分" })).toBeEnabled();
});
it("releases the selection lock after a partial confirmation POST fails", async () => {
  vi.mocked(learningApi.preparation).mockResolvedValue({ runs: [run({ status: "needs_attention", canContinue: true })] });
  vi.mocked(learningApi.resumePreparation).mockRejectedValueOnce(new Error("network"));
  render(<LearningPreparation {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "先整理可用部分" }));
  await waitFor(() => expect(props.onBusy).toHaveBeenLastCalledWith(false));
  expect(learningApi.resumePreparation).toHaveBeenCalledTimes(1);
  expect(learningApi.preparation).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("button", { name: "先整理可用部分" })).toBeEnabled();
});

it("keeps partial confirmation locked until the updated page selection has been published", async () => {
  const partial = run({ status: "needs_attention", canContinue: true });
  vi.mocked(learningApi.preparation).mockResolvedValue({ runs: [partial] });
  vi.mocked(learningApi.resumePreparation).mockResolvedValue({ run: { ...partial, status: "completed", updatedAt: "2026-09-24T00:02:00Z" } });
  let published!: () => void;
  props.onUpdated.mockReturnValueOnce(undefined).mockReturnValueOnce(new Promise<void>(resolve => { published = resolve; }));
  render(<LearningPreparation {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "先整理可用部分" }));
  await waitFor(() => expect(props.onUpdated).toHaveBeenCalledTimes(2));
  expect(props.onBusy).toHaveBeenLastCalledWith(true);
  expect(screen.queryByText("本次整理已完成")).not.toBeInTheDocument();
  published();
  await screen.findByText("本次整理已完成");
  expect(props.onBusy).toHaveBeenLastCalledWith(false);
});
it("keeps a failed page refresh visible and retries the read before announcing preparation completion", async () => {
  const partial = run({ status: "needs_attention", canContinue: true, intent: "prepare" });
  const completed = { ...partial, status: "completed" as const, updatedAt: "2026-09-24T00:02:00Z" };
  vi.mocked(learningApi.preparation).mockResolvedValueOnce({ runs: [partial] }).mockResolvedValue({ runs: [completed] });
  vi.mocked(learningApi.resumePreparation).mockResolvedValue({ run: completed });
  props.onUpdated.mockReturnValueOnce(undefined).mockRejectedValueOnce(new Error("page read failed")).mockResolvedValue(undefined);
  render(<LearningPreparation {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "先整理可用部分" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("未能确认");
  expect(screen.queryByText("材料已准备，可以开始练习")).not.toBeInTheDocument();
  expect(props.onBusy).toHaveBeenLastCalledWith(false);
  expect(learningApi.preparation).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "重新读取进度" }));
  await screen.findByText("材料已准备，可以开始练习");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(learningApi.resumePreparation).toHaveBeenCalledTimes(1);
});
