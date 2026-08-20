// @vitest-environment node

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AudioUpload, TranscriptSegment } from "@/lib/domain/types";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import { createMemoryRepository } from "@/lib/server/memory/repository";
import { validatePersonTranscriptEvidence } from "./evidence";
import { createPersonMemoryRepository } from "./memory-repository";
import { createPersonRepository } from "./repository";

let database: Database.Database;

beforeEach(() => {
  database = openMemoryDatabase({ filePath: ":memory:" });
});

afterEach(() => {
  database.close();
});

async function transcriptEvidence(input: {
  accountId?: string;
  uploadId: string;
  segmentId: string;
  identityId: string;
  text: string;
}) {
  const accountId = input.accountId ?? "account_user";
  const segment: TranscriptSegment = {
    id: input.segmentId,
    uploadId: input.uploadId,
    startSeconds: 0,
    endSeconds: 5,
    speaker: input.identityId,
    identity: {
      globalSpeakerId: input.identityId,
      displayName: input.identityId,
      identityType: "known_contact",
      confidence: 0.97,
      source: "voiceprint"
    },
    text: input.text,
    confidence: 0.98,
    sceneLabels: ["private_content"],
    valueLabels: ["notable_quote"]
  };
  const upload: AudioUpload = {
    id: input.uploadId,
    originalName: `${input.uploadId}.wav`,
    mimeType: "audio/wav",
    sizeBytes: 1024,
    recordingDate: "2026-08-10",
    status: "ready"
  };
  return validatePersonTranscriptEvidence({
    store: {
      async read<T>(collection: string, id: string) {
        if (collection === "uploads" && id === input.uploadId) return upload as T;
        if (collection === "segments" && id === input.uploadId) return [segment] as T;
        return null;
      }
    },
    authenticatedAccountId: accountId,
    accountId,
    uploadId: input.uploadId,
    sourceSegmentId: input.segmentId,
    quote: input.text
  });
}

async function confirmedPerson(input: {
  displayName: string;
  identityId: string;
  uploadId: string;
  segmentId: string;
  text: string;
  accountId?: string;
  confirmSubject?: boolean;
}) {
  const accountId = input.accountId ?? "account_user";
  const evidence = await transcriptEvidence({ ...input, accountId });
  const repository = createPersonRepository(database);
  const candidate = repository.createCandidate({
    accountId,
    displayName: input.displayName,
    source: "transcript_candidate",
    evidence
  });
  repository.confirmPerson({ accountId, personId: candidate.id, evidence });
  const link = repository.createIdentityLinkCandidate({
    accountId,
    personId: candidate.id,
    identityId: input.identityId,
    source: "manual_confirmation",
    evidence
  });
  repository.confirmIdentityLink({ accountId, linkId: link.id, evidence });
  if (input.confirmSubject !== false) {
    repository.recordConfirmedSubject({
      accountId,
      personId: candidate.id,
      identityId: input.identityId,
      reason: "explicit test subject",
      evidence
    });
  }
  return { person: repository.getConfirmedPerson(accountId, candidate.id)!, evidence };
}

function writeMemory(input: {
  accountId?: string;
  id: string;
  uploadId: string;
  segmentId: string;
  type?: "event" | "preference" | "question";
  title: string;
  summary: string;
  quote: string;
  date?: string;
  status?: "active" | "resolved";
}) {
  const accountId = input.accountId ?? "account_user";
  const date = input.date ?? "2026-08-10";
  createMemoryRepository(database).replaceUploadMemories({
    userId: accountId,
    uploadId: input.uploadId,
    memories: [{
      id: input.id,
      type: input.type ?? "event",
      title: input.title,
      summary: input.summary,
      importance: 0.7,
      importanceScore: 0.7,
      status: input.status ?? "active",
      date,
      createdAt: `${date}T10:00:00.000Z`,
      updatedAt: `${date}T10:00:00.000Z`,
      evidence: [{
        id: `memory_evidence_${input.id}`,
        sourceType: "transcript",
        sourceId: input.segmentId,
        uploadId: input.uploadId,
        date,
        quote: input.quote,
        createdAt: `${date}T10:00:00.000Z`
      }]
    }]
  });
}

