import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";

const state = vi.hoisted(() => ({
  repository: null as unknown,
  store: null as unknown
}));

vi.mock("@/lib/server/auth/request-context", () => ({
  requireAuthContext: vi.fn(async (request: Request) => {
    const userId = request.headers.get("x-test-user");
    if (!userId) throw new Error("unauthenticated");
    return {
      user: { id: userId, email: `${userId}@example.com` },
      store: state.store,
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
import { JsonStore } from "@/lib/server/storage/json-store";
import { GET as listRelationships, POST as createRelationship } from "./relationships/route";
import { GET as getRelationshipView } from "./relationships/[relationshipId]/view/route";
import { POST as importInteraction } from "./relationships/[relationshipId]/interactions/import/route";
import { PUT as updateParticipants } from "./interactions/[interactionId]/participants/route";
import { PUT as updateRecap } from "./interactions/[interactionId]/recap/route";
import { PATCH as patchPromise } from "./promises/[promiseId]/route";
import { GET as searchRelationship } from "./relationships/[relationshipId]/search/route";
import { DELETE as deleteInteraction } from "./interactions/[interactionId]/route";

const roots: string[] = [];

describe("Date Companion API isolation", () => {
  let database: Database.Database;
  let repository: DateCompanionRepository;

  beforeEach(() => {
    database = openDateCompanionDatabase({ filePath: ":memory:" });
    repository = new DateCompanionRepository(database);
    state.repository = repository;
    state.store = {};
  });

  afterEach(async () => {
    database.close();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("requires authentication", async () => {
    const response = await listRelationships(new Request("http://localhost/api/date-companion/relationships"));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthenticated" });
  });

  it("creates one relationship and returns 404 for the same id under another user", async () => {
    const created = (await createRelationship(new Request(
      "http://localhost/api/date-companion/relationships",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": "user_a" },
        body: JSON.stringify({ displayName: "小满" })
      }
    )))!;
    expect(created.status).toBe(201);
    const payload = await created.json() as { relationship: { id: string } };

    const crossUser = await getRelationshipView(new Request(
      `http://localhost/api/date-companion/relationships/${payload.relationship.id}/view`,
      { headers: { "x-test-user": "user_b" } }
    ), {
      params: Promise.resolve({ relationshipId: payload.relationship.id })
    });
    expect(crossUser.status).toBe(404);
    await expect(crossUser.json()).resolves.toEqual({ error: "date_companion_not_found" });
  });

  it("maps invalid speaker and stale interaction versions to 422 and 409", async () => {
    const relationship = repository.createOrGetRelationship("user_a").relationship;
    const imported = repository.importInteraction({
      userId: "user_a",
      relationshipId: relationship.id,
      sourceUploadId: "upload_1",
      recordingDate: "2026-08-04",
      originalName: "fixture.wav",
      speakerIds: ["speaker_0"],
      recapCandidates: [{
        kind: "promise",
        proposedText: "我来跟进",
        sortOrder: 0,
        evidence: [{
          uploadId: "upload_1",
          sourceSegmentId: "segment_1",
          startSeconds: 0,
          endSeconds: 2,
          speakerId: "speaker_0",
          quote: "我来跟进"
        }]
      }]
    });
    const call = (version: number, speakerId: string) => updateParticipants(new Request(
      `http://localhost/api/date-companion/interactions/${imported.interactionId}/participants`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", "x-test-user": "user_a" },
        body: JSON.stringify({ version, assignments: [{ speakerId, role: "self" }] })
      }
    ), {
      params: Promise.resolve({ interactionId: imported.interactionId })
    });

    const invalid = (await call(0, "speaker_unknown"))!;
    expect(invalid.status).toBe(422);
    await expect(invalid.json()).resolves.toEqual({ error: "invalid_speaker_id" });
    expect((await call(0, "speaker_0"))!.status).toBe(200);
    const stale = (await call(0, "speaker_0"))!;
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ error: "version_conflict", currentVersion: 1 });
  });

  it("imports through the route from server DayPayload and accepts only uploadId", async () => {
    const root = await mkdtemp(join(tmpdir(), "date-companion-route-"));
    roots.push(root);
    const store = new JsonStore(root);
    state.store = store;
    await store.write("uploads", "upload_1", {
      id: "upload_1",
      originalName: "fixture.wav",
      mimeType: "audio/wav",
      sizeBytes: 128,
      recordingDate: "2026-08-04",
      status: "ready"
    });
    await store.write("jobs-by-upload", "upload_1", {
      id: "job_1",
      uploadId: "upload_1",
      status: "ready",
      progress: 100
    });
    await store.write("segments", "upload_1", [{
      id: "segment_1",
      uploadId: "upload_1",
      startSeconds: 0,
      endSeconds: 3,
      speaker: "speaker_0",
      text: "服务端真实原话",
      confidence: 0.9,
      sceneLabels: [],
      valueLabels: ["commitment"]
    }]);
    await store.write("audio-insights", "upload_1", []);
    await store.write("semantic-segments", "upload_1", []);
    await store.write("relationship-signals", "upload_1", []);
    await store.write("brief-items", "upload_1", [{
      id: "brief_1",
      uploadId: "upload_1",
      category: "commitment",
      title: "约定",
      body: "我会跟进",
      priority: "high",
      confidence: 0.9,
      status: "candidate",
      sourceSegmentIds: ["segment_1"],
      sourceTimeRange: { startSeconds: 0, endSeconds: 3 },
      transcriptExcerpt: "不能信任的客户端摘录",
      people: [],
      topics: []
    }]);
    const relationship = repository.createOrGetRelationship("user_a").relationship;
    const request = (body: unknown) => importInteraction(new Request(
      `http://localhost/api/date-companion/relationships/${relationship.id}/interactions/import`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": "user_a" },
        body: JSON.stringify(body)
      }
    ), { params: Promise.resolve({ relationshipId: relationship.id }) });

    const fabricated = (await request({ uploadId: "upload_1", evidence: [{ quote: "伪造" }] }))!;
    expect(fabricated.status).toBe(400);
    const first = (await request({ uploadId: "upload_1" }))!;
    expect(first.status).toBe(201);
    const firstPayload = await first.json() as {
      interactionId: string;
      reused: boolean;
      view: { interactions: Array<{ recapItems: Array<{ evidence: Array<{ quote: string }> }> }> };
    };
    expect(firstPayload.reused).toBe(false);
    expect(firstPayload.view.interactions[0].recapItems[0].evidence[0].quote).toBe("服务端真实原话");
    await store.delete("uploads", "upload_1");
    const repeated = (await request({ uploadId: "upload_1" }))!;
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toMatchObject({
      interactionId: firstPayload.interactionId,
      reused: true
    });
  });

  it("keeps recap, promise, search and delete routes authenticated, user-scoped and versioned", async () => {
    const relationship = repository.createOrGetRelationship("user_a").relationship;
    const imported = repository.importInteraction({
      userId: "user_a",
      relationshipId: relationship.id,
      sourceUploadId: "upload_routes",
      recordingDate: "2026-08-04",
      originalName: "routes.wav",
      speakerIds: ["speaker_0"],
      recapCandidates: [{
        kind: "promise",
        proposedText: "book the restaurant",
        sortOrder: 0,
        evidence: [{
          uploadId: "upload_routes",
          sourceSegmentId: "segment_routes",
          startSeconds: 0,
          endSeconds: 2,
          speakerId: "speaker_0",
          quote: "I will book the restaurant"
        }]
      }]
    });
    const interactionId = imported.interactionId;
    const recapItem = repository.getRelationshipView("user_a", relationship.id).interactions[0].recapItems[0];
    const recapRequest = (userId: string | null, body: unknown) => updateRecap(new Request(
      `http://localhost/api/date-companion/interactions/${interactionId}/recap`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          ...(userId ? { "x-test-user": userId } : {})
        },
        body: JSON.stringify(body)
      }
    ), { params: Promise.resolve({ interactionId }) });

    expect((await recapRequest(null, { version: 0, items: [], finalize: true }))!.status).toBe(401);
    expect((await recapRequest("user_b", { version: 0, items: [], finalize: true }))!.status).toBe(404);
    expect((await updateParticipants(new Request(
      `http://localhost/api/date-companion/interactions/${interactionId}/participants`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", "x-test-user": "user_a" },
        body: JSON.stringify({
          version: 0,
          assignments: [{ speakerId: "speaker_0", role: "self" }]
        })
      }
    ), { params: Promise.resolve({ interactionId }) }))!.status).toBe(200);

    const finalizeBody = {
      version: 1,
      items: [{ id: recapItem.id, version: 0, disposition: "kept" }],
      finalize: true
    };
    const finalized = (await recapRequest("user_a", finalizeBody))!;
    expect(finalized.status).toBe(200);
    const finalizedPayload = await finalized.json() as {
      view: { promises: Array<{ id: string; version: number; status: string }> };
    };
    expect(finalizedPayload.view.promises).toHaveLength(1);
    const promise = finalizedPayload.view.promises[0];

    const repeated = (await recapRequest("user_a", finalizeBody))!;
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toMatchObject({ view: { promises: [{ id: promise.id }] } });
    const mismatchedReplay = (await recapRequest(
      "user_a",
      { version: 1, items: [], finalize: true }
    ))!;
    expect(mismatchedReplay.status).toBe(409);
    await expect(mismatchedReplay.json()).resolves.toEqual({
      error: "confirmation_payload_conflict"
    });

    const promiseRequest = (userId: string, version: number) => patchPromise(new Request(
      `http://localhost/api/date-companion/promises/${promise.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-test-user": userId },
        body: JSON.stringify({ version, status: "done" })
      }
    ), { params: Promise.resolve({ promiseId: promise.id }) });
    expect((await promiseRequest("user_b", 0))!.status).toBe(404);
    expect((await promiseRequest("user_a", 0))!.status).toBe(200);
    const stalePromise = (await promiseRequest("user_a", 0))!;
    expect(stalePromise.status).toBe(409);
    await expect(stalePromise.json()).resolves.toMatchObject({ error: "version_conflict", currentVersion: 1 });

    const search = (userId: string) => searchRelationship(new Request(
      `http://localhost/api/date-companion/relationships/${relationship.id}/search?q=restaurant`,
      { headers: { "x-test-user": userId } }
    ), { params: Promise.resolve({ relationshipId: relationship.id }) });
    const ownerSearch = (await search("user_a"))!;
    expect(ownerSearch.status).toBe(200);
    await expect(ownerSearch.json()).resolves.toMatchObject({ results: [{ recapItemId: recapItem.id }] });
    expect((await search("user_b"))!.status).toBe(404);

    const remove = (userId: string, ifMatch?: string) => deleteInteraction(new Request(
      `http://localhost/api/date-companion/interactions/${interactionId}`,
      {
        method: "DELETE",
        headers: {
          "x-test-user": userId,
          ...(ifMatch ? { "if-match": ifMatch } : {})
        }
      }
    ), { params: Promise.resolve({ interactionId }) });
    const interactionVersion = repository.getRelationshipView(
      "user_a",
      relationship.id
    ).interactions[0].version;
    const missingVersion = (await remove("user_a"))!;
    expect(missingVersion.status).toBe(428);
    await expect(missingVersion.json()).resolves.toEqual({
      error: "interaction_version_required"
    });
    const invalidVersion = (await remove("user_a", "not-a-version"))!;
    expect(invalidVersion.status).toBe(400);
    await expect(invalidVersion.json()).resolves.toEqual({
      error: "invalid_interaction_version"
    });
    const staleDelete = (await remove("user_a", String(interactionVersion - 1)))!;
    expect(staleDelete.status).toBe(409);
    await expect(staleDelete.json()).resolves.toEqual({
      error: "version_conflict",
      currentVersion: interactionVersion
    });
    expect((await remove("user_b", `"${interactionVersion}"`))!.status).toBe(404);
    expect((await remove("user_a", `"${interactionVersion}"`))!.status).toBe(200);
    expect(repository.getRelationshipView("user_a", relationship.id).interactions).toEqual([]);
    expect(repository.getRelationshipView("user_a", relationship.id).promises).toEqual([]);
  });
});
