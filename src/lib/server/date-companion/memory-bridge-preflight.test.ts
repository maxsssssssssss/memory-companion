// @vitest-environment node

import Database from "better-sqlite3";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseDateCompanionMemoryBridgePreflightArgs
} from "../../../../scripts/date-companion-memory-bridge-preflight";
import { getMemoryDatabasePath, openMemoryDatabase } from "@/lib/server/memory/db";
import { MEMORY_SCHEMA_VERSION } from "@/lib/server/memory/schema";

import { getDateCompanionDatabasePath, openDateCompanionDatabase } from "./db";
import { DATE_COMPANION_SCHEMA_VERSION } from "./schema";
import {
  DateCompanionMemoryBridgePreflightConfigurationError,
  inspectDateCompanionMemoryBridgePreflight,
  migrateAndInspectDateCompanionMemoryBridge,
  resolveDateCompanionMemoryBridgePreflightDataDirectory
} from "./memory-bridge-preflight";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true
  })));
});

async function temporaryRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function createLatestDatabases(root: string) {
  const dateCompanion = openDateCompanionDatabase({
    filePath: getDateCompanionDatabasePath(root)
  });
  dateCompanion.close();
  const memory = openMemoryDatabase({
    filePath: getMemoryDatabasePath(root)
  });
  memory.close();
}

function createVersionFiveDateCompanionDatabase(root: string) {
  const database = new Database(getDateCompanionDatabasePath(root));
  database.exec(`
    CREATE TABLE dc_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    INSERT INTO dc_schema_migrations(version, applied_at) VALUES
      (1, '2026-08-01T00:00:00.000Z'),
      (2, '2026-08-02T00:00:00.000Z'),
      (3, '2026-08-03T00:00:00.000Z'),
      (4, '2026-08-04T00:00:00.000Z'),
      (5, '2026-08-05T00:00:00.000Z');
    CREATE TABLE dc_relationships (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      UNIQUE(id, user_id)
    );
    CREATE TABLE dc_interactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      relationship_id TEXT NOT NULL,
      source_upload_id TEXT NOT NULL,
      status TEXT NOT NULL,
      source_state TEXT NOT NULL,
      confirmation_fingerprint TEXT,
      UNIQUE(id, user_id)
    );
    CREATE TABLE dc_recap_items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      interaction_id TEXT NOT NULL,
      disposition TEXT NOT NULL,
      UNIQUE(id, user_id)
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
      UNIQUE(id, user_id),
      UNIQUE(user_id, recap_item_id, upload_id, source_segment_id)
    );
  `);
  database.close();
}

