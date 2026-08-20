import { afterEach, describe, expect, it, vi } from "vitest";

import type { DailyReflectionDetailResponse } from "@/lib/domain/daily-reflection-api";
import type { DailyReflectionStatus } from "@/lib/domain/daily-reflection";

import {
  DailyReflectionApiError,
  type DailyReflectionApi,
  type DailyReflectionBrowserRecordingInput,
  type DailyReflectionUploadInput
} from "./daily-reflection-api";
import { DailyReflectionSessionController } from "./daily-reflection-session";

const NOW = "2026-08-13T08:00:00.000Z";

function detail(
  reflectionId: string,
  status: DailyReflectionStatus,
  progress = status === "review_pending" ? 100 : 42
): DailyReflectionDetailResponse {
  const uploadId = `upload_${reflectionId}`;
  const terminal = status === "review_pending"
    || status === "confirmation_ready"
    || status === "admitting"
    || status === "completed"
    || status === "admission_failed";
  const failed = status === "failed";
  const cancelled = status === "cancelled";
  return {
    reflection: {
      id: reflectionId,
      accountId: "user_1",
      uploadId,
      inputMethod: "file_upload",
      sourceOrigin: "user_reflection",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      status,
      version: 1,
      idempotencyKey: `key_${reflectionId}`,
      errorCode: failed ? "transcription_failed" : null,
      errorMessage: failed ? "处理没有完成" : null,
      createdAt: NOW,
      updatedAt: NOW
    },
    processingPlan: {
      planVersion: 1,
      reflectionId,
      uploadId,
      inputMethod: "file_upload",
      sourceOrigin: "user_reflection",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      reviewPolicy: "required"
    },
    job: {
      id: `job_${reflectionId}`,
      reflectionId,
      uploadId,
      status: terminal ? "completed" : failed ? "failed" : cancelled ? "cancelled" : "processing",
      progress,
      executionMode: "queue",
      updatedAt: NOW,
      ...(failed ? { errorCode: "transcription_failed", errorMessage: "处理没有完成" } : {})
    },
    upload: {
      id: uploadId,
      originalName: `${reflectionId}.m4a`,
      mimeType: "audio/mp4",
      sizeBytes: 2_048,
      recordingDate: "2026-08-13",
      createdAt: NOW,
      durationSeconds: 12,
      status: terminal ? "ready" : failed ? "failed" : "processing"
    },
    segments: terminal
      ? [{
          id: `segment_${reflectionId}`,
          uploadId,
          startSeconds: 0,
          endSeconds: 5,
          text: "今天完成了一个重要决定。",
          confidence: 0.96,
          sceneLabels: ["self_reflection"],
          valueLabels: ["decision"]
        }]
      : [],
    effectiveOrigin: "user_reflection",
    candidates: [],
    confirmation: null,
    admissionOperation: null,
    admissionResults: []
  };
}

function reviewCandidate(
  status: "pending" | "kept" | "excluded",
  overrides: Record<string, unknown> = {}
) {
  return {
    id: "candidate_1",
    reflectionId: "reflection_1",
    ordinal: 0,
    proposedText: "今天完成了一个重要决定。",
    userText: null,
    status,
    candidateType: "event" as const,
    sourceSegmentIds: ["segment_reflection_1"],
    subjectPersonId: null,
    subjectConfirmed: false,
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
    evidence: [{
      sourceSegmentId: "segment_reflection_1",
      uploadId: "upload_reflection_1",
      effectiveOrigin: "user_reflection" as const,
      startSeconds: 0,
      endSeconds: 5,
      text: "今天完成了一个重要决定。"
    }],
    ...overrides
  };
}

function reviewDetail(
  version: number,
  candidates = [reviewCandidate("pending")]
): DailyReflectionDetailResponse {
  const base = detail("reflection_1", "review_pending");
  return {
    ...base,
    reflection: { ...base.reflection, version },
    candidates
  };
}

function confirmedDetail(
  status: "confirmation_ready" | "admitting" | "completed" | "admission_failed",
  candidate = reviewCandidate("kept")
): DailyReflectionDetailResponse {
  const base = detail("reflection_1", status);
  const confirmation = {
    id: "confirmation_1",
    reflectionId: "reflection_1",
    accountId: "user_1",
    fingerprint: "a".repeat(64),
    requestFingerprint: "b".repeat(64),
    idempotencyKey: "stable-finalize-key",
    sourceOrigin: "user_reflection" as const,
    inputMethod: "file_upload" as const,
    processingProfile: "full_recording" as const,
    candidateSnapshots: [{
      candidateId: candidate.id,
      proposedText: candidate.proposedText,
      userText: candidate.userText,
      finalText: candidate.userText ?? candidate.proposedText,
      status: "kept" as const,
      candidateType: candidate.candidateType,
      sourceSegmentIds: candidate.sourceSegmentIds,
      evidenceSnapshots: candidate.evidence,
      subjectPersonId: candidate.subjectPersonId
    }],
    createdAt: NOW
  };
  return {
    ...base,
    reflection: { ...base.reflection, version: status === "completed" ? 10 : 8 },
    candidates: [candidate],
    confirmation,
    admissionOperation: {
      id: "operation_1",
      reflectionId: "reflection_1",
      confirmationId: "confirmation_1",
      accountId: "user_1",
      status,
      admittedCount: status === "completed" ? 1 : 0,
      rejectedCount: 0,
      excludedCount: 0,
      errorCode: status === "admission_failed" ? "safe_internal_code" : null,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: status === "completed" ? NOW : null
    },
    admissionResults: []
  };
}

