"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useMemo, useState } from "react";

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
  DcSubjectSuggestionBatch,
  DcSubjectSuggestionConfirmation
} from "@/lib/domain/date-companion-stage2";
import {
  loadDateCompanionSubjectSuggestions
} from "@/lib/client/date-companion-subject-suggestions";
import { ProductEvidence, ProductReviewCompletion, ProductState } from "@/components/product-system/product-primitives";

import { CompanionTranscript, type TranscriptChapterPresentation } from "./companion-transcript";
import styles from "./date-companion.module.css";

export type CompanionParticipantMutation = {
  speakerId: string;
  role: DateCompanionParticipantRole;
};

export type CompanionRecapItemMutation = {
  id: string;
  version: number;
  userText?: string | null;
  disposition: RecapItemVM["disposition"];
};

type CompanionRecapProps = {
  chapters?: TranscriptChapterPresentation[];
  initialSegmentId?: string | null;
  interaction: InteractionVM | null;
  items: RecapItemVM[];
  mutationState?: DateCompanionMutationState;
  participants?: ParticipantReviewVM[];
  memoryBridgeState?: DateCompanionMemoryBridgeState;
  memoryMutationState?: DateCompanionMemoryMutationState;
  proactiveObservation?: ReactNode;
  proactiveObservationStatus?: "ready" | "fallback";
  questionControl?: ReactNode;
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
  | { status: "idle" | "loading" }
  | { status: "ready"; batch: DcSubjectSuggestionBatch }
  | { status: "error"; message: string };

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

function formatDuration(seconds?: number) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
}

