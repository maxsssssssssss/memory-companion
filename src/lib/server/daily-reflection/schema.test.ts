import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  DailyReflectionMemoryProposalEventSchema,
  DailyReflectionMemoryProposalSchema
} from "../../domain/daily-reflection-memory-proposal";
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
          { version: 10, count: 1 },
          { version: 11, count: 1 },
          { version: 12, count: 1 },
          { version: 13, count: 1 },
          { version: 14, count: 1 }
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
        { version: 10 },
        { version: 11 },
        { version: 12 },
        { version: 13 },
        { version: 14 }
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
        { name: "dr_working_card_memory_revocation_operations" },
        { name: "dr_working_card_memory_revocation_receipts" },
        { name: "dr_memory_proposals" },
        { name: "dr_memory_proposal_events" },
        { name: "dr_ai_review_operations" },
        { name: "dr_ai_review_source_links" },
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
      ).get()).toEqual({ count: 14 });
      expect(reopened.prepare(
        "SELECT source_origin FROM dr_reflections WHERE id = 'reflection_reopen'"
      ).get()).toEqual({ source_origin: "unknown" });
      migrateDailyReflectionSchema(reopened);
      expect(reopened.prepare(
        "SELECT COUNT(*) AS count FROM dr_schema_migrations"
      ).get()).toEqual({ count: 14 });
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
        { version: 10 },
        { version: 11 },
        { version: 12 },
        { version: 13 },
        { version: 14 }
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

  it("adds V14 AI review fencing and stales content when Evidence is deleted", () => {
    const database = openDailyReflectionDatabase({ filePath: ":memory:" });
    try {
      database.prepare(`
        INSERT INTO dr_reflections (
          id, account_id, upload_id, input_method, source_origin,
          processing_profile, ingestion_context, status, version,
          idempotency_key, create_fingerprint, error_code, error_message,
          created_at, updated_at
        ) VALUES (
          'reflection_ai_review', 'account_1', 'upload_ai_review',
          'file_upload', 'user_reflection', 'quick_reflection',
          'daily_reflection', 'review_pending', 0, NULL, 'fingerprint',
          NULL, NULL, ?, ?
        )
      `).run(timestamp, timestamp);
      database.prepare(`
        INSERT INTO dr_working_cards (
          id, account_id, source_reflection_ids_json, title, content,
          card_kind, evidence_ids_json, status, importance, novelty,
          related_card_ids_json, tags_json, visibility, source_unavailable,
          saved_at, version, created_at, updated_at
        ) VALUES (
          'card_ai_review', 'account_1', '["reflection_ai_review"]',
          'title', 'content', 'insight', '["segment_ai_review"]', 'saved',
          0.8, 0.7, '[]', '[]', 'private', 0, ?, 1, ?, ?
        )
      `).run(timestamp, timestamp, timestamp);
      database.prepare(`
        INSERT INTO dr_ai_review_operations (
          id, account_id, scope, start_date, end_date, source_fingerprint,
          prompt_version, model, status, result_json, failure_code,
          claim_token, lease_until, attempt_version, provider_started_at,
          provider_input_tokens, provider_output_tokens, provider_total_tokens,
          created_at, updated_at, completed_at, seen_at
        ) VALUES (
          'review_ai', 'account_1', 'daily', '2026-09-01', '2026-09-01',
          ?, 'review-v1', 'gpt', 'ready', '{}', NULL, NULL, NULL, 1, ?,
          1, 2, 3, ?, ?, ?, NULL
        )
      `).run("a".repeat(64), timestamp, timestamp, timestamp, timestamp);
      database.prepare(`
        INSERT INTO dr_ai_review_source_links (
          account_id, review_id, source_id, reflection_id, card_id,
          evidence_id, position
        ) VALUES (
          'account_1', 'review_ai', 'source_ai', 'reflection_ai_review',
          'card_ai_review', 'segment_ai_review', 0
        )
      `).run();

      expect(() => database.prepare(`
        INSERT INTO dr_ai_review_source_links (
          account_id, review_id, source_id, reflection_id, card_id,
          evidence_id, position
        ) VALUES (
          'account_2', 'review_ai', 'bad_source', 'reflection_ai_review',
          'card_ai_review', 'bad_segment', 0
        )
      `).run()).toThrow(/FOREIGN KEY/u);
      database.prepare(`
        DELETE FROM dr_reflections
        WHERE account_id = 'account_1' AND id = 'reflection_ai_review'
      `).run();
      expect(database.prepare(`
        SELECT status, result_json, seen_at
        FROM dr_ai_review_operations WHERE id = 'review_ai'
      `).get()).toEqual({ status: "stale", result_json: null, seen_at: null });
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("backfills V9 Cards into additive Working Card snapshots without rewriting history", () => {
    const database = openDailyReflectionDatabase({ filePath: ":memory:" });
    try {
      database.exec(`
        DROP TABLE dr_working_card_memory_revocation_receipts;
        DROP TABLE dr_working_card_memory_revocation_operations;
        DROP TABLE dr_memory_proposal_events;
        DROP TABLE dr_memory_proposals;
        DROP TABLE dr_working_card_events;
        DROP TABLE dr_working_cards;
        DELETE FROM dr_schema_migrations WHERE version IN (10, 11, 12);
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
               evidence_ids_json, status, source_unavailable, saved_at,
               memory_lifecycle_status, memory_lifecycle_version
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
        saved_at: timestamp,
        memory_lifecycle_status: "not_admitted",
        memory_lifecycle_version: 0
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

  it("restores a missing V11 proposal ledger under the V12 Card lifecycle", () => {
    const database = openDailyReflectionDatabase({ filePath: ":memory:" });
    try {
      database.exec(`
        DROP TABLE dr_memory_proposal_events;
        DROP TABLE dr_memory_proposals;
        DELETE FROM dr_schema_migrations WHERE version = 11;
        PRAGMA user_version = 10;

        INSERT INTO dr_working_cards (
          id, account_id, source_reflection_ids_json, title, content, card_kind,
          evidence_ids_json, status, importance, novelty, related_card_ids_json,
          tags_json, visibility, source_unavailable, saved_at, version,
          created_at, updated_at
        ) VALUES (
          'card_v10_proposal', 'account_1', '["reflection_v10"]',
          'V10 title', 'V10 content', 'insight', '["segment_v10"]', 'saved',
          0.8, 0.7, '[]', '[]', 'private', 0, '${timestamp}', 3,
          '${timestamp}', '${timestamp}'
        );
      `);

      migrateDailyReflectionSchema(database);

      expect(database.prepare(
        "SELECT version FROM dr_schema_migrations ORDER BY version DESC LIMIT 2"
      ).all()).toEqual([{ version: 14 }, { version: 13 }]);
      expect(database.prepare(`
        SELECT id, title, content, status, version
        FROM dr_working_cards WHERE id = 'card_v10_proposal'
      `).get()).toEqual({
        id: "card_v10_proposal",
        title: "V10 title",
        content: "V10 content",
        status: "saved",
        version: 3
      });
      expect(database.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN (
          'dr_memory_proposals', 'dr_memory_proposal_events'
        ) ORDER BY name
      `).all()).toEqual([
        { name: "dr_memory_proposal_events" },
        { name: "dr_memory_proposals" }
      ]);
      expect((database.pragma("table_info(dr_memory_proposals)") as Array<{
        name: string;
      }>).map((column) => column.name)).toContain("memory_type_v2");
      expect((database.pragma("table_info(dr_admission_operations)") as Array<{
        name: string;
      }>).map((column) => column.name)).toContain("execution_method");
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("enforces the V11 proposal snapshot, uniqueness, status, and audit checks", () => {
    const database = openDailyReflectionDatabase({ filePath: ":memory:" });
    try {
      const insertCard = database.prepare(`
        INSERT INTO dr_working_cards (
          id, account_id, source_reflection_ids_json, title, content, card_kind,
          evidence_ids_json, status, importance, novelty, related_card_ids_json,
          tags_json, visibility, source_unavailable, saved_at, version,
          created_at, updated_at
        ) VALUES (
          ?, 'account_1', '["reflection_v11"]', 'Frozen title',
          'Frozen content', 'action', '["segment_v11"]', 'saved', 0.8, 0.7,
          '[]', '[]', 'private', 0, ?, 4, ?, ?
        )
      `);
      for (const cardId of [
        "card_valid",
        "card_same_operation",
        "card_bad_admitted",
        "card_bad_rejected",
        "card_bad_epistemic"
      ]) {
        insertCard.run(cardId, timestamp, timestamp, timestamp);
      }

      const insertProposal = database.prepare(`
        INSERT INTO dr_memory_proposals (
          id, account_id, card_id, reflection_id, title, card_kind,
          action_claimed, memory_type, content, evidence_ids_json,
          evidence_snapshots_json, risk_flags_json, subject_person_id,
          importance, durability, novelty, sensitivity, epistemic_status,
          epistemic_caution, status, policy_version, score, reasons_json,
          operation_key, request_fingerprint, memory_id, source_origin,
          input_adapter, capture_purpose, recording_date, created_by,
          admission_method, card_version, version, lease_owner, lease_until,
          attempt_version, error_code, created_at, updated_at, admitted_at
        ) VALUES (
          @id, 'account_1', @cardId, 'reflection_v11', 'Frozen title', 'action',
          1, 'commitment', 'Frozen content', '["segment_v11"]',
          '[{"sourceSegmentId":"segment_v11","uploadId":"upload_v11","startSeconds":0,"endSeconds":1,"effectiveOrigin":"user_reflection","contentDigest":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}]',
          '["sensitive"]', NULL, 0.8, 0.7, 0.6, 0.5, @epistemicStatus,
          'reported_inference', @status, 'proposal-policy-v1', 0.75,
          @reasons, @operationKey, @requestFingerprint, @memoryId,
          'user_reflection', 'file_picker', 'inspiration_capture', '2026-08-13',
          'user', 'daily_reflection_memory_proposal_v1', 4, 0, NULL, NULL,
          0, NULL, @createdAt, @updatedAt, @admittedAt
        )
      `);
      const valid = {
        id: "proposal_valid",
        cardId: "card_valid",
        epistemicStatus: "reported_event",
        status: "pending",
        reasons: JSON.stringify(["policy_score_passed"]),
        operationKey: "daily-reflection-card:card_valid",
        requestFingerprint: "a".repeat(64),
        memoryId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        admittedAt: null
      };
      expect(() => insertProposal.run(valid)).not.toThrow();
      expect(database.prepare(`
        SELECT title, card_kind, action_claimed, epistemic_status,
               epistemic_caution, card_version, attempt_version
        FROM dr_memory_proposals WHERE id = 'proposal_valid'
      `).get()).toEqual({
        title: "Frozen title",
        card_kind: "action",
        action_claimed: 1,
        epistemic_status: "reported_event",
        epistemic_caution: "reported_inference",
        card_version: 4,
        attempt_version: 0
      });

      expect(() => insertProposal.run({
        ...valid,
        id: "proposal_duplicate_card",
        operationKey: "daily-reflection-card:card_valid"
      })).toThrow(/UNIQUE/u);
      expect(() => insertProposal.run({
        ...valid,
        id: "proposal_duplicate_operation",
        cardId: "card_same_operation",
        operationKey: "daily-reflection-card:card_valid"
      })).toThrow(/CHECK constraint/u);
      expect(() => insertProposal.run({
        ...valid,
        id: "proposal_bad_admitted",
        cardId: "card_bad_admitted",
        operationKey: "daily-reflection-card:card_bad_admitted",
        status: "admitted"
      })).toThrow(/CHECK constraint/u);
      expect(() => insertProposal.run({
        ...valid,
        id: "proposal_bad_rejected",
        cardId: "card_bad_rejected",
        operationKey: "daily-reflection-card:card_bad_rejected",
        status: "rejected",
        reasons: "[]"
      })).toThrow(/CHECK constraint/u);
      expect(() => insertProposal.run({
        ...valid,
        id: "proposal_bad_epistemic",
        cardId: "card_bad_epistemic",
        operationKey: "daily-reflection-card:card_bad_epistemic",
        epistemicStatus: "reported_inference"
      })).toThrow(/CHECK constraint/u);

      expect(() => database.prepare(`
        INSERT INTO dr_memory_proposal_events (
          id, account_id, proposal_id, proposal_version, event_type,
          reason_metadata_json, created_at
        ) VALUES (?, 'account_1', 'proposal_valid', 0, ?, ?, ?)
      `).run(
        "event_created",
        "created",
        JSON.stringify({ reasonCode: "policy.created" }),
        timestamp
      )).not.toThrow();
      expect(() => database.prepare(`
        INSERT INTO dr_memory_proposal_events (
          id, account_id, proposal_id, proposal_version, event_type,
          reason_metadata_json, created_at
        ) VALUES (?, 'account_1', 'proposal_valid', 0, ?, '{}', ?)
      `).run("event_invalid", "receipt_replayed", timestamp))
        .toThrow(/CHECK constraint/u);
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(database.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      database.close();
    }
  });

  it("keeps the public proposal DTO strict and metadata-only", () => {
    const proposal = {
      id: "proposal_dto",
      cardId: "card_dto",
      reflectionId: "reflection_dto",
      accountId: "account_1",
      title: "确定性标题",
      cardKind: "insight",
      actionClaimed: false,
      memoryType: "preference",
      content: "用户明确认可的偏好",
      evidenceIds: ["segment_dto"],
      evidenceSnapshots: [{
        sourceSegmentId: "segment_dto",
        uploadId: "upload_dto",
        startSeconds: 1,
        endSeconds: 2,
        effectiveOrigin: "user_reflection"
      }],
      riskFlags: [],
      subjectPersonId: null,
      importance: 0.7,
      durability: 0.8,
      novelty: 0.6,
      sensitivity: 0.2,
      epistemicStatus: "reported_event",
      epistemicCaution: "reported_inference",
      status: "pending",
      policyVersion: "proposal-policy-v1",
      score: 0.75,
      reasons: ["policy_score_passed"],
      operationKey: "daily-reflection-card:card_dto",
      requestFingerprint: "b".repeat(64),
      memoryId: null,
      sourceOrigin: "user_reflection",
      inputAdapter: "file_picker",
      capturePurpose: "inspiration_capture",
      recordingDate: "2026-08-13",
      createdBy: "user",
      admissionMethod: "daily_reflection_memory_proposal_v1",
      cardVersion: 4,
      version: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      admittedAt: null
    } as const;

    expect(DailyReflectionMemoryProposalSchema.parse(proposal)).toEqual(proposal);
    expect(DailyReflectionMemoryProposalSchema.safeParse({
      ...proposal,
      epistemicStatus: "reported_inference"
    }).success).toBe(false);
    expect(DailyReflectionMemoryProposalSchema.safeParse({
      ...proposal,
      evidenceSnapshots: [{ ...proposal.evidenceSnapshots[0], text: "not public" }]
    }).success).toBe(false);
    expect(DailyReflectionMemoryProposalSchema.safeParse({
      ...proposal,
      status: "rejected",
      reasons: []
    }).success).toBe(false);
    expect(DailyReflectionMemoryProposalEventSchema.safeParse({
      id: "event_dto",
      proposalId: proposal.id,
      accountId: proposal.accountId,
      proposalVersion: 0,
      eventType: "evaluated",
      reasonMetadata: { reasonCode: "policy.accepted", transcript: "not allowed" },
      createdAt: timestamp
    }).success).toBe(false);
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
