import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { LearningPage } from "@/lib/domain/learning";
import { LearningMaterialInput } from "./learning-material-input";
import { LearningWorkspace } from "./learning-workspace";
import { LearningApiError, learningApi } from "@/lib/client/learning-api";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/client/learning-api", async (original) => ({ ...await original<typeof import("@/lib/client/learning-api")>(),
  learningApi: { get: vi.fn(), save: vi.fn(), source: vi.fn(), select: vi.fn(), deleteMaterial: vi.fn(), deletePage: vi.fn(),
    preparation: vi.fn().mockResolvedValue({ runs: [] }), startPreparation: vi.fn(), resumePreparation: vi.fn(),
    transcribe: vi.fn(), transcriptions: vi.fn().mockResolvedValue({ runs: [] }),
    parsed: vi.fn().mockResolvedValue({documents:[],document:null,progress:[],selection:null}),
    framework: vi.fn().mockResolvedValue({ framework: { runs: [], chapters: [], overview: [] } }) }
}));
const page: LearningPage = { id: "test-page", title: "合成测试学习页", createdAt: "", updatedAt: "", revision: 1, materialCount: 1,
  materials: [{ id: "test-material", title: "合成材料", kind: "text", filename: null, byteLength: 40, createdAt: "", selected: true }] };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(learningApi.preparation).mockResolvedValue({ runs: [] }); vi.spyOn(window, "scrollTo").mockImplementation(() => {}); window.history.replaceState(null, "", "/learning/test-page"); });
afterEach(cleanup);

