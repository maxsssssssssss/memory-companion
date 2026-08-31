import { describe, expect, it, vi } from "vitest";

import {
  createDailyReflectionMemoryProposalFinalizeService,
  DailyReflectionMemoryProposalConfirmationRequiredError
} from
  "./memory-proposal-finalize-service";

const NOW = "2026-08-25T08:00:00.000Z";

type SnapshotKind = "insight" | "open_question" | "decision" | "user_action";
type ProposalType =
  | "summary"
  | "question"
  | "decision"
  | "commitment";

function snapshot(
  candidateId: string,
  candidateKind: SnapshotKind,
  actionClaimed = false
) {
  return {
    contractVersion: 2 as const,
    candidateId,
    proposedText: `text for ${candidateId}`,
    userText: null,
    finalText: `text for ${candidateId}`,
    status: "kept" as const,
    candidateKind,
    candidateType: candidateKind === "open_question"
      ? "question" as const
      : candidateKind === "user_action" && actionClaimed
        ? "commitment" as const
        : "summary" as const,
    evidenceIds: [`segment_${candidateId}`],
    sourceSegmentIds: [`segment_${candidateId}`],
    evidenceSnapshots: [{
      sourceSegmentId: `segment_${candidateId}`,
      uploadId: "upload_1",
      startSeconds: 0,
      endSeconds: 10,
      text: `evidence for ${candidateId}`,
      effectiveOrigin: "user_reflection" as const
    }],
    confidence: 0.9,
    caution: "explicit user statement",
    actionClaimed,
    subjectPersonId: null
  };
}

function confirmation(snapshots: ReturnType<typeof snapshot>[]) {
  return {
    contractVersion: 2 as const,
    id: "confirmation_1",
    reflectionId: "reflection_1",
    accountId: "account_1",
    fingerprint: "a".repeat(64),
    requestFingerprint: "b".repeat(64),
    idempotencyKey: "operation_1",
    operationKey: "operation_1",
    sourceOrigin: "user_reflection" as const,
    inputMethod: "file_upload" as const,
    processingProfile: "full_recording" as const,
    inputAdapter: "file_picker" as const,
    capturePurpose: "inspiration_capture" as const,
    recordingDate: "2026-08-25",
    saveIntent: "retain_selected" as const,
    candidateSnapshots: snapshots,
    createdAt: NOW
  };
}

function outerOperation(status: string, attemptVersion = 1) {
  return {
    id: "outer_operation_1",
    reflectionId: "reflection_1",
    confirmationId: "confirmation_1",
    accountId: "account_1",
    status,
    executionMethod: "memory_proposal_v1",
    admittedCount: 0,
    rejectedCount: 0,
    excludedCount: 0,
    errorCode: null,
    leaseOwner: null,
    leaseUntil: null,
    attemptVersion,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: status === "completed" ? NOW : null
  };
}

function proposal(
  cardId: string,
  memoryType: ProposalType,
  status: "pending" | "rejected" | "admitted" = "pending"
) {
  return {
    id: `proposal_${cardId}`,
    cardId,
    reflectionId: "reflection_1",
    accountId: "account_1",
    title: `title for ${cardId}`,
    cardKind: cardId.includes("action") ? "action" : "insight",
    actionClaimed: false,
    memoryType,
    content: `content for ${cardId}`,
    evidenceIds: [`segment_${cardId}`],
    evidenceSnapshots: [],
    riskFlags: [],
    subjectPersonId: null,
    importance: 0.9,
    durability: 0.9,
    novelty: 0.9,
    sensitivity: 0,
    epistemicStatus: "explicit_user_statement",
    epistemicCaution: null,
    status,
    policyVersion: "test_policy_v1",
    score: status === "rejected" ? 0 : 0.9,
    reasons: status === "rejected" ? ["action_not_claimed"] : [],
    operationKey: `daily-reflection-card:${cardId}`,
    requestFingerprint: "c".repeat(64),
    memoryId: status === "admitted" ? `memory_${cardId}` : null,
    sourceOrigin: "user_reflection",
    inputAdapter: "file_picker",
    capturePurpose: "inspiration_capture",
    recordingDate: "2026-08-25",
    createdBy: "user",
    admissionMethod: "daily_reflection_memory_proposal_v1",
    cardVersion: 1,
    version: status === "pending" ? 0 : 1,
    createdAt: NOW,
    updatedAt: NOW,
    admittedAt: status === "admitted" ? NOW : null
  };
}

