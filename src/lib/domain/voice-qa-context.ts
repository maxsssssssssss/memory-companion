import { z } from "zod";

import {
  AudioInsightSchema,
  BriefItemSchema,
  RelationshipSignalCardSchema,
  SemanticSegmentSchema,
  TranscriptSegmentSchema
} from "./types";

export const MAX_VOICE_QA_CONTEXT_BYTES = 4 * 1024 * 1024;

const CONTEXT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export const VoiceQaContextSchema = z.object({
  contextId: z.string().min(1).max(200).regex(CONTEXT_ID_PATTERN),
  segments: z.array(TranscriptSegmentSchema).max(2_000),
  audioInsights: z.array(AudioInsightSchema).max(1_000),
  semanticSegments: z.array(SemanticSegmentSchema).max(1_000),
  briefItems: z.array(BriefItemSchema).max(1_000),
  relationshipSignals: z.array(RelationshipSignalCardSchema).max(1_000)
}).strict().refine(
  (context) =>
    context.segments.length > 0 ||
    context.audioInsights.length > 0 ||
    context.semanticSegments.length > 0 ||
    context.briefItems.length > 0 ||
    context.relationshipSignals.length > 0,
  { message: "Voice QA context must contain at least one evidence-bearing item" }
);

export type VoiceQaContext = z.infer<typeof VoiceQaContextSchema>;
