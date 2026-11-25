import { z } from "zod";
import { resolve, sep } from "node:path";

import {
  ProactiveInsightCacheDocumentSchema,
  proactiveInsightCacheIdForUpload
} from "@/lib/domain/proactive-insights";
import {
  AudioInsightSchema,
  AudioUploadSchema,
  BriefItemSchema,
  ProcessingJobSchema,
  RelationshipSignalCardSchema,
  SemanticSegmentSchema,
  TranscriptSegmentSchema,
  type TranscriptSegment
} from "@/lib/domain/types";
import { DayPayloadSchema, type DayPayload } from "@/lib/domain/day-payload";
import { dateCompanionParticipantKey } from "@/lib/domain/date-companion-speaker";
import {
  isDateCompanionMarkedUpload,
  type DateCompanionMarkedUpload
} from "@/lib/domain/date-companion-upload";
import type { JsonStore } from "@/lib/server/storage/json-store";
import { isDailyReflectionUpload } from "@/lib/server/daily-reflection/upload-record";

import {
  DateCompanionRepository,
  DcConflictError,
  DcNotFoundError,
  DcRetryableError,
  DcValidationError
} from "./repository";
import type { DcImportRecapCandidate } from "./types";
import { buildParticipantAudioSamples } from "./participant-audio";
import {
  participantAudioSamplesFromStaging,
  readDateCompanionAudioStaging
} from "./audio-staging";
import {
  buildDateCompanionParticipantPlan,
  type DateCompanionParticipantBuildOptions
} from "./participant-plan";
import { buildDateCompanionVoiceEnrollmentSnapshots } from "./enrollment-snapshot";
import { isDateCompanionVoiceEnrollmentRuntimeAvailable } from "./voice-enrollment";

export { isDateCompanionProviderLabelContinuityEnabled } from "./participant-plan";

type StoredAudioUpload = DateCompanionMarkedUpload & {
  filePath?: unknown;
};

export function safeDateCompanionUploadFilePath(value: unknown, uploadsRootDir?: string) {
  if (typeof value !== "string" || !value.trim() || !uploadsRootDir) return null;
  const root = resolve(uploadsRootDir);
  const candidate = resolve(value);
  if (!candidate.startsWith(`${root}${sep}`)) throw new DcValidationError("invalid_upload_file_path");
  return candidate;
}

export function normalizeDateCompanionSpeakerId(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 512 ? normalized : undefined;
}

function normalizeDateCompanionPayloadSpeakers(payload: DayPayload): DayPayload {
  return {
    ...payload,
    segments: payload.segments.map((segment) => {
      const speaker = normalizeDateCompanionSpeakerId(segment.speaker);
      const { speaker: _rawSpeaker, ...withoutSpeaker } = segment;
      return speaker ? { ...withoutSpeaker, speaker } : withoutSpeaker;
    })
  };
}

export async function buildDateCompanionParticipants(
  store: JsonStore,
  payload: DayPayload,
  userId: string,
  options: DateCompanionParticipantBuildOptions = {}
) {
  return (await buildDateCompanionParticipantPlan({
    store,
    uploadId: payload.upload.id,
    segments: payload.segments,
    userId,
    options
  })).participants;
}