function serviceInput() {
  return {
    accountId: "account_1",
    reflectionId: "reflection_1",
    leaseOwner: "outer_worker_1",
    leaseDurationMs: 60_000
  };
}

describe("Daily Reflection Memory Proposal finalize service", () => {
  it("maps all four retained Card kinds to the authoritative Proposal types", async () => {
    const snapshots = [
      snapshot("card_question", "open_question"),
      snapshot("card_action", "user_action", true),
      snapshot("card_insight", "insight"),
      snapshot("card_decision", "decision")
    ];
    const proposals = new Map<string, ReturnType<typeof proposal>>();
    const create = vi.fn((input: {
      cardId: string;
      memoryType: ProposalType;
    }) => {
      const created = proposal(input.cardId, input.memoryType);
      proposals.set(input.cardId, created);
      return { proposal: created, reused: false };
    });
    const admit = vi.fn(async (input: {
      proposalId: string;
      deferPublication: boolean;
    }) => {
      const cardId = input.proposalId.replace(/^proposal_/u, "");
      const pending = proposals.get(cardId)!;
      const admitted = proposal(cardId, pending.memoryType, "admitted");
      proposals.set(cardId, admitted);
      return {
        status: "admitted" as const,
        proposal: admitted,
        memoryId: admitted.memoryId,
        reasons: []
      };
    });
    const completeAdmissionOperation = vi.fn((input: {
      results: unknown[];
    }) => ({
      operation: outerOperation("completed"),
      results: input.results,
      reused: false
    }));
    const publish = vi.fn(async () => undefined);
    const repository = {
      getAdmissionExecutionMethod: vi.fn(() => "memory_proposal_v1"),
      startAdmissionOperation: vi.fn(() => ({
        operation: outerOperation("admitting"),
        executionFence: { leaseOwner: "outer_worker_1", attemptVersion: 1 },
        reused: false
      })),
      getConfirmation: vi.fn(() => confirmation(snapshots)),
      getWorkingCard: vi.fn(() => ({ version: 1 })),
      completeAdmissionOperation,
      failAdmissionOperation: vi.fn(),
      getAdmissionOperation: vi.fn(),
      listAdmissionResults: vi.fn()
    };
    const proposalService = {
      create,
      admit,
      getByCard: vi.fn((_accountId: string, cardId: string) => proposals.get(cardId)),
      publish
    };
    const service = createDailyReflectionMemoryProposalFinalizeService({
      repository: repository as never,
      proposalService: proposalService as never,
      now: () => NOW
    });

    const result = await service.admitUnderLease(serviceInput());

    expect(create.mock.calls.map(([input]) => [input.cardId, input.memoryType])).toEqual([
      ["card_action", "commitment"],
      ["card_decision", "decision"],
      ["card_insight", "summary"],
      ["card_question", "question"]
    ]);
    expect(admit).toHaveBeenCalledTimes(4);
    expect(admit.mock.calls.every(([input]) => input.deferPublication === true)).toBe(true);
    expect(result.results).toEqual([
      expect.objectContaining({ candidateId: "card_action", status: "admitted" }),
      expect.objectContaining({ candidateId: "card_decision", status: "admitted" }),
      expect.objectContaining({ candidateId: "card_insight", status: "admitted" }),
      expect.objectContaining({ candidateId: "card_question", status: "admitted" })
    ]);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.invocationCallOrder[0]).toBeLessThan(
      completeAdmissionOperation.mock.invocationCallOrder[0]!
    );
  });

  it("projects an unclaimed action policy rejection without a Durable Memory result", async () => {
    const action = snapshot("card_action", "user_action", false);
    const pending = proposal("card_action", "commitment");
    const rejected = proposal("card_action", "commitment", "rejected");
    const completeAdmissionOperation = vi.fn((input: { results: unknown[] }) => ({
      operation: outerOperation("completed"),
      results: input.results,
      reused: false
    }));
    const publish = vi.fn(async () => undefined);
    const repository = {
      getAdmissionExecutionMethod: vi.fn(() => "memory_proposal_v1"),
      startAdmissionOperation: vi.fn(() => ({
        operation: outerOperation("admitting"),
        executionFence: { leaseOwner: "outer_worker_1", attemptVersion: 1 },
        reused: false
      })),
      getConfirmation: vi.fn(() => confirmation([action])),
      getWorkingCard: vi.fn(() => ({ version: 1 })),
      completeAdmissionOperation,
      failAdmissionOperation: vi.fn(),
      getAdmissionOperation: vi.fn(),
      listAdmissionResults: vi.fn()
    };
    const proposalService = {
      create: vi.fn(() => ({ proposal: pending, reused: false })),
      admit: vi.fn(async () => ({
        status: "rejected" as const,
        proposal: rejected,
        memoryId: null,
        reasons: ["action_not_claimed"]
      })),
      getByCard: vi.fn(),
      publish
    };
    const service = createDailyReflectionMemoryProposalFinalizeService({
      repository: repository as never,
      proposalService: proposalService as never,
      now: () => NOW
    });

    const result = await service.admitUnderLease(serviceInput());

    expect(proposalService.create).toHaveBeenCalledWith(expect.objectContaining({
      cardId: "card_action",
      memoryType: "commitment"
    }));
    expect(result.results).toEqual([{
      candidateId: "card_action",
      status: "rejected",
      memoryId: null,
      reasonCode: "action_not_claimed",
      errorCode: null,
      operationKey: "daily-reflection-card:card_action",
      updatedAt: NOW
    }]);
    expect(publish).not.toHaveBeenCalled();
    expect(repository.failAdmissionOperation).not.toHaveBeenCalled();
  });

  it("treats explicit long-term selection as acknowledgement of ordinary soft requirements", async () => {
    const insight = snapshot("card_insight", "insight");
    const pending = proposal("card_insight", "summary");
    const awaitingConfirmation = {
      ...pending,
      version: 1,
      reasons: [
        "confirmation_required:acknowledge_attribution_uncertainty",
        "confirmation_required:acknowledge_inference",
        "confirmation_required:acknowledge_sensitive_content"
      ]
    };
    const admitted = proposal("card_insight", "summary", "admitted");
    const failAdmissionOperation = vi.fn();
    const completeAdmissionOperation = vi.fn((input: { results: unknown[] }) => ({
      operation: outerOperation("completed"),
      results: input.results,
      reused: false
    }));
    const repository = {
      getAdmissionExecutionMethod: vi.fn(() => "memory_proposal_v1"),
      startAdmissionOperation: vi.fn(() => ({
        operation: outerOperation("admitting"),
        executionFence: { leaseOwner: "outer_worker_1", attemptVersion: 1 },
        reused: false
      })),
      getConfirmation: vi.fn(() => confirmation([insight])),
      getWorkingCard: vi.fn(() => ({ version: 1 })),
      completeAdmissionOperation,
      failAdmissionOperation,
      getAdmissionOperation: vi.fn(),
      listAdmissionResults: vi.fn()
    };
    const proposalService = {
      create: vi.fn(() => ({ proposal: pending, reused: false })),
      admit: vi.fn()
        .mockResolvedValueOnce({
          status: "needs_confirmation" as const,
          proposal: awaitingConfirmation,
          memoryId: null,
          reasons: awaitingConfirmation.reasons,
          confirmationRequirements: [
            {
              code: "acknowledge_attribution_uncertainty" as const,
              resolution: "acknowledgement" as const
            },
            {
              code: "acknowledge_inference" as const,
              resolution: "acknowledgement" as const
            },
            {
              code: "acknowledge_sensitive_content" as const,
              resolution: "acknowledgement" as const
            }
          ]
        })
        .mockResolvedValueOnce({
          status: "admitted" as const,
          proposal: admitted,
          memoryId: admitted.memoryId,
          reasons: [],
          confirmationRequirements: []
        }),
      getByCard: vi.fn(() => admitted),
      publish: vi.fn(async () => undefined)
    };
    const service = createDailyReflectionMemoryProposalFinalizeService({
      repository: repository as never,
      proposalService: proposalService as never,
      now: () => NOW
    });

    const result = await service.admitUnderLease(serviceInput());

    expect(result.results).toEqual([
      expect.objectContaining({ candidateId: "card_insight", status: "admitted" })
    ]);
    expect(proposalService.admit).toHaveBeenCalledTimes(2);
    expect(proposalService.admit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      proposalId: awaitingConfirmation.id,
      expectedVersion: awaitingConfirmation.version,
      acknowledgements: [
        "acknowledge_attribution_uncertainty",
        "acknowledge_inference",
        "acknowledge_sensitive_content"
      ],
      deferPublication: true
    }));
    expect(completeAdmissionOperation).toHaveBeenCalledOnce();
    expect(failAdmissionOperation).not.toHaveBeenCalled();
    expect(proposalService.publish).toHaveBeenCalledOnce();
  });

  it("keeps verified-owner requirements fail-closed", async () => {
    const insight = snapshot("card_insight", "insight");
    const pending = proposal("card_insight", "summary");
    const failAdmissionOperation = vi.fn();
    const repository = {
      getAdmissionExecutionMethod: vi.fn(() => "memory_proposal_v1"),
      startAdmissionOperation: vi.fn(() => ({
        operation: outerOperation("admitting"),
        executionFence: { leaseOwner: "outer_worker_1", attemptVersion: 1 },
        reused: false
      })),
      getConfirmation: vi.fn(() => confirmation([insight])),
      getWorkingCard: vi.fn(() => ({ version: 1 })),
      completeAdmissionOperation: vi.fn(),
      failAdmissionOperation,
      getAdmissionOperation: vi.fn(),
      listAdmissionResults: vi.fn()
    };
    const proposalService = {
      create: vi.fn(() => ({ proposal: pending, reused: false })),
      admit: vi.fn(async () => ({
        status: "needs_confirmation" as const,
        proposal: pending,
        memoryId: null,
        reasons: ["confirmation_required:verify_fact_owner"],
        confirmationRequirements: [{
          code: "verify_fact_owner" as const,
          resolution: "verified_owner" as const
        }]
      })),
      getByCard: vi.fn(),
      publish: vi.fn()
    };
    const service = createDailyReflectionMemoryProposalFinalizeService({
      repository: repository as never,
      proposalService: proposalService as never,
      now: () => NOW
    });

    await expect(service.admitUnderLease(serviceInput())).rejects.toMatchObject({
      code: "daily_reflection_memory_proposal_confirmation_required",
      proposalId: pending.id,
      cardId: pending.cardId,
      confirmationRequirements: [{
        code: "verify_fact_owner",
        resolution: "verified_owner"
      }]
    } satisfies Partial<DailyReflectionMemoryProposalConfirmationRequiredError>);
    expect(proposalService.admit).toHaveBeenCalledOnce();
    expect(repository.completeAdmissionOperation).not.toHaveBeenCalled();
    expect(failAdmissionOperation).toHaveBeenCalledOnce();
    expect(proposalService.publish).not.toHaveBeenCalled();
  });

  it("persists a retryable outer receipt after partial failure and reuses admitted work", async () => {
    const snapshots = [
      snapshot("card_a", "insight"),
      snapshot("card_b", "decision")
    ];
    const proposalTypes = new Map<string, ProposalType>();
    const createCounts = new Map<string, number>();
    const create = vi.fn((input: { cardId: string; memoryType: ProposalType }) => {
      proposalTypes.set(input.cardId, input.memoryType);
      const count = (createCounts.get(input.cardId) ?? 0) + 1;
      createCounts.set(input.cardId, count);
      return {
        proposal: proposal(input.cardId, input.memoryType),
        reused: count > 1
      };
    });
    const admissionCounts = new Map<string, number>();
    const admit = vi.fn(async (input: { proposalId: string }) => {
      const cardId = input.proposalId.replace(/^proposal_/u, "");
      const count = (admissionCounts.get(cardId) ?? 0) + 1;
      admissionCounts.set(cardId, count);
      if (cardId === "card_b" && count === 1) {
        throw new Error("simulated second Card admission failure");
      }
      const admitted = proposal(cardId, proposalTypes.get(cardId)!, "admitted");
      return {
        status: cardId === "card_a" && count === 2
          ? "already_exists" as const
          : "admitted" as const,
        proposal: admitted,
        memoryId: admitted.memoryId,
        reasons: []
      };
    });
    let outerAttempt = 0;
    const startAdmissionOperation = vi.fn(() => {
      outerAttempt += 1;
      return {
        operation: outerOperation("admitting", outerAttempt),
        executionFence: {
          leaseOwner: `outer_worker_${outerAttempt}`,
          attemptVersion: outerAttempt
        },
        reused: outerAttempt > 1
      };
    });
    const failAdmissionOperation = vi.fn();
    const completeAdmissionOperation = vi.fn((input: { results: unknown[] }) => ({
      operation: outerOperation("completed", 2),
      results: input.results,
      reused: false
    }));
    const publish = vi.fn(async () => undefined);
    const repository = {
      getAdmissionExecutionMethod: vi.fn(() => "memory_proposal_v1"),
      startAdmissionOperation,
      getConfirmation: vi.fn(() => confirmation(snapshots)),
      getWorkingCard: vi.fn(() => ({ version: 1 })),
      completeAdmissionOperation,
      failAdmissionOperation,
      getAdmissionOperation: vi.fn(),
      listAdmissionResults: vi.fn()
    };
    const proposalService = {
      create,
      admit,
      getByCard: vi.fn((_accountId: string, cardId: string) =>
        proposal(cardId, proposalTypes.get(cardId)!, "admitted")),
      publish
    };
    const service = createDailyReflectionMemoryProposalFinalizeService({
      repository: repository as never,
      proposalService: proposalService as never,
      now: () => NOW
    });

    await expect(service.admitUnderLease(serviceInput()))
      .rejects.toThrow("simulated second Card admission failure");
    expect(failAdmissionOperation).toHaveBeenCalledWith(expect.objectContaining({
      leaseOwner: "outer_worker_1",
      attemptVersion: 1,
      errorCode: "daily_reflection_memory_proposal_finalize_failed",
      results: [
        expect.objectContaining({ candidateId: "card_a", status: "admitted" }),
        {
          candidateId: "card_b",
          status: "retryable_error",
          memoryId: null,
          reasonCode: null,
          errorCode: "daily_reflection_memory_proposal_finalize_failed",
          operationKey: "daily-reflection-card:card_b",
          updatedAt: NOW
        }
      ]
    }));
    expect(publish).not.toHaveBeenCalled();

    const retried = await service.admitUnderLease(serviceInput());

    expect(retried.results).toEqual([
      expect.objectContaining({ candidateId: "card_a", status: "already_admitted" }),
      expect.objectContaining({ candidateId: "card_b", status: "admitted" })
    ]);
    expect(createCounts).toEqual(new Map([
      ["card_a", 2],
      ["card_b", 2]
    ]));
    expect(admissionCounts).toEqual(new Map([
      ["card_a", 2],
      ["card_b", 2]
    ]));
    expect(completeAdmissionOperation).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
  });

  it("replays a completed outer receipt by publishing only, without create or admit", async () => {
    const completedResults = [{
      candidateId: "card_insight",
      status: "admitted" as const,
      memoryId: "memory_card_insight",
      reasonCode: null,
      errorCode: null,
      operationKey: "daily-reflection-card:card_insight",
      updatedAt: NOW
    }];
    const create = vi.fn();
    const admit = vi.fn();
    const publish = vi.fn(async () => undefined);
    const completeAdmissionOperation = vi.fn();
    const failAdmissionOperation = vi.fn();
    const repository = {
      getAdmissionExecutionMethod: vi.fn(() => "memory_proposal_v1"),
      startAdmissionOperation: vi.fn(() => ({
        operation: outerOperation("completed"),
        executionFence: null,
        reused: true
      })),
      listAdmissionResults: vi.fn(() => completedResults),
      getConfirmation: vi.fn(),
      getWorkingCard: vi.fn(),
      completeAdmissionOperation,
      failAdmissionOperation,
      getAdmissionOperation: vi.fn()
    };
    const admitted = proposal("card_insight", "summary", "admitted");
    const proposalService = {
      create,
      admit,
      getByCard: vi.fn(() => admitted),
      publish
    };
    const service = createDailyReflectionMemoryProposalFinalizeService({
      repository: repository as never,
      proposalService: proposalService as never,
      now: () => NOW
    });

    await expect(service.admitUnderLease(serviceInput())).resolves.toEqual({
      operation: outerOperation("completed"),
      results: completedResults,
      reused: true
    });
    expect(publish).toHaveBeenCalledWith("account_1", admitted.id);
    expect(create).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
    expect(repository.getConfirmation).not.toHaveBeenCalled();
    expect(repository.getWorkingCard).not.toHaveBeenCalled();
    expect(completeAdmissionOperation).not.toHaveBeenCalled();
    expect(failAdmissionOperation).not.toHaveBeenCalled();
  });

  it("keeps the outer receipt retryable when publication fails", async () => {
    const insight = snapshot("card_insight", "insight");
    const admitted = proposal("card_insight", "summary", "admitted");
    const completeAdmissionOperation = vi.fn();
    const failAdmissionOperation = vi.fn();
    const repository = {
      getAdmissionExecutionMethod: vi.fn(() => "memory_proposal_v1"),
      startAdmissionOperation: vi.fn(() => ({
        operation: outerOperation("admitting"),
        executionFence: { leaseOwner: "outer_worker_1", attemptVersion: 1 },
        reused: false
      })),
      getConfirmation: vi.fn(() => confirmation([insight])),
      getWorkingCard: vi.fn(() => ({ version: 1 })),
      completeAdmissionOperation,
      failAdmissionOperation,
      getAdmissionOperation: vi.fn(),
      listAdmissionResults: vi.fn()
    };
    const proposalService = {
      create: vi.fn(() => ({ proposal: admitted, reused: false })),
      admit: vi.fn(async () => ({
        status: "admitted" as const,
        proposal: admitted,
        memoryId: admitted.memoryId,
        reasons: []
      })),
      getByCard: vi.fn(() => admitted),
      publish: vi.fn(async () => {
        throw new Error("publication unavailable");
      })
    };
    const service = createDailyReflectionMemoryProposalFinalizeService({
      repository: repository as never,
      proposalService: proposalService as never,
      now: () => NOW
    });

    await expect(service.admitUnderLease(serviceInput()))
      .rejects.toThrow("publication unavailable");
    expect(completeAdmissionOperation).not.toHaveBeenCalled();
    expect(failAdmissionOperation).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "daily_reflection_memory_proposal_finalize_failed",
      results: [expect.objectContaining({
        candidateId: "card_insight",
        status: "admitted"
      })]
    }));
  });
});
