// @vitest-environment node

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import { createMemoryRepository } from "@/lib/server/memory/repository";
import { MEMORY_SCHEMA_VERSION, migrateMemorySchema } from "@/lib/server/memory/schema";
import { createPersonCommitmentRepository } from "./commitments";
import {
  LifecycleTranscriptStore,
  confirmedLifecycleRelationship,
  createConfirmedLifecyclePerson,
  exactSharedSubjectEvidence,
  exactSubjectEvidence
} from "./lifecycle-test-fixtures";
import { createPersonMemoryRepository } from "./memory-repository";
import { createRelationshipContextBuilder } from "./relationship-context";
import { createPersonRelationshipRepository } from "./relationship-repository";
import { createPersonRepository } from "./repository";
import { createTemporalFactRepository } from "./temporal-facts";

let database: Database.Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("Memory schema v7 to v8 explicit admission migration", () => {
  it("preserves all Phase 1-3 data and read contracts while adding only admission sidecars", async () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const store = new LifecycleTranscriptStore();
    const alice = await createConfirmedLifecyclePerson({
      database,
      store,
      displayName: "Alice",
      identityId: "identity_alice_v7",
      uploadId: "upload_alice_v7",
      segmentId: "segment_alice_v7"
    });
    const bob = await createConfirmedLifecyclePerson({
      database,
      store,
      displayName: "Bob",
      identityId: "identity_bob_v7",
      uploadId: "upload_bob_v7",
      segmentId: "segment_bob_v7"
    });
    const relationship = await confirmedLifecycleRelationship({
      database,
      store,
      personAId: alice.person.id,
      personBId: bob.person.id,
      uploadId: "upload_relationship_v7",
      segmentId: "segment_relationship_v7",
      now: "2026-08-10T00:00:00.000Z"
    });
    const memoryEvidence = await exactSubjectEvidence({
      database,
      store,
      personId: alice.person.id,
      identityId: alice.identityId,
      uploadId: "upload_memory_v7",
      segmentId: "segment_memory_v7",
      text: "I visited the museum."
    });
    const fact = createTemporalFactRepository(database).createFact({
      accountId: "account_user",
      subjectPersonId: alice.person.id,
      relationshipId: relationship.id,
      kind: "event",
      factKey: "museum.visit",
      derivedText: "Alice visited the museum.",
      observedAt: "2026-08-10T01:00:00.000Z",
      evidence: memoryEvidence,
      now: "2026-08-10T01:00:00.000Z"
    });
    const commitmentEvidence = await exactSharedSubjectEvidence({
      database,
      store,
      primaryPersonId: alice.person.id,
      primaryIdentityId: alice.identityId,
      secondaryPersonId: bob.person.id,
      uploadId: "upload_commitment_v7",
      segmentId: "segment_commitment_v7",
      text: "Alice promised Bob to send the notes."
    });
    const commitment = createPersonCommitmentRepository(database).createCommitment({
      accountId: "account_user",
      relationshipId: relationship.id,
      promisorPersonId: alice.person.id,
      promiseePersonId: bob.person.id,
      text: "Send the notes",
      observedAt: "2026-08-10T02:00:00.000Z",
      occurredAt: "2026-08-10T02:00:00.000Z",
      evidence: commitmentEvidence,
      now: "2026-08-10T02:00:00.000Z"
    });
    expect(commitment.known).toBe(true);

    const memoryRepository = createMemoryRepository(database);
    memoryRepository.replaceUploadMemories({
      userId: "account_user",
      uploadId: memoryEvidence.uploadId,
      sourceSegments: [memoryEvidence.segment],
      memories: [{
        id: "memory_v7",
        type: "event",
        title: "Museum visit",
        summary: "Alice visited the museum.",
        importance: 0.7,
        date: "2026-08-10",
        createdAt: "2026-08-10T01:00:00.000Z",
        updatedAt: "2026-08-10T01:00:00.000Z",
        evidence: [{
          id: "memory_evidence_v7",
          sourceType: "transcript",
          sourceId: memoryEvidence.sourceSegmentId,
          uploadId: memoryEvidence.uploadId,
          date: "2026-08-10",
          quote: memoryEvidence.quote,
          createdAt: "2026-08-10T01:00:00.000Z"
        }]
      }]
    });
    database.prepare(`
      INSERT INTO person_subject_resolution_audits (
        id, account_id, upload_id, source_segment_id, evidence_id, decision,
        person_id, identity_id, subject_observation_id, subject_observation_created,
        candidate_person_ids_json, reason_codes_json, resolver_version,
        created_at, updated_at
      ) VALUES (
        'audit_v7', 'account_user', 'upload_memory_v7', 'segment_memory_v7', ?,
        'candidate', ?, NULL, NULL, 0, ?, '["not_explicit_first_person"]', 1,
        '2026-08-10T01:00:00.000Z', '2026-08-10T01:00:00.000Z'
      )
    `).run(memoryEvidence.id, alice.person.id, JSON.stringify([alice.person.id]));

    const personRepository = createPersonRepository(database);
    const personMemoryRepository = createPersonMemoryRepository(database);
    const relationshipRepository = createPersonRelationshipRepository(database);
    const contextBuilder = createRelationshipContextBuilder(database);
    const before = {
      memory: memoryRepository.getRelevantMemories({ userId: "account_user" }),
      people: personRepository.listConfirmedPersons("account_user"),
      personMemories: personMemoryRepository.getPersonMemories({
        accountId: "account_user",
        personId: alice.person.id
      }),
      relationships: relationshipRepository.listConfirmedForPerson(
        "account_user",
        alice.person.id
      ),
      context: contextBuilder.buildRelationshipContext({
        accountId: "account_user",
        personId: alice.person.id,
        asOf: "2026-08-11T00:00:00.000Z"
      }),
      counts: {
        persons: (database.prepare("SELECT COUNT(*) AS count FROM person_entities").get() as { count: number }).count,
        evidence: (database.prepare("SELECT COUNT(*) AS count FROM person_evidence").get() as { count: number }).count,
        subjectAudits: (database.prepare("SELECT COUNT(*) AS count FROM person_subject_resolution_audits").get() as { count: number }).count,
        relationships: (database.prepare("SELECT COUNT(*) AS count FROM person_relationships").get() as { count: number }).count,
        facts: (database.prepare("SELECT COUNT(*) AS count FROM person_facts").get() as { count: number }).count,
        commitments: (database.prepare("SELECT COUNT(*) AS count FROM person_commitments").get() as { count: number }).count
      }
    };
    expect(before.personMemories?.memories).toHaveLength(1);
    expect(before.context).toMatchObject({ known: true });
    expect(fact.status).toBe("active");

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
      DELETE FROM schema_migrations WHERE version >= 8;
    `);
    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: 7 });

    migrateMemorySchema(database);

    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: MEMORY_SCHEMA_VERSION });
    expect(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'person_entity_admissions', 'person_relationship_admissions',
        'person_subject_admissions', 'person_self_bindings', 'person_admission_audits'
      ) ORDER BY name
    `).all()).toEqual([
      { name: "person_admission_audits" },
      { name: "person_entity_admissions" },
      { name: "person_relationship_admissions" },
      { name: "person_self_bindings" },
      { name: "person_subject_admissions" }
    ]);
    expect({
      memory: memoryRepository.getRelevantMemories({ userId: "account_user" }),
      people: personRepository.listConfirmedPersons("account_user"),
      personMemories: personMemoryRepository.getPersonMemories({
        accountId: "account_user",
        personId: alice.person.id
      }),
      relationships: relationshipRepository.listConfirmedForPerson(
        "account_user",
        alice.person.id
      ),
      context: contextBuilder.buildRelationshipContext({
        accountId: "account_user",
        personId: alice.person.id,
        asOf: "2026-08-11T00:00:00.000Z"
      }),
      counts: {
        persons: (database.prepare("SELECT COUNT(*) AS count FROM person_entities").get() as { count: number }).count,
        evidence: (database.prepare("SELECT COUNT(*) AS count FROM person_evidence").get() as { count: number }).count,
        subjectAudits: (database.prepare("SELECT COUNT(*) AS count FROM person_subject_resolution_audits").get() as { count: number }).count,
        relationships: (database.prepare("SELECT COUNT(*) AS count FROM person_relationships").get() as { count: number }).count,
        facts: (database.prepare("SELECT COUNT(*) AS count FROM person_facts").get() as { count: number }).count,
        commitments: (database.prepare("SELECT COUNT(*) AS count FROM person_commitments").get() as { count: number }).count
      }
    }).toEqual(before);
  });
});
