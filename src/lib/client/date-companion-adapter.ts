import type { DayPayload } from "@/lib/domain/day-payload";
import {
  emptyDateCompanionViewModel,
  type DateCompanionViewModel,
  type DateCompanionMemorySubject,
  type InteractionVM,
  type ParticipantReviewVM,
  type PromiseVM,
  type RecapItemVM,
  type RelationshipVM,
  type DateCompanionSearchResultVM,
  type SourceRefVM,
  type TranscriptChapterVM,
  type TranscriptLineVM
} from "@/lib/domain/date-companion";
import type {
  DcEvidenceSnapshot,
  DcInteractionDetail,
  DcPromise,
  DcRecapItem,
  DcRelationshipView,
  DcSearchResult
} from "@/lib/domain/date-companion-stage2";
import type { DateCompanionRelationshipPersonSource } from "@/lib/domain/date-companion-person-source";
import type { TranscriptSegment } from "@/lib/domain/types";
import {
  dateCompanionParticipantKey,
  dateCompanionParticipantLabel
} from "@/lib/domain/date-companion-speaker";

import { isRealDateCompanionUploadId } from "./date-companion-api";

export class DateCompanionAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DateCompanionAdapterError";
  }
}

export type DateCompanionRelationshipAdapterOptions = {
  hasLocalDay?: (uploadId: string) => boolean;
  getLocalDay?: (uploadId: string) => DayPayload | null;
  selectedInteractionId?: string | null;
  retainedSubjects?: Readonly<Record<string, DateCompanionMemorySubject>>;
  memoryRetainedSourceKeys?: readonly string[];
  relationshipPersonSources?: readonly DateCompanionRelationshipPersonSource[];
};

export function dateCompanionRetainedSourceKey(uploadId: string, sourceSegmentId: string) {
  return `${uploadId}\u0000${sourceSegmentId}`;
}

type SourceKind = SourceRefVM["kind"];
type SourcePresentation = SourceRefVM["presentation"];

function explicitSpeakerAlias(
  speakerId: string | undefined,
  aliases: Record<string, string>
): string | undefined {
  if (!speakerId) return undefined;
  return aliases[speakerId]?.trim() || undefined;
}

function displaySpeaker(speakerId: string | undefined, aliases: Record<string, string>): string | undefined {
  if (!speakerId) return undefined;
  const alias = explicitSpeakerAlias(speakerId, aliases);
  if (alias) return alias;

  const numberedSpeaker = /^speaker[_-]?(\d+)$/iu.exec(speakerId);
  if (numberedSpeaker) return `说话人 ${Number(numberedSpeaker[1]) + 1}`;
  return undefined;
}

function sortedTranscript(payload: DayPayload): TranscriptLineVM[] {
  return [...payload.segments]
    .sort((left, right) =>
      left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds || left.id.localeCompare(right.id)
    )
    .map((segment) => ({
      id: segment.id,
      uploadId: segment.uploadId,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      speakerId: dateCompanionParticipantKey(segment),
      speakerLabel:
        explicitSpeakerAlias(segment.speaker, payload.speakerAliases) ??
        dateCompanionParticipantLabel(segment),
      text: segment.text
    }));
}

function resolveSegments(
  segmentIds: string[],
  segmentById: Map<string, TranscriptSegment>,
  uploadId: string
): TranscriptSegment[] | null {
  const uniqueIds = [...new Set(segmentIds)];
  if (uniqueIds.length === 0) return null;

  const segments = uniqueIds.map((id) => segmentById.get(id));
  if (segments.some((segment) => !segment || segment.uploadId !== uploadId)) return null;
  return (segments as TranscriptSegment[]).sort(
    (left, right) => left.startSeconds - right.startSeconds || left.id.localeCompare(right.id)
  );
}

