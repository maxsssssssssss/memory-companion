import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AudioInsightSchema, type AudioInsight, type TranscriptSegment } from "@/lib/domain/types";
import { resolveAnalysisTranscriptChunks } from "@/lib/server/analysis-chunks/transcript-chunks";
import { JsonAnalysisChunkCheckpointStore } from "@/lib/server/analysis-chunks/checkpoint";
import { JsonStore } from "@/lib/server/storage/json-store";
import {
  StructuredJsonResponseError,
  type StructuredJsonDiagnostics
} from "@/lib/server/openai/structured-json";
import type { RawRelationshipSignalItem } from "@/lib/processing/relationship-signals";
import type { RelationshipSignalProvider } from "./provider";
import { processRelationshipSignalChunks } from "./chunk-processing";

const timestamp = "2026-07-15T08:00:00.000Z";
let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function relationshipSegment(index: number): TranscriptSegment {
  return {
    id: `seg_${index}`,
    uploadId: "upload_1",
    startSeconds: index * 310,
    endSeconds: index * 310 + 20,
    speaker: `speaker_${index + 1}`,
    text: index === 0 ? "在这段关系里，我听到了你的担心，我们晚一点继续确认。" : "关于相处安排，我会认真听，也会在周五前给你明确答复。",
    confidence: 0.9,
    sceneLabels: [],
    valueLabels: index === 1 ? ["commitment"] : []
  };
}

function candidate(segment: TranscriptSegment): RawRelationshipSignalItem {
  return {
    signalType: "active_listening",
    signalCategory: "positive",
    severity: "low",
    confidence: 0.8,
    summary: "回应中复述并确认了对方的担心。",
    explanation: "这是当前具体片段里的倾听线索，不代表长期结论。",
    involvedSpeakers: [segment.speaker ?? "speaker_unknown"],
    evidenceSegmentIds: [segment.id],
    evidenceSegments: [],
    counterEvidence: [],
    acousticEvidence: [],
    textEvidence: [segment.text],
    interactionEvidence: [],
    suggestedReflection: "哪一句回应让你觉得被认真听见？"
  };
}

function audioInsight(segment: TranscriptSegment, summary: string) {
  return AudioInsightSchema.parse({
    id: `audio_${segment.id}`,
    uploadId: segment.uploadId,
    sourceSegmentIds: [segment.id],
    sourceTimeRange: { startSeconds: segment.startSeconds, endSeconds: segment.endSeconds },
    speaker: { id: segment.speaker ?? "speaker_unknown", role: "unknown", confidence: 0.7 },
    voice: { pace: "normal", volume: "unknown", pause: "unknown", overlap: false, confidence: 0.5 },
    toneLabels: ["comforting"],
    emotionLabels: ["neutral"],
    interactionLabels: ["rapport"],
    summary,
    evidence: segment.text,
    confidence: 0.8
  });
}

function emitRelationshipRequestMetrics(
  input: Parameters<NonNullable<RelationshipSignalProvider["extractCandidates"]>>[0],
  recoveryMode: "standard" | "compact",
  candidateLimit: 5 | 3
) {
  input.onRequestMetrics?.({
    responseMode: "json",
    model: "mock-relationship-model",
    promptCharacterCount: 1_200,
    unoptimizedContextCharacterCount: 1_100,
    optimizedContextCharacterCount: 900,
    transcriptCharacterCount: 700,
    semanticCharacterCount: 0,
    semanticSegmentCount: 0,
    insightCharacterCount: 200,
    systemPromptCharacterCount: 200,
    jsonInstructionCharacterCount: 100,
    maxOutputTokens: 2_800,
    recoveryMode,
    candidateLimit
  });
}

