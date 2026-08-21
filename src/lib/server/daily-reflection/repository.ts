import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";

import {
  CandidateSchema,
  CandidateKindV2Schema,
  CandidateV2Schema,
  CandidateAdmissionResultSchema,
  CandidateStatusSchema,
  CandidateUserTextInputSchema,
  CreateDailyReflectionInputSchema,
  CreateDailyReflectionV2InputSchema,
  DAILY_REFLECTION_PROCESSING_PLAN_VERSION,
  DAILY_REFLECTION_PROCESSING_PLAN_V2_VERSION,
  DailyReflectionAdmissionOperationSchema,
  DailyReflectionIdSchema,
  DailyReflectionSchema,
  DailyReflectionStatusSchema,
  PendingCandidateInputSchema,
  PendingCandidateV2InputSchema,
  ProcessingProfileSchema,
  ProcessingPlanSchema,
  ProcessingPlanV2Schema,
  ReflectionConfirmationSchema,
  ReflectionConfirmationV2Schema,
  DailyReflectionSaveIntentSchema,
  DailyReflectionV2InputSchema,
  DailyReflectionV2InputAdapterSchema,
  ReviewPolicySchema,
  legacyCandidateKindForV2,
  type Candidate,
  type CandidateAdmissionResult,
  type CreateDailyReflectionInput,
  type CreateDailyReflectionV2Input,
  type DailyReflectionAdmissionOperation,
  type DailyReflection,
  type DailyReflectionStatus,
  type DailyReflectionV2InputAdapter,
  type PendingCandidateInput,
  type PendingCandidateV2Input,
  type ProcessingProfile,
  type ProcessingPlan,
  type ReflectionConfirmation,
  type ReflectionConfirmationCandidateSnapshot,
  type ReflectionConfirmationCandidateSnapshotV2,
  type ReflectionConfirmationV2,
  type ReviewPolicy
} from "@/lib/domain/daily-reflection";
import {
  DAILY_REFLECTION_FULL_CANDIDATE_LIMIT,
  DAILY_REFLECTION_QUICK_CANDIDATE_LIMIT
} from "@/lib/domain/daily-reflection-duration";

import { parseDailyReflectionCanonicalTranscript } from "./canonical-transcript";

import {
  assertFailedDailyReflectionRetry,
  assertDailyReflectionTransition,
  isDailyReflectionTombstone,
  type DailyReflectionRetryStatus
} from "./state-machine";
import {
  buildDailyReflectionUploadId,
  isDailyReflectionUploadRecord
} from "./upload-record";
import { buildDailyReflectionProductJobId } from "./job-store";

type ReflectionRow = {
  id: string;
  account_id: string;
  upload_id: string | null;
  input_method: "file_upload" | "browser_recording";
  source_origin:
    | "direct_conversation"
    | "user_reflection"
    | "manual_note"
    | "ai_derived_observation"
    | "unknown"
    | "legacy_unknown";
  processing_profile: "full_recording" | "quick_reflection";
  ingestion_context: "daily_reflection";
  status: DailyReflectionStatus;
  review_status: "confirmation_ready" | "admitting" | "completed" | "admission_failed" | null;
  version: number;
  idempotency_key: string | null;
  create_fingerprint: string;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

type ProcessingPlanRow = {
  reflection_id: string;
  upload_id: string;
  plan_version: 1;
  input_method: ReflectionRow["input_method"];
  source_origin: ReflectionRow["source_origin"];
  processing_profile: ReflectionRow["processing_profile"];
  ingestion_context: "standard_upload" | "date_companion" | "daily_reflection";
  review_policy: ReviewPolicy;
};

type CandidateRow = {
  id: string;
  reflection_id: string;
  ordinal: number;
  proposed_text: string;
  user_text: string | null;
  status: "pending" | "kept" | "excluded";
  candidate_type: "event" | "commitment" | "question" | "preference" | "summary";
  subject_person_id: string | null;
  subject_confirmed: 0 | 1;
  version: number;
  created_at: string;
  updated_at: string;
};

type ProcessingPlanV2Row = {
  account_id: string;
  reflection_id: string;
  plan_version: 2;
  input_adapter: "file_picker" | "browser_recorder" | "toy_sync";
  capture_purpose: "inspiration_capture";
  effective_duration_ms: number;
  duration_source: "server_ffprobe";
  candidate_limit: number;
  created_at: string;
};

type CandidateV2MetadataRow = {
  candidate_kind: "insight" | "open_question" | "decision" | "user_action";
  evidence_ids_json: string;
  confidence: number;
  caution: string;
  action_claimed: 0 | 1;
};

type ReflectionV2InputRow = {
  account_id: string;
  reflection_id: string;
  operation_key: string;
  contract_fingerprint: string;
  input_adapter: "file_picker" | "browser_recorder" | "toy_sync";
  source_origin: "user_reflection" | "direct_conversation";
  capture_purpose: "inspiration_capture";
  recording_date: string;
  created_at: string;
  updated_at: string;
};

type InputReceiptV2Row = {
  account_id: string;
  reflection_id: string;
  operation_key: string;
  capture_purpose: "inspiration_capture";
  content_hash: string;
  upload_id: string;
  job_id: string;
  created_at: string;
};

export type DailyReflectionInputReceiptV2 = {
  accountId: string;
  reflectionId: string;
  operationKey: string;
  capturePurpose: "inspiration_capture";
  contentHash: string;
  uploadId: string;
  jobId: string;
  createdAt: string;
};

type ConfirmationRow = {
  id: string;
  account_id: string;
  reflection_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  confirmation_fingerprint: string;
  source_origin: ReflectionRow["source_origin"];
  input_method: ReflectionRow["input_method"];
  processing_profile: ReflectionRow["processing_profile"];
  candidate_snapshots_json: string;
  contract_version: 1 | 2;
  save_intent: "recap_only" | "retain_selected" | null;
  operation_key: string | null;
  input_adapter: "file_picker" | "browser_recorder" | "toy_sync" | null;
  capture_purpose: "inspiration_capture" | null;
  recording_date: string | null;
  created_at: string;
};

type AdmissionOperationRow = {
  id: string;
  account_id: string;
  reflection_id: string;
  confirmation_id: string;
  status: "confirmation_ready" | "admitting" | "completed" | "admission_failed" | "delete_requested";
  admitted_count: number;
  rejected_count: number;
  excluded_count: number;
  error_code: string | null;
  attempt_version: number;
  lease_owner: string | null;
  lease_until: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type AdmissionReceiptRow = {
  candidate_id: string;
  status: "admitted" | "rejected" | "already_admitted" | "retryable_error";
  memory_id: string | null;
  reason_code: string | null;
  error_code: string | null;
  operation_key: string;
  updated_at: string;
};

type CandidateRevocationOperationRow = {
  id: string;
  account_id: string;
  reflection_id: string;
  confirmation_id: string;
  candidate_id: string;
  operation_key: string;
  idempotency_key: string;
  request_fingerprint: string;
  admission_status: "admitted" | "already_admitted" | "rejected" | "no_receipt";
  memory_id: string | null;
  status: "ready" | "revoking" | "completed" | "failed";
  attempt_version: number;
  lease_owner: string | null;
  lease_until: string | null;
  error_code: string | null;
  index_refresh_status: "not_required" | "pending" | "enqueued" | "failed";
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type CandidateRevocationReceiptRow = {
  account_id: string;
  operation_id: string;
  reflection_id: string;
  confirmation_id: string;
  candidate_id: string;
  outcome: "revoked" | "no_long_term_object";
  memory_id: string | null;
  removed_memory_evidence_count: number;
  removed_person_source_count: number;
  created_at: string;
};

export type DailyReflectionCandidateRevocationOperation = {
  id: string;
  accountId: string;
  reflectionId: string;
  confirmationId: string;
  candidateId: string;
  operationKey: string;
  idempotencyKey: string;
  requestFingerprint: string;
  admissionStatus: CandidateRevocationOperationRow["admission_status"];
  memoryId: string | null;
  status: CandidateRevocationOperationRow["status"];
  attemptVersion: number;
  errorCode: string | null;
  indexRefreshStatus: CandidateRevocationOperationRow["index_refresh_status"];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type DailyReflectionCandidateRevocationReceipt = {
  accountId: string;
  operationId: string;
  reflectionId: string;
  confirmationId: string;
  candidateId: string;
  outcome: CandidateRevocationReceiptRow["outcome"];
  memoryId: string | null;
  removedMemoryEvidenceCount: number;
  removedPersonSourceCount: number;
  createdAt: string;
};

const TransitionInputSchema = z.object({
  accountId: DailyReflectionIdSchema,
  reflectionId: DailyReflectionIdSchema,
  expectedVersion: z.number().int().nonnegative(),
  status: DailyReflectionStatusSchema,
  errorCode: z.string().trim().min(1).max(256).nullable().optional(),
  errorMessage: z.string().trim().min(1).max(4_000).nullable().optional(),
  leaseOwner: z.string().trim().min(1).max(512).optional(),
  attemptVersion: z.number().int().positive().optional()
}).strict().refine(
  (input) => Boolean(input.leaseOwner) === (input.attemptVersion !== undefined),
  { message: "leaseOwner and attemptVersion must be provided together" }
);

const BindUploadInputSchema = z.object({
  accountId: DailyReflectionIdSchema,
  reflectionId: DailyReflectionIdSchema,
  expectedVersion: z.number().int().nonnegative(),
  uploadId: DailyReflectionIdSchema,
  processingProfile: ProcessingProfileSchema.optional(),
  planVersion: z.literal(DAILY_REFLECTION_PROCESSING_PLAN_VERSION).optional(),
  reviewPolicy: ReviewPolicySchema.optional(),
  leaseOwner: z.string().trim().min(1).max(512).optional(),
  attemptVersion: z.number().int().positive().optional()
}).strict().refine(
  (input) => Boolean(input.leaseOwner) === (input.attemptVersion !== undefined),
  { message: "leaseOwner and attemptVersion must be provided together" }
);

const BindUploadV2InputSchema = z.object({
  accountId: DailyReflectionIdSchema,
  reflectionId: DailyReflectionIdSchema,
  expectedVersion: z.number().int().nonnegative(),
  uploadId: DailyReflectionIdSchema,
  inputAdapter: DailyReflectionV2InputAdapterSchema,
  processingProfile: ProcessingProfileSchema,
  effectiveDurationMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  durationSource: z.literal("server_ffprobe"),
  candidateLimit: z.number().int().min(1).max(DAILY_REFLECTION_FULL_CANDIDATE_LIMIT),
  leaseOwner: z.string().trim().min(1).max(512),
  attemptVersion: z.number().int().positive()
}).strict().superRefine((input, context) => {
  if (
    input.processingProfile === "quick_reflection"
    && input.candidateLimit > DAILY_REFLECTION_QUICK_CANDIDATE_LIMIT
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["candidateLimit"],
      message: "quick_reflection candidateLimit cannot exceed 3"
    });
  }
});

const RetryFailedInputSchema = z.object({
  accountId: DailyReflectionIdSchema,
  reflectionId: DailyReflectionIdSchema,
  expectedVersion: z.number().int().nonnegative(),
  resumeStatus: z.enum(["uploading", "transcribing", "extracting"])
}).strict();

const SaveCandidatesInputSchema = z.object({
  accountId: DailyReflectionIdSchema,
  reflectionId: DailyReflectionIdSchema,
  expectedVersion: z.number().int().nonnegative(),
  candidates: z.array(PendingCandidateInputSchema).min(1),
  leaseOwner: z.string().trim().min(1).max(512).optional(),
  attemptVersion: z.number().int().positive().optional()
}).strict().superRefine((input, context) => {
  if (Boolean(input.leaseOwner) !== (input.attemptVersion !== undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "leaseOwner and attemptVersion must be provided together"
    });
  }
  const ordinals = input.candidates.map((candidate) => candidate.ordinal);
  if (new Set(ordinals).size !== ordinals.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["candidates"],
      message: "candidate ordinals must be unique"
    });
  }
  const explicitIds = input.candidates.flatMap((candidate) => candidate.id ? [candidate.id] : []);
  if (new Set(explicitIds).size !== explicitIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["candidates"],
      message: "candidate ids must be unique"
    });
  }
});

const SaveCandidatesV2InputSchema = z.object({
  accountId: DailyReflectionIdSchema,
  reflectionId: DailyReflectionIdSchema,
  expectedVersion: z.number().int().nonnegative(),
  candidates: z.array(PendingCandidateV2InputSchema)
    .min(1)
    .max(DAILY_REFLECTION_FULL_CANDIDATE_LIMIT),
  leaseOwner: z.string().trim().min(1).max(512).optional(),
  attemptVersion: z.number().int().positive().optional()
}).strict().superRefine((input, context) => {
  if (Boolean(input.leaseOwner) !== (input.attemptVersion !== undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "leaseOwner and attemptVersion must be provided together"
    });
  }
  const ordinals = input.candidates.map((candidate) => candidate.ordinal);
  const explicitIds = input.candidates.flatMap((candidate) => candidate.id ? [candidate.id] : []);
  if (new Set(ordinals).size !== ordinals.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["candidates"], message: "candidate ordinals must be unique" });
  }
  if (new Set(explicitIds).size !== explicitIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["candidates"], message: "candidate ids must be unique" });
  }
});

const CandidateDecisionInputSchema = z.object({
  candidateId: DailyReflectionIdSchema,
  status: CandidateStatusSchema,
  userText: CandidateUserTextInputSchema,
  subjectPersonId: DailyReflectionIdSchema.nullable(),
  actionClaimed: z.boolean().optional()
}).strict().superRefine((candidate, context) => {
  if (candidate.status !== "kept" && candidate.subjectPersonId !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subjectPersonId"],
      message: "only kept candidates may select a Subject"
    });
  }
});

const UpdateCandidateDecisionsInputSchema = z.object({
  accountId: DailyReflectionIdSchema,
  reflectionId: DailyReflectionIdSchema,
  expectedVersion: z.number().int().nonnegative(),
  candidates: z.array(CandidateDecisionInputSchema).min(1)
}).strict().superRefine((input, context) => {
  const ids = input.candidates.map((candidate) => candidate.candidateId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["candidates"],
      message: "candidate ids must be unique"
    });
  }
});

const CreateManualCandidateV2InputSchema = z.object({
  accountId: DailyReflectionIdSchema,
  reflectionId: DailyReflectionIdSchema,
  expectedVersion: z.number().int().nonnegative(),
  candidateKind: CandidateKindV2Schema,
  proposedText: z.string().trim().min(1).max(20_000),
  evidenceIds: z.array(DailyReflectionIdSchema).max(64),
  confidence: z.number().min(0).max(1),
  caution: z.string().trim().min(1).max(4_000),
  actionClaimed: z.boolean()
}).strict().superRefine((candidate, context) => {
  if (new Set(candidate.evidenceIds).size !== candidate.evidenceIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidenceIds"],
      message: "evidenceIds must be unique"
    });
  }
  if (candidate.candidateKind !== "user_action" && candidate.actionClaimed) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["actionClaimed"],
      message: "only user_action may claim an action"
    });
  }
  if (candidate.actionClaimed && candidate.evidenceIds.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidenceIds"],
      message: "claimed actions require canonical Evidence"
    });
  }
});

const ExcludeCandidateV2InputSchema = z.object({
  accountId: DailyReflectionIdSchema,
  reflectionId: DailyReflectionIdSchema,
  candidateId: DailyReflectionIdSchema,
  expectedVersion: z.number().int().nonnegative()
}).strict();

const FinalizeReflectionInputSchema = z.object({
  accountId: DailyReflectionIdSchema,
  reflectionId: DailyReflectionIdSchema,
  expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: z.string().trim().min(1).max(512)
}).strict();

const FinalizeReflectionV2InputSchema = z.object({
  accountId: DailyReflectionIdSchema,
  reflectionId: DailyReflectionIdSchema,
  expectedVersion: z.number().int().nonnegative(),
  operationKey: z.string().trim().min(1).max(512),
  saveIntent: DailyReflectionSaveIntentSchema
}).strict();

export class DailyReflectionNotFoundError extends Error {
  readonly code = "daily_reflection_not_found";

  constructor() {
    super("Daily Reflection not found");
  }
}

export class DailyReflectionVersionConflictError extends Error {
  readonly code = "version_conflict";

  constructor(readonly currentVersion: number) {
    super("Daily Reflection resource version is stale");
  }
}

export class DailyReflectionConflictError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export class DailyReflectionLeaseLostError extends Error {
  readonly code = "daily_reflection_lease_lost";

  constructor() {
    super("Daily Reflection execution lease is no longer owned by this attempt");
  }
}

export type DailyReflectionExecutionFence = {
  leaseOwner: string;
  attemptVersion: number;
  leaseUntil: string;
};

export type DailyReflectionAdmissionExecutionFence = {
  leaseOwner: string;
  leaseUntil: string;
  attemptVersion: number;
};

export type DailyReflectionProvisionalUploadOwnership = {
  accountId: string;
  reflectionId: string;
  uploadId: string;
  uploadFingerprint: string;
  attemptVersion: number;
  leaseOwner: string | null;
  leaseUntil: string | null;
  status: DailyReflectionStatus;
  version: number;
  updatedAt: string;
};

export type DailyReflectionPublishedAssetKind = "upload" | "segments";

export type DailyReflectionRepositoryOptions = {
  now?: () => string;
  idFactory?: () => string;
};

