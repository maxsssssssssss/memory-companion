export type WorkReviewFeatureFlags = {
  enabled: boolean;
  uploadEnabled: boolean;
  analysisEnabled: boolean;
  verifierEnabled: boolean;
  todoEnabled: boolean;
  todoMeetingProjectionEnabled: boolean;
  followUpEnabled: boolean;
  recoveryEnabled: boolean;
  projectsEnabled?: boolean;
  weeklyEnabled?: boolean;
  weeklyAiEnabled?: boolean;
  weeklyVerifierEnabled?: boolean;
  weeklyQaEnabled?: boolean;
  weeklyQaVerifierEnabled?: boolean;
};

export type WorkReviewCapacityLimits = {
  maxUploadBytes: number;
  maxAudioDurationSeconds: number;
};

export type WorkReviewExtractorExecutionPolicy = {
  targetInputTokensPerWindow: number;
  maxInputTokensPerWindow: number;
  /**
   * Retained in the contract so existing Extractor checkpoint digests remain
   * reusable. New analysis attempts do not create timeout-driven splits.
   */
  maxRecoverySplitDepth: number;
  maxProviderCalls: number;
  extractorMaxProviderCalls: number;
  verifierMaxProviderCalls: number;
  recoveryMaxProviderCalls: number;
  analysisDeadlineMs: number;
};

export const DEFAULT_WORK_REVIEW_MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
export const DEFAULT_WORK_REVIEW_MAX_AUDIO_DURATION_SECONDS = 4 * 60 * 60;
export const DEFAULT_WORK_REVIEW_ANALYSIS_CONCURRENCY = 2;
export const DEFAULT_WORK_REVIEW_TARGET_INPUT_TOKENS_PER_WINDOW = 1_000;
export const DEFAULT_WORK_REVIEW_MAX_INPUT_TOKENS_PER_WINDOW = 1_500;
export const DEFAULT_WORK_REVIEW_EXTRACTOR_MAX_RECOVERY_SPLIT_DEPTH = 1;
export const DEFAULT_WORK_REVIEW_ANALYSIS_MAX_PROVIDER_CALLS = 15;
export const DEFAULT_WORK_REVIEW_EXTRACTOR_MAX_PROVIDER_CALLS = 11;
export const DEFAULT_WORK_REVIEW_VERIFIER_MAX_PROVIDER_CALLS = 3;
export const DEFAULT_WORK_REVIEW_RECOVERY_MAX_PROVIDER_CALLS = 1;
export const DEFAULT_WORK_REVIEW_ANALYSIS_DEADLINE_MS = 10 * 60_000;

export type WorkReviewAnalysisProviderName =
  | "openai-compatible-structured-json"
  | "deepseek-structured-json"
  | "tokenhub-structured-json"
  | "fixture";

export type WorkReviewReasoningEffort =
  | "provider_default"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high";

export type WorkReviewAnalysisProviderProfile = {
  profileId: string;
  provider: WorkReviewAnalysisProviderName;
  model: string;
  reasoningEffort: WorkReviewReasoningEffort;
  timeoutMs: number;
  maxOutputTokens: number;
  promptVersion: string;
  schemaVersion: string;
};

export type WorkReviewAnalysisRuntimeConfig = {
  extractor: WorkReviewAnalysisProviderProfile;
  verifier: WorkReviewAnalysisProviderProfile;
};

export const WORK_MEETING_PIPELINE_VERSION = "work_meeting_v25" as const;
export const WORK_MEETING_EXTRACTOR_PROMPT_VERSION = "work_meeting_extractor_v15" as const;
export const WORK_MEETING_EXTRACTOR_SCHEMA_VERSION = "work_meeting_candidates_v7" as const;
export const WORK_MEETING_VERIFIER_PROMPT_VERSION = "work_meeting_verifier_v13" as const;
export const WORK_MEETING_VERIFIER_SCHEMA_VERSION = "work_meeting_claim_evaluations_v3" as const;
export const WORK_MEETING_PUBLICATION_POLICY_VERSION = "work_meeting_publication_v9" as const;

