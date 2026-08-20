// @vitest-environment node

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AudioUpload, TranscriptSegment } from "@/lib/domain/types";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import { validatePersonTranscriptEvidence } from "./evidence";
import { createPersonRepository, PersonRepositoryError } from "./repository";
import { createPersonRelationshipRepository } from "./relationship-repository";

let database: Database.Database;

beforeEach(() => {
  database = openMemoryDatabase({ filePath: ":memory:" });
});

afterEach(() => {
  database.close();
});

async function evidence(input: {
  accountId?: string;
  uploadId: string;
  segmentId: string;
  text: string;
}) {
  const accountId = input.accountId ?? "account_user";
  const segment: TranscriptSegment = {
    id: input.segmentId,
    uploadId: input.uploadId,
    startSeconds: 0,
    endSeconds: 4,
    speaker: "reviewed_speaker",
    text: input.text,
    confidence: 0.97,
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
  accountId?: string;
  displayName: string;
  uploadId: string;
  segmentId: string;
}) {
  const accountId = input.accountId ?? "account_user";
  const personEvidence = await evidence({
    accountId,
    uploadId: input.uploadId,
    segmentId: input.segmentId,
    text: `${input.displayName} was explicitly reviewed.`
  });
  const repository = createPersonRepository(database);
  const person = repository.createCandidate({
    accountId,
    displayName: input.displayName,
    source: "transcript_candidate",
    evidence: personEvidence
  });
  repository.confirmPerson({ accountId, personId: person.id, evidence: personEvidence });
  return repository.getConfirmedPerson(accountId, person.id)!;
}

