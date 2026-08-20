import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CreateDailyReflectionInput,
  DailyReflection,
  DailyReflectionStatus
} from "@/lib/domain/daily-reflection";

import { openDailyReflectionDatabase } from "./db";
import {
  DailyReflectionConflictError,
  DailyReflectionLeaseLostError,
  DailyReflectionNotFoundError,
  DailyReflectionRepository
} from "./repository";
import { DailyReflectionTransitionError } from "./state-machine";

const timestamp = "2026-08-13T00:00:00.000Z";

let database: Database.Database;
let repository: DailyReflectionRepository;
let generatedId = 0;

beforeEach(() => {
  database = openDailyReflectionDatabase({ filePath: ":memory:" });
  generatedId = 0;
  repository = new DailyReflectionRepository(database, {
    now: () => timestamp,
    idFactory: () => `generated_${++generatedId}`
  });
});

afterEach(() => {
  database.close();
});

function createInput(
  overrides: Partial<CreateDailyReflectionInput> = {}
): CreateDailyReflectionInput {
  return {
    id: "reflection_1",
    accountId: "account_1",
    uploadId: "upload_1",
    inputMethod: "file_upload",
    sourceOrigin: "unknown",
    processingProfile: "full_recording",
    ingestionContext: "daily_reflection",
    idempotencyKey: "create_1",
    ...overrides
  };
}

function transitionPath(
  reflection: DailyReflection,
  statuses: DailyReflectionStatus[]
) {
  return statuses.reduce((current, status) => repository.transitionStatus({
    accountId: current.accountId,
    reflectionId: current.id,
    expectedVersion: current.version,
    status
  }), reflection);
}

function createReviewPendingCandidateSet() {
  const created = repository.createReflection(createInput({
    sourceOrigin: "user_reflection"
  })).reflection;
  const extracting = transitionPath(created, [
    "uploading",
    "transcribing",
    "extracting"
  ]);
  const fence = repository.claimExecutionLease({
    accountId: extracting.accountId,
    reflectionId: extracting.id,
    leaseOwner: "candidate_builder",
    leaseDurationMs: 60_000,
    allowedStatuses: ["extracting"]
  });
  if (!fence) throw new Error("expected candidate builder lease");
  repository.publishAssetUnderExecutionFence({
    accountId: extracting.accountId,
    reflectionId: extracting.id,
    leaseOwner: fence.leaseOwner,
    attemptVersion: fence.attemptVersion,
    assetKind: "segments",
    payload: [
      {
        id: "segment_1",
        uploadId: "upload_1",
        startSeconds: 0,
        endSeconds: 8,
        text: "Contact Alice before Friday.",
        confidence: 0.98,
        sceneLabels: [],
        valueLabels: []
      },
      {
        id: "segment_2",
        uploadId: "upload_1",
        startSeconds: 8,
        endSeconds: 16,
        text: "Reconsider the travel plan.",
        confidence: 0.97,
        sceneLabels: [],
        valueLabels: []
      }
    ]
  });
  const saved = repository.savePendingCandidates({
    accountId: extracting.accountId,
    reflectionId: extracting.id,
    expectedVersion: extracting.version,
    leaseOwner: fence.leaseOwner,
    attemptVersion: fence.attemptVersion,
    candidates: [
      {
        id: "candidate_1",
        ordinal: 0,
        proposedText: "Contact Alice before Friday.",
        candidateType: "commitment",
        sourceSegmentIds: ["segment_1"]
      },
      {
        id: "candidate_2",
        ordinal: 1,
        proposedText: "Reconsider the travel plan.",
        candidateType: "event",
        sourceSegmentIds: ["segment_2"]
      }
    ]
  });
  const reflection = repository.transitionStatus({
    accountId: saved.reflection.accountId,
    reflectionId: saved.reflection.id,
    expectedVersion: saved.reflection.version,
    status: "review_pending",
    leaseOwner: fence.leaseOwner,
    attemptVersion: fence.attemptVersion
  });
  repository.releaseExecutionLease({
    accountId: reflection.accountId,
    reflectionId: reflection.id,
    leaseOwner: fence.leaseOwner,
    attemptVersion: fence.attemptVersion
  });
  return {
    reflection,
    candidates: repository.listCandidates(reflection.accountId, reflection.id)
  };
}

function createCompletedCandidateSet() {
  const review = createReviewPendingCandidateSet();
  const decided = repository.updateCandidateDecisions({
    accountId: review.reflection.accountId,
    reflectionId: review.reflection.id,
    expectedVersion: review.reflection.version,
    candidates: [
      {
        candidateId: "candidate_1",
        status: "kept",
        userText: null,
        subjectPersonId: null
      },
      {
        candidateId: "candidate_2",
        status: "kept",
        userText: null,
        subjectPersonId: null
      }
    ]
  });
  repository.finalizeReview({
    accountId: review.reflection.accountId,
    reflectionId: review.reflection.id,
    expectedVersion: decided.reflection.version,
    idempotencyKey: "finalize_for_revocation"
  });
  const claim = repository.startAdmissionOperation({
    accountId: review.reflection.accountId,
    reflectionId: review.reflection.id,
    leaseOwner: "admission_for_revocation",
    leaseDurationMs: 60_000,
    now: timestamp
  });
  if (!claim.executionFence) throw new Error("expected admission fence");
  repository.completeAdmissionOperation({
    accountId: review.reflection.accountId,
    reflectionId: review.reflection.id,
    leaseOwner: claim.executionFence.leaseOwner,
    attemptVersion: claim.executionFence.attemptVersion,
    results: [
      {
        candidateId: "candidate_1",
        status: "admitted",
        memoryId: "memory_candidate_1",
        reasonCode: null,
        errorCode: null,
        operationKey: "admission_candidate_1",
        updatedAt: timestamp
      },
      {
        candidateId: "candidate_2",
        status: "rejected",
        memoryId: null,
        reasonCode: "admission_rejected",
        errorCode: null,
        operationKey: "admission_candidate_2",
        updatedAt: timestamp
      }
    ],
    now: timestamp
  });
  return repository.getReflection(review.reflection.accountId, review.reflection.id);
}

