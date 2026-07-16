import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioInsightSchema, type AudioInsight, type TranscriptSegment } from "@/lib/domain/types";
import { resolveAnalysisTranscriptChunks } from "@/lib/server/analysis-chunks/transcript-chunks";
import { JsonAnalysisChunkCheckpointStore } from "@/lib/server/analysis-chunks/checkpoint";
import { JsonStore } from "@/lib/server/storage/json-store";
import type { AudioInsightProvider } from "./provider";
import { DeepseekAudioInsightError } from "./deepseek-provider";
import { processAudioInsightChunks } from "./chunk-processing";

const timestamp = "2026-07-15T08:00:00.000Z";
let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function segment(index: number): TranscriptSegment {
  return {
    id: `seg_${index}`,
    uploadId: "upload_1",
    startSeconds: index * 310,
    endSeconds: index * 310 + 20,
    speaker: `speaker_${index}`,
    text: `第 ${index} 段对话。`,
    confidence: 0.9,
    sceneLabels: [],
    valueLabels: []
  };
}

function insight(source: TranscriptSegment, confidence = 0.8): AudioInsight {
  return AudioInsightSchema.parse({
    id: "provider_reused_id",
    uploadId: source.uploadId,
    sourceSegmentIds: [source.id],
    sourceTimeRange: { startSeconds: source.startSeconds, endSeconds: source.endSeconds },
    speaker: { id: source.speaker ?? "speaker_unknown", role: "unknown", confidence: 0.7 },
    voice: { pace: "normal", volume: "unknown", pause: "unknown", overlap: false, confidence: 0.5 },
    toneLabels: ["explaining"],
    emotionLabels: ["neutral"],
    interactionLabels: ["unknown"],
    summary: `关于 ${source.id} 的线索`,
    evidence: source.text,
    confidence
  });
}