async function readDayPayload(store: JsonStore, uploadId: string): Promise<DayPayload> {
  const rawUpload = await store.read<unknown>("uploads", uploadId);
  if (!rawUpload) throw new DcNotFoundError("Upload not found");
  if (isDailyReflectionUpload(rawUpload)) {
    throw new DcNotFoundError("Upload not found");
  }

  try {
    const upload = AudioUploadSchema.parse(rawUpload);
    const rawJob = await store.read<unknown>("jobs-by-upload", uploadId);
    const job = rawJob === null ? undefined : ProcessingJobSchema.parse(rawJob);
    const rawSemanticSegments = await store.read<unknown>("semantic-segments", uploadId);
    const rawRelationshipSignals = await store.read<unknown>("relationship-signals", uploadId);
    const rawProactive = await store.read<unknown>(
      "proactive-insights",
      proactiveInsightCacheIdForUpload(uploadId)
    );
    const parsedProactive = ProactiveInsightCacheDocumentSchema.safeParse(rawProactive);
    const speakerAliases = (
      await store.read<{ aliases?: Record<string, string> }>("speaker-aliases", uploadId)
    )?.aliases ?? {};

    const payload = DayPayloadSchema.parse({
      upload,
      job,
      segments: z.array(TranscriptSegmentSchema).parse(
        (await store.read<unknown>("segments", uploadId)) ?? []
      ),
      audioInsights: z.array(AudioInsightSchema).parse(
        (await store.read<unknown>("audio-insights", uploadId)) ?? []
      ),
      semanticSegments: z.array(SemanticSegmentSchema).parse(rawSemanticSegments ?? []),
      semanticSegmentsAvailable: rawSemanticSegments !== null,
      briefItems: z.array(BriefItemSchema).parse(
        (await store.read<unknown>("brief-items", uploadId)) ?? []
      ),
      relationshipSignals: z.array(RelationshipSignalCardSchema).parse(
        rawRelationshipSignals ?? []
      ),
      relationshipSignalsAvailable: rawRelationshipSignals !== null,
      proactiveInsights: parsedProactive.success ? parsedProactive.data.items : [],
      proactiveInsightsAvailable: parsedProactive.success,
      speakerAliases,
      speakerAliasesByUploadId: { [uploadId]: speakerAliases }
    });
    if ((payload.job?.status ?? payload.upload.status) !== "ready") {
      throw new DcConflictError("upload_not_ready");
    }
    return payload;
  } catch (error) {
    if (error instanceof DcConflictError) throw error;
    if (error instanceof z.ZodError) {
      throw new DcValidationError("invalid_day_payload");
    }
    throw error;
  }
}

function resolveEvidence(
  payload: DayPayload,
  segmentById: Map<string, TranscriptSegment>,
  sourceSegmentIds: string[]
) {
  const ids = [...new Set(sourceSegmentIds)];
  if (ids.length === 0) return null;
  const segments = ids.map((id) => segmentById.get(id));
  if (segments.some((segment) => !segment || segment.uploadId !== payload.upload.id)) return null;
  return (segments as TranscriptSegment[])
    .sort((left, right) => left.startSeconds - right.startSeconds || left.id.localeCompare(right.id))
    .map((segment) => ({
      uploadId: payload.upload.id,
      sourceSegmentId: segment.id,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      ...(dateCompanionParticipantKey(segment)
        ? { speakerId: dateCompanionParticipantKey(segment) }
        : {}),
      quote: segment.text
    }));
}

