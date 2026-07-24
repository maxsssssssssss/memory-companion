import { resolve } from "node:path";

import { loadRuntimeEnv } from "@/lib/server/env/runtime-env";

loadRuntimeEnv();

function safeError(error: unknown) {
  return (error instanceof Error ? error.message : "unknown Relationship replay error")
    .replace(/((?:token|access_token|api_key|key|password)\s*[=:]\s*)[^\s&,]+/giu, "$1****")
    .replace(/([?&](?:token|access_token|api_key|key|password)=)[^&\s]+/giu, "$1****")
    .slice(0, 300);
}

async function main() {
  const [{ parseRelationshipReplayArgs }, { runRelationshipReplay }] = await Promise.all([
    import("@/lib/server/relationship-signals/replay-cli"),
    import("@/lib/server/relationship-signals/replay")
  ]);
  const options = parseRelationshipReplayArgs(process.argv.slice(2), process.env);
  const provider = options.remote
    ? (await import("@/lib/server/relationship-signals/provider")).getRelationshipSignalProvider()
    : undefined;
  const result = await runRelationshipReplay({
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
    uploadId: result.report.uploadId,
    reportPath: result.reportPath,
    cards: result.report.stats.cardCount,
    retries: result.report.stats.retrySuccessChunks,
    fallbacks: result.report.stats.fallbackChunks,
    sourceArtifactsUnchanged: result.report.integrity.sourceArtifactsUnchanged
  }, null, 2));
}

main().catch((error) => {
  console.error(`[relationship-replay] failed: ${safeError(error)}`);
  process.exitCode = 1;
});
