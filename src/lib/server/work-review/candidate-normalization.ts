import { createHash } from "node:crypto";

import {
  WorkAtomicClaimSchema,
  WorkCanonicalSegmentsSchema,
  WorkExtractorCandidateDraftSchema,
  WorkMeetingCandidateStructuredDataSchema,
  type WorkAtomicClaim,
  type WorkExtractorCandidateDraft,
  type WorkVerifierClaimDraft
} from "@/lib/domain/work-review";
import type { TranscriptSegment } from "@/lib/domain/types";
import { buildWorkMeetingVerifierProviderPayload, materializeWorkEvidence, type WorkMeetingVerifierInput } from "./analysis-provider";
import type { WorkDuplicateCoverageRequest, WorkDuplicateCoverageEvaluation } from "./duplicate-coverage";
import { evaluateWorkCandidatePublication, isWorkOptionalAttributeClaim, requiresWorkClaimGptVerification } from "./publication-policy";

export type WorkWindowCandidateBatch = {
  windowIndex: number;
  candidates: WorkExtractorCandidateDraft[];
};

export type AssembledWorkMeetingCandidate = Omit<WorkExtractorCandidateDraft, "claims"> & {
  id: string;
  sourceWindowIndexes: number[];
  sourceDraftReferences?: Array<{ windowIndex: number; clientCandidateKey: string }>;
  claims: WorkAtomicClaim[];
};

export const WORK_MEETING_MAX_PRIMARY_REVIEW_ITEMS = 20;
export const WORK_VERIFIER_MAX_BATCHES = 3;
export const WORK_VERIFIER_MAX_CLAIMS_PER_BATCH = 24;
export const WORK_VERIFIER_MAX_PAYLOAD_CHARACTERS_PER_BATCH = 12_000;

const WORK_REVIEW_FALLBACK_LANE: Record<
  WorkExtractorCandidateDraft["kind"],
  number
> = {
  decision: 1,
  commitment: 0,
  action_item: 2,
  plan_change: 1,
  open_question: 2,
  proposal: 3,
  discussion_topic: 4
};

export class WorkMeetingAnalysisLimitError extends Error {
  constructor(public readonly code: "work_verifier_batch_budget_exceeded") {
    super(code);
    this.name = "WorkMeetingAnalysisLimitError";
  }
}

const WORK_MAIN_CLAIM_TYPE_BY_CANDIDATE_KIND: Record<
  WorkExtractorCandidateDraft["kind"],
  WorkAtomicClaim["claimType"]
> = {
  discussion_topic: "topic",
  proposal: "proposal",
  decision: "decision_existence",
  commitment: "commitment_existence",
  open_question: "open_question",
  plan_change: "plan_change",
  action_item: "action_item"
};

export function deriveCandidateCopyFromAtomicClaims(
  claims: AssembledWorkMeetingCandidate["claims"]
) {
  if (claims.length === 0) throw new Error("work_candidate_claims_required");
  const texts = [...new Set(claims.map((claim) => claim.text.trim()).filter(Boolean))];
  if (texts.length === 0) throw new Error("work_candidate_claim_text_required");
  return {
    title: texts[0],
    body: texts.join("；")
  };
}

export function deriveCandidateCopyFromPublication(input: {
  claims: AssembledWorkMeetingCandidate["claims"];
  displayClaimIds: string[];
  displayNotes: string[];
}) {
  const displayClaimIds = new Set(input.displayClaimIds);
  const retainedClaims = input.claims.filter((claim) => displayClaimIds.has(claim.id));
  // Suppressed Candidates remain persisted for audit. They are not user-visible,
  // but still need deterministic non-empty copy for the existing DB contract.
  const copy = deriveCandidateCopyFromAtomicClaims(
    retainedClaims.length > 0 ? retainedClaims : input.claims.slice(0, 1)
  );
  const notes = [...new Set(input.displayNotes.map((note) => note.trim()).filter(Boolean))];
  return {
    title: copy.title,
    body: [...new Set([copy.body, ...notes])].join("；")
  };
}

/** The same publication projection is used at runtime and when replaying the
 * audit. Only policy-generated display notes are separate from semantic copy;
 * text supplied by a model (including uncertainty) remains part of the facts. */
export function buildWorkCandidatePublicationProjection(input: {
  candidate: AssembledWorkMeetingCandidate;
  publicationId: string;
  segments: unknown[];
  timestampQualityBySegmentId?: Readonly<Record<string, unknown>>;
  evaluations: WorkVerifierClaimDraft[];
  verifierEnabled: boolean;
}) {
  const segments = WorkCanonicalSegmentsSchema.parse(input.segments);
  const evidenceFor = (evidenceIds: string[]) => materializeWorkEvidence({
    publicationId: input.publicationId, segments, evidenceIds,
    timestampQualityBySegmentId: input.timestampQualityBySegmentId
  });
  const speakerFor = (evidence: ReturnType<typeof evidenceFor>) => {
    const speakers = new Set(evidence.flatMap(e => e.rawSpeakerLabel ? [e.rawSpeakerLabel] : []));
    return speakers.size === 1 ? [...speakers][0] : null;
  };
  const candidate = input.candidate;
  const structuredData = WorkMeetingCandidateStructuredDataSchema.parse({
    ...candidate.structuredData,
    rawActorLabel: speakerFor(evidenceFor(candidate.evidenceIds)),
    planStages: candidate.structuredData.planStages.map(stage => {
      const evidence = evidenceFor(stage.evidenceIds);
      return {
        id: stage.clientStageKey,
        content: evidence.map(item => item.text).join("；").slice(0, 20_000),
        status: "unclear",
        rawSpeakerLabel: speakerFor(evidence),
        evidenceRefs: evidence.map(({ text: _text, ...reference }) => reference)
      };
    })
  });
  const policy = evaluateWorkCandidatePublication({
    kind: candidate.kind, structuredData, claims: candidate.claims,
    evaluations: input.evaluations, verifierEnabled: input.verifierEnabled, canonicalSegments: segments
  });
  const copyInput = { claims: candidate.claims, displayClaimIds: policy.displayClaimIds };
  return {
    policy,
    semanticCopy: deriveCandidateCopyFromPublication({ ...copyInput, displayNotes: [] }),
    renderedCopy: deriveCandidateCopyFromPublication({ ...copyInput, displayNotes: policy.displayNotes })
  };
}

