import { z } from "zod";

import { AuthUserSchema } from "@/lib/client/date-companion-api";
import { WorkReviewDateSchema } from "@/lib/domain/work-review";

export const WORK_REVIEW_AUDIO_ACCEPT = [
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".mp4",
  ".mpga",
  ".ogg",
  ".opus",
  ".pcm",
  ".wav",
  ".webm",
  "audio/aac",
  "audio/flac",
  "audio/m4a",
  "audio/mp3",
  "audio/mp4",
  "audio/mpeg",
  "audio/mpga",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/webm",
  "audio/x-pcm",
  "video/mp4"
].join(",");

const WorkIdSchema = z.string().trim().min(1).max(160);
const WorkIngestionStatusSchema = z.enum([
  "created",
  "queued",
  "transcribing",
  "transcript_ready",
  "failed",
  "deleted"
]);
const WorkAnalysisStatusSchema = z.enum([
  "not_started",
  "queued",
  "extracting",
  "verifying",
  "review_ready",
  "failed",
  "deleted"
]);
const WorkReviewStatusSchema = z.enum(["not_started", "in_progress", "completed"]);
export const WorkMeetingCandidateKindSchema = z.enum([
  "discussion_topic",
  "proposal",
  "decision",
  "commitment",
  "open_question",
  "plan_change",
  "action_item"
]);
const WorkCandidateStatusSchema = z.enum([
  "pending_review",
  "accepted",
  "edited_and_accepted",
  "retyped_and_accepted",
  "ignored",
  "invalidated"
]);
export const WorkTodoKindSchema = z.enum(["self", "waiting_for_other"]);
export const WorkTodoStatusSchema = z.enum(["open", "completed"]);
export const WorkTodoOriginSchema = z.enum([
  "manual",
  "meeting_finding",
  "detached_meeting_finding"
]);
export const WorkTodoViewSchema = z.enum(["today", "all", "planned", "waiting", "completed"]);
export const WorkMeetingDeletePolicySchema = z.enum([
  "delete_linked_todos",
  "detach_linked_todos"
]);

export const WorkTranscriptSegmentSchema = z.object({
  id: WorkIdSchema,
  uploadId: WorkIdSchema,
  startSeconds: z.number().finite().nonnegative(),
  endSeconds: z.number().finite().nonnegative(),
  speaker: z.string().trim().min(1).nullable().optional(),
  text: z.string().trim().min(1),
  confidence: z.number().finite().min(0).max(1).nullable().optional()
}).strict();

export const WorkEvidenceViewSchema = z.object({
  publicationId: WorkIdSchema,
  segmentId: WorkIdSchema,
  startSeconds: z.number().finite().nonnegative(),
  endSeconds: z.number().finite().nonnegative(),
  rawSpeakerLabel: z.string().trim().min(1).nullable().optional(),
  timestampQuality: z.string().trim().min(1).optional(),
  text: z.string().trim().min(1),
  contextBefore: z.string().optional(),
  contextAfter: z.string().optional()
}).strict();

export const WorkMeetingListItemSchema = z.object({
  id: WorkIdSchema,
  title: z.string().trim().min(1),
  meetingDate: WorkReviewDateSchema,
  ingestionStatus: WorkIngestionStatusSchema,
  analysisStatus: WorkAnalysisStatusSchema,
  reviewStatus: WorkReviewStatusSchema,
  durationSeconds: z.number().finite().nonnegative().nullable().optional(),
  pendingCandidateCount: z.number().int().nonnegative().nullable().optional(),
  canonicalSegmentCount: z.number().int().nonnegative().nullable().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
}).strict();

const WorkPlanChangeStageSchema = z.object({
  text: z.string().trim().min(1),
  status: z.string().trim().min(1).optional(),
  rawSpeakerLabel: z.string().trim().min(1).nullable().optional(),
  evidence: z.array(WorkEvidenceViewSchema).min(1)
}).strict();

export const WorkMeetingCandidateSchema = z.object({
  id: WorkIdSchema,
  kind: WorkMeetingCandidateKindSchema,
  status: WorkCandidateStatusSchema,
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
  version: z.number().int().nonnegative(),
  publicationAction: z.enum(["show_as_candidate", "show_as_question"]),
  riskLevel: z.enum(["low", "medium", "high", "critical"]),
  candidateOwner: z.string().trim().min(1).nullable().optional(),
  dueAt: z.string().trim().min(1).nullable().optional(),
  originalDueExpression: z.string().trim().min(1).nullable().optional(),
  actionBasis: z.enum([
    "explicit_commitment",
    "assignment_without_acceptance",
    "suggested_action",
    "unowned_follow_up"
  ]).nullable().optional(),
  decisionFinality: z.enum(["final", "tentative", "unclear"]).nullable().optional(),
  evidence: z.array(WorkEvidenceViewSchema).min(1),
  planChangeStages: z.array(WorkPlanChangeStageSchema).optional(),
  structuredData: z.record(z.string(), z.unknown()).optional()
}).strict();

