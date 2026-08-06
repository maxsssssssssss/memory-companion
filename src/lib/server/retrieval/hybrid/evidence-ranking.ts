import {
  meaningfulTextTokens,
  sharedTokenCount
} from "@/lib/server/text-features";
import {
  assessQaLifecycleEvidence,
  type QaLifecycleEvidenceState
} from "../lifecycle-retrieval";
import { parseHybridQuery, type HybridQuery } from "./query-parser";
import type {
  EvidenceRankingMetadata,
  HybridEvidenceCandidate
} from "./types";

export type EvidenceRankingFeatures = {
  semantic: number;
  lexical: number;
  temporal: number;
  entity: number;
  lifecycle: number;
  importance: number;
  relationship: number;
  preference: number;
};

export type EvidenceRankingExperiment =
  | "semantic_only"
  | "lexical_only"
  | "temporal_only"
  | "entity_only"
  | "lifecycle_only"
  | "preference_only"
  | "relationship_only"
  | "importance_only"
  | "current_full"
  | "query_category_gated"
  | "per_category_weights"
  | "importance_capped"
  | "relevance_gated_importance"
  | "lifecycle_chain_reservation"
  | "final_state_gated_boost"
  | "calibrated_semantic"
  | "exact_entity_lexical"
  | "top16_chain_protection"
  | "phase3_1_minimal";

export type RankedHybridEvidence = HybridEvidenceCandidate & {
  rank: number;
  originalRank: number;
  score: number;
  features: EvidenceRankingFeatures;
  weights: EvidenceRankingFeatures;
  contributions: EvidenceRankingFeatures;
  lifecycleState: QaLifecycleEvidenceState;
  lifecycleTopicOverlap: number;
  relevanceGate: number;
  rankingGuards: string[];
};

type FeatureWeights = EvidenceRankingFeatures;
type FeatureName = keyof EvidenceRankingFeatures;

const FEATURE_NAMES: FeatureName[] = [
  "semantic",
  "lexical",
  "temporal",
  "entity",
  "lifecycle",
  "importance",
  "relationship",
  "preference"
];

const PHASE_3_1_EXPERIMENTS = new Set<EvidenceRankingExperiment>([
  "importance_capped",
  "relevance_gated_importance",
  "lifecycle_chain_reservation",
  "final_state_gated_boost",
  "calibrated_semantic",
  "exact_entity_lexical",
  "top16_chain_protection",
  "phase3_1_minimal"
]);

const ZERO_WEIGHTS: FeatureWeights = {
  semantic: 0,
  lexical: 0,
  temporal: 0,
  entity: 0,
  lifecycle: 0,
  importance: 0,
  relationship: 0,
  preference: 0
};

const CURRENT_FULL_WEIGHTS: FeatureWeights = {
  semantic: 0.28,
  lexical: 0.22,
  temporal: 0.08,
  entity: 0.1,
  lifecycle: 0.08,
  importance: 0.14,
  relationship: 0.06,
  preference: 0.04
};

function currentFullWeights(query: HybridQuery): FeatureWeights {
  if (query.types.includes("lifecycle")) {
    return {
      semantic: 0.18,
      lexical: 0.12,
      temporal: 0.16,
      entity: 0.08,
      lifecycle: 0.28,
      importance: 0.1,
      relationship: 0.04,
      preference: 0.04
    };
  }
  if (query.types.includes("preference")) {
    return {
      semantic: 0.2,
      lexical: 0.12,
      temporal: 0.12,
      entity: 0.06,
      lifecycle: 0.05,
      importance: 0.14,
      relationship: 0.06,
      preference: 0.25
    };
  }
  const relationshipPrimary =
    query.types.includes("relationship") &&
    !query.types.includes("decision") &&
    !query.types.includes("lifecycle") &&
    !query.types.includes("preference");
  if (relationshipPrimary) {
    return {
      semantic: 0.18,
      lexical: 0.12,
      temporal: 0.08,
      entity: 0.2,
      lifecycle: 0.05,
      importance: 0.08,
      relationship: 0.25,
      preference: 0.04
    };
  }
  if (query.types.includes("decision")) {
    return {
      semantic: 0.22,
      lexical: 0.15,
      temporal: 0.13,
      entity: 0.08,
      lifecycle: 0.2,
      importance: 0.14,
      relationship: 0.04,
      preference: 0.04
    };
  }
  return CURRENT_FULL_WEIGHTS;
}
function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function evidenceText(candidate: HybridEvidenceCandidate) {
  return `${candidate.evidence.title} ${candidate.evidence.text}`.normalize("NFKC");
}

