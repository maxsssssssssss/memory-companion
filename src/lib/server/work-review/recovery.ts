import type Database from "better-sqlite3";

import type { JsonStore } from "@/lib/server/storage/json-store";

import { getWorkReviewDatabase } from "./db";
import {
  processWorkMeeting,
  type ProcessWorkMeetingInput,
  type ProcessWorkMeetingResult,
  type WorkMeetingProcessorDependencies
} from "./orchestrator";
import {
  WorkReviewConflictError,
  WorkReviewLeaseLostError,
  WorkReviewRepository,
  type WorkProcessingStage
} from "./repository";
import { WORK_MEETING_PIPELINE_VERSION } from "./runtime-config";

const DEFAULT_RECOVERY_BATCH_SIZE = 10;
const MAX_RECOVERY_BATCH_SIZE = 50;
const DEFAULT_STALE_AFTER_MS = 15 * 60_000;
const RECOVERY_FAILURE_LEASE_MS = 60_000;

type RecoveryCandidate = {
  accountId: string;
  meetingId: string;
  stage: WorkProcessingStage;
  attemptVersion: number;
  updatedAt: string;
};

type RecoveryCandidateRow = {
  account_id: string;
  meeting_id: string;
  stage: WorkProcessingStage;
  attempt_version: number;
  updated_at: string;
};

type RecoveryStateRow = {
  ingestion_status: string;
  analysis_status: string;
  current_transcription_attempt: number;
  current_analysis_attempt: number;
  updated_at: string;
  deleted_at: string | null;
  tombstoned: number;
  active_lease_expires_at: string | null;
};

type RecoveryOutcome =
  | "recovered"
  | "failed"
  | "skipped_busy"
  | "skipped_changed"
  | "skipped_deleted"
  | "error";

export type WorkMeetingRecoveryRuntime = {
  store: JsonStore;
  uploadsRootDir: string;
};

export type RecoverStaleWorkMeetingsInput = {
  /** Recovery must respect the same feature gates used by ordinary processing. */
  allowTranscription: boolean;
  allowAnalysis: boolean;
  resolveRuntime: (
    accountId: string
  ) => WorkMeetingRecoveryRuntime | null | Promise<WorkMeetingRecoveryRuntime | null>;
  batchSize?: number;
  staleAfterMs?: number;
  now?: string;
};

export type WorkMeetingRecoveryProgress = {
  completed: number;
  total: number;
  state: "started" | "processing" | "completed";
  outcome?: RecoveryOutcome;
};

export type WorkMeetingRecoverySummary = {
  selected: number;
  completed: number;
  recovered: number;
  failed: number;
  skippedBusy: number;
  skippedChanged: number;
  skippedDeleted: number;
  errors: number;
};

type RecoveryProcessMeeting = (
  request: ProcessWorkMeetingInput,
  dependencies?: WorkMeetingProcessorDependencies
) => Promise<ProcessWorkMeetingResult>;

export type WorkMeetingRecoveryDependencies = {
  database?: Database.Database;
  processMeeting?: RecoveryProcessMeeting;
  processorDependencies?: Omit<WorkMeetingProcessorDependencies, "repository">;
  processingNow?: () => string;
  onProgress?: (event: WorkMeetingRecoveryProgress) => void;
};

function boundedBatchSize(value: number | undefined) {
  if (value === undefined) return DEFAULT_RECOVERY_BATCH_SIZE;
  if (!Number.isFinite(value)) return DEFAULT_RECOVERY_BATCH_SIZE;
  return Math.max(1, Math.min(MAX_RECOVERY_BATCH_SIZE, Math.trunc(value)));
}

function recoveryClock(input: RecoverStaleWorkMeetingsInput) {
  const now = input.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error("work_review_recovery_invalid_clock");
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
    throw new Error("work_review_recovery_invalid_stale_window");
  }
  return {
    now,
    nowMs,
    cutoff: new Date(nowMs - staleAfterMs).toISOString()
  };
}

