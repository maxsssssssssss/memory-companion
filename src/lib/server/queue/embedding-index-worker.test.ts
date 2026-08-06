// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { JsonStore } from "@/lib/server/storage/json-store";
import { createEmbeddingIndexJobProcessor } from "./embedding-index-worker";

describe("embedding index queue worker", () => {
  it("reports real completed/total progress and returns index counters", async () => {
    const store = new JsonStore("unused-test-root");
    const updateProgress = vi.fn(async (_progress: number) => undefined);
    const refresh = vi.fn(async (input) => {
      await input.onProgress?.({
        completed: 0,
        total: 4,
        stage: "embedding"
      });
      await input.onProgress?.({
        completed: 4,
        total: 4,
        stage: "completed"
      });
      return {
        uploadCount: 1,
        retainedUploadCount: 2,
        completedDeletionCount: 1,
        total: 4,
        embedded: 3,
        unchanged: 1,
        removed: 0
      };
    });
    const processor = createEmbeddingIndexJobProcessor({
      getStore: () => store,
      refresh
    });
    await expect(processor({
      data: {
        version: 1,
        userRef: "user_1",
        reason: "manual"
      },
      updateProgress
    })).resolves.toEqual({
      status: "indexed",
      userRef: "user_1",
      uploadCount: 1,
      retainedUploadCount: 2,
      completedDeletionCount: 1,
      total: 4,
      embedded: 3,
      unchanged: 1,
      removed: 0
    });
    expect(updateProgress.mock.calls.map(([value]) => value)).toEqual([0, 100]);
  });

  it("runs permanent deletion as a local-only processor operation", async () => {
    const store = new JsonStore("unused-test-root");
    const updateProgress = vi.fn(async (_progress: number) => undefined);
    const refresh = vi.fn();
    const deletePending = vi.fn(async () => ({
      completed: 1,
      requested: 3,
      removed: 2,
      alreadyMissing: 1
    }));
    const processor = createEmbeddingIndexJobProcessor({
      getStore: () => store,
      refresh,
      deletePending
    });

    await expect(processor({
      data: {
        version: 1,
        userRef: "user_1",
        reason: "permanent_delete"
      },
      updateProgress
    })).resolves.toEqual({
      status: "indexed",
      userRef: "user_1",
      uploadCount: 0,
      retainedUploadCount: 0,
      completedDeletionCount: 1,
      total: 3,
      embedded: 0,
      unchanged: 1,
      removed: 2
    });
    expect(deletePending).toHaveBeenCalledWith({
      userId: "user_1",
      store
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(updateProgress).toHaveBeenCalledWith(100);
  });
});
