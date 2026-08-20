// @vitest-environment node

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import { createMemoryRepository } from "@/lib/server/memory/repository";
import {
  createPersonMemoryRepository,
  createPersonRelationshipRepository,
  createPersonRepository
} from "@/lib/server/person";

const state = vi.hoisted(() => ({
  personRepository: null as unknown,
  personMemoryRepository: null as unknown,
  personRelationshipRepository: null as unknown
}));

vi.mock("@/lib/server/auth/request-context", () => ({
  requireAuthContext: vi.fn(async (request: Request) => {
    const userId = request.headers.get("x-test-user");
    if (!userId) throw new Error("unauthenticated");
    return {
      user: { id: userId, email: `${userId}@example.test` },
      store: null,
      dataRootDir: ".data",
      uploadsRootDir: ".data/uploads"
    };
  }),
  isUnauthenticatedError: (error: unknown) =>
    error instanceof Error && error.message === "unauthenticated",
  unauthorizedResponse: () => Response.json({ error: "unauthenticated" }, { status: 401 })
}));

vi.mock("@/lib/server/person", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/person")>()),
  getPersonRepository: () => state.personRepository,
  getPersonMemoryRepository: () => state.personMemoryRepository,
  getPersonRelationshipRepository: () => state.personRelationshipRepository
}));

import { GET as listPeople } from "./route";
import { GET as getPerson } from "./[personId]/route";
import { GET as getPersonMemories } from "./[personId]/memories/route";
import { GET as getPersonTimeline } from "./[personId]/timeline/route";
import { GET as getPersonRelationships } from "./[personId]/relationships/route";

let database: Database.Database;

beforeEach(() => {
  database = openMemoryDatabase({ filePath: ":memory:" });
  state.personRepository = createPersonRepository(database);
  state.personMemoryRepository = createPersonMemoryRepository(database);
  state.personRelationshipRepository = createPersonRelationshipRepository(database);
});

afterEach(() => {
  database.close();
});

