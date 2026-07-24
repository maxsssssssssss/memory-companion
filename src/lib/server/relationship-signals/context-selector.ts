import type { AudioInsight, TranscriptSegment } from "@/lib/domain/types";

export type RelationshipContextRemovalReason =
  | "invalid_source_refs"
  | "generic_low_value"
  | "duplicate_source_overlap";

export type RelationshipContextSelectionAudit = {
  insightsBefore: number;
  insightsAfter: number;
  insightCharsBefore: number;
  insightCharsAfter: number;
  removedReasonCounts: Record<RelationshipContextRemovalReason, number>;
  selectedInsightIds: string[];
};

export type RelationshipContextSelection = {
  segments: TranscriptSegment[];
  audioInsights: AudioInsight[];
  audit: RelationshipContextSelectionAudit;
};

type ScoredInsight = {
  insight: AudioInsight;
  score: number;
};

const HIGH_VALUE_LABEL_WEIGHTS: Readonly<Record<string, number>> = {
  commitment: 4,
  decision: 4,
  risk: 4,
  open_question: 2.5,
  notable_quote: 1.5,
  firm: 3,
  pushing_back: 3,
  comforting: 3,
  perfunctory: 2,
  hesitant: 2,
  questioning: 2,
  serious: 0.25,
  tense: 3,
  anxious: 2,
  confused: 2,
  dissatisfied: 2,
  tired: 2,
  disagreement: 3,
  tension: 3,
  decision_moment: 3,
  follow_up_question: 2.5,
  interruption: 2,
  silence: 2,
  flirtation_or_testing: 2,
  conflicted: 3,
  avoidant: 3,
  uncertain: 2,
  awkward: 2,
  rushed: 2,
  warm: 1.5,
  collaborative: 0.5,
  rapport: 1.5
};

const MIN_RELATIONSHIP_RELEVANCE_SCORE = 2;
const LOW_VALUE_CHATTER_PENALTY = 3;

function labelScore(labels: readonly string[]) {
  return labels.reduce((sum, label) => sum + (HIGH_VALUE_LABEL_WEIGHTS[label] ?? 0), 0);
}

function insightScore(insight: AudioInsight, sourceSegments: TranscriptSegment[]) {
  const sourceValueLabels = sourceSegments.flatMap((segment) => segment.valueLabels);
  const sourceValueScore = labelScore(sourceValueLabels);
  const allSourceSegmentsAreLowValue =
    sourceSegments.length > 0 &&
    sourceSegments.every((segment) => segment.sceneLabels.includes("low_value_chatter"));
  const structuredLabels = [
    ...insight.toneLabels,
    ...insight.emotionLabels,
    ...insight.interactionLabels,
    ...(insight.atmosphereLabels ?? [])
  ];

  return (
    sourceValueScore +
    labelScore(structuredLabels) -
    (allSourceSegmentsAreLowValue && sourceValueScore === 0 ? LOW_VALUE_CHATTER_PENALTY : 0)
  );
}

function stableLabels(labels: readonly string[] | undefined) {
  return [...(labels ?? [])].sort().join(",");
}

function duplicateSignature(insight: AudioInsight) {
  return [
    [...insight.sourceSegmentIds].sort().join(","),
    insight.speaker.id,
    stableLabels(insight.toneLabels),
    stableLabels(insight.emotionLabels),
    stableLabels(insight.interactionLabels),
    stableLabels(insight.atmosphereLabels),
    insight.summary.replace(/\s+/gu, " ").trim().toLocaleLowerCase()
  ].join("|");
}

function comparePreferredInsight(left: ScoredInsight, right: ScoredInsight) {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  if (left.insight.confidence !== right.insight.confidence) {
    return right.insight.confidence - left.insight.confidence;
  }
  if (left.insight.sourceSegmentIds.length !== right.insight.sourceSegmentIds.length) {
    return right.insight.sourceSegmentIds.length - left.insight.sourceSegmentIds.length;
  }
  return left.insight.id.localeCompare(right.insight.id);
}

function compareSelectedInsight(left: AudioInsight, right: AudioInsight) {
  if (left.sourceTimeRange.startSeconds !== right.sourceTimeRange.startSeconds) {
    return left.sourceTimeRange.startSeconds - right.sourceTimeRange.startSeconds;
  }
  if (left.sourceTimeRange.endSeconds !== right.sourceTimeRange.endSeconds) {
    return left.sourceTimeRange.endSeconds - right.sourceTimeRange.endSeconds;
  }
  return left.id.localeCompare(right.id);
}

