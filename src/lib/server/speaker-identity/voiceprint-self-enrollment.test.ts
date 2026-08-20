import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioUpload } from "@/lib/domain/types";
import { JsonStore } from "@/lib/server/storage/json-store";

import { VoiceprintProviderError } from "./voiceprint-client";
import {
  VoiceprintSelfEnrollmentOperationRepository,
  createVoiceprintSelfEnrollment,
  processVoiceprintSelfEnrollment,
  voiceprintSelfEnrollmentTrainPolicy
} from "./voiceprint-self-enrollment";
import {
  VoiceprintTrainingCandidateRepository,
  VoiceprintTrainingCandidateSchema,
  type VoiceprintTrainingCandidate
} from "./voiceprint-training-candidates";

let tempDir: string | undefined;
let originalBaseUrl: string | undefined;
let originalToken: string | undefined;
const TEST_NOW = "2026-07-29T00:00:00.000Z";
const TEST_CANDIDATE_EXPIRES_AT = "2026-08-05T00:00:00.000Z";

beforeEach(() => {
  originalBaseUrl = process.env.SPEAKER_ASR_AUDIO_BASE_URL;
  originalToken = process.env.SPEAKER_ASR_AUDIO_ACCESS_TOKEN;
  process.env.SPEAKER_ASR_AUDIO_BASE_URL = "https://audio.example.test";
  process.env.SPEAKER_ASR_AUDIO_ACCESS_TOKEN = "secret";
});