function sourceRef(input: {
  id: string;
  kind: SourceKind;
  presentation: SourcePresentation;
  segmentIds: string[];
  payload: DayPayload;
  segmentById: Map<string, TranscriptSegment>;
}): SourceRefVM | null {
  const segments = resolveSegments(input.segmentIds, input.segmentById, input.payload.upload.id);
  if (!segments) return null;
  const speakers = [...new Set(segments.flatMap((segment) => {
    const participantKey = dateCompanionParticipantKey(segment);
    return participantKey ? [participantKey] : [];
  }))];

  return {
    id: input.id,
    uploadId: input.payload.upload.id,
    segmentIds: segments.map((segment) => segment.id),
    recordingDate: input.payload.upload.recordingDate,
    startSeconds: Math.min(...segments.map((segment) => segment.startSeconds)),
    endSeconds: Math.max(...segments.map((segment) => segment.endSeconds)),
    ...(speakers.length === 1
      ? {
          speakerId: speakers[0],
          speakerLabel: (() => {
            const segment = segments.find(
              (candidate) => dateCompanionParticipantKey(candidate) === speakers[0]
            );
            return segment
              ? explicitSpeakerAlias(segment.speaker, input.payload.speakerAliases) ??
                  dateCompanionParticipantLabel(segment)
              : undefined;
          })()
        }
      : {}),
    quote: segments.map((segment) => segment.text).join(" "),
    kind: input.kind,
    presentation: input.presentation,
    canOpenTranscript: true
  };
}

function recapItem(input: {
  id: string;
  kind: RecapItemVM["kind"];
  title: string;
  text: string;
  source: SourceRefVM | null;
}): RecapItemVM | null {
  if (!input.source) return null;
  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    proposedText: input.text,
    displayedText: input.text,
    disposition: "pending",
    sources: [input.source]
  };
}

function buildMomentItems(payload: DayPayload, segmentById: Map<string, TranscriptSegment>): RecapItemVM[] {
  const relationshipMoments = payload.relationshipSignals
    .filter((signal) => signal.signalCategory === "positive")
    .flatMap((signal) => {
      const item = recapItem({
        id: `moment:relationship:${signal.id}`,
        kind: "moment",
        title: "一次值得记住的互动",
        text: signal.summary,
        source: sourceRef({
          id: signal.id,
          kind: "relationship",
          presentation: "derived_summary",
          segmentIds: signal.evidenceSegments.map((evidence) => evidence.segmentId),
          payload,
          segmentById
        })
      });
      return item ? [item] : [];
    });

  const quoteMoments = payload.briefItems
    .filter((item) => item.category === "notable_quote")
    .flatMap((item) => {
      const mapped = recapItem({
        id: `moment:brief:${item.id}`,
        kind: "moment",
        title: item.title,
        text: item.body,
        source: sourceRef({
          id: item.id,
          kind: "brief",
          presentation: "derived_summary",
          segmentIds: item.sourceSegmentIds,
          payload,
          segmentById
        })
      });
      return mapped ? [mapped] : [];
    });

  const semanticMoments = [...payload.semanticSegments]
    .filter((segment) => segment.confidence >= 0.7)
    .sort((left, right) => right.confidence - left.confidence || left.startSeconds - right.startSeconds)
    .flatMap((segment) => {
      const mapped = recapItem({
        id: `moment:semantic:${segment.id}`,
        kind: "moment",
        title: segment.title,
        text: segment.summary,
        source: sourceRef({
          id: segment.id,
          kind: "semantic",
          presentation: "derived_summary",
          segmentIds: segment.sourceSegmentIds,
          payload,
          segmentById
        })
      });
      return mapped ? [mapped] : [];
    });

  if (relationshipMoments.length > 0) return relationshipMoments;
  if (quoteMoments.length > 0) return quoteMoments;
  return semanticMoments.slice(0, 1);
}

function buildContinuationItems(payload: DayPayload, segmentById: Map<string, TranscriptSegment>): RecapItemVM[] {
  const openQuestions = payload.briefItems
    .filter((item) => item.category === "open_question")
    .flatMap((item) => {
      const mapped = recapItem({
        id: `continue:brief:${item.id}`,
        kind: "continue",
        title: item.title,
        text: item.body,
        source: sourceRef({
          id: item.id,
          kind: "brief",
          presentation: "derived_summary",
          segmentIds: item.sourceSegmentIds,
          payload,
          segmentById
        })
      });
      return mapped ? [mapped] : [];
    });

  const suggestions = payload.proactiveInsights
    .filter((insight) =>
      insight.type === "follow_up_question" ||
      insight.type === "relationship_question" ||
      insight.type === "unresolved_issue"
    )
    .flatMap((insight) => {
      const segmentIds = insight.evidenceRefs.flatMap((evidence) => evidence.sourceSegmentIds);
      const mapped = recapItem({
        id: `continue:proactive:${insight.id}`,
        kind: "continue",
        title: "可以自然继续",
        text: insight.question,
        source: sourceRef({
          id: insight.id,
          kind: "proactive",
          presentation: "suggestion",
          segmentIds,
          payload,
          segmentById
        })
      });
      return mapped ? [mapped] : [];
    });

  return [...openQuestions, ...suggestions];
}

