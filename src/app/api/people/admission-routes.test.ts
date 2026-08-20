// @vitest-environment node

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import {
  createPersonAdmissionRepository
} from "@/lib/server/person";
import { LifecycleTranscriptStore } from "@/lib/server/person/lifecycle-test-fixtures";

const state = vi.hoisted(() => ({
  admissionRepository: null as unknown,
  store: null as unknown
}));

vi.mock("@/lib/server/auth/request-context", () => ({
  requireAuthContext: vi.fn(async (request: Request) => {
    const userId = request.headers.get("x-test-user");
    if (!userId) throw new Error("unauthenticated");
    return {
      user: { id: userId, email: `${userId}@example.test` },
      store: state.store,
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
  getPersonAdmissionRepository: () => state.admissionRepository
}));

import { POST as createPerson } from "./route";
import { PATCH as updatePerson } from "./[personId]/route";
import { GET as getSelf, PUT as putSelf } from "./self/route";
import { PUT as putSubject } from "./subjects/route";
import { POST as createRelationship } from "./relationships/route";
import { PATCH as updateRelationship } from "./relationships/[relationshipId]/route";

let database: Database.Database;
let store: LifecycleTranscriptStore;

beforeEach(() => {
  database = openMemoryDatabase({ filePath: ":memory:" });
  store = new LifecycleTranscriptStore();
  state.store = store;
  state.admissionRepository = createPersonAdmissionRepository(database);
});

afterEach(() => {
  database.close();
});

function request(url: string, body: unknown, userId = "account_user", method = "POST") {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-test-user": userId
    },
    body: JSON.stringify(body)
  });
}

async function createConfirmed(key: string, displayName: string) {
  const created = await createPerson(request("http://localhost/api/people", {
    idempotencyKey: key,
    displayName
  }));
  const candidate = (await created.json()).person as { id: string; version: number };
  const confirmed = await updatePerson(request(
    `http://localhost/api/people/${candidate.id}`,
    { action: "confirm", expectedVersion: candidate.version },
    "account_user",
    "PATCH"
  ), { params: Promise.resolve({ personId: candidate.id }) });
  return (await confirmed.json()).person as { id: string; version: number };
}

