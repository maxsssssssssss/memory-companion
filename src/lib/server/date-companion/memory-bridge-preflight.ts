import Database from "better-sqlite3";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import {
  getDateCompanionDatabasePath
} from "@/lib/server/date-companion/db";
import {
  DATE_COMPANION_SCHEMA_VERSION,
  migrateDateCompanionSchema
} from "@/lib/server/date-companion/schema";
import { getMemoryDatabasePath } from "@/lib/server/memory/db";
import {
  MEMORY_SCHEMA_VERSION,
  migrateMemorySchema
} from "@/lib/server/memory/schema";

export type DateCompanionMemoryBridgeSchemaStatus =
  | "compatible"
  | "incompatible"
  | "unreadable"
  | "not_checked";

export type DateCompanionMemoryBridgeForeignKeyStatus =
  | "ok"
  | "violations"
  | "unreadable"
  | "not_checked";

export type DateCompanionMemoryBridgeIntegrityStatus =
  | "ok"
  | "failed"
  | "unreadable"
  | "not_checked";

export type DateCompanionMemoryBridgeDatabasePreflight = {
  visible: boolean;
  expectedSchemaVersion: number;
  schemaVersions: number[];
  schemaStatus: DateCompanionMemoryBridgeSchemaStatus;
  foreignKeyStatus: DateCompanionMemoryBridgeForeignKeyStatus;
  foreignKeyViolationCount: number | null;
  integrityStatus: DateCompanionMemoryBridgeIntegrityStatus;
  integrityIssueCount: number | null;
};

export type DateCompanionMemoryBridgeMigrationStatus =
  | "not_started"
  | "completed"
  | "failed";

export type DateCompanionMemoryBridgePreflightResult = {
  ok: boolean;
  mode: "check" | "migrate";
  checkedAt: string;
  storage: {
    directoryVisible: boolean;
  };
  dateCompanion: DateCompanionMemoryBridgeDatabasePreflight;
  memory: DateCompanionMemoryBridgeDatabasePreflight;
  migration: null | {
    dateCompanion: DateCompanionMemoryBridgeMigrationStatus;
    memory: DateCompanionMemoryBridgeMigrationStatus;
  };
  errorCodes: string[];
};

export type DateCompanionMemoryBridgePreflightInput = {
  dataDirectory: string;
  now?: () => string;
};

export class DateCompanionMemoryBridgePreflightConfigurationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DateCompanionMemoryBridgePreflightConfigurationError";
  }
}

export type DateCompanionMemoryBridgeStorageResolutionOptions = {
  workingDirectory?: string;
  nodeEnv?: string;
  platform?: NodeJS.Platform;
};

type ManagedDatabase = "date_companion" | "memory";
type FileVisibility = "visible" | "missing" | "invalid" | "unreadable";

function expectedVersions(latest: number) {
  return Array.from({ length: latest }, (_, index) => index + 1);
}

function sameVersions(actual: number[], expected: number[]) {
  return actual.length === expected.length
    && actual.every((version, index) => version === expected[index]);
}

function isSupportedMigrationPrefix(actual: number[], expected: number[]) {
  return actual.length > 0
    && actual.length <= expected.length
    && actual.every((version, index) => version === expected[index]);
}

function inspectFile(path: string): FileVisibility {
  try {
    return statSync(path).isFile() ? "visible" : "invalid";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "missing";
    }
    return "unreadable";
  }
}

function inspectDirectory(path: string): FileVisibility {
  try {
    return statSync(path).isDirectory() ? "visible" : "invalid";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "missing";
    }
    return "unreadable";
  }
}

function emptyDatabasePreflight(
  expectedSchemaVersion: number
): DateCompanionMemoryBridgeDatabasePreflight {
  return {
    visible: false,
    expectedSchemaVersion,
    schemaVersions: [],
    schemaStatus: "not_checked",
    foreignKeyStatus: "not_checked",
    foreignKeyViolationCount: null,
    integrityStatus: "not_checked",
    integrityIssueCount: null
  };
}

function databaseErrorCode(database: ManagedDatabase, suffix: string) {
  return `${database}_${suffix}`;
}

