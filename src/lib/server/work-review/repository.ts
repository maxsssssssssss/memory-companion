import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { WorkMeetingCandidateStructuredDataSchema } from "@/lib/domain/work-review";
import {
  WorkProjectIdsSchema,
  type WorkProjectScopeFilter
} from "@/lib/domain/work-project";
import type {
  WorkMeetingCandidateStructuredData,
  WorkAtomicClaimType,
  WorkClaimPublicationAction,
  WorkClaimRiskLevel,
  WorkClaimSupportVerdict,
  WorkEvidenceTimestampQuality,
  WorkMeetingAnalysisStatus,
  WorkMeetingCandidateKind,
  WorkMeetingCandidateStatus,
  WorkMeetingIngestionStatus,
  WorkMeetingReviewStatus
} from "@/lib/domain/work-review";
import type { TranscriptSegment } from "@/lib/domain/types";

import {
  deleteLinkedMeetingTodosWithinTransaction,
  detachLinkedMeetingTodosWithinTransaction,
  listActiveMeetingTodoIdsWithinTransaction
} from "./todo-meeting-deletion";
import { invalidateWorkWeeklySourcesWithinTransaction } from "./weekly-invalidation";
import {
  validateWorkMeetingAnalysisAudit, WorkMeetingAnalysisAuditSchema,
  WORK_MEETING_ANALYSIS_AUDIT_VERSION
} from "./analysis-audit";

export type WorkIngestionStatus = WorkMeetingIngestionStatus;
export type WorkAnalysisStatus = WorkMeetingAnalysisStatus;
export type WorkReviewStatus = WorkMeetingReviewStatus;
export type WorkProcessingStage = "transcription" | "meeting_analysis";
export type WorkCandidateKind = WorkMeetingCandidateKind;
export type WorkCandidateStatus = WorkMeetingCandidateStatus;
export type WorkClaimType = WorkAtomicClaimType;
export type WorkSupportVerdict = WorkClaimSupportVerdict;
export type WorkPublicationAction = WorkClaimPublicationAction;
export type WorkRiskLevel = WorkClaimRiskLevel;
export type WorkTimestampQuality = WorkEvidenceTimestampQuality;
export type WorkTranscriptSegment = TranscriptSegment;

export type WorkMeetingRecord = {
  id: string;
  accountId: string;
  productSpace: "office_review";
  title: string;
  meetingDate: string;
  sourceUploadId: string;
  sourceDurationSeconds: number | null;
  ingestionStatus: WorkIngestionStatus;
  analysisStatus: WorkAnalysisStatus;
  reviewStatus: WorkReviewStatus;
  canonicalPublicationId: string | null;
  canonicalContentDigest: string | null;
  canonicalSegmentCount: number;
  currentTranscriptionAttempt: number;
  currentAnalysisAttempt: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  transcriptReadyAt: string | null;
  reviewReadyAt: string | null;
  reviewCompletedAt: string | null;
  failedAt: string | null;
  deletedAt: string | null;
  errorStage: WorkProcessingStage | null;
  errorCode: string | null;
};

export type WorkInputReceiptRecord = {
  receiptId: string;
  accountId: string;
  meetingId: string;
  operationKey: string;
  idempotencyKey: string;
  contentHash: string;
  requestFingerprint: string;
  state: "reserved" | "accepted" | "processing" | "completed" | "failed" | "deleted";
  createdAt: string;
  completedAt: string | null;
  errorCode: string | null;
};

export type WorkProcessingFence = {
  stage: WorkProcessingStage;
  attemptVersion: number;
  leaseOwner: string;
  leaseExpiresAt: string;
  deadlineAt: string | null;
};

export type WorkAnalysisCheckpointKind = "extractor_block" | "organization_plan" | "verifier_batch";

export type WorkAnalysisCheckpointRecord = {
  accountId: string;
  meetingId: string;
  publicationId: string;
  canonicalContentDigest: string;
  checkpointKind: WorkAnalysisCheckpointKind;
  logicalInputDigest: string;
  providerContractDigest: string;
  outputSchemaVersion: string;
  payload: unknown;
  payloadDigest: string;
  originAttemptVersion: number;
  createdAt: string;
};

export type WorkAnalysisCheckpointInput = {
  accountId: string;
  meetingId: string;
  fence: WorkProcessingFence;
  publicationId: string;
  canonicalContentDigest: string;
  checkpointKind: WorkAnalysisCheckpointKind;
  logicalInputDigest: string;
  providerContractDigest: string;
  outputSchemaVersion: string;
  now?: string;
};

export type WorkCanonicalPublicationRecord = {
  publicationId: string;
  accountId: string;
  meetingId: string;
  sourceUploadId: string;
  attemptVersion: number;
  contentDigest: string;
  segmentCount: number;
  segments: WorkTranscriptSegment[];
  createdAt: string;
  assetKind: "segments";
  tombstonedAt: null;
};

export type WorkEvidenceReferenceRecord = {
  publicationId: string;
  segmentId: string;
  startSeconds: number;
  endSeconds: number;
  rawSpeakerLabel: string | null;
  timestampQuality: WorkTimestampQuality;
};

export type WorkCandidateRecord = {
  id: string;
  accountId: string;
  meetingId: string;
  publicationId: string;
  ordinal: number;
  kind: WorkCandidateKind;
  title: string;
  body: string;
  structuredData: unknown;
  status: WorkCandidateStatus;
  publicationAction: WorkPublicationAction;
  riskLevel: WorkRiskLevel;
  generatorProfile: string;
  generatorPromptVersion: string;
  analysisAttemptVersion: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  evidenceRefs: WorkEvidenceReferenceRecord[];
};

export type WorkFindingRecord = {
  id: string;
  accountId: string;
  meetingId: string;
  sourceCandidateId: string;
  kind: WorkCandidateKind;
  title: string;
  body: string;
  structuredData: unknown;
  userConfirmedAt: string;
  userEditedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  evidenceRefs: WorkEvidenceReferenceRecord[];
};

export type WorkAtomicClaimRecord = {
  id: string;
  candidateId: string;
  claimType: WorkClaimType;
  text: string;
  evidenceIds: string[];
  createdAt: string;
};

export type WorkClaimEvaluationRecord = {
  id: string;
  accountId: string;
  meetingId: string;
  claimId: string;
  supportVerdict: WorkSupportVerdict;
  issueCodes: string[];
  riskLevel: WorkRiskLevel;
  publicationAction: WorkPublicationAction;
  confirmationRequired: boolean;
  supportedEvidenceIds: string[];
  generatorProfile: string;
  verifierProfile: string;
  verifierPromptVersion: string;
  policyVersion: string;
  verifiedAt: string;
};

export type WorkSourceUploadRecord = {
  accountId: string;
  meetingId: string;
  uploadId: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  recordingDate: string;
  filePath: string | null;
  contentHash: string;
  createdAt: string;
  cleanedAt: string | null;
};

export type WorkMeetingDetail = {
  meeting: WorkMeetingRecord;
  activeProcessingLease: {
    stage: WorkProcessingStage;
    leaseExpiresAt: string;
  } | null;
  transcript: WorkCanonicalPublicationRecord | null;
  candidates: WorkCandidateRecord[];
  claims: WorkAtomicClaimRecord[];
  evaluations: WorkClaimEvaluationRecord[];
  findings: WorkFindingRecord[];
  speakerAliases: Array<{
    rawLabel: string;
    displayLabel: string;
    version: number;
    createdAt: string;
    updatedAt: string;
  }>;
};

type RepositoryOptions = { now?: () => string; idFactory?: () => string };

export class WorkReviewNotFoundError extends Error {
  readonly code = "work_review_not_found";
  constructor() { super("Work Review resource not found"); }
}

export class WorkReviewConflictError extends Error {
  constructor(readonly code: string) { super(code); }
}

export class WorkReviewVersionConflictError extends Error {
  readonly code = "version_conflict";
  constructor(readonly currentVersion: number) {
    super("Work Review resource version is stale");
  }
}

export class WorkReviewLeaseLostError extends Error {
  readonly code = "work_review_lease_lost";
  constructor() { super("Work Review processing lease is no longer owned by this attempt"); }
}

export class WorkReviewAnalysisDeadlineExceededError extends Error {
  readonly code = "work_analysis_deadline_exceeded";
  constructor() { super("Work Review analysis deadline was exceeded"); }
}

export class WorkReviewFeatureDisabledError extends Error {
  constructor(readonly code: "upload_disabled" | "analysis_disabled") {
    super(code);
  }
}

export type WorkMeetingLinkedTodoPolicy =
  | "delete_linked_todos"
  | "detach_linked_todos";

export class WorkReviewLinkedTodosPolicyRequiredError extends Error {
  readonly code = "linked_todos_require_policy";

  constructor(readonly linkedTodoIds: string[]) {
    super("Linked Work Todos require an explicit meeting deletion policy");
  }

  get linkedTodoCount() {
    return this.linkedTodoIds.length;
  }
}

type MeetingRow = {
  id: string; account_id: string; product_space: "office_review"; title: string;
  meeting_date: string; source_upload_id: string; source_duration_seconds: number | null;
  ingestion_status: WorkIngestionStatus; analysis_status: WorkAnalysisStatus;
  review_status: WorkReviewStatus; canonical_publication_id: string | null;
  canonical_content_digest: string | null; canonical_segment_count: number;
  current_transcription_attempt: number; current_analysis_attempt: number; version: number;
  created_at: string; updated_at: string; transcript_ready_at: string | null;
  review_ready_at: string | null; review_completed_at: string | null;
  failed_at: string | null; deleted_at: string | null;
  error_stage: WorkProcessingStage | null; error_code: string | null;
};

type ReceiptRow = {
  receipt_id: string; account_id: string; meeting_id: string; operation_key: string;
  idempotency_key: string; content_hash: string; request_fingerprint: string;
  state: WorkInputReceiptRecord["state"]; created_at: string;
  completed_at: string | null; error_code: string | null;
};

type PublicationRow = {
  publication_id: string; account_id: string; meeting_id: string;
  source_upload_id: string; attempt_version: number; content_digest: string;
  segment_count: number; payload_json: string; created_at: string;
};

type AnalysisCheckpointRow = {
  account_id: string;
  meeting_id: string;
  publication_id: string;
  canonical_content_digest: string;
  checkpoint_kind: WorkAnalysisCheckpointKind;
  logical_input_digest: string;
  provider_contract_digest: string;
  output_schema_version: string;
  payload_json: string;
  payload_digest: string;
  origin_attempt_version: number;
  created_at: string;
};

type CandidateRow = {
  id: string; account_id: string; meeting_id: string; publication_id: string;
  ordinal: number; kind: WorkCandidateKind; title: string; body: string;
  structured_data_json: string; status: WorkCandidateStatus;
  publication_action: WorkPublicationAction; risk_level: WorkRiskLevel;
  generator_profile: string; generator_prompt_version: string;
  analysis_attempt_version: number; version: number; created_at: string; updated_at: string;
};

type FindingRow = {
  id: string; account_id: string; meeting_id: string; source_candidate_id: string;
  kind: WorkCandidateKind; title: string; body: string; structured_data_json: string;
  user_confirmed_at: string; user_edited_at: string | null; version: number;
  created_at: string; updated_at: string;
};

function meetingFromRow(row: MeetingRow): WorkMeetingRecord {
  return {
    id: row.id, accountId: row.account_id, productSpace: row.product_space,
    title: row.title, meetingDate: row.meeting_date, sourceUploadId: row.source_upload_id,
    sourceDurationSeconds: row.source_duration_seconds, ingestionStatus: row.ingestion_status,
    analysisStatus: row.analysis_status, reviewStatus: row.review_status,
    canonicalPublicationId: row.canonical_publication_id,
    canonicalContentDigest: row.canonical_content_digest,
    canonicalSegmentCount: row.canonical_segment_count,
    currentTranscriptionAttempt: row.current_transcription_attempt,
    currentAnalysisAttempt: row.current_analysis_attempt, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at,
    transcriptReadyAt: row.transcript_ready_at, reviewReadyAt: row.review_ready_at,
    reviewCompletedAt: row.review_completed_at, failedAt: row.failed_at,
    deletedAt: row.deleted_at, errorStage: row.error_stage, errorCode: row.error_code
  };
}

function receiptFromRow(row: ReceiptRow): WorkInputReceiptRecord {
  return {
    receiptId: row.receipt_id, accountId: row.account_id, meetingId: row.meeting_id,
    operationKey: row.operation_key, idempotencyKey: row.idempotency_key,
    contentHash: row.content_hash, requestFingerprint: row.request_fingerprint,
    state: row.state, createdAt: row.created_at, completedAt: row.completed_at,
    errorCode: row.error_code
  };
}

