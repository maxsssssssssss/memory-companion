import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  getDailyReflectionDatabasePath,
  openDailyReflectionDatabase
} from "./db";
import {
  DAILY_REFLECTION_SCHEMA_VERSION,
  migrateDailyReflectionSchema
} from "./schema";

const roots: string[] = [];
const timestamp = "2026-08-13T00:00:00.000Z";

function withMigrationBarrier(
  database: Database.Database,
  version: number,
  release: () => void
) {
  let released = false;
  return new Proxy(database, {
    get(target, property) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const statement = target.prepare(sql);
        const normalizedSql = sql.replace(/\s+/gu, " ").trim();
        if (normalizedSql !==
          "SELECT 1 FROM dr_schema_migrations WHERE version = ?") {
          return statement;
        }
        return new Proxy(statement, {
          get(statementTarget, statementProperty) {
            if (statementProperty !== "get") {
              const value = Reflect.get(
                statementTarget,
                statementProperty,
                statementTarget
              );
              return typeof value === "function"
                ? value.bind(statementTarget)
                : value;
            }
            return (...params: unknown[]) => {
              const get = statementTarget.get.bind(statementTarget) as
                (...bindings: unknown[]) => unknown;
              const row = get(...params);
              if (!released && params[0] === version && row === undefined) {
                released = true;
                release();
              }
              return row;
            };
          }
        });
      };
    }
  }) as Database.Database;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

function createVersionOneFixture(database: Database.Database) {
  database.exec(`
    CREATE TABLE dr_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    INSERT INTO dr_schema_migrations(version, applied_at)
    VALUES (1, '${timestamp}');

    CREATE TABLE dr_reflections (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      upload_id TEXT,
      input_method TEXT NOT NULL,
      processing_profile TEXT NOT NULL,
      ingestion_context TEXT NOT NULL,
      status TEXT NOT NULL,
      version INTEGER NOT NULL,
      idempotency_key TEXT,
      create_fingerprint TEXT NOT NULL,
      error_code TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (id, account_id),
      UNIQUE (account_id, idempotency_key)
    );
    CREATE TABLE dr_candidates (
      id TEXT PRIMARY KEY,
      proposed_text TEXT NOT NULL
    );
  `);
}

function insertLegacyReflection(
  database: Database.Database,
  id: string,
  uploadId: string | null
) {
  database.prepare(`
    INSERT INTO dr_reflections (
      id, account_id, upload_id, input_method, processing_profile,
      ingestion_context, status, version, idempotency_key,
      create_fingerprint, error_code, error_message, created_at, updated_at
    ) VALUES (?, 'account_1', ?, 'file_upload', 'full_recording',
      'daily_reflection', 'created', 0, NULL, ?, NULL, NULL, ?, ?)
  `).run(id, uploadId, `fingerprint_${id}`, timestamp, timestamp);
}