function inspectManagedDatabase(input: {
  database: ManagedDatabase;
  filePath: string;
  migrationTable: "dc_schema_migrations" | "schema_migrations";
  expectedSchemaVersion: number;
}) {
  const result = emptyDatabasePreflight(input.expectedSchemaVersion);
  const errorCodes: string[] = [];
  const visibility = inspectFile(input.filePath);
  if (visibility !== "visible") {
    errorCodes.push(databaseErrorCode(input.database, `database_${visibility}`));
    return { result, errorCodes };
  }
  result.visible = true;

  let database: Database.Database | undefined;
  try {
    database = new Database(input.filePath, {
      readonly: true,
      fileMustExist: true
    });
    database.pragma("query_only = ON");
    database.pragma("busy_timeout = 5000");
  } catch {
    result.schemaStatus = "unreadable";
    result.foreignKeyStatus = "unreadable";
    result.integrityStatus = "unreadable";
    errorCodes.push(databaseErrorCode(input.database, "database_open_failed"));
    database?.close();
    return { result, errorCodes };
  }

  try {
    try {
      const rows = database.prepare(
        `SELECT version FROM ${input.migrationTable} ORDER BY version`
      ).all() as Array<{ version: unknown }>;
      const versions = rows.map((row) => row.version);
      if (!versions.every((version): version is number =>
        Number.isSafeInteger(version) && Number(version) > 0
      )) {
        result.schemaStatus = "unreadable";
        errorCodes.push(databaseErrorCode(input.database, "schema_unreadable"));
      } else {
        result.schemaVersions = versions;
        const compatible = sameVersions(
          versions,
          expectedVersions(input.expectedSchemaVersion)
        );
        result.schemaStatus = compatible ? "compatible" : "incompatible";
        if (!compatible) {
          errorCodes.push(databaseErrorCode(input.database, "schema_incompatible"));
        }
      }
    } catch {
      result.schemaStatus = "unreadable";
      errorCodes.push(databaseErrorCode(input.database, "schema_unreadable"));
    }

    try {
      const violations = database.pragma("foreign_key_check") as unknown[];
      result.foreignKeyViolationCount = violations.length;
      result.foreignKeyStatus = violations.length === 0 ? "ok" : "violations";
      if (violations.length > 0) {
        errorCodes.push(databaseErrorCode(input.database, "foreign_key_violations"));
      }
    } catch {
      result.foreignKeyStatus = "unreadable";
      errorCodes.push(databaseErrorCode(input.database, "foreign_key_check_failed"));
    }

    try {
      const rows = database.pragma("integrity_check") as Array<Record<string, unknown>>;
      const integrityOk = rows.length === 1 && Object.values(rows[0] ?? {})[0] === "ok";
      result.integrityIssueCount = integrityOk ? 0 : Math.max(1, rows.length);
      result.integrityStatus = integrityOk ? "ok" : "failed";
      if (!integrityOk) {
        errorCodes.push(databaseErrorCode(input.database, "integrity_failed"));
      }
    } catch {
      result.integrityStatus = "unreadable";
      errorCodes.push(databaseErrorCode(input.database, "integrity_check_failed"));
    }
  } finally {
    database.close();
  }

  return { result, errorCodes };
}

function uniqueCodes(codes: string[]) {
  return Array.from(new Set(codes));
}

function inspectAt(
  dataDirectory: string,
  checkedAt: string
): DateCompanionMemoryBridgePreflightResult {
  const directoryVisibility = inspectDirectory(dataDirectory);
  const storageErrors = directoryVisibility === "visible"
    ? []
    : [`data_directory_${directoryVisibility}`];
  const dateCompanion = inspectManagedDatabase({
    database: "date_companion",
    filePath: getDateCompanionDatabasePath(dataDirectory),
    migrationTable: "dc_schema_migrations",
    expectedSchemaVersion: DATE_COMPANION_SCHEMA_VERSION
  });
  const memory = inspectManagedDatabase({
    database: "memory",
    filePath: getMemoryDatabasePath(dataDirectory),
    migrationTable: "schema_migrations",
    expectedSchemaVersion: MEMORY_SCHEMA_VERSION
  });
  const errorCodes = uniqueCodes([
    ...storageErrors,
    ...dateCompanion.errorCodes,
    ...memory.errorCodes
  ]);
  return {
    ok: errorCodes.length === 0,
    mode: "check",
    checkedAt,
    storage: {
      directoryVisible: directoryVisibility === "visible"
    },
    dateCompanion: dateCompanion.result,
    memory: memory.result,
    migration: null,
    errorCodes
  };
}

function checkedAt(now?: () => string) {
  const value = now?.() ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(value))) {
    throw new DateCompanionMemoryBridgePreflightConfigurationError(
      "preflight_now_invalid"
    );
  }
  return value;
}

