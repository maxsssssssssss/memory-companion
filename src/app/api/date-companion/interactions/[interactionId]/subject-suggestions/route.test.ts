import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  resolve: vi.fn(),
  status: vi.fn()
}));

vi.mock("@/lib/server/auth/request-context", () => ({
  requireAuthContext: vi.fn(async (request: Request) => {
    const userId = request.headers.get("x-test-user");
    if (!userId) throw new Error("unauthenticated");
    return {
      user: { id: userId, email: `${userId}@example.com` },
      store: {},
      dataRootDir: ".data",
      uploadsRootDir: ".data/uploads"
    };
  }),
  isUnauthenticatedError: (error: unknown) =>
    error instanceof Error && error.message === "unauthenticated",
  unauthorizedResponse: () => Response.json({ error: "unauthenticated" }, { status: 401 })
}));

vi.mock("@/lib/server/date-companion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/date-companion")>()),
  getDateCompanionDatabase: () => ({ database: "fixture" }),
  getDateCompanionSubjectSuggestionBatchStatus: state.status,
  getOrCreateDateCompanionSubjectSuggestionBatch: state.resolve
}));

import { DcNotFoundError } from "@/lib/server/date-companion/errors";
import { GET, POST } from "./route";

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
    confidence: 0.96,
    reasonCode: "explicit_companion_reference"
  }],
  createdAt: "2026-08-18T08:00:00.000Z"
};

describe("Date Companion Subject suggestion route", () => {
  beforeEach(() => {
    state.resolve.mockReset();
    state.resolve.mockResolvedValue(batch);
    state.status.mockReset();
    state.status.mockReturnValue({
      status: "ready",
      interactionId: batch.interactionId,
      interactionVersion: batch.interactionVersion,
      mappingVersion: batch.mappingVersion,
      evidenceDigest: batch.evidenceDigest,
      batch
    });
  });

  it("requires authentication before any Provider-backed work", async () => {
    const response = await POST(new Request(
      "http://localhost/api/date-companion/interactions/interaction_1/subject-suggestions",
      { method: "POST" }
    ), { params: Promise.resolve({ interactionId: "interaction_1" }) });
    expect(response.status).toBe(401);
    expect(state.resolve).not.toHaveBeenCalled();
    const statusResponse = await GET(new Request(
      "http://localhost/api/date-companion/interactions/interaction_1/subject-suggestions",
      { method: "GET" }
    ), { params: Promise.resolve({ interactionId: "interaction_1" }) });
    expect(statusResponse.status).toBe(401);
    expect(state.status).not.toHaveBeenCalled();
  });

  it("reads the current persisted status without starting Provider-backed work", async () => {
    const response = await GET(new Request(
      "http://localhost/api/date-companion/interactions/interaction_1/subject-suggestions",
      { method: "GET", headers: { "x-test-user": "user_a" } }
    ), { params: Promise.resolve({ interactionId: "interaction_1" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(state.status).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_a",
      interactionId: "interaction_1"
    }));
    expect(state.resolve).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      status: "ready",
      interactionId: batch.interactionId,
      interactionVersion: batch.interactionVersion,
      mappingVersion: batch.mappingVersion,
      evidenceDigest: batch.evidenceDigest,
      batch
    });
  });

  it("passes only the authenticated account scope and returns private batch metadata", async () => {
    const response = await POST(new Request(
      "http://localhost/api/date-companion/interactions/interaction_1/subject-suggestions",
      { method: "POST", headers: { "x-test-user": "user_a" } }
    ), { params: Promise.resolve({ interactionId: "interaction_1" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(state.resolve).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_a",
      interactionId: "interaction_1"
    }));
    await expect(response.json()).resolves.toEqual({ batch });
  });

  it("fails a cross-account lookup closed as not found", async () => {
    state.resolve.mockRejectedValueOnce(new DcNotFoundError("Interaction not found"));
    const response = await POST(new Request(
      "http://localhost/api/date-companion/interactions/interaction_1/subject-suggestions",
      { method: "POST", headers: { "x-test-user": "user_b" } }
    ), { params: Promise.resolve({ interactionId: "interaction_1" }) });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "date_companion_not_found" });
  });
});
