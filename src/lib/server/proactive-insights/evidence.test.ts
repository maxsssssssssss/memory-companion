import { describe, expect, it } from "vitest";

import type { AudioInsight, BriefItem, RelationshipSignalCard, SemanticSegment, TranscriptSegment } from "@/lib/domain/types";

import { buildProactiveInsightContext } from "./evidence";

function segment(index: number, text?: string): TranscriptSegment {
  return {
    id: `seg_${index}`,
    uploadId: "upload_1",
    startSeconds: index * 10,
    endSeconds: index * 10 + 8,
    speaker: index % 2 === 0 ? "self" : "other",
    text: text ?? `Segment ${index} text with enough detail to verify excerpt backfill ${index}.`,
    confidence: 0.95,
    sceneLabels: ["team_management"],
    valueLabels: ["decision"]
  };
}

function relationshipCard(index: number, overrides: Partial<RelationshipSignalCard> = {}): RelationshipSignalCard {
  return {
    id: `card_${index}`,
    uploadId: "upload_1",
    date: "2026-07-10",
    signalType: "boundary_respect",
    signalCategory: "risk",
    severity: index % 2 === 0 ? "high" : "medium",
    confidence: 0.9 - index * 0.03,
    summary: `Relationship summary ${index}`,
    explanation: `Relationship explanation ${index}`,
    involvedSpeakers: ["self", "other"],
    timeRange: {
      startSeconds: index * 10,
      endSeconds: index * 10 + 8
    },
    evidenceSegments: [
      {
        segmentId: `seg_${index + 1}`,
        speaker: "other",
        startSeconds: index * 10,
        endSeconds: index * 10 + 8,
        text: `Hallucinated relationship text ${index}`
      }
    ],
    textEvidence: [`Hallucinated relationship text ${index}`],
    suggestedReflection: `Reflection ${index}`,
    caution: `Caution ${index}`,
    createdAt: "2026-07-10T00:00:00.000Z",
    ...overrides
  };
}

function briefItem(index: number, overrides: Partial<BriefItem> = {}): BriefItem {
  return {
    id: `brief_${index}`,
    uploadId: "upload_1",
    category: "decision",
    title: `Brief title ${index}`,
    body: `Brief body ${index}`,
    priority: index % 3 === 0 ? "high" : index % 3 === 1 ? "medium" : "low",
    confidence: 0.8 - index * 0.02,
    status: "confirmed",
    sourceSegmentIds: [`seg_${index + 8}`],
    sourceTimeRange: {
      startSeconds: (index + 8) * 10,
      endSeconds: (index + 8) * 10 + 8
    },
    transcriptExcerpt: `Fake brief excerpt ${index}`,
    people: [],
    topics: [],
    ...overrides
  };
}

function semanticSegment(index: number, overrides: Partial<SemanticSegment> = {}): SemanticSegment {
  return {
    id: `semantic_${index}`,
    uploadId: "upload_1",
    title: `Semantic title ${index}`,
    summary: `Semantic summary ${index}`,
    startSeconds: (index + 16) * 10,
    endSeconds: (index + 16) * 10 + 8,
    tags: ["tag"],
    sceneLabels: ["team_management"],
    valueLabels: ["decision"],
    confidence: 0.7 - index * 0.02,
    sourceSegmentIds: [`seg_${index + 16}`],
    sourceTimeRange: {
      startSeconds: (index + 16) * 10,
      endSeconds: (index + 16) * 10 + 8
    },
    transcriptExcerpt: `Fake semantic excerpt ${index}`,
    ...overrides
  };
}

function audioInsight(index: number, overrides: Partial<AudioInsight> = {}): AudioInsight {
  return {
    id: `audio_${index}`,
    uploadId: "upload_1",
    sourceSegmentIds: [`seg_${index + 24}`],
    sourceTimeRange: {
      startSeconds: (index + 24) * 10,
      endSeconds: (index + 24) * 10 + 8
    },
    speaker: {
      id: "speaker_1",
      role: "self",
      confidence: 0.7
    },
    voice: {
      pace: "normal",
      volume: "normal",
      pause: "normal",
      overlap: false,
      confidence: 0.6
    },
    toneLabels: ["serious"],
    emotionLabels: ["neutral"],
    interactionLabels: ["topic_shift"],
    summary: `Audio summary ${index}`,
    evidence: `Fake audio evidence ${index}`,
    confidence: 0.65 - index * 0.01,
    ...overrides
  };
}

