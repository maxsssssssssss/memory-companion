// @vitest-environment node

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import { createMemoryRepository } from "@/lib/server/memory/repository";
import { MEMORY_SCHEMA_VERSION, migrateMemorySchema } from "@/lib/server/memory/schema";

let database: Database.Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("Memory schema v5 to v6 People Relationship migration", () => {
  it("preserves Phase 1 sidecars, audits, Memory rows, and legacy retrieval output", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const memoryRepository = createMemoryRepository(database);
    memoryRepository.replaceUploadMemories({
      userId: "account_user",
      uploadId: "upload_v5",
      memories: [{
        id: "memory_v5",
        type: "event",
        title: "Existing Memory",
        summary: "Existing v5 Memory stays unchanged.",
        importance: 0.7,
        date: "2026-08-10",
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
        evidence: [{
          id: "memory_evidence_v5",
          sourceType: "transcript",
          sourceId: "segment_v5",
          uploadId: "upload_v5",
          date: "2026-08-10",
          quote: "Existing v5 Memory stays unchanged.",
          createdAt: "2026-08-10T00:00:00.000Z"
        }]
      }]
    });
    database.exec(`
      INSERT INTO person_entities (
        id, account_id, display_name, source, status, created_at, updated_at
      ) VALUES (
        'person_v5', 'account_user', 'Alice', 'manual_confirmation', 'confirmed',
        '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
      );
      INSERT INTO person_evidence (
        id, account_id, upload_id, source_segment_id, quote, created_at, updated_at
      ) VALUES (
        'person_evidence_v5', 'account_user', 'upload_v5', 'segment_v5',
        'Existing v5 Memory stays unchanged.',
        '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
      );
      INSERT INTO person_names (
        id, account_id, person_id, evidence_id, name, normalized_name,
        kind, status, source, created_at, updated_at
      ) VALUES (
        'person_name_v5', 'account_user', 'person_v5', 'person_evidence_v5',
        'Alice', 'alice', 'display_name', 'confirmed', 'manual_confirmation',
        '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
      );
      INSERT INTO person_subject_resolution_audits (
        id, account_id, upload_id, source_segment_id, evidence_id, decision,
        person_id, identity_id, subject_observation_id, subject_observation_created,
        candidate_person_ids_json, reason_codes_json, resolver_version,
        created_at, updated_at
      ) VALUES (
        'audit_v5', 'account_user', 'upload_v5', 'segment_v5', 'person_evidence_v5',
        'candidate', 'person_v5', NULL, NULL, 0,
        '["person_v5"]', '["not_explicit_first_person"]', 1,
        '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
      );
    `);
    const before = memoryRepository.getRelevantMemories({ userId: "account_user" });
    const phase1Counts = {
      people: (database.prepare("SELECT COUNT(*) AS count FROM person_entities").get() as { count: number }).count,
      evidence: (database.prepare("SELECT COUNT(*) AS count FROM person_evidence").get() as { count: number }).count,
      names: (database.prepare("SELECT COUNT(*) AS count FROM person_names").get() as { count: number }).count,
      audits: (database.prepare("SELECT COUNT(*) AS count FROM person_subject_resolution_audits").get() as { count: number }).count
    };

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
      DROP TABLE person_relationship_evidence;
      DROP TABLE person_relationships;
      DROP INDEX idx_person_subject_observations_confirmed_person_evidence;
      CREATE UNIQUE INDEX idx_person_subject_observations_confirmed_evidence
        ON person_subject_observations(account_id, evidence_id)
        WHERE status = 'confirmed';
      DELETE FROM schema_migrations WHERE version >= 6;
    `);
    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: 5 });

    migrateMemorySchema(database);

    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: MEMORY_SCHEMA_VERSION });
    expect(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('person_relationships', 'person_relationship_evidence')
      ORDER BY name
    `).all()).toEqual([
      { name: "person_relationship_evidence" },
      { name: "person_relationships" }
    ]);
    expect({
      people: (database.prepare("SELECT COUNT(*) AS count FROM person_entities").get() as { count: number }).count,
      evidence: (database.prepare("SELECT COUNT(*) AS count FROM person_evidence").get() as { count: number }).count,
      names: (database.prepare("SELECT COUNT(*) AS count FROM person_names").get() as { count: number }).count,
      audits: (database.prepare("SELECT COUNT(*) AS count FROM person_subject_resolution_audits").get() as { count: number }).count
    }).toEqual(phase1Counts);
    expect(memoryRepository.getRelevantMemories({ userId: "account_user" })).toEqual(before);
    expect(database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_person_subject_observations_confirmed_person_evidence'
    `).get()).toEqual(expect.objectContaining({
      sql: expect.stringContaining("account_id, evidence_id, person_id")
    }));
  });
});
