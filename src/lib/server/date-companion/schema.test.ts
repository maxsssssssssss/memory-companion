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
        count: 2
      });
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
      ).all()).toEqual([{ version: 1 }, { version: 2 }]);
      migrateDateCompanionSchema(database);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM dc_schema_migrations"
      ).get()).toEqual({ count: 2 });
    } finally {
      database.close();
    }
  });
});
