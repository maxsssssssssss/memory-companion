import { createHash } from "node:crypto";
import { z } from "zod";
import type { JsonStore } from "@/lib/server/storage/json-store";

const CHECKPOINT_COLLECTION = "analysis-chunks";
const CHECKPOINT_VERSION = 1;

export const AnalysisCheckpointKindSchema = z.enum([
  "audio_insight",
  "daily_brief",
  "relationship_candidate"
]);

export const AnalysisCheckpointResultSourceSchema = z.enum([
  "provider_success",
  "provider_retry_success",
  "rule_fallback",
  "deterministic_skip"
]);

export const AnalysisChunkCheckpointSchema = z
  .object({
    version: z.literal(CHECKPOINT_VERSION),
    id: z.string().min(1),
    userId: z.string().min(1),
    uploadId: z.string().min(1),
    kind: AnalysisCheckpointKindSchema,
    sourceChunkId: z.string().min(1),
    sourceChunkIndex: z.number().int().nonnegative(),
    inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    processorFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    status: z.enum(["created", "processing", "completed", "failed"]),
    resultSource: AnalysisCheckpointResultSourceSchema.optional(),
    attemptCount: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime(),
    output: z.unknown().optional(),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        retryable: z.boolean()
      })
      .strict()
      .optional(),
    metadata: z.record(z.string(), z.unknown()).default({})
  })
  .strict()
  .superRefine((checkpoint, context) => {
    if (checkpoint.status === "completed") {
      if (checkpoint.output === undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["output"], message: "completed checkpoints require output" });
      }
      if (!checkpoint.resultSource) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["resultSource"], message: "completed checkpoints require resultSource" });
      }
      if (!checkpoint.completedAt) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["completedAt"], message: "completed checkpoints require completedAt" });
      }
    }
    if (checkpoint.status === "failed" && !checkpoint.error) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["error"], message: "failed checkpoints require error" });
    }
  });

export type AnalysisCheckpointKind = z.infer<typeof AnalysisCheckpointKindSchema>;
export type AnalysisCheckpointResultSource = z.infer<typeof AnalysisCheckpointResultSourceSchema>;
export type AnalysisChunkCheckpoint = z.infer<typeof AnalysisChunkCheckpointSchema>;
export type AnalysisCheckpointCacheStatus = "hit" | "miss" | "stale" | "corrupt";

export class AnalysisCheckpointBusyError extends Error {
  constructor(readonly checkpointId: string) {
    super(`Analysis checkpoint is still processing: ${checkpointId}`);
    this.name = "AnalysisCheckpointBusyError";
  }
}

type CheckpointIdentity = {
  userId: string;
  uploadId: string;
  kind: AnalysisCheckpointKind;
  sourceChunkId: string;
  sourceChunkIndex: number;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

export function fingerprintAnalysisInput(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function safeKeyPart(value: string) {
  const safe = value.replace(/[^A-Za-z0-9_-]/gu, "_");
  return safe.length > 0 ? safe.slice(0, 80) : "unknown";
}

export function buildAnalysisCheckpointId(input: CheckpointIdentity) {
  const sourceHash = fingerprintAnalysisInput(input.sourceChunkId).slice(0, 12);
  return [
    safeKeyPart(input.userId),
    safeKeyPart(input.uploadId),
    input.kind,
    String(input.sourceChunkIndex).padStart(5, "0"),
    sourceHash
  ].join("_");
}

function safeErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : "analysis chunk failed")
    .replace(/((?:token|access_token|api_key|key|password)\s*[=:]\s*)[^\s&,]+/giu, "$1****")
    .replace(/([?&](?:token|access_token|api_key|key|password)=)[^&\s]+/giu, "$1****")
    .slice(0, 300);
}

function errorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code.slice(0, 80);
  }
  return error instanceof z.ZodError ? "invalid_output" : "processing_failed";
}

export class JsonAnalysisChunkCheckpointStore {
  constructor(private readonly store: JsonStore) {}

  async read(id: string): Promise<unknown | null> {
    return await this.store.read<unknown>(CHECKPOINT_COLLECTION, id);
  }

  async write(checkpoint: AnalysisChunkCheckpoint | unknown) {
    const parsed = AnalysisChunkCheckpointSchema.parse(checkpoint);
    await this.store.write(CHECKPOINT_COLLECTION, parsed.id, parsed);
  }

  async list(filter: { userId: string; uploadId: string; kind?: AnalysisCheckpointKind }) {
    const ids = await this.store.listIds(CHECKPOINT_COLLECTION);
    const records: AnalysisChunkCheckpoint[] = [];
    for (const id of ids) {
      try {
        const parsed = AnalysisChunkCheckpointSchema.safeParse(await this.read(id));
        if (
          parsed.success &&
          parsed.data.userId === filter.userId &&
          parsed.data.uploadId === filter.uploadId &&
          (!filter.kind || parsed.data.kind === filter.kind)
        ) {
          records.push(parsed.data);
        }
      } catch {
        // Corrupt records are isolated and replaced on the next execution.
      }
    }
    return records.sort(
      (left, right) => left.sourceChunkIndex - right.sourceChunkIndex || left.id.localeCompare(right.id)
    );
  }

