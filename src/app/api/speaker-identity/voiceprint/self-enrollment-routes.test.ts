import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioUpload } from "@/lib/domain/types";
import { JsonStore } from "@/lib/server/storage/json-store";
import {
  VoiceprintTrainingCandidateRepository,
  VoiceprintTrainingCandidateSchema,
  type VoiceprintTrainingCandidate
} from "@/lib/server/speaker-identity/voiceprint-training-candidates";

const {
  enqueueVoiceprintEnrollmentMock,
  requireAuthContextMock
} = vi.hoisted(() => ({
  enqueueVoiceprintEnrollmentMock: vi.fn(),
  requireAuthContextMock: vi.fn()
}));

vi.mock("@/lib/server/auth/request-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/auth/request-context")>();
  return {
    ...actual,
    requireAuthContext: requireAuthContextMock
  };
});

vi.mock("@/lib/server/speaker-identity/voiceprint-enrollment-queue", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/server/speaker-identity/voiceprint-enrollment-queue")
  >();
  return {
    ...actual,
    enqueueVoiceprintEnrollment: enqueueVoiceprintEnrollmentMock
  };
});

import { GET as getCandidateAudio } from "./candidates/[candidateId]/audio/route";
import { GET as listCandidates } from "./candidates/route";
import { GET as getOperation } from "./operations/[operationId]/route";
import { POST as createEnrollment } from "./self-enrollment/route";

let tempDir: string | undefined;
let originalFeatureFlag: string | undefined;

beforeEach(() => {
  originalFeatureFlag = process.env.VOICEPRINT_SELF_ENROLLMENT_ENABLED;
  process.env.VOICEPRINT_SELF_ENROLLMENT_ENABLED = "true";
  enqueueVoiceprintEnrollmentMock.mockResolvedValue({
    jobId: "job_1",
    enqueued: true
  });
});

