import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BriefItem, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";
import { JsonAnalysisChunkCheckpointStore, fingerprintAnalysisInput } from "@/lib/server/analysis-chunks/checkpoint";
import { JsonStore } from "@/lib/server/storage/json-store";
import type { ExtractionChunk } from "./chunks";
import {
  processDailyBriefChunks,
  resolveDailyBriefChunkConcurrency,
  type DailyBriefChunkExecution
} from "./chunk-processing";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function longInput() {
  const segments = Array.from({ length: 66 }, (_, index): TranscriptSegment => ({
    id: `seg_${String(index).padStart(3, "0")}`,
    uploadId: "upload_brief",
    startSeconds: index * 20,
    endSeconds: index * 20 + 10,
    speaker: index % 2 === 0 ? "speaker_1" : "speaker_2",
    text: `segment ${index} contains a concrete action and enough detail for chunk planning`,
    confidence: 0.9,
    sceneLabels: ["product_discussion"],
    valueLabels: index % 11 === 0 ? ["task"] : []
  }));
  const semanticSegments = Array.from({ length: 6 }, (_, index): SemanticSegment => {
    const source = segments.slice(index * 11, index * 11 + 11);
    return {
      id: `semantic_${index}`,
      uploadId: "upload_brief",
      title: `Topic ${index}`,
      summary: `Summary ${index}`,
      startSeconds: source[0].startSeconds,
      endSeconds: source.at(-1)!.endSeconds,
      tags: ["topic"],
      sceneLabels: ["product_discussion"],
      valueLabels: [],
      confidence: 0.9,
      sourceSegmentIds: source.map((segment) => segment.id),
      sourceTimeRange: { startSeconds: source[0].startSeconds, endSeconds: source.at(-1)!.endSeconds },
      transcriptExcerpt: source[0].text
    };
  });
  return { segments, semanticSegments };
}

function itemForChunk(chunk: ExtractionChunk): BriefItem {
  const source = chunk.segments[0];
  return {
    id: `raw_${chunk.index}`,
    uploadId: "upload_brief",
    category: "task",
    title: `Task ${chunk.index}`,
    body: source.text,
    priority: "medium",
    confidence: 0.8,
    status: "candidate",
    sourceSegmentIds: [source.id],
    sourceTimeRange: { startSeconds: source.startSeconds, endSeconds: source.endSeconds },
    transcriptExcerpt: source.text,
    people: [],
    topics: [`topic_${chunk.index}`]
  };
}

function digest(items: BriefItem[]) {
  return createHash("sha256").update(JSON.stringify(items)).digest("hex");
}

async function run(concurrency: number, executeChunk?: (chunk: ExtractionChunk) => Promise<DailyBriefChunkExecution>) {
  const input = longInput();
  return await processDailyBriefChunks({
    uploadId: "upload_brief",
    ...input,
    concurrency,
    executeChunk: executeChunk ?? (async (chunk) => ({
      items: [itemForChunk(chunk)],
      resultSource: "provider_success"
    })),
    fallbackChunk: async (chunk) => ({
      items: [itemForChunk(chunk)],
      resultSource: "rule_fallback",
      fallbackReason: "unknown_provider_error"
    })
  });
}

type RetryAwareDailyBriefInput = Parameters<typeof processDailyBriefChunks>[0] & {
  recoveryConcurrency: number;
  maxRetries: number;
  retryDelayMs: number;
  attemptTimeoutMs: number;
  totalBudgetMs: number;
};

function retryableNetworkError(message = "upstream connection failed") {
  return Object.assign(new Error(message), { status: 503, code: "ECONNRESET" });
}

