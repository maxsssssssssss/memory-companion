// @vitest-environment node

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import { createMemoryRepository } from "@/lib/server/memory/repository";
import { MEMORY_SCHEMA_VERSION, migrateMemorySchema } from "@/lib/server/memory/schema";
import { createPersonMemoryRepository } from "./memory-repository";
import { createPersonRelationshipRepository } from "./relationship-repository";
import { createPersonRepository } from "./repository";
import {
  LifecycleTranscriptStore,
  confirmedLifecycleRelationship,
  createConfirmedLifecyclePerson,
  exactSubjectEvidence
} from "./lifecycle-test-fixtures";

let database: Database.Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("Memory schema v6 to v7 Relationship Lifecycle migration", () => {
  it("adds lifecycle tables while preserving Phase 1/2 sidecars, People reads, and legacy Memory output", async () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const store = new LifecycleTranscriptStore();
    const alice = await createConfirmedLifecyclePerson({
      database,
      store,
      displayName: "Alice",
      identityId: "identity_alice",
      uploadId: "upload_alice_profile",
      segmentId: "segment_alice_profile"
    });
    const bob = await createConfirmedLifecyclePerson({
      database,
      store,
      displayName: "Bob",
      identityId: "identity_bob",
      uploadId: "upload_bob_profile",
      segmentId: "segment_bob_profile"
    });
    const memoryEvidence = await exactSubjectEvidence({
      database,
      store,
      personId: alice.person.id,
      identityId: alice.identityId,
      uploadId: "upload_memory",
      segmentId: "segment_memory",
      text: "I visited the museum."
    });
    const memoryRepository = createMemoryRepository(database);
    memoryRepository.replaceUploadMemories({
      userId: "account_user",
      uploadId: "upload_memory",
      sourceSegments: [{
        id: "segment_memory",
        uploadId: "upload_memory",
        startSeconds: 0,
        endSeconds: 5,
        speaker: alice.identityId,
        text: memoryEvidence.quote,
        confidence: 0.98,
        sceneLabels: ["private_content"],
        valueLabels: ["notable_quote"]
      }],
      memories: [{
        id: "memory_v6",
        type: "event",
        title: "Museum visit",
        summary: "Alice visited the museum.",
        importance: 0.72,
        date: "2026-08-10",
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
        evidence: [{
          id: "memory_evidence_v6",
          sourceType: "transcript",
          sourceId: "segment_memory",
          uploadId: "upload_memory",
          date: "2026-08-10",
          quote: memoryEvidence.quote,
          createdAt: "2026-08-10T00:00:00.000Z"
        }]
      }]
    });
    const relationship = await confirmedLifecycleRelationship({
      database,
      store,
      personAId: alice.person.id,
      personBId: bob.person.id,
      uploadId: "upload_relationship",
      segmentId: "segment_relationship"
    });
    const personRepository = createPersonRepository(database);
    const personMemoryRepository = createPersonMemoryRepository(database);
    const relationshipRepository = createPersonRelationshipRepository(database);
    const before = {
      memories: memoryRepository.getRelevantMemories({ userId: "account_user" }),
      people: personRepository.listConfirmedPersons("account_user"),
      aliceMemories: personMemoryRepository.getPersonMemories({
        accountId: "account_user",
        personId: alice.person.id
      }),
      relationships: relationshipRepository.listConfirmedForPerson(
        "account_user",
        alice.person.id
      ),
      counts: {
        evidence: (database.prepare("SELECT COUNT(*) AS count FROM person_evidence").get() as { count: number }).count,
        subjects: (database.prepare("SELECT COUNT(*) AS count FROM person_subject_observations").get() as { count: number }).count,
        relationships: (database.prepare("SELECT COUNT(*) AS count FROM person_relationships").get() as { count: number }).count
      }
    };
    expect(before.relationships).toEqual([expect.objectContaining({ id: relationship.id })]);
    expect(before.aliceMemories?.memories).toHaveLength(1);

    database.exec(`
      DROP TRIGGER IF EXISTS dc_memory_bridge_candidate_receipts_immutable;
      DROP TABLE dc_memory_bridge_candidate_receipts;
      DROP TRIGGER IF EXISTS memory_daily_reflection_candidate_receipts_immutable;
      DROP TABLE memory_daily_reflection_candidate_revocations;
      DROP TABLE memory_daily_reflection_candidate_person_sources;
      DROP TABLE memory_daily_reflection_candidate_current_memories;
      DROP TABLE memory_daily_reflection_candidate_payloads;
      DROP TABLE memory_daily_reflection_evidence_provenance;
      DROP TABLE memory_daily_reflection_candidate_receipts;
      DROP TABLE memory_daily_reflection_publications;
      DROP TABLE memory_upload_tombstones;
      DROP TABLE dc_memory_bridge_receipts;
      DROP TABLE dc_person_relationship_links;
      DROP TABLE person_evidence_dc_links;
      DROP TABLE dc_retained_uploads;
      DROP TABLE memory_evidence_provenance;
      DROP TABLE person_admission_audits;
      DROP TABLE person_self_bindings;
      DROP TABLE person_subject_admissions;
      DROP TABLE person_relationship_admissions;
      DROP TABLE person_entity_admissions;
      DROP TABLE person_fact_transitions;
      DROP TABLE person_commitment_transitions;
      DROP TABLE person_fact_evidence;
      DROP TABLE person_commitment_evidence;
      DROP TABLE person_facts;
      DROP TABLE person_commitments;
      DELETE FROM schema_migrations WHERE version >= 7;
    `);
    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: 6 });

    migrateMemorySchema(database);

    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: MEMORY_SCHEMA_VERSION });
    expect(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'person_facts', 'person_fact_evidence', 'person_fact_transitions',
        'person_commitments', 'person_commitment_evidence', 'person_commitment_transitions'
      ) ORDER BY name
    `).all()).toEqual([
      { name: "person_commitment_evidence" },
      { name: "person_commitment_transitions" },
      { name: "person_commitments" },
      { name: "person_fact_evidence" },
      { name: "person_fact_transitions" },
      { name: "person_facts" }
    ]);
    expect({
      memories: memoryRepository.getRelevantMemories({ userId: "account_user" }),
      people: personRepository.listConfirmedPersons("account_user"),
      aliceMemories: personMemoryRepository.getPersonMemories({
        accountId: "account_user",
        personId: alice.person.id
      }),
      relationships: relationshipRepository.listConfirmedForPerson(
        "account_user",
        alice.person.id
      ),
      counts: {
        evidence: (database.prepare("SELECT COUNT(*) AS count FROM person_evidence").get() as { count: number }).count,
        subjects: (database.prepare("SELECT COUNT(*) AS count FROM person_subject_observations").get() as { count: number }).count,
        relationships: (database.prepare("SELECT COUNT(*) AS count FROM person_relationships").get() as { count: number }).count
      }
    }).toEqual(before);
    expect(memoryRepository.getRelevantMemories({ userId: "account_user" }))
      .toEqual(before.memories);
  });
});
