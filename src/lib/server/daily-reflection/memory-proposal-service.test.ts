import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DailyReflectionMemoryProposal } from
  "@/lib/domain/daily-reflection-memory-proposal";
import type { TranscriptSegment } from "@/lib/domain/types";

import { createDailyReflectionMemoryProposalService } from
  "./memory-proposal-service";

const NOW = "2026-08-24T08:00:00.000Z";

function segment(text = "我平时更喜欢安静的位置。") : TranscriptSegment {
  return {
    id: "segment_1",
    uploadId: "upload_1",
    startSeconds: 0,
    endSeconds: 8,
    speaker: "speaker_0",
    identity: {
      globalSpeakerId: "user_1",
      identityType: "known_user",
      confidence: 0.98,
      source: "voiceprint"
    },
    text,
    confidence: 0.96,
    sceneLabels: [],
    valueLabels: []
  };
}

function proposal(overrides: Partial<DailyReflectionMemoryProposal> = {}) {
  return {
    id: "proposal_1",
    accountId: "account_1",
    cardId: "card_1",
    reflectionId: "reflection_1",
    title: "安静位置偏好",
    cardKind: "insight",
    actionClaimed: false,
    memoryType: "preference",
    content: "我平时更喜欢安静的位置。",
    evidenceIds: ["segment_1"],
    evidenceSnapshots: [{
      sourceSegmentId: "segment_1",
      uploadId: "upload_1",
      startSeconds: 0,
      endSeconds: 8,
      effectiveOrigin: "user_reflection"
    }],
    riskFlags: [],
    subjectPersonId: null,
    importance: 0.9,
    durability: 0.9,
    novelty: 0.8,
    sensitivity: 0.1,
    epistemicStatus: "explicit_user_statement",
    epistemicCaution: null,
    status: "pending",
    policyVersion: "unassessed",
    score: 0,
    reasons: [],
    operationKey: "daily-reflection-card:card_1",
    requestFingerprint: "a".repeat(64),
    memoryId: null,
    sourceOrigin: "user_reflection",
    inputAdapter: "file_picker",
    capturePurpose: "inspiration_capture",
    recordingDate: "2026-08-24",
    createdBy: "user",
    admissionMethod: "daily_reflection_memory_proposal_v1",
    cardVersion: 1,
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
    admittedAt: null,
    ...overrides
  } satisfies DailyReflectionMemoryProposal;
}

function harness(initial = proposal()) {
  let current = initial;
  const source = {
    proposal: current,
    evidenceSegments: [{ ...segment(), effectiveOrigin: "user_reflection" as const }],
    sourceSegments: [segment()],
    upload: {
      id: "upload_1",
      recordingDate: "2026-08-24",
      mimeType: "audio/wav",
      originalName: "fixture.wav",
      sizeBytes: 1024,
      status: "ready" as const
    },
    sourceValid: true,
    sourceInvalidReason: null
  };
  const proposalRepository = {
    create: vi.fn(),
    get: vi.fn(() => current),
    list: vi.fn(),
    getAdmissionSource: vi.fn(() => ({ ...source, proposal: current })),
    evaluate: vi.fn((input: {
      decision: "approved" | "rejected";
      policyVersion: string;
      score: number;
      reasons: string[];
    }) => {
      current = {
        ...current,
        status: input.decision,
        policyVersion: input.policyVersion,
        score: input.score,
        reasons: input.reasons,
        version: current.version + 1
      };
      return { proposal: current, reused: false };
    }),
    startAdmission: vi.fn(() => {
      if (current.status === "admitted" || current.status === "rejected") {
        return { proposal: current, executionFence: null };
      }
      current = { ...current, version: current.version + 1 };
      return {
        proposal: current,
        executionFence: {
          leaseOwner: "lease_1",
          leaseUntil: "2026-08-24T08:01:00.000Z",
          attemptVersion: 1
        }
      };
    }),
    completeAdmission: vi.fn((input: { memoryId: string }) => {
      current = {
        ...current,
        status: "admitted",
        memoryId: input.memoryId,
        admittedAt: NOW,
        version: current.version + 1
      };
      return { proposal: current, reused: false };
    }),
    failAdmission: vi.fn(),
    reject: vi.fn(),
    listEvents: vi.fn((): Array<{ event_type: string }> => [])
  };
  const admissionRepository = {
    findByOperationKey: vi.fn(() => null as null | {
      status: "already_exists";
      userId: string;
      reflectionId: string;
      publicationId: string;
      publicationStatus: "unpublished" | "published";
      proposalId: string;
      cardId: string;
      operationKey: string;
      payloadDigest: string;
      memoryId: string;
    }),
    applyProposal: vi.fn((input: {
      memory: { id: string };
      payloadDigest: string;
      publicationId: string;
    }) => ({
      status: "admitted" as "admitted" | "already_exists",
      userId: "account_1",
      reflectionId: "reflection_1",
      publicationId: "publication_1",
      publicationStatus: "unpublished" as const,
      proposalId: "proposal_1",
      cardId: "card_1",
      operationKey: "daily-reflection-card:card_1",
      payloadDigest: input.payloadDigest,
      memoryId: input.memory.id
    })),
    getProvenance: vi.fn(() => []),
    getPublication: vi.fn(() => null),
    markPublished: vi.fn(() => ({
      id: "publication_1",
      status: "published" as const
    }))
  };
  const personRepository = {
    getConfirmedPerson: vi.fn((_accountId: string, _personId: string): unknown => null)
  };
  const onPublicationVisible = vi.fn();
  const service = createDailyReflectionMemoryProposalService({
    proposalRepository: proposalRepository as never,
    admissionRepository: admissionRepository as never,
    personRepository: personRepository as never,
    now: () => NOW,
    leaseOwnerFactory: () => "lease_1",
    onPublicationVisible
  });
  return {
    service,
    proposalRepository,
    admissionRepository,
    personRepository,
    onPublicationVisible,
    current: () => current
  };
}

