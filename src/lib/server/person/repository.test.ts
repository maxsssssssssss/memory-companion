// @vitest-environment node

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AudioUpload, TranscriptSegment } from "@/lib/domain/types";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import { createMemoryRepository } from "@/lib/server/memory/repository";
import { validatePersonTranscriptEvidence } from "./evidence";
import { createPersonRepository, PersonRepositoryError } from "./repository";

let database: Database.Database;

beforeEach(() => {
  database = openMemoryDatabase({ filePath: ":memory:" });
});

afterEach(() => {
  database.close();
});

function transcriptSegment(input: {
  uploadId: string;
  segmentId: string;
  speaker?: string;
  identityId?: string;
  identityKind?: "trusted" | "unknown" | "none";
  text?: string;
}): TranscriptSegment {
  const identityKind = input.identityKind ?? (input.identityId ? "trusted" : "none");
  return {
    id: input.segmentId,
    uploadId: input.uploadId,
    startSeconds: 0,
    endSeconds: 5,
    speaker: input.speaker,
    identity: identityKind === "none" ? undefined : {
      globalSpeakerId: input.identityId ?? "unknown_identity",
      displayName: input.speaker,
      identityType: identityKind === "unknown" ? "unknown_person" : "known_contact",
      confidence: identityKind === "trusted" ? 0.96 : null,
      source: identityKind === "trusted" ? "voiceprint" : "cross_chunk_matching"
    },
    text: input.text ?? `${input.speaker ?? "有人"} 最近喜欢摄影。`,
    confidence: 0.97,
    sceneLabels: ["private_content"],
    valueLabels: ["notable_quote"]
  };
}

async function evidence(input: {
  accountId?: string;
  uploadId?: string;
  segmentId?: string;
  speaker?: string;
  identityId?: string;
  identityKind?: "trusted" | "unknown" | "none";
  text?: string;
}) {
  const accountId = input.accountId ?? "account_user";
  const uploadId = input.uploadId ?? "upload_1";
  const segmentId = input.segmentId ?? "segment_1";
  const segment = transcriptSegment({
    uploadId,
    segmentId,
    speaker: input.speaker,
    identityId: input.identityId,
    identityKind: input.identityKind,
    text: input.text
  });
  const upload: AudioUpload = {
    id: uploadId,
    originalName: `${uploadId}.wav`,
    mimeType: "audio/wav",
    sizeBytes: 1024,
    recordingDate: "2026-08-10",
    status: "ready"
  };
  const values = new Map<string, unknown>([
    [`uploads/${uploadId}`, upload],
    [`segments/${uploadId}`, [segment]]
  ]);
  return validatePersonTranscriptEvidence({
    store: {
      async read<T>(collection: string, id: string) {
        return (values.get(`${collection}/${id}`) ?? null) as T | null;
      }
    },
    authenticatedAccountId: accountId,
    accountId,
    uploadId,
    sourceSegmentId: segmentId,
    quote: segment.text
  });
}

