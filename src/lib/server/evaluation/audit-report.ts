import type { AnalysisChunkCheckpoint } from "@/lib/server/analysis-chunks/checkpoint";
import type { AudioChunk, TranscriptChunk } from "@/lib/domain/chunks";
import type {
  AudioInsight,
  BriefItem,
  RelationshipSignalCard,
  SemanticSegment,
  TranscriptSegment
} from "@/lib/domain/types";
import type { ProactiveInsight } from "@/lib/domain/proactive-insights";
import type { MemoryIndexUpdateResult, MemoryItem, MemoryRelation } from "@/lib/server/memory";
import { normalizeEvidenceQuoteForDedup } from "@/lib/server/memory/evidence-deduplication";
import type { RelationshipReducerAudit } from "@/lib/server/relationship-signals/candidates";
import type { RelationshipLifecycleAudit } from "@/lib/server/relationship-signals/lifecycle/types";
import type { ProviderRawResponseCaptureReport } from "./provider-response-capture";

export const EVALUATION_AUDIT_REPORT_VERSION = 1 as const;

export type EvaluationMemoryIndexStageAudit =
  | {
      status: "completed";
      update: MemoryIndexUpdateResult;
      admission: unknown;
    }
  | {
      status: "skipped";
      reason: "missing_user_id" | "date_companion_confirmation_required";
    }
  | {
      status: "failed";
      error: string;
    };

export type EvaluationEvidenceFirstAudit = {
  audited: boolean;
  evidenceCount: number;
  invalidSourceIds: number | null;
  nonVerbatimQuotes: number | null;
  duplicateEvidence: number | null;
  memoriesWithoutEvidence: number | null;
  memoriesWithoutEvidenceScope: "user" | "unavailable";
  orphanEvidence: number | null;
  orphanEvidenceScope: "evaluation_memory_database" | "unavailable";
};

export type EvaluationAuditReport = {
  version: typeof EVALUATION_AUDIT_REPORT_VERSION;
  mode: "evaluation_retention";
  generatedAt: string;
  uploadId: string;
  userId: string | null;
  recordingDate: string;
  status: "ready";
  retention: {
    uploadRecordRetained: true;
    uploadFilePathRetained: boolean;
    uploadFileExists: boolean;
    automaticDeleteBlocked: true;
    explicitConfirmedDeleteAllowed: true;
  };
  artifacts: {
    transcriptSegments: number;
    audioInsights: number;
    semanticSegments: number;
    briefItems: number;
    relationshipCards: number;
    proactiveInsights: number;
    audioChunkCheckpoints: number;
    transcriptChunkCheckpoints: number;
    analysisCheckpoints: number;
    analysisCheckpointsByKind: Record<AnalysisChunkCheckpoint["kind"], number>;
    analysisCheckpointsByStatus: Record<AnalysisChunkCheckpoint["status"], number>;
    providerRawResponses: ProviderRawResponseCaptureReport;
  };
  relationship: {
    stats: Record<string, number>;
    reducerAudit: RelationshipReducerAudit | null;
    reducerAuditAvailable: boolean;
    lifecycleAudit: RelationshipLifecycleAudit | null;
    lifecycleAuditAvailable: boolean;
  };
  memory: {
    stage: EvaluationMemoryIndexStageAudit;
    auditStatus: "completed" | "skipped" | "failed";
    auditError?: string;
    audited: boolean;
    itemScope: "user";
    userItemCount: number;
    itemsWithCurrentUploadEvidence: number;
    userEvidenceCount: number;
    currentUploadEvidenceCount: number;
    userRelationCount: number | null;
  };
  evidenceFirst: EvaluationEvidenceFirstAudit;
};

function normalizedQuote(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/\s+/gu, " ")
    .trim();
}

function countByAnalysisKind(checkpoints: AnalysisChunkCheckpoint[]) {
  const counts: EvaluationAuditReport["artifacts"]["analysisCheckpointsByKind"] = {
    audio_insight: 0,
    daily_brief: 0,
    relationship_candidate: 0
  };
  checkpoints.forEach((checkpoint) => {
    counts[checkpoint.kind] += 1;
  });
  return counts;
}