export function estimateWorkVerifierEvidencePayloadCharacters(segment: TranscriptSegment) {
  return JSON.stringify({
    [segment.id]: {
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      rawSpeakerLabel: segment.speaker?.trim() || null,
      timestampQuality: "unknown",
      text: segment.text
    }
  }).length;
}

export function estimateWorkVerifierClaimPayloadCharacters(claim: WorkAtomicClaim) {
  return JSON.stringify({
    claimId: claim.id,
    candidateId: claim.candidateId,
    claimType: claim.claimType,
    semanticRiskFlags: claim.semanticRiskFlags ?? [],
    semanticValue: claim.semanticValue ?? null,
    text: claim.text,
    evidenceIds: claim.evidenceIds
  }).length + 1;
}

function estimateWorkVerifierBatchPayloadCharactersFromCanonical(input: {
  claims: WorkAtomicClaim[];
  segmentById: ReadonlyMap<string, TranscriptSegment>;
}) {
  const evidenceIds = new Set(input.claims.flatMap((claim) => claim.evidenceIds));
  // The fixed system prompt and JSON instruction are identical for every
  // request, so splitting cannot reduce them. The batch budget intentionally
  // covers the complete dynamic requestInput JSON sent to the Provider.
  return JSON.stringify({
    evidenceById: Object.fromEntries([...evidenceIds].map((id) => {
      const segment = input.segmentById.get(id)!;
      return [id, {
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        rawSpeakerLabel: segment.speaker?.trim() || null,
        timestampQuality: "unknown",
        text: segment.text
      }];
    })),
    items: input.claims.map((claim) => ({
      claimId: claim.id,
      candidateId: claim.candidateId,
      claimType: claim.claimType,
      semanticRiskFlags: claim.semanticRiskFlags ?? [],
      semanticValue: claim.semanticValue ?? null,
      text: claim.text,
      evidenceIds: claim.evidenceIds
    }))
  }).length;
}

export function estimateWorkVerifierBatchPayloadCharacters(input: {
  claims: WorkAtomicClaim[];
  segments: unknown[];
}) {
  const segments = WorkCanonicalSegmentsSchema.parse(input.segments);
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  if (input.claims.some((claim) => claim.evidenceIds.some((id) => !segmentById.has(id)))) {
    throw new Error("work_verifier_input_evidence_outside_canonical_publication");
  }
  return estimateWorkVerifierBatchPayloadCharactersFromCanonical({
    claims: input.claims,
    segmentById
  });
}

function boundedBatchInteger(input: {
  value: number | undefined;
  fallback: number;
  minimum: number;
  maximum: number;
  name: string;
}) {
  const value = input.value ?? input.fallback;
  if (!Number.isSafeInteger(value) || value < input.minimum || value > input.maximum) {
    throw new Error(`${input.name} must be an integer between ${input.minimum} and ${input.maximum}`);
  }
  return value;
}

function validateWorkVerificationSource(input: {
  candidates: AssembledWorkMeetingCandidate[];
  segments: unknown[];
}) {
  const segments = WorkCanonicalSegmentsSchema.parse(input.segments);
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  const sourceClaims = input.candidates.flatMap((candidate) => candidate.claims);
  if (new Set(sourceClaims.map((claim) => claim.id)).size !== sourceClaims.length) {
    throw new Error("work_verifier_claim_id_duplicate");
  }
  if (sourceClaims.some((claim) => claim.evidenceIds.some((id) => !segmentById.has(id)))) {
    throw new Error("work_verifier_input_evidence_outside_canonical_publication");
  }
  for (const candidate of input.candidates) {
    const candidateEvidence = new Set(candidate.evidenceIds);
    if (candidate.claims.some((claim) =>
      claim.evidenceIds.some((id) => !candidateEvidence.has(id))
    )) {
      throw new Error("work_verifier_input_candidate_evidence_closure_invalid");
    }
  }
  return { segments, segmentById, sourceClaims };
}

export function selectWorkCandidatesForGptVerification(input: {
  candidates: AssembledWorkMeetingCandidate[];
  segments: unknown[];
}) {
  validateWorkVerificationSource(input);
  return input.candidates.flatMap((candidate) => {
    const claims = candidate.claims.filter(requiresWorkClaimGptVerification);
    return claims.length === 0 ? [] : [{ ...candidate, claims }];
  });
}

