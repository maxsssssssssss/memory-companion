import type { RelationshipSignalCard, TranscriptSegment } from "@/lib/domain/types";
import { transcriptSpeakerIdentityKey } from "@/lib/domain/speaker-identity";
import { roundedScore } from "@/lib/server/text-features";
import type { RelationshipSignalCandidate } from "../candidates";
import { matchLifecycleIdentity } from "./matching";
import { compatibleLifecycleRule, lifecycleRoles } from "./rules";
import {
  RelationshipLifecycleEdgeSchema,
  RelationshipLifecycleMatchAuditSchema,
  RelationshipLifecycleSignalSchema,
  type RelationshipLifecycleEdge,
  type RelationshipLifecycleMatchAudit,
  type RelationshipLifecycleRejectionReason,
  type RelationshipLifecycleResolution,
  type RelationshipLifecycleSignal
} from "./types";

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function structuralReason(input: {
  sourceRole: string;
  targetRole: string;
  sharedGoals: number;
  sharedTopics: number;
  sharedEvidence: number;
  sharedSpeakers: number;
  temporalGapSeconds: number;
}) {
  const identity = input.sharedEvidence > 0
    ? "shared_evidence"
    : input.sharedGoals > 0
      ? "shared_goal"
      : "shared_topic";
  const context = input.sharedSpeakers > 0 ? "shared_speaker_context" : "temporal_proximity";
  return `${input.sourceRole}_to_${input.targetRole}:${identity}:${context}:forward_time`;
}

function candidateConfidence(input: {
  source: RelationshipLifecycleSignal;
  target: RelationshipLifecycleSignal;
  topicScore: number;
  contextScore: number;
}) {
  return roundedScore(
    0.46 +
    input.topicScore * 0.26 +
    input.contextScore * 0.12 +
    ((input.source.confidence + input.target.confidence) / 2) * 0.16
  );
}

type AcceptedCandidate = {
  edge: RelationshipLifecycleEdge;
  audit: RelationshipLifecycleMatchAudit;
  priority: number;
};

export function resolveRelationshipLifecycles(
  rawSignals: RelationshipLifecycleSignal[]
): RelationshipLifecycleResolution {
  const signals = rawSignals.map((signal) => RelationshipLifecycleSignalSchema.parse(signal))
    .sort((left, right) => left.timeRange.startSeconds - right.timeRange.startSeconds || left.id.localeCompare(right.id));
  const matches: RelationshipLifecycleMatchAudit[] = [];
  const acceptedCandidates: AcceptedCandidate[] = [];
  let candidatePairsChecked = 0;

  for (let sourceIndex = 0; sourceIndex < signals.length; sourceIndex += 1) {
    for (let targetIndex = sourceIndex + 1; targetIndex < signals.length; targetIndex += 1) {
      candidatePairsChecked += 1;
      const source = signals[sourceIndex];
      const target = signals[targetIndex];
      const rule = compatibleLifecycleRule(lifecycleRoles(source), lifecycleRoles(target));
      if (!rule) {
        matches.push(RelationshipLifecycleMatchAuditSchema.parse({
          from: source.id,
          to: target.id,
          accepted: false,
          rejectionReason: "different_signal_type"
        }));
        continue;
      }
      const identity = matchLifecycleIdentity(source, target);
      if (!identity.matched) {
        matches.push(RelationshipLifecycleMatchAuditSchema.parse({
          from: source.id,
          to: target.id,
          accepted: false,
          rejectionReason: identity.rejectionReason
        }));
        continue;
      }
      const confidence = candidateConfidence({
        source,
        target,
        topicScore: identity.features.topicScore,
        contextScore: identity.features.contextScore
      });
      const reason = structuralReason({
        sourceRole: rule.sourceRole,
        targetRole: rule.targetRole,
        ...identity.features
      });
      const edge = RelationshipLifecycleEdgeSchema.parse({
        fromSignalId: source.id,
        toSignalId: target.id,
        relationType: rule.relationType,
        confidence,
        evidence: {
          fromSegments: unique(source.evidenceSegmentIds),
          toSegments: unique(target.evidenceSegmentIds)
        },
        reason
      });
      acceptedCandidates.push({
        edge,
        priority: rule.priority,
        audit: RelationshipLifecycleMatchAuditSchema.parse({
          from: source.id,
          to: target.id,
          accepted: true,
          relationType: edge.relationType,
          confidence,
          reason
        })
      });
    }
  }

  const selected: AcceptedCandidate[] = [];
  for (const candidate of acceptedCandidates.sort((left, right) =>
    right.priority - left.priority ||
    right.edge.confidence - left.edge.confidence ||
    left.edge.fromSignalId.localeCompare(right.edge.fromSignalId) ||
    left.edge.toSignalId.localeCompare(right.edge.toSignalId)
  )) {
    const duplicatePair = selected.some((item) =>
      item.edge.fromSignalId === candidate.edge.fromSignalId &&
      item.edge.toSignalId === candidate.edge.toSignalId
    );
    const competingSource = selected.some((item) => item.edge.fromSignalId === candidate.edge.fromSignalId);
    const competingTarget = selected.some((item) =>
      item.edge.toSignalId === candidate.edge.toSignalId &&
      item.edge.relationType === candidate.edge.relationType
    );
    if (duplicatePair || competingSource || competingTarget) {
      matches.push(RelationshipLifecycleMatchAuditSchema.parse({
        from: candidate.edge.fromSignalId,
        to: candidate.edge.toSignalId,
        accepted: false,
        rejectionReason: "lower_confidence_match"
      }));
      continue;
    }
    selected.push(candidate);
    matches.push(candidate.audit);
  }

  const edges = selected.map((item) => item.edge).sort((left, right) =>
    left.fromSignalId.localeCompare(right.fromSignalId) ||
    left.toSignalId.localeCompare(right.toSignalId) ||
    left.relationType.localeCompare(right.relationType)
  );
  const sortedMatches = matches.sort((left, right) =>
    left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || Number(right.accepted) - Number(left.accepted)
  );
  const rejectedMatches: Partial<Record<RelationshipLifecycleRejectionReason, number>> = {};
  for (const match of sortedMatches) {
    if (!match.rejectionReason) continue;
    rejectedMatches[match.rejectionReason] = (rejectedMatches[match.rejectionReason] ?? 0) + 1;
  }
  return {
    edges,
    audit: {
      version: 1,
      candidatePairsChecked,
      lifecycleEdgesCreated: edges.length,
      rejectedMatches,
      matches: sortedMatches,
      edges
    }
  };
}

