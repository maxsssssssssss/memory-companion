import { useEffect } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseDayPayload, type DayPayload } from "@/lib/domain/day-payload";
import type { DcRelationshipView } from "@/lib/domain/date-companion-stage2";
import type { QuestionAnswer } from "@/lib/domain/types";

import type { DateCompanionApi } from "./date-companion-api";
import {
  DateCompanionSessionController,
  type DateCompanionCache,
  type DateCompanionSessionOptions
} from "./date-companion-session";
import {
  DateCompanionSessionProvider,
  usePersistentDateCompanionSession
} from "./date-companion-session-provider";

function readyPayload(): DayPayload {
  return parseDayPayload({
    upload: {
      id: "upload_1",
      originalName: "date.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 2_048,
      recordingDate: "2026-08-04",
      createdAt: "2026-08-04T10:00:00.000Z",
      durationSeconds: 10,
      status: "ready"
    },
    job: {
      id: "job_1",
      uploadId: "upload_1",
      status: "ready",
      progress: 100
    },
    segments: [],
    audioInsights: [],
    semanticSegments: [],
    semanticSegmentsAvailable: true,
    briefItems: [],
    relationshipSignals: [],
    relationshipSignalsAvailable: true,
    proactiveInsights: [],
    proactiveInsightsAvailable: true,
    speakerAliases: {},
    speakerAliasesByUploadId: { upload_1: {} }
  });
}

function relationshipView(): DcRelationshipView {
  return {
    relationship: {
      id: "relationship_1",
      displayName: "Ta",
      status: "active",
      version: 0,
      createdAt: "2026-08-04T09:00:00.000Z",
      updatedAt: "2026-08-04T09:00:00.000Z"
    },
    interactions: [{
      id: "interaction_1",
      relationshipId: "relationship_1",
      sourceUploadId: "upload_1",
      recordingDate: "2026-08-04",
      originalName: "date.m4a",
      durationSeconds: 10,
      status: "draft",
      sourceState: "server_cleaned",
      version: 0,
      createdAt: "2026-08-04T10:00:00.000Z",
      updatedAt: "2026-08-04T10:00:00.000Z",
      participants: [],
      recapItems: []
    }],
    promises: []
  };
}

function completedAnswer(): QuestionAnswer {
  return {
    id: "answer_1",
    uploadId: "person_ta",
    question: "这次聊了什么？",
    answer: "聊到了周末的安排。",
    citedSegmentIds: [],
    citations: [],
    createdAt: "2026-08-04T12:00:00.000Z"
  };
}

function createCache(payload: DayPayload, history: QuestionAnswer[]): DateCompanionCache {
  return {
    saveDay: vi.fn(),
    readDay: vi.fn((uploadId) => uploadId === payload.upload.id ? payload : null),
    listDays: vi.fn(() => [{
      uploadId: payload.upload.id,
      recordingDate: payload.upload.recordingDate,
      originalName: payload.upload.originalName,
      createdAt: payload.upload.createdAt ?? ""
    }]),
    deleteDay: vi.fn(),
    readQaHistory: vi.fn((scopeId) => scopeId === "relationship_1" ? history : []),
    appendQaHistory: vi.fn(),
    clearQaHistory: vi.fn()
  };
}