describe("Daily Reflection SQLite schema", () => {
  it("rechecks the ledger after a two-connection Web and Worker startup barrier", async () => {
    const root = await mkdtemp(join(tmpdir(), "daily-reflection-schema-race-"));
    roots.push(root);
    const filePath = getDailyReflectionDatabasePath(root);
    const web = new Database(filePath);
    const worker = new Database(filePath);
    try {
      for (const database of [web, worker]) {
        database.pragma("foreign_keys = ON");
        database.pragma("busy_timeout = 5000");
      }
      web.pragma("journal_mode = WAL");
      worker.pragma("journal_mode = WAL");
      web.pragma("synchronous = NORMAL");
      worker.pragma("synchronous = NORMAL");

      let workerSucceeded = false;
      const webAtBarrier = withMigrationBarrier(web, 3, () => {
        migrateDailyReflectionSchema(worker);
        workerSucceeded = true;
      });

      expect(() => migrateDailyReflectionSchema(webAtBarrier)).not.toThrow();
      expect(workerSucceeded).toBe(true);
      for (const database of [web, worker]) {
        expect(database.pragma("user_version", { simple: true }))
          .toBe(DAILY_REFLECTION_SCHEMA_VERSION);
        expect(database.prepare(`
          SELECT version, COUNT(*) AS count
          FROM dr_schema_migrations
          GROUP BY version
          ORDER BY version
        `).all()).toEqual([
          { version: 1, count: 1 },
          { version: 2, count: 1 },
          { version: 3, count: 1 },
          { version: 4, count: 1 },
          { version: 5, count: 1 },
          { version: 6, count: 1 }
        ]);
      }
      expect((web.prepare("PRAGMA table_info(dr_reflections)").all() as Array<{
        name: string;
      }>).map((column) => column.name)).toEqual(expect.arrayContaining([
        "lease_owner",
        "lease_until",
        "attempt_version",
        "upload_fingerprint",
        "review_status"
      ]));
      expect(web.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_dr_reflections_active_lease'
      `).get()).toEqual({ name: "idx_dr_reflections_active_lease" });
      expect(web.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'dr_asset_publications'
      `).get()).toEqual({ name: "dr_asset_publications" });
      expect(web.pragma("foreign_key_check")).toEqual([]);
      expect(web.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      web.close();
      worker.close();
    }
  });

  it("uses APP_DATA_DIR/daily-reflection.sqlite and safely reopens a migrated database", async () => {
    const root = await mkdtemp(join(tmpdir(), "daily-reflection-schema-"));
    roots.push(root);
    const filePath = getDailyReflectionDatabasePath(root);
    expect(filePath).toBe(resolve(join(root, "daily-reflection.sqlite")));

    const first = openDailyReflectionDatabase({ filePath });
    try {
      expect(first.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(first.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(first.prepare(
        "SELECT version FROM dr_schema_migrations ORDER BY version"
      ).all()).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 }
      ]);
      expect((first.prepare("PRAGMA table_info(dr_reflections)").all() as Array<{
        name: string;
      }>).map((column) => column.name)).toEqual(expect.arrayContaining([
        "lease_owner",
        "lease_until",
        "attempt_version",
        "upload_fingerprint"
      ]));
      expect(first.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'dr_%'"
      ).all()).toEqual(expect.arrayContaining([
        { name: "dr_reflections" },
        { name: "dr_candidates" },
        { name: "dr_candidate_sources" },
        { name: "dr_processing_plans" },
        { name: "dr_asset_publications" },
        { name: "dr_schema_migrations" }
      ]));
      first.prepare(`
        INSERT INTO dr_reflections (
          id, account_id, upload_id, input_method, source_origin,
          processing_profile, ingestion_context, status, version,
          idempotency_key, create_fingerprint, error_code, error_message,
          created_at, updated_at
        ) VALUES (
          'reflection_reopen', 'account_1', NULL, 'file_upload', 'unknown',
          'full_recording', 'daily_reflection', 'created', 0,
          NULL, 'fingerprint', NULL, NULL, ?, ?
        )
      `).run(timestamp, timestamp);
    } finally {
      first.close();
    }

    const reopened = openDailyReflectionDatabase({ filePath });
    try {
      expect(reopened.prepare(
        "SELECT COUNT(*) AS count FROM dr_schema_migrations"
      ).get()).toEqual({ count: 6 });
      expect(reopened.prepare(
        "SELECT source_origin FROM dr_reflections WHERE id = 'reflection_reopen'"
      ).get()).toEqual({ source_origin: "unknown" });
      migrateDailyReflectionSchema(reopened);
      expect(reopened.prepare(
        "SELECT COUNT(*) AS count FROM dr_schema_migrations"
      ).get()).toEqual({ count: 6 });
      expect(reopened.pragma("foreign_key_check")).toEqual([]);
      expect(reopened.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      reopened.close();
    }
  });

  it("backfills a missing legacy source as legacy_unknown", () => {
    const database = new Database(":memory:");
    try {
      database.pragma("foreign_keys = ON");
      createVersionOneFixture(database);
      insertLegacyReflection(database, "reflection_legacy", "upload_legacy");

      migrateDailyReflectionSchema(database);

      expect(database.prepare(`
        SELECT source_origin FROM dr_reflections WHERE id = 'reflection_legacy'
      `).get()).toEqual({ source_origin: "legacy_unknown" });
      expect(database.prepare(
        "SELECT version FROM dr_schema_migrations ORDER BY version"
      ).all()).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 }
      ]);
      expect(database.prepare(`
        SELECT lease_owner, lease_until, attempt_version, upload_fingerprint
        FROM dr_reflections WHERE id = 'reflection_legacy'
      `).get()).toEqual({
        lease_owner: null,
        lease_until: null,
        attempt_version: 0,
        upload_fingerprint: null
      });
    } finally {
      database.close();
    }
  });

  it("rolls a migration back completely when legacy upload bindings conflict", () => {
    const database = new Database(":memory:");
    try {
      createVersionOneFixture(database);
      insertLegacyReflection(database, "reflection_conflict_1", "upload_shared");
      insertLegacyReflection(database, "reflection_conflict_2", "upload_shared");

      expect(() => migrateDailyReflectionSchema(database)).toThrow();
      expect(database.prepare(
        "SELECT version FROM dr_schema_migrations ORDER BY version"
      ).all()).toEqual([{ version: 1 }]);
      expect((database.prepare("PRAGMA table_info(dr_reflections)").all() as Array<{
        name: string;
      }>).map((column) => column.name)).not.toContain("source_origin");
      expect(database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'dr_processing_plans'
      `).get()).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("enforces account-scoped foreign keys and rolls failed transactions back", () => {
    const database = openDailyReflectionDatabase({ filePath: ":memory:" });
    try {
      const insertReflection = database.prepare(`
        INSERT INTO dr_reflections (
          id, account_id, upload_id, input_method, source_origin,
          processing_profile, ingestion_context, status, version,
          idempotency_key, create_fingerprint, error_code, error_message,
          created_at, updated_at
        ) VALUES (
          'reflection_atomic', 'account_1', NULL, 'file_upload', 'unknown',
          'full_recording', 'daily_reflection', 'extracting', 0,
          NULL, 'fingerprint', NULL, NULL, ?, ?
        )
      `);
      const insertWrongAccountCandidate = database.prepare(`
        INSERT INTO dr_candidates (
          id, account_id, reflection_id, ordinal, proposed_text, user_text,
          status, candidate_type, subject_person_id, subject_confirmed,
          version, created_at, updated_at
        ) VALUES (
          'candidate_atomic', 'account_2', 'reflection_atomic', 0, 'text', NULL,
          'pending', 'event', NULL, 0, 0, ?, ?
        )
      `);
      const run = database.transaction(() => {
        insertReflection.run(timestamp, timestamp);
        insertWrongAccountCandidate.run(timestamp, timestamp);
      });

      expect(() => run()).toThrow(/FOREIGN KEY/u);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM dr_reflections"
      ).get()).toEqual({ count: 0 });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM dr_candidates"
      ).get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
