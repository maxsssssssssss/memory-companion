import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TranscriptChunkSchema,
  type TranscriptChunk
} from "@/lib/domain/chunks";
import type { TranscriptSegment } from "@/lib/domain/types";
import { getFfmpegExecutable, getFfprobeExecutable } from "@/lib/server/ffmpeg";
import { JsonStore } from "@/lib/server/storage/json-store";

import {
  VoiceprintTrainingCandidateRepository,
  deleteVoiceprintTrainingCandidatesForUpload,
  generateVoiceprintTrainingCandidates,
  runVoiceprintCandidateFfmpeg,
  voiceprintTrainingCandidateLimits
} from "./voiceprint-training-candidates";

const execFileAsync = promisify(execFile);
let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function segment(input: {
  id: string;
  uploadId?: string;
  start: number;
  end: number;
  speaker: string;
  text?: string;
}): TranscriptSegment {
  return {
    id: input.id,
    uploadId: input.uploadId ?? "upload_1",
    startSeconds: input.start,
    endSeconds: input.end,
    speaker: input.speaker,
    text: input.text ?? `text ${input.id}`,
    confidence: 0.9,
    sceneLabels: ["unknown"],
    valueLabels: []
  };
}

function chunk(input: {
  id: string;
  index: number;
  start: number;
  end: number;
  segments: TranscriptSegment[];
}): TranscriptChunk {
  return TranscriptChunkSchema.parse({
    id: input.id,
    uploadId: "upload_1",
    audioChunkId: `audio_${input.index}`,
    index: input.index,
    startSeconds: input.start,
    endSeconds: input.end,
    timebase: "upload_global",
    speakerIdScope: "chunk",
    speakerMap: Object.fromEntries(
      [...new Set(input.segments.flatMap((item) => item.speaker ? [item.speaker] : []))]
        .map((speaker) => [speaker, speaker])
    ),
    segments: input.segments,
    status: "completed",
    retryCount: 0,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:01.000Z",
    startedAt: "2026-07-29T00:00:00.000Z",
    finishedAt: "2026-07-29T00:00:01.000Z",
    metadata: {}
  });
}

async function testContext() {
  tempDir = await mkdtemp(join(tmpdir(), "voiceprint-candidates-"));
  const uploadsRootDir = join(tempDir, "uploads");
  const sourceFilePath = join(uploadsRootDir, "source.wav");
  const store = new JsonStore(join(tempDir, "store"));
  await mkdir(uploadsRootDir, { recursive: true });
  await writeFile(sourceFilePath, "source");
  const runFfmpeg = vi.fn(async ({ outputFilePath }: { outputFilePath: string }) => {
    await writeFile(outputFilePath, "compact-mp3");
  });
  return { store, uploadsRootDir, sourceFilePath, runFfmpeg };
}

