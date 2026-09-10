import {
  WorkMeetingCandidateStructuredDataSchema,
  type WorkMeetingCandidateStructuredData
} from "@/lib/domain/work-review";

import type {
  WorkCanonicalPublicationRecord,
  WorkEvidenceReferenceRecord,
  WorkMeetingDetail,
  WorkMeetingRecord,
  WorkReviewRepository
} from "./repository";
import { WORK_MEETING_NON_GPT_PROFILE } from "./publication-policy";

const CANDIDATE_KIND_ORDER = [
  "decision",
  "action_item",
  "commitment",
  "open_question",
  "plan_change",
  "proposal",
  "discussion_topic"
] as const;

function materializeEvidence(input: {
  publication: WorkCanonicalPublicationRecord;
  refs: WorkEvidenceReferenceRecord[];
}) {
  const indexById = new Map(input.publication.segments.map((segment, index) => [segment.id, index]));
  return input.refs.map((reference) => {
    const index = indexById.get(reference.segmentId);
    const segment = index === undefined ? undefined : input.publication.segments[index];
    if (!segment) throw new Error("work_review_evidence_segment_missing");
    const previous = index === undefined || index <= 0
      ? undefined
      : input.publication.segments[index - 1];
    const next = index === undefined || index >= input.publication.segments.length - 1
      ? undefined
      : input.publication.segments[index + 1];
    return {
      publicationId: reference.publicationId,
      segmentId: reference.segmentId,
      startSeconds: reference.startSeconds,
      endSeconds: reference.endSeconds,
      rawSpeakerLabel: reference.rawSpeakerLabel,
      timestampQuality: reference.timestampQuality,
      text: segment.text,
      ...(previous ? { contextBefore: previous.text } : {}),
      ...(next ? { contextAfter: next.text } : {})
    };
  });
}

function structuredData(value: unknown): WorkMeetingCandidateStructuredData {
  return WorkMeetingCandidateStructuredDataSchema.parse(value);
}

export function toWorkMeetingListItem(input: {
  repository: WorkReviewRepository;
  accountId: string;
  meeting: WorkMeetingRecord;
  projects?: unknown[];
}) {
  const candidates = input.meeting.analysisStatus === "review_ready"
    ? input.repository.listCandidates(input.accountId, input.meeting.id, false)
    : [];
  return {
    id: input.meeting.id,
    title: input.meeting.title,
    meetingDate: input.meeting.meetingDate,
    ingestionStatus: input.meeting.ingestionStatus,
    analysisStatus: input.meeting.analysisStatus,
    reviewStatus: input.meeting.reviewStatus,
    durationSeconds: input.meeting.sourceDurationSeconds,
    pendingCandidateCount: candidates.filter((candidate) =>
      candidate.status === "pending_review" && candidate.publicationAction !== "suppress"
    ).length,
    canonicalSegmentCount: input.meeting.canonicalSegmentCount,
    version: input.meeting.version,
    projects: input.projects ?? [],
    createdAt: input.meeting.createdAt,
    updatedAt: input.meeting.updatedAt
  };
}

