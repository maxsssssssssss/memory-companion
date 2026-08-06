import type { TranscriptSegment } from "@/lib/domain/types";
import {
  MemoryOwnerAttributionSchema,
  MemoryOwnerAuditSchema,
  MemoryOwnerObservationSchema,
  MemoryOwnerResolutionSchema,
  MemoryParticipantAttributionSchema,
  type MemoryOwnerAttribution,
  type MemoryOwnerObservation,
  type MemoryOwnerResolution,
  type MemoryOwnerResolutionReason,
  type MemoryOwnerStatementKind,
  type MemoryParticipantAttribution,
  type MemoryParticipantRole,
  type ResolveMemoryOwnerAttributionInput,
  type ResolveMemoryOwnerAttributionsInput
} from "./types";

export const MIN_OWNER_IDENTITY_CONFIDENCE = 0.8;

const SELF_PREFERENCE_PATTERN =
  /我(?:自己)?[^，。！？；,.!?;\n]{0,12}(?:不吃|不喜欢|不爱|不能吃|不太能吃|不太能接受|不能接受|喜欢|更喜欢|最喜欢|偏好|倾向|习惯|平时|通常|一般|选择|会选|prefer|avoid)/iu;
const THIRD_PERSON_PREFERENCE_PATTERN =
  /(?:她|他|你|您|对方|伴侣|朋友|家人|partner|they|she|he|you)[^，。！？；,.!?;\n]{0,16}(?:不吃|不喜欢|不爱|不能吃|不太能吃|不太能接受|不能接受|喜欢|更喜欢|最喜欢|偏好|倾向|习惯|平时|通常|一般|选择|会选|prefer|avoid)/iu;
const SELF_COMMITMENT_PATTERN =
  /我(?:自己)?[^，。！？；,.!?;\n]{0,18}(?:会|将|要|答应|承诺|保证|负责|准备|打算|计划|愿意|陪|帮|发送|通知|确认|完成|promise|will)/iu;
const THIRD_PERSON_COMMITMENT_PATTERN =
  /(?:她|他|对方|伴侣|朋友|家人|partner|they|she|he)[^，。！？；,.!?;\n]{0,18}(?:会|将|要|答应|承诺|保证|负责|准备|打算|计划|愿意|陪|帮|发送|通知|确认|完成|promise|will)/iu;
const SELF_EVENT_PATTERN =
  /我(?:自己)?[^，。！？；,.!?;\n]{0,18}(?:去|参加|完成|预约|到|做|见|出发|回来|attend|join|visit|complete)/iu;
const SHARED_CONTEXT_PATTERN = /我们|咱们|双方|一起|共同|两个人|彼此|both of us|together/iu;
const SECOND_PERSON_PATTERN = /你|您|your?|you/iu;

const unknownOwner = (): MemoryOwnerAttribution => MemoryOwnerAttributionSchema.parse({
  type: "unknown",
  confidence: 0,
  source: "unknown"
});

function orderedSegments(segments: TranscriptSegment[]) {
  return [...segments].sort(
    (left, right) =>
      left.startSeconds - right.startSeconds ||
      left.endSeconds - right.endSeconds ||
      left.id.localeCompare(right.id)
  );
}

function statementKind(
  memoryType: ResolveMemoryOwnerAttributionInput["memoryType"],
  text: string
): MemoryOwnerStatementKind {
  const normalized = text.normalize("NFKC");
  if (memoryType === "preference") {
    if (THIRD_PERSON_PREFERENCE_PATTERN.test(normalized)) return "third_person_reference";
    if (SHARED_CONTEXT_PATTERN.test(normalized)) return "shared_statement";
    if (SELF_PREFERENCE_PATTERN.test(normalized)) return "self_statement";
  }
  if (memoryType === "commitment") {
    if (THIRD_PERSON_COMMITMENT_PATTERN.test(normalized)) return "third_person_reference";
    if (SHARED_CONTEXT_PATTERN.test(normalized)) return "shared_statement";
    if (SELF_COMMITMENT_PATTERN.test(normalized)) return "self_statement";
  }
  if (
    (memoryType === "event" || memoryType === "relationship_signal") &&
    SHARED_CONTEXT_PATTERN.test(normalized)
  ) {
    return "shared_statement";
  }
  return "other";
}

