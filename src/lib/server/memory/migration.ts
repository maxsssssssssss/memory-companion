import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  AudioUploadSchema,
  BriefItemSchema,
  RelationshipSignalCardSchema,
  SemanticSegmentSchema,
  TranscriptSegmentSchema
} from "@/lib/domain/types";
import { JsonStore } from "@/lib/server/storage/json-store";
import { getDataRootDir } from "@/lib/server/storage/paths";
import { getMemoryDatabasePath, openMemoryDatabase } from "./db";
import { extractUploadMemoriesWithAudit } from "./extractor";
import { createMemoryRepository } from "./repository";
import type { MemoryRepository } from "./types";

const SAFE_USER_ID = /^[A-Za-z0-9_-]+$/;

export type MemoryMigrationResult = {
  usersScanned: number;
  uploadsScanned: number;
  uploadsIndexed: number;
  uploadsSkipped: number;
  uploadsFailed: number;
  memoriesIndexed: number;
};

type MigrationLogger = Pick<Console, "info" | "warn">;

async function listUserIds(dataRoot: string) {
  try {
    const entries = await readdir(join(dataRoot, "users"), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && SAFE_USER_ID.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readArray<TSchema extends z.ZodTypeAny>(
  store: JsonStore,
  collection: string,
  uploadId: string,
  schema: TSchema
): Promise<Array<z.output<TSchema>>> {
  const value = (await store.read<unknown>(collection, uploadId)) ?? [];
  return z.array(schema).parse(value);
}

export async function migrateLegacyMemoryIndex(input: {
  dataRoot?: string;
  repository?: MemoryRepository;
  logger?: MigrationLogger;
} = {}): Promise<MemoryMigrationResult> {
  const dataRoot = input.dataRoot ?? getDataRootDir();
  const logger = input.logger ?? console;
  const ownedDatabase = input.repository
    ? null
    : openMemoryDatabase({ filePath: getMemoryDatabasePath(dataRoot) });
  const repository = input.repository ?? createMemoryRepository(ownedDatabase!);
  const result: MemoryMigrationResult = {
    usersScanned: 0,
    uploadsScanned: 0,
    uploadsIndexed: 0,
    uploadsSkipped: 0,
    uploadsFailed: 0,
    memoriesIndexed: 0
  };

  try {
    const userIds = await listUserIds(dataRoot);
    result.usersScanned = userIds.length;

    for (const userId of userIds) {
      const store = new JsonStore(join(dataRoot, "users", userId));
      const uploadRecords = await store.list<unknown>("uploads");

      for (const record of uploadRecords) {
        result.uploadsScanned += 1;
        const parsedUpload = AudioUploadSchema.safeParse(record.value);
        if (!parsedUpload.success || parsedUpload.data.status !== "ready") {
          result.uploadsSkipped += 1;
          continue;
        }

        const upload = parsedUpload.data;
        try {
          const [segments, briefItems, semanticSegments, relationshipSignals] = await Promise.all([
            readArray(store, "segments", upload.id, TranscriptSegmentSchema),
            readArray(store, "brief-items", upload.id, BriefItemSchema),
            readArray(store, "semantic-segments", upload.id, SemanticSegmentSchema),
            readArray(store, "relationship-signals", upload.id, RelationshipSignalCardSchema)
          ]);
          const extraction = extractUploadMemoriesWithAudit({
            userId,
            uploadId: upload.id,
            recordingDate: upload.recordingDate,
            segments,
            briefItems,
            semanticSegments,
            relationshipSignals
          });

          repository.replaceUploadMemories({
            userId,
            uploadId: upload.id,
            sourceSegments: segments,
            memories: extraction.memories,
            ownerAttributions: extraction.ownerAttributions
          });
          result.uploadsIndexed += 1;
          result.memoriesIndexed += extraction.memories.length;
        } catch (error) {
          result.uploadsFailed += 1;
          logger.warn("[memory:migrate] upload skipped after validation/index failure", {
            userId,
            uploadId: upload.id,
            reason: error instanceof Error ? error.message : "unknown_error"
          });
        }
      }
    }

    logger.info("[memory:migrate] completed", result);
    return result;
  } finally {
    ownedDatabase?.close();
  }
}
