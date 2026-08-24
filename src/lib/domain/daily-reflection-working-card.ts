import { z } from "zod";

import {
  CandidateKindV2Schema,
  DailyReflectionIdSchema,
  DailyReflectionVersionSchema
} from "./daily-reflection";

export const DailyReflectionWorkingCardKindSchema = z.enum([
  "idea",
  "insight",
  "question",
  "decision",
  "event",
  "action"
]);

export const DailyReflectionWorkingCardStatusSchema = z.enum([
  "generated",
  "review_pending",
  "saved",
  "archived",
  "removed"
]);

export const DailyReflectionWorkingCardVisibilitySchema = z.literal("private");

export const DailyReflectionWorkingCardMemoryLifecycleStatusSchema = z.enum([
  "not_admitted",
  "active",
  "revocation_requested",
  "revoked"
]);

export const DailyReflectionWorkingCardBaseSchema = z.object({
  id: DailyReflectionIdSchema,
  accountId: DailyReflectionIdSchema,
  sourceReflectionIds: z.array(DailyReflectionIdSchema).min(1).max(64),
  title: z.string().trim().min(1).max(240),
  content: z.string().trim().min(1).max(20_000),
  cardKind: DailyReflectionWorkingCardKindSchema,
  evidenceIds: z.array(DailyReflectionIdSchema).min(1).max(64),
  status: DailyReflectionWorkingCardStatusSchema,
  importance: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  relatedCardIds: z.array(DailyReflectionIdSchema).max(64),
  tags: z.array(z.string().trim().min(1).max(64)).max(24),
  visibility: DailyReflectionWorkingCardVisibilitySchema,
  sourceUnavailable: z.boolean(),
  memoryLifecycleStatus: DailyReflectionWorkingCardMemoryLifecycleStatusSchema
    .default("not_admitted"),
  memoryLifecycleVersion: DailyReflectionVersionSchema.default(0),
  memoryLifecycleUpdatedAt: z.string().datetime().nullable().default(null),
  version: DailyReflectionVersionSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

export const DailyReflectionWorkingCardSchema = DailyReflectionWorkingCardBaseSchema
  .superRefine((card, context) => {
  for (const [field, values] of [
    ["sourceReflectionIds", card.sourceReflectionIds],
    ["evidenceIds", card.evidenceIds],
    ["relatedCardIds", card.relatedCardIds],
    ["tags", card.tags]
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} must be unique`
      });
    }
  }
  if (card.relatedCardIds.includes(card.id)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["relatedCardIds"],
      message: "a Working Card cannot relate to itself"
    });
  }
  });

export function workingCardKindForReflectionCard(
  kind: z.infer<typeof CandidateKindV2Schema>
): z.infer<typeof DailyReflectionWorkingCardKindSchema> {
  switch (kind) {
    case "open_question": return "question";
    case "user_action": return "action";
    case "insight": return "insight";
    case "decision": return "decision";
  }
}

export type DailyReflectionWorkingCard = z.infer<
  typeof DailyReflectionWorkingCardSchema
>;
export type DailyReflectionWorkingCardKind = z.infer<
  typeof DailyReflectionWorkingCardKindSchema
>;
export type DailyReflectionWorkingCardStatus = z.infer<
  typeof DailyReflectionWorkingCardStatusSchema
>;
export type DailyReflectionWorkingCardMemoryLifecycleStatus = z.infer<
  typeof DailyReflectionWorkingCardMemoryLifecycleStatusSchema
>;
