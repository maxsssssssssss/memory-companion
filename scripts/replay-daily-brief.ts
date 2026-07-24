import { resolve } from "node:path";

import { loadRuntimeEnv } from "@/lib/server/env/runtime-env";

loadRuntimeEnv();

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : "unknown Daily Brief replay error")
    .replace(/((?:token|access_token|api_key|key|password)\s*[=:]\s*)[^\s&,]+/giu, "$1****")
    .replace(/([?&](?:token|access_token|api_key|key|password)=)[^&\s]+/giu, "$1****")
    .slice(0, 300);
}

async function main() {
  const [{ parseDailyBriefReplayArgs }, { runDailyBriefReplay }] = await Promise.all([
    import("@/lib/server/extraction/replay-cli"),
    import("@/lib/server/extraction/replay")
  ]);
  const options = parseDailyBriefReplayArgs(process.argv.slice(2), process.env);
  const provider = options.remote
    ? (await import("@/lib/server/extraction/openai-provider")).openaiExtractionProvider
    : undefined;
  const result = await runDailyBriefReplay({
    uploadId: options.uploadId,
    dataDir: resolve(options.dataDir),
    reportPath: resolve(options.reportPath),
    ...(options.userId ? { userId: options.userId } : {}),
    ...(provider ? { provider } : {}),
    remote: options.remote
  });
  console.info(JSON.stringify({
    ok: true,
    mode: result.report.mode,
    executionKind: result.report.execution.kind,
    uploadId: result.report.uploadId,
    reportPath: result.reportPath,
    items: result.report.replay.stats.finalItemCount,
    sourceArtifactsUnchanged: result.report.integrity.sourceArtifactsUnchanged
  }, null, 2));
}

main().catch((error) => {
  console.error(`[daily-brief-replay] failed: ${safeError(error)}`);
  process.exitCode = 1;
});
