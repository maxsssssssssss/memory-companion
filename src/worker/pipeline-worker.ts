import { loadRuntimeEnv } from "@/lib/server/env/runtime-env";
import { getPipelineQueueConfig } from "@/lib/server/queue/config";
import {
  acquireLocalWorkerLease,
  localWorkerLeasePath
} from "@/lib/server/queue/local-worker-lease";

loadRuntimeEnv();

async function main() {
  const queueConfig = getPipelineQueueConfig();
  const lease = await acquireLocalWorkerLease({
    enabled: true,
    filePath: localWorkerLeasePath(queueConfig.dataDirectory),
    role: "worker"
  });
  try {
    const [
      { startPipelineWorker },
      { startDateCompanionSensitiveAudioCleanupRuntime },
      { isDateCompanionVoiceEnrollmentRuntimeAvailable }
    ] = await Promise.all([
      import("@/lib/server/queue/runtime"),
      import("@/lib/server/date-companion/sensitive-audio-cleanup-runtime"),
      import("@/lib/server/date-companion/voice-enrollment")
    ]);
    const runtimes: Array<{
      runPromise: Promise<void>;
      close(): Promise<void>;
    }> = [
      await startPipelineWorker(),
      // Sensitive audio retention is a storage invariant, not a Provider
      // feature. It remains active even when voice enrollment is disabled.
      startDateCompanionSensitiveAudioCleanupRuntime()
    ];
    if (isDateCompanionVoiceEnrollmentRuntimeAvailable()) {
      const { startDateCompanionVoiceEnrollmentWorker } = await import(
        "@/lib/server/date-companion/voice-enrollment-runtime"
      );
      runtimes.push(startDateCompanionVoiceEnrollmentWorker());
    }

    await new Promise<void>((resolve, reject) => {
      let shuttingDown = false;
      const closeRuntimes = async () => {
        const results = await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
        const rejected = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected"
        );
        if (rejected) throw rejected.reason;
      };
      const shutdown = (signal: "SIGINT" | "SIGTERM") => {
        if (shuttingDown) {
          return;
        }
        shuttingDown = true;
        console.info(`[pipeline-worker] received ${signal}`);
        void closeRuntimes()
          .catch((error: unknown) => {
            console.error(
              `[pipeline-worker] shutdown failed error_name=${error instanceof Error ? error.name : "unknown"}`
            );
          })
          .finally(resolve);
      };
      process.once("SIGINT", () => shutdown("SIGINT"));
      process.once("SIGTERM", () => shutdown("SIGTERM"));

      void Promise.race(runtimes.map(async (runtime, index) => {
        await runtime.runPromise;
        throw new Error(`worker runtime ${index + 1} stopped unexpectedly`);
      })).catch(async (error: unknown) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.error(
          `[pipeline-worker] runtime stopped error_name=${error instanceof Error ? error.name : "unknown"}`
        );
        try {
          await closeRuntimes();
        } catch (closeError) {
          console.error(
            `[pipeline-worker] runtime cleanup failed error_name=${closeError instanceof Error ? closeError.name : "unknown"}`
          );
        }
        reject(error);
      });
    });
  } finally {
    await lease.release();
  }
}

try {
  await main();
} catch (error) {
  console.error(
    `[pipeline-worker] startup failed error_name=${error instanceof Error ? error.name : "unknown"}`
  );
  process.exitCode = 1;
}
