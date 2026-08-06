import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const outputDirectory = resolve(process.cwd(), ".data", "evaluation", "queue-worker-v1");
const workspaceDirectory = join(outputDirectory, "workspace");
const generatedAt = new Date().toISOString();
const queueName = `daily-brief-pipeline-smoke-${Date.now()}`;

const runtimeEnv = process.env as Record<string, string | undefined>;
runtimeEnv.NODE_ENV = "test";
runtimeEnv.APP_DATA_DIR = workspaceDirectory;
runtimeEnv.APP_STORAGE_MODE = "server";
runtimeEnv.EVALUATION_MODE = "true";
runtimeEnv.PIPELINE_EXECUTION_MODE = "queue";
runtimeEnv.PIPELINE_QUEUE_NAME = queueName;
runtimeEnv.PIPELINE_WORKER_CONCURRENCY = "1";
runtimeEnv.PIPELINE_JOB_ATTEMPTS = "3";
runtimeEnv.PIPELINE_JOB_BACKOFF_MS = "100";
runtimeEnv.PIPELINE_PROCESSING_STALE_MS = "60000";
runtimeEnv.REDIS_URL ||= "redis://127.0.0.1:6380";
runtimeEnv.PROACTIVE_INSIGHT_PROVIDER = "none";
runtimeEnv.MEMORY_RELEVANCE_PROVIDER = "none";

type SmokeReport = {
  version: 1;
  generatedAt: string;
  queueName: string;
  stableQueueJobId?: string;
  assertions: Record<string, boolean>;
  counters: Record<string, number>;
  recovery?: unknown;
  checkpoint?: unknown;
  evidenceFirst?: unknown;
  health?: unknown;
  final?: unknown;
  error?: string;
};

const report: SmokeReport = {
  version: 1,
  generatedAt,
  queueName,
  assertions: {},
  counters: {}
};

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) {
      return value;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Queue smoke timed out after ${timeoutMs}ms`);
}

async function writeReports() {
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, "report.json"), JSON.stringify(report, null, 2), "utf8");
  await writeFile(
    join(outputDirectory, "recovery-report.json"),
    JSON.stringify(report.recovery ?? { unavailable: true }, null, 2),
    "utf8"
  );
  const assertionLines = Object.entries(report.assertions)
    .map(([name, passed]) => `- ${name}: ${passed ? "PASS" : "FAIL"}`)
    .join("\n");
  await writeFile(
    join(outputDirectory, "report.md"),
    `# Queue / Worker Smoke v1\n\n` +
      `Generated: ${generatedAt}\n\n` +
      `Queue: ${queueName}\n\n` +
      `This is a local Redis test with deterministic mock providers. Remote provider calls: 0.\n\n` +
      `The startup scanner reprojects stale product state. When the stable Bull job still exists as active, it is not duplicated; the replacement Worker resumes it through BullMQ stalled-job recovery.\n\n` +
      `## Assertions\n\n${assertionLines}\n\n` +
      `## Counters\n\n\`\`\`json\n${JSON.stringify(report.counters, null, 2)}\n\`\`\`\n\n` +
      `## Recovery\n\n\`\`\`json\n${JSON.stringify(report.recovery, null, 2)}\n\`\`\`\n\n` +
      `## Checkpoint\n\n\`\`\`json\n${JSON.stringify(report.checkpoint, null, 2)}\n\`\`\`\n\n` +
      `## Evidence First\n\n\`\`\`json\n${JSON.stringify(report.evidenceFirst, null, 2)}\n\`\`\`\n`,
    "utf8"
  );
}

