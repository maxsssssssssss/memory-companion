import { z } from "zod";

import { WorkProjectReferenceSchema } from "./work-project";
import {
  WorkEvidenceTimestampQualitySchema,
  WorkMeetingCandidateKindSchema,
  WorkReviewDateSchema,
  WorkReviewIdSchema,
  WorkReviewIsoDateTimeSchema,
  WorkReviewVersionSchema
} from "./work-review";
import {
  WorkTodoEventTypeSchema,
  WorkTodoKindSchema,
  WorkTodoStatusSchema
} from "./work-todo";

export const WORK_WEEKLY_CONTRACT_VERSION = 1 as const;
export const WORK_WEEKLY_MAX_QA_TURNS = 8 as const;

export const WorkWeeklyScopeKindSchema = z.enum(["all", "project", "unassigned"]);
export const WorkWeeklyTimeZoneSchema = z.string().trim().min(1).max(128).superRefine(
  (value, context) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid IANA time zone"
      });
    }
  }
);

const WorkWeeklyScopeRequestShape = {
  weekStart: WorkReviewDateSchema,
  timeZone: WorkWeeklyTimeZoneSchema,
  scopeKind: WorkWeeklyScopeKindSchema,
  projectId: WorkReviewIdSchema.nullable()
} as const;

function requireCoherentScope(
  value: { scopeKind: "all" | "project" | "unassigned"; projectId: string | null },
  context: z.RefinementCtx
) {
  if ((value.scopeKind === "project") !== (value.projectId !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["projectId"],
      message: "projectId is required only for project scope"
    });
  }
}

export const WorkWeeklyScopeRequestSchema = z.object(
  WorkWeeklyScopeRequestShape
).strict().superRefine(requireCoherentScope);

export const WorkWeeklyScopeSchema = z.object({
  ...WorkWeeklyScopeRequestShape,
  weekEnd: WorkReviewDateSchema,
  observedThrough: WorkReviewDateSchema,
  windowComplete: z.boolean()
}).strict().superRefine(requireCoherentScope);

export const WorkWeeklySourceRefSchema = z.string().trim().min(1).max(1_024);
export const WorkWeeklySourceKindSchema = z.enum([
  "meeting",
  "finding",
  "todo",
  "todo_event",
  "project",
  "evidence"
]);

const NonNegativeCountSchema = z.number().int().nonnegative();

export const WorkWeeklySourceSummarySchema = z.object({
  meetingCount: NonNegativeCountSchema,
  findingCount: NonNegativeCountSchema,
  todoCount: NonNegativeCountSchema,
  todoEventCount: NonNegativeCountSchema,
  evidenceCount: NonNegativeCountSchema,
  projectCount: NonNegativeCountSchema,
  pendingCandidateCount: NonNegativeCountSchema,
  includedFindingCount: NonNegativeCountSchema,
  includedTodoCount: NonNegativeCountSchema,
  includedTodoEventCount: NonNegativeCountSchema,
  includedEvidenceCount: NonNegativeCountSchema,
  omittedFindingCount: NonNegativeCountSchema,
  omittedTodoCount: NonNegativeCountSchema,
  omittedTodoEventCount: NonNegativeCountSchema,
  omittedEvidenceCount: NonNegativeCountSchema,
  truncated: z.boolean(),
  historyCompleteness: z.enum(["exact", "legacy_limited"])
}).strict();

export const WorkWeeklyMeetingSourceSchema = z.object({
  sourceRef: WorkWeeklySourceRefSchema,
  id: WorkReviewIdSchema,
  version: WorkReviewVersionSchema,
  title: z.string().trim().min(1).max(2_000),
  meetingDate: WorkReviewDateSchema,
  reviewStatus: z.enum(["not_started", "in_progress", "completed"]),
  pendingCandidateCount: NonNegativeCountSchema,
  canonicalPublicationId: WorkReviewIdSchema,
  canonicalContentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  projects: z.array(WorkProjectReferenceSchema)
}).strict();