describe("Person repository isolation and review state", () => {
  it("keeps same-name and similar-name candidates distinct without normalized-name merging", async () => {
    const repository = createPersonRepository(database);
    const aliceOne = repository.createCandidate({
      accountId: "account_user",
      displayName: "Alice",
      source: "transcript_candidate",
      evidence: await evidence({ uploadId: "upload_1", segmentId: "segment_1" })
    });
    const aliceTwo = repository.createCandidate({
      accountId: "account_user",
      displayName: "Alice",
      source: "transcript_candidate",
      evidence: await evidence({ uploadId: "upload_2", segmentId: "segment_2" })
    });
    const aliceZhang = repository.createCandidate({
      accountId: "account_user",
      displayName: "Alice Zhang",
      source: "transcript_candidate",
      evidence: await evidence({ uploadId: "upload_3", segmentId: "segment_3" })
    });
    const smallAlice = repository.createCandidate({
      accountId: "account_user",
      displayName: "小 Alice",
      source: "transcript_candidate",
      evidence: await evidence({ uploadId: "upload_4", segmentId: "segment_4" })
    });

    expect(new Set([aliceOne.id, aliceTwo.id, aliceZhang.id, smallAlice.id]).size).toBe(4);
    expect(repository.listPersonsForReview("account_user")).toHaveLength(4);
    expect(repository.listConfirmedPersons("account_user")).toEqual([]);
  });

  it("isolates same-name people and every referenced resource by account", async () => {
    const repository = createPersonRepository(database);
    const evidenceA = await evidence({ accountId: "account_a" });
    const evidenceB = await evidence({ accountId: "account_b" });
    const accountA = repository.createCandidate({
      accountId: "account_a",
      displayName: "Alice",
      source: "transcript_candidate",
      evidence: evidenceA
    });
    const accountB = repository.createCandidate({
      accountId: "account_b",
      displayName: "Alice",
      source: "transcript_candidate",
      evidence: evidenceB
    });

    expect(accountA.id).not.toBe(accountB.id);
    expect(repository.getPersonForReview("account_b", accountA.id)).toBeNull();
    expect(repository.listPersonsForReview("account_a").map((person) => person.id)).toEqual([accountA.id]);
    expect(repository.listPersonsForReview("account_b").map((person) => person.id)).toEqual([accountB.id]);
    expect(() => repository.confirmPerson({
      accountId: "account_b",
      personId: accountA.id,
      evidence: evidenceB
    })).toThrow(PersonRepositoryError);
  });

  it("requires explicit name confirmation and never treats an alias as a merge key", async () => {
    const repository = createPersonRepository(database);
    const candidateEvidence = await evidence({ uploadId: "upload_1", segmentId: "segment_1" });
    const person = repository.createCandidate({
      accountId: "account_user",
      displayName: "Alice",
      source: "transcript_candidate",
      evidence: candidateEvidence
    });
    repository.confirmPerson({
      accountId: "account_user",
      personId: person.id,
      evidence: candidateEvidence
    });
    const alias = repository.createAliasCandidate({
      accountId: "account_user",
      personId: person.id,
      alias: "Alice Zhang",
      source: "transcript_candidate",
      evidence: await evidence({ uploadId: "upload_2", segmentId: "segment_2" })
    });

    expect(repository.getConfirmedPerson("account_user", person.id)?.aliases).toEqual([]);
    const confirmedAlias = repository.confirmName({
      accountId: "account_user",
      nameId: alias.id,
      evidence: await evidence({ uploadId: "upload_3", segmentId: "segment_3" })
    });
    expect(confirmedAlias.status).toBe("confirmed");
    expect(repository.getConfirmedPerson("account_user", person.id)?.aliases.map((name) => name.name)).toEqual([
      "Alice Zhang"
    ]);
  });
});

