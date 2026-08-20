// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioUpload, TranscriptSegment } from "@/lib/domain/types";
import { JsonStore } from "@/lib/server/storage/json-store";
import type { EmbeddingProvider } from "./embedding-provider";
import { SqliteEmbeddingIndex } from "./embedding-index";
import { refreshHybridEvidenceIndex } from "./index-refresh";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("user-scoped Hybrid evidence index refresh", () => {
  it("does not index unpublished Reflection projections and indexes only the published canonical allowlist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daily-brief-index-reflection-"));
    temporaryDirectories.push(directory);
    const store = new JsonStore(join(directory, "store"));
    const indexPath = join(directory, "index.sqlite");
    const upload = {
      id: "daily-reflection-reflection_1",
      originalName: "reflection.wav",
      mimeType: "audio/wav",
      sizeBytes: 10,
      recordingDate: "2026-08-13",
      status: "ready" as const,
      ingestionContext: "daily_reflection" as const,
      reflectionId: "reflection_1"
    };
    await store.write("uploads", upload.id, upload);
    await store.write("segments", upload.id, [{
      id: "segment_store_bypass",
      uploadId: upload.id,
      text: "Pending projection"
    }]);
    const provider: EmbeddingProvider = {
      config: { modelName: "test-embedding", modelVersion: "revision-1", dimension: 4 },
      embed: vi.fn(async (texts) => texts.map(() => [1, 0, 0, 0]))
    };
    const hidden = await refreshHybridEvidenceIndex({
      userId: "user_1",
      store,
      provider,
      indexPath,
      resolveUploadSource: () => ({
        visible: false,
        attribution: {
          origin: "unknown",
          statement: "来源尚未完全确认",
          date: "2026-08-13",
          contentKind: "memory_navigation",
          sourceSegmentIds: []
        }
      })
    });
    expect(hidden).toMatchObject({ uploadCount: 0, total: 0 });

    const canonical: TranscriptSegment = {
      id: "segment_kept",
      uploadId: upload.id,
      speaker: "self",
      startSeconds: 0,
      endSeconds: 5,
      text: "I prefer quiet cafes.",
      confidence: 1,
      sceneLabels: ["self_reflection"],
      valueLabels: ["notable_quote"]
    };
    const visible = await refreshHybridEvidenceIndex({
      userId: "user_1",
      store,
      provider,
      indexPath,
      resolveUploadSource: () => ({
        visible: true,
        canonicalSegments: [canonical],
        attribution: {
          origin: "user_reflection",
          statement: "你在 2026-08-13 的复盘中提到……",
          date: "2026-08-13",
          contentKind: "user_confirmed_derived_content",
          reflectionId: "reflection_1",
          sourceSegmentIds: [canonical.id]
        }
      })
    });
    expect(visible).toMatchObject({ uploadCount: 1, total: 1, embedded: 1 });
    const reader = new SqliteEmbeddingIndex(indexPath, provider.config, { readonly: true });
    expect(reader.list("evidence").map((item) => item.objectId)).toEqual([canonical.id]);
    expect(JSON.stringify(reader.list("evidence"))).not.toContain("segment_store_bypass");
    reader.close();
  });

  it("indexes all ready evidence and removes stale entries on the next snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daily-brief-index-refresh-"));
    temporaryDirectories.push(directory);
    const store = new JsonStore(join(directory, "store"));
    const indexPath = join(directory, "index.sqlite");
    const upload: AudioUpload = {
      id: "upload-1",
      originalName: "recording.m4a",
      mimeType: "audio/mp4",
      sizeBytes: 10,
      recordingDate: "2026-07-30",
      status: "ready"
    };
    const segment: TranscriptSegment = {
      id: "segment-1",
      uploadId: upload.id,
      speaker: "speaker_1",
      startSeconds: 0,
      endSeconds: 5,
      text: "最终安排是周日下午两点。",
      confidence: 1,
      sceneLabels: ["unknown"],
      valueLabels: []
    };
    await store.write("uploads", upload.id, upload);
    await store.write("segments", upload.id, [segment]);
    const provider: EmbeddingProvider = {
      config: {
        modelName: "test-embedding",
        modelVersion: "revision-1",
        dimension: 4
      },
      embed: vi.fn(async (texts) =>
        texts.map(() => [1, 0, 0, 0])
      )
    };
    const progress: string[] = [];
    const first = await refreshHybridEvidenceIndex({
      userId: "user_1",
      store,
      provider,
      indexPath,
      batchSize: 1,
      onProgress: (item) => {
        progress.push(`${item.stage}:${item.completed}/${item.total}`);
      }
    });
    expect(first).toMatchObject({
      uploadCount: 1,
      total: 1,
      embedded: 1,
      removed: 0
    });
    expect(progress).toContain("completed:1/1");

    await store.delete("uploads", upload.id);
    const second = await refreshHybridEvidenceIndex({
      userId: "user_1",
      store,
      provider,
      indexPath
    });
    expect(second).toMatchObject({
      uploadCount: 0,
      total: 0,
      embedded: 0,
      removed: 1
    });
    const reader = new SqliteEmbeddingIndex(indexPath, provider.config, {
      readonly: true
    });
    expect(reader.list("evidence")).toEqual([]);
    reader.close();
  });
});
