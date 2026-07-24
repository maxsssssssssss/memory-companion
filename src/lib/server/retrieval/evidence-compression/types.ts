import type {
  QaLifecycleEvidenceState,
  QaQueryIntentAnalysis
} from "../lifecycle-retrieval";

export type CanonicalEvidenceProjectionItem = {
  id: string;
  kind:
    | "brief"
    | "semantic"
    | "audio"
    | "audio_emotion"
    | "raw"
    | "relationship_signal";
  title: string;
  text: string;
  startSeconds: number;
  endSeconds: number;
  sourceSegmentIds: readonly string[];
};

export type CompactEvidenceProjectionStatus =
  | "projected"
  | "unchanged"
  | "fallback_original";

export type CompactEvidenceFallbackReason =
  | "unparseable_audio_evidence"
  | "user_correction_present"
  | "lifecycle_state_changed"
  | "lifecycle_topic_changed";

export type CompactEvidenceLifecycleAudit = {
  originalState: QaLifecycleEvidenceState;
  candidateState: QaLifecycleEvidenceState;
  compactState: QaLifecycleEvidenceState;
  originalTopicOverlap: number;
  candidateTopicOverlap: number;
  compactTopicOverlap: number;
  unchanged: boolean;
};

/**
 * Prompt-only projection of one canonical QA Evidence item.
 *
 * The source mapping remains server-side and is copied directly from the
 * canonical item. `promptText` is never used to build citations or support IDs
 * while the projection runs in shadow mode.
 */
export type CompactEvidenceView = {
  citationId: `E${number}`;
  canonicalEvidenceId: string;
  kind: CanonicalEvidenceProjectionItem["kind"];
  title: string;
  sourceSegmentIds: string[];
  timestamp: {
    startSeconds: number;
    endSeconds: number;
  };
  summary: string | null;
  evidence: string | null;
  promptText: string;
  projectionStatus: CompactEvidenceProjectionStatus;
  fallbackReason: CompactEvidenceFallbackReason | null;
  originalSerializedChars: number;
  compactSerializedChars: number;
  lifecycle: CompactEvidenceLifecycleAudit;
};

export type CompactEvidenceProjection = {
  queryIntent: QaQueryIntentAnalysis;
  views: CompactEvidenceView[];
  originalChars: number;
  compactChars: number;
  reductionRatio: number;
  audioItems: number;
  projectedAudioItems: number;
  fallbackItems: number;
  citationMappingUnchanged: boolean;
  sourceIdsUnchanged: boolean;
  lifecycleStateUnchanged: boolean;
  /** Confirms that this shadow result is not the Provider request body. */
  providerPayload: "canonical";
};
