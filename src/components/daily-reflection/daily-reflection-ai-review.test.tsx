import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DailyReflectionAiReviewApi,
  DailyReflectionAiReviewLookupResponse,
  DailyReflectionAiReviewOperationView
} from "@/lib/client/daily-reflection-ai-review-api";

import { DailyReflectionAiReview } from "./daily-reflection-ai-review";
import { ReflectionAiReviewProvider } from "./reflection-ai-review-provider";

const now = "2026-08-24T08:00:00.000Z";

function operation(
  status: DailyReflectionAiReviewOperationView["status"],
  withContent = status === "ready"
): DailyReflectionAiReviewOperationView {
  const source = {
    sourceId: "source_1",
    sourceKind: "open_loop" as const,
    title: "继续完成小版本",
    content: "先完成可验证的小版本，再决定是否扩大范围。",
    memoryIds: ["memory_1"],
    cardIds: ["card_1"],
    recordingDates: ["2026-08-23"],
    evidence: [{
      reflectionId: "reflection_1",
      cardId: "card_1",
      recordingDate: "2026-08-23",
      sourceOrigin: "user_reflection" as const,
      sourceSegmentId: "segment_1",
      startSeconds: 65,
      endSeconds: 73,
      snippet: "我决定先把小版本做完。"
    }],
    epistemicStatuses: ["explicit_user_statement" as const]
  };
  return {
    schemaVersion: 1,
    reviewId: "review_1",
    scope: "daily",
    startDate: "2026-08-24",
    endDate: "2026-08-24",
    status,
    sourceFingerprint: "a".repeat(64),
    promptVersion: "ai-review-v1",
    model: "configured-model",
    content: withContent ? {
      schemaVersion: 1,
      selectedSourceIds: [source.sourceId],
      canonicalSources: [source],
      observations: [{
        sourceIds: [source.sourceId],
        canonicalSources: [source],
        modelInterpretation: {
          kind: "model_inference",
          text: "你正在用一个可验证的小版本控制扩展范围。"
        },
        followUpQuestion: null
      }]
    } : null,
    failureCode: status === "failed" ? "provider_unavailable" : null,
    providerStartedAt: status === "queued" ? null : now,
    completedAt: status === "ready" || status === "failed" ? now : null,
    seenAt: null,
    updatedAt: now
  };
}

function reviewApi(input: Partial<DailyReflectionAiReviewApi>): DailyReflectionAiReviewApi {
  return {
    get: vi.fn(async () => ({
      schemaVersion: 1 as const,
      exposureMode: "on" as const,
      scope: "daily" as const,
      referenceDate: "2026-08-24",
      review: operation("ready")
    })),
    ensure: vi.fn(async () => operation("queued")),
    getSummary: vi.fn(async () => ({
      schemaVersion: 1 as const,
      exposureMode: "on" as const,
      pendingCount: 0,
      unseenReadyCount: 0,
      items: []
    })),
    markSeen: vi.fn(async () => ({ ...operation("ready"), seenAt: now })),
    ...input
  };
}

function renderReview(api: DailyReflectionAiReviewApi, props: Partial<ComponentProps<typeof DailyReflectionAiReview>> = {}) {
  return render(
    <ReflectionAiReviewProvider accountId="account_1" api={api}>
      <DailyReflectionAiReview
        hasRuleContent
        quickViewOpen={false}
        referenceDate="2026-08-24"
        rules={<p>规则内容立即可读</p>}
        scope="daily"
        {...props}
      />
    </ReflectionAiReviewProvider>
  );
}