function singleFeatureWeights(feature: FeatureName): FeatureWeights {
  return { ...ZERO_WEIGHTS, [feature]: 1 };
}

function queryGatedWeights(query: HybridQuery): FeatureWeights {
  const weights: FeatureWeights = {
    semantic: 0.42,
    lexical: 0.32,
    temporal: 0,
    entity: 0.08,
    lifecycle: 0,
    importance: 0.04,
    relationship: 0,
    preference: 0
  };
  if (query.types.includes("temporal")) {
    weights.semantic = 0.25;
    weights.lexical = 0.16;
    weights.temporal = 0.35;
    weights.lifecycle = 0.14;
  }
  if (query.types.includes("relationship")) {
    weights.semantic = 0.18;
    weights.lexical = 0.12;
    weights.entity = 0.24;
    weights.relationship = 0.36;
    weights.importance = 0.02;
  }
  if (query.types.includes("lifecycle") || query.types.includes("decision")) {
    weights.semantic = 0.22;
    weights.lexical = 0.14;
    weights.temporal = Math.max(weights.temporal, 0.16);
    weights.lifecycle = 0.3;
    weights.importance = 0.04;
  }
  if (query.types.includes("preference")) {
    weights.semantic = 0.22;
    weights.lexical = 0.16;
    weights.temporal = Math.max(weights.temporal, 0.1);
    weights.preference = 0.34;
    weights.importance = 0.03;
  }
  const total = FEATURE_NAMES.reduce((sum, name) => sum + weights[name], 0);
  return Object.fromEntries(
    FEATURE_NAMES.map((name) => [name, total > 0 ? weights[name] / total : 0])
  ) as FeatureWeights;
}

function perCategoryWeights(query: HybridQuery): FeatureWeights {
  if (query.types.includes("relationship")) {
    return {
      semantic: 0.16,
      lexical: 0.12,
      temporal: 0.04,
      entity: 0.26,
      lifecycle: 0.02,
      importance: 0.02,
      relationship: 0.37,
      preference: 0.01
    };
  }
  if (query.types.includes("temporal")) {
    return {
      semantic: 0.24,
      lexical: 0.15,
      temporal: 0.36,
      entity: 0.04,
      lifecycle: 0.15,
      importance: 0.03,
      relationship: 0.02,
      preference: 0.01
    };
  }
  if (query.types.includes("lifecycle") || query.types.includes("decision")) {
    return {
      semantic: 0.26,
      lexical: 0.16,
      temporal: 0.14,
      entity: 0.05,
      lifecycle: 0.31,
      importance: 0.04,
      relationship: 0.02,
      preference: 0.02
    };
  }
  if (query.types.includes("preference")) {
    return {
      semantic: 0.28,
      lexical: 0.18,
      temporal: 0.1,
      entity: 0.04,
      lifecycle: 0.03,
      importance: 0.03,
      relationship: 0.02,
      preference: 0.32
    };
  }
  return {
    semantic: 0.48,
    lexical: 0.34,
    temporal: 0.04,
    entity: 0.06,
    lifecycle: 0.02,
    importance: 0.04,
    relationship: 0.01,
    preference: 0.01
  };
}

export function weightsForRankingExperiment(
  query: HybridQuery,
  experiment: EvidenceRankingExperiment
): FeatureWeights {
  if (experiment.endsWith("_only")) {
    return singleFeatureWeights(experiment.replace("_only", "") as FeatureName);
  }
  if (experiment === "query_category_gated") return queryGatedWeights(query);
  if (
    experiment === "per_category_weights" ||
    PHASE_3_1_EXPERIMENTS.has(experiment)
  ) return perCategoryWeights(query);
  return currentFullWeights(query);
}

function lexicalFeature(query: HybridQuery, text: string) {
  const queryTokens = new Set(query.tokens);
  if (queryTokens.size === 0) return 0;
  return clamp01(sharedTokenCount(queryTokens, meaningfulTextTokens(text)) / queryTokens.size);
}

