import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";

import { isChunkLocalSpeakerLabel } from "@/lib/domain/speaker-identity";
import type { TranscriptSegment } from "@/lib/domain/types";
import { getFfmpegExecutable } from "@/lib/server/ffmpeg";
import type { JsonStore } from "@/lib/server/storage/json-store";

import type { MemoryWriteInput } from "./types";

const CANDIDATE_COLLECTION = "memory-owner-review-candidates";
const OPERATION_COLLECTION = "memory-owner-review-operations";
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const BOUNDARY_TRIM_MS = 100;
const MAX_EVIDENCE_SEGMENTS = 20;
const MAX_EVIDENCE_DURATION_MS = 120_000;
const StoreKeySchema = z.string().trim().regex(/^[A-Za-z0-9_-]+$/).max(512);
const ownerReviewRequestLocks = new Map<string, Promise<void>>();

const StructuralGateSchema = z.object({
  status: z.enum(["healthy", "degraded", "blocked"]),
  reasons: z.array(z.string().max(256))
}).strict();

const AudioClipSchema = z.object({
  segmentId: StoreKeySchema,
  filePath: z.string().min(1),
  durationMilliseconds: z.number().int().positive(),
  expiresAt: z.string().datetime()
}).strict();

export const MemoryOwnerReviewCandidateSchema = z.object({
  version: z.literal(1),
  candidateId: StoreKeySchema,
  uploadId: StoreKeySchema,
  memoryId: StoreKeySchema,
  memoryType: z.enum([
    "preference",
    "commitment",
    "event",
    "question",
    "relationship_signal",
    "summary"
  ]),
  title: z.string().max(500),
  summary: z.string().max(4_000),
  evidenceSegmentIds: z.array(StoreKeySchema).min(1),
  evidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  providerLabels: z.array(z.string().min(1).max(512)).min(1),
  structuralGate: StructuralGateSchema,
  status: z.enum([
    "pending",
    "confirmed",
    "daily_only",
    "expired",
    "stale",
    "processing_failed"
  ]),
  audioClips: z.array(AudioClipSchema).max(MAX_EVIDENCE_SEGMENTS),
  confirmedOwnerIdentityId: StoreKeySchema.optional(),
  confirmedAt: z.string().datetime().optional(),
  confirmationSource: z.literal("user_confirmed_memory_owner").optional(),
  failureReason: z.string().max(300).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime()
}).strict();

export const MemoryOwnerReviewOperationSchema = z.object({
  version: z.literal(1),
  operationId: StoreKeySchema,
  requestId: StoreKeySchema,
  candidateId: StoreKeySchema,
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(["confirm_owner", "keep_daily_only", "revoke_confirmation"]),
  ownerIdentityId: StoreKeySchema.nullable(),
  status: z.enum(["running", "succeeded", "failed"]),
  error: z.string().max(300).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

export type MemoryOwnerReviewCandidate = z.infer<typeof MemoryOwnerReviewCandidateSchema>;
export type MemoryOwnerReviewOperation = z.infer<typeof MemoryOwnerReviewOperationSchema>;
export type MemoryOwnerReviewStructuralGate = z.infer<typeof StructuralGateSchema>;

export type MemoryOwnerReviewDraft = {
  memory: MemoryWriteInput;
  evidenceSegments: TranscriptSegment[];
  providerLabels: string[];
  structuralGate: MemoryOwnerReviewStructuralGate;
};

export type MemoryOwnerReviewOverride = {
  candidateId: string;
  evidenceDigest: string;
  ownerIdentityId: string;
};

type OwnerReviewStore = Pick<JsonStore, "read" | "write" | "list" | "delete">;
type MemoryOwnerReviewFfmpegRunner = (input: {
  sourceFilePath: string;
  outputFilePath: string;
  ranges: Array<{ startMilliseconds: number; endMilliseconds: number }>;
}) => Promise<void>;

function ownerReviewFfmpegFilter(
  ranges: Array<{ startMilliseconds: number; endMilliseconds: number }>
) {
  const trims = ranges.map(
    (range, index) =>
      `[0:a]atrim=start=${(range.startMilliseconds / 1_000).toFixed(3)}:` +
      `end=${(range.endMilliseconds / 1_000).toFixed(3)},` +
      `asetpts=PTS-STARTPTS[a${index}]`
  );
  const inputs = ranges.map((_range, index) => `[a${index}]`).join("");
  return `${trims.join(";")};${inputs}concat=n=${ranges.length}:v=0:a=1[out]`;
}

const runMemoryOwnerReviewFfmpeg: MemoryOwnerReviewFfmpegRunner = async (input) => {
  if (input.ranges.length === 0) {
    throw new Error("owner review audio requires at least one range");
  }
  await mkdir(dirname(input.outputFilePath), { recursive: true });
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    input.sourceFilePath,
    "-filter_complex",
    ownerReviewFfmpegFilter(input.ranges),
    "-map",
    "[out]",
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "32k",
    input.outputFilePath
  ];
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(getFfmpegExecutable(), args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 4_096) {
        stderr += chunk.slice(0, 4_096 - stderr.length);
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`owner review ffmpeg failed with code ${code}: ${stderr.trim()}`));
    });
  });
};

