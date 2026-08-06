import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import type { PipelineQueueConfig } from "./config";

const MARKER_VERSION = 1 as const;
const MARKER_DIRECTORY = "queue-runtime";
const MARKER_FILE = "shared-storage-marker.json";

export type QueueStorageMarker = {
  version: typeof MARKER_VERSION;
  storageId: string;
  createdAt: string;
};

export type QueueWorkerStorageSummary = {
  version: typeof MARKER_VERSION;
  queueName: string;
  storageId: string;
  workerId: string;
  startedAt: string;
};

export type QueueStorageProbeRedis = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
};

export type QueueStorageProbeStatus =
  | { status: "matched"; markerFingerprint: string; workerId: string }
  | { status: "worker_probe_missing"; markerFingerprint: string }
  | {
      status: "storage_mismatch";
      markerFingerprint: string;
      workerMarkerFingerprint: string;
    }
  | { status: "worker_probe_invalid"; markerFingerprint: string };

function markerPath(dataDirectory: string) {
  return join(dataDirectory, MARKER_DIRECTORY, MARKER_FILE);
}

function parseMarker(raw: string): QueueStorageMarker {
  const value = JSON.parse(raw) as Partial<QueueStorageMarker>;
  if (
    value.version !== MARKER_VERSION
    || typeof value.storageId !== "string"
    || !/^[A-Za-z0-9_-]{16,128}$/u.test(value.storageId)
    || typeof value.createdAt !== "string"
    || !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new Error("Invalid queue shared-storage marker");
  }
  return value as QueueStorageMarker;
}

function parseWorkerSummary(raw: string): QueueWorkerStorageSummary {
  const value = JSON.parse(raw) as Partial<QueueWorkerStorageSummary>;
  if (
    value.version !== MARKER_VERSION
    || typeof value.queueName !== "string"
    || typeof value.storageId !== "string"
    || typeof value.workerId !== "string"
    || typeof value.startedAt !== "string"
    || !Number.isFinite(Date.parse(value.startedAt))
  ) {
    throw new Error("Invalid queue Worker storage summary");
  }
  return value as QueueWorkerStorageSummary;
}

export function queueStorageMarkerFingerprint(storageId: string) {
  return createHash("sha256").update(storageId).digest("hex").slice(0, 16);
}

export function queueWorkerStorageProbeKey(queueName: string) {
  return `daily-brief:${queueName}:worker-storage-v1`;
}

export async function ensureQueueStorageMarker(
  dataDirectory: string,
  options: {
    now?: () => string;
    storageId?: () => string;
  } = {}
) {
  const path = markerPath(dataDirectory);
  await mkdir(join(dataDirectory, MARKER_DIRECTORY), { recursive: true });
  const marker: QueueStorageMarker = {
    version: MARKER_VERSION,
    storageId: options.storageId?.() ?? randomUUID(),
    createdAt: options.now?.() ?? new Date().toISOString()
  };
  try {
    await writeFile(path, JSON.stringify(marker), { encoding: "utf8", flag: "wx", mode: 0o600 });
    return marker;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
  }

  // A second process can observe EEXIST while the creator is still flushing
  // the small marker. Retry bounded reads rather than accepting partial JSON.
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return parseMarker(await readFile(path, "utf8"));
    } catch (error) {
      lastError = error;
      await wait(10 * (attempt + 1));
    }
  }
  throw lastError;
}

export async function publishQueueWorkerStorageProbe(input: {
  config: PipelineQueueConfig;
  redis: QueueStorageProbeRedis;
  workerId?: string;
  now?: () => string;
}) {
  const marker = await ensureQueueStorageMarker(input.config.dataDirectory, {
    now: input.now
  });
  const summary: QueueWorkerStorageSummary = {
    version: MARKER_VERSION,
    queueName: input.config.queueName,
    storageId: marker.storageId,
    workerId: input.workerId ?? randomUUID(),
    startedAt: input.now?.() ?? new Date().toISOString()
  };
  await input.redis.set(
    queueWorkerStorageProbeKey(input.config.queueName),
    JSON.stringify(summary)
  );
  return summary;
}

export async function inspectQueueStorageProbe(input: {
  config: PipelineQueueConfig;
  redis: Pick<QueueStorageProbeRedis, "get">;
}): Promise<QueueStorageProbeStatus> {
  const marker = await ensureQueueStorageMarker(input.config.dataDirectory);
  const markerFingerprint = queueStorageMarkerFingerprint(marker.storageId);
  const rawSummary = await input.redis.get(
    queueWorkerStorageProbeKey(input.config.queueName)
  );
  if (!rawSummary) return { status: "worker_probe_missing", markerFingerprint };
  let summary: QueueWorkerStorageSummary;
  try {
    summary = parseWorkerSummary(rawSummary);
  } catch {
    return { status: "worker_probe_invalid", markerFingerprint };
  }
  if (summary.queueName !== input.config.queueName || summary.storageId !== marker.storageId) {
    return {
      status: "storage_mismatch",
      markerFingerprint,
      workerMarkerFingerprint: queueStorageMarkerFingerprint(summary.storageId)
    };
  }
  return {
    status: "matched",
    markerFingerprint,
    workerId: summary.workerId
  };
}

export async function assertQueueStorageProbe(input: {
  config: PipelineQueueConfig;
  redis: Pick<QueueStorageProbeRedis, "get">;
}) {
  const result = await inspectQueueStorageProbe(input);
  if (result.status !== "matched") {
    throw new Error(`Queue shared-storage probe failed: ${result.status}`);
  }
  return result;
}

export async function clearQueueWorkerStorageProbe(input: {
  config: PipelineQueueConfig;
  redis: Pick<QueueStorageProbeRedis, "get" | "del">;
  workerId: string;
}) {
  const key = queueWorkerStorageProbeKey(input.config.queueName);
  const raw = await input.redis.get(key);
  if (!raw) return;
  try {
    const summary = parseWorkerSummary(raw);
    if (summary.workerId === input.workerId) await input.redis.del(key);
  } catch {
    // Do not delete an invalid or foreign value without ownership proof.
  }
}
