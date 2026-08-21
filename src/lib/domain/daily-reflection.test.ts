import { describe, expect, it } from "vitest";

import {
  CandidateKindSchema,
  CandidateKindV2Schema,
  CandidateSchema,
  CandidateStatusSchema,
  CreateDailyReflectionInputSchema,
  DailyReflectionV2InputSchema,
  PendingCandidateV2InputSchema,
  ReflectionConfirmationV2Schema,
  DailyReflectionStatusSchema,
  IngestionContextSchema,
  InputMethodSchema,
  LegacyDailyReflectionSchema,
  ProcessingPlanSchema,
  ProcessingProfileSchema,
  SourceOriginSchema,
  legacyCandidateKindForV2,
  normalizeLegacySourceOrigin
} from "./daily-reflection";

const timestamp = "2026-08-13T00:00:00.000Z";

describe("Daily Reflection domain contracts", () => {
  it("round-trips the four independent ingestion dimensions", () => {
    expect(InputMethodSchema.options).toEqual(["file_upload", "browser_recording"]);
    expect(SourceOriginSchema.options).toEqual([
      "direct_conversation",
      "user_reflection",
      "manual_note",
      "ai_derived_observation",
      "unknown",
      "legacy_unknown"
    ]);
    expect(ProcessingProfileSchema.options).toEqual([
      "full_recording",
      "quick_reflection"
    ]);
    expect(IngestionContextSchema.options).toEqual([
      "standard_upload",
      "date_companion",
      "daily_reflection"
    ]);
  });

  it("requires an explicit source for new records and fail-closes legacy values", () => {
    expect(() => CreateDailyReflectionInputSchema.parse({
      accountId: "account_1",
      uploadId: "upload_1",
      inputMethod: "file_upload",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection"
    })).toThrow();
    expect(normalizeLegacySourceOrigin(undefined)).toBe("legacy_unknown");
    expect(normalizeLegacySourceOrigin("old_conversation_flag")).toBe("legacy_unknown");
    expect(normalizeLegacySourceOrigin("user_reflection")).toBe("user_reflection");
    expect(LegacyDailyReflectionSchema.parse({
      id: "reflection_legacy",
      accountId: "account_1",
      uploadId: null,
      inputMethod: "file_upload",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      status: "created",
      version: 0,
      idempotencyKey: null,
      errorCode: null,
      errorMessage: null,
      createdAt: timestamp,
      updatedAt: timestamp
    }).sourceOrigin).toBe("legacy_unknown");
  });

  it("persists a versioned, review-gated plan bound to a reflection and upload", () => {
    expect(ProcessingPlanSchema.parse({
      planVersion: 1,
      reflectionId: "reflection_1",
      uploadId: "upload_1",
      inputMethod: "file_upload",
      sourceOrigin: "unknown",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      reviewPolicy: "required"
    })).toMatchObject({
      planVersion: 1,
      reflectionId: "reflection_1",
      uploadId: "upload_1",
      reviewPolicy: "required"
    });
    expect(() => ProcessingPlanSchema.parse({
      planVersion: 1,
      reflectionId: "reflection_1",
      inputMethod: "file_upload",
      sourceOrigin: "unknown",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      reviewPolicy: "required"
    })).toThrow();
    expect(() => ProcessingPlanSchema.parse({
      planVersion: 2,
      reflectionId: "reflection_1",
      uploadId: "upload_1",
      inputMethod: "file_upload",
      sourceOrigin: "unknown",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      reviewPolicy: "required"
    })).toThrow();
  });

  it("defines every workflow and candidate state without adding a decision kind", () => {
    expect(DailyReflectionStatusSchema.options).toEqual([
      "created",
      "uploading",
      "transcribing",
      "extracting",
      "review_pending",
      "confirmation_ready",
      "admitting",
      "completed",
      "admission_failed",
      "failed",
      "cancelled",
      "deleted"
    ]);
    expect(CandidateStatusSchema.options).toEqual(["pending", "kept", "excluded"]);
    expect(CandidateKindSchema.options).toEqual([
      "event",
      "commitment",
      "question",
      "preference",
      "summary"
    ]);
  });

  it("requires canonical segment references and fail-closed subject confirmation", () => {
    const base = {
      id: "candidate_1",
      reflectionId: "reflection_1",
      ordinal: 0,
      proposedText: "I may need to revisit the plan.",
      userText: null,
      status: "pending" as const,
      candidateType: "event" as const,
      sourceSegmentIds: ["segment_1"],
      subjectPersonId: null,
      subjectConfirmed: false,
      version: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    expect(CandidateSchema.parse(base)).toEqual(base);
    expect(() => CandidateSchema.parse({ ...base, sourceSegmentIds: [] })).toThrow();
    expect(() => CandidateSchema.parse({
      ...base,
      sourceSegmentIds: ["segment_1", "segment_1"]
    })).toThrow();
    expect(() => CandidateSchema.parse({ ...base, subjectConfirmed: true })).toThrow();
  });

  it("defines the strict inspiration-capture V2 contract without Person inference", () => {
    expect(CandidateKindV2Schema.options).toEqual([
      "insight",
      "open_question",
      "decision",
      "user_action"
    ]);
    expect(DailyReflectionV2InputSchema.parse({
      operationKey: "reflection-v2-operation",
      inputAdapter: "toy_sync",
      sourceOrigin: "direct_conversation",
      capturePurpose: "inspiration_capture",
      recordingDate: "2026-08-21"
    })).toMatchObject({ capturePurpose: "inspiration_capture" });
    expect(PendingCandidateV2InputSchema.parse({
      ordinal: 0,
      candidateKind: "insight",
      proposedText: "我意识到需要给重要问题留出思考时间。",
      evidenceIds: [],
      confidence: 0.72,
      caution: "这是用户复盘中的总结。",
      actionClaimed: false
    })).toMatchObject({ evidenceIds: [] });
    expect(legacyCandidateKindForV2({
      candidateKind: "insight",
      actionClaimed: false
    })).toBe("summary");
    expect(legacyCandidateKindForV2({
      candidateKind: "decision",
      actionClaimed: false
    })).toBe("summary");
    expect(legacyCandidateKindForV2({
      candidateKind: "open_question",
      actionClaimed: false
    })).toBe("question");
    expect(legacyCandidateKindForV2({
      candidateKind: "user_action",
      actionClaimed: true
    })).toBe("commitment");
    expect(() => PendingCandidateV2InputSchema.parse({
      ordinal: 1,
      candidateKind: "decision",
      proposedText: "A decision is not itself a claimed action.",
      evidenceIds: ["segment_2"],
      confidence: 0.8,
      caution: "Keep the action boundary explicit.",
      actionClaimed: true
    })).toThrow();
    expect(() => PendingCandidateV2InputSchema.parse({
      ordinal: 0,
      candidateKind: "insight",
      proposedText: "重复 Evidence 不应被接受。",
      evidenceIds: ["segment_1", "segment_1"],
      confidence: 0.72,
      caution: "需要核对。",
      actionClaimed: false,
      subjectPersonId: "person_alice"
    })).toThrow();
  });

  it("allows Evidence-free V2 recap but rejects Evidence-free retention", () => {
    const confirmation = {
      contractVersion: 2 as const,
      id: "confirmation_v2",
      reflectionId: "reflection_v2",
      accountId: "account_1",
      fingerprint: "a".repeat(64),
      requestFingerprint: "b".repeat(64),
      idempotencyKey: "operation_v2",
      operationKey: "operation_v2",
      sourceOrigin: "user_reflection" as const,
      inputMethod: "file_upload" as const,
      processingProfile: "full_recording" as const,
      inputAdapter: "file_picker" as const,
      capturePurpose: "inspiration_capture" as const,
      recordingDate: "2026-08-21",
      saveIntent: "recap_only" as const,
      candidateSnapshots: [{
        contractVersion: 2 as const,
        candidateId: "candidate_v2",
        proposedText: "今天最重要的领悟。",
        userText: null,
        finalText: "今天最重要的领悟。",
        status: "kept" as const,
        candidateKind: "insight" as const,
        candidateType: "summary" as const,
        evidenceIds: [],
        sourceSegmentIds: [],
        evidenceSnapshots: [],
        confidence: 0.8,
        caution: "无直接 Evidence，只能保存复盘。",
        actionClaimed: false,
        subjectPersonId: null
      }],
      createdAt: timestamp
    };
    expect(ReflectionConfirmationV2Schema.parse(confirmation).saveIntent)
      .toBe("recap_only");
    expect(() => ReflectionConfirmationV2Schema.parse({
      ...confirmation,
      saveIntent: "retain_selected"
    })).toThrow();
  });
});
