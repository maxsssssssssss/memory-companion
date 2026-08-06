import type { QaRetrievedEvidence } from "../ai-qa";

export type HybridMemoryType =
  | "event"
  | "commitment"
  | "question"
  | "relationship_signal"
  | "preference"
  | "summary";

/**
 * Sidecar-only ranking metadata. It decorates Canonical Evidence by ID and
 * intentionally does not change either the Evidence or Memory schema.
 */
export type EvidenceRankingMetadata = {
  recordingDate?: string;
  recordingId?: string;
  segmentOrder?: number;
  entities?: string[];
  entityAliases?: string[];
  speakers?: string[];
  owners?: string[];
  memoryType?: HybridMemoryType;
  memoryTypes?: HybridMemoryType[];
  memoryStatus?: "active" | "resolved" | "expired" | "superseded";
  occurrenceCount?: number;
  distinctDates?: number;
  importanceScore?: number;
  relationshipSourceValid?: boolean;
};

export type HybridRecallChannel =
  | "current"
  | "dense"
  | "lexical"
  | "structured"
  | "relationship"
  | "temporal"
  | "lifecycle"
  | "preference";

export type CandidateChannelRanks = Partial<Record<HybridRecallChannel, number>>;

export type HybridFusionStrategy =
  | "uniform_rrf"
  | "weighted_rrf"
  | "query_gated_rrf"
  | "quota_rrf"
  | "union_then_rrf"
  | "dynamic_dense_rrf"
  | "guarded_rrf";

export type HybridEvidenceCandidate = {
  evidence: QaRetrievedEvidence;
  rrfScore: number;
  channelRanks: CandidateChannelRanks;
  denseScore?: number;
  structuredScore?: number;
};
