import type { TranscriptChunk } from "@/lib/domain/chunks";
import {
  isChunkLocalSpeakerLabel,
  normalizeSpeakerIdentityLabel
} from "@/lib/domain/speaker-identity";
import {
  DEFAULT_SPEAKER_MATCH_MARGIN,
  DEFAULT_SPEAKER_MATCH_THRESHOLD,
  buildSpeakerIdentityCandidates,
  matchSpeakerIdentityCandidate,
  speakerIdentityCandidateKey,
  stableUnknownSpeakerId
} from "./matching";
import type {
  ResolveSpeakerIdentitiesInput,
  SpeakerIdentity,
  SpeakerIdentityAssignment,
  SpeakerIdentityAssignmentReason,
  SpeakerIdentityCandidate,
  SpeakerIdentityDirectMapping,
  ProviderLabelIdentityEvidence,
  SpeakerIdentityResolutionResult,
  SpeakerIdentitySource,
  VoiceprintIdentityHint
} from "./types";

type VerifiedProviderLabelHint = Extract<
  VoiceprintIdentityHint,
  { identityStatus: "verified" }
>;

type DirectPlan = {
  candidate: SpeakerIdentityCandidate;
  mapping: SpeakerIdentityDirectMapping | VerifiedProviderLabelHint;
  source: Extract<
    SpeakerIdentitySource,
    "manual_mapping" | "provider_speaker_result"
  >;
  confidence: number | null;
};

type RejectedDirectEvidence = {
  reason: Extract<
    SpeakerIdentityAssignmentReason,
    | "below_confidence_threshold"
    | "provider_not_verified"
    | "provider_label_review_required"
    | "ambiguous_match"
    | "same_chunk_identity_conflict"
  >;
  confidence: number | null;
  evidence?: ProviderLabelIdentityEvidence;
};

function policyValue(value: number | undefined, fallback: number, name: string) {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
  return resolved;
}

function mappingConfidence(mapping: SpeakerIdentityDirectMapping, fallback: number) {
  return policyValue(mapping.confidence, fallback, "speaker identity mapping confidence");
}

function validateMapping(mapping: SpeakerIdentityDirectMapping) {
  if (!mapping.chunkId.trim() || !mapping.localSpeaker.trim() || !mapping.globalSpeakerId.trim()) {
    throw new Error("Speaker identity mappings require chunkId, localSpeaker, and globalSpeakerId");
  }
}

function validateVoiceprintHint(mapping: VoiceprintIdentityHint) {
  if (!mapping.chunkId.trim() || !mapping.localSpeaker.trim()) {
    throw new Error("Provider-label evidence requires chunkId and localSpeaker");
  }
  if (
    mapping.evidence.type !== "provider_label" ||
    mapping.evidence.provider !== "company_voiceprint" ||
    normalizeSpeakerIdentityLabel(mapping.evidence.providerLabel) !==
      normalizeSpeakerIdentityLabel(mapping.localSpeaker)
  ) {
    throw new Error(
      "Provider-label evidence must contain the exact Provider speaker_result label"
    );
  }
  if (
    mapping.identityStatus === "verified" &&
    isChunkLocalSpeakerLabel(mapping.localSpeaker)
  ) {
    throw new Error(
      "Chunk-local speaker labels cannot be Provider-verified identities"
    );
  }
  if (
    mapping.identityStatus === "verified" &&
    (
      !mapping.globalSpeakerId.trim() ||
      (
        mapping.identityType !== "known_user" &&
        mapping.identityType !== "known_contact"
      )
    )
  ) {
    throw new Error(
      "Verified Provider-label evidence requires a known user or contact identity"
    );
  }
  if (
    mapping.identityStatus === "conflict" &&
    new Set(mapping.conflictingGlobalSpeakerIds.map((item) => item.trim()).filter(Boolean)).size < 2
  ) {
    throw new Error("Conflicting Provider-label evidence requires at least two identities");
  }
}

function bestMapping<T extends SpeakerIdentityDirectMapping>(mappings: T[]) {
  return [...mappings]
    .sort((left, right) => {
      const leftConfidence = mappingConfidence(left, 1);
      const rightConfidence = mappingConfidence(right, 1);
      return rightConfidence - leftConfidence || left.globalSpeakerId.localeCompare(right.globalSpeakerId);
    })[0];
}