afterEach(async () => {
  if (originalBaseUrl === undefined) delete process.env.SPEAKER_ASR_AUDIO_BASE_URL;
  else process.env.SPEAKER_ASR_AUDIO_BASE_URL = originalBaseUrl;
  if (originalToken === undefined) delete process.env.SPEAKER_ASR_AUDIO_ACCESS_TOKEN;
  else process.env.SPEAKER_ASR_AUDIO_ACCESS_TOKEN = originalToken;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function context() {
  tempDir = await mkdtemp(join(tmpdir(), "voiceprint-self-enrollment-"));
  const uploadsRootDir = join(tempDir, "uploads");
  await mkdir(uploadsRootDir, { recursive: true });
  return {
    store: new JsonStore(join(tempDir, "store")),
    uploadsRootDir,
    userId: "user_1",
    now: () => TEST_NOW
  };
}

async function saveCandidate(
  input: Awaited<ReturnType<typeof context>>,
  values: Partial<VoiceprintTrainingCandidate> & {
    candidateId: string;
    uploadId: string;
  }
) {
  const {
    candidateId,
    uploadId,
    ...overrides
  } = values;
  const parentUpload: AudioUpload = {
    id: uploadId,
    originalName: `${uploadId}.wav`,
    mimeType: "audio/wav",
    sizeBytes: 10,
    recordingDate: "2026-07-29",
    status: "ready",
    durationSeconds: 40
  };
  await input.store.write("uploads", uploadId, parentUpload);
  const audioFilePath = join(
    input.uploadsRootDir,
    "voiceprint-training",
    uploadId,
    `${candidateId}.mp3`
  );
  await mkdir(join(audioFilePath, ".."), { recursive: true }).catch(() => undefined);
  await mkdir(
    join(input.uploadsRootDir, "voiceprint-training", uploadId),
    { recursive: true }
  );
  await writeFile(audioFilePath, "mp3");
  const candidate = VoiceprintTrainingCandidateSchema.parse({
    version: 1,
    candidateId,
    uploadId,
    candidateKey: `${uploadId}::speaker_1`,
    chunkId: `chunk_${uploadId}`,
    chunkIndex: 0,
    localSpeaker: "speaker_1",
    segmentIds: [`seg_${candidateId}`],
    sourceRanges: [{ startMilliseconds: 100, endMilliseconds: 35_100 }],
    durationMilliseconds: 35_000,
    audioFilePath,
    identityState: "unknown",
    status: "available",
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    expiresAt: TEST_CANDIDATE_EXPIRES_AT,
    ...overrides
  });
  await new VoiceprintTrainingCandidateRepository(input.store).save(candidate);
  return candidate;
}

describe("voiceprint self enrollment", () => {
  it("fails closed when the candidate parent upload is missing", async () => {
    const input = await context();
    const candidate = await saveCandidate(input, {
      candidateId: "candidate_missing_parent",
      uploadId: "upload_missing_parent"
    });
    await input.store.delete("uploads", candidate.uploadId);

    await expect(
      createVoiceprintSelfEnrollment({
        ...input,
        requestId: "request_missing_parent",
        candidateId: candidate.candidateId
      })
    ).rejects.toMatchObject({
      reason: "invalid_candidate"
    });
  });

  it("reuses identical request input and rejects request-id conflicts", async () => {
    const input = await context();
    const first = await saveCandidate(input, {
      candidateId: "candidate_1",
      uploadId: "upload_1"
    });
    const second = await saveCandidate(input, {
      candidateId: "candidate_2",
      uploadId: "upload_2"
    });
    const created = await createVoiceprintSelfEnrollment({
      ...input,
      requestId: "request_1",
      candidateId: first.candidateId
    });
    const reused = await createVoiceprintSelfEnrollment({
      ...input,
      requestId: "request_1",
      candidateId: first.candidateId
    });

    expect(created.reused).toBe(false);
    expect(reused).toEqual({ operation: created.operation, reused: true });
    await expect(
      createVoiceprintSelfEnrollment({
        ...input,
        requestId: "request_1",
        candidateId: second.candidateId
      })
    ).rejects.toMatchObject({
      reason: "request_id_conflict"
    });
  });

  it("trains once with the current and latest successful sample, then cleans obsolete audio", async () => {
    const input = await context();
    const primary = await saveCandidate(input, {
      candidateId: "candidate_primary",
      uploadId: "upload_current"
    });
    const sibling = await saveCandidate(input, {
      candidateId: "candidate_sibling",
      uploadId: "upload_current"
    });
    const previous = await saveCandidate(input, {
      candidateId: "candidate_previous",
      uploadId: "upload_previous",
      status: "trained",
      trainedAt: "2026-07-28T12:00:00.000Z"
    });
    const created = await createVoiceprintSelfEnrollment({
      ...input,
      requestId: "request_success",
      candidateId: primary.candidateId,
      now: () => "2026-07-29T00:00:00.000Z"
    });
    const trainUser = vi.fn(async () => ({
      operation: { resultMetadata: { providerCode: 0 } }
    } as never));

    const result = await processVoiceprintSelfEnrollment({
      ...input,
      operationId: created.operation.operationId,
      now: (() => {
        const timestamps = [
          "2026-07-29T00:00:01.000Z",
          "2026-07-29T00:00:02.000Z",
          "2026-07-29T00:00:03.000Z",
          "2026-07-29T00:00:04.000Z"
        ];
        return () => timestamps.shift() ?? "2026-07-29T00:00:04.000Z";
      })(),
      createService: () => ({ trainUser })
    });

    expect(result).toMatchObject({
      status: "succeeded",
      attemptCount: 1,
      providerCode: 0
    });
    expect(trainUser).toHaveBeenCalledOnce();
    expect(trainUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_1",
        audio: [
          expect.objectContaining({
            url: expect.stringContaining(primary.candidateId),
            rule: [[0, 35_000]]
          }),
          expect.objectContaining({
            url: expect.stringContaining(previous.candidateId),
            rule: [[0, 35_000]]
          })
        ]
      })
    );
    const candidates = new VoiceprintTrainingCandidateRepository(input.store);
    await expect(candidates.get(primary.candidateId)).resolves.toMatchObject({
      status: "trained"
    });
    await expect(candidates.get(sibling.candidateId)).resolves.toBeNull();
    await expect(candidates.get(previous.candidateId)).resolves.toBeNull();
  });

  it("marks timeout ambiguous, retains audio, and never retries automatically", async () => {
    const input = await context();
    const candidate = await saveCandidate(input, {
      candidateId: "candidate_timeout",
      uploadId: "upload_timeout"
    });
    const created = await createVoiceprintSelfEnrollment({
      ...input,
      requestId: "request_timeout",
      candidateId: candidate.candidateId
    });
    const trainUser = vi.fn(async () => {
      throw new VoiceprintProviderError(
        "timeout",
        "timed out",
        undefined,
        undefined,
        1
      );
    });

    const first = await processVoiceprintSelfEnrollment({
      ...input,
      operationId: created.operation.operationId,
      createService: () => ({ trainUser })
    });
    const second = await processVoiceprintSelfEnrollment({
      ...input,
      operationId: created.operation.operationId,
      createService: () => ({ trainUser })
    });

    expect(first.status).toBe("ambiguous_timeout");
    expect(second.status).toBe("ambiguous_timeout");
    expect(trainUser).toHaveBeenCalledOnce();
    const stored = await new VoiceprintTrainingCandidateRepository(input.store)
      .get(candidate.candidateId);
    expect(stored).toMatchObject({
      status: "failed",
      failureReason: "ambiguous_timeout"
    });
    await expect(
      createVoiceprintSelfEnrollment({
        ...input,
        requestId: "request_manual_retry",
        candidateId: candidate.candidateId
      })
    ).resolves.toMatchObject({ reused: false });
  });

  it("fails closed on a recovered running operation without a Provider checkpoint", async () => {
    const input = await context();
    const candidate = await saveCandidate(input, {
      candidateId: "candidate_running",
      uploadId: "upload_running"
    });
    const created = await createVoiceprintSelfEnrollment({
      ...input,
      requestId: "request_running",
      candidateId: candidate.candidateId
    });
    const operations = new VoiceprintSelfEnrollmentOperationRepository(
      input.store,
      input.now
    );
    await operations.update(created.operation.operationId, (current) => ({
      ...current,
      status: "running",
      attemptCount: 1,
      startedAt: "2026-07-29T00:00:00.000Z"
    }));
    const trainUser = vi.fn();

    const result = await processVoiceprintSelfEnrollment({
      ...input,
      operationId: created.operation.operationId,
      createService: () => ({ trainUser })
    });

    expect(result.status).toBe("ambiguous_timeout");
    expect(result.attemptCount).toBe(1);
    expect(trainUser).not.toHaveBeenCalled();
  });

  it("rejects a candidate at the deterministic expiry boundary", async () => {
    const input = await context();
    const candidate = await saveCandidate(input, {
      candidateId: "candidate_expired",
      uploadId: "upload_expired"
    });

    await expect(
      createVoiceprintSelfEnrollment({
        ...input,
        requestId: "request_expired",
        candidateId: candidate.candidateId,
        now: () => TEST_CANDIDATE_EXPIRES_AT
      })
    ).rejects.toMatchObject({
      reason: "candidate_expired"
    });
    await expect(
      new VoiceprintTrainingCandidateRepository(input.store).get(
        candidate.candidateId
      )
    ).resolves.toMatchObject({
      status: "expired",
      audioFilePath: null
    });
  });

  it("pins the product Train policy to 240 seconds and zero Provider retries", () => {
    expect(voiceprintSelfEnrollmentTrainPolicy).toEqual({
      timeoutMilliseconds: 240_000,
      maximumAttempts: 1,
      providerRetries: 0
    });
  });
});