function calibratedLexicalFeature(input: {
  query: HybridQuery;
  text: string;
  documentFrequency: ReadonlyMap<string, number>;
  documentCount: number;
}) {
  const textTokens = meaningfulTextTokens(input.text);
  if (input.query.tokens.length === 0) return 0;
  let matchedWeight = 0;
  let queryWeight = 0;
  for (const token of input.query.tokens) {
    const frequency = input.documentFrequency.get(token) ?? 0;
    const weight = 1 + Math.log(
      (input.documentCount + 1) / Math.max(1, frequency + 1)
    );
    queryWeight += weight;
    if (textTokens.has(token)) matchedWeight += weight;
  }
  return queryWeight > 0 ? clamp01(matchedWeight / queryWeight) : 0;
}

function entityFeature(query: HybridQuery, text: string, metadata?: EvidenceRankingMetadata) {
  if (query.entities.length === 0) {
    return query.relationshipMode === "speaker_pair" &&
      (metadata?.speakers?.length ?? 0) >= 2 ? 1 : 0;
  }
  const normalizedText = text.toLocaleLowerCase("en-US");
  const metadataValues = [
    ...(metadata?.entities ?? []),
    ...(metadata?.entityAliases ?? []),
    ...(query.relationshipMode === "owner" ? metadata?.owners ?? [] : metadata?.speakers ?? [])
  ].map((entity) => entity.toLocaleLowerCase("en-US"));
  const matched = query.entities.filter((entity) => {
    const normalizedEntity = entity.toLocaleLowerCase("en-US");
    return normalizedText.includes(normalizedEntity) || metadataValues.includes(normalizedEntity);
  }).length;
  return matched / query.entities.length;
}

function lifecycleStateValue(query: HybridQuery, state: QaLifecycleEvidenceState) {
  if (!query.types.includes("lifecycle") && !query.types.includes("decision")) return 0;
  if (["earlier", "first"].includes(query.temporalIntent)) {
    return state === "pending" ? 1 : state === "neutral" ? 0.35 : 0.15;
  }
  if (
    ["final", "last", "later", "recent"].includes(query.temporalIntent) ||
    query.lifecycle.preferLatestState
  ) {
    return state === "resolved" ? 1 : state === "neutral" ? 0.3 : 0.08;
  }
  return state === "resolved" ? 0.8 : state === "pending" ? 0.65 : 0.25;
}

function lifecycleFeature(input: {
  query: HybridQuery;
  state: QaLifecycleEvidenceState;
  topicOverlap: number;
  lexical: number;
  entity: number;
  gateByTopic: boolean;
}) {
  const value = lifecycleStateValue(input.query, input.state);
  if (!input.gateByTopic) return value;
  const topicConsistency =
    input.topicOverlap > 0
      ? clamp01(0.55 + input.topicOverlap * 0.2)
      : Math.max(input.entity, input.lexical >= 0.2 ? input.lexical * 0.45 : 0);
  return value * topicConsistency;
}

function effectiveLifecycleState(input: {
  query: HybridQuery;
  assessed: QaLifecycleEvidenceState;
  text: string;
  metadata?: EvidenceRankingMetadata;
}): QaLifecycleEvidenceState {
  if (input.assessed !== "neutral") return input.assessed;
  if (input.metadata?.memoryStatus === "resolved") return "resolved";
  if (
    (input.query.types.includes("lifecycle") || input.query.types.includes("decision")) &&
    /(?:最初|起初|考虑|计划|打算|还没|尚未|待确认|pending|considering|planned)/iu.test(input.text)
  ) {
    return "pending";
  }
  return "neutral";
}

function sortableDate(metadata: EvidenceRankingMetadata | undefined) {
  const date = metadata?.recordingDate;
  return date && /^\d{4}-\d{2}-\d{2}$/u.test(date) ? date : undefined;
}

function temporalFeature(input: {
  query: HybridQuery;
  metadata?: EvidenceRankingMetadata;
  orderedDates: readonly string[];
  endSeconds: number;
  sameRecordingMaxEndSeconds?: number;
}) {
  const date = sortableDate(input.metadata);
  if (input.query.explicitDates.length > 0) {
    return date && input.query.explicitDates.some((expected) =>
      expected.startsWith("--") ? date.endsWith(expected.slice(1)) : date === expected
    ) ? 1 : 0;
  }
  if (!date || input.orderedDates.length === 0) return 0;
  const dateIndex = input.orderedDates.indexOf(date);
  const denominator = Math.max(1, input.orderedDates.length - 1);
  const chronological = dateIndex / denominator;
  const sameRecordingPosition = input.sameRecordingMaxEndSeconds
    ? clamp01(input.endSeconds / Math.max(1, input.sameRecordingMaxEndSeconds))
    : 0.5;
  if (["earlier", "first"].includes(input.query.temporalIntent)) {
    return clamp01((1 - chronological) * 0.9 + (1 - sameRecordingPosition) * 0.1);
  }
  if (["recent", "later", "final", "last"].includes(input.query.temporalIntent)) {
    return clamp01(chronological * 0.9 + sameRecordingPosition * 0.1);
  }
  if (input.query.temporalIntent === "sequence") return 0.65;
  return 0;
}

