import * as fs from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";

import type { JsonStore } from "@/lib/server/storage/json-store";
import { cleanupGeneratedAudioChunks } from "@/lib/server/transcription/chunks/audio-planner";
import { JsonChunkCheckpointStore } from "@/lib/server/transcription/chunks/checkpoint-store";

import {
  DAILY_REFLECTION_JOBS_COLLECTION,
  DailyReflectionJobSchema
} from "./job-store";
import {
  deleteDailyReflectionAssetAttempts,
  readDailyReflectionPublishedAsset
} from "./published-assets";
import type {
  DailyReflectionExecutionFence,
  DailyReflectionRepository
} from "./repository";
import { isDailyReflectionTombstone } from "./state-machine";
import {
  isDailyReflectionUploadRecord,
  type StoredDailyReflectionUpload
} from "./upload-record";

const STORE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/u;

type DailyReflectionDeletedUploadMarker = {
  uploadId: string;
  reflectionId: string;
  filePath: string | null;
  deletedAt: string;
  ingestionContext: "daily_reflection";
  cleanupStatus: "pending" | "complete";
};

export class DailyReflectionCleanupOwnershipError extends Error {
  readonly code = "daily_reflection_cleanup_ownership_mismatch";

  constructor() {
    super("Daily Reflection cleanup target is not owned by the reflection");
  }
}

function isOwnedUploadPath(filePath: string, uploadsRootDir: string) {
  const root = resolve(uploadsRootDir);
  const candidate = resolve(filePath);
  return candidate.startsWith(`${root}${sep}`);
}

export async function cleanupDailyReflectionUploadPersistenceFailure(input: {
  store: JsonStore;
  repository: DailyReflectionRepository;
  accountId: string;
  reflectionId: string;
  uploadId: string;
  uploadsRootDir: string;
  persistedFilePath?: string;
  attemptVersion?: number;
}) {
  const upload = await readDailyReflectionPublishedAsset<StoredDailyReflectionUpload>({
    repository: input.repository,
    store: input.store,
    accountId: input.accountId,
    reflectionId: input.reflectionId,
    uploadId: input.uploadId,
    assetKind: "upload"
  });
  if (!upload) {
    if (
      input.persistedFilePath
      && isOwnedUploadPath(input.persistedFilePath, input.uploadsRootDir)
    ) {
      await fs.rm(input.persistedFilePath, { force: true });
    }
    await input.store.delete(DAILY_REFLECTION_JOBS_COLLECTION, input.reflectionId);
    await deleteDailyReflectionAssetAttempts({
      store: input.store,
      reflectionId: input.reflectionId
    });
    return;
  }
  if (
    !isDailyReflectionUploadRecord(upload)
    || upload.id !== input.uploadId
    || upload.reflectionId !== input.reflectionId
    || !isOwnedUploadPath(upload.filePath, input.uploadsRootDir)
  ) {
    throw new DailyReflectionCleanupOwnershipError();
  }
  if (
    input.attemptVersion !== undefined
    && upload.persistenceAttemptVersion !== input.attemptVersion
  ) {
    if (
      input.persistedFilePath
      && isOwnedUploadPath(input.persistedFilePath, input.uploadsRootDir)
    ) {
      await fs.rm(input.persistedFilePath, { force: true });
    }
    return;
  }
  if (
    input.persistedFilePath
    && isOwnedUploadPath(input.persistedFilePath, input.uploadsRootDir)
  ) {
    await fs.rm(input.persistedFilePath, { force: true });
  }
  await fs.rm(upload.filePath, { force: true });
  await Promise.all([
    input.store.delete("uploads", input.uploadId),
    input.store.delete(DAILY_REFLECTION_JOBS_COLLECTION, input.reflectionId)
  ]);
  input.repository.deletePublishedAsset(
    input.accountId,
    input.reflectionId,
    "upload"
  );
  await deleteDailyReflectionAssetAttempts({
    store: input.store,
    reflectionId: input.reflectionId
  });
}

