import {
  buildTranscriptChunkId,
  type AudioChunk,
  type TranscriptChunk
} from "@/lib/domain/chunks";
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
import {
  isEmptyTranscriptRecoveryCandidate,
  isEmptyTranscriptRecoveryEnabled,
  recoverEmptyTranscriptChunk
} from "./empty-transcript-recovery";
import { processAudioChunks, type ChunkSchedulerOptions } from "./scheduler";
import { mergeTranscriptChunks } from "./transcript-merge";

export type UploadTranscriptionInput = TranscriptionInput & {
  store: JsonStore;
  userId?: string;
  onChunkProgress?: ChunkSchedulerOptions["onProgress"];
  /**
   * Daily Reflection staging is transcript-only. It must not read identity or
   * voiceprint state, attach an inferred identity, or persist an identity
   * audit. Standard uploads retain the existing resolve-and-persist default.
   */
  identityPolicy?: "resolve_and_persist" | "skip";
};

export type UploadTranscriptionProcessor = (input: UploadTranscriptionInput) => Promise<TranscriptSegment[]>;

type ChunkedTranscriptionDependencies = {
  planner?: (input: AudioChunkPlannerInput) => ReturnType<typeof planAudioChunks>;
  adapter?: ChunkTranscriptionAdapter;
  checkpoints?: ChunkCheckpointStore;
  cleanupChunks?: typeof cleanupGeneratedAudioChunks;
  schedulerOptions?: ChunkSchedulerOptions;
  identityResolver?: IdentityResolver;
  emptyTranscriptRecovery?: typeof recoverEmptyTranscriptChunk;
  emptyTranscriptRecoveryEnabled?: boolean;
};

export class IncompleteChunkTranscriptionError extends Error {
  constructor(readonly failedChunkIds: string[]) {
    super(`chunked transcription incomplete: ${failedChunkIds.length} chunk(s) failed`);
    this.name = "IncompleteChunkTranscriptionError";
  }
}

function matchesCompletedCheckpoint(input: {
  planned: AudioChunk;
  audio?: AudioChunk;
  transcript?: TranscriptChunk;
}) {
  const { planned, audio, transcript } = input;
  return Boolean(
    audio &&
    transcript &&
    audio.id === planned.id &&
    audio.uploadId === planned.uploadId &&
    audio.index === planned.index &&
    audio.startSeconds === planned.startSeconds &&
    audio.endSeconds === planned.endSeconds &&
    audio.durationSeconds === planned.durationSeconds &&
    audio.status === "completed" &&
    !audio.error &&
    transcript.audioChunkId === planned.id &&
    transcript.id === buildTranscriptChunkId(planned.uploadId, planned.index) &&
    transcript.uploadId === planned.uploadId &&
    transcript.index === planned.index &&
    transcript.startSeconds === planned.startSeconds &&
    transcript.endSeconds === planned.endSeconds &&
    transcript.timebase === "upload_global" &&
    transcript.status === "completed" &&
    transcript.segments.length > 0 &&
    transcript.segments.every(
      (segment) =>
        segment.text.trim().length > 0 &&
        segment.startSeconds >= planned.startSeconds &&
        segment.endSeconds <= planned.endSeconds &&
        segment.endSeconds > segment.startSeconds
    )
  );
}