function importanceFeature(
  candidate: HybridEvidenceCandidate,
  metadata: EvidenceRankingMetadata | undefined
) {
  const canonicalPriority = clamp01(candidate.evidence.priority / 20);
  const memoryImportance = metadata?.importanceScore === undefined
    ? 0
    : clamp01(metadata.importanceScore);
  return Math.max(canonicalPriority, memoryImportance);
}

function relationshipFeature(input: {
  query: HybridQuery;
  candidate: HybridEvidenceCandidate;
  metadata?: EvidenceRankingMetadata;
  entity: number;
}) {
  if (!input.query.types.includes("relationship")) return 0;
  if (input.metadata?.relationshipSourceValid === false) return 0;
  let value = 0;
  if (input.candidate.evidence.kind === "relationship_signal") value += 0.5;
  if (
    input.metadata?.memoryType === "relationship_signal" ||
    input.metadata?.memoryTypes?.includes("relationship_signal")
  ) value += 0.18;
  if (input.candidate.evidence.relationshipSignal) {
    value += clamp01(input.candidate.evidence.relationshipSignal.confidence) * 0.14;
  }
  if (input.query.relationshipMode === "speaker_pair" && (input.metadata?.speakers?.length ?? 0) >= 2) {
    value += 0.18;
  }
  value += input.entity * 0.28;
  return clamp01(value);
}

function preferenceFeature(
  query: HybridQuery,
  metadata: EvidenceRankingMetadata | undefined
) {
  if (!query.types.includes("preference")) return 0;
  if (
    metadata?.memoryType !== "preference" &&
    metadata?.memoryTypes?.includes("preference") !== true
  ) return 0;
  if (metadata.memoryStatus === "superseded" || metadata.memoryStatus === "expired") {
    return 0.08;
  }
  const occurrences = clamp01(((metadata.occurrenceCount ?? 1) - 1) / 4);
  const dates = clamp01(((metadata.distinctDates ?? 1) - 1) / 3);
  const active = metadata.memoryStatus === "active" ? 1 : 0;
  return clamp01(0.2 + occurrences * 0.3 + dates * 0.35 + active * 0.15);
}

function semanticFeature(score: number | undefined) {
  if (score === undefined || !Number.isFinite(score)) return 0;
  return clamp01((score - 0.2) / 0.65);
}

function calibratedSemanticFeature(input: {
  score: number | undefined;
  denseRank: number | undefined;
  denseCandidateCount: number;
}) {
  const absolute = semanticFeature(input.score);
  if (!input.denseRank || input.denseCandidateCount <= 1) return absolute;
  const rankPercentile = 1 -
    (input.denseRank - 1) / Math.max(1, input.denseCandidateCount - 1);
  return clamp01(absolute * 0.82 + rankPercentile * 0.18);
}

function relevanceGate(features: Pick<
  EvidenceRankingFeatures,
  "semantic" | "lexical" | "entity" | "relationship" | "preference"
>, lifecycleTopicOverlap: number) {
  return clamp01(Math.max(
    features.lexical,
    features.entity,
    features.semantic * 0.72,
    features.relationship * 0.8,
    features.preference * 0.72,
    lifecycleTopicOverlap > 0 ? 0.55 + lifecycleTopicOverlap * 0.15 : 0
  ));
}

function contributionBreakdown(
  features: EvidenceRankingFeatures,
  weights: FeatureWeights
) {
  return Object.fromEntries(
    FEATURE_NAMES.map((name) => [name, features[name] * weights[name]])
  ) as EvidenceRankingFeatures;
}

function contributionTotal(contributions: EvidenceRankingFeatures) {
  return FEATURE_NAMES.reduce((sum, name) => sum + contributions[name], 0);
}

function addRankingGuard(candidate: RankedHybridEvidence, guard: string) {
  return candidate.rankingGuards.includes(guard)
    ? candidate
    : { ...candidate, rankingGuards: [...candidate.rankingGuards, guard] };
}