export async function cleanupDailyReflectionCompletedAudio(input: {
  store: JsonStore;
  repository: DailyReflectionRepository;
  accountId: string;
  reflectionId: string;
  uploadId: string;
  uploadsRootDir: string;
  removeFile?: typeof fs.rm;
}) {
  const reflection = input.repository.getReflection(
    input.accountId,
    input.reflectionId
  );
  const plan = input.repository.getProcessingPlan(
    input.accountId,
    input.reflectionId
  );
  if (
    reflection.status !== "review_pending"
    || reflection.accountId !== input.accountId
    || reflection.id !== input.reflectionId
    || plan?.ingestionContext !== "daily_reflection"
    || plan.reflectionId !== input.reflectionId
    || plan.uploadId !== input.uploadId
  ) {
    throw new DailyReflectionCleanupOwnershipError();
  }

  const upload = await readDailyReflectionPublishedAsset<StoredDailyReflectionUpload>({
    repository: input.repository,
    store: input.store,
    accountId: input.accountId,
    reflectionId: input.reflectionId,
    uploadId: input.uploadId,
    assetKind: "upload"
  });
  if (
    !upload
    || !isDailyReflectionUploadRecord(upload)
    || upload.id !== input.uploadId
    || upload.reflectionId !== input.reflectionId
    || typeof upload.filePath !== "string"
    || !isOwnedUploadPath(upload.filePath, input.uploadsRootDir)
  ) {
    throw new DailyReflectionCleanupOwnershipError();
  }

  const checkpoints = new JsonChunkCheckpointStore(input.store);
  const audioChunks = await checkpoints.listAudioChunks(input.uploadId);
  const chunkDirectory = join(dirname(upload.filePath), `${input.uploadId}-chunks`);
  if (!isOwnedUploadPath(chunkDirectory, input.uploadsRootDir)) {
    throw new DailyReflectionCleanupOwnershipError();
  }
  const generatedPaths = audioChunks.flatMap((chunk) =>
    chunk.source.type === "generated_chunk" && chunk.source.path
      ? [chunk.source.path]
      : []
  );
  if (generatedPaths.some((filePath) =>
    !isOwnedUploadPath(filePath, chunkDirectory))) {
    throw new DailyReflectionCleanupOwnershipError();
  }

  const removeFile = input.removeFile ?? fs.rm;
  await removeAttemptAudioFiles({
    uploadId: input.uploadId,
    uploadsRootDir: input.uploadsRootDir,
    removeFile
  });
  await removeFile(upload.filePath, { force: true });
  for (const filePath of generatedPaths) {
    await removeFile(filePath, { force: true });
  }
  await removeFile(chunkDirectory, { recursive: true, force: true });
  await checkpoints.deleteUpload(input.uploadId);
  await deleteDailyReflectionAssetAttempts({
    store: input.store,
    reflectionId: input.reflectionId,
    accountId: input.accountId,
    uploadId: input.uploadId
  });
}

async function removeAttemptAudioFiles(input: {
  uploadId: string;
  uploadsRootDir: string;
  maxAttemptVersion?: number;
  removeFile?: typeof fs.rm;
}) {
  if (!STORE_KEY_PATTERN.test(input.uploadId)) {
    throw new DailyReflectionCleanupOwnershipError();
  }
  const prefix = `${input.uploadId}.attempt-`;
  const escapedUploadId = input.uploadId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const attemptPattern = new RegExp(
    `^${escapedUploadId}\\.attempt-(\\d+)(?:\\.[^/\\\\]*)?$`,
    "u"
  );
  const entries = await fs.readdir(input.uploadsRootDir, { withFileTypes: true })
    .catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
    if (input.maxAttemptVersion !== undefined) {
      const match = attemptPattern.exec(entry.name);
      if (!match || Number(match[1]) > input.maxAttemptVersion) continue;
    }
    const candidate = join(input.uploadsRootDir, entry.name);
    if (!isOwnedUploadPath(candidate, input.uploadsRootDir)) {
      throw new DailyReflectionCleanupOwnershipError();
    }
    await (input.removeFile ?? fs.rm)(candidate, { force: true });
  }
}