describe("Evidence First Person Relationship repository", () => {
  it("creates an idempotent candidate and requires explicit confirmation", async () => {
    const alice = await confirmedPerson({
      displayName: "Alice",
      uploadId: "upload_alice",
      segmentId: "segment_alice"
    });
    const bob = await confirmedPerson({
      displayName: "Bob",
      uploadId: "upload_bob",
      segmentId: "segment_bob"
    });
    const relationshipEvidence = await evidence({
      uploadId: "upload_relationship",
      segmentId: "segment_relationship",
      text: "The friend relationship was explicitly confirmed."
    });
    const repository = createPersonRelationshipRepository(database);
    const first = repository.createCandidate({
      accountId: "account_user",
      personAId: alice.id,
      personBId: bob.id,
      type: "friend",
      evidence: relationshipEvidence
    });
    const retry = repository.createCandidate({
      accountId: "account_user",
      personAId: bob.id,
      personBId: alice.id,
      type: "friend",
      evidence: relationshipEvidence
    });

    expect(first.id).toBe(retry.id);
    expect(first.status).toBe("candidate");
    expect(repository.listConfirmedForPerson("account_user", alice.id)).toEqual([]);
    const confirmed = repository.confirmRelationship({
      accountId: "account_user",
      relationshipId: first.id
    });
    expect(confirmed).toMatchObject({
      status: "confirmed",
      explicitlyConfirmed: true,
      type: "friend"
    });
    expect(confirmed.evidence).toHaveLength(1);
    expect(repository.confirmRelationship({
      accountId: "account_user",
      relationshipId: first.id
    }).id).toBe(first.id);
    expect(repository.listConfirmedForPerson("account_user", alice.id)?.map((item) => item.id))
      .toEqual([first.id]);
  });

  it("fails closed for candidate endpoints, cross-account resources, and missing Evidence", async () => {
    const alice = await confirmedPerson({
      displayName: "Alice",
      uploadId: "upload_alice",
      segmentId: "segment_alice"
    });
    const candidateEvidence = await evidence({
      uploadId: "upload_candidate",
      segmentId: "segment_candidate",
      text: "Candidate Bob."
    });
    const personRepository = createPersonRepository(database);
    const candidateBob = personRepository.createCandidate({
      accountId: "account_user",
      displayName: "Bob",
      source: "transcript_candidate",
      evidence: candidateEvidence
    });
    const relationshipEvidence = await evidence({
      uploadId: "upload_relation",
      segmentId: "segment_relation",
      text: "A relationship candidate."
    });
    const repository = createPersonRelationshipRepository(database);
    expect(() => repository.createCandidate({
      accountId: "account_user",
      personAId: alice.id,
      personBId: candidateBob.id,
      type: "friend",
      evidence: relationshipEvidence
    })).toThrow(PersonRepositoryError);
    expect(repository.listConfirmedForPerson("other_account", alice.id)).toBeNull();

    const bob = await confirmedPerson({
      displayName: "Confirmed Bob",
      uploadId: "upload_confirmed_bob",
      segmentId: "segment_confirmed_bob"
    });
    const candidate = repository.createCandidate({
      accountId: "account_user",
      personAId: alice.id,
      personBId: bob.id,
      type: "friend",
      evidence: relationshipEvidence
    });
    database.prepare(`
      DELETE FROM person_relationship_evidence
      WHERE account_id = ? AND relationship_id = ?
    `).run("account_user", candidate.id);
    expect(() => repository.confirmRelationship({
      accountId: "account_user",
      relationshipId: candidate.id
    })).toThrow(/canonical Transcript Evidence/u);
  });

  it("never lets a conflict review overwrite a confirmed Relationship", async () => {
    const alice = await confirmedPerson({
      displayName: "Alice",
      uploadId: "upload_alice",
      segmentId: "segment_alice"
    });
    const bob = await confirmedPerson({
      displayName: "Bob",
      uploadId: "upload_bob",
      segmentId: "segment_bob"
    });
    const repository = createPersonRelationshipRepository(database);
    const confirmedCandidate = repository.createCandidate({
      accountId: "account_user",
      personAId: alice.id,
      personBId: bob.id,
      type: "friend",
      evidence: await evidence({
        uploadId: "upload_friend",
        segmentId: "segment_friend",
        text: "They explicitly confirmed they are friends."
      })
    });
    repository.confirmRelationship({
      accountId: "account_user",
      relationshipId: confirmedCandidate.id
    });
    expect(() => repository.markConflict({
      accountId: "account_user",
      relationshipId: confirmedCandidate.id
    })).toThrow(/cannot overwrite/u);

    const conflictCandidate = repository.createCandidate({
      accountId: "account_user",
      personAId: alice.id,
      personBId: bob.id,
      type: "coworker",
      evidence: await evidence({
        uploadId: "upload_coworker",
        segmentId: "segment_coworker",
        text: "The coworker relation is disputed."
      })
    });
    repository.markConflict({
      accountId: "account_user",
      relationshipId: conflictCandidate.id
    });
    expect(repository.listConfirmedForPerson("account_user", alice.id)?.map((item) => item.id))
      .toEqual([confirmedCandidate.id]);
    expect(repository.getForReview("account_user", conflictCandidate.id)?.status).toBe("conflict");
  });

  it("archives an Evidence-less Relationship on upload deletion without affecting other uploads", async () => {
    const alice = await confirmedPerson({
      displayName: "Alice",
      uploadId: "upload_alice",
      segmentId: "segment_alice"
    });
    const bob = await confirmedPerson({
      displayName: "Bob",
      uploadId: "upload_bob",
      segmentId: "segment_bob"
    });
    const repository = createPersonRelationshipRepository(database);
    const candidate = repository.createCandidate({
      accountId: "account_user",
      personAId: alice.id,
      personBId: bob.id,
      type: "friend",
      evidence: await evidence({
        uploadId: "upload_relation_only",
        segmentId: "segment_relation_only",
        text: "Explicit relationship evidence."
      })
    });
    repository.confirmRelationship({ accountId: "account_user", relationshipId: candidate.id });

    const deleted = createPersonRepository(database).deleteByUpload(
      "account_user",
      "upload_relation_only"
    );
    expect(deleted).toMatchObject({
      deletedRelationshipEvidenceCount: 1,
      archivedRelationshipCount: 1
    });
    expect(repository.listConfirmedForPerson("account_user", alice.id)).toEqual([]);
    expect(repository.getForReview("account_user", candidate.id)?.status).toBe("archived");
    expect(createPersonRepository(database).getConfirmedPerson("account_user", alice.id)).not.toBeNull();
    expect(createPersonRepository(database).getConfirmedPerson("account_user", bob.id)).not.toBeNull();
  });

  it("does not read an unlinked Date Companion relationship", async () => {
    const alice = await confirmedPerson({
      displayName: "Alice",
      uploadId: "upload_alice",
      segmentId: "segment_alice"
    });
    expect(createPersonRelationshipRepository(database)
      .listConfirmedForPerson("account_user", alice.id)).toEqual([]);
    expect(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'relationship_external_links'
    `).get()).toBeUndefined();
  });
});
