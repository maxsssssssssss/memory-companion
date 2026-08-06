import { writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import type { TranscriptSegment } from "@/lib/domain/types";

import { buildParticipantAudioSamples, participantAudioFfmpegArgs } from "./participant-audio";

function segment(input: {
  id: string;
  speaker?: string;
  startSeconds: number;
  endSeconds: number;
}): TranscriptSegment {
  return {
    id: input.id,
    uploadId: "upload_1",
    startSeconds: input.startSeconds,
    endSeconds: input.endSeconds,
    ...(input.speaker ? { speaker: input.speaker } : {}),
    text: "只用于测试范围选择",
    confidence: 0.9,
    sceneLabels: [],
    valueLabels: []
  };
}

describe("date companion participant audio", () => {
  it("uses one fast-seek input per short range instead of scanning the full recording", () => {
    const args = participantAudioFfmpegArgs({
      sourceFilePath: "C:/safe/45-minutes.wav",
      outputFilePath: "C:/temp/sample.mp3",
      ranges: [
        { startMilliseconds: 60_000, endMilliseconds: 64_000 },
        { startMilliseconds: 2_400_000, endMilliseconds: 2_405_000 }
      ]
    });

    expect(args.filter((argument) => argument === "-i")).toHaveLength(2);
    expect(args).toEqual(expect.arrayContaining([
      "-ss", "60.000", "-t", "4.000",
      "-ss", "2400.000", "-t", "5.000"
    ]));
    expect(args.join(" ")).not.toContain("atrim");
    expect(args[args.indexOf("-i") - 4]).toBe("-ss");
    expect(args[args.lastIndexOf("-i") - 4]).toBe("-ss");
  });

  it("creates one bounded audio snapshot per diarized speaker", async () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const runFfmpeg = vi.fn(async ({ outputFilePath }: {
      outputFilePath: string;
      ranges: Array<unknown>;
    }) => {
      await writeFile(outputFilePath, new Uint8Array([1, 2, 3]));
    });

    const samples = await buildParticipantAudioSamples({
      uploadId: "upload_1",
      sourceFilePath: "C:/safe/upload.wav",
      segments: [
        segment({ id: "self_1", speaker: "speaker_0", startSeconds: 0, endSeconds: 8 }),
        segment({ id: "self_2", speaker: "speaker_0", startSeconds: 10, endSeconds: 16 }),
        segment({ id: "companion_1", speaker: "speaker_1", startSeconds: 20, endSeconds: 27 })
      ],
      runFfmpeg
    });

    expect(samples.map((sample) => sample.speakerId)).toEqual([
      "local_speaker_0",
      "local_speaker_1"
    ]);
    expect(samples.every((sample) => sample.mimeType === "audio/mpeg")).toBe(true);
    expect(samples.every((sample) => sample.durationMilliseconds > 0)).toBe(true);
    expect(samples.every((sample) => sample.audio.byteLength === 3)).toBe(true);
    expect(runFfmpeg).toHaveBeenCalledTimes(2);
    expect(consoleInfo).toHaveBeenCalledWith("[date-companion-audio] progress upload_id=upload_1 completed=0 total=2");
    expect(consoleInfo).toHaveBeenCalledWith("[date-companion-audio] progress upload_id=upload_1 completed=2 total=2");
    consoleInfo.mockRestore();
  });

  it("does not invent an audio owner for speaker-less or too-short segments", async () => {
    const runFfmpeg = vi.fn();
    await expect(buildParticipantAudioSamples({
      uploadId: "upload_1",
      sourceFilePath: "C:/safe/upload.wav",
      segments: [
        segment({ id: "unknown", startSeconds: 0, endSeconds: 4 }),
        segment({ id: "short", speaker: "speaker_0", startSeconds: 5, endSeconds: 5.2 })
      ],
      runFfmpeg
    })).resolves.toEqual([]);
    expect(runFfmpeg).not.toHaveBeenCalled();
  });

  it("applies the reviewed participant grouping before the 16-sample limit", async () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const runFfmpeg = vi.fn(async ({ outputFilePath }: {
      outputFilePath: string;
      ranges: Array<unknown>;
    }) => {
      await writeFile(outputFilePath, new Uint8Array([1, 2, 3]));
    });
    const segments = Array.from({ length: 20 }, (_, index) => segment({
      id: `segment_${index}`,
      speaker: `raw_${index}`,
      startSeconds: index * 5,
      endSeconds: index * 5 + 4
    }));

    const samples = await buildParticipantAudioSamples({
      uploadId: "upload_1",
      sourceFilePath: "C:/safe/upload.wav",
      segments,
      selectionGroupKey: (item) => Number(item.id.split("_").at(-1)) % 2 === 0
        ? "review_self"
        : "review_companion",
      runFfmpeg
    });

    expect(samples.map((sample) => sample.speakerId)).toEqual([
      "local_raw_0",
      "local_raw_1"
    ]);
    expect(runFfmpeg).toHaveBeenCalledTimes(2);
    expect(runFfmpeg.mock.calls.every(([input]) => input.ranges.length === 1)).toBe(true);
    consoleInfo.mockRestore();
  });
});
