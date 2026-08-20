// @vitest-environment node

import type Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DcConflictError } from "./errors";
import type { DateCompanionMemoryBridgeRuntimeConfig } from "./memory-bridge-runtime-config";
import {
  DateCompanionMemoryBridgeRuntimePreflightError,
  startDateCompanionMemoryBridgeRuntime,
  type DateCompanionMemoryBridgeRuntime,
  type DateCompanionMemoryBridgeRuntimeDependencies,
  type DateCompanionMemoryBridgeRuntimeHealthSnapshot
} from "./memory-bridge-runtime";

const runtimes: DateCompanionMemoryBridgeRuntime[] = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  vi.useRealTimers();
});

function config(
  overrides: Partial<DateCompanionMemoryBridgeRuntimeConfig> = {}
): DateCompanionMemoryBridgeRuntimeConfig {
  return {
    enabled: true,
    dataDirectory: resolve("memory-bridge-runtime-test"),
    pollIntervalMs: 1_000,
    batchSize: 10,
    leaseMs: 300_000,
    retryBaseMs: 1_000,
    retryMaxMs: 4_000,
    shutdownDrainTimeoutMs: 1_000,
    oldestPendingHealthMs: 60_000,
    failedCountThreshold: 10,
    ...overrides
  };
}

function managedDatabase() {
  let open = true;
  const close = vi.fn(() => {
    open = false;
  });
  const database = {
    get open() {
      return open;
    },
    close
  } as unknown as Database.Database;
  return { database, close };
}

function silentLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function successfulResult(index = 1) {
  return {
    outboxId: `outbox_${index}`,
    completed: true as const,
    idempotent: false
  };
}

function startTestRuntime(input: {
  runtimeConfig?: DateCompanionMemoryBridgeRuntimeConfig;
  processNext?: DateCompanionMemoryBridgeRuntimeDependencies["processNext"];
  reportHealth?: (
    snapshot: DateCompanionMemoryBridgeRuntimeHealthSnapshot
  ) => void | Promise<void>;
  logger?: ReturnType<typeof silentLogger>;
  now?: () => number;
  startImmediately?: boolean;
  dateCompanionDatabase?: ReturnType<typeof managedDatabase>;
  memoryDatabase?: ReturnType<typeof managedDatabase>;
}) {
  const dateCompanion = input.dateCompanionDatabase ?? managedDatabase();
  const memory = input.memoryDatabase ?? managedDatabase();
  const logger = input.logger ?? silentLogger();
  const runtime = startDateCompanionMemoryBridgeRuntime({
    config: input.runtimeConfig ?? config(),
    startImmediately: input.startImmediately ?? false,
    dependencies: {
      inspectPreflight: () => ({ ok: true, errorCodes: [] }),
      openDateCompanionDatabase: () => dateCompanion.database,
      openMemoryDatabase: () => memory.database,
      processNext: input.processNext ?? (async () => null),
      now: input.now ?? (() => Date.parse("2026-08-11T00:00:00.000Z")),
      logger,
      reportHealth: input.reportHealth
    }
  });
  if (!runtime) throw new Error("test runtime unexpectedly disabled");
  runtimes.push(runtime);
  return { runtime, dateCompanion, memory, logger };
}

