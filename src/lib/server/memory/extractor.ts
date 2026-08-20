import { createHash } from "node:crypto";
import type { BriefItem, RelationshipSignalCard, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
import type { RelationshipLifecycleEdge } from "@/lib/server/relationship-signals/lifecycle/types";
import type {
  MemoryEvidenceSourceType,
  MemoryEvidenceWrite,
  MemoryItemType,
  MemoryWriteInput
} from "./types";
import {
  evaluateMemoryAdmission,
  isStablePreferenceText,
  type MemoryAdmissionDecision
} from "./admission";
import {
  extractPreferenceIdentities,
  preferenceIdentitiesFromMemory,
  preferenceIdentityHash,
  preferenceIdentityLabel,
  type PreferenceIdentity
} from "./preference-identity";
import {
  resolveMemoryOwnerAttribution,
  resolveMemoryOwnerAttributions,
  auditMemoryOwnerAttributions,
  type MemoryOwnerAudit,
  type MemoryOwnerResolution
} from "./owner-attribution";
import {
  memoryOwnerReviewCandidateId,
  memoryOwnerReviewEvidenceDigest,
  providerReviewLabels,
  type MemoryOwnerReviewDraft,
  type MemoryOwnerReviewOverride,
  type MemoryOwnerReviewStructuralGate
} from "./owner-review";

export type ExtractUploadMemoriesInput = {
  userId: string;
  uploadId: string;
  recordingDate: string;
  segments: TranscriptSegment[];
  briefItems: BriefItem[];
  semanticSegments: SemanticSegment[];
  relationshipSignals: RelationshipSignalCard[];
  relationshipLifecycle?: {
    edges: RelationshipLifecycleEdge[];
    candidateIdsByCardId?: Record<string, string[]>;
  };
  identityStructuralGate?: MemoryOwnerReviewStructuralGate;
  ownerReviewOverrides?: MemoryOwnerReviewOverride[];
  now?: string;
};

const priorityImportance = {
  high: 0.9,
  medium: 0.7,
  low: 0.5
} as const;

const severityImportance = {
  high: 0.9,
  medium: 0.7,
  low: 0.5
} as const;

type MemoryClassification = {
  type: MemoryItemType;
  reason: string;
};

const unresolvedPattern =
  /未解决|没解决|没说清|待确认|待定|尚未|还(?:没|未|需|要).{0,10}(?:确认|决定|说清|解决)|需要(?:再|继续|进一步)?确认|open question|unresolved|not decided|still (?:open|unclear)/i;
const preferencePattern =
  /(?:我|我们|你|你们|他|她|对方).{0,12}(?:不喜欢|更喜欢|最喜欢|特别喜欢|偏好|习惯|通常|一般|总是|每次)|(?:我|我们).{0,12}(?:希望|需要).{0,16}(?:先|再|被|得到|不要|别|提前)|不喜欢临时|prefer(?:ence)?|usually|habit/i;
const commitmentPattern =
  /(?:我|我们|他|她|对方|双方).{0,10}(?:承诺|答应|约定|说好|保证)|(?:明天|后天|下周|周末|下次).{0,24}(?:一起|去|做|见|确认|联系|安排|完成)|(?:我|我们|他|她|对方).{0,10}(?:会|将|计划|打算|准备).{0,28}(?:确认|联系|安排|去|做|不再|及时|一起|完成|回复)|promise|commitment|agreed? to|will (?:confirm|contact|meet|do|finish)/i;
const completedTaskPattern =
  /已(?:经)?.{0,16}(?:完成|提交|交付|结束)|(?:完成|提交|交付)(?:了|完成)|任务已(?:经)?结束|\b(?:completed|submitted|delivered|finished|done)\b/i;
const unfinishedTaskPattern =
  /(?:还|仍)(?:需要|需|要|剩|差)|仍未|尚未|未(?:完成|提交|交付|结束)|待(?:完成|提交|交付|核对)|(?:计划|准备|打算).{0,24}(?:完成|提交|交付|核对)|会.{0,12}(?:继续|完成|提交|交付|核对)|\b(?:pending|still (?:open|incomplete|unfinished)|not (?:done|completed|finished))\b/i;
const recentEventPattern =
  /今天|昨天|刚刚|这次|当时|上次|已经.{0,12}(?:完成|解决|确认)|(?:完成|解决|确认)了|today|yesterday|this time|last time/i;
const MAX_RECENT_SEMANTIC_EVENTS = 2;

function clamp(value: number) {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

function cleanText(value: string, maxLength = 4_000) {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function verbatimQuote(value: string, maxLength = 4_000) {
  return value.slice(0, maxLength);
}

function semanticMemorySummary(value: string) {
  const conciseIntro = value.match(/^围绕[^。！？!?]{1,240}展开[。！？!?]/u)?.[0];
  return conciseIntro ?? value;
}

function stableId(prefix: "memory" | "evidence", parts: string[]) {
  const digest = createHash("sha256").update(parts.join("\u001f")).digest("hex").slice(0, 32);
  return `${prefix}_${digest}`;
}

function sourceText(input: { title: string; summary: string; excerpt: string }) {
  return `${input.title}\n${input.summary}\n${input.excerpt}`;
}

function classifyBriefItem(item: BriefItem): MemoryClassification | null {
  if (item.category === "commitment") {
    return { type: "commitment", reason: "extraction: brief category commitment" };
  }
  if (item.category === "open_question") {
    return { type: "question", reason: "extraction: brief category open_question" };
  }
  const text = sourceText({ title: item.title, summary: item.body, excerpt: item.transcriptExcerpt });
  if (preferencePattern.test(text)) {
    return { type: "preference", reason: "extraction: contains explicit stable preference or habit" };
  }
  if (
    item.category === "task" &&
    completedTaskPattern.test(text) &&
    !unfinishedTaskPattern.test(text)
  ) {
    return { type: "event", reason: "extraction: brief task is explicitly completed" };
  }
  if (item.category === "task") {
    return { type: "commitment", reason: "extraction: brief task contains a future action" };
  }
  if (item.category === "risk" && unresolvedPattern.test(text)) {
    return { type: "question", reason: "extraction: risk remains unresolved or pending confirmation" };
  }
  if (item.category === "decision" || item.category === "risk") {
    return { type: "event", reason: `extraction: brief category ${item.category}` };
  }
  return null;
}

function classifySemanticSegment(segment: SemanticSegment): MemoryClassification | null {
  const text = sourceText({
    title: segment.title,
    summary: segment.summary,
    excerpt: segment.transcriptExcerpt
  });
  if (segment.valueLabels.includes("open_question") || unresolvedPattern.test(text)) {
    return {
      type: "question",
      reason: segment.valueLabels.includes("open_question")
        ? "extraction: semantic value label open_question"
        : "extraction: contains unresolved or pending confirmation language"
    };
  }
  if (preferencePattern.test(text)) {
    return { type: "preference", reason: "extraction: contains explicit stable preference or habit" };
  }
  if (segment.valueLabels.includes("task")) {
    return { type: "commitment", reason: "extraction: semantic task contains a future action" };
  }
  if (commitmentPattern.test(text)) {
    return {
      type: "commitment",
      reason: "extraction: contains future action and commitment language"
    };
  }
  if (segment.valueLabels.includes("decision") || segment.valueLabels.includes("risk")) {
    const label = segment.valueLabels.includes("decision") ? "decision" : "risk";
    return { type: "event", reason: `extraction: semantic value label ${label}` };
  }
  if (recentEventPattern.test(text)) {
    return { type: "event", reason: "extraction: contains a dated or completed activity" };
  }
  return null;
}

function createMemory(input: {
  userId: string;
  uploadId: string;
  recordingDate: string;
  type: MemoryItemType;
  title: string;
  summary: string;
  importance: number;
  extractionReason: string;
  structuredSourceType?: Exclude<MemoryEvidenceSourceType, "transcript" | "audio_insight">;
  structuredSourceId?: string;
  identityKey?: string;
  sourceSegmentIds: string[];
  segmentById: Map<string, TranscriptSegment>;
  now: string;
  status?: MemoryWriteInput["status"];
}): MemoryWriteInput | null {
  const sourceSegments = Array.from(new Set(input.sourceSegmentIds))
    .map((segmentId) => input.segmentById.get(segmentId))
    .filter(
      (segment): segment is TranscriptSegment =>
        segment !== undefined && segment.uploadId === input.uploadId
    );

  if (sourceSegments.length === 0) {
    return null;
  }

  const memoryId = stableId("memory", [
    input.userId,
    input.uploadId,
    input.type,
    input.structuredSourceType ?? "transcript",
    input.structuredSourceId ?? sourceSegments[0].id,
    input.identityKey ?? ""
  ]);
  const canonicalQuote = verbatimQuote(sourceSegments[0].text);
  const evidence: MemoryEvidenceWrite[] = [
    ...(input.structuredSourceType && input.structuredSourceId ? [{
      id: stableId("evidence", [memoryId, input.structuredSourceType, input.structuredSourceId]),
      sourceType: input.structuredSourceType,
      sourceId: input.structuredSourceId,
      uploadId: input.uploadId,
      date: input.recordingDate,
      quote: canonicalQuote,
      createdAt: input.now
    }] : []),
    ...sourceSegments.map((segment) => ({
      id: stableId("evidence", [memoryId, "transcript", segment.id]),
      sourceType: "transcript" as const,
      sourceId: segment.id,
      uploadId: input.uploadId,
      date: input.recordingDate,
      quote: verbatimQuote(segment.text),
      createdAt: input.now
    }))
  ];

  return {
    id: memoryId,
    type: input.type,
    title: cleanText(input.title, 500),
    summary: cleanText(input.summary),
    importance: clamp(input.importance),
    importanceReasons: [input.extractionReason],
    ...(input.status ? { status: input.status } : {}),
    date: input.recordingDate,
    createdAt: input.now,
    updatedAt: input.now,
    evidence
  };
}

function transcriptPreferenceGroups(segments: TranscriptSegment[]) {
  const candidates = segments.filter((segment) => isStablePreferenceText(segment.text));
  const groups = new Map<string, {
    identity: PreferenceIdentity;
    ownerKey: string;
    segments: TranscriptSegment[];
  }>();
  for (const candidate of candidates) {
    const attribution = resolveMemoryOwnerAttribution({
      memoryId: `preference_observation_${candidate.id}`,
      memoryType: "preference",
      evidenceSegments: [candidate]
    });
    const ownerKey = attribution.scope === "individual" && attribution.owner.type !== "unknown"
      ? `${attribution.owner.type}\u001f${attribution.owner.identityId}`
      : `unresolved\u001f${candidate.id}`;
    for (const identity of extractPreferenceIdentities(candidate.text)) {
      const groupKey = `${ownerKey}\u001f${identity.fingerprint}`;
      const group = groups.get(groupKey) ?? { identity, ownerKey, segments: [] };
      if (!group.segments.some((segment) => segment.id === candidate.id)) {
        group.segments.push(candidate);
      }
      groups.set(groupKey, group);
    }
  }
  return [...groups.values()].sort((left, right) =>
    left.ownerKey.localeCompare(right.ownerKey) ||
    left.identity.fingerprint.localeCompare(right.identity.fingerprint)
  );
}

export type MemoryExtractionAudit = {
  candidateCount: number;
  persistedCount: number;
  rejectedCount: number;
  decisions: MemoryAdmissionDecision[];
  preferenceCandidates: Array<{
    memoryId: string;
    sourceSegmentIds: string[];
    identityHash: string;
    normalizedValue: PreferenceIdentity["value"];
    observationCount: number;
    persisted: boolean;
  }>;
  relationshipSignals: Array<{
    signalId: string;
    signalType: RelationshipSignalCard["signalType"];
    memoryTier: MemoryAdmissionDecision["memoryTier"];
    score: number;
    reasons: string[];
    lifecycleResolved?: boolean;
    lifecycleRelationTypes?: RelationshipLifecycleEdge["relationType"][];
  }>;
  ownerAttribution: MemoryOwnerAudit;
};

type MemoryCandidate = {
  memory: MemoryWriteInput;
  ownerAttribution?: MemoryOwnerResolution;
  relationshipSignal?: RelationshipSignalCard;
  sourceSegmentCount: number;
  preferenceSourceSegmentIds?: string[];
  preferenceIdentity?: PreferenceIdentity;
  lifecycleResolved?: boolean;
  lifecycleRelationTypes?: RelationshipLifecycleEdge["relationType"][];
};

function relationshipLifecycleForCard(input: {
  cardId: string;
  lifecycle?: ExtractUploadMemoriesInput["relationshipLifecycle"];
}) {
  if (!input.lifecycle) {
    return { targetSegmentIds: [] as string[], relationTypes: [] as RelationshipLifecycleEdge["relationType"][], resolved: false };
  }
  const sourceIds = new Set([
    input.cardId,
    ...(input.lifecycle.candidateIdsByCardId?.[input.cardId] ?? [])
  ]);
  const edgesBySource = new Map<string, RelationshipLifecycleEdge[]>();
  for (const edge of input.lifecycle.edges) {
    const outgoing = edgesBySource.get(edge.fromSignalId) ?? [];
    outgoing.push(edge);
    edgesBySource.set(edge.fromSignalId, outgoing);
  }
  const queue = [...sourceIds];
  const visited = new Set<string>();
  const edges: RelationshipLifecycleEdge[] = [];
  while (queue.length > 0) {
    const signalId = queue.shift()!;
    if (visited.has(signalId)) continue;
    visited.add(signalId);
    for (const edge of edgesBySource.get(signalId) ?? []) {
      edges.push(edge);
      if (!visited.has(edge.toSignalId)) queue.push(edge.toSignalId);
    }
  }
  const relationTypes = [...new Set(edges.map((edge) => edge.relationType))];
  return {
    targetSegmentIds: [...new Set(edges.flatMap((edge) => edge.evidence.toSegments))],
    relationTypes,
    resolved: relationTypes.some((relationType) => relationType !== "updated_by")
  };
}

function transcriptEvidenceIds(memory: MemoryWriteInput) {
  return new Set(memory.evidence.filter((item) => item.sourceType === "transcript").map((item) => item.sourceId));
}

function sourceSegmentsForMemory(
  memory: MemoryWriteInput,
  segmentById: Map<string, TranscriptSegment>
) {
  return [...transcriptEvidenceIds(memory)]
    .map((segmentId) => segmentById.get(segmentId))
    .filter((segment): segment is TranscriptSegment => segment !== undefined);
}

function ownerDedupKey(candidate: MemoryCandidate) {
  const attribution = candidate.ownerAttribution;
  return attribution?.scope === "individual" && attribution.owner.type !== "unknown"
    ? `${attribution.owner.type}\u001f${attribution.owner.identityId}`
    : `unresolved\u001f${candidate.memory.id}`;
}

function preferenceCandidateKey(candidate: MemoryCandidate, identity: PreferenceIdentity) {
  return `${ownerDedupKey(candidate)}\u001f${identity.fingerprint}`;
}

function deduplicateExtractionCandidates(candidates: MemoryCandidate[]) {
  const deduplicated = candidates.filter((candidate) => candidate.memory.type !== "preference");
  const preferenceByIdentity = new Map<string, MemoryCandidate>();
  const mergePreferenceCandidate = (candidate: MemoryCandidate) => {
    const identity = candidate.preferenceIdentity;
    if (!identity) return;
    const key = preferenceCandidateKey(candidate, identity);
    const existing = preferenceByIdentity.get(key);
    if (!existing) {
      preferenceByIdentity.set(key, candidate);
      return;
    }
    const evidenceByKey = new Map(
      [...existing.memory.evidence, ...candidate.memory.evidence]
        .map((evidence) => [`${evidence.sourceType}\u001f${evidence.sourceId}`, evidence] as const)
    );
    const preferred = candidate.preferenceSourceSegmentIds ? candidate.memory : existing.memory;
    existing.memory = {
      ...preferred,
      importanceReasons: [
        ...new Set([...(existing.memory.importanceReasons ?? []), ...(candidate.memory.importanceReasons ?? [])])
      ],
      evidence: [...evidenceByKey.values()]
    };
    existing.sourceSegmentCount = transcriptEvidenceIds(existing.memory).size;
    existing.preferenceSourceSegmentIds = [
      ...new Set([...(existing.preferenceSourceSegmentIds ?? []), ...(candidate.preferenceSourceSegmentIds ?? [])])
    ];
  };

  for (const candidate of candidates.filter((item) => item.memory.type === "preference" && item.preferenceIdentity)) {
    mergePreferenceCandidate(candidate);
  }

  for (const candidate of candidates.filter((item) => item.memory.type === "preference" && !item.preferenceIdentity)) {
    const identities = preferenceIdentitiesFromMemory(candidate.memory);
    const existingMatches = identities.flatMap((identity) => {
      const existing = preferenceByIdentity.get(preferenceCandidateKey(candidate, identity));
      return existing ? [existing] : [];
    });
    if (existingMatches.length > 0) {
      for (const existing of existingMatches) {
        existing.memory = {
          ...existing.memory,
          importanceReasons: [
            ...new Set([...(existing.memory.importanceReasons ?? []), ...(candidate.memory.importanceReasons ?? [])])
          ]
        };
      }
      continue;
    }
    if (identities.length !== 1) {
      continue;
    }
    const transcriptEvidence = candidate.memory.evidence.filter((evidence) =>
      evidence.sourceType === "transcript" &&
      extractPreferenceIdentities(evidence.quote).some((identity) => identity.fingerprint === identities[0].fingerprint)
    );
    if (transcriptEvidence.length === 0) {
      continue;
    }
    mergePreferenceCandidate({
      ...candidate,
      memory: { ...candidate.memory, evidence: transcriptEvidence },
      sourceSegmentCount: transcriptEvidence.length,
      preferenceSourceSegmentIds: transcriptEvidence.map((evidence) => evidence.sourceId),
      preferenceIdentity: identities[0]
    });
  }
  return [
    ...deduplicated,
    ...[...preferenceByIdentity.values()].sort((left, right) =>
      ownerDedupKey(left).localeCompare(ownerDedupKey(right)) ||
      left.preferenceIdentity!.fingerprint.localeCompare(right.preferenceIdentity!.fingerprint)
    )
  ];
}

export function extractUploadMemoriesWithAudit(input: ExtractUploadMemoriesInput): {
  memories: MemoryWriteInput[];
  ownerAttributions: MemoryOwnerResolution[];
  ownerReviewDrafts: MemoryOwnerReviewDraft[];
  appliedOwnerReviewCandidateIds: string[];
  audit: MemoryExtractionAudit;
} {
  const now = input.now ?? new Date().toISOString();
  const segmentById = new Map(input.segments.map((segment) => [segment.id, segment]));
  const candidates: MemoryCandidate[] = [];
  const addCandidate = (
    memory: MemoryWriteInput | null,
    metadata: Omit<MemoryCandidate, "memory"> = { sourceSegmentCount: 0 }
  ) => {
    if (memory) candidates.push({ memory, ...metadata });
  };
  let recentSemanticEventCount = 0;

  for (const semanticSegment of input.semanticSegments) {
    const classification = classifySemanticSegment(semanticSegment);
    if (!classification) continue;
    if (classification.reason === "extraction: contains a dated or completed activity") {
      if (recentSemanticEventCount >= MAX_RECENT_SEMANTIC_EVENTS) continue;
      recentSemanticEventCount += 1;
    }
    addCandidate(createMemory({
      ...input,
      type: classification.type,
      title: semanticSegment.title,
      summary: semanticMemorySummary(semanticSegment.summary),
      importance: 0.45 + semanticSegment.confidence * 0.35,
      extractionReason: classification.reason,
      structuredSourceType: "timeline",
      structuredSourceId: semanticSegment.id,
      sourceSegmentIds: semanticSegment.sourceSegmentIds,
      segmentById,
      now
    }), { sourceSegmentCount: semanticSegment.sourceSegmentIds.length });
  }

  for (const briefItem of input.briefItems) {
    const classification = classifyBriefItem(briefItem);
    if (!classification) continue;
    addCandidate(createMemory({
      ...input,
      type: classification.type,
      title: briefItem.title,
      summary: briefItem.body,
      importance: priorityImportance[briefItem.priority] * 0.7 + briefItem.confidence * 0.3,
      extractionReason: classification.reason,
      structuredSourceType: "brief",
      structuredSourceId: briefItem.id,
      sourceSegmentIds: briefItem.sourceSegmentIds,
      segmentById,
      now
    }), { sourceSegmentCount: briefItem.sourceSegmentIds.length });
  }

  for (const preferenceGroup of transcriptPreferenceGroups(input.segments)) {
    const preferenceSegments = preferenceGroup.segments;
    const representative = [...preferenceSegments].sort(
      (left, right) =>
        extractPreferenceIdentities(left.text).length - extractPreferenceIdentities(right.text).length ||
        right.text.length - left.text.length ||
        left.startSeconds - right.startSeconds
    )[0];
    const memory = createMemory({
      ...input,
      type: "preference",
      title: `明确偏好表达：${preferenceIdentityLabel(preferenceGroup.identity)}`,
      summary: representative.text,
      importance: 0.7,
      extractionReason: "extraction: explicit stable preference from transcript",
      sourceSegmentIds: preferenceSegments.map((segment) => segment.id),
      identityKey: `${preferenceGroup.ownerKey}\u001f${preferenceGroup.identity.fingerprint}`,
      segmentById,
      now
    });
    addCandidate(memory, {
      sourceSegmentCount: preferenceSegments.length,
      preferenceSourceSegmentIds: preferenceSegments.map((segment) => segment.id),
      preferenceIdentity: preferenceGroup.identity
    });
  }

  for (const relationshipSignal of input.relationshipSignals) {
    const lifecycle = relationshipLifecycleForCard({
      cardId: relationshipSignal.id,
      lifecycle: input.relationshipLifecycle
    });
    addCandidate(createMemory({
      ...input,
      type: "relationship_signal",
      title: relationshipSignal.summary,
      summary: relationshipSignal.explanation,
      importance: severityImportance[relationshipSignal.severity] * 0.6 + relationshipSignal.confidence * 0.4,
      extractionReason: `extraction: relationship signal ${relationshipSignal.signalType}`,
      structuredSourceType: "relationship_signal",
      structuredSourceId: relationshipSignal.id,
      sourceSegmentIds: [
        ...relationshipSignal.evidenceSegments.map((evidence) => evidence.segmentId),
        ...lifecycle.targetSegmentIds
      ],
      segmentById,
      now,
      ...(lifecycle.resolved ? { status: "resolved" as const } : {})
    }), {
      relationshipSignal,
      sourceSegmentCount: relationshipSignal.evidenceSegments.length + lifecycle.targetSegmentIds.length,
      ...(lifecycle.relationTypes.length > 0 ? {
        lifecycleResolved: lifecycle.resolved,
        lifecycleRelationTypes: lifecycle.relationTypes
      } : {})
    });
  }

  const initiallyAttributed = candidates.map((candidate) => ({
    ...candidate,
    ownerAttribution: resolveMemoryOwnerAttribution({
      memoryId: candidate.memory.id,
      memoryType: candidate.memory.type,
      evidenceSegments: sourceSegmentsForMemory(candidate.memory, segmentById)
    })
  }));
  const normalizedCandidates = deduplicateExtractionCandidates(initiallyAttributed);
  const ownerResolution = resolveMemoryOwnerAttributions({
    memories: normalizedCandidates.map((candidate) => ({
      memoryId: candidate.memory.id,
      memoryType: candidate.memory.type,
      evidenceSegments: sourceSegmentsForMemory(candidate.memory, segmentById)
    })),
    now: () => now
  });
  const ownerAttributionByMemoryId = new Map(
    ownerResolution.attributions.map((attribution) => [attribution.memoryId, attribution])
  );
  const ownerReviewOverrideByCandidateId = new Map(
    (input.ownerReviewOverrides ?? []).map((override) => [override.candidateId, override])
  );
  const candidateReviewData = new Map<string, {
    candidateId: string;
    evidenceDigest: string;
    evidenceSegments: TranscriptSegment[];
    providerLabels: string[];
  }>();
  for (const candidate of normalizedCandidates) {
    const evidenceSegments = sourceSegmentsForMemory(candidate.memory, segmentById);
    const providerLabels = providerReviewLabels(evidenceSegments);
    if (providerLabels.length === 0) continue;
    const candidateId = memoryOwnerReviewCandidateId(input.uploadId, candidate.memory.id);
    candidateReviewData.set(candidate.memory.id, {
      candidateId,
      evidenceDigest: memoryOwnerReviewEvidenceDigest({
        uploadId: input.uploadId,
        memory: candidate.memory,
        evidenceSegments,
        providerLabels
      }),
      evidenceSegments,
      providerLabels
    });
  }
  const manualOwnerResolution = (
    candidate: MemoryCandidate,
    reviewData: NonNullable<ReturnType<typeof candidateReviewData.get>>,
    override: MemoryOwnerReviewOverride
  ): MemoryOwnerResolution => {
    const evidenceSegmentIds = reviewData.evidenceSegments.map((segment) => segment.id);
    const attribution = {
      type: "known_identity" as const,
      identityId: override.ownerIdentityId,
      confidence: 1,
      source: "manual_mapping" as const
    };
    return {
      version: 1,
      memoryId: candidate.memory.id,
      memoryType: candidate.memory.type,
      scope: "individual",
      owner: attribution,
      participants: [{
        role: "owner",
        attribution,
        evidenceSegmentIds
      }],
      evidenceSegmentIds,
      observations: [],
      reasons: ["explicit_owner"]
    };
  };
  const appliedOwnerReviewCandidateIds = new Set<string>();
  const evaluated = normalizedCandidates.map((candidate) => {
    const reviewData = candidateReviewData.get(candidate.memory.id);
    const override = reviewData
      ? ownerReviewOverrideByCandidateId.get(reviewData.candidateId)
      : undefined;
    const ownerAttribution = (
      reviewData &&
      override &&
      override.evidenceDigest === reviewData.evidenceDigest
    )
      ? manualOwnerResolution(candidate, reviewData, override)
      : ownerAttributionByMemoryId.get(candidate.memory.id);
    if (reviewData && override && ownerAttribution?.owner.source === "manual_mapping") {
      appliedOwnerReviewCandidateIds.add(reviewData.candidateId);
    }
    return {
      ...candidate,
      ownerAttribution,
      decision: evaluateMemoryAdmission({
        ...candidate,
        ownerAttribution
      })
    };
  });
  const persisted = evaluated.filter((candidate) => candidate.decision.shouldPersist);
  const memories = persisted.map((candidate) => candidate.memory);
  const persistedAttributions = persisted.flatMap((candidate) =>
    candidate.ownerAttribution ? [candidate.ownerAttribution] : []
  );
  const ownerReviewDrafts = evaluated.flatMap((candidate): MemoryOwnerReviewDraft[] => {
    const reviewData = candidateReviewData.get(candidate.memory.id);
    if (!reviewData) return [];
    const contentDecision = evaluateMemoryAdmission({
      ...candidate,
      ownerAttribution: undefined
    });
    if (!contentDecision.shouldPersist || candidate.decision.shouldPersist) return [];
    return [{
      memory: candidate.memory,
      evidenceSegments: reviewData.evidenceSegments,
      providerLabels: reviewData.providerLabels,
      structuralGate: input.identityStructuralGate ?? {
        status: "degraded",
        reasons: ["identity_structural_gate_unavailable"]
      }
    }];
  });
  return {
    memories,
    ownerAttributions: persistedAttributions,
    ownerReviewDrafts,
    appliedOwnerReviewCandidateIds: [...appliedOwnerReviewCandidateIds].sort(),
    audit: {
      candidateCount: normalizedCandidates.length,
      persistedCount: memories.length,
      rejectedCount: normalizedCandidates.length - memories.length,
      decisions: evaluated.map((candidate) => candidate.decision),
      preferenceCandidates: evaluated.flatMap((candidate) => candidate.preferenceSourceSegmentIds ? [{
        memoryId: candidate.memory.id,
        sourceSegmentIds: candidate.preferenceSourceSegmentIds,
        identityHash: preferenceIdentityHash(candidate.preferenceIdentity!),
        normalizedValue: candidate.preferenceIdentity!.value,
        observationCount: candidate.preferenceSourceSegmentIds.length,
        persisted: candidate.decision.shouldPersist
      }] : []),
      relationshipSignals: evaluated.flatMap((candidate) => candidate.relationshipSignal ? [{
        signalId: candidate.relationshipSignal.id,
        signalType: candidate.relationshipSignal.signalType,
        memoryTier: candidate.decision.memoryTier,
        score: candidate.decision.score,
        reasons: candidate.decision.reasons,
        ...(candidate.lifecycleRelationTypes ? {
          lifecycleResolved: candidate.lifecycleResolved === true,
          lifecycleRelationTypes: candidate.lifecycleRelationTypes
        } : {})
      }] : []),
      ownerAttribution: auditMemoryOwnerAttributions(persistedAttributions, () => now)
    }
  };
}

export function extractUploadMemories(input: ExtractUploadMemoriesInput): MemoryWriteInput[] {
  return extractUploadMemoriesWithAudit(input).memories;
}