function formatTimestamp(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function sourcePresentationLabel(source: SourceRefVM) {
  if (source.presentation === "direct_quote") return "原话片段";
  if (source.presentation === "suggestion") return "根据原话整理的建议";
  return "根据原话整理";
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

function RecapSourceList({
  availableSegmentIds,
  onJump,
  sources
}: {
  availableSegmentIds: ReadonlySet<string>;
  onJump: (segmentId: string) => void;
  sources: SourceRefVM[];
}) {
  return (
    <details className={styles.sourceDetails}>
      <summary><span>{sources.length} 条来源</span><span>查看原话</span></summary>
      <ul className={styles.sourceList}>
        {sources.map((source) => {
          const firstSegmentId = source.segmentIds.find((segmentId) => availableSegmentIds.has(segmentId));
          return (
            <li className={styles.sourceItem} key={source.id}>
              <ProductEvidence
                label={sourcePresentationLabel(source)}
                meta={formatTimestamp(source.startSeconds)}
              >
                {source.presentation === "direct_quote" ? `“${source.quote}”` : source.quote}
              </ProductEvidence>
              <div className={styles.sourceMeta}>
                {firstSegmentId ? (
                  <button className={styles.sourceJump} onClick={() => onJump(firstSegmentId)} type="button">在文字稿中查看</button>
                ) : <span className={styles.evidenceOnlyLabel}>已保留可核对原话</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </details>
  );
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
  roles: Readonly<Record<string, DateCompanionParticipantRole>>
): RecapItemVM["disposition"] {
  const safe = item.sources.length > 0 && item.sources.every((source) => {
    if (!source.speakerId) return false;
    const role = roles[source.speakerId] ?? "unresolved";
    if (role === "unresolved") return false;
    if (item.kind === "mentioned") return role === "companion";
    if (item.kind === "promise") return role === "self";
    return true;
  });
  return safe ? "kept" : "excluded";
}

function automaticExclusionReason(
  item: RecapItemVM,
  roles: Readonly<Record<string, DateCompanionParticipantRole>>
) {
  if (item.sources.length === 0 || item.sources.some((source) => !source.speakerId)) {
    return "缺少可核对的说话人来源";
  }
  const sourceRoles = item.sources.map((source) => roles[source.speakerId!] ?? "unresolved");
  if (sourceRoles.some((role) => role === "unresolved")) return "说话人暂不确定";
  if (item.kind === "mentioned" && sourceRoles.some((role) => role !== "companion")) {
    return "这条需要确认是由 Ta 说出的";
  }
  if (item.kind === "promise" && sourceRoles.some((role) => role !== "self")) {
    return "这条需要确认是由你说出的";
  }
  return null;
}

export function CompanionRecap({
  chapters,
  initialSegmentId,
  interaction,
  items,
  mutationState = { status: "idle" },
  participants = [],
  memoryBridgeState = { status: "idle" },
  memoryMutationState = { status: "idle" },
  proactiveObservation,
  proactiveObservationStatus = "ready",
  questionControl,
  onFinalize,
  onMemorySync,
  onMemoryRefresh
}: CompanionRecapProps) {
  const [highlightedSegmentId, setHighlightedSegmentId] = useState<string | null>(initialSegmentId ?? null);
  const [roles, setRoles] = useState<Record<string, DateCompanionParticipantRole>>({});
  const [audioErrors, setAudioErrors] = useState<Record<string, boolean>>({});
  const [expandedGroups, setExpandedGroups] = useState<Set<RecapItemVM["kind"]>>(() => new Set());
  const [manuallyExcludedIds, setManuallyExcludedIds] = useState<Set<string>>(() => new Set());
  const [editedTexts, setEditedTexts] = useState<Record<string, string>>({});
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [rememberVoiceGroupId, setRememberVoiceGroupId] = useState<string | null>(null);
  const [participantReviewOpen, setParticipantReviewOpen] = useState(false);
  const [reviewedSpeakerIds, setReviewedSpeakerIds] = useState<Set<string>>(() => new Set());
  const [includeLongTerm, setIncludeLongTerm] = useState(false);
  const [localOperation, setLocalOperation] = useState<"finalize" | "sync" | "refresh" | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localErrorOperation, setLocalErrorOperation] = useState<"finalize" | "sync" | "refresh" | null>(null);
  const [subjectSuggestionState, setSubjectSuggestionState] = useState<SubjectSuggestionState>({ status: "idle" });

  const validItems = useMemo(() => items.filter((item) => item.sources.length > 0), [items]);
  const speakers = useMemo(
    () => speakerGroups(interaction?.transcript ?? [], participants),
    [interaction?.transcript, participants]
  );
  const unassignedTranscriptCount = useMemo(
    () => interaction?.transcript.filter((line) => !line.speakerId).length ?? 0,
    [interaction?.transcript]
  );
  const duration = formatDuration(interaction?.durationSeconds);
  const availableSegmentIds = useMemo(
    () => new Set(interaction?.transcript.map((line) => line.id) ?? []),
    [interaction?.transcript]
  );
  const participantSyncKey = participants.map((participant) =>
    `${participant.speakerId}:${participant.memberSpeakerIds?.join(",") ?? ""}:${participant.audioSpeakerId ?? ""}:${participant.role}:${participant.version ?? 0}`
  ).join("|");
  const speakerSyncKey = speakers.map((speaker) => speaker.id).join("|");

  useEffect(() => {
    const nextRoles = initialRoles(speakers, participants);
    const nextReviewedSpeakerIds = new Set(
      speakers.flatMap((speaker) => participants.some(
        (participant) => participant.speakerId === speaker.id && participant.state === "confirmed"
      ) ? [speaker.id] : [])
    );
    setRoles(nextRoles);
    setReviewedSpeakerIds(nextReviewedSpeakerIds);
    setParticipantReviewOpen(
      Boolean(onFinalize)
      && interaction?.persistenceStatus !== "confirmed"
      && speakers.length > 0
    );
  }, [interaction?.id, participantSyncKey, speakerSyncKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setAudioErrors({});
    setExpandedGroups(new Set());
    setManuallyExcludedIds(new Set());
    setEditedTexts({});
    setEditingItemId(null);
    setEditingText("");
    setRememberVoiceGroupId(null);
    setIncludeLongTerm(false);
    setSubjectSuggestionState({ status: "idle" });
    setLocalError(null);
    setLocalErrorOperation(null);
  }, [interaction?.id]);

  const editable = Boolean(onFinalize);
  const confirmed = interaction?.persistenceStatus === "confirmed";
  const participantReviewComplete = speakers.every((speaker) => reviewedSpeakerIds.has(speaker.id));
  const participantReviewCollapsible = confirmed || !editable || participantReviewComplete;
  const rolesBySourceSpeaker = useMemo(
    () => sourceSpeakerRoles(participants, roles),
    [participants, roles]
  );
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
        : automaticDisposition(item, rolesBySourceSpeaker)
    } satisfies CompanionRecapItemMutation;
  }), [confirmed, editedTexts, manuallyExcludedIds, rolesBySourceSpeaker, validItems]);
  const keptCount = finalizeItems.filter((item) => item.disposition === "kept").length;
  const excludedCount = finalizeItems.length - keptCount;
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
  const subjectEditable = Boolean(
    longTermReady
    && (
      (interaction?.persistenceStatus !== "confirmed" && includeLongTerm)
      || memoryStatus === "not_queued"
      || relationshipReconfirmationRequired
    )
  );
  const subjectInteractionId = interaction?.relationshipInteractionId;
  const subjectInteractionVersion = interaction?.version ?? 0;
  const subjectMappingVersion = mapping?.version;
  useEffect(() => {
    if (!subjectEditable || !subjectInteractionId || subjectMappingVersion === undefined) {
      setSubjectSuggestionState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setSubjectSuggestionState({ status: "loading" });
    void loadDateCompanionSubjectSuggestions({
      interactionId: subjectInteractionId,
      interactionVersion: subjectInteractionVersion,
      mappingVersion: subjectMappingVersion,
      signal: controller.signal
    }).then((batch) => {
      if (controller.signal.aborted) return;
      if (
        batch.interactionId !== subjectInteractionId
        || batch.mappingVersion !== subjectMappingVersion
        || batch.interactionVersion !== subjectInteractionVersion
      ) {
        setSubjectSuggestionState({ status: "error", message: "这次内容已经变化，请稍后重新查看整理结果。" });
        return;
      }
      setSubjectSuggestionState({ status: "ready", batch });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setSubjectSuggestionState({
        status: "error",
        message: error instanceof Error && error.message === "subject_suggestion_provider_unavailable"
          ? "这次人物范围暂时没有整理好；你仍可完成本次复盘。"
          : "这次内容范围暂时没有整理好；你仍可完成本次复盘。"
      });
    });
    return () => controller.abort();
  }, [subjectEditable, subjectInteractionId, subjectInteractionVersion, subjectMappingVersion]);
  const subjectSuggestionBatch = subjectSuggestionState.status === "ready"
    ? subjectSuggestionState.batch
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
  const visibleSubjectSuggestions = useMemo(() => {
    if (!subjectSuggestionBatch) return [];
    const retainedItemIds = new Set(retainedItems.map((item) => item.id));
    const retainedSources = new Map(
      retainedItems.flatMap((item) => item.sources).map((source) => [source.id, source])
    );
    return subjectSuggestionBatch.suggestions.flatMap((suggestion) => {
      const evidenceSnapshotIds = suggestion.evidenceSnapshotIds.filter((id) => retainedSources.has(id));
      if (evidenceSnapshotIds.length === 0) return [];
      const group = GROUPS.find((candidate) => suggestion.recapItemIds.some((id) =>
        retainedItemIds.has(id)
        && retainedItems.some((item) => item.id === id && item.kind === candidate.kind)
      ));
      const source = retainedSources.get(evidenceSnapshotIds[0]);
      return [{
        ...suggestion,
        evidenceSnapshotIds,
        subject: suggestion.proposedSubject,
        kind: group?.kind ?? "moment",
        quote: source?.quote ?? "原话来源"
      }];
    });
  }, [retainedItems, subjectSuggestionBatch]);
  const subjectCounts = useMemo(() => {
    const counts: Record<DateCompanionMemorySubject, number> = {
      self: 0,
      companion: 0,
      both: 0,
      unknown: 0
    };
    for (const suggestion of visibleSubjectSuggestions) {
      counts[suggestion.subject ?? "unknown"] += 1;
    }
    return counts;
  }, [visibleSubjectSuggestions]);
  const subjectThemes = useMemo(() => GROUPS.flatMap((group) => {
    const themeItems = retainedItems.filter((item) => item.kind === group.kind);
    const suggestions = visibleSubjectSuggestions.filter((suggestion) => suggestion.kind === group.kind);
    if (suggestions.length === 0) return [];
    const counts: Record<DateCompanionMemorySubject, number> = {
      self: 0,
      companion: 0,
      both: 0,
      unknown: 0
    };
    for (const suggestion of suggestions) counts[suggestion.subject] += 1;
    return [{
      ...group,
      items: themeItems,
      suggestions,
      counts
    }];
  }), [retainedItems, visibleSubjectSuggestions]);

  const jumpToSource = (segmentId: string) => {
    setHighlightedSegmentId(segmentId);
    const targetUrl = new URL(window.location.href);
    targetUrl.searchParams.set("segment", segmentId);
    targetUrl.hash = "full-transcript";
    window.history.replaceState(
      window.history.state,
      "",
      `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`
    );
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    requestAnimationFrame(() => document.getElementById("full-transcript")?.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start"
    }));
  };

  const runMutation = async (
    operation: "finalize" | "sync" | "refresh",
    action: () => Promise<void> | void
  ) => {
    if (saving) return;
    setLocalOperation(operation);
    setLocalError(null);
    setLocalErrorOperation(null);
    try {
      await action();
    } catch (error) {
      setLocalError(error instanceof Error && error.message.trim() ? error.message : "暂时没有保存成功，请稍后再试。");
      setLocalErrorOperation(operation);
    } finally {
      setLocalOperation(null);
    }
  };

  const participantAssignments = speakers.flatMap((speaker) => {
    const participant = participants.find((candidate) => candidate.speakerId === speaker.id);
    return participantMemberSpeakerIds(participant, speaker.id).map((speakerId) => ({
      speakerId,
      role: roles[speaker.id] ?? "unresolved"
    }));
  });

  const recapItemPresentation = (item: RecapItemVM) => {
    const manuallyExcluded = manuallyExcludedIds.has(item.id);
    const disposition = confirmed
      ? item.disposition
      : manuallyExcluded
        ? "excluded"
        : automaticDisposition(item, rolesBySourceSpeaker);
    const automaticReason = automaticExclusionReason(item, rolesBySourceSpeaker);
    const exclusionReason = disposition === "excluded"
      ? manuallyExcluded
        ? "你选择不留下这条"
        : automaticReason ?? "这条在确认时没有留下"
      : null;
    return { item, disposition, exclusionReason, manuallyExcluded };
  };

  const renderRecapItem = (presentation: ReturnType<typeof recapItemPresentation>) => {
    const { item, disposition, exclusionReason, manuallyExcluded } = presentation;
    const editing = editingItemId === item.id;
    const displayedText = editedTexts[item.id] ?? (item.displayedText || item.proposedText);
    const displayedSubjectOptions = SUBJECT_OPTIONS.filter((option) =>
      item.sources.some((source) => source.memorySubject === option.subject)
    );
    return (
      <div className={styles.recapItemEditor} data-disposition={disposition} key={item.id}>
        <div className={styles.recapItemHeading}>
          <h4>{item.title}</h4>
          <span>{disposition === "kept" ? (confirmed ? "已保留" : "将保留") : "未保留"}</span>
        </div>
        {editing ? (
          <div className={styles.recapOptionalEditor}>
            <label htmlFor={`recap-edit-${item.id}`}>修改整理后的文字</label>
            <textarea
              id={`recap-edit-${item.id}`}
              aria-label={`修改这条：${item.title}`}
              disabled={saving}
              onChange={(event) => setEditingText(event.currentTarget.value)}
              value={editingText}
            />
            <span>
              <button disabled={saving} onClick={() => setEditingItemId(null)} type="button">取消</button>
              <button
                disabled={saving || !editingText.trim()}
                onClick={() => {
                  setEditedTexts((current) => ({ ...current, [item.id]: editingText.trim() }));
                  setEditingItemId(null);
                }}
                type="button"
              >应用修改</button>
            </span>
          </div>
        ) : <p className={styles.recapText}>{displayedText}</p>}
        {exclusionReason ? <p className={styles.recapExclusionReason}>{exclusionReason}</p> : null}
        {editable && !confirmed && !editing ? (
          <div className={styles.recapOptionalActions}>
            {disposition === "kept" ? (
              <button
                disabled={saving}
                onClick={() => {
                  setEditingItemId(item.id);
                  setEditingText(displayedText);
                }}
                type="button"
              >修改</button>
            ) : null}
            {disposition === "kept" ? (
              <button
                disabled={saving}
                onClick={() => {
                  setManuallyExcludedIds((current) => new Set(current).add(item.id));
                  setEditingItemId((current) => current === item.id ? null : current);
                }}
                type="button"
              >这条不留下</button>
            ) : manuallyExcluded ? (
              <button
                disabled={saving}
                onClick={() => setManuallyExcludedIds((current) => {
                  const next = new Set(current);
                  next.delete(item.id);
                  return next;
                })}
                type="button"
              >恢复这条</button>
            ) : <small>核对上面的说话人后，这条会自动恢复。</small>}
          </div>
        ) : null}
        {disposition === "kept" && memoryStatus === "completed" && displayedSubjectOptions.length > 0 ? (
          <div aria-label="这条内容的长期归属" className={styles.subjectReadOnly}>
            {displayedSubjectOptions.map((option) => (
              <span key={option.subject}>{option.label}</span>
            ))}
          </div>
        ) : null}
        <RecapSourceList availableSegmentIds={availableSegmentIds} sources={item.sources} onJump={jumpToSource} />
      </div>
    );
  };

  const renderRecapGroup = (group: (typeof GROUPS)[number]) => {
    const groupItems = validItems.filter((item) => item.kind === group.kind);
    const presentations = groupItems.map(recapItemPresentation);
    const includedItems = presentations.filter((item) => item.disposition !== "excluded");
    const excludedItems = presentations.filter((item) => item.disposition === "excluded");
    const expanded = expandedGroups.has(group.kind);
    const visibleItems = expanded ? includedItems : includedItems.slice(0, 5);
    const hiddenCount = includedItems.length - visibleItems.length;
    return (
      <section className={styles.recapReviewGroup} data-card-kind={group.kind} key={group.kind}>
        <header>
          <span>{group.eyebrow}</span>
          <h3>{group.title}</h3>
        </header>
        <div id={`recap-group-${group.kind}-items`}>
          {includedItems.length === 0
            ? <p className={styles.recapGroupEmpty}>{group.empty}</p>
            : visibleItems.map(renderRecapItem)}
        </div>
        {includedItems.length > 5 ? (
          <button
            aria-controls={`recap-group-${group.kind}-items`}
            aria-expanded={expanded}
            className={styles.recapGroupToggle}
            onClick={() => setExpandedGroups((current) => {
              const next = new Set(current);
              if (next.has(group.kind)) next.delete(group.kind);
              else next.add(group.kind);
              return next;
            })}
            type="button"
          >
            {expanded ? "收起，仅显示前 5 条" : `展开其余 ${hiddenCount} 条`}
          </button>
        ) : null}
        {excludedItems.length > 0 ? (
          <details className={styles.recapExcludedGroup}>
            <summary>未保留 {excludedItems.length} 条</summary>
            <div>{excludedItems.map(renderRecapItem)}</div>
          </details>
        ) : null}
      </section>
    );
  };

  const participantReviewPanel = (
    <details
      className={`${styles.contentPanel} ${styles.participantPanel}`}
      data-panel-state={confirmed ? "confirmed" : editable ? "current" : "readonly"}
      data-review-complete={participantReviewComplete ? "true" : "false"}
      onToggle={(event) => {
        if (!event.currentTarget.open && !participantReviewCollapsible) {
          event.currentTarget.open = true;
          setParticipantReviewOpen(true);
          return;
        }
        setParticipantReviewOpen(event.currentTarget.open);
      }}
      open={participantReviewOpen}
    >
      <summary
        className={styles.participantSummary}
        onClick={(event) => {
          if (participantReviewOpen && !participantReviewCollapsible) event.preventDefault();
        }}
      >
        <div>
          <h2>核对说话人</h2>
          <p>{confirmed
            ? "本次说话人归属已保存；需要时可以重新展开核对。"
            : participantReviewComplete
              ? "说话人已核对；你可以收起这一段，继续阅读复盘。"
              : "请为每个声音明确选择“我”“Ta”或“暂不确定”；全部核对后可以收起。"}</p>
        </div>
        <span aria-hidden="true" className={styles.participantSummaryAction}>
          {!participantReviewCollapsible ? "请先核对" : participantReviewOpen ? "收起" : "展开"}
        </span>
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
              const audioSpeakerId = review?.audioSpeakerId ?? (memberSpeakerIds.length === 1 ? memberSpeakerIds[0] : undefined);
              const audioAvailable = Boolean(interaction?.relationshipInteractionId && audioSpeakerId && !audioErrors[speaker.id]);
              return (
                <article className={styles.participantCard} key={speaker.id}>
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
                    <ul className={styles.participantSamples}>
                      {speaker.samples.map((sample) => <li key={sample}>“{sample}”</li>)}
                    </ul>
                    {editable ? (
                      <div className={styles.participantRoleGroup} aria-label={`${speakerName}的身份`}>
                        {ROLE_OPTIONS.map((option) => (
                          <button
                            aria-pressed={(roles[speaker.id] ?? "unresolved") === option.role}
                            className={`${styles.roleChoice} ${(roles[speaker.id] ?? "unresolved") === option.role ? styles.roleChoiceActive : ""}`}
                            disabled={confirmed || saving}
                            key={option.role}
                            onClick={() => {
                              setRoles((current) => ({ ...current, [speaker.id]: option.role }));
                              setReviewedSpeakerIds((current) => new Set(current).add(speaker.id));
                              if (option.role !== "companion" && rememberVoiceGroupId === speaker.id) setRememberVoiceGroupId(null);
                            }}
                            type="button"
                          >{option.label}</button>
                        ))}
                      </div>
                    ) : (
                      <span className={styles.readOnlyBadge}>{(roles[speaker.id] ?? "unresolved") === "self" ? "已确认：我" : (roles[speaker.id] ?? "unresolved") === "companion" ? "已确认：Ta" : "尚未核对"}</span>
                    )}
                    {editable && !confirmed && roles[speaker.id] === "companion" && enrollmentEligibleGroups.some((candidate) => candidate.speaker.id === speaker.id) ? (
                      <label className={styles.voiceEnrollmentChoice}>
                        <input
                          checked={rememberVoiceGroupId === speaker.id}
                          disabled={saving}
                          name="date-companion-voice-enrollment"
                          onChange={() => setRememberVoiceGroupId(speaker.id)}
                          type="radio"
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
      </div>
    </details>
  );

  return (
    <main className={styles.recapReviewPage}>
      <header className={styles.recapReviewHeader}>
        <div>
          <p className={styles.eyebrow}>{interaction?.recordingDate ?? "这次相处"}</p>
          <h1>{!interaction
            ? "还没有相处记录"
            : interaction.status === "ready"
              ? confirmed ? "这次相处的复盘已完成" : "完成这次相处的复盘"
              : interaction.status === "failed" ? "这次整理没有完成" : "这次相处正在整理"}</h1>
          <p>{!interaction
            ? "上传一段录音后，这里会出现可核对的复盘。"
            : interaction.status === "ready"
              ? confirmed
                ? "你留下的内容和原话仍可随时核对。"
                : "先读这次相处里值得带走的内容，再处理真正需要你确认的部分。"
              : interaction.status === "failed"
                ? "录音和已有内容不会因此丢失。"
                : "录音正在转成文字并整理重点。"}</p>
        </div>
        {interaction ? (
          <div className={styles.recapHeaderMeta} aria-label="本次录音信息">
            <span>{interaction.fileName}</span>
            <span>{[duration, interaction.status === "ready" ? "已整理" : interaction.status === "failed" ? "处理失败" : "正在处理"].filter(Boolean).join(" · ")}</span>
          </div>
        ) : null}
        {questionControl ? <div className={styles.recapQaControl}>{questionControl}</div> : null}
      </header>

      <div aria-label="这次相处详情" className={styles.recapReviewBody} role="region">
        {!interaction ? (
          <ProductState
            action={<Link href="/date-companion/a">返回上传</Link>}
            description="整理完成后，这里会显示带真实来源的复盘和文字稿。"
            title="先上传一段录音"
            tone="empty"
          />
        ) : interaction.status !== "ready" ? (
          <ProductState
            action={<Link href="/date-companion/a">返回此刻</Link>}
            description={interaction.status === "failed"
              ? "请返回此刻查看失败原因并选择是否重试。"
              : `当前进度${typeof interaction.progress === "number" ? ` ${Math.round(interaction.progress)}%` : "正在更新"}；现在没有内容不代表最终结果为空。`}
            title={interaction.status === "failed" ? "整理暂未完成" : "还在整理"}
            tone={interaction.status === "failed" ? "error" : "loading"}
          />
        ) : (
          <>
            {pageError ? <p className={styles.inlineError} role="alert">{pageError}</p> : null}

            {participantReviewPanel}

            <section className={styles.recapOverview} aria-labelledby="recap-overview-title">
              <div>
                <h2 id="recap-overview-title">这次相处里，整理出 {validItems.length} 条有原话支撑的内容</h2>
                <p>复盘会保存你确认的说话人和内容；长期记忆不会自动改变。</p>
              </div>
              <span>{confirmed ? "已完成" : editable ? "等你看看" : "只读查看"}</span>
            </section>

            {proactiveObservation ? (
              <section
                className={styles.recapObservation}
                data-observation-origin={proactiveObservationStatus}
                aria-labelledby="current-proactive-observation-title"
              >
                <span aria-hidden="true" className={styles.recapObservationMark}>
                  {proactiveObservationStatus === "ready" ? "AI" : "原话"}
                </span>
                <div className={styles.recapObservationBody}>
                  <header className={styles.recapObservationHeader}>
                    <h2 id="current-proactive-observation-title">
                      {proactiveObservationStatus === "ready" ? "AI 观察" : "原话线索"}
                    </h2>
                    <p>{proactiveObservationStatus === "ready"
                      ? "基于这次可核对的原话，提供一个值得再看一眼的角度。"
                      : "从这次可核对的原话里，整理出一个值得留意的线索。"}</p>
                  </header>
                  {proactiveObservation}
                </div>
              </section>
            ) : null}

            <section className={styles.recapFindings} aria-labelledby="recap-findings-title">
              <header>
                <h2 id="recap-findings-title">值得带走</h2>
                <p>先阅读内容；需要时再编辑、移除或查看原话。</p>
              </header>
              <div className={styles.recapPrimaryGroups}>
                {GROUPS.slice(0, 2).map(renderRecapGroup)}
              </div>
              <details className={styles.recapMore}>
                <summary>
                  <span>更多可能有用的内容</span>
                  <span>{validItems.filter((item) => GROUPS.slice(2).some((group) => group.kind === item.kind)).length} 条</span>
                </summary>
                <div className={styles.recapSecondaryGroups}>
                  {GROUPS.slice(2).map(renderRecapGroup)}
                </div>
              </details>
            </section>

            <section className={styles.memoryAdmissionPanel} aria-labelledby="long-term-review-title">
              <header>
                <div>
                  <h2 id="long-term-review-title">长期记忆（可选）</h2>
                  <p>只在你明确选择时使用；不影响“完成本次复盘”。</p>
                </div>
                {!longTermReady
                  ? <Link className={styles.textButton} href="/date-companion/a/people">查看人物设置</Link>
                  : <span className={styles.memoryStatusBadge} data-status={memoryStatus}>{MEMORY_STATUS_COPY[memoryStatus]}</span>}
              </header>
              {!confirmed && longTermReady ? (
                <label className={styles.longTermChoice}>
                  <input checked={includeLongTerm} disabled={saving} onChange={(event) => setIncludeLongTerm(event.currentTarget.checked)} type="checkbox" />
                  <span><b>这次也整理进长期记忆</b><small>会先展示内容归属；你不选择时，不会写入长期记忆。</small></span>
                </label>
              ) : null}
              {memoryBridgeState.status === "error" ? <p>人物设置暂时没有读取成功；本次复盘仍可完成。</p> : null}
              {longTermReady && memoryStillProcessing ? (
                <div className={styles.longTermStatus}>
                  <p>{saving ? "正在整理；本次复盘仍可单独完成。" : "长期整理仍在后台继续。"}</p>
                  {!saving && onMemoryRefresh ? <button className={styles.secondaryButton} onClick={() => void runMutation("refresh", onMemoryRefresh)} type="button">{localOperation === "refresh" ? "正在查看…" : "查看整理结果"}</button> : null}
                </div>
              ) : null}
              {subjectEditable && subjectSuggestionState.status === "loading" ? <p role="status">正在整理内容归属；你仍可先完成本次复盘。</p> : null}
              {subjectEditable && subjectSuggestionState.status === "error" ? <p className={styles.inlineError} role="alert">{subjectSuggestionState.message}</p> : null}
              {subjectEditable && subjectSuggestionBatch ? (
                <div className={styles.subjectReview}>
                  <p>准备长期保留的内容归属</p>
                  <div className={styles.subjectReadOnly} aria-label="内容范围统计">
                    <span>关于 Ta {subjectCounts.companion}</span><span>关于我们 {subjectCounts.both}</span><span>关于我 {subjectCounts.self}</span><span>暂不确定 {subjectCounts.unknown}</span>
                  </div>
                  {subjectSuggestionBatch.status === "degraded" ? <small>无法确认归属的内容会保持“暂不确定”，不会自动关联人物。</small> : null}
                  {subjectThemes.map((theme) => (
                    <details className={styles.subjectSource} key={theme.kind}>
                      <summary>{theme.title} · {theme.suggestions.length} 条原话</summary>
                      <div className={styles.subjectReadOnly} aria-label={`${theme.title}的内容范围`}>
                        {SUBJECT_OPTIONS.flatMap((option) => theme.counts[option.subject] > 0 ? [<span key={option.subject}>{option.label} {theme.counts[option.subject]}</span>] : [])}
                      </div>
                      <ol className={styles.subjectSourceList}>
                        {theme.suggestions.map((suggestion, index) => (
                          <li key={suggestion.canonicalSourceKey}>
                            <q>{suggestion.quote}</q>
                            <span aria-label={`${theme.title}第 ${index + 1} 条原话的内容范围`}>
                              {SUBJECT_OPTIONS.find((option) => option.subject === suggestion.subject)?.label ?? "暂不确定"}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </details>
                  ))}
                  <small>完成复盘时会接受这些归属；真正长期保留哪些内容，仍受现有安全规则约束。</small>
                </div>
              ) : null}
              {relationshipReconfirmationRequired ? <p className={styles.boundaryNote} role="note">这段长期关系记录之前已被清理；重新启用后会按你确认的归属继续整理。</p> : memoryStatus === "needs_review" ? <p className={styles.boundaryNote} role="note">{memoryReview?.kind === "evidence_review_required" ? "这次原话来源已经变化，暂时不能继续长期整理。" : "人物设置已经变化，需要重新确认后才能继续长期整理。"}</p> : null}
              {memorySyncError ? <p className={styles.inlineError} role="alert">{memorySyncError}</p> : null}
              {confirmed && longTermReady && onMemorySync && (memoryStatus === "not_queued" || memoryStatus === "retryable_failed" || relationshipReconfirmationRequired) ? (
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
            </section>

            {editable ? (
              <ProductReviewCompletion
                action={!confirmed ? (
                  <button
                    className={styles.primaryButton}
                    disabled={!canFinalize}
                    onClick={() => onFinalize && void runMutation("finalize", () => (
                      includeLongTerm && memoryAdmission
                        ? onFinalize(participantAssignments, finalizeItems, voiceEnrollmentIntents, memoryAdmission)
                        : onFinalize(participantAssignments, finalizeItems, voiceEnrollmentIntents)
                    ))}
                    type="button"
                  >{localOperation === "finalize" || (mutationState.status === "saving" && mutationState.operation === "finalize") ? "正在完成…" : "完成本次复盘"}</button>
                ) : <span className={styles.recapCompletionStatus}>已完成</span>}
                className={styles.recapCompletion}
                description={confirmed
                  ? `已保留 ${keptCount} 条带原话的内容。长期记忆只会保留你明确选择并通过安全核对的部分。`
                  : keptCount === 0
                    ? "需要先确认至少一条有真实来源、且说话人归属一致的内容。"
                    : `将保留 ${keptCount} 条内容${excludedCount > 0 ? `，另有 ${excludedCount} 条未保留` : ""}。${includeLongTerm ? (memoryAdmission ? "你还选择了长期整理。" : "长期整理尚未准备好，但不会阻止完成复盘。") : "不会自动写入长期记忆。"}`}
                title={confirmed ? "本次复盘已完成" : "准备好就完成本次复盘"}
              />
            ) : null}

            {interaction.transcript.length > 0 ? (
              <CompanionTranscript chapters={chapters} highlightedSegmentId={highlightedSegmentId} lines={interaction.transcript} />
            ) : (
              <section className={styles.contentPanel}>
                <h2>完整文字记录</h2>
                <p className={styles.contentIntro}>这台设备没有完整文字稿；上面的来源片段仍可核对，不会生成失效入口。</p>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
