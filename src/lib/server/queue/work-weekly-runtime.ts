import { createHash, randomUUID } from "node:crypto";

import {
  Queue,
  UnrecoverableError,
  Worker,
  type Job,
  type JobsOptions
} from "bullmq";
import IORedis from "ioredis";

import type {
  WorkWeeklyQaRun,
  WorkWeeklyRun
} from "@/lib/domain/work-weekly";
import { resolveWorkReviewFeatureFlags } from "@/lib/server/work-review/runtime-config";
import type { WorkWeeklyDiagnosticSink } from "@/lib/server/work-review/weekly-evaluation-diagnostics";
import type {
  WorkWeeklyGenerationRunRequest,
  WorkWeeklyQaRunRequest,
  WorkWeeklyQaUnknownOutcomeTerminationRequest,
  WorkWeeklyRecoveryDisposition,
  WorkWeeklyRunResult,
  WorkWeeklyUnknownOutcomeTerminationRequest
} from "@/lib/server/work-review/weekly-ai-runner";

import { getPipelineQueueConfig, type PipelineQueueConfig } from "./config";
import { assertQueueStorageProbe } from "./storage-probe";
import {
  buildWorkWeeklyQueueJobId,
  WORK_WEEKLY_GENERATION_QUEUE_JOB_NAME,
  WORK_WEEKLY_QA_QUEUE_JOB_NAME,
  WorkWeeklyGenerationQueuePayloadSchema,
  WorkWeeklyQaQueuePayloadSchema,
  type WorkWeeklyQueuePayload,
  workWeeklyQueueJobName,
  workWeeklyQueueName
} from "./work-weekly-queue";

export const WORK_WEEKLY_RECOVERY_BATCH_SIZE_PER_KIND = 16 as const;
// Each pipeline performs at most two sequential Provider calls, and every
// profile timeout is capped at 120 seconds by the frozen runner contract.
// Keep this fixed lease above that four-minute upper bound; lease renewal must
// remain inside the runner because it owns the mutable publish fence.
export const WORK_WEEKLY_RUN_LEASE_MS = 10 * 60 * 1_000;
export const WORK_WEEKLY_MAX_STALLED_COUNT = 0 as const;

type WorkWeeklyRuntimeFlags = Pick<
  ReturnType<typeof resolveWorkReviewFeatureFlags>,
  "weeklyAiEnabled" | "weeklyQaEnabled"
>;

export type WorkWeeklyRuntimeService = {
  listGenerationRuns(now: string, limit: number): WorkWeeklyRun[] | Promise<WorkWeeklyRun[]>;
  listQaRuns(now: string, limit: number): WorkWeeklyQaRun[] | Promise<WorkWeeklyQaRun[]>;
  classifyGenerationRun(run: WorkWeeklyRun, now: Date): WorkWeeklyRecoveryDisposition;
  classifyQaRun(run: WorkWeeklyQaRun, now: Date): WorkWeeklyRecoveryDisposition;
  runGeneration(request: WorkWeeklyGenerationRunRequest): Promise<WorkWeeklyRunResult>;
  runQa(request: WorkWeeklyQaRunRequest): Promise<WorkWeeklyRunResult>;
  terminateGenerationUnknownOutcome(
    request: WorkWeeklyUnknownOutcomeTerminationRequest
  ): Promise<WorkWeeklyRunResult>;
  terminateQaUnknownOutcome(
    request: WorkWeeklyQaUnknownOutcomeTerminationRequest
  ): Promise<WorkWeeklyRunResult>;
};