export const WorkMeetingFindingSchema = z.object({
  id: WorkIdSchema,
  sourceCandidateId: WorkIdSchema,
  kind: WorkMeetingCandidateKindSchema,
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
  version: z.number().int().nonnegative(),
  candidateOwner: z.string().trim().min(1).nullable().optional(),
  dueAt: z.string().trim().min(1).nullable().optional(),
  originalDueExpression: z.string().trim().min(1).nullable().optional(),
  actionBasis: z.enum([
    "explicit_commitment",
    "assignment_without_acceptance",
    "suggested_action",
    "unowned_follow_up"
  ]).nullable().optional(),
  decisionFinality: z.enum(["final", "tentative", "unclear"]).nullable().optional(),
  evidence: z.array(WorkEvidenceViewSchema).min(1),
  planChangeStages: z.array(WorkPlanChangeStageSchema).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
}).strict();

export const WorkTodoSchema = z.object({
  contractVersion: z.literal(1),
  id: WorkIdSchema,
  accountId: WorkIdSchema,
  kind: WorkTodoKindSchema,
  status: WorkTodoStatusSchema,
  origin: WorkTodoOriginSchema,
  title: z.string().trim().min(1).max(240),
  notes: z.string().max(5_000).nullable(),
  ownerLabel: z.string().trim().min(1).max(512).nullable(),
  currentDueDate: WorkReviewDateSchema.nullable(),
  isImportant: z.boolean(),
  myDayDate: WorkReviewDateSchema.nullable(),
  sourceMeetingId: WorkIdSchema.nullable(),
  sourceFindingId: WorkIdSchema.nullable(),
  sourceFindingVersion: z.number().int().nonnegative().nullable(),
  sourceFindingKind: z.enum(["action_item", "commitment"]).nullable(),
  sourceOwnerLabel: z.string().trim().min(1).max(512).nullable(),
  sourceOriginalDueAt: z.string().datetime().nullable(),
  sourceOriginalDueExpression: z.string().trim().min(1).max(2_000).nullable(),
  sourceActionBasis: z.enum([
    "explicit_commitment",
    "assignment_without_acceptance",
    "suggested_action",
    "unowned_follow_up"
  ]).nullable(),
  sourceDetachedAt: z.string().datetime().nullable(),
  version: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  reopenedAt: z.string().datetime().nullable(),
  deletedAt: z.string().datetime().nullable()
}).strict();

export const WorkTodoProjectionSchema = z.object({
  id: WorkIdSchema,
  sourceFindingId: WorkIdSchema,
  status: WorkTodoStatusSchema,
  title: z.string().trim().min(1).max(240),
  version: z.number().int().nonnegative(),
  kind: WorkTodoKindSchema,
  currentDueDate: WorkReviewDateSchema.nullable(),
  sourceOriginalDueAt: z.string().datetime().nullable(),
  sourceOriginalDueExpression: z.string().trim().min(1).max(2_000).nullable()
}).strict();

export const WorkMeetingFollowUpDraftSchema = z.object({
  contractVersion: z.literal(1),
  meetingId: WorkIdSchema,
  accountId: WorkIdSchema,
  bodyMarkdown: z.string().trim().min(1).max(100_000),
  systemSnapshotDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  currentSnapshotDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  stale: z.boolean(),
  version: z.number().int().nonnegative(),
  generatedAt: z.string().datetime(),
  userEditedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
  copySlices: z.object({
    full: z.string().trim().min(1).max(100_000),
    decisions: z.string().max(100_000),
    actions: z.string().max(100_000),
    selectiveSlicesSource: z.literal("system_snapshot")
  }).strict(),
  sourceStats: z.object({
    findingCount: z.number().int().nonnegative(),
    todoCount: z.number().int().nonnegative(),
    confirmedResultCount: z.number().int().nonnegative(),
    myTodoCount: z.number().int().nonnegative(),
    waitingForOtherTodoCount: z.number().int().nonnegative(),
    unresolvedQuestionCount: z.number().int().nonnegative()
  }).strict()
}).strict();
export const WorkMeetingFollowUpSourceStatsSchema = WorkMeetingFollowUpDraftSchema.shape.sourceStats;

