import { z } from "zod";

import { QuestionAnswerSchema } from "@/lib/domain/types";

const IdentifierSchema = z.string().trim().min(1).max(256);
const SafeErrorCodeSchema = z.string().min(1).max(128).regex(/^[a-z0-9_]+$/u);

const GroundedSentenceEventSchema = z.object({
  type: z.literal("sentence"),
  sequence: z.number().int().positive(),
  text: z.string().trim().min(1).max(16_000),
  supportIds: z.array(IdentifierSchema).min(1).max(128),
  citedSegmentIds: z.array(IdentifierSchema).min(1).max(128),
  groundingValidated: z.literal(true)
}).strict();

export const QaBrowserStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("meta"),
    version: z.literal(1),
    streamId: z.string().uuid()
  }).strict(),
  GroundedSentenceEventSchema,
  z.object({
    type: z.literal("final"),
    answer: QuestionAnswerSchema.strict(),
    source: z.enum([
      "provider_stream",
      "provider_stream_validation_fallback",
      "non_stream_fallback"
    ])
  }).strict(),
  z.object({
    type: z.literal("error"),
    code: SafeErrorCodeSchema,
    recoverable: z.boolean()
  }).strict(),
  z.object({
    type: z.literal("complete"),
    status: z.enum(["completed", "completed_with_fallback", "failed"])
  }).strict()
]).superRefine((event, context) => {
  if (event.type !== "sentence") return;

  const supportIds = new Set(event.supportIds);
  const citedSegmentIds = new Set(event.citedSegmentIds);
  const hasDuplicates =
    supportIds.size !== event.supportIds.length ||
    citedSegmentIds.size !== event.citedSegmentIds.length;
  const sameCanonicalIds =
    supportIds.size === citedSegmentIds.size &&
    [...supportIds].every((id) => citedSegmentIds.has(id));

  if (hasDuplicates || !sameCanonicalIds) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["citedSegmentIds"],
      message: "Grounded sentence source IDs must be unique and match support IDs"
    });
  }
});

export type QaBrowserStreamEvent = z.infer<typeof QaBrowserStreamEventSchema>;
export type QaBrowserGroundedSentenceEvent = Extract<
  QaBrowserStreamEvent,
  { type: "sentence" }
>;

export function encodeQaBrowserStreamEvent(event: QaBrowserStreamEvent) {
  const validated = QaBrowserStreamEventSchema.parse(event);
  return new TextEncoder().encode(`${JSON.stringify(validated)}\n`);
}
