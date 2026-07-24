import type { TranscriptSegment } from "@/lib/domain/types";
import type { JsonStore } from "@/lib/server/storage/json-store";
import {
  JsonSpeakerIdentityRepository,
  type SpeakerIdentityRepository
} from "@/lib/server/speaker-identity/repository";
import { resolveSpeakerIdentities } from "@/lib/server/speaker-identity/resolver";
import type {
  SpeakerIdentityMatcher,
  VoiceprintIdentityHint
} from "@/lib/server/speaker-identity/types";
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
  speakerIdentityRepository?:
    Pick<SpeakerIdentityRepository, "loadDirectMappings"> &
    Partial<Pick<SpeakerIdentityRepository, "loadVoiceprintHints">>;
  speakerIdentityMatcher?: SpeakerIdentityMatcher;
  speakerIdentityMatcherFeatures?: Record<string, unknown>;
  voiceprintIdentityHints?: VoiceprintIdentityHint[];
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
    let transcriptChunks = result.completed;
    try {
      const identityRepository = dependencies.speakerIdentityRepository ??
        new JsonSpeakerIdentityRepository(input.store);
      const [manualMappings, storedVoiceprintHints] = await Promise.all([
        identityRepository.loadDirectMappings(input.uploadId),
        dependencies.voiceprintIdentityHints === undefined &&
        identityRepository.loadVoiceprintHints
          ? identityRepository.loadVoiceprintHints(result.completed)
          : Promise.resolve([])
      ]);
      const identityResolution = await resolveSpeakerIdentities({
        uploadId: input.uploadId,
        chunks: result.completed,
        manualMappings,
        voiceprintHints: dependencies.voiceprintIdentityHints ?? storedVoiceprintHints,
        matcher: dependencies.speakerIdentityMatcher,
        matcherFeatures: dependencies.speakerIdentityMatcherFeatures
      });
      transcriptChunks = identityResolution.chunks;
      try {
        await input.store.write("speaker-identities", input.uploadId, identityResolution.audit);
      } catch (error) {
        console.warn(
          `[speaker-identity] audit_write_failed upload_id=${input.uploadId} error_name=${error instanceof Error ? error.name : "unknown"}`
        );
      }
      console.info(
        `[speaker-identity] upload_id=${input.uploadId} chunks=${identityResolution.audit.chunksProcessed} local_speaker_groups=${identityResolution.audit.localSpeakerGroups} global_speakers=${identityResolution.audit.globalSpeakers} matched=${identityResolution.audit.matched} unknown=${identityResolution.audit.unknown} conflicts=${identityResolution.audit.conflicts} average_confidence=${identityResolution.audit.averageConfidence.toFixed(4)}`
      );
    } catch (error) {
      console.warn(
        `[speaker-identity] resolution_failed upload_id=${input.uploadId} error_name=${error instanceof Error ? error.name : "unknown"}`
      );
    }
    const merged = mergeTranscriptChunks(transcriptChunks);
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