function promoteBeforeBoundary(input: {
  ranked: readonly RankedHybridEvidence[];
  candidateId: string;
  boundary: number;
  guard: string;
}) {
  const output = [...input.ranked];
  const index = output.findIndex((item) => item.evidence.id === input.candidateId);
  if (index < 0 || index < input.boundary) return output;
  const [candidate] = output.splice(index, 1);
  if (!candidate) return output;
  output.splice(
    Math.min(input.boundary - 1, output.length),
    0,
    addRankingGuard(candidate, input.guard)
  );
  return output;
}

function lifecycleDate(candidate: RankedHybridEvidence, metadata?: EvidenceRankingMetadata) {
  return sortableDate(metadata) ?? "";
}

function reserveLifecycleChain(input: {
  query: HybridQuery;
  ranked: readonly RankedHybridEvidence[];
  metadata?: ReadonlyMap<string, EvidenceRankingMetadata>;
}) {
  if (
    !input.query.types.includes("lifecycle") &&
    !input.query.types.includes("decision")
  ) return [...input.ranked];
  const topical = input.ranked.filter((candidate) =>
    candidate.lifecycleTopicOverlap > 0 &&
    candidate.relevanceGate >= 0.45
  );
  if (topical.length === 0) return [...input.ranked];

  let output = [...input.ranked];
  const bestForState = (state: QaLifecycleEvidenceState, newest: boolean) =>
    topical
      .filter((candidate) => candidate.lifecycleState === state)
      .sort((left, right) => {
        const leftDate = lifecycleDate(
          left,
          input.metadata?.get(left.evidence.id)
        );
        const rightDate = lifecycleDate(
          right,
          input.metadata?.get(right.evidence.id)
        );
        return (newest
          ? rightDate.localeCompare(leftDate)
          : leftDate.localeCompare(rightDate)) ||
          right.score - left.score ||
          left.originalRank - right.originalRank;
      })[0];

  const resolved = bestForState("resolved", true);
  const pending = bestForState("pending", false);
  const change = topical
    .filter((candidate) => candidate.lifecycleState === "neutral")
    .sort((left, right) =>
      right.score - left.score ||
      left.originalRank - right.originalRank
    )[0];

  if (
    resolved &&
    (
      ["final", "last", "later", "recent"].includes(input.query.temporalIntent) ||
      input.query.lifecycle.preferLatestState
    )
  ) {
    output = promoteBeforeBoundary({
      ranked: output,
      candidateId: resolved.evidence.id,
      boundary: 5,
      guard: "topic_consistent_final_top5"
    });
  }

  if (
    input.query.temporalIntent === "sequence" ||
    input.query.lifecycle.aggregateCommitmentCompletion
  ) {
    for (const representative of [pending, change, resolved]) {
      if (!representative) continue;
      output = promoteBeforeBoundary({
        ranked: output,
        candidateId: representative.evidence.id,
        boundary: 16,
        guard: "lifecycle_chain_top16"
      });
    }
  }
  return output;
}