function buildSemanticTopicItems(payload: DayPayload, segmentById: Map<string, TranscriptSegment>): RecapItemVM[] {
  return payload.semanticSegments.flatMap((segment) => {
    const mapped = recapItem({
      id: `mentioned:semantic:${segment.id}`,
      kind: "mentioned",
      title: segment.title,
      text: segment.summary,
      source: sourceRef({
        id: segment.id,
        kind: "semantic",
        presentation: "derived_summary",
        segmentIds: segment.sourceSegmentIds,
        payload,
        segmentById
      })
    });
    return mapped ? [mapped] : [];
  });
}

function buildParticipants(payload: DayPayload, segmentById: Map<string, TranscriptSegment>): ParticipantReviewVM[] {
  const speakerIds = [
    ...new Set(
      payload.segments
        .flatMap((segment) => {
          const participantKey = dateCompanionParticipantKey(segment);
          return participantKey ? [participantKey] : [];
        })
    )
  ];

  return speakerIds.map((speakerId) => {
    const samples = payload.segments
      .filter((segment) => dateCompanionParticipantKey(segment) === speakerId)
      .slice(0, 3)
      .flatMap((segment) => {
        const source = sourceRef({
          id: `transcript:${segment.id}`,
          kind: "transcript",
          presentation: "direct_quote",
          segmentIds: [segment.id],
          payload,
          segmentById
        });
        return source ? [source] : [];
      });
    const representative = payload.segments.find(
      (segment) => dateCompanionParticipantKey(segment) === speakerId
    );
    const alias = representative?.speaker
      ? payload.speakerAliases[representative.speaker]?.trim()
      : undefined;

    return {
      speakerId,
      displayLabel:
        (representative
          ? explicitSpeakerAlias(representative.speaker, payload.speakerAliases) ??
            dateCompanionParticipantLabel(representative) ??
            displaySpeaker(representative.speaker, payload.speakerAliases)
          : undefined) ?? "说话人",
      ...(alias ? { alias } : {}),
      state: "unresolved" as const,
      role: "unresolved" as const,
      sampleQuotes: samples
    };
  });
}

function buildChapters(payload: DayPayload, segmentById: Map<string, TranscriptSegment>): TranscriptChapterVM[] {
  const semanticChapters = [...payload.semanticSegments]
    .sort((left, right) => left.startSeconds - right.startSeconds || left.id.localeCompare(right.id))
    .flatMap((segment) => {
      const resolved = resolveSegments(segment.sourceSegmentIds, segmentById, payload.upload.id);
      if (!resolved) return [];
      return [{
        id: segment.id,
        title: segment.title,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        sourceSegmentIds: resolved.map((item) => item.id)
      }];
    });
  if (semanticChapters.length > 0) return semanticChapters;
  if (payload.segments.length === 0) return [];

  return [{
    id: `transcript:${payload.upload.id}`,
    title: "完整记录",
    startSeconds: Math.min(...payload.segments.map((segment) => segment.startSeconds)),
    endSeconds: Math.max(...payload.segments.map((segment) => segment.endSeconds)),
    sourceSegmentIds: [...payload.segments]
      .sort((left, right) => left.startSeconds - right.startSeconds)
      .map((segment) => segment.id)
  }];
}

function interactionFromPayload(payload: DayPayload): InteractionVM {
  const status = payload.job?.status ?? payload.upload.status;
  return {
    id: payload.upload.id,
    uploadIds: [payload.upload.id],
    recordingDate: payload.upload.recordingDate,
    fileName: payload.upload.originalName,
    title: "这次相处",
    durationSeconds: payload.upload.durationSeconds,
    status: status === "ready" ? "ready" : status === "failed" ? "failed" : "processing",
    progress: payload.job?.progress,
    errorMessage: payload.job?.errorMessage,
    transcript: sortedTranscript(payload)
  };
}

