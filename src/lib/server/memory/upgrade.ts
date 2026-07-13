import type Database from "better-sqlite3";
import { getMemoryDatabasePath, openMemoryDatabase } from "./db";
import { createMemoryRepository } from "./repository";

export type MemoryUpgradeResult = {
  usersProcessed: number;
  memoriesBefore: number;
  memoriesAfter: number;
  duplicatesMerged: number;
  relations: number;
  failures: number;
};

type UpgradeLogger = Pick<Console, "info" | "warn">;

export async function upgradeMemoryIndex(input: {
  database?: Database.Database;
  filePath?: string;
  logger?: UpgradeLogger;
} = {}): Promise<MemoryUpgradeResult> {
  const logger = input.logger ?? console;
  const ownedDatabase = input.database
    ? null
    : openMemoryDatabase({ filePath: input.filePath ?? getMemoryDatabasePath() });
  const database = input.database ?? ownedDatabase!;
  const repository = createMemoryRepository(database);
  const result: MemoryUpgradeResult = {
    usersProcessed: 0,
    memoriesBefore: 0,
    memoriesAfter: 0,
    duplicatesMerged: 0,
    relations: 0,
    failures: 0
  };

  try {
    for (const userId of repository.getUserIds()) {
      try {
        const userResult = repository.rebuildUserMemories(userId);
        result.usersProcessed += 1;
        result.memoriesBefore += userResult.inputCount;
        result.memoriesAfter += userResult.memoryCount;
        result.duplicatesMerged += userResult.mergedCount;
        result.relations += userResult.relationCount;
      } catch (error) {
        result.failures += 1;
        logger.warn("[memory:upgrade] user upgrade failed", {
          userId,
          reason: error instanceof Error ? error.message : "unknown_error"
        });
      }
    }

    logger.info("[memory:upgrade] completed", result);
    return result;
  } finally {
    ownedDatabase?.close();
  }
}
