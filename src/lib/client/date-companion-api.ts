import { z } from "zod";

import { parseQaBrowserNdjsonStream } from "@/lib/client/qa-ndjson-stream";
import { DayPayloadSchema, RecordingDateSchema, type DayPayload } from "@/lib/domain/day-payload";
import type {
  AuthUser,
  DateCompanionConfirmedPerson,
  DateCompanionMemoryBridgeReview,
  DateCompanionMemoryBridgeStatus,
  DateCompanionMemoryReview,
  DateCompanionMemorySubject,
  DateCompanionPersonMapping,
  DateCompanionRelationshipReconfirmationRequest,
  DateCompanionRelationshipType,
  DateCompanionRetentionSetting,
  DateCompanionSelfBinding,
  FailedUploadReceipt,
  ToyIngestionReceipt,
  UploadReceipt
} from "@/lib/domain/date-companion";
import {
  DATE_COMPANION_UPLOAD_CONTEXT_FIELD,
  DATE_COMPANION_UPLOAD_CONTEXT_VALUE
} from "@/lib/domain/date-companion-upload";
import {
  DateCompanionPersonSourceCatalogSchema,
  type DateCompanionPersonSourceCatalog
} from "@/lib/domain/date-companion-person-source";
import {
  DcCreateRelationshipRequestSchema,
  DcCreateRelationshipResponseSchema,
  DcDeleteInteractionResponseSchema,
  DcIdSchema,
  DcImportInteractionRequestSchema,
  DcImportInteractionResponseSchema,
  DcPatchPromiseRequestSchema,
  DcRelationshipViewResponseSchema,
  DcRelationshipsResponseSchema,
  DcSearchResponseSchema,
  DcMemoryBridgeReviewSchema,
  DcUpdateParticipantsRequestSchema,
  DcUpdateRecapRequestSchema,
  type DcCreateRelationshipRequest,
  type DcImportInteractionRequest,
  type DcPatchPromiseRequest,
  type DcRelationship,
  type DcRelationshipView,
  type DcSearchResult,
  type DcSubjectSuggestionConfirmation,
  type DcUpdateParticipantsRequest,
  type DcUpdateRecapRequest
} from "@/lib/domain/date-companion-stage2";
import type {
  AudioInsight,
  BriefItem,
  QuestionAnswer,
  RelationshipSignalCard,
  SemanticSegment,
  TranscriptSegment
} from "@/lib/domain/types";
import type { QaBrowserStreamEvent } from "@/lib/qa-browser-stream";

const StoreKeySchema = z.string().min(1).regex(/^[A-Za-z0-9_-]+$/u);
const VirtualDayIdSchema = z.string().regex(/^day_\d{4}-\d{2}-\d{2}$/u);

export const AuthUserSchema = z
  .object({
    id: z.string().min(1),
    email: z.string().email(),
    name: z.string().min(1).optional()
  })
  .strict();

const AuthResponseSchema = z.object({ user: AuthUserSchema }).strict();

export const ToyIngestionReceiptSchema = z.object({
  receiptId: StoreKeySchema,
  operationKey: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
  destination: z.literal("date_companion"),
  relationshipId: DcIdSchema,
  // Accepted only for compatibility with receipts created by the earlier
  // full-ledger experiment. The minimal recovery request never sends it.
  generation: z.number().int().nonnegative().optional(),
  uploadId: StoreKeySchema,
  jobId: StoreKeySchema,
  state: z.enum(["reserving", "accepted", "processing", "completed", "failed", "deleted"]),
  decision: z.enum(["accepted", "replayed", "already_uploaded"]),
  recordingDate: RecordingDateSchema,
  serverAcceptedAt: z.string().datetime().optional(),
  processingAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  failedAt: z.string().datetime().optional(),
  sourceCleanedAt: z.string().datetime().optional(),
  deletedAt: z.string().datetime().optional(),
  reimportOfReceiptId: StoreKeySchema.optional()
}).strict();

export const UploadReceiptSchema = z
  .object({
    uploadId: StoreKeySchema,
    jobId: StoreKeySchema,
    status: z.enum(["uploaded", "waiting"]),
    executionMode: z.enum(["inline", "queue"]).optional(),
    queueJobId: StoreKeySchema.optional(),
    enqueueDeferred: z.boolean().optional(),
    warning: z.literal("pipeline_queue_unavailable").optional(),
    evaluationRetention: z.boolean().optional(),
    ingestionReceipt: ToyIngestionReceiptSchema.optional()
  })
  .strict()
  .superRefine((receipt, context) => {
    const preAcceptToyReceipt = receipt.ingestionReceipt?.state === "reserving";
    if (
      receipt.status === "waiting"
      && receipt.executionMode !== "queue"
      && !preAcceptToyReceipt
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executionMode"],
        message: "waiting uploads must identify queue execution"
      });
    }
    if (receipt.executionMode === "queue" && !receipt.queueJobId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["queueJobId"],
        message: "queue uploads require queueJobId"
      });
    }
    if (receipt.enqueueDeferred && receipt.executionMode !== "queue") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["enqueueDeferred"],
        message: "deferred enqueue is only valid for queue uploads"
      });
    }
    if (receipt.enqueueDeferred && receipt.warning !== "pipeline_queue_unavailable") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["warning"],
        message: "deferred enqueue must identify the queue warning"
      });
    }
  });

