import { z } from "zod";

import { dateCompanionParticipantKey } from "@/lib/domain/date-companion-speaker";
import type { TranscriptSegment } from "@/lib/domain/types";
import type { JsonStore } from "@/lib/server/storage/json-store";

import {
  buildParticipantAudioSamples,
  participantAudioLimits,
  type GeneratedParticipantAudioSample
} from "./participant-audio";
import type { DcParticipantAudioSample } from "./types";
import {
  buildDateCompanionParticipantPlan,
  type DateCompanionParticipantBuildOptions
} from "./participant-plan";

export const DATE_COMPANION_AUDIO_STAGING_COLLECTION =
  "date-companion-audio-staging";

const DATE_COMPANION_AUDIO_STAGING_RETENTION_MS = 24 * 60 * 60 * 1_000;

const MAX_STAGING_AUDIO_BASE64_LENGTH =
  Math.ceil(participantAudioLimits.maxSampleBytes / 3) * 4;

const SourceRangeSchema = z.object({
  startMilliseconds: z.number().int().nonnegative(),
  endMilliseconds: z.number().int().positive()
}).strict().refine((range) => range.endMilliseconds > range.startMilliseconds, {
  message: "participant audio source range must be positive"
});

const StagedSampleSchema = z.object({
  speakerId: z.string().trim().min(1).max(512),
  mimeType: z.literal("audio/mpeg"),
  durationMilliseconds: z.number().int().positive(),
  sourceRanges: z.array(SourceRangeSchema).min(1),
  audioBase64: z.string()
    .min(1)
    .max(MAX_STAGING_AUDIO_BASE64_LENGTH)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u)
}).strict();

const StagingBaseSchema = z.object({
  version: z.literal(1),
  uploadId: z.string().min(1),
  userId: z.string().min(1),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().optional()
});

const ReadyStagingSchema = StagingBaseSchema.extend({
  status: z.literal("ready"),
  samples: z.array(StagedSampleSchema).min(1).max(participantAudioLimits.maxSpeakers)
}).strict();

const NotApplicableStagingSchema = StagingBaseSchema.extend({
  status: z.literal("not_applicable"),
  reason: z.literal("no_eligible_speaker_ranges")
}).strict();

export const DateCompanionAudioStagingSchema = z.discriminatedUnion("status", [
  ReadyStagingSchema,
  NotApplicableStagingSchema
]);

export type DateCompanionAudioStaging = z.infer<
  typeof DateCompanionAudioStagingSchema
>;

export class DateCompanionAudioStagingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DateCompanionAudioStagingError";
  }
}

function requireOwnedStaging(input: {
  raw: unknown;
  uploadId: string;
  userId: string;
}) {
  const parsed = DateCompanionAudioStagingSchema.safeParse(input.raw);
  if (!parsed.success) {
    throw new DateCompanionAudioStagingError(
      "date_companion_audio_staging_invalid"
    );
  }
  if (
    parsed.data.uploadId !== input.uploadId ||
    parsed.data.userId !== input.userId
  ) {
    throw new DateCompanionAudioStagingError(
      "date_companion_audio_staging_owner_mismatch"
    );
  }
  return parsed.data;
}

export async function readDateCompanionAudioStaging(input: {
  store: JsonStore;
  uploadId: string;
  userId: string;
  now?: () => string;
}) {
  const raw = await input.store.read<unknown>(
    DATE_COMPANION_AUDIO_STAGING_COLLECTION,
    input.uploadId
  );
  if (raw === null) return null;
  const staging = requireOwnedStaging({ ...input, raw });
  const expiresAt = staging.expiresAt ?? new Date(
    Date.parse(staging.createdAt) + DATE_COMPANION_AUDIO_STAGING_RETENTION_MS
  ).toISOString();
  const now = input.now?.() ?? new Date().toISOString();
  if (Date.parse(expiresAt) <= Date.parse(now)) {
    await input.store.delete(DATE_COMPANION_AUDIO_STAGING_COLLECTION, input.uploadId);
    return null;
  }
  return staging;
}