function isOwnedProvisionalAttemptPath(input: {
  filePath: string;
  uploadsRootDir: string;
  uploadId: string;
  attemptVersion: number;
}) {
  if (resolve(dirname(input.filePath)) !== resolve(input.uploadsRootDir)) {
    return false;
  }
  const escapedUploadId = input.uploadId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(
    `^${escapedUploadId}\\.attempt-(\\d+)(?:\\.[^/\\\\]*)?$`,
    "u"
  ).exec(basename(input.filePath));
  return Boolean(match && Number(match[1]) === input.attemptVersion);
}

export async function cleanupDailyReflectionBoundUploadAttemptAudio(input: {
  store: JsonStore;
  repository: DailyReflectionRepository;
  accountId: string;
  reflectionId: string;
  uploadId: string;
  uploadsRootDir: string;
  maxAttemptVersion: number;
  executionFence: DailyReflectionExecutionFence;
  renewExecutionFence?: () => void;
  removeFile?: typeof fs.rm;
}) {
  const reflection = input.repository.getReflection(
    input.accountId,
    input.reflectionId
  );
  const plan = input.repository.getProcessingPlan(
    input.accountId,
    input.reflectionId
  );
  if (
    reflection.inputMethod !== "browser_recording"
    || reflection.status !== "uploading"
    || reflection.uploadId !== input.uploadId
    || plan?.reflectionId !== input.reflectionId
    || plan.uploadId !== input.uploadId
    || plan.ingestionContext !== "daily_reflection"
    || plan.inputMethod !== "browser_recording"
    || input.maxAttemptVersion !== input.executionFence.attemptVersion - 1
    || input.maxAttemptVersion < 1
  ) {
    throw new DailyReflectionCleanupOwnershipError();
  }
  const renewAndAssertFence = () => {
    input.renewExecutionFence?.();
    input.repository.assertExecutionLease({
      accountId: input.accountId,
      reflectionId: input.reflectionId,
      leaseOwner: input.executionFence.leaseOwner,
      attemptVersion: input.executionFence.attemptVersion
    });
  };
  renewAndAssertFence();
  const publishedUpload = await readDailyReflectionPublishedAsset<unknown>({
    repository: input.repository,
    store: input.store,
    accountId: input.accountId,
    reflectionId: input.reflectionId,
    uploadId: input.uploadId,
    assetKind: "upload"
  });
  if (publishedUpload !== null) {
    throw new DailyReflectionCleanupOwnershipError();
  }
  renewAndAssertFence();
  await removeAttemptAudioFiles({
    uploadId: input.uploadId,
    uploadsRootDir: input.uploadsRootDir,
    maxAttemptVersion: input.maxAttemptVersion,
    ...(input.removeFile ? { removeFile: input.removeFile } : {})
  });
  renewAndAssertFence();
  await deleteDailyReflectionAssetAttempts({
    store: input.store,
    reflectionId: input.reflectionId,
    accountId: input.accountId,
    uploadId: input.uploadId,
    maxAttemptVersion: input.maxAttemptVersion
  });
  renewAndAssertFence();
}