export function partitionWorkCandidatesForVerification(input: {
  candidates: AssembledWorkMeetingCandidate[];
  segments: unknown[];
  maxClaimsPerBatch?: number;
  maxPayloadCharactersPerBatch?: number;
  maxBatches?: number;
}) {
  const maxClaimsPerBatch = boundedBatchInteger({
    value: input.maxClaimsPerBatch,
    fallback: WORK_VERIFIER_MAX_CLAIMS_PER_BATCH,
    minimum: 1,
    maximum: 256,
    name: "maxClaimsPerBatch"
  });
  const maxPayloadCharactersPerBatch = boundedBatchInteger({
    value: input.maxPayloadCharactersPerBatch,
    fallback: WORK_VERIFIER_MAX_PAYLOAD_CHARACTERS_PER_BATCH,
    minimum: 256,
    maximum: 1_000_000,
    name: "maxPayloadCharactersPerBatch"
  });
  const maxBatches = boundedBatchInteger({
    value: input.maxBatches,
    fallback: WORK_VERIFIER_MAX_BATCHES,
    minimum: 1,
    maximum: 256,
    name: "maxBatches"
  });
  const { segmentById, sourceClaims } = validateWorkVerificationSource(input);

  const batches: AssembledWorkMeetingCandidate[][] = [];
  let current: AssembledWorkMeetingCandidate[] = [];
  let currentClaims: WorkAtomicClaim[] = [];
  const flush = () => {
    if (current.length === 0) return;
    batches.push(current);
    current = [];
    currentClaims = [];
  };

  for (const candidate of input.candidates) {
    // Keep an ordinary item's core and attributes together. Oversized legacy
    // candidates still use the existing bounded Claim partition below.
    const candidateFits = candidate.claims.length <= maxClaimsPerBatch
      && estimateWorkVerifierBatchPayloadCharactersFromCanonical({ claims: candidate.claims, segmentById }) <= maxPayloadCharactersPerBatch;
    if (currentClaims.length > 0 && candidateFits && (
      currentClaims.length + candidate.claims.length > maxClaimsPerBatch
      || estimateWorkVerifierBatchPayloadCharactersFromCanonical({
        claims: [...currentClaims, ...candidate.claims], segmentById
      }) > maxPayloadCharactersPerBatch
    )) flush();
    for (const claim of candidate.claims) {
      const trialClaims = [...currentClaims, claim];
      if (
        currentClaims.length > 0
        && (
          trialClaims.length > maxClaimsPerBatch
          || estimateWorkVerifierBatchPayloadCharactersFromCanonical({
            claims: trialClaims,
            segmentById
          }) > maxPayloadCharactersPerBatch
        )
      ) {
        flush();
      }

      const lastCandidate = current.at(-1);
      if (lastCandidate?.id === candidate.id) {
        current[current.length - 1] = {
          ...lastCandidate,
          claims: [...lastCandidate.claims, claim]
        };
      } else {
        current.push({ ...candidate, claims: [claim] });
      }
      currentClaims.push(claim);
    }
  }
  flush();

  if (batches.length > maxBatches) {
    throw new WorkMeetingAnalysisLimitError("work_verifier_batch_budget_exceeded");
  }

  const partitionedClaimIds = batches.flatMap((batch) =>
    batch.flatMap((candidate) => candidate.claims.map((claim) => claim.id))
  );
  const sourceClaimIds = sourceClaims.map((claim) => claim.id);
  if (
    partitionedClaimIds.length !== sourceClaimIds.length
    || partitionedClaimIds.some((id, index) => id !== sourceClaimIds[index])
  ) {
    throw new Error("work_verifier_partition_claim_closure_invalid");
  }
  return batches;
}

/** Reserve required semantics before optional attributes consume bounded capacity. */
export function planWorkCandidatesForVerification(input: Parameters<typeof partitionWorkCandidatesForVerification>[0]) {
  const { segmentById, sourceClaims } = validateWorkVerificationSource(input);
  const maxClaims = input.maxClaimsPerBatch ?? WORK_VERIFIER_MAX_CLAIMS_PER_BATCH;
  const maxCharacters = input.maxPayloadCharactersPerBatch ?? WORK_VERIFIER_MAX_PAYLOAD_CHARACTERS_PER_BATCH;
  const maxBatches = input.maxBatches ?? WORK_VERIFIER_MAX_BATCHES;
  const fits = (claims: WorkAtomicClaim[]) => claims.length <= maxClaims
    && estimateWorkVerifierBatchPayloadCharactersFromCanonical({ claims, segmentById }) <= maxCharacters;
  try {
    const batches = partitionWorkCandidatesForVerification(input);
    if (batches.every(batch => fits(batch.flatMap(c => c.claims)))) return { batches, deferredClaimIds: [] as string[] };
  } catch (error) {
    if (!(error instanceof WorkMeetingAnalysisLimitError)) throw error;
  }
  const required = input.candidates.flatMap(candidate => {
    const claims = candidate.claims.filter(claim => !isWorkOptionalAttributeClaim(claim));
    return claims.length ? [{ ...candidate, claims }] : [];
  });
  const batches = partitionWorkCandidatesForVerification({ ...input, candidates: required });
  // Preserve the existing required-Claim contract, including a single
  // oversized Claim in its own batch. Never add optional payload to it.
  const deferredClaimIds: string[] = [];
  for (const candidate of input.candidates) for (const claim of candidate.claims.filter(isWorkOptionalAttributeClaim)) {
    // Try the item's core batch first, then existing spare capacity, then a
    // spare batch. Required Claims never move or disappear to make room.
    const indexes = batches.map((batch, index) => ({ index, sameItem: batch.some(c => c.id === candidate.id) }))
      .sort((a, b) => Number(b.sameItem) - Number(a.sameItem) || a.index - b.index).map(row => row.index);
    const index = indexes.find(index => fits([...batches[index].flatMap(c => c.claims), claim]));
    if (index !== undefined) {
      const existing = batches[index].findIndex(c => c.id === candidate.id);
      if (existing < 0) batches[index].push({ ...candidate, claims: [claim] });
      else batches[index][existing] = { ...batches[index][existing], claims: [...batches[index][existing].claims, claim] };
    } else if (batches.length < maxBatches && fits([claim])) {
      batches.push([{ ...candidate, claims: [claim] }]);
    } else deferredClaimIds.push(claim.id);
  }
  const routed = batches.flatMap(batch => batch.flatMap(c => c.claims.map(claim => claim.id)));
  const accounted = [...routed, ...deferredClaimIds];
  if (new Set(accounted).size !== sourceClaims.length || accounted.length !== sourceClaims.length
    || sourceClaims.some(claim => !accounted.includes(claim.id))) throw new Error("work_verifier_partition_claim_closure_invalid");
  return { batches, deferredClaimIds };
}

