import { describe, expect, it } from "vitest";

import {
  DailyReflectionDetailResponseSchema,
  DailyReflectionUploadSourceSchema
} from "./daily-reflection-api";

function detailResponse() {
  return {
    reflection: {
      id: "reflection_detail_contract",
      accountId: "account_detail_contract",
      uploadId: "upload_detail_contract",
      inputMethod: "file_upload",
      sourceOrigin: "manual_note",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      status: "review_pending",
      version: 4,
      idempotencyKey: "detail-contract",
      errorCode: null,
      errorMessage: null,
      createdAt: "2026-08-13T08:00:00.000Z",
      updatedAt: "2026-08-13T08:04:00.000Z"
    },
    processingPlan: {
      planVersion: 1,
      reflectionId: "reflection_detail_contract",
      uploadId: "upload_detail_contract",
      inputMethod: "file_upload",
      sourceOrigin: "manual_note",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      reviewPolicy: "required"
    },
    job: {
      id: "job_detail_contract",
      reflectionId: "reflection_detail_contract",
      uploadId: "upload_detail_contract",
      status: "completed",
      progress: 100,
      executionMode: "inline",
      updatedAt: "2026-08-13T08:04:00.000Z",
      finishedAt: "2026-08-13T08:04:00.000Z"
    },
    upload: {
      id: "upload_detail_contract",
      originalName: "refreshed-name.wav",
      mimeType: "audio/wav",
      sizeBytes: 2048,
      recordingDate: "2026-08-13",
      createdAt: "2026-08-13T08:00:00.000Z",
      durationSeconds: 16,
      status: "ready"
    },
    segments: [{
      id: "segment_detail_contract",
      uploadId: "upload_detail_contract",
      startSeconds: 0,
      endSeconds: 8,
      text: "Canonical transcript text.",
      confidence: 0.97,
      sceneLabels: [],
      valueLabels: []
    }],
    effectiveOrigin: "manual_note",
    confirmation: null,
    admissionOperation: null,
    admissionResults: [],
    candidates: [{
      id: "candidate_detail_contract",
      reflectionId: "reflection_detail_contract",
      ordinal: 0,
      proposedText: "Evidence-backed candidate.",
      userText: null,
      status: "pending",
      candidateType: "summary",
      sourceSegmentIds: ["segment_detail_contract"],
      subjectPersonId: null,
      subjectConfirmed: false,
      version: 0,
      createdAt: "2026-08-13T08:04:00.000Z",
      updatedAt: "2026-08-13T08:04:00.000Z",
      evidence: [{
        sourceSegmentId: "segment_detail_contract",
        uploadId: "upload_detail_contract",
        effectiveOrigin: "manual_note",
        startSeconds: 0,
        endSeconds: 8,
        text: "Canonical transcript text."
      }]
    }]
  };
}

describe("DailyReflectionUploadSourceSchema", () => {
  it("accepts only the three explicit public file-upload origins", () => {
    expect(DailyReflectionUploadSourceSchema.options).toEqual([
      "user_reflection",
      "direct_conversation",
      "unknown"
    ]);
    for (const sourceOrigin of [
      "user_reflection",
      "direct_conversation",
      "unknown"
    ]) {
      expect(DailyReflectionUploadSourceSchema.safeParse(sourceOrigin).success).toBe(true);
    }
    for (const sourceOrigin of [
      "manual_note",
      "ai_derived_observation",
      "legacy_unknown",
      "future_external_source"
    ]) {
      expect(DailyReflectionUploadSourceSchema.safeParse(sourceOrigin).success).toBe(false);
    }
  });
});

