import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JsonStore } from "@/lib/server/storage/json-store";

import { cleanupWorkReviewUploadArtifacts } from "./cleanup";

describe("cleanupWorkReviewUploadArtifacts", () => {
  let rootDir: string;
  let uploadsRootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "work-review-cleanup-"));
    uploadsRootDir = join(rootDir, "uploads");
    await mkdir(uploadsRootDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("removes the published file and abandoned request attempts without touching other uploads", async () => {
    const uploadId = "work-meeting-1234";
    const publishedPath = join(uploadsRootDir, `${uploadId}.request-winner.mp3`);
    const abandonedPath = join(uploadsRootDir, `${uploadId}.request-abandoned.wav`);
    const unrelatedPath = join(uploadsRootDir, "work-meeting-other.request-live.mp3");
    await Promise.all([
      writeFile(publishedPath, "published"),
      writeFile(abandonedPath, "abandoned"),
      writeFile(unrelatedPath, "unrelated")
    ]);

    const result = await cleanupWorkReviewUploadArtifacts({
      store: new JsonStore(rootDir),
      uploadsRootDir,
      uploadId,
      filePath: publishedPath
    });

    expect(result).toEqual({ ok: true, failures: [] });
    await expect(access(publishedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(abandonedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(unrelatedPath)).resolves.toBeUndefined();
  });
});
