import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ThinkingMattersApi } from "@/lib/client/reflection-thinking-matters-api";
import type { DailyReflectionApi } from "@/lib/client/daily-reflection-api";
import { ThinkingMatterViewSchema, type ThinkingMatterView } from "@/lib/domain/reflection-thinking-matter";

import { ReflectionThinkingMatters } from "./reflection-thinking-matters";

const timestamp = "2026-11-02T08:00:00.000Z";
function saved(): ThinkingMatterView {
  return ThinkingMatterViewSchema.parse({
    matter: {
      id: "matter_1", accountId: "account_1", question: "我总是修改作品计划，一直没有开始。", goal: "开始一个能展示的作品",
      mode: "brainstorm", contextMode: "none", status: "active", version: 2,
      understanding: "范围太大，让开始变得困难。", judgments: ["范围可能不是唯一阻力。"],
      suggestions: [{ id: "suggestion_1", text: "先做一个最小页面，看看真正卡在哪里。", kind: "action", status: "proposed", createdAt: timestamp, sourceEventId: "event_2" }],
      arrangements: [], activeGeneration: null, createdAt: timestamp, updatedAt: timestamp,
    },
    events: [
      { id: "event_1", matterId: "matter_1", ordinal: 0, kind: "user_message", text: "主要是功能范围太大，不知道删什么。", data: {}, sources: [], matterVersion: 1, createdAt: timestamp },
      { id: "event_2", matterId: "matter_1", ordinal: 1, kind: "assistant_message", text: "可以先用一个最小页面试试。", data: {}, sources: [], matterVersion: 2, createdAt: timestamp },
    ],
  });
}

function client(initial: ThinkingMatterView | null = saved()) {
  let state = initial;
  const api: ThinkingMattersApi = {
    list: vi.fn(async () => state ? [state.matter] : []),
    get: vi.fn(async () => structuredClone(state!)),
    create: vi.fn(async input => {
      state = saved();
      state.matter.question = input.question;
      state.matter.contextMode = input.contextMode ?? "none";
      state.matter.suggestions = [];
      if (input.sourceCardId) state.matter.linkedSources = [{ sourceId: input.sourceCardId, version: "canonical_version", kind: "card", sourceEventId: "linked_event" }];
      state.events = [];
      return structuredClone(state);
    }),
    turn: vi.fn(async (_id, input) => {
      if (!state) throw new Error("missing matter");
      state = structuredClone(state);
      state.matter.version++;
      state.matter.contextMode = input.contextMode ?? "none";
      state.events.push({ id: `event_${state.events.length + 3}`, matterId: state.matter.id, ordinal: state.events.length, kind: input.feedback ? "feedback" : "user_message", text: input.text, data: {}, sources: [], matterVersion: state.matter.version, createdAt: timestamp });
      state.events.push({ id: `assistant_${state.events.length + 3}`, matterId: state.matter.id, ordinal: state.events.length, kind: "assistant_message", text: "那我们讨论页面展示的内容。", data: {}, sources: [], matterVersion: state.matter.version, createdAt: timestamp });
      return structuredClone(state);
    }),
    mutate: vi.fn<ThinkingMattersApi["mutate"]>(async (_id, input) => {
      state = structuredClone(state!);
      state.matter.version++;
      if (input.kind === "adopt") {
        const suggestion = state.matter.suggestions.find(item => item.id === input.suggestionId)!;
        suggestion.status = "adopted";
        state.matter.arrangements.push({ id: "arrangement_1", suggestionId: suggestion.id, text: suggestion.text, kind: suggestion.kind, status: "adopted", adoptedAt: timestamp, updatedAt: timestamp, version: 0 });
      }
      if (input.kind === "reject") state.matter.suggestions.find(item => item.id === input.suggestionId)!.status = "rejected";
      if (input.kind === "status") state.matter.status = input.status;
      if (input.kind === "edit") {
        state.matter.goal = input.goal ?? state.matter.goal;
        state.matter.contextMode = input.contextMode ?? state.matter.contextMode;
      }
      if (input.kind === "comparison") {
        state.matter.comparison = { ...input.comparison, sourceEventId: "comparison_event", options: input.comparison.options.map((option, index) => ({ ...option, id: option.id ?? `option_new_${index}`, sourceEventId: "comparison_event" })), recommendation: input.comparison.recommendation ? { ...input.comparison.recommendation, sourceEventId: "comparison_event" } : null };
      }
      if (input.kind === "choice") {
        const previousChoice = state.matter.userChoice;
        state.matter.userChoice = { status: input.status, optionId: input.optionId ?? null, reason: input.reason, rejectedIds: input.rejectedIds ?? [], sourceEventId: `choice_${state.matter.version}` };
        state.events.push({ id: `choice_${state.matter.version}`, matterId: state.matter.id, ordinal: state.events.length, kind: "choice_changed", text: `用户更新取舍：${input.status}`, data: { previousChoice, choice: state.matter.userChoice, reason: input.reason }, sources: [], matterVersion: state.matter.version, createdAt: timestamp });
      }
      if (input.kind === "correct") { state.matter.understanding = input.understanding; state.matter.judgments = []; }
      if (input.kind === "cancel") state.matter.activeGeneration = null;
      return structuredClone(state);
    }),
    recover: vi.fn(async () => structuredClone(state!)),
    linkCard: vi.fn(async (_id, input) => { state = structuredClone(state!); state.matter.version++; state.matter.linkedSources.push({ sourceId: input.cardId, version: "canonical_version", kind: "card", sourceEventId: "linked_event" }); return state; }),
    unlinkCard: vi.fn(async (_id, input) => { state = structuredClone(state!); state.matter.version++; state.matter.linkedSources = state.matter.linkedSources.filter(source => source.sourceId !== input.cardId); return state; }),
  };
  return api;
}

async function openProgress() {
  const trigger = await screen.findByRole("button", { name: "进展与资料" });
  fireEvent.click(trigger);
  return screen.getByRole("dialog", { name: "进展与资料" });
}
function closeProgress() { fireEvent.click(within(screen.getByRole("dialog", { name: "进展与资料" })).getByRole("button", { name: "关闭" })); }
async function openMore() { await screen.findByRole("button", { name: "进展与资料" }); fireEvent.click(screen.getByText("更多", { selector: "summary" })); }

