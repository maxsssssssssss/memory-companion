import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openMemoryDatabase } from "@/lib/server/memory/db";
import { createMemoryRepository } from "@/lib/server/memory/repository";
import { JsonStore } from "@/lib/server/storage/json-store";
import {
  JsonAnalysisChunkCheckpointStore,
  executeWithAnalysisCheckpoint,
  fingerprintAnalysisInput
} from "@/lib/server/analysis-chunks/checkpoint";
import { z } from "zod";

import { resetFixtureReplayUser } from "./reset";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

function memoryInput(id: string, uploadId: string, date: string) {
  return {
    id,
    type: "event" as const,
    title: id,
    summary: `${id} completed`,
    importance: 0.5,
    date,
    createdAt: `${date}T00:00:00.000Z`,
    updatedAt: `${date}T00:00:00.000Z`,
    evidence: [{
      id: `${id}_evidence`,
      sourceType: "transcript" as const,
      sourceId: `${uploadId}_seg_01`,
      uploadId,
      date,
      quote: id,
      createdAt: `${date}T00:00:00.000Z`
    }]
  };
}

describe("fixture replay reset", () => {
  it("only deletes the selected user and fixture upload artifacts", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "fixture-reset-"));
    const database = openMemoryDatabase({ filePath: join(tempDir, "memory.sqlite") });
    const repository = createMemoryRepository(database);
    const selectedStore = new JsonStore(join(tempDir, "users", "memory-eval-user"));
    const otherStore = new JsonStore(join(tempDir, "users", "other-user"));
    const fixtureUploadId = "fixture_memory-v1-day-01";
    repository.replaceUploadMemories({
      userId: "memory-eval-user",
      uploadId: fixtureUploadId,
      memories: [memoryInput("selected_memory", fixtureUploadId, "2026-06-29")]
    });
    repository.replaceUploadMemories({
      userId: "other-user",
      uploadId: "other_upload",
      memories: [memoryInput("other_memory", "other_upload", "2026-06-29")]
    });
    await selectedStore.write("uploads", fixtureUploadId, { id: fixtureUploadId });
    await selectedStore.write("memory-owner-audits", fixtureUploadId, {
      version: 1,
      memoriesProcessed: 1
    });
    await selectedStore.write("uploads", "real_upload", { id: "real_upload" });
    await otherStore.write("uploads", "other_upload", { id: "other_upload" });

    const result = await resetFixtureReplayUser({
      userId: "memory-eval-user",
      uploadIds: [fixtureUploadId],
      store: selectedStore,
      database
    });

    expect(result.before.memoryItems).toBe(1);
    expect(result.after).toEqual({ memoryItems: 0, memoryEvidence: 0, memoryRelations: 0, fixtureArtifacts: 0 });
    expect(repository.getRelevantMemories({ userId: "memory-eval-user" })).toEqual([]);
    expect(repository.getRelevantMemories({ userId: "other-user" })).toHaveLength(1);
    expect(await selectedStore.read("uploads", fixtureUploadId)).toBeNull();
    expect(await selectedStore.read("memory-owner-audits", fixtureUploadId)).toBeNull();
    expect(await selectedStore.read("uploads", "real_upload")).toEqual({ id: "real_upload" });
    expect(await otherStore.read("uploads", "other_upload")).toEqual({ id: "other_upload" });
    database.close();
  });

  it("can preserve analysis checkpoints for deterministic resume verification", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "fixture-reset-resume-"));
    const database = openMemoryDatabase({ filePath: join(tempDir, "memory.sqlite") });
    const store = new JsonStore(join(tempDir, "users", "memory-eval-user"));
    const uploadId = "fixture_memory-v1-day-01";
    const checkpoints = new JsonAnalysisChunkCheckpointStore(store);
    await executeWithAnalysisCheckpoint({
      store: checkpoints,
      userId: "memory-eval-user",
      uploadId,
      kind: "daily_brief",
      sourceChunkId: `${uploadId}_chunk_0`,
      sourceChunkIndex: 0,
      inputFingerprint: fingerprintAnalysisInput({ value: "input" }),
      processorFingerprint: fingerprintAnalysisInput({ value: "processor" }),
      outputSchema: z.array(z.string()),
      staleAfterMs: 60_000,
      execute: async () => ({ output: ["cached"], resultSource: "provider_success" })
    });
    await store.write("uploads", uploadId, { id: uploadId });

    await resetFixtureReplayUser({
      userId: "memory-eval-user",
      uploadIds: [uploadId],
      store,
      database,
      preserveAnalysisCheckpoints: true
    });

    expect(await store.read("uploads", uploadId)).toBeNull();
    expect(await checkpoints.list({ userId: "memory-eval-user", uploadId })).toHaveLength(1);
    database.close();
  });
});
