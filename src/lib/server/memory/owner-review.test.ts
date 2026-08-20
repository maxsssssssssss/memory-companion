// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import type { TranscriptSegment } from "@/lib/domain/types";
import { JsonStore } from "@/lib/server/storage/json-store";

import {
  generateMemoryOwnerReviewCandidates,
  isMemoryOwnerReviewAudioPath,
  MemoryOwnerReviewRepository,
  providerReviewLabels,
  type MemoryOwnerReviewDraft
} from "./owner-review";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function segment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: "segment_1",
    uploadId: "upload_1",
    startSeconds: 1,
    endSeconds: 4,
    speaker: "Alice",
    identity: {
      globalSpeakerId: "unknown_alice",
      identityType: "unknown_person",
      confidence: null,
      source: "provider_speaker_result",
      evidence: {
        type: "provider_label",
        provider: "company_voiceprint",
        providerLabel: "Alice"
      }
    },
    text: "我不喜欢香菜。",
    confidence: 0.9,
    sceneLabels: [],
    valueLabels: [],
    ...overrides
  };
}

function draft(evidenceSegments: TranscriptSegment[]): MemoryOwnerReviewDraft {
  return {
    memory: {
      id: "memory_1",
      type: "preference",
      title: "饮食偏好",
      summary: "不喜欢香菜",
      importance: 0.8,
      importanceReasons: ["test"],
      date: "2026-07-30",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
      evidence: evidenceSegments.map((item) => ({
        id: `evidence_${item.id}`,
        sourceType: "transcript",
        sourceId: item.id,
        uploadId: "upload_1",
        date: "2026-07-30",
        quote: item.text,
        createdAt: "2026-07-30T00:00:00.000Z"
      }))
    },
    evidenceSegments,
    providerLabels: ["Alice"],
    structuralGate: { status: "healthy", reasons: [] }
  };
}

describe("Memory owner review sidecar", () => {
  it("accepts only complete untrusted Provider-label evidence", () => {
    expect(providerReviewLabels([segment()])).toEqual(["Alice"]);
    expect(providerReviewLabels([
      segment(),
      segment({ id: "segment_2", speaker: "speaker_1", identity: undefined })
    ])).toEqual([]);
  });

  it("creates authenticated review audio metadata without exposing the file path", async () => {
    const root = await mkdtemp(join(tmpdir(), "daily-brief-owner-review-"));
    temporaryDirectories.push(root);
    const uploadsRootDir = join(root, "uploads");
    const sourceFilePath = join(uploadsRootDir, "source.wav");
    await mkdir(uploadsRootDir, { recursive: true });
    await writeFile(sourceFilePath, "source");
    const store = new JsonStore(join(root, "data"));
    const generated = await generateMemoryOwnerReviewCandidates({
      store,
      uploadId: "upload_1",
      sourceFilePath,
      uploadsRootDir,
      drafts: [draft([segment()])],
      ffmpegRunner: async ({ outputFilePath }) => {
        await writeFile(outputFilePath, "mp3");
      },
      now: () => "2026-07-30T00:00:00.000Z"
    });

    expect(generated).toHaveLength(1);
    expect(generated[0]).toMatchObject({
      status: "pending",
      providerLabels: ["Alice"],
      audioClips: [expect.objectContaining({ segmentId: "segment_1" })]
    });
    expect(isMemoryOwnerReviewAudioPath(
      generated[0].audioClips[0].filePath,
      uploadsRootDir
    )).toBe(true);
    expect(await new MemoryOwnerReviewRepository(store).getCandidate(
      generated[0].candidateId
    )).toEqual(generated[0]);
  });

  it("fails closed to daily-only when evidence exceeds the 120 second limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "daily-brief-owner-review-"));
    temporaryDirectories.push(root);
    const store = new JsonStore(join(root, "data"));
    const longSegment = segment({ endSeconds: 123 });
    const generated = await generateMemoryOwnerReviewCandidates({
      store,
      uploadId: "upload_1",
      sourceFilePath: join(root, "source.wav"),
      uploadsRootDir: join(root, "uploads"),
      drafts: [draft([longSegment])],
      ffmpegRunner: async () => {
        throw new Error("must not run");
      },
      now: () => "2026-07-30T00:00:00.000Z"
    });

    expect(generated[0]).toMatchObject({
      status: "daily_only",
      failureReason: "evidence_duration_limit_exceeded",
      audioClips: []
    });
  });
});
