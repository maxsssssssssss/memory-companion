import { execFile } from "child_process";
import { mkdir, readdir, rm, rmdir } from "fs/promises";
import { dirname, join } from "path";
import { promisify } from "util";
import {
  AudioChunkSetSchema,
  buildAudioChunkId,
  type AudioChunk
} from "@/lib/domain/chunks";
import { getFfmpegExecutable, getFfprobeExecutable } from "@/lib/server/ffmpeg";

const execFileAsync = promisify(execFile);
const DEFAULT_CHUNK_DURATION_SECONDS = 5 * 60;
const MIN_CHUNK_DURATION_SECONDS = 30;
const MAX_CHUNK_DURATION_SECONDS = 60 * 60;

export type AudioChunkRange = {
  index: number;
  startSeconds: number;
  endSeconds: number;
};

export interface AudioChunkPlanningStrategy {
  readonly name: string;
  plan(durationSeconds: number): AudioChunkRange[];
}

export type AudioChunkPlannerInput = {
  uploadId: string;
  filePath: string;
  mimeType: string;
  chunkDurationSeconds?: number;
  strategy?: AudioChunkPlanningStrategy;
};

export type AudioChunkPlannerDependencies = {
  probeDurationSeconds?: (filePath: string) => Promise<number>;
  splitAudio?: (input: {
    filePath: string;
    outputDirectory: string;
    chunkDurationSeconds: number;
    ranges: AudioChunkRange[];
  }) => Promise<string[]>;
  now?: () => string;
};

function roundTime(value: number) {
  return Number(value.toFixed(3));
}

function readChunkDurationSeconds() {
  const parsed = Number.parseInt(process.env.ASR_CHUNK_DURATION_SECONDS?.trim() ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CHUNK_DURATION_SECONDS;
  }
  return Math.min(MAX_CHUNK_DURATION_SECONDS, Math.max(MIN_CHUNK_DURATION_SECONDS, parsed));
}

export class FixedDurationAudioChunkStrategy implements AudioChunkPlanningStrategy {
  readonly name = "fixed_duration";

  constructor(readonly chunkDurationSeconds = DEFAULT_CHUNK_DURATION_SECONDS) {
    if (!Number.isFinite(chunkDurationSeconds) || chunkDurationSeconds <= 0) {
      throw new Error("chunk duration must be positive");
    }
  }

  plan(durationSeconds: number): AudioChunkRange[] {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error("audio duration must be positive");
    }

    const chunkCount = Math.ceil(durationSeconds / this.chunkDurationSeconds);
    return Array.from({ length: chunkCount }, (_, index) => {
      const startSeconds = roundTime(index * this.chunkDurationSeconds);
      return {
        index,
        startSeconds,
        endSeconds: roundTime(Math.min(durationSeconds, startSeconds + this.chunkDurationSeconds))
      };
    });
  }
}

export async function probeAudioDurationSeconds(filePath: string) {
  const result = await execFileAsync(getFfprobeExecutable(), [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath
  ]);
  const stdout = typeof result === "string" ? result : result.stdout;
  const durationSeconds = Number.parseFloat(String(stdout).trim());
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("ffprobe did not return a valid audio duration");
  }
  return roundTime(durationSeconds);
}

export async function splitAudioWithFfmpeg(input: {
  filePath: string;
  outputDirectory: string;
  chunkDurationSeconds: number;
  ranges: AudioChunkRange[];
}) {
  await rm(input.outputDirectory, { recursive: true, force: true });
  await mkdir(input.outputDirectory, { recursive: true });
  const outputPattern = join(input.outputDirectory, "chunk_%05d.mp3");

  try {
    await execFileAsync(getFfmpegExecutable(), [
      "-y",
      "-v",
      "error",
      "-i",
      input.filePath,
      "-vn",
      "-f",
      "segment",
      "-segment_time",
      String(input.chunkDurationSeconds),
      "-reset_timestamps",
      "1",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "32k",
      outputPattern
    ]);

    return (await readdir(input.outputDirectory))
      .filter((fileName) => /^chunk_\d{5}\.mp3$/.test(fileName))
      .sort()
      .map((fileName) => join(input.outputDirectory, fileName));
  } catch (error) {
    await rm(input.outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function cleanupGeneratedAudioChunks(chunks: AudioChunk[]) {
  const generatedPaths = chunks.flatMap((chunk) =>
    chunk.source.type === "generated_chunk" && chunk.source.path ? [chunk.source.path] : []
  );
  await Promise.all(generatedPaths.map((filePath) => rm(filePath, { force: true })));
  const directories = Array.from(new Set(generatedPaths.map((filePath) => dirname(filePath))));
  await Promise.all(directories.map((directory) => rmdir(directory).catch(() => undefined)));
}

export async function planAudioChunks(
  input: AudioChunkPlannerInput,
  dependencies: AudioChunkPlannerDependencies = {}
): Promise<AudioChunk[]> {
  const probe = dependencies.probeDurationSeconds ?? probeAudioDurationSeconds;
  const splitAudio = dependencies.splitAudio ?? splitAudioWithFfmpeg;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const chunkDurationSeconds = input.chunkDurationSeconds ?? readChunkDurationSeconds();
  const strategy = input.strategy ?? new FixedDurationAudioChunkStrategy(chunkDurationSeconds);
  const durationSeconds = await probe(input.filePath);
  const ranges = strategy.plan(durationSeconds);
  const createdAt = now();

  let chunkPaths: string[];
  if (ranges.length === 1) {
    chunkPaths = [input.filePath];
  } else {
    chunkPaths = await splitAudio({
      filePath: input.filePath,
      outputDirectory: join(dirname(input.filePath), `${input.uploadId}-chunks`),
      chunkDurationSeconds,
      ranges
    });
    if (chunkPaths.length !== ranges.length) {
      await Promise.all(chunkPaths.map((filePath) => rm(filePath, { force: true })));
      throw new Error(`expected ${ranges.length} audio chunks but ffmpeg created ${chunkPaths.length}`);
    }
  }

  const chunks = ranges.map((range, index): AudioChunk => ({
    id: buildAudioChunkId(input.uploadId, range.index),
    uploadId: input.uploadId,
    index: range.index,
    startSeconds: range.startSeconds,
    endSeconds: range.endSeconds,
    durationSeconds: roundTime(range.endSeconds - range.startSeconds),
    source: {
      type: ranges.length === 1 ? "uploaded_audio" : "generated_chunk",
      path: chunkPaths[index]
    },
    status: "created",
    retryCount: 0,
    createdAt,
    updatedAt: createdAt,
    metadata: {
      strategy: strategy.name,
      mimeType: ranges.length === 1 ? input.mimeType : "audio/mpeg",
      originalMimeType: input.mimeType
    }
  }));

  return AudioChunkSetSchema.parse({ uploadId: input.uploadId, chunks }).chunks;
}
