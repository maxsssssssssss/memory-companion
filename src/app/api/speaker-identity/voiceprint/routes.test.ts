import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TranscriptChunk } from "@/lib/domain/chunks";
import { JsonSpeakerIdentityRepository } from "@/lib/server/speaker-identity/repository";
import { JsonVoiceprintOperationRepository } from "@/lib/server/speaker-identity/voiceprint-operation-repository";
import { JsonStore } from "@/lib/server/storage/json-store";
import { JsonChunkCheckpointStore } from "@/lib/server/transcription/chunks/checkpoint-store";

const authContextMock = vi.hoisted(() => ({
  requireAuthContext: vi.fn(),
  isUnauthenticatedError: vi.fn(() => false),
  unauthorizedResponse: vi.fn(() => new Response(null, { status: 401 }))
}));

vi.mock("@/lib/server/auth/request-context", () => authContextMock);

import { POST as trainVoiceprint } from "./train/route";
import { POST as saveVoiceprint } from "./save/route";

const timestamp = "2026-07-24T00:00:00.000Z";

function chunk(): TranscriptChunk {
  return {
    id: "chunk_1",
    uploadId: "upload_1",
    audioChunkId: "audio_chunk_1",
    index: 0,
    startSeconds: 0,
    endSeconds: 300,
    timebase: "upload_global",
    speakerIdScope: "chunk",
    speakerMap: { speaker_1: "speaker_1" },
    segments: [{
      id: "segment_1",
      uploadId: "upload_1",
      startSeconds: 0,
      endSeconds: 1,
      speaker: "speaker_1",
      text: "你好",
      confidence: 0.9,
      sceneLabels: [],
      valueLabels: []
    }],
    status: "completed",
    retryCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    metadata: { provider: "test" }
  };
}

