import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LearningQuiz } from "./learning-quiz";
import { learningApi, LearningApiError } from "@/lib/client/learning-api";
import type { QuizAttemptView, QuizRunSummary } from "@/lib/domain/learning-quiz";
vi.mock("@/lib/client/learning-api", async original => ({ ...await original<typeof import("@/lib/client/learning-api")>(), learningApi: { quizzes: vi.fn(), framework: vi.fn(), generateQuiz: vi.fn(), startQuiz: vi.fn(), quizAttempt: vi.fn(), quizAction: vi.fn(), quizSource: vi.fn(), deleteQuiz: vi.fn() } }));
const settings = { materialIds: ["m"], chapterIds: [], nodeIds: [], includeNotes: false, includeSupplements: false, count: 5, difficulty: "standard" as const };
const run: QuizRunSummary = { id: "q", createdAt: "2026-09-21T12:00:00Z", status: "completed", failure: null, settings, title: "合成题组", count: 1, reason: "仅支持一题", attemptId: null };
let a: QuizAttemptView;
const materials = [{ id: "m", title: "合成文本", kind: "text" as const, byteLength: 8, createdAt: "", filename: null, selected: true }];
const save = vi.fn();
async function mount() { const r = render(<LearningQuiz pageId="p" materials={materials} selected={["m"]} disabled={false} saveSelection={save} onSource={vi.fn()} />); await screen.findByRole("button", { name: "生成 Quiz" }); return r; }
async function ready() { fireEvent.click(screen.getByRole("button", {name:"题组与历史"})); fireEvent.click(await screen.findByRole("button", {name:"使用这组题"})); }
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); window.history.replaceState(null,"","/learning/p?view=quiz"); save.mockResolvedValue(undefined);
  a = { id: "a", quizId: "q", title: "合成题组", mode: "test", revision: 0, completed: false, createdAt: "", completedAt: null, score: null,
    questions: [{ index: 0, stem: "合成问题", kind: "concept", options: [{ id: "A", text: "选项甲" }, { id: "B", text: "选项乙" }], progress: { optionId: null, submitted: false, skipped: false, hinted: false, revealed: false } }] };
  vi.mocked(learningApi.quizzes).mockResolvedValue({ quizzes: [run] }); vi.mocked(learningApi.framework).mockResolvedValue({ framework: { runs: [], chapters: [], overview: [] } });
  vi.mocked(learningApi.deleteQuiz).mockReset().mockResolvedValue({ quizzes: [] });
  vi.mocked(learningApi.startQuiz).mockImplementation(async () => ({ attempt: structuredClone(a) })); vi.mocked(learningApi.quizAttempt).mockImplementation(async () => ({ attempt: structuredClone(a) }));
});
afterEach(cleanup);
it("opens an Agent-created group through the existing quiz preparation and answer contracts", async () => {
  render(<LearningQuiz pageId="p" materials={materials} selected={["m"]} disabled={false} saveSelection={save} onSource={vi.fn()} openQuizId="q" openQuizRequest={1} />);
  await screen.findByRole("button", { name: "开始作答" });
  expect(learningApi.startQuiz).not.toHaveBeenCalled();
  expect(learningApi.generateQuiz).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "开始作答" }));
  await screen.findByText("合成问题");
  expect(learningApi.startQuiz).toHaveBeenCalledExactlyOnceWith("p", expect.any(String), "q", "practice");
});
it("reopens a linked Agent quiz after a refresh using its saved attempt without creating another", async () => {
  window.history.replaceState(null, "", "/learning/p?view=quiz&quiz=q");
  vi.mocked(learningApi.quizzes).mockResolvedValue({ quizzes: [{ ...run, attemptId: "a" }] });
  render(<LearningQuiz pageId="p" materials={materials} selected={["m"]} disabled={false} saveSelection={save} onSource={vi.fn()} />);
  await screen.findByText("合成问题");
  expect(learningApi.startQuiz).not.toHaveBeenCalled();
  expect(learningApi.generateQuiz).not.toHaveBeenCalled();
  expect(new URLSearchParams(window.location.search).get("attempt")).toBe("a");
});
it("returns from a restored completed Agent attempt without sending another quiz or feedback operation", async () => {
  a.completed = true; a.score = { correct: 1, total: 1, unassistedCorrect: 1, hinted: 0, revealed: 0, skipped: 0 };
  window.history.replaceState(null, "", "/learning/p?view=quiz&agent=task-one&attempt=a");
  const onReturn = vi.fn();
  render(<LearningQuiz pageId="p" materials={materials} selected={["m"]} disabled={false} saveSelection={save} onSource={vi.fn()} onReturnToAgent={onReturn} />);
  await screen.findByText("本次答对 1/1 题");
  expect(screen.getByText(/作答已保存。返回本轮复习后/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "返回本轮复习" }));
  expect(onReturn).toHaveBeenCalledOnce();
  expect(learningApi.quizAction).not.toHaveBeenCalled();
  expect(learningApi.startQuiz).not.toHaveBeenCalled();
  expect(learningApi.generateQuiz).not.toHaveBeenCalled();
});
it("confirms the complete group deletion scope and leaves everything untouched on cancel", async () => {
  await mount(); fireEvent.click(screen.getByRole("button", { name: "题组与历史" }));
  fireEvent.click(await screen.findByRole("button", { name: "删除题组 合成题组" }));
  const dialog = screen.getByRole("dialog", { name: "删除「合成题组」？" });
  expect(within(dialog).getByText(/全部作答记录，包括未完成的练习或测验/)).toBeVisible();
  expect(within(dialog).getByText(/材料、知识框架、个人笔记及其他题组会保留/)).toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "使用这组题" })).toBeEnabled();
  expect(learningApi.deleteQuiz).not.toHaveBeenCalled();
  expect(learningApi.quizAction).not.toHaveBeenCalled();
});

