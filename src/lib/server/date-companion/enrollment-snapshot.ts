import { createHash } from "node:crypto";

import { dateCompanionParticipantKey } from "@/lib/domain/date-companion-speaker";
import type { TranscriptSegment } from "@/lib/domain/types";
import type { IdentityResolverAudit } from "@/lib/server/speaker-identity/identity-resolver";
import { speakerIdentityCandidateKey } from "@/lib/server/speaker-identity/matching";
import type { JsonStore } from "@/lib/server/storage/json-store";
import { JsonChunkCheckpointStore } from "@/lib/server/transcription/chunks/checkpoint-store";
import { buildChunkSegmentId } from "@/lib/server/transcription/chunks/transcript-merge";

import type { DateCompanionParticipantPlan } from "./participant-plan";
import type { DcVoiceEnrollmentSnapshotInput } from "./types";

export const DATE_COMPANION_VOICE_ENROLLMENT_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1_000;

function auditDigest(input: {
  audit: IdentityResolverAudit;
  resolution: IdentityResolverAudit["resolutionStates"][number];
}) {
  return createHash("sha256").update(JSON.stringify({
    version: input.audit.version,
    uploadId: input.audit.uploadId,
    generatedAt: input.audit.generatedAt,
    structuralGate: input.audit.structuralGate,
    evidenceAvailability: input.audit.evidenceAvailability,
    resolution: {
      candidateKey: input.resolution.candidateKey,
      chunkId: input.resolution.chunkId,
      localSpeaker: input.resolution.localSpeaker,
      globalSpeakerId: input.resolution.globalSpeakerId,
      ownerIdentityId: input.resolution.ownerIdentityId,
      confidence: input.resolution.confidence,
      status: input.resolution.status,
      source: input.resolution.source,
      providerLabel: input.resolution.providerLabel,
      evidence: input.resolution.evidence,
      reason: input.resolution.reason
    }
  })).digest("hex");
}

function validAudit(raw: unknown, uploadId: string): raw is IdentityResolverAudit {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const audit = raw as Partial<IdentityResolverAudit>;
  return audit.version === 1
    && audit.uploadId === uploadId
    && audit.structuralGate?.status === "healthy"
    && Array.isArray(audit.structuralGate.chunks)
    && Array.isArray(audit.resolutionStates);
}

function eligibleAuditResolution(input: {
  raw: unknown;
  candidateKey: string;
  chunkId: string;
  localSpeaker: string;
}) {
  if (!input.raw || typeof input.raw !== "object" || Array.isArray(input.raw)) return false;
  const resolution = input.raw as Record<string, unknown>;
  return resolution.candidateKey === input.candidateKey
    && resolution.chunkId === input.chunkId
    && typeof resolution.localSpeaker === "string"
    && resolution.localSpeaker.trim() === input.localSpeaker
    && (resolution.status === "verified"
      || resolution.status === "pending"
      || resolution.status === "unknown")
    && typeof resolution.reason === "string"
    && resolution.reason.length > 0
    && resolution.reason.length <= 512;
}

/**
 * Captures only Provider record provenance and an audit digest. Audio bytes and
 * transcript text are intentionally excluded so normal upload cleanup remains
 * the authoritative raw-data boundary.
 */
