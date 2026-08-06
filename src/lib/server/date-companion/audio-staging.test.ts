import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TranscriptSegment } from "@/lib/domain/types";
import { JsonStore } from "@/lib/server/storage/json-store";

import {
  DATE_COMPANION_AUDIO_STAGING_COLLECTION,
  cleanupExpiredDateCompanionAudioStaging,
  dateCompanionAudioStagingLimits,
  deleteDateCompanionAudioStaging,
  participantAudioSamplesFromStaging,
  readDateCompanionAudioStaging,
  stageDateCompanionParticipantAudio
} from "./audio-staging";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

function segment(): TranscriptSegment {
  return {
    id: "segment_1",
    uploadId: "upload_1",
    startSeconds: 1,
    endSeconds: 5,
    speaker: "speaker_1",
    text: "仅用于音频快照测试",
    confidence: 0.9,
    sceneLabels: [],
    valueLabels: []
  };
}

describe("date companion participant audio staging", () => {
  it("stores bounded base64 audio with user ownership and source ranges", async () => {
    const root = await mkdtemp(join(tmpdir(), "date-companion-audio-stage-"));
    roots.push(root);
    const store = new JsonStore(root);
    const buildAudioSamples = vi.fn(async () => [{
      speakerId: "speaker_1",
      mimeType: "audio/mpeg" as const,
      durationMilliseconds: 3_800,
      audio: new Uint8Array([1, 2, 3]),
      sourceRanges: [{ startMilliseconds: 1_100, endMilliseconds: 4_900 }]
    }]);

    const staged = await stageDateCompanionParticipantAudio({
      store,
      uploadId: "upload_1",
      userId: "user_1",
      sourceFilePath: join(root, "upload.wav"),
      segments: [segment()],
      buildAudioSamples,
      now: () => "2026-08-04T00:00:00.000Z"
    });

    expect(staged).toMatchObject({
      version: 1,
      uploadId: "upload_1",
      userId: "user_1",
      expiresAt: "2026-08-05T00:00:00.000Z",
      status: "ready",
      samples: [{
        speakerId: "speaker_1",
        audioBase64: "AQID",
        sourceRanges: [{ startMilliseconds: 1_100, endMilliseconds: 4_900 }]
      }]
    });
    expect(participantAudioSamplesFromStaging(staged)).toEqual([{
      speakerId: "speaker_1",
      mimeType: "audio/mpeg",
      durationMilliseconds: 3_800,
      audio: new Uint8Array([1, 2, 3])
    }]);

    await stageDateCompanionParticipantAudio({
      store,
      uploadId: "upload_1",
      userId: "user_1",
      sourceFilePath: join(root, "missing-after-first-stage.wav"),
      segments: [segment()],
      buildAudioSamples,
      now: () => "2026-08-04T01:00:00.000Z"
    });
    expect(buildAudioSamples).toHaveBeenCalledTimes(1);
  });

  it("writes an explicit not_applicable marker when no speaker range is eligible", async () => {
    const root = await mkdtemp(join(tmpdir(), "date-companion-audio-none-"));
    roots.push(root);
    const store = new JsonStore(root);

    const staged = await stageDateCompanionParticipantAudio({
      store,
      uploadId: "upload_1",
      userId: "user_1",
      sourceFilePath: join(root, "upload.wav"),
      segments: [],
      buildAudioSamples: vi.fn(async () => []),
      now: () => "2026-08-04T00:00:00.000Z"
    });

    expect(staged).toEqual({
      version: 1,
      uploadId: "upload_1",
      userId: "user_1",
      createdAt: "2026-08-04T00:00:00.000Z",
      expiresAt: "2026-08-05T00:00:00.000Z",
      status: "not_applicable",
      reason: "no_eligible_speaker_ranges"
    });
    expect(participantAudioSamplesFromStaging(staged)).toEqual([]);
  });

  it("rejects a staging document owned by another authenticated user", async () => {
    const root = await mkdtemp(join(tmpdir(), "date-companion-audio-owner-"));
    roots.push(root);
    const store = new JsonStore(root);
    await store.write(DATE_COMPANION_AUDIO_STAGING_COLLECTION, "upload_1", {
      version: 1,
      uploadId: "upload_1",
      userId: "user_other",
      createdAt: "2026-08-04T00:00:00.000Z",
      status: "not_applicable",
      reason: "no_eligible_speaker_ranges"
    });

    await expect(readDateCompanionAudioStaging({
      store,
      uploadId: "upload_1",
      userId: "user_1"
    })).rejects.toMatchObject({
      code: "date_companion_audio_staging_owner_mismatch"
    });
  });

  it("removes staging only when the caller reaches upload cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "date-companion-audio-delete-"));
    roots.push(root);
    const store = new JsonStore(root);
    await store.write(DATE_COMPANION_AUDIO_STAGING_COLLECTION, "upload_1", {
      version: 1,
      uploadId: "upload_1",
      userId: "user_1",
      createdAt: "2026-08-04T00:00:00.000Z",
      status: "not_applicable",
      reason: "no_eligible_speaker_ranges"
    });

    await deleteDateCompanionAudioStaging(store, "upload_1");
    await expect(store.read(
      DATE_COMPANION_AUDIO_STAGING_COLLECTION,
      "upload_1"
    )).resolves.toBeNull();
  });

  it("treats legacy and current staging documents as expired after 24 hours", async () => {
    const root = await mkdtemp(join(tmpdir(), "date-companion-audio-expiry-"));
    roots.push(root);
    const store = new JsonStore(root);
    await store.write(DATE_COMPANION_AUDIO_STAGING_COLLECTION, "legacy", {
      version: 1,
      uploadId: "legacy",
      userId: "user_1",
      createdAt: "2026-08-04T00:00:00.000Z",
      status: "not_applicable",
      reason: "no_eligible_speaker_ranges"
    });
    await store.write(DATE_COMPANION_AUDIO_STAGING_COLLECTION, "current", {
      version: 1,
      uploadId: "current",
      userId: "user_1",
      createdAt: "2026-08-04T12:00:00.000Z",
      expiresAt: "2026-08-04T13:00:00.000Z",
      status: "not_applicable",
      reason: "no_eligible_speaker_ranges"
    });
    await store.write(DATE_COMPANION_AUDIO_STAGING_COLLECTION, "corrupt", {
      version: 1,
      audioBase64: "sensitive-but-invalid"
    });

    await expect(readDateCompanionAudioStaging({
      store,
      uploadId: "legacy",
      userId: "user_1",
      now: () => "2026-08-05T00:00:00.000Z"
    })).resolves.toBeNull();
    await expect(store.read(
      DATE_COMPANION_AUDIO_STAGING_COLLECTION,
      "legacy"
    )).resolves.toBeNull();
    await expect(cleanupExpiredDateCompanionAudioStaging({
      store,
      now: () => "2026-08-05T00:00:00.000Z"
    })).resolves.toBe(2);
    await expect(store.read(
      DATE_COMPANION_AUDIO_STAGING_COLLECTION,
      "corrupt"
    )).resolves.toBeNull();
    expect(dateCompanionAudioStagingLimits.retentionMilliseconds).toBe(86_400_000);
  });
});
