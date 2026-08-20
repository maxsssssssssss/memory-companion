import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { z } from "zod";

import type { JsonStore } from "@/lib/server/storage/json-store";
import { isDailyReflectionUpload } from "@/lib/server/daily-reflection/upload-record";

import {
  VoiceprintProviderError,
  type VoiceprintTrainingAudio
} from "./voiceprint-client";
import {
  buildVoiceprintTrainingCandidateAudioUrl,
  createVoiceprintProviderRequestId
} from "./voiceprint-api-support";
import { JsonVoiceprintOperationRepository } from "./voiceprint-operation-repository";
import {
  createConfiguredVoiceprintService,
  VoiceprintWorkflowError,
  type TrainUserVoiceprintResult
} from "./voiceprint-service";
import {
  VoiceprintTrainingCandidateRepository,
  isVoiceprintCandidateFilePath,
  type VoiceprintTrainingCandidate
} from "./voiceprint-training-candidates";

const COLLECTION = "voiceprint-self-enrollment-operations";
const TRAIN_TIMEOUT_MS = 240_000;
const operationLocks = new Map<string, Promise<unknown>>();
const StoreKeySchema = z.string().trim().regex(/^[A-Za-z0-9_-]+$/).max(512);

export const VoiceprintSelfEnrollmentOperationSchema = z.object({
  version: z.literal(1),
  operationId: StoreKeySchema,
  requestId: z.string().trim().min(1).max(512),
  providerRequestId: StoreKeySchema,
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  primaryCandidateId: StoreKeySchema,
  candidateIds: z.array(StoreKeySchema).min(1).max(2),
  status: z.enum([
    "queued",
    "running",
    "succeeded",
    "failed",
    "ambiguous_timeout"
  ]),
  attemptCount: z.number().int().nonnegative().max(1),
  providerCode: z.number().int().optional(),
  errorReason: z.enum([
    "invalid_candidate",
    "candidate_expired",
    "candidate_audio_unavailable",
    "queue_unavailable",
    "provider_failed",
    "persistence_error",
    "ambiguous_timeout"
  ]).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  durationMilliseconds: z.number().int().nonnegative().optional()
}).strict();

export type VoiceprintSelfEnrollmentOperation = z.infer<
  typeof VoiceprintSelfEnrollmentOperationSchema
>;

type OperationStore = Pick<JsonStore, "read" | "write">;