function listRecoveryCandidates(input: {
  database: Database.Database;
  cutoff: string;
  batchSize: number;
  allowTranscription: boolean;
  allowAnalysis: boolean;
}): RecoveryCandidate[] {
  const eligible: string[] = [];
  if (input.allowTranscription) {
    eligible.push("meeting.ingestion_status IN ('queued', 'transcribing')");
  }
  if (input.allowAnalysis) {
    eligible.push(`(
      meeting.ingestion_status = 'transcript_ready'
      AND meeting.analysis_status IN ('queued', 'extracting', 'verifying')
    )`);
  }
  if (eligible.length === 0) return [];

  const rows = input.database.prepare(`
    SELECT
      meeting.account_id,
      meeting.id AS meeting_id,
      CASE
        WHEN meeting.ingestion_status IN ('queued', 'transcribing')
          THEN 'transcription'
        ELSE 'meeting_analysis'
      END AS stage,
      CASE
        WHEN meeting.ingestion_status IN ('queued', 'transcribing')
          THEN meeting.current_transcription_attempt
        ELSE meeting.current_analysis_attempt
      END AS attempt_version,
      meeting.updated_at
    FROM wr_meetings meeting
    WHERE meeting.updated_at <= ?
      AND meeting.deleted_at IS NULL
      AND meeting.ingestion_status <> 'deleted'
      AND meeting.analysis_status <> 'deleted'
      AND NOT EXISTS (
        SELECT 1 FROM wr_tombstones tombstone
        WHERE tombstone.account_id = meeting.account_id
          AND tombstone.meeting_id = meeting.id
      )
      AND (${eligible.join(" OR ")})
    ORDER BY meeting.updated_at, meeting.id
    LIMIT ?
  `).all(input.cutoff, input.batchSize) as RecoveryCandidateRow[];

  return rows.map((row) => ({
    accountId: row.account_id,
    meetingId: row.meeting_id,
    stage: row.stage,
    attemptVersion: row.attempt_version,
    updatedAt: row.updated_at
  }));
}

function stageForState(row: RecoveryStateRow): WorkProcessingStage | null {
  if (["queued", "transcribing"].includes(row.ingestion_status)) return "transcription";
  if (row.ingestion_status === "transcript_ready"
    && ["queued", "extracting", "verifying"].includes(row.analysis_status)) {
    return "meeting_analysis";
  }
  return null;
}

function readRecoveryState(
  database: Database.Database,
  candidate: RecoveryCandidate
): RecoveryStateRow | null {
  return database.prepare(`
    SELECT
      meeting.ingestion_status,
      meeting.analysis_status,
      meeting.current_transcription_attempt,
      meeting.current_analysis_attempt,
      meeting.updated_at,
      meeting.deleted_at,
      EXISTS (
        SELECT 1 FROM wr_tombstones tombstone
        WHERE tombstone.account_id = meeting.account_id
          AND tombstone.meeting_id = meeting.id
      ) AS tombstoned,
      (
        SELECT attempt.lease_expires_at
        FROM wr_processing_attempts attempt
        WHERE attempt.account_id = meeting.account_id
          AND attempt.meeting_id = meeting.id
          AND attempt.stage = ?
          AND attempt.state = 'processing'
        ORDER BY attempt.attempt_version DESC
        LIMIT 1
      ) AS active_lease_expires_at
    FROM wr_meetings meeting
    WHERE meeting.account_id = ? AND meeting.id = ?
  `).get(candidate.stage, candidate.accountId, candidate.meetingId) as
    RecoveryStateRow | undefined ?? null;
}

function revalidateCandidate(input: {
  database: Database.Database;
  candidate: RecoveryCandidate;
  nowMs: number;
}): "live" | "busy" | "changed" | "deleted" {
  const row = readRecoveryState(input.database, input.candidate);
  if (!row || row.deleted_at || row.tombstoned
    || row.ingestion_status === "deleted" || row.analysis_status === "deleted") {
    return "deleted";
  }
  const currentAttempt = input.candidate.stage === "transcription"
    ? row.current_transcription_attempt
    : row.current_analysis_attempt;
  if (stageForState(row) !== input.candidate.stage
    || currentAttempt !== input.candidate.attemptVersion
    || row.updated_at !== input.candidate.updatedAt) {
    return "changed";
  }
  if (row.active_lease_expires_at) {
    const leaseExpiresAtMs = Date.parse(row.active_lease_expires_at);
    if (!Number.isFinite(leaseExpiresAtMs)) return "changed";
    if (leaseExpiresAtMs > input.nowMs) return "busy";
  }
  return "live";
}

