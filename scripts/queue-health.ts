import { loadRuntimeEnv } from "@/lib/server/env/runtime-env";

loadRuntimeEnv();

async function main() {
  const [
    { Queue },
    { default: IORedis },
    { getPipelineQueueConfig, sanitizedRedisEndpoint },
    { evaluatePipelineQueueHealth },
    { inspectQueueStorageProbe }
  ] =
    await Promise.all([
      import("bullmq"),
      import("ioredis"),
      import("@/lib/server/queue/config"),
      import("@/lib/server/queue/health"),
      import("@/lib/server/queue/storage-probe")
    ]);
  const config = getPipelineQueueConfig();
  const redis = new IORedis(config.redisUrl, {
    lazyConnect: true,
    connectTimeout: 5_000,
    enableReadyCheck: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null
  });
  let queue: InstanceType<typeof Queue> | undefined;
  try {
    await redis.connect();
    const ping = await redis.ping();
    queue = new Queue(config.queueName, { connection: redis });
    await queue.waitUntilReady();
    const counts = await queue.getJobCounts("waiting", "active", "failed");
    const workerCount = await queue.getWorkersCount();
    const failedJobs = await queue.getJobs(
      ["failed"],
      0,
      Math.max(0, config.retention.failed.count - 1),
      false
    );
    const failedCutoff = Date.now() - config.failedHealthWindowMs;
    const recentFailedCount = failedJobs.filter((job) =>
      typeof job.finishedOn === "number" && job.finishedOn >= failedCutoff
    ).length;
    const storageProbe = await inspectQueueStorageProbe({ config, redis });
    const health = evaluatePipelineQueueHealth({
      executionMode: config.executionMode,
      redisPing: ping,
      workerCount,
      storageProbeStatus: storageProbe.status,
      recentFailedCount
    });
    console.info(
      JSON.stringify(
        {
          ok: health.ok,
          reasons: health.reasons,
          executionMode: config.executionMode,
          redis: sanitizedRedisEndpoint(config.redisUrl),
          queue: config.queueName,
          workers: workerCount,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          failed: counts.failed ?? 0,
          recentFailed: recentFailedCount,
          failedWindowMs: config.failedHealthWindowMs,
          storageProbe
        },
        null,
        2
      )
    );
    if (!health.ok) process.exitCode = 1;
  } finally {
    await queue?.close().catch(() => undefined);
    try {
      await redis.quit();
    } catch {
      redis.disconnect(false);
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(
    JSON.stringify({ ok: false, error: error instanceof Error ? error.name : "unknown" })
  );
  process.exitCode = 1;
}
