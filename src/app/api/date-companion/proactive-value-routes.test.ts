import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  current: vi.fn(),
  relationship: vi.fn()
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

vi.mock("@/lib/server/date-companion/proactive-value", () => ({
  getDateCompanionProactiveValueService: () => ({
    getCurrentInteraction: state.current,
    getPersonRelationship: state.relationship
  })
}));

import { DcNotFoundError } from "@/lib/server/date-companion/errors";
import { GET as getCurrent } from "./interactions/[interactionId]/proactive-value/route";
import { GET as getRelationship } from "./relationships/[relationshipId]/proactive-value/route";

function response(scope: "current_interaction" | "person_relationship") {
  return {
    schemaVersion: 2,
    scope,
    relationshipId: "relationship_1",
    ...(scope === "current_interaction"
      ? { interactionId: "interaction_1" }
      : { personId: "person_companion" }),
    mappingVersion: 2,
    status: "ready",
    sourceFingerprint: "a".repeat(64),
    cacheHit: false,
    value: {
      observation: "这次有一件事值得继续留意。",
      suggestedQuestions: ["后来有新进展吗？"],
      reason: "来自已确认记录。",
      evidenceIds: ["evidence_1"],
      confidence: 0.7,
      caution: "这只是局部线索。"
    },
    evidenceReferences: [{
      evidenceId: "evidence_1",
      uploadId: "upload_1",
      sourceSegmentId: "segment_1",
      recordingDate: "2026-08-19",
      quote: "Ta 说周末想去看展。",
      contentDigest: "b".repeat(64),
      origin: "direct_conversation",
      subject: "companion"
    }]
  };
}

beforeEach(() => {
  state.current.mockReset().mockResolvedValue(response("current_interaction"));
  state.relationship.mockReset().mockResolvedValue(response("person_relationship"));
});

describe("Date Companion proactive value routes", () => {
  it("requires authentication and uses private no-store responses", async () => {
    const unauthenticated = await getCurrent(
      new Request("http://localhost/api/date-companion/interactions/interaction_1/proactive-value"),
      { params: Promise.resolve({ interactionId: "interaction_1" }) }
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("cache-control")).toContain("no-store");
    expect(state.current).not.toHaveBeenCalled();
  });

  it("scopes current and relationship reads only by authenticated account and path ID", async () => {
    const headers = { "x-test-user": "account_a" };
    const current = await getCurrent(
      new Request("http://localhost/api/date-companion/interactions/interaction_1/proactive-value", { headers }),
      { params: Promise.resolve({ interactionId: "interaction_1" }) }
    );
    const relationship = await getRelationship(
      new Request("http://localhost/api/date-companion/relationships/relationship_1/proactive-value", { headers }),
      { params: Promise.resolve({ relationshipId: "relationship_1" }) }
    );
    expect(state.current).toHaveBeenCalledWith({
      accountId: "account_a",
      interactionId: "interaction_1"
    });
    expect(state.relationship).toHaveBeenCalledWith({
      accountId: "account_a",
      relationshipId: "relationship_1"
    });
    expect(await current.json()).toMatchObject({ scope: "current_interaction", status: "ready" });
    expect(await relationship.json()).toMatchObject({ scope: "person_relationship", status: "ready" });
    expect(current.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(relationship.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  });

  it("returns the uniform 404 boundary for cross-account resources", async () => {
    state.relationship.mockRejectedValue(new DcNotFoundError("Relationship not found"));
    const result = await getRelationship(
      new Request("http://localhost/api/date-companion/relationships/relationship_1/proactive-value", {
        headers: { "x-test-user": "account_b" }
      }),
      { params: Promise.resolve({ relationshipId: "relationship_1" }) }
    );
    expect(result.status).toBe(404);
    expect(await result.json()).toEqual({ error: "date_companion_not_found" });
  });
});