export function toWorkMeetingDetailView(detail: WorkMeetingDetail) {
  const publication = detail.transcript;
  const evaluationProfiles = detail.evaluations.map((evaluation) => evaluation.verifierProfile);
  const allClaimsSkippedAsNonHighRisk = evaluationProfiles.length > 0
    && evaluationProfiles.every((profile) => profile === WORK_MEETING_NON_GPT_PROFILE);
  const anyVerifierInvocation = evaluationProfiles.some((profile) =>
    profile !== "verifier_disabled" && profile !== WORK_MEETING_NON_GPT_PROFILE
  );
  const verifierMode = detail.meeting.analysisStatus !== "review_ready"
    ? null
    : detail.evaluations.length === 0 || allClaimsSkippedAsNonHighRisk
      ? "not_applicable"
      : anyVerifierInvocation
        ? "enabled"
        : "disabled";
  const candidateKindIndex = (kind: string) => {
    const index = CANDIDATE_KIND_ORDER.indexOf(kind as typeof CANDIDATE_KIND_ORDER[number]);
    return index < 0 ? CANDIDATE_KIND_ORDER.length : index;
  };
  const candidates = detail.candidates
    .filter((candidate) => candidate.publicationAction !== "suppress"
      && candidate.status !== "invalidated")
    .sort((left, right) =>
      candidateKindIndex(left.kind) - candidateKindIndex(right.kind)
      || left.ordinal - right.ordinal
      || left.id.localeCompare(right.id)
    )
    .map((candidate) => {
      if (!publication) throw new Error("work_review_candidate_without_transcript");
      const data = structuredData(candidate.structuredData);
      return {
        id: candidate.id,
        kind: candidate.kind,
        status: candidate.status,
        title: candidate.title,
        body: candidate.body,
        version: candidate.version,
        publicationAction: candidate.publicationAction,
        riskLevel: candidate.riskLevel,
        candidateOwner: data.candidateOwner,
        dueAt: data.dueAt,
        originalDueExpression: data.originalDueExpression,
        actionBasis: data.actionBasis,
        decisionFinality: data.decisionFinality,
        evidence: materializeEvidence({ publication, refs: candidate.evidenceRefs }),
        planChangeStages: data.planStages.map((stage) => ({
          text: stage.content,
          status: stage.status,
          rawSpeakerLabel: stage.rawSpeakerLabel,
          evidence: materializeEvidence({ publication, refs: stage.evidenceRefs })
        })),
        structuredData: data
      };
    });
  const findings = detail.findings.map((finding) => {
    if (!publication) throw new Error("work_review_finding_without_transcript");
    const data = structuredData(finding.structuredData);
    return {
      id: finding.id,
      sourceCandidateId: finding.sourceCandidateId,
      kind: finding.kind,
      title: finding.title,
      body: finding.body,
      version: finding.version,
      candidateOwner: data.candidateOwner,
      dueAt: data.dueAt,
      originalDueExpression: data.originalDueExpression,
      actionBasis: data.actionBasis,
      decisionFinality: data.decisionFinality,
      evidence: materializeEvidence({ publication, refs: finding.evidenceRefs }),
      planChangeStages: data.planStages.map((stage) => ({
        text: stage.content,
        status: stage.status,
        rawSpeakerLabel: stage.rawSpeakerLabel,
        evidence: materializeEvidence({ publication, refs: stage.evidenceRefs })
      })),
      createdAt: finding.createdAt,
      updatedAt: finding.updatedAt
    };
  });
  return {
    meeting: {
      id: detail.meeting.id,
      title: detail.meeting.title,
      meetingDate: detail.meeting.meetingDate,
      sourceUploadId: detail.meeting.sourceUploadId,
      ingestionStatus: detail.meeting.ingestionStatus,
      analysisStatus: detail.meeting.analysisStatus,
      reviewStatus: detail.meeting.reviewStatus,
      durationSeconds: detail.meeting.sourceDurationSeconds,
      pendingCandidateCount: candidates.filter((candidate) =>
        candidate.status === "pending_review"
      ).length,
      canonicalSegmentCount: detail.meeting.canonicalSegmentCount,
      canonicalPublicationId: detail.meeting.canonicalPublicationId,
      canonicalContentDigest: detail.meeting.canonicalContentDigest,
      version: detail.meeting.version,
      errorStage: detail.meeting.errorStage,
      errorCode: detail.meeting.errorCode,
      processingStage: detail.activeProcessingLease?.stage ?? null,
      processingLeaseExpiresAt: detail.activeProcessingLease?.leaseExpiresAt ?? null,
      verifierMode,
      createdAt: detail.meeting.createdAt,
      updatedAt: detail.meeting.updatedAt
    },
    transcriptSegments: publication?.segments.map((segment) => ({
      id: segment.id,
      uploadId: segment.uploadId,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      speaker: segment.speaker?.trim() || null,
      text: segment.text,
      confidence: segment.confidence
    })) ?? [],
    candidates,
    findings,
    speakerAliases: detail.speakerAliases.map((alias) => ({ ...alias }))
  };
}