function protectRelevantHybridBoundaries(input: {
  query: HybridQuery;
  ranked: readonly RankedHybridEvidence[];
}) {
  const relationshipPrimary =
    input.query.types.includes("relationship") &&
    /关系|相处|互动|支持|倾听|边界|沟通方式|双方|对方|两人|relationship/iu.test(
      input.query.normalized
    ) &&
    !input.query.types.includes("decision") &&
    !input.query.types.includes("lifecycle") &&
    !input.query.types.includes("preference");
  if (relationshipPrimary) {
    const relationshipAnchors = input.ranked
      .filter((candidate) =>
        candidate.originalRank <= 30 &&
        (
          candidate.features.relationship >= 0.3 ||
          candidate.features.lexical >= 0.08 ||
          candidate.features.semantic >= 0.4
        )
      )
      .sort((left, right) => left.originalRank - right.originalRank);
    return protectBoundary({
      ranked: input.ranked,
      anchors: relationshipAnchors,
      boundary: 30,
      guard: "relevant_relationship_hybrid_top30"
    });
  }

  let output = [...input.ranked];
  const temporalPrimary =
    input.query.types.includes("temporal") &&
    !input.query.types.includes("lifecycle") &&
    !input.query.types.includes("decision");
  const anchors = [...input.ranked]
    .filter((candidate) => {
      const directlyRelevant =
        candidate.features.lexical >= 0.16 ||
        candidate.features.entity >= 0.5 ||
        candidate.lifecycleTopicOverlap > 0 ||
        candidate.features.relationship >= 0.5 ||
        candidate.features.preference >= 0.55 ||
        (
          candidate.features.semantic >= 0.42 &&
          candidate.originalRank <= 5
        );
      return directlyRelevant && candidate.originalRank <= 16;
    })
    .sort((left, right) => left.originalRank - right.originalRank);
  const currentRank = (candidate: RankedHybridEvidence) =>
    output.findIndex((item) => item.evidence.id === candidate.evidence.id) + 1;
  const anchorPriority = (
    left: RankedHybridEvidence,
    right: RankedHybridEvidence
  ) =>
    Number(right.lifecycleTopicOverlap > 0) -
      Number(left.lifecycleTopicOverlap > 0) ||
    right.relevanceGate - left.relevanceGate ||
    right.features.lexical - left.features.lexical ||
    left.originalRank - right.originalRank;
  const missingTop5 = anchors
    .filter((candidate) =>
      candidate.originalRank <= 5 && currentRank(candidate) > 5
    )
    .sort(anchorPriority)
    .slice(0, 1);
  output = protectBoundary({
    ranked: output,
    anchors: temporalPrimary ? [] : missingTop5,
    boundary: 5,
    guard: "relevant_hybrid_top5"
  });
  const rankAfterTop5 = (candidate: RankedHybridEvidence) =>
    output.findIndex((item) => item.evidence.id === candidate.evidence.id) + 1;
  const missingTop16 = anchors
    .filter((candidate) =>
      candidate.originalRank <= 16 && rankAfterTop5(candidate) > 16
    )
    .sort(anchorPriority)
    .slice(0, 1);
  output = protectBoundary({
    ranked: output,
    anchors: missingTop16,
    boundary: 16,
    guard: "relevant_hybrid_top16"
  });
  return output;
}

function protectBoundary(input: {
  ranked: readonly RankedHybridEvidence[];
  anchors: readonly RankedHybridEvidence[];
  boundary: number;
  guard: string;
}) {
  if (input.anchors.length === 0) return [...input.ranked];
  const originalOrder = new Map(
    input.ranked.map((candidate, index) => [candidate.evidence.id, index])
  );
  const anchorIds = new Set(
    input.anchors
      .slice(0, input.boundary)
      .map((candidate) => candidate.evidence.id)
  );
  const head = input.ranked.slice(0, input.boundary);
  const selectedIds = new Set(head.map((candidate) => candidate.evidence.id));
  const missing = input.anchors.filter((candidate) =>
    anchorIds.has(candidate.evidence.id) &&
    !selectedIds.has(candidate.evidence.id)
  );
  const protectedHeadIds = new Set(
    head
      .filter((candidate) => anchorIds.has(candidate.evidence.id))
      .map((candidate) => candidate.evidence.id)
  );
  const replaceable = [...head]
    .filter((candidate) => !protectedHeadIds.has(candidate.evidence.id))
    .sort((left, right) => {
      const leftTopical = left.lifecycleTopicOverlap > 0 ? 1 : 0;
      const rightTopical = right.lifecycleTopicOverlap > 0 ? 1 : 0;
      return leftTopical - rightTopical ||
        left.relevanceGate - right.relevanceGate ||
        (originalOrder.get(right.evidence.id) ?? 0) -
          (originalOrder.get(left.evidence.id) ?? 0);
    });
  const evictedIds = new Set<string>();
  for (const candidate of missing) {
    const evicted = replaceable.shift();
    if (!evicted) break;
    evictedIds.add(evicted.evidence.id);
    selectedIds.delete(evicted.evidence.id);
    selectedIds.add(candidate.evidence.id);
  }
  const guardedHead = input.ranked
    .filter((candidate) => selectedIds.has(candidate.evidence.id))
    .sort((left, right) =>
      (originalOrder.get(left.evidence.id) ?? Number.POSITIVE_INFINITY) -
      (originalOrder.get(right.evidence.id) ?? Number.POSITIVE_INFINITY)
    )
    .map((candidate) =>
      anchorIds.has(candidate.evidence.id)
        ? addRankingGuard(candidate, input.guard)
        : candidate
    );
  const tail = input.ranked.filter((candidate) =>
    !selectedIds.has(candidate.evidence.id)
  );
  return [...guardedHead, ...tail].map((candidate) =>
    evictedIds.has(candidate.evidence.id)
      ? addRankingGuard(candidate, `${input.guard}_evicted`)
      : candidate
  );
}

