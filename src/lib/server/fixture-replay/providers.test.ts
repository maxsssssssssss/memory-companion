import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { buildSemanticSegments } from "@/lib/processing/semantic-segments";
import { buildFixtureTranscriptSegments, loadFixtureDataset } from "./dataset";
import {
  fixtureAudioInsightProvider,
  fixtureExtractionProvider,
  fixtureMemoryRelevanceJudge,
  fixtureRelationshipSignalProvider
} from "./providers";

const datasetPath = resolve("test-data/memory-multiday-v1");

async function sessionInput(index: number) {
  const dataset = await loadFixtureDataset(datasetPath);
  const session = dataset.manifest.sessions[index];
  const segments = await buildFixtureTranscriptSegments({ dataset, session });
  const uploadId = segments[0].uploadId;
  const audioInsights = await fixtureAudioInsightProvider.analyze(uploadId, segments);
  const semanticSegments = buildSemanticSegments(uploadId, segments);
  return { dataset, session, segments, uploadId, audioInsights, semanticSegments };
}

describe("fixture replay providers", () => {
  it("extracts Day 1 commitment and preference from real segments", async () => {
    const input = await sessionInput(0);
    const items = await fixtureExtractionProvider.extract(input.uploadId, input.segments);

    expect(items.map((item) => item.category)).toEqual(expect.arrayContaining(["commitment", "notable_quote"]));
    expect(items.every((item) => input.segments.some((segment) => segment.id === item.sourceSegmentIds[0] && segment.text === item.transcriptExcerpt))).toBe(true);
  });

  it("routes relationship candidates through final evidence normalization", async () => {
    const input = await sessionInput(0);
    const cards = await fixtureRelationshipSignalProvider.analyze({
      uploadId: input.uploadId,
      recordingDate: input.session.date,
      segments: input.segments,
      audioInsights: input.audioInsights,
      semanticSegments: input.semanticSegments
    });

    expect(cards.map((card) => card.signalType)).toEqual(expect.arrayContaining(["active_listening", "clear_commitment"]));
    expect(cards.every((card) => card.evidenceSegments.every((evidence) => input.segments.some((segment) => segment.id === evidence.segmentId && segment.text === evidence.text)))).toBe(true);
  });

  it("keeps counter evidence on the Day 3 uncertain signal", async () => {
    const input = await sessionInput(2);
    const cards = await fixtureRelationshipSignalProvider.analyze({
      uploadId: input.uploadId,
      recordingDate: input.session.date,
      segments: input.segments,
      audioInsights: input.audioInsights,
      semanticSegments: input.semanticSegments
    });
    const evasive = cards.find((card) => card.signalType === "evasive_answer");

    expect(evasive?.signalCategory).toBe("uncertain");
    expect(evasive?.caution).toBeTruthy();
    expect(evasive?.counterEvidence?.[0]).toContain("回答太含糊");
  });

  it("rejects unrelated memories in the deterministic relevance judge", async () => {
    const result = await fixtureMemoryRelevanceJudge.judge({
      current: {
        referenceDate: "2026-07-12",
        topics: ["博物馆计划完成"],
        briefItems: [],
        semanticSummaries: [],
        relationshipSignals: []
      },
      candidates: [
        {
          memoryId: "museum",
          memoryRef: "memory:museum",
          type: "event",
          summary: "博物馆计划",
          dates: ["2026-07-01"],
          importanceScore: 0.8,
          status: "active",
          occurrenceCount: 1,
          evidenceSummaries: ["讨论博物馆"]
        },
        {
          memoryId: "coffee",
          memoryRef: "memory:coffee",
          type: "preference",
          summary: "咖啡偏好",
          dates: ["2026-06-29"],
          importanceScore: 0.8,
          status: "active",
          occurrenceCount: 1,
          evidenceSummaries: ["无糖拿铁"]
        }
      ]
    });

    expect(result.rawResults).toEqual([
      expect.objectContaining({ memoryId: "museum", shouldUse: true }),
      expect.objectContaining({ memoryId: "coffee", shouldUse: false })
    ]);
  });

  it("contains no HTTP or remote model client in the fixture provider bundle", async () => {
    const source = await readFile(resolve("src/lib/server/fixture-replay/providers.ts"), "utf8");

    expect(source).not.toMatch(/\bfetch\s*\(|https?:\/\/|createOpenAIClient|createDeepSeekClient/u);
  });
});