export const WorkWeeklyFindingSourceSchema = z.object({
  sourceRef: WorkWeeklySourceRefSchema,
  id: WorkReviewIdSchema,
  meetingId: WorkReviewIdSchema,
  version: WorkReviewVersionSchema,
  kind: WorkMeetingCandidateKindSchema,
  title: z.string().trim().min(1).max(2_000),
  body: z.string().trim().min(1).max(20_000),
  structuredData: z.unknown(),
  userConfirmedAt: WorkReviewIsoDateTimeSchema,
  userEditedAt: WorkReviewIsoDateTimeSchema.nullable(),
  evidenceRefs: z.array(WorkWeeklySourceRefSchema).min(1).max(64)
}).strict();

export const WorkWeeklyTodoStateSchema = z.object({
  title: z.string().trim().min(1).max(240),
  kind: WorkTodoKindSchema,
  status: WorkTodoStatusSchema,
  ownerLabel: z.string().trim().min(1).max(512).nullable(),
  currentDueDate: WorkReviewDateSchema.nullable(),
  completedAt: WorkReviewIsoDateTimeSchema.nullable(),
  deletedAt: WorkReviewIsoDateTimeSchema.nullable(),
  version: WorkReviewVersionSchema
}).strict();

export const WorkWeeklyTodoSourceSchema = z.object({
  sourceRef: WorkWeeklySourceRefSchema,
  id: WorkReviewIdSchema,
  version: WorkReviewVersionSchema,
  current: WorkWeeklyTodoStateSchema,
  stateAtWeekEnd: WorkWeeklyTodoStateSchema.nullable(),
  historyCompleteness: z.enum(["exact", "legacy_limited"]),
  sourceMeetingId: WorkReviewIdSchema.nullable(),
  sourceFindingId: WorkReviewIdSchema.nullable(),
  sourceFindingKind: z.enum(["action_item", "commitment"]).nullable(),
  projects: z.array(WorkProjectReferenceSchema)
}).strict();

export const WorkWeeklyTodoEventSourceSchema = z.object({
  sourceRef: WorkWeeklySourceRefSchema,
  id: WorkReviewIdSchema,
  todoId: WorkReviewIdSchema,
  eventType: WorkTodoEventTypeSchema,
  changedFields: z.array(z.string().trim().min(1).max(128)).max(32),
  occurredAt: WorkReviewIsoDateTimeSchema,
  localDate: WorkReviewDateSchema,
  oldVersion: WorkReviewVersionSchema.nullable(),
  newVersion: WorkReviewVersionSchema,
  stateAfter: WorkWeeklyTodoStateSchema.nullable(),
  historyCompleteness: z.enum(["exact", "legacy_limited"])
}).strict();

export const WorkWeeklyEvidenceSourceSchema = z.object({
  sourceRef: WorkWeeklySourceRefSchema,
  publicationId: WorkReviewIdSchema,
  publicationDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  meetingId: WorkReviewIdSchema,
  segmentId: WorkReviewIdSchema,
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  rawSpeakerLabel: z.string().nullable(),
  timestampQuality: WorkEvidenceTimestampQualitySchema,
  text: z.string().trim().min(1).max(20_000)
}).strict().superRefine((value, context) => {
  if (value.endSeconds <= value.startSeconds) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Evidence end must follow start" });
  }
});

export const WorkWeeklySourceIdentitySchema = z.object({
  sourceRef: WorkWeeklySourceRefSchema,
  sourceKind: WorkWeeklySourceKindSchema,
  sourceId: WorkReviewIdSchema,
  version: WorkReviewVersionSchema.nullable(),
  digest: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  publicationId: WorkReviewIdSchema.nullable(),
  segmentId: WorkReviewIdSchema.nullable(),
  included: z.boolean()
}).strict();

