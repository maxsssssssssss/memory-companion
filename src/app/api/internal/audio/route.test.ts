import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAudioChunkId } from "@/lib/domain/chunks";
import { getUserScopedStore, getUserUploadsRootDir } from "@/lib/server/auth/session";
import { createTranscriptionAudioAccessCapability } from "@/lib/server/transcription/audio-access-capability";
import {
  DailyReflectionRepository,
  getDailyReflectionDatabase,
  getDailyReflectionRepository,
  openDailyReflectionDatabase
} from "@/lib/server/daily-reflection";
import { JsonChunkCheckpointStore } from "@/lib/server/transcription/chunks/checkpoint-store";
import { GET } from "./[userId]/[uploadId]/route";

const originalEnv = { ...process.env };
const capabilitySecret = "daily-reflection-audio-capability-secret-test-only";

let tempDir: string;

describe("internal audio route", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "daily-brief-internal-audio-"));
    process.env.APP_DATA_DIR = tempDir;
    process.env.SPEAKER_ASR_AUDIO_ACCESS_TOKEN = "internal_audio_token";
    process.env.DAILY_REFLECTION_AUDIO_CAPABILITY_SECRET = capabilitySecret;
  });

  afterEach(async () => {
    getDailyReflectionDatabase().close();
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

  it("does not stream parked Daily Reflection audio even with the internal token", async () => {
    const userId = "user_1";
    const uploadId = "upload_reflection";
    const uploadsRootDir = getUserUploadsRootDir(userId);
    const filePath = join(uploadsRootDir, `${uploadId}.wav`);
    const store = getUserScopedStore(userId);
    await mkdir(uploadsRootDir, { recursive: true });
    await writeFile(filePath, "private reflection audio");
    await store.write("uploads", uploadId, {
      id: uploadId,
      originalName: "reflection.wav",
      mimeType: "audio/wav",
      sizeBytes: 24,
      recordingDate: "2026-08-13",
      status: "extracting",
      filePath,
      ingestionContext: "daily_reflection",
      reflectionId: "reflection_1"
    });

    const response = await GET(new Request(
      `http://localhost/api/internal/audio/${userId}/${uploadId}?token=internal_audio_token`
    ), { params: Promise.resolve({ userId, uploadId }) });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "audio_not_found" });
  });

  it("streams Daily Reflection audio only through its bound transcription capability", async () => {
    const userId = "user_1";
    const uploadId = "upload_reflection_transcribing";
    const uploadsRootDir = getUserUploadsRootDir(userId);
    const filePath = join(uploadsRootDir, `${uploadId}.wav`);
    const store = getUserScopedStore(userId);
    await mkdir(uploadsRootDir, { recursive: true });
    await writeFile(filePath, "reflection asr audio");
    await store.write("uploads", uploadId, {
      id: uploadId,
      originalName: "reflection.wav",
      mimeType: "audio/wav",
      sizeBytes: 20,
      recordingDate: "2026-08-13",
      status: "transcribing",
      filePath,
      ingestionContext: "daily_reflection",
      reflectionId: "reflection_transcribing"
    });
    process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "true";
    const database = openDailyReflectionDatabase({
      filePath: join(tempDir, "daily-reflection.sqlite")
    });
    const repository = new DailyReflectionRepository(database, {
      idFactory: () => "reflection_transcribing"
    });
    const created = repository.createReflection({
      accountId: userId,
      uploadId,
      inputMethod: "file_upload",
      sourceOrigin: "user_reflection",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection"
    });
    const uploading = repository.transitionStatus({
      accountId: userId,
      reflectionId: created.reflection.id,
      expectedVersion: created.reflection.version,
      status: "uploading"
    });
    repository.transitionStatus({
      accountId: userId,
      reflectionId: created.reflection.id,
      expectedVersion: uploading.version,
      status: "transcribing"
    });
    database.close();
    const expiresAtSeconds = Math.floor(Date.now() / 1_000) + 300;
    const capability = createTranscriptionAudioAccessCapability(
      capabilitySecret,
      { userId, uploadId, expiresAtSeconds }
    );

    const allowed = await GET(new Request(
      `http://localhost/api/internal/audio/${userId}/${uploadId}`
      + `?purpose=transcription&expires=${expiresAtSeconds}`
      + `&capability=${encodeURIComponent(capability)}`
    ), { params: Promise.resolve({ userId, uploadId }) });
    expect(allowed.status).toBe(200);
    await expect(allowed.text()).resolves.toBe("reflection asr audio");

    const bearerForgedCapability = createTranscriptionAudioAccessCapability(
      "internal_audio_token",
      { userId, uploadId, expiresAtSeconds }
    );
    const bearerCannotSign = await GET(new Request(
      `http://localhost/api/internal/audio/${userId}/${uploadId}`
      + `?purpose=transcription&expires=${expiresAtSeconds}`
      + `&capability=${encodeURIComponent(bearerForgedCapability)}`
    ), { params: Promise.resolve({ userId, uploadId }) });
    expect(bearerCannotSign.status).toBe(401);

    const wrongPurpose = await GET(new Request(
      `http://localhost/api/internal/audio/${userId}/${uploadId}`
      + `?purpose=voiceprint&expires=${expiresAtSeconds}`
      + `&capability=${encodeURIComponent(capability)}`
    ), { params: Promise.resolve({ userId, uploadId }) });
    expect(wrongPurpose.status).toBe(401);

    const wrongUploadCapability = createTranscriptionAudioAccessCapability(
      capabilitySecret,
      { userId, uploadId: "different_upload", expiresAtSeconds }
    );
    const wrongUpload = await GET(new Request(
      `http://localhost/api/internal/audio/${userId}/${uploadId}`
      + `?purpose=transcription&expires=${expiresAtSeconds}`
      + `&capability=${encodeURIComponent(wrongUploadCapability)}`
    ), { params: Promise.resolve({ userId, uploadId }) });
    expect(wrongUpload.status).toBe(401);

    const expiredAtSeconds = Math.floor(Date.now() / 1_000) - 1;
    const expiredCapability = createTranscriptionAudioAccessCapability(
      capabilitySecret,
      { userId, uploadId, expiresAtSeconds: expiredAtSeconds }
    );
    const expired = await GET(new Request(
      `http://localhost/api/internal/audio/${userId}/${uploadId}`
      + `?purpose=transcription&expires=${expiredAtSeconds}`
      + `&capability=${encodeURIComponent(expiredCapability)}`
    ), { params: Promise.resolve({ userId, uploadId }) });
    expect(expired.status).toBe(401);

    process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "false";
    const featureOff = await GET(new Request(
      `http://localhost/api/internal/audio/${userId}/${uploadId}`
      + `?purpose=transcription&expires=${expiresAtSeconds}`
      + `&capability=${encodeURIComponent(capability)}`
    ), { params: Promise.resolve({ userId, uploadId }) });
    expect(featureOff.status).toBe(404);

    process.env.DAILY_REFLECTION_UPLOAD_ENABLED = "true";
    const persistedRepository = getDailyReflectionRepository();
    const transcribing = persistedRepository.getReflection(
      userId,
      "reflection_transcribing"
    );
    persistedRepository.transitionStatus({
      accountId: userId,
      reflectionId: transcribing.id,
      expectedVersion: transcribing.version,
      status: "extracting"
    });
    const noLongerTranscribing = await GET(new Request(
      `http://localhost/api/internal/audio/${userId}/${uploadId}`
      + `?purpose=transcription&expires=${expiresAtSeconds}`
      + `&capability=${encodeURIComponent(capability)}`
    ), { params: Promise.resolve({ userId, uploadId }) });
    expect(noLongerTranscribing.status).toBe(404);
    getDailyReflectionDatabase().close();
  });

  it("streams a persisted generated chunk without exposing arbitrary files", async () => {
    const userId = "user_1";
    const uploadId = "upload_1";
    const chunkId = buildAudioChunkId(uploadId, 0);
    const uploadsRootDir = getUserUploadsRootDir(userId);
    const filePath = join(uploadsRootDir, `${uploadId}.mp3`);
    const chunkPath = join(uploadsRootDir, `${uploadId}-chunks`, "chunk_00000.mp3");
    const store = getUserScopedStore(userId);
    await mkdir(join(uploadsRootDir, `${uploadId}-chunks`), { recursive: true });
    await writeFile(filePath, "original audio");
    await writeFile(chunkPath, "chunk audio");
    await store.write("uploads", uploadId, {
      id: uploadId,
      originalName: "meeting.mp3",
      mimeType: "audio/mpeg",
      sizeBytes: 14,
      recordingDate: "2026-07-14",
      status: "uploaded",
      filePath
    });
    await new JsonChunkCheckpointStore(store).saveAudioChunk({
      id: chunkId,
      uploadId,
      index: 0,
      startSeconds: 0,
      endSeconds: 300,
      durationSeconds: 300,
      source: { type: "generated_chunk", path: chunkPath },
      status: "processing",
      retryCount: 0,
      createdAt: "2026-07-14T08:00:00.000Z",
      updatedAt: "2026-07-14T08:00:00.000Z",
      startedAt: "2026-07-14T08:00:00.000Z",
      metadata: { mimeType: "audio/mpeg" }
    });

    const response = await GET(
      new Request(
        `http://localhost/api/internal/audio/${userId}/${uploadId}?token=internal_audio_token&chunkId=${chunkId}`
      ),
      { params: Promise.resolve({ userId, uploadId }) }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(await response.text()).toBe("chunk audio");
  });
});