describe("learning stage 1 truthful UI", () => {
  it("keeps manual transcription receipts and late completion when the material window is closed", async () => {
    const audioPage: LearningPage = { ...page, materials: [{ ...page.materials[0], kind: "audio", audio: {
      sha256: "synthetic", originalVersion: 1, mimeType: "audio/wav", durationSeconds: 10,
      transcription: "not_transcribed", completedChunks: 0, totalChunks: 0,
    } }] };
    vi.mocked(learningApi.get).mockResolvedValue({ page: audioPage });
    vi.mocked(learningApi.transcribe).mockRejectedValueOnce(new Error("unknown outcome"));
    render(<LearningWorkspace pageId={page.id} />);
    fireEvent.click(await screen.findByRole("button", { name: "材料" }));
    fireEvent.click(screen.getByRole("button", { name: /材料进度/ }));
    fireEvent.click(screen.getByText("按材料查看处理详情"));
    fireEvent.click(screen.getByRole("button", { name: "转写所选录音" }));
    await screen.findByRole("button", { name: "核对本次转写" });
    const original = vi.mocked(learningApi.transcribe).mock.calls[0];
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /材料进度/ }));
    expect(screen.getByRole("button", { name: "核对本次转写" })).toBeEnabled();
    let finish!: (value: Awaited<ReturnType<typeof learningApi.transcribe>>) => void;
    vi.mocked(learningApi.transcribe).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "核对本次转写" }));
    await waitFor(() => expect(learningApi.transcribe).toHaveBeenCalledTimes(2));
    expect(vi.mocked(learningApi.transcribe).mock.calls[1]).toEqual(original);
    fireEvent.keyDown(document, { key: "Escape" });
    finish({ page: { ...audioPage, revision: 2, materials: audioPage.materials.map(m => ({ ...m, audio: { ...m.audio!, transcription: "completed", completedChunks: 1, totalChunks: 1 } })) } });
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /合成材料/ })).toHaveAccessibleName(/转写完成/));
    expect(learningApi.transcribe).toHaveBeenCalledTimes(2);
  });

  it("opens a confirmation window on file selection and preserves the batch across closing and task navigation", async () => {
    vi.mocked(learningApi.get).mockResolvedValue({ page });
    render(<LearningWorkspace pageId={page.id} />);
    fireEvent.click(await screen.findByRole("button", { name: "材料" }));
    fireEvent.change(screen.getByLabelText("添加文件"), { target: { files: [new File(["synthetic"], "合成课件.pdf", { type: "application/pdf" })] } });
    const dialog = await screen.findByRole("dialog", { name: "材料与进度" });
    expect(within(dialog).getByText("等待确认 · 1 份材料")).toBeVisible();
    expect(learningApi.save).not.toHaveBeenCalled();
    expect(learningApi.startPreparation).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "阅读框架" }));
    fireEvent.click(screen.getByRole("button", { name: /材料进度/ }));
    expect(within(screen.getByRole("dialog")).getByText("合成课件")).toBeVisible();
    expect(screen.getByRole("button", { name: "开始整理 · 1 份" })).toBeEnabled();
    expect(learningApi.save).not.toHaveBeenCalled();
  });

  it("refreshes preparation status with the progress window closed and reads it without resubmitting", async () => {
    vi.mocked(learningApi.get).mockResolvedValue({ page });
    const run: import("@/lib/domain/learning-preparation").LearningPreparationRun = {
      id: "synthetic-run", pageId: page.id, materialIds: ["test-material"], intent: "organize", status: "preparing",
      materials: [], completed: 0, total: 1, frameworkRunId: null, frameworkPublished: false, error: null,
      createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z", canContinue: false, canResume: false,
    };
    vi.mocked(learningApi.preparation).mockResolvedValue({ runs: [run] });
    render(<LearningWorkspace pageId={page.id} />);
    fireEvent.click(await screen.findByRole("button", { name: /材料进度.*处理中/ }));
    expect(await screen.findByText("正在准备学习材料")).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    vi.mocked(learningApi.preparation).mockResolvedValue({ runs: [{ ...run, status: "completed", completed: 1, updatedAt: "2026-09-29T00:01:00Z" }] });
    fireEvent.focus(window);
    fireEvent.click(await screen.findByRole("button", { name: /材料进度.*已完成/ }));
    expect(screen.getByText("本次整理已完成")).toBeVisible();
    expect(learningApi.resumePreparation).not.toHaveBeenCalled();
    expect(learningApi.startPreparation).not.toHaveBeenCalled();
  });

  it("distinguishes recoverable font warnings from long names without claiming parsed content", async () => {
    vi.mocked(learningApi.get).mockResolvedValue({ page: { ...page, materials: [{ ...page.materials[0], kind: "pdf", filename: "synthetic.pdf",
      pdf: { sha256: "synthetic", originalVersion: 1, pageCount: 1, pages: [], parsing: "not_parsed",
        compatibilityWarnings: [{ code: "font_hinting_removed", physicalPage: 1, functionId: 3 }] } }] } });
    render(<LearningWorkspace pageId={page.id} />);
    fireEvent.click(await screen.findByRole("button", { name: "材料" }));
    const material = await screen.findByRole("checkbox", { name: /合成材料/ });
    expect(material.closest("label")).toHaveTextContent("部分字体已停用无效微调指令，请核对原页显示");
    expect(material.closest("label")).not.toHaveTextContent("较长 PDF 名称");
    expect(material.closest("label")).toHaveTextContent("尚无可用学习范围");
  });
  it("keeps an unconfirmed batch and retries the same material IDs instead of duplicating", async () => {
    vi.mocked(learningApi.save).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ page });
    const onSaved = vi.fn();
    function Input() { const [busy, setBusy] = useState(false); return <LearningMaterialInput pageId={page.id} disabled={busy} onBusy={setBusy} onSaved={onSaved} />; }
    render(<Input />);
    fireEvent.click(screen.getByText("粘贴文本或笔记"));
    fireEvent.change(screen.getByLabelText("文本标题"), { target: { value: "合成笔记" } });
    fireEvent.change(screen.getByLabelText("粘贴文本"), { target: { value: "[合成] 不调用模型" } });
    fireEvent.click(screen.getByRole("button", { name: "加入本次材料" }));
    fireEvent.click(await screen.findByRole("button", { name: "开始整理 · 1 份" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("未能确认");
    expect(screen.getByText("合成笔记")).toBeVisible(); expect(onSaved).not.toHaveBeenCalled();
    const first = vi.mocked(learningApi.save).mock.calls[0][1].get("materials");
    expect(vi.mocked(learningApi.save).mock.calls[0][1].get("intent")).toBe("organize");
    expect(screen.getByLabelText("完成后")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重试保存材料" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(page));
    expect(vi.mocked(learningApi.save).mock.calls[1][1].get("materials")).toBe(first);
    expect(screen.getByRole("status")).toHaveTextContent("已保存：1/1");
  });
  it("supports explicit save-only and keeps processing failure separate from saved originals", async () => {
    vi.mocked(learningApi.save).mockResolvedValue({ page });
    render(<LearningMaterialInput pageId={page.id} disabled={false} onBusy={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("添加文件"), {target:{files:[new File(["synthetic"],"合成.pdf",{type:"application/pdf"})]}});
    fireEvent.click(await screen.findByText("其他整理方式"));
    fireEvent.change(screen.getByLabelText("完成后"), { target: { value: "save" } });
    fireEvent.click(screen.getByRole("button",{name:"只保存 · 1 份"}));
    await waitFor(()=>expect(learningApi.save).toHaveBeenCalled());
    expect(vi.mocked(learningApi.save).mock.calls[0][1].get("intent")).toBe("save");
    await screen.findByText("已保存：1/1");
    vi.mocked(learningApi.save).mockImplementation(async (_id,form) => {
      const id=JSON.parse(form.get("materials") as string)[0].id;
      return {page,preparation:[{materialId:id,status:"unavailable",error:"pdf_parser_not_configured"}]};
    });
    fireEvent.change(screen.getByLabelText("添加文件"), {target:{files:[new File(["synthetic"],"另一个合成.pdf")]}});
    fireEvent.click(await screen.findByText("其他整理方式"));
    fireEvent.change(screen.getByLabelText("完成后"), { target: { value: "organize" } });
    fireEvent.click(screen.getByRole("button",{name:"开始整理 · 1 份"}));
    expect(await screen.findByText(/另一个合成：PDF 解析服务尚未配置/)).toHaveTextContent("已保存：1/1");
    expect(screen.queryByText(/本批未保存/)).not.toBeInTheDocument();
  });
  it("shows saved selection, plain source text and the exact deletion warning without fake features", async () => {
    vi.mocked(learningApi.get).mockResolvedValue({ page });
    vi.mocked(learningApi.source).mockResolvedValue({ source: { material: page.materials[0], text: "<script>inert</script>", paragraphs: [{ number: 1, start: 0, end: 22, text: "<script>inert</script>" }] } });
    vi.mocked(learningApi.deleteMaterial).mockResolvedValue({ page: { ...page, materials: [], materialCount: 0, revision: 2 } });
    render(<LearningWorkspace pageId={page.id} />); await screen.findByRole("button", { name: "材料" }); fireEvent.click(screen.getByRole("button", { name: "材料" }));
    expect(await screen.findByRole("checkbox", { name: /合成材料/ })).toBeChecked();
    expect(screen.queryByLabelText("尚未接入的能力")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /生成 Quiz|开始作答/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看原文 合成材料" }));
    expect(await screen.findByText("<script>inert</script>")).toBeVisible(); expect(document.querySelector("script")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "关闭原文" })); fireEvent.click(screen.getByRole("button", { name: "删除材料 合成材料" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("已有成果中可能仍包含材料摘录");
    fireEvent.click(within(dialog).getByRole("button", { name: "删除这份材料" }));
    await waitFor(() => expect(screen.queryByText("<script>inert</script>")).not.toBeInTheDocument());
    expect(await screen.findByText("还没有已保存材料")).toBeVisible();
  });
  it("does not apply a late source response after the user deletes its material", async () => {
    vi.mocked(learningApi.get).mockResolvedValue({ page });
    let finish!: (value: Awaited<ReturnType<typeof learningApi.source>>) => void;
    vi.mocked(learningApi.source).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    vi.mocked(learningApi.deleteMaterial).mockResolvedValue({ page: { ...page, materials: [], materialCount: 0, revision: 2 } });
    render(<LearningWorkspace pageId={page.id} />); await screen.findByRole("button", { name: "材料" }); fireEvent.click(screen.getByRole("button", { name: "材料" })); await screen.findByRole("checkbox");
    fireEvent.click(screen.getByRole("button", { name: "查看原文 合成材料" }));
    await waitFor(() => expect(learningApi.source).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "关闭原文" })); fireEvent.click(screen.getByRole("button", { name: "删除材料 合成材料" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "删除这份材料" }));
    await screen.findByText("还没有已保存材料");
    finish({ source: { material: page.materials[0], text: "LATE_PRIVATE_SOURCE", paragraphs: [{ number: 1, start: 0, end: 19, text: "LATE_PRIVATE_SOURCE" }] } });
    await waitFor(() => expect(screen.queryByLabelText("材料原文")).not.toBeInTheDocument());
    expect(screen.queryByText("LATE_PRIVATE_SOURCE")).not.toBeInTheDocument();
  });
  it("reopens a late paragraph from its source link and aligns that paragraph at the start", async () => {
    vi.mocked(learningApi.get).mockResolvedValue({ page });
    const paragraphs=Array.from({length:70},(_,i)=>({number:i+1,start:i*30,end:i*30+29,text:`[合成] 段落 ${i+1} 的完整条件与例外。`}));
    vi.mocked(learningApi.source).mockResolvedValue({source:{material:page.materials[0],text:paragraphs.map(p=>p.text).join("\n\n"),paragraphs}});
    window.history.replaceState(null,"","/learning/test-page?material=test-material&paragraph=70");
    const previous=HTMLElement.prototype.scrollIntoView;
    const targets:string[]=[];
    const scroll=vi.fn(function(this:HTMLElement){targets.push(this.id);});
    HTMLElement.prototype.scrollIntoView=scroll;
    try {
      render(<LearningWorkspace pageId={page.id} />);
      await waitFor(()=>expect(targets).toContain("learning-paragraph-70"));
      expect(document.getElementById("learning-paragraph-70")).toHaveAttribute("data-current","true");
      expect(scroll).toHaveBeenLastCalledWith({block:"start"});
      expect(within(screen.getByRole("dialog",{name:"材料原文"})).getByLabelText("定位段落")).toHaveValue(70);
    } finally {HTMLElement.prototype.scrollIntoView=previous;}
  });
  it("keeps selection edits visibly unsaved when a concurrent update prevents saving", async () => {
    vi.mocked(learningApi.get).mockResolvedValue({ page });
    vi.mocked(learningApi.select).mockRejectedValue(new LearningApiError(409, "source_changed"));
    render(<LearningWorkspace pageId={page.id} />); await screen.findByRole("button", { name: "材料" }); fireEvent.click(screen.getByRole("button", { name: "材料" })); fireEvent.click(await screen.findByRole("checkbox"));
        expect(await screen.findByRole("alert")).toHaveTextContent("其他操作中改变");
    expect(screen.getByText("选择尚未保存，本地选择已保留")).toBeVisible();
  });
  it("lets users remove a rejected PDF batch, then save corrected input with no fake parsed state", async () => {
    vi.mocked(learningApi.save).mockRejectedValueOnce(new LearningApiError(422, "pdf_encrypted"));
    function Input() { const [busy, setBusy] = useState(false); return <LearningMaterialInput pageId={page.id} disabled={busy} onBusy={setBusy} onSaved={vi.fn()} />; }
    render(<Input />);
    fireEvent.change(screen.getByLabelText("添加文件"), { target: { files: [new File(["synthetic fixture"], "合成密码.pdf", { type: "application/pdf" })] } });
    fireEvent.click(await screen.findByRole("button", { name: "开始整理 · 1 份" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("加密");
    expect(screen.getByRole("button", { name: "移除待保存材料 合成密码" })).toBeEnabled();
    expect(screen.getByText("保存失败，本批未保存。可移除不支持的文件后再次保存。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "移除待保存材料 合成密码" }));
    expect(screen.queryByRole("button", { name: "开始整理 · 1 份" })).not.toBeInTheDocument();
  });
});

it("serializes rapid selection edits and never restores an older saved choice", async () => {
  const other = { ...page.materials[0], id: "other", title: "第二份合成材料" };
  const two = { ...page, materialCount: 2, materials: [...page.materials, other] };
  vi.mocked(learningApi.get).mockResolvedValue({ page: two });
  let finish!: (value: { page: LearningPage }) => void;
  vi.mocked(learningApi.select).mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce({ page: { ...two, revision: 3, materials: two.materials.map(item => ({ ...item, selected: false })) } });
  render(<LearningWorkspace pageId={page.id} />);
  fireEvent.click(await screen.findByRole("button", { name: "材料" }));
  const first = screen.getByRole("checkbox", { name: /^合成材料/ });
  const second = screen.getByRole("checkbox", { name: /第二份合成材料/ });
  fireEvent.click(first); fireEvent.click(second);
  expect(first).not.toBeChecked(); expect(second).not.toBeChecked(); expect(learningApi.select).toHaveBeenCalledTimes(1);
  finish({ page: { ...two, revision: 2, materials: [{ ...two.materials[0], selected: false }, other] } });
  await waitFor(() => expect(learningApi.select).toHaveBeenCalledTimes(2));
  expect(vi.mocked(learningApi.select).mock.calls[1]).toEqual([page.id, 2, []]);
  await screen.findByText("选择已自动保存"); expect(first).not.toBeChecked(); expect(second).not.toBeChecked();
});
it("preserves failed local selection through a refreshed server page before an explicit retry", async () => {
  vi.mocked(learningApi.get).mockResolvedValue({ page });
  vi.mocked(learningApi.select).mockRejectedValueOnce(new LearningApiError(409, "source_changed"));
  render(<LearningWorkspace pageId={page.id} />);
  fireEvent.click(await screen.findByRole("button", { name: "材料" }));
  const check = screen.getByRole("checkbox", { name: /^合成材料/ }); fireEvent.click(check);
  await screen.findByRole("button", { name: "重试保存选择" }); expect(check).not.toBeChecked();
  vi.mocked(learningApi.get).mockResolvedValue({ page: { ...page, revision: 2 } });
  let finish!: (value: { page: LearningPage }) => void;
  vi.mocked(learningApi.select).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "重试保存选择" }));
  await waitFor(() => expect(learningApi.select).toHaveBeenLastCalledWith(page.id, 2, []));
  expect(check).not.toBeChecked();
  finish({ page: { ...page, revision: 3, materials: [{ ...page.materials[0], selected: false }] } });
  await screen.findByText("选择已自动保存"); expect(check).not.toBeChecked();
});

it("starts a fresh workspace when the route changes to another learning page", async () => {
  vi.mocked(learningApi.get).mockResolvedValueOnce({ page: { ...page, revision: 9 } });
  const ui = render(<LearningWorkspace pageId={page.id} />);
  await screen.findByRole("heading", { name: page.title });
  const next = { ...page, id: "next-page", title: "另一合成学习页", revision: 1, materials: [{ ...page.materials[0], id: "next-material", title: "另一材料" }] };
  vi.mocked(learningApi.get).mockResolvedValueOnce({ page: next });
  ui.rerender(<LearningWorkspace pageId={next.id} />);
  await screen.findByRole("heading", { name: next.title });
  expect(screen.queryByRole("heading", { name: page.title })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "材料" }));
  expect(screen.getByRole("checkbox", { name: /另一材料/ })).toBeChecked();
});
it("does not resurrect a deleted page from a late selection save response", async () => {
  vi.mocked(learningApi.get).mockResolvedValue({ page });
  let finish!: (value: { page: LearningPage }) => void;
  vi.mocked(learningApi.select).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  vi.mocked(learningApi.deletePage).mockResolvedValueOnce({ deleted: true });
  render(<LearningWorkspace pageId={page.id} />);
  fireEvent.click(await screen.findByRole("button", { name: "材料" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /^合成材料/ }));
  fireEvent.click(screen.getByText("学习页管理")); fireEvent.click(screen.getByRole("button", { name: "删除学习页" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "删除学习页" }));
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/learning"));
  finish({ page: { ...page, revision: 2, materials: [{ ...page.materials[0], selected: false }] } });
  await waitFor(() => expect(screen.queryByRole("heading", { name: page.title })).not.toBeInTheDocument());
});

it("accepts server exclusion of blocked materials after saving local choices and confirming partial scope", async () => {
  const extra = { ...page.materials[0], id: "extra", title: "另份合成材料" };
  const blocked = { ...page.materials[0], id: "blocked", title: "不可用录音", kind: "audio" as const,
    audio: { sha256: "synthetic", originalVersion: 1 as const, mimeType: "audio/wav", durationSeconds: 1, transcription: "failed" as const, completedChunks: 0, totalChunks: 1 } };
  let current: LearningPage = { ...page, materialCount: 3, materials: [...page.materials, extra, blocked] };
  const partial: import("@/lib/domain/learning-preparation").LearningPreparationRun = {
    id: "partial-run", pageId: page.id, materialIds: [page.materials[0].id, blocked.id], intent: "prepare", status: "needs_attention",
    materials: [{ materialId: page.materials[0].id, title: "合成材料", kind: "text", status: "ready", completed: 1, total: 1, issues: [] },
      { materialId: blocked.id, title: blocked.title, kind: "audio", status: "blocked", completed: 0, total: 1, issues: ["录音未完成转写"] }],
    completed: 1, total: 2, frameworkRunId: null, frameworkPublished: false, error: null,
    createdAt: "2026-09-24T00:00:00Z", updatedAt: "2026-09-24T00:00:00Z", canContinue: true, canResume: false
  };
  vi.mocked(learningApi.get).mockImplementation(async () => ({ page: current }));
  vi.mocked(learningApi.preparation).mockResolvedValue({ runs: [partial] });
  let saved!: (value: { page: LearningPage }) => void;
  vi.mocked(learningApi.select).mockReturnValueOnce(new Promise(resolve => { saved = resolve; }));
  let refreshed!: (value: { page: LearningPage }) => void;
  vi.mocked(learningApi.resumePreparation).mockImplementation(async () => {
    current = { ...current, revision: 3, materials: current.materials.map(item => item.id === blocked.id ? { ...item, selected: false } : item) };
    vi.mocked(learningApi.get).mockReturnValueOnce(new Promise(resolve => { refreshed = resolve; }));
    return { run: { ...partial, status: "completed", updatedAt: "2026-09-24T00:01:00Z" } };
  });
  render(<LearningWorkspace pageId={page.id} />);
  fireEvent.click(await screen.findByRole("button", { name: "材料" }));
  await screen.findByRole("button", { name: /材料进度.*需要处理/ });
  const extraCheck = screen.getByRole("checkbox", { name: /另份合成材料/ });
  const blockedCheck = screen.getByRole("checkbox", { name: /不可用录音/ });
  fireEvent.click(extraCheck);
  fireEvent.click(screen.getByRole("button", { name: /材料进度/ }));
  fireEvent.click(screen.getByRole("button", { name: "先整理可用部分" }));
  expect(extraCheck).toBeDisabled(); expect(blockedCheck).toBeDisabled();
  expect(learningApi.resumePreparation).not.toHaveBeenCalled();
  current = { ...current, revision: 2, materials: current.materials.map(item => item.id === extra.id ? { ...item, selected: false } : item) };
  saved({ page: current });
  await waitFor(() => expect(learningApi.resumePreparation).toHaveBeenCalledWith(page.id, partial.id, { continueWithAvailable: true }));
  expect(extraCheck).toBeDisabled(); expect(blockedCheck).toBeDisabled();
  refreshed({ page: current });
  await waitFor(() => expect(blockedCheck).not.toBeChecked());
  expect(extraCheck).not.toBeChecked(); expect(extraCheck).toBeEnabled();
  expect(screen.getByRole("checkbox", { name: /^合成材料/ })).toBeChecked();
  expect(learningApi.select).toHaveBeenCalledTimes(1);
});
