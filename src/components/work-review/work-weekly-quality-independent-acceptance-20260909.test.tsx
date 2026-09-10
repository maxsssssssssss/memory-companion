import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ACCOUNT_ID, createFixture, NOW } from "../../../e2e/fixtures/work-review-ui-acceptance-20260909.fixture";
import type { WorkReviewV2CoreApi } from "@/lib/client/work-review-api";
import type { WorkWeeklyDisplayedGeneration, WorkWeeklyLatestGeneration, WorkWeeklyReview, WorkWeeklyReviewItem } from "@/lib/domain/work-weekly";
import { WorkReviewContext } from "./work-review-shell";
import { WorkWeeklyPage } from "./work-weekly-page";

const navigation = vi.hoisted(() => ({
  pathname: "/work-review/weekly",
  router: { push: vi.fn(), replace: vi.fn() },
  search: new URLSearchParams("weekStart=2026-09-07&scope=all")
}));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => navigation.router,
  useSearchParams: () => navigation.search
}));

const writes: string[] = [];
function show(records: Array<Partial<WorkWeeklyReviewItem> & { id: string }>, assessment: {
  displayedGeneration?: WorkWeeklyDisplayedGeneration | null;
  latestGeneration?: WorkWeeklyLatestGeneration | null;
  reviewStatus?: WorkWeeklyReview["status"];
} = {}) {
  const data = createFixture();
  const items = records.map((record) => ({ ...data.items[0]!, ...record }));
  const before = JSON.stringify(items);
  const detail = { review: { ...data.review, status: assessment.reviewStatus ?? data.review.status }, items,
    sourceSummary: data.sourceSummary, displayedGeneration: assessment.displayedGeneration ?? null,
    latestGeneration: assessment.latestGeneration ?? null };
  const allowed = {
    listProjects: vi.fn().mockResolvedValue(data.projects),
    getWeeklyReview: vi.fn().mockResolvedValue(detail),
    getWeeklyReviewDetail: vi.fn().mockResolvedValue(detail),
    getWeeklyQa: vi.fn().mockResolvedValue(null)
  };
  // Every unexpected method is fatal; this component fixture cannot write data.
  const api = new Proxy(allowed, { get(target, name: string) {
    if (name in target) return target[name as keyof typeof target];
    return () => { writes.push(name); throw new Error(`unexpected fixture API: ${name}`); };
  } }) as unknown as WorkReviewV2CoreApi;
  render(<WorkReviewContext.Provider value={{
    api, capabilities: data.capabilities, capabilitiesStatus: "ready", refreshCapabilities: vi.fn(),
    featureFlags: { analysisEnabled: true, followUpEnabled: true, todoEnabled: true,
      todoMeetingProjectionEnabled: true, uploadEnabled: true, verifierEnabled: true },
    user: { id: ACCOUNT_ID, email: "fixture@example.invalid", name: "匿名验收" }
  }}><WorkWeeklyPage /></WorkReviewContext.Provider>);
  return { items, before, detail, allowed };
}