function createVersionEightMemoryDatabase(root: string) {
  const filePath = getMemoryDatabasePath(root);
  const latest = openMemoryDatabase({ filePath });
  latest.close();
  const database = new Database(filePath);
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
    DELETE FROM schema_migrations WHERE version >= 9;
  `);
  database.close();
}

describe("Date Companion Memory bridge preflight", () => {
  it("checks the current bridge schemas read-only without exposing the data path", async () => {
    const root = await temporaryRoot("memory-bridge-preflight-latest-");
    createLatestDatabases(root);

    const report = inspectDateCompanionMemoryBridgePreflight({
      dataDirectory: root,
      now: () => "2026-08-11T00:00:00.000Z"
    });

    expect(report).toMatchObject({
      ok: true,
      mode: "check",
      checkedAt: "2026-08-11T00:00:00.000Z",
      storage: { directoryVisible: true },
      dateCompanion: {
        visible: true,
        expectedSchemaVersion: DATE_COMPANION_SCHEMA_VERSION,
        schemaVersions: Array.from(
          { length: DATE_COMPANION_SCHEMA_VERSION },
          (_, index) => index + 1
        ),
        schemaStatus: "compatible",
        foreignKeyStatus: "ok",
        foreignKeyViolationCount: 0,
        integrityStatus: "ok",
        integrityIssueCount: 0
      },
      memory: {
        visible: true,
        expectedSchemaVersion: MEMORY_SCHEMA_VERSION,
        schemaVersions: Array.from({ length: MEMORY_SCHEMA_VERSION }, (_, index) => index + 1),
        schemaStatus: "compatible",
        foreignKeyStatus: "ok",
        integrityStatus: "ok"
      },
      migration: null,
      errorCodes: []
    });
    expect(JSON.stringify(report)).not.toContain(root);
  });

  it("does not create missing databases in check-only mode", async () => {
    const root = await temporaryRoot("memory-bridge-preflight-missing-");

    const report = inspectDateCompanionMemoryBridgePreflight({ dataDirectory: root });

    expect(report.ok).toBe(false);
    expect(report.errorCodes).toEqual(expect.arrayContaining([
      "date_companion_database_missing",
      "memory_database_missing"
    ]));
    expect(() => new Database(getDateCompanionDatabasePath(root), {
      readonly: true,
      fileMustExist: true
    })).toThrow();
    expect(() => new Database(getMemoryDatabasePath(root), {
      readonly: true,
      fileMustExist: true
    })).toThrow();
  });

  it("requires the exact migration sequence and never fills a gap while checking", async () => {
    const root = await temporaryRoot("memory-bridge-preflight-gap-");
    createLatestDatabases(root);
    const filePath = getDateCompanionDatabasePath(root);
    const database = new Database(filePath);
    database.prepare("DELETE FROM dc_schema_migrations WHERE version = 6").run();
    database.close();

    const report = inspectDateCompanionMemoryBridgePreflight({ dataDirectory: root });

    expect(report.dateCompanion).toMatchObject({
      schemaVersions: [1, 2, 3, 4, 5, 7, 8, 9, 10, 11],
      schemaStatus: "incompatible"
    });
    expect(report.errorCodes).toContain("date_companion_schema_incompatible");
    const inspector = new Database(filePath, { readonly: true, fileMustExist: true });
    expect(inspector.prepare(
      "SELECT version FROM dc_schema_migrations WHERE version = 6"
    ).get()).toBeUndefined();
    inspector.close();
  });

  it("reports foreign-key violations as counts without returning row details", async () => {
    const root = await temporaryRoot("memory-bridge-preflight-fk-");
    createLatestDatabases(root);
    const memory = new Database(getMemoryDatabasePath(root));
    memory.pragma("foreign_keys = OFF");
    memory.prepare(`
      INSERT INTO memory_evidence_provenance (
        memory_evidence_id, user_id, upload_id, source_segment_id,
        start_seconds, end_seconds, speaker_id, source_kind, origin,
        content_digest, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "missing_evidence",
      "user_a",
      "upload_a",
      "segment_a",
      0,
      1,
      null,
      "transcript",
      "date_companion_retention",
      "digest",
      "2026-08-11T00:00:00.000Z"
    );
    memory.close();

    const report = inspectDateCompanionMemoryBridgePreflight({ dataDirectory: root });

    expect(report.memory).toMatchObject({
      foreignKeyStatus: "violations",
      foreignKeyViolationCount: 1
    });
    expect(report.errorCodes).toContain("memory_foreign_key_violations");
    expect(JSON.stringify(report)).not.toContain("missing_evidence");
  });

  it("migrates a supported v5/v8 pair only in explicit migrate mode", async () => {
    const root = await temporaryRoot("memory-bridge-preflight-migrate-");
    createVersionFiveDateCompanionDatabase(root);
    createVersionEightMemoryDatabase(root);

    const before = inspectDateCompanionMemoryBridgePreflight({ dataDirectory: root });
    expect(before.dateCompanion.schemaVersions).toEqual([1, 2, 3, 4, 5]);
    expect(before.memory.schemaVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const after = migrateAndInspectDateCompanionMemoryBridge({ dataDirectory: root });

    expect(after).toMatchObject({
      ok: true,
      mode: "migrate",
      dateCompanion: {
        schemaVersions: Array.from(
          { length: DATE_COMPANION_SCHEMA_VERSION },
          (_, index) => index + 1
        ),
        schemaStatus: "compatible"
      },
      memory: {
        schemaVersions: Array.from({ length: MEMORY_SCHEMA_VERSION }, (_, index) => index + 1),
        schemaStatus: "compatible"
      },
      migration: {
        dateCompanion: "completed",
        memory: "completed"
      },
      errorCodes: []
    });
  });

  it("refuses migration before touching the visible database when its peer is missing", async () => {
    const root = await temporaryRoot("memory-bridge-preflight-refuse-");
    const filePath = getDateCompanionDatabasePath(root);
    const dateCompanion = openDateCompanionDatabase({ filePath });
    dateCompanion.prepare("DELETE FROM dc_schema_migrations WHERE version = 6").run();
    dateCompanion.close();

    const report = migrateAndInspectDateCompanionMemoryBridge({ dataDirectory: root });

    expect(report).toMatchObject({
      ok: false,
      mode: "migrate",
      migration: {
        dateCompanion: "not_started",
        memory: "not_started"
      }
    });
    expect(report.errorCodes).toContain("migration_refused_missing_database");
    const inspector = new Database(filePath, { readonly: true, fileMustExist: true });
    expect(inspector.prepare(
      "SELECT version FROM dc_schema_migrations WHERE version = 6"
    ).get()).toBeUndefined();
    inspector.close();
  });

  it("sanitizes corrupt database failures", async () => {
    const root = await temporaryRoot("memory-bridge-preflight-corrupt-");
    const dateCompanion = openDateCompanionDatabase({
      filePath: getDateCompanionDatabasePath(root)
    });
    dateCompanion.close();
    await writeFile(getMemoryDatabasePath(root), "not a sqlite database", "utf8");

    const report = inspectDateCompanionMemoryBridgePreflight({ dataDirectory: root });
    const serialized = JSON.stringify(report);

    expect(report.ok).toBe(false);
    expect(report.errorCodes.some((code) => code.startsWith("memory_"))).toBe(true);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("not a sqlite database");
    expect(serialized).not.toContain("SQLITE_");
  });

  it("enforces an absolute server APP_DATA_DIR and parses explicit migrate only", () => {
    const absolute = resolve("bridge-preflight-data");
    expect(resolveDateCompanionMemoryBridgePreflightDataDirectory({
      APP_DATA_DIR: absolute,
      APP_STORAGE_MODE: "server"
    })).toBe(absolute);
    expect(() => resolveDateCompanionMemoryBridgePreflightDataDirectory({
      APP_DATA_DIR: ".data",
      APP_STORAGE_MODE: "server"
    })).toThrowError(expect.objectContaining<Partial<DateCompanionMemoryBridgePreflightConfigurationError>>({
      code: "app_data_dir_must_be_absolute"
    }));
    expect(() => resolveDateCompanionMemoryBridgePreflightDataDirectory({
      APP_DATA_DIR: absolute,
      APP_STORAGE_MODE: "local"
    })).toThrowError(expect.objectContaining<Partial<DateCompanionMemoryBridgePreflightConfigurationError>>({
      code: "app_storage_mode_must_be_server"
    }));
    expect(() => resolveDateCompanionMemoryBridgePreflightDataDirectory({
      APP_DATA_DIR: resolve(process.cwd(), "release-data"),
      APP_STORAGE_MODE: "server",
      NODE_ENV: "production"
    }, {
      workingDirectory: process.cwd()
    })).toThrowError(expect.objectContaining({
      code: "app_data_dir_must_be_outside_release"
    }));
    expect(resolveDateCompanionMemoryBridgePreflightDataDirectory({
      APP_DATA_DIR: resolve(process.cwd(), "..", "persistent-data"),
      APP_STORAGE_MODE: "server",
      NODE_ENV: "production"
    }, {
      workingDirectory: process.cwd()
    })).toBe(resolve(process.cwd(), "..", "persistent-data"));
    expect(parseDateCompanionMemoryBridgePreflightArgs([])).toEqual({
      help: false,
      migrate: false
    });
    expect(parseDateCompanionMemoryBridgePreflightArgs(["--migrate"])).toEqual({
      help: false,
      migrate: true
    });
    expect(() => parseDateCompanionMemoryBridgePreflightArgs(["--unknown"]))
      .toThrowError(expect.objectContaining({ code: "preflight_argument_invalid" }));
  });
});