afterEach(async () => {
  if (originalFeatureFlag === undefined) {
    delete process.env.VOICEPRINT_SELF_ENROLLMENT_ENABLED;
  } else {
    process.env.VOICEPRINT_SELF_ENROLLMENT_ENABLED = originalFeatureFlag;
  }
  requireAuthContextMock.mockReset();
  enqueueVoiceprintEnrollmentMock.mockReset();
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

async function createContext(userId: string) {
  tempDir ??= await mkdtemp(join(tmpdir(), "voiceprint-enrollment-routes-"));
  const dataRootDir = join(tempDir, userId);
  const uploadsRootDir = join(dataRootDir, "uploads");
  await mkdir(uploadsRootDir, { recursive: true });
  return {
    user: { id: userId, email: `${userId}@example.test`, name: userId },
    store: new JsonStore(dataRootDir),
    dataRootDir,
    uploadsRootDir
  };
}

async function saveUploadAndCandidate(
  context: Awaited<ReturnType<typeof createContext>>,
  values: {
    uploadId: string;
    candidateId: string;
    status?: VoiceprintTrainingCandidate["status"];
    identityState?: VoiceprintTrainingCandidate["identityState"];
    expiresAt?: string;
  }
) {
  const upload: AudioUpload = {
    id: values.uploadId,
    originalName: "sample.wav",
    mimeType: "audio/wav",
    sizeBytes: 10,
    recordingDate: "2026-07-29",
    status: "ready",
    durationSeconds: 40
  };
  await context.store.write("uploads", upload.id, upload);
  const audioFilePath = join(
    context.uploadsRootDir,
    "voiceprint-training",
    values.uploadId,
    `${values.candidateId}.mp3`
  );
  await mkdir(dirname(audioFilePath), { recursive: true });
  await writeFile(audioFilePath, "mp3");
  const candidate = VoiceprintTrainingCandidateSchema.parse({
    version: 1,
    candidateId: values.candidateId,
    uploadId: values.uploadId,
    candidateKey: `chunk_${values.uploadId}::speaker_1`,
    chunkId: `chunk_${values.uploadId}`,
    chunkIndex: 0,
    localSpeaker: "speaker_1",
    segmentIds: [`seg_${values.candidateId}`],
    sourceRanges: [{ startMilliseconds: 100, endMilliseconds: 35_100 }],
    durationMilliseconds: 35_000,
    audioFilePath,
    identityState: values.identityState ?? "unknown",
    status: values.status ?? "available",
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    expiresAt: values.expiresAt ?? "2099-08-05T00:00:00.000Z"
  });
  await new VoiceprintTrainingCandidateRepository(context.store).save(candidate);
  return candidate;
}

function jsonRequest(url: string, body: unknown) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("voiceprint self-enrollment product routes", () => {
  it("lists safe candidate metadata without exposing the file path", async () => {
    const context = await createContext("user_a");
    const candidate = await saveUploadAndCandidate(context, {
      uploadId: "upload_1",
      candidateId: "candidate_1"
    });
    requireAuthContextMock.mockResolvedValue(context);

    const response = await listCandidates(
      new Request("http://localhost/api/speaker-identity/voiceprint/candidates?uploadId=upload_1")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      enabled: true,
      candidates: [
        {
          candidateId: candidate.candidateId,
          speaker: "speaker_1",
          canEnroll: true,
          hasAudio: true
        }
      ]
    });
    expect(JSON.stringify(body)).not.toContain(candidate.audioFilePath);
  });

  it("hides a retained candidate after the parent upload record is gone", async () => {
    const context = await createContext("user_a");
    const candidate = await saveUploadAndCandidate(context, {
      uploadId: "upload_cached",
      candidateId: "candidate_cached"
    });
    await context.store.delete("uploads", "upload_cached");
    requireAuthContextMock.mockResolvedValue(context);

    const response = await listCandidates(
      new Request(
        "http://localhost/api/speaker-identity/voiceprint/candidates?uploadId=upload_cached"
      )
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "upload_not_found" });
  });

  it("does not expose retained candidates for a daily reflection upload", async () => {
    const context = await createContext("user_a");
    const candidate = await saveUploadAndCandidate(context, {
      uploadId: "upload_daily_reflection",
      candidateId: "candidate_daily_reflection"
    });
    const upload = await context.store.read<AudioUpload>("uploads", candidate.uploadId);
    await context.store.write("uploads", candidate.uploadId, {
      ...upload!,
      ingestionContext: "daily_reflection",
      reflectionId: "reflection_1"
    });
    requireAuthContextMock.mockResolvedValue(context);

    const response = await listCandidates(
      new Request(
        `http://localhost/api/speaker-identity/voiceprint/candidates?uploadId=${candidate.uploadId}`
      )
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ error: "upload_not_found" });
    expect(JSON.stringify(body)).not.toContain(candidate.candidateId);
  });

  it("streams candidate audio with browser media range support", async () => {
    const context = await createContext("user_a");
    const candidate = await saveUploadAndCandidate(context, {
      uploadId: "upload_audio",
      candidateId: "candidate_audio"
    });
    requireAuthContextMock.mockResolvedValue(context);
    const url =
      `http://localhost/api/speaker-identity/voiceprint/candidates/${candidate.candidateId}/audio`;

    const fullResponse = await getCandidateAudio(
      new Request(url),
      { params: Promise.resolve({ candidateId: candidate.candidateId }) }
    );
    const rangeResponse = await getCandidateAudio(
      new Request(url, { headers: { Range: "bytes=1-" } }),
      { params: Promise.resolve({ candidateId: candidate.candidateId }) }
    );

    expect(fullResponse.status).toBe(200);
    expect(fullResponse.headers.get("Accept-Ranges")).toBe("bytes");
    expect(fullResponse.headers.get("Content-Length")).toBe("3");
    await expect(fullResponse.text()).resolves.toBe("mp3");
    expect(rangeResponse.status).toBe(206);
    expect(rangeResponse.headers.get("Content-Range")).toBe("bytes 1-2/3");
    expect(rangeResponse.headers.get("Content-Length")).toBe("2");
    await expect(rangeResponse.text()).resolves.toBe("p3");
  });

  it("rejects an unsatisfiable candidate audio range", async () => {
    const context = await createContext("user_a");
    const candidate = await saveUploadAndCandidate(context, {
      uploadId: "upload_audio",
      candidateId: "candidate_audio"
    });
    requireAuthContextMock.mockResolvedValue(context);

    const response = await getCandidateAudio(
      new Request(
        `http://localhost/api/speaker-identity/voiceprint/candidates/${candidate.candidateId}/audio`,
        { headers: { Range: "bytes=99-" } }
      ),
      { params: Promise.resolve({ candidateId: candidate.candidateId }) }
    );

    expect(response.status).toBe(416);
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Range")).toBe("bytes */3");
  });

  it("rejects stale Daily Reflection candidate audio and enrollment", async () => {
    const context = await createContext("user_a");
    const candidate = await saveUploadAndCandidate(context, {
      uploadId: "upload_reflection_stale",
      candidateId: "candidate_reflection_stale"
    });
    const upload = await context.store.read<AudioUpload>("uploads", candidate.uploadId);
    await context.store.write("uploads", candidate.uploadId, {
      ...upload!,
      ingestionContext: "daily_reflection",
      reflectionId: "reflection_stale"
    });
    requireAuthContextMock.mockResolvedValue(context);

    const audio = await getCandidateAudio(new Request(
      `http://localhost/api/speaker-identity/voiceprint/candidates/${candidate.candidateId}/audio`
    ), { params: Promise.resolve({ candidateId: candidate.candidateId }) });
    const enrollment = await createEnrollment(jsonRequest(
      "http://localhost/api/speaker-identity/voiceprint/self-enrollment",
      {
        requestId: "request_reflection_stale",
        candidateId: candidate.candidateId,
        confirmation: "self"
      }
    ));

    expect(audio.status).toBe(404);
    expect(enrollment.status).toBe(409);
    expect(enqueueVoiceprintEnrollmentMock).not.toHaveBeenCalled();
  });

  it("requires explicit self confirmation and blocks contact candidates", async () => {
    const context = await createContext("user_a");
    const candidate = await saveUploadAndCandidate(context, {
      uploadId: "upload_contact",
      candidateId: "candidate_contact",
      identityState: "known_contact",
      status: "ineligible"
    });
    requireAuthContextMock.mockResolvedValue(context);

    const missingConfirmation = await createEnrollment(
      jsonRequest("http://localhost/api/speaker-identity/voiceprint/self-enrollment", {
        requestId: "request_1",
        candidateId: candidate.candidateId
      })
    );
    const blockedContact = await createEnrollment(
      jsonRequest("http://localhost/api/speaker-identity/voiceprint/self-enrollment", {
        requestId: "request_2",
        candidateId: candidate.candidateId,
        confirmation: "self"
      })
    );

    expect(missingConfirmation.status).toBe(400);
    expect(blockedContact.status).toBe(409);
    expect(enqueueVoiceprintEnrollmentMock).not.toHaveBeenCalled();
  });

  it("returns 202, enqueues once, exposes status, and reuses the same request", async () => {
    const context = await createContext("user_a");
    const candidate = await saveUploadAndCandidate(context, {
      uploadId: "upload_1",
      candidateId: "candidate_1"
    });
    requireAuthContextMock.mockResolvedValue(context);
    const requestBody = {
      requestId: "stable_request_1",
      candidateId: candidate.candidateId,
      confirmation: "self"
    };

    const first = await createEnrollment(
      jsonRequest("http://localhost/api/speaker-identity/voiceprint/self-enrollment", requestBody)
    );
    const firstBody = await first.json();
    const second = await createEnrollment(
      jsonRequest("http://localhost/api/speaker-identity/voiceprint/self-enrollment", requestBody)
    );
    const secondBody = await second.json();
    const status = await getOperation(
      new Request(`http://localhost/api/speaker-identity/voiceprint/operations/${firstBody.operation.id}`),
      { params: Promise.resolve({ operationId: firstBody.operation.id }) }
    );

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(firstBody.operation).toMatchObject({
      status: "queued",
      attemptCount: 0,
      reused: false
    });
    expect(secondBody.operation).toMatchObject({
      id: firstBody.operation.id,
      reused: true
    });
    expect(enqueueVoiceprintEnrollmentMock).toHaveBeenCalledOnce();
    await expect(status.json()).resolves.toMatchObject({
      operation: {
        id: firstBody.operation.id,
        status: "queued",
        attemptCount: 0
      }
    });
  });

  it("does not read a candidate or operation from another account store", async () => {
    const accountA = await createContext("user_a");
    const candidate = await saveUploadAndCandidate(accountA, {
      uploadId: "upload_1",
      candidateId: "candidate_private"
    });
    const accountB = await createContext("user_b");
    requireAuthContextMock.mockResolvedValue(accountB);

    const createResponse = await createEnrollment(
      jsonRequest("http://localhost/api/speaker-identity/voiceprint/self-enrollment", {
        requestId: "request_cross_account",
        candidateId: candidate.candidateId,
        confirmation: "self"
      })
    );
    const audioResponse = await getCandidateAudio(
      new Request(`http://localhost/api/speaker-identity/voiceprint/candidates/${candidate.candidateId}/audio`),
      { params: Promise.resolve({ candidateId: candidate.candidateId }) }
    );

    expect(createResponse.status).toBe(409);
    expect(audioResponse.status).toBe(404);
    expect(enqueueVoiceprintEnrollmentMock).not.toHaveBeenCalled();
  });

  it("rejects expired candidates without enqueueing", async () => {
    const context = await createContext("user_a");
    const candidate = await saveUploadAndCandidate(context, {
      uploadId: "upload_expired",
      candidateId: "candidate_expired",
      expiresAt: "2026-07-01T00:00:00.000Z"
    });
    requireAuthContextMock.mockResolvedValue(context);

    const response = await createEnrollment(
      jsonRequest("http://localhost/api/speaker-identity/voiceprint/self-enrollment", {
        requestId: "request_expired",
        candidateId: candidate.candidateId,
        confirmation: "self"
      })
    );

    expect(response.status).toBe(410);
    expect(enqueueVoiceprintEnrollmentMock).not.toHaveBeenCalled();
  });
});