describe("Together-thinking saved matters", () => {
  beforeEach(() => { window.history.replaceState({}, "", "/reflection/think"); });

  it("starts a real discussion from one question with history permission off and no automatic adoption", async () => {
    const api = client(null);
    render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    await waitFor(() => expect(api.list).toHaveBeenCalledOnce());
    fireEvent.change(await screen.findByLabelText("你正在想什么"), { target: { value: "我总是修改作品计划，一直没有开始。" } });
    fireEvent.click(screen.getByRole("button", { name: "开始一起想" }));
    await within(screen.getByRole("log", { name: "这件事的对话" })).findByText("那我们讨论页面展示的内容。");
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ question: "我总是修改作品计划，一直没有开始。", contextMode: "none" }), expect.any(AbortSignal));
    expect(api.turn).toHaveBeenCalledWith("matter_1", expect.objectContaining({ text: "我总是修改作品计划，一直没有开始。", contextMode: "none" }), expect.any(AbortSignal));
    expect(vi.mocked(api.turn).mock.calls[0][1]).not.toHaveProperty("feedback");
    expect(api.mutate).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?matter=matter_1");
  });

  it("distinguishes a suggestion from adoption and keeps an adopted action unexecuted", async () => {
    const api = client();
    render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    await screen.findByRole("button", { name: "采纳这一步" });
    expect(screen.queryByRole("region", { name: "已采纳的安排" })).not.toBeInTheDocument();
    expect(api.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "采纳这一步" }));
    await openProgress();
    expect(await screen.findByText("已采纳 · 尚未执行")).toBeVisible();
    expect(api.mutate).toHaveBeenCalledOnce();
    expect(api.mutate).toHaveBeenCalledWith("matter_1", expect.objectContaining({ kind: "adopt", suggestionId: "suggestion_1", expectedVersion: 2 }));
    expect(screen.queryByText("用户确认已完成")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "采纳这一步" })).not.toBeInTheDocument();
  });

  it("reuses the creation receipt key after a disconnected response instead of creating a duplicate matter", async () => {
    const api = client(null);
    vi.mocked(api.create).mockRejectedValueOnce(new Error("连接中断，结果尚未确认。"));
    render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    const input = await screen.findByLabelText("你正在想什么");
    await waitFor(() => expect(screen.getByRole("button", { name: "新建一件事" })).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "我一直改计划。" } });
    fireEvent.click(screen.getByRole("button", { name: "开始一起想" }));
    await screen.findByText("连接中断，结果尚未确认。");
    expect(api.create).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "开始一起想" }));
    await within(screen.getByRole("log", { name: "这件事的对话" })).findByText("那我们讨论页面展示的内容。");
    const calls = vi.mocked(api.create).mock.calls;
    expect(calls[1][0].operationKey).toBe(calls[0][0].operationKey);
    expect(api.turn).toHaveBeenCalledOnce();
  });

  it("records rejection without creating an arrangement", async () => {
    const api = client();
    render(<ReflectionThinkingMatters api={api} mode="compare_directions" />);
    fireEvent.click(await screen.findByRole("button", { name: "不采纳" }));
    await screen.findByText("已记下不采纳，原建议保留在历史里。");
    expect(screen.queryByRole("region", { name: "已采纳的安排" })).not.toBeInTheDocument();
    expect(api.mutate).toHaveBeenCalledWith("matter_1", expect.objectContaining({ kind: "reject", suggestionId: "suggestion_1" }));
  });

  it("reopens the saved matter and submits actual feedback through the discussion API", async () => {
    const initial = saved();
    initial.matter.suggestions[0].status = "adopted";
    initial.matter.arrangements.push({ id: "arrangement_1", suggestionId: "suggestion_1", text: "先做一个最小页面，看看真正卡在哪里。", kind: "action", status: "adopted", adoptedAt: timestamp, updatedAt: timestamp, version: 0 });
    window.history.replaceState({}, "", "/reflection/think?matter=matter_1");
    const api = client(initial);
    const first = render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    await openProgress();
    await screen.findByText("已采纳 · 尚未执行");
    first.unmount();
    render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    fireEvent.click(await screen.findByRole("button", { name: "反馈实际情况" }));
    fireEvent.change(screen.getByLabelText("反馈实际情况"), { target: { value: "我试过了，技术其实没问题，主要是不知道展示什么内容。" } });
    fireEvent.click(screen.getByRole("button", { name: "提交反馈并继续想" }));
    await within(screen.getByRole("log", { name: "这件事的对话" })).findByText("那我们讨论页面展示的内容。");
    expect(api.turn).toHaveBeenCalledWith("matter_1", expect.objectContaining({ feedback: true, text: "我试过了，技术其实没问题，主要是不知道展示什么内容。" }), expect.any(AbortSignal));
    expect(within(screen.getByRole("log", { name: "这件事的对话" })).getByText("主要是功能范围太大，不知道删什么。")).toBeVisible();
  });

  it("allows discussion without plans and uses history only after explicit permission", async () => {
    const api = client(null);
    render(<ReflectionThinkingMatters api={api} mode="compare_directions" />);
    const input = await screen.findByLabelText("你正在想什么");
    await waitFor(() => expect(screen.getByRole("button", { name: "新建一件事" })).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "帮我比较两个方向，但今天不要安排计划。" } });
    await openProgress();
    fireEvent.click(screen.getByLabelText("允许按需参考我的日常卡片和记忆"));
    closeProgress();
    fireEvent.click(screen.getByRole("button", { name: "开始一起想" }));
    await within(screen.getByRole("log", { name: "这件事的对话" })).findByText("那我们讨论页面展示的内容。");
    expect(api.turn).toHaveBeenCalledWith("matter_1", expect.objectContaining({ mode: "compare_directions", contextMode: "personal" }), expect.any(AbortSignal));
    expect(api.mutate).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "采纳这一步" })).not.toBeInTheDocument();
  });

  it("pauses and resumes without calling the model or displaying completion", async () => {
    const api = client();
    render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    await openMore();
    fireEvent.click(await screen.findByRole("button", { name: "先暂停这件事" }));
    expect(await screen.findByText("暂时放下")).toBeVisible();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    expect(api.turn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "继续这件事" }));
    await screen.findByText("继续思考中");
    expect(screen.queryByText("已解决")).not.toBeInTheDocument();
    expect(api.mutate).toHaveBeenLastCalledWith("matter_1", expect.objectContaining({ kind: "status", status: "active" }));
  });

  it("persists revoked history permission immediately and keeps it revoked after reopening", async () => {
    const initial = saved();
    initial.matter.contextMode = "personal";
    const api = client(initial);
    const first = render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    await openProgress();
    const permission = await screen.findByLabelText("允许按需参考我的日常卡片和记忆");
    await waitFor(() => expect(permission).toBeChecked());
    fireEvent.click(permission);
    await screen.findByText("已保存资料使用选择。");
    expect(api.mutate).toHaveBeenCalledWith("matter_1", expect.objectContaining({ kind: "edit", contextMode: "none", expectedVersion: 2 }));
    expect(api.turn).not.toHaveBeenCalled();
    first.unmount();
    render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    await openProgress();
    expect(screen.getByLabelText("允许按需参考我的日常卡片和记忆")).not.toBeChecked();
    expect(api.turn).not.toHaveBeenCalled();
  });

  it("saves a user correction with the current version", async () => {
    const api = client();
    render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    await openProgress();
    fireEvent.click(await screen.findByRole("button", { name: "修改目标" }));
    fireEvent.change(screen.getByLabelText("当前目标"), { target: { value: "先确认展示什么内容" } });
    fireEvent.click(screen.getByRole("button", { name: "保存目标" }));
    await screen.findByText("你希望：先确认展示什么内容");
    expect(api.mutate).toHaveBeenCalledWith("matter_1", expect.objectContaining({ kind: "edit", expectedVersion: 2, goal: "先确认展示什么内容" }));
    expect(api.turn).not.toHaveBeenCalled();
  });

  it("links available card and memory evidence without displaying database identifiers", async () => {
    const initial = saved();
    initial.events[1].sources = [
      { sourceId: "private_card_123", kind: "card", version: "version_1" },
      { sourceId: "private_memory_456", kind: "memory", version: "version_2" },
    ];
    const api = client(initial);
    render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    await openProgress();
    expect(await screen.findByRole("link", { name: "日常卡片 1" })).toHaveAttribute("href", "/reflection/cards/private_card_123");
    expect(screen.getByRole("link", { name: "日常记忆 1" })).toHaveAttribute("href", "/reflection/memory/private_memory_456");
    const log = screen.getByRole("log", { name: "这件事的对话" });
    expect(log).not.toHaveTextContent("private_card_123");
    expect(log).not.toHaveTextContent("private_memory_456");
    // A re-read after revocation returns the redacted business projection.
    const withdrawn = saved();
    vi.mocked(api.get).mockResolvedValueOnce(withdrawn);
    fireEvent.change(screen.getByRole("combobox", { name: "选择正在想的事" }), { target: { value: "matter_1" } });
    await waitFor(() => expect(screen.queryByRole("link", { name: "日常卡片 1" })).not.toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "日常记忆 1" })).not.toBeInTheDocument();
  });

  it("does not automatically resend an unknown reply and can cancel it", async () => {
    const initial = saved();
    initial.matter.activeGeneration = { id: "generation_1", version: 2, taskId: "task_1", status: "unknown" };
    const api = client(initial);
    render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    await screen.findByText("这次回复的结果尚未确认");
    expect(api.turn).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "取消本次回复" }));
    await screen.findByText("本次回复已取消，已保存的讨论仍然保留。");
    expect(api.mutate).toHaveBeenCalledWith("matter_1", expect.objectContaining({ kind: "cancel", generationId: "generation_1", expectedVersion: 2 }));
    expect(api.turn).not.toHaveBeenCalled();
  });

  it("shows a known failure from its saved event even after the active generation is cleared", async () => {
    const initial = saved();
    initial.matter.activeGeneration = null;
    initial.events.push({ id: "failure_1", matterId: "matter_1", ordinal: 2, kind: "generation_failed", text: "本轮回复未完成，用户输入已保存。", data: { status: "known_failed" }, sources: [], matterVersion: 3, createdAt: timestamp });
    const api = client(initial);
    render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    expect(await screen.findByText("这次回复未完成")).toBeVisible();
    expect(screen.getByText("原问题和反馈已保留，你可以补充问题继续讨论；不会自动重新发送。")).toBeVisible();
    expect(api.turn).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("继续一起想"), { target: { value: "补充一点新的情况。" } });
    expect(screen.getByRole("button", { name: "发送" })).not.toBeDisabled();
    expect(api.turn).not.toHaveBeenCalled();
  });

  it("retains an error without retrying a request whose save result is unknown", async () => {
    const api = client();
    vi.mocked(api.mutate).mockRejectedValueOnce(new Error("连接中断，保存结果尚未确认。"));
    render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    fireEvent.click(await screen.findByRole("button", { name: "采纳这一步" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("连接中断，保存结果尚未确认。")).toBeVisible();
    expect(api.mutate).toHaveBeenCalledOnce();
    fireEvent.click(within(alert).getByRole("button", { name: "重新读取进展" }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(api.mutate).toHaveBeenCalledOnce();
  });

  it("inspects an unknown result without sending another discussion or hiding its uncertainty", async () => {
    const initial = saved();
    initial.matter.activeGeneration = { id: "generation_1", version: 2, taskId: "task_1", status: "unknown" };
    const api = client(initial);
    render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    fireEvent.click(await screen.findByRole("button", { name: "核对本轮结果" }));
    await screen.findByText("尚未找到已完成的回复，结果仍未确认；没有重新发起回复。");
    expect(api.recover).toHaveBeenCalledOnce();
    expect(api.recover).toHaveBeenCalledWith("matter_1", { operationKey: expect.any(String) });
    expect(api.turn).not.toHaveBeenCalled();
    expect(screen.getByText("这次回复的结果尚未确认")).toBeVisible();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  it("shows a recovered saved response and never regenerates it", async () => {
    const initial = saved();
    initial.matter.activeGeneration = { id: "generation_1", version: 2, taskId: "task_1", status: "unknown" };
    const api = client(initial);
    const recovered = saved();
    recovered.events[1].text = "已经保存的原回复。";
    vi.mocked(api.recover).mockResolvedValueOnce(recovered);
    render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    fireEvent.click(await screen.findByRole("button", { name: "核对本轮结果" }));
    await within(screen.getByRole("log", { name: "这件事的对话" })).findByText("已经保存的原回复。");
    expect(screen.queryByText("这次回复的结果尚未确认")).not.toBeInTheDocument();
    expect(api.turn).not.toHaveBeenCalled();
    expect(api.recover).toHaveBeenCalledOnce();
  });

  it("ignores a reply arriving after cancellation", async () => {
    const api = client();
    let finish!: (view: ThinkingMatterView) => void;
    vi.mocked(api.turn).mockImplementationOnce(async () => new Promise<ThinkingMatterView>(resolve => { finish = resolve; }));
    render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    fireEvent.change(await screen.findByLabelText("继续一起想"), { target: { value: "继续讨论" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => expect(api.turn).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "取消本次回复" }));
    await screen.findByText("本次回复已取消，已保存的讨论仍然保留。");
    const late = saved();
    late.matter.understanding = "这条晚到结果不应覆盖用户进展";
    await act(async () => { finish(late); });
    expect(screen.queryByText("这条晚到结果不应覆盖用户进展")).not.toBeInTheDocument();
  });
});

function compared(): ThinkingMatterView {
  const view = saved();
  view.matter.comparison = {
    question: "先快速展示，还是完整讲述作品过程？", dimensions: ["准备时间", "表达深度"], sourceEventId: "event_2",
    options: [
      { id: "option_a", name: "方案A", content: "快速发布作品概览", reasons: ["先获得反馈"], limits: ["过程表达较少"], costs: ["半天"], unknowns: ["观众是否看得明白"], sourceEventId: "event_2" },
      { id: "option_b", name: "方案B", content: "完整讲述作品过程", reasons: ["展示判断过程"], limits: ["需要素材"], costs: ["两天"], unknowns: ["讲述长度"], sourceEventId: "event_2" },
    ], recommendation: { optionId: "option_a", text: "可以先用概览得到反馈。", sourceEventId: "event_2" },
  };
  return view;
}

function cardApi(sourceUnavailable = false): Pick<DailyReflectionApi, "getWorkingCard"> {
  return { getWorkingCard: vi.fn<DailyReflectionApi["getWorkingCard"]>(async () => ({ card: {
    id: "card_1", title: sourceUnavailable ? "不可用卡片的旧标题" : "作品方向的记录", content: "卡片原文不会自动进入问题草稿",
    cardKind: "question", evidenceIds: ["segment_1"], sourceReflectionIds: ["reflection_1"],
    status: "saved", sourceUnavailable, importance: 0.7, novelty: 0.6, relatedCardIds: [], tags: [], visibility: "private",
    memoryLifecycleStatus: "not_admitted", memoryLifecycleVersion: 0, memoryLifecycleUpdatedAt: null,
    version: 3, createdAt: timestamp, updatedAt: timestamp, evidence: [],
  } })) };
}

describe("Together-thinking P2 choices and matters", () => {
  beforeEach(() => { window.history.replaceState({}, "", "/reflection/think"); });

  it("requires an explicit matter when several exist and displays recent status and update time", async () => {
    const first = saved(), second = saved();
    second.matter.id = "matter_2"; second.matter.question = "周末如何休息"; second.matter.status = "paused";
    const api = client(first);
    vi.mocked(api.list).mockResolvedValue([first.matter, second.matter]);
    vi.mocked(api.get).mockImplementation(async id => structuredClone(id === "matter_2" ? second : first));
    render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    await screen.findByText("选择要继续的事，或新建一件事");
    expect(api.get).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("继续一起想")).not.toBeInTheDocument();
    await openProgress();
    const recent = screen.getByRole("region", { name: "最近在想的事" });
    expect(recent).toHaveTextContent("暂时放下");
    expect(recent).toHaveTextContent("更新于");
    fireEvent.click(within(recent).getByRole("button", { name: "周末如何休息" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "选择正在想的事" })).toHaveValue("matter_2"));
    expect(api.get).toHaveBeenCalledWith("matter_2");
    expect(api.turn).not.toHaveBeenCalled();
  });

  it("archives and reopens without changing earlier discussions or completing arrangements", async () => {
    const view = saved();
    view.matter.arrangements.push({ id: "arrangement_1", suggestionId: "suggestion_1", text: "先做最小页面", kind: "action", status: "adopted", adoptedAt: timestamp, updatedAt: timestamp, version: 0 });
    const api = client(view);
    render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    await openMore();
    fireEvent.click(await screen.findByRole("button", { name: "归档这件事" }));
    await screen.findByRole("button", { name: "重新打开这件事" });
    expect(screen.getByLabelText("继续一起想")).toBeDisabled();
    await openProgress();
    expect(screen.getByText("已采纳 · 尚未执行")).toBeVisible();
    closeProgress();
    fireEvent.click(screen.getByRole("button", { name: "重新打开这件事" }));
    await waitFor(() => expect(screen.getByLabelText("继续一起想")).not.toBeDisabled());
    expect(api.mutate).toHaveBeenNthCalledWith(1, "matter_1", expect.objectContaining({ kind: "status", status: "archived" }));
    expect(api.mutate).toHaveBeenNthCalledWith(2, "matter_1", expect.objectContaining({ kind: "status", status: "active" }));
    expect(within(screen.getByRole("log", { name: "这件事的对话" })).getByText("可以先用一个最小页面试试。")).toBeVisible();
    expect(api.turn).not.toHaveBeenCalled();
  });

  it("keeps assistant recommendation separate from user choices and records a changed choice with reasons", async () => {
    const api = client(compared());
    render(<ReflectionThinkingMatters api={api} mode="compare_directions" />);
    await openProgress();
    const comparison = await screen.findByRole("region", { name: "方案比较" });
    expect(comparison).toHaveTextContent("助手的建议：方案A");
    expect(comparison).toHaveTextContent("你的选择：暂不决定");
    expect(api.mutate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("取舍原因（可不填）"), { target: { value: "先快速得到反馈" } });
    fireEvent.click(screen.getByRole("button", { name: "选择：方案A" }));
    await screen.findByText("你的选择：已选择方案A；原因：先快速得到反馈");
    fireEvent.change(screen.getByLabelText("取舍原因（可不填）"), { target: { value: "新的展示要求需要判断过程" } });
    fireEvent.click(screen.getByRole("button", { name: "选择：方案B" }));
    await screen.findByText("你的选择：已选择方案B；原因：新的展示要求需要判断过程");
    expect(api.mutate).toHaveBeenLastCalledWith("matter_1", expect.objectContaining({ kind: "choice", optionId: "option_b", status: "selected", reason: "新的展示要求需要判断过程" }));
    fireEvent.click(screen.getByText("查看取舍变化记录"));
    expect(screen.getByText("选择方案A → 选择方案B")).toBeVisible();
    expect(screen.getByText("原因：先快速得到反馈")).toBeVisible();
    expect(api.turn).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "已采纳的安排" })).not.toBeInTheDocument();
  });

  it("edits option names and dynamic comparison points while preserving stable option identifiers", async () => {
    const api = client(compared());
    render(<ReflectionThinkingMatters api={api} mode="compare_directions" />);
    await openProgress();
    fireEvent.click(await screen.findByRole("button", { name: "编辑方案比较" }));
    fireEvent.change(screen.getByLabelText("方案 1 名称"), { target: { value: "先发布概览" } });
    fireEvent.change(screen.getByLabelText("比较关注点（每行一个）"), { target: { value: "观众能理解什么\n维护负担\n可逆程度" } });
    fireEvent.click(screen.getByRole("button", { name: "保存方案比较" }));
    await screen.findByRole("heading", { name: "先发布概览" });
    const call = vi.mocked(api.mutate).mock.calls[0][1];
    expect(call.kind).toBe("comparison");
    if (call.kind !== "comparison") throw new Error("comparison required");
    expect(call.comparison.options.map(option => option.id)).toEqual(["option_a", "option_b"]);
    expect(call.comparison.dimensions).toEqual(["观众能理解什么", "维护负担", "可逆程度"]);
    expect(call.comparison.options[0]).not.toHaveProperty("sourceEventId");
    expect(screen.getByText("你的选择：暂不决定")).toBeVisible();
    expect(api.turn).not.toHaveBeenCalled();
  });

  it("records leaning, rejection and remaining undecided as different explicit choices", async () => {
    const api = client(compared());
    render(<ReflectionThinkingMatters api={api} mode="compare_directions" />);
    await openProgress();
    fireEvent.click(await screen.findByRole("button", { name: "倾向：方案A" }));
    await screen.findByText("你的选择：更倾向方案A");
    fireEvent.click(screen.getByRole("button", { name: "暂不考虑：方案A" }));
    await waitFor(() => expect(screen.getByText("暂不考虑：方案A", { selector: "p" })).toBeVisible());
    expect(api.mutate).toHaveBeenLastCalledWith("matter_1", expect.objectContaining({ kind: "choice", status: "undecided", optionId: null, rejectedIds: ["option_a"] }));
    fireEvent.click(screen.getByRole("button", { name: "暂不决定" }));
    await waitFor(() => expect(api.mutate).toHaveBeenCalledTimes(3));
    expect(api.turn).not.toHaveBeenCalled();
  });

  it("persists a direct correction and clears unconfirmed old judgments without a model call", async () => {
    const api = client();
    render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    await openProgress();
    fireEvent.click(await screen.findByRole("button", { name: "纠正当前理解" }));
    fireEvent.change(screen.getByLabelText("更正后的理解"), { target: { value: "我并不是害怕开始，只是还没定展示对象。" } });
    fireEvent.change(screen.getByLabelText("更正说明（可不填）"), { target: { value: "技术部分已经试过" } });
    fireEvent.click(screen.getByRole("button", { name: "保存更正" }));
    await screen.findByText("我并不是害怕开始，只是还没定展示对象。");
    expect(api.mutate).toHaveBeenCalledWith("matter_1", expect.objectContaining({ kind: "correct", reason: "技术部分已经试过" }));
    expect(screen.queryByText("范围可能不是唯一阻力。")).not.toBeInTheDocument();
    expect(api.turn).not.toHaveBeenCalled();
  });

  it("starts from a canonical card only after choosing a new matter and granting that card permission", async () => {
    window.history.replaceState({}, "", "/reflection/think?card=card_1&title=伪造标题");
    const api = client();
    const cards = cardApi();
    render(<ReflectionThinkingMatters api={api} cardApi={cards} mode="compare_directions" />);
    await screen.findByText("作品方向的记录");
    expect(api.get).not.toHaveBeenCalled();
    expect(screen.queryByText("伪造标题")).not.toBeInTheDocument();
    expect(screen.getByLabelText("允许这件事使用这张卡片")).not.toBeChecked();
    fireEvent.click(screen.getByLabelText("允许这件事使用这张卡片"));
    fireEvent.click(screen.getByRole("button", { name: "在新事项中一起想" }));
    expect(screen.queryByRole("dialog", { name: "进展与资料" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("你正在想什么")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("你正在想什么"), { target: { value: "只讨论这两个方向，不安排计划。" } });
    fireEvent.click(screen.getByRole("button", { name: "开始一起想" }));
    await within(screen.getByRole("log", { name: "这件事的对话" })).findByText("那我们讨论页面展示的内容。");
    expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ sourceCardId: "card_1", sourceCardVersion: 3, contextMode: "none", question: "只讨论这两个方向，不安排计划。" }), expect.any(AbortSignal));
    expect(api.linkCard).not.toHaveBeenCalled();
    await openProgress();
    expect(screen.getByRole("region", { name: "明确关联的卡片" })).toBeVisible();
    expect(new URL(window.location.href).searchParams.has("card")).toBe(false);
  });

  it("requires explicit selection and authorization to link an existing matter, and can unlink with no model call", async () => {
    window.history.replaceState({}, "", "/reflection/think?card=card_1");
    const api = client();
    render(<ReflectionThinkingMatters api={api} cardApi={cardApi()} mode="brainstorm" />);
    await screen.findByText("作品方向的记录");
    fireEvent.change(screen.getByLabelText("选择正在想的事"), { target: { value: "matter_1" } });
    await screen.findByLabelText("继续一起想");
    await openProgress();
    const link = await screen.findByRole("button", { name: "关联到这件事" });
    expect(link).toBeDisabled();
    fireEvent.click(screen.getByLabelText("允许这件事使用这张卡片"));
    fireEvent.click(link);
    await screen.findByText("已把这张卡片关联到当前事项，其他资料仍按你的许可使用。");
    await openProgress();
    await screen.findByRole("button", { name: "取消关联卡片 1" });
    expect(api.linkCard).toHaveBeenCalledWith("matter_1", expect.objectContaining({ cardId: "card_1", cardVersion: 3, expectedVersion: 2 }));
    fireEvent.click(screen.getByRole("button", { name: "取消关联卡片 1" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "明确关联的卡片" })).not.toBeInTheDocument());
    expect(api.unlinkCard).toHaveBeenCalledWith("matter_1", expect.objectContaining({ cardId: "card_1" }));
    expect(api.turn).not.toHaveBeenCalled();
  });

  it("does not display or reuse a revoked card excerpt", async () => {
    window.history.replaceState({}, "", "/reflection/think?card=card_1");
    const api = client(null);
    render(<ReflectionThinkingMatters api={api} cardApi={cardApi(true)} mode="brainstorm" />);
    await screen.findByText("这张卡片或原始来源目前不可用，不会使用旧摘录。");
    expect(screen.queryByText("不可用卡片的旧标题")).not.toBeInTheDocument();
    expect(screen.queryByText("卡片原文不会自动进入问题草稿")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("允许这件事使用这张卡片")).not.toBeInTheDocument();
    expect(api.create).not.toHaveBeenCalled();
    expect(api.turn).not.toHaveBeenCalled();
  });
});