// An extracted task can also be a suggestion. Only file an agreement when
// the cited utterance actually contains an undertaking.
function statesAnAgreement(text: string) {
  // A quoted first person belongs to the quoted speaker. Evaluate the carrier's
  // own words separately; keep the original, unmodified text for every source.
  const ownWords = text.replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"/gu, " ");
  return ownWords.split(/[。；，,.;\n]|但(?:是)?|不过/u).some(clause => {
    if (/不是(?:由)?我|^\s*(?:(?:他|她|对方|Ta)(?:说|答应|承诺)|我(?:转述|听说))/iu.test(clause)) return false;
    if (/[？?]|(?:没(?:有)?|未(?:曾)?|不(?:是|算|代表|会|能|敢|愿|曾)?)(?:明确)?(?:答应|承诺|约定|保证|约好|说好)|能不能|会不会|是否|[吗么]\s*$|\b(?:might|maybe|could|didn't|did not)\b/iu.test(clause)) return false;
    if (/答应|承诺|保证|约定|约好了?|说好了?|一言为定|就这么定|\b(?:I|we)\s+(?:promise|commit|agree)\b/iu.test(clause)) return true;
    if (/可以|或许|也许|可能|建议|考虑|要不要|不一定|不确定/u.test(clause)) return false;
    const undertaking = /(?:由我(?:们)?负责|我(?:们)?(?:(?:一定|肯定)?会|将|负责|来(?:给|把|订|买|寄|发|带|找|负责|准备|安排)|就(?:把|给|寄|发|去|来|带)))|\b(?:I|we)(?:'ll| will)\b/iu;
    const assignedAction = /[^\s]我(?:来)?(?:订|买|寄|发|准备|安排|负责)\s*$/u;
    const datedAction = /(?:明天|后天|今晚|下周|周[一二三四五六日天]|星期[一二三四五六日天])/u.test(clause)
      && /我(?:们)?[^，。！？]{0,18}(?:发给|给你|寄出|带给|去接|预订|来接)/u.test(clause);
    return undertaking.test(clause) || assignedAction.test(clause) || datedAction;
  });
}

function classifyAgreement(text: string, evidence: DcImportRecapCandidate["evidence"], excerpt?: string) {
  const quotes = evidence.map(item => item.quote);
  const verifiedExcerpt = excerpt?.trim();
  const groundedText = verifiedExcerpt && quotes.join("").includes(verifiedExcerpt)
    ? verifiedExcerpt : quotes.join("\n");
  const optionalSummary = /也?可以|不妨|要不要|(?:只是|提出|表示)(?:一个)?建议|\b(?:could|might|suggest)\b/iu.test(text);
  if (!statesAnAgreement(groundedText) || (optionalSummary && !statesAnAgreement(text))) {
    // The model can have asserted a commitment that the speaker never made.
    return { kind: "moment" as const, proposedText: groundedText };
  }
  const condition = /前提|如果|只要|只有|要是|以.+为条件|(?:确认|收到|拿到|问到|取得|找到|核实)[^，。；]{0,12}(?:后|再|才)|provided that|\bon condition\b|\bif\b/iu;
  const boundText = quotes.join("\n");
  const conditions = boundText.split(/[。；，,.;\n]/u).map(part => part.trim()).filter(part => condition.test(part));
  // A second, unrelated "之后" in a summary says nothing about this prerequisite.
  // Prefer the verified passage (including its condition) over a lossy paraphrase.
  if (conditions.some(part => !text.includes(part))) {
    return { kind: "promise" as const, proposedText: conditions.every(part => groundedText.includes(part)) ? groundedText : boundText };
  }
  return { kind: "promise" as const, proposedText: text };
}

export function buildDateCompanionImportCandidates(payload: DayPayload): DcImportRecapCandidate[] {
  const segmentById = new Map(payload.segments.map((segment) => [segment.id, segment]));
  const candidates: DcImportRecapCandidate[] = [];
  const append = (
    kind: DcImportRecapCandidate["kind"],
    proposedText: string,
    sourceSegmentIds: string[],
    excerpt?: string
  ) => {
    const evidence = resolveEvidence(payload, segmentById, sourceSegmentIds);
    const text = proposedText.trim();
    // A missing diarization label is not a stable person identity. Do not turn
    // several unknown voices into one synthetic participant or a confirmable
    // long-term fact. The complete local transcript remains available.
    if (!evidence || !text || evidence.some((item) => !item.speakerId)) return;
    const entry = kind === "promise" ? classifyAgreement(text, evidence, excerpt) : { kind, proposedText: text };
    candidates.push({ ...entry, sortOrder: candidates.length, evidence });
  };

  for (const signal of payload.relationshipSignals.filter((item) => item.signalCategory === "positive")) {
    append("moment", signal.summary, signal.evidenceSegments.map((item) => item.segmentId));
  }
  for (const item of payload.briefItems.filter((brief) => brief.category === "notable_quote")) {
    append("moment", item.body, item.sourceSegmentIds);
  }
  for (const segment of payload.semanticSegments.filter((item) => item.confidence >= 0.7)) {
    append("moment", segment.summary, segment.sourceSegmentIds);
  }
  for (const segment of payload.semanticSegments) {
    append("mentioned", segment.summary, segment.sourceSegmentIds);
  }
  for (const item of payload.briefItems.filter(
    (brief) => brief.category === "commitment" || brief.category === "task"
  )) {
    append("promise", item.body, item.sourceSegmentIds, item.transcriptExcerpt);
  }
  for (const item of payload.briefItems.filter((brief) => brief.category === "open_question")) {
    append("continue", item.body, item.sourceSegmentIds);
  }
  for (const insight of payload.proactiveInsights.filter((item) =>
    item.type === "follow_up_question" ||
    item.type === "relationship_question" ||
    item.type === "unresolved_issue"
  )) {
    append(
      "continue",
      insight.question,
      insight.evidenceRefs.flatMap((evidence) => evidence.sourceSegmentIds)
    );
  }

  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const key = [
      candidate.kind,
      candidate.proposedText,
      ...candidate.evidence.map((evidence) => `${evidence.uploadId}:${evidence.sourceSegmentId}`)
    ].join("\u0000");
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ ...candidate, sortOrder: seen.size - 1 }];
  });
}

