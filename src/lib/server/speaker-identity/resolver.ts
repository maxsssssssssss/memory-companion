import type { TranscriptChunk } from "@/lib/domain/chunks";
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
  SpeakerIdentityResolutionResult,
  SpeakerIdentitySource,
  VoiceprintIdentityHint
} from "./types";

type DirectPlan = {
  candidate: SpeakerIdentityCandidate;
  mapping: SpeakerIdentityDirectMapping | VoiceprintIdentityHint;
  source: Extract<SpeakerIdentitySource, "manual_mapping" | "voiceprint">;
  confidence: number;
};

type RejectedDirectEvidence = {
  reason: Extract<
    SpeakerIdentityAssignmentReason,
    "below_confidence_threshold" | "ambiguous_match" | "same_chunk_identity_conflict"
  >;
  confidence: number;
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
  validateMapping(mapping);
  if (
    mapping.identityType !== "known_user" &&
    mapping.identityType !== "known_contact"
  ) {
    throw new Error(
      "Voiceprint identity hints require an explicit known_user or known_contact identity type"
    );
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

function mappingsForCandidate<T extends SpeakerIdentityDirectMapping>(
  candidate: SpeakerIdentityCandidate,
  mappings: T[]
) {
  return mappings.filter(
    (mapping) =>
      mapping.chunkId === candidate.chunkId && mapping.localSpeaker === candidate.localSpeaker
  );
}

function directIdentity(plan: DirectPlan): SpeakerIdentity {
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
  const voiceprintThreshold = policyValue(
    input.voiceprintThreshold,
    threshold,
    "voiceprint threshold"
  );
  const manualMappings = input.manualMappings ?? [];
  const voiceprintHints = input.voiceprintHints ?? [];
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
    const distinctVoiceprintIdentities = new Set(
      candidateVoiceprintHints.map(
        (hint) => `${hint.globalSpeakerId.trim()}\u001f${hint.identityType}`
      )
    );
    if (distinctVoiceprintIdentities.size > 1) {
      rejectedDirectEvidence.set(candidate.key, {
        reason: "ambiguous_match",
        confidence: Math.max(
          0,
          ...candidateVoiceprintHints.map((hint) => mappingConfidence(hint, 0))
        )
      });
      continue;
    }
    const voiceprint = bestMapping(candidateVoiceprintHints);
    if (!voiceprint) continue;
    const confidence = mappingConfidence(voiceprint, 0);
    if (confidence < voiceprintThreshold) {
      rejectedDirectEvidence.set(candidate.key, {
        reason: "below_confidence_threshold",
        confidence
      });
      continue;
    }
    directPlans.push({
      candidate,
      mapping: voiceprint,
      source: "voiceprint",
      confidence
    });
  }

  const voiceprintPlansByChunkIdentity = new Map<string, DirectPlan[]>();
  for (const plan of directPlans) {
    if (plan.source !== "voiceprint") continue;
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
        confidence: plan.confidence
      });
    }
  }

  directPlans.sort(
    (left, right) =>
      Number(right.source === "manual_mapping") - Number(left.source === "manual_mapping") ||
      right.confidence - left.confidence ||
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
        confidence: plan.confidence
      });
      continue;
    }
    assignments.set(
      plan.candidate.key,
      assignment({
        candidate: plan.candidate,
        identity,
        matched: true,
        reason: plan.source === "manual_mapping" ? "manual_mapping" : "voiceprint_match"
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
            source: "cross_chunk_matching"
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
  const confidenceTotal = orderedAssignments.reduce(
    (total, item) => total + item.identity.confidence,
    0
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
      orderedAssignments.length > 0 ? confidenceTotal / orderedAssignments.length : 0,
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
