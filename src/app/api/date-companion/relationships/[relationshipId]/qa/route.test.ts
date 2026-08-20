import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";

const state = vi.hoisted(() => ({ repository: null as unknown }));

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
  getDateCompanionRepository: () => state.repository
}));

import { openDateCompanionDatabase } from "@/lib/server/date-companion/db";
import { DateCompanionRepository } from "@/lib/server/date-companion/repository";
import { POST } from "./route";

describe("POST relationship QA", () => {
  let database: Database.Database;
  let repository: DateCompanionRepository;

  beforeEach(() => {
    database = openDateCompanionDatabase({ filePath: ":memory:" });
    repository = new DateCompanionRepository(database);
    state.repository = repository;
  });

  afterEach(() => database.close());

  async function call(relationshipId: string, userId?: string, body: unknown = { question: "Ta 说过什么？" }, stream = false) {
    return (await POST(new Request(
      `http://localhost/api/date-companion/relationships/${relationshipId}/qa`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(userId ? { "x-test-user": userId } : {}),
          ...(stream ? { accept: "application/x-ndjson" } : {})
        },
        body: JSON.stringify(body)
      }
    ), { params: Promise.resolve({ relationshipId }) }))!;
  }

  it("returns 401 without an authenticated user", async () => {
    const response = await call("relationship_1");
    expect(response.status).toBe(401);
  });

  it("returns the same 404 boundary for another user", async () => {
    const relationship = repository.createOrGetRelationship("user_a", "Ta").relationship;
    const response = await call(relationship.id, "user_b");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "date_companion_not_found" });
  });

  it("rejects client-supplied Evidence instead of accepting a fabricated allowlist", async () => {
    const relationship = repository.createOrGetRelationship("user_a", "Ta").relationship;
    const response = await call(relationship.id, "user_a", {
      question: "Ta 说过什么？",
      segments: [{ id: "fabricated", text: "伪造证据" }]
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_relationship_qa_request" });
  });

  it("returns a short canonical uncertainty answer without calling a Provider when Evidence is empty", async () => {
    const relationship = repository.createOrGetRelationship("user_a", "Ta").relationship;
    const response = await call(relationship.id, "user_a");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      uploadId: relationship.id,
      answer: "没有找到足够证据确认这个信息。",
      citedSegmentIds: [],
      citations: []
    });
  });

  it("keeps the canonical NDJSON meta/final/complete contract for an empty deterministic fixture", async () => {
    const relationship = repository.createOrGetRelationship("user_a", "Ta").relationship;
    const response = await call(relationship.id, "user_a", undefined, true);
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; [key: string]: unknown });

    expect(response.status).toBe(200);
    expect(events.map((event) => event.type)).toEqual(["meta", "final", "complete"]);
    expect(events[1]).toMatchObject({
      type: "final",
      answer: {
        uploadId: relationship.id,
        answer: "没有找到足够证据确认这个信息。",
        citedSegmentIds: [],
        citations: []
      }
    });
    expect(events[2]).toEqual({ type: "complete", status: "completed_with_fallback" });
  });
});
