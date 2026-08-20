import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const RUNTIME_REPORT_VERSION = 1 as const;
const RUNTIME_REPORT_DIRECTORY = "queue-runtime";
const RUNTIME_REPORT_FILE = "date-companion-memory-bridge-runtime-v1.json";

export type DateCompanionMemoryBridgeRuntimeReport = {
  running: boolean;
  startedAt: string;
  heartbeatAt: string;
  processed: number;
  retried: number;
  failed: number;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
};

type StoredRuntimeReport = DateCompanionMemoryBridgeRuntimeReport & {
  version: typeof RUNTIME_REPORT_VERSION;
};

export type DateCompanionMemoryBridgePreflightStatus =
  | "not_required"
  | "ok"
  | "invalid";

export type DateCompanionMemoryBridgeDatabaseStats = {
  pending: number;
  processing: number;
  retryableFailed: number;
  needsReview: number;
  waitingForCleanup: number;
  activeLeaseCount: number;
  oldestPendingAgeMs: number | null;
  processed: number;
  retried: number;
  failed: number;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
};

export type DateCompanionMemoryBridgeHealth =
  DateCompanionMemoryBridgeDatabaseStats & {
    enabled: boolean;
    consumerRunning: boolean;
    preflight: DateCompanionMemoryBridgePreflightStatus;
    schema: {
      dateCompanionVersion: number | null;
      memoryVersion: number | null;
      compatible: boolean;
    };
    ok: boolean;
    reasons: string[];
  };

type AggregateRow = {
  pending: number;
  processing: number;
  retryable_failed: number;
  needs_review: number;
  waiting_for_cleanup: number;
  active_lease_count: number;
  oldest_pending_at: string | null;
  processed: number;
  retried: number;
  failed: number;
  last_success_at: string | null;
  last_error_code: string | null;
};

const EMPTY_STATS: DateCompanionMemoryBridgeDatabaseStats = {
  pending: 0,
  processing: 0,
  retryableFailed: 0,
  needsReview: 0,
  waitingForCleanup: 0,
  activeLeaseCount: 0,
  oldestPendingAgeMs: null,
  processed: 0,
  retried: 0,
  failed: 0,
  lastSuccessAt: null,
  lastErrorCode: null
};

function nonNegativeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function safeErrorCode(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,120}$/u.test(value)
    ? value
    : null;
}

function runtimeReportPath(dataDirectory: string) {
  return join(dataDirectory, RUNTIME_REPORT_DIRECTORY, RUNTIME_REPORT_FILE);
}

function parseRuntimeReport(raw: string): StoredRuntimeReport | null {
  let value: Partial<StoredRuntimeReport>;
  try {
    value = JSON.parse(raw) as Partial<StoredRuntimeReport>;
  } catch {
    return null;
  }
  if (
    value.version !== RUNTIME_REPORT_VERSION
    || typeof value.running !== "boolean"
    || typeof value.startedAt !== "string"
    || !Number.isFinite(Date.parse(value.startedAt))
    || typeof value.heartbeatAt !== "string"
    || !Number.isFinite(Date.parse(value.heartbeatAt))
    || !Number.isSafeInteger(value.processed)
    || Number(value.processed) < 0
    || !Number.isSafeInteger(value.retried)
    || Number(value.retried) < 0
    || !Number.isSafeInteger(value.failed)
    || Number(value.failed) < 0
    || !(value.lastSuccessAt === null || (
      typeof value.lastSuccessAt === "string"
      && Number.isFinite(Date.parse(value.lastSuccessAt))
    ))
    || !(value.lastErrorCode === null || safeErrorCode(value.lastErrorCode) !== null)
  ) {
    return null;
  }
  return value as StoredRuntimeReport;
}

