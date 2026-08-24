import { z } from "zod";

import {
  DailyReflectionIdSchema,
  DailyReflectionVersionSchema
} from "./daily-reflection";
import {
  DailyReflectionWorkingCardMemoryLifecycleStatusSchema,
  DailyReflectionWorkingCardBaseSchema
} from "./daily-reflection-working-card";

export const DailyReflectionCardMemoryRevocationOperationStatusSchema = z.enum([
  "ready",
  "revoking",
  "completed",
  "failed"
]);

export const DailyReflectionCardMemoryRevocationIndexStatusSchema = z.enum([
  "not_required",
  "pending",
  "enqueued",
  "failed"
]);

export const DailyReflectionCardMemoryRevocationOutcomeSchema = z.enum([
  "revoked",
  "no_long_term_object"
]);

export const DailyReflectionCardMemoryRevocationRequestSchema = z.object({
  expectedMemoryLifecycleVersion: DailyReflectionVersionSchema,
  idempotencyKey: z.string().trim().min(1).max(512)
}).strict();

export const DailyReflectionCardMemoryRevocationOperationSchema = z.object({
  id: DailyReflectionIdSchema,
  accountId: DailyReflectionIdSchema,
  cardId: DailyReflectionIdSchema,
  reflectionId: DailyReflectionIdSchema,
  proposalId: DailyReflectionIdSchema.nullable(),
  authorityConfirmationId: DailyReflectionIdSchema.nullable(),
  authorityMemoryId: DailyReflectionIdSchema.nullable(),
  operationKey: z.string().trim().min(1).max(512),
  idempotencyKey: z.string().trim().min(1).max(512),
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  requestedMemoryLifecycleVersion: DailyReflectionVersionSchema,
  status: DailyReflectionCardMemoryRevocationOperationStatusSchema,
  attemptVersion: DailyReflectionVersionSchema,
  indexRefreshStatus: DailyReflectionCardMemoryRevocationIndexStatusSchema,
  errorCode: z.string().trim().min(1).max(128).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable()
}).strict().superRefine((operation, context) => {
  if (
    (operation.authorityConfirmationId === null)
    !== (operation.authorityMemoryId === null)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authorityMemoryId"],
      message: "authority confirmation and Memory must be present together"
    });
  }
  if (operation.operationKey !== `daily-reflection-card-revocation:${operation.cardId}`) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["operationKey"],
      message: "operationKey must be stable for the Working Card"
    });
  }
  if ((operation.status === "completed") !== (operation.completedAt !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["completedAt"],
      message: "completedAt must exactly match completed status"
    });
  }
});

export const DailyReflectionCardMemoryRevocationReceiptSchema = z.object({
  cardId: DailyReflectionIdSchema,
  proposalId: DailyReflectionIdSchema.nullable(),
  outcome: DailyReflectionCardMemoryRevocationOutcomeSchema,
  historicalMemoryId: DailyReflectionIdSchema.nullable(),
  removedMemoryEvidenceCount: z.number().int().nonnegative(),
  removedPersonSourceCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime()
}).strict().superRefine((receipt, context) => {
  if ((receipt.outcome === "revoked") !== (receipt.historicalMemoryId !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["historicalMemoryId"],
      message: "only revoked receipts carry a historical Memory id"
    });
  }
});

export const DailyReflectionCardMemoryRevocationPublicOperationSchema = z.object({
  status: DailyReflectionCardMemoryRevocationOperationStatusSchema,
  attemptVersion: DailyReflectionVersionSchema,
  requestedMemoryLifecycleVersion: DailyReflectionVersionSchema,
  indexRefreshStatus: DailyReflectionCardMemoryRevocationIndexStatusSchema,
  errorCode: z.string().trim().min(1).max(128).nullable(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable()
}).strict();

export const DailyReflectionCardMemoryRevocationResponseSchema = z.object({
  card: DailyReflectionWorkingCardBaseSchema.omit({ accountId: true }),
  lifecycleStatus: DailyReflectionWorkingCardMemoryLifecycleStatusSchema,
  operation: DailyReflectionCardMemoryRevocationPublicOperationSchema,
  receipt: DailyReflectionCardMemoryRevocationReceiptSchema.nullable(),
  reused: z.boolean()
}).strict();

export const DailyReflectionCardMemoryRevocationLookupResponseSchema =
  z.discriminatedUnion("found", [
    z.object({ found: z.literal(false) }).strict(),
    z.object({
      found: z.literal(true),
      result: DailyReflectionCardMemoryRevocationResponseSchema
    }).strict()
  ]);

export type DailyReflectionCardMemoryRevocationOperation = z.infer<
  typeof DailyReflectionCardMemoryRevocationOperationSchema
>;
export type DailyReflectionCardMemoryRevocationReceipt = z.infer<
  typeof DailyReflectionCardMemoryRevocationReceiptSchema
>;
export type DailyReflectionCardMemoryRevocationRequest = z.infer<
  typeof DailyReflectionCardMemoryRevocationRequestSchema
>;
export type DailyReflectionCardMemoryRevocationResponse = z.infer<
  typeof DailyReflectionCardMemoryRevocationResponseSchema
>;
export type DailyReflectionCardMemoryRevocationLookupResponse = z.infer<
  typeof DailyReflectionCardMemoryRevocationLookupResponseSchema
>;
