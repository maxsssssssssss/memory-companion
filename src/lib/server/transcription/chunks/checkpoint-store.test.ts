import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAudioChunkId, type AudioChunk } from "@/lib/domain/chunks";
import { JsonStore } from "@/lib/server/storage/json-store";
import { JsonChunkCheckpointStore } from "./checkpoint-store";

let tempDir: string | undefined;
const timestamp = "2026-07-14T08:00:00.000Z";

function chunk(uploadId: string, index: number): AudioChunk {
  return {
    id: buildAudioChunkId(uploadId, index),
    uploadId,
    index,
    startSeconds: index * 300,
    endSeconds: (index + 1) * 300,
    durationSeconds: 300,
    source: { type: "generated_chunk", path: `C:/tmp/${uploadId}_${index}.mp3` },
    status: "created",
    retryCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {}
  };
}

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("JSON chunk checkpoint store", () => {
  it("persists individual chunks and deletes only the requested upload", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "chunk-checkpoints-"));
    const checkpoints = new JsonChunkCheckpointStore(new JsonStore(tempDir));
    await checkpoints.saveAudioChunk(chunk("upload_a", 0));
    await checkpoints.saveAudioChunk(chunk("upload_b", 0));

    expect(await checkpoints.listAudioChunks("upload_a")).toHaveLength(1);
    await checkpoints.deleteUpload("upload_a");

    expect(await checkpoints.listAudioChunks("upload_a")).toEqual([]);
    expect(await checkpoints.listAudioChunks("upload_b")).toHaveLength(1);
  });
});
