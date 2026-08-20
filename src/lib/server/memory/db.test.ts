// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryDatabase } from "./db";
import { createMemoryRepository } from "./repository";
import { MEMORY_SCHEMA_VERSION } from "./schema";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("memory database", () => {
  it("creates the managed memory schema with owner-attribution and additive Person sidecars", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-db-"));
    const database = openMemoryDatabase({ filePath: join(tempDir, "memory.sqlite") });

    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const migration = database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    const itemColumns = database.prepare("PRAGMA table_info(memory_items)").all() as Array<{ name: string }>;
    const relationIndexes = database.prepare("PRAGMA index_list(memory_relations)").all() as Array<{
      name: string;
      unique: number;
    }>;
    const dcRelationshipLinkColumns = database
      .prepare("PRAGMA table_info(dc_person_relationship_links)")
      .all() as Array<{ name: string }>;

    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining([
        "memory_evidence",
        "memory_items",
        "memory_owner_observations",
        "memory_relations",
        "memory_daily_reflection_candidate_receipts",
        "memory_daily_reflection_candidate_current_memories",
        "memory_daily_reflection_candidate_payloads",
        "memory_daily_reflection_candidate_person_sources",
        "memory_daily_reflection_candidate_revocations",
        "memory_daily_reflection_evidence_provenance",
        "memory_daily_reflection_publications",
        "memory_upload_tombstones",
        "dc_memory_bridge_candidate_receipts",
        "person_admission_audits",
        "person_entities",
        "person_entity_admissions",
        "person_evidence",
        "person_fact_evidence",
        "person_fact_transitions",
        "person_facts",
        "person_identity_links",
        "person_commitment_evidence",
        "person_commitment_transitions",
        "person_commitments",
        "person_names",
        "person_relationship_evidence",
        "person_relationship_admissions",
        "person_relationships",
        "person_self_bindings",
        "person_subject_admissions",
        "person_subject_resolution_audits",
        "person_subject_observations",
        "schema_migrations"
      ])
    );
    expect(itemColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "importance_score",
        "importance_reason",
        "status",
        "occurrence_count",
        "first_seen_date",
        "last_seen_date",
        "access_count",
        "last_accessed_at"
      ])
    );
    expect(relationIndexes).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "idx_memory_relations_unique", unique: 1 })])
    );
    expect(migration).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
      { version: 8 },
      { version: 9 },
      { version: 10 },
      { version: 11 },
      { version: 12 },
      { version: 13 }
    ]);
    expect(dcRelationshipLinkColumns.map((column) => column.name)).toContain("relationship_epoch");
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);

    database.close();
  });

  it("keeps Date Companion candidate receipts immutable, scoped, and operation-owned", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-db-dc-candidate-receipts-"));
    const database = openMemoryDatabase({ filePath: join(tempDir, "memory.sqlite") });
    database.prepare(`
      INSERT INTO dc_memory_bridge_receipts (
        id, account_id, idempotency_key, payload_digest, dc_relationship_id,
        dc_interaction_id, dc_outbox_id, mapping_version, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "operation_receipt_1",
      "account_1",
      "idempotency_1",
      "payload_digest_1",
      "relationship_1",
      "interaction_1",
      "outbox_1",
      1,
      "2026-08-20T00:00:00.000Z"
    );
    const insertCandidateReceipt = database.prepare(`
      INSERT INTO dc_memory_bridge_candidate_receipts (
        id, account_id, operation_receipt_id, dc_outbox_id, dc_interaction_id,
        recap_item_id, origin_key, status, memory_id, score, reasons_json,
        evidence_digest, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertCandidateReceipt.run(
      "candidate_receipt_1",
      "account_1",
      "operation_receipt_1",
      "outbox_1",
      "interaction_1",
      "recap_1",
      "date-companion-memory:v1:account_1:interaction_1:recap_1",
      "admitted",
      "memory_1",
      0.8,
      "[]",
      "a".repeat(64),
      "2026-08-20T00:00:00.000Z"
    );
    database.prepare(`
      INSERT INTO dc_memory_bridge_receipts (
        id, account_id, idempotency_key, payload_digest, dc_relationship_id,
        dc_interaction_id, dc_outbox_id, mapping_version, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "operation_receipt_2",
      "account_1",
      "idempotency_2",
      "payload_digest_2",
      "relationship_1",
      "interaction_1",
      "outbox_1",
      2,
      "2026-08-20T00:00:01.000Z"
    );
    insertCandidateReceipt.run(
      "candidate_receipt_new_operation",
      "account_1",
      "operation_receipt_2",
      "outbox_1",
      "interaction_1",
      "recap_1",
      "date-companion-memory:v1:account_1:interaction_1:recap_1:epoch-2",
      "rejected",
      null,
      0.2,
      '["policy_rejected"]',
      "b".repeat(64),
      "2026-08-20T00:00:01.000Z"
    );

    expect(() => database.prepare(`
      UPDATE dc_memory_bridge_candidate_receipts SET score = 0.9 WHERE id = ?
    `).run("candidate_receipt_1")).toThrow("dc_memory_bridge_candidate_receipt_immutable");
    expect(() => insertCandidateReceipt.run(
      "candidate_receipt_duplicate",
      "account_1",
      "operation_receipt_2",
      "outbox_1",
      "interaction_1",
      "recap_1",
      "date-companion-memory:v1:account_1:interaction_1:recap_1:duplicate",
      "rejected",
      null,
      0.2,
      '["policy_rejected"]',
      "c".repeat(64),
      "2026-08-20T00:00:02.000Z"
    )).toThrow();
    expect(() => insertCandidateReceipt.run(
      "candidate_receipt_invalid_status_memory",
      "account_1",
      "operation_receipt_1",
      "outbox_2",
      "interaction_1",
      "recap_2",
      "date-companion-memory:v1:account_1:interaction_1:recap_2",
      "rejected",
      "memory_2",
      0.2,
      '["policy_rejected"]',
      "d".repeat(64),
      "2026-08-20T00:00:03.000Z"
    )).toThrow();
    expect(() => insertCandidateReceipt.run(
      "candidate_receipt_wrong_account",
      "account_2",
      "operation_receipt_1",
      "outbox_2",
      "interaction_1",
      "recap_2",
      "date-companion-memory:v1:account_2:interaction_1:recap_2",
      "rejected",
      null,
      0.2,
      '["policy_rejected"]',
      "e".repeat(64),
      "2026-08-20T00:00:04.000Z"
    )).toThrow();

    database.prepare("DELETE FROM dc_memory_bridge_receipts WHERE id = ? AND account_id = ?")
      .run("operation_receipt_1", "account_1");
    expect(database.prepare(`
      SELECT operation_receipt_id
      FROM dc_memory_bridge_candidate_receipts
    `).all()).toEqual([{ operation_receipt_id: "operation_receipt_2" }]);
    database.prepare("DELETE FROM dc_memory_bridge_receipts WHERE id = ? AND account_id = ?")
      .run("operation_receipt_2", "account_1");
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM dc_memory_bridge_candidate_receipts
    `).get()).toEqual({ count: 0 });
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });

  it("migrates v10 Reflection receipts to active v11 current mappings without changing Memory", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-db-v10-v11-"));
    const filePath = join(tempDir, "memory.sqlite");
    const legacy = openMemoryDatabase({ filePath });
    createMemoryRepository(legacy).replaceUploadMemories({
      userId: "account_migration",
      uploadId: "upload_migration",
      memories: [{
        id: "memory_migration",
        type: "event",
        title: "Migration event",
        summary: "Migration event remains available.",
        importance: 0.7,
        date: "2026-08-14",
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
        evidence: [{
          id: "evidence_migration",
          sourceType: "transcript",
          sourceId: "segment_migration",
          uploadId: "upload_migration",
          date: "2026-08-14",
          quote: "Migration event remains available.",
          createdAt: "2026-08-14T00:00:00.000Z"
        }]
      }]
    });
    legacy.exec(`
      INSERT INTO memory_daily_reflection_publications (
        id, user_id, reflection_id, confirmation_id, upload_id,
        confirmation_fingerprint, payload_digest, source_origin, status,
        created_at, updated_at, deleted_at
      ) VALUES (
        'publication_migration', 'account_migration', 'reflection_migration',
        'confirmation_migration', 'upload_migration', '${"a".repeat(64)}',
        '${"b".repeat(64)}', 'user_reflection', 'published',
        '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z', NULL
      );
      INSERT INTO memory_daily_reflection_candidate_receipts (
        user_id, publication_id, candidate_id, status, memory_id,
        reason_code, operation_key, created_at
      ) VALUES (
        'account_migration', 'publication_migration', 'candidate_migration',
        'admitted', 'memory_migration', NULL, 'operation_migration',
        '2026-08-14T00:00:00.000Z'
      );
      INSERT INTO memory_daily_reflection_evidence_provenance (
        memory_evidence_id, user_id, publication_id, reflection_id,
        confirmation_id, candidate_id, upload_id, source_segment_id,
        source_origin, content_digest, created_at
      ) VALUES (
        'evidence_migration', 'account_migration', 'publication_migration',
        'reflection_migration', 'confirmation_migration', 'candidate_migration',
        'upload_migration', 'segment_migration', 'user_reflection',
        '${"c".repeat(64)}', '2026-08-14T00:00:00.000Z'
      );
      DROP TABLE memory_daily_reflection_candidate_revocations;
      DROP TABLE memory_daily_reflection_candidate_person_sources;
      DROP TABLE memory_daily_reflection_candidate_current_memories;
      DROP TABLE memory_daily_reflection_candidate_payloads;
      DROP TRIGGER memory_daily_reflection_candidate_receipts_immutable;
      DELETE FROM schema_migrations WHERE version = 11;
    `);
    legacy.close();

    const migrated = openMemoryDatabase({ filePath });
    expect(migrated.prepare("SELECT COUNT(*) AS count FROM memory_items").get())
      .toEqual({ count: 1 });
    expect(migrated.prepare(`
      SELECT status, current_memory_id
      FROM memory_daily_reflection_candidate_current_memories
      WHERE user_id = 'account_migration' AND candidate_id = 'candidate_migration'
    `).get()).toEqual({ status: "active", current_memory_id: "memory_migration" });
    expect(migrated.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: MEMORY_SCHEMA_VERSION });
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    expect(migrated.pragma("integrity_check", { simple: true })).toBe("ok");
    migrated.close();
  });
});