export class DateCompanionService {
  constructor(
    private readonly repository: DateCompanionRepository,
    private readonly options: {
      buildAudioSamples?: typeof buildParticipantAudioSamples;
      buildVoiceEnrollmentSnapshots?: typeof buildDateCompanionVoiceEnrollmentSnapshots;
      voiceEnrollmentEnabled?: boolean;
    } = {}
  ) {}

  async importInteraction(input: {
    store: JsonStore;
    userId: string;
    relationshipId: string;
    uploadId: string;
    uploadsRootDir?: string;
  }) {
    const existing = this.repository.getInteractionVersionByUpload(input.userId, input.uploadId);
    if (existing) {
      if (this.repository.getInteractionRelationshipId(input.userId, existing.interactionId) !== input.relationshipId) {
        throw new DcConflictError("interaction_relationship_conflict");
      }
    }

    const storedUpload = await input.store.read<StoredAudioUpload>("uploads", input.uploadId);
    const toyRelationshipId = (storedUpload as {
      toyIngestionRelationshipId?: unknown;
    } | null)?.toyIngestionRelationshipId;
    if (toyRelationshipId !== undefined && toyRelationshipId !== input.relationshipId) {
      throw new DcConflictError("toy_ingestion_relationship_conflict");
    }

    let payload: DayPayload;
    try {
      payload = normalizeDateCompanionPayloadSpeakers(await readDayPayload(input.store, input.uploadId));
    } catch (error) {
      if (existing && error instanceof DcNotFoundError) {
        return {
          interactionId: existing.interactionId,
          reused: true,
          view: this.repository.getRelationshipView(input.userId, input.relationshipId)
        };
      }
      throw error;
    }
    const markedForAudioStaging = isDateCompanionMarkedUpload(storedUpload ?? {});
    let stagedAudioSamples = null as ReturnType<
      typeof participantAudioSamplesFromStaging
    > | null;
    if (markedForAudioStaging) {
      try {
        const staging = await readDateCompanionAudioStaging({
          store: input.store,
          uploadId: input.uploadId,
          userId: input.userId
        });
        if (!staging) {
          throw new Error("date_companion_audio_staging_missing");
        }
        stagedAudioSamples = participantAudioSamplesFromStaging(staging);
      } catch (error) {
        console.warn(
          `[date-companion-audio] staging_unavailable upload_id=${input.uploadId} error_name=${error instanceof Error ? error.name : "unknown"}`
        );
        throw new DcRetryableError("participant_audio_staging_unavailable");
      }
    }
    const sourceFilePath = markedForAudioStaging
      ? null
      : safeDateCompanionUploadFilePath(
        storedUpload?.filePath,
        input.uploadsRootDir
      );
    const participantPlan = await buildDateCompanionParticipantPlan({
      store: input.store,
      uploadId: payload.upload.id,
      segments: payload.segments,
      userId: input.userId
    });
    const voiceEnrollmentEnabled = this.options.voiceEnrollmentEnabled
      ?? isDateCompanionVoiceEnrollmentRuntimeAvailable();
    let voiceEnrollmentSnapshots = null as Awaited<ReturnType<
      typeof buildDateCompanionVoiceEnrollmentSnapshots
    >> | null;
    if (
      voiceEnrollmentEnabled
      && (!existing || !this.repository.hasVoiceEnrollmentSnapshots(
        input.userId,
        existing.interactionId
      ))
    ) {
      try {
        voiceEnrollmentSnapshots = await (
          this.options.buildVoiceEnrollmentSnapshots
          ?? buildDateCompanionVoiceEnrollmentSnapshots
        )({
          store: input.store,
          uploadId: payload.upload.id,
          segments: payload.segments,
          participantPlan
        });
      } catch (error) {
        console.warn(
          `[date-companion-voice-enrollment] snapshot_build_failed upload_id=${input.uploadId} `
          + `error_name=${error instanceof Error ? error.name : "unknown"}`
        );
        throw new DcRetryableError("voice_enrollment_snapshot_failed");
      }
    }

    const result = this.repository.importInteraction({
      userId: input.userId,
      relationshipId: input.relationshipId,
      sourceUploadId: input.uploadId,
      recordingDate: payload.upload.recordingDate,
      originalName: payload.upload.originalName,
      ...(payload.upload.durationSeconds !== undefined
        ? { durationSeconds: payload.upload.durationSeconds }
        : {}),
      participants: participantPlan.participants,
      recapCandidates: buildDateCompanionImportCandidates(payload)
    });

    if (voiceEnrollmentSnapshots !== null && voiceEnrollmentSnapshots.length > 0) {
      try {
        this.repository.saveVoiceEnrollmentSnapshots({
          userId: input.userId,
          relationshipId: input.relationshipId,
          interactionId: result.interactionId,
          snapshots: voiceEnrollmentSnapshots
        });
      } catch (error) {
        console.warn(
          `[date-companion-voice-enrollment] snapshot_persist_failed upload_id=${input.uploadId} `
          + `error_name=${error instanceof Error ? error.name : "unknown"}`
        );
        throw new DcRetryableError("voice_enrollment_snapshot_failed");
      }
    }

    if (stagedAudioSamples !== null) {
      try {
        if (stagedAudioSamples.length > 0) {
          this.repository.saveParticipantAudioSamples({
            userId: input.userId,
            interactionId: result.interactionId,
            samples: stagedAudioSamples
          });
        }
      } catch (error) {
        console.warn(
          `[date-companion-audio] staging_persist_failed upload_id=${input.uploadId} error_name=${error instanceof Error ? error.name : "unknown"}`
        );
        throw new DcRetryableError("participant_audio_snapshot_failed");
      }
    } else if (sourceFilePath) {
      try {
        const audioSamples = await (this.options.buildAudioSamples ?? buildParticipantAudioSamples)({
          uploadId: input.uploadId,
          sourceFilePath,
          segments: payload.segments
        });
        if (audioSamples.length > 0) {
          this.repository.saveParticipantAudioSamples({
            userId: input.userId,
            interactionId: result.interactionId,
            samples: audioSamples
          });
        }
      } catch (error) {
        console.warn(
          `[date-companion-audio] generation_failed upload_id=${input.uploadId} error_name=${error instanceof Error ? error.name : "unknown"}`
        );
        throw new DcRetryableError("participant_audio_snapshot_failed");
      }
    }
    return {
      ...result,
      view: this.repository.getRelationshipView(input.userId, input.relationshipId)
    };
  }
}
