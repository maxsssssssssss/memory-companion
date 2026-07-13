import { describe, expect, it } from "vitest";

import {
  ProactiveEvidenceSchema,
  ProactiveInsightCacheDocumentSchema,
  ProactiveInsightContextSchema,
  ProactiveInsightSchema,
  ProactiveInsightRawItemSchema,
  proactiveInsightCacheIdForUpload
} from "./proactive-insights";

describe("proactive insight domain schemas", () => {
  it("uses a stable current-scope cache id for an upload", () => {
    expect(proactiveInsightCacheIdForUpload("upload_1")).toBe("current_upload_1");
  });

  it("accepts evidence and normalized insights with concrete references", () => {
    const evidence = ProactiveEvidenceSchema.parse({
      evidenceId: "relationship_signal:card_1",
      kind: "relationship_signal",
      sourceType: "relationship_signal",
      sourceId: "card_1",
      uploadId: "upload_1",
      recordingDate: "2026-07-10",
      sourceSegmentIds: ["seg_1"],
      timeRange: {
        startSeconds: 10,
        endSeconds: 18
      },
      title: "Boundary respect signal",
      summary: "A clear check-in before continuing.",
      excerpt: "I want to make sure this still feels okay for you.",
      confidence: 0.82,
      caution: "Only a local clue from this recording.",
      signalCategory: "uncertain"
    });

    const context = ProactiveInsightContextSchema.parse({
      schemaVersion: 1,
      scope: "current",
      referenceDate: "2026-07-10",
      dateRange: {
        startDate: "2026-07-10",
        endDate: "2026-07-10"
      },
      sourceUploadIds: ["upload_1"],
      distinctDates: ["2026-07-10"],
      evidence: [evidence],
      truncated: false
    });

    const insight = ProactiveInsightSchema.parse({
      id: "pi_1",
      scope: "current",
      type: "follow_up_question",
      insightType: "follow_up",
      category: "follow_up",
      observation: "The speaker checked in before pushing ahead.",
      question: "What made that check-in feel different from other moments?",
      reason: "The question stays anchored to a specific interaction clue.",
      confidence: 0.7,
      evidenceRefs: [evidence],
      memoryRefs: ["memory:commitment_1"],
      sourceUploadIds: ["upload_1"],
      caution: "Only a local clue from this recording.",
      createdAt: "2026-07-10T00:00:00.000Z"
    });

    expect(context.evidence[0]).toEqual(evidence);
    expect(insight.evidenceRefs[0].evidenceId).toBe("relationship_signal:card_1");
    expect(insight.insightType).toBe("follow_up");
    expect(insight.memoryRefs).toEqual(["memory:commitment_1"]);
  });

  it("accepts the v2 raw reflection fields while keeping the existing type contract", () => {
    const item = ProactiveInsightRawItemSchema.parse({
      type: "follow_up_question",
      insightType: "reminder",
      category: "memory",
      observation: "之前有一项安排仍值得确认。",
      question: "这项安排现在是否已经有了后续？",
      reason: "当前证据与一条 active commitment 都指向同一项待确认安排。",
      evidenceIds: ["brief:item_1"],
      memoryRefs: ["memory:commitment_1"],
      confidence: 0.76,
      caution: "现有记录只能提示需要确认，不能据此判断是否违约。"
    });

    expect(item.insightType).toBe("reminder");
    expect(item.memoryRefs).toEqual(["memory:commitment_1"]);
  });

  it("rejects malformed raw items and oversized evidence contexts", () => {
    expect(() =>
      ProactiveInsightRawItemSchema.parse({
        type: "reflection",
        category: "summary",
        observation: "",
        question: "What happened?",
        reason: "Because",
        evidenceIds: [],
        confidence: 0.9
      })
    ).toThrow();

    const evidence = Array.from({ length: 25 }, (_, index) => ({
      evidenceId: `brief:item_${index}`,
      kind: "brief" as const,
      sourceType: "brief",
      sourceId: `item_${index}`,
      uploadId: "upload_1",
      recordingDate: "2026-07-10",
      sourceSegmentIds: [`seg_${index}`],
      timeRange: {
        startSeconds: index,
        endSeconds: index + 1
      },
      title: `Title ${index}`,
      summary: `Summary ${index}`,
      excerpt: `Excerpt ${index}`
    }));

    expect(() =>
      ProactiveInsightContextSchema.parse({
        schemaVersion: 1,
        scope: "week",
        referenceDate: "2026-07-10",
        dateRange: {
          startDate: "2026-07-01",
          endDate: "2026-07-10"
        },
        sourceUploadIds: ["upload_1"],
        distinctDates: ["2026-07-10"],
        evidence,
        truncated: true
      })
    ).toThrow();
  });

  it("accepts cache documents with generated provider metadata", () => {
    const cacheDocument = ProactiveInsightCacheDocumentSchema.parse({
      schemaVersion: 1,
      cacheId: "cache_1",
      scope: "all",
      status: "generated",
      sourceFingerprint: "fp_1",
      generatedAt: "2026-07-10T00:00:00.000Z",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      elapsedMs: 1234,
      items: [
        {
          id: "pi_1",
          scope: "all",
          type: "reflection",
          category: "summary",
          observation: "A grounded observation.",
          question: "What detail is still unresolved here?",
          reason: "It points to a concrete evidence gap.",
          confidence: 0.66,
          evidenceRefs: [
            {
              evidenceId: "semantic_segment:sem_1",
              kind: "semantic_segment",
              sourceType: "semantic_segment",
              sourceId: "sem_1",
              uploadId: "upload_1",
              recordingDate: "2026-07-10",
              sourceSegmentIds: ["seg_1"],
              timeRange: {
                startSeconds: 5,
                endSeconds: 12
              },
              title: "Topic shift",
              summary: "The discussion shifted into staffing.",
              excerpt: "Let's figure out staffing before we move on."
            }
          ],
          sourceUploadIds: ["upload_1"],
          createdAt: "2026-07-10T00:00:00.000Z"
        }
      ]
    });

    expect(cacheDocument.status).toBe("generated");
    expect(cacheDocument.items).toHaveLength(1);
  });
});
