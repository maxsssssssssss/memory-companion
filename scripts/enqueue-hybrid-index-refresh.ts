import { loadRuntimeEnv } from "@/lib/server/env/runtime-env";
import { enqueueEmbeddingIndexJob } from "@/lib/server/queue/producer";

loadRuntimeEnv();

const userIndex = process.argv.indexOf("--user");
const userRef = userIndex >= 0 ? process.argv[userIndex + 1]?.trim() : undefined;
if (!userRef || !/^[A-Za-z0-9_-]+$/u.test(userRef)) {
  throw new Error("Usage: npm run hybrid:index:refresh -- --user <user-id>");
}
const result = await enqueueEmbeddingIndexJob({
  version: 1,
  userRef,
  reason: "manual"
});
console.info(
  `[hybrid-index-enqueue] progress=1/1 user=${userRef} ` +
  `job_id=${result.jobId} enqueued=${result.enqueued}`
);
