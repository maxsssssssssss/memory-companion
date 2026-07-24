import { z } from "zod";
import { RelationshipSignalTypeSchema } from "@/lib/domain/types";

export const RelationshipLifecycleRelationTypeSchema = z.enum([
  "resolved_by",
  "fulfilled_by",
  "answered_by",
  "updated_by"
]);

export const RelationshipLifecycleRoleSchema = z.enum([
  "question",
  "plan",
  "commitment",
  "concern",
  "answer",
  "completion",
  "fulfillment",
  "resolution",
  "update"
]);

export const RelationshipLifecycleSignalSchema = z.object({
  id: z.string().min(1),
  signalType: RelationshipSignalTypeSchema,
  signalCategory: z.enum(["positive", "risk", "uncertain"]).optional(),
  summary: z.string().min(1),
  evidenceSegmentIds: z.array(z.string().min(1)).min(1),
  evidenceText: z.array(z.string()).default([]),
  timeRange: z.object({
    startSeconds: z.number().nonnegative(),
    endSeconds: z.number().positive()
  }).refine((range) => range.endSeconds > range.startSeconds, {
    message: "lifecycle signal time range must be valid"
  }),
  speakers: z.array(z.string().min(1)).default([]),
  confidence: z.number().min(0).max(1),
  date: z.string().min(1).optional(),
  metadata: z.object({
    entities: z.array(z.string().min(1)).optional(),
    goals: z.array(z.string().min(1)).optional(),
    timeframes: z.array(z.string().min(1)).optional(),
    status: z.string().min(1).optional()
  }).strict().optional()
}).strict();

export const RelationshipLifecycleEdgeSchema = z.object({
  fromSignalId: z.string().min(1),
  toSignalId: z.string().min(1),
  relationType: RelationshipLifecycleRelationTypeSchema,
  confidence: z.number().min(0).max(1),
  evidence: z.object({
    fromSegments: z.array(z.string().min(1)).min(1),
    toSegments: z.array(z.string().min(1)).min(1)
  }).strict(),
  reason: z.string().min(1)
}).strict().refine((edge) => edge.fromSignalId !== edge.toSignalId, {
  message: "lifecycle edge endpoints must differ"
});

export const RelationshipLifecycleRejectionReasonSchema = z.enum([
  "different_entity",
  "different_time_window",
  "different_signal_type",
  "different_goal",
  "non_forward_time",
  "unrelated_interaction_context",
  "lower_confidence_match"
]);

export const RelationshipLifecycleMatchAuditSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  accepted: z.boolean(),
  relationType: RelationshipLifecycleRelationTypeSchema.optional(),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().min(1).optional(),
  rejectionReason: RelationshipLifecycleRejectionReasonSchema.optional()
}).strict();

export type RelationshipLifecycleRelationType = z.infer<typeof RelationshipLifecycleRelationTypeSchema>;
export type RelationshipLifecycleRole = z.infer<typeof RelationshipLifecycleRoleSchema>;
export type RelationshipLifecycleSignal = z.infer<typeof RelationshipLifecycleSignalSchema>;
export type RelationshipLifecycleEdge = z.infer<typeof RelationshipLifecycleEdgeSchema>;
export type RelationshipLifecycleRejectionReason = z.infer<typeof RelationshipLifecycleRejectionReasonSchema>;
export type RelationshipLifecycleMatchAudit = z.infer<typeof RelationshipLifecycleMatchAuditSchema>;

export type RelationshipLifecycleAudit = {
  version: 1;
  candidatePairsChecked: number;
  lifecycleEdgesCreated: number;
  rejectedMatches: Partial<Record<RelationshipLifecycleRejectionReason, number>>;
  matches: RelationshipLifecycleMatchAudit[];
  edges: RelationshipLifecycleEdge[];
};

export type RelationshipLifecycleResolution = {
  edges: RelationshipLifecycleEdge[];
  audit: RelationshipLifecycleAudit;
};
