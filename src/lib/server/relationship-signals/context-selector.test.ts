import { describe, expect, it } from "vitest";
import { AudioInsightSchema, type AudioInsight, type TranscriptSegment } from "@/lib/domain/types";
import { selectRelationshipContext } from "./context-selector";

const uploadId = "upload_context_selector";

function segment(
  id: string,
  index: number,
  overrides: Partial<TranscriptSegment> = {}
): TranscriptSegment {
  return {
    id,
    uploadId,
    startSeconds: index * 20,
    endSeconds: index * 20 + 18,
    speaker: index % 2 === 0 ? "speaker_1" : "speaker_2",
    text: `Neutral transcript marker ${index}; this exact text must remain available for evidence backfill.`,
    confidence: 0.94,
    sceneLabels: ["unknown"],
    valueLabels: [],
    ...overrides
  };
}

type InsightOverrides = Partial<Omit<AudioInsight, "speaker" | "voice" | "sourceTimeRange">> & {
  speaker?: Partial<AudioInsight["speaker"]>;
  voice?: Partial<AudioInsight["voice"]>;
};

function insight(
  id: string,
  sourceSegments: TranscriptSegment[],
  overrides: InsightOverrides = {}
): AudioInsight {
  const first = sourceSegments[0];
  const last = sourceSegments[sourceSegments.length - 1];
  const { speaker: speakerOverrides, voice: voiceOverrides, ...insightOverrides } = overrides;

  return AudioInsightSchema.parse({
    id,
    uploadId,
    sourceSegmentIds: sourceSegments.map((entry) => entry.id),
    sourceTimeRange: {
      startSeconds: first.startSeconds,
      endSeconds: last.endSeconds
    },
    speaker: {
      id: first.speaker ?? "speaker_unknown",
      role: "unknown",
      confidence: 0.8,
      ...speakerOverrides
    },
    voice: {
      pace: "normal",
      volume: "normal",
      pause: "normal",
      overlap: false,
      confidence: 0.75,
      ...voiceOverrides
    },
    toneLabels: ["explaining"],
    emotionLabels: ["neutral"],
    interactionLabels: ["unknown"],
    atmosphereLabels: ["unknown"],
    summary: `Structured observation ${id}.`,
    evidence: `Evidence payload for ${id}.`,
    confidence: 0.82,
    ...insightOverrides
  });
}

