import { z } from "zod";

import {
  DailyReflectionIdSchema,
  ReflectionCardEpistemicStatusSchema
} from "./daily-reflection";
import { DailyReflectionReturnEvidenceSchema } from "./daily-reflection-return";

export const DAILY_REFLECTION_AI_REVIEW_CONTRACT_VERSION = 1 as const;

const DateKeySchema = z.string().date();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const DailyReflectionAiReviewScopeSchema = z.enum(["daily", "weekly"]);
export const DailyReflectionAiReviewStatusSchema = z.enum([
  "queued",
  "processing",
  "validating",
  "ready",
  "failed",
  "stale"
]);
export const DailyReflectionAiReviewExposureModeSchema = z.enum(["shadow", "on"]);

export const DailyReflectionAiReviewSourceKindSchema = z.enum([
  "open_loop",
  "resurfaced_memory",
  "reflection_prompt",
  "repeated_theme",
  "changed_decision",
  "open_commitment",
  "emerging_idea"
]);

function uniqueValues(values: string[]) {
  return new Set(values).size === values.length;
}

export const DailyReflectionAiReviewCanonicalSourceSchema = z.object({
  sourceId: DailyReflectionIdSchema,
  sourceKind: DailyReflectionAiReviewSourceKindSchema,
  title: z.string().trim().min(1).max(240),
  content: z.string().trim().min(1).max(2_000),
  memoryIds: z.array(DailyReflectionIdSchema).max(64),
  cardIds: z.array(DailyReflectionIdSchema).min(1).max(64),
  recordingDates: z.array(DateKeySchema).min(1).max(31),
  evidence: z.array(DailyReflectionReturnEvidenceSchema).min(1).max(128),
  epistemicStatuses: z.array(ReflectionCardEpistemicStatusSchema).min(1).max(4)
}).strict().superRefine((source, context) => {
  for (const field of [
    "memoryIds",
    "cardIds",
    "recordingDates",
    "epistemicStatuses"
  ] as const) {
    if (!uniqueValues(source[field])) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} must be unique`
      });
    }
  }
  const evidenceIds = source.evidence.map((item) => item.sourceSegmentId);
  if (!uniqueValues(evidenceIds)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence"],
      message: "canonical Evidence IDs must be unique"
    });
  }
  if (
    source.evidence.some((item) => !source.cardIds.includes(item.cardId))
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence"],
      message: "canonical Evidence Cards must belong to cardIds"
    });
  }
  if (
    source.sourceKind === "emerging_idea"
    && source.memoryIds.length > 0
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["memoryIds"],
      message: "emerging ideas must remain Card-only"
    });
  }
  if (
    source.sourceKind !== "emerging_idea"
    && source.memoryIds.length === 0
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["memoryIds"],
      message: "non-emerging Return sources require Durable Memory authority"
    });
  }
});

const ProviderObservationSchema = z.object({
  sourceIds: z.array(DailyReflectionIdSchema).min(1).max(4),
  interpretation: z.string().trim().min(1).max(4_000),
  followUpQuestion: z.string().trim().min(1).max(1_000).nullable()
}).strict().superRefine((observation, context) => {
  if (!uniqueValues(observation.sourceIds)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceIds"],
      message: "sourceIds must be unique"
    });
  }
});

export const DailyReflectionAiReviewProviderDraftSchema = z.object({
  schemaVersion: z.literal(DAILY_REFLECTION_AI_REVIEW_CONTRACT_VERSION),
  selectedSourceIds: z.array(DailyReflectionIdSchema).min(1).max(64),
  observations: z.array(ProviderObservationSchema).min(1).max(10)
}).strict().superRefine((draft, context) => {
  if (!uniqueValues(draft.selectedSourceIds)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selectedSourceIds"],
      message: "selectedSourceIds must be unique"
    });
  }
  const selected = new Set(draft.selectedSourceIds);
  const used = new Set(draft.observations.flatMap((item) => item.sourceIds));
  if (
    [...used].some((sourceId) => !selected.has(sourceId))
    || [...selected].some((sourceId) => !used.has(sourceId))
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["observations"],
      message: "observations must exactly cover selectedSourceIds"
    });
  }
});

export const DailyReflectionAiReviewModelInferenceSchema = z.object({
  kind: z.literal("model_inference"),
  text: z.string().trim().min(1).max(4_000)
}).strict();

export const DailyReflectionAiReviewReadyObservationSchema = z.object({
  sourceIds: z.array(DailyReflectionIdSchema).min(1).max(4),
  canonicalSources: z.array(DailyReflectionAiReviewCanonicalSourceSchema).min(1).max(4),
  modelInterpretation: DailyReflectionAiReviewModelInferenceSchema,
  followUpQuestion: DailyReflectionAiReviewModelInferenceSchema.nullable()
}).strict().superRefine((observation, context) => {
  const canonicalSourceIds = observation.canonicalSources.map((item) => item.sourceId);
  if (
    !uniqueValues(observation.sourceIds)
    || !uniqueValues(canonicalSourceIds)
    || JSON.stringify([...observation.sourceIds].sort())
      !== JSON.stringify([...canonicalSourceIds].sort())
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["canonicalSources"],
      message: "canonicalSources must exactly cover sourceIds"
    });
  }
});

export const DailyReflectionAiReviewReadyContentSchema = z.object({
  schemaVersion: z.literal(DAILY_REFLECTION_AI_REVIEW_CONTRACT_VERSION),
  selectedSourceIds: z.array(DailyReflectionIdSchema).min(1).max(64),
  canonicalSources: z.array(DailyReflectionAiReviewCanonicalSourceSchema).min(1).max(64),
  observations: z.array(DailyReflectionAiReviewReadyObservationSchema).min(1).max(10)
}).strict().superRefine((content, context) => {
  const canonicalSourceIds = content.canonicalSources.map((item) => item.sourceId);
  if (
    !uniqueValues(content.selectedSourceIds)
    || !uniqueValues(canonicalSourceIds)
    || JSON.stringify([...content.selectedSourceIds].sort())
      !== JSON.stringify([...canonicalSourceIds].sort())
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["canonicalSources"],
      message: "canonicalSources must exactly cover selectedSourceIds"
    });
  }
});

export const DailyReflectionAiReviewOperationViewSchema = z.object({
  schemaVersion: z.literal(DAILY_REFLECTION_AI_REVIEW_CONTRACT_VERSION),
  reviewId: DailyReflectionIdSchema,
  scope: DailyReflectionAiReviewScopeSchema,
  startDate: DateKeySchema,
  endDate: DateKeySchema,
  status: DailyReflectionAiReviewStatusSchema,
  sourceFingerprint: Sha256Schema,
  promptVersion: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(256),
  content: DailyReflectionAiReviewReadyContentSchema.nullable(),
  failureCode: z.string().trim().min(1).max(128).nullable(),
  providerStartedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  seenAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime()
}).strict().superRefine((view, context) => {
  if (view.startDate > view.endDate) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endDate"],
      message: "endDate must not precede startDate"
    });
  }
  if (view.status !== "ready" && view.content !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["content"],
      message: "non-ready reviews must not expose content"
    });
  }
  if (view.status === "failed" && view.failureCode === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["failureCode"],
      message: "failed reviews require a failureCode"
    });
  }
  if (view.status !== "ready" && view.seenAt !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["seenAt"],
      message: "only ready reviews may be seen"
    });
  }
});

export const DailyReflectionAiReviewLookupResponseSchema = z.object({
  schemaVersion: z.literal(DAILY_REFLECTION_AI_REVIEW_CONTRACT_VERSION),
  exposureMode: DailyReflectionAiReviewExposureModeSchema,
  scope: DailyReflectionAiReviewScopeSchema,
  referenceDate: DateKeySchema,
  review: DailyReflectionAiReviewOperationViewSchema.nullable()
}).strict();

export const DailyReflectionAiReviewSummarySchema = z.object({
  schemaVersion: z.literal(DAILY_REFLECTION_AI_REVIEW_CONTRACT_VERSION),
  exposureMode: DailyReflectionAiReviewExposureModeSchema,
  pendingCount: z.number().int().nonnegative(),
  unseenReadyCount: z.number().int().nonnegative(),
  items: z.array(z.object({
    reviewId: DailyReflectionIdSchema,
    scope: DailyReflectionAiReviewScopeSchema,
    startDate: DateKeySchema,
    endDate: DateKeySchema,
    completedAt: z.string().datetime()
  }).strict()).max(100)
}).strict();

export type DailyReflectionAiReviewScope = z.infer<
  typeof DailyReflectionAiReviewScopeSchema
>;
export type DailyReflectionAiReviewStatus = z.infer<
  typeof DailyReflectionAiReviewStatusSchema
>;
export type DailyReflectionAiReviewExposureMode = z.infer<
  typeof DailyReflectionAiReviewExposureModeSchema
>;
export type DailyReflectionAiReviewCanonicalSource = z.infer<
  typeof DailyReflectionAiReviewCanonicalSourceSchema
>;
export type DailyReflectionAiReviewProviderDraft = z.infer<
  typeof DailyReflectionAiReviewProviderDraftSchema
>;
export type DailyReflectionAiReviewReadyContent = z.infer<
  typeof DailyReflectionAiReviewReadyContentSchema
>;
export type DailyReflectionAiReviewOperationView = z.infer<
  typeof DailyReflectionAiReviewOperationViewSchema
>;
export type DailyReflectionAiReviewLookupResponse = z.infer<
  typeof DailyReflectionAiReviewLookupResponseSchema
>;
export type DailyReflectionAiReviewSummary = z.infer<
  typeof DailyReflectionAiReviewSummarySchema
>;
