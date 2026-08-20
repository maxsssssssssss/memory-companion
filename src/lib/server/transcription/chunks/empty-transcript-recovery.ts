import {
  AudioChunkSchema,
  buildTranscriptChunkId,
  type AudioChunk,
  type TranscriptChunk
} from "@/lib/domain/chunks";
import type { ChunkTranscriptionAdapter } from "./adapter";
import {
  cleanupGeneratedAudioChunks,
  splitAudioChunkForEmptyTranscriptRecovery
} from "./audio-planner";
import type { ChunkCheckpointStore } from "./checkpoint-store";
import {
  processAudioChunks,
  type ChunkSchedulerOptions
} from "./scheduler";
import { createTranscriptChunkFromLocalSegments } from "./transcript-merge";
import type { AudioAccessPolicy } from "../provider";

const EMPTY_TRANSCRIPT_ERROR_CODE = "speaker_asr_empty_transcript";
const RECOVERY_ENABLED_ENV = "ASR_CHUNK_EMPTY_TRANSCRIPT_SPLIT_ENABLED";
const DEFAULT_RECOVERY_MAX_DEPTH = 3;
const DEFAULT_RECOVERY_MINIMUM_CHILD_DURATION_SECONDS = 30;

export type EmptyTranscriptRecoveryDependencies = {
  splitChunk?: typeof splitAudioChunkForEmptyTranscriptRecovery;
  cleanupChunks?: typeof cleanupGeneratedAudioChunks;
  processChunks?: typeof processAudioChunks;
  now?: () => string;
  maxDepth?: number;
  minimumChildDurationSeconds?: number;
};

type EmptyTranscriptRecoveryLimits = {
  maxDepth: number;
  minimumChildDurationSeconds: number;
};

type EmptyTranscriptRecoveryOutcome = {
  transcript: TranscriptChunk;
  depthUsed: number;
  leafChunkIds: string[];
};

function readBooleanEnv(name: string, fallback: boolean) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(value)) {
    return false;
  }
  return fallback;
}

export function isEmptyTranscriptRecoveryEnabled() {
  return readBooleanEnv(RECOVERY_ENABLED_ENV, true);
}

export function isEmptyTranscriptRecoveryCandidate(chunk: AudioChunk) {
  return (
    chunk.status === "failed" &&
    chunk.error?.code === EMPTY_TRANSCRIPT_ERROR_CODE &&
    chunk.durationSeconds >= 2 &&
    Boolean(chunk.source.path)
  );
}

async function cleanupRecoveryArtifacts(input: {
  recoveryChunks: AudioChunk[];
  checkpoints: ChunkCheckpointStore;
  cleanupChunks: typeof cleanupGeneratedAudioChunks;
}) {
  const cleanupResults = await Promise.allSettled([
    input.cleanupChunks(input.recoveryChunks),
    ...input.recoveryChunks.flatMap((chunk) => [
      input.checkpoints.deleteAudioChunk?.(chunk.id) ?? Promise.resolve(),
      input.checkpoints.deleteTranscriptChunk?.(
        buildTranscriptChunkId(chunk.uploadId, chunk.index)
      ) ?? Promise.resolve()
    ])
  ]);
  const failedCleanupCount = cleanupResults.filter(
    (result) => result.status === "rejected"
  ).length;
  if (failedCleanupCount > 0) {
    console.warn(
      `[asr-chunks] empty transcript recovery cleanup failed operations=${failedCleanupCount}/${cleanupResults.length}`
    );
  }
}

function parentLocalSegments(parent: AudioChunk, chunks: TranscriptChunk[]) {
  return chunks
    .flatMap((chunk) => chunk.segments)
    .sort(
      (left, right) =>
        left.startSeconds - right.startSeconds ||
        left.endSeconds - right.endSeconds ||
        left.id.localeCompare(right.id)
    )
    .map((segment) => ({
      ...segment,
      startSeconds: Number((segment.startSeconds - parent.startSeconds).toFixed(3)),
      endSeconds: Number((segment.endSeconds - parent.startSeconds).toFixed(3))
    }));
}