export const FailedUploadResponseSchema = z
  .object({
    error: z.string().min(1),
    uploadId: StoreKeySchema,
    jobId: StoreKeySchema,
    status: z.literal("failed"),
    ingestionReceipt: ToyIngestionReceiptSchema.optional()
  })
  .passthrough();

export type FailedUploadResponse = z.infer<typeof FailedUploadResponseSchema> & FailedUploadReceipt;

const LogoutResponseSchema = z.object({ ok: z.literal(true) }).strict();
const ErrorResponseSchema = z
  .object({
    error: z.string().min(1).optional(),
    message: z.string().min(1).optional()
  })
  .passthrough();

const NullableDateTimeSchema = z.string().datetime().nullable();
const PersonAdmissionSchema = z.object({
  id: z.string().trim().min(1).max(512),
  displayName: z.string().trim().min(1).max(500).nullable(),
  status: z.enum(["candidate", "confirmed", "archived"]),
  version: z.number().int().positive(),
  explicitlyConfirmed: z.boolean(),
  confirmedAt: NullableDateTimeSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).passthrough();
const ConfirmedPersonSchema = PersonAdmissionSchema.extend({
  status: z.literal("confirmed"),
  explicitlyConfirmed: z.literal(true),
  confirmedAt: z.string().datetime()
});
const PeopleResponseSchema = z.object({ people: z.array(ConfirmedPersonSchema) }).strict();
const PersonResponseSchema = z.object({ person: PersonAdmissionSchema }).strict();
const SelfBindingSchema = z.object({
  personId: z.string().trim().min(1).max(512).nullable(),
  status: z.enum(["active", "cleared"]),
  version: z.number().int().positive(),
  setAt: NullableDateTimeSchema,
  clearedAt: NullableDateTimeSchema,
  updatedAt: z.string().datetime()
}).strict();
const SelfBindingResponseSchema = z.object({ selfBinding: SelfBindingSchema.nullable() }).strict();
const RetentionSettingSchema = z.object({
  enabled: z.boolean(),
  version: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  enabledAt: NullableDateTimeSchema,
  disabledAt: NullableDateTimeSchema
}).strict();
const RetentionSettingResponseSchema = z.object({ setting: RetentionSettingSchema }).strict();
const PersonMappingSchema = z.object({
  id: DcIdSchema,
  selfPersonId: z.string().trim().min(1).max(512),
  companionPersonId: z.string().trim().min(1).max(512),
  relationshipType: z.enum(["dating", "partner", "friend", "other"]),
  status: z.enum(["confirmed", "needs_review", "archived"]),
  version: z.number().int().positive(),
  confirmedAt: NullableDateTimeSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();
const PersonMappingResponseSchema = z.object({ mapping: PersonMappingSchema.nullable() }).strict();
const MemoryBridgeStatusSchema = z.enum([
  "waiting_for_cleanup",
  "pending",
  "processing",
  "completed",
  "retryable_failed",
  "needs_review",
  "cancelled"
]);
const MemoryReviewInteractionSchema = z.object({
  interactionId: DcIdSchema,
  sourceUploadId: DcIdSchema,
  recordingDate: RecordingDateSchema,
  sourceState: z.enum(["available", "server_cleaned", "explicitly_deleted"]),
  status: z.union([MemoryBridgeStatusSchema, z.literal("not_queued")]),
  attemptCount: z.number().int().nonnegative(),
  selectionCount: z.number().int().nonnegative(),
  unknownCount: z.number().int().nonnegative(),
  updatedAt: NullableDateTimeSchema,
  review: DcMemoryBridgeReviewSchema.optional()
}).strict();
const MemoryReviewSchema = z.object({
  retention: RetentionSettingSchema,
  mapping: PersonMappingSchema.nullable(),
  interactions: z.array(MemoryReviewInteractionSchema)
}).strict();
const MemoryReviewResponseSchema = z.object({ review: MemoryReviewSchema }).strict();
const BridgeStatusSchema = z.object({
  status: MemoryBridgeStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
  retryable: z.boolean(),
  review: DcMemoryBridgeReviewSchema.optional()
}).strict();
const MemorySyncResponseSchema = z.object({ bridge: BridgeStatusSchema.nullable() }).strict();
const RetainedSourceSchema = z.object({
  uploadId: z.string().trim().min(1).max(512),
  sourceSegmentId: z.string().trim().min(1).max(512),
  quote: z.string().trim().min(1).max(4_000)
}).passthrough();
const PersonMemoriesResponseSchema = z.object({
  memories: z.array(z.object({
    subjectPersonIds: z.array(z.string().trim().min(1).max(512)).min(1),
    evidenceLinks: z.array(z.object({
      personEvidence: RetainedSourceSchema,
      contentDigest: z.string().length(64).regex(/^[a-f0-9]+$/u).optional()
    }).passthrough())
  }).passthrough())
}).passthrough();
const PERSON_MEMORY_RECORD_LIMIT = 200;
const PurgeResponseSchema = z.object({
  purge: z.object({
    purgeId: z.string().trim().min(1).max(512),
    status: z.string().trim().min(1),
    totalCount: z.number().int().nonnegative(),
    completedCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    retryable: z.boolean(),
    updatedAt: z.string().datetime()
  }).strict()
}).strict();

export type DateCompanionRetainedSource = {
  uploadId: string;
  sourceSegmentId: string;
  quote: string;
  contentDigest?: string;
  subjectPersonIds: string[];
};

export type LoginInput = {
  email: string;
  password: string;
};

export const RegisterInputSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8),
    name: z.string().trim().min(1).max(80).optional(),
    inviteCode: z.string().trim().min(1).max(200)
  })
  .strict();