describe("voiceprint API routes", () => {
  let rootDir: string;
  let store: JsonStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "voiceprint-routes-"));
    store = new JsonStore(rootDir);
    authContextMock.requireAuthContext.mockResolvedValue({
      user: { id: "user_1", email: "user@example.test", name: "Test user" },
      store,
      dataRootDir: rootDir,
      uploadsRootDir: join(rootDir, "uploads")
    });
    vi.stubEnv("VOICEPRINT_BASE_URL", "https://voiceprint.example.test");
    vi.stubEnv("SPEAKER_ASR_AUDIO_BASE_URL", "https://audio-gateway.example.test");
    vi.stubEnv("SPEAKER_ASR_AUDIO_ACCESS_TOKEN", "internal_audio_token");
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ code: 0, message: "success" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    ));
  });

  async function writeAvailableUpload(
    uploadId: string,
    extra: Record<string, unknown> = {}
  ) {
    const uploadsRoot = join(rootDir, "uploads");
    const filePath = join(uploadsRoot, `${uploadId}.wav`);
    await mkdir(uploadsRoot, { recursive: true });
    await writeFile(filePath, Buffer.from("synthetic-audio"));
    await store.write("uploads", uploadId, {
      id: uploadId,
      filePath,
      ...extra
    });
  }

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("trains the authenticated user and persists only operation metadata", async () => {
    await writeAvailableUpload("upload_1");
    const response = await trainVoiceprint(new Request("http://localhost/api/speaker-identity/voiceprint/train", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "train_request_1",
        audio: [{
          uploadId: "upload_1",
          rule: [[0, 8_000]]
        }]
      })
    }));

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      operation: { status: "succeeded" },
      identity: { identityType: "known_user" }
    });
    expect(payload.operation.requestId).toMatch(/^voiceprint_train_/);
    await expect(
      new JsonVoiceprintOperationRepository(store).get(payload.operation.requestId)
    ).resolves.toMatchObject({
      resultMetadata: { audioCount: 1, providerSucceeded: true }
    });
    const providerBody = JSON.parse(
      String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)
    ) as Record<string, unknown>;
    expect(providerBody).toMatchObject({
      user_id: "user_1",
      audio: [{
        url: "https://audio-gateway.example.test/api/internal/audio/user_1/upload_1?token=internal_audio_token",
        rule: [[0, 8_000]]
      }]
    });
  });

  it("rejects arbitrary training URLs instead of forwarding them", async () => {
    const response = await trainVoiceprint(new Request("http://localhost/api/speaker-identity/voiceprint/train", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audio: [{
          url: "https://untrusted.example.test/private",
          rule: [[0, 8_000]]
        }]
      })
    }));

    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects training ranges outside the owned upload duration", async () => {
    await store.write("uploads", "upload_1", {
      id: "upload_1",
      durationSeconds: 5
    });
    const response = await trainVoiceprint(new Request("http://localhost/api/speaker-identity/voiceprint/train", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "train_request_out_of_range",
        audio: [{
          uploadId: "upload_1",
          rule: [[0, 8_000]]
        }]
      })
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "voiceprint_training_range_out_of_bounds"
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reuses the same user-scoped request and rejects changed input", async () => {
    await writeAvailableUpload("upload_1");
    const requestBody = {
      requestId: "train_idempotent",
      audio: [{ uploadId: "upload_1", rule: [[0, 4_000]] }]
    };
    const invoke = (body: unknown) =>
      trainVoiceprint(new Request("http://localhost/api/speaker-identity/voiceprint/train", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }));

    const first = await invoke(requestBody);
    const second = await invoke(requestBody);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      operation: { reused: true }
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    const conflict = await invoke({
      ...requestBody,
      audio: [{ uploadId: "upload_1", rule: [[0, 5_000]] }]
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: "voiceprint_request_id_conflict"
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("forwards two owned retained recordings for incremental training", async () => {
    await writeAvailableUpload("upload_current", { durationSeconds: 12 });
    await writeAvailableUpload("upload_history", {
      durationSeconds: 10,
      evaluationRetention: true
    });

    const response = await trainVoiceprint(new Request(
      "http://localhost/api/speaker-identity/voiceprint/train",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "train_incremental",
          audio: [
            { uploadId: "upload_current", rule: [[0, 8_000]] },
            { uploadId: "upload_history", rule: [[1_000, 9_000]] }
          ]
        })
      }
    ));

    expect(response.status).toBe(200);
    const providerBody = JSON.parse(
      String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)
    ) as { audio: Array<{ url: string }> };
    expect(providerBody.audio).toHaveLength(2);
    expect(providerBody.audio.map((item) => item.url)).toEqual([
      expect.stringContaining("/upload_current?"),
      expect.stringContaining("/upload_history?")
    ]);
  });

  it("fails before Provider access when a historical upload audio was cleaned", async () => {
    await store.write("uploads", "upload_ready", {
      id: "upload_ready",
      status: "ready"
    });

    const response = await trainVoiceprint(new Request(
      "http://localhost/api/speaker-identity/voiceprint/train",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "train_missing_audio",
          audio: [{ uploadId: "upload_ready", rule: [[0, 5_000]] }]
        })
      }
    ));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "voiceprint_training_audio_unavailable"
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("binds only a speaker that exists in the selected transcript chunk", async () => {
    await store.write("uploads", "upload_1", { id: "upload_1" });
    await new JsonChunkCheckpointStore(store).saveTranscriptChunk(chunk());

    const response = await saveVoiceprint(new Request("http://localhost/api/speaker-identity/voiceprint/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "save_request_1",
        uploadId: "upload_1",
        chunkId: "chunk_1",
        localSpeaker: "speaker_1",
        globalSpeakerId: "contact_alice",
        displayName: "Alice"
      })
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      identity: {
        globalSpeakerId: "contact_alice",
        identityType: "known_contact"
      },
      mapping: {
        localSpeaker: "speaker_1",
        source: "manual_mapping"
      }
    });
    await expect(
      new JsonSpeakerIdentityRepository(store).getManualMapping({
        uploadId: "upload_1",
        chunkId: "chunk_1",
        localSpeaker: "speaker_1"
      })
    ).resolves.toMatchObject({ globalSpeakerId: "contact_alice" });
    const providerBody = JSON.parse(
      String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)
    ) as Record<string, unknown>;
    expect(providerBody).toMatchObject({
      user_id: "user_1",
      record_id: "audio_chunk_1",
      speaker_id: "speaker_1",
      speaker_name: "Alice"
    });
  });

  it("rejects a local speaker outside the selected chunk before provider access", async () => {
    await store.write("uploads", "upload_1", { id: "upload_1" });
    await new JsonChunkCheckpointStore(store).saveTranscriptChunk(chunk());

    const response = await saveVoiceprint(new Request("http://localhost/api/speaker-identity/voiceprint/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "save_request_unknown_speaker",
        uploadId: "upload_1",
        chunkId: "chunk_1",
        localSpeaker: "speaker_9",
        displayName: "Alice"
      })
    }));

    expect(response.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires an authenticated user before accessing voiceprint operations", async () => {
    authContextMock.requireAuthContext.mockRejectedValueOnce(new Error("unauthenticated"));
    authContextMock.isUnauthenticatedError.mockReturnValueOnce(true);

    const response = await trainVoiceprint(new Request("http://localhost/api/speaker-identity/voiceprint/train", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "train_request_unauthenticated",
        audio: [{ uploadId: "upload_1", rule: [[0, 1_000]] }]
      })
    }));

    expect(response.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
});
