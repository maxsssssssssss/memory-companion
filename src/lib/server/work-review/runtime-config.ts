export type WorkReviewFeatureFlags = {
  enabled: boolean;
  uploadEnabled: boolean;
  analysisEnabled: boolean;
  verifierEnabled: boolean;
  todoEnabled: boolean;
  todoMeetingProjectionEnabled: boolean;
  followUpEnabled: boolean;
  recoveryEnabled: boolean;
};

export type WorkReviewCapacityLimits = {
  maxUploadBytes: number;
  maxAudioDurationSeconds: number;
};

export const DEFAULT_WORK_REVIEW_MAX_UPLOAD_BYTES = 300 * 1024 * 1024;
export const DEFAULT_WORK_REVIEW_MAX_AUDIO_DURATION_SECONDS = 4 * 60 * 60;

export type WorkReviewAnalysisProviderName =
  | "openai-compatible-structured-json"
  | "fixture";

export type WorkReviewReasoningEffort =
  | "provider_default"
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

export const WORK_MEETING_PIPELINE_VERSION = "work_meeting_v1" as const;
export const WORK_MEETING_EXTRACTOR_PROMPT_VERSION = "work_meeting_extractor_v1" as const;
export const WORK_MEETING_EXTRACTOR_SCHEMA_VERSION = "work_meeting_candidates_v1" as const;
export const WORK_MEETING_VERIFIER_PROMPT_VERSION = "work_meeting_verifier_v1" as const;
export const WORK_MEETING_VERIFIER_SCHEMA_VERSION = "work_meeting_claim_evaluations_v1" as const;
export const WORK_MEETING_PUBLICATION_POLICY_VERSION = "work_meeting_publication_v1" as const;

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
  if (normalized === "openai-compatible-structured-json" || normalized === "fixture") {
    return normalized;
  }
  throw new WorkReviewRuntimeConfigError(
    "work_review_unknown_analysis_provider",
    `${fieldName} must be openai-compatible-structured-json or fixture`
  );
}

function reasoningEffort(
  value: string | undefined,
  fieldName: string
): WorkReviewReasoningEffort {
  const normalized = nonEmpty(value)?.toLowerCase() ?? "provider_default";
  if (["provider_default", "minimal", "low", "medium", "high"].includes(normalized)) {
    return normalized as WorkReviewReasoningEffort;
  }
  throw new WorkReviewRuntimeConfigError(
    "work_review_unknown_reasoning_effort",
    `${fieldName} must be provider_default, minimal, low, medium, or high`
  );
}

export function resolveWorkReviewFeatureFlags(
  env: Readonly<Record<string, string | undefined>> = process.env
): WorkReviewFeatureFlags {
  const enabled = isStrictlyEnabled(env.WORK_REVIEW_ENABLED);
  const uploadEnabled = enabled && isStrictlyEnabled(env.WORK_REVIEW_UPLOAD_ENABLED);
  const analysisEnabled = uploadEnabled && isStrictlyEnabled(env.WORK_REVIEW_ANALYSIS_ENABLED);
  const verifierEnabled = analysisEnabled && isStrictlyEnabled(env.WORK_REVIEW_VERIFIER_ENABLED);
  const todoEnabled = enabled && isStrictlyEnabled(env.WORK_REVIEW_TODO_ENABLED);
  const todoMeetingProjectionEnabled = todoEnabled
    && analysisEnabled
    && isStrictlyEnabled(env.WORK_REVIEW_TODO_MEETING_PROJECTION_ENABLED);
  const followUpEnabled = analysisEnabled
    && isStrictlyEnabled(env.WORK_REVIEW_FOLLOW_UP_ENABLED);
  const recoveryEnabled = uploadEnabled
    && isStrictlyEnabled(env.WORK_REVIEW_RECOVERY_ENABLED);
  return {
    enabled,
    uploadEnabled,
    analysisEnabled,
    verifierEnabled,
    todoEnabled,
    todoMeetingProjectionEnabled,
    followUpEnabled,
    recoveryEnabled
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
  const sharedModel = nonEmpty(env.OPENAI_TEXT_MODEL) ?? nonEmpty(env.OPENAI_QA_MODEL);
  return {
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
      "WORK_REVIEW_EXTRACTOR_REASONING_EFFORT"
    ),
    timeoutMs: boundedInteger({
      value: env.WORK_REVIEW_EXTRACTOR_TIMEOUT_MS,
      fallback: 120_000,
      minimum: 1_000,
      maximum: 10 * 60 * 1_000,
      name: "WORK_REVIEW_EXTRACTOR_TIMEOUT_MS"
    }),
    maxOutputTokens: boundedInteger({
      value: env.WORK_REVIEW_EXTRACTOR_MAX_OUTPUT_TOKENS,
      fallback: 12_000,
      minimum: 256,
      maximum: 64_000,
      name: "WORK_REVIEW_EXTRACTOR_MAX_OUTPUT_TOKENS"
    }),
    promptVersion: WORK_MEETING_EXTRACTOR_PROMPT_VERSION,
    schemaVersion: WORK_MEETING_EXTRACTOR_SCHEMA_VERSION
  };
}

export function resolveWorkReviewVerifierProfile(
  env: Readonly<Record<string, string | undefined>> = process.env
): WorkReviewAnalysisProviderProfile {
  const verifierProvider = providerName(
    env.WORK_REVIEW_VERIFIER_PROVIDER,
    "WORK_REVIEW_VERIFIER_PROVIDER"
  );
  assertFixtureAnalysisAllowed(verifierProvider, env);
  const sharedModel = nonEmpty(env.OPENAI_TEXT_MODEL) ?? nonEmpty(env.OPENAI_QA_MODEL);
  return {
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
      "WORK_REVIEW_VERIFIER_REASONING_EFFORT"
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
      fallback: 8_000,
      minimum: 256,
      maximum: 64_000,
      name: "WORK_REVIEW_VERIFIER_MAX_OUTPUT_TOKENS"
    }),
    promptVersion: WORK_MEETING_VERIFIER_PROMPT_VERSION,
    schemaVersion: WORK_MEETING_VERIFIER_SCHEMA_VERSION
  };
}

export function resolveWorkReviewAnalysisRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env
): WorkReviewAnalysisRuntimeConfig {
  return {
    extractor: resolveWorkReviewExtractorProfile(env),
    verifier: resolveWorkReviewVerifierProfile(env)
  };
}
