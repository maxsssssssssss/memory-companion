// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { DailyReflectionMemoryCandidateRevocationError } from
  "@/lib/server/memory/daily-reflection-candidate-revocation";

import { createDailyReflectionWorkingCardMemoryRevocationService } from
  "./working-card-memory-revocation-service";

const NOW = "2026-08-24T08:00:00.000Z";

function card(status: "revocation_requested" | "revoked") {
  return {
    id: "card_1",
    accountId: "account_1",
    sourceReflectionIds: ["reflection_1"],
    title: "长期偏好",
    content: "我平时更喜欢安静的位置。",
    cardKind: "insight" as const,
    evidenceIds: ["segment_1"],
    status: "saved" as const,
    importance: 0.9,
    novelty: 0.8,
    relatedCardIds: [],
    tags: [],
    visibility: "private" as const,
    sourceUnavailable: false,
    memoryLifecycleStatus: status,
    memoryLifecycleVersion: status === "revoked" ? 2 : 1,
    memoryLifecycleUpdatedAt: NOW,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW
  };
}

function operation(input: {
  status: "ready" | "revoking" | "completed" | "failed";
  attemptVersion?: number;
  authority?: boolean;
  indexRefreshStatus?: "not_required" | "pending" | "enqueued" | "failed";
}) {
  const authority = input.authority ?? false;
  return {
    id: "card_revocation_operation",
    accountId: "account_1",
    cardId: "card_1",
    reflectionId: "reflection_1",
    proposalId: authority ? "proposal_1" : null,
    authorityConfirmationId: authority ? "proposal_1" : null,
    authorityMemoryId: authority ? "memory_1" : null,
    operationKey: "daily-reflection-card-revocation:card_1",
    idempotencyKey: "revoke_card_1",
    requestFingerprint: "a".repeat(64),
    requestedMemoryLifecycleVersion: authority ? 1 : 0,
    status: input.status,
    attemptVersion: input.attemptVersion ?? 0,
    indexRefreshStatus: input.indexRefreshStatus ?? "not_required",
    errorCode: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: input.status === "completed" ? NOW : null
  };
}

function receipt(outcome: "revoked" | "no_long_term_object") {
  return {
    cardId: "card_1",
    proposalId: outcome === "revoked" ? "proposal_1" : null,
    outcome,
    historicalMemoryId: outcome === "revoked" ? "memory_1" : null,
    removedMemoryEvidenceCount: outcome === "revoked" ? 1 : 0,
    removedPersonSourceCount: 0,
    createdAt: NOW
  };
}

const authority = {
  reflectionId: "reflection_1",
  confirmationId: "proposal_1",
  candidateId: "card_1",
  currentMemoryId: "memory_1",
  publicationStatus: "unpublished" as const
};