it("keeps a failed deletion in the confirmation and prevents duplicate clicks while it is pending", async () => {
  let reject!: (reason: unknown) => void;
  vi.mocked(learningApi.deleteQuiz).mockImplementationOnce(() => new Promise((_resolve, rejectRequest) => { reject = rejectRequest; }));
  await mount(); fireEvent.click(screen.getByRole("button", { name: "题组与历史" }));
  fireEvent.click(await screen.findByRole("button", { name: "删除题组 合成题组" }));
  fireEvent.click(screen.getByRole("button", { name: "删除题组与记录" }));
  expect(screen.getByRole("button", { name: "正在删除…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "正在删除…" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeVisible();
  await act(async () => { reject(new LearningApiError(503, "learning_storage_unavailable")); });
  expect(within(screen.getByRole("dialog")).getByRole("alert")).toBeVisible();
  expect(screen.getByRole("button", { name: "删除题组与记录" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.getByRole("button", { name: "使用这组题" })).toBeEnabled();
  expect(learningApi.deleteQuiz).toHaveBeenCalledExactlyOnceWith("p", "q");
});

it("removes the selected group and restoration state, rejects a late old list, and keeps other groups usable", async () => {
  const other = { ...run, id: "other", title: "保留的题组" };
  vi.mocked(learningApi.quizzes).mockResolvedValue({ quizzes: [{ ...run, attemptId: "a" }, other] });
  window.history.replaceState(null, "", "/learning/p?view=quiz&attempt=a&question=0");
  await mount(); await screen.findByText("合成问题");
  fireEvent.click(screen.getByRole("button", { name: "题组与历史" }));
  await screen.findByRole("button", { name: "删除题组 合成题组" });
  let completeOldRead!: (value: { quizzes: QuizRunSummary[] }) => void;
  vi.mocked(learningApi.quizzes).mockImplementationOnce(() => new Promise(resolve => { completeOldRead = resolve; }));
  fireEvent.focus(window);
  await waitFor(() => expect(completeOldRead).toBeTypeOf("function"));
  vi.mocked(learningApi.deleteQuiz).mockResolvedValue({ quizzes: [other] });
  fireEvent.click(screen.getByRole("button", { name: "删除题组 合成题组" }));
  fireEvent.click(screen.getByRole("button", { name: "删除题组与记录" }));
  await screen.findByText("题组及其作答记录已删除。");
  await act(async () => { completeOldRead({ quizzes: [{ ...run, attemptId: "a" }, other] }); });
  expect(screen.queryByRole("button", { name: "删除题组 合成题组" })).not.toBeInTheDocument();
  expect(screen.queryByText("合成问题")).not.toBeInTheDocument();
  expect(new URLSearchParams(window.location.search).has("attempt")).toBe(false);
  expect(new URLSearchParams(window.location.search).has("question")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "使用这组题" }));
  expect(screen.getByRole("heading", { name: "保留的题组" })).toBeVisible();
  expect(screen.getByRole("button", { name: "开始作答" })).toBeEnabled();
  expect(learningApi.quizAction).not.toHaveBeenCalled();
  expect(learningApi.generateQuiz).not.toHaveBeenCalled();
});

it("clears a deleted in-progress generation receipt so it cannot be resumed on reopen", async () => {
  sessionStorage.setItem("learning-quiz-pending:p", JSON.stringify({ id: "q", settings }));
  vi.mocked(learningApi.quizzes).mockResolvedValue({ quizzes: [{ ...run, status: "generating" }] });
  await mount(); fireEvent.click(screen.getByRole("button", { name: "题组与历史" }));
  fireEvent.click(await screen.findByRole("button", { name: "删除题组 合成题组" }));
  expect(screen.getByText(/删除后，即使生成返回，也不会恢复题组/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "删除题组与记录" }));
  await screen.findByText("题组及其作答记录已删除。");
  expect(sessionStorage.getItem("learning-quiz-pending:p")).toBeNull();
  expect(screen.getByText("还没有题组，选择材料后可以开始生成。")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "生成另一组" }));
  expect(screen.queryByRole("button", { name: "核对并继续本次生成" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "生成 Quiz" })).toBeEnabled();
  expect(learningApi.generateQuiz).not.toHaveBeenCalled();
});

it.each([[404, "quiz_not_found"], [410, "quiz_deleted"]] as const)("drops an unavailable attempt (%s) without hiding the remaining history", async (status, code) => {
  const other = { ...run, id: "other", title: "保留的题组" };
  vi.mocked(learningApi.quizzes).mockResolvedValue({ quizzes: [{ ...run, attemptId: "a" }, other] });
  window.history.replaceState(null, "", "/learning/p?view=quiz&attempt=a&question=0");
  await mount(); await screen.findByText("合成问题");
  vi.mocked(learningApi.quizzes).mockResolvedValue({ quizzes: [other] });
  vi.mocked(learningApi.quizAttempt).mockRejectedValue(new LearningApiError(status, code));
  fireEvent.focus(window);
  await screen.findByText("这份题组或作答记录已不可用，可以继续使用其他题组。");
  expect(screen.queryByText("合成问题")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "删除题组 合成题组" })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "保留的题组" })).toBeVisible();
  expect(screen.getByRole("button", { name: "使用这组题" })).toBeEnabled();
  expect(new URLSearchParams(window.location.search).has("attempt")).toBe(false);
  const reads = vi.mocked(learningApi.quizAttempt).mock.calls.length;
  fireEvent.focus(window);
  await waitFor(() => expect(learningApi.quizzes).toHaveBeenCalledTimes(3));
  expect(learningApi.quizAttempt).toHaveBeenCalledTimes(reads);
  expect(learningApi.generateQuiz).not.toHaveBeenCalled();
});

it("does not touch navigation or receipts after leaving while deletion completes", async () => {
  let finish!: (value: { quizzes: QuizRunSummary[] }) => void;
  vi.mocked(learningApi.deleteQuiz).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = await mount(); fireEvent.click(screen.getByRole("button", { name: "题组与历史" }));
  fireEvent.click(await screen.findByRole("button", { name: "删除题组 合成题组" }));
  fireEvent.click(screen.getByRole("button", { name: "删除题组与记录" }));
  view.unmount();
  window.history.replaceState(null, "", "/learning/other?view=quiz&attempt=other-attempt&question=1");
  sessionStorage.setItem("learning-quiz-pending:other", "retained-receipt");
  await act(async () => { finish({ quizzes: [] }); });
  expect(window.location.pathname).toBe("/learning/other");
  expect(new URLSearchParams(window.location.search).get("attempt")).toBe("other-attempt");
  expect(sessionStorage.getItem("learning-quiz-pending:other")).toBe("retained-receipt");
});