export function buildDateCompanionViewModel(payload: DayPayload): DateCompanionViewModel {
  if (!isRealDateCompanionUploadId(payload.upload.id)) {
    throw new DateCompanionAdapterError("A virtual day aggregate cannot be treated as one date-companion interaction");
  }

  const empty = emptyDateCompanionViewModel();
  const segmentById = new Map(payload.segments.map((segment) => [segment.id, segment]));
  const interaction = interactionFromPayload(payload);
  const moments = buildMomentItems(payload, segmentById);
  const continuations = buildContinuationItems(payload, segmentById);
  const topics = buildSemanticTopicItems(payload, segmentById);
  const recapItems = [...moments, ...continuations];
  const participants = buildParticipants(payload, segmentById);
  const chapters = buildChapters(payload, segmentById);

  return {
    relationship: null,
    currentInteraction: interaction,
    home: {
      remembered: moments[0] ?? null,
      preparePreview: continuations[0] ?? null,
      participantNotice: participants.length > 0 ? "这次相处中的人物还没有核对" : null
    },
    person: {
      remembered: [],
      recent: [],
      relationship: [],
      promises: [],
      interactions: [interaction],
      observation: null,
      limitedToCurrentInteraction: true
    },
    recap: {
      interaction,
      items: recapItems,
      participants,
      chapters
    },
    prepare: {
      ...empty.prepare,
      recentConcern: continuations[0] ?? null,
      lastTopic: topics.at(-1) ?? null,
      promise: null,
      conversationStarter: continuations[0] ?? null,
      items: [],
      openPromises: []
    }
  };
}

const LONG_TERM_TITLES: Record<RecapItemVM["kind"], string> = {
  moment: "这次值得记住",
  mentioned: "Ta 提到的",
  promise: "你答应的",
  continue: "可以自然继续"
};

function relationshipVm(view: DcRelationshipView): RelationshipVM {
  const interactionDates = view.interactions.map((interaction) => interaction.recordingDate).sort();
  return {
    id: view.relationship.id,
    displayName: view.relationship.displayName,
    knownSinceDate: interactionDates[0] ?? view.relationship.createdAt.slice(0, 10),
    lastInteractionAt: interactionDates.at(-1),
    participantState: "confirmed",
    status: view.relationship.status,
    version: view.relationship.version
  };
}

function evidenceSource(
  evidence: DcEvidenceSnapshot,
  recordingDate: string,
  options: DateCompanionRelationshipAdapterOptions,
  interactionId?: string
): SourceRefVM {
  const relationshipSource = interactionId
    ? relationshipPersonSourceFor(interactionId, evidence, options)
    : undefined;
  const uploadId = relationshipSource?.uploadId ?? evidence.uploadId;
  const sourceSegmentId = relationshipSource?.sourceSegmentId ?? evidence.sourceSegmentId;
  const memorySubject = options.retainedSubjects?.[dateCompanionRetainedSourceKey(uploadId, sourceSegmentId)];
  return {
    id: relationshipSource?.evidenceSnapshotId ?? evidence.id,
    uploadId,
    segmentIds: [sourceSegmentId],
    recordingDate: relationshipSource?.recordingDate ?? recordingDate,
    startSeconds: relationshipSource?.startSeconds ?? evidence.startSeconds,
    endSeconds: relationshipSource?.endSeconds ?? evidence.endSeconds,
    speakerId: relationshipSource?.speakerId ?? evidence.speakerId,
    quote: relationshipSource?.quote ?? evidence.quote,
    contentDigest: relationshipSource?.contentDigest ?? evidence.contentDigest,
    kind: "transcript",
    presentation: "direct_quote",
    canOpenTranscript: options.hasLocalDay?.(uploadId) === true,
    ...(memorySubject ? { memorySubject } : {})
  };
}

function persistentRecapItem(
  item: DcRecapItem,
  recordingDate: string,
  options: DateCompanionRelationshipAdapterOptions
): RecapItemVM {
  return {
    id: item.id,
    interactionId: item.interactionId,
    kind: item.kind,
    title: LONG_TERM_TITLES[item.kind],
    proposedText: item.proposedText,
    displayedText: item.displayedText,
    disposition: item.disposition,
    sources: item.evidence.map((evidence) => evidenceSource(evidence, recordingDate, options, item.interactionId)),
    version: item.version,
    sortOrder: item.sortOrder
  };
}

