"use client";

import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  DateCompanionMutationState,
  DateCompanionMemoryBridgeState,
  DateCompanionMemoryReviewInteraction,
  DateCompanionMemoryMutationState,
  DateCompanionMemorySubject,
  DateCompanionRelationshipReconfirmationRequest,
  DateCompanionParticipantRole,
  DateCompanionVoiceEnrollmentIntent,
  InteractionVM,
  ParticipantReviewVM,
  RecapItemVM,
  SourceRefVM,
  TranscriptLineVM
} from "@/lib/domain/date-companion";
import type {
  DcReviewedSegment,
  DcSpeakerReviewMutation,
  DcSubjectDraftPreview,
  DcSubjectSuggestionBatch,
  DcSubjectSuggestionConfirmation
} from "@/lib/domain/date-companion-stage2";
import {
  loadDateCompanionSubjectSuggestions
} from "@/lib/client/date-companion-subject-suggestions";
import { formatTimestamp, type TranscriptChapterPresentation } from "./companion-transcript";
import { BookRecap, bookItemCopy, bookMeetingTitle, bookRetentionReason, type BookItem } from "./book-recap";
import { BookMemory, BookPanelsProvider } from "./book-panels";
import styles from "./date-companion.module.css";

export type CompanionParticipantMutation = DcSpeakerReviewMutation;

export type CompanionRecapItemMutation = {
  id: string;
  version: number;
  userText?: string | null;
  disposition: RecapItemVM["disposition"];
};

type CompanionRecapProps = {
  relationshipName?: string;
  chapters?: TranscriptChapterPresentation[];
  initialSegmentId?: string | null;
  bookHomeHref?: string;
  onReturnToSourceOrigin?: () => void;
  interaction: InteractionVM | null;
  items: RecapItemVM[];
  mutationState?: DateCompanionMutationState;
  participants?: ParticipantReviewVM[];
  memoryBridgeState?: DateCompanionMemoryBridgeState;
  memoryMutationState?: DateCompanionMemoryMutationState;
  proactiveObservation?: ReactNode;
  questionControl?: ReactNode;
  onSaveSegmentReview?: (assignments: CompanionParticipantMutation[]) => Promise<void>;
  onFinalize?: (
    assignments: CompanionParticipantMutation[],
    items: CompanionRecapItemMutation[],
    voiceEnrollmentIntents: DateCompanionVoiceEnrollmentIntent[],
    memoryAdmission?: {
      mappingVersion: number;
      subjectSuggestionConfirmation: DcSubjectSuggestionConfirmation;
      selections: Array<{ evidenceSnapshotId: string; subject: DateCompanionMemorySubject }>;
    }
  ) => Promise<void> | void;
  onMemorySync?: (
    selections?: Array<{ evidenceSnapshotId: string; subject: DateCompanionMemorySubject }>,
    subjectSuggestionConfirmation?: DcSubjectSuggestionConfirmation,
    relationshipReconfirmation?: DateCompanionRelationshipReconfirmationRequest
  ) => Promise<void> | void;
  onMemoryRefresh?: () => Promise<void> | void;
};

type SubjectSuggestionState =
  | { status: "idle" }
  | { status: "loading"; scope: string }
  | { status: "ready"; scope: string; batch: DcSubjectSuggestionBatch }
  | { status: "error"; scope: string; message: string };

const GROUPS: Array<{ kind: RecapItemVM["kind"]; eyebrow: string; title: string; empty: string }> = [
  { kind: "moment", eyebrow: "01 · 一个瞬间", title: "这次值得记住", empty: "还没有找到带真实来源的特别片段" },
  { kind: "mentioned", eyebrow: "02 · Ta 提到的", title: "Ta 说起了什么", empty: "人物尚未核对，暂不把任何片段确定归给 Ta" },
  { kind: "promise", eyebrow: "03 · 你答应的", title: "这次出现的约定", empty: "还没有找到由“我”明确说出的约定" },
  { kind: "continue", eyebrow: "04 · 可以继续", title: "下次自然接上", empty: "还没有带来源的开放问题" }
];

const ROLE_OPTIONS: Array<{ role: DateCompanionParticipantRole; label: string }> = [
  { role: "self", label: "我" },
  { role: "companion", label: "Ta" },
  { role: "unresolved", label: "暂不确定" }
];

const SUBJECT_OPTIONS: Array<{ subject: DateCompanionMemorySubject; label: string }> = [
  { subject: "self", label: "关于我" },
  { subject: "companion", label: "关于 Ta" },
  { subject: "both", label: "关于我们" },
  { subject: "unknown", label: "暂不确定" }
];

const MEMORY_STATUS_COPY = {
  waiting_for_cleanup: "等待整理",
  pending: "等待整理",
  processing: "正在整理",
  completed: "已整理",
  retryable_failed: "整理未完成，可重试",
  needs_review: "需要重新确认人物或内容",
  cancelled: "未保留或已取消",
  not_queued: "尚未选择长期保留"
} as const;

function latestMemoryStatus(
  interactionBridge: InteractionVM["memoryBridge"],
  reviewInteraction: DateCompanionMemoryReviewInteraction | undefined
) {
  if (!reviewInteraction) return interactionBridge?.status ?? "not_queued";
  // A fresh review with no active grant supersedes the old interaction's saved receipt.
  if (reviewInteraction.status === "not_queued") return "not_queued";
  if (!interactionBridge) return reviewInteraction.status;
  const interactionUpdatedAt = Date.parse(interactionBridge.updatedAt);
  const reviewUpdatedAt = reviewInteraction.updatedAt ? Date.parse(reviewInteraction.updatedAt) : Number.NaN;
  if (!Number.isFinite(reviewUpdatedAt)) return interactionBridge.status;
  if (!Number.isFinite(interactionUpdatedAt)) return reviewInteraction.status;
  return reviewUpdatedAt >= interactionUpdatedAt ? reviewInteraction.status : interactionBridge.status;
}

