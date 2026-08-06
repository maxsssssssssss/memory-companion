import type { TranscriptChunk } from "@/lib/domain/chunks";
import { isVerifiedProviderSpeakerIdentity } from "@/lib/domain/speaker-identity";
import type { JsonStore } from "@/lib/server/storage/json-store";

import { JsonSpeakerIdentityRepository } from "./repository";
import { resolveSpeakerIdentities } from "./resolver";
import type {
  ResolveSpeakerIdentitiesInput,
  SpeakerIdentityAssignment,
  SpeakerIdentityAssignmentReason,
  SpeakerIdentityAudit,
  SpeakerIdentityDirectMapping,
  SpeakerIdentityMatcher,
  ProviderLabelIdentityEvidence,
  SpeakerIdentityResolutionResult,
  VoiceprintIdentityHint
} from "./types";

export type IdentityResolutionStatus =
  | "verified"
  | "unknown"
  | "pending"
  | "conflict";

export type IdentityResolutionSource =
  | "provider_speaker_result"
  | "manual_mapping"
  | "cross_chunk_matching"
  | "fallback";

export type IdentityResolution = {
  candidateKey: string;
  chunkId: string;
  localSpeaker: string;
  /**
   * Stable speaker-group id. For unresolved speakers this is an opaque
   * unknown id, never a user or contact id inferred from the local label.
   */
  globalSpeakerId: string;
  /**
   * Set only for a Provider-verified voiceprint assignment. Memory owner
   * attribution must not use globalSpeakerId as an owner id by itself.
   */
  ownerIdentityId: string | null;
  /**
   * Local matcher/manual confidence. Null means the Provider supplied a
   * categorical speaker_result label without an acoustic score.
   */
  confidence: number | null;
  status: IdentityResolutionStatus;
  source: IdentityResolutionSource;
  providerLabel: string | null;
  evidence: ProviderLabelIdentityEvidence | null;
  reason: SpeakerIdentityAssignmentReason;
};

export type IdentityEvidenceAvailability = "available" | "unknown" | "pending";

export type IdentityStructuralGateStatus = "healthy" | "degraded" | "blocked";

export type IdentityStructuralChunkAudit = {
  chunkId: string;
  requestedSpeakerCount: number | null;
  speakerResultItemCount: number | null;
  distinctLabelCount: number;
  labelCoverage: number;
  dominantLabelRatio: number;
  knownLabelRatio: number;
  unknownLabelRatio: number;
  status: IdentityStructuralGateStatus;
  reasons: string[];
};

export type IdentityStructuralGateAudit = {
  status: IdentityStructuralGateStatus;
  reasons: string[];
  chunks: IdentityStructuralChunkAudit[];
};

export type IdentityResolverAudit = SpeakerIdentityAudit & {
  resolutionStates: IdentityResolution[];
  structuralGate: IdentityStructuralGateAudit;
  evidenceAvailability: {
    manualMapping: IdentityEvidenceAvailability;
    voiceprint: IdentityEvidenceAvailability;
  };
};

export type IdentityResolverResult = Omit<SpeakerIdentityResolutionResult, "audit"> & {
  audit: IdentityResolverAudit;
  resolutions: IdentityResolution[];
  evidenceAvailability: IdentityResolverAudit["evidenceAvailability"];
};

export type IdentityResolverInput = {
  uploadId: string;
  chunks: TranscriptChunk[];
};

export interface IdentityResolver {
  resolve(input: IdentityResolverInput): Promise<IdentityResolverResult>;
}

type IdentityEvidenceResult<T> = {
  availability: IdentityEvidenceAvailability;
  evidence: T[];
};

export interface IdentityEvidenceResolver<T> {
  resolve(input: IdentityResolverInput): Promise<IdentityEvidenceResult<T>>;
}

function isTimeoutFailure(error: unknown) {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  return (
    "reason" in error &&
    (error as Error & { reason?: unknown }).reason === "timeout"
  );
}

async function safeEvidence<T>(
  resolver: IdentityEvidenceResolver<T>,
  input: IdentityResolverInput
): Promise<IdentityEvidenceResult<T>> {
  try {
    return await resolver.resolve(input);
  } catch (error) {
    return {
      availability: isTimeoutFailure(error) ? "pending" : "unknown",
      evidence: []
    };
  }
}

export class ManualMappingResolver
implements IdentityEvidenceResolver<SpeakerIdentityDirectMapping> {
  constructor(
    private readonly repository: {
      loadDirectMappings(uploadId: string): Promise<SpeakerIdentityDirectMapping[]>;
    }
  ) {}

  async resolve(input: IdentityResolverInput): Promise<IdentityEvidenceResult<SpeakerIdentityDirectMapping>> {
    try {
      return {
        availability: "available",
        evidence: await this.repository.loadDirectMappings(input.uploadId)
      };
    } catch {
      return {
        availability: "unknown",
        evidence: []
      };
    }
  }
}