export async function hasDailyReflectionProvisionalAssets(input: {
  store: JsonStore;
  repository: DailyReflectionRepository;
  accountId: string;
  reflectionId: string;
  uploadId: string;
  uploadsRootDir: string;
  maxAttemptVersion: number;
}) {
  const ownership = input.repository.getProvisionalUploadOwnership(
    input.accountId,
    input.reflectionId
  );
  if (
    !ownership
    || ownership.uploadId !== input.uploadId
    || !Number.isInteger(input.maxAttemptVersion)
    || input.maxAttemptVersion < 0
    || input.maxAttemptVersion > ownership.attemptVersion
    || !STORE_KEY_PATTERN.test(input.uploadId)
  ) {
    throw new DailyReflectionCleanupOwnershipError();
  }
  const escapedUploadId = input.uploadId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const attemptPattern = new RegExp(
    `^${escapedUploadId}\\.attempt-(\\d+)(?:\\.[^/\\\\]*)?$`,
    "u"
  );
  const entries = await fs.readdir(input.uploadsRootDir, { withFileTypes: true })
    .catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
  if (entries.some((entry) => {
    if (!entry.isFile()) return false;
    const match = attemptPattern.exec(entry.name);
    return Boolean(match && Number(match[1]) <= input.maxAttemptVersion);
  })) {
    return true;
  }
  const checkpoints = new JsonChunkCheckpointStore(input.store);
  const [upload, segments, job, audioChunks, transcriptChunks, attempts, chunkEntries] =
    await Promise.all([
      input.store.read<unknown>("uploads", input.uploadId),
      input.store.read<unknown>("segments", input.uploadId),
      input.store.read<unknown>(DAILY_REFLECTION_JOBS_COLLECTION, input.reflectionId),
      checkpoints.listAudioChunks(input.uploadId),
      checkpoints.listTranscriptChunks(input.uploadId),
      input.store.list<{
        accountId?: unknown;
        reflectionId?: unknown;
        uploadId?: unknown;
        attemptVersion?: unknown;
      }>("daily-reflection-asset-attempts"),
      fs.readdir(join(input.uploadsRootDir, `${input.uploadId}-chunks`))
        .catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return [];
          }
          throw error;
        })
    ]);
  return upload !== null
    || segments !== null
    || job !== null
    || audioChunks.length > 0
    || transcriptChunks.length > 0
    || chunkEntries.length > 0
    || attempts.some(({ value }) =>
      value.accountId === input.accountId
      && value.reflectionId === input.reflectionId
      && value.uploadId === input.uploadId
      && Number.isInteger(value.attemptVersion)
      && (value.attemptVersion as number) <= input.maxAttemptVersion
    );
}