export const WorkMeetingDetailSchema = z.object({
  meeting: WorkMeetingListItemSchema.extend({
    sourceUploadId: WorkIdSchema,
    version: z.number().int().nonnegative(),
    canonicalPublicationId: WorkIdSchema.nullable().optional(),
    canonicalContentDigest: z.string().min(1).nullable().optional(),
    errorStage: z.string().trim().min(1).nullable().optional(),
    errorCode: z.string().trim().min(1).nullable().optional(),
    processingStage: z.enum(["transcription", "meeting_analysis"]).nullable().optional(),
    processingLeaseExpiresAt: z.string().datetime().nullable().optional(),
    verifierMode: z.enum(["enabled", "disabled", "not_applicable"]).nullable().optional()
  }).strict(),
  transcriptSegments: z.array(WorkTranscriptSegmentSchema),
  candidates: z.array(WorkMeetingCandidateSchema),
  findings: z.array(WorkMeetingFindingSchema),
  todoProjections: z.array(WorkTodoProjectionSchema).optional().default([]),
  linkedTodoCount: z.number().int().nonnegative().optional().default(0),
  speakerAliases: z.array(z.object({
    rawLabel: z.string().trim().min(1),
    displayLabel: z.string().trim().min(1),
    version: z.number().int().nonnegative(),
    createdAt: z.string().min(1).optional(),
    updatedAt: z.string().min(1).optional()
  }).strict())
}).strict();

const WorkMeetingListResponseSchema = z.object({
  meetings: z.array(WorkMeetingListItemSchema)
}).strict();
const WorkMeetingCreateReceiptSchema = z.object({
  meetingId: WorkIdSchema,
  receiptId: WorkIdSchema,
  ingestionStatus: WorkIngestionStatusSchema,
  analysisStatus: WorkAnalysisStatusSchema,
  reused: z.boolean().optional().default(false)
}).strict();
const WorkTodoListResponseSchema = z.object({ todos: z.array(WorkTodoSchema) }).strict();
const WorkTodoMutationResponseSchema = z.object({
  todo: WorkTodoSchema,
  reused: z.boolean()
}).strict();
const WorkMeetingFollowUpGetResponseSchema = z.object({
  draft: WorkMeetingFollowUpDraftSchema.nullable(),
  sourceStats: WorkMeetingFollowUpSourceStatsSchema
}).strict();
const WorkMeetingFollowUpMutationResponseSchema = z.object({
  draft: WorkMeetingFollowUpDraftSchema,
  reused: z.boolean()
}).strict();
export const WorkReviewCapacityLimitsSchema = z.object({
  maxUploadBytes: z.number().int().positive(),
  maxAudioDurationSeconds: z.number().int().positive()
}).strict();
const WorkReviewConfigResponseSchema = z.object({
  limits: WorkReviewCapacityLimitsSchema
}).strict();
const WorkTodoSourceStateSchema = z.enum(["none", "available", "changed", "detached", "missing"]);
const WorkTodoMeetingSummarySchema = z.object({
  id: WorkIdSchema,
  title: z.string().trim().min(1),
  meetingDate: WorkReviewDateSchema
}).strict();
const WorkTodoDetailResponseSchema = z.object({
  todo: WorkTodoSchema,
  source: z.object({
    state: WorkTodoSourceStateSchema,
    sourceChanged: z.boolean(),
    currentFindingVersion: z.number().int().nonnegative().nullable(),
    meeting: WorkTodoMeetingSummarySchema.nullable()
  }).strict()
}).strict();
const WorkTodoSourceResponseSchema = z.object({
  todoId: WorkIdSchema,
  sourceChanged: z.boolean(),
  meeting: WorkTodoMeetingSummarySchema,
  finding: z.object({
    id: WorkIdSchema,
    kind: z.enum(["action_item", "commitment"]),
    title: z.string().trim().min(1),
    body: z.string().trim().min(1),
    version: z.number().int().nonnegative(),
    structuredData: z.record(z.string(), z.unknown())
  }).strict(),
  evidenceContexts: z.array(z.object({
    publicationId: WorkIdSchema,
    segmentId: WorkIdSchema,
    text: z.string().trim().min(1),
    startSeconds: z.number().finite().nonnegative(),
    endSeconds: z.number().finite().nonnegative(),
    rawSpeakerLabel: z.string().trim().min(1).nullable(),
    displaySpeakerLabel: z.string().trim().min(1).nullable(),
    timestampQuality: z.string().trim().min(1).nullable(),
    isDirectEvidence: z.boolean()
  }).strict()).min(1)
}).strict();
const AuthResponseSchema = z.object({ user: AuthUserSchema }).strict();
const LogoutResponseSchema = z.object({ ok: z.literal(true) }).strict();
const MutationResponseSchema = z.object({ ok: z.literal(true) }).passthrough();
const ErrorResponseSchema = z.object({ error: z.string().min(1) }).passthrough();