it("keeps explicit history navigation when an old attempt restoration arrives late", async () => {
  let finish!: (value: { attempt: QuizAttemptView }) => void;
  vi.mocked(learningApi.quizAttempt).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  window.history.replaceState(null, "", "/learning/p?view=quiz&attempt=a&question=0");
  await mount();
  await waitFor(() => expect(learningApi.quizAttempt).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "题组与历史" }));
  await screen.findByRole("button", { name: "使用这组题" });
  fireEvent.click(screen.getByRole("button", { name: "生成另一组" }));
  await act(async () => { finish({ attempt: structuredClone(a) }); });
  expect(screen.getByRole("button", { name: "生成 Quiz" })).toBeVisible();
  expect(screen.queryByRole("heading", { name: "测验" })).not.toBeInTheDocument();
  expect(learningApi.quizAttempt).toHaveBeenCalledTimes(1);
  expect(learningApi.quizAction).not.toHaveBeenCalled();
  expect(learningApi.generateQuiz).not.toHaveBeenCalled();
  expect(new URLSearchParams(window.location.search).has("attempt")).toBe(false);
});

it("shows saved material-coverage limits in the existing quiz flow without exposing answers or generating again", async () => {
  const reason = "本组题引用了 2/3 份所选材料，未引用《合成 PDF》；不代表已覆盖全部学习范围。";
  vi.mocked(learningApi.quizzes).mockResolvedValue({ quizzes: [{ ...run, reason }] });
  await mount(); await ready();
  expect(screen.getByText(reason)).toBeVisible();
  expect(screen.queryByText(/正确选项/)).not.toBeInTheDocument();
  expect(learningApi.generateQuiz).not.toHaveBeenCalled();
});

it("shows a zero-publication failure without blaming insufficient material or exposing a rejected answer", async () => {
  const delivery = { requested: 3, candidates: 3, published: 0, rejected: [{ code: "equivalent_options" as const, count: 3 }],
    message: "这次未能生成可靠的题目，没有提供可作答题组。",
    nextStep: "可以先结合原文理清概念；这次生成不用于判断你是否掌握。" };
  vi.mocked(learningApi.quizzes).mockResolvedValue({ quizzes: [{ ...run, status: "insufficient", count: 0,
    reason: "不应展示的原生成说明：正确答案A", delivery }] });
  await mount();
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(delivery.message); expect(alert).toHaveTextContent(delivery.nextStep);
  expect(alert).not.toHaveTextContent(/依据不足|材料不足|正确答案|equivalent_options/);
  fireEvent.click(screen.getByRole("button", { name: "题组与历史" }));
  expect(await screen.findByText(delivery.message)).toBeVisible();
  expect(screen.queryByText(/不应展示的原生成说明|依据不足/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "使用这组题" })).not.toBeInTheDocument();
  expect(learningApi.generateQuiz).not.toHaveBeenCalled(); expect(learningApi.startQuiz).not.toHaveBeenCalled();
});

it("gives legacy zero-publication runs an honest fallback without guessing their rejection cause", async () => {
  vi.mocked(learningApi.quizzes).mockResolvedValue({ quizzes: [{ ...run, status: "insufficient", count: 0, reason: "旧模型不可作为诊断的原文" }] });
  await mount();
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("这次未能生成可靠的题目");
  expect(alert).toHaveTextContent("这不代表你没有掌握");
  expect(alert).not.toHaveTextContent(/材料不足|依据不足|旧模型不可/);
  expect(learningApi.generateQuiz).not.toHaveBeenCalled();
});

it("keeps the one valid question from a partial delivery usable and hides answer details until submission", async () => {
  const delivery = { requested: 3, candidates: 3, published: 1, rejected: [{ code: "option_identity" as const, count: 2 }],
    message: "本次准备了 1/3 道可作答题目，其余未发布。",
    nextStep: "你可以先完成这些题；未检查的目标仍然保留。" };
  vi.mocked(learningApi.quizzes).mockResolvedValue({ quizzes: [{ ...run, settings: { ...settings, count: 3 }, delivery }] });
  await mount(); await ready();
  expect(screen.getByText(delivery.message)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "开始作答" }));
  expect(await screen.findByText("合成问题")).toBeVisible();
  expect(screen.getByText(delivery.message)).toBeVisible();
  expect(screen.getByText(delivery.nextStep)).toBeVisible();
  expect(screen.queryByText(/正确选项|option_identity|已覆盖全部/)).not.toBeInTheDocument();
  expect(learningApi.startQuiz).toHaveBeenCalledOnce(); expect(learningApi.generateQuiz).not.toHaveBeenCalled();
});

