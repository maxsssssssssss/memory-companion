import { getUserScopedStore } from "@/lib/server/auth/session";
import { appStore, type JsonStore } from "@/lib/server/storage/json-store";

import { cleanupExpiredDateCompanionAudioStaging } from "./audio-staging";
import { getDateCompanionDatabase } from "./db";
import { createDateCompanionRepository, type DateCompanionRepository } from "./repository";

const DEFAULT_CLEANUP_INTERVAL_MS = 15 * 60_000;

export type DateCompanionSensitiveAudioCleanupReport = {
  users: number;
  failedUsers: number;
  stagingDeleted: number;
  participantAudioDeleted: number;
  participantCleanupFailed: boolean;
};

export type DateCompanionSensitiveAudioCleanupRuntime = {
  runPromise: Promise<void>;
  cleanupNow(): Promise<DateCompanionSensitiveAudioCleanupReport>;
  close(): Promise<void>;
};

type CleanupRepository = Pick<
  DateCompanionRepository,
  "cleanupExpiredParticipantAudioSamples"
>;

type CleanupLogger = Pick<Console, "info" | "warn" | "error">;

function cleanupIntervalMs(env: Record<string, string | undefined>) {
  const raw = env.DATE_COMPANION_SENSITIVE_AUDIO_CLEANUP_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_CLEANUP_INTERVAL_MS;
  if (!/^\d+$/u.test(raw)) {
    throw new Error("DATE_COMPANION_SENSITIVE_AUDIO_CLEANUP_INTERVAL_MS must be an integer");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 60_000 || value > 24 * 60 * 60_000) {
    throw new Error(
      "DATE_COMPANION_SENSITIVE_AUDIO_CLEANUP_INTERVAL_MS must be between 60000 and 86400000"
    );
  }
  return value;
}

async function defaultListUserIds() {
  const users = await appStore.list<{ id?: string }>("users");
  return [...new Set(users.map((record) =>
    typeof record.value.id === "string" && record.value.id.trim()
      ? record.value.id
      : record.id
  ))].sort();
}

function emptyReport(): DateCompanionSensitiveAudioCleanupReport {
  return {
    users: 0,
    failedUsers: 0,
    stagingDeleted: 0,
    participantAudioDeleted: 0,
    participantCleanupFailed: false
  };
}

export function startDateCompanionSensitiveAudioCleanupRuntime(options: {
  env?: Record<string, string | undefined>;
  intervalMs?: number;
  repository?: CleanupRepository;
  now?: () => number;
  logger?: CleanupLogger;
  listUserIds?: () => Promise<string[]>;
  getUserStore?: (userId: string) => JsonStore;
  cleanupStaging?: (store: JsonStore, now: string) => Promise<number>;
  startImmediately?: boolean;
} = {}): DateCompanionSensitiveAudioCleanupRuntime {
  const intervalMs = options.intervalMs ?? cleanupIntervalMs(options.env ?? process.env);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error("Date Companion sensitive-audio cleanup interval must be positive");
  }
  const repository = options.repository
    ?? createDateCompanionRepository(getDateCompanionDatabase());
  const now = options.now ?? Date.now;
  const logger = options.logger ?? console;
  const listUserIds = options.listUserIds ?? defaultListUserIds;
  const getUserStore = options.getUserStore ?? getUserScopedStore;
  const cleanupStaging = options.cleanupStaging ?? ((store, timestamp) =>
    cleanupExpiredDateCompanionAudioStaging({ store, now: () => timestamp }));
  let closing = false;
  let inFlight: Promise<DateCompanionSensitiveAudioCleanupReport> | null = null;
  let resolveRunPromise: (() => void) | undefined;
  const runPromise = new Promise<void>((resolve) => {
    resolveRunPromise = resolve;
  });

  const runCleanup = async () => {
    const report = emptyReport();
    const timestamp = new Date(now()).toISOString();
    const userIds = await listUserIds();
    report.users = userIds.length;
    logger.info(`[date-companion-audio-cleanup] completed=0 total=${userIds.length}`);
    for (const [index, userId] of userIds.entries()) {
      if (closing) break;
      try {
        report.stagingDeleted += await cleanupStaging(getUserStore(userId), timestamp);
      } catch (error) {
        report.failedUsers += 1;
        logger.warn(
          `[date-companion-audio-cleanup] staging_failed error_name=${error instanceof Error ? error.name : "unknown"}`
        );
      }
      logger.info(
        `[date-companion-audio-cleanup] completed=${index + 1} total=${userIds.length}`
      );
    }
    if (!closing) {
      try {
        report.participantAudioDeleted = repository.cleanupExpiredParticipantAudioSamples(
          timestamp
        );
      } catch (error) {
        report.participantCleanupFailed = true;
        logger.warn(
          `[date-companion-audio-cleanup] participant_failed error_name=${error instanceof Error ? error.name : "unknown"}`
        );
      }
    }
    logger.info(
      `[date-companion-audio-cleanup] finished users=${report.users} failed_users=${report.failedUsers} staging_deleted=${report.stagingDeleted} participant_deleted=${report.participantAudioDeleted}`
    );
    return report;
  };

  const cleanupNow = () => {
    if (closing) return Promise.resolve(emptyReport());
    if (inFlight) return inFlight;
    inFlight = runCleanup().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  const timer = setInterval(() => {
    void cleanupNow().catch((error: unknown) => {
      logger.error(
        `[date-companion-audio-cleanup] cycle_failed error_name=${error instanceof Error ? error.name : "unknown"}`
      );
    });
  }, intervalMs);
  timer.unref();
  if (options.startImmediately !== false) {
    void cleanupNow().catch((error: unknown) => {
      logger.error(
        `[date-companion-audio-cleanup] initial_failed error_name=${error instanceof Error ? error.name : "unknown"}`
      );
    });
  }
  let closePromise: Promise<void> | undefined;
  return {
    runPromise,
    cleanupNow,
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

export const dateCompanionSensitiveAudioCleanupDefaults = {
  intervalMilliseconds: DEFAULT_CLEANUP_INTERVAL_MS
} as const;