describe("DailyReflectionDetailResponseSchema", () => {
  it("strictly parses the complete client-safe detail contract", () => {
    expect(DailyReflectionDetailResponseSchema.parse(detailResponse())).toEqual(
      detailResponse()
    );
  });

  it("rejects forged fields and data that crosses canonical boundaries", () => {
    const detail = detailResponse();

    expect(DailyReflectionDetailResponseSchema.safeParse({
      ...detail,
      upload: { ...detail.upload, filePath: "C:\\private\\reflection.wav" }
    }).success).toBe(false);
    expect(DailyReflectionDetailResponseSchema.safeParse({
      ...detail,
      job: { ...detail.job, leaseOwner: "secret-lease" }
    }).success).toBe(false);
    expect(DailyReflectionDetailResponseSchema.safeParse({
      ...detail,
      segments: [{ ...detail.segments[0], uploadId: "upload_other" }]
    }).success).toBe(false);
    expect(DailyReflectionDetailResponseSchema.safeParse({
      ...detail,
      candidates: [{
        ...detail.candidates[0],
        sourceSegmentIds: ["segment_missing"]
      }]
    }).success).toBe(false);
    expect(DailyReflectionDetailResponseSchema.safeParse({
      ...detail,
      effectiveOrigin: "direct_conversation"
    }).success).toBe(false);
    expect(DailyReflectionDetailResponseSchema.safeParse({
      ...detail,
      stack: "internal stack"
    }).success).toBe(false);
  });

  it("accepts only a consistent durable candidate revocation overlay", () => {
    const base = detailResponse();
    const candidate = {
      ...base.candidates[0],
      status: "kept" as const
    };
    const confirmation = {
      id: "confirmation_detail_contract",
      reflectionId: base.reflection.id,
      accountId: base.reflection.accountId,
      fingerprint: "a".repeat(64),
      requestFingerprint: "b".repeat(64),
      idempotencyKey: "confirmation-detail-contract",
      sourceOrigin: "manual_note" as const,
      inputMethod: "file_upload" as const,
      processingProfile: "full_recording" as const,
      candidateSnapshots: [{
        candidateId: candidate.id,
        proposedText: candidate.proposedText,
        userText: null,
        finalText: candidate.proposedText,
        status: "kept" as const,
        candidateType: candidate.candidateType,
        sourceSegmentIds: candidate.sourceSegmentIds,
        evidenceSnapshots: candidate.evidence,
        subjectPersonId: null
      }],
      createdAt: "2026-08-13T08:05:00.000Z"
    };
    const completed = {
      ...base,
      reflection: { ...base.reflection, status: "completed" as const, version: 9 },
      candidates: [candidate],
      confirmation,
      admissionOperation: {
        id: "operation_detail_contract",
        reflectionId: base.reflection.id,
        confirmationId: confirmation.id,
        accountId: base.reflection.accountId,
        status: "completed" as const,
        admittedCount: 1,
        rejectedCount: 0,
        excludedCount: 0,
        errorCode: null,
        createdAt: "2026-08-13T08:05:00.000Z",
        updatedAt: "2026-08-13T08:05:00.000Z",
        completedAt: "2026-08-13T08:05:00.000Z"
      },
      admissionResults: [{
        candidateId: candidate.id,
        status: "admitted" as const,
        memoryId: "memory_detail_contract",
        reasonCode: null,
        errorCode: null,
        operationKey: "operation-candidate-detail-contract",
        updatedAt: "2026-08-13T08:05:00.000Z"
      }],
      rememberedCount: 0,
      revokedCandidateIds: [candidate.id]
    };

    expect(DailyReflectionDetailResponseSchema.safeParse(completed).success).toBe(true);
    expect(DailyReflectionDetailResponseSchema.safeParse({
      ...completed,
      rememberedCount: 1
    }).success).toBe(false);
    expect(DailyReflectionDetailResponseSchema.safeParse({
      ...completed,
      revokedCandidateIds: ["candidate_not_admitted"]
    }).success).toBe(false);
    expect(DailyReflectionDetailResponseSchema.safeParse({
      ...completed,
      revokedCandidateIds: [candidate.id, candidate.id]
    }).success).toBe(false);
  });
});