it("keeps an older failed generation in history without presenting it as the current generation failure", async () => {
  const old:QuizRunSummary={...run,id:"old-failure",status:"failed",failure:"quiz_invalid_result",progress:{completed:1,total:2,canResume:true,uncertain:false}};
  vi.mocked(learningApi.quizzes).mockResolvedValue({quizzes:[{...run,status:"generating",progress:{completed:2,total:4,canResume:false,uncertain:false}},old]});
  await mount();
  expect(await screen.findByRole("status")).toHaveTextContent("2/4");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByRole("button",{name:"继续未完成部分"})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:"题组与历史"}));
  expect(await screen.findByText(/本次题目结构、数量或来源不符合要求/)).toBeVisible();
});
it.each([
  ["quiz_reading_invalid_source", "材料整理阶段的原文定位未通过检查", false],
  ["quiz_reading_restart_required", "这次材料整理采用的旧格式已无法继续", false],
  ["quiz_reading_invalid_result", "材料整理阶段的结果不符合格式要求", true],
  ["quiz_selection_invalid_result", "考点安排阶段的结果不符合要求", true],
] as const)("explains %s before any questions and preserves the available recovery action", async (failure, message, canResume) => {
  vi.mocked(learningApi.quizzes).mockResolvedValue({ quizzes: [{ ...run, id: "failed-reading", status: "failed", failure,
    title: null, count: 0, progress: { completed: 1, total: 3, canResume, uncertain: false },
    delivery: { requested: 5, candidates: null, published: 0, rejected: [{ code: "known_failure", count: 1 }],
      message: "这次生成未能完成。", nextStep: "可先回看原文。" } }, run] });
  await mount();
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(message);
  expect(alert).toHaveTextContent(/尚未开始出题|尚未生成可作答题组/);
  expect(alert).toHaveTextContent(/材料.*旧成果保留/);
  expect(alert).not.toHaveTextContent(/题目结构、数量|缩小|删减|缩减/);
  if (canResume) expect(screen.getByRole("button", { name: "继续未完成部分" })).toBeEnabled();
  else {
    expect(alert).toHaveTextContent("重新生成新题组");
    expect(screen.queryByRole("button", { name: "继续未完成部分" })).not.toBeInTheDocument();
  }
  expect(screen.getByRole("button", { name: "生成 Quiz" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "题组与历史" }));
  expect(await screen.findByText(new RegExp(message))).toBeVisible();
  expect(screen.getByRole("button", { name: "使用这组题" })).toBeEnabled();
  expect(learningApi.generateQuiz).not.toHaveBeenCalled();
});
it("shows explicit included and excluded ranges without treating chapter bodies as sources", async () => {
  vi.mocked(learningApi.framework).mockResolvedValue({framework:{runs:[],overview:[],chapters:[{id:"c",runId:"f",revision:0,title:"容量章节",explanation:"AI正文不是依据",edited:false,nodes:[{id:"n",title:"容量规则",explanation:"AI正文",note:"个人笔记",supplement:null,edited:false,sources:[{materialId:"m",paragraph:2,start:0,end:8,originalSha256:"old",paragraphSha256:"p"}]}]}]}});
  render(<LearningQuiz pageId="p" materials={[...materials,{...materials[0],id:"other",title:"未选材料",selected:false}]} selected={["m"]} disabled={false} saveSelection={save} onSource={vi.fn()}/>);
  await screen.findByRole("button",{name:"生成 Quiz"});fireEvent.click(screen.getByText(/本次范围预览/));
  expect(screen.getByText(/未包含材料：未选材料/)).toBeVisible();expect(screen.getByText(/已保存正文全文/)).toBeVisible();
  fireEvent.change(screen.getByLabelText("出题范围"),{target:{value:"chapters"}});fireEvent.click(await screen.findByLabelText("容量章节"));
  expect(screen.getByText(/仅引用段落 2/)).toBeVisible();expect(screen.getByText(/不读取框架正文/)).toBeVisible();
  expect(screen.getByText(/个人笔记：未纳入/)).toBeVisible();fireEvent.click(screen.getByLabelText("纳入所选范围的个人笔记"));
  expect(screen.getByText(/个人笔记：1 条，明确纳入/)).toBeVisible();expect(learningApi.generateQuiz).not.toHaveBeenCalled();
});
it("uses persisted order for display letters while saving stable option IDs and matching feedback", async () => {
  a.questions[0].options.reverse(); a.questions[0].options.forEach((o,i)=>{o.label=String.fromCharCode(65+i);});
  a.mode = "practice";
  vi.mocked(learningApi.quizAction).mockImplementation(async (_page, value) => {
    a.revision++; a.questions[0].progress.optionId = value.optionId;
    a.questions[0].progress.submitted = true;
    a.questions[0].feedback = { correct: false, correctOptionId: "A", explanation: "原解释", reasons: [{id:"B",reason:"乙的理由"},{id:"A",reason:"甲的理由"}], sources: [] };
    return { attempt: structuredClone(a) };
  });
  await mount(); await ready(); fireEvent.click(screen.getByRole("button", {name:"开始作答"}));
  fireEvent.click(await screen.findByRole("radio", {name:"A. 选项乙"}));
  await waitFor(() => expect(learningApi.quizAction).toHaveBeenCalledWith("p", expect.objectContaining({optionId:"B"})));
  await screen.findByText(/正确选项 B/); fireEvent.click(screen.getByText("各选项说明")); expect(screen.getByText("A：乙的理由")).toBeVisible(); expect(screen.getByText("B：甲的理由")).toBeVisible();
});
it("defaults to material-only independent quiz, with explicit optional evidence and no fake answers", async () => {
  await mount(); expect(screen.getByLabelText("纳入所选范围的个人笔记")).not.toBeChecked(); expect(screen.getByLabelText("纳入所选知识点已保存的补充解释")).not.toBeChecked();
  vi.mocked(learningApi.generateQuiz).mockResolvedValue({ quizzes: [run] }); fireEvent.click(screen.getByRole("button", { name: "生成 Quiz" }));
  await waitFor(() => expect(learningApi.generateQuiz).toHaveBeenCalledWith("p", expect.any(String), settings)); expect(save).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/正确选项/)).not.toBeInTheDocument();
});
it("keeps test answers absent, auto-saves choices, and retries unknown save with the same event ID", async () => {
  await mount(); await ready(); fireEvent.click(screen.getByRole("radio", {name:/测验/})); fireEvent.click(screen.getByRole("button", { name: "开始作答" })); await screen.findByText("合成问题");
    expect(new URL(window.location.href).searchParams.get("view")).toBe("quiz");
    expect(new URL(window.location.href).searchParams.get("attempt")).toBe("a");
  expect(screen.queryByRole("button", { name: "看答案" })).not.toBeInTheDocument(); expect(screen.queryByText(/正确选项/)).not.toBeInTheDocument();
  vi.mocked(learningApi.quizAction).mockRejectedValueOnce(new LearningApiError(503, "learning_storage_unavailable")).mockImplementationOnce(async () => { a.revision++; a.questions[0].progress.optionId = "A"; return { attempt: structuredClone(a) }; });
  fireEvent.click(screen.getByRole("radio", { name: "A. 选项甲" })); await screen.findByText(/这次作答的保存结果尚未确认/); expect(screen.getByRole("radio", { name: "A. 选项甲" })).not.toBeChecked();
  expect(screen.getByRole("status")).toHaveTextContent("保存尚未确认");
  expect(screen.getByRole("radio", { name: "B. 选项乙" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "题组与历史" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "核对并重试同一作答操作" })); await waitFor(() => expect(screen.getByRole("radio", { name: "A. 选项甲" })).toBeChecked());
  expect(screen.getByRole("status")).toHaveTextContent("选择已保存");
  expect(screen.queryByText(/这次作答的保存结果尚未确认/)).not.toBeInTheDocument();
  expect(screen.queryByText(/正确选项/)).not.toBeInTheDocument();
  expect(vi.mocked(learningApi.quizAction).mock.calls[0]).toEqual(vi.mocked(learningApi.quizAction).mock.calls[1]); expect(learningApi.generateQuiz).not.toHaveBeenCalled();
});

