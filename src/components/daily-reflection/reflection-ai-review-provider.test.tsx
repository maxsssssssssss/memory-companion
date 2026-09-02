import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DailyReflectionAiReviewApi } from "@/lib/client/daily-reflection-ai-review-api";
import type { DailyReflectionAiReviewSummary } from "@/lib/domain/daily-reflection-ai-review";

import { ReflectionAiReviewProvider, useReflectionAiReview } from "./reflection-ai-review-provider";

const completedItem = {
  reviewId: "review_1",
  scope: "daily" as const,
  startDate: "2026-08-24",
  endDate: "2026-08-24",
  completedAt: "2026-08-24T08:00:00.000Z"
};

function Consumer() {
  const { completionNotice, markSeen, summary } = useReflectionAiReview();
  return <div>
    <span>未读 {summary?.unseenReadyCount ?? "-"}</span>
    <span>提示 {completionNotice?.reviewId ?? "无"}</span>
    {completionNotice ? <button onClick={() => void markSeen(completionNotice.reviewId)} type="button">已查看</button> : null}
  </div>;
}

function api(getSummary: DailyReflectionAiReviewApi["getSummary"]): DailyReflectionAiReviewApi {
  return {
    get: vi.fn(),
    ensure: vi.fn(),
    getSummary,
    markSeen: vi.fn(async () => ({
      schemaVersion: 1 as const,
      reviewId: "review_1",
      scope: "daily" as const,
      startDate: "2026-08-24",
      endDate: "2026-08-24",
      status: "ready" as const,
      sourceFingerprint: "a".repeat(64),
      promptVersion: "ai-review-v1",
      model: "configured-model",
      content: null,
      failureCode: null,
      providerStartedAt: "2026-08-24T07:59:00.000Z",
      completedAt: "2026-08-24T08:00:00.000Z",
      seenAt: "2026-08-24T08:01:00.000Z",
      updatedAt: "2026-08-24T08:01:00.000Z"
    }))
  };
}

describe("ReflectionAiReviewProvider", () => {
  it("restores persisted unread state without replaying a completion notification", async () => {
    const reviewApi = api(vi.fn(async () => ({
      schemaVersion: 1 as const,
      exposureMode: "on" as const,
      pendingCount: 0,
      unseenReadyCount: 1,
      items: [completedItem]
    })));
    render(<ReflectionAiReviewProvider accountId="account_1" api={reviewApi}><Consumer /></ReflectionAiReviewProvider>);

    expect(await screen.findByText("未读 1")).toBeVisible();
    expect(screen.getByText("提示 无")).toBeVisible();
  });

  it("announces only a newly completed on-mode review and persists seen through the API", async () => {
    const getSummary = vi.fn()
      .mockResolvedValueOnce({
        schemaVersion: 1 as const,
        exposureMode: "on" as const,
        pendingCount: 1,
        unseenReadyCount: 0,
        items: []
      })
      .mockResolvedValueOnce({
        schemaVersion: 1 as const,
        exposureMode: "on" as const,
        pendingCount: 0,
        unseenReadyCount: 1,
        items: [completedItem]
      })
      .mockResolvedValue({
        schemaVersion: 1 as const,
        exposureMode: "on" as const,
        pendingCount: 0,
        unseenReadyCount: 0,
        items: []
      });
    const reviewApi = api(getSummary);
    render(<ReflectionAiReviewProvider accountId="account_1" api={reviewApi}><Consumer /></ReflectionAiReviewProvider>);
    await waitFor(() => expect(getSummary).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByText("提示 review_1")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "已查看" }));

    await waitFor(() => expect(reviewApi.markSeen).toHaveBeenCalledWith("review_1", expect.any(AbortSignal)));
    expect(await screen.findByText("提示 无")).toBeVisible();
    expect(await screen.findByText("未读 0")).toBeVisible();
  });

  it("keeps shadow completions invisible", async () => {
    const getSummary = vi.fn()
      .mockResolvedValueOnce({
        schemaVersion: 1 as const,
        exposureMode: "shadow" as const,
        pendingCount: 1,
        unseenReadyCount: 0,
        items: []
      })
      .mockResolvedValue({
        schemaVersion: 1 as const,
        exposureMode: "shadow" as const,
        pendingCount: 0,
        unseenReadyCount: 0,
        items: [completedItem]
      });
    render(<ReflectionAiReviewProvider accountId="account_1" api={api(getSummary)}><Consumer /></ReflectionAiReviewProvider>);
    await waitFor(() => expect(getSummary).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(getSummary).toHaveBeenCalledTimes(2));

    expect(screen.getByText("提示 无")).toBeVisible();
    expect(screen.getByText("未读 0")).toBeVisible();
  });

  it("aborts the previous account summary epoch before loading another account", async () => {
    const getSummary = vi.fn((_signal?: AbortSignal) => new Promise<DailyReflectionAiReviewSummary>(() => undefined));
    const reviewApi = api(getSummary);
    const { rerender, unmount } = render(
      <ReflectionAiReviewProvider accountId="account_1" api={reviewApi}><Consumer /></ReflectionAiReviewProvider>
    );
    await waitFor(() => expect(getSummary).toHaveBeenCalledTimes(1));
    const firstSignal = getSummary.mock.calls[0]?.[0];

    rerender(
      <ReflectionAiReviewProvider accountId="account_2" api={reviewApi}><Consumer /></ReflectionAiReviewProvider>
    );
    await waitFor(() => expect(getSummary).toHaveBeenCalledTimes(2));
    expect(firstSignal?.aborted).toBe(true);
    unmount();
  });
});