export const WorkWeeklySourceSnapshotSchema = z.object({
  contractVersion: z.literal(WORK_WEEKLY_CONTRACT_VERSION),
  accountId: WorkReviewIdSchema,
  scope: WorkWeeklyScopeSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  inputPackDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  createdAt: WorkReviewIsoDateTimeSchema,
  summary: WorkWeeklySourceSummarySchema,
  identities: z.array(WorkWeeklySourceIdentitySchema),
  meetings: z.array(WorkWeeklyMeetingSourceSchema),
  findings: z.array(WorkWeeklyFindingSourceSchema),
  todos: z.array(WorkWeeklyTodoSourceSchema),
  todoEvents: z.array(WorkWeeklyTodoEventSourceSchema),
  projects: z.array(WorkProjectReferenceSchema),
  evidence: z.array(WorkWeeklyEvidenceSourceSchema),
  allowlistedSourceRefs: z.array(WorkWeeklySourceRefSchema)
}).strict();

export const WorkWeeklyReviewStatusSchema = z.enum([
  "queued",
  "generating",
  "verifying",
  "ready",
  "stale",
  "failed",
  "deleted"
]);
export const WorkWeeklyRunStateSchema = z.enum([
  "queued", "processing", "verifying", "completed", "failed", "superseded", "deleted"
]);
export const WorkWeeklySectionKindSchema = z.enum([
  "overview",
  "progress",
  "decisions",
  "completed",
  "in_progress",
  "waiting_for_others",
  "open_questions",
  "next_week"
]);
export const WorkWeeklyItemOriginSchema = z.enum(["gpt", "user_note"]);
export const WorkWeeklyItemVerificationStateSchema = z.enum([
  "verified", "qualified", "user_authored", "invalidated"
]);

export const WorkWeeklyReviewSchema = z.object({
  contractVersion: z.literal(WORK_WEEKLY_CONTRACT_VERSION),
  id: WorkReviewIdSchema,
  accountId: WorkReviewIdSchema,
  scope: WorkWeeklyScopeSchema,
  status: WorkWeeklyReviewStatusSchema,
  sourceSnapshotDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceSummary: WorkWeeklySourceSummarySchema,
  currentSystemVersion: NonNegativeCountSchema,
  currentRunVersion: NonNegativeCountSchema,
  version: WorkReviewVersionSchema,
  generatedAt: WorkReviewIsoDateTimeSchema.nullable(),
  updatedAt: WorkReviewIsoDateTimeSchema,
  deletedAt: WorkReviewIsoDateTimeSchema.nullable()
}).strict();

export const WorkWeeklyReviewItemSchema = z.object({
  contractVersion: z.literal(WORK_WEEKLY_CONTRACT_VERSION),
  id: WorkReviewIdSchema,
  accountId: WorkReviewIdSchema,
  weeklyReviewId: WorkReviewIdSchema,
  section: WorkWeeklySectionKindSchema,
  origin: WorkWeeklyItemOriginSchema,
  systemText: z.string().trim().min(1).max(20_000).nullable(),
  userText: z.string().trim().min(1).max(20_000).nullable(),
  sourceRefs: z.array(WorkWeeklySourceRefSchema).max(256),
  verificationState: WorkWeeklyItemVerificationStateSchema,
  sortOrder: z.number().int().nonnegative(),
  systemVersion: WorkReviewVersionSchema.nullable(),
  version: WorkReviewVersionSchema,
  userEditedAt: WorkReviewIsoDateTimeSchema.nullable(),
  hiddenAt: WorkReviewIsoDateTimeSchema.nullable(),
  invalidatedAt: WorkReviewIsoDateTimeSchema.nullable(),
  createdAt: WorkReviewIsoDateTimeSchema,
  updatedAt: WorkReviewIsoDateTimeSchema
}).strict();

export const WorkWeeklyPublishedItemInputSchema = z.object({
  section: WorkWeeklySectionKindSchema,
  text: z.string().trim().min(1).max(20_000),
  sourceRefs: z.array(WorkWeeklySourceRefSchema).min(1).max(256),
  verificationState: z.enum(["verified", "qualified"]),
  sortOrder: z.number().int().nonnegative()
}).strict();

