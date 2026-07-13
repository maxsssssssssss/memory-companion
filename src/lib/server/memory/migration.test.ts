// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AudioUpload, BriefItem, TranscriptSegment } from "@/lib/domain/types";
import { JsonStore } from "@/lib/server/storage/json-store";
import { openMemoryDatabase } from "./db";
import { migrateLegacyMemoryIndex } from "./migration";
import { createMemoryRepository } from "./repository";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("memory migration", () => {
  it("indexes ready legacy JSON data and is safe to rerun", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-migrate-"));
    const userId = "user_1";
    const uploadId = "upload_1";
    const store = new JsonStore(join(tempDir, "users", userId));
    const upload: AudioUpload = {
      id: uploadId,
      originalName: "synthetic-demo.wav",
      mimeType: "audio/wav",
      sizeBytes: 100,
      recordingDate: "2026-07-08",
      status: "ready"
    };
    const segment: TranscriptSegment = {
      id: "segment_1",
      uploadId,
      startSeconds: 0,
      endSeconds: 5,
      text: "我会在周五前确认。",
      confidence: 0.95,
      sceneLabels: ["unknown"],
      valueLabels: ["commitment"]
    };
    const brief: BriefItem = {
      id: "brief_1",
      uploadId,
      category: "commitment",
      title: "周五前确认",
      body: "录音中出现了一项明确承诺。",
      priority: "high",
      confidence: 0.86,
      status: "candidate",
      sourceSegmentIds: [segment.id],
      sourceTimeRange: { startSeconds: 0, endSeconds: 5 },
      transcriptExcerpt: segment.text,
      people: [],
      topics: []
    };
    await store.write("uploads", uploadId, upload);
    await store.write("segments", uploadId, [segment]);
    await store.write("brief-items", uploadId, [brief]);
    await store.write("semantic-segments", uploadId, []);
    await store.write("relationship-signals", uploadId, []);

    const database = openMemoryDatabase({ filePath: join(tempDir, "memory.sqlite") });
    const repository = createMemoryRepository(database);
    const first = await migrateLegacyMemoryIndex({ dataRoot: tempDir, repository });
    const second = await migrateLegacyMemoryIndex({ dataRoot: tempDir, repository });

    expect(first).toMatchObject({ usersScanned: 1, uploadsIndexed: 1, memoriesIndexed: 1, uploadsFailed: 0 });
    expect(second).toMatchObject({ usersScanned: 1, uploadsIndexed: 1, memoriesIndexed: 1, uploadsFailed: 0 });
    expect(repository.getRelevantMemories({ userId })).toEqual([
      expect.objectContaining({ type: "commitment", title: "周五前确认" })
    ]);

    database.close();
  });
});