function reflectionFromRow(row: ReflectionRow): DailyReflection {
  return DailyReflectionSchema.parse({
    id: row.id,
    accountId: row.account_id,
    uploadId: row.upload_id,
    inputMethod: row.input_method,
    sourceOrigin: row.source_origin,
    processingProfile: row.processing_profile,
    ingestionContext: row.ingestion_context,
    status: row.review_status ?? row.status,
    version: row.version,
    idempotencyKey: row.idempotency_key,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function confirmationFromRow(row: ConfirmationRow): ReflectionConfirmation {
  if (row.contract_version === 2) {
    return ReflectionConfirmationSchema.parse({
      contractVersion: 2,
      id: row.id,
      reflectionId: row.reflection_id,
      accountId: row.account_id,
      fingerprint: row.confirmation_fingerprint,
      requestFingerprint: row.request_fingerprint,
      idempotencyKey: row.idempotency_key,
      operationKey: row.operation_key,
      sourceOrigin: row.source_origin,
      inputMethod: row.input_method,
      processingProfile: row.processing_profile,
      inputAdapter: row.input_adapter,
      capturePurpose: row.capture_purpose,
      recordingDate: row.recording_date,
      saveIntent: row.save_intent,
      candidateSnapshots: JSON.parse(row.candidate_snapshots_json) as unknown,
      createdAt: row.created_at
    });
  }
  return ReflectionConfirmationSchema.parse({
    id: row.id,
    reflectionId: row.reflection_id,
    accountId: row.account_id,
    fingerprint: row.confirmation_fingerprint,
    requestFingerprint: row.request_fingerprint,
    idempotencyKey: row.idempotency_key,
    sourceOrigin: row.source_origin,
    inputMethod: row.input_method,
    processingProfile: row.processing_profile,
    candidateSnapshots: JSON.parse(row.candidate_snapshots_json) as unknown,
    createdAt: row.created_at
  });
}

function admissionOperationFromRow(row: AdmissionOperationRow): DailyReflectionAdmissionOperation {
  return DailyReflectionAdmissionOperationSchema.parse({
    id: row.id,
    reflectionId: row.reflection_id,
    confirmationId: row.confirmation_id,
    accountId: row.account_id,
    status: row.status,
    admittedCount: row.admitted_count,
    rejectedCount: row.rejected_count,
    excludedCount: row.excluded_count,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  });
}

function admissionReceiptFromRow(row: AdmissionReceiptRow): CandidateAdmissionResult {
  return CandidateAdmissionResultSchema.parse({
    candidateId: row.candidate_id,
    status: row.status,
    memoryId: row.memory_id,
    reasonCode: row.reason_code,
    errorCode: row.error_code,
    operationKey: row.operation_key,
    updatedAt: row.updated_at
  });
}

function candidateRevocationOperationFromRow(
  row: CandidateRevocationOperationRow
): DailyReflectionCandidateRevocationOperation {
  return {
    id: row.id,
    accountId: row.account_id,
    reflectionId: row.reflection_id,
    confirmationId: row.confirmation_id,
    candidateId: row.candidate_id,
    operationKey: row.operation_key,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    admissionStatus: row.admission_status,
    memoryId: row.memory_id,
    status: row.status,
    attemptVersion: row.attempt_version,
    errorCode: row.error_code,
    indexRefreshStatus: row.index_refresh_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

function candidateRevocationReceiptFromRow(
  row: CandidateRevocationReceiptRow
): DailyReflectionCandidateRevocationReceipt {
  return {
    accountId: row.account_id,
    operationId: row.operation_id,
    reflectionId: row.reflection_id,
    confirmationId: row.confirmation_id,
    candidateId: row.candidate_id,
    outcome: row.outcome,
    memoryId: row.memory_id,
    removedMemoryEvidenceCount: row.removed_memory_evidence_count,
    removedPersonSourceCount: row.removed_person_source_count,
    createdAt: row.created_at
  };
}

function planFromRow(row: ProcessingPlanRow): ProcessingPlan {
  return ProcessingPlanSchema.parse({
    planVersion: row.plan_version,
    reflectionId: row.reflection_id,
    uploadId: row.upload_id,
    inputMethod: row.input_method,
    sourceOrigin: row.source_origin,
    processingProfile: row.processing_profile,
    ingestionContext: row.ingestion_context,
    reviewPolicy: row.review_policy
  });
}

function createFingerprint(input: CreateDailyReflectionInput) {
  return createHash("sha256").update(JSON.stringify({
    uploadId: input.uploadId,
    inputMethod: input.inputMethod,
    sourceOrigin: input.sourceOrigin,
    processingProfile: input.processingProfile,
    ingestionContext: input.ingestionContext,
    planVersion: input.planVersion ?? DAILY_REFLECTION_PROCESSING_PLAN_VERSION,
    reviewPolicy: input.reviewPolicy ?? "required"
  })).digest("hex");
}

function stableFingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function planV2FromRows(
  plan: ProcessingPlanRow,
  extension: ProcessingPlanV2Row
): ProcessingPlan {
  return ProcessingPlanV2Schema.parse({
    planVersion: extension.plan_version,
    reflectionId: plan.reflection_id,
    uploadId: plan.upload_id,
    inputMethod: plan.input_method,
    sourceOrigin: plan.source_origin,
    processingProfile: plan.processing_profile,
    ingestionContext: plan.ingestion_context,
    reviewPolicy: plan.review_policy,
    inputAdapter: extension.input_adapter,
    capturePurpose: extension.capture_purpose,
    effectiveDurationMs: extension.effective_duration_ms,
    durationSource: extension.duration_source,
    candidateLimit: extension.candidate_limit
  });
}

function reflectionV2InputFromRow(row: ReflectionV2InputRow) {
  return DailyReflectionV2InputSchema.parse({
    operationKey: row.operation_key,
    inputAdapter: row.input_adapter,
    sourceOrigin: row.source_origin,
    capturePurpose: row.capture_purpose,
    recordingDate: row.recording_date
  });
}

function inputReceiptV2FromRow(row: InputReceiptV2Row): DailyReflectionInputReceiptV2 {
  return {
    accountId: row.account_id,
    reflectionId: row.reflection_id,
    operationKey: row.operation_key,
    capturePurpose: row.capture_purpose,
    contentHash: row.content_hash,
    uploadId: row.upload_id,
    jobId: row.job_id,
    createdAt: row.created_at
  };
}

export class DailyReflectionRepository {
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(
    private readonly database: Database.Database,
    options: DailyReflectionRepositoryOptions = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  private findReflectionRow(accountId: string, reflectionId: string) {
    return this.database.prepare(`
      SELECT id, account_id, upload_id, input_method, source_origin,
             processing_profile, ingestion_context, status, review_status, version,
             idempotency_key, create_fingerprint, error_code, error_message,
             created_at, updated_at
      FROM dr_reflections
      WHERE id = ? AND account_id = ?
    `).get(reflectionId, accountId) as ReflectionRow | undefined;
  }

  private requireReflectionRow(accountId: string, reflectionId: string) {
    const row = this.findReflectionRow(accountId, reflectionId);
    if (!row) throw new DailyReflectionNotFoundError();
    return row;
  }

  private leaseRow(accountId: string, reflectionId: string) {
    return this.database.prepare(`
      SELECT lease_owner, lease_until, attempt_version
      FROM dr_reflections
      WHERE id = ? AND account_id = ?
    `).get(reflectionId, accountId) as {
      lease_owner: string | null;
      lease_until: string | null;
      attempt_version: number;
    } | undefined;
  }

  private assertLeaseFence(input: {
    accountId: string;
    reflectionId: string;
    leaseOwner?: string;
    attemptVersion?: number;
    now?: string;
  }) {
    if (!input.leaseOwner || input.attemptVersion === undefined) return;
    const lease = this.leaseRow(input.accountId, input.reflectionId);
    const now = input.now ?? this.now();
    if (
      !lease
      || lease.lease_owner !== input.leaseOwner
      || lease.attempt_version !== input.attemptVersion
      || !lease.lease_until
      || lease.lease_until <= now
    ) {
      throw new DailyReflectionLeaseLostError();
    }
  }

  private findPlanRow(accountId: string, reflectionId: string) {
    return this.database.prepare(`
      SELECT reflection_id, upload_id, plan_version, input_method,
             source_origin, processing_profile, ingestion_context, review_policy
      FROM dr_processing_plans
      WHERE reflection_id = ? AND account_id = ?
    `).get(reflectionId, accountId) as ProcessingPlanRow | undefined;
  }

  private findPlanV2Row(accountId: string, reflectionId: string) {
    return this.database.prepare(`
      SELECT account_id, reflection_id, plan_version, input_adapter,
             capture_purpose, effective_duration_ms, duration_source,
             candidate_limit, created_at
      FROM dr_processing_plans_v2
      WHERE account_id = ? AND reflection_id = ?
    `).get(accountId, reflectionId) as ProcessingPlanV2Row | undefined;
  }

  private findV2InputRow(accountId: string, reflectionId: string) {
    return this.database.prepare(`
      SELECT account_id, reflection_id, operation_key, contract_fingerprint,
             input_adapter, source_origin, capture_purpose, recording_date,
             created_at, updated_at
      FROM dr_v2_reflection_inputs
      WHERE account_id = ? AND reflection_id = ?
    `).get(accountId, reflectionId) as ReflectionV2InputRow | undefined;
  }

  private findInputReceiptV2Row(accountId: string, operationKey: string) {
    return this.database.prepare(`
      SELECT account_id, reflection_id, operation_key, capture_purpose,
             content_hash, upload_id, job_id, created_at
      FROM dr_v2_input_receipts
      WHERE account_id = ? AND operation_key = ?
    `).get(accountId, operationKey) as InputReceiptV2Row | undefined;
  }

  private ensureInputReceiptV2(input: {
    accountId: string;
    reflectionId: string;
    operationKey: string;
    capturePurpose: "inspiration_capture";
    contentHash?: string;
  }) {
    if (!input.contentHash) return null;
    const uploadId = buildDailyReflectionUploadId(input.reflectionId);
    const jobId = buildDailyReflectionProductJobId(input);
    const existing = this.findInputReceiptV2Row(input.accountId, input.operationKey);
    if (existing) {
      if (
        existing.reflection_id !== input.reflectionId
        || existing.capture_purpose !== input.capturePurpose
        || existing.content_hash !== input.contentHash
        || existing.upload_id !== uploadId
        || existing.job_id !== jobId
      ) {
        throw new DailyReflectionConflictError("daily_reflection_idempotency_conflict");
      }
      return inputReceiptV2FromRow(existing);
    }
    const now = this.now();
    this.database.prepare(`
      INSERT INTO dr_v2_input_receipts (
        account_id, reflection_id, operation_key, capture_purpose,
        content_hash, upload_id, job_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.accountId,
      input.reflectionId,
      input.operationKey,
      input.capturePurpose,
      input.contentHash,
      uploadId,
      jobId,
      now
    );
    return inputReceiptV2FromRow(
      this.findInputReceiptV2Row(input.accountId, input.operationKey)!
    );
  }

  private candidateFromRow(accountId: string, row: CandidateRow) {
    const sources = this.database.prepare(`
      SELECT source_segment_id
      FROM dr_candidate_sources
      WHERE account_id = ? AND candidate_id = ?
      ORDER BY position
    `).all(accountId, row.id) as Array<{ source_segment_id: string }>;
    const v2 = this.database.prepare(`
      SELECT candidate_kind, evidence_ids_json, confidence, caution, action_claimed
      FROM dr_candidate_v2_metadata
      WHERE account_id = ? AND reflection_id = ? AND candidate_id = ?
    `).get(accountId, row.reflection_id, row.id) as CandidateV2MetadataRow | undefined;
    if (v2) {
      return CandidateV2Schema.parse({
        contractVersion: 2,
        id: row.id,
        reflectionId: row.reflection_id,
        ordinal: row.ordinal,
        proposedText: row.proposed_text,
        userText: row.user_text,
        status: row.status,
        candidateKind: v2.candidate_kind,
        candidateType: row.candidate_type,
        evidenceIds: JSON.parse(v2.evidence_ids_json) as unknown,
        sourceSegmentIds: sources.map((source) => source.source_segment_id),
        confidence: v2.confidence,
        caution: v2.caution,
        actionClaimed: v2.action_claimed === 1,
        subjectPersonId: null,
        subjectConfirmed: false,
        version: row.version,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      });
    }
    return CandidateSchema.parse({
      id: row.id,
      reflectionId: row.reflection_id,
      ordinal: row.ordinal,
      proposedText: row.proposed_text,
      userText: row.user_text,
      status: row.status,
      candidateType: row.candidate_type,
      sourceSegmentIds: sources.map((source) => source.source_segment_id),
      subjectPersonId: row.subject_person_id,
      subjectConfirmed: row.subject_confirmed === 1,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }

  private listCandidateRows(accountId: string, reflectionId: string) {
    return this.database.prepare(`
      SELECT id, reflection_id, ordinal, proposed_text, user_text, status,
             candidate_type, subject_person_id, subject_confirmed, version,
             created_at, updated_at
      FROM dr_candidates
      WHERE account_id = ? AND reflection_id = ?
      ORDER BY ordinal, id
    `).all(accountId, reflectionId) as CandidateRow[];
  }

  private findAdmissionOperationRow(accountId: string, reflectionId: string) {
    return this.database.prepare(`
      SELECT * FROM dr_admission_operations
      WHERE account_id = ? AND reflection_id = ?
    `).get(accountId, reflectionId) as AdmissionOperationRow | undefined;
  }

  private findCandidateRevocationOperationRow(
    accountId: string,
    reflectionId: string,
    candidateId: string
  ) {
    return this.database.prepare(`
      SELECT * FROM dr_candidate_revocation_operations
      WHERE account_id = ? AND reflection_id = ? AND candidate_id = ?
    `).get(accountId, reflectionId, candidateId) as
      CandidateRevocationOperationRow | undefined;
  }

  private assertCandidateRevocationFence(input: {
    accountId: string;
    reflectionId: string;
    candidateId: string;
    leaseOwner: string;
    attemptVersion: number;
    now: string;
  }) {
    const operation = this.findCandidateRevocationOperationRow(
      input.accountId,
      input.reflectionId,
      input.candidateId
    );
    if (
      !operation
      || operation.status !== "revoking"
      || operation.lease_owner !== input.leaseOwner
      || operation.attempt_version !== input.attemptVersion
      || !operation.lease_until
      || operation.lease_until <= input.now
    ) {
      throw new DailyReflectionConflictError(
        "daily_reflection_candidate_revocation_lease_lost"
      );
    }
    return operation;
  }

  private assertAdmissionFence(input: {
    accountId: string;
    reflectionId: string;
    leaseOwner: string;
    attemptVersion: number;
    now: string;
  }) {
    const operation = this.findAdmissionOperationRow(
      input.accountId,
      input.reflectionId
    );
    if (
      !operation
      || operation.status !== "admitting"
      || operation.lease_owner !== input.leaseOwner
      || operation.attempt_version !== input.attemptVersion
      || !operation.lease_until
      || operation.lease_until <= input.now
    ) {
      throw new DailyReflectionConflictError(
        "daily_reflection_admission_lease_lost"
      );
    }
    return operation;
  }

  createReflection(rawInput: CreateDailyReflectionInput) {
    const input = CreateDailyReflectionInputSchema.parse(rawInput);
    if (input.processingProfile !== "full_recording") {
      throw new DailyReflectionConflictError(
        input.inputMethod === "file_upload"
          ? "daily_reflection_file_upload_requires_full_recording"
          : "daily_reflection_browser_profile_requires_authoritative_duration"
      );
    }
    if (input.inputMethod === "browser_recording" && input.uploadId !== null) {
      throw new DailyReflectionConflictError(
        "daily_reflection_browser_plan_requires_authoritative_duration"
      );
    }
    const idempotencyKey = input.idempotencyKey ?? null;
    const fingerprint = createFingerprint(input);
    const run = this.database.transaction(() => {
      if (idempotencyKey !== null) {
        const existing = this.database.prepare(`
          SELECT id, create_fingerprint
          FROM dr_reflections
          WHERE account_id = ? AND idempotency_key = ?
        `).get(input.accountId, idempotencyKey) as {
          id: string;
          create_fingerprint: string;
        } | undefined;
        if (existing) {
          if (existing.create_fingerprint !== fingerprint) {
            throw new DailyReflectionConflictError("daily_reflection_idempotency_conflict");
          }
          return {
            reflection: reflectionFromRow(
              this.requireReflectionRow(input.accountId, existing.id)
            ),
            processingPlan: this.getProcessingPlan(input.accountId, existing.id),
            reused: true
          };
        }
      }

      if (input.uploadId !== null) {
        const uploadOwner = this.database.prepare(`
          SELECT id FROM dr_reflections
          WHERE account_id = ? AND upload_id = ?
        `).get(input.accountId, input.uploadId) as { id: string } | undefined;
        if (uploadOwner) {
          throw new DailyReflectionConflictError("daily_reflection_upload_already_bound");
        }
      }

      const reflectionId = input.id ?? this.idFactory();
      const now = this.now();
      this.database.prepare(`
        INSERT INTO dr_reflections (
          id, account_id, upload_id, input_method, source_origin,
          processing_profile, ingestion_context, status, version,
          idempotency_key, create_fingerprint, error_code, error_message,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'created', 0, ?, ?, NULL, NULL, ?, ?)
      `).run(
        reflectionId,
        input.accountId,
        input.uploadId,
        input.inputMethod,
        input.sourceOrigin,
        input.processingProfile,
        input.ingestionContext,
        idempotencyKey,
        fingerprint,
        now,
        now
      );

      if (input.uploadId !== null) {
        this.insertPlan({
          reflectionId,
          accountId: input.accountId,
          uploadId: input.uploadId,
          inputMethod: input.inputMethod,
          sourceOrigin: input.sourceOrigin,
          processingProfile: input.processingProfile,
          ingestionContext: input.ingestionContext,
          planVersion: input.planVersion ?? DAILY_REFLECTION_PROCESSING_PLAN_VERSION,
          reviewPolicy: input.reviewPolicy ?? "required"
        });
      }

      return {
        reflection: reflectionFromRow(
          this.requireReflectionRow(input.accountId, reflectionId)
        ),
        processingPlan: this.getProcessingPlan(input.accountId, reflectionId),
        reused: false
      };
    });
    return run();
  }

  private isCandidateReviewDeleted(
    accountId: string,
    reflectionId: string,
    candidateId: string
  ) {
    const row = this.database.prepare(`
      SELECT event_kind
      FROM dr_candidate_v2_review_exclusion_events
      WHERE account_id = ? AND reflection_id = ? AND candidate_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `).get(accountId, reflectionId, candidateId) as {
      event_kind: "excluded" | "restored";
    } | undefined;
    return row?.event_kind === "excluded";
  }

  private appendCandidateReviewExclusionEvent(input: {
    accountId: string;
    reflectionId: string;
    candidateId: string;
    eventKind: "excluded" | "restored";
    now: string;
  }) {
    this.database.prepare(`
      INSERT INTO dr_candidate_v2_review_exclusion_events (
        id, account_id, reflection_id, candidate_id, event_kind, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      this.idFactory(),
      input.accountId,
      input.reflectionId,
      input.candidateId,
      input.eventKind,
      input.now
    );
  }

  createReflectionV2(rawInput: CreateDailyReflectionV2Input) {
    const input = CreateDailyReflectionV2InputSchema.parse(rawInput);
    const inputMethod = input.inputAdapter === "browser_recorder"
      ? "browser_recording" as const
      : "file_upload" as const;
    const uploadId = input.uploadId ?? null;
    if (inputMethod === "browser_recording" && uploadId !== null) {
      throw new DailyReflectionConflictError(
        "daily_reflection_browser_plan_requires_authoritative_duration"
      );
    }
    const contractFingerprint = stableFingerprint({
      version: 2,
      id: input.id ?? null,
      uploadId,
      operationKey: input.operationKey,
      inputAdapter: input.inputAdapter,
      sourceOrigin: input.sourceOrigin,
      capturePurpose: input.capturePurpose,
      recordingDate: input.recordingDate,
      contentHash: input.contentHash ?? null
    });
    const run = this.database.transaction(() => {
      const existing = this.database.prepare(`
        SELECT account_id, reflection_id, operation_key, contract_fingerprint,
               input_adapter, source_origin, capture_purpose, recording_date,
               created_at, updated_at
        FROM dr_v2_reflection_inputs
        WHERE account_id = ? AND operation_key = ?
      `).get(input.accountId, input.operationKey) as ReflectionV2InputRow | undefined;
      if (existing) {
        if (existing.contract_fingerprint !== contractFingerprint) {
          throw new DailyReflectionConflictError("daily_reflection_idempotency_conflict");
        }
        const receipt = this.ensureInputReceiptV2({
          accountId: input.accountId,
          reflectionId: existing.reflection_id,
          operationKey: input.operationKey,
          capturePurpose: input.capturePurpose,
          ...(input.contentHash ? { contentHash: input.contentHash } : {})
        });
        return {
          reflection: this.getReflection(input.accountId, existing.reflection_id),
          processingPlan: this.getProcessingPlan(input.accountId, existing.reflection_id),
          input: reflectionV2InputFromRow(existing),
          receipt,
          reused: true
        };
      }
      const created = this.createReflection({
        ...(input.id ? { id: input.id } : {}),
        accountId: input.accountId,
        uploadId,
        inputMethod,
        sourceOrigin: input.sourceOrigin,
        processingProfile: "full_recording",
        ingestionContext: "daily_reflection",
        idempotencyKey: `drv2_${stableFingerprint({
          accountId: input.accountId,
          operationKey: input.operationKey
        }).slice(0, 48)}`
      });
      if (created.reused) {
        throw new DailyReflectionConflictError("daily_reflection_idempotency_conflict");
      }
      const now = this.now();
      this.database.prepare(`
        INSERT INTO dr_v2_reflection_inputs (
          account_id, reflection_id, operation_key, contract_fingerprint,
          input_adapter, source_origin, capture_purpose, recording_date,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.accountId,
        created.reflection.id,
        input.operationKey,
        contractFingerprint,
        input.inputAdapter,
        input.sourceOrigin,
        input.capturePurpose,
        input.recordingDate,
        now,
        now
      );
      const receipt = this.ensureInputReceiptV2({
        accountId: input.accountId,
        reflectionId: created.reflection.id,
        operationKey: input.operationKey,
        capturePurpose: input.capturePurpose,
        ...(input.contentHash ? { contentHash: input.contentHash } : {})
      });
      return {
        ...created,
        input: this.getReflectionV2Input(input.accountId, created.reflection.id)!,
        receipt,
        reused: false
      };
    });
    return run.immediate();
  }

  private insertPlan(input: {
    reflectionId: string;
    accountId: string;
    uploadId: string;
    inputMethod: ReflectionRow["input_method"];
    sourceOrigin: ReflectionRow["source_origin"];
    processingProfile: ReflectionRow["processing_profile"];
    ingestionContext: "daily_reflection";
    planVersion: 1;
    reviewPolicy: ReviewPolicy;
  }) {
    this.database.prepare(`
      INSERT INTO dr_processing_plans (
        reflection_id, account_id, upload_id, plan_version, input_method,
        source_origin, processing_profile, ingestion_context, review_policy
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.reflectionId,
      input.accountId,
      input.uploadId,
      input.planVersion,
      input.inputMethod,
      input.sourceOrigin,
      input.processingProfile,
      input.ingestionContext,
      input.reviewPolicy
    );
  }

  findReflection(accountId: string, reflectionId: string) {
    const parsedAccountId = DailyReflectionIdSchema.parse(accountId);
    const parsedReflectionId = DailyReflectionIdSchema.parse(reflectionId);
    const row = this.findReflectionRow(parsedAccountId, parsedReflectionId);
    return row ? reflectionFromRow(row) : null;
  }

  findReflectionByUpload(accountId: string, uploadId: string) {
    const parsedAccountId = DailyReflectionIdSchema.parse(accountId);
    const parsedUploadId = DailyReflectionIdSchema.parse(uploadId);
    const row = this.database.prepare(`
      SELECT id, account_id, upload_id, input_method, source_origin,
             processing_profile, ingestion_context, status, review_status, version,
             idempotency_key, create_fingerprint, error_code, error_message,
             created_at, updated_at
      FROM dr_reflections
      WHERE account_id = ? AND upload_id = ?
        AND EXISTS (
          SELECT 1 FROM dr_processing_plans
          WHERE account_id = dr_reflections.account_id
            AND reflection_id = dr_reflections.id
            AND upload_id = dr_reflections.upload_id
        )
    `).get(parsedAccountId, parsedUploadId) as ReflectionRow | undefined;
    return row ? reflectionFromRow(row) : null;
  }

  getReflection(accountId: string, reflectionId: string) {
    const parsedAccountId = DailyReflectionIdSchema.parse(accountId);
    const parsedReflectionId = DailyReflectionIdSchema.parse(reflectionId);
    return reflectionFromRow(this.requireReflectionRow(parsedAccountId, parsedReflectionId));
  }

  getReflectionV2Input(accountId: string, reflectionId: string) {
    const parsedAccountId = DailyReflectionIdSchema.parse(accountId);
    const parsedReflectionId = DailyReflectionIdSchema.parse(reflectionId);
    this.requireReflectionRow(parsedAccountId, parsedReflectionId);
    const row = this.findV2InputRow(parsedAccountId, parsedReflectionId);
    return row ? reflectionV2InputFromRow(row) : null;
  }

  getInputReceiptV2(accountId: string, operationKey: string) {
    const parsedAccountId = DailyReflectionIdSchema.parse(accountId);
    const parsedOperationKey = z.string().trim().min(1).max(512).parse(operationKey);
    const row = this.findInputReceiptV2Row(parsedAccountId, parsedOperationKey);
    return row ? inputReceiptV2FromRow(row) : null;
  }

  listAccountReflections(accountId: string, limit = 24) {
    const parsedAccountId = DailyReflectionIdSchema.parse(accountId);
    const parsedLimit = z.number().int().min(1).max(24).parse(limit);
    const rows = this.database.prepare(`
      SELECT id, account_id, upload_id, input_method, source_origin,
             processing_profile, ingestion_context, status, review_status, version,
             idempotency_key, create_fingerprint, error_code, error_message,
             created_at, updated_at
      FROM dr_reflections
      WHERE account_id = ? AND status <> 'deleted'
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(parsedAccountId, parsedLimit) as ReflectionRow[];
    return rows.map(reflectionFromRow);
  }

  getProcessingPlan(accountId: string, reflectionId: string) {
    const parsedAccountId = DailyReflectionIdSchema.parse(accountId);
    const parsedReflectionId = DailyReflectionIdSchema.parse(reflectionId);
    const row = this.findPlanRow(parsedAccountId, parsedReflectionId);
    if (!row) return null;
    const extension = this.findPlanV2Row(parsedAccountId, parsedReflectionId);
    return extension ? planV2FromRows(row, extension) : planFromRow(row);
  }

  listRecoverableReflections() {
    const rows = this.database.prepare(`
      SELECT id, account_id, upload_id, input_method, source_origin,
             processing_profile, ingestion_context, status, review_status, version,
             idempotency_key, create_fingerprint, error_code, error_message,
             created_at, updated_at
      FROM dr_reflections
      WHERE status IN (
        'created', 'uploading', 'transcribing', 'extracting', 'review_pending'
      )
        AND review_status IS NULL
      ORDER BY updated_at, id
    `).all() as ReflectionRow[];
    return rows.map((row) => ({
      reflection: reflectionFromRow(row),
      processingPlan: this.getProcessingPlan(row.account_id, row.id)
    }));
  }

  getProvisionalUploadOwnership(accountId: string, reflectionId: string) {
    const parsedAccountId = DailyReflectionIdSchema.parse(accountId);
    const parsedReflectionId = DailyReflectionIdSchema.parse(reflectionId);
    this.requireReflectionRow(parsedAccountId, parsedReflectionId);
    const row = this.database.prepare(`
      SELECT account_id, id, upload_id, upload_fingerprint, attempt_version,
             lease_owner, lease_until, status, version, updated_at
      FROM dr_reflections
      WHERE account_id = ? AND id = ?
        AND (
          input_method = 'browser_recording'
          OR EXISTS (
            SELECT 1 FROM dr_v2_reflection_inputs
            WHERE account_id = dr_reflections.account_id
              AND reflection_id = dr_reflections.id
          )
        )
        AND status IN ('created', 'uploading', 'failed', 'cancelled', 'deleted')
        AND upload_fingerprint IS NOT NULL
        AND attempt_version > 0
        AND NOT EXISTS (
          SELECT 1 FROM dr_processing_plans
          WHERE account_id = dr_reflections.account_id
            AND reflection_id = dr_reflections.id
        )
    `).get(parsedAccountId, parsedReflectionId) as {
      account_id: string;
      id: string;
      upload_id: string | null;
      upload_fingerprint: string;
      attempt_version: number;
      lease_owner: string | null;
      lease_until: string | null;
      status: DailyReflectionStatus;
      version: number;
      updated_at: string;
    } | undefined;
    if (!row) return null;
    let uploadId: string;
    try {
      uploadId = buildDailyReflectionUploadId(row.id);
    } catch {
      return null;
    }
    if (row.upload_id !== null && row.upload_id !== uploadId) return null;
    return {
      accountId: row.account_id,
      reflectionId: row.id,
      uploadId,
      uploadFingerprint: row.upload_fingerprint,
      attemptVersion: row.attempt_version,
      leaseOwner: row.lease_owner,
      leaseUntil: row.lease_until,
      status: row.status,
      version: row.version,
      updatedAt: row.updated_at
    } satisfies DailyReflectionProvisionalUploadOwnership;
  }

  listProvisionalUploadOwnerships() {
    const rows = this.database.prepare(`
      SELECT account_id, id
      FROM dr_reflections
      WHERE (
          input_method = 'browser_recording'
          OR EXISTS (
            SELECT 1 FROM dr_v2_reflection_inputs
            WHERE account_id = dr_reflections.account_id
              AND reflection_id = dr_reflections.id
          )
        )
        AND status IN ('created', 'uploading', 'failed', 'cancelled', 'deleted')
        AND upload_fingerprint IS NOT NULL
        AND attempt_version > 0
        AND NOT EXISTS (
          SELECT 1 FROM dr_processing_plans
          WHERE account_id = dr_reflections.account_id
            AND reflection_id = dr_reflections.id
        )
      ORDER BY updated_at, id
    `).all() as Array<{ account_id: string; id: string }>;
    return rows.flatMap((row) => {
      const ownership = this.getProvisionalUploadOwnership(row.account_id, row.id);
      return ownership ? [ownership] : [];
    });
  }

  bindUploadAndPlan(rawInput: {
    accountId: string;
    reflectionId: string;
    expectedVersion: number;
    uploadId: string;
    processingProfile?: ProcessingProfile;
    planVersion?: 1;
    reviewPolicy?: ReviewPolicy;
    leaseOwner?: string;
    attemptVersion?: number;
  }) {
    const input = BindUploadInputSchema.parse(rawInput);
    const planVersion = input.planVersion ?? DAILY_REFLECTION_PROCESSING_PLAN_VERSION;
    const reviewPolicy = input.reviewPolicy ?? "required";
    const run = this.database.transaction(() => {
      const row = this.requireReflectionRow(input.accountId, input.reflectionId);
      if (isDailyReflectionTombstone(row.status)) {
        throw new DailyReflectionConflictError("daily_reflection_tombstoned");
      }
      const existingPlan = this.findPlanRow(input.accountId, input.reflectionId);
      if (existingPlan) {
        if (
          row.upload_id === input.uploadId
          && existingPlan.upload_id === input.uploadId
          && existingPlan.plan_version === planVersion
          && existingPlan.review_policy === reviewPolicy
          && existingPlan.input_method === row.input_method
          && existingPlan.source_origin === row.source_origin
          && existingPlan.processing_profile === row.processing_profile
          && existingPlan.ingestion_context === row.ingestion_context
          && (
            row.input_method !== "file_upload"
            || row.processing_profile === "full_recording"
          )
          && (
            input.processingProfile === undefined
            || existingPlan.processing_profile === input.processingProfile
          )
        ) {
          return {
            reflection: reflectionFromRow(row),
            processingPlan: planFromRow(existingPlan),
            reused: true
          };
        }
        throw new DailyReflectionConflictError("daily_reflection_plan_binding_conflict");
      }
      let processingProfile: ProcessingProfile;
      if (row.input_method === "browser_recording") {
        if (row.status !== "created" && row.status !== "uploading") {
          throw new DailyReflectionConflictError(
            "daily_reflection_browser_plan_binding_not_active"
          );
        }
        if (input.processingProfile === undefined) {
          throw new DailyReflectionConflictError(
            "daily_reflection_authoritative_profile_required"
          );
        }
        if (!input.leaseOwner || input.attemptVersion === undefined) {
          throw new DailyReflectionConflictError(
            "daily_reflection_profile_fence_required"
          );
        }
        processingProfile = input.processingProfile;
      } else {
        if (
          input.processingProfile !== undefined
          && input.processingProfile !== "full_recording"
        ) {
          throw new DailyReflectionConflictError(
            "daily_reflection_file_upload_requires_full_recording"
          );
        }
        processingProfile = "full_recording";
      }
      if (row.upload_id !== null && row.upload_id !== input.uploadId) {
        throw new DailyReflectionConflictError("daily_reflection_upload_binding_conflict");
      }
      if (row.version !== input.expectedVersion) {
        throw new DailyReflectionVersionConflictError(row.version);
      }
      this.assertLeaseFence(input);
      const uploadOwner = this.database.prepare(`
        SELECT id FROM dr_reflections
        WHERE account_id = ? AND upload_id = ? AND id <> ?
      `).get(input.accountId, input.uploadId, input.reflectionId) as { id: string } | undefined;
      if (uploadOwner) {
        throw new DailyReflectionConflictError("daily_reflection_upload_already_bound");
      }

      const now = this.now();
      const updated = this.database.prepare(`
        UPDATE dr_reflections
        SET upload_id = ?, processing_profile = ?,
            version = version + 1, updated_at = ?
        WHERE id = ? AND account_id = ? AND version = ?
          ${input.leaseOwner
            ? "AND lease_owner = ? AND attempt_version = ? AND lease_until > ?"
            : ""}
      `).run(
        input.uploadId,
        processingProfile,
        now,
        input.reflectionId,
        input.accountId,
        input.expectedVersion,
        ...(input.leaseOwner
          ? [input.leaseOwner, input.attemptVersion!, now]
          : [])
      );
      if (updated.changes !== 1) {
        throw new DailyReflectionVersionConflictError(
          this.requireReflectionRow(input.accountId, input.reflectionId).version
        );
      }
      this.insertPlan({
        reflectionId: input.reflectionId,
        accountId: input.accountId,
        uploadId: input.uploadId,
        inputMethod: row.input_method,
        sourceOrigin: row.source_origin,
        processingProfile,
        ingestionContext: row.ingestion_context,
        planVersion,
        reviewPolicy
      });
      const reflection = reflectionFromRow(
        this.requireReflectionRow(input.accountId, input.reflectionId)
      );
      return {
        reflection,
        processingPlan: planFromRow(
          this.findPlanRow(input.accountId, input.reflectionId)!
        ),
        reused: false
      };
    });
    return run.immediate();
  }

  bindUploadAndPlanV2(rawInput: {
    accountId: string;
    reflectionId: string;
    expectedVersion: number;
    uploadId: string;
    inputAdapter: DailyReflectionV2InputAdapter;
    processingProfile: ProcessingProfile;
    effectiveDurationMs: number;
    durationSource: "server_ffprobe";
    candidateLimit: number;
    leaseOwner: string;
    attemptVersion: number;
  }) {
    const input = BindUploadV2InputSchema.parse(rawInput);
    const run = this.database.transaction(() => {
      const row = this.requireReflectionRow(input.accountId, input.reflectionId);
      if (isDailyReflectionTombstone(row.status)) {
        throw new DailyReflectionConflictError("daily_reflection_tombstoned");
      }
      const v2Input = this.findV2InputRow(input.accountId, input.reflectionId);
      const receipt = v2Input
        ? this.findInputReceiptV2Row(input.accountId, v2Input.operation_key)
        : undefined;
      if (!v2Input || !receipt) {
        throw new DailyReflectionConflictError("daily_reflection_v2_input_receipt_missing");
      }
      if (v2Input.input_adapter !== input.inputAdapter) {
        throw new DailyReflectionConflictError("daily_reflection_input_adapter_mismatch");
      }
      if (receipt.upload_id !== input.uploadId) {
        throw new DailyReflectionConflictError("daily_reflection_upload_binding_conflict");
      }
      if (row.version !== input.expectedVersion) {
        throw new DailyReflectionVersionConflictError(row.version);
      }
      this.assertLeaseFence(input);
      const existingPlan = this.findPlanRow(input.accountId, input.reflectionId);
      const existingV2 = this.findPlanV2Row(input.accountId, input.reflectionId);
      if (existingPlan || existingV2) {
        if (
          existingPlan
          && existingV2
          && row.upload_id === input.uploadId
          && existingPlan.upload_id === input.uploadId
          && existingPlan.input_method === row.input_method
          && existingPlan.source_origin === v2Input.source_origin
          && existingPlan.processing_profile === input.processingProfile
          && existingPlan.ingestion_context === "daily_reflection"
          && existingV2.plan_version === DAILY_REFLECTION_PROCESSING_PLAN_V2_VERSION
          && existingV2.input_adapter === v2Input.input_adapter
          && existingV2.capture_purpose === v2Input.capture_purpose
          && existingV2.effective_duration_ms === input.effectiveDurationMs
          && existingV2.duration_source === input.durationSource
          && existingV2.candidate_limit === input.candidateLimit
        ) {
          return {
            reflection: reflectionFromRow(row),
            processingPlan: planV2FromRows(existingPlan, existingV2),
            reused: true
          };
        }
        throw new DailyReflectionConflictError("daily_reflection_plan_binding_conflict");
      }
      if (row.status !== "created" && row.status !== "uploading") {
        throw new DailyReflectionConflictError(
          "daily_reflection_v2_plan_binding_not_active"
        );
      }
      if (row.upload_id !== null && row.upload_id !== input.uploadId) {
        throw new DailyReflectionConflictError("daily_reflection_upload_binding_conflict");
      }
      const uploadOwner = this.database.prepare(`
        SELECT id FROM dr_reflections
        WHERE account_id = ? AND upload_id = ? AND id <> ?
      `).get(input.accountId, input.uploadId, input.reflectionId) as { id: string } | undefined;
      if (uploadOwner) {
        throw new DailyReflectionConflictError("daily_reflection_upload_already_bound");
      }

      const now = this.now();
      const updated = this.database.prepare(`
        UPDATE dr_reflections
        SET upload_id = ?, processing_profile = ?,
            version = version + 1, updated_at = ?
        WHERE id = ? AND account_id = ? AND version = ?
          AND lease_owner = ? AND attempt_version = ? AND lease_until > ?
      `).run(
        input.uploadId,
        input.processingProfile,
        now,
        input.reflectionId,
        input.accountId,
        input.expectedVersion,
        input.leaseOwner,
        input.attemptVersion,
        now
      );
      if (updated.changes !== 1) {
        throw new DailyReflectionVersionConflictError(
          this.requireReflectionRow(input.accountId, input.reflectionId).version
        );
      }
      this.insertPlan({
        reflectionId: input.reflectionId,
        accountId: input.accountId,
        uploadId: input.uploadId,
        inputMethod: row.input_method,
        sourceOrigin: v2Input.source_origin,
        processingProfile: input.processingProfile,
        ingestionContext: "daily_reflection",
        planVersion: DAILY_REFLECTION_PROCESSING_PLAN_VERSION,
        reviewPolicy: "required"
      });
      this.database.prepare(`
        INSERT INTO dr_processing_plans_v2 (
          account_id, reflection_id, plan_version, input_adapter,
          capture_purpose, effective_duration_ms, duration_source,
          candidate_limit, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.accountId,
        input.reflectionId,
        DAILY_REFLECTION_PROCESSING_PLAN_V2_VERSION,
        v2Input.input_adapter,
        v2Input.capture_purpose,
        input.effectiveDurationMs,
        input.durationSource,
        input.candidateLimit,
        now
      );
      const reflection = reflectionFromRow(
        this.requireReflectionRow(input.accountId, input.reflectionId)
      );
      return {
        reflection,
        processingPlan: planV2FromRows(
          this.findPlanRow(input.accountId, input.reflectionId)!,
          this.findPlanV2Row(input.accountId, input.reflectionId)!
        ),
        reused: false
      };
    });
    return run.immediate();
  }

  claimExecutionLease(input: {
    accountId: string;
    reflectionId: string;
    leaseOwner: string;
    leaseDurationMs: number;
    uploadFingerprint?: string;
    provisionalUploadId?: string;
    expectedAttemptVersion?: number;
    allowedStatuses?: DailyReflectionStatus[];
    now?: string;
  }) {
    const accountId = DailyReflectionIdSchema.parse(input.accountId);
    const reflectionId = DailyReflectionIdSchema.parse(input.reflectionId);
    const leaseOwner = z.string().trim().min(1).max(512).parse(input.leaseOwner);
    const uploadFingerprint = input.uploadFingerprint === undefined
      ? null
      : z.string().regex(/^[a-f0-9]{64}$/u).parse(input.uploadFingerprint);
    const provisionalUploadId = input.provisionalUploadId === undefined
      ? null
      : DailyReflectionIdSchema.parse(input.provisionalUploadId);
    if (provisionalUploadId !== null && uploadFingerprint === null) {
      throw new DailyReflectionConflictError(
        "daily_reflection_provisional_fingerprint_required"
      );
    }
    if (
      input.expectedAttemptVersion !== undefined
      && (
        !Number.isInteger(input.expectedAttemptVersion)
        || input.expectedAttemptVersion < 0
      )
    ) {
      throw new DailyReflectionConflictError(
        "daily_reflection_invalid_expected_attempt_version"
      );
    }
    if (!Number.isFinite(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      throw new DailyReflectionConflictError("daily_reflection_invalid_lease_duration");
    }
    const now = input.now ?? this.now();
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) {
      throw new DailyReflectionConflictError("daily_reflection_invalid_lease_clock");
    }
    const leaseUntil = new Date(nowMs + input.leaseDurationMs).toISOString();
    const allowedStatuses = input.allowedStatuses?.map((status) =>
      DailyReflectionStatusSchema.parse(status)
    );
    const statusClause = allowedStatuses
      ? `AND status IN (${allowedStatuses.map(() => "?").join(", ")})`
      : "";
    const run = this.database.transaction(() => {
      const row = this.requireReflectionRow(accountId, reflectionId);
      if (
        input.expectedAttemptVersion !== undefined
        && this.leaseRow(accountId, reflectionId)!.attempt_version
          !== input.expectedAttemptVersion
      ) {
        return null;
      }
      if (provisionalUploadId !== null) {
        let expectedUploadId: string;
        try {
          expectedUploadId = buildDailyReflectionUploadId(reflectionId);
        } catch {
          throw new DailyReflectionConflictError(
            "daily_reflection_invalid_provisional_upload_id"
          );
        }
        const v2Input = this.findV2InputRow(accountId, reflectionId);
        if (
          provisionalUploadId !== expectedUploadId
          || (!v2Input && row.input_method !== "browser_recording")
        ) {
          throw new DailyReflectionConflictError(
            "daily_reflection_invalid_provisional_upload_id"
          );
        }
        const existingPlan = this.findPlanRow(accountId, reflectionId);
        if (
          existingPlan
          && (!v2Input || existingPlan.upload_id !== provisionalUploadId)
        ) {
          throw new DailyReflectionConflictError(
            "daily_reflection_upload_binding_conflict"
          );
        }
        if (row.upload_id !== null && row.upload_id !== provisionalUploadId) {
          throw new DailyReflectionConflictError(
            "daily_reflection_upload_binding_conflict"
          );
        }
        const uploadOwner = this.database.prepare(`
          SELECT id FROM dr_reflections
          WHERE account_id = ? AND upload_id = ? AND id <> ?
        `).get(accountId, provisionalUploadId, reflectionId) as {
          id: string;
        } | undefined;
        if (uploadOwner) {
          throw new DailyReflectionConflictError(
            "daily_reflection_upload_already_bound"
          );
        }
      }
      const persistedFingerprint = this.database.prepare(`
        SELECT upload_fingerprint
        FROM dr_reflections
        WHERE id = ? AND account_id = ?
      `).get(reflectionId, accountId) as { upload_fingerprint: string | null };
      if (
        uploadFingerprint
        && persistedFingerprint.upload_fingerprint
        && persistedFingerprint.upload_fingerprint !== uploadFingerprint
      ) {
        throw new DailyReflectionConflictError(
          "daily_reflection_idempotency_conflict"
        );
      }
      if (
        allowedStatuses
        && !allowedStatuses.includes(row.status)
      ) {
        return null;
      }
      const updated = this.database.prepare(`
        UPDATE dr_reflections
        SET upload_id = COALESCE(upload_id, ?),
            version = version + CASE
              WHEN upload_id IS NULL AND ? IS NOT NULL THEN 1 ELSE 0
            END,
            lease_owner = ?, lease_until = ?,
            upload_fingerprint = COALESCE(upload_fingerprint, ?),
            attempt_version = attempt_version + 1, updated_at = ?
        WHERE id = ? AND account_id = ?
          AND (lease_owner IS NULL OR lease_until IS NULL OR lease_until <= ?)
          AND (? IS NULL OR upload_fingerprint IS NULL OR upload_fingerprint = ?)
          ${statusClause}
      `).run(
        provisionalUploadId,
        provisionalUploadId,
        leaseOwner,
        leaseUntil,
        uploadFingerprint,
        now,
        reflectionId,
        accountId,
        now,
        uploadFingerprint,
        uploadFingerprint,
        ...(allowedStatuses ?? [])
      );
      if (updated.changes !== 1) {
        const currentFingerprint = this.database.prepare(`
          SELECT upload_fingerprint
          FROM dr_reflections
          WHERE id = ? AND account_id = ?
        `).get(reflectionId, accountId) as { upload_fingerprint: string | null };
        if (
          uploadFingerprint
          && currentFingerprint.upload_fingerprint
          && currentFingerprint.upload_fingerprint !== uploadFingerprint
        ) {
          throw new DailyReflectionConflictError(
            "daily_reflection_idempotency_conflict"
          );
        }
        return null;
      }
      const lease = this.leaseRow(accountId, reflectionId)!;
      return {
        leaseOwner: lease.lease_owner!,
        leaseUntil: lease.lease_until!,
        attemptVersion: lease.attempt_version
      } satisfies DailyReflectionExecutionFence;
    });
    return run.immediate();
  }

  getExecutionLease(accountId: string, reflectionId: string) {
    const parsedAccountId = DailyReflectionIdSchema.parse(accountId);
    const parsedReflectionId = DailyReflectionIdSchema.parse(reflectionId);
    this.requireReflectionRow(parsedAccountId, parsedReflectionId);
    const lease = this.leaseRow(parsedAccountId, parsedReflectionId)!;
    return lease.lease_owner && lease.lease_until
      ? {
        leaseOwner: lease.lease_owner,
        leaseUntil: lease.lease_until,
        attemptVersion: lease.attempt_version
      } satisfies DailyReflectionExecutionFence
      : null;
  }

  getUploadFingerprint(accountId: string, reflectionId: string) {
    const parsedAccountId = DailyReflectionIdSchema.parse(accountId);
    const parsedReflectionId = DailyReflectionIdSchema.parse(reflectionId);
    this.requireReflectionRow(parsedAccountId, parsedReflectionId);
    const row = this.database.prepare(`
      SELECT upload_fingerprint
      FROM dr_reflections
      WHERE id = ? AND account_id = ?
    `).get(parsedReflectionId, parsedAccountId) as {
      upload_fingerprint: string | null;
    };
    return row.upload_fingerprint;
  }

  assertExecutionLease(input: {
    accountId: string;
    reflectionId: string;
    leaseOwner: string;
    attemptVersion: number;
    now?: string;
  }) {
    this.requireReflectionRow(input.accountId, input.reflectionId);
    this.assertLeaseFence(input);
  }

  renewExecutionLease(input: {
    accountId: string;
    reflectionId: string;
    leaseOwner: string;
    attemptVersion: number;
    leaseDurationMs: number;
    now?: string;
  }) {
    const now = input.now ?? this.now();
    const nowMs = Date.parse(now);
    if (
      !Number.isFinite(nowMs)
      || !Number.isFinite(input.leaseDurationMs)
      || input.leaseDurationMs <= 0
    ) {
      throw new DailyReflectionConflictError("daily_reflection_invalid_lease_clock");
    }
    const leaseUntil = new Date(nowMs + input.leaseDurationMs).toISOString();
    const updated = this.database.prepare(`
      UPDATE dr_reflections SET lease_until = ?, updated_at = ?
      WHERE id = ? AND account_id = ? AND lease_owner = ?
        AND attempt_version = ? AND lease_until > ?
    `).run(
      leaseUntil,
      now,
      input.reflectionId,
      input.accountId,
      input.leaseOwner,
      input.attemptVersion,
      now
    );
    if (updated.changes !== 1) throw new DailyReflectionLeaseLostError();
    return {
      leaseOwner: input.leaseOwner,
      attemptVersion: input.attemptVersion,
      leaseUntil
    } satisfies DailyReflectionExecutionFence;
  }

  releaseExecutionLease(input: {
    accountId: string;
    reflectionId: string;
    leaseOwner: string;
    attemptVersion: number;
  }) {
    return this.database.prepare(`
      UPDATE dr_reflections
      SET lease_owner = NULL, lease_until = NULL
      WHERE id = ? AND account_id = ? AND lease_owner = ? AND attempt_version = ?
    `).run(
      input.reflectionId,
      input.accountId,
      input.leaseOwner,
      input.attemptVersion
    ).changes === 1;
  }

  publishAssetUnderExecutionFence(input: {
    accountId: string;
    reflectionId: string;
    leaseOwner: string;
    attemptVersion: number;
    assetKind: DailyReflectionPublishedAssetKind;
    payload: unknown;
    now?: string;
    beforeCommit?: () => void;
  }) {
    const now = input.now ?? this.now();
    const payloadJson = JSON.stringify(input.payload);
    const run = this.database.transaction(() => {
      const reflection = this.requireReflectionRow(input.accountId, input.reflectionId);
      // Failure settlement happens after the reflection transition. Only the
      // same fenced worker may publish its matching failed upload projection;
      // every other post-staging asset write remains closed.
      const isOwnedFailureUpload = reflection.status === "failed"
        && input.assetKind === "upload"
        && isDailyReflectionUploadRecord(input.payload)
        && input.payload.id === reflection.upload_id
        && input.payload.reflectionId === input.reflectionId
        && input.payload.status === "failed"
        && reflection.error_code !== null
        && input.payload.errorCode === reflection.error_code;
      if (
        reflection.review_status !== null
        || (
          ![
            "created",
            "uploading",
            "transcribing",
            "extracting"
          ].includes(reflection.status)
          && !isOwnedFailureUpload
        )
      ) {
        throw new DailyReflectionLeaseLostError();
      }
      this.assertLeaseFence({ ...input, now });
      const existing = this.database.prepare(`
        SELECT attempt_version
        FROM dr_asset_publications
        WHERE account_id = ? AND reflection_id = ? AND asset_kind = ?
      `).get(input.accountId, input.reflectionId, input.assetKind) as {
        attempt_version: number;
      } | undefined;
      if (existing && existing.attempt_version > input.attemptVersion) {
        throw new DailyReflectionLeaseLostError();
      }
      input.beforeCommit?.();
      const published = this.database.prepare(`
        INSERT INTO dr_asset_publications (
          account_id, reflection_id, asset_kind, attempt_version,
          payload_json, published_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, reflection_id, asset_kind) DO UPDATE SET
          attempt_version = excluded.attempt_version,
          payload_json = excluded.payload_json,
          published_at = excluded.published_at
        WHERE dr_asset_publications.attempt_version <= excluded.attempt_version
      `).run(
        input.accountId,
        input.reflectionId,
        input.assetKind,
        input.attemptVersion,
        payloadJson,
        now
      );
      if (published.changes !== 1) throw new DailyReflectionLeaseLostError();
    });
    run.immediate();
  }

  readPublishedAsset<T>(input: {
    accountId: string;
    reflectionId: string;
    assetKind: DailyReflectionPublishedAssetKind;
  }): T | null {
    this.requireReflectionRow(input.accountId, input.reflectionId);
    const row = this.database.prepare(`
      SELECT payload_json
      FROM dr_asset_publications
      WHERE account_id = ? AND reflection_id = ? AND asset_kind = ?
    `).get(input.accountId, input.reflectionId, input.assetKind) as {
      payload_json: string;
    } | undefined;
    return row ? JSON.parse(row.payload_json) as T : null;
  }

  deletePublishedAssets(accountId: string, reflectionId: string) {
    this.requireReflectionRow(accountId, reflectionId);
    return this.database.prepare(`
      DELETE FROM dr_asset_publications
      WHERE account_id = ? AND reflection_id = ?
    `).run(accountId, reflectionId).changes;
  }

  deletePublishedAsset(
    accountId: string,
    reflectionId: string,
    assetKind: DailyReflectionPublishedAssetKind
  ) {
    this.requireReflectionRow(accountId, reflectionId);
    return this.database.prepare(`
      DELETE FROM dr_asset_publications
      WHERE account_id = ? AND reflection_id = ? AND asset_kind = ?
    `).run(accountId, reflectionId, assetKind).changes;
  }

  transitionStatus(rawInput: {
    accountId: string;
    reflectionId: string;
    expectedVersion: number;
    status: DailyReflectionStatus;
    errorCode?: string | null;
    errorMessage?: string | null;
    leaseOwner?: string;
    attemptVersion?: number;
  }) {
    const input = TransitionInputSchema.parse(rawInput);
    if (
      input.status === "confirmation_ready"
      || input.status === "admitting"
      || input.status === "completed"
      || input.status === "admission_failed"
    ) {
      throw new DailyReflectionConflictError("daily_reflection_review_transition_requires_operation");
    }
    const run = this.database.transaction(() => {
      const row = this.requireReflectionRow(input.accountId, input.reflectionId);
      if (row.version !== input.expectedVersion) {
        throw new DailyReflectionVersionConflictError(row.version);
      }
      this.assertLeaseFence(input);
      assertDailyReflectionTransition(reflectionFromRow(row).status, input.status);
      const now = this.now();
      const errorCode = input.status === "failed" ? input.errorCode ?? null : row.error_code;
      const errorMessage = input.status === "failed" ? input.errorMessage ?? null : row.error_message;
      const fenceClause = input.leaseOwner
        ? "AND lease_owner = ? AND attempt_version = ? AND lease_until > ?"
        : "";
      const updated = this.database.prepare(`
        UPDATE dr_reflections
        SET status = ?, review_status = NULL, version = version + 1,
            error_code = ?, error_message = ?,
            updated_at = ?,
            lease_owner = CASE WHEN ? THEN NULL ELSE lease_owner END,
            lease_until = CASE WHEN ? THEN NULL ELSE lease_until END
        WHERE id = ? AND account_id = ? AND version = ? ${fenceClause}
      `).run(
        input.status,
        errorCode,
        errorMessage,
        now,
        isDailyReflectionTombstone(input.status) ? 1 : 0,
        isDailyReflectionTombstone(input.status) ? 1 : 0,
        input.reflectionId,
        input.accountId,
        input.expectedVersion,
        ...(input.leaseOwner
          ? [input.leaseOwner, input.attemptVersion!, now]
          : [])
      );
      if (updated.changes !== 1) {
        throw new DailyReflectionVersionConflictError(
          this.requireReflectionRow(input.accountId, input.reflectionId).version
        );
      }
      return reflectionFromRow(
        this.requireReflectionRow(input.accountId, input.reflectionId)
      );
    });
    return run();
  }

  retryFailed(rawInput: {
    accountId: string;
    reflectionId: string;
    expectedVersion: number;
    resumeStatus: DailyReflectionRetryStatus;
  }) {
    const input = RetryFailedInputSchema.parse(rawInput);
    const run = this.database.transaction(() => {
      const row = this.requireReflectionRow(input.accountId, input.reflectionId);
      if (row.version !== input.expectedVersion) {
        throw new DailyReflectionVersionConflictError(row.version);
      }
      if (row.status !== "failed") {
        throw new DailyReflectionConflictError("daily_reflection_retry_requires_failed");
      }
      assertFailedDailyReflectionRetry(row.status, input.resumeStatus);

      const planRow = this.findPlanRow(input.accountId, input.reflectionId);
      if (row.upload_id === null || !planRow) {
        throw new DailyReflectionConflictError(
          "daily_reflection_retry_requires_upload_binding"
        );
      }
      if (planRow.upload_id !== row.upload_id) {
        throw new DailyReflectionConflictError(
          "daily_reflection_retry_reference_mismatch"
        );
      }

      const now = this.now();
      const updated = this.database.prepare(`
        UPDATE dr_reflections
        SET status = ?, version = version + 1, error_code = NULL,
            error_message = NULL, updated_at = ?,
            lease_owner = NULL, lease_until = NULL
        WHERE id = ? AND account_id = ? AND version = ? AND status = 'failed'
      `).run(
        input.resumeStatus,
        now,
        input.reflectionId,
        input.accountId,
        input.expectedVersion
      );
      if (updated.changes !== 1) {
        const current = this.requireReflectionRow(input.accountId, input.reflectionId);
        if (current.version !== input.expectedVersion) {
          throw new DailyReflectionVersionConflictError(current.version);
        }
        throw new DailyReflectionConflictError("daily_reflection_retry_requires_failed");
      }

      return {
        reflection: reflectionFromRow(
          this.requireReflectionRow(input.accountId, input.reflectionId)
        ),
        processingPlan: planFromRow(planRow)
      };
    });
    return run();
  }

  listCandidates(accountId: string, reflectionId: string): Candidate[] {
    const parsedAccountId = DailyReflectionIdSchema.parse(accountId);
    const parsedReflectionId = DailyReflectionIdSchema.parse(reflectionId);
    this.requireReflectionRow(parsedAccountId, parsedReflectionId);
    return this.listCandidateRows(parsedAccountId, parsedReflectionId)
      .map((row) => this.candidateFromRow(parsedAccountId, row));
  }

  deleteCandidates(accountId: string, reflectionId: string) {
    const parsedAccountId = DailyReflectionIdSchema.parse(accountId);
    const parsedReflectionId = DailyReflectionIdSchema.parse(reflectionId);
    this.requireReflectionRow(parsedAccountId, parsedReflectionId);
    return this.database.prepare(`
      DELETE FROM dr_candidates
      WHERE account_id = ? AND reflection_id = ?
    `).run(parsedAccountId, parsedReflectionId).changes;
  }

  createManualCandidateV2(rawInput: {
    accountId: string;
    reflectionId: string;
    expectedVersion: number;
    candidateKind: "insight" | "open_question" | "decision" | "user_action";
    proposedText: string;
    evidenceIds: string[];
    confidence: number;
    caution: string;
    actionClaimed: boolean;
  }) {
    const input = CreateManualCandidateV2InputSchema.parse(rawInput);
    const run = this.database.transaction(() => {
      const reflectionRow = this.requireReflectionRow(input.accountId, input.reflectionId);
      const v2Input = this.findV2InputRow(input.accountId, input.reflectionId);
      const plan = this.findPlanRow(input.accountId, input.reflectionId);
      const planV2 = this.findPlanV2Row(input.accountId, input.reflectionId);
      if (!v2Input || !plan || !planV2) {
        throw new DailyReflectionConflictError("daily_reflection_v2_input_missing");
      }
      const providerRecovery = reflectionRow.status === "failed"
        && Boolean(reflectionRow.error_code?.startsWith("daily_reflection_candidate_"));
      if (reflectionRow.status !== "review_pending" && !providerRecovery) {
        throw new DailyReflectionConflictError("daily_reflection_review_not_editable");
      }
      if (reflectionRow.version !== input.expectedVersion) {
        throw new DailyReflectionVersionConflictError(reflectionRow.version);
      }
      const finalized = this.database.prepare(`
        SELECT 1 FROM dr_reflection_confirmations
        WHERE account_id = ? AND reflection_id = ?
      `).get(input.accountId, input.reflectionId);
      if (finalized) {
        throw new DailyReflectionConflictError("daily_reflection_candidate_finalized");
      }
      const currentRows = this.listCandidateRows(input.accountId, input.reflectionId);
      if (currentRows.length >= planV2.candidate_limit) {
        throw new DailyReflectionConflictError("daily_reflection_candidate_limit_exceeded");
      }
      const canonicalSegments = parseDailyReflectionCanonicalTranscript(
        this.readPublishedAsset<unknown>({
          accountId: input.accountId,
          reflectionId: input.reflectionId,
          assetKind: "segments"
        }),
        plan.upload_id
      );
      if (!canonicalSegments?.length) {
        throw new DailyReflectionConflictError(
          "daily_reflection_confirmation_evidence_unavailable"
        );
      }
      const evidenceOrder = new Map(
        canonicalSegments.map((segment, index) => [segment.id, index] as const)
      );
      if (input.evidenceIds.some((evidenceId) => !evidenceOrder.has(evidenceId))) {
        throw new DailyReflectionConflictError(
          "daily_reflection_confirmation_evidence_unavailable"
        );
      }
      const evidenceIds = [...input.evidenceIds].sort(
        (left, right) => evidenceOrder.get(left)! - evidenceOrder.get(right)!
      );
      const ordinal = currentRows.reduce(
        (maximum, candidate) => Math.max(maximum, candidate.ordinal),
        -1
      ) + 1;
      const candidateId = this.idFactory();
      const now = this.now();
      const candidateType = legacyCandidateKindForV2(input);
      this.database.prepare(`
        INSERT INTO dr_candidates (
          id, account_id, reflection_id, ordinal, proposed_text, user_text,
          status, candidate_type, subject_person_id, subject_confirmed,
          version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, 'pending', ?, NULL, 0, 0, ?, ?)
      `).run(
        candidateId,
        input.accountId,
        input.reflectionId,
        ordinal,
        input.proposedText,
        candidateType,
        now,
        now
      );
      const insertSource = this.database.prepare(`
        INSERT INTO dr_candidate_sources (
          account_id, candidate_id, position, source_segment_id
        ) VALUES (?, ?, ?, ?)
      `);
      evidenceIds.forEach((evidenceId, position) => {
        insertSource.run(input.accountId, candidateId, position, evidenceId);
      });
      this.database.prepare(`
        INSERT INTO dr_candidate_v2_metadata (
          account_id, reflection_id, candidate_id, candidate_kind,
          evidence_ids_json, confidence, caution, action_claimed,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.accountId,
        input.reflectionId,
        candidateId,
        input.candidateKind,
        JSON.stringify(evidenceIds),
        input.confidence,
        input.caution,
        input.actionClaimed ? 1 : 0,
        now,
        now
      );
      const updated = this.database.prepare(`
        UPDATE dr_reflections
        SET status = 'review_pending', error_code = NULL, error_message = NULL,
            version = version + 1, updated_at = ?
        WHERE id = ? AND account_id = ? AND version = ?
          AND review_status IS NULL
          AND (status = 'review_pending' OR (
            status = 'failed' AND error_code LIKE 'daily_reflection_candidate_%'
          ))
      `).run(
        now,
        input.reflectionId,
        input.accountId,
        input.expectedVersion
      );
      if (updated.changes !== 1) {
        throw new DailyReflectionVersionConflictError(
          this.requireReflectionRow(input.accountId, input.reflectionId).version
        );
      }
      return {
        reflection: reflectionFromRow(
          this.requireReflectionRow(input.accountId, input.reflectionId)
        ),
        candidate: this.candidateFromRow(
          input.accountId,
          this.listCandidateRows(input.accountId, input.reflectionId)
            .find((candidate) => candidate.id === candidateId)!
        ),
        retentionEligibility: evidenceIds.length > 0
          ? "retain_selected" as const
          : "recap_only" as const
      };
    });
    return run.immediate();
  }

  excludeCandidateV2(rawInput: {
    accountId: string;
    reflectionId: string;
    candidateId: string;
    expectedVersion: number;
  }) {
    const input = ExcludeCandidateV2InputSchema.parse(rawInput);
    const run = this.database.transaction(() => {
      const reflectionRow = this.requireReflectionRow(input.accountId, input.reflectionId);
      if (reflectionRow.status !== "review_pending" || reflectionRow.review_status !== null) {
        throw new DailyReflectionConflictError("daily_reflection_review_not_editable");
      }
      if (reflectionRow.version !== input.expectedVersion) {
        throw new DailyReflectionVersionConflictError(reflectionRow.version);
      }
      const row = this.listCandidateRows(input.accountId, input.reflectionId)
        .find((candidate) => candidate.id === input.candidateId);
      const v2 = row ? this.database.prepare(`
        SELECT 1 FROM dr_candidate_v2_metadata
        WHERE account_id = ? AND reflection_id = ? AND candidate_id = ?
      `).get(input.accountId, input.reflectionId, input.candidateId) : null;
      if (!row || !v2) throw new DailyReflectionNotFoundError();
      if (this.isCandidateReviewDeleted(
        input.accountId,
        input.reflectionId,
        input.candidateId
      )) {
        throw new DailyReflectionConflictError("daily_reflection_candidate_already_excluded");
      }
      const now = this.now();
      const updatedCandidate = this.database.prepare(`
        UPDATE dr_candidates
        SET status = 'excluded', user_text = NULL, subject_person_id = NULL,
            subject_confirmed = 0, version = version + 1, updated_at = ?
        WHERE id = ? AND account_id = ? AND reflection_id = ?
      `).run(now, input.candidateId, input.accountId, input.reflectionId);
      if (updatedCandidate.changes !== 1) throw new DailyReflectionNotFoundError();
      this.appendCandidateReviewExclusionEvent({
        accountId: input.accountId,
        reflectionId: input.reflectionId,
        candidateId: input.candidateId,
        eventKind: "excluded",
        now
      });
      const updatedReflection = this.database.prepare(`
        UPDATE dr_reflections
        SET version = version + 1, updated_at = ?
        WHERE id = ? AND account_id = ? AND version = ?
          AND status = 'review_pending' AND review_status IS NULL
      `).run(now, input.reflectionId, input.accountId, input.expectedVersion);
      if (updatedReflection.changes !== 1) {
        throw new DailyReflectionVersionConflictError(
          this.requireReflectionRow(input.accountId, input.reflectionId).version
        );
      }
      return {
        reflection: reflectionFromRow(
          this.requireReflectionRow(input.accountId, input.reflectionId)
        ),
        candidate: this.candidateFromRow(
          input.accountId,
          this.listCandidateRows(input.accountId, input.reflectionId)
            .find((candidate) => candidate.id === input.candidateId)!
        ),
        disposition: "excluded" as const,
        recoverable: true as const
      };
    });
    return run.immediate();
  }

  updateCandidateDecisions(rawInput: {
    accountId: string;
    reflectionId: string;
    expectedVersion: number;
    candidates: Array<{
      candidateId: string;
      status: "pending" | "kept" | "excluded";
      userText: string | null;
      subjectPersonId: string | null;
      actionClaimed?: boolean;
    }>;
  }) {
    const input = UpdateCandidateDecisionsInputSchema.parse(rawInput);
    const run = this.database.transaction(() => {
      const reflectionRow = this.requireReflectionRow(input.accountId, input.reflectionId);
      const reflection = reflectionFromRow(reflectionRow);
      if (reflection.status !== "review_pending") {
        throw new DailyReflectionConflictError("daily_reflection_review_not_editable");
      }
      if (reflection.version !== input.expectedVersion) {
        throw new DailyReflectionVersionConflictError(reflection.version);
      }
      const finalized = this.database.prepare(`
        SELECT 1 FROM dr_reflection_confirmations
        WHERE account_id = ? AND reflection_id = ?
      `).get(input.accountId, input.reflectionId);
      if (finalized) {
        throw new DailyReflectionConflictError("daily_reflection_candidate_finalized");
      }

      const currentCandidates = new Map(
        this.listCandidateRows(input.accountId, input.reflectionId)
          .map((row) => [row.id, row] as const)
      );
      const update = this.database.prepare(`
        UPDATE dr_candidates
        SET user_text = ?, status = ?, subject_person_id = ?,
            subject_confirmed = ?, candidate_type = ?,
            version = version + 1, updated_at = ?
        WHERE id = ? AND account_id = ? AND reflection_id = ?
      `);
      const now = this.now();
      for (const decision of input.candidates) {
        if (!currentCandidates.has(decision.candidateId)) {
          throw new DailyReflectionConflictError("daily_reflection_candidate_mismatch");
        }
        const v2 = this.database.prepare(`
          SELECT candidate_kind, evidence_ids_json, confidence, caution, action_claimed
          FROM dr_candidate_v2_metadata
          WHERE account_id = ? AND reflection_id = ? AND candidate_id = ?
        `).get(
          input.accountId,
          input.reflectionId,
          decision.candidateId
        ) as CandidateV2MetadataRow | undefined;
        if (v2 && decision.subjectPersonId !== null) {
          throw new DailyReflectionConflictError(
            "daily_reflection_v2_subject_not_supported"
          );
        }
        if (decision.actionClaimed !== undefined && !v2) {
          throw new DailyReflectionConflictError(
            "daily_reflection_action_claim_requires_v2"
          );
        }
        if (
          decision.actionClaimed === true
          && (
            v2?.candidate_kind !== "user_action"
            || z.array(DailyReflectionIdSchema).parse(JSON.parse(v2.evidence_ids_json)).length === 0
          )
        ) {
          throw new DailyReflectionConflictError(
            "daily_reflection_action_claim_requires_evidence"
          );
        }
        const actionClaimed = decision.actionClaimed ?? Boolean(v2?.action_claimed);
        const candidateType = v2
          ? legacyCandidateKindForV2({
              candidateKind: v2.candidate_kind,
              actionClaimed
            })
          : currentCandidates.get(decision.candidateId)!.candidate_type;
        const subjectPersonId = decision.status === "kept"
          ? decision.subjectPersonId
          : null;
        const result = update.run(
          decision.userText,
          decision.status,
          subjectPersonId,
          subjectPersonId === null ? 0 : 1,
          candidateType,
          now,
          decision.candidateId,
          input.accountId,
          input.reflectionId
        );
        if (result.changes !== 1) {
          throw new DailyReflectionConflictError("daily_reflection_candidate_mismatch");
        }
        if (v2 && decision.actionClaimed !== undefined) {
          this.database.prepare(`
            UPDATE dr_candidate_v2_metadata
            SET action_claimed = ?, updated_at = ?
            WHERE account_id = ? AND reflection_id = ? AND candidate_id = ?
          `).run(
            decision.actionClaimed ? 1 : 0,
            now,
            input.accountId,
            input.reflectionId,
            decision.candidateId
          );
        }
        if (
          v2
          && decision.status !== "excluded"
          && this.isCandidateReviewDeleted(
            input.accountId,
            input.reflectionId,
            decision.candidateId
          )
        ) {
          this.appendCandidateReviewExclusionEvent({
            accountId: input.accountId,
            reflectionId: input.reflectionId,
            candidateId: decision.candidateId,
            eventKind: "restored",
            now
          });
        }
      }
      const updated = this.database.prepare(`
        UPDATE dr_reflections
        SET version = version + 1, updated_at = ?
        WHERE id = ? AND account_id = ? AND version = ?
          AND status = 'review_pending' AND review_status IS NULL
      `).run(now, input.reflectionId, input.accountId, input.expectedVersion);
      if (updated.changes !== 1) {
        throw new DailyReflectionVersionConflictError(
          reflectionFromRow(this.requireReflectionRow(input.accountId, input.reflectionId)).version
        );
      }
      return this.getReflectionDetail(input.accountId, input.reflectionId);
    });
    return run();
  }

  findConfirmationByIdempotencyKey(accountId: string, idempotencyKey: string) {
    const parsedAccountId = DailyReflectionIdSchema.parse(accountId);
    const parsedKey = z.string().trim().min(1).max(512).parse(idempotencyKey);
    const row = this.database.prepare(`
      SELECT * FROM dr_reflection_confirmations
      WHERE account_id = ? AND idempotency_key = ?
    `).get(parsedAccountId, parsedKey) as ConfirmationRow | undefined;
    return row ? confirmationFromRow(row) : null;
  }

  getConfirmation(accountId: string, reflectionId: string) {
    const parsedAccountId = DailyReflectionIdSchema.parse(accountId);
    const parsedReflectionId = DailyReflectionIdSchema.parse(reflectionId);
    const row = this.database.prepare(`
      SELECT * FROM dr_reflection_confirmations
      WHERE account_id = ? AND reflection_id = ?
    `).get(parsedAccountId, parsedReflectionId) as ConfirmationRow | undefined;
    return row ? confirmationFromRow(row) : null;
  }

  getAdmissionOperation(accountId: string, reflectionId: string) {
    const parsedAccountId = DailyReflectionIdSchema.parse(accountId);
    const parsedReflectionId = DailyReflectionIdSchema.parse(reflectionId);
    const row = this.findAdmissionOperationRow(parsedAccountId, parsedReflectionId);
    return row ? admissionOperationFromRow(row) : null;
  }

  listAdmissionResults(accountId: string, operationId: string) {
    const parsedAccountId = DailyReflectionIdSchema.parse(accountId);
    const parsedOperationId = DailyReflectionIdSchema.parse(operationId);
    return (this.database.prepare(`
      SELECT candidate_id, status, memory_id, reason_code, error_code,
             operation_key, updated_at
      FROM dr_candidate_admission_receipts
      WHERE account_id = ? AND operation_id = ?
      ORDER BY candidate_id
    `).all(parsedAccountId, parsedOperationId) as AdmissionReceiptRow[])
      .map(admissionReceiptFromRow);
  }

  getCandidateRevocationOperation(
    accountId: string,
    reflectionId: string,
    candidateId: string
  ) {
    const parsedAccountId = DailyReflectionIdSchema.parse(accountId);
    const parsedReflectionId = DailyReflectionIdSchema.parse(reflectionId);
    const parsedCandidateId = DailyReflectionIdSchema.parse(candidateId);
    const row = this.findCandidateRevocationOperationRow(
      parsedAccountId,
      parsedReflectionId,
      parsedCandidateId
    );
    return row ? candidateRevocationOperationFromRow(row) : null;
  }

  getCandidateRevocationReceipt(accountId: string, operationId: string) {
    const parsedAccountId = DailyReflectionIdSchema.parse(accountId);
    const parsedOperationId = DailyReflectionIdSchema.parse(operationId);
    const row = this.database.prepare(`
      SELECT * FROM dr_candidate_revocation_receipts
      WHERE account_id = ? AND operation_id = ?
    `).get(parsedAccountId, parsedOperationId) as
      CandidateRevocationReceiptRow | undefined;
    return row ? candidateRevocationReceiptFromRow(row) : null;
  }

  listCandidateRevocationReceipts(accountId: string, reflectionId: string) {
    const parsedAccountId = DailyReflectionIdSchema.parse(accountId);
    const parsedReflectionId = DailyReflectionIdSchema.parse(reflectionId);
    return (this.database.prepare(`
      SELECT * FROM dr_candidate_revocation_receipts
      WHERE account_id = ? AND reflection_id = ?
      ORDER BY candidate_id
    `).all(parsedAccountId, parsedReflectionId) as CandidateRevocationReceiptRow[])
      .map(candidateRevocationReceiptFromRow);
  }

  getRememberedCandidateCount(accountId: string, reflectionId: string) {
    const operation = this.getAdmissionOperation(accountId, reflectionId);
    if (!operation) return 0;
    const admitted = this.listAdmissionResults(accountId, operation.id).filter(
      (result) => result.status === "admitted" || result.status === "already_admitted"
    ).length;
    const revoked = this.listCandidateRevocationReceipts(accountId, reflectionId).filter(
      (receipt) => receipt.outcome === "revoked"
    ).length;
    return Math.max(0, admitted - revoked);
  }

  prepareCandidateRevocation(rawInput: {
    accountId: string;
    reflectionId: string;
    candidateId: string;
    expectedVersion: number;
    idempotencyKey: string;
    now?: string;
  }) {
    const accountId = DailyReflectionIdSchema.parse(rawInput.accountId);
    const reflectionId = DailyReflectionIdSchema.parse(rawInput.reflectionId);
    const candidateId = DailyReflectionIdSchema.parse(rawInput.candidateId);
    const expectedVersion = z.number().int().nonnegative().parse(rawInput.expectedVersion);
    const idempotencyKey = z.string().trim().min(1).max(512).parse(rawInput.idempotencyKey);
    const requestFingerprint = stableFingerprint({ reflectionId, candidateId, expectedVersion });
    const now = rawInput.now ?? this.now();
    const run = this.database.transaction(() => {
      const replay = this.database.prepare(`
        SELECT * FROM dr_candidate_revocation_operations
        WHERE account_id = ? AND idempotency_key = ?
      `).get(accountId, idempotencyKey) as CandidateRevocationOperationRow | undefined;
      if (replay) {
        if (replay.request_fingerprint !== requestFingerprint) {
          throw new DailyReflectionConflictError(
            "daily_reflection_candidate_revocation_idempotency_conflict"
          );
        }
        return {
          operation: candidateRevocationOperationFromRow(replay),
          receipt: this.getCandidateRevocationReceipt(accountId, replay.id),
          reused: true
        };
      }

      const reflectionRow = this.requireReflectionRow(accountId, reflectionId);
      const reflection = reflectionFromRow(reflectionRow);
      if (reflection.version !== expectedVersion) {
        throw new DailyReflectionVersionConflictError(reflection.version);
      }
      if (reflection.status !== "completed") {
        throw new DailyReflectionConflictError(
          "daily_reflection_candidate_revocation_requires_completed"
        );
      }
      const confirmation = this.getConfirmation(accountId, reflectionId);
      const admissionOperation = this.getAdmissionOperation(accountId, reflectionId);
      if (!confirmation || !admissionOperation || admissionOperation.status !== "completed") {
        throw new DailyReflectionConflictError(
          "daily_reflection_candidate_revocation_admission_incomplete"
        );
      }
      const candidate = this.database.prepare(`
        SELECT id FROM dr_candidates
        WHERE id = ? AND account_id = ? AND reflection_id = ?
      `).get(candidateId, accountId, reflectionId);
      if (!candidate) throw new DailyReflectionNotFoundError();
      if (this.findCandidateRevocationOperationRow(accountId, reflectionId, candidateId)) {
        throw new DailyReflectionConflictError(
          "daily_reflection_candidate_revocation_already_requested"
        );
      }
      const admissionReceipt = this.database.prepare(`
        SELECT candidate_id, status, memory_id, reason_code, error_code,
               operation_key, updated_at
        FROM dr_candidate_admission_receipts
        WHERE account_id = ? AND operation_id = ? AND candidate_id = ?
      `).get(accountId, admissionOperation.id, candidateId) as AdmissionReceiptRow | undefined;
      const hasLongTermObject = admissionReceipt?.status === "admitted"
        || admissionReceipt?.status === "already_admitted";
      const admissionStatus: CandidateRevocationOperationRow["admission_status"] =
        admissionReceipt?.status === "admitted" || admissionReceipt?.status === "already_admitted"
          ? admissionReceipt.status
          : admissionReceipt?.status === "rejected" ? "rejected" : "no_receipt";
      const operationKey = `daily_reflection_candidate_revocation_${stableFingerprint({
        accountId,
        confirmationId: confirmation.id,
        candidateId
      })}`;
      const operationId = `dr_candidate_revocation_${stableFingerprint({
        accountId,
        confirmationId: confirmation.id,
        candidateId
      }).slice(0, 32)}`;
      const initialStatus = hasLongTermObject ? "ready" : "completed";
      this.database.prepare(`
        INSERT INTO dr_candidate_revocation_operations (
          id, account_id, reflection_id, confirmation_id, candidate_id,
          operation_key, idempotency_key, request_fingerprint,
          admission_status, memory_id, status, attempt_version,
          lease_owner, lease_until, error_code, index_refresh_status,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL,
          'not_required', ?, ?, ?)
      `).run(
        operationId,
        accountId,
        reflectionId,
        confirmation.id,
        candidateId,
        operationKey,
        idempotencyKey,
        requestFingerprint,
        admissionStatus,
        admissionReceipt?.memory_id ?? null,
        initialStatus,
        now,
        now,
        hasLongTermObject ? null : now
      );
      if (!hasLongTermObject) {
        this.database.prepare(`
          INSERT INTO dr_candidate_revocation_receipts (
            account_id, operation_id, reflection_id, confirmation_id,
            candidate_id, outcome, memory_id, removed_memory_evidence_count,
            removed_person_source_count, created_at
          ) VALUES (?, ?, ?, ?, ?, 'no_long_term_object', NULL, 0, 0, ?)
        `).run(accountId, operationId, reflectionId, confirmation.id, candidateId, now);
      }
      const updated = this.database.prepare(`
        UPDATE dr_reflections SET version = version + 1, updated_at = ?
        WHERE id = ? AND account_id = ? AND version = ?
          AND status = 'review_pending' AND review_status = 'completed'
      `).run(now, reflectionId, accountId, expectedVersion);
      if (updated.changes !== 1) {
        throw new DailyReflectionVersionConflictError(
          reflectionFromRow(this.requireReflectionRow(accountId, reflectionId)).version
        );
      }
      const operation = this.getCandidateRevocationOperation(accountId, reflectionId, candidateId)!;
      return {
        operation,
        receipt: this.getCandidateRevocationReceipt(accountId, operation.id),
        reused: false
      };
    });
    return run.immediate();
  }

  startCandidateRevocation(input: {
    accountId: string;
    reflectionId: string;
    candidateId: string;
    leaseOwner: string;
    leaseDurationMs: number;
    now?: string;
  }) {
    const accountId = DailyReflectionIdSchema.parse(input.accountId);
    const reflectionId = DailyReflectionIdSchema.parse(input.reflectionId);
    const candidateId = DailyReflectionIdSchema.parse(input.candidateId);
    const leaseOwner = z.string().trim().min(1).max(512).parse(input.leaseOwner);
    if (!Number.isFinite(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      throw new DailyReflectionConflictError(
        "daily_reflection_invalid_candidate_revocation_lease_duration"
      );
    }
    const now = input.now ?? this.now();
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) {
      throw new DailyReflectionConflictError(
        "daily_reflection_invalid_candidate_revocation_lease_clock"
      );
    }
    const leaseUntil = new Date(nowMs + input.leaseDurationMs).toISOString();
    const run = this.database.transaction(() => {
      this.requireReflectionRow(accountId, reflectionId);
      const admission = this.findAdmissionOperationRow(accountId, reflectionId);
      if (!admission || admission.status === "delete_requested") {
        throw new DailyReflectionConflictError("daily_reflection_delete_requested");
      }
      const row = this.findCandidateRevocationOperationRow(accountId, reflectionId, candidateId);
      if (!row) throw new DailyReflectionNotFoundError();
      if (row.status === "completed") {
        return {
          operation: candidateRevocationOperationFromRow(row),
          executionFence: null,
          reused: true
        };
      }
      if (
        row.status === "revoking"
        && row.lease_owner === leaseOwner
        && row.lease_until
        && row.lease_until > now
      ) {
        return {
          operation: candidateRevocationOperationFromRow(row),
          executionFence: {
            leaseOwner,
            leaseUntil: row.lease_until,
            attemptVersion: row.attempt_version
          },
          reused: true
        };
      }
      if (row.status === "revoking" && row.lease_until && row.lease_until > now) {
        throw new DailyReflectionConflictError(
          "daily_reflection_candidate_revocation_busy"
        );
      }
      const updated = this.database.prepare(`
        UPDATE dr_candidate_revocation_operations
        SET status = 'revoking', attempt_version = attempt_version + 1,
            lease_owner = ?, lease_until = ?, error_code = NULL, updated_at = ?
        WHERE id = ? AND account_id = ? AND (
          status IN ('ready', 'failed')
          OR (status = 'revoking' AND (lease_until IS NULL OR lease_until <= ?))
        )
      `).run(leaseOwner, leaseUntil, now, row.id, accountId, now);
      if (updated.changes !== 1) {
        throw new DailyReflectionConflictError(
          "daily_reflection_candidate_revocation_claim_conflict"
        );
      }
      const claimed = this.findCandidateRevocationOperationRow(accountId, reflectionId, candidateId)!;
      return {
        operation: candidateRevocationOperationFromRow(claimed),
        executionFence: {
          leaseOwner: claimed.lease_owner!,
          leaseUntil: claimed.lease_until!,
          attemptVersion: claimed.attempt_version
        },
        reused: false
      };
    });
    return run.immediate();
  }

  completeCandidateRevocation(input: {
    accountId: string;
    reflectionId: string;
    candidateId: string;
    leaseOwner: string;
    attemptVersion: number;
    result: {
      outcome: "revoked";
      memoryId: string;
      removedMemoryEvidenceCount: number;
      removedPersonSourceCount: number;
    };
    indexRefreshRequired: boolean;
    now?: string;
  }) {
    const accountId = DailyReflectionIdSchema.parse(input.accountId);
    const reflectionId = DailyReflectionIdSchema.parse(input.reflectionId);
    const candidateId = DailyReflectionIdSchema.parse(input.candidateId);
    const leaseOwner = z.string().trim().min(1).max(512).parse(input.leaseOwner);
    const attemptVersion = z.number().int().positive().parse(input.attemptVersion);
    const now = input.now ?? this.now();
    const run = this.database.transaction(() => {
      const existing = this.findCandidateRevocationOperationRow(accountId, reflectionId, candidateId);
      if (!existing) throw new DailyReflectionNotFoundError();
      if (existing.status === "completed") {
        return {
          operation: candidateRevocationOperationFromRow(existing),
          receipt: this.getCandidateRevocationReceipt(accountId, existing.id)!,
          reused: true
        };
      }
      const operation = this.assertCandidateRevocationFence({
        accountId,
        reflectionId,
        candidateId,
        leaseOwner,
        attemptVersion,
        now
      });
      const admission = this.findAdmissionOperationRow(accountId, reflectionId);
      if (!admission || admission.status === "delete_requested") {
        throw new DailyReflectionConflictError("daily_reflection_delete_requested");
      }
      this.database.prepare(`
        INSERT INTO dr_candidate_revocation_receipts (
          account_id, operation_id, reflection_id, confirmation_id,
          candidate_id, outcome, memory_id, removed_memory_evidence_count,
          removed_person_source_count, created_at
        ) VALUES (?, ?, ?, ?, ?, 'revoked', ?, ?, ?, ?)
      `).run(
        accountId,
        operation.id,
        reflectionId,
        operation.confirmation_id,
        candidateId,
        input.result.memoryId,
        input.result.removedMemoryEvidenceCount,
        input.result.removedPersonSourceCount,
        now
      );
      const updated = this.database.prepare(`
        UPDATE dr_candidate_revocation_operations
        SET status = 'completed', lease_owner = NULL, lease_until = NULL,
            error_code = NULL, index_refresh_status = ?,
            updated_at = ?, completed_at = ?
        WHERE id = ? AND account_id = ? AND status = 'revoking'
          AND lease_owner = ? AND attempt_version = ? AND lease_until > ?
      `).run(
        input.indexRefreshRequired ? "pending" : "not_required",
        now,
        now,
        operation.id,
        accountId,
        leaseOwner,
        attemptVersion,
        now
      );
      if (updated.changes !== 1) {
        throw new DailyReflectionConflictError(
          "daily_reflection_candidate_revocation_lease_lost"
        );
      }
      return {
        operation: this.getCandidateRevocationOperation(accountId, reflectionId, candidateId)!,
        receipt: this.getCandidateRevocationReceipt(accountId, operation.id)!,
        reused: false
      };
    });
    return run.immediate();
  }

  failCandidateRevocation(input: {
    accountId: string;
    reflectionId: string;
    candidateId: string;
    leaseOwner: string;
    attemptVersion: number;
    errorCode: string;
    now?: string;
  }) {
    const accountId = DailyReflectionIdSchema.parse(input.accountId);
    const reflectionId = DailyReflectionIdSchema.parse(input.reflectionId);
    const candidateId = DailyReflectionIdSchema.parse(input.candidateId);
    const leaseOwner = z.string().trim().min(1).max(512).parse(input.leaseOwner);
    const attemptVersion = z.number().int().positive().parse(input.attemptVersion);
    const errorCode = z.string().trim().min(1).max(256).parse(input.errorCode);
    const now = input.now ?? this.now();
    const run = this.database.transaction(() => {
      this.assertCandidateRevocationFence({
        accountId,
        reflectionId,
        candidateId,
        leaseOwner,
        attemptVersion,
        now
      });
      const updated = this.database.prepare(`
        UPDATE dr_candidate_revocation_operations
        SET status = 'failed', lease_owner = NULL, lease_until = NULL,
            error_code = ?, updated_at = ?
        WHERE account_id = ? AND reflection_id = ? AND candidate_id = ?
          AND status = 'revoking' AND lease_owner = ?
          AND attempt_version = ? AND lease_until > ?
      `).run(
        errorCode,
        now,
        accountId,
        reflectionId,
        candidateId,
        leaseOwner,
        attemptVersion,
        now
      );
      if (updated.changes !== 1) {
        throw new DailyReflectionConflictError(
          "daily_reflection_candidate_revocation_lease_lost"
        );
      }
      return this.getCandidateRevocationOperation(accountId, reflectionId, candidateId)!;
    });
    return run.immediate();
  }

  setCandidateRevocationIndexRefreshStatus(input: {
    accountId: string;
    reflectionId: string;
    candidateId: string;
    status: "enqueued" | "failed";
    now?: string;
  }) {
    const accountId = DailyReflectionIdSchema.parse(input.accountId);
    const reflectionId = DailyReflectionIdSchema.parse(input.reflectionId);
    const candidateId = DailyReflectionIdSchema.parse(input.candidateId);
    const now = input.now ?? this.now();
    this.database.prepare(`
      UPDATE dr_candidate_revocation_operations
      SET index_refresh_status = ?, updated_at = ?
      WHERE account_id = ? AND reflection_id = ? AND candidate_id = ?
        AND status = 'completed' AND index_refresh_status IN ('pending', 'failed')
    `).run(input.status, now, accountId, reflectionId, candidateId);
    return this.getCandidateRevocationOperation(accountId, reflectionId, candidateId);
  }

  finalizeReview(rawInput: {
    accountId: string;
    reflectionId: string;
    expectedVersion: number;
    idempotencyKey: string;
  }) {
    const input = FinalizeReflectionInputSchema.parse(rawInput);
    const requestFingerprint = stableFingerprint({
      reflectionId: input.reflectionId,
      expectedVersion: input.expectedVersion
    });
    const run = this.database.transaction(() => {
      const reused = this.findConfirmationByIdempotencyKey(
        input.accountId,
        input.idempotencyKey
      );
      if (reused) {
        if (
          reused.reflectionId !== input.reflectionId
          || reused.requestFingerprint !== requestFingerprint
        ) {
          throw new DailyReflectionConflictError("daily_reflection_finalize_idempotency_conflict");
        }
        const operation = this.getAdmissionOperation(input.accountId, input.reflectionId);
        if (!operation) {
          throw new DailyReflectionConflictError("daily_reflection_admission_operation_missing");
        }
        return { confirmation: reused, operation, reused: true };
      }

      const reflectionRow = this.requireReflectionRow(input.accountId, input.reflectionId);
      const reflection = reflectionFromRow(reflectionRow);
      if (reflection.status !== "review_pending") {
        throw new DailyReflectionConflictError("daily_reflection_not_ready_for_confirmation");
      }
      if (reflection.version !== input.expectedVersion) {
        throw new DailyReflectionVersionConflictError(reflection.version);
      }
      const plan = this.findPlanRow(input.accountId, input.reflectionId);
      if (!plan) {
        throw new DailyReflectionConflictError("daily_reflection_processing_plan_missing");
      }
      const canonicalSegments = parseDailyReflectionCanonicalTranscript(
        this.readPublishedAsset<unknown>({
          accountId: input.accountId,
          reflectionId: input.reflectionId,
          assetKind: "segments"
        }),
        plan.upload_id
      );
      if (!canonicalSegments) {
        throw new DailyReflectionConflictError(
          "daily_reflection_confirmation_evidence_unavailable"
        );
      }
      const segmentById = new Map(
        canonicalSegments.map((segment) => [segment.id, segment] as const)
      );
      if (segmentById.size !== canonicalSegments.length) {
        throw new DailyReflectionConflictError(
          "daily_reflection_confirmation_evidence_ambiguous"
        );
      }
      const candidates = this.listCandidateRows(input.accountId, input.reflectionId)
        .map((row) => this.candidateFromRow(input.accountId, row));
      if (candidates.some((candidate) => candidate.status === "pending")) {
        throw new DailyReflectionConflictError("daily_reflection_candidates_pending");
      }
      const snapshots: ReflectionConfirmationCandidateSnapshot[] = candidates.map((candidate) => {
        const evidenceSnapshots = candidate.sourceSegmentIds.map((sourceSegmentId) => {
          const segment = segmentById.get(sourceSegmentId);
          if (!segment) {
            throw new DailyReflectionConflictError(
              "daily_reflection_confirmation_evidence_unavailable"
            );
          }
          return {
            sourceSegmentId,
            uploadId: plan.upload_id,
            startSeconds: segment.startSeconds,
            endSeconds: segment.endSeconds,
            text: segment.text,
            effectiveOrigin: plan.source_origin
          };
        });
        return {
          candidateId: candidate.id,
          proposedText: candidate.proposedText,
          userText: candidate.userText,
          finalText: candidate.userText ?? candidate.proposedText,
          status: candidate.status as "kept" | "excluded",
          candidateType: candidate.candidateType,
          sourceSegmentIds: [...candidate.sourceSegmentIds],
          evidenceSnapshots,
          subjectPersonId: candidate.status === "kept" ? candidate.subjectPersonId : null
        };
      });
      const confirmationFingerprint = stableFingerprint({
        reflectionId: input.reflectionId,
        sourceOrigin: plan.source_origin,
        inputMethod: plan.input_method,
        processingProfile: plan.processing_profile,
        candidates: snapshots
      });
      const confirmationId = this.idFactory();
      const operationId = this.idFactory();
      const now = this.now();
      this.database.prepare(`
        INSERT INTO dr_reflection_confirmations (
          id, account_id, reflection_id, idempotency_key, request_fingerprint,
          confirmation_fingerprint, source_origin, input_method,
          processing_profile, candidate_snapshots_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        confirmationId,
        input.accountId,
        input.reflectionId,
        input.idempotencyKey,
        requestFingerprint,
        confirmationFingerprint,
        plan.source_origin,
        plan.input_method,
        plan.processing_profile,
        JSON.stringify(snapshots),
        now
      );
      const excludedCount = snapshots.filter((candidate) => candidate.status === "excluded").length;
      this.database.prepare(`
        INSERT INTO dr_admission_operations (
          id, account_id, reflection_id, confirmation_id, status,
          admitted_count, rejected_count, excluded_count, error_code,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, 'confirmation_ready', 0, 0, ?, NULL, ?, ?, NULL)
      `).run(
        operationId,
        input.accountId,
        input.reflectionId,
        confirmationId,
        excludedCount,
        now,
        now
      );
      const updated = this.database.prepare(`
        UPDATE dr_reflections
        SET review_status = 'confirmation_ready', version = version + 1,
            updated_at = ?
        WHERE id = ? AND account_id = ? AND version = ?
          AND status = 'review_pending' AND review_status IS NULL
      `).run(now, input.reflectionId, input.accountId, input.expectedVersion);
      if (updated.changes !== 1) {
        throw new DailyReflectionVersionConflictError(
          reflectionFromRow(this.requireReflectionRow(input.accountId, input.reflectionId)).version
        );
      }
      return {
        confirmation: this.getConfirmation(input.accountId, input.reflectionId)!,
        operation: this.getAdmissionOperation(input.accountId, input.reflectionId)!,
        reused: false
      };
    });
    return run();
  }

  startAdmissionOperation(rawInput: {
    accountId: string;
    reflectionId: string;
    leaseOwner: string;
    leaseDurationMs: number;
    now?: string;
  }) {
    const accountId = DailyReflectionIdSchema.parse(rawInput.accountId);
    const reflectionId = DailyReflectionIdSchema.parse(rawInput.reflectionId);
    const leaseOwner = z.string().trim().min(1).max(512).parse(rawInput.leaseOwner);
    if (!Number.isFinite(rawInput.leaseDurationMs) || rawInput.leaseDurationMs <= 0) {
      throw new DailyReflectionConflictError(
        "daily_reflection_invalid_admission_lease_duration"
      );
    }
    const now = rawInput.now ?? this.now();
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) {
      throw new DailyReflectionConflictError(
        "daily_reflection_invalid_admission_lease_clock"
      );
    }
    const leaseUntil = new Date(nowMs + rawInput.leaseDurationMs).toISOString();
    const run = this.database.transaction(() => {
      const operationRow = this.findAdmissionOperationRow(accountId, reflectionId);
      if (!operationRow) {
        throw new DailyReflectionConflictError("daily_reflection_admission_operation_missing");
      }
      if (operationRow.status === "delete_requested") {
        throw new DailyReflectionConflictError("daily_reflection_delete_requested");
      }
      if (operationRow.status === "completed") {
        return {
          operation: admissionOperationFromRow(operationRow),
          executionFence: null,
          reused: true
        };
      }
      if (
        operationRow.status === "admitting"
        && operationRow.lease_owner === leaseOwner
        && operationRow.lease_until
        && operationRow.lease_until > now
      ) {
        return {
          operation: admissionOperationFromRow(operationRow),
          executionFence: {
            leaseOwner,
            leaseUntil: operationRow.lease_until,
            attemptVersion: operationRow.attempt_version
          } satisfies DailyReflectionAdmissionExecutionFence,
          reused: true
        };
      }
      if (
        operationRow.status === "admitting"
        && operationRow.lease_until
        && operationRow.lease_until > now
      ) {
        throw new DailyReflectionConflictError("daily_reflection_admission_busy");
      }
      const updated = this.database.prepare(`
        UPDATE dr_admission_operations
        SET status = 'admitting', error_code = NULL,
            attempt_version = attempt_version + 1,
            lease_owner = ?, lease_until = ?, updated_at = ?, completed_at = NULL
        WHERE id = ? AND account_id = ?
          AND (
            status IN ('confirmation_ready', 'admission_failed')
            OR (status = 'admitting' AND (lease_until IS NULL OR lease_until <= ?))
          )
      `).run(
        leaseOwner,
        leaseUntil,
        now,
        operationRow.id,
        accountId,
        now
      );
      if (updated.changes !== 1) {
        throw new DailyReflectionConflictError("daily_reflection_admission_claim_conflict");
      }
      const reflectionUpdated = this.database.prepare(`
        UPDATE dr_reflections
        SET review_status = 'admitting', version = version + 1, updated_at = ?
        WHERE id = ? AND account_id = ? AND status = 'review_pending'
          AND review_status IN ('confirmation_ready', 'admitting', 'admission_failed')
      `).run(now, reflectionId, accountId);
      if (reflectionUpdated.changes !== 1) {
        throw new DailyReflectionConflictError("daily_reflection_admission_claim_conflict");
      }
      const claimed = this.findAdmissionOperationRow(accountId, reflectionId)!;
      return {
        operation: admissionOperationFromRow(claimed),
        executionFence: {
          leaseOwner: claimed.lease_owner!,
          leaseUntil: claimed.lease_until!,
          attemptVersion: claimed.attempt_version
        } satisfies DailyReflectionAdmissionExecutionFence,
        reused: false
      };
    });
    return run.immediate();
  }

  completeAdmissionOperation(input: {
    accountId: string;
    reflectionId: string;
    leaseOwner: string;
    attemptVersion: number;
    results: CandidateAdmissionResult[];
    now?: string;
  }) {
    const accountId = DailyReflectionIdSchema.parse(input.accountId);
    const reflectionId = DailyReflectionIdSchema.parse(input.reflectionId);
    const leaseOwner = z.string().trim().min(1).max(512).parse(input.leaseOwner);
    const attemptVersion = z.number().int().positive().parse(input.attemptVersion);
    const results = z.array(CandidateAdmissionResultSchema).parse(input.results);
    if (new Set(results.map((result) => result.candidateId)).size !== results.length) {
      throw new DailyReflectionConflictError("daily_reflection_admission_receipt_duplicate");
    }
    if (results.some((result) => result.status === "retryable_error")) {
      throw new DailyReflectionConflictError("daily_reflection_retryable_result_cannot_complete");
    }
    const run = this.database.transaction(() => {
      const operationRow = this.findAdmissionOperationRow(accountId, reflectionId);
      if (!operationRow) {
        throw new DailyReflectionConflictError("daily_reflection_admission_operation_missing");
      }
      const operation = admissionOperationFromRow(operationRow);
      if (operationRow.status === "delete_requested") {
        throw new DailyReflectionConflictError("daily_reflection_delete_requested");
      }
      if (operationRow.status === "completed") {
        return {
          operation,
          results: this.listAdmissionResults(accountId, operation.id),
          reused: true
        };
      }
      const now = input.now ?? this.now();
      this.assertAdmissionFence({
        accountId,
        reflectionId,
        leaseOwner,
        attemptVersion,
        now
      });
      const confirmation = this.getConfirmation(accountId, reflectionId);
      if (!confirmation) {
        throw new DailyReflectionConflictError("daily_reflection_confirmation_missing");
      }
      const keptIds = new Set(
        confirmation.candidateSnapshots
          .filter((candidate) => candidate.status === "kept")
          .map((candidate) => candidate.candidateId)
      );
      if (results.length !== keptIds.size || results.some((result) => !keptIds.has(result.candidateId))) {
        throw new DailyReflectionConflictError("daily_reflection_admission_receipt_mismatch");
      }
      const upsert = this.database.prepare(`
        INSERT INTO dr_candidate_admission_receipts (
          account_id, operation_id, reflection_id, confirmation_id,
          candidate_id, status, memory_id,
          reason_code, error_code, operation_key, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, operation_id, candidate_id) DO UPDATE SET
          status = excluded.status,
          memory_id = excluded.memory_id,
          reason_code = excluded.reason_code,
          error_code = excluded.error_code,
          operation_key = excluded.operation_key,
          updated_at = excluded.updated_at
      `);
      for (const result of results) {
        upsert.run(
          accountId,
          operation.id,
          reflectionId,
          confirmation.id,
          result.candidateId,
          result.status,
          result.memoryId,
          result.reasonCode,
          result.errorCode,
          result.operationKey,
          now
        );
      }
      const admittedCount = results.filter(
        (result) => result.status === "admitted" || result.status === "already_admitted"
      ).length;
      const rejectedCount = results.filter((result) => result.status === "rejected").length;
      const operationUpdated = this.database.prepare(`
        UPDATE dr_admission_operations
        SET status = 'completed', admitted_count = ?, rejected_count = ?,
            error_code = NULL, lease_owner = NULL, lease_until = NULL,
            updated_at = ?, completed_at = ?
        WHERE id = ? AND account_id = ? AND status = 'admitting'
          AND lease_owner = ? AND attempt_version = ? AND lease_until > ?
      `).run(
        admittedCount,
        rejectedCount,
        now,
        now,
        operation.id,
        accountId,
        leaseOwner,
        attemptVersion,
        now
      );
      if (operationUpdated.changes !== 1) {
        throw new DailyReflectionConflictError(
          "daily_reflection_admission_lease_lost"
        );
      }
      const reflectionUpdated = this.database.prepare(`
        UPDATE dr_reflections
        SET review_status = 'completed', version = version + 1, updated_at = ?
        WHERE id = ? AND account_id = ? AND status = 'review_pending'
          AND review_status = 'admitting'
      `).run(now, reflectionId, accountId);
      if (reflectionUpdated.changes !== 1) {
        throw new DailyReflectionConflictError(
          "daily_reflection_admission_completion_conflict"
        );
      }
      return {
        operation: this.getAdmissionOperation(accountId, reflectionId)!,
        results: this.listAdmissionResults(accountId, operation.id),
        reused: false
      };
    });
    return run.immediate();
  }

  failAdmissionOperation(input: {
    accountId: string;
    reflectionId: string;
    leaseOwner: string;
    attemptVersion: number;
    errorCode: string;
    results?: CandidateAdmissionResult[];
    now?: string;
  }) {
    const accountId = DailyReflectionIdSchema.parse(input.accountId);
    const reflectionId = DailyReflectionIdSchema.parse(input.reflectionId);
    const leaseOwner = z.string().trim().min(1).max(512).parse(input.leaseOwner);
    const attemptVersion = z.number().int().positive().parse(input.attemptVersion);
    const errorCode = z.string().trim().min(1).max(256).parse(input.errorCode);
    const results = z.array(CandidateAdmissionResultSchema).parse(input.results ?? []);
    if (new Set(results.map((result) => result.candidateId)).size !== results.length) {
      throw new DailyReflectionConflictError("daily_reflection_admission_receipt_duplicate");
    }
    const run = this.database.transaction(() => {
      const operationRow = this.findAdmissionOperationRow(accountId, reflectionId);
      if (!operationRow) {
        throw new DailyReflectionConflictError("daily_reflection_admission_operation_missing");
      }
      if (operationRow.status === "delete_requested") {
        throw new DailyReflectionConflictError("daily_reflection_delete_requested");
      }
      if (operationRow.status === "completed") {
        return admissionOperationFromRow(operationRow);
      }
      const now = input.now ?? this.now();
      this.assertAdmissionFence({
        accountId,
        reflectionId,
        leaseOwner,
        attemptVersion,
        now
      });
      const confirmation = this.getConfirmation(accountId, reflectionId);
      if (!confirmation) {
        throw new DailyReflectionConflictError("daily_reflection_confirmation_missing");
      }
      const keptIds = new Set(
        confirmation.candidateSnapshots
          .filter((candidate) => candidate.status === "kept")
          .map((candidate) => candidate.candidateId)
      );
      if (results.some((result) => !keptIds.has(result.candidateId))) {
        throw new DailyReflectionConflictError("daily_reflection_admission_receipt_mismatch");
      }
      const upsert = this.database.prepare(`
        INSERT INTO dr_candidate_admission_receipts (
          account_id, operation_id, reflection_id, confirmation_id,
          candidate_id, status, memory_id,
          reason_code, error_code, operation_key, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, operation_id, candidate_id) DO UPDATE SET
          status = excluded.status,
          memory_id = excluded.memory_id,
          reason_code = excluded.reason_code,
          error_code = excluded.error_code,
          operation_key = excluded.operation_key,
          updated_at = excluded.updated_at
      `);
      for (const result of results) {
        upsert.run(
          accountId,
          operationRow.id,
          reflectionId,
          confirmation.id,
          result.candidateId,
          result.status,
          result.memoryId,
          result.reasonCode,
          result.errorCode,
          result.operationKey,
          now
        );
      }
      const operationUpdated = this.database.prepare(`
        UPDATE dr_admission_operations
        SET status = 'admission_failed', error_code = ?,
            lease_owner = NULL, lease_until = NULL,
            updated_at = ?, completed_at = NULL
        WHERE id = ? AND account_id = ? AND status = 'admitting'
          AND lease_owner = ? AND attempt_version = ? AND lease_until > ?
      `).run(
        errorCode,
        now,
        operationRow.id,
        accountId,
        leaseOwner,
        attemptVersion,
        now
      );
      if (operationUpdated.changes !== 1) {
        throw new DailyReflectionConflictError(
          "daily_reflection_admission_lease_lost"
        );
      }
      const reflectionUpdated = this.database.prepare(`
        UPDATE dr_reflections
        SET review_status = 'admission_failed', version = version + 1, updated_at = ?
        WHERE id = ? AND account_id = ? AND status = 'review_pending'
          AND review_status = 'admitting'
      `).run(now, reflectionId, accountId);
      if (reflectionUpdated.changes !== 1) {
        throw new DailyReflectionConflictError(
          "daily_reflection_admission_failure_conflict"
        );
      }
      return this.getAdmissionOperation(accountId, reflectionId)!;
    });
    return run.immediate();
  }

  markAdmissionDeleteRequested(accountId: string, reflectionId: string) {
    const parsedAccountId = DailyReflectionIdSchema.parse(accountId);
    const parsedReflectionId = DailyReflectionIdSchema.parse(reflectionId);
    const run = this.database.transaction(() => {
      const operation = this.getAdmissionOperation(parsedAccountId, parsedReflectionId);
      if (!operation || operation.status === "delete_requested") return operation;
      const now = this.now();
      this.database.prepare(`
        UPDATE dr_admission_operations
        SET status = 'delete_requested', lease_owner = NULL, lease_until = NULL,
            updated_at = ?
        WHERE id = ? AND account_id = ?
      `).run(now, operation.id, parsedAccountId);
      this.database.prepare(`
        UPDATE dr_candidate_revocation_operations
        SET status = 'failed', lease_owner = NULL, lease_until = NULL,
            error_code = 'daily_reflection_delete_requested', updated_at = ?
        WHERE account_id = ? AND reflection_id = ?
          AND status IN ('ready', 'revoking', 'failed')
      `).run(now, parsedAccountId, parsedReflectionId);
      return this.getAdmissionOperation(parsedAccountId, parsedReflectionId);
    });
    return run();
  }

  deleteConfirmationArtifacts(accountId: string, reflectionId: string) {
    const parsedAccountId = DailyReflectionIdSchema.parse(accountId);
    const parsedReflectionId = DailyReflectionIdSchema.parse(reflectionId);
    return this.database.transaction(() => {
      this.database.prepare(`
        DELETE FROM dr_admission_operations
        WHERE account_id = ? AND reflection_id = ?
      `).run(parsedAccountId, parsedReflectionId);
      return this.database.prepare(`
        DELETE FROM dr_reflection_confirmations
        WHERE account_id = ? AND reflection_id = ?
      `).run(parsedAccountId, parsedReflectionId).changes;
    })();
  }

  savePendingCandidates(rawInput: {
    accountId: string;
    reflectionId: string;
    expectedVersion: number;
    candidates: PendingCandidateInput[];
    leaseOwner?: string;
    attemptVersion?: number;
  }) {
    const input = SaveCandidatesInputSchema.parse(rawInput);
    const candidates = [...input.candidates].sort((left, right) => left.ordinal - right.ordinal);
    const run = this.database.transaction(() => {
      const reflectionRow = this.requireReflectionRow(input.accountId, input.reflectionId);
      this.assertLeaseFence(input);
      if (isDailyReflectionTombstone(reflectionRow.status)) {
        throw new DailyReflectionConflictError("daily_reflection_tombstoned");
      }
      const processingPlan = this.findPlanRow(input.accountId, input.reflectionId);
      if (!processingPlan) {
        throw new DailyReflectionConflictError(
          "daily_reflection_processing_plan_missing"
        );
      }
      if (
        reflectionRow.upload_id === null
        || processingPlan.upload_id !== reflectionRow.upload_id
        || processingPlan.input_method !== reflectionRow.input_method
        || processingPlan.source_origin !== reflectionRow.source_origin
        || processingPlan.processing_profile !== reflectionRow.processing_profile
        || processingPlan.ingestion_context !== reflectionRow.ingestion_context
      ) {
        throw new DailyReflectionConflictError(
          "daily_reflection_processing_plan_mismatch"
        );
      }
      if (
        processingPlan.processing_profile === "quick_reflection"
        && candidates.length > DAILY_REFLECTION_QUICK_CANDIDATE_LIMIT
      ) {
        throw new DailyReflectionConflictError(
          "daily_reflection_quick_candidate_limit_exceeded"
        );
      }
      const existing = this.listCandidateRows(input.accountId, input.reflectionId)
        .map((row) => this.candidateFromRow(input.accountId, row));
      if (existing.length > 0) {
        const same = existing.length === candidates.length && existing.every((candidate, index) => {
          const requested = candidates[index];
          return candidate.ordinal === requested.ordinal
            && candidate.proposedText === requested.proposedText
            && candidate.candidateType === requested.candidateType
            && candidate.sourceSegmentIds.length === requested.sourceSegmentIds.length
            && candidate.sourceSegmentIds.every(
              (sourceId, sourceIndex) => sourceId === requested.sourceSegmentIds[sourceIndex]
            );
        });
        if (!same) {
          throw new DailyReflectionConflictError("daily_reflection_candidate_set_conflict");
        }
        return {
          reflection: reflectionFromRow(reflectionRow),
          candidates: existing,
          reused: true
        };
      }
      if (reflectionRow.status !== "extracting") {
        throw new DailyReflectionConflictError("daily_reflection_not_extracting");
      }
      if (reflectionRow.version !== input.expectedVersion) {
        throw new DailyReflectionVersionConflictError(reflectionRow.version);
      }

      const now = this.now();
      const insertCandidate = this.database.prepare(`
        INSERT INTO dr_candidates (
          id, account_id, reflection_id, ordinal, proposed_text, user_text,
          status, candidate_type, subject_person_id, subject_confirmed,
          version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, 'pending', ?, NULL, 0, 0, ?, ?)
      `);
      const insertSource = this.database.prepare(`
        INSERT INTO dr_candidate_sources (
          account_id, candidate_id, position, source_segment_id
        ) VALUES (?, ?, ?, ?)
      `);
      for (const candidate of candidates) {
        const candidateId = candidate.id ?? this.idFactory();
        insertCandidate.run(
          candidateId,
          input.accountId,
          input.reflectionId,
          candidate.ordinal,
          candidate.proposedText,
          candidate.candidateType,
          now,
          now
        );
        candidate.sourceSegmentIds.forEach((sourceSegmentId, position) => {
          insertSource.run(input.accountId, candidateId, position, sourceSegmentId);
        });
      }
      const updated = this.database.prepare(`
        UPDATE dr_reflections
        SET version = version + 1, updated_at = ?
        WHERE id = ? AND account_id = ? AND version = ?
          ${input.leaseOwner
            ? "AND lease_owner = ? AND attempt_version = ? AND lease_until > ?"
            : ""}
      `).run(
        now,
        input.reflectionId,
        input.accountId,
        input.expectedVersion,
        ...(input.leaseOwner
          ? [input.leaseOwner, input.attemptVersion!, now]
          : [])
      );
      if (updated.changes !== 1) {
        throw new DailyReflectionVersionConflictError(
          this.requireReflectionRow(input.accountId, input.reflectionId).version
        );
      }
      return {
        reflection: reflectionFromRow(
          this.requireReflectionRow(input.accountId, input.reflectionId)
        ),
        candidates: this.listCandidateRows(input.accountId, input.reflectionId)
          .map((row) => this.candidateFromRow(input.accountId, row)),
        reused: false
      };
    });
    return run();
  }

  finalizeReviewV2(rawInput: {
    accountId: string;
    reflectionId: string;
    expectedVersion: number;
    operationKey: string;
    saveIntent: "recap_only" | "retain_selected";
  }): {
    confirmation: ReflectionConfirmationV2;
    operation: DailyReflectionAdmissionOperation | null;
    reused: boolean;
  } {
    const input = FinalizeReflectionV2InputSchema.parse(rawInput);
    const requestFingerprint = stableFingerprint({
      contractVersion: 2,
      reflectionId: input.reflectionId,
      expectedVersion: input.expectedVersion,
      saveIntent: input.saveIntent
    });
    const run = this.database.transaction(() => {
      const reused = this.findConfirmationByIdempotencyKey(
        input.accountId,
        input.operationKey
      );
      if (reused) {
        const v2Reused = ReflectionConfirmationV2Schema.safeParse(reused);
        if (
          !v2Reused.success
          || reused.reflectionId !== input.reflectionId
          || reused.requestFingerprint !== requestFingerprint
          || v2Reused.data.operationKey !== input.operationKey
          || v2Reused.data.saveIntent !== input.saveIntent
        ) {
          throw new DailyReflectionConflictError(
            "daily_reflection_finalize_idempotency_conflict"
          );
        }
        const operation = this.getAdmissionOperation(input.accountId, input.reflectionId);
        if (
          (input.saveIntent === "recap_only" && operation !== null)
          || (input.saveIntent === "retain_selected" && operation === null)
        ) {
          throw new DailyReflectionConflictError(
            "daily_reflection_v2_admission_contract_conflict"
          );
        }
        return { confirmation: v2Reused.data, operation, reused: true };
      }

      const reflectionRow = this.requireReflectionRow(input.accountId, input.reflectionId);
      const reflection = reflectionFromRow(reflectionRow);
      if (reflection.status !== "review_pending") {
        throw new DailyReflectionConflictError("daily_reflection_not_ready_for_confirmation");
      }
      if (reflection.version !== input.expectedVersion) {
        throw new DailyReflectionVersionConflictError(reflection.version);
      }
      const v2InputRow = this.findV2InputRow(input.accountId, input.reflectionId);
      if (!v2InputRow || v2InputRow.operation_key !== input.operationKey) {
        throw new DailyReflectionConflictError("daily_reflection_v2_input_mismatch");
      }
      const plan = this.findPlanRow(input.accountId, input.reflectionId);
      if (
        !plan
        || plan.source_origin !== v2InputRow.source_origin
        || plan.ingestion_context !== "daily_reflection"
        || plan.review_policy !== "required"
      ) {
        throw new DailyReflectionConflictError("daily_reflection_processing_plan_mismatch");
      }
      const candidates = this.listCandidateRows(input.accountId, input.reflectionId)
        .map((row) => this.candidateFromRow(input.accountId, row));
      if (
        candidates.length === 0
        || candidates.some((candidate) => candidate.status === "pending")
        || candidates.some((candidate) => !("contractVersion" in candidate))
      ) {
        throw new DailyReflectionConflictError("daily_reflection_candidates_pending");
      }
      const parsedCandidates = candidates.map((candidate) => CandidateV2Schema.safeParse(candidate));
      if (parsedCandidates.some((candidate) => !candidate.success)) {
        throw new DailyReflectionConflictError("daily_reflection_v2_candidate_mismatch");
      }
      const v2Candidates = candidates.map((candidate) => CandidateV2Schema.parse(candidate));
      const confirmationCandidates = v2Candidates.filter((candidate) =>
        !this.isCandidateReviewDeleted(
          input.accountId,
          input.reflectionId,
          candidate.id
        )
      );
      if (confirmationCandidates.length === 0) {
        throw new DailyReflectionConflictError("daily_reflection_candidates_missing");
      }
      if (
        input.saveIntent === "retain_selected"
        && confirmationCandidates.some(
          (candidate) => candidate.status === "kept" && candidate.evidenceIds.length === 0
        )
      ) {
        throw new DailyReflectionConflictError("daily_reflection_retain_requires_evidence");
      }

      const rawCanonicalSegments = this.readPublishedAsset<unknown>({
        accountId: input.accountId,
        reflectionId: input.reflectionId,
        assetKind: "segments"
      });
      const canonicalSegments = parseDailyReflectionCanonicalTranscript(
        rawCanonicalSegments,
        plan.upload_id
      );
      const referencedEvidenceCount = confirmationCandidates.reduce(
        (count, candidate) => count + candidate.evidenceIds.length,
        0
      );
      if (!canonicalSegments && referencedEvidenceCount > 0) {
        throw new DailyReflectionConflictError(
          "daily_reflection_confirmation_evidence_unavailable"
        );
      }
      const segmentById = new Map(
        (canonicalSegments ?? []).map((segment) => [segment.id, segment] as const)
      );
      if (segmentById.size !== (canonicalSegments?.length ?? 0)) {
        throw new DailyReflectionConflictError(
          "daily_reflection_confirmation_evidence_ambiguous"
        );
      }
      const snapshots: ReflectionConfirmationCandidateSnapshotV2[] = confirmationCandidates.map(
        (candidate) => {
          const evidenceSnapshots = candidate.evidenceIds.map((evidenceId) => {
            const segment = segmentById.get(evidenceId);
            if (!segment) {
              throw new DailyReflectionConflictError(
                "daily_reflection_confirmation_evidence_unavailable"
              );
            }
            return {
              sourceSegmentId: evidenceId,
              uploadId: plan.upload_id,
              startSeconds: segment.startSeconds,
              endSeconds: segment.endSeconds,
              text: segment.text,
              effectiveOrigin: v2InputRow.source_origin
            };
          });
          return {
            contractVersion: 2,
            candidateId: candidate.id,
            proposedText: candidate.proposedText,
            userText: candidate.userText,
            finalText: candidate.userText ?? candidate.proposedText,
            status: candidate.status as "kept" | "excluded",
            candidateKind: candidate.candidateKind,
            candidateType: legacyCandidateKindForV2(candidate),
            evidenceIds: [...candidate.evidenceIds],
            sourceSegmentIds: [...candidate.evidenceIds],
            evidenceSnapshots,
            confidence: candidate.confidence,
            caution: candidate.caution,
            actionClaimed: candidate.actionClaimed,
            subjectPersonId: null
          };
        }
      );
      const confirmationFingerprint = stableFingerprint({
        contractVersion: 2,
        reflectionId: input.reflectionId,
        operationKey: input.operationKey,
        sourceOrigin: v2InputRow.source_origin,
        inputAdapter: v2InputRow.input_adapter,
        capturePurpose: v2InputRow.capture_purpose,
        recordingDate: v2InputRow.recording_date,
        saveIntent: input.saveIntent,
        candidates: snapshots
      });
      const confirmationId = this.idFactory();
      const now = this.now();
      this.database.prepare(`
        INSERT INTO dr_reflection_confirmations (
          id, account_id, reflection_id, idempotency_key, request_fingerprint,
          confirmation_fingerprint, source_origin, input_method,
          processing_profile, candidate_snapshots_json, created_at,
          contract_version, save_intent, operation_key, input_adapter,
          capture_purpose, recording_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, ?, ?)
      `).run(
        confirmationId,
        input.accountId,
        input.reflectionId,
        input.operationKey,
        requestFingerprint,
        confirmationFingerprint,
        v2InputRow.source_origin,
        plan.input_method,
        plan.processing_profile,
        JSON.stringify(snapshots),
        now,
        input.saveIntent,
        input.operationKey,
        v2InputRow.input_adapter,
        v2InputRow.capture_purpose,
        v2InputRow.recording_date
      );

      let operation: DailyReflectionAdmissionOperation | null = null;
      if (input.saveIntent === "retain_selected") {
        const operationId = this.idFactory();
        const excludedCount = snapshots.filter(
          (candidate) => candidate.status === "excluded"
        ).length;
        this.database.prepare(`
          INSERT INTO dr_admission_operations (
            id, account_id, reflection_id, confirmation_id, status,
            admitted_count, rejected_count, excluded_count, error_code,
            created_at, updated_at, completed_at
          ) VALUES (?, ?, ?, ?, 'confirmation_ready', 0, 0, ?, NULL, ?, ?, NULL)
        `).run(
          operationId,
          input.accountId,
          input.reflectionId,
          confirmationId,
          excludedCount,
          now,
          now
        );
        const updated = this.database.prepare(`
          UPDATE dr_reflections
          SET review_status = 'confirmation_ready', version = version + 1,
              updated_at = ?
          WHERE id = ? AND account_id = ? AND version = ?
            AND status = 'review_pending' AND review_status IS NULL
        `).run(now, input.reflectionId, input.accountId, input.expectedVersion);
        if (updated.changes !== 1) {
          throw new DailyReflectionVersionConflictError(
            reflectionFromRow(
              this.requireReflectionRow(input.accountId, input.reflectionId)
            ).version
          );
        }
        operation = this.getAdmissionOperation(input.accountId, input.reflectionId);
      } else {
        assertDailyReflectionTransition("review_pending", "confirmation_ready");
        assertDailyReflectionTransition("confirmation_ready", "completed");
        const updated = this.database.prepare(`
          UPDATE dr_reflections
          SET review_status = 'completed', version = version + 1, updated_at = ?
          WHERE id = ? AND account_id = ? AND version = ?
            AND status = 'review_pending' AND review_status IS NULL
        `).run(now, input.reflectionId, input.accountId, input.expectedVersion);
        if (updated.changes !== 1) {
          throw new DailyReflectionVersionConflictError(
            reflectionFromRow(
              this.requireReflectionRow(input.accountId, input.reflectionId)
            ).version
          );
        }
      }
      const confirmation = this.getConfirmation(input.accountId, input.reflectionId);
      const parsedConfirmation = ReflectionConfirmationV2Schema.safeParse(confirmation);
      if (!parsedConfirmation.success) {
        throw new DailyReflectionConflictError("daily_reflection_confirmation_invalid");
      }
      return { confirmation: parsedConfirmation.data, operation, reused: false };
    });
    return run.immediate();
  }

  savePendingCandidatesV2(rawInput: {
    accountId: string;
    reflectionId: string;
    expectedVersion: number;
    candidates: PendingCandidateV2Input[];
    leaseOwner?: string;
    attemptVersion?: number;
  }) {
    const input = SaveCandidatesV2InputSchema.parse(rawInput);
    const candidates = [...input.candidates].sort((left, right) => left.ordinal - right.ordinal);
    const run = this.database.transaction(() => {
      const reflectionRow = this.requireReflectionRow(input.accountId, input.reflectionId);
      this.assertLeaseFence(input);
      if (isDailyReflectionTombstone(reflectionRow.status)) {
        throw new DailyReflectionConflictError("daily_reflection_tombstoned");
      }
      const v2Input = this.findV2InputRow(input.accountId, input.reflectionId);
      if (!v2Input) {
        throw new DailyReflectionConflictError("daily_reflection_v2_input_missing");
      }
      const processingPlan = this.findPlanRow(input.accountId, input.reflectionId);
      const processingPlanV2 = this.findPlanV2Row(input.accountId, input.reflectionId);
      if (
        !processingPlan
        || reflectionRow.upload_id === null
        || processingPlan.upload_id !== reflectionRow.upload_id
        || processingPlan.source_origin !== v2Input.source_origin
        || processingPlan.ingestion_context !== "daily_reflection"
      ) {
        throw new DailyReflectionConflictError("daily_reflection_processing_plan_mismatch");
      }
      if (
        candidates.length
        > (processingPlanV2?.candidate_limit ?? DAILY_REFLECTION_QUICK_CANDIDATE_LIMIT)
      ) {
        throw new DailyReflectionConflictError("daily_reflection_candidate_limit_exceeded");
      }
      const existing = this.listCandidateRows(input.accountId, input.reflectionId)
        .map((row) => this.candidateFromRow(input.accountId, row));
      if (existing.length > 0) {
        const same = existing.length === candidates.length && existing.every((candidate, index) => {
          const requested = candidates[index];
          const parsedCandidate = CandidateV2Schema.safeParse(candidate);
          return parsedCandidate.success
            && parsedCandidate.data.ordinal === requested.ordinal
            && parsedCandidate.data.proposedText === requested.proposedText
            && parsedCandidate.data.candidateKind === requested.candidateKind
            && parsedCandidate.data.confidence === requested.confidence
            && parsedCandidate.data.caution === requested.caution
            && parsedCandidate.data.actionClaimed === requested.actionClaimed
            && parsedCandidate.data.evidenceIds.length === requested.evidenceIds.length
            && parsedCandidate.data.evidenceIds.every(
              (evidenceId, evidenceIndex) => evidenceId === requested.evidenceIds[evidenceIndex]
            );
        });
        if (!same) {
          throw new DailyReflectionConflictError("daily_reflection_candidate_set_conflict");
        }
        return { reflection: reflectionFromRow(reflectionRow), candidates: existing, reused: true };
      }
      if (reflectionRow.status !== "extracting") {
        throw new DailyReflectionConflictError("daily_reflection_not_extracting");
      }
      if (reflectionRow.version !== input.expectedVersion) {
        throw new DailyReflectionVersionConflictError(reflectionRow.version);
      }

      const now = this.now();
      const insertCandidate = this.database.prepare(`
        INSERT INTO dr_candidates (
          id, account_id, reflection_id, ordinal, proposed_text, user_text,
          status, candidate_type, subject_person_id, subject_confirmed,
          version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, 'pending', ?, NULL, 0, 0, ?, ?)
      `);
      const insertSource = this.database.prepare(`
        INSERT INTO dr_candidate_sources (
          account_id, candidate_id, position, source_segment_id
        ) VALUES (?, ?, ?, ?)
      `);
      const insertMetadata = this.database.prepare(`
        INSERT INTO dr_candidate_v2_metadata (
          account_id, reflection_id, candidate_id, candidate_kind,
          evidence_ids_json, confidence, caution, action_claimed,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const candidate of candidates) {
        const candidateId = candidate.id ?? this.idFactory();
        const candidateType = legacyCandidateKindForV2(candidate);
        insertCandidate.run(
          candidateId,
          input.accountId,
          input.reflectionId,
          candidate.ordinal,
          candidate.proposedText,
          candidateType,
          now,
          now
        );
        candidate.evidenceIds.forEach((evidenceId, position) => {
          insertSource.run(input.accountId, candidateId, position, evidenceId);
        });
        insertMetadata.run(
          input.accountId,
          input.reflectionId,
          candidateId,
          candidate.candidateKind,
          JSON.stringify(candidate.evidenceIds),
          candidate.confidence,
          candidate.caution,
          candidate.actionClaimed ? 1 : 0,
          now,
          now
        );
      }
      const updated = this.database.prepare(`
        UPDATE dr_reflections
        SET version = version + 1, updated_at = ?
        WHERE id = ? AND account_id = ? AND version = ?
          ${input.leaseOwner
            ? "AND lease_owner = ? AND attempt_version = ? AND lease_until > ?"
            : ""}
      `).run(
        now,
        input.reflectionId,
        input.accountId,
        input.expectedVersion,
        ...(input.leaseOwner ? [input.leaseOwner, input.attemptVersion!, now] : [])
      );
      if (updated.changes !== 1) {
        throw new DailyReflectionVersionConflictError(
          this.requireReflectionRow(input.accountId, input.reflectionId).version
        );
      }
      return {
        reflection: reflectionFromRow(
          this.requireReflectionRow(input.accountId, input.reflectionId)
        ),
        candidates: this.listCandidateRows(input.accountId, input.reflectionId)
          .map((row) => this.candidateFromRow(input.accountId, row)),
        reused: false
      };
    });
    return run();
  }

  createPendingCandidates(input: Parameters<DailyReflectionRepository["savePendingCandidates"]>[0]) {
    return this.savePendingCandidates(input);
  }

  getReflectionDetail(accountId: string, reflectionId: string) {
    const operation = this.getAdmissionOperation(accountId, reflectionId);
    return {
      reflection: this.getReflection(accountId, reflectionId),
      processingPlan: this.getProcessingPlan(accountId, reflectionId),
      candidates: this.listCandidates(accountId, reflectionId),
      confirmation: this.getConfirmation(accountId, reflectionId),
      admissionOperation: operation,
      admissionResults: operation
        ? this.listAdmissionResults(accountId, operation.id)
        : []
    };
  }
}

export function createDailyReflectionRepository(
  database: Database.Database,
  options: DailyReflectionRepositoryOptions = {}
) {
  return new DailyReflectionRepository(database, options);
}
