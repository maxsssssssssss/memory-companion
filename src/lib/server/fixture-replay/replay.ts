import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { AudioUpload } from "@/lib/domain/types";
import { extractUploadMemories } from "@/lib/server/memory/extractor";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import { createMemoryRepository } from "@/lib/server/memory/repository";
import type { MemoryItem } from "@/lib/server/memory/types";
import { processUpload } from "@/lib/server/pipeline/process-upload";
import { JsonStore } from "@/lib/server/storage/json-store";

import { buildFixtureTranscriptSegments, fixtureUploadId, loadFixtureDataset } from "./dataset";
import { evaluateFixtureReplay, type FixtureDayReplayResult } from "./evaluation";
import { createFixtureTranscriptionProvider, fixtureReplayProviders } from "./providers";
import { resetFixtureReplayUser } from "./reset";

export type ReplayMemoryFixturesInput = {
  datasetPath: string;
  userId: string;
  fromDay?: number;
  toDay?: number;
  resetUser?: boolean;
  reportPath?: string;
  failFast?: boolean;
  dataRoot?: string;
  memoryDatabasePath?: string;
  preserveAnalysisCheckpointsOnReset?: boolean;
  logger?: Pick<Console, "info" | "warn" | "error">;
};

const SAFE_USER_ID = /^[A-Za-z0-9_-]+$/;

export function assertFixtureReplayEnvironment(nodeEnv: string | undefined) {
  if (nodeEnv !== "development" && nodeEnv !== "test") {
    throw new Error("Memory fixture replay is only available in development or test");
  }
}

function selectSessions<T>(sessions: T[], fromDay?: number, toDay?: number) {
  const start = fromDay ?? 1;
  const end = toDay ?? sessions.length;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > sessions.length) {
    throw new Error(`Invalid day range: ${start}-${end}`);
  }
  return sessions.slice(start - 1, end);
}

function memoryEvidenceCount(memory: MemoryItem) {
  return memory.evidence.length;
}

