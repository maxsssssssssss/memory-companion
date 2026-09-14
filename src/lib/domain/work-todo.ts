import { z } from "zod";

import {
  WorkMeetingActionBasisSchema,
  WorkReviewDateSchema,
  WorkReviewIdSchema,
  WorkReviewIsoDateTimeSchema,
  WorkReviewVersionSchema
} from "@/lib/domain/work-review";
import { WorkProjectIdsSchema } from "@/lib/domain/work-project";

export const WORK_TODO_CONTRACT_VERSION = 1 as const;

export const WorkTodoKindSchema = z.enum(["self", "waiting_for_other"]);
export const WorkTodoStatusSchema = z.enum(["open", "completed"]);
export const WorkTodoOriginSchema = z.enum([
  "manual",
  "meeting_finding",
  "detached_meeting_finding"
]);
export const WorkTodoSourceFindingKindSchema = z.enum(["action_item", "commitment"]);
export const WorkTodoViewSchema = z.enum([
  "today",
  "all",
  "planned",
  "waiting",
  "completed"
]);
export const WorkTodoEventTypeSchema = z.enum([
  "todo.created_manual",
  "todo.created_from_finding",
  "todo.updated",
  "todo.completed",
  "todo.reopened",
  "todo.added_to_my_day",
  "todo.removed_from_my_day",
  "todo.deleted",
  "todo.detached_from_source"
]);

export const WorkTodoTitleSchema = z.string().trim().min(1).max(240);
export const WorkTodoNotesSchema = z.string().max(5_000);
export const WorkTodoOwnerLabelSchema = z.string().trim().min(1).max(512);
export const WorkTodoDateSchema = WorkReviewDateSchema;

/** Defaults derived from an existing Finding, not new ownership or deadline evidence. */
export function getWorkTodoFindingDefaults(input: {
  title?: string;
  body: string;
  candidateOwner?: string | null;
  dueAt?: string | null;
  originalDueExpression?: string | null;
  actionBasis?: string | null;
}) {
  // Neither field guarantees action semantics. Keep both complete source
  // expressions when they fit; never replace an action title with background
  // prose or truncate a condition to make a generated title fit.
  const originalTitle = input.title?.trim() ?? "";
  const body = input.body.trim();
  const combinedTitle = [...new Set([originalTitle, body].filter(Boolean))].join("：");
  const title = WorkTodoTitleSchema.safeParse(combinedTitle).success ? combinedTitle : originalTitle;
  // Publication appends standalone confirmation notes using `；`. A mention
  // inside ordinary prose is not that note and must not erase supported fields.
  const notes = new Set(input.body.split(/[；\n]/u).map((part) => part.trim()));
  const ownerNeedsConfirmation = notes.has("负责人待确认") || input.actionBasis === "unowned_follow_up";
  const dueNeedsConfirmation = notes.has("截止时间待确认")
    || (!input.dueAt && Boolean(input.originalDueExpression));
  const owner = WorkTodoOwnerLabelSchema.safeParse(input.candidateOwner);
  const dueAt = WorkReviewIsoDateTimeSchema.safeParse(input.dueAt);
  const sourceOwnerLabel = !ownerNeedsConfirmation && owner.success ? owner.data : null;
  const sourceDueAt = !dueNeedsConfirmation && dueAt.success ? dueAt.data : null;
  const dateParts = sourceDueAt === null ? null : new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(sourceDueAt));
  const currentDueDate = dateParts === null ? null : ["year", "month", "day"]
    .map((type) => dateParts.find((part) => part.type === type)!.value).join("-");
  return { title, sourceOwnerLabel, sourceDueAt, currentDueDate, ownerNeedsConfirmation, dueNeedsConfirmation };
}

const OptionalNullableNotesSchema = z.union([WorkTodoNotesSchema, z.null()])
  .optional()
  .transform((value) => value === undefined || value === "" ? null : value);
const OptionalNullableOwnerSchema = z.union([WorkTodoOwnerLabelSchema, z.literal(""), z.null()])
  .optional()
  .transform((value) => value === undefined || value === "" ? null : value);