it("hides preparation while answering and advances a test only after choose is saved", async () => {
  a.questions.push({ ...structuredClone(a.questions[0]), index: 1, stem: "第二题" });
  await mount(); await ready(); fireEvent.click(screen.getByRole("button", {name:"开始作答"}));
  await screen.findByText("合成问题");
  expect(screen.queryByRole("button", {name:"生成 Quiz"})).not.toBeInTheDocument();
  expect(screen.queryByRole("button", {name:"确认答案"})).not.toBeInTheDocument();
  expect(screen.getByRole("button", {name:"下一题"})).toBeDisabled();
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("请选择一个选项"));
  const status = screen.getByRole("status");
  const answer = screen.getByRole("article", {name:"当前作答"});
  const preceding = answer.previousElementSibling;
  let finish!: (value: {attempt:QuizAttemptView}) => void;
  vi.mocked(learningApi.quizAction).mockImplementationOnce(() => new Promise(resolve => {finish=resolve;}));
  fireEvent.click(screen.getByRole("radio", {name:"A. 选项甲"}));
  expect(screen.getByRole("status")).toBe(status);
  expect(status).toHaveTextContent("正在保存…");
  expect(answer.previousElementSibling).toBe(preceding);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", {name:"核对并重试同一作答操作"})).not.toBeInTheDocument();
  expect(screen.getByRole("radio", {name:"B. 选项乙"})).toBeDisabled();
  expect(screen.getByRole("button", {name:"下一题"})).toBeDisabled();
  fireEvent.click(screen.getByRole("radio", {name:"B. 选项乙"}));
  expect(learningApi.quizAction).toHaveBeenCalledTimes(1);
  a.questions[0].progress.optionId="A";a.revision++;finish({attempt:structuredClone(a)});
  await waitFor(()=>expect(screen.getByRole("button", {name:"下一题"})).toBeEnabled());
  expect(screen.getByRole("status")).toBe(status);
  expect(status).toHaveTextContent("选择已保存");
  expect(answer.previousElementSibling).toBe(preceding);
  fireEvent.click(screen.getByRole("button", {name:"下一题"}));await screen.findByText("第二题");
  expect(learningApi.quizAction).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", {name:"交卷并查看结果"})).toBeVisible();
});

it("keeps feedback citations closed until expanded and preserves source lookup and unavailable states", async () => {
  a.mode = "practice";
  a.questions.push({ ...structuredClone(a.questions[0]), index: 1, stem: "第二题" });
  const source = { kind: "material" as const, materialId: "m", paragraph: 2, start: 0, end: 8, originalSha256: "original", paragraphSha256: "paragraph", state: "available" };
  vi.mocked(learningApi.quizAction).mockImplementationOnce(async () => {
    a.revision++;
    a.questions[0].progress.revealed = true;
    a.questions[0].feedback = { correct: false, correctOptionId: "A", explanation: "合成解析", reasons: [], sources: [source, {...source, state: "material_deleted"}, {...source, state: "changed"}] };
    return {attempt: structuredClone(a)};
  });
  vi.mocked(learningApi.quizSource).mockResolvedValue({source: {kind:"material", materialId:"m", paragraph: {number:2, start:0, end:4, text:"合成来源"}}});
  const onSource = vi.fn();
  render(<LearningQuiz pageId="p" materials={materials} selected={["m"]} disabled={false} saveSelection={save} onSource={onSource}/>);
  await screen.findByRole("button", {name:"生成 Quiz"}); await ready();
  fireEvent.click(screen.getByRole("button", {name:"开始作答"}));
  await screen.findByText("合成问题");
  expect(screen.queryByLabelText("解析引用")).not.toBeInTheDocument();
  expect(screen.queryByText("合成解析")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", {name:"看答案"}));
  await screen.findByText("合成解析");
  const references = screen.getByLabelText("解析引用");
  expect(references).not.toHaveAttribute("open");
  expect(screen.getByText("引用 · 3")).toBeVisible();
  expect(screen.getByText("原材料 · 第 2 段")).not.toBeVisible();
  expect(learningApi.quizSource).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("引用 · 3"));
  expect(references).toHaveAttribute("open");
  expect(screen.getByRole("button", {name:"来源已删除"})).toBeDisabled();
  expect(screen.getByRole("button", {name:"来源已变化"})).toBeDisabled();
  fireEvent.click(screen.getByRole("button", {name:"原材料 · 第 2 段"}));
  await waitFor(() => expect(onSource).toHaveBeenCalledWith("m", 2, undefined));
  expect(learningApi.quizSource).toHaveBeenCalledWith("p", "a", 0, 0);
  fireEvent.click(screen.getByRole("button", {name:"下一题"}));
  await screen.findByText("第二题");
  fireEvent.click(screen.getByRole("button", {name:"上一题"}));
  await screen.findByText("合成问题");
  expect(screen.getByLabelText("解析引用")).not.toHaveAttribute("open");
  expect(learningApi.quizAction).toHaveBeenCalledTimes(1);
});

it("starts completed test result citations collapsed when restoring saved feedback", async () => {
  a.completed = true;
  a.questions[0].progress.optionId = "A";
  a.questions[0].progress.submitted = true;
  a.questions[0].feedback = {
    correct: true, correctOptionId: "A", explanation: "已保存的测验解析", reasons: [],
    sources: [{kind:"note", id:"note", sha256:"saved", nodeId:"node", chapterId:"chapter", state:"available"}],
  };
  window.history.replaceState(null, "", "/learning/p?view=quiz&attempt=a&question=0");
  await mount();
  await screen.findByText("已保存的测验解析");
  const review = screen.getByLabelText("第 1 题回顾");
  expect(review).not.toHaveAttribute("open");
  expect(screen.getByText("已保存的测验解析")).not.toBeVisible();
  fireEvent.click(review.querySelector("summary")!);
  expect(screen.getByLabelText("解析引用")).not.toHaveAttribute("open");
  expect(screen.getByText("个人笔记依据")).not.toBeVisible();
  fireEvent.click(screen.getByText("引用 · 1"));
  expect(screen.getByRole("button", {name:"个人笔记依据"})).toBeVisible();
  expect(learningApi.quizAction).not.toHaveBeenCalled();
  expect(learningApi.quizSource).not.toHaveBeenCalled();
});