describe("buildProactiveInsightContext", () => {
  it("caps evidence by kind, preserves group order, and backfills excerpts from source segments", () => {
    const segments = Array.from({ length: 40 }, (_, index) =>
      segment(index + 1, `Real segment ${index + 1} text from transcript.`)
    );

    const result = buildProactiveInsightContext({
      scope: "current",
      uploadId: "upload_1",
      recordingDate: "2026-07-10",
      segments,
      relationshipSignals: Array.from({ length: 7 }, (_, index) => relationshipCard(index + 1)),
      briefItems: Array.from({ length: 9 }, (_, index) => briefItem(index + 1)),
      semanticSegments: Array.from({ length: 7 }, (_, index) => semanticSegment(index + 1)),
      audioInsights: Array.from({ length: 9 }, (_, index) => audioInsight(index + 1))
    });

    expect(result.context.evidence).toHaveLength(24);
    expect(result.context.truncated).toBe(true);
    expect(result.context.evidence.slice(0, 6).every((item) => item.kind === "relationship_signal")).toBe(true);
    expect(result.context.evidence.slice(6, 14).every((item) => item.kind === "brief")).toBe(true);
    expect(result.context.evidence.slice(14, 20).every((item) => item.kind === "semantic_segment")).toBe(true);
    expect(result.context.evidence.slice(20).every((item) => item.kind === "audio_insight")).toBe(true);
    expect(result.context.evidence[0]?.excerpt).toContain("Real segment 2 text from transcript.");
    expect(result.context.evidence[0]?.excerpt).not.toContain("Hallucinated relationship text");
    expect(result.context.sourceUploadIds).toEqual(["upload_1"]);
    expect(result.context.distinctDates).toEqual(["2026-07-10"]);
    expect(result.context.dateRange).toEqual({
      startDate: "2026-07-10",
      endDate: "2026-07-10"
    });
    expect(result.context.truncated).toBe(true);
  });

  it("drops evidence with forged source segments and produces a stable fingerprint", () => {
    const segments = [
      segment(1, "First real segment."),
      segment(2, "Second real segment."),
      segment(3, "Third real segment."),
      segment(4, "Fourth real segment."),
      segment(5, "Fifth real segment.")
    ];

    const validResult = buildProactiveInsightContext({
      scope: "current",
      uploadId: "upload_1",
      recordingDate: "2026-07-10",
      segments,
      relationshipSignals: [
        relationshipCard(1, {
          evidenceSegments: [
            {
              segmentId: "seg_1",
              speaker: "other",
              startSeconds: 1,
              endSeconds: 2,
              text: "forged"
            }
          ]
        }),
        relationshipCard(2, {
          uploadId: "upload_2",
          evidenceSegments: [
            {
              segmentId: "seg_missing",
              speaker: "other",
              startSeconds: 1,
              endSeconds: 2,
              text: "forged"
            }
          ]
        })
      ],
      briefItems: [
        briefItem(1, {
          sourceSegmentIds: ["seg_2", "seg_3", "seg_4", "seg_5", "seg_missing"]
        })
      ],
      semanticSegments: [],
      audioInsights: []
    });

    const repeatedResult = buildProactiveInsightContext({
      scope: "current",
      uploadId: "upload_1",
      recordingDate: "2026-07-10",
      segments,
      relationshipSignals: [
        relationshipCard(1, {
          evidenceSegments: [
            {
              segmentId: "seg_1",
              speaker: "other",
              startSeconds: 1,
              endSeconds: 2,
              text: "forged"
            }
          ]
        })
      ],
      briefItems: [],
      semanticSegments: [],
      audioInsights: []
    });

    expect(validResult.context.evidence).toHaveLength(1);
    expect(validResult.context.evidence[0]?.sourceSegmentIds).toEqual(["seg_1"]);
    expect(validResult.context.evidence[0]?.timeRange).toEqual({
      startSeconds: 10,
      endSeconds: 18
    });
    expect(validResult.sourceFingerprint).toBe(repeatedResult.sourceFingerprint);
  });

  it("marks truncated when items are dropped by per-kind caps even if total evidence stays below 24", () => {
    const segments = Array.from({ length: 20 }, (_, index) => segment(index + 1, `Real segment ${index + 1}.`));

    const result = buildProactiveInsightContext({
      scope: "current",
      uploadId: "upload_1",
      recordingDate: "2026-07-10",
      segments,
      relationshipSignals: Array.from({ length: 7 }, (_, index) => relationshipCard(index + 1)),
      briefItems: [],
      semanticSegments: [],
      audioInsights: []
    });

    expect(result.context.evidence).toHaveLength(6);
    expect(result.context.truncated).toBe(true);
  });

  it("preserves traceable semantic source ids longer than 120 characters", () => {
    const longSemanticId = `semantic_${"a".repeat(150)}`;
    const result = buildProactiveInsightContext({
      scope: "current",
      uploadId: "upload_1",
      recordingDate: "2026-07-10",
      segments: [segment(1, "A real transcript excerpt for a long semantic id.")],
      relationshipSignals: [],
      briefItems: [],
      semanticSegments: [
        semanticSegment(1, {
          id: longSemanticId,
          sourceSegmentIds: ["seg_1"]
        })
      ],
      audioInsights: []
    });

    expect(result.context.evidence[0]).toMatchObject({
      sourceId: longSemanticId,
      evidenceId: `semantic_segment:${longSemanticId}`
    });
  });
});
