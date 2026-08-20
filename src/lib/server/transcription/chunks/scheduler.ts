import {
  AudioChunkSchema,
  TranscriptChunkSchema,
  type AudioChunk,
  type ChunkProcessingError,
  type TranscriptChunk
} from "@/lib/domain/chunks";
import { ChunkTranscriptionError, type ChunkTranscriptionAdapter } from "./adapter";
import type { ChunkCheckpointStore } from "./checkpoint-store";
import { mapWithConcurrency } from "@/lib/server/chunks/bounded-scheduler";
import type { AudioAccessPolicy } from "../provider";

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 10 * 60 * 1_000;

export type ChunkSchedulerProgress = {
  completed: number;
  failed: number;
  total: number;
  chunkId: string;
  status: "completed" | "failed";
};

export type ChunkSchedulerOptions = {
  concurrency?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  attemptTimeoutMs?: number;
  now?: () => string;
  onProgress?: (event: ChunkSchedulerProgress) => void | Promise<void>;
};

export type ChunkSchedulerResult = {
  completed: TranscriptChunk[];
  failed: AudioChunk[];
};

function readIntegerEnv(name: string, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(process.env[name]?.trim() ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, parsed));
}

function sanitizeErrorMessage(message: string) {
  return message
    .replace(/([?&](?:token|access_token|api_key|key)=)[^&\s]+/gi, "$1****")
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, "$1****")
    .slice(0, 500);
}

function chunkError(error: unknown): ChunkProcessingError {
  if (error instanceof ChunkTranscriptionError) {
    return {
      code: error.code,
      message: sanitizeErrorMessage(error.message),
      retryable: error.retryable
    };
  }
  return {
    code: "chunk_processing_failed",
    message: sanitizeErrorMessage(error instanceof Error ? error.message : "unknown chunk processing error"),
    retryable: true
  };
}

