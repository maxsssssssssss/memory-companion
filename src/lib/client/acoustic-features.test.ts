import { afterEach, describe, expect, it, vi } from "vitest";

import type { TranscriptSegment } from "@/lib/domain/types";

import { extractBrowserAcousticFeatures } from "./acoustic-features";

const segments: TranscriptSegment[] = [
  {
    id: "seg_1",
    uploadId: "upload_1",
    startSeconds: 0,
    endSeconds: 1,
    speaker: "speaker_1",
    text: "第一段",
    confidence: 0.9,
    sceneLabels: ["unknown"],
    valueLabels: []
  },
  {
    id: "seg_2",
    uploadId: "upload_1",
    startSeconds: 0.99,
    endSeconds: 2,
    speaker: "speaker_2",
    text: "第二段",
    confidence: 0.9,
    sceneLabels: ["unknown"],
    valueLabels: []
  }
];

describe("extractBrowserAcousticFeatures", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("extracts real waveform volume, pause ratio, and speaker overlap in local-first mode", async () => {
    const closeMock = vi.fn();
    const samples = new Float32Array(200);
    samples.fill(0.6, 0, 100);
    samples.fill(0, 100, 150);
    samples.fill(0.05, 150, 200);

    class FakeAudioContext {
      async decodeAudioData() {
        return {
          duration: 2,
          sampleRate: 100,
          numberOfChannels: 1,
          getChannelData: () => samples
        };
      }

      close = closeMock;
    }

    vi.stubGlobal("AudioContext", FakeAudioContext);

    const features = await extractBrowserAcousticFeatures({
      bytes: new Uint8Array([1, 2, 3]),
      segments
    });

    expect(features).toEqual([
      {
        segmentId: "seg_1",
        volume: "high",
        pause: "few",
        overlap: true,
        confidence: 0.74
      },
      {
        segmentId: "seg_2",
        volume: "normal",
        pause: "many",
        overlap: true,
        confidence: 0.74
      }
    ]);
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});
