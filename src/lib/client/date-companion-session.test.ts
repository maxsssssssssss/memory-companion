import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseDayPayload, type DayPayload } from "@/lib/domain/day-payload";
import type { ToyIngestionReceipt } from "@/lib/domain/date-companion";
import type { DcRelationshipView } from "@/lib/domain/date-companion-stage2";
import type { QuestionAnswer } from "@/lib/domain/types";

import {
  DateCompanionApiError,
  type DateCompanionApi,
  type DateCompanionToyUploadRequest
} from "./date-companion-api";
import {
  DateCompanionSessionController,
  type DateCompanionCache
} from "./date-companion-session";

function payload(uploadId = "upload_1", status: "processing" | "ready" | "failed" = "ready"): DayPayload {
  return parseDayPayload({
    upload: {
      id: uploadId,
      originalName: `${uploadId}.m4a`,
      mimeType: "audio/mp4",
      sizeBytes: 2048,
      recordingDate: "2026-08-04",
      createdAt: "2026-08-04T10:00:00.000Z",
      durationSeconds: 10,
      status
    },
    job: {
      id: `job_${uploadId}`,
      uploadId,
      status,
      progress: status === "ready" ? 100 : 40,
      ...(status === "failed" ? { errorMessage: "provider failed" } : {})
    },
    segments: [],
    audioInsights: [],
    semanticSegments: [],
    semanticSegmentsAvailable: status === "ready",
    briefItems: [],
    relationshipSignals: [],
    relationshipSignalsAvailable: status === "ready",
    proactiveInsights: [],
    proactiveInsightsAvailable: status === "ready",
    speakerAliases: {},
    speakerAliasesByUploadId: { [uploadId]: {} }
  });
}

function answer(id: string, uploadId = "relationship_1"): QuestionAnswer {
  return {
    id,
    uploadId,
    question: `question ${id}`,
    answer: `answer ${id}`,
    citedSegmentIds: [],
    citations: [],
    createdAt: "2026-08-04T12:00:00.000Z"
  };
}

function relationshipView(uploadIds: string[] = []): DcRelationshipView {
  return {
    relationship: {
      id: "relationship_1",
      displayName: "Ta",
      status: "active",
      version: 0,
      createdAt: "2026-08-04T09:00:00.000Z",
      updatedAt: "2026-08-04T09:00:00.000Z"
    },
    interactions: uploadIds.map((uploadId, index) => ({
      id: `interaction_${index + 1}`,
      relationshipId: "relationship_1",
      sourceUploadId: uploadId,
      recordingDate: "2026-08-04",
      originalName: `${uploadId}.m4a`,
      durationSeconds: 10,
      status: "draft",
      sourceState: "available",
      version: 0,
      createdAt: "2026-08-04T10:00:00.000Z",
      updatedAt: "2026-08-04T10:00:00.000Z",
      participants: [],
      recapItems: []
    })),
    promises: []
  };
}

function toyReceipt(
  overrides: Partial<ToyIngestionReceipt> = {}
): ToyIngestionReceipt {
  return {
    receiptId: "receipt_1",
    operationKey: `toyop_v1_${"a".repeat(64)}`,
    destination: "date_companion",
    relationshipId: "relationship_1",
    uploadId: "upload_1",
    jobId: "job_1",
    state: "accepted",
    decision: "accepted",
    recordingDate: "2026-08-04",
    serverAcceptedAt: "2026-08-04T10:00:00.000Z",
    ...overrides
  };
}

function confirmedPersonCatalogView(): DcRelationshipView {
  const now = "2026-08-11T10:00:00.000Z";
  return {
    relationship: {
      id: "relationship_1",
      displayName: "Ta",
      status: "active",
      version: 1,
      createdAt: now,
      updatedAt: now
    },
    interactions: [{
      id: "interaction_1",
      relationshipId: "relationship_1",
      sourceUploadId: "upload_1",
      recordingDate: "2026-08-10",
      originalName: "date.wav",
      status: "confirmed",
      sourceState: "server_cleaned",
      version: 2,
      createdAt: now,
      updatedAt: now,
      confirmedAt: now,
      memoryBridge: { status: "completed", attemptCount: 1, updatedAt: now, retryable: false },
      participants: [{ speakerId: "speaker_ta", role: "companion", confirmedAt: now }],
      recapItems: [{
        id: "recap_1",
        interactionId: "interaction_1",
        kind: "mentioned",
        proposedText: "Ta 喜欢摄影。",
        displayedText: "Ta 喜欢摄影。",
        disposition: "kept",
        version: 1,
        sortOrder: 0,
        evidence: [{
          id: "snapshot_1",
          recapItemId: "recap_1",
          uploadId: "upload_1",
          sourceSegmentId: "segment_1",
          startSeconds: 1,
          endSeconds: 4,
          speakerId: "speaker_ta",
          quote: "我最近很喜欢拍夜景",
          createdAt: now
        }]
      }]
    }],
    promises: []
  };
}

function fakeApi(overrides: Partial<DateCompanionApi> = {}): DateCompanionApi {
  const emptyRelationshipView = relationshipView();
  return {
    getCurrentUser: async () => ({ id: "user_1", email: "user@example.com" }),
    login: async () => ({ id: "user_1", email: "user@example.com" }),
    register: async () => ({ id: "user_1", email: "user@example.com" }),
    logout: async () => undefined,
    upload: async () => ({ uploadId: "upload_1", jobId: "job_1", status: "uploaded" }),
    getToyIngestionReceipt: async () => null,
    getDay: async () => payload(),
    pollDay: async (_uploadId, options) => {
      const ready = payload();
      options?.onPayload?.(ready);
      return ready;
    },
    cleanupUpload: async () => undefined,
    deleteSourceUpload: async () => undefined,
    listRelationships: async () => [emptyRelationshipView.relationship],
    createRelationship: async () => ({ relationship: emptyRelationshipView.relationship, reused: false }),
    getRelationshipView: async () => emptyRelationshipView,
    importInteraction: async (_relationshipId, input) => ({
      interactionId: "interaction_1",
      reused: false,
      view: relationshipView([input.uploadId])
    }),
    updateParticipants: async () => emptyRelationshipView,
    updateRecap: async () => emptyRelationshipView,
    patchPromise: async () => emptyRelationshipView,
    searchRelationship: async () => [],
    deleteInteraction: async () => undefined,
    async *streamCurrentInteractionQa() {
      // No default response.
    },
    async *streamRelationshipQa() {
      // No default response.
    },
    async *streamPersonQa() {
      // No default response.
    },
    listConfirmedPeople: async () => [],
    createPersonCandidate: async () => ({
      id: "person_candidate",
      displayName: "人物",
      status: "candidate",
      version: 1,
      explicitlyConfirmed: false,
      confirmedAt: null,
      createdAt: "2026-08-04T10:00:00.000Z",
      updatedAt: "2026-08-04T10:00:00.000Z"
    }),
    confirmPerson: async (personId) => ({
      id: personId,
      displayName: "人物",
      status: "confirmed",
      version: 2,
      explicitlyConfirmed: true,
      confirmedAt: "2026-08-04T10:00:00.000Z",
      createdAt: "2026-08-04T10:00:00.000Z",
      updatedAt: "2026-08-04T10:00:00.000Z"
    }),
    getSelfBinding: async () => null,
    setSelfBinding: async (personId) => ({
      personId,
      status: "active",
      version: 1,
      setAt: "2026-08-04T10:00:00.000Z",
      clearedAt: null,
      updatedAt: "2026-08-04T10:00:00.000Z"
    }),
    getMemorySetting: async () => ({ enabled: false, version: 0, createdAt: "2026-08-04T10:00:00.000Z", updatedAt: "2026-08-04T10:00:00.000Z", enabledAt: null, disabledAt: null }),
    updateMemorySetting: async (enabled) => ({ enabled, version: 1, createdAt: "2026-08-04T10:00:00.000Z", updatedAt: "2026-08-04T10:00:00.000Z", enabledAt: enabled ? "2026-08-04T10:00:00.000Z" : null, disabledAt: enabled ? null : "2026-08-04T10:00:00.000Z" }),
    getPersonMapping: async () => null,
    updatePersonMapping: async (_relationshipId, input) => ({ id: "mapping_1", ...input, status: "confirmed", version: input.expectedVersion + 1, confirmedAt: "2026-08-04T10:00:00.000Z", createdAt: "2026-08-04T10:00:00.000Z", updatedAt: "2026-08-04T10:00:00.000Z" }),
    getMemoryReview: async () => ({ retention: { enabled: false, version: 0, createdAt: "2026-08-04T10:00:00.000Z", updatedAt: "2026-08-04T10:00:00.000Z", enabledAt: null, disabledAt: null }, mapping: null, interactions: [] }),
    getPersonSourceCatalog: async (relationshipId) => ({
      relationshipId,
      companionPersonId: null,
      mappingVersion: null,
      status: "unavailable",
      sources: []
    }),
    getPersonRetainedSources: async () => [],
    syncInteractionMemory: async () => null,
    purgeRetainedMemory: async () => ({ purgeId: "purge_1", status: "completed", totalCount: 0, completedCount: 0, failedCount: 0, retryable: false, updatedAt: "2026-08-04T10:00:00.000Z" }),
    ...overrides
  };
}

const PERSON_QA_NOW = "2026-08-11T10:00:00.000Z";

function personQaMapping(overrides: Partial<{
  selfPersonId: string;
  companionPersonId: string;
  status: "confirmed" | "needs_review" | "archived";
  version: number;
}> = {}) {
  return {
    id: "mapping_person_qa",
    selfPersonId: "person_self",
    companionPersonId: "person_ta",
    relationshipType: "dating" as const,
    status: "confirmed" as const,
    version: 3,
    confirmedAt: PERSON_QA_NOW,
    createdAt: PERSON_QA_NOW,
    updatedAt: PERSON_QA_NOW,
    ...overrides
  };
}

function validPersonQaApi(overrides: Partial<DateCompanionApi> = {}): Partial<DateCompanionApi> {
  const mapping = personQaMapping();
  return {
    listConfirmedPeople: async () => [
      { id: "person_self", displayName: "我", status: "confirmed", version: 1, explicitlyConfirmed: true, confirmedAt: PERSON_QA_NOW, createdAt: PERSON_QA_NOW, updatedAt: PERSON_QA_NOW },
      { id: "person_ta", displayName: "Ta", status: "confirmed", version: 1, explicitlyConfirmed: true, confirmedAt: PERSON_QA_NOW, createdAt: PERSON_QA_NOW, updatedAt: PERSON_QA_NOW }
    ],
    getSelfBinding: async () => ({ personId: "person_self", status: "active", version: 1, setAt: PERSON_QA_NOW, clearedAt: null, updatedAt: PERSON_QA_NOW }),
    getMemoryReview: async () => ({
      retention: { enabled: true, version: 1, createdAt: PERSON_QA_NOW, updatedAt: PERSON_QA_NOW, enabledAt: PERSON_QA_NOW, disabledAt: null },
      mapping,
      interactions: []
    }),
    getPersonRetainedSources: async () => [],
    ...overrides
  };
}

function readyPersonSourceCatalog(overrides: Partial<{
  relationshipId: string;
  companionPersonId: string | null;
  mappingVersion: number | null;
  status: "ready" | "needs_review" | "unavailable";
  sources: Array<{
    evidenceSnapshotId: string;
    interactionId: string;
    uploadId: string;
    sourceSegmentId: string;
    recordingDate: string;
    startSeconds: number;
    endSeconds: number;
    speakerId?: string;
    quote: string;
    subject: "companion" | "both";
  }>;
}> = {}) {
  return {
    relationshipId: "relationship_1",
    companionPersonId: "person_ta",
    mappingVersion: 3,
    status: "ready" as const,
    sources: [],
    ...overrides
  };
}

function personQaHistoryKey(input: { userId?: string; personId?: string; mappingVersion?: number } = {}) {
  return `daily-brief:${input.userId ?? "user_1"}:date-companion:person-qa:relationship_1:${input.personId ?? "person_ta"}:mapping-${input.mappingVersion ?? 3}:v1`;
}