describe("chunked relationship signal processing", () => {
  it("reuses candidate checkpoints while rerunning the deterministic reducer", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "relationship-checkpoint-"));
    const segments = [relationshipSegment(0), relationshipSegment(1)];
    const chunks = resolveAnalysisTranscriptChunks({
      uploadId: "upload_1",
      segments,
      maxDurationSeconds: 300,
      now: () => timestamp
    });
    const extractCandidates = vi.fn(async (input: { segments: TranscriptSegment[] }) => [candidate(input.segments[0])]);
    const checkpoint = {
      store: new JsonAnalysisChunkCheckpointStore(new JsonStore(tempDir)),
      userId: "user_1",
      processorFingerprint: "relationship-v1"
    };
    const common = {
      uploadId: "upload_1",
      recordingDate: "2026-07-15",
      transcriptChunks: chunks,
      segments,
      semanticSegments: [],
      audioInsights: [] as AudioInsight[],
      provider: { async analyze() { return []; }, extractCandidates },
      options: { concurrency: 2, maxRetries: 0, attemptTimeoutMs: 1_000, now: () => timestamp, analysisCheckpoint: checkpoint }
    };

    const first = await processRelationshipSignalChunks(common);
    const second = await processRelationshipSignalChunks(common);

    expect(extractCandidates).toHaveBeenCalledTimes(2);
    expect(second.stats.checkpointHits).toBe(2);
    expect(second.cards).toEqual(first.cards);
    expect(second.stats.reducerDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("single-flights concurrent checkpointed stage executions", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "relationship-stage-flight-"));
    const segments = [relationshipSegment(0), relationshipSegment(1)];
    const chunks = resolveAnalysisTranscriptChunks({
      uploadId: "upload_1",
      segments,
      maxDurationSeconds: 300,
      now: () => timestamp
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const extractCandidates = vi.fn(async (input: { segments: TranscriptSegment[] }) => {
      await gate;
      return [candidate(input.segments[0])];
    });
    const common = {
      uploadId: "upload_1",
      recordingDate: "2026-07-15",
      transcriptChunks: chunks,
      segments,
      semanticSegments: [],
      audioInsights: [] as AudioInsight[],
      provider: { async analyze() { return []; }, extractCandidates },
      options: {
        concurrency: 2,
        maxRetries: 0,
        attemptTimeoutMs: 1_000,
        now: () => timestamp,
        analysisCheckpoint: {
          store: new JsonAnalysisChunkCheckpointStore(new JsonStore(tempDir)),
          userId: "user_1",
          processorFingerprint: "relationship-v1"
        }
      }
    };

    const first = processRelationshipSignalChunks(common);
    const second = processRelationshipSignalChunks(common);
    release();
    const [left, right] = await Promise.all([first, second]);

    expect(extractCandidates).toHaveBeenCalledTimes(2);
    expect(left.cards).toEqual(right.cards);
  });

  it("invalidates only the relationship chunk whose Audio Insight changed", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "relationship-audio-invalidation-"));
    const segments = [relationshipSegment(0), relationshipSegment(1)];
    const chunks = resolveAnalysisTranscriptChunks({
      uploadId: "upload_1",
      segments,
      maxDurationSeconds: 300,
      now: () => timestamp
    });
    const extractCandidates = vi.fn(async (input: { segments: TranscriptSegment[] }) => [candidate(input.segments[0])]);
    const checkpoint = {
      store: new JsonAnalysisChunkCheckpointStore(new JsonStore(tempDir)),
      userId: "user_1",
      processorFingerprint: "relationship-v1"
    };
    const run = (insights: AudioInsight[]) => processRelationshipSignalChunks({
      uploadId: "upload_1",
      recordingDate: "2026-07-15",
      transcriptChunks: chunks,
      segments,
      semanticSegments: [],
      audioInsights: insights,
      provider: { async analyze() { return []; }, extractCandidates },
      options: { concurrency: 2, maxRetries: 0, attemptTimeoutMs: 1_000, now: () => timestamp, analysisCheckpoint: checkpoint }
    });
    await run([audioInsight(segments[0], "first summary")]);

    const second = await run([audioInsight(segments[0], "changed summary")]);

    expect(extractCandidates).toHaveBeenCalledTimes(3);
    expect(second.stats.checkpointHits).toBe(1);
    expect(second.stats.checkpointMisses).toBe(1);
  });

  it("extracts chunk candidates and deterministically reduces matching multi-chunk evidence", async () => {
    const segments = [relationshipSegment(0), relationshipSegment(1)];
    const chunks = resolveAnalysisTranscriptChunks({
      uploadId: "upload_1",
      segments,
      maxDurationSeconds: 300,
      now: () => timestamp
    });
    const provider: RelationshipSignalProvider = {
      async analyze() { return []; },
      async extractCandidates(input) { return [candidate(input.segments[0])]; }
    };

    const result = await processRelationshipSignalChunks({
      uploadId: "upload_1",
      recordingDate: "2026-07-15",
      transcriptChunks: chunks,
      segments,
      semanticSegments: [],
      audioInsights: [] as AudioInsight[],
      provider,
      options: { concurrency: 2, maxRetries: 0, attemptTimeoutMs: 1_000, now: () => timestamp }
    });

    expect(result.stats.candidateCount).toBe(2);
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].evidenceSegments.map((item) => item.segmentId)).toEqual(["seg_0", "seg_1"]);
    expect(result.cards[0].evidenceSegments.map((item) => item.text)).toEqual(segments.map((item) => item.text));
    expect(result.analysisChunks).toHaveLength(2);
  });

  it("rejects fabricated evidence ids before the daily reducer", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "relationship-validation-audit-"));
    const segments = [relationshipSegment(0)];
    const chunks = resolveAnalysisTranscriptChunks({ uploadId: "upload_1", segments, now: () => timestamp });
    const badCandidate = { ...candidate(segments[0]), evidenceSegmentIds: ["invented_segment"] };
    const extractCandidates = vi.fn(async () => [badCandidate]);
    const common = {
      uploadId: "upload_1",
      recordingDate: "2026-07-15",
      transcriptChunks: chunks,
      segments,
      semanticSegments: [],
      audioInsights: [],
      provider: {
        async analyze() { return []; },
        extractCandidates
      },
      options: {
        maxRetries: 0,
        attemptTimeoutMs: 1_000,
        now: () => timestamp,
        analysisCheckpoint: {
          store: new JsonAnalysisChunkCheckpointStore(new JsonStore(tempDir)),
          userId: "user_1",
          processorFingerprint: "relationship-validation-audit-v1"
        }
      }
    };

    const first = await processRelationshipSignalChunks(common);
    const result = await processRelationshipSignalChunks(common);

    expect(result.stats.rejectedCandidates).toBe(1);
    expect(result.stats.checkpointHits).toBe(1);
    expect(extractCandidates).toHaveBeenCalledTimes(1);
    expect(result.cards).toEqual([]);
    expect(result.reducerAudit).toEqual(first.reducerAudit);
    expect(result.reducerAudit).toMatchObject({
      rawCandidateCount: 1,
      validationRejectedCount: 1,
      rejectedCount: 1
    });
    expect(result.reducerAudit.candidates).toEqual([
      expect.objectContaining({
        candidateId: "upload_1_relationship_candidate_00000_001",
        selected: false,
        rejectionReason: "evidence_missing_or_invalid",
        clusterId: null,
        score: expect.objectContaining({ finalScore: 0 })
      })
    ]);
  });

  it("returns no cards for non-relationship chunks without calling the provider", async () => {
    const segments: TranscriptSegment[] = [{
      ...relationshipSegment(0),
      text: "我们需要检查 API 返回结构和数据库迁移脚本。",
      sceneLabels: ["product_discussion"]
    }];
    const chunks = resolveAnalysisTranscriptChunks({ uploadId: "upload_1", segments, now: () => timestamp });
    const extractCandidates = vi.fn(async () => [candidate(segments[0])]);

    const result = await processRelationshipSignalChunks({
      uploadId: "upload_1",
      recordingDate: "2026-07-15",
      transcriptChunks: chunks,
      segments,
      semanticSegments: [],
      audioInsights: [],
      provider: { async analyze() { return []; }, extractCandidates },
      options: { maxRetries: 0, attemptTimeoutMs: 1_000, now: () => timestamp }
    });

    expect(extractCandidates).not.toHaveBeenCalled();
    expect(result.cards).toEqual([]);
  });

  it("isolates one failed candidate chunk while preserving successful chunks", async () => {
    const segments = [relationshipSegment(0), relationshipSegment(1)];
    const chunks = resolveAnalysisTranscriptChunks({
      uploadId: "upload_1",
      segments,
      maxDurationSeconds: 300,
      now: () => timestamp
    });
    const provider: RelationshipSignalProvider = {
      async analyze() { return []; },
      async extractCandidates(input) {
        if (input.segments[0].id === "seg_0") throw new Error("temporary model failure");
        return [candidate(input.segments[0])];
      }
    };

    const result = await processRelationshipSignalChunks({
      uploadId: "upload_1",
      recordingDate: "2026-07-15",
      transcriptChunks: chunks,
      segments,
      semanticSegments: [],
      audioInsights: [],
      provider,
      options: { concurrency: 2, maxRetries: 0, attemptTimeoutMs: 1_000, now: () => timestamp }
    });

    expect(result.stats.fallbackChunks).toBe(1);
    expect(result.stats.failedChunks).toBe(0);
    expect(result.cards.some((card) => card.evidenceSegments.some((evidence) => evidence.segmentId === "seg_1"))).toBe(true);
  });

  it("preserves rule-fallback provenance when a candidate checkpoint is reused", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "relationship-fallback-checkpoint-"));
    const segments = [relationshipSegment(0)];
    const chunks = resolveAnalysisTranscriptChunks({ uploadId: "upload_1", segments, now: () => timestamp });
    const extractCandidates = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const common = {
      uploadId: "upload_1",
      recordingDate: "2026-07-15",
      transcriptChunks: chunks,
      segments,
      semanticSegments: [],
      audioInsights: [] as AudioInsight[],
      provider: { async analyze() { return []; }, extractCandidates },
      options: {
        maxRetries: 0,
        attemptTimeoutMs: 1_000,
        now: () => timestamp,
        analysisCheckpoint: {
          store: new JsonAnalysisChunkCheckpointStore(new JsonStore(tempDir)),
          userId: "user_1",
          processorFingerprint: "relationship-fallback-checkpoint-v1"
        }
      }
    };

    const first = await processRelationshipSignalChunks(common);
    const second = await processRelationshipSignalChunks(common);

    expect(first.stats.fallbackChunks).toBe(1);
    expect(second.stats).toMatchObject({ checkpointHits: 1, fallbackChunks: 1, successChunks: 0 });
    expect(extractCandidates).toHaveBeenCalledTimes(1);
  });

  it("uses compact recovery after an incomplete max-output response and keeps at most three candidates", async () => {
    const segments = [relationshipSegment(0)];
    const chunks = resolveAnalysisTranscriptChunks({ uploadId: "upload_1", segments, now: () => timestamp });
    const recoveryModes: string[] = [];
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const provider: RelationshipSignalProvider = {
      async analyze() { return []; },
      async extractCandidates(input) {
        const recoveryMode = input.recoveryMode ?? "standard";
        recoveryModes.push(recoveryMode);
        emitRelationshipRequestMetrics(input, recoveryMode, recoveryMode === "compact" ? 3 : 5);
        if (recoveryMode === "standard") {
          input.onDiagnostics?.({
            responseStatus: "incomplete",
            incompleteReason: "max_output_tokens",
            responseTextLength: 1_900,
            parseResult: "not_started",
            validationResult: "not_started"
          });
          throw new StructuredJsonResponseError(
            "incomplete_response",
            "Structured response was incomplete: max_output_tokens"
          );
        }
        const candidates = Array.from({ length: 3 }, (_, index) => ({
          ...candidate(input.segments[0]),
          confidence: 0.9 - index * 0.05,
          summary: `compact-recovery-candidate-${index + 1}`
        }));
        input.onCandidateAudit?.({
          contract: "compact",
          recoveryMode,
          candidateLimit: 3,
          rawCandidateCount: 4,
          compactCandidateCount: 3,
          overLimitCount: 1
        });
        return candidates;
      }
    };

    try {
      const result = await processRelationshipSignalChunks({
        uploadId: "upload_1",
        recordingDate: "2026-07-15",
        transcriptChunks: chunks,
        segments,
        semanticSegments: [],
        audioInsights: [],
        provider,
        options: {
          concurrency: 1,
          recoveryConcurrency: 1,
          maxRetries: 1,
          retryDelayMs: 0,
          attemptTimeoutMs: 1_000,
          totalBudgetMs: 3_000,
          now: () => timestamp
        }
      });

      expect(recoveryModes).toEqual(["standard", "compact"]);
      expect(result.stats.retrySuccessChunks).toBe(1);
      expect(result.stats.fallbackChunks).toBe(0);
      expect(result.stats.candidateCount).toBe(3);
      const logs = consoleInfo.mock.calls.map(([message]) => String(message)).join("\n");
      expect(logs).toContain("failure_reason=incomplete_response");
      expect(logs).toContain("recovery_mode=compact");
      expect(logs).toContain("compact_candidate_count=3");
      expect(logs).toContain("output_tokens_budget=2800");
    } finally {
      consoleInfo.mockRestore();
    }
  });

  it("does not use compact recovery for non-token incomplete responses", async () => {
    const segments = [relationshipSegment(0)];
    const chunks = resolveAnalysisTranscriptChunks({ uploadId: "upload_1", segments, now: () => timestamp });
    const recoveryModes: string[] = [];
    const provider: RelationshipSignalProvider = {
      async analyze() { return []; },
      async extractCandidates(input) {
        const mode = input.recoveryMode ?? "standard";
        recoveryModes.push(mode);
        emitRelationshipRequestMetrics(input, mode, 5);
        if (recoveryModes.length === 1) {
          input.onDiagnostics?.({
            responseStatus: "incomplete",
            incompleteReason: "content_filter",
            responseTextLength: 0,
            parseResult: "not_started",
            validationResult: "not_started"
          });
          throw new StructuredJsonResponseError(
            "incomplete_response",
            "Structured response was incomplete: content_filter"
          );
        }
        return [candidate(input.segments[0])];
      }
    };

    const result = await processRelationshipSignalChunks({
      uploadId: "upload_1",
      recordingDate: "2026-07-15",
      transcriptChunks: chunks,
      segments,
      semanticSegments: [],
      audioInsights: [],
      provider,
      options: {
        concurrency: 1,
        recoveryConcurrency: 1,
        maxRetries: 1,
        retryDelayMs: 0,
        attemptTimeoutMs: 1_000,
        totalBudgetMs: 3_000,
        now: () => timestamp
      }
    });

    expect(recoveryModes).toEqual(["standard", "standard"]);
    expect(result.stats.retrySuccessChunks).toBe(1);
  });

  it("keeps timeout recovery in standard mode", async () => {
    const segments = [relationshipSegment(0)];
    const chunks = resolveAnalysisTranscriptChunks({ uploadId: "upload_1", segments, now: () => timestamp });
    const recoveryModes: string[] = [];
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const provider: RelationshipSignalProvider = {
      async analyze() { return []; },
      async extractCandidates(input) {
        const recoveryMode = input.recoveryMode ?? "standard";
        recoveryModes.push(recoveryMode);
        emitRelationshipRequestMetrics(input, recoveryMode, 5);
        if (recoveryModes.length === 1) {
          return await new Promise<RawRelationshipSignalItem[]>((_resolve, reject) => {
            input.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        return [candidate(input.segments[0])];
      }
    };

    try {
      const result = await processRelationshipSignalChunks({
        uploadId: "upload_1",
        recordingDate: "2026-07-15",
        transcriptChunks: chunks,
        segments,
        semanticSegments: [],
        audioInsights: [],
        provider,
        options: {
          concurrency: 1,
          recoveryConcurrency: 1,
          maxRetries: 1,
          retryDelayMs: 0,
          attemptTimeoutMs: 10,
          totalBudgetMs: 1_000,
          now: () => timestamp
        }
      });

      expect(recoveryModes).toEqual(["standard", "standard"]);
      expect(result.stats.timeoutChunks).toBe(1);
      expect(result.stats.retrySuccessChunks).toBe(1);
      const logs = consoleInfo.mock.calls.map(([message]) => String(message)).join("\n");
      expect(logs).toContain("failure_reason=timeout");
      expect(logs).toContain("recovery_mode=standard");
      expect(logs).not.toContain("recovery_mode=compact");
    } finally {
      consoleInfo.mockRestore();
    }
  });

  it("moves retryable timeouts to a single-concurrency recovery queue", async () => {
    const segments = [relationshipSegment(0), relationshipSegment(1)];
    const chunks = resolveAnalysisTranscriptChunks({
      uploadId: "upload_1",
      segments,
      maxDurationSeconds: 300,
      now: () => timestamp
    });
    const attempts = new Map<string, number>();
    let activeRecovery = 0;
    let maxActiveRecovery = 0;
    const provider: RelationshipSignalProvider = {
      async analyze() { return []; },
      async extractCandidates(input) {
        const id = input.segments[0].id;
        const attempt = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, attempt);
        if (attempt === 1) {
          return await new Promise<RawRelationshipSignalItem[]>((_resolve, reject) => {
            input.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        activeRecovery += 1;
        maxActiveRecovery = Math.max(maxActiveRecovery, activeRecovery);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeRecovery -= 1;
        return [candidate(input.segments[0])];
      }
    };

    const result = await processRelationshipSignalChunks({
      uploadId: "upload_1",
      recordingDate: "2026-07-15",
      transcriptChunks: chunks,
      segments,
      semanticSegments: [],
      audioInsights: [],
      provider,
      options: {
        concurrency: 2,
        recoveryConcurrency: 1,
        maxRetries: 1,
        retryDelayMs: 0,
        attemptTimeoutMs: 10,
        totalBudgetMs: 1_000,
        now: () => timestamp
      }
    });

    expect(maxActiveRecovery).toBe(1);
    expect([...attempts.values()]).toEqual([2, 2]);
    expect(result.stats.retrySuccessChunks).toBe(2);
    expect(result.stats.fallbackChunks).toBe(0);
  });

  it("falls back after one recovery timeout without cancelling another successful chunk", async () => {
    const segments = [relationshipSegment(0), relationshipSegment(1)];
    const chunks = resolveAnalysisTranscriptChunks({
      uploadId: "upload_1",
      segments,
      maxDurationSeconds: 300,
      now: () => timestamp
    });
    const attempts = new Map<string, number>();
    const provider: RelationshipSignalProvider = {
      async analyze() { return []; },
      async extractCandidates(input) {
        const id = input.segments[0].id;
        attempts.set(id, (attempts.get(id) ?? 0) + 1);
        if (id === "seg_1") return [candidate(input.segments[0])];
        return await new Promise<RawRelationshipSignalItem[]>((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
    };

    const result = await processRelationshipSignalChunks({
      uploadId: "upload_1",
      recordingDate: "2026-07-15",
      transcriptChunks: chunks,
      segments,
      semanticSegments: [],
      audioInsights: [],
      provider,
      options: {
        concurrency: 2,
        recoveryConcurrency: 1,
        maxRetries: 1,
        retryDelayMs: 0,
        attemptTimeoutMs: 10,
        totalBudgetMs: 1_000,
        now: () => timestamp
      }
    });

    expect(attempts.get("seg_0")).toBe(2);
    expect(attempts.get("seg_1")).toBe(1);
    expect(result.stats.fallbackChunks).toBe(1);
    expect(result.stats.retrySuccessChunks).toBe(0);
    expect(result.cards.some((card) => card.evidenceSegments.some((item) => item.segmentId === "seg_1"))).toBe(true);
  });

  it("retries parse failures but classifies validation failures without retrying them", async () => {
    const segments = [relationshipSegment(0), relationshipSegment(1)];
    const chunks = resolveAnalysisTranscriptChunks({
      uploadId: "upload_1",
      segments,
      maxDurationSeconds: 300,
      now: () => timestamp
    });
    const attempts = new Map<string, number>();
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const provider: RelationshipSignalProvider = {
      async analyze() { return []; },
      async extractCandidates(input) {
        const id = input.segments[0].id;
        const attempt = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, attempt);
        if (id === "seg_0" && attempt === 1) {
          throw new StructuredJsonResponseError("invalid_json", "invalid JSON");
        }
        if (id === "seg_1") {
          throw new z.ZodError([{ code: "custom", path: ["items"], message: "invalid candidate" }]);
        }
        return [candidate(input.segments[0])];
      }
    };

    try {
      const result = await processRelationshipSignalChunks({
        uploadId: "upload_1",
        recordingDate: "2026-07-15",
        transcriptChunks: chunks,
        segments,
        semanticSegments: [],
        audioInsights: [],
        provider,
        options: {
          concurrency: 2,
          recoveryConcurrency: 1,
          maxRetries: 1,
          retryDelayMs: 0,
          attemptTimeoutMs: 1_000,
          totalBudgetMs: 3_000,
          now: () => timestamp
        }
      });

      expect(attempts.get("seg_0")).toBe(2);
      expect(attempts.get("seg_1")).toBe(1);
      expect(result.stats).toMatchObject({
        parseFailureChunks: 1,
        validationFailureChunks: 1,
        retrySuccessChunks: 1,
        fallbackChunks: 1
      });
      const logs = consoleInfo.mock.calls.map(([message]) => String(message)).join("\n");
      expect(logs).toContain("failure_phase=parse");
      expect(logs).toContain("failure_reason=invalid_json will_retry=true retry_reason=invalid_json");
      expect(logs).toContain("failure_phase=validation");
      expect(logs).toContain("failure_reason=validation_failure will_retry=false retry_reason=none");
    } finally {
      consoleInfo.mockRestore();
    }
  });

  it("logs bounded validation issues and checkpoints only their code summary", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "relationship-validation-diagnostics-"));
    const segments = [relationshipSegment(0)];
    const chunks = resolveAnalysisTranscriptChunks({
      uploadId: "upload_1",
      segments,
      maxDurationSeconds: 300,
      now: () => timestamp
    });
    const checkpointStore = new JsonAnalysisChunkCheckpointStore(new JsonStore(tempDir));
    const sensitiveTranscript = segments[0].text;
    const sensitiveQuote = "PRIVATE_QUOTE_SHOULD_NOT_APPEAR";
    const sensitiveToken = "PRIVATE_TOKEN_SHOULD_NOT_APPEAR";
    const validationIssues = Array.from({ length: 10 }, (_, index) => ({
      path: `items[${index}].signalType`,
      code: "invalid_enum_value",
      message: index === 0 ? sensitiveQuote : "Invalid enum value"
    }));
    const provider: RelationshipSignalProvider = {
      async analyze() { return []; },
      async extractCandidates(input) {
        const diagnostics: StructuredJsonDiagnostics = {
          responseTextLength: 500,
          parseResult: "success",
          validationResult: "failed",
          validationIssueCount: 12,
          validationIssues,
          validationIssueSummary: [{ code: "invalid_enum_value", count: 12 }],
          validationIssuesTruncated: true
        };
        input.onDiagnostics?.(diagnostics);
        throw new z.ZodError([
          {
            code: "custom",
            path: ["items", 0, "signalType"],
            message: `${sensitiveTranscript} ${sensitiveQuote} ${sensitiveToken}`
          }
        ]);
      }
    };
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      const result = await processRelationshipSignalChunks({
        uploadId: "upload_1",
        recordingDate: "2026-07-15",
        transcriptChunks: chunks,
        segments,
        semanticSegments: [],
        audioInsights: [],
        provider,
        options: {
          concurrency: 1,
          recoveryConcurrency: 1,
          maxRetries: 0,
          retryDelayMs: 0,
          attemptTimeoutMs: 1_000,
          totalBudgetMs: 3_000,
          now: () => timestamp,
          analysisCheckpoint: {
            store: checkpointStore,
            userId: "user_1",
            processorFingerprint: "relationship-validation-diagnostics-v1"
          }
        }
      });

      expect(result.stats.validationFailureChunks).toBe(1);
      const logs = consoleInfo.mock.calls.map(([message]) => String(message)).join("\n");
      expect(logs).toContain("[relationship-provider] validation_failed");
      expect(logs).toContain("validation_issue_count=12");
      expect(logs).toContain("validation_issue_codes=invalid_enum_value");
      expect(logs).toContain("validation_issue_paths=items[0].signalType");
      expect(logs).toContain("items[9].signalType");
      expect(logs).not.toContain("items[10].signalType");
      expect(logs).toContain("truncated=true");
      expect(logs).not.toContain(sensitiveTranscript);
      expect(logs).not.toContain(sensitiveQuote);
      expect(logs).not.toContain(sensitiveToken);

      const checkpoints = await checkpointStore.list({
        userId: "user_1",
        uploadId: "upload_1",
        kind: "relationship_candidate"
      });
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].metadata.validationIssueSummary).toEqual([
        { code: "invalid_enum_value", count: 12 }
      ]);
      const responseDiagnostics = checkpoints[0].metadata.responseDiagnostics as Record<string, unknown>;
      expect(responseDiagnostics).toMatchObject({
        parseResult: "success",
        validationResult: "failed",
        validationIssueCount: 12,
        validationIssuesTruncated: true
      });
      expect(responseDiagnostics.validationIssues).toBeUndefined();
      expect(responseDiagnostics.validationIssueSummary).toBeUndefined();
      expect(JSON.stringify(checkpoints[0].metadata)).not.toContain(sensitiveTranscript);
      expect(JSON.stringify(checkpoints[0].metadata)).not.toContain(sensitiveQuote);
      expect(JSON.stringify(checkpoints[0].metadata)).not.toContain(sensitiveToken);
    } finally {
      consoleInfo.mockRestore();
    }
  });
});