export class WorkReviewRuntimeConfigError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "WorkReviewRuntimeConfigError";
  }
}

function isStrictlyEnabled(value: string | undefined) {
  return value?.trim().toLowerCase() === "true";
}

function nonEmpty(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function boundedInteger(input: {
  value: string | undefined;
  fallback: number;
  minimum: number;
  maximum: number;
  name: string;
}) {
  const raw = nonEmpty(input.value);
  if (!raw) return input.fallback;
  if (!/^\d+$/u.test(raw)) {
    throw new WorkReviewRuntimeConfigError(
      "work_review_invalid_integer_config",
      `${input.name} must be an integer between ${input.minimum} and ${input.maximum}`
    );
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < input.minimum || parsed > input.maximum) {
    throw new WorkReviewRuntimeConfigError(
      "work_review_invalid_integer_config",
      `${input.name} must be an integer between ${input.minimum} and ${input.maximum}`
    );
  }
  return parsed;
}

function providerName(value: string | undefined, fieldName: string): WorkReviewAnalysisProviderName {
  const normalized = nonEmpty(value)?.toLowerCase() ?? "openai-compatible-structured-json";
  if (normalized === "openai-compatible-structured-json" || normalized === "deepseek-structured-json"
    || normalized === "tokenhub-structured-json"
    || normalized === "fixture") {
    return normalized;
  }
  throw new WorkReviewRuntimeConfigError(
    "work_review_unknown_analysis_provider",
    `${fieldName} must be openai-compatible-structured-json, deepseek-structured-json, tokenhub-structured-json, or fixture`
  );
}

function reasoningEffort(
  value: string | undefined,
  fieldName: string,
  provider: WorkReviewAnalysisProviderName
): WorkReviewReasoningEffort {
  const normalized = nonEmpty(value)?.toLowerCase() ?? "provider_default";
  const allowed = provider === "deepseek-structured-json"
    ? ["provider_default", "none", "low", "high"]
    : provider === "tokenhub-structured-json"
      ? ["provider_default", "none"]
      : ["provider_default", "minimal", "low", "medium", "high"];
  if (allowed.includes(normalized)) {
    return normalized as WorkReviewReasoningEffort;
  }
  throw new WorkReviewRuntimeConfigError(
    "work_review_unknown_reasoning_effort",
    `${fieldName} is not supported by the selected Work Review analysis provider`
  );
}

/** Also validate profiles supplied directly to production factories, outside env resolution. */
export function assertWorkReviewAnalysisProfileSupported(profile: WorkReviewAnalysisProviderProfile) {
  if (providerName(profile.provider, "Work Review analysis provider") !== profile.provider) {
    throw new WorkReviewRuntimeConfigError(
      "work_review_unknown_analysis_provider",
      "Work Review analysis profile requires an exact supported provider"
    );
  }
  if (reasoningEffort(profile.reasoningEffort, "Work Review analysis reasoning effort", profile.provider)
    !== profile.reasoningEffort) {
    throw new WorkReviewRuntimeConfigError(
      "work_review_unknown_reasoning_effort",
      "Work Review analysis profile requires an exact supported reasoning effort"
    );
  }
  if (profile.provider === "deepseek-structured-json"
    && !["deepseek-v4-flash", "deepseek-v4-pro"].includes(profile.model)) {
    throw new WorkReviewRuntimeConfigError(
      "work_review_analysis_model_unsupported",
      "Work Review DeepSeek analysis requires a supported text model"
    );
  }
  if (profile.provider === "tokenhub-structured-json" && profile.model !== "deepseek-v4-pro") {
    throw new WorkReviewRuntimeConfigError(
      "work_review_analysis_model_unsupported",
      "Work Review TokenHub analysis requires the adopted DeepSeek Pro model"
    );
  }
}

export function resolveWorkReviewFeatureFlags(
  env: Readonly<Record<string, string | undefined>> = process.env
): WorkReviewFeatureFlags {
  // Work Review is on by default; explicit overrides and parent gates still apply.
  // Fixture-provider switches remain opt-in and do not use these defaults.
  const enabled = isStrictlyEnabled(env.WORK_REVIEW_ENABLED ?? "true");
  const uploadEnabled = enabled && isStrictlyEnabled(env.WORK_REVIEW_UPLOAD_ENABLED ?? "true");
  const analysisEnabled = uploadEnabled && isStrictlyEnabled(env.WORK_REVIEW_ANALYSIS_ENABLED ?? "true");
  const verifierEnabled = analysisEnabled && isStrictlyEnabled(env.WORK_REVIEW_VERIFIER_ENABLED ?? "true");
  const todoEnabled = enabled && isStrictlyEnabled(env.WORK_REVIEW_TODO_ENABLED ?? "true");
  const todoMeetingProjectionEnabled = todoEnabled
    && analysisEnabled
    && isStrictlyEnabled(env.WORK_REVIEW_TODO_MEETING_PROJECTION_ENABLED ?? "true");
  const followUpEnabled = analysisEnabled
    && isStrictlyEnabled(env.WORK_REVIEW_FOLLOW_UP_ENABLED ?? "true");
  const recoveryEnabled = uploadEnabled
    && isStrictlyEnabled(env.WORK_REVIEW_RECOVERY_ENABLED ?? "true");
  const projectsEnabled = enabled
    && isStrictlyEnabled(env.WORK_REVIEW_PROJECTS_ENABLED ?? "true");
  const weeklyEnabled = enabled
    && isStrictlyEnabled(env.WORK_REVIEW_WEEKLY_ENABLED ?? "true");
  const weeklyAiEnabled = weeklyEnabled
    && isStrictlyEnabled(env.WORK_REVIEW_WEEKLY_AI_ENABLED ?? "true");
  const weeklyVerifierEnabled = weeklyAiEnabled
    && isStrictlyEnabled(env.WORK_REVIEW_WEEKLY_VERIFIER_ENABLED ?? "true");
  const weeklyQaEnabled = weeklyAiEnabled
    && isStrictlyEnabled(env.WORK_REVIEW_WEEKLY_QA_ENABLED ?? "true");
  const weeklyQaVerifierEnabled = weeklyQaEnabled
    && isStrictlyEnabled(env.WORK_REVIEW_WEEKLY_QA_VERIFIER_ENABLED ?? "true");
  return {
    enabled,
    uploadEnabled,
    analysisEnabled,
    verifierEnabled,
    todoEnabled,
    todoMeetingProjectionEnabled,
    followUpEnabled,
    recoveryEnabled,
    projectsEnabled,
    weeklyEnabled,
    weeklyAiEnabled,
    weeklyVerifierEnabled,
    weeklyQaEnabled,
    weeklyQaVerifierEnabled
  };
}

export function isWorkReviewEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  return resolveWorkReviewFeatureFlags(env).enabled;
}