describe("Together-thinking P3 recovery and source visibility", () => {
  beforeEach(() => { window.history.replaceState({}, "", "/reflection/think"); });

  it("keeps unsent feedback and an edit draft when a conflict is reread, without overwriting the newer version", async () => {
    const api = client();
    const latest = saved(); latest.matter.version = 8; latest.matter.goal = "其他页面更新后的目标";
    vi.mocked(api.get).mockResolvedValueOnce(saved()).mockResolvedValueOnce(latest);
    vi.mocked(api.mutate).mockRejectedValueOnce(new Error("进展已经变化，请重新读取后继续。"));
    render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    await openProgress();
    fireEvent.change(await screen.findByLabelText("继续一起想"), { target: { value: "这句尚未发送" } });
    fireEvent.click(screen.getByRole("button", { name: "修改目标" }));
    fireEvent.change(screen.getByLabelText("当前目标"), { target: { value: "当前页面未保存的目标" } });
    fireEvent.click(screen.getByRole("button", { name: "保存目标" }));
    fireEvent.click(await screen.findByRole("button", { name: "重新读取进展" }));
    await openProgress();
    await screen.findByText("你希望：其他页面更新后的目标");
    expect(screen.getByLabelText("继续一起想")).toHaveValue("这句尚未发送");
    expect(screen.getByLabelText("当前目标")).toHaveValue("当前页面未保存的目标");
    expect(screen.getByRole("button", { name: "保存目标" })).toBeDisabled();
    expect(api.mutate).toHaveBeenCalledOnce(); expect(api.turn).not.toHaveBeenCalled();
  });

  it("does not silently rebase an old comparison editor onto a refreshed version", async () => {
    const api = client(compared());
    const latest = compared(); latest.matter.version = 9; latest.matter.comparison!.options[0].name = "其他页面已改名";
    vi.mocked(api.get).mockResolvedValueOnce(compared()).mockResolvedValueOnce(latest);
    vi.mocked(api.mutate).mockRejectedValueOnce(new Error("比较版本冲突，请重新读取。"));
    render(<ReflectionThinkingMatters api={api} mode="compare_directions" />);
    await openProgress();
    fireEvent.click(await screen.findByRole("button", { name: "编辑方案比较" }));
    fireEvent.change(screen.getByLabelText("方案 1 名称"), { target: { value: "尚未保存的方案草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "保存方案比较" }));
    fireEvent.click(await screen.findByRole("button", { name: "重新读取进展" }));
    await openProgress();
    await screen.findByRole("heading", { name: "其他页面已改名" });
    expect(screen.getByLabelText("方案 1 名称")).toHaveValue("尚未保存的方案草稿");
    expect(screen.getByRole("button", { name: "保存方案比较" })).toBeDisabled();
    expect(screen.getByText("比较已更新，当前草稿已保留。请取消编辑，再核对最新方案。")).toBeVisible();
    expect(api.mutate).toHaveBeenCalledOnce();
  });

  it("ignores an older matter read that arrives after a newer selection", async () => {
    const first = saved(), second = saved(); second.matter.id = "matter_2"; second.matter.question = "第二件独立的事";
    const api = client(); vi.mocked(api.list).mockResolvedValue([first.matter, second.matter]);
    const finish = new Map<string, (view: ThinkingMatterView) => void>();
    vi.mocked(api.get).mockImplementation(id => new Promise(resolve => { finish.set(id, resolve); }));
    render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    await screen.findByText("选择要继续的事，或新建一件事");
    const select = screen.getByLabelText("选择正在想的事");
    act(() => { fireEvent.change(select, { target: { value: "matter_1" } }); fireEvent.change(select, { target: { value: "matter_2" } }); });
    expect(api.get).toHaveBeenCalledTimes(2);
    await act(async () => finish.get("matter_2")!(second));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "选择正在想的事" })).toHaveValue("matter_2"));
    await act(async () => finish.get("matter_1")!(first));
    expect(screen.getByRole("combobox", { name: "选择正在想的事" })).toHaveValue("matter_2");
    expect(new URL(window.location.href).searchParams.get("matter")).toBe("matter_2");
    expect(api.turn).not.toHaveBeenCalled();
  });

  it("surfaces the latest feedback independently of the long conversation", async () => {
    const view = saved();
    view.events.push({ id: "feedback_old_window", matterId: "matter_1", ordinal: 2, kind: "feedback", text: "实际卡住的是展示内容，不是技术。", data: {}, sources: [], matterVersion: 2, createdAt: timestamp });
    for (let index = 0; index < 20; index++) view.events.push({ id: `later_${index}`, matterId: "matter_1", ordinal: index + 3, kind: "user_message", text: `后续讨论 ${index}`, data: {}, sources: [], matterVersion: 2, createdAt: timestamp });
    const api = client(view);
    render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    await openProgress();
    const latest = await screen.findByRole("region", { name: "最近反馈" });
    expect(latest).toHaveTextContent("实际卡住的是展示内容，不是技术。");
    expect(screen.getByText("查看这件事的完整记录")).toBeVisible();
    expect(api.turn).not.toHaveBeenCalled();
  });

  it.each(["available", "unavailable", "mismatch"] as const)("uses only matching canonical linked-card availability: %s", async status => {
    const view = saved();
    view.matter.status = "archived";
    view.matter.linkedSources = [{ sourceId: "card_1", kind: "card", version: "version_live", sourceEventId: "linked_event" }];
    view.events.push({ id: "linked_event", matterId: "matter_1", ordinal: 2, kind: "source_linked", text: "用户关联日常卡片", sources: [], createdAt: timestamp, matterVersion: 2,
      data: { linkedSourceAvailability: [{ sourceId: "card_1", kind: "card", version: status === "mismatch" ? "version_old" : "version_live", status: status === "mismatch" ? "available" : status }] } });
    const api = client(view);
    render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    await openProgress();
    const section = await screen.findByRole("region", { name: "明确关联的卡片" });
    if (status === "available") expect(within(section).getByRole("link", { name: "日常卡片 1" })).toHaveAttribute("href", "/reflection/cards/card_1");
    else {
      expect(within(section).queryByRole("link")).not.toBeInTheDocument();
      expect(section).toHaveTextContent(status === "unavailable" ? "来源已失效或已撤回" : "来源尚未核对");
    }
    const unlink = within(section).getByRole("button", { name: "取消关联卡片 1" });
    expect(unlink).not.toBeDisabled(); fireEvent.click(unlink);
    await waitFor(() => expect(screen.queryByRole("region", { name: "明确关联的卡片" })).not.toBeInTheDocument());
    expect(api.turn).not.toHaveBeenCalled();
  });

  it("describes a resolved matter as resolved rather than paused", async () => {
    const view = saved(); view.matter.status = "resolved";
    render(<ReflectionThinkingMatters api={client(view)} mode="brainstorm" />);
    expect(await screen.findByText("你已将这件事标为已解决；重新打开后可以继续，原有历史会保留。")).toBeVisible();
    expect(screen.queryByText("这件事暂时放下了；恢复后可以继续讨论，原有历史会保留。")).not.toBeInTheDocument();
  });

  it.each(["unavailable", "corrected"] as const)("disables choices for unavailable or corrected options: %s", async status => {
    const view = compared();
    view.events[1].data.interpretationStatus = status;
    view.events[1].text = status === "corrected" ? "此前解释已修正。" : "此前自动分析的来源已失效。";
    view.matter.comparison!.options = view.matter.comparison!.options.map((option, index) => ({ ...option,
      name: `此前方案 ${index + 1}（依据已失效或已修正）`, content: "旧自动内容不可作为当前依据，请重新核对。", reasons: [], limits: [], costs: [], unknowns: [],
    }));
    view.matter.comparison!.recommendation = null;
    view.matter.userChoice = { status: "selected", optionId: "option_b", reason: "保留用户明确给出的选择理由", rejectedIds: [], sourceEventId: "choice_saved" };
    view.events.push({ id: "choice_saved", matterId: "matter_1", ordinal: 2, kind: "choice_changed", text: "保留用户明确给出的选择理由", sources: [], createdAt: timestamp, matterVersion: 2,
      data: { previousChoice: { status: "undecided", optionId: null }, choice: view.matter.userChoice } });
    const api = client(view);
    render(<ReflectionThinkingMatters api={api} mode="compare_directions" />);
    await openProgress();
    await screen.findByRole("region", { name: "方案比较" });
    for (const option of view.matter.comparison!.options) {
      const section = screen.getByRole("article", { name: `方案：${option.name}` });
      for (const prefix of ["倾向", "选择", "暂不考虑"]) {
        const button = within(section).getByRole("button", { name: `${prefix}：${option.name}` });
        expect(button).toBeDisabled(); fireEvent.click(button);
      }
      expect(section).toHaveTextContent(status === "corrected" ? "此前解释已被修正，暂不可选择。" : "来源已失效，暂不可选择。");
      expect(section).toHaveTextContent("可以根据你现在的表达重新记录比较。");
    }
    expect(screen.getByText("你的选择：已选择此前方案 2（依据已失效或已修正）；原因：保留用户明确给出的选择理由")).toBeVisible();
    fireEvent.click(screen.getByText("查看取舍变化记录"));
    expect(screen.getByText("暂不决定 → 选择此前方案 2（依据已失效或已修正）")).toBeVisible();
    expect(api.mutate).not.toHaveBeenCalled(); expect(api.turn).not.toHaveBeenCalled();
  });
});


