import { afterEach, describe, expect, it, vi } from "vitest";

import type { TranscriptSegment } from "@/lib/domain/types";

import { getEmotionSignalProvider } from "./provider";

const segments: TranscriptSegment[] = [
  {
    id: "seg_1",
    uploadId: "upload_1",
    startSeconds: 0,
    endSeconds: 30,
    speaker: "speaker_1",
    text: "预算是不是还有风险？",
    confidence: 0.9,
    sceneLabels: ["unknown"],
    valueLabels: ["risk", "open_question"]
  }
];

describe("emotion signal provider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses no-op provider by default", async () => {
    vi.unstubAllEnvs();

    const provider = getEmotionSignalProvider();
    const result = await provider.analyze({
      uploadId: "upload_1",
      segments,
      filePath: "/tmp/demo.mp3",
      mimeType: "audio/mpeg"
    });

    expect(result).toEqual([]);
  });

  it("uses rule provider when explicitly configured", async () => {
    vi.stubEnv("EMOTION_SIGNAL_PROVIDER", "rule");

    const provider = getEmotionSignalProvider();
    const result = await provider.analyze({
      uploadId: "upload_1",
      segments,
      filePath: "/tmp/demo.mp3",
      mimeType: "audio/mpeg"
    });

    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ normalizedLabel: "tense", source: "fusion" })
      ])
    );
  });

  it("rejects unknown providers", () => {
    vi.stubEnv("EMOTION_SIGNAL_PROVIDER", "unknown");

    expect(() => getEmotionSignalProvider()).toThrow("Unknown emotion signal provider");
  });
});
