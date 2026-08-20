import {
  meaningfulTextTokens,
  sharedTokenCount
} from "@/lib/server/text-features";
import {
  assessQaLifecycleEvidence
} from "../lifecycle-retrieval";
import type { QaRetrievedEvidence } from "../ai-qa";
import type { DenseEvidenceCandidate } from "./dense-retrieval";
import { parseHybridQuery, type HybridQuery } from "./query-parser";
import { reciprocalRankFusion, type RrfRankedItem } from "./rrf";
import type {
  EvidenceRankingMetadata,
  HybridEvidenceCandidate,
  HybridFusionStrategy,
  HybridRecallChannel
} from "./types";

type ChannelCandidate = {
  evidence: QaRetrievedEvidence;
  rank: number;
  score: number;
  reasons: string[];
};

export type HybridCandidateDiagnostics = {
  strategy: HybridFusionStrategy;
  query: HybridQuery;
  channelCounts: Record<HybridRecallChannel, number>;
  channelIds: Record<HybridRecallChannel, string[]>;
  appliedQuotas: Partial<Record<HybridRecallChannel, number>>;
  candidates: HybridEvidenceCandidate[];
};

function evidenceText(evidence: QaRetrievedEvidence) {
  return `${evidence.title} ${evidence.text}`.normalize("NFKC");
}

function metadataFor(
  evidence: QaRetrievedEvidence,
  metadata: ReadonlyMap<string, EvidenceRankingMetadata> | undefined
) {
  return metadata?.get(evidence.id);
}

function hasMemoryType(
  metadata: EvidenceRankingMetadata | undefined,
  type: NonNullable<EvidenceRankingMetadata["memoryType"]>
) {
  return metadata?.memoryType === type || metadata?.memoryTypes?.includes(type) === true;
}

function normalizedValues(values: readonly string[] | undefined) {
  return (values ?? []).map((value) => value.normalize("NFKC").toLocaleLowerCase("en-US"));
}

function queryEntityMatches(
  query: HybridQuery,
  evidence: QaRetrievedEvidence,
  metadata: EvidenceRankingMetadata | undefined
) {
  if (query.entities.length === 0) return { exact: 0, alias: 0, speaker: 0, owner: 0 };
  const text = evidenceText(evidence).toLocaleLowerCase("en-US");
  const aliases = normalizedValues(metadata?.entityAliases);
  const entities = normalizedValues(metadata?.entities);
  const speakers = normalizedValues(metadata?.speakers);
  const owners = normalizedValues(metadata?.owners);
  let exact = 0;
  let alias = 0;
  let speaker = 0;
  let owner = 0;
  for (const rawEntity of query.entities) {
    const entity = rawEntity.normalize("NFKC").toLocaleLowerCase("en-US");
    if (text.includes(entity) || entities.includes(entity)) exact += 1;
    if (aliases.includes(entity)) alias += 1;
    if (speakers.includes(entity)) speaker += 1;
    if (owners.includes(entity)) owner += 1;
  }
  return { exact, alias, speaker, owner };
}

function explicitDateMatches(query: HybridQuery, recordingDate: string | undefined) {
  if (!recordingDate || query.explicitDates.length === 0) return false;
  return query.explicitDates.some((date) =>
    date.startsWith("--") ? recordingDate.endsWith(date.slice(1)) : recordingDate === date
  );
}

function relationshipConceptScore(query: HybridQuery, text: string) {
  let score = 0;
  const reasons: string[] = [];
  const concepts: Array<{ query: RegExp; evidence: RegExp; label: string }> = [
    {
      query: /边界|沟通方式|变化|变更|延误/iu,
      evidence: /边界|提前(?:告诉|说明|通知)|明确答复|留出调整时间|不让.{0,6}等|变化.{0,8}(?:说明|通知)|先说事实|更新时间/iu,
      label: "communication_boundary"
    },
    {
      query: /支持|帮助|倾听|可观察行为/iu,
      evidence: /支持|帮助|倾听|听出来|复述|记得|陪伴|安慰|接住|一起/iu,
      label: "support_behavior"
    },
    {
      query: /承诺|约定|答应/iu,
      evidence: /承诺|约定|答应|最晚|按时|提前|明确|会.{0,12}(?:发|告诉|说明|完成)/iu,
      label: "commitment_behavior"
    }
  ];
  for (const concept of concepts) {
    if (concept.query.test(query.normalized) && concept.evidence.test(text)) {
      score += 12;
      reasons.push(concept.label);
    }
  }
  return { score, reasons };
}

