import type Database from "better-sqlite3";

import type { JsonStore } from "@/lib/server/storage/json-store";
import { JsonAnalysisChunkCheckpointStore } from "@/lib/server/analysis-chunks/checkpoint";

const uploadOwnedCollections = [
  "uploads",
  "jobs-by-upload",
  "segments",
  "audio-insights",
  "semantic-segments",
  "brief-items",
  "relationship-signals",
  "relationship-lifecycle",
  "memory-owner-audits",
  "deleted-uploads"
] as const;

export type FixtureResetCounts = {
  memoryItems: number;
  memoryEvidence: number;
  memoryRelations: number;
  fixtureArtifacts: number;
};

function memoryCounts(database: Database.Database, userId: string) {
  const memoryItems = (database.prepare(
    "SELECT COUNT(*) AS count FROM memory_items WHERE user_id = ?"
  ).get(userId) as { count: number }).count;
  const memoryEvidence = (database.prepare(`
    SELECT COUNT(*) AS count
    FROM memory_evidence evidence
    INNER JOIN memory_items memory ON memory.id = evidence.memory_id
    WHERE memory.user_id = ?
  `).get(userId) as { count: number }).count;
  const memoryRelations = (database.prepare(`
    SELECT COUNT(*) AS count
    FROM memory_relations relation
    INNER JOIN memory_items source ON source.id = relation.source_memory_id
    WHERE source.user_id = ?
  `).get(userId) as { count: number }).count;
  return { memoryItems, memoryEvidence, memoryRelations };
}

async function countFixtureArtifacts(store: JsonStore, userId: string, uploadIds: Set<string>) {
  let count = 0;
  for (const collection of uploadOwnedCollections) {
    const records = await store.list<unknown>(collection);
    count += records.filter((record) => uploadIds.has(record.id)).length;
  }
  const proactive = await store.list<unknown>("proactive-insights");
  count += proactive.filter((record) =>
    record.id.startsWith("current_") && uploadIds.has(record.id.slice("current_".length))
  ).length;
  const jobs = await store.list<{ uploadId?: string }>("jobs");
  count += jobs.filter((record) => record.value.uploadId && uploadIds.has(record.value.uploadId)).length;
  const checkpoints = new JsonAnalysisChunkCheckpointStore(store);
  for (const uploadId of uploadIds) {
    count += (await checkpoints.list({ userId, uploadId })).length;
  }
  return count;
}

export async function countFixtureReplayUserData(input: {
  userId: string;
  uploadIds: string[];
  store: JsonStore;
  database: Database.Database;
}): Promise<FixtureResetCounts> {
  const uploadIds = new Set(input.uploadIds);
  return {
    ...memoryCounts(input.database, input.userId),
    fixtureArtifacts: await countFixtureArtifacts(input.store, input.userId, uploadIds)
  };
}

export async function resetFixtureReplayUser(input: {
  userId: string;
  uploadIds: string[];
  store: JsonStore;
  database: Database.Database;
  preserveAnalysisCheckpoints?: boolean;
}) {
  const before = await countFixtureReplayUserData(input);
  const uploadIds = new Set(input.uploadIds);

  input.database.transaction(() => {
    input.database.prepare("DELETE FROM memory_items WHERE user_id = ?").run(input.userId);
  })();

  for (const collection of uploadOwnedCollections) {
    const records = await input.store.list<unknown>(collection);
    for (const record of records) {
      if (uploadIds.has(record.id)) {
        await input.store.delete(collection, record.id);
      }
    }
  }
  const proactive = await input.store.list<unknown>("proactive-insights");
  for (const record of proactive) {
    if (record.id.startsWith("current_") && uploadIds.has(record.id.slice("current_".length))) {
      await input.store.delete("proactive-insights", record.id);
    }
  }
  const jobs = await input.store.list<{ uploadId?: string }>("jobs");
  for (const record of jobs) {
    if (record.value.uploadId && uploadIds.has(record.value.uploadId)) {
      await input.store.delete("jobs", record.id);
    }
  }
  if (!input.preserveAnalysisCheckpoints) {
    const checkpoints = new JsonAnalysisChunkCheckpointStore(input.store);
    for (const uploadId of uploadIds) {
      await checkpoints.deleteUpload(input.userId, uploadId);
    }
  }

  const after = await countFixtureReplayUserData(input);
  return { before, after };
}
