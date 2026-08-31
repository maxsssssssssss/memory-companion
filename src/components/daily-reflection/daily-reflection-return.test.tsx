import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  DailyReflectionDailyReturnResponse,
  DailyReflectionReturnItem,
  DailyReflectionWeeklyItem,
  DailyReflectionWeeklyReflectionResponse
} from "@/lib/domain/daily-reflection-return";

import { DailyReflectionReturn } from "./daily-reflection-return";
import { consumeCaptureContextIntent } from "./reflection-capture-intent";

function evidence(cardId = "card_1", recordingDate = "2026-08-23") {
  return [{
    reflectionId: "reflection_1",
    cardId,
    recordingDate,
    sourceOrigin: "user_reflection" as const,
    sourceSegmentId: `segment_${cardId}`,
    startSeconds: 65,
    endSeconds: 72,
    snippet: "我决定先把这件事做完，再开始下一项。"
  }];
}

function dailyItem(
  id: string,
  type: DailyReflectionReturnItem["type"],
  title: string
): DailyReflectionReturnItem {
  const cardId = `card_${id}`;
  return {
    id,
    type,
    title,
    body: type === "reflection_prompt" ? "你之前提到这件事，现在情况有变化吗？" : `${title}的可核对内容。`,
    sourceMemoryIds: [`memory_${id}`],
    sourceCardIds: [cardId],
    evidenceIds: [`evidence_${id}`],
    evidence: evidence(cardId),
    epistemicStatuses: ["explicit_user_statement"],
    createdAt: "2026-08-24T01:00:00.000Z"
  };
}

function weeklyItem(
  id: string,
  type: DailyReflectionWeeklyItem["type"],
  title: string
): DailyReflectionWeeklyItem {
  const cardId = `card_${id}`;
  return {
    id,
    type,
    title,
    body: `${title}的有来源回顾。`,
    sourceCount: type === "repeated_theme" ? 2 : 1,
    dates: type === "repeated_theme" ? ["2026-08-22", "2026-08-23"] : ["2026-08-23"],
    sourceMemoryIds: type === "emerging_idea" ? [] : [`memory_${id}`],
    sourceCardIds: [cardId],
    evidenceIds: [`evidence_${id}`],
    evidence: evidence(cardId),
    epistemicStatuses: ["explicit_user_statement"],
    createdAt: "2026-08-24T01:00:00.000Z"
  };
}

function dailyResponse(overrides: Partial<DailyReflectionDailyReturnResponse> = {}): DailyReflectionDailyReturnResponse {
  return {
    referenceDate: "2026-08-24",
    timeZone: "Asia/Shanghai",
    openLoops: [dailyItem("open", "open_loop", "继续完成复盘")],
    resurfacedMemories: [dailyItem("past", "resurfaced_memory", "回看上周决定")],
    reflectionPrompts: [dailyItem("prompt", "reflection_prompt", "确认最近变化")],
    ...overrides
  };
}

function weeklyResponse(overrides: Partial<DailyReflectionWeeklyReflectionResponse> = {}): DailyReflectionWeeklyReflectionResponse {
  return {
    startDate: "2026-08-18",
    endDate: "2026-08-24",
    timeZone: "Asia/Shanghai",
    repeatedThemes: [weeklyItem("theme", "repeated_theme", "重复提到留出专注时间")],
    changedDecisions: [weeklyItem("decision", "changed_decision", "先后决定有变化")],
    openCommitments: [weeklyItem("commitment", "open_commitment", "仍待完成的事项")],
    emergingIdeas: [weeklyItem("idea", "emerging_idea", "新想法")],
    ...overrides
  };
}

function api(
  daily: Promise<DailyReflectionDailyReturnResponse> = Promise.resolve(dailyResponse()),
  weekly: Promise<DailyReflectionWeeklyReflectionResponse> = Promise.resolve(weeklyResponse())
) {
  return {
    getDailyReturn: vi.fn(() => daily),
    getWeeklyReflection: vi.fn(() => weekly)
  };
}