describe("Date Companion Memory Bridge runtime", () => {
  it("does not preflight, open databases, report health, schedule, or claim while disabled", () => {
    vi.useFakeTimers();
    const inspectPreflight = vi.fn(() => ({ ok: true, errorCodes: [] }));
    const openDateCompanion = vi.fn(() => managedDatabase().database);
    const openMemory = vi.fn(() => managedDatabase().database);
    const processNext = vi.fn(async () => successfulResult());
    const reportHealth = vi.fn();

    expect(startDateCompanionMemoryBridgeRuntime({
      config: config({ enabled: false }),
      dependencies: {
        inspectPreflight,
        openDateCompanionDatabase: openDateCompanion,
        openMemoryDatabase: openMemory,
        processNext,
        reportHealth
      }
    })).toBeNull();
    expect(inspectPreflight).not.toHaveBeenCalled();
    expect(openDateCompanion).not.toHaveBeenCalled();
    expect(openMemory).not.toHaveBeenCalled();
    expect(processNext).not.toHaveBeenCalled();
    expect(reportHealth).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails the read-only preflight before opening either database", () => {
    const openDateCompanion = vi.fn(() => managedDatabase().database);
    const openMemory = vi.fn(() => managedDatabase().database);
    expect(() => startDateCompanionMemoryBridgeRuntime({
      config: config(),
      dependencies: {
        inspectPreflight: () => ({
          ok: false,
          errorCodes: ["date_companion_schema_incompatible"]
        }),
        openDateCompanionDatabase: openDateCompanion,
        openMemoryDatabase: openMemory
      }
    })).toThrow(DateCompanionMemoryBridgeRuntimePreflightError);
    expect(openDateCompanion).not.toHaveBeenCalled();
    expect(openMemory).not.toHaveBeenCalled();
  });

  it("does not recreate a database that disappears after preflight", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "memory-bridge-runtime-missing-"));
    const dateCompanionPath = join(dataDirectory, "date-companion.sqlite");
    try {
      expect(() => startDateCompanionMemoryBridgeRuntime({
        config: config({ dataDirectory }),
        dependencies: {
          inspectPreflight: () => ({ ok: true, errorCodes: [] }),
          reportHealth: undefined
        }
      })).toThrow();
      expect(existsSync(dateCompanionPath)).toBe(false);
    } finally {
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  });

  it("opens one owned connection pair and returns one idempotent singleton", async () => {
    const dateCompanion = managedDatabase();
    const memory = managedDatabase();
    const first = startTestRuntime({ dateCompanionDatabase: dateCompanion, memoryDatabase: memory });
    const ignoredOpen = vi.fn(() => managedDatabase().database);
    const second = startDateCompanionMemoryBridgeRuntime({
      config: config(),
      dependencies: {
        inspectPreflight: () => ({ ok: true, errorCodes: [] }),
        openDateCompanionDatabase: ignoredOpen,
        openMemoryDatabase: ignoredOpen
      }
    });

    expect(second).toBe(first.runtime);
    expect(ignoredOpen).not.toHaveBeenCalled();
    await expect(first.runtime.close()).resolves.toEqual({ timedOut: false });
    expect(dateCompanion.close).toHaveBeenCalledOnce();
    expect(memory.close).toHaveBeenCalledOnce();
    await expect(first.runtime.runPromise).resolves.toBeUndefined();
  });

  it("processes no more than the bounded batch and logs content-free progress", async () => {
    const processNext = vi.fn(async () => successfulResult(processNext.mock.calls.length));
    const reportHealth = vi.fn(async (
      _snapshot: DateCompanionMemoryBridgeRuntimeHealthSnapshot
    ) => undefined);
    const logger = silentLogger();
    const { runtime } = startTestRuntime({
      runtimeConfig: config({ batchSize: 2 }),
      processNext,
      reportHealth,
      logger
    });

    await expect(runtime.pollNow()).resolves.toEqual({
      handled: 2,
      completed: 2,
      needsReview: 0,
      retryableFailed: 0,
      idle: false,
      stopped: false
    });
    expect(processNext).toHaveBeenCalledTimes(2);
    expect(processNext).toHaveBeenCalledWith(expect.objectContaining({ leaseMs: 300_000 }));
    expect(runtime.getHealthSnapshot()).toMatchObject({
      running: true,
      processed: 2,
      retried: 0,
      failed: 0,
      lastErrorCode: null
    });
    const logs = [...logger.info.mock.calls, ...logger.warn.mock.calls].flat().join(" ");
    expect(logs).toContain("processed=2");
    expect(logs).not.toContain("outbox_");
    const latest = reportHealth.mock.calls.at(-1)?.[0];
    expect(Object.keys(latest ?? {}).sort()).toEqual([
      "failed",
      "heartbeatAt",
      "lastErrorCode",
      "lastSuccessAt",
      "processed",
      "retried",
      "running",
      "startedAt"
    ]);
    expect(latest).not.toHaveProperty("dataDirectory");
  });

  it("waits cheaply after an empty poll instead of busy-looping", async () => {
    vi.useFakeTimers();
    const processNext = vi.fn(async () => null);
    startTestRuntime({ processNext, startImmediately: true });

    await vi.advanceTimersByTimeAsync(0);
    expect(processNext).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(processNext).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(processNext).toHaveBeenCalledTimes(2);
  });

  it("stops a tick on retryable failure and applies bounded exponential backoff", async () => {
    vi.useFakeTimers();
    const processNext = vi.fn(async () => {
      if (processNext.mock.calls.length <= 2) throw new Error("transient");
      return null;
    });
    const { runtime } = startTestRuntime({ processNext, startImmediately: true });

    await vi.advanceTimersByTimeAsync(0);
    expect(processNext).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(processNext).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(processNext).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(processNext).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(processNext).toHaveBeenCalledTimes(3);
    expect(runtime.getHealthSnapshot()).toMatchObject({
      processed: 0,
      retried: 2,
      failed: 2,
      lastErrorCode: "memory_bridge_failed"
    });
  });

  it("continues after needs_review without counting an infrastructure failure", async () => {
    const processNext = vi.fn(async () => {
      if (processNext.mock.calls.length === 1) throw new DcConflictError("mapping_stale");
      if (processNext.mock.calls.length === 2) return successfulResult(2);
      return null;
    });
    const { runtime } = startTestRuntime({ processNext });

    await expect(runtime.pollNow()).resolves.toMatchObject({
      handled: 2,
      completed: 1,
      needsReview: 1,
      retryableFailed: 0,
      idle: true
    });
    expect(processNext).toHaveBeenCalledTimes(3);
    expect(runtime.getHealthSnapshot()).toMatchObject({
      processed: 1,
      retried: 0,
      failed: 0,
      lastErrorCode: null
    });
  });

  it("deduplicates overlapping polls and drains the current item before closing", async () => {
    let resolveItem: ((value: ReturnType<typeof successfulResult>) => void) | undefined;
    const processNext = vi.fn(() => new Promise<ReturnType<typeof successfulResult>>((resolve) => {
      resolveItem = resolve;
    }));
    const { runtime, dateCompanion, memory } = startTestRuntime({ processNext });
    const firstPoll = runtime.pollNow();
    const secondPoll = runtime.pollNow();
    expect(secondPoll).toBe(firstPoll);
    await vi.waitFor(() => expect(processNext).toHaveBeenCalledOnce());

    const close = runtime.close();
    let closed = false;
    void close.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(dateCompanion.close).not.toHaveBeenCalled();
    expect(memory.close).not.toHaveBeenCalled();

    resolveItem?.(successfulResult());
    await Promise.all([firstPoll, close, runtime.runPromise]);
    expect(closed).toBe(true);
    expect(dateCompanion.close).toHaveBeenCalledOnce();
    expect(memory.close).toHaveBeenCalledOnce();
  });

  it("returns after a bounded shutdown timeout without closing in-use databases or changing the lease", async () => {
    vi.useFakeTimers();
    let resolveItem: ((value: ReturnType<typeof successfulResult>) => void) | undefined;
    const processNext = vi.fn(() => new Promise<ReturnType<typeof successfulResult>>((resolve) => {
      resolveItem = resolve;
    }));
    const reportHealth = vi.fn((
      _snapshot: DateCompanionMemoryBridgeRuntimeHealthSnapshot
    ) => new Promise<void>(() => undefined));
    const { runtime, dateCompanion, memory } = startTestRuntime({
      processNext,
      reportHealth,
      runtimeConfig: config({ shutdownDrainTimeoutMs: 1_000 })
    });
    const poll = runtime.pollNow();
    await vi.waitFor(() => expect(processNext).toHaveBeenCalledOnce());
    const close = runtime.close();

    await vi.advanceTimersByTimeAsync(999);
    expect(dateCompanion.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(close).resolves.toEqual({ timedOut: true });
    await expect(runtime.runPromise).resolves.toBeUndefined();
    expect(dateCompanion.close).not.toHaveBeenCalled();
    expect(memory.close).not.toHaveBeenCalled();
    expect(processNext).toHaveBeenCalledTimes(1);
    expect(runtime.getHealthSnapshot()).toMatchObject({
      running: false,
      failed: 1,
      lastErrorCode: "memory_bridge_shutdown_timeout"
    });

    resolveItem?.(successfulResult());
    await poll;
    await vi.waitFor(() => expect(dateCompanion.close).toHaveBeenCalledOnce());
    expect(memory.close).toHaveBeenCalledOnce();
    expect(reportHealth.mock.calls.every(([snapshot]) =>
      !Object.values(snapshot as Record<string, unknown>).includes(config().dataDirectory)
    )).toBe(true);
  });
});
