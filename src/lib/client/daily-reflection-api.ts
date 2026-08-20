import { z } from "zod";

import { AuthUserSchema } from "@/lib/client/date-companion-api";
import { RecordingDateSchema } from "@/lib/domain/day-payload";
import {
  DailyReflectionClientReportedDurationMsSchema
} from "@/lib/domain/daily-reflection-duration";
import {
  DailyReflectionCandidateUpdateRequestSchema,
  DailyReflectionCandidateUpdateResponseSchema,
  DailyReflectionCandidateRevocationRequestSchema,
  DailyReflectionCandidateRevocationResponseSchema,
  DailyReflectionDetailResponseSchema,
  DailyReflectionFinalizeRequestSchema,
  DailyReflectionFinalizeResponseSchema,
  DailyReflectionHistoryResponseSchema,
  DailyReflectionUploadSourceSchema,
  type DailyReflectionCandidateUpdateRequest,
  type DailyReflectionCandidateUpdateResponse,
  type DailyReflectionCandidateRevocationRequest,
  type DailyReflectionCandidateRevocationResponse,
  type DailyReflectionDetailResponse,
  type DailyReflectionFinalizeRequest,
  type DailyReflectionFinalizeResponse,
  type DailyReflectionHistoryItem,
  type DailyReflectionUploadSource
} from "@/lib/domain/daily-reflection-api";
import {
  DailyReflectionIdSchema,
  DailyReflectionStatusSchema
} from "@/lib/domain/daily-reflection";
import type { AuthUser, DateCompanionConfirmedPerson } from "@/lib/domain/date-companion";
import { PipelineExecutionModeSchema } from "@/lib/domain/types";

export {
  DailyReflectionUploadSourceSchema,
  type DailyReflectionUploadSource
};

export type DailyReflectionUploadInput = Readonly<{
  file: File;
  sourceOrigin: DailyReflectionUploadSource;
  idempotencyKey: string;
  recordingDate: string;
  inputAdapter?: "toy_sync";
}>;

export type DailyReflectionBrowserRecordingInput = Readonly<{
  file: File;
  idempotencyKey: string;
  recordingDate: string;
  clientReportedDurationMs?: number;
}>;

const DailyReflectionUploadInputSchema = z.object({
  file: z.custom<File>(
    (value) => typeof File !== "undefined" && value instanceof File,
    "A recording file is required"
  ),
  sourceOrigin: DailyReflectionUploadSourceSchema,
  idempotencyKey: z.string().trim().min(1).max(512),
  recordingDate: RecordingDateSchema,
  inputAdapter: z.literal("toy_sync").optional()
}).strict();

const DailyReflectionBrowserRecordingInputSchema = z.object({
  file: z.custom<File>(
    (value) => typeof File !== "undefined" && value instanceof File,
    "A browser recording file is required"
  ),
  idempotencyKey: z.string().trim().min(1).max(512),
  recordingDate: RecordingDateSchema,
  clientReportedDurationMs: DailyReflectionClientReportedDurationMsSchema.optional()
}).strict();