function unsafeRecoveryCode(
  database: Database.Database,
  candidate: RecoveryCandidate
): string | null {
  if (candidate.stage === "transcription") {
    const canonical = database.prepare(`
      SELECT 1 FROM wr_canonical_publications
      WHERE account_id = ? AND meeting_id = ? AND asset_kind = 'segments'
        AND tombstoned_at IS NULL
    `).get(candidate.accountId, candidate.meetingId);
    if (canonical) return null;
    const source = database.prepare(`
      SELECT file_path FROM wr_source_uploads
      WHERE account_id = ? AND meeting_id = ?
    `).get(candidate.accountId, candidate.meetingId) as
      { file_path: string | null } | undefined;
    return source?.file_path
      ? null
      : "work_review_recovery_source_unavailable";
  }

  const canonical = database.prepare(`
    SELECT 1
    FROM wr_meetings meeting
    JOIN wr_canonical_publications publication
      ON publication.account_id = meeting.account_id
     AND publication.meeting_id = meeting.id
     AND publication.publication_id = meeting.canonical_publication_id
     AND publication.content_digest = meeting.canonical_content_digest
     AND publication.asset_kind = 'segments'
     AND publication.tombstoned_at IS NULL
    WHERE meeting.account_id = ? AND meeting.id = ?
  `).get(candidate.accountId, candidate.meetingId);
  return canonical ? null : "work_review_recovery_canonical_missing";
}

function classifyRepositoryError(error: unknown): RecoveryOutcome {
  if (error instanceof WorkReviewConflictError && error.code === "work_review_tombstoned") {
    return "skipped_deleted";
  }
  if (error instanceof WorkReviewLeaseLostError) return "skipped_busy";
  return "error";
}

function failRecoveryCandidate(input: {
  database: Database.Database;
  repository: WorkReviewRepository;
  candidate: RecoveryCandidate;
  errorCode: string;
  processingNow: () => string;
}): RecoveryOutcome {
  const now = input.processingNow();
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return "error";
  try {
    const fence = input.repository.claimProcessingAttempt({
      accountId: input.candidate.accountId,
      meetingId: input.candidate.meetingId,
      stage: input.candidate.stage,
      leaseOwner: `work-recovery-guard-${input.candidate.meetingId}`,
      leaseDurationMs: RECOVERY_FAILURE_LEASE_MS,
      pipelineVersion: WORK_MEETING_PIPELINE_VERSION,
      providerProfile: "work_recovery_guard",
      promptVersion: null,
      expectedAttemptVersion: input.candidate.attemptVersion,
      expectedUpdatedAt: input.candidate.updatedAt,
      now
    });
    if (!fence) {
      const state = revalidateCandidate({
        database: input.database,
        candidate: input.candidate,
        nowMs
      });
      if (state === "busy") return "skipped_busy";
      if (state === "deleted") return "skipped_deleted";
      return "skipped_changed";
    }
    input.repository.markStageFailed({
      accountId: input.candidate.accountId,
      meetingId: input.candidate.meetingId,
      fence,
      errorCode: input.errorCode,
      now
    });
    return "failed";
  } catch (error) {
    return classifyRepositoryError(error);
  }
}

function classifyCompletedStage(input: {
  repository: WorkReviewRepository;
  candidate: RecoveryCandidate;
}) {
  try {
    const meeting = input.repository.getMeeting(
      input.candidate.accountId,
      input.candidate.meetingId
    );
    if (meeting.deletedAt || meeting.ingestionStatus === "deleted"
      || meeting.analysisStatus === "deleted") return "skipped_deleted" as const;
    if (input.candidate.stage === "transcription") {
      if (meeting.ingestionStatus === "transcript_ready") return "recovered" as const;
      if (meeting.ingestionStatus === "failed") return "failed" as const;
    } else {
      if (meeting.analysisStatus === "review_ready") return "recovered" as const;
      if (meeting.analysisStatus === "failed") return "failed" as const;
    }
    return null;
  } catch (error) {
    return classifyRepositoryError(error);
  }
}

