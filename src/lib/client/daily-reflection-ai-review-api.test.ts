import { describe, expect, it, vi } from "vitest";

import { createDailyReflectionAiReviewApi } from "./daily-reflection-ai-review-api";

const now = "2026-08-24T08:00:00.000Z";

function operation(status: "queued" | "ready" = "queued") {
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
    content: null,
    failureCode: null,
    providerStartedAt: status === "queued" ? null : now,
    completedAt: status === "ready" ? now : null,
    seenAt: null,
    updatedAt: now
  };
}

describe("Daily Reflection AI review client", () => {
  it("uses strict same-origin lookup, ensure, summary and seen contracts", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({
        schemaVersion: 1,
        exposureMode: "shadow",
        scope: "daily",
        referenceDate: "2026-08-24",
        review: operation()
      }))
      .mockResolvedValueOnce(Response.json(operation()))
      .mockResolvedValueOnce(Response.json({
        schemaVersion: 1,
        exposureMode: "on",
        pendingCount: 1,
        unseenReadyCount: 0,
        items: []
      }))
      .mockResolvedValueOnce(Response.json(operation("ready")));
    const api = createDailyReflectionAiReviewApi(fetcher);

    await api.get({ scope: "daily", referenceDate: "2026-08-24" });
    await api.ensure({ scope: "daily", referenceDate: "2026-08-24" });
    await api.getSummary();
    await api.markSeen("review_1");

    expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ["/api/daily-reflections/returns/ai-review?scope=daily&referenceDate=2026-08-24", "GET"],
      ["/api/daily-reflections/returns/ai-review", "POST"],
      ["/api/daily-reflections/returns/ai-review/summary", "GET"],
      ["/api/daily-reflections/returns/ai-review/review_1/seen", "POST"]
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      scope: "daily",
      referenceDate: "2026-08-24"
    });
    expect(fetcher.mock.calls[3]?.[1]?.body).toBeUndefined();
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ cache: "no-store", credentials: "same-origin" });
    }
  });

  it("fails closed on response fields outside the summary contract", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      schemaVersion: 1,
      exposureMode: "on",
      pendingCount: 0,
      unseenReadyCount: 0,
      items: [],
      privateBody: "must not pass"
    }));

    await expect(createDailyReflectionAiReviewApi(fetcher).getSummary())
      .rejects.toMatchObject({ code: "invalid_response" });
  });

  it("preserves abort errors and bounds transport details", async () => {
    const aborter = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("aborted", "AbortError"));
    const offline = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("private endpoint details"));
    const controller = new AbortController();
    controller.abort();

    await expect(createDailyReflectionAiReviewApi(aborter).getSummary(controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    const failure = await createDailyReflectionAiReviewApi(offline).getSummary().catch((error) => error);
    expect(failure).toMatchObject({ code: "network_error", status: 0 });
    expect(String(failure)).not.toContain("private endpoint");
  });
});
