// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { JobsOptions } from "bullmq";

import type {
  WorkWeeklyQaRun,
  WorkWeeklyRun
} from "@/lib/domain/work-weekly";
import type {
  WorkWeeklyGenerationRunRequest,
  WorkWeeklyQaRunRequest,
  WorkWeeklyQaUnknownOutcomeTerminationRequest,
  WorkWeeklyRecoveryDisposition,
  WorkWeeklyRunResult,
  WorkWeeklyUnknownOutcomeTerminationRequest
} from "@/lib/server/work-review/weekly-ai-runner";

import type { PipelineQueueConfig } from "./config";
import {
  startWorkWeeklyRuntime,
  type WorkWeeklyRuntimeService,
  WORK_WEEKLY_RECOVERY_BATCH_SIZE_PER_KIND,
  WORK_WEEKLY_RUN_LEASE_MS
} from "./work-weekly-runtime";
import {
  buildWorkWeeklyQueueJobId,
  WORK_WEEKLY_GENERATION_QUEUE_JOB_NAME,
  WORK_WEEKLY_QA_QUEUE_JOB_NAME,
  WorkWeeklyGenerationQueuePayloadSchema,
  type WorkWeeklyQueuePayload
} from "./work-weekly-queue";

const NOW = "2026-09-03T00:00:00.000Z";
const DIGEST = "b".repeat(64);

const config: PipelineQueueConfig = {
  redisUrl: "redis://127.0.0.1:6379",
  queueName: "daily-brief-test",
  executionMode: "queue",
  attempts: 3,
  backoffMs: 1_000,
  workerConcurrency: 1,
  processingStaleMs: 60_000,
  recoveryIntervalMs: 60_000,
  failedHealthWindowMs: 60_000,
  retention: {
    completed: { age: 3_600, count: 10 },
    failed: { age: 3_600, count: 10 }
  },
  dataDirectory: "C:\\tmp\\daily-brief-test",
  storageMode: "server"
};

function generationRun(
  state: "queued" | "processing" | "verifying" = "queued",
  suffix = "1"
): WorkWeeklyRun {
  return {
    id: `generation_run_${suffix}`,
    accountId: `account_${suffix}`,
    weeklyReviewId: `weekly_${suffix}`,
    runVersion: 1,
    sourceSnapshotDigest: DIGEST,
    state,
    leaseOwner: state === "queued" ? null : "old_worker",
    leaseExpiresAt: state === "queued" ? null : "2026-09-02T00:00:00.000Z",
    pipelineVersion: "work-weekly-v1",
    synthesizerProfile: null,
    verifierProfile: null,
    createdAt: NOW,
    completedAt: null,
    errorCode: null
  };
}

function qaRun(
  state: "queued" | "processing" | "verifying" = "queued",
  suffix = "1"
): WorkWeeklyQaRun {
  return {
    id: `qa_run_${suffix}`,
    accountId: `account_${suffix}`,
    weeklyReviewId: `weekly_${suffix}`,
    threadId: `thread_${suffix}`,
    questionMessageId: `question_${suffix}`,
    runVersion: 2,
    sourceSnapshotDigest: DIGEST,
    state,
    leaseOwner: state === "queued" ? null : "old_worker",
    leaseExpiresAt: state === "queued" ? null : "2026-09-02T00:00:00.000Z",
    providerProfile: null,
    promptVersion: null,
    verifierProfile: null,
    createdAt: NOW,
    completedAt: null,
    errorCode: null
  };
}

