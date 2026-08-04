import { describe, expect, it } from "vitest";

import { DayPayloadSchema, parseDayPayload } from "./day-payload";

function validPayload() {
  return {
    upload: {
      id: "upload_1",
      originalName: "date.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 1024,
      recordingDate: "2026-08-04",
      createdAt: "2026-08-04T10:00:00.000Z",
      durationSeconds: 30,
      status: "processing"
    },
    job: null,
    segments: [
      {
        id: "segment_1",
        uploadId: "upload_1",
        startSeconds: 0,
        endSeconds: 3,
        speaker: "speaker_0",
        text: "我们下次可以去看展。",
        confidence: 0.94,
        sceneLabels: ["unknown"],
        valueLabels: ["notable_quote"]
      }
    ],
    audioInsights: [],
    semanticSegments: [],
    semanticSegmentsAvailable: false,
    briefItems: [],
    relationshipSignals: [],
    relationshipSignalsAvailable: false,
    proactiveInsights: [],
    proactiveInsightsAvailable: false,
    speakerAliases: {},
    speakerAliasesByUploadId: { upload_1: {} }
  };
}

describe("DayPayloadSchema", () => {
  it("parses the complete day API contract and normalizes a null job", () => {
    const parsed = parseDayPayload(validPayload());

    expect(parsed.job).toBeUndefined();
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.semanticSegmentsAvailable).toBe(false);

    const { job: _omittedJob, ...withoutJob } = validPayload();
    expect(parseDayPayload(withoutJob).job).toBeUndefined();
  });

  it("does not confuse an unfinished empty array with an available empty result", () => {
    const pending = DayPayloadSchema.parse(validPayload());
    const completedEmpty = DayPayloadSchema.parse({
      ...validPayload(),
      semanticSegmentsAvailable: true,
      relationshipSignalsAvailable: true,
      proactiveInsightsAvailable: true
    });

    expect(pending.semanticSegments).toEqual([]);
    expect(pending.semanticSegmentsAvailable).toBe(false);
    expect(completedEmpty.semanticSegments).toEqual([]);
    expect(completedEmpty.semanticSegmentsAvailable).toBe(true);
  });

  it("rejects missing availability fields and malformed nested records", () => {
    const { semanticSegmentsAvailable: _missing, ...withoutAvailability } = validPayload();
    expect(DayPayloadSchema.safeParse(withoutAvailability).success).toBe(false);

    const malformed = validPayload();
    malformed.segments[0].endSeconds = 0;
    expect(DayPayloadSchema.safeParse(malformed).success).toBe(false);
  });

  it("rejects records and jobs that belong to a different upload", () => {
    const foreignSegment = validPayload();
    foreignSegment.segments[0].uploadId = "upload_2";
    expect(DayPayloadSchema.safeParse(foreignSegment).success).toBe(false);

    const foreignJob = {
      ...validPayload(),
      job: {
        id: "job_1",
        uploadId: "upload_2",
        status: "processing",
        progress: 25
      }
    };
    expect(DayPayloadSchema.safeParse(foreignJob).success).toBe(false);
  });
});