function persistentInteraction(
  interaction: DcInteractionDetail,
  options: DateCompanionRelationshipAdapterOptions
): InteractionVM {
  const localPayload = options.getLocalDay?.(interaction.sourceUploadId) ?? null;
  return {
    id: interaction.sourceUploadId,
    uploadIds: [interaction.sourceUploadId],
    recordingDate: interaction.recordingDate,
    fileName: interaction.originalName,
    title: "这次相处",
    durationSeconds: interaction.durationSeconds,
    status: "ready",
    transcript: localPayload ? sortedTranscript(localPayload) : [],
    relationshipInteractionId: interaction.id,
    sourceUploadId: interaction.sourceUploadId,
    persistenceStatus: interaction.status,
    sourceState: interaction.sourceState,
    version: interaction.version,
    ...(interaction.memoryBridge ? { memoryBridge: interaction.memoryBridge } : {})
  };
}

function assignmentRole(interaction: DcInteractionDetail, speakerId: string | undefined) {
  if (!speakerId) return "unresolved" as const;
  return interaction.participants.find((assignment) => assignment.speakerId === speakerId)?.role ?? "unresolved";
}

function normalizedEvidenceText(value: string) {
  return value.normalize("NFKC").trim();
}

function relationshipPersonSourceFor(
  interactionId: string,
  evidence: DcEvidenceSnapshot,
  options: DateCompanionRelationshipAdapterOptions
) {
  return options.relationshipPersonSources?.find((source) =>
    source.interactionId === interactionId
    && source.evidenceSnapshotId === evidence.id
    && source.uploadId === evidence.uploadId
    && source.sourceSegmentId === evidence.sourceSegmentId
    && normalizedEvidenceText(source.quote) === normalizedEvidenceText(evidence.quote)
  );
}

function sourceIsLongTermAdmitted(
  interaction: DcInteractionDetail,
  evidence: DcEvidenceSnapshot,
  options: DateCompanionRelationshipAdapterOptions
) {
  const memoryKey = dateCompanionRetainedSourceKey(evidence.uploadId, evidence.sourceSegmentId);
  const hasExplicitCatalogBoundary = options.memoryRetainedSourceKeys !== undefined
    || options.relationshipPersonSources !== undefined;
  if (!hasExplicitCatalogBoundary) return Boolean(options.retainedSubjects?.[memoryKey]);
  return options.memoryRetainedSourceKeys?.includes(memoryKey) === true
    || Boolean(relationshipPersonSourceFor(interaction.id, evidence, options));
}

function subjectEligible(kind: DcRecapItem["kind"], subject: DateCompanionMemorySubject | undefined) {
  if (!subject || subject === "unknown") return false;
  if (kind === "promise") return subject === "self" || subject === "both";
  if (kind === "moment") return subject === "both";
  return subject === "companion" || subject === "both";
}

function isLongTermEligible(
  interaction: DcInteractionDetail,
  item: DcRecapItem,
  options: DateCompanionRelationshipAdapterOptions
): boolean {
  if (
    interaction.status !== "confirmed" ||
    interaction.memoryBridge?.status !== "completed" ||
    item.disposition !== "kept" ||
    item.evidence.length === 0
  ) return false;
  const roles = item.evidence.map((evidence) => assignmentRole(interaction, evidence.speakerId));
  if (roles.some((role) => role === "unresolved")) return false;
  if (item.kind === "mentioned" && !roles.every((role) => role === "companion")) return false;
  if (item.kind === "promise" && !roles.every((role) => role === "self")) return false;
  return item.evidence.every((evidence) =>
    sourceIsLongTermAdmitted(interaction, evidence, options)
    && subjectEligible(
      item.kind,
      options.retainedSubjects?.[dateCompanionRetainedSourceKey(evidence.uploadId, evidence.sourceSegmentId)]
    )
  );
}

function promiseVm(
  promise: DcPromise,
  recordingDate: string,
  options: DateCompanionRelationshipAdapterOptions,
  interactionId?: string
): PromiseVM {
  return {
    id: promise.id,
    relationshipId: promise.relationshipId,
    originatingRecapItemId: promise.originatingRecapItemId,
    text: promise.text,
    status: promise.status,
    version: promise.version,
    resolvedAt: promise.resolvedAt,
    sources: promise.evidence.map((evidence) => evidenceSource(evidence, recordingDate, options, interactionId))
  };
}