export const WorkWeeklyRunSchema = z.object({
  id: WorkReviewIdSchema,
  accountId: WorkReviewIdSchema,
  weeklyReviewId: WorkReviewIdSchema,
  runVersion: z.number().int().positive(),
  sourceSnapshotDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  state: WorkWeeklyRunStateSchema,
  leaseOwner: WorkReviewIdSchema.nullable(),
  leaseExpiresAt: WorkReviewIsoDateTimeSchema.nullable(),
  pipelineVersion: z.string().trim().min(1).max(256),
  synthesizerProfile: z.string().trim().min(1).max(256).nullable(),
  verifierProfile: z.string().trim().min(1).max(256).nullable(),
  createdAt: WorkReviewIsoDateTimeSchema,
  completedAt: WorkReviewIsoDateTimeSchema.nullable(),
  errorCode: z.string().trim().min(1).max(256).nullable()
}).strict();

export const WorkWeeklyReviewIssueSchema = z.object({
  sourceRef: WorkWeeklySourceRefSchema.nullable(),
  reasonCode: z.enum([
    "missing_key_content", "missing_qualification", "claim_not_verified",
    "coverage_claim_filtered", "coverage_not_applicable_invalid",
    "source_pack_truncated", "source_history_incomplete", "source_unavailable"
  ])
}).strict().superRefine((issue, context) => {
  const sourceLess = ["source_pack_truncated", "source_history_incomplete", "source_unavailable"]
    .includes(issue.reasonCode);
  if ((issue.sourceRef === null) !== sourceLess) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceRef"], message: "Invalid review issue scope" });
  }
});
export type WorkWeeklyReviewIssue = z.infer<typeof WorkWeeklyReviewIssueSchema>;

