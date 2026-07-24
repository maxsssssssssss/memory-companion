import { loadRuntimeEnv } from "@/lib/server/env/runtime-env";
import { acquireLocalWorkerLease } from "@/lib/server/queue/local-worker-lease";

loadRuntimeEnv();

async function main() {
  const lease = await acquireLocalWorkerLease({ role: "worker" });
  try {
    const { startPipelineWorker } = await import("@/lib/server/queue/runtime");
    const runtime = await startPipelineWorker();

    await new Promise<void>((resolve) => {
      let shuttingDown = false;
      const shutdown = (signal: "SIGINT" | "SIGTERM") => {
        if (shuttingDown) {
          return;
        }
        shuttingDown = true;
        console.info(`[pipeline-worker] received ${signal}`);
        void runtime
          .close()
          .catch((error: unknown) => {
            console.error(
              `[pipeline-worker] shutdown failed error_name=${error instanceof Error ? error.name : "unknown"}`
            );
          })
          .finally(resolve);
      };
      process.once("SIGINT", () => shutdown("SIGINT"));
      process.once("SIGTERM", () => shutdown("SIGTERM"));
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