describe("Person Identity and Subject fail-closed rules", () => {
  it("keeps unknown and candidate Subject observations out of confirmed Subject lookup", async () => {
    const repository = createPersonRepository(database);
    const unknownEvidence = await evidence({
      speaker: "speaker_1",
      identityId: "unknown_identity",
      identityKind: "unknown"
    });
    const person = repository.createCandidate({
      accountId: "account_user",
      displayName: "Alice",
      source: "transcript_candidate",
      evidence: unknownEvidence
    });
    repository.recordUnknownSubject({
      accountId: "account_user",
      reason: "No confirmed subject",
      evidence: unknownEvidence
    });
    repository.recordCandidateSubject({
      accountId: "account_user",
      personId: person.id,
      reason: "Name mention is only a review candidate",
      evidence: unknownEvidence
    });

    expect(repository.getConfirmedSubjectPersonId({
      accountId: "account_user",
      uploadId: "upload_1",
      sourceSegmentId: "segment_1"
    })).toBeNull();
    expect(repository.listSubjectObservations("account_user").map((item) => item.status).sort()).toEqual([
      "candidate",
      "unknown"
    ]);
    expect(() => repository.createIdentityLinkCandidate({
      accountId: "account_user",
      personId: person.id,
      identityId: "speaker_1",
      source: "identity_profile",
      evidence: unknownEvidence
    })).toThrow("Chunk-local speaker labels");
  });

  it("requires a confirmed Person, confirmed Identity link, and matching trusted Transcript Identity", async () => {
    const repository = createPersonRepository(database);
    const aliceEvidence = await evidence({
      speaker: "Alice",
      identityId: "identity_alice",
      identityKind: "trusted"
    });
    const person = repository.createCandidate({
      accountId: "account_user",
      displayName: "Alice",
      source: "identity_profile",
      evidence: aliceEvidence
    });

    expect(() => repository.recordConfirmedSubject({
      accountId: "account_user",
      personId: person.id,
      identityId: "identity_alice",
      reason: "premature",
      evidence: aliceEvidence
    })).toThrow("confirmed Person");

    repository.confirmPerson({ accountId: "account_user", personId: person.id, evidence: aliceEvidence });
    const link = repository.createIdentityLinkCandidate({
      accountId: "account_user",
      personId: person.id,
      identityId: "identity_alice",
      source: "manual_confirmation",
      evidence: aliceEvidence
    });
    expect(() => repository.recordConfirmedSubject({
      accountId: "account_user",
      personId: person.id,
      identityId: "identity_alice",
      reason: "link is still candidate",
      evidence: aliceEvidence
    })).toThrow("confirmed Person-to-Identity link");

    repository.confirmIdentityLink({ accountId: "account_user", linkId: link.id, evidence: aliceEvidence });
    const observation = repository.recordConfirmedSubject({
      accountId: "account_user",
      personId: person.id,
      identityId: "identity_alice",
      reason: "Explicitly reviewed Identity-to-Person link matches the Transcript speaker",
      evidence: aliceEvidence
    });

    expect(observation).toMatchObject({
      accountId: "account_user",
      personId: person.id,
      status: "confirmed",
      source: "confirmed_identity"
    });
    expect(aliceEvidence.segment.speaker).toBe("Alice");
    expect(aliceEvidence.segment.identity?.globalSpeakerId).toBe("identity_alice");
    expect(aliceEvidence.accountId).toBe("account_user");
    expect(person.id).not.toBe("identity_alice");
    expect(repository.getConfirmedSubjectPersonId({
      accountId: "account_user",
      uploadId: "upload_1",
      sourceSegmentId: "segment_1"
    })).toBe(person.id);
    expect(repository.confirmIdentityLink({
      accountId: "account_user",
      linkId: link.id,
      evidence: aliceEvidence
    }).id).toBe(link.id);
    expect(repository.recordConfirmedSubject({
      accountId: "account_user",
      personId: person.id,
      identityId: "identity_alice",
      reason: "Idempotent reviewed assertion",
      evidence: aliceEvidence
    }).id).toBe(observation.id);
    expect(repository.listIdentityLinks("account_user")).toHaveLength(1);
    expect(repository.listSubjectObservations("account_user").filter((item) => item.status === "confirmed"))
      .toHaveLength(1);
  });

  it("rejects raw data, identity-as-Person ids, unknown identities, and conflicting confirmed links", async () => {
    const repository = createPersonRepository(database);
    expect(() => repository.createCandidate({
      accountId: "account_user",
      displayName: "Fake",
      source: "transcript_candidate",
      evidence: {} as never
    })).toThrow("validated against the authenticated Transcript store");

    const firstEvidence = await evidence({ identityId: "identity_alice", speaker: "Alice" });
    const first = repository.createCandidate({
      accountId: "account_user",
      displayName: "Alice",
      source: "identity_profile",
      evidence: firstEvidence
    });
    expect(() => repository.createIdentityLinkCandidate({
      accountId: "account_user",
      personId: first.id,
      identityId: first.id,
      source: "identity_profile",
      evidence: firstEvidence
    })).toThrow("Identity id cannot be used as Person id");

    repository.confirmPerson({ accountId: "account_user", personId: first.id, evidence: firstEvidence });
    const firstLink = repository.createIdentityLinkCandidate({
      accountId: "account_user",
      personId: first.id,
      identityId: "identity_alice",
      source: "identity_profile",
      evidence: firstEvidence
    });
    repository.confirmIdentityLink({ accountId: "account_user", linkId: firstLink.id, evidence: firstEvidence });

    const unknownEvidence = await evidence({
      uploadId: "upload_unknown",
      segmentId: "segment_unknown",
      identityId: "unknown_identity",
      identityKind: "unknown"
    });
    const unknownPerson = repository.createCandidate({
      accountId: "account_user",
      displayName: "Unknown",
      source: "identity_profile",
      evidence: unknownEvidence
    });
    repository.confirmPerson({ accountId: "account_user", personId: unknownPerson.id, evidence: unknownEvidence });
    const unknownLink = repository.createIdentityLinkCandidate({
      accountId: "account_user",
      personId: unknownPerson.id,
      identityId: "unknown_identity",
      source: "identity_profile",
      evidence: unknownEvidence
    });
    expect(() => repository.confirmIdentityLink({
      accountId: "account_user",
      linkId: unknownLink.id,
      evidence: unknownEvidence
    })).toThrow("trusted Identity");

    const secondEvidence = await evidence({
      uploadId: "upload_2",
      segmentId: "segment_2",
      identityId: "identity_alice",
      speaker: "Another Alice"
    });
    const second = repository.createCandidate({
      accountId: "account_user",
      displayName: "Another Alice",
      source: "identity_profile",
      evidence: secondEvidence
    });
    repository.confirmPerson({ accountId: "account_user", personId: second.id, evidence: secondEvidence });
    const secondLink = repository.createIdentityLinkCandidate({
      accountId: "account_user",
      personId: second.id,
      identityId: "identity_alice",
      source: "identity_profile",
      evidence: secondEvidence
    });
    expect(() => repository.confirmIdentityLink({
      accountId: "account_user",
      linkId: secondLink.id,
      evidence: secondEvidence
    })).toThrow("already confirmed for another Person");
  });
});