function mappingsForCandidate<T extends { chunkId: string; localSpeaker: string }>(
  candidate: SpeakerIdentityCandidate,
  mappings: T[]
) {
  return mappings.filter(
    (mapping) =>
      mapping.chunkId === candidate.chunkId && mapping.localSpeaker === candidate.localSpeaker
  );
}

function directIdentity(plan: DirectPlan): SpeakerIdentity {
  if (plan.source === "provider_speaker_result") {
    const mapping = plan.mapping as VerifiedProviderLabelHint;
    return {
      globalSpeakerId: mapping.globalSpeakerId.trim(),
      ...(mapping.displayName?.trim()
        ? { displayName: mapping.displayName.trim() }
        : {}),
      identityType: mapping.identityType,
      confidence: null,
      source: "provider_speaker_result",
      evidence: { ...mapping.evidence }
    };
  }
  return {
    globalSpeakerId: plan.mapping.globalSpeakerId.trim(),
    ...(plan.mapping.displayName?.trim()
      ? { displayName: plan.mapping.displayName.trim() }
      : {}),
    identityType: plan.mapping.identityType ?? "known_contact",
    confidence: plan.confidence,
    source: plan.source
  };
}

function assignment(input: {
  candidate: SpeakerIdentityCandidate;
  identity: SpeakerIdentity;
  matched: boolean;
  reason: SpeakerIdentityAssignmentReason;
}): SpeakerIdentityAssignment {
  return {
    candidateKey: input.candidate.key,
    chunkId: input.candidate.chunkId,
    chunkIndex: input.candidate.chunkIndex,
    localSpeaker: input.candidate.localSpeaker,
    identity: input.identity,
    matched: input.matched,
    reason: input.reason,
    segmentCount: input.candidate.segmentCount
  };
}

function occupiedByChunk(assignments: Map<string, SpeakerIdentityAssignment>, chunkId: string) {
  return new Set(
    [...assignments.values()]
      .filter((item) => item.chunkId === chunkId)
      .map((item) => item.identity.globalSpeakerId)
  );
}

function buildResolvedChunks(
  chunks: TranscriptChunk[],
  assignments: Map<string, SpeakerIdentityAssignment>
): SpeakerIdentityResolutionResult["chunks"] {
  return chunks.map((chunk) => {
    const speakerMap = { ...chunk.speakerMap };
    const segments = chunk.segments.map((segment) => {
      if (!segment.speaker?.trim()) return { ...segment };
      const resolved = assignments.get(speakerIdentityCandidateKey(chunk.id, segment.speaker));
      if (!resolved) return { ...segment };
      speakerMap[segment.speaker] = resolved.identity.globalSpeakerId;
      return {
        ...segment,
        identity: { ...resolved.identity }
      };
    });

    return {
      ...chunk,
      speakerMap,
      segments
    };
  });
}