function stableId(prefix: string, value: unknown) {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function normalizedText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{S}\s]+/gu, "")
    .trim();
}

function shingles(value: string) {
  const normalized = normalizedText(value);
  if (normalized.length < 2) return new Set(normalized ? [normalized] : []);
  return new Set(Array.from({ length: normalized.length - 1 }, (_, index) =>
    normalized.slice(index, index + 2)
  ));
}

function similarity(left: string, right: string, allowContainment = true) {
  const normalizedLeft = normalizedText(left);
  const normalizedRight = normalizedText(right);
  if (normalizedLeft === normalizedRight) return normalizedLeft ? 1 : 0;
  if (
    allowContainment && Math.min(normalizedLeft.length, normalizedRight.length) >= 4
    && (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft))
  ) {
    return 0.92;
  }
  const leftSet = shingles(left);
  const rightSet = shingles(right);
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  let intersection = 0;
  for (const item of leftSet) {
    if (rightSet.has(item)) intersection += 1;
  }
  return intersection / (leftSet.size + rightSet.size - intersection);
}

function evidenceOverlap(left: string[], right: string[]) {
  const rightSet = new Set(right);
  return left.some((id) => rightSet.has(id));
}

function coreTexts(candidate: WorkExtractorCandidateDraft | AssembledWorkMeetingCandidate) {
  const mainClaimType = WORK_MAIN_CLAIM_TYPE_BY_CANDIDATE_KIND[candidate.kind];
  const claimTexts = candidate.claims
    .filter((claim) => claim.claimType === mainClaimType)
    .map((claim) => claim.text);
  const sourceTexts = claimTexts.length > 0 ? claimTexts : [candidate.title];
  return [...new Set(sourceTexts.map(normalizedText).filter(Boolean))].sort();
}

function coreSimilarity(
  left: WorkExtractorCandidateDraft | AssembledWorkMeetingCandidate,
  right: WorkExtractorCandidateDraft | AssembledWorkMeetingCandidate
) {
  return Math.max(...coreTexts(left).flatMap((leftText) =>
    coreTexts(right).map((rightText) => similarity(leftText, rightText,
      left.kind !== "commitment" && left.kind !== "action_item"))
  ));
}

function evidenceDistance(
  left: string[],
  right: string[],
  evidenceOrder: ReadonlyMap<string, number>
) {
  let distance = Number.POSITIVE_INFINITY;
  for (const leftId of left) {
    for (const rightId of right) {
      const leftIndex = evidenceOrder.get(leftId);
      const rightIndex = evidenceOrder.get(rightId);
      if (leftIndex === undefined || rightIndex === undefined) continue;
      distance = Math.min(distance, Math.abs(leftIndex - rightIndex));
    }
  }
  return distance;
}

function canMerge(
  left: WorkExtractorCandidateDraft,
  right: WorkExtractorCandidateDraft,
  evidenceOrder: ReadonlyMap<string, number>
) {
  if (left.kind !== right.kind) return false;
  // For tasks, lexical similarity is not proof of the same deliverable. The
  // single global organizer can propose semantic groups for later verification.
  if (left.kind === "commitment" || left.kind === "action_item") {
    if (JSON.stringify(coreTexts(left)) !== JSON.stringify(coreTexts(right))) return false;
    if (left.structuredData.candidateOwner && right.structuredData.candidateOwner
      && normalizedText(left.structuredData.candidateOwner) !== normalizedText(right.structuredData.candidateOwner)) return false;
  }
  const bestSimilarity = coreSimilarity(left, right);
  if (evidenceOverlap(left.evidenceIds, right.evidenceIds)) {
    return bestSimilarity >= 0.62;
  }
  const distance = evidenceDistance(left.evidenceIds, right.evidenceIds, evidenceOrder);
  if (left.kind === "discussion_topic") {
    return distance <= 12 && bestSimilarity >= 0.65;
  }
  if (left.kind === "proposal" || left.kind === "open_question") {
    return distance <= 12 && bestSimilarity >= 0.68;
  }
  return distance <= 8 && bestSimilarity >= 0.9;
}

