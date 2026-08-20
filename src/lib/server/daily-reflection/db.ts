import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { getDataRootDir } from "@/lib/server/storage/paths";

import { migrateDailyReflectionSchema } from "./schema";

type DailyReflectionDatabaseGlobal = typeof globalThis & {
  __dailyBriefDailyReflectionDatabase?: {
    filePath: string;
    database: Database.Database;
  };
};

export function getDailyReflectionDatabasePath(dataRoot = getDataRootDir()) {
  return resolve(join(dataRoot, "daily-reflection.sqlite"));
}

export function openDailyReflectionDatabase(input: { filePath?: string } = {}) {
  const filePath = input.filePath ?? getDailyReflectionDatabasePath();
  if (filePath !== ":memory:") mkdirSync(dirname(filePath), { recursive: true });

  const database = new Database(filePath);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  if (filePath !== ":memory:") {
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = NORMAL");
  }
  migrateDailyReflectionSchema(database);
  return database;
}

export function getDailyReflectionDatabase() {
  const globalState = globalThis as DailyReflectionDatabaseGlobal;
  const filePath = getDailyReflectionDatabasePath();
  const existing = globalState.__dailyBriefDailyReflectionDatabase;
  if (existing?.filePath === filePath && existing.database.open) return existing.database;
  if (existing?.database.open) existing.database.close();

  const database = openDailyReflectionDatabase({ filePath });
  globalState.__dailyBriefDailyReflectionDatabase = { filePath, database };
  return database;
}