async function reusableCompletedCheckpoints(input: {
  uploadId: string;
  plannedChunks: AudioChunk[];
  checkpoints: ChunkCheckpointStore;
}) {
  try {
    const [audioChunks, transcriptChunks] = await Promise.all([
      input.checkpoints.listAudioChunks(input.uploadId),
      input.checkpoints.listTranscriptChunks(input.uploadId)
    ]);
    const audioById = new Map(audioChunks.map((chunk) => [chunk.id, chunk]));
    const transcriptByAudioChunkId = new Map(
      transcriptChunks.map((chunk) => [chunk.audioChunkId, chunk])
    );
    return input.plannedChunks.flatMap((planned) => {
      const audio = audioById.get(planned.id);
      const transcript = transcriptByAudioChunkId.get(planned.id);
      return matchesCompletedCheckpoint({ planned, audio, transcript })
        ? [transcript!]
        : [];
    });
  } catch (error) {
    console.warn(
      `[asr-chunks] checkpoint resume unavailable upload_id=${input.uploadId} error_name=${error instanceof Error ? error.name : "unknown"}`
    );
    return [];
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
    const resumedTranscriptChunks = await reusableCompletedCheckpoints({
      uploadId: input.uploadId,
      plannedChunks: chunks,
      checkpoints
    });
    const resumedAudioChunkIds = new Set(
      resumedTranscriptChunks.map((chunk) => chunk.audioChunkId)
    );
    const pendingChunks = chunks.filter(
      (chunk) => !resumedAudioChunkIds.has(chunk.id)
    );
    if (resumedTranscriptChunks.length > 0) {
      console.info(
        `[asr-chunks] checkpoint resume upload_id=${input.uploadId} completed=${resumedTranscriptChunks.length}/${chunks.length} pending=${pendingChunks.length}`
      );
    }
    const onProgress =
      input.onChunkProgress ?? dependencies.schedulerOptions?.onProgress;
    const result = pendingChunks.length > 0
      ? await processAudioChunks({
          chunks: pendingChunks,
          adapter: dependencies.adapter ?? speakerAsrChunkTranscriptionAdapter,
          checkpoints,
          userId: input.userId,
          audioAccessPolicy: input.audioAccessPolicy,
          options: {
            ...dependencies.schedulerOptions,
            onProgress: onProgress
              ? (event) => onProgress({
                  ...event,
                  completed: resumedTranscriptChunks.length + event.completed,
                  total: chunks.length
                })
              : undefined
          }
        })
      : { completed: [], failed: [] };
    const recoverEmptyTranscript =
      dependencies.emptyTranscriptRecovery ?? recoverEmptyTranscriptChunk;
    const recoveryEnabled =
      dependencies.emptyTranscriptRecoveryEnabled ?? isEmptyTranscriptRecoveryEnabled();
    const transcriptChunks = [
      ...resumedTranscriptChunks,
      ...result.completed
    ];
    const failedChunks: AudioChunk[] = [];

    for (const failedChunk of result.failed) {
      if (!recoveryEnabled || !isEmptyTranscriptRecoveryCandidate(failedChunk)) {
        failedChunks.push(failedChunk);
        continue;
      }
      try {
        const recovered = await recoverEmptyTranscript({
          chunk: failedChunk,
          adapter: dependencies.adapter ?? speakerAsrChunkTranscriptionAdapter,
          checkpoints,
          userId: input.userId,
          audioAccessPolicy: input.audioAccessPolicy,
          schedulerOptions: dependencies.schedulerOptions
        });
        if (recovered) {
          transcriptChunks.push(recovered);
          continue;
        }
      } catch (error) {
        console.warn(
          `[asr-chunks] empty transcript recovery unavailable parent_chunk_id=${failedChunk.id} error_name=${error instanceof Error ? error.name : "unknown"}`
        );
      }
      failedChunks.push(failedChunk);
    }

    transcriptChunks.sort((left, right) => left.index - right.index);
    console.info(
      `[asr-chunks] settled upload_id=${input.uploadId} completed=${transcriptChunks.length}/${chunks.length} failed=${failedChunks.length}`
    );
    if (failedChunks.length > 0) {
      throw new IncompleteChunkTranscriptionError(failedChunks.map((chunk) => chunk.id));
    }
    let resolvedTranscriptChunks = transcriptChunks;
    if ((input.identityPolicy ?? "resolve_and_persist") === "resolve_and_persist") {
      try {
        const identityResolver =
          dependencies.identityResolver ?? createIdentityResolver({ store: input.store });
        const identityResolution = await identityResolver.resolve({
          uploadId: input.uploadId,
          chunks: transcriptChunks
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
  const configuredInput: UploadTranscriptionInput = {
    ...input,
    audioAccessPolicy: input.audioAccessPolicy ?? "legacy_bearer"
  };
  const runtime = getTranscriptionProviderRuntime();
  if (runtime.name !== "speaker-asr") {
    return await getTranscriptionProvider().transcribe(configuredInput);
  }

  try {
    return await transcribeSpeakerAsrAudioInChunks(configuredInput);
  } catch (error) {
    if (!runtime.fallbackProvider || !runtime.fallbackName) {
      throw error;
    }
    console.error(
      `[transcription provider fallback] speaker-asr chunk processing failed, fallback provider ${runtime.fallbackName} will be used.`,
      error
    );
    return await runtime.fallbackProvider.transcribe(configuredInput);
  }
};

export const transcribeDailyReflectionAudio: UploadTranscriptionProcessor = (input) =>
  transcribeConfiguredAudio({
    ...input,
    identityPolicy: "skip",
    audioAccessPolicy: "daily_reflection_capability"
  });