export async function cleanupDailyReflectionProvisionalAssets(input: {
  store: JsonStore;
  repository: DailyReflectionRepository;
  accountId: string;
  reflectionId: string;
  uploadId: string;
  uploadsRootDir: string;
  maxAttemptVersion: number;
  executionFence?: DailyReflectionExecutionFence;
  renewExecutionFence?: () => void;
  tombstone?: boolean;
  now?: () => string;
  removeFile?: typeof fs.rm;
}) {
  const ownership = input.repository.getProvisionalUploadOwnership(
    input.accountId,
    input.reflectionId
  );
  if (
    !ownership
    || ownership.uploadId !== input.uploadId
    || !Number.isInteger(input.maxAttemptVersion)
    || input.maxAttemptVersion < 0
    || input.maxAttemptVersion > ownership.attemptVersion
    || (!input.tombstone && !input.executionFence)
    || (
      input.tombstone
      && !isDailyReflectionTombstone(ownership.status)
    )
  ) {
    throw new DailyReflectionCleanupOwnershipError();
  }
  const assertFence = () => {
    if (!input.executionFence) return;
    if (ownership.attemptVersion !== input.executionFence.attemptVersion) {
      throw new DailyReflectionCleanupOwnershipError();
    }
    input.repository.assertExecutionLease({
      accountId: input.accountId,
      reflectionId: input.reflectionId,
      leaseOwner: input.executionFence.leaseOwner,
      attemptVersion: input.executionFence.attemptVersion
    });
  };
  const renewAndAssertFence = () => {
    input.renewExecutionFence?.();
    assertFence();
  };
  renewAndAssertFence();

  const checkpoints = new JsonChunkCheckpointStore(input.store);
  const [rawUpload, rawJob, audioChunks] = await Promise.all([
    input.store.read<unknown>("uploads", input.uploadId),
    input.store.read<unknown>(DAILY_REFLECTION_JOBS_COLLECTION, input.reflectionId),
    checkpoints.listAudioChunks(input.uploadId)
  ]);
  const upload = rawUpload === null
    ? null
    : isDailyReflectionUploadRecord(rawUpload)
      ? rawUpload
      : null;
  if (
    rawUpload !== null
    && (
      !upload
      || upload.id !== input.uploadId
      || upload.reflectionId !== input.reflectionId
      || upload.ingestionContext !== "daily_reflection"
      || typeof upload.filePath !== "string"
      || !Number.isInteger(upload.persistenceAttemptVersion)
      || upload.persistenceAttemptVersion! <= 0
      || upload.persistenceAttemptVersion! > input.maxAttemptVersion
      || !isOwnedProvisionalAttemptPath({
        filePath: upload.filePath,
        uploadsRootDir: input.uploadsRootDir,
        uploadId: input.uploadId,
        attemptVersion: upload.persistenceAttemptVersion!
      })
    )
  ) {
    throw new DailyReflectionCleanupOwnershipError();
  }
  const parsedJob = rawJob === null
    ? null
    : DailyReflectionJobSchema.safeParse(rawJob);
  if (
    rawJob !== null
    && (
      !parsedJob?.success
      || parsedJob.data.reflectionId !== input.reflectionId
      || parsedJob.data.uploadId !== input.uploadId
    )
  ) {
    throw new DailyReflectionCleanupOwnershipError();
  }
  const chunkDirectory = join(input.uploadsRootDir, `${input.uploadId}-chunks`);
  if (!isOwnedUploadPath(chunkDirectory, input.uploadsRootDir)) {
    throw new DailyReflectionCleanupOwnershipError();
  }
  const generatedPaths = audioChunks.flatMap((chunk) =>
    chunk.source.type === "generated_chunk" && chunk.source.path
      ? [chunk.source.path]
      : []
  );
  if (generatedPaths.some((filePath) => !isOwnedUploadPath(filePath, chunkDirectory))) {
    throw new DailyReflectionCleanupOwnershipError();
  }

  if (input.tombstone) {
    await input.store.write("deleted-uploads", input.uploadId, {
      uploadId: input.uploadId,
      reflectionId: input.reflectionId,
      filePath: upload?.filePath ?? null,
      deletedAt: input.now?.() ?? new Date().toISOString(),
      ingestionContext: "daily_reflection",
      cleanupStatus: "pending"
    } satisfies DailyReflectionDeletedUploadMarker);
  }
  renewAndAssertFence();
  const removeFile = input.removeFile ?? fs.rm;
  await removeAttemptAudioFiles({
    uploadId: input.uploadId,
    uploadsRootDir: input.uploadsRootDir,
    maxAttemptVersion: input.maxAttemptVersion,
    removeFile
  });
  if (upload) await removeFile(upload.filePath, { force: true });
  for (const filePath of generatedPaths) {
    await removeFile(filePath, { force: true });
  }
  await removeFile(chunkDirectory, { recursive: true, force: true });
  renewAndAssertFence();
  await Promise.all([
    checkpoints.deleteUpload(input.uploadId),
    input.store.delete("segments", input.uploadId),
    ...(upload ? [input.store.delete("uploads", input.uploadId)] : []),
    ...(parsedJob?.success
      ? [input.store.delete(DAILY_REFLECTION_JOBS_COLLECTION, input.reflectionId)]
      : [])
  ]);
  await deleteDailyReflectionAssetAttempts({
    store: input.store,
    reflectionId: input.reflectionId,
    accountId: input.accountId,
    uploadId: input.uploadId,
    maxAttemptVersion: input.maxAttemptVersion
  });
  renewAndAssertFence();
  input.repository.deletePublishedAssets(input.accountId, input.reflectionId);
  renewAndAssertFence();
  if (input.tombstone) {
    await input.store.write("deleted-uploads", input.uploadId, {
      uploadId: input.uploadId,
      reflectionId: input.reflectionId,
      filePath: upload?.filePath ?? null,
      deletedAt: input.now?.() ?? new Date().toISOString(),
      ingestionContext: "daily_reflection",
      cleanupStatus: "complete"
    } satisfies DailyReflectionDeletedUploadMarker);
  }
}