describe("Daily Brief chunk processing", () => {
  it("reuses completed checkpoints and still reruns deterministic merge", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "daily-brief-checkpoint-"));
    const input = longInput();
    const executeChunk = vi.fn(async (chunk: ExtractionChunk) => ({
      items: [itemForChunk(chunk)],
      resultSource: "provider_success" as const
    }));
    const common = {
      uploadId: "upload_brief",
      ...input,
      concurrency: 2,
      executeChunk,
      fallbackChunk: async (_chunk: ExtractionChunk, error: unknown) => { throw error; },
      checkpoint: {
        store: new JsonAnalysisChunkCheckpointStore(new JsonStore(tempDir)),
        userId: "user_1",
        recordingDate: "2026-07-15",
        processorFingerprint: fingerprintAnalysisInput({ processor: "brief-v1" }),
        staleAfterMs: 60_000
      }
    };

    const first = await processDailyBriefChunks(common);
    const second = await processDailyBriefChunks(common);
    const checkpoints = await common.checkpoint.store.list({
      userId: "user_1",
      uploadId: "upload_brief",
      kind: "daily_brief"
    });

    expect(executeChunk).toHaveBeenCalledTimes(6);
    expect(checkpoints).toHaveLength(6);
    expect(checkpoints.every((checkpoint) => checkpoint.resultSource === "provider_success")).toBe(true);
    expect(checkpoints.every((checkpoint) => (
      checkpoint.metadata.providerAttemptCount === 1
      && checkpoint.metadata.retryCount === 0
    ))).toBe(true);
    expect(second.stats.checkpointHits).toBe(6);
    expect(second.chunkResults.every((chunk) => (
      chunk.resultSource === "provider_success"
      && chunk.metadata.providerAttemptCount === 1
      && chunk.metadata.retryCount === 0
    ))).toBe(true);
    expect(second.items).toEqual(first.items);
    expect(second.stats.mergeElapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("claims checkpoints before provider execution so concurrent runs do not duplicate calls", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "daily-brief-checkpoint-single-flight-"));
    const input = longInput();
    const executeChunk = vi.fn(async (chunk: ExtractionChunk) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        items: [itemForChunk(chunk)],
        resultSource: "provider_success" as const
      };
    });
    const common = {
      uploadId: "upload_brief",
      ...input,
      concurrency: 2,
      executeChunk,
      fallbackChunk: async (_chunk: ExtractionChunk, error: unknown) => { throw error; },
      checkpoint: {
        store: new JsonAnalysisChunkCheckpointStore(new JsonStore(tempDir)),
        userId: "user_1",
        recordingDate: "2026-07-15",
        processorFingerprint: fingerprintAnalysisInput({ processor: "brief-single-flight-v1" }),
        staleAfterMs: 60_000
      }
    };

    const [first, second] = await Promise.all([
      processDailyBriefChunks(common),
      processDailyBriefChunks(common)
    ]);

    expect(executeChunk).toHaveBeenCalledTimes(6);
    expect(second.items).toEqual(first.items);
    expect(first.stats.checkpointHits + second.stats.checkpointHits).toBe(6);
  });

  it("waits for a fresh foreign processing checkpoint and reuses its completed output", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "daily-brief-checkpoint-foreign-owner-"));
    const input = longInput();
    const executeChunk = vi.fn(async (chunk: ExtractionChunk) => ({
      items: [itemForChunk(chunk)],
      resultSource: "provider_success" as const
    }));
    const checkpointStore = new JsonAnalysisChunkCheckpointStore(new JsonStore(tempDir));
    const common = {
      uploadId: "upload_brief",
      ...input,
      concurrency: 2,
      executeChunk,
      fallbackChunk: async (_chunk: ExtractionChunk, error: unknown) => { throw error; },
      checkpoint: {
        store: checkpointStore,
        userId: "user_1",
        recordingDate: "2026-07-15",
        processorFingerprint: fingerprintAnalysisInput({ processor: "brief-foreign-owner-v1" }),
        staleAfterMs: 60_000
      }
    };
    await processDailyBriefChunks(common);
    const completed = (await checkpointStore.list({
      userId: "user_1",
      uploadId: "upload_brief",
      kind: "daily_brief"
    }))[0];
    const processingAt = new Date().toISOString();
    await checkpointStore.write({
      ...completed,
      status: "processing",
      resultSource: undefined,
      output: undefined,
      completedAt: undefined,
      startedAt: processingAt,
      updatedAt: processingAt
    });
    executeChunk.mockClear();
    let released = false;

    const replayed = await processDailyBriefChunks({
      ...common,
      sleep: async () => {
        if (released) return;
        released = true;
        await checkpointStore.write(completed);
      }
    });

    expect(released).toBe(true);
    expect(executeChunk).not.toHaveBeenCalled();
    expect(replayed.stats.checkpointHits).toBe(6);
  });

  it("reclaims an orphan processing checkpoint after its short lease becomes stale", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "daily-brief-checkpoint-orphan-"));
    const input = longInput();
    const executeChunk = vi.fn(async (chunk: ExtractionChunk) => ({
      items: [itemForChunk(chunk)],
      resultSource: "provider_success" as const
    }));
    const checkpointStore = new JsonAnalysisChunkCheckpointStore(new JsonStore(tempDir));
    const baseCheckpoint = {
      store: checkpointStore,
      userId: "user_1",
      recordingDate: "2026-07-15",
      processorFingerprint: fingerprintAnalysisInput({ processor: "brief-orphan-v1" }),
      staleAfterMs: 100
    };
    const common = {
      uploadId: "upload_brief",
      ...input,
      concurrency: 2,
      executeChunk,
      fallbackChunk: async (_chunk: ExtractionChunk, error: unknown) => { throw error; },
      checkpoint: baseCheckpoint
    };
    await processDailyBriefChunks(common);
    const completed = (await checkpointStore.list({
      userId: "user_1",
      uploadId: "upload_brief",
      kind: "daily_brief"
    }))[0];
    const processingAt = new Date().toISOString();
    await checkpointStore.write({
      ...completed,
      status: "processing",
      resultSource: undefined,
      output: undefined,
      completedAt: undefined,
      startedAt: processingAt,
      updatedAt: processingAt
    });
    executeChunk.mockClear();

    const replayed = await processDailyBriefChunks({
      ...common,
      totalBudgetMs: 1_000,
      sleep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 125));
      }
    });

    expect(executeChunk).toHaveBeenCalledTimes(1);
    expect(replayed.stats.checkpointStale).toBe(1);
    expect(replayed.stats.checkpointHits).toBe(5);
    expect(replayed.stats.fallbackChunks).toBe(0);
  });

  it("refreshes a live checkpoint lease while a provider attempt is active", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "daily-brief-checkpoint-heartbeat-"));
    const input = longInput();
    const checkpointStore = new JsonAnalysisChunkCheckpointStore(new JsonStore(tempDir));
    const processing = processDailyBriefChunks({
      uploadId: "upload_brief",
      ...input,
      concurrency: 2,
      executeChunk: async (chunk) => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { items: [itemForChunk(chunk)], resultSource: "provider_success" as const };
      },
      fallbackChunk: async (_chunk, error) => { throw error; },
      checkpoint: {
        store: checkpointStore,
        userId: "user_1",
        recordingDate: "2026-07-15",
        processorFingerprint: fingerprintAnalysisInput({ processor: "brief-heartbeat-v1" }),
        staleAfterMs: 60
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const active = (await checkpointStore.list({
      userId: "user_1",
      uploadId: "upload_brief",
      kind: "daily_brief"
    })).filter((checkpoint) => checkpoint.status === "processing");

    expect(active.length).toBeGreaterThan(0);
    expect(active.every((checkpoint) => (
      checkpoint.startedAt !== undefined
      && Date.parse(checkpoint.updatedAt) > Date.parse(checkpoint.startedAt)
    ))).toBe(true);
    await processing;
  });

  it("treats cached non-verbatim evidence as corrupt and recomputes only that chunk", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "daily-brief-checkpoint-evidence-"));
    const input = longInput();
    const executeChunk = vi.fn(async (chunk: ExtractionChunk) => ({
      items: [itemForChunk(chunk)],
      resultSource: "provider_success" as const
    }));
    const checkpointStore = new JsonAnalysisChunkCheckpointStore(new JsonStore(tempDir));
    const common = {
      uploadId: "upload_brief",
      ...input,
      concurrency: 2,
      executeChunk,
      fallbackChunk: async (_chunk: ExtractionChunk, error: unknown) => { throw error; },
      checkpoint: {
        store: checkpointStore,
        userId: "user_1",
        recordingDate: "2026-07-15",
        processorFingerprint: fingerprintAnalysisInput({ processor: "brief-evidence-v1" }),
        staleAfterMs: 60_000
      }
    };
    await processDailyBriefChunks(common);
    const checkpoints = await checkpointStore.list({
      userId: "user_1",
      uploadId: "upload_brief",
      kind: "daily_brief"
    });
    const corrupt = checkpoints[0];
    await checkpointStore.write({
      ...corrupt,
      output: (corrupt.output as BriefItem[]).map((item) => ({
        ...item,
        transcriptExcerpt: "fabricated excerpt that is not in the transcript"
      }))
    });
    executeChunk.mockClear();

    const replayed = await processDailyBriefChunks(common);

    expect(executeChunk).toHaveBeenCalledTimes(1);
    expect(replayed.stats.checkpointCorrupt).toBe(1);
    expect(replayed.stats.checkpointHits).toBe(5);
  });

  it("invalidates Daily Brief checkpoints when only its processor fingerprint changes", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "daily-brief-processor-invalidation-"));
    const input = longInput();
    const executeChunk = vi.fn(async (chunk: ExtractionChunk) => ({
      items: [itemForChunk(chunk)],
      resultSource: "provider_success" as const
    }));
    const store = new JsonAnalysisChunkCheckpointStore(new JsonStore(tempDir));
    const runVersion = (version: string) => processDailyBriefChunks({
      uploadId: "upload_brief",
      ...input,
      concurrency: 2,
      executeChunk,
      fallbackChunk: async (_chunk: ExtractionChunk, error: unknown) => { throw error; },
      checkpoint: {
        store,
        userId: "user_1",
        recordingDate: "2026-07-15",
        processorFingerprint: fingerprintAnalysisInput({ processor: version }),
        staleAfterMs: 60_000
      }
    });
    await runVersion("brief-v1");

    const second = await runVersion("brief-v2");

    expect(executeChunk).toHaveBeenCalledTimes(12);
    expect(second.stats.checkpointStale).toBe(6);
  });

  it("limits six chunks to two concurrent workers and restores index order before merge", async () => {
    let active = 0;
    let maximum = 0;
    const completed: number[] = [];

    const result = await run(2, async (chunk) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, (6 - chunk.index) * 8));
      active -= 1;
      completed.push(chunk.index);
      return { items: [itemForChunk(chunk)], resultSource: "provider_success" };
    });

    expect(maximum).toBe(2);
    expect(completed).not.toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.chunkResults.map((chunk) => chunk.chunkIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.items.map((item) => item.sourceSegmentIds[0])).toEqual([
      "seg_000", "seg_011", "seg_022", "seg_033", "seg_044", "seg_055"
    ]);
  });

  it("produces the same deterministic merge digest at concurrency one, two, and three", async () => {
    const serial = await run(1);
    const two = await run(2);
    const three = await run(3);

    expect(digest(two.items)).toBe(digest(serial.items));
    expect(digest(three.items)).toBe(digest(serial.items));
  });

  it("isolates a failed chunk, uses fallback, and completes the merge", async () => {
    const fallback = vi.fn(async (chunk: ExtractionChunk) => ({
      items: [itemForChunk(chunk)],
      resultSource: "rule_fallback" as const,
      fallbackReason: "unknown_provider_error" as const
    }));
    const input = longInput();
    const result = await processDailyBriefChunks({
      uploadId: "upload_brief",
      ...input,
      concurrency: 2,
      maxRetries: 0,
      executeChunk: async (chunk) => {
        if (chunk.index === 2) {
          throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
        }
        return { items: [itemForChunk(chunk)], resultSource: "provider_success" };
      },
      fallbackChunk: fallback
    });

    expect(result.items).toHaveLength(6);
    expect(result.stats.fallbackChunks).toBe(1);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(result.chunkResults[2].resultSource).toBe("rule_fallback");
  });

  it("runs all six first attempts at concurrency two before a single-concurrency recovery queue", async () => {
    const input = longInput();
    const attempts = new Map<number, number>();
    let activeFirstPass = 0;
    let maxActiveFirstPass = 0;
    let completedFirstPass = 0;
    let activeRecovery = 0;
    let maxActiveRecovery = 0;
    let recoveryStartedEarly = false;

    const request: RetryAwareDailyBriefInput = {
      uploadId: "upload_brief",
      ...input,
      concurrency: 2,
      recoveryConcurrency: 1,
      maxRetries: 1,
      retryDelayMs: 0,
      attemptTimeoutMs: 1_000,
      totalBudgetMs: 5_000,
      executeChunk: async (chunk) => {
        const attempt = (attempts.get(chunk.index) ?? 0) + 1;
        attempts.set(chunk.index, attempt);
        if (attempt === 1) {
          activeFirstPass += 1;
          maxActiveFirstPass = Math.max(maxActiveFirstPass, activeFirstPass);
          await new Promise((resolve) => setTimeout(resolve, 5));
          activeFirstPass -= 1;
          completedFirstPass += 1;
          throw retryableNetworkError();
        }

        recoveryStartedEarly ||= completedFirstPass < 6;
        activeRecovery += 1;
        maxActiveRecovery = Math.max(maxActiveRecovery, activeRecovery);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeRecovery -= 1;
        return { items: [itemForChunk(chunk)], resultSource: "provider_success" };
      },
      fallbackChunk: async (chunk) => ({
        items: [itemForChunk(chunk)],
        resultSource: "rule_fallback",
        fallbackReason: "provider_5xx" as never
      })
    };
    const result = await processDailyBriefChunks(request);

    expect(maxActiveFirstPass).toBe(2);
    expect(recoveryStartedEarly).toBe(false);
    expect(maxActiveRecovery).toBe(1);
    expect([...attempts.values()]).toEqual([2, 2, 2, 2, 2, 2]);
    expect(result.stats).toMatchObject({
      providerSuccess: 0,
      providerRetrySuccess: 6,
      fallbackChunks: 0
    });
    expect(result.chunkResults.every((chunk) => chunk.resultSource === "provider_retry_success")).toBe(true);
  });

  it("records success, retry success, and fallback without retrying successful chunks", async () => {
    const input = longInput();
    const attempts = new Map<number, number>();

    const request: RetryAwareDailyBriefInput = {
      uploadId: "upload_brief",
      ...input,
      concurrency: 2,
      recoveryConcurrency: 1,
      maxRetries: 1,
      retryDelayMs: 0,
      attemptTimeoutMs: 1_000,
      totalBudgetMs: 5_000,
      executeChunk: async (chunk) => {
        const attempt = (attempts.get(chunk.index) ?? 0) + 1;
        attempts.set(chunk.index, attempt);
        if ((chunk.index === 1 && attempt === 1) || chunk.index === 2) {
          throw retryableNetworkError();
        }
        return { items: [itemForChunk(chunk)], resultSource: "provider_success" };
      },
      fallbackChunk: async (chunk) => ({
        items: [itemForChunk(chunk)],
        resultSource: "rule_fallback",
        fallbackReason: "provider_5xx" as never
      })
    };
    const result = await processDailyBriefChunks(request);

    expect(attempts.get(0)).toBe(1);
    expect(attempts.get(1)).toBe(2);
    expect(attempts.get(2)).toBe(2);
    expect(result.chunkResults.map((chunk) => chunk.resultSource)).toEqual([
      "provider_success",
      "provider_retry_success",
      "rule_fallback",
      "provider_success",
      "provider_success",
      "provider_success"
    ]);
    expect(result.stats).toMatchObject({
      providerSuccess: 4,
      providerRetrySuccess: 1,
      fallbackChunks: 1
    });
  });

  it("uses a safe default and rejects invalid configured concurrency", () => {
    expect(resolveDailyBriefChunkConcurrency(undefined)).toBe(2);
    expect(resolveDailyBriefChunkConcurrency("3")).toBe(3);
    expect(() => resolveDailyBriefChunkConcurrency("0")).toThrow("between 1 and 8");
    expect(() => resolveDailyBriefChunkConcurrency("abc")).toThrow("between 1 and 8");
  });
});