export type WorkReviewAuthUser = z.infer<typeof AuthUserSchema>;
export type WorkMeetingListItem = z.infer<typeof WorkMeetingListItemSchema>;
export type WorkMeetingDetail = z.infer<typeof WorkMeetingDetailSchema>;
export type WorkMeetingCandidate = z.infer<typeof WorkMeetingCandidateSchema>;
export type WorkMeetingFinding = z.infer<typeof WorkMeetingFindingSchema>;
export type WorkEvidenceView = z.infer<typeof WorkEvidenceViewSchema>;
export type WorkMeetingCandidateKind = z.infer<typeof WorkMeetingCandidateKindSchema>;
export type WorkMeetingCreateReceipt = z.infer<typeof WorkMeetingCreateReceiptSchema>;
export type WorkTodo = z.infer<typeof WorkTodoSchema>;
export type WorkTodoProjection = z.infer<typeof WorkTodoProjectionSchema>;
export type WorkTodoKind = z.infer<typeof WorkTodoKindSchema>;
export type WorkTodoView = z.infer<typeof WorkTodoViewSchema>;
export type WorkMeetingDeletePolicy = z.infer<typeof WorkMeetingDeletePolicySchema>;
export type WorkTodoDetailResponse = z.infer<typeof WorkTodoDetailResponseSchema>;
export type WorkTodoSourceResponse = z.infer<typeof WorkTodoSourceResponseSchema>;
export type WorkMeetingFollowUpDraft = z.infer<typeof WorkMeetingFollowUpDraftSchema>;
export type WorkMeetingFollowUpGetResponse = z.infer<
  typeof WorkMeetingFollowUpGetResponseSchema
>;
export type WorkReviewCapacityLimits = z.infer<typeof WorkReviewCapacityLimitsSchema>;

export type WorkMeetingUploadInput = Readonly<{
  file: File;
  idempotencyKey: string;
  meetingDate: string;
  title?: string;
}>;

export type WorkCandidateReviewDraft =
  | Readonly<{ action: "accept" | "ignore" }>
  | Readonly<{
    action: "edit_and_accept";
    title: string;
    body: string;
    structuredData: Readonly<Record<string, unknown>>;
  }>
  | Readonly<{
    action: "retype_and_accept";
    kind: WorkMeetingCandidateKind;
    title: string;
    body: string;
    structuredData: Readonly<Record<string, unknown>>;
  }>;

export type WorkCandidateReviewInput = WorkCandidateReviewDraft & Readonly<{
  expectedVersion: number;
  operationKey: string;
}>;

export type WorkTodoDraft = Readonly<{
  title: string;
  kind: WorkTodoKind;
  ownerLabel: string | null;
  currentDueDate: string | null;
  notes: string | null;
  isImportant: boolean;
  myDayDate: string | null;
}>;

export type CreateWorkTodoInput = WorkTodoDraft & Readonly<{ operationKey: string }>;
export type CreateWorkTodoFromFindingInput = CreateWorkTodoInput & Readonly<{
  ownershipOverrideConfirmed: boolean;
}>;
export type UpdateWorkTodoInput = Partial<WorkTodoDraft> & Readonly<{
  expectedVersion: number;
  operationKey: string;
}>;
export type WorkTodoVersionedOperationInput = Readonly<{
  expectedVersion: number;
  operationKey: string;
}>;
export type WorkTodoMyDayInput = WorkTodoVersionedOperationInput & Readonly<{ day: string }>;
export type UpdateWorkMeetingFollowUpInput = Readonly<{
  bodyMarkdown: string;
  expectedVersion: number;
  operationKey: string;
}>;
export type GenerateWorkMeetingFollowUpInput = Readonly<{
  expectedVersion: number | null;
  operationKey: string;
}>;
export type ResetWorkMeetingFollowUpInput = Readonly<{
  expectedVersion: number;
  operationKey: string;
}>;

