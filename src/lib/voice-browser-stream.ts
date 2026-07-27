import { z } from "zod";

import { QuestionAnswerSchema } from "@/lib/domain/types";

const Base64Schema = z.string().min(1).max(256 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/u);
const StoreKeySchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/u);
const QuestionAnswerCitationsSchema = QuestionAnswerSchema.shape.citations.unwrap();

export const VoiceBrowserAnswerMetadataSchema = z.object({
  id: QuestionAnswerSchema.shape.id,
  citedSegmentIds: QuestionAnswerSchema.shape.citedSegmentIds,
  citations: QuestionAnswerCitationsSchema
}).strict();

export const VoiceBrowserStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("meta"),
    version: z.literal(1),
    conversationSessionId: StoreKeySchema,
    traceId: z.string().uuid(),
    audio: z.object({
      format: z.literal("pcm_s16le"),
      sampleRate: z.literal(24_000),
      channels: z.literal(1)
    }).strict()
  }).strict(),
  z.object({
    type: z.literal("audio_chunk"),
    sequence: z.number().int().positive(),
    sentenceSequence: z.number().int().positive(),
    chunkSequence: z.number().int().positive(),
    audioBase64: Base64Schema
  }).strict(),
  z.object({
    type: z.literal("answer"),
    sessionId: StoreKeySchema,
    transcript: z.string().max(4_000),
    text: z.string().max(16_000),
    answer: VoiceBrowserAnswerMetadataSchema.optional(),
    errors: z.array(z.string().min(1).max(128)).max(8).optional(),
    errorCodes: z.array(z.string().min(1).max(128)).max(8).optional()
  }).strict(),
  z.object({
    type: z.literal("fallback_audio"),
    audioBase64: z.string().min(1).max(16 * 1024 * 1024),
    audioMimeType: z.literal("audio/wav")
  }).strict(),
  z.object({
    type: z.literal("error"),
    code: z.string().min(1).max(128),
    textAvailable: z.boolean()
  }).strict(),
  z.object({
    type: z.literal("complete"),
    status: z.enum(["completed", "completed_with_errors", "failed", "aborted"]),
    errors: z.array(z.string().min(1).max(128)).max(8)
  }).strict()
]);

export type VoiceBrowserStreamEvent = z.infer<typeof VoiceBrowserStreamEventSchema>;
export type VoiceBrowserAnswerMetadata = z.infer<typeof VoiceBrowserAnswerMetadataSchema>;

export function encodeVoiceBrowserStreamEvent(event: VoiceBrowserStreamEvent) {
  const validated = VoiceBrowserStreamEventSchema.parse(event);
  return new TextEncoder().encode(`${JSON.stringify(validated)}\n`);
}