export function isWorkReviewUploadEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  return resolveWorkReviewFeatureFlags(env).uploadEnabled;
}

export function isWorkReviewAnalysisEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  return resolveWorkReviewFeatureFlags(env).analysisEnabled;
}

export function isWorkReviewVerifierEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  return resolveWorkReviewFeatureFlags(env).verifierEnabled;
}

export function isWorkReviewTodoEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  return resolveWorkReviewFeatureFlags(env).todoEnabled;
}

export function isWorkReviewTodoMeetingProjectionEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  return resolveWorkReviewFeatureFlags(env).todoMeetingProjectionEnabled;
}

export function isWorkReviewFollowUpEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  return resolveWorkReviewFeatureFlags(env).followUpEnabled;
}

export function isWorkReviewRecoveryEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  return resolveWorkReviewFeatureFlags(env).recoveryEnabled;
}

export function isWorkReviewProjectsEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  return resolveWorkReviewFeatureFlags(env).projectsEnabled;
}

export function isWorkReviewWeeklyEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  return resolveWorkReviewFeatureFlags(env).weeklyEnabled;
}

export function isWorkReviewWeeklyAiEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  return resolveWorkReviewFeatureFlags(env).weeklyAiEnabled;
}

export function isWorkReviewWeeklyVerifierEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  return resolveWorkReviewFeatureFlags(env).weeklyVerifierEnabled;
}

export function isWorkReviewWeeklyQaEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  return resolveWorkReviewFeatureFlags(env).weeklyQaEnabled;
}

export function isWorkReviewWeeklyQaVerifierEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  return resolveWorkReviewFeatureFlags(env).weeklyQaVerifierEnabled;
}

export function resolveWorkReviewCapacityLimits(
  env: Readonly<Record<string, string | undefined>> = process.env
): WorkReviewCapacityLimits {
  return {
    maxUploadBytes: boundedInteger({
      value: env.WORK_REVIEW_MAX_UPLOAD_BYTES,
      fallback: DEFAULT_WORK_REVIEW_MAX_UPLOAD_BYTES,
      minimum: 1,
      maximum: 5 * 1024 * 1024 * 1024,
      name: "WORK_REVIEW_MAX_UPLOAD_BYTES"
    }),
    maxAudioDurationSeconds: boundedInteger({
      value: env.WORK_REVIEW_MAX_AUDIO_DURATION_SECONDS,
      fallback: DEFAULT_WORK_REVIEW_MAX_AUDIO_DURATION_SECONDS,
      minimum: 1,
      maximum: 24 * 60 * 60,
      name: "WORK_REVIEW_MAX_AUDIO_DURATION_SECONDS"
    })
  };
}

export function resolveWorkReviewAnalysisConcurrency(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  return boundedInteger({
    value: env.WORK_REVIEW_ANALYSIS_CONCURRENCY,
    fallback: DEFAULT_WORK_REVIEW_ANALYSIS_CONCURRENCY,
    minimum: 1,
    maximum: 4,
    name: "WORK_REVIEW_ANALYSIS_CONCURRENCY"
  });
}

export function resolveWorkReviewExtractorExecutionPolicy(
  env: Readonly<Record<string, string | undefined>> = process.env
): WorkReviewExtractorExecutionPolicy {
  const maxProviderCalls = boundedInteger({
    value: env.WORK_REVIEW_ANALYSIS_MAX_PROVIDER_CALLS,
    fallback: DEFAULT_WORK_REVIEW_ANALYSIS_MAX_PROVIDER_CALLS,
    minimum: 1,
    maximum: DEFAULT_WORK_REVIEW_ANALYSIS_MAX_PROVIDER_CALLS,
    name: "WORK_REVIEW_ANALYSIS_MAX_PROVIDER_CALLS"
  });
  // Keep one recovery call and up to three Verifier calls reserved instead of
  // allowing Extractor fan-out to consume the entire meeting budget. Smaller
  // explicitly configured totals degrade the later-stage reservations first.
  const recoveryMaxProviderCalls = Math.min(
    DEFAULT_WORK_REVIEW_RECOVERY_MAX_PROVIDER_CALLS,
    Math.max(0, maxProviderCalls - 1)
  );
  const verifierMaxProviderCalls = Math.min(
    DEFAULT_WORK_REVIEW_VERIFIER_MAX_PROVIDER_CALLS,
    Math.max(0, maxProviderCalls - recoveryMaxProviderCalls - 1)
  );
  const extractorMaxProviderCalls = maxProviderCalls
    - verifierMaxProviderCalls
    - recoveryMaxProviderCalls;
  const policy = {
    targetInputTokensPerWindow: boundedInteger({
      value: env.WORK_REVIEW_TARGET_INPUT_TOKENS_PER_WINDOW,
      fallback: DEFAULT_WORK_REVIEW_TARGET_INPUT_TOKENS_PER_WINDOW,
      minimum: 800,
      maximum: 4_000,
      name: "WORK_REVIEW_TARGET_INPUT_TOKENS_PER_WINDOW"
    }),
    maxInputTokensPerWindow: boundedInteger({
      value: env.WORK_REVIEW_MAX_INPUT_TOKENS_PER_WINDOW,
      fallback: DEFAULT_WORK_REVIEW_MAX_INPUT_TOKENS_PER_WINDOW,
      minimum: 1_200,
      maximum: 6_000,
      name: "WORK_REVIEW_MAX_INPUT_TOKENS_PER_WINDOW"
    }),
    maxRecoverySplitDepth: boundedInteger({
      value: env.WORK_REVIEW_EXTRACTOR_MAX_RECOVERY_SPLIT_DEPTH,
      fallback: DEFAULT_WORK_REVIEW_EXTRACTOR_MAX_RECOVERY_SPLIT_DEPTH,
      minimum: 1,
      maximum: 2,
      name: "WORK_REVIEW_EXTRACTOR_MAX_RECOVERY_SPLIT_DEPTH"
    }),
    maxProviderCalls,
    extractorMaxProviderCalls,
    verifierMaxProviderCalls,
    recoveryMaxProviderCalls,
    analysisDeadlineMs: boundedInteger({
      value: env.WORK_REVIEW_ANALYSIS_DEADLINE_MS,
      fallback: DEFAULT_WORK_REVIEW_ANALYSIS_DEADLINE_MS,
      minimum: 30_000,
      maximum: DEFAULT_WORK_REVIEW_ANALYSIS_DEADLINE_MS,
      name: "WORK_REVIEW_ANALYSIS_DEADLINE_MS"
    })
  };
  if (policy.targetInputTokensPerWindow > policy.maxInputTokensPerWindow) {
    throw new WorkReviewRuntimeConfigError(
      "work_review_invalid_analysis_window_config",
      "WORK_REVIEW_TARGET_INPUT_TOKENS_PER_WINDOW cannot exceed WORK_REVIEW_MAX_INPUT_TOKENS_PER_WINDOW"
    );
  }
  return policy;
}

