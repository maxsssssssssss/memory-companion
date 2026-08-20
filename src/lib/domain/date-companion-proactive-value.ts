import { z } from "zod";

import {
  DcIdSchema,
  DcMemorySubjectSchema,
  DcRecordingDateSchema
} from "./date-companion-stage2";

export const DATE_COMPANION_PROACTIVE_VALUE_CONTRACT_VERSION = 1 as const;
export const DATE_COMPANION_PROACTIVE_VALUE_RESPONSE_VERSION = 2 as const;

export const DateCompanionProactiveValueScopeSchema = z.enum([
  "current_interaction",
  "person_relationship"
]);

export const DateCompanionProactiveEvidenceOriginSchema = z.enum([
  "direct_conversation",
  "user_reflection"
]);

const DateCompanionProactiveEvidenceObjectSchema = z.object({
  evidenceId: z.string().trim().min(1).max(512),
  uploadId: DcIdSchema,
  sourceSegmentId: z.string().trim().min(1).max(512),
  recordingDate: DcRecordingDateSchema,
  startSeconds: z.number().nonnegative().optional(),
  endSeconds: z.number().positive().optional(),
  speakerId: z.string().trim().min(1).max(512).optional(),
  quote: z.string().trim().min(1).max(4_000),
  contentDigest: z.string().length(64).regex(/^[a-f0-9]+$/u),
  origin: DateCompanionProactiveEvidenceOriginSchema,
  subject: DcMemorySubjectSchema.extract(["self", "companion", "both"]),
  subjectVersion: z.number().int().positive().optional()
}).strict();

export const DateCompanionProactiveEvidenceSchema = DateCompanionProactiveEvidenceObjectSchema.refine(
  (evidence) => evidence.startSeconds === undefined
    && evidence.endSeconds === undefined
    || evidence.startSeconds !== undefined
    && evidence.endSeconds !== undefined
    && evidence.endSeconds > evidence.startSeconds,
  { message: "Evidence timing must be complete and ordered" }
);

export const DateCompanionProactiveEvidenceReferenceSchema =
  DateCompanionProactiveEvidenceObjectSchema;

export const DateCompanionProactiveValueContextSchema = z.object({
  schemaVersion: z.literal(DATE_COMPANION_PROACTIVE_VALUE_CONTRACT_VERSION),
  scope: DateCompanionProactiveValueScopeSchema,
  relationshipId: DcIdSchema,
  interactionId: DcIdSchema.optional(),
  personId: DcIdSchema.optional(),
  mappingVersion: z.number().int().positive(),
  interactionVersion: z.number().int().nonnegative().optional(),
  confirmationFingerprint: z.string().length(64).regex(/^[a-f0-9]+$/u).optional(),
  evidence: z.array(DateCompanionProactiveEvidenceSchema).min(1).max(24)
}).strict().superRefine((context, issue) => {
  if (context.scope === "current_interaction") {
    if (!context.interactionId || context.interactionVersion === undefined) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Current interaction scope requires interaction identity and version"
      });
    }
    if (context.personId !== undefined) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Current interaction scope must not guess a Person"
      });
    }
    if (context.evidence.some((evidence) => evidence.origin !== "direct_conversation")) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Current interaction scope accepts only direct conversation Evidence"
      });
    }
  } else if (!context.personId || context.interactionId !== undefined) {
    issue.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Person relationship scope requires only a stable Person"
    });
  }
  if (new Set(context.evidence.map((evidence) => evidence.evidenceId)).size !== context.evidence.length) {
    issue.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Proactive Evidence IDs must be unique"
    });
  }
});

export const DateCompanionProactiveValueSchema = z.object({
  observation: z.string().trim().min(1).max(360),
  suggestedQuestions: z.array(z.string().trim().min(1).max(280)).min(1).max(2),
  reason: z.string().trim().min(1).max(480),
  evidenceIds: z.array(z.string().trim().min(1).max(512)).min(1).max(4),
  confidence: z.number().min(0).max(1),
  caution: z.string().trim().min(1).max(360)
}).strict().superRefine((value, issue) => {
  if (new Set(value.suggestedQuestions).size !== value.suggestedQuestions.length) {
    issue.addIssue({ code: z.ZodIssueCode.custom, message: "Suggested questions must be unique" });
  }
  if (new Set(value.evidenceIds).size !== value.evidenceIds.length) {
    issue.addIssue({ code: z.ZodIssueCode.custom, message: "Evidence IDs must be unique" });
  }
});

export const DateCompanionProactiveValueStatusSchema = z.enum([
  "processing",
  "ready",
  "fallback",
  "unavailable"
]);

export const DateCompanionProactiveValueResponseSchema = z.object({
  schemaVersion: z.literal(DATE_COMPANION_PROACTIVE_VALUE_RESPONSE_VERSION),
  scope: DateCompanionProactiveValueScopeSchema,
  relationshipId: DcIdSchema,
  interactionId: DcIdSchema.optional(),
  personId: DcIdSchema.optional(),
  mappingVersion: z.number().int().positive().nullable(),
  status: DateCompanionProactiveValueStatusSchema,
  sourceFingerprint: z.string().length(64).regex(/^[a-f0-9]+$/u).optional(),
  cacheHit: z.boolean(),
  value: DateCompanionProactiveValueSchema.optional(),
  evidenceReferences: z.array(DateCompanionProactiveEvidenceReferenceSchema).max(24),
  failureCode: z.string().trim().min(1).max(80).optional()
}).strict().superRefine((response, issue) => {
  const available = response.status === "ready" || response.status === "fallback";
  if (available !== Boolean(response.value && response.sourceFingerprint)) {
    issue.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Available proactive value requires value and fingerprint"
    });
  }
  if (!available && response.evidenceReferences.length > 0) {
    issue.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Pending or unavailable proactive value cannot expose stale Evidence"
    });
  }
});

export type DateCompanionProactiveValueScope = z.infer<
  typeof DateCompanionProactiveValueScopeSchema
>;
export type DateCompanionProactiveEvidence = z.infer<
  typeof DateCompanionProactiveEvidenceSchema
>;
export type DateCompanionProactiveValueContext = z.infer<
  typeof DateCompanionProactiveValueContextSchema
>;
export type DateCompanionProactiveValue = z.infer<
  typeof DateCompanionProactiveValueSchema
>;
export type DateCompanionProactiveValueResponse = z.infer<
  typeof DateCompanionProactiveValueResponseSchema
>;
