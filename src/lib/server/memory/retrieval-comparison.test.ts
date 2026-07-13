// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { compareRetrievalSources, logRetrievalComparison } from "./retrieval-comparison";
import type { MemoryItem } from "./types";

const memory: MemoryItem = {
  id: "memory_1",
  userId: "user_1",
  type: "commitment",
  title: "确认下次安排",
  summary: "出现了一项承诺。",
  importance: 0.8,
  importanceScore: 0.8,
  importanceReasons: ["commitment type"],
  status: "active",
  occurrenceCount: 1,
  firstSeenDate: "2026-07-08",
  lastSeenDate: "2026-07-08",
  accessCount: 0,
  lastAccessedAt: null,
  date: "2026-07-08",
  createdAt: "2026-07-08T10:00:00.000Z",
  updatedAt: "2026-07-08T10:00:00.000Z",
  evidence: [
    {
      id: "memory_evidence_brief",
      memoryId: "memory_1",
      sourceType: "brief",
      sourceId: "brief_1",
      uploadId: "upload_1",
      date: "2026-07-08",
      quote: "Brief evidence text",
      createdAt: "2026-07-08T10:00:00.000Z"
    },
    {
      id: "memory_evidence_segment_1",
      memoryId: "memory_1",
      sourceType: "transcript",
      sourceId: "segment_1",
      uploadId: "upload_1",
      date: "2026-07-08",
      quote: "Sensitive transcript text that must not be logged",
      createdAt: "2026-07-08T10:00:00.000Z"
    },
    {
      id: "memory_evidence_segment_2",
      memoryId: "memory_1",
      sourceType: "transcript",
      sourceId: "segment_2",
      uploadId: "upload_1",
      date: "2026-07-08",
      quote: "Another transcript segment",
      createdAt: "2026-07-08T10:00:00.000Z"
    }
  ]
};

describe("retrieval comparison", () => {
  it("calculates overlap, source differences, dates and latency", () => {
    const result = compareRetrievalSources({
      query: "有哪些承诺？",
      scope: "all",
      jsonEvidence: [
        { id: "brief_1", kind: "brief", title: "2026-07-08 承诺", text: "summary", sourceSegmentIds: ["segment_1"] },
        { id: "raw_3", kind: "raw", title: "2026-07-09 transcript", text: "summary", sourceSegmentIds: ["segment_3"] }
      ],
      jsonRetrievalTimeMs: 12,
      memoryResult: {
        memories: [memory],
        evidence: memory.evidence,
        retrievalTimeMs: 4,
        count: 1
      }
    });

    expect(result).toMatchObject({
      jsonEvidenceCount: 2,
      memoryCount: 1,
      memoryEvidenceCount: 3,
      overlapCount: 2,
      onlyMemory: ["segment_2"],
      latency: { jsonMs: 12, sqliteMs: 4 }
    });
    expect(result.onlyJson).toEqual(expect.arrayContaining(["raw_3", "segment_3"]));
    expect(result.memoryTypes).toEqual({ commitment: 1 });
    expect(result.jsonSourceTypes).toEqual({ brief: 1, raw: 1 });
    expect(result.jsonDates).toEqual(["2026-07-08", "2026-07-09"]);
    expect(result.memoryDates).toEqual(["2026-07-08"]);
  });

  it("logs summaries without transcript text", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const comparison = compareRetrievalSources({
      query: "过去有哪些承诺？",
      scope: "all",
      jsonEvidence: [],
      jsonRetrievalTimeMs: 2,
      memoryResult: { memories: [memory], evidence: memory.evidence, retrievalTimeMs: 1, count: 1 }
    });

    logRetrievalComparison(comparison);

    const logged = String(info.mock.calls[0]?.[0]);
    expect(logged).toContain("[memory-shadow] scope=all");
    expect(logged).toContain("sqlite_memories=1");
    expect(logged).not.toContain("Sensitive transcript text");
  });
});