function countByAnalysisStatus(checkpoints: AnalysisChunkCheckpoint[]) {
  const counts: EvaluationAuditReport["artifacts"]["analysisCheckpointsByStatus"] = {
    created: 0,
    processing: 0,
    completed: 0,
    failed: 0
  };
  checkpoints.forEach((checkpoint) => {
    counts[checkpoint.status] += 1;
  });
  return counts;
}

function buildEvidenceFirstAudit(input: {
  audited: boolean;
  uploadId: string;
  segments: TranscriptSegment[];
  audioInsights: AudioInsight[];
  semanticSegments: SemanticSegment[];
  briefItems: BriefItem[];
  relationshipCards: RelationshipSignalCard[];
  memories: MemoryItem[];
  orphanEvidenceCount: number | null;
  memoriesWithoutEvidenceCount: number | null;
}): EvaluationEvidenceFirstAudit {
  const currentUploadMemories = input.memories.filter((memory) =>
    memory.evidence.some((evidence) => evidence.uploadId === input.uploadId)
  );
  const evidence = currentUploadMemories.flatMap((memory) =>
    memory.evidence.filter((item) => item.uploadId === input.uploadId)
  );
  if (!input.audited) {
    return {
      audited: false,
      evidenceCount: evidence.length,
      invalidSourceIds: null,
      nonVerbatimQuotes: null,
      duplicateEvidence: null,
      memoriesWithoutEvidence: input.memoriesWithoutEvidenceCount,
      memoriesWithoutEvidenceScope: input.memoriesWithoutEvidenceCount === null ? "unavailable" : "user",
      orphanEvidence: input.orphanEvidenceCount,
      orphanEvidenceScope: input.orphanEvidenceCount === null ? "unavailable" : "evaluation_memory_database"
    };
  }

  const segmentById = new Map(input.segments.map((segment) => [segment.id, segment]));
  const sourceIdsByType = {
    transcript: new Set(input.segments.map((segment) => segment.id)),
    brief: new Set(input.briefItems.map((item) => item.id)),
    timeline: new Set(input.semanticSegments.map((segment) => segment.id)),
    audio_insight: new Set(input.audioInsights.map((insight) => insight.id)),
    relationship_signal: new Set(input.relationshipCards.map((card) => card.id))
  };
  const transcriptText = input.segments.map((segment) => normalizedQuote(segment.text));
  const invalidSourceIds = evidence.filter((item) => !sourceIdsByType[item.sourceType].has(item.sourceId)).length;
  const nonVerbatimQuotes = evidence.filter((item) => {
    const quote = normalizedQuote(item.quote);
    if (!quote) return true;
    const source = item.sourceType === "transcript" ? segmentById.get(item.sourceId) : undefined;
    return source
      ? !normalizedQuote(source.text).includes(quote)
      : !transcriptText.some((text) => text.includes(quote));
  }).length;
  const duplicateEvidence = currentUploadMemories.reduce((total, memory) => {
    const seen = new Set<string>();
    return total + memory.evidence.filter((item) => item.uploadId === input.uploadId).reduce((duplicates, item) => {
      const key = `${item.uploadId}\u001f${item.sourceId}\u001f${normalizeEvidenceQuoteForDedup(item.quote)}`;
      if (seen.has(key)) return duplicates + 1;
      seen.add(key);
      return duplicates;
    }, 0);
  }, 0);

  return {
    audited: true,
    evidenceCount: evidence.length,
    invalidSourceIds,
    nonVerbatimQuotes,
    duplicateEvidence,
    memoriesWithoutEvidence: input.memoriesWithoutEvidenceCount,
    memoriesWithoutEvidenceScope: input.memoriesWithoutEvidenceCount === null ? "unavailable" : "user",
    orphanEvidence: input.orphanEvidenceCount,
    orphanEvidenceScope: input.orphanEvidenceCount === null ? "unavailable" : "evaluation_memory_database"
  };
}