function hash(parts: string[]) {
  return createHash("sha256").update(parts.join("\u001f")).digest("hex");
}

export function memoryOwnerReviewCandidateId(uploadId: string, memoryId: string) {
  return `mor_${hash([StoreKeySchema.parse(uploadId), StoreKeySchema.parse(memoryId)]).slice(0, 40)}`;
}

export function memoryOwnerReviewEvidenceDigest(input: {
  uploadId: string;
  memory: MemoryWriteInput;
  evidenceSegments: TranscriptSegment[];
  providerLabels: string[];
}) {
  return hash([
    input.uploadId,
    input.memory.id,
    input.memory.type,
    input.memory.title,
    input.memory.summary,
    ...[...input.evidenceSegments]
      .sort((left, right) => left.id.localeCompare(right.id, "en"))
      .flatMap((segment) => [
        segment.id,
        String(segment.startSeconds),
        String(segment.endSeconds),
        segment.text,
        segment.speaker ?? ""
      ]),
    ...[...input.providerLabels].sort((left, right) => left.localeCompare(right, "en"))
  ]);
}

export function providerReviewLabels(segments: TranscriptSegment[]) {
  if (segments.length === 0) return [];
  const labels = segments.flatMap((segment) => {
    const identity = segment.identity;
    if (
      !identity ||
      identity.identityType !== "unknown_person" ||
      identity.source !== "provider_speaker_result" ||
      identity.confidence !== null ||
      identity.evidence?.type !== "provider_label" ||
      isChunkLocalSpeakerLabel(identity.evidence.providerLabel)
    ) {
      return [];
    }
    return [identity.evidence.providerLabel];
  });
  return labels.length === segments.length
    ? [...new Set(labels)].sort((left, right) => left.localeCompare(right, "en"))
    : [];
}

function expiresAt(timestamp: string) {
  return new Date(Date.parse(timestamp) + RETENTION_MS).toISOString();
}

function safeChildPath(root: string, ...parts: string[]) {
  const normalizedRoot = resolve(root);
  const child = resolve(root, ...parts);
  if (child !== normalizedRoot && !child.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error("owner review audio path escaped its root");
  }
  return child;
}

export function isMemoryOwnerReviewAudioPath(filePath: string, uploadsRootDir: string) {
  const root = resolve(uploadsRootDir, "memory-owner-review");
  const candidate = resolve(filePath);
  return candidate.startsWith(`${root}${sep}`);
}

function evidenceRanges(segments: TranscriptSegment[]) {
  const ordered = [...segments].sort(
    (left, right) =>
      left.startSeconds - right.startSeconds ||
      left.endSeconds - right.endSeconds ||
      left.id.localeCompare(right.id, "en")
  );
  if (ordered.length > MAX_EVIDENCE_SEGMENTS) {
    return { eligible: false as const, reason: "evidence_segment_limit_exceeded" };
  }
  const ranges = ordered.map((segment) => {
    const startMilliseconds = Math.ceil(segment.startSeconds * 1_000) + BOUNDARY_TRIM_MS;
    const endMilliseconds = Math.floor(segment.endSeconds * 1_000) - BOUNDARY_TRIM_MS;
    return {
      segment,
      startMilliseconds,
      endMilliseconds,
      durationMilliseconds: endMilliseconds - startMilliseconds
    };
  });
  if (ranges.some((range) => range.durationMilliseconds <= 0)) {
    return { eligible: false as const, reason: "evidence_segment_too_short" };
  }
  if (ranges.reduce((total, range) => total + range.durationMilliseconds, 0) > MAX_EVIDENCE_DURATION_MS) {
    return { eligible: false as const, reason: "evidence_duration_limit_exceeded" };
  }
  return { eligible: true as const, ranges };
}

export function isMemoryOwnerReviewEnabled(env = process.env) {
  return env.MEMORY_OWNER_REVIEW_ENABLED?.trim().toLowerCase() === "true";
}

