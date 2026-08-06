import type { TranscriptSegment } from "@/lib/domain/types";
import type { JsonStore } from "@/lib/server/storage/json-store";
import {
  createIdentityResolver,
  type IdentityResolver
} from "@/lib/server/speaker-identity/identity-resolver";
import {
  getTranscriptionProvider,
  getTranscriptionProviderRuntime,
  type TranscriptionInput
} from "../provider";
import { speakerAsrChunkTranscriptionAdapter } from "../speaker-asr-provider";
import type { ChunkTranscriptionAdapter } from "./adapter";
import {
  cleanupGeneratedAudioChunks,
  planAudioChunks,
  type AudioChunkPlannerInput
} from "./audio-planner";
import { JsonChunkCheckpointStore, type ChunkCheckpointStore } from "./checkpoint-store";
import { processAudioChunks, type ChunkSchedulerOptions } from "./scheduler";
import { mergeTranscriptChunks } from "./transcript-merge";

export type UploadTranscriptionInput = TranscriptionInput & {
  store: JsonStore;
  userId?: string;
  onChunkProgress?: ChunkSchedulerOptions["onProgress"];
};

export type UploadTranscriptionProcessor = (input: UploadTranscriptionInput) => Promise<TranscriptSegment[]>;

type ChunkedTranscriptionDependencies = {
  planner?: (input: AudioChunkPlannerInput) => ReturnType<typeof planAudioChunks>;
  adapter?: ChunkTranscriptionAdapter;
  checkpoints?: ChunkCheckpointStore;
  cleanupChunks?: typeof cleanupGeneratedAudioChunks;
  schedulerOptions?: ChunkSchedulerOptions;
  identityResolver?: IdentityResolver;
};

export class IncompleteChunkTranscriptionError extends Error {
  constructor(readonly failedChunkIds: string[]) {
    super(`chunked transcription incomplete: ${failedChunkIds.length} chunk(s) failed`);
    this.name = "IncompleteChunkTranscriptionError";
  }
}

export async function transcribeSpeakerAsrAudioInChunks(
  input: UploadTranscriptionInput,
  dependencies: ChunkedTranscriptionDependencies = {}
) {
  const planner = dependencies.planner ?? planAudioChunks;
  const checkpoints = dependencies.checkpoints ?? new JsonChunkCheckpointStore(input.store);
  const cleanupChunks = dependencies.cleanupChunks ?? cleanupGeneratedAudioChunks;
  const chunks = await planner({
    uploadId: input.uploadId,
    filePath: input.filePath,
    mimeType: input.mimeType
  });
  console.info(
    `[asr-chunks] planned upload_id=${input.uploadId} chunks=${chunks.length} duration_seconds=${chunks.at(-1)?.endSeconds ?? 0}`
  );

  try {
    const result = await processAudioChunks({
      chunks,
      adapter: dependencies.adapter ?? speakerAsrChunkTranscriptionAdapter,
      checkpoints,
      userId: input.userId,
      options: {
        ...dependencies.schedulerOptions,
        onProgress: input.onChunkProgress ?? dependencies.schedulerOptions?.onProgress
      }
    });
    console.info(
      `[asr-chunks] settled upload_id=${input.uploadId} completed=${result.completed.length} failed=${result.failed.length}`
    );
    if (result.failed.length > 0) {
      throw new IncompleteChunkTranscriptionError(result.failed.map((chunk) => chunk.id));
    }
    let resolvedTranscriptChunks = result.completed;
    try {
      const identityResolver =
        dependencies.identityResolver ?? createIdentityResolver({ store: input.store });
      const identityResolution = await identityResolver.resolve({
        uploadId: input.uploadId,
        chunks: result.completed
      });
      resolvedTranscriptChunks = identityResolution.chunks;
      try {
        await input.store.write("speaker-identities", input.uploadId, identityResolution.audit);
      } catch (error) {
        console.warn(
          `[speaker-identity] audit_write_failed upload_id=${input.uploadId} error_name=${error instanceof Error ? error.name : "unknown"}`
        );
      }
      const verified = identityResolution.resolutions.filter(
        (resolution) => resolution.status === "verified"
      ).length;
      const pending = identityResolution.resolutions.filter(
        (resolution) => resolution.status === "pending"
      ).length;
      console.info(
        `[speaker-identity] upload_id=${input.uploadId} chunks=${identityResolution.audit.chunksProcessed} local_speaker_groups=${identityResolution.audit.localSpeakerGroups} global_speakers=${identityResolution.audit.globalSpeakers} verified=${verified} pending=${pending} matched=${identityResolution.audit.matched} unknown=${identityResolution.audit.unknown} conflicts=${identityResolution.audit.conflicts} average_local_confidence=${identityResolution.audit.averageConfidence === null ? "not_applicable" : identityResolution.audit.averageConfidence.toFixed(4)}`
      );
    } catch (error) {
      console.warn(
        `[speaker-identity] resolution_failed upload_id=${input.uploadId} error_name=${error instanceof Error ? error.name : "unknown"}`
      );
    }
    const merged = mergeTranscriptChunks(resolvedTranscriptChunks);
    console.info(
      `[transcript-merge] upload_id=${input.uploadId} chunks=${merged.stats.chunkCount} input_segments=${merged.stats.inputSegmentCount} segments=${merged.stats.segmentCount} duplicates_removed=${merged.stats.duplicateRemoved} warnings=${merged.warnings.length}`
    );
    return merged.segments;
  } finally {
    try {
      await cleanupChunks(chunks);
    } catch (error) {
      console.warn(
        `[asr-chunks] temporary file cleanup failed upload_id=${input.uploadId} error_name=${error instanceof Error ? error.name : "unknown"}`
      );
    }
  }
}

export const transcribeConfiguredAudio: UploadTranscriptionProcessor = async (input) => {
  const runtime = getTranscriptionProviderRuntime();
  if (runtime.name !== "speaker-asr") {
    return await getTranscriptionProvider().transcribe(input);
  }

  try {
    return await transcribeSpeakerAsrAudioInChunks(input);
  } catch (error) {
    if (!runtime.fallbackProvider || !runtime.fallbackName) {
      throw error;
    }
    console.error(
      `[transcription provider fallback] speaker-asr chunk processing failed, fallback provider ${runtime.fallbackName} will be used.`,
      error
    );
    return await runtime.fallbackProvider.transcribe(input);
  }
};
