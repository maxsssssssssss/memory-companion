import { z } from "zod";
import {
  RelationshipSignalCardSchema,
  RelationshipSignalCategorySchema,
  RelationshipSignalSeveritySchema,
  RelationshipSignalTypeSchema,
  type AudioInsight,
  type RelationshipSignalCard,
  type SemanticSegment,
  type TranscriptSegment
} from "@/lib/domain/types";

const MIN_CONFIDENCE = 0.35;

const relationshipContextPattern =
  /约会|相处|亲密|亲近|关系|恋爱|喜欢|边界|舒服|不舒服|感受|情绪|委屈|尊重|倾听|接住|陪伴|暧昧|见面|在一起|男朋友|女朋友|伴侣|分手|回避|敷衍|否定|贬低|心动|安全感|吃醋|表白|牵手|拥抱/;

const forbiddenRelationshipJudgmentPattern =
  /渣男|渣女|一定在操控|对方一定|情感操纵你|操纵你|操控你|(?:建议|最好|应当|应该|必须).{0,8}(?:分手|离开|结束).{0,6}(?:关系|他|她|对方)?|这个人有病|有病|你应该分手|应该分手|必须分手|人格定性|人格障碍|人格有问题|心理诊断|关系裁判|诊断为|病态|控制狂|自恋型|PUA/i;

const RawAcousticEvidenceSchema = z.object({
  audioInsightId: z.string().min(1),
  detail: z.string().min(1),
  confidence: z.number().min(0).max(1).default(0.5)
});

const RawInteractionEvidenceSchema = z.object({
  sourceId: z.string().min(1),
  detail: z.string().min(1),
  confidence: z.number().min(0).max(1).default(0.5)
});

const RawCounterEvidenceSchema = z.string().min(1);

const RawEvidenceSegmentSchema = z.object({
  segmentId: z.string().min(1),
  speaker: z.string().optional(),
  startSeconds: z.number().optional(),
  endSeconds: z.number().optional(),
  text: z.string().optional()
});

export const RawRelationshipSignalItemSchema = z.object({
  signalType: RelationshipSignalTypeSchema,
  signalCategory: RelationshipSignalCategorySchema,
  severity: RelationshipSignalSeveritySchema.default("low"),
  confidence: z.number().min(0).max(1).default(0.5),
  summary: z.string().min(1),
  explanation: z.string().min(1),
  involvedSpeakers: z.array(z.string().min(1)).default([]),
  evidenceSegmentIds: z.array(z.string().min(1)).default([]),
  evidenceSegments: z.array(RawEvidenceSegmentSchema).default([]),
  counterEvidence: z.array(RawCounterEvidenceSchema).optional(),
  acousticEvidence: z.array(RawAcousticEvidenceSchema).optional(),
  textEvidence: z.array(z.string().min(1)).default([]),
  interactionEvidence: z.array(RawInteractionEvidenceSchema).optional(),
  suggestedReflection: z.string().min(1),
  caution: z.string().min(1).optional()
});

export const RelationshipSignalModelItemsSchema = z.object({
  items: z.array(RawRelationshipSignalItemSchema)
});

export type RawRelationshipSignalItem = z.infer<typeof RawRelationshipSignalItemSchema>;

export function normalizeEvidenceField(value: unknown): unknown[] {
  if (typeof value === "string") {
    return value.trim() ? [value] : [];
  }
  return Array.isArray(value) ? value : [];
}

function normalizeEvidenceItems(value: unknown, itemSchema: z.ZodTypeAny): unknown[] {
  return normalizeEvidenceField(value).filter((item) => itemSchema.safeParse(item).success);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeRelationshipSignalModelResponse(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    return value;
  }

  return {
    ...value,
    items: value.items.map((item) => {
      if (!isRecord(item)) {
        return item;
      }

      return {
        ...item,
        counterEvidence: normalizeEvidenceItems(item.counterEvidence, RawCounterEvidenceSchema),
        acousticEvidence: normalizeEvidenceItems(item.acousticEvidence, RawAcousticEvidenceSchema),
        interactionEvidence: normalizeEvidenceItems(item.interactionEvidence, RawInteractionEvidenceSchema)
      };
    })
  };
}

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

function textFromAudioInsight(insight: AudioInsight) {
  return [
    insight.summary,
    insight.evidence,
    ...(insight.atmosphereLabels ?? []),
    ...insight.toneLabels,
    ...insight.emotionLabels,
    ...insight.interactionLabels,
    ...(insight.emotionEvidence ?? []).map((evidence) => `${evidence.label} ${evidence.detail}`)
  ].join(" ");
}

export function hasRelationshipSignalContext(input: {
  segments: TranscriptSegment[];
  semanticSegments?: SemanticSegment[];
  audioInsights?: AudioInsight[];
}) {
  const combinedText = [
    ...input.segments.map((segment) => segment.text),
    ...(input.semanticSegments ?? []).flatMap((segment) => [segment.title, segment.summary, segment.transcriptExcerpt]),
    ...(input.audioInsights ?? []).map(textFromAudioInsight)
  ].join(" ");

  return relationshipContextPattern.test(combinedText);
}

