import * as fs from "fs/promises";
import {
  TranscriptSegmentSchema,
  type AudioInsight,
  type AudioUpload,
  type BriefItem,
  type EmotionEvidence,
  type ProcessingJob,
  type RelationshipSignalCard,
  type SemanticSegment,
  type TranscriptSegment
} from "@/lib/domain/types";
import {
  ProactiveInsightCacheDocumentSchema,
  proactiveInsightCacheIdForUpload,
  type ProactiveInsight,
  type ProactiveInsightCacheDocument
} from "@/lib/domain/proactive-insights";
import {
  applyAcousticFeaturesToAudioInsights,
  type AcousticSegmentFeature
} from "@/lib/processing/acoustic-features";
import { buildSemanticSegments } from "@/lib/processing/semantic-segments";
import { applyEmotionEvidenceToAudioInsights } from "@/lib/processing/emotion-evidence";
import { extractFfmpegAcousticFeatures } from "@/lib/server/audio-features/ffmpeg-acoustic-features";
import { getAudioInsightChunkProviders, type AudioInsightProvider } from "@/lib/server/audio-insights/provider";
import { ruleAudioInsightProvider } from "@/lib/server/audio-insights/rule-provider";
import { processAudioInsightChunks } from "@/lib/server/audio-insights/chunk-processing";
import { resolveAnalysisTranscriptChunks } from "@/lib/server/analysis-chunks/transcript-chunks";
import { JsonAnalysisChunkCheckpointStore } from "@/lib/server/analysis-chunks/checkpoint";
import { getEmotionSignalProvider, type EmotionSignalProvider } from "@/lib/server/emotion-signals/provider";
import {
  buildEvaluationAuditReport,
  type EvaluationMemoryIndexStageAudit
} from "@/lib/server/evaluation/audit-report";
import { isEvaluationRetentionUpload } from "@/lib/server/evaluation/retention";
import { collectProviderRawResponseCaptureReport } from "@/lib/server/evaluation/provider-response-capture";
import { getExtractionProvider, type ExtractionProgressEvent, type ExtractionProvider } from "@/lib/server/extraction/provider";
import { createJob, updateJob } from "@/lib/server/jobs/job-store";
import {
  extractUploadMemoriesWithAudit,
  getMemoryDatabase,
  getMemoryRepository,
  type MemoryExtractionAudit,
  type MemoryItem,
  type MemoryRelation,
  type MemoryRepository
} from "@/lib/server/memory";
import { applyMemoryRelevanceGate } from "@/lib/server/memory/relevance";
import type { MemoryRelevanceJudge } from "@/lib/server/memory/relevance/types";
import { buildProactiveInsightContext } from "@/lib/server/proactive-insights/evidence";
import {
  buildProactiveInsightMemoryContext,
  combineProactiveInsightSourceFingerprint,
  emptyProactiveInsightMemoryContext
} from "@/lib/server/proactive-insights/memory-context";
import { getProactiveInsightProvider, type ProactiveInsightProvider } from "@/lib/server/proactive-insights/provider";
import { getRelationshipSignalProvider, type RelationshipSignalProvider } from "@/lib/server/relationship-signals/provider";
import { processRelationshipSignalChunks } from "@/lib/server/relationship-signals/chunk-processing";
import {
  relationshipLifecycleSignalsFromCandidates,
  relationshipLifecycleSignalsFromCards,
  resolveRelationshipLifecycles
} from "@/lib/server/relationship-signals/lifecycle/resolver";
import type { JsonStore } from "@/lib/server/storage/json-store";
import { appStore } from "@/lib/server/storage/json-store";
import { type TranscriptionProvider } from "@/lib/server/transcription/provider";
import { JsonChunkCheckpointStore } from "@/lib/server/transcription/chunks/checkpoint-store";
import { JsonSpeakerIdentityRepository } from "@/lib/server/speaker-identity/repository";
import {
  transcribeConfiguredAudio,
  type UploadTranscriptionProcessor
} from "@/lib/server/transcription/chunks/process-audio";

type StoredUpload = AudioUpload & {
  filePath?: string;
  errorCode?: string;
  errorMessage?: string;
  evaluationRetention?: boolean;
};

type DeletedUploadMarker = {
  uploadId: string;
  deletedAt: string;
};

export type ProcessUploadInput = {
  uploadId: string;
  store?: JsonStore;
  userId?: string;
  onJobUpdate?: (job: ProcessingJob) => void | Promise<void>;
  memoryRepository?: Pick<MemoryRepository, "replaceUploadMemories" | "getRelevantMemories"> &
    Partial<Pick<MemoryRepository, "deleteByUpload">>;
  dependencies?: ProcessUploadDependencies;
};

export type ProcessUploadDependencies = {
  transcriptionProvider?: TranscriptionProvider;
  transcriptionProcessor?: UploadTranscriptionProcessor;
  audioInsightProvider?: AudioInsightProvider;
  acousticFeatureExtractor?: (input: {
    filePath: string;
    segments: TranscriptSegment[];
  }) => Promise<AcousticSegmentFeature[]>;
  emotionSignalProvider?: EmotionSignalProvider;
  extractionProvider?: ExtractionProvider;
  relationshipSignalProvider?: RelationshipSignalProvider;
  memoryRelevanceJudge?: MemoryRelevanceJudge;
  proactiveInsightProvider?: ProactiveInsightProvider;
  now?: () => string;
  evaluationRawResponseCapture?: boolean;
};

export type ProcessUploadResult = {
  job: ProcessingJob;
  segments: TranscriptSegment[];
  audioInsights: AudioInsight[];
  semanticSegments: SemanticSegment[];
  briefItems: BriefItem[];
  relationshipSignals: RelationshipSignalCard[];
  proactiveInsights: ProactiveInsight[];
};

export class UploadProcessingCancelledError extends Error {
  constructor(uploadId: string) {
    super(`Upload processing cancelled: ${uploadId}`);
    this.name = "UploadProcessingCancelledError";
  }
}

export function isUploadProcessingCancelled(error: unknown): error is UploadProcessingCancelledError {
  return error instanceof UploadProcessingCancelledError;
}