describe("Daily Reflection Working Card Memory revocation service", () => {
  it("revokes a Card with no Memory without calling the Memory repository", async () => {
    const memoryApply = vi.fn();
    const complete = vi.fn((input) => ({
      operation: operation({ status: "completed", attemptVersion: 1 }),
      receipt: receipt("no_long_term_object"),
      card: card("revoked"),
      reused: false,
      completedInput: input
    }));
    const sourceRepository = {
      get: vi.fn(),
      prepare: vi.fn(() => ({
        operation: operation({ status: "ready" }),
        receipt: null,
        card: card("revocation_requested"),
        reused: false
      })),
      start: vi.fn(() => ({
        operation: operation({ status: "revoking", attemptVersion: 1 }),
        executionFence: { leaseOwner: "worker_1", attemptVersion: 1 },
        reused: false
      })),
      complete,
      fail: vi.fn(),
      setIndexRefreshStatus: vi.fn()
    };
    const service = createDailyReflectionWorkingCardMemoryRevocationService({
      sourceRepository: sourceRepository as never,
      memoryRepository: {
        findActiveAuthority: vi.fn(() => null),
        apply: memoryApply
      },
      shouldRefreshIndex: () => false,
      enqueueIndexRefresh: vi.fn(),
      now: () => NOW,
      idFactory: () => "worker_1"
    });

    await expect(service.revoke({
      accountId: "account_1",
      cardId: "card_1",
      expectedMemoryLifecycleVersion: 0,
      idempotencyKey: "revoke_card_1"
    })).resolves.toMatchObject({
      receipt: { outcome: "no_long_term_object" },
      card: { memoryLifecycleStatus: "revoked" }
    });
    expect(memoryApply).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      result: {
        outcome: "no_long_term_object",
        historicalMemoryId: null,
        removedMemoryEvidenceCount: 0,
        removedPersonSourceCount: 0
      },
      indexRefreshRequired: false
    }));
  });

  it("propagates an admitted unpublished authority through Existing Memory revocation", async () => {
    const memoryApply = vi.fn(() => ({
      outcome: "revoked" as const,
      historicalMemoryId: "memory_1",
      removedMemoryEvidenceCount: 1,
      removedPersonSourceCount: 0,
      reused: false
    }));
    const complete = vi.fn(() => ({
      operation: operation({
        status: "completed",
        attemptVersion: 1,
        authority: true,
        indexRefreshStatus: "pending"
      }),
      receipt: receipt("revoked"),
      card: card("revoked"),
      reused: false
    }));
    const setIndexRefreshStatus = vi.fn(() => operation({
      status: "completed",
      attemptVersion: 1,
      authority: true,
      indexRefreshStatus: "enqueued"
    }));
    const enqueueIndexRefresh = vi.fn(async () => ({ enqueued: true }));
    const service = createDailyReflectionWorkingCardMemoryRevocationService({
      sourceRepository: {
        get: vi.fn(),
        prepare: vi.fn(() => ({
          operation: operation({ status: "ready", authority: true }),
          receipt: null,
          card: card("revocation_requested"),
          reused: false
        })),
        start: vi.fn(() => ({
          operation: operation({ status: "revoking", attemptVersion: 1, authority: true }),
          executionFence: { leaseOwner: "worker_1", attemptVersion: 1 },
          reused: false
        })),
        complete,
        fail: vi.fn(),
        setIndexRefreshStatus
      } as never,
      memoryRepository: {
        findActiveAuthority: vi.fn(() => authority),
        apply: memoryApply
      },
      shouldRefreshIndex: () => true,
      enqueueIndexRefresh,
      now: () => NOW,
      idFactory: () => "worker_1"
    });

    await expect(service.revoke({
      accountId: "account_1",
      cardId: "card_1",
      expectedMemoryLifecycleVersion: 1,
      idempotencyKey: "revoke_card_1"
    })).resolves.toMatchObject({
      receipt: { outcome: "revoked", historicalMemoryId: "memory_1" },
      operation: { indexRefreshStatus: "enqueued" }
    });
    expect(memoryApply).toHaveBeenCalledOnce();
    expect(memoryApply).toHaveBeenCalledWith(expect.objectContaining({
      userId: "account_1",
      reflectionId: "reflection_1",
      confirmationId: "proposal_1",
      candidateId: "card_1",
      operationKey: "daily-reflection-card-revocation:card_1"
    }));
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      result: {
        outcome: "revoked",
        historicalMemoryId: "memory_1",
        removedMemoryEvidenceCount: 1,
        removedPersonSourceCount: 0
      },
      indexRefreshRequired: true
    }));
    expect(enqueueIndexRefresh).toHaveBeenCalledOnce();
    expect(setIndexRefreshStatus).toHaveBeenCalledWith(expect.objectContaining({
      status: "enqueued"
    }));
  });

  it("recovers response loss by reusing the Memory result and emits one DR receipt", async () => {
    let attempt = 0;
    let completed = false;
    let indexStatus: "pending" | "enqueued" = "pending";
    const prepare = vi.fn(() => completed
      ? {
          operation: operation({
            status: "completed",
            attemptVersion: 2,
            authority: true,
            indexRefreshStatus: indexStatus
          }),
          receipt: receipt("revoked"),
          card: card("revoked"),
          reused: true
        }
      : {
          operation: operation({
            status: attempt === 0 ? "ready" : "failed",
            attemptVersion: attempt,
            authority: true
          }),
          receipt: null,
          card: card("revocation_requested"),
          reused: attempt > 0
        });
    const start = vi.fn(() => {
      attempt += 1;
      return {
        operation: operation({ status: "revoking", attemptVersion: attempt, authority: true }),
        executionFence: { leaseOwner: `worker_${attempt}`, attemptVersion: attempt },
        reused: false
      };
    });
    const complete = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("simulated response loss after Memory commit");
      })
      .mockImplementationOnce(() => {
        completed = true;
        return {
          operation: operation({
            status: "completed",
            attemptVersion: 2,
            authority: true,
            indexRefreshStatus: "pending"
          }),
          receipt: receipt("revoked"),
          card: card("revoked"),
          reused: false
        };
      });
    const memoryApply = vi.fn()
      .mockReturnValueOnce({
        outcome: "revoked",
        historicalMemoryId: "memory_1",
        removedMemoryEvidenceCount: 1,
        removedPersonSourceCount: 0,
        reused: false
      })
      .mockReturnValueOnce({
        outcome: "revoked",
        historicalMemoryId: "memory_1",
        removedMemoryEvidenceCount: 1,
        removedPersonSourceCount: 0,
        reused: true
      });
    const fail = vi.fn();
    const enqueueIndexRefresh = vi.fn(async () => ({ enqueued: true }));
    const service = createDailyReflectionWorkingCardMemoryRevocationService({
      sourceRepository: {
        get: vi.fn(() => completed ? {
          operation: operation({
            status: "completed",
            attemptVersion: 2,
            authority: true,
            indexRefreshStatus: indexStatus
          }),
          receipt: receipt("revoked"),
          card: card("revoked")
        } : null),
        prepare,
        start,
        complete,
        fail,
        setIndexRefreshStatus: vi.fn((input) => {
          indexStatus = input.status === "enqueued" ? "enqueued" : "pending";
          return operation({
            status: "completed",
            attemptVersion: 2,
            authority: true,
            indexRefreshStatus: indexStatus
          });
        })
      } as never,
      memoryRepository: {
        findActiveAuthority: vi.fn()
          .mockReturnValueOnce(authority)
          .mockReturnValue(null),
        apply: memoryApply
      },
      shouldRefreshIndex: () => true,
      enqueueIndexRefresh,
      now: () => NOW,
      idFactory: () => `worker_${attempt + 1}`
    });
    const input = {
      accountId: "account_1",
      cardId: "card_1",
      expectedMemoryLifecycleVersion: 1,
      idempotencyKey: "revoke_card_1"
    };

    await expect(service.revoke(input)).rejects.toMatchObject({
      code: "daily_reflection_card_memory_revocation_failed"
    });
    await expect(service.revoke(input)).resolves.toMatchObject({
      reused: true,
      receipt: { outcome: "revoked" }
    });
    await expect(service.revoke(input)).resolves.toMatchObject({
      reused: true,
      receipt: { outcome: "revoked" }
    });
    expect(memoryApply).toHaveBeenCalledTimes(2);
    expect(memoryApply.mock.results[1]!.value).toMatchObject({ reused: true });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "daily_reflection_card_memory_revocation_receipt_failed"
    }));
    expect(enqueueIndexRefresh).toHaveBeenCalledOnce();
  });

  it("does not resurrect a tombstoned Memory when its authority disappears", async () => {
    const complete = vi.fn(() => ({
      operation: operation({ status: "completed", attemptVersion: 1, authority: true }),
      receipt: receipt("no_long_term_object"),
      card: card("revoked"),
      reused: false
    }));
    const memoryApply = vi.fn(() => {
      throw new DailyReflectionMemoryCandidateRevocationError(
        "daily_reflection_candidate_revocation_upload_deleted"
      );
    });
    const service = createDailyReflectionWorkingCardMemoryRevocationService({
      sourceRepository: {
        get: vi.fn(),
        prepare: vi.fn(() => ({
          operation: operation({ status: "ready", authority: true }),
          receipt: null,
          card: card("revocation_requested"),
          reused: false
        })),
        start: vi.fn(() => ({
          operation: operation({ status: "revoking", attemptVersion: 1, authority: true }),
          executionFence: { leaseOwner: "worker_1", attemptVersion: 1 },
          reused: false
        })),
        complete,
        fail: vi.fn(),
        setIndexRefreshStatus: vi.fn()
      } as never,
      memoryRepository: {
        findActiveAuthority: vi.fn()
          .mockReturnValueOnce(authority)
          .mockReturnValueOnce(null),
        apply: memoryApply
      },
      shouldRefreshIndex: () => false,
      enqueueIndexRefresh: vi.fn(),
      now: () => NOW,
      idFactory: () => "worker_1"
    });

    await expect(service.revoke({
      accountId: "account_1",
      cardId: "card_1",
      expectedMemoryLifecycleVersion: 1,
      idempotencyKey: "revoke_card_1"
    })).resolves.toMatchObject({
      receipt: { outcome: "no_long_term_object", historicalMemoryId: null }
    });
    expect(memoryApply).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      result: {
        outcome: "no_long_term_object",
        historicalMemoryId: null,
        removedMemoryEvidenceCount: 0,
        removedPersonSourceCount: 0
      }
    }));
  });
});
