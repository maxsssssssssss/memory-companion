import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildFixtureTranscriptSegments,
  fixtureSegmentId,
  fixtureUploadId,
  loadFixtureDataset,
  resolveFixturePath
} from "./dataset";

const datasetPath = resolve("test-data/memory-multiday-v1");

describe("memory fixture dataset", () => {
  it("loads the manifest and preserves recording dates", async () => {
    const dataset = await loadFixtureDataset(datasetPath);

    expect(dataset.manifest.sessions).toHaveLength(8);
    expect(dataset.manifest.sessions[0]?.date).toBe("2026-06-29");
    expect(dataset.manifest.sessions.at(-1)?.date).toBe("2026-07-12");
  });

  it("builds stable, traceable, non-overlapping transcript segments", async () => {
    const dataset = await loadFixtureDataset(datasetPath);
    const session = dataset.manifest.sessions[0];
    const first = await buildFixtureTranscriptSegments({ dataset, session });
    const second = await buildFixtureTranscriptSegments({ dataset, session });

    expect(second).toEqual(first);
    expect(first[0]?.id).toBe(fixtureSegmentId(session.sessionId, 0));
    expect(first.every((segment) => segment.uploadId === fixtureUploadId(session.sessionId))).toBe(true);
    expect(first.every((segment, index) => index === 0 || segment.startSeconds > first[index - 1].endSeconds)).toBe(true);
    expect(first.map((segment) => segment.speaker)).toEqual(["A", "B", "A", "B", "A", "B", "A", "B", "A", "B"]);
    expect(first.map((segment) => segment.identity?.globalSpeakerId)).toEqual([
      "fixture_person_a",
      "fixture_person_b",
      "fixture_person_a",
      "fixture_person_b",
      "fixture_person_a",
      "fixture_person_b",
      "fixture_person_a",
      "fixture_person_b",
      "fixture_person_a",
      "fixture_person_b"
    ]);
    expect(first.every((segment) => segment.identity?.source === "manual_mapping")).toBe(true);
  });

  it("rejects paths outside the dataset", () => {
    expect(() => resolveFixturePath(datasetPath, "../manifest.json")).toThrow("escapes dataset root");
  });

  it("uses stable upload identifiers", () => {
    expect(fixtureUploadId("memory-v1-day-01")).toBe("fixture_memory-v1-day-01");
  });
});
