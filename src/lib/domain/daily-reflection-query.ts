import { z } from "zod";

import {
  DailyReflectionIdSchema,
  ReflectionCardEpistemicStatusSchema
} from "./daily-reflection";
import { DailyReflectionReturnEvidenceSchema } from "./daily-reflection-return";

export const DailyReflectionQueryIntentSchema = z.enum([
  "decision_reasoning",
  "first_appearance",
  "belief_change",
  "commitment_recall",
  "memory_exploration"
]);

export const DailyReflectionQueryScopeSchema = z.enum([
  "all",
  "last_7_days",
  "last_30_days"
]);

export const DailyReflectionQueryRequestSchema = z.object({
  query: z.string().trim().min(2).max(512),
  personId: DailyReflectionIdSchema.optional(),
  scope: DailyReflectionQueryScopeSchema.default("all")
}).strict();

export const DailyReflectionQueryClaimSchema = z.object({
  text: z.string().trim().min(1).max(2_000),
  sourceMemoryIds: z.array(DailyReflectionIdSchema).max(32),
  sourceCardIds: z.array(DailyReflectionIdSchema).min(1).max(32),
  evidenceIds: z.array(DailyReflectionIdSchema).min(1).max(64),
  evidence: z.array(DailyReflectionReturnEvidenceSchema).min(1).max(64),
  epistemicStatuses: z.array(ReflectionCardEpistemicStatusSchema).min(1).max(4)
}).strict().superRefine((claim, context) => {
  for (const [field, values] of [
    ["sourceMemoryIds", claim.sourceMemoryIds],
    ["sourceCardIds", claim.sourceCardIds],
    ["evidenceIds", claim.evidenceIds],
    ["epistemicStatuses", claim.epistemicStatuses]
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} must be unique`
      });
    }
  }
  const evidenceIds = claim.evidence.map((item) => item.sourceSegmentId);
  if (
    new Set(evidenceIds).size !== evidenceIds.length
    || JSON.stringify([...evidenceIds].sort())
      !== JSON.stringify([...claim.evidenceIds].sort())
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence"],
      message: "Claim Evidence must exactly cover evidenceIds"
    });
  }
  if (claim.evidence.some((item) => !claim.sourceCardIds.includes(item.cardId))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence"],
      message: "Claim Evidence Cards must belong to sourceCardIds"
    });
  }
  const evidenceCardIds = [...new Set(
    claim.evidence.map((item) => item.cardId)
  )].sort();
  if (
    JSON.stringify(evidenceCardIds)
      !== JSON.stringify([...claim.sourceCardIds].sort())
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceCardIds"],
      message: "Every Claim source Card must have Evidence"
    });
  }
  if (claim.sourceMemoryIds.length > claim.sourceCardIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceMemoryIds"],
      message: "Claim Memory sources cannot outnumber grounded Card sources"
    });
  }
});

export const DailyReflectionQueryResurfacingSchema = z.object({
  title: z.string().trim().min(1).max(240),
  body: z.string().trim().min(1).max(1_000),
  earliestDate: z.string().date(),
  evidence: DailyReflectionReturnEvidenceSchema
}).strict();

export const DailyReflectionQueryResponseSchema = z.object({
  answer: z.string().trim().min(1).max(4_000),
  claims: z.array(DailyReflectionQueryClaimSchema).max(8),
  intent: DailyReflectionQueryIntentSchema,
  confidence: z.number().min(0).max(1),
  insufficientEvidence: z.boolean(),
  resurfacing: DailyReflectionQueryResurfacingSchema.nullable(),
  createdAt: z.string().datetime()
}).strict().superRefine((response, context) => {
  if (response.insufficientEvidence !== (response.claims.length === 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["insufficientEvidence"],
      message: "insufficientEvidence must reflect whether Claims exist"
    });
  }
  if (response.insufficientEvidence && response.confidence !== 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["confidence"],
      message: "insufficient answers must have zero confidence"
    });
  }
  if (response.insufficientEvidence && response.resurfacing !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["resurfacing"],
      message: "insufficient answers cannot include resurfacing"
    });
  }
  if (response.resurfacing) {
    const source = response.resurfacing.evidence;
    const belongsToClaim = response.claims.some((claim) => claim.evidence.some(
      (evidence) => JSON.stringify(evidence) === JSON.stringify(source)
    ));
    if (
      !belongsToClaim
      || response.resurfacing.earliestDate !== source.recordingDate
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resurfacing"],
        message: "resurfacing must reuse Claim Evidence and its date"
      });
    }
  }
  const evidenceAuthority = new Map<string, string>();
  for (const evidence of response.claims.flatMap((claim) => claim.evidence)) {
    const authority = JSON.stringify(evidence);
    const existing = evidenceAuthority.get(evidence.sourceSegmentId);
    if (existing && existing !== authority) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["claims"],
        message: "A Segment ID cannot identify multiple Evidence authorities"
      });
      break;
    }
    evidenceAuthority.set(evidence.sourceSegmentId, authority);
  }
  if (
    response.claims.some((claim) => claim.epistemicStatuses.some(
      (status) => status === "ai_inference" || status === "unknown"
    ))
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["claims"],
      message: "AI inference and unknown sources cannot become factual Claims"
    });
  }
});

export type DailyReflectionQueryIntent = z.infer<
  typeof DailyReflectionQueryIntentSchema
>;
export type DailyReflectionQueryScope = z.infer<
  typeof DailyReflectionQueryScopeSchema
>;
export type DailyReflectionQueryRequest = z.infer<
  typeof DailyReflectionQueryRequestSchema
>;
export type DailyReflectionQueryClaim = z.infer<
  typeof DailyReflectionQueryClaimSchema
>;
export type DailyReflectionQueryResponse = z.infer<
  typeof DailyReflectionQueryResponseSchema
>;
