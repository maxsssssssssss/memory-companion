import { describe, expect, it } from "vitest";

import type { ProactiveInsight } from "@/lib/domain/proactive-insights";

import type { ProactiveInsightMemoryContext, ProactiveMemoryItem } from "./memory-context";
import { rankProactiveInsights } from "./ranking";

function memory(input: Partial<ProactiveMemoryItem> & Pick<ProactiveMemoryItem, "memoryId" | "type">): ProactiveMemoryItem {
  return {
    evidenceId: `memory:${input.memoryId}`,
    title: input.memoryId,
    summary: `${input.memoryId} summary`,
    importanceScore: 0.8,
    confidence: "high",
    status: "active",
    lifecycleKind: "preference",
    occurrenceCount: 1,
    dates: ["2026-07-09"],
    sourceUploadIds: ["history_upload"],
    evidence: [
      {
        sourceType: "transcript",
        sourceId: `${input.memoryId}_segment`,
        uploadId: "history_upload",
        recordingDate: "2026-07-09",
        excerpt: "Historical evidence"
      }
    ],
    ...input
  };
}

function insight(id: string, memoryRefs: string[], insightType: ProactiveInsight["insightType"]): ProactiveInsight {
  return {
    id,
    scope: "current",
    type: "reflection",
    insightType,
    category: "memory",
    observation: `${id} observation`,
    question: `${id} question?`,
    reason: `${id} reason`,
    confidence: 0.7,
    evidenceRefs: [
      {
        evidenceId: "brief:item_1",
        kind: "brief",
        sourceType: "brief",
        sourceId: "item_1",
        uploadId: "upload_current",
        recordingDate: "2026-07-10",
        sourceSegmentIds: ["seg_1"],
        timeRange: { startSeconds: 1, endSeconds: 2 },
        title: "Current",
        summary: "Current evidence",
        excerpt: "Current evidence"
      }
    ],
    memoryRefs,
    sourceUploadIds: ["upload_current", "history_upload"],
    caution: "This is a reflection prompt, not a conclusion.",
    createdAt: "2026-07-10T12:00:00.000Z"
  };
}

describe("rankProactiveInsights", () => {
  it("orders unresolved questions before commitments, repeated memory, relationship signals, and reflection", () => {
    const memoryContext: ProactiveInsightMemoryContext = {
      scope: "current",
      currentUploadId: "upload_current",
      truncated: false,
      relations: [
        {
          relationId: "relation_change",
          relationType: "follow_up",
          confidence: 0.82,
          sourceMemoryRef: "memory:changed",
          targetMemoryRef: "memory:external"
        }
      ],
      memories: [
        memory({ memoryId: "question", type: "question", lifecycleKind: "unresolved_question" }),
        memory({ memoryId: "commitment", type: "commitment", lifecycleKind: "active_commitment" }),
        memory({ memoryId: "changed", type: "preference", lifecycleKind: "preference" }),
        memory({ memoryId: "repeated", type: "preference", lifecycleKind: "repeated_memory", occurrenceCount: 3 }),
        memory({ memoryId: "relationship", type: "relationship_signal", lifecycleKind: "relationship_signal" })
      ]
    };

    const ranked = rankProactiveInsights([
      insight("reflection", [], "reflection"),
      insight("relationship", ["memory:relationship"], "reflection"),
      insight("repeated", ["memory:repeated"], "pattern_observation"),
      insight("changed", ["memory:changed"], "reflection"),
      insight("commitment", ["memory:commitment"], "reminder"),
      insight("question", ["memory:question"], "follow_up")
    ], memoryContext);

    expect(ranked.map((item) => item.id)).toEqual([
      "question",
      "commitment",
      "changed",
      "repeated",
      "relationship",
      "reflection"
    ]);
  });
});
