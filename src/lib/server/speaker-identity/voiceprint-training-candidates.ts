import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { z } from "zod";

import type { TranscriptChunk } from "@/lib/domain/chunks";
import type { TranscriptSegment } from "@/lib/domain/types";
import type { JsonStore } from "@/lib/server/storage/json-store";
import { getFfmpegExecutable } from "@/lib/server/ffmpeg";

import { speakerIdentityCandidateKey } from "./matching";

const COLLECTION = "voiceprint-training-candidates";
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const BOUNDARY_TRIM_MS = 100;
const MIN_SEGMENT_MS = 500;
const MIN_CANDIDATE_MS = 30_000;
const TARGET_CANDIDATE_MS = 90_000;
const MAX_CANDIDATE_MS = 120_000;
const MAX_SEGMENTS = 20;
const candidateLocks = new Map<string, Promise<unknown>>();

const StoreKeySchema = z.string().trim().regex(/^[A-Za-z0-9_-]+$/).max(512);
const CandidateRangeSchema = z.object({
  startMilliseconds: z.number().int().nonnegative(),
  endMilliseconds: z.number().int().positive()
}).strict().refine(
  (range) => range.endMilliseconds > range.startMilliseconds,
  "candidate range end must be after start"
);

export const VoiceprintTrainingCandidateSchema = z.object({
  version: z.literal(1),
  candidateId: StoreKeySchema,
  uploadId: StoreKeySchema,
  candidateKey: z.string().trim().min(1).max(1024),
  chunkId: StoreKeySchema,
  chunkIndex: z.number().int().nonnegative(),
  localSpeaker: z.string().trim().min(1).max(512),
  segmentIds: z.array(StoreKeySchema).max(MAX_SEGMENTS),
  sourceRanges: z.array(CandidateRangeSchema).max(MAX_SEGMENTS),
  durationMilliseconds: z.number().int().nonnegative().max(MAX_CANDIDATE_MS),
  audioFilePath: z.string().min(1).nullable(),
  identityState: z.enum(["verified_self", "known_contact", "unknown", "conflict"]),
  status: z.enum([
    "available",
    "insufficient",
    "ineligible",
    "queued",
    "trained",
    "failed",
    "expired"
  ]),
  operationId: StoreKeySchema.optional(),
  failureReason: z.enum([
    "audio_generation_failed",
    "provider_failed",
    "persistence_error",
    "ambiguous_timeout",
    "queue_unavailable"
  ]).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  trainedAt: z.string().datetime().optional()
}).strict();

export type VoiceprintTrainingCandidate = z.infer<
  typeof VoiceprintTrainingCandidateSchema
>;

type CandidateStore = Pick<JsonStore, "read" | "write" | "list" | "delete">;

export type VoiceprintCandidateResolution = {
  candidateKey: string;
  status: "verified" | "unknown" | "pending" | "conflict";
  ownerIdentityId: string | null;
};

export type VoiceprintCandidateFfmpegRunner = (input: {
  sourceFilePath: string;
  outputFilePath: string;
  ranges: VoiceprintTrainingCandidate["sourceRanges"];
}) => Promise<void>;

function candidateDocumentId(uploadId: string, candidateKey: string) {
  const digest = createHash("sha256")
    .update(`${uploadId}\u001f${candidateKey}`)
    .digest("hex");
  return `vp_candidate_${digest}`;
}

function datePlusRetention(timestamp: string) {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    throw new Error("candidate timestamp must be an ISO datetime");
  }
  return new Date(parsed + RETENTION_MS).toISOString();
}

function hasOverlapWithAnotherSpeaker(
  segment: TranscriptSegment,
  chunk: TranscriptChunk
) {
  return chunk.segments.some((other) =>
    other.id !== segment.id &&
    other.speaker !== segment.speaker &&
    Boolean(other.speaker?.trim()) &&
    Math.min(segment.endSeconds, other.endSeconds) >
      Math.max(segment.startSeconds, other.startSeconds)
  );
}

function trimmedRange(segment: TranscriptSegment) {
  const startMilliseconds = Math.ceil(segment.startSeconds * 1_000) + BOUNDARY_TRIM_MS;
  const endMilliseconds = Math.floor(segment.endSeconds * 1_000) - BOUNDARY_TRIM_MS;
  return endMilliseconds - startMilliseconds >= MIN_SEGMENT_MS
    ? { startMilliseconds, endMilliseconds }
    : null;
}