export function containsForbiddenRelationshipJudgment(value: unknown): boolean {
  if (typeof value === "string") {
    return forbiddenRelationshipJudgmentPattern.test(value);
  }

  if (Array.isArray(value)) {
    return value.some(containsForbiddenRelationshipJudgment);
  }

  if (value && typeof value === "object") {
    return Object.values(value).some(containsForbiddenRelationshipJudgment);
  }

  return false;
}

function resolvedEvidenceSegmentIds(item: RawRelationshipSignalItem) {
  return unique([
    ...item.evidenceSegmentIds,
    ...item.evidenceSegments.map((segment) => segment.segmentId)
  ]);
}

function normalizeTextEvidence(item: RawRelationshipSignalItem, sourceSegments: TranscriptSegment[]) {
  const modelEvidence = item.textEvidence.map((text) => text.trim()).filter(Boolean);
  return unique(modelEvidence.length > 0 ? modelEvidence : sourceSegments.map((segment) => segment.text));
}

function normalizeSpeakerIds(item: RawRelationshipSignalItem, sourceSegments: TranscriptSegment[]) {
  return unique([
    ...item.involvedSpeakers.map((speaker) => speaker.trim()).filter(Boolean),
    ...sourceSegments.flatMap((segment) => (segment.speaker ? [segment.speaker] : []))
  ]);
}

function normalizeAcousticEvidence(item: RawRelationshipSignalItem, audioInsights: AudioInsight[]) {
  const audioInsightIds = new Set(audioInsights.map((insight) => insight.id));
  const evidence = (item.acousticEvidence ?? []).filter((entry) => audioInsightIds.has(entry.audioInsightId));
  return evidence.length > 0 ? evidence : undefined;
}

function normalizeInteractionEvidence(item: RawRelationshipSignalItem, semanticSegments: SemanticSegment[], audioInsights: AudioInsight[]) {
  const sourceIds = new Set([
    ...semanticSegments.map((segment) => segment.id),
    ...audioInsights.map((insight) => insight.id)
  ]);
  const evidence = (item.interactionEvidence ?? []).filter((entry) => sourceIds.has(entry.sourceId));
  return evidence.length > 0 ? evidence : undefined;
}

function errorSummary(error: z.ZodError) {
  return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
}

function segmentsMatching(segments: TranscriptSegment[], pattern: RegExp, includePrevious = false) {
  const matchedIds = new Set<string>();
  segments.forEach((segment, index) => {
    if (!pattern.test(segment.text)) {
      return;
    }
    if (includePrevious && index > 0) {
      matchedIds.add(segments[index - 1].id);
    }
    matchedIds.add(segment.id);
  });

  return segments.filter((segment) => matchedIds.has(segment.id));
}

function itemFromEvidence(input: {
  signalType: z.infer<typeof RelationshipSignalTypeSchema>;
  signalCategory: z.infer<typeof RelationshipSignalCategorySchema>;
  severity?: z.infer<typeof RelationshipSignalSeveritySchema>;
  confidence: number;
  summary: string;
  explanation: string;
  segments: TranscriptSegment[];
  suggestedReflection: string;
  caution?: string;
}): RawRelationshipSignalItem | null {
  if (input.segments.length === 0) {
    return null;
  }

  return {
    signalType: input.signalType,
    signalCategory: input.signalCategory,
    severity: input.severity ?? "low",
    confidence: input.confidence,
    summary: input.summary,
    explanation: input.explanation,
    involvedSpeakers: unique(input.segments.flatMap((segment) => (segment.speaker ? [segment.speaker] : []))),
    evidenceSegmentIds: input.segments.map((segment) => segment.id),
    evidenceSegments: [],
    textEvidence: input.segments.map((segment) => segment.text),
    suggestedReflection: input.suggestedReflection,
    ...(input.caution ? { caution: input.caution } : {})
  };
}