function mergeOptionalValue<Value extends string>(left: Value | null, right: Value | null) {
  if (left === null) return right;
  if (right === null) return left;
  return normalizedText(left) === normalizedText(right) ? left : null;
}

function mergeDecisionFinality(
  left: WorkExtractorCandidateDraft["structuredData"]["decisionFinality"],
  right: WorkExtractorCandidateDraft["structuredData"]["decisionFinality"]
) {
  if (left === null) return right;
  if (right === null) return left;
  return left === right ? left : "unclear";
}

function mergeDeadline(input: {
  leftDueAt: string | null;
  rightDueAt: string | null;
  leftExpression: string | null;
  rightExpression: string | null;
}) {
  const dueAt = mergeOptionalValue(input.leftDueAt, input.rightDueAt);
  if (input.leftDueAt !== null && input.rightDueAt !== null && dueAt === null) {
    return { dueAt: null, originalDueExpression: null };
  }
  return {
    dueAt,
    originalDueExpression: mergeOptionalValue(input.leftExpression, input.rightExpression)
  };
}

function preferredText(left: string, right: string) {
  return [left, right].sort((a, b) =>
    b.length - a.length || a.localeCompare(b, "zh-CN")
  )[0];
}

function sortedUnique(ids: string[], evidenceOrder: Map<string, number>) {
  return [...new Set(ids)].sort((left, right) =>
    (evidenceOrder.get(left) ?? Number.MAX_SAFE_INTEGER)
    - (evidenceOrder.get(right) ?? Number.MAX_SAFE_INTEGER)
    || left.localeCompare(right)
  );
}

function mergePlanStages(input: {
  meetingId: string;
  stages: WorkExtractorCandidateDraft["structuredData"]["planStages"];
  evidenceOrder: Map<string, number>;
}) {
  const grouped = new Map<string, typeof input.stages[number]>();
  for (const stage of input.stages) {
    const key = [
      normalizedText(stage.content),
      stage.status,
      normalizedText(stage.rawSpeakerLabel ?? "")
    ].join("\u0000");
    const existing = grouped.get(key);
    const evidenceIds = sortedUnique([
      ...(existing?.evidenceIds ?? []),
      ...stage.evidenceIds
    ], input.evidenceOrder);
    grouped.set(key, {
      ...stage,
      clientStageKey: stableId("work_stage", {
        meetingId: input.meetingId,
        content: normalizedText(stage.content),
        status: stage.status,
        rawSpeakerLabel: normalizedText(stage.rawSpeakerLabel ?? ""),
        evidenceIds
      }),
      evidenceIds
    });
  }
  return [...grouped.values()].sort((left, right) =>
    (input.evidenceOrder.get(left.evidenceIds[0]) ?? Number.MAX_SAFE_INTEGER)
    - (input.evidenceOrder.get(right.evidenceIds[0]) ?? Number.MAX_SAFE_INTEGER)
    || left.clientStageKey.localeCompare(right.clientStageKey)
  );
}

type CandidateAccumulator = {
  candidate: WorkExtractorCandidateDraft;
  sourceWindowIndexes: number[];
  sourceReferences: Array<{ windowIndex: number; clientCandidateKey: string }>;
  relatedCommitmentReferences: Array<{ windowIndex: number; clientCandidateKey: string }>;
};

function windowCandidateKey(windowIndex: number, clientCandidateKey: string) {
  return `${windowIndex}\u0000${clientCandidateKey}`;
}