function participantReviews(
  interaction: DcInteractionDetail,
  existing: ParticipantReviewVM[]
): ParticipantReviewVM[] {
  const bySpeaker = new Map(existing.map((participant) => [participant.speakerId, participant]));
  const groups = new Map<string, DcInteractionDetail["participants"]>();
  for (const assignment of interaction.participants) {
    const groupId = assignment.reviewGroupId ?? assignment.speakerId;
    const group = groups.get(groupId) ?? [];
    group.push(assignment);
    groups.set(groupId, group);
  }
  return [...groups.entries()].map(([groupId, assignments]) => {
    const memberSpeakerIds = assignments
      .map((assignment) => assignment.speakerId)
      .sort((left, right) => left.localeCompare(right));
    const locals = memberSpeakerIds.flatMap((speakerId) => {
      const local = bySpeaker.get(speakerId);
      return local ? [local] : [];
    });
    const persistedRoles = new Set(assignments.map((assignment) => assignment.role));
    const persistedRole = persistedRoles.size === 1
      ? assignments[0].role
      : "unresolved";
    const suggestionRoles = assignments.flatMap((assignment) =>
      assignment.role === "unresolved" && assignment.roleSuggestion
        ? [assignment.roleSuggestion.role]
        : []
    );
    const suggestedRoleSet = new Set(suggestionRoles);
    const suggestedRole = assignments.every((assignment) => assignment.role === "unresolved")
      && suggestionRoles.length === assignments.length
      && suggestedRoleSet.size === 1
      ? suggestionRoles[0]
      : undefined;
    const sampleQuotes = locals
      .flatMap((participant) => participant.sampleQuotes)
      .filter((source, index, sources) =>
        sources.findIndex((candidate) => candidate.id === source.id) === index
      )
      .slice(0, 3);
    const audioSpeakerId = assignments.find(
      (assignment) => assignment.audioSampleAvailable
    )?.speakerId;
    const voiceEnrollmentEligible = assignments.length > 0
      && assignments.every((assignment) => assignment.voiceEnrollmentEligible === true);
    const local = locals[0];
    return {
      speakerId: groupId,
      memberSpeakerIds,
      ...(audioSpeakerId ? { audioSpeakerId } : {}),
      ...(voiceEnrollmentEligible ? { voiceEnrollmentEligible: true as const } : {}),
      displayLabel: local?.displayLabel ?? "说话人",
      alias: local?.alias,
      state: assignments.every((assignment) => assignment.confirmedAt)
        ? "confirmed"
        : "unresolved",
      role: suggestedRole ?? persistedRole,
      ...(suggestedRole
        ? { roleSuggestion: { role: suggestedRole, source: "previous_confirmation" as const } }
        : {}),
      version: interaction.version,
      sampleQuotes
    };
  });
}

/**
 * Merges the authoritative relationship read model into the local current-upload
 * model. Draft/current transcript and QA remain local; person, prepare, promises,
 * history and confirmed text always come from the server view.
 */
