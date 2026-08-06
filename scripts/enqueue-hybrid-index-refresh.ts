import { loadRuntimeEnv } from "@/lib/server/env/runtime-env";

loadRuntimeEnv();

const { enqueueEmbeddingIndexJob } = await import("@/lib/server/queue/producer");
const {
  getPipelineQueueConfig,
  sanitizedRedisEndpoint
} = await import("@/lib/server/queue/config");
const { appStore } = await import("@/lib/server/storage/json-store");

const queueConfig = getPipelineQueueConfig();
console.info(
  `[hybrid-index-enqueue] queue=${queueConfig.queueName} ` +
  `redis=${sanitizedRedisEndpoint(queueConfig.redisUrl)}`
);

const userIndex = process.argv.indexOf("--user");
const userRef = userIndex >= 0 ? process.argv[userIndex + 1]?.trim() : undefined;
const allUsers = process.argv.includes("--all");
if (allUsers === Boolean(userRef) || (userRef && !/^[A-Za-z0-9_-]+$/u.test(userRef))) {
  throw new Error("Usage: npm run hybrid:index:refresh -- (--all | --user <user-id>)");
}

const userRefs = allUsers
  ? (await appStore.list<{ id?: string }>("users")).map((record) =>
      typeof record.value.id === "string" && record.value.id.trim()
        ? record.value.id
        : record.id
    )
  : [userRef!];

let enqueued = 0;
for (const [index, targetUser] of userRefs.entries()) {
  const result = await enqueueEmbeddingIndexJob({
    version: 1,
    userRef: targetUser,
    reason: "manual"
  });
  if (result.enqueued) enqueued += 1;
  console.info(
    `[hybrid-index-enqueue] progress=${index + 1}/${userRefs.length} ` +
    `status=${result.enqueued ? "enqueued" : "coalesced"}`
  );
}
console.info(
  `[hybrid-index-enqueue] completed=${userRefs.length}/${userRefs.length} ` +
  `enqueued=${enqueued} coalesced=${userRefs.length - enqueued}`
);