function assertFixtureAnalysisAllowed(
  provider: WorkReviewAnalysisProviderName,
  env: Readonly<Record<string, string | undefined>>
) {
  if (provider !== "fixture") return;
  if (env.NODE_ENV?.trim().toLowerCase() === "production") {
    throw new WorkReviewRuntimeConfigError(
      "work_review_analysis_fixture_forbidden_in_production",
      "Work Review fixture analysis is forbidden in production"
    );
  }
  if (!isStrictlyEnabled(env.WORK_REVIEW_FIXTURE_ANALYSIS_ENABLED)) {
    throw new WorkReviewRuntimeConfigError(
      "work_review_analysis_fixture_not_explicitly_enabled",
      "Work Review fixture analysis requires explicit non-production enablement"
    );
  }
}

function modelForProfile(input: {
  provider: WorkReviewAnalysisProviderName;
  configuredModel: string | undefined;
  fallbackModel: string | undefined;
  fieldName: string;
}) {
  if (input.provider === "fixture") return "work-review-deterministic-fixture-v1";
  const model = nonEmpty(input.configuredModel) ?? nonEmpty(input.fallbackModel);
  if (!model) {
    throw new WorkReviewRuntimeConfigError(
      "work_review_analysis_model_missing",
      `${input.fieldName} is required for Work Review analysis`
    );
  }
  return model;
}