describe("DailyReflectionRepository", () => {
  it("creates an explicitly sourced reflection with its persisted processing plan", () => {
    const created = repository.createReflection(createInput());

    expect(created.reused).toBe(false);
    expect(created.reflection).toMatchObject({
      id: "reflection_1",
      accountId: "account_1",
      uploadId: "upload_1",
      inputMethod: "file_upload",
      sourceOrigin: "unknown",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      status: "created",
      version: 0,
      idempotencyKey: "create_1",
      errorCode: null,
      errorMessage: null
    });
    expect(created.processingPlan).toEqual({
      planVersion: 1,
      reflectionId: "reflection_1",
      uploadId: "upload_1",
      inputMethod: "file_upload",
      sourceOrigin: "unknown",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      reviewPolicy: "required"
    });

    const input = createInput();
    delete (input as Partial<CreateDailyReflectionInput>).sourceOrigin;
    expect(() => repository.createReflection(input)).toThrow();
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM dr_reflections"
    ).get()).toEqual({ count: 1 });
  });

  it("is idempotent only for the same account, key, and immutable create payload", () => {
    const first = repository.createReflection(createInput());
    const repeated = repository.createReflection(createInput({ id: "ignored_retry_id" }));

    expect(repeated).toEqual({ ...first, reused: true });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM dr_reflections"
    ).get()).toEqual({ count: 1 });
    expect(() => repository.createReflection(createInput({
      id: "reflection_conflict",
      sourceOrigin: "direct_conversation"
    }))).toThrowError(expect.objectContaining({
      code: "daily_reflection_idempotency_conflict"
    }));

    const otherAccount = repository.createReflection(createInput({
      id: "reflection_account_2",
      accountId: "account_2"
    }));
    expect(otherAccount.reflection.accountId).toBe("account_2");
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM dr_reflections"
    ).get()).toEqual({ count: 2 });
  });

  it("binds a delayed upload and all four plan dimensions atomically", () => {
    const created = repository.createReflection(createInput({
      uploadId: null,
      idempotencyKey: "delayed_upload"
    }));
    expect(created.processingPlan).toBeNull();

    const bound = repository.bindUploadAndPlan({
      accountId: "account_1",
      reflectionId: created.reflection.id,
      expectedVersion: 0,
      uploadId: "upload_delayed"
    });
    expect(bound.reused).toBe(false);
    expect(bound.reflection).toMatchObject({ uploadId: "upload_delayed", version: 1 });
    expect(bound.processingPlan).toMatchObject({
      reflectionId: created.reflection.id,
      uploadId: "upload_delayed",
      inputMethod: "file_upload",
      sourceOrigin: "unknown",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      reviewPolicy: "required"
    });

    expect(repository.bindUploadAndPlan({
      accountId: "account_1",
      reflectionId: created.reflection.id,
      expectedVersion: 0,
      uploadId: "upload_delayed"
    }).reused).toBe(true);
    expect(() => repository.bindUploadAndPlan({
      accountId: "account_1",
      reflectionId: created.reflection.id,
      expectedVersion: 1,
      uploadId: "upload_different"
    })).toThrow(DailyReflectionConflictError);
  });

  it("freezes a browser profile under both the optimistic version and execution fence", () => {
    const created = repository.createReflection(createInput({
      uploadId: null,
      inputMethod: "browser_recording",
      sourceOrigin: "user_reflection",
      processingProfile: "full_recording",
      idempotencyKey: "browser_profile"
    }));
    expect(created.processingPlan).toBeNull();
    expect(() => repository.bindUploadAndPlan({
      accountId: created.reflection.accountId,
      reflectionId: created.reflection.id,
      expectedVersion: created.reflection.version,
      uploadId: "upload_browser",
      processingProfile: "quick_reflection"
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_profile_fence_required"
    }));

    const staleFence = repository.claimExecutionLease({
      accountId: created.reflection.accountId,
      reflectionId: created.reflection.id,
      leaseOwner: "browser_probe_stale",
      leaseDurationMs: 60_000,
      allowedStatuses: ["created"]
    });
    expect(staleFence).not.toBeNull();
    repository.releaseExecutionLease({
      accountId: created.reflection.accountId,
      reflectionId: created.reflection.id,
      leaseOwner: staleFence!.leaseOwner,
      attemptVersion: staleFence!.attemptVersion
    });
    expect(() => repository.bindUploadAndPlan({
      accountId: created.reflection.accountId,
      reflectionId: created.reflection.id,
      expectedVersion: created.reflection.version,
      uploadId: "upload_browser",
      processingProfile: "quick_reflection",
      leaseOwner: staleFence!.leaseOwner,
      attemptVersion: staleFence!.attemptVersion
    })).toThrow(DailyReflectionLeaseLostError);

    const fence = repository.claimExecutionLease({
      accountId: created.reflection.accountId,
      reflectionId: created.reflection.id,
      leaseOwner: "browser_probe_winner",
      leaseDurationMs: 60_000,
      allowedStatuses: ["created"]
    });
    expect(fence).not.toBeNull();
    const bound = repository.bindUploadAndPlan({
      accountId: created.reflection.accountId,
      reflectionId: created.reflection.id,
      expectedVersion: created.reflection.version,
      uploadId: "upload_browser",
      processingProfile: "quick_reflection",
      leaseOwner: fence!.leaseOwner,
      attemptVersion: fence!.attemptVersion
    });
    expect(bound.reflection).toMatchObject({
      uploadId: "upload_browser",
      inputMethod: "browser_recording",
      processingProfile: "quick_reflection",
      version: 1
    });
    expect(bound.processingPlan).toMatchObject({
      uploadId: "upload_browser",
      inputMethod: "browser_recording",
      sourceOrigin: "user_reflection",
      processingProfile: "quick_reflection"
    });
    expect(repository.bindUploadAndPlan({
      accountId: created.reflection.accountId,
      reflectionId: created.reflection.id,
      expectedVersion: created.reflection.version,
      uploadId: "upload_browser",
      processingProfile: "quick_reflection"
    }).reused).toBe(true);
    expect(() => repository.bindUploadAndPlan({
      accountId: created.reflection.accountId,
      reflectionId: created.reflection.id,
      expectedVersion: bound.reflection.version,
      uploadId: "upload_browser",
      processingProfile: "full_recording"
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_plan_binding_conflict"
    }));
  });

  it("atomically reserves and converts account-scoped browser upload ownership", () => {
    const reflectionId = "reflection_browser_provisional";
    const uploadId = `daily-reflection-${reflectionId}`;
    const created = repository.createReflection(createInput({
      id: reflectionId,
      uploadId: null,
      inputMethod: "browser_recording",
      sourceOrigin: "user_reflection",
      processingProfile: "full_recording",
      idempotencyKey: "browser_provisional"
    })).reflection;
    const uploading = repository.transitionStatus({
      accountId: created.accountId,
      reflectionId,
      expectedVersion: created.version,
      status: "uploading"
    });
    const firstFence = repository.claimExecutionLease({
      accountId: created.accountId,
      reflectionId,
      leaseOwner: "browser_provisional_writer_1",
      leaseDurationMs: 60_000,
      uploadFingerprint: "a".repeat(64),
      provisionalUploadId: uploadId,
      allowedStatuses: ["uploading"]
    });

    expect(firstFence).toMatchObject({ attemptVersion: 1 });
    expect(repository.getReflection(created.accountId, reflectionId)).toMatchObject({
      uploadId,
      version: uploading.version + 1,
      processingProfile: "full_recording",
      sourceOrigin: "user_reflection"
    });
    expect(repository.getProcessingPlan(created.accountId, reflectionId)).toBeNull();
    expect(repository.getProvisionalUploadOwnership(created.accountId, reflectionId))
      .toMatchObject({
        accountId: created.accountId,
        reflectionId,
        uploadId,
        uploadFingerprint: "a".repeat(64),
        attemptVersion: 1,
        leaseOwner: firstFence!.leaseOwner,
        status: "uploading"
      });
    expect(repository.findReflectionByUpload(created.accountId, uploadId)).toBeNull();
    expect(() => repository.getProvisionalUploadOwnership("account_2", reflectionId))
      .toThrow(DailyReflectionNotFoundError);
    expect(() => repository.claimExecutionLease({
      accountId: created.accountId,
      reflectionId,
      leaseOwner: "browser_wrong_fingerprint",
      leaseDurationMs: 60_000,
      uploadFingerprint: "b".repeat(64),
      provisionalUploadId: uploadId,
      allowedStatuses: ["uploading"]
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_idempotency_conflict"
    }));

    repository.releaseExecutionLease({
      accountId: created.accountId,
      reflectionId,
      leaseOwner: firstFence!.leaseOwner,
      attemptVersion: firstFence!.attemptVersion
    });
    expect(repository.claimExecutionLease({
      accountId: created.accountId,
      reflectionId,
      leaseOwner: "browser_stale_provisional_writer",
      leaseDurationMs: 60_000,
      uploadFingerprint: "a".repeat(64),
      provisionalUploadId: uploadId,
      expectedAttemptVersion: 0,
      allowedStatuses: ["uploading"]
    })).toBeNull();
    const secondFence = repository.claimExecutionLease({
      accountId: created.accountId,
      reflectionId,
      leaseOwner: "browser_provisional_writer_2",
      leaseDurationMs: 60_000,
      uploadFingerprint: "a".repeat(64),
      provisionalUploadId: uploadId,
      expectedAttemptVersion: 1,
      allowedStatuses: ["uploading"]
    });
    expect(secondFence).toMatchObject({ attemptVersion: 2 });
    expect(repository.getReflection(created.accountId, reflectionId).version)
      .toBe(uploading.version + 1);
    expect(() => repository.bindUploadAndPlan({
      accountId: created.accountId,
      reflectionId,
      expectedVersion: uploading.version + 1,
      uploadId,
      processingProfile: "quick_reflection",
      leaseOwner: firstFence!.leaseOwner,
      attemptVersion: firstFence!.attemptVersion
    })).toThrow(DailyReflectionLeaseLostError);

    const bound = repository.bindUploadAndPlan({
      accountId: created.accountId,
      reflectionId,
      expectedVersion: uploading.version + 1,
      uploadId,
      processingProfile: "quick_reflection",
      leaseOwner: secondFence!.leaseOwner,
      attemptVersion: secondFence!.attemptVersion
    });
    expect(bound.reflection).toMatchObject({
      uploadId,
      processingProfile: "quick_reflection",
      version: uploading.version + 2
    });
    expect(bound.processingPlan).toMatchObject({ uploadId, processingProfile: "quick_reflection" });
    expect(repository.getProvisionalUploadOwnership(created.accountId, reflectionId))
      .toBeNull();
    expect(repository.findReflectionByUpload(created.accountId, uploadId))
      .toMatchObject({ id: reflectionId, accountId: created.accountId });
  });

  it("keeps file uploads full and rejects browser plans without an authoritative bind", () => {
    expect(() => repository.createReflection(createInput({
      processingProfile: "quick_reflection"
    }))).toThrowError(expect.objectContaining({
      code: "daily_reflection_file_upload_requires_full_recording"
    }));
    expect(() => repository.createReflection(createInput({
      inputMethod: "browser_recording",
      sourceOrigin: "user_reflection",
      processingProfile: "quick_reflection",
      uploadId: null
    }))).toThrowError(expect.objectContaining({
      code: "daily_reflection_browser_profile_requires_authoritative_duration"
    }));
    expect(() => repository.createReflection(createInput({
      inputMethod: "browser_recording",
      sourceOrigin: "user_reflection"
    }))).toThrowError(expect.objectContaining({
      code: "daily_reflection_browser_plan_requires_authoritative_duration"
    }));
  });

  it("enforces account isolation and optimistic status versions", () => {
    const created = repository.createReflection(createInput()).reflection;
    expect(repository.findReflection("account_2", created.id)).toBeNull();
    expect(() => repository.getReflection("account_2", created.id))
      .toThrow(DailyReflectionNotFoundError);
    expect(repository.getProcessingPlan("account_2", created.id)).toBeNull();
    expect(() => repository.listCandidates("account_2", created.id))
      .toThrow(DailyReflectionNotFoundError);
    expect(() => repository.transitionStatus({
      accountId: "account_2",
      reflectionId: created.id,
      expectedVersion: 0,
      status: "uploading"
    })).toThrow(DailyReflectionNotFoundError);

    const uploading = repository.transitionStatus({
      accountId: "account_1",
      reflectionId: created.id,
      expectedVersion: 0,
      status: "uploading"
    });
    expect(uploading.version).toBe(1);
    expect(() => repository.transitionStatus({
      accountId: "account_1",
      reflectionId: created.id,
      expectedVersion: 0,
      status: "transcribing"
    })).toThrowError(expect.objectContaining({
      code: "version_conflict",
      currentVersion: 1
    }));
  });

  it("keeps cancelled and deleted records as non-revivable tombstones", () => {
    const created = repository.createReflection(createInput()).reflection;
    const uploading = repository.transitionStatus({
      accountId: created.accountId,
      reflectionId: created.id,
      expectedVersion: created.version,
      status: "uploading"
    });
    const cancelled = repository.transitionStatus({
      accountId: uploading.accountId,
      reflectionId: uploading.id,
      expectedVersion: uploading.version,
      status: "cancelled"
    });
    expect(() => repository.transitionStatus({
      accountId: cancelled.accountId,
      reflectionId: cancelled.id,
      expectedVersion: cancelled.version,
      status: "review_pending"
    })).toThrow(DailyReflectionTransitionError);
    const deleted = repository.transitionStatus({
      accountId: cancelled.accountId,
      reflectionId: cancelled.id,
      expectedVersion: cancelled.version,
      status: "deleted"
    });
    expect(deleted.status).toBe("deleted");
    expect(() => repository.transitionStatus({
      accountId: deleted.accountId,
      reflectionId: deleted.id,
      expectedVersion: deleted.version,
      status: "created"
    })).toThrow(DailyReflectionTransitionError);

    const repeatedCreate = repository.createReflection(createInput({ id: "new_id" }));
    expect(repeatedCreate.reused).toBe(true);
    expect(repeatedCreate.reflection.status).toBe("deleted");
  });

  it("retains processing failure audit fields when the workflow is deleted", () => {
    const created = repository.createReflection(createInput()).reflection;
    const failed = repository.transitionStatus({
      accountId: created.accountId,
      reflectionId: created.id,
      expectedVersion: created.version,
      status: "failed",
      errorCode: "asr_failed",
      errorMessage: "transcription failed"
    });
    const deleted = repository.transitionStatus({
      accountId: failed.accountId,
      reflectionId: failed.id,
      expectedVersion: failed.version,
      status: "deleted"
    });
    expect(deleted).toMatchObject({
      status: "deleted",
      errorCode: "asr_failed",
      errorMessage: "transcription failed"
    });
  });

  it("retries a failed reflection only through the versioned retry entrypoint", () => {
    const created = repository.createReflection(createInput()).reflection;
    const failed = repository.transitionStatus({
      accountId: created.accountId,
      reflectionId: created.id,
      expectedVersion: created.version,
      status: "failed",
      errorCode: "asr_failed",
      errorMessage: "transcription failed"
    });

    expect(() => repository.transitionStatus({
      accountId: failed.accountId,
      reflectionId: failed.id,
      expectedVersion: failed.version,
      status: "transcribing"
    })).toThrow(DailyReflectionTransitionError);
    expect(() => repository.retryFailed({
      accountId: "account_2",
      reflectionId: failed.id,
      expectedVersion: failed.version,
      resumeStatus: "transcribing"
    })).toThrow(DailyReflectionNotFoundError);
    expect(() => repository.retryFailed({
      accountId: failed.accountId,
      reflectionId: failed.id,
      expectedVersion: failed.version - 1,
      resumeStatus: "transcribing"
    })).toThrowError(expect.objectContaining({
      code: "version_conflict",
      currentVersion: failed.version
    }));

    const retried = repository.retryFailed({
      accountId: failed.accountId,
      reflectionId: failed.id,
      expectedVersion: failed.version,
      resumeStatus: "transcribing"
    });
    expect(retried.reflection).toMatchObject({
      status: "transcribing",
      version: failed.version + 1,
      errorCode: null,
      errorMessage: null
    });
    expect(retried.processingPlan.uploadId).toBe("upload_1");
    expect(() => repository.retryFailed({
      accountId: retried.reflection.accountId,
      reflectionId: retried.reflection.id,
      expectedVersion: retried.reflection.version,
      resumeStatus: "extracting"
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_retry_requires_failed"
    }));
  });

  it("stores pending candidates once with fail-closed identity defaults", () => {
    const created = repository.createReflection(createInput()).reflection;
    const extracting = transitionPath(created, [
      "uploading",
      "transcribing",
      "extracting"
    ]);
    const candidateInput = [
      {
        id: "candidate_1",
        ordinal: 0,
        proposedText: "I may need to revisit the plan.",
        candidateType: "event" as const,
        sourceSegmentIds: ["segment_1", "segment_2"]
      },
      {
        id: "candidate_2",
        ordinal: 1,
        proposedText: "Ask whether the timing still works.",
        candidateType: "question" as const,
        sourceSegmentIds: ["segment_3"]
      }
    ];

    const saved = repository.savePendingCandidates({
      accountId: extracting.accountId,
      reflectionId: extracting.id,
      expectedVersion: extracting.version,
      candidates: candidateInput
    });
    expect(saved.reused).toBe(false);
    expect(saved.reflection.version).toBe(extracting.version + 1);
    expect(saved.candidates).toHaveLength(2);
    expect(saved.candidates[0]).toMatchObject({
      proposedText: "I may need to revisit the plan.",
      userText: null,
      status: "pending",
      subjectPersonId: null,
      subjectConfirmed: false,
      version: 0,
      sourceSegmentIds: ["segment_1", "segment_2"]
    });

    const reviewPending = repository.transitionStatus({
      accountId: saved.reflection.accountId,
      reflectionId: saved.reflection.id,
      expectedVersion: saved.reflection.version,
      status: "review_pending"
    });
    const repeated = repository.savePendingCandidates({
      accountId: reviewPending.accountId,
      reflectionId: reviewPending.id,
      expectedVersion: extracting.version,
      candidates: candidateInput
    });
    expect(repeated.reused).toBe(true);
    expect(repeated.candidates).toHaveLength(2);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM dr_candidates"
    ).get()).toEqual({ count: 2 });

    expect(() => database.prepare(`
      UPDATE dr_candidates SET proposed_text = 'overwritten' WHERE id = 'candidate_1'
    `).run()).toThrow(/daily_reflection_candidate_proposed_text_immutable/u);
    expect(repository.listCandidates("account_1", created.id)[0].proposedText)
      .toBe("I may need to revisit the plan.");
    expect(() => repository.savePendingCandidates({
      accountId: reviewPending.accountId,
      reflectionId: reviewPending.id,
      expectedVersion: reviewPending.version,
      candidates: [{ ...candidateInput[0], proposedText: "different" }, candidateInput[1]]
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_candidate_set_conflict"
    }));
  });

  it("rejects evidence-free candidates without partial writes", () => {
    const extracting = transitionPath(
      repository.createReflection(createInput()).reflection,
      ["uploading", "transcribing", "extracting"]
    );
    expect(() => repository.savePendingCandidates({
      accountId: extracting.accountId,
      reflectionId: extracting.id,
      expectedVersion: extracting.version,
      candidates: [{
        ordinal: 0,
        proposedText: "unsupported",
        candidateType: "summary",
        sourceSegmentIds: []
      }]
    })).toThrow();
    expect(repository.getReflection(extracting.accountId, extracting.id).version)
      .toBe(extracting.version);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM dr_candidates"
    ).get()).toEqual({ count: 0 });
  });

  it("enforces the frozen quick-reflection candidate maximum in persistence", () => {
    const created = repository.createReflection(createInput({
      uploadId: null,
      inputMethod: "browser_recording",
      sourceOrigin: "user_reflection",
      idempotencyKey: "quick_candidate_limit"
    })).reflection;
    const fence = repository.claimExecutionLease({
      accountId: created.accountId,
      reflectionId: created.id,
      leaseOwner: "quick_profile_probe",
      leaseDurationMs: 60_000,
      allowedStatuses: ["created"]
    });
    const bound = repository.bindUploadAndPlan({
      accountId: created.accountId,
      reflectionId: created.id,
      expectedVersion: created.version,
      uploadId: "upload_quick",
      processingProfile: "quick_reflection",
      leaseOwner: fence!.leaseOwner,
      attemptVersion: fence!.attemptVersion
    }).reflection;
    repository.releaseExecutionLease({
      accountId: created.accountId,
      reflectionId: created.id,
      leaseOwner: fence!.leaseOwner,
      attemptVersion: fence!.attemptVersion
    });
    const extracting = transitionPath(bound, [
      "uploading",
      "transcribing",
      "extracting"
    ]);
    expect(() => repository.savePendingCandidates({
      accountId: extracting.accountId,
      reflectionId: extracting.id,
      expectedVersion: extracting.version,
      candidates: Array.from({ length: 4 }, (_, ordinal) => ({
        ordinal,
        proposedText: `quick candidate ${ordinal + 1}`,
        candidateType: "summary" as const,
        sourceSegmentIds: [`segment_quick_${ordinal + 1}`]
      }))
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_quick_candidate_limit_exceeded"
    }));
    expect(repository.getReflection(extracting.accountId, extracting.id).version)
      .toBe(extracting.version);
    expect(repository.listCandidates(extracting.accountId, extracting.id)).toEqual([]);
  });

  it("rolls candidate, source, and reflection writes back as one transaction", () => {
    const extracting = transitionPath(
      repository.createReflection(createInput()).reflection,
      ["uploading", "transcribing", "extracting"]
    );
    database.exec(`
      CREATE TRIGGER dr_test_reject_second_source
      BEFORE INSERT ON dr_candidate_sources
      WHEN NEW.position = 1
      BEGIN
        SELECT RAISE(ABORT, 'forced_candidate_source_failure');
      END;
    `);

    expect(() => repository.savePendingCandidates({
      accountId: extracting.accountId,
      reflectionId: extracting.id,
      expectedVersion: extracting.version,
      candidates: [{
        id: "candidate_atomic",
        ordinal: 0,
        proposedText: "atomic candidate",
        candidateType: "summary",
        sourceSegmentIds: ["segment_1", "segment_2"]
      }]
    })).toThrow(/forced_candidate_source_failure/u);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM dr_candidates"
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM dr_candidate_sources"
    ).get()).toEqual({ count: 0 });
    expect(repository.getReflection(extracting.accountId, extracting.id).version)
      .toBe(extracting.version);
  });

  it("blocks candidate writes after a cancellation tombstone", () => {
    const extracting = transitionPath(
      repository.createReflection(createInput()).reflection,
      ["uploading", "transcribing", "extracting"]
    );
    const cancelled = repository.transitionStatus({
      accountId: extracting.accountId,
      reflectionId: extracting.id,
      expectedVersion: extracting.version,
      status: "cancelled"
    });
    expect(() => repository.savePendingCandidates({
      accountId: cancelled.accountId,
      reflectionId: cancelled.id,
      expectedVersion: cancelled.version,
      candidates: [{
        ordinal: 0,
        proposedText: "late candidate",
        candidateType: "event",
        sourceSegmentIds: ["segment_late"]
      }]
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_tombstoned"
    }));
    expect(repository.listCandidates(cancelled.accountId, cancelled.id)).toEqual([]);
  });

  it("lists only the requested account's non-deleted records in stable recent order", () => {
    repository.createReflection(createInput({
      id: "reflection_b",
      uploadId: "upload_b",
      idempotencyKey: "create_b"
    }));
    repository.createReflection(createInput({
      id: "reflection_a",
      uploadId: "upload_a",
      idempotencyKey: "create_a"
    }));
    repository.createReflection(createInput({
      id: "reflection_other",
      accountId: "account_2",
      uploadId: "upload_other",
      idempotencyKey: "create_other"
    }));
    const deleted = repository.createReflection(createInput({
      id: "reflection_deleted",
      uploadId: "upload_deleted",
      idempotencyKey: "create_deleted"
    })).reflection;
    repository.transitionStatus({
      accountId: deleted.accountId,
      reflectionId: deleted.id,
      expectedVersion: deleted.version,
      status: "deleted"
    });

    expect(repository.listAccountReflections("account_1", 2).map((item) => item.id))
      .toEqual(["reflection_b", "reflection_a"]);
    expect(repository.listAccountReflections("account_2").map((item) => item.id))
      .toEqual(["reflection_other"]);
    expect(() => repository.listAccountReflections("account_1", 25)).toThrow();
  });

  it("updates candidate decisions atomically with one optimistic reflection version", () => {
    const review = createReviewPendingCandidateSet();
    const updated = repository.updateCandidateDecisions({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      candidates: [
        {
          candidateId: "candidate_1",
          status: "kept",
          userText: "  I will contact Alice before Friday.  ",
          subjectPersonId: "person_alice"
        },
        {
          candidateId: "candidate_2",
          status: "excluded",
          userText: "   ",
          subjectPersonId: null
        }
      ]
    });

    expect(updated.reflection.version).toBe(review.reflection.version + 1);
    expect(updated.candidates).toEqual([
      expect.objectContaining({
        id: "candidate_1",
        proposedText: "Contact Alice before Friday.",
        userText: "I will contact Alice before Friday.",
        status: "kept",
        subjectPersonId: "person_alice",
        subjectConfirmed: true,
        version: 1
      }),
      expect.objectContaining({
        id: "candidate_2",
        proposedText: "Reconsider the travel plan.",
        userText: null,
        status: "excluded",
        subjectPersonId: null,
        subjectConfirmed: false,
        version: 1
      })
    ]);
    expect(() => repository.updateCandidateDecisions({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      candidates: [{
        candidateId: "candidate_1",
        status: "excluded",
        userText: null,
        subjectPersonId: null
      }]
    })).toThrowError(expect.objectContaining({ code: "version_conflict" }));
  });

  it("rolls back a candidate decision batch containing a foreign candidate", () => {
    const review = createReviewPendingCandidateSet();
    expect(() => repository.updateCandidateDecisions({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      candidates: [
        {
          candidateId: "candidate_1",
          status: "kept",
          userText: null,
          subjectPersonId: null
        },
        {
          candidateId: "candidate_from_another_reflection",
          status: "excluded",
          userText: null,
          subjectPersonId: null
        }
      ]
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_candidate_mismatch"
    }));
    expect(repository.getReflection(review.reflection.accountId, review.reflection.id).version)
      .toBe(review.reflection.version);
    expect(repository.listCandidates(review.reflection.accountId, review.reflection.id))
      .toEqual([
        expect.objectContaining({ id: "candidate_1", status: "pending", version: 0 }),
        expect.objectContaining({ id: "candidate_2", status: "pending", version: 0 })
      ]);
  });

  it("creates one immutable confirmation and reuses the exact finalize request", () => {
    const review = createReviewPendingCandidateSet();
    const decided = repository.updateCandidateDecisions({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      candidates: [
        {
          candidateId: "candidate_1",
          status: "kept",
          userText: "I will contact Alice tomorrow.",
          subjectPersonId: "person_alice"
        },
        {
          candidateId: "candidate_2",
          status: "excluded",
          userText: null,
          subjectPersonId: null
        }
      ]
    });
    const finalized = repository.finalizeReview({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: decided.reflection.version,
      idempotencyKey: "finalize_1"
    });

    expect(finalized.reused).toBe(false);
    expect(finalized.confirmation).toMatchObject({
      reflectionId: review.reflection.id,
      sourceOrigin: "user_reflection",
      idempotencyKey: "finalize_1",
      candidateSnapshots: [
        {
          candidateId: "candidate_1",
          proposedText: "Contact Alice before Friday.",
          userText: "I will contact Alice tomorrow.",
          finalText: "I will contact Alice tomorrow.",
          status: "kept",
          sourceSegmentIds: ["segment_1"],
          subjectPersonId: "person_alice"
        },
        {
          candidateId: "candidate_2",
          proposedText: "Reconsider the travel plan.",
          userText: null,
          finalText: "Reconsider the travel plan.",
          status: "excluded",
          sourceSegmentIds: ["segment_2"],
          subjectPersonId: null
        }
      ]
    });
    expect(finalized.operation).toMatchObject({
      status: "confirmation_ready",
      excludedCount: 1
    });
    expect(repository.getReflection(review.reflection.accountId, review.reflection.id).status)
      .toBe("confirmation_ready");
    expect(repository.finalizeReview({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: decided.reflection.version,
      idempotencyKey: "finalize_1"
    })).toEqual({ ...finalized, reused: true });
    expect(() => repository.finalizeReview({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: decided.reflection.version + 1,
      idempotencyKey: "finalize_1"
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_finalize_idempotency_conflict"
    }));
    expect(() => repository.updateCandidateDecisions({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: decided.reflection.version + 1,
      candidates: [{
        candidateId: "candidate_1",
        status: "excluded",
        userText: null,
        subjectPersonId: null
      }]
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_review_not_editable"
    }));
    expect(() => database.prepare(`
      UPDATE dr_reflection_confirmations SET source_origin = 'unknown'
      WHERE reflection_id = 'reflection_1'
    `).run()).toThrow(/daily_reflection_confirmation_immutable/u);
  });

  it("requires every candidate decision and completes an all-excluded review with zero receipts", () => {
    const review = createReviewPendingCandidateSet();
    expect(() => repository.finalizeReview({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      idempotencyKey: "pending_finalize"
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_candidates_pending"
    }));
    const decided = repository.updateCandidateDecisions({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      candidates: review.candidates.map((candidate) => ({
        candidateId: candidate.id,
        status: "excluded" as const,
        userText: null,
        subjectPersonId: null
      }))
    });
    repository.finalizeReview({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: decided.reflection.version,
      idempotencyKey: "all_excluded"
    });
    const claim = repository.startAdmissionOperation({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      leaseOwner: "admission_worker_1",
      leaseDurationMs: 60_000
    });
    if (!claim.executionFence) throw new Error("expected admission fence");
    const completed = repository.completeAdmissionOperation({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      leaseOwner: claim.executionFence.leaseOwner,
      attemptVersion: claim.executionFence.attemptVersion,
      results: []
    });

    expect(completed).toMatchObject({
      reused: false,
      results: [],
      operation: {
        status: "completed",
        admittedCount: 0,
        rejectedCount: 0,
        excludedCount: 2
      }
    });
    expect(repository.getReflection(review.reflection.accountId, review.reflection.id).status)
      .toBe("completed");
    expect(repository.completeAdmissionOperation({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      leaseOwner: claim.executionFence.leaseOwner,
      attemptVersion: claim.executionFence.attemptVersion,
      results: []
    })).toMatchObject({ reused: true, results: [] });
  });

  it("fences admission retries so stale workers cannot overwrite receipts or terminal state", () => {
    const review = createReviewPendingCandidateSet();
    const decided = repository.updateCandidateDecisions({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      candidates: [
        {
          candidateId: "candidate_1",
          status: "kept",
          userText: null,
          subjectPersonId: null
        },
        {
          candidateId: "candidate_2",
          status: "excluded",
          userText: null,
          subjectPersonId: null
        }
      ]
    });
    repository.finalizeReview({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: decided.reflection.version,
      idempotencyKey: "fenced_admission"
    });
    const first = repository.startAdmissionOperation({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      leaseOwner: "admission_worker_old",
      leaseDurationMs: 60_000
    });
    if (!first.executionFence) throw new Error("expected first admission fence");
    const retryableResult = {
      candidateId: "candidate_1",
      status: "retryable_error" as const,
      memoryId: null,
      reasonCode: null,
      errorCode: "memory_unavailable",
      operationKey: "daily-reflection:confirmation:candidate_1",
      updatedAt: timestamp
    };
    repository.failAdmissionOperation({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      leaseOwner: first.executionFence.leaseOwner,
      attemptVersion: first.executionFence.attemptVersion,
      errorCode: "memory_unavailable",
      results: [retryableResult]
    });
    const second = repository.startAdmissionOperation({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      leaseOwner: "admission_worker_new",
      leaseDurationMs: 60_000
    });
    if (!second.executionFence) throw new Error("expected second admission fence");
    expect(second.executionFence.attemptVersion)
      .toBe(first.executionFence.attemptVersion + 1);

    expect(() => repository.failAdmissionOperation({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      leaseOwner: first.executionFence!.leaseOwner,
      attemptVersion: first.executionFence!.attemptVersion,
      errorCode: "stale_failure",
      results: [{ ...retryableResult, errorCode: "stale_failure" }]
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_admission_lease_lost"
    }));
    expect(() => repository.completeAdmissionOperation({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      leaseOwner: first.executionFence!.leaseOwner,
      attemptVersion: first.executionFence!.attemptVersion,
      results: [{
        candidateId: "candidate_1",
        status: "admitted",
        memoryId: "memory_stale",
        reasonCode: null,
        errorCode: null,
        operationKey: retryableResult.operationKey,
        updatedAt: timestamp
      }]
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_admission_lease_lost"
    }));
    expect(repository.getAdmissionOperation(review.reflection.accountId, review.reflection.id))
      .toMatchObject({ status: "admitting" });
    expect(repository.listAdmissionResults(
      review.reflection.accountId,
      second.operation.id
    )).toEqual([expect.objectContaining({ errorCode: "memory_unavailable" })]);

    repository.completeAdmissionOperation({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      leaseOwner: second.executionFence.leaseOwner,
      attemptVersion: second.executionFence.attemptVersion,
      results: [{
        candidateId: "candidate_1",
        status: "admitted",
        memoryId: "memory_1",
        reasonCode: null,
        errorCode: null,
        operationKey: retryableResult.operationKey,
        updatedAt: timestamp
      }]
    });
    repository.failAdmissionOperation({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      leaseOwner: first.executionFence.leaseOwner,
      attemptVersion: first.executionFence.attemptVersion,
      errorCode: "very_late_failure",
      results: [{ ...retryableResult, errorCode: "very_late_failure" }]
    });
    expect(repository.getAdmissionOperation(review.reflection.accountId, review.reflection.id))
      .toMatchObject({ status: "completed", admittedCount: 1 });
    expect(repository.listAdmissionResults(
      review.reflection.accountId,
      second.operation.id
    )).toEqual([expect.objectContaining({
      status: "admitted",
      memoryId: "memory_1",
      errorCode: null
    })]);
  });

  it("freezes canonical Evidence at review and rejects late asset publication", () => {
    const created = repository.createReflection(createInput({
      sourceOrigin: "user_reflection",
      idempotencyKey: "evidence_freeze"
    })).reflection;
    const extracting = transitionPath(created, ["uploading", "transcribing", "extracting"]);
    const fence = repository.claimExecutionLease({
      accountId: created.accountId,
      reflectionId: created.id,
      leaseOwner: "late_staging_worker",
      leaseDurationMs: 60_000,
      allowedStatuses: ["extracting"]
    });
    if (!fence) throw new Error("expected staging fence");
    const originalSegment = {
      id: "segment_immutable",
      uploadId: "upload_1",
      startSeconds: 0,
      endSeconds: 9,
      text: "The canonical wording stays unchanged.",
      confidence: 0.99,
      sceneLabels: [],
      valueLabels: []
    };
    repository.publishAssetUnderExecutionFence({
      accountId: created.accountId,
      reflectionId: created.id,
      leaseOwner: fence.leaseOwner,
      attemptVersion: fence.attemptVersion,
      assetKind: "segments",
      payload: [originalSegment]
    });
    const saved = repository.savePendingCandidates({
      accountId: created.accountId,
      reflectionId: created.id,
      expectedVersion: extracting.version,
      leaseOwner: fence.leaseOwner,
      attemptVersion: fence.attemptVersion,
      candidates: [{
        id: "candidate_immutable",
        ordinal: 0,
        proposedText: "The canonical wording stays unchanged.",
        candidateType: "summary",
        sourceSegmentIds: [originalSegment.id]
      }]
    });
    const reviewPending = repository.transitionStatus({
      accountId: created.accountId,
      reflectionId: created.id,
      expectedVersion: saved.reflection.version,
      status: "review_pending",
      leaseOwner: fence.leaseOwner,
      attemptVersion: fence.attemptVersion
    });
    expect(() => repository.publishAssetUnderExecutionFence({
      accountId: created.accountId,
      reflectionId: created.id,
      leaseOwner: fence.leaseOwner,
      attemptVersion: fence.attemptVersion,
      assetKind: "segments",
      payload: [{ ...originalSegment, text: "Late replacement." }]
    })).toThrow(DailyReflectionLeaseLostError);
    const decided = repository.updateCandidateDecisions({
      accountId: created.accountId,
      reflectionId: created.id,
      expectedVersion: reviewPending.version,
      candidates: [{
        candidateId: "candidate_immutable",
        status: "kept",
        userText: null,
        subjectPersonId: null
      }]
    });
    const finalized = repository.finalizeReview({
      accountId: created.accountId,
      reflectionId: created.id,
      expectedVersion: decided.reflection.version,
      idempotencyKey: "evidence_freeze_finalize"
    });
    expect(finalized.confirmation.candidateSnapshots[0].evidenceSnapshots)
      .toEqual([{
        sourceSegmentId: originalSegment.id,
        uploadId: originalSegment.uploadId,
        startSeconds: originalSegment.startSeconds,
        endSeconds: originalSegment.endSeconds,
        text: originalSegment.text,
        effectiveOrigin: "user_reflection"
      }]);
    expect(() => repository.transitionStatus({
      accountId: created.accountId,
      reflectionId: created.id,
      expectedVersion: decided.reflection.version + 1,
      status: "cancelled"
    })).toThrow(DailyReflectionTransitionError);
    expect(() => repository.deleteCandidates(created.accountId, created.id))
      .toThrow(/daily_reflection_candidate_finalized/u);
  });

  it("publishes only the owned failed upload while the failing worker still holds its fence", () => {
    const created = repository.createReflection(createInput({
      sourceOrigin: "user_reflection"
    })).reflection;
    const extracting = transitionPath(created, [
      "uploading",
      "transcribing",
      "extracting"
    ]);
    const fence = repository.claimExecutionLease({
      accountId: created.accountId,
      reflectionId: created.id,
      leaseOwner: "failing_staging_worker",
      leaseDurationMs: 60_000,
      allowedStatuses: ["extracting"]
    });
    if (!fence) throw new Error("expected failing worker fence");
    repository.transitionStatus({
      accountId: created.accountId,
      reflectionId: created.id,
      expectedVersion: extracting.version,
      status: "failed",
      errorCode: "daily_reflection_processing_failed",
      errorMessage: "Daily Reflection staging failed",
      leaseOwner: fence.leaseOwner,
      attemptVersion: fence.attemptVersion
    });
    const failedUpload = {
      id: "upload_1",
      originalName: "reflection.wav",
      mimeType: "audio/wav",
      sizeBytes: 5,
      recordingDate: "2026-08-13",
      createdAt: timestamp,
      status: "failed" as const,
      filePath: "C:/daily-brief/uploads/upload_1.wav",
      ingestionContext: "daily_reflection" as const,
      reflectionId: created.id,
      errorCode: "daily_reflection_processing_failed",
      errorMessage: "Daily Reflection staging failed"
    };
    const publish = (assetKind: "upload" | "segments", payload: unknown) =>
      repository.publishAssetUnderExecutionFence({
        accountId: created.accountId,
        reflectionId: created.id,
        leaseOwner: fence.leaseOwner,
        attemptVersion: fence.attemptVersion,
        assetKind,
        payload
      });

    expect(() => publish("segments", [])).toThrow(DailyReflectionLeaseLostError);
    expect(() => publish("upload", { ...failedUpload, status: "extracting" }))
      .toThrow(DailyReflectionLeaseLostError);
    expect(() => publish("upload", { ...failedUpload, reflectionId: "reflection_other" }))
      .toThrow(DailyReflectionLeaseLostError);
    expect(() => publish("upload", { ...failedUpload, id: "upload_other" }))
      .toThrow(DailyReflectionLeaseLostError);
    expect(() => publish("upload", {
      ...failedUpload,
      errorCode: "daily_reflection_other_failure"
    })).toThrow(DailyReflectionLeaseLostError);

    expect(() => publish("upload", failedUpload)).not.toThrow();
    expect(repository.readPublishedAsset({
      accountId: created.accountId,
      reflectionId: created.id,
      assetKind: "upload"
    })).toEqual(failedUpload);

    repository.releaseExecutionLease({
      accountId: created.accountId,
      reflectionId: created.id,
      leaseOwner: fence.leaseOwner,
      attemptVersion: fence.attemptVersion
    });
    expect(() => publish("upload", failedUpload)).toThrow(DailyReflectionLeaseLostError);
  });

  it("lists unfinished review finalization for recovery but excludes settled states", () => {
    const created = repository.createReflection(createInput()).reflection;
    const reviewPending = transitionPath(created, [
      "uploading",
      "transcribing",
      "extracting",
      "review_pending"
    ]);
    const failed = transitionPath(repository.createReflection(createInput({
      id: "reflection_failed_recovery",
      uploadId: "upload_failed_recovery",
      idempotencyKey: "failed_recovery"
    })).reflection, ["uploading", "failed"]);
    const cancelled = transitionPath(repository.createReflection(createInput({
      id: "reflection_cancelled_recovery",
      uploadId: "upload_cancelled_recovery",
      idempotencyKey: "cancelled_recovery"
    })).reflection, ["cancelled"]);
    const deleted = transitionPath(repository.createReflection(createInput({
      id: "reflection_deleted_recovery",
      uploadId: "upload_deleted_recovery",
      idempotencyKey: "deleted_recovery"
    })).reflection, ["deleted"]);

    const recoverableIds = repository.listRecoverableReflections()
      .map(({ reflection }) => reflection.id);

    expect(recoverableIds).toContain(reviewPending.id);
    expect(recoverableIds).not.toEqual(expect.arrayContaining([
      failed.id,
      cancelled.id,
      deleted.id
    ]));
  });

  it("fences dual repositories and rejects stale writers after an expired takeover", () => {
    const root = mkdtempSync(join(tmpdir(), "daily-reflection-lease-"));
    const filePath = join(root, "daily-reflection.sqlite");
    const databaseA = openDailyReflectionDatabase({ filePath });
    const databaseB = openDailyReflectionDatabase({ filePath });
    try {
      let leaseNow = "2026-08-13T00:00:00.000Z";
      const repositoryA = new DailyReflectionRepository(databaseA, {
        now: () => leaseNow
      });
      const repositoryB = new DailyReflectionRepository(databaseB, {
        now: () => leaseNow
      });
      const created = repositoryA.createReflection(createInput({
        id: "reflection_fenced",
        uploadId: "upload_fenced",
        idempotencyKey: "fenced"
      })).reflection;
      const uploading = repositoryA.transitionStatus({
        accountId: created.accountId,
        reflectionId: created.id,
        expectedVersion: created.version,
        status: "uploading"
      });
      const firstFence = repositoryA.claimExecutionLease({
        accountId: created.accountId,
        reflectionId: created.id,
        leaseOwner: "worker_a",
        leaseDurationMs: 1_000,
        uploadFingerprint: "a".repeat(64),
        allowedStatuses: ["uploading"],
        now: "2026-08-13T00:00:00.000Z"
      });
      expect(firstFence).not.toBeNull();
      expect(repositoryB.claimExecutionLease({
        accountId: created.accountId,
        reflectionId: created.id,
        leaseOwner: "worker_b_early",
        leaseDurationMs: 1_000,
        uploadFingerprint: "a".repeat(64),
        allowedStatuses: ["uploading"],
        now: "2026-08-13T00:00:00.500Z"
      })).toBeNull();

      const secondFence = repositoryB.claimExecutionLease({
        accountId: created.accountId,
        reflectionId: created.id,
        leaseOwner: "worker_b",
        leaseDurationMs: 5_000,
        uploadFingerprint: "a".repeat(64),
        allowedStatuses: ["uploading"],
        now: "2026-08-13T00:00:02.000Z"
      });
      leaseNow = "2026-08-13T00:00:02.100Z";
      expect(secondFence).toMatchObject({
        leaseOwner: "worker_b",
        attemptVersion: firstFence!.attemptVersion + 1
      });
      repositoryB.publishAssetUnderExecutionFence({
        accountId: created.accountId,
        reflectionId: created.id,
        leaseOwner: secondFence!.leaseOwner,
        attemptVersion: secondFence!.attemptVersion,
        assetKind: "upload",
        payload: { id: "upload_fenced", writer: "winner" }
      });
      expect(() => repositoryA.publishAssetUnderExecutionFence({
        accountId: created.accountId,
        reflectionId: created.id,
        leaseOwner: firstFence!.leaseOwner,
        attemptVersion: firstFence!.attemptVersion,
        assetKind: "upload",
        payload: { id: "upload_fenced", writer: "stale" }
      })).toThrow(DailyReflectionLeaseLostError);
      expect(repositoryB.readPublishedAsset({
        accountId: created.accountId,
        reflectionId: created.id,
        assetKind: "upload"
      })).toEqual({ id: "upload_fenced", writer: "winner" });
      expect(repositoryA.getUploadFingerprint(created.accountId, created.id))
        .toBe("a".repeat(64));
      expect(() => repositoryA.transitionStatus({
        accountId: created.accountId,
        reflectionId: created.id,
        expectedVersion: uploading.version,
        status: "transcribing",
        leaseOwner: firstFence!.leaseOwner,
        attemptVersion: firstFence!.attemptVersion
      })).toThrow(DailyReflectionLeaseLostError);
      expect(repositoryA.releaseExecutionLease({
        accountId: created.accountId,
        reflectionId: created.id,
        leaseOwner: firstFence!.leaseOwner,
        attemptVersion: firstFence!.attemptVersion
      })).toBe(false);

      const transcribing = repositoryB.transitionStatus({
        accountId: created.accountId,
        reflectionId: created.id,
        expectedVersion: uploading.version,
        status: "transcribing",
        leaseOwner: secondFence!.leaseOwner,
        attemptVersion: secondFence!.attemptVersion
      });
      const extracting = repositoryB.transitionStatus({
        accountId: created.accountId,
        reflectionId: created.id,
        expectedVersion: transcribing.version,
        status: "extracting",
        leaseOwner: secondFence!.leaseOwner,
        attemptVersion: secondFence!.attemptVersion
      });
      expect(() => repositoryA.savePendingCandidates({
        accountId: created.accountId,
        reflectionId: created.id,
        expectedVersion: extracting.version,
        leaseOwner: firstFence!.leaseOwner,
        attemptVersion: firstFence!.attemptVersion,
        candidates: [{
          ordinal: 0,
          proposedText: "stale candidate",
          candidateType: "summary",
          sourceSegmentIds: ["segment_stale"]
        }]
      })).toThrow(DailyReflectionLeaseLostError);
      expect(repositoryB.listCandidates(created.accountId, created.id)).toEqual([]);
      repositoryB.savePendingCandidates({
        accountId: created.accountId,
        reflectionId: created.id,
        expectedVersion: extracting.version,
        leaseOwner: secondFence!.leaseOwner,
        attemptVersion: secondFence!.attemptVersion,
        candidates: [{
          ordinal: 0,
          proposedText: "winning candidate",
          candidateType: "summary",
          sourceSegmentIds: ["segment_winner"]
        }]
      });
      expect(repositoryB.listCandidates(created.accountId, created.id))
        .toEqual([expect.objectContaining({ proposedText: "winning candidate" })]);
    } finally {
      databaseB.close();
      databaseA.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fences candidate revocation and preserves immutable admission history", () => {
    const completed = createCompletedCandidateSet();
    const request = {
      accountId: completed.accountId,
      reflectionId: completed.id,
      candidateId: "candidate_1",
      expectedVersion: completed.version,
      idempotencyKey: "revoke_candidate_1",
      now: timestamp
    };
    const prepared = repository.prepareCandidateRevocation(request);
    expect(prepared).toMatchObject({
      reused: false,
      receipt: null,
      operation: {
        status: "ready",
        admissionStatus: "admitted",
        memoryId: "memory_candidate_1"
      }
    });
    expect(repository.prepareCandidateRevocation(request)).toMatchObject({ reused: true });
    expect(() => repository.prepareCandidateRevocation({
      ...request,
      expectedVersion: completed.version + 1
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_candidate_revocation_idempotency_conflict"
    }));

    const first = repository.startCandidateRevocation({
      accountId: completed.accountId,
      reflectionId: completed.id,
      candidateId: "candidate_1",
      leaseOwner: "revocation_first",
      leaseDurationMs: 60_000,
      now: timestamp
    });
    expect(first.executionFence).toMatchObject({ attemptVersion: 1 });
    expect(() => repository.startCandidateRevocation({
      accountId: completed.accountId,
      reflectionId: completed.id,
      candidateId: "candidate_1",
      leaseOwner: "revocation_second",
      leaseDurationMs: 60_000,
      now: timestamp
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_candidate_revocation_busy"
    }));
    repository.failCandidateRevocation({
      accountId: completed.accountId,
      reflectionId: completed.id,
      candidateId: "candidate_1",
      leaseOwner: first.executionFence!.leaseOwner,
      attemptVersion: first.executionFence!.attemptVersion,
      errorCode: "memory_apply_interrupted",
      now: timestamp
    });
    const retry = repository.startCandidateRevocation({
      accountId: completed.accountId,
      reflectionId: completed.id,
      candidateId: "candidate_1",
      leaseOwner: "revocation_retry",
      leaseDurationMs: 60_000,
      now: timestamp
    });
    expect(retry.executionFence).toMatchObject({ attemptVersion: 2 });
    expect(() => repository.completeCandidateRevocation({
      accountId: completed.accountId,
      reflectionId: completed.id,
      candidateId: "candidate_1",
      leaseOwner: first.executionFence!.leaseOwner,
      attemptVersion: first.executionFence!.attemptVersion,
      result: {
        outcome: "revoked",
        memoryId: "memory_candidate_1",
        removedMemoryEvidenceCount: 1,
        removedPersonSourceCount: 0
      },
      indexRefreshRequired: false,
      now: timestamp
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_candidate_revocation_lease_lost"
    }));
    const done = repository.completeCandidateRevocation({
      accountId: completed.accountId,
      reflectionId: completed.id,
      candidateId: "candidate_1",
      leaseOwner: retry.executionFence!.leaseOwner,
      attemptVersion: retry.executionFence!.attemptVersion,
      result: {
        outcome: "revoked",
        memoryId: "memory_candidate_1",
        removedMemoryEvidenceCount: 1,
        removedPersonSourceCount: 0
      },
      indexRefreshRequired: true,
      now: timestamp
    });
    expect(done).toMatchObject({
      operation: { status: "completed", indexRefreshStatus: "pending" },
      receipt: { outcome: "revoked", memoryId: "memory_candidate_1" }
    });
    expect(repository.getRememberedCandidateCount(completed.accountId, completed.id)).toBe(0);
    expect(repository.listCandidates(completed.accountId, completed.id))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "candidate_1", status: "kept" })
      ]));
    expect(repository.getConfirmation(completed.accountId, completed.id)?.candidateSnapshots)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ candidateId: "candidate_1", status: "kept" })
      ]));
    expect(repository.getAdmissionOperation(completed.accountId, completed.id))
      .toMatchObject({ status: "completed", admittedCount: 1 });
  });

  it("returns a no-op receipt for rejected candidates and lets whole delete win", () => {
    const completed = createCompletedCandidateSet();
    const noObject = repository.prepareCandidateRevocation({
      accountId: completed.accountId,
      reflectionId: completed.id,
      candidateId: "candidate_2",
      expectedVersion: completed.version,
      idempotencyKey: "revoke_rejected_candidate",
      now: timestamp
    });
    expect(noObject).toMatchObject({
      operation: { status: "completed", admissionStatus: "rejected" },
      receipt: { outcome: "no_long_term_object" }
    });

    const current = repository.getReflection(completed.accountId, completed.id);
    repository.prepareCandidateRevocation({
      accountId: completed.accountId,
      reflectionId: completed.id,
      candidateId: "candidate_1",
      expectedVersion: current.version,
      idempotencyKey: "revoke_then_delete",
      now: timestamp
    });
    repository.markAdmissionDeleteRequested(completed.accountId, completed.id);
    expect(() => repository.startCandidateRevocation({
      accountId: completed.accountId,
      reflectionId: completed.id,
      candidateId: "candidate_1",
      leaseOwner: "late_revocation",
      leaseDurationMs: 60_000,
      now: timestamp
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_delete_requested"
    }));
    expect(() => repository.prepareCandidateRevocation({
      accountId: "account_other",
      reflectionId: completed.id,
      candidateId: "candidate_1",
      expectedVersion: current.version,
      idempotencyKey: "cross_account_revocation",
      now: timestamp
    })).toThrow(DailyReflectionNotFoundError);
  });
});