export type RegisterInput = z.input<typeof RegisterInputSchema>;

export type DateCompanionToyUploadRequest = Readonly<{
  operationKey: string;
  destination: "date_companion";
  relationshipId: string;
}>;

export type QaConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export type CurrentInteractionQaInput = {
  uploadId: string;
  question: string;
  conversation?: QaConversationMessage[];
  segments: TranscriptSegment[];
  audioInsights: AudioInsight[];
  semanticSegments: SemanticSegment[];
  briefItems: BriefItem[];
  relationshipSignals: RelationshipSignalCard[];
  signal?: AbortSignal;
};

export type RelationshipQaInput = {
  relationshipId: string;
  question: string;
  conversation?: QaConversationMessage[];
  signal?: AbortSignal;
};

export type PersonQaInput = {
  personId: string;
  question: string;
  conversation?: QaConversationMessage[];
  signal?: AbortSignal;
};

export type PollDayOptions = {
  signal?: AbortSignal;
  intervalMs?: number;
  onPayload?: (payload: DayPayload) => void;
};

export type DateCompanionDeletePrecondition = {
  interactionId: string;
  expectedVersion: number;
};

export interface DateCompanionApi {
  getCurrentUser(signal?: AbortSignal): Promise<AuthUser | null>;
  login(input: LoginInput, signal?: AbortSignal): Promise<AuthUser>;
  register(input: RegisterInput, signal?: AbortSignal): Promise<AuthUser>;
  logout(signal?: AbortSignal): Promise<void>;
  upload(
    file: File,
    recordingDate: string,
    signal?: AbortSignal,
    toyRequest?: DateCompanionToyUploadRequest
  ): Promise<UploadReceipt>;
  getToyIngestionReceipt(
    request: DateCompanionToyUploadRequest,
    signal?: AbortSignal
  ): Promise<ToyIngestionReceipt | null>;
  getDay(uploadId: string, signal?: AbortSignal): Promise<DayPayload>;
  pollDay(uploadId: string, options?: PollDayOptions): Promise<DayPayload>;
  cleanupUpload(uploadId: string, signal?: AbortSignal): Promise<void>;
  deleteSourceUpload(
    uploadId: string,
    precondition: DateCompanionDeletePrecondition,
    signal?: AbortSignal
  ): Promise<void>;
  listRelationships(signal?: AbortSignal): Promise<DcRelationship[]>;
  createRelationship(
    input: DcCreateRelationshipRequest,
    signal?: AbortSignal
  ): Promise<{ relationship: DcRelationship; reused: boolean }>;
  getRelationshipView(relationshipId: string, signal?: AbortSignal): Promise<DcRelationshipView>;
  importInteraction(
    relationshipId: string,
    input: DcImportInteractionRequest,
    signal?: AbortSignal
  ): Promise<{ interactionId: string; reused: boolean; view: DcRelationshipView }>;
  updateParticipants(
    interactionId: string,
    input: DcUpdateParticipantsRequest,
    signal?: AbortSignal
  ): Promise<DcRelationshipView>;
  updateRecap(
    interactionId: string,
    input: DcUpdateRecapRequest,
    signal?: AbortSignal
  ): Promise<DcRelationshipView>;
  patchPromise(
    promiseId: string,
    input: DcPatchPromiseRequest,
    signal?: AbortSignal
  ): Promise<DcRelationshipView>;
  searchRelationship(relationshipId: string, query: string, signal?: AbortSignal): Promise<DcSearchResult[]>;
  deleteInteraction(
    interactionId: string,
    expectedVersion: number,
    signal?: AbortSignal
  ): Promise<void>;
  streamCurrentInteractionQa(input: CurrentInteractionQaInput): AsyncGenerator<QaBrowserStreamEvent>;
  streamRelationshipQa(input: RelationshipQaInput): AsyncGenerator<QaBrowserStreamEvent>;
  streamPersonQa(input: PersonQaInput): AsyncGenerator<QaBrowserStreamEvent>;
  listConfirmedPeople(signal?: AbortSignal): Promise<DateCompanionConfirmedPerson[]>;
  createPersonCandidate(input: { idempotencyKey: string; displayName: string }, signal?: AbortSignal): Promise<z.infer<typeof PersonAdmissionSchema>>;
  confirmPerson(personId: string, expectedVersion: number, signal?: AbortSignal): Promise<DateCompanionConfirmedPerson>;
  getSelfBinding(signal?: AbortSignal): Promise<DateCompanionSelfBinding | null>;
  setSelfBinding(personId: string, expectedVersion: number, signal?: AbortSignal): Promise<DateCompanionSelfBinding>;
  getMemorySetting(signal?: AbortSignal): Promise<DateCompanionRetentionSetting>;
  updateMemorySetting(enabled: boolean, expectedVersion: number, signal?: AbortSignal): Promise<DateCompanionRetentionSetting>;
  getPersonMapping(relationshipId: string, signal?: AbortSignal): Promise<DateCompanionPersonMapping | null>;
  updatePersonMapping(relationshipId: string, input: {
    selfPersonId: string;
    companionPersonId: string;
    relationshipType: DateCompanionRelationshipType;
    expectedVersion: number;
  }, signal?: AbortSignal): Promise<DateCompanionPersonMapping>;
  getMemoryReview(relationshipId: string, signal?: AbortSignal): Promise<DateCompanionMemoryReview>;
  getPersonSourceCatalog(
    relationshipId: string,
    signal?: AbortSignal
  ): Promise<DateCompanionPersonSourceCatalog>;
  getPersonRetainedSources(personId: string, signal?: AbortSignal): Promise<DateCompanionRetainedSource[]>;
  syncInteractionMemory(interactionId: string, input: {
    mappingVersion: number;
    subjectSuggestionConfirmation?: DcSubjectSuggestionConfirmation;
    selections?: Array<{ evidenceSnapshotId: string; subject: DateCompanionMemorySubject }>;
    relationshipReconfirmation?: DateCompanionRelationshipReconfirmationRequest;
  }, signal?: AbortSignal): Promise<{
    status: DateCompanionMemoryBridgeStatus;
    attemptCount: number;
    updatedAt: string;
    retryable: boolean;
    review?: DateCompanionMemoryBridgeReview;
  } | null>;
  purgeRetainedMemory(relationshipId: string, signal?: AbortSignal): Promise<z.infer<typeof PurgeResponseSchema>["purge"]>;
}

