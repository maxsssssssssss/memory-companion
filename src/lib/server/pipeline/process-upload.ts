import * as fs from "fs/promises";
import type { AudioInsight, AudioUpload, BriefItem, EmotionEvidence, ProcessingJob, RelationshipSignalCard, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
import {
  ProactiveInsightCacheDocumentSchema,
  proactiveInsightCacheIdForUpload,
  type ProactiveInsight,
  type ProactiveInsightCacheDocument
} from "@/lib/domain/proactive-insights";
import { applyAcousticFeaturesToAudioInsights } from "@/lib/processing/acoustic-features";
import { buildSemanticSegments } from "@/lib/processing/semantic-segments";
import { applyEmotionEvidenceToAudioInsights } from "@/lib/processing/emotion-evidence";
import { extractFfmpegAcousticFeatures } from "@/lib/server/audio-features/ffmpeg-acoustic-features";
import { getAudioInsightProvider } from "@/lib/server/audio-insights/provider";
import { getEmotionSignalProvider } from "@/lib/server/emotion-signals/provider";
import { getExtractionProvider, type ExtractionProgressEvent } from "@/lib/server/extraction/provider";
import { createJob, updateJob } from "@/lib/server/jobs/job-store";
import { extractUploadMemories, getMemoryRepository, type MemoryRepository } from "@/lib/server/memory";
import { applyMemoryRelevanceGate } from "@/lib/server/memory/relevance";
import { buildProactiveInsightContext } from "@/lib/server/proactive-insights/evidence";
import {
  buildProactiveInsightMemoryContext,
  combineProactiveInsightSourceFingerprint,
  emptyProactiveInsightMemoryContext
} from "@/lib/server/proactive-insights/memory-context";
import { getProactiveInsightProvider } from "@/lib/server/proactive-insights/provider";
import { getRelationshipSignalProvider } from "@/lib/server/relationship-signals/provider";
import type { JsonStore } from "@/lib/server/storage/json-store";
import { appStore } from "@/lib/server/storage/json-store";
import { getTranscriptionProvider } from "@/lib/server/transcription/provider";

type StoredUpload = AudioUpload & {
  filePath?: string;
  errorCode?: string;
  errorMessage?: string;
};

type DeletedUploadMarker = {
  uploadId: string;
  deletedAt: string;
};

export type ProcessUploadInput = {
  uploadId: string;
  store?: JsonStore;
  userId?: string;
  memoryRepository?: Pick<MemoryRepository, "replaceUploadMemories" | "getRelevantMemories">;
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

async function cleanupProcessingArtifacts(store: JsonStore, uploadId: string, job?: ProcessingJob | null) {
  await Promise.all([
    cleanupJobArtifacts(store, uploadId, job),
    store.delete("segments", uploadId),
    store.delete("audio-insights", uploadId),
    store.delete("semantic-segments", uploadId),
    store.delete("brief-items", uploadId),
    store.delete("relationship-signals", uploadId),
    store.delete("proactive-insights", proactiveInsightCacheIdForUpload(uploadId))
  ]);
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

async function updateUploadJob(store: JsonStore, job: ProcessingJob, patch: Partial<ProcessingJob>) {
  await assertUploadWritable(store, job.uploadId);
  const nextJob = await updateJob(store, job, patch);
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

async function enrichAudioInsightsWithAcousticFeatures(input: {
  filePath: string;
  segments: TranscriptSegment[];
  audioInsights: AudioInsight[];
}) {
  const startedAt = Date.now();
  console.info(`[ffmpeg-features] start segments=${input.segments.length}`);
  try {
    const features = await extractFfmpegAcousticFeatures({
      filePath: input.filePath,
      segments: input.segments
    });

    console.info(
      `[ffmpeg-features] completed count=${features.length} elapsed_ms=${Date.now() - startedAt}`
    );
    return applyAcousticFeaturesToAudioInsights(input.audioInsights, features);
  } catch (error) {
    const errorCode =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[A-Za-z0-9_-]+$/.test(error.code)
        ? error.code
        : "unknown";
    console.info(
      `[ffmpeg-features] failed elapsed_ms=${Date.now() - startedAt} error_name=${error instanceof Error ? error.name : "unknown"} error_code=${errorCode}`
    );
    console.warn("[audio feature fallback] ffmpeg acoustic feature extraction failed; text-based audio insights will be used.", error);
    return input.audioInsights;
  }
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
  audioInsights: AudioInsight[];
  semanticSegments: SemanticSegment[];
}) {
  try {
    return await getRelationshipSignalProvider().analyze({
      uploadId: input.upload.id,
      recordingDate: input.upload.recordingDate,
      segments: input.segments,
      audioInsights: input.audioInsights,
      semanticSegments: input.semanticSegments
    });
  } catch (error) {
    console.warn(
      "[relationship signal fallback] relationship signal extraction failed; empty cards will be stored.",
      error instanceof Error ? error.message : error
    );
    return [];
  }
}

function updateMemoryIndex(input: {
  userId?: string;
  upload: StoredUpload;
  segments: TranscriptSegment[];
  briefItems: BriefItem[];
  semanticSegments: SemanticSegment[];
  relationshipSignals: RelationshipSignalCard[];
  repository?: Pick<MemoryRepository, "replaceUploadMemories">;
}) {
  if (!input.userId) {
    return;
  }

  try {
    const memories = extractUploadMemories({
      userId: input.userId,
      uploadId: input.upload.id,
      recordingDate: input.upload.recordingDate,
      segments: input.segments,
      briefItems: input.briefItems,
      semanticSegments: input.semanticSegments,
      relationshipSignals: input.relationshipSignals
    });
    const repository = input.repository ?? getMemoryRepository();
    const result = repository.replaceUploadMemories({
      userId: input.userId,
      uploadId: input.upload.id,
      memories
    });
    console.info(
      `[memory-index] updated user_id=${input.userId} upload_id=${input.upload.id} input=${result.inputCount} memories=${result.memoryCount} merged=${result.mergedCount} relations=${result.relationCount}`
    );
  } catch (error) {
    console.warn(
      "[memory-index] update failed; upload processing will continue.",
      error instanceof Error ? error.message : "unknown_error"
    );
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
}): Promise<ProactiveInsightCacheDocument> {
  const cacheId = proactiveInsightCacheIdForUpload(input.upload.id);
  const generatedAt = new Date().toISOString();
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
      memoryContext
    });
    memoryContext = relevanceResult.memoryContext;
    sourceFingerprint = combineProactiveInsightSourceFingerprint(
      contextResult.sourceFingerprint,
      memoryContext
    );
    const result = await getProactiveInsightProvider().generate({
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
  return Math.min(90, 70 + Math.floor((event.chunkIndex / event.chunkCount) * 20));
}

export async function processUpload(input: ProcessUploadInput): Promise<ProcessUploadResult> {
  const store = input.store ?? appStore;
  const upload = await assertUploadWritable(store, input.uploadId);
  const pipelineStartedAt = Date.now();
  let activeStage = "initializing";
  let job: ProcessingJob | null = null;

  try {
    console.info(`[pipeline] start upload_id=${upload.id}`);
    job = await createUploadJob(store, upload.id);
    job = await updateUploadJob(store, job, {
      status: "transcribing",
      progress: 25,
      startedAt: new Date().toISOString()
    });

    const uploadFilePath = requireUploadFilePath(upload);
    activeStage = "transcription";
    const transcriptionStartedAt = Date.now();
    console.info("[transcription] start");
    const segments = await getTranscriptionProvider().transcribe({
      uploadId: upload.id,
      filePath: uploadFilePath,
      mimeType: upload.mimeType
    });
    await writeUploadScopedValue(store, "segments", upload.id, segments);
    const speakerCount = new Set(segments.map((segment) => segment.speaker).filter(Boolean)).size;
    console.info(
      `[transcription] completed segments=${segments.length} speakers=${speakerCount} elapsed_ms=${Date.now() - transcriptionStartedAt}`
    );

    activeStage = "audio-insights";
    const audioInsightsStartedAt = Date.now();
    console.info(`[audio-insights] start segments=${segments.length}`);
    const textAudioInsights = await getAudioInsightProvider().analyze(upload.id, segments);
    const acousticAudioInsights = await enrichAudioInsightsWithAcousticFeatures({
      filePath: uploadFilePath,
      segments,
      audioInsights: textAudioInsights
    });
    const emotionSignalsStartedAt = Date.now();
    console.info(`[emotion-signals] start segments=${segments.length}`);
    const externalEmotionEvidence = await getEmotionSignalProvider().analyze({
      uploadId: upload.id,
      filePath: uploadFilePath,
      mimeType: upload.mimeType,
      segments
    });
    console.info(
      `[emotion-signals] completed count=${externalEmotionEvidence.length} elapsed_ms=${Date.now() - emotionSignalsStartedAt}`
    );
    const audioInsights = applyEmotionEvidenceToAudioInsights(
      mergeExternalEmotionEvidence(acousticAudioInsights, externalEmotionEvidence)
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
    });

    activeStage = "extraction";
    const extractionStartedAt = Date.now();
    console.info(
      `[extraction] start segments=${segments.length} semantic_segments=${semanticSegments.length}`
    );
    const briefItems = await getExtractionProvider().extract(upload.id, segments, {
      semanticSegments,
      onProgress: async (event) => {
        logExtractionProgress(event);
        const progress = extractionJobProgress(event);
        if (progress === null || !job || progress <= job.progress) {
          return;
        }
        job = await updateUploadJob(store, job, { progress });
      }
    });
    await writeUploadScopedValue(store, "brief-items", upload.id, briefItems);
    console.info(
      `[extraction] completed count=${briefItems.length} elapsed_ms=${Date.now() - extractionStartedAt}`
    );
    if (job.progress < 92) {
      job = await updateUploadJob(store, job, { progress: 92 });
    }

    activeStage = "relationship-signals";
    const relationshipSignalsStartedAt = Date.now();
    console.info(`[relationship-signals] start segments=${segments.length}`);
    const relationshipSignals = await generateRelationshipSignals({
      upload,
      segments,
      audioInsights,
      semanticSegments
    });
    await writeUploadScopedValue(store, "relationship-signals", upload.id, relationshipSignals);
    console.info(
      `[relationship-signals] completed count=${relationshipSignals.length} elapsed_ms=${Date.now() - relationshipSignalsStartedAt}`
    );

    activeStage = "memory-index";
    const memoryIndexStartedAt = Date.now();
    console.info("[memory-index] start");
    updateMemoryIndex({
      userId: input.userId,
      upload,
      segments,
      briefItems,
      semanticSegments,
      relationshipSignals,
      repository: input.memoryRepository
    });
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
      memoryRepository: input.memoryRepository
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
      job = await updateUploadJob(store, job, { progress: 96 });
    }

    job = await updateUploadJob(store, job, {
      status: "ready",
      progress: 100,
      finishedAt: new Date().toISOString()
    });

    const currentUpload = await assertUploadWritable(store, upload.id);
    await deleteUploadedAudioFile(currentUpload);
    await writeUploadScopedValue(store, "uploads", upload.id, stripUploadFilePath({ ...currentUpload, status: "ready" }));

    console.info(
      `[pipeline] ready upload_id=${upload.id} segments=${segments.length} speakers=${speakerCount} audio_insights=${audioInsights.length} semantic_segments=${semanticSegments.length} brief_items=${briefItems.length} relationship_signals=${relationshipSignals.length} proactive_insights=${proactiveInsights.length} elapsed_ms=${Date.now() - pipelineStartedAt}`
    );

    return { job, segments, audioInsights, semanticSegments, briefItems, relationshipSignals, proactiveInsights };
  } catch (error) {
    console.info(
      `[pipeline] failed upload_id=${upload.id} stage=${activeStage} elapsed_ms=${Date.now() - pipelineStartedAt} error_name=${error instanceof Error ? error.name : "unknown"}`
    );
    if (isUploadProcessingCancelled(error)) {
      await cleanupProcessingArtifacts(store, upload.id, job);
      throw error;
    }

    if (!job) {
      throw error;
    }

    const message = error instanceof Error ? error.message : "Unknown processing error";
    try {
      const currentUpload = await assertUploadWritable(store, upload.id);
      await deleteUploadedAudioFile(currentUpload);
      const failedJob = await updateUploadJob(store, job, {
        status: "failed",
        errorCode: "processing_failed",
        errorMessage: message,
        finishedAt: new Date().toISOString()
      });
      await writeUploadScopedValue(store, "uploads", upload.id, stripUploadFilePath({
        ...currentUpload,
        status: "failed",
        errorCode: "processing_failed",
        errorMessage: message
      }));
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
        await cleanupProcessingArtifacts(store, upload.id, job);
      }
      throw failureWriteError;
    }
  }
}
