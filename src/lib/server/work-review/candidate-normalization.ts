import { createHash } from "node:crypto";

import {
  WorkAtomicClaimSchema,
  WorkCanonicalSegmentsSchema,
  WorkExtractorCandidateDraftSchema,
  type WorkAtomicClaim,
  type WorkExtractorCandidateDraft
} from "@/lib/domain/work-review";
import type { WorkMeetingVerifierInput } from "./analysis-provider";

export type WorkWindowCandidateBatch = {
  windowIndex: number;
  candidates: WorkExtractorCandidateDraft[];
};

export type AssembledWorkMeetingCandidate = Omit<WorkExtractorCandidateDraft, "claims"> & {
  id: string;
  sourceWindowIndexes: number[];
  claims: WorkAtomicClaim[];
};

export const WORK_VERIFIER_MAX_CLAIMS_PER_BATCH = 256;

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

export function partitionWorkCandidatesForVerification(
  candidates: AssembledWorkMeetingCandidate[]
) {
  const batches: AssembledWorkMeetingCandidate[][] = [];
  let current: AssembledWorkMeetingCandidate[] = [];
  let claimCount = 0;
  for (const candidate of candidates) {
    if (candidate.claims.length > WORK_VERIFIER_MAX_CLAIMS_PER_BATCH) {
      throw new Error("work_verifier_candidate_claim_limit_exceeded");
    }
    if (current.length > 0
      && claimCount + candidate.claims.length > WORK_VERIFIER_MAX_CLAIMS_PER_BATCH) {
      batches.push(current);
      current = [];
      claimCount = 0;
    }
    current.push(candidate);
    claimCount += candidate.claims.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
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

function similarity(left: string, right: string) {
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

function attributionKey(candidate: WorkExtractorCandidateDraft) {
  const data = candidate.structuredData;
  return [
    data.rawActorLabel ?? "",
    data.candidateOwner ?? "",
    data.dueAt ?? "",
    data.originalDueExpression ?? "",
    data.actionBasis ?? "",
    data.decisionFinality ?? ""
  ].map(normalizedText).join("\u0000");
}

function canMerge(
  left: WorkExtractorCandidateDraft,
  right: WorkExtractorCandidateDraft
) {
  if (left.kind !== right.kind || attributionKey(left) !== attributionKey(right)) return false;
  if (!evidenceOverlap(left.evidenceIds, right.evidenceIds)) return false;
  const titleSimilarity = similarity(left.title, right.title);
  const bodySimilarity = similarity(left.body, right.body);
  return titleSimilarity >= 0.82 || bodySimilarity >= 0.82;
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
      const duplicate = accumulators.find((item) => canMerge(item.candidate, candidate));
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
    title: normalizedText(item.candidate.title),
    body: normalizedText(item.candidate.body),
    attribution: attributionKey(item.candidate),
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
    const claimGroups = new Map<string, typeof item.candidate.claims>();
    for (const claim of item.candidate.claims) {
      const key = [
        claim.claimType,
        normalizedText(claim.text),
        sortedUnique(claim.evidenceIds, evidenceOrder).join("\u0000")
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
      return WorkAtomicClaimSchema.parse({
        id: stableId("work_claim", {
          meetingId: input.meetingId,
          candidateId,
          claimType: first.claimType,
          text: normalizedText(first.text),
          evidenceIds: claimEvidenceIds
        }),
        candidateId,
        claimType: first.claimType,
        text: group.map((claim) => claim.text).reduce(preferredText),
        evidenceIds: claimEvidenceIds,
        createdAt: null
      });
    }).sort((left, right) => left.id.localeCompare(right.id));
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
  if (claims.some((claim) => claim.evidenceIds.some((id) => !allowedEvidence.has(id)))) {
    throw new Error("work_verifier_input_evidence_outside_canonical_publication");
  }
  return {
    accountId: input.accountId,
    meetingId: input.meetingId,
    publicationId: input.publicationId,
    canonicalDigest: input.canonicalDigest,
    segments,
    claims,
    timestampQualityBySegmentId: input.timestampQualityBySegmentId,
    signal: input.signal
  };
}