export class MemoryOwnerReviewRepository {
  constructor(
    private readonly store: OwnerReviewStore,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async getCandidate(candidateId: string) {
    const value = await this.store.read<unknown>(
      CANDIDATE_COLLECTION,
      StoreKeySchema.parse(candidateId)
    );
    return value === null ? null : MemoryOwnerReviewCandidateSchema.parse(value);
  }

  async listCandidates(uploadId?: string) {
    const records = await this.store.list<unknown>(CANDIDATE_COLLECTION);
    return records
      .map(({ value }) => MemoryOwnerReviewCandidateSchema.parse(value))
      .filter((candidate) => uploadId === undefined || candidate.uploadId === uploadId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt, "en"));
  }

  async saveCandidate(candidate: MemoryOwnerReviewCandidate) {
    const parsed = MemoryOwnerReviewCandidateSchema.parse(candidate);
    await this.store.write(CANDIDATE_COLLECTION, parsed.candidateId, parsed);
    return parsed;
  }

  async patchCandidate(
    candidateId: string,
    patch: Partial<Pick<
      MemoryOwnerReviewCandidate,
      | "status"
      | "audioClips"
      | "confirmedOwnerIdentityId"
      | "confirmedAt"
      | "confirmationSource"
      | "failureReason"
    >>
  ) {
    const current = await this.getCandidate(candidateId);
    if (!current) return null;
    const value = MemoryOwnerReviewCandidateSchema.parse({
      ...current,
      ...patch,
      updatedAt: this.now()
    });
    await this.store.write(CANDIDATE_COLLECTION, candidateId, value);
    return value;
  }

  async deleteUpload(uploadId: string) {
    const candidates = await this.listCandidates(StoreKeySchema.parse(uploadId));
    const candidateIds = new Set(candidates.map((candidate) => candidate.candidateId));
    const operations = await this.store.list<unknown>(OPERATION_COLLECTION);
    await Promise.all(candidates.map(async (candidate) => {
      await Promise.all(candidate.audioClips.map((clip) => rm(clip.filePath, { force: true })));
      await this.store.delete(CANDIDATE_COLLECTION, candidate.candidateId);
    }));
    await Promise.all(operations.flatMap(({ id, value }) => {
      const operation = MemoryOwnerReviewOperationSchema.safeParse(value);
      return operation.success && candidateIds.has(operation.data.candidateId)
        ? [this.store.delete(OPERATION_COLLECTION, id)]
        : [];
    }));
    return candidates.length;
  }

  async cleanupExpired() {
    const nowMs = Date.parse(this.now());
    const candidates = await this.listCandidates();
    let cleaned = 0;
    for (const candidate of candidates) {
      const expired = Date.parse(candidate.expiresAt) <= nowMs;
      if (!expired) continue;
      await Promise.all(candidate.audioClips.map((clip) => rm(clip.filePath, { force: true })));
      await this.patchCandidate(candidate.candidateId, {
        audioClips: [],
        ...(candidate.status === "pending" ? { status: "expired" as const } : {})
      });
      cleaned += 1;
    }
    return cleaned;
  }

  async getOperationByRequestId(requestId: string) {
    const id = `mor_op_${hash([StoreKeySchema.parse(requestId)]).slice(0, 40)}`;
    const value = await this.store.read<unknown>(OPERATION_COLLECTION, id);
    return value === null ? null : MemoryOwnerReviewOperationSchema.parse(value);
  }

  async saveOperation(operation: MemoryOwnerReviewOperation) {
    const parsed = MemoryOwnerReviewOperationSchema.parse(operation);
    await this.store.write(OPERATION_COLLECTION, parsed.operationId, parsed);
    return parsed;
  }
}