export class VoiceprintResolver
implements IdentityEvidenceResolver<VoiceprintIdentityHint> {
  constructor(
    private readonly repository: {
      loadVoiceprintHints(chunks: TranscriptChunk[]): Promise<VoiceprintIdentityHint[]>;
    }
  ) {}

  async resolve(input: IdentityResolverInput): Promise<IdentityEvidenceResult<VoiceprintIdentityHint>> {
    try {
      return {
        availability: "available",
        evidence: await this.repository.loadVoiceprintHints(input.chunks)
      };
    } catch (error) {
      return {
        availability: isTimeoutFailure(error) ? "pending" : "unknown",
        evidence: []
      };
    }
  }
}

function isConflictReason(reason: SpeakerIdentityAssignmentReason) {
  return reason === "ambiguous_match" || reason === "same_chunk_identity_conflict";
}

function resolutionStatus(
  assignment: SpeakerIdentityAssignment,
  voiceprintAvailability: IdentityEvidenceAvailability
): IdentityResolutionStatus {
  if (isConflictReason(assignment.reason)) return "conflict";
  if (assignment.reason === "provider_label_review_required") return "pending";
  if (
    assignment.matched &&
    isVerifiedProviderSpeakerIdentity({
      speaker: assignment.localSpeaker,
      identity: assignment.identity
    })
  ) {
    return "verified";
  }
  if (assignment.identity.identityType !== "unknown_person") return "pending";
  return voiceprintAvailability === "pending" ? "pending" : "unknown";
}

function resolutionSource(
  assignment: SpeakerIdentityAssignment,
  status: IdentityResolutionStatus
): IdentityResolutionSource {
  if (
    status === "verified" ||
    assignment.identity.evidence?.type === "provider_label"
  ) return "provider_speaker_result";
  if (assignment.identity.source === "manual_mapping") return "manual_mapping";
  if (assignment.matched && assignment.reason === "cross_chunk_match") {
    return "cross_chunk_matching";
  }
  return "fallback";
}

function withIdentityResolutions(
  result: SpeakerIdentityResolutionResult,
  evidenceAvailability: IdentityResolverResult["evidenceAvailability"]
): IdentityResolverResult {
  const resolutions: IdentityResolution[] = result.assignments.map((assignment) => {
    const status = resolutionStatus(assignment, evidenceAvailability.voiceprint);
    return {
      candidateKey: assignment.candidateKey,
      chunkId: assignment.chunkId,
      localSpeaker: assignment.localSpeaker,
      globalSpeakerId: assignment.identity.globalSpeakerId,
      ownerIdentityId:
        status === "verified" ? assignment.identity.globalSpeakerId : null,
      confidence: assignment.identity.confidence,
      status,
      source: resolutionSource(assignment, status),
      providerLabel:
        assignment.identity.evidence?.type === "provider_label"
          ? assignment.identity.evidence.providerLabel
          : null,
      evidence:
        assignment.identity.evidence?.type === "provider_label"
          ? { ...assignment.identity.evidence }
          : null,
      reason: assignment.reason
    };
  });
  const structuralGate = buildStructuralGate(result.chunks, resolutions);
  return {
    ...result,
    audit: {
      ...result.audit,
      resolutionStates: resolutions,
      structuralGate,
      evidenceAvailability
    },
    resolutions,
    evidenceAvailability
  };
}

function finiteMetadataNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function roundedRatio(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function buildStructuralGate(
  chunks: TranscriptChunk[],
  resolutions: IdentityResolution[]
): IdentityStructuralGateAudit {
  const resolutionByKey = new Map(
    resolutions.map((resolution) => [resolution.candidateKey, resolution])
  );
  const chunkAudits = chunks.map((chunk): IdentityStructuralChunkAudit => {
    const requestedSpeakerCount = finiteMetadataNumber(
      chunk.metadata.requestedSpeakerCount
    );
    const speakerResultItemCount = finiteMetadataNumber(
      chunk.metadata.speakerResultItemCount
    );
    const labels = chunk.segments.flatMap((segment) =>
      segment.speaker?.trim() ? [segment.speaker.trim()] : []
    );
    const labelCounts = new Map<string, number>();
    for (const label of labels) {
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
    const knownLabels = [...labelCounts.keys()].filter((label) => {
      const resolution = resolutionByKey.get(`${chunk.id}::${label}`);
      return Boolean(
        resolution?.providerLabel &&
        resolution.status !== "unknown" &&
        resolution.status !== "conflict"
      );
    }).length;
    const distinctLabelCount = labelCounts.size;
    const reasons: string[] = [];
    if (speakerResultItemCount === null) {
      reasons.push("speaker_result_metrics_missing");
    }
    if (speakerResultItemCount === 0 || chunk.segments.length === 0 || labels.length === 0) {
      reasons.push("speaker_result_missing");
    }
    if (
      requestedSpeakerCount !== null &&
      requestedSpeakerCount > 0 &&
      distinctLabelCount < requestedSpeakerCount
    ) {
      reasons.push("distinct_labels_below_requested_speakers");
    }
    const dominantLabelRatio = labels.length > 0
      ? Math.max(...labelCounts.values()) / labels.length
      : 0;
    if (
      requestedSpeakerCount !== null &&
      requestedSpeakerCount > 1 &&
      dominantLabelRatio >= 0.9
    ) {
      reasons.push("single_label_dominance");
    }
    if (
      [...labelCounts.keys()].some((label) =>
        resolutionByKey.get(`${chunk.id}::${label}`)?.status === "conflict"
      )
    ) {
      reasons.push("provider_label_conflict");
    }
    const blocked = reasons.includes("speaker_result_missing");
    const status: IdentityStructuralGateStatus = blocked
      ? "blocked"
      : reasons.length > 0
        ? "degraded"
        : "healthy";
    return {
      chunkId: chunk.id,
      requestedSpeakerCount,
      speakerResultItemCount,
      distinctLabelCount,
      labelCoverage: roundedRatio(
        chunk.segments.length > 0 ? labels.length / chunk.segments.length : 0
      ),
      dominantLabelRatio: roundedRatio(dominantLabelRatio),
      knownLabelRatio: roundedRatio(
        distinctLabelCount > 0 ? knownLabels / distinctLabelCount : 0
      ),
      unknownLabelRatio: roundedRatio(
        distinctLabelCount > 0 ? (distinctLabelCount - knownLabels) / distinctLabelCount : 1
      ),
      status,
      reasons
    };
  });
  const status: IdentityStructuralGateStatus = chunkAudits.some(
    (chunk) => chunk.status === "blocked"
  )
    ? "blocked"
    : chunkAudits.some((chunk) => chunk.status === "degraded")
      ? "degraded"
      : "healthy";
  return {
    status,
    reasons: [...new Set(chunkAudits.flatMap((chunk) => chunk.reasons))],
    chunks: chunkAudits
  };
}

export class UnknownFallbackResolver implements IdentityResolver {
  async resolve(input: IdentityResolverInput): Promise<IdentityResolverResult> {
    const result = await resolveSpeakerIdentities({
      uploadId: input.uploadId,
      chunks: input.chunks,
      manualMappings: [],
      voiceprintHints: []
    });
    return withIdentityResolutions(result, {
      manualMapping: "unknown",
      voiceprint: "unknown"
    });
  }
}

export class CompositeIdentityResolver implements IdentityResolver {
  private readonly fallbackResolver: IdentityResolver;

  constructor(private readonly options: {
    manualMappingResolver: IdentityEvidenceResolver<SpeakerIdentityDirectMapping>;
    voiceprintResolver: IdentityEvidenceResolver<VoiceprintIdentityHint>;
    fallbackResolver?: IdentityResolver;
    matcher?: SpeakerIdentityMatcher;
    matcherFeatures?: Record<string, unknown>;
    matchThreshold?: number;
    matchMargin?: number;
    providerLabelTrust?: ResolveSpeakerIdentitiesInput["providerLabelTrust"];
  }) {
    this.fallbackResolver = options.fallbackResolver ?? new UnknownFallbackResolver();
  }

  async resolve(input: IdentityResolverInput): Promise<IdentityResolverResult> {
    const [manualMapping, voiceprint] = await Promise.all([
      safeEvidence(this.options.manualMappingResolver, input),
      safeEvidence(this.options.voiceprintResolver, input)
    ]);
    const coreInput: ResolveSpeakerIdentitiesInput = {
      uploadId: input.uploadId,
      chunks: input.chunks,
      manualMappings: manualMapping.evidence,
      voiceprintHints: voiceprint.evidence,
      ...(this.options.matcher ? { matcher: this.options.matcher } : {}),
      ...(this.options.matcherFeatures
        ? { matcherFeatures: this.options.matcherFeatures }
        : {}),
      ...(this.options.matchThreshold !== undefined
        ? { matchThreshold: this.options.matchThreshold }
        : {}),
      ...(this.options.matchMargin !== undefined
        ? { matchMargin: this.options.matchMargin }
        : {}),
      ...(this.options.providerLabelTrust
        ? { providerLabelTrust: this.options.providerLabelTrust }
        : {}),
    };

    try {
      const result = await resolveSpeakerIdentities(coreInput);
      return withIdentityResolutions(result, {
        manualMapping: manualMapping.availability,
        voiceprint: voiceprint.availability
      });
    } catch {
      return await this.fallbackResolver.resolve(input);
    }
  }
}

export function createIdentityResolver(input: {
  store: JsonStore;
  matcher?: SpeakerIdentityMatcher;
  matcherFeatures?: Record<string, unknown>;
}): IdentityResolver {
  const repository = new JsonSpeakerIdentityRepository(input.store);
  return new CompositeIdentityResolver({
    manualMappingResolver: new ManualMappingResolver(repository),
    voiceprintResolver: new VoiceprintResolver(repository),
    ...(input.matcher ? { matcher: input.matcher } : {}),
    ...(input.matcherFeatures ? { matcherFeatures: input.matcherFeatures } : {})
  });
}
