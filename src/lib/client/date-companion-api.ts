import { z } from "zod";

import { parseQaBrowserNdjsonStream } from "@/lib/client/qa-ndjson-stream";
import { DayPayloadSchema, RecordingDateSchema, type DayPayload } from "@/lib/domain/day-payload";
import type { AuthUser, FailedUploadReceipt, UploadReceipt } from "@/lib/domain/date-companion";
import {
  DATE_COMPANION_UPLOAD_CONTEXT_FIELD,
  DATE_COMPANION_UPLOAD_CONTEXT_VALUE
} from "@/lib/domain/date-companion-upload";
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
  DcUpdateParticipantsRequestSchema,
  DcUpdateRecapRequestSchema,
  type DcCreateRelationshipRequest,
  type DcImportInteractionRequest,
  type DcPatchPromiseRequest,
  type DcRelationship,
  type DcRelationshipView,
  type DcSearchResult,
  type DcUpdateParticipantsRequest,
  type DcUpdateRecapRequest
} from "@/lib/domain/date-companion-stage2";
import type {
  AudioInsight,
  BriefItem,
  QuestionAnswer,
  RelationshipSignalCard,
  SemanticSegment,
  SpeakerAliasesByUploadId,
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

export const UploadReceiptSchema = z
  .object({
    uploadId: StoreKeySchema,
    jobId: StoreKeySchema,
    status: z.enum(["uploaded", "waiting"]),
    executionMode: z.enum(["inline", "queue"]).optional(),
    queueJobId: StoreKeySchema.optional(),
    enqueueDeferred: z.boolean().optional(),
    warning: z.literal("pipeline_queue_unavailable").optional(),
    evaluationRetention: z.boolean().optional()
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.status === "waiting" && receipt.executionMode !== "queue") {
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
    status: z.literal("failed")
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

export type LoginInput = {
  email: string;
  password: string;
};

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
  speakerAliasesByUploadId?: SpeakerAliasesByUploadId;
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
  logout(signal?: AbortSignal): Promise<void>;
  upload(file: File, recordingDate: string, signal?: AbortSignal): Promise<UploadReceipt>;
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

const HYBRID_INDEX_MAINTENANCE_RETRY_TIMEOUT_MS = 2 * 60 * 1_000;

function responseErrorCode(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const error = (payload as { error?: unknown }).error;
  return typeof error === "string" ? error : null;
}

function retryAfterMilliseconds(response: Response) {
  const seconds = Number(response.headers.get("retry-after") ?? "2");
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(5_000, Math.max(250, Math.round(seconds * 1_000)))
    : 2_000;
}

async function deleteWithHybridIndexRetry(input: {
  request: () => Promise<Response>;
  pendingError: "hybrid_index_pending" | "hybrid_index_deletion_pending";
  signal?: AbortSignal;
}) {
  const deadline = Date.now() + HYBRID_INDEX_MAINTENANCE_RETRY_TIMEOUT_MS;
  while (true) {
    const response = await input.request();
    if (response.ok) return response;
    const payload = await responsePayload(response);
    if (
      response.status === 409 &&
      responseErrorCode(payload) === input.pendingError &&
      Date.now() < deadline
    ) {
      await waitForNextPoll(retryAfterMilliseconds(response), input.signal);
      continue;
    }
    throw apiError(response, payload);
  }
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

    async logout(signal) {
      const response = await sameOrigin("/api/auth/logout", { method: "POST", signal });
      await parseJsonResponse(response, LogoutResponseSchema);
    },

    async upload(file, recordingDate, signal) {
      const normalizedDate = RecordingDateSchema.parse(recordingDate);
      const body = new FormData();
      body.append("file", file);
      body.append("recordingDate", normalizedDate);
      body.append(
        DATE_COMPANION_UPLOAD_CONTEXT_FIELD,
        DATE_COMPANION_UPLOAD_CONTEXT_VALUE
      );
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
      const response = await deleteWithHybridIndexRetry({
        request: () => sameOrigin(`/api/uploads/${encodeURIComponent(realUploadId)}`, {
          method: "DELETE",
          headers: { "x-daily-brief-cleanup-mode": "browser-cache" },
          signal
        }),
        pendingError: "hybrid_index_pending",
        signal
      });
      await response.body?.cancel().catch(() => undefined);
    },

    async deleteSourceUpload(uploadId, precondition, signal) {
      const realUploadId = assertRealUploadId(uploadId);
      const interactionId = assertCompanionId(
        precondition.interactionId,
        "invalid_interaction_id"
      );
      const expectedVersion = assertExpectedVersion(precondition.expectedVersion);
      const response = await deleteWithHybridIndexRetry({
        request: () => sameOrigin(`/api/uploads/${encodeURIComponent(realUploadId)}`, {
          method: "DELETE",
          // The person page uses a second explicit confirmation before this call.
          // Preserve the evaluation-retention contract instead of bypassing it.
          headers: {
            "x-evaluation-delete-confirmed": "true",
            "x-date-companion-interaction-id": interactionId,
            "if-match": `"${expectedVersion}"`
          },
          signal
        }),
        pendingError: "hybrid_index_deletion_pending",
        signal
      });
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
      const response = await deleteWithHybridIndexRetry({
        request: () => sameOrigin(`/api/date-companion/interactions/${encodeURIComponent(id)}`, {
          method: "DELETE",
          headers: { "if-match": `"${version}"` },
          signal
        }),
        pendingError: "hybrid_index_deletion_pending",
        signal
      });
      await parseJsonResponse(response, DcDeleteInteractionResponseSchema);
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
          relationshipSignals: input.relationshipSignals,
          ...(input.speakerAliasesByUploadId
            ? { speakerAliasesByUploadId: input.speakerAliasesByUploadId }
            : {})
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