export function assembleWorkMeetingCandidates(input: {
  accountId: string;
  meetingId: string;
  publicationId: string;
  canonicalDigest: string;
  segments: unknown[];
  batches: WorkWindowCandidateBatch[];
}): AssembledWorkMeetingCandidate[] {
  const segments = WorkCanonicalSegmentsSchema.parse(input.segments);
  const evidenceOrder = new Map(segments.map((segment, index) => [segment.id, index]));
  const allowedEvidence = new Set(evidenceOrder.keys());
  const normalizedBatches = [...input.batches].sort((left, right) => left.windowIndex - right.windowIndex);
  const accumulators: CandidateAccumulator[] = [];
  for (const batch of normalizedBatches) {
    for (const rawCandidate of batch.candidates) {
      const candidate = WorkExtractorCandidateDraftSchema.parse(rawCandidate);
      const allEvidenceIds = [
        ...candidate.evidenceIds,
        ...candidate.claims.flatMap((claim) => claim.evidenceIds),
        ...candidate.structuredData.planStages.flatMap((stage) => stage.evidenceIds)
      ];
      if (allEvidenceIds.some((id) => !allowedEvidence.has(id))) {
        throw new Error("work_candidate_evidence_outside_canonical_publication");
      }
      const candidateEvidence = new Set(candidate.evidenceIds);
      if (candidate.claims.some((claim) =>
        claim.evidenceIds.some((id) => !candidateEvidence.has(id))
      ) || candidate.structuredData.planStages.some((stage) =>
        stage.evidenceIds.some((id) => !candidateEvidence.has(id))
      )) {
        throw new Error("work_candidate_evidence_closure_invalid");
      }
      const relatedCommitmentReference = candidate.structuredData.relatedCommitmentCandidateId
        ? [{
            windowIndex: batch.windowIndex,
            clientCandidateKey: candidate.structuredData.relatedCommitmentCandidateId
          }]
        : [];
      const duplicate = accumulators.find((item) =>
        canMerge(item.candidate, candidate, evidenceOrder)
      );
      if (!duplicate) {
        accumulators.push({
          candidate,
          sourceWindowIndexes: [batch.windowIndex],
          sourceReferences: [{
            windowIndex: batch.windowIndex,
            clientCandidateKey: candidate.clientCandidateKey
          }],
          relatedCommitmentReferences: relatedCommitmentReference
        });
        continue;
      }
      duplicate.sourceWindowIndexes.push(batch.windowIndex);
      duplicate.sourceReferences.push({
        windowIndex: batch.windowIndex,
        clientCandidateKey: candidate.clientCandidateKey
      });
      duplicate.relatedCommitmentReferences.push(...relatedCommitmentReference);
      const mergedDeadline = mergeDeadline({
        leftDueAt: duplicate.candidate.structuredData.dueAt,
        rightDueAt: candidate.structuredData.dueAt,
        leftExpression: duplicate.candidate.structuredData.originalDueExpression,
        rightExpression: candidate.structuredData.originalDueExpression
      });
      duplicate.candidate = {
        ...duplicate.candidate,
        title: preferredText(duplicate.candidate.title, candidate.title),
        body: preferredText(duplicate.candidate.body, candidate.body),
        evidenceIds: sortedUnique([
          ...duplicate.candidate.evidenceIds,
          ...candidate.evidenceIds
        ], evidenceOrder),
        claims: [...duplicate.candidate.claims, ...candidate.claims],
        structuredData: {
          ...duplicate.candidate.structuredData,
          decisionFinality: mergeDecisionFinality(
            duplicate.candidate.structuredData.decisionFinality,
            candidate.structuredData.decisionFinality
          ),
          rawActorLabel: mergeOptionalValue(
            duplicate.candidate.structuredData.rawActorLabel,
            candidate.structuredData.rawActorLabel
          ),
          candidateOwner: mergeOptionalValue(
            duplicate.candidate.structuredData.candidateOwner,
            candidate.structuredData.candidateOwner
          ),
          dueAt: mergedDeadline.dueAt,
          originalDueExpression: mergedDeadline.originalDueExpression,
          actionBasis: mergeOptionalValue(
            duplicate.candidate.structuredData.actionBasis,
            candidate.structuredData.actionBasis
          ),
          planStages: [
            ...duplicate.candidate.structuredData.planStages,
            ...candidate.structuredData.planStages
          ]
        }
      };
    }
  }

  const stableCandidateIds = accumulators.map((item) => stableId("work_candidate", {
    accountId: input.accountId,
    meetingId: input.meetingId,
    publicationId: input.publicationId,
    canonicalDigest: input.canonicalDigest,
    kind: item.candidate.kind,
    coreTexts: coreTexts(item.candidate),
    evidenceIds: sortedUnique(item.candidate.evidenceIds, evidenceOrder)
  }));
  const stableCandidateByWindowKey = new Map<string, {
    id: string;
    kind: WorkExtractorCandidateDraft["kind"];
  }>();
  accumulators.forEach((item, index) => {
    for (const reference of item.sourceReferences) {
      stableCandidateByWindowKey.set(
        windowCandidateKey(reference.windowIndex, reference.clientCandidateKey),
        { id: stableCandidateIds[index], kind: item.candidate.kind }
      );
    }
  });

  return accumulators.map((item, index) => {
    const candidateId = stableCandidateIds[index];
    const evidenceIds = sortedUnique(item.candidate.evidenceIds, evidenceOrder);
    const mainClaimType = WORK_MAIN_CLAIM_TYPE_BY_CANDIDATE_KIND[item.candidate.kind];
    const claimGroups = new Map<string, typeof item.candidate.claims>();
    for (const claim of item.candidate.claims) {
      const key = claim.claimType === mainClaimType
        ? ["core", claim.claimType].join("\u0000")
        : [
            claim.claimType,
            JSON.stringify(claim.semanticValue ?? null),
            normalizedText(claim.text)
          ].join("\u0000");
      const group = claimGroups.get(key) ?? [];
      group.push(claim);
      claimGroups.set(key, group);
    }
    const claims = [...claimGroups.values()].map((group) => {
      const first = group[0];
      const claimEvidenceIds = sortedUnique(
        group.flatMap((claim) => claim.evidenceIds),
        evidenceOrder
      );
      const semanticRiskFlags = [...new Set(
        group.flatMap((claim) => claim.semanticRiskFlags ?? [])
      )].sort();
      // Similarity is only a grouping hint. A longer paraphrase can omit a
      // shorter condition/state, so preserve every distinct core for Verifier.
      const text = first.claimType === mainClaimType
        ? [...new Set(group.map(claim => claim.text.trim()))].join("；")
        : group.map(claim => claim.text).reduce(preferredText);
      return WorkAtomicClaimSchema.parse({
        id: stableId("work_claim", {
          meetingId: input.meetingId,
          candidateId,
          claimType: first.claimType,
          ...(semanticRiskFlags.length > 0 ? { semanticRiskFlags } : {}),
          ...(first.semanticValue ? { semanticValue: first.semanticValue } : {}),
          text: normalizedText(text),
          evidenceIds: claimEvidenceIds
        }),
        candidateId,
        claimType: first.claimType,
        semanticRiskFlags,
        ...(first.semanticValue ? { semanticValue: first.semanticValue } : {}),
        text,
        evidenceIds: claimEvidenceIds,
        createdAt: null
      });
    }).sort((left, right) =>
      Number(right.claimType === mainClaimType) - Number(left.claimType === mainClaimType)
      || left.claimType.localeCompare(right.claimType)
      || left.id.localeCompare(right.id)
    );
    const relatedCommitmentIds = new Set(item.relatedCommitmentReferences.flatMap((reference) => {
      const related = stableCandidateByWindowKey.get(
        windowCandidateKey(reference.windowIndex, reference.clientCandidateKey)
      );
      return related?.kind === "commitment" ? [related.id] : [];
    }));
    const relatedCommitmentCandidateId = relatedCommitmentIds.size === 1
      ? [...relatedCommitmentIds][0]
      : null;
    return {
      ...item.candidate,
      id: candidateId,
      sourceDraftReferences: item.sourceReferences,
      evidenceIds,
      structuredData: {
        ...item.candidate.structuredData,
        relatedCommitmentCandidateId,
        planStages: mergePlanStages({
          meetingId: input.meetingId,
          stages: item.candidate.structuredData.planStages,
          evidenceOrder
        })
      },
      sourceWindowIndexes: [...new Set(item.sourceWindowIndexes)].sort((a, b) => a - b),
      claims
    };
  }).sort((left, right) =>
    (evidenceOrder.get(left.evidenceIds[0]) ?? Number.MAX_SAFE_INTEGER)
    - (evidenceOrder.get(right.evidenceIds[0]) ?? Number.MAX_SAFE_INTEGER)
    || left.id.localeCompare(right.id)
  );
}

