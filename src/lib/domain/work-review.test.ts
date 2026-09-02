import { describe, expect, it } from "vitest";

import {
  ReviewWorkCandidateRequestSchema,
  WorkCanonicalPublicationSchema,
  WorkCanonicalSegmentsSchema,
  WorkMeetingCandidateStructuredDataSchema,
  WorkMeetingSchema,
  WorkReviewDateSchema
} from "./work-review";

function segment(id: string, uploadId = "upload_1", startSeconds = 0) {
  return {
    id,
    uploadId,
    startSeconds,
    endSeconds: startSeconds + 1,
    speaker: "Speaker 1",
    text: `canonical ${id}`,
    confidence: 0.9,
    sceneLabels: [],
    valueLabels: []
  };
}

describe("Work Review domain", () => {
  it("accepts only real calendar dates", () => {
    expect(WorkReviewDateSchema.parse("2026-09-01")).toBe("2026-09-01");
    expect(() => WorkReviewDateSchema.parse("2026-02-29")).toThrow();
    expect(() => WorkReviewDateSchema.parse("2026-99-99")).toThrow();
  });

  it("accepts one non-empty canonical authority and rejects duplicate segment IDs", () => {
    expect(WorkCanonicalSegmentsSchema.parse([
      segment("seg_1"),
      segment("seg_2", "upload_1", 1)
    ])).toHaveLength(2);
    expect(() => WorkCanonicalSegmentsSchema.parse([
      segment("seg_1"),
      segment("seg_1", "upload_1", 1)
    ])).toThrow("segment IDs must be unique");
  });

  it("rejects a canonical publication whose sourceUploadId or count does not match", () => {
    const base = {
      publicationId: "publication_1",
      accountId: "account_1",
      meetingId: "meeting_1",
      sourceUploadId: "upload_1",
      assetKind: "segments" as const,
      attemptVersion: 1,
      contentDigest: "a".repeat(64),
      segmentCount: 1,
      segments: [segment("seg_1")],
      createdAt: "2026-09-01T00:00:00.000Z",
      tombstonedAt: null
    };
    expect(WorkCanonicalPublicationSchema.parse(base).segmentCount).toBe(1);
    expect(() => WorkCanonicalPublicationSchema.parse({
      ...base,
      sourceUploadId: "other_upload"
    })).toThrow("sourceUploadId mismatch");
    expect(() => WorkCanonicalPublicationSchema.parse({
      ...base,
      segmentCount: 2
    })).toThrow("segmentCount must match");
  });

  it("requires a complete canonical pointer before transcript_ready analysis", () => {
    const base = {
      contractVersion: 1 as const,
      id: "meeting_1",
      accountId: "account_1",
      productId: "office_review" as const,
      title: "发布会议",
      meetingDate: "2026-09-01",
      sourceUploadId: "upload_1",
      audioDurationSeconds: null,
      ingestionStatus: "transcript_ready" as const,
      analysisStatus: "queued" as const,
      reviewStatus: "not_started" as const,
      canonicalPublicationId: "publication_1",
      canonicalContentDigest: "b".repeat(64),
      canonicalSegmentCount: 1,
      currentTranscriptionAttempt: 1,
      currentAnalysisAttempt: 1,
      version: 2,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:01:00.000Z",
      transcriptReadyAt: "2026-09-01T00:01:00.000Z",
      reviewReadyAt: null,
      reviewCompletedAt: null,
      failedAt: null,
      deletedAt: null,
      errorStage: null,
      errorCode: null
    };
    expect(WorkMeetingSchema.parse(base).analysisStatus).toBe("queued");
    expect(() => WorkMeetingSchema.parse({
      ...base,
      canonicalContentDigest: null
    })).toThrow("complete canonical authority");
    expect(() => WorkMeetingSchema.parse({
      ...base,
      ingestionStatus: "transcribing"
    })).toThrow("analysis requires transcript_ready");
  });

  it("normalizes empty candidate structured data without inventing owner or deadline", () => {
    expect(WorkMeetingCandidateStructuredDataSchema.parse({})).toEqual({
      decisionFinality: null,
      rawActorLabel: null,
      candidateOwner: null,
      dueAt: null,
      originalDueExpression: null,
      actionBasis: null,
      relatedCommitmentCandidateId: null,
      planStages: []
    });
  });

  it("keeps candidate review operations versioned and rejects client account scope", () => {
    expect(ReviewWorkCandidateRequestSchema.parse({
      action: "accept",
      expectedVersion: 2,
      operationKey: "review_operation_1"
    })).toMatchObject({ action: "accept", expectedVersion: 2 });
    expect(() => ReviewWorkCandidateRequestSchema.parse({
      action: "accept",
      expectedVersion: 2,
      operationKey: "review_operation_1",
      accountId: "attacker"
    })).toThrow();
  });
});