export function buildEvaluationAuditReport(input: {
  generatedAt: string;
  uploadId: string;
  userId?: string;
  recordingDate: string;
  uploadFilePathRetained: boolean;
  uploadFileExists: boolean;
  segments: TranscriptSegment[];
  audioInsights: AudioInsight[];
  semanticSegments: SemanticSegment[];
  briefItems: BriefItem[];
  relationshipCards: RelationshipSignalCard[];
  proactiveInsights: ProactiveInsight[];
  audioChunks: AudioChunk[];
  transcriptChunks: TranscriptChunk[];
  analysisCheckpoints: AnalysisChunkCheckpoint[];
  relationshipStats: Record<string, number>;
  relationshipReducerAudit: RelationshipReducerAudit | null;
  relationshipLifecycleAudit?: RelationshipLifecycleAudit | null;
  memoryStage: EvaluationMemoryIndexStageAudit;
  memoryAuditStatus: "completed" | "skipped" | "failed";
  memoryAuditError?: string;
  memories: MemoryItem[];
  memoryRelations: MemoryRelation[] | null;
  orphanEvidenceCount: number | null;
  memoriesWithoutEvidenceCount: number | null;
  providerRawResponses?: ProviderRawResponseCaptureReport;
}): EvaluationAuditReport {
  const currentUploadEvidence = input.memories.flatMap((memory) =>
    memory.evidence.filter((evidence) => evidence.uploadId === input.uploadId)
  );
  const memoryAudited = input.memoryStage.status === "completed" && input.memoryAuditStatus === "completed";
  return {
    version: EVALUATION_AUDIT_REPORT_VERSION,
    mode: "evaluation_retention",
    generatedAt: input.generatedAt,
    uploadId: input.uploadId,
    userId: input.userId ?? null,
    recordingDate: input.recordingDate,
    status: "ready",
    retention: {
      uploadRecordRetained: true,
      uploadFilePathRetained: input.uploadFilePathRetained,
      uploadFileExists: input.uploadFileExists,
      automaticDeleteBlocked: true,
      explicitConfirmedDeleteAllowed: true
    },
    artifacts: {
      transcriptSegments: input.segments.length,
      audioInsights: input.audioInsights.length,
      semanticSegments: input.semanticSegments.length,
      briefItems: input.briefItems.length,
      relationshipCards: input.relationshipCards.length,
      proactiveInsights: input.proactiveInsights.length,
      audioChunkCheckpoints: input.audioChunks.length,
      transcriptChunkCheckpoints: input.transcriptChunks.length,
      analysisCheckpoints: input.analysisCheckpoints.length,
      analysisCheckpointsByKind: countByAnalysisKind(input.analysisCheckpoints),
      analysisCheckpointsByStatus: countByAnalysisStatus(input.analysisCheckpoints),
      providerRawResponses: input.providerRawResponses ?? {
        version: 1,
        enabled: false,
        fileCount: 0,
        aggregateSha256: null,
        files: []
      }
    },
    relationship: {
      stats: input.relationshipStats,
      reducerAudit: input.relationshipReducerAudit,
      reducerAuditAvailable: input.relationshipReducerAudit !== null,
      lifecycleAudit: input.relationshipLifecycleAudit ?? null,
      lifecycleAuditAvailable: input.relationshipLifecycleAudit !== null && input.relationshipLifecycleAudit !== undefined
    },
    memory: {
      stage: input.memoryStage,
      auditStatus: input.memoryAuditStatus,
      ...(input.memoryAuditError ? { auditError: input.memoryAuditError } : {}),
      audited: memoryAudited,
      itemScope: "user",
      userItemCount: input.memories.length,
      itemsWithCurrentUploadEvidence: input.memories.filter((memory) =>
        memory.evidence.some((evidence) => evidence.uploadId === input.uploadId)
      ).length,
      userEvidenceCount: input.memories.reduce((total, memory) => total + memory.evidence.length, 0),
      currentUploadEvidenceCount: currentUploadEvidence.length,
      userRelationCount: input.memoryRelations?.length ?? null
    },
    evidenceFirst: buildEvidenceFirstAudit({
      audited: memoryAudited,
      uploadId: input.uploadId,
      segments: input.segments,
      audioInsights: input.audioInsights,
      semanticSegments: input.semanticSegments,
      briefItems: input.briefItems,
      relationshipCards: input.relationshipCards,
      memories: input.memories,
      orphanEvidenceCount: input.orphanEvidenceCount,
      memoriesWithoutEvidenceCount: input.memoriesWithoutEvidenceCount
    })
  };
}