describe("voiceprint training candidates", () => {
  it("keeps identical speaker labels isolated by chunk", async () => {
    const context = await testContext();
    const chunks = [
      chunk({
        id: "chunk_0",
        index: 0,
        start: 0,
        end: 65,
        segments: [
          segment({ id: "seg_0_1", start: 0, end: 31, speaker: "speaker_1" }),
          segment({ id: "seg_0_2", start: 31, end: 62, speaker: "speaker_1" })
        ]
      }),
      chunk({
        id: "chunk_1",
        index: 1,
        start: 65,
        end: 135,
        segments: [
          segment({ id: "seg_1_1", start: 70, end: 101, speaker: "speaker_1" }),
          segment({ id: "seg_1_2", start: 101, end: 132, speaker: "speaker_1" })
        ]
      })
    ];
    const candidates = await generateVoiceprintTrainingCandidates({
      ...context,
      uploadId: "upload_1",
      chunks,
      now: () => "2026-07-29T00:00:00.000Z"
    });

    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((candidate) => candidate.candidateKey)).size).toBe(2);
    expect(candidates.map((candidate) => candidate.candidateKey)).toEqual([
      "chunk_0::speaker_1",
      "chunk_1::speaker_1"
    ]);
    expect(context.runFfmpeg).toHaveBeenCalledTimes(2);
  });

  it("excludes overlap and empty segments before enforcing the 30 second gate", async () => {
    const context = await testContext();
    const candidates = await generateVoiceprintTrainingCandidates({
      ...context,
      uploadId: "upload_1",
      chunks: [
        chunk({
          id: "chunk_0",
          index: 0,
          start: 0,
          end: 60,
          segments: [
            segment({ id: "overlap_target", start: 0, end: 20, speaker: "speaker_1" }),
            segment({ id: "overlap_other", start: 5, end: 10, speaker: "speaker_2" }),
            segment({ id: "empty", start: 20, end: 30, speaker: "speaker_1", text: " " }),
            segment({ id: "clean", start: 20, end: 55, speaker: "speaker_1" })
          ]
        })
      ],
      now: () => "2026-07-29T00:00:00.000Z"
    });
    const speakerOne = candidates.find((candidate) => candidate.localSpeaker === "speaker_1");

    expect(speakerOne).toMatchObject({
      status: "available",
      segmentIds: ["clean"],
      durationMilliseconds: 34_800
    });
    expect(speakerOne?.sourceRanges).toEqual([
      { startMilliseconds: 20_100, endMilliseconds: 54_900 }
    ]);
  });

  it("stops near the 90 second target and never exceeds hard limits", async () => {
    const context = await testContext();
    const segments = Array.from({ length: 20 }, (_, index) =>
      segment({
        id: `seg_${index}`,
        start: index * 15,
        end: index * 15 + 15,
        speaker: "speaker_1"
      })
    );
    const [candidate] = await generateVoiceprintTrainingCandidates({
      ...context,
      uploadId: "upload_1",
      chunks: [
        chunk({
          id: "chunk_0",
          index: 0,
          start: 0,
          end: 305,
          segments
        })
      ]
    });

    expect(candidate.durationMilliseconds).toBeGreaterThanOrEqual(
      voiceprintTrainingCandidateLimits.targetMilliseconds
    );
    expect(candidate.durationMilliseconds).toBeLessThanOrEqual(
      voiceprintTrainingCandidateLimits.maximumMilliseconds
    );
    expect(candidate.segmentIds.length).toBeLessThanOrEqual(
      voiceprintTrainingCandidateLimits.maximumSegments
    );
  });

  it("records audio generation failure without throwing", async () => {
    const context = await testContext();
    const candidates = await generateVoiceprintTrainingCandidates({
      ...context,
      uploadId: "upload_1",
      chunks: [
        chunk({
          id: "chunk_0",
          index: 0,
          start: 0,
          end: 40,
          segments: [
            segment({ id: "seg_1", start: 0, end: 35, speaker: "speaker_1" })
          ]
        })
      ],
      runFfmpeg: async () => {
        throw new Error("ffmpeg unavailable");
      }
    });

    expect(candidates[0]).toMatchObject({
      status: "failed",
      failureReason: "audio_generation_failed",
      audioFilePath: null
    });
  });

  it("blocks known contacts and conflict resolutions from Train", async () => {
    const context = await testContext();
    const contactSegment = segment({
      id: "seg_contact",
      start: 0,
      end: 35,
      speaker: "Alice"
    });
    const conflictSegment = segment({
      id: "seg_conflict",
      start: 40,
      end: 75,
      speaker: "speaker_1"
    });
    const candidates = await generateVoiceprintTrainingCandidates({
      ...context,
      uploadId: "upload_1",
      chunks: [
        chunk({
          id: "chunk_contact",
          index: 0,
          start: 0,
          end: 40,
          segments: [contactSegment]
        }),
        chunk({
          id: "chunk_conflict",
          index: 1,
          start: 40,
          end: 80,
          segments: [conflictSegment]
        })
      ],
      resolvedSegments: [{
        ...contactSegment,
        identity: {
          globalSpeakerId: "contact_alice",
          displayName: "Alice",
          identityType: "known_contact",
          confidence: null,
          source: "provider_speaker_result",
          evidence: {
            type: "provider_label",
            provider: "company_voiceprint",
            providerLabel: "Alice"
          }
        }
      }],
      resolutions: [{
        candidateKey: "chunk_conflict::speaker_1",
        status: "conflict",
        ownerIdentityId: null
      }]
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        localSpeaker: "Alice",
        identityState: "known_contact",
        status: "ineligible",
        audioFilePath: null
      }),
      expect.objectContaining({
        localSpeaker: "speaker_1",
        identityState: "conflict",
        status: "ineligible",
        audioFilePath: null
      })
    ]);
    expect(context.runFfmpeg).not.toHaveBeenCalled();
  });

  it("expires metadata and removes the compact file after seven days", async () => {
    const context = await testContext();
    const [candidate] = await generateVoiceprintTrainingCandidates({
      ...context,
      uploadId: "upload_1",
      chunks: [
        chunk({
          id: "chunk_0",
          index: 0,
          start: 0,
          end: 40,
          segments: [
            segment({ id: "seg_1", start: 0, end: 35, speaker: "speaker_1" })
          ]
        })
      ],
      now: () => "2026-07-01T00:00:00.000Z"
    });
    const repository = new VoiceprintTrainingCandidateRepository(
      context.store,
      () => "2026-07-09T00:00:00.000Z"
    );

    await expect(
      repository.cleanupExpired(context.uploadsRootDir)
    ).resolves.toBe(1);
    await expect(readFile(candidate.audioFilePath!, "utf8")).rejects.toThrow();
    await expect(repository.get(candidate.candidateId)).resolves.toMatchObject({
      status: "expired",
      audioFilePath: null
    });
  });

  it("removes candidate metadata and audio when its upload is deleted", async () => {
    const context = await testContext();
    const [candidate] = await generateVoiceprintTrainingCandidates({
      ...context,
      uploadId: "upload_1",
      chunks: [
        chunk({
          id: "chunk_0",
          index: 0,
          start: 0,
          end: 40,
          segments: [
            segment({ id: "seg_1", start: 0, end: 35, speaker: "speaker_1" })
          ]
        })
      ]
    });

    await expect(
      deleteVoiceprintTrainingCandidatesForUpload({
        store: context.store,
        uploadId: "upload_1",
        uploadsRootDir: context.uploadsRootDir
      })
    ).resolves.toBe(1);
    await expect(readFile(candidate.audioFilePath!, "utf8")).rejects.toThrow();
    await expect(
      new VoiceprintTrainingCandidateRepository(context.store).get(
        candidate.candidateId
      )
    ).resolves.toBeNull();
  });

  it("emits 16 kHz mono 32 kbps MP3 audio", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "voiceprint-candidate-ffmpeg-"));
    const sourceFilePath = join(tempDir, "source.wav");
    const outputFilePath = join(tempDir, "candidate.mp3");
    await execFileAsync(getFfmpegExecutable(), [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=16000",
      "-t",
      "2",
      sourceFilePath
    ]);
    await runVoiceprintCandidateFfmpeg({
      sourceFilePath,
      outputFilePath,
      ranges: [{ startMilliseconds: 100, endMilliseconds: 1_900 }]
    });
    const { stdout } = await execFileAsync(getFfprobeExecutable(), [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_name,sample_rate,channels,bit_rate",
      "-of",
      "json",
      outputFilePath
    ]);
    const stream = JSON.parse(stdout).streams[0] as Record<string, unknown>;

    expect(stream.codec_name).toBe("mp3");
    expect(stream.sample_rate).toBe("16000");
    expect(stream.channels).toBe(1);
    expect(Number(stream.bit_rate)).toBeGreaterThanOrEqual(30_000);
    expect(Number(stream.bit_rate)).toBeLessThanOrEqual(34_000);
  });
});
