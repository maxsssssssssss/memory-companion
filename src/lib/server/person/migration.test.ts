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

describe("Memory schema v3 to current Person migrations", () => {
  it("adds only Person sidecar tables and preserves existing Memory retrieval output", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const memoryRepository = createMemoryRepository(database);
    memoryRepository.replaceUploadMemories({
      userId: "account_user",
      uploadId: "upload_legacy",
      sourceSegments: [{
        id: "segment_legacy",
        uploadId: "upload_legacy",
        startSeconds: 0,
        endSeconds: 4,
        speaker: "speaker_1",
        text: "用户计划周末整理照片。",
        confidence: 0.95,
        sceneLabels: ["self_reflection"],
        valueLabels: ["task"]
      }],
      memories: [{
        id: "memory_legacy",
        type: "commitment",
        title: "整理照片",
        summary: "用户计划周末整理照片。",
        importance: 0.68,
        date: "2026-08-09",
        createdAt: "2026-08-09T10:00:00.000Z",
        updatedAt: "2026-08-09T10:00:00.000Z",
        evidence: [{
          id: "memory_evidence_legacy",
          sourceType: "transcript",
          sourceId: "segment_legacy",
          uploadId: "upload_legacy",
          date: "2026-08-09",
          quote: "用户计划周末整理照片。",
          createdAt: "2026-08-09T10:00:00.000Z"
        }]
      }]
    });
    const before = memoryRepository.getRelevantMemories({ userId: "account_user" });

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
      DROP TABLE person_subject_resolution_audits;
      DROP TABLE person_subject_observations;
      DROP TABLE person_identity_links;
      DROP TABLE person_names;
      DROP TABLE person_evidence;
      DROP TABLE person_entities;
      DELETE FROM schema_migrations WHERE version >= 4;
    `);
    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 3 });

    migrateMemorySchema(database);

    const tables = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'person_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name)).toEqual([
      "person_admission_audits",
      "person_commitment_evidence",
      "person_commitment_transitions",
      "person_commitments",
      "person_entities",
      "person_entity_admissions",
      "person_evidence",
      "person_evidence_dc_links",
      "person_fact_evidence",
      "person_fact_transitions",
      "person_facts",
      "person_identity_links",
      "person_names",
      "person_relationship_admissions",
      "person_relationship_evidence",
      "person_relationships",
      "person_self_bindings",
      "person_subject_admissions",
      "person_subject_observations",
      "person_subject_resolution_audits"
    ]);
    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
      version: MEMORY_SCHEMA_VERSION
    });
    expect(memoryRepository.getRelevantMemories({ userId: "account_user" })).toEqual(before);
    expect((database.prepare("PRAGMA table_info(memory_items)").all() as Array<{ name: string }>)
      .map((column) => column.name)).not.toContain("subject_person_id");
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
  });
});
