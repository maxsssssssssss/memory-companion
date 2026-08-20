// @vitest-environment node

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import { createMemoryRepository } from "@/lib/server/memory/repository";
import { createPersonAdmissionRepository, PersonAdmissionError } from "./admission-repository";
import { createPersonMemoryRepository } from "./memory-repository";
import { createPersonRelationshipRepository } from "./relationship-repository";
import { createPersonRepository } from "./repository";
import {
  LifecycleTranscriptStore,
  validatedLifecycleEvidence
} from "./lifecycle-test-fixtures";

let database: Database.Database;
let store: LifecycleTranscriptStore;

beforeEach(() => {
  database = openMemoryDatabase({ filePath: ":memory:" });
  store = new LifecycleTranscriptStore();
});

afterEach(() => {
  database.close();
});

function count(table: string) {
  return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function createConfirmedPerson(input: {
  accountId?: string;
  key: string;
  displayName?: string | null;
}) {
  const accountId = input.accountId ?? "account_user";
  const repository = createPersonAdmissionRepository(database);
  const candidate = repository.createPersonCandidate({
    accountId,
    idempotencyKey: input.key,
    displayName: input.displayName
  });
  return repository.confirmPerson({
    accountId,
    personId: candidate.id,
    expectedVersion: candidate.version
  });
}

async function evidence(input: {
  accountId?: string;
  uploadId: string;
  segmentId: string;
  text: string;
}) {
  return validatedLifecycleEvidence({
    store,
    accountId: input.accountId,
    uploadId: input.uploadId,
    segmentId: input.segmentId,
    identityId: "speaker_1",
    text: input.text
  });
}

function seedMemory(input: {
  accountId?: string;
  uploadId: string;
  segmentId: string;
  text: string;
  memoryId: string;
  title?: string;
}) {
  const accountId = input.accountId ?? "account_user";
  createMemoryRepository(database).replaceUploadMemories({
    userId: accountId,
    uploadId: input.uploadId,
    sourceSegments: [{
      id: input.segmentId,
      uploadId: input.uploadId,
      startSeconds: 0,
      endSeconds: 5,
      speaker: "speaker_1",
      text: input.text,
      confidence: 0.98,
      sceneLabels: ["private_content"],
      valueLabels: ["notable_quote"]
    }],
    memories: [{
      id: input.memoryId,
      type: "event",
      title: input.title ?? "Explicit Person event",
      summary: input.text,
      importance: 0.72,
      date: "2026-08-10",
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
      evidence: [{
        id: `memory_evidence_${input.memoryId}`,
        sourceType: "transcript",
        sourceId: input.segmentId,
        uploadId: input.uploadId,
        date: "2026-08-10",
        quote: input.text,
        createdAt: "2026-08-10T00:00:00.000Z"
      }]
    }]
  });
}

describe("Phase 4B explicit Person and self admission", () => {
  it("keeps same-name and cross-account Persons isolated and versions explicit self changes", () => {
    const repository = createPersonAdmissionRepository(database);
    const aliceA = repository.createPersonCandidate({
      accountId: "account_user",
      idempotencyKey: "alice-a",
      displayName: "Alice"
    });
    const aliceB = repository.createPersonCandidate({
      accountId: "account_user",
      idempotencyKey: "alice-b",
      displayName: "Alice"
    });
    const unnamed = repository.createPersonCandidate({
      accountId: "account_user",
      idempotencyKey: "unnamed"
    });
    const otherAlice = repository.createPersonCandidate({
      accountId: "account_other",
      idempotencyKey: "alice-a",
      displayName: "Alice"
    });

    expect(aliceA.id).not.toBe(aliceB.id);
    expect(aliceA.id).not.toBe(otherAlice.id);
    expect(unnamed.displayName).toBeNull();
    expect(repository.createPersonCandidate({
      accountId: "account_user",
      idempotencyKey: "alice-a",
      displayName: "Alice"
    })).toEqual(aliceA);
    expect(() => repository.createPersonCandidate({
      accountId: "account_user",
      idempotencyKey: "alice-a",
      displayName: "Alice Zhang"
    })).toThrow(PersonAdmissionError);
    expect(() => repository.confirmPerson({
      accountId: "account_other",
      personId: aliceA.id,
      expectedVersion: 1
    })).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => repository.setSelfBinding({
      accountId: "account_user",
      personId: aliceA.id,
      expectedVersion: 0
    })).toThrow(expect.objectContaining({ code: "not_found" }));

    const confirmedA = repository.confirmPerson({
      accountId: "account_user",
      personId: aliceA.id,
      expectedVersion: 1
    });
    const confirmedB = repository.confirmPerson({
      accountId: "account_user",
      personId: aliceB.id,
      expectedVersion: 1
    });
    expect(confirmedA).toMatchObject({
      status: "confirmed",
      version: 2,
      explicitlyConfirmed: true
    });
    expect(repository.confirmPerson({
      accountId: "account_user",
      personId: aliceA.id,
      expectedVersion: 1
    })).toEqual(confirmedA);
    expect(() => repository.renamePerson({
      accountId: "account_user",
      personId: confirmedA.id,
      displayName: "Alice Zhang",
      expectedVersion: 1
    })).toThrow(expect.objectContaining({ code: "version_conflict", currentVersion: 2 }));
    const renamedA = repository.renamePerson({
      accountId: "account_user",
      personId: confirmedA.id,
      displayName: "Alice Zhang",
      expectedVersion: 2
    });
    expect(renamedA).toMatchObject({ displayName: "Alice Zhang", version: 3 });
    expect(repository.renamePerson({
      accountId: "account_user",
      personId: confirmedA.id,
      displayName: "Alice Zhang",
      expectedVersion: 0
    })).toEqual(renamedA);

    const firstBinding = repository.setSelfBinding({
      accountId: "account_user",
      personId: confirmedA.id,
      expectedVersion: 0
    });
    expect(firstBinding).toMatchObject({ personId: confirmedA.id, status: "active", version: 1 });
    expect(repository.setSelfBinding({
      accountId: "account_user",
      personId: confirmedA.id,
      expectedVersion: 99
    })).toEqual(firstBinding);
    const replacement = repository.setSelfBinding({
      accountId: "account_user",
      personId: confirmedB.id,
      expectedVersion: 1
    });
    expect(replacement).toMatchObject({ personId: confirmedB.id, version: 2 });
    expect(() => repository.setSelfBinding({
      accountId: "account_user",
      personId: null,
      expectedVersion: 1
    })).toThrow(expect.objectContaining({ code: "version_conflict", currentVersion: 2 }));
    const cleared = repository.setSelfBinding({
      accountId: "account_user",
      personId: null,
      expectedVersion: 2
    });
    expect(cleared).toMatchObject({ personId: null, status: "cleared", version: 3 });
    expect(repository.setSelfBinding({
      accountId: "account_user",
      personId: null,
      expectedVersion: 0
    })).toEqual(cleared);

    const archived = repository.archivePerson({
      accountId: "account_user",
      personId: confirmedB.id,
      expectedVersion: 2
    });
    expect(archived).toMatchObject({ status: "archived", version: 3 });
    expect(() => repository.setSelfBinding({
      accountId: "account_user",
      personId: confirmedB.id,
      expectedVersion: 3
    })).toThrow(expect.objectContaining({ code: "not_found" }));

    expect(count("memory_items")).toBe(0);
    expect(count("person_names")).toBe(0);
    expect(count("person_identity_links")).toBe(0);
    expect(count("person_facts")).toBe(0);
    expect(count("person_commitments")).toBe(0);
    expect(repository.listAudits("account_user").map((audit) => audit.action)).toEqual(
      expect.arrayContaining([
        "person_created",
        "person_confirmed",
        "self_set",
        "self_replaced",
        "self_cleared",
        "person_archived"
      ])
    );
  });
});