export function assertProcessUploadDependenciesAllowed(
  dependencies: ProcessUploadDependencies | undefined,
  nodeEnv = process.env.NODE_ENV
) {
  if (!dependencies) {
    return;
  }
  if (nodeEnv !== "development" && nodeEnv !== "test") {
    throw new Error("Custom processUpload dependencies are only available in development or test");
  }
}

async function assertUploadWritable(store: JsonStore, uploadId: string): Promise<StoredUpload> {
  const deleted = await store.read<DeletedUploadMarker>("deleted-uploads", uploadId);
  if (deleted) {
    throw new UploadProcessingCancelledError(uploadId);
  }

  const upload = await store.read<StoredUpload>("uploads", uploadId);
  if (!upload) {
    throw new UploadProcessingCancelledError(uploadId);
  }

  return upload;
}

async function cleanupJobArtifacts(store: JsonStore, uploadId: string, job?: ProcessingJob | null) {
  const jobIds = new Set<string>();
  if (job?.id) {
    jobIds.add(job.id);
  }

  const indexedJob = await store.read<ProcessingJob>("jobs-by-upload", uploadId);
  if (indexedJob?.id) {
    jobIds.add(indexedJob.id);
  }

  await Promise.all([
    ...Array.from(jobIds).map((jobId) => store.delete("jobs", jobId)),
    store.delete("jobs-by-upload", uploadId)
  ]);
}

async function cleanupProcessingArtifacts(
  store: JsonStore,
  uploadId: string,
  userId: string,
  job?: ProcessingJob | null,
  deleteMemories?: () => void
) {
  await Promise.all([
    cleanupJobArtifacts(store, uploadId, job),
    new JsonChunkCheckpointStore(store).deleteUpload(uploadId),
    new JsonAnalysisChunkCheckpointStore(store).deleteUpload(userId, uploadId),
    new JsonSpeakerIdentityRepository(store).deleteUploadMappings(uploadId),
    store.delete("segments", uploadId),
    store.delete("audio-insights", uploadId),
    store.delete("semantic-segments", uploadId),
    store.delete("brief-items", uploadId),
    store.delete("relationship-signals", uploadId),
    store.delete("relationship-lifecycle", uploadId),
    store.delete("memory-owner-audits", uploadId),
    store.delete("speaker-identities", uploadId),
    store.delete("proactive-insights", proactiveInsightCacheIdForUpload(uploadId))
  ]);
  deleteMemories?.();
}

async function assertUploadWritableAfterWrite(
  store: JsonStore,
  uploadId: string,
  cleanup: () => Promise<void>
) {
  try {
    return await assertUploadWritable(store, uploadId);
  } catch (error) {
    if (isUploadProcessingCancelled(error)) {
      await cleanup();
    }
    throw error;
  }
}

async function createUploadJob(store: JsonStore, uploadId: string) {
  await assertUploadWritable(store, uploadId);
  const job = await createJob(store, uploadId);
  await assertUploadWritableAfterWrite(store, uploadId, () => cleanupJobArtifacts(store, uploadId, job));
  return job;
}

async function updateUploadJob(
  store: JsonStore,
  job: ProcessingJob,
  patch: Partial<ProcessingJob>,
  onJobUpdate?: ProcessUploadInput["onJobUpdate"]
) {
  await assertUploadWritable(store, job.uploadId);
  const nextJob = await updateJob(store, job, patch);
  await onJobUpdate?.(nextJob);
  await assertUploadWritableAfterWrite(store, job.uploadId, () =>
    cleanupJobArtifacts(store, job.uploadId, nextJob)
  );
  return nextJob;
}

async function writeUploadScopedValue<T>(
  store: JsonStore,
  collection: string,
  uploadId: string,
  value: T
) {
  await writeUploadOwnedValue(store, collection, uploadId, uploadId, value);
}

async function writeUploadOwnedValue<T>(
  store: JsonStore,
  collection: string,
  recordId: string,
  uploadId: string,
  value: T
) {
  await assertUploadWritable(store, uploadId);
  await store.write(collection, recordId, value);
  await assertUploadWritableAfterWrite(store, uploadId, () => store.delete(collection, recordId));
}

async function readRequiredUploadArray<T>(store: JsonStore, collection: string, uploadId: string) {
  const value = await store.read<unknown>(collection, uploadId);
  if (!Array.isArray(value)) {
    throw new Error(`Evaluation audit could not read retained ${collection}`);
  }
  return value as T[];
}

async function readResumableTranscriptSegments(
  store: JsonStore,
  uploadId: string,
  executionMode: ProcessingJob["executionMode"]
) {
  if (executionMode !== "queue") {
    return null;
  }
  const stored = await store.read<unknown>("segments", uploadId);
  if (stored === null) {
    return null;
  }
  const parsed = TranscriptSegmentSchema.array().safeParse(stored);
  if (!parsed.success || parsed.data.some((segment) => segment.uploadId !== uploadId)) {
    console.warn(`[transcription] resume artifact rejected upload_id=${uploadId}`);
    return null;
  }
  return parsed.data;
}

function requireUploadFilePath(upload: StoredUpload) {
  if (!upload.filePath) {
    throw new Error("Uploaded audio file is missing");
  }

  return upload.filePath;
}

async function deleteUploadedAudioFile(upload: StoredUpload) {
  if (!upload.filePath) {
    return;
  }

  await fs.rm(upload.filePath, { force: true });
}

function stripUploadFilePath(upload: StoredUpload): StoredUpload {
  const { filePath: _filePath, ...uploadWithoutFilePath } = upload;
  return uploadWithoutFilePath;
}

type TimedAnalysisStage<T> = {
  value: T;
  elapsedMs: number;
  fallback: boolean;
};

function safeErrorName(error: unknown) {
  return error instanceof Error ? error.name : "unknown";
}

function safeErrorCode(error: unknown) {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Za-z0-9_-]+$/.test(error.code)
    ? error.code
    : "unknown";
}