const AuthResponseSchema = z.object({ user: AuthUserSchema }).strict();
const LogoutResponseSchema = z.object({ ok: z.literal(true) }).strict();
const ConfirmedPersonSchema = z.object({
  id: z.string().trim().min(1),
  displayName: z.string().trim().min(1).max(200).nullable(),
  status: z.literal("confirmed"),
  version: z.number().int().positive(),
  explicitlyConfirmed: z.literal(true),
  confirmedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).passthrough();
const ConfirmedPeopleResponseSchema = z.object({
  people: z.array(ConfirmedPersonSchema)
}).strict();

const DailyReflectionUploadReceiptSchema = z.object({
  reflectionId: DailyReflectionIdSchema,
  uploadId: DailyReflectionIdSchema,
  jobId: DailyReflectionIdSchema,
  status: DailyReflectionStatusSchema,
  executionMode: PipelineExecutionModeSchema,
  queueJobId: DailyReflectionIdSchema.optional(),
  persistencePending: z.boolean().optional(),
  enqueueDeferred: z.boolean().optional(),
  warning: z.literal("pipeline_queue_unavailable").optional(),
  reused: z.boolean().optional()
}).strict();

const DailyReflectionActionReceiptSchema = z.object({
  reflectionId: DailyReflectionIdSchema,
  uploadId: DailyReflectionIdSchema,
  jobId: DailyReflectionIdSchema,
  status: DailyReflectionStatusSchema,
  executionMode: PipelineExecutionModeSchema,
  queueJobId: DailyReflectionIdSchema.optional(),
  enqueueDeferred: z.boolean().optional(),
  warning: z.literal("pipeline_queue_unavailable").optional()
}).strict();

const DailyReflectionCancelReceiptSchema = z.object({
  reflectionId: DailyReflectionIdSchema,
  status: z.literal("cancelled")
}).strict();

const ErrorCodeResponseSchema = z.object({
  error: z.string().trim().min(1).max(256),
  message: z.string().max(4_000).optional(),
  reflectionId: DailyReflectionIdSchema.optional(),
  uploadId: DailyReflectionIdSchema.optional(),
  currentVersion: z.number().int().nonnegative().optional(),
  retryable: z.boolean().optional()
}).strict();

export type DailyReflectionUploadReceipt = z.infer<
  typeof DailyReflectionUploadReceiptSchema
>;
export type DailyReflectionActionReceipt = z.infer<
  typeof DailyReflectionActionReceiptSchema
>;
export type DailyReflectionCancelReceipt = z.infer<
  typeof DailyReflectionCancelReceiptSchema
>;

export interface DailyReflectionApi {
  getCurrentUser(signal?: AbortSignal): Promise<AuthUser | null>;
  logout(signal?: AbortSignal): Promise<void>;
  listConfirmedPeople(signal?: AbortSignal): Promise<DateCompanionConfirmedPerson[]>;
  list(signal?: AbortSignal): Promise<DailyReflectionHistoryItem[]>;
  upload(
    input: DailyReflectionUploadInput,
    signal?: AbortSignal
  ): Promise<DailyReflectionUploadReceipt>;
  uploadBrowserRecording(
    input: DailyReflectionBrowserRecordingInput,
    signal?: AbortSignal
  ): Promise<DailyReflectionUploadReceipt>;
  get(
    reflectionId: string,
    signal?: AbortSignal
  ): Promise<DailyReflectionDetailResponse>;
  updateCandidates(
    reflectionId: string,
    input: DailyReflectionCandidateUpdateRequest,
    signal?: AbortSignal
  ): Promise<DailyReflectionCandidateUpdateResponse>;
  finalize(
    reflectionId: string,
    input: DailyReflectionFinalizeRequest,
    signal?: AbortSignal
  ): Promise<DailyReflectionFinalizeResponse>;
  revokeCandidate(
    reflectionId: string,
    candidateId: string,
    input: DailyReflectionCandidateRevocationRequest,
    signal?: AbortSignal
  ): Promise<DailyReflectionCandidateRevocationResponse>;
  cancel(
    reflectionId: string,
    signal?: AbortSignal
  ): Promise<DailyReflectionCancelReceipt>;
  retry(
    reflectionId: string,
    signal?: AbortSignal
  ): Promise<DailyReflectionActionReceipt>;
  delete(reflectionId: string, signal?: AbortSignal): Promise<void>;
}

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  unauthenticated: "登录已失效，请重新登录。",
  feature_disabled: "日常复盘暂时不可用。",
  daily_reflection_not_found: "这条复盘不存在或已被删除。",
  invalid_reflection_id: "复盘记录无效，请返回后重试。",
  invalid_upload_input: "请选择来源、录音日期和音频文件。",
  invalid_multipart: "录音上传内容无效，请重新选择文件。",
  missing_file: "请选择要上传的音频文件。",
  empty_file: "所选音频文件为空。",
  file_too_large: "音频文件不能超过 300MB。",
  unsupported_audio_format: "暂不支持这种音频格式。",
  invalid_source_origin: "请选择这段录音的来源。",
  invalid_idempotency_key: "上传请求无效，请重新尝试。",
  invalid_upload_body: "无法读取所选音频，请重新选择文件。",
  daily_reflection_idempotency_conflict: "这次上传与已有记录不一致，请重新选择文件。",
  daily_reflection_cancelled: "这条复盘已取消。",
  daily_reflection_upload_persist_failed: "录音暂时无法保存，请稍后重试。",
  daily_reflection_evidence_unavailable: "复盘内容暂时无法加载，请稍后重试。",
  daily_reflection_cannot_cancel_failed: "处理已停止，可重试或删除这条记录。",
  daily_reflection_retry_requires_failed: "当前记录无需重试。",
  daily_reflection_retry_requires_upload_binding: "原录音已不可用，无法重试。",
  daily_reflection_cancel_conflict: "取消未完成，请刷新后重试。",
  daily_reflection_delete_conflict: "删除未完成，请刷新后重试。",
  daily_reflection_cleanup_failed: "清理录音未完成，请稍后重试。",
  invalid_candidate_update: "这条内容的选择无法保存，请重新检查后再试。",
  invalid_finalize_input: "这次确认无法提交，请重新加载后再试。",
  version_conflict: "这份复盘已经在其他页面更新，请重新加载最新内容。",
  daily_reflection_subject_invalid: "所选人物已经不可用，请重新加载最新内容。",
  daily_reflection_review_not_editable: "这份复盘已经不能继续修改，请重新加载最新内容。",
  daily_reflection_candidate_finalized: "这条内容已经完成确认，请重新加载最新内容。",
  daily_reflection_candidates_pending: "还有内容没有选择是否记住，请先完成确认。",
  daily_reflection_finalize_idempotency_conflict: "这次确认状态已经变化，请重新加载最新内容。",
  invalid_candidate_revocation_target: "这条内容无法撤销，请重新加载最新内容。",
  invalid_candidate_revocation_input: "撤销请求无效，请重新加载后再试。",
  daily_reflection_candidate_revocation_conflict: "撤销状态正在变化，请稍后重试。",
  daily_reflection_candidate_revocation_failed: "这条内容暂时没有撤销成功，请稍后重试。",
  daily_reflection_candidate_revocation_memory_failed: "这条内容暂时没有撤销成功，请稍后重试。",
  daily_reflection_candidate_revocation_receipt_failed: "撤销结果暂时没有确认，请稍后重试。",
  daily_reflection_candidate_revocation_index_refresh_failed: "这条内容已开始撤销，请稍后重试确认结果。",
  invalid_response: "服务器返回了无法识别的数据，请稍后重试。",
  network_error: "网络连接失败，请检查网络后重试。"
};