describe("Person-scoped Memory retrieval", () => {
  it("isolates two same-name people by personId and ignores names in Memory text", async () => {
    const aliceA = await confirmedPerson({
      displayName: "Alice",
      identityId: "identity_alice_a",
      uploadId: "upload_alice_a",
      segmentId: "segment_alice_a",
      text: "I finished the photo project."
    });
    const aliceB = await confirmedPerson({
      displayName: "Alice",
      identityId: "identity_alice_b",
      uploadId: "upload_alice_b",
      segmentId: "segment_alice_b",
      text: "I prefer quiet cafes."
    });
    const bob = await confirmedPerson({
      displayName: "Bob",
      identityId: "identity_bob",
      uploadId: "upload_bob",
      segmentId: "segment_bob",
      text: "I need to ask Alice about the budget."
    });
    writeMemory({
      id: "memory_alice_a",
      uploadId: aliceA.evidence.uploadId,
      segmentId: aliceA.evidence.sourceSegmentId,
      title: "Photo project",
      summary: "Finished the photo project.",
      quote: aliceA.evidence.quote
    });
    writeMemory({
      id: "memory_alice_b",
      uploadId: aliceB.evidence.uploadId,
      segmentId: aliceB.evidence.sourceSegmentId,
      type: "preference",
      title: "Quiet cafes",
      summary: "Prefers quiet cafes.",
      quote: aliceB.evidence.quote
    });
    writeMemory({
      id: "memory_bob_mentions_alice",
      uploadId: bob.evidence.uploadId,
      segmentId: bob.evidence.sourceSegmentId,
      type: "question",
      title: "Ask Alice",
      summary: "Bob needs to ask Alice about the budget.",
      quote: bob.evidence.quote
    });

    const repository = createPersonMemoryRepository(database);
    expect(repository.getPersonMemories({
      accountId: "account_user",
      personId: aliceA.person.id
    })?.memories.map((item) => item.memory.id)).toEqual(["memory_alice_a"]);
    expect(repository.getPersonMemories({
      accountId: "account_user",
      personId: aliceB.person.id
    })?.memories.map((item) => item.memory.id)).toEqual(["memory_alice_b"]);
    expect(repository.getPersonMemories({
      accountId: "account_user",
      personId: bob.person.id
    })?.memories.map((item) => item.memory.id)).toEqual(["memory_bob_mentions_alice"]);
  });

  it("fails closed for candidate, unknown Subject, archived Person, and cross-account IDs", async () => {
    const candidateEvidence = await transcriptEvidence({
      uploadId: "upload_candidate",
      segmentId: "segment_candidate",
      identityId: "identity_candidate",
      text: "I like tea."
    });
    const personRepository = createPersonRepository(database);
    const candidate = personRepository.createCandidate({
      accountId: "account_user",
      displayName: "Candidate",
      source: "transcript_candidate",
      evidence: candidateEvidence
    });
    const unknownPerson = await confirmedPerson({
      displayName: "Unknown Subject Person",
      identityId: "identity_unknown_subject",
      uploadId: "upload_unknown_subject",
      segmentId: "segment_unknown_subject",
      text: "I may travel.",
      confirmSubject: false
    });
    personRepository.recordUnknownSubject({
      accountId: "account_user",
      reason: "not enough evidence",
      evidence: unknownPerson.evidence
    });
    writeMemory({
      id: "memory_unknown_subject",
      uploadId: unknownPerson.evidence.uploadId,
      segmentId: unknownPerson.evidence.sourceSegmentId,
      title: "Possible travel",
      summary: "May travel.",
      quote: unknownPerson.evidence.quote
    });
    const archivedPerson = await confirmedPerson({
      displayName: "Archived",
      identityId: "identity_archived",
      uploadId: "upload_archived",
      segmentId: "segment_archived",
      text: "I archived this profile."
    });
    database.prepare(`
      UPDATE person_entities SET status = 'archived' WHERE id = ? AND account_id = ?
    `).run(archivedPerson.person.id, "account_user");

    const repository = createPersonMemoryRepository(database);
    expect(repository.getPersonMemories({ accountId: "account_user", personId: candidate.id })).toBeNull();
    expect(repository.getPersonMemories({
      accountId: "account_user",
      personId: unknownPerson.person.id
    })?.memories).toEqual([]);
    expect(repository.getPersonMemories({
      accountId: "account_user",
      personId: archivedPerson.person.id
    })).toBeNull();
    expect(repository.getPersonMemories({
      accountId: "another_account",
      personId: unknownPerson.person.id
    })).toBeNull();
  });

  it("marks explicitly multi-subject Evidence as shared for every scoped Person", async () => {
    const alice = await confirmedPerson({
      displayName: "Alice",
      identityId: "identity_shared_alice",
      uploadId: "upload_shared",
      segmentId: "segment_shared",
      text: "We agreed to meet on Friday."
    });
    const bob = await confirmedPerson({
      displayName: "Bob",
      identityId: "identity_shared_bob",
      uploadId: "upload_bob_profile",
      segmentId: "segment_bob_profile",
      text: "I am Bob."
    });
    database.prepare(`
      INSERT INTO person_subject_observations (
        id, account_id, person_id, evidence_id, status, source, reason,
        confirmed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'confirmed', 'manual_review', ?, ?, ?, ?)
    `).run(
      "subject_shared_bob",
      "account_user",
      bob.person.id,
      alice.evidence.id,
      "explicit shared evidence review",
      "2026-08-10T11:00:00.000Z",
      "2026-08-10T11:00:00.000Z",
      "2026-08-10T11:00:00.000Z"
    );
    writeMemory({
      id: "memory_shared",
      uploadId: alice.evidence.uploadId,
      segmentId: alice.evidence.sourceSegmentId,
      title: "Friday meeting",
      summary: "Alice and Bob agreed to meet Friday.",
      quote: alice.evidence.quote
    });

    const repository = createPersonMemoryRepository(database);
    const aliceMemory = repository.getPersonMemories({
      accountId: "account_user",
      personId: alice.person.id
    })!.memories[0];
    const bobMemory = repository.getPersonMemories({
      accountId: "account_user",
      personId: bob.person.id
    })!.memories[0];
    expect(aliceMemory.shared).toBe(true);
    expect(bobMemory.shared).toBe(true);
    expect(aliceMemory.subjectPersonIds).toEqual([alice.person.id, bob.person.id].sort());
    expect(bobMemory.subjectPersonIds).toEqual(aliceMemory.subjectPersonIds);
  });

  it("applies structured date, type, status, and limit filters without changing legacy retrieval", async () => {
    const person = await confirmedPerson({
      displayName: "Alice",
      identityId: "identity_filter",
      uploadId: "upload_filter",
      segmentId: "segment_filter",
      text: "I completed the plan."
    });
    writeMemory({
      id: "memory_filter",
      uploadId: person.evidence.uploadId,
      segmentId: person.evidence.sourceSegmentId,
      type: "event",
      status: "resolved",
      title: "Completed plan",
      summary: "The plan is complete.",
      quote: person.evidence.quote,
      date: "2026-08-09"
    });
    const legacyBefore = createMemoryRepository(database).getRelevantMemories({ userId: "account_user" });
    const repository = createPersonMemoryRepository(database);
    expect(repository.getPersonMemories({
      accountId: "account_user",
      personId: person.person.id,
      startDate: "2026-08-09",
      endDate: "2026-08-09",
      types: ["event"],
      statuses: [legacyBefore[0].status],
      limit: 1
    })?.memories).toHaveLength(1);
    expect(repository.getPersonMemories({
      accountId: "account_user",
      personId: person.person.id,
      statuses: [legacyBefore[0].status === "active" ? "resolved" : "active"]
    })?.memories).toEqual([]);
    expect(createMemoryRepository(database).getRelevantMemories({ userId: "account_user" }))
      .toEqual(legacyBefore);
  });

  it("invalidates the scoped read after upload deletion and preserves other uploads", async () => {
    const deletedPerson = await confirmedPerson({
      displayName: "Alice",
      identityId: "identity_delete",
      uploadId: "upload_delete",
      segmentId: "segment_delete",
      text: "I finished the deleted item."
    });
    const keptPerson = await confirmedPerson({
      displayName: "Bob",
      identityId: "identity_keep",
      uploadId: "upload_keep",
      segmentId: "segment_keep",
      text: "I finished the kept item."
    });
    writeMemory({
      id: "memory_delete",
      uploadId: deletedPerson.evidence.uploadId,
      segmentId: deletedPerson.evidence.sourceSegmentId,
      title: "Deleted item",
      summary: "Deleted item is complete.",
      quote: deletedPerson.evidence.quote
    });
    writeMemory({
      id: "memory_keep",
      uploadId: keptPerson.evidence.uploadId,
      segmentId: keptPerson.evidence.sourceSegmentId,
      type: "preference",
      title: "Kept item",
      summary: "Kept item remains.",
      quote: keptPerson.evidence.quote
    });
    const repository = createPersonMemoryRepository(database);
    expect(repository.getPersonMemories({
      accountId: "account_user",
      personId: deletedPerson.person.id
    })?.memories).toHaveLength(1);

    createMemoryRepository(database).deleteByUpload("account_user", "upload_delete");

    expect(repository.getPersonMemories({
      accountId: "account_user",
      personId: deletedPerson.person.id
    })).toBeNull();
    expect(repository.getPersonMemories({
      accountId: "account_user",
      personId: keptPerson.person.id
    })?.memories.map((item) => item.memory.id)).toEqual(["memory_keep"]);
  });
});