function identityAttribution(segment: TranscriptSegment): {
  attribution: MemoryOwnerAttribution;
  reason: MemoryOwnerObservation["reason"];
} {
  const identity = segment.identity;
  if (!identity) {
    return { attribution: unknownOwner(), reason: "identity_missing" };
  }
  if (
    identity.confidence === null ||
    identity.confidence < MIN_OWNER_IDENTITY_CONFIDENCE
  ) {
    return { attribution: unknownOwner(), reason: "identity_below_threshold" };
  }

  return {
    attribution: MemoryOwnerAttributionSchema.parse({
      type:
        identity.identityType === "known_user" || identity.identityType === "known_contact"
          ? "known_identity"
          : "local_speaker",
      identityId: identity.globalSpeakerId,
      confidence: identity.confidence,
      source: identity.source === "manual_mapping" ? "manual_mapping" : "speaker_identity"
    }),
    reason: "trusted_speaker_identity"
  };
}

function observationForSegment(
  memoryType: ResolveMemoryOwnerAttributionInput["memoryType"],
  segment: TranscriptSegment
) {
  const kind = statementKind(memoryType, segment.text);
  if (kind === "third_person_reference") {
    return MemoryOwnerObservationSchema.parse({
      segmentId: segment.id,
      statementKind: kind,
      eligible: false,
      attribution: unknownOwner(),
      reason: "third_person_reference"
    });
  }

  const identity = identityAttribution(segment);
  const ownerEligible = kind === "self_statement" && identity.attribution.type !== "unknown";
  return MemoryOwnerObservationSchema.parse({
    segmentId: segment.id,
    statementKind: kind,
    eligible: identity.attribution.type !== "unknown",
    attribution: ownerEligible
      ? MemoryOwnerAttributionSchema.parse({
          ...identity.attribution,
          source: "explicit_statement"
        })
      : identity.attribution,
    reason: ownerEligible ? "explicit_self_statement" : identity.reason
  });
}

function attributionKey(attribution: MemoryOwnerAttribution) {
  return attribution.type === "unknown"
    ? null
    : `${attribution.type}\u001f${attribution.identityId}`;
}

type AttributionGroup = {
  attribution: MemoryOwnerAttribution;
  evidenceSegmentIds: string[];
};

function groupedAttributions(
  items: Array<{ attribution: MemoryOwnerAttribution; segmentId: string }>
): AttributionGroup[] {
  const groups = new Map<string, AttributionGroup>();
  for (const item of items) {
    const key = attributionKey(item.attribution);
    if (!key) continue;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        attribution: item.attribution,
        evidenceSegmentIds: [item.segmentId]
      });
      continue;
    }
    existing.attribution = MemoryOwnerAttributionSchema.parse({
      ...existing.attribution,
      confidence: Math.min(existing.attribution.confidence, item.attribution.confidence),
      source:
        existing.attribution.source === "explicit_statement" ||
        item.attribution.source === "explicit_statement"
          ? "explicit_statement"
          : existing.attribution.source === "manual_mapping" ||
              item.attribution.source === "manual_mapping"
            ? "manual_mapping"
            : "speaker_identity"
    });
    if (!existing.evidenceSegmentIds.includes(item.segmentId)) {
      existing.evidenceSegmentIds.push(item.segmentId);
    }
  }
  return [...groups.values()].sort((left, right) => {
    const leftId = left.attribution.identityId ?? "";
    const rightId = right.attribution.identityId ?? "";
    return leftId.localeCompare(rightId);
  });
}

function participant(
  role: MemoryParticipantRole,
  group: AttributionGroup
): MemoryParticipantAttribution {
  return MemoryParticipantAttributionSchema.parse({
    role,
    attribution: group.attribution,
    evidenceSegmentIds: [...group.evidenceSegmentIds].sort()
  });
}

