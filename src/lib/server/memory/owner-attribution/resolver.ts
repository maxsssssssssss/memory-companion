import type { TranscriptSegment } from "@/lib/domain/types";
import { trustedTranscriptSpeakerIdentity } from "@/lib/domain/speaker-identity";
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
  /我(?:自己)?[^，。！？；,.!?;\n]{0,18}(?:(?:答应|承诺|保证|负责|准备|打算|计划|愿意)|(?:会|将|要)[^，。！？；,.!?;\n]{0,12}(?:联系|回复|发送|通知|确认|完成|提交|检查|查询|预约|处理|安排|跟进|解决|陪|帮|去|来|做|参加|见面)|(?:今晚|明天|后天|下周|下次|周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}(?:点|时|[:：]\d{1,2}))[^，。！？；,.!?;\n]{0,12}(?:联系|回复|发送|通知|确认|完成|提交|检查|查询|预约|处理|安排|跟进|解决|陪|帮|去|来|做|参加|见面)|promise|will\b[^，。！？；,.!?;\n]{0,12}(?:contact|reply|send|confirm|complete|submit|check|book|help|attend|meet))/iu;
const NEGATED_SELF_COMMITMENT_PATTERN =
  /我(?:自己)?[^，。！？；,.!?;\n]{0,18}(?:没有|没(?:有)?|不(?:会|再|打算|准备|愿意|负责)?|拒绝|取消(?:了)?|撤回(?:了)?)[^，。！？；,.!?;\n]{0,18}(?:答应|承诺|约定|说好|保证|会|将|要|负责|准备|打算|计划|愿意|陪|帮|联系|回复|发送|通知|确认|完成|提交|检查|查询|预约|处理|安排|跟进|解决|去|来|做|参加|见面)/iu;
const THIRD_PERSON_COMMITMENT_PATTERN =
  /(?:她|他|对方|伴侣|朋友|家人|partner|they|she|he)[^，。！？；,.!?;\n]{0,18}(?:会|将|要|答应|承诺|保证|负责|准备|打算|计划|愿意|陪|帮|发送|通知|确认|完成|promise|will)/iu;
const SHARED_CONTEXT_PATTERN = /我们|咱们|双方|一起|共同|两个人|彼此|both of us|together/iu;
const NEGATED_SHARED_CONTEXT_PATTERN =
  /(?:不(?:会|要|能|再)?|并非|并不|没有|避免)[^，。！？；,.!?;\n]{0,18}(?:一起|共同|双方|彼此|both of us|together)/iu;
const SECOND_PERSON_PATTERN = /你|您|your?|you/iu;

const unknownOwner = (): MemoryOwnerAttribution => MemoryOwnerAttributionSchema.parse({
  type: "unknown",
  confidence: 0,
  source: "unknown"
});

function hasSharedContext(value: string) {
  const normalized = value.normalize("NFKC");
  return SHARED_CONTEXT_PATTERN.test(normalized) && !NEGATED_SHARED_CONTEXT_PATTERN.test(normalized);
}

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
    if (hasSharedContext(normalized)) return "shared_statement";
    if (SELF_PREFERENCE_PATTERN.test(normalized)) return "self_statement";
  }
  if (memoryType === "commitment") {
    if (THIRD_PERSON_COMMITMENT_PATTERN.test(normalized)) return "third_person_reference";
    if (NEGATED_SELF_COMMITMENT_PATTERN.test(normalized)) return "other";
    if (SELF_COMMITMENT_PATTERN.test(normalized)) return "self_statement";
    if (hasSharedContext(normalized)) return "shared_statement";
  }
  if (
    (memoryType === "event" || memoryType === "relationship_signal") &&
    hasSharedContext(normalized)
  ) {
    return "shared_statement";
  }
  return "other";
}

function identityAttribution(
  segment: TranscriptSegment,
  allowManualMappingIdentity = false
): {
  attribution: MemoryOwnerAttribution;
  reason: MemoryOwnerObservation["reason"];
} {
  const identity = segment.identity;
  if (!identity) {
    return { attribution: unknownOwner(), reason: "identity_missing" };
  }
  const trustedIdentity = allowManualMappingIdentity
    && identity.identityType !== "unknown_person"
    && identity.source === "manual_mapping"
    && identity.confidence === 1
    ? identity
    : trustedTranscriptSpeakerIdentity(segment, MIN_OWNER_IDENTITY_CONFIDENCE);
  if (!trustedIdentity) {
    return {
      attribution: unknownOwner(),
      reason: trustedTranscriptSpeakerIdentity(segment, 0)
        ? "identity_below_threshold"
        : "identity_not_provider_verified"
    };
  }

  return {
    attribution: MemoryOwnerAttributionSchema.parse({
      type: "known_identity",
      identityId: trustedIdentity.globalSpeakerId,
      // Memory schema requires an attribution confidence. For exact
      // Provider-label evidence this is categorical attribution certainty,
      // not an acoustic or similarity score.
      confidence: trustedIdentity.confidence ?? 1,
      source: trustedIdentity.source === "manual_mapping"
        ? "manual_mapping"
        : "speaker_identity"
    }),
    reason: "trusted_speaker_identity"
  };
}