describe("DailyReflectionAiReview", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([300, -150])("only preserves a scroll anchor when already reading inside the rules (top=%s)", async (top) => {
    vi.useFakeTimers();
    const scroll = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      top: screen.queryByRole("heading", { name: "AI 深度回看" }) ? top + 400 : top
    } as DOMRect));
    const lookup = (status: DailyReflectionAiReviewOperationView["status"]): DailyReflectionAiReviewLookupResponse => ({
      schemaVersion: 1, exposureMode: "on", scope: "daily", referenceDate: "2026-08-24", review: operation(status)
    });
    const get = vi.fn<DailyReflectionAiReviewApi["get"]>()
      .mockResolvedValueOnce(lookup("processing")).mockResolvedValue(lookup("ready"));
    await act(async () => { renderReview(reviewApi({ get })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(screen.getByRole("heading", { name: "AI 深度回看" })).toBeVisible();
    if (top < 0) {
      expect(scroll).toHaveBeenCalledWith({ behavior: "auto", top: 400 });
      expect(screen.getByText("规则内容立即可读")).toBeVisible();
    } else expect(scroll).not.toHaveBeenCalled();
  });

  it("continues polling after a failed status read and shows ready content without remounting", async () => {
    vi.useFakeTimers();
    const lookup = (status: DailyReflectionAiReviewOperationView["status"]): DailyReflectionAiReviewLookupResponse => ({
      schemaVersion: 1, exposureMode: "on", scope: "daily", referenceDate: "2026-08-24", review: operation(status)
    });
    const get = vi.fn<DailyReflectionAiReviewApi["get"]>()
      .mockResolvedValueOnce(lookup("queued"))
      .mockRejectedValueOnce(new Error("temporary read failure"))
      .mockResolvedValue(lookup("ready"));
    const api = reviewApi({ get });
    await act(async () => { renderReview(api); });
    expect(screen.getByRole("heading", { name: "AI 深度回看正在等待整理" })).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(screen.getByText("暂时没有读到最新回看")).toBeVisible();
    expect(screen.getByText("规则内容立即可读")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(screen.getByRole("heading", { name: "AI 深度回看" })).toBeVisible();
    expect(screen.getByText("你正在用一个可验证的小版本控制扩展范围。")).toBeVisible();
    expect(api.ensure).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("recovers an initial read failure and ignores late errors from an aborted read", async () => {
    vi.useFakeTimers();
    let rejectOld!: (error: Error) => void;
    const get = vi.fn<DailyReflectionAiReviewApi["get"]>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }))
      .mockResolvedValue({ schemaVersion: 1, exposureMode: "on", scope: "daily", referenceDate: "2026-08-24", review: operation("ready") });
    const api = reviewApi({ get });
    await act(async () => { renderReview(api); });
    expect(screen.getByText("暂时没有读到最新回看")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    await act(async () => { fireEvent.focus(window); });
    expect(screen.getByRole("heading", { name: "AI 深度回看" })).toBeVisible();
    await act(async () => { rejectOld(new Error("obsolete read")); });
    expect(screen.queryByText("暂时没有读到最新回看")).not.toBeInTheDocument();
    expect(get.mock.calls[1][1]?.aborted).toBe(true);
  });

  it("keeps rules immediately visible and ensures one real queued review without fake percent", async () => {
    const api = reviewApi({
      get: vi.fn(async () => ({
        schemaVersion: 1 as const,
        exposureMode: "on" as const,
        scope: "daily" as const,
        referenceDate: "2026-08-24",
        review: null
      }))
    });
    const { container } = renderReview(api);

    expect(screen.getByText("规则内容立即可读")).toBeVisible();
    expect(await screen.findByRole("heading", { name: "AI 深度回看正在等待整理" })).toBeVisible();
    expect(api.ensure).toHaveBeenCalledTimes(1);
    expect(api.ensure).toHaveBeenCalledWith(
      { scope: "daily", referenceDate: "2026-08-24" },
      expect.any(AbortSignal)
    );
    expect(container.textContent).not.toContain("%");
  });

  it("upgrades on-mode ready content without a model-authored follow-up and marks it seen", async () => {
    const api = reviewApi({});
    renderReview(api);

    const panel = (await screen.findByRole("heading", { name: "AI 深度回看" })).closest("section") as HTMLElement;
    expect(within(panel).getByText("AI 综合理解 · 不等于你的历史原话")).toBeVisible();
    expect(within(panel).getByText("你正在用一个可验证的小版本控制扩展范围。")).toBeVisible();
    expect(within(panel).queryByText("什么结果会让你愿意扩大范围？"))
      .not.toBeInTheDocument();
    fireEvent.click(within(panel).getByText("1 条已核对来源"));
    expect(within(panel).getByText("我决定先把小版本做完。")).toBeVisible();
    expect(within(panel).getByRole("link", { name: "查看原话" }))
      .toHaveAttribute("href", "/reflection/sessions/reflection_1?segment=segment_1");

    const quickRules = screen.getByText("查看快速回看").closest("details") as HTMLDetailsElement;
    await waitFor(() => expect(quickRules).not.toHaveAttribute("open"));
    fireEvent.click(screen.getByText("查看快速回看"));
    expect(screen.getByText("规则内容立即可读")).toBeVisible();
    await waitFor(() => expect(api.markSeen).toHaveBeenCalledWith("review_1", expect.any(AbortSignal)));
  });

  it("does not collapse the quick rule review while its evidence view is open", async () => {
    const api = reviewApi({});
    renderReview(api, { quickViewOpen: true });

    await screen.findByRole("heading", { name: "AI 深度回看" });
    const quickRules = screen.getByText("查看快速回看").closest("details") as HTMLDetailsElement;
    expect(quickRules).toHaveAttribute("open");
    expect(screen.getByText("规则内容立即可读")).toBeVisible();
  });

  it("aborts an obsolete date epoch and ignores its late ready result", async () => {
    let releaseOld!: (value: DailyReflectionAiReviewLookupResponse) => void;
    const oldLookup = new Promise<DailyReflectionAiReviewLookupResponse>((resolve) => {
      releaseOld = resolve;
    });
    const get = vi.fn<DailyReflectionAiReviewApi["get"]>((input) => input.referenceDate === "2026-08-23"
      ? oldLookup
      : Promise.resolve({
        schemaVersion: 1,
        exposureMode: "on",
        scope: "daily",
        referenceDate: input.referenceDate,
        review: operation("failed")
      }));
    const api = reviewApi({ get });
    const view = (referenceDate: string) => (
      <ReflectionAiReviewProvider accountId="account_1" api={api}>
        <DailyReflectionAiReview
          hasRuleContent
          quickViewOpen={false}
          referenceDate={referenceDate}
          rules={<p>规则内容立即可读</p>}
          scope="daily"
        />
      </ReflectionAiReviewProvider>
    );
    const { rerender } = render(view("2026-08-23"));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    const oldSignal = get.mock.calls[0]?.[1];

    rerender(view("2026-08-24"));
    expect(await screen.findByRole("heading", { name: "这次 AI 深度回看暂时没有生成" })).toBeVisible();
    expect(oldSignal?.aborted).toBe(true);

    await act(async () => {
      releaseOld({
        schemaVersion: 1,
        exposureMode: "on",
        scope: "daily",
        referenceDate: "2026-08-23",
        review: operation("ready")
      });
      await Promise.resolve();
    });
    expect(screen.queryByRole("heading", { name: "AI 深度回看" })).not.toBeInTheDocument();
  });

  it("never exposes or marks shadow content and keeps failed on-mode results behind rules", async () => {
    const shadowApi = reviewApi({
      get: vi.fn(async () => ({
        schemaVersion: 1 as const,
        exposureMode: "shadow" as const,
        scope: "daily" as const,
        referenceDate: "2026-08-24",
        review: operation("ready", false)
      }))
    });
    const { unmount } = renderReview(shadowApi);
    await waitFor(() => expect(shadowApi.get).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("heading", { name: "AI 深度回看" })).not.toBeInTheDocument();
    expect(shadowApi.markSeen).not.toHaveBeenCalled();
    expect(screen.getByText("规则内容立即可读")).toBeVisible();
    unmount();

    const onNullApi = reviewApi({
      get: vi.fn(async () => ({
        schemaVersion: 1 as const,
        exposureMode: "on" as const,
        scope: "daily" as const,
        referenceDate: "2026-08-24",
        review: operation("ready", false)
      }))
    });
    const onNull = renderReview(onNullApi);
    await waitFor(() => expect(onNullApi.get).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("heading", { name: "AI 深度回看" })).not.toBeInTheDocument();
    expect(onNullApi.markSeen).not.toHaveBeenCalled();
    expect(screen.getByText("规则内容立即可读")).toBeVisible();
    onNull.unmount();

    const noRulesApi = reviewApi({});
    const noRules = renderReview(noRulesApi, { hasRuleContent: false });
    await waitFor(() => expect(noRulesApi.get).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("heading", { name: "AI 深度回看" })).not.toBeInTheDocument();
    expect(noRulesApi.ensure).not.toHaveBeenCalled();
    expect(noRulesApi.markSeen).not.toHaveBeenCalled();
    noRules.unmount();

    const failedApi = reviewApi({
      get: vi.fn(async () => ({
        schemaVersion: 1 as const,
        exposureMode: "on" as const,
        scope: "daily" as const,
        referenceDate: "2026-08-24",
        review: operation("failed")
      }))
    });
    renderReview(failedApi);
    expect(await screen.findByText("这次 AI 深度回看暂时没有生成")).toBeVisible();
    expect(screen.getByText("规则内容立即可读")).toBeVisible();
    expect(failedApi.markSeen).not.toHaveBeenCalled();
  });
});