export async function generateMemoryOwnerReviewCandidates(input: {
  store: OwnerReviewStore;
  uploadId: string;
  sourceFilePath: string | null;
  uploadsRootDir: string;
  drafts: MemoryOwnerReviewDraft[];
  ffmpegRunner?: MemoryOwnerReviewFfmpegRunner;
  now?: () => string;
}) {
  const now = input.now ?? (() => new Date().toISOString());
  const timestamp = now();
  const repository = new MemoryOwnerReviewRepository(input.store, now);
  await repository.cleanupExpired();
  const generated: MemoryOwnerReviewCandidate[] = [];
  const ffmpegRunner = input.ffmpegRunner ?? runMemoryOwnerReviewFfmpeg;
  console.info(`[memory-owner-review] candidate_generation progress=0/${input.drafts.length}`);

  for (const [index, draft] of input.drafts.entries()) {
    const candidateId = memoryOwnerReviewCandidateId(input.uploadId, draft.memory.id);
    const digest = memoryOwnerReviewEvidenceDigest({
      uploadId: input.uploadId,
      memory: draft.memory,
      evidenceSegments: draft.evidenceSegments,
      providerLabels: draft.providerLabels
    });
    const expiration = expiresAt(timestamp);
    const base = {
      version: 1 as const,
      candidateId,
      uploadId: input.uploadId,
      memoryId: draft.memory.id,
      memoryType: draft.memory.type,
      title: draft.memory.title,
      summary: draft.memory.summary,
      evidenceSegmentIds: draft.evidenceSegments.map((segment) => segment.id),
      evidenceDigest: digest,
      providerLabels: draft.providerLabels,
      structuralGate: draft.structuralGate,
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: expiration
    };
    const selected = evidenceRanges(draft.evidenceSegments);
    if (
      !input.sourceFilePath ||
      draft.structuralGate.status === "blocked" ||
      !selected.eligible
    ) {
      generated.push(await repository.saveCandidate({
        ...base,
        status: "daily_only",
        audioClips: [],
        failureReason:
          !input.sourceFilePath
            ? "source_audio_missing"
            : draft.structuralGate.status === "blocked"
              ? "structural_gate_blocked"
              : selected.reason
      }));
      console.info(`[memory-owner-review] candidate_generation progress=${index + 1}/${input.drafts.length}`);
      continue;
    }

    const candidateRoot = safeChildPath(
      input.uploadsRootDir,
      "memory-owner-review",
      input.uploadId,
      candidateId
    );
    await mkdir(candidateRoot, { recursive: true });
    const clips: MemoryOwnerReviewCandidate["audioClips"] = [];
    try {
      for (const [clipIndex, range] of selected.ranges.entries()) {
        const filePath = safeChildPath(candidateRoot, `evidence_${clipIndex + 1}.mp3`);
        await ffmpegRunner({
          sourceFilePath: input.sourceFilePath,
          outputFilePath: filePath,
          ranges: [{
            startMilliseconds: range.startMilliseconds,
            endMilliseconds: range.endMilliseconds
          }]
        });
        const file = await stat(filePath);
        if (!file.isFile() || file.size <= 0) {
          throw new Error("owner review audio output is empty");
        }
        clips.push({
          segmentId: range.segment.id,
          filePath,
          durationMilliseconds: range.durationMilliseconds,
          expiresAt: expiration
        });
      }
      generated.push(await repository.saveCandidate({
        ...base,
        status: "pending",
        audioClips: clips
      }));
    } catch (error) {
      await rm(candidateRoot, { recursive: true, force: true });
      generated.push(await repository.saveCandidate({
        ...base,
        status: "daily_only",
        audioClips: [],
        failureReason: error instanceof Error
          ? `audio_generation_failed:${error.name}`.slice(0, 300)
          : "audio_generation_failed"
      }));
    }
    console.info(`[memory-owner-review] candidate_generation progress=${index + 1}/${input.drafts.length}`);
  }
  return generated;
}

export function memoryOwnerReviewOperationInputDigest(input: {
  candidateId: string;
  evidenceDigest: string;
  decision: "confirm_owner" | "keep_daily_only" | "revoke_confirmation";
  ownerIdentityId: string | null;
}) {
  return hash([
    input.candidateId,
    input.evidenceDigest,
    input.decision,
    input.ownerIdentityId ?? ""
  ]);
}

export function memoryOwnerReviewOperationId(requestId: string) {
  return `mor_op_${hash([StoreKeySchema.parse(requestId)]).slice(0, 40)}`;
}

export async function withMemoryOwnerReviewRequestLock<T>(
  requestId: string,
  task: () => Promise<T>
) {
  const key = StoreKeySchema.parse(requestId);
  const previous = ownerReviewRequestLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  ownerReviewRequestLocks.set(key, current);
  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (ownerReviewRequestLocks.get(key) === current) {
      ownerReviewRequestLocks.delete(key);
    }
  }
}

export async function deleteMemoryOwnerReviewCandidatesForUpload(input: {
  store: OwnerReviewStore;
  uploadId: string;
  uploadsRootDir?: string;
}) {
  const deleted = await new MemoryOwnerReviewRepository(input.store).deleteUpload(input.uploadId);
  if (input.uploadsRootDir) {
    await rm(
      safeChildPath(input.uploadsRootDir, "memory-owner-review", input.uploadId),
      { recursive: true, force: true }
    );
  }
  return deleted;
}
