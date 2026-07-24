import {
  assessQaLifecycleEvidence,
  type QaLifecycleEvidenceAssessment,
  type QaQueryIntentAnalysis
} from "../lifecycle-retrieval";
import type {
  CanonicalEvidenceProjectionItem,
  CompactEvidenceFallbackReason,
  CompactEvidenceLifecycleAudit,
  CompactEvidenceProjection,
  CompactEvidenceView
} from "./types";

/**
 * Mirrors the current QA Evidence prompt limit. The projection is shadow-only;
 * the production serializer in ai-qa.ts remains unchanged.
 */
const QA_EVIDENCE_PROMPT_TEXT_LIMIT = 900;

type AudioProjectionFields = {
  interactionLine: string | null;
  summary: string;
  evidence: string;
};

function compactPromptText(text: string, maxLength = QA_EVIDENCE_PROMPT_TEXT_LIMIT) {
  const compacted = text.replace(/\s+/gu, " ").trim();
  return compacted.length > maxLength
    ? `${compacted.slice(0, maxLength - 1)}…`
    : compacted;
}

function evidenceBlock(input: {
  citationId: `E${number}`;
  title: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
}) {
  return `[${input.citationId}] ${input.startSeconds}-${input.endSeconds}s ${input.title}\n${compactPromptText(input.text)}`;
}

function markerIndexes(text: string, marker: string) {
  const indexes: number[] = [];
  let fromIndex = 0;
  while (fromIndex < text.length) {
    const index = text.indexOf(marker, fromIndex);
    if (index < 0) break;
    indexes.push(index);
    fromIndex = index + marker.length;
  }
  return indexes;
}

function isUnknownInteractionLine(line: string) {
  const value = line.slice("互动标签：".length).trim();
  if (!value) return true;
  return value
    .split(/[、,，]/u)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .every((item) => item === "unknown" || item === "未知" || item === "未标注");
}

/**
 * Extracts only fields already present in the canonical Audio Insight text.
 * Ambiguous layouts fail closed instead of guessing where a field begins.
 */
function extractAudioProjectionFields(text: string): AudioProjectionFields | null {
  const normalized = text.replace(/\r\n?/gu, "\n");
  if (/(?:^|\n)用户纠正：/u.test(normalized)) {
    return null;
  }

  const summaryMarker = "\n摘要：";
  const evidenceMarker = "\n依据：";
  const summaryIndexes = markerIndexes(normalized, summaryMarker);
  const evidenceIndexes = markerIndexes(normalized, evidenceMarker);
  if (
    summaryIndexes.length !== 1 ||
    evidenceIndexes.length !== 1 ||
    evidenceIndexes[0] <= summaryIndexes[0]
  ) {
    return null;
  }

  const summary = normalized
    .slice(summaryIndexes[0] + summaryMarker.length, evidenceIndexes[0])
    .trim();
  const evidence = normalized
    .slice(evidenceIndexes[0] + evidenceMarker.length)
    .trim();
  if (!summary || !evidence) {
    return null;
  }

  const interactionLines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("互动标签："));
  const interactionLine =
    interactionLines.length === 1 && !isUnknownInteractionLine(interactionLines[0])
      ? interactionLines[0]
      : null;

  return {
    interactionLine,
    summary,
    evidence
  };
}

function lifecycleAssessment(
  queryIntent: QaQueryIntentAnalysis,
  item: CanonicalEvidenceProjectionItem,
  text: string
) {
  return assessQaLifecycleEvidence(queryIntent, `${item.title}\n${text}`);
}

function lifecycleAudit(input: {
  original: QaLifecycleEvidenceAssessment;
  candidate: QaLifecycleEvidenceAssessment;
  compact: QaLifecycleEvidenceAssessment;
}): CompactEvidenceLifecycleAudit {
  return {
    originalState: input.original.state,
    candidateState: input.candidate.state,
    compactState: input.compact.state,
    originalTopicOverlap: input.original.topicOverlap,
    candidateTopicOverlap: input.candidate.topicOverlap,
    compactTopicOverlap: input.compact.topicOverlap,
    unchanged:
      input.original.state === input.compact.state &&
      input.original.topicOverlap === input.compact.topicOverlap
  };
}

function sourceIdsEqual(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((sourceId, index) => sourceId === right[index])
  );
}