/** Retrieve possible resolutions, never decide resolution by lexical overlap.
 * The existing Verifier must judge the hypothesis against both Canonical sides.
 */
export function attachWorkQuestionResolutionClaims(input: {
  candidates: AssembledWorkMeetingCandidate[];
  segments: unknown[];
}): AssembledWorkMeetingCandidate[] {
  const { segments } = validateWorkVerificationSource(input);
  const evidenceOrder = new Map(segments.map((segment, index) => [segment.id, index]));
  const lastEvidenceIndex = (candidate: AssembledWorkMeetingCandidate) =>
    Math.max(...candidate.evidenceIds.map((id) => evidenceOrder.get(id)!));
  return input.candidates.map((question) => {
    if (question.kind !== "open_question"
      || question.claims.some((claim) => claim.claimType === "question_resolution")) return question;
    const questionIndex = lastEvidenceIndex(question);
    const relatedLater = input.candidates.filter((candidate) =>
      candidate.id !== question.id
      && lastEvidenceIndex(candidate) > questionIndex
      && coreSimilarity(question, candidate) >= 0.12
    );
    if (!relatedLater.some((candidate) => candidate.kind === "decision")) return question;
    const evidenceIds = sortedUnique([
      ...question.evidenceIds,
      ...relatedLater.flatMap((candidate) => candidate.evidenceIds)
    ], evidenceOrder);
    // Do not truncate a potentially contradictory later result to fit a Claim.
    if (evidenceIds.length > 64) return question;
    const text = `会议后续已明确解决以下问题：${question.claims
      .filter((claim) => claim.claimType === "open_question")
      .map((claim) => claim.text).join("；")}`;
    const resolution = WorkAtomicClaimSchema.parse({
      id: stableId("work_claim", { candidateId: question.id,
        claimType: "question_resolution", text, evidenceIds }),
      candidateId: question.id,
      claimType: "question_resolution",
      semanticRiskFlags: [],
      semanticValue: null,
      text,
      evidenceIds,
      createdAt: null
    });
    return { ...question, evidenceIds, claims: [...question.claims, resolution] };
  });
}

export function partitionWorkMeetingCandidateReviewCapacity<
  Candidate extends Pick<AssembledWorkMeetingCandidate, "id" | "kind">
>(
  candidates: Candidate[],
  maximum = WORK_MEETING_MAX_PRIMARY_REVIEW_ITEMS,
  priorityIds: readonly string[] = []
) {
  const boundedMaximum = boundedBatchInteger({
    value: maximum,
    fallback: WORK_MEETING_MAX_PRIMARY_REVIEW_ITEMS,
    minimum: 1,
    maximum: 256,
    name: "maximumCandidates"
  });
  // Fallback alternates deliveries, decisions and unresolved follow-ups; no
  // kind can exhaust all slots merely by appearing first in the transcript.
  const lanes = Array.from({ length: 5 }, (_, lane) => candidates.filter(candidate =>
    WORK_REVIEW_FALLBACK_LANE[candidate.kind] === lane));
  const hasDeliveryDate = (candidate: Candidate) => {
    const value = candidate as Candidate & { structuredData?: { originalDueExpression?: string | null }; claims?: Array<{ claimType: string }> };
    return Boolean(value.structuredData?.originalDueExpression || value.claims?.some(claim => claim.claimType === "deadline"));
  };
  lanes[0].sort((left, right) => Number(hasDeliveryDate(right)) - Number(hasDeliveryDate(left)));
  const fallback: Candidate[] = [];
  while (lanes.slice(0, 3).some(lane => lane.length)) {
    for (const lane of lanes.slice(0, 3)) if (lane.length) fallback.push(lane.shift()!);
  }
  fallback.push(...lanes[3], ...lanes[4]);
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const promoted = [...new Set(priorityIds)].flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
  const promotedIds = new Set(promoted.map(candidate => candidate.id));
  // A rejected deletion can restore an item omitted from the AI's ranking.
  // Mixing a prefix with omissions would silently force those items to the end.
  const missingPriorityIds = candidates.filter(c => !promotedIds.has(c.id)).map(c => c.id);
  const completePriority = missingPriorityIds.length === 0 && promoted.length === candidates.length;
  const prioritized = completePriority ? promoted : fallback;
  return {
    primaryCandidates: prioritized.slice(0, boundedMaximum),
    overflowCandidates: prioritized.slice(boundedMaximum),
    priorityIds: prioritized.map(c => c.id),
    ranking: { strategy: completePriority ? "ai_complete" as const : "full_fallback" as const, missingPriorityIds }
  };
}

