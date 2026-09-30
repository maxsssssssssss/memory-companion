import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FrameworkView } from "@/lib/domain/learning-framework";
import { learningApi, LearningApiError } from "@/lib/client/learning-api";
import { LearningFramework } from "./learning-framework";
vi.mock("@/lib/client/learning-api", async (original) => ({ ...await original<typeof import("@/lib/client/learning-api")>(),
  learningApi: { framework: vi.fn(), organize: vi.fn(), editFramework: vi.fn(), frameworkSource: vi.fn(), overview: vi.fn() } }));
const materials = [{ id: "material", title: "合成原文", kind: "text" as const, byteLength: 20, filename: null, createdAt: "", selected: true }];
let view: FrameworkView;
const saveSelection = vi.fn(); const onSource = vi.fn();
function mount() { return render(<LearningFramework pageId="page" materials={materials} selected={["material"]} disabled={false} saveSelection={saveSelection} onSource={onSource} />); }
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.mocked(learningApi.overview).mockResolvedValue({ overview: { latest: null, published: null } });
  view = { runs: [], chapters: [{ id: "chapter", runId: "run", revision: 0, title: "合成章节", explanation: "章节解释", edited: false,
    nodes: [{ id: "node", title: "合成知识点", explanation: "原来的 AI 解释", edited: false, note: "旧笔记", supplement: "基础补充",
      sources: [{ materialId: "material", paragraph: 2, start: 10, end: 20, originalSha256: "mock", paragraphSha256: "mock" }] }] }], overview: [] };
  vi.mocked(learningApi.framework).mockImplementation(async () => ({ framework: structuredClone(view) }));
  saveSelection.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("framework reader and editor (explicit mock data)", () => {
  it("keeps draft and notes on conflict while loading new saved content", async () => {
    mount(); await screen.findByRole("heading", {name: "合成章节"});

    fireEvent.click(screen.getByText("更多")); fireEvent.click(screen.getByRole("button", { name: "编辑知识点 / 笔记" }));
    fireEvent.change(screen.getByLabelText("解释", { exact: true }), { target: { value: "未保存解释" } });
    fireEvent.change(screen.getByLabelText("个人笔记", { exact: true }), { target: { value: "未保存笔记" } });
    view.chapters[0].revision = 1;
    vi.mocked(learningApi.editFramework).mockRejectedValueOnce(new LearningApiError(409, "framework_edit_conflict"));
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("草稿仍在");
    expect(screen.getByLabelText("个人笔记", { exact: true })).toHaveValue("未保存笔记");
    expect(screen.getByLabelText("解释", { exact: true })).toHaveValue("未保存解释");
    expect(learningApi.editFramework).toHaveBeenCalledWith("page", expect.objectContaining({ revision: 0, note: "未保存笔记" }));
  });
  it("validates a source before navigation and distinguishes supplements and personal notes", async () => {
    mount(); await screen.findByRole("heading", {name: "合成章节"});
    expect(screen.getByText("补充解释 · 材料外")).toBeVisible(); expect(screen.getByText("个人笔记", { exact: true })).toBeVisible();
    vi.mocked(learningApi.frameworkSource).mockResolvedValueOnce({ source: { materialId: "material", title: "合成原文", paragraph: { number: 2, text: "原文", start: 10, end: 12 } } });
    const citation = screen.getByText("引用 · 1").closest("details")!;
    expect(citation).not.toHaveAttribute("open");
    expect(learningApi.frameworkSource).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("引用 · 1"));
    fireEvent.click(screen.getByRole("button", { name: "合成原文 · 第 2 段" }));
    await waitFor(() => expect(onSource).toHaveBeenCalledWith("material", 2, undefined));
  });
  it("keeps old content editable while generation waits and never shows partial new chapters", async () => {
    let finish!: (r: { framework: FrameworkView }) => void;
    vi.mocked(learningApi.organize).mockImplementation(() => new Promise((r) => { finish = r; }));
    mount(); await screen.findByRole("heading", {name: "合成章节"});
    fireEvent.click(screen.getByRole("button", { name: "整理新材料" })); fireEvent.click(screen.getByRole("button", { name: "整理所选材料" }));
    await waitFor(() => expect(learningApi.organize).toHaveBeenCalledTimes(1));
     fireEvent.click(screen.getByRole("button", { name: "编辑与管理" })); fireEvent.click(screen.getByRole("button", { name: "编辑章节" }));
    vi.mocked(learningApi.editFramework).mockResolvedValueOnce({ framework: view });
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "生成期间编辑" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(learningApi.editFramework).toHaveBeenCalledTimes(1));
    finish({ framework: view }); await waitFor(() => expect(screen.getByRole("button", { name: "整理所选材料" })).toBeEnabled());
  });
  it("reuses the submission ID when a response is unknown and shows unconfigured honestly", async () => {
    vi.mocked(learningApi.organize).mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new LearningApiError(503, "learning_generation_not_configured"));
    mount(); await screen.findByRole("heading", {name: "合成章节"}); fireEvent.click(screen.getByRole("button", { name: "整理新材料" })); fireEvent.click(screen.getByRole("button", { name: "整理所选材料" }));
    fireEvent.click(await screen.findByRole("button", { name: "核对并继续本次整理" }));
    await waitFor(() => expect(learningApi.organize).toHaveBeenCalledTimes(2));
    expect(vi.mocked(learningApi.organize).mock.calls[0][1]).toBe(vi.mocked(learningApi.organize).mock.calls[1][1]);
    expect(await screen.findByRole("alert")).toHaveTextContent("学习生成尚未配置");
  });
});

it("keeps the current chapter and editor draft when an automatic batch refreshes the framework", async () => {
  const ui = mount(); await screen.findByRole("heading", { name: "合成章节" });
  fireEvent.click(screen.getByText("更多")); fireEvent.click(screen.getByRole("button", { name: "编辑知识点 / 笔记" }));
  fireEvent.change(screen.getByLabelText("个人笔记", { exact: true }), { target: { value: "阅读中的未保存笔记" } });
  view.chapters.push({ ...view.chapters[0], id: "new-chapter", title: "新批次章节", nodes: [] });
  ui.rerender(<LearningFramework pageId="page" materials={materials} selected={["material"]} disabled={false} saveSelection={saveSelection} onSource={onSource} refreshKey={1} />);
  await screen.findByRole("button", { name: /2\. 新批次章节/ });
  expect(screen.getByRole("heading", { name: "合成章节" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "新批次章节" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("个人笔记", { exact: true })).toHaveValue("阅读中的未保存笔记");
});
