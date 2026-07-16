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
      fallbackReason: "provider_error"
    })
  });
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

    expect(executeChunk).toHaveBeenCalledTimes(6);
    expect(second.stats.checkpointHits).toBe(6);
    expect(second.items).toEqual(first.items);
    expect(second.stats.mergeElapsedMs).toBeGreaterThanOrEqual(0);
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
      fallbackReason: "provider_error" as const
    }));
    const input = longInput();
    const result = await processDailyBriefChunks({
      uploadId: "upload_brief",
      ...input,
      concurrency: 2,
      executeChunk: async (chunk) => {
        if (chunk.index === 2) throw new Error("provider failed");
        return { items: [itemForChunk(chunk)], resultSource: "provider_success" };
      },
      fallbackChunk: fallback
    });

    expect(result.items).toHaveLength(6);
    expect(result.stats.fallbackChunks).toBe(1);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(result.chunkResults[2].resultSource).toBe("rule_fallback");
  });

  it("uses a safe default and rejects invalid configured concurrency", () => {
    expect(resolveDailyBriefChunkConcurrency(undefined)).toBe(2);
    expect(resolveDailyBriefChunkConcurrency("3")).toBe(3);
    expect(() => resolveDailyBriefChunkConcurrency("0")).toThrow("positive integer");
    expect(() => resolveDailyBriefChunkConcurrency("abc")).toThrow("positive integer");
  });
});
