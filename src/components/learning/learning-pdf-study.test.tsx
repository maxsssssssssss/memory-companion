import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LearningPdfStudy } from "./learning-pdf-study";
import { learningApi } from "@/lib/client/learning-api";
import type { LearningMaterial, LearningPage } from "@/lib/domain/learning";
vi.mock("@/lib/client/learning-api", async original => ({ ...await original<typeof import("@/lib/client/learning-api")>(), learningApi: { parsed: vi.fn(), pdfStudyScope: vi.fn(), parsePdf: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const material = { id: "m", title: "合成测试", kind: "pdf", pdf: { pageCount: 53 } } as LearningMaterial;
const page = { id: "p", revision: 0 } as LearningPage;
function fixture(usable = true) {
  const doc = { id: "document", version: 1, status: "completed", requestedPages: [17], coverage: { whole_document_processed: false, failed_pages: [] }, pages: [{ physical_page: 17, parse_status: "succeeded", issues: [], blocks: [] }] };
  return { document: doc, documents: [doc], progress: [], selection: null, readiness: {
    documentId: doc.id, status: usable ? "partial" : "blocked", selection: usable ? { documentId: doc.id, physicalPages: [17], excludedBlockIds: [], acknowledgeUnverified: true, acknowledgeWarnings: false } : null,
    partial: true, totalPages: 53, completedPages: [17], failedPages: [], pendingPages: [], unknownPages: [], excludedPages: usable ? [] : [17], excludedBlockCount: 0, warningCodes: [], limitations: []
  } };
}
function expand(element: HTMLDetailsElement) { element.open = true; fireEvent(element, new Event("toggle")); }
function mount() { return render(<LearningPdfStudy page={page} material={material} onUpdated={vi.fn()} onSource={vi.fn()} />); }
it("shows compact truthful PDF coverage and keeps technical page details closed", async () => {
  vi.mocked(learningApi.parsed).mockResolvedValue(fixture() as never);
  const ui = mount();
  await screen.findByText(/部分可用 · 1\/53 页/);
  expect(learningApi.parsed).toHaveBeenCalledWith("p", "m", undefined, true);
  expand(ui.container.querySelector("details")!);
  expect(screen.getByText(/不能代表完整 PDF/)).toBeVisible();
  expect(screen.queryByRole("checkbox", { name: /第 17/ })).not.toBeInTheDocument();
  expect(learningApi.parsePdf).not.toHaveBeenCalled();
});
it("uses server readiness to disable a parsed page rejected by the generation scope gate", async () => {
  vi.mocked(learningApi.parsed).mockResolvedValue(fixture(false) as never);
  const ui = mount(); expand(ui.container.querySelector("details")!);
  expand(screen.getByText("高级：手动解析与学习范围").closest("details")!);
  expect(await screen.findByRole("checkbox", { name: /第 17 物理页/ })).toBeDisabled();
  expect(screen.getByRole("button", { name: "保存 PDF 学习范围" })).toBeDisabled();
  expect(learningApi.pdfStudyScope).not.toHaveBeenCalled();
});
it("describes an explicit scope save honestly without claiming a new parse", async () => {
  vi.mocked(learningApi.parsed).mockResolvedValue(fixture() as never);
  vi.mocked(learningApi.pdfStudyScope).mockImplementation(() => new Promise(() => {}));
  const ui = mount(); expand(ui.container.querySelector("details")!);
  expand(screen.getByText("高级：手动解析与学习范围").closest("details")!);
  fireEvent.click(await screen.findByRole("checkbox", { name: /第 17 物理页/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: /我已对照选定范围/ }));
  fireEvent.click(screen.getByRole("button", { name: "保存 PDF 学习范围" }));
  await screen.findByText("正在保存学习范围…");
  expect(screen.queryByText(/正在解析 \d/)).not.toBeInTheDocument();
  expect(learningApi.parsePdf).not.toHaveBeenCalled();
  await waitFor(() => expect(learningApi.pdfStudyScope).toHaveBeenCalledWith("p", "m", 0, expect.objectContaining({ physicalPages: [17], acknowledgeUnverified: true })));
});
it("shows resource waiting in the compact material status and never posts on refresh or disclosure", async () => {
  const value = fixture();
  Object.assign(value.readiness, { processing: "waiting_resource", pendingPages: [18, 19] });
  vi.mocked(learningApi.parsed).mockResolvedValue(value as never);
  const ui = mount();
  await screen.findByText(/等待解析资源 · 已完成 1\/53 页/);
  expand(ui.container.querySelector("details")!);
  expect(screen.getByText(/正在等待解析资源，已完成页已保存/)).toBeVisible();
  fireEvent.focus(window);
  await waitFor(() => expect(learningApi.parsed).toHaveBeenCalledTimes(2));
  expect(learningApi.parsePdf).not.toHaveBeenCalled();
  expect(learningApi.pdfStudyScope).not.toHaveBeenCalled();
});
it.each([
  ["budget_exhausted", "本轮解析额度已用完"], ["session_expired", "本轮解析会话已结束"]
] as const)("shows %s as paused rather than pending resource admission", async (processing, label) => {
  const value = fixture(); Object.assign(value.readiness, { processing, failedPages: [18] });
  vi.mocked(learningApi.parsed).mockResolvedValue(value as never);
  mount(); await screen.findByText(new RegExp(`${label} · 已完成 1/53 页`));
  expect(screen.queryByText(/等待解析资源/)).not.toBeInTheDocument();
  expect(learningApi.parsePdf).not.toHaveBeenCalled();
});
it("prioritizes an unknown outcome over a wait label and preserves its no-resubmit explanation", async () => {
  const value = fixture();
  Object.assign(value.readiness, { processing: "waiting_resource", unknownPages: [18] });
  vi.mocked(learningApi.parsed).mockResolvedValue(value as never);
  const ui = mount();
  await screen.findByText(/处理结果待确认 · 已完成 1\/53 页/);
  expand(ui.container.querySelector("details")!);
  expect(screen.getByText(/不会自动重新提交。请先核对原请求/)).toBeVisible();
  expect(screen.queryByText(/正在等待解析资源，已完成页已保存/)).not.toBeInTheDocument();
  expect(learningApi.parsePdf).not.toHaveBeenCalled();
});