it("keeps every result collapsed despite the saved question position and groups stable answers without changing history", async () => {
  a.completed = true;
  a.score = {correct:1,total:2,unassistedCorrect:0,hinted:1,revealed:0,skipped:1};
  const first = a.questions[0];
  first.stem = "合成的完整长题干：在两种材料给出的条件均成立、且没有触发例外时，应如何解释这个案例？这些条件需要完整保留，折叠预览不能删改历史题目。";
  first.options = [{id:"B",label:"A",text:"选项乙"},{id:"A",label:"B",text:"选项甲"}];
  first.progress = {optionId:"B",submitted:true,skipped:false,hinted:true,revealed:false};
  first.hint = "先区分适用前提和执行结果。";
  first.feedback = {correct:true,correctOptionId:"B",explanation:"合成的已保存解析。",reasons:[{id:"A",reason:"甲不满足材料前提。"},{id:"B",reason:"乙满足完整条件。"}],sources:[]};
  a.questions.push({...structuredClone(first),index:1,stem:"第二题完整题干",progress:{optionId:null,submitted:false,skipped:true,hinted:false,revealed:false},feedback:{...structuredClone(first.feedback),correct:false}});
  const before = structuredClone(a);
  window.history.replaceState(null,"","/learning/p?view=quiz&attempt=a&question=1");
  await mount();
  const reviews = await screen.findAllByLabelText(/第 \d 题回顾/);
  expect(reviews).toHaveLength(2);
  for(const review of reviews) expect(review).not.toHaveAttribute("open");
  expect(screen.getByText("本次答对 1/2 题")).toBeVisible();
  expect(screen.getByText("无提示答对 0 题 · 使用提示 1 题 · 看答案 0 题 · 跳过 1 题")).toBeVisible();
  expect(within(reviews[0]).getByText("使用过提示")).toBeVisible();
  expect(within(reviews[1]).getByText("已跳过")).toBeVisible();
  fireEvent.click(reviews[0].querySelector("summary")!);
  expect(reviews[0]).toHaveAttribute("open");
  expect(reviews[1]).not.toHaveAttribute("open");
  expect(within(reviews[0]).getByText("你的选择").nextElementSibling).toHaveTextContent("A. 选项乙");
  expect(within(reviews[0]).getByText("正确答案").nextElementSibling).toHaveTextContent("A. 选项乙");
  expect(within(reviews[0]).getByText("合成的已保存解析。")).toBeVisible();
  expect(within(reviews[0]).getByText("甲不满足材料前提。")).not.toBeVisible();
  fireEvent.click(within(reviews[0]).getByText("各选项说明"));
  expect(within(reviews[0]).getByText("甲不满足材料前提。").parentElement).toHaveTextContent("B. 选项甲");
  expect(within(reviews[0]).getByText("乙满足完整条件。").parentElement).toHaveTextContent("A. 选项乙");
  fireEvent.click(reviews[0].querySelector("summary")!);
  expect(reviews[0]).not.toHaveAttribute("open");
  expect(a).toEqual(before);
  expect(learningApi.quizAction).not.toHaveBeenCalled();
  expect(learningApi.generateQuiz).not.toHaveBeenCalled();
  expect(learningApi.startQuiz).not.toHaveBeenCalled();
});

it("restores a confirmed practice question from the URL without another submit or shuffle", async () => {
  a.mode="practice";a.questions[0].progress.submitted=true;a.questions[0].progress.optionId="B";
  a.questions[0].options.reverse();
  window.history.replaceState(null,"","/learning/p?view=quiz&attempt=a&question=0");
  await mount();await screen.findByText("合成问题");
  expect(screen.queryByRole("button", {name:"确认答案"})).not.toBeInTheDocument();
  expect(screen.getByRole("radio", {name:"B. 选项乙"})).toBeChecked();
  expect(learningApi.quizAction).not.toHaveBeenCalled();expect(learningApi.startQuiz).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", {name:"下一题"})).not.toBeInTheDocument();
});

it("restores an unknown operation receipt and prevents history navigation until retry succeeds", async () => {
  const receipt={id:"event",attemptId:"a",revision:0,action:"choose",question:0,optionId:"B"};
  sessionStorage.setItem("learning-quiz-pending:p:action",JSON.stringify(receipt));
  window.history.replaceState(null,"","/learning/p?view=quiz&attempt=a&question=0");
  vi.mocked(learningApi.quizAction).mockResolvedValueOnce({attempt:a});
  await mount();await screen.findByText("合成问题");
  expect(screen.getByRole("button", {name:"题组与历史"})).toBeDisabled();
  fireEvent.click(screen.getByRole("button", {name:"核对并重试同一作答操作"}));
  await waitFor(()=>expect(learningApi.quizAction).toHaveBeenCalledWith("p",receipt));
  await waitFor(()=>expect(sessionStorage.getItem("learning-quiz-pending:p:action")).toBeNull());
});


