import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORK_REVIEW_MAX_AUDIO_DURATION_SECONDS,
  DEFAULT_WORK_REVIEW_MAX_UPLOAD_BYTES,
  isWorkReviewAnalysisEnabled,
  isWorkReviewEnabled,
  isWorkReviewFollowUpEnabled,
  isWorkReviewRecoveryEnabled,
  isWorkReviewTodoEnabled,
  isWorkReviewTodoMeetingProjectionEnabled,
  isWorkReviewUploadEnabled,
  isWorkReviewVerifierEnabled,
  resolveWorkReviewAnalysisRuntimeConfig,
  resolveWorkReviewCapacityLimits,
  resolveWorkReviewExtractorProfile,
  resolveWorkReviewFeatureFlags,
  WorkReviewRuntimeConfigError
} from "./runtime-config";

describe("Work Review runtime config", () => {
  it("enforces feature dependencies fail closed", () => {
    const orphaned = {
      WORK_REVIEW_ENABLED: "false",
      WORK_REVIEW_UPLOAD_ENABLED: "true",
      WORK_REVIEW_ANALYSIS_ENABLED: "true",
      WORK_REVIEW_VERIFIER_ENABLED: "true",
      WORK_REVIEW_TODO_ENABLED: "true",
      WORK_REVIEW_TODO_MEETING_PROJECTION_ENABLED: "true",
      WORK_REVIEW_FOLLOW_UP_ENABLED: "true",
      WORK_REVIEW_RECOVERY_ENABLED: "true"
    };
    expect(resolveWorkReviewFeatureFlags(orphaned)).toEqual({
      enabled: false,
      uploadEnabled: false,
      analysisEnabled: false,
      verifierEnabled: false,
      todoEnabled: false,
      todoMeetingProjectionEnabled: false,
      followUpEnabled: false,
      recoveryEnabled: false
    });
    const enabled = {
      WORK_REVIEW_ENABLED: "true",
      WORK_REVIEW_UPLOAD_ENABLED: "true",
      WORK_REVIEW_ANALYSIS_ENABLED: "true",
      WORK_REVIEW_VERIFIER_ENABLED: "true",
      WORK_REVIEW_TODO_ENABLED: "true",
      WORK_REVIEW_TODO_MEETING_PROJECTION_ENABLED: "true",
      WORK_REVIEW_FOLLOW_UP_ENABLED: "true",
      WORK_REVIEW_RECOVERY_ENABLED: "true"
    };
    expect(isWorkReviewEnabled(enabled)).toBe(true);
    expect(isWorkReviewUploadEnabled(enabled)).toBe(true);
    expect(isWorkReviewAnalysisEnabled(enabled)).toBe(true);
    expect(isWorkReviewVerifierEnabled(enabled)).toBe(true);
    expect(isWorkReviewTodoEnabled(enabled)).toBe(true);
    expect(isWorkReviewTodoMeetingProjectionEnabled(enabled)).toBe(true);
    expect(isWorkReviewFollowUpEnabled(enabled)).toBe(true);
    expect(isWorkReviewRecoveryEnabled(enabled)).toBe(true);
  });

  it("keeps manual Todo available while meeting analysis or projection is closed", () => {
    const analysisClosed = {
      WORK_REVIEW_ENABLED: "true",
      WORK_REVIEW_UPLOAD_ENABLED: "false",
      WORK_REVIEW_ANALYSIS_ENABLED: "true",
      WORK_REVIEW_TODO_ENABLED: "true",
      WORK_REVIEW_TODO_MEETING_PROJECTION_ENABLED: "true"
    };
    expect(resolveWorkReviewFeatureFlags(analysisClosed)).toMatchObject({
      todoEnabled: true,
      todoMeetingProjectionEnabled: false
    });
    const projectionClosed = {
      WORK_REVIEW_ENABLED: "true",
      WORK_REVIEW_UPLOAD_ENABLED: "true",
      WORK_REVIEW_ANALYSIS_ENABLED: "true",
      WORK_REVIEW_TODO_ENABLED: "true",
      WORK_REVIEW_TODO_MEETING_PROJECTION_ENABLED: "false"
    };
    expect(resolveWorkReviewFeatureFlags(projectionClosed)).toMatchObject({
      todoEnabled: true,
      todoMeetingProjectionEnabled: false
    });
  });

  it("keeps analysis and verifier disabled when their parent flag is closed", () => {
    const env = {
      WORK_REVIEW_ENABLED: "true",
      WORK_REVIEW_UPLOAD_ENABLED: "false",
      WORK_REVIEW_ANALYSIS_ENABLED: "true",
      WORK_REVIEW_VERIFIER_ENABLED: "true"
    };
    expect(resolveWorkReviewFeatureFlags(env)).toMatchObject({
      enabled: true,
      uploadEnabled: false,
      analysisEnabled: false,
      verifierEnabled: false
    });
  });

  it("keeps follow-up and recovery fail closed behind their required Work gates", () => {
    expect(resolveWorkReviewFeatureFlags({
      WORK_REVIEW_ENABLED: "true",
      WORK_REVIEW_UPLOAD_ENABLED: "false",
      WORK_REVIEW_ANALYSIS_ENABLED: "true",
      WORK_REVIEW_FOLLOW_UP_ENABLED: "true",
      WORK_REVIEW_RECOVERY_ENABLED: "true"
    })).toMatchObject({
      followUpEnabled: false,
      recoveryEnabled: false
    });
  });

  it("resolves Work-owned upload and audio duration limits", () => {
    expect(resolveWorkReviewCapacityLimits({})).toEqual({
      maxUploadBytes: DEFAULT_WORK_REVIEW_MAX_UPLOAD_BYTES,
      maxAudioDurationSeconds: DEFAULT_WORK_REVIEW_MAX_AUDIO_DURATION_SECONDS
    });
    expect(resolveWorkReviewCapacityLimits({
      WORK_REVIEW_MAX_UPLOAD_BYTES: "1048576",
      WORK_REVIEW_MAX_AUDIO_DURATION_SECONDS: "3600"
    })).toEqual({ maxUploadBytes: 1_048_576, maxAudioDurationSeconds: 3_600 });
    expect(() => resolveWorkReviewCapacityLimits({
      WORK_REVIEW_MAX_UPLOAD_BYTES: "0"
    })).toThrowError(expect.objectContaining<Partial<WorkReviewRuntimeConfigError>>({
      code: "work_review_invalid_integer_config"
    }));
  });

  it("resolves distinct extractor and verifier profiles without hard-coding a model", () => {
    const config = resolveWorkReviewAnalysisRuntimeConfig({
      WORK_REVIEW_EXTRACTOR_MODEL: "extractor-model",
      WORK_REVIEW_VERIFIER_MODEL: "verifier-model",
      WORK_REVIEW_EXTRACTOR_REASONING_EFFORT: "minimal",
      WORK_REVIEW_VERIFIER_REASONING_EFFORT: "high",
      WORK_REVIEW_EXTRACTOR_TIMEOUT_MS: "2000",
      WORK_REVIEW_VERIFIER_TIMEOUT_MS: "3000"
    });
    expect(config.extractor).toMatchObject({
      profileId: "work-meeting-extractor",
      model: "extractor-model",
      reasoningEffort: "minimal",
      timeoutMs: 2_000,
      promptVersion: "work_meeting_extractor_v1"
    });
    expect(config.verifier).toMatchObject({
      profileId: "work-meeting-verifier",
      model: "verifier-model",
      reasoningEffort: "high",
      timeoutMs: 3_000,
      promptVersion: "work_meeting_verifier_v1"
    });
  });

  it("rejects reasoning values that cannot be forwarded to Responses", () => {
    expect(() => resolveWorkReviewExtractorProfile({
      WORK_REVIEW_EXTRACTOR_MODEL: "extractor-model",
      WORK_REVIEW_EXTRACTOR_REASONING_EFFORT: "disabled"
    })).toThrowError(expect.objectContaining<Partial<WorkReviewRuntimeConfigError>>({
      code: "work_review_unknown_reasoning_effort"
    }));
  });

  it("fails when a production analysis model is not configured", () => {
    expect(() => resolveWorkReviewAnalysisRuntimeConfig({})).toThrowError(
      expect.objectContaining<Partial<WorkReviewRuntimeConfigError>>({
        code: "work_review_analysis_model_missing"
      })
    );
  });

  it("can resolve the extractor without requiring a disabled verifier profile", () => {
    expect(resolveWorkReviewExtractorProfile({
      WORK_REVIEW_EXTRACTOR_MODEL: "extractor-only-model",
      WORK_REVIEW_VERIFIER_PROVIDER: "fixture"
    })).toMatchObject({
      profileId: "work-meeting-extractor",
      model: "extractor-only-model"
    });
  });

  it("allows fixture profiles only when explicitly enabled outside production", () => {
    expect(() => resolveWorkReviewAnalysisRuntimeConfig({
      NODE_ENV: "production",
      WORK_REVIEW_EXTRACTOR_PROVIDER: "fixture",
      WORK_REVIEW_VERIFIER_PROVIDER: "fixture",
      WORK_REVIEW_FIXTURE_ANALYSIS_ENABLED: "true"
    })).toThrowError(expect.objectContaining<Partial<WorkReviewRuntimeConfigError>>({
      code: "work_review_analysis_fixture_forbidden_in_production"
    }));
    expect(() => resolveWorkReviewAnalysisRuntimeConfig({
      NODE_ENV: "test",
      WORK_REVIEW_EXTRACTOR_PROVIDER: "fixture",
      WORK_REVIEW_VERIFIER_PROVIDER: "fixture"
    })).toThrowError(expect.objectContaining<Partial<WorkReviewRuntimeConfigError>>({
      code: "work_review_analysis_fixture_not_explicitly_enabled"
    }));
    const fixture = resolveWorkReviewAnalysisRuntimeConfig({
      NODE_ENV: "test",
      WORK_REVIEW_EXTRACTOR_PROVIDER: "fixture",
      WORK_REVIEW_VERIFIER_PROVIDER: "fixture",
      WORK_REVIEW_FIXTURE_ANALYSIS_ENABLED: "true"
    });
    expect(fixture.extractor.model).toBe("work-review-deterministic-fixture-v1");
    expect(fixture.verifier.provider).toBe("fixture");
  });
});