function roundRatio(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function projectItem(input: {
  item: CanonicalEvidenceProjectionItem;
  index: number;
  queryIntent: QaQueryIntentAnalysis;
}): CompactEvidenceView {
  const { item, queryIntent } = input;
  const citationId = `E${input.index + 1}` as const;
  const originalBlock = evidenceBlock({
    citationId,
    title: item.title,
    startSeconds: item.startSeconds,
    endSeconds: item.endSeconds,
    text: item.text
  });
  const originalAssessment = lifecycleAssessment(queryIntent, item, item.text);
  const isAudio = item.kind === "audio" || item.kind === "audio_emotion";

  let summary: string | null = null;
  let evidence: string | null = null;
  let candidateText = item.text;
  let promptText = item.text;
  let projectionStatus: CompactEvidenceView["projectionStatus"] = "unchanged";
  let fallbackReason: CompactEvidenceFallbackReason | null = null;

  if (isAudio) {
    const fields = extractAudioProjectionFields(item.text);
    if (!fields) {
      projectionStatus = "fallback_original";
      fallbackReason = /(?:^|\n)用户纠正：/u.test(item.text)
        ? "user_correction_present"
        : "unparseable_audio_evidence";
    } else {
      summary = fields.summary;
      evidence = fields.evidence;
      candidateText = [
        fields.interactionLine,
        `摘要：${fields.summary}`,
        `依据：${fields.evidence}`
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");

      const candidateAssessment = lifecycleAssessment(
        queryIntent,
        item,
        candidateText
      );
      if (
        queryIntent.intent === "lifecycle_resolution" &&
        candidateAssessment.state !== originalAssessment.state
      ) {
        projectionStatus = "fallback_original";
        fallbackReason = "lifecycle_state_changed";
      } else if (
        queryIntent.intent === "lifecycle_resolution" &&
        candidateAssessment.topicOverlap !== originalAssessment.topicOverlap
      ) {
        projectionStatus = "fallback_original";
        fallbackReason = "lifecycle_topic_changed";
      } else {
        promptText = candidateText;
        projectionStatus = "projected";
      }
    }
  }

  const candidateAssessment = lifecycleAssessment(
    queryIntent,
    item,
    candidateText
  );
  const compactAssessment = lifecycleAssessment(
    queryIntent,
    item,
    promptText
  );
  const compactBlock = evidenceBlock({
    citationId,
    title: item.title,
    startSeconds: item.startSeconds,
    endSeconds: item.endSeconds,
    text: promptText
  });

  return {
    citationId,
    canonicalEvidenceId: item.id,
    kind: item.kind,
    title: item.title,
    sourceSegmentIds: [...item.sourceSegmentIds],
    timestamp: {
      startSeconds: item.startSeconds,
      endSeconds: item.endSeconds
    },
    summary,
    evidence,
    promptText,
    projectionStatus,
    fallbackReason,
    originalSerializedChars: originalBlock.length,
    compactSerializedChars: compactBlock.length,
    lifecycle: lifecycleAudit({
      original: originalAssessment,
      candidate: candidateAssessment,
      compact: compactAssessment
    })
  };
}

/**
 * Builds a deterministic, prompt-only projection. It does not mutate, remove,
 * reorder, or merge canonical Evidence items.
 */
export function projectCompactEvidence(input: {
  evidence: readonly CanonicalEvidenceProjectionItem[];
  queryIntent: QaQueryIntentAnalysis;
}): CompactEvidenceProjection {
  const views = input.evidence.map((item, index) =>
    projectItem({
      item,
      index,
      queryIntent: input.queryIntent
    })
  );
  const separatorChars = Math.max(0, input.evidence.length - 1) * 2;
  const originalChars =
    views.reduce((total, view) => total + view.originalSerializedChars, 0) +
    separatorChars;
  const compactChars =
    views.reduce((total, view) => total + view.compactSerializedChars, 0) +
    separatorChars;
  const audioItems = views.filter(
    (view) => view.kind === "audio" || view.kind === "audio_emotion"
  );
  const citationMappingUnchanged = views.every(
    (view, index) =>
      view.citationId === `E${index + 1}` &&
      view.canonicalEvidenceId === input.evidence[index]?.id
  );
  const sourceIdsUnchanged = views.every((view, index) =>
    sourceIdsEqual(
      view.sourceSegmentIds,
      input.evidence[index]?.sourceSegmentIds ?? []
    )
  );

  return {
    queryIntent: {
      ...input.queryIntent,
      topicTokens: [...input.queryIntent.topicTokens]
    },
    views,
    originalChars,
    compactChars,
    reductionRatio:
      originalChars === 0
        ? 0
        : roundRatio(Math.max(0, originalChars - compactChars) / originalChars),
    audioItems: audioItems.length,
    projectedAudioItems: audioItems.filter(
      (view) => view.projectionStatus === "projected"
    ).length,
    fallbackItems: audioItems.filter(
      (view) => view.projectionStatus === "fallback_original"
    ).length,
    citationMappingUnchanged,
    sourceIdsUnchanged,
    lifecycleStateUnchanged: views.every((view) => view.lifecycle.unchanged),
    providerPayload: "canonical"
  };
}

export function compactEvidencePromptForEvaluation(
  projection: CompactEvidenceProjection
) {
  return projection.views
    .map((view) =>
      evidenceBlock({
        citationId: view.citationId,
        title: view.title,
        startSeconds: view.timestamp.startSeconds,
        endSeconds: view.timestamp.endSeconds,
        text: view.promptText
      })
    )
    .join("\n\n");
}