async function transcribeWithTimeout(input: {
  adapter: ChunkTranscriptionAdapter;
  chunk: AudioChunk;
  userId?: string;
  audioAccessPolicy?: AudioAccessPolicy;
  timeoutMs: number;
}) {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new ChunkTranscriptionError("chunk_timeout", `chunk attempt timed out after ${input.timeoutMs}ms`, true));
      controller.abort();
    }, input.timeoutMs);
  });

  try {
    return await Promise.race([
      input.adapter.transcribeChunk({
        chunk: input.chunk,
        userId: input.userId,
        audioAccessPolicy: input.audioAccessPolicy,
        signal: controller.signal
      }),
      timeout
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function schedulerConfig(options: ChunkSchedulerOptions) {
  return {
    concurrency:
      options.concurrency ?? readIntegerEnv("ASR_CHUNK_CONCURRENCY", DEFAULT_CONCURRENCY, 1, 16),
    maxRetries:
      options.maxRetries ?? readIntegerEnv("ASR_CHUNK_MAX_RETRIES", DEFAULT_MAX_RETRIES, 0, 5),
    retryDelayMs:
      options.retryDelayMs ?? readIntegerEnv("ASR_CHUNK_RETRY_DELAY_MS", DEFAULT_RETRY_DELAY_MS, 0, 60_000),
    attemptTimeoutMs:
      options.attemptTimeoutMs ??
      readIntegerEnv("ASR_CHUNK_ATTEMPT_TIMEOUT_MS", DEFAULT_ATTEMPT_TIMEOUT_MS, 1_000, 60 * 60 * 1_000)
  };
}

export async function processAudioChunks(input: {
  chunks: AudioChunk[];
  adapter: ChunkTranscriptionAdapter;
  checkpoints: ChunkCheckpointStore;
  userId?: string;
  audioAccessPolicy?: AudioAccessPolicy;
  options?: ChunkSchedulerOptions;
}): Promise<ChunkSchedulerResult> {
  const options = input.options ?? {};
  const config = schedulerConfig(options);
  const now = options.now ?? (() => new Date().toISOString());
  const chunks = [...input.chunks].sort((left, right) => left.index - right.index);
  const completed: TranscriptChunk[] = [];
  const failed: AudioChunk[] = [];

  for (const chunk of chunks) {
    await input.checkpoints.saveAudioChunk(AudioChunkSchema.parse(chunk));
  }

  const reportProgress = async (chunkId: string, status: "completed" | "failed") => {
    await options.onProgress?.({
      completed: completed.length,
      failed: failed.length,
      total: chunks.length,
      chunkId,
      status
    });
  };

  const processOne = async (initialChunk: AudioChunk) => {
    let chunk = initialChunk;
    const chunkStartedAt = Date.now();
    console.info(
      `[asr-chunks] chunk started chunk_id=${chunk.id} index=${chunk.index} start_seconds=${chunk.startSeconds} end_seconds=${chunk.endSeconds} duration_seconds=${chunk.durationSeconds}`
    );

    for (;;) {
      const startedAt = chunk.startedAt ?? now();
      chunk = AudioChunkSchema.parse({
        ...chunk,
        status: "processing",
        error: undefined,
        startedAt,
        finishedAt: undefined,
        updatedAt: now()
      });
      await input.checkpoints.saveAudioChunk(chunk);

      try {
        const transcript = await transcribeWithTimeout({
          adapter: input.adapter,
          chunk,
          userId: input.userId,
          audioAccessPolicy: input.audioAccessPolicy,
          timeoutMs: config.attemptTimeoutMs
        });
        const finishedAt = now();
        const completedTranscript = TranscriptChunkSchema.parse({
          ...transcript,
          retryCount: chunk.retryCount,
          updatedAt: finishedAt,
          finishedAt
        });
        chunk = AudioChunkSchema.parse({
          ...chunk,
          status: "completed",
          error: undefined,
          updatedAt: finishedAt,
          finishedAt
        });
        await input.checkpoints.saveTranscriptChunk(completedTranscript);
        await input.checkpoints.saveAudioChunk(chunk);
        completed.push(completedTranscript);
        console.info(
          `[asr-chunks] chunk completed chunk_id=${chunk.id} index=${chunk.index} retry_count=${chunk.retryCount} segments=${completedTranscript.segments.length} elapsed_ms=${Date.now() - chunkStartedAt}`
        );
        await reportProgress(chunk.id, "completed");
        return;
      } catch (error) {
        const normalizedError = chunkError(error);
        if (normalizedError.retryable && chunk.retryCount < config.maxRetries) {
          chunk = AudioChunkSchema.parse({
            ...chunk,
            retryCount: chunk.retryCount + 1,
            error: normalizedError,
            updatedAt: now()
          });
          await input.checkpoints.saveAudioChunk(chunk);
          console.info(
            `[asr-chunks] chunk retry chunk_id=${chunk.id} index=${chunk.index} retry_count=${chunk.retryCount} error_code=${normalizedError.code}`
          );
          if (config.retryDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, config.retryDelayMs));
          }
          continue;
        }

        chunk = AudioChunkSchema.parse({
          ...chunk,
          status: "failed",
          error: normalizedError,
          updatedAt: now(),
          finishedAt: now()
        });
        await input.checkpoints.saveAudioChunk(chunk);
        failed.push(chunk);
        console.info(
          `[asr-chunks] chunk failed chunk_id=${chunk.id} index=${chunk.index} retry_count=${chunk.retryCount} error_code=${normalizedError.code} elapsed_ms=${Date.now() - chunkStartedAt}`
        );
        await reportProgress(chunk.id, "failed");
        return;
      }
    }
  };

  await mapWithConcurrency({
    items: chunks,
    options: { concurrency: config.concurrency },
    worker: processOne
  });

  return {
    completed: completed.sort((left, right) => left.index - right.index),
    failed: failed.sort((left, right) => left.index - right.index)
  };
}