export class DateCompanionApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(input: { status: number; code: string; message?: string; details?: unknown; cause?: unknown }) {
    super(input.message ?? input.code, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "DateCompanionApiError";
    this.status = input.status;
    this.code = input.code;
    this.details = input.details;
  }
}

export function isRealDateCompanionUploadId(uploadId: string): boolean {
  return StoreKeySchema.safeParse(uploadId).success && !VirtualDayIdSchema.safeParse(uploadId).success;
}

function assertRealUploadId(uploadId: string): string {
  if (!isRealDateCompanionUploadId(uploadId)) {
    throw new DateCompanionApiError({
      status: 400,
      code: "invalid_upload_id",
      message: "A real recording upload ID is required"
    });
  }
  return uploadId;
}

function assertCompanionId(value: string, code: string): string {
  const parsed = DcIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new DateCompanionApiError({ status: 400, code, message: "A valid date-companion ID is required" });
  }
  return parsed.data;
}

function assertRecordId(value: string, code: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > 512 || /\s/u.test(normalized)) {
    throw new DateCompanionApiError({ status: 400, code, message: "A valid record ID is required" });
  }
  return normalized;
}

function assertExpectedVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DateCompanionApiError({
      status: 400,
      code: "invalid_interaction_version",
      message: "A non-negative interaction version is required"
    });
  }
  return value;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function waitForNextPoll(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function responsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new DateCompanionApiError({
      status: response.status,
      code: "invalid_response",
      message: "Server returned invalid JSON",
      cause
    });
  }
}

function apiError(response: Response, payload: unknown): DateCompanionApiError {
  const parsed = ErrorResponseSchema.safeParse(payload);
  const code = parsed.success ? parsed.data.error ?? `http_${response.status}` : `http_${response.status}`;
  const message = parsed.success ? parsed.data.message ?? code : code;
  return new DateCompanionApiError({ status: response.status, code, message, details: payload });
}

async function parseJsonResponse<Schema extends z.ZodTypeAny>(
  response: Response,
  schema: Schema
): Promise<z.output<Schema>> {
  const payload = await responsePayload(response);
  if (!response.ok) throw apiError(response, payload);

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new DateCompanionApiError({
      status: response.status,
      code: "invalid_response",
      message: "Server response did not match the expected contract",
      cause: parsed.error
    });
  }
  return parsed.data;
}

