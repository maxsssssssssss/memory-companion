import { describe, expect, it, vi } from "vitest";

import type { ProactiveInsightContext } from "@/lib/domain/proactive-insights";
import type { ProactiveInsightMemoryContext } from "@/lib/server/proactive-insights/memory-context";

import { applyMemoryRelevanceGate } from "./judge";
import type { MemoryRelevanceJudge } from "./types";

function currentContext(): ProactiveInsightContext {
  return {
    schemaVersion: 1,
    scope: "current",
    referenceDate: "2026-07-13",
    dateRange: { startDate: "2026-07-13", endDate: "2026-07-13" },
    sourceUploadIds: ["upload_current"],
    distinctDates: ["2026-07-13"],
    truncated: false,
    evidence: [{
      evidenceId: "semantic_segment:game",
      kind: "semantic_segment",
      sourceType: "semantic_segment",
      sourceId: "game",
      uploadId: "upload_current",
      recordingDate: "2026-07-13",
      sourceSegmentIds: ["segment_current"],
      timeRange: { startSeconds: 0, endSeconds: 30 },
      title: "合作游戏",
      summary: "两个人讨论下一局如何配合",
      excerpt: "下一局我先去左边，你帮我看右边。"
    }]
  };
}

function memoryContext(): ProactiveInsightMemoryContext {
  return {
    scope: "current",
    currentUploadId: "upload_current",
    truncated: false,
    memories: [
      {
        evidenceId: "memory:game",
        memoryId: "game",
        type: "relationship_signal",
        title: "会回应游戏建议",
        summary: "之前玩游戏时也会听完建议再调整",
        importanceScore: 0.75,
        confidence: "medium",
        status: "active",
        lifecycleKind: "relationship_signal",
        occurrenceCount: 2,
        dates: ["2026-07-10"],
        sourceUploadIds: ["upload_game"],
        evidence: [{
          sourceType: "transcript",
          sourceId: "segment_game",
          uploadId: "upload_game",
          recordingDate: "2026-07-10",
          excerpt: "好，我按你说的试试。"
        }]
      },
      {
        evidenceId: "memory:travel",
        memoryId: "travel",
        type: "commitment",
        title: "旅行计划",
        summary: "之前讨论了下个月的旅行日期",
        importanceScore: 0.91,
        confidence: "high",
        status: "active",
        lifecycleKind: "active_commitment",
        occurrenceCount: 1,
        dates: ["2026-07-01"],
        sourceUploadIds: ["upload_travel"],
        evidence: [{
          sourceType: "transcript",
          sourceId: "segment_travel",
          uploadId: "upload_travel",
          recordingDate: "2026-07-01",
          excerpt: "下个月再确认旅行日期。"
        }]
      }
    ],
    relations: [{
      relationId: "related",
      relationType: "related",
      confidence: 0.7,
      sourceMemoryRef: "memory:game",
      targetMemoryRef: "memory:travel"
    }]
  };
}

function judge(rawResults: unknown[]): MemoryRelevanceJudge {
  return {
    judge: vi.fn().mockResolvedValue({
      status: "judged",
      rawResults,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      elapsedMs: 8
    })
  };
}

describe("memory relevance gate", () => {
  it("keeps a relevant memory, rejects an important unrelated memory, and removes dangling relations", async () => {
    const original = memoryContext();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const result = await applyMemoryRelevanceGate({
      context: currentContext(),
      memoryContext: original,
      judge: judge([
        {
          memoryId: "game",
          shouldUse: true,
          relevanceScore: 0.9,
          usefulnessScore: 0.82,
          reason: "The earlier game response is directly useful now."
        },
        {
          memoryId: "travel",
          shouldUse: false,
          relevanceScore: 0.1,
          usefulnessScore: 0.08,
          reason: "The travel plan is unrelated to the game."
        }
      ]),
      logger
    });

    expect(result.memoryContext.memories.map((memory) => memory.memoryId)).toEqual(["game"]);
    expect(result.memoryContext.relations).toEqual([]);
    expect(result).toMatchObject({ candidates: 2, accepted: 1, rejected: 1, fallback: false });
    expect(original.memories).toHaveLength(2);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("unrelated_topic:1"));
  });

  it("uses current-only context when the judge fails and never throws", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const failingJudge: MemoryRelevanceJudge = {
      judge: vi.fn().mockResolvedValue({
        status: "fallback",
        rawResults: [],
        provider: "deepseek",
        model: "deepseek-v4-flash",
        elapsedMs: 20,
        failureCode: "invalid_json"
      })
    };

    const result = await applyMemoryRelevanceGate({
      context: currentContext(),
      memoryContext: memoryContext(),
      judge: failingJudge,
      logger
    });

    expect(result.memoryContext.memories).toEqual([]);
    expect(result).toMatchObject({ fallback: true, failureCode: "invalid_json" });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("fallback=true"));
  });

  it("rejects unsafe relationship conclusions from the judge", async () => {
    const result = await applyMemoryRelevanceGate({
      context: currentContext(),
      memoryContext: memoryContext(),
      judge: judge([
        {
          memoryId: "game",
          shouldUse: true,
          relevanceScore: 0.9,
          usefulnessScore: 0.9,
          reason: "对方就是操控型人格，所以这条记忆应该使用。"
        },
        {
          memoryId: "travel",
          shouldUse: false,
          relevanceScore: 0.1,
          usefulnessScore: 0.1,
          reason: "The travel plan is unrelated."
        }
      ]),
      logger: { info: vi.fn(), warn: vi.fn() }
    });

    expect(result.memoryContext.memories).toEqual([]);
  });

  it("passes at most five judged memories to the proactive agent", async () => {
    const baseMemory = memoryContext().memories[0]!;
    const manyMemories: ProactiveInsightMemoryContext = {
      scope: "current",
      currentUploadId: "upload_current",
      truncated: false,
      relations: [],
      memories: Array.from({ length: 7 }, (_, index) => ({
        ...baseMemory,
        evidenceId: `memory:relevant_${index + 1}`,
        memoryId: `relevant_${index + 1}`,
        importanceScore: 0.9 - index * 0.01
      }))
    };
    const rawResults = manyMemories.memories.map((memory, index) => ({
      memoryId: memory.memoryId,
      shouldUse: true,
      relevanceScore: 0.95 - index * 0.02,
      usefulnessScore: 0.9 - index * 0.02,
      reason: "This earlier game detail can support a concrete reminder."
    }));

    const result = await applyMemoryRelevanceGate({
      context: currentContext(),
      memoryContext: manyMemories,
      judge: judge(rawResults),
      logger: { info: vi.fn(), warn: vi.fn() }
    });

    expect(result.memoryContext.memories).toHaveLength(5);
    expect(result.rejected).toBe(2);
  });
});