type RedisAdapter = {
  connect(): Promise<unknown>;
  ping(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  quit(): Promise<unknown>;
  disconnect(reconnect?: boolean): void;
};

type QueueJobAdapter = {
  getState(): Promise<string>;
};

type QueueAdapter = {
  waitUntilReady(): Promise<unknown>;
  getJob(jobId: string): Promise<QueueJobAdapter | null | undefined>;
  add(
    name: string,
    data: WorkWeeklyQueuePayload,
    options: JobsOptions
  ): Promise<unknown>;
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
  getWorkersCount(): Promise<number>;
  close(): Promise<void>;
};

type WorkWeeklyWorkerResult = {
  status: WorkWeeklyRunResult["state"] | "disabled" | "stale_skipped";
  kind: "generation" | "qa";
};

type WorkerJob = {
  id?: string;
  name: string;
  data: WorkWeeklyQueuePayload;
};

type WorkerAdapter = {
  on(event: "active", listener: (job: WorkerJob) => void): unknown;
  on(
    event: "completed",
    listener: (job: WorkerJob, result: WorkWeeklyWorkerResult) => void
  ): unknown;
  on(
    event: "failed",
    listener: (job: WorkerJob | undefined, error: Error) => void
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  run(): Promise<void>;
  close(force?: boolean): Promise<void>;
};

type RuntimeLogger = Pick<Console, "info" | "error">;

export type WorkWeeklyRecoveryReport = {
  generationQueued: number;
  qaQueued: number;
  providerOutcomeUnknown: number;
  providerOutcomeTerminated: number;
  terminationFailed: number;
  enqueued: number;
  existing: number;
};

export type WorkWeeklyRuntimeHealth = {
  running: boolean;
  workers: number;
  waiting: number;
  active: number;
  failed: number;
};

export type WorkWeeklyRuntime = {
  readonly recovery: WorkWeeklyRecoveryReport;
  readonly runPromise: Promise<void>;
  getHealthSnapshot(): Promise<WorkWeeklyRuntimeHealth>;
  close(): Promise<void>;
};

export type WorkWeeklyRuntimeDependencies = {
  flags(env: Readonly<Record<string, string | undefined>>): WorkWeeklyRuntimeFlags;
  createRedis(config: PipelineQueueConfig): RedisAdapter;
  createQueue(
    config: PipelineQueueConfig,
    connection: RedisAdapter,
    queueName: string
  ): QueueAdapter;
  createWorker(
    config: PipelineQueueConfig,
    connection: RedisAdapter,
    queueName: string,
    processor: (job: WorkerJob) => Promise<WorkWeeklyWorkerResult>
  ): WorkerAdapter;
  verifyStorage(config: PipelineQueueConfig, connection: RedisAdapter): Promise<unknown>;
  createRuntimeService(
    env: Readonly<Record<string, string | undefined>>,
    diagnosticSink?: WorkWeeklyDiagnosticSink
  ): Promise<WorkWeeklyRuntimeService>;
  workerId(): string;
  now(): string;
  logger: RuntimeLogger;
  setInterval(handler: () => void, intervalMs: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
};

async function createDefaultRuntimeService(
  env: Readonly<Record<string, string | undefined>>,
  diagnosticSink?: WorkWeeklyDiagnosticSink
): Promise<WorkWeeklyRuntimeService> {
  const [databaseModule, serviceModule, runnerModule] = await Promise.all([
    import("@/lib/server/work-review/db"),
    import("@/lib/server/work-review/weekly-service"),
    import("@/lib/server/work-review/weekly-ai-runner")
  ]);
  const service = serviceModule.createWorkWeeklyService(
    databaseModule.getWorkReviewDatabase()
  );
  const repository = service.runtimeRepository();
  const executor = runnerModule.createConfiguredWorkWeeklyRunExecutor({
    repository,
    env,
    diagnosticSink,
    loadSnapshot: ({ accountId, weeklyReviewId }) => {
      const review = repository.getReview(accountId, weeklyReviewId);
      return service.buildSnapshot(accountId, {
        weekStart: review.scope.weekStart,
        timeZone: review.scope.timeZone,
        scopeKind: review.scope.scopeKind,
        projectId: review.scope.projectId
      });
    }
  });
  if (executor.contractVersion !== runnerModule.WORK_WEEKLY_RUNNER_CONTRACT_VERSION) {
    throw new Error("Unsupported Work Weekly runner contract");
  }
  return {
    listGenerationRuns: (now, limit) =>
      repository.listRecoverableGenerationRuns(now, limit),
    listQaRuns: (now, limit) => repository.listRecoverableQaRuns(now, limit),
    classifyGenerationRun: runnerModule.classifyWorkWeeklyGenerationRecovery,
    classifyQaRun: runnerModule.classifyWorkWeeklyQaRecovery,
    runGeneration: (request) => executor.runGeneration(request),
    runQa: (request) => executor.runQa(request),
    terminateGenerationUnknownOutcome: (request) =>
      executor.terminateGenerationUnknownOutcome(request),
    terminateQaUnknownOutcome: (request) =>
      executor.terminateQaUnknownOutcome(request)
  };
}

const defaultDependencies: WorkWeeklyRuntimeDependencies = {
  flags: resolveWorkReviewFeatureFlags,
  createRedis: (config) => new IORedis(config.redisUrl, {
    lazyConnect: true,
    connectTimeout: 10_000,
    enableReadyCheck: true,
    maxRetriesPerRequest: null
  }),
  createQueue: (_config, connection, queueName) => new Queue(queueName, {
    connection: connection as IORedis
  }) as unknown as QueueAdapter,
  createWorker: (_config, connection, queueName, processor) =>
    new Worker<WorkWeeklyQueuePayload, WorkWeeklyWorkerResult>(
      queueName,
      (job: Job<WorkWeeklyQueuePayload>) => processor(job),
      {
        connection: connection as IORedis,
        concurrency: 1,
        autorun: false,
        maxStalledCount: WORK_WEEKLY_MAX_STALLED_COUNT
      }
    ) as unknown as WorkerAdapter,
  verifyStorage: (config, connection) => assertQueueStorageProbe({
    config,
    redis: connection
  }),
  createRuntimeService: createDefaultRuntimeService,
  workerId: () => `work-weekly:${randomUUID()}`,
  now: () => new Date().toISOString(),
  logger: console,
  setInterval: (handler, intervalMs) => setInterval(handler, intervalMs),
  clearInterval: (timer) => clearInterval(timer)
};

function queueOptions(config: PipelineQueueConfig): JobsOptions {
  return {
    attempts: 1,
    removeOnComplete: config.retention.completed,
    removeOnFail: config.retention.failed
  };
}

function redactedJobToken(jobId: string | undefined) {
  return createHash("sha256")
    .update(jobId ?? "unknown")
    .digest("hex")
    .slice(0, 16);
}

async function closeRedis(connection: RedisAdapter) {
  try {
    await connection.quit();
  } catch {
    connection.disconnect(false);
  }
}

function runtimeEnabled(flags: WorkWeeklyRuntimeFlags) {
  return flags.weeklyAiEnabled || flags.weeklyQaEnabled;
}

function hasUnknownOutcomeState<T extends { state: string }>(
  run: T
): run is T & { state: "processing" | "verifying" } {
  return run.state === "processing" || run.state === "verifying";
}

export async function startWorkWeeklyRuntime(
  options: {
    env?: Record<string, string | undefined>;
    config?: PipelineQueueConfig;
    dependencies?: Partial<WorkWeeklyRuntimeDependencies>;
    diagnosticSink?: WorkWeeklyDiagnosticSink;
  } = {}
): Promise<WorkWeeklyRuntime | null> {
  const env = options.env ?? process.env;
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const initialFlags = dependencies.flags(env);
  if (!runtimeEnabled(initialFlags)) return null;

  const config = options.config ?? getPipelineQueueConfig(env);
  if (config.executionMode !== "queue") {
    throw new Error("Work Weekly runtime requires queue execution mode");
  }

  const connection = dependencies.createRedis(config);
  const queueName = workWeeklyQueueName(config);
  let queue: QueueAdapter | undefined;
  let worker: WorkerAdapter | undefined;
  try {
    await connection.connect();
    await connection.ping();
    await dependencies.verifyStorage(config, connection);
    queue = dependencies.createQueue(config, connection, queueName);
    await queue.waitUntilReady();

    const service = options.diagnosticSink
      ? await dependencies.createRuntimeService(env, options.diagnosticSink)
      : await dependencies.createRuntimeService(env);
    const workerId = dependencies.workerId();
    const admittedJobIds = new Set<string>();
    const processor = async (job: WorkerJob): Promise<WorkWeeklyWorkerResult> => {
      const currentFlags = dependencies.flags(env);
      if (job.name === WORK_WEEKLY_GENERATION_QUEUE_JOB_NAME) {
        const payload = WorkWeeklyGenerationQueuePayloadSchema.parse(job.data);
        const expectedJobId = buildWorkWeeklyQueueJobId(payload);
        if (job.id !== expectedJobId || !admittedJobIds.delete(expectedJobId)) {
          return { status: "stale_skipped", kind: "generation" };
        }
        if (!currentFlags.weeklyAiEnabled) {
          return { status: "disabled", kind: "generation" };
        }
        const result = await service.runGeneration({
          accountId: payload.accountId,
          weeklyReviewId: payload.weeklyReviewId,
          runId: payload.runId,
          runVersion: payload.runVersion,
          sourceSnapshotDigest: payload.sourceSnapshotDigest,
          leaseOwner: workerId,
          leaseMs: WORK_WEEKLY_RUN_LEASE_MS,
          observedState: "queued"
        });
        if (result.state === "failed") {
          throw new UnrecoverableError("Work Weekly generation failed");
        }
        return { status: result.state, kind: "generation" };
      }
      if (job.name === WORK_WEEKLY_QA_QUEUE_JOB_NAME) {
        const payload = WorkWeeklyQaQueuePayloadSchema.parse(job.data);
        const expectedJobId = buildWorkWeeklyQueueJobId(payload);
        if (job.id !== expectedJobId || !admittedJobIds.delete(expectedJobId)) {
          return { status: "stale_skipped", kind: "qa" };
        }
        if (!currentFlags.weeklyQaEnabled) {
          return { status: "disabled", kind: "qa" };
        }
        const result = await service.runQa({
          accountId: payload.accountId,
          weeklyReviewId: payload.weeklyReviewId,
          runId: payload.runId,
          runVersion: payload.runVersion,
          sourceSnapshotDigest: payload.sourceSnapshotDigest,
          threadId: payload.threadId,
          questionMessageId: payload.questionMessageId,
          leaseOwner: workerId,
          leaseMs: WORK_WEEKLY_RUN_LEASE_MS,
          observedState: "queued"
        });
        if (result.state === "failed") {
          throw new UnrecoverableError("Work Weekly QA failed");
        }
        return { status: result.state, kind: "qa" };
      }
      throw new UnrecoverableError("Unknown Work Weekly queue job");
    };

    worker = dependencies.createWorker(
      config,
      connection,
      queueName,
      processor
    );
    worker.on("active", (job) => {
      dependencies.logger.info(
        `[work-weekly-worker] active job_token=${redactedJobToken(job.id)}`
      );
    });
    worker.on("completed", (job, result) => {
      dependencies.logger.info(
        `[work-weekly-worker] completed job_token=${redactedJobToken(job.id)} ` +
        `kind=${result.kind} status=${result.status}`
      );
    });
    worker.on("failed", (job, error) => {
      dependencies.logger.error(
        `[work-weekly-worker] failed job_token=${redactedJobToken(job?.id)} ` +
        `error_name=${error.name}`
      );
    });
    worker.on("error", (error) => {
      dependencies.logger.error(
        `[work-weekly-worker] runtime_error error_name=${error.name}`
      );
    });

    const recoverOnce = async (): Promise<WorkWeeklyRecoveryReport> => {
      const currentFlags = dependencies.flags(env);
      if (!runtimeEnabled(currentFlags)) {
        return {
          generationQueued: 0,
          qaQueued: 0,
          providerOutcomeUnknown: 0,
          providerOutcomeTerminated: 0,
          terminationFailed: 0,
          enqueued: 0,
          existing: 0
        };
      }
      const now = dependencies.now();
      const generationRuns = currentFlags.weeklyAiEnabled
        ? await service.listGenerationRuns(now, WORK_WEEKLY_RECOVERY_BATCH_SIZE_PER_KIND)
        : [];
      const qaRuns = currentFlags.weeklyQaEnabled
        ? await service.listQaRuns(now, WORK_WEEKLY_RECOVERY_BATCH_SIZE_PER_KIND)
        : [];
      const recoveryTime = new Date(now);
      if (Number.isNaN(recoveryTime.getTime())) {
        throw new Error("Invalid Work Weekly recovery clock");
      }
      const generationQueued = generationRuns.filter((run) =>
        service.classifyGenerationRun(run, recoveryTime) === "execute_queued"
      );
      const qaQueued = qaRuns.filter((run) =>
        service.classifyQaRun(run, recoveryTime) === "execute_queued"
      );
      const unknownGenerationRuns = generationRuns.filter((run): run is WorkWeeklyRun & {
        state: "processing" | "verifying";
      } =>
        service.classifyGenerationRun(run, recoveryTime) === "terminate_unknown_outcome"
          && hasUnknownOutcomeState(run)
      );
      const unknownQaRuns = qaRuns.filter((run): run is WorkWeeklyQaRun & {
        state: "processing" | "verifying";
      } =>
        service.classifyQaRun(run, recoveryTime) === "terminate_unknown_outcome"
          && hasUnknownOutcomeState(run)
      );
      const providerOutcomeUnknown = unknownGenerationRuns.length + unknownQaRuns.length;
      let providerOutcomeTerminated = 0;
      let terminationFailed = 0;
      for (const run of unknownGenerationRuns) {
        try {
          const result = await service.terminateGenerationUnknownOutcome({
            accountId: run.accountId,
            weeklyReviewId: run.weeklyReviewId,
            runId: run.id,
            runVersion: run.runVersion,
            sourceSnapshotDigest: run.sourceSnapshotDigest,
            leaseOwner: workerId,
            leaseMs: WORK_WEEKLY_RUN_LEASE_MS,
            observedState: run.state
          });
          if (result.state === "failed") providerOutcomeTerminated += 1;
        } catch (error) {
          terminationFailed += 1;
          dependencies.logger.error(
            `[work-weekly-worker] unknown_outcome_termination_failed kind=generation ` +
            `error_name=${error instanceof Error ? error.name : "unknown"}`
          );
        }
      }
      for (const run of unknownQaRuns) {
        try {
          const result = await service.terminateQaUnknownOutcome({
            accountId: run.accountId,
            weeklyReviewId: run.weeklyReviewId,
            runId: run.id,
            runVersion: run.runVersion,
            sourceSnapshotDigest: run.sourceSnapshotDigest,
            threadId: run.threadId,
            questionMessageId: run.questionMessageId,
            leaseOwner: workerId,
            leaseMs: WORK_WEEKLY_RUN_LEASE_MS,
            observedState: run.state
          });
          if (result.state === "failed") providerOutcomeTerminated += 1;
        } catch (error) {
          terminationFailed += 1;
          dependencies.logger.error(
            `[work-weekly-worker] unknown_outcome_termination_failed kind=qa ` +
            `error_name=${error instanceof Error ? error.name : "unknown"}`
          );
        }
      }
      const payloads: WorkWeeklyQueuePayload[] = [
        ...generationQueued.map((run) => WorkWeeklyGenerationQueuePayloadSchema.parse({
          version: 1,
          kind: "generation",
          accountId: run.accountId,
          weeklyReviewId: run.weeklyReviewId,
          runId: run.id,
          runVersion: run.runVersion,
          sourceSnapshotDigest: run.sourceSnapshotDigest
        })),
        ...qaQueued.map((run) => WorkWeeklyQaQueuePayloadSchema.parse({
          version: 1,
          kind: "qa",
          accountId: run.accountId,
          weeklyReviewId: run.weeklyReviewId,
          runId: run.id,
          runVersion: run.runVersion,
          sourceSnapshotDigest: run.sourceSnapshotDigest,
          threadId: run.threadId,
          questionMessageId: run.questionMessageId
        }))
      ];
      let enqueued = 0;
      let existing = 0;
      for (const payload of payloads) {
        const jobId = buildWorkWeeklyQueueJobId(payload);
        const existingJob = await queue!.getJob(jobId);
        if (existingJob) {
          // Retained active and terminal transport receipts are both durable
          // dedupe evidence. Runtime never revives them automatically: a
          // pre-claim crash must not become an unbounded periodic retry, while
          // post-claim ambiguity is already fenced in the Core run state.
          const state = await existingJob.getState();
          if (state !== "completed" && state !== "failed") {
            admittedJobIds.add(jobId);
          }
          existing += 1;
          continue;
        }
        admittedJobIds.add(jobId);
        try {
          await queue!.add(
            workWeeklyQueueJobName(payload),
            payload,
            { ...queueOptions(config), jobId }
          );
          enqueued += 1;
        } catch (error) {
          const persisted = await queue!.getJob(jobId).catch(() => undefined);
          if (persisted) {
            existing += 1;
            continue;
          }
          admittedJobIds.delete(jobId);
          throw error;
        }
      }
      return {
        generationQueued: generationQueued.length,
        qaQueued: qaQueued.length,
        providerOutcomeUnknown,
        providerOutcomeTerminated,
        terminationFailed,
        enqueued,
        existing
      };
    };

    const recovery = await recoverOnce();
    dependencies.logger.info(
      `[work-weekly-worker] ready queue=${queueName} concurrency=1 ` +
      `recovered=${recovery.enqueued}/${recovery.generationQueued + recovery.qaQueued} ` +
      `provider_outcome_unknown=${recovery.providerOutcomeUnknown} ` +
      `provider_outcome_terminated=${recovery.providerOutcomeTerminated} ` +
      `termination_failed=${recovery.terminationFailed}`
    );

    let running = true;
    let closing = false;
    const runPromise = worker.run().finally(() => {
      running = false;
    });
    let periodicRecovery: Promise<void> | null = null;
    const recoveryTimer = dependencies.setInterval(() => {
      if (closing || periodicRecovery || !runtimeEnabled(dependencies.flags(env))) return;
      periodicRecovery = recoverOnce()
        .then((report) => {
          dependencies.logger.info(
            `[work-weekly-worker] recovery recovered=${report.enqueued}/` +
            `${report.generationQueued + report.qaQueued} existing=${report.existing} ` +
            `provider_outcome_unknown=${report.providerOutcomeUnknown} ` +
            `provider_outcome_terminated=${report.providerOutcomeTerminated} ` +
            `termination_failed=${report.terminationFailed}`
          );
        })
        .catch((error: unknown) => {
          dependencies.logger.error(
            `[work-weekly-worker] recovery_failed ` +
            `error_name=${error instanceof Error ? error.name : "unknown"}`
          );
        })
        .finally(() => {
          periodicRecovery = null;
        });
    }, config.recoveryIntervalMs);
    recoveryTimer.unref?.();

    let closePromise: Promise<void> | undefined;
    return {
      recovery,
      runPromise,
      async getHealthSnapshot() {
        const counts = await queue!.getJobCounts("waiting", "active", "failed");
        return {
          running,
          workers: await queue!.getWorkersCount(),
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          failed: counts.failed ?? 0
        };
      },
      close() {
        closePromise ??= (async () => {
          closing = true;
          running = false;
          dependencies.clearInterval(recoveryTimer);
          await worker!.close();
          await runPromise.catch(() => undefined);
          await periodicRecovery?.catch(() => undefined);
          admittedJobIds.clear();
          await queue!.close();
          await closeRedis(connection);
          dependencies.logger.info("[work-weekly-worker] shutdown_completed");
        })();
        return closePromise;
      }
    };
  } catch (error) {
    await worker?.close(true).catch(() => undefined);
    await queue?.close().catch(() => undefined);
    await closeRedis(connection);
    throw error;
  }
}
