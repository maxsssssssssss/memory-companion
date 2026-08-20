import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getUserScopedStore,
  getUserUploadsRootDir
} from "@/lib/server/auth/session";
import {
  VoiceprintTrainingCandidateRepository,
  VoiceprintTrainingCandidateSchema
} from "@/lib/server/speaker-identity/voiceprint-training-candidates";

import { GET } from "./[userId]/[candidateId]/route";

let tempDir: string;
const originalEnv = { ...process.env };

describe("internal voiceprint candidate audio", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "internal-voiceprint-candidate-"));
    process.env.APP_DATA_DIR = tempDir;
    process.env.SPEAKER_ASR_AUDIO_ACCESS_TOKEN = "internal_token";
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  it("streams only a queued candidate from the scoped user store", async () => {
    const userId = "user_1";
    const candidateId = "candidate_1";
    const uploadId = "upload_1";
    const uploadsRootDir = getUserUploadsRootDir(userId);
    const audioFilePath = join(
      uploadsRootDir,
      "voiceprint-training",
      uploadId,
      `${candidateId}.mp3`
    );
    await mkdir(dirname(audioFilePath), { recursive: true });
    await writeFile(audioFilePath, "candidate audio");
    const store = getUserScopedStore(userId);
    await new VoiceprintTrainingCandidateRepository(store).save(
      VoiceprintTrainingCandidateSchema.parse({
        version: 1,
        candidateId,
        uploadId,
        candidateKey: "chunk_1::speaker_1",
        chunkId: "chunk_1",
        chunkIndex: 0,
        localSpeaker: "speaker_1",
        segmentIds: ["seg_1"],
        sourceRanges: [{ startMilliseconds: 100, endMilliseconds: 35_100 }],
        durationMilliseconds: 35_000,
        audioFilePath,
        identityState: "unknown",
        status: "queued",
        createdAt: "2026-07-29T00:00:00.000Z",
        updatedAt: "2026-07-29T00:00:00.000Z",
        expiresAt: "2099-08-05T00:00:00.000Z"
      })
    );

    const response = await GET(
      new Request(
        `http://localhost/api/internal/voiceprint-candidates/${userId}/${candidateId}?token=internal_token`
      ),
      { params: Promise.resolve({ userId, candidateId }) }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(await response.text()).toBe("candidate audio");
  });

  it("does not expose another user's candidate", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/internal/voiceprint-candidates/user_2/candidate_1?token=internal_token"
      ),
      {
        params: Promise.resolve({
          userId: "user_2",
          candidateId: "candidate_1"
        })
      }
    );

    expect(response.status).toBe(404);
  });

  it("rejects an invalid token", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/internal/voiceprint-candidates/user_1/candidate_1?token=wrong"
      ),
      {
        params: Promise.resolve({
          userId: "user_1",
          candidateId: "candidate_1"
        })
      }
    );

    expect(response.status).toBe(401);
  });
});
