import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import {
  getDateCompanionDatabasePath,
  openDateCompanionDatabase
} from "./db";
import { DateCompanionRepository } from "./repository";
import { createDateCompanionMemoryBridgeRepository } from "./memory-bridge-repository";
import { DATE_COMPANION_SCHEMA_VERSION, migrateDateCompanionSchema } from "./schema";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function versionsThrough(version: number) {
  return Array.from({ length: version }, (_, index) => index + 1);
}

// Each migration and its ledger insert share a transaction. Stop that transaction
// at the first newer version so the fixture contains only the historical schema.
function createLegacySchema(db: Database.Database, version: 1 | 12) {
  db.exec(`
    CREATE TABLE dc_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TEMP TRIGGER fixture_stop_migrations BEFORE INSERT ON dc_schema_migrations
    WHEN NEW.version > ${version}
    BEGIN SELECT RAISE(ABORT, 'fixture_target_version_reached'); END;
  `);
  expect(() => migrateDateCompanionSchema(db)).toThrow(/^fixture_target_version_reached$/);
  db.exec("DROP TRIGGER fixture_stop_migrations");
  expect(db.prepare("SELECT version FROM dc_schema_migrations ORDER BY version").pluck().all())
    .toEqual(versionsThrough(version));
}

describe("date-companion SQLite schema", () => {
  it("upgrades V12 with its saved meeting, speaker identity and evidence intact", () => {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys = ON");
      createLegacySchema(db, 12);
      const newTables = [
        "dc_preparations", "dc_preparation_operations", "dc_reviewed_speaker_segments",
        "dc_memory_withdrawals", "dc_memory_withdrawn_grants"
      ];
      for (const name of newTables) {
        expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = ?").get(name)).toBeUndefined();
      }
      const repo = new DateCompanionRepository(db);
      const userId = "migration-user", relationship = repo.createOrGetRelationship(userId).relationship;
      const upload = "migration-fixture", { interactionId } = repo.importInteraction({
        userId, relationshipId: relationship.id, sourceUploadId: upload, recordingDate: "2026-11-03", originalName: "synthetic.wav",
        participants: [{ speakerId: "self" }], recapCandidates: [{ kind: "promise", proposedText: "把书名发给你", sortOrder: 0,
          evidence: [{ uploadId: upload, sourceSegmentId: "migration-segment", startSeconds: 0, endSeconds: 2, speakerId: "self", quote: "我把书名发给你。" }] }],
      });
      // Finalized V12 records have a label-level assignment and no segment-review column.
      const now = "2026-11-03T12:00:00.000Z";
      db.prepare("UPDATE dc_interactions SET status='confirmed', version=1, confirmed_at=? WHERE id=?")
        .run(now, interactionId);
      db.prepare("UPDATE dc_participant_assignments SET role='self', confirmed_by=?, confirmed_at=? WHERE interaction_id=?")
        .run(userId, now, interactionId);
      db.prepare("UPDATE dc_recap_items SET disposition='kept', version=1 WHERE interaction_id=?").run(interactionId);
      db.prepare(`
        INSERT INTO dc_promises (id, user_id, relationship_id, originating_recap_item_id, text, status, created_at, updated_at)
        SELECT 'promise', user_id, ?, id, proposed_text, 'open', ?, ? FROM dc_recap_items WHERE interaction_id=?
      `).run(relationship.id, now, now, interactionId);
      createDateCompanionMemoryBridgeRepository(db).putPersonMapping({
        userId, relationshipId: relationship.id, selfPersonId: "person_a", companionPersonId: "person_b",
        relationshipType: "dating", expectedVersion: 0
      });
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'dc_%' AND name!='dc_schema_migrations' ORDER BY name").all() as { name: string }[];
      const originalColumns = tables.map(({name}) => ({
        name, columns: (db.pragma(`table_info("${name}")`) as Array<{name:string}>).map(c => c.name).join(",")
      }));
      const rows = () => originalColumns.map(({name,columns}) => [name, db.prepare(`SELECT ${columns} FROM "${name}"`).all()]);
      const before = rows();
      const migrations = db.prepare("SELECT * FROM dc_schema_migrations ORDER BY version").all();
      expect(migrations).toHaveLength(12);
      expect(db.prepare("SELECT COUNT(*) AS n FROM dc_promises").get()).toEqual({n:1});
      expect(db.prepare("SELECT COUNT(*) AS n FROM dc_evidence_snapshots").get()).toEqual({n:1});
      migrateDateCompanionSchema(db);
      migrateDateCompanionSchema(db);
      expect(rows()).toEqual(before);
      expect(db.prepare("SELECT * FROM dc_schema_migrations WHERE version<13 ORDER BY version").all()).toEqual(migrations);
      expect(db.prepare("SELECT version FROM dc_schema_migrations WHERE version>12 ORDER BY version").pluck().all())
        .toEqual(versionsThrough(DATE_COMPANION_SCHEMA_VERSION).slice(12));
      expect(db.prepare("SELECT review_by_segment FROM dc_participant_assignments").get()).toEqual({review_by_segment:0});
      expect(db.prepare("SELECT role, confirmed_by FROM dc_evidence_speaker_reviews").get())
        .toEqual({ role: "self", confirmed_by: userId });
      expect(db.prepare("SELECT self_person_id, companion_person_id, status, version FROM dc_relationship_person_mappings").get())
        .toEqual({ self_person_id: "person_a", companion_person_id: "person_b", status: "confirmed", version: 1 });
      for (const table of newTables) {
        expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({n:0});
      }
      expect(db.pragma("index_info(idx_dc_withdrawn_grants_receipt)")).toEqual([
        expect.objectContaining({ name: "withdrawal_id" })
      ]);
      const insertReceipt = db.prepare(`
        INSERT INTO dc_memory_withdrawals (id, user_id, relationship_id, preview_version, created_at, updated_at)
        VALUES (?, ?, ?, 'preview', ?, ?)
      `);
      expect(() => insertReceipt.run("wrong-owner", "other-user", relationship.id, now, now)).toThrow(/FOREIGN KEY/);
      insertReceipt.run("receipt", userId, relationship.id, now, now);
      expect(() => insertReceipt.run("duplicate", userId, relationship.id, now, now)).toThrow(/UNIQUE/);
      const insertGrant = db.prepare(`
        INSERT INTO dc_memory_withdrawn_grants (withdrawal_id, user_id, relationship_id, interaction_id, upload_id,
          generation, outbox_id, idempotency_key, payload_digest, category, status)
        VALUES ('receipt', ?, ?, ?, ?, ?, 'outbox', 'key', 'digest', ?, 'pending')
      `);
      expect(() => insertGrant.run(userId, relationship.id, interactionId, upload, 0, "retained")).toThrow(/CHECK/);
      expect(() => insertGrant.run(userId, relationship.id, interactionId, upload, 1, "unclassified")).toThrow(/CHECK/);
      insertGrant.run(userId, relationship.id, interactionId, upload, 1, "retained");
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally { db.close(); }
  });

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
      CREATE TABLE dc_participant_assignments (
        user_id TEXT NOT NULL, interaction_id TEXT NOT NULL, speaker_id TEXT NOT NULL, role TEXT, confirmed_at TEXT, confirmed_by TEXT,
        PRIMARY KEY(user_id,interaction_id,speaker_id)
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
        count: DATE_COMPANION_SCHEMA_VERSION
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
    try {
      legacyDatabase.pragma("foreign_keys = ON");
      createLegacySchema(legacyDatabase, 1);
      expect(legacyDatabase.prepare(
        "SELECT name FROM pragma_table_info('dc_interactions') WHERE name='confirmation_fingerprint'"
      ).get()).toBeUndefined();
      legacyDatabase.exec(`
        INSERT INTO dc_relationships (id, user_id, status, created_at, updated_at)
          VALUES ('relation', 'owner', 'active', '2026-08-04', '2026-08-04');
        INSERT INTO dc_interactions (id, user_id, relationship_id, source_upload_id, recording_date,
          original_name, status, source_state, created_at, updated_at)
          VALUES ('meeting', 'owner', 'relation', 'upload', '2026-08-04',
            'synthetic.wav', 'draft', 'available', '2026-08-04', '2026-08-04');
      `);
    } finally {
      legacyDatabase.close();
    }

    const database = openDateCompanionDatabase({ filePath });
    const ledger = "SELECT version, applied_at FROM dc_schema_migrations ORDER BY version";
    let migratedLedger: unknown[];
    try {
      const columns = database.prepare(
        "PRAGMA table_info(dc_interactions)"
      ).all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain("confirmation_fingerprint");
      expect(database.prepare(
        "SELECT version FROM dc_schema_migrations ORDER BY version"
      ).pluck().all()).toEqual(versionsThrough(DATE_COMPANION_SCHEMA_VERSION));
      migratedLedger = database.prepare(ledger).all();
    } finally {
      database.close();
    }
    const reopened = openDateCompanionDatabase({ filePath });
    try {
      expect(reopened.prepare(ledger).all()).toEqual(migratedLedger);
      expect(reopened.prepare(`
        SELECT user_id, relationship_id, source_upload_id, status, confirmation_fingerprint
        FROM dc_interactions WHERE id='meeting'
      `).get()).toEqual({
        user_id: "owner", relationship_id: "relation", source_upload_id: "upload",
        status: "draft", confirmation_fingerprint: null
      });
      expect(reopened.pragma("foreign_key_check")).toEqual([]);
      expect(reopened.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      reopened.close();
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