/**
 * Compatibility wrapper for callers that only persist the primary review set.
 * Capacity overflow is intentionally non-fatal; callers that need audit counts
 * should use partitionWorkMeetingCandidateReviewCapacity directly.
 */
export function assertWorkMeetingCandidateReviewBudget(
  candidates: AssembledWorkMeetingCandidate[],
  maximum = WORK_MEETING_MAX_PRIMARY_REVIEW_ITEMS
) {
  return partitionWorkMeetingCandidateReviewCapacity(candidates, maximum).primaryCandidates;
}

export function buildWorkMeetingVerifierInput(input: {
  accountId: string;
  meetingId: string;
  publicationId: string;
  canonicalDigest: string;
  segments: unknown[];
  candidates: AssembledWorkMeetingCandidate[];
  timestampQualityBySegmentId?: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}): WorkMeetingVerifierInput {
  const segments = WorkCanonicalSegmentsSchema.parse(input.segments);
  const allowedEvidence = new Set(segments.map((segment) => segment.id));
  const claims = input.candidates.flatMap((candidate) => candidate.claims);
  if (new Set(claims.map((claim) => claim.id)).size !== claims.length) {
    throw new Error("work_verifier_claim_id_duplicate");
  }
  if (claims.some((claim) => claim.evidenceIds.some((id) => !allowedEvidence.has(id)))) {
    throw new Error("work_verifier_input_evidence_outside_canonical_publication");
  }
  const selectedEvidenceIds = new Set(claims.flatMap((claim) => claim.evidenceIds));
  const selectedSegments = segments.filter((segment) => selectedEvidenceIds.has(segment.id));
  const timestampQualityBySegmentId = input.timestampQualityBySegmentId
    ? Object.fromEntries(selectedSegments.flatMap((segment) =>
        Object.hasOwn(input.timestampQualityBySegmentId!, segment.id)
          ? [[segment.id, input.timestampQualityBySegmentId![segment.id]]]
          : []
      ))
    : undefined;
  return {
    accountId: input.accountId,
    meetingId: input.meetingId,
    publicationId: input.publicationId,
    canonicalDigest: input.canonicalDigest,
    segments: selectedSegments,
    claims,
    timestampQualityBySegmentId,
    signal: input.signal
  };
}

/** Fit optional coverage behind required Claims inside the existing 3-batch
 * and 24-result/12k-character limits. Unaffordable relations retain originals. */
export function packWorkDuplicateCoverageForVerification(input: {
  base: Omit<WorkMeetingVerifierInput, "claims" | "duplicateCoverage">;
  batches: AssembledWorkMeetingCandidate[][];
  requests: WorkDuplicateCoverageRequest[];
  maxBatches?: number;
}) {
  const inputs = input.batches.map(candidates => buildWorkMeetingVerifierInput({ ...input.base, candidates }));
  const canonical = WorkCanonicalSegmentsSchema.parse(input.base.segments);
  const unchecked: WorkDuplicateCoverageEvaluation[] = [];
  const maxBatches = Math.min(WORK_VERIFIER_MAX_BATCHES, input.maxBatches ?? WORK_VERIFIER_MAX_BATCHES);
  for (const relation of input.requests) {
    let placed = false;
    for (let i = 0; i < inputs.length + Number(inputs.length < maxBatches); i++) {
      const current = inputs[i] ?? buildWorkMeetingVerifierInput({ ...input.base, candidates: [] });
      const duplicateCoverage = [...(current.duplicateCoverage ?? []), relation];
      if (current.claims.length + duplicateCoverage.length > WORK_VERIFIER_MAX_CLAIMS_PER_BATCH) continue;
      const evidenceIds = new Set([...current.claims.flatMap(c => c.evidenceIds),
        ...duplicateCoverage.flatMap(r => [r.original, ...r.coveredBy].flatMap(s => s.evidenceIds))]);
      const trial = { ...current, duplicateCoverage, segments: canonical.filter(s => evidenceIds.has(s.id)) };
      if (JSON.stringify(buildWorkMeetingVerifierProviderPayload(trial)).length > WORK_VERIFIER_MAX_PAYLOAD_CHARACTERS_PER_BATCH) continue;
      inputs[i] = trial; placed = true; break;
    }
    if (!placed) unchecked.push({ relationId: relation.relationId, verdict: "uncertain", reason: "capacity", supportedEvidenceIds: [] });
  }
  return { inputs, unchecked };
}