async function recoverCandidate(input: {
  database: Database.Database;
  repository: WorkReviewRepository;
  candidate: RecoveryCandidate;
  request: RecoverStaleWorkMeetingsInput;
  now: string;
  nowMs: number;
  processingNow: () => string;
  processMeeting: RecoveryProcessMeeting;
  processorDependencies?: Omit<WorkMeetingProcessorDependencies, "repository">;
}): Promise<RecoveryOutcome> {
  const state = revalidateCandidate({
    database: input.database,
    candidate: input.candidate,
    nowMs: input.nowMs
  });
  if (state === "busy") return "skipped_busy";
  if (state === "changed") return "skipped_changed";
  if (state === "deleted") return "skipped_deleted";

  const unsafeCode = unsafeRecoveryCode(input.database, input.candidate);
  if (unsafeCode) {
    return failRecoveryCandidate({
      database: input.database,
      repository: input.repository,
      candidate: input.candidate,
      errorCode: unsafeCode,
      processingNow: input.processingNow
    });
  }

  let runtime: WorkMeetingRecoveryRuntime | null;
  try {
    runtime = await input.request.resolveRuntime(input.candidate.accountId);
  } catch {
    runtime = null;
  }
  if (!runtime) {
    return failRecoveryCandidate({
      database: input.database,
      repository: input.repository,
      candidate: input.candidate,
      errorCode: "work_review_recovery_runtime_unavailable",
      processingNow: input.processingNow
    });
  }

  let processResult: ProcessWorkMeetingResult;
  try {
    processResult = await input.processMeeting({
      accountId: input.candidate.accountId,
      meetingId: input.candidate.meetingId,
      store: runtime.store,
      uploadsRootDir: runtime.uploadsRootDir
    }, {
      ...input.processorDependencies,
      repository: input.repository
    });
  } catch {
    return failRecoveryCandidate({
      database: input.database,
      repository: input.repository,
      candidate: input.candidate,
      errorCode: "work_review_recovery_processing_failed",
      processingNow: input.processingNow
    });
  }
  if (processResult.busy) return "skipped_busy";

  const completed = classifyCompletedStage({
    repository: input.repository,
    candidate: input.candidate
  });
  if (completed) return completed;
  return failRecoveryCandidate({
    database: input.database,
    repository: input.repository,
    candidate: input.candidate,
    errorCode: "work_review_recovery_no_progress",
    processingNow: input.processingNow
  });
}

function incrementSummary(
  summary: WorkMeetingRecoverySummary,
  outcome: RecoveryOutcome
) {
  if (outcome === "recovered") summary.recovered += 1;
  else if (outcome === "failed") summary.failed += 1;
  else if (outcome === "skipped_busy") summary.skippedBusy += 1;
  else if (outcome === "skipped_changed") summary.skippedChanged += 1;
  else if (outcome === "skipped_deleted") summary.skippedDeleted += 1;
  else summary.errors += 1;
}

/**
 * Recovers only bounded, stale Work-owned processing states. The caller owns
 * scheduling and must pass the currently enabled processing stages explicitly.
 */
export async function recoverStaleWorkMeetings(
  input: RecoverStaleWorkMeetingsInput,
  dependencies: WorkMeetingRecoveryDependencies = {}
): Promise<WorkMeetingRecoverySummary> {
  const clock = recoveryClock(input);
  const database = dependencies.database ?? getWorkReviewDatabase();
  // The scan cutoff is a stable batch snapshot, but processing leases must use
  // a live clock so a long batch or long ASR call cannot extend a stale fence.
  const repository = new WorkReviewRepository(database, {
    now: dependencies.processingNow ?? (() => new Date().toISOString())
  });
  const candidates = listRecoveryCandidates({
    database,
    cutoff: clock.cutoff,
    batchSize: boundedBatchSize(input.batchSize),
    allowTranscription: input.allowTranscription,
    allowAnalysis: input.allowAnalysis
  });
  const summary: WorkMeetingRecoverySummary = {
    selected: candidates.length,
    completed: 0,
    recovered: 0,
    failed: 0,
    skippedBusy: 0,
    skippedChanged: 0,
    skippedDeleted: 0,
    errors: 0
  };

  dependencies.onProgress?.({
    completed: 0,
    total: candidates.length,
    state: "started"
  });
  for (const candidate of candidates) {
    const outcome = await recoverCandidate({
      database,
      repository,
      candidate,
      request: input,
      now: clock.now,
      nowMs: clock.nowMs,
      processingNow: dependencies.processingNow ?? (() => new Date().toISOString()),
      processMeeting: dependencies.processMeeting ?? processWorkMeeting,
      processorDependencies: dependencies.processorDependencies
    });
    summary.completed += 1;
    incrementSummary(summary, outcome);
    dependencies.onProgress?.({
      completed: summary.completed,
      total: candidates.length,
      state: "processing",
      outcome
    });
  }
  dependencies.onProgress?.({
    completed: summary.completed,
    total: candidates.length,
    state: "completed"
  });
  return summary;
}
