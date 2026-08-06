import { getUserScopedStore } from "@/lib/server/auth/session";
import type { JsonStore } from "@/lib/server/storage/json-store";
import { createConfiguredVoiceprintService } from "@/lib/server/speaker-identity/voiceprint-service";

import { getDateCompanionDatabase } from "./db";
import { createDateCompanionRepository, type DateCompanionRepository } from "./repository";
import type {
  DcVoiceEnrollmentDispatchCandidate,
  DcVoiceEnrollmentDispatchJob
} from "./types";
import {
  dispatchDateCompanionVoiceEnrollment,
  isDateCompanionVoiceEnrollmentRuntimeAvailable,
  type DateCompanionVoiceEnrollmentDispatcher,
  type DateCompanionVoiceEnrollmentRepository
} from "./voice-enrollment";

const DEFAULTS = {
  pollIntervalMs: 5_000,
  maxAttempts: 3,
  retryBaseMs: 30_000,
  retryMaxMs: 15 * 60_000,
  batchSize: 10
} as const;

export type DateCompanionVoiceEnrollmentRuntimeConfig = {
  pollIntervalMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  batchSize: number;
};

export type DateCompanionVoiceEnrollmentCandidateRepository =
  DateCompanionVoiceEnrollmentRepository & Pick<
    DateCompanionRepository,
    "listVoiceEnrollmentDispatchCandidates"
  >;

type VoiceprintContactService = {
  saveContact(input: {
    userId: string;
    requestId: string;
    recordId: string;
    uploadId: string;
    chunkId: string;
    localSpeaker: string;
    globalSpeakerId: string;
    displayName: string;
    providerSpeakerId: string;
  }): Promise<{ profile: { globalSpeakerId: string } }>;
};

type RuntimeLogger = Pick<Console, "info" | "warn" | "error">;

export type DateCompanionVoiceEnrollmentPollReport = {
  scanned: number;
  eligible: number;
  dispatched: number;
  completed: number;
  failed: number;
};

