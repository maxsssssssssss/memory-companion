import { z } from "zod";

import { RelationshipSignalCategorySchema, TimeRangeSchema } from "./types";

const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const ProactiveInsightScopeSchema = z.enum(["current", "week", "all"]);
export const ProactiveEvidenceKindSchema = z.enum([
  "relationship_signal",
  "brief",
  "semantic_segment",
  "audio_insight"
]);
export const ProactiveEvidenceSourceTypeSchema = ProactiveEvidenceKindSchema;

export const ProactiveEvidenceSchema = z.object({
  evidenceId: z.string().min(1).max(512),
  kind: ProactiveEvidenceKindSchema,
  sourceType: ProactiveEvidenceSourceTypeSchema,
  sourceId: z.string().min(1).max(512),
  uploadId: z.string().min(1).max(120),
  recordingDate: DateOnlySchema,
  sourceSegmentIds: z.array(z.string().min(1).max(120)).min(1).max(4),
  timeRange: TimeRangeSchema,
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(400),
  excerpt: z.string().min(1).max(800),
  confidence: z.number().min(0).max(1).optional(),
  caution: z.string().min(1).max(240).optional(),
  signalCategory: RelationshipSignalCategorySchema.optional()
});

export const ProactiveInsightDateRangeSchema = z.object({
  startDate: DateOnlySchema,
  endDate: DateOnlySchema
});

export const ProactiveInsightContextSchema = z.object({
  schemaVersion: z.literal(1),
  scope: ProactiveInsightScopeSchema,
  referenceDate: DateOnlySchema,
  dateRange: ProactiveInsightDateRangeSchema,
  sourceUploadIds: z.array(z.string().min(1).max(120)).max(31),
  distinctDates: z.array(DateOnlySchema).max(31),
  evidence: z.array(ProactiveEvidenceSchema).max(24),
  truncated: z.boolean()
});

export const ProactiveInsightTypeSchema = z.enum([
  "relationship_question",
  "follow_up_question",
  "unresolved_issue",
  "memory_pattern",
  "reflection"
]);
export const ProactiveInsightCategorySchema = z.enum([
  "relationship",
  "follow_up",
  "summary",
  "tone",
  "memory"
]);
export const ProactiveReflectionTypeSchema = z.enum([
  "reminder",
  "reflection",
  "follow_up",
  "pattern_observation"
]);

export const ProactiveInsightRawItemSchema = z.object({
  type: ProactiveInsightTypeSchema,
  insightType: ProactiveReflectionTypeSchema.optional(),
  category: ProactiveInsightCategorySchema,
  observation: z.string().trim().min(1).max(280),
  question: z.string().trim().min(1).max(280),
  reason: z.string().trim().min(1).max(360),
  evidenceIds: z.array(z.string().min(1).max(512)).min(1).max(4),
  memoryRefs: z.array(z.string().min(1).max(512)).max(4).optional(),
  confidence: z.number().min(0).max(1),
  caution: z.string().trim().min(1).max(240).optional()
}).strict();

export const ProactiveInsightSchema = z.object({
  id: z.string().min(1).max(120),
  scope: ProactiveInsightScopeSchema,
  type: ProactiveInsightTypeSchema,
  insightType: ProactiveReflectionTypeSchema.optional(),
  category: ProactiveInsightCategorySchema,
  observation: z.string().trim().min(1).max(280),
  question: z.string().trim().min(1).max(280),
  reason: z.string().trim().min(1).max(360),
  confidence: z.number().min(0).max(1),
  evidenceRefs: z.array(ProactiveEvidenceSchema).min(1).max(4),
  memoryRefs: z.array(z.string().min(1).max(512)).max(4).optional(),
  sourceUploadIds: z.array(z.string().min(1).max(120)).min(1).max(4),
  caution: z.string().min(1).max(240).optional(),
  createdAt: z.string().datetime()
});

export const ProactiveInsightCacheStatusSchema = z.enum(["generated", "fallback", "disabled"]);

export const ProactiveInsightCacheDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  cacheId: z.string().min(1).max(120),
  scope: ProactiveInsightScopeSchema,
  status: ProactiveInsightCacheStatusSchema,
  sourceFingerprint: z.string().min(1).max(128),
  generatedAt: z.string().datetime(),
  provider: z.enum(["deepseek", "none"]).optional(),
  model: z.string().min(1).max(64).optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
  failureCode: z.string().min(1).max(64).optional(),
  items: z.array(ProactiveInsightSchema)
});

export type ProactiveInsightScope = z.infer<typeof ProactiveInsightScopeSchema>;
export type ProactiveEvidenceKind = z.infer<typeof ProactiveEvidenceKindSchema>;
export type ProactiveEvidence = z.infer<typeof ProactiveEvidenceSchema>;
export type ProactiveInsightContext = z.infer<typeof ProactiveInsightContextSchema>;
export type ProactiveInsightType = z.infer<typeof ProactiveInsightTypeSchema>;
export type ProactiveReflectionType = z.infer<typeof ProactiveReflectionTypeSchema>;
export type ProactiveInsightCategory = z.infer<typeof ProactiveInsightCategorySchema>;
export type ProactiveInsightRawItem = z.infer<typeof ProactiveInsightRawItemSchema>;
export type ProactiveInsight = z.infer<typeof ProactiveInsightSchema>;
export type ProactiveInsightCacheStatus = z.infer<typeof ProactiveInsightCacheStatusSchema>;
export type ProactiveInsightCacheDocument = z.infer<typeof ProactiveInsightCacheDocumentSchema>;

export function proactiveInsightCacheIdForUpload(uploadId: string) {
  return `current_${uploadId}`;
}
