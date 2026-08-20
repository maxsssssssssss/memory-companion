import { NextResponse } from "next/server";
import { z } from "zod";
import {
  DcIdSchema,
  DcSubjectSuggestionConfirmationSchema
} from "@/lib/domain/date-companion-stage2";

export const DateCompanionMemorySettingRequestSchema = z.object({
  enabled: z.boolean(),
  expectedVersion: z.number().int().nonnegative()
}).strict();

export const DateCompanionPersonMappingRequestSchema = z.object({
  selfPersonId: DcIdSchema,
  companionPersonId: DcIdSchema,
  relationshipType: z.enum(["dating", "partner", "friend", "other"]),
  expectedVersion: z.number().int().nonnegative()
}).strict();

export const DateCompanionMemorySyncRequestSchema = z.object({
  mappingVersion: z.number().int().positive(),
  subjectSuggestionConfirmation: DcSubjectSuggestionConfirmationSchema.optional(),
  relationshipReconfirmation: z.object({
    action: z.literal("reconfirm_archived_relationship"),
    idempotencyKey: z.string().trim().min(8).max(200)
  }).strict().optional(),
  selections: z.array(z.object({
    evidenceSnapshotId: DcIdSchema,
    subject: z.enum(["self", "companion", "both", "unknown"])
  }).strict()).max(2_000).optional()
}).strict().refine(
  (input) => input.selections === undefined || input.subjectSuggestionConfirmation !== undefined,
  { message: "Subject suggestion confirmation is required with selections" }
).refine(
  (input) => !input.relationshipReconfirmation
    || Boolean(input.subjectSuggestionConfirmation && input.selections && input.selections.length > 0),
  { message: "A current Subject confirmation is required to reactivate an archived relationship" }
);

export const DateCompanionRetainedMemoryPurgeRequestSchema = z.object({
  confirmation: z.literal("purge_retained_memory")
}).strict();

export const DATE_COMPANION_MEMORY_PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Pragma": "no-cache"
} as const;

export function privateMemoryJson(value: unknown, status = 200) {
  return NextResponse.json(value, {
    status,
    headers: DATE_COMPANION_MEMORY_PRIVATE_HEADERS
  });
}

export function privateMemoryResponse(response: Response) {
  response.headers.set("Cache-Control", DATE_COMPANION_MEMORY_PRIVATE_HEADERS["Cache-Control"]);
  response.headers.set("Pragma", DATE_COMPANION_MEMORY_PRIVATE_HEADERS.Pragma);
  return response;
}
