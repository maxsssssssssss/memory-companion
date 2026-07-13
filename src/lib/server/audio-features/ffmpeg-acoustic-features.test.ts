import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn()
}));

vi.mock("child_process", () => ({
  default: {
    execFile: execFileMock
  },
  execFile: execFileMock
}));

import type { TranscriptSegment } from "@/lib/domain/types";

import { extractFfmpegAcousticFeatures } from "./ffmpeg-acoustic-features";

const segments: TranscriptSegment[] = [
  {
    id: "seg_1",
    uploadId: "upload_1",
    startSeconds: 0,
    endSeconds: 10,
    speaker: "speaker_1",
    text: "第一段",
    confidence: 0.9,
    sceneLabels: ["unknown"],
    valueLabels: []
  },
  {
    id: "seg_2",
    uploadId: "upload_1",
    startSeconds: 8,
    endSeconds: 20,
    speaker: "speaker_2",
    text: "第二段",
    confidence: 0.9,
    sceneLabels: ["unknown"],
    valueLabels: []
  }
];

describe("extractFfmpegAcousticFeatures", () => {
  const originalFfmpegPath = process.env.FFMPEG_PATH;

  beforeEach(() => {
    process.env.FFMPEG_PATH = "ffmpeg";
  });

  afterEach(() => {
    if (originalFfmpegPath === undefined) {
      delete process.env.FFMPEG_PATH;
    } else {
      process.env.FFMPEG_PATH = originalFfmpegPath;
    }
  });

  it("extracts waveform volume, pause ratio, and diarized overlap signals", async () => {
    const rmsLines = Array.from({ length: 20 }, (_item, index) =>
      [
        `[Parsed_ametadata_3 @ 0x1] frame:${index}    pts:${index * 16000}       pts_time:${index}`,
        `[Parsed_ametadata_3 @ 0x1] lavfi.astats.Overall.RMS_level=${index < 8 ? "-16.0" : "-28.0"}`
      ].join("\n")
    );
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        callback(
          null,
          "",
          [
            "[silencedetect @ 0x1] silence_start: 2",
            "[silencedetect @ 0x1] silence_end: 4 | silence_duration: 2",
            "[silencedetect @ 0x1] silence_start: 12",
            "[silencedetect @ 0x1] silence_end: 18 | silence_duration: 6",
            ...rmsLines
          ].join("\n")
        );
      }
    );

    const features = await extractFfmpegAcousticFeatures({
      filePath: "/tmp/demo.mp3",
      segments
    });

    expect(execFileMock).toHaveBeenCalledWith("ffmpeg", expect.arrayContaining(["-af", "silencedetect=n=-35dB:d=0.4,aresample=16000,asetnsamples=n=16000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level"]), expect.any(Object), expect.any(Function));
    expect(features).toEqual([
      expect.objectContaining({
        segmentId: "seg_1",
        volume: "high",
        pause: "normal",
        overlap: true,
        confidence: 0.72,
        explanations: expect.arrayContaining([
          expect.objectContaining({ kind: "volume", label: "音量更高" }),
          expect.objectContaining({ kind: "pause", label: "停顿正常" }),
          expect.objectContaining({ kind: "overlap", label: "多人重叠" })
        ])
      }),
      expect.objectContaining({
        segmentId: "seg_2",
        volume: "normal",
        pause: "many",
        overlap: true,
        confidence: 0.72,
        explanations: expect.arrayContaining([
          expect.objectContaining({ kind: "volume", label: "音量正常" }),
          expect.objectContaining({ kind: "pause", label: "停顿变多" }),
          expect.objectContaining({ kind: "overlap", label: "多人重叠" })
        ])
      })
    ]);
  });
});
