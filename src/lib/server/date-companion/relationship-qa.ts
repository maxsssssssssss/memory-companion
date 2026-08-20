import type { DcRecapKind, DcRelationshipView } from "@/lib/domain/date-companion-stage2";
import {
  BriefItemSchema,
  TranscriptSegmentSchema,
  type BriefCategory,
  type BriefItem,
  type TranscriptSegment
} from "@/lib/domain/types";
import {
  type AnswerQuestionWithAIInput,
  type QaConversationMessage
} from "@/lib/server/retrieval/ai-qa";
import type { JsonStore } from "@/lib/server/storage/json-store";

type EligibleEvidence = {
  recapItemId: string;
  uploadId: string;
  sourceSegmentId: string;
  startSeconds: number;
  endSeconds: number;
  speakerRole: "self" | "companion";
  quote: string;
  recordingDate: string;
};

export type DateCompanionRelationshipQaContext = {
  segments: TranscriptSegment[];
  briefItems: BriefItem[];
  eligibleSourceSegmentIds: string[];
};

const CATEGORY_BY_KIND: Record<DcRecapKind, BriefCategory> = {
  moment: "notable_quote",
  mentioned: "idea",
  promise: "commitment",
  continue: "open_question"
};

const TITLE_BY_KIND: Record<DcRecapKind, string> = {
  moment: "值得记住的相处片段",
  mentioned: "Ta 提到的内容",
  promise: "已确认的约定",
  continue: "可以继续的话题"
};

function evidenceSignature(evidence: EligibleEvidence) {
  return JSON.stringify([
    evidence.uploadId,
    evidence.startSeconds,
    evidence.endSeconds,
    evidence.speakerRole,
    evidence.quote
  ]);
}

function roleIsEligibleForKind(kind: DcRecapKind, role: EligibleEvidence["speakerRole"]) {
  if (kind === "mentioned") return role === "companion";
  if (kind === "promise") return role === "self";
  return true;
}

/**
 * Builds the relationship QA Evidence allowlist exclusively from the
 * authenticated server relationship view. Browser-provided Evidence never
 * crosses this boundary.
 */
