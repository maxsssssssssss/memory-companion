import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import {
  getDateCompanionDatabasePath,
  openDateCompanionDatabase
} from "./db";
import { migrateDateCompanionSchema } from "./schema";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("date-companion SQLite schema", () => {
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
        count: 5
      });
      expect(database.prepare("PRAGMA table_info(dc_participant_audio_samples)").all()).not.toHaveLength(0);
      expect(database.prepare("PRAGMA table_info(dc_relationship_speaker_bindings)").all()).not.toHaveLength(0);
      expect(database.prepare("PRAGMA table_info(dc_voice_enrollment_snapshots)").all()).not.toHaveLength(0);
      expect(database.prepare("PRAGMA table_info(dc_voice_enrollment_snapshot_members)").all()).not.toHaveLength(0);
      expect(database.prepare("PRAGMA table_info(dc_voice_enrollment_outbox)").all()).not.toHaveLength(0);
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
        id TEXT PRIMARY KEY
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
        { version: 5 }
      ]);
      migrateDateCompanionSchema(database);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM dc_schema_migrations"
      ).get()).toEqual({ count: 5 });
    } finally {
      database.close();
    }
  });
});