export interface WorkReviewApi {
  getCurrentUser(signal?: AbortSignal): Promise<WorkReviewAuthUser | null>;
  logout(signal?: AbortSignal): Promise<void>;
  getRuntimeConfig(signal?: AbortSignal): Promise<WorkReviewCapacityLimits>;
  listMeetings(signal?: AbortSignal): Promise<WorkMeetingListItem[]>;
  uploadMeeting(input: WorkMeetingUploadInput, signal?: AbortSignal): Promise<WorkMeetingCreateReceipt>;
  getMeeting(meetingId: string, signal?: AbortSignal): Promise<WorkMeetingDetail>;
  retryMeeting(meetingId: string, operationKey: string, signal?: AbortSignal): Promise<void>;
  reviewCandidate(
    meetingId: string,
    candidateId: string,
    input: WorkCandidateReviewInput,
    signal?: AbortSignal
  ): Promise<void>;
  updateSpeakerAlias(
    meetingId: string,
    rawLabel: string,
    displayName: string,
    expectedVersion: number,
    operationKey: string,
    signal?: AbortSignal
  ): Promise<void>;
  completeMeeting(
    meetingId: string,
    expectedVersion: number,
    operationKey: string,
    signal?: AbortSignal
  ): Promise<void>;
  deleteMeeting(
    meetingId: string,
    policy?: WorkMeetingDeletePolicy,
    signal?: AbortSignal
  ): Promise<void>;
  getMeetingFollowUp(
    meetingId: string,
    signal?: AbortSignal
  ): Promise<WorkMeetingFollowUpGetResponse>;
  generateMeetingFollowUp(
    meetingId: string,
    input: GenerateWorkMeetingFollowUpInput,
    signal?: AbortSignal
  ): Promise<WorkMeetingFollowUpDraft>;
  updateMeetingFollowUp(
    meetingId: string,
    input: UpdateWorkMeetingFollowUpInput,
    signal?: AbortSignal
  ): Promise<WorkMeetingFollowUpDraft>;
  resetMeetingFollowUp(
    meetingId: string,
    input: ResetWorkMeetingFollowUpInput,
    signal?: AbortSignal
  ): Promise<WorkMeetingFollowUpDraft>;
  listTodos(view: WorkTodoView, day?: string, signal?: AbortSignal): Promise<WorkTodo[]>;
  createTodo(input: CreateWorkTodoInput, signal?: AbortSignal): Promise<WorkTodo>;
  createTodoFromFinding(
    meetingId: string,
    findingId: string,
    input: CreateWorkTodoFromFindingInput,
    signal?: AbortSignal
  ): Promise<WorkTodo>;
  getTodo(todoId: string, signal?: AbortSignal): Promise<WorkTodoDetailResponse>;
  updateTodo(todoId: string, input: UpdateWorkTodoInput, signal?: AbortSignal): Promise<WorkTodo>;
  completeTodo(todoId: string, input: WorkTodoVersionedOperationInput, signal?: AbortSignal): Promise<WorkTodo>;
  reopenTodo(todoId: string, input: WorkTodoVersionedOperationInput, signal?: AbortSignal): Promise<WorkTodo>;
  setTodoMyDay(todoId: string, input: WorkTodoMyDayInput, signal?: AbortSignal): Promise<WorkTodo>;
  removeTodoMyDay(todoId: string, input: WorkTodoVersionedOperationInput, signal?: AbortSignal): Promise<WorkTodo>;
  deleteTodo(todoId: string, input: WorkTodoVersionedOperationInput, signal?: AbortSignal): Promise<WorkTodo>;
  getTodoSource(todoId: string, signal?: AbortSignal): Promise<WorkTodoSourceResponse>;
}

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  unauthenticated: "登录状态已经失效，请重新登录。",
  feature_disabled: "工作复盘暂未开放。",
  upload_disabled: "会议录音上传暂不可用。",
  analysis_disabled: "会议原文已保存，但内容整理暂不可用。",
  invalid_upload: "请选择受支持的会议录音文件。",
  invalid_multipart: "上传内容无法读取，请重新选择会议录音。",
  invalid_meeting_fields: "请填写真实有效的会议日期。",
  empty_file: "这段录音是空文件，请重新选择。",
  unsupported_audio_format: "当前不支持这种录音格式，请选择页面列出的音频格式。",
  file_too_large: "这段录音超过当前允许的文件大小。",
  audio_duration_exceeded: "这段录音超过当前允许的会议时长。",
  invalid_audio_duration: "无法确认这段录音的时长，请检查文件后重试。",
  idempotency_conflict: "这次上传标识已用于另一段录音，请重新选择文件后再试。",
  version_conflict: "这条会议结果已在其他页面更新，请载入最新内容后再操作。",
  meeting_not_found: "这次会议不存在或已经删除。",
  cleanup_failed: "会议已停止处理，但临时文件清理未完成；请重试删除。",
  todo_disabled: "工作复盘待办暂未开放。",
  todo_meeting_projection_disabled: "从会议结果创建待办暂未开放。",
  todo_not_found: "这条待办不存在或已经删除。",
  invalid_todo_fields: "请检查待办标题、类型、负责人和日期。",
  invalid_todo_operation: "这次待办操作无法识别，请重新操作。",
  todo_ownership_override_required: "会议中只记录了任务分配。请确认由你接手后再加入我的待办。",
  linked_todos_require_policy: "这次会议仍有关联待办。请选择删除关联待办，或保留待办并移除会议来源。",
  follow_up_disabled: "会后纪要暂未开放。",
  follow_up_review_incomplete: "请先完成会议结果确认，再生成会后纪要。",
  follow_up_not_generated: "请先生成会后纪要草稿。",
  follow_up_operation_conflict: "这次纪要操作标识已用于其他内容，请重新操作。",
  invalid_response: "服务返回了无法识别的数据，请稍后重试。",
  network_error: "暂时无法连接服务，请检查网络后重试。"
};

