import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { getDataRootDir } from "@/lib/server/storage/paths";

import { migrateWorkReviewSchema } from "./schema";

type WorkReviewDatabaseGlobal = typeof globalThis & {
  __dailyBriefWorkReviewDatabase?: {
    filePath: string;
    database: Database.Database;
  };
};

export function getWorkReviewDatabasePath(dataRoot = getDataRootDir()) {
  return resolve(join(dataRoot, "work-review.sqlite"));
}

export function openWorkReviewDatabase(input: { filePath?: string } = {}) {
  const filePath = input.filePath ?? getWorkReviewDatabasePath();
  if (filePath !== ":memory:") mkdirSync(dirname(filePath), { recursive: true });

  const database = new Database(filePath);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  if (filePath !== ":memory:") {
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = NORMAL");
  }
  migrateWorkReviewSchema(database);
  return database;
}

export function getWorkReviewDatabase() {
  const globalState = globalThis as WorkReviewDatabaseGlobal;
  const filePath = getWorkReviewDatabasePath();
  const existing = globalState.__dailyBriefWorkReviewDatabase;
  if (existing?.filePath === filePath && existing.database.open) {
    return existing.database;
  }
  if (existing?.database.open) existing.database.close();

  const database = openWorkReviewDatabase({ filePath });
  globalState.__dailyBriefWorkReviewDatabase = { filePath, database };
  return database;
}