export type DateCompanionVoiceEnrollmentWorkerRuntime = {
  runPromise: Promise<void>;
  pollNow(): Promise<DateCompanionVoiceEnrollmentPollReport>;
  close(): Promise<void>;
};

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
) {
  if (!value?.trim()) return fallback;
  if (!/^\d+$/u.test(value.trim())) {
    throw new Error(`Date Companion voice enrollment integer must be between ${minimum} and ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Date Companion voice enrollment integer must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function getDateCompanionVoiceEnrollmentRuntimeConfig(
  env: Record<string, string | undefined> = process.env
): DateCompanionVoiceEnrollmentRuntimeConfig {
  const retryBaseMs = boundedInteger(
    env.DATE_COMPANION_VOICE_ENROLLMENT_RETRY_BASE_MS,
    DEFAULTS.retryBaseMs,
    100,
    60 * 60_000
  );
  const retryMaxMs = boundedInteger(
    env.DATE_COMPANION_VOICE_ENROLLMENT_RETRY_MAX_MS,
    DEFAULTS.retryMaxMs,
    retryBaseMs,
    24 * 60 * 60_000
  );
  return {
    pollIntervalMs: boundedInteger(
      env.DATE_COMPANION_VOICE_ENROLLMENT_POLL_INTERVAL_MS,
      DEFAULTS.pollIntervalMs,
      100,
      60 * 60_000
    ),
    maxAttempts: boundedInteger(
      env.DATE_COMPANION_VOICE_ENROLLMENT_MAX_ATTEMPTS,
      DEFAULTS.maxAttempts,
      1,
      10
    ),
    retryBaseMs,
    retryMaxMs,
    batchSize: boundedInteger(
      env.DATE_COMPANION_VOICE_ENROLLMENT_BATCH_SIZE,
      DEFAULTS.batchSize,
      1,
      50
    )
  };
}

function retryDelayMs(
  attemptCount: number,
  config: DateCompanionVoiceEnrollmentRuntimeConfig
) {
  const exponent = Math.max(0, Math.min(30, attemptCount - 1));
  return Math.min(config.retryMaxMs, config.retryBaseMs * (2 ** exponent));
}

export function isVoiceEnrollmentCandidateEligible(
  candidate: DcVoiceEnrollmentDispatchCandidate,
  nowMs: number,
  config: DateCompanionVoiceEnrollmentRuntimeConfig
) {
  if (
    !Number.isSafeInteger(candidate.attemptCount)
    || candidate.attemptCount < 0
    || candidate.attemptCount >= config.maxAttempts
  ) {
    return false;
  }
  if (candidate.status === "pending") return true;
  if (candidate.status === "processing") {
    return !candidate.leaseExpiresAt || Date.parse(candidate.leaseExpiresAt) <= nowMs;
  }
  const updatedAtMs = Date.parse(candidate.updatedAt);
  return Number.isFinite(updatedAtMs)
    && updatedAtMs + retryDelayMs(candidate.attemptCount, config) <= nowMs;
}

class VoiceEnrollmentProfileMismatchError extends Error {
  readonly code = "voice_enrollment_profile_mismatch";

  constructor() {
    super("Voice enrollment profile does not match the expected identity");
    this.name = "VoiceEnrollmentProfileMismatchError";
  }
}

export function createConfiguredDateCompanionVoiceEnrollmentDispatcher(
  dependencies: {
    getUserStore?: (userId: string) => JsonStore;
    createService?: (store: JsonStore) => VoiceprintContactService;
  } = {}
): DateCompanionVoiceEnrollmentDispatcher {
  const getUserStore = dependencies.getUserStore ?? getUserScopedStore;
  const createService = dependencies.createService
    ?? ((store: JsonStore) => createConfiguredVoiceprintService(store));
  const services = new Map<string, VoiceprintContactService>();
  return {
    async enroll(job: DcVoiceEnrollmentDispatchJob) {
      let service = services.get(job.userId);
      if (!service) {
        service = createService(getUserStore(job.userId));
        services.set(job.userId, service);
      }
      const result = await service.saveContact({
        userId: job.userId,
        requestId: job.idempotencyKey,
        recordId: job.providerRecordId,
        uploadId: job.sourceUploadId,
        chunkId: job.chunkId,
        localSpeaker: job.localSpeaker,
        globalSpeakerId: job.expectedGlobalSpeakerId,
        displayName: "Ta",
        providerSpeakerId: job.providerSpeakerId
      });
      if (result.profile.globalSpeakerId !== job.expectedGlobalSpeakerId) {
        throw new VoiceEnrollmentProfileMismatchError();
      }
      return { profileGlobalSpeakerId: result.profile.globalSpeakerId };
    }
  };
}

function emptyPollReport(): DateCompanionVoiceEnrollmentPollReport {
  return {
    scanned: 0,
    eligible: 0,
    dispatched: 0,
    completed: 0,
    failed: 0
  };
}

export function startDateCompanionVoiceEnrollmentWorker(options: {
  enabled?: boolean;
  config?: DateCompanionVoiceEnrollmentRuntimeConfig;
  repository?: DateCompanionVoiceEnrollmentCandidateRepository;
  dispatcher?: DateCompanionVoiceEnrollmentDispatcher;
  dispatchCandidate?: (
    candidate: DcVoiceEnrollmentDispatchCandidate
  ) => Promise<{ status: "completed" | "failed" }>;
  now?: () => number;
  logger?: RuntimeLogger;
  startImmediately?: boolean;
} = {}): DateCompanionVoiceEnrollmentWorkerRuntime {
  const enabled = options.enabled ?? isDateCompanionVoiceEnrollmentRuntimeAvailable();
  if (!enabled) {
    throw new Error("Date Companion voice enrollment Worker is disabled");
  }
  const config = options.config ?? getDateCompanionVoiceEnrollmentRuntimeConfig();
  const repository = options.repository
    ?? createDateCompanionRepository(getDateCompanionDatabase());
  const dispatcher = options.dispatcher
    ?? createConfiguredDateCompanionVoiceEnrollmentDispatcher();
  const dispatchCandidate = options.dispatchCandidate ?? ((candidate) =>
    dispatchDateCompanionVoiceEnrollment({
      repository,
      dispatcher,
      userId: candidate.userId,
      outboxId: candidate.outboxId
    }));
  const now = options.now ?? Date.now;
  const logger = options.logger ?? console;
  const scanLimit = Math.min(1_000, Math.max(config.batchSize, config.batchSize * 20));
  let closing = false;
  let inFlight: Promise<DateCompanionVoiceEnrollmentPollReport> | null = null;
  let resolveRunPromise: (() => void) | undefined;
  const runPromise = new Promise<void>((resolve) => {
    resolveRunPromise = resolve;
  });

  const runPoll = async () => {
    const report = emptyPollReport();
    const timestampMs = now();
    if (closing) return report;
    const candidates = repository.listVoiceEnrollmentDispatchCandidates({
      now: new Date(timestampMs).toISOString(),
      limit: scanLimit,
      maxAttempts: config.maxAttempts
    });
    report.scanned = candidates.length;
    const eligible = candidates
      .filter((candidate) => isVoiceEnrollmentCandidateEligible(candidate, timestampMs, config))
      .slice(0, config.batchSize);
    report.eligible = eligible.length;
    logger.info(
      `[date-companion-voice-enrollment] dispatch completed=0 total=${eligible.length}`
    );
    for (const [index, candidate] of eligible.entries()) {
      if (closing) break;
      report.dispatched += 1;
      try {
        const result = await dispatchCandidate(candidate);
        if (result.status === "completed") report.completed += 1;
        else report.failed += 1;
      } catch (error) {
        report.failed += 1;
        logger.warn(
          `[date-companion-voice-enrollment] dispatch_failed error_name=${error instanceof Error ? error.name : "unknown"}`
        );
      }
      logger.info(
        `[date-companion-voice-enrollment] dispatch completed=${index + 1} total=${eligible.length}`
      );
    }
    return report;
  };

  const pollNow = () => {
    if (closing) return Promise.resolve(emptyPollReport());
    if (inFlight) return inFlight;
    inFlight = runPoll().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  const timer = setInterval(() => {
    void pollNow().catch((error: unknown) => {
      logger.error(
        `[date-companion-voice-enrollment] poll_failed error_name=${error instanceof Error ? error.name : "unknown"}`
      );
    });
  }, config.pollIntervalMs);
  timer.unref();
  if (options.startImmediately !== false) {
    void pollNow().catch((error: unknown) => {
      logger.error(
        `[date-companion-voice-enrollment] initial_poll_failed error_name=${error instanceof Error ? error.name : "unknown"}`
      );
    });
  }
  let closePromise: Promise<void> | undefined;
  return {
    runPromise,
    pollNow,
    close() {
      closePromise ??= (async () => {
        closing = true;
        clearInterval(timer);
        await inFlight?.catch(() => undefined);
        resolveRunPromise?.();
      })();
      return closePromise;
    }
  };
}