it("embeds only the requested group and keeps practice completion on its final explanation", async () => {
  a.mode = "practice";
  const onAttemptSaved = vi.fn();
  window.history.replaceState(null, "", "/learning/p?view=agent");
  vi.mocked(learningApi.quizAction).mockImplementation(async (_page, value) => {
    a.revision++;
    a.questions[0].progress.optionId = "A";
    if (value.action === "submit") {
      a.completed = true; a.questions[0].progress.submitted = true;
      a.questions[0].feedback = {correct:true, correctOptionId:"A", explanation:"最后一题的解析", reasons:[], sources:[]};
    }
    return {attempt:structuredClone(a)};
  });
  render(<LearningQuiz pageId="p" materials={materials} selected={["m"]} disabled={false} saveSelection={save} onSource={vi.fn()} embedded openQuizId="q" onAttemptSaved={onAttemptSaved} onReturnToAgent={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", {name:"开始作答"}));
  await screen.findByText("合成问题");
  expect(screen.queryByRole("button", {name:"题组与历史"})).not.toBeInTheDocument();
  expect(screen.queryByRole("button", {name:"返回本轮复习"})).not.toBeInTheDocument();
  expect(screen.queryByRole("button", {name:"生成 Quiz"})).not.toBeInTheDocument();
  expect(learningApi.framework).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("radio", {name:"A. 选项甲"}));
  await waitFor(() => expect(screen.getByRole("button", {name:"确认答案"})).toBeEnabled());
  expect(onAttemptSaved.mock.calls.every(([attempt]) => !attempt.completed)).toBe(true);
  fireEvent.click(screen.getByRole("button", {name:"确认答案"}));
  await screen.findByText("最后一题的解析");
  expect(screen.getByRole("article", {name:"当前作答"})).toBeVisible();
  await waitFor(() => expect(onAttemptSaved.mock.calls.filter(([attempt]) => attempt.completed)).toHaveLength(1));
  fireEvent.focus(window);
  await waitFor(() => expect(learningApi.quizAttempt).toHaveBeenCalled());
  expect(onAttemptSaved.mock.calls.filter(([attempt]) => attempt.completed)).toHaveLength(1);
  expect(window.location.search).toBe("?view=agent");
  fireEvent.click(screen.getByRole("button", {name:"查看本次结果"}));
  expect(screen.queryByRole("button", {name:"生成另一组"})).not.toBeInTheDocument();
  expect(screen.getByLabelText("第 1 题回顾").querySelector("summary")).toBeVisible();
  expect(learningApi.generateQuiz).not.toHaveBeenCalled();
});

it("notifies an embedded test only of server-confirmed completion after hand-in", async () => {
  const onAttemptSaved = vi.fn();
  vi.mocked(learningApi.quizzes).mockResolvedValue({quizzes:[{...run, attemptId:"a"}]});
  vi.mocked(learningApi.quizAction).mockImplementation(async (_page, value) => {
    a.revision++; a.questions[0].progress.optionId="A";
    if(value.action === "finish") {a.completed=true;a.questions[0].progress.submitted=true;}
    return {attempt:structuredClone(a)};
  });
  render(<LearningQuiz pageId="p" materials={materials} selected={["m"]} disabled={false} saveSelection={save} onSource={vi.fn()} embedded openQuizId="q" onAttemptSaved={onAttemptSaved} />);
  fireEvent.click(await screen.findByRole("radio", {name:"A. 选项甲"}));
  await waitFor(() => expect(screen.getByRole("button", {name:"交卷并查看结果"})).toBeEnabled());
  expect(onAttemptSaved.mock.calls.every(([attempt]) => !attempt.completed)).toBe(true);
  fireEvent.click(screen.getByRole("button", {name:"交卷并查看结果"}));
  await waitFor(() => expect(onAttemptSaved.mock.calls.filter(([attempt]) => attempt.completed)).toHaveLength(1));
  expect(screen.getByLabelText("本次结果")).toBeVisible();
});

it("restores an embedded completed attempt without importing an unrelated Quiz URL or generating", async () => {
  a.completed=true;
  window.history.replaceState(null,"","/learning/p?view=agent&attempt=unrelated&question=9");
  vi.mocked(learningApi.quizzes).mockResolvedValue({quizzes:[{...run, attemptId:"a"}]});
  const onAttemptSaved=vi.fn();
  render(<LearningQuiz pageId="p" materials={materials} selected={["m"]} disabled={false} saveSelection={save} onSource={vi.fn()} embedded openQuizId="q" onAttemptSaved={onAttemptSaved} />);
  await waitFor(()=>expect(onAttemptSaved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({id:"a",quizId:"q",completed:true})));
  expect(learningApi.quizAttempt).not.toHaveBeenCalledWith("p","unrelated");
  expect(learningApi.startQuiz).not.toHaveBeenCalled();
  expect(learningApi.generateQuiz).not.toHaveBeenCalled();
  expect(window.location.search).toBe("?view=agent&attempt=unrelated&question=9");
});

it("retains an unknown embedded save across refresh and reports completion only after the same receipt succeeds", async () => {
  const onAttemptSaved=vi.fn();
  vi.mocked(learningApi.quizzes).mockResolvedValue({quizzes:[{...run,attemptId:"a"}]});
  vi.mocked(learningApi.quizAction).mockRejectedValueOnce(new LearningApiError(503,"learning_storage_unavailable"));
  const props={pageId:"p",materials,selected:["m"],disabled:false,saveSelection:save,onSource:vi.fn(),embedded:true,openQuizId:"q",onAttemptSaved};
  const first=render(<LearningQuiz {...props}/>);
  fireEvent.click(await screen.findByRole("radio",{name:"A. 选项甲"}));
  await screen.findByText(/这次作答的保存结果尚未确认/);
  const receipt=vi.mocked(learningApi.quizAction).mock.calls[0][1];
  expect(sessionStorage.getItem("learning-quiz-pending:p:embedded:q:action")).not.toBeNull();
  first.unmount();
  a.completed=true;
  render(<LearningQuiz {...props}/>);
  await screen.findByText(/这次作答的保存结果尚未确认/);
  expect(onAttemptSaved.mock.calls.every(([attempt])=>!attempt.completed)).toBe(true);
  vi.mocked(learningApi.quizAction).mockResolvedValueOnce({attempt:structuredClone(a)});
  fireEvent.click(screen.getByRole("button",{name:"核对并重试同一作答操作"}));
  await waitFor(()=>expect(onAttemptSaved.mock.calls.filter(([attempt])=>attempt.completed)).toHaveLength(1));
  expect(vi.mocked(learningApi.quizAction).mock.calls[1][1]).toEqual(receipt);
  expect(sessionStorage.getItem("learning-quiz-pending:p:embedded:q:action")).toBeNull();
});

it("ignores a late completed read when the embedded group changes", async () => {
  const firstAttempt=structuredClone(a);firstAttempt.completed=true;
  const nextAttempt={...structuredClone(a),id:"a-next",quizId:"q-next",title:"新的题组"};
  vi.mocked(learningApi.quizzes).mockResolvedValue({quizzes:[{...run,attemptId:"a"},{...run,id:"q-next",attemptId:"a-next"}]});
  let resolveOld!: (value:{attempt:QuizAttemptView})=>void;
  vi.mocked(learningApi.quizAttempt).mockImplementation(async(_page,id)=>id==="a"?new Promise(resolve=>{resolveOld=resolve;}):{attempt:nextAttempt});
  const onAttemptSaved=vi.fn();
  const props={pageId:"p",materials,selected:["m"],disabled:false,saveSelection:save,onSource:vi.fn(),embedded:true,onAttemptSaved};
  const view=render(<LearningQuiz {...props} openQuizId="q"/>);
  await waitFor(()=>expect(resolveOld).toBeTypeOf("function"));
  view.rerender(<LearningQuiz {...props} openQuizId="q-next"/>);
  await screen.findByText("新的题组");
  await act(async()=>resolveOld({attempt:firstAttempt}));
  expect(onAttemptSaved.mock.calls.every(([attempt])=>attempt.quizId==="q-next")).toBe(true);
  expect(screen.queryByText("合成题组")).not.toBeInTheDocument();
});

it("ignores an old embedded save after switching groups without clearing the new group's unknown receipt", async () => {
  const old=structuredClone(a);old.completed=true;
  const next={...structuredClone(a),id:"a-next",quizId:"q-next",title:"新的题组"};
  vi.mocked(learningApi.quizzes).mockResolvedValue({quizzes:[{...run,attemptId:"a"},{...run,id:"q-next",attemptId:"a-next"}]});
  vi.mocked(learningApi.quizAttempt).mockImplementation(async(_page,id)=>({attempt:structuredClone(id==="a"?a:next)}));
  let resolveOld!: (value:{attempt:QuizAttemptView})=>void;
  vi.mocked(learningApi.quizAction).mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;})).mockRejectedValueOnce(new LearningApiError(503,"learning_storage_unavailable"));
  const onAttemptSaved=vi.fn();
  const props={pageId:"p",materials,selected:["m"],disabled:false,saveSelection:save,onSource:vi.fn(),embedded:true,onAttemptSaved};
  const view=render(<LearningQuiz {...props} openQuizId="q"/>);
  fireEvent.click(await screen.findByRole("radio",{name:"A. 选项甲"}));
  await waitFor(()=>expect(resolveOld).toBeTypeOf("function"));
  view.rerender(<LearningQuiz {...props} openQuizId="q-next"/>);
  fireEvent.click(await screen.findByRole("radio",{name:"A. 选项甲"}));
  await screen.findByText(/这次作答的保存结果尚未确认/);
  await act(async()=>resolveOld({attempt:old}));
  expect(onAttemptSaved.mock.calls.every(([attempt])=>!attempt.completed)).toBe(true);
  expect(sessionStorage.getItem("learning-quiz-pending:p:embedded:q-next:action")).not.toBeNull();
  expect(screen.getByText("新的题组")).toBeVisible();
  expect(screen.getByRole("button",{name:"核对并重试同一作答操作"})).toBeEnabled();
});