function explicitOwnerGroups(observations: MemoryOwnerObservation[]) {
  return groupedAttributions(
    observations.flatMap((observation) =>
      observation.statementKind === "self_statement" &&
      observation.attribution.type !== "unknown"
        ? [{ attribution: observation.attribution, segmentId: observation.segmentId }]
        : []
    )
  );
}

function trustedIdentityGroups(
  segments: TranscriptSegment[],
  included?: (segment: TranscriptSegment) => boolean
) {
  return groupedAttributions(
    segments.flatMap((segment) => {
      if (included && !included(segment)) return [];
      const resolved = identityAttribution(segment).attribution;
      return resolved.type === "unknown"
        ? []
        : [{ attribution: resolved, segmentId: segment.id }];
    })
  );
}

function ownerResolution(input: {
  input: ResolveMemoryOwnerAttributionInput;
  segments: TranscriptSegment[];
  observations: MemoryOwnerObservation[];
}) {
  const ownerCandidates = explicitOwnerGroups(input.observations);
  if (ownerCandidates.length === 1) {
    return {
      owner: ownerCandidates[0].attribution,
      ownerGroup: ownerCandidates[0],
      reason: "explicit_owner" as const
    };
  }
  if (ownerCandidates.length > 1) {
    return {
      owner: unknownOwner(),
      reason: "ambiguous_owner" as const
    };
  }
  if (input.observations.some((observation) => observation.statementKind === "third_person_reference")) {
    return {
      owner: unknownOwner(),
      reason: "third_person_only" as const
    };
  }
  if (input.observations.some((observation) => observation.statementKind === "shared_statement")) {
    return {
      owner: unknownOwner(),
      reason: "shared_context" as const
    };
  }
  const speakerCandidates = trustedIdentityGroups(input.segments);
  if (speakerCandidates.length === 1) {
    return {
      owner: speakerCandidates[0].attribution,
      ownerGroup: speakerCandidates[0],
      reason: "speaker_identity_owner" as const
    };
  }
  return {
    owner: unknownOwner(),
    reason: speakerCandidates.length > 1
      ? "ambiguous_owner" as const
      : "no_trusted_identity" as const
  };
}

function preferenceResolution(input: {
  input: ResolveMemoryOwnerAttributionInput;
  segments: TranscriptSegment[];
  observations: MemoryOwnerObservation[];
}) {
  const resolved = ownerResolution(input);
  return {
    scope: resolved.owner.type === "unknown" ? "unknown" as const : "individual" as const,
    owner: resolved.owner,
    participants: resolved.ownerGroup ? [participant("owner", resolved.ownerGroup)] : [],
    reasons: [resolved.reason] satisfies MemoryOwnerResolutionReason[]
  };
}

function commitmentResolution(input: {
  input: ResolveMemoryOwnerAttributionInput;
  segments: TranscriptSegment[];
  observations: MemoryOwnerObservation[];
}) {
  const resolved = ownerResolution(input);
  if (!resolved.ownerGroup || resolved.owner.type === "unknown") {
    return {
      scope: "unknown" as const,
      owner: resolved.owner,
      participants: [] as MemoryParticipantAttribution[],
      reasons: [resolved.reason, "receiver_unresolved"] satisfies MemoryOwnerResolutionReason[]
    };
  }

  const actorKey = attributionKey(resolved.owner)!;
  const actorSegmentIds = new Set(resolved.ownerGroup.evidenceSegmentIds);
  const directlyAddressesReceiver = input.segments.some(
    (segment) => actorSegmentIds.has(segment.id) && SECOND_PERSON_PATTERN.test(segment.text.normalize("NFKC"))
  );
  const receivers = trustedIdentityGroups(input.segments).filter(
    (group) => attributionKey(group.attribution) !== actorKey
  );
  const participants = [participant("actor", resolved.ownerGroup)];
  const reasons: MemoryOwnerResolutionReason[] = ["commitment_actor"];
  if (directlyAddressesReceiver && receivers.length === 1) {
    participants.push(participant("receiver", receivers[0]));
    reasons.push("receiver_unique");
  } else {
    reasons.push("receiver_unresolved");
  }
  return {
    scope: "individual" as const,
    owner: resolved.owner,
    participants,
    reasons
  };
}