function createApi(view: DcRelationshipView) {
  const getCurrentUser = vi.fn(async () => ({ id: "user_1", email: "user@example.com" }));
  const listRelationships = vi.fn(async () => [view.relationship]);
  const getRelationshipView = vi.fn(async () => view);
  const importInteraction = vi.fn(async () => ({
    interactionId: "interaction_1",
    reused: true,
    view
  }));
  const cleanupUpload = vi.fn(async () => undefined);
  const pollDay = vi.fn(async () => readyPayload());
  const listConfirmedPeople = vi.fn(async () => [
    { id: "person_self", displayName: "我", status: "confirmed" as const, version: 1, explicitlyConfirmed: true as const, confirmedAt: "2026-08-04T10:00:00.000Z", createdAt: "2026-08-04T10:00:00.000Z", updatedAt: "2026-08-04T10:00:00.000Z" },
    { id: "person_ta", displayName: "Ta", status: "confirmed" as const, version: 1, explicitlyConfirmed: true as const, confirmedAt: "2026-08-04T10:00:00.000Z", createdAt: "2026-08-04T10:00:00.000Z", updatedAt: "2026-08-04T10:00:00.000Z" }
  ]);
  const getSelfBinding = vi.fn(async () => ({ personId: "person_self", status: "active" as const, version: 1, setAt: "2026-08-04T10:00:00.000Z", clearedAt: null, updatedAt: "2026-08-04T10:00:00.000Z" }));
  const getMemoryReview = vi.fn(async () => ({
    retention: { enabled: true, version: 1, createdAt: "2026-08-04T10:00:00.000Z", updatedAt: "2026-08-04T10:00:00.000Z", enabledAt: "2026-08-04T10:00:00.000Z", disabledAt: null },
    mapping: { id: "mapping_1", selfPersonId: "person_self", companionPersonId: "person_ta", relationshipType: "dating" as const, status: "confirmed" as const, version: 3, confirmedAt: "2026-08-04T10:00:00.000Z", createdAt: "2026-08-04T10:00:00.000Z", updatedAt: "2026-08-04T10:00:00.000Z" },
    interactions: []
  }));
  const getPersonSourceCatalog = vi.fn(async () => ({
    relationshipId: view.relationship.id,
    companionPersonId: "person_ta",
    mappingVersion: 3,
    status: "ready" as const,
    sources: []
  }));
  const getPersonRetainedSources = vi.fn(async () => []);

  const api: DateCompanionApi = {
    getCurrentUser,
    login: async () => ({ id: "user_1", email: "user@example.com" }),
    register: async () => ({ id: "user_1", email: "user@example.com" }),
    logout: async () => undefined,
    upload: async () => ({ uploadId: "upload_1", jobId: "job_1", status: "uploaded" }),
    getToyIngestionReceipt: async () => null,
    getDay: async () => readyPayload(),
    pollDay,
    cleanupUpload,
    deleteSourceUpload: async () => undefined,
    listRelationships,
    createRelationship: async () => ({ relationship: view.relationship, reused: true }),
    getRelationshipView,
    importInteraction,
    updateParticipants: async () => view,
    updateRecap: async () => view,
    patchPromise: async () => view,
    searchRelationship: async () => [],
    deleteInteraction: async () => undefined,
    async *streamCurrentInteractionQa() {
      // The persistence test restores prior QA history and does not issue a new request.
    },
    async *streamRelationshipQa() {
      // The persistence test restores prior QA history and does not issue a new request.
    },
    async *streamPersonQa() {
      // The persistence test restores prior QA history and does not issue a new request.
    },
    listConfirmedPeople,
    createPersonCandidate: async () => { throw new Error("unexpected person creation"); },
    confirmPerson: async () => { throw new Error("unexpected person confirmation"); },
    getSelfBinding,
    setSelfBinding: async () => { throw new Error("unexpected self binding"); },
    getMemorySetting: async () => { throw new Error("unexpected setting read"); },
    updateMemorySetting: async () => { throw new Error("unexpected setting update"); },
    getPersonMapping: async () => null,
    updatePersonMapping: async () => { throw new Error("unexpected mapping update"); },
    getMemoryReview,
    getPersonSourceCatalog,
    getPersonRetainedSources,
    syncInteractionMemory: async () => null,
    purgeRetainedMemory: async () => { throw new Error("unexpected purge"); }
  };

  return {
    api,
    bootstrap: { getCurrentUser, listRelationships, getRelationshipView },
    bridge: { listConfirmedPeople, getSelfBinding, getMemoryReview, getPersonSourceCatalog, getPersonRetainedSources },
    unexpectedWork: { importInteraction, cleanupUpload, pollDay }
  };
}

function SessionProbe({ screenName }: { screenName: string }) {
  const session = usePersistentDateCompanionSession();
  useEffect(() => {
    if (session.relationshipState.status === "ready") void session.ensureMemoryBridgeLoaded();
  }, [session.ensureMemoryBridgeLoaded, session.relationshipState.status]);
  const loading = session.auth.status === "checking"
    || session.relationshipState.status === "idle"
    || session.relationshipState.status === "loading";

  return (
    <main
      data-auth={session.auth.status}
      data-current-interaction={session.viewModel.currentInteraction?.id ?? "none"}
      data-loading={String(loading)}
      data-qa-count={String(session.qaHistory.length)}
      data-relationship={session.relationshipState.status}
      data-screen={screenName}
      data-upload={session.uploadState.status}
      data-testid="session-probe"
    />
  );
}