export function resolveWorkReviewExtractorProfile(
  env: Readonly<Record<string, string | undefined>> = process.env
): WorkReviewAnalysisProviderProfile {
  const extractorProvider = providerName(
    env.WORK_REVIEW_EXTRACTOR_PROVIDER,
    "WORK_REVIEW_EXTRACTOR_PROVIDER"
  );
  assertFixtureAnalysisAllowed(extractorProvider, env);
  const sharedModel = extractorProvider === "deepseek-structured-json"
    ? nonEmpty(env.DEEPSEEK_MODEL)
    : extractorProvider === "tokenhub-structured-json" ? undefined
    : nonEmpty(env.OPENAI_TEXT_MODEL) ?? nonEmpty(env.OPENAI_QA_MODEL);
  const profile: WorkReviewAnalysisProviderProfile = {
    profileId: "work-meeting-extractor",
    provider: extractorProvider,
    model: modelForProfile({
      provider: extractorProvider,
      configuredModel: env.WORK_REVIEW_EXTRACTOR_MODEL,
      fallbackModel: sharedModel,
      fieldName: "WORK_REVIEW_EXTRACTOR_MODEL"
    }),
    reasoningEffort: reasoningEffort(
      env.WORK_REVIEW_EXTRACTOR_REASONING_EFFORT,
      "WORK_REVIEW_EXTRACTOR_REASONING_EFFORT",
      extractorProvider
    ),
    timeoutMs: boundedInteger({
      value: env.WORK_REVIEW_EXTRACTOR_TIMEOUT_MS,
      fallback: 90_000,
      minimum: 1_000,
      maximum: 10 * 60 * 1_000,
      name: "WORK_REVIEW_EXTRACTOR_TIMEOUT_MS"
    }),
    maxOutputTokens: boundedInteger({
      value: env.WORK_REVIEW_EXTRACTOR_MAX_OUTPUT_TOKENS,
      fallback: 4_000,
      minimum: 256,
      maximum: 8_000,
      name: "WORK_REVIEW_EXTRACTOR_MAX_OUTPUT_TOKENS"
    }),
    promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
    schemaVersion: WORK_MEETING_EXTRACTOR_SCHEMA_VERSION
  };
  assertWorkReviewAnalysisProfileSupported(profile);
  return profile;
}

export function resolveWorkReviewVerifierProfile(
  env: Readonly<Record<string, string | undefined>> = process.env
): WorkReviewAnalysisProviderProfile {
  const verifierProvider = providerName(
    env.WORK_REVIEW_VERIFIER_PROVIDER,
    "WORK_REVIEW_VERIFIER_PROVIDER"
  );
  assertFixtureAnalysisAllowed(verifierProvider, env);
  const sharedModel = verifierProvider === "deepseek-structured-json"
    ? nonEmpty(env.DEEPSEEK_MODEL)
    : verifierProvider === "tokenhub-structured-json" ? undefined
    : nonEmpty(env.OPENAI_TEXT_MODEL) ?? nonEmpty(env.OPENAI_QA_MODEL);
  const profile: WorkReviewAnalysisProviderProfile = {
    profileId: "work-meeting-verifier",
    provider: verifierProvider,
    model: modelForProfile({
      provider: verifierProvider,
      configuredModel: env.WORK_REVIEW_VERIFIER_MODEL,
      fallbackModel: sharedModel,
      fieldName: "WORK_REVIEW_VERIFIER_MODEL"
    }),
    reasoningEffort: reasoningEffort(
      env.WORK_REVIEW_VERIFIER_REASONING_EFFORT,
      "WORK_REVIEW_VERIFIER_REASONING_EFFORT",
      verifierProvider
    ),
    timeoutMs: boundedInteger({
      value: env.WORK_REVIEW_VERIFIER_TIMEOUT_MS,
      fallback: 120_000,
      minimum: 1_000,
      maximum: 10 * 60 * 1_000,
      name: "WORK_REVIEW_VERIFIER_TIMEOUT_MS"
    }),
    maxOutputTokens: boundedInteger({
      value: env.WORK_REVIEW_VERIFIER_MAX_OUTPUT_TOKENS,
      fallback: 3_000,
      minimum: 256,
      maximum: 8_000,
      name: "WORK_REVIEW_VERIFIER_MAX_OUTPUT_TOKENS"
    }),
    promptVersion: WORK_MEETING_VERIFIER_PROMPT_VERSION,
    schemaVersion: WORK_MEETING_VERIFIER_SCHEMA_VERSION
  };
  assertWorkReviewAnalysisProfileSupported(profile);
  return profile;
}

export function resolveWorkReviewAnalysisRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): WorkReviewAnalysisRuntimeConfig {
  return {
    extractor: resolveWorkReviewExtractorProfile(env),
    verifier: resolveWorkReviewVerifierProfile(env)
  };
}
