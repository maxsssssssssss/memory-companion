import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import {
  getDateCompanionDatabasePath,
  openDateCompanionDatabase
} from "./db";
import { DATE_COMPANION_SCHEMA_VERSION, migrateDateCompanionSchema } from "./schema";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("date-companion SQLite schema", () => {
  it("migrates the V11 cache to TokenHub without losing payloads, leases, uniqueness or account-scoped delete cascades", () => {
    const database = openDateCompanionDatabase({ filePath: ":memory:" });
    try {
      const cacheDefinition = database.prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dc_proactive_value_cache'
      `).get() as { sql: string };
      const legacyDefinition = cacheDefinition.sql.replace("'deepseek', 'none', 'tokenhub'", "'deepseek', 'none'");
      expect(legacyDefinition).not.toContain("tokenhub");
      database.exec("DROP TABLE dc_proactive_value_cache");
      database.exec(legacyDefinition);
      database.prepare("DELETE FROM dc_schema_migrations WHERE version = 12").run();
      const time = "2026-09-08T00:00:00.000Z";
      database.prepare(`
        INSERT INTO dc_relationships (
          id, user_id, display_name, status, version, created_at, updated_at
        ) VALUES ('migration_relationship', 'user_a', 'Love', 'active', 1, ?, ?)
      `).run(time, time);
      database.prepare(`
        INSERT INTO dc_interactions (
          id, user_id, relationship_id, source_upload_id, recording_date,
          original_name, status, source_state, version, created_at, updated_at
        ) VALUES ('migration_interaction', 'user_a', 'migration_relationship', 'migration_upload',
          '2026-09-08', 'migration.wav', 'confirmed', 'available', 1, ?, ?)
      `).run(time, time);
      const insertCache = database.prepare(`
        INSERT INTO dc_proactive_value_cache (
          id, user_id, scope, relationship_id, interaction_id, person_id,
          mapping_version, source_fingerprint, contract_version, provider, model,
          status, payload_json, failure_code, created_at, updated_at, completed_at,
          claim_token, lease_expires_at, attempt_count
        ) VALUES (?, 'user_a', ?, 'migration_relationship', ?, ?, 1, ?, 1, ?,
          'fixture-model', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertCache.run("cached_generated", "person_relationship", null, "person_companion", "a".repeat(64),
        "deepseek", "generated", '{"fixture":"generated"}', null, time, time, time, null, null, 1);
      insertCache.run("cached_fallback", "current_interaction", "migration_interaction", null, "b".repeat(64),
        "none", "fallback", '{"fixture":"fallback"}', "disabled", time, time, time, null, null, 2);
      insertCache.run("cached_processing", "current_interaction", "migration_interaction", null, "c".repeat(64),
        "deepseek", "processing", null, null, time, time, null, "owned_claim", "2026-09-08T00:00:45.000Z", 3);
      const before = database.prepare("SELECT * FROM dc_proactive_value_cache ORDER BY id").all();
      migrateDateCompanionSchema(database);
      migrateDateCompanionSchema(database);
      expect(database.prepare("SELECT * FROM dc_proactive_value_cache ORDER BY id").all()).toEqual(before);
      expect(database.prepare("SELECT COUNT(*) AS count FROM dc_schema_migrations WHERE version = 12").get())
        .toEqual({ count: 1 });
      expect(database.prepare("SELECT MAX(version) AS version FROM dc_schema_migrations").get())
        .toEqual({ version: DATE_COMPANION_SCHEMA_VERSION });
      const tokenhub = database.prepare(`
        INSERT INTO dc_proactive_value_cache (
          id, user_id, scope, relationship_id, person_id, mapping_version,
          source_fingerprint, contract_version, provider, model, status, created_at, updated_at
        ) VALUES (?, ?, 'person_relationship', 'migration_relationship', 'person_companion',
          1, ?, 1, ?, 'deepseek-v4-pro', 'processing', ?, ?)
      `);
      tokenhub.run("new_tokenhub", "user_a", "d".repeat(64), "tokenhub", time, time);
      expect(() => tokenhub.run("duplicate_tokenhub", "user_a", "d".repeat(64), "tokenhub", time, time))
        .toThrow(/UNIQUE/u);
      expect(() => tokenhub.run("foreign_tokenhub", "user_b", "e".repeat(64), "tokenhub", time, time))
        .toThrow(/FOREIGN KEY/u);
      expect(() => tokenhub.run("invalid_provider", "user_a", "f".repeat(64), "unexpected", time, time))
        .toThrow(/CHECK/u);
      database.prepare("DELETE FROM dc_interactions WHERE id = 'migration_interaction'").run();
      expect(database.prepare("SELECT id FROM dc_proactive_value_cache ORDER BY id").all())
        .toEqual([{ id: "cached_generated" }, { id: "new_tokenhub" }]);
      database.prepare("DELETE FROM dc_relationships WHERE id = 'migration_relationship'").run();
      expect(database.prepare("SELECT COUNT(*) AS count FROM dc_proactive_value_cache").get())
        .toEqual({ count: 0 });
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_dc_proactive_value_scope'").get())
        .toEqual({ name: "idx_dc_proactive_value_scope" });
    } finally {
      database.close();
    }
  });

  function createVersionFiveFixture(database: Database.Database, conflicting = false) {
    database.exec(`
      CREATE TABLE dc_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO dc_schema_migrations(version, applied_at) VALUES
        (1, '2026-08-01T00:00:00.000Z'), (2, '2026-08-02T00:00:00.000Z'),
        (3, '2026-08-03T00:00:00.000Z'), (4, '2026-08-04T00:00:00.000Z'),
        (5, '2026-08-05T00:00:00.000Z');
      CREATE TABLE dc_relationships (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL,
        UNIQUE(id, user_id)
      );
      CREATE TABLE dc_interactions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, relationship_id TEXT NOT NULL,
        source_upload_id TEXT NOT NULL, status TEXT NOT NULL, source_state TEXT NOT NULL,
        UNIQUE(id, user_id)
      );
      CREATE TABLE dc_recap_items (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, interaction_id TEXT NOT NULL,
        disposition TEXT NOT NULL, UNIQUE(id, user_id)
      );
      CREATE TABLE dc_evidence_snapshots (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, recap_item_id TEXT NOT NULL,
        upload_id TEXT NOT NULL, source_segment_id TEXT NOT NULL,
        start_seconds REAL NOT NULL, end_seconds REAL NOT NULL, speaker_id TEXT,
        quote TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(id, user_id),
        UNIQUE(user_id, recap_item_id, upload_id, source_segment_id)
      );
      INSERT INTO dc_relationships VALUES ('relationship_1', 'user_a', 'active');
      INSERT INTO dc_interactions VALUES (
        'interaction_1', 'user_a', 'relationship_1', 'upload_1', 'confirmed', 'server_cleaned'
      );
      INSERT INTO dc_recap_items VALUES ('recap_1', 'user_a', 'interaction_1', 'kept');
      INSERT INTO dc_evidence_snapshots VALUES (
        'evidence_1', 'user_a', 'recap_1', 'upload_1', 'segment_1',
        0, 2, 'speaker_1', 'canonical quote', '2026-08-05T00:00:00.000Z'
      );
    `);
    if (conflicting) {
      database.exec(`
        INSERT INTO dc_recap_items VALUES ('recap_2', 'user_a', 'interaction_1', 'kept');
        INSERT INTO dc_evidence_snapshots VALUES (
          'evidence_2', 'user_a', 'recap_2', 'upload_1', 'segment_1',
          0, 2, 'speaker_1', 'different quote', '2026-08-05T00:00:00.000Z'
        );
      `);
    }
  }

  it("uses APP_DATA_DIR/date-companion.sqlite and applies migration once with WAL and foreign keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "date-companion-schema-"));
    roots.push(root);
    const filePath = getDateCompanionDatabasePath(root);
    expect(filePath).toBe(resolve(join(root, "date-companion.sqlite")));

    const database = openDateCompanionDatabase({ filePath });
    try {
      expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      migrateDateCompanionSchema(database);
      expect(database.prepare("SELECT COUNT(*) AS count FROM dc_schema_migrations").get()).toEqual({
        count: 12
      });
      expect(database.prepare("PRAGMA table_info(dc_participant_audio_samples)").all()).not.toHaveLength(0);
      expect(database.prepare("PRAGMA table_info(dc_relationship_speaker_bindings)").all()).not.toHaveLength(0);
      expect(database.prepare("PRAGMA table_info(dc_voice_enrollment_snapshots)").all()).not.toHaveLength(0);
      expect(database.prepare("PRAGMA table_info(dc_voice_enrollment_snapshot_members)").all()).not.toHaveLength(0);
      expect(database.prepare("PRAGMA table_info(dc_voice_enrollment_outbox)").all()).not.toHaveLength(0);
      expect(database.prepare("PRAGMA table_info(dc_memory_bridge_outbox)").all()).not.toHaveLength(0);
      expect(database.prepare("PRAGMA table_info(dc_relationship_person_mappings)").all()).not.toHaveLength(0);
      expect(database.prepare("PRAGMA table_info(dc_subject_suggestion_batches)").all()).not.toHaveLength(0);
      expect(database.prepare("PRAGMA table_info(dc_subject_suggestion_claims)").all()).not.toHaveLength(0);
      expect(database.prepare("PRAGMA table_info(dc_proactive_value_cache)").all()).not.toHaveLength(0);
      const proactiveColumns = database.prepare(
        "PRAGMA table_info(dc_proactive_value_cache)"
      ).all() as Array<{ name: string }>;
      expect(proactiveColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "claim_token",
        "lease_expires_at",
        "attempt_count"
      ]));
      const participantColumns = database.prepare(
        "PRAGMA table_info(dc_participant_assignments)"
      ).all() as Array<{ name: string }>;
      expect(participantColumns.map((column) => column.name)).toContain("continuity_key");
      const bindingColumns = database.prepare(
        "PRAGMA table_info(dc_relationship_speaker_bindings)"
      ).all() as Array<{ name: string }>;
      expect(bindingColumns.map((column) => column.name)).toContain("source_interaction_id");
      expect(database.prepare(
        "PRAGMA foreign_key_list(dc_relationship_speaker_bindings)"
      ).all()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          table: "dc_interactions",
          from: "source_interaction_id",
          to: "id",
          on_delete: "CASCADE"
        })
      ]));
    } finally {
      database.close();
    }
  });

  it("adds the confirmation fingerprint to an existing version-one database", async () => {
    const root = await mkdtemp(join(tmpdir(), "date-companion-schema-v1-"));
    roots.push(root);
    const filePath = getDateCompanionDatabasePath(root);
    const legacyDatabase = new Database(filePath);
    legacyDatabase.exec(`
      CREATE TABLE dc_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT INTO dc_schema_migrations (version, applied_at)
      VALUES (1, '2026-08-04T00:00:00.000Z');
      CREATE TABLE dc_interactions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        UNIQUE (id, user_id)
      );
      CREATE TABLE dc_relationships (
        id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        UNIQUE (id, user_id)
      );
      CREATE TABLE dc_participant_assignments (
        user_id TEXT NOT NULL,
        interaction_id TEXT NOT NULL,
        speaker_id TEXT NOT NULL,
        PRIMARY KEY (user_id, interaction_id, speaker_id)
      );
      CREATE TABLE dc_evidence_snapshots (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        recap_item_id TEXT NOT NULL,
        upload_id TEXT NOT NULL,
        source_segment_id TEXT NOT NULL,
        start_seconds REAL NOT NULL,
        end_seconds REAL NOT NULL,
        speaker_id TEXT,
        quote TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (id, user_id),
        UNIQUE (user_id, recap_item_id, upload_id, source_segment_id)
      );
    `);
    legacyDatabase.close();

    const database = openDateCompanionDatabase({ filePath });
    try {
      const columns = database.prepare(
        "PRAGMA table_info(dc_interactions)"
      ).all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain("confirmation_fingerprint");
      expect(database.prepare(
        "SELECT version FROM dc_schema_migrations ORDER BY version"
      ).all()).toEqual([
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
        { version: 12 }
      ]);
      migrateDateCompanionSchema(database);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM dc_schema_migrations"
      ).get()).toEqual({ count: 12 });
    } finally {
      database.close();
    }
  });

  it("backfills v5 Evidence provenance and rolls the v6 migration back on source conflicts", () => {
    const legacy = new Database(":memory:");
    try {
      createVersionFiveFixture(legacy);
      migrateDateCompanionSchema(legacy);
      expect(legacy.prepare(`
        SELECT provenance_version, source_kind, length(content_digest) AS digest_length
        FROM dc_evidence_snapshots WHERE id = 'evidence_1'
      `).get()).toEqual({
        provenance_version: 1,
        source_kind: "date_companion_recap",
        digest_length: 64
      });
      expect(legacy.prepare("SELECT version FROM dc_schema_migrations WHERE version = 6").get())
        .toEqual({ version: 6 });
      expect(legacy.prepare("SELECT version FROM dc_schema_migrations WHERE version = 7").get())
        .toEqual({ version: 7 });
      expect(legacy.prepare("SELECT version FROM dc_schema_migrations WHERE version = 8").get())
        .toEqual({ version: 8 });
      expect(legacy.prepare("SELECT version FROM dc_schema_migrations WHERE version = 9").get())
        .toEqual({ version: 9 });
      expect(legacy.prepare("SELECT version FROM dc_schema_migrations WHERE version = 10").get())
        .toEqual({ version: 10 });
    } finally {
      legacy.close();
    }

    const conflict = new Database(":memory:");
    try {
      createVersionFiveFixture(conflict, true);
      expect(() => migrateDateCompanionSchema(conflict))
        .toThrow("date_companion_evidence_source_conflict");
      expect(conflict.prepare("SELECT version FROM dc_schema_migrations WHERE version = 6").get())
        .toBeUndefined();
      expect((conflict.prepare("PRAGMA table_info(dc_evidence_snapshots)").all() as Array<{ name: string }>)
        .map((column) => column.name)).not.toContain("content_digest");
    } finally {
      conflict.close();
    }
  });
});
