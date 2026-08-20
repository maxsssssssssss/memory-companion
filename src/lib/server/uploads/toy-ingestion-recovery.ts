import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";

import type Database from "better-sqlite3";

import { DATE_COMPANION_UPLOAD_CONTEXT_VALUE } from "@/lib/domain/date-companion-upload";
import type { ProcessingJob } from "@/lib/domain/types";

import {
  TOY_DATE_COMPANION_DESTINATION,
  type ToyIngestionRequest
} from "./toy-ingestion-receipt";
export type ToyAudioNormalizationContext = "passthrough" | "raw-pcm" | "opus-auto";
export type ToyIngestionExecutionMode = "inline" | "queue";

const RECOVERY_RESERVATION_MS = 30_000;
const SHA256 = /^[a-f0-9]{64}$/u;

export type ToyRecoveryReceiptState =
  | "reserving"
  | "accepted"
  | "processing"
  | "completed"
  | "failed";

export type ToyRecoveryReceipt = {
  receiptId: string;
  accountId: string;
  destination: typeof TOY_DATE_COMPANION_DESTINATION;
  operationKey: string;
  relationshipId: string;
  contentSha256: string;
  recordingDate: string;
  uploadContext: typeof DATE_COMPANION_UPLOAD_CONTEXT_VALUE;
  normalizationContext: ToyAudioNormalizationContext;
  requestFingerprint: string;
  uploadId: string;
  jobId: string;
  executionMode: ToyIngestionExecutionMode;
  queueJobId?: string;
  state: ToyRecoveryReceiptState;
  responseStatus?: number;
  responseJson?: string;
  reservationToken?: string;
  reservationExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
  serverAcceptedAt?: string;
  completedAt?: string;
  failedAt?: string;
};

export type PreparedToyRecovery = {
  accountId: string;
  destination: typeof TOY_DATE_COMPANION_DESTINATION;
  operationKey: string;
  relationshipId: string;
  contentSha256: string;
  recordingDate: string;
  uploadContext: typeof DATE_COMPANION_UPLOAD_CONTEXT_VALUE;
  normalizationContext: ToyAudioNormalizationContext;
  executionMode: ToyIngestionExecutionMode;
  requestFingerprint: string;
};

type ReceiptRow = {
  receipt_id: string;
  account_id: string;
  destination: typeof TOY_DATE_COMPANION_DESTINATION;
  operation_key: string;
  relationship_id: string;
  content_sha256: string;
  recording_date: string;
  upload_context: typeof DATE_COMPANION_UPLOAD_CONTEXT_VALUE;
  normalization_context: ToyAudioNormalizationContext;
  request_fingerprint: string;
  upload_id: string;
  job_id: string;
  execution_mode: ToyIngestionExecutionMode;
  queue_job_id: string | null;
  state: ToyRecoveryReceiptState;
  response_status: number | null;
  response_json: string | null;
  reservation_token: string | null;
  reservation_expires_at: string | null;
  created_at: string;
  updated_at: string;
  accepted_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
};

export type ToyRecoveryClaim =
  | {
      kind: "owner";
      receipt: ToyRecoveryReceipt;
      reservationToken: string;
    }
  | {
      kind: "replay";
      receipt: ToyRecoveryReceipt;
    }
  | {
      kind: "conflict";
      receipt: ToyRecoveryReceipt;
      conflict: "relationship_mismatch" | "payload_mismatch";
    };

