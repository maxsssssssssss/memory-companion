// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JsonStore } from "@/lib/server/storage/json-store";

import {
  cleanupOlderAudioUploadAttempts,
  cleanupPersistedAudioUploadAttempt,
  persistAudioUpload
} from "./storage";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true
  })));
});

describe("Toy upload attempt cleanup", () => {
  it("removes a lost attempt file without deleting a newer shared Upload projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "toy-upload-attempt-cleanup-"));
    roots.push(root);
    const store = new JsonStore(join(root, "store"));
    const loserPath = join(root, "upload_1.attempt-1.wav");
    const winnerPath = join(root, "upload_1.attempt-2.wav");
    await writeFile(loserPath, "loser");
    await writeFile(winnerPath, "winner");
    await store.write("uploads", "upload_1", {
      id: "upload_1",
      filePath: winnerPath,
      toyIngestionAttemptVersion: 2
    });

    await cleanupPersistedAudioUploadAttempt({
      store,
      upload: { id: "upload_1", filePath: loserPath }
    });

    await expect(readFile(loserPath)).rejects.toThrow();
    await expect(readFile(winnerPath, "utf8")).resolves.toBe("winner");
    await expect(store.read("uploads", "upload_1")).resolves.toMatchObject({
      filePath: winnerPath,
      toyIngestionAttemptVersion: 2
    });
  });

  it("deletes only older attempt files after the winning receipt is accepted", async () => {
    const root = await mkdtemp(join(tmpdir(), "toy-upload-old-attempts-"));
    roots.push(root);
    const first = join(root, "upload_1.attempt-1.wav");
    const current = join(root, "upload_1.attempt-2.wav");
    const other = join(root, "upload_2.attempt-1.wav");
    await Promise.all([
      writeFile(first, "first"),
      writeFile(current, "current"),
      writeFile(other, "other")
    ]);

    await cleanupOlderAudioUploadAttempts({
      uploadDir: root,
      uploadId: "upload_1",
      currentAttempt: 2
    });

    await expect(readFile(first)).rejects.toThrow();
    await expect(readFile(current, "utf8")).resolves.toBe("current");
    await expect(readFile(other, "utf8")).resolves.toBe("other");
  });

  it("wires older-attempt cleanup into successful numbered persistence", async () => {
    const root = await mkdtemp(join(tmpdir(), "toy-upload-persistence-cleanup-"));
    roots.push(root);
    const store = new JsonStore(join(root, "store"));
    const first = join(root, "upload_1.attempt-1.wav");
    const current = join(root, "upload_1.attempt-2.wav");
    await writeFile(first, "orphan");

    await persistAudioUpload({
      store,
      uploadId: "upload_1",
      uploadDir: root,
      file: new File([
        new Uint8Array([82, 73, 70, 70, 61, 62, 63, 64])
      ], "recording.wav", { type: "audio/wav" }),
      recordingDate: "2026-08-20",
      attemptSuffix: "attempt-2"
    });

    await expect(readFile(first)).rejects.toThrow();
    await expect(readFile(current)).resolves.toEqual(
      Buffer.from([82, 73, 70, 70, 61, 62, 63, 64])
    );
  });
});