export function applyDateCompanionRelationshipView(
  current: DateCompanionViewModel,
  view: DcRelationshipView,
  options: DateCompanionRelationshipAdapterOptions = {}
): DateCompanionViewModel {
  const confirmed = [...view.interactions]
    .filter((interaction) =>
      interaction.status === "confirmed" &&
      interaction.recapItems.some((item) => isLongTermEligible(interaction, item, options))
    )
    .sort((left, right) => left.recordingDate.localeCompare(right.recordingDate) || left.id.localeCompare(right.id));
  const confirmedItems = confirmed.flatMap((interaction) =>
    interaction.recapItems
      .filter((item) => isLongTermEligible(interaction, item, options))
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
      .map((item) => persistentRecapItem(item, interaction.recordingDate, options))
  );
  const dateByRecapItem = new Map(
    view.interactions.flatMap((interaction) => interaction.recapItems.map((item) => [item.id, interaction.recordingDate] as const))
  );
  const interactionByRecapItem = new Map(
    view.interactions.flatMap((interaction) => interaction.recapItems.map((item) => [item.id, interaction.id] as const))
  );
  const eligibleRecapItemIds = new Set(confirmedItems.map((item) => item.id));
  const promises = view.promises
    .filter((promise) => eligibleRecapItemIds.has(promise.originatingRecapItemId))
    .map((promise) =>
      promiseVm(
        promise,
        dateByRecapItem.get(promise.originatingRecapItemId) ?? view.relationship.createdAt.slice(0, 10),
        options,
        interactionByRecapItem.get(promise.originatingRecapItemId)
      )
    );
  const openPromises = promises.filter((promise) => promise.status === "open");
  const currentUploadId = current.currentInteraction?.sourceUploadId ?? current.currentInteraction?.id;
  const importedCurrent = currentUploadId
    ? view.interactions.find((interaction) => interaction.sourceUploadId === currentUploadId)
    : undefined;
  const explicitlySelected = options.selectedInteractionId
    ? view.interactions.find((interaction) =>
        interaction.id === options.selectedInteractionId && interaction.status === "confirmed"
      )
    : undefined;
  const recapTarget = explicitlySelected ?? importedCurrent;
  const currentInteraction = current.currentInteraction && importedCurrent
    ? {
        ...current.currentInteraction,
        relationshipInteractionId: importedCurrent.id,
        sourceUploadId: importedCurrent.sourceUploadId,
        persistenceStatus: importedCurrent.status,
        sourceState: importedCurrent.sourceState,
        version: importedCurrent.version,
        ...(importedCurrent.memoryBridge ? { memoryBridge: importedCurrent.memoryBridge } : {})
      }
    : current.currentInteraction;
  const recapInteraction = recapTarget
    ? currentInteraction && importedCurrent?.id === recapTarget.id
      ? currentInteraction
      : persistentInteraction(recapTarget, options)
    : currentInteraction;
  const currentRecapItems = recapTarget
    ? [...recapTarget.recapItems]
        .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))
        .map((item) => persistentRecapItem(item, recapTarget.recordingDate, options))
    : current.recap.items;
  const currentParticipants = recapTarget
    ? participantReviews(
        recapTarget,
        importedCurrent?.id === recapTarget.id ? current.recap.participants : []
      )
    : current.recap.participants;
  const mentioned = confirmedItems.filter((item) => item.kind === "mentioned");
  const moments = confirmedItems.filter((item) => item.kind === "moment");
  const continuations = confirmedItems.filter((item) => item.kind === "continue");
  const promiseItems = confirmedItems.filter((item) => item.kind === "promise");
  const openPromiseItems = promiseItems.filter((item) =>
    openPromises.some((promise) => promise.originatingRecapItemId === item.id)
  );
  const prepareItems = [...mentioned.slice(-1), ...moments.slice(-1), ...openPromiseItems, ...continuations.slice(-1)];
  const unresolved = currentParticipants.some((participant) => participant.state === "unresolved");

  return {
    ...current,
    relationship: relationshipVm(view),
    currentInteraction,
    home: {
      ...current.home,
      preparePreview: prepareItems.at(-1) ?? null,
      participantNotice: unresolved ? "这次相处中的人物还没有全部核对" : null
    },
    person: {
      remembered: mentioned,
      recent: mentioned.slice(-3),
      relationship: moments,
      promises,
      interactions: confirmed.map((interaction) => persistentInteraction(interaction, options)),
      observation: moments.at(-1) ?? null,
      limitedToCurrentInteraction: false
    },
    recap: {
      ...current.recap,
      interaction: recapInteraction,
      items: currentRecapItems,
      participants: currentParticipants,
      chapters: recapTarget && recapTarget.id !== importedCurrent?.id
        ? []
        : current.recap.chapters
    },
    prepare: {
      ...current.prepare,
      recentConcern: mentioned.at(-1) ?? null,
      lastTopic: moments.at(-1) ?? null,
      promise: openPromiseItems[0] ?? null,
      conversationStarter: continuations.at(-1) ?? null,
      items: prepareItems,
      openPromises
    }
  };
}

export function buildDateCompanionSearchResults(
  results: DcSearchResult[],
  options: DateCompanionRelationshipAdapterOptions & { relationshipView?: DcRelationshipView } = {}
): DateCompanionSearchResultVM[] {
  return results.filter((result) => {
    if (!options.relationshipView) return false;
    const interaction = options.relationshipView.interactions.find((candidate) => candidate.id === result.interactionId);
    const item = interaction?.recapItems.find((candidate) => candidate.id === result.recapItemId);
    return Boolean(interaction && item && isLongTermEligible(interaction, item, options));
  }).map((result) => ({
    id: result.recapItemId,
    kind: result.kind,
    text: result.text,
    recordingDate: result.recordingDate,
    sources: result.evidence.map((evidence) =>
      evidenceSource(evidence, result.recordingDate, options, result.interactionId)
    )
  }));
}