function candidateFromRow(
  row: CandidateRow, evidenceRefs: WorkEvidenceReferenceRecord[] = []
): WorkCandidateRecord {
  return {
    id: row.id, accountId: row.account_id, meetingId: row.meeting_id,
    publicationId: row.publication_id, ordinal: row.ordinal, kind: row.kind,
    title: row.title, body: row.body, structuredData: JSON.parse(row.structured_data_json),
    status: row.status, publicationAction: row.publication_action,
    riskLevel: row.risk_level, generatorProfile: row.generator_profile,
    generatorPromptVersion: row.generator_prompt_version,
    analysisAttemptVersion: row.analysis_attempt_version, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at, evidenceRefs
  };
}

function findingFromRow(
  row: FindingRow, evidenceRefs: WorkEvidenceReferenceRecord[] = []
): WorkFindingRecord {
  return {
    id: row.id, accountId: row.account_id, meetingId: row.meeting_id,
    sourceCandidateId: row.source_candidate_id, kind: row.kind, title: row.title,
    body: row.body, structuredData: JSON.parse(row.structured_data_json),
    userConfirmedAt: row.user_confirmed_at, userEditedAt: row.user_edited_at,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
    evidenceRefs
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function digest(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function canonicalJson(value: unknown) {
  try {
    const serialized = stableStringify(value);
    if (typeof serialized !== "string") throw new Error("not_json");
    JSON.parse(serialized);
    return serialized;
  } catch {
    throw new WorkReviewConflictError("work_review_analysis_checkpoint_payload_invalid");
  }
}

function serializedDigest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeIsoTimestamp(value: string, code: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new WorkReviewConflictError(code);
  return new Date(timestamp).toISOString();
}

function requireText(value: string, code: string) {
  const normalized = value.trim();
  if (!normalized) throw new WorkReviewConflictError(code);
  return normalized;
}

function requireDigest(value: string, code: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new WorkReviewConflictError(code);
  return normalized;
}

function requireCheckpointKind(value: WorkAnalysisCheckpointKind) {
  if (value !== "extractor_block" && value !== "verifier_batch" && value !== "organization_plan") {
    throw new WorkReviewConflictError("work_review_analysis_checkpoint_kind_invalid");
  }
  return value;
}

function checkpointFromRow(row: AnalysisCheckpointRow): WorkAnalysisCheckpointRecord {
  if (serializedDigest(row.payload_json) !== row.payload_digest) {
    throw new WorkReviewConflictError("work_review_analysis_checkpoint_invalid");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_json) as unknown;
  } catch {
    throw new WorkReviewConflictError("work_review_analysis_checkpoint_invalid");
  }
  return {
    accountId: row.account_id,
    meetingId: row.meeting_id,
    publicationId: row.publication_id,
    canonicalContentDigest: row.canonical_content_digest,
    checkpointKind: row.checkpoint_kind,
    logicalInputDigest: row.logical_input_digest,
    providerContractDigest: row.provider_contract_digest,
    outputSchemaVersion: row.output_schema_version,
    payload,
    payloadDigest: row.payload_digest,
    originAttemptVersion: row.origin_attempt_version,
    createdAt: row.created_at
  };
}

function canonicalizeSegments(raw: WorkTranscriptSegment[], sourceUploadId: string) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new WorkReviewConflictError("work_review_empty_transcript");
  }
  const ids = new Set<string>();
  const segments = raw.map((item) => {
    if (!item || typeof item !== "object") {
      throw new WorkReviewConflictError("work_review_invalid_segment");
    }
    const id = requireText(item.id, "work_review_invalid_segment_id");
    if (ids.has(id)) throw new WorkReviewConflictError("work_review_duplicate_segment_id");
    ids.add(id);
    if (item.uploadId !== sourceUploadId) {
      throw new WorkReviewConflictError("work_review_segment_upload_mismatch");
    }
    if (!Number.isFinite(item.startSeconds) || item.startSeconds < 0
      || !Number.isFinite(item.endSeconds) || item.endSeconds <= item.startSeconds) {
      throw new WorkReviewConflictError("work_review_invalid_segment_time");
    }
    const text = requireText(item.text, "work_review_empty_segment_text");
    const { identity: _identity, ...withoutIdentity } = item;
    return { ...withoutIdentity, id, uploadId: sourceUploadId, text } as WorkTranscriptSegment;
  }).sort((left, right) =>
    left.startSeconds - right.startSeconds
    || left.endSeconds - right.endSeconds
    || left.id.localeCompare(right.id));
  return segments;
}

