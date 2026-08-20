import { describe, expect, it } from "vitest";

import {
  CandidateKindSchema,
  CandidateSchema,
  CandidateStatusSchema,
  CreateDailyReflectionInputSchema,
  DailyReflectionStatusSchema,
  IngestionContextSchema,
  InputMethodSchema,
  LegacyDailyReflectionSchema,
  ProcessingPlanSchema,
  ProcessingProfileSchema,
  SourceOriginSchema,
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
});
