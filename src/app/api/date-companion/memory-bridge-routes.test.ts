import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";

const state = vi.hoisted(() => ({
  dateCompanionDatabase: null as unknown as Database.Database,
  memoryDatabase: null as unknown as Database.Database
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
  getDateCompanionDatabase: () => state.dateCompanionDatabase
}));

vi.mock("@/lib/server/memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/memory")>()),
  getMemoryDatabase: () => state.memoryDatabase
}));

import { openDateCompanionDatabase } from "@/lib/server/date-companion/db";
import { createDateCompanionMemoryBridgeRepository } from "@/lib/server/date-companion/memory-bridge-repository";
import { DateCompanionRepository } from "@/lib/server/date-companion/repository";
import { getOrCreateDateCompanionSubjectSuggestionBatch } from "@/lib/server/date-companion/subject-suggestions";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import { POST as syncMemory } from "./interactions/[interactionId]/memory-sync/route";
import { GET as getSettings, PUT as putSettings } from "./memory-settings/route";
import {
  GET as getMapping,
  PUT as putMapping
} from "./relationships/[relationshipId]/person-mapping/route";
import { GET as getMemoryReview } from "./relationships/[relationshipId]/memory-review/route";

describe("Date Companion Memory bridge APIs", () => {
  let relationshipId: string;

  beforeEach(() => {
    state.dateCompanionDatabase = openDateCompanionDatabase({ filePath: ":memory:" });
    state.memoryDatabase = openMemoryDatabase({ filePath: ":memory:" });
    relationshipId = new DateCompanionRepository(state.dateCompanionDatabase)
      .createOrGetRelationship("user_a", "Ta").relationship.id;
    const insert = state.memoryDatabase.prepare(`
      INSERT INTO person_entities (
        id, account_id, display_name, source, status, created_at, updated_at
      ) VALUES (?, 'user_a', ?, 'manual_confirmation', 'confirmed', ?, ?)
    `);
    const now = "2026-08-11T00:00:00.000Z";
    insert.run("person_self", "我", now, now);
    insert.run("person_ta", "Ta", now, now);
    state.memoryDatabase.prepare(`
      INSERT INTO person_self_bindings (
        account_id, person_id, status, version, set_at, cleared_at, created_at, updated_at
      ) VALUES ('user_a', 'person_self', 'active', 1, ?, NULL, ?, ?)
    `).run(now, now, now);
  });

  afterEach(() => {
    state.dateCompanionDatabase.close();
    state.memoryDatabase.close();
  });

  it("is authenticated, strict, versioned and private no-store", async () => {
    const unauthenticated = await getSettings(new Request(
      "http://localhost/api/date-companion/memory-settings"
    ));
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("cache-control")).toContain("no-store");

    const defaultSetting = await getSettings(new Request(
      "http://localhost/api/date-companion/memory-settings",
      { headers: { "x-test-user": "user_a" } }
    ));
    expect(defaultSetting.status).toBe(200);
    await expect(defaultSetting.json()).resolves.toMatchObject({
      setting: { enabled: true, version: 0, enabledAt: null }
    });

    const invalid = await putSettings(new Request(
      "http://localhost/api/date-companion/memory-settings",
      {
        method: "PUT",
        headers: { "content-type": "application/json", "x-test-user": "user_a" },
        body: JSON.stringify({ enabled: true, expectedVersion: 0, inferred: true })
      }
    ));
    expect(invalid.status).toBe(400);

    const enabled = await putSettings(new Request(
      "http://localhost/api/date-companion/memory-settings",
      {
        method: "PUT",
        headers: { "content-type": "application/json", "x-test-user": "user_a" },
        body: JSON.stringify({ enabled: true, expectedVersion: 0 })
      }
    ));
    expect(enabled.status).toBe(200);
    await expect(enabled.json()).resolves.toMatchObject({ setting: { enabled: true, version: 1 } });

    const stale = await putSettings(new Request(
      "http://localhost/api/date-companion/memory-settings",
      {
        method: "PUT",
        headers: { "content-type": "application/json", "x-test-user": "user_a" },
        body: JSON.stringify({ enabled: false, expectedVersion: 0 })
      }
    ));
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ error: "version_conflict", currentVersion: 1 });
  });

  it("persists an explicit opt-out from the enabled product default", async () => {
    const disabled = await putSettings(new Request(
      "http://localhost/api/date-companion/memory-settings",
      {
        method: "PUT",
        headers: { "content-type": "application/json", "x-test-user": "user_b" },
        body: JSON.stringify({ enabled: false, expectedVersion: 0 })
      }
    ));
    expect(disabled.status).toBe(200);
    await expect(disabled.json()).resolves.toMatchObject({
      setting: { enabled: false, version: 1 }
    });

    const persisted = await getSettings(new Request(
      "http://localhost/api/date-companion/memory-settings",
      { headers: { "x-test-user": "user_b" } }
    ));
    await expect(persisted.json()).resolves.toMatchObject({
      setting: { enabled: false, version: 1 }
    });
  });

  it("maps only stable same-account confirmed Person IDs and cross-user reads are 404", async () => {
    const call = (userId: string, body: unknown) => putMapping(new Request(
      `http://localhost/api/date-companion/relationships/${relationshipId}/person-mapping`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", "x-test-user": userId },
        body: JSON.stringify(body)
      }
    ), { params: Promise.resolve({ relationshipId }) });
    const mapped = await call("user_a", {
      selfPersonId: "person_self",
      companionPersonId: "person_ta",
      relationshipType: "dating",
      expectedVersion: 0
    });
    expect(mapped.status).toBe(200);
    await expect(mapped.json()).resolves.toMatchObject({
      mapping: {
        selfPersonId: "person_self",
        companionPersonId: "person_ta",
        relationshipType: "dating",
        status: "confirmed",
        version: 1
      }
    });

    const samePerson = await call("user_a", {
      selfPersonId: "person_self",
      companionPersonId: "person_self",
      relationshipType: "dating",
      expectedVersion: 1
    });
    expect(samePerson.status).toBe(409);

    const crossUser = await getMapping(new Request(
      `http://localhost/api/date-companion/relationships/${relationshipId}/person-mapping`,
      { headers: { "x-test-user": "user_b" } }
    ), { params: Promise.resolve({ relationshipId }) });
    expect(crossUser.status).toBe(404);

    const review = await getMemoryReview(new Request(
      `http://localhost/api/date-companion/relationships/${relationshipId}/memory-review`,
      { headers: { "x-test-user": "user_a" } }
    ), { params: Promise.resolve({ relationshipId }) });
    expect(review.status).toBe(200);
    const text = await review.text();
    expect(text).not.toContain("quote");
    expect(text).not.toContain("transcript");
  });

  it("queues memory sync for the Worker without consuming the outbox in Web", async () => {
    const repository = new DateCompanionRepository(state.dateCompanionDatabase);
    const imported = repository.importInteraction({
      userId: "user_a",
      relationshipId,
      sourceUploadId: "upload_memory_sync",
      recordingDate: "2026-08-11",
      originalName: "memory-sync.wav",
      participants: [{ speakerId: "speaker_1" }],
      recapCandidates: [{
        kind: "mentioned",
        proposedText: "A confirmed companion detail",
        sortOrder: 0,
        evidence: [{
          uploadId: "upload_memory_sync",
          sourceSegmentId: "segment_memory_sync",
          startSeconds: 0,
          endSeconds: 2,
          speakerId: "speaker_1",
          quote: "A confirmed companion detail"
        }]
      }]
    });
    const interaction = repository.getRelationshipView("user_a", relationshipId).interactions[0];
    const recapItem = interaction.recapItems[0];
    repository.updateRecap({
      userId: "user_a",
      interactionId: imported.interactionId,
      version: 0,
      assignments: [{ speakerId: "speaker_1", role: "companion" }],
      mutations: [{ id: recapItem.id, version: 0, disposition: "kept" }],
      finalize: true
    });

    const bridgeRepository = createDateCompanionMemoryBridgeRepository(
      state.dateCompanionDatabase
    );
    const mapping = bridgeRepository.putPersonMapping({
      userId: "user_a",
      relationshipId,
      selfPersonId: "person_self",
      companionPersonId: "person_ta",
      relationshipType: "dating",
      expectedVersion: 0
    });
    expect(repository.markUploadSourceState(
      "user_a",
      "upload_memory_sync",
      "server_cleaned"
    )).toBe(true);
    const suggestionBatch = await getOrCreateDateCompanionSubjectSuggestionBatch({
      database: state.dateCompanionDatabase,
      userId: "user_a",
      interactionId: imported.interactionId,
      provider: {
        model: "Qwen/Qwen3.6-27B",
        suggest: async (sources) => sources.map((source) => ({
          canonicalSourceKey: source.canonicalSourceKey,
          proposedSubject: "companion" as const,
          confidence: 0.96,
          reasonCode: "explicit_companion_reference" as const
        }))
      }
    });

    const response = await syncMemory(new Request(
      `http://localhost/api/date-companion/interactions/${imported.interactionId}/memory-sync`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": "user_a" },
        body: JSON.stringify({
          mappingVersion: mapping.version,
          subjectSuggestionConfirmation: {
            batchId: suggestionBatch.batchId,
            evidenceDigest: suggestionBatch.evidenceDigest,
            proposalDigest: suggestionBatch.proposalDigest,
            confirmationFingerprint: suggestionBatch.confirmationFingerprint,
            confirmedVisibleSuggestions: true
          },
          selections: [{
            evidenceSnapshotId: recapItem.evidence[0].id,
            subject: "companion"
          }]
        })
      }
    ), { params: Promise.resolve({ interactionId: imported.interactionId }) });

    expect(response.status).toBe(200);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload).toMatchObject({
      bridge: { status: "pending", attemptCount: 0 }
    });
    expect(payload).not.toHaveProperty("processed");
    expect(state.dateCompanionDatabase.prepare(`
      SELECT status, attempt_count, claim_token, lease_expires_at
      FROM dc_memory_bridge_outbox
      WHERE user_id = ? AND interaction_id = ?
    `).get("user_a", imported.interactionId)).toEqual({
      status: "pending",
      attempt_count: 0,
      claim_token: null,
      lease_expires_at: null
    });
    expect(state.memoryDatabase.prepare(`
      SELECT COUNT(*) AS count FROM dc_memory_bridge_receipts
    `).get()).toEqual({ count: 0 });

    const forgedFence = await syncMemory(new Request(
      `http://localhost/api/date-companion/interactions/${imported.interactionId}/memory-sync`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-user": "user_a" },
        body: JSON.stringify({
          mappingVersion: mapping.version,
          subjectSuggestionConfirmation: {
            batchId: suggestionBatch.batchId,
            evidenceDigest: suggestionBatch.evidenceDigest,
            proposalDigest: suggestionBatch.proposalDigest,
            confirmationFingerprint: suggestionBatch.confirmationFingerprint,
            confirmedVisibleSuggestions: true
          },
          selections: [{
            evidenceSnapshotId: recapItem.evidence[0].id,
            subject: "companion"
          }],
          relationshipReconfirmation: {
            action: "reconfirm_archived_relationship",
            idempotencyKey: "explicit-reconfirmation-key",
            epoch: 999,
            personRelationshipId: "forged-person-relationship"
          }
        })
      }
    ), { params: Promise.resolve({ interactionId: imported.interactionId }) });
    expect(forgedFence.status).toBe(400);
    await expect(forgedFence.json()).resolves.toEqual({ error: "invalid_memory_sync_request" });
  });
});