function fallbackErrorMessage(status: number): string {
  if (status === 401) return ERROR_MESSAGES.unauthenticated;
  if (status === 404) return "请求的复盘记录不可用。";
  if (status === 409) return "这份复盘已经在其他页面更新，请重新加载最新内容。";
  if (status >= 400 && status < 500) return "请求内容有误，请检查后重试。";
  return "暂时无法完成操作，请稍后重试。";
}

function errorMessage(status: number, code: string): string {
  return ERROR_MESSAGES[code] ?? fallbackErrorMessage(status);
}

export class DailyReflectionApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    status: number,
    code: string,
    message: string = errorMessage(status, code),
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "DailyReflectionApiError";
    this.status = status;
    this.code = code;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function responsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new DailyReflectionApiError(
      response.status,
      "invalid_response",
      errorMessage(response.status, "invalid_response"),
      { cause }
    );
  }
}

function responseError(response: Response, payload: unknown): DailyReflectionApiError {
  const parsed = ErrorCodeResponseSchema.safeParse(payload);
  const code = response.status === 401
    ? "unauthenticated"
    : parsed.success
      ? parsed.data.error
      : `http_${response.status}`;
  return new DailyReflectionApiError(response.status, code);
}

async function parseJsonResponse<Schema extends z.ZodTypeAny>(
  response: Response,
  schema: Schema
): Promise<z.output<Schema>> {
  const payload = await responsePayload(response);
  if (!response.ok) throw responseError(response, payload);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new DailyReflectionApiError(
      response.status,
      "invalid_response",
      errorMessage(response.status, "invalid_response"),
      { cause: parsed.error }
    );
  }
  return parsed.data;
}

function reflectionPath(reflectionId: string): string {
  const parsed = DailyReflectionIdSchema.safeParse(reflectionId);
  if (!parsed.success) {
    throw new DailyReflectionApiError(400, "invalid_reflection_id");
  }
  return `/api/daily-reflections/${encodeURIComponent(parsed.data)}`;
}

function candidatePath(reflectionId: string, candidateId: string): string {
  const parsed = DailyReflectionIdSchema.safeParse(candidateId);
  if (!parsed.success) {
    throw new DailyReflectionApiError(400, "invalid_candidate_revocation_target");
  }
  return `${reflectionPath(reflectionId)}/candidates/${encodeURIComponent(parsed.data)}`;
}