function diversifyByRecordingDate(
  candidates: readonly Omit<ChannelCandidate, "rank">[],
  metadata: ReadonlyMap<string, EvidenceRankingMetadata> | undefined
) {
  const groups = new Map<string, Array<Omit<ChannelCandidate, "rank">>>();
  for (const candidate of candidates) {
    const date = metadataFor(candidate.evidence, metadata)?.recordingDate ?? "unknown";
    const group = groups.get(date) ?? [];
    group.push(candidate);
    groups.set(date, group);
  }
  if (groups.size <= 1) return [...candidates];
  const dates = [...groups.keys()].sort().reverse();
  const output: Array<Omit<ChannelCandidate, "rank">> = [];
  for (let offset = 0; output.length < candidates.length; offset += 1) {
    let added = false;
    for (const date of dates) {
      const candidate = groups.get(date)?.[offset];
      if (candidate) {
        output.push(candidate);
        added = true;
      }
    }
    if (!added) break;
  }
  return output;
}

export function retrieveLexicalEvidence(input: {
  query: HybridQuery;
  evidence: readonly QaRetrievedEvidence[];
  currentCandidates?: readonly QaRetrievedEvidence[];
  limit?: number;
}) {
  const queryTokens = new Set(input.query.tokens);
  const currentRanks = new Map(
    (input.currentCandidates ?? []).map((item, index) => [item.id, index + 1])
  );
  return input.evidence
    .map((evidence) => {
      const text = evidenceText(evidence);
      const shared = sharedTokenCount(queryTokens, meaningfulTextTokens(text));
      const entityMatches = input.query.entities.filter((entity) =>
        text.toLocaleLowerCase("en-US").includes(entity.toLocaleLowerCase("en-US"))
      ).length;
      return {
        evidence,
        shared,
        entityMatches,
        currentRank: currentRanks.get(evidence.id)
      };
    })
    .filter((candidate) =>
      candidate.shared > 0 ||
      candidate.entityMatches > 0 ||
      candidate.currentRank !== undefined
    )
    .sort((left, right) =>
      Number(left.currentRank === undefined) - Number(right.currentRank === undefined) ||
      (left.currentRank ?? Number.POSITIVE_INFINITY) -
        (right.currentRank ?? Number.POSITIVE_INFINITY) ||
      right.entityMatches - left.entityMatches ||
      right.shared - left.shared ||
      right.evidence.priority - left.evidence.priority ||
      left.evidence.id.localeCompare(right.evidence.id)
    )
    .slice(0, Math.max(1, input.limit ?? 50))
    .map((candidate, index) => ({
      evidence: candidate.evidence,
      rank: index + 1,
      score: candidate.shared + candidate.entityMatches * 4,
      lexicalMatches: candidate.shared,
      entityMatches: candidate.entityMatches,
      reasons: [
        ...(candidate.currentRank ? [`current_rank:${candidate.currentRank}`] : []),
        ...(candidate.shared ? [`token_matches:${candidate.shared}`] : []),
        ...(candidate.entityMatches ? [`entity_matches:${candidate.entityMatches}`] : [])
      ]
    }));
}