describe("Phase 4B admission write APIs", () => {
  it("strictly creates/confirms Persons and versions explicit self binding", async () => {
    expect((await createPerson(request("http://localhost/api/people", {
      idempotencyKey: "bad",
      displayName: "Alice",
      transcriptText: "client supplied text"
    }))).status).toBe(400);
    expect((await createPerson(new Request("http://localhost/api/people", {
      method: "POST",
      body: JSON.stringify({ idempotencyKey: "missing-auth" })
    }))).status).toBe(401);

    const created = await createPerson(request("http://localhost/api/people", {
      idempotencyKey: "alice",
      displayName: "Alice"
    }));
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("private, no-store");
    const candidate = (await created.json()).person as {
      id: string;
      status: string;
      version: number;
    };
    expect(candidate).toMatchObject({ status: "candidate", version: 1 });

    const confirmedResponse = await updatePerson(request(
      `http://localhost/api/people/${candidate.id}`,
      { action: "confirm", expectedVersion: 1 },
      "account_user",
      "PATCH"
    ), { params: Promise.resolve({ personId: candidate.id }) });
    expect(confirmedResponse.status).toBe(200);
    const confirmed = (await confirmedResponse.json()).person as { version: number };
    expect(confirmed.version).toBe(2);

    const crossAccount = await updatePerson(request(
      `http://localhost/api/people/${candidate.id}`,
      { action: "archive", expectedVersion: 2 },
      "account_other",
      "PATCH"
    ), { params: Promise.resolve({ personId: candidate.id }) });
    expect(crossAccount.status).toBe(404);
    await expect(crossAccount.json()).resolves.toEqual({ error: "person_not_found" });

    const self = await putSelf(request("http://localhost/api/people/self", {
      personId: candidate.id,
      expectedVersion: 0
    }, "account_user", "PUT"));
    expect(self.status).toBe(200);
    await expect(self.json()).resolves.toEqual({
      selfBinding: expect.objectContaining({ personId: candidate.id, status: "active", version: 1 })
    });
    const selfRead = await getSelf(new Request("http://localhost/api/people/self", {
      headers: { "x-test-user": "account_user" }
    }));
    expect(selfRead.headers.get("cache-control")).toBe("private, no-store");
    await expect(selfRead.json()).resolves.toEqual({
      selfBinding: expect.objectContaining({ personId: candidate.id, version: 1 })
    });
  });

  it("accepts only stable Evidence IDs for explicit Subject confirmation", async () => {
    const alice = await createConfirmed("subject-alice", "Alice");
    store.put({
      uploadId: "upload_subject",
      segmentId: "segment_subject",
      identityId: "speaker_1",
      text: "This canonical segment is explicitly about Alice."
    });

    const forged = await putSubject(request("http://localhost/api/people/subjects", {
      personId: alice.id,
      uploadId: "upload_subject",
      sourceSegmentId: "segment_subject",
      disposition: "confirmed",
      expectedVersion: 0,
      quote: "forged quote"
    }, "account_user", "PUT"));
    expect(forged.status).toBe(400);
    expect((database.prepare("SELECT COUNT(*) AS count FROM person_evidence").get() as { count: number }).count)
      .toBe(0);

    const missing = await putSubject(request("http://localhost/api/people/subjects", {
      personId: alice.id,
      uploadId: "upload_subject",
      sourceSegmentId: "segment_missing",
      disposition: "confirmed",
      expectedVersion: 0
    }, "account_user", "PUT"));
    expect(missing.status).toBe(404);

    const admitted = await putSubject(request("http://localhost/api/people/subjects", {
      personId: alice.id,
      uploadId: "upload_subject",
      sourceSegmentId: "segment_subject",
      disposition: "confirmed",
      expectedVersion: 0
    }, "account_user", "PUT"));
    expect(admitted.status).toBe(200);
    const admittedBody = await admitted.json() as {
      subjectAdmission: Record<string, unknown>;
    };
    expect(admittedBody.subjectAdmission).toEqual(expect.objectContaining({
      personId: alice.id,
      disposition: "confirmed",
      version: 1
    }));
    expect(admittedBody.subjectAdmission).not.toHaveProperty("quote");

    const stale = await putSubject(request("http://localhost/api/people/subjects", {
      personId: alice.id,
      uploadId: "upload_subject",
      sourceSegmentId: "segment_subject",
      disposition: "rejected",
      expectedVersion: 0
    }, "account_user", "PUT"));
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({ error: "version_conflict", currentVersion: 1 });

    store.put({
      uploadId: "upload_subject",
      segmentId: "segment_subject",
      identityId: "speaker_1",
      text: "The canonical source changed after the first admission."
    });
    const quoteConflict = await putSubject(request("http://localhost/api/people/subjects", {
      personId: alice.id,
      uploadId: "upload_subject",
      sourceSegmentId: "segment_subject",
      disposition: "confirmed",
      expectedVersion: 1
    }, "account_user", "PUT"));
    expect(quoteConflict.status).toBe(409);
    await expect(quoteConflict.json()).resolves.toEqual({ error: "conflict" });

    const crossAccount = await putSubject(request("http://localhost/api/people/subjects", {
      personId: alice.id,
      uploadId: "upload_subject",
      sourceSegmentId: "segment_subject",
      disposition: "confirmed",
      expectedVersion: 0
    }, "account_other", "PUT"));
    expect(crossAccount.status).toBe(404);
  });

  it("creates and explicitly confirms only Evidence-backed Relationships", async () => {
    const alice = await createConfirmed("relationship-alice", "Alice");
    const bob = await createConfirmed("relationship-bob", "Bob");
    store.put({
      uploadId: "upload_relationship",
      segmentId: "segment_relationship",
      identityId: "speaker_1",
      text: "The user explicitly selected a friendship relationship."
    });

    const forged = await createRelationship(request(
      "http://localhost/api/people/relationships",
      {
        personAId: alice.id,
        personBId: bob.id,
        type: "friend",
        expectedVersion: 0,
        uploadId: "upload_relationship",
        sourceSegmentId: "segment_relationship",
        quote: "client quote"
      }
    ));
    expect(forged.status).toBe(400);

    const created = await createRelationship(request(
      "http://localhost/api/people/relationships",
      {
        personAId: alice.id,
        personBId: bob.id,
        type: "friend",
        expectedVersion: 0,
        uploadId: "upload_relationship",
        sourceSegmentId: "segment_relationship"
      }
    ));
    expect(created.status).toBe(201);
    const candidate = (await created.json()).relationship as {
      id: string;
      status: string;
      version: number;
      evidenceReferences: unknown[];
    };
    expect(candidate).toMatchObject({ status: "candidate", version: 1 });
    expect(candidate.evidenceReferences).toEqual([
      expect.objectContaining({
        uploadId: "upload_relationship",
        sourceSegmentId: "segment_relationship"
      })
    ]);

    const confirmed = await updateRelationship(request(
      `http://localhost/api/people/relationships/${candidate.id}`,
      { action: "confirm", expectedVersion: 1 },
      "account_user",
      "PATCH"
    ), { params: Promise.resolve({ relationshipId: candidate.id }) });
    expect(confirmed.status).toBe(200);
    await expect(confirmed.json()).resolves.toEqual({
      relationship: expect.objectContaining({
        id: candidate.id,
        status: "confirmed",
        version: 2,
        explicitlyConfirmed: true
      })
    });

    const cannotOverwrite = await updateRelationship(request(
      `http://localhost/api/people/relationships/${candidate.id}`,
      { action: "conflict", expectedVersion: 2 },
      "account_user",
      "PATCH"
    ), { params: Promise.resolve({ relationshipId: candidate.id }) });
    expect(cannotOverwrite.status).toBe(409);

    const crossAccount = await updateRelationship(request(
      `http://localhost/api/people/relationships/${candidate.id}`,
      { action: "archive", expectedVersion: 2 },
      "account_other",
      "PATCH"
    ), { params: Promise.resolve({ relationshipId: candidate.id }) });
    expect(crossAccount.status).toBe(404);
  });
});