describe("DailyReflectionReturn", () => {
  it("presents one deterministic Today focus without claiming importance and switches focus locally", async () => {
    window.sessionStorage.clear();
    const returnApi = api();
    const { container } = render(<DailyReflectionReturn api={returnApi} embedded />);

    expect(await screen.findByText("今天有 3 件过去的内容值得重新看看。")).toBeVisible();
    expect(screen.getByText("2026 年 8 月 24 日")).toBeVisible();
    expect(screen.getByText("今天先看")).toBeVisible();
    expect(screen.getByRole("button", { name: /^继续完成复盘$/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("另外 2 条值得回看")).toBeVisible();
    expect(screen.queryByText(/最重要|最高优先级|为什么今天值得再看/)).not.toBeInTheDocument();

    const secondary = screen.getByRole("button", { name: /^现在是否有变化.*确认最近变化/ });
    fireEvent.click(secondary);
    expect(screen.getByRole("button", { name: /^确认最近变化$/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /^仍值得继续.*继续完成复盘/ })).toBeVisible();
    expect(screen.getAllByText("确认最近变化")).toHaveLength(1);
    const continueLink = screen.getByRole("link", { name: "继续想" });
    expect(continueLink).toHaveAttribute("href", "/reflection/capture?new=1");
    expect(continueLink.getAttribute("href")).not.toContain("确认最近变化");
    continueLink.addEventListener("click", (event) => event.preventDefault(), { once: true });
    fireEvent.click(continueLink);
    expect(consumeCaptureContextIntent()).toBe("确认最近变化：你之前提到这件事，现在情况有变化吗？");
    expect(screen.getByRole("link", { name: "打开原卡片" }))
      .toHaveAttribute("href", "/reflection/cards/card_prompt");
    expect(returnApi.getDailyReturn).toHaveBeenCalledWith({}, expect.any(AbortSignal));
    expect(returnApi.getWeeklyReflection).toHaveBeenCalledWith({}, expect.any(AbortSignal));

    for (const forbidden of ["Provider", "Candidate", "Admission", "Pipeline", "Evidence ID", "Memory ID", "confidence"]) {
      expect(container.textContent).not.toContain(forbidden);
    }
  });

  it("supports Home and End keyboard navigation between Today and Week", async () => {
    render(<DailyReflectionReturn api={api()} embedded />);
    await screen.findByText("今天有 3 件过去的内容值得重新看看。");
    const today = screen.getByRole("tab", { name: "今天" });
    const week = screen.getByRole("tab", { name: "本周" });

    fireEvent.keyDown(today, { key: "End" });
    expect(week).toHaveAttribute("aria-selected", "true");
    expect(week).toHaveFocus();

    fireEvent.keyDown(week, { key: "Home" });
    expect(today).toHaveAttribute("aria-selected", "true");
    expect(today).toHaveFocus();
  });

  it("opens an evidence-grounded accessible Quick View and restores scroll and focus", async () => {
    render(<DailyReflectionReturn api={api()} embedded />);
    const trigger = await screen.findByRole("button", { name: /^继续完成复盘$/ });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "继续完成复盘" });
    expect(trigger).toHaveAttribute("aria-controls", "return-quick-view");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("button", { name: "继续完成复盘" })).toHaveAttribute("aria-expanded", "true");
    expect(within(dialog).getByText("我决定先把这件事做完，再开始下一项。")).toBeVisible();
    expect(within(dialog).getByText("你在 8 月 23 日 的复盘中提到")).toBeVisible();
    expect(within(dialog).getByText("1:05")).toBeVisible();
    expect(within(dialog).getByRole("link", { name: "查看原话" }))
      .toHaveAttribute("href", "/reflection/sessions/reflection_1?segment=segment_card_open");
    expect(document.body.style.overflow).toBe("hidden");
    expect(within(dialog).getByRole("button", { name: "关闭回看详情" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(within(dialog).getByRole("link", { name: "打开原卡片" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.body.style.overflow).toBe("");
  });

  it("keeps all eligible Daily items and folds only the items beyond the current three", async () => {
    render(<DailyReflectionReturn api={api(Promise.resolve(dailyResponse({
      openLoops: [
        dailyItem("open", "open_loop", "继续完成复盘"),
        dailyItem("open_two", "open_loop", "第二条未完成")
      ],
      reflectionPrompts: [
        dailyItem("prompt", "reflection_prompt", "确认最近变化"),
        dailyItem("prompt_two", "reflection_prompt", "第二个变化问题")
      ]
    })))} embedded />);

    expect(await screen.findByText("今天有 5 件过去的内容值得重新看看。")).toBeVisible();
    const more = screen.getByText(/更多值得回看/);
    expect(more).toBeVisible();
    expect(screen.getByText("第二条未完成")).not.toBeVisible();
    fireEvent.click(more);
    expect(screen.getByText("第二条未完成")).toBeVisible();
    expect(screen.getByText("第二个变化问题")).toBeVisible();
  });

  it("renders Weekly as real non-empty categories without inventing a weekly mainline", async () => {
    render(<DailyReflectionReturn api={api(
      Promise.resolve(dailyResponse()),
      Promise.resolve(weeklyResponse({ changedDecisions: [] }))
    )} embedded />);

    await screen.findByText("今天有 3 件过去的内容值得重新看看。");
    fireEvent.click(screen.getByRole("tab", { name: "本周" }));
    expect(await screen.findByText("本周有 3 个线索值得重新整理。")).toBeVisible();
    expect(screen.getByRole("heading", { name: "反复出现的主题" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "发生变化的决定" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "仍在继续的承诺" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "正在形成的想法" })).toBeVisible();
    expect(screen.queryByText(/本周主线|本周最重要/)).not.toBeInTheDocument();
    expect(within(screen.getByRole("heading", { name: "反复出现的主题" }).closest("section") as HTMLElement)
      .getByText("2 条来源")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "重复提到留出专注时间" }));
    const dialog = screen.getByRole("dialog", { name: "重复提到留出专注时间" });
    expect(within(dialog).getByText("反复出现的主题")).toBeVisible();
    expect(within(dialog).getByRole("link", { name: "查看原话" })).toBeVisible();
  });

  it("keeps empty states honest and hides unsafe or source-free items", async () => {
    const unsafe = {
      ...dailyItem("unsafe", "open_loop", "不应展示"),
      epistemicStatuses: ["unknown"],
      evidenceIds: [],
      evidence: []
    } as unknown as DailyReflectionReturnItem;
    render(<DailyReflectionReturn api={api(
      Promise.resolve(dailyResponse({ openLoops: [unsafe], resurfacedMemories: [], reflectionPrompts: [] })),
      Promise.resolve(weeklyResponse({ repeatedThemes: [], changedDecisions: [], openCommitments: [], emergingIdeas: [] }))
    )} embedded />);

    expect(await screen.findByText("今天暂时没有需要重新出现的内容。")).toBeVisible();
    expect(screen.queryByText("不应展示")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "本周" }));
    expect(await screen.findByText("本周还没有形成足够清晰的回看线索。")).toBeVisible();
  });

  it("keeps Daily and Weekly failures independent and retries only the failed scope", async () => {
    const getDailyReturn = vi.fn()
      .mockRejectedValueOnce(new Error("daily unavailable"))
      .mockResolvedValueOnce(dailyResponse());
    const returnApi = {
      getDailyReturn,
      getWeeklyReflection: vi.fn(() => Promise.resolve(weeklyResponse()))
    };
    render(<DailyReflectionReturn api={returnApi} embedded />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("今天的回看暂时无法加载。");
    fireEvent.click(within(alert).getByRole("button", { name: "重新尝试" }));
    expect(await screen.findByText("今天有 3 件过去的内容值得重新看看。")).toBeVisible();
    expect(getDailyReturn).toHaveBeenCalledTimes(2);
    expect(returnApi.getWeeklyReflection).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("tab", { name: "本周" }));
    expect(screen.getByText("重复提到留出专注时间")).toBeVisible();
  });
});
