import { afterEach, describe, expect, it, vi } from "vitest";

import {
  confirmDateCompanionSubjectSuggestions,
  getDateCompanionSubjectSuggestionStatus,
  loadDateCompanionSubjectSuggestions,
  requestDateCompanionSubjectSuggestions
} from "./date-companion-subject-suggestions";

const batch = {
  batchId: "batch_1",
  interactionId: "interaction_1",
  interactionVersion: 0,
  mappingVersion: 2,
  evidenceDigest: "a".repeat(64),
  proposalDigest: "b".repeat(64),
  confirmationFingerprint: "c".repeat(64),
  model: "Qwen/Qwen3.6-27B",
  status: "ready",
  suggestions: [{
    canonicalSourceKey: "d".repeat(64),
    uploadId: "upload_1",
    sourceSegmentId: "segment_1",
    contentDigest: "e".repeat(64),
    recapItemIds: ["recap_1"],
    evidenceSnapshotIds: ["evidence_1"],
    proposedSubject: "companion",
    confidence: 0.95,
    reasonCode: "explicit_companion_reference"
  }],
  createdAt: "2026-08-18T08:00:00.000Z"
} as const;

describe("Date Companion Subject suggestion client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads one server-owned batch for an interaction", async () => {
    const fetchMock = vi.fn(async () => Response.json({ batch }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestDateCompanionSubjectSuggestions("interaction_1")).resolves.toEqual(batch);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/date-companion/interactions/interaction_1/subject-suggestions",
      { method: "POST", signal: undefined }
    );
  });

  it("reads a persisted batch status without a generation request", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      status: "ready",
      interactionId: batch.interactionId,
      interactionVersion: batch.interactionVersion,
      mappingVersion: batch.mappingVersion,
      evidenceDigest: batch.evidenceDigest,
      batch
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getDateCompanionSubjectSuggestionStatus("interaction_1"))
      .resolves.toMatchObject({ status: "ready", batch });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/date-companion/interactions/interaction_1/subject-suggestions",
      { method: "GET", signal: undefined }
    );
  });

  it("retries an initial temporary status failure and reuses the persisted batch without POST", async () => {
    let reads = 0;
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      reads += 1;
      return reads === 1
        ? Response.json({ error: "temporarily_unavailable" }, { status: 503 })
        : Response.json({
            status: "ready",
            interactionId: batch.interactionId,
            interactionVersion: batch.interactionVersion,
            mappingVersion: batch.mappingVersion,
            evidenceDigest: batch.evidenceDigest,
            batch
          });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadDateCompanionSubjectSuggestions({
      interactionId: "interaction_1",
      interactionVersion: 0,
      mappingVersion: 2,
      pollIntervalMs: 1,
      maxPolls: 3
    })).resolves.toEqual(batch);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("recovers a persisted batch by bounded GET polling when the one POST response is lost", async () => {
    let statusReads = 0;
    const fetchMock = vi.fn((_: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") return new Promise<Response>(() => undefined);
      statusReads += 1;
      if (statusReads === 1) {
        return Promise.resolve(Response.json({
          status: "idle",
          interactionId: batch.interactionId,
          interactionVersion: batch.interactionVersion,
          mappingVersion: batch.mappingVersion,
          evidenceDigest: batch.evidenceDigest
        }));
      }
      if (statusReads === 2) {
        return Promise.resolve(Response.json({
          status: "processing",
          interactionId: batch.interactionId,
          interactionVersion: batch.interactionVersion,
          mappingVersion: batch.mappingVersion,
          evidenceDigest: batch.evidenceDigest
        }));
      }
      return Promise.resolve(Response.json({
        status: "ready",
        interactionId: batch.interactionId,
        interactionVersion: batch.interactionVersion,
        mappingVersion: batch.mappingVersion,
        evidenceDigest: batch.evidenceDigest,
        batch
      }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadDateCompanionSubjectSuggestions({
      interactionId: "interaction_1",
      interactionVersion: 0,
      mappingVersion: 2,
      pollIntervalMs: 1,
      maxPolls: 3
    })).resolves.toEqual(batch);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "GET")).toHaveLength(3);
  });

  it("keeps reading the durable status after a gateway timeout and a temporary GET failure", async () => {
    let statusReads = 0;
    const fetchMock = vi.fn((_: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve(Response.json({ error: "gateway_timeout" }, { status: 504 }));
      }
      statusReads += 1;
      if (statusReads === 1) {
        return Promise.resolve(Response.json({
          status: "idle",
          interactionId: batch.interactionId,
          interactionVersion: batch.interactionVersion,
          mappingVersion: batch.mappingVersion,
          evidenceDigest: batch.evidenceDigest
        }));
      }
      if (statusReads === 2) {
        return Promise.resolve(Response.json({ error: "temporarily_unavailable" }, { status: 503 }));
      }
      return Promise.resolve(Response.json({
        status: "ready",
        interactionId: batch.interactionId,
        interactionVersion: batch.interactionVersion,
        mappingVersion: batch.mappingVersion,
        evidenceDigest: batch.evidenceDigest,
        batch
      }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadDateCompanionSubjectSuggestions({
      interactionId: "interaction_1",
      interactionVersion: 0,
      mappingVersion: 2,
      pollIntervalMs: 1,
      maxPolls: 3
    })).resolves.toEqual(batch);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "GET")).toHaveLength(3);
  });

  it("does not POST when another request is already generating the same fenced batch", async () => {
    let statusReads = 0;
    const fetchMock = vi.fn((_: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      statusReads += 1;
      return Promise.resolve(Response.json(statusReads === 1 ? {
        status: "processing",
        interactionId: batch.interactionId,
        interactionVersion: batch.interactionVersion,
        mappingVersion: batch.mappingVersion,
        evidenceDigest: batch.evidenceDigest
      } : {
        status: "ready",
        interactionId: batch.interactionId,
        interactionVersion: batch.interactionVersion,
        mappingVersion: batch.mappingVersion,
        evidenceDigest: batch.evidenceDigest,
        batch
      }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadDateCompanionSubjectSuggestions({
      interactionId: "interaction_1",
      interactionVersion: 0,
      mappingVersion: 2,
      pollIntervalMs: 1,
      maxPolls: 2
    })).resolves.toEqual(batch);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the current Evidence fence changes while polling", async () => {
    let statusReads = 0;
    vi.stubGlobal("fetch", vi.fn((_: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") return new Promise<Response>(() => undefined);
      statusReads += 1;
      return Promise.resolve(Response.json({
        status: statusReads === 1 ? "idle" : "processing",
        interactionId: batch.interactionId,
        interactionVersion: batch.interactionVersion,
        mappingVersion: batch.mappingVersion,
        evidenceDigest: (statusReads === 1 ? "a" : "f").repeat(64)
      }));
    }));

    await expect(loadDateCompanionSubjectSuggestions({
      interactionId: "interaction_1",
      interactionVersion: 0,
      mappingVersion: 2,
      pollIntervalMs: 1,
      maxPolls: 2
    })).rejects.toMatchObject({ status: 409, code: "subject_suggestion_status_stale" });
  });

  it("preserves a permanent status conflict instead of retrying it as a network failure", async () => {
    let statusReads = 0;
    const fetchMock = vi.fn((_: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") return new Promise<Response>(() => undefined);
      statusReads += 1;
      return statusReads === 1
        ? Promise.resolve(Response.json({
            status: "idle",
            interactionId: batch.interactionId,
            interactionVersion: batch.interactionVersion,
            mappingVersion: batch.mappingVersion,
            evidenceDigest: batch.evidenceDigest
          }))
        : Promise.resolve(Response.json(
            { error: "subject_suggestion_mapping_not_confirmed" },
            { status: 409 }
          ));
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadDateCompanionSubjectSuggestions({
      interactionId: "interaction_1",
      interactionVersion: 0,
      mappingVersion: 2,
      pollIntervalMs: 1,
      maxPolls: 3
    })).rejects.toMatchObject({
      status: 409,
      code: "subject_suggestion_mapping_not_confirmed"
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "GET")).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("submits the visible confirmation token with the exact Evidence selection set", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        mappingVersion: 2,
        subjectSuggestionConfirmation: {
          batchId: batch.batchId,
          evidenceDigest: batch.evidenceDigest,
          proposalDigest: batch.proposalDigest,
          confirmationFingerprint: batch.confirmationFingerprint,
          confirmedVisibleSuggestions: true
        },
        selections: [{ evidenceSnapshotId: "evidence_1", subject: "companion" }]
      });
      return Response.json({ bridge: { status: "pending" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await confirmDateCompanionSubjectSuggestions({
      interactionId: "interaction_1",
      mappingVersion: 2,
      confirmation: {
        batchId: batch.batchId,
        evidenceDigest: batch.evidenceDigest,
        proposalDigest: batch.proposalDigest,
        confirmationFingerprint: batch.confirmationFingerprint,
        confirmedVisibleSuggestions: true
      },
      selections: [{ evidenceSnapshotId: "evidence_1", subject: "companion" }]
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a safe server error code without parsing Provider response text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { error: "subject_suggestion_provider_unavailable" },
      { status: 503 }
    )));
    await expect(requestDateCompanionSubjectSuggestions("interaction_1"))
      .rejects.toEqual(expect.objectContaining({
        status: 503,
        code: "subject_suggestion_provider_unavailable"
      }));
  });
});
