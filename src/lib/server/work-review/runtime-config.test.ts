import { describe, expect, it } from "vitest";

import {
  assertWorkReviewAnalysisProfileSupported,
  DEFAULT_WORK_REVIEW_ANALYSIS_CONCURRENCY,
  DEFAULT_WORK_REVIEW_ANALYSIS_DEADLINE_MS,
  DEFAULT_WORK_REVIEW_ANALYSIS_MAX_PROVIDER_CALLS,
  DEFAULT_WORK_REVIEW_EXTRACTOR_MAX_PROVIDER_CALLS,
  DEFAULT_WORK_REVIEW_EXTRACTOR_MAX_RECOVERY_SPLIT_DEPTH,
  DEFAULT_WORK_REVIEW_MAX_INPUT_TOKENS_PER_WINDOW,
  DEFAULT_WORK_REVIEW_MAX_AUDIO_DURATION_SECONDS,
  DEFAULT_WORK_REVIEW_MAX_UPLOAD_BYTES,
  DEFAULT_WORK_REVIEW_RECOVERY_MAX_PROVIDER_CALLS,
  DEFAULT_WORK_REVIEW_TARGET_INPUT_TOKENS_PER_WINDOW,
  DEFAULT_WORK_REVIEW_VERIFIER_MAX_PROVIDER_CALLS,
  isWorkReviewAnalysisEnabled,
  isWorkReviewEnabled,
  isWorkReviewFollowUpEnabled,
  isWorkReviewRecoveryEnabled,
  isWorkReviewProjectsEnabled,
  isWorkReviewWeeklyAiEnabled,
  isWorkReviewWeeklyEnabled,
  isWorkReviewWeeklyQaEnabled,
  isWorkReviewWeeklyQaVerifierEnabled,
  isWorkReviewWeeklyVerifierEnabled,
  isWorkReviewTodoEnabled,
  isWorkReviewTodoMeetingProjectionEnabled,
  isWorkReviewUploadEnabled,
  isWorkReviewVerifierEnabled,
  resolveWorkReviewAnalysisRuntimeConfig,
  resolveWorkReviewAnalysisConcurrency,
  resolveWorkReviewCapacityLimits,
  resolveWorkReviewExtractorExecutionPolicy,
  resolveWorkReviewExtractorProfile,
  resolveWorkReviewFeatureFlags,
  resolveWorkReviewVerifierProfile,
  WorkReviewRuntimeConfigError,
  type WorkReviewAnalysisProviderProfile
} from "./runtime-config";

