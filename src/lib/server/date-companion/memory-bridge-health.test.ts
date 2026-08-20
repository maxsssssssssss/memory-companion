// @vitest-environment node

import Database from "better-sqlite3";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  evaluateDateCompanionMemoryBridgeHealth,
  inspectDateCompanionMemoryBridgeDatabaseStats,
  inspectDateCompanionMemoryBridgeRuntimeReport,
  publishDateCompanionMemoryBridgeRuntimeReport
} from "./memory-bridge-health";

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];

function createDatabase() {
  const database = new Database(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE dc_interactions (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      source_state TEXT NOT NULL,
      PRIMARY KEY (id, user_id)
    );
    CREATE TABLE dc_memory_bridge_outbox (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      interaction_id TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      lease_expires_at TEXT,
      last_error_code TEXT,
      requested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
  `);
  return database;
}

function insertRow(input: {
  database: Database.Database;
  id: string;
  sourceState: "available" | "server_cleaned";
  status: string;
  attemptCount?: number;
  requestedAt?: string;
  leaseExpiresAt?: string | null;
  completedAt?: string | null;
  lastErrorCode?: string | null;
}) {
  input.database.prepare(`
    INSERT INTO dc_interactions (id, user_id, source_state) VALUES (?, 'user-1', ?)
  `).run(input.id, input.sourceState);
  input.database.prepare(`
    INSERT INTO dc_memory_bridge_outbox (
      id, user_id, interaction_id, status, attempt_count, lease_expires_at,
      last_error_code, requested_at, updated_at, completed_at
    ) VALUES (?, 'user-1', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `outbox-${input.id}`,
    input.id,
    input.status,
    input.attemptCount ?? 0,
    input.leaseExpiresAt ?? null,
    input.lastErrorCode ?? null,
    input.requestedAt ?? "2026-08-11T00:00:00.000Z",
    input.requestedAt ?? "2026-08-11T00:00:00.000Z",
    input.completedAt ?? null
  );
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("date companion memory bridge health", () => {
  it("reports structural backlog without reading payload or user content", () => {
    const database = createDatabase();
    insertRow({ database, id: "pending", sourceState: "server_cleaned", status: "pending" });
    insertRow({ database, id: "waiting", sourceState: "available", status: "pending" });
    insertRow({
      database,
      id: "active",
      sourceState: "server_cleaned",
      status: "processing",
      leaseExpiresAt: "2026-08-11T00:10:00.000Z"
    });
    insertRow({
      database,
      id: "retry",
      sourceState: "server_cleaned",
      status: "retryable_failed",
      attemptCount: 3,
      lastErrorCode: "bridge_retryable"
    });
    insertRow({
      database,
      id: "review",
      sourceState: "server_cleaned",
      status: "needs_review"
    });
    insertRow({
      database,
      id: "done",
      sourceState: "server_cleaned",
      status: "completed",
      attemptCount: 1,
      completedAt: "2026-08-11T00:01:00.000Z"
    });

    expect(inspectDateCompanionMemoryBridgeDatabaseStats({
      database,
      now: new Date("2026-08-11T00:05:00.000Z")
    })).toEqual({
      pending: 1,
      processing: 1,
      retryableFailed: 1,
      needsReview: 1,
      waitingForCleanup: 1,
      activeLeaseCount: 1,
      oldestPendingAgeMs: 300_000,
      processed: 1,
      retried: 2,
      failed: 1,
      lastSuccessAt: "2026-08-11T00:01:00.000Z",
      lastErrorCode: "bridge_retryable"
    });
  });

  it("treats disabled as healthy and needs_review as product state", () => {
    const disabled = evaluateDateCompanionMemoryBridgeHealth({
      enabled: false,
      consumerRunning: false,
      preflight: "invalid",
      dateCompanionSchemaVersion: null,
      memorySchemaVersion: null,
      expectedDateCompanionSchemaVersion: 6,
      expectedMemorySchemaVersion: 9,
      oldestPendingWarnMs: 60_000,
      failedCountThreshold: 10
    });
    expect(disabled.ok).toBe(true);
    expect(disabled.preflight).toBe("not_required");
    expect(disabled.reasons).toEqual([]);

    const needsReview = evaluateDateCompanionMemoryBridgeHealth({
      enabled: true,
      consumerRunning: true,
      preflight: "ok",
      dateCompanionSchemaVersion: 6,
      memorySchemaVersion: 9,
      expectedDateCompanionSchemaVersion: 6,
      expectedMemorySchemaVersion: 9,
      oldestPendingWarnMs: 60_000,
      failedCountThreshold: 10,
      stats: {
        pending: 0,
        processing: 0,
        retryableFailed: 0,
        needsReview: 3,
        waitingForCleanup: 0,
        activeLeaseCount: 0,
        oldestPendingAgeMs: null,
        processed: 0,
        retried: 0,
        failed: 0,
        lastSuccessAt: null,
        lastErrorCode: "admission_needs_review"
      }
    });
    expect(needsReview.ok).toBe(true);
    expect(needsReview.needsReview).toBe(3);
  });

  it("degrades only for enabled infrastructure/schema/backlog failures", () => {
    const health = evaluateDateCompanionMemoryBridgeHealth({
      enabled: true,
      consumerRunning: false,
      preflight: "invalid",
      dateCompanionSchemaVersion: 5,
      memorySchemaVersion: 9,
      expectedDateCompanionSchemaVersion: 6,
      expectedMemorySchemaVersion: 9,
      oldestPendingWarnMs: 60_000,
      failedCountThreshold: 1,
      stats: {
        pending: 2,
        processing: 0,
        retryableFailed: 2,
        needsReview: 0,
        waitingForCleanup: 0,
        activeLeaseCount: 0,
        oldestPendingAgeMs: 60_001,
        processed: 0,
        retried: 1,
        failed: 2,
        lastSuccessAt: null,
        lastErrorCode: "bridge_retryable"
      }
    });
    expect(health.ok).toBe(false);
    expect(health.reasons).toEqual([
      "memory_bridge_preflight_invalid",
      "memory_bridge_schema_incompatible",
      "memory_bridge_consumer_not_running",
      "memory_bridge_oldest_pending_exceeded",
      "memory_bridge_retryable_failed_exceeded"
    ]);
  });

  it("publishes a non-sensitive runtime heartbeat and rejects stale/invalid reports", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "memory-bridge-health-"));
    temporaryDirectories.push(dataDirectory);
    const report = {
      running: true,
      startedAt: "2026-08-11T00:00:00.000Z",
      heartbeatAt: "2026-08-11T00:00:10.000Z",
      processed: 2,
      retried: 1,
      failed: 0,
      lastSuccessAt: "2026-08-11T00:00:09.000Z",
      lastErrorCode: null
    };
    const reportWithExtra = {
      ...report,
      payload: "must-not-escape"
    };
    await publishDateCompanionMemoryBridgeRuntimeReport({
      dataDirectory,
      report: reportWithExtra
    });
    await publishDateCompanionMemoryBridgeRuntimeReport({
      dataDirectory,
      report: reportWithExtra
    });

    expect(await inspectDateCompanionMemoryBridgeRuntimeReport({
      dataDirectory,
      staleAfterMs: 30_000,
      now: new Date("2026-08-11T00:00:20.000Z")
    })).toEqual({ consumerRunning: true, report });
    expect(await inspectDateCompanionMemoryBridgeRuntimeReport({
      dataDirectory,
      staleAfterMs: 5_000,
      now: new Date("2026-08-11T00:00:20.000Z")
    })).toEqual({ consumerRunning: false, report });

    const reportPath = join(
      dataDirectory,
      "queue-runtime",
      "date-companion-memory-bridge-runtime-v1.json"
    );
    expect(await readFile(reportPath, "utf8")).not.toContain("payload");
    await writeFile(reportPath, JSON.stringify({
      version: 1,
      ...report,
      payload: "must-not-escape"
    }), "utf8");
    expect(await inspectDateCompanionMemoryBridgeRuntimeReport({
      dataDirectory,
      staleAfterMs: 30_000,
      now: new Date("2026-08-11T00:00:20.000Z")
    })).toEqual({ consumerRunning: true, report });
    await writeFile(reportPath, "{partial", "utf8");
    expect(await inspectDateCompanionMemoryBridgeRuntimeReport({
      dataDirectory,
      staleAfterMs: 30_000
    })).toEqual({ consumerRunning: false, report: null });
  });
});