  async deleteUpload(userId: string, uploadId: string) {
    const prefix = `${safeKeyPart(userId)}_${safeKeyPart(uploadId)}_`;
    const ids = await this.store.listIds(CHECKPOINT_COLLECTION);
    await Promise.all(
      ids.filter((id) => id.startsWith(prefix)).map((id) => this.store.delete(CHECKPOINT_COLLECTION, id))
    );
  }
}

const singleFlights = new Map<string, Promise<AnalysisCheckpointExecutionResult<unknown>>>();

export type AnalysisCheckpointExecutionResult<T> = {
  output: T;
  checkpoint: AnalysisChunkCheckpoint;
  cacheStatus: AnalysisCheckpointCacheStatus;
  resultSource: AnalysisCheckpointResultSource;
};

export type AnalysisCheckpointLookupResult<T> = {
  cacheStatus: AnalysisCheckpointCacheStatus;
  output?: T;
  checkpoint?: AnalysisChunkCheckpoint;
};

export type ExecuteWithAnalysisCheckpointInput<T> = CheckpointIdentity & {
  store: JsonAnalysisChunkCheckpointStore;
  inputFingerprint: string;
  processorFingerprint: string;
  outputSchema: z.ZodType<T, z.ZodTypeDef, unknown>;
  validateOutput?: (output: T) => void | Promise<void>;
  staleAfterMs: number;
  now?: () => string;
  metadata?: Record<string, unknown>;
  execute: () => Promise<{
    output: T;
    resultSource: AnalysisCheckpointResultSource;
    metadata?: Record<string, unknown>;
  }>;
};

function checkpointAgeMs(checkpoint: AnalysisChunkCheckpoint, now: string) {
  return Math.max(0, Date.parse(now) - Date.parse(checkpoint.updatedAt));
}

async function parseCachedOutput<T>(input: ExecuteWithAnalysisCheckpointInput<T>, checkpoint: AnalysisChunkCheckpoint) {
  const output = input.outputSchema.parse(checkpoint.output);
  await input.validateOutput?.(output);
  return output;
}

export async function lookupAnalysisCheckpoint<T>(input: Omit<ExecuteWithAnalysisCheckpointInput<T>, "execute">): Promise<AnalysisCheckpointLookupResult<T>> {
  const id = buildAnalysisCheckpointId(input);
  try {
    const raw = await input.store.read(id);
    if (raw === null) return { cacheStatus: "miss" };
    const parsed = AnalysisChunkCheckpointSchema.safeParse(raw);
    if (!parsed.success) return { cacheStatus: "corrupt" };
    const checkpoint = parsed.data;
    if (
      checkpoint.userId !== input.userId ||
      checkpoint.uploadId !== input.uploadId ||
      checkpoint.kind !== input.kind ||
      checkpoint.sourceChunkId !== input.sourceChunkId ||
      checkpoint.sourceChunkIndex !== input.sourceChunkIndex
    ) {
      return { cacheStatus: "corrupt", checkpoint };
    }
    if (
      checkpoint.inputFingerprint !== input.inputFingerprint ||
      checkpoint.processorFingerprint !== input.processorFingerprint
    ) {
      return { cacheStatus: "stale", checkpoint };
    }
    if (checkpoint.status === "processing" && checkpointAgeMs(checkpoint, (input.now ?? (() => new Date().toISOString()))()) >= input.staleAfterMs) {
      return { cacheStatus: "stale", checkpoint };
    }
    if (checkpoint.status !== "completed") {
      return { cacheStatus: "miss", checkpoint };
    }
    try {
      const output = await parseCachedOutput(input as ExecuteWithAnalysisCheckpointInput<T>, checkpoint);
      console.info(
        `[analysis-checkpoint] kind=${input.kind} upload_id=${input.uploadId} chunk_index=${input.sourceChunkIndex} status=completed cache=hit result_source=${checkpoint.resultSource} attempt_count=${checkpoint.attemptCount} elapsed_ms=0`
      );
      return { cacheStatus: "hit", checkpoint, output };
    } catch {
      return { cacheStatus: "corrupt", checkpoint };
    }
  } catch {
    return { cacheStatus: "corrupt" };
  }
}