function fallbackErrorMessage(status: number) {
  if (status === 401) return ERROR_MESSAGES.unauthenticated;
  if (status === 404) return ERROR_MESSAGES.meeting_not_found;
  if (status === 409) return ERROR_MESSAGES.version_conflict;
  if (status >= 400 && status < 500) return "请求内容有误，请检查后重试。";
  return "暂时无法完成操作，请稍后重试。";
}

type WorkReviewApiErrorOptions = ErrorOptions & Readonly<{
  details?: Readonly<Record<string, unknown>>;
}>;

export class WorkReviewApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>> | null;

  constructor(status: number, code: string, options?: WorkReviewApiErrorOptions) {
    super(ERROR_MESSAGES[code] ?? fallbackErrorMessage(status), { cause: options?.cause });
    this.name = "WorkReviewApiError";
    this.status = status;
    this.code = code;
    this.details = options?.details ?? null;
  }
}

const DEFINITIVE_WORK_REVIEW_CLIENT_STATUSES = new Set([
  400, 401, 403, 404, 405, 409, 410, 411, 413, 414, 415, 416, 422
]);

export function isDefinitiveWorkReviewApiError(error: unknown) {
  return error instanceof WorkReviewApiError
    && DEFINITIVE_WORK_REVIEW_CLIENT_STATUSES.has(error.status);
}

function requestId(value: string, code: string) {
  const parsed = WorkIdSchema.safeParse(value);
  if (!parsed.success) throw new WorkReviewApiError(400, code, { cause: parsed.error });
  return parsed.data;
}

function pathId(value: string, code: string) {
  return encodeURIComponent(requestId(value, code));
}

async function responsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new WorkReviewApiError(response.status, "invalid_response", { cause });
  }
}

async function parseResponse<Schema extends z.ZodTypeAny>(response: Response, schema: Schema) {
  const payload = await responsePayload(response);
  if (!response.ok) {
    const parsed = ErrorResponseSchema.safeParse(payload);
    throw new WorkReviewApiError(
      response.status,
      response.status === 401 ? "unauthenticated" : parsed.success ? parsed.data.error : `http_${response.status}`,
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? { details: payload as Readonly<Record<string, unknown>> }
        : undefined
    );
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new WorkReviewApiError(response.status, "invalid_response", { cause: parsed.error });
  }
  return parsed.data as z.output<Schema>;
}