export function structuredEvidenceScore(input: {
  query: HybridQuery;
  evidence: QaRetrievedEvidence;
  metadata?: EvidenceRankingMetadata;
}) {
  const text = evidenceText(input.evidence);
  const entityMatches = queryEntityMatches(input.query, input.evidence, input.metadata);
  const explicitDateMatch = explicitDateMatches(input.query, input.metadata?.recordingDate);
  const lifecycle = assessQaLifecycleEvidence(input.query.lifecycle, text);
  let score = 0;
  score += entityMatches.exact * 8;
  score += entityMatches.alias * 7;
  score += entityMatches.speaker * 5;
  score += entityMatches.owner * (input.query.relationshipMode === "owner" ? 10 : 4);
  score += explicitDateMatch ? 12 : 0;
  score += lifecycle.topicOverlap * 2;
  if (input.query.temporalIntent === "final" && lifecycle.state === "resolved") score += 12;
  if (["earlier", "first"].includes(input.query.temporalIntent) && lifecycle.state === "pending") {
    score += 8;
  }
  if (input.query.types.includes("relationship")) {
    if (input.evidence.kind === "relationship_signal") score += 12;
    if (hasMemoryType(input.metadata, "relationship_signal")) score += 8;
  }
  if (input.query.types.includes("preference") && hasMemoryType(input.metadata, "preference")) {
    score += 12;
  }
  if (input.query.types.includes("decision")) {
    if (hasMemoryType(input.metadata, "event")) score += 4;
    if (/决定|选择|确认|decision/iu.test(text)) score += 6;
  }
  if (
    input.query.temporalIntent === "recent" &&
    input.metadata?.memoryStatus === "active"
  ) score += 5;
  return score;
}