/** Stored assessment metadata, never unverified generated prose. */
export const WorkWeeklyGenerationQualitySchema = z.object({
  status: z.enum(["passed", "needs_review", "insufficient"]),
  reviewIssues: z.array(WorkWeeklyReviewIssueSchema).max(2_048).default([])
}).strict().superRefine((quality, context) => {
  if ((quality.status === "passed" && quality.reviewIssues.length !== 0)
    || (quality.status === "needs_review" && quality.reviewIssues.length === 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reviewIssues"], message: "Quality and review issues disagree" });
  }
});
export type WorkWeeklyGenerationQuality = z.infer<typeof WorkWeeklyGenerationQualitySchema>;

/** Quality of the persisted system version, independent of the latest attempt. */
export const WorkWeeklyDisplayedGenerationSchema = z.object({
  runId: WorkReviewIdSchema,
  runVersion: z.number().int().positive(),
  systemVersion: z.number().int().positive(),
  qualityStatus: z.enum(["passed", "needs_review", "not_assessed"]),
  reviewIssues: z.array(WorkWeeklyReviewIssueSchema).max(2_048).default([])
}).strict();
export type WorkWeeklyDisplayedGeneration = z.infer<typeof WorkWeeklyDisplayedGenerationSchema>;

/** Assessment of the latest attempt, not a certification of the displayed prose. */
export const WorkWeeklyLatestGenerationSchema = z.object({
  runId: WorkReviewIdSchema,
  runVersion: z.number().int().positive(),
  executionStatus: z.enum(["pending", "running", "completed", "failed", "unknown"]),
  sourceCheckStatus: z.enum(["completed", "not_established"]),
  qualityStatus: z.enum(["passed", "needs_review", "insufficient", "not_assessed"]),
  reviewIssues: z.array(WorkWeeklyReviewIssueSchema).max(2_048).default([]),
  displayingPreviousVersion: z.boolean(),
  errorCode: z.string().regex(/^(?:work|weekly)_[a-z0-9_]{1,120}$/u).nullable()
}).strict();
export type WorkWeeklyLatestGeneration = z.infer<typeof WorkWeeklyLatestGenerationSchema>;

export const WorkWeeklyRunFenceSchema = z.object({
  weeklyReviewId: WorkReviewIdSchema,
  runId: WorkReviewIdSchema,
  runVersion: z.number().int().positive(),
  leaseOwner: WorkReviewIdSchema,
  leaseExpiresAt: WorkReviewIsoDateTimeSchema,
  sourceSnapshotDigest: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();

export const GenerateWorkWeeklyReviewRequestSchema = z.object({
  ...WorkWeeklyScopeRequestShape,
  operationKey: WorkReviewIdSchema,
  expectedVersion: WorkReviewVersionSchema.nullable().optional()
}).strict().superRefine(requireCoherentScope);

export const RegenerateWorkWeeklyReviewRequestSchema = z.object({
  operationKey: WorkReviewIdSchema,
  expectedVersion: WorkReviewVersionSchema
}).strict();

export const UpdateWorkWeeklyItemRequestSchema = z.object({
  operationKey: WorkReviewIdSchema,
  expectedVersion: WorkReviewVersionSchema,
  text: z.string().trim().min(1).max(20_000).optional(),
  hidden: z.boolean().optional(),
  sortOrder: z.number().int().nonnegative().optional()
}).strict().superRefine((value, context) => {
  if (value.text === undefined && value.hidden === undefined && value.sortOrder === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Item update is empty" });
  }
});

export const CreateWorkWeeklyUserNoteRequestSchema = z.object({
  operationKey: WorkReviewIdSchema,
  expectedVersion: WorkReviewVersionSchema,
  section: WorkWeeklySectionKindSchema,
  text: z.string().trim().min(1).max(20_000),
  sortOrder: z.number().int().nonnegative()
}).strict();

export const WorkWeeklyVersionedOperationRequestSchema = z.object({
  operationKey: WorkReviewIdSchema,
  expectedVersion: WorkReviewVersionSchema
}).strict();

export const WorkWeeklyQaAnswerStatusSchema = z.enum([
  "answered", "partially_answered", "insufficient_evidence", "failed", "invalidated"
]);

export const WorkWeeklyQaThreadSchema = z.object({
  id: WorkReviewIdSchema,
  accountId: WorkReviewIdSchema,
  weeklyReviewId: WorkReviewIdSchema,
  sourceSnapshotDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  version: WorkReviewVersionSchema,
  createdAt: WorkReviewIsoDateTimeSchema,
  updatedAt: WorkReviewIsoDateTimeSchema,
  clearedAt: WorkReviewIsoDateTimeSchema.nullable()
}).strict();

export const WorkWeeklyQaMessageSchema = z.object({
  id: WorkReviewIdSchema,
  accountId: WorkReviewIdSchema,
  weeklyReviewId: WorkReviewIdSchema,
  threadId: WorkReviewIdSchema,
  role: z.enum(["user", "assistant"]),
  text: z.string().max(40_000).nullable(),
  answerStatus: WorkWeeklyQaAnswerStatusSchema.nullable(),
  sourceRefs: z.array(WorkWeeklySourceRefSchema).max(256),
  sourceSnapshotDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  providerProfile: z.string().trim().min(1).max(256).nullable(),
  promptVersion: z.string().trim().min(1).max(256).nullable(),
  verifierProfile: z.string().trim().min(1).max(256).nullable(),
  version: WorkReviewVersionSchema,
  createdAt: WorkReviewIsoDateTimeSchema,
  invalidatedAt: WorkReviewIsoDateTimeSchema.nullable()
}).strict();

export const AskWorkWeeklyQaRequestSchema = z.object({
  question: z.string().trim().min(1).max(8_000),
  operationKey: WorkReviewIdSchema,
  expectedVersion: WorkReviewVersionSchema.nullable()
}).strict();

export const WorkWeeklyQaRunStateSchema = WorkWeeklyRunStateSchema;
export const WorkWeeklyQaRunSchema = z.object({
  id: WorkReviewIdSchema,
  accountId: WorkReviewIdSchema,
  weeklyReviewId: WorkReviewIdSchema,
  threadId: WorkReviewIdSchema,
  questionMessageId: WorkReviewIdSchema,
  runVersion: z.number().int().positive(),
  sourceSnapshotDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  state: WorkWeeklyQaRunStateSchema,
  leaseOwner: WorkReviewIdSchema.nullable(),
  leaseExpiresAt: WorkReviewIsoDateTimeSchema.nullable(),
  providerProfile: z.string().trim().min(1).max(256).nullable(),
  promptVersion: z.string().trim().min(1).max(256).nullable(),
  verifierProfile: z.string().trim().min(1).max(256).nullable(),
  createdAt: WorkReviewIsoDateTimeSchema,
  completedAt: WorkReviewIsoDateTimeSchema.nullable(),
  errorCode: z.string().trim().min(1).max(256).nullable()
}).strict();

export const WorkWeeklyQaRunFenceSchema = z.object({
  weeklyReviewId: WorkReviewIdSchema,
  threadId: WorkReviewIdSchema,
  runId: WorkReviewIdSchema,
  runVersion: z.number().int().positive(),
  leaseOwner: WorkReviewIdSchema,
  leaseExpiresAt: WorkReviewIsoDateTimeSchema,
  sourceSnapshotDigest: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();

export type WorkWeeklyScopeKind = z.infer<typeof WorkWeeklyScopeKindSchema>;
export type WorkWeeklyScope = z.infer<typeof WorkWeeklyScopeSchema>;
export type WorkWeeklyScopeRequest = z.infer<typeof WorkWeeklyScopeRequestSchema>;
export type WorkWeeklySourceKind = z.infer<typeof WorkWeeklySourceKindSchema>;
export type WorkWeeklySourceSummary = z.infer<typeof WorkWeeklySourceSummarySchema>;
export type WorkWeeklySourceIdentity = z.infer<typeof WorkWeeklySourceIdentitySchema>;
export type WorkWeeklySourceSnapshot = z.infer<typeof WorkWeeklySourceSnapshotSchema>;
export type WorkWeeklyReviewStatus = z.infer<typeof WorkWeeklyReviewStatusSchema>;
export type WorkWeeklyRunState = z.infer<typeof WorkWeeklyRunStateSchema>;
export type WorkWeeklySectionKind = z.infer<typeof WorkWeeklySectionKindSchema>;
export type WorkWeeklyReview = z.infer<typeof WorkWeeklyReviewSchema>;
export type WorkWeeklyReviewItem = z.infer<typeof WorkWeeklyReviewItemSchema>;
export type WorkWeeklyPublishedItemInput = z.infer<typeof WorkWeeklyPublishedItemInputSchema>;
export type WorkWeeklyRun = z.infer<typeof WorkWeeklyRunSchema>;
export type WorkWeeklyRunFence = z.infer<typeof WorkWeeklyRunFenceSchema>;
export type GenerateWorkWeeklyReviewRequest = z.infer<
  typeof GenerateWorkWeeklyReviewRequestSchema
>;
export type RegenerateWorkWeeklyReviewRequest = z.infer<
  typeof RegenerateWorkWeeklyReviewRequestSchema
>;
export type UpdateWorkWeeklyItemRequest = z.infer<typeof UpdateWorkWeeklyItemRequestSchema>;
export type CreateWorkWeeklyUserNoteRequest = z.infer<
  typeof CreateWorkWeeklyUserNoteRequestSchema
>;
export type WorkWeeklyVersionedOperationRequest = z.infer<
  typeof WorkWeeklyVersionedOperationRequestSchema
>;
export type WorkWeeklyQaThread = z.infer<typeof WorkWeeklyQaThreadSchema>;
export type WorkWeeklyQaMessage = z.infer<typeof WorkWeeklyQaMessageSchema>;
export type AskWorkWeeklyQaRequest = z.infer<typeof AskWorkWeeklyQaRequestSchema>;
export type WorkWeeklyQaRun = z.infer<typeof WorkWeeklyQaRunSchema>;
export type WorkWeeklyQaRunFence = z.infer<typeof WorkWeeklyQaRunFenceSchema>;