export function createWorkReviewApi(fetchImpl: typeof fetch = fetch): WorkReviewApi {
  const sameOrigin = async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      return await fetchImpl(input, { ...init, credentials: "same-origin" });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError" || init?.signal?.aborted) throw cause;
      throw new WorkReviewApiError(0, "network_error", { cause });
    }
  };
  const meetingPath = (meetingId: string) => (
    `/api/work-reviews/meetings/${pathId(meetingId, "invalid_meeting_id")}`
  );
  const todoPath = (todoId: string) => `/api/work-reviews/todos/${pathId(todoId, "invalid_todo_id")}`;
  const versionedBody = (input: WorkTodoVersionedOperationInput) => ({
    expectedVersion: input.expectedVersion,
    operationKey: requestId(input.operationKey, "invalid_operation_key")
  });

  return {
    async getCurrentUser(signal) {
      const response = await sameOrigin("/api/auth/me", { method: "GET", signal });
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      return (await parseResponse(response, AuthResponseSchema)).user;
    },
    async logout(signal) {
      const response = await sameOrigin("/api/auth/logout", { method: "POST", signal });
      await parseResponse(response, LogoutResponseSchema);
    },
    async getRuntimeConfig(signal) {
      const response = await sameOrigin("/api/work-reviews/config", { method: "GET", signal });
      return (await parseResponse(response, WorkReviewConfigResponseSchema)).limits;
    },
    async listMeetings(signal) {
      const response = await sameOrigin("/api/work-reviews/meetings", { method: "GET", signal });
      return (await parseResponse(response, WorkMeetingListResponseSchema)).meetings;
    },
    async uploadMeeting(input, signal) {
      const meetingDate = WorkReviewDateSchema.safeParse(input.meetingDate);
      const key = WorkIdSchema.safeParse(input.idempotencyKey);
      if (!meetingDate.success || !key.success || !(input.file instanceof File)) {
        throw new WorkReviewApiError(400, "invalid_upload");
      }
      const body = new FormData();
      body.set("file", input.file);
      body.set("meetingDate", meetingDate.data);
      if (input.title?.trim()) body.set("title", input.title.trim());
      const response = await sameOrigin("/api/work-reviews/meetings", {
        method: "POST",
        body,
        headers: { "Idempotency-Key": key.data },
        signal
      });
      return await parseResponse(response, WorkMeetingCreateReceiptSchema);
    },
    async getMeeting(meetingId, signal) {
      const response = await sameOrigin(meetingPath(meetingId), { method: "GET", signal });
      return await parseResponse(response, WorkMeetingDetailSchema);
    },
    async retryMeeting(meetingId, operationKey, signal) {
      const response = await sameOrigin(`${meetingPath(meetingId)}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operationKey: requestId(operationKey, "invalid_operation_key") }),
        signal
      });
      await parseResponse(response, MutationResponseSchema);
    },
    async reviewCandidate(meetingId, candidateId, input, signal) {
      const response = await sameOrigin(
        `${meetingPath(meetingId)}/candidates/${pathId(candidateId, "invalid_candidate_id")}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal
        }
      );
      await parseResponse(response, MutationResponseSchema);
    },
    async updateSpeakerAlias(meetingId, rawLabel, displayName, expectedVersion, operationKey, signal) {
      const response = await sameOrigin(
        `${meetingPath(meetingId)}/speakers/${encodeURIComponent(rawLabel)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            displayName: displayName.trim(),
            expectedVersion,
            operationKey: requestId(operationKey, "invalid_operation_key")
          }),
          signal
        }
      );
      await parseResponse(response, MutationResponseSchema);
    },
    async completeMeeting(meetingId, expectedVersion, operationKey, signal) {
      const response = await sameOrigin(`${meetingPath(meetingId)}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion,
          operationKey: requestId(operationKey, "invalid_operation_key")
        }),
        signal
      });
      await parseResponse(response, MutationResponseSchema);
    },
    async deleteMeeting(meetingId, policy, signal) {
      const response = await sameOrigin(meetingPath(meetingId), {
        method: "DELETE",
        ...(policy ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ policy: WorkMeetingDeletePolicySchema.parse(policy) })
        } : {}),
        signal
      });
      if (!response.ok) {
        const payload = await responsePayload(response);
        const parsed = ErrorResponseSchema.safeParse(payload);
        const code = parsed.success ? parsed.data.error : `http_${response.status}`;
        if (response.status === 404 && code === "meeting_not_found") return;
        throw new WorkReviewApiError(
          response.status,
          code,
          payload && typeof payload === "object" && !Array.isArray(payload)
            ? { details: payload as Readonly<Record<string, unknown>> }
            : undefined
        );
      }
      await response.body?.cancel().catch(() => undefined);
    },
    async getMeetingFollowUp(meetingId, signal) {
      const response = await sameOrigin(`${meetingPath(meetingId)}/follow-up`, {
        method: "GET",
        signal
      });
      return await parseResponse(response, WorkMeetingFollowUpGetResponseSchema);
    },
    async generateMeetingFollowUp(meetingId, input, signal) {
      const response = await sameOrigin(`${meetingPath(meetingId)}/follow-up/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion: input.expectedVersion,
          operationKey: requestId(input.operationKey, "invalid_operation_key")
        }),
        signal
      });
      return (await parseResponse(response, WorkMeetingFollowUpMutationResponseSchema)).draft;
    },
    async updateMeetingFollowUp(meetingId, input, signal) {
      const response = await sameOrigin(`${meetingPath(meetingId)}/follow-up`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bodyMarkdown: input.bodyMarkdown,
          expectedVersion: input.expectedVersion,
          operationKey: requestId(input.operationKey, "invalid_operation_key")
        }),
        signal
      });
      return (await parseResponse(response, WorkMeetingFollowUpMutationResponseSchema)).draft;
    },
    async resetMeetingFollowUp(meetingId, input, signal) {
      const response = await sameOrigin(`${meetingPath(meetingId)}/follow-up/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion: input.expectedVersion,
          operationKey: requestId(input.operationKey, "invalid_operation_key")
        }),
        signal
      });
      return (await parseResponse(response, WorkMeetingFollowUpMutationResponseSchema)).draft;
    },
    async listTodos(view, day, signal) {
      const query = new URLSearchParams({ view: WorkTodoViewSchema.parse(view) });
      if (day) query.set("day", WorkReviewDateSchema.parse(day));
      const response = await sameOrigin(`/api/work-reviews/todos?${query.toString()}`, { method: "GET", signal });
      return (await parseResponse(response, WorkTodoListResponseSchema)).todos;
    },
    async createTodo(input, signal) {
      const response = await sameOrigin("/api/work-reviews/todos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, operationKey: requestId(input.operationKey, "invalid_operation_key") }),
        signal
      });
      return (await parseResponse(response, WorkTodoMutationResponseSchema)).todo;
    },
    async createTodoFromFinding(meetingId, findingId, input, signal) {
      const response = await sameOrigin(
        `${meetingPath(meetingId)}/findings/${pathId(findingId, "invalid_finding_id")}/todo`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...input, operationKey: requestId(input.operationKey, "invalid_operation_key") }),
          signal
        }
      );
      return (await parseResponse(response, WorkTodoMutationResponseSchema)).todo;
    },
    async getTodo(todoId, signal) {
      const response = await sameOrigin(todoPath(todoId), { method: "GET", signal });
      return await parseResponse(response, WorkTodoDetailResponseSchema);
    },
    async updateTodo(todoId, input, signal) {
      const response = await sameOrigin(todoPath(todoId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, operationKey: requestId(input.operationKey, "invalid_operation_key") }),
        signal
      });
      return (await parseResponse(response, WorkTodoMutationResponseSchema)).todo;
    },
    async completeTodo(todoId, input, signal) {
      const response = await sameOrigin(`${todoPath(todoId)}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(versionedBody(input)),
        signal
      });
      return (await parseResponse(response, WorkTodoMutationResponseSchema)).todo;
    },
    async reopenTodo(todoId, input, signal) {
      const response = await sameOrigin(`${todoPath(todoId)}/reopen`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(versionedBody(input)),
        signal
      });
      return (await parseResponse(response, WorkTodoMutationResponseSchema)).todo;
    },
    async setTodoMyDay(todoId, input, signal) {
      const response = await sameOrigin(`${todoPath(todoId)}/my-day`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...versionedBody(input), day: WorkReviewDateSchema.parse(input.day) }),
        signal
      });
      return (await parseResponse(response, WorkTodoMutationResponseSchema)).todo;
    },
    async removeTodoMyDay(todoId, input, signal) {
      const response = await sameOrigin(`${todoPath(todoId)}/my-day`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(versionedBody(input)),
        signal
      });
      return (await parseResponse(response, WorkTodoMutationResponseSchema)).todo;
    },
    async deleteTodo(todoId, input, signal) {
      const response = await sameOrigin(todoPath(todoId), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(versionedBody(input)),
        signal
      });
      return (await parseResponse(response, WorkTodoMutationResponseSchema)).todo;
    },
    async getTodoSource(todoId, signal) {
      const response = await sameOrigin(`${todoPath(todoId)}/source`, { method: "GET", signal });
      return await parseResponse(response, WorkTodoSourceResponseSchema);
    }
  };
}
