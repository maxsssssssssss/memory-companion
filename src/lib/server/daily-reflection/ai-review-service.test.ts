import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DailyReflectionAiReviewCanonicalSource } from
  "@/lib/domain/daily-reflection-ai-review";
import type { JsonStore } from "@/lib/server/storage/json-store";

import type { DailyReflectionAiReviewContext } from "./ai-review-context";
import {
  DailyReflectionAiReviewNotFoundError,
  DailyReflectionAiReviewService
} from "./ai-review-service";
import type {
  DailyReflectionAiReviewClaim,
  DailyReflectionAiReviewRecord,
  DailyReflectionAiReviewRepository
} from "./ai-review-repository";

const now = "2026-09-01T00:00:00.000Z";
const store = {} as JsonStore;

function source(): DailyReflectionAiReviewCanonicalSource {
  return {
    sourceId: "source_1",
    sourceKind: "open_loop",
    title: "仍值得继续",
    content: "你计划在周五前确认最终安排。",
    memoryIds: ["memory_1"],
    cardIds: ["card_1"],
    recordingDates: ["2026-09-01"],
    evidence: [{
      reflectionId: "reflection_1",
      cardId: "card_1",
      recordingDate: "2026-09-01",
      sourceOrigin: "user_reflection",
      sourceSegmentId: "segment_1",
      startSeconds: 2,
      endSeconds: 4,
      snippet: "周五前确认最终安排"
    }],
    epistemicStatuses: ["explicit_user_statement"]
  };
}

function context(fingerprint = "a".repeat(64)): DailyReflectionAiReviewContext {
  return {
    schemaVersion: 1,
    accountId: "account_1",
    scope: "daily",
    startDate: "2026-09-01",
    endDate: "2026-09-01",
    promptVersion: "daily-reflection-ai-review-v2",
    model: "gpt-5.5",
    sourceFingerprint: fingerprint,
    sources: [source()]
  };
}

const claim: DailyReflectionAiReviewClaim = {
  reviewId: "dr_ai_review_1",
  accountId: "account_1",
  claimToken: "worker:claim_1",
  attemptVersion: 1
};

function record(overrides: Partial<DailyReflectionAiReviewRecord> = {}): DailyReflectionAiReviewRecord {
  return {
    schemaVersion: 1,
    reviewId: "dr_ai_review_1",
    accountId: "account_1",
    scope: "daily",
    startDate: "2026-09-01",
    endDate: "2026-09-01",
    status: "queued",
    sourceFingerprint: "a".repeat(64),
    promptVersion: "daily-reflection-ai-review-v2",
    model: "gpt-5.5",
    content: null,
    failureCode: null,
    claimToken: null,
    leaseUntil: null,
    attemptVersion: 0,
    providerStartedAt: null,
    usage: {
      inputTokenCount: null,
      outputTokenCount: null,
      totalTokenCount: null
    },
    createdAt: now,
    completedAt: null,
    seenAt: null,
    updatedAt: now,
    ...overrides
  };
}

function setup() {
  const repository = {
    ensure: vi.fn(() => ({ record: record(), inserted: true })),
    get: vi.fn((_accountId: string, _reviewId: string): DailyReflectionAiReviewRecord | null =>
      record()
    ),
    getLatest: vi.fn((_input: {
      accountId: string;
      scope: "daily" | "weekly";
      startDate: string;
      endDate: string;
    }): DailyReflectionAiReviewRecord | null => null),
    stale: vi.fn(() => true),
    summary: vi.fn((_accountId: string): {
      pendingCount: number;
      unseenReadyCount: number;
      items: Array<{
        reviewId: string;
        scope: "daily" | "weekly";
        startDate: string;
        endDate: string;
        completedAt: string;
      }>;
    } => ({ pendingCount: 0, unseenReadyCount: 0, items: [] })),
    listUnseenReady: vi.fn((_accountId: string): Array<{
      reviewId: string;
      scope: "daily" | "weekly";
      startDate: string;
      endDate: string;
      completedAt: string;
    }> => []),
    markSeen: vi.fn(() => true),
    claim: vi.fn(() => ({ claimed: true as const, claim, record: record({
      status: "processing",
      claimToken: claim.claimToken,
      attemptVersion: 1
    }) })),
    providerStarted: vi.fn(() => true),
    validating: vi.fn(() => true),
    complete: vi.fn(() => true),
    fail: vi.fn(() => true),
    recoverExpiredLeases: vi.fn(() => ({
      returnedToQueue: 0,
      providerOutcomeUnknown: 0
    })),
    listQueued: vi.fn(() => [])
  };
  const provider = {
    generate: vi.fn(async () => ({
      draft: {
        schemaVersion: 1 as const,
        selectedSourceIds: ["source_1"],
        observations: [{
          sourceIds: ["source_1"],
          interpretation: "这可能是一个仍需收口的事项。",
          followUpQuestion: "现在最小的下一步是什么？"
        }]
      },
      model: "gpt-5.5",
      elapsedMs: 10,
      usage: { outputTokenCount: 20, totalTokenCount: 50 }
    }))
  };
  const dependencies = {
    repository,
    provider,
    mode: vi.fn<() => "off" | "shadow" | "on">(() => "on"),
    getStore: vi.fn(() => store),
    resolveModel: vi.fn(async () => "gpt-5.5"),
    buildContext: vi.fn(() => context()),
    enqueue: vi.fn(async () => ({ jobId: "job_1", enqueued: true }))
  };
  return {
    dependencies,
    provider,
    repository,
    service: new DailyReflectionAiReviewService({
      ...dependencies,
      repository: repository as unknown as DailyReflectionAiReviewRepository
    })
  };
}