export async function buildDateCompanionVoiceEnrollmentSnapshots(input: {
  store: JsonStore;
  uploadId: string;
  segments: TranscriptSegment[];
  participantPlan: DateCompanionParticipantPlan;
  now?: () => string;
}): Promise<DcVoiceEnrollmentSnapshotInput[]> {
  const [chunks, rawAudit] = await Promise.all([
    new JsonChunkCheckpointStore(input.store).listTranscriptChunks(input.uploadId),
    input.store.read<unknown>("speaker-identities", input.uploadId)
  ]);
  if (!validAudit(rawAudit, input.uploadId) || chunks.length === 0) return [];

  const audit = rawAudit;
  const chunkGateById = new Map(audit.structuralGate.chunks.flatMap((chunk) =>
    chunk
      && typeof chunk === "object"
      && typeof chunk.chunkId === "string"
      && (chunk.status === "healthy" || chunk.status === "degraded" || chunk.status === "blocked")
      ? [[chunk.chunkId, chunk] as const]
      : []
  ));
  const mergedById = new Map(input.segments.map((segment) => [segment.id, segment]));
  const groupMembers = new Map<string, string[]>();
  for (const participant of input.participantPlan.participants) {
    const groupId = input.participantPlan.reviewSpeakerIdBySpeakerId.get(
      participant.speakerId
    ) ?? participant.speakerId;
    const members = groupMembers.get(groupId) ?? [];
    members.push(participant.speakerId);
    groupMembers.set(groupId, members);
  }

  const candidatesBySpeaker = new Map<string, Array<{
    providerRecordId: string;
    chunkId: string;
    chunkIndex: number;
    localSpeaker: string;
    auditStatus: "verified" | "pending" | "unknown";
    auditReason: string;
    auditDigest: string;
  }>>();
  for (const chunk of chunks) {
    if (chunkGateById.get(chunk.id)?.status !== "healthy") continue;
    const localSpeakers = new Set(
      chunk.segments.flatMap((segment) => segment.speaker?.trim() ? [segment.speaker.trim()] : [])
    );
    for (const localSpeaker of localSpeakers) {
      const candidateKey = speakerIdentityCandidateKey(chunk.id, localSpeaker);
      const resolutions = audit.resolutionStates.filter(
        (raw): raw is IdentityResolverAudit["resolutionStates"][number] =>
          eligibleAuditResolution({
            raw,
            candidateKey,
            chunkId: chunk.id,
            localSpeaker
          })
      );
      if (resolutions.length !== 1) continue;
      const resolution = resolutions[0];
      if (resolution.status === "conflict") continue;
      const rawSpeakerIds = new Set(
        chunk.segments
          .flatMap((segment, segmentIndex) => segment.speaker?.trim() === localSpeaker
            ? [{ segment, segmentIndex }]
            : [])
          .flatMap(({ segmentIndex }) => {
            const canonicalSegmentId = buildChunkSegmentId(
              chunk.uploadId,
              chunk.index,
              segmentIndex
            );
            const merged = mergedById.get(canonicalSegmentId);
            const rawSpeakerId = merged ? dateCompanionParticipantKey(merged) : undefined;
            return rawSpeakerId ? [rawSpeakerId] : [];
          })
      );
      if (rawSpeakerIds.size !== 1) continue;
      const rawSpeakerId = [...rawSpeakerIds][0];
      const candidates = candidatesBySpeaker.get(rawSpeakerId) ?? [];
      candidates.push({
        providerRecordId: chunk.audioChunkId,
        chunkId: chunk.id,
        chunkIndex: chunk.index,
        localSpeaker,
        auditStatus: resolution.status,
        auditReason: resolution.reason,
        auditDigest: auditDigest({ audit, resolution })
      });
      candidatesBySpeaker.set(rawSpeakerId, candidates);
    }
  }

  const timestamp = input.now?.() ?? new Date().toISOString();
  const expiresAt = new Date(
    Date.parse(timestamp) + DATE_COMPANION_VOICE_ENROLLMENT_SNAPSHOT_TTL_MS
  ).toISOString();
  return [...groupMembers.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([reviewGroupId, rawMembers]): DcVoiceEnrollmentSnapshotInput[] => {
      const speakerIds = [...new Set(rawMembers)].sort();
      if (speakerIds.length === 0 || speakerIds.length > 16) return [];
      const memberCandidates = speakerIds.map((speakerId) =>
        (candidatesBySpeaker.get(speakerId) ?? [])
          .sort((left, right) =>
            left.chunkIndex - right.chunkIndex
            || left.chunkId.localeCompare(right.chunkId)
            || left.localSpeaker.localeCompare(right.localSpeaker)
          )
      );
      if (memberCandidates.some((candidates) => candidates.length === 0)) return [];
      const representative = memberCandidates[0][0];
      return [{
        reviewGroupId,
        speakerIds,
        sourceUploadId: input.uploadId,
        providerRecordId: representative.providerRecordId,
        chunkId: representative.chunkId,
        localSpeaker: representative.localSpeaker,
        auditStatus: representative.auditStatus,
        auditReason: representative.auditReason,
        auditDigest: representative.auditDigest,
        expiresAt
      }];
    });
}
