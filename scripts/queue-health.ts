import { loadRuntimeEnv } from "@/lib/server/env/runtime-env";

loadRuntimeEnv();

async function main() {
  const [{ Queue }, { default: IORedis }, { getPipelineQueueConfig, sanitizedRedisEndpoint }] =
    await Promise.all([
      import("bullmq"),
      import("ioredis"),
      import("@/lib/server/queue/config")
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
    console.info(
      JSON.stringify(
        {
          ok: ping === "PONG",
          redis: sanitizedRedisEndpoint(config.redisUrl),
          queue: config.queueName,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          failed: counts.failed ?? 0
        },
        null,
        2
      )
    );
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
