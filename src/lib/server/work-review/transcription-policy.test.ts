import { describe, expect, it, vi } from "vitest";

import {
  createWorkMeetingTranscriber,
  type WorkMeetingTranscriptionInput
} from "./transcription-policy";

function segment(uploadId = "upload_1") {
  return {
    id: "segment_1",
    uploadId,
    startSeconds: 0,
    endSeconds: 1,
    speaker: "Speaker 1",
    text: "我们决定先验证上传流程。",
    confidence: 0.9,
    sceneLabels: [],
    valueLabels: []
  };
}

function input(): WorkMeetingTranscriptionInput {
  return {
    uploadId: "upload_1",
    filePath: "C:/tmp/meeting.wav",
    mimeType: "audio/wav",
    userId: "account_1",
    store: {} as WorkMeetingTranscriptionInput["store"]
  };
}

describe("Work Review transcription policy", () => {
  it("rejects an implicit provider before invoking ASR", async () => {
    const transcribe = vi.fn();
    const worker = createWorkMeetingTranscriber({
      env: { NODE_ENV: "test" },
      resolveRuntime: () => ({ name: "fixture", fallbackName: null }),
      transcribe
    });
    await expect(worker(input())).rejects.toMatchObject({
      code: "work_transcription_provider_missing"
    });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("forbids fixture ASR in production even when explicitly selected", async () => {
    const worker = createWorkMeetingTranscriber({
      env: {
        NODE_ENV: "production",
        TRANSCRIPTION_PROVIDER: "fixture",
        WORK_REVIEW_FIXTURE_TRANSCRIPTION_ENABLED: "true"
      },
      resolveRuntime: () => ({ name: "fixture", fallbackName: null }),
      transcribe: vi.fn()
    });
    await expect(worker(input())).rejects.toMatchObject({
      code: "work_transcription_fixture_forbidden"
    });
  });

  it("forbids every fallback because canonical provenance must remain fail closed", async () => {
    const transcribe = vi.fn();
    const worker = createWorkMeetingTranscriber({
      env: {
        NODE_ENV: "production",
        TRANSCRIPTION_PROVIDER: "openai"
      },
      resolveRuntime: () => ({ name: "openai", fallbackName: "fixture" }),
      transcribe
    });
    await expect(worker(input())).rejects.toMatchObject({
      code: "work_transcription_fallback_forbidden"
    });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("requires a Work-scoped audio capability for speaker-asr", async () => {
    const transcribe = vi.fn();
    const worker = createWorkMeetingTranscriber({
      env: {
        NODE_ENV: "production",
        TRANSCRIPTION_PROVIDER: "speaker-asr"
      },
      resolveRuntime: () => ({ name: "speaker-asr", fallbackName: null }),
      transcribe
    });

    await expect(worker(input())).rejects.toMatchObject({
      code: "work_transcription_audio_capability_missing"
    });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("permits only explicitly enabled non-production fixture mode", async () => {
    const transcribe = vi.fn(async () => [segment()]);
    const worker = createWorkMeetingTranscriber({
      env: {
        NODE_ENV: "test",
        TRANSCRIPTION_PROVIDER: "fixture",
        WORK_REVIEW_FIXTURE_TRANSCRIPTION_ENABLED: "true"
      },
      resolveRuntime: () => ({ name: "fixture", fallbackName: null }),
      transcribe
    });
    await expect(worker(input())).resolves.toEqual([segment()]);
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({
      identityPolicy: "skip",
      audioAccessPolicy: "work_review_capability"
    }));
  });

  it("rejects empty or cross-upload ASR output without publishing it", async () => {
    const worker = createWorkMeetingTranscriber({
      env: {
        NODE_ENV: "production",
        TRANSCRIPTION_PROVIDER: "openai",
        TRANSCRIPTION_FALLBACK_PROVIDER: "none"
      },
      resolveRuntime: () => ({ name: "openai", fallbackName: null }),
      transcribe: vi.fn(async () => [segment("other_upload")])
    });
    await expect(worker(input())).rejects.toMatchObject({
      code: "work_transcription_segments_invalid"
    });
  });

  it("propagates Provider failure instead of invoking a fixture fallback", async () => {
    const providerError = new Error("provider_timeout");
    const transcribe = vi.fn(async () => {
      throw providerError;
    });
    const worker = createWorkMeetingTranscriber({
      env: {
        NODE_ENV: "production",
        TRANSCRIPTION_PROVIDER: "openai",
        TRANSCRIPTION_FALLBACK_PROVIDER: "none"
      },
      resolveRuntime: () => ({ name: "openai", fallbackName: null }),
      transcribe
    });
    await expect(worker(input())).rejects.toBe(providerError);
    expect(transcribe).toHaveBeenCalledTimes(1);
  });
});
