import { access, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioInsight, AudioUpload, ProcessingJob, TranscriptSegment } from "@/lib/domain/types";
import { TranscriptChunkSchema } from "@/lib/domain/chunks";
import { buildAudioInsights } from "@/lib/processing/audio-insights";
import { extractBriefItems } from "@/lib/processing/extract-rule-based";
import { deepseekAudioInsightProvider } from "@/lib/server/audio-insights/deepseek-provider";
import { openaiAudioInsightProvider } from "@/lib/server/audio-insights/openai-provider";
import type { EvaluationAuditReport } from "@/lib/server/evaluation/audit-report";
import * as extractionProviderModule from "@/lib/server/extraction/provider";
import {
  deleteMemoryOwnerReviewCandidatesForUpload,
  generateMemoryOwnerReviewCandidates,
  MemoryOwnerReviewRepository
} from "@/lib/server/memory";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import { createMemoryRepository } from "@/lib/server/memory/repository";
import { JsonStore } from "@/lib/server/storage/json-store";
import { VoiceprintTrainingCandidateRepository } from "@/lib/server/speaker-identity/voiceprint-training-candidates";
import {
  DATE_COMPANION_AUDIO_STAGING_COLLECTION,
  stageDateCompanionParticipantAudio
} from "@/lib/server/date-companion/audio-staging";
import {
  DailyReflectionStandardPipelineRejectedError,
  UploadProcessingCancelledError,
  processUpload
} from "./process-upload";

const {
  emotionSignalAnalyzeMock,
  extractFfmpegAcousticFeaturesMock,
  getEmotionSignalProviderMock,
  applyMemoryRelevanceGateMock,
  getProactiveInsightProviderMock,
  getRelationshipSignalProviderMock,
  proactiveInsightGenerateMock,
  relationshipSignalAnalyzeMock
} = vi.hoisted(() => ({
  emotionSignalAnalyzeMock: vi.fn(),
  extractFfmpegAcousticFeaturesMock: vi.fn(),
  getEmotionSignalProviderMock: vi.fn(),
  applyMemoryRelevanceGateMock: vi.fn(),
  getProactiveInsightProviderMock: vi.fn(),
  getRelationshipSignalProviderMock: vi.fn(),
  proactiveInsightGenerateMock: vi.fn(),
  relationshipSignalAnalyzeMock: vi.fn()
}));

vi.mock("@/lib/server/audio-features/ffmpeg-acoustic-features", () => ({
  extractFfmpegAcousticFeatures: extractFfmpegAcousticFeaturesMock
}));

vi.mock("@/lib/server/emotion-signals/provider", () => ({
  getEmotionSignalProvider: getEmotionSignalProviderMock
}));

vi.mock("@/lib/server/relationship-signals/provider", () => ({
  getRelationshipSignalProvider: getRelationshipSignalProviderMock
}));

vi.mock("@/lib/server/proactive-insights/provider", () => ({
  getProactiveInsightProvider: getProactiveInsightProviderMock
}));

vi.mock("@/lib/server/memory/relevance", () => ({
  applyMemoryRelevanceGate: applyMemoryRelevanceGateMock
}));

let tempDir: string | undefined;
const originalEvaluationMode = process.env.EVALUATION_MODE;
const originalDebugSaveProviderResponse = process.env.DEBUG_SAVE_PROVIDER_RESPONSE;

type StoredUpload = AudioUpload & {
  filePath?: string;
  errorCode?: string;
  errorMessage?: string;
  evaluationRetention?: boolean;
  dateCompanionAudioSnapshotVersion?: 1;
};

type DeleteTrigger = (collection: string, id: string, value: unknown) => boolean;

function isProcessingJob(value: unknown): value is ProcessingJob {
  return value !== null && typeof value === "object" && "status" in value && "uploadId" in value;
}

function hasReadyStatus(value: unknown) {
  return value !== null && typeof value === "object" && "status" in value && value.status === "ready";
}

class DeleteDuringWriteStore extends JsonStore {
  private hasDeleted = false;

  constructor(
    rootDir: string,
    private readonly shouldDeleteBeforeWrite: DeleteTrigger
  ) {
    super(rootDir);
  }

  override async write<T>(collection: string, id: string, value: T): Promise<void> {
    if (!this.hasDeleted && this.shouldDeleteBeforeWrite(collection, id, value)) {
      this.hasDeleted = true;
      await this.simulateUploadDelete(this.uploadIdForWrite(collection, id, value));
    }

    await super.write(collection, id, value);
  }

  private uploadIdForWrite(collection: string, id: string, value: unknown) {
    if (
      collection === "jobs" &&
      value &&
      typeof value === "object" &&
      "uploadId" in value &&
      typeof value.uploadId === "string"
    ) {
      return value.uploadId;
    }

    if (collection === "proactive-insights" && id.startsWith("current_")) {
      return id.slice("current_".length);
    }

    return id;
  }

  private async simulateUploadDelete(uploadId: string) {
    const job = await super.read<ProcessingJob>("jobs-by-upload", uploadId);

    await super.write("deleted-uploads", uploadId, {
      uploadId,
      deletedAt: "2026-06-03T00:00:00.000Z"
    });
    await super.delete("uploads", uploadId);

    if (job?.id) {
      await super.delete("jobs", job.id);
    }

    await Promise.all([
      super.delete("jobs-by-upload", uploadId),
      super.delete("segments", uploadId),
      super.delete("semantic-segments", uploadId),
      super.delete("brief-items", uploadId)
    ]);
  }
}

class RecordingJobStore extends JsonStore {
  readonly progressWrites: number[] = [];

  override async write<T>(collection: string, id: string, value: T): Promise<void> {
    if (collection === "jobs-by-upload" && isProcessingJob(value)) {
      this.progressWrites.push(value.progress);
    }
    await super.write(collection, id, value);
  }
}

class EvaluationAuditOrderStore extends JsonStore {
  readonly terminalWrites: string[] = [];

  override async write<T>(collection: string, id: string, value: T): Promise<void> {
    if (collection === "evaluation-reports") {
      this.terminalWrites.push("audit-report");
    }
    if (collection === "uploads" && hasReadyStatus(value)) {
      this.terminalWrites.push("upload-ready");
    }
    if (collection === "jobs-by-upload" && isProcessingJob(value) && value.status === "ready") {
      this.terminalWrites.push("job-ready");
    }
    await super.write(collection, id, value);
  }
}

class FailingProactiveInsightCacheStore extends JsonStore {
  override async write<T>(collection: string, id: string, value: T): Promise<void> {
    if (collection === "proactive-insights") {
      throw new Error("proactive insight cache unavailable");
    }
    await super.write(collection, id, value);
  }
}

class MutationRecordingStore extends JsonStore {
  readonly mutations: Array<{ collection: string; id: string; operation: "write" | "delete" }> = [];

  override async write<T>(collection: string, id: string, value: T): Promise<void> {
    this.mutations.push({ collection, id, operation: "write" });
    await super.write(collection, id, value);
  }

  override async delete(collection: string, id: string): Promise<void> {
    this.mutations.push({ collection, id, operation: "delete" });
    await super.delete(collection, id);
  }
}

function restoreProviderEnv(
  key:
    | "TRANSCRIPTION_PROVIDER"
    | "EXTRACTION_PROVIDER"
    | "AUDIO_INSIGHT_PROVIDER"
    | "AUDIO_INSIGHT_FALLBACK_PROVIDER"
    | "DAILY_REFLECTION_AUDIO_CAPABILITY_SECRET"
    | "MEMORY_OWNER_REVIEW_ENABLED",
  value: string | undefined
) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

beforeEach(() => {
  delete process.env.EVALUATION_MODE;
  delete process.env.DEBUG_SAVE_PROVIDER_RESPONSE;
  delete process.env.MEMORY_OWNER_REVIEW_ENABLED;
  extractFfmpegAcousticFeaturesMock.mockResolvedValue([]);
  emotionSignalAnalyzeMock.mockResolvedValue([]);
  getEmotionSignalProviderMock.mockReturnValue({ analyze: emotionSignalAnalyzeMock });
  relationshipSignalAnalyzeMock.mockResolvedValue([]);
  getRelationshipSignalProviderMock.mockReturnValue({ analyze: relationshipSignalAnalyzeMock });
  proactiveInsightGenerateMock.mockImplementation(async ({ sourceFingerprint }: { sourceFingerprint?: string }) => ({
    status: "disabled",
    items: [],
    provider: "none",
    elapsedMs: 0,
    sourceFingerprint: sourceFingerprint ?? "disabled"
  }));
  getProactiveInsightProviderMock.mockReturnValue({ generate: proactiveInsightGenerateMock });
  applyMemoryRelevanceGateMock.mockImplementation(async ({ memoryContext }) => ({
    memoryContext,
    candidates: memoryContext.memories.length,
    accepted: memoryContext.memories.length,
    rejected: 0,
    averageRelevanceScore: memoryContext.memories.length > 0 ? 0.8 : 0,
    fallback: false
  }));
});