describe("Daily Reflection AI review service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fails closed before source reads, writes and queueing when the mode is off", async () => {
    const { dependencies, repository, service } = setup();
    dependencies.mode.mockReturnValue("off");
    await expect(service.ensure({
      accountId: "account_1",
      scope: "daily",
      referenceDate: "2026-09-01"
    })).rejects.toBeInstanceOf(DailyReflectionAiReviewNotFoundError);
    expect(dependencies.buildContext).not.toHaveBeenCalled();
    expect(repository.ensure).not.toHaveBeenCalled();
    expect(dependencies.enqueue).not.toHaveBeenCalled();
  });

  it("persists server-built authority before enqueueing an identifier-only job", async () => {
    const { dependencies, repository, service } = setup();
    const result = await service.ensure({
      accountId: "account_1",
      scope: "daily",
      referenceDate: "2026-09-01"
    });
    expect(repository.ensure).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account_1",
      sourceFingerprint: "a".repeat(64),
      model: "gpt-5.5",
      sources: [source()]
    }));
    expect(dependencies.enqueue).toHaveBeenCalledWith({
      version: 1,
      reviewId: "dr_ai_review_1",
      userRef: "account_1"
    });
    expect(result.review).toMatchObject({ status: "queued", content: null });
  });

  it("checks the fingerprint before Provider and never calls it for stale authority", async () => {
    const { dependencies, provider, repository, service } = setup();
    dependencies.buildContext.mockReturnValue(context("b".repeat(64)));
    await expect(service.process({
      accountId: "account_1",
      reviewId: "dr_ai_review_1",
      workerId: "worker_1"
    })).resolves.toEqual({ status: "stale" });
    expect(repository.stale).toHaveBeenCalledWith("account_1", "dr_ai_review_1");
    expect(repository.providerStarted).not.toHaveBeenCalled();
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("uses a durable Provider-started fence and commits only canonical projection", async () => {
    const { provider, repository, service } = setup();
    await expect(service.process({
      accountId: "account_1",
      reviewId: "dr_ai_review_1",
      workerId: "worker_1"
    })).resolves.toEqual({ status: "ready" });
    expect(repository.providerStarted).toHaveBeenCalledOnce();
    expect(provider.generate).toHaveBeenCalledOnce();
    expect(repository.validating).toHaveBeenCalledOnce();
    expect(repository.complete).toHaveBeenCalledWith(expect.objectContaining({
      claim,
      content: expect.objectContaining({
        selectedSourceIds: ["source_1"],
        canonicalSources: [source()],
        observations: [expect.objectContaining({
          canonicalSources: [source()],
          modelInterpretation: {
            kind: "model_inference",
            text: "这可能是一个仍需收口的事项。"
          },
          followUpQuestion: null
        })]
      }),
      usage: {
        inputTokenCount: 30,
        outputTokenCount: 20,
        totalTokenCount: 50
      }
    }));
  });

  it("does not call Provider when another worker already owns or started the receipt", async () => {
    const { provider, repository, service } = setup();
    repository.providerStarted.mockReturnValueOnce(false);
    await expect(service.process({
      accountId: "account_1",
      reviewId: "dr_ai_review_1",
      workerId: "worker_2"
    })).resolves.toEqual({ status: "superseded" });
    expect(provider.generate).not.toHaveBeenCalled();
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it("discards a late Provider result when source authority changes", async () => {
    const { dependencies, provider, repository, service } = setup();
    dependencies.buildContext
      .mockReturnValueOnce(context())
      .mockReturnValueOnce(context("b".repeat(64)));
    await expect(service.process({
      accountId: "account_1",
      reviewId: "dr_ai_review_1",
      workerId: "worker_1"
    })).resolves.toEqual({ status: "stale" });
    expect(provider.generate).toHaveBeenCalledOnce();
    expect(repository.stale).toHaveBeenCalledWith("account_1", "dr_ai_review_1");
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it("keeps shadow content and unread metadata server-only", async () => {
    const { dependencies, repository, service } = setup();
    dependencies.mode.mockReturnValue("shadow");
    repository.getLatest.mockReturnValue(record({
      status: "ready",
      content: {
        schemaVersion: 1,
        selectedSourceIds: ["source_1"],
        canonicalSources: [source()],
        observations: [{
          sourceIds: ["source_1"],
          canonicalSources: [source()],
          modelInterpretation: { kind: "model_inference", text: "模型推演" },
          followUpQuestion: null
        }]
      },
      completedAt: now
    }));
    repository.get.mockReturnValue(record({
      status: "ready",
      content: {
        schemaVersion: 1,
        selectedSourceIds: ["source_1"],
        canonicalSources: [source()],
        observations: [{
          sourceIds: ["source_1"],
          canonicalSources: [source()],
          modelInterpretation: { kind: "model_inference", text: "模型推演" },
          followUpQuestion: null
        }]
      },
      completedAt: now
    }));
    repository.summary.mockReturnValue({
      pendingCount: 0,
      unseenReadyCount: 1,
      items: [{
        reviewId: "dr_ai_review_1",
        scope: "daily",
        startDate: "2026-09-01",
        endDate: "2026-09-01",
        completedAt: now
      }]
    });
    const lookup = await service.lookup({
      accountId: "account_1",
      scope: "daily",
      referenceDate: "2026-09-01"
    });
    expect(lookup.review).toMatchObject({ status: "ready", content: null });
    await expect(service.summary("account_1")).resolves.toMatchObject({
      exposureMode: "shadow",
      unseenReadyCount: 0,
      items: []
    });
    await expect(service.markSeen("account_1", "dr_ai_review_1"))
      .rejects.toBeInstanceOf(DailyReflectionAiReviewNotFoundError);
  });

  it("exposes validated ready content and unread state only in on mode", async () => {
    const { repository, service } = setup();
    const ready = record({
      status: "ready",
      content: {
        schemaVersion: 1,
        selectedSourceIds: ["source_1"],
        canonicalSources: [source()],
        observations: [{
          sourceIds: ["source_1"],
          canonicalSources: [source()],
          modelInterpretation: {
            kind: "model_inference",
            text: "这可能是一个仍需收口的事项。"
          },
          followUpQuestion: null
        }]
      },
      completedAt: now
    });
    repository.getLatest.mockReturnValue(ready);
    repository.get.mockReturnValue(ready);
    repository.summary.mockReturnValue({
      pendingCount: 0,
      unseenReadyCount: 1,
      items: [{
        reviewId: "dr_ai_review_1",
        scope: "daily",
        startDate: "2026-09-01",
        endDate: "2026-09-01",
        completedAt: now
      }]
    });

    await expect(service.lookup({
      accountId: "account_1",
      scope: "daily",
      referenceDate: "2026-09-01"
    })).resolves.toMatchObject({
      exposureMode: "on",
      review: { status: "ready", content: ready.content }
    });
    await expect(service.summary("account_1")).resolves.toMatchObject({
      exposureMode: "on",
      unseenReadyCount: 1,
      items: [expect.objectContaining({ reviewId: "dr_ai_review_1" })]
    });

    repository.get.mockReturnValue({ ...ready, seenAt: now });
    await expect(service.markSeen("account_1", "dr_ai_review_1"))
      .resolves.toMatchObject({ reviewId: "dr_ai_review_1", seenAt: now });
    expect(repository.markSeen).toHaveBeenCalledWith(
      "account_1",
      "dr_ai_review_1"
    );
  });

  it("stales a pre-safety prompt result before on-mode exposure", async () => {
    const { repository, service } = setup();
    const oldFingerprint = "b".repeat(64);
    repository.getLatest.mockReturnValue(record({
      status: "ready",
      sourceFingerprint: oldFingerprint,
      promptVersion: "daily-reflection-ai-review-v1",
      content: {
        schemaVersion: 1,
        selectedSourceIds: ["source_1"],
        canonicalSources: [source()],
        observations: [{
          sourceIds: ["source_1"],
          canonicalSources: [source()],
          modelInterpretation: {
            kind: "model_inference",
            text: "旧版本模型推演"
          },
          followUpQuestion: null
        }]
      },
      completedAt: now
    }));
    repository.stale.mockImplementation(() => {
      repository.get.mockReturnValue(record({
        status: "stale",
        sourceFingerprint: oldFingerprint,
        promptVersion: "daily-reflection-ai-review-v1",
        content: null,
        completedAt: null
      }));
      return true;
    });

    await expect(service.lookup({
      accountId: "account_1",
      scope: "daily",
      referenceDate: "2026-09-01"
    })).resolves.toMatchObject({
      exposureMode: "on",
      review: { status: "stale", content: null }
    });
    expect(repository.stale).toHaveBeenCalledWith(
      "account_1",
      "dr_ai_review_1"
    );
  });

  it("revalidates canonical authority on lookup and unread-summary reads", async () => {
    const lookupHarness = setup();
    lookupHarness.repository.getLatest.mockReturnValue(record({
      status: "ready",
      completedAt: now
    }));
    lookupHarness.dependencies.buildContext.mockReturnValue(
      context("b".repeat(64))
    );
    await lookupHarness.service.lookup({
      accountId: "account_1",
      scope: "daily",
      referenceDate: "2026-09-01"
    });
    expect(lookupHarness.repository.stale).toHaveBeenCalledWith(
      "account_1",
      "dr_ai_review_1"
    );

    const summaryHarness = setup();
    summaryHarness.dependencies.buildContext.mockReturnValue(
      context("b".repeat(64))
    );
    summaryHarness.repository.get.mockReturnValue(record({
      status: "ready",
      completedAt: now
    }));
    summaryHarness.repository.listUnseenReady.mockReturnValue([{
      reviewId: "dr_ai_review_1",
      scope: "daily",
      startDate: "2026-09-01",
      endDate: "2026-09-01",
      completedAt: now
    }]);
    summaryHarness.repository.summary.mockReturnValue({
      pendingCount: 0,
      unseenReadyCount: 0,
      items: []
    });
    await expect(summaryHarness.service.summary("account_1")).resolves.toMatchObject({
      unseenReadyCount: 0,
      items: []
    });
    expect(summaryHarness.repository.stale).toHaveBeenCalledWith(
      "account_1",
      "dr_ai_review_1"
    );
  });

  it("returns only the strict public operation DTO after marking seen", async () => {
    const { repository, service } = setup();
    repository.get.mockReturnValue(record({
      status: "ready",
      completedAt: now,
      seenAt: now
    }));
    await expect(service.markSeen("account_1", "dr_ai_review_1"))
      .resolves.not.toHaveProperty("accountId");
    await expect(service.markSeen("account_1", "dr_ai_review_1"))
      .resolves.not.toHaveProperty("claimToken");
  });

  it("converts Provider failure into a terminal non-retryable record", async () => {
    const { provider, repository, service } = setup();
    provider.generate.mockRejectedValueOnce(new Error("secret provider body"));
    await expect(service.process({
      accountId: "account_1",
      reviewId: "dr_ai_review_1",
      workerId: "worker_1"
    })).resolves.toEqual({ status: "failed" });
    expect(repository.fail).toHaveBeenCalledWith({
      claim,
      failureCode: "provider_unavailable"
    });
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it("does not claim work while disabled and discards results if disabled in flight", async () => {
    const disabled = setup();
    disabled.dependencies.mode.mockReturnValue("off");
    await expect(disabled.service.process({
      accountId: "account_1",
      reviewId: "dr_ai_review_1",
      workerId: "worker_1"
    })).resolves.toEqual({ status: "disabled" });
    expect(disabled.repository.claim).not.toHaveBeenCalled();
    expect(disabled.provider.generate).not.toHaveBeenCalled();

    const late = setup();
    late.dependencies.mode
      .mockReturnValueOnce("on")
      .mockReturnValueOnce("on")
      .mockReturnValueOnce("off");
    await expect(late.service.process({
      accountId: "account_1",
      reviewId: "dr_ai_review_1",
      workerId: "worker_1"
    })).resolves.toEqual({ status: "stale" });
    expect(late.provider.generate).toHaveBeenCalledOnce();
    expect(late.repository.stale).toHaveBeenCalledWith(
      "account_1",
      "dr_ai_review_1"
    );
    expect(late.repository.complete).not.toHaveBeenCalled();
  });
});