function completedReviewAttempt(): QuizAttemptView {
  const question = structuredClone(a.questions[0]);
  const progress = { optionId: "B", submitted: true, skipped: false, hinted: false, revealed: false };
  const feedback = { correct: false, correctOptionId: "A", explanation: "原题解析", reasons: [{ id: "A", reason: "正确依据" }, { id: "B", reason: "错误依据" }], sources: [] };
  return { ...a, completed: true, revision: 3, completedAt: "2026-10-15T01:00:00Z", score: { correct: 0, total: 2, unassistedCorrect: 0, hinted: 0, revealed: 0, skipped: 0 },
    questions: [{ ...question, index: 0, stem: "第一道错题", progress, feedback }, { ...question, index: 1, stem: "第二道错题", progress, feedback }] };
}

it("opens the requested saved wrong question after the embedded group loads and reopens it without writes", async () => {
  a = completedReviewAttempt();
  vi.mocked(learningApi.quizzes).mockResolvedValue({ quizzes: [{ ...run, attemptId: "a", count: 2 }] });
  const props = { pageId: "p", materials, selected: ["m"], disabled: false, saveSelection: save, onSource: vi.fn(), embedded: true, openQuizId: "q" };
  const view = render(<LearningQuiz {...props} openReview={{ index: 1, requestId: "review-one" }} />);
  const review = await screen.findByLabelText("第 2 题回顾");
  await waitFor(() => expect(review).toHaveAttribute("open"));
  expect(screen.getByLabelText("第 1 题回顾")).not.toHaveAttribute("open");
  expect(review.querySelector("summary")).toHaveFocus();
  fireEvent.click(review.querySelector("summary")!); expect(review).not.toHaveAttribute("open");
  view.rerender(<LearningQuiz {...props} openReview={{ index: 1, requestId: "review-two" }} />);
  await waitFor(() => expect(review).toHaveAttribute("open"));
  expect(learningApi.quizAction).not.toHaveBeenCalled(); expect(learningApi.generateQuiz).not.toHaveBeenCalled(); expect(learningApi.startQuiz).not.toHaveBeenCalled();
});

it("applies a wrong-question target only after the newly selected embedded group is restored", async () => {
  const first = completedReviewAttempt(); const next = { ...completedReviewAttempt(), id: "attempt-next", quizId: "quiz-next", title: "另一个题组" };
  vi.mocked(learningApi.quizzes).mockResolvedValue({ quizzes: [{ ...run, attemptId: "a" }, { ...run, id: "quiz-next", attemptId: "attempt-next", title: "另一个题组" }] });
  vi.mocked(learningApi.quizAttempt).mockImplementation(async (_page, id) => ({ attempt: structuredClone(id === "a" ? first : next) }));
  const props = { pageId: "p", materials, selected: ["m"], disabled: false, saveSelection: save, onSource: vi.fn(), embedded: true };
  const view = render(<LearningQuiz {...props} openQuizId="q" openReview={{ index: 0, requestId: "old" }} />);
  await waitFor(() => expect(screen.getByLabelText("第 1 题回顾")).toHaveAttribute("open"));
  view.rerender(<LearningQuiz {...props} openQuizId="quiz-next" openReview={{ index: 1, requestId: "next" }} />);
  await screen.findByRole("heading", { name: "另一个题组" });
  await waitFor(() => expect(screen.getByLabelText("第 2 题回顾")).toHaveAttribute("open"));
  expect(screen.getByLabelText("第 1 题回顾")).not.toHaveAttribute("open");
  expect(learningApi.quizAction).not.toHaveBeenCalled(); expect(learningApi.generateQuiz).not.toHaveBeenCalled();
});

it("can review an already submitted wrong answer in an unfinished attempt without submitting remaining questions", async () => {
  const saved = completedReviewAttempt();
  a = { ...saved, completed: false, score: null, completedAt: null, questions: [saved.questions[0], { ...saved.questions[1], feedback: undefined, progress: { optionId: null, submitted: false, skipped: false, hinted: false, revealed: false } }] };
  vi.mocked(learningApi.quizzes).mockResolvedValue({ quizzes: [{ ...run, attemptId: "a", count: 2 }] });
  render(<LearningQuiz pageId="p" materials={materials} selected={["m"]} disabled={false} saveSelection={save} onSource={vi.fn()} embedded openQuizId="q" openReview={{ index: 0, requestId: "review-partial" }} />);
  await screen.findByText("第一道错题");
  expect(screen.getByText("原题解析")).toBeVisible(); expect(screen.getByText("第 1/2 题 · 已选择 1 题")).toBeVisible();
  expect(screen.getByRole("radio", { name: "A. 选项甲" })).toBeDisabled();
  expect(learningApi.quizAction).not.toHaveBeenCalled(); expect(learningApi.generateQuiz).not.toHaveBeenCalled(); expect(learningApi.startQuiz).not.toHaveBeenCalled();
});
