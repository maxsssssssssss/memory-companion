// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getUserUploadsRootDir } from "@/lib/server/auth/session";
import { getDailyReflectionDatabase } from "@/lib/server/daily-reflection";
import {
  createTranscriptionAudioAccessCapability
} from "@/lib/server/transcription/audio-access-capability";
import { getWorkReviewDatabase } from "@/lib/server/work-review/db";
import { WorkReviewRepository } from "@/lib/server/work-review/repository";

import { GET } from "./[userId]/[uploadId]/route";

const originalEnv = { ...process.env };
const legacyToken = "work-review-internal-audio-token";
const capabilitySecret = "work-review-capability-secret";
const dailyReflectionCapabilitySecret = "daily-reflection-capability-secret";
let tempDir: string;
let repository: WorkReviewRepository;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "work-review-internal-audio-"));
  process.env.APP_DATA_DIR = tempDir;
  process.env.SPEAKER_ASR_AUDIO_ACCESS_TOKEN = legacyToken;
  process.env.DAILY_REFLECTION_AUDIO_CAPABILITY_SECRET = dailyReflectionCapabilitySecret;
  process.env.WORK_REVIEW_AUDIO_CAPABILITY_SECRET = capabilitySecret;
  process.env.WORK_REVIEW_ENABLED = "true";
  process.env.WORK_REVIEW_UPLOAD_ENABLED = "true";
  repository = new WorkReviewRepository(getWorkReviewDatabase(), {
    now: () => "2026-09-01T10:00:00.000Z",
    idFactory: (() => {
      let value = 0;
      return () => `internal_audio_${++value}`;
    })()
  });
});

afterEach(async () => {
  const workDatabase = getWorkReviewDatabase();
  if (workDatabase.open) workDatabase.close();
  const dailyReflectionDatabase = getDailyReflectionDatabase();
  if (dailyReflectionDatabase.open) dailyReflectionDatabase.close();
  process.env = { ...originalEnv };
  await rm(tempDir, { recursive: true, force: true });
});

async function seedWorkUpload(input: {
  accountId: string;
  suffix: string;
  transcribing: boolean;
  tombstoned?: boolean;
}) {
  const uploadId = `work-meeting-${input.suffix}`;
  const meetingId = `work_meeting_${input.suffix}`;
  const uploadsRootDir = getUserUploadsRootDir(input.accountId);
  const filePath = join(uploadsRootDir, `${uploadId}.wav`);
  await mkdir(uploadsRootDir, { recursive: true });
  await writeFile(filePath, `work audio ${input.suffix}`);
  repository.reserveMeeting({
    accountId: input.accountId,
    idempotencyKey: `work_idempotency_${input.suffix}`,
    operationKey: `work_operation_${input.suffix}`,
    contentHash: "a".repeat(64),
    meetingId,
    sourceUploadId: uploadId,
    title: `工作会议 ${input.suffix}`,
    meetingDate: "2026-09-01"
  });
  repository.publishSourceUpload({
    accountId: input.accountId,
    meetingId,
    uploadId,
    originalName: `${uploadId}.wav`,
    mimeType: "audio/wav",
    sizeBytes: 24,
    recordingDate: "2026-09-01",
    filePath,
    contentHash: "a".repeat(64)
  });
  if (input.transcribing) {
    repository.queueStage({
      accountId: input.accountId,
      meetingId,
      stage: "transcription"
    });
    const fence = repository.claimProcessingAttempt({
      accountId: input.accountId,
      meetingId,
      stage: "transcription",
      leaseOwner: `speaker_asr_${input.suffix}`,
      leaseDurationMs: 60_000,
      pipelineVersion: "work_meeting_v1",
      providerProfile: "speaker-asr"
    });
    if (!fence) throw new Error("expected Work transcription fence");
  }
  if (input.tombstoned) {
    repository.deleteMeeting({ accountId: input.accountId, meetingId });
  }
  return { uploadId, meetingId, filePath };
}

