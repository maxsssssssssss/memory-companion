import { WorkCanonicalSegmentsSchema } from "@/lib/domain/work-review";
import {
  getTranscriptionProviderRuntime,
  type TranscriptionProviderName
} from "@/lib/server/transcription/provider";
import {
  transcribeConfiguredAudio,
  type UploadTranscriptionInput,
  type UploadTranscriptionProcessor
} from "@/lib/server/transcription/chunks/process-audio";
import { WORK_REVIEW_AUDIO_CAPABILITY_SECRET_ENV } from "@/lib/server/transcription/audio-access-capability";

export type WorkMeetingTranscriptionInput = Omit<
  UploadTranscriptionInput,
  "identityPolicy" | "audioAccessPolicy"
>;

export type WorkMeetingTranscriber = (
  input: WorkMeetingTranscriptionInput
) => ReturnType<UploadTranscriptionProcessor>;

export type WorkTranscriptionRuntime = {
  name: TranscriptionProviderName;
  fallbackName: TranscriptionProviderName | null;
};

export class WorkReviewTranscriptionPolicyError extends Error {
  constructor(
    public readonly code:
      | "work_transcription_provider_missing"
      | "work_transcription_provider_mismatch"
      | "work_transcription_fixture_forbidden"
      | "work_transcription_fixture_not_explicitly_enabled"
      | "work_transcription_fallback_forbidden"
      | "work_transcription_audio_capability_missing"
      | "work_transcription_segments_invalid",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "WorkReviewTranscriptionPolicyError";
  }
}

function normalized(value: string | undefined) {
  const result = value?.trim().toLowerCase();
  return result ? result : undefined;
}

function explicitlyEnabled(value: string | undefined) {
  return normalized(value) === "true";
}

export function assertWorkReviewTranscriptionRuntime(input: {
  runtime: WorkTranscriptionRuntime;
  env?: Readonly<Record<string, string | undefined>>;
}) {
  const env = input.env ?? process.env;
  const configuredProvider = normalized(env.TRANSCRIPTION_PROVIDER);
  if (!configuredProvider) {
    throw new WorkReviewTranscriptionPolicyError(
      "work_transcription_provider_missing",
      "Work Review requires an explicitly configured transcription provider"
    );
  }
  if (configuredProvider !== input.runtime.name) {
    throw new WorkReviewTranscriptionPolicyError(
      "work_transcription_provider_mismatch",
      "Configured transcription provider does not match the resolved runtime"
    );
  }
  if (input.runtime.fallbackName !== null) {
    throw new WorkReviewTranscriptionPolicyError(
      "work_transcription_fallback_forbidden",
      "Work Review transcription must fail closed instead of using a fallback provider"
    );
  }
  if (input.runtime.name === "speaker-asr" && !normalized(env[WORK_REVIEW_AUDIO_CAPABILITY_SECRET_ENV])) {
    throw new WorkReviewTranscriptionPolicyError(
      "work_transcription_audio_capability_missing",
      "Work Review speaker-asr requires a product-scoped audio capability secret"
    );
  }
  if (input.runtime.name !== "fixture") return;
  if (normalized(env.NODE_ENV) === "production") {
    throw new WorkReviewTranscriptionPolicyError(
      "work_transcription_fixture_forbidden",
      "Work Review fixture transcription is forbidden in production"
    );
  }
  if (!explicitlyEnabled(env.WORK_REVIEW_FIXTURE_TRANSCRIPTION_ENABLED)) {
    throw new WorkReviewTranscriptionPolicyError(
      "work_transcription_fixture_not_explicitly_enabled",
      "Work Review fixture transcription requires explicit non-production enablement"
    );
  }
}

export function createWorkMeetingTranscriber(dependencies: {
  resolveRuntime?: () => WorkTranscriptionRuntime;
  transcribe?: UploadTranscriptionProcessor;
  env?: Readonly<Record<string, string | undefined>>;
} = {}): WorkMeetingTranscriber {
  const resolveRuntime = dependencies.resolveRuntime ?? getTranscriptionProviderRuntime;
  const transcribe = dependencies.transcribe ?? transcribeConfiguredAudio;
  return async (input) => {
    assertWorkReviewTranscriptionRuntime({
      runtime: resolveRuntime(),
      env: dependencies.env
    });
    let rawSegments;
    try {
      rawSegments = await transcribe({
        ...input,
        // Work Review must not read or publish shared Person/voiceprint identity.
        identityPolicy: "skip",
        // Work audio uses a short-lived product-scoped capability; the global
        // legacy Speaker-ASR bearer cannot authorize Work source audio.
        audioAccessPolicy: "work_review_capability"
      });
    } catch (error) {
      throw error;
    }
    const withoutIdentity = rawSegments.map((segment) => {
      const { identity: _identity, ...safeSegment } = segment;
      return safeSegment;
    });
    const parsed = WorkCanonicalSegmentsSchema.safeParse(withoutIdentity);
    if (!parsed.success || parsed.data.some((segment) => segment.uploadId !== input.uploadId)) {
      throw new WorkReviewTranscriptionPolicyError(
        "work_transcription_segments_invalid",
        "Work Review transcription returned invalid canonical segments",
        parsed.success ? undefined : { cause: parsed.error }
      );
    }
    return [...parsed.data].sort((left, right) =>
      left.startSeconds - right.startSeconds
      || left.endSeconds - right.endSeconds
      || left.id.localeCompare(right.id)
    );
  };
}

export const transcribeWorkMeetingAudio = createWorkMeetingTranscriber();