function compactText(text: string, maxLength: number) {
  const normalized = text.replace(/\s+/gu, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function insightLabels(insight: AudioInsight) {
  return [
    ...insight.toneLabels,
    ...insight.emotionLabels,
    ...insight.interactionLabels,
    ...(insight.atmosphereLabels ?? [])
  ];
}

function legacyRelationshipInsightLine(insight: AudioInsight, currentSegmentIds: ReadonlySet<string>) {
  const sourceSegmentIds = insight.sourceSegmentIds.filter((segmentId) => currentSegmentIds.has(segmentId));
  return `[${insight.id}] ${insight.sourceTimeRange.startSeconds}-${insight.sourceTimeRange.endSeconds}s ${insight.speaker.id} sourceSegmentIds=${sourceSegmentIds.join(",")} labels=${compactText(insightLabels(insight).join(","), 120)} summary=${compactText(insight.summary, 180)}`;
}

export function formatRelationshipInsightForProvider(
  insight: AudioInsight,
  currentSegmentIds: ReadonlySet<string>,
  speakerLabel = insight.speaker.id
) {
  const sourceSegmentIds = insight.sourceSegmentIds.filter((segmentId) => currentSegmentIds.has(segmentId));
  const labels = insightLabels(insight)
    .filter((label) => (HIGH_VALUE_LABEL_WEIGHTS[label] ?? 0) >= 1)
    .filter((label, index, values) => values.indexOf(label) === index);
  return `[${insight.id}] ${insight.sourceTimeRange.startSeconds}-${insight.sourceTimeRange.endSeconds}s speaker=${speakerLabel} sourceSegmentIds=${sourceSegmentIds.join(",")} labels=${labels.join(",") || "none"} summary=${compactText(insight.summary, 140)}`;
}

function insightCharacterCount(
  insights: readonly AudioInsight[],
  currentSegmentIds: ReadonlySet<string>,
  mode: "legacy" | "compact"
) {
  return insights
    .map((insight) => mode === "legacy"
      ? legacyRelationshipInsightLine(insight, currentSegmentIds)
      : formatRelationshipInsightForProvider(insight, currentSegmentIds))
    .join("\n").length;
}

export function selectRelationshipContext(input: {
  segments: TranscriptSegment[];
  audioInsights: AudioInsight[];
}): RelationshipContextSelection {
  const segmentById = new Map(input.segments.map((segment) => [segment.id, segment]));
  const currentSegmentIds = new Set(segmentById.keys());
  const removedReasonCounts: Record<RelationshipContextRemovalReason, number> = {
    invalid_source_refs: 0,
    generic_low_value: 0,
    duplicate_source_overlap: 0
  };
  const eligible: ScoredInsight[] = [];

  for (const insight of input.audioInsights) {
    const sourceSegments = insight.sourceSegmentIds
      .map((segmentId) => segmentById.get(segmentId))
      .filter((segment): segment is TranscriptSegment => Boolean(segment));

    if (sourceSegments.length === 0) {
      removedReasonCounts.invalid_source_refs += 1;
      continue;
    }

    const score = insightScore(insight, sourceSegments);
    if (score < MIN_RELATIONSHIP_RELEVANCE_SCORE) {
      removedReasonCounts.generic_low_value += 1;
      continue;
    }

    eligible.push({ insight, score });
  }

  const duplicateGroups = new Map<string, ScoredInsight[]>();
  for (const entry of eligible) {
    const signature = duplicateSignature(entry.insight);
    duplicateGroups.set(signature, [...(duplicateGroups.get(signature) ?? []), entry]);
  }

  const audioInsights = [...duplicateGroups.values()]
    .map((entries) => {
      const sorted = [...entries].sort(comparePreferredInsight);
      removedReasonCounts.duplicate_source_overlap += sorted.length - 1;
      return sorted[0].insight;
    })
    .sort(compareSelectedInsight);

  return {
    segments: input.segments,
    audioInsights,
    audit: {
      insightsBefore: input.audioInsights.length,
      insightsAfter: audioInsights.length,
      insightCharsBefore: insightCharacterCount(input.audioInsights, currentSegmentIds, "legacy"),
      insightCharsAfter: insightCharacterCount(audioInsights, currentSegmentIds, "compact"),
      removedReasonCounts,
      selectedInsightIds: audioInsights.map((insight) => insight.id)
    }
  };
}