export function scoreHybridEvidenceCandidates(input: {
  question: string;
  candidates: readonly HybridEvidenceCandidate[];
  metadata?: ReadonlyMap<string, EvidenceRankingMetadata>;
  experiment?: EvidenceRankingExperiment;
}): RankedHybridEvidence[] {
  const query = parseHybridQuery(input.question);
  const experiment = input.experiment ?? "current_full";
  const weights = weightsForRankingExperiment(query, experiment);
  const phase31KeepsBaselineCalibration =
    experiment === "phase3_1_minimal" &&
    (
      query.types.includes("relationship") ||
      query.types.includes("temporal")
    );
  const useCalibratedSemantic =
    experiment === "calibrated_semantic" ||
    (
      experiment === "phase3_1_minimal" &&
      !phase31KeepsBaselineCalibration
    );
  const useCalibratedLexical =
    experiment === "exact_entity_lexical" ||
    (
      experiment === "phase3_1_minimal" &&
      !phase31KeepsBaselineCalibration
    );
  const capImportance =
    experiment === "importance_capped" ||
    experiment === "relevance_gated_importance" ||
    (
      experiment === "phase3_1_minimal" &&
      !query.types.includes("relationship")
    );
  const gateImportance =
    experiment === "relevance_gated_importance" ||
    (
      experiment === "phase3_1_minimal" &&
      !query.types.includes("relationship")
    );
  const gateLifecycleByTopic =
    experiment === "final_state_gated_boost" ||
    experiment === "phase3_1_minimal";
  const documentFrequency = new Map<string, number>();
  for (const candidate of input.candidates) {
    const tokens = meaningfulTextTokens(evidenceText(candidate));
    for (const token of query.tokens) {
      if (tokens.has(token)) {
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
      }
    }
  }
  const denseCandidateCount = Math.max(
    0,
    ...input.candidates.map((candidate) => candidate.channelRanks.dense ?? 0)
  );
  const orderedDates = [...new Set(input.candidates.flatMap((candidate) => {
    const date = sortableDate(input.metadata?.get(candidate.evidence.id));
    return date ? [date] : [];
  }))].sort();
  const maxEndSecondsByRecording = new Map<string, number>();
  for (const candidate of input.candidates) {
    const metadata = input.metadata?.get(candidate.evidence.id);
    if (!metadata?.recordingId) continue;
    maxEndSecondsByRecording.set(
      metadata.recordingId,
      Math.max(
        maxEndSecondsByRecording.get(metadata.recordingId) ?? 0,
        candidate.evidence.endSeconds
      )
    );
  }

  const ranked = input.candidates
    .map((candidate, originalIndex) => {
      const metadata = input.metadata?.get(candidate.evidence.id);
      const text = evidenceText(candidate);
      const lifecycleAssessment = assessQaLifecycleEvidence(query.lifecycle, text);
      const lifecycleState = effectiveLifecycleState({
        query,
        assessed: lifecycleAssessment.state,
        text,
        metadata
      });
      const entity = entityFeature(query, text, metadata);
      const semantic = useCalibratedSemantic
        ? calibratedSemanticFeature({
            score: candidate.denseScore,
            denseRank: candidate.channelRanks.dense,
            denseCandidateCount
          })
        : semanticFeature(candidate.denseScore);
      const lexical = useCalibratedLexical
        ? calibratedLexicalFeature({
            query,
            text,
            documentFrequency,
            documentCount: input.candidates.length
          })
        : lexicalFeature(query, text);
      const initialFeatures = {
        semantic,
        lexical,
        entity,
        relationship: relationshipFeature({ query, candidate, metadata, entity }),
        preference: preferenceFeature(query, metadata)
      };
      const candidateRelevanceGate = relevanceGate(
        initialFeatures,
        lifecycleAssessment.topicOverlap
      );
      const rawImportance = importanceFeature(candidate, metadata);
      const importance = (
        capImportance ? Math.min(0.35, rawImportance) : rawImportance
      ) * (gateImportance ? candidateRelevanceGate : 1);
      const features: EvidenceRankingFeatures = {
        semantic,
        lexical,
        temporal: temporalFeature({
          query,
          metadata,
          orderedDates,
          endSeconds: candidate.evidence.endSeconds,
          sameRecordingMaxEndSeconds: metadata?.recordingId
            ? maxEndSecondsByRecording.get(metadata.recordingId)
            : undefined
        }),
        entity,
        lifecycle: lifecycleFeature({
          query,
          state: lifecycleState,
          topicOverlap: lifecycleAssessment.topicOverlap,
          lexical,
          entity,
          gateByTopic: gateLifecycleByTopic
        }),
        importance,
        relationship: initialFeatures.relationship,
        preference: initialFeatures.preference
      };
      const contributions = contributionBreakdown(features, weights);
      return {
        ...candidate,
        rank: 0,
        originalRank: originalIndex + 1,
        score: contributionTotal(contributions),
        features,
        weights,
        contributions,
        lifecycleState,
        lifecycleTopicOverlap: lifecycleAssessment.topicOverlap,
        relevanceGate: candidateRelevanceGate,
        rankingGuards: []
      };
    })
    .sort((left, right) =>
      right.score - left.score ||
      right.rrfScore - left.rrfScore ||
      left.originalRank - right.originalRank ||
      left.evidence.id.localeCompare(right.evidence.id)
    );
  const usePerCategoryOrdering =
    experiment === "per_category_weights" ||
    PHASE_3_1_EXPERIMENTS.has(experiment);
  const protectCurrentTop10 =
    usePerCategoryOrdering &&
    (
      query.types.includes("relationship") ||
      query.types.includes("temporal")
    );
  const currentOrder = (left: RankedHybridEvidence, right: RankedHybridEvidence) =>
    (left.channelRanks.current ?? Number.POSITIVE_INFINITY) -
      (right.channelRanks.current ?? Number.POSITIVE_INFINITY) ||
    left.evidence.id.localeCompare(right.evidence.id);
  const protectedTop10 = ranked.filter(
    (candidate) => (candidate.channelRanks.current ?? Number.POSITIVE_INFINITY) <= 10
  );
  const protectedTop16Tail = ranked.filter((candidate) => {
    const currentRank = candidate.channelRanks.current ?? Number.POSITIVE_INFINITY;
    return currentRank > 10 && currentRank <= 16;
  });
  if (query.types.includes("relationship")) {
    protectedTop10.sort(currentOrder);
    protectedTop16Tail.sort(currentOrder);
  }
  const ordered = protectCurrentTop10
    ? [
        ...protectedTop10,
        ...protectedTop16Tail,
        ...ranked.filter(
          (candidate) => (candidate.channelRanks.current ?? Number.POSITIVE_INFINITY) > 16
        )
      ]
    : ranked;
  const preserveHybridTop30 =
    usePerCategoryOrdering &&
    (
      query.types.includes("preference") ||
      (
        !query.types.includes("relationship") &&
        !query.types.includes("temporal")
      )
    );
  const bounded = preserveHybridTop30
    ? [
        ...ordered.filter((candidate) => candidate.originalRank <= 30),
        ...ordered.filter((candidate) => candidate.originalRank > 30)
      ]
    : ordered;
  const chainReserved =
    experiment === "lifecycle_chain_reservation" ||
    experiment === "phase3_1_minimal"
      ? reserveLifecycleChain({
          query,
          ranked: bounded,
          metadata: input.metadata
        })
      : bounded;
  const guarded =
    experiment === "top16_chain_protection" ||
    experiment === "phase3_1_minimal"
      ? protectRelevantHybridBoundaries({ query, ranked: chainReserved })
      : chainReserved;
  return guarded.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

/**
 * Exposes a wider, read-only ranking window for shadow-review diagnostics.
 * Production retrieval must continue to use rankHybridEvidence and its Top-16 cap.
 */
export function rankHybridEvidenceForReview(input: {
  question: string;
  candidates: readonly HybridEvidenceCandidate[];
  metadata?: ReadonlyMap<string, EvidenceRankingMetadata>;
  experiment?: EvidenceRankingExperiment;
}): RankedHybridEvidence[] {
  return scoreHybridEvidenceCandidates(input).slice(0, 30);
}

export function rankHybridEvidence(input: {
  question: string;
  candidates: readonly HybridEvidenceCandidate[];
  metadata?: ReadonlyMap<string, EvidenceRankingMetadata>;
  limit?: number;
  experiment?: EvidenceRankingExperiment;
}): RankedHybridEvidence[] {
  return scoreHybridEvidenceCandidates(input)
    .slice(0, Math.min(16, Math.max(1, Math.floor(input.limit ?? 16))))
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}