beforeEach(() => {
  writes.length = 0;
  Object.defineProperty(navigator, "clipboard", { configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(() => { cleanup(); expect(writes).toEqual([]); vi.clearAllMocks(); });

describe("11/11 independent Weekly presentation and copy contract", () => {
  it.each(["复制全文", "只复制决定", "复制待办与等待他人"])(
    "retains the displayed partial warning in %s without publishing rejected or unavailable content", async (button) => {
      const data = createFixture();
      const displayed: WorkWeeklyDisplayedGeneration = { runId: "reviewed_partial_run", runVersion: 1,
        systemVersion: data.review.currentSystemVersion, qualityStatus: "needs_review", reviewIssues: [
          { sourceRef: data.items[0]!.sourceRefs[0]!, reasonCode: "missing_key_content" },
          { sourceRef: null, reasonCode: "source_unavailable" }
        ] };
      show([
        { id: "decision", section: "decisions", systemText: "暂定的范围保持待确认。" },
        { id: "waiting", section: "waiting_for_others", systemText: "外部依赖尚未解除。", userText: "用户保留的依赖说明。", userEditedAt: NOW },
        { id: "hidden", section: "decisions", systemText: "PRIVATE_HIDDEN_TEXT", hiddenAt: NOW },
        { id: "unavailable", section: "decisions", systemText: "PRIVATE_ERASED_TEXT", invalidatedAt: NOW,
          verificationState: "invalidated", sourceRefs: [] }
      ], { displayedGeneration: displayed, reviewStatus: "failed", latestGeneration: {
        runId: "later_failed_run", runVersion: 2, executionStatus: "failed", sourceCheckStatus: "not_established",
        qualityStatus: "not_assessed", reviewIssues: [], displayingPreviousVersion: true, errorCode: "weekly_generation_failed"
      } });
      expect(await screen.findByRole("heading", { name: "已生成，部分内容待核对" })).toBeVisible();
      const expand = screen.getByRole("button", { name: "查看待核对事项（2）" });
      fireEvent.click(expand);
      expect(screen.getByText("这条来源的重要内容尚未完整纳入回顾。")).toBeVisible();
      expect(screen.getByText("原来源已不可用，相关事项仍待核对。")).toBeVisible();
      expect(screen.getByRole("button", { name: "查看事项 1 的原始记录" })).toBeVisible();
      expect(screen.queryByRole("button", { name: "查看事项 2 的原始记录" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: button }));
      await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1));
      const copy = vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0];
      expect(copy).toContain("已生成，部分内容待核对");
      expect(copy).toContain("以下是当前可用内容，仍有缺失或待核对事项。");
      expect(copy).not.toMatch(/PRIVATE_|全稿已核对|完整性已通过/);
      if (button !== "复制待办与等待他人") expect(copy).toContain("暂定的范围保持待确认。");
      if (button !== "只复制决定") expect(copy).toContain("用户保留的依赖说明。");
    }
  );

  it("keeps the current partial assessment when a refresh reports a newer failed attempt", async () => {
    const data = createFixture();
    const displayed: WorkWeeklyDisplayedGeneration = { runId: "current_partial_run", runVersion: 1,
      systemVersion: data.review.currentSystemVersion, qualityStatus: "needs_review", reviewIssues: [
        { sourceRef: data.items[0]!.sourceRefs[0]!, reasonCode: "missing_qualification" }
      ] };
    const state = show([{ id: "kept", section: "decisions", systemText: "已核对的安排仍为暂定。" }], {
      displayedGeneration: displayed, reviewStatus: "queued", latestGeneration: { runId: "later_attempt", runVersion: 2,
        executionStatus: "pending", sourceCheckStatus: "not_established", qualityStatus: "not_assessed",
        reviewIssues: [], displayingPreviousVersion: true, errorCode: null }
    });
    await screen.findByRole("heading", { name: "已生成，部分内容待核对" });
    const refreshed = { ...state.detail, review: { ...state.detail.review, status: "failed" },
      latestGeneration: { runId: "later_attempt", runVersion: 2, executionStatus: "failed", sourceCheckStatus: "not_established",
        qualityStatus: "not_assessed", reviewIssues: [], displayingPreviousVersion: true, errorCode: "weekly_generation_failed" } };
    state.allowed.getWeeklyReview.mockResolvedValue(refreshed);
    state.allowed.getWeeklyReviewDetail.mockResolvedValue(refreshed);
    fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));
    await waitFor(() => expect(state.allowed.getWeeklyReviewDetail).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("heading", { name: "已生成，部分内容待核对" })).toBeVisible();
    expect(screen.getByText("已核对的安排仍为暂定。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "复制全文" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1));
    expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0]).toContain("已生成，部分内容待核对");
  });

  it("shows the suggestion boundary and copies the exact visible system text without changing stored history", async () => {
    const original = "GPT 建议关注：权限范围；依据：首轮关闭，人工运行两次后再评估；未取消。";
    const displayed = "AI建议关注：权限范围；依据：首轮关闭，人工运行两次后再评估；未取消。";
    const state = show([
      { id: "legacy", section: "next_week", systemText: original },
      { id: "decision", section: "decisions", systemText: "暂定只上线每日摘要；最终性未确认。" },
      { id: "hidden", section: "next_week", systemText: "GPT 建议关注：隐藏内容", hiddenAt: NOW },
      { id: "invalid", section: "next_week", systemText: "GPT 建议关注：失效内容",
        verificationState: "invalidated", invalidatedAt: NOW }
    ]);
    expect(await screen.findByRole("heading", { name: "AI建议关注" })).toBeVisible();
    expect(screen.getByText("AI 建议，不是承诺")).toBeVisible();
    const row = screen.getByText(displayed).closest("li")!;
    expect(within(row).getByText("来源已核对")).toBeVisible();
    expect(screen.getByText("来源核对仅检查原始记录是否支持相关表述，不保证内容质量或决定已最终确认；AI 建议不代表承诺。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "复制全文" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1));
    const copy = vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0];
    expect(copy).toContain(`AI建议关注\n- ${displayed}`);
    expect(copy).toContain("- 暂定只上线每日摘要；最终性未确认。");
    expect(copy).not.toMatch(/隐藏内容|失效内容/);
    fireEvent.click(within(row).getByRole("button", { name: "编辑" }));
    expect(screen.getByLabelText("编辑回顾内容")).toHaveValue(displayed);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(JSON.stringify(state.items)).toBe(state.before);
    expect(state.items[0]!.systemText).toBe(original);
  });

  it("preserves user overlays and notes byte for byte, including whitespace and empty edits", async () => {
    const user = "  GPT 建议关注：用户原文\n保留否定、条件与 GPT 字样。  ";
    const note = "GPT 建议关注：个人补充\n尚未承诺。";
    const state = show([
      { id: "edited", section: "next_week", userText: user, userEditedAt: NOW, systemVersion: 1 },
      { id: "note", section: "next_week", origin: "user_note", userText: note,
        systemText: null, verificationState: "user_authored", systemVersion: null },
      { id: "empty", section: "next_week", userText: "", userEditedAt: NOW, systemText: "GPT 建议关注：不得恢复的系统正文" },
      { id: "middle", section: "next_week", systemText: "原文中的 GPT 建议关注：字样保持。" },
      { id: "other", section: "decisions", systemText: "GPT 建议关注：不同区块原文。" }
    ]);
    await screen.findByText("用户编辑");
    const row = screen.getByText("用户编辑").closest("li")!;
    expect(row.querySelector("p")!.textContent).toBe(user);
    expect(screen.getByText("保留的旧版内容")).toBeVisible();
    expect(screen.queryByText(/不得恢复的系统正文/)).not.toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "编辑" }));
    expect(screen.getByLabelText("编辑回顾内容")).toHaveValue(user);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "复制全文" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1));
    const copy = vi.mocked(navigator.clipboard.writeText).mock.calls[0]![0];
    for (const text of [user, note, "原文中的 GPT 建议关注：字样保持。", "GPT 建议关注：不同区块原文。"]) {
      expect(copy).toContain(`- ${text}`);
    }
    expect(copy).not.toContain("不得恢复的系统正文");
    expect(JSON.stringify(state.items)).toBe(state.before);
  });
});