describe("relationship context selector", () => {
  it("keeps structurally high-value commitment, conflict, and support insights", () => {
    const commitment = segment("seg_commitment", 0, { valueLabels: ["commitment"] });
    const conflict = segment("seg_conflict", 1, { valueLabels: ["risk"] });
    const support = segment("seg_support", 2, { valueLabels: ["open_question"] });
    const generic = segment("seg_generic", 3, { sceneLabels: ["low_value_chatter"] });
    const audioInsights = [
      insight("insight_commitment", [commitment], {
        interactionLabels: ["decision_moment"],
        atmosphereLabels: ["collaborative"]
      }),
      insight("insight_conflict", [conflict], {
        toneLabels: ["pushing_back"],
        emotionLabels: ["anxious"],
        interactionLabels: ["disagreement"],
        atmosphereLabels: ["conflicted"]
      }),
      insight("insight_support", [support], {
        toneLabels: ["comforting"],
        emotionLabels: ["tired"],
        interactionLabels: ["rapport"],
        atmosphereLabels: ["warm"]
      }),
      insight("insight_generic", [generic], {
        toneLabels: ["playful"],
        emotionLabels: ["happy"],
        interactionLabels: ["agreement"],
        atmosphereLabels: ["playful"]
      })
    ];

    const selected = selectRelationshipContext({
      segments: [commitment, conflict, support, generic],
      audioInsights
    });

    expect(selected.audioInsights.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(["insight_commitment", "insight_conflict", "insight_support"])
    );
    expect(selected.audioInsights.map((entry) => entry.id)).not.toContain("insight_generic");
  });

  it("removes generic low-value insights and overlapping duplicates deterministically", () => {
    const highValueSource = segment("seg_high_value", 0, { valueLabels: ["decision"] });
    const lowValueSource = segment("seg_low_value", 1, { sceneLabels: ["low_value_chatter"] });
    const preferred = insight("insight_preferred", [highValueSource], {
      toneLabels: ["firm"],
      interactionLabels: ["decision_moment"],
      confidence: 0.93
    });
    const duplicate = insight("insight_duplicate", [highValueSource], {
      toneLabels: ["firm"],
      interactionLabels: ["decision_moment"],
      summary: preferred.summary,
      confidence: 0.71
    });
    const generic = insight("insight_low_value", [lowValueSource], {
      toneLabels: ["playful"],
      emotionLabels: ["happy"],
      interactionLabels: ["agreement"],
      atmosphereLabels: ["playful"]
    });

    const selected = selectRelationshipContext({
      segments: [highValueSource, lowValueSource],
      audioInsights: [duplicate, generic, preferred]
    });

    expect(selected.audioInsights.map((entry) => entry.id)).toEqual(["insight_preferred"]);
    expect(selected.audit.removedReasonCounts).toMatchObject({
      duplicate_source_overlap: 1,
      generic_low_value: 1
    });
  });

  it("keeps distinct facts that share sources and structured labels", () => {
    const source = segment("seg_shared", 0, { valueLabels: ["commitment"] });
    const first = insight("insight_first_fact", [source], {
      toneLabels: ["firm"],
      interactionLabels: ["decision_moment"],
      summary: "A specific action was agreed for the first follow-up."
    });
    const second = insight("insight_second_fact", [source], {
      toneLabels: ["firm"],
      interactionLabels: ["decision_moment"],
      summary: "A separate boundary was agreed for schedule changes."
    });

    const selected = selectRelationshipContext({ segments: [source], audioInsights: [first, second] });

    expect(selected.audioInsights.map((entry) => entry.id)).toEqual([
      "insight_first_fact",
      "insight_second_fact"
    ]);
    expect(selected.audit.removedReasonCounts.duplicate_source_overlap).toBe(0);
  });

  it("keeps a cross-chunk insight when at least one source belongs to the current chunk", () => {
    const current = segment("seg_current", 0, { valueLabels: ["commitment"] });
    const adjacent = segment("seg_adjacent", 20, { valueLabels: ["commitment"] });
    const crossChunk = insight("insight_cross_chunk", [current, adjacent], {
      interactionLabels: ["decision_moment"],
      summary: "The agreement continues across the analysis chunk boundary."
    });

    const selected = selectRelationshipContext({ segments: [current], audioInsights: [crossChunk] });

    expect(selected.audioInsights.map((entry) => entry.id)).toEqual(["insight_cross_chunk"]);
    expect(selected.audit.removedReasonCounts.invalid_source_refs).toBe(0);
  });

  it("uses structured fields instead of fixture-specific text keywords", () => {
    const source = segment("seg_opaque", 0, {
      text: "Object alpha changed state after marker beta.",
      valueLabels: ["commitment"]
    });
    const structuredSignal = insight("insight_opaque", [source], {
      interactionLabels: ["decision_moment"],
      atmosphereLabels: ["collaborative"],
      summary: "Object gamma will transition before marker delta.",
      evidence: "Opaque evidence marker epsilon."
    });

    const selected = selectRelationshipContext({ segments: [source], audioInsights: [structuredSignal] });

    expect(selected.audioInsights.map((entry) => entry.id)).toEqual(["insight_opaque"]);
  });

  it("does not truncate, rewrite, or reorder transcript segments", () => {
    const segments = Array.from({ length: 18 }, (_, index) =>
      segment(`seg_${index}`, index, {
        text: `Exact evidence text ${index}: ${"content ".repeat(40)}end-${index}`
      })
    );
    const snapshot = structuredClone(segments);

    const selected = selectRelationshipContext({
      segments,
      audioInsights: [
        insight("insight_relevant", [segments[7]], {
          toneLabels: ["comforting"],
          emotionLabels: ["anxious"],
          interactionLabels: ["follow_up_question"]
        })
      ]
    });

    expect(selected.segments).toEqual(snapshot);
    expect(selected.segments.map((entry) => entry.id)).toEqual(segments.map((entry) => entry.id));
    expect(selected.segments.map((entry) => entry.text)).toEqual(segments.map((entry) => entry.text));
  });

  it("audits before/after counts and compresses high-load insight characters by at least 30 percent", () => {
    const highValueSources = [
      segment("seg_plan", 0, { valueLabels: ["commitment"] }),
      segment("seg_boundary", 1, { valueLabels: ["risk"] })
    ];
    const lowValueSources = Array.from({ length: 8 }, (_, index) =>
      segment(`seg_low_${index}`, index + 2, { sceneLabels: ["low_value_chatter"] })
    );
    const retained = [
      insight("insight_plan", [highValueSources[0]], {
        interactionLabels: ["decision_moment"],
        atmosphereLabels: ["collaborative"],
        summary: "Structured plan marker. ".repeat(12)
      }),
      insight("insight_boundary", [highValueSources[1]], {
        toneLabels: ["firm"],
        emotionLabels: ["tense"],
        interactionLabels: ["disagreement"],
        atmosphereLabels: ["conflicted"],
        summary: "Structured boundary marker. ".repeat(12)
      })
    ];
    const duplicates = Array.from({ length: 4 }, (_, index) =>
      insight(`insight_duplicate_${index}`, [highValueSources[index % 2]], {
        toneLabels: index % 2 === 0 ? ["explaining"] : ["firm"],
        emotionLabels: index % 2 === 0 ? ["neutral"] : ["tense"],
        interactionLabels: index % 2 === 0 ? ["decision_moment"] : ["disagreement"],
        atmosphereLabels: index % 2 === 0 ? ["collaborative"] : ["conflicted"],
        summary: `Repeated structured observation ${index}. `.repeat(14),
        confidence: 0.6
      })
    );
    const generic = lowValueSources.map((source, index) =>
      insight(`insight_generic_${index}`, [source], {
        toneLabels: ["playful"],
        emotionLabels: ["happy"],
        interactionLabels: ["agreement"],
        atmosphereLabels: ["playful"],
        summary: `Generic scene observation ${index}. `.repeat(14),
        evidence: `Verbose recoverable source text ${index}. `.repeat(18)
      })
    );
    const audioInsights = [...retained, ...duplicates, ...generic];

    const selected = selectRelationshipContext({
      segments: [...highValueSources, ...lowValueSources],
      audioInsights
    });

    expect(selected.audit.insightsBefore).toBe(audioInsights.length);
    expect(selected.audit.insightsAfter).toBe(selected.audioInsights.length);
    expect(selected.audit.insightCharsBefore).toBeGreaterThan(0);
    expect(selected.audit.insightCharsAfter).toBeGreaterThan(0);
    expect(selected.audit.insightCharsAfter).toBeLessThanOrEqual(selected.audit.insightCharsBefore * 0.7);
    expect(Object.values(selected.audit.removedReasonCounts).reduce((sum, count) => sum + count, 0)).toBe(
      selected.audit.insightsBefore - selected.audit.insightsAfter
    );
    expect(selected.audioInsights.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(["insight_plan", "insight_boundary"])
    );
  });
});