describe("DateCompanionSessionProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps one initialized session while the four companion screens replace their page subtree", async () => {
    const view = relationshipView();
    const apiState = createApi(view);
    const payload = readyPayload();
    const cache = createCache(payload, [completedAnswer()]);
    const options: DateCompanionSessionOptions = {
      api: apiState.api,
      cache,
      storage: window.localStorage,
      pollIntervalMs: 0
    };
    window.localStorage.setItem(
      "daily-brief:user_1:date-companion:session",
      JSON.stringify({
        version: 1,
        currentUploadId: "upload_1",
        receipt: { uploadId: "upload_1", jobId: "job_1", status: "uploaded" },
        cleanupConfirmed: true
      })
    );
    window.localStorage.setItem(
      "daily-brief:user_1:date-companion:person-qa:relationship_1:person_ta:mapping-3:v1",
      JSON.stringify([completedAnswer()])
    );
    const initialize = vi.spyOn(DateCompanionSessionController.prototype, "initialize");
    const dispose = vi.spyOn(DateCompanionSessionController.prototype, "dispose");

    const renderTree = (screenName: string) => (
      <DateCompanionSessionProvider options={options}>
        <SessionProbe key={screenName} screenName={screenName} />
      </DateCompanionSessionProvider>
    );
    const rendered = render(renderTree("home"));

    await waitFor(() => {
      const probe = screen.getByTestId("session-probe");
      expect(probe).toHaveAttribute("data-auth", "authenticated");
      expect(probe).toHaveAttribute("data-relationship", "ready");
      expect(probe).toHaveAttribute("data-current-interaction", "upload_1");
      expect(probe).toHaveAttribute("data-upload", "ready");
      expect(probe).toHaveAttribute("data-qa-count", "1");
      expect(probe).toHaveAttribute("data-loading", "false");
    });

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(apiState.bootstrap.getCurrentUser).toHaveBeenCalledTimes(1);
    expect(apiState.bootstrap.listRelationships).toHaveBeenCalledTimes(1);
    expect(apiState.bootstrap.getRelationshipView).toHaveBeenCalledTimes(1);
    const bridgeCallsAfterReady = {
      people: apiState.bridge.listConfirmedPeople.mock.calls.length,
      self: apiState.bridge.getSelfBinding.mock.calls.length,
      review: apiState.bridge.getMemoryReview.mock.calls.length,
      catalog: apiState.bridge.getPersonSourceCatalog.mock.calls.length,
      sources: apiState.bridge.getPersonRetainedSources.mock.calls.length
    };
    expect(bridgeCallsAfterReady.people).toBeGreaterThan(0);
    expect(bridgeCallsAfterReady.self).toBeGreaterThan(0);
    expect(bridgeCallsAfterReady.review).toBeGreaterThan(0);
    expect(bridgeCallsAfterReady.catalog).toBeGreaterThan(0);
    expect(bridgeCallsAfterReady.sources).toBeGreaterThan(0);
    expect(apiState.unexpectedWork.importInteraction).not.toHaveBeenCalled();
    expect(apiState.unexpectedWork.cleanupUpload).not.toHaveBeenCalled();
    expect(apiState.unexpectedWork.pollDay).not.toHaveBeenCalled();

    for (const screenName of ["person", "recap", "prepare"]) {
      rendered.rerender(renderTree(screenName));
      const probe = screen.getByTestId("session-probe");
      expect(probe).toHaveAttribute("data-screen", screenName);
      expect(probe).toHaveAttribute("data-auth", "authenticated");
      expect(probe).toHaveAttribute("data-relationship", "ready");
      expect(probe).toHaveAttribute("data-current-interaction", "upload_1");
      expect(probe).toHaveAttribute("data-upload", "ready");
      expect(probe).toHaveAttribute("data-qa-count", "1");
      expect(probe).toHaveAttribute("data-loading", "false");
      expect(apiState.bootstrap.getCurrentUser).toHaveBeenCalledTimes(1);
      expect(apiState.bootstrap.listRelationships).toHaveBeenCalledTimes(1);
      expect(apiState.bootstrap.getRelationshipView).toHaveBeenCalledTimes(1);
      expect(apiState.bridge.listConfirmedPeople).toHaveBeenCalledTimes(bridgeCallsAfterReady.people);
      expect(apiState.bridge.getSelfBinding).toHaveBeenCalledTimes(bridgeCallsAfterReady.self);
      expect(apiState.bridge.getMemoryReview).toHaveBeenCalledTimes(bridgeCallsAfterReady.review);
      expect(apiState.bridge.getPersonSourceCatalog).toHaveBeenCalledTimes(bridgeCallsAfterReady.catalog);
      expect(apiState.bridge.getPersonRetainedSources).toHaveBeenCalledTimes(bridgeCallsAfterReady.sources);
      expect(dispose).not.toHaveBeenCalled();
    }

    rendered.unmount();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