function recoveryLimits(
  dependencies: EmptyTranscriptRecoveryDependencies
): EmptyTranscriptRecoveryLimits {
  const configuredMaxDepth =
    dependencies.maxDepth ?? DEFAULT_RECOVERY_MAX_DEPTH;
  const configuredMinimumChildDurationSeconds =
    dependencies.minimumChildDurationSeconds ??
    DEFAULT_RECOVERY_MINIMUM_CHILD_DURATION_SECONDS;
  return {
    maxDepth: Number.isFinite(configuredMaxDepth)
      ? Math.max(0, Math.floor(configuredMaxDepth))
      : DEFAULT_RECOVERY_MAX_DEPTH,
    minimumChildDurationSeconds:
      Number.isFinite(configuredMinimumChildDurationSeconds)
        ? Math.max(1, configuredMinimumChildDurationSeconds)
        : DEFAULT_RECOVERY_MINIMUM_CHILD_DURATION_SECONDS
  };
}

function canSplitForRecovery(
  chunk: AudioChunk,
  depth: number,
  limits: EmptyTranscriptRecoveryLimits
) {
  return (
    depth < limits.maxDepth &&
    chunk.durationSeconds / 2 >= limits.minimumChildDurationSeconds
  );
}

async function recoverEmptyTranscriptChunkAtDepth(input: {
  chunk: AudioChunk;
  adapter: ChunkTranscriptionAdapter;
  checkpoints: ChunkCheckpointStore;
  userId?: string;
  audioAccessPolicy?: AudioAccessPolicy;
  schedulerOptions?: ChunkSchedulerOptions;
  dependencies: EmptyTranscriptRecoveryDependencies;
  limits: EmptyTranscriptRecoveryLimits;
  depth: number;
}): Promise<EmptyTranscriptRecoveryOutcome | null> {
  if (!isEmptyTranscriptRecoveryCandidate(input.chunk)) {
    return null;
  }

  if (!canSplitForRecovery(input.chunk, input.depth, input.limits)) {
    console.info(
      `[asr-chunks] empty transcript recovery stopped parent_chunk_id=${input.chunk.id} depth=${input.depth}/${input.limits.maxDepth} duration_seconds=${input.chunk.durationSeconds} minimum_child_duration_seconds=${input.limits.minimumChildDurationSeconds}`
    );
    return null;
  }

  const dependencies = input.dependencies;
  const splitChunk = dependencies.splitChunk ?? splitAudioChunkForEmptyTranscriptRecovery;
  const cleanupChunks = dependencies.cleanupChunks ?? cleanupGeneratedAudioChunks;
  const processChunks = dependencies.processChunks ?? processAudioChunks;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const recoveryChunks = await splitChunk(input.chunk, { now });

  console.info(
    `[asr-chunks] empty transcript recovery started parent_chunk_id=${input.chunk.id} depth=${input.depth + 1}/${input.limits.maxDepth} subchunks=0/${recoveryChunks.length}`
  );
  try {
    let settledSubchunks = 0;
    const result = await processChunks({
      chunks: recoveryChunks,
      adapter: input.adapter,
      checkpoints: input.checkpoints,
      userId: input.userId,
      audioAccessPolicy: input.audioAccessPolicy,
      options: {
        concurrency: Math.min(2, input.schedulerOptions?.concurrency ?? 2),
        maxRetries: 0,
        retryDelayMs: 0,
        attemptTimeoutMs: input.schedulerOptions?.attemptTimeoutMs,
        now,
        onProgress: (event) => {
          settledSubchunks += 1;
          console.info(
            `[asr-chunks] empty transcript recovery progress parent_chunk_id=${input.chunk.id} depth=${input.depth + 1}/${input.limits.maxDepth} subchunks=${settledSubchunks}/${recoveryChunks.length} status=${event.status}`
          );
        }
      }
    });

    const emptyCompleted = result.completed.filter(
      (chunk) =>
        chunk.segments.length === 0 ||
        chunk.segments.every((segment) => segment.text.trim().length === 0)
    );
    if (emptyCompleted.length > 0) {
      console.info(
        `[asr-chunks] empty transcript recovery failed parent_chunk_id=${input.chunk.id} depth=${input.depth + 1}/${input.limits.maxDepth} empty_completed=${emptyCompleted.length}`
      );
      return null;
    }

    const completed = [...result.completed];
    const leafChunkIds = result.completed.map((chunk) => chunk.audioChunkId);
    let depthUsed = 1;
    let recursiveFailure = false;

    for (const failedChunk of result.failed) {
      const recoveredChild = await recoverEmptyTranscriptChunkAtDepth({
        ...input,
        chunk: failedChunk,
        depth: input.depth + 1
      });
      if (!recoveredChild) {
        recursiveFailure = true;
        continue;
      }
      completed.push(recoveredChild.transcript);
      leafChunkIds.push(...recoveredChild.leafChunkIds);
      depthUsed = Math.max(depthUsed, recoveredChild.depthUsed + 1);
    }

    if (recursiveFailure || completed.length !== recoveryChunks.length) {
      console.info(
        `[asr-chunks] empty transcript recovery failed parent_chunk_id=${input.chunk.id} depth=${input.depth + 1}/${input.limits.maxDepth} completed=${completed.length}/${recoveryChunks.length} failed=${recoveryChunks.length - completed.length}`
      );
      return null;
    }

    const recoveredTranscript = createTranscriptChunkFromLocalSegments({
      chunk: input.chunk,
      localSegments: parentLocalSegments(input.chunk, completed),
      providerMetadata: {
        provider: input.adapter.name,
        recovery: "empty_transcript_split",
        recoverySubchunkCount: recoveryChunks.length,
        recoverySubchunkIds: recoveryChunks.map((chunk) => chunk.id),
        recoveryDepth: depthUsed,
        recoveryLeafCount: leafChunkIds.length,
        recoveryLeafChunkIds: leafChunkIds,
        recoveryMaxDepth: input.limits.maxDepth,
        recoveryMinimumChildDurationSeconds:
          input.limits.minimumChildDurationSeconds
      },
      now
    });
    if (recoveredTranscript.segments.length === 0) {
      console.info(
        `[asr-chunks] empty transcript recovery failed parent_chunk_id=${input.chunk.id} depth=${input.depth + 1}/${input.limits.maxDepth} merged_segments=0`
      );
      return null;
    }
    const finishedAt = now();
    const recoveredParent = AudioChunkSchema.parse({
      ...input.chunk,
      status: "completed",
      error: undefined,
      updatedAt: finishedAt,
      finishedAt
    });
    await input.checkpoints.saveTranscriptChunk(recoveredTranscript);
    await input.checkpoints.saveAudioChunk(recoveredParent);
    console.info(
      `[asr-chunks] empty transcript recovery completed parent_chunk_id=${input.chunk.id} depth_used=${depthUsed}/${input.limits.maxDepth} leaves=${leafChunkIds.length} segments=${recoveredTranscript.segments.length}`
    );
    return {
      transcript: recoveredTranscript,
      depthUsed,
      leafChunkIds
    };
  } finally {
    await cleanupRecoveryArtifacts({
      recoveryChunks,
      checkpoints: input.checkpoints,
      cleanupChunks
    });
  }
}

export async function recoverEmptyTranscriptChunk(input: {
  chunk: AudioChunk;
  adapter: ChunkTranscriptionAdapter;
  checkpoints: ChunkCheckpointStore;
  userId?: string;
  audioAccessPolicy?: AudioAccessPolicy;
  schedulerOptions?: ChunkSchedulerOptions;
  dependencies?: EmptyTranscriptRecoveryDependencies;
}) {
  const dependencies = input.dependencies ?? {};
  const outcome = await recoverEmptyTranscriptChunkAtDepth({
    ...input,
    dependencies,
    limits: recoveryLimits(dependencies),
    depth: 0
  });
  return outcome?.transcript ?? null;
}