export async function cleanupDailyReflectionStagingAssets(input: {
  store: JsonStore;
  repository: DailyReflectionRepository;
  accountId: string;
  reflectionId: string;
  uploadId: string;
  uploadsRootDir: string;
  removeUpload?: boolean;
  now?: () => string;
  removeFile?: typeof fs.rm;
}) {
  const checkpoints = new JsonChunkCheckpointStore(input.store);
  const reflection = input.repository.getReflection(
    input.accountId,
    input.reflectionId
  );
  const plan = input.repository.getProcessingPlan(
    input.accountId,
    input.reflectionId
  );
  if (
    plan?.ingestionContext !== "daily_reflection"
    || plan.uploadId !== input.uploadId
    || (input.removeUpload && !isDailyReflectionTombstone(reflection.status))
  ) {
    throw new DailyReflectionCleanupOwnershipError();
  }
  const upload = await readDailyReflectionPublishedAsset<StoredDailyReflectionUpload>({
    repository: input.repository,
    store: input.store,
    accountId: input.accountId,
    reflectionId: input.reflectionId,
    uploadId: input.uploadId,
    assetKind: "upload"
  });
  const deletedMarker = await input.store.read<DailyReflectionDeletedUploadMarker>(
    "deleted-uploads",
    input.uploadId
  );
  const markerOwnsUpload = deletedMarker?.ingestionContext === "daily_reflection"
    && deletedMarker.uploadId === input.uploadId
    && deletedMarker.reflectionId === input.reflectionId
    && (
      deletedMarker.filePath === null
      || isOwnedUploadPath(deletedMarker.filePath, input.uploadsRootDir)
    );
  const uploadOwnsPath = Boolean(
    upload
    && isDailyReflectionUploadRecord(upload)
    && upload.id === input.uploadId
    && upload.reflectionId === input.reflectionId
    && isOwnedUploadPath(upload.filePath, input.uploadsRootDir)
  );
  if (upload && !uploadOwnsPath) {
    throw new DailyReflectionCleanupOwnershipError();
  }
  const filePath = uploadOwnsPath
    ? upload!.filePath
    : markerOwnsUpload
      ? deletedMarker!.filePath
      : null;

  if (input.removeUpload) {
    await input.store.write("deleted-uploads", input.uploadId, {
      uploadId: input.uploadId,
      reflectionId: input.reflectionId,
      filePath,
      deletedAt: input.now?.() ?? new Date().toISOString(),
      ingestionContext: "daily_reflection",
      cleanupStatus: "pending"
    } satisfies DailyReflectionDeletedUploadMarker);
  }
  await removeAttemptAudioFiles({
    uploadId: input.uploadId,
    uploadsRootDir: input.uploadsRootDir,
    ...(input.removeFile ? { removeFile: input.removeFile } : {})
  });
  await deleteDailyReflectionAssetAttempts({
    store: input.store,
    reflectionId: input.reflectionId
  });
  const audioChunks = await checkpoints.listAudioChunks(input.uploadId)
    .catch(() => []);

  await cleanupGeneratedAudioChunks(audioChunks).catch(() => undefined);
  if (STORE_KEY_PATTERN.test(input.uploadId)) {
    const orphanChunkDirectory = join(
      input.uploadsRootDir,
      `${input.uploadId}-chunks`
    );
    if (isOwnedUploadPath(orphanChunkDirectory, input.uploadsRootDir)) {
      await fs.rm(orphanChunkDirectory, { recursive: true, force: true });
    }
  }
  await Promise.all([
    checkpoints.deleteUpload(input.uploadId),
    input.store.delete("segments", input.uploadId)
  ]);

  if (!input.removeUpload) return;
  if (filePath) await (input.removeFile ?? fs.rm)(filePath, { force: true });
  await Promise.all([
    input.store.delete("uploads", input.uploadId),
    input.store.delete(DAILY_REFLECTION_JOBS_COLLECTION, input.reflectionId)
  ]);
  await input.store.write("deleted-uploads", input.uploadId, {
    uploadId: input.uploadId,
    reflectionId: input.reflectionId,
    filePath,
    deletedAt: input.now?.() ?? new Date().toISOString(),
    ingestionContext: "daily_reflection",
    cleanupStatus: "complete"
  } satisfies DailyReflectionDeletedUploadMarker);
  input.repository.deletePublishedAssets(input.accountId, input.reflectionId);
}
