import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { TranscriptChunk } from "@/lib/domain/chunks";
import {
  createSyntheticLabelSwapFixture,
  evaluateSpeakerIdentityArtifacts,
  loadSpeakerIdentityEvaluationArtifacts,
  speakerIdentityIntegrityHashes
} from "./evaluation";

const timestamp = "2026-07-17T00:00:00.000Z";
const createdDirectories: string[] = [];

function transcriptChunk(index: number): TranscriptChunk {
  const startSeconds = index * 300;
  return {
    id: `upload_1_transcript_chunk_${String(index).padStart(5, "0")}`,
    uploadId: "upload_1",
    audioChunkId: `upload_1_audio_chunk_${String(index).padStart(5, "0")}`,
    index,
    startSeconds,
    endSeconds: startSeconds + 300,
    timebase: "upload_global",
    speakerIdScope: "chunk",
    speakerMap: { speaker_1: "speaker_1", speaker_2: "speaker_2" },
    segments: [
      {
        id: `segment_${index}_a`,
        uploadId: "upload_1",
        startSeconds: startSeconds + 1,
        endSeconds: startSeconds + 10,
        speaker: "speaker_1",
        text: `PRIVATE_TRANSCRIPT_TEXT_${index}_A`,
        confidence: 0.72,
        sceneLabels: [],
        valueLabels: []
      },
      {
        id: `segment_${index}_b`,
        uploadId: "upload_1",
        startSeconds: startSeconds + 11,
        endSeconds: startSeconds + 20,
        speaker: "speaker_2",
        text: `PRIVATE_TRANSCRIPT_TEXT_${index}_B`,
        confidence: 0.72,
        sceneLabels: [],
        valueLabels: []
      }
    ],
    status: "completed",
    retryCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    metadata: { provider: "speaker-asr" }
  };
}

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("speaker identity offline evaluation", () => {
  it("loads only the explicitly selected retained upload", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "speaker-identity-evaluation-"));
    createdDirectories.push(dataDir);
    const transcriptChunkDir = join(dataDir, "users", "user_1", "transcript-chunks");
    await mkdir(transcriptChunkDir, { recursive: true });
    await writeFile(
      join(transcriptChunkDir, "upload_1_transcript_chunk_00000.json"),
      JSON.stringify(transcriptChunk(0)),
      "utf8"
    );
    await writeFile(
      join(transcriptChunkDir, "other_upload_transcript_chunk_00000.json"),
      JSON.stringify({ ...transcriptChunk(0), id: "other", uploadId: "other_upload" }),
      "utf8"
    );

    const artifacts = await loadSpeakerIdentityEvaluationArtifacts({ dataDir, uploadId: "upload_1" });

    expect(artifacts.chunks).toHaveLength(1);
    expect(artifacts.chunks[0].uploadId).toBe("upload_1");
    expect(artifacts.userRoot).toBe(join(dataDir, "users", "user_1"));
  });

  it("keeps actual retained speakers unknown and recovers an in-memory label swap", async () => {
    const chunks = [transcriptChunk(0), transcriptChunk(1), transcriptChunk(2)];
    const artifacts = {
      dataDir: "C:/evaluation/runtime",
      userRoot: "C:/evaluation/runtime/users/user_1",
      uploadId: "upload_1",
      chunks
    };

    const report = await evaluateSpeakerIdentityArtifacts({
      artifacts,
      now: () => timestamp
    });

    expect(report.mode).toBe("offline");
    expect(report.networkCallsAllowed).toBe(false);
    expect(report.actual.summary).toMatchObject({
      chunksProcessed: 3,
      segmentCount: 6,
      localSpeakerGroups: 6,
      matched: 0,
      unknown: 6,
      conflicts: 0
    });
    expect(report.actual.assignments.every((assignment) => !assignment.matched)).toBe(true);
    expect(report.simulated.swappedChunkIndexes).toEqual([1]);
    expect(report.simulated.summary).toMatchObject({
      chunksProcessed: 3,
      localSpeakerGroups: 6,
      globalSpeakers: 2,
      matched: 4,
      unknown: 2,
      conflicts: 0
    });
    expect(report.simulated.oracle).toEqual({
      expectedAssignments: 6,
      correctAssignments: 6,
      accuracy: 1,
      falseMerges: 0,
      falseSplits: 0
    });
    expect(report.actual.integrity).toMatchObject({
      segmentIdsUnchanged: true,
      transcriptTextUnchanged: true,
      timestampsUnchanged: true,
      localSpeakersUnchanged: true
    });
    expect(report.simulated.integrity).toMatchObject({
      segmentIdsUnchanged: true,
      transcriptTextUnchanged: true,
      timestampsUnchanged: true,
      localSpeakersUnchanged: true
    });
  });

  it("reports structural hashes without transcript, audio, or matcher features", async () => {
    const chunks = [transcriptChunk(0), transcriptChunk(1)];
    const fixture = createSyntheticLabelSwapFixture(chunks);
    const report = await evaluateSpeakerIdentityArtifacts({
      artifacts: {
        dataDir: "C:/evaluation/runtime",
        userRoot: "C:/evaluation/runtime/users/user_1",
        uploadId: "upload_1",
        chunks
      },
      syntheticFixture: fixture,
      now: () => timestamp
    });
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain("PRIVATE_TRANSCRIPT_TEXT");
    expect(serialized).not.toContain("matcherFeatures");
    expect(serialized).not.toContain("audio bytes");
    expect(report.actual.integrity.before.transcriptTextSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes only the corresponding integrity digest when immutable input changes", () => {
    const before = [transcriptChunk(0)];
    const after = [
      {
        ...transcriptChunk(0),
        segments: transcriptChunk(0).segments.map((segment, index) =>
          index === 0 ? { ...segment, text: "changed" } : segment
        )
      }
    ];

    const beforeHashes = speakerIdentityIntegrityHashes(before);
    const afterHashes = speakerIdentityIntegrityHashes(after);
    expect(afterHashes.transcriptTextSha256).not.toBe(beforeHashes.transcriptTextSha256);
    expect(afterHashes.segmentIdsSha256).toBe(beforeHashes.segmentIdsSha256);
    expect(afterHashes.timestampsSha256).toBe(beforeHashes.timestampsSha256);
    expect(afterHashes.localSpeakersSha256).toBe(beforeHashes.localSpeakersSha256);
  });
});
