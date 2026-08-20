import { loadRuntimeEnv } from "@/lib/server/env/runtime-env";
import type {
  DateCompanionMemoryBridgeDatabaseStats
} from "@/lib/server/date-companion/memory-bridge-health";

loadRuntimeEnv();

async function main() {
  const [
    { Queue },
    { default: IORedis },
    { getPipelineQueueConfig, sanitizedRedisEndpoint },
    { evaluatePipelineQueueHealth },
    { inspectQueueStorageProbe },
    { getDateCompanionMemoryBridgeRuntimeConfig },
    {
      evaluateDateCompanionMemoryBridgeHealth,
      inspectDateCompanionMemoryBridgeDatabaseStats,
      inspectDateCompanionMemoryBridgeRuntimeReport
    },
    { inspectDateCompanionMemoryBridgePreflight },
    { getDateCompanionDatabasePath },
    { DATE_COMPANION_SCHEMA_VERSION },
    { MEMORY_SCHEMA_VERSION },
    { default: Database }
  ] =
    await Promise.all([
      import("bullmq"),
      import("ioredis"),
      import("@/lib/server/queue/config"),
      import("@/lib/server/queue/health"),
      import("@/lib/server/queue/storage-probe"),
      import("@/lib/server/date-companion/memory-bridge-runtime-config"),
      import("@/lib/server/date-companion/memory-bridge-health"),
      import("@/lib/server/date-companion/memory-bridge-preflight"),
      import("@/lib/server/date-companion/db"),
      import("@/lib/server/date-companion/schema"),
      import("@/lib/server/memory/schema"),
      import("better-sqlite3")
    ]);
  const config = getPipelineQueueConfig();
  const memoryBridgeConfig = getDateCompanionMemoryBridgeRuntimeConfig();
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
    const preflight = memoryBridgeConfig.enabled
      ? inspectDateCompanionMemoryBridgePreflight({
          dataDirectory: memoryBridgeConfig.dataDirectory
        })
      : null;
    const runtimeReport = memoryBridgeConfig.enabled
      ? await inspectDateCompanionMemoryBridgeRuntimeReport({
          dataDirectory: memoryBridgeConfig.dataDirectory,
          staleAfterMs: Math.max(60_000, memoryBridgeConfig.pollIntervalMs * 3)
        })
      : { consumerRunning: false, report: null } as const;
    let memoryBridgeStats: DateCompanionMemoryBridgeDatabaseStats | undefined;
    if (preflight?.ok) {
      const database = new Database(
        getDateCompanionDatabasePath(memoryBridgeConfig.dataDirectory),
        { readonly: true, fileMustExist: true }
      );
      try {
        database.pragma("query_only = ON");
        database.pragma("busy_timeout = 5000");
        memoryBridgeStats = inspectDateCompanionMemoryBridgeDatabaseStats({ database });
      } finally {
        database.close();
      }
    }
    const dateCompanionSchemaVersion = preflight?.dateCompanion.schemaStatus === "compatible"
      ? preflight.dateCompanion.schemaVersions.at(-1) ?? null
      : null;
    const memorySchemaVersion = preflight?.memory.schemaStatus === "compatible"
      ? preflight.memory.schemaVersions.at(-1) ?? null
      : null;
    const memoryBridge = evaluateDateCompanionMemoryBridgeHealth({
      enabled: memoryBridgeConfig.enabled,
      consumerRunning: runtimeReport.consumerRunning && workerCount === 1,
      preflight: preflight?.ok ? "ok" : memoryBridgeConfig.enabled ? "invalid" : "not_required",
      dateCompanionSchemaVersion,
      memorySchemaVersion,
      expectedDateCompanionSchemaVersion: DATE_COMPANION_SCHEMA_VERSION,
      expectedMemorySchemaVersion: MEMORY_SCHEMA_VERSION,
      oldestPendingWarnMs: memoryBridgeConfig.oldestPendingHealthMs,
      failedCountThreshold: memoryBridgeConfig.failedCountThreshold,
      stats: memoryBridgeStats
    });
    const health = evaluatePipelineQueueHealth({
      executionMode: config.executionMode,
      redisPing: ping,
      workerCount,
      storageProbeStatus: storageProbe.status,
      recentFailedCount,
      memoryBridge
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
          storageProbe,
          memoryBridge: {
            ...memoryBridge,
            runtimeCounters: runtimeReport.report
              ? {
                  processed: runtimeReport.report.processed,
                  retried: runtimeReport.report.retried,
                  failed: runtimeReport.report.failed
                }
              : null,
            preflightChecks: preflight
              ? {
                  storage: preflight.storage,
                  dateCompanion: {
                    schemaStatus: preflight.dateCompanion.schemaStatus,
                    foreignKeyStatus: preflight.dateCompanion.foreignKeyStatus,
                    integrityStatus: preflight.dateCompanion.integrityStatus
                  },
                  memory: {
                    schemaStatus: preflight.memory.schemaStatus,
                    foreignKeyStatus: preflight.memory.foreignKeyStatus,
                    integrityStatus: preflight.memory.integrityStatus
                  },
                  errorCodes: preflight.errorCodes
                }
              : null
          }
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