const OptionalNullableDateSchema = z.union([WorkTodoDateSchema, z.literal(""), z.null()])
  .optional()
  .transform((value) => value === undefined || value === "" ? null : value);

const WorkTodoEditableFieldsShape = {
  title: WorkTodoTitleSchema,
  kind: WorkTodoKindSchema,
  notes: OptionalNullableNotesSchema,
  ownerLabel: OptionalNullableOwnerSchema,
  currentDueDate: OptionalNullableDateSchema,
  isImportant: z.boolean().default(false),
  myDayDate: OptionalNullableDateSchema
} as const;

function requireWaitingOwner(
  value: { kind: "self" | "waiting_for_other"; ownerLabel?: string | null },
  context: z.RefinementCtx
) {
  if (value.kind === "waiting_for_other" && !value.ownerLabel) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ownerLabel"],
      message: "Waiting-for-other Todo requires an owner label"
    });
  }
}

export const CreateManualWorkTodoRequestSchema = z.object({
  ...WorkTodoEditableFieldsShape,
  operationKey: WorkReviewIdSchema,
  projectIds: WorkProjectIdsSchema.optional()
}).strict().superRefine(requireWaitingOwner);

export const CreateWorkTodoFromFindingRequestSchema = z.object({
  ...WorkTodoEditableFieldsShape,
  operationKey: WorkReviewIdSchema,
  projectIds: WorkProjectIdsSchema.optional(),
  ownershipOverrideConfirmed: z.boolean().default(false)
}).strict().superRefine(requireWaitingOwner);

const OptionalPatchNotesSchema = z.union([WorkTodoNotesSchema, z.null()]).optional();
const OptionalPatchOwnerSchema = z.union([
  WorkTodoOwnerLabelSchema, z.literal(""), z.null()
]).optional().transform((value) => value === "" ? null : value);
const OptionalPatchDateSchema = z.union([
  WorkTodoDateSchema, z.literal(""), z.null()
]).optional().transform((value) => value === "" ? null : value);

export const UpdateWorkTodoRequestSchema = z.object({
  expectedVersion: WorkReviewVersionSchema,
  operationKey: WorkReviewIdSchema,
  title: WorkTodoTitleSchema.optional(),
  kind: WorkTodoKindSchema.optional(),
  notes: OptionalPatchNotesSchema,
  ownerLabel: OptionalPatchOwnerSchema,
  currentDueDate: OptionalPatchDateSchema,
  isImportant: z.boolean().optional(),
  myDayDate: OptionalPatchDateSchema
}).strict().superRefine((value, context) => {
  const editableKeys = [
    "title", "kind", "notes", "ownerLabel", "currentDueDate", "isImportant", "myDayDate"
  ] as const;
  if (!editableKeys.some((key) => Object.prototype.hasOwnProperty.call(value, key))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "At least one editable Todo field is required"
    });
  }
});

export const WorkTodoVersionedOperationRequestSchema = z.object({
  expectedVersion: WorkReviewVersionSchema,
  operationKey: WorkReviewIdSchema
}).strict();

export const SetWorkTodoMyDayRequestSchema = WorkTodoVersionedOperationRequestSchema.extend({
  day: WorkTodoDateSchema
}).strict();