export class WorkReviewRepository {
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(private readonly database: Database.Database, options: RepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  private nextId(prefix: string) { return `${prefix}_${this.idFactory()}`; }

  private meetingRow(accountId: string, meetingId: string) {
    return this.database.prepare(`SELECT * FROM wr_meetings WHERE id = ? AND account_id = ?`)
      .get(meetingId, accountId) as MeetingRow | undefined;
  }

  private requireMeetingRow(accountId: string, meetingId: string) {
    const row = this.meetingRow(accountId, meetingId);
    if (!row) throw new WorkReviewNotFoundError();
    return row;
  }

  private assertLiveMeeting(accountId: string, meetingId: string) {
    const row = this.requireMeetingRow(accountId, meetingId);
    const tombstone = this.database.prepare(`
      SELECT 1 FROM wr_tombstones WHERE account_id = ? AND meeting_id = ?
    `).get(accountId, meetingId);
    if (row.deleted_at || row.ingestion_status === "deleted" || tombstone) {
      throw new WorkReviewConflictError("work_review_tombstoned");
    }
    return row;
  }

  getMeeting(accountId: string, meetingId: string) {
    return meetingFromRow(this.requireMeetingRow(
      requireText(accountId, "work_review_invalid_account"),
      requireText(meetingId, "work_review_invalid_meeting_id")
    ));
  }

  listMeetings(accountId: string, projectScope: WorkProjectScopeFilter = { kind: "all" }) {
    const parsedAccount = requireText(accountId, "work_review_invalid_account");
    const scope = projectScope;
    let scopeSql = "";
    const parameters: unknown[] = [parsedAccount];
    if (scope.kind === "project") {
      scopeSql = `AND EXISTS (
        SELECT 1 FROM wr_meeting_projects mp
        WHERE mp.account_id = wr_meetings.account_id
          AND mp.meeting_id = wr_meetings.id AND mp.project_id = ?
      )`;
      parameters.push(scope.projectId);
    } else if (scope.kind === "unassigned") {
      scopeSql = `AND NOT EXISTS (
        SELECT 1 FROM wr_meeting_projects mp
        WHERE mp.account_id = wr_meetings.account_id
          AND mp.meeting_id = wr_meetings.id
      )`;
    }
    return (this.database.prepare(`
      SELECT * FROM wr_meetings
      WHERE account_id = ? AND ingestion_status <> 'deleted'
      ${scopeSql}
      ORDER BY meeting_date DESC, created_at DESC, id
    `).all(...parameters) as MeetingRow[]).map(meetingFromRow);
  }

  reserveMeeting(input: {
    accountId: string; idempotencyKey: string; operationKey?: string;
    contentHash: string; meetingId?: string; receiptId?: string;
    sourceUploadId: string; title?: string | null; meetingDate: string;
    sourceDurationSeconds?: number | null;
    projectIds?: string[];
  }) {
    const accountId = requireText(input.accountId, "work_review_invalid_account");
    const idempotencyKey = requireText(input.idempotencyKey, "work_review_idempotency_key_required");
    const operationKey = requireText(input.operationKey ?? idempotencyKey, "work_review_operation_key_required");
    const contentHash = requireDigest(input.contentHash, "work_review_invalid_content_hash");
    const sourceUploadId = requireText(input.sourceUploadId, "work_review_invalid_upload_id");
    const meetingDate = requireText(input.meetingDate, "work_review_invalid_meeting_date");
    const title = input.title === undefined || input.title === null || !input.title.trim()
      ? `工作会议 · ${meetingDate}` : input.title.trim();
    const parsedProjectIds = WorkProjectIdsSchema.safeParse(input.projectIds ?? []);
    if (!parsedProjectIds.success) {
      throw new WorkReviewConflictError("work_project_invalid_links");
    }
    const projectIds = [...parsedProjectIds.data].sort();
    if (input.sourceDurationSeconds !== undefined && input.sourceDurationSeconds !== null
      && (!Number.isFinite(input.sourceDurationSeconds) || input.sourceDurationSeconds <= 0)) {
      throw new WorkReviewConflictError("work_review_invalid_duration");
    }
    const requestFingerprint = digest(projectIds.length > 0
      ? { contentHash, projectIds }
      : { contentHash });
    const run = this.database.transaction(() => {
      const existing = this.database.prepare(`
        SELECT * FROM wr_input_receipts
        WHERE account_id = ? AND idempotency_key = ?
      `).get(accountId, idempotencyKey) as ReceiptRow | undefined;
      if (existing) {
        if (existing.content_hash !== contentHash
          || existing.request_fingerprint !== requestFingerprint) {
          throw new WorkReviewConflictError("work_review_idempotency_conflict");
        }
        return {
          meeting: meetingFromRow(this.requireMeetingRow(accountId, existing.meeting_id)),
          receipt: receiptFromRow(existing), reused: true
        };
      }
      const operationCollision = this.database.prepare(`
        SELECT content_hash FROM wr_input_receipts
        WHERE account_id = ? AND operation_key = ?
      `).get(accountId, operationKey) as { content_hash: string } | undefined;
      if (operationCollision) {
        throw new WorkReviewConflictError("work_review_idempotency_conflict");
      }
      const now = this.now();
      const meetingId = input.meetingId ?? this.nextId("wrm");
      const receiptId = input.receiptId ?? this.nextId("wrr");
      if (projectIds.length > 0) {
        const found = this.database.prepare(`
          SELECT count(*) AS count FROM wr_projects
          WHERE account_id = ? AND deleted_at IS NULL AND id IN (${projectIds.map(() => "?").join(",")})
        `).get(accountId, ...projectIds) as { count: number };
        if (found.count !== projectIds.length) {
          throw new WorkReviewConflictError("work_project_not_found");
        }
      }
      this.database.prepare(`
        INSERT INTO wr_meetings (
          id, account_id, product_space, title, meeting_date, source_upload_id,
          source_duration_seconds, ingestion_status, analysis_status, review_status,
          created_at, updated_at
        ) VALUES (?, ?, 'office_review', ?, ?, ?, ?, 'created', 'not_started',
                  'not_started', ?, ?)
      `).run(meetingId, accountId, title, meetingDate, sourceUploadId,
        input.sourceDurationSeconds ?? null, now, now);
      for (const projectId of projectIds) {
        this.database.prepare(`
          INSERT INTO wr_meeting_projects(account_id, meeting_id, project_id, created_at)
          VALUES (?, ?, ?, ?)
        `).run(accountId, meetingId, projectId, now);
      }
      this.database.prepare(`
        INSERT INTO wr_input_receipts (
          receipt_id, account_id, meeting_id, operation_key, idempotency_key,
          content_hash, request_fingerprint, state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?)
      `).run(receiptId, accountId, meetingId, operationKey, idempotencyKey,
        contentHash, requestFingerprint, now);
      return {
        meeting: meetingFromRow(this.requireMeetingRow(accountId, meetingId)),
        receipt: receiptFromRow(this.database.prepare(`
          SELECT * FROM wr_input_receipts WHERE receipt_id = ? AND account_id = ?
        `).get(receiptId, accountId) as ReceiptRow), reused: false
      };
    });
    return run.immediate();
  }

  getReceipt(accountId: string, idempotencyKey: string) {
    const row = this.database.prepare(`
      SELECT * FROM wr_input_receipts WHERE account_id = ? AND idempotency_key = ?
    `).get(accountId, idempotencyKey) as ReceiptRow | undefined;
    return row ? receiptFromRow(row) : null;
  }

  publishSourceUpload(input: {
    accountId: string;
    meetingId: string;
    uploadId: string;
    originalName: string;
    mimeType: string;
    sizeBytes: number;
    recordingDate: string;
    filePath: string;
    contentHash: string;
  }) {
    const contentHash = requireDigest(input.contentHash, "work_review_invalid_content_hash");
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0) {
      throw new WorkReviewConflictError("work_review_invalid_upload_size");
    }
    const run = this.database.transaction(() => {
      const meeting = this.assertLiveMeeting(input.accountId, input.meetingId);
      if (meeting.source_upload_id !== input.uploadId) {
        throw new WorkReviewConflictError("work_review_source_upload_mismatch");
      }
      const receipt = this.database.prepare(`
        SELECT content_hash FROM wr_input_receipts
        WHERE account_id = ? AND meeting_id = ?
      `).get(input.accountId, input.meetingId) as { content_hash: string } | undefined;
      if (!receipt || receipt.content_hash !== contentHash) {
        throw new WorkReviewConflictError("work_review_source_upload_hash_mismatch");
      }
      const existing = this.readSourceUpload(input.accountId, input.meetingId);
      if (existing) {
        // Input idempotency is defined by account + key + file hash. Concurrent
        // HTTP attempts may carry different filenames/dates and always use a
        // distinct attempt path; the first durable source publication wins.
        const same = existing.uploadId === input.uploadId
          && existing.contentHash === contentHash;
        if (!same) throw new WorkReviewConflictError("work_review_source_upload_conflict");
        return { upload: existing, reused: true };
      }
      const now = this.now();
      this.database.prepare(`
        INSERT INTO wr_source_uploads (
          account_id, meeting_id, upload_id, original_name, mime_type, size_bytes,
          recording_date, file_path, content_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(input.accountId, input.meetingId, input.uploadId,
        requireText(input.originalName, "work_review_original_name_required"),
        requireText(input.mimeType, "work_review_mime_type_required"), input.sizeBytes,
        requireText(input.recordingDate, "work_review_recording_date_required"),
        requireText(input.filePath, "work_review_file_path_required"), contentHash, now);
      this.database.prepare(`
        UPDATE wr_input_receipts SET state = 'accepted', error_code = NULL
        WHERE account_id = ? AND meeting_id = ? AND state = 'reserved'
      `).run(input.accountId, input.meetingId);
      return { upload: this.readSourceUpload(input.accountId, input.meetingId)!, reused: false };
    });
    return run.immediate();
  }

  readSourceUpload(accountId: string, meetingId: string): WorkSourceUploadRecord | null {
    this.requireMeetingRow(accountId, meetingId);
    const row = this.database.prepare(`
      SELECT account_id, meeting_id, upload_id, original_name, mime_type,
             size_bytes, recording_date, file_path, content_hash, created_at, cleaned_at
      FROM wr_source_uploads WHERE account_id = ? AND meeting_id = ?
    `).get(accountId, meetingId) as {
      account_id: string; meeting_id: string; upload_id: string; original_name: string;
      mime_type: string; size_bytes: number; recording_date: string;
      file_path: string | null; content_hash: string; created_at: string;
      cleaned_at: string | null;
    } | undefined;
    return row ? {
      accountId: row.account_id, meetingId: row.meeting_id, uploadId: row.upload_id,
      originalName: row.original_name, mimeType: row.mime_type, sizeBytes: row.size_bytes,
      recordingDate: row.recording_date, filePath: row.file_path,
      contentHash: row.content_hash, createdAt: row.created_at, cleanedAt: row.cleaned_at
    } : null;
  }

  readTranscribingSourceUploadByUploadId(
    accountId: string,
    uploadId: string
  ): WorkSourceUploadRecord | null {
    const row = this.database.prepare(`
      SELECT source.account_id, source.meeting_id, source.upload_id,
             source.original_name, source.mime_type, source.size_bytes,
             source.recording_date, source.file_path, source.content_hash,
             source.created_at, source.cleaned_at
      FROM wr_source_uploads AS source
      INNER JOIN wr_meetings AS meeting
        ON meeting.id = source.meeting_id AND meeting.account_id = source.account_id
      WHERE source.account_id = ? AND source.upload_id = ?
        AND source.file_path IS NOT NULL
        AND meeting.ingestion_status = 'transcribing'
        AND meeting.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM wr_tombstones AS tombstone
          WHERE tombstone.account_id = source.account_id
            AND tombstone.meeting_id = source.meeting_id
        )
      LIMIT 1
    `).get(accountId, uploadId) as {
      account_id: string; meeting_id: string; upload_id: string; original_name: string;
      mime_type: string; size_bytes: number; recording_date: string;
      file_path: string | null; content_hash: string; created_at: string;
      cleaned_at: string | null;
    } | undefined;
    return row ? {
      accountId: row.account_id, meetingId: row.meeting_id, uploadId: row.upload_id,
      originalName: row.original_name, mimeType: row.mime_type, sizeBytes: row.size_bytes,
      recordingDate: row.recording_date, filePath: row.file_path,
      contentHash: row.content_hash, createdAt: row.created_at, cleanedAt: row.cleaned_at
    } : null;
  }

  clearSourceUploadPath(input: {
    accountId: string; meetingId: string; expectedFilePath?: string; now?: string;
  }) {
    this.requireMeetingRow(input.accountId, input.meetingId);
    const now = input.now ?? this.now();
    const pathClause = input.expectedFilePath === undefined ? "" : "AND file_path = ?";
    const updated = this.database.prepare(`
      UPDATE wr_source_uploads SET file_path = NULL, cleaned_at = ?
      WHERE account_id = ? AND meeting_id = ? AND file_path IS NOT NULL ${pathClause}
    `).run(now, input.accountId, input.meetingId,
      ...(input.expectedFilePath === undefined ? [] : [input.expectedFilePath]));
    if (updated.changes === 0) {
      const current = this.readSourceUpload(input.accountId, input.meetingId);
      if (!current || (current.filePath !== null
        && input.expectedFilePath !== undefined && current.filePath !== input.expectedFilePath)) {
        throw new WorkReviewConflictError("work_review_source_upload_cleanup_conflict");
      }
    }
    return this.readSourceUpload(input.accountId, input.meetingId);
  }

  listPendingSourceUploadCleanups(accountId: string, limit = 10) {
    const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    return this.database.prepare(`
      SELECT source.meeting_id AS meetingId, source.upload_id AS uploadId,
             source.file_path AS filePath
      FROM wr_source_uploads source
      JOIN wr_meetings meeting
        ON meeting.id = source.meeting_id AND meeting.account_id = source.account_id
      LEFT JOIN wr_tombstones tombstone
        ON tombstone.meeting_id = source.meeting_id
       AND tombstone.account_id = source.account_id
      WHERE source.account_id = ? AND source.file_path IS NOT NULL
        AND meeting.ingestion_status = 'transcript_ready'
        AND tombstone.meeting_id IS NULL
      ORDER BY meeting.updated_at, source.meeting_id
      LIMIT ?
    `).all(accountId, boundedLimit) as Array<{
      meetingId: string;
      uploadId: string;
      filePath: string;
    }>;
  }

  listPendingDeletionCleanups(accountId: string, limit = 10) {
    const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
    return this.database.prepare(`
      SELECT tombstone.meeting_id AS meetingId,
             tombstone.source_upload_id AS uploadId,
             source.file_path AS filePath,
             tombstone.cleanup_status AS cleanupStatus
      FROM wr_tombstones tombstone
      LEFT JOIN wr_source_uploads source
        ON source.meeting_id = tombstone.meeting_id
       AND source.account_id = tombstone.account_id
      WHERE tombstone.account_id = ?
        AND tombstone.cleanup_status IN ('pending', 'failed')
      ORDER BY tombstone.deleted_at, tombstone.meeting_id
      LIMIT ?
    `).all(accountId, boundedLimit) as Array<{
      meetingId: string;
      uploadId: string;
      filePath: string | null;
      cleanupStatus: "pending" | "failed";
    }>;
  }

  queueStage(input: { accountId: string; meetingId: string; stage: WorkProcessingStage }) {
    const run = this.database.transaction(() => {
      const meeting = this.assertLiveMeeting(input.accountId, input.meetingId);
      const now = this.now();
      if (input.stage === "transcription") {
        if (!["created", "failed"].includes(meeting.ingestion_status)) {
          throw new WorkReviewConflictError("work_review_transcription_not_queueable");
        }
        this.database.prepare(`
          UPDATE wr_meetings SET ingestion_status = 'queued', version = version + 1,
            updated_at = ?, failed_at = NULL, error_stage = NULL, error_code = NULL
          WHERE id = ? AND account_id = ?
        `).run(now, input.meetingId, input.accountId);
      } else {
        if (meeting.ingestion_status !== "transcript_ready"
          || !["not_started", "failed"].includes(meeting.analysis_status)) {
          throw new WorkReviewConflictError("work_review_analysis_not_queueable");
        }
        this.database.prepare(`
          UPDATE wr_meetings SET analysis_status = 'queued', version = version + 1,
            updated_at = ?, failed_at = NULL, error_stage = NULL, error_code = NULL
          WHERE id = ? AND account_id = ?
        `).run(now, input.meetingId, input.accountId);
      }
      this.database.prepare(`
        UPDATE wr_input_receipts
        SET state = 'accepted', completed_at = NULL, error_code = NULL
        WHERE account_id = ? AND meeting_id = ? AND state <> 'deleted'
      `).run(input.accountId, input.meetingId);
      return meetingFromRow(this.requireMeetingRow(input.accountId, input.meetingId));
    });
    return run.immediate();
  }

  retryProcessing(input: {
    accountId: string;
    meetingId: string;
    operationKey: string;
    allowTranscription: boolean;
    allowAnalysis: boolean;
  }) {
    const accountId = requireText(input.accountId, "work_review_invalid_account");
    const meetingId = requireText(input.meetingId, "work_review_invalid_meeting_id");
    const operationKey = requireText(input.operationKey, "work_review_operation_key_required");
    const requestFingerprint = digest({ action: "retry_processing", meetingId });
    const run = this.database.transaction(() => {
      const replay = this.database.prepare(`
        SELECT request_fingerprint, response_json FROM wr_processing_operations
        WHERE account_id = ? AND operation_key = ?
      `).get(accountId, operationKey) as {
        request_fingerprint: string;
        response_json: string;
      } | undefined;
      if (replay) {
        if (replay.request_fingerprint !== requestFingerprint) {
          throw new WorkReviewConflictError("work_review_operation_conflict");
        }
        const response = JSON.parse(replay.response_json) as { stage: WorkProcessingStage };
        if (response.stage === "transcription" && !input.allowTranscription) {
          throw new WorkReviewFeatureDisabledError("upload_disabled");
        }
        if (response.stage === "meeting_analysis" && !input.allowAnalysis) {
          throw new WorkReviewFeatureDisabledError("analysis_disabled");
        }
        return {
          ...response,
          meeting: meetingFromRow(this.assertLiveMeeting(accountId, meetingId)),
          reused: true
        };
      }

      const meeting = this.assertLiveMeeting(accountId, meetingId);
      const hasCanonicalPublication = Boolean(this.database.prepare(`
        SELECT 1 FROM wr_canonical_publications
        WHERE account_id = ? AND meeting_id = ? AND asset_kind = 'segments'
          AND tombstoned_at IS NULL
      `).get(accountId, meetingId));
      const stage: WorkProcessingStage = hasCanonicalPublication
        ? "meeting_analysis"
        : "transcription";
      if (stage === "transcription" && !input.allowTranscription) {
        throw new WorkReviewFeatureDisabledError("upload_disabled");
      }
      if (stage === "meeting_analysis" && !input.allowAnalysis) {
        throw new WorkReviewFeatureDisabledError("analysis_disabled");
      }
      const now = this.now();
      let queued = false;

      if (stage === "transcription") {
        if (["created", "failed"].includes(meeting.ingestion_status)) {
          this.database.prepare(`
            UPDATE wr_meetings SET ingestion_status = 'queued', version = version + 1,
              updated_at = ?, failed_at = NULL, error_stage = NULL, error_code = NULL
            WHERE id = ? AND account_id = ?
          `).run(now, meetingId, accountId);
          queued = true;
        } else if (!["queued", "transcribing"].includes(meeting.ingestion_status)) {
          throw new WorkReviewConflictError("work_review_transcription_not_retryable");
        }
      } else {
        if (meeting.ingestion_status !== "transcript_ready") {
          throw new WorkReviewConflictError("work_review_analysis_not_retryable");
        }
        if (["not_started", "failed"].includes(meeting.analysis_status)) {
          this.database.prepare(`
            UPDATE wr_meetings SET analysis_status = 'queued', version = version + 1,
              updated_at = ?, failed_at = NULL, error_stage = NULL, error_code = NULL
            WHERE id = ? AND account_id = ?
          `).run(now, meetingId, accountId);
          queued = true;
        } else if (!["queued", "extracting", "verifying"].includes(meeting.analysis_status)) {
          throw new WorkReviewConflictError("work_review_analysis_not_retryable");
        }
      }

      if (queued) {
        this.database.prepare(`
          UPDATE wr_input_receipts
          SET state = 'accepted', completed_at = NULL, error_code = NULL
          WHERE account_id = ? AND meeting_id = ? AND state <> 'deleted'
        `).run(accountId, meetingId);
      }
      const response = { stage };
      this.database.prepare(`
        INSERT INTO wr_processing_operations (
          account_id, operation_key, meeting_id, stage,
          request_fingerprint, response_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(accountId, operationKey, meetingId, stage,
        requestFingerprint, JSON.stringify(response), now);
      return {
        ...response,
        meeting: meetingFromRow(this.requireMeetingRow(accountId, meetingId)),
        reused: false
      };
    });
    return run.immediate();
  }

  claimProcessingAttempt(input: {
    accountId: string; meetingId: string; stage: WorkProcessingStage;
    leaseOwner: string; leaseDurationMs: number; pipelineVersion: string;
    providerProfile: string; promptVersion?: string | null; now?: string;
    deadlineAt?: string | null;
    expectedAttemptVersion?: number; expectedUpdatedAt?: string;
  }): WorkProcessingFence | null {
    const leaseOwner = requireText(input.leaseOwner, "work_review_lease_owner_required");
    if (!Number.isFinite(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      throw new WorkReviewConflictError("work_review_invalid_lease_duration");
    }
    const now = input.now ?? this.now();
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) throw new WorkReviewConflictError("work_review_invalid_lease_clock");
    const leaseExpiresAt = new Date(nowMs + input.leaseDurationMs).toISOString();
    const deadlineAt = input.deadlineAt == null
      ? null
      : normalizeIsoTimestamp(input.deadlineAt, "work_review_invalid_processing_deadline");
    if (deadlineAt !== null && Date.parse(deadlineAt) <= nowMs) {
      throw new WorkReviewConflictError("work_review_invalid_processing_deadline");
    }
    const run = this.database.transaction(() => {
      const meeting = this.assertLiveMeeting(input.accountId, input.meetingId);
      if (input.stage === "transcription"
        && !["created", "queued", "transcribing", "failed"].includes(meeting.ingestion_status)) {
        return null;
      }
      if (input.stage === "meeting_analysis"
        && (meeting.ingestion_status !== "transcript_ready"
          || !["not_started", "queued", "extracting", "verifying", "failed"]
            .includes(meeting.analysis_status))) return null;
      const attemptField = input.stage === "transcription"
        ? "current_transcription_attempt" : "current_analysis_attempt";
      const currentAttempt = input.stage === "transcription"
        ? meeting.current_transcription_attempt : meeting.current_analysis_attempt;
      if (input.expectedAttemptVersion !== undefined
        && currentAttempt !== input.expectedAttemptVersion) return null;
      if (input.expectedUpdatedAt !== undefined
        && meeting.updated_at !== input.expectedUpdatedAt) return null;
      const active = this.database.prepare(`
        SELECT lease_expires_at FROM wr_processing_attempts
        WHERE account_id = ? AND meeting_id = ? AND stage = ? AND state = 'processing'
        ORDER BY attempt_version DESC LIMIT 1
      `).get(input.accountId, input.meetingId, input.stage) as
        { lease_expires_at: string } | undefined;
      if (active?.lease_expires_at && active.lease_expires_at > now) return null;
      this.database.prepare(`
        UPDATE wr_processing_attempts
        SET state = 'superseded', lease_owner = NULL, lease_expires_at = NULL,
            completed_at = ?, error_code = 'work_review_lease_expired'
        WHERE account_id = ? AND meeting_id = ? AND stage = ? AND state = 'processing'
      `).run(now, input.accountId, input.meetingId, input.stage);
      const attemptVersion = currentAttempt + 1;
      this.database.prepare(`
        INSERT INTO wr_processing_attempts (
          id, account_id, meeting_id, stage, attempt_version, lease_owner,
          lease_expires_at, pipeline_version, provider_profile, prompt_version,
          state, created_at, deadline_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?)
      `).run(this.nextId("wra"), input.accountId, input.meetingId, input.stage, attemptVersion,
        leaseOwner, leaseExpiresAt,
        requireText(input.pipelineVersion, "work_review_pipeline_version_required"),
        requireText(input.providerProfile, "work_review_provider_profile_required"),
        input.promptVersion ?? null, now, deadlineAt);
      const statusAssignment = input.stage === "transcription"
        ? "ingestion_status = 'transcribing'"
        : "analysis_status = 'extracting'";
      this.database.prepare(`
        UPDATE wr_meetings SET ${attemptField} = ?, ${statusAssignment},
          version = version + 1, updated_at = ?, failed_at = NULL,
          error_stage = NULL, error_code = NULL
        WHERE id = ? AND account_id = ?
      `).run(attemptVersion, now, input.meetingId, input.accountId);
      this.database.prepare(`
        UPDATE wr_input_receipts SET state = 'processing', error_code = NULL
        WHERE account_id = ? AND meeting_id = ? AND state <> 'deleted'
      `).run(input.accountId, input.meetingId);
      return { stage: input.stage, attemptVersion, leaseOwner, leaseExpiresAt, deadlineAt };
    });
    return run.immediate();
  }

  private assertFence(input: {
    accountId: string; meetingId: string; fence: WorkProcessingFence; now?: string;
    allowExpiredDeadline?: boolean;
  }) {
    const meeting = this.assertLiveMeeting(input.accountId, input.meetingId);
    const currentAttempt = input.fence.stage === "transcription"
      ? meeting.current_transcription_attempt : meeting.current_analysis_attempt;
    const now = input.now ?? this.now();
    const attempt = this.database.prepare(`
      SELECT lease_owner, lease_expires_at, deadline_at, state FROM wr_processing_attempts
      WHERE account_id = ? AND meeting_id = ? AND stage = ? AND attempt_version = ?
    `).get(input.accountId, input.meetingId, input.fence.stage,
      input.fence.attemptVersion) as {
        lease_owner: string | null; lease_expires_at: string | null;
        deadline_at: string | null; state: string;
      } | undefined;
    if (currentAttempt !== input.fence.attemptVersion || !attempt
      || attempt.state !== "processing" || attempt.lease_owner !== input.fence.leaseOwner
      || !attempt.lease_expires_at || attempt.lease_expires_at <= now) {
      throw new WorkReviewLeaseLostError();
    }
    if (!input.allowExpiredDeadline && attempt.deadline_at !== null) {
      const deadlineMs = Date.parse(attempt.deadline_at);
      const nowMs = Date.parse(now);
      if (!Number.isFinite(deadlineMs) || !Number.isFinite(nowMs) || deadlineMs <= nowMs) {
        throw new WorkReviewAnalysisDeadlineExceededError();
      }
    }
    return meeting;
  }

  renewProcessingLease(input: {
    accountId: string; meetingId: string; fence: WorkProcessingFence;
    leaseDurationMs: number; now?: string;
  }) {
    const now = input.now ?? this.now();
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs) || !Number.isFinite(input.leaseDurationMs)
      || input.leaseDurationMs <= 0) {
      throw new WorkReviewConflictError("work_review_invalid_lease_clock");
    }
    const leaseExpiresAt = new Date(nowMs + input.leaseDurationMs).toISOString();
    const updated = this.database.prepare(`
      UPDATE wr_processing_attempts SET lease_expires_at = ?
      WHERE account_id = ? AND meeting_id = ? AND stage = ? AND attempt_version = ?
        AND state = 'processing' AND lease_owner = ? AND lease_expires_at > ?
        AND NOT EXISTS (
          SELECT 1 FROM wr_tombstones
          WHERE account_id = ? AND meeting_id = ?
        )
    `).run(leaseExpiresAt, input.accountId, input.meetingId, input.fence.stage,
      input.fence.attemptVersion, input.fence.leaseOwner, now,
      input.accountId, input.meetingId);
    if (updated.changes !== 1) throw new WorkReviewLeaseLostError();
    return { ...input.fence, leaseExpiresAt };
  }

  publishCanonicalTranscript(input: {
    accountId: string; meetingId: string; fence: WorkProcessingFence;
    segments: WorkTranscriptSegment[]; publicationId?: string;
    sourceDurationSeconds?: number | null; now?: string;
  }) {
    if (input.fence.stage !== "transcription") throw new WorkReviewLeaseLostError();
    const preliminary = this.assertLiveMeeting(input.accountId, input.meetingId);
    const segments = canonicalizeSegments(input.segments, preliminary.source_upload_id);
    const contentDigest = digest(segments);
    const sourceDurationSeconds = input.sourceDurationSeconds ?? null;
    if (sourceDurationSeconds !== null
      && (!Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds <= 0)) {
      throw new WorkReviewConflictError("work_review_invalid_audio_duration");
    }
    const now = input.now ?? this.now();
    const run = this.database.transaction(() => {
      const meeting = this.assertFence({ ...input, now });
      const sourceUpload = this.readSourceUpload(input.accountId, input.meetingId);
      if (!sourceUpload || sourceUpload.uploadId !== meeting.source_upload_id
        || sourceUpload.filePath === null) {
        throw new WorkReviewConflictError("work_review_source_upload_missing");
      }
      const existing = this.database.prepare(`
        SELECT * FROM wr_canonical_publications
        WHERE account_id = ? AND meeting_id = ? AND asset_kind = 'segments'
      `).get(input.accountId, input.meetingId) as PublicationRow | undefined;
      if (existing) {
        if (existing.content_digest !== contentDigest
          || existing.source_upload_id !== meeting.source_upload_id) {
          throw new WorkReviewConflictError("work_review_canonical_publication_conflict");
        }
        return { publication: this.publicationFromRow(existing), reused: true };
      }
      const publicationId = input.publicationId ?? this.nextId("wrp");
      this.database.prepare(`
        INSERT INTO wr_canonical_publications (
          publication_id, account_id, meeting_id, source_upload_id, product_space,
          asset_kind, attempt_version, content_digest, segment_count, payload_json,
          created_at
        ) VALUES (?, ?, ?, ?, 'office_review', 'segments', ?, ?, ?, ?, ?)
      `).run(publicationId, input.accountId, input.meetingId, meeting.source_upload_id,
        input.fence.attemptVersion, contentDigest, segments.length,
        JSON.stringify(segments), now);
      const updated = this.database.prepare(`
        UPDATE wr_meetings
        SET ingestion_status = 'transcript_ready', canonical_publication_id = ?,
            canonical_content_digest = ?, canonical_segment_count = ?,
            source_duration_seconds = COALESCE(?, source_duration_seconds),
            transcript_ready_at = ?, version = version + 1, updated_at = ?,
            failed_at = NULL, error_stage = NULL, error_code = NULL
        WHERE id = ? AND account_id = ? AND ingestion_status = 'transcribing'
          AND current_transcription_attempt = ? AND deleted_at IS NULL
      `).run(publicationId, contentDigest, segments.length, sourceDurationSeconds, now, now,
        input.meetingId, input.accountId, input.fence.attemptVersion);
      if (updated.changes !== 1) throw new WorkReviewLeaseLostError();
      this.completeAttempt(input.accountId, input.meetingId, input.fence, now);
      this.database.prepare(`
        UPDATE wr_input_receipts SET state = 'completed', completed_at = ?, error_code = NULL
        WHERE account_id = ? AND meeting_id = ? AND state <> 'deleted'
      `).run(now, input.accountId, input.meetingId);
      const row = this.database.prepare(`
        SELECT * FROM wr_canonical_publications WHERE publication_id = ?
      `).get(publicationId) as PublicationRow;
      return { publication: this.publicationFromRow(row), reused: false };
    });
    return run.immediate();
  }

  private completeAttempt(
    accountId: string, meetingId: string, fence: WorkProcessingFence, now: string
  ) {
    const updated = this.database.prepare(`
      UPDATE wr_processing_attempts
      SET state = 'completed', lease_owner = NULL, lease_expires_at = NULL,
          completed_at = ?, error_code = NULL
      WHERE account_id = ? AND meeting_id = ? AND stage = ? AND attempt_version = ?
        AND state = 'processing' AND lease_owner = ?
    `).run(now, accountId, meetingId, fence.stage, fence.attemptVersion, fence.leaseOwner);
    if (updated.changes !== 1) throw new WorkReviewLeaseLostError();
  }

  markStageFailed(input: {
    accountId: string; meetingId: string; fence: WorkProcessingFence;
    errorCode: string; now?: string;
  }) {
    const now = input.now ?? this.now();
    const run = this.database.transaction(() => {
      this.assertFence({ ...input, now, allowExpiredDeadline: true });
      const statusAssignment = input.fence.stage === "transcription"
        ? "ingestion_status = 'failed'" : "analysis_status = 'failed'";
      this.database.prepare(`
        UPDATE wr_meetings SET ${statusAssignment}, failed_at = ?, error_stage = ?,
          error_code = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND account_id = ?
      `).run(now, input.fence.stage, requireText(input.errorCode, "work_review_error_code_required"),
        now, input.meetingId, input.accountId);
      this.database.prepare(`
        UPDATE wr_processing_attempts
        SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL,
            completed_at = ?, error_code = ?
        WHERE account_id = ? AND meeting_id = ? AND stage = ? AND attempt_version = ?
          AND state = 'processing' AND lease_owner = ?
      `).run(now, input.errorCode, input.accountId, input.meetingId,
        input.fence.stage, input.fence.attemptVersion, input.fence.leaseOwner);
      this.database.prepare(`
        UPDATE wr_input_receipts SET state = 'failed', completed_at = ?, error_code = ?
        WHERE account_id = ? AND meeting_id = ? AND state <> 'deleted'
      `).run(now, input.errorCode, input.accountId, input.meetingId);
      return meetingFromRow(this.requireMeetingRow(input.accountId, input.meetingId));
    });
    return run.immediate();
  }

  markAnalysisVerifying(input: {
    accountId: string; meetingId: string; fence: WorkProcessingFence; now?: string;
  }) {
    if (input.fence.stage !== "meeting_analysis") throw new WorkReviewLeaseLostError();
    const run = this.database.transaction(() => {
      const now = input.now ?? this.now();
      const meeting = this.assertFence({ ...input, now });
      if (meeting.analysis_status !== "extracting") {
        throw new WorkReviewConflictError("work_review_analysis_not_extracting");
      }
      const updated = this.database.prepare(`
        UPDATE wr_meetings
        SET analysis_status = 'verifying', version = version + 1, updated_at = ?
        WHERE id = ? AND account_id = ? AND analysis_status = 'extracting'
          AND current_analysis_attempt = ? AND deleted_at IS NULL
      `).run(now, input.meetingId, input.accountId, input.fence.attemptVersion);
      if (updated.changes !== 1) throw new WorkReviewLeaseLostError();
      return meetingFromRow(this.requireMeetingRow(input.accountId, input.meetingId));
    });
    return run.immediate();
  }

  private publicationFromRow(row: PublicationRow): WorkCanonicalPublicationRecord {
    return {
      publicationId: row.publication_id, accountId: row.account_id,
      meetingId: row.meeting_id, sourceUploadId: row.source_upload_id,
      attemptVersion: row.attempt_version, contentDigest: row.content_digest,
      segmentCount: row.segment_count,
      segments: JSON.parse(row.payload_json) as WorkTranscriptSegment[],
      createdAt: row.created_at,
      assetKind: "segments",
      tombstonedAt: null
    };
  }

  readCanonicalPublication(accountId: string, meetingId: string) {
    this.assertLiveMeeting(accountId, meetingId);
    const row = this.database.prepare(`
      SELECT * FROM wr_canonical_publications
      WHERE account_id = ? AND meeting_id = ? AND asset_kind = 'segments'
        AND tombstoned_at IS NULL
    `).get(accountId, meetingId) as PublicationRow | undefined;
    return row ? this.publicationFromRow(row) : null;
  }

  private assertAnalysisCheckpointContext(input: {
    accountId: string;
    meetingId: string;
    fence: WorkProcessingFence;
    publicationId: string;
    canonicalContentDigest: string;
    now: string;
  }) {
    if (input.fence.stage !== "meeting_analysis") throw new WorkReviewLeaseLostError();
    const meeting = this.assertFence(input);
    if (meeting.ingestion_status !== "transcript_ready"
      || meeting.canonical_publication_id !== input.publicationId
      || meeting.canonical_content_digest !== input.canonicalContentDigest) {
      throw new WorkReviewConflictError("work_review_canonical_digest_mismatch");
    }
    const publication = this.database.prepare(`
      SELECT 1 FROM wr_canonical_publications
      WHERE publication_id = ? AND account_id = ? AND meeting_id = ?
        AND content_digest = ? AND asset_kind = 'segments' AND tombstoned_at IS NULL
    `).get(input.publicationId, input.accountId, input.meetingId,
      input.canonicalContentDigest);
    if (!publication) {
      throw new WorkReviewConflictError("work_review_canonical_digest_mismatch");
    }
  }

  readAnalysisCheckpoint(
    input: WorkAnalysisCheckpointInput
  ): WorkAnalysisCheckpointRecord | null {
    const publicationId = requireText(
      input.publicationId,
      "work_review_analysis_checkpoint_publication_required"
    );
    const canonicalContentDigest = requireDigest(
      input.canonicalContentDigest,
      "work_review_invalid_canonical_digest"
    );
    const checkpointKind = requireCheckpointKind(input.checkpointKind);
    const logicalInputDigest = requireDigest(
      input.logicalInputDigest,
      "work_review_analysis_checkpoint_input_digest_invalid"
    );
    const providerContractDigest = requireDigest(
      input.providerContractDigest,
      "work_review_analysis_checkpoint_contract_digest_invalid"
    );
    const outputSchemaVersion = requireText(
      input.outputSchemaVersion,
      "work_review_analysis_checkpoint_schema_required"
    );
    const run = this.database.transaction(() => {
      const now = input.now ?? this.now();
      this.assertAnalysisCheckpointContext({
        ...input,
        publicationId,
        canonicalContentDigest,
        now
      });
      const row = this.database.prepare(`
        SELECT * FROM wr_analysis_checkpoints
        WHERE account_id = ? AND meeting_id = ? AND publication_id = ?
          AND checkpoint_kind = ? AND logical_input_digest = ?
          AND provider_contract_digest = ?
      `).get(input.accountId, input.meetingId, publicationId, checkpointKind,
        logicalInputDigest, providerContractDigest) as AnalysisCheckpointRow | undefined;
      if (!row) return null;
      if (row.canonical_content_digest !== canonicalContentDigest
        || row.output_schema_version !== outputSchemaVersion) {
        throw new WorkReviewConflictError("work_review_analysis_checkpoint_conflict");
      }
      return checkpointFromRow(row);
    });
    return run.immediate();
  }

  saveAnalysisCheckpoint(
    input: WorkAnalysisCheckpointInput & { payload: unknown }
  ): { checkpoint: WorkAnalysisCheckpointRecord; reused: boolean } {
    const publicationId = requireText(
      input.publicationId,
      "work_review_analysis_checkpoint_publication_required"
    );
    const canonicalContentDigest = requireDigest(
      input.canonicalContentDigest,
      "work_review_invalid_canonical_digest"
    );
    const checkpointKind = requireCheckpointKind(input.checkpointKind);
    const logicalInputDigest = requireDigest(
      input.logicalInputDigest,
      "work_review_analysis_checkpoint_input_digest_invalid"
    );
    const providerContractDigest = requireDigest(
      input.providerContractDigest,
      "work_review_analysis_checkpoint_contract_digest_invalid"
    );
    const outputSchemaVersion = requireText(
      input.outputSchemaVersion,
      "work_review_analysis_checkpoint_schema_required"
    );
    const payloadJson = canonicalJson(input.payload);
    const payloadDigest = serializedDigest(payloadJson);
    const run = this.database.transaction(() => {
      const now = input.now ?? this.now();
      this.assertAnalysisCheckpointContext({
        ...input,
        publicationId,
        canonicalContentDigest,
        now
      });
      const existing = this.database.prepare(`
        SELECT * FROM wr_analysis_checkpoints
        WHERE account_id = ? AND meeting_id = ? AND publication_id = ?
          AND checkpoint_kind = ? AND logical_input_digest = ?
          AND provider_contract_digest = ?
      `).get(input.accountId, input.meetingId, publicationId, checkpointKind,
        logicalInputDigest, providerContractDigest) as AnalysisCheckpointRow | undefined;
      if (existing) {
        if (existing.canonical_content_digest !== canonicalContentDigest
          || existing.output_schema_version !== outputSchemaVersion
          || existing.payload_digest !== payloadDigest
          || existing.payload_json !== payloadJson) {
          throw new WorkReviewConflictError("work_review_analysis_checkpoint_conflict");
        }
        return { checkpoint: checkpointFromRow(existing), reused: true };
      }
      this.database.prepare(`
        INSERT INTO wr_analysis_checkpoints (
          account_id, meeting_id, publication_id, canonical_content_digest,
          checkpoint_kind, logical_input_digest, provider_contract_digest,
          output_schema_version, payload_json, payload_digest,
          origin_attempt_version, attempt_stage, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'meeting_analysis', ?)
      `).run(input.accountId, input.meetingId, publicationId, canonicalContentDigest,
        checkpointKind, logicalInputDigest, providerContractDigest,
        outputSchemaVersion, payloadJson, payloadDigest,
        input.fence.attemptVersion, now);
      const row = this.database.prepare(`
        SELECT * FROM wr_analysis_checkpoints
        WHERE account_id = ? AND meeting_id = ? AND publication_id = ?
          AND checkpoint_kind = ? AND logical_input_digest = ?
          AND provider_contract_digest = ?
      `).get(input.accountId, input.meetingId, publicationId, checkpointKind,
        logicalInputDigest, providerContractDigest) as AnalysisCheckpointRow;
      return { checkpoint: checkpointFromRow(row), reused: false };
    });
    return run.immediate();
  }

  publishAnalysisResult(input: {
    accountId: string; meetingId: string; fence: WorkProcessingFence;
    canonicalContentDigest: string;
    analysisAudit?: unknown;
    candidates: Array<{
      id?: string; kind: WorkCandidateKind; title: string; body: string;
      structuredData: unknown; publicationAction: WorkPublicationAction;
      riskLevel: WorkRiskLevel; generatorProfile: string;
      generatorPromptVersion: string; evidenceSegmentIds: string[];
      timestampQualityBySegmentId?: Record<string, WorkTimestampQuality>;
      claims: Array<{
        id?: string; claimType: WorkClaimType; text: string; evidenceSegmentIds: string[];
        evaluation: {
          supportVerdict: WorkSupportVerdict; issueCodes: string[];
          riskLevel: WorkRiskLevel; publicationAction: WorkPublicationAction;
          confirmationRequired: boolean; supportedEvidenceIds: string[];
          generatorProfile: string; verifierProfile: string;
          verifierPromptVersion: string; policyVersion: string;
        };
      }>;
    }>;
    now?: string;
  }) {
    if (input.fence.stage !== "meeting_analysis") throw new WorkReviewLeaseLostError();
    const expectedDigest = requireDigest(
      input.canonicalContentDigest, "work_review_invalid_canonical_digest"
    );
    const run = this.database.transaction(() => {
      const now = input.now ?? this.now();
      const meeting = this.assertFence({ ...input, now });
      if (meeting.ingestion_status !== "transcript_ready"
        || meeting.analysis_status !== "verifying"
        || meeting.canonical_content_digest !== expectedDigest
        || !meeting.canonical_publication_id) {
        throw new WorkReviewConflictError("work_review_canonical_digest_mismatch");
      }
      const publication = this.database.prepare(`
        SELECT * FROM wr_canonical_publications
        WHERE publication_id = ? AND account_id = ? AND meeting_id = ?
          AND tombstoned_at IS NULL
      `).get(meeting.canonical_publication_id, input.accountId,
        input.meetingId) as PublicationRow | undefined;
      if (!publication || publication.content_digest !== expectedDigest) {
        throw new WorkReviewConflictError("work_review_canonical_digest_mismatch");
      }
      const existingCount = (this.database.prepare(`
        SELECT count(*) AS count FROM wr_meeting_candidates
        WHERE account_id = ? AND meeting_id = ?
      `).get(input.accountId, input.meetingId) as { count: number }).count;
      if (existingCount > 0) throw new WorkReviewConflictError("work_review_analysis_result_conflict");
      const canonicalSegments = JSON.parse(publication.payload_json) as WorkTranscriptSegment[];
      const segmentById = new Map(canonicalSegments.map((segment) => [segment.id, segment]));
      const allCandidateIds = new Set<string>();
      input.candidates.forEach((candidate, ordinal) => {
        const candidateId = candidate.id ?? this.nextId("wrc");
        if (allCandidateIds.has(candidateId)) {
          throw new WorkReviewConflictError("work_review_duplicate_candidate_id");
        }
        allCandidateIds.add(candidateId);
        const evidenceIds = [...new Set(candidate.evidenceSegmentIds)];
        if (evidenceIds.length === 0 || evidenceIds.some((id) => !segmentById.has(id))) {
          throw new WorkReviewConflictError("work_review_candidate_evidence_invalid");
        }
        const candidateStatus: WorkCandidateStatus = candidate.publicationAction === "suppress"
          ? "invalidated" : "pending_review";
        this.database.prepare(`
          INSERT INTO wr_meeting_candidates (
            id, account_id, meeting_id, publication_id, ordinal, kind, title, body,
            structured_data_json, status, publication_action, risk_level,
            generator_profile, generator_prompt_version, analysis_attempt_version,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(candidateId, input.accountId, input.meetingId, publication.publication_id,
          ordinal, candidate.kind, requireText(candidate.title, "work_review_candidate_title_required"),
          requireText(candidate.body, "work_review_candidate_body_required"),
          JSON.stringify(candidate.structuredData ?? {}), candidateStatus,
          candidate.publicationAction, candidate.riskLevel,
          requireText(candidate.generatorProfile, "work_review_generator_profile_required"),
          requireText(candidate.generatorPromptVersion, "work_review_generator_prompt_required"),
          input.fence.attemptVersion, now, now);
        evidenceIds.forEach((segmentId, position) => {
          const segment = segmentById.get(segmentId)!;
          this.database.prepare(`
            INSERT INTO wr_candidate_evidence (
              account_id, meeting_id, candidate_id, publication_id, position,
              segment_id, start_seconds, end_seconds, raw_speaker_label,
              timestamp_quality
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(input.accountId, input.meetingId, candidateId, publication.publication_id,
            position, segmentId, segment.startSeconds, segment.endSeconds,
            segment.speaker ?? null,
            candidate.timestampQualityBySegmentId?.[segmentId] ?? "unknown");
        });
        const claimIds = new Set<string>();
        candidate.claims.forEach((claim, claimOrdinal) => {
          const claimId = claim.id ?? this.nextId("wrcl");
          if (claimIds.has(claimId)) {
            throw new WorkReviewConflictError("work_review_duplicate_claim_id");
          }
          claimIds.add(claimId);
          const claimEvidenceIds = [...new Set(claim.evidenceSegmentIds)];
          if (claimEvidenceIds.length === 0
            || claimEvidenceIds.some((id) => !segmentById.has(id))
            || claimEvidenceIds.some((id) => !evidenceIds.includes(id))) {
            throw new WorkReviewConflictError("work_review_claim_evidence_invalid");
          }
          const supportedIds = [...new Set(claim.evaluation.supportedEvidenceIds)];
          if (supportedIds.some((id) => !claimEvidenceIds.includes(id))) {
            throw new WorkReviewConflictError("work_review_evaluation_evidence_invalid");
          }
          this.database.prepare(`
            INSERT INTO wr_atomic_claims (
              id, account_id, meeting_id, candidate_id, ordinal, claim_type, text, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(claimId, input.accountId, input.meetingId, candidateId, claimOrdinal,
            claim.claimType, requireText(claim.text, "work_review_claim_text_required"), now);
          claimEvidenceIds.forEach((segmentId, position) => {
            this.database.prepare(`
              INSERT INTO wr_claim_evidence (
                account_id, meeting_id, claim_id, publication_id, position, segment_id
              ) VALUES (?, ?, ?, ?, ?, ?)
            `).run(input.accountId, input.meetingId, claimId,
              publication.publication_id, position, segmentId);
          });
          this.database.prepare(`
            INSERT INTO wr_claim_evaluations (
              id, account_id, meeting_id, claim_id, support_verdict, issue_codes_json,
              risk_level, publication_action, confirmation_required,
              supported_evidence_ids_json, generator_profile, verifier_profile,
              verifier_prompt_version, policy_version, verified_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(this.nextId("wrev"), input.accountId, input.meetingId, claimId,
            claim.evaluation.supportVerdict, JSON.stringify(claim.evaluation.issueCodes),
            claim.evaluation.riskLevel, claim.evaluation.publicationAction,
            claim.evaluation.confirmationRequired ? 1 : 0, JSON.stringify(supportedIds),
            requireText(claim.evaluation.generatorProfile, "work_review_generator_profile_required"),
            requireText(claim.evaluation.verifierProfile, "work_review_verifier_profile_required"),
            requireText(claim.evaluation.verifierPromptVersion, "work_review_verifier_prompt_required"),
            requireText(claim.evaluation.policyVersion, "work_review_policy_version_required"), now);
        });
      });
      if (input.analysisAudit !== undefined) {
        const auditJson = JSON.stringify(input.analysisAudit);
        if (Buffer.byteLength(auditJson, "utf8") > 8 * 1024 * 1024) {
          throw new WorkReviewConflictError("work_review_analysis_audit_limit_exceeded");
        }
        try {
          validateWorkMeetingAnalysisAudit({ audit: input.analysisAudit, segments: canonicalSegments,
            accountId: input.accountId, meetingId: input.meetingId, canonicalDigest: expectedDigest,
            publicationId: publication.publication_id, publishedCandidates: input.candidates });
        } catch {
          throw new WorkReviewConflictError("work_review_analysis_audit_invalid");
        }
        this.database.prepare(`
          INSERT INTO wr_analysis_audits (
            account_id, meeting_id, publication_id, canonical_content_digest,
            attempt_version, schema_version, payload_json, payload_digest, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(input.accountId, input.meetingId, publication.publication_id, expectedDigest,
          input.fence.attemptVersion, WORK_MEETING_ANALYSIS_AUDIT_VERSION, auditJson, serializedDigest(auditJson), now);
      }
      this.database.prepare(`
        DELETE FROM wr_analysis_checkpoints
        WHERE account_id = ? AND meeting_id = ?
      `).run(input.accountId, input.meetingId);
      const updated = this.database.prepare(`
        UPDATE wr_meetings
        SET analysis_status = 'review_ready', review_status = 'not_started',
            review_ready_at = ?, version = version + 1, updated_at = ?,
            failed_at = NULL, error_stage = NULL, error_code = NULL
        WHERE id = ? AND account_id = ? AND analysis_status = 'verifying'
          AND current_analysis_attempt = ? AND canonical_content_digest = ?
          AND deleted_at IS NULL
      `).run(now, now, input.meetingId, input.accountId,
        input.fence.attemptVersion, expectedDigest);
      if (updated.changes !== 1) throw new WorkReviewLeaseLostError();
      this.completeAttempt(input.accountId, input.meetingId, input.fence, now);
      this.database.prepare(`
        UPDATE wr_input_receipts
        SET state = 'completed', completed_at = ?, error_code = NULL
        WHERE account_id = ? AND meeting_id = ? AND state <> 'deleted'
      `).run(now, input.accountId, input.meetingId);
      return this.listCandidates(input.accountId, input.meetingId);
    });
    return run.immediate();
  }

  readAnalysisAudit(accountId: string, meetingId: string) {
    const meeting = this.assertLiveMeeting(accountId, meetingId);
    const row = this.database.prepare(`
      SELECT payload_json, payload_digest, schema_version FROM wr_analysis_audits
      WHERE account_id = ? AND meeting_id = ? AND publication_id = ? AND canonical_content_digest = ?
      ORDER BY attempt_version DESC LIMIT 1
    `).get(accountId, meetingId, meeting.canonical_publication_id, meeting.canonical_content_digest) as
      { payload_json: string; payload_digest: string; schema_version: string } | undefined;
    if (!row) return null;
    if (row.schema_version !== WORK_MEETING_ANALYSIS_AUDIT_VERSION || serializedDigest(row.payload_json) !== row.payload_digest) {
      throw new WorkReviewConflictError("work_review_analysis_audit_invalid");
    }
    return WorkMeetingAnalysisAuditSchema.parse(JSON.parse(row.payload_json));
  }

  listCandidates(accountId: string, meetingId: string, includeSuppressed = true) {
    this.requireMeetingRow(accountId, meetingId);
    const clause = includeSuppressed ? "" : "AND status <> 'invalidated'";
    return (this.database.prepare(`
      SELECT * FROM wr_meeting_candidates
      WHERE account_id = ? AND meeting_id = ? ${clause}
      ORDER BY ordinal, id
    `).all(accountId, meetingId) as CandidateRow[]).map((row) => candidateFromRow(
      row, this.candidateEvidenceRefs(accountId, meetingId, row.id)
    ));
  }

  private candidateEvidenceRefs(accountId: string, meetingId: string, candidateId: string) {
    return this.database.prepare(`
      SELECT publication_id AS publicationId, segment_id AS segmentId,
             start_seconds AS startSeconds, end_seconds AS endSeconds,
             raw_speaker_label AS rawSpeakerLabel, timestamp_quality AS timestampQuality
      FROM wr_candidate_evidence
      WHERE account_id = ? AND meeting_id = ? AND candidate_id = ?
      ORDER BY position
    `).all(accountId, meetingId, candidateId) as WorkEvidenceReferenceRecord[];
  }

  private findingEvidenceRefs(accountId: string, meetingId: string, findingId: string) {
    return this.database.prepare(`
      SELECT publication_id AS publicationId, segment_id AS segmentId,
             start_seconds AS startSeconds, end_seconds AS endSeconds,
             raw_speaker_label AS rawSpeakerLabel, timestamp_quality AS timestampQuality
      FROM wr_finding_evidence
      WHERE account_id = ? AND meeting_id = ? AND finding_id = ?
      ORDER BY position
    `).all(accountId, meetingId, findingId) as WorkEvidenceReferenceRecord[];
  }

  listAtomicClaims(accountId: string, meetingId: string): WorkAtomicClaimRecord[] {
    this.requireMeetingRow(accountId, meetingId);
    const rows = this.database.prepare(`
      SELECT id, candidate_id, claim_type, text, created_at
      FROM wr_atomic_claims
      WHERE account_id = ? AND meeting_id = ?
      ORDER BY candidate_id, ordinal, id
    `).all(accountId, meetingId) as Array<{
      id: string; candidate_id: string; claim_type: WorkClaimType;
      text: string; created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id, candidateId: row.candidate_id, claimType: row.claim_type,
      text: row.text,
      evidenceIds: (this.database.prepare(`
        SELECT segment_id FROM wr_claim_evidence
        WHERE account_id = ? AND meeting_id = ? AND claim_id = ?
        ORDER BY position
      `).all(accountId, meetingId, row.id) as Array<{ segment_id: string }>)
        .map((item) => item.segment_id),
      createdAt: row.created_at
    }));
  }

  listClaimEvaluations(accountId: string, meetingId: string): WorkClaimEvaluationRecord[] {
    this.requireMeetingRow(accountId, meetingId);
    return (this.database.prepare(`
      SELECT id, account_id, meeting_id, claim_id, support_verdict,
             issue_codes_json, risk_level, publication_action,
             confirmation_required, supported_evidence_ids_json,
             generator_profile, verifier_profile, verifier_prompt_version,
             policy_version, verified_at
      FROM wr_claim_evaluations
      WHERE account_id = ? AND meeting_id = ?
      ORDER BY verified_at, id
    `).all(accountId, meetingId) as Array<{
      id: string; account_id: string; meeting_id: string; claim_id: string;
      support_verdict: WorkSupportVerdict; issue_codes_json: string;
      risk_level: WorkRiskLevel; publication_action: WorkPublicationAction;
      confirmation_required: number; supported_evidence_ids_json: string;
      generator_profile: string; verifier_profile: string;
      verifier_prompt_version: string; policy_version: string;
      verified_at: string;
    }>).map((row) => ({
      id: row.id, accountId: row.account_id, meetingId: row.meeting_id,
      claimId: row.claim_id, supportVerdict: row.support_verdict,
      issueCodes: JSON.parse(row.issue_codes_json) as string[], riskLevel: row.risk_level,
      publicationAction: row.publication_action,
      confirmationRequired: row.confirmation_required === 1,
      supportedEvidenceIds: JSON.parse(row.supported_evidence_ids_json) as string[],
      generatorProfile: row.generator_profile, verifierProfile: row.verifier_profile,
      verifierPromptVersion: row.verifier_prompt_version,
      policyVersion: row.policy_version, verifiedAt: row.verified_at
    }));
  }

  listFindings(accountId: string, meetingId: string) {
    this.requireMeetingRow(accountId, meetingId);
    return (this.database.prepare(`
      SELECT * FROM wr_findings WHERE account_id = ? AND meeting_id = ?
      ORDER BY created_at, id
    `).all(accountId, meetingId) as FindingRow[]).map((row) => findingFromRow(
      row, this.findingEvidenceRefs(accountId, meetingId, row.id)
    ));
  }

  private sanitizeFindingStructuredData(input: {
    accountId: string;
    meetingId: string;
    candidateId: string;
    targetKind: WorkCandidateKind;
    originalValue: unknown;
    requestedValue: unknown;
  }): WorkMeetingCandidateStructuredData {
    const original = WorkMeetingCandidateStructuredDataSchema.parse(input.originalValue);
    const requested = WorkMeetingCandidateStructuredDataSchema.parse(input.requestedValue);
    const candidateEvidence = this.candidateEvidenceRefs(
      input.accountId,
      input.meetingId,
      input.candidateId
    );
    const evidenceBySegmentId = new Map(candidateEvidence.map((reference) => [
      reference.segmentId,
      reference
    ]));
    const planStages = input.targetKind === "plan_change"
      ? requested.planStages.map((stage) => {
          const ids = stage.evidenceRefs.map((reference) => reference.segmentId);
          if (new Set(ids).size !== ids.length) {
            throw new WorkReviewConflictError("work_review_finding_evidence_invalid");
          }
          const evidenceRefs = ids.map((segmentId) => {
            const reference = evidenceBySegmentId.get(segmentId);
            if (!reference) {
              throw new WorkReviewConflictError("work_review_finding_evidence_invalid");
            }
            return reference;
          });
          return {
            ...stage,
            rawSpeakerLabel: evidenceRefs[0]?.rawSpeakerLabel ?? null,
            evidenceRefs
          };
        })
      : [];
    if (input.targetKind === "plan_change" && planStages.length < 2) {
      throw new WorkReviewConflictError("work_review_plan_change_stages_required");
    }
    const assignmentKind = input.targetKind === "commitment"
      || input.targetKind === "action_item";
    const relatedCommitmentCandidateId = input.targetKind === "action_item"
      ? requested.relatedCommitmentCandidateId
      : null;
    if (relatedCommitmentCandidateId) {
      const related = this.database.prepare(`
        SELECT 1 FROM wr_meeting_candidates
        WHERE id = ? AND account_id = ? AND meeting_id = ?
          AND kind = 'commitment' AND status <> 'invalidated'
          AND id <> ?
      `).get(relatedCommitmentCandidateId, input.accountId, input.meetingId,
        input.candidateId);
      if (!related) {
        throw new WorkReviewConflictError("work_review_related_commitment_invalid");
      }
    }
    return WorkMeetingCandidateStructuredDataSchema.parse({
      decisionFinality: input.targetKind === "decision"
        ? requested.decisionFinality
        : null,
      rawActorLabel: assignmentKind ? original.rawActorLabel : null,
      candidateOwner: assignmentKind ? requested.candidateOwner : null,
      dueAt: assignmentKind ? requested.dueAt : null,
      originalDueExpression: assignmentKind ? original.originalDueExpression : null,
      actionBasis: input.targetKind === "commitment"
        ? "explicit_commitment"
        : input.targetKind === "action_item"
          ? requested.actionBasis
          : null,
      relatedCommitmentCandidateId,
      planStages
    });
  }

  reviewCandidate(input: {
    accountId: string; meetingId: string; candidateId: string;
    action: "accept" | "edit_and_accept" | "retype_and_accept" | "ignore";
    expectedVersion: number; operationKey: string;
    title?: string; body?: string; kind?: WorkCandidateKind; structuredData?: unknown;
  }) {
    const operationKey = requireText(input.operationKey, "work_review_operation_key_required");
    const requestFingerprint = digest({
      meetingId: input.meetingId, candidateId: input.candidateId, action: input.action,
      expectedVersion: input.expectedVersion, title: input.title ?? null,
      body: input.body ?? null, kind: input.kind ?? null,
      structuredData: input.structuredData ?? null
    });
    const run = this.database.transaction(() => {
      const replay = this.database.prepare(`
        SELECT request_fingerprint, response_json FROM wr_review_operations
        WHERE account_id = ? AND operation_key = ?
      `).get(input.accountId, operationKey) as {
        request_fingerprint: string; response_json: string;
      } | undefined;
      if (replay) {
        if (replay.request_fingerprint !== requestFingerprint) {
          throw new WorkReviewConflictError("work_review_operation_conflict");
        }
        const response = JSON.parse(replay.response_json) as {
          candidate: WorkCandidateRecord;
          finding: WorkFindingRecord | null;
        };
        return { ...response, reused: true };
      }
      const meeting = this.assertLiveMeeting(input.accountId, input.meetingId);
      if (meeting.analysis_status !== "review_ready") {
        throw new WorkReviewConflictError("work_review_not_review_ready");
      }
      const row = this.database.prepare(`
        SELECT * FROM wr_meeting_candidates
        WHERE id = ? AND account_id = ? AND meeting_id = ?
      `).get(input.candidateId, input.accountId, input.meetingId) as CandidateRow | undefined;
      if (!row) throw new WorkReviewNotFoundError();
      if (row.version !== input.expectedVersion) {
        throw new WorkReviewVersionConflictError(row.version);
      }
      if (row.status !== "pending_review") {
        throw new WorkReviewConflictError("work_review_candidate_already_reviewed");
      }
      const now = this.now();
      const nextStatus: WorkCandidateStatus = input.action === "accept" ? "accepted"
        : input.action === "edit_and_accept" ? "edited_and_accepted"
          : input.action === "retype_and_accept" ? "retyped_and_accepted" : "ignored";
      const nextVersion = row.version + 1;
      this.database.prepare(`
        UPDATE wr_meeting_candidates SET status = ?, version = ?, updated_at = ?
        WHERE id = ? AND account_id = ? AND meeting_id = ? AND version = ?
      `).run(nextStatus, nextVersion, now, input.candidateId,
        input.accountId, input.meetingId, input.expectedVersion);
      let finding: WorkFindingRecord | null = null;
      if (input.action !== "ignore") {
        const findingId = this.nextId("wrf");
        const kind = input.action === "retype_and_accept"
          ? input.kind ?? (() => { throw new WorkReviewConflictError("work_review_retype_kind_required"); })()
          : row.kind;
        const title = input.action === "accept" ? row.title
          : requireText(input.title ?? row.title, "work_review_finding_title_required");
        const body = input.action === "accept" ? row.body
          : requireText(input.body ?? row.body, "work_review_finding_body_required");
        const originalStructuredData = JSON.parse(row.structured_data_json) as unknown;
        const structuredData = this.sanitizeFindingStructuredData({
          accountId: input.accountId,
          meetingId: input.meetingId,
          candidateId: input.candidateId,
          targetKind: kind,
          originalValue: originalStructuredData,
          requestedValue: input.action === "accept"
            ? originalStructuredData
            : input.structuredData ?? originalStructuredData
        });
        const editedAt = input.action === "accept" ? null : now;
        this.database.prepare(`
          INSERT INTO wr_findings (
            id, account_id, meeting_id, source_candidate_id, kind, title, body,
            structured_data_json, user_confirmed_at, user_edited_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(findingId, input.accountId, input.meetingId, input.candidateId,
          kind, title, body, JSON.stringify(structuredData), now, editedAt, now, now);
        this.database.prepare(`
          INSERT INTO wr_finding_evidence (
            account_id, meeting_id, finding_id, publication_id, position, segment_id,
            start_seconds, end_seconds, raw_speaker_label, timestamp_quality
          )
          SELECT account_id, meeting_id, ?, publication_id, position, segment_id,
                 start_seconds, end_seconds, raw_speaker_label, timestamp_quality
          FROM wr_candidate_evidence
          WHERE account_id = ? AND meeting_id = ? AND candidate_id = ?
          ORDER BY position
        `).run(findingId, input.accountId, input.meetingId, input.candidateId);
        const findingRow = this.database.prepare(`
          SELECT * FROM wr_findings WHERE id = ? AND account_id = ?
        `).get(findingId, input.accountId) as FindingRow;
        finding = findingFromRow(
          findingRow,
          this.findingEvidenceRefs(input.accountId, input.meetingId, findingId)
        );
      }
      const candidateRow = this.database.prepare(`
        SELECT * FROM wr_meeting_candidates WHERE id = ? AND account_id = ?
      `).get(input.candidateId, input.accountId) as CandidateRow;
      const candidate = candidateFromRow(
        candidateRow,
        this.candidateEvidenceRefs(input.accountId, input.meetingId, input.candidateId)
      );
      if (meeting.review_status === "not_started") {
        this.database.prepare(`
          UPDATE wr_meetings SET review_status = 'in_progress', version = version + 1,
            updated_at = ? WHERE id = ? AND account_id = ? AND review_status = 'not_started'
        `).run(now, input.meetingId, input.accountId);
      }
      const eventType = input.action === "accept" ? "candidate_confirmed"
        : input.action === "edit_and_accept" ? "candidate_edited_and_confirmed"
          : input.action === "retype_and_accept" ? "candidate_retyped_and_confirmed"
            : "candidate_ignored";
      this.database.prepare(`
        INSERT INTO wr_review_events (
          event_id, account_id, meeting_id, candidate_id, finding_id,
          operation_key, event_type, candidate_version, finding_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(this.nextId("wre"), input.accountId, input.meetingId,
        input.candidateId, finding?.id ?? null, operationKey, eventType,
        candidate.version, finding?.version ?? null, now);
      const response = { candidate, finding };
      this.database.prepare(`
        INSERT INTO wr_review_operations (
          account_id, operation_key, meeting_id, candidate_id, finding_id,
          action, request_fingerprint, response_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(input.accountId, operationKey, input.meetingId, input.candidateId,
        finding?.id ?? null, input.action, requestFingerprint, JSON.stringify(response), now);
      return { ...response, reused: false };
    });
    return run.immediate();
  }

  setSpeakerAlias(input: {
    accountId: string; meetingId: string; rawLabel: string; displayLabel: string;
    expectedVersion: number; operationKey: string;
  }) {
    const operationKey = requireText(input.operationKey, "work_review_operation_key_required");
    const requestFingerprint = digest({
      meetingId: input.meetingId, rawLabel: input.rawLabel,
      displayLabel: input.displayLabel, expectedVersion: input.expectedVersion
    });
    const run = this.database.transaction(() => {
      const replay = this.database.prepare(`
        SELECT request_fingerprint, response_json FROM wr_review_operations
        WHERE account_id = ? AND operation_key = ?
      `).get(input.accountId, operationKey) as {
        request_fingerprint: string; response_json: string;
      } | undefined;
      if (replay) {
        if (replay.request_fingerprint !== requestFingerprint) {
          throw new WorkReviewConflictError("work_review_operation_conflict");
        }
        const response = JSON.parse(replay.response_json) as {
          alias: WorkMeetingDetail["speakerAliases"][number];
        };
        return { ...response, reused: true };
      }
      this.assertLiveMeeting(input.accountId, input.meetingId);
      const publication = this.readCanonicalPublication(input.accountId, input.meetingId);
      const rawLabel = requireText(input.rawLabel, "work_review_raw_speaker_required");
      if (!publication?.segments.some((segment) => segment.speaker === rawLabel)) {
        throw new WorkReviewConflictError("work_review_speaker_not_in_transcript");
      }
      const displayLabel = requireText(input.displayLabel, "work_review_display_speaker_required");
      const existing = this.database.prepare(`
        SELECT version, created_at FROM wr_speaker_aliases
        WHERE account_id = ? AND meeting_id = ? AND raw_label = ?
      `).get(input.accountId, input.meetingId, rawLabel) as {
        version: number; created_at: string;
      } | undefined;
      if (existing && existing.version !== input.expectedVersion) {
        throw new WorkReviewVersionConflictError(existing.version);
      }
      if (!existing && input.expectedVersion !== 0) {
        throw new WorkReviewVersionConflictError(0);
      }
      const now = this.now();
      this.database.prepare(`
        INSERT INTO wr_speaker_aliases (
          account_id, meeting_id, raw_label, display_label, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(account_id, meeting_id, raw_label) DO UPDATE SET
          display_label = excluded.display_label,
          version = wr_speaker_aliases.version + 1,
          updated_at = excluded.updated_at
      `).run(input.accountId, input.meetingId, rawLabel, displayLabel, now, now);
      const alias = this.database.prepare(`
        SELECT raw_label AS rawLabel, display_label AS displayLabel, version,
               created_at AS createdAt, updated_at AS updatedAt
        FROM wr_speaker_aliases
        WHERE account_id = ? AND meeting_id = ? AND raw_label = ?
      `).get(input.accountId, input.meetingId, rawLabel) as {
        rawLabel: string; displayLabel: string; version: number;
        createdAt: string; updatedAt: string;
      };
      const response = { alias };
      this.database.prepare(`
        INSERT INTO wr_review_operations (
          account_id, operation_key, meeting_id, action,
          request_fingerprint, response_json, created_at
        ) VALUES (?, ?, ?, 'set_speaker_alias', ?, ?, ?)
      `).run(input.accountId, operationKey, input.meetingId,
        requestFingerprint, JSON.stringify(response), now);
      return { ...response, reused: false };
    });
    return run.immediate();
  }

  listSpeakerAliases(accountId: string, meetingId: string) {
    this.requireMeetingRow(accountId, meetingId);
    return this.database.prepare(`
      SELECT raw_label AS rawLabel, display_label AS displayLabel, version,
             created_at AS createdAt, updated_at AS updatedAt
      FROM wr_speaker_aliases WHERE account_id = ? AND meeting_id = ?
      ORDER BY raw_label
    `).all(accountId, meetingId) as WorkMeetingDetail["speakerAliases"];
  }

  completeReview(input: {
    accountId: string; meetingId: string; expectedVersion: number; operationKey: string;
  }) {
    const operationKey = requireText(input.operationKey, "work_review_operation_key_required");
    const requestFingerprint = digest({
      meetingId: input.meetingId, expectedVersion: input.expectedVersion,
      action: "complete_review"
    });
    const run = this.database.transaction(() => {
      const replay = this.database.prepare(`
        SELECT request_fingerprint, response_json FROM wr_review_operations
        WHERE account_id = ? AND operation_key = ?
      `).get(input.accountId, operationKey) as {
        request_fingerprint: string; response_json: string;
      } | undefined;
      if (replay) {
        if (replay.request_fingerprint !== requestFingerprint) {
          throw new WorkReviewConflictError("work_review_operation_conflict");
        }
        const response = JSON.parse(replay.response_json) as {
          meeting: WorkMeetingRecord;
        };
        return { ...response, reused: true };
      }
      const meeting = this.assertLiveMeeting(input.accountId, input.meetingId);
      if (meeting.analysis_status !== "review_ready") {
        throw new WorkReviewConflictError("work_review_not_review_ready");
      }
      if (meeting.version !== input.expectedVersion) {
        throw new WorkReviewVersionConflictError(meeting.version);
      }
      if (meeting.review_status === "completed") {
        throw new WorkReviewConflictError("work_review_already_completed");
      }
      const pending = (this.database.prepare(`
        SELECT count(*) AS count FROM wr_meeting_candidates
        WHERE account_id = ? AND meeting_id = ? AND status = 'pending_review'
      `).get(input.accountId, input.meetingId) as { count: number }).count;
      if (pending > 0) throw new WorkReviewConflictError("work_review_candidates_pending");
      const now = this.now();
      this.database.prepare(`
        UPDATE wr_meetings SET review_status = 'completed', review_completed_at = ?,
          version = version + 1, updated_at = ?
        WHERE id = ? AND account_id = ? AND review_status IN ('not_started', 'in_progress')
          AND version = ?
      `).run(now, now, input.meetingId, input.accountId, input.expectedVersion);
      this.database.prepare(`
        INSERT INTO wr_review_events (
          event_id, account_id, meeting_id, operation_key, event_type, created_at
        ) VALUES (?, ?, ?, ?, 'review_completed', ?)
      `).run(this.nextId("wre"), input.accountId, input.meetingId, operationKey, now);
      const response = {
        meeting: meetingFromRow(this.requireMeetingRow(input.accountId, input.meetingId))
      };
      this.database.prepare(`
        INSERT INTO wr_review_operations (
          account_id, operation_key, meeting_id, action,
          request_fingerprint, response_json, created_at
        ) VALUES (?, ?, ?, 'complete_review', ?, ?, ?)
      `).run(input.accountId, operationKey, input.meetingId,
        requestFingerprint, JSON.stringify(response), now);
      return { ...response, reused: false };
    });
    return run.immediate();
  }

  deleteMeeting(input: {
    accountId: string;
    meetingId: string;
    linkedTodoPolicy?: WorkMeetingLinkedTodoPolicy;
    now?: string;
  }) {
    const now = input.now ?? this.now();
    const run = this.database.transaction(() => {
      const meeting = this.requireMeetingRow(input.accountId, input.meetingId);
      const existing = this.database.prepare(`
        SELECT cleanup_status FROM wr_tombstones WHERE account_id = ? AND meeting_id = ?
      `).get(input.accountId, input.meetingId) as { cleanup_status: string } | undefined;
      if (existing) {
        return { sourceUploadId: meeting.source_upload_id, reused: true,
          filePath: this.readSourceUpload(input.accountId, input.meetingId)?.filePath ?? null,
          cleanupStatus: existing.cleanup_status,
          linkedTodoIds: [] as string[] };
      }
      const linkedTodoIds = listActiveMeetingTodoIdsWithinTransaction(
        this.database,
        input.accountId,
        input.meetingId
      );
      if (linkedTodoIds.length > 0 && !input.linkedTodoPolicy) {
        throw new WorkReviewLinkedTodosPolicyRequiredError(linkedTodoIds);
      }
      invalidateWorkWeeklySourcesWithinTransaction(this.database, {
        accountId: input.accountId,
        meetingId: input.meetingId,
        now
      });
      if (input.linkedTodoPolicy === "delete_linked_todos") {
        deleteLinkedMeetingTodosWithinTransaction(this.database, {
          accountId: input.accountId,
          meetingId: input.meetingId,
          now
        }, { idFactory: this.idFactory });
      } else if (input.linkedTodoPolicy === "detach_linked_todos") {
        detachLinkedMeetingTodosWithinTransaction(this.database, {
          accountId: input.accountId,
          meetingId: input.meetingId,
          now
        }, { idFactory: this.idFactory });
      }
      this.database.prepare(`
        DELETE FROM wr_meeting_projects WHERE account_id = ? AND meeting_id = ?
      `).run(input.accountId, input.meetingId);
      this.database.prepare(`
        DELETE FROM wr_project_operations
        WHERE account_id = ? AND target_kind = 'meeting_projects' AND target_id = ?
      `).run(input.accountId, input.meetingId);
      const sourceUpload = this.readSourceUpload(input.accountId, input.meetingId);
      this.database.prepare(`
        INSERT INTO wr_tombstones (
          account_id, meeting_id, source_upload_id, transcription_attempt_version,
          analysis_attempt_version, cleanup_status, deleted_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
      `).run(input.accountId, input.meetingId, meeting.source_upload_id,
        meeting.current_transcription_attempt, meeting.current_analysis_attempt, now);
      this.database.prepare(`
        UPDATE wr_meetings
        SET title = '已删除会议', ingestion_status = 'deleted', analysis_status = 'deleted',
            deleted_at = ?, version = version + 1, updated_at = ?,
            meeting_date = '1970-01-01', source_duration_seconds = NULL,
            canonical_publication_id = NULL, canonical_content_digest = NULL,
            canonical_segment_count = 0, transcript_ready_at = NULL,
            review_ready_at = NULL, review_completed_at = NULL, failed_at = NULL,
            error_stage = NULL, error_code = NULL
        WHERE id = ? AND account_id = ?
      `).run(now, now, input.meetingId, input.accountId);
      this.database.prepare(`
        UPDATE wr_processing_attempts
        SET state = 'deleted', lease_owner = NULL, lease_expires_at = NULL,
            completed_at = COALESCE(completed_at, ?),
            error_code = 'work_review_deleted'
        WHERE account_id = ? AND meeting_id = ? AND state = 'processing'
      `).run(now, input.accountId, input.meetingId);
      this.database.prepare(`
        UPDATE wr_input_receipts SET state = 'deleted', completed_at = COALESCE(completed_at, ?),
          error_code = 'work_review_deleted'
        WHERE account_id = ? AND meeting_id = ?
      `).run(now, input.accountId, input.meetingId);
      this.database.prepare(`DELETE FROM wr_review_events WHERE account_id = ? AND meeting_id = ?`)
        .run(input.accountId, input.meetingId);
      this.database.prepare(`DELETE FROM wr_review_operations WHERE account_id = ? AND meeting_id = ?`)
        .run(input.accountId, input.meetingId);
      this.database.prepare(`DELETE FROM wr_follow_up_operations WHERE account_id = ? AND meeting_id = ?`)
        .run(input.accountId, input.meetingId);
      this.database.prepare(`DELETE FROM wr_follow_up_drafts WHERE account_id = ? AND meeting_id = ?`)
        .run(input.accountId, input.meetingId);
      this.database.prepare(`DELETE FROM wr_processing_operations WHERE account_id = ? AND meeting_id = ?`)
        .run(input.accountId, input.meetingId);
      this.database.prepare(`DELETE FROM wr_speaker_aliases WHERE account_id = ? AND meeting_id = ?`)
        .run(input.accountId, input.meetingId);
      this.database.prepare(`DELETE FROM wr_meeting_candidates WHERE account_id = ? AND meeting_id = ?`)
        .run(input.accountId, input.meetingId);
      this.database.prepare(`DELETE FROM wr_canonical_publications WHERE account_id = ? AND meeting_id = ?`)
        .run(input.accountId, input.meetingId);
      return {
        sourceUploadId: meeting.source_upload_id,
        filePath: sourceUpload?.filePath ?? null,
        reused: false,
        cleanupStatus: "pending",
        linkedTodoIds
      };
    });
    return run.immediate();
  }

  markDeletionCleanup(input: {
    accountId: string; meetingId: string; status: "completed" | "failed";
    errorCode?: string | null; now?: string;
  }) {
    const now = input.now ?? this.now();
    const run = this.database.transaction(() => {
      const tombstone = this.database.prepare(`
        SELECT cleanup_status FROM wr_tombstones
        WHERE account_id = ? AND meeting_id = ?
      `).get(input.accountId, input.meetingId) as { cleanup_status: string } | undefined;
      if (!tombstone) throw new WorkReviewNotFoundError();
      if (tombstone.cleanup_status === "completed") return "completed" as const;
      if (input.status === "completed") {
        this.database.prepare(`
          DELETE FROM wr_source_uploads
          WHERE account_id = ? AND meeting_id = ?
        `).run(input.accountId, input.meetingId);
      }
      const updated = this.database.prepare(`
        UPDATE wr_tombstones
        SET cleanup_status = ?, cleanup_error_code = ?, cleanup_completed_at = ?
        WHERE account_id = ? AND meeting_id = ? AND cleanup_status <> 'completed'
      `).run(input.status, input.errorCode ?? null, now, input.accountId, input.meetingId);
      if (updated.changes !== 1) {
        throw new WorkReviewConflictError("work_review_cleanup_state_conflict");
      }
      return input.status;
    });
    return run.immediate();
  }

  readActiveProcessingLease(accountId: string, meetingId: string) {
    const row = this.database.prepare(`
      SELECT stage, lease_expires_at FROM wr_processing_attempts
      WHERE account_id = ? AND meeting_id = ? AND state = 'processing'
      ORDER BY attempt_version DESC LIMIT 1
    `).get(accountId, meetingId) as {
      stage: WorkProcessingStage;
      lease_expires_at: string;
    } | undefined;
    return row ? { stage: row.stage, leaseExpiresAt: row.lease_expires_at } : null;
  }

  getMeetingDetail(accountId: string, meetingId: string): WorkMeetingDetail {
    const meeting = this.getMeeting(accountId, meetingId);
    if (meeting.ingestionStatus === "deleted") {
      throw new WorkReviewConflictError("work_review_tombstoned");
    }
    return {
      meeting,
      activeProcessingLease: this.readActiveProcessingLease(accountId, meetingId),
      transcript: this.readCanonicalPublication(accountId, meetingId),
      candidates: this.listCandidates(accountId, meetingId),
      claims: this.listAtomicClaims(accountId, meetingId),
      evaluations: this.listClaimEvaluations(accountId, meetingId),
      findings: this.listFindings(accountId, meetingId),
      speakerAliases: this.listSpeakerAliases(accountId, meetingId)
    };
  }
}

export function createWorkReviewRepository(
  database: Database.Database, options: RepositoryOptions = {}
) {
  return new WorkReviewRepository(database, options);
}
