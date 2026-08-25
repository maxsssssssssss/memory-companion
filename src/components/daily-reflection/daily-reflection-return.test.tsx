import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  DailyReflectionDailyReturnResponse,
  DailyReflectionReturnItem,
  DailyReflectionWeeklyItem,
  DailyReflectionWeeklyReflectionResponse
} from "@/lib/domain/daily-reflection-return";

import { DailyReflectionReturn } from "./daily-reflection-return";

function evidence(cardId = "card_1") {
  return [{
    reflectionId: "reflection_1",
    cardId,
    recordingDate: "2026-08-24",
    sourceOrigin: "user_reflection" as const,
    sourceSegmentId: "segment_1",
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
  return {
    id,
    type,
    title,
    body: type === "reflection_prompt" ? "你之前提到这件事，现在情况有变化吗？" : `${title}的可核对内容。`,
    sourceMemoryIds: [`memory_${id}`],
    sourceCardIds: ["card_1"],
    evidenceIds: ["segment_1"],
    evidence: evidence(),
    epistemicStatuses: ["explicit_user_statement"],
    createdAt: "2026-08-24T01:00:00.000Z"
  };
}

function weeklyItem(
  id: string,
  type: DailyReflectionWeeklyItem["type"],
  title: string
): DailyReflectionWeeklyItem {
  return {
    id,
    type,
    title,
    body: `${title}的有来源回顾。`,
    sourceCount: type === "repeated_theme" ? 2 : 1,
    dates: type === "repeated_theme" ? ["2026-08-23", "2026-08-24"] : ["2026-08-24"],
    sourceMemoryIds: type === "emerging_idea" ? [] : [`memory_${id}`],
    sourceCardIds: ["card_1"],
    evidenceIds: ["segment_1"],
    evidence: evidence(),
    epistemicStatuses: ["explicit_user_statement"],
    createdAt: "2026-08-24T01:00:00.000Z"
  };
}

function dailyResponse(overrides: Partial<DailyReflectionDailyReturnResponse> = {}): DailyReflectionDailyReturnResponse {
  return {
    referenceDate: "2026-08-24",
    timeZone: "Asia/Shanghai",
    openLoops: [dailyItem("return_open", "open_loop", "继续完成复盘")],
    resurfacedMemories: [dailyItem("return_past", "resurfaced_memory", "回看上周决定")],
    reflectionPrompts: [dailyItem("return_prompt", "reflection_prompt", "确认最近变化")],
    ...overrides
  };
}

function weeklyResponse(overrides: Partial<DailyReflectionWeeklyReflectionResponse> = {}): DailyReflectionWeeklyReflectionResponse {
  return {
    startDate: "2026-08-18",
    endDate: "2026-08-24",
    timeZone: "Asia/Shanghai",
    repeatedThemes: [weeklyItem("weekly_theme", "repeated_theme", "重复提到留出专注时间")],
    changedDecisions: [weeklyItem("weekly_decision", "changed_decision", "先后决定有变化")],
    openCommitments: [weeklyItem("weekly_commitment", "open_commitment", "仍待完成的事项")],
    emergingIdeas: [weeklyItem("weekly_idea", "emerging_idea", "新想法")],
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
  it("shows Daily Return and Weekly Reflection with evidence-first source links", async () => {
    const returnApi = api();
    const { container } = render(<DailyReflectionReturn api={returnApi} />);

    expect(await screen.findByRole("heading", { name: "一个未解决问题" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "一个相关旧想法" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "一个值得核对的变化" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "反复出现了什么" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "本周" }));
    expect(screen.getByRole("heading", { name: "反复出现了什么" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "什么发生变化" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "什么仍未解决" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "什么可能形成方向" })).toBeVisible();
    expect(screen.queryByText("我决定先把这件事做完，再开始下一项。")).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "查看依据" })[0]);
    expect(screen.getByText("我决定先把这件事做完，再开始下一项。")).toBeVisible();
    expect(screen.getByText("你在 2026-08-24 的复盘中提到 · 1:05")).toBeVisible();
    expect(screen.getByRole("link", { name: "查看原话" }))
      .toHaveAttribute("href", "/reflection/sessions/reflection_1?segment=segment_1");
    expect(returnApi.getDailyReturn).toHaveBeenCalledWith({}, expect.any(AbortSignal));
    expect(returnApi.getWeeklyReflection).toHaveBeenCalledWith({}, expect.any(AbortSignal));

    for (const forbidden of [
      "Provider",
      "Candidate",
      "Admission",
      "Pipeline",
      "Evidence ID",
      "Memory ID",
      "Proposal ID",
      "contentHash",
      "confidence"
    ]) {
      expect(container.textContent).not.toContain(forbidden);
    }
  });

  it("keeps empty states honest and hides unsafe or source-free items", async () => {
    const unsafe = {
      ...dailyItem("unsafe", "open_loop", "不应展示"),
      epistemicStatuses: ["unknown"],
      evidenceIds: [],
      evidence: []
    } as unknown as DailyReflectionReturnItem;
    render(<DailyReflectionReturn api={api(
      Promise.resolve(dailyResponse({
        openLoops: [unsafe],
        resurfacedMemories: [],
        reflectionPrompts: []
      })),
      Promise.resolve(weeklyResponse({
        repeatedThemes: [],
        changedDecisions: [],
        openCommitments: [],
        emergingIdeas: []
      }))
    )} />);

    expect(await screen.findByText("今天暂时没有需要回看的内容。")).toBeVisible();
    expect(screen.queryByText("不应展示")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "本周" }));
    expect(await screen.findByText("过去七天暂无足够、有来源的回顾内容。")).toBeVisible();
  });

  it("keeps Daily and Weekly loading failures independent", async () => {
    render(<DailyReflectionReturn api={api(
      Promise.reject(new Error("daily unavailable")),
      Promise.resolve(weeklyResponse())
    )} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("今天的回看暂时无法加载。");
    fireEvent.click(screen.getByRole("tab", { name: "本周" }));
    const weekly = screen.getByRole("heading", { name: "本周回顾" }).closest("section");
    expect(weekly).not.toBeNull();
    expect(within(weekly as HTMLElement).getByText("重复提到留出专注时间")).toBeVisible();
  });
});