function request(input: {
  userId: string;
  uploadId: string;
  query: string;
}) {
  return GET(new Request(
    `http://localhost/api/internal/audio/${input.userId}/${input.uploadId}?${input.query}`
  ), {
    params: Promise.resolve({ userId: input.userId, uploadId: input.uploadId })
  });
}

describe("internal audio route for Work Review", () => {
  it("streams only a currently transcribing Work source for its account and scoped capability", async () => {
    const source = await seedWorkUpload({
      accountId: "account_a",
      suffix: "allowed",
      transcribing: true
    });

    const expiresAtSeconds = Math.floor(Date.now() / 1_000) + 300;
    const capability = createTranscriptionAudioAccessCapability(capabilitySecret, {
      userId: "account_a",
      uploadId: source.uploadId,
      expiresAtSeconds
    });
    const response = await request({
      userId: "account_a",
      uploadId: source.uploadId,
      query: `purpose=transcription&expires=${expiresAtSeconds}`
        + `&capability=${encodeURIComponent(capability)}`
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/wav");
    await expect(response.text()).resolves.toBe("work audio allowed");
  });

  it("denies cross-account, non-transcribing, tombstoned, legacy bearer, and Daily capability access", async () => {
    const transcribing = await seedWorkUpload({
      accountId: "account_a",
      suffix: "private",
      transcribing: true
    });
    const parked = await seedWorkUpload({
      accountId: "account_a",
      suffix: "parked",
      transcribing: false
    });
    const tombstoned = await seedWorkUpload({
      accountId: "account_a",
      suffix: "deleted",
      transcribing: true,
      tombstoned: true
    });
    const expiresAtSeconds = Math.floor(Date.now() / 1_000) + 300;
    const capability = createTranscriptionAudioAccessCapability(capabilitySecret, {
      userId: "account_a",
      uploadId: transcribing.uploadId,
      expiresAtSeconds
    });
    const crossAccountCapability = createTranscriptionAudioAccessCapability(capabilitySecret, {
      userId: "account_b",
      uploadId: transcribing.uploadId,
      expiresAtSeconds
    });
    const parkedCapability = createTranscriptionAudioAccessCapability(capabilitySecret, {
      userId: "account_a",
      uploadId: parked.uploadId,
      expiresAtSeconds
    });
    const tombstonedCapability = createTranscriptionAudioAccessCapability(capabilitySecret, {
      userId: "account_a",
      uploadId: tombstoned.uploadId,
      expiresAtSeconds
    });
    const dailyCapability = createTranscriptionAudioAccessCapability(dailyReflectionCapabilitySecret, {
      userId: "account_a",
      uploadId: transcribing.uploadId,
      expiresAtSeconds
    });

    const responses = await Promise.all([
      request({
        userId: "account_b",
        uploadId: transcribing.uploadId,
        query: `purpose=transcription&expires=${expiresAtSeconds}`
          + `&capability=${encodeURIComponent(crossAccountCapability)}`
      }),
      request({
        userId: "account_a",
        uploadId: parked.uploadId,
        query: `purpose=transcription&expires=${expiresAtSeconds}`
          + `&capability=${encodeURIComponent(parkedCapability)}`
      }),
      request({
        userId: "account_a",
        uploadId: tombstoned.uploadId,
        query: `purpose=transcription&expires=${expiresAtSeconds}`
          + `&capability=${encodeURIComponent(tombstonedCapability)}`
      }),
      request({
        userId: "account_a",
        uploadId: transcribing.uploadId,
        query: `token=${legacyToken}`
      }),
      request({
        userId: "account_a",
        uploadId: transcribing.uploadId,
        query: `purpose=transcription&expires=${expiresAtSeconds}`
          + `&capability=${encodeURIComponent(dailyCapability)}`
      })
    ]);

    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404]);
    for (const response of responses) {
      await expect(response.json()).resolves.toEqual({ error: "audio_not_found" });
    }
  });
});