describe("Work Review runtime config", () => {
  it("enables every released Work Review capability when no override is configured", () => {
    expect(resolveWorkReviewFeatureFlags({})).toEqual({
      enabled: true,
      uploadEnabled: true,
      analysisEnabled: true,
      verifierEnabled: true,
      todoEnabled: true,
      todoMeetingProjectionEnabled: true,
      followUpEnabled: true,
      recoveryEnabled: true,
      projectsEnabled: true,
      weeklyEnabled: true,
      weeklyAiEnabled: true,
      weeklyVerifierEnabled: true,
      weeklyQaEnabled: true,
      weeklyQaVerifierEnabled: true
    });
  });

  it.each(["false", "", "1", "invalid"])("closes all default-on features for explicit top-level value %j", (value) => {
    const flags = resolveWorkReviewFeatureFlags({ WORK_REVIEW_ENABLED: value });
    expect(Object.values(flags).every((flag) => flag === false)).toBe(true);
  });

  it("honors individual opt-outs without disabling independent features", () => {
    expect(resolveWorkReviewFeatureFlags({
      WORK_REVIEW_PROJECTS_ENABLED: "false",
      WORK_REVIEW_WEEKLY_ENABLED: "false",
      WORK_REVIEW_TODO_ENABLED: "false"
    })).toMatchObject({
      enabled: true,
      analysisEnabled: true,
      verifierEnabled: true,
      todoEnabled: false,
      todoMeetingProjectionEnabled: false,
      projectsEnabled: false,
      weeklyEnabled: false,
      weeklyAiEnabled: false,
      weeklyVerifierEnabled: false,
      weeklyQaEnabled: false,
      weeklyQaVerifierEnabled: false
    });
  });

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
      recoveryEnabled: false,
      projectsEnabled: false,
      weeklyEnabled: false,
      weeklyAiEnabled: false,
      weeklyVerifierEnabled: false,
      weeklyQaEnabled: false,
      weeklyQaVerifierEnabled: false
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

  it("keeps every V2 capability fail closed behind its exact parent", () => {
    const enabled = {
      WORK_REVIEW_ENABLED: "true",
      WORK_REVIEW_PROJECTS_ENABLED: "true",
      WORK_REVIEW_WEEKLY_ENABLED: "true",
      WORK_REVIEW_WEEKLY_AI_ENABLED: "true",
      WORK_REVIEW_WEEKLY_VERIFIER_ENABLED: "true",
      WORK_REVIEW_WEEKLY_QA_ENABLED: "true",
      WORK_REVIEW_WEEKLY_QA_VERIFIER_ENABLED: "true"
    };
    expect(isWorkReviewProjectsEnabled(enabled)).toBe(true);
    expect(isWorkReviewWeeklyEnabled(enabled)).toBe(true);
    expect(isWorkReviewWeeklyAiEnabled(enabled)).toBe(true);
    expect(isWorkReviewWeeklyVerifierEnabled(enabled)).toBe(true);
    expect(isWorkReviewWeeklyQaEnabled(enabled)).toBe(true);
    expect(isWorkReviewWeeklyQaVerifierEnabled(enabled)).toBe(true);
    expect(resolveWorkReviewFeatureFlags({
      ...enabled,
      WORK_REVIEW_WEEKLY_AI_ENABLED: "false"
    })).toMatchObject({
      weeklyEnabled: true,
      weeklyAiEnabled: false,
      weeklyVerifierEnabled: false,
      weeklyQaEnabled: false,
      weeklyQaVerifierEnabled: false
    });
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

  it("uses bounded Work analysis concurrency", () => {
    expect(resolveWorkReviewAnalysisConcurrency({})).toBe(
      DEFAULT_WORK_REVIEW_ANALYSIS_CONCURRENCY
    );
    expect(resolveWorkReviewAnalysisConcurrency({
      WORK_REVIEW_ANALYSIS_CONCURRENCY: "4"
    })).toBe(4);
    expect(() => resolveWorkReviewAnalysisConcurrency({
      WORK_REVIEW_ANALYSIS_CONCURRENCY: "5"
    })).toThrowError(expect.objectContaining<Partial<WorkReviewRuntimeConfigError>>({
      code: "work_review_invalid_integer_config"
    }));
  });

  it("uses a bounded Work-owned Extractor window and recovery policy", () => {
    expect(resolveWorkReviewExtractorExecutionPolicy({})).toEqual({
      targetInputTokensPerWindow: DEFAULT_WORK_REVIEW_TARGET_INPUT_TOKENS_PER_WINDOW,
      maxInputTokensPerWindow: DEFAULT_WORK_REVIEW_MAX_INPUT_TOKENS_PER_WINDOW,
      maxRecoverySplitDepth: DEFAULT_WORK_REVIEW_EXTRACTOR_MAX_RECOVERY_SPLIT_DEPTH,
      maxProviderCalls: DEFAULT_WORK_REVIEW_ANALYSIS_MAX_PROVIDER_CALLS,
      extractorMaxProviderCalls: DEFAULT_WORK_REVIEW_EXTRACTOR_MAX_PROVIDER_CALLS,
      verifierMaxProviderCalls: DEFAULT_WORK_REVIEW_VERIFIER_MAX_PROVIDER_CALLS,
      recoveryMaxProviderCalls: DEFAULT_WORK_REVIEW_RECOVERY_MAX_PROVIDER_CALLS,
      analysisDeadlineMs: DEFAULT_WORK_REVIEW_ANALYSIS_DEADLINE_MS
    });
    expect(resolveWorkReviewExtractorExecutionPolicy({
      WORK_REVIEW_TARGET_INPUT_TOKENS_PER_WINDOW: "900",
      WORK_REVIEW_MAX_INPUT_TOKENS_PER_WINDOW: "1400",
      WORK_REVIEW_EXTRACTOR_MAX_RECOVERY_SPLIT_DEPTH: "1",
      WORK_REVIEW_ANALYSIS_MAX_PROVIDER_CALLS: "12",
      WORK_REVIEW_ANALYSIS_DEADLINE_MS: "540000"
    })).toEqual({
      targetInputTokensPerWindow: 900,
      maxInputTokensPerWindow: 1_400,
      maxRecoverySplitDepth: 1,
      maxProviderCalls: 12,
      extractorMaxProviderCalls: 8,
      verifierMaxProviderCalls: 3,
      recoveryMaxProviderCalls: 1,
      analysisDeadlineMs: 540_000
    });
    expect(() => resolveWorkReviewExtractorExecutionPolicy({
      WORK_REVIEW_TARGET_INPUT_TOKENS_PER_WINDOW: "799"
    })).toThrowError(expect.objectContaining<Partial<WorkReviewRuntimeConfigError>>({
      code: "work_review_invalid_integer_config"
    }));
    expect(() => resolveWorkReviewExtractorExecutionPolicy({
      WORK_REVIEW_MAX_INPUT_TOKENS_PER_WINDOW: "6001"
    })).toThrowError(expect.objectContaining<Partial<WorkReviewRuntimeConfigError>>({
      code: "work_review_invalid_integer_config"
    }));
    expect(() => resolveWorkReviewExtractorExecutionPolicy({
      WORK_REVIEW_ANALYSIS_MAX_PROVIDER_CALLS: "16"
    })).toThrowError(expect.objectContaining<Partial<WorkReviewRuntimeConfigError>>({
      code: "work_review_invalid_integer_config"
    }));
    expect(() => resolveWorkReviewExtractorExecutionPolicy({
      WORK_REVIEW_ANALYSIS_DEADLINE_MS: "600001"
    })).toThrowError(expect.objectContaining<Partial<WorkReviewRuntimeConfigError>>({
      code: "work_review_invalid_integer_config"
    }));
    expect(() => resolveWorkReviewExtractorExecutionPolicy({
      WORK_REVIEW_EXTRACTOR_MAX_RECOVERY_SPLIT_DEPTH: "3"
    })).toThrowError(expect.objectContaining<Partial<WorkReviewRuntimeConfigError>>({
      code: "work_review_invalid_integer_config"
    }));
  });

  it("accepts explicit 4000-token windows while retaining default budgets and rejecting out-of-range settings", () => {
    const defaults = resolveWorkReviewExtractorExecutionPolicy({});
    expect(defaults).toMatchObject({
      targetInputTokensPerWindow: 1_000,
      maxInputTokensPerWindow: 1_500,
      maxProviderCalls: 15,
      extractorMaxProviderCalls: 11,
      verifierMaxProviderCalls: 3,
      recoveryMaxProviderCalls: 1,
      analysisDeadlineMs: 600_000
    });
    expect(resolveWorkReviewExtractorExecutionPolicy({
      WORK_REVIEW_TARGET_INPUT_TOKENS_PER_WINDOW: "4000",
      WORK_REVIEW_MAX_INPUT_TOKENS_PER_WINDOW: "6000"
    })).toEqual({ ...defaults, targetInputTokensPerWindow: 4_000, maxInputTokensPerWindow: 6_000 });
    expect(() => resolveWorkReviewExtractorExecutionPolicy({
      WORK_REVIEW_TARGET_INPUT_TOKENS_PER_WINDOW: "4001",
      WORK_REVIEW_MAX_INPUT_TOKENS_PER_WINDOW: "6000"
    })).toThrowError(expect.objectContaining({ code: "work_review_invalid_integer_config" }));
    expect(() => resolveWorkReviewExtractorExecutionPolicy({
      WORK_REVIEW_TARGET_INPUT_TOKENS_PER_WINDOW: "4000",
      WORK_REVIEW_MAX_INPUT_TOKENS_PER_WINDOW: "6001"
    })).toThrowError(expect.objectContaining({ code: "work_review_invalid_integer_config" }));
    expect(() => resolveWorkReviewExtractorExecutionPolicy({
      WORK_REVIEW_TARGET_INPUT_TOKENS_PER_WINDOW: "4000"
    })).toThrowError(expect.objectContaining({ code: "work_review_invalid_analysis_window_config" }));
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
      maxOutputTokens: 4_000,
      promptVersion: "work_meeting_extractor_v15",
      schemaVersion: "work_meeting_candidates_v7"
    });
    expect(config.verifier).toMatchObject({
      profileId: "work-meeting-verifier",
      model: "verifier-model",
      reasoningEffort: "high",
      timeoutMs: 3_000,
      maxOutputTokens: 3_000,
      promptVersion: "work_meeting_verifier_v13",
      schemaVersion: "work_meeting_claim_evaluations_v3"
    });
  });

  it("keeps the default OpenAI profiles while resolving an explicitly selected DeepSeek stage", () => {
    const config = resolveWorkReviewAnalysisRuntimeConfig({
      OPENAI_TEXT_MODEL: "gpt-5.5",
      DEEPSEEK_MODEL: "deepseek-v4-flash",
      WORK_REVIEW_EXTRACTOR_PROVIDER: "deepseek-structured-json",
      WORK_REVIEW_EXTRACTOR_REASONING_EFFORT: "none"
    });
    expect(config.extractor).toMatchObject({
      provider: "deepseek-structured-json", model: "deepseek-v4-flash", reasoningEffort: "none",
      timeoutMs: 90_000, maxOutputTokens: 4_000
    });
    expect(config.verifier).toMatchObject({
      provider: "openai-compatible-structured-json", model: "gpt-5.5", reasoningEffort: "provider_default",
      timeoutMs: 120_000, maxOutputTokens: 3_000
    });
    expect(resolveWorkReviewVerifierProfile({
      DEEPSEEK_MODEL: "deepseek-v4-flash",
      WORK_REVIEW_VERIFIER_PROVIDER: "deepseek-structured-json",
      WORK_REVIEW_VERIFIER_MODEL: "deepseek-v4-pro",
      WORK_REVIEW_VERIFIER_REASONING_EFFORT: "high"
    })).toMatchObject({ provider: "deepseek-structured-json", model: "deepseek-v4-pro", reasoningEffort: "high" });
  });

  it.each(["EXTRACTOR", "VERIFIER"])("does not inherit an OpenAI model for the DeepSeek %s", (stage) => {
    const resolver = stage === "EXTRACTOR" ? resolveWorkReviewExtractorProfile : resolveWorkReviewVerifierProfile;
    expect(() => resolver({
      OPENAI_TEXT_MODEL: "gpt-5.5",
      OPENAI_QA_MODEL: "gpt-5.5",
      [`WORK_REVIEW_${stage}_PROVIDER`]: "deepseek-structured-json"
    })).toThrowError(expect.objectContaining({ code: "work_review_analysis_model_missing" }));
    expect(() => resolver({
      [`WORK_REVIEW_${stage}_PROVIDER`]: "deepseek-structured-json",
      [`WORK_REVIEW_${stage}_MODEL`]: "gpt-5.5"
    })).toThrowError(expect.objectContaining({ code: "work_review_analysis_model_unsupported" }));
  });

  it.each(["provider_default", "none", "low", "high"])("accepts DeepSeek effort %s explicitly", (effort) => {
    expect(resolveWorkReviewExtractorProfile({
      WORK_REVIEW_EXTRACTOR_PROVIDER: "deepseek-structured-json",
      WORK_REVIEW_EXTRACTOR_MODEL: "deepseek-v4-flash",
      WORK_REVIEW_EXTRACTOR_REASONING_EFFORT: effort
    }).reasoningEffort).toBe(effort);
  });

  it.each(["minimal", "medium", "max", "disabled"])("rejects DeepSeek effort %s outside the adopted profiles", (effort) => {
    expect(() => resolveWorkReviewExtractorProfile({
      WORK_REVIEW_EXTRACTOR_PROVIDER: "deepseek-structured-json",
      WORK_REVIEW_EXTRACTOR_MODEL: "deepseek-v4-flash",
      WORK_REVIEW_EXTRACTOR_REASONING_EFFORT: effort
    })).toThrowError(expect.objectContaining({ code: "work_review_unknown_reasoning_effort" }));
  });

  it.each(["EXTRACTOR", "VERIFIER"])("resolves the adopted TokenHub %s without inheriting shared models", (stage) => {
    const resolver = stage === "EXTRACTOR" ? resolveWorkReviewExtractorProfile : resolveWorkReviewVerifierProfile;
    const env = {
      [`WORK_REVIEW_${stage}_PROVIDER`]: "tokenhub-structured-json",
      [`WORK_REVIEW_${stage}_MODEL`]: "deepseek-v4-pro",
      [`WORK_REVIEW_${stage}_REASONING_EFFORT`]: "none",
      OPENAI_TEXT_MODEL: "gpt-5.5", OPENAI_QA_MODEL: "gpt-5.5", DEEPSEEK_MODEL: "deepseek-v4-flash"
    };
    expect(resolver(env)).toMatchObject({ provider: "tokenhub-structured-json", model: "deepseek-v4-pro", reasoningEffort: "none" });
    expect(() => resolver({ ...env, [`WORK_REVIEW_${stage}_MODEL`]: "" }))
      .toThrowError(expect.objectContaining({ code: "work_review_analysis_model_missing" }));
    expect(() => resolver({ ...env, [`WORK_REVIEW_${stage}_MODEL`]: "gpt-5.6-terra" }))
      .toThrowError(expect.objectContaining({ code: "work_review_analysis_model_unsupported" }));
    expect(() => resolver({ ...env, [`WORK_REVIEW_${stage}_REASONING_EFFORT`]: "low" }))
      .toThrowError(expect.objectContaining({ code: "work_review_unknown_reasoning_effort" }));
  });

  it("rejects none for OpenAI and rejects unnormalized direct production profiles", () => {
    const profile = resolveWorkReviewExtractorProfile({ WORK_REVIEW_EXTRACTOR_MODEL: "gpt-5.5" });
    expect(() => resolveWorkReviewExtractorProfile({
      WORK_REVIEW_EXTRACTOR_MODEL: "gpt-5.5",
      WORK_REVIEW_EXTRACTOR_REASONING_EFFORT: "none"
    })).toThrowError(expect.objectContaining({ code: "work_review_unknown_reasoning_effort" }));
    for (const provider of ["OPENAI-COMPATIBLE-STRUCTURED-JSON", " deepseek-structured-json ", ""]) {
      expect(() => assertWorkReviewAnalysisProfileSupported({
        ...profile, provider
      } as WorkReviewAnalysisProviderProfile)).toThrowError(expect.objectContaining({ code: "work_review_unknown_analysis_provider" }));
    }
    expect(() => assertWorkReviewAnalysisProfileSupported({
      ...profile, reasoningEffort: "HIGH"
    } as unknown as WorkReviewAnalysisProviderProfile)).toThrowError(expect.objectContaining({ code: "work_review_unknown_reasoning_effort" }));
    expect(() => assertWorkReviewAnalysisProfileSupported({
      ...profile, provider: "fixture", reasoningEffort: "none"
    })).toThrowError(expect.objectContaining({ code: "work_review_unknown_reasoning_effort" }));
  });

  it("keeps Work analysis output budgets bounded", () => {
    expect(resolveWorkReviewExtractorProfile({
      WORK_REVIEW_EXTRACTOR_MODEL: "extractor-model"
    }).timeoutMs).toBe(90_000);
    expect(() => resolveWorkReviewExtractorProfile({
      WORK_REVIEW_EXTRACTOR_MODEL: "extractor-model",
      WORK_REVIEW_EXTRACTOR_MAX_OUTPUT_TOKENS: "8001"
    })).toThrowError(expect.objectContaining<Partial<WorkReviewRuntimeConfigError>>({
      code: "work_review_invalid_integer_config"
    }));
    expect(() => resolveWorkReviewVerifierProfile({
      WORK_REVIEW_VERIFIER_MODEL: "verifier-model",
      WORK_REVIEW_VERIFIER_MAX_OUTPUT_TOKENS: "8001"
    })).toThrowError(expect.objectContaining<Partial<WorkReviewRuntimeConfigError>>({
      code: "work_review_invalid_integer_config"
    }));
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
