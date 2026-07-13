import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getUserScopedStore, getUserUploadsRootDir } from "@/lib/server/auth/session";
import { GET } from "./[userId]/[uploadId]/route";

const originalEnv = { ...process.env };

let tempDir: string;

describe("internal audio route", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "daily-brief-internal-audio-"));
    process.env.APP_DATA_DIR = tempDir;
    process.env.SPEAKER_ASR_AUDIO_ACCESS_TOKEN = "internal_audio_token";
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(tempDir, { recursive: true, force: true });
  });

  it("streams a user upload only when the speaker-asr token matches", async () => {
    const userId = "user_1";
    const uploadId = "upload_1";
    const uploadsRootDir = getUserUploadsRootDir(userId);
    const filePath = join(uploadsRootDir, `${uploadId}.mp3`);
    const store = getUserScopedStore(userId);

    await mkdir(uploadsRootDir, { recursive: true });
    await writeFile(filePath, "audio bytes");
    await store.write("uploads", uploadId, {
      id: uploadId,
      originalName: "meeting.mp3",
      mimeType: "audio/mpeg",
      sizeBytes: 11,
      recordingDate: "2026-06-26",
      status: "uploaded",
      filePath
    });

    const response = await GET(new Request(`http://localhost/api/internal/audio/${userId}/${uploadId}?token=internal_audio_token`), {
      params: Promise.resolve({ userId, uploadId })
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(await response.text()).toBe("audio bytes");
  });

  it("rejects requests without the configured token", async () => {
    const response = await GET(new Request("http://localhost/api/internal/audio/user_1/upload_1?token=wrong"), {
      params: Promise.resolve({ userId: "user_1", uploadId: "upload_1" })
    });

    expect(response.status).toBe(401);
  });
});
