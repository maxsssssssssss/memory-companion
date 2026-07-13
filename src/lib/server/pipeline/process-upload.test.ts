import { access, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioInsight, AudioUpload, ProcessingJob, TranscriptSegment } from "@/lib/domain/types";
import { extractBriefItems } from "@/lib/processing/extract-rule-based";
import { deepseekAudioInsightProvider } from "@/lib/server/audio-insights/deepseek-provider";
import { openaiAudioInsightProvider } from "@/lib/server/audio-insights/openai-provider";
import * as extractionProviderModule from "@/lib/server/extraction/provider";
import { JsonStore } from "@/lib/server/storage/json-store";
import { UploadProcessingCancelledError, processUpload } from "./process-upload";

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

type StoredUpload = AudioUpload & {
  errorCode?: string;
  errorMessage?: string;
};

type DeleteTrigger = (collection: string, id: string, value: unknown) => boolean;

function isProcessingJob(value: unknown): value is ProcessingJob {
  return value !== null && typeof value === "object" && "status" in value && "uploadId" in value;
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

class FailingProactiveInsightCacheStore extends JsonStore {
  override async write<T>(collection: string, id: string, value: T): Promise<void> {
    if (collection === "proactive-insights") {
      throw new Error("proactive insight cache unavailable");
    }
    await super.write(collection, id, value);
  }
}

function restoreProviderEnv(
  key: "TRANSCRIPTION_PROVIDER" | "EXTRACTION_PROVIDER" | "AUDIO_INSIGHT_PROVIDER" | "AUDIO_INSIGHT_FALLBACK_PROVIDER",
  value: string | undefined
) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

beforeEach(() => {
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

      expect(result.job.status).toBe("ready");
      expect(logs).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^\[audio-insights\] start segments=\d+$/),
          expect.stringMatching(/^\[audio-insights\] completed count=\d+ elapsed_ms=\d+$/),
          expect.stringMatching(/^\[ffmpeg-features\] start segments=\d+$/),
          expect.stringMatching(/^\[ffmpeg-features\] completed count=\d+ elapsed_ms=\d+$/),
          expect.stringMatching(/^\[semantic-segments\] start segments=\d+$/),
          expect.stringMatching(/^\[semantic-segments\] completed count=\d+ elapsed_ms=\d+$/),
          expect.stringMatching(/^\[extraction\] start segments=\d+ semantic_segments=\d+$/),
          expect.stringMatching(/^\[extraction\] completed count=\d+ elapsed_ms=\d+$/),
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
          reason: "timeout"
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
      expect(relationshipSignalAnalyzeMock).toHaveBeenCalledTimes(1);
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

      expect(openaiAudioInsightProvider.analyze).toHaveBeenCalledTimes(1);
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
      expect(deepseekAudioInsightProvider.analyze).toHaveBeenCalledTimes(1);
      expect(result.audioInsights.length).toBeGreaterThan(0);
      expect(result.briefItems.length).toBeGreaterThan(0);
      expect(relationshipSignalAnalyzeMock).toHaveBeenCalledTimes(1);
      expect(memoryRepository.replaceUploadMemories).toHaveBeenCalledTimes(1);
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

      expect(relationshipSignalAnalyzeMock).toHaveBeenCalledOnce();
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
    } finally {
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

  it("deletes the uploaded audio file after processing fails", async () => {
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
      await expect(access(filePath)).rejects.toThrow();
      const storedUpload = await store.read<StoredUpload>("uploads", upload.id);
      expect(storedUpload?.status).toBe("failed");
      expect("filePath" in (storedUpload ?? {})).toBe(false);
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
});