function digest(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function rowToReceipt(row: ReceiptRow): ToyRecoveryReceipt {
  return {
    receiptId: row.receipt_id,
    accountId: row.account_id,
    destination: row.destination,
    operationKey: row.operation_key,
    relationshipId: row.relationship_id,
    contentSha256: row.content_sha256,
    recordingDate: row.recording_date,
    uploadContext: row.upload_context,
    normalizationContext: row.normalization_context,
    requestFingerprint: row.request_fingerprint,
    uploadId: row.upload_id,
    jobId: row.job_id,
    executionMode: row.execution_mode,
    ...(row.queue_job_id === null ? {} : { queueJobId: row.queue_job_id }),
    state: row.state,
    ...(row.response_status === null ? {} : { responseStatus: row.response_status }),
    ...(row.response_json === null ? {} : { responseJson: row.response_json }),
    ...(row.reservation_token === null ? {} : { reservationToken: row.reservation_token }),
    ...(row.reservation_expires_at === null ? {} : { reservationExpiresAt: row.reservation_expires_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.accepted_at === null ? {} : { serverAcceptedAt: row.accepted_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.failed_at === null ? {} : { failedAt: row.failed_at })
  };
}

export function prepareToyRecovery(input: {
  accountId: string;
  request: ToyIngestionRequest;
  contentSha256: string;
  recordingDate: string;
  normalizationContext: ToyAudioNormalizationContext;
  executionMode: ToyIngestionExecutionMode;
}): PreparedToyRecovery {
  const prepared = {
    accountId: input.accountId,
    destination: input.request.destination,
    operationKey: input.request.operationKey,
    relationshipId: input.request.relationshipId,
    contentSha256: input.contentSha256,
    recordingDate: input.recordingDate,
    uploadContext: DATE_COMPANION_UPLOAD_CONTEXT_VALUE as typeof DATE_COMPANION_UPLOAD_CONTEXT_VALUE,
    normalizationContext: input.normalizationContext,
    executionMode: input.executionMode
  };
  return {
    ...prepared,
    requestFingerprint: digest(JSON.stringify({
      contentSha256: prepared.contentSha256,
      destination: prepared.destination,
      normalizationContext: prepared.normalizationContext,
      recordingDate: prepared.recordingDate,
      relationshipId: prepared.relationshipId,
      uploadContext: prepared.uploadContext
    }))
  };
}

export class ToyRecoveryReceiptRepository {
  constructor(private readonly database: Database.Database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS toy_ingestion_recovery_receipts (
        receipt_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        destination TEXT NOT NULL CHECK (destination = 'date_companion'),
        operation_key TEXT NOT NULL,
        relationship_id TEXT NOT NULL,
        content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
        recording_date TEXT NOT NULL,
        upload_context TEXT NOT NULL CHECK (upload_context = 'date-companion'),
        normalization_context TEXT NOT NULL CHECK (normalization_context IN (
          'passthrough', 'raw-pcm', 'opus-auto'
        )),
        request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
        upload_id TEXT NOT NULL UNIQUE,
        job_id TEXT NOT NULL UNIQUE,
        execution_mode TEXT NOT NULL CHECK (execution_mode IN ('inline', 'queue')),
        queue_job_id TEXT,
        state TEXT NOT NULL CHECK (state IN (
          'reserving', 'accepted', 'processing', 'completed', 'failed'
        )),
        response_status INTEGER,
        response_json TEXT,
        reservation_token TEXT,
        reservation_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        accepted_at TEXT,
        completed_at TEXT,
        failed_at TEXT,
        UNIQUE (account_id, destination, operation_key)
      );
      CREATE INDEX IF NOT EXISTS idx_toy_recovery_account_upload
        ON toy_ingestion_recovery_receipts (account_id, upload_id);
    `);
  }

  getByOperation(input: {
    accountId: string;
    destination: typeof TOY_DATE_COMPANION_DESTINATION;
    operationKey: string;
  }) {
    const row = this.database.prepare(`
      SELECT * FROM toy_ingestion_recovery_receipts
      WHERE account_id = ? AND destination = ? AND operation_key = ?
    `).get(
      input.accountId,
      input.destination,
      input.operationKey
    ) as ReceiptRow | undefined;
    return row ? rowToReceipt(row) : null;
  }

  getByUpload(accountId: string, uploadId: string) {
    const row = this.database.prepare(`
      SELECT * FROM toy_ingestion_recovery_receipts
      WHERE account_id = ? AND upload_id = ?
    `).get(accountId, uploadId) as ReceiptRow | undefined;
    return row ? rowToReceipt(row) : null;
  }

  claim(input: PreparedToyRecovery & {
    now?: () => string;
    leaseMs?: number;
    receiptId?: string;
    uploadId?: string;
    jobId?: string;
    reservationToken?: string;
  }): ToyRecoveryClaim {
    if (!SHA256.test(input.contentSha256) || !SHA256.test(input.requestFingerprint)) {
      throw new Error("invalid_toy_recovery_digest");
    }
    const now = input.now?.() ?? new Date().toISOString();
    const leaseMs = input.leaseMs ?? RECOVERY_RESERVATION_MS;
    const reservationToken = input.reservationToken ?? randomUUID();
    const reservationExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();

    return this.database.transaction((): ToyRecoveryClaim => {
      const existing = this.getByOperation(input);
      if (existing) {
        if (existing.relationshipId !== input.relationshipId) {
          return { kind: "conflict", receipt: existing, conflict: "relationship_mismatch" };
        }
        if (existing.requestFingerprint !== input.requestFingerprint) {
          return { kind: "conflict", receipt: existing, conflict: "payload_mismatch" };
        }
        if (existing.state === "failed" && !existing.serverAcceptedAt) {
          this.database.prepare(`
            UPDATE toy_ingestion_recovery_receipts
            SET state = 'reserving', reservation_token = ?, reservation_expires_at = ?,
                updated_at = ?, failed_at = NULL
            WHERE receipt_id = ?
          `).run(reservationToken, reservationExpiresAt, now, existing.receiptId);
          return {
            kind: "owner",
            receipt: this.getByOperation(input)!,
            reservationToken
          };
        }
        return { kind: "replay", receipt: existing };
      }

      const receiptId = input.receiptId ?? randomUUID();
      const uploadId = input.uploadId ?? randomUUID();
      const jobId = input.jobId ?? randomUUID();
      this.database.prepare(`
        INSERT INTO toy_ingestion_recovery_receipts (
          receipt_id, account_id, destination, operation_key, relationship_id,
          content_sha256, recording_date, upload_context, normalization_context,
          request_fingerprint, upload_id, job_id, execution_mode, state,
          reservation_token, reservation_expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserving', ?, ?, ?, ?)
      `).run(
        receiptId,
        input.accountId,
        input.destination,
        input.operationKey,
        input.relationshipId,
        input.contentSha256,
        input.recordingDate,
        input.uploadContext,
        input.normalizationContext,
        input.requestFingerprint,
        uploadId,
        jobId,
        input.executionMode,
        reservationToken,
        reservationExpiresAt,
        now,
        now
      );
      return {
        kind: "owner",
        receipt: this.getByOperation(input)!,
        reservationToken
      };
    }).immediate();
  }

  markAccepted(input: {
    accountId: string;
    receiptId: string;
    reservationToken: string;
    responseStatus: number;
    response: Record<string, unknown>;
    queueJobId?: string;
    now?: () => string;
  }) {
    const now = input.now?.() ?? new Date().toISOString();
    const result = this.database.prepare(`
      UPDATE toy_ingestion_recovery_receipts
      SET state = 'accepted', response_status = ?, response_json = ?, queue_job_id = ?,
          reservation_token = NULL, reservation_expires_at = NULL,
          accepted_at = ?, updated_at = ?
      WHERE account_id = ? AND receipt_id = ? AND state = 'reserving'
        AND reservation_token = ?
    `).run(
      input.responseStatus,
      JSON.stringify(input.response),
      input.queueJobId ?? null,
      now,
      now,
      input.accountId,
      input.receiptId,
      input.reservationToken
    );
    if (result.changes !== 1) throw new Error("toy_recovery_reservation_lost");
    return this.getByOperationByReceipt(input.accountId, input.receiptId)!;
  }

  markFailed(input: {
    accountId: string;
    receiptId: string;
    reservationToken: string;
    now?: () => string;
  }) {
    const now = input.now?.() ?? new Date().toISOString();
    this.database.prepare(`
      UPDATE toy_ingestion_recovery_receipts
      SET state = 'failed', reservation_token = NULL, reservation_expires_at = NULL,
          failed_at = ?, updated_at = ?
      WHERE account_id = ? AND receipt_id = ? AND state = 'reserving'
        AND reservation_token = ?
    `).run(
      now,
      now,
      input.accountId,
      input.receiptId,
      input.reservationToken
    );
    return this.getByOperationByReceipt(input.accountId, input.receiptId);
  }

  reconcileJob(accountId: string, receiptId: string, job: ProcessingJob | null) {
    const receipt = this.getByOperationByReceipt(accountId, receiptId);
    if (!receipt || !receipt.serverAcceptedAt || !job) return receipt;
    const state: ToyRecoveryReceiptState = job.status === "ready"
      ? "completed"
      : job.status === "failed"
        ? "failed"
        : job.status === "waiting"
          ? "accepted"
          : "processing";
    if (receipt.state === state) return receipt;
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE toy_ingestion_recovery_receipts
      SET state = ?, updated_at = ?,
          completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
          failed_at = CASE WHEN ? = 'failed' THEN ? ELSE failed_at END
      WHERE account_id = ? AND receipt_id = ? AND accepted_at IS NOT NULL
    `).run(state, now, state, now, state, now, accountId, receiptId);
    return this.getByOperationByReceipt(accountId, receiptId);
  }

  private getByOperationByReceipt(accountId: string, receiptId: string) {
    const row = this.database.prepare(`
      SELECT * FROM toy_ingestion_recovery_receipts
      WHERE account_id = ? AND receipt_id = ?
    `).get(accountId, receiptId) as ReceiptRow | undefined;
    return row ? rowToReceipt(row) : null;
  }
}

export async function stageToyRecoveryFile(input: {
  accountDataRoot: string;
  file: File;
}) {
  const stagingDir = join(input.accountDataRoot, "toy-ingestion-staging");
  await fs.mkdir(stagingDir, { recursive: true });
  const stagingPath = join(stagingDir, `${randomUUID()}.part`);
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  try {
    await fs.writeFile(stagingPath, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    await fs.rm(stagingPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
    cleanup: () => fs.rm(stagingPath, { force: true })
  };
}

export function publicToyRecoveryReceipt(input: {
  receipt: ToyRecoveryReceipt;
  decision: "accepted" | "replayed";
}) {
  return {
    receiptId: input.receipt.receiptId,
    operationKey: input.receipt.operationKey,
    destination: input.receipt.destination,
    relationshipId: input.receipt.relationshipId,
    uploadId: input.receipt.uploadId,
    jobId: input.receipt.jobId,
    state: input.receipt.state,
    decision: input.decision,
    recordingDate: input.receipt.recordingDate,
    ...(input.receipt.serverAcceptedAt ? { serverAcceptedAt: input.receipt.serverAcceptedAt } : {}),
    ...(input.receipt.completedAt ? { completedAt: input.receipt.completedAt } : {}),
    ...(input.receipt.failedAt ? { failedAt: input.receipt.failedAt } : {})
  };
}

export function toyRecoveryResponse(input: {
  receipt: ToyRecoveryReceipt;
  decision: "accepted" | "replayed";
}) {
  const stored = input.receipt.responseJson
    ? JSON.parse(input.receipt.responseJson) as Record<string, unknown>
    : {
        uploadId: input.receipt.uploadId,
        jobId: input.receipt.jobId,
        status: "waiting"
      };
  return {
    ...stored,
    uploadId: input.receipt.uploadId,
    jobId: input.receipt.jobId,
    ingestionReceipt: publicToyRecoveryReceipt(input)
  };
}
