// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { createDailyReflectionCandidateRevocationService } from "./candidate-revocation";

const NOW = "2026-08-14T00:00:00.000Z";

function operation(input: {
  status: "ready" | "revoking" | "completed" | "failed";
  attemptVersion?: number;
  indexRefreshStatus?: "not_required" | "pending" | "enqueued" | "failed";
}) {
  return {
    id: "revocation_operation",
    accountId: "account_1",
    reflectionId: "reflection_1",
    confirmationId: "confirmation_1",
    candidateId: "candidate_1",
    operationKey: "candidate_revocation_operation_key",
    idempotencyKey: "request_1",
    requestFingerprint: "a".repeat(64),
    admissionStatus: "admitted" as const,
    memoryId: "memory_1",
    status: input.status,
    attemptVersion: input.attemptVersion ?? 0,
    errorCode: null,
    indexRefreshStatus: input.indexRefreshStatus ?? "not_required",
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: input.status === "completed" ? NOW : null
  };
}

const receipt = {
  accountId: "account_1",
  operationId: "revocation_operation",
  reflectionId: "reflection_1",
  confirmationId: "confirmation_1",
  candidateId: "candidate_1",
  outcome: "revoked" as const,
  memoryId: "memory_1",
  removedMemoryEvidenceCount: 1,
  removedPersonSourceCount: 0,
  createdAt: NOW
};

describe("Daily Reflection candidate revocation service", () => {
  it("recovers after Memory commit before DR receipt and enqueues index refresh once", async () => {
    let attempt = 0;
    let completed = false;
    let indexStatus: "pending" | "enqueued" = "pending";
    const prepareCandidateRevocation = vi.fn(() => completed
      ? { operation: operation({ status: "completed", indexRefreshStatus: indexStatus }), receipt, reused: true }
      : { operation: operation({ status: attempt === 0 ? "ready" : "failed" }), receipt: null, reused: attempt > 0 });
    const startCandidateRevocation = vi.fn(() => {
      attempt += 1;
      return {
        operation: operation({ status: "revoking", attemptVersion: attempt }),
        executionFence: {
          leaseOwner: `lease_${attempt}`,
          leaseUntil: "2026-08-14T00:01:00.000Z",
          attemptVersion: attempt
        },
        reused: false
      };
    });
    const completeCandidateRevocation = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error("simulated crash before DR receipt");
      })
      .mockImplementationOnce(() => {
        completed = true;
        return {
          operation: operation({ status: "completed", attemptVersion: 2, indexRefreshStatus: "pending" }),
          receipt,
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
    const enqueueIndexRefresh = vi.fn(async () => ({ enqueued: true }));
    const service = createDailyReflectionCandidateRevocationService({
      sourceRepository: {
        prepareCandidateRevocation,
        startCandidateRevocation,
        completeCandidateRevocation,
        failCandidateRevocation: vi.fn(),
        setCandidateRevocationIndexRefreshStatus: vi.fn((input) => {
          indexStatus = input.status === "enqueued" ? "enqueued" : "pending";
          return operation({ status: "completed", attemptVersion: 2, indexRefreshStatus: indexStatus });
        }),
        getCandidateRevocationReceipt: vi.fn(() => completed ? receipt : null),
        getRememberedCandidateCount: vi.fn(() => 0)
      },
      memoryRepository: { apply: memoryApply },
      shouldRefreshIndex: () => true,
      enqueueIndexRefresh,
      now: () => NOW,
      idFactory: () => `worker_${attempt + 1}`
    });
    const input = {
      accountId: "account_1",
      reflectionId: "reflection_1",
      candidateId: "candidate_1",
      expectedVersion: 7,
      idempotencyKey: "request_1"
    };

    await expect(service.revoke(input)).rejects.toMatchObject({
      code: "daily_reflection_candidate_revocation_failed"
    });
    await expect(service.revoke(input)).resolves.toMatchObject({
      receipt: { outcome: "revoked" },
      rememberedCount: 0
    });
    await expect(service.revoke(input)).resolves.toMatchObject({ reused: true });

    expect(memoryApply).toHaveBeenCalledTimes(2);
    expect(memoryApply.mock.results[1]!.value).toMatchObject({ reused: true });
    expect(completeCandidateRevocation).toHaveBeenCalledTimes(2);
    expect(enqueueIndexRefresh).toHaveBeenCalledTimes(1);
  });
});