export function buildConservativeRelationshipSignalFallbackCards(input: {
  uploadId: string;
  recordingDate: string;
  segments: TranscriptSegment[];
  semanticSegments?: SemanticSegment[];
  audioInsights?: AudioInsight[];
  createdAt?: string;
}): RelationshipSignalCard[] {
  const semanticSegments = input.semanticSegments ?? [];
  const audioInsights = input.audioInsights ?? [];

  if (!hasRelationshipSignalContext({ segments: input.segments, semanticSegments, audioInsights })) {
    return [];
  }

  const activeListeningSegments = segmentsMatching(input.segments, /听到|听到了|对吗|理解|愿意这样说/, true).slice(0, 2);
  const boundarySegments = segmentsMatching(input.segments, /边界|尊重|休息|不要一直追问|先停一下/).slice(0, 2);
  const commitmentSegments = segmentsMatching(input.segments, /明确答复|提前发消息|会提前|周三前|我会|下次如果/).slice(0, 2);

  const items = [
    itemFromEvidence({
      signalType: "active_listening",
      signalCategory: "positive",
      confidence: 0.68,
      summary: "回应里出现了复述和确认对方感受的线索。",
      explanation: "这更像一次当下对话里的倾听动作，只能说明这一小段里有回应感，不能推出长期关系结论。",
      segments: activeListeningSegments,
      suggestedReflection: "可以继续观察这种复述和确认，后续是否也会稳定出现。"
    }),
    itemFromEvidence({
      signalType: "boundary_respect",
      signalCategory: "positive",
      confidence: 0.72,
      summary: "边界表达后，对话里出现了尊重休息需求的回应。",
      explanation: "证据指向的是这段对话中对边界的接纳，仍需要结合更多互动观察是否稳定。",
      segments: boundarySegments,
      suggestedReflection: "可以留意当你表达需要空间或休息时，对方后续是否也能保持尊重。"
    }),
    itemFromEvidence({
      signalType: "clear_commitment",
      signalCategory: "positive",
      confidence: 0.7,
      summary: "对方给出了后续回应方式或明确答复时间。",
      explanation: "这里的积极点在于把不确定性转成了可追踪的下一步，而不是直接给出关系结论。",
      segments: commitmentSegments,
      suggestedReflection: "可以在约定时间后回看，对方是否按这个具体承诺执行。"
    })
  ].filter((item): item is RawRelationshipSignalItem => item !== null);

  return normalizeRelationshipSignalItems({
    uploadId: input.uploadId,
    recordingDate: input.recordingDate,
    segments: input.segments,
    semanticSegments,
    audioInsights,
    items,
    createdAt: input.createdAt
  });
}

export function normalizeRelationshipSignalItems(input: {
  uploadId: string;
  recordingDate: string;
  segments: TranscriptSegment[];
  semanticSegments?: SemanticSegment[];
  audioInsights?: AudioInsight[];
  items: unknown[];
  createdAt?: string;
}): RelationshipSignalCard[] {
  const semanticSegments = input.semanticSegments ?? [];
  const audioInsights = input.audioInsights ?? [];

  if (!hasRelationshipSignalContext({ segments: input.segments, semanticSegments, audioInsights })) {
    return [];
  }

  const segmentById = new Map(input.segments.map((segment) => [segment.id, segment]));
  const createdAt = input.createdAt ?? new Date().toISOString();

  return input.items.flatMap((rawItem, index): RelationshipSignalCard[] => {
    const parsedItem = RawRelationshipSignalItemSchema.safeParse(rawItem);
    if (!parsedItem.success) {
      return [];
    }

    const item = parsedItem.data;
    if (item.confidence < MIN_CONFIDENCE || containsForbiddenRelationshipJudgment(item)) {
      return [];
    }
    if ((item.signalCategory === "risk" || item.signalCategory === "uncertain") && !item.caution?.trim()) {
      return [];
    }

    const sourceSegments = resolvedEvidenceSegmentIds(item).flatMap((segmentId) => {
      const segment = segmentById.get(segmentId);
      return segment ? [segment] : [];
    });

    if (sourceSegments.length === 0) {
      return [];
    }

    const evidenceSegments = sourceSegments.map((segment) => ({
      segmentId: segment.id,
      speaker: segment.speaker,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      text: segment.text
    }));
    const textEvidence = normalizeTextEvidence(item, sourceSegments);
    const startSeconds = Math.min(...sourceSegments.map((segment) => segment.startSeconds));
    const endSeconds = Math.max(...sourceSegments.map((segment) => segment.endSeconds));
    const involvedSpeakers = normalizeSpeakerIds(item, sourceSegments);

    if (textEvidence.length === 0 || involvedSpeakers.length === 0) {
      return [];
    }

    const parsedCard = RelationshipSignalCardSchema.safeParse({
      id: `relationship_signal_${input.uploadId}_${index + 1}`,
      uploadId: input.uploadId,
      date: input.recordingDate,
      signalType: item.signalType,
      signalCategory: item.signalCategory,
      severity: item.severity,
      confidence: item.confidence,
      summary: item.summary.trim(),
      explanation: item.explanation.trim(),
      involvedSpeakers,
      timeRange: { startSeconds, endSeconds },
      evidenceSegments,
      counterEvidence: item.counterEvidence,
      acousticEvidence: normalizeAcousticEvidence(item, audioInsights),
      textEvidence,
      interactionEvidence: normalizeInteractionEvidence(item, semanticSegments, audioInsights),
      suggestedReflection: item.suggestedReflection.trim(),
      caution: item.caution?.trim(),
      createdAt
    });

    if (!parsedCard.success) {
      console.warn("[relationship signals] dropped invalid card", errorSummary(parsedCard.error));
      return [];
    }

    return [parsedCard.data];
  });
}
