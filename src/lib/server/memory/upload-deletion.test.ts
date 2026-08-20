// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "./db";
import { createMemoryRepository } from "./repository";
import {
  deleteMemoryUploadAndRefreshIndex,
  MemoryUploadDeletionError
} from "./upload-deletion";

const NOW = "2026-08-11T00:00:00.000Z";
let database: Database.Database | undefined;

function writeMemory(input: {
  userId: string;
  uploadId: string;
  memoryId: string;
  date: string;
}) {
  createMemoryRepository(database!).replaceUploadMemories({
    userId: input.userId,
    uploadId: input.uploadId,
    memories: [{
      id: input.memoryId,
      type: "event",
      title: input.memoryId,
      summary: input.memoryId,
      importance: 0.7,
      date: input.date,
      createdAt: NOW,
      updatedAt: NOW,
      evidence: [{
        id: `${input.memoryId}_evidence`,
        sourceType: "transcript",
        sourceId: `${input.memoryId}_segment`,
        uploadId: input.uploadId,
        date: input.date,
        quote: input.memoryId,
        createdAt: NOW
      }]
    }]
  });
}

function writeBridgeReceipt(userId: string, uploadId: string, interactionId: string) {
  database!.prepare(`
    INSERT INTO dc_retained_uploads (
      user_id, upload_id, dc_relationship_id, dc_interaction_id,
      provenance_count, provenance_digest, status, captured_at, updated_at
    ) VALUES (?, ?, 'dc_relationship_1', ?, 1, ?, 'active', ?, ?)
  `).run(userId, uploadId, interactionId, "a".repeat(64), NOW, NOW);
  database!.prepare(`
    INSERT INTO dc_memory_bridge_receipts (
      id, account_id, idempotency_key, payload_digest, dc_relationship_id,
      dc_interaction_id, dc_outbox_id, mapping_version, committed_at
    ) VALUES (?, ?, ?, ?, 'dc_relationship_1', ?, ?, 1, ?)
  `).run(
    `receipt_${interactionId}`,
    userId,
    `idempotency_${interactionId}`,
    "b".repeat(64),
    interactionId,
    `outbox_${interactionId}`,
    NOW
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  database?.close();
  database = undefined;
});