function stagedDocument(input: {
  uploadId: string;
  userId: string;
  createdAt: string;
  samples: GeneratedParticipantAudioSample[];
}): DateCompanionAudioStaging {
  const expiresAt = new Date(
    Date.parse(input.createdAt) + DATE_COMPANION_AUDIO_STAGING_RETENTION_MS
  ).toISOString();
  if (input.samples.length === 0) {
    return {
      version: 1,
      uploadId: input.uploadId,
      userId: input.userId,
      createdAt: input.createdAt,
      expiresAt,
      status: "not_applicable",
      reason: "no_eligible_speaker_ranges"
    };
  }
  return DateCompanionAudioStagingSchema.parse({
    version: 1,
    uploadId: input.uploadId,
    userId: input.userId,
    createdAt: input.createdAt,
    expiresAt,
    status: "ready",
    samples: input.samples.map((sample) => ({
      speakerId: sample.speakerId,
      mimeType: sample.mimeType,
      durationMilliseconds: sample.durationMilliseconds,
      sourceRanges: sample.sourceRanges,
      audioBase64: Buffer.from(sample.audio).toString("base64")
    }))
  });
}

export async function stageDateCompanionParticipantAudio(input: {
  store: JsonStore;
  uploadId: string;
  userId: string;
  sourceFilePath: string;
  segments: TranscriptSegment[];
  buildAudioSamples?: typeof buildParticipantAudioSamples;
  participantBuildOptions?: DateCompanionParticipantBuildOptions;
  now?: () => string;
}) {
  const existing = await readDateCompanionAudioStaging(input);
  if (existing) return existing;

  const participantPlan = await buildDateCompanionParticipantPlan({
    store: input.store,
    uploadId: input.uploadId,
    segments: input.segments,
    userId: input.userId,
    options: input.participantBuildOptions
  });
  const samples = await (
    input.buildAudioSamples ?? buildParticipantAudioSamples
  )({
    uploadId: input.uploadId,
    sourceFilePath: input.sourceFilePath,
    segments: input.segments,
    selectionGroupKey: (segment) => {
      const rawSpeakerId = dateCompanionParticipantKey(segment);
      return rawSpeakerId
        ? participantPlan.reviewSpeakerIdBySpeakerId.get(rawSpeakerId) ?? rawSpeakerId
        : undefined;
    }
  });
  const document = stagedDocument({
    uploadId: input.uploadId,
    userId: input.userId,
    createdAt: input.now?.() ?? new Date().toISOString(),
    samples
  });
  await input.store.write(
    DATE_COMPANION_AUDIO_STAGING_COLLECTION,
    input.uploadId,
    document
  );
  return document;
}

export function participantAudioSamplesFromStaging(
  staging: DateCompanionAudioStaging
): DcParticipantAudioSample[] {
  if (staging.status === "not_applicable") return [];
  return staging.samples.map((sample) => {
    const audio = Buffer.from(sample.audioBase64, "base64");
    if (
      audio.byteLength <= 0 ||
      audio.byteLength > participantAudioLimits.maxSampleBytes ||
      audio.toString("base64") !== sample.audioBase64
    ) {
      throw new DateCompanionAudioStagingError(
        "date_companion_audio_staging_invalid_audio"
      );
    }
    return {
      speakerId: sample.speakerId,
      mimeType: sample.mimeType,
      durationMilliseconds: sample.durationMilliseconds,
      audio: new Uint8Array(audio)
    };
  });
}

export async function deleteDateCompanionAudioStaging(
  store: JsonStore,
  uploadId: string
) {
  await store.delete(DATE_COMPANION_AUDIO_STAGING_COLLECTION, uploadId);
}

export async function cleanupExpiredDateCompanionAudioStaging(input: {
  store: JsonStore;
  now?: () => string;
}) {
  const nowMs = Date.parse(input.now?.() ?? new Date().toISOString());
  let deleted = 0;
  for (const record of await input.store.list<unknown>(
    DATE_COMPANION_AUDIO_STAGING_COLLECTION
  )) {
    const parsed = DateCompanionAudioStagingSchema.safeParse(record.value);
    if (!parsed.success) {
      await input.store.delete(DATE_COMPANION_AUDIO_STAGING_COLLECTION, record.id);
      deleted += 1;
      continue;
    }
    const expiresAt = parsed.data.expiresAt ?? new Date(
      Date.parse(parsed.data.createdAt) + DATE_COMPANION_AUDIO_STAGING_RETENTION_MS
    ).toISOString();
    if (Date.parse(expiresAt) > nowMs) continue;
    await input.store.delete(DATE_COMPANION_AUDIO_STAGING_COLLECTION, record.id);
    deleted += 1;
  }
  return deleted;
}

export const dateCompanionAudioStagingLimits = {
  retentionMilliseconds: DATE_COMPANION_AUDIO_STAGING_RETENTION_MS
} as const;