export async function resolveSpeakerIdentities(
  input: ResolveSpeakerIdentitiesInput
): Promise<SpeakerIdentityResolutionResult> {
  const threshold = policyValue(
    input.matchThreshold,
    DEFAULT_SPEAKER_MATCH_THRESHOLD,
    "speaker match threshold"
  );
  const margin = policyValue(
    input.matchMargin,
    DEFAULT_SPEAKER_MATCH_MARGIN,
    "speaker match margin"
  );
  const manualMappings = input.manualMappings ?? [];
  const voiceprintHints = input.voiceprintHints ?? [];
  const providerLabelTrust = input.providerLabelTrust ?? "review_required";
  manualMappings.forEach(validateMapping);
  voiceprintHints.forEach(validateVoiceprintHint);

  const candidates = buildSpeakerIdentityCandidates({
    uploadId: input.uploadId,
    chunks: input.chunks,
    matcherFeatures: input.matcherFeatures
  });
  const candidateOrder = new Map(candidates.map((candidate, index) => [candidate.key, index]));
  const assignments = new Map<string, SpeakerIdentityAssignment>();
  const rejectedDirectEvidence = new Map<string, RejectedDirectEvidence>();
  const comparisons: SpeakerIdentityResolutionResult["audit"]["comparisons"] = [];
  const directPlans: DirectPlan[] = [];

  for (const candidate of candidates) {
    const manual = bestMapping(mappingsForCandidate(candidate, manualMappings));
    if (manual) {
      directPlans.push({
        candidate,
        mapping: manual,
        source: "manual_mapping",
        confidence: mappingConfidence(manual, 1)
      });
      continue;
    }

    const candidateVoiceprintHints = mappingsForCandidate(candidate, voiceprintHints);
    if (candidateVoiceprintHints.some((hint) => hint.identityStatus === "conflict")) {
      const conflict = candidateVoiceprintHints.find(
        (hint) => hint.identityStatus === "conflict"
      )!;
      rejectedDirectEvidence.set(candidate.key, {
        reason: "ambiguous_match",
        confidence: null,
        evidence: { ...conflict.evidence }
      });
      continue;
    }
    const verifiedVoiceprintHints = candidateVoiceprintHints.filter(
      (hint): hint is VerifiedProviderLabelHint => hint.identityStatus === "verified"
    );
    const distinctVoiceprintIdentities = new Set(
      verifiedVoiceprintHints.map(
        (hint) => `${hint.globalSpeakerId.trim()}\u001f${hint.identityType}`
      )
    );
    if (distinctVoiceprintIdentities.size > 1) {
      rejectedDirectEvidence.set(candidate.key, {
        reason: "ambiguous_match",
        confidence: null,
        evidence: { ...verifiedVoiceprintHints[0].evidence }
      });
      continue;
    }
    const voiceprint = [...verifiedVoiceprintHints].sort(
      (left, right) => left.globalSpeakerId.localeCompare(right.globalSpeakerId, "en")
    )[0];
    if (!voiceprint) continue;
    if (providerLabelTrust !== "trusted_test_fixture") {
      rejectedDirectEvidence.set(candidate.key, {
        reason: "provider_label_review_required",
        confidence: null,
        evidence: { ...voiceprint.evidence }
      });
      continue;
    }
    directPlans.push({
      candidate,
      mapping: voiceprint,
      source: "provider_speaker_result",
      confidence: null
    });
  }

  const voiceprintPlansByChunkIdentity = new Map<string, DirectPlan[]>();
  for (const plan of directPlans) {
    if (plan.source !== "provider_speaker_result") continue;
    const key = `${plan.candidate.chunkId}\u001f${plan.mapping.globalSpeakerId.trim()}`;
    const plans = voiceprintPlansByChunkIdentity.get(key) ?? [];
    plans.push(plan);
    voiceprintPlansByChunkIdentity.set(key, plans);
  }
  const conflictingVoiceprintCandidateKeys = new Set<string>();
  for (const plans of voiceprintPlansByChunkIdentity.values()) {
    if (plans.length < 2) continue;
    for (const plan of plans) {
      conflictingVoiceprintCandidateKeys.add(plan.candidate.key);
      rejectedDirectEvidence.set(plan.candidate.key, {
        reason: "same_chunk_identity_conflict",
        confidence: plan.confidence,
        ...(plan.source === "provider_speaker_result"
          ? { evidence: { ...(plan.mapping as VerifiedProviderLabelHint).evidence } }
          : {})
      });
    }
  }

  directPlans.sort(
    (left, right) =>
      Number(right.source === "manual_mapping") - Number(left.source === "manual_mapping") ||
      (right.confidence ?? -1) - (left.confidence ?? -1) ||
      (candidateOrder.get(left.candidate.key) ?? 0) - (candidateOrder.get(right.candidate.key) ?? 0)
  );

  for (const plan of directPlans) {
    if (conflictingVoiceprintCandidateKeys.has(plan.candidate.key)) {
      continue;
    }
    const identity = directIdentity(plan);
    if (occupiedByChunk(assignments, plan.candidate.chunkId).has(identity.globalSpeakerId)) {
      rejectedDirectEvidence.set(plan.candidate.key, {
        reason: "same_chunk_identity_conflict",
        confidence: plan.confidence,
        ...(plan.source === "provider_speaker_result"
          ? { evidence: { ...(plan.mapping as VerifiedProviderLabelHint).evidence } }
          : {})
      });
      continue;
    }
    assignments.set(
      plan.candidate.key,
      assignment({
        candidate: plan.candidate,
        identity,
        matched: true,
        reason:
          plan.source === "manual_mapping"
            ? "manual_mapping"
            : "provider_label_match"
      })
    );
  }

  for (const candidate of candidates) {
    if (assignments.has(candidate.key)) continue;
    const rejectedDirect = rejectedDirectEvidence.get(candidate.key);
    if (
      rejectedDirect?.reason === "ambiguous_match" ||
      rejectedDirect?.reason === "same_chunk_identity_conflict"
    ) {
      assignments.set(
        candidate.key,
        assignment({
          candidate,
          identity: {
            globalSpeakerId: stableUnknownSpeakerId(candidate),
            identityType: "unknown_person",
            confidence: 0,
            source: "cross_chunk_matching",
            ...(rejectedDirect.evidence
              ? { evidence: { ...rejectedDirect.evidence } }
              : {})
          },
          matched: false,
          reason: rejectedDirect.reason
        })
      );
      continue;
    }
    if (rejectedDirect?.reason === "provider_label_review_required") {
      assignments.set(
        candidate.key,
        assignment({
          candidate,
          identity: {
            globalSpeakerId: stableUnknownSpeakerId(candidate),
            identityType: "unknown_person",
            confidence: null,
            source: "provider_speaker_result",
            evidence: { ...rejectedDirect.evidence! }
          },
          matched: false,
          reason: rejectedDirect.reason
        })
      );
      continue;
    }
    const match = await matchSpeakerIdentityCandidate({
      candidate,
      targets: candidates.flatMap((targetCandidate) => {
        const targetAssignment = assignments.get(targetCandidate.key);
        return targetAssignment ? [{ candidate: targetCandidate, assignment: targetAssignment }] : [];
      }),
      matcher: input.matcher,
      threshold,
      margin,
      occupiedGlobalSpeakerIds: occupiedByChunk(assignments, candidate.chunkId)
    });
    comparisons.push(...match.comparisons);

    if (match.matched && match.target) {
      const targetIdentity = match.target.assignment.identity;
      assignments.set(
        candidate.key,
        assignment({
          candidate,
          identity: {
            globalSpeakerId: targetIdentity.globalSpeakerId,
            ...(targetIdentity.displayName ? { displayName: targetIdentity.displayName } : {}),
            identityType: targetIdentity.identityType,
            confidence: match.confidence,
            source: "cross_chunk_matching"
          },
          matched: true,
          reason: "cross_chunk_match"
        })
      );
      continue;
    }

    const reason =
      rejectedDirect &&
      match.reason === "no_matching_evidence"
        ? rejectedDirect.reason
        : match.reason;
    assignments.set(
      candidate.key,
      assignment({
        candidate,
        identity: {
          globalSpeakerId: stableUnknownSpeakerId(candidate),
          identityType: "unknown_person",
          confidence: 0,
          source: "cross_chunk_matching"
        },
        matched: false,
        reason
      })
    );
  }

  const orderedAssignments = candidates.map((candidate) => assignments.get(candidate.key)!);
  const confidenceValues = orderedAssignments.flatMap((item) =>
    item.identity.identityType !== "unknown_person" &&
    typeof item.identity.confidence === "number"
      ? [item.identity.confidence]
      : []
  );
  const audit: SpeakerIdentityResolutionResult["audit"] = {
    version: 1,
    uploadId: input.uploadId,
    generatedAt: (input.now ?? (() => new Date().toISOString()))(),
    chunksProcessed: input.chunks.length,
    localSpeakerGroups: orderedAssignments.length,
    globalSpeakers: new Set(
      orderedAssignments.map((item) => item.identity.globalSpeakerId)
    ).size,
    matched: orderedAssignments.filter((item) => item.matched).length,
    unknown: orderedAssignments.filter(
      (item) => item.identity.identityType === "unknown_person"
    ).length,
    averageConfidence:
      confidenceValues.length > 0
        ? confidenceValues.reduce((total, value) => total + value, 0) /
          confidenceValues.length
        : null,
    conflicts: orderedAssignments.filter(
      (item) =>
        item.reason === "same_chunk_identity_conflict" ||
        item.reason === "ambiguous_match"
    ).length,
    assignments: orderedAssignments.map((item) => {
      const { displayName: _displayName, ...identity } = item.identity;
      return {
        ...item,
        identity
      };
    }),
    comparisons,
  };

  return {
    chunks: buildResolvedChunks(input.chunks, assignments),
    assignments: orderedAssignments.map((item) => ({
      ...item,
      identity: { ...item.identity }
    })),
    assignmentsByCandidateKey: Object.fromEntries(
      orderedAssignments.map((item) => [item.candidateKey, {
        ...item,
        identity: { ...item.identity }
      }])
    ),
    audit
  };
}
