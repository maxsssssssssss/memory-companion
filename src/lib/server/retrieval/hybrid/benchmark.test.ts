import { describe, expect, it } from "vitest";
import type { QaRetrievedEvidence } from "../ai-qa";
import type { MemoryIndexQaContext } from "../memory-index-evidence";
import { buildHybridBenchmarkScopedQaInput } from "./benchmark";
import {
  hybridCandidateCitationValidity
} from "./hybrid-candidates";

function evidence(id: string, sourceId = `segment-${id}`): QaRetrievedEvidence {
  return {
    id,
    kind: "raw",
    title: id,
    text: id,
    startSeconds: 0,
    endSeconds: 1,
    sourceSegmentIds: [sourceId],
    priority: 1
  };
}

describe("Hybrid benchmark citation invariant", () => {
  it("accepts only candidates that preserve Canonical Evidence source IDs", () => {
    const canonical = [evidence("one"), evidence("two")];
    expect(hybridCandidateCitationValidity([
      { evidence: canonical[0]!, rrfScore: 0.1, channelRanks: { dense: 1 } }
    ], canonical)).toBe(true);
    expect(hybridCandidateCitationValidity([
      {
        evidence: { ...canonical[0]!, sourceSegmentIds: ["invented"] },
        rrfScore: 0.1,
        channelRanks: { dense: 1 }
      }
    ], canonical)).toBe(false);
    expect(hybridCandidateCitationValidity([
      {
        evidence: evidence("invented-id"),
        rrfScore: 0.1,
        channelRanks: { dense: 1 }
      }
    ], canonical)).toBe(false);
  });
});

describe("Hybrid benchmark scoped QA input", () => {
  it("preserves the SQLite Memory context used by week/all Current Retrieval", () => {
    const memoryContext = {
      scope: "week",
      memories: [],
      ownerAttributions: [],
      evidence: [],
      sourceIds: ["segment-memory"],
      distinctDates: ["2026-07-20"],
      count: 1,
      retrievalTimeMs: 0
    } satisfies MemoryIndexQaContext;

    const qaInput = buildHybridBenchmarkScopedQaInput({
      userId: "benchmark-user",
      question: "杩欏懆鎴戝畬鎴愪簡浠€涔堬紵",
      scope: "week",
      context: {
        uploadId: "week:2026-07-20:2026-07-26",
        scope: "week",
        segments: [],
        audioInsights: [],
        semanticSegments: [],
        briefItems: [],
        relationshipSignals: []
      },
      memoryContext
    });

    expect(qaInput.userId).toBe("benchmark-user");
    expect(qaInput.memoryContext).toBe(memoryContext);
  });
});
