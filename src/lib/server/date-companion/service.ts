import { z } from "zod";

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
import type { JsonStore } from "@/lib/server/storage/json-store";

import {
  DateCompanionRepository,
  DcConflictError,
  DcNotFoundError,
  DcValidationError
} from "./repository";
import type { DcImportRecapCandidate } from "./types";

async function readDayPayload(store: JsonStore, uploadId: string): Promise<DayPayload> {
  const rawUpload = await store.read<unknown>("uploads", uploadId);
  if (!rawUpload) throw new DcNotFoundError("Upload not found");

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
      ...(segment.speaker ? { speakerId: segment.speaker } : {}),
      quote: segment.text
    }));
}

export function buildDateCompanionImportCandidates(payload: DayPayload): DcImportRecapCandidate[] {
  const segmentById = new Map(payload.segments.map((segment) => [segment.id, segment]));
  const candidates: DcImportRecapCandidate[] = [];
  const append = (
    kind: DcImportRecapCandidate["kind"],
    proposedText: string,
    sourceSegmentIds: string[]
  ) => {
    const evidence = resolveEvidence(payload, segmentById, sourceSegmentIds);
    const text = proposedText.trim();
    // A missing diarization label is not a stable person identity. Do not turn
    // several unknown voices into one synthetic participant or a confirmable
    // long-term fact. The complete local transcript remains available.
    if (!evidence || !text || evidence.some((item) => !item.speakerId)) return;
    candidates.push({ kind, proposedText: text, sortOrder: candidates.length, evidence });
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
    append("promise", item.body, item.sourceSegmentIds);
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
  constructor(private readonly repository: DateCompanionRepository) {}

  async importInteraction(input: {
    store: JsonStore;
    userId: string;
    relationshipId: string;
    uploadId: string;
  }) {
    if (this.repository.hasInteractionForUpload(input.userId, input.uploadId)) {
      const existing = this.repository.importInteraction({
        userId: input.userId,
        relationshipId: input.relationshipId,
        sourceUploadId: input.uploadId,
        recordingDate: "1970-01-01",
        originalName: "reused",
        speakerIds: [],
        recapCandidates: []
      });
      return {
        ...existing,
        view: this.repository.getRelationshipView(input.userId, input.relationshipId)
      };
    }

    const payload = await readDayPayload(input.store, input.uploadId);
    const result = this.repository.importInteraction({
      userId: input.userId,
      relationshipId: input.relationshipId,
      sourceUploadId: input.uploadId,
      recordingDate: payload.upload.recordingDate,
      originalName: payload.upload.originalName,
      ...(payload.upload.durationSeconds !== undefined
        ? { durationSeconds: payload.upload.durationSeconds }
        : {}),
      speakerIds: payload.segments.flatMap((segment) => segment.speaker ? [segment.speaker] : []),
      recapCandidates: buildDateCompanionImportCandidates(payload)
    });
    return {
      ...result,
      view: this.repository.getRelationshipView(input.userId, input.relationshipId)
    };
  }
}