function seedConfirmedPerson(input: {
  id: string;
  accountId?: string;
  displayName?: string;
  uploadId: string;
  segmentId: string;
  quote: string;
}) {
  const accountId = input.accountId ?? "account_a";
  const now = "2026-08-10T00:00:00.000Z";
  const evidenceId = `person_evidence_${input.id}`;
  database.prepare(`
    INSERT INTO person_entities (
      id, account_id, display_name, source, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'manual_confirmation', 'confirmed', ?, ?)
  `).run(input.id, accountId, input.displayName ?? input.id, now, now);
  database.prepare(`
    INSERT INTO person_evidence (
      id, account_id, upload_id, source_segment_id, quote, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(evidenceId, accountId, input.uploadId, input.segmentId, input.quote, now, now);
  database.prepare(`
    INSERT INTO person_names (
      id, account_id, person_id, evidence_id, name, normalized_name,
      kind, status, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'display_name', 'confirmed', 'manual_confirmation', ?, ?)
  `).run(
    `person_name_${input.id}`,
    accountId,
    input.id,
    evidenceId,
    input.displayName ?? input.id,
    (input.displayName ?? input.id).toLocaleLowerCase("und"),
    now,
    now
  );
  database.prepare(`
    INSERT INTO person_subject_observations (
      id, account_id, person_id, evidence_id, status, source, reason,
      confirmed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'confirmed', 'manual_review', 'explicit API fixture', ?, ?, ?)
  `).run(`subject_${input.id}`, accountId, input.id, evidenceId, now, now, now);
  return { evidenceId, accountId };
}

function seedMemory(input: {
  id: string;
  accountId?: string;
  uploadId: string;
  segmentId: string;
  quote: string;
}) {
  const accountId = input.accountId ?? "account_a";
  createMemoryRepository(database).replaceUploadMemories({
    userId: accountId,
    uploadId: input.uploadId,
    memories: [{
      id: input.id,
      type: "event",
      title: input.id,
      summary: input.quote,
      importance: 0.7,
      date: "2026-08-10",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
      evidence: [{
        id: `memory_evidence_${input.id}`,
        sourceType: "transcript",
        sourceId: input.segmentId,
        uploadId: input.uploadId,
        date: "2026-08-10",
        quote: input.quote,
        createdAt: "2026-08-10T00:00:00.000Z"
      }]
    }]
  });
}

describe("People Relationship View API", () => {
  it("requires auth, lists only confirmed account-scoped People, and returns cross-account 404", async () => {
    seedConfirmedPerson({
      id: "person_alice_a",
      displayName: "Alice",
      uploadId: "upload_a",
      segmentId: "segment_a",
      quote: "Alice evidence."
    });
    seedConfirmedPerson({
      id: "person_alice_b",
      accountId: "account_b",
      displayName: "Alice",
      uploadId: "upload_b",
      segmentId: "segment_b",
      quote: "Other account Alice evidence."
    });
    database.prepare(`
      INSERT INTO person_entities (
        id, account_id, display_name, source, status, created_at, updated_at
      ) VALUES (
        'person_candidate', 'account_a', 'Candidate', 'transcript_candidate', 'candidate',
        '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
      )
    `).run();

    expect((await listPeople(new Request("http://localhost/api/people"))).status).toBe(401);
    const response = await listPeople(new Request("http://localhost/api/people", {
      headers: { "x-test-user": "account_a" }
    }));
    expect((await response.json()).people.map((person: { id: string }) => person.id))
      .toEqual(["person_alice_a"]);

    const crossAccount = await getPerson(new Request(
      "http://localhost/api/people/person_alice_b",
      { headers: { "x-test-user": "account_a" } }
    ), { params: Promise.resolve({ personId: "person_alice_b" }) });
    expect(crossAccount.status).toBe(404);
    await expect(crossAccount.json()).resolves.toEqual({ error: "person_not_found" });
  });

  it("returns only exact structured Subject Memories and a descending timeline", async () => {
    seedConfirmedPerson({
      id: "person_alice",
      displayName: "Alice",
      uploadId: "upload_alice",
      segmentId: "segment_alice",
      quote: "Alice completed the project."
    });
    seedMemory({
      id: "memory_alice",
      uploadId: "upload_alice",
      segmentId: "segment_alice",
      quote: "Alice completed the project."
    });
    seedConfirmedPerson({
      id: "person_bob",
      displayName: "Bob",
      uploadId: "upload_bob",
      segmentId: "segment_bob",
      quote: "Bob mentioned Alice in his own update."
    });
    seedMemory({
      id: "memory_bob_mentions_alice",
      uploadId: "upload_bob",
      segmentId: "segment_bob",
      quote: "Bob mentioned Alice in his own update."
    });

    const request = new Request(
      "http://localhost/api/people/person_alice/memories?type=event&status=active&limit=10",
      { headers: { "x-test-user": "account_a" } }
    );
    const response = await getPersonMemories(request, {
      params: Promise.resolve({ personId: "person_alice" })
    });
    expect(response.status).toBe(200);
    expect((await response.json()).memories.map((item: { memory: { id: string } }) => item.memory.id))
      .toEqual(["memory_alice"]);

    const timeline = await getPersonTimeline(new Request(
      "http://localhost/api/people/person_alice/timeline",
      { headers: { "x-test-user": "account_a" } }
    ), { params: Promise.resolve({ personId: "person_alice" }) });
    expect((await timeline.json()).timeline.map((item: { memory: { id: string } }) => item.memory.id))
      .toEqual(["memory_alice"]);

    const invalid = await getPersonMemories(new Request(
      "http://localhost/api/people/person_alice/memories?status=not-a-status",
      { headers: { "x-test-user": "account_a" } }
    ), { params: Promise.resolve({ personId: "person_alice" }) });
    expect(invalid.status).toBe(400);
  });

  it("returns only explicitly confirmed Evidence-backed Relationships", async () => {
    const alice = seedConfirmedPerson({
      id: "person_alice",
      displayName: "Alice",
      uploadId: "upload_alice",
      segmentId: "segment_alice",
      quote: "Alice relationship evidence."
    });
    seedConfirmedPerson({
      id: "person_bob",
      displayName: "Bob",
      uploadId: "upload_bob",
      segmentId: "segment_bob",
      quote: "Bob relationship evidence."
    });
    database.prepare(`
      INSERT INTO person_relationships (
        id, account_id, person_a_id, person_b_id, type, status,
        explicitly_confirmed, confirmed_at, created_at, updated_at
      ) VALUES (
        'relationship_confirmed', 'account_a', 'person_alice', 'person_bob', 'friend',
        'confirmed', 1, '2026-08-10T00:00:00.000Z',
        '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
      )
    `).run();
    database.prepare(`
      INSERT INTO person_relationship_evidence (
        id, account_id, relationship_id, evidence_id, created_at
      ) VALUES (
        'relationship_evidence_confirmed', 'account_a', 'relationship_confirmed', ?,
        '2026-08-10T00:00:00.000Z'
      )
    `).run(alice.evidenceId);
    database.prepare(`
      INSERT INTO person_relationships (
        id, account_id, person_a_id, person_b_id, type, status,
        explicitly_confirmed, confirmed_at, created_at, updated_at
      ) VALUES (
        'relationship_candidate', 'account_a', 'person_alice', 'person_bob', 'coworker',
        'candidate', 0, NULL,
        '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
      )
    `).run();

    const response = await getPersonRelationships(new Request(
      "http://localhost/api/people/person_alice/relationships",
      { headers: { "x-test-user": "account_a" } }
    ), { params: Promise.resolve({ personId: "person_alice" }) });
    expect(response.status).toBe(200);
    expect((await response.json()).relationships.map((item: { id: string }) => item.id))
      .toEqual(["relationship_confirmed"]);
  });
});
