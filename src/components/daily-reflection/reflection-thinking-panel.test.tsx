import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DailyReflectionThinkingRequest,
  DailyReflectionThinkingResponse
} from "@/lib/domain/daily-reflection-thinking";
import type { DailyReflectionThinkingApi } from "@/lib/client/daily-reflection-thinking-api";

import {
  ReflectionThinkingProvider,
  ReflectionThinkingQuickPanel,
  ThinkingComposer,
  ThinkingConversation,
  normalizeThinkingPlainText,
  useReflectionThinking
} from "./reflection-thinking-panel";
import { ReflectionThinkingWorkspace } from "./reflection-thinking-workspace";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => navigation
}));

function responseFor(
  input: DailyReflectionThinkingRequest,
  conversationId = input.conversationId ?? "thinking_conversation_1",
  content = `回应：${input.message}`,
  usedPersonalContext = input.contextMode === "personal"
): DailyReflectionThinkingResponse {
  const personal = usedPersonalContext;
  const source = {
    sourceId: "source_1",
    claim: {
      text: "你此前决定先验证浏览器工作台。",
      sourceMemoryIds: ["memory_1"],
      sourceCardIds: ["card_1"],
      evidenceIds: ["segment_1"],
      evidence: [{
        reflectionId: "reflection_1",
        cardId: "card_1",
        recordingDate: "2026-08-23",
        sourceOrigin: "user_reflection" as const,
        sourceSegmentId: "segment_1",
        startSeconds: 12,
        endSeconds: 19,
        snippet: "我决定先验证浏览器工作台。"
      }],
      epistemicStatuses: ["explicit_user_statement" as const]
    }
  };
  const sources = personal ? [source] : [];
  return {
    conversationId,
    operationKey: input.operationKey,
    assistantMessage: {
      id: `assistant_${input.operationKey}`,
      operationKey: input.operationKey,
      role: "assistant",
      mode: input.mode,
      contextMode: input.contextMode,
      content,
      usedPersonalContext: personal,
      sources,
      personalContextClaims: personal ? [{
        text: source.claim.text,
        sourceIds: [source.sourceId]
      }] : [],
      interpretations: ["可以先并排写下两个方向。"],
      hypotheses: ["也许真正需要验证的是使用节奏。"],
      model: "fixture-model",
      createdAt: "2026-08-26T08:00:00.000Z",
      completionStatus: "completed"
    },
    usedPersonalContext: personal,
    sources,
    model: "fixture-model"
  };
}

function api(responseContent?: string): DailyReflectionThinkingApi & {
  think: ReturnType<typeof vi.fn<DailyReflectionThinkingApi["think"]>>;
  getConversation: ReturnType<typeof vi.fn<DailyReflectionThinkingApi["getConversation"]>>;
} {
  return {
    think: vi.fn(async (input) => responseFor(input, undefined, responseContent ?? `回应：${input.message}`)),
    getConversation: vi.fn(async (conversationId) => ({
      schemaVersion: 1,
      conversationId,
      messages: [],
      createdAt: "2026-08-26T08:00:00.000Z",
      updatedAt: "2026-08-26T08:00:00.000Z"
    }))
  };
}

function Harness() {
  const state = useReflectionThinking();
  return (
    <>
      <output aria-label="conversation id">{state.conversationId ?? "none"}</output>
      <button onClick={() => state.changeMode("clarify_decision")} type="button">切到决定</button>
      <ThinkingConversation />
      <ThinkingComposer />
    </>
  );
}

function PanelHarness() {
  const state = useReflectionThinking();
  return (
    <>
      <button onClick={(event) => state.openPanel(event.currentTarget)} type="button">打开头脑风暴</button>
      <output aria-label="conversation id">{state.conversationId ?? "none"}</output>
      <ReflectionThinkingQuickPanel />
    </>
  );
}