async function withNetworkDisabled<T>(run: () => Promise<T>) {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    throw new Error("Network access is disabled during memory fixture replay");
  }) as typeof fetch;
  try {
    const value = await run();
    return { value, attempts };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function deterministicNow(recordedAt: string) {
  const value = new Date(recordedAt);
  if (Number.isNaN(value.getTime())) {
    throw new Error(`Invalid recordedAt: ${recordedAt}`);
  }
  return value.toISOString();
}

function memoryChanges(before: MemoryItem[], after: MemoryItem[]) {
  const beforeById = new Map(before.map((memory) => [memory.id, memory] as const));
  const addedMemoryIds = after.filter((memory) => !beforeById.has(memory.id)).map((memory) => memory.id);
  const updatedMemoryIds = after
    .filter((memory) => {
      const previous = beforeById.get(memory.id);
      return previous && (
        previous.occurrenceCount !== memory.occurrenceCount ||
        memoryEvidenceCount(previous) !== memoryEvidenceCount(memory) ||
        previous.status !== memory.status
      );
    })
    .map((memory) => memory.id);
  return { addedMemoryIds, updatedMemoryIds };
}

export async function replayMemoryFixtures(input: ReplayMemoryFixturesInput) {
  assertFixtureReplayEnvironment(process.env.NODE_ENV);
  if (!SAFE_USER_ID.test(input.userId)) {
    throw new Error("Fixture replay user must contain only letters, numbers, underscores, or hyphens");
  }
  const logger = input.logger ?? console;
  const dataset = await loadFixtureDataset(input.datasetPath);
  const sessions = selectSessions(dataset.manifest.sessions, input.fromDay, input.toDay)
    .slice()
    .sort((left, right) => left.date.localeCompare(right.date) || left.sessionId.localeCompare(right.sessionId));
  const dataRoot = resolve(input.dataRoot ?? ".data");
  const store = new JsonStore(join(dataRoot, "users", input.userId));
  const databasePath = input.memoryDatabasePath ?? join(dataRoot, "memory.sqlite");
  const database = openMemoryDatabase({ filePath: databasePath });
  const repository = createMemoryRepository(database);
  const allUploadIds = dataset.manifest.sessions.map((session) => fixtureUploadId(session.sessionId));
  const reportPath = resolve(input.reportPath ?? join(dataRoot, "evaluation", `${dataset.manifest.datasetVersion}-report.json`));
  const startedAt = new Date().toISOString();

  try {
    if (input.resetUser) {
      const reset = await resetFixtureReplayUser({
        userId: input.userId,
        uploadIds: allUploadIds,
        store,
        database,
        preserveAnalysisCheckpoints: input.preserveAnalysisCheckpointsOnReset
      });
      logger.info(
        `[fixture-replay] reset user=${input.userId} before_memories=${reset.before.memoryItems} before_evidence=${reset.before.memoryEvidence} before_relations=${reset.before.memoryRelations} before_artifacts=${reset.before.fixtureArtifacts}`
      );
    }

    const guarded = await withNetworkDisabled(async () => {
      const dayResults: FixtureDayReplayResult[] = [];
      for (const [index, session] of sessions.entries()) {
        const segments = await buildFixtureTranscriptSegments({ dataset, session });
        const uploadId = fixtureUploadId(session.sessionId);
        const before = repository.getRelevantMemories({ userId: input.userId, limit: 10_000 });
        const beforeRelations = repository.getMemoryRelations(input.userId);
        const now = deterministicNow(session.recordedAt);
        const durationSeconds = segments.at(-1)?.endSeconds ?? 1;
        const upload: AudioUpload & { filePath: string } = {
          id: uploadId,
          originalName: session.transcriptFile.split(/[\\/]/u).at(-1) ?? `${session.sessionId}.txt`,
          mimeType: "application/x-memory-fixture-transcript",
          sizeBytes: Math.max(1, Buffer.byteLength(segments.map((segment) => segment.text).join("\n"), "utf8")),
          recordingDate: session.date,
          createdAt: now,
          durationSeconds,
          status: "uploaded",
          filePath: join(dataRoot, "fixture-artifacts", input.userId, `${uploadId}.fixture`)
        };
        await store.delete("deleted-uploads", uploadId);
        await store.write("uploads", uploadId, upload);
        logger.info(`[fixture-replay] day=${index + 1}/${sessions.length} session=${session.sessionId} date=${session.date} start`);

        const result = await processUpload({
          uploadId,
          store,
          userId: input.userId,
          memoryRepository: repository,
          dependencies: {
            ...fixtureReplayProviders,
            transcriptionProvider: createFixtureTranscriptionProvider(segments),
            now: () => now
          }
        });
        const after = repository.getRelevantMemories({ userId: input.userId, limit: 10_000 });
        const afterRelations = repository.getMemoryRelations(input.userId);
        const memoryCandidates = extractUploadMemories({
          userId: input.userId,
          uploadId,
          recordingDate: session.date,
          segments: result.segments,
          briefItems: result.briefItems,
          semanticSegments: result.semanticSegments,
          relationshipSignals: result.relationshipSignals,
          now
        }).length;
        const changes = memoryChanges(before, after);
        const dayResult: FixtureDayReplayResult = {
          sessionId: session.sessionId,
          uploadId,
          recordingDate: session.date,
          status: result.job.status,
          transcriptSegments: result.segments.length,
          speakers: new Set(result.segments.map((segment) => segment.speaker).filter(Boolean)).size,
          audioInsights: result.audioInsights.length,
          semanticSegments: result.semanticSegments.length,
          briefItems: result.briefItems.length,
          relationshipSignals: result.relationshipSignals.length,
          proactiveInsights: result.proactiveInsights.length,
          memoryCandidates,
          ...changes,
          dedupMerged: Math.max(0, before.length + memoryCandidates - after.length),
          relationCount: afterRelations.length
        };
        dayResults.push(dayResult);
        logger.info(
          `[fixture-replay] session=${session.sessionId} status=${dayResult.status} brief=${dayResult.briefItems} signals=${dayResult.relationshipSignals} memory_added=${dayResult.addedMemoryIds.length} memory_updated=${dayResult.updatedMemoryIds.length} dedup=${dayResult.dedupMerged} relations=${dayResult.relationCount} proactive=${dayResult.proactiveInsights}`
        );
        if (input.failFast && result.job.status !== "ready") {
          throw new Error(`Fixture replay failed for ${session.sessionId}`);
        }
        if (afterRelations.length < beforeRelations.length && !input.resetUser) {
          logger.warn(`[fixture-replay] relation count decreased after ${session.sessionId}; index was rebuilt deterministically`);
        }
      }
      return dayResults;
    });

    if (guarded.attempts > 0) {
      throw new Error(`Fixture replay attempted network access ${guarded.attempts} time(s)`);
    }
    const finishedAt = new Date().toISOString();
    const orphanEvidenceCount = Number((database.prepare(`
      SELECT COUNT(*) AS count
      FROM memory_evidence e
      LEFT JOIN memory_items m ON m.id = e.memory_id
      WHERE m.id IS NULL
    `).get() as { count: number }).count);
    const report = await evaluateFixtureReplay({
      dataset,
      sessions,
      userId: input.userId,
      store,
      repository,
      dayResults: guarded.value,
      networkAttempts: guarded.attempts,
      orphanEvidenceCount,
      startedAt,
      finishedAt
    });
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
    logger.info(`[fixture-replay] report=${reportPath} pass=${report.pass} digest=${report.deterministicDigest}`);
    return { report, reportPath };
  } finally {
    database.close();
  }
}
