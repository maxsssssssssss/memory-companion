import {
  getUserScopedStore,
  getUserUploadsRootDir
} from "@/lib/server/auth/session";
import type {
  RecoverStaleWorkMeetingsInput,
  WorkMeetingRecoveryDependencies,
  WorkMeetingRecoveryProgress,
  WorkMeetingRecoveryRuntime,
  WorkMeetingRecoverySummary
} from "@/lib/server/work-review/recovery";
import { resolveWorkReviewFeatureFlags } from "@/lib/server/work-review/runtime-config";

type RecoverStaleWorkMeetings = (
  input: RecoverStaleWorkMeetingsInput,
  dependencies?: WorkMeetingRecoveryDependencies
) => Promise<WorkMeetingRecoverySummary>;

let activeStartupRecovery: Promise<WorkMeetingRecoverySummary> | null = null;

export type WorkReviewStartupRecoveryDependencies = {
  recoverStaleWorkMeetings?: RecoverStaleWorkMeetings;
  resolveRuntime?: (
    accountId: string
  ) => WorkMeetingRecoveryRuntime | null | Promise<WorkMeetingRecoveryRuntime | null>;
  logger?: Pick<Console, "info">;
};

async function defaultRecoverStaleWorkMeetings(
  input: RecoverStaleWorkMeetingsInput,
  dependencies?: WorkMeetingRecoveryDependencies
) {
  const recovery = await import("@/lib/server/work-review/recovery");
  return recovery.recoverStaleWorkMeetings(input, dependencies);
}

function defaultResolveRuntime(accountId: string): WorkMeetingRecoveryRuntime {
  return {
    store: getUserScopedStore(accountId),
    uploadsRootDir: getUserUploadsRootDir(accountId)
  };
}

function logRecoveryProgress(
  logger: Pick<Console, "info">,
  progress: WorkMeetingRecoveryProgress
) {
  logger.info(
    `[work-review-worker] recovery progress=${progress.completed}/${progress.total} ` +
    `state=${progress.state}` +
    (progress.outcome ? ` outcome=${progress.outcome}` : "")
  );
}

/**
 * Runs one bounded Work Review recovery pass during worker startup.
 *
 * The Core recovery owns the candidate bound, lease/fence checks and
 * idempotency. This adapter owns only feature gating, account-scoped runtime
 * resolution and privacy-safe operational logging.
 */
export async function runWorkReviewStartupRecovery(
  env: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: WorkReviewStartupRecoveryDependencies = {}
): Promise<WorkMeetingRecoverySummary | null> {
  const flags = resolveWorkReviewFeatureFlags(env);
  if (!flags.recoveryEnabled) return null;

  const logger = dependencies.logger ?? console;
  if (activeStartupRecovery) return activeStartupRecovery;
  const recover = dependencies.recoverStaleWorkMeetings
    ?? defaultRecoverStaleWorkMeetings;
  const currentRecovery = recover({
      allowTranscription: flags.uploadEnabled,
      allowAnalysis: flags.analysisEnabled,
      resolveRuntime: dependencies.resolveRuntime ?? defaultResolveRuntime
    }, {
      onProgress: (progress) => logRecoveryProgress(logger, progress)
    })
    .then((summary) => {
      logger.info(
        `[work-review-worker] recovery selected=${summary.selected} ` +
        `completed=${summary.completed} recovered=${summary.recovered} ` +
        `failed=${summary.failed} skipped_busy=${summary.skippedBusy} ` +
        `skipped_changed=${summary.skippedChanged} ` +
        `skipped_deleted=${summary.skippedDeleted} errors=${summary.errors}`
      );
      return summary;
    });
  activeStartupRecovery = currentRecovery;
  try {
    return await currentRecovery;
  } finally {
    if (activeStartupRecovery === currentRecovery) {
      activeStartupRecovery = null;
    }
  }
}