async function executeOwned<T>(
  input: ExecuteWithAnalysisCheckpointInput<T>,
  id: string
): Promise<AnalysisCheckpointExecutionResult<T>> {
  const now = input.now ?? (() => new Date().toISOString());
  let previous: AnalysisChunkCheckpoint | null = null;
  let cacheStatus: AnalysisCheckpointCacheStatus = "miss";
  let busy = false;
  try {
    const raw = await input.store.read(id);
    if (raw !== null) {
      const parsed = AnalysisChunkCheckpointSchema.safeParse(raw);
      if (!parsed.success) {
        cacheStatus = "corrupt";
      } else {
        previous = parsed.data;
        const fingerprintsMatch =
          previous.inputFingerprint === input.inputFingerprint &&
          previous.processorFingerprint === input.processorFingerprint;
        if (previous.status === "completed" && fingerprintsMatch) {
          try {
            const output = await parseCachedOutput(input, previous);
            console.info(
              `[analysis-checkpoint] kind=${input.kind} upload_id=${input.uploadId} chunk_index=${input.sourceChunkIndex} status=completed cache=hit result_source=${previous.resultSource} attempt_count=${previous.attemptCount} elapsed_ms=0`
            );
            return {
              output,
              checkpoint: previous,
              cacheStatus: "hit",
              resultSource: previous.resultSource!
            };
          } catch {
            cacheStatus = "corrupt";
          }
        } else if (!fingerprintsMatch) {
          cacheStatus = "stale";
        } else if (
          previous.status === "processing" &&
          checkpointAgeMs(previous, now()) >= input.staleAfterMs
        ) {
          cacheStatus = "stale";
        } else if (previous.status === "processing") {
          busy = true;
        }
      }
    }
  } catch {
    cacheStatus = "corrupt";
  }

  if (busy) {
    throw new AnalysisCheckpointBusyError(id);
  }

  const startedAt = now();
  const attemptCount = (previous?.attemptCount ?? 0) + 1;
  const processing = AnalysisChunkCheckpointSchema.parse({
    version: CHECKPOINT_VERSION,
    id,
    userId: input.userId,
    uploadId: input.uploadId,
    kind: input.kind,
    sourceChunkId: input.sourceChunkId,
    sourceChunkIndex: input.sourceChunkIndex,
    inputFingerprint: input.inputFingerprint,
    processorFingerprint: input.processorFingerprint,
    status: "processing",
    attemptCount,
    createdAt: previous?.createdAt ?? startedAt,
    startedAt,
    updatedAt: startedAt,
    metadata: { ...(previous?.metadata ?? {}), ...(input.metadata ?? {}) }
  });
  await input.store.write(processing);

  const wallStartedAt = Date.now();
  try {
    const executed = await input.execute();
    const output = input.outputSchema.parse(executed.output);
    await input.validateOutput?.(output);
    const completedAt = now();
    const completed = AnalysisChunkCheckpointSchema.parse({
      ...processing,
      status: "completed",
      resultSource: executed.resultSource,
      completedAt,
      updatedAt: completedAt,
      output,
      metadata: { ...processing.metadata, ...(executed.metadata ?? {}) }
    });
    await input.store.write(completed);
    console.info(
      `[analysis-checkpoint] kind=${input.kind} upload_id=${input.uploadId} chunk_index=${input.sourceChunkIndex} status=completed cache=${cacheStatus} result_source=${executed.resultSource} attempt_count=${attemptCount} elapsed_ms=${Date.now() - wallStartedAt}`
    );
    return { output, checkpoint: completed, cacheStatus, resultSource: executed.resultSource };
  } catch (error) {
    const failedAt = now();
    const failed = AnalysisChunkCheckpointSchema.parse({
      ...processing,
      status: "failed",
      updatedAt: failedAt,
      error: {
        code: errorCode(error),
        message: safeErrorMessage(error),
        retryable: true
      }
    });
    await input.store.write(failed);
    console.info(
      `[analysis-checkpoint] kind=${input.kind} upload_id=${input.uploadId} chunk_index=${input.sourceChunkIndex} status=failed cache=${cacheStatus} result_source=none attempt_count=${attemptCount} elapsed_ms=${Date.now() - wallStartedAt}`
    );
    throw error;
  }
}

export async function executeWithAnalysisCheckpoint<T>(
  input: ExecuteWithAnalysisCheckpointInput<T>
): Promise<AnalysisCheckpointExecutionResult<T>> {
  const id = buildAnalysisCheckpointId(input);
  const flightKey = `${input.userId}:${id}`;
  const existing = singleFlights.get(flightKey);
  if (existing) {
    return (await existing) as AnalysisCheckpointExecutionResult<T>;
  }
  const execution = executeOwned(input, id);
  singleFlights.set(flightKey, execution as Promise<AnalysisCheckpointExecutionResult<unknown>>);
  try {
    return await execution;
  } finally {
    if (singleFlights.get(flightKey) === execution) {
      singleFlights.delete(flightKey);
    }
  }
}