async function runTimedAnalysisStage<T>(input: {
  name: "audio_insight" | "acoustic" | "emotion";
  execute: () => Promise<T>;
  fallback: (error: unknown) => Promise<T> | T;
  onError: (error: unknown, elapsedMs: number) => void;
}): Promise<TimedAnalysisStage<T>> {
  const startedAt = Date.now();
  try {
    const value = await input.execute();
    const elapsedMs = Date.now() - startedAt;
    console.info(
      `[analysis-parallel] stage=${input.name} completed=true elapsed_ms=${elapsedMs} fallback=false`
    );
    return { value, elapsedMs, fallback: false };
  } catch (error) {
    input.onError(error, Date.now() - startedAt);
    const value = await input.fallback(error);
    const elapsedMs = Date.now() - startedAt;
    console.info(
      `[analysis-parallel] stage=${input.name} completed=true elapsed_ms=${elapsedMs} fallback=true`
    );
    return { value, elapsedMs, fallback: true };
  }
}

async function extractAcousticFeatures(input: {
  filePath: string;
  segments: TranscriptSegment[];
  extractor?: (input: {
    filePath: string;
    segments: TranscriptSegment[];
  }) => Promise<AcousticSegmentFeature[]>;
}) {
  console.info(`[ffmpeg-features] start segments=${input.segments.length}`);
  const startedAt = Date.now();
  const features = await (input.extractor ?? extractFfmpegAcousticFeatures)({
    filePath: input.filePath,
    segments: input.segments
  });
  console.info(
    `[ffmpeg-features] completed count=${features.length} elapsed_ms=${Date.now() - startedAt}`
  );
  return features;
}

function mergeExternalEmotionEvidence(audioInsights: AudioInsight[], externalEmotionEvidence: EmotionEvidence[]) {
  if (externalEmotionEvidence.length === 0) {
    return audioInsights;
  }

  return audioInsights.map((insight) => ({
    ...insight,
    emotionEvidence: [
      ...(insight.emotionEvidence ?? []),
      ...externalEmotionEvidence.filter((item) =>
        item.sourceSegmentIds.some((segmentId) => insight.sourceSegmentIds.includes(segmentId))
      )
    ]
  }));
}

async function generateRelationshipSignals(input: {
  upload: StoredUpload;
  segments: TranscriptSegment[];
  transcriptChunks: import("@/lib/domain/chunks").TranscriptChunk[];
  audioInsights: AudioInsight[];
  semanticSegments: SemanticSegment[];
  provider?: RelationshipSignalProvider;
  analysisCheckpoint?: {
    store: JsonAnalysisChunkCheckpointStore;
    userId: string;
  };
  evaluationRawResponseCapture?: boolean;
  now?: () => string;
}) {
  try {
    return await processRelationshipSignalChunks({
      uploadId: input.upload.id,
      recordingDate: input.upload.recordingDate,
      transcriptChunks: input.transcriptChunks,
      segments: input.segments,
      audioInsights: input.audioInsights,
      semanticSegments: input.semanticSegments,
      provider: input.provider ?? getRelationshipSignalProvider(),
      options: {
        evaluationRawResponseCapture: input.evaluationRawResponseCapture === true,
        ...(input.analysisCheckpoint ? { analysisCheckpoint: input.analysisCheckpoint } : {}),
        ...(input.now ? { now: input.now } : {})
      }
    });
  } catch (error) {
    console.warn(
      "[relationship signal fallback] relationship signal extraction failed; empty cards will be stored.",
      error instanceof Error ? error.message : error
    );
    return {
      cards: [],
      candidates: [],
      candidateIdsByCardId: {},
      analysisChunks: [],
      stats: {
        chunkCount: input.transcriptChunks.length,
        completedChunks: 0,
        failedChunks: input.transcriptChunks.length,
        fallbackChunks: 0,
        candidateCount: 0,
        rejectedCandidates: 0,
        timeoutChunks: 0,
        invalidJsonChunks: 0,
        parseFailureChunks: 0,
        validationFailureChunks: 0,
        providerFailureChunks: input.transcriptChunks.length,
        mergedCandidateCount: 0,
        candidateValidationRejected: 0,
        qualityRejectedCandidates: 0,
        clusterRejected: 0,
        normalizationRejected: 0,
        selectionRejected: 0,
        cardCount: 0,
        parallelDurationMs: 0,
        reducerDurationMs: 0
      }
    };
  }
}

