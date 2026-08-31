import type Database from "better-sqlite3";
import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { openDailyReflectionDatabase } from "./db";
import { DailyReflectionInputOrchestrator } from "./input-orchestrator";
import {
  DailyReflectionConflictError,
  DailyReflectionNotFoundError,
  DailyReflectionRepository
} from "./repository";

const NOW = "2026-08-21T01:00:00.000Z";
let database: Database.Database;
let repository: DailyReflectionRepository;
let generatedId = 0;

beforeEach(() => {
  database = openDailyReflectionDatabase({ filePath: ":memory:" });
  repository = new DailyReflectionRepository(database, {
    now: () => NOW,
    idFactory: () => `generated_v2_${String(++generatedId).padStart(4, "0")}`
  });
});

afterEach(() => database.close());

function setupV2(input: {
  operationKey: string;
  finalStatus: "extracting" | "review_pending" | "failed";
  candidates?: Array<{
    id: string;
    ordinal: number;
    candidateKind: "insight" | "open_question" | "decision" | "user_action";
    proposedText: string;
    evidenceIds: string[];
    confidence: number;
    caution: string;
    actionClaimed: boolean;
  }>;
}) {
  const orchestrator = new DailyReflectionInputOrchestrator(repository);
  const reserved = orchestrator.reserve({
    accountId: "account_1",
    inputMethod: "file_upload",
    inputAdapter: "file_picker",
    sourceOrigin: "user_reflection",
    capturePurpose: "inspiration_capture",
    operationKey: input.operationKey,
    recordingDate: "2026-08-21",
    contentHash: "a".repeat(64)
  });
  const uploading = repository.transitionStatus({
    accountId: "account_1",
    reflectionId: reserved.reflection.id,
    expectedVersion: reserved.reflection.version,
    status: "uploading"
  });
  const fence = orchestrator.claimStaging({
    receipt: reserved.receipt,
    leaseOwner: `lease_${input.operationKey}`,
    leaseDurationMs: 60_000
  })!;
  const bound = orchestrator.bindAuthoritativePlan({
    receipt: reserved.receipt,
    expectedVersion: uploading.version + 1,
    duration: {
      inputMethod: "file_upload",
      inputAdapter: "file_picker",
      effectiveDurationMs: 300_000,
      clientReportedDurationMs: null,
      durationSource: "server_ffprobe",
      processingProfile: "full_recording"
    },
    fence
  });
  repository.publishAssetUnderExecutionFence({
    accountId: "account_1",
    reflectionId: reserved.reflection.id,
    leaseOwner: fence.leaseOwner,
    attemptVersion: fence.attemptVersion,
    assetKind: "segments",
    payload: [
      {
        id: "segment_1",
        uploadId: reserved.receipt.uploadId,
        startSeconds: 0,
        endSeconds: 8,
        text: "I decided to write the plan.",
        confidence: 0.97,
        sceneLabels: [],
        valueLabels: []
      },
      {
        id: "segment_2",
        uploadId: reserved.receipt.uploadId,
        startSeconds: 8,
        endSeconds: 16,
        text: "The second canonical fact.",
        confidence: 0.96,
        sceneLabels: [],
        valueLabels: []
      }
    ]
  });
  repository.releaseExecutionLease({
    accountId: "account_1",
    reflectionId: reserved.reflection.id,
    leaseOwner: fence.leaseOwner,
    attemptVersion: fence.attemptVersion
  });
  const transcribing = repository.transitionStatus({
    accountId: "account_1",
    reflectionId: reserved.reflection.id,
    expectedVersion: bound.reflection.version,
    status: "transcribing"
  });
  let current = repository.transitionStatus({
    accountId: "account_1",
    reflectionId: reserved.reflection.id,
    expectedVersion: transcribing.version,
    status: "extracting"
  });
  if (input.candidates?.length) {
    current = repository.savePendingCandidatesV2({
      accountId: "account_1",
      reflectionId: reserved.reflection.id,
      expectedVersion: current.version,
      candidates: input.candidates
    }).reflection;
  }
  if (input.finalStatus === "review_pending") {
    current = repository.transitionStatus({
      accountId: "account_1",
      reflectionId: reserved.reflection.id,
      expectedVersion: current.version,
      status: "review_pending"
    });
  } else if (input.finalStatus === "failed") {
    current = repository.transitionStatus({
      accountId: "account_1",
      reflectionId: reserved.reflection.id,
      expectedVersion: current.version,
      status: "failed",
      errorCode: "daily_reflection_candidate_provider_unavailable",
      errorMessage: "daily_reflection_candidate_provider_unavailable"
    });
  }
  return { reserved, reflection: current };
}