export function createDailyReflectionApi(
  fetchImpl: typeof fetch = fetch
): DailyReflectionApi {
  const sameOrigin = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    try {
      return await fetchImpl(input, { ...init, credentials: "same-origin" });
    } catch (cause) {
      if (isAbortError(cause) || init?.signal?.aborted) throw cause;
      throw new DailyReflectionApiError(
        0,
        "network_error",
        errorMessage(0, "network_error"),
        { cause }
      );
    }
  };

  return {
    async getCurrentUser(signal) {
      const response = await sameOrigin("/api/auth/me", { method: "GET", signal });
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      return (await parseJsonResponse(response, AuthResponseSchema)).user;
    },

    async logout(signal) {
      const response = await sameOrigin("/api/auth/logout", {
        method: "POST",
        signal
      });
      await parseJsonResponse(response, LogoutResponseSchema);
    },

    async listConfirmedPeople(signal) {
      const response = await sameOrigin("/api/people", { method: "GET", signal });
      return (await parseJsonResponse(response, ConfirmedPeopleResponseSchema)).people;
    },

    async list(signal) {
      const response = await sameOrigin("/api/daily-reflections", {
        method: "GET",
        signal
      });
      return (await parseJsonResponse(response, DailyReflectionHistoryResponseSchema)).reflections;
    },

    async upload(input, signal) {
      const parsedInput = DailyReflectionUploadInputSchema.safeParse(input);
      if (!parsedInput.success) {
        throw new DailyReflectionApiError(
          400,
          "invalid_upload_input",
          errorMessage(400, "invalid_upload_input"),
          { cause: parsedInput.error }
        );
      }
      const body = new FormData();
      body.set("file", parsedInput.data.file);
      body.set("sourceOrigin", parsedInput.data.sourceOrigin);
      body.set("idempotencyKey", parsedInput.data.idempotencyKey);
      body.set("recordingDate", parsedInput.data.recordingDate);
      if (parsedInput.data.inputAdapter) {
        body.set("inputAdapter", parsedInput.data.inputAdapter);
      }
      const response = await sameOrigin("/api/daily-reflections", {
        method: "POST",
        body,
        signal
      });
      return parseJsonResponse(response, DailyReflectionUploadReceiptSchema);
    },

    async uploadBrowserRecording(input, signal) {
      const parsedInput = DailyReflectionBrowserRecordingInputSchema.safeParse(input);
      if (!parsedInput.success) {
        throw new DailyReflectionApiError(
          400,
          "invalid_upload_input",
          errorMessage(400, "invalid_upload_input"),
          { cause: parsedInput.error }
        );
      }
      const body = new FormData();
      body.set("file", parsedInput.data.file);
      body.set("inputMethod", "browser_recording");
      body.set("idempotencyKey", parsedInput.data.idempotencyKey);
      body.set("recordingDate", parsedInput.data.recordingDate);
      if (parsedInput.data.clientReportedDurationMs !== undefined) {
        body.set(
          "clientReportedDurationMs",
          String(parsedInput.data.clientReportedDurationMs)
        );
      }
      const response = await sameOrigin("/api/daily-reflections", {
        method: "POST",
        body,
        signal
      });
      return parseJsonResponse(response, DailyReflectionUploadReceiptSchema);
    },

    async get(reflectionId, signal) {
      const response = await sameOrigin(reflectionPath(reflectionId), {
        method: "GET",
        signal
      });
      return parseJsonResponse(response, DailyReflectionDetailResponseSchema);
    },

    async updateCandidates(reflectionId, input, signal) {
      const parsedInput = DailyReflectionCandidateUpdateRequestSchema.safeParse(input);
      if (!parsedInput.success) {
        throw new DailyReflectionApiError(
          400,
          "invalid_candidate_update",
          errorMessage(400, "invalid_candidate_update"),
          { cause: parsedInput.error }
        );
      }
      const response = await sameOrigin(`${reflectionPath(reflectionId)}/candidates`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsedInput.data),
        signal
      });
      return parseJsonResponse(response, DailyReflectionCandidateUpdateResponseSchema);
    },

    async finalize(reflectionId, input, signal) {
      const parsedInput = DailyReflectionFinalizeRequestSchema.safeParse(input);
      if (!parsedInput.success) {
        throw new DailyReflectionApiError(
          400,
          "invalid_finalize_input",
          errorMessage(400, "invalid_finalize_input"),
          { cause: parsedInput.error }
        );
      }
      const response = await sameOrigin(`${reflectionPath(reflectionId)}/finalize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsedInput.data),
        signal
      });
      return parseJsonResponse(response, DailyReflectionFinalizeResponseSchema);
    },

    async revokeCandidate(reflectionId, candidateId, input, signal) {
      const parsedInput = DailyReflectionCandidateRevocationRequestSchema.safeParse(input);
      if (!parsedInput.success) {
        throw new DailyReflectionApiError(
          400,
          "invalid_candidate_revocation_input",
          errorMessage(400, "invalid_candidate_revocation_input"),
          { cause: parsedInput.error }
        );
      }
      const response = await sameOrigin(`${candidatePath(reflectionId, candidateId)}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsedInput.data),
        signal
      });
      return parseJsonResponse(response, DailyReflectionCandidateRevocationResponseSchema);
    },

    async cancel(reflectionId, signal) {
      const response = await sameOrigin(`${reflectionPath(reflectionId)}/cancel`, {
        method: "POST",
        signal
      });
      return parseJsonResponse(response, DailyReflectionCancelReceiptSchema);
    },

    async retry(reflectionId, signal) {
      const response = await sameOrigin(`${reflectionPath(reflectionId)}/retry`, {
        method: "POST",
        signal
      });
      return parseJsonResponse(response, DailyReflectionActionReceiptSchema);
    },

    async delete(reflectionId, signal) {
      const response = await sameOrigin(reflectionPath(reflectionId), {
        method: "DELETE",
        signal
      });
      if (!response.ok) {
        throw responseError(response, await responsePayload(response));
      }
      if (response.status !== 204) {
        throw new DailyReflectionApiError(response.status, "invalid_response");
      }
    }
  };
}