export class VoiceprintSelfEnrollmentError extends Error {
  constructor(
    readonly reason:
      | "request_id_conflict"
      | "invalid_candidate"
      | "candidate_expired"
      | "candidate_audio_unavailable"
      | "operation_not_found",
    message: string
  ) {
    super(message);
    this.name = "VoiceprintSelfEnrollmentError";
  }
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function operationDocumentId(requestId: string) {
  return `vp_self_enroll_${createHash("sha256")
    .update(requestId.trim())
    .digest("hex")}`;
}

function providerRequestId(userId: string, requestId: string) {
  return createVoiceprintProviderRequestId({
    operation: "train",
    userId,
    clientRequestId: `self_enrollment_${requestId}`
  });
}

async function withOperationLock<T>(
  operationId: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = operationLocks.get(operationId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  operationLocks.set(operationId, current);
  try {
    return await current;
  } finally {
    if (operationLocks.get(operationId) === current) {
      operationLocks.delete(operationId);
    }
  }
}

export class VoiceprintSelfEnrollmentOperationRepository {
  constructor(
    private readonly store: OperationStore,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async get(operationId: string) {
    const id = StoreKeySchema.parse(operationId);
    const value = await this.store.read<unknown>(COLLECTION, id);
    return value === null
      ? null
      : VoiceprintSelfEnrollmentOperationSchema.parse(value);
  }

  async getByRequestId(requestId: string) {
    const normalized = requestId.trim();
    if (!normalized || normalized.length > 512) {
      return null;
    }
    return await this.get(operationDocumentId(normalized));
  }

  async create(input: {
    userId: string;
    requestId: string;
    primaryCandidateId: string;
    candidateIds: string[];
  }) {
    const requestId = input.requestId.trim();
    if (!requestId || requestId.length > 512) {
      throw new VoiceprintSelfEnrollmentError(
        "request_id_conflict",
        "self-enrollment request id is invalid"
      );
    }
    const operationId = operationDocumentId(requestId);
    const inputDigest = digest({
      confirmation: "self",
      primaryCandidateId: input.primaryCandidateId
    });
    return await withOperationLock(operationId, async () => {
      const current = await this.get(operationId);
      if (current) {
        if (current.inputDigest !== inputDigest) {
          throw new VoiceprintSelfEnrollmentError(
            "request_id_conflict",
            "self-enrollment request id is already used by different input"
          );
        }
        return { operation: current, reused: true };
      }
      const timestamp = this.now();
      const operation = VoiceprintSelfEnrollmentOperationSchema.parse({
        version: 1,
        operationId,
        requestId,
        providerRequestId: providerRequestId(input.userId, requestId),
        inputDigest,
        primaryCandidateId: input.primaryCandidateId,
        candidateIds: input.candidateIds,
        status: "queued",
        attemptCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp
      });
      await this.store.write(COLLECTION, operationId, operation);
      return { operation, reused: false };
    });
  }

  async update(
    operationId: string,
    update: (
      current: VoiceprintSelfEnrollmentOperation
    ) => VoiceprintSelfEnrollmentOperation
  ) {
    const id = StoreKeySchema.parse(operationId);
    return await withOperationLock(id, async () => {
      const current = await this.get(id);
      if (!current) {
        throw new VoiceprintSelfEnrollmentError(
          "operation_not_found",
          "self-enrollment operation was not found"
        );
      }
      const next = VoiceprintSelfEnrollmentOperationSchema.parse({
        ...update(current),
        operationId: current.operationId,
        requestId: current.requestId,
        providerRequestId: current.providerRequestId,
        inputDigest: current.inputDigest,
        primaryCandidateId: current.primaryCandidateId,
        candidateIds: current.candidateIds,
        createdAt: current.createdAt,
        updatedAt: this.now()
      });
      await this.store.write(COLLECTION, id, next);
      return next;
    });
  }
}

async function candidateAudioAvailable(
  candidate: VoiceprintTrainingCandidate,
  uploadsRootDir: string
) {
  if (
    !candidate.audioFilePath ||
    !isVoiceprintCandidateFilePath(candidate.audioFilePath, uploadsRootDir)
  ) {
    return false;
  }
  const value = await stat(candidate.audioFilePath).catch(() => null);
  return Boolean(value?.isFile() && value.size > 0);
}

async function latestSuccessfulCandidate(input: {
  store: JsonStore;
  repository: VoiceprintTrainingCandidateRepository;
  primaryCandidateId: string;
  uploadsRootDir: string;
  now: string;
}) {
  const candidates = (await input.repository.list())
    .filter(
      (candidate) =>
        candidate.candidateId !== input.primaryCandidateId &&
        candidate.status === "trained" &&
        candidate.trainedAt &&
        Date.parse(candidate.expiresAt) > Date.parse(input.now)
    )
    .sort(
      (left, right) =>
        (right.trainedAt ?? "").localeCompare(left.trainedAt ?? "") ||
        right.updatedAt.localeCompare(left.updatedAt)
    );
  for (const candidate of candidates) {
    const upload = await input.store.read<unknown>("uploads", candidate.uploadId);
    if (
      upload
      && !isDailyReflectionUpload(upload)
      && await candidateAudioAvailable(candidate, input.uploadsRootDir)
    ) {
      return candidate;
    }
  }
  return null;
}

export async function createVoiceprintSelfEnrollment(input: {
  store: JsonStore;
  userId: string;
  uploadsRootDir: string;
  requestId: string;
  candidateId: string;
  now?: () => string;
}) {
  const now = input.now ?? (() => new Date().toISOString());
  const repository = new VoiceprintSelfEnrollmentOperationRepository(
    input.store,
    now
  );
  const existing = await repository.getByRequestId(input.requestId);
  const candidates = new VoiceprintTrainingCandidateRepository(input.store, now);
  if (existing) {
    const candidate = await candidates.get(input.candidateId);
    const upload = candidate
      ? await input.store.read<unknown>("uploads", candidate.uploadId)
      : null;
    if (!candidate || !upload || isDailyReflectionUpload(upload)) {
      throw new VoiceprintSelfEnrollmentError(
        "invalid_candidate",
        "self-enrollment candidate parent upload is unavailable"
      );
    }
    return await repository.create({
      userId: input.userId,
      requestId: input.requestId,
      primaryCandidateId: input.candidateId,
      candidateIds: existing.candidateIds
    });
  }
  await candidates.cleanupExpired(input.uploadsRootDir);
  const candidate = await candidates.get(input.candidateId);
  if (!candidate) {
    throw new VoiceprintSelfEnrollmentError(
      "invalid_candidate",
      "self-enrollment candidate was not found"
    );
  }
  const parentUpload = await input.store.read<unknown>("uploads", candidate.uploadId);
  if (!parentUpload || isDailyReflectionUpload(parentUpload)) {
    throw new VoiceprintSelfEnrollmentError(
      "invalid_candidate",
      "self-enrollment candidate parent upload is unavailable"
    );
  }
  if (
    candidate.status === "expired" ||
    Date.parse(candidate.expiresAt) <= Date.parse(now())
  ) {
    throw new VoiceprintSelfEnrollmentError(
      "candidate_expired",
      "self-enrollment candidate has expired"
    );
  }
  if (
    (
      candidate.status !== "available" &&
      !(
        candidate.status === "failed" &&
        candidate.failureReason !== "audio_generation_failed"
      )
    ) ||
    (
      candidate.identityState !== "unknown" &&
      candidate.identityState !== "verified_self"
    )
  ) {
    throw new VoiceprintSelfEnrollmentError(
      "invalid_candidate",
      "self-enrollment candidate is not eligible"
    );
  }
  if (!(await candidateAudioAvailable(candidate, input.uploadsRootDir))) {
    throw new VoiceprintSelfEnrollmentError(
      "candidate_audio_unavailable",
      "self-enrollment candidate audio is unavailable"
    );
  }

  const previous = await latestSuccessfulCandidate({
    store: input.store,
    repository: candidates,
    primaryCandidateId: candidate.candidateId,
    uploadsRootDir: input.uploadsRootDir,
    now: now()
  });
  const result = await repository.create({
    userId: input.userId,
    requestId: input.requestId,
    primaryCandidateId: candidate.candidateId,
    candidateIds: [
      candidate.candidateId,
      ...(previous ? [previous.candidateId] : [])
    ]
  });
  if (!result.reused) {
    await candidates.update(candidate.candidateId, (current) => ({
      ...current,
      status: "queued",
      operationId: result.operation.operationId,
      failureReason: undefined
    }));
  }
  return result;
}

function trainingAudio(
  userId: string,
  candidates: VoiceprintTrainingCandidate[]
): VoiceprintTrainingAudio[] {
  return candidates.map((candidate) => ({
    url: buildVoiceprintTrainingCandidateAudioUrl({
      userId,
      candidateId: candidate.candidateId
    }),
    rule: [[0, candidate.durationMilliseconds]]
  }));
}

async function finishCandidateRetention(input: {
  candidates: VoiceprintTrainingCandidateRepository;
  primary: VoiceprintTrainingCandidate;
  uploadsRootDir: string;
  now: string;
}) {
  const trained = await input.candidates.update(
    input.primary.candidateId,
    (current) => ({
      ...current,
      status: "trained",
      failureReason: undefined,
      trainedAt: input.now,
      expiresAt: new Date(
        Date.parse(input.now) + 7 * 24 * 60 * 60 * 1_000
      ).toISOString()
    })
  );
  const obsolete = (await input.candidates.list()).filter(
    (candidate) =>
      candidate.candidateId !== trained.candidateId &&
      (
        candidate.uploadId === trained.uploadId ||
        candidate.status === "trained"
      )
  );
  for (const candidate of obsolete) {
    await input.candidates.delete(
      candidate.candidateId,
      input.uploadsRootDir
    );
  }
  return trained;
}

type VoiceprintServiceLike = {
  trainUser(input: {
    userId: string;
    requestId: string;
    audio: VoiceprintTrainingAudio[];
    displayName?: string;
  }): Promise<TrainUserVoiceprintResult>;
};

export async function processVoiceprintSelfEnrollment(input: {
  store: JsonStore;
  userId: string;
  uploadsRootDir: string;
  operationId: string;
  displayName?: string;
  now?: () => string;
  createService?: (store: JsonStore) => VoiceprintServiceLike;
}) {
  const now = input.now ?? (() => new Date().toISOString());
  const operations = new VoiceprintSelfEnrollmentOperationRepository(
    input.store,
    now
  );
  const candidates = new VoiceprintTrainingCandidateRepository(input.store, now);
  const initial = await operations.get(input.operationId);
  if (!initial) {
    throw new VoiceprintSelfEnrollmentError(
      "operation_not_found",
      "self-enrollment operation was not found"
    );
  }
  if (
    initial.status === "succeeded" ||
    initial.status === "failed" ||
    initial.status === "ambiguous_timeout"
  ) {
    return initial;
  }

  let resumeProviderCheckpoint = false;
  if (initial.status === "running") {
    const providerOperation = await new JsonVoiceprintOperationRepository(
      input.store
    ).get(initial.providerRequestId);
    resumeProviderCheckpoint =
      providerOperation?.status === "provider_succeeded" ||
      providerOperation?.status === "succeeded";
    if (!resumeProviderCheckpoint) {
      const finishedAt = now();
      return await operations.update(initial.operationId, (current) => ({
        ...current,
        status: "ambiguous_timeout",
        errorReason: "ambiguous_timeout",
        finishedAt,
        durationMilliseconds: current.startedAt
          ? Math.max(0, Date.parse(finishedAt) - Date.parse(current.startedAt))
          : 0
      }));
    }
  }

  const selectedCandidates: VoiceprintTrainingCandidate[] = [];
  for (const candidateId of initial.candidateIds) {
    const candidate = await candidates.get(candidateId);
    if (
      !candidate ||
      Date.parse(candidate.expiresAt) <= Date.parse(now()) ||
      !(await candidateAudioAvailable(candidate, input.uploadsRootDir))
    ) {
      const failed = await operations.update(initial.operationId, (current) => ({
        ...current,
        status: "failed",
        errorReason: candidate ? "candidate_audio_unavailable" : "invalid_candidate",
        finishedAt: now()
      }));
      return failed;
    }
    selectedCandidates.push(candidate);
  }

  const startedAt = initial.startedAt ?? now();
  const running = resumeProviderCheckpoint
    ? initial
    : await operations.update(initial.operationId, (current) => ({
        ...current,
        status: "running",
        attemptCount: 1,
        startedAt,
        errorReason: undefined
      }));
  console.info(
    `[voiceprint-enrollment] running operation_id=${running.operationId} attempt=1 audio_count=${selectedCandidates.length}`
  );

  let providerSucceeded = false;
  try {
    const service =
      input.createService?.(input.store) ??
      createConfiguredVoiceprintService(input.store, {
        trainTimeoutMs: TRAIN_TIMEOUT_MS,
        maxRetries: 0
      });
    const result = await service.trainUser({
      userId: input.userId,
      requestId: running.providerRequestId,
      audio: trainingAudio(input.userId, selectedCandidates),
      ...(input.displayName?.trim()
        ? { displayName: input.displayName.trim() }
        : {})
    });
    providerSucceeded = true;
    const finishedAt = now();
    await finishCandidateRetention({
      candidates,
      primary: selectedCandidates[0],
      uploadsRootDir: input.uploadsRootDir,
      now: finishedAt
    });
    const succeeded = await operations.update(running.operationId, (current) => ({
      ...current,
      status: "succeeded",
      providerCode: result.operation.resultMetadata.providerCode ?? 0,
      errorReason: undefined,
      finishedAt,
      durationMilliseconds: Math.max(
        0,
        Date.parse(finishedAt) - Date.parse(startedAt)
      )
    }));
    console.info(
      `[voiceprint-enrollment] succeeded operation_id=${succeeded.operationId} duration_ms=${succeeded.durationMilliseconds ?? 0} attempt=1`
    );
    return succeeded;
  } catch (error) {
    const finishedAt = now();
    const ambiguous =
      error instanceof VoiceprintProviderError &&
      error.reason === "timeout";
    const persistenceFailure =
      providerSucceeded ||
      (
        error instanceof VoiceprintWorkflowError &&
        error.reason === "persistence_error"
      );
    const failed = await operations.update(running.operationId, (current) => ({
      ...current,
      status: ambiguous ? "ambiguous_timeout" : "failed",
      errorReason: ambiguous
        ? "ambiguous_timeout"
        : persistenceFailure
          ? "persistence_error"
          : "provider_failed",
      ...(error instanceof VoiceprintProviderError &&
      error.providerCode !== undefined
        ? { providerCode: error.providerCode }
        : {}),
      finishedAt,
      durationMilliseconds: Math.max(
        0,
        Date.parse(finishedAt) - Date.parse(startedAt)
      )
    }));
    await candidates.update(initial.primaryCandidateId, (current) => ({
      ...current,
      status: "failed",
      failureReason: ambiguous
        ? "ambiguous_timeout"
        : persistenceFailure
          ? "persistence_error"
          : "provider_failed"
    })).catch(() => undefined);
    console.warn(
      `[voiceprint-enrollment] ${ambiguous ? "ambiguous_timeout" : "failed"} operation_id=${failed.operationId} duration_ms=${failed.durationMilliseconds ?? 0} attempt=1 error_name=${error instanceof Error ? error.name : "unknown"}`
    );
    return failed;
  }
}

export const voiceprintSelfEnrollmentTrainPolicy = {
  timeoutMilliseconds: TRAIN_TIMEOUT_MS,
  maximumAttempts: 1,
  providerRetries: 0
} as const;