describe("Daily Reflection Memory Proposal service", () => {
  it("admits a durable explicit preference only through the existing repository", async () => {
    const fixture = harness();
    const result = await fixture.service.admit({
      accountId: "account_1",
      proposalId: "proposal_1",
      expectedVersion: 0
    });

    expect(result).toMatchObject({ status: "admitted", memoryId: expect.any(String) });
    expect(fixture.proposalRepository.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "approved" })
    );
    expect(fixture.admissionRepository.applyProposal).toHaveBeenCalledTimes(1);
    expect(fixture.admissionRepository.markPublished).toHaveBeenCalledTimes(1);
    expect(fixture.onPublicationVisible).toHaveBeenCalledWith({
      accountId: "account_1",
      reflectionId: "reflection_1",
      uploadId: "upload_1"
    });
  });

  it.each([
    proposal({
      cardKind: "action",
      memoryType: "commitment",
      actionClaimed: false,
      content: "我会在明天完成并提交材料。"
    }),
    proposal({ epistemicStatus: "ai_inference" }),
    proposal({
      memoryType: "preference",
      content: "我今天先喝咖啡。",
      durability: 0.2
    })
  ])("rejects an unsafe or transient proposal with zero Durable Memory writes", async (unsafe) => {
    const fixture = harness(unsafe);
    const result = await fixture.service.admit({
      accountId: "account_1",
      proposalId: unsafe.id,
      expectedVersion: unsafe.version
    });

    expect(result.status).toBe("rejected");
    expect(fixture.admissionRepository.applyProposal).not.toHaveBeenCalled();
    expect(fixture.admissionRepository.markPublished).not.toHaveBeenCalled();
  });

  it("keeps person_fact fail-closed when the existing Person admission path is unavailable", async () => {
    const personFact = proposal({
      memoryType: "person_fact",
      subjectPersonId: "person_alex",
      content: "我认为 Alex 可能不喜欢这个方案。",
      epistemicStatus: "reported_event",
      epistemicCaution: "reported_inference"
    });
    const fixture = harness(personFact);
    fixture.personRepository.getConfirmedPerson.mockReturnValue({ id: "person_alex" });

    const result = await fixture.service.admit({
      accountId: "account_1",
      proposalId: personFact.id,
      expectedVersion: personFact.version
    });

    expect(result.status).toBe("rejected");
    expect(result.reasons).toContain("reported_inference_person_fact_forbidden");
    expect(fixture.admissionRepository.applyProposal).not.toHaveBeenCalled();
  });

  it("preserves reported-event epistemic framing in the Durable Memory payload", async () => {
    const fixture = harness(proposal({
      cardKind: "event",
      memoryType: "event",
      content: "项目负责人报告验收已经完成。",
      epistemicStatus: "reported_event",
      durability: 0.7
    }));

    expect((await fixture.service.admit({
      accountId: "account_1",
      proposalId: "proposal_1",
      expectedVersion: 0
    })).status).toBe("admitted");
    expect(fixture.admissionRepository.applyProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        memory: expect.objectContaining({
          type: "event",
          summary: "用户报告：项目负责人报告验收已经完成。",
          importanceReasons: expect.arrayContaining([
            "daily_reflection: epistemic status reported_event"
          ])
        })
      })
    );
  });

  it("recovers a lost response from the authoritative operation without a duplicate write", async () => {
    const fixture = harness(proposal({ status: "approved", version: 3 }));
    const prepared = (fixture.admissionRepository.applyProposal as ReturnType<typeof vi.fn>);
    const probe = harness();
    await probe.service.admit({
      accountId: "account_1",
      proposalId: "proposal_1",
      expectedVersion: 0
    });
    const firstInput = probe.admissionRepository.applyProposal.mock.calls[0]![0];
    fixture.admissionRepository.findByOperationKey.mockReturnValue({
      status: "already_exists",
      userId: "account_1",
      reflectionId: "reflection_1",
      publicationId: firstInput.publicationId,
      publicationStatus: "unpublished",
      proposalId: "proposal_1",
      cardId: "card_1",
      operationKey: "daily-reflection-card:card_1",
      payloadDigest: firstInput.payloadDigest,
      memoryId: firstInput.memory.id
    });
    fixture.admissionRepository.applyProposal.mockReturnValue({
      status: "already_exists",
      userId: "account_1",
      reflectionId: "reflection_1",
      publicationId: firstInput.publicationId,
      publicationStatus: "unpublished",
      proposalId: "proposal_1",
      cardId: "card_1",
      operationKey: "daily-reflection-card:card_1",
      payloadDigest: firstInput.payloadDigest,
      memoryId: firstInput.memory.id
    });

    const result = await fixture.service.admit({
      accountId: "account_1",
      proposalId: "proposal_1",
      expectedVersion: 1
    });

    expect(result.status).toBe("already_exists");
    expect(prepared).toHaveBeenCalledTimes(1);
    expect(fixture.proposalRepository.completeAdmission).toHaveBeenCalledWith(
      expect.objectContaining({ recovered: true })
    );
  });

  it("claims the lease before revalidating Card and Evidence", async () => {
    const fixture = harness(proposal({ status: "approved", version: 1 }));
    await fixture.service.admit({
      accountId: "account_1",
      proposalId: "proposal_1",
      expectedVersion: 1
    });
    expect(fixture.proposalRepository.startAdmission.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.proposalRepository.getAdmissionSource.mock.invocationCallOrder[0]!);
    expect(fixture.proposalRepository.getAdmissionSource.mock.invocationCallOrder[0])
      .toBeLessThan(fixture.admissionRepository.applyProposal.mock.invocationCallOrder[0]!);
  });

  it("rejects a source changed under the lease with zero Durable Memory writes", async () => {
    const fixture = harness(proposal({ status: "approved", version: 1 }));
    fixture.proposalRepository.getAdmissionSource.mockReturnValueOnce({
      proposal: fixture.current(),
      evidenceSegments: [],
      sourceSegments: [],
      upload: null,
      sourceValid: false,
      sourceInvalidReason: "daily_reflection_memory_proposal_source_changed"
    } as never);

    await expect(fixture.service.admit({
      accountId: "account_1",
      proposalId: "proposal_1",
      expectedVersion: 1
    })).rejects.toMatchObject({
      code: "daily_reflection_memory_proposal_source_invalid"
    });
    expect(fixture.admissionRepository.applyProposal).not.toHaveBeenCalled();
    expect(fixture.proposalRepository.failAdmission).toHaveBeenCalledTimes(1);
    expect(fixture.proposalRepository.reject).toHaveBeenCalledWith({
      accountId: "account_1",
      proposalId: "proposal_1",
      reason: "canonical_source_invalid"
    });
  });

  it("does not revive a revoked admitted Proposal", async () => {
    const admitted = proposal({
      status: "admitted",
      version: 4,
      policyVersion: "daily_reflection_memory_proposal_policy_v1",
      score: 0.8,
      reasons: ["policy_threshold_met"],
      memoryId: "memory_1",
      admittedAt: NOW
    });
    const fixture = harness(admitted);
    fixture.proposalRepository.listEvents.mockReturnValueOnce([{
      event_type: "revoked"
    }]);
    await expect(fixture.service.admit({
      accountId: "account_1",
      proposalId: "proposal_1",
      expectedVersion: admitted.version
    })).rejects.toMatchObject({
      code: "daily_reflection_memory_proposal_revoked"
    });
    expect(fixture.admissionRepository.applyProposal).not.toHaveBeenCalled();
    expect(fixture.admissionRepository.markPublished).not.toHaveBeenCalled();
  });
});