export const WorkTodoSchema = z.object({
  contractVersion: z.literal(WORK_TODO_CONTRACT_VERSION),
  id: WorkReviewIdSchema,
  accountId: WorkReviewIdSchema,
  kind: WorkTodoKindSchema,
  status: WorkTodoStatusSchema,
  origin: WorkTodoOriginSchema,
  title: WorkTodoTitleSchema,
  notes: WorkTodoNotesSchema.nullable(),
  ownerLabel: WorkTodoOwnerLabelSchema.nullable(),
  currentDueDate: WorkTodoDateSchema.nullable(),
  isImportant: z.boolean(),
  myDayDate: WorkTodoDateSchema.nullable(),
  sourceMeetingId: WorkReviewIdSchema.nullable(),
  sourceFindingId: WorkReviewIdSchema.nullable(),
  sourceFindingVersion: WorkReviewVersionSchema.nullable(),
  sourceFindingKind: WorkTodoSourceFindingKindSchema.nullable(),
  sourceOwnerLabel: WorkTodoOwnerLabelSchema.nullable(),
  sourceOriginalDueAt: WorkReviewIsoDateTimeSchema.nullable(),
  sourceOriginalDueExpression: z.string().trim().min(1).max(2_000).nullable(),
  sourceActionBasis: WorkMeetingActionBasisSchema.nullable(),
  sourceDetachedAt: WorkReviewIsoDateTimeSchema.nullable(),
  version: WorkReviewVersionSchema,
  createdAt: WorkReviewIsoDateTimeSchema,
  updatedAt: WorkReviewIsoDateTimeSchema,
  completedAt: WorkReviewIsoDateTimeSchema.nullable(),
  reopenedAt: WorkReviewIsoDateTimeSchema.nullable(),
  deletedAt: WorkReviewIsoDateTimeSchema.nullable()
}).strict().superRefine((todo, context) => {
  if (todo.kind === "waiting_for_other" && !todo.ownerLabel) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ownerLabel"],
      message: "Waiting-for-other Todo requires an owner label"
    });
  }
  const hasSourceIdentity = todo.sourceMeetingId !== null
    && todo.sourceFindingId !== null
    && todo.sourceFindingVersion !== null
    && todo.sourceFindingKind !== null;
  const hasAnySourceIdentity = todo.sourceMeetingId !== null
    || todo.sourceFindingId !== null
    || todo.sourceFindingVersion !== null
    || todo.sourceFindingKind !== null;
  if (todo.origin === "meeting_finding" && !hasSourceIdentity) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["origin"], message: "Source identity required" });
  }
  if (todo.origin !== "meeting_finding" && hasAnySourceIdentity) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["origin"], message: "Source identity forbidden" });
  }
  if ((todo.origin === "detached_meeting_finding") !== (todo.sourceDetachedAt !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceDetachedAt"], message: "Detached origin mismatch" });
  }
});

export type WorkTodoKind = z.infer<typeof WorkTodoKindSchema>;
export type WorkTodoStatus = z.infer<typeof WorkTodoStatusSchema>;
export type WorkTodoOrigin = z.infer<typeof WorkTodoOriginSchema>;
export type WorkTodoSourceFindingKind = z.infer<typeof WorkTodoSourceFindingKindSchema>;
export type WorkTodoView = z.infer<typeof WorkTodoViewSchema>;
export type WorkTodoEventType = z.infer<typeof WorkTodoEventTypeSchema>;
export type WorkTodo = z.infer<typeof WorkTodoSchema>;
export type CreateManualWorkTodoRequest = z.infer<typeof CreateManualWorkTodoRequestSchema>;
export type CreateWorkTodoFromFindingRequest = z.infer<typeof CreateWorkTodoFromFindingRequestSchema>;
export type UpdateWorkTodoRequest = z.infer<typeof UpdateWorkTodoRequestSchema>;
export type WorkTodoVersionedOperationRequest = z.infer<typeof WorkTodoVersionedOperationRequestSchema>;
export type SetWorkTodoMyDayRequest = z.infer<typeof SetWorkTodoMyDayRequestSchema>;

export type WorkTodoEvidenceContext = {
  publicationId: string;
  segmentId: string;
  isDirectEvidence: boolean;
  text: string;
  startSeconds: number;
  endSeconds: number;
  rawSpeakerLabel: string | null;
  displaySpeakerLabel: string | null;
  timestampQuality: "provider_exact" | "provider_estimated" | "synthetic" | "unknown";
};

export type WorkTodoSourceSummary = {
  state: "none" | "available" | "changed" | "detached" | "missing";
  sourceChanged: boolean;
  currentFindingVersion: number | null;
  meeting: { id: string; title: string; meetingDate: string } | null;
};

export type WorkTodoDetail = {
  todo: WorkTodo;
  source: WorkTodoSourceSummary;
};

export type WorkTodoResolvedSource = {
  todoId: string;
  sourceChanged: boolean;
  meeting: { id: string; title: string; meetingDate: string };
  finding: {
    id: string;
    kind: WorkTodoSourceFindingKind;
    title: string;
    body: string;
    version: number;
    structuredData: unknown;
  };
  evidenceContexts: WorkTodoEvidenceContext[];
};