function memoryReviewRevisionToken(review: DateCompanionMemoryReviewInteraction | undefined) {
  if (!review || review.attemptCount < 0 || !Number.isInteger(review.attemptCount) || !review.updatedAt) return null;
  const updatedAtMs = Date.parse(review.updatedAt);
  if (!Number.isFinite(updatedAtMs) || updatedAtMs < 0) return null;
  return `a${review.attemptCount.toString(36)}-t${updatedAtMs.toString(36)}`;
}

function normalizedSpeakerId(value: string | undefined) {
  const normalized = value?.trim();
  return normalized && normalized.length <= 512 ? normalized : undefined;
}

function speakerGroups(lines: TranscriptLineVM[], participants: ParticipantReviewVM[]) {
  const groups = new Map<string, { id: string; label?: string; samples: string[] }>();
  for (const participant of participants) {
    const key = normalizedSpeakerId(participant.speakerId);
    if (!key || groups.has(key)) continue;
    groups.set(key, {
      id: key,
      label: participant.displayLabel?.trim() || undefined,
      samples: participant.sampleQuotes
        .map((source) => source.quote.trim())
        .filter((quote, index, quotes) => quote.length > 0 && quotes.indexOf(quote) === index)
        .slice(0, 3)
    });
  }

  const hasServerParticipants = participants.length > 0;
  for (const line of lines) {
    const key = normalizedSpeakerId(line.speakerId);
    if (!key || (hasServerParticipants && !groups.has(key))) continue;
    const existing = groups.get(key) ?? { id: key, label: line.speakerLabel, samples: [] };
    if (!existing.label && line.speakerLabel) existing.label = line.speakerLabel;
    const sample = line.text.trim();
    if (sample && existing.samples.length < 3 && !existing.samples.includes(sample)) existing.samples.push(sample);
    groups.set(key, existing);
  }
  return [...groups.values()];
}

function initialRoles(
  speakers: Array<{ id: string }>,
  participants: ParticipantReviewVM[]
): Record<string, DateCompanionParticipantRole> {
  const persisted = new Map(participants.map((participant) => [participant.speakerId, participant.role]));
  return Object.fromEntries(speakers.map((speaker) => [speaker.id, persisted.get(speaker.id) ?? "unresolved"]));
}

function participantMemberSpeakerIds(participant: ParticipantReviewVM | undefined, fallback: string) {
  const memberSpeakerIds = participant?.memberSpeakerIds
    ?.map(normalizedSpeakerId)
    .filter((speakerId): speakerId is string => Boolean(speakerId));
  return memberSpeakerIds && memberSpeakerIds.length > 0
    ? [...new Set(memberSpeakerIds)]
    : [fallback];
}

function sourceSpeakerRoles(
  participants: ParticipantReviewVM[],
  roles: Readonly<Record<string, DateCompanionParticipantRole>>
) {
  const sourceRoles: Record<string, DateCompanionParticipantRole> = { ...roles };
  for (const participant of participants) {
    const groupRole = roles[participant.speakerId] ?? "unresolved";
    for (const speakerId of participantMemberSpeakerIds(participant, participant.speakerId)) {
      sourceRoles[speakerId] = groupRole;
    }
  }
  return sourceRoles;
}

function automaticDisposition(
  item: RecapItemVM,
  roleFor: (id?: string, segmentId?: string) => DateCompanionParticipantRole | undefined
): RecapItemVM["disposition"] {
  const safe = item.sources.length > 0 && item.sources.every((source) => {
    if (!source.speakerId) return false;
    const role = roleFor(source.speakerId, source.segmentIds[0]) ?? "unresolved";
    if (role === "unresolved") return false;
    if (item.kind === "mentioned") return role === "companion";
    if (item.kind === "promise") return role === "self";
    return true;
  });
  return safe ? "kept" : "excluded";
}

