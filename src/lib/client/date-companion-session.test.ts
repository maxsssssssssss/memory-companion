import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseDayPayload, type DayPayload } from "@/lib/domain/day-payload";
import type { DcRelationshipView } from "@/lib/domain/date-companion-stage2";
import type { QuestionAnswer } from "@/lib/domain/types";

import { DateCompanionApiError, type DateCompanionApi } from "./date-companion-api";
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

function answer(id: string, uploadId = "upload_1"): QuestionAnswer {
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

function fakeApi(overrides: Partial<DateCompanionApi> = {}): DateCompanionApi {
  const emptyRelationshipView = relationshipView();
  return {
    getCurrentUser: async () => ({ id: "user_1", email: "user@example.com" }),
    login: async () => ({ id: "user_1", email: "user@example.com" }),
    logout: async () => undefined,
    upload: async () => ({ uploadId: "upload_1", jobId: "job_1", status: "uploaded" }),
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
    ...overrides
  };
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

    await controller.upload(new File(["audio"], "date.m4a", { type: "audio/mp4" }), "2026-08-04");

    expect(controller.getSnapshot()).toMatchObject({
      auth: { status: "anonymous" },
      uploadState: { status: "idle" },
      qaState: { status: "idle" }
    });
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

    await controller.upload(new File(["audio"], "date.m4a", { type: "audio/mp4" }), "2026-08-04");

    expect(pollDay).toHaveBeenCalledWith(
      "upload_deferred",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(controller.getSnapshot().uploadState).toMatchObject({
      status: "ready",
      uploadId: "upload_deferred",
      receipt
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

    await controller.upload(new File(["audio"], "date.m4a", { type: "audio/mp4" }), "2026-08-04");

    expect(controller.getSnapshot().uploadState).toMatchObject({
      status: "failed",
      failureStage: "cache",
      serverDataRetained: true
    });
    expect(cleanup).not.toHaveBeenCalled();
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

    await controller.upload(new File(["audio"], "date.m4a", { type: "audio/mp4" }), "2026-08-04");

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
    const controller = new DateCompanionSessionController({
      api: fakeApi({
        getRelationshipView: async () => view,
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
    const cacheState = memoryCache({ upload_1: cached });
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

  it("commits QA history only after final completion and sends at most four prior turns", async () => {
    const priorHistory = [1, 2, 3, 4, 5].map((index) => answer(`prior_${index}`));
    const cacheState = memoryCache({ upload_1: payload() }, priorHistory);
    let conversationLength = 0;
    const completedAnswer = answer("new_answer");
    const api = fakeApi({
      getRelationshipView: async () => relationshipView(["upload_1"]),
      async *streamCurrentInteractionQa(input) {
        conversationLength = input.conversation?.length ?? 0;
        yield { type: "meta", version: 1, streamId: "11111111-1111-4111-8111-111111111111" };
        yield { type: "final", answer: completedAnswer, source: "provider_stream" };
        yield { type: "complete", status: "completed" };
      }
    });
    const controller = new DateCompanionSessionController({
      api,
      cache: cacheState.cache,
      storage: window.localStorage
    });
    await controller.initialize();

    const result = await controller.ask("这次聊了什么？");

    expect(result).toEqual(completedAnswer);
    expect(conversationLength).toBe(8);
    expect(cacheState.history().at(-1)?.id).toBe("new_answer");
    expect(controller.getSnapshot().qaHistory).toHaveLength(6);
  });

  it("does not save an error-only QA stream as a completed answer", async () => {
    const cacheState = memoryCache({ upload_1: payload() });
    const api = fakeApi({
      getRelationshipView: async () => relationshipView(["upload_1"]),
      async *streamCurrentInteractionQa() {
        yield { type: "meta", version: 1, streamId: "11111111-1111-4111-8111-111111111111" };
        yield { type: "error", code: "provider_failed", recoverable: true };
        yield { type: "complete", status: "failed" };
      }
    });
    const controller = new DateCompanionSessionController({ api, cache: cacheState.cache, storage: window.localStorage });
    await controller.initialize();

    await expect(controller.ask("这次聊了什么？")).resolves.toBeNull();

    expect(cacheState.history()).toEqual([]);
    expect(controller.getSnapshot().qaState).toMatchObject({ status: "failed" });
  });
});