export function retrieveStructuredEvidence(input: {
  query: HybridQuery;
  evidence: readonly QaRetrievedEvidence[];
  metadata?: ReadonlyMap<string, EvidenceRankingMetadata>;
  limit?: number;
}): ChannelCandidate[] {
  return input.evidence
    .map((evidence) => ({
      evidence,
      score: structuredEvidenceScore({
        query: input.query,
        evidence,
        metadata: metadataFor(evidence, input.metadata)
      })
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      right.evidence.priority - left.evidence.priority ||
      left.evidence.id.localeCompare(right.evidence.id)
    )
    .slice(0, Math.max(1, input.limit ?? 50))
    .map((candidate, index) => ({
      ...candidate,
      rank: index + 1,
      reasons: [`structured_score:${candidate.score}`]
    }));
}

export function retrieveRelationshipEvidence(input: {
  query: HybridQuery;
  evidence: readonly QaRetrievedEvidence[];
  metadata?: ReadonlyMap<string, EvidenceRankingMetadata>;
  limit?: number;
}): ChannelCandidate[] {
  if (!input.query.types.includes("relationship")) return [];
  const ranked = input.evidence
    .flatMap((evidence) => {
      const metadata = metadataFor(evidence, input.metadata);
      if (
        evidence.sourceSegmentIds.length === 0 ||
        metadata?.relationshipSourceValid === false
      ) return [];
      const matches = queryEntityMatches(input.query, evidence, metadata);
      if (input.query.relationshipMode === "owner" && input.query.entities.length > 0) {
        if (matches.owner === 0) return [];
      }
      let score = 0;
      const reasons: string[] = [];
      if (matches.exact > 0) {
        score += matches.exact * 16;
        reasons.push(`exact_entity:${matches.exact}`);
      }
      if (matches.alias > 0) {
        score += matches.alias * 14;
        reasons.push(`entity_alias:${matches.alias}`);
      }
      if (matches.speaker > 0 && input.query.relationshipMode !== "owner") {
        score += matches.speaker * 8;
        reasons.push(`speaker_match:${matches.speaker}`);
      }
      if (matches.owner > 0) {
        score += matches.owner * 12;
        reasons.push(`owner_match:${matches.owner}`);
      }
      if (evidence.kind === "relationship_signal") {
        score += 18;
        reasons.push("canonical_relationship_signal");
      }
      if (hasMemoryType(metadata, "relationship_signal")) {
        score += 8;
        reasons.push("relationship_memory_signal");
      }
      const text = evidenceText(evidence);
      const relationshipTerms = sharedTokenCount(
        new Set(input.query.tokens),
        meaningfulTextTokens(text)
      );
      if (relationshipTerms > 0) {
        score += Math.min(12, relationshipTerms * 2);
        reasons.push(`relationship_terms:${relationshipTerms}`);
      }
      if (
        /边界|支持|倾听|承诺|沟通|互动|相处|对方|双方|两人|speaker/iu.test(text)
      ) {
        score += 3;
        reasons.push("relationship_text_signal");
      }
      const concept = relationshipConceptScore(input.query, text);
      score += concept.score;
      reasons.push(...concept.reasons);
      return score > 0 ? [{ evidence, score, reasons }] : [];
    })
    .sort((left, right) =>
      right.score - left.score ||
      right.evidence.priority - left.evidence.priority ||
      (metadataFor(right.evidence, input.metadata)?.recordingDate ?? "").localeCompare(
        metadataFor(left.evidence, input.metadata)?.recordingDate ?? ""
      ) ||
      left.evidence.id.localeCompare(right.evidence.id)
    );
  return diversifyByRecordingDate(ranked, input.metadata)
    .slice(0, Math.max(1, input.limit ?? 50))
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

function temporalSortValue(
  evidence: QaRetrievedEvidence,
  metadata: EvidenceRankingMetadata | undefined
) {
  return {
    date: metadata?.recordingDate ?? "",
    recordingId: metadata?.recordingId ?? "",
    segmentOrder: metadata?.segmentOrder ?? evidence.startSeconds,
    startSeconds: evidence.startSeconds
  };
}

function compareTemporal(
  left: { evidence: QaRetrievedEvidence },
  right: { evidence: QaRetrievedEvidence },
  query: HybridQuery,
  metadata: ReadonlyMap<string, EvidenceRankingMetadata> | undefined
) {
  const a = temporalSortValue(left.evidence, metadataFor(left.evidence, metadata));
  const b = temporalSortValue(right.evidence, metadataFor(right.evidence, metadata));
  const ascending = ["earlier", "first", "sequence"].includes(query.temporalIntent);
  const dateDifference = a.date.localeCompare(b.date);
  if (dateDifference !== 0) return ascending ? dateDifference : -dateDifference;
  if (a.recordingId && b.recordingId && a.recordingId === b.recordingId) {
    const orderDifference = a.segmentOrder - b.segmentOrder || a.startSeconds - b.startSeconds;
    if (orderDifference !== 0) return ascending ? orderDifference : -orderDifference;
  }
  return left.evidence.id.localeCompare(right.evidence.id);
}

export function retrieveTemporalEvidence(input: {
  query: HybridQuery;
  evidence: readonly QaRetrievedEvidence[];
  metadata?: ReadonlyMap<string, EvidenceRankingMetadata>;
  limit?: number;
}): ChannelCandidate[] {
  if (!input.query.types.includes("temporal")) return [];
  const dated = input.evidence
    .flatMap((evidence) => {
      const metadata = metadataFor(evidence, input.metadata);
      const explicit = explicitDateMatches(input.query, metadata?.recordingDate);
      if (input.query.explicitDates.length > 0 && !explicit) return [];
      let score = explicit ? 20 : 5;
      const reasons = explicit ? ["explicit_date"] : ["recording_date_order"];
      const lifecycle = assessQaLifecycleEvidence(input.query.lifecycle, evidenceText(evidence));
      if (
        ["final", "last", "later", "recent"].includes(input.query.temporalIntent) &&
        lifecycle.state === "resolved"
      ) {
        score += 6;
        reasons.push("resolved_latest_state");
      }
      if (
        ["earlier", "first"].includes(input.query.temporalIntent) &&
        lifecycle.state === "pending"
      ) {
        score += 5;
        reasons.push("initial_pending_state");
      }
      return metadata?.recordingDate ? [{ evidence, score, reasons }] : [];
    })
    .sort((left, right) =>
      compareTemporal(left, right, input.query, input.metadata) ||
      right.score - left.score
    );
  return dated
    .slice(0, Math.max(1, input.limit ?? 50))
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

function retrieveLifecycleEvidence(input: {
  query: HybridQuery;
  evidence: readonly QaRetrievedEvidence[];
  metadata?: ReadonlyMap<string, EvidenceRankingMetadata>;
  limit?: number;
}): ChannelCandidate[] {
  if (!input.query.types.includes("lifecycle") && !input.query.types.includes("decision")) return [];
  return input.evidence
    .flatMap((evidence) => {
      const assessment = assessQaLifecycleEvidence(input.query.lifecycle, evidenceText(evidence));
      if (assessment.topicOverlap <= 0) return [];
      let score = assessment.topicOverlap * 3;
      const reasons = [`topic_overlap:${assessment.topicOverlap}`];
      if (assessment.state === "resolved") {
        score += 8;
        reasons.push("resolved");
      } else if (assessment.state === "pending") {
        score += 5;
        reasons.push("pending");
      }
      return [{ evidence, score, reasons }];
    })
    .sort((left, right) =>
      right.score - left.score ||
      (metadataFor(right.evidence, input.metadata)?.recordingDate ?? "").localeCompare(
        metadataFor(left.evidence, input.metadata)?.recordingDate ?? ""
      ) ||
      left.evidence.id.localeCompare(right.evidence.id)
    )
    .slice(0, Math.max(1, input.limit ?? 50))
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

function retrievePreferenceEvidence(input: {
  query: HybridQuery;
  evidence: readonly QaRetrievedEvidence[];
  metadata?: ReadonlyMap<string, EvidenceRankingMetadata>;
  limit?: number;
}): ChannelCandidate[] {
  if (!input.query.types.includes("preference")) return [];
  return input.evidence
    .flatMap((evidence) => {
      const metadata = metadataFor(evidence, input.metadata);
      const text = evidenceText(evidence);
      const typed = hasMemoryType(metadata, "preference");
      const lexical = /喜欢|偏好|习惯|不喜欢|更愿意|长期|清淡|安静|prefer/iu.test(text);
      if (!typed && !lexical) return [];
      const distinctDates = metadata?.distinctDates ?? 1;
      const occurrences = metadata?.occurrenceCount ?? 1;
      const active = metadata?.memoryStatus === "active";
      const score =
        (typed ? 10 : 0) +
        (lexical ? 4 : 0) +
        Math.min(6, distinctDates * 2) +
        Math.min(4, occurrences) +
        (active ? 3 : 0);
      return [{
        evidence,
        score,
        reasons: [
          ...(typed ? ["preference_memory"] : []),
          ...(lexical ? ["preference_text"] : []),
          `distinct_dates:${distinctDates}`,
          `occurrences:${occurrences}`,
          ...(active ? ["active"] : [])
        ]
      }];
    })
    .sort((left, right) =>
      right.score - left.score ||
      (metadataFor(right.evidence, input.metadata)?.recordingDate ?? "").localeCompare(
        metadataFor(left.evidence, input.metadata)?.recordingDate ?? ""
      ) ||
      left.evidence.id.localeCompare(right.evidence.id)
    )
    .slice(0, Math.max(1, input.limit ?? 50))
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

function channelWeights(strategy: HybridFusionStrategy, query: HybridQuery) {
  const uniform: Record<string, number> = {
    current: 0,
    dense: 1,
    lexical: 1,
    structured: 1,
    relationship: 1,
    temporal: 1,
    lifecycle: 1,
    preference: 1,
    memory: 1
  };
  if (strategy === "uniform_rrf" || strategy === "guarded_rrf") return uniform;
  const weighted = {
    ...uniform,
    dense: 1.1,
    relationship: 1.35,
    temporal: 1.3,
    lifecycle: 1.15,
    preference: 1.15
  };
  if (strategy === "weighted_rrf") return weighted;
  if (query.types.includes("relationship")) weighted.relationship = 2;
  if (query.types.includes("temporal")) weighted.temporal = 1.8;
  if (query.types.includes("lifecycle") || query.types.includes("decision")) {
    weighted.lifecycle = 1.6;
  }
  if (query.types.includes("preference")) weighted.preference = 1.6;
  return weighted;
}

function denseLimit(strategy: HybridFusionStrategy, query: HybridQuery, available: number) {
  if (strategy !== "dynamic_dense_rrf") return available;
  if (query.types.includes("relationship") || query.types.includes("temporal")) {
    return Math.min(20, available);
  }
  return Math.min(40, available);
}

function appliedQuotas(query: HybridQuery): Partial<Record<HybridRecallChannel, number>> {
  return {
    ...(query.types.includes("relationship") ? { relationship: 4 } : {}),
    ...(query.types.includes("temporal") ? { temporal: 4 } : {}),
    ...(query.types.includes("lifecycle") || query.types.includes("decision")
      ? { lifecycle: 3 }
      : {}),
    ...(query.types.includes("preference") ? { preference: 4 } : {})
  };
}

function promoteChannelQuota(
  ids: string[],
  channel: readonly ChannelCandidate[],
  quota: number,
  boundary: number
) {
  if (quota <= 0 || channel.length === 0) return ids;
  const output = [...ids];
  const wanted = channel.slice(0, quota).map((item) => item.evidence.id);
  let insertionIndex = Math.max(0, boundary - quota);
  for (const id of wanted) {
    const currentIndex = output.indexOf(id);
    if (currentIndex >= 0 && currentIndex < boundary) continue;
    if (currentIndex >= 0) output.splice(currentIndex, 1);
    output.splice(Math.min(insertionIndex, output.length), 0, id);
    insertionIndex += 1;
  }
  return output;
}

function protectCurrentRetrievalFloor(input: {
  ids: readonly string[];
  current: readonly ChannelCandidate[];
  query: HybridQuery;
  limit: number;
}) {
  if (
    !input.query.types.includes("relationship") &&
    !input.query.types.includes("temporal")
  ) {
    return [...input.ids];
  }
  const currentIds = [...new Set(input.current.map((item) => item.evidence.id))];
  const fusedRank = new Map(input.ids.map((id, index) => [id, index + 1]));
  const protectedTop10 = currentIds
    .slice(0, 10)
    .sort((left, right) =>
      (fusedRank.get(left) ?? Number.POSITIVE_INFINITY) -
        (fusedRank.get(right) ?? Number.POSITIVE_INFINITY) ||
      currentIds.indexOf(left) - currentIds.indexOf(right)
    );
  const protectedTail = currentIds.slice(10, 16);
  const protectedIds = new Set([...protectedTop10, ...protectedTail]);
  const fusedOnly = input.ids.filter((id) => !protectedIds.has(id));
  const headCapacity = Math.max(0, input.limit - protectedTail.length);
  const output = [
    ...protectedTop10,
    ...fusedOnly.slice(0, Math.max(0, headCapacity - protectedTop10.length)),
    ...protectedTail
  ];
  if (output.length < input.limit) {
    output.push(
      ...input.ids.filter((id) => !output.includes(id)).slice(0, input.limit - output.length)
    );
  }
  return output.slice(0, input.limit);
}

function appendCurrentAvailabilityTail(input: {
  ids: readonly string[];
  current: readonly ChannelCandidate[];
  query: HybridQuery;
  limit: number;
}) {
  if (
    input.limit <= 30 ||
    (
      !input.query.types.includes("relationship") &&
      !input.query.types.includes("temporal")
    )
  ) {
    return [...input.ids];
  }
  const top30 = input.ids.slice(0, 30);
  const selected = new Set(top30);
  const currentTail = input.current
    .map((item) => item.evidence.id)
    .filter((id) => !selected.has(id));
  for (const id of currentTail) selected.add(id);
  const fusedTail = input.ids
    .slice(30)
    .filter((id) => !selected.has(id));
  return [...top30, ...currentTail, ...fusedTail].slice(0, input.limit);
}

function rankingsForStrategy(
  strategy: HybridFusionStrategy,
  channels: Record<HybridRecallChannel, ChannelCandidate[]>,
  query: HybridQuery
) {
  const rankings: Record<string, RrfRankedItem[]> = Object.fromEntries(
    Object.entries(channels).map(([name, candidates]) => [
      name,
      candidates.map((item) => ({ id: item.evidence.id, rank: item.rank }))
    ])
  );
  if (strategy === "union_then_rrf") {
    const firstStage = reciprocalRankFusion({
      dense: rankings.dense!,
      structured: rankings.structured!
    }, {
      limit: 50,
      channelWeights: { dense: 1.1, structured: 1 }
    });
    return {
      semantic_structured_union: firstStage.map((item, index) => ({
        id: item.id,
        rank: index + 1
      })),
      lexical: rankings.lexical!,
      relationship: rankings.relationship!,
      temporal: rankings.temporal!,
      lifecycle: rankings.lifecycle!,
      preference: rankings.preference!,
      memory: rankings.memory!
    };
  }
  return rankings;
}

export function generateHybridCandidatesWithDiagnostics(input: {
  question: string;
  conversation?: readonly { role: "user" | "assistant"; content: string }[];
  evidence: readonly QaRetrievedEvidence[];
  denseCandidates: readonly DenseEvidenceCandidate[];
  currentCandidates: readonly QaRetrievedEvidence[];
  memoryCandidates?: readonly {
    evidence: QaRetrievedEvidence;
    score: number;
    reasons?: readonly string[];
  }[];
  metadata?: ReadonlyMap<string, EvidenceRankingMetadata>;
  limit?: number;
  strategy?: HybridFusionStrategy;
}): HybridCandidateDiagnostics {
  const limit = Math.min(50, Math.max(30, Math.floor(input.limit ?? 50)));
  const strategy = input.strategy ?? "quota_rrf";
  const query = parseHybridQuery(input.question, input.conversation);
  const dense = input.denseCandidates
    .slice(0, denseLimit(strategy, query, input.denseCandidates.length))
    .map((item) => ({
      evidence: item.evidence,
      rank: item.rank,
      score: item.score,
      reasons: [`cosine_rank:${item.rank}`]
    }));
  const canonicalIds = new Set(input.evidence.map((item) => item.id));
  const current = input.currentCandidates
    .filter((item) => canonicalIds.has(item.id))
    .map((item, index) => ({
      evidence: item,
      rank: index + 1,
      score: 0,
      reasons: [`current_rank:${index + 1}`]
    }));
  const channels: Record<HybridRecallChannel, ChannelCandidate[]> = {
    current,
    dense,
    lexical: retrieveLexicalEvidence({
      query,
      evidence: input.evidence,
      currentCandidates: input.currentCandidates,
      limit: 50
    }),
    structured: retrieveStructuredEvidence({
      query,
      evidence: input.evidence,
      metadata: input.metadata,
      limit: 50
    }),
    relationship: retrieveRelationshipEvidence({
      query,
      evidence: input.evidence,
      metadata: input.metadata,
      limit: 50
    }),
    temporal: retrieveTemporalEvidence({
      query,
      evidence: input.evidence,
      metadata: input.metadata,
      limit: 50
    }),
    lifecycle: retrieveLifecycleEvidence({
      query,
      evidence: input.evidence,
      metadata: input.metadata,
      limit: 50
    }),
    preference: retrievePreferenceEvidence({
      query,
      evidence: input.evidence,
      metadata: input.metadata,
      limit: 50
    }),
    memory: (input.memoryCandidates ?? [])
      .filter((candidate) => canonicalIds.has(candidate.evidence.id))
      .slice(0, 50)
      .map((candidate, index) => ({
        evidence: candidate.evidence,
        rank: index + 1,
        score: candidate.score,
        reasons: [...(candidate.reasons ?? ["memory_expansion"])]
      }))
  };
  const rankings = rankingsForStrategy(strategy, channels, query);
  const fused = reciprocalRankFusion(rankings, {
    limit: Math.max(limit, input.evidence.length),
    channelWeights: channelWeights(strategy, query)
  });
  let ids = fused.map((item) => item.id);
  const quotas =
    strategy === "quota_rrf" || strategy === "dynamic_dense_rrf"
      ? appliedQuotas(query)
      : {};
  if (quotas.relationship) {
    ids = promoteChannelQuota(ids, channels.relationship, quotas.relationship, 10);
  }
  if (quotas.temporal) {
    ids = promoteChannelQuota(ids, channels.temporal, quotas.temporal, 10);
  }
  if (quotas.lifecycle) {
    ids = promoteChannelQuota(ids, channels.lifecycle, quotas.lifecycle, 16);
  }
  if (quotas.preference) {
    ids = promoteChannelQuota(ids, channels.preference, quotas.preference, 16);
  }
  if (strategy === "guarded_rrf") {
    ids = protectCurrentRetrievalFloor({
      ids,
      current: channels.current,
      query,
      limit
    });
  } else if (strategy === "uniform_rrf") {
    ids = appendCurrentAvailabilityTail({
      ids,
      current: channels.current,
      query,
      limit
    });
  }
  ids = [...new Set(ids)].slice(0, limit);

  const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));
  const fusedById = new Map(fused.map((item) => [item.id, item]));
  const denseById = new Map(input.denseCandidates.map((item) => [item.evidence.id, item]));
  const structuredById = new Map(channels.structured.map((item) => [item.evidence.id, item]));
  const candidates = ids.flatMap((id): HybridEvidenceCandidate[] => {
    const evidence = evidenceById.get(id);
    const item = fusedById.get(id);
    if (!evidence) return [];
    const denseItem = denseById.get(id);
    const structuredItem = structuredById.get(id);
    const channelRanks = Object.fromEntries(
      Object.entries(channels).flatMap(([channel, items]) => {
        const found = items.find((candidate) => candidate.evidence.id === id);
        return found ? [[channel, found.rank]] : [];
      })
    );
    return [{
      evidence,
      rrfScore: item?.score ?? 0,
      channelRanks,
      ...(denseItem ? { denseScore: denseItem.score } : {}),
      ...(structuredItem ? { structuredScore: structuredItem.score } : {})
    }];
  });

  return {
    strategy,
    query,
    channelCounts: Object.fromEntries(
      Object.entries(channels).map(([name, candidates]) => [name, candidates.length])
    ) as Record<HybridRecallChannel, number>,
    channelIds: Object.fromEntries(
      Object.entries(channels).map(([name, candidates]) => [
        name,
        candidates.map((candidate) => candidate.evidence.id)
      ])
    ) as Record<HybridRecallChannel, string[]>,
    appliedQuotas: quotas,
    candidates
  };
}

export function generateHybridCandidates(
  input: Parameters<typeof generateHybridCandidatesWithDiagnostics>[0]
): HybridEvidenceCandidate[] {
  return generateHybridCandidatesWithDiagnostics(input).candidates;
}

export function hybridCandidateCitationValidity(
  candidates: readonly HybridEvidenceCandidate[],
  canonicalEvidence: readonly QaRetrievedEvidence[]
) {
  const canonicalById = new Map(canonicalEvidence.map((item) => [item.id, item]));
  return candidates.every((candidate) => {
    const canonical = canonicalById.get(candidate.evidence.id);
    return Boolean(
      canonical &&
      canonical.sourceSegmentIds.length > 0 &&
      canonical.sourceSegmentIds.length === candidate.evidence.sourceSegmentIds.length &&
      canonical.sourceSegmentIds.every((id, index) => id === candidate.evidence.sourceSegmentIds[index])
    );
  });
}