describe("Phase 4B explicit Subject admission", () => {
  it("admits only explicit confirmed subjects, supports explicit sharing, and cleans by upload", async () => {
    const repository = createPersonAdmissionRepository(database);
    const personRepository = createPersonRepository(database);
    const personMemoryRepository = createPersonMemoryRepository(database);
    const alice = createConfirmedPerson({ key: "alice", displayName: "Alice" });
    const bob = createConfirmedPerson({ key: "bob", displayName: "Bob" });
    const candidate = repository.createPersonCandidate({
      accountId: "account_user",
      idempotencyKey: "candidate",
      displayName: "Candidate"
    });
    const sharedEvidence = await evidence({
      uploadId: "upload_shared",
      segmentId: "segment_shared",
      text: "We both visited the museum."
    });
    seedMemory({
      uploadId: sharedEvidence.uploadId,
      segmentId: sharedEvidence.sourceSegmentId,
      text: sharedEvidence.quote,
      memoryId: "memory_shared"
    });

    const aliceAdmission = repository.recordSubjectAdmission({
      accountId: "account_user",
      personId: alice.id,
      disposition: "confirmed",
      expectedVersion: 0,
      evidence: sharedEvidence
    });
    expect(aliceAdmission).toMatchObject({ personId: alice.id, disposition: "confirmed", version: 1 });
    expect(repository.recordSubjectAdmission({
      accountId: "account_user",
      personId: alice.id,
      disposition: "confirmed",
      expectedVersion: 999,
      evidence: sharedEvidence
    })).toEqual(aliceAdmission);
    expect(() => repository.recordSubjectAdmission({
      accountId: "account_user",
      personId: alice.id,
      disposition: "rejected",
      expectedVersion: 0,
      evidence: sharedEvidence
    })).toThrow(expect.objectContaining({ code: "version_conflict", currentVersion: 1 }));
    expect(() => repository.recordSubjectAdmission({
      accountId: "account_user",
      personId: candidate.id,
      disposition: "confirmed",
      expectedVersion: 0,
      evidence: sharedEvidence
    })).toThrow(expect.objectContaining({ code: "not_found" }));

    const aliceOnly = personMemoryRepository.getPersonMemories({
      accountId: "account_user",
      personId: alice.id
    });
    expect(aliceOnly?.memories).toEqual([
      expect.objectContaining({ shared: false, subjectPersonIds: [alice.id] })
    ]);
    expect(sharedEvidence.segment.speaker).toBe("speaker_1");
    expect(aliceOnly?.memories[0]?.memory.userId).toBe("account_user");
    expect(aliceOnly?.person.id).toBe(alice.id);

    repository.recordSubjectAdmission({
      accountId: "account_user",
      personId: bob.id,
      disposition: "confirmed",
      expectedVersion: 0,
      evidence: sharedEvidence
    });
    expect(personMemoryRepository.getPersonMemories({
      accountId: "account_user",
      personId: alice.id
    })?.memories[0]).toMatchObject({
      shared: true,
      subjectPersonIds: [alice.id, bob.id].sort()
    });
    expect(personMemoryRepository.getPersonTimeline({
      accountId: "account_user",
      personId: alice.id
    })?.timeline).toHaveLength(1);

    const bobEvidence = await evidence({
      uploadId: "upload_bob",
      segmentId: "segment_bob",
      text: "The summary mentions Alice, but this Evidence is about Bob."
    });
    seedMemory({
      uploadId: bobEvidence.uploadId,
      segmentId: bobEvidence.sourceSegmentId,
      text: bobEvidence.quote,
      memoryId: "memory_bob",
      title: "Alice appears only in text"
    });
    repository.recordSubjectAdmission({
      accountId: "account_user",
      personId: bob.id,
      disposition: "confirmed",
      expectedVersion: 0,
      evidence: bobEvidence
    });
    expect(personMemoryRepository.getPersonMemories({
      accountId: "account_user",
      personId: alice.id
    })?.memories.map((item) => item.memory.id)).toEqual(["memory_shared"]);

    const unknownEvidence = await evidence({
      uploadId: "upload_unknown",
      segmentId: "segment_unknown",
      text: "The subject cannot be determined."
    });
    const unknown = repository.recordSubjectAdmission({
      accountId: "account_user",
      personId: null,
      disposition: "unknown",
      expectedVersion: 0,
      evidence: unknownEvidence
    });
    expect(unknown).toMatchObject({ personId: null, disposition: "unknown" });
    const correctedUnknown = repository.recordSubjectAdmission({
      accountId: "account_user",
      personId: alice.id,
      disposition: "confirmed",
      expectedVersion: 0,
      evidence: unknownEvidence
    });
    expect(correctedUnknown).toMatchObject({ personId: alice.id, disposition: "confirmed" });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM person_subject_observations
      WHERE account_id = 'account_user' AND evidence_id = ? AND status = 'unknown'
    `).get(unknownEvidence.id)).toEqual({ count: 0 });

    const deletion = personRepository.deleteByUpload("account_user", "upload_shared");
    expect(deletion.deletedSubjectObservationCount).toBe(2);
    expect(count("person_subject_admissions")).toBe(2);
    expect(personRepository.getConfirmedPerson("account_user", alice.id)?.id).toBe(alice.id);
    expect(personRepository.getConfirmedPerson("account_user", bob.id)?.id).toBe(bob.id);
    expect(personMemoryRepository.getPersonMemories({
      accountId: "account_user",
      personId: alice.id
    })?.memories).toEqual([]);
    expect(personMemoryRepository.getPersonMemories({
      accountId: "account_user",
      personId: bob.id
    })?.memories.map((item) => item.memory.id)).toEqual(["memory_bob"]);
    expect(count("person_facts")).toBe(0);
    expect(count("person_commitments")).toBe(0);
  });
});

describe("Phase 4B explicit Relationship admission", () => {
  it("requires confirmed endpoints and Evidence, versions transitions, and preserves remaining support", async () => {
    const repository = createPersonAdmissionRepository(database);
    const relationshipRepository = createPersonRelationshipRepository(database);
    const personRepository = createPersonRepository(database);
    const alice = createConfirmedPerson({ key: "relationship-alice", displayName: "Alice" });
    const bob = createConfirmedPerson({ key: "relationship-bob", displayName: "Bob" });
    const candidatePerson = repository.createPersonCandidate({
      accountId: "account_user",
      idempotencyKey: "relationship-candidate",
      displayName: "Candidate"
    });
    const sourceA = await evidence({
      uploadId: "upload_relationship_a",
      segmentId: "segment_relationship_a",
      text: "The friendship was explicitly reviewed."
    });
    const sourceB = await evidence({
      uploadId: "upload_relationship_b",
      segmentId: "segment_relationship_b",
      text: "A second Transcript segment supports the friendship."
    });

    expect(() => repository.createRelationshipCandidate({
      accountId: "account_user",
      personAId: alice.id,
      personBId: candidatePerson.id,
      type: "friend",
      expectedVersion: 0,
      evidence: sourceA
    })).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => repository.createRelationshipCandidate({
      accountId: "account_user",
      personAId: alice.id,
      personBId: alice.id,
      type: "friend",
      expectedVersion: 0,
      evidence: sourceA
    })).toThrow(expect.objectContaining({ code: "invalid_request" }));
    expect(() => repository.createRelationshipCandidate({
      accountId: "account_other",
      personAId: alice.id,
      personBId: bob.id,
      type: "friend",
      expectedVersion: 0,
      evidence: sourceA
    })).toThrow(expect.objectContaining({ code: "not_found" }));

    const candidate = repository.createRelationshipCandidate({
      accountId: "account_user",
      personAId: alice.id,
      personBId: bob.id,
      type: "friend",
      expectedVersion: 0,
      evidence: sourceA
    });
    expect(candidate).toMatchObject({ status: "candidate", version: 1, explicitlyConfirmed: false });
    expect(repository.createRelationshipCandidate({
      accountId: "account_user",
      personAId: bob.id,
      personBId: alice.id,
      type: "friend",
      expectedVersion: 99,
      evidence: sourceA
    })).toEqual(candidate);
    expect(() => repository.createRelationshipCandidate({
      accountId: "account_user",
      personAId: alice.id,
      personBId: bob.id,
      type: "friend",
      expectedVersion: 0,
      evidence: sourceB
    })).toThrow(expect.objectContaining({ code: "version_conflict", currentVersion: 1 }));
    const twoSources = repository.createRelationshipCandidate({
      accountId: "account_user",
      personAId: alice.id,
      personBId: bob.id,
      type: "friend",
      expectedVersion: 1,
      evidence: sourceB
    });
    expect(twoSources).toMatchObject({ version: 2 });
    expect(twoSources.evidence).toHaveLength(2);
    expect(() => repository.transitionRelationship({
      accountId: "account_user",
      relationshipId: candidate.id,
      action: "confirm",
      expectedVersion: 1
    })).toThrow(expect.objectContaining({ code: "version_conflict", currentVersion: 2 }));
    const confirmed = repository.transitionRelationship({
      accountId: "account_user",
      relationshipId: candidate.id,
      action: "confirm",
      expectedVersion: 2
    });
    expect(confirmed).toMatchObject({ status: "confirmed", version: 3, explicitlyConfirmed: true });
    expect(repository.transitionRelationship({
      accountId: "account_user",
      relationshipId: candidate.id,
      action: "confirm",
      expectedVersion: 1
    })).toEqual(confirmed);
    expect(() => repository.transitionRelationship({
      accountId: "account_user",
      relationshipId: candidate.id,
      action: "conflict",
      expectedVersion: 3
    })).toThrow(expect.objectContaining({ code: "invalid_state" }));

    personRepository.deleteByUpload("account_user", sourceA.uploadId);
    expect(relationshipRepository.getForReview("account_user", candidate.id)).toMatchObject({
      status: "confirmed",
      version: 3,
      evidence: [expect.objectContaining({ uploadId: sourceB.uploadId })]
    });
    personRepository.deleteByUpload("account_user", sourceB.uploadId);
    expect(relationshipRepository.getForReview("account_user", candidate.id)).toMatchObject({
      status: "archived",
      version: 4,
      evidence: []
    });
    expect(relationshipRepository.listConfirmedForPerson("account_user", alice.id)).toEqual([]);

    const conflictEvidence = await evidence({
      uploadId: "upload_relationship_conflict",
      segmentId: "segment_relationship_conflict",
      text: "The mentor relationship requires conflict review."
    });
    const conflictCandidate = repository.createRelationshipCandidate({
      accountId: "account_user",
      personAId: alice.id,
      personBId: bob.id,
      type: "mentor",
      expectedVersion: 0,
      evidence: conflictEvidence
    });
    const conflict = repository.transitionRelationship({
      accountId: "account_user",
      relationshipId: conflictCandidate.id,
      action: "conflict",
      expectedVersion: 1
    });
    expect(conflict).toMatchObject({ status: "conflict", version: 2 });
    expect(() => repository.transitionRelationship({
      accountId: "account_user",
      relationshipId: conflict.id,
      action: "confirm",
      expectedVersion: 2
    })).toThrow(expect.objectContaining({ code: "invalid_state" }));
    expect(count("memory_items")).toBe(0);
    expect(count("person_facts")).toBe(0);
    expect(count("person_commitments")).toBe(0);
    expect(count("person_identity_links")).toBe(0);
  });
});
