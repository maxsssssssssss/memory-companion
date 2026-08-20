import type { DcVoiceEnrollmentDispatchJob } from "./types";
import { DateCompanionRepository } from "./repository";
import { getPipelineQueueConfig } from "@/lib/server/queue/config";

export type DateCompanionVoiceEnrollmentRepository = Pick<
  DateCompanionRepository,
  "claimVoiceEnrollment" | "completeVoiceEnrollment" | "failVoiceEnrollment"
>;

export function isDateCompanionVoiceEnrollmentEnabled(
  value = process.env.DATE_COMPANION_VOICE_ENROLLMENT_ENABLED
) {
  return value?.trim().toLowerCase() === "true";
}

export type DateCompanionVoiceEnrollmentAvailability =
  | { available: true; reason: "available" }
  | {
      available: false;
      reason: "flag_disabled" | "execution_mode_not_queue" | "queue_configuration_invalid";
    };

export function resolveDateCompanionVoiceEnrollmentAvailability(
  env: Record<string, string | undefined> = process.env
): DateCompanionVoiceEnrollmentAvailability {
  if (!isDateCompanionVoiceEnrollmentEnabled(env.DATE_COMPANION_VOICE_ENROLLMENT_ENABLED)) {
    return { available: false, reason: "flag_disabled" };
  }
  try {
    const queue = getPipelineQueueConfig(env);
    if (queue.executionMode !== "queue") {
      return { available: false, reason: "execution_mode_not_queue" };
    }
    return { available: true, reason: "available" };
  } catch {
    return { available: false, reason: "queue_configuration_invalid" };
  }
}

export function isDateCompanionVoiceEnrollmentRuntimeAvailable(
  env: Record<string, string | undefined> = process.env
) {
  return resolveDateCompanionVoiceEnrollmentAvailability(env).available;
}

export type DateCompanionVoiceEnrollmentDispatchResult = {
  profileGlobalSpeakerId: string;
};

/**
 * Date Companion owns only the durable outbox contract. A Worker adapter may
 * call the existing Voiceprint service, but no Provider implementation is
 * selected or invoked from this module.
 */
export interface DateCompanionVoiceEnrollmentDispatcher {
  enroll(
    job: DcVoiceEnrollmentDispatchJob
  ): Promise<DateCompanionVoiceEnrollmentDispatchResult>;
}

function dispatcherErrorCode(error: unknown) {
  if (
    error instanceof Error
    && "code" in error
    && typeof error.code === "string"
    && /^[A-Za-z0-9_-]{1,120}$/u.test(error.code)
  ) {
    return error.code;
  }
  return "voice_enrollment_dispatch_failed";
}

export async function dispatchDateCompanionVoiceEnrollment(input: {
  repository: DateCompanionVoiceEnrollmentRepository;
  dispatcher: DateCompanionVoiceEnrollmentDispatcher;
  userId: string;
  outboxId: string;
}) {
  const job = input.repository.claimVoiceEnrollment(input.userId, input.outboxId);
  try {
    const result = await input.dispatcher.enroll(job);
    return {
      status: "completed" as const,
      ...input.repository.completeVoiceEnrollment({
        userId: input.userId,
        outboxId: input.outboxId,
        claimToken: job.claimToken,
        profileGlobalSpeakerId: result.profileGlobalSpeakerId
      })
    };
  } catch (error) {
    input.repository.failVoiceEnrollment({
      userId: input.userId,
      outboxId: input.outboxId,
      claimToken: job.claimToken,
      errorCode: dispatcherErrorCode(error)
    });
    return { status: "failed" as const };
  }
}