function runtimeHarness(input: {
  flags?: () => { weeklyAiEnabled: boolean; weeklyQaEnabled: boolean };
  generationRuns?: WorkWeeklyRun[];
  qaRuns?: WorkWeeklyQaRun[];
  getJob?: (jobId: string) => Promise<{
    getState(): Promise<string>;
  } | null>;
  add?: (
    name: string,
    data: WorkWeeklyQueuePayload,
    options: JobsOptions
  ) => Promise<unknown>;
} = {}) {
  let processor: ((job: {
    id?: string;
    name: string;
    data: WorkWeeklyQueuePayload;
  }) => Promise<{ status: string; kind: "generation" | "qa" }>) | undefined;
  let intervalHandler: (() => void) | undefined;
  let resolveWorkerRun: (() => void) | undefined;
  const workerRun = new Promise<void>((resolve) => {
    resolveWorkerRun = resolve;
  });
  const add = vi.fn(async (
    name: string,
    data: WorkWeeklyQueuePayload,
    options: JobsOptions
  ) => input.add?.(name, data, options));
  const queueClose = vi.fn(async () => undefined);
  const redisQuit = vi.fn(async () => undefined);
  const runGeneration = vi.fn(async (
    request: WorkWeeklyGenerationRunRequest
  ): Promise<WorkWeeklyRunResult> => ({
    state: "published" as const,
    kind: "generation" as const,
    weeklyReviewId: request.weeklyReviewId,
    runId: request.runId,
    runVersion: request.runVersion
  }));
  const runQa = vi.fn(async (
    request: WorkWeeklyQaRunRequest
  ): Promise<WorkWeeklyRunResult> => ({
    state: "published" as const,
    kind: "qa" as const,
    weeklyReviewId: request.weeklyReviewId,
    runId: request.runId,
    runVersion: request.runVersion
  }));
  const listGenerationRuns = vi.fn(async (
    _now: string,
    _limit: number
  ): Promise<WorkWeeklyRun[]> => input.generationRuns ?? []);
  const listQaRuns = vi.fn(async (
    _now: string,
    _limit: number
  ): Promise<WorkWeeklyQaRun[]> => input.qaRuns ?? []);
  const classify = (run: WorkWeeklyRun | WorkWeeklyQaRun): WorkWeeklyRecoveryDisposition => {
    if (run.state === "queued") return "execute_queued" as const;
    return "terminate_unknown_outcome" as const;
  };
  const terminateGenerationUnknownOutcome = vi.fn(async (
    request: WorkWeeklyUnknownOutcomeTerminationRequest
  ) => ({
    state: "failed" as const,
    kind: "generation" as const,
    weeklyReviewId: request.weeklyReviewId,
    runId: request.runId,
    runVersion: request.runVersion,
    errorCode: "weekly_generation_provider_outcome_unknown"
  }));
  const terminateQaUnknownOutcome = vi.fn(async (
    request: WorkWeeklyQaUnknownOutcomeTerminationRequest
  ) => ({
    state: "failed" as const,
    kind: "qa" as const,
    weeklyReviewId: request.weeklyReviewId,
    runId: request.runId,
    runVersion: request.runVersion,
    errorCode: "weekly_qa_provider_outcome_unknown"
  }));
  const runtimeService = {
    listGenerationRuns,
    listQaRuns,
    classifyGenerationRun: (run: WorkWeeklyRun) => classify(run),
    classifyQaRun: (run: WorkWeeklyQaRun) => classify(run),
    runGeneration,
    runQa,
    terminateGenerationUnknownOutcome,
    terminateQaUnknownOutcome
  } satisfies WorkWeeklyRuntimeService;
  const createRuntimeService = vi.fn(async (
    _env: Readonly<Record<string, string | undefined>>
  ) => runtimeService);
  const createRedis = vi.fn(() => ({
    connect: vi.fn(async () => undefined),
    ping: vi.fn(async () => "PONG"),
    get: vi.fn(async () => null),
    quit: redisQuit,
    disconnect: vi.fn()
  }));
  const createQueue = vi.fn(() => ({
    waitUntilReady: vi.fn(async () => undefined),
    getJob: vi.fn(input.getJob ?? (async () => null)),
    add,
    getJobCounts: vi.fn(async () => ({ waiting: 0, active: 0, failed: 0 })),
    getWorkersCount: vi.fn(async () => 1),
    close: queueClose
  }));
  const createWorker = vi.fn((_config, _connection, _queueName, handler) => {
    processor = handler;
    return {
      on: vi.fn(),
      run: vi.fn(() => workerRun),
      close: vi.fn(async () => resolveWorkerRun?.())
    };
  });
  const flags = input.flags ?? (() => ({
    weeklyAiEnabled: true,
    weeklyQaEnabled: true
  }));

  return {
    dependencies: {
      flags: vi.fn(flags),
      createRedis,
      createQueue,
      createWorker,
      verifyStorage: vi.fn(async () => undefined),
      createRuntimeService,
      workerId: () => "work-weekly:test-worker",
      now: () => NOW,
      logger: { info: vi.fn(), error: vi.fn() },
      setInterval: vi.fn((handler) => {
        intervalHandler = handler;
        return { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
      }),
      clearInterval: vi.fn()
    },
    add,
    createRedis,
    createRuntimeService,
    listGenerationRuns,
    listQaRuns,
    runGeneration,
    runQa,
    terminateGenerationUnknownOutcome,
    terminateQaUnknownOutcome,
    processor: () => processor!,
    intervalHandler: () => intervalHandler!,
    queueClose,
    redisQuit
  };
}

describe("Work Weekly Queue Runtime", () => {
  it("forwards only explicitly injected diagnostics through the existing service factory", async () => {
    const harness = runtimeHarness();
    const diagnosticSink = vi.fn(async () => undefined);
    const runtime = await startWorkWeeklyRuntime({ env: {}, config,
      dependencies: harness.dependencies, diagnosticSink });
    expect(harness.createRuntimeService).toHaveBeenCalledWith({}, diagnosticSink);
    await runtime?.close();
  });

  it("returns before Redis, Work DB service, or Provider runner when all gates are off", async () => {
    const harness = runtimeHarness({
      flags: () => ({ weeklyAiEnabled: false, weeklyQaEnabled: false })
    });

    await expect(startWorkWeeklyRuntime({
      env: {},
      config,
      dependencies: harness.dependencies
    })).resolves.toBeNull();

    expect(harness.createRedis).not.toHaveBeenCalled();
    expect(harness.createRuntimeService).not.toHaveBeenCalled();
  });

  it("enqueues only safe queued runs and reports expired active leases as outcome unknown", async () => {
    const harness = runtimeHarness({
      generationRuns: [generationRun("queued", "g1"), generationRun("processing", "g2")],
      qaRuns: [qaRun("queued", "q1"), qaRun("verifying", "q2")]
    });

    const runtime = await startWorkWeeklyRuntime({
      env: {},
      config,
      dependencies: harness.dependencies
    });

    expect(runtime?.recovery).toEqual({
      generationQueued: 1,
      qaQueued: 1,
      providerOutcomeUnknown: 2,
      providerOutcomeTerminated: 2,
      terminationFailed: 0,
      enqueued: 2,
      existing: 0
    });
    expect(harness.listGenerationRuns).toHaveBeenCalledWith(
      NOW,
      WORK_WEEKLY_RECOVERY_BATCH_SIZE_PER_KIND
    );
    expect(harness.listQaRuns).toHaveBeenCalledWith(
      NOW,
      WORK_WEEKLY_RECOVERY_BATCH_SIZE_PER_KIND
    );
    expect(harness.add).toHaveBeenCalledTimes(2);
    expect(harness.add.mock.calls.map((call) => call[0])).toEqual([
      WORK_WEEKLY_GENERATION_QUEUE_JOB_NAME,
      WORK_WEEKLY_QA_QUEUE_JOB_NAME
    ]);
    expect(harness.add.mock.calls.every((call) => call[2].attempts === 1)).toBe(true);
    expect(JSON.stringify(harness.dependencies.logger.info.mock.calls))
      .not.toMatch(/account_g1|weekly_g1|generation_run_g1|question_q1/u);

    const generationPayload = harness.add.mock.calls[0][1] as WorkWeeklyQueuePayload;
    await expect(harness.processor()({
      id: buildWorkWeeklyQueueJobId(generationPayload),
      name: WORK_WEEKLY_GENERATION_QUEUE_JOB_NAME,
      data: generationPayload
    })).resolves.toEqual({ status: "published", kind: "generation" });
    expect(harness.runGeneration).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "account_g1",
      runId: "generation_run_g1",
      leaseOwner: "work-weekly:test-worker",
      leaseMs: WORK_WEEKLY_RUN_LEASE_MS,
      observedState: "queued"
    }));

    const qaPayload = harness.add.mock.calls[1][1] as WorkWeeklyQueuePayload;
    await expect(harness.processor()({
      id: buildWorkWeeklyQueueJobId(qaPayload),
      name: WORK_WEEKLY_QA_QUEUE_JOB_NAME,
      data: qaPayload
    })).resolves.toEqual({ status: "published", kind: "qa" });
    expect(harness.runQa).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread_q1",
      questionMessageId: "question_q1",
      leaseMs: WORK_WEEKLY_RUN_LEASE_MS,
      observedState: "queued"
    }));

    await runtime?.close();
  });

  it("does not execute retained jobs after their feature gate is turned off", async () => {
    let enabled = true;
    const harness = runtimeHarness({
      flags: () => ({ weeklyAiEnabled: enabled, weeklyQaEnabled: enabled }),
      generationRuns: [generationRun()]
    });
    const runtime = await startWorkWeeklyRuntime({
      env: {}, config, dependencies: harness.dependencies
    });
    const payload = harness.add.mock.calls[0][1] as WorkWeeklyQueuePayload;
    enabled = false;

    await expect(harness.processor()({
      id: buildWorkWeeklyQueueJobId(payload),
      name: WORK_WEEKLY_GENERATION_QUEUE_JOB_NAME,
      data: payload
    })).resolves.toEqual({ status: "disabled", kind: "generation" });
    expect(harness.runGeneration).not.toHaveBeenCalled();

    await runtime?.close();
  });

  it("never scans or dispatches QA while the QA gate is off", async () => {
    const harness = runtimeHarness({
      flags: () => ({ weeklyAiEnabled: true, weeklyQaEnabled: false }),
      generationRuns: [generationRun("queued", "generation_only")],
      qaRuns: [qaRun("queued", "must_not_scan")]
    });
    const runtime = await startWorkWeeklyRuntime({
      env: {}, config, dependencies: harness.dependencies
    });

    expect(harness.listQaRuns).not.toHaveBeenCalled();
    expect(harness.add).toHaveBeenCalledTimes(1);
    expect(harness.add.mock.calls[0][0]).toBe(WORK_WEEKLY_GENERATION_QUEUE_JOB_NAME);

    await runtime?.close();
  });

  it("does not replay an expired active Core run from a retained waiting job", async () => {
    const expired = generationRun("processing", "expired");
    const payload = WorkWeeklyGenerationQueuePayloadSchema.parse({
      version: 1,
      kind: "generation",
      accountId: expired.accountId,
      weeklyReviewId: expired.weeklyReviewId,
      runId: expired.id,
      runVersion: expired.runVersion,
      sourceSnapshotDigest: expired.sourceSnapshotDigest
    });
    const harness = runtimeHarness({ generationRuns: [expired] });
    const runtime = await startWorkWeeklyRuntime({
      env: {}, config, dependencies: harness.dependencies
    });

    await expect(harness.processor()({
      id: buildWorkWeeklyQueueJobId(payload),
      name: WORK_WEEKLY_GENERATION_QUEUE_JOB_NAME,
      data: payload
    })).resolves.toEqual({ status: "stale_skipped", kind: "generation" });
    expect(harness.runGeneration).not.toHaveBeenCalled();
    expect(harness.terminateGenerationUnknownOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "generation_run_expired",
        observedState: "processing"
      })
    );

    await runtime?.close();
  });

  it("recovers a lost queue-add response without creating a second job", async () => {
    let lookups = 0;
    const harness = runtimeHarness({
      generationRuns: [generationRun("queued", "response_lost")],
      qaRuns: [],
      getJob: async () => {
        lookups += 1;
        return lookups === 1 ? null : { getState: async () => "waiting" };
      },
      add: async () => {
        throw new Error("redis_response_lost");
      }
    });

    const runtime = await startWorkWeeklyRuntime({
      env: {}, config, dependencies: harness.dependencies
    });
    expect(runtime?.recovery).toMatchObject({ enqueued: 0, existing: 1 });
    expect(harness.add).toHaveBeenCalledTimes(1);

    const payload = harness.add.mock.calls[0][1];
    await expect(harness.processor()({
      id: buildWorkWeeklyQueueJobId(payload),
      name: WORK_WEEKLY_GENERATION_QUEUE_JOB_NAME,
      data: payload
    })).resolves.toEqual({ status: "published", kind: "generation" });
    expect(harness.runGeneration).toHaveBeenCalledTimes(1);

    await runtime?.close();
  });

  it("rejects a mismatched transport job id without consuming the admitted run", async () => {
    const harness = runtimeHarness({
      generationRuns: [generationRun("queued", "transport_fence")]
    });
    const runtime = await startWorkWeeklyRuntime({
      env: {}, config, dependencies: harness.dependencies
    });
    const payload = harness.add.mock.calls[0][1];

    await expect(harness.processor()({
      id: "spoofed_transport_job",
      name: WORK_WEEKLY_GENERATION_QUEUE_JOB_NAME,
      data: payload
    })).resolves.toEqual({ status: "stale_skipped", kind: "generation" });
    expect(harness.runGeneration).not.toHaveBeenCalled();

    await expect(harness.processor()({
      id: buildWorkWeeklyQueueJobId(payload),
      name: WORK_WEEKLY_GENERATION_QUEUE_JOB_NAME,
      data: payload
    })).resolves.toEqual({ status: "published", kind: "generation" });
    expect(harness.runGeneration).toHaveBeenCalledTimes(1);

    await runtime?.close();
  });

  it("consumes one admission for a late tombstoned run and never retries it", async () => {
    const harness = runtimeHarness({
      generationRuns: [generationRun("queued", "deleted_late")]
    });
    harness.runGeneration.mockResolvedValueOnce({
      state: "not_claimed",
      kind: "generation",
      weeklyReviewId: "weekly_deleted_late",
      runId: "generation_run_deleted_late",
      runVersion: 1,
      errorCode: "weekly_generation_not_claimed"
    });
    const runtime = await startWorkWeeklyRuntime({
      env: {}, config, dependencies: harness.dependencies
    });
    const payload = harness.add.mock.calls[0][1];
    const job = {
      id: buildWorkWeeklyQueueJobId(payload),
      name: WORK_WEEKLY_GENERATION_QUEUE_JOB_NAME,
      data: payload
    };

    await expect(harness.processor()(job)).resolves.toEqual({
      status: "not_claimed",
      kind: "generation"
    });
    await expect(harness.processor()(job)).resolves.toEqual({
      status: "stale_skipped",
      kind: "generation"
    });
    expect(harness.runGeneration).toHaveBeenCalledTimes(1);

    await runtime?.close();
  });

  it("does not revive retained terminal or active transport jobs", async () => {
    let lookups = 0;
    const harness = runtimeHarness({
      generationRuns: [generationRun("queued", "terminal")],
      qaRuns: [qaRun("queued", "active")],
      getJob: async () => {
        lookups += 1;
        return lookups === 1
          ? { getState: async () => "failed" }
          : { getState: async () => "waiting" };
      }
    });

    const runtime = await startWorkWeeklyRuntime({
      env: {}, config, dependencies: harness.dependencies
    });

    expect(runtime?.recovery).toMatchObject({ enqueued: 0, existing: 2 });
    expect(harness.add).not.toHaveBeenCalled();

    await runtime?.close();
  });

  it("keeps periodic recovery single-flight and waits for it during shutdown", async () => {
    let resolveRecovery: ((value: ReturnType<typeof generationRun>[]) => void) | undefined;
    const pendingRecovery = new Promise<WorkWeeklyRun[]>((resolve) => {
      resolveRecovery = resolve;
    });
    const harness = runtimeHarness();
    harness.listGenerationRuns
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(pendingRecovery);

    const runtime = await startWorkWeeklyRuntime({
      env: {}, config, dependencies: harness.dependencies
    });
    harness.intervalHandler()();
    harness.intervalHandler()();
    expect(harness.listGenerationRuns).toHaveBeenCalledTimes(2);

    let closed = false;
    const closing = runtime!.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    resolveRecovery?.([]);
    await closing;
    await runtime!.close();
    expect(closed).toBe(true);
    expect(harness.queueClose).toHaveBeenCalledTimes(1);
    expect(harness.redisQuit).toHaveBeenCalledTimes(1);
  });

  it("fails closed for unknown job names", async () => {
    const harness = runtimeHarness({ generationRuns: [generationRun()] });
    const runtime = await startWorkWeeklyRuntime({
      env: {}, config, dependencies: harness.dependencies
    });
    const payload = harness.add.mock.calls[0][1] as WorkWeeklyQueuePayload;

    await expect(harness.processor()({
      name: "unexpected-work-weekly-job",
      data: payload
    })).rejects.toMatchObject({ name: "UnrecoverableError" });

    await runtime?.close();
  });

  it("cleans Queue and Redis when the Work runtime service cannot start", async () => {
    const harness = runtimeHarness();
    const failure = new Error("work_runtime_service_unavailable");
    harness.createRuntimeService.mockRejectedValueOnce(failure);

    await expect(startWorkWeeklyRuntime({
      env: {}, config, dependencies: harness.dependencies
    })).rejects.toBe(failure);

    expect(harness.queueClose).toHaveBeenCalledTimes(1);
    expect(harness.redisQuit).toHaveBeenCalledTimes(1);
  });
});
