import type { JsonStore } from "@/lib/server/storage/json-store";

import {
  type DailyReflectionExecutionFence,
  type DailyReflectionPublishedAssetKind,
  type DailyReflectionRepository
} from "./repository";

export const DAILY_REFLECTION_ASSET_ATTEMPTS_COLLECTION =
  "daily-reflection-asset-attempts";

function collectionFor(kind: DailyReflectionPublishedAssetKind) {
  return kind === "upload" ? "uploads" : "segments";
}

export function dailyReflectionAssetAttemptId(input: {
  reflectionId: string;
  assetKind: DailyReflectionPublishedAssetKind;
  attemptVersion: number;
}) {
  return `${input.reflectionId}-${input.assetKind}-attempt-${input.attemptVersion}`;
}

export async function readDailyReflectionPublishedAsset<T>(input: {
  repository: DailyReflectionRepository;
  store: JsonStore;
  accountId: string;
  reflectionId: string;
  uploadId: string;
  assetKind: DailyReflectionPublishedAssetKind;
}) {
  const published = input.repository.readPublishedAsset<T>({
    accountId: input.accountId,
    reflectionId: input.reflectionId,
    assetKind: input.assetKind
  });
  if (published !== null) return published;
  // Compatibility for workflows created before the fenced publication table.
  return await input.store.read<T>(collectionFor(input.assetKind), input.uploadId);
}

export async function publishDailyReflectionAsset<T>(input: {
  repository: DailyReflectionRepository;
  store: JsonStore;
  accountId: string;
  reflectionId: string;
  uploadId: string;
  assetKind: DailyReflectionPublishedAssetKind;
  fence: DailyReflectionExecutionFence;
  payload: T;
  now?: string;
  beforePublish?: () => void | Promise<void>;
}) {
  const attemptId = dailyReflectionAssetAttemptId({
    reflectionId: input.reflectionId,
    assetKind: input.assetKind,
    attemptVersion: input.fence.attemptVersion
  });
  await input.store.write(DAILY_REFLECTION_ASSET_ATTEMPTS_COLLECTION, attemptId, {
    accountId: input.accountId,
    reflectionId: input.reflectionId,
    uploadId: input.uploadId,
    assetKind: input.assetKind,
    attemptVersion: input.fence.attemptVersion,
    payload: input.payload
  });
  try {
    await input.beforePublish?.();
    input.repository.publishAssetUnderExecutionFence({
      accountId: input.accountId,
      reflectionId: input.reflectionId,
      leaseOwner: input.fence.leaseOwner,
      attemptVersion: input.fence.attemptVersion,
      assetKind: input.assetKind,
      payload: input.payload,
      ...(input.now ? { now: input.now } : {})
    });
    const canonical = input.repository.readPublishedAsset<T>({
      accountId: input.accountId,
      reflectionId: input.reflectionId,
      assetKind: input.assetKind
    });
    if (canonical === null) throw new Error("daily_reflection_asset_publish_missing");
    // Existing consumers see a compatibility projection. Daily Reflection
    // readers always prefer the fenced SQLite publication above.
    await input.store.write(collectionFor(input.assetKind), input.uploadId, canonical);
    return canonical;
  } finally {
    await input.store.delete(DAILY_REFLECTION_ASSET_ATTEMPTS_COLLECTION, attemptId);
  }
}

export async function deleteDailyReflectionAssetAttempts(input: {
  store: JsonStore;
  reflectionId: string;
  accountId?: string;
  uploadId?: string;
  maxAttemptVersion?: number;
}) {
  const prefix = `${input.reflectionId}-`;
  const attempts = await input.store.list<{
    accountId?: unknown;
    reflectionId?: unknown;
    uploadId?: unknown;
    attemptVersion?: unknown;
  }>(
    DAILY_REFLECTION_ASSET_ATTEMPTS_COLLECTION
  );
  const matchingAttempts = attempts.filter(({ id, value }) =>
    id.startsWith(prefix)
    && (
      input.accountId === undefined
      || (
        value.accountId === input.accountId
        && value.reflectionId === input.reflectionId
        && value.uploadId === input.uploadId
      )
    )
    && (
      input.maxAttemptVersion === undefined
      || (
        Number.isInteger(value.attemptVersion)
        && (value.attemptVersion as number) <= input.maxAttemptVersion
      )
    )
  );
  await Promise.all(matchingAttempts.map(({ id }) =>
    input.store.delete(DAILY_REFLECTION_ASSET_ATTEMPTS_COLLECTION, id)
  ));
}
