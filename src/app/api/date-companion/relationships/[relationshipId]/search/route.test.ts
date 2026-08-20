import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  resolveCatalog: vi.fn(),
  searchPersonProjection: vi.fn()
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

vi.mock("@/lib/server/date-companion", () => ({
  getDateCompanionRepository: () => ({
    searchPersonProjection: state.searchPersonProjection
  })
}));

vi.mock("@/lib/server/date-companion/person-source-catalog", () => ({
  resolveProductionDateCompanionPersonSourceCatalog: state.resolveCatalog
}));

import { DcNotFoundError } from "@/lib/server/date-companion/errors";
import { GET } from "./route";

const readyCatalog = {
  relationshipId: "relationship_1",
  companionPersonId: "person_ta",
  mappingVersion: 3,
  status: "ready" as const,
  sources: [{
    evidenceSnapshotId: "snapshot_1",
    interactionId: "interaction_1",
    uploadId: "upload_1",
    sourceSegmentId: "segment_1",
    recordingDate: "2026-08-19",
    startSeconds: 1,
    endSeconds: 3,
    speakerId: "speaker_1",
    quote: "Ta 想周五去看展",
    subject: "companion" as const
  }]
};

function call(userId = "user_a", query = "看展") {
  return GET(new Request(
    `http://localhost/api/date-companion/relationships/relationship_1/search?q=${encodeURIComponent(query)}`,
    { headers: userId ? { "x-test-user": userId } : {} }
  ), { params: Promise.resolve({ relationshipId: "relationship_1" }) });
}

describe("GET Date Companion relationship search", () => {
  beforeEach(() => {
    state.resolveCatalog.mockReset().mockReturnValue(readyCatalog);
    state.searchPersonProjection.mockReset().mockReturnValue([{
      recapItemId: "recap_1",
      interactionId: "interaction_1",
      kind: "mentioned",
      text: "Ta 想周五去看展",
      recordingDate: "2026-08-19",
      evidence: [{
        id: "snapshot_1",
        recapItemId: "recap_1",
        uploadId: "upload_1",
        sourceSegmentId: "segment_1",
        startSeconds: 1,
        endSeconds: 3,
        speakerId: "speaker_1",
        quote: "Ta 想周五去看展",
        createdAt: "2026-08-19T00:00:00.000Z"
      }]
    }]);
  });

  it("uses only the admitted companion/both catalog as the search allowlist", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("pragma")).toBe("no-cache");
    await expect(response.json()).resolves.toMatchObject({
      results: [{
        recapItemId: "recap_1",
        evidence: [{ id: "snapshot_1" }]
      }]
    });
    expect(state.resolveCatalog).toHaveBeenCalledWith({
      accountId: "user_a",
      relationshipId: "relationship_1"
    });
    expect(state.searchPersonProjection).toHaveBeenCalledWith(
      "user_a",
      "relationship_1",
      "看展",
      ["snapshot_1"],
      { version: 3, companionPersonId: "person_ta" }
    );
  });

  it.each(["needs_review", "unavailable"] as const)(
    "fails closed when the source catalog is %s",
    async (status) => {
      state.resolveCatalog.mockReturnValue({
        ...readyCatalog,
        status,
        sources: []
      });
      const response = await call();
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
      await expect(response.json()).resolves.toEqual({ results: [] });
      expect(state.searchPersonProjection).not.toHaveBeenCalled();
    }
  );

  it("fails closed for an incomplete ready catalog", async () => {
    state.resolveCatalog.mockReturnValue({
      ...readyCatalog,
      companionPersonId: null,
      mappingVersion: null
    });
    const response = await call();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ results: [] });
    expect(state.searchPersonProjection).not.toHaveBeenCalled();
  });

  it("preserves authentication, validation, and cross-account 404 boundaries", async () => {
    const unauthenticated = await call("");
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    const invalid = await call("user_a", "");
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(state.resolveCatalog).not.toHaveBeenCalled();

    state.resolveCatalog.mockImplementation(() => {
      throw new DcNotFoundError("Relationship not found");
    });
    const crossAccount = await call("user_b");
    expect(crossAccount.status).toBe(404);
    expect(crossAccount.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    await expect(crossAccount.json()).resolves.toEqual({
      error: "date_companion_not_found"
    });
    expect(state.searchPersonProjection).not.toHaveBeenCalled();
  });
});