function observationForSegment(
  memoryType: ResolveMemoryOwnerAttributionInput["memoryType"],
  segment: TranscriptSegment,
  allowManualMappingIdentity = false
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

  const identity = identityAttribution(segment, allowManualMappingIdentity);
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
  included?: (segment: TranscriptSegment) => boolean,
  allowManualMappingIdentity = false
) {
  return groupedAttributions(
    segments.flatMap((segment) => {
      if (included && !included(segment)) return [];
      const resolved = identityAttribution(segment, allowManualMappingIdentity).attribution;
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
  allowSpeakerFallback?: boolean;
}) {
  const ownerCandidates = explicitOwnerGroups(input.observations);
  const hasThirdPersonReference = input.observations.some(
    (observation) => observation.statementKind === "third_person_reference"
  );
  if (ownerCandidates.length > 0 && hasThirdPersonReference) {
    return {
      owner: unknownOwner(),
      reason: "ambiguous_owner" as const
    };
  }
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
  if (hasThirdPersonReference) {
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
  if (input.allowSpeakerFallback === false) {
    return {
      owner: unknownOwner(),
      reason: "no_trusted_identity" as const
    };
  }
  const speakerCandidates = trustedIdentityGroups(
    input.segments,
    undefined,
    input.input.allowManualMappingIdentity
  );
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
  const resolved = ownerResolution({
    ...input,
    allowSpeakerFallback: false
  });
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
  const receivers = trustedIdentityGroups(
    input.segments,
    undefined,
    input.input.allowManualMappingIdentity
  ).filter(
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

function eventResolution(segments: TranscriptSegment[], allowManualMappingIdentity = false) {
  const shared = segments.some((segment) => hasSharedContext(segment.text));
  // Event memories do not claim that the speaker owns the event. Keep every
  // verified evidence speaker as a participant so subjectless completion
  // statements remain admissible without inventing an owner.
  const groups = trustedIdentityGroups(segments, undefined, allowManualMappingIdentity);
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

function relationshipResolution(segments: TranscriptSegment[], allowManualMappingIdentity = false) {
  const groups = trustedIdentityGroups(segments, undefined, allowManualMappingIdentity);
  const shared =
    groups.length >= 2 ||
    segments.some((segment) => hasSharedContext(segment.text));
  return {
    scope: shared ? "shared" as const : "unknown" as const,
    owner: unknownOwner(),
    participants: groups.map((group) => participant("participant", group)),
    reasons: [shared ? "shared_context" as const : "owner_not_applicable" as const]
  };
}

function nonOwnerResolution(segments: TranscriptSegment[], allowManualMappingIdentity = false) {
  const groups = trustedIdentityGroups(segments, undefined, allowManualMappingIdentity);
  return {
    scope:
      groups.length === 1
        ? "individual" as const
        : groups.length > 1
          ? "shared" as const
          : "unknown" as const,
    owner: unknownOwner(),
    participants: groups.map((group) => participant("participant", group)),
    reasons: [
      groups.length === 1
        ? "individual_participant" as const
        : groups.length > 1
          ? "shared_context" as const
          : "owner_not_applicable" as const
    ]
  };
}

export function resolveMemoryOwnerAttribution(
  input: ResolveMemoryOwnerAttributionInput
): MemoryOwnerResolution {
  const segments = orderedSegments(input.evidenceSegments);
  const observations = segments.map((segment) => observationForSegment(
    input.memoryType,
    segment,
    input.allowManualMappingIdentity
  ));
  const resolved = input.memoryType === "preference"
    ? preferenceResolution({ input, segments, observations })
    : input.memoryType === "commitment"
      ? commitmentResolution({ input, segments, observations })
      : input.memoryType === "event"
        ? eventResolution(segments, input.allowManualMappingIdentity)
        : input.memoryType === "relationship_signal"
          ? relationshipResolution(segments, input.allowManualMappingIdentity)
          : nonOwnerResolution(segments, input.allowManualMappingIdentity);

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
  return {
    attributions,
    audit: auditMemoryOwnerAttributions(attributions, input.now)
  };
}

export function auditMemoryOwnerAttributions(
  attributions: MemoryOwnerResolution[],
  now?: () => string
) {
  const audit = MemoryOwnerAuditSchema.parse({
    version: 1,
    generatedAt: (now ?? (() => new Date().toISOString()))(),
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
  return audit;
}
