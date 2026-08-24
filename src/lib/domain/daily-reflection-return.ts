import { z } from "zod";

import {
  DailyReflectionIdSchema,
  ReflectionCardEpistemicStatusSchema,
  SourceOriginSchema
} from "./daily-reflection";

const DateKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

export const DAILY_REFLECTION_RETURN_TIME_ZONE = "Asia/Shanghai" as const;

export const DailyReflectionReturnEvidenceSchema = z.object({
  reflectionId: DailyReflectionIdSchema,
  cardId: DailyReflectionIdSchema,
  recordingDate: DateKeySchema,
  sourceOrigin: SourceOriginSchema.extract(["user_reflection", "direct_conversation"]),
  sourceSegmentId: DailyReflectionIdSchema,
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  snippet: z.string().trim().min(1).max(320)
}).strict().refine((evidence) => evidence.endSeconds > evidence.startSeconds, {
  message: "Evidence endSeconds must be greater than startSeconds"
});

const SourceFields = {
  sourceMemoryIds: z.array(DailyReflectionIdSchema).max(64),
  sourceCardIds: z.array(DailyReflectionIdSchema).min(1).max(64),
  evidenceIds: z.array(DailyReflectionIdSchema).min(1).max(128),
  evidence: z.array(DailyReflectionReturnEvidenceSchema).min(1).max(128),
  epistemicStatuses: z.array(ReflectionCardEpistemicStatusSchema).min(1).max(4)
} as const;

function addSourceInvariants(
  item: {
    sourceMemoryIds: string[];
    sourceCardIds: string[];
    evidenceIds: string[];
    evidence: Array<{ sourceSegmentId: string; cardId: string }>;
    epistemicStatuses: string[];
  },
  context: z.RefinementCtx,
  memoryRequired: boolean
) {
  for (const [field, values] of [
    ["sourceMemoryIds", item.sourceMemoryIds],
    ["sourceCardIds", item.sourceCardIds],
    ["evidenceIds", item.evidenceIds],
    ["epistemicStatuses", item.epistemicStatuses]
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} must be unique`
      });
    }
  }
  if (memoryRequired && item.sourceMemoryIds.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceMemoryIds"],
      message: "a Durable Memory source is required"
    });
  }
  const evidenceIds = item.evidence.map((evidence) => evidence.sourceSegmentId);
  if (
    new Set(evidenceIds).size !== evidenceIds.length
    || JSON.stringify([...evidenceIds].sort())
      !== JSON.stringify([...item.evidenceIds].sort())
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence"],
      message: "Evidence must exactly cover evidenceIds"
    });
  }
  if (item.evidence.some((evidence) => !item.sourceCardIds.includes(evidence.cardId))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence"],
      message: "Evidence Cards must belong to sourceCardIds"
    });
  }
}

export const DailyReflectionReturnItemTypeSchema = z.enum([
  "open_loop",
  "resurfaced_memory",
  "reflection_prompt"
]);

export const DailyReflectionReturnItemSchema = z.object({
  id: DailyReflectionIdSchema,
  type: DailyReflectionReturnItemTypeSchema,
  title: z.string().trim().min(1).max(240),
  body: z.string().trim().min(1).max(2_000),
  ...SourceFields,
  createdAt: z.string().datetime()
}).strict().superRefine((item, context) => {
  addSourceInvariants(item, context, true);
  if (
    item.type === "reflection_prompt"
    && /你应该|建议你|必须|ought to|you should/iu.test(item.body)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["body"],
      message: "reflection prompts must remain non-prescriptive"
    });
  }
});

export const DailyReflectionWeeklyItemTypeSchema = z.enum([
  "repeated_theme",
  "changed_decision",
  "open_commitment",
  "emerging_idea"
]);

export const DailyReflectionWeeklyItemSchema = z.object({
  id: DailyReflectionIdSchema,
  type: DailyReflectionWeeklyItemTypeSchema,
  title: z.string().trim().min(1).max(240),
  body: z.string().trim().min(1).max(2_000),
  sourceCount: z.number().int().positive(),
  dates: z.array(DateKeySchema).min(1).max(7),
  ...SourceFields,
  createdAt: z.string().datetime()
}).strict().superRefine((item, context) => {
  addSourceInvariants(item, context, item.type !== "emerging_idea");
  if (new Set(item.dates).size !== item.dates.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["dates"],
      message: "dates must be unique"
    });
  }
  if (item.type === "repeated_theme" && item.sourceCount < 2) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceCount"],
      message: "repeated themes require at least two sources"
    });
  }
});

export const DailyReflectionDailyReturnResponseSchema = z.object({
  referenceDate: DateKeySchema,
  timeZone: z.literal(DAILY_REFLECTION_RETURN_TIME_ZONE),
  openLoops: z.array(DailyReflectionReturnItemSchema).max(3),
  resurfacedMemories: z.array(DailyReflectionReturnItemSchema).max(3),
  reflectionPrompts: z.array(DailyReflectionReturnItemSchema).max(3)
}).strict();

export const DailyReflectionWeeklyReflectionResponseSchema = z.object({
  startDate: DateKeySchema,
  endDate: DateKeySchema,
  timeZone: z.literal(DAILY_REFLECTION_RETURN_TIME_ZONE),
  repeatedThemes: z.array(DailyReflectionWeeklyItemSchema).max(5),
  changedDecisions: z.array(DailyReflectionWeeklyItemSchema).max(5),
  openCommitments: z.array(DailyReflectionWeeklyItemSchema).max(5),
  emergingIdeas: z.array(DailyReflectionWeeklyItemSchema).max(5)
}).strict();

export type DailyReflectionReturnEvidence = z.infer<
  typeof DailyReflectionReturnEvidenceSchema
>;
export type DailyReflectionReturnItem = z.infer<
  typeof DailyReflectionReturnItemSchema
>;
export type DailyReflectionWeeklyItem = z.infer<
  typeof DailyReflectionWeeklyItemSchema
>;
export type DailyReflectionDailyReturnResponse = z.infer<
  typeof DailyReflectionDailyReturnResponseSchema
>;
export type DailyReflectionWeeklyReflectionResponse = z.infer<
  typeof DailyReflectionWeeklyReflectionResponseSchema
>;