async function main() {
  await rm(workspaceDirectory, { recursive: true, force: true });
  await mkdir(workspaceDirectory, { recursive: true });

  const [
    { Queue, Worker },
    { default: IORedis },
    { JsonStore },
    { getUserScopedStore },
    { createJob, updateJob },
    { processUpload },
    { ruleAudioInsightProvider },
    { ruleExtractionProvider },
    { JsonAnalysisChunkCheckpointStore },
    { createPipelineJobProcessor },
    { recoverPipelineJobs },
    { enqueuePipelineJob },
    { getPipelineQueueConfig },
    { buildPipelineJobId },
    { evaluatePipelineQueueHealth },
    {
      assertQueueStorageProbe,
      clearQueueWorkerStorageProbe,
      inspectQueueStorageProbe,
      publishQueueWorkerStorageProbe
    }
  ] = await Promise.all([
    import("bullmq"),
    import("ioredis"),
    import("@/lib/server/storage/json-store"),
    import("@/lib/server/auth/session"),
    import("@/lib/server/jobs/job-store"),
    import("@/lib/server/pipeline/process-upload"),
    import("@/lib/server/audio-insights/rule-provider"),
    import("@/lib/server/extraction/rule-provider"),
    import("@/lib/server/analysis-chunks/checkpoint"),
    import("@/lib/server/queue/worker"),
    import("@/lib/server/queue/recovery"),
    import("@/lib/server/queue/producer"),
    import("@/lib/server/queue/config"),
    import("@/lib/server/queue/types"),
    import("@/lib/server/queue/health"),
    import("@/lib/server/queue/storage-probe")
  ]);

  const config = getPipelineQueueConfig();
  const userRef = "queue_smoke_user";
  const uploadId = "queue_smoke_upload";
  const payload = { version: 1 as const, uploadId, userRef };
  const queueJobId = buildPipelineJobId(payload);
  report.stableQueueJobId = queueJobId;

  const rootStore = new JsonStore(workspaceDirectory);
  await rootStore.write("users", userRef, { id: userRef, email: "queue-smoke@example.invalid" });
  const store = getUserScopedStore(userRef);
  const uploadsDirectory = join(workspaceDirectory, "users", userRef, "uploads");
  await mkdir(uploadsDirectory, { recursive: true });
  const audioPath = join(uploadsDirectory, `${uploadId}.wav`);
  await writeFile(audioPath, "local queue smoke audio", "utf8");
  await store.write("uploads", uploadId, {
    id: uploadId,
    originalName: "queue-smoke.wav",
    mimeType: "audio/wav",
    sizeBytes: 23,
    recordingDate: "2026-07-16",
    createdAt: generatedAt,
    status: "uploaded",
    filePath: audioPath,
    evaluationRetention: true
  });
  await createJob(store, uploadId, {
    executionMode: "queue",
    queueJobId,
    queuedAt: generatedAt,
    now: () => generatedAt
  });

  let pipelineCalls = 0;
  let transcriptionProviderCalls = 0;
  let audioInsightProviderCalls = 0;
  let extractionProviderCalls = 0;
  let firstExtractionReachedResolve: (() => void) | undefined;
  const firstExtractionReached = new Promise<void>((resolvePromise) => {
    firstExtractionReachedResolve = resolvePromise;
  });

  const segments = [
    {
      id: `${uploadId}_segment_1`,
      uploadId,
      startSeconds: 0,
      endSeconds: 12,
      speaker: "speaker_1",
      text: "周六晚上我会帮你检查简历，并把修改建议发给你。",
      confidence: 0.99,
      sceneLabels: ["product_discussion" as const],
      valueLabels: ["commitment" as const]
    },
    {
      id: `${uploadId}_segment_2`,
      uploadId,
      startSeconds: 310,
      endSeconds: 322,
      speaker: "speaker_2",
      text: "好，我们周日中午再确认最终版本。",
      confidence: 0.99,
      sceneLabels: ["product_discussion" as const],
      valueLabels: ["task" as const]
    }
  ];

  const dependencies = {
    transcriptionProvider: {
      async transcribe() {
        transcriptionProviderCalls += 1;
        return segments;
      }
    },
    audioInsightProvider: {
      async analyze(currentUploadId: string, currentSegments: typeof segments) {
        audioInsightProviderCalls += 1;
        return await ruleAudioInsightProvider.analyze(currentUploadId, currentSegments);
      }
    },
    acousticFeatureExtractor: async () => [],
    emotionSignalProvider: { analyze: async () => [] },
    extractionProvider: {
      async extract(currentUploadId: string, currentSegments: typeof segments) {
        extractionProviderCalls += 1;
        if (extractionProviderCalls === 1) {
          firstExtractionReachedResolve?.();
          return await new Promise<never>(() => undefined);
        }
        return await ruleExtractionProvider.extract(currentUploadId, currentSegments);
      }
    },
    relationshipSignalProvider: { analyze: async () => [] }
  };

  const processor = createPipelineJobProcessor({
    getStore: () => store,
    runProcessUpload: async (input) => {
      pipelineCalls += 1;
      return await processUpload({ ...input, dependencies });
    }
  });

  const firstWorkerConnection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  await firstWorkerConnection.ping();
  const firstWorkerStorage = await publishQueueWorkerStorageProbe({
    config,
    redis: firstWorkerConnection,
    workerId: "queue-smoke-worker-1"
  });
  report.assertions.sharedStorageProbeMatchedBeforeEnqueue = (
    await assertQueueStorageProbe({ config, redis: firstWorkerConnection })
  ).status === "matched";
  let firstEnqueue: Awaited<ReturnType<typeof enqueuePipelineJob>>;
  try {
    firstEnqueue = await enqueuePipelineJob(payload, { config });
  } catch (error) {
    await clearQueueWorkerStorageProbe({
      config,
      redis: firstWorkerConnection,
      workerId: firstWorkerStorage.workerId
    }).catch(() => undefined);
    firstWorkerConnection.disconnect(false);
    throw error;
  }
  report.assertions.enqueueSucceeded = firstEnqueue.enqueued && firstEnqueue.jobId === queueJobId;

  const queueConnection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(config.queueName, { connection: queueConnection });
  const firstWorker = new Worker(config.queueName, processor, {
    connection: firstWorkerConnection,
    concurrency: 1,
    lockDuration: 1_000,
    stalledInterval: 500,
    maxStalledCount: 2
  });
  firstWorker.on("error", () => undefined);
  await firstExtractionReached;

  const checkpointsBeforeCrash = await new JsonAnalysisChunkCheckpointStore(store).list({
    userId: userRef,
    uploadId,
    kind: "audio_insight"
  });
  const callsBeforeCrash = audioInsightProviderCalls;
  report.assertions.twoAnalysisChunksCompletedBeforeCrash =
    checkpointsBeforeCrash.length === 2 && checkpointsBeforeCrash.every((item) => item.status === "completed");

  await firstWorker.close(true);
  firstWorkerConnection.disconnect(false);

  const activeProductJob = await store.read<import("@/lib/domain/types").ProcessingJob>(
    "jobs-by-upload",
    uploadId
  );
  if (!activeProductJob) {
    throw new Error("Product job disappeared during crash simulation");
  }
  await updateJob(store, activeProductJob, { updatedAt: "2000-01-01T00:00:00.000Z" });
  const recovery = await recoverPipelineJobs(
    {
      enqueue: (recoveryPayload, enqueueOptions) =>
        enqueuePipelineJob(recoveryPayload, {
          config,
          reviveTerminal: enqueueOptions.reviveTerminal
        }),
      staleAfterMs: 0
    },
    { rootStore, getStore: () => store }
  );
  report.recovery = recovery;
  const recoveredProductJob = await store.read<import("@/lib/domain/types").ProcessingJob>(
    "jobs-by-upload",
    uploadId
  );
  report.assertions.startupRecoveryDetectedStaleProcessing =
    recovery.enqueued === 0 &&
    recovery.existing === 1 &&
    recoveredProductJob?.status === "waiting";

  const secondWorkerConnection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  await secondWorkerConnection.ping();
  const secondWorkerStorage = await publishQueueWorkerStorageProbe({
    config,
    redis: secondWorkerConnection,
    workerId: "queue-smoke-worker-2"
  });
  report.assertions.workerRestartRepublishedSharedStorageProbe = (
    await assertQueueStorageProbe({ config, redis: secondWorkerConnection })
  ).status === "matched";
  const secondWorker = new Worker(config.queueName, processor, {
    connection: secondWorkerConnection,
    concurrency: 1,
    lockDuration: 1_000,
    stalledInterval: 500,
    maxStalledCount: 2
  });
  secondWorker.on("error", () => undefined);

  const readyJob = await waitFor(async () => {
    const current = await store.read<import("@/lib/domain/types").ProcessingJob>(
      "jobs-by-upload",
      uploadId
    );
    return current?.status === "ready" ? current : null;
  });
  const completedQueueJob = await waitFor(async () => {
    const current = await queue.getJob(queueJobId);
    return current && (await current.getState()) === "completed" ? current : null;
  });

  const duplicateEnqueue = await enqueuePipelineJob(payload, { config });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  const healthPing = await secondWorkerConnection.ping();
  const healthWorkerCount = await queue.getWorkersCount();
  const healthProbe = await inspectQueueStorageProbe({
    config,
    redis: secondWorkerConnection
  });
  const healthFailedJobs = await queue.getJobs(
    ["failed"],
    0,
    Math.max(0, config.retention.failed.count - 1),
    false
  );
  const healthFailedCutoff = Date.now() - config.failedHealthWindowMs;
  const healthRecentFailedCount = healthFailedJobs.filter((job) =>
    typeof job.finishedOn === "number" && job.finishedOn >= healthFailedCutoff
  ).length;
  const health = evaluatePipelineQueueHealth({
    executionMode: config.executionMode,
    redisPing: healthPing,
    workerCount: healthWorkerCount,
    storageProbeStatus: healthProbe.status,
    recentFailedCount: healthRecentFailedCount
  });
  report.assertions.queueHealthAcceptedOneMatchingWorker = health.ok;
  report.health = {
    ...health,
    redisPing: healthPing,
    workerCount: healthWorkerCount,
    storageProbeStatus: healthProbe.status,
    recentFailedCount: healthRecentFailedCount
  };
  const checkpointsAfterRecovery = await new JsonAnalysisChunkCheckpointStore(store).list({
    userId: userRef,
    uploadId,
    kind: "audio_insight"
  });
  const auditReport = await store.read<Record<string, unknown>>("evaluation-reports", uploadId);
  const evidenceFirst = (auditReport?.evidenceFirst ?? null) as Record<string, unknown> | null;

  report.assertions.workerRecoveredToReady = readyJob.status === "ready";
  report.assertions.queueJobCompleted = (await completedQueueJob.getState()) === "completed";
  report.assertions.bullProgressReached100 = completedQueueJob.progress === 100;
  report.assertions.duplicateEnqueueDidNotExecute = !duplicateEnqueue.enqueued && pipelineCalls === 2;
  report.assertions.completedProviderChunksWereNotRepeated =
    callsBeforeCrash === 2 && audioInsightProviderCalls === callsBeforeCrash;
  report.assertions.completedTranscriptionWasNotRepeated = transcriptionProviderCalls === 1;
  report.assertions.completedCheckpointsWereHits = checkpointsAfterRecovery.every(
    (item) => item.status === "completed" && item.attemptCount === 1
  );
  report.assertions.evidenceFirstViolationsAreZero = Boolean(
    evidenceFirst &&
      evidenceFirst.invalidSourceIds === 0 &&
      evidenceFirst.nonVerbatimQuotes === 0 &&
      evidenceFirst.duplicateEvidence === 0 &&
      evidenceFirst.memoriesWithoutEvidence === 0 &&
      evidenceFirst.orphanEvidence === 0
  );

  report.counters = {
    pipelineCalls,
    transcriptionProviderCalls,
    audioInsightProviderCalls,
    extractionProviderCalls,
    analysisCheckpointCount: checkpointsAfterRecovery.length,
    remoteProviderCalls: 0
  };
  report.checkpoint = {
    beforeCrash: checkpointsBeforeCrash.map((item) => ({
      id: item.id,
      status: item.status,
      attemptCount: item.attemptCount
    })),
    afterRecovery: checkpointsAfterRecovery.map((item) => ({
      id: item.id,
      status: item.status,
      attemptCount: item.attemptCount
    })),
    providerCallsBeforeCrash: callsBeforeCrash,
    providerCallsAfterRecovery: audioInsightProviderCalls
  };
  report.evidenceFirst = evidenceFirst;
  report.final = {
    productJobStatus: readyJob.status,
    productProgress: readyJob.progress,
    bullJobState: await completedQueueJob.getState(),
    bullProgress: completedQueueJob.progress,
    firstEnqueue,
    duplicateEnqueue
  };

  await secondWorker.close();
  await clearQueueWorkerStorageProbe({
    config,
    redis: secondWorkerConnection,
    workerId: secondWorkerStorage.workerId
  });
  await secondWorkerConnection.quit();
  await queue.obliterate({ force: true });
  await queue.close();
  await queueConnection.quit();

  const failedAssertions = Object.entries(report.assertions).filter(([, passed]) => !passed);
  if (failedAssertions.length > 0) {
    throw new Error(`Queue smoke assertions failed: ${failedAssertions.map(([name]) => name).join(", ")}`);
  }
}

try {
  await main();
} catch (error) {
  report.error = error instanceof Error ? error.message : "unknown queue smoke error";
  process.exitCode = 1;
} finally {
  await writeReports();
  console.info(`Queue worker smoke report: ${join(outputDirectory, "report.md")}`);
}