describe("chunked audio insight processing", () => {
  it("reuses validated chunk checkpoints and reruns the deterministic merge", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "audio-insight-checkpoint-"));
    const segments = [segment(0), segment(1)];
    const chunks = resolveAnalysisTranscriptChunks({
      uploadId: "upload_1",
      segments,
      maxDurationSeconds: 300,
      now: () => timestamp
    });
    const analyze = vi.fn(async (_uploadId: string, chunkSegments: TranscriptSegment[]) => [insight(chunkSegments[0])]);
    const checkpoint = {
      store: new JsonAnalysisChunkCheckpointStore(new JsonStore(tempDir)),
      userId: "user_1",
      processorFingerprint: "audio-v1"
    };

    const first = await processAudioInsightChunks({
      uploadId: "upload_1",
      transcriptChunks: chunks,
      segments,
      provider: { analyze },
      fallbackProvider: { analyze },
      options: { maxRetries: 0, attemptTimeoutMs: 1_000, now: () => timestamp, analysisCheckpoint: checkpoint }
    });
    const second = await processAudioInsightChunks({
      uploadId: "upload_1",
      transcriptChunks: chunks,
      segments,
      provider: { analyze },
      fallbackProvider: { analyze },
      options: { maxRetries: 0, attemptTimeoutMs: 1_000, now: () => timestamp, analysisCheckpoint: checkpoint }
    });

    expect(analyze).toHaveBeenCalledTimes(2);
    expect(second.stats.checkpointHits).toBe(2);
    expect(second.insights).toEqual(first.insights);
    expect(second.stats.mergeDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("invalidates only the audio chunk whose transcript content changed", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "audio-insight-invalidation-"));
    const original = [segment(0), segment(1)];
    const analyze = vi.fn(async (_uploadId: string, chunkSegments: TranscriptSegment[]) => [insight(chunkSegments[0])]);
    const checkpoint = {
      store: new JsonAnalysisChunkCheckpointStore(new JsonStore(tempDir)),
      userId: "user_1",
      processorFingerprint: "audio-v1"
    };
    const run = async (segments: TranscriptSegment[]) => processAudioInsightChunks({
      uploadId: "upload_1",
      transcriptChunks: resolveAnalysisTranscriptChunks({
        uploadId: "upload_1",
        segments,
        maxDurationSeconds: 300,
        now: () => timestamp
      }),
      segments,
      provider: { analyze },
      fallbackProvider: { analyze },
      options: { maxRetries: 0, attemptTimeoutMs: 1_000, now: () => timestamp, analysisCheckpoint: checkpoint }
    });
    await run(original);
    const changed = [original[0], { ...original[1], text: `${original[1].text} changed` }];

    const second = await run(changed);

    expect(analyze).toHaveBeenCalledTimes(3);
    expect(second.stats.checkpointHits).toBe(1);
    expect(second.stats.checkpointStale).toBe(1);
  });

  it("uses bounded concurrency and merges chunk outputs into stable evidence-backed insights", async () => {
    const segments = [segment(0), segment(1), segment(2), segment(3)];
    const chunks = resolveAnalysisTranscriptChunks({
      uploadId: "upload_1",
      segments,
      maxDurationSeconds: 300,
      now: () => timestamp
    });
    let active = 0;
    let maxActive = 0;
    const provider: AudioInsightProvider = {
      async analyze(_uploadId, chunkSegments) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return [insight(chunkSegments[0])];
      }
    };

    const result = await processAudioInsightChunks({
      uploadId: "upload_1",
      transcriptChunks: chunks,
      segments,
      provider,
      fallbackProvider: provider,
      options: { concurrency: 2, maxRetries: 0, attemptTimeoutMs: 1_000, now: () => timestamp }
    });

    expect(maxActive).toBe(2);
    expect(result.insights).toHaveLength(4);
    expect(new Set(result.insights.map((item) => item.id)).size).toBe(4);
    expect(result.insights.map((item) => item.sourceSegmentIds[0])).toEqual(segments.map((item) => item.id));
    expect(result.analysisChunks.every((chunk) => chunk.kind === "audio_insight")).toBe(true);
    expect(result.stats.chunkCount).toBe(4);
  });

  it("retries and isolates a failed chunk with a chunk-local fallback", async () => {
    const segments = [segment(0), segment(1), segment(2)];
    const chunks = resolveAnalysisTranscriptChunks({
      uploadId: "upload_1",
      segments,
      maxDurationSeconds: 300,
      now: () => timestamp
    });
    const attempts = new Map<string, number>();
    const provider: AudioInsightProvider = {
      async analyze(_uploadId, chunkSegments) {
        const id = chunkSegments[0].id;
        attempts.set(id, (attempts.get(id) ?? 0) + 1);
        if (id === "seg_1") throw new Error("temporary failure");
        return [insight(chunkSegments[0])];
      }
    };
    const fallbackProvider: AudioInsightProvider = {
      analyze: vi.fn(async (_uploadId, chunkSegments) => [insight(chunkSegments[0], 0.55)])
    };

    const result = await processAudioInsightChunks({
      uploadId: "upload_1",
      transcriptChunks: chunks,
      segments,
      provider,
      fallbackProvider,
      options: { concurrency: 2, maxRetries: 1, retryDelayMs: 0, attemptTimeoutMs: 1_000, now: () => timestamp }
    });

    expect(attempts.get("seg_1")).toBe(2);
    expect(fallbackProvider.analyze).toHaveBeenCalledTimes(1);
    expect(result.insights).toHaveLength(3);
    expect(result.stats.fallbackChunks).toBe(1);
    expect(result.stats.failedChunks).toBe(0);
  });

  it("drops provider output that cannot resolve to a real chunk segment", async () => {
    const segments = [segment(0)];
    const chunks = resolveAnalysisTranscriptChunks({ uploadId: "upload_1", segments, now: () => timestamp });
    const invalid = insight(segments[0]);
    invalid.sourceSegmentIds = ["invented_segment"];
    const fallbackProvider: AudioInsightProvider = {
      async analyze(_uploadId, chunkSegments) {
        return [insight(chunkSegments[0], 0.5)];
      }
    };

    const result = await processAudioInsightChunks({
      uploadId: "upload_1",
      transcriptChunks: chunks,
      segments,
      provider: { async analyze() { return [invalid]; } },
      fallbackProvider,
      options: { maxRetries: 0, attemptTimeoutMs: 1_000, now: () => timestamp }
    });

    expect(result.insights).toHaveLength(1);
    expect(result.insights[0].sourceSegmentIds).toEqual([segments[0].id]);
    expect(result.stats.fallbackChunks).toBe(1);
  });

  it("deduplicates repeated insight output inside a chunk", async () => {
    const segments = [segment(0)];
    const chunks = resolveAnalysisTranscriptChunks({ uploadId: "upload_1", segments, now: () => timestamp });
    const duplicate = insight(segments[0], 0.6);

    const result = await processAudioInsightChunks({
      uploadId: "upload_1",
      transcriptChunks: chunks,
      segments,
      provider: { async analyze() { return [insight(segments[0], 0.8), duplicate]; } },
      fallbackProvider: { async analyze() { return []; } },
      options: { maxRetries: 0, attemptTimeoutMs: 1_000, now: () => timestamp }
    });

    expect(result.insights).toHaveLength(1);
    expect(result.insights[0].confidence).toBe(0.8);
    expect(result.stats.duplicateRemoved).toBe(1);
  });

  it("times out one chunk and immediately uses its local fallback", async () => {
    const segments = [segment(0)];
    const chunks = resolveAnalysisTranscriptChunks({ uploadId: "upload_1", segments, now: () => timestamp });
    const provider: AudioInsightProvider = {
      async analyze(_uploadId, _segments, options) {
        return await new Promise<AudioInsight[]>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
    };

    const result = await processAudioInsightChunks({
      uploadId: "upload_1",
      transcriptChunks: chunks,
      segments,
      provider,
      fallbackProvider: { async analyze() { return [insight(segments[0], 0.5)]; } },
      options: { maxRetries: 0, attemptTimeoutMs: 10, now: () => timestamp }
    });

    expect(result.insights).toHaveLength(1);
    expect(result.stats.fallbackChunks).toBe(1);
  });

  it("retries invalid JSON once before accepting a provider recovery", async () => {
    const segments = [segment(0)];
    const chunks = resolveAnalysisTranscriptChunks({ uploadId: "upload_1", segments, now: () => timestamp });
    let attempts = 0;
    const provider: AudioInsightProvider = {
      async analyze(_uploadId, chunkSegments) {
        attempts += 1;
        if (attempts === 1) throw new DeepseekAudioInsightError("invalid_json");
        return [insight(chunkSegments[0])];
      }
    };

    const result = await processAudioInsightChunks({
      uploadId: "upload_1",
      transcriptChunks: chunks,
      segments,
      provider,
      fallbackProvider: { async analyze() { throw new Error("fallback should not run"); } },
      options: { maxRetries: 1, retryDelayMs: 0, attemptTimeoutMs: 1_000, now: () => timestamp }
    });

    expect(attempts).toBe(2);
    expect(result.stats.retrySuccessChunks).toBe(1);
    expect(result.stats.fallbackChunks).toBe(0);
  });

  it("falls back after invalid JSON exhausts one retry", async () => {
    const segments = [segment(0)];
    const chunks = resolveAnalysisTranscriptChunks({ uploadId: "upload_1", segments, now: () => timestamp });
    const analyze = vi.fn(async () => { throw new DeepseekAudioInsightError("invalid_json"); });

    const result = await processAudioInsightChunks({
      uploadId: "upload_1",
      transcriptChunks: chunks,
      segments,
      provider: { analyze },
      fallbackProvider: { async analyze() { return [insight(segments[0], 0.5)]; } },
      options: { maxRetries: 1, retryDelayMs: 0, attemptTimeoutMs: 1_000, now: () => timestamp }
    });

    expect(analyze).toHaveBeenCalledTimes(2);
    expect(result.stats.invalidJsonChunks).toBe(1);
    expect(result.stats.fallbackChunks).toBe(1);
  });

  it("does not retry a provider evidence violation", async () => {
    const segments = [segment(0)];
    const chunks = resolveAnalysisTranscriptChunks({ uploadId: "upload_1", segments, now: () => timestamp });
    const analyze = vi.fn(async () => { throw new DeepseekAudioInsightError("invalid_evidence"); });

    const result = await processAudioInsightChunks({
      uploadId: "upload_1",
      transcriptChunks: chunks,
      segments,
      provider: { analyze },
      fallbackProvider: { async analyze() { return [insight(segments[0], 0.5)]; } },
      options: { maxRetries: 1, retryDelayMs: 0, attemptTimeoutMs: 1_000, now: () => timestamp }
    });

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(result.stats.fallbackChunks).toBe(1);
  });
});