describe("Reflection thinking UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
  });

  it("retains one conversation, history and unsent input across mode switches", async () => {
    const client = api();
    render(<ReflectionThinkingProvider api={client}><Harness /></ReflectionThinkingProvider>);

    fireEvent.change(screen.getByLabelText("想一起推演什么"), {
      target: { value: "先看看这个想法有哪些方向。" }
    });
    fireEvent.click(screen.getByRole("button", { name: "一起想" }));

    await screen.findByText("回应：先看看这个想法有哪些方向。");
    expect(screen.getByLabelText("conversation id")).toHaveTextContent("thinking_conversation_1");
    expect(screen.getByText(/头脑风暴/u)).toBeVisible();
    expect(client.think).toHaveBeenNthCalledWith(1, expect.objectContaining({
      mode: "brainstorm",
      contextMode: "personal"
    }), expect.any(AbortSignal));

    fireEvent.change(screen.getByLabelText("想一起推演什么"), {
      target: { value: "这段草稿不能在切换时消失。" }
    });
    fireEvent.click(screen.getByRole("button", { name: "切到决定" }));

    expect(screen.getByLabelText("conversation id")).toHaveTextContent("thinking_conversation_1");
    expect(screen.getByLabelText("想一起推演什么")).toHaveValue("这段草稿不能在切换时消失。");
    expect(screen.getByText("回应：先看看这个想法有哪些方向。")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "一起想" }));
    await screen.findByText("回应：这段草稿不能在切换时消失。");

    expect(client.think).toHaveBeenNthCalledWith(2, expect.objectContaining({
      conversationId: "thinking_conversation_1",
      mode: "clarify_decision",
      contextMode: "personal"
    }), expect.any(AbortSignal));
    expect(screen.getByText(/想清一个决定/u)).toBeVisible();
    expect(screen.queryByText("新的推演")).not.toBeInTheDocument();
    expect(screen.queryByText("模型解释")).not.toBeInTheDocument();
    expect(screen.queryByText("可以先并排写下两个方向。")).not.toBeInTheDocument();
    expect(screen.queryByText("也许真正需要验证的是使用节奏。")).not.toBeInTheDocument();
    expect(screen.getAllByText("本轮参考 · 1 组来源")).toHaveLength(2);
  });

  it.each([
    ["brainstorm", "头脑风暴"],
    ["clarify_decision", "想清一个决定"],
    ["compare_directions", "比较几个方向"],
    ["extend_idea", "延伸一个想法"]
  ] as const)("uses personal retrieval by default for %s but answers without a match", async (mode, label) => {
    const client = api();
    client.think.mockImplementationOnce(async (input) => responseFor(
      input,
      undefined,
      `回应：${input.message}`,
      false
    ));
    render(
      <ReflectionThinkingProvider api={client}>
        <ReflectionThinkingWorkspace initialMode={mode} />
      </ReflectionThinkingProvider>
    );

    await waitFor(() => expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "true"));
    fireEvent.change(screen.getByLabelText("想一起推演什么"), {
      target: { value: "继续想这个问题。" }
    });
    fireEvent.click(screen.getByRole("button", { name: "一起想" }));

    await waitFor(() => expect(client.think).toHaveBeenCalledWith(expect.objectContaining({
      mode,
      contextMode: "personal"
    }), expect.any(AbortSignal)));
    expect(screen.getByText("回应：继续想这个问题。")).toBeVisible();
    expect(screen.queryByText(/本轮参考/u)).not.toBeInTheDocument();
  });

  it("does not expose internal retrieval modes in the full workspace", async () => {
    const client = api();
    render(
      <ReflectionThinkingProvider api={client}>
        <ReflectionThinkingWorkspace />
      </ReflectionThinkingProvider>
    );

    for (const label of ["只看当前问题", "结合我的内容", "需要时再找"]) {
      expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
    }
  });

  it("opens a modal Quick Panel, restores focus on Escape and keeps the page scroll position", async () => {
    const client = api();
    render(<ReflectionThinkingProvider api={client}><PanelHarness /></ReflectionThinkingProvider>);
    const trigger = screen.getByRole("button", { name: "打开头脑风暴" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "先把这个念头打开" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(document.body.style.overflow).toBe("hidden");
    for (const label of ["只看当前问题", "结合我的内容", "需要时再找"]) {
      expect(within(dialog).queryByRole("button", { name: label })).not.toBeInTheDocument();
    }

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(document.body.style.overflow).toBe("");
  });

  it("carries the same conversation and private draft from Quick Panel into the full workspace", async () => {
    const client = api();
    const view = render(
      <ReflectionThinkingProvider api={client}><PanelHarness /></ReflectionThinkingProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "打开头脑风暴" }));
    const dialog = screen.getByRole("dialog", { name: "先把这个念头打开" });
    fireEvent.change(within(dialog).getByLabelText("想一起推演什么"), {
      target: { value: "先形成第一轮回答。" }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "一起想" }));
    await within(dialog).findByText("回应：先形成第一轮回答。");
    fireEvent.change(within(dialog).getByLabelText("想一起推演什么"), {
      target: { value: "这段私人草稿只通过会话交接。" }
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /在“一起想”中展开/u }));

    expect(navigation.push).toHaveBeenCalledWith("/reflection/think?mode=brainstorm");
    expect(navigation.push.mock.calls[0]?.[0]).not.toContain("私人草稿");

    view.rerender(
      <ReflectionThinkingProvider api={client}>
        <ReflectionThinkingWorkspace initialMode="brainstorm" />
      </ReflectionThinkingProvider>
    );
    expect(screen.getByText("回应：先形成第一轮回答。")).toBeVisible();
    expect(screen.getByLabelText("想一起推演什么")).toHaveValue("这段私人草稿只通过会话交接。");
    expect(client.think).toHaveBeenCalledWith(expect.objectContaining({
      contextMode: "personal"
    }), expect.any(AbortSignal));
    expect(screen.queryByRole("button", { name: "结合我的内容" })).not.toBeInTheDocument();
  });

  it("keeps answers as safe plain text while removing common historical display markers", async () => {
    const historical = [
      "# 一个方向",
      "",
      "- **先写下问题**",
      "- [危险链接](javascript:alert(1))",
      "",
      "> 保留这一段",
      "<script>alert('x')</script>"
    ].join("\n");
    const client = api(historical);
    const { container } = render(
      <ReflectionThinkingProvider api={client}><Harness /></ReflectionThinkingProvider>
    );

    fireEvent.change(screen.getByLabelText("想一起推演什么"), {
      target: { value: "展示历史回答。" }
    });
    fireEvent.click(screen.getByRole("button", { name: "一起想" }));

    const answer = await screen.findByTestId("thinking-answer");
    expect(answer.textContent).toBe([
      "一个方向",
      "",
      "先写下问题",
      "危险链接",
      "",
      "保留这一段",
      "<script>alert('x')</script>"
    ].join("\n"));
    expect(answer.textContent).not.toMatch(/\*\*|^#\s|^-\s/mu);
    expect(answer.querySelector("strong, em, a, ul, ol")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(normalizeThinkingPlainText("## 标题\n\n1. 第一项\n2. 第二项")).toBe("标题\n\n第一项\n第二项");
    expect(normalizeThinkingPlainText("保留 source_id 和 2 * 3")).toBe("保留 source_id 和 2 * 3");
  });

  it("aborts an in-flight request on mode switch and preserves the sent question in the conversation", async () => {
    const client = api();
    let capturedSignal: AbortSignal | undefined;
    client.think.mockImplementationOnce((_input, signal) => {
      capturedSignal = signal;
      return new Promise(() => undefined);
    });
    render(<ReflectionThinkingProvider api={client}><Harness /></ReflectionThinkingProvider>);

    fireEvent.change(screen.getByLabelText("想一起推演什么"), {
      target: { value: "切换时仍要保留。" }
    });
    fireEvent.click(screen.getByRole("button", { name: "一起想" }));
    await waitFor(() => expect(capturedSignal).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "切到决定" }));

    expect(capturedSignal?.aborted).toBe(true);
    expect(screen.getByLabelText("想一起推演什么")).toHaveValue("");
    expect(screen.getByText("切换时仍要保留。")).toBeVisible();
    expect(screen.getByText("已停止回复")).toBeVisible();
  });

  it("shows the sent question and thinking status immediately, then preserves the next draft", async () => {
    const client = api();
    let finish!: () => void;
    client.think.mockImplementationOnce((input) => new Promise((resolve) => {
      finish = () => resolve(responseFor(input));
    }));
    render(<ReflectionThinkingProvider api={client}><Harness /></ReflectionThinkingProvider>);
    const composer = screen.getByLabelText("想一起推演什么");
    fireEvent.change(composer, { target: { value: "先从哪里开始？" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(composer).toHaveValue("");
    const conversation = screen.getByRole("list", { name: "本次一起想的内容" });
    expect(within(conversation).getByText("先从哪里开始?")).toBeVisible();
    expect(within(conversation).getByRole("status")).toHaveTextContent("AI 正在思考回复");
    fireEvent.change(composer, { target: { value: "下一句草稿" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(client.think).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(screen.getByText("回应：先从哪里开始?")).toBeVisible();
    expect(within(conversation).queryByRole("status")).not.toBeInTheDocument();
    expect(within(conversation).getAllByText("先从哪里开始?")).toHaveLength(1);
    expect(composer).toHaveValue("下一句草稿");
  });

  it.each(["network", "provider"])("retains one question through %s failure and explicit retry", async (failure) => {
    const client = api();
    client.think.mockImplementationOnce(async (input) => {
      if (failure === "network") throw new Error("offline");
      const response = responseFor(input);
      return { ...response, assistantMessage: { ...response.assistantMessage, completionStatus: "provider_error" } };
    });
    render(<ReflectionThinkingProvider api={client}><Harness /></ReflectionThinkingProvider>);
    fireEvent.change(screen.getByLabelText("想一起推演什么"), { target: { value: "保留这个问题" } });
    fireEvent.click(screen.getByRole("button", { name: "一起想" }));
    await screen.findByRole("alert");
    expect(screen.getByText("保留这个问题")).toBeVisible();
    expect(screen.getByLabelText("想一起推演什么")).toHaveValue("");
    expect(client.think).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("回应：保留这个问题");
    expect(screen.getAllByText("保留这个问题")).toHaveLength(1);
    const firstKey = client.think.mock.calls[0][0].operationKey;
    const retryKey = client.think.mock.calls[1][0].operationKey;
    if (failure === "network") expect(retryKey).toBe(firstKey);
    else expect(retryKey).not.toBe(firstKey);
  });

  it("ignores a late stopped reply while another question is waiting", async () => {
    const client = api();
    let finishOld!: () => void;
    let finishNew!: () => void;
    client.think.mockImplementationOnce((input) => new Promise((resolve) => {
      finishOld = () => resolve(responseFor(input));
    })).mockImplementationOnce((input) => new Promise((resolve) => {
      finishNew = () => resolve(responseFor(input));
    }));
    render(<ReflectionThinkingProvider api={client}><Harness /></ReflectionThinkingProvider>);
    const composer = screen.getByLabelText("想一起推演什么");
    fireEvent.change(composer, { target: { value: "旧问题" } });
    fireEvent.click(screen.getByRole("button", { name: "一起想" }));
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    fireEvent.change(composer, { target: { value: "新问题" } });
    fireEvent.click(screen.getByRole("button", { name: "一起想" }));
    await act(async () => finishOld());
    expect(screen.queryByText("回应：旧问题")).not.toBeInTheDocument();
    expect(screen.getByText("AI 正在思考回复…")).toBeVisible();
    expect(client.think).toHaveBeenCalledTimes(2);
    await act(async () => finishNew());
    expect(screen.getByText("回应：新问题")).toBeVisible();
    expect(screen.getByText("旧问题")).toBeVisible();
  });

  it("hides scope controls and forces personal retrieval for past clues", async () => {
    const client = api();
    render(
      <ReflectionThinkingProvider api={client}>
        <ReflectionThinkingWorkspace initialMode="past_clues" />
      </ReflectionThinkingProvider>
    );

    const modes = screen.getByRole("group", { name: "一起想的方式" });
    for (const label of ["头脑风暴", "想清一个决定", "比较几个方向", "延伸一个想法", "从过去找线索"]) {
      expect(within(modes).getByRole("button", { name: label })).toBeVisible();
    }
    expect(screen.queryByText("参考范围")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "只看当前问题" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "结合我的内容" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "需要时再找" })).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText(/第\s*\d+\s*步|步骤|进度/u)).not.toBeInTheDocument();
    const messageViewport = screen.getByRole("log", { name: "一起想的消息" });
    const composer = screen.getByLabelText("想一起推演什么").closest("form");
    expect(messageViewport.contains(composer)).toBe(false);
    expect(messageViewport.parentElement).toBe(composer?.parentElement);
    fireEvent.change(screen.getByLabelText("想一起推演什么"), {
      target: { value: "我以前是怎么想的？" }
    });
    fireEvent.click(screen.getByRole("button", { name: "一起想" }));
    await waitFor(() => expect(client.think).toHaveBeenCalledWith(expect.objectContaining({
      mode: "past_clues",
      contextMode: "personal"
    }), expect.any(AbortSignal)));
  });

  it("follows new messages only while the reader remains near the bottom", async () => {
    const client = api();
    render(
      <ReflectionThinkingProvider api={client}><ReflectionThinkingWorkspace /></ReflectionThinkingProvider>
    );
    const viewport = screen.getByRole("log", { name: "一起想的消息" });
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 600 });
    Object.defineProperty(viewport, "scrollTo", { configurable: true, value: vi.fn() });
    viewport.scrollTop = 400;
    fireEvent.scroll(viewport);

    fireEvent.change(screen.getByLabelText("想一起推演什么"), {
      target: { value: "第一轮。" }
    });
    fireEvent.click(screen.getByRole("button", { name: "一起想" }));
    await screen.findByText("回应：第一轮。");
    await waitFor(() => expect(viewport.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 600 })));

    vi.mocked(viewport.scrollTo).mockClear();
    viewport.scrollTop = 40;
    fireEvent.scroll(viewport);
    fireEvent.change(screen.getByLabelText("想一起推演什么"), {
      target: { value: "第二轮。" }
    });
    fireEvent.click(screen.getByRole("button", { name: "一起想" }));
    await screen.findByText("回应：第二轮。");
    await waitFor(() => expect(client.think).toHaveBeenCalledTimes(2));
    expect(viewport.scrollTo).not.toHaveBeenCalled();
    expect(viewport.scrollTop).toBe(40);
  });
});