export function createDateCompanionApi(fetcher: typeof fetch = fetch): DateCompanionApi {
  const sameOrigin = (input: RequestInfo | URL, init?: RequestInit) =>
    fetcher(input, { ...init, credentials: "same-origin" });

  return {
    async getCurrentUser(signal) {
      const response = await sameOrigin("/api/auth/me", { method: "GET", signal });
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      return (await parseJsonResponse(response, AuthResponseSchema)).user;
    },

    async login(input, signal) {
      const response = await sameOrigin("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal
      });
      return (await parseJsonResponse(response, AuthResponseSchema)).user;
    },

    async register(input, signal) {
      const body = RegisterInputSchema.parse(input);
      const response = await sameOrigin("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal
      });
      return (await parseJsonResponse(response, AuthResponseSchema)).user;
    },

    async logout(signal) {
      const response = await sameOrigin("/api/auth/logout", { method: "POST", signal });
      await parseJsonResponse(response, LogoutResponseSchema);
    },

    async upload(file, recordingDate, signal, toyRequest) {
      const normalizedDate = RecordingDateSchema.parse(recordingDate);
      const body = new FormData();
      body.append("file", file);
      body.append("recordingDate", normalizedDate);
      body.append(
        DATE_COMPANION_UPLOAD_CONTEXT_FIELD,
        DATE_COMPANION_UPLOAD_CONTEXT_VALUE
      );
      if (toyRequest) {
        const operationKey = toyRequest.operationKey.trim();
        if (!/^[A-Za-z0-9_-]{1,128}$/u.test(operationKey)) {
          throw new DateCompanionApiError({
            status: 400,
            code: "invalid_toy_operation_key"
          });
        }
        if (toyRequest.destination !== "date_companion") {
          throw new DateCompanionApiError({
            status: 400,
            code: "invalid_toy_destination"
          });
        }
        const relationshipId = assertCompanionId(
          toyRequest.relationshipId,
          "invalid_toy_relationship_id"
        );
        body.append("toyOperationKey", operationKey);
        body.append("toyDestination", toyRequest.destination);
        body.append("toyRelationshipId", relationshipId);
      }
      const response = await sameOrigin("/api/uploads", {
        method: "POST",
        body,
        signal
      });
      const payload = await responsePayload(response);
      if (!response.ok) {
        const failedUpload = FailedUploadResponseSchema.safeParse(payload);
        if (failedUpload.success) {
          throw new DateCompanionApiError({
            status: response.status,
            code: failedUpload.data.error,
            message: failedUpload.data.error,
            details: failedUpload.data
          });
        }
        throw apiError(response, payload);
      }
      const parsed = UploadReceiptSchema.safeParse(payload);
      if (!parsed.success) {
        throw new DateCompanionApiError({
          status: response.status,
          code: "invalid_response",
          message: "Server response did not match the expected upload contract",
          cause: parsed.error
        });
      }
      return parsed.data;
    },

    async getToyIngestionReceipt(toyRequest, signal) {
      const operationKey = toyRequest.operationKey.trim();
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(operationKey)) {
        throw new DateCompanionApiError({ status: 400, code: "invalid_toy_operation_key" });
      }
      if (toyRequest.destination !== "date_companion") {
        throw new DateCompanionApiError({ status: 400, code: "invalid_toy_destination" });
      }
      const relationshipId = assertCompanionId(
        toyRequest.relationshipId,
        "invalid_toy_relationship_id"
      );
      const query = new URLSearchParams({
        operationKey,
        destination: toyRequest.destination,
        relationshipId
      });
      const response = await sameOrigin(`/api/uploads/toy-receipts?${query.toString()}`, {
        method: "GET",
        signal
      });
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      return (await parseJsonResponse(
        response,
        z.object({ ingestionReceipt: ToyIngestionReceiptSchema }).strict()
      )).ingestionReceipt;
    },

    async getDay(uploadId, signal) {
      const realUploadId = assertRealUploadId(uploadId);
      const response = await sameOrigin(`/api/days/${encodeURIComponent(realUploadId)}`, {
        method: "GET",
        signal
      });
      return parseJsonResponse(response, DayPayloadSchema);
    },

    async pollDay(uploadId, options = {}) {
      const realUploadId = assertRealUploadId(uploadId);
      const intervalMs = Math.max(0, options.intervalMs ?? 1_200);

      while (true) {
        const payload = await this.getDay(realUploadId, options.signal);
        options.onPayload?.(payload);
        const status = payload.job?.status ?? payload.upload.status;
        if (status === "ready" || status === "failed") return payload;
        await waitForNextPoll(intervalMs, options.signal);
      }
    },

    async cleanupUpload(uploadId, signal) {
      const realUploadId = assertRealUploadId(uploadId);
      const response = await sameOrigin(`/api/uploads/${encodeURIComponent(realUploadId)}`, {
        method: "DELETE",
        headers: { "x-daily-brief-cleanup-mode": "browser-cache" },
        signal
      });
      if (!response.ok) {
        const payload = await responsePayload(response);
        throw apiError(response, payload);
      }
      await response.body?.cancel().catch(() => undefined);
    },

    async deleteSourceUpload(uploadId, precondition, signal) {
      const realUploadId = assertRealUploadId(uploadId);
      const interactionId = assertCompanionId(
        precondition.interactionId,
        "invalid_interaction_id"
      );
      const expectedVersion = assertExpectedVersion(precondition.expectedVersion);
      const response = await sameOrigin(`/api/uploads/${encodeURIComponent(realUploadId)}`, {
        method: "DELETE",
        // The person page uses a second explicit confirmation before this call.
        // Preserve the evaluation-retention contract instead of bypassing it.
        headers: {
          "x-evaluation-delete-confirmed": "true",
          "x-date-companion-interaction-id": interactionId,
          "if-match": `"${expectedVersion}"`
        },
        signal
      });
      if (!response.ok) {
        const payload = await responsePayload(response);
        throw apiError(response, payload);
      }
      await response.body?.cancel().catch(() => undefined);
    },

    async listRelationships(signal) {
      const response = await sameOrigin("/api/date-companion/relationships", { method: "GET", signal });
      return (await parseJsonResponse(response, DcRelationshipsResponseSchema)).relationships;
    },

    async createRelationship(input, signal) {
      const body = DcCreateRelationshipRequestSchema.parse(input);
      const response = await sameOrigin("/api/date-companion/relationships", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal
      });
      return parseJsonResponse(response, DcCreateRelationshipResponseSchema);
    },

    async getRelationshipView(relationshipId, signal) {
      const id = assertCompanionId(relationshipId, "invalid_relationship_id");
      const response = await sameOrigin(`/api/date-companion/relationships/${encodeURIComponent(id)}/view`, {
        method: "GET",
        signal
      });
      return (await parseJsonResponse(response, DcRelationshipViewResponseSchema)).view;
    },

    async importInteraction(relationshipId, input, signal) {
      const id = assertCompanionId(relationshipId, "invalid_relationship_id");
      const body = DcImportInteractionRequestSchema.parse(input);
      const response = await sameOrigin(`/api/date-companion/relationships/${encodeURIComponent(id)}/interactions/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal
      });
      return parseJsonResponse(response, DcImportInteractionResponseSchema);
    },

    async updateParticipants(interactionId, input, signal) {
      const id = assertCompanionId(interactionId, "invalid_interaction_id");
      const body = DcUpdateParticipantsRequestSchema.parse(input);
      const response = await sameOrigin(`/api/date-companion/interactions/${encodeURIComponent(id)}/participants`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal
      });
      return (await parseJsonResponse(response, DcRelationshipViewResponseSchema)).view;
    },

    async updateRecap(interactionId, input, signal) {
      const id = assertCompanionId(interactionId, "invalid_interaction_id");
      const body = DcUpdateRecapRequestSchema.parse(input);
      const response = await sameOrigin(`/api/date-companion/interactions/${encodeURIComponent(id)}/recap`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal
      });
      return (await parseJsonResponse(response, DcRelationshipViewResponseSchema)).view;
    },

    async patchPromise(promiseId, input, signal) {
      const id = assertCompanionId(promiseId, "invalid_promise_id");
      const body = DcPatchPromiseRequestSchema.parse(input);
      const response = await sameOrigin(`/api/date-companion/promises/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal
      });
      return (await parseJsonResponse(response, DcRelationshipViewResponseSchema)).view;
    },

    async searchRelationship(relationshipId, query, signal) {
      const id = assertCompanionId(relationshipId, "invalid_relationship_id");
      const normalizedQuery = query.trim();
      if (!normalizedQuery) return [];
      const response = await sameOrigin(
        `/api/date-companion/relationships/${encodeURIComponent(id)}/search?q=${encodeURIComponent(normalizedQuery)}`,
        { method: "GET", signal }
      );
      return (await parseJsonResponse(response, DcSearchResponseSchema)).results;
    },

    async deleteInteraction(interactionId, expectedVersion, signal) {
      const id = assertCompanionId(interactionId, "invalid_interaction_id");
      const version = assertExpectedVersion(expectedVersion);
      const response = await sameOrigin(`/api/date-companion/interactions/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "if-match": `"${version}"` },
        signal
      });
      await parseJsonResponse(response, DcDeleteInteractionResponseSchema);
    },

    async listConfirmedPeople(signal) {
      const response = await sameOrigin("/api/people", { method: "GET", signal });
      const people = (await parseJsonResponse(response, PeopleResponseSchema)).people;
      return people.map((person) => ({
        id: person.id,
        displayName: person.displayName,
        status: person.status,
        version: person.version,
        explicitlyConfirmed: person.explicitlyConfirmed,
        confirmedAt: person.confirmedAt,
        createdAt: person.createdAt,
        updatedAt: person.updatedAt
      }));
    },

    async createPersonCandidate(input, signal) {
      const displayName = input.displayName.normalize("NFKC").trim();
      const idempotencyKey = input.idempotencyKey.normalize("NFKC").trim();
      if (!displayName || displayName.length > 500 || !idempotencyKey || /\s/u.test(idempotencyKey)) {
        throw new DateCompanionApiError({ status: 400, code: "invalid_person_request" });
      }
      const response = await sameOrigin("/api/people", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey, displayName }),
        signal
      });
      return (await parseJsonResponse(response, PersonResponseSchema)).person;
    },

    async confirmPerson(personId, expectedVersion, signal) {
      const id = assertRecordId(personId, "invalid_person_id");
      const response = await sameOrigin(`/api/people/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "confirm", expectedVersion: assertExpectedVersion(expectedVersion) }),
        signal
      });
      const person = (await parseJsonResponse(response, PersonResponseSchema)).person;
      const confirmed = ConfirmedPersonSchema.safeParse(person);
      if (!confirmed.success) {
        throw new DateCompanionApiError({ status: response.status, code: "person_confirmation_incomplete" });
      }
      return confirmed.data;
    },

    async getSelfBinding(signal) {
      const response = await sameOrigin("/api/people/self", { method: "GET", signal });
      return (await parseJsonResponse(response, SelfBindingResponseSchema)).selfBinding;
    },

    async setSelfBinding(personId, expectedVersion, signal) {
      const id = assertRecordId(personId, "invalid_person_id");
      const response = await sameOrigin("/api/people/self", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personId: id, expectedVersion: assertExpectedVersion(expectedVersion) }),
        signal
      });
      const binding = (await parseJsonResponse(response, SelfBindingResponseSchema)).selfBinding;
      if (!binding) throw new DateCompanionApiError({ status: response.status, code: "self_binding_missing" });
      return binding;
    },

    async getMemorySetting(signal) {
      const response = await sameOrigin("/api/date-companion/memory-settings", { method: "GET", signal });
      return (await parseJsonResponse(response, RetentionSettingResponseSchema)).setting;
    },

    async updateMemorySetting(enabled, expectedVersion, signal) {
      const response = await sameOrigin("/api/date-companion/memory-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, expectedVersion: assertExpectedVersion(expectedVersion) }),
        signal
      });
      return (await parseJsonResponse(response, RetentionSettingResponseSchema)).setting;
    },

    async getPersonMapping(relationshipId, signal) {
      const id = assertCompanionId(relationshipId, "invalid_relationship_id");
      const response = await sameOrigin(`/api/date-companion/relationships/${encodeURIComponent(id)}/person-mapping`, {
        method: "GET",
        signal
      });
      return (await parseJsonResponse(response, PersonMappingResponseSchema)).mapping;
    },

    async updatePersonMapping(relationshipId, input, signal) {
      const id = assertCompanionId(relationshipId, "invalid_relationship_id");
      const response = await sameOrigin(`/api/date-companion/relationships/${encodeURIComponent(id)}/person-mapping`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selfPersonId: assertRecordId(input.selfPersonId, "invalid_self_person_id"),
          companionPersonId: assertRecordId(input.companionPersonId, "invalid_companion_person_id"),
          relationshipType: PersonMappingSchema.shape.relationshipType.parse(input.relationshipType),
          expectedVersion: assertExpectedVersion(input.expectedVersion)
        }),
        signal
      });
      const mapping = (await parseJsonResponse(response, PersonMappingResponseSchema)).mapping;
      if (!mapping) throw new DateCompanionApiError({ status: response.status, code: "person_mapping_missing" });
      return mapping;
    },

    async getMemoryReview(relationshipId, signal) {
      const id = assertCompanionId(relationshipId, "invalid_relationship_id");
      const response = await sameOrigin(`/api/date-companion/relationships/${encodeURIComponent(id)}/memory-review`, {
        method: "GET",
        signal
      });
      return (await parseJsonResponse(response, MemoryReviewResponseSchema)).review;
    },

    async getPersonSourceCatalog(relationshipId, signal) {
      const id = assertCompanionId(relationshipId, "invalid_relationship_id");
      const response = await sameOrigin(
        `/api/date-companion/relationships/${encodeURIComponent(id)}/person-source-catalog`,
        { method: "GET", signal }
      );
      return parseJsonResponse(response, DateCompanionPersonSourceCatalogSchema);
    },

    async getPersonRetainedSources(personId, signal) {
      const id = assertRecordId(personId, "invalid_person_id");
      const response = await sameOrigin(`/api/people/${encodeURIComponent(id)}/memories?limit=${PERSON_MEMORY_RECORD_LIMIT}`, {
        method: "GET",
        signal
      });
      const payload = await parseJsonResponse(response, PersonMemoriesResponseSchema);
      if (payload.memories.length >= PERSON_MEMORY_RECORD_LIMIT) {
        throw new DateCompanionApiError({
          status: 409,
          code: "person_memory_source_limit_reached",
          message: "人物内容数量已经达到当前安全读取上限"
        });
      }
      const bySource = new Map<string, DateCompanionRetainedSource>();
      const conflictingSources = new Set<string>();
      for (const memory of payload.memories) {
        for (const link of memory.evidenceLinks) {
          const source = link.personEvidence;
          const key = `${source.uploadId}\u0000${source.sourceSegmentId}`;
          const existing = bySource.get(key);
          if (
            existing
            && (
              existing.quote !== source.quote
              || existing.contentDigest !== link.contentDigest
            )
          ) {
            conflictingSources.add(key);
            continue;
          }
          bySource.set(key, {
            uploadId: source.uploadId,
            sourceSegmentId: source.sourceSegmentId,
            quote: source.quote,
            ...(link.contentDigest ? { contentDigest: link.contentDigest } : {}),
            subjectPersonIds: [...new Set([...(existing?.subjectPersonIds ?? []), ...memory.subjectPersonIds])]
          });
        }
      }
      return [...bySource.entries()]
        .filter(([key]) => !conflictingSources.has(key))
        .map(([, source]) => source);
    },

    async syncInteractionMemory(interactionId, input, signal) {
      const id = assertCompanionId(interactionId, "invalid_interaction_id");
      const response = await sameOrigin(`/api/date-companion/interactions/${encodeURIComponent(id)}/memory-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal
      });
      return (await parseJsonResponse(response, MemorySyncResponseSchema)).bridge;
    },

    async purgeRetainedMemory(relationshipId, signal) {
      const id = assertCompanionId(relationshipId, "invalid_relationship_id");
      const response = await sameOrigin(`/api/date-companion/relationships/${encodeURIComponent(id)}/retained-memory`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "purge_retained_memory" }),
        signal
      });
      return (await parseJsonResponse(response, PurgeResponseSchema)).purge;
    },

    async *streamCurrentInteractionQa(input) {
      const uploadId = assertRealUploadId(input.uploadId);
      const response = await sameOrigin("/api/days/context/qa", {
        method: "POST",
        headers: {
          Accept: "application/x-ndjson",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          uploadId,
          scope: "current",
          question: input.question,
          ...(input.conversation && input.conversation.length > 0 ? { conversation: input.conversation } : {}),
          promptPresetId: "date",
          segments: input.segments,
          audioInsights: input.audioInsights,
          semanticSegments: input.semanticSegments,
          briefItems: input.briefItems,
          relationshipSignals: input.relationshipSignals
        }),
        signal: input.signal
      });

      if (!response.ok) {
        const payload = await responsePayload(response);
        throw apiError(response, payload);
      }
      if (!response.body) {
        throw new DateCompanionApiError({
          status: response.status,
          code: "missing_response_stream",
          message: "QA response stream was unavailable"
        });
      }

      for await (const event of parseQaBrowserNdjsonStream(response.body)) {
        yield event;
      }
    },

    async *streamRelationshipQa(input) {
      const relationshipId = assertCompanionId(input.relationshipId, "invalid_relationship_id");
      const response = await sameOrigin(
        `/api/date-companion/relationships/${encodeURIComponent(relationshipId)}/qa`,
        {
          method: "POST",
          headers: {
            Accept: "application/x-ndjson",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            question: input.question,
            ...(input.conversation && input.conversation.length > 0
              ? { conversation: input.conversation }
              : {})
          }),
          signal: input.signal
        }
      );

      if (!response.ok) {
        const payload = await responsePayload(response);
        throw apiError(response, payload);
      }
      if (!response.body) {
        throw new DateCompanionApiError({
          status: response.status,
          code: "missing_response_stream",
          message: "QA response stream was unavailable"
        });
      }

      for await (const event of parseQaBrowserNdjsonStream(response.body)) {
        yield event;
      }
    },

    async *streamPersonQa(input) {
      const personId = assertCompanionId(input.personId, "invalid_person_id");
      const response = await sameOrigin(
        `/api/people/${encodeURIComponent(personId)}/qa`,
        {
          method: "POST",
          headers: {
            Accept: "application/x-ndjson",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            question: input.question,
            ...(input.conversation && input.conversation.length > 0
              ? { conversation: input.conversation }
              : {})
          }),
          signal: input.signal
        }
      );

      if (!response.ok) {
        const payload = await responsePayload(response);
        throw apiError(response, payload);
      }
      if (!response.body) {
        throw new DateCompanionApiError({
          status: response.status,
          code: "missing_response_stream",
          message: "QA response stream was unavailable"
        });
      }

      for await (const event of parseQaBrowserNdjsonStream(response.body)) {
        yield event;
      }
    }
  };
}

export function qaAnswerFromEvents(events: QaBrowserStreamEvent[]): QuestionAnswer | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "final") return event.answer;
  }
  return null;
}