export function CompanionRecap({
  relationshipName,
  chapters,
  initialSegmentId,
  bookHomeHref,
  onReturnToSourceOrigin,
  interaction,
  items,
  mutationState = { status: "idle" },
  participants = [],
  memoryBridgeState = { status: "idle" },
  memoryMutationState = { status: "idle" },
  proactiveObservation,
  questionControl,
  onFinalize,
  onSaveSegmentReview,
  onMemorySync,
  onMemoryRefresh
}: CompanionRecapProps) {
  const operationLock = useRef(false);
  const [segmentEdits, setSegmentEdits] = useState<{ scope: string; groups: Record<string, DcReviewedSegment[]> } | null>(null);
  const [roleEdits, setRoleEdits] = useState<{ scope: string; values: Record<string, DateCompanionParticipantRole> } | null>(null);
  const [audioErrors, setAudioErrors] = useState<Record<string, boolean>>({});
  const [manuallyExcludedIds, setManuallyExcludedIds] = useState<Set<string>>(() => new Set());
  const [editedTexts, setEditedTexts] = useState<Record<string, string>>({});
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [rememberVoiceGroupId, setRememberVoiceGroupId] = useState<string | null>(null);

  const [longTermDraftId, setLongTermDraftId] = useState<string | null>(null);
  const includeLongTerm = Boolean(interaction && longTermDraftId === interaction.id);
  const [localOperation, setLocalOperation] = useState<"finalize" | "sync" | "refresh" | "participants" | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localErrorOperation, setLocalErrorOperation] = useState<"finalize" | "sync" | "refresh" | "participants" | null>(null);
  const [subjectSuggestionState, setSubjectSuggestionState] = useState<SubjectSuggestionState>({ status: "idle" });
  const subjectRequest = useRef<AbortController | null>(null);

  const validItems = useMemo(() => items.filter((item) => item.sources.length > 0), [items]);
  const speakers = useMemo(
    () => speakerGroups(interaction?.transcript ?? [], participants),
    [interaction?.transcript, participants]
  );
  const unassignedTranscriptCount = useMemo(
    () => interaction?.transcript.filter((line) => !line.speakerId).length ?? 0,
    [interaction?.transcript]
  );
  const participantSyncKey = participants.map((participant) =>
    `${participant.speakerId}:${participant.memberSpeakerIds?.join(",") ?? ""}:${participant.audioSpeakerId ?? ""}:${participant.role}:${participant.state}:${participant.version ?? 0}`
  ).join("|");
  const speakerSyncKey = speakers.map((speaker) => speaker.id).join("|");

  // The detail response already includes the saved identities. Render them in
  // the same commit as the entries; only unsaved manual choices need local state.
  const roleScope = JSON.stringify([interaction?.id, participantSyncKey, speakerSyncKey]);
  const localRoles = roleEdits?.scope === roleScope ? roleEdits.values : undefined;
  const splitGroups = useMemo(() => ({
    ...Object.fromEntries(participants.flatMap(p => p.reviewedSegments ? [[p.speakerId, p.reviewedSegments] as const] : [])),
    ...(segmentEdits?.scope === roleScope ? segmentEdits.groups : {})
  }), [participants, roleScope, segmentEdits]);
  const roles = useMemo(() => ({
    ...initialRoles(speakers, participants), ...localRoles,
    ...Object.fromEntries(Object.keys(splitGroups).map(id => [id, "unresolved" as const]))
  }), [speakers, participants, localRoles, splitGroups]);
  const segmentSources = useMemo(() => {
    const byId = new Map<string, SourceRefVM>();
    for (const item of validItems) for (const source of item.sources) {
      if (source.segmentIds.length === 1 && source.contentDigest && source.presentation === "direct_quote") {
        byId.set(source.segmentIds[0], source);
      }
    }
    return byId;
  }, [validItems]);
  function changeSegmentReview(groupId: string, reviewed: DcReviewedSegment[]) {
    setSegmentEdits(current => ({
      scope: roleScope, groups: { ...(current?.scope === roleScope ? current.groups : {}), [groupId]: reviewed }
    }));
    if (rememberVoiceGroupId === groupId) setRememberVoiceGroupId(null);
  }
  const reviewedSpeakerIds = useMemo(() => new Set([
    ...participants.filter(person => person.state === "confirmed").map(person => person.speakerId),
    ...Object.keys(localRoles ?? {}), ...Object.keys(splitGroups)
  ]), [participants, localRoles, splitGroups]);

  useEffect(() => {
    setAudioErrors({});
    setManuallyExcludedIds(new Set());
    setEditedTexts({});
    setEditingItemId(null);
    setEditingText("");
    setRememberVoiceGroupId(null);
    setLongTermDraftId(null);
    setSubjectSuggestionState({ status: "idle" });
    setLocalError(null);
    setLocalErrorOperation(null);
  }, [interaction?.id]);

  const editable = Boolean(onFinalize);
  const confirmed = interaction?.persistenceStatus === "confirmed";
  const participantReviewComplete = speakers.every((speaker) => reviewedSpeakerIds.has(speaker.id));
  const rolesBySourceSpeaker = useMemo(
    () => sourceSpeakerRoles(participants, roles),
    [participants, roles]
  );
  const confirmedSpeakers = useMemo(() => {
    const ids = new Set(reviewedSpeakerIds);
    for (const person of participants) {
      if (ids.has(person.speakerId)) {
        for (const id of participantMemberSpeakerIds(person,person.speakerId)) ids.add(id);
      }
    }
    return ids;
  }, [participants,reviewedSpeakerIds]);
  const splitByMember = useMemo(() => {
    const result = new Map<string, Map<string, DcReviewedSegment>>();
    for (const [groupId, reviewed] of Object.entries(splitGroups)) {
      const participant = participants.find(p => p.speakerId === groupId);
      const byId = new Map(reviewed.map(s => [s.sourceSegmentId, s]));
      for (const id of participantMemberSpeakerIds(participant, groupId)) result.set(id, byId);
    }
    return result;
  }, [participants, splitGroups]);
  const roleForSource = useCallback((id?: string, segmentId?: string) => {
    if (!id) return undefined;
    const group = splitByMember.get(id);
    if (!group) return rolesBySourceSpeaker[id];
    const source = segmentId && segmentSources.get(segmentId);
    const review = segmentId && group.get(segmentId);
    return source && review && source.speakerId === id && review.contentDigest === source.contentDigest
      ? review.role : "unresolved";
  }, [rolesBySourceSpeaker, segmentSources, splitByMember]);
  const knownRole = useCallback((id?: string, segmentId?: string) =>
    id && confirmedSpeakers.has(id) ? roleForSource(id, segmentId) : undefined,
  [confirmedSpeakers,roleForSource]);
  const speakerLabel = useCallback((id?: string, segmentId?: string, line?: TranscriptLineVM) => {
    if (!id) return "说话人未识别";
    if (line && splitByMember.has(id)) {
      const snapshot = segmentSources.get(line.id);
      if (!snapshot || snapshot.uploadId !== line.uploadId || snapshot.quote !== line.text
        || snapshot.startSeconds !== line.startSeconds || snapshot.endSeconds !== line.endSeconds) return "身份暂不确定";
    }
    const role = knownRole(id, segmentId);
    if (role === "self") return "我";
    if (role === "companion") return relationshipName?.trim() || "Ta";
    return role === "unresolved" ? "身份暂不确定" : "说话人待核对";
  },[knownRole,relationshipName,segmentSources,splitByMember]);
  const finalizeItems = useMemo(() => validItems.map((item) => {
    const editedText = editedTexts[item.id]?.trim();
    return {
      id: item.id,
      version: item.version ?? 0,
      ...(editedText ? { userText: editedText } : {}),
      disposition: confirmed
        ? item.disposition
        : manuallyExcludedIds.has(item.id)
        ? "excluded"
        : automaticDisposition(item, roleForSource)
    } satisfies CompanionRecapItemMutation;
  }), [confirmed, editedTexts, manuallyExcludedIds, roleForSource, validItems]);
  const keptCount = finalizeItems.filter((item) => item.disposition === "kept").length;
  const saving = mutationState.status === "saving" || memoryMutationState.status === "saving" || localOperation !== null;
  const mutationError = mutationState.status === "error"
    ? mutationState.message
    : memoryMutationState.status === "error"
      ? memoryMutationState.message
      : null;
  const memorySyncError = localErrorOperation === "sync" && localError
    ? localError
    : memoryMutationState.status === "error" && memoryMutationState.operation === "sync"
      ? memoryMutationState.message
      : null;
  const pageError = memorySyncError
    ? mutationState.status === "error" ? mutationState.message : null
    : localError || mutationError;
  const canFinalize = Boolean(onFinalize) && !confirmed && keptCount > 0 && !saving;
  const enrollmentEligibleGroups = useMemo(() => speakers.flatMap((speaker) => {
    const participant = participants.find((candidate) => candidate.speakerId === speaker.id);
    return roles[speaker.id] === "companion"
      && participant?.audioSpeakerId
      && participant.voiceEnrollmentEligible === true
      && !participant.roleSuggestion
      && !audioErrors[speaker.id]
      ? [{ speaker, participant }]
      : [];
  }), [audioErrors, participants, roles, speakers]);
  const voiceEnrollmentIntents = useMemo<DateCompanionVoiceEnrollmentIntent[]>(() => {
    const selected = enrollmentEligibleGroups.find((candidate) => candidate.speaker.id === rememberVoiceGroupId);
    if (!selected) return [];
    const memberSpeakerIds = participantMemberSpeakerIds(
      selected.participant,
      selected.speaker.id
    );
    return memberSpeakerIds.length > 0 ? [{ speakerIds: memberSpeakerIds }] : [];
  }, [enrollmentEligibleGroups, rememberVoiceGroupId]);
  const readyMemoryBridge = memoryBridgeState.status === "ready" ? memoryBridgeState : null;
  const memoryReady = Boolean(readyMemoryBridge);
  const mapping = readyMemoryBridge?.mapping ?? null;
  const longTermReady = Boolean(
    memoryReady &&
    readyMemoryBridge?.setting.enabled &&
    mapping?.status === "confirmed" &&
    mapping.selfPersonId !== mapping.companionPersonId
  );
  const reviewInteraction = readyMemoryBridge && interaction?.relationshipInteractionId
    ? readyMemoryBridge.review.interactions.find(
        (candidate) => candidate.interactionId === interaction.relationshipInteractionId
      )
    : undefined;
  const memoryStatus = latestMemoryStatus(interaction?.memoryBridge, reviewInteraction);
  const memoryReview = reviewInteraction?.review ?? interaction?.memoryBridge?.review;
  const memoryReviewRevision = memoryReviewRevisionToken(reviewInteraction);
  const relationshipReconfirmationRequired = memoryStatus === "needs_review"
    && memoryReview?.kind === "relationship_reconfirmation_required"
    && memoryReview.canReconfirm;
  const memoryStillProcessing = memoryStatus === "waiting_for_cleanup"
    || memoryStatus === "pending"
    || memoryStatus === "processing";
  const previewItemIds = !confirmed && includeLongTerm ? validItems
    .filter(item => !manuallyExcludedIds.has(item.id) && item.disposition !== "excluded"
      && automaticDisposition(item, knownRole) === "kept")
    .map(item => item.id) : [];
  const subjectEditable = Boolean(
    longTermReady && (confirmed
      ? keptCount > 0 && (memoryStatus === "not_queued" || relationshipReconfirmationRequired)
      : previewItemIds.length > 0)
  );
  const subjectInteractionId = interaction?.relationshipInteractionId;
  const subjectInteractionVersion = interaction?.version ?? 0;
  const subjectMappingVersion = mapping?.version;
  const participantAssignments = speakers.flatMap((speaker) => {
    const participant = participants.find((candidate) => candidate.speakerId === speaker.id);
    return participantMemberSpeakerIds(participant, speaker.id).map((speakerId) => ({
      speakerId,
      role: roles[speaker.id] ?? "unresolved",
      ...(splitGroups[speaker.id] ? { reviewedSegments: splitGroups[speaker.id].filter(s =>
        segmentSources.get(s.sourceSegmentId)?.speakerId === speakerId) } : {})
    }));
  });
  const previewKey = subjectEditable && !confirmed ? JSON.stringify({
    version: subjectInteractionVersion,
    itemIds: previewItemIds,
    assignments: participantAssignments.filter(a => confirmedSpeakers.has(a.speakerId))
  } satisfies DcSubjectDraftPreview) : null;
  const subjectScope = JSON.stringify([subjectInteractionId, subjectInteractionVersion, subjectMappingVersion,
    mapping?.selfPersonId, mapping?.companionPersonId, confirmed, previewKey]);
  const requestSubjectPreview = useCallback(() => {
    if (!subjectEditable || !subjectInteractionId || subjectMappingVersion === undefined || subjectRequest.current) return;
    const controller = new AbortController();
    subjectRequest.current = controller;
    setSubjectSuggestionState({ status: "loading", scope: subjectScope });
    void loadDateCompanionSubjectSuggestions({
      interactionId: subjectInteractionId,
      interactionVersion: subjectInteractionVersion,
      mappingVersion: subjectMappingVersion,
      draftPreview: previewKey ? JSON.parse(previewKey) as DcSubjectDraftPreview : undefined,
      signal: controller.signal
    }).then((batch) => {
      if (controller.signal.aborted) return;
      if (
        batch.interactionId !== subjectInteractionId
        || batch.mappingVersion !== subjectMappingVersion
        || batch.interactionVersion !== subjectInteractionVersion
      ) {
        setSubjectSuggestionState({ status: "error", scope: subjectScope, message: "这次内容已经变化，请重新核对归属建议。" });
        return;
      }
      setSubjectSuggestionState({ status: "ready", scope: subjectScope, batch });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setSubjectSuggestionState({
        status: "error",
        scope: subjectScope,
        message: confirmed ? "这次归属建议未能取得，可以重试。"
          : error instanceof Error && error.message === "subject_suggestion_provider_unavailable"
            ? "这次人物范围暂时没有整理好；你仍可完成本次复盘。"
            : "这次内容范围暂时没有整理好；你仍可完成本次复盘。"
      });
    }).finally(() => {
      if (subjectRequest.current === controller) subjectRequest.current = null;
    });
  }, [subjectEditable, subjectInteractionId, subjectInteractionVersion, subjectMappingVersion, confirmed, previewKey, subjectScope]);
  const cancelSubjectRequest = useCallback(() => {
    subjectRequest.current?.abort();
    subjectRequest.current = null;
  }, []);
  useEffect(() => {
    setSubjectSuggestionState({ status: "idle" });
    // Only an opted-in draft follows changes to the selected material. A saved
    // recap starts this same loader exclusively from its explicit preview button.
    if (previewKey) requestSubjectPreview();
    return cancelSubjectRequest;
  }, [previewKey, requestSubjectPreview, cancelSubjectRequest]);
  const currentSubjectState = subjectEditable && subjectSuggestionState.status !== "idle"
    && subjectSuggestionState.scope === subjectScope ? subjectSuggestionState : null;
  const subjectSuggestionBatch = currentSubjectState?.status === "ready"
    ? currentSubjectState.batch
    : null;
  const suggestedSubjectByEvidenceId = useMemo(() => new Map(
    subjectSuggestionBatch?.suggestions.flatMap((suggestion) =>
      suggestion.evidenceSnapshotIds.map((evidenceSnapshotId) => [
        evidenceSnapshotId,
        suggestion.proposedSubject
      ] as const)
    ) ?? []
  ), [subjectSuggestionBatch]);
  const memoryAdmissionSelections = useMemo(() => {
    const selections = finalizeItems.flatMap((mutation) => {
    if (mutation.disposition !== "kept") return [];
    const item = validItems.find((candidate) => candidate.id === mutation.id);
    if (!item?.interactionId) return [];
    return item.sources.flatMap((source) => {
      const subject = suggestedSubjectByEvidenceId.get(source.id);
      return subject ? [{ evidenceSnapshotId: source.id, subject }] : [];
    });
    });
    return [...new Map(selections.map((selection) => [selection.evidenceSnapshotId, selection])).values()];
  }, [finalizeItems, suggestedSubjectByEvidenceId, validItems]);
  const keptEvidenceSnapshotIds = useMemo(() => new Set(finalizeItems.flatMap((mutation) => {
    if (mutation.disposition !== "kept") return [];
    return validItems.find((candidate) => candidate.id === mutation.id)?.sources.map((source) => source.id) ?? [];
  })), [finalizeItems, validItems]);
  const automaticSubjectsComplete = Boolean(
    subjectSuggestionBatch
    && memoryAdmissionSelections.length === keptEvidenceSnapshotIds.size
  );
  const subjectSuggestionConfirmation = subjectSuggestionBatch ? {
    batchId: subjectSuggestionBatch.batchId,
    evidenceDigest: subjectSuggestionBatch.evidenceDigest,
    proposalDigest: subjectSuggestionBatch.proposalDigest,
    confirmationFingerprint: subjectSuggestionBatch.confirmationFingerprint,
    confirmedVisibleSuggestions: true as const
  } : null;
  const relationshipReconfirmation = relationshipReconfirmationRequired
    && interaction?.relationshipInteractionId
    && mapping
    && subjectSuggestionConfirmation
    && memoryReviewRevision
    ? {
        action: "reconfirm_archived_relationship" as const,
        idempotencyKey: [
          "dc-rel-reconfirm",
          "v2",
          subjectSuggestionConfirmation.confirmationFingerprint,
          memoryReviewRevision
        ].join(":")
      }
    : undefined;
  const memoryAdmission = longTermReady && mapping && subjectSuggestionConfirmation && automaticSubjectsComplete
    ? {
        mappingVersion: mapping.version,
        subjectSuggestionConfirmation,
        selections: memoryAdmissionSelections
      }
    : undefined;
  const retainedItems = useMemo(() => finalizeItems.flatMap((mutation) => {
    if (mutation.disposition !== "kept") return [];
    const item = validItems.find((candidate) => candidate.id === mutation.id);
    return item ? [item] : [];
  }), [finalizeItems, validItems]);
  const runMutation = async (
    operation: "finalize" | "sync" | "refresh" | "participants",
    action: () => Promise<void> | void
  ) => {
    if (saving || operationLock.current) return;
    operationLock.current = true;
    setLocalOperation(operation);
    setLocalError(null);
    setLocalErrorOperation(null);
    try {
      await action();
    } catch (error) {
      setLocalError(error instanceof Error && error.message.trim() ? error.message : "暂时没有保存成功，请稍后再试。");
      setLocalErrorOperation(operation);
    } finally {
      operationLock.current = false;
      setLocalOperation(null);
    }
  };

  const recapItemPresentation = (item: RecapItemVM) => {
    const manuallyExcluded = manuallyExcludedIds.has(item.id);
    const disposition = confirmed
      ? item.disposition
      : manuallyExcluded
        ? "excluded"
        : automaticDisposition(item, roleForSource);
    return { item, disposition, manuallyExcluded };
  };

  function editItem(item: RecapItemVM) {
    if (!editable || confirmed || saving || recapItemPresentation(item).disposition !== "kept") return;
    setEditingItemId(item.id);
    setEditingText(editedTexts[item.id] ?? (item.displayedText || item.proposedText));
  }
  function applyEdit() {
    if (!editingItemId || !editingText.trim() || !editable || confirmed || saving) return;
    setEditedTexts((current) => ({ ...current, [editingItemId]: editingText.trim() }));
    setEditingItemId(null);
  }
  function changeRetention(item: RecapItemVM) {
    if (!editable || confirmed || saving) return;
    const { disposition, manuallyExcluded } = recapItemPresentation(item);
    if (!manuallyExcluded && disposition !== "kept") return;
    setManuallyExcludedIds((current) => {
      const next = new Set(current);
      if (manuallyExcluded) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
    if (editingItemId === item.id) setEditingItemId(null);
  }
  function finalize() {
    if (!onFinalize || !canFinalize) return;
    void runMutation("finalize", () => includeLongTerm && memoryAdmission
      ? onFinalize(participantAssignments, finalizeItems, voiceEnrollmentIntents, memoryAdmission)
      : onFinalize(participantAssignments, finalizeItems, voiceEnrollmentIntents));
  }

  const participantReviewPanel = (
    <details
      className={`${styles.contentPanel} ${styles.participantPanel}`}
      data-panel-state={confirmed ? "confirmed" : editable ? "current" : "readonly"}
      data-review-complete={participantReviewComplete ? "true" : "false"}
      open
    >
      <summary
        className={styles.participantSummary}
        tabIndex={-1}
        onClick={(event) => event.preventDefault()}
      >
        <div>
          <h2>核对说话人</h2>
          <p>{confirmed ? "这次录音的身份已保存，原话仍可随时核对。"
            : Object.keys(splitGroups).length ? "按原段核对声音。混声或未确认的原段可在本次复盘查看。"
            : participantReviewComplete ? "身份已核对，读完可返回书页继续。"
            : "结合下面的原话，为每个声音确认身份。不确定时可以先留待核对。"}</p>
        </div>
      </summary>
      <div className={styles.participantPanelBody}>
        {unassignedTranscriptCount > 0 ? (
          <p className={styles.boundaryNote} role="note">
            有 {unassignedTranscriptCount} 段文字没有稳定的说话人标记；它们仍可查看，但不会被合并成虚构人物或进入长期记录。
          </p>
        ) : null}
        {speakers.length > 0 ? (
          <div className={styles.participantList}>
            {speakers.map((speaker, index) => {
              const speakerName = speaker.label?.trim() || `说话人 ${index + 1}`;
              const review = participants.find((participant) => participant.speakerId === speaker.id);
              const memberSpeakerIds = participantMemberSpeakerIds(review, speaker.id);
              const reviewed = splitGroups[speaker.id];
              const sources = [...segmentSources.values()].filter(s => s.speakerId && memberSpeakerIds.includes(s.speakerId))
                .sort((a,b) => a.startSeconds - b.startSeconds);
              const groupLines = (interaction?.transcript ?? []).filter(line => line.speakerId && memberSpeakerIds.includes(line.speakerId));
              const audioSpeakerId = review?.audioSpeakerId;
              const audioAvailable = Boolean(interaction?.relationshipInteractionId && audioSpeakerId && !audioErrors[speaker.id]);
              return (
                <article className={styles.participantCard} data-recap-speaker={speaker.id} key={speaker.id}>
                  <span className={styles.speakerMark} aria-hidden="true">{index + 1}</span>
                  <div className={styles.participantCopy}>
                    <b>{speakerName}</b>
                    <small>{speaker.label ? "本次录音中的声音" : "请试听后确认"}</small>
                    {review?.roleSuggestion ? <small className={styles.participantSuggestion}>已按上次确认预选，请再核对一次</small> : null}
                    {audioAvailable ? (
                      <label className={styles.participantAudio}>
                        <span>播放声音节选</span>
                        <audio
                          aria-label={`${speakerName}的声音节选`}
                          controls
                          onError={() => setAudioErrors((current) => ({ ...current, [speaker.id]: true }))}
                          preload="metadata"
                          src={`/api/date-companion/interactions/${encodeURIComponent(interaction!.relationshipInteractionId!)}/participants/${encodeURIComponent(audioSpeakerId!)}/audio`}
                        />
                      </label>
                    ) : <small>声音节选暂不可用，请结合原话判断。</small>}
                    {!reviewed && <ul className={styles.participantSamples} data-speaker-samples="">
                      {speaker.samples.map((sample) => <li key={sample}>“{sample}”</li>)}
                    </ul>}
                    {!reviewed && sources.length > 0 && groupLines.length > 1 && <details>
                      <summary>查看本组全部 {groupLines.length} 段转写</summary>
                      <ol>{groupLines.map(line => <li key={line.id}><time>{formatTimestamp(line.startSeconds)}</time>　{line.text}</li>)}</ol>
                    </details>}
                    {reviewed ? (
                      <div className={styles.segmentReview}>
                        <b>逐段核对</b>
                        <p>只确认整段都由一人说出的原话。混有双方或听不清的段落留作未确认，可继续查看本次文字。</p>
                        {editable && !confirmed && !review?.reviewedSegments && <button type="button" className={styles.roleChoice}
                          disabled={saving} onClick={() => setSegmentEdits(current => {
                            if (!current || current.scope !== roleScope) return current;
                            const remaining = { ...current.groups };
                            delete remaining[speaker.id];
                            return {scope: roleScope, groups: remaining};
                          })}>返回整组核对</button>}
                        {sources.map(source => {
                          const segmentId = source.segmentIds[0];
                          const choice = reviewed.find(s => s.sourceSegmentId === segmentId && s.contentDigest === source.contentDigest);
                          return <label key={segmentId} data-segment-review={segmentId}>
                            <span>{formatTimestamp(source.startSeconds)} – {formatTimestamp(source.endSeconds)}</span>
                            <q>{source.quote}</q>
                            <select aria-label={`${formatTimestamp(source.startSeconds)} 起的原段说话人`}
                              value={choice?.role ?? "unresolved"} disabled={!editable || confirmed || saving}
                              onChange={event => {
                                const role = event.currentTarget.value;
                                const others = reviewed.filter(s => s.sourceSegmentId !== segmentId);
                                changeSegmentReview(speaker.id, role === "self" || role === "companion"
                                  ? [...others,{ sourceSegmentId: segmentId, contentDigest: source.contentDigest!, role }] : others);
                              }}>
                              <option value="unresolved">混声或暂不确定</option><option value="self">我</option><option value="companion">Ta</option>
                            </select>
                          </label>;
                        })}
                      </div>
                    ) : editable ? (
                      <div className={styles.participantRoleGroup} aria-label={`${speakerName}的身份`}>
                        {sources.length > 0 && !confirmed && <small>整组选择适用于这些原段都是同一人的情况。</small>}
                        {ROLE_OPTIONS.map((option) => (
                          <button
                            aria-pressed={(roles[speaker.id] ?? "unresolved") === option.role}
                            className={`${styles.roleChoice} ${(roles[speaker.id] ?? "unresolved") === option.role ? styles.roleChoiceActive : ""}`}
                            disabled={confirmed || saving}
                            key={option.role}
                            onClick={() => {
                              setRoleEdits(current => ({ scope: roleScope, values: {
                                ...(current?.scope === roleScope ? current.values : {}), [speaker.id]: option.role
                              } }));
                              if (option.role !== "companion" && rememberVoiceGroupId === speaker.id) setRememberVoiceGroupId(null);
                            }}
                            type="button"
                          >{sources.length && speakers.length > 1 && option.role !== "unresolved"
                            ? `整组都是${option.label}` : option.label}</button>
                        ))}
                        {sources.length > 0 && !confirmed && <button type="button" disabled={saving}
                          className={styles.roleChoice} onClick={() => changeSegmentReview(speaker.id, [])}>混有不同声音，逐段核对</button>}
                      </div>
                    ) : (
                      <span className={styles.readOnlyBadge}>{(roles[speaker.id] ?? "unresolved") === "self" ? "已确认：我" : (roles[speaker.id] ?? "unresolved") === "companion" ? "已确认：Ta" : "尚未核对"}</span>
                    )}
                    {editable && !confirmed && roles[speaker.id] === "companion" && enrollmentEligibleGroups.some((candidate) => candidate.speaker.id === speaker.id) ? (
                      <label className={styles.voiceEnrollmentChoice} data-voice-consent="">
                        <input
                          checked={rememberVoiceGroupId === speaker.id}
                          disabled={saving}
                          name="date-companion-voice-enrollment"
                          onChange={event => setRememberVoiceGroupId(event.currentTarget.checked ? speaker.id : null)}
                          type="checkbox"
                        />
                        <span><b>记住这段声音，方便下次认出 Ta</b><small>整次最多选择一段；默认关闭。</small></span>
                      </label>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        ) : <div className={styles.emptyState}><div><b>没有可核对的说话人</b><span>{unassignedTranscriptCount > 0 ? "文字稿没有稳定的说话人标记。" : "文字稿中没有识别到可用内容。"}</span></div></div>}
        {onSaveSegmentReview && !confirmed && segmentEdits?.scope === roleScope && Object.keys(segmentEdits.groups).length > 0 && (
          <button type="button" className={styles.secondaryButton} disabled={saving}
            onClick={() => void runMutation("participants", () => onSaveSegmentReview(participantAssignments.filter(a =>
              confirmedSpeakers.has(a.speakerId))))}>保存分段核对，继续留作草稿</button>
        )}
        {localErrorOperation === "participants" && localError && <p role="alert">{localError}</p>}
      </div>
    </details>
  );

  const memoryControls = (
    <>
    {!confirmed && editable && longTermReady ? (
      <label className={styles.longTermChoice} data-memory-consent="">
        <input checked={includeLongTerm} disabled={saving} onChange={(event) => setLongTermDraftId(event.currentTarget.checked ? interaction?.id ?? null : null)} type="checkbox" />
        <span><b>这次也整理进长期记忆</b><small>勾选后，先为本次保留且已核对说话人的内容生成归属建议。</small></span>
      </label>
    ) : null}
    {!confirmed && includeLongTerm && longTermReady && !previewItemIds.length ? (
      <p role="status">保留一条已核对说话人的内容，即可查看归属建议。</p>
    ) : null}
    {memoryBridgeState.status === "error" ? <p>人物设置暂时没有读取成功；本次复盘仍可完成。</p> : null}
    {longTermReady && memoryStillProcessing ? (
      <div className={styles.longTermStatus}>
        <p>{saving ? "正在整理；本次复盘仍可单独完成。" : "长期整理仍在后台继续。"}</p>
        {!saving && onMemoryRefresh ? <button className={styles.secondaryButton} onClick={() => void runMutation("refresh", onMemoryRefresh)} type="button">{localOperation === "refresh" ? "正在查看…" : "查看整理结果"}</button> : null}
      </div>
    ) : null}
    {confirmed && subjectEditable && onMemorySync && subjectInteractionId && subjectMappingVersion !== undefined ? (
      <button type="button" className={styles.secondaryButton} disabled={saving}
        aria-disabled={currentSubjectState?.status === "loading" || Boolean(subjectSuggestionBatch)}
        onClick={() => {
          if (!subjectSuggestionBatch && currentSubjectState?.status !== "loading") requestSubjectPreview();
        }}>
        {subjectSuggestionBatch ? "已生成归属建议" : currentSubjectState?.status === "loading" ? "正在生成归属建议…" :
          currentSubjectState?.status === "error" ? "重新生成归属建议" : "生成归属建议"}
      </button>
    ) : null}
    {currentSubjectState?.status === "loading" ? <p role="status">{confirmed ? "正在核对本次保留的内容。" : "正在整理内容归属；你仍可先完成本次复盘。"}</p> : null}
    {currentSubjectState?.status === "error" ? <p className={styles.inlineError} role="alert">{currentSubjectState.message}</p> : null}
    {subjectEditable && subjectSuggestionBatch ? (
      <div className={styles.subjectReview} role="note">
        {subjectSuggestionBatch.status === "degraded" ? <p>无法确认归属的内容会保持“暂不确定”，不会自动关联人物。</p> : null}
        <small>{confirmed
          ? "翻看不会授权长期保存；点击下方整理按钮后，才会接受这些归属并开始长期整理。"
          : includeLongTerm
            ? "完成复盘时会接受这些归属；真正长期保留哪些内容，仍受现有安全规则约束。"
            : "目前只是在查看内容归属。勾选长期记忆并完成复盘后，才会接受这些归属并开始长期整理。"}</small>
      </div>
    ) : null}
    {relationshipReconfirmationRequired ? <p className={styles.boundaryNote} role="note">这段长期关系记录之前已被清理；重新启用后会按你确认的归属继续整理。</p> : memoryStatus === "needs_review" ? <p className={styles.boundaryNote} role="note">{memoryReview?.kind === "evidence_review_required" ? "这次原话来源已经变化，暂时不能继续长期整理。" : "人物设置已经变化，需要重新确认后才能继续长期整理。"}</p> : null}
    {memorySyncError ? <p className={styles.inlineError} role="alert">{memorySyncError}</p> : null}
    {confirmed && longTermReady && onMemorySync && (subjectSuggestionBatch || memoryStatus === "retryable_failed") ? (
      <button
        className={styles.secondaryButton}
        disabled={saving || (memoryStatus !== "retryable_failed" && !automaticSubjectsComplete)}
        onClick={() => void runMutation("sync", async () => {
          if (memoryStatus === "retryable_failed") return onMemorySync();
          if (!subjectSuggestionConfirmation || !automaticSubjectsComplete) throw new Error("内容归属还没有整理完成，请稍后再试。");
          if (relationshipReconfirmationRequired && !relationshipReconfirmation) throw new Error("长期关系恢复信息还没有准备好，请稍后再试。");
          return relationshipReconfirmation
            ? onMemorySync(memoryAdmissionSelections, subjectSuggestionConfirmation, relationshipReconfirmation)
            : onMemorySync(memoryAdmissionSelections, subjectSuggestionConfirmation);
        })}
        type="button"
      >{localOperation === "sync" || (memoryMutationState.status === "saving" && memoryMutationState.operation === "sync") ? "正在整理…" : memoryStatus === "retryable_failed" ? "重新整理" : relationshipReconfirmationRequired ? "重新启用并继续整理" : "开始长期整理"}</button>
    ) : null}
    </>
  );

  const meetingTitle = bookMeetingTitle(interaction);
  const entries: BookItem[] = validItems.map(item => {
    const presentation = recapItemPresentation(item);
    const pendingIdentity = item.sources.some(source => {
      const role = knownRole(source.speakerId, source.segmentIds[0]);
      return !role || role === "unresolved";
    });
    const text = editedTexts[item.id] ?? (item.displayedText || item.proposedText);
    return {
      ...presentation,
      exclusionReason: bookRetentionReason(item,presentation.disposition,presentation.manuallyExcluded,knownRole),
      ...bookItemCopy(item,text,pendingIdentity),
      pendingIdentity,
      subjects: memoryStatus === "completed" && presentation.disposition === "kept" ? SUBJECT_OPTIONS
        .filter(option => item.sources.some(source => source.memorySubject === option.subject))
        .map(option => option.label.replace(/^关于\s*/,"")) : [],
    };
  });
  const sources = validItems.flatMap(item => item.sources);
  let bookMemoryStatus: string = MEMORY_STATUS_COPY[memoryStatus];
  if (!memoryReady) {
    bookMemoryStatus = memoryBridgeState.status === "error" ? "人物设置暂时未能读取" : "正在读取人物设置…";
  } else if (!longTermReady) {
    bookMemoryStatus = readyMemoryBridge?.setting.enabled ? "人物归属尚待核对" : "长期整理未开启";
  } else if (!confirmed && includeLongTerm && memoryStatus === "not_queued") {
    bookMemoryStatus = memoryAdmission ? "已选择随本次复盘整理" : "已选择长期整理，尚待核对归属";
  }
  const memory = validItems.length > 0 && <BookMemory meetingTitle={meetingTitle} items={retainedItems}
    suggestedSubjects={suggestedSubjectByEvidenceId} status={memoryStatus}
    onDismiss={() => {
      if (confirmed && subjectRequest.current) {
        cancelSubjectRequest();
        setSubjectSuggestionState({ status: "idle" });
      }
    }}
    statusLabel={bookMemoryStatus}
    itemTitle={item=>entries.find(entry=>entry.item.id===item.id)?.title || item.displayedText}
    controls={<>
      {memoryBridgeState.status === "error" && onMemoryRefresh && <button type="button" disabled={saving}
        onClick={() => void runMutation("refresh", onMemoryRefresh)}>重新读取人物设置</button>}
      {memoryReady && !longTermReady && <Link href="/date-companion/a/people">查看人物设置</Link>}
      {memoryControls}
    </>}/>;
  return (
    <BookPanelsProvider interaction={interaction} meetingTitle={meetingTitle} chapters={chapters} initialSegmentId={initialSegmentId} onReturnToSourceOrigin={onReturnToSourceOrigin} sources={sources} speakerLabel={speakerLabel}>
      <BookRecap interaction={interaction} entries={entries} groups={GROUPS}
        confirmed={confirmed} editable={editable} saving={saving} participantReviewComplete={participantReviewComplete}
        participantPanel={speakers.length || unassignedTranscriptCount ? participantReviewPanel : null}
        hasTranscript={Boolean(interaction?.transcript.length || sources.length)} homeHref={bookHomeHref}
        question={questionControl} observation={proactiveObservation} memory={memory}
        canFinalize={canFinalize} submitting={localOperation==="finalize" || mutationState.status==="saving" && mutationState.operation==="finalize"}
        error={pageError} memoryNote={includeLongTerm ? (memoryAdmission ? "这次也会整理进长期记忆。" : "长期整理还未就绪，本次复盘仍可完成。") : "仅保存在本次复盘。"}
        speakerLabel={speakerLabel} editingId={editingItemId} editingText={editingText} onEdit={editItem} onText={setEditingText}
        onApply={applyEdit} onCancel={()=>setEditingItemId(null)} onChangeRetention={changeRetention} onFinalize={finalize}/>
    </BookPanelsProvider>
  );
}