describe("deleteMemoryUploadAndRefreshIndex", () => {
  it("removes only the scoped retained upload, receipt, and Evidence before enqueuing refresh", async () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createMemoryRepository(database);
    writeMemory({ userId: "user_a", uploadId: "upload_delete", memoryId: "memory_delete", date: "2026-08-10" });
    writeMemory({ userId: "user_a", uploadId: "upload_keep", memoryId: "memory_keep", date: "2026-08-11" });
    writeMemory({ userId: "user_b", uploadId: "upload_delete", memoryId: "memory_other_user", date: "2026-08-10" });
    writeBridgeReceipt("user_a", "upload_delete", "interaction_delete");
    const enqueueIndexJob = vi.fn(async () => ({ jobId: "job_1", enqueued: true }));

    await expect(deleteMemoryUploadAndRefreshIndex({
      userId: "user_a",
      uploadId: "upload_delete",
      indexRefreshFailure: "throw"
    }, {
      getRepository: () => repository,
      resolveExecutionMode: () => "queue",
      resolveHybridMode: () => "shadow",
      enqueueIndexJob
    })).resolves.toEqual({ memoryDeleted: true, indexRefresh: "enqueued" });

    expect(repository.getRelevantMemories({ userId: "user_a" }).map((memory) => memory.id))
      .toEqual(["memory_keep"]);
    expect(repository.getRelevantMemories({ userId: "user_b" }).map((memory) => memory.id))
      .toEqual(["memory_other_user"]);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM dc_memory_bridge_receipts
      WHERE account_id = 'user_a' AND dc_interaction_id = 'interaction_delete'
    `).get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT status FROM dc_retained_uploads
      WHERE user_id = 'user_a' AND upload_id = 'upload_delete'
    `).get()).toEqual({ status: "purged" });
    expect(enqueueIndexJob).toHaveBeenCalledWith({
      version: 1,
      userRef: "user_a",
      reason: "upload_deleted"
    });
  });

  it("keeps a Memory item grounded in its other upload Evidence", async () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createMemoryRepository(database);
    const first = {
      id: "preference_first",
      type: "preference" as const,
      title: "不喜欢过甜饮品",
      summary: "我不喜欢过甜饮品。",
      importance: 0.8,
      date: "2026-08-10",
      createdAt: NOW,
      updatedAt: NOW,
      evidence: [{
        id: "preference_first_evidence",
        sourceType: "transcript" as const,
        sourceId: "segment_first",
        uploadId: "upload_first",
        date: "2026-08-10",
        quote: "我不喜欢过甜饮品。",
        createdAt: NOW
      }]
    };
    repository.replaceUploadMemories({ userId: "user_a", uploadId: "upload_first", memories: [first] });
    repository.replaceUploadMemories({
      userId: "user_a",
      uploadId: "upload_second",
      memories: [{
        ...first,
        id: "preference_second",
        date: "2026-08-11",
        evidence: [{
          ...first.evidence[0],
          id: "preference_second_evidence",
          sourceId: "segment_second",
          uploadId: "upload_second",
          date: "2026-08-11"
        }]
      }]
    });
    expect(repository.getRelevantMemories({ userId: "user_a" })[0])
      .toMatchObject({ occurrenceCount: 2 });

    await deleteMemoryUploadAndRefreshIndex({
      userId: "user_a",
      uploadId: "upload_second",
      indexRefreshFailure: "throw"
    }, {
      getRepository: () => repository,
      resolveExecutionMode: () => "inline",
      resolveHybridMode: () => "off"
    });

    const remaining = repository.getRelevantMemories({ userId: "user_a" });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ occurrenceCount: 1 });
    expect(remaining[0]?.evidence.map((evidence) => evidence.uploadId)).toEqual(["upload_first"]);
  });

  it("reports index failure after Memory commit and retries idempotently", async () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createMemoryRepository(database);
    writeMemory({ userId: "user_a", uploadId: "upload_delete", memoryId: "memory_delete", date: "2026-08-11" });
    writeBridgeReceipt("user_a", "upload_delete", "interaction_delete");
    const enqueueIndexJob = vi.fn()
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValueOnce({ jobId: "job_1", enqueued: true });
    const input = {
      userId: "user_a",
      uploadId: "upload_delete",
      indexRefreshFailure: "throw" as const
    };
    const dependencies = {
      getRepository: () => repository,
      resolveExecutionMode: () => "queue" as const,
      resolveHybridMode: () => "shadow" as const,
      enqueueIndexJob
    };

    await expect(deleteMemoryUploadAndRefreshIndex(input, dependencies))
      .rejects.toMatchObject({ code: "memory_index_refresh_failed" });
    expect(repository.getRelevantMemories({ userId: "user_a" })).toEqual([]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM dc_memory_bridge_receipts").get())
      .toEqual({ count: 0 });

    await expect(deleteMemoryUploadAndRefreshIndex(input, dependencies))
      .resolves.toEqual({ memoryDeleted: true, indexRefresh: "enqueued" });
    expect(enqueueIndexJob).toHaveBeenCalledTimes(2);
  });

  it("does not enqueue refresh when the Memory transaction fails", async () => {
    const enqueueIndexJob = vi.fn();
    await expect(deleteMemoryUploadAndRefreshIndex({
      userId: "user_a",
      uploadId: "upload_delete",
      indexRefreshFailure: "throw"
    }, {
      getRepository: () => ({ deleteByUpload: () => { throw new Error("sqlite busy"); } }),
      resolveExecutionMode: () => "queue",
      resolveHybridMode: () => "shadow",
      enqueueIndexJob
    })).rejects.toEqual(new MemoryUploadDeletionError("memory_upload_delete_failed"));
    expect(enqueueIndexJob).not.toHaveBeenCalled();
  });
});
