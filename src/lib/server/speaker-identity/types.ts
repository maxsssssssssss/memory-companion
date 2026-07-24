import type { TranscriptChunk } from "@/lib/domain/chunks";
import type { TranscriptSegment } from "@/lib/domain/types";

export type SpeakerIdentityType = "known_user" | "known_contact" | "unknown_person";

export type SpeakerIdentitySource =
  | "voiceprint"
  | "cross_chunk_matching"
  | "manual_mapping";

export type SpeakerIdentity = {
  globalSpeakerId: string;
  displayName?: string;
  identityType: SpeakerIdentityType;
  confidence: number;
  source: SpeakerIdentitySource;
};

export type VoiceIdentityProfileStatus = "active" | "disabled";

export type VoiceIdentityProviderReference = {
  provider: "company_voiceprint";
  speakerLabel: string;
  lastRequestId: string;
  operationType: "train" | "save";
};

/**
 * Internal, user-scoped metadata for a voice identity. This model stores only
 * provider references; raw audio, embeddings, and provider-private voiceprint
 * material are intentionally excluded.
 */
export type VoiceIdentityProfile = {
  globalSpeakerId: string;
  userId: string;
  contactName?: string;
  identityType: Extract<SpeakerIdentityType, "known_user" | "known_contact">;
  providerReference: VoiceIdentityProviderReference;
  createdAt: string;
  updatedAt: string;
  status: VoiceIdentityProfileStatus;
};

/**
 * Read-only adapter boundary for future Memory Owner Attribution consumers.
 * It does not mutate Memory and preserves unknown rather than inventing an
 * identity when the resolver has no trusted evidence.
 */
export type VoiceIdentityHint =
  | {
      identityType: Extract<SpeakerIdentityType, "known_user" | "known_contact">;
      globalSpeakerId: string;
      contactName?: string;
      confidence: number;
      source: SpeakerIdentitySource;
    }
  | {
      identityType: "unknown_person";
      confidence: 0;
      source: "unknown";
    };

export type SpeakerIdentityCandidate = {
  key: string;
  uploadId: string;
  chunkId: string;
  chunkIndex: number;
  localSpeaker: string;
  segmentIds: string[];
  segmentCount: number;
  startSeconds: number;
  endSeconds: number;
  /**
   * Opaque, caller-supplied matcher input. It is never copied to an audit or
   * persisted by the resolver.
   */
  matcherFeatures?: unknown;
};

export interface SpeakerIdentityMatcher {
  score(input: {
    left: SpeakerIdentityCandidate;
    right: SpeakerIdentityCandidate;
  }): number | null | Promise<number | null>;
}

export type SpeakerIdentityDirectMapping = {
  chunkId: string;
  localSpeaker: string;
  globalSpeakerId: string;
  displayName?: string;
  identityType?: SpeakerIdentityType;
  confidence?: number;
};

export type VoiceprintIdentityHint = Omit<
  SpeakerIdentityDirectMapping,
  "identityType" | "confidence"
> & {
  identityType: Extract<SpeakerIdentityType, "known_user" | "known_contact">;
  confidence: number;
};

export type SpeakerIdentityAssignmentReason =
  | "manual_mapping"
  | "voiceprint_match"
  | "cross_chunk_match"
  | "no_matching_evidence"
  | "below_confidence_threshold"
  | "ambiguous_match"
  | "same_chunk_identity_conflict";

export type SpeakerIdentityAssignment = {
  candidateKey: string;
  chunkId: string;
  chunkIndex: number;
  localSpeaker: string;
  identity: SpeakerIdentity;
  matched: boolean;
  reason: SpeakerIdentityAssignmentReason;
  segmentCount: number;
};

export type PersistedSpeakerIdentityAuditAssignment = Omit<SpeakerIdentityAssignment, "identity"> & {
  identity: Omit<SpeakerIdentity, "displayName">;
};

export type SpeakerIdentityComparisonReason =
  | "accepted"
  | "not_selected"
  | "below_confidence_threshold"
  | "ambiguous_match"
  | "same_chunk_identity_conflict";

export type SpeakerIdentityComparisonAudit = {
  leftCandidateKey: string;
  rightCandidateKey: string;
  targetGlobalSpeakerId: string;
  score: number;
  accepted: boolean;
  reason: SpeakerIdentityComparisonReason;
};

export type SpeakerIdentityAudit = {
  version: 1;
  uploadId: string;
  generatedAt: string;
  chunksProcessed: number;
  localSpeakerGroups: number;
  globalSpeakers: number;
  matched: number;
  unknown: number;
  averageConfidence: number;
  conflicts: number;
  assignments: PersistedSpeakerIdentityAuditAssignment[];
  comparisons: SpeakerIdentityComparisonAudit[];
};

export type SpeakerIdentityResolvedSegment = TranscriptSegment & {
  identity?: SpeakerIdentity;
};

export type SpeakerIdentityResolvedChunk = Omit<TranscriptChunk, "segments"> & {
  segments: SpeakerIdentityResolvedSegment[];
};

export type ResolveSpeakerIdentitiesInput = {
  uploadId: string;
  chunks: TranscriptChunk[];
  manualMappings?: SpeakerIdentityDirectMapping[];
  voiceprintHints?: VoiceprintIdentityHint[];
  matcher?: SpeakerIdentityMatcher;
  matcherFeatures?: Record<string, unknown>;
  matchThreshold?: number;
  matchMargin?: number;
  voiceprintThreshold?: number;
  now?: () => string;
};

export type SpeakerIdentityResolutionResult = {
  chunks: SpeakerIdentityResolvedChunk[];
  assignments: SpeakerIdentityAssignment[];
  assignmentsByCandidateKey: Record<string, SpeakerIdentityAssignment>;
  audit: SpeakerIdentityAudit;
};
