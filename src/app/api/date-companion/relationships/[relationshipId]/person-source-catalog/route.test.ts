import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  resolve: vi.fn()
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

vi.mock("@/lib/server/date-companion/person-source-catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/date-companion/person-source-catalog")>()),
  resolveProductionDateCompanionPersonSourceCatalog: state.resolve
}));

import { DcNotFoundError } from "@/lib/server/date-companion/errors";
import { GET } from "./route";

describe("GET relationship Person source catalog", () => {
  beforeEach(() => {
    state.resolve.mockReset().mockReturnValue({
      relationshipId: "relationship_1",
      companionPersonId: "person_ta",
      mappingVersion: 3,
      status: "ready",
      sources: [{
        evidenceSnapshotId: "snapshot_1",
        interactionId: "interaction_1",
        uploadId: "upload_1",
        sourceSegmentId: "segment_1",
        recordingDate: "2026-08-11",
        startSeconds: 1,
        endSeconds: 4,
        speakerId: "speaker_1",
        quote: "Ta 喜欢摄影",
        subject: "companion"
      }]
    });
  });

  function call(relationshipId: string, userId?: string) {
    return GET(new Request(
      `http://localhost/api/date-companion/relationships/${relationshipId}/person-source-catalog`,
      { headers: userId ? { "x-test-user": userId } : {} }
    ), { params: Promise.resolve({ relationshipId }) });
  }

  it("requires authentication and keeps every response private no-store", async () => {
    const response = await call("relationship_1");
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(state.resolve).not.toHaveBeenCalled();
  });

  it("accepts only the path relationship ID and returns the restricted DTO", async () => {
    const response = await call("relationship_1", "user_a");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(state.resolve).toHaveBeenCalledWith({
      accountId: "user_a",
      relationshipId: "relationship_1"
    });
    const body = await response.json();
    expect(body).toMatchObject({
      relationshipId: "relationship_1",
      companionPersonId: "person_ta",
      mappingVersion: 3,
      status: "ready",
      sources: [{
        evidenceSnapshotId: "snapshot_1",
        uploadId: "upload_1",
        sourceSegmentId: "segment_1",
        quote: "Ta 喜欢摄影",
        subject: "companion"
      }]
    });
    expect(JSON.stringify(body)).not.toMatch(/digest|receipt|outbox/iu);
  });

  it("returns 400 for invalid IDs and the same 404 boundary for cross-account resources", async () => {
    const invalid = await call("not valid", "user_a");
    expect(invalid.status).toBe(400);
    expect(state.resolve).not.toHaveBeenCalled();

    state.resolve.mockImplementation(() => {
      throw new DcNotFoundError("Relationship not found");
    });
    const crossAccount = await call("relationship_1", "user_b");
    expect(crossAccount.status).toBe(404);
    expect(crossAccount.headers.get("cache-control")).toContain("no-store");
    await expect(crossAccount.json()).resolves.toEqual({
      error: "date_companion_not_found"
    });
  });
});
