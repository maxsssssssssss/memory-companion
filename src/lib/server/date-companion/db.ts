import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { getDataRootDir } from "@/lib/server/storage/paths";

import { migrateDateCompanionSchema } from "./schema";

type DateCompanionDatabaseGlobal = typeof globalThis & {
  __dailyBriefDateCompanionDatabase?: {
    filePath: string;
    database: Database.Database;
  };
};

export function getDateCompanionDatabasePath(dataRoot = getDataRootDir()) {
  return resolve(join(dataRoot, "date-companion.sqlite"));
}

export function openDateCompanionDatabase(input: { filePath?: string } = {}) {
  const filePath = input.filePath ?? getDateCompanionDatabasePath();
  if (filePath !== ":memory:") mkdirSync(dirname(filePath), { recursive: true });

  const database = new Database(filePath);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  if (filePath !== ":memory:") {
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = NORMAL");
  }
  migrateDateCompanionSchema(database);
  return database;
}

export function getDateCompanionDatabase() {
  const globalState = globalThis as DateCompanionDatabaseGlobal;
  const filePath = getDateCompanionDatabasePath();
  const existing = globalState.__dailyBriefDateCompanionDatabase;
  if (existing?.filePath === filePath && existing.database.open) return existing.database;
  if (existing?.database.open) existing.database.close();

  const database = openDateCompanionDatabase({ filePath });
  globalState.__dailyBriefDateCompanionDatabase = { filePath, database };
  return database;
}