export function relationshipLifecycleSignalsFromCards(cards: RelationshipSignalCard[]) {
  return cards.map((card): RelationshipLifecycleSignal => RelationshipLifecycleSignalSchema.parse({
    id: card.id,
    signalType: card.signalType,
    signalCategory: card.signalCategory,
    summary: card.summary,
    evidenceSegmentIds: card.evidenceSegments.map((segment) => segment.segmentId),
    evidenceText: card.evidenceSegments.map((segment) => segment.text),
    timeRange: card.timeRange,
    speakers: card.involvedSpeakers,
    confidence: card.confidence,
    date: card.date
  }));
}

export function relationshipLifecycleSignalsFromCandidates(input: {
  candidates: RelationshipSignalCandidate[];
  segments: TranscriptSegment[];
  recordingDate?: string;
}) {
  const segmentById = new Map(input.segments.map((segment) => [segment.id, segment]));
  return input.candidates.flatMap((candidate): RelationshipLifecycleSignal[] => {
    const segments = unique(candidate.item.evidenceSegmentIds)
      .flatMap((segmentId) => {
        const segment = segmentById.get(segmentId);
        return segment ? [segment] : [];
      });
    if (segments.length === 0) return [];
    return [RelationshipLifecycleSignalSchema.parse({
      id: candidate.id,
      signalType: candidate.item.signalType,
      signalCategory: candidate.item.signalCategory,
      summary: candidate.item.summary,
      evidenceSegmentIds: segments.map((segment) => segment.id),
      evidenceText: segments.map((segment) => segment.text),
      timeRange: {
        startSeconds: Math.min(...segments.map((segment) => segment.startSeconds)),
        endSeconds: Math.max(...segments.map((segment) => segment.endSeconds))
      },
      speakers: unique(segments.flatMap((segment) => {
        const speaker = transcriptSpeakerIdentityKey(segment);
        return speaker ? [speaker] : [];
      })),
      confidence: candidate.item.confidence,
      ...(input.recordingDate ? { date: input.recordingDate } : {})
    })];
  });
}
