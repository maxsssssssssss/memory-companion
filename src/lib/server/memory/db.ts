import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getDataRootDir } from "@/lib/server/storage/paths";
import { migrateMemorySchema } from "./schema";

type MemoryDatabaseGlobal = typeof globalThis & {
  __dailyBriefMemoryDatabase?: {
    filePath: string;
    database: Database.Database;
  };
};

export function getMemoryDatabasePath(dataRoot = getDataRootDir()) {
  return resolve(join(dataRoot, "memory.sqlite"));
}

export function openMemoryDatabase(input: { filePath?: string } = {}) {
  const filePath = input.filePath ?? getMemoryDatabasePath();

  if (filePath !== ":memory:") {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  const database = new Database(filePath);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  if (filePath !== ":memory:") {
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = NORMAL");
  }
  migrateMemorySchema(database);

  return database;
}

export function getMemoryDatabase() {
  const globalState = globalThis as MemoryDatabaseGlobal;
  const filePath = getMemoryDatabasePath();
  const existing = globalState.__dailyBriefMemoryDatabase;

  if (existing?.filePath === filePath && existing.database.open) {
    return existing.database;
  }

  if (existing?.database.open) {
    existing.database.close();
  }

  const database = openMemoryDatabase({ filePath });
  globalState.__dailyBriefMemoryDatabase = { filePath, database };
  return database;
}
