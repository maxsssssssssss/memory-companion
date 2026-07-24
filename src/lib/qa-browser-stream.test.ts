import { describe, expect, it } from "vitest";

import {
  QaBrowserStreamEventSchema,
  encodeQaBrowserStreamEvent
} from "./qa-browser-stream";

const answer = {
  id: "answer_1",
  uploadId: "upload_1",
  question: "今天发生了什么？",
  answer: "今天确认了安排。[E1]",
  citedSegmentIds: ["segment_1"],
  citations: [{
    id: "E1",
    title: "安排确认",
    startSeconds: 1,
    endSeconds: 2,
    excerpt: "已经确认",
    sourceSegmentIds: ["segment_1"]
  }],
  createdAt: "2026-07-23T00:00:00.000Z"
};

describe("QaBrowserStreamEventSchema", () => {
  it("accepts only grounded sentence projections and validated final answers", () => {
    expect(QaBrowserStreamEventSchema.parse({
      type: "sentence",
      sequence: 1,
      text: "今天确认了安排。",
      supportIds: ["segment_1"],
      citedSegmentIds: ["segment_1"],
      groundingValidated: true
    })).toMatchObject({ type: "sentence", groundingValidated: true });

    expect(QaBrowserStreamEventSchema.parse({
      type: "final",
      answer,
      source: "provider_stream"
    })).toMatchObject({ type: "final", answer: { id: "answer_1" } });
  });

  it("rejects raw token events and ungrounded sentences", () => {
    expect(QaBrowserStreamEventSchema.safeParse({
      type: "token",
      quarantinedText: "raw provider delta"
    }).success).toBe(false);

    expect(QaBrowserStreamEventSchema.safeParse({
      type: "sentence",
      sequence: 1,
      text: "没有经过验证。",
      supportIds: ["segment_1"],
      citedSegmentIds: ["segment_1"],
      groundingValidated: false
    }).success).toBe(false);
  });

  it("rejects missing, duplicate, or mismatched canonical support IDs", () => {
    for (const event of [
      {
        type: "sentence",
        sequence: 1,
        text: "没有支持。",
        supportIds: [],
        citedSegmentIds: [],
        groundingValidated: true
      },
      {
        type: "sentence",
        sequence: 1,
        text: "重复支持。",
        supportIds: ["segment_1", "segment_1"],
        citedSegmentIds: ["segment_1"],
        groundingValidated: true
      },
      {
        type: "sentence",
        sequence: 1,
        text: "支持不一致。",
        supportIds: ["segment_1"],
        citedSegmentIds: ["segment_2"],
        groundingValidated: true
      }
    ]) {
      expect(QaBrowserStreamEventSchema.safeParse(event).success).toBe(false);
    }
  });

  it("encodes one validated NDJSON frame without exposing provider deltas", () => {
    const frame = encodeQaBrowserStreamEvent({
      type: "sentence",
      sequence: 1,
      text: "今天确认了安排。",
      supportIds: ["segment_1"],
      citedSegmentIds: ["segment_1"],
      groundingValidated: true
    });
    const decoded = new TextDecoder().decode(frame);

    expect(decoded.endsWith("\n")).toBe(true);
    expect(JSON.parse(decoded)).toMatchObject({
      type: "sentence",
      sequence: 1,
      groundingValidated: true
    });
    expect(decoded).not.toContain("quarantinedText");
  });
});