export function resolveDateCompanionMemoryBridgePreflightDataDirectory(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: DateCompanionMemoryBridgeStorageResolutionOptions = {}
) {
  const configured = env.APP_DATA_DIR?.trim();
  if (!configured || !isAbsolute(configured)) {
    throw new DateCompanionMemoryBridgePreflightConfigurationError(
      "app_data_dir_must_be_absolute"
    );
  }
  if (env.APP_STORAGE_MODE?.trim().toLowerCase() !== "server") {
    throw new DateCompanionMemoryBridgePreflightConfigurationError(
      "app_storage_mode_must_be_server"
    );
  }
  const dataDirectory = resolve(configured);
  const nodeEnv = options.nodeEnv ?? env.NODE_ENV ?? process.env.NODE_ENV;
  if (nodeEnv?.trim().toLowerCase() === "production") {
    const platform = options.platform ?? process.platform;
    const canonical = (path: string) => {
      let value: string;
      try {
        value = realpathSync.native(path);
      } catch {
        value = resolve(path);
      }
      return platform === "win32" ? value.toLowerCase() : value;
    };
    const workingDirectory = canonical(options.workingDirectory ?? process.cwd());
    const candidate = canonical(dataDirectory);
    const fromWorkingDirectory = relative(workingDirectory, candidate);
    const parentPrefix = platform === "win32" ? "..\\" : "../";
    const insideRelease = fromWorkingDirectory === ""
      || (
        fromWorkingDirectory !== ".."
        && !fromWorkingDirectory.startsWith(parentPrefix)
        && !isAbsolute(fromWorkingDirectory)
      );
    if (insideRelease) {
      throw new DateCompanionMemoryBridgePreflightConfigurationError(
        "app_data_dir_must_be_outside_release"
      );
    }
  }
  return dataDirectory;
}

/** Strictly read-only: it never creates a directory, database, table, or migration. */
export function inspectDateCompanionMemoryBridgePreflight(
  input: DateCompanionMemoryBridgePreflightInput
) {
  return inspectAt(resolve(input.dataDirectory), checkedAt(input.now));
}

function migrationReady(
  database: DateCompanionMemoryBridgeDatabasePreflight
) {
  return database.visible
    && isSupportedMigrationPrefix(
      database.schemaVersions,
      expectedVersions(database.expectedSchemaVersion)
    )
    && database.foreignKeyStatus === "ok"
    && database.integrityStatus === "ok";
}

function withMigrationResult(
  report: DateCompanionMemoryBridgePreflightResult,
  migration: NonNullable<DateCompanionMemoryBridgePreflightResult["migration"]>,
  additionalErrors: string[] = []
): DateCompanionMemoryBridgePreflightResult {
  const errorCodes = uniqueCodes([...report.errorCodes, ...additionalErrors]);
  return {
    ...report,
    ok: errorCodes.length === 0
      && migration.dateCompanion === "completed"
      && migration.memory === "completed",
    mode: "migrate",
    migration,
    errorCodes
  };
}

function migrateDatabase(input: {
  filePath: string;
  migrate(database: Database.Database): void;
}) {
  const database = new Database(input.filePath, { fileMustExist: true });
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = NORMAL");
    input.migrate(database);
  } finally {
    database.close();
  }
}

/** Mutating counterpart for a reviewed maintenance window only. */
export function migrateAndInspectDateCompanionMemoryBridge(
  input: DateCompanionMemoryBridgePreflightInput
): DateCompanionMemoryBridgePreflightResult {
  const dataDirectory = resolve(input.dataDirectory);
  const timestamp = checkedAt(input.now);
  const before = inspectAt(dataDirectory, timestamp);
  const migration: NonNullable<DateCompanionMemoryBridgePreflightResult["migration"]> = {
    dateCompanion: "not_started",
    memory: "not_started"
  };

  if (!before.dateCompanion.visible || !before.memory.visible) {
    return withMigrationResult(before, migration, ["migration_refused_missing_database"]);
  }
  if (
    !before.storage.directoryVisible
    || !migrationReady(before.dateCompanion)
    || !migrationReady(before.memory)
  ) {
    return withMigrationResult(before, migration, ["migration_refused_preflight_failed"]);
  }

  try {
    migrateDatabase({
      filePath: getDateCompanionDatabasePath(dataDirectory),
      migrate: migrateDateCompanionSchema
    });
    migration.dateCompanion = "completed";
  } catch (error) {
    migration.dateCompanion = "failed";
    const code = error instanceof Error
      && (
        error.message === "date_companion_evidence_digest_conflict"
        || error.message === "date_companion_evidence_source_conflict"
      )
      ? error.message
      : "date_companion_migration_failed";
    return withMigrationResult(inspectAt(dataDirectory, timestamp), migration, [code]);
  }

  try {
    migrateDatabase({
      filePath: getMemoryDatabasePath(dataDirectory),
      migrate: migrateMemorySchema
    });
    migration.memory = "completed";
  } catch {
    migration.memory = "failed";
    return withMigrationResult(
      inspectAt(dataDirectory, timestamp),
      migration,
      ["memory_migration_failed"]
    );
  }

  return withMigrationResult(inspectAt(dataDirectory, timestamp), migration);
}