function eventResolution(segments: TranscriptSegment[]) {
  const shared = segments.some((segment) => SHARED_CONTEXT_PATTERN.test(segment.text.normalize("NFKC")));
  const groups = trustedIdentityGroups(
    segments,
    shared
      ? undefined
      : (segment) => SELF_EVENT_PATTERN.test(segment.text.normalize("NFKC"))
  );
  return {
    scope: shared ? "shared" as const : groups.length === 1 ? "individual" as const : "unknown" as const,
    owner: unknownOwner(),
    participants: groups.map((group) => participant("participant", group)),
    reasons: [
      shared
        ? "shared_context" as const
        : groups.length === 1
          ? "individual_participant" as const
          : "owner_not_applicable" as const
    ]
  };
}

function relationshipResolution(segments: TranscriptSegment[]) {
  const groups = trustedIdentityGroups(segments);
  const shared =
    groups.length >= 2 ||
    segments.some((segment) => SHARED_CONTEXT_PATTERN.test(segment.text.normalize("NFKC")));
  return {
    scope: shared ? "shared" as const : "unknown" as const,
    owner: unknownOwner(),
    participants: groups.map((group) => participant("participant", group)),
    reasons: [shared ? "shared_context" as const : "owner_not_applicable" as const]
  };
}

export function resolveMemoryOwnerAttribution(
  input: ResolveMemoryOwnerAttributionInput
): MemoryOwnerResolution {
  const segments = orderedSegments(input.evidenceSegments);
  const observations = segments.map((segment) => observationForSegment(input.memoryType, segment));
  const resolved = input.memoryType === "preference"
    ? preferenceResolution({ input, segments, observations })
    : input.memoryType === "commitment"
      ? commitmentResolution({ input, segments, observations })
      : input.memoryType === "event"
        ? eventResolution(segments)
        : input.memoryType === "relationship_signal"
          ? relationshipResolution(segments)
          : {
              scope: "unknown" as const,
              owner: unknownOwner(),
              participants: [] as MemoryParticipantAttribution[],
              reasons: ["owner_not_applicable" as const]
            };

  return MemoryOwnerResolutionSchema.parse({
    version: 1,
    memoryId: input.memoryId,
    memoryType: input.memoryType,
    ...resolved,
    evidenceSegmentIds: [...new Set(segments.map((segment) => segment.id))],
    observations
  });
}

export function resolveMemoryOwnerAttributions(input: ResolveMemoryOwnerAttributionsInput) {
  const attributions = input.memories.map(resolveMemoryOwnerAttribution);
  const audit = MemoryOwnerAuditSchema.parse({
    version: 1,
    generatedAt: (input.now ?? (() => new Date().toISOString()))(),
    memoriesProcessed: attributions.length,
    knownOwners: attributions.filter((item) => item.owner.type === "known_identity").length,
    localSpeakerOwners: attributions.filter((item) => item.owner.type === "local_speaker").length,
    unknownOwners: attributions.filter((item) => item.owner.type === "unknown").length,
    individualMemories: attributions.filter((item) => item.scope === "individual").length,
    sharedMemories: attributions.filter((item) => item.scope === "shared").length,
    unknownScopeMemories: attributions.filter((item) => item.scope === "unknown").length,
    speakerDerived: attributions.filter((item) => item.owner.source === "speaker_identity").length,
    manualDerived: attributions.filter((item) => item.owner.source === "manual_mapping").length,
    explicitDerived: attributions.filter((item) => item.owner.source === "explicit_statement").length,
    records: attributions.map((item) => ({
      memoryId: item.memoryId,
      memoryType: item.memoryType,
      ownerType: item.owner.type,
      scope: item.scope,
      confidence: item.owner.confidence,
      source: item.owner.source,
      evidenceSegmentIds: item.evidenceSegmentIds,
      participantCount: item.participants.length,
      reasons: item.reasons
    }))
  });
  return { attributions, audit };
}
