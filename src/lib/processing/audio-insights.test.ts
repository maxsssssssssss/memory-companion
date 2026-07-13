import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "@/lib/domain/types";
import { buildAudioInsights } from "./audio-insights";

function segment(overrides: Partial<TranscriptSegment>): TranscriptSegment {
  return {
    id: "seg_1",
    uploadId: "upload_1",
    startSeconds: 60,
    endSeconds: 95,
    speaker: "speaker_1",
    text: "默认转写文本",
    confidence: 0.9,
    sceneLabels: ["unknown"],
    valueLabels: [],
    ...overrides
  };
}

describe("buildAudioInsights", () => {
  it("extracts speaker tone emotion and interaction signals from transcript segments", () => {
    const insights = buildAudioInsights("upload_1", [
      segment({
        text: "我觉得这个方案可能还有风险，我们是不是需要再确认一下？",
        valueLabels: ["risk", "open_question"]
      })
    ]);

    expect(insights).toHaveLength(1);
    expect(insights[0]).toMatchObject({
      uploadId: "upload_1",
      sourceSegmentIds: ["seg_1"],
      sourceTimeRange: { startSeconds: 60, endSeconds: 95 },
      speaker: {
        id: "speaker_1",
        role: "self"
      },
      voice: {
        volume: "unknown",
        pause: "unknown",
        overlap: false
      }
    });
    expect(insights[0].toneLabels).toEqual(expect.arrayContaining(["hesitant", "questioning"]));
    expect(insights[0].emotionLabels).toContain("anxious");
    expect(insights[0].interactionLabels).toEqual(expect.arrayContaining(["follow_up_question", "tension"]));
    expect(insights[0].summary).toContain("试探");
    expect(insights[0].evidence).toContain("可能还有风险");
  });

  it("keeps audio-derived estimates conservative when only text is available", () => {
    const insights = buildAudioInsights("upload_1", [
      segment({
        id: "seg_fast",
        startSeconds: 0,
        endSeconds: 10,
        text: "这里我们必须马上确认销售方案和客户预算，不能继续拖延，否则下周交付会有明显风险。"
      })
    ]);

    expect(insights[0].voice.pace).toBe("fast");
    expect(insights[0].voice.volume).toBe("unknown");
    expect(insights[0].voice.confidence).toBeLessThan(0.5);
    expect(insights[0].toneLabels).toContain("firm");
    expect(insights[0].emotionLabels).not.toContain("happy");
  });

  it("does not mutate transcript segments", () => {
    const input = [
      segment({
        text: "这个方案可以继续推进。"
      })
    ];
    const snapshot = structuredClone(input);

    buildAudioInsights("upload_1", input);

    expect(input).toEqual(snapshot);
  });
});
