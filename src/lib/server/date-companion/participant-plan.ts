import {
  DATE_COMPANION_TRUSTED_SPEAKER_CONFIDENCE,
  dateCompanionIdentityContinuityKey,
  dateCompanionParticipantKey
} from "@/lib/domain/date-companion-speaker";
import {
  isChunkLocalSpeakerLabel,
  normalizeSpeakerIdentityLabel,
  trustedTranscriptSpeakerIdentity
} from "@/lib/domain/speaker-identity";
import type { TranscriptSegment } from "@/lib/domain/types";
import { JsonSpeakerIdentityRepository } from "@/lib/server/speaker-identity/repository";
import type { JsonStore } from "@/lib/server/storage/json-store";

export type DateCompanionParticipantBuildOptions = {
  providerLabelContinuityEnabled?: boolean;
};

export type DateCompanionParticipantPlan = {
  participants: Array<{
    speakerId: string;
    continuityKey?: string;
  }>;
  reviewSpeakerIdBySpeakerId: ReadonlyMap<string, string>;
};

export function isDateCompanionProviderLabelContinuityEnabled(
  value = process.env.DATE_COMPANION_PROVIDER_LABEL_CONTINUITY_ENABLED
) {
  return value?.trim().toLowerCase() === "true";
}

function reviewRequiredProviderLabel(segment: TranscriptSegment) {
  const identity = segment.identity;
  const speaker = normalizeSpeakerIdentityLabel(segment.speaker);
  const providerLabel = normalizeSpeakerIdentityLabel(identity?.evidence?.providerLabel);
  if (
    !identity
    || identity.identityType !== "unknown_person"
    || identity.source !== "provider_speaker_result"
    || identity.confidence !== null
    || identity.evidence?.type !== "provider_label"
    || identity.evidence.provider !== "company_voiceprint"
    || !speaker
    || isChunkLocalSpeakerLabel(speaker)
    || providerLabel !== speaker
  ) {
    return undefined;
  }
  return providerLabel;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizedAuditLabel(value: unknown) {
  return typeof value === "string"
    ? normalizeSpeakerIdentityLabel(value)
    : undefined;
}

function auditAllowsReviewRequiredProviderLabel(
  rawAudit: unknown,
  segment: TranscriptSegment,
  providerLabel: string
) {
  const audit = recordValue(rawAudit);
  const structuralGate = recordValue(audit?.structuralGate);
  const evidenceAvailability = recordValue(audit?.evidenceAvailability);
  if (
    audit?.version !== 1
    || audit.uploadId !== segment.uploadId
    || structuralGate?.status !== "healthy"
    || evidenceAvailability?.voiceprint !== "available"
    || !Array.isArray(audit?.resolutionStates)
  ) {
    return false;
  }

  const globalSpeakerId = segment.identity?.globalSpeakerId;
  if (!globalSpeakerId) return false;
  const matchingResolutions = audit.resolutionStates.filter((rawResolution) => {
    const resolution = recordValue(rawResolution);
    const evidence = recordValue(resolution?.evidence);
    return (
      resolution
      && resolution.globalSpeakerId === globalSpeakerId
      && normalizedAuditLabel(resolution.localSpeaker) === providerLabel
      && normalizedAuditLabel(resolution.providerLabel) === providerLabel
      && resolution.ownerIdentityId === null
      && resolution.confidence === null
      && resolution.status === "pending"
      && resolution.source === "provider_speaker_result"
      && resolution.reason === "provider_label_review_required"
      && evidence?.type === "provider_label"
      && evidence.provider === "company_voiceprint"
      && normalizedAuditLabel(evidence.providerLabel) === providerLabel
    );
  });
  return matchingResolutions.length === 1;
}

export async function buildDateCompanionParticipantPlan(input: {
  store: JsonStore;
  uploadId: string;
  segments: TranscriptSegment[];
  userId: string;
  options?: DateCompanionParticipantBuildOptions;
}): Promise<DateCompanionParticipantPlan> {
  const providerLabelContinuityEnabled =
    input.options?.providerLabelContinuityEnabled
    ?? isDateCompanionProviderLabelContinuityEnabled();
  let identityAudit: unknown = null;
  if (providerLabelContinuityEnabled) {
    try {
      identityAudit = await input.store.read<unknown>("speaker-identities", input.uploadId);
    } catch (error) {
      console.warn(
        `[date-companion-speaker] identity_audit_lookup_failed upload_id=${input.uploadId} ` +
        `error_name=${error instanceof Error ? error.name : "unknown"}`
      );
    }
  }

  let profiles = [] as Awaited<ReturnType<JsonSpeakerIdentityRepository["listProfiles"]>>;
  try {
    profiles = (await new JsonSpeakerIdentityRepository(input.store).listProfiles())
      .filter(
        (profile) =>
          profile.status === "active"
          && profile.identityType !== "unknown_person"
          && profile.userId === input.userId
      );
  } catch (error) {
    console.warn(
      `[date-companion-speaker] profile_lookup_failed upload_id=${input.uploadId} ` +
      `error_name=${error instanceof Error ? error.name : "unknown"}`
    );
  }
  const profileById = new Map(profiles.map((profile) => [profile.globalSpeakerId, profile]));
  const profilesByProviderLabel = new Map<string, typeof profiles>();
  for (const profile of profiles) {
    const providerLabel = normalizeSpeakerIdentityLabel(
      profile.providerReference?.speakerLabel
    );
    if (!providerLabel || isChunkLocalSpeakerLabel(providerLabel)) continue;
    const matching = profilesByProviderLabel.get(providerLabel) ?? [];
    matching.push(profile);
    profilesByProviderLabel.set(providerLabel, matching);
  }

  const segmentsByParticipant = new Map<string, TranscriptSegment[]>();
  for (const segment of input.segments) {
    const speakerId = dateCompanionParticipantKey(segment);
    if (!speakerId) continue;
    const segments = segmentsByParticipant.get(speakerId) ?? [];
    segments.push(segment);
    segmentsByParticipant.set(speakerId, segments);
  }

  const participants = [...segmentsByParticipant.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([speakerId, segments]) => {
      const matchingProfiles = new Set<string>();
      let allSegmentsMatch = true;
      for (const segment of segments) {
        const identity = trustedTranscriptSpeakerIdentity(
          segment,
          DATE_COMPANION_TRUSTED_SPEAKER_CONFIDENCE
        );
        if (identity) {
          const profile = profileById.get(identity.globalSpeakerId);
          if (profile?.identityType === identity.identityType) {
            matchingProfiles.add(profile.globalSpeakerId);
          } else {
            allSegmentsMatch = false;
          }
        } else {
          const providerLabel = providerLabelContinuityEnabled
            ? reviewRequiredProviderLabel(segment)
            : undefined;
          const providerProfiles = providerLabel
            && auditAllowsReviewRequiredProviderLabel(identityAudit, segment, providerLabel)
            ? profilesByProviderLabel.get(providerLabel) ?? []
            : [];
          if (providerProfiles.length === 1) {
            matchingProfiles.add(providerProfiles[0].globalSpeakerId);
          } else {
            allSegmentsMatch = false;
          }
        }
        if (!allSegmentsMatch || matchingProfiles.size > 1) break;
      }
      if (!allSegmentsMatch || matchingProfiles.size !== 1) return { speakerId };
      const continuityKey = dateCompanionIdentityContinuityKey([...matchingProfiles][0]);
      return {
        speakerId,
        ...(continuityKey ? { continuityKey } : {})
      };
    });

  const representativeByContinuityKey = new Map<string, string>();
  for (const participant of participants) {
    if (
      participant.continuityKey
      && !representativeByContinuityKey.has(participant.continuityKey)
    ) {
      representativeByContinuityKey.set(participant.continuityKey, participant.speakerId);
    }
  }
  const reviewSpeakerIdBySpeakerId = new Map(
    participants.map((participant) => [
      participant.speakerId,
      participant.continuityKey
        ? representativeByContinuityKey.get(participant.continuityKey) ?? participant.speakerId
        : participant.speakerId
    ])
  );
  return { participants, reviewSpeakerIdBySpeakerId };
}