describe("Together-thinking chat layout", () => {
  beforeEach(() => { window.history.replaceState({}, "", "/reflection/think"); });

  it("keeps the main view focused on chat and renders each proposal once beside its assistant reply", async () => {
    const view = saved();
    view.matter.suggestions.push({ ...view.matter.suggestions[0], id: "orphan_proposal", sourceEventId: "earlier_reply", text: "另一条可选建议" });
    const api = client(view);
    render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    const log = await screen.findByRole("log", { name: "这件事的对话" });
    await within(log).findByText("可以先用一个最小页面试试。");
    expect(screen.queryByRole("heading", { name: view.matter.question })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "当前理解" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "方案比较" })).not.toBeInTheDocument();
    expect(log).not.toContainElement(screen.getByLabelText("继续一起想"));
    const assistant = within(log).getByText("可以先用一个最小页面试试。").closest("article")!;
    expect(within(assistant).getByRole("button", { name: "采纳这一步" })).toBeVisible();
    expect(within(log).getAllByRole("button", { name: "采纳这一步" })).toHaveLength(2);
    expect(within(log).getAllByText("另一条可选建议")).toHaveLength(1);
    expect(api.mutate).not.toHaveBeenCalled(); expect(api.turn).not.toHaveBeenCalled();
  });

  it("preserves chat and editor drafts across the drawer and keeps focus while typing", async () => {
    const api = client(compared());
    render(<ReflectionThinkingMatters api={api} mode="compare_directions" />);
    const chat = await screen.findByLabelText("继续一起想");
    fireEvent.change(chat, { target: { value: "还没有发出的讨论" } });
    await openProgress();
    fireEvent.click(screen.getByRole("button", { name: "修改目标" }));
    const goal = screen.getByLabelText("当前目标"); goal.focus();
    fireEvent.change(goal, { target: { value: "保留这段目标草稿" } });
    expect(goal).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "编辑方案比较" }));
    const option = screen.getByLabelText("方案 1 名称"); option.focus();
    fireEvent.change(option, { target: { value: "还在修改的方案名" } });
    expect(option).toHaveFocus();
    closeProgress();
    expect(chat).toHaveValue("还没有发出的讨论");
    await openProgress();
    expect(screen.getByLabelText("当前目标")).toHaveValue("保留这段目标草稿");
    expect(screen.getByLabelText("方案 1 名称")).toHaveValue("还在修改的方案名");
    expect(api.mutate).not.toHaveBeenCalled(); expect(api.turn).not.toHaveBeenCalled();
  });

  it("opens per-reply evidence and permission controls without silently granting history access", async () => {
    const view = saved();
    view.events[1].sources = [{ sourceId: "card_private", kind: "card", version: "canonical" }];
    const api = client(view);
    render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    fireEvent.click(await screen.findByRole("button", { name: "查看本轮依据 · 1" }));
    const drawer = screen.getByRole("dialog", { name: "进展与资料" });
    expect(within(drawer).getByRole("link", { name: "日常卡片 1" })).toHaveAttribute("href", "/reflection/cards/card_private");
    expect(within(drawer).getByText(/这轮回复的依据/)).toBeVisible();
    expect(within(drawer).getByLabelText("允许按需参考我的日常卡片和记忆")).not.toBeChecked();
    closeProgress();
    fireEvent.click(screen.getByRole("button", { name: "资料 · 0" }));
    expect(screen.getByRole("region", { name: "资料使用范围" })).toBeVisible();
    expect(api.mutate).not.toHaveBeenCalled(); expect(api.turn).not.toHaveBeenCalled();
  });

  it.each(["link", "unlink"] as const)("exposes a failed %s operation beside the composer and preserves its unsent draft", async operation => {
    window.history.replaceState({}, "", "/reflection/think?matter=matter_1&card=card_1");
    const view = saved();
    if (operation === "unlink") view.matter.linkedSources = [{ sourceId: "card_1", kind: "card", version: "canonical", sourceEventId: "event_1" }];
    const api = client(view);
    const failure = new Error("来源操作暂时未确认，请重新读取进展。");
    if (operation === "link") vi.mocked(api.linkCard).mockRejectedValueOnce(failure);
    else vi.mocked(api.unlinkCard).mockRejectedValueOnce(failure);
    render(<ReflectionThinkingMatters api={api} cardApi={cardApi()} mode="brainstorm" />);
    await screen.findByRole("dialog", { name: "进展与资料" });
    const draft = await screen.findByLabelText("继续一起想");
    closeProgress(); fireEvent.change(draft, { target: { value: "保留未发送的补充" } });
    await openProgress();
    if (operation === "link") {
      fireEvent.click(screen.getByLabelText("允许这件事使用这张卡片"));
      fireEvent.click(screen.getByRole("button", { name: "关联到这件事" }));
    } else fireEvent.click(screen.getByRole("button", { name: "取消关联卡片 1" }));
    expect(await screen.findByText(failure.message)).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "进展与资料" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新读取进展" })).toBeVisible();
    expect(draft).toHaveValue("保留未发送的补充");
    expect(api.turn).not.toHaveBeenCalled();
  });

  it("jumps on the user's send but preserves reading position if a later reply arrives while reading above", async () => {
    const initial = saved(), api = client(initial);
    let finish!: (view: ThinkingMatterView) => void;
    vi.mocked(api.turn).mockImplementationOnce(async () => new Promise(resolve => { finish = resolve; }));
    render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    const draft = await screen.findByLabelText("继续一起想");
    const viewport = screen.getByRole("log", { name: "这件事的对话" });
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(viewport, "scrollTo", { configurable: true, value: vi.fn() });
    viewport.scrollTop = 10; fireEvent.scroll(viewport);
    fireEvent.change(draft, { target: { value: "继续这个问题" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(viewport.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 1000 }));
    vi.mocked(viewport.scrollTo).mockClear();
    viewport.scrollTop = 40; fireEvent.scroll(viewport);
    const next = saved();
    next.events.push({ ...next.events[1], id: "new_reply", ordinal: 2, text: "新的回复已经到了" });
    await act(async () => finish(next));
    await within(viewport).findByText("新的回复已经到了");
    expect(viewport.scrollTo).not.toHaveBeenCalled(); expect(viewport.scrollTop).toBe(40);
    fireEvent.click(await screen.findByRole("button", { name: "有新回复，回到最新" }));
    expect(viewport.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 1000 }));
    expect(screen.queryByRole("button", { name: "有新回复，回到最新" })).not.toBeInTheDocument();
  });

  it("follows a new reply near the bottom and resets that behavior when switching matters", async () => {
    const first = saved(), second = saved(); second.matter.id = "matter_2"; second.matter.question = "另一件事";
    const api = client(first); vi.mocked(api.list).mockResolvedValue([first.matter, second.matter]);
    vi.mocked(api.get).mockImplementation(async id => structuredClone(id === "matter_2" ? second : first));
    render(<ReflectionThinkingMatters api={api} mode="brainstorm" />);
    await screen.findByText("选择要继续的事，或新建一件事");
    const select = screen.getByLabelText("选择正在想的事");
    fireEvent.change(select, { target: { value: "matter_1" } });
    await screen.findByLabelText("继续一起想");
    const viewport = screen.getByRole("log", { name: "这件事的对话" });
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 600 });
    Object.defineProperty(viewport, "scrollTo", { configurable: true, value: vi.fn() });
    viewport.scrollTop = 305; fireEvent.scroll(viewport);
    const next = saved(); next.events.push({ ...next.events[1], id: "followed_reply", ordinal: 2, text: "靠近底部的新回复" });
    vi.mocked(api.get).mockResolvedValueOnce(next);
    fireEvent.change(select, { target: { value: "matter_1" } });
    await within(viewport).findByText("靠近底部的新回复");
    await waitFor(() => expect(viewport.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 600 })));
    vi.mocked(viewport.scrollTo).mockClear(); viewport.scrollTop = 40; fireEvent.scroll(viewport);
    fireEvent.change(select, { target: { value: "matter_2" } });
    await waitFor(() => expect(select).toHaveValue("matter_2"));
    await waitFor(() => expect(viewport.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 600 })));
    expect(screen.queryByRole("button", { name: "有新回复，回到最新" })).not.toBeInTheDocument();
  });
});