function memoryCache(initial: Record<string, DayPayload> = {}, initialHistory: QuestionAnswer[] = []) {
  const days = new Map(Object.entries(initial));
  let history = [...initialHistory];
  const cache: DateCompanionCache = {
    saveDay(value) {
      days.set(value.upload.id, value);
    },
    readDay(uploadId) {
      return days.get(uploadId) ?? null;
    },
    listDays() {
      return [...days.values()].map((value) => ({
        uploadId: value.upload.id,
        recordingDate: value.upload.recordingDate,
        originalName: value.upload.originalName,
        createdAt: value.upload.createdAt ?? ""
      }));
    },
    deleteDay(uploadId) {
      days.delete(uploadId);
    },
    readQaHistory() {
      return [...history];
    },
    appendQaHistory(_uploadId, value) {
      history = [...history.filter((item) => item.id !== value.id), value];
    },
    clearQaHistory() {
      history = [];
    }
  };
  return { cache, days, history: () => history };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("DateCompanionSessionController", () => {
  it("restores a full receipt and finalizes strictly as cache, relationship import, then cleanup", async () => {
    const receipt = {
      uploadId: "upload_1",
      jobId: "job_1",
      status: "waiting" as const,
      executionMode: "queue" as const,
      queueJobId: "pipeline_upload_1"
    };
    window.localStorage.setItem(
      "daily-brief:user_1:date-companion:session",
      JSON.stringify({ version: 1, currentUploadId: "upload_1", receipt })
    );
    const order: string[] = [];
    const cacheState = memoryCache();
    const cache: DateCompanionCache = {
      ...cacheState.cache,
      saveDay(value) {
        order.push("save");
        cacheState.cache.saveDay(value);
      }
    };
    const cleanup = vi.fn(async () => {
      order.push("cleanup");
    });
    const api = fakeApi({
      pollDay: async (_uploadId, options) => {
        options?.onPayload?.(payload("upload_1", "processing"));
        return payload("upload_1", "ready");
      },
      importInteraction: async (_relationshipId, input) => {
        order.push("import");
        return { interactionId: "interaction_1", reused: false, view: relationshipView([input.uploadId]) };
      },
      cleanupUpload: cleanup
    });
    const controller = new DateCompanionSessionController({ api, cache, storage: window.localStorage, pollIntervalMs: 0 });

    await controller.initialize();

    expect(window.localStorage.getItem("daily-brief:active-user-id")).toBe("user_1");
    expect(order).toEqual(["save", "import", "cleanup"]);
    expect(controller.getSnapshot().uploadState).toMatchObject({
      status: "ready",
      uploadId: "upload_1",
      receipt,
      cacheStatus: "saved",
      serverCleanupStatus: "completed"
    });
    expect(controller.getSnapshot().viewModel.currentInteraction?.id).toBe("upload_1");
  });

  it("clears the cache user boundary when the session is anonymous", async () => {
    window.localStorage.setItem("daily-brief:active-user-id", "old_user");
    const controller = new DateCompanionSessionController({
      api: fakeApi({ getCurrentUser: async () => null }),
      cache: memoryCache().cache,
      storage: window.localStorage
    });

    await controller.initialize();

    expect(controller.getSnapshot().auth).toEqual({ status: "anonymous" });
    expect(window.localStorage.getItem("daily-brief:active-user-id")).toBeNull();
  });

  it("registers through the real client contract and restores the authenticated session state", async () => {
    const register = vi.fn(async () => ({ id: "user_new", email: "new@example.com", name: "小林" }));
    const controller = new DateCompanionSessionController({
      api: fakeApi({ getCurrentUser: async () => null, register }),
      cache: memoryCache().cache,
      storage: window.localStorage
    });
    await controller.initialize();

    await controller.register({
      email: "new@example.com",
      password: "password-123",
      name: "小林",
      inviteCode: "invitation"
    });

    expect(register).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().auth).toEqual({
      status: "authenticated",
      user: { id: "user_new", email: "new@example.com", name: "小林" }
    });
    expect(window.localStorage.getItem("daily-brief:active-user-id")).toBe("user_new");
  });

  it.each([
    [400, "invalid_register_input"],
    [403, "invalid_invite_code"],
    [409, "user_exists"],
    [503, "invite_not_configured"]
  ])("keeps registration failure %i unauthenticated and preserves its safe error code", async (status, code) => {
    const controller = new DateCompanionSessionController({
      api: fakeApi({
        getCurrentUser: async () => null,
        register: async () => { throw new DateCompanionApiError({ status, code }); }
      }),
      cache: memoryCache().cache,
      storage: window.localStorage
    });
    await controller.initialize();

    await controller.register({ email: "new@example.com", password: "password-123", inviteCode: "invitation" });

    expect(controller.getSnapshot().auth).toEqual({ status: "error", message: code });
    expect(window.localStorage.getItem("daily-brief:active-user-id")).toBeNull();
    controller.clearAuthError();
    expect(controller.getSnapshot().auth).toEqual({ status: "anonymous" });
  });

  it("does not expose a technical network error during registration", async () => {
    const controller = new DateCompanionSessionController({
      api: fakeApi({
        getCurrentUser: async () => null,
        register: async () => { throw new TypeError("fetch failed at internal socket"); }
      }),
      cache: memoryCache().cache,
      storage: window.localStorage
    });
    await controller.initialize();

    await controller.register({ email: "new@example.com", password: "password-123", inviteCode: "invitation" });

    expect(controller.getSnapshot().auth).toEqual({
      status: "error",
      message: "暂时无法连接注册服务，请稍后再试。"
    });
  });

  it("selects a server interaction for evidence-only recap without creating current QA context", async () => {
    const serverView = relationshipView(["upload_server_only"]);
    serverView.interactions[0] = {
      ...serverView.interactions[0],
      status: "confirmed",
      confirmedAt: "2026-08-04T11:00:00.000Z"
    };
    serverView.interactions.push({
      ...serverView.interactions[0],
      id: "interaction_draft",
      sourceUploadId: "upload_draft",
      originalName: "upload_draft.m4a",
      status: "draft",
      confirmedAt: undefined
    });
    const controller = new DateCompanionSessionController({
      api: fakeApi({ getRelationshipView: async () => serverView }),
      cache: memoryCache().cache,
      storage: window.localStorage
    });

    await controller.initialize();
    expect(controller.getSnapshot().viewModel.currentInteraction).toBeNull();
    expect(controller.getSnapshot().viewModel.recap.interaction).toBeNull();

    expect(controller.selectRelationshipInteraction("interaction_1")).toBe(true);
    expect(controller.getSnapshot().viewModel.currentInteraction).toBeNull();
    expect(controller.getSnapshot().viewModel.recap.interaction).toMatchObject({
      relationshipInteractionId: "interaction_1",
      transcript: []
    });
    expect(controller.selectRelationshipInteraction("interaction_draft")).toBe(false);
    expect(controller.getSnapshot().viewModel.recap.interaction).toBeNull();
    expect(controller.selectRelationshipInteraction("interaction_other_user")).toBe(false);
  });

  it("can initialize again after the immediate effect cleanup used by React Strict Mode", async () => {
    let callCount = 0;
    const getCurrentUser = vi.fn(async (signal?: AbortSignal) => {
      callCount += 1;
      if (callCount === 1) {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true }
          );
        });
      }
      return { id: "user_1", email: "user@example.com" };
    });
    const controller = new DateCompanionSessionController({
      api: fakeApi({ getCurrentUser }),
      cache: memoryCache().cache,
      storage: window.localStorage
    });

    const firstInitialization = controller.initialize();
    controller.dispose();
    const secondInitialization = controller.initialize();
    await Promise.all([firstInitialization, secondInitialization]);

    expect(getCurrentUser).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().auth).toEqual({
      status: "authenticated",
      user: { id: "user_1", email: "user@example.com" }
    });
  });

  it("returns to the real login boundary when an authenticated request expires", async () => {
    const controller = new DateCompanionSessionController({
      api: fakeApi({
        pollDay: async () => {
          throw new DateCompanionApiError({ status: 401, code: "unauthenticated" });
        }
      }),
      cache: memoryCache().cache,
      storage: window.localStorage,
      pollIntervalMs: 0
    });
    await controller.initialize();

    const receiptReceived = await controller.upload(
      new File(["audio"], "date.m4a", { type: "audio/mp4" }),
      "2026-08-04"
    );

    expect(controller.getSnapshot()).toMatchObject({
      auth: { status: "anonymous" },
      uploadState: { status: "idle" },
      qaState: { status: "idle" }
    });
    expect(receiptReceived).toBe(true);
    expect(controller.getSnapshot().viewModel.currentInteraction).toBeNull();
    expect(window.localStorage.getItem("daily-brief:active-user-id")).toBeNull();
  });

  it("keeps polling after a deferred queue enqueue receipt", async () => {
    const receipt = {
      uploadId: "upload_deferred",
      jobId: "job_deferred",
      status: "waiting" as const,
      executionMode: "queue" as const,
      queueJobId: "pipeline_upload_deferred",
      enqueueDeferred: true,
      warning: "pipeline_queue_unavailable" as const
    };
    const pollDay = vi.fn(async (uploadId: string, options?: { onPayload?: (value: DayPayload) => void }) => {
      const ready = payload(uploadId, "ready");
      options?.onPayload?.(ready);
      return ready;
    });
    const controller = new DateCompanionSessionController({
      api: fakeApi({ upload: async () => receipt, pollDay }),
      cache: memoryCache().cache,
      storage: window.localStorage,
      pollIntervalMs: 0
    });
    await controller.initialize();

    const receiptReceived = await controller.upload(
      new File(["audio"], "date.m4a", { type: "audio/mp4" }),
      "2026-08-04"
    );

    expect(pollDay).toHaveBeenCalledWith(
      "upload_deferred",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(controller.getSnapshot().uploadState).toMatchObject({
      status: "ready",
      uploadId: "upload_deferred",
      receipt
    });
    expect(receiptReceived).toBe(true);
  });

  it("retries a failed input-adapter receipt notification before polling completes", async () => {
    let resolvePoll!: (value: DayPayload) => void;
    const pollDay = vi.fn((_uploadId: string, options?: { onPayload?: (value: DayPayload) => void }) => (
      new Promise<DayPayload>((resolve) => {
        resolvePoll = (value) => {
          options?.onPayload?.(value);
          resolve(value);
        };
      })
    ));
    let successfulNotifications = 0;
    const onServerAccepted = vi.fn()
      .mockRejectedValueOnce(new Error("transient indexed db failure"))
      .mockImplementationOnce(async () => {
        successfulNotifications += 1;
      });
    const controller = new DateCompanionSessionController({
      api: fakeApi({ pollDay }),
      cache: memoryCache().cache,
      storage: window.localStorage,
      pollIntervalMs: 0
    });
    await controller.initialize();

    let uploadCompleted = false;
    const uploadPromise = controller.upload(
      new File(["audio"], "date.m4a", { type: "audio/mp4" }),
      "2026-08-04",
      { onServerAccepted }
    ).then((result) => {
      uploadCompleted = true;
      return result;
    });

    await vi.waitFor(() => expect(onServerAccepted).toHaveBeenCalledTimes(2));
    expect(successfulNotifications).toBe(1);
    expect(pollDay).toHaveBeenCalledTimes(1);
    expect(uploadCompleted).toBe(false);

    resolvePoll(payload("upload_1", "ready"));
    await expect(uploadPromise).resolves.toBe(true);
    expect(onServerAccepted).toHaveBeenCalledTimes(2);
    expect(successfulNotifications).toBe(1);
  });

  it("passes Toy operation scope to the existing upload while manual uploads keep the old call", async () => {
    const upload = vi.fn(async (
      _file: File,
      _recordingDate: string,
      _signal?: AbortSignal,
      _toyRequest?: DateCompanionToyUploadRequest
    ) => ({ uploadId: "upload_1", jobId: "job_1", status: "uploaded" as const }));
    const controller = new DateCompanionSessionController({
      api: fakeApi({ upload }),
      cache: memoryCache().cache,
      storage: window.localStorage,
      pollIntervalMs: 0
    });
    await controller.initialize();
    const file = new File(["audio"], "date.m4a", { type: "audio/mp4" });
    const toyOperation: DateCompanionToyUploadRequest = {
      operationKey: `toyop_v1_${"a".repeat(64)}`,
      destination: "date_companion",
      relationshipId: "relationship_1"
    };

    await expect(controller.upload(file, "2026-08-04", { toyOperation })).resolves.toBe(true);
    expect(upload).toHaveBeenNthCalledWith(
      1,
      file,
      "2026-08-04",
      expect.any(AbortSignal),
      toyOperation
    );

    await expect(controller.upload(file, "2026-08-04")).resolves.toBe(true);
    expect(upload).toHaveBeenNthCalledWith(
      2,
      file,
      "2026-08-04",
      expect.any(AbortSignal)
    );
  });

  it("fails closed before upload when a Toy operation belongs to another relationship", async () => {
    const upload = vi.fn(async () => ({
      uploadId: "upload_1",
      jobId: "job_1",
      status: "uploaded" as const
    }));
    const controller = new DateCompanionSessionController({
      api: fakeApi({ upload }),
      cache: memoryCache().cache,
      storage: window.localStorage,
      pollIntervalMs: 0
    });
    await controller.initialize();

    await expect(controller.upload(
      new File(["audio"], "date.m4a", { type: "audio/mp4" }),
      "2026-08-04",
      {
        toyOperation: {
          operationKey: `toyop_v1_${"b".repeat(64)}`,
          destination: "date_companion",
          relationshipId: "relationship_other"
        }
      }
    )).resolves.toBe(false);

    expect(upload).not.toHaveBeenCalled();
    expect(controller.getSnapshot().uploadState).toMatchObject({
      status: "failed",
      failureStage: "upload",
      message: expect.stringContaining("不属于当前关系")
    });
  });

  it("recovers a lost POST response from the durable receipt without posting the file again", async () => {
    const receipt = toyReceipt();
    const getToyIngestionReceipt = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(receipt)
      .mockResolvedValueOnce(receipt);
    const upload = vi.fn(async () => {
      throw new TypeError("response lost");
    });
    const pollDay = vi.fn(async (_uploadId, options) => {
      const ready = payload();
      options?.onPayload?.(ready);
      return ready;
    });
    const controller = new DateCompanionSessionController({
      api: fakeApi({ upload, getToyIngestionReceipt, pollDay }),
      cache: memoryCache().cache,
      storage: window.localStorage,
      pollIntervalMs: 0
    });
    await controller.initialize();

    await expect(controller.upload(
      new File(["audio"], "date.m4a", { type: "audio/mp4" }),
      "2026-08-04",
      {
        toyOperation: {
          operationKey: receipt.operationKey,
          destination: "date_companion",
          relationshipId: receipt.relationshipId
        }
      }
    )).resolves.toBe(true);

    expect(upload).toHaveBeenCalledTimes(1);
    expect(getToyIngestionReceipt).toHaveBeenCalledTimes(3);
    expect(pollDay).toHaveBeenCalledTimes(1);
  });

  it("automatically recovers a remounted Toy operation across 404, reserving, and accepted", async () => {
    const receipt = toyReceipt({ decision: "already_uploaded" });
    const reserving = toyReceipt({
      state: "reserving",
      decision: "accepted",
      serverAcceptedAt: undefined
    });
    const upload = vi.fn();
    const getToyIngestionReceipt = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(reserving)
      .mockResolvedValueOnce(receipt);
    const importInteraction = vi.fn(async (_relationshipId: string, input: { uploadId: string }) => ({
      interactionId: "interaction_1",
      reused: false,
      view: relationshipView([input.uploadId])
    }));
    const cleanupUpload = vi.fn(async () => undefined);
    const getDay = vi.fn(async () => payload());
    const pollDay = vi.fn();
    const controller = new DateCompanionSessionController({
      api: fakeApi({ upload, getToyIngestionReceipt, getDay, pollDay, importInteraction, cleanupUpload }),
      cache: memoryCache().cache,
      storage: window.localStorage,
      pollIntervalMs: 0
    });
    await controller.initialize();

    await expect(controller.adoptToyIngestionReceipt({
      operationKey: receipt.operationKey,
      destination: "date_companion",
      relationshipId: receipt.relationshipId
    })).resolves.toEqual(receipt);
    expect(upload).not.toHaveBeenCalled();
    expect(getToyIngestionReceipt).toHaveBeenCalledTimes(3);
    expect(getDay).toHaveBeenCalledTimes(1);
    expect(pollDay).not.toHaveBeenCalled();
    expect(importInteraction).toHaveBeenCalledTimes(1);
    expect(cleanupUpload).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().uploadState).toMatchObject({
      status: "ready",
      uploadId: receipt.uploadId
    });
  });

  it("bounds recovery Job polling and keeps the canonical receipt retryable without audio POST", async () => {
    const receipt = toyReceipt({ decision: "already_uploaded" });
    const upload = vi.fn();
    const getToyIngestionReceipt = vi.fn(async () => receipt);
    const getDay = vi.fn()
      .mockResolvedValueOnce(payload(receipt.uploadId, "processing"))
      .mockResolvedValueOnce(payload(receipt.uploadId, "processing"))
      .mockResolvedValueOnce(payload(receipt.uploadId, "ready"));
    const pollDay = vi.fn();
    const importInteraction = vi.fn(async (_relationshipId: string, input: { uploadId: string }) => ({
      interactionId: "interaction_1",
      reused: false,
      view: relationshipView([input.uploadId])
    }));
    const cleanupUpload = vi.fn(async () => undefined);
    const controller = new DateCompanionSessionController({
      api: fakeApi({
        upload,
        getToyIngestionReceipt,
        getDay,
        pollDay,
        importInteraction,
        cleanupUpload
      }),
      cache: memoryCache().cache,
      storage: window.localStorage,
      pollIntervalMs: 0,
      toyRecoveryPollMaxAttempts: 2,
      toyRecoveryPollTimeoutMs: 10_000
    });
    await controller.initialize();

    await expect(controller.adoptToyIngestionReceipt({
      operationKey: receipt.operationKey,
      destination: "date_companion",
      relationshipId: receipt.relationshipId
    })).resolves.toEqual(receipt);

    expect(upload).not.toHaveBeenCalled();
    expect(getDay).toHaveBeenCalledTimes(2);
    expect(pollDay).not.toHaveBeenCalled();
    expect(importInteraction).not.toHaveBeenCalled();
    expect(cleanupUpload).not.toHaveBeenCalled();
    expect(controller.getSnapshot().uploadState).toMatchObject({
      status: "failed",
      uploadId: receipt.uploadId,
      receipt: expect.objectContaining({ ingestionReceipt: receipt }),
      failureStage: "read",
      serverDataRetained: true,
      message: expect.stringContaining("不需要再次上传音频")
    });

    await controller.retryRead();

    expect(upload).not.toHaveBeenCalled();
    expect(getDay).toHaveBeenCalledTimes(3);
    expect(pollDay).not.toHaveBeenCalled();
    expect(importInteraction).toHaveBeenCalledTimes(1);
    expect(cleanupUpload).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().uploadState).toMatchObject({
      status: "ready",
      uploadId: receipt.uploadId
    });
  });

  it("lets a manual upload supersede a pending Toy recovery without adopting its late receipt", async () => {
    const lateReceipt = toyReceipt();
    let resolveLookup!: (receipt: ToyIngestionReceipt | null) => void;
    const getToyIngestionReceipt = vi.fn(() => new Promise<ToyIngestionReceipt | null>((resolve) => {
      resolveLookup = resolve;
    }));
    const upload = vi.fn(async (
      _file: File,
      _recordingDate: string,
      _signal?: AbortSignal,
      _toyRequest?: DateCompanionToyUploadRequest
    ) => ({
      uploadId: "upload_manual",
      jobId: "job_manual",
      status: "uploaded" as const
    }));
    const pollDay = vi.fn(async (_uploadId, options) => {
      const ready = payload("upload_manual");
      options?.onPayload?.(ready);
      return ready;
    });
    const importInteraction = vi.fn(async (_relationshipId: string, input: { uploadId: string }) => ({
      interactionId: "interaction_1",
      reused: false,
      view: relationshipView([input.uploadId])
    }));
    const cleanupUpload = vi.fn(async () => undefined);
    const controller = new DateCompanionSessionController({
      api: fakeApi({ upload, getToyIngestionReceipt, pollDay, importInteraction, cleanupUpload }),
      cache: memoryCache().cache,
      storage: window.localStorage,
      pollIntervalMs: 0
    });
    await controller.initialize();

    const recovery = controller.adoptToyIngestionReceipt({
      operationKey: lateReceipt.operationKey,
      destination: "date_companion",
      relationshipId: lateReceipt.relationshipId
    });
    await vi.waitFor(() => expect(getToyIngestionReceipt).toHaveBeenCalledTimes(1));

    await expect(controller.upload(
      new File(["manual"], "manual.wav", { type: "audio/wav" }),
      "2026-08-20"
    )).resolves.toBe(true);
    resolveLookup(lateReceipt);
    await expect(recovery).resolves.toBeNull();

    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[3]).toBeUndefined();
    expect(pollDay).toHaveBeenCalledTimes(1);
    expect(importInteraction).toHaveBeenCalledTimes(1);
    expect(cleanupUpload).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().uploadState).toMatchObject({
      status: "ready",
      uploadId: "upload_manual"
    });
  });

  it("fails closed when a recovered receipt belongs to another relationship", async () => {
    const mismatched = toyReceipt({ relationshipId: "relationship_other" });
    const upload = vi.fn();
    const pollDay = vi.fn();
    const importInteraction = vi.fn();
    const cleanupUpload = vi.fn();
    const controller = new DateCompanionSessionController({
      api: fakeApi({
        upload,
        getToyIngestionReceipt: async () => mismatched,
        pollDay,
        importInteraction,
        cleanupUpload
      }),
      cache: memoryCache().cache,
      storage: window.localStorage,
      pollIntervalMs: 0
    });
    await controller.initialize();

    await expect(controller.adoptToyIngestionReceipt({
      operationKey: mismatched.operationKey,
      destination: "date_companion",
      relationshipId: "relationship_1"
    })).rejects.toMatchObject({ code: "toy_ingestion_relationship_mismatch" });

    expect(upload).not.toHaveBeenCalled();
    expect(pollDay).not.toHaveBeenCalled();
    expect(importInteraction).not.toHaveBeenCalled();
    expect(cleanupUpload).not.toHaveBeenCalled();
    expect(controller.getSnapshot().uploadState).toMatchObject({
      status: "failed",
      failureStage: "relationship_import",
      message: expect.stringContaining("另一段关系")
    });
  });

  it("fences a late ready response after relationship mismatch before import or cleanup", async () => {
    const accepted = toyReceipt();
    const mismatched = toyReceipt({
      receiptId: "receipt_other",
      operationKey: accepted.operationKey,
      relationshipId: "relationship_other",
      uploadId: "upload_other",
      jobId: "job_other"
    });
    let resolvePoll!: (value: DayPayload) => void;
    const getDay = vi.fn(() => new Promise<DayPayload>((resolve) => {
      resolvePoll = resolve;
    }));
    const pollDay = vi.fn();
    const getToyIngestionReceipt = vi.fn()
      .mockResolvedValueOnce(accepted)
      .mockResolvedValueOnce(mismatched);
    const importInteraction = vi.fn();
    const cleanupUpload = vi.fn();
    const controller = new DateCompanionSessionController({
      api: fakeApi({ getToyIngestionReceipt, getDay, pollDay, importInteraction, cleanupUpload }),
      cache: memoryCache().cache,
      storage: window.localStorage,
      pollIntervalMs: 0
    });
    await controller.initialize();
    const request = {
      operationKey: accepted.operationKey,
      destination: "date_companion" as const,
      relationshipId: accepted.relationshipId
    };

    const firstRecovery = controller.adoptToyIngestionReceipt(request);
    await vi.waitFor(() => expect(getDay).toHaveBeenCalledTimes(1));
    await expect(controller.adoptToyIngestionReceipt(request)).rejects.toMatchObject({
      code: "toy_ingestion_relationship_mismatch"
    });
    resolvePoll(payload(accepted.uploadId, "ready"));
    await firstRecovery;

    expect(importInteraction).not.toHaveBeenCalled();
    expect(cleanupUpload).not.toHaveBeenCalled();
    expect(pollDay).not.toHaveBeenCalled();
    expect(controller.getSnapshot().uploadState).toMatchObject({
      status: "failed",
      failureStage: "relationship_import"
    });
  });

  it("silently fences an accepted recovery across relationship switch and ignores its persisted anchor", async () => {
    const accepted = toyReceipt();
    const relationshipA = relationshipView();
    const relationshipBBase = relationshipView();
    const relationshipB: DcRelationshipView = {
      ...relationshipBBase,
      relationship: {
        ...relationshipBBase.relationship,
        id: "relationship_2"
      },
      interactions: []
    };
    let currentRelationship = relationshipA;
    let resolveLateDay!: (value: DayPayload) => void;
    const getDay = vi.fn(() => new Promise<DayPayload>((resolve) => {
      resolveLateDay = resolve;
    }));
    const getToyIngestionReceipt = vi.fn(async () => accepted);
    const importInteraction = vi.fn();
    const cleanupUpload = vi.fn();
    const listRelationships = vi.fn(async () => [currentRelationship.relationship]);
    const getRelationshipView = vi.fn(async () => currentRelationship);
    const sharedStorage = window.localStorage;
    const controller = new DateCompanionSessionController({
      api: fakeApi({
        getToyIngestionReceipt,
        getDay,
        listRelationships,
        getRelationshipView,
        importInteraction,
        cleanupUpload
      }),
      cache: memoryCache().cache,
      storage: sharedStorage,
      pollIntervalMs: 0
    });
    await controller.initialize();

    const recovery = controller.adoptToyIngestionReceipt({
      operationKey: accepted.operationKey,
      destination: "date_companion",
      relationshipId: accepted.relationshipId
    });
    await vi.waitFor(() => expect(getDay).toHaveBeenCalledTimes(1));

    currentRelationship = relationshipB;
    await (controller as unknown as { loadRelationship(): Promise<void> }).loadRelationship();
    expect(controller.getSnapshot().relationshipState).toMatchObject({
      status: "ready",
      relationship: { id: "relationship_2" }
    });
    expect(controller.getSnapshot().uploadState).toEqual({ status: "idle" });

    resolveLateDay(payload(accepted.uploadId, "ready"));
    await recovery;

    expect(importInteraction).not.toHaveBeenCalled();
    expect(cleanupUpload).not.toHaveBeenCalled();
    expect(controller.getSnapshot().uploadState).toEqual({ status: "idle" });
    expect(JSON.parse(sharedStorage.getItem(
      "daily-brief:user_1:date-companion:session"
    ) ?? "null")).toMatchObject({
      receipt: {
        ingestionReceipt: {
          operationKey: accepted.operationKey,
          relationshipId: "relationship_1"
        }
      }
    });

    const secondGetToyReceipt = vi.fn(async () => accepted);
    const secondGetDay = vi.fn();
    const reloaded = new DateCompanionSessionController({
      api: fakeApi({
        getToyIngestionReceipt: secondGetToyReceipt,
        getDay: secondGetDay,
        listRelationships: async () => [relationshipB.relationship],
        getRelationshipView: async () => relationshipB
      }),
      cache: memoryCache().cache,
      storage: sharedStorage,
      pollIntervalMs: 0
    });
    await reloaded.initialize();

    expect(secondGetToyReceipt).not.toHaveBeenCalled();
    expect(secondGetDay).not.toHaveBeenCalled();
    expect(reloaded.getSnapshot().relationshipState).toMatchObject({
      status: "ready",
      relationship: { id: "relationship_2" }
    });
    expect(reloaded.getSnapshot().uploadState).toEqual({ status: "idle" });
  });

  it("does not treat a POST reserving receipt as accepted or poll a missing Upload", async () => {
    const reserving = toyReceipt({
      state: "reserving",
      serverAcceptedAt: undefined
    });
    const upload = vi.fn(async () => ({
      uploadId: reserving.uploadId,
      jobId: reserving.jobId,
      status: "waiting" as const,
      executionMode: "inline" as const,
      ingestionReceipt: reserving
    }));
    const getToyIngestionReceipt = vi.fn(async () => null);
    const pollDay = vi.fn();
    const onServerAccepted = vi.fn();
    const onIngestionReceipt = vi.fn();
    const controller = new DateCompanionSessionController({
      api: fakeApi({ upload, getToyIngestionReceipt, pollDay }),
      cache: memoryCache().cache,
      storage: window.localStorage,
      pollIntervalMs: 0
    });
    await controller.initialize();

    await expect(controller.upload(
      new File(["audio"], "date.m4a", { type: "audio/mp4" }),
      "2026-08-04",
      {
        toyOperation: {
          operationKey: reserving.operationKey,
          destination: "date_companion",
          relationshipId: reserving.relationshipId
        },
        onServerAccepted,
        onIngestionReceipt
      }
    )).resolves.toBe(false);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(onIngestionReceipt).toHaveBeenCalledWith(reserving);
    expect(onServerAccepted).not.toHaveBeenCalled();
    expect(pollDay).not.toHaveBeenCalled();
  });

  it("keeps a structured pre-accept Toy failure retryable with the same operation", async () => {
    const preAcceptFailed = toyReceipt({
      state: "failed",
      serverAcceptedAt: undefined,
      failedAt: "2026-08-04T10:01:00.000Z"
    });
    const upload = vi.fn(async (
      _file: File,
      _recordingDate: string,
      _signal?: AbortSignal,
      _toyRequest?: DateCompanionToyUploadRequest
    ) => {
      throw new DateCompanionApiError({
        status: 500,
        code: "toy_ingestion_reservation_failed",
        details: {
          error: "toy_ingestion_reservation_failed",
          uploadId: preAcceptFailed.uploadId,
          jobId: preAcceptFailed.jobId,
          status: "failed",
          ingestionReceipt: preAcceptFailed
        }
      });
    });
    const onServerAccepted = vi.fn();
    const onIngestionReceipt = vi.fn();
    const controller = new DateCompanionSessionController({
      api: fakeApi({ upload }),
      cache: memoryCache().cache,
      storage: window.localStorage,
      pollIntervalMs: 0
    });
    await controller.initialize();
    const file = new File(["audio"], "date.m4a", { type: "audio/mp4" });
    const options = {
      toyOperation: {
        operationKey: preAcceptFailed.operationKey,
        destination: "date_companion" as const,
        relationshipId: preAcceptFailed.relationshipId
      },
      onServerAccepted,
      onIngestionReceipt
    };

    await expect(controller.upload(file, "2026-08-04", options)).resolves.toBe(false);
    await expect(controller.upload(file, "2026-08-04", options)).resolves.toBe(false);

    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls.map((call) => call[3])).toEqual([
      options.toyOperation,
      options.toyOperation
    ]);
    expect(onIngestionReceipt).toHaveBeenCalledTimes(2);
    expect(onServerAccepted).not.toHaveBeenCalled();
    expect(controller.getSnapshot().uploadState).toMatchObject({
      status: "failed",
      failureStage: "upload"
    });
    expect(controller.getSnapshot().uploadState).not.toHaveProperty("serverDataRetained");
  });

  it("does not let legacy cleanup metadata bypass canonical Job polling", async () => {
    const reserving = toyReceipt({ state: "reserving", serverAcceptedAt: undefined });
    const completed = toyReceipt({
      state: "completed",
      completedAt: "2026-08-04T10:05:00.000Z",
      sourceCleanedAt: "2026-08-04T10:06:00.000Z"
    });
    const getToyIngestionReceipt = vi.fn()
      .mockResolvedValueOnce(reserving)
      .mockResolvedValueOnce(completed);
    const upload = vi.fn(async (
      _file: File,
      _recordingDate: string,
      _signal?: AbortSignal,
      _toyRequest?: DateCompanionToyUploadRequest
    ) => ({
      uploadId: completed.uploadId,
      jobId: completed.jobId,
      status: "uploaded" as const,
      ingestionReceipt: completed
    }));
    const pollDay = vi.fn(async (_uploadId, options) => {
      const ready = payload(completed.uploadId, "ready");
      options?.onPayload?.(ready);
      return ready;
    });
    const controller = new DateCompanionSessionController({
      api: fakeApi({
        upload,
        getToyIngestionReceipt,
        pollDay,
        getRelationshipView: async () => relationshipView([completed.uploadId])
      }),
      cache: memoryCache().cache,
      storage: window.localStorage,
      pollIntervalMs: 0
    });
    await controller.initialize();

    await expect(controller.upload(
      new File(["audio"], "date.m4a", { type: "audio/mp4" }),
      "2026-08-04",
      {
        toyOperation: {
          operationKey: completed.operationKey,
          destination: "date_companion",
          relationshipId: completed.relationshipId
        }
      }
    )).resolves.toBe(true);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[3]).toEqual(expect.objectContaining({
      operationKey: completed.operationKey
    }));
    expect(pollDay).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().uploadState).toMatchObject({
      status: "ready",
      uploadId: completed.uploadId,
      cacheStatus: "saved",
      serverCleanupStatus: "completed"
    });
  });

  it("refreshes a persisted receipt then polls the canonical Job", async () => {
    const accepted = toyReceipt();
    const completed = toyReceipt({
      state: "completed",
      completedAt: "2026-08-04T10:05:00.000Z",
      sourceCleanedAt: "2026-08-04T10:06:00.000Z"
    });
    window.localStorage.setItem(
      "daily-brief:user_1:date-companion:session",
      JSON.stringify({
        version: 1,
        currentUploadId: accepted.uploadId,
        receipt: {
          uploadId: accepted.uploadId,
          jobId: accepted.jobId,
          status: "uploaded",
          ingestionReceipt: accepted
        }
      })
    );
    const getToyIngestionReceipt = vi.fn(async () => completed);
    const getDay = vi.fn(async () => payload(completed.uploadId, "ready"));
    const pollDay = vi.fn();
    const controller = new DateCompanionSessionController({
      api: fakeApi({
        getToyIngestionReceipt,
        getDay,
        pollDay,
        getRelationshipView: async () => relationshipView([completed.uploadId])
      }),
      cache: memoryCache().cache,
      storage: window.localStorage,
      pollIntervalMs: 0
    });

    await controller.initialize();

    expect(getToyIngestionReceipt).toHaveBeenCalledWith({
      operationKey: accepted.operationKey,
      destination: "date_companion",
      relationshipId: accepted.relationshipId
    }, expect.any(AbortSignal));
    expect(getDay).toHaveBeenCalledTimes(1);
    expect(pollDay).not.toHaveBeenCalled();
    expect(controller.getSnapshot().uploadState).toMatchObject({
      status: "ready",
      uploadId: completed.uploadId,
      cacheStatus: "saved",
      serverCleanupStatus: "completed",
      receipt: { ingestionReceipt: { state: "completed" } }
    });
    expect(JSON.parse(window.localStorage.getItem(
      "daily-brief:user_1:date-companion:session"
    ) ?? "null")).toMatchObject({
      receipt: { ingestionReceipt: { state: "completed" } }
    });
  });

  it("never deletes server data when saving the ready payload locally fails", async () => {
    const cleanup = vi.fn(async () => undefined);
    const cacheState = memoryCache();
    const cache: DateCompanionCache = {
      ...cacheState.cache,
      saveDay() {
        throw new Error("quota exceeded");
      }
    };
    const controller = new DateCompanionSessionController({
      api: fakeApi({ cleanupUpload: cleanup }),
      cache,
      storage: window.localStorage,
      pollIntervalMs: 0
    });
    await controller.initialize();

    const cacheReceiptReceived = await controller.upload(
      new File(["audio"], "date.m4a", { type: "audio/mp4" }),
      "2026-08-04"
    );

    expect(controller.getSnapshot().uploadState).toMatchObject({
      status: "failed",
      failureStage: "cache",
      serverDataRetained: true
    });
    expect(cacheReceiptReceived).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("returns true for a structured failed receipt because the server retained the upload", async () => {
    const onServerAccepted = vi.fn(async () => undefined);
    const controller = new DateCompanionSessionController({
      api: fakeApi({
        upload: async () => {
          throw new DateCompanionApiError({
            status: 500,
            code: "transcription_failed",
            details: {
              error: "transcription_failed",
              uploadId: "upload_failed",
              jobId: "job_failed",
              status: "failed"
            }
          });
        }
      }),
      cache: memoryCache().cache,
      storage: window.localStorage,
      pollIntervalMs: 0
    });
    await controller.initialize();

    await expect(controller.upload(
      new File(["audio"], "date.m4a", { type: "audio/mp4" }),
      "2026-08-04",
      { onServerAccepted }
    )).resolves.toBe(true);
    expect(onServerAccepted).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().uploadState).toMatchObject({
      status: "failed",
      uploadId: "upload_failed",
      serverDataRetained: true
    });
  });

  it("returns false when upload fails before the server accepts the file", async () => {
    const controller = new DateCompanionSessionController({
      api: fakeApi({
        upload: async () => {
          throw new TypeError("network unavailable");
        }
      }),
      cache: memoryCache().cache,
      storage: window.localStorage,
      pollIntervalMs: 0
    });
    await controller.initialize();

    await expect(controller.upload(
      new File(["audio"], "date.m4a", { type: "audio/mp4" }),
      "2026-08-04"
    )).resolves.toBe(false);
    expect(controller.getSnapshot().uploadState).toMatchObject({
      status: "failed",
      failureStage: "upload"
    });
  });

  it("keeps the server upload when participant audio snapshot import is retryable", async () => {
    const cleanup = vi.fn(async () => undefined);
    const importInteraction = vi.fn(async () => {
      throw new DateCompanionApiError({ status: 503, code: "participant_audio_snapshot_failed" });
    });
    const controller = new DateCompanionSessionController({
      api: fakeApi({ importInteraction, cleanupUpload: cleanup }),
      cache: memoryCache().cache,
      storage: window.localStorage,
      pollIntervalMs: 0
    });
    await controller.initialize();

    const importReceiptReceived = await controller.upload(
      new File(["audio"], "date.m4a", { type: "audio/mp4" }),
      "2026-08-04"
    );

    expect(importInteraction).toHaveBeenCalledWith(
      "relationship_1",
      { uploadId: "upload_1" },
      expect.any(AbortSignal)
    );
    expect(controller.getSnapshot().uploadState).toMatchObject({
      status: "failed",
      uploadId: "upload_1",
      failureStage: "relationship_import",
      serverDataRetained: true
    });
    expect(controller.getSnapshot().uploadState).not.toHaveProperty("message", expect.stringContaining("participant_audio_snapshot_failed"));
    expect(importReceiptReceived).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("retries an available interaction import after reload before cleaning its source audio", async () => {
    const cached = payload("upload_1", "ready");
    const receipt = { uploadId: "upload_1", jobId: "job_1", status: "uploaded" as const };
    window.localStorage.setItem(
      "daily-brief:user_1:date-companion:session",
      JSON.stringify({ version: 1, currentUploadId: "upload_1", receipt })
    );
    const order: string[] = [];
    const pollDay = vi.fn(async () => payload("upload_1", "ready"));
    const importedView = relationshipView(["upload_1"]);
    const importInteraction = vi.fn()
      .mockImplementationOnce(async () => {
        order.push("import-failed");
        throw new DateCompanionApiError({ status: 503, code: "participant_audio_snapshot_failed" });
      })
      .mockImplementationOnce(async () => {
        order.push("import-succeeded");
        return { interactionId: "interaction_1", reused: true, view: importedView };
      });
    const cleanupUpload = vi.fn(async () => {
      order.push("cleanup");
    });
    const api = fakeApi({
      getRelationshipView: async () => importedView,
      importInteraction,
      cleanupUpload,
      pollDay
    });
    const cache = memoryCache({ upload_1: cached }).cache;
    const first = new DateCompanionSessionController({
      api,
      cache,
      storage: window.localStorage,
      pollIntervalMs: 0
    });

    await first.initialize();

    expect(first.getSnapshot().uploadState).toMatchObject({
      status: "failed",
      failureStage: "relationship_import",
      serverDataRetained: true
    });
    expect(cleanupUpload).not.toHaveBeenCalled();
    first.dispose();

    const reloaded = new DateCompanionSessionController({
      api,
      cache,
      storage: window.localStorage,
      pollIntervalMs: 0
    });
    await reloaded.initialize();

    expect(order).toEqual(["import-failed", "import-succeeded", "cleanup"]);
    expect(importInteraction).toHaveBeenCalledTimes(2);
    expect(cleanupUpload).toHaveBeenCalledTimes(1);
    expect(pollDay).not.toHaveBeenCalled();
    expect(reloaded.getSnapshot().uploadState).toMatchObject({
      status: "ready",
      uploadId: "upload_1",
      cacheStatus: "saved",
      serverCleanupStatus: "completed"
    });
  });

  it("retries partial server cleanup from the full local cache without polling or overwriting it", async () => {
    const cached = payload("upload_1", "ready");
    cached.segments.push({
      id: "segment_full",
      uploadId: "upload_1",
      startSeconds: 0,
      endSeconds: 4,
      speaker: "speaker_1",
      text: "本机保留的完整原话",
      confidence: 0.99,
      sceneLabels: ["unknown"],
      valueLabels: []
    });
    const cacheState = memoryCache({ upload_1: cached });
    const saveDay = vi.fn(cacheState.cache.saveDay);
    const cache: DateCompanionCache = { ...cacheState.cache, saveDay };
    const receipt = { uploadId: "upload_1", jobId: "job_1", status: "uploaded" as const };
    window.localStorage.setItem(
      "daily-brief:user_1:date-companion:session",
      JSON.stringify({ version: 1, currentUploadId: "upload_1", receipt })
    );
    const pollDay = vi.fn(async () => payload("upload_1", "ready"));
    const cleanupUpload = vi.fn()
      .mockRejectedValueOnce(new DateCompanionApiError({ status: 500, code: "upload_cleanup_failed" }))
      .mockResolvedValueOnce(undefined);
    const importInteraction = vi.fn();
    const partiallyCleanedView = relationshipView(["upload_1"]);
    partiallyCleanedView.interactions[0].sourceState = "server_cleaned";
    const controller = new DateCompanionSessionController({
      api: fakeApi({
        getRelationshipView: async () => partiallyCleanedView,
        pollDay,
        importInteraction,
        cleanupUpload
      }),
      cache,
      storage: window.localStorage,
      pollIntervalMs: 0
    });

    await controller.initialize();

    expect(controller.getSnapshot().uploadState).toMatchObject({
      status: "ready",
      uploadId: "upload_1",
      serverCleanupStatus: "not_completed"
    });
    expect(pollDay).not.toHaveBeenCalled();
    expect(importInteraction).not.toHaveBeenCalled();
    expect(saveDay).not.toHaveBeenCalled();
    expect(cacheState.days.get("upload_1")?.segments.map((segment) => segment.text)).toEqual([
      "本机保留的完整原话"
    ]);

    await controller.retryRead();

    expect(cleanupUpload).toHaveBeenCalledTimes(2);
    expect(pollDay).not.toHaveBeenCalled();
    expect(saveDay).not.toHaveBeenCalled();
    expect(controller.getSnapshot().uploadState).toMatchObject({
      status: "ready",
      serverCleanupStatus: "completed"
    });
    expect(cacheState.days.get("upload_1")?.segments[0]?.text).toBe("本机保留的完整原话");
    expect(JSON.parse(window.localStorage.getItem(
      "daily-brief:user_1:date-companion:session"
    ) ?? "null")).toMatchObject({ cleanupConfirmed: true });

    controller.dispose();
    const restored = new DateCompanionSessionController({
      api: fakeApi({
        getRelationshipView: async () => partiallyCleanedView,
        pollDay,
        importInteraction,
        cleanupUpload
      }),
      cache,
      storage: window.localStorage,
      pollIntervalMs: 0
    });
    await restored.initialize();
    expect(cleanupUpload).toHaveBeenCalledTimes(2);
    expect(pollDay).not.toHaveBeenCalled();
  });

  it("resumes a cache-succeeded import failure as import then cleanup without polling again", async () => {
    const pollDay = vi.fn(async () => payload("upload_1", "ready"));
    const importInteraction = vi.fn()
      .mockRejectedValueOnce(new DateCompanionApiError({ status: 500, code: "relationship_import_failed" }))
      .mockImplementationOnce(async (_relationshipId: string, input: { uploadId: string }) => ({
        interactionId: "interaction_1",
        reused: false,
        view: relationshipView([input.uploadId])
      }));
    const cleanupUpload = vi.fn(async () => undefined);
    const cacheState = memoryCache();
    const controller = new DateCompanionSessionController({
      api: fakeApi({ pollDay, importInteraction, cleanupUpload }),
      cache: cacheState.cache,
      storage: window.localStorage,
      pollIntervalMs: 0
    });
    await controller.initialize();

    await controller.upload(new File(["audio"], "date.m4a", { type: "audio/mp4" }), "2026-08-04");
    expect(controller.getSnapshot().uploadState).toMatchObject({
      status: "failed",
      failureStage: "relationship_import",
      serverDataRetained: true
    });
    expect(cacheState.days.has("upload_1")).toBe(true);

    await controller.retryRead();

    expect(pollDay).toHaveBeenCalledTimes(1);
    expect(importInteraction).toHaveBeenCalledTimes(2);
    expect(cleanupUpload).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().uploadState).toMatchObject({
      status: "ready",
      uploadId: "upload_1",
      cacheStatus: "saved",
      serverCleanupStatus: "completed"
    });
  });

  it("uses the same cache-first cleanup resume after login", async () => {
    const cached = payload("upload_1", "ready");
    const receipt = { uploadId: "upload_1", jobId: "job_1", status: "uploaded" as const };
    window.localStorage.setItem(
      "daily-brief:user_1:date-companion:session",
      JSON.stringify({ version: 1, currentUploadId: "upload_1", receipt })
    );
    const pollDay = vi.fn(async () => payload("upload_1", "ready"));
    const cleanupUpload = vi.fn(async () => undefined);
    const controller = new DateCompanionSessionController({
      api: fakeApi({
        getCurrentUser: async () => null,
        getRelationshipView: async () => relationshipView(["upload_1"]),
        pollDay,
        cleanupUpload
      }),
      cache: memoryCache({ upload_1: cached }).cache,
      storage: window.localStorage,
      pollIntervalMs: 0
    });
    await controller.initialize();

    await controller.login({ email: "user@example.com", password: "password123" });

    expect(pollDay).not.toHaveBeenCalled();
    expect(cleanupUpload).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().uploadState).toMatchObject({
      status: "ready",
      uploadId: "upload_1",
      serverCleanupStatus: "completed"
    });
  });

  it("fails closed without uploading or creating a relationship when the user has none", async () => {
    const upload = vi.fn(async () => ({ uploadId: "upload_1", jobId: "job_1", status: "uploaded" as const }));
    const createRelationship = vi.fn(async () => ({
      relationship: relationshipView().relationship,
      reused: false
    }));
    const controller = new DateCompanionSessionController({
      api: fakeApi({ listRelationships: async () => [], upload, createRelationship }),
      cache: memoryCache().cache,
      storage: window.localStorage
    });
    await controller.initialize();

    await controller.upload(new File(["audio"], "date.m4a", { type: "audio/mp4" }), "2026-08-04");

    expect(controller.getSnapshot().relationshipState).toEqual({ status: "absent" });
    expect(controller.getSnapshot().uploadState).toMatchObject({ status: "failed", failureStage: "upload" });
    expect(upload).not.toHaveBeenCalled();
    expect(createRelationship).not.toHaveBeenCalled();
  });

  it("creates the single relationship only after the explicit user action", async () => {
    const createdView = relationshipView();
    createdView.relationship.displayName = "小满";
    const createRelationship = vi.fn(async () => ({ relationship: createdView.relationship, reused: false }));
    const getRelationshipView = vi.fn(async () => createdView);
    const controller = new DateCompanionSessionController({
      api: fakeApi({ listRelationships: async () => [], createRelationship, getRelationshipView }),
      cache: memoryCache().cache,
      storage: window.localStorage
    });
    await controller.initialize();

    expect(controller.getSnapshot().relationshipState).toEqual({ status: "absent" });
    await controller.createRelationship("  小满  ");

    expect(createRelationship).toHaveBeenCalledWith({ displayName: "小满" }, expect.any(AbortSignal));
    expect(controller.getSnapshot().relationshipState).toMatchObject({
      status: "ready",
      relationship: { id: "relationship_1", displayName: "小满" }
    });
    expect(controller.getSnapshot().viewModel.relationship).toMatchObject({
      id: "relationship_1",
      displayName: "小满"
    });
  });

  it("sends versioned participant, recap, finalize and promise mutations and adopts server views", async () => {
    const view = relationshipView(["upload_1"]);
    const updateParticipants = vi.fn(async () => view);
    const updateRecap = vi.fn(async () => view);
    const patchPromise = vi.fn(async () => view);
    const controller = new DateCompanionSessionController({
      api: fakeApi({
        getRelationshipView: async () => view,
        updateParticipants,
        updateRecap,
        patchPromise
      }),
      cache: memoryCache().cache,
      storage: window.localStorage
    });
    await controller.initialize();

    await controller.updateParticipants("interaction_1", 2, [
      { speakerId: "speaker_0", role: "self" },
      { speakerId: "speaker_1", role: "companion" }
    ]);
    await controller.updateRecap("interaction_1", 3, [
      { id: "recap_1", version: 4, userText: "改过的内容", disposition: "kept" }
    ]);
    await controller.finalizeRecap(
      "interaction_1",
      4,
      [
        { speakerId: "speaker_0", role: "self" },
        { speakerId: "speaker_1", role: "companion" }
      ],
      [{ id: "recap_1", version: 5, disposition: "kept" }],
      [{ speakerIds: ["speaker_1"] }]
    );
    await controller.finalizeRecap(
      "interaction_1",
      5,
      [
        { speakerId: "speaker_0", role: "self" },
        { speakerId: "speaker_1", role: "companion" }
      ],
      [{ id: "recap_1", version: 6, disposition: "kept" }]
    );
    await controller.updatePromise("promise_1", 5, "done");

    expect(updateParticipants).toHaveBeenCalledWith("interaction_1", {
      version: 2,
      assignments: [
        { speakerId: "speaker_0", role: "self" },
        { speakerId: "speaker_1", role: "companion" }
      ]
    }, expect.any(AbortSignal));
    expect(updateRecap).toHaveBeenNthCalledWith(1, "interaction_1", {
      version: 3,
      items: [{ id: "recap_1", version: 4, userText: "改过的内容", disposition: "kept" }],
      finalize: false
    }, expect.any(AbortSignal));
    expect(updateRecap).toHaveBeenNthCalledWith(2, "interaction_1", {
      version: 4,
      assignments: [
        { speakerId: "speaker_0", role: "self" },
        { speakerId: "speaker_1", role: "companion" }
      ],
      items: [{ id: "recap_1", version: 5, disposition: "kept" }],
      voiceEnrollmentIntents: [{ speakerIds: ["speaker_1"] }],
      finalize: true
    }, expect.any(AbortSignal));
    expect(updateRecap).toHaveBeenNthCalledWith(3, "interaction_1", {
      version: 5,
      assignments: [
        { speakerId: "speaker_0", role: "self" },
        { speakerId: "speaker_1", role: "companion" }
      ],
      items: [{ id: "recap_1", version: 6, disposition: "kept" }],
      finalize: true
    }, expect.any(AbortSignal));
    expect(patchPromise).toHaveBeenCalledWith("promise_1", { version: 5, status: "done" }, expect.any(AbortSignal));
    expect(controller.getSnapshot().mutationState).toEqual({ status: "idle" });
  });

  it("does not expose technical version-conflict codes in mutation errors", async () => {
    const controller = new DateCompanionSessionController({
      api: fakeApi({
        updateParticipants: async () => {
          throw new DateCompanionApiError({ status: 409, code: "version_conflict" });
        }
      }),
      cache: memoryCache().cache,
      storage: window.localStorage
    });
    await controller.initialize();

    await expect(
      controller.updateParticipants("interaction_1", 0, [{ speakerId: "speaker_0", role: "self" }])
    ).rejects.toThrow("内容已经在别处更新，请重新读取后再试。");

    expect(controller.getSnapshot().mutationState).toMatchObject({
      status: "error",
      operation: "participants",
      message: "内容已经在别处更新，请重新读取后再试。"
    });
  });

  it("deletes an available source through the explicit upload route and surfaces failures", async () => {
    const available = relationshipView(["upload_1"]);
    const empty = relationshipView();
    const getRelationshipView = vi.fn()
      .mockResolvedValueOnce(available)
      .mockResolvedValueOnce(empty);
    const deleteSourceUpload = vi.fn(async () => undefined);
    const deleteInteraction = vi.fn(async () => undefined);
    const cacheState = memoryCache({ upload_1: payload("upload_1") }, [answer("answer_1")]);
    const controller = new DateCompanionSessionController({
      api: fakeApi({ getRelationshipView, deleteSourceUpload, deleteInteraction }),
      cache: cacheState.cache,
      storage: window.localStorage
    });
    await controller.initialize();

    await controller.deleteInteraction("interaction_1");

    expect(deleteSourceUpload).toHaveBeenCalledWith(
      "upload_1",
      { interactionId: "interaction_1", expectedVersion: 0 },
      expect.any(AbortSignal)
    );
    expect(deleteInteraction).not.toHaveBeenCalled();
    expect(cacheState.days.has("upload_1")).toBe(false);
    expect(controller.getSnapshot().mutationState).toEqual({ status: "idle" });

    const failedView = relationshipView(["upload_2"]);
    const failedCache = memoryCache({ upload_2: payload("upload_2") });
    const failed = new DateCompanionSessionController({
      api: fakeApi({
        getRelationshipView: async () => failedView,
        deleteSourceUpload: async () => {
          throw new DateCompanionApiError({ status: 500, code: "upload_cleanup_failed" });
        }
      }),
      cache: failedCache.cache,
      storage: window.localStorage
    });
    await failed.initialize();

    await expect(failed.deleteInteraction("interaction_1")).rejects.toThrow();
    expect(failedCache.days.has("upload_2")).toBe(true);
    expect(failed.getSnapshot().mutationState).toMatchObject({ status: "error", operation: "delete" });
  });

  it("deletes a server-cleaned source through the compact interaction endpoint", async () => {
    const cleaned = relationshipView(["upload_1"]);
    cleaned.interactions[0].sourceState = "server_cleaned";
    const getRelationshipView = vi.fn()
      .mockResolvedValueOnce(cleaned)
      .mockResolvedValueOnce(relationshipView());
    const deleteSourceUpload = vi.fn(async () => undefined);
    const deleteInteraction = vi.fn(async () => undefined);
    const controller = new DateCompanionSessionController({
      api: fakeApi({ getRelationshipView, deleteSourceUpload, deleteInteraction }),
      cache: memoryCache().cache,
      storage: window.localStorage
    });
    await controller.initialize();

    await controller.deleteInteraction("interaction_1");

    expect(deleteInteraction).toHaveBeenCalledWith(
      "interaction_1",
      0,
      expect.any(AbortSignal)
    );
    expect(deleteSourceUpload).not.toHaveBeenCalled();
  });

  it("returns relationship search evidence without a broken transcript link on a new browser", async () => {
    const view = relationshipView(["upload_1"]);
    view.interactions[0] = {
      ...view.interactions[0],
      status: "confirmed",
      sourceState: "server_cleaned",
      confirmedAt: "2026-08-04T11:00:00.000Z",
      participants: [{ speakerId: "speaker_0", role: "self", confirmedAt: "2026-08-04T10:30:00.000Z" }],
      recapItems: [{
        id: "recap_1",
        interactionId: "interaction_1",
        kind: "moment",
        proposedText: "一起去看展",
        displayedText: "一起去看展",
        disposition: "kept",
        version: 1,
        sortOrder: 0,
        evidence: [{ id: "evidence_1", recapItemId: "recap_1", uploadId: "upload_1", sourceSegmentId: "segment_1", startSeconds: 1, endSeconds: 5, speakerId: "speaker_0", quote: "一起去看展", createdAt: "2026-08-04T10:00:00.000Z" }]
      }],
      memoryBridge: { status: "completed", attemptCount: 1, updatedAt: "2026-08-04T11:00:00.000Z", retryable: false }
    };
    const setting = { enabled: true, version: 1, createdAt: "2026-08-04T10:00:00.000Z", updatedAt: "2026-08-04T10:00:00.000Z", enabledAt: "2026-08-04T10:00:00.000Z", disabledAt: null };
    const mapping = { id: "mapping_1", selfPersonId: "person_self", companionPersonId: "person_companion", relationshipType: "dating" as const, status: "confirmed" as const, version: 1, confirmedAt: "2026-08-04T10:00:00.000Z", createdAt: "2026-08-04T10:00:00.000Z", updatedAt: "2026-08-04T10:00:00.000Z" };
    const controller = new DateCompanionSessionController({
      api: fakeApi({
        getRelationshipView: async () => view,
        getMemoryReview: async () => ({ retention: setting, mapping, interactions: [{ interactionId: "interaction_1", sourceUploadId: "upload_1", recordingDate: "2026-08-04", sourceState: "server_cleaned", status: "completed", attemptCount: 1, selectionCount: 1, unknownCount: 0, updatedAt: "2026-08-04T11:00:00.000Z" }] }),
        listConfirmedPeople: async () => [
          { id: "person_self", displayName: "我", status: "confirmed", version: 1, explicitlyConfirmed: true, confirmedAt: "2026-08-04T10:00:00.000Z", createdAt: "2026-08-04T10:00:00.000Z", updatedAt: "2026-08-04T10:00:00.000Z" },
          { id: "person_companion", displayName: "Ta", status: "confirmed", version: 1, explicitlyConfirmed: true, confirmedAt: "2026-08-04T10:00:00.000Z", createdAt: "2026-08-04T10:00:00.000Z", updatedAt: "2026-08-04T10:00:00.000Z" }
        ],
        getSelfBinding: async () => ({ personId: "person_self", status: "active", version: 1, setAt: "2026-08-04T10:00:00.000Z", clearedAt: null, updatedAt: "2026-08-04T10:00:00.000Z" }),
        getPersonRetainedSources: async () => [{ uploadId: "upload_1", sourceSegmentId: "segment_1", quote: "一起去看展", subjectPersonIds: ["person_self", "person_companion"] }],
        searchRelationship: async () => [
          {
            recapItemId: "recap_1",
            interactionId: "interaction_1",
            kind: "moment",
            text: "一起去看展",
            recordingDate: "2026-08-04",
            evidence: [
              {
                id: "evidence_1",
                recapItemId: "recap_1",
                uploadId: "upload_1",
                sourceSegmentId: "segment_1",
                startSeconds: 1,
                endSeconds: 5,
                speakerId: "speaker_0",
                quote: "一起去看展",
                createdAt: "2026-08-04T10:00:00.000Z"
              }
            ]
          }
        ]
      }),
      cache: memoryCache().cache,
      storage: window.localStorage
    });
    await controller.initialize();
    await controller.ensureMemoryBridgeLoaded();

    await controller.searchRelationship("看展");

    expect(controller.getSnapshot().searchState).toMatchObject({
      status: "ready",
      query: "看展",
      results: [
        expect.objectContaining({
          id: "recap_1",
          sources: [expect.objectContaining({ canOpenTranscript: false })]
        })
      ]
    });
  });

  it("ignores an older upload response even when its provider ignores AbortSignal", async () => {
    let resolveFirst!: (value: DayPayload) => void;
    const firstResult = new Promise<DayPayload>((resolve) => {
      resolveFirst = resolve;
    });
    const api = fakeApi({
      upload: async (file) => ({
        uploadId: file.name.startsWith("first") ? "upload_1" : "upload_2",
        jobId: file.name.startsWith("first") ? "job_1" : "job_2",
        status: "uploaded"
      }),
      pollDay: async (uploadId) => uploadId === "upload_1" ? firstResult : payload("upload_2", "ready")
    });
    const controller = new DateCompanionSessionController({
      api,
      cache: memoryCache().cache,
      storage: window.localStorage,
      pollIntervalMs: 0
    });
    await controller.initialize();

    const first = controller.upload(new File(["a"], "first.m4a"), "2026-08-04");
    await vi.waitFor(() => expect(controller.getSnapshot().uploadState.status).toBe("processing"));
    const second = controller.upload(new File(["b"], "second.m4a"), "2026-08-04");
    await second;
    resolveFirst(payload("upload_1", "ready"));
    await first;

    expect(controller.getSnapshot().viewModel.currentInteraction?.id).toBe("upload_2");
    expect(controller.getSnapshot().uploadState).toMatchObject({ status: "ready", uploadId: "upload_2" });
  });

  it("falls back to the same user-scoped cached recording after server cleanup", async () => {
    const cached = payload("upload_1", "ready");
    const cachedQaAnswer = answer("cached_current", "upload_1");
    const cacheState = memoryCache({ upload_1: cached }, [cachedQaAnswer]);
    const receipt = { uploadId: "upload_1", jobId: "job_1", status: "uploaded" as const };
    window.localStorage.setItem(
      "daily-brief:user_1:date-companion:session",
      JSON.stringify({ version: 1, currentUploadId: "upload_1", receipt })
    );
    const cleanedView = relationshipView(["upload_1"]);
    cleanedView.interactions[0].sourceState = "server_cleaned";
    const controller = new DateCompanionSessionController({
      api: fakeApi({
        getRelationshipView: async () => cleanedView,
        pollDay: async () => {
          throw new DateCompanionApiError({ status: 404, code: "upload_not_found" });
        }
      }),
      cache: cacheState.cache,
      storage: window.localStorage
    });

    await controller.initialize();

    expect(controller.getSnapshot().viewModel.currentInteraction?.id).toBe("upload_1");
    expect(controller.getSnapshot().uploadState).toMatchObject({
      status: "ready",
      serverCleanupStatus: "completed"
    });
    expect(controller.currentInteractionQaAvailability()).toEqual({ enabled: true, uploadId: "upload_1" });
    expect(controller.getSnapshot().currentQaHistory).toEqual([cachedQaAnswer]);
  });

  it("restores only a cache already imported into the current relationship", async () => {
    const imported = payload("upload_imported", "ready");
    imported.upload.createdAt = "2026-08-03T10:00:00.000Z";
    const unrelated = payload("upload_unrelated", "ready");
    unrelated.upload.createdAt = "2026-08-05T10:00:00.000Z";
    const controller = new DateCompanionSessionController({
      api: fakeApi({ getRelationshipView: async () => relationshipView(["upload_imported"]) }),
      cache: memoryCache({ upload_imported: imported, upload_unrelated: unrelated }).cache,
      storage: window.localStorage
    });

    await controller.initialize();

    expect(controller.getSnapshot().viewModel.currentInteraction?.id).toBe("upload_imported");
    expect(controller.getSnapshot().uploadState).toMatchObject({
      status: "ready",
      uploadId: "upload_imported",
      serverCleanupStatus: "completed"
    });
  });

  it("clears a stale persisted cache when another browser deleted its relationship interaction", async () => {
    const cached = payload("upload_deleted", "ready");
    const cacheState = memoryCache({ upload_deleted: cached });
    const receipt = { uploadId: "upload_deleted", jobId: "job_deleted", status: "uploaded" as const };
    window.localStorage.setItem(
      "daily-brief:user_1:date-companion:session",
      JSON.stringify({ version: 1, currentUploadId: "upload_deleted", receipt })
    );
    const controller = new DateCompanionSessionController({
      api: fakeApi({
        getRelationshipView: async () => relationshipView(),
        importInteraction: async () => {
          throw new DateCompanionApiError({ status: 404, code: "upload_not_found" });
        },
        pollDay: async () => {
          throw new DateCompanionApiError({ status: 404, code: "upload_not_found" });
        }
      }),
      cache: cacheState.cache,
      storage: window.localStorage
    });

    await controller.initialize();

    expect(controller.getSnapshot().viewModel.currentInteraction).toBeNull();
    expect(controller.getSnapshot().uploadState).toEqual({ status: "idle" });
    expect(cacheState.days.has("upload_deleted")).toBe(false);
    expect(window.localStorage.getItem("daily-brief:user_1:date-companion:session")).toBeNull();
  });

  it("keeps current-interaction QA separate and commits only its completed current answer", async () => {
    const local = payload("upload_1", "ready");
    local.segments = [{
      id: "segment_current",
      uploadId: "upload_1",
      startSeconds: 1,
      endSeconds: 4,
      speaker: "speaker_1",
      text: "这次聊到了周末去看电影。",
      confidence: 0.9,
      sceneLabels: ["unknown"],
      valueLabels: []
    }];
    const completedAnswer: QuestionAnswer = {
      ...answer("current_complete", "upload_1"),
      citedSegmentIds: ["segment_current"],
      citations: [{
        id: "E1",
        title: "这次相处",
        startSeconds: 1,
        endSeconds: 4,
        excerpt: "这次聊到了周末去看电影。",
        sourceSegmentIds: ["segment_current"]
      }]
    };
    const receipt = { uploadId: "upload_1", jobId: "job_1", status: "uploaded" as const };
    window.localStorage.setItem(
      "daily-brief:user_1:date-companion:session",
      JSON.stringify({ version: 1, currentUploadId: "upload_1", receipt, cleanupConfirmed: true })
    );
    const cleanedView = relationshipView(["upload_1"]);
    cleanedView.interactions[0].sourceState = "server_cleaned";
    const streamPersonQa = vi.fn(async function* () {
      // Current mode must not call Person QA.
    });
    const streamCurrentInteractionQa = vi.fn(async function* (input: Parameters<DateCompanionApi["streamCurrentInteractionQa"]>[0]) {
      expect(input).toMatchObject({ uploadId: "upload_1", question: "这次聊了什么？" });
      expect(input.segments.map((segment) => segment.id)).toEqual(["segment_current"]);
      expect(input).not.toHaveProperty("personId");
      expect(input).not.toHaveProperty("mappingVersion");
      yield { type: "meta" as const, version: 1 as const, streamId: "11111111-1111-4111-8111-111111111111" };
      yield {
        type: "sentence" as const,
        sequence: 0,
        text: "这次聊到了周末安排。",
        citedSegmentIds: ["segment_current"],
        supportIds: ["E1"],
        groundingValidated: true as const
      };
      yield { type: "final" as const, answer: completedAnswer, source: "provider_stream" as const };
      yield { type: "complete" as const, status: "completed" as const };
    });
    const cacheState = memoryCache({ upload_1: local });
    const controller = new DateCompanionSessionController({
      api: fakeApi({
        getRelationshipView: async () => cleanedView,
        streamCurrentInteractionQa,
        streamPersonQa
      }),
      cache: cacheState.cache,
      storage: window.localStorage
    });

    await controller.initialize();
    await expect(controller.askCurrentInteraction("这次聊了什么？")).resolves.toEqual(completedAnswer);

    expect(streamCurrentInteractionQa).toHaveBeenCalledTimes(1);
    expect(streamPersonQa).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      activeQaMode: "current-interaction",
      currentQaState: { status: "complete" },
      qaState: { status: "idle" },
      qaHistory: []
    });
    expect(controller.getSnapshot().currentQaHistory).toEqual([completedAnswer]);
    expect(cacheState.history()).toEqual([completedAnswer]);
  });

  it("does not commit an invalid citation or incomplete current-interaction stream", async () => {
    const local = payload("upload_1", "ready");
    const receipt = { uploadId: "upload_1", jobId: "job_1", status: "uploaded" as const };
    window.localStorage.setItem(
      "daily-brief:user_1:date-companion:session",
      JSON.stringify({ version: 1, currentUploadId: "upload_1", receipt, cleanupConfirmed: true })
    );
    const cleanedView = relationshipView(["upload_1"]);
    cleanedView.interactions[0].sourceState = "server_cleaned";
    let streamCase: "invalid" | "incomplete" = "invalid";
    const cacheState = memoryCache({ upload_1: local });
    const controller = new DateCompanionSessionController({
      api: fakeApi({
        getRelationshipView: async () => cleanedView,
        async *streamCurrentInteractionQa() {
          const result = streamCase === "invalid"
            ? {
                ...answer("invalid_current", "upload_1"),
                citedSegmentIds: ["segment_from_another_upload"]
              }
            : answer("incomplete_current", "upload_1");
          yield { type: "meta", version: 1, streamId: "11111111-1111-4111-8111-111111111111" };
          yield { type: "final", answer: result, source: "provider_stream" };
          if (streamCase === "invalid") yield { type: "complete", status: "completed" };
        }
      }),
      cache: cacheState.cache,
      storage: window.localStorage
    });

    await controller.initialize();
    await expect(controller.askCurrentInteraction("无效来源")).resolves.toBeNull();
    expect(controller.getSnapshot().currentQaHistory).toEqual([]);

    streamCase = "incomplete";
    await expect(controller.askCurrentInteraction("不完整回答")).resolves.toBeNull();
    expect(controller.getSnapshot().currentQaHistory).toEqual([]);
    expect(cacheState.history()).toEqual([]);
  });

  it("fails current QA closed without a local DayPayload while Person QA remains independently available", async () => {
    const serverView = relationshipView(["upload_server_only"]);
    serverView.interactions[0] = {
      ...serverView.interactions[0],
      status: "confirmed",
      confirmedAt: PERSON_QA_NOW,
      sourceState: "server_cleaned"
    };
    const streamCurrentInteractionQa = vi.fn(async function* () {
      // Missing local context must stop before transport.
    });
    const controller = new DateCompanionSessionController({
      api: fakeApi(validPersonQaApi({
        getRelationshipView: async () => serverView,
        streamCurrentInteractionQa
      })),
      cache: memoryCache().cache,
      storage: window.localStorage
    });

    await controller.initialize();
    expect(controller.selectRelationshipInteraction("interaction_1")).toBe(true);
    await controller.ensureMemoryBridgeLoaded();

    expect(controller.currentInteractionQaAvailability()).toMatchObject({ enabled: false });
    expect(controller.personQaAvailability()).toMatchObject({ enabled: true, personId: "person_ta" });
    await expect(controller.askCurrentInteraction("只问这一次")).resolves.toBeNull();
    expect(streamCurrentInteractionQa).not.toHaveBeenCalled();
    expect(controller.getSnapshot().currentQaState).toMatchObject({ status: "failed" });
    expect(controller.personQaAvailability()).toMatchObject({ enabled: true });
  });

  it("aborts the old stream and isolates history when switching from current interaction to Person mode", async () => {
    const local = payload("upload_1", "ready");
    const receipt = { uploadId: "upload_1", jobId: "job_1", status: "uploaded" as const };
    window.localStorage.setItem(
      "daily-brief:user_1:date-companion:session",
      JSON.stringify({ version: 1, currentUploadId: "upload_1", receipt, cleanupConfirmed: true })
    );
    const cleanedView = relationshipView(["upload_1"]);
    cleanedView.interactions[0].sourceState = "server_cleaned";
    let currentSignal: AbortSignal | undefined;
    const personAnswer = answer("person_after_switch", "person_ta");
    const controller = new DateCompanionSessionController({
      api: fakeApi(validPersonQaApi({
        getRelationshipView: async () => cleanedView,
        async *streamCurrentInteractionQa(input) {
          currentSignal = input.signal;
          yield { type: "meta", version: 1, streamId: "11111111-1111-4111-8111-111111111111" };
          await new Promise<never>((_resolve, reject) => {
            input.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          });
        },
        async *streamPersonQa() {
          yield { type: "meta", version: 1, streamId: "22222222-2222-4222-8222-222222222222" };
          yield { type: "final", answer: personAnswer, source: "provider_stream" };
          yield { type: "complete", status: "completed" };
        }
      })),
      cache: memoryCache({ upload_1: local }).cache,
      storage: window.localStorage
    });

    await controller.initialize();
    const pendingCurrent = controller.askCurrentInteraction("还在回答的当前问题");
    await vi.waitFor(() => expect(controller.getSnapshot().currentQaState.status).toBe("streaming"));

    controller.activateQaMode("person");
    expect(currentSignal?.aborted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      activeQaMode: "person",
      currentQaState: { status: "idle" },
      qaState: { status: "idle" }
    });
    await expect(pendingCurrent).resolves.toBeNull();

    await expect(controller.ask("再问 Ta")).resolves.toEqual(personAnswer);
    expect(controller.getSnapshot().currentQaHistory).toEqual([]);
    expect(controller.getSnapshot().qaHistory).toEqual([personAnswer]);
  });

  it("commits QA history only after final completion and sends at most four prior turns", async () => {
    const priorHistory = [1, 2, 3, 4, 5].map((index) => answer(`prior_${index}`, "person_ta"));
    window.localStorage.setItem(personQaHistoryKey(), JSON.stringify(priorHistory));
    const cacheState = memoryCache({ upload_1: payload() });
    let conversationLength = 0;
    const completedAnswer = answer("new_answer", "person_ta");
    const relationshipQaCalled = vi.fn();
    const api = fakeApi(validPersonQaApi({
      getRelationshipView: async () => relationshipView(["upload_1"]),
      async *streamPersonQa(input) {
        expect(input.personId).toBe("person_ta");
        conversationLength = input.conversation?.length ?? 0;
        yield { type: "meta", version: 1, streamId: "11111111-1111-4111-8111-111111111111" };
        yield { type: "final", answer: completedAnswer, source: "provider_stream" };
        yield { type: "complete", status: "completed" };
      },
      async *streamRelationshipQa() {
        relationshipQaCalled();
      }
    }));
    const controller = new DateCompanionSessionController({
      api,
      cache: cacheState.cache,
      storage: window.localStorage
    });
    await controller.initialize();

    const result = await controller.ask("这次聊了什么？");

    expect(result).toEqual(completedAnswer);
    expect(conversationLength).toBe(8);
    expect(cacheState.history()).toEqual([]);
    expect(relationshipQaCalled).not.toHaveBeenCalled();
    expect(controller.getSnapshot().qaHistory).toHaveLength(6);
    expect(JSON.parse(window.localStorage.getItem(personQaHistoryKey()) ?? "[]")).toHaveLength(6);
  });

  it("does not save an error-only QA stream as a completed answer", async () => {
    const cacheState = memoryCache({ upload_1: payload() });
    const api = fakeApi(validPersonQaApi({
      getRelationshipView: async () => relationshipView(["upload_1"]),
      async *streamPersonQa() {
        yield { type: "meta", version: 1, streamId: "11111111-1111-4111-8111-111111111111" };
        yield { type: "error", code: "provider_failed", recoverable: true };
        yield { type: "complete", status: "failed" };
      }
    }));
    const controller = new DateCompanionSessionController({ api, cache: cacheState.cache, storage: window.localStorage });
    await controller.initialize();

    await expect(controller.ask("这次聊了什么？")).resolves.toBeNull();

    expect(cacheState.history()).toEqual([]);
    expect(controller.getSnapshot().qaState).toMatchObject({ status: "failed" });
  });

  it("answers from a server Evidence snapshot when this browser has no DayPayload", async () => {
    const serverView = relationshipView(["upload_old"]);
    serverView.interactions[0] = {
      ...serverView.interactions[0],
      recordingDate: "2026-07-10",
      status: "confirmed",
      confirmedAt: "2026-07-10T11:00:00.000Z",
      sourceState: "server_cleaned",
      participants: [{
        speakerId: "speaker_ta",
        role: "companion",
        confirmedAt: "2026-07-10T11:00:00.000Z"
      }],
      recapItems: [{
        id: "recap_old",
        interactionId: "interaction_1",
        kind: "mentioned",
        proposedText: "Ta 想去海边",
        displayedText: "Ta 想去海边",
        disposition: "kept",
        version: 1,
        sortOrder: 0,
        evidence: [{
          id: "evidence_old",
          recapItemId: "recap_old",
          uploadId: "upload_old",
          sourceSegmentId: "segment_old",
          startSeconds: 1,
          endSeconds: 3,
          speakerId: "speaker_ta",
          quote: "我一直想去海边",
          createdAt: "2026-07-10T11:00:00.000Z"
        }]
      }]
    };
    const completedAnswer: QuestionAnswer = {
      id: "answer_old",
      uploadId: "person_ta",
      question: "Ta 以前想去哪里？",
      answer: "Ta 以前提过想去海边。",
      citedSegmentIds: ["segment_old"],
      citations: [{
        id: "E1",
        title: "2026-07-10 · Ta 提到的内容",
        startSeconds: 1,
        endSeconds: 3,
        excerpt: "我一直想去海边",
        sourceSegmentIds: ["segment_old"]
      }],
      createdAt: "2026-08-07T10:00:00.000Z"
    };
    const api = fakeApi(validPersonQaApi({
      getRelationshipView: async () => serverView,
      getPersonRetainedSources: async (personId) => personId === "person_ta" ? [{
        uploadId: "upload_old",
        sourceSegmentId: "segment_old",
        quote: "我一直想去海边",
        subjectPersonIds: ["person_ta"]
      }] : [],
      async *streamPersonQa(input) {
        expect(input).toMatchObject({
          personId: "person_ta",
          question: "Ta 以前想去哪里？"
        });
        expect(input).not.toHaveProperty("segments");
        yield { type: "meta", version: 1, streamId: "11111111-1111-4111-8111-111111111111" };
        yield { type: "final", answer: completedAnswer, source: "provider_stream" };
        yield { type: "complete", status: "completed" };
      }
    }));
    const controller = new DateCompanionSessionController({
      api,
      cache: memoryCache().cache,
      storage: window.localStorage
    });
    await controller.initialize();

    expect(controller.getSnapshot().viewModel.currentInteraction).toBeNull();
    await controller.ensureMemoryBridgeLoaded();
    expect(controller.personQaSources()).toEqual([
      expect.objectContaining({
        uploadId: "upload_old",
        segmentIds: ["segment_old"],
        quote: "我一直想去海边",
        canOpenTranscript: false
      })
    ]);
    await expect(controller.ask("Ta 以前想去哪里？")).resolves.toEqual(completedAnswer);
  });

  it("marks a Person citation linkable only when the matching local segment is present", async () => {
    const local = payload("upload_old");
    local.segments = [{
      id: "segment_old",
      uploadId: "upload_old",
      startSeconds: 1,
      endSeconds: 3,
      speaker: "speaker_ta",
      text: "我一直想去海边",
      confidence: 0.9,
      sceneLabels: ["unknown"],
      valueLabels: []
    }];
    const controller = new DateCompanionSessionController({
      api: fakeApi(validPersonQaApi({
        getRelationshipView: async () => relationshipView(["upload_old"]),
        getPersonRetainedSources: async (personId) => personId === "person_ta" ? [{
          uploadId: "upload_old",
          sourceSegmentId: "segment_old",
          quote: "我一直想去海边",
          subjectPersonIds: ["person_ta"]
        }] : []
      })),
      cache: memoryCache({ upload_old: local }).cache,
      storage: window.localStorage
    });
    await controller.initialize();
    await controller.ensureMemoryBridgeLoaded();

    expect(controller.personQaSources()).toEqual([
      expect.objectContaining({
        uploadId: "upload_old",
        segmentIds: ["segment_old"],
        quote: "我一直想去海边",
        canOpenTranscript: true
      })
    ]);
    expect(controller.selectCachedInteraction("upload_old")).toBe(true);
  });

  it("shows and cites a ready relationship-only catalog when Memory sources are empty", async () => {
    const view = confirmedPersonCatalogView();
    const catalog = readyPersonSourceCatalog({
      sources: [{
        evidenceSnapshotId: "snapshot_1",
        interactionId: "interaction_1",
        uploadId: "upload_1",
        sourceSegmentId: "segment_1",
        recordingDate: "2026-08-10",
        startSeconds: 1,
        endSeconds: 4,
        speakerId: "speaker_ta",
        quote: "我最近很喜欢拍夜景",
        subject: "companion"
      }]
    });
    const completedAnswer: QuestionAnswer = {
      id: "answer_relationship_only",
      uploadId: "person_ta",
      question: "Ta 最近喜欢什么？",
      answer: "Ta 提过最近喜欢拍夜景。",
      citedSegmentIds: ["segment_1"],
      citations: [{
        id: "E1",
        title: "较早的一次相处",
        startSeconds: 1,
        endSeconds: 4,
        excerpt: "我最近很喜欢拍夜景",
        sourceSegmentIds: ["segment_1"]
      }],
      createdAt: PERSON_QA_NOW
    };
    const controller = new DateCompanionSessionController({
      api: fakeApi(validPersonQaApi({
        getRelationshipView: async () => view,
        getPersonRetainedSources: async () => [],
        getPersonSourceCatalog: async () => catalog,
        async *streamPersonQa(input) {
          expect(input).toMatchObject({ personId: "person_ta", question: "Ta 最近喜欢什么？" });
          expect(input).not.toHaveProperty("sources");
          yield { type: "meta", version: 1, streamId: "11111111-1111-4111-8111-111111111111" };
          yield { type: "final", answer: completedAnswer, source: "provider_stream" };
          yield { type: "complete", status: "completed" };
        }
      })),
      cache: memoryCache().cache,
      storage: window.localStorage
    });
    await controller.initialize();
    await controller.ensureMemoryBridgeLoaded();

    expect(controller.getSnapshot().viewModel.person.remembered).toEqual([
      expect.objectContaining({ id: "recap_1", displayedText: "Ta 喜欢摄影。" })
    ]);
    expect(controller.personQaSources()).toEqual([
      expect.objectContaining({
        id: "snapshot_1",
        uploadId: "upload_1",
        segmentIds: ["segment_1"],
        quote: "我最近很喜欢拍夜景",
        canOpenTranscript: false
      })
    ]);
    await expect(controller.ask("Ta 最近喜欢什么？")).resolves.toEqual(completedAnswer);
  });

  it.each([
    ["needs_review", readyPersonSourceCatalog({ status: "needs_review", sources: [] })],
    ["unavailable", readyPersonSourceCatalog({ status: "unavailable", companionPersonId: null, mappingVersion: null, sources: [] })],
    ["wrong person", readyPersonSourceCatalog({ companionPersonId: "person_other", sources: [] })],
    ["wrong version", readyPersonSourceCatalog({ mappingVersion: 99, sources: [] })]
  ])("does not consume a %s relationship source catalog", async (_label, catalog) => {
    const view = confirmedPersonCatalogView();
    const controller = new DateCompanionSessionController({
      api: fakeApi(validPersonQaApi({
        getRelationshipView: async () => view,
        getPersonRetainedSources: async () => [],
        getPersonSourceCatalog: async () => catalog
      })),
      cache: memoryCache().cache,
      storage: window.localStorage
    });
    await controller.initialize();
    await controller.ensureMemoryBridgeLoaded();
    expect(controller.personQaSources()).toEqual([]);
    expect(controller.getSnapshot().viewModel.person.remembered).toEqual([]);
  });

  it("clears a previously visible catalog when the relationship source route becomes unavailable", async () => {
    const view = confirmedPersonCatalogView();
    let unavailable = false;
    const source = {
      evidenceSnapshotId: "snapshot_1",
      interactionId: "interaction_1",
      uploadId: "upload_1",
      sourceSegmentId: "segment_1",
      recordingDate: "2026-08-10",
      startSeconds: 1,
      endSeconds: 4,
      speakerId: "speaker_ta",
      quote: "我最近很喜欢拍夜景",
      subject: "companion" as const
    };
    const controller = new DateCompanionSessionController({
      api: fakeApi(validPersonQaApi({
        getRelationshipView: async () => view,
        getPersonRetainedSources: async () => [],
        getPersonSourceCatalog: async () => {
          if (unavailable) throw new DateCompanionApiError({ status: 404, code: "date_companion_not_found" });
          return readyPersonSourceCatalog({ sources: [source] });
        }
      })),
      cache: memoryCache().cache,
      storage: window.localStorage
    });
    await controller.initialize();
    await controller.ensureMemoryBridgeLoaded();
    expect(controller.getSnapshot().viewModel.person.remembered).toHaveLength(1);

    unavailable = true;
    await controller.ensureMemoryBridgeLoaded(true);
    expect(controller.getSnapshot().memoryBridgeState).toMatchObject({ status: "error" });
    expect(controller.personQaSources()).toEqual([]);
    expect(controller.getSnapshot().viewModel.person.remembered).toEqual([]);
  });

  it("deduplicates Memory and relationship sources by upload plus segment and links only a matching local payload", async () => {
    const view = confirmedPersonCatalogView();
    const local = payload("upload_1");
    local.segments = [{
      id: "segment_1",
      uploadId: "upload_1",
      startSeconds: 1,
      endSeconds: 4,
      speaker: "speaker_ta",
      text: "我最近很喜欢拍夜景",
      confidence: 0.9,
      sceneLabels: ["unknown"],
      valueLabels: []
    }];
    const controller = new DateCompanionSessionController({
      api: fakeApi(validPersonQaApi({
        getRelationshipView: async () => view,
        getPersonRetainedSources: async (personId) => personId === "person_ta" ? [{
          uploadId: "upload_1",
          sourceSegmentId: "segment_1",
          quote: "我最近很喜欢拍夜景",
          subjectPersonIds: ["person_ta"]
        }] : [],
        getPersonSourceCatalog: async () => readyPersonSourceCatalog({
          sources: [{
            evidenceSnapshotId: "snapshot_1",
            interactionId: "interaction_1",
            uploadId: "upload_1",
            sourceSegmentId: "segment_1",
            recordingDate: "2026-08-10",
            startSeconds: 1,
            endSeconds: 4,
            speakerId: "speaker_ta",
            quote: "我最近很喜欢拍夜景",
            subject: "companion"
          }]
        })
      })),
      cache: memoryCache({ upload_1: local }).cache,
      storage: window.localStorage
    });
    await controller.initialize();
    await controller.ensureMemoryBridgeLoaded();
    expect(controller.personQaSources()).toEqual([
      expect.objectContaining({ id: "snapshot_1", canOpenTranscript: true })
    ]);
    expect(controller.getSnapshot().memoryBridgeState).toMatchObject({
      status: "ready",
      memoryRetainedSourceKeys: [],
      relationshipPersonSources: [expect.objectContaining({ evidenceSnapshotId: "snapshot_1" })]
    });
  });

  it("removes relationship-only sources immediately and refreshes the catalog after explicit deletion", async () => {
    const retainedView = confirmedPersonCatalogView();
    const emptyView = { ...retainedView, interactions: [], promises: [] };
    let deleted = false;
    const controller = new DateCompanionSessionController({
      api: fakeApi(validPersonQaApi({
        getRelationshipView: async () => deleted ? emptyView : retainedView,
        deleteInteraction: async () => { deleted = true; },
        getPersonRetainedSources: async () => [],
        getPersonSourceCatalog: async () => deleted
          ? readyPersonSourceCatalog({ sources: [] })
          : readyPersonSourceCatalog({
              sources: [{
                evidenceSnapshotId: "snapshot_1",
                interactionId: "interaction_1",
                uploadId: "upload_1",
                sourceSegmentId: "segment_1",
                recordingDate: "2026-08-10",
                startSeconds: 1,
                endSeconds: 4,
                speakerId: "speaker_ta",
                quote: "我最近很喜欢拍夜景",
                subject: "companion"
              }]
            })
      })),
      cache: memoryCache().cache,
      storage: window.localStorage
    });
    await controller.initialize();
    await controller.ensureMemoryBridgeLoaded();
    expect(controller.personQaSources()).toHaveLength(1);

    const deletion = controller.deleteInteraction("interaction_1");
    expect(controller.personQaSources()).toEqual([]);
    await deletion;
    expect(controller.personQaSources()).toEqual([]);
    expect(controller.getSnapshot().viewModel.person.interactions).toEqual([]);
  });

  it.each([
    ["缺少人物映射", null, ["person_self", "person_ta"]],
    ["人物映射需要重新确认", personQaMapping({ status: "needs_review" }), ["person_self", "person_ta"]],
    ["人物映射已停用", personQaMapping({ status: "archived" }), ["person_self", "person_ta"]],
    ["我和 Ta 指向同一人物", personQaMapping({ companionPersonId: "person_self" }), ["person_self"]],
    ["Ta 不在已确认人物中", personQaMapping(), ["person_self"]]
  ])("fails closed when %s", async (_label, mapping, confirmedIds) => {
    const streamPersonQa = vi.fn(async function* () {
      // A blocked target must never reach transport.
    });
    const people = confirmedIds.map((id) => ({
      id,
      displayName: id,
      status: "confirmed" as const,
      version: 1,
      explicitlyConfirmed: true as const,
      confirmedAt: PERSON_QA_NOW,
      createdAt: PERSON_QA_NOW,
      updatedAt: PERSON_QA_NOW
    }));
    const controller = new DateCompanionSessionController({
      api: fakeApi(validPersonQaApi({
        listConfirmedPeople: async () => people,
        getMemoryReview: async () => ({
          retention: { enabled: true, version: 1, createdAt: PERSON_QA_NOW, updatedAt: PERSON_QA_NOW, enabledAt: PERSON_QA_NOW, disabledAt: null },
          mapping,
          interactions: []
        }),
        streamPersonQa
      })),
      cache: memoryCache().cache,
      storage: window.localStorage
    });

    await controller.initialize();
    await controller.ensureMemoryBridgeLoaded();

    expect(controller.personQaAvailability()).toMatchObject({ enabled: false });
    await expect(controller.ask("Ta 以前说过什么？")).resolves.toBeNull();
    expect(streamPersonQa).not.toHaveBeenCalled();
    expect(controller.getSnapshot().qaHistory).toEqual([]);
  });

  it("isolates local QA history by account, companion Person and mapping version", async () => {
    let mapping = personQaMapping();
    const people = ["person_self", "person_ta", "person_ta_2"].map((id) => ({
      id,
      displayName: id,
      status: "confirmed" as const,
      version: 1,
      explicitlyConfirmed: true as const,
      confirmedAt: PERSON_QA_NOW,
      createdAt: PERSON_QA_NOW,
      updatedAt: PERSON_QA_NOW
    }));
    window.localStorage.setItem(personQaHistoryKey(), JSON.stringify([answer("old_mapping", "person_ta")]));
    window.localStorage.setItem(
      personQaHistoryKey({ personId: "person_ta_2", mappingVersion: 5 }),
      JSON.stringify([answer("new_person", "person_ta_2")])
    );
    const api = fakeApi(validPersonQaApi({
      listConfirmedPeople: async () => people,
      getMemoryReview: async () => ({
        retention: { enabled: true, version: 1, createdAt: PERSON_QA_NOW, updatedAt: PERSON_QA_NOW, enabledAt: PERSON_QA_NOW, disabledAt: null },
        mapping,
        interactions: []
      })
    }));
    const controller = new DateCompanionSessionController({ api, cache: memoryCache().cache, storage: window.localStorage });
    await controller.initialize();
    await controller.ensureMemoryBridgeLoaded();
    expect(controller.getSnapshot().qaHistory.map((item) => item.id)).toEqual(["old_mapping"]);

    mapping = personQaMapping({ version: 4 });
    await controller.ensureMemoryBridgeLoaded(true);
    expect(controller.getSnapshot().qaHistory).toEqual([]);

    mapping = personQaMapping({ companionPersonId: "person_ta_2", version: 5 });
    await controller.ensureMemoryBridgeLoaded(true);
    expect(controller.getSnapshot().qaHistory.map((item) => item.id)).toEqual(["new_person"]);

    const secondAccount = new DateCompanionSessionController({
      api: fakeApi(validPersonQaApi({
        getCurrentUser: async () => ({ id: "user_2", email: "other@example.com" }),
        listConfirmedPeople: async () => people,
        getMemoryReview: async () => ({
          retention: { enabled: true, version: 1, createdAt: PERSON_QA_NOW, updatedAt: PERSON_QA_NOW, enabledAt: PERSON_QA_NOW, disabledAt: null },
          mapping,
          interactions: []
        })
      })),
      cache: memoryCache().cache,
      storage: window.localStorage
    });
    await secondAccount.initialize();
    await secondAccount.ensureMemoryBridgeLoaded();
    expect(secondAccount.getSnapshot().qaHistory).toEqual([]);
  });

  it("aborts an old Person stream and clears sources when the mapping version changes", async () => {
    let mapping = personQaMapping();
    let streamSignal: AbortSignal | undefined;
    let streamStartedResolve!: () => void;
    const streamStarted = new Promise<void>((resolve) => { streamStartedResolve = resolve; });
    const controller = new DateCompanionSessionController({
      api: fakeApi(validPersonQaApi({
        getRelationshipView: async () => confirmedPersonCatalogView(),
        getMemoryReview: async () => ({
          retention: { enabled: true, version: 1, createdAt: PERSON_QA_NOW, updatedAt: PERSON_QA_NOW, enabledAt: PERSON_QA_NOW, disabledAt: null },
          mapping,
          interactions: []
        }),
        getPersonSourceCatalog: async () => readyPersonSourceCatalog({
          mappingVersion: mapping.version,
          companionPersonId: mapping.companionPersonId,
          sources: mapping.version === 3 ? [{
            evidenceSnapshotId: "snapshot_1",
            interactionId: "interaction_1",
            uploadId: "upload_1",
            sourceSegmentId: "segment_1",
            recordingDate: "2026-08-10",
            startSeconds: 1,
            endSeconds: 4,
            speakerId: "speaker_ta",
            quote: "我最近很喜欢拍夜景",
            subject: "companion"
          }] : []
        }),
        async *streamPersonQa(input) {
          streamSignal = input.signal;
          streamStartedResolve();
          await new Promise<never>((_resolve, reject) => {
            input.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          });
        }
      })),
      cache: memoryCache().cache,
      storage: window.localStorage
    });
    await controller.initialize();
    await controller.ensureMemoryBridgeLoaded();
    const pending = controller.ask("Ta 喜欢什么？");
    await streamStarted;

    mapping = personQaMapping({ version: 4 });
    await controller.ensureMemoryBridgeLoaded(true);

    expect(streamSignal?.aborted).toBe(true);
    await expect(pending).resolves.toBeNull();
    expect(controller.personQaSources()).toEqual([]);
    expect(controller.getSnapshot().qaHistory).toEqual([]);
  });

  it("rejects an invalid Person citation and an incomplete stream without saving history", async () => {
    const invalidAnswer: QuestionAnswer = {
      ...answer("invalid_citation", "person_ta"),
      citedSegmentIds: ["segment_outside"],
      citations: [{ id: "E1", title: "不属于 Ta", startSeconds: 1, endSeconds: 2, excerpt: "错误来源", sourceSegmentIds: ["segment_outside"] }]
    };
    let mode: "invalid" | "incomplete" = "invalid";
    const controller = new DateCompanionSessionController({
      api: fakeApi(validPersonQaApi({
        getPersonRetainedSources: async (personId) => personId === "person_ta" ? [{ uploadId: "upload_1", sourceSegmentId: "segment_1", quote: "真实原话", subjectPersonIds: ["person_ta"] }] : [],
        async *streamPersonQa() {
          yield { type: "meta", version: 1, streamId: "11111111-1111-4111-8111-111111111111" };
          yield { type: "final", answer: mode === "invalid" ? invalidAnswer : answer("incomplete", "person_ta"), source: "provider_stream" };
          if (mode === "invalid") yield { type: "complete", status: "completed" };
        }
      })),
      cache: memoryCache().cache,
      storage: window.localStorage
    });
    await controller.initialize();

    await expect(controller.ask("第一次提问")).resolves.toBeNull();
    expect(controller.getSnapshot().qaHistory).toEqual([]);
    expect(window.localStorage.getItem(personQaHistoryKey())).toBeNull();

    mode = "incomplete";
    await expect(controller.ask("第二次提问")).resolves.toBeNull();
    expect(controller.getSnapshot().qaHistory).toEqual([]);
  });

  it("aborts a Person QA stream without committing a partial answer", async () => {
    const controller = new DateCompanionSessionController({
      api: fakeApi(validPersonQaApi({
        async *streamPersonQa(input) {
          yield { type: "meta", version: 1, streamId: "11111111-1111-4111-8111-111111111111" };
          await new Promise<never>((_resolve, reject) => {
            input.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          });
        }
      })),
      cache: memoryCache().cache,
      storage: window.localStorage
    });
    await controller.initialize();

    const pending = controller.ask("还在回答的问题");
    await vi.waitFor(() => expect(controller.getSnapshot().qaState.status).toBe("streaming"));
    controller.cancelQa();

    await expect(pending).resolves.toBeNull();
    expect(controller.getSnapshot().qaHistory).toEqual([]);
    expect(window.localStorage.getItem(personQaHistoryKey())).toBeNull();
  });

  it("shows a friendly fail-closed state when the Person route returns 404", async () => {
    const controller = new DateCompanionSessionController({
      api: fakeApi(validPersonQaApi({
        async *streamPersonQa() {
          throw new DateCompanionApiError({ status: 404, code: "person_not_found" });
        }
      })),
      cache: memoryCache().cache,
      storage: window.localStorage
    });
    await controller.initialize();

    await expect(controller.ask("Ta 以前说过什么？")).resolves.toBeNull();
    expect(controller.getSnapshot().qaState).toMatchObject({
      status: "failed",
      message: "人物设置已经变化，请重新确认后再试。"
    });
    expect(controller.getSnapshot().qaHistory).toEqual([]);
  });

  it("loads retention off by default and saves a distinct confirmed mapping with actual versions", async () => {
    const now = "2026-08-11T10:00:00.000Z";
    const people = ["person_self", "person_ta"].map((id) => ({ id, displayName: "林澄", status: "confirmed" as const, version: 1, explicitlyConfirmed: true as const, confirmedAt: now, createdAt: now, updatedAt: now }));
    const setSelfBinding = vi.fn(async (personId: string) => ({ personId, status: "active" as const, version: 1, setAt: now, clearedAt: null, updatedAt: now }));
    const updatePersonMapping = vi.fn(async (_relationshipId: string, input: { selfPersonId: string; companionPersonId: string; relationshipType: "dating" | "partner" | "friend" | "other"; expectedVersion: number }, _signal?: AbortSignal) => ({ id: "mapping_1", selfPersonId: input.selfPersonId, companionPersonId: input.companionPersonId, relationshipType: input.relationshipType, status: "confirmed" as const, version: 1, confirmedAt: now, createdAt: now, updatedAt: now }));
    let mapping: Awaited<ReturnType<typeof updatePersonMapping>> | null = null;
    const api = fakeApi({
      listConfirmedPeople: async () => people,
      getMemoryReview: async () => ({ retention: { enabled: false, version: 0, createdAt: now, updatedAt: now, enabledAt: null, disabledAt: null }, mapping, interactions: [] }),
      getSelfBinding: async () => null,
      setSelfBinding,
      updatePersonMapping: async (relationshipId, input, signal) => {
        mapping = await updatePersonMapping(relationshipId, input, signal);
        return mapping;
      }
    });
    const controller = new DateCompanionSessionController({ api, cache: memoryCache().cache, storage: window.localStorage });
    await controller.initialize();
    await controller.ensureMemoryBridgeLoaded();
    expect(controller.getSnapshot().memoryBridgeState).toMatchObject({ status: "ready", setting: { enabled: false, version: 0 } });

    await expect(controller.savePersonMapping({ selfPersonId: "person_self", companionPersonId: "person_self", relationshipType: "dating" })).rejects.toThrow("两个不同的人");
    expect(setSelfBinding).not.toHaveBeenCalled();
    await controller.savePersonMapping({ selfPersonId: "person_self", companionPersonId: "person_ta", relationshipType: "partner" });
    expect(setSelfBinding).toHaveBeenCalledWith("person_self", 0, expect.any(AbortSignal));
    expect(updatePersonMapping).toHaveBeenCalledWith("relationship_1", expect.objectContaining({ expectedVersion: 0, relationshipType: "partner" }), expect.any(AbortSignal));
  });

  it("refreshes server truth after a stale mapping version instead of overwriting it", async () => {
    const now = "2026-08-11T10:00:00.000Z";
    const people = ["person_self", "person_ta"].map((id) => ({ id, displayName: id, status: "confirmed" as const, version: 1, explicitlyConfirmed: true as const, confirmedAt: now, createdAt: now, updatedAt: now }));
    const getMemoryReview = vi.fn(async () => ({ retention: { enabled: false, version: 0, createdAt: now, updatedAt: now, enabledAt: null, disabledAt: null }, mapping: null, interactions: [] }));
    const api = fakeApi({
      listConfirmedPeople: async () => people,
      getMemoryReview,
      getSelfBinding: async () => ({ personId: "person_self", status: "active", version: 1, setAt: now, clearedAt: null, updatedAt: now }),
      updatePersonMapping: async () => { throw new DateCompanionApiError({ status: 409, code: "version_conflict" }); }
    });
    const controller = new DateCompanionSessionController({ api, cache: memoryCache().cache, storage: window.localStorage });
    await controller.initialize();
    await controller.ensureMemoryBridgeLoaded();
    await expect(controller.savePersonMapping({ selfPersonId: "person_self", companionPersonId: "person_ta", relationshipType: "dating" })).rejects.toThrow("已经在别处更新");
    expect(getMemoryReview).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().memoryMutationState).toMatchObject({ status: "error", operation: "mapping" });
  });

  it("blocks a stale Subject finalize and refreshes the current mapping", async () => {
    const now = "2026-08-11T10:00:00.000Z";
    const mapping = { id: "mapping_1", selfPersonId: "person_self", companionPersonId: "person_ta", relationshipType: "dating" as const, status: "confirmed" as const, version: 4, confirmedAt: now, createdAt: now, updatedAt: now };
    const getMemoryReview = vi.fn(async () => ({ retention: { enabled: true, version: 1, createdAt: now, updatedAt: now, enabledAt: now, disabledAt: null }, mapping, interactions: [] }));
    const updateRecap = vi.fn(async () => { throw new DateCompanionApiError({ status: 409, code: "version_conflict" }); });
    const controller = new DateCompanionSessionController({
      api: fakeApi({ getMemoryReview, getPersonRetainedSources: async () => [], updateRecap }),
      cache: memoryCache().cache,
      storage: window.localStorage
    });
    await controller.initialize();
    await controller.ensureMemoryBridgeLoaded();
    await expect(controller.finalizeRecap(
      "interaction_1",
      2,
      [{ speakerId: "speaker_1", role: "companion" }],
      [{ id: "recap_1", version: 1, disposition: "kept" }],
      [],
      {
        mappingVersion: 3,
        subjectSuggestionConfirmation: {
          batchId: "batch_1",
          evidenceDigest: "a".repeat(64),
          proposalDigest: "b".repeat(64),
          confirmationFingerprint: "c".repeat(64),
          confirmedVisibleSuggestions: true
        },
        selections: [{ evidenceSnapshotId: "evidence_1", subject: "companion" }]
      }
    )).rejects.toThrow("已经在别处更新");
    expect(updateRecap).toHaveBeenCalledTimes(1);
    expect(getMemoryReview).toHaveBeenCalledTimes(2);
  });

  it("deduplicates repeated sync clicks and clears account-scoped bridge state on logout", async () => {
    const now = "2026-08-11T10:00:00.000Z";
    const mapping = { id: "mapping_1", selfPersonId: "person_self", companionPersonId: "person_ta", relationshipType: "dating" as const, status: "confirmed" as const, version: 2, confirmedAt: now, createdAt: now, updatedAt: now };
    let resolveSync!: () => void;
    const syncInteractionMemory = vi.fn(() => new Promise<null>((resolve) => { resolveSync = () => resolve(null); }));
    const api = fakeApi({
      listConfirmedPeople: async () => [],
      getSelfBinding: async () => null,
      getMemoryReview: async () => ({ retention: { enabled: true, version: 1, createdAt: now, updatedAt: now, enabledAt: now, disabledAt: null }, mapping, interactions: [] }),
      getPersonRetainedSources: async () => [],
      syncInteractionMemory
    });
    const controller = new DateCompanionSessionController({ api, cache: memoryCache().cache, storage: window.localStorage });
    await controller.initialize();
    await controller.ensureMemoryBridgeLoaded();
    const confirmation = {
      batchId: "batch_1",
      evidenceDigest: "a".repeat(64),
      proposalDigest: "b".repeat(64),
      confirmationFingerprint: "c".repeat(64),
      confirmedVisibleSuggestions: true as const
    };
    const selections = [{ evidenceSnapshotId: "evidence_1", subject: "unknown" as const }];
    const first = controller.syncInteractionMemory("interaction_1", selections, confirmation);
    const second = controller.syncInteractionMemory("interaction_1", selections, confirmation);
    expect(syncInteractionMemory).toHaveBeenCalledTimes(1);
    expect(syncInteractionMemory).toHaveBeenCalledWith(
      "interaction_1",
      { mappingVersion: 2, selections, subjectSuggestionConfirmation: confirmation },
      expect.any(AbortSignal)
    );
    resolveSync();
    await Promise.all([first, second]);
    await controller.logout();
    expect(controller.getSnapshot().memoryBridgeState).toEqual({ status: "idle" });
    expect(controller.getSnapshot().memoryMutationState).toEqual({ status: "idle" });
  });

  it("surfaces a visible error instead of silently ignoring sync before the bridge is ready", async () => {
    const syncInteractionMemory = vi.fn(async () => null);
    const controller = new DateCompanionSessionController({
      api: fakeApi({ syncInteractionMemory }),
      cache: memoryCache().cache,
      storage: window.localStorage
    });
    await controller.initialize();

    await expect(controller.syncInteractionMemory("interaction_1")).rejects.toThrow(
      "人物与长期保留设置还没有读取完成"
    );
    expect(syncInteractionMemory).not.toHaveBeenCalled();
    expect(controller.getSnapshot().memoryMutationState).toEqual({
      status: "error",
      operation: "sync",
      message: "人物与长期保留设置还没有读取完成，请稍后再试。",
      targetId: "interaction_1"
    });
  });

  it("forwards an explicit archived-relationship reconfirmation and applies its allowlisted review", async () => {
    const now = "2026-08-11T10:00:00.000Z";
    const mapping = { id: "mapping_1", selfPersonId: "person_self", companionPersonId: "person_ta", relationshipType: "dating" as const, status: "confirmed" as const, version: 2, confirmedAt: now, createdAt: now, updatedAt: now };
    const retention = { enabled: true, version: 1, createdAt: now, updatedAt: now, enabledAt: now, disabledAt: null };
    const reviewReason = {
      kind: "relationship_reconfirmation_required" as const,
      canReconfirm: true as const,
      reason: "relationship_was_archived" as const,
      nextAction: "reconfirm_archived_relationship" as const
    };
    const syncInteractionMemory = vi.fn(async () => ({
      status: "pending" as const,
      attemptCount: 2,
      updatedAt: now,
      retryable: true,
      review: reviewReason
    }));
    const controller = new DateCompanionSessionController({
      api: fakeApi({
        listConfirmedPeople: async () => [],
        getSelfBinding: async () => null,
        getMemoryReview: async () => ({
          retention,
          mapping,
          interactions: [{
            interactionId: "interaction_1",
            sourceUploadId: "upload_1",
            recordingDate: "2026-08-11",
            sourceState: "server_cleaned" as const,
            status: "needs_review" as const,
            attemptCount: 1,
            selectionCount: 1,
            unknownCount: 0,
            updatedAt: now,
            review: reviewReason
          }]
        }),
        getPersonRetainedSources: async () => [],
        syncInteractionMemory
      }),
      cache: memoryCache().cache,
      storage: window.localStorage,
      memoryBridgePollTimeoutMs: 0
    });
    await controller.initialize();
    await controller.ensureMemoryBridgeLoaded();
    const reconfirmation = {
      action: "reconfirm_archived_relationship" as const,
      idempotencyKey: "stable-reconfirmation-key"
    };

    await controller.syncInteractionMemory(
      "interaction_1",
      [{ evidenceSnapshotId: "evidence_1", subject: "companion" }],
      undefined,
      reconfirmation
    );

    expect(syncInteractionMemory).toHaveBeenCalledWith(
      "interaction_1",
      {
        mappingVersion: 2,
        selections: [{ evidenceSnapshotId: "evidence_1", subject: "companion" }],
        relationshipReconfirmation: reconfirmation
      },
      expect.any(AbortSignal)
    );
    expect(controller.getSnapshot().memoryBridgeState).toMatchObject({
      status: "ready",
      review: {
        interactions: [{
          interactionId: "interaction_1",
          status: "pending",
          review: reviewReason
        }]
      }
    });
  });

  it("polls only the memory review until a queued sync completes", async () => {
    const now = "2026-08-11T10:00:00.000Z";
    const mapping = { id: "mapping_1", selfPersonId: "person_self", companionPersonId: "person_ta", relationshipType: "dating" as const, status: "confirmed" as const, version: 2, confirmedAt: now, createdAt: now, updatedAt: now };
    const retention = { enabled: true, version: 1, createdAt: now, updatedAt: now, enabledAt: now, disabledAt: null };
    const statuses = ["pending", "processing", "completed"] as const;
    let syncAccepted = false;
    let statusIndex = 0;
    const getMemoryReview = vi.fn(async () => ({
      retention,
      mapping,
      interactions: syncAccepted ? [{
        interactionId: "interaction_1",
        sourceUploadId: "upload_1",
        recordingDate: "2026-08-11",
        sourceState: "server_cleaned" as const,
        status: statuses[Math.min(statusIndex++, statuses.length - 1)],
        attemptCount: 1,
        selectionCount: 1,
        unknownCount: 0,
        updatedAt: now
      }] : []
    }));
    const syncInteractionMemory = vi.fn(async () => {
      syncAccepted = true;
      return { status: "pending" as const, attemptCount: 1, updatedAt: now, retryable: true };
    });
    const controller = new DateCompanionSessionController({
      api: fakeApi({
        listConfirmedPeople: async () => [],
        getSelfBinding: async () => null,
        getMemoryReview,
        getPersonRetainedSources: async () => [],
        syncInteractionMemory
      }),
      cache: memoryCache().cache,
      storage: window.localStorage,
      pollIntervalMs: 0,
      memoryBridgePollTimeoutMs: 1_000
    });
    await controller.initialize();
    await controller.ensureMemoryBridgeLoaded();

    await controller.syncInteractionMemory("interaction_1", [{ evidenceSnapshotId: "evidence_1", subject: "companion" }]);

    expect(syncInteractionMemory).toHaveBeenCalledTimes(1);
    expect(getMemoryReview).toHaveBeenCalled();
    expect(controller.getSnapshot().memoryBridgeState).toMatchObject({
      status: "ready",
      review: { interactions: [{ interactionId: "interaction_1", status: "completed" }] }
    });
    expect(controller.getSnapshot().memoryMutationState).toEqual({ status: "idle" });
  });

  it("stops automatic memory review polling at the configured deadline without resubmitting", async () => {
    vi.useFakeTimers();
    try {
      const now = "2026-08-11T10:00:00.000Z";
      const mapping = { id: "mapping_1", selfPersonId: "person_self", companionPersonId: "person_ta", relationshipType: "dating" as const, status: "confirmed" as const, version: 2, confirmedAt: now, createdAt: now, updatedAt: now };
      const retention = { enabled: true, version: 1, createdAt: now, updatedAt: now, enabledAt: now, disabledAt: null };
      let syncAccepted = false;
      let postSyncReads = 0;
      const review = () => ({
        retention,
        mapping,
        interactions: [{
          interactionId: "interaction_1",
          sourceUploadId: "upload_1",
          recordingDate: "2026-08-11",
          sourceState: "server_cleaned" as const,
          status: syncAccepted ? "processing" as const : "not_queued" as const,
          attemptCount: 1,
          selectionCount: 1,
          unknownCount: 0,
          updatedAt: now
        }]
      });
      const getMemoryReview = vi.fn((_relationshipId: string, signal?: AbortSignal) => {
        if (syncAccepted && postSyncReads++ === 0) {
          return new Promise<ReturnType<typeof review>>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          });
        }
        return Promise.resolve(review());
      });
      const syncInteractionMemory = vi.fn(async () => {
        syncAccepted = true;
        return { status: "pending" as const, attemptCount: 1, updatedAt: now, retryable: true };
      });
      const controller = new DateCompanionSessionController({
        api: fakeApi({
          listConfirmedPeople: async () => [],
          getSelfBinding: async () => null,
          getMemoryReview,
          getPersonRetainedSources: async () => [],
          syncInteractionMemory
        }),
        cache: memoryCache().cache,
        storage: window.localStorage,
        pollIntervalMs: 10,
        memoryBridgePollTimeoutMs: 25
      });
      await controller.initialize();
      await controller.ensureMemoryBridgeLoaded();

      const sync = controller.syncInteractionMemory("interaction_1", [{ evidenceSnapshotId: "evidence_1", subject: "companion" }]);
      await vi.advanceTimersByTimeAsync(30);
      await sync;

      expect(syncInteractionMemory).toHaveBeenCalledTimes(1);
      expect(controller.getSnapshot().memoryBridgeState).toMatchObject({
        status: "ready",
        review: { interactions: [{ interactionId: "interaction_1", status: "pending" }] }
      });
      expect(controller.getSnapshot().memoryMutationState).toEqual({ status: "idle" });
    } finally {
      vi.useRealTimers();
    }
  });
});
