import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DailyReflectionCardUpdateRequest,
  DailyReflectionCardView,
  DailyReflectionCandidateView,
  DailyReflectionDetailResponse,
  DailyReflectionOperationUploadState,
  DailyReflectionWorkingCardDetailResponse
} from "@/lib/domain/daily-reflection-api";
import type { DailyReflectionStatus } from "@/lib/domain/daily-reflection";

import {
  DailyReflectionApiError,
  type DailyReflectionApi,
  type DailyReflectionBrowserRecordingInput,
  type DailyReflectionUploadInput
} from "./daily-reflection-api";
import { DailyReflectionSessionController } from "./daily-reflection-session";
import type { ReflectionRecordingBackup, ReflectionRecordingStorage } from "./daily-reflection-recording-storage";

const NOW = "2026-08-13T08:00:00.000Z";

function operationReceipt(
  reflectionId = "reflection_1",
  inputAdapter: "file_picker" | "browser_recorder" | "toy_sync" = "file_picker"
) {
  return {
    reflectionId,
    uploadId: `upload_${reflectionId}`,
    jobId: `job_${reflectionId}`,
    operationKey: `operation_${reflectionId}`,
    contentHash: "a".repeat(64),
    capturePurpose: "inspiration_capture" as const,
    status: "uploading" as const,
    executionMode: "queue" as const,
    inputAdapter,
    sourceOrigin: "user_reflection" as const,
    recordingDate: "2026-08-13"
  };
}

function storeOperationReceipt(
  values: Map<string, string>,
  receipt = operationReceipt()
) {
  values.set(
    `daily-reflection:operation-receipt:v2:user_1:${receipt.reflectionId}`,
    JSON.stringify(receipt)
  );
}

function storePendingInputOperation(
  storage: Pick<Storage, "setItem">,
  operationKey = "pending-operation"
) {
  storage.setItem(
    "daily-reflection:pending-input:v2:user_1",
    JSON.stringify({
      accountId: "user_1",
      operationKey,
      inputAdapter: "file_picker",
      sourceOrigin: "user_reflection",
      recordingDate: "2026-08-13"
    })
  );
}

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
    cards: [],
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

function reviewCandidateV2(
  status: "pending" | "kept" | "excluded" = "pending",
  overrides: Record<string, unknown> = {}
) {
  return {
    contractVersion: 2 as const,
    id: "candidate_v2_1",
    reflectionId: "reflection_1",
    ordinal: 0,
    proposedText: "我准备明天把这件事做完。",
    userText: null,
    status,
    candidateKind: "user_action" as const,
    candidateType: "summary" as const,
    evidenceIds: ["segment_reflection_1"],
    sourceSegmentIds: ["segment_reflection_1"],
    confidence: 0.8,
    caution: "请按你的实际计划确认。",
    actionClaimed: false,
    subjectPersonId: null,
    subjectConfirmed: false as const,
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
    evidence: [{
      sourceSegmentId: "segment_reflection_1",
      uploadId: "upload_reflection_1",
      effectiveOrigin: "user_reflection" as const,
      startSeconds: 0,
      endSeconds: 5,
      text: "我准备明天把这件事做完。"
    }],
    ...overrides
  };
}

function reviewCard(
  id: string,
  displayTier: "primary" | "more",
  cardKind: DailyReflectionCardView["cardKind"] = "insight"
): DailyReflectionCardView {
  return {
    id,
    reflectionId: "reflection_1",
    cardKind,
    proposedTitle: `${id} 标题`,
    proposedText: `${id} 内容`,
    userTitle: null,
    userText: null,
    sourceCandidateIds: [`candidate_${id}`],
    evidenceIds: ["segment_reflection_1"],
    clusterId: `cluster_${id}`,
    clusterTitle: "今天的重点",
    displayTier,
    rank: displayTier === "primary" ? 0 : 1,
    confidence: 0.8,
    importance: 0.8,
    durability: 0.7,
    novelty: 0.6,
    epistemicStatus: "explicit_user_statement",
    riskFlags: [],
    actionClaimed: false,
    reviewStatus: displayTier === "primary" ? "pending" : "not_proposed",
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
    evidence: [{
      sourceSegmentId: "segment_reflection_1",
      uploadId: "upload_reflection_1",
      effectiveOrigin: "user_reflection",
      startSeconds: 0,
      endSeconds: 5,
      text: "今天完成了一个重要决定。"
    }]
  };
}

function workingCardDetail(
  status: "saved" | "archived" | "removed",
  version: number
): DailyReflectionWorkingCardDetailResponse {
  return {
    card: {
      id: "card_working",
      sourceReflectionIds: ["reflection_1"],
      title: "工作卡片",
      content: "工作卡片内容",
      cardKind: "insight",
      evidenceIds: ["segment_1"],
      status,
      importance: 0.8,
      novelty: 0.7,
      relatedCardIds: [],
      tags: [],
      visibility: "private",
      sourceUnavailable: false,
      memoryLifecycleStatus: "not_admitted",
      memoryLifecycleVersion: 0,
      memoryLifecycleUpdatedAt: null,
      version,
      createdAt: NOW,
      updatedAt: NOW,
      evidence: [{
        sourceSegmentId: "segment_1",
        uploadId: "upload_1",
        effectiveOrigin: "user_reflection",
        startSeconds: 0,
        endSeconds: 8,
        text: "Canonical Evidence"
      }]
    }
  };
}