export function buildDateCompanionRelationshipQaContext(
  view: DcRelationshipView
): DateCompanionRelationshipQaContext {
  const eligibleByRecap = new Map<string, EligibleEvidence[]>();
  const recapById = new Map<string, {
    kind: DcRecapKind;
    displayedText: string;
    recordingDate: string;
    sourceUploadId: string;
    sortOrder: number;
  }>();

  const interactions = [...view.interactions]
    .filter((interaction) =>
      interaction.relationshipId === view.relationship.id &&
      interaction.status === "confirmed" &&
      Boolean(interaction.confirmedAt) &&
      interaction.sourceState !== "explicitly_deleted"
    )
    .sort((left, right) =>
      left.recordingDate.localeCompare(right.recordingDate) || left.id.localeCompare(right.id)
    );

  for (const interaction of interactions) {
    const participantRoleBySpeaker = new Map(
      interaction.participants.flatMap((participant) =>
        participant.confirmedAt && participant.role !== "unresolved"
          ? [[participant.speakerId, participant.role] as const]
          : []
      )
    );

    for (const recap of interaction.recapItems) {
      if (recap.disposition !== "kept") continue;
      recapById.set(recap.id, {
        kind: recap.kind,
        displayedText: recap.displayedText,
        recordingDate: interaction.recordingDate,
        sourceUploadId: interaction.sourceUploadId,
        sortOrder: recap.sortOrder
      });
      const eligible = recap.evidence.flatMap((evidence): EligibleEvidence[] => {
        const sourceSegmentId = evidence.sourceSegmentId.trim();
        const quote = evidence.quote.replace(/\s+/gu, " ").trim();
        const speakerRole = evidence.speakerId
          ? participantRoleBySpeaker.get(evidence.speakerId)
          : undefined;
        if (
          !sourceSegmentId ||
          !quote ||
          evidence.uploadId !== interaction.sourceUploadId ||
          !speakerRole ||
          !roleIsEligibleForKind(recap.kind, speakerRole)
        ) {
          return [];
        }
        return [{
          recapItemId: recap.id,
          uploadId: evidence.uploadId,
          sourceSegmentId,
          startSeconds: evidence.startSeconds,
          endSeconds: evidence.endSeconds,
          speakerRole,
          quote,
          recordingDate: interaction.recordingDate
        }];
      });
      if (eligible.length > 0) eligibleByRecap.set(recap.id, eligible);
    }
  }

  const evidenceBySourceId = new Map<string, EligibleEvidence[]>();
  for (const evidence of [...eligibleByRecap.values()].flat()) {
    const candidates = evidenceBySourceId.get(evidence.sourceSegmentId) ?? [];
    candidates.push(evidence);
    evidenceBySourceId.set(evidence.sourceSegmentId, candidates);
  }

  const unambiguousBySourceId = new Map<string, EligibleEvidence>();
  for (const [sourceSegmentId, candidates] of evidenceBySourceId) {
    if (new Set(candidates.map(evidenceSignature)).size !== 1) continue;
    unambiguousBySourceId.set(sourceSegmentId, candidates[0]);
  }

  const segments = [...unambiguousBySourceId.values()]
    .sort((left, right) =>
      left.recordingDate.localeCompare(right.recordingDate) ||
      left.startSeconds - right.startSeconds ||
      left.sourceSegmentId.localeCompare(right.sourceSegmentId)
    )
    .map((evidence) => TranscriptSegmentSchema.parse({
      id: evidence.sourceSegmentId,
      uploadId: evidence.uploadId,
      startSeconds: evidence.startSeconds,
      endSeconds: evidence.endSeconds,
      speaker: evidence.speakerRole === "self" ? "我" : "Ta",
      text: `记录日期：${evidence.recordingDate}\n原话：${evidence.quote}`,
      confidence: 1,
      sceneLabels: [],
      valueLabels: []
    }));

  const briefItems = [...recapById.entries()]
    .sort((left, right) =>
      left[1].recordingDate.localeCompare(right[1].recordingDate) ||
      left[1].sortOrder - right[1].sortOrder ||
      left[0].localeCompare(right[0])
    )
    .flatMap(([recapItemId, recap]): BriefItem[] => {
      const evidence = (eligibleByRecap.get(recapItemId) ?? []).filter(
        (item) => unambiguousBySourceId.has(item.sourceSegmentId)
      );
      if (evidence.length === 0) return [];
      const startSeconds = Math.min(...evidence.map((item) => item.startSeconds));
      const endSeconds = Math.max(...evidence.map((item) => item.endSeconds));
      return [BriefItemSchema.parse({
        id: `dc_recap_${recapItemId}`,
        uploadId: recap.sourceUploadId,
        category: CATEGORY_BY_KIND[recap.kind],
        title: `${recap.recordingDate} · ${TITLE_BY_KIND[recap.kind]}`,
        body: `${recap.displayedText}\n记录日期：${recap.recordingDate}`,
        priority: recap.kind === "promise" ? "high" : "medium",
        confidence: 1,
        status: "confirmed",
        sourceSegmentIds: [...new Set(evidence.map((item) => item.sourceSegmentId))],
        sourceTimeRange: { startSeconds, endSeconds },
        transcriptExcerpt: evidence
          .map((item) => `[${item.recordingDate}] “${item.quote}”`)
          .join("\n"),
        people: [],
        topics: []
      })];
    });

  return {
    segments,
    briefItems,
    eligibleSourceSegmentIds: segments.map((segment) => segment.id)
  };
}

export function buildDateCompanionRelationshipQaInput(input: {
  userId: string;
  relationshipId: string;
  question: string;
  conversation: QaConversationMessage[];
  settingsStore: JsonStore;
  view: DcRelationshipView;
}): AnswerQuestionWithAIInput {
  const context = buildDateCompanionRelationshipQaContext(input.view);
  return {
    userId: input.userId,
    uploadId: input.relationshipId,
    question: input.question,
    ...(input.conversation.length > 0 ? { conversation: input.conversation } : {}),
    relationshipScope: true,
    settingsStore: input.settingsStore,
    segments: context.segments,
    audioInsights: [],
    semanticSegments: [],
    briefItems: context.briefItems,
    relationshipSignals: [],
    disableHybridRetrieval: true,
    failClosedOnModelProviderMismatch: true
  };
}