function revocableDetail(version = 10, revoked = false): DailyReflectionDetailResponse {
  const kept = reviewCandidate("kept", { version: 1 });
  const base = confirmedDetail("completed", kept);
  return {
    ...base,
    reflection: { ...base.reflection, version },
    admissionResults: [{
      candidateId: kept.id,
      status: "admitted",
      memoryId: "memory_1",
      reasonCode: null,
      errorCode: null,
      operationKey: "admission-candidate-1",
      updatedAt: NOW
    }],
    rememberedCount: revoked ? 0 : 1,
    revokedCandidateIds: revoked ? [kept.id] : []
  };
}

function fakeApi(overrides: Partial<DailyReflectionApi> = {}): DailyReflectionApi {
  return {
    getCurrentUser: async () => ({ id: "user_1", email: "user@example.com" }),
    logout: async () => undefined,
    listConfirmedPeople: async () => [],
    list: async () => [],
    upload: async () => ({
      reflectionId: "reflection_1",
      uploadId: "upload_reflection_1",
      jobId: "job_reflection_1",
      status: "uploading",
      executionMode: "queue"
    }),
    uploadBrowserRecording: async () => ({
      reflectionId: "reflection_1",
      uploadId: "upload_reflection_1",
      jobId: "job_reflection_1",
      status: "uploading",
      executionMode: "queue"
    }),
    get: async (reflectionId) => detail(reflectionId, "review_pending"),
    updateCandidates: async (_reflectionId, input) => ({
      reflection: { ...detail("reflection_1", "review_pending").reflection, version: input.expectedVersion + 1 },
      candidates: []
    }),
    finalize: async () => {
      throw new Error("finalize is not configured for this test");
    },
    revokeCandidate: async () => {
      throw new Error("candidate revocation is not configured for this test");
    },
    cancel: async (reflectionId) => ({ reflectionId, status: "cancelled" }),
    retry: async (reflectionId) => ({
      reflectionId,
      uploadId: `upload_${reflectionId}`,
      jobId: `job_${reflectionId}`,
      status: "uploading",
      executionMode: "queue"
    }),
    delete: async () => undefined,
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("DailyReflectionSessionController", () => {
  it("starts with no selected source and checks the real auth API", async () => {
    const getCurrentUser = vi.fn(async () => ({ id: "user_1", email: "user@example.com" }));
    const controller = new DailyReflectionSessionController({ api: fakeApi({ getCurrentUser }) });

    expect(controller.getSnapshot()).toMatchObject({
      auth: { status: "checking" },
      state: "idle",
      sourceOrigin: null,
      selectedFile: null,
      recordingDate: ""
    });

    await controller.initialize();

    expect(getCurrentUser).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().auth).toEqual({
      status: "authenticated",
      user: { id: "user_1", email: "user@example.com" }
    });
  });

  it("keeps upload indeterminate, then exposes only real progress while polling to review", async () => {
    const uploadRequest = deferred<ReturnType<DailyReflectionApi["upload"]> extends Promise<infer T> ? T : never>();
    const finalDetail = deferred<DailyReflectionDetailResponse>();
    const upload = vi.fn((_input: DailyReflectionUploadInput) => uploadRequest.promise);
    const get = vi.fn()
      .mockResolvedValueOnce(detail("reflection_1", "transcribing", 37))
      .mockImplementationOnce(() => finalDetail.promise);
    const reflectionIds: Array<string | null> = [];
    const controller = new DailyReflectionSessionController({
      api: fakeApi({ upload, get }),
      pollIntervalMs: 0,
      createIdempotencyKey: () => "stable-key",
      onReflectionIdChange: (reflectionId) => reflectionIds.push(reflectionId)
    });
    await controller.initialize();
    const file = new File(["audio"], "reflection.m4a", { type: "audio/mp4" });

    const pending = controller.upload(file, "user_reflection", "2026-08-13");
    expect(controller.getSnapshot()).toMatchObject({
      state: "uploading",
      operation: "uploading",
      detail: null,
      reflectionId: null
    });
    uploadRequest.resolve({
      reflectionId: "reflection_1",
      uploadId: "upload_reflection_1",
      jobId: "job_reflection_1",
      status: "uploading",
      executionMode: "queue"
    });

    await vi.waitFor(() => {
      expect(controller.getSnapshot().state).toBe("transcribing");
    });
    expect(controller.getSnapshot().detail?.job?.progress).toBe(37);
    expect(controller.getSnapshot()).not.toHaveProperty("progress");
    expect(reflectionIds).toEqual(["reflection_1"]);
    expect(upload).toHaveBeenCalledWith({
      file,
      sourceOrigin: "user_reflection",
      recordingDate: "2026-08-13",
      idempotencyKey: "stable-key"
    }, expect.any(AbortSignal));

    finalDetail.resolve(detail("reflection_1", "review_pending", 100));
    await pending;
    expect(controller.getSnapshot()).toMatchObject({
      state: "review_pending",
      operation: "idle",
      reflectionId: "reflection_1"
    });
    expect(controller.getSnapshot().detail?.job?.progress).toBe(100);
  });

  it("uses a roughly 1.2 second interval between processing reads", async () => {
    vi.useFakeTimers();
    const get = vi.fn()
      .mockResolvedValueOnce(detail("reflection_1", "extracting", 73))
      .mockResolvedValueOnce(detail("reflection_1", "review_pending", 100));
    const controller = new DailyReflectionSessionController({ api: fakeApi({ get }) });
    await controller.initialize();

    const pending = controller.reload("reflection_1");
    await vi.advanceTimersByTimeAsync(0);
    expect(get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_199);
    expect(get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(get).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().state).toBe("review_pending");
  });

  it("uploads one browser recording with its stable key and polls it to review", async () => {
    const uploadRequest = deferred<
      Awaited<ReturnType<DailyReflectionApi["uploadBrowserRecording"]>>
    >();
    const uploadBrowserRecording = vi.fn(
      (_input: DailyReflectionBrowserRecordingInput) => uploadRequest.promise
    );
    const get = vi.fn()
      .mockResolvedValueOnce(detail("reflection_browser_1", "transcribing", 41))
      .mockResolvedValueOnce(detail("reflection_browser_1", "review_pending", 100));
    const reflectionIds: Array<string | null> = [];
    const controller = new DailyReflectionSessionController({
      api: fakeApi({ uploadBrowserRecording, get }),
      pollIntervalMs: 0,
      onReflectionIdChange: (reflectionId) => reflectionIds.push(reflectionId)
    });
    await controller.initialize();
    const file = new File([new Blob(["browser audio"], { type: "audio/webm" })],
      "quick-reflection.webm", { type: "audio/webm" });

    const pending = controller.uploadBrowserRecording(
      file,
      181_000,
      "2026-08-13",
      "stable-browser-key"
    );
    expect(controller.getSnapshot()).toMatchObject({
      state: "uploading",
      operation: "uploading",
      reflectionId: null,
      selectedFile: file,
      sourceOrigin: "user_reflection",
      recordingDate: "2026-08-13"
    });
    expect(uploadBrowserRecording).toHaveBeenCalledTimes(1);
    expect(uploadBrowserRecording).toHaveBeenCalledWith({
      file,
      clientReportedDurationMs: 181_000,
      recordingDate: "2026-08-13",
      idempotencyKey: "stable-browser-key"
    }, expect.any(AbortSignal));
    expect(uploadBrowserRecording.mock.calls[0]?.[0]).not.toHaveProperty("sourceOrigin");

    uploadRequest.resolve({
      reflectionId: "reflection_browser_1",
      uploadId: "upload_reflection_browser_1",
      jobId: "job_reflection_browser_1",
      status: "uploading",
      executionMode: "queue"
    });
    await pending;

    expect(get).toHaveBeenCalledTimes(2);
    expect(reflectionIds).toEqual(["reflection_browser_1"]);
    expect(controller.getSnapshot()).toMatchObject({
      state: "review_pending",
      operation: "idle",
      reflectionId: "reflection_browser_1"
    });
  });

  it("omits a zero browser duration and applies the existing bounded error state", async () => {
    const uploadError = new DailyReflectionApiError(
      400,
      "daily_reflection_duration_too_short",
      "这段录音还不够长，请继续说一会儿。"
    );
    const uploadBrowserRecording = vi.fn(
      async (_input: DailyReflectionBrowserRecordingInput) => {
        throw uploadError;
      }
    );
    const get = vi.fn();
    const controller = new DailyReflectionSessionController({
      api: fakeApi({ uploadBrowserRecording, get })
    });
    await controller.initialize();
    const file = new File(["browser audio"], "quick-reflection.webm", {
      type: "audio/webm"
    });

    await controller.uploadBrowserRecording(
      file,
      0,
      "2026-08-13",
      "stable-browser-key"
    );

    expect(uploadBrowserRecording).toHaveBeenCalledTimes(1);
    expect(uploadBrowserRecording).toHaveBeenCalledWith({
      file,
      recordingDate: "2026-08-13",
      idempotencyKey: "stable-browser-key"
    }, expect.any(AbortSignal));
    expect(get).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      auth: { status: "authenticated" },
      state: "error",
      operation: "idle",
      reflectionId: null,
      errorMessage: "这段录音还不够长，请继续说一会儿。"
    });
  });

  it("restores a reflection ID and ignores an older response that disregards abort", async () => {
    const oldResponse = deferred<DailyReflectionDetailResponse>();
    const get = vi.fn((reflectionId: string) => reflectionId === "old"
      ? oldResponse.promise
      : Promise.resolve(detail("new", "review_pending")));
    const controller = new DailyReflectionSessionController({ api: fakeApi({ get }), pollIntervalMs: 0 });
    await controller.initialize();

    const oldReload = controller.reload("old");
    const newReload = controller.reload("new");
    await newReload;
    expect(controller.getSnapshot().reflectionId).toBe("new");

    oldResponse.resolve(detail("old", "failed"));
    await oldReload;
    expect(controller.getSnapshot()).toMatchObject({
      reflectionId: "new",
      state: "review_pending"
    });
  });

  it("aborts active work on dispose and does not apply its late result", async () => {
    const lateResponse = deferred<DailyReflectionDetailResponse>();
    let observedSignal: AbortSignal | undefined;
    const get = vi.fn((_reflectionId: string, signal?: AbortSignal) => {
      observedSignal = signal;
      return lateResponse.promise;
    });
    const controller = new DailyReflectionSessionController({ api: fakeApi({ get }) });
    await controller.initialize();

    const pending = controller.reload("reflection_1");
    expect(observedSignal?.aborted).toBe(false);
    controller.dispose();
    expect(observedSignal?.aborted).toBe(true);
    const snapshotAtDispose = controller.getSnapshot();
    lateResponse.resolve(detail("reflection_1", "review_pending"));
    await pending;
    expect(controller.getSnapshot()).toBe(snapshotAtDispose);
  });

  it("retries a failed record and resumes polling to review_pending", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(detail("reflection_1", "failed", 28))
      .mockResolvedValueOnce(detail("reflection_1", "review_pending", 100));
    const retry = vi.fn(async (reflectionId: string) => ({
      reflectionId,
      uploadId: `upload_${reflectionId}`,
      jobId: `job_${reflectionId}`,
      status: "uploading" as const,
      executionMode: "queue" as const
    }));
    const controller = new DailyReflectionSessionController({ api: fakeApi({ get, retry }) });

    await controller.initialize("reflection_1");
    expect(controller.getSnapshot().state).toBe("failed");
    await controller.retry();

    expect(retry).toHaveBeenCalledWith("reflection_1", expect.any(AbortSignal));
    expect(controller.getSnapshot()).toMatchObject({
      state: "review_pending",
      operation: "idle",
      reflectionId: "reflection_1"
    });
  });

  it("reuses a caller-provided toy key and reports whether the upload receipt arrived", async () => {
    const upload = vi.fn(async () => ({
      reflectionId: "reflection_toy_1",
      uploadId: "upload_toy_1",
      jobId: "job_toy_1",
      status: "uploading" as const,
      executionMode: "inline" as const
    }));
    const get = vi.fn(async () => detail("reflection_toy_1", "review_pending", 100));
    const controller = new DailyReflectionSessionController({
      api: fakeApi({ upload, get }),
      pollIntervalMs: 0,
      createIdempotencyKey: () => "must-not-be-used"
    });
    await controller.initialize();
    const file = new File(["toy audio"], "toy.wav", { type: "audio/wav" });

    await expect(controller.upload(file, "user_reflection", "2026-08-18", {
      idempotencyKey: "daily-reflection-toy-stable",
      inputAdapter: "toy_sync"
    })).resolves.toBe(true);
    expect(upload).toHaveBeenCalledWith({
      file,
      sourceOrigin: "user_reflection",
      recordingDate: "2026-08-18",
      idempotencyKey: "daily-reflection-toy-stable",
      inputAdapter: "toy_sync"
    }, expect.any(AbortSignal));
  });

  it("reports no receipt when a toy upload fails before the API responds", async () => {
    const controller = new DailyReflectionSessionController({
      api: fakeApi({
        upload: vi.fn(async () => {
          throw new DailyReflectionApiError(0, "network_error");
        })
      })
    });
    await controller.initialize();

    await expect(controller.upload(
      new File(["toy audio"], "toy.wav", { type: "audio/wav" }),
      "user_reflection",
      "2026-08-18",
      { idempotencyKey: "daily-reflection-toy-stable", inputAdapter: "toy_sync" }
    )).resolves.toBe(false);
    expect(controller.getSnapshot().state).toBe("error");
  });

  it("keeps the upload receipt true when later processing status refresh fails", async () => {
    const upload = vi.fn(async () => ({
      reflectionId: "reflection_toy_receipt",
      uploadId: "upload_toy_receipt",
      jobId: "job_toy_receipt",
      status: "uploading" as const,
      executionMode: "inline" as const
    }));
    const controller = new DailyReflectionSessionController({
      api: fakeApi({
        upload,
        get: vi.fn(async () => {
          throw new DailyReflectionApiError(503, "status_unavailable");
        })
      }),
      pollIntervalMs: 0
    });
    await controller.initialize();

    await expect(controller.upload(
      new File(["toy audio"], "toy.wav", { type: "audio/wav" }),
      "user_reflection",
      "2026-08-18",
      { idempotencyKey: "daily-reflection-toy-stable", inputAdapter: "toy_sync" }
    )).resolves.toBe(true);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({
      reflectionId: "reflection_toy_receipt",
      state: "error"
    });
  });

  it("saves one candidate decision, reloads server truth, and exposes confirmed people", async () => {
    const pending = reviewDetail(3);
    const keptCandidate = reviewCandidate("kept", {
      userText: "今天做出了重要决定。",
      subjectPersonId: "person_1",
      subjectConfirmed: true,
      version: 1
    });
    const kept = reviewDetail(4, [keptCandidate]);
    const get = vi.fn()
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(kept);
    const listConfirmedPeople = vi.fn(async () => [{
      id: "person_1",
      displayName: "林澄",
      status: "confirmed" as const,
      version: 1,
      explicitlyConfirmed: true as const,
      confirmedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW
    }]);
    const updateCandidates = vi.fn(async () => ({
      reflection: kept.reflection,
      candidates: []
    }));
    const controller = new DailyReflectionSessionController({
      api: fakeApi({ get, listConfirmedPeople, updateCandidates })
    });
    await controller.initialize("reflection_1");

    await controller.updateCandidate({
      candidateId: "candidate_1",
      status: "kept",
      userText: "今天做出了重要决定。",
      subjectPersonId: "person_1"
    });

    expect(updateCandidates).toHaveBeenCalledWith("reflection_1", {
      expectedVersion: 3,
      candidates: [{
        candidateId: "candidate_1",
        status: "kept",
        userText: "今天做出了重要决定。",
        subjectPersonId: "person_1"
      }]
    }, expect.any(AbortSignal));
    expect(get).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject({
      state: "review_pending",
      operation: "idle",
      peopleState: "ready",
      confirmedPeople: [{ id: "person_1" }],
      detail: { reflection: { version: 4 } }
    });
  });

  it("reloads authoritative truth and shows the exact safe message after a stale update", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(reviewDetail(2))
      .mockResolvedValueOnce(reviewDetail(3, [reviewCandidate("excluded", { version: 1 })]));
    const updateCandidates = vi.fn(async () => {
      throw new DailyReflectionApiError(409, "version_conflict");
    });
    const controller = new DailyReflectionSessionController({
      api: fakeApi({ get, updateCandidates })
    });
    await controller.initialize("reflection_1");

    await controller.updateCandidate({
      candidateId: "candidate_1",
      status: "excluded",
      userText: null,
      subjectPersonId: null
    });

    expect(get).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject({
      state: "review_pending",
      operation: "idle",
      detail: { reflection: { version: 3 } },
      errorMessage: "这份复盘已经在其他页面更新，请重新加载最新内容。"
    });
  });

  it("reuses the same finalize key and expected version after response loss and refresh", async () => {
    const storageValues = new Map<string, string>();
    const storage = {
      getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => { storageValues.set(key, value); },
      removeItem: (key: string) => { storageValues.delete(key); }
    };
    const keptCandidate = reviewCandidate("kept", { version: 1 });
    const ready = reviewDetail(7, [keptCandidate]);
    const firstFinalize = vi.fn(async () => {
      throw new DailyReflectionApiError(0, "network_error", "网络连接失败，请检查网络后重试。");
    });
    const first = new DailyReflectionSessionController({
      api: fakeApi({ get: async () => ready, finalize: firstFinalize }),
      createFinalizeIdempotencyKey: () => "stable-finalize-key",
      storage
    });
    await first.initialize("reflection_1");
    await first.finalize();
    expect(first.getSnapshot()).toMatchObject({
      state: "review_pending",
      operation: "idle",
      errorMessage: "网络连接失败，请检查网络后重试。"
    });
    first.dispose();

    const confirmation = {
      id: "confirmation_1",
      reflectionId: "reflection_1",
      accountId: "user_1",
      fingerprint: "a".repeat(64),
      requestFingerprint: "b".repeat(64),
      idempotencyKey: "stable-finalize-key",
      sourceOrigin: "user_reflection" as const,
      inputMethod: "file_upload" as const,
      processingProfile: "full_recording" as const,
      candidateSnapshots: [{
        candidateId: "candidate_1",
        proposedText: keptCandidate.proposedText,
        userText: null,
        finalText: keptCandidate.proposedText,
        status: "kept" as const,
        candidateType: "event" as const,
        sourceSegmentIds: ["segment_reflection_1"],
        evidenceSnapshots: [{
          sourceSegmentId: "segment_reflection_1",
          uploadId: "upload_reflection_1",
          startSeconds: 0,
          endSeconds: 5,
          text: "今天完成了一个重要决定。",
          effectiveOrigin: "user_reflection" as const
        }],
        subjectPersonId: null
      }],
      createdAt: NOW
    };
    const admissionOperation = {
      id: "operation_1",
      reflectionId: "reflection_1",
      confirmationId: "confirmation_1",
      accountId: "user_1",
      status: "completed" as const,
      admittedCount: 1,
      rejectedCount: 0,
      excludedCount: 0,
      errorCode: null,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: NOW
    };
    const completedBase = detail("reflection_1", "completed");
    const completed: DailyReflectionDetailResponse = {
      ...completedBase,
      reflection: { ...completedBase.reflection, version: 8 },
      candidates: [keptCandidate],
      confirmation,
      admissionOperation,
      admissionResults: []
    };
    const get = vi.fn()
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(completed);
    const secondFinalize = vi.fn(async () => ({
      reflection: completed.reflection,
      confirmation,
      admissionOperation,
      admissionResults: [],
      reused: true
    }));
    const secondKeyFactory = vi.fn(() => "must-not-be-used");
    const second = new DailyReflectionSessionController({
      api: fakeApi({ get, finalize: secondFinalize }),
      createFinalizeIdempotencyKey: secondKeyFactory,
      storage
    });
    await second.initialize("reflection_1");
    await second.finalize();

    expect(firstFinalize).toHaveBeenCalledWith("reflection_1", {
      expectedVersion: 7,
      idempotencyKey: "stable-finalize-key"
    }, expect.any(AbortSignal));
    expect(secondFinalize).toHaveBeenCalledWith("reflection_1", {
      expectedVersion: 7,
      idempotencyKey: "stable-finalize-key"
    }, expect.any(AbortSignal));
    expect(secondKeyFactory).not.toHaveBeenCalled();
    expect(second.getSnapshot()).toMatchObject({
      state: "completed",
      operation: "idle",
      detail: { admissionOperation: { admittedCount: 1 } }
    });
    expect(storageValues.size).toBe(0);
  });

  it("keeps polling confirmation and admission phases until completion", async () => {
    const keptCandidate = reviewCandidate("kept", { version: 1 });
    const ready = reviewDetail(7, [keptCandidate]);
    const confirmationReady = confirmedDetail("confirmation_ready", keptCandidate);
    const admitting = confirmedDetail("admitting", keptCandidate);
    const completed = confirmedDetail("completed", keptCandidate);
    const get = vi.fn()
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(confirmationReady)
      .mockResolvedValueOnce(admitting)
      .mockResolvedValueOnce(completed);
    const finalize = vi.fn(async () => ({
      reflection: confirmationReady.reflection,
      confirmation: confirmationReady.confirmation!,
      admissionOperation: confirmationReady.admissionOperation!,
      admissionResults: [],
      reused: false
    }));
    const controller = new DailyReflectionSessionController({
      api: fakeApi({ get, finalize }),
      createFinalizeIdempotencyKey: () => "stable-finalize-key",
      pollIntervalMs: 0
    });
    await controller.initialize("reflection_1");

    await controller.finalize();

    expect(get).toHaveBeenCalledTimes(4);
    expect(controller.getSnapshot()).toMatchObject({
      state: "completed",
      operation: "idle",
      detail: { admissionOperation: { status: "completed", admittedCount: 1 } }
    });
  });

  it("retries a failed admission with the same persisted finalize request", async () => {
    const storageValues = new Map<string, string>();
    const storage = {
      getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => { storageValues.set(key, value); },
      removeItem: (key: string) => { storageValues.delete(key); }
    };
    const keptCandidate = reviewCandidate("kept", { version: 1 });
    const ready = reviewDetail(7, [keptCandidate]);
    const failed = confirmedDetail("admission_failed", keptCandidate);
    const completed = confirmedDetail("completed", keptCandidate);
    const get = vi.fn()
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(completed);
    const finalize = vi.fn()
      .mockRejectedValueOnce(new DailyReflectionApiError(
        503,
        "daily_reflection_memory_admission_failed"
      ))
      .mockResolvedValueOnce({
        reflection: completed.reflection,
        confirmation: completed.confirmation!,
        admissionOperation: completed.admissionOperation!,
        admissionResults: [],
        reused: true
      });
    const controller = new DailyReflectionSessionController({
      api: fakeApi({ get, finalize }),
      createFinalizeIdempotencyKey: () => "stable-finalize-key",
      pollIntervalMs: 0,
      storage
    });
    await controller.initialize("reflection_1");

    await controller.finalize();
    expect(controller.getSnapshot()).toMatchObject({
      state: "admission_failed",
      operation: "idle"
    });
    expect(storageValues.size).toBe(1);

    await controller.finalize();
    expect(finalize).toHaveBeenCalledTimes(2);
    expect(finalize.mock.calls.map((call) => call[1])).toEqual([
      { expectedVersion: 7, idempotencyKey: "stable-finalize-key" },
      { expectedVersion: 7, idempotencyKey: "stable-finalize-key" }
    ]);
    expect(controller.getSnapshot()).toMatchObject({
      state: "completed",
      operation: "idle"
    });
    expect(storageValues.size).toBe(0);
  });

  it("reuses one persisted candidate revocation request after refresh and a 503", async () => {
    const storageValues = new Map<string, string>();
    const storage = {
      getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => { storageValues.set(key, value); },
      removeItem: (key: string) => { storageValues.delete(key); }
    };
    const active = revocableDetail(10, false);
    const revoked = revocableDetail(11, true);
    const firstGet = vi.fn()
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(active);
    const firstRevoke = vi.fn(async () => {
      throw new DailyReflectionApiError(
        503,
        "daily_reflection_candidate_revocation_failed",
        "这条内容暂时没有撤销成功，请稍后重试。"
      );
    });
    const first = new DailyReflectionSessionController({
      api: fakeApi({ get: firstGet, revokeCandidate: firstRevoke }),
      createRevocationIdempotencyKey: () => "stable-revoke-key",
      storage
    });
    await first.initialize("reflection_1");
    await first.revokeCandidate("candidate_1");

    expect(first.getSnapshot()).toMatchObject({
      state: "completed",
      operation: "idle",
      activeCandidateId: "candidate_1",
      errorMessage: "这条内容暂时没有撤销成功，请稍后重试。"
    });
    expect(storageValues.size).toBe(1);
    first.dispose();

    const secondGet = vi.fn()
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(revoked);
    const secondRevoke = vi.fn(async () => ({
      reflectionId: "reflection_1",
      candidateId: "candidate_1",
      reflectionStatus: "completed" as const,
      reflectionVersion: 11,
      revocationStatus: "completed" as const,
      outcome: "revoked" as const,
      rememberedCount: 0,
      reused: true
    }));
    const secondKeyFactory = vi.fn(() => "must-not-be-used");
    const second = new DailyReflectionSessionController({
      api: fakeApi({ get: secondGet, revokeCandidate: secondRevoke }),
      createRevocationIdempotencyKey: secondKeyFactory,
      storage
    });
    await second.initialize("reflection_1");
    expect(second.getSnapshot().activeCandidateId).toBe("candidate_1");
    await second.revokeCandidate("candidate_1");

    expect(firstRevoke).toHaveBeenCalledWith("reflection_1", "candidate_1", {
      expectedVersion: 10,
      idempotencyKey: "stable-revoke-key"
    }, expect.any(AbortSignal));
    expect(secondRevoke).toHaveBeenCalledWith("reflection_1", "candidate_1", {
      expectedVersion: 10,
      idempotencyKey: "stable-revoke-key"
    }, expect.any(AbortSignal));
    expect(secondKeyFactory).not.toHaveBeenCalled();
    expect(second.getSnapshot()).toMatchObject({
      state: "completed",
      operation: "idle",
      activeCandidateId: null,
      errorMessage: null,
      detail: { rememberedCount: 0, revokedCandidateIds: ["candidate_1"] }
    });
    expect(storageValues.size).toBe(0);
  });

  it("recovers a lost revocation response by rereading durable server truth", async () => {
    const storageValues = new Map<string, string>();
    const storage = {
      getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => { storageValues.set(key, value); },
      removeItem: (key: string) => { storageValues.delete(key); }
    };
    const get = vi.fn()
      .mockResolvedValueOnce(revocableDetail(10, false))
      .mockResolvedValueOnce(revocableDetail(11, true));
    const revokeCandidate = vi.fn(async () => {
      throw new DailyReflectionApiError(0, "network_error", "网络连接失败，请检查网络后重试。");
    });
    const controller = new DailyReflectionSessionController({
      api: fakeApi({ get, revokeCandidate }),
      createRevocationIdempotencyKey: () => "lost-response-key",
      storage
    });
    await controller.initialize("reflection_1");
    await controller.revokeCandidate("candidate_1");

    expect(controller.getSnapshot()).toMatchObject({
      state: "completed",
      operation: "idle",
      activeCandidateId: null,
      errorMessage: null,
      detail: { rememberedCount: 0, revokedCandidateIds: ["candidate_1"] }
    });
    expect(storageValues.size).toBe(0);
  });

  it("reloads server truth and clears a stale revocation attempt after 409", async () => {
    const storageValues = new Map<string, string>();
    const storage = {
      getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => { storageValues.set(key, value); },
      removeItem: (key: string) => { storageValues.delete(key); }
    };
    const get = vi.fn()
      .mockResolvedValueOnce(revocableDetail(10, false))
      .mockResolvedValueOnce(revocableDetail(11, false));
    const controller = new DailyReflectionSessionController({
      api: fakeApi({
        get,
        revokeCandidate: async () => {
          throw new DailyReflectionApiError(409, "version_conflict");
        }
      }),
      createRevocationIdempotencyKey: () => "stale-revoke-key",
      storage
    });
    await controller.initialize("reflection_1");
    await controller.revokeCandidate("candidate_1");

    expect(get).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject({
      state: "completed",
      operation: "idle",
      activeCandidateId: null,
      errorMessage: "这份复盘已经在其他页面更新，请重新加载最新内容。",
      detail: { reflection: { version: 11 } }
    });
    expect(storageValues.size).toBe(0);
  });

  it("returns to history when a candidate revocation reports a missing record", async () => {
    const item = {
      id: "reflection_1",
      status: "completed" as const,
      inputMethod: "file_upload" as const,
      sourceOrigin: "user_reflection" as const,
      recordingDate: "2026-08-13",
      sourceStatement: "你在 2026-08-13 的复盘中提到……",
      candidateCount: 1,
      pendingCount: 0,
      keptCount: 1,
      excludedCount: 0,
      rememberedCount: 1,
      notSavedCount: 0,
      subjectPersonIds: [],
      transcriptAvailable: true,
      createdAt: NOW,
      updatedAt: NOW
    };
    const list = vi.fn()
      .mockResolvedValueOnce([item])
      .mockResolvedValueOnce([]);
    const controller = new DailyReflectionSessionController({
      api: fakeApi({
        list,
        get: async () => revocableDetail(10, false),
        revokeCandidate: async () => {
          throw new DailyReflectionApiError(404, "daily_reflection_not_found");
        }
      })
    });
    await controller.initialize("reflection_1");
    await controller.revokeCandidate("candidate_1");

    expect(controller.getSnapshot()).toMatchObject({
      state: "idle",
      reflectionId: null,
      history: [],
      historyErrorMessage: "这条复盘不存在或已被删除。"
    });
  });

  it("cancels processing, then deletes the record and clears recovery state", async () => {
    const blockedPoll = deferred<DailyReflectionDetailResponse>();
    const get = vi.fn()
      .mockResolvedValueOnce(detail("reflection_1", "transcribing", 51))
      .mockImplementationOnce(() => blockedPoll.promise)
      .mockResolvedValueOnce(detail("reflection_1", "cancelled", 51));
    const cancel = vi.fn(async (reflectionId: string) => ({
      reflectionId,
      status: "cancelled" as const
    }));
    const deleteReflection = vi.fn(async () => undefined);
    const reflectionIds: Array<string | null> = [];
    const controller = new DailyReflectionSessionController({
      api: fakeApi({ get, cancel, delete: deleteReflection }),
      pollIntervalMs: 0,
      onReflectionIdChange: (reflectionId) => reflectionIds.push(reflectionId)
    });
    await controller.initialize();

    const polling = controller.reload("reflection_1");
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    const cancelling = controller.cancel();
    blockedPoll.reject(new DOMException("aborted", "AbortError"));
    await Promise.all([polling, cancelling]);
    expect(cancel).toHaveBeenCalledWith("reflection_1", expect.any(AbortSignal));
    expect(controller.getSnapshot().state).toBe("cancelled");

    await controller.delete();
    expect(deleteReflection).toHaveBeenCalledWith("reflection_1", expect.any(AbortSignal));
    expect(controller.getSnapshot()).toMatchObject({
      state: "idle",
      operation: "idle",
      reflectionId: null,
      detail: null,
      selectedFile: null,
      sourceOrigin: null,
      recordingDate: ""
    });
    expect(reflectionIds).toEqual(["reflection_1", null]);
  });

  it("loads recent records, keeps them when starting a new Reflection, and removes only a confirmed deletion", async () => {
    const history = [{
      id: "reflection_1",
      status: "completed" as const,
      inputMethod: "file_upload" as const,
      sourceOrigin: "user_reflection" as const,
      recordingDate: "2026-08-13",
      sourceStatement: "你在 2026-08-13 的复盘中提到……",
      candidateCount: 2,
      pendingCount: 0,
      keptCount: 1,
      excludedCount: 1,
      rememberedCount: 1,
      notSavedCount: 1,
      subjectPersonIds: ["person_1"],
      transcriptAvailable: true,
      createdAt: NOW,
      updatedAt: NOW
    }];
    const list = vi.fn()
      .mockResolvedValueOnce(history)
      .mockResolvedValueOnce([]);
    const deleteReflection = vi.fn(async () => undefined);
    const controller = new DailyReflectionSessionController({
      api: fakeApi({ list, delete: deleteReflection })
    });

    await controller.initialize("reflection_1");
    expect(controller.getSnapshot()).toMatchObject({
      historyState: "ready",
      history,
      reflectionId: "reflection_1"
    });

    controller.startNew();
    expect(controller.getSnapshot()).toMatchObject({
      reflectionId: null,
      history
    });

    await controller.reload("reflection_1");
    await controller.delete();
    expect(deleteReflection).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toMatchObject({
      reflectionId: null,
      history: [],
      historyState: "ready"
    });
  });

  it("keeps the selected record and recent list when deletion fails so the user can retry", async () => {
    const item = {
      id: "reflection_1",
      status: "completed" as const,
      inputMethod: "file_upload" as const,
      sourceOrigin: "unknown" as const,
      recordingDate: null,
      sourceStatement: "来源尚未完全确认",
      candidateCount: 0,
      pendingCount: 0,
      keptCount: 0,
      excludedCount: 0,
      rememberedCount: 0,
      notSavedCount: 0,
      subjectPersonIds: [],
      transcriptAvailable: false,
      createdAt: NOW,
      updatedAt: NOW
    };
    const controller = new DailyReflectionSessionController({
      api: fakeApi({
        list: async () => [item],
        delete: async () => {
          throw new DailyReflectionApiError(503, "daily_reflection_cleanup_failed", "删除没有完成，请稍后再试。");
        }
      })
    });

    await controller.initialize("reflection_1");
    await controller.delete();

    expect(controller.getSnapshot()).toMatchObject({
      reflectionId: "reflection_1",
      history: [item],
      operation: "idle",
      state: "error",
      errorMessage: "删除没有完成，请稍后再试。"
    });
  });

  it("expires the session on a 401 from a reflection action", async () => {
    const get = vi.fn(async () => {
      throw new DailyReflectionApiError(401, "unauthenticated", "登录已失效。");
    });
    const controller = new DailyReflectionSessionController({ api: fakeApi({ get }) });

    await controller.initialize("reflection_1");

    expect(controller.getSnapshot()).toMatchObject({
      auth: { status: "anonymous" },
      state: "idle",
      reflectionId: null,
      detail: null
    });
  });

  it("handles anonymous initialization and logout without retaining workflow state", async () => {
    const anonymous = new DailyReflectionSessionController({
      api: fakeApi({ getCurrentUser: async () => null })
    });
    await anonymous.initialize("reflection_1");
    expect(anonymous.getSnapshot().auth).toEqual({ status: "anonymous" });
    expect(anonymous.getSnapshot().reflectionId).toBeNull();

    const logout = vi.fn(async () => undefined);
    const authenticated = new DailyReflectionSessionController({ api: fakeApi({ logout }) });
    await authenticated.initialize("reflection_1");
    await authenticated.logout();
    expect(logout).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(authenticated.getSnapshot()).toMatchObject({
      auth: { status: "anonymous" },
      state: "idle",
      reflectionId: null,
      detail: null
    });
  });
});
