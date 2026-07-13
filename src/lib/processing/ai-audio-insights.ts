import { z } from "zod";

import {
  AtmosphereLabelSchema,
  AudioInsightSchema,
  EmotionLabelSchema,
  EmotionEvidenceSchema,
  InteractionLabelSchema,
  SpeakerRoleSchema,
  ToneLabelSchema,
  VoicePaceSchema,
  VoicePauseSchema,
  VoiceVolumeSchema,
  type AudioInsight,
  type TranscriptSegment
} from "@/lib/domain/types";

function evidenceText(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as Record<string, unknown>;
  const stringPartsFromUnknown = (item: unknown): string[] => {
    if (typeof item === "string") {
      return [item];
    }
    if (!item || typeof item !== "object") {
      return [];
    }

    const nestedRecord = item as Record<string, unknown>;
    return [nestedRecord.quote, nestedRecord.detail, nestedRecord.reason, nestedRecord.summary].filter(
      (entry): entry is string => typeof entry === "string"
    );
  };
  const parts = [record.textEvidence, record.reason, record.detail, record.summary]
    .flatMap((item) => {
      if (typeof item === "string") {
        return [item];
      }
      if (Array.isArray(item)) {
        return item.flatMap(stringPartsFromUnknown);
      }
      return [];
    })
    .map((item) => item.trim())
    .filter(Boolean);

  return parts.length > 0 ? parts.join(" ") : JSON.stringify(value);
}

const AiAudioInsightItemSchema = z.object({
  sourceSegmentIds: z.array(z.string().min(1)).min(1),
  speaker: z.object({
    id: z.string().min(1).nullable().optional(),
    displayName: z.string().min(1).nullable().optional(),
    role: SpeakerRoleSchema.default("unknown"),
    confidence: z.number().min(0).max(1).default(0.45)
  }),
  voice: z.object({
    pace: VoicePaceSchema.default("unknown"),
    volume: VoiceVolumeSchema.default("unknown"),
    pause: VoicePauseSchema.default("unknown"),
    overlap: z.boolean().default(false),
    confidence: z.number().min(0).max(1).default(0.35)
  }),
  toneLabels: z.array(ToneLabelSchema).min(1),
  emotionLabels: z.array(EmotionLabelSchema).min(1),
  interactionLabels: z.array(InteractionLabelSchema).min(1),
  atmosphereLabels: z.array(z.unknown()).nullable().optional(),
  emotionEvidence: z.array(z.unknown()).nullable().optional(),
  summary: z.string().min(1),
  evidence: z.preprocess(evidenceText, z.string().min(1)),
  confidence: z.number().min(0).max(1).default(0.55)
});

export const AiAudioInsightItemsSchema = z.object({
  items: z.array(AiAudioInsightItemSchema)
});

export type AiAudioInsightItem = z.infer<typeof AiAudioInsightItemSchema>;

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

function normalizeAtmosphereLabels(labels: unknown[] | null | undefined) {
  return labels?.flatMap((label) => {
    const parsedLabel = AtmosphereLabelSchema.safeParse(label);
    return parsedLabel.success ? [parsedLabel.data] : [];
  });
}

function normalizeEmotionEvidence(items: unknown[] | null | undefined, sourceSegmentIds: string[]) {
  return items
    ?.flatMap((item) => {
      const parsedItem = EmotionEvidenceSchema.safeParse(item);
      return parsedItem.success ? [parsedItem.data] : [];
    })
    .filter((item) => item.sourceSegmentIds.every((segmentId) => sourceSegmentIds.includes(segmentId)));
}

export function normalizeAiAudioInsightItems(input: {
  uploadId: string;
  segments: TranscriptSegment[];
  items: unknown[];
}): AudioInsight[] {
  const segmentById = new Map(input.segments.map((segment) => [segment.id, segment]));

  return input.items.flatMap((rawItem, index): AudioInsight[] => {
    const parsedItem = AiAudioInsightItemSchema.safeParse(rawItem);
    if (!parsedItem.success) {
      return [];
    }

    const sourceSegments = unique(parsedItem.data.sourceSegmentIds).flatMap((segmentId) => {
      const segment = segmentById.get(segmentId);
      return segment ? [segment] : [];
    });

    if (sourceSegments.length === 0) {
      return [];
    }

    const sourceSegmentIds = sourceSegments.map((segment) => segment.id);
    const startSeconds = Math.min(...sourceSegments.map((segment) => segment.startSeconds));
    const endSeconds = Math.max(...sourceSegments.map((segment) => segment.endSeconds));
    const fallbackSpeakerId = sourceSegments.find((segment) => segment.speaker)?.speaker ?? "speaker_unknown";
    const speaker = {
      ...parsedItem.data.speaker,
      id: parsedItem.data.speaker.id || fallbackSpeakerId,
      displayName: parsedItem.data.speaker.displayName ?? undefined
    };

    const insight = AudioInsightSchema.safeParse({
      id: `insight_${input.uploadId}_ai_${index + 1}`,
      uploadId: input.uploadId,
      sourceSegmentIds,
      sourceTimeRange: {
        startSeconds,
        endSeconds
      },
      speaker,
      voice: parsedItem.data.voice,
      toneLabels: parsedItem.data.toneLabels,
      emotionLabels: parsedItem.data.emotionLabels,
      interactionLabels: parsedItem.data.interactionLabels,
      atmosphereLabels: normalizeAtmosphereLabels(parsedItem.data.atmosphereLabels),
      emotionEvidence: normalizeEmotionEvidence(parsedItem.data.emotionEvidence, sourceSegmentIds),
      summary: parsedItem.data.summary,
      evidence: parsedItem.data.evidence,
      confidence: parsedItem.data.confidence
    });

    return insight.success ? [insight.data] : [];
  });
}
