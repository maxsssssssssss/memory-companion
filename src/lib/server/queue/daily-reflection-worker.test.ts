// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

import { isDailyReflectionUploadEnabled } from "@/lib/server/daily-reflection/runtime-config";
import type { JsonStore } from "@/lib/server/storage/json-store";

import { createDailyReflectionJobProcessor } from "./daily-reflection-worker";

const payload = {
  version: 1 as const,
  ingestionContext: "daily_reflection" as const,
  reflectionId: "reflection_1",
  userRef: "account_1"
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("daily reflection queue worker", () => {
  it("delegates only the account and reflection references so the processor rereads the persisted plan", async () => {
    const store = {} as JsonStore;
    const runProcess = vi.fn(async (_input: unknown) => ({
      outcome: "completed" as const,
      reflectionId: payload.reflectionId,
      uploadId: "upload_from_persisted_plan",
      status: "review_pending",
      candidateCount: 5
    }));
    const processJob = createDailyReflectionJobProcessor({
      getStore: vi.fn(() => store),
      getUploadsRootDir: vi.fn(() => "C:/uploads/account_1"),
      runProcess
    });

    await expect(processJob({ data: payload })).resolves.toEqual({
      status: "review_pending",
      reflectionId: payload.reflectionId,
      uploadId: "upload_from_persisted_plan",
      candidateCount: 5
    });
    expect(runProcess).toHaveBeenCalledWith({
      accountId: payload.userRef,
      reflectionId: payload.reflectionId,
      store,
      uploadsRootDir: "C:/uploads/account_1",
      executionMode: "queue"
    });
    const delegatedInput = runProcess.mock.calls[0]?.[0];
    expect(delegatedInput).not.toHaveProperty("uploadId");
    expect(delegatedInput).not.toHaveProperty("sourceOrigin");
  });

  it("rejects non-discriminated or enriched payloads before resolving account storage", async () => {
    const getStore = vi.fn(() => ({} as JsonStore));
    const runProcess = vi.fn();
    const processJob = createDailyReflectionJobProcessor({
      getStore,
      getUploadsRootDir: vi.fn(() => "C:/uploads"),
      runProcess
    });

    await expect(processJob({
      data: { ...payload, uploadId: "untrusted_route_marker" }
    })).rejects.toThrow();
    await expect(processJob({
      data: { ...payload, ingestionContext: "standard_upload" }
    })).rejects.toThrow();
    expect(getStore).not.toHaveBeenCalled();
    expect(runProcess).not.toHaveBeenCalled();
  });

  it.each([
    ["failed", "failed"],
    ["tombstoned", "cancelled"],
    ["reused", "reused"],
    ["busy", "reused"]
  ] as const)("maps processor outcome %s to queue status %s", async (outcome, status) => {
    const processJob = createDailyReflectionJobProcessor({
      getStore: vi.fn(() => ({} as JsonStore)),
      getUploadsRootDir: vi.fn(() => "C:/uploads"),
      runProcess: vi.fn(async () => ({
        outcome,
        reflectionId: payload.reflectionId,
        uploadId: "upload_1",
        status,
        candidateCount: 0
      }))
    });

    await expect(processJob({ data: payload })).resolves.toMatchObject({ status });
  });
});

describe("daily reflection worker feature flag", () => {
  it("is fail-closed by default", () => {
    vi.stubEnv("DAILY_REFLECTION_UPLOAD_ENABLED", "");
    expect(isDailyReflectionUploadEnabled()).toBe(false);
  });

  it("enables the worker gate only for the explicit true value", () => {
    vi.stubEnv("DAILY_REFLECTION_UPLOAD_ENABLED", "true");
    expect(isDailyReflectionUploadEnabled()).toBe(true);
    vi.stubEnv("DAILY_REFLECTION_UPLOAD_ENABLED", "1");
    expect(isDailyReflectionUploadEnabled()).toBe(false);
  });
});