function selectRanges(segments: TranscriptSegment[], chunk: TranscriptChunk) {
  const eligible = [...segments]
    .sort(
      (left, right) =>
        left.startSeconds - right.startSeconds ||
        left.endSeconds - right.endSeconds ||
        left.id.localeCompare(right.id)
    )
    .flatMap((segment) => {
      if (!segment.text.trim() || hasOverlapWithAnotherSpeaker(segment, chunk)) {
        return [];
      }
      const range = trimmedRange(segment);
      return range ? [{ segment, range }] : [];
    });

  const selected: Array<{
    segment: TranscriptSegment;
    range: VoiceprintTrainingCandidate["sourceRanges"][number];
  }> = [];
  let durationMilliseconds = 0;

  for (const item of eligible) {
    if (
      selected.length >= MAX_SEGMENTS ||
      durationMilliseconds >= TARGET_CANDIDATE_MS
    ) {
      break;
    }
    const remaining = MAX_CANDIDATE_MS - durationMilliseconds;
    if (remaining < MIN_SEGMENT_MS) {
      break;
    }
    const rangeDuration =
      item.range.endMilliseconds - item.range.startMilliseconds;
    const acceptedDuration = Math.min(rangeDuration, remaining);
    if (acceptedDuration < MIN_SEGMENT_MS) {
      continue;
    }
    selected.push({
      segment: item.segment,
      range: {
        startMilliseconds: item.range.startMilliseconds,
        endMilliseconds: item.range.startMilliseconds + acceptedDuration
      }
    });
    durationMilliseconds += acceptedDuration;
  }

  return { selected, durationMilliseconds };
}

function identityState(input: {
  candidateKey: string;
  segments: TranscriptSegment[];
  resolutions: VoiceprintCandidateResolution[];
}): VoiceprintTrainingCandidate["identityState"] {
  const resolution = input.resolutions.find(
    (item) => item.candidateKey === input.candidateKey
  );
  if (resolution?.status === "conflict") {
    return "conflict";
  }
  if (
    input.segments.some(
      (segment) => segment.identity?.identityType === "known_contact"
    )
  ) {
    return "known_contact";
  }
  if (
    resolution?.status === "verified" &&
    resolution.ownerIdentityId &&
    input.segments.some(
      (segment) =>
        segment.identity?.identityType === "known_user" &&
        segment.identity.source === "provider_speaker_result"
    )
  ) {
    return "verified_self";
  }
  return "unknown";
}

function ffmpegFilter(
  ranges: VoiceprintTrainingCandidate["sourceRanges"]
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

export const runVoiceprintCandidateFfmpeg: VoiceprintCandidateFfmpegRunner =
  async (input) => {
    if (input.ranges.length === 0) {
      throw new Error("voiceprint candidate requires at least one range");
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
      ffmpegFilter(input.ranges),
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
        } else {
          reject(
            new Error(
              `voiceprint candidate ffmpeg failed with code ${code ?? "unknown"}${
                stderr.trim() ? `: ${stderr.trim()}` : ""
              }`
            )
          );
        }
      });
    });
  };