function updateMemoryIndex(input: {
  userId?: string;
  upload: StoredUpload;
  segments: TranscriptSegment[];
  briefItems: BriefItem[];
  semanticSegments: SemanticSegment[];
  relationshipSignals: RelationshipSignalCard[];
  relationshipLifecycle?: {
    edges: import("@/lib/server/relationship-signals/lifecycle/types").RelationshipLifecycleEdge[];
    candidateIdsByCardId?: Record<string, string[]>;
  };
  repository?: Pick<MemoryRepository, "replaceUploadMemories">;
  now?: string;
}): EvaluationMemoryIndexStageAudit {
  if (!input.userId) {
    return { status: "skipped", reason: "missing_user_id" };
  }

  try {
    const extraction = extractUploadMemoriesWithAudit({
      userId: input.userId,
      uploadId: input.upload.id,
      recordingDate: input.upload.recordingDate,
      segments: input.segments,
      briefItems: input.briefItems,
      semanticSegments: input.semanticSegments,
      relationshipSignals: input.relationshipSignals,
      ...(input.relationshipLifecycle ? { relationshipLifecycle: input.relationshipLifecycle } : {}),
      ...(input.now ? { now: input.now } : {})
    });
    const repository = input.repository ?? getMemoryRepository();
    console.info(
      `[memory-owner] upload_id=${input.upload.id} known=${extraction.audit.ownerAttribution.knownOwners} local=${extraction.audit.ownerAttribution.localSpeakerOwners} unknown=${extraction.audit.ownerAttribution.unknownOwners} shared=${extraction.audit.ownerAttribution.sharedMemories}`
    );
    const result = repository.replaceUploadMemories({
      userId: input.userId,
      uploadId: input.upload.id,
      sourceSegments: input.segments,
      memories: extraction.memories,
      ownerAttributions: extraction.ownerAttributions
    });
    console.info(
      `[memory-index] updated user_id=${input.userId} upload_id=${input.upload.id} input=${result.inputCount} memories=${result.memoryCount} merged=${result.mergedCount} relations=${result.relationCount}`
    );
    console.info(
      `[memory-admission] upload_id=${input.upload.id} candidates=${extraction.audit.candidateCount} persisted=${extraction.audit.persistedCount} rejected=${extraction.audit.rejectedCount} relationship_daily_only=${extraction.audit.relationshipSignals.filter((item) => item.memoryTier === "daily_only").length} relationship_long_term=${extraction.audit.relationshipSignals.filter((item) => item.memoryTier === "long_term").length} preference_candidates=${extraction.audit.preferenceCandidates.length}`
    );
    return {
      status: "completed",
      update: result,
      admission: extraction.audit
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    console.warn(
      "[memory-index] update failed; upload processing will continue.",
      message
    );
    return {
      status: "failed",
      error: message.slice(0, 300)
    };
  }
}

type EvaluationMemoryAuditState = {
  status: "completed" | "skipped" | "failed";
  error?: string;
  memories: MemoryItem[];
  relations: MemoryRelation[] | null;
  orphanEvidenceCount: number | null;
  memoriesWithoutEvidenceCount: number | null;
};

function collectEvaluationMemoryAudit(input: {
  userId?: string;
  stage: EvaluationMemoryIndexStageAudit;
  repository?: Pick<MemoryRepository, "getRelevantMemories">;
}): EvaluationMemoryAuditState {
  if (!input.userId) {
    return {
      status: "skipped",
      memories: [],
      relations: null,
      orphanEvidenceCount: null,
      memoriesWithoutEvidenceCount: null
    };
  }
  if (input.stage.status === "failed") {
    return {
      status: "failed",
      error: input.stage.error,
      memories: [],
      relations: null,
      orphanEvidenceCount: null,
      memoriesWithoutEvidenceCount: null
    };
  }
  if (input.stage.status === "skipped") {
    return {
      status: "skipped",
      memories: [],
      relations: null,
      orphanEvidenceCount: null,
      memoriesWithoutEvidenceCount: null
    };
  }

  try {
    const repository = input.repository ?? getMemoryRepository();
    const memories = repository.getRelevantMemories({ userId: input.userId, limit: 10_000 });
    const relationReader = (repository as Partial<MemoryRepository>).getMemoryRelations;
    const relations = relationReader ? relationReader.call(repository, input.userId) : null;
    const orphanEvidenceCount = input.repository ? null : Number((getMemoryDatabase().prepare(`
          SELECT COUNT(*) AS count FROM memory_evidence e
          LEFT JOIN memory_items m ON m.id = e.memory_id
          WHERE m.id IS NULL
        `).get() as { count: number }).count);
    const memoriesWithoutEvidenceCount = input.repository
      ? memories.filter((memory) => memory.evidence.length === 0).length
      : Number((getMemoryDatabase().prepare(`
          SELECT COUNT(*) AS count FROM memory_items m
          LEFT JOIN memory_evidence e ON e.memory_id = m.id
          WHERE m.user_id = ? AND e.id IS NULL
        `).get(input.userId) as { count: number }).count);
    return {
      status: "completed",
      memories,
      relations,
      orphanEvidenceCount,
      memoriesWithoutEvidenceCount
    };
  } catch (error) {
    return {
      status: "failed",
      error: (error instanceof Error ? error.message : "memory audit failed").slice(0, 300),
      memories: [],
      relations: null,
      orphanEvidenceCount: null,
      memoriesWithoutEvidenceCount: null
    };
  }
}

async function generateCurrentProactiveInsightCache(input: {
  userId?: string;
  upload: StoredUpload;
  segments: TranscriptSegment[];
  audioInsights: AudioInsight[];
  semanticSegments: SemanticSegment[];
  briefItems: BriefItem[];
  relationshipSignals: RelationshipSignalCard[];
  memoryRepository?: Pick<MemoryRepository, "getRelevantMemories">;
  memoryRelevanceJudge?: MemoryRelevanceJudge;
  proactiveInsightProvider?: ProactiveInsightProvider;
  generatedAt?: string;
}): Promise<ProactiveInsightCacheDocument> {
  const cacheId = proactiveInsightCacheIdForUpload(input.upload.id);
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  let sourceFingerprint = "context_unavailable";

  try {
    const contextResult = buildProactiveInsightContext({
      scope: "current",
      uploadId: input.upload.id,
      recordingDate: input.upload.recordingDate,
      segments: input.segments,
      relationshipSignals: input.relationshipSignals,
      briefItems: input.briefItems,
      semanticSegments: input.semanticSegments,
      audioInsights: input.audioInsights
    });
    let memoryContext = emptyProactiveInsightMemoryContext({
      scope: "current",
      currentUploadId: input.upload.id
    });
    if (input.userId) {
      try {
        memoryContext = buildProactiveInsightMemoryContext({
          userId: input.userId,
          scope: "current",
          currentUploadId: input.upload.id,
          ...(input.memoryRepository ? { repository: input.memoryRepository } : {})
        });
      } catch (error) {
        console.warn(
          "[proactive-insights] memory context unavailable; current evidence will still be used.",
          error instanceof Error ? error.message : "unknown_error"
        );
      }
    }
    const relevanceResult = await applyMemoryRelevanceGate({
      context: contextResult.context,
      memoryContext,
      ...(input.memoryRelevanceJudge ? { judge: input.memoryRelevanceJudge } : {})
    });
    memoryContext = relevanceResult.memoryContext;
    sourceFingerprint = combineProactiveInsightSourceFingerprint(
      contextResult.sourceFingerprint,
      memoryContext
    );
    const result = await (input.proactiveInsightProvider ?? getProactiveInsightProvider()).generate({
      context: contextResult.context,
      memoryContext,
      sourceFingerprint,
      createdAt: generatedAt
    });

    return ProactiveInsightCacheDocumentSchema.parse({
      schemaVersion: 1,
      cacheId,
      scope: "current",
      status: result.status,
      sourceFingerprint: result.sourceFingerprint,
      generatedAt,
      provider: result.provider,
      model: result.model,
      elapsedMs: result.elapsedMs,
      failureCode: result.failureCode,
      items: result.items
    });
  } catch {
    console.warn("[proactive-insights] unexpected provider failure; rule suggestions will be used.");
    return ProactiveInsightCacheDocumentSchema.parse({
      schemaVersion: 1,
      cacheId,
      scope: "current",
      status: "fallback",
      sourceFingerprint,
      generatedAt,
      elapsedMs: 0,
      failureCode: "provider_error",
      items: []
    });
  }
}

function logExtractionProgress(event: ExtractionProgressEvent) {
  if (event.phase === "planned") {
    console.info(
      `[extraction] planned segments=${event.segmentCount} input_chars=${event.inputChars} input_bytes=${event.inputBytes} estimated_tokens=${event.estimatedTokensMin}-${event.estimatedTokensMax} chunks=${event.chunkCount} oversized_chunks=${event.oversizedChunkCount} long_form=${event.longForm}`
    );
    return;
  }
  if (event.phase === "chunk_started") {
    console.info(
      `[extraction] chunk started chunk=${event.chunkIndex}/${event.chunkCount} segments=${event.segmentCount} input_chars=${event.inputChars} range_seconds=${event.startSeconds}-${event.endSeconds}`
    );
    return;
  }
  if (event.phase === "chunk_completed") {
    console.info(
      `[extraction] chunk completed chunk=${event.chunkIndex}/${event.chunkCount} elapsed_ms=${event.elapsedMs} items=${event.itemCount} provider=${event.provider}`
    );
    return;
  }
  if (event.phase === "chunk_fallback") {
    console.info(
      `[extraction] chunk fallback chunk=${event.chunkIndex}/${event.chunkCount} elapsed_ms=${event.elapsedMs} items=${event.itemCount} reason=${event.reason}`
    );
    return;
  }
  console.info(
    `[extraction] merged raw_items=${event.rawItemCount} valid_items=${event.validItemCount} deduplicated_items=${event.deduplicatedItemCount} final_items=${event.finalItemCount} fallback_chunks=${event.fallbackChunks} elapsed_ms=${event.elapsedMs}`
  );
}

function extractionJobProgress(event: ExtractionProgressEvent) {
  if (event.phase !== "chunk_completed" && event.phase !== "chunk_fallback") {
    return null;
  }
  if (event.chunkCount <= 0) {
    return 70;
  }
  return Math.min(90, 70 + Math.floor(((event.completedCount ?? event.chunkIndex) / event.chunkCount) * 20));
}

export async function processUpload(input: ProcessUploadInput): Promise<ProcessUploadResult> {
  assertProcessUploadDependenciesAllowed(input.dependencies);
  const store = input.store ?? appStore;
  const upload = await assertUploadWritable(store, input.uploadId);
  const evaluationRetention = isEvaluationRetentionUpload(upload);
  const checkpointUserId = input.userId ?? "local-user";
  const analysisCheckpointStore = new JsonAnalysisChunkCheckpointStore(store);
  const now = () => input.dependencies?.now?.() ?? new Date().toISOString();
  const deleteMemoriesOnCancellation = input.userId
    ? () => {
        if (input.memoryRepository) {
          input.memoryRepository.deleteByUpload?.(input.userId!, upload.id);
        } else {
          getMemoryRepository().deleteByUpload(input.userId!, upload.id);
        }
      }
    : undefined;
  const pipelineStartedAt = Date.now();
  let activeStage = "initializing";
  let job: ProcessingJob | null = null;

  try {
    console.info(`[pipeline] start upload_id=${upload.id}`);
    job = await createUploadJob(store, upload.id);
    job = await updateUploadJob(store, job, {
      status: "transcribing",
      progress: 25,
      startedAt: now(),
      finishedAt: undefined,
      errorCode: undefined,
      errorMessage: undefined
    }, input.onJobUpdate);

    const uploadFilePath = requireUploadFilePath(upload);
    activeStage = "transcription";
    const transcriptionStartedAt = Date.now();
    console.info("[transcription] start");
    const transcriptionInput = {
      uploadId: upload.id,
      filePath: uploadFilePath,
      mimeType: upload.mimeType
    };
    let segments = await readResumableTranscriptSegments(store, upload.id, job.executionMode);
    if (segments) {
      console.info(
        `[transcription] resume hit upload_id=${upload.id} segments=${segments.length}`
      );
    } else if (input.dependencies?.transcriptionProcessor) {
      segments = await input.dependencies.transcriptionProcessor({
        ...transcriptionInput,
        store,
        userId: input.userId
      });
    } else if (input.dependencies?.transcriptionProvider) {
      segments = await input.dependencies.transcriptionProvider.transcribe(transcriptionInput);
    } else {
      let progressQueue = Promise.resolve();
      segments = await transcribeConfiguredAudio({
        ...transcriptionInput,
        store,
        userId: input.userId,
        onChunkProgress: (event) => {
          progressQueue = progressQueue.then(async () => {
            if (!job || event.total <= 0) {
              return;
            }
            const settled = event.completed + event.failed;
            const progress = Math.min(60, 25 + Math.floor((settled / event.total) * 35));
            if (progress > job.progress) {
              job = await updateUploadJob(store, job, { progress }, input.onJobUpdate);
            }
          });
          return progressQueue;
        }
      });
      await progressQueue;
    }
    await writeUploadScopedValue(store, "segments", upload.id, segments);
    const speakerCount = new Set(segments.map((segment) => segment.speaker).filter(Boolean)).size;
    console.info(
      `[transcription] completed segments=${segments.length} speakers=${speakerCount} elapsed_ms=${Date.now() - transcriptionStartedAt}`
    );

    let checkpointTranscriptChunks = [] as import("@/lib/domain/chunks").TranscriptChunk[];
    try {
      checkpointTranscriptChunks = await new JsonChunkCheckpointStore(store).listTranscriptChunks(upload.id);
    } catch (error) {
      console.warn(
        `[analysis-chunks] checkpoint read failed upload_id=${upload.id} error_name=${safeErrorName(error)}`
      );
    }
    const transcriptChunks = resolveAnalysisTranscriptChunks({
      uploadId: upload.id,
      segments,
      checkpointChunks: checkpointTranscriptChunks,
      now
    });
    const analysisChunkSource = transcriptChunks.every(
      (chunk) => chunk.metadata?.analysisSource === "asr_checkpoint"
    )
      ? "asr_checkpoint"
      : "merged_transcript";
    console.info(
      `[analysis-chunks] ready upload_id=${upload.id} chunks=${transcriptChunks.length} source=${analysisChunkSource}`
    );

    activeStage = "analysis-parallel";
    const audioInsightsStartedAt = Date.now();
    console.info(`[audio-insights] start segments=${segments.length}`);
    const analysisParallelStartedAt = Date.now();
    console.info(`[analysis-parallel] started segments=${segments.length}`);
    const audioInsightProviders = input.dependencies?.audioInsightProvider
      ? { provider: input.dependencies.audioInsightProvider, fallbackProvider: ruleAudioInsightProvider }
      : getAudioInsightChunkProviders();
    const [audioInsightStage, acousticStage, emotionStage] = await Promise.all([
      runTimedAnalysisStage({
        name: "audio_insight",
        execute: () => processAudioInsightChunks({
          uploadId: upload.id,
          transcriptChunks,
          segments,
          provider: audioInsightProviders.provider,
          fallbackProvider: audioInsightProviders.fallbackProvider,
          options: {
            now,
            analysisCheckpoint: {
              store: analysisCheckpointStore,
              userId: checkpointUserId
            }
          }
        }),
        fallback: async () => ({
          insights: await ruleAudioInsightProvider.analyze(upload.id, segments),
          analysisChunks: [],
          stats: {
            chunkCount: transcriptChunks.length,
            completedChunks: 0,
            failedChunks: transcriptChunks.length,
            fallbackChunks: transcriptChunks.length,
            retrySuccessChunks: 0,
            timeoutChunks: 0,
            invalidJsonChunks: 0,
            inputInsightCount: 0,
            outputInsightCount: 0,
            rejectedInsights: 0,
            duplicateRemoved: 0,
            parallelDurationMs: 0,
            mergeDurationMs: 0,
            checkpointHits: 0,
            checkpointMisses: transcriptChunks.length,
            checkpointStale: 0,
            checkpointCorrupt: 0
          }
        }),
        onError: (error) => {
          console.warn(
            "[analysis-parallel] stage=audio_insight failed; rule fallback will be used.",
            safeErrorName(error)
          );
        }
      }),
      runTimedAnalysisStage({
        name: "acoustic",
        execute: () =>
          extractAcousticFeatures({
            filePath: uploadFilePath,
            segments,
            extractor: input.dependencies?.acousticFeatureExtractor
          }),
        fallback: () => [],
        onError: (error, elapsedMs) => {
          console.info(
            `[ffmpeg-features] failed elapsed_ms=${elapsedMs} error_name=${safeErrorName(error)} error_code=${safeErrorCode(error)}`
          );
          console.warn(
            "[audio feature fallback] ffmpeg acoustic feature extraction failed; text-based audio insights will be used.",
            safeErrorName(error)
          );
        }
      }),
      runTimedAnalysisStage({
        name: "emotion",
        execute: async () => {
          const emotionSignalsStartedAt = Date.now();
          console.info(`[emotion-signals] start segments=${segments.length}`);
          const evidence = await (
            input.dependencies?.emotionSignalProvider ?? getEmotionSignalProvider()
          ).analyze({
            uploadId: upload.id,
            filePath: uploadFilePath,
            mimeType: upload.mimeType,
            segments
          });
          console.info(
            `[emotion-signals] completed count=${evidence.length} elapsed_ms=${Date.now() - emotionSignalsStartedAt}`
          );
          return evidence;
        },
        fallback: () => [],
        onError: (error, elapsedMs) => {
          console.info(
            `[emotion-signals] failed elapsed_ms=${elapsedMs} error_name=${safeErrorName(error)}`
          );
          console.warn(
            "[emotion signal fallback] emotion signal analysis failed; existing audio insight evidence will be used.",
            safeErrorName(error)
          );
        }
      })
    ]);
    const acousticAudioInsights = applyAcousticFeaturesToAudioInsights(
      audioInsightStage.value.insights,
      acousticStage.value
    );
    const audioInsights = applyEmotionEvidenceToAudioInsights(
      mergeExternalEmotionEvidence(acousticAudioInsights, emotionStage.value)
    );
    console.info(
      `[analysis-parallel] completed audio_insight_duration_ms=${audioInsightStage.elapsedMs} acoustic_duration_ms=${acousticStage.elapsedMs} emotion_duration_ms=${emotionStage.elapsedMs} elapsed_ms=${Date.now() - analysisParallelStartedAt} audio_insight_fallback=${audioInsightStage.fallback || audioInsightStage.value.stats.fallbackChunks > 0} acoustic_fallback=${acousticStage.fallback} emotion_fallback=${emotionStage.fallback}`
    );
    await writeUploadScopedValue(store, "audio-insights", upload.id, audioInsights);
    console.info(
      `[audio-insights] completed count=${audioInsights.length} elapsed_ms=${Date.now() - audioInsightsStartedAt}`
    );

    activeStage = "semantic-segments";
    const semanticSegmentsStartedAt = Date.now();
    console.info(`[semantic-segments] start segments=${segments.length}`);
    const semanticSegments = buildSemanticSegments(upload.id, segments);
    await writeUploadScopedValue(store, "semantic-segments", upload.id, semanticSegments);
    console.info(
      `[semantic-segments] completed count=${semanticSegments.length} elapsed_ms=${Date.now() - semanticSegmentsStartedAt}`
    );

    job = await updateUploadJob(store, job, {
      status: "extracting",
      progress: 70
    }, input.onJobUpdate);

    activeStage = "extraction";
    const extractionStartedAt = Date.now();
    console.info(
      `[extraction] start segments=${segments.length} semantic_segments=${semanticSegments.length}`
    );
    const briefItems = await (
      input.dependencies?.extractionProvider ?? getExtractionProvider()
    ).extract(upload.id, segments, {
      semanticSegments,
      evaluationRawResponseCapture: evaluationRetention,
      analysisCheckpoint: {
        store: analysisCheckpointStore,
        userId: checkpointUserId,
        recordingDate: upload.recordingDate
      },
      onProgress: async (event) => {
        logExtractionProgress(event);
        const progress = extractionJobProgress(event);
        if (progress === null || !job || progress <= job.progress) {
          return;
        }
        job = await updateUploadJob(store, job, { progress }, input.onJobUpdate);
      }
    });
    await writeUploadScopedValue(store, "brief-items", upload.id, briefItems);
    console.info(
      `[extraction] completed count=${briefItems.length} elapsed_ms=${Date.now() - extractionStartedAt}`
    );
    if (job.progress < 92) {
      job = await updateUploadJob(store, job, { progress: 92 }, input.onJobUpdate);
    }

    activeStage = "relationship-signals";
    const relationshipSignalsStartedAt = Date.now();
    console.info(`[relationship-signals] start segments=${segments.length}`);
    const relationshipSignalResult = await generateRelationshipSignals({
      upload,
      segments,
      transcriptChunks,
      audioInsights,
      semanticSegments,
      provider: input.dependencies?.relationshipSignalProvider,
      analysisCheckpoint: {
        store: analysisCheckpointStore,
        userId: checkpointUserId
      },
      evaluationRawResponseCapture: evaluationRetention,
      now
    });
    const relationshipSignals = relationshipSignalResult.cards;
    await writeUploadScopedValue(store, "relationship-signals", upload.id, relationshipSignals);
    console.info(
      `[relationship-signals] completed count=${relationshipSignals.length} elapsed_ms=${Date.now() - relationshipSignalsStartedAt}`
    );

    const lifecycleSignals = relationshipSignalResult.candidates.length > 0
      ? relationshipLifecycleSignalsFromCandidates({
          candidates: relationshipSignalResult.candidates,
          segments,
          recordingDate: upload.recordingDate
        })
      : relationshipLifecycleSignalsFromCards(relationshipSignals);
    const relationshipLifecycle = resolveRelationshipLifecycles(lifecycleSignals);
    const relationshipLifecycleArtifact = {
      version: 1 as const,
      uploadId: upload.id,
      generatedAt: now(),
      inputSource: relationshipSignalResult.candidates.length > 0 ? "candidates" as const : "cards" as const,
      signalCount: lifecycleSignals.length,
      candidateIdsByCardId: relationshipSignalResult.candidateIdsByCardId,
      edges: relationshipLifecycle.edges,
      audit: relationshipLifecycle.audit
    };
    await writeUploadScopedValue(store, "relationship-lifecycle", upload.id, relationshipLifecycleArtifact);
    console.info(
      `[relationship-lifecycle] pairs_checked=${relationshipLifecycle.audit.candidatePairsChecked} edges_created=${relationshipLifecycle.edges.length} rejected_matches=${relationshipLifecycle.audit.matches.filter((match) => !match.accepted).length}`
    );

    activeStage = "memory-index";
    const memoryIndexStartedAt = Date.now();
    console.info("[memory-index] start");
    const memoryIndexStage = updateMemoryIndex({
      userId: input.userId,
      upload,
      segments,
      briefItems,
      semanticSegments,
      relationshipSignals,
      relationshipLifecycle: {
        edges: relationshipLifecycle.edges,
        candidateIdsByCardId: relationshipSignalResult.candidateIdsByCardId
      },
      repository: input.memoryRepository,
      now: now()
    });
    if (memoryIndexStage.status === "completed") {
      const admissionAudit = memoryIndexStage.admission as MemoryExtractionAudit;
      await writeUploadScopedValue(
        store,
        "memory-owner-audits",
        upload.id,
        admissionAudit.ownerAttribution
      );
    }
    console.info(`[memory-index] completed elapsed_ms=${Date.now() - memoryIndexStartedAt}`);

    activeStage = "proactive-insights";
    const proactiveInsightsStartedAt = Date.now();
    console.info("[proactive-insights] start");
    const proactiveInsightCache = await generateCurrentProactiveInsightCache({
      userId: input.userId,
      upload,
      segments,
      audioInsights,
      semanticSegments,
      briefItems,
      relationshipSignals,
      memoryRepository: input.memoryRepository,
      memoryRelevanceJudge: input.dependencies?.memoryRelevanceJudge,
      proactiveInsightProvider: input.dependencies?.proactiveInsightProvider,
      generatedAt: now()
    });
    let proactiveInsights = proactiveInsightCache.items;
    try {
      await writeUploadOwnedValue(
        store,
        "proactive-insights",
        proactiveInsightCache.cacheId,
        upload.id,
        proactiveInsightCache
      );
    } catch (error) {
      if (isUploadProcessingCancelled(error)) {
        throw error;
      }
      console.warn("[proactive-insights] cache write failed; rule suggestions will be used.");
      proactiveInsights = [];
    }
    console.info(
      `[proactive-insights] completed count=${proactiveInsights.length} status=${proactiveInsightCache.status} elapsed_ms=${Date.now() - proactiveInsightsStartedAt}`
    );
    if (job.progress < 96) {
      job = await updateUploadJob(store, job, { progress: 96 }, input.onJobUpdate);
    }

    const currentUpload = await assertUploadWritable(store, upload.id);
    if (evaluationRetention) {
      const retainedUpload = await store.read<StoredUpload>("uploads", upload.id);
      if (!retainedUpload || retainedUpload.evaluationRetention !== true) {
        throw new Error("Evaluation audit could not read retained upload record");
      }
      const proactiveCacheRaw = await store.read<unknown>(
        "proactive-insights",
        proactiveInsightCacheIdForUpload(upload.id)
      );
      const retainedProactiveCache = ProactiveInsightCacheDocumentSchema.parse(proactiveCacheRaw);
      const chunkCheckpointStore = new JsonChunkCheckpointStore(store);
      const [
        retainedSegments,
        retainedAudioInsights,
        retainedSemanticSegments,
        retainedBriefItems,
        retainedRelationshipSignals,
        audioChunks,
        retainedTranscriptChunks,
        analysisCheckpoints
      ] = await Promise.all([
        readRequiredUploadArray<TranscriptSegment>(store, "segments", upload.id),
        readRequiredUploadArray<AudioInsight>(store, "audio-insights", upload.id),
        readRequiredUploadArray<SemanticSegment>(store, "semantic-segments", upload.id),
        readRequiredUploadArray<BriefItem>(store, "brief-items", upload.id),
        readRequiredUploadArray<RelationshipSignalCard>(store, "relationship-signals", upload.id),
        chunkCheckpointStore.listAudioChunks(upload.id),
        chunkCheckpointStore.listTranscriptChunks(upload.id),
        analysisCheckpointStore.list({ userId: checkpointUserId, uploadId: upload.id })
      ]);
      let uploadFileExists = false;
      if (currentUpload.filePath) {
        try {
          await fs.access(currentUpload.filePath);
          uploadFileExists = true;
        } catch {
          uploadFileExists = false;
        }
      }
      const memoryAudit = collectEvaluationMemoryAudit({
        stage: memoryIndexStage,
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.memoryRepository ? { repository: input.memoryRepository } : {})
      });
      const reducerAudit = "reducerAudit" in relationshipSignalResult
        ? relationshipSignalResult.reducerAudit
        : null;
      const providerRawResponses = await collectProviderRawResponseCaptureReport({
        uploadId: upload.id,
        evaluationRetention
      });
      const auditReport = buildEvaluationAuditReport({
        generatedAt: now(),
        uploadId: upload.id,
        ...(input.userId ? { userId: input.userId } : {}),
        recordingDate: upload.recordingDate,
        uploadFilePathRetained: Boolean(retainedUpload.filePath),
        uploadFileExists,
        segments: retainedSegments,
        audioInsights: retainedAudioInsights,
        semanticSegments: retainedSemanticSegments,
        briefItems: retainedBriefItems,
        relationshipCards: retainedRelationshipSignals,
        proactiveInsights: retainedProactiveCache.items,
        audioChunks,
        transcriptChunks: retainedTranscriptChunks,
        analysisCheckpoints,
        relationshipStats: relationshipSignalResult.stats,
        relationshipReducerAudit: reducerAudit,
        relationshipLifecycleAudit: relationshipLifecycle.audit,
        memoryStage: memoryIndexStage,
        memoryAuditStatus: memoryAudit.status,
        ...(memoryAudit.error ? { memoryAuditError: memoryAudit.error } : {}),
        memories: memoryAudit.memories,
        memoryRelations: memoryAudit.relations,
        orphanEvidenceCount: memoryAudit.orphanEvidenceCount,
        memoriesWithoutEvidenceCount: memoryAudit.memoriesWithoutEvidenceCount,
        providerRawResponses
      });
      await writeUploadScopedValue(store, "evaluation-reports", upload.id, auditReport);
      await writeUploadScopedValue(store, "uploads", upload.id, { ...currentUpload, status: "ready" });
      console.info(
        `[evaluation-retention] ready artifacts retained upload_id=${upload.id} audio_retained=${Boolean(currentUpload.filePath)} audio_exists=${uploadFileExists} analysis_checkpoints=${analysisCheckpoints.length} memory_items=${memoryAudit.memories.length} evidence=${auditReport.evidenceFirst.evidenceCount} report_id=${upload.id}`
      );
    } else {
      // Persist the terminal upload state before removing the only retry input.
      // A worker crash after this write can be reconciled as ready instead of
      // misclassifying the upload as audio_missing.
      await writeUploadScopedValue(store, "uploads", upload.id, { ...currentUpload, status: "ready" });
      await deleteUploadedAudioFile(currentUpload);
      await writeUploadScopedValue(store, "uploads", upload.id, stripUploadFilePath({ ...currentUpload, status: "ready" }));
    }

    job = await updateUploadJob(store, job, {
      status: "ready",
      progress: 100,
      finishedAt: now()
    }, input.onJobUpdate);

    console.info(
      `[pipeline] ready upload_id=${upload.id} segments=${segments.length} speakers=${speakerCount} audio_insights=${audioInsights.length} semantic_segments=${semanticSegments.length} brief_items=${briefItems.length} relationship_signals=${relationshipSignals.length} proactive_insights=${proactiveInsights.length} elapsed_ms=${Date.now() - pipelineStartedAt}`
    );

    return { job, segments, audioInsights, semanticSegments, briefItems, relationshipSignals, proactiveInsights };
  } catch (error) {
    console.info(
      `[pipeline] failed upload_id=${upload.id} stage=${activeStage} elapsed_ms=${Date.now() - pipelineStartedAt} error_name=${error instanceof Error ? error.name : "unknown"}`
    );
    if (isUploadProcessingCancelled(error)) {
      await cleanupProcessingArtifacts(
        store,
        upload.id,
        checkpointUserId,
        job,
        deleteMemoriesOnCancellation
      );
      throw error;
    }

    if (!job) {
      throw error;
    }

    const message = error instanceof Error ? error.message : "Unknown processing error";
    try {
      const currentUpload = await assertUploadWritable(store, upload.id);
      const failedJob = await updateUploadJob(store, job, {
        status: "failed",
        errorCode: "processing_failed",
        errorMessage: message,
        finishedAt: now()
      }, input.onJobUpdate);
      const failedUpload = {
        ...currentUpload,
        status: "failed" as const,
        errorCode: "processing_failed",
        errorMessage: message
      };
      await writeUploadScopedValue(
        store,
        "uploads",
        upload.id,
        failedUpload
      );
      const storedSegments = (await store.read<TranscriptSegment[]>("segments", upload.id)) ?? [];
      const storedAudioInsights = (await store.read<AudioInsight[]>("audio-insights", upload.id)) ?? [];
      const storedSemanticSegments = (await store.read<SemanticSegment[]>("semantic-segments", upload.id)) ?? [];
      const storedRelationshipSignals = (await store.read<RelationshipSignalCard[]>("relationship-signals", upload.id)) ?? [];
      const storedProactiveInsightCache = await store.read<unknown>(
        "proactive-insights",
        proactiveInsightCacheIdForUpload(upload.id)
      );
      const parsedProactiveInsightCache = ProactiveInsightCacheDocumentSchema.safeParse(storedProactiveInsightCache);

      return {
        job: failedJob,
        segments: storedSegments,
        audioInsights: storedAudioInsights,
        semanticSegments: storedSemanticSegments,
        briefItems: [],
        relationshipSignals: storedRelationshipSignals,
        proactiveInsights: parsedProactiveInsightCache.success ? parsedProactiveInsightCache.data.items : []
      };
    } catch (failureWriteError) {
      if (isUploadProcessingCancelled(failureWriteError)) {
        await cleanupProcessingArtifacts(
          store,
          upload.id,
          checkpointUserId,
          job,
          deleteMemoriesOnCancellation
        );
      }
      throw failureWriteError;
    }
  }
}