/** Writes one small, non-sensitive process report into the shared data root. */
export async function publishDateCompanionMemoryBridgeRuntimeReport(input: {
  dataDirectory: string;
  report: DateCompanionMemoryBridgeRuntimeReport;
}) {
  const directory = join(input.dataDirectory, RUNTIME_REPORT_DIRECTORY);
  const path = runtimeReportPath(input.dataDirectory);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const storedReport: StoredRuntimeReport = {
    version: RUNTIME_REPORT_VERSION,
    running: input.report.running,
    startedAt: input.report.startedAt,
    heartbeatAt: input.report.heartbeatAt,
    processed: input.report.processed,
    retried: input.report.retried,
    failed: input.report.failed,
    lastSuccessAt: input.report.lastSuccessAt,
    lastErrorCode: input.report.lastErrorCode
  };
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporaryPath, JSON.stringify(storedReport), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function inspectDateCompanionMemoryBridgeRuntimeReport(input: {
  dataDirectory: string;
  staleAfterMs: number;
  now?: Date;
}) {
  let report: StoredRuntimeReport | null = null;
  try {
    report = parseRuntimeReport(await readFile(runtimeReportPath(input.dataDirectory), "utf8"));
  } catch {
    // Missing, unreadable and partial reports all fail closed as not running.
  }
  if (!report) return { consumerRunning: false, report: null } as const;
  const nowMs = (input.now ?? new Date()).getTime();
  const heartbeatMs = Date.parse(report.heartbeatAt);
  const consumerRunning = report.running
    && nowMs >= heartbeatMs
    && nowMs - heartbeatMs <= input.staleAfterMs;
  const safeReport: DateCompanionMemoryBridgeRuntimeReport = {
    running: report.running,
    startedAt: report.startedAt,
    heartbeatAt: report.heartbeatAt,
    processed: report.processed,
    retried: report.retried,
    failed: report.failed,
    lastSuccessAt: report.lastSuccessAt,
    lastErrorCode: report.lastErrorCode
  };
  return { consumerRunning, report: safeReport } as const;
}

/**
 * Reads only structural outbox state. payload_json, Evidence, Person names and
 * user-authored text are deliberately absent from both the SELECT and DTO.
 */
export function inspectDateCompanionMemoryBridgeDatabaseStats(input: {
  database: Database.Database;
  now?: Date;
}): DateCompanionMemoryBridgeDatabaseStats {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const row = input.database.prepare(`
    SELECT
      COALESCE(SUM(CASE
        WHEN o.status = 'pending' AND i.source_state = 'server_cleaned' THEN 1 ELSE 0
      END), 0) AS pending,
      COALESCE(SUM(CASE WHEN o.status = 'processing' THEN 1 ELSE 0 END), 0) AS processing,
      COALESCE(SUM(CASE WHEN o.status = 'retryable_failed' THEN 1 ELSE 0 END), 0)
        AS retryable_failed,
      COALESCE(SUM(CASE WHEN o.status = 'needs_review' THEN 1 ELSE 0 END), 0)
        AS needs_review,
      COALESCE(SUM(CASE
        WHEN o.status = 'pending' AND i.source_state = 'available' THEN 1 ELSE 0
      END), 0) AS waiting_for_cleanup,
      COALESCE(SUM(CASE
        WHEN o.status = 'processing' AND o.lease_expires_at > ? THEN 1 ELSE 0
      END), 0) AS active_lease_count,
      MIN(CASE
        WHEN i.source_state = 'server_cleaned' AND (
          o.status IN ('pending', 'retryable_failed') OR
          (o.status = 'processing' AND o.lease_expires_at <= ?)
        ) THEN o.requested_at ELSE NULL
      END) AS oldest_pending_at,
      COALESCE(SUM(CASE WHEN o.status = 'completed' THEN 1 ELSE 0 END), 0) AS processed,
      COALESCE(SUM(CASE
        WHEN o.attempt_count > 1 THEN o.attempt_count - 1 ELSE 0
      END), 0) AS retried,
      COALESCE(SUM(CASE WHEN o.status = 'retryable_failed' THEN 1 ELSE 0 END), 0)
        AS failed,
      MAX(o.completed_at) AS last_success_at,
      (
        SELECT latest.last_error_code
        FROM dc_memory_bridge_outbox latest
        WHERE latest.last_error_code IS NOT NULL
        ORDER BY latest.updated_at DESC, latest.id DESC
        LIMIT 1
      ) AS last_error_code
    FROM dc_memory_bridge_outbox o
    INNER JOIN dc_interactions i
      ON i.id = o.interaction_id AND i.user_id = o.user_id
  `).get(nowIso, nowIso) as AggregateRow;

  const oldestTimestamp = row.oldest_pending_at === null
    ? Number.NaN
    : Date.parse(row.oldest_pending_at);
  return {
    pending: nonNegativeInteger(row.pending),
    processing: nonNegativeInteger(row.processing),
    retryableFailed: nonNegativeInteger(row.retryable_failed),
    needsReview: nonNegativeInteger(row.needs_review),
    waitingForCleanup: nonNegativeInteger(row.waiting_for_cleanup),
    activeLeaseCount: nonNegativeInteger(row.active_lease_count),
    oldestPendingAgeMs: Number.isFinite(oldestTimestamp)
      ? Math.max(0, now.getTime() - oldestTimestamp)
      : null,
    processed: nonNegativeInteger(row.processed),
    retried: nonNegativeInteger(row.retried),
    failed: nonNegativeInteger(row.failed),
    lastSuccessAt: row.last_success_at,
    lastErrorCode: safeErrorCode(row.last_error_code)
  };
}

export function evaluateDateCompanionMemoryBridgeHealth(input: {
  enabled: boolean;
  consumerRunning: boolean;
  preflight: DateCompanionMemoryBridgePreflightStatus;
  dateCompanionSchemaVersion: number | null;
  memorySchemaVersion: number | null;
  expectedDateCompanionSchemaVersion: number;
  expectedMemorySchemaVersion: number;
  oldestPendingWarnMs: number;
  failedCountThreshold: number;
  stats?: DateCompanionMemoryBridgeDatabaseStats;
}): DateCompanionMemoryBridgeHealth {
  const stats = input.stats ?? EMPTY_STATS;
  const schemaCompatible = input.dateCompanionSchemaVersion
    === input.expectedDateCompanionSchemaVersion
    && input.memorySchemaVersion === input.expectedMemorySchemaVersion;
  const reasons: string[] = [];

  if (input.enabled) {
    if (input.preflight !== "ok") reasons.push("memory_bridge_preflight_invalid");
    if (!schemaCompatible) reasons.push("memory_bridge_schema_incompatible");
    if (!input.consumerRunning) reasons.push("memory_bridge_consumer_not_running");
    if (
      stats.oldestPendingAgeMs !== null
      && stats.oldestPendingAgeMs > input.oldestPendingWarnMs
    ) {
      reasons.push("memory_bridge_oldest_pending_exceeded");
    }
    if (stats.retryableFailed > input.failedCountThreshold) {
      reasons.push("memory_bridge_retryable_failed_exceeded");
    }
  }

  return {
    enabled: input.enabled,
    consumerRunning: input.enabled && input.consumerRunning,
    ...stats,
    preflight: input.enabled ? input.preflight : "not_required",
    schema: {
      dateCompanionVersion: input.dateCompanionSchemaVersion,
      memoryVersion: input.memorySchemaVersion,
      compatible: schemaCompatible
    },
    ok: reasons.length === 0,
    reasons
  };
}