function candidate(overrides: Partial<{
  id: string;
  ordinal: number;
  candidateKind: "insight" | "open_question" | "decision" | "user_action";
  proposedText: string;
  evidenceIds: string[];
  confidence: number;
  caution: string;
  actionClaimed: boolean;
}> = {}) {
  return {
    id: "candidate_1",
    ordinal: 0,
    candidateKind: "user_action" as const,
    proposedText: "Write the plan.",
    evidenceIds: ["segment_1"],
    confidence: 0.9,
    caution: "Confirm this is your action.",
    actionClaimed: false,
    ...overrides
  };
}

describe("Daily Reflection V2 candidate mutation contract", () => {
  it("updates actionClaimed only for an evidenced user_action under account/version fencing", () => {
    const setup = setupV2({
      operationKey: "operation_action_claim",
      finalStatus: "review_pending",
      candidates: [
        candidate(),
        candidate({
          id: "candidate_decision",
          ordinal: 1,
          candidateKind: "decision",
          proposedText: "A decision"
        })
      ]
    });
    expect(() => repository.updateCandidateDecisions({
      accountId: "account_1",
      reflectionId: setup.reflection.id,
      expectedVersion: setup.reflection.version,
      candidates: [{
        candidateId: "candidate_decision",
        status: "kept",
        userText: null,
        subjectPersonId: null,
        actionClaimed: true
      }]
    })).toThrowError(expect.objectContaining<Partial<DailyReflectionConflictError>>({
      code: "daily_reflection_action_claim_requires_evidence"
    }));
    const updated = repository.updateCandidateDecisions({
      accountId: "account_1",
      reflectionId: setup.reflection.id,
      expectedVersion: setup.reflection.version,
      candidates: [{
        candidateId: "candidate_1",
        status: "kept",
        userText: null,
        subjectPersonId: null,
        actionClaimed: true
      }]
    });
    expect(updated.candidates.find((item) => item.id === "candidate_1"))
      .toMatchObject({ actionClaimed: true, candidateType: "commitment" });
    expect(() => repository.updateCandidateDecisions({
      accountId: "account_2",
      reflectionId: setup.reflection.id,
      expectedVersion: updated.reflection.version,
      candidates: [{
        candidateId: "candidate_1",
        status: "kept",
        userText: null,
        subjectPersonId: null
      }]
    })).toThrow(DailyReflectionNotFoundError);
  });

  it("recovers a Provider failure with a strict manual candidate and marks no-Evidence as recap-only", () => {
    const setup = setupV2({
      operationKey: "operation_manual_recovery",
      finalStatus: "failed"
    });
    expect(() => repository.createManualCandidateV2({
      accountId: "account_1",
      reflectionId: setup.reflection.id,
      expectedVersion: setup.reflection.version,
      candidateKind: "insight",
      proposedText: "Invented reference",
      evidenceIds: ["not_canonical"],
      confidence: 1,
      caution: "Manual entry.",
      actionClaimed: false
    })).toThrowError(expect.objectContaining<Partial<DailyReflectionConflictError>>({
      code: "daily_reflection_confirmation_evidence_unavailable"
    }));
    const created = repository.createManualCandidateV2({
      accountId: "account_1",
      reflectionId: setup.reflection.id,
      expectedVersion: setup.reflection.version,
      candidateKind: "insight",
      proposedText: "Manual recap note",
      evidenceIds: [],
      confidence: 0.8,
      caution: "This item has no canonical Evidence.",
      actionClaimed: false
    });
    expect(created).toMatchObject({
      reflection: { status: "review_pending", errorCode: null },
      candidate: { sourceSegmentIds: [] },
      retentionEligibility: "recap_only"
    });
    const decided = repository.updateCandidateDecisions({
      accountId: "account_1",
      reflectionId: setup.reflection.id,
      expectedVersion: created.reflection.version,
      candidates: [{
        candidateId: created.candidate.id,
        status: "kept",
        userText: null,
        subjectPersonId: null
      }]
    });
    expect(() => repository.finalizeReviewV2({
      accountId: "account_1",
      reflectionId: setup.reflection.id,
      expectedVersion: decided.reflection.version,
      operationKey: setup.reserved.input.operationKey,
      saveIntent: "retain_selected"
    })).toThrowError(expect.objectContaining<Partial<DailyReflectionConflictError>>({
      code: "daily_reflection_retain_requires_evidence"
    }));
  });

  it("projects an Evidence-backed manual candidate into a Working Card before retention", () => {
    const setup = setupV2({
      operationKey: "operation_manual_card",
      finalStatus: "failed"
    });
    const created = repository.createManualCandidateV2({
      accountId: "account_1",
      reflectionId: setup.reflection.id,
      expectedVersion: setup.reflection.version,
      candidateKind: "open_question",
      proposedText: "这个方向下一步应该先验证什么？",
      evidenceIds: ["segment_1"],
      confidence: 0.8,
      caution: "User-authored Card.",
      actionClaimed: false
    });
    expect(created.retentionEligibility).toBe("retain_selected");
    const detail = repository.getReflectionDetail("account_1", setup.reflection.id);
    expect(detail.cards).toEqual([
      expect.objectContaining({
        id: created.candidate.id,
        cardKind: "open_question",
        reviewStatus: "pending",
        epistemicStatus: "explicit_user_statement"
      })
    ]);
    expect(repository.getWorkingCard("account_1", created.candidate.id)).toMatchObject({
      status: "review_pending",
      cardKind: "question",
      evidenceIds: ["segment_1"]
    });
    const reviewed = repository.updateReflectionCards({
      accountId: "account_1",
      reflectionId: setup.reflection.id,
      expectedVersion: created.reflection.version,
      cards: [{
        cardId: created.candidate.id,
        reviewStatus: "kept",
        userTitle: null,
        userText: null
      }]
    });
    repository.finalizeReviewV2({
      accountId: "account_1",
      reflectionId: setup.reflection.id,
      expectedVersion: reviewed.reflection.version,
      operationKey: setup.reserved.input.operationKey,
      saveIntent: "retain_selected"
    });
    expect(repository.getAdmissionExecutionMethod(
      "account_1",
      setup.reflection.id
    )).toBe("memory_proposal_v1");
    expect(repository.getWorkingCard("account_1", created.candidate.id).status)
      .toBe("saved");
  });

  it("soft-excludes one candidate, omits it from confirmation, and restores via PATCH semantics", () => {
    const setup = setupV2({
      operationKey: "operation_candidate_exclude",
      finalStatus: "review_pending",
      candidates: [
        candidate(),
        candidate({
          id: "candidate_2",
          ordinal: 1,
          candidateKind: "insight",
          proposedText: "Keep this insight",
          evidenceIds: ["segment_2"]
        })
      ]
    });
    const excluded = repository.excludeCandidateV2({
      accountId: "account_1",
      reflectionId: setup.reflection.id,
      candidateId: "candidate_1",
      expectedVersion: setup.reflection.version
    });
    expect(excluded).toMatchObject({
      candidate: { status: "excluded" },
      disposition: "excluded",
      recoverable: true
    });
    const restored = repository.updateCandidateDecisions({
      accountId: "account_1",
      reflectionId: setup.reflection.id,
      expectedVersion: excluded.reflection.version,
      candidates: [{
        candidateId: "candidate_1",
        status: "kept",
        userText: null,
        subjectPersonId: null
      }]
    });
    const excludedAgain = repository.excludeCandidateV2({
      accountId: "account_1",
      reflectionId: setup.reflection.id,
      candidateId: "candidate_1",
      expectedVersion: restored.reflection.version
    });
    const decided = repository.updateCandidateDecisions({
      accountId: "account_1",
      reflectionId: setup.reflection.id,
      expectedVersion: excludedAgain.reflection.version,
      candidates: [{
        candidateId: "candidate_2",
        status: "kept",
        userText: null,
        subjectPersonId: null
      }]
    });
    const finalized = repository.finalizeReviewV2({
      accountId: "account_1",
      reflectionId: setup.reflection.id,
      expectedVersion: decided.reflection.version,
      operationKey: setup.reserved.input.operationKey,
      saveIntent: "retain_selected"
    });
    expect(finalized.confirmation.candidateSnapshots.map((item) => item.candidateId))
      .toEqual(["candidate_2"]);
  });
});