afterEach(async () => {
  if (originalEvaluationMode === undefined) {
    delete process.env.EVALUATION_MODE;
  } else {
    process.env.EVALUATION_MODE = originalEvaluationMode;
  }
  if (originalDebugSaveProviderResponse === undefined) {
    delete process.env.DEBUG_SAVE_PROVIDER_RESPONSE;
  } else {
    process.env.DEBUG_SAVE_PROVIDER_RESPONSE = originalDebugSaveProviderResponse;
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
  extractFfmpegAcousticFeaturesMock.mockReset();
  emotionSignalAnalyzeMock.mockReset();
  getEmotionSignalProviderMock.mockReset();
  relationshipSignalAnalyzeMock.mockReset();
  getRelationshipSignalProviderMock.mockReset();
  proactiveInsightGenerateMock.mockReset();
  getProactiveInsightProviderMock.mockReset();
  applyMemoryRelevanceGateMock.mockReset();
});

describe("processUpload", () => {
  it("rejects daily reflection uploads before the standard pipeline mutates any state", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-daily-reflection-guard-"));
    const store = new MutationRecordingStore(tempDir);
    const upload = {
      id: "upload_daily_reflection_guard",
      originalName: "reflection.wav",
      mimeType: "audio/wav",
      sizeBytes: 10,
      recordingDate: "2026-08-13",
      status: "uploaded" as const,
      ingestionContext: "daily_reflection" as const,
      reflectionId: "reflection_1"
    };
    await store.write("uploads", upload.id, upload);
    store.mutations.length = 0;

    await expect(processUpload({ uploadId: upload.id, store })).rejects.toBeInstanceOf(
      DailyReflectionStandardPipelineRejectedError
    );

    expect(store.mutations).toEqual([]);
    await expect(store.read("uploads", upload.id)).resolves.toEqual(upload);
  });

  it("logs each post-ASR pipeline stage without transcript content", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const upload: AudioUpload = {
      id: "upload_stage_logs",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-06-03",
      status: "uploaded"
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });

      const result = await processUpload({ uploadId: upload.id, store });
      const logs = consoleInfo.mock.calls.map(([message]) => String(message));
      const lifecycle = await store.read<Record<string, unknown>>("relationship-lifecycle", upload.id);

      expect(result.job.status).toBe("ready");
      expect(lifecycle).toEqual(expect.objectContaining({
        version: 1,
        uploadId: upload.id,
        signalCount: expect.any(Number),
        edges: expect.any(Array),
        audit: expect.objectContaining({ candidatePairsChecked: expect.any(Number) })
      }));
      expect(logs).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^\[audio-insights\] start segments=\d+$/),
          expect.stringMatching(/^\[audio-insights\] chunks=\d+ .*parallel_elapsed_ms=\d+ merge_elapsed_ms=\d+$/),
          expect.stringMatching(/^\[audio-insights\] completed count=\d+ elapsed_ms=\d+$/),
          expect.stringMatching(/^\[ffmpeg-features\] start segments=\d+$/),
          expect.stringMatching(/^\[ffmpeg-features\] completed count=\d+ elapsed_ms=\d+$/),
          expect.stringMatching(/^\[semantic-segments\] start segments=\d+$/),
          expect.stringMatching(/^\[semantic-segments\] completed count=\d+ elapsed_ms=\d+$/),
          expect.stringMatching(/^\[extraction\] start segments=\d+ semantic_segments=\d+$/),
          expect.stringMatching(/^\[extraction\] completed count=\d+ elapsed_ms=\d+$/),
          expect.stringMatching(/^\[relationship-signals\] chunks=\d+ .*candidates=\d+ .*reducer_elapsed_ms=\d+$/),
          expect.stringMatching(/^\[relationship-lifecycle\] pairs_checked=\d+ edges_created=\d+ rejected_matches=\d+$/),
          expect.stringMatching(/^\[pipeline\] ready .*elapsed_ms=\d+$/)
        ])
      );
      expect(logs.join("\n")).not.toContain(result.segments[0]?.text ?? "never-present");
    } finally {
      consoleInfo.mockRestore();
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
    }
  });

  it("starts independent post-ASR analysis stages concurrently before semantic extraction", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-parallel-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const originalAudioInsightProvider = process.env.AUDIO_INSIGHT_PROVIDER;
    const startedStages: string[] = [];
    let releaseStages: (() => void) | undefined;
    const stageGate = new Promise<void>((resolve) => {
      releaseStages = resolve;
    });
    let processing: ReturnType<typeof processUpload> | undefined;
    const extractionProvider = {
      extract: vi.fn(
        async (
          uploadId: string,
          segments: TranscriptSegment[],
          options?: extractionProviderModule.ExtractionOptions
        ) => {
          startedStages.push("extraction");
          expect(options?.semanticSegments?.length).toBeGreaterThan(0);
          return extractBriefItems(uploadId, segments);
        }
      )
    };
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const upload: AudioUpload = {
      id: "upload_parallel_analysis",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-07-14",
      status: "uploaded"
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      process.env.AUDIO_INSIGHT_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });

      processing = processUpload({
        uploadId: upload.id,
        store,
        dependencies: {
          audioInsightProvider: {
            async analyze(uploadId, segments) {
              startedStages.push("audio-insight");
              await stageGate;
              return buildAudioInsights(uploadId, segments);
            }
          },
          acousticFeatureExtractor: async () => {
            startedStages.push("acoustic-features");
            await stageGate;
            return [];
          },
          emotionSignalProvider: {
            async analyze() {
              startedStages.push("emotion-signals");
              await stageGate;
              return [];
            }
          },
          extractionProvider
        }
      });

      await vi.waitFor(() => {
        expect(startedStages).toEqual(
          expect.arrayContaining(["audio-insight", "acoustic-features", "emotion-signals"])
        );
      });
      expect(startedStages).not.toContain("extraction");

      releaseStages?.();
      const result = await processing;
      const logs = consoleInfo.mock.calls.map(([message]) => String(message));
      const parallelCompletedIndex = logs.findIndex((line) =>
        line.startsWith("[analysis-parallel] completed")
      );
      const semanticStartedIndex = logs.findIndex((line) =>
        line.startsWith("[semantic-segments] start")
      );
      const extractionStartedIndex = logs.findIndex((line) => line.startsWith("[extraction] start"));

      expect(result.job.status).toBe("ready");
      expect(startedStages.indexOf("extraction")).toBeGreaterThan(
        startedStages.indexOf("emotion-signals")
      );
      expect(parallelCompletedIndex).toBeGreaterThanOrEqual(0);
      expect(semanticStartedIndex).toBeGreaterThan(parallelCompletedIndex);
      expect(extractionStartedIndex).toBeGreaterThan(semanticStartedIndex);
      expect(logs).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^\[analysis-parallel\] started segments=\d+$/),
          expect.stringMatching(
            /^\[analysis-parallel\] completed audio_insight_duration_ms=\d+ acoustic_duration_ms=\d+ emotion_duration_ms=\d+ elapsed_ms=\d+ audio_insight_fallback=false acoustic_fallback=false emotion_fallback=false$/
          )
        ])
      );
    } finally {
      releaseStages?.();
      await processing?.catch(() => undefined);
      consoleInfo.mockRestore();
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
      restoreProviderEnv("AUDIO_INSIGHT_PROVIDER", originalAudioInsightProvider);
    }
  });

  it("isolates an Audio Insight failure while acoustic and emotion stages still complete", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-parallel-fallback-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const acousticFeatureExtractor = vi.fn(async ({ segments }: { segments: TranscriptSegment[] }) => [
      {
        segmentId: segments[0].id,
        volume: "high" as const,
        pause: "normal" as const,
        overlap: false,
        confidence: 0.72
      }
    ]);
    const emotionSignalProvider = { analyze: vi.fn(async () => []) };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const upload: AudioUpload = {
      id: "upload_parallel_audio_fallback",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-07-14",
      status: "uploaded"
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });

      const result = await processUpload({
        uploadId: upload.id,
        store,
        dependencies: {
          audioInsightProvider: {
            async analyze() {
              throw new Error("audio insight unavailable");
            }
          },
          acousticFeatureExtractor,
          emotionSignalProvider
        }
      });

      expect(result.job.status).toBe("ready");
      expect(acousticFeatureExtractor).toHaveBeenCalledOnce();
      expect(emotionSignalProvider.analyze).toHaveBeenCalledOnce();
      expect(result.audioInsights.length).toBeGreaterThan(0);
      expect(result.audioInsights[0].voice.volume).toBe("high");
      expect(warnSpy).not.toHaveBeenCalledWith(
        "[analysis-parallel] stage=audio_insight failed; rule fallback will be used.",
        "Error"
      );
    } finally {
      warnSpy.mockRestore();
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
    }
  });

  it("isolates acoustic and emotion failures while preserving text Audio Insights", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-optional-fallbacks-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const audioInsightProvider = {
      analyze: vi.fn(async (uploadId: string, segments: TranscriptSegment[]) =>
        buildAudioInsights(uploadId, segments)
      )
    };
    const acousticFeatureExtractor = vi.fn(async () => {
      throw Object.assign(new Error("ffmpeg unavailable"), { code: "ENOENT" });
    });
    const emotionSignalProvider = {
      analyze: vi.fn(async () => {
        throw new Error("emotion provider unavailable");
      })
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const upload: AudioUpload = {
      id: "upload_parallel_optional_fallbacks",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-07-14",
      status: "uploaded"
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });

      const result = await processUpload({
        uploadId: upload.id,
        store,
        dependencies: {
          audioInsightProvider,
          acousticFeatureExtractor,
          emotionSignalProvider
        }
      });

      expect(result.job.status).toBe("ready");
      expect(audioInsightProvider.analyze).toHaveBeenCalledTimes(4);
      expect(audioInsightProvider.analyze.mock.calls.every(([, chunkSegments]) => chunkSegments.length === 1)).toBe(true);
      expect(acousticFeatureExtractor).toHaveBeenCalledOnce();
      expect(emotionSignalProvider.analyze).toHaveBeenCalledOnce();
      expect(result.audioInsights.length).toBeGreaterThan(0);
      expect(result.audioInsights.every((insight) => insight.uploadId === upload.id)).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        "[audio feature fallback] ffmpeg acoustic feature extraction failed; text-based audio insights will be used.",
        "Error"
      );
      expect(warnSpy).toHaveBeenCalledWith(
        "[emotion signal fallback] emotion signal analysis failed; existing audio insight evidence will be used.",
        "Error"
      );
    } finally {
      warnSpy.mockRestore();
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
    }
  });

  it("passes semantic segments into extraction and records chunk progress before ready", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-"));
    const store = new RecordingJobStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const extractionProvider = {
      extract: vi.fn(async (uploadId: string, segments: TranscriptSegment[], options?: extractionProviderModule.ExtractionOptions) => {
        expect(options?.semanticSegments?.length).toBeGreaterThan(0);
        await options?.onProgress?.({
          phase: "planned",
          segmentCount: segments.length,
          inputChars: 1_000,
          inputBytes: 2_000,
          estimatedTokensMin: 250,
          estimatedTokensMax: 667,
          chunkCount: 2,
          longForm: true,
          oversizedChunkCount: 0
        });
        await options?.onProgress?.({
          phase: "chunk_completed",
          chunkIndex: 1,
          chunkCount: 2,
          itemCount: 1,
          elapsedMs: 100,
          provider: "openai"
        });
        await options?.onProgress?.({
          phase: "chunk_fallback",
          chunkIndex: 2,
          chunkCount: 2,
          itemCount: 1,
          elapsedMs: 50,
          reason: "fetch_timeout"
        });
        const items = extractBriefItems(uploadId, segments);
        await options?.onProgress?.({
          phase: "merged",
          rawItemCount: items.length,
          validItemCount: items.length,
          deduplicatedItemCount: items.length,
          finalItemCount: items.length,
          fallbackChunks: 1,
          elapsedMs: 200
        });
        return items;
      })
    };
    const providerSpy = vi.spyOn(extractionProviderModule, "getExtractionProvider").mockReturnValue(extractionProvider);
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const upload: AudioUpload = {
      id: "upload_extraction_progress",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-06-03",
      status: "uploaded"
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });

      const result = await processUpload({ uploadId: upload.id, store });

      expect(result.job.status).toBe("ready");
      expect(extractionProvider.extract).toHaveBeenCalledTimes(1);
      expect(store.progressWrites).toEqual([0, 25, 70, 80, 90, 92, 96, 100]);
      expect(relationshipSignalAnalyzeMock).toHaveBeenCalledTimes(2);
    } finally {
      providerSpy.mockRestore();
      consoleInfo.mockRestore();
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
    }
  });

  it("stores generated proactive insights before marking the upload ready", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-"));
    const store = new RecordingJobStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const createdAt = "2026-07-10T12:00:00.000Z";

    proactiveInsightGenerateMock.mockImplementation(
      async ({ context, sourceFingerprint }: { context: { evidence: Array<Record<string, unknown>> }; sourceFingerprint: string }) => ({
        status: "generated",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        elapsedMs: 25,
        sourceFingerprint,
        items: [
          {
            id: "pi_pipeline_1",
            scope: "current",
            type: "follow_up_question",
            category: "follow_up",
            observation: "录音中出现了一项仍需确认的下一步。",
            question: "这次还有什么需要继续确认？",
            reason: "摘要里留下了一项未确认内容。",
            confidence: 0.72,
            evidenceRefs: [context.evidence[0]],
            sourceUploadIds: ["upload_proactive_generated"],
            createdAt
          }
        ]
      })
    );

    const upload: AudioUpload = {
      id: "upload_proactive_generated",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-07-10",
      status: "uploaded"
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });

      const result = await processUpload({ uploadId: upload.id, store });
      const cache = await store.read<Record<string, unknown>>("proactive-insights", `current_${upload.id}`);

      expect(result.job.status).toBe("ready");
      expect(result.proactiveInsights).toHaveLength(1);
      expect(proactiveInsightGenerateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({ scope: "current", sourceUploadIds: [upload.id] }),
          sourceFingerprint: expect.any(String)
        })
      );
      expect(cache).toMatchObject({
        schemaVersion: 1,
        cacheId: `current_${upload.id}`,
        scope: "current",
        status: "generated",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        items: [expect.objectContaining({ id: "pi_pipeline_1" })]
      });
      expect(store.progressWrites).toContain(96);
    } finally {
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
    }
  });

  it("keeps the upload ready and caches fallback when proactive insight generation throws", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    proactiveInsightGenerateMock.mockRejectedValue(new Error("unexpected proactive insight failure"));

    const upload: AudioUpload = {
      id: "upload_proactive_fallback",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-07-10",
      status: "uploaded"
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });

      const result = await processUpload({ uploadId: upload.id, store });
      const cache = await store.read<Record<string, unknown>>("proactive-insights", `current_${upload.id}`);

      expect(result.job.status).toBe("ready");
      expect(result.proactiveInsights).toEqual([]);
      expect(cache).toMatchObject({
        status: "fallback",
        failureCode: "provider_error",
        items: []
      });
    } finally {
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
    }
  });

  it("keeps the upload ready when the optional proactive insight cache cannot be written", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-"));
    const store = new FailingProactiveInsightCacheStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const upload: AudioUpload = {
      id: "upload_proactive_cache_failure",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-07-10",
      status: "uploaded"
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });

      const result = await processUpload({ uploadId: upload.id, store });

      expect(result.job.status).toBe("ready");
      expect(result.proactiveInsights).toEqual([]);
      expect(await store.read("proactive-insights", `current_${upload.id}`)).toBeNull();
    } finally {
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
    }
  });

  it("creates transcript segments and evidence-backed brief items", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;

    const upload: AudioUpload = {
      id: "upload_1",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-06-03",
      status: "uploaded"
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });

      const result = await processUpload({ uploadId: upload.id, store });

      expect(result.job.status).toBe("ready");
      expect(result.segments.length).toBeGreaterThan(0);
      expect(result.audioInsights.length).toBeGreaterThan(0);
      expect(result.audioInsights.every((insight) => insight.sourceSegmentIds.length > 0)).toBe(true);
      expect(result.semanticSegments.length).toBeGreaterThan(0);
      expect(result.semanticSegments.every((segment) => segment.sourceSegmentIds.length > 0)).toBe(true);
      expect(result.briefItems.every((item) => item.sourceSegmentIds.length > 0)).toBe(true);
      const storedAudioInsights = await store.read<AudioInsight[]>("audio-insights", upload.id);
      expect(storedAudioInsights?.length).toBe(result.audioInsights.length);
    } finally {
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
    }
  });

  it("accepts the chunked transcription processor while preserving downstream segment contracts", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.wav");
    await writeFile(filePath, "fake audio");
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const originalAudioInsightProvider = process.env.AUDIO_INSIGHT_PROVIDER;
    const transcriptionProcessor = vi.fn(async ({ uploadId }: { uploadId: string }) => [
      {
        id: `${uploadId}_chunk_00000_seg_00001`,
        uploadId,
        startSeconds: 1,
        endSeconds: 3,
        speaker: "speaker_1",
        text: "我们周五前再确认一次。",
        confidence: 0.9,
        sceneLabels: ["self_reflection" as const],
        valueLabels: ["commitment" as const]
      }
    ]);
    const upload: AudioUpload = {
      id: "upload_chunk_processor",
      originalName: "demo.wav",
      mimeType: "audio/wav",
      sizeBytes: 10,
      recordingDate: "2026-07-14",
      status: "uploaded"
    };

    try {
      process.env.EXTRACTION_PROVIDER = "rule";
      process.env.AUDIO_INSIGHT_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });

      const result = await processUpload({
        uploadId: upload.id,
        store,
        dependencies: { transcriptionProcessor }
      });

      expect(transcriptionProcessor).toHaveBeenCalledWith(
        expect.objectContaining({
          uploadId: upload.id,
          store,
          filePath,
          audioAccessPolicy: "legacy_bearer"
        })
      );
      expect(result.job.status).toBe("ready");
      expect(result.segments).toEqual([
        expect.objectContaining({
          id: `${upload.id}_chunk_00000_seg_00001`,
          uploadId: upload.id,
          startSeconds: 1,
          endSeconds: 3
        })
      ]);
    } finally {
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
      restoreProviderEnv("AUDIO_INSIGHT_PROVIDER", originalAudioInsightProvider);
    }
  });

  it("runs voiceprint candidate generation before deleting the original audio", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-voiceprint-candidate-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.wav");
    await writeFile(filePath, "fake audio");
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const originalAudioInsightProvider = process.env.AUDIO_INSIGHT_PROVIDER;
    const upload: AudioUpload = {
      id: "upload_voiceprint_candidate",
      originalName: "demo.wav",
      mimeType: "audio/wav",
      sizeBytes: 10,
      recordingDate: "2026-07-29",
      status: "uploaded"
    };
    const transcriptSegment: TranscriptSegment = {
      id: `${upload.id}_chunk_00000_seg_00001`,
      uploadId: upload.id,
      startSeconds: 0,
      endSeconds: 35,
      speaker: "speaker_1",
      text: "这是一段本人声纹训练候选录音。",
      confidence: 0.9,
      sceneLabels: ["unknown"],
      valueLabels: []
    };
    const transcriptChunk = TranscriptChunkSchema.parse({
      id: `${upload.id}_transcript_chunk_00000`,
      uploadId: upload.id,
      audioChunkId: `${upload.id}_audio_chunk_00000`,
      index: 0,
      startSeconds: 0,
      endSeconds: 35,
      timebase: "upload_global",
      speakerIdScope: "chunk",
      speakerMap: { speaker_1: "speaker_1" },
      segments: [transcriptSegment],
      status: "completed",
      retryCount: 0,
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:01.000Z",
      startedAt: "2026-07-29T00:00:00.000Z",
      finishedAt: "2026-07-29T00:00:01.000Z",
      metadata: {}
    });
    const voiceprintCandidateGenerator = vi.fn(async (candidateInput: {
      sourceFilePath: string;
    }) => {
      await expect(access(candidateInput.sourceFilePath)).resolves.toBeUndefined();
      return [];
    });

    try {
      process.env.EXTRACTION_PROVIDER = "rule";
      process.env.AUDIO_INSIGHT_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });
      await store.write("transcript-chunks", transcriptChunk.id, transcriptChunk);

      const result = await processUpload({
        uploadId: upload.id,
        store,
        userId: "user_1",
        dependencies: {
          transcriptionProcessor: async () => [transcriptSegment],
          voiceprintCandidateGenerator
        }
      });

      expect(result.job.status).toBe("ready");
      expect(voiceprintCandidateGenerator).toHaveBeenCalledWith(
        expect.objectContaining({
          uploadId: upload.id,
          sourceFilePath: filePath,
          chunks: [transcriptChunk],
          resolvedSegments: [transcriptSegment]
        })
      );
      await expect(access(filePath)).rejects.toThrow();
    } finally {
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
      restoreProviderEnv("AUDIO_INSIGHT_PROVIDER", originalAudioInsightProvider);
    }
  });

  it("keeps the upload ready when voiceprint candidate generation fails", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-voiceprint-failure-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.wav");
    await writeFile(filePath, "fake audio");
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const originalAudioInsightProvider = process.env.AUDIO_INSIGHT_PROVIDER;
    const upload: AudioUpload = {
      id: "upload_voiceprint_candidate_failure",
      originalName: "demo.wav",
      mimeType: "audio/wav",
      sizeBytes: 10,
      recordingDate: "2026-07-29",
      status: "uploaded"
    };
    const transcriptSegment: TranscriptSegment = {
      id: `${upload.id}_chunk_00000_seg_00001`,
      uploadId: upload.id,
      startSeconds: 0,
      endSeconds: 35,
      speaker: "speaker_1",
      text: "这是一段候选生成失败时仍可继续处理的录音。",
      confidence: 0.9,
      sceneLabels: ["unknown"],
      valueLabels: []
    };
    const transcriptChunk = TranscriptChunkSchema.parse({
      id: `${upload.id}_transcript_chunk_00000`,
      uploadId: upload.id,
      audioChunkId: `${upload.id}_audio_chunk_00000`,
      index: 0,
      startSeconds: 0,
      endSeconds: 35,
      timebase: "upload_global",
      speakerIdScope: "chunk",
      speakerMap: { speaker_1: "speaker_1" },
      segments: [transcriptSegment],
      status: "completed",
      retryCount: 0,
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:01.000Z",
      startedAt: "2026-07-29T00:00:00.000Z",
      finishedAt: "2026-07-29T00:00:01.000Z",
      metadata: {}
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      process.env.EXTRACTION_PROVIDER = "rule";
      process.env.AUDIO_INSIGHT_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });
      await store.write("transcript-chunks", transcriptChunk.id, transcriptChunk);

      const result = await processUpload({
        uploadId: upload.id,
        store,
        userId: "user_1",
        dependencies: {
          transcriptionProcessor: async () => [transcriptSegment],
          voiceprintCandidateGenerator: async () => {
            throw new Error("candidate generation unavailable");
          }
        }
      });

      expect(result.job.status).toBe("ready");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `[voiceprint-candidates] noncritical_failure upload_id=${upload.id}`
        )
      );
      await expect(access(filePath)).rejects.toThrow();
    } finally {
      warn.mockRestore();
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
      restoreProviderEnv("AUDIO_INSIGHT_PROVIDER", originalAudioInsightProvider);
    }
  });

  it("falls back to rule audio insights when the AI audio insight provider fails", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const originalAudioInsightProvider = process.env.AUDIO_INSIGHT_PROVIDER;
    const originalAudioInsightFallbackProvider = process.env.AUDIO_INSIGHT_FALLBACK_PROVIDER;
    const openaiAnalyze = vi.spyOn(openaiAudioInsightProvider, "analyze").mockRejectedValue(new Error("model unavailable"));

    const upload: AudioUpload = {
      id: "upload_ai_insight_fallback",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-06-03",
      status: "uploaded"
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      process.env.AUDIO_INSIGHT_PROVIDER = "openai";
      process.env.AUDIO_INSIGHT_FALLBACK_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });

      const result = await processUpload({ uploadId: upload.id, store });
      const storedAudioInsights = await store.read<AudioInsight[]>("audio-insights", upload.id);

      expect(openaiAudioInsightProvider.analyze).toHaveBeenCalledTimes(4);
      expect(result.job.status).toBe("ready");
      expect(result.audioInsights.length).toBeGreaterThan(0);
      expect(storedAudioInsights?.length).toBe(result.audioInsights.length);
      expect(storedAudioInsights?.every((insight) => insight.uploadId === upload.id)).toBe(true);
    } finally {
      openaiAnalyze.mockRestore();
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
      restoreProviderEnv("AUDIO_INSIGHT_PROVIDER", originalAudioInsightProvider);
      restoreProviderEnv("AUDIO_INSIGHT_FALLBACK_PROVIDER", originalAudioInsightFallbackProvider);
    }
  });

  it("continues extraction, relationship signals, memory and ready when DeepSeek audio insights fail", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const originalAudioInsightProvider = process.env.AUDIO_INSIGHT_PROVIDER;
    const originalAudioInsightFallbackProvider = process.env.AUDIO_INSIGHT_FALLBACK_PROVIDER;
    const deepseekAnalyze = vi
      .spyOn(deepseekAudioInsightProvider, "analyze")
      .mockRejectedValue(new Error("timeout"));
    const memoryRepository = {
      replaceUploadMemories: vi.fn(() => ({
        inputCount: 2,
        memoryCount: 2,
        mergedCount: 0,
        relationCount: 0
      })),
      getRelevantMemories: vi.fn(() => [])
    };
    const upload: AudioUpload = {
      id: "upload_deepseek_audio_fallback",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-06-03",
      status: "uploaded"
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      process.env.AUDIO_INSIGHT_PROVIDER = "deepseek";
      process.env.AUDIO_INSIGHT_FALLBACK_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });

      const result = await processUpload({
        uploadId: upload.id,
        store,
        userId: "user_1",
        memoryRepository
      });

      expect(result.job.status).toBe("ready");
      expect(deepseekAudioInsightProvider.analyze).toHaveBeenCalledTimes(4);
      expect(result.audioInsights.length).toBeGreaterThan(0);
      expect(result.briefItems.length).toBeGreaterThan(0);
      expect(relationshipSignalAnalyzeMock).toHaveBeenCalledTimes(2);
      expect(memoryRepository.replaceUploadMemories).toHaveBeenCalledTimes(1);
      expect(await store.read("memory-owner-audits", upload.id)).toEqual(
        expect.objectContaining({ version: 1, memoriesProcessed: expect.any(Number) })
      );
      expect(proactiveInsightGenerateMock).toHaveBeenCalledTimes(1);
    } finally {
      deepseekAnalyze.mockRestore();
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
      restoreProviderEnv("AUDIO_INSIGHT_PROVIDER", originalAudioInsightProvider);
      restoreProviderEnv("AUDIO_INSIGHT_FALLBACK_PROVIDER", originalAudioInsightFallbackProvider);
    }
  });

  it("keeps the upload ready and stores empty relationship signals when relationship signal extraction fails", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    relationshipSignalAnalyzeMock.mockRejectedValue(new Error("relationship model unavailable"));

    const upload: AudioUpload = {
      id: "upload_relationship_fallback",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-06-03",
      status: "uploaded"
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });

      const result = await processUpload({ uploadId: upload.id, store });
      const storedRelationshipSignals = await store.read("relationship-signals", upload.id);

      expect(relationshipSignalAnalyzeMock).toHaveBeenCalledTimes(2);
      expect(result.job.status).toBe("ready");
      expect(storedRelationshipSignals).toEqual([]);
    } finally {
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
    }
  });

  it("enriches audio insights with real acoustic features from the uploaded file", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    extractFfmpegAcousticFeaturesMock.mockResolvedValue([
      {
        segmentId: "seg_customer_1",
        volume: "high",
        pause: "many",
        overlap: true,
        confidence: 0.72,
        explanations: [
          { kind: "volume", label: "音量更高", detail: "这一段平均音量更高。", confidence: 0.72 },
          { kind: "pause", label: "停顿变多", detail: "这一段停顿和静音比例更高。", confidence: 0.68 },
          { kind: "overlap", label: "多人重叠", detail: "这一段检测到多人重叠说话。", confidence: 0.72 }
        ]
      }
    ]);

    const upload: AudioUpload = {
      id: "upload_acoustic",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-06-03",
      status: "uploaded"
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });

      const result = await processUpload({ uploadId: upload.id, store });
      const storedAudioInsights = await store.read<AudioInsight[]>("audio-insights", upload.id);

      expect(extractFfmpegAcousticFeaturesMock).toHaveBeenCalledWith({
        filePath,
        segments: expect.any(Array)
      });
      expect(result.audioInsights[0].voice).toMatchObject({
        volume: "high",
        pause: "many",
        overlap: true,
        confidence: 0.72
      });
      expect(storedAudioInsights?.[0].voice).toMatchObject({
        volume: "high",
        pause: "many",
        overlap: true,
        confidence: 0.72
      });
      expect(result.audioInsights[0].atmosphereLabels).toEqual(expect.arrayContaining(["tense"]));
      expect(result.audioInsights[0].atmosphereLabels).toEqual(expect.arrayContaining(["uncertain"]));
      expect(result.audioInsights[0].emotionEvidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "acoustic",
            sourceSegmentIds: expect.arrayContaining(["seg_customer_1"])
          })
        ])
      );
      expect(storedAudioInsights?.[0].atmosphereLabels).toEqual(expect.arrayContaining(["tense"]));
      expect(storedAudioInsights?.[0].atmosphereLabels).toEqual(expect.arrayContaining(["uncertain"]));
      expect(storedAudioInsights?.[0].emotionEvidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "acoustic",
            sourceSegmentIds: expect.arrayContaining(["seg_customer_1"])
          })
        ])
      );
    } finally {
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
    }
  });

  it("keeps text-derived emotion evidence when acoustic feature extraction fails", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const ffmpegError = Object.assign(new Error("ffmpeg unavailable"), { code: "ENOENT" });
    extractFfmpegAcousticFeaturesMock.mockRejectedValueOnce(ffmpegError);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const upload: AudioUpload = {
      id: "upload_acoustic_fallback",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-06-03",
      status: "uploaded"
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });

      const result = await processUpload({ uploadId: upload.id, store });

      expect(result.job.status).toBe("ready");
      expect(result.audioInsights.some((insight) => insight.emotionEvidence?.some((evidence) => evidence.source === "fusion"))).toBe(true);
      expect(result.audioInsights.every((insight) => insight.emotionEvidence?.every((evidence) => evidence.source !== "acoustic"))).toBe(true);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringMatching(/^\[ffmpeg-features\] failed elapsed_ms=\d+ error_name=Error error_code=ENOENT$/)
      );
    } finally {
      infoSpy.mockRestore();
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
    }
  });

  it("merges external emotion signal provider evidence into stored audio insights", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    emotionSignalAnalyzeMock.mockResolvedValueOnce([
      {
        id: "external_emotion_1",
        kind: "atmosphere",
        label: "外部模型：认真偏紧",
        normalizedLabel: "tense",
        source: "llm",
        confidence: 0.81,
        detail: "外部模型结合声音和原文认为这一段有认真偏紧线索。",
        sourceSegmentIds: ["seg_customer_1"],
        sourceTimeRange: { startSeconds: 420, endSeconds: 510 },
        features: [{ name: "provider", label: "external_emotion_model" }]
      }
    ]);

    const upload: AudioUpload = {
      id: "upload_external_emotion",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-06-03",
      status: "uploaded"
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });

      const result = await processUpload({ uploadId: upload.id, store });
      const storedAudioInsights = await store.read<AudioInsight[]>("audio-insights", upload.id);

      expect(getEmotionSignalProviderMock).toHaveBeenCalledTimes(1);
      expect(emotionSignalAnalyzeMock).toHaveBeenCalledWith({
        uploadId: upload.id,
        filePath,
        mimeType: upload.mimeType,
        segments: expect.arrayContaining([expect.objectContaining({ id: "seg_customer_1" })])
      });
      expect(result.audioInsights[0].emotionEvidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "external_emotion_1",
            source: "llm",
            normalizedLabel: "tense",
            sourceSegmentIds: ["seg_customer_1"]
          })
        ])
      );
      expect(storedAudioInsights?.[0].emotionEvidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "external_emotion_1",
            source: "llm",
            normalizedLabel: "tense",
            sourceSegmentIds: ["seg_customer_1"]
          })
        ])
      );
    } finally {
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
    }
  });

  it("deletes the uploaded audio file after processing succeeds", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;

    const upload: AudioUpload = {
      id: "upload_delete_audio_success",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-06-03",
      status: "uploaded"
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });

      const result = await processUpload({ uploadId: upload.id, store });

      expect(result.job.status).toBe("ready");
      await expect(access(filePath)).rejects.toThrow();
      const storedUpload = await store.read<StoredUpload>("uploads", upload.id);
      expect(storedUpload?.status).toBe("ready");
      expect("filePath" in (storedUpload ?? {})).toBe(false);
      expect(await store.read("evaluation-reports", upload.id)).toBeNull();
    } finally {
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
    }
  });

  it("uses production cleanup for an unmarked upload even when evaluation mode is enabled", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-unmarked-evaluation-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "ordinary.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const upload: AudioUpload = {
      id: "upload_unmarked_evaluation_mode",
      originalName: "ordinary.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-07-16",
      status: "uploaded"
    };

    try {
      process.env.EVALUATION_MODE = "true";
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });

      const result = await processUpload({ uploadId: upload.id, store });

      expect(result.job.status).toBe("ready");
      await expect(access(filePath)).rejects.toThrow();
      const storedUpload = await store.read<StoredUpload & { filePath?: string }>("uploads", upload.id);
      expect(storedUpload?.status).toBe("ready");
      expect("filePath" in (storedUpload ?? {})).toBe(false);
      expect(await store.read("evaluation-reports", upload.id)).toBeNull();
    } finally {
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
    }
  });

  it("retains the uploaded audio and ready artifacts in evaluation mode", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-evaluation-"));
    const store = new EvaluationAuditOrderStore(tempDir);
    const filePath = join(tempDir, "evaluation.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const memoryDatabase = openMemoryDatabase({ filePath: join(tempDir, "evaluation-memory.sqlite") });
    const memoryRepository = createMemoryRepository(memoryDatabase);
    const upload: AudioUpload = {
      id: "upload_retain_audio_success",
      originalName: "evaluation.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-07-16",
      status: "uploaded"
    };

    try {
      process.env.EVALUATION_MODE = "true";
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath, evaluationRetention: true });

      const result = await processUpload({
        uploadId: upload.id,
        store,
        userId: "evaluation-user",
        memoryRepository
      });

      expect(result.job.status).toBe("ready");
      await expect(access(filePath)).resolves.toBeUndefined();
      const storedUpload = await store.read<StoredUpload & { filePath?: string }>("uploads", upload.id);
      expect(storedUpload).toMatchObject({ status: "ready", filePath });
      expect(await store.read("segments", upload.id)).not.toBeNull();
      expect((await store.listIds("analysis-chunks")).length).toBeGreaterThan(0);
      const report = await store.read<EvaluationAuditReport>("evaluation-reports", upload.id);
      expect(report).toMatchObject({
        mode: "evaluation_retention",
        uploadId: upload.id,
        status: "ready",
        retention: {
          uploadRecordRetained: true,
          uploadFilePathRetained: true,
          uploadFileExists: true,
          automaticDeleteBlocked: true,
          explicitConfirmedDeleteAllowed: true
        },
        memory: {
          auditStatus: "completed",
          audited: true
        }
      });
      expect(report?.artifacts.transcriptSegments).toBe(result.segments.length);
      expect(report?.artifacts.analysisCheckpoints).toBeGreaterThan(0);
      expect(report?.artifacts.providerRawResponses).toEqual({
        version: 1,
        enabled: false,
        fileCount: 0,
        aggregateSha256: null,
        files: []
      });
      expect(report?.relationship.reducerAuditAvailable).toBe(true);
      expect(report?.relationship.lifecycleAuditAvailable).toBe(true);
      expect(report?.relationship.lifecycleAudit).toEqual(expect.objectContaining({
        candidatePairsChecked: expect.any(Number),
        lifecycleEdgesCreated: expect.any(Number),
        edges: expect.any(Array)
      }));
      expect(store.terminalWrites).toEqual(["audit-report", "upload-ready", "job-ready"]);
      expect(report?.evidenceFirst).toMatchObject({
        audited: true,
        invalidSourceIds: 0,
        nonVerbatimQuotes: 0,
        memoriesWithoutEvidence: 0
      });
      expect(report?.evidenceFirst.duplicateEvidence).toEqual(expect.any(Number));
      expect(memoryRepository.getRelevantMemories({
        userId: "evaluation-user",
        uploadId: upload.id,
        limit: 100
      })).toEqual([]);
    } finally {
      memoryDatabase.close();
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
    }
  });

  it("preserves stored transcript segments when extraction fails", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    extractFfmpegAcousticFeaturesMock.mockResolvedValueOnce([
      {
        segmentId: "seg_customer_1",
        volume: "high",
        pause: "many",
        overlap: true,
        confidence: 0.72,
        explanations: [
          { kind: "volume", label: "音量更高", detail: "这一段平均音量更高。", confidence: 0.72 },
          { kind: "pause", label: "停顿变多", detail: "这一段停顿和静音比例更高。", confidence: 0.68 },
          { kind: "overlap", label: "多人重叠", detail: "这一段检测到多人重叠说话。", confidence: 0.72 }
        ]
      }
    ]);

    const upload: AudioUpload = {
      id: "upload_2",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-06-03",
      status: "uploaded"
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "unknown-provider";
      await store.write("uploads", upload.id, { ...upload, filePath });

      const result = await processUpload({ uploadId: upload.id, store });
      const storedSegments = await store.read<TranscriptSegment[]>("segments", upload.id);
      const storedAudioInsights = await store.read<AudioInsight[]>("audio-insights", upload.id);
      const storedSemanticSegments = await store.read("semantic-segments", upload.id);
      const storedUpload = await store.read<StoredUpload>("uploads", upload.id);

      expect(result.job.status).toBe("failed");
      expect(storedUpload?.status).toBe("failed");
      expect(storedUpload?.errorCode).toBe("processing_failed");
      expect(storedUpload?.errorMessage).toBeTruthy();
      expect(storedSegments?.length).toBeGreaterThan(0);
      expect(storedSegments?.every((segment) => segment.uploadId === upload.id)).toBe(true);
      expect(storedAudioInsights?.length).toBeGreaterThan(0);
      expect(storedAudioInsights?.every((insight) => insight.uploadId === upload.id)).toBe(true);
      expect(result.audioInsights[0].voice).toMatchObject({
        volume: "high",
        pause: "many",
        overlap: true,
        confidence: 0.72
      });
      expect(storedAudioInsights?.[0].voice).toMatchObject({
        volume: "high",
        pause: "many",
        overlap: true,
        confidence: 0.72
      });
      expect(result.audioInsights[0].atmosphereLabels).toEqual(expect.arrayContaining(["tense", "uncertain"]));
      expect(storedAudioInsights?.[0].atmosphereLabels).toEqual(expect.arrayContaining(["tense", "uncertain"]));
      expect(result.audioInsights[0].emotionEvidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: "acoustic" }),
          expect.objectContaining({ source: "fusion" })
        ])
      );
      expect(storedAudioInsights?.[0].emotionEvidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: "acoustic" }),
          expect.objectContaining({ source: "fusion" })
        ])
      );
      expect(storedSemanticSegments).not.toBeNull();
    } finally {
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
    }
  });

  it("stages participant audio only for a marked date-companion upload before deleting raw audio", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-date-companion-stage-"));
    const store = new JsonStore(tempDir);
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const originalDailyReflectionCapabilitySecret =
      process.env.DAILY_REFLECTION_AUDIO_CAPABILITY_SECRET;
    const transcriptionProcessor = vi.fn(async ({ uploadId }: { uploadId: string }) => [{
      id: `${uploadId}_seg_1`,
      uploadId,
      startSeconds: 0,
      endSeconds: 2,
      speaker: "speaker_0",
      text: "date companion transcript",
      confidence: 0.9,
      sceneLabels: ["unknown" as const],
      valueLabels: []
    }]);
    const stager = vi.fn(async (input: Parameters<typeof stageDateCompanionParticipantAudio>[0]) => {
      await expect(access(input.sourceFilePath)).resolves.toBeUndefined();
      return stageDateCompanionParticipantAudio({
        ...input,
        buildAudioSamples: async () => [{
          speakerId: "speaker_0",
          mimeType: "audio/mpeg" as const,
          durationMilliseconds: 2_000,
          audio: new Uint8Array([1, 2, 3]),
          sourceRanges: [{ startMilliseconds: 0, endMilliseconds: 2_000 }]
        }]
      });
    });
    const memoryRepository = {
      replaceUploadMemories: vi.fn(() => ({ inputCount: 0, memoryCount: 0, mergedCount: 0, relationCount: 0 })),
      getRelevantMemories: vi.fn(() => []),
      deleteByUpload: vi.fn()
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      delete process.env.DAILY_REFLECTION_AUDIO_CAPABILITY_SECRET;
      for (const marked of [true, false]) {
        const uploadId = marked ? "upload_date_companion" : "upload_regular";
        const filePath = join(tempDir, `${uploadId}.wav`);
        await writeFile(filePath, "fake audio");
        await store.write("uploads", uploadId, {
          id: uploadId,
          originalName: "demo.wav",
          mimeType: "audio/wav",
          sizeBytes: 10,
          recordingDate: "2026-08-04",
          status: "uploaded",
          filePath,
          ...(marked ? { dateCompanionAudioSnapshotVersion: 1 } : {})
        });

        const result = await processUpload({
          uploadId,
          store,
          userId: "user_1",
          memoryRepository,
          dependencies: {
            dateCompanionAudioStager: stager,
            transcriptionProcessor
          }
        });
        expect(result.job.status).toBe("ready");
        await expect(access(filePath)).rejects.toThrow();
      }

      expect(stager).toHaveBeenCalledOnce();
      expect(transcriptionProcessor).toHaveBeenCalledWith(expect.objectContaining({
        uploadId: "upload_date_companion",
        audioAccessPolicy: "legacy_bearer"
      }));
      expect(await store.read(
        DATE_COMPANION_AUDIO_STAGING_COLLECTION,
        "upload_date_companion"
      )).toMatchObject({ status: "ready", userId: "user_1" });
      expect(await store.read(
        DATE_COMPANION_AUDIO_STAGING_COLLECTION,
        "upload_regular"
      )).toBeNull();
    } finally {
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
      restoreProviderEnv(
        "DAILY_REFLECTION_AUDIO_CAPABILITY_SECRET",
        originalDailyReflectionCapabilitySecret
      );
    }
  });

  it("defers Date Companion Memory and owner review until explicit recap confirmation", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-date-companion-memory-gate-"));
    const store = new JsonStore(tempDir);
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const originalAudioInsightProvider = process.env.AUDIO_INSIGHT_PROVIDER;
    const originalMemoryOwnerReviewEnabled = process.env.MEMORY_OWNER_REVIEW_ENABLED;
    const memoryRepository = {
      replaceUploadMemories: vi.fn(() => ({
        inputCount: 2,
        memoryCount: 1,
        mergedCount: 0,
        relationCount: 0
      })),
      getRelevantMemories: vi.fn(() => [])
    };
    const memoryOwnerReviewCandidateGenerator = vi.fn(async () => []);
    const memoryOwnerReviewCandidateCleaner = vi.fn(async () => 0);
    const dateCompanionAudioStager = vi.fn(async ({
      uploadId,
      userId
    }: Parameters<typeof stageDateCompanionParticipantAudio>[0]) => ({
      version: 1 as const,
      uploadId,
      userId,
      createdAt: "2026-08-18T10:00:00.000Z",
      status: "not_applicable" as const,
      reason: "no_eligible_speaker_ranges" as const
    }));
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const segmentsForUpload = (uploadId: string): TranscriptSegment[] => [{
      id: `${uploadId}_known_preference`,
      uploadId,
      startSeconds: 0,
      endSeconds: 4,
      speaker: "speaker_self",
      identity: {
        globalSpeakerId: "person_user",
        identityType: "known_contact",
        confidence: 0.99,
        source: "voiceprint"
      },
      text: "我不喜欢香菜。",
      confidence: 0.96,
      sceneLabels: ["unknown"],
      valueLabels: []
    }, {
      id: `${uploadId}_pending_owner_preference`,
      uploadId,
      startSeconds: 5,
      endSeconds: 9,
      speaker: "Alice",
      identity: {
        globalSpeakerId: "unknown_provider_alice",
        identityType: "unknown_person",
        confidence: null,
        source: "provider_speaker_result",
        evidence: {
          type: "provider_label",
          provider: "company_voiceprint",
          providerLabel: "Alice"
        }
      },
      text: "我不太能吃辣。",
      confidence: 0.95,
      sceneLabels: ["unknown"],
      valueLabels: []
    }];
    const runUpload = async (uploadId: string, marked: boolean) => {
      const filePath = join(tempDir!, `${uploadId}.wav`);
      await writeFile(filePath, "fake audio");
      await store.write("uploads", uploadId, {
        id: uploadId,
        originalName: "memory-candidate.wav",
        mimeType: "audio/wav",
        sizeBytes: 10,
        recordingDate: "2026-08-18",
        status: "uploaded",
        filePath,
        ...(marked ? { dateCompanionAudioSnapshotVersion: 1 } : {})
      });
      await store.write("speaker-identities", uploadId, {
        structuralGate: { status: "healthy", reasons: [] }
      });
      return processUpload({
        uploadId,
        store,
        userId: "user_1",
        memoryRepository,
        dependencies: {
          transcriptionProcessor: async () => segmentsForUpload(uploadId),
          memoryOwnerReviewCandidateCleaner,
          memoryOwnerReviewCandidateGenerator,
          dateCompanionAudioStager
        }
      });
    };

    try {
      process.env.EXTRACTION_PROVIDER = "rule";
      process.env.AUDIO_INSIGHT_PROVIDER = "rule";
      process.env.MEMORY_OWNER_REVIEW_ENABLED = "true";

      const markedUploadId = "upload_date_companion_memory_gate";
      const markedResult = await runUpload(markedUploadId, true);

      expect(markedResult.job.status).toBe("ready");
      expect(memoryRepository.replaceUploadMemories).not.toHaveBeenCalled();
      expect(memoryOwnerReviewCandidateGenerator).not.toHaveBeenCalled();
      expect(await store.read("memory-owner-audits", markedUploadId)).toBeNull();
      expect(consoleInfo).toHaveBeenCalledWith(
        `[memory-index] skipped upload_id=${markedUploadId} reason=date_companion_confirmation_required`
      );

      const regularUploadId = "upload_regular_memory_control";
      const regularResult = await runUpload(regularUploadId, false);

      expect(regularResult.job.status).toBe("ready");
      expect(memoryRepository.replaceUploadMemories).toHaveBeenCalledOnce();
      expect(memoryRepository.replaceUploadMemories).toHaveBeenCalledWith(
        expect.objectContaining({
          uploadId: regularUploadId,
          memories: [expect.objectContaining({ type: "preference" })]
        })
      );
      expect(memoryOwnerReviewCandidateGenerator).toHaveBeenCalledOnce();
      expect(memoryOwnerReviewCandidateGenerator).toHaveBeenCalledWith(
        expect.objectContaining({
          uploadId: regularUploadId,
          drafts: [expect.objectContaining({
            memory: expect.objectContaining({ type: "preference" })
          })]
        })
      );
      expect(await store.read("memory-owner-audits", regularUploadId)).not.toBeNull();
    } finally {
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
      restoreProviderEnv("AUDIO_INSIGHT_PROVIDER", originalAudioInsightProvider);
      restoreProviderEnv("MEMORY_OWNER_REVIEW_ENABLED", originalMemoryOwnerReviewEnabled);
      consoleInfo.mockRestore();
    }
  });

  it("keeps raw audio and retry metadata when marked staging fails", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-date-companion-stage-fail-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.wav");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const uploadId = "upload_date_companion_stage_fail";

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      await store.write("uploads", uploadId, {
        id: uploadId,
        originalName: "demo.wav",
        mimeType: "audio/wav",
        sizeBytes: 10,
        recordingDate: "2026-08-04",
        status: "uploaded",
        filePath,
        dateCompanionAudioSnapshotVersion: 1
      });

      const result = await processUpload({
        uploadId,
        store,
        userId: "user_1",
        memoryRepository: {
          replaceUploadMemories: vi.fn(() => ({ inputCount: 0, memoryCount: 0, mergedCount: 0, relationCount: 0 })),
          getRelevantMemories: vi.fn(() => []),
          deleteByUpload: vi.fn()
        },
        dependencies: {
          dateCompanionAudioStager: vi.fn(async () => {
            throw new Error("snapshot unavailable");
          })
        }
      });

      expect(result.job.status).toBe("failed");
      await expect(access(filePath)).resolves.toBeUndefined();
      expect(await store.read<StoredUpload>("uploads", uploadId)).toMatchObject({
        status: "failed",
        filePath,
        errorCode: "processing_failed",
        dateCompanionAudioSnapshotVersion: 1
      });
      expect(await store.read(
        DATE_COMPANION_AUDIO_STAGING_COLLECTION,
        uploadId
      )).toBeNull();
    } finally {
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
    }
  });

  it("retains the uploaded audio file after processing fails so an outer retry can resume", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;

    const upload: AudioUpload = {
      id: "upload_delete_audio_failed",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-06-03",
      status: "uploaded"
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "unknown-provider";
      await store.write("uploads", upload.id, { ...upload, filePath });

      const result = await processUpload({ uploadId: upload.id, store });

      expect(result.job.status).toBe("failed");
      await expect(access(filePath)).resolves.toBeUndefined();
      const storedUpload = await store.read<StoredUpload>("uploads", upload.id);
      expect(storedUpload?.status).toBe("failed");
      expect(storedUpload?.filePath).toBe(filePath);
    } finally {
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
    }
  });

  it("does not write processing results for a deleted upload", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;

    const upload: AudioUpload = {
      id: "upload_deleted",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-06-03",
      status: "uploaded"
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });
      await store.write("deleted-uploads", upload.id, {
        uploadId: upload.id,
        deletedAt: "2026-06-03T00:00:00.000Z"
      });

      await expect(processUpload({ uploadId: upload.id, store })).rejects.toBeInstanceOf(
        UploadProcessingCancelledError
      );

      expect(await store.read("jobs-by-upload", upload.id)).toBeNull();
      expect(await store.read("segments", upload.id)).toBeNull();
      expect(await store.read("audio-insights", upload.id)).toBeNull();
      expect(await store.read("semantic-segments", upload.id)).toBeNull();
      expect(await store.read("brief-items", upload.id)).toBeNull();
      expect(await store.read("proactive-insights", `current_${upload.id}`)).toBeNull();
      expect((await store.read<StoredUpload>("uploads", upload.id))?.status).toBe("uploaded");
    } finally {
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
    }
  });

  it("removes a proactive insight cache written during a mid-processing delete", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-"));
    const deleteTrigger = vi.fn((collection: string) => collection === "proactive-insights");
    const store = new DeleteDuringWriteStore(tempDir, deleteTrigger);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const upload: AudioUpload = {
      id: "upload_mid_delete_proactive",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-06-03",
      status: "uploaded"
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });

      const outcome = await processUpload({ uploadId: upload.id, store }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );

      expect(deleteTrigger.mock.calls.map(([collection]) => collection)).toContain("proactive-insights");
      expect(outcome).toEqual({ error: expect.any(UploadProcessingCancelledError) });
      expect(await store.read("deleted-uploads", upload.id)).not.toBeNull();
      expect(await store.read("uploads", upload.id)).toBeNull();
      expect(await store.read("proactive-insights", `current_${upload.id}`)).toBeNull();
    } finally {
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
    }
  });

  it("cleans Owner Review and Voiceprint sidecars after a mid-processing delete", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-sidecar-delete-"));
    const store = new DeleteDuringWriteStore(
      tempDir,
      (collection) => collection === "proactive-insights"
    );
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const upload: AudioUpload = {
      id: "upload_mid_delete_sidecars",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-06-03",
      status: "uploaded"
    };
    const now = "2026-08-12T00:00:00.000Z";
    const expiresAt = "2026-08-19T00:00:00.000Z";
    const ownerRepository = new MemoryOwnerReviewRepository(store);
    const voiceprintRepository = new VoiceprintTrainingCandidateRepository(store);
    const memoryRepository = {
      replaceUploadMemories: vi.fn(() => ({
        inputCount: 0,
        memoryCount: 0,
        mergedCount: 0,
        relationCount: 0
      })),
      getRelevantMemories: vi.fn(() => []),
      deleteByUpload: vi.fn()
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });
      await ownerRepository.saveCandidate({
        version: 1,
        candidateId: "mor_mid_delete",
        uploadId: upload.id,
        memoryId: "memory_mid_delete",
        memoryType: "preference",
        title: "待确认偏好",
        summary: "待确认偏好",
        evidenceSegmentIds: ["segment_mid_delete"],
        evidenceDigest: "a".repeat(64),
        providerLabels: ["Alice"],
        structuralGate: { status: "blocked", reasons: ["test"] },
        status: "daily_only",
        audioClips: [],
        failureReason: "structural_gate_blocked",
        createdAt: now,
        updatedAt: now,
        expiresAt
      });
      await voiceprintRepository.save({
        version: 1,
        candidateId: "vp_mid_delete",
        uploadId: upload.id,
        candidateKey: "chunk_0::speaker_1",
        chunkId: "chunk_0",
        chunkIndex: 0,
        localSpeaker: "speaker_1",
        segmentIds: [],
        sourceRanges: [],
        durationMilliseconds: 0,
        audioFilePath: null,
        identityState: "unknown",
        status: "insufficient",
        createdAt: now,
        updatedAt: now,
        expiresAt
      });

      await expect(processUpload({
        uploadId: upload.id,
        store,
        userId: "user_1",
        memoryRepository,
        dependencies: {
          memoryOwnerReviewCandidateCleaner: async () => 0
        }
      })).rejects.toBeInstanceOf(UploadProcessingCancelledError);

      expect(await ownerRepository.listCandidates(upload.id)).toEqual([]);
      expect(await voiceprintRepository.listByUpload(upload.id)).toEqual([]);
      expect(memoryRepository.deleteByUpload).toHaveBeenCalledWith("user_1", upload.id);
    } finally {
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
    }
  });

  it("removes memories that race with a mid-processing delete", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-"));
    const store = new DeleteDuringWriteStore(
      tempDir,
      (collection) => collection === "proactive-insights"
    );
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const memoryRepository = {
      replaceUploadMemories: vi.fn(() => ({
        inputCount: 0,
        memoryCount: 0,
        mergedCount: 0,
        relationCount: 0
      })),
      getRelevantMemories: vi.fn(() => []),
      deleteByUpload: vi.fn()
    };
    const upload: AudioUpload = {
      id: "upload_mid_delete_memory",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-06-03",
      status: "uploaded"
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });

      await expect(
        processUpload({
          uploadId: upload.id,
          store,
          userId: "user_1",
          memoryRepository
        })
      ).rejects.toBeInstanceOf(UploadProcessingCancelledError);

      expect(memoryRepository.replaceUploadMemories).toHaveBeenCalledOnce();
      expect(memoryRepository.deleteByUpload).toHaveBeenCalledWith("user_1", upload.id);
    } finally {
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
    }
  });

  it("cleans transcript segments written after a mid-processing delete", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-"));
    const store = new DeleteDuringWriteStore(tempDir, (collection) => collection === "segments");
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;

    const upload: AudioUpload = {
      id: "upload_mid_delete_segments",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-06-03",
      status: "uploaded"
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });

      await expect(processUpload({ uploadId: upload.id, store })).rejects.toBeInstanceOf(
        UploadProcessingCancelledError
      );

      expect(await store.read("deleted-uploads", upload.id)).not.toBeNull();
      expect(await store.read("uploads", upload.id)).toBeNull();
      expect(await store.read("jobs-by-upload", upload.id)).toBeNull();
      expect(await store.read("segments", upload.id)).toBeNull();
      expect(await store.read("audio-insights", upload.id)).toBeNull();
      expect(await store.read("semantic-segments", upload.id)).toBeNull();
      expect(await store.read("brief-items", upload.id)).toBeNull();
    } finally {
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
    }
  });

  it("cleans job records written after a mid-processing delete", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-"));
    const existingJob: ProcessingJob = {
      id: "job_mid_delete",
      uploadId: "upload_mid_delete_job",
      status: "waiting",
      progress: 0
    };
    const store = new DeleteDuringWriteStore(
      tempDir,
      (collection, _id, value) => collection === "jobs" && isProcessingJob(value) && value.status === "transcribing"
    );
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;

    const upload: AudioUpload = {
      id: existingJob.uploadId,
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-06-03",
      status: "uploaded"
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });
      await store.write("jobs", existingJob.id, existingJob);
      await store.write("jobs-by-upload", upload.id, existingJob);

      await expect(processUpload({ uploadId: upload.id, store })).rejects.toBeInstanceOf(
        UploadProcessingCancelledError
      );

      expect(await store.read("deleted-uploads", upload.id)).not.toBeNull();
      expect(await store.read("uploads", upload.id)).toBeNull();
      expect(await store.read("jobs", existingJob.id)).toBeNull();
      expect(await store.read("jobs-by-upload", upload.id)).toBeNull();
      expect(await store.read("segments", upload.id)).toBeNull();
      expect(await store.read("audio-insights", upload.id)).toBeNull();
      expect(await store.read("semantic-segments", upload.id)).toBeNull();
      expect(await store.read("brief-items", upload.id)).toBeNull();
    } finally {
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
    }
  });

  it("logs v1.5 memory scoring, deduplication and relation counts", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const memoryRepository = {
      replaceUploadMemories: vi.fn(() => ({
        inputCount: 4,
        memoryCount: 3,
        mergedCount: 1,
        relationCount: 2
      })),
      getRelevantMemories: vi.fn(() => [
        {
          id: "memory_commitment_history",
          userId: "user_1",
          type: "commitment" as const,
          title: "Confirm the next meeting",
          summary: "A previous date still needs confirmation.",
          importance: 0.86,
          importanceScore: 0.86,
          importanceReasons: ["commitment type"],
          status: "active" as const,
          occurrenceCount: 1,
          firstSeenDate: "2026-07-09",
          lastSeenDate: "2026-07-09",
          accessCount: 0,
          lastAccessedAt: null,
          date: "2026-07-09",
          createdAt: "2026-07-09T10:00:00.000Z",
          updatedAt: "2026-07-09T10:00:00.000Z",
          evidence: [
            {
              id: "memory_commitment_history_evidence",
              memoryId: "memory_commitment_history",
              sourceType: "transcript" as const,
              sourceId: "history_segment_1",
              uploadId: "history_upload_1",
              date: "2026-07-09",
              quote: "Let's confirm the exact time tomorrow.",
              createdAt: "2026-07-09T10:00:00.000Z"
            }
          ]
        }
      ])
    };
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const upload: AudioUpload = {
      id: "upload_memory_v15",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-07-10",
      status: "uploaded"
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });

      const result = await processUpload({
        uploadId: upload.id,
        store,
        userId: "user_1",
        memoryRepository
      });

      expect(result.job.status).toBe("ready");
      expect(infoSpy).toHaveBeenCalledWith(
        "[memory-index] updated user_id=user_1 upload_id=upload_memory_v15 input=4 memories=3 merged=1 relations=2"
      );
      expect(applyMemoryRelevanceGateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({ scope: "current" }),
          memoryContext: expect.objectContaining({
            memories: [expect.objectContaining({ memoryId: "memory_commitment_history" })]
          })
        })
      );
      expect(proactiveInsightGenerateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          memoryContext: expect.objectContaining({
            currentUploadId: upload.id,
            memories: [expect.objectContaining({ memoryId: "memory_commitment_history" })]
          }),
          sourceFingerprint: expect.any(String)
        })
      );
    } finally {
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
      infoSpy.mockRestore();
    }
  });

  it("keeps the upload ready when memory indexing fails", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalTranscriptionProvider = process.env.TRANSCRIPTION_PROVIDER;
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const memoryRepository = {
      replaceUploadMemories: vi.fn(() => {
        throw new Error("memory database unavailable");
      }),
      getRelevantMemories: vi.fn(() => {
        throw new Error("memory database unavailable");
      })
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const upload: AudioUpload = {
      id: "upload_memory_failure",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-07-10",
      status: "uploaded"
    };

    try {
      process.env.TRANSCRIPTION_PROVIDER = "fixture";
      process.env.EXTRACTION_PROVIDER = "rule";
      await store.write("uploads", upload.id, { ...upload, filePath });

      const result = await processUpload({
        uploadId: upload.id,
        store,
        userId: "user_1",
        memoryRepository
      });

      expect(result.job.status).toBe("ready");
      expect(memoryRepository.replaceUploadMemories).toHaveBeenCalledOnce();
      expect(memoryRepository.getRelevantMemories).toHaveBeenCalledOnce();
      expect(proactiveInsightGenerateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({ scope: "current" }),
          memoryContext: expect.objectContaining({ memories: [] })
        })
      );
      expect(warnSpy).toHaveBeenCalledWith(
        "[memory-index] update failed; upload processing will continue.",
        "memory database unavailable"
      );
      expect(warnSpy).toHaveBeenCalledWith(
        "[proactive-insights] memory context unavailable; current evidence will still be used.",
        "memory database unavailable"
      );
    } finally {
      restoreProviderEnv("TRANSCRIPTION_PROVIDER", originalTranscriptionProvider);
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
      warnSpy.mockRestore();
    }
  });

  it("keeps Memory owner review disabled unless explicitly enabled", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-owner-review-off-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const originalAudioInsightProvider = process.env.AUDIO_INSIGHT_PROVIDER;
    const originalMemoryOwnerReviewEnabled = process.env.MEMORY_OWNER_REVIEW_ENABLED;
    const memoryRepository = {
      replaceUploadMemories: vi.fn(() => ({
        inputCount: 0,
        memoryCount: 0,
        mergedCount: 0,
        relationCount: 0
      })),
      getRelevantMemories: vi.fn(() => [])
    };
    const memoryOwnerReviewCandidateGenerator = vi.fn(async () => []);
    const segment: TranscriptSegment = {
      id: "segment_owner_review_off",
      uploadId: "upload_owner_review_off",
      startSeconds: 0,
      endSeconds: 8,
      speaker: "Alice",
      identity: {
        globalSpeakerId: "unknown_alice",
        identityType: "unknown_person",
        confidence: null,
        source: "provider_speaker_result",
        evidence: {
          type: "provider_label",
          provider: "company_voiceprint",
          providerLabel: "Alice"
        }
      },
      text: "我不喜欢香菜。",
      confidence: 0.9,
      sceneLabels: ["unknown"],
      valueLabels: []
    };
    const upload: AudioUpload = {
      id: segment.uploadId,
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-08-10",
      status: "uploaded"
    };

    try {
      process.env.EXTRACTION_PROVIDER = "rule";
      process.env.AUDIO_INSIGHT_PROVIDER = "rule";
      process.env.MEMORY_OWNER_REVIEW_ENABLED = "false";
      await store.write("uploads", upload.id, { ...upload, filePath });

      const result = await processUpload({
        uploadId: upload.id,
        store,
        userId: "user_1",
        memoryRepository,
        dependencies: {
          transcriptionProcessor: async () => [segment],
          memoryOwnerReviewCandidateGenerator
        }
      });

      expect(result.job.status).toBe("ready");
      expect(memoryOwnerReviewCandidateGenerator).not.toHaveBeenCalled();
      expect(memoryRepository.replaceUploadMemories).toHaveBeenCalledWith(
        expect.objectContaining({ memories: [] })
      );
    } finally {
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
      restoreProviderEnv("AUDIO_INSIGHT_PROVIDER", originalAudioInsightProvider);
      restoreProviderEnv("MEMORY_OWNER_REVIEW_ENABLED", originalMemoryOwnerReviewEnabled);
    }
  });

  it("passes the verified identity structural gate to owner review and keeps failures observable", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-owner-review-on-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const originalAudioInsightProvider = process.env.AUDIO_INSIGHT_PROVIDER;
    const originalMemoryOwnerReviewEnabled = process.env.MEMORY_OWNER_REVIEW_ENABLED;
    const memoryRepository = {
      replaceUploadMemories: vi.fn(() => ({
        inputCount: 0,
        memoryCount: 0,
        mergedCount: 0,
        relationCount: 0
      })),
      getRelevantMemories: vi.fn(() => [])
    };
    const segment: TranscriptSegment = {
      id: "segment_owner_review_blocked",
      uploadId: "upload_owner_review_blocked",
      startSeconds: 2,
      endSeconds: 12,
      speaker: "Alice",
      identity: {
        globalSpeakerId: "unknown_alice",
        identityType: "unknown_person",
        confidence: null,
        source: "provider_speaker_result",
        evidence: {
          type: "provider_label",
          provider: "company_voiceprint",
          providerLabel: "Alice"
        }
      },
      text: "我不喜欢香菜。",
      confidence: 0.95,
      sceneLabels: ["unknown"],
      valueLabels: []
    };
    const upload: AudioUpload = {
      id: segment.uploadId,
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-08-10",
      status: "uploaded"
    };
    const memoryOwnerReviewCandidateGenerator = vi.fn(async () => {
      throw new Error("owner review store unavailable");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      process.env.EXTRACTION_PROVIDER = "rule";
      process.env.AUDIO_INSIGHT_PROVIDER = "rule";
      process.env.MEMORY_OWNER_REVIEW_ENABLED = "true";
      await store.write("uploads", upload.id, { ...upload, filePath });
      await store.write("speaker-identities", upload.id, {
        structuralGate: {
          status: "blocked",
          reasons: ["speaker_count_mismatch"]
        }
      });

      const result = await processUpload({
        uploadId: upload.id,
        store,
        userId: "user_1",
        memoryRepository,
        dependencies: {
          transcriptionProcessor: async () => [segment],
          memoryOwnerReviewCandidateGenerator
        }
      });

      expect(result.job.status).toBe("ready");
      expect(memoryOwnerReviewCandidateGenerator).toHaveBeenCalledOnce();
      expect(memoryOwnerReviewCandidateGenerator).toHaveBeenCalledWith(
        expect.objectContaining({
          drafts: [
            expect.objectContaining({
              structuralGate: {
                status: "blocked",
                reasons: ["speaker_count_mismatch"]
              },
              memory: expect.objectContaining({
                evidence: [
                  expect.objectContaining({
                    sourceId: segment.id,
                    uploadId: upload.id,
                    quote: segment.text
                  })
                ]
              }),
              evidenceSegments: [segment]
            })
          ]
        })
      );
      expect(memoryRepository.replaceUploadMemories).toHaveBeenCalledWith(
        expect.objectContaining({ memories: [] })
      );
      expect(warnSpy).toHaveBeenCalledWith(
        `[memory-owner-review] noncritical_failure upload_id=${upload.id} error_name=Error`
      );
    } finally {
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
      restoreProviderEnv("AUDIO_INSIGHT_PROVIDER", originalAudioInsightProvider);
      restoreProviderEnv("MEMORY_OWNER_REVIEW_ENABLED", originalMemoryOwnerReviewEnabled);
      warnSpy.mockRestore();
    }
  });

  it("cleans a prior-run Owner Review candidate when the rerun has no review drafts", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-owner-review-cleanup-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    const ownerReviewUploadsRoot = join(tempDir, "owner-review-uploads");
    await writeFile(filePath, "fake audio");
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const originalAudioInsightProvider = process.env.AUDIO_INSIGHT_PROVIDER;
    const originalMemoryOwnerReviewEnabled = process.env.MEMORY_OWNER_REVIEW_ENABLED;
    const upload: AudioUpload = {
      id: "upload_owner_review_rerun_no_draft",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-08-10",
      status: "uploaded"
    };
    const staleSegment: TranscriptSegment = {
      id: "segment_owner_review_stale",
      uploadId: upload.id,
      startSeconds: 0,
      endSeconds: 6,
      speaker: "Alice",
      identity: {
        globalSpeakerId: "unknown_alice",
        identityType: "unknown_person",
        confidence: null,
        source: "provider_speaker_result",
        evidence: {
          type: "provider_label",
          provider: "company_voiceprint",
          providerLabel: "Alice"
        }
      },
      text: "我不喜欢香菜。",
      confidence: 0.9,
      sceneLabels: [],
      valueLabels: []
    };
    const rerunSegment: TranscriptSegment = {
      id: "segment_owner_review_rerun",
      uploadId: upload.id,
      startSeconds: 0,
      endSeconds: 5,
      speaker: "speaker_1",
      text: "今天散步了。",
      confidence: 0.9,
      sceneLabels: [],
      valueLabels: []
    };
    const memoryRepository = {
      replaceUploadMemories: vi.fn(() => ({
        inputCount: 0,
        memoryCount: 0,
        mergedCount: 0,
        relationCount: 0
      })),
      getRelevantMemories: vi.fn(() => [])
    };

    try {
      process.env.EXTRACTION_PROVIDER = "rule";
      process.env.AUDIO_INSIGHT_PROVIDER = "rule";
      process.env.MEMORY_OWNER_REVIEW_ENABLED = "false";
      await store.write("uploads", upload.id, { ...upload, filePath });
      await generateMemoryOwnerReviewCandidates({
        store,
        uploadId: upload.id,
        sourceFilePath: null,
        uploadsRootDir: ownerReviewUploadsRoot,
        drafts: [{
          memory: {
            id: "memory_owner_review_stale",
            type: "preference",
            title: "饮食偏好",
            summary: staleSegment.text,
            importance: 0.8,
            importanceReasons: ["test"],
            date: upload.recordingDate,
            createdAt: "2026-08-10T00:00:00.000Z",
            updatedAt: "2026-08-10T00:00:00.000Z",
            evidence: [{
              id: "evidence_owner_review_stale",
              sourceType: "transcript",
              sourceId: staleSegment.id,
              uploadId: upload.id,
              date: upload.recordingDate,
              quote: staleSegment.text,
              createdAt: "2026-08-10T00:00:00.000Z"
            }]
          },
          evidenceSegments: [staleSegment],
          providerLabels: ["Alice"],
          structuralGate: { status: "blocked", reasons: ["prior_run"] }
        }],
        now: () => "2026-08-10T00:00:00.000Z"
      });
      const repository = new MemoryOwnerReviewRepository(store);
      expect(await repository.listCandidates(upload.id)).toHaveLength(1);

      const result = await processUpload({
        uploadId: upload.id,
        store,
        userId: "user_1",
        memoryRepository,
        dependencies: {
          transcriptionProcessor: async () => [rerunSegment],
          memoryOwnerReviewCandidateCleaner: (cleanupInput) =>
            deleteMemoryOwnerReviewCandidatesForUpload({
              ...cleanupInput,
              uploadsRootDir: ownerReviewUploadsRoot
            })
        }
      });

      expect(result.job.status).toBe("ready");
      expect(await repository.listCandidates(upload.id)).toEqual([]);
      expect(memoryRepository.replaceUploadMemories).toHaveBeenCalledOnce();
    } finally {
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
      restoreProviderEnv("AUDIO_INSIGHT_PROVIDER", originalAudioInsightProvider);
      restoreProviderEnv("MEMORY_OWNER_REVIEW_ENABLED", originalMemoryOwnerReviewEnabled);
    }
  });

  it("cleans Owner Review state before generating replacement candidates", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-owner-review-order-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const originalAudioInsightProvider = process.env.AUDIO_INSIGHT_PROVIDER;
    const originalMemoryOwnerReviewEnabled = process.env.MEMORY_OWNER_REVIEW_ENABLED;
    const executionOrder: string[] = [];
    const memoryRepository = {
      replaceUploadMemories: vi.fn(() => ({
        inputCount: 0,
        memoryCount: 0,
        mergedCount: 0,
        relationCount: 0
      })),
      getRelevantMemories: vi.fn(() => [])
    };
    const upload: AudioUpload = {
      id: "upload_owner_review_cleanup_order",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-08-10",
      status: "uploaded"
    };
    const segment: TranscriptSegment = {
      id: "segment_owner_review_cleanup_order",
      uploadId: upload.id,
      startSeconds: 0,
      endSeconds: 8,
      speaker: "Alice",
      identity: {
        globalSpeakerId: "unknown_alice",
        identityType: "unknown_person",
        confidence: null,
        source: "provider_speaker_result",
        evidence: {
          type: "provider_label",
          provider: "company_voiceprint",
          providerLabel: "Alice"
        }
      },
      text: "我不喜欢香菜。",
      confidence: 0.9,
      sceneLabels: [],
      valueLabels: []
    };
    const memoryOwnerReviewCandidateCleaner = vi.fn(async () => {
      executionOrder.push("cleanup");
      return 1;
    });
    const memoryOwnerReviewCandidateGenerator = vi.fn(async () => {
      executionOrder.push("generate");
      return [];
    });

    try {
      process.env.EXTRACTION_PROVIDER = "rule";
      process.env.AUDIO_INSIGHT_PROVIDER = "rule";
      process.env.MEMORY_OWNER_REVIEW_ENABLED = "true";
      await store.write("uploads", upload.id, { ...upload, filePath });

      const result = await processUpload({
        uploadId: upload.id,
        store,
        userId: "user_1",
        memoryRepository,
        dependencies: {
          transcriptionProcessor: async () => [segment],
          memoryOwnerReviewCandidateCleaner,
          memoryOwnerReviewCandidateGenerator
        }
      });

      expect(result.job.status).toBe("ready");
      expect(memoryOwnerReviewCandidateCleaner).toHaveBeenCalledOnce();
      expect(memoryOwnerReviewCandidateGenerator).toHaveBeenCalledOnce();
      expect(executionOrder).toEqual(["cleanup", "generate"]);
      expect(memoryRepository.replaceUploadMemories).toHaveBeenCalledWith(
        expect.objectContaining({ memories: [] })
      );
    } finally {
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
      restoreProviderEnv("AUDIO_INSIGHT_PROVIDER", originalAudioInsightProvider);
      restoreProviderEnv("MEMORY_OWNER_REVIEW_ENABLED", originalMemoryOwnerReviewEnabled);
    }
  });

  it("skips Owner Review generation and logs a safe warning when rerun cleanup fails", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "brief-pipeline-owner-review-cleanup-failure-"));
    const store = new JsonStore(tempDir);
    const filePath = join(tempDir, "demo.m4a");
    await writeFile(filePath, "fake audio");
    const originalExtractionProvider = process.env.EXTRACTION_PROVIDER;
    const originalAudioInsightProvider = process.env.AUDIO_INSIGHT_PROVIDER;
    const originalMemoryOwnerReviewEnabled = process.env.MEMORY_OWNER_REVIEW_ENABLED;
    const memoryRepository = {
      replaceUploadMemories: vi.fn(() => ({
        inputCount: 0,
        memoryCount: 0,
        mergedCount: 0,
        relationCount: 0
      })),
      getRelevantMemories: vi.fn(() => [])
    };
    const upload: AudioUpload = {
      id: "upload_owner_review_cleanup_failure",
      originalName: "demo.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-08-10",
      status: "uploaded"
    };
    const segment: TranscriptSegment = {
      id: "segment_owner_review_cleanup_failure",
      uploadId: upload.id,
      startSeconds: 0,
      endSeconds: 8,
      speaker: "Alice",
      identity: {
        globalSpeakerId: "unknown_alice",
        identityType: "unknown_person",
        confidence: null,
        source: "provider_speaker_result",
        evidence: {
          type: "provider_label",
          provider: "company_voiceprint",
          providerLabel: "Alice"
        }
      },
      text: "我不喜欢香菜。",
      confidence: 0.9,
      sceneLabels: [],
      valueLabels: []
    };
    const memoryOwnerReviewCandidateCleaner = vi.fn(async () => {
      throw new Error("owner review cleanup unavailable");
    });
    const memoryOwnerReviewCandidateGenerator = vi.fn(async () => []);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      process.env.EXTRACTION_PROVIDER = "rule";
      process.env.AUDIO_INSIGHT_PROVIDER = "rule";
      process.env.MEMORY_OWNER_REVIEW_ENABLED = "true";
      await store.write("uploads", upload.id, { ...upload, filePath });

      const result = await processUpload({
        uploadId: upload.id,
        store,
        userId: "user_1",
        memoryRepository,
        dependencies: {
          transcriptionProcessor: async () => [segment],
          memoryOwnerReviewCandidateCleaner,
          memoryOwnerReviewCandidateGenerator
        }
      });

      expect(result.job.status).toBe("ready");
      expect(memoryOwnerReviewCandidateCleaner).toHaveBeenCalledOnce();
      expect(memoryOwnerReviewCandidateGenerator).not.toHaveBeenCalled();
      expect(memoryRepository.replaceUploadMemories).toHaveBeenCalledWith(
        expect.objectContaining({ memories: [] })
      );
      expect(warnSpy).toHaveBeenCalledWith(
        `[memory-owner-review] cleanup_failure upload_id=${upload.id} error_name=Error`
      );
    } finally {
      restoreProviderEnv("EXTRACTION_PROVIDER", originalExtractionProvider);
      restoreProviderEnv("AUDIO_INSIGHT_PROVIDER", originalAudioInsightProvider);
      restoreProviderEnv("MEMORY_OWNER_REVIEW_ENABLED", originalMemoryOwnerReviewEnabled);
      warnSpy.mockRestore();
    }
  });
});
