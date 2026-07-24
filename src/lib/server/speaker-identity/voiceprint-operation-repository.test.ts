import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JsonStore } from "@/lib/server/storage/json-store";
import { JsonVoiceprintOperationRepository } from "./voiceprint-operation-repository";

const INPUT_DIGEST = "a".repeat(64);
const OTHER_INPUT_DIGEST = "b".repeat(64);

describe("JsonVoiceprintOperationRepository", () => {
  let rootDir: string;
  let repository: JsonVoiceprintOperationRepository;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "voiceprint-operation-"));
    repository = new JsonVoiceprintOperationRepository(
      new JsonStore(rootDir),
      () => "2026-07-24T00:00:00.000Z"
    );
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("stores only bounded operation metadata and never stores training audio", async () => {
    await repository.save({
      providerRequestId: "train_request_1",
      operationType: "train",
      status: "succeeded",
      resultMetadata: {
        inputDigest: INPUT_DIGEST,
        subjectType: "known_user",
        providerCode: 0,
        providerMessagePresent: true,
        providerSucceeded: true,
        audioCount: 2,
        incremental: true,
        globalSpeakerId: "user_1"
      }
    });

    await expect(repository.get("train_request_1")).resolves.toMatchObject({
      operationType: "train",
      status: "succeeded",
      resultMetadata: {
        audioCount: 2,
        incremental: true
      }
    });

    const files = (await readdir(rootDir, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
    const stored = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
    expect(stored).not.toContain("https://audio.example.test");
    expect(stored).not.toContain("embedding");
    expect(stored).not.toContain("voice_bytes");
  });

  it("updates a failed request deterministically without changing its creation time", async () => {
    await repository.save({
      providerRequestId: "save_request_1",
      operationType: "save",
      status: "failed",
      resultMetadata: {
        inputDigest: INPUT_DIGEST,
        subjectType: "known_contact",
        providerSucceeded: false,
        failureReason: "timeout",
        failurePhase: "provider",
        retryable: true
      }
    });
    const first = await repository.get("save_request_1");

    const second = await repository.save({
      providerRequestId: "save_request_1",
      operationType: "save",
      status: "succeeded",
      resultMetadata: {
        inputDigest: INPUT_DIGEST,
        subjectType: "known_contact",
        providerCode: 0,
        providerSucceeded: true,
        globalSpeakerId: "contact_alice"
      }
    });

    expect(second.createdAt).toBe(first?.createdAt);
    expect(second.status).toBe("succeeded");
  });

  it("rejects arbitrary raw metadata fields", async () => {
    await expect(repository.save({
      providerRequestId: "train_request_raw",
      operationType: "train",
      status: "succeeded",
      resultMetadata: {
        inputDigest: INPUT_DIGEST,
        subjectType: "known_user",
        providerSucceeded: true,
        audioCount: 1,
        audioUrl: "https://audio.example.test/private.wav"
      }
    } as never)).rejects.toThrow();
  });

  it("does not let a late failure overwrite a succeeded operation", async () => {
    const succeeded = await repository.save({
      providerRequestId: "terminal_request",
      operationType: "save",
      status: "succeeded",
      resultMetadata: {
        inputDigest: INPUT_DIGEST,
        subjectType: "known_contact",
        providerCode: 0,
        providerSucceeded: true,
        globalSpeakerId: "contact_alice"
      }
    });

    const lateFailure = await repository.save({
      providerRequestId: "terminal_request",
      operationType: "save",
      status: "failed",
      resultMetadata: {
        inputDigest: INPUT_DIGEST,
        subjectType: "known_contact",
        providerSucceeded: false,
        failureReason: "timeout",
        failurePhase: "provider",
        retryable: true,
        globalSpeakerId: "contact_alice"
      }
    });

    expect(lateFailure).toEqual(succeeded);
    await expect(repository.get("terminal_request")).resolves.toEqual(succeeded);
  });

  it("rejects reusing a provider request id for different input", async () => {
    await repository.save({
      providerRequestId: "conflicting_request",
      operationType: "train",
      status: "failed",
      resultMetadata: {
        inputDigest: INPUT_DIGEST,
        subjectType: "known_user",
        providerSucceeded: false,
        failureReason: "timeout",
        failurePhase: "provider",
        retryable: true
      }
    });

    await expect(repository.save({
      providerRequestId: "conflicting_request",
      operationType: "train",
      status: "pending",
      resultMetadata: {
        inputDigest: OTHER_INPUT_DIGEST,
        subjectType: "known_user",
        providerSucceeded: false,
        audioCount: 1
      }
    })).rejects.toThrow("different input");
  });
});