function reviewDetail(
  version: number,
  candidates: DailyReflectionCandidateView[] = [reviewCandidate("pending")]
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
  candidate: DailyReflectionCandidateView = reviewCandidate("kept")
): DailyReflectionDetailResponse {
  const base = detail("reflection_1", status);
  const confirmation = {
    contractVersion: 2 as const,
    id: "confirmation_1",
    reflectionId: "reflection_1",
    accountId: "user_1",
    fingerprint: "a".repeat(64),
    requestFingerprint: "b".repeat(64),
    idempotencyKey: "operation_reflection_1",
    operationKey: "operation_reflection_1",
    sourceOrigin: "user_reflection" as const,
    inputMethod: "file_upload" as const,
    processingProfile: "full_recording" as const,
    inputAdapter: "file_picker" as const,
    capturePurpose: "inspiration_capture" as const,
    recordingDate: "2026-08-13",
    saveIntent: "retain_selected" as const,
    candidateSnapshots: [{
      contractVersion: 2 as const,
      candidateId: candidate.id,
      proposedText: candidate.proposedText,
      userText: candidate.userText,
      finalText: candidate.userText ?? candidate.proposedText,
      status: "kept" as const,
      candidateKind: "insight" as const,
      candidateType: "summary" as const,
      evidenceIds: candidate.sourceSegmentIds,
      sourceSegmentIds: candidate.sourceSegmentIds,
      evidenceSnapshots: candidate.evidence,
      confidence: 0.8,
      caution: "请按你的实际感受判断。",
      actionClaimed: false,
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

function recapOnlyCompletedDetail(
  candidate: DailyReflectionCandidateView
): DailyReflectionDetailResponse {
  const base = confirmedDetail("completed", candidate);
  if (!base.confirmation || !("contractVersion" in base.confirmation)) {
    throw new Error("expected a V2 confirmation fixture");
  }
  return {
    ...base,
    confirmation: { ...base.confirmation, saveIntent: "recap_only" },
    admissionOperation: null,
    admissionResults: [],
    rememberedCount: 0,
    revokedCandidateIds: []
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
    list: async () => [],
    upload: async () => operationReceipt(),
    uploadBrowserRecording: async () => operationReceipt("reflection_1", "browser_recorder"),
    get: async (reflectionId) => detail(reflectionId, "review_pending"),
    getOperation: async () => ({ found: false }),
    updateCards: async (_reflectionId, input) => ({
      reflection: { ...detail("reflection_1", "review_pending").reflection, version: input.expectedVersion + 1 },
      cards: []
    }),
    listWorkingCards: async () => ({ cards: [], total: 0, limit: 24, offset: 0 }),
    getWorkingCard: async () => {
      throw new Error("working card detail is not configured for this test");
    },
    saveWorkingCard: async () => {
      throw new Error("working card save is not configured for this test");
    },
    updateWorkingCard: async () => {
      throw new Error("working card update is not configured for this test");
    },
    archiveWorkingCard: async () => {
      throw new Error("working card archive is not configured for this test");
    },
    restoreWorkingCard: async () => {
      throw new Error("working card restore is not configured for this test");
    },
    removeWorkingCard: async () => {
      throw new Error("working card remove is not configured for this test");
    },
    getWorkingCardMemoryProposal: async () => { throw new Error("Memory lookup is not configured"); },
    evaluateMemoryProposal: async () => { throw new Error("Memory evaluation is not configured"); },
    createWorkingCardMemoryProposal: async () => {
      throw new Error("working card Memory proposal is not configured for this test");
    },
    admitMemoryProposal: async () => {
      throw new Error("working card Memory admission is not configured for this test");
    },
    getMemoryRecommendations: async (reflectionId) => ({
      reflectionId,
      policyVersion: "daily_reflection_memory_recommendation_v1",
      recommendationFingerprint: "0".repeat(64),
      maxRecommendations: 5,
      eligibleCount: 0,
      recommendations: []
    }),
    getWorkingCardMemoryRevocation: async () => ({ found: false }),
    revokeWorkingCardMemory: async () => {
      throw new Error("working card Memory revocation is not configured for this test");
    },
    listMemories: async () => ({ memories: [], total: 0 }),
    getMemory: async () => {
      throw new Error("Daily Reflection Memory is not configured for this test");
    },
    getDailyReturn: async () => {
      throw new Error("Daily Return is not configured for this test");
    },
    getWeeklyReflection: async () => {
      throw new Error("Weekly Reflection is not configured for this test");
    },
    queryReflection: async () => {
      throw new Error("Daily Reflection query is not configured for this test");
    },
    updateCandidates: async (_reflectionId, input) => ({
      reflection: { ...detail("reflection_1", "review_pending").reflection, version: input.expectedVersion + 1 },
      candidates: []
    }),
    createManualCandidate: async () => {
      throw new Error("manual candidate creation is not configured for this test");
    },
    excludeCandidate: async () => {
      throw new Error("candidate exclusion is not configured for this test");
    },
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

function recordingStorageFixture() {
  const rows = new Map<string, ReflectionRecordingBackup>();
  const storage: ReflectionRecordingStorage = {
    load: async (accountId) => rows.get(accountId) ?? null,
    save: async (row) => { rows.set(row.accountId, row); },
    remove: async (accountId, operationKey) => {
      if (rows.get(accountId)?.operationKey === operationKey) rows.delete(accountId);
    }
  };
  return { storage, rows };
}

describe("recording transport recovery", () => {
  const file = () => new File(["same synthetic audio bytes"], "original.webm", { type: "audio/webm" });
  const lookupState = (uploadState: DailyReflectionOperationUploadState, status: DailyReflectionStatus = "uploading") => ({
    found: true as const, uploadState, status, reflectionId: "reflection_1", uploadId: "upload_reflection_1",
    jobId: "job_reflection_1", contentHash: "a".repeat(64)
  });
  async function storedRecording(storage: ReflectionRecordingStorage) {
    const original = { accountId: "user_1", operationKey: "state-key", file: file(), sourceOrigin: "direct_conversation" as const,
      recordingDate: "2026-08-13", clientReportedDurationMs: 3456, submitted: true };
    await storage.save(original);
    return original;
  }

  it.each(["uploading", "failed", "review_pending"] as const)("adopts accepted %s without a POST and cleans only the local audio", async (status) => {
    const { storage, rows } = recordingStorageFixture();
    await storedRecording(storage);
    const upload = vi.fn();
    const finalize = vi.fn();
    const controller = new DailyReflectionSessionController({ recordingStorage: storage, api: fakeApi({
      getOperation: async () => lookupState("accepted", status), uploadBrowserRecording: upload, finalize
    }) });
    await controller.initialize();
    expect(controller.getSnapshot().recordingRecovery).toMatchObject({ phase: "saved", file: null, reflectionId: "reflection_1" });
    expect(rows.size).toBe(0);
    expect(upload).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("waits for active persistence before cleaning the file, without reposting", async () => {
    const { storage, rows } = recordingStorageFixture();
    await storedRecording(storage);
    const lookup = vi.fn().mockImplementationOnce(async () => {
      expect(rows.size).toBe(1); return lookupState("still_persisting");
    }).mockImplementationOnce(async () => {
      expect(rows.size).toBe(1); return lookupState("accepted");
    });
    const upload = vi.fn();
    const controller = new DailyReflectionSessionController({ recordingStorage: storage, pollIntervalMs: 0,
      api: fakeApi({ getOperation: lookup, uploadBrowserRecording: upload }) });
    await controller.initialize();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(rows.size).toBe(0);
    expect(upload).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("bounds persistent waiting to five lookups and retains the recording", async () => {
    const { storage, rows } = recordingStorageFixture();
    await storedRecording(storage);
    const lookup = vi.fn(async () => lookupState("still_persisting"));
    const controller = new DailyReflectionSessionController({ recordingStorage: storage, pollIntervalMs: 0,
      api: fakeApi({ getOperation: lookup }) });
    await controller.initialize();
    expect(lookup).toHaveBeenCalledTimes(5);
    expect(controller.getSnapshot().recordingRecovery?.phase).toBe("persisting");
    expect(rows.size).toBe(1);
    controller.dispose();
  });

  it("reuploads only with explicit permission and keeps the original payload and operation", async () => {
    const { storage } = recordingStorageFixture();
    const original = await storedRecording(storage);
    const upload = vi.fn(async (_input: DailyReflectionBrowserRecordingInput) => ({ ...operationReceipt(), operationKey: original.operationKey }));
    const controller = new DailyReflectionSessionController({ recordingStorage: storage,
      api: fakeApi({ getOperation: async () => lookupState("reupload_allowed", "failed"), uploadBrowserRecording: upload }) });
    await controller.initialize();
    expect(upload).not.toHaveBeenCalled();
    await controller.retryRecordingUpload();
    expect(upload).toHaveBeenCalledOnce();
    expect(upload.mock.calls[0]?.[0]).toMatchObject({ file: original.file, operationKey: original.operationKey,
      sourceOrigin: original.sourceOrigin, recordingDate: original.recordingDate, clientReportedDurationMs: original.clientReportedDurationMs });
    controller.dispose();
  });

  it("does not resend when a newer lease turns reupload permission into persistence pending", async () => {
    const { storage, rows } = recordingStorageFixture();
    await storedRecording(storage);
    const lookup = vi.fn().mockResolvedValueOnce(lookupState("reupload_allowed"))
      .mockResolvedValueOnce(lookupState("reupload_allowed"))
      .mockResolvedValueOnce(lookupState("still_persisting"))
      .mockResolvedValue(lookupState("accepted"));
    const upload = vi.fn(async () => ({ ...operationReceipt(), operationKey: "state-key", persistencePending: true }));
    const controller = new DailyReflectionSessionController({ recordingStorage: storage, pollIntervalMs: 0,
      api: fakeApi({ getOperation: lookup, uploadBrowserRecording: upload }) });
    await controller.initialize();
    await controller.retryRecordingUpload();
    expect(upload).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledTimes(4);
    expect(rows.size).toBe(0);
    controller.dispose();
  });

  it("ignores an accepted lookup that arrives after the account changes", async () => {
    const { storage, rows } = recordingStorageFixture();
    await storedRecording(storage);
    const late = deferred<ReturnType<typeof lookupState>>();
    const lookup = vi.fn(() => late.promise);
    let accountId = "user_1";
    const controller = new DailyReflectionSessionController({ recordingStorage: storage, api: fakeApi({
      getCurrentUser: async () => ({ id: accountId, email: "fixture@example.com" }), getOperation: lookup
    }) });
    const first = controller.initialize();
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
    accountId = "user_2";
    await controller.initialize();
    late.resolve(lookupState("accepted"));
    await first;
    expect(controller.getSnapshot().recordingRecovery).toBeNull();
    expect(controller.getSnapshot().reflectionId).toBeNull();
    expect(rows.size).toBe(1);
    controller.dispose();
  });

  it("retains the backup when a legacy or unknown lookup fails strict parsing", async () => {
    const { storage, rows } = recordingStorageFixture();
    await storedRecording(storage);
    const upload = vi.fn();
    const controller = new DailyReflectionSessionController({ recordingStorage: storage, api: fakeApi({
      getOperation: async () => { throw new DailyReflectionApiError(200, "invalid_response"); }, uploadBrowserRecording: upload
    }) });
    await controller.initialize();
    await controller.retryRecordingUpload();
    expect(upload).not.toHaveBeenCalled();
    expect(rows.size).toBe(1);
    expect(controller.getSnapshot().recordingRecovery?.phase).toBe("interrupted");
    controller.dispose();
  });

  it("ignores an old account's late pending-operation lookup even when no local audio exists", async () => {
    storePendingInputOperation(window.localStorage, "late-no-audio");
    const late = deferred<ReturnType<typeof lookupState>>();
    let accountId = "user_1";
    const lookup = vi.fn(() => late.promise);
    const get = vi.fn();
    const controller = new DailyReflectionSessionController({ api: fakeApi({ get, getOperation: lookup,
      getCurrentUser: async () => ({ id: accountId, email: "fixture@example.com" }) }) });
    const first = controller.initialize();
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
    accountId = "user_2";
    await controller.initialize();
    late.resolve(lookupState("accepted"));
    await first;
    expect(get).not.toHaveBeenCalled();
    expect(controller.getSnapshot().reflectionId).toBeNull();
    controller.dispose();
  });

  it.each(["cancelled", "deleted"] as const)("fences a late detail read when lookup reports a %s operation as terminated", async (status) => {
    const { storage, rows } = recordingStorageFixture();
    await storedRecording(storage);
    const lookup = vi.fn(async () => lookupState("unresolved", "failed"));
    const get = vi.fn(async () => detail("reflection_1", "failed"));
    const controller = new DailyReflectionSessionController({ recordingStorage: storage,
      api: fakeApi({ getOperation: lookup, get }) });
    await controller.initialize();
    const late = deferred<DailyReflectionDetailResponse>();
    get.mockImplementationOnce(() => late.promise);
    const reading = controller.reload("reflection_1");
    lookup.mockResolvedValue(lookupState("terminated", status));
    await controller.retryRecordingUpload();
    late.resolve(detail("reflection_1", "review_pending"));
    await reading;
    expect(controller.getSnapshot()).toMatchObject({ state: status, reflectionId: null, detail: null, recordingRecovery: null });
    expect(rows.size).toBe(0);
    controller.dispose();
  });

  it.each(["created", "uploading", "failed"] as const)("keeps bytes and refuses speculative retransmission for ambiguous %s lookup", async (status) => {
    const { storage, rows } = recordingStorageFixture();
    await storage.save({ accountId: "user_1", operationKey: "ambiguous", file: file(), sourceOrigin: "direct_conversation", recordingDate: "2026-08-13", submitted: true });
    const upload = vi.fn();
    const controller = new DailyReflectionSessionController({ recordingStorage: storage, api: fakeApi({
      uploadBrowserRecording: upload,
      get: async () => detail("uncertain", "failed"),
      getOperation: async () => ({ found: true, uploadState: "unresolved", status, reflectionId: "uncertain", uploadId: "u_uncertain", jobId: "j_uncertain", contentHash: "a".repeat(64) })
    }) });
    await controller.initialize();
    await controller.retryRecordingUpload();
    expect(upload).not.toHaveBeenCalled();
    expect(rows.size).toBe(1);
    expect(controller.getSnapshot().recordingRecovery?.phase).toBe("interrupted");
    controller.dispose();
  });

  it.each(["cancel", "delete"] as const)("does not restore a recording from a late detail response after %s", async (action) => {
    const { storage, rows } = recordingStorageFixture();
    await storage.save({ accountId: "user_1", operationKey: "late-detail", file: file(), sourceOrigin: "user_reflection", recordingDate: "2026-08-13", submitted: true });
    const get = vi.fn(async () => detail("known", "failed"));
    const controller = new DailyReflectionSessionController({ recordingStorage: storage, api: fakeApi({ get,
      getOperation: async () => ({ found: true, uploadState: "unresolved", status: "failed", reflectionId: "known", uploadId: "u_known", jobId: "j_known", contentHash: "a".repeat(64) })
    }) });
    await controller.initialize();
    const late = deferred<DailyReflectionDetailResponse>();
    get.mockImplementationOnce(() => late.promise);
    const read = controller.reload("known");
    get.mockResolvedValue(detail("known", "cancelled"));
    await controller[action]();
    late.resolve(detail("known", "review_pending"));
    await read;
    expect(controller.getSnapshot().recordingRecovery).toBeNull();
    expect(controller.getSnapshot().state).not.toBe("review_pending");
    expect(rows.size).toBe(0);
    controller.dispose();
  });

  it("keeps the upload and original bytes through history navigation, startNew and view detachment", async () => {
    const pending = deferred<Awaited<ReturnType<DailyReflectionApi["uploadBrowserRecording"]>>>();
    let signal: AbortSignal | undefined;
    const upload = vi.fn((_input, nextSignal) => { signal = nextSignal; return pending.promise; });
    const { storage, rows } = recordingStorageFixture();
    const controller = new DailyReflectionSessionController({ api: fakeApi({ uploadBrowserRecording: upload }), recordingStorage: storage });
    await controller.initialize();
    const original = file();
    const work = controller.uploadBrowserRecording(original, 3000, "2026-08-13", "nav-key", "direct_conversation");
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
    await controller.reload("another-reflection");
    expect(signal?.aborted).toBe(false);
    expect(controller.getSnapshot().recordingRecovery?.file).toBe(original);
    controller.startNew();
    expect(signal?.aborted).toBe(false);
    await controller.reload("another-reflection");
    controller.detachView();
    pending.resolve({ ...operationReceipt("uploaded", "browser_recorder"), operationKey: "nav-key" });
    await work;
    expect(controller.getSnapshot().reflectionId).toBe("another-reflection");
    expect(controller.getSnapshot().recordingRecovery).toMatchObject({ phase: "saved", reflectionId: "uploaded", file: null });
    expect(rows.size).toBe(0);
    expect(upload).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("keeps the local audio for a reserved persistencePending receipt", async () => {
    const { storage, rows } = recordingStorageFixture();
    const controller = new DailyReflectionSessionController({ recordingStorage: storage, api: fakeApi({
      uploadBrowserRecording: async () => ({ ...operationReceipt(), persistencePending: true }),
      get: async () => detail("reflection_1", "failed")
    }) });
    await controller.initialize();
    await controller.uploadBrowserRecording(file(), 3000, "2026-08-13", "pending-key");
    expect(rows.get("user_1")?.file.size).toBeGreaterThan(0);
    expect(controller.getSnapshot().recordingRecovery).toMatchObject({ phase: "interrupted", reflectionId: "reflection_1" });
    controller.dispose();
  });

  it("retries the exact bytes, source, date and key only after lookup finds no operation", async () => {
    const { storage } = recordingStorageFixture();
    const upload = vi.fn().mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce({ ...operationReceipt(), operationKey: "retry-key" });
    const lookup = vi.fn(async () => ({ found: false as const }));
    const controller = new DailyReflectionSessionController({ recordingStorage: storage, api: fakeApi({ uploadBrowserRecording: upload, getOperation: lookup }) });
    await controller.initialize();
    const original = file();
    await controller.uploadBrowserRecording(original, 3456, "2026-08-13", "retry-key", "direct_conversation");
    expect(controller.getSnapshot().recordingRecovery?.file).toBe(original);
    await controller.retryRecordingUpload();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[1][0]).toEqual(upload.mock.calls[0][0]);
    expect(upload.mock.calls[1][0].file).toBe(original);
    expect(lookup).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("recovers a lost receipt without a second POST", async () => {
    const { storage, rows } = recordingStorageFixture();
    const upload = vi.fn(async () => { throw new TypeError("lost response"); });
    const controller = new DailyReflectionSessionController({ recordingStorage: storage, api: fakeApi({ uploadBrowserRecording: upload,
      getOperation: async () => ({ found: true, uploadState: "accepted", reflectionId: "received", uploadId: "upload_received", jobId: "job_received", contentHash: "a".repeat(64), status: "review_pending" })
    }) });
    await controller.initialize();
    await controller.uploadBrowserRecording(file(), 3000, "2026-08-13", "lost-key");
    await controller.retryRecordingUpload();
    expect(upload).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().recordingRecovery?.phase).toBe("saved");
    expect(rows.size).toBe(0);
    controller.dispose();
  });

  it("restores an unsubmitted recording after refresh without inventing its source or POSTing", async () => {
    const { storage } = recordingStorageFixture();
    const first = new DailyReflectionSessionController({ recordingStorage: storage, api: fakeApi() });
    await first.initialize();
    await first.preserveRecording({ file: file(), sourceOrigin: null, recordingDate: "2026-08-13", operationKey: "draft-key" });
    first.dispose();
    const upload = vi.fn();
    const next = new DailyReflectionSessionController({ recordingStorage: storage, api: fakeApi({ uploadBrowserRecording: upload }) });
    await next.initialize();
    expect(next.getSnapshot().recordingRecovery).toMatchObject({ phase: "draft", sourceOrigin: null, operationKey: "draft-key", localCopy: "saved" });
    await next.retryRecordingUpload();
    expect(upload).not.toHaveBeenCalled();
    next.dispose();
  });

  it("keeps an in-memory download when local storage is unavailable", async () => {
    const original = file();
    const controller = new DailyReflectionSessionController({ api: fakeApi(), recordingStorage: {
      load: async () => null, save: async () => { throw new Error("quota"); }, remove: async () => undefined
    } });
    await controller.initialize();
    await controller.preserveRecording({ file: original, sourceOrigin: null, recordingDate: "2026-08-13", operationKey: "quota-key" });
    expect(controller.getSnapshot().recordingRecovery).toMatchObject({ file: original, localCopy: "unavailable" });
    controller.dispose();
  });

  it("isolates account switching and ignores the old account's late response", async () => {
    const { storage, rows } = recordingStorageFixture();
    const pending = deferred<Awaited<ReturnType<DailyReflectionApi["uploadBrowserRecording"]>>>();
    let accountId = "user_1";
    const upload = vi.fn(() => pending.promise);
    const controller = new DailyReflectionSessionController({ recordingStorage: storage, api: fakeApi({
      getCurrentUser: async () => ({ id: accountId, email: "fixture@example.com" }), uploadBrowserRecording: upload
    }) });
    await controller.initialize();
    const work = controller.uploadBrowserRecording(file(), 3000, "2026-08-13", "account-key");
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
    accountId = "user_2";
    await controller.initialize();
    pending.resolve(operationReceipt());
    await work;
    expect(controller.getSnapshot().recordingRecovery).toBeNull();
    expect(controller.getSnapshot().reflectionId).toBeNull();
    expect(rows.has("user_1")).toBe(true);
    controller.dispose();
  });

  it.each(["deleted", "cancelled"] as const)("does not restore a %s operation from a local backup", async (status) => {
    const { storage, rows } = recordingStorageFixture();
    await storage.save({ accountId: "user_1", operationKey: "ended-key", file: file(), sourceOrigin: "user_reflection", recordingDate: "2026-08-13", submitted: true });
    const upload = vi.fn();
    const controller = new DailyReflectionSessionController({ recordingStorage: storage, api: fakeApi({ uploadBrowserRecording: upload,
      getOperation: async () => ({ found: true, uploadState: "terminated", status, reflectionId: "ended", uploadId: "upload_ended", jobId: "job_ended", contentHash: "a".repeat(64) })
    }) });
    await controller.initialize();
    await controller.retryRecordingUpload();
    expect(rows.size).toBe(0);
    expect(controller.getSnapshot().recordingRecovery).toBeNull();
    expect(upload).not.toHaveBeenCalled();
    controller.dispose();
  });
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
    uploadRequest.resolve({ ...operationReceipt(), operationKey: "stable-key" });

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
      operationKey: "stable-key",
      inputAdapter: "file_picker",
      capturePurpose: "inspiration_capture"
    }, expect.any(AbortSignal));
    expect(controller.getSnapshot().operationReceipt).toMatchObject({
      reflectionId: "reflection_1",
      operationKey: "stable-key"
    });

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
    await vi.waitFor(() => expect(uploadBrowserRecording).toHaveBeenCalledTimes(1));
    expect(uploadBrowserRecording).toHaveBeenCalledWith({
      file,
      clientReportedDurationMs: 181_000,
      recordingDate: "2026-08-13",
      operationKey: "stable-browser-key",
      inputAdapter: "browser_recorder",
      sourceOrigin: "user_reflection",
      capturePurpose: "inspiration_capture"
    }, expect.any(AbortSignal));

    uploadRequest.resolve({
      ...operationReceipt("reflection_browser_1", "browser_recorder"),
      operationKey: "stable-browser-key"
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

    await vi.waitFor(() => expect(uploadBrowserRecording).toHaveBeenCalledTimes(1));
    expect(uploadBrowserRecording).toHaveBeenCalledWith({
      file,
      recordingDate: "2026-08-13",
      operationKey: "stable-browser-key",
      inputAdapter: "browser_recorder",
      sourceOrigin: "user_reflection",
      capturePurpose: "inspiration_capture"
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
      ...operationReceipt("reflection_toy_1", "toy_sync"),
      operationKey: "daily-reflection-toy-stable",
      executionMode: "inline" as const,
      recordingDate: "2026-08-18"
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
      operationKey: "daily-reflection-toy-stable",
      inputAdapter: "toy_sync"
    })).resolves.toBe(true);
    expect(upload).toHaveBeenCalledWith({
      file,
      sourceOrigin: "user_reflection",
      recordingDate: "2026-08-18",
      operationKey: "daily-reflection-toy-stable",
      inputAdapter: "toy_sync",
      capturePurpose: "inspiration_capture"
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
      { operationKey: "daily-reflection-toy-stable", inputAdapter: "toy_sync" }
    )).resolves.toBe(false);
    expect(controller.getSnapshot().state).toBe("error");
  });

  it("adopts the durable operation receipt after an upload response is lost without posting twice", async () => {
    const upload = vi.fn(async () => {
      throw new DailyReflectionApiError(0, "network_error");
    });
    const getOperation = vi.fn(async () => ({
      found: true as const,
      uploadState: "accepted" as const,
      reflectionId: "reflection_recovered",
      uploadId: "upload_reflection_recovered",
      jobId: "job_reflection_recovered",
      contentHash: "b".repeat(64),
      status: "review_pending" as const
    }));
    const get = vi.fn(async () => detail("reflection_recovered", "review_pending", 100));
    const controller = new DailyReflectionSessionController({
      api: fakeApi({ upload, getOperation, get }),
      pollIntervalMs: 0,
      createIdempotencyKey: () => "lost-response-operation"
    });
    await controller.initialize();

    await expect(controller.upload(
      new File(["audio"], "reflection.wav", { type: "audio/wav" }),
      "user_reflection",
      "2026-08-13"
    )).resolves.toBe(true);

    expect(upload).toHaveBeenCalledOnce();
    expect(getOperation).toHaveBeenCalledWith("lost-response-operation", expect.any(AbortSignal));
    expect(get).toHaveBeenCalledWith("reflection_recovered", expect.any(AbortSignal));
    expect(controller.getSnapshot()).toMatchObject({
      reflectionId: "reflection_recovered",
      state: "review_pending",
      operation: "idle"
    });
  });

  it("recovers a persisted pending operation on page initialization", async () => {
    storePendingInputOperation(window.localStorage, "pending-operation");
    const getOperation = vi.fn(async () => ({
      found: true as const,
      uploadState: "accepted" as const,
      reflectionId: "reflection_recovered",
      uploadId: "upload_reflection_recovered",
      jobId: "job_reflection_recovered",
      contentHash: "c".repeat(64),
      status: "review_pending" as const
    }));
    const get = vi.fn(async () => detail("reflection_recovered", "review_pending", 100));
    const controller = new DailyReflectionSessionController({
      api: fakeApi({ getOperation, get }),
      pollIntervalMs: 0
    });

    await controller.initialize();

    expect(getOperation).toHaveBeenCalledWith("pending-operation", expect.any(AbortSignal));
    expect(controller.getSnapshot()).toMatchObject({
      reflectionId: "reflection_recovered",
      state: "review_pending"
    });
  });

  it("does not lookup or adopt a different record after a fail-closed upload conflict", async () => {
    const getOperation = vi.fn(async () => ({ found: false as const }));
    const upload = vi.fn(async () => {
      throw new DailyReflectionApiError(409, "operation_payload_conflict");
    });
    const controller = new DailyReflectionSessionController({
      api: fakeApi({ upload, getOperation }),
      createIdempotencyKey: () => "conflicting-operation"
    });
    await controller.initialize();

    await expect(controller.upload(
      new File(["audio"], "reflection.wav", { type: "audio/wav" }),
      "user_reflection",
      "2026-08-13"
    )).resolves.toBe(false);

    expect(getOperation).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ state: "error", reflectionId: null });
  });

  it("keeps the upload receipt true when later processing status refresh fails", async () => {
    const upload = vi.fn(async () => ({
      ...operationReceipt("reflection_toy_receipt", "toy_sync"),
      operationKey: "daily-reflection-toy-stable",
      executionMode: "inline" as const,
      recordingDate: "2026-08-18"
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
      { operationKey: "daily-reflection-toy-stable", inputAdapter: "toy_sync" }
    )).resolves.toBe(true);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({
      reflectionId: "reflection_toy_receipt",
      state: "error"
    });
  });

  it("saves one candidate decision, reloads server truth, and never writes a Person", async () => {
    const pending = reviewDetail(3);
    const keptCandidate = reviewCandidate("kept", {
      userText: "今天做出了重要决定。",
      subjectPersonId: null,
      subjectConfirmed: false,
      version: 1
    });
    const kept = reviewDetail(4, [keptCandidate]);
    const get = vi.fn()
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(kept);
    const updateCandidates = vi.fn(async () => ({
      reflection: kept.reflection,
      candidates: []
    }));
    const controller = new DailyReflectionSessionController({
      api: fakeApi({ get, updateCandidates })
    });
    await controller.initialize("reflection_1");

    await controller.updateCandidate({
      candidateId: "candidate_1",
      status: "kept",
      userText: "今天做出了重要决定。",
      subjectPersonId: null
    });

    expect(updateCandidates).toHaveBeenCalledWith("reflection_1", {
      expectedVersion: 3,
      candidates: [{
        candidateId: "candidate_1",
        status: "kept",
        userText: "今天做出了重要决定。",
        subjectPersonId: null
      }]
    }, expect.any(AbortSignal));
    expect(get).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject({
      state: "review_pending",
      operation: "idle",
      detail: { reflection: { version: 4 } }
    });
  });

  it("accepts all candidates in one versioned mutation and preserves an unclaimed action", async () => {
    const ordinary = reviewCandidate("pending");
    const action = reviewCandidateV2();
    const ready = reviewDetail(3, [ordinary, action]);
    const accepted = reviewDetail(4, [
      { ...ordinary, status: "kept" as const, version: 1 },
      { ...action, status: "kept" as const, version: 1 }
    ]);
    const get = vi.fn()
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(accepted);
    const updateCandidates = vi.fn(async () => ({
      reflection: accepted.reflection,
      candidates: []
    }));
    const controller = new DailyReflectionSessionController({
      api: fakeApi({ get, updateCandidates })
    });
    await controller.initialize("reflection_1");

    await controller.acceptAllCandidates();

    expect(updateCandidates).toHaveBeenCalledWith("reflection_1", {
      expectedVersion: 3,
      candidates: [{
        candidateId: ordinary.id,
        status: "kept",
        userText: null,
        subjectPersonId: null
      }, {
        candidateId: action.id,
        status: "kept",
        userText: null,
        subjectPersonId: null,
        actionClaimed: false
      }]
    }, expect.any(AbortSignal));
    expect(controller.getSnapshot().detail?.candidates).toEqual(accepted.candidates);
  });

  it("bulk-keeps only Primary Cards and never claims an action", async () => {
    const primaryAction = reviewCard("card_primary", "primary", "user_action");
    const moreInsight = reviewCard("card_more", "more");
    const ready = {
      ...reviewDetail(3, []),
      cards: [primaryAction, moreInsight]
    };
    const accepted = {
      ...ready,
      reflection: { ...ready.reflection, version: 4 },
      cards: [{ ...primaryAction, reviewStatus: "kept" as const, version: 1 }, moreInsight]
    };
    const get = vi.fn()
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(accepted);
    const updateCards = vi.fn(async (
      _reflectionId: string,
      _input: DailyReflectionCardUpdateRequest,
      _signal?: AbortSignal
    ) => ({
      reflection: accepted.reflection,
      cards: accepted.cards
    }));
    const controller = new DailyReflectionSessionController({
      api: fakeApi({ get, updateCards })
    });
    await controller.initialize("reflection_1");

    await controller.acceptAllCandidates();

    expect(updateCards).toHaveBeenCalledWith("reflection_1", {
      expectedVersion: 3,
      cards: [{
        cardId: primaryAction.id,
        reviewStatus: "kept",
        userTitle: null,
        userText: null
      }]
    }, expect.any(AbortSignal));
    expect(updateCards.mock.calls[0]?.[1].cards[0]).not.toHaveProperty("actionClaimed");
    expect(updateCards.mock.calls[0]?.[1].cards).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ cardId: moreInsight.id })])
    );
  });

  it("saves a Working Card without invoking finalize or Memory admission", async () => {
    const card = reviewCard("card_working", "primary", "insight");
    const ready = { ...reviewDetail(3, []), cards: [card] };
    const saveWorkingCard = vi.fn(async () => workingCardDetail("saved", 1));
    const archiveWorkingCard = vi.fn(async () => workingCardDetail("archived", 2));
    const restoreWorkingCard = vi.fn(async () => workingCardDetail("saved", 3));
    const removeWorkingCard = vi.fn(async () => workingCardDetail("removed", 4));
    const finalize = vi.fn(async () => {
      throw new Error("finalize must not run for Working Card save");
    });
    const controller = new DailyReflectionSessionController({
      api: fakeApi({
        get: async () => ready,
        saveWorkingCard,
        archiveWorkingCard,
        restoreWorkingCard,
        removeWorkingCard,
        finalize
      })
    });
    await controller.initialize("reflection_1");

    expect(await controller.saveWorkingCard(card.id)).toBe(true);

    expect(saveWorkingCard).toHaveBeenCalledWith(
      "reflection_1",
      card.id,
      { expectedVersion: card.version },
      expect.any(AbortSignal)
    );
    expect(finalize).not.toHaveBeenCalled();
    await controller.archiveWorkingCard(card.id);
    await controller.restoreWorkingCard(card.id);
    await controller.removeWorkingCard(card.id);
    expect(archiveWorkingCard).toHaveBeenCalledWith(
      card.id,
      { expectedVersion: 1 },
      expect.any(AbortSignal)
    );
    expect(restoreWorkingCard).toHaveBeenCalledWith(
      card.id,
      { expectedVersion: 2 },
      expect.any(AbortSignal)
    );
    expect(removeWorkingCard).toHaveBeenCalledWith(
      card.id,
      { expectedVersion: 3 },
      expect.any(AbortSignal)
    );
    expect(finalize).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      operation: "idle",
      activeCandidateId: null,
      workingCardStates: { [card.id]: { status: "removed", version: 4 } },
      errorMessage: null
    });
  });

  it("hydrates saved Working Card lifecycle state and replaces it on reload", async () => {
    const card = reviewCard("card_working", "primary", "insight");
    const get = vi.fn()
      .mockResolvedValueOnce({
        ...reviewDetail(3, []),
        cards: [card],
        workingCards: [{ id: card.id, status: "archived", version: 7 }]
      })
      .mockResolvedValueOnce({
        ...reviewDetail(3, []),
        cards: [card],
        workingCards: [{ id: card.id, status: "removed", version: 8 }]
      })
      .mockResolvedValueOnce({
        ...reviewDetail(3, []),
        cards: [card],
        workingCards: []
      });
    const restoreWorkingCard = vi.fn(async () => workingCardDetail("saved", 8));
    const controller = new DailyReflectionSessionController({
      api: fakeApi({ get, restoreWorkingCard })
    });

    await controller.initialize("reflection_1");
    expect(controller.getSnapshot().workingCardStates).toEqual({
      [card.id]: { status: "archived", version: 7 }
    });
    await controller.restoreWorkingCard(card.id);
    expect(restoreWorkingCard).toHaveBeenCalledWith(
      card.id,
      { expectedVersion: 7 },
      expect.any(AbortSignal)
    );

    await controller.reload("reflection_1");
    expect(controller.getSnapshot().workingCardStates).toEqual({
      [card.id]: { status: "removed", version: 8 }
    });
    await controller.reload("reflection_1");
    expect(controller.getSnapshot().workingCardStates).toEqual({});
  });

  it("persists edited Card text before saving it without finalizing", async () => {
    const card = reviewCard("card_working", "primary", "insight");
    const ready = { ...reviewDetail(3, []), cards: [card], workingCards: [] };
    const editedCard = {
      ...card,
      userTitle: "用户编辑后的标题",
      userText: "用户编辑后的内容",
      version: 1
    };
    const updateCards = vi.fn(async () => ({
      reflection: { ...ready.reflection, version: 4 },
      cards: [editedCard]
    }));
    const saveWorkingCard = vi.fn(async () => workingCardDetail("saved", 2));
    const finalize = vi.fn(async () => {
      throw new Error("finalize must not run for Working Card save");
    });
    const controller = new DailyReflectionSessionController({
      api: fakeApi({
        get: async () => ready,
        updateCards,
        saveWorkingCard,
        finalize
      })
    });
    await controller.initialize("reflection_1");

    expect(await controller.saveWorkingCard(card.id, {
      userTitle: editedCard.userTitle,
      userText: editedCard.userText
    })).toBe(true);

    expect(updateCards).toHaveBeenCalledWith("reflection_1", {
      expectedVersion: 3,
      cards: [{
        cardId: card.id,
        reviewStatus: card.reviewStatus,
        userTitle: editedCard.userTitle,
        userText: editedCard.userText
      }]
    }, expect.any(AbortSignal));
    expect(saveWorkingCard).toHaveBeenCalledWith(
      "reflection_1",
      card.id,
      { expectedVersion: editedCard.version },
      expect.any(AbortSignal)
    );
    expect(controller.getSnapshot()).toMatchObject({
      detail: {
        reflection: { version: 4 },
        cards: [{
          id: card.id,
          userTitle: editedCard.userTitle,
          userText: editedCard.userText
        }]
      },
      workingCardStates: { [card.id]: { status: "saved", version: 2 } }
    });
    expect(finalize).not.toHaveBeenCalled();
  });

  it("does not save stale text when the pre-save Card update conflicts", async () => {
    const card = reviewCard("card_working", "primary", "insight");
    const ready = { ...reviewDetail(3, []), cards: [card], workingCards: [] };
    const fresh = {
      ...reviewDetail(4, []),
      cards: [{ ...card, userText: "其他页面的内容", version: 1 }],
      workingCards: []
    };
    const get = vi.fn().mockResolvedValueOnce(ready).mockResolvedValueOnce(fresh);
    const updateCards = vi.fn(async () => {
      throw new DailyReflectionApiError(409, "version_conflict");
    });
    const saveWorkingCard = vi.fn(async () => workingCardDetail("saved", 1));
    const controller = new DailyReflectionSessionController({
      api: fakeApi({ get, updateCards, saveWorkingCard })
    });
    await controller.initialize("reflection_1");

    expect(await controller.saveWorkingCard(card.id, {
      userTitle: null,
      userText: "本页尚未保存的内容"
    })).toBe(false);

    expect(saveWorkingCard).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot()).toMatchObject({
      detail: { reflection: { version: 4 } },
      workingCardStates: {}
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

  it("persists an explicit action claim without inferring it from candidate kind", async () => {
    const pendingAction = reviewCandidateV2();
    const claimedAction = reviewCandidateV2("pending", {
      actionClaimed: true,
      candidateType: "commitment",
      version: 1
    });
    const get = vi.fn()
      .mockResolvedValueOnce(reviewDetail(4, [pendingAction]))
      .mockResolvedValueOnce(reviewDetail(5, [claimedAction]));
    const updateCandidates = vi.fn(async () => ({
      reflection: reviewDetail(5, [claimedAction]).reflection,
      candidates: []
    }));
    const controller = new DailyReflectionSessionController({
      api: fakeApi({ get, updateCandidates })
    });
    await controller.initialize("reflection_1");

    await controller.updateCandidate({
      candidateId: pendingAction.id,
      status: "pending",
      userText: null,
      subjectPersonId: null,
      actionClaimed: true
    });

    expect(updateCandidates).toHaveBeenCalledWith("reflection_1", {
      expectedVersion: 4,
      candidates: [expect.objectContaining({ actionClaimed: true })]
    }, expect.any(AbortSignal));
    expect(controller.getSnapshot().detail?.candidates[0]).toMatchObject({
      actionClaimed: true,
      candidateType: "commitment"
    });
  });

  it("creates an Evidence-free manual card for recap only, then reloads server truth", async () => {
    const failed = detail("reflection_1", "failed");
    const manual = reviewCandidateV2("pending", {
      id: "manual_candidate",
      candidateKind: "insight",
      proposedText: "这是我手写补充的一点。",
      candidateType: "summary",
      evidenceIds: [],
      sourceSegmentIds: [],
      evidence: [],
      confidence: 1,
      caution: "这是你手写补充的内容，请按原话核对。"
    });
    const recovered = reviewDetail(5, [manual]);
    const get = vi.fn()
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(recovered);
    const { evidence: _evidence, ...manualCandidate } = manual;
    const createManualCandidate = vi.fn(async () => ({
      reflection: recovered.reflection,
      candidate: manualCandidate,
      retentionEligibility: "recap_only" as const
    }));
    const controller = new DailyReflectionSessionController({
      api: fakeApi({ get, createManualCandidate })
    });
    await controller.initialize("reflection_1");

    await controller.createManualCandidate({
      candidateKind: "insight",
      proposedText: "这是我手写补充的一点。",
      evidenceIds: [],
      confidence: 1,
      caution: "这是你手写补充的内容，请按原话核对。",
      actionClaimed: false
    });

    expect(createManualCandidate).toHaveBeenCalledWith("reflection_1", {
      expectedVersion: 1,
      candidateKind: "insight",
      proposedText: "这是我手写补充的一点。",
      evidenceIds: [],
      confidence: 1,
      caution: "这是你手写补充的内容，请按原话核对。",
      actionClaimed: false
    }, expect.any(AbortSignal));
    expect(controller.getSnapshot()).toMatchObject({
      state: "review_pending",
      operation: "idle",
      detail: { candidates: [{ id: "manual_candidate", evidence: [] }] }
    });
  });

  it("excludes one V2 card through DELETE and reloads the recoverable result", async () => {
    const candidate = reviewCandidateV2("kept");
    const excluded = reviewCandidateV2("excluded", { version: 1 });
    const current = reviewDetail(6, [candidate]);
    const refreshed = reviewDetail(7, [excluded]);
    const get = vi.fn()
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(refreshed);
    const { evidence: _evidence, ...excludedCandidate } = excluded;
    const excludeCandidate = vi.fn(async () => ({
      reflection: refreshed.reflection,
      candidate: excludedCandidate,
      disposition: "excluded" as const,
      recoverable: true as const
    }));
    const controller = new DailyReflectionSessionController({
      api: fakeApi({ get, excludeCandidate })
    });
    await controller.initialize("reflection_1");

    await controller.excludeCandidate(candidate.id);

    expect(excludeCandidate).toHaveBeenCalledWith("reflection_1", candidate.id, {
      expectedVersion: 6
    }, expect.any(AbortSignal));
    expect(controller.getSnapshot()).toMatchObject({
      operation: "idle",
      detail: { candidates: [{ status: "excluded" }] }
    });
  });

  it("records recap-only as its own intent and keeps pending cards inside the recap", async () => {
    const storageValues = new Map<string, string>();
    const storage = {
      getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => { storageValues.set(key, value); },
      removeItem: (key: string) => { storageValues.delete(key); }
    };
    storeOperationReceipt(storageValues);
    const pending = reviewCandidateV2();
    const ready = reviewDetail(1, [pending]);
    const kept = { ...pending, status: "kept" as const, version: 1 };
    const updated = reviewDetail(2, [kept]);
    const completed = recapOnlyCompletedDetail(kept);
    const confirmation = completed.confirmation;
    if (!confirmation || !("contractVersion" in confirmation)) {
      throw new Error("expected a V2 confirmation fixture");
    }
    const get = vi.fn()
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(updated)
      .mockResolvedValueOnce(completed);
    const updateCandidates = vi.fn(async () => ({
      reflection: updated.reflection,
      candidates: []
    }));
    const finalize = vi.fn(async () => ({
      reflection: completed.reflection,
      confirmation,
      admission: { exists: false as const },
      reused: false
    }));
    const controller = new DailyReflectionSessionController({
      api: fakeApi({ get, updateCandidates, finalize }),
      pollIntervalMs: 0,
      storage
    });
    await controller.initialize("reflection_1");

    await controller.finalize("recap_only");

    expect(updateCandidates).toHaveBeenCalledWith("reflection_1", {
      expectedVersion: 1,
      candidates: [{
        candidateId: pending.id,
        status: "kept",
        userText: null,
        subjectPersonId: null,
        actionClaimed: false
      }]
    }, expect.any(AbortSignal));
    expect(finalize).toHaveBeenCalledWith("reflection_1", {
      expectedVersion: 2,
      operationKey: "operation_reflection_1",
      saveIntent: "recap_only"
    }, expect.any(AbortSignal));
    expect(controller.getSnapshot()).toMatchObject({
      state: "completed",
      detail: {
        confirmation: { saveIntent: "recap_only" },
        admissionOperation: null
      }
    });
  });

  it("reuses the same finalize key and expected version after response loss and refresh", async () => {
    const storageValues = new Map<string, string>();
    const storage = {
      getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => { storageValues.set(key, value); },
      removeItem: (key: string) => { storageValues.delete(key); }
    };
    storeOperationReceipt(storageValues);
    const keptCandidate = reviewCandidate("kept", { version: 1 });
    const ready = reviewDetail(7, [keptCandidate]);
    const firstFinalize = vi.fn(async () => {
      throw new DailyReflectionApiError(0, "network_error", "网络连接失败，请检查网络后重试。");
    });
    const first = new DailyReflectionSessionController({
      api: fakeApi({ get: async () => ready, finalize: firstFinalize }),
      storage
    });
    await first.initialize("reflection_1");
    await first.finalize("retain_selected");
    expect(first.getSnapshot()).toMatchObject({
      state: "review_pending",
      operation: "idle",
      errorMessage: "网络连接失败，请检查网络后重试。"
    });
    await first.finalize("recap_only");
    expect(firstFinalize).toHaveBeenCalledTimes(1);
    expect(first.getSnapshot().errorMessage).toBe(
      "上一次“保存并长期保留”的请求仍待确认，请继续使用原来的保存方式。"
    );
    first.dispose();

    const completed = confirmedDetail("completed", keptCandidate);
    const confirmation = completed.confirmation;
    if (!confirmation || !("contractVersion" in confirmation)) {
      throw new Error("expected a V2 confirmation fixture");
    }
    const admissionOperation = completed.admissionOperation!;
    const get = vi.fn()
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(completed);
    const secondFinalize = vi.fn(async () => ({
      reflection: completed.reflection,
      confirmation,
      admission: { exists: true as const, operation: admissionOperation, results: [] },
      reused: true
    }));
    const second = new DailyReflectionSessionController({
      api: fakeApi({ get, finalize: secondFinalize }),
      storage
    });
    await second.initialize("reflection_1");
    await second.finalize("retain_selected");

    expect(firstFinalize).toHaveBeenCalledWith("reflection_1", {
      expectedVersion: 7,
      operationKey: "operation_reflection_1",
      saveIntent: "retain_selected"
    }, expect.any(AbortSignal));
    expect(secondFinalize).toHaveBeenCalledWith("reflection_1", {
      expectedVersion: 7,
      operationKey: "operation_reflection_1",
      saveIntent: "retain_selected"
    }, expect.any(AbortSignal));
    expect(second.getSnapshot()).toMatchObject({
      state: "completed",
      operation: "idle",
      detail: { admissionOperation: { admittedCount: 1 } }
    });
    expect([...storageValues.keys()]).toEqual([
      "daily-reflection:operation-receipt:v2:user_1:reflection_1"
    ]);
  });

  it("keeps polling confirmation and admission phases until completion", async () => {
    const storageValues = new Map<string, string>();
    storeOperationReceipt(storageValues);
    const storage = {
      getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => { storageValues.set(key, value); },
      removeItem: (key: string) => { storageValues.delete(key); }
    };
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
    const confirmation = confirmationReady.confirmation;
    if (!confirmation || !("contractVersion" in confirmation)) {
      throw new Error("expected a V2 confirmation fixture");
    }
    const finalize = vi.fn(async () => ({
      reflection: confirmationReady.reflection,
      confirmation,
      admission: {
        exists: true as const,
        operation: confirmationReady.admissionOperation!,
        results: []
      },
      reused: false
    }));
    const controller = new DailyReflectionSessionController({
      api: fakeApi({ get, finalize }),
      pollIntervalMs: 0,
      storage
    });
    await controller.initialize("reflection_1");

    await controller.finalize("retain_selected");

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
    storeOperationReceipt(storageValues);
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
        admission: {
          exists: true as const,
          operation: completed.admissionOperation!,
          results: []
        },
        reused: true
      });
    const controller = new DailyReflectionSessionController({
      api: fakeApi({ get, finalize }),
      pollIntervalMs: 0,
      storage
    });
    await controller.initialize("reflection_1");

    await controller.finalize("retain_selected");
    expect(controller.getSnapshot()).toMatchObject({
      state: "admission_failed",
      operation: "idle"
    });
    expect(storageValues.size).toBe(2);

    await controller.finalize("retain_selected");
    expect(finalize).toHaveBeenCalledTimes(2);
    expect(finalize.mock.calls.map((call) => call[1])).toEqual([
      {
        expectedVersion: 7,
        operationKey: "operation_reflection_1",
        saveIntent: "retain_selected"
      },
      {
        expectedVersion: 7,
        operationKey: "operation_reflection_1",
        saveIntent: "retain_selected"
      }
    ]);
    expect(controller.getSnapshot()).toMatchObject({
      state: "completed",
      operation: "idle"
    });
    expect([...storageValues.keys()]).toEqual([
      "daily-reflection:operation-receipt:v2:user_1:reflection_1"
    ]);
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