async function withCandidateLock<T>(
  candidateId: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = candidateLocks.get(candidateId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  candidateLocks.set(candidateId, current);
  try {
    return await current;
  } finally {
    if (candidateLocks.get(candidateId) === current) {
      candidateLocks.delete(candidateId);
    }
  }
}

export class VoiceprintTrainingCandidateRepository {
  constructor(
    private readonly store: CandidateStore,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async save(candidate: VoiceprintTrainingCandidate) {
    const parsed = VoiceprintTrainingCandidateSchema.parse(candidate);
    await this.store.write(COLLECTION, parsed.candidateId, parsed);
    return parsed;
  }

  async get(candidateId: string) {
    const id = StoreKeySchema.parse(candidateId);
    const value = await this.store.read<unknown>(COLLECTION, id);
    return value === null
      ? null
      : VoiceprintTrainingCandidateSchema.parse(value);
  }

  async list() {
    const records = await this.store.list<unknown>(COLLECTION);
    return records
      .map(({ value }) => VoiceprintTrainingCandidateSchema.parse(value))
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.candidateId.localeCompare(right.candidateId)
      );
  }

  async listByUpload(uploadId: string) {
    const id = StoreKeySchema.parse(uploadId);
    return (await this.list()).filter((candidate) => candidate.uploadId === id);
  }

  async update(
    candidateId: string,
    update: (
      current: VoiceprintTrainingCandidate
    ) => VoiceprintTrainingCandidate
  ) {
    const id = StoreKeySchema.parse(candidateId);
    return await withCandidateLock(id, async () => {
      const current = await this.get(id);
      if (!current) {
        throw new Error("voiceprint training candidate not found");
      }
      const next = VoiceprintTrainingCandidateSchema.parse({
        ...update(current),
        candidateId: current.candidateId,
        createdAt: current.createdAt,
        updatedAt: this.now()
      });
      await this.store.write(COLLECTION, id, next);
      return next;
    });
  }

  async cleanupExpired(uploadsRootDir: string) {
    const nowMs = Date.parse(this.now());
    const expired = (await this.list()).filter(
      (candidate) =>
        candidate.status !== "expired" &&
        Date.parse(candidate.expiresAt) <= nowMs
    );
    for (const candidate of expired) {
      await removeCandidateAudio(candidate, uploadsRootDir);
      await this.save({
        ...candidate,
        audioFilePath: null,
        status: "expired",
        updatedAt: this.now()
      });
    }
    return expired.length;
  }

  async delete(candidateId: string, uploadsRootDir: string) {
    const candidate = await this.get(candidateId);
    if (!candidate) {
      return false;
    }
    await removeCandidateAudio(candidate, uploadsRootDir);
    await this.store.delete(COLLECTION, candidate.candidateId);
    return true;
  }
}

export function isVoiceprintCandidateFilePath(
  filePath: string,
  uploadsRootDir: string
) {
  const candidateRoot = resolve(uploadsRootDir, "voiceprint-training");
  const resolvedPath = resolve(filePath);
  return (
    resolvedPath.startsWith(`${candidateRoot}${sep}`) &&
    resolvedPath.toLocaleLowerCase().endsWith(".mp3")
  );
}

async function removeCandidateAudio(
  candidate: VoiceprintTrainingCandidate,
  uploadsRootDir: string
) {
  if (
    candidate.audioFilePath &&
    isVoiceprintCandidateFilePath(candidate.audioFilePath, uploadsRootDir)
  ) {
    await rm(candidate.audioFilePath, { force: true });
  }
}

export function isVoiceprintSelfEnrollmentEnabled(
  value = process.env.VOICEPRINT_SELF_ENROLLMENT_ENABLED
) {
  return value?.trim().toLowerCase() === "true";
}

export async function generateVoiceprintTrainingCandidates(input: {
  store: JsonStore;
  uploadId: string;
  sourceFilePath: string;
  uploadsRootDir: string;
  chunks: TranscriptChunk[];
  resolvedSegments?: TranscriptSegment[];
  resolutions?: VoiceprintCandidateResolution[];
  now?: () => string;
  runFfmpeg?: VoiceprintCandidateFfmpegRunner;
}) {
  const now = input.now ?? (() => new Date().toISOString());
  const repository = new VoiceprintTrainingCandidateRepository(input.store, now);
  await repository.cleanupExpired(input.uploadsRootDir);
  const resolvedById = new Map(
    (input.resolvedSegments ?? []).map((segment) => [segment.id, segment])
  );
  const resolutions = input.resolutions ?? [];
  const groups = [...input.chunks]
    .sort((left, right) => left.index - right.index || left.id.localeCompare(right.id))
    .flatMap((chunk) => {
      const bySpeaker = new Map<string, TranscriptSegment[]>();
      for (const rawSegment of chunk.segments) {
        const localSpeaker = rawSegment.speaker?.trim();
        if (!localSpeaker) {
          continue;
        }
        const resolvedSegment = resolvedById.get(rawSegment.id);
        const segment = resolvedSegment?.identity
          ? { ...rawSegment, identity: resolvedSegment.identity }
          : rawSegment;
        const current = bySpeaker.get(localSpeaker) ?? [];
        current.push(segment);
        bySpeaker.set(localSpeaker, current);
      }
      return [...bySpeaker.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([localSpeaker, segments]) => ({
          chunk,
          localSpeaker,
          segments,
          candidateKey: speakerIdentityCandidateKey(chunk.id, localSpeaker)
        }));
    });

  const created: VoiceprintTrainingCandidate[] = [];
  const runFfmpeg = input.runFfmpeg ?? runVoiceprintCandidateFfmpeg;
  let completed = 0;

  for (const group of groups) {
    const timestamp = now();
    const candidateId = candidateDocumentId(input.uploadId, group.candidateKey);
    const selected = selectRanges(group.segments, group.chunk);
    const groupIdentityState = identityState({
      candidateKey: group.candidateKey,
      segments: group.segments,
      resolutions
    });
    const ineligible =
      groupIdentityState === "known_contact" ||
      groupIdentityState === "conflict";
    const enoughAudio = selected.durationMilliseconds >= MIN_CANDIDATE_MS;
    const outputFilePath = join(
      input.uploadsRootDir,
      "voiceprint-training",
      input.uploadId,
      `${candidateId}.mp3`
    );
    let candidate = VoiceprintTrainingCandidateSchema.parse({
      version: 1,
      candidateId,
      uploadId: input.uploadId,
      candidateKey: group.candidateKey,
      chunkId: group.chunk.id,
      chunkIndex: group.chunk.index,
      localSpeaker: group.localSpeaker,
      segmentIds: selected.selected.map((item) => item.segment.id),
      sourceRanges: selected.selected.map((item) => item.range),
      durationMilliseconds: selected.durationMilliseconds,
      audioFilePath: null,
      identityState: groupIdentityState,
      status: ineligible
        ? "ineligible"
        : enoughAudio
          ? "available"
          : "insufficient",
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: datePlusRetention(timestamp)
    });

    const existing = await repository.get(candidateId);
    if (
      existing &&
      (existing.status === "queued" || existing.status === "trained")
    ) {
      created.push(existing);
      completed += 1;
      console.info(
        `[voiceprint-candidates] progress upload_id=${input.uploadId} completed=${completed} total=${groups.length}`
      );
      continue;
    }

    if (!ineligible && enoughAudio) {
      try {
        await mkdir(dirname(outputFilePath), { recursive: true });
        await runFfmpeg({
          sourceFilePath: input.sourceFilePath,
          outputFilePath,
          ranges: candidate.sourceRanges
        });
        const outputStat = await stat(outputFilePath);
        if (!outputStat.isFile() || outputStat.size === 0) {
          throw new Error("voiceprint candidate output is empty");
        }
        candidate = VoiceprintTrainingCandidateSchema.parse({
          ...candidate,
          audioFilePath: outputFilePath
        });
      } catch (error) {
        await rm(outputFilePath, { force: true }).catch(() => undefined);
        candidate = VoiceprintTrainingCandidateSchema.parse({
          ...candidate,
          status: "failed",
          failureReason: "audio_generation_failed"
        });
        console.warn(
          `[voiceprint-candidates] generation_failed upload_id=${input.uploadId} candidate_id=${candidateId} error_name=${error instanceof Error ? error.name : "unknown"}`
        );
      }
    }

    await repository.save(candidate);
    created.push(candidate);
    completed += 1;
    console.info(
      `[voiceprint-candidates] progress upload_id=${input.uploadId} completed=${completed} total=${groups.length}`
    );
  }

  return created;
}

export async function deleteVoiceprintTrainingCandidatesForUpload(input: {
  store: JsonStore;
  uploadId: string;
  uploadsRootDir: string;
}) {
  const repository = new VoiceprintTrainingCandidateRepository(input.store);
  const candidates = await repository.listByUpload(input.uploadId);
  for (const candidate of candidates) {
    await repository.delete(candidate.candidateId, input.uploadsRootDir);
  }
  const uploadDirectory = resolve(
    input.uploadsRootDir,
    "voiceprint-training",
    input.uploadId
  );
  if (
    uploadDirectory.startsWith(
      `${resolve(input.uploadsRootDir, "voiceprint-training")}${sep}`
    )
  ) {
    await rm(uploadDirectory, { recursive: true, force: true });
  }
  return candidates.length;
}

export const voiceprintTrainingCandidateLimits = {
  boundaryTrimMilliseconds: BOUNDARY_TRIM_MS,
  minimumMilliseconds: MIN_CANDIDATE_MS,
  targetMilliseconds: TARGET_CANDIDATE_MS,
  maximumMilliseconds: MAX_CANDIDATE_MS,
  maximumSegments: MAX_SEGMENTS,
  retentionMilliseconds: RETENTION_MS
} as const;