describe("Person repository persistence semantics", () => {
  it("is idempotent and rolls back evidence/entity writes when a dependent write fails", async () => {
    const repository = createPersonRepository(database);
    const validated = await evidence({ identityId: "identity_alice", speaker: "Alice" });
    const first = repository.createCandidate({
      accountId: "account_user",
      displayName: "Alice",
      source: "transcript_candidate",
      evidence: validated,
      now: "2026-08-10T00:00:00.000Z"
    });
    const retry = repository.createCandidate({
      accountId: "account_user",
      displayName: "Alice",
      source: "transcript_candidate",
      evidence: validated,
      now: "2026-08-10T00:01:00.000Z"
    });
    expect(retry.id).toBe(first.id);
    expect((database.prepare("SELECT COUNT(*) AS count FROM person_entities").get() as { count: number }).count).toBe(1);
    expect((database.prepare("SELECT COUNT(*) AS count FROM person_evidence").get() as { count: number }).count).toBe(1);
    expect((database.prepare("SELECT COUNT(*) AS count FROM person_names").get() as { count: number }).count).toBe(1);

    database.exec(`
      CREATE TRIGGER fail_person_name_insert
      BEFORE INSERT ON person_names
      WHEN NEW.name = 'Rollback Person'
      BEGIN
        SELECT RAISE(ABORT, 'forced dependent failure');
      END;
    `);
    const rollbackEvidence = await evidence({ uploadId: "upload_2", segmentId: "segment_2" });
    expect(() => repository.createCandidate({
      accountId: "account_user",
      displayName: "Rollback Person",
      source: "transcript_candidate",
      evidence: rollbackEvidence
    })).toThrow("forced dependent failure");
    expect(database.prepare("SELECT 1 FROM person_evidence WHERE id = ?").get(rollbackEvidence.id)).toBeUndefined();
    expect(database.prepare("SELECT 1 FROM person_entities WHERE display_name = 'Rollback Person'").get()).toBeUndefined();
  });

  it("joins Subject evidence to Memory evidence by upload and source segment without a Memory id dependency", async () => {
    const personRepository = createPersonRepository(database);
    const memoryRepository = createMemoryRepository(database);
    const validated = await evidence({ identityId: "identity_alice", speaker: "Alice" });
    memoryRepository.replaceUploadMemories({
      userId: "account_user",
      uploadId: "upload_1",
      sourceSegments: [validated.segment],
      memories: [{
        id: "memory_alice_photography",
        type: "preference",
        title: "Alice 喜欢摄影",
        summary: "Alice 最近喜欢摄影。",
        importance: 0.7,
        date: "2026-08-10",
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
        evidence: [{
          id: "memory_evidence_alice",
          sourceType: "transcript",
          sourceId: "segment_1",
          uploadId: "upload_1",
          date: "2026-08-10",
          quote: validated.quote,
          createdAt: "2026-08-10T00:00:00.000Z"
        }]
      }]
    });
    const memoryBeforePersonWrites = memoryRepository.getRelevantMemories({ userId: "account_user" });
    const person = personRepository.createCandidate({
      accountId: "account_user",
      displayName: "Alice",
      source: "identity_profile",
      evidence: validated
    });
    personRepository.confirmPerson({ accountId: "account_user", personId: person.id, evidence: validated });
    const link = personRepository.createIdentityLinkCandidate({
      accountId: "account_user",
      personId: person.id,
      identityId: "identity_alice",
      source: "identity_profile",
      evidence: validated
    });
    personRepository.confirmIdentityLink({ accountId: "account_user", linkId: link.id, evidence: validated });
    personRepository.recordConfirmedSubject({
      accountId: "account_user",
      personId: person.id,
      identityId: "identity_alice",
      reason: "reviewed",
      evidence: validated
    });

    const joined = database.prepare(`
      SELECT memory.id AS memory_evidence_id, subject.id AS subject_observation_id
      FROM person_subject_observations subject
      INNER JOIN person_evidence person_source
        ON person_source.id = subject.evidence_id AND person_source.account_id = subject.account_id
      INNER JOIN memory_evidence memory
        ON memory.upload_id = person_source.upload_id
        AND memory.source_id = person_source.source_segment_id
      INNER JOIN memory_items item
        ON item.id = memory.memory_id AND item.user_id = subject.account_id
      WHERE subject.account_id = ? AND subject.status = 'confirmed'
    `).get("account_user") as { memory_evidence_id: string; subject_observation_id: string } | undefined;
    expect(joined).toEqual({
      memory_evidence_id: "memory_evidence_alice",
      subject_observation_id: expect.stringMatching(/^person_subject_observation_/u)
    });
    expect(memoryRepository.getRelevantMemories({ userId: "account_user" })).toEqual(memoryBeforePersonWrites);
  });

  it("returns stable deletion counts and makes direct upload cleanup idempotent", async () => {
    const repository = createPersonRepository(database);
    const validated = await evidence({ uploadId: "upload_delete", segmentId: "segment_delete" });
    const person = repository.createCandidate({
      accountId: "account_user",
      displayName: "Delete Candidate",
      source: "transcript_candidate",
      evidence: validated
    });

    expect(repository.deleteByUpload("account_user", "upload_delete")).toEqual({
      deletedEvidenceCount: 1,
      deletedNameCount: 1,
      deletedIdentityLinkCount: 0,
      deletedSubjectObservationCount: 0,
      deletedSubjectResolutionAuditCount: 0,
      deletedRelationshipEvidenceCount: 0,
      archivedRelationshipCount: 0,
      deletedFactEvidenceCount: 0,
      deletedFactTransitionCount: 0,
      deletedFactCount: 0,
      recalculatedFactCount: 0,
      deletedCommitmentEvidenceCount: 0,
      deletedCommitmentTransitionCount: 0,
      deletedCommitmentCount: 0,
      recalculatedCommitmentCount: 0,
      archivedPersonCount: 1
    });
    expect(repository.getPersonForReview("account_user", person.id)?.status).toBe("archived");
    expect(repository.deleteByUpload("account_user", "upload_delete")).toEqual({
      deletedEvidenceCount: 0,
      deletedNameCount: 0,
      deletedIdentityLinkCount: 0,
      deletedSubjectObservationCount: 0,
      deletedSubjectResolutionAuditCount: 0,
      deletedRelationshipEvidenceCount: 0,
      archivedRelationshipCount: 0,
      deletedFactEvidenceCount: 0,
      deletedFactTransitionCount: 0,
      deletedFactCount: 0,
      recalculatedFactCount: 0,
      deletedCommitmentEvidenceCount: 0,
      deletedCommitmentTransitionCount: 0,
      deletedCommitmentCount: 0,
      recalculatedCommitmentCount: 0,
      archivedPersonCount: 0
    });
  });

  it("cleans Person evidence and dependents inside existing upload deletion while preserving other accounts", async () => {
    const repository = createPersonRepository(database);
    const memoryRepository = createMemoryRepository(database);
    const userEvidence = await evidence({ identityId: "identity_alice", speaker: "Alice" });
    const otherEvidence = await evidence({
      accountId: "account_other",
      identityId: "identity_other_alice",
      speaker: "Alice"
    });
    const person = repository.createCandidate({
      accountId: "account_user",
      displayName: "Alice",
      source: "identity_profile",
      evidence: userEvidence
    });
    repository.confirmPerson({ accountId: "account_user", personId: person.id, evidence: userEvidence });
    const link = repository.createIdentityLinkCandidate({
      accountId: "account_user",
      personId: person.id,
      identityId: "identity_alice",
      source: "identity_profile",
      evidence: userEvidence
    });
    repository.confirmIdentityLink({ accountId: "account_user", linkId: link.id, evidence: userEvidence });
    repository.recordConfirmedSubject({
      accountId: "account_user",
      personId: person.id,
      identityId: "identity_alice",
      reason: "reviewed",
      evidence: userEvidence
    });
    repository.createCandidate({
      accountId: "account_other",
      displayName: "Alice",
      source: "transcript_candidate",
      evidence: otherEvidence
    });

    memoryRepository.deleteByUpload("account_user", "upload_1");
    expect((database.prepare("SELECT COUNT(*) AS count FROM person_evidence WHERE account_id = 'account_user'").get() as { count: number }).count).toBe(0);
    expect((database.prepare("SELECT COUNT(*) AS count FROM person_names WHERE account_id = 'account_user'").get() as { count: number }).count).toBe(0);
    expect((database.prepare("SELECT COUNT(*) AS count FROM person_identity_links WHERE account_id = 'account_user'").get() as { count: number }).count).toBe(0);
    expect((database.prepare("SELECT COUNT(*) AS count FROM person_subject_observations WHERE account_id = 'account_user'").get() as { count: number }).count).toBe(0);
    expect(repository.getPersonForReview("account_user", person.id)?.status).toBe("archived");
    expect(repository.listPersonsForReview("account_other")).toHaveLength(1);

    memoryRepository.deleteByUpload("account_user", "upload_1");
    expect(repository.getPersonForReview("account_user", person.id)?.status).toBe("archived");
    expect(repository.listPersonsForReview("account_other")).toHaveLength(1);
  });
});
