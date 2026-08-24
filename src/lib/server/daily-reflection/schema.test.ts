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
          { version: 6, count: 1 },
          { version: 7, count: 1 },
          { version: 8, count: 1 },
          { version: 9, count: 1 },
          { version: 10, count: 1 }
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
        { version: 6 },
        { version: 7 },
        { version: 8 },
        { version: 9 },
        { version: 10 }
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
        { name: "dr_working_cards" },
        { name: "dr_working_card_events" },
        { name: "dr_candidates" },
        { name: "dr_candidate_sources" },
        { name: "dr_processing_plans" },
        { name: "dr_asset_publications" },
        { name: "dr_v2_reflection_inputs" },
        { name: "dr_candidate_v2_metadata" },
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
      ).get()).toEqual({ count: 10 });
      expect(reopened.prepare(
        "SELECT source_origin FROM dr_reflections WHERE id = 'reflection_reopen'"
      ).get()).toEqual({ source_origin: "unknown" });
      migrateDailyReflectionSchema(reopened);
      expect(reopened.prepare(
        "SELECT COUNT(*) AS count FROM dr_schema_migrations"
      ).get()).toEqual({ count: 10 });
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
        { version: 6 },
        { version: 7 },
        { version: 8 },
        { version: 9 },
        { version: 10 }
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

  it("backfills V9 Cards into additive Working Card snapshots without rewriting history", () => {
    const database = openDailyReflectionDatabase({ filePath: ":memory:" });
    try {
      database.exec(`
        DROP TABLE dr_working_card_events;
        DROP TABLE dr_working_cards;
        DELETE FROM dr_schema_migrations WHERE version = 10;
        PRAGMA user_version = 9;
      `);
      database.prepare(`
        INSERT INTO dr_reflections (
          id, account_id, upload_id, input_method, processing_profile,
          ingestion_context, status, version, idempotency_key,
          create_fingerprint, error_code, error_message, created_at,
          updated_at, source_origin
        ) VALUES (?, ?, ?, ?, ?, 'daily_reflection', 'review_pending', 0, ?, ?, NULL, NULL, ?, ?, ?)
      `).run(
        "reflection_v9_card",
        "account_1",
        "upload_v9_card",
        "file_upload",
        "full_recording",
        "operation_v9_card",
        "fingerprint_v9_card",
        timestamp,
        timestamp,
        "user_reflection"
      );
      database.prepare(`
        INSERT INTO dr_candidates (
          id, account_id, reflection_id, ordinal, proposed_text, user_text,
          status, candidate_type, subject_person_id, subject_confirmed,
          version, created_at, updated_at
        ) VALUES (?, ?, ?, 0, ?, ?, 'kept', 'question', NULL, 0, 2, ?, ?)
      `).run(
        "card_v9",
        "account_1",
        "reflection_v9_card",
        "旧标题对应内容",
        "用户确认后的内容",
        timestamp,
        timestamp
      );
      database.prepare(`
        INSERT INTO dr_reflection_cards (
          id, account_id, reflection_id, card_kind, proposed_title,
          proposed_text, user_title, user_text, source_candidate_ids_json,
          evidence_ids_json, cluster_id, cluster_title, display_tier, rank,
          confidence, importance, durability, novelty, epistemic_status,
          risk_flags_json, action_claimed, review_status, version,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'open_question', ?, ?, ?, ?, ?, ?, ?, ?, 'primary', 0,
                  0.8, 0.7, 0.6, 0.5, 'explicit_user_statement', '[]', 0,
                  'kept', 2, ?, ?)
      `).run(
        "card_v9",
        "account_1",
        "reflection_v9_card",
        "旧标题",
        "旧内容",
        "用户标题",
        "用户确认后的内容",
        JSON.stringify(["hidden_v9"]),
        JSON.stringify(["segment_v9"]),
        "cluster_v9",
        "旧主题",
        timestamp,
        timestamp
      );
      database.prepare(`
        INSERT INTO dr_asset_publications (
          account_id, reflection_id, asset_kind, attempt_version,
          payload_json, published_at
        ) VALUES (?, ?, 'segments', 1, ?, ?)
      `).run(
        "account_1",
        "reflection_v9_card",
        JSON.stringify([{ id: "segment_v9" }]),
        timestamp
      );

      database.prepare(`
        INSERT INTO dr_reflections (
          id, account_id, upload_id, input_method, processing_profile,
          ingestion_context, status, version, idempotency_key,
          create_fingerprint, error_code, error_message, created_at,
          updated_at, source_origin
        ) VALUES (?, ?, ?, ?, ?, 'daily_reflection', 'cancelled', 0, ?, ?, NULL, NULL, ?, ?, ?)
      `).run(
        "reflection_v9_cancelled",
        "account_1",
        "upload_v9_cancelled",
        "file_upload",
        "full_recording",
        "operation_v9_cancelled",
        "fingerprint_v9_cancelled",
        timestamp,
        timestamp,
        "user_reflection"
      );
      for (const [id, status] of [
        ["card_v9_cancelled_saved", "kept"],
        ["card_v9_cancelled_unsaved", "pending"]
      ] as const) {
        database.prepare(`
          INSERT INTO dr_candidates (
            id, account_id, reflection_id, ordinal, proposed_text, user_text,
            status, candidate_type, subject_person_id, subject_confirmed,
            version, created_at, updated_at
          ) VALUES (?, 'account_1', 'reflection_v9_cancelled', ?, ?, NULL,
                    ?, 'summary', NULL, 0, 0, ?, ?)
        `).run(
          id,
          status === "kept" ? 0 : 1,
          `Legacy ${status}`,
          status,
          timestamp,
          timestamp
        );
        database.prepare(`
          INSERT INTO dr_reflection_cards (
            id, account_id, reflection_id, card_kind, proposed_title,
            proposed_text, user_title, user_text, source_candidate_ids_json,
            evidence_ids_json, cluster_id, cluster_title, display_tier, rank,
            confidence, importance, durability, novelty, epistemic_status,
            risk_flags_json, action_claimed, review_status, version,
            created_at, updated_at
          ) VALUES (?, 'account_1', 'reflection_v9_cancelled', 'insight', ?, ?,
                    NULL, NULL, ?, ?, ?, 'Legacy', 'primary', ?, 0.8, 0.7, 0.6,
                    0.5, 'reported_event', '[]', 0, ?, 0, ?, ?)
        `).run(
          id,
          `Legacy ${status}`,
          `Legacy ${status} content`,
          JSON.stringify([id]),
          JSON.stringify([`segment_${id}`]),
          `cluster_${id}`,
          status === "kept" ? 0 : 1,
          status,
          timestamp,
          timestamp
        );
      }

      migrateDailyReflectionSchema(database);

      expect(database.prepare(`
        SELECT id, source_reflection_ids_json, title, content, card_kind,
               evidence_ids_json, status, source_unavailable, saved_at
        FROM dr_working_cards WHERE account_id = 'account_1' AND id = 'card_v9'
      `).get()).toEqual({
        id: "card_v9",
        source_reflection_ids_json: JSON.stringify(["reflection_v9_card"]),
        title: "用户标题",
        content: "用户确认后的内容",
        card_kind: "question",
        evidence_ids_json: JSON.stringify(["segment_v9"]),
        status: "saved",
        source_unavailable: 0,
        saved_at: timestamp
      });
      expect(database.prepare(`
        SELECT review_status, version FROM dr_reflection_cards WHERE id = 'card_v9'
      `).get()).toEqual({ review_status: "kept", version: 2 });
      expect(database.prepare(`
        SELECT id, status, source_unavailable, saved_at
        FROM dr_working_cards
        WHERE source_reflection_ids_json = json_array('reflection_v9_cancelled')
        ORDER BY id
      `).all()).toEqual([{
        id: "card_v9_cancelled_saved",
        status: "saved",
        source_unavailable: 1,
        saved_at: timestamp
      }]);
      expect(database.pragma("foreign_key_check")).toEqual([]);
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

  it("adds V2 sidecars without weakening candidate scope or confirmation shape", () => {
    const database = openDailyReflectionDatabase({ filePath: ":memory:" });
    try {
      const insertReflection = database.prepare(`
        INSERT INTO dr_reflections (
          id, account_id, upload_id, input_method, source_origin,
          processing_profile, ingestion_context, status, version,
          idempotency_key, create_fingerprint, error_code, error_message,
          created_at, updated_at
        ) VALUES (?, 'account_1', ?, 'file_upload', 'user_reflection',
          'full_recording', 'daily_reflection', 'extracting', 0,
          NULL, ?, NULL, NULL, ?, ?)
      `);
      insertReflection.run("reflection_v2_a", "upload_v2_a", "fingerprint_a", timestamp, timestamp);
      insertReflection.run("reflection_v2_b", "upload_v2_b", "fingerprint_b", timestamp, timestamp);
      database.prepare(`
        INSERT INTO dr_candidates (
          id, account_id, reflection_id, ordinal, proposed_text, user_text,
          status, candidate_type, subject_person_id, subject_confirmed,
          version, created_at, updated_at
        ) VALUES ('candidate_v2', 'account_1', 'reflection_v2_a', 0, 'text', NULL,
          'pending', 'summary', NULL, 0, 0, ?, ?)
      `).run(timestamp, timestamp);

      const insertMetadata = database.prepare(`
        INSERT INTO dr_candidate_v2_metadata (
          account_id, reflection_id, candidate_id, candidate_kind,
          evidence_ids_json, confidence, caution, action_claimed,
          created_at, updated_at
        ) VALUES ('account_1', ?, 'candidate_v2', 'insight', '[]', 0.8,
          'user reflection', 0, ?, ?)
      `);
      expect(() => insertMetadata.run("reflection_v2_b", timestamp, timestamp))
        .toThrow(/daily_reflection_v2_candidate_scope_mismatch/u);
      expect(() => insertMetadata.run("reflection_v2_a", timestamp, timestamp))
        .not.toThrow();

      expect(() => database.prepare(`
        INSERT INTO dr_reflection_confirmations (
          id, account_id, reflection_id, idempotency_key, request_fingerprint,
          confirmation_fingerprint, source_origin, input_method,
          processing_profile, candidate_snapshots_json, created_at,
          contract_version, save_intent
        ) VALUES ('confirmation_invalid_v2', 'account_1', 'reflection_v2_a',
          'operation_invalid_v2', ?, ?, 'user_reflection', 'file_upload',
          'full_recording', '[]', ?, 2, 'recap_only')
      `).run("a".repeat(64), "b".repeat(64), timestamp))
        .toThrow(/daily_reflection_confirmation_contract_mismatch/u);
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      database.close();
    }
  });
});
