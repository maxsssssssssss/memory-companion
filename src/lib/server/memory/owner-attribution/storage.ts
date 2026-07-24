import { createHash } from "node:crypto";
import { z } from "zod";
import { MemoryItemTypeSchema, type MemoryItemType } from "../types";
import {
  MemoryOwnerAttributionSchema,
  MemoryOwnerMetadataSchema,
  MemoryOwnerResolutionReasonSchema,
  MemoryOwnershipScopeSchema,
  MemoryParticipantAttributionSchema,
  type MemoryOwnerAttribution,
  type MemoryOwnerMetadata,
  type MemoryOwnerResolution,
  type MemoryParticipantAttribution
} from "./types";

const RecordIdSchema = z.string().trim().min(1).max(512);

export const PersistedMemoryOwnerObservationSchema = z.object({
  id: RecordIdSchema,
  memoryId: RecordIdSchema,
  uploadId: RecordIdSchema,
  memoryType: MemoryItemTypeSchema,
  scope: MemoryOwnershipScopeSchema,
  owner: MemoryOwnerAttributionSchema,
  participants: z.array(MemoryParticipantAttributionSchema),
  evidenceSegmentIds: z.array(RecordIdSchema),
  reasons: z.array(MemoryOwnerResolutionReasonSchema).min(1),
  createdAt: z.string().datetime()
}).strict();

export type PersistedMemoryOwnerObservation = z.infer<typeof PersistedMemoryOwnerObservationSchema>;

function attributionKey(attribution: MemoryOwnerAttribution) {
  return attribution.type === "unknown"
    ? null
    : `${attribution.type}\u001f${attribution.identityId}`;
}

function unknownOwner(): MemoryOwnerAttribution {
  return { type: "unknown", confidence: 0, source: "unknown" };
}

function observationId(input: {
  uploadId: string;
  originalMemoryId: string;
  evidenceSegmentIds: string[];
}) {
  const digest = createHash("sha256")
    .update([
      input.uploadId,
      input.originalMemoryId,
      ...[...input.evidenceSegmentIds].sort()
    ].join("\u001f"))
    .digest("hex")
    .slice(0, 32);
  return `memory_owner_${digest}`;
}

function supportedOwner(input: {
  owner: MemoryOwnerAttribution;
  participants: MemoryParticipantAttribution[];
}) {
  const key = attributionKey(input.owner);
  if (!key) return input.owner;
  const supported = input.participants.some((participant) =>
    (participant.role === "owner" || participant.role === "actor") &&
    attributionKey(participant.attribution) === key &&
    participant.evidenceSegmentIds.length > 0
  );
  return supported ? input.owner : unknownOwner();
}

export function createPersistedMemoryOwnerObservation(input: {
  uploadId: string;
  resolution: MemoryOwnerResolution;
  allowedEvidenceSegmentIds: ReadonlySet<string>;
  createdAt: string;
}): PersistedMemoryOwnerObservation | null {
  const evidenceSegmentIds = input.resolution.evidenceSegmentIds
    .filter((segmentId) => input.allowedEvidenceSegmentIds.has(segmentId));
  if (evidenceSegmentIds.length === 0) return null;

  const participants = input.resolution.participants.flatMap((participant) => {
    const supportedIds = participant.evidenceSegmentIds
      .filter((segmentId) => input.allowedEvidenceSegmentIds.has(segmentId));
    return supportedIds.length > 0 ? [{ ...participant, evidenceSegmentIds: supportedIds }] : [];
  });
  const owner = supportedOwner({ owner: input.resolution.owner, participants });
  const scope = input.resolution.scope === "individual" && owner.type === "unknown"
    ? "unknown"
    : input.resolution.scope;

  return PersistedMemoryOwnerObservationSchema.parse({
    id: observationId({
      uploadId: input.uploadId,
      originalMemoryId: input.resolution.memoryId,
      evidenceSegmentIds
    }),
    memoryId: input.resolution.memoryId,
    uploadId: input.uploadId,
    memoryType: input.resolution.memoryType,
    scope,
    owner,
    participants,
    evidenceSegmentIds,
    reasons: input.resolution.reasons,
    createdAt: input.createdAt
  });
}

function sourcePriority(source: MemoryOwnerAttribution["source"]) {
  if (source === "explicit_statement") return 3;
  if (source === "manual_mapping") return 2;
  if (source === "speaker_identity") return 1;
  return 0;
}

function mergeAttributions(items: MemoryOwnerAttribution[]) {
  const first = items[0];
  if (!first) return unknownOwner();
  return MemoryOwnerAttributionSchema.parse({
    ...first,
    confidence: Math.min(...items.map((item) => item.confidence)),
    source: [...items].sort(
      (left, right) => sourcePriority(right.source) - sourcePriority(left.source)
    )[0].source
  });
}

function mergeParticipants(observations: PersistedMemoryOwnerObservation[]) {
  const groups = new Map<string, MemoryParticipantAttribution[]>();
  for (const participant of observations.flatMap((item) => item.participants)) {
    const key = `${participant.role}\u001f${attributionKey(participant.attribution)}`;
    const group = groups.get(key) ?? [];
    group.push(participant);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => MemoryParticipantAttributionSchema.parse({
    role: group[0].role,
    attribution: mergeAttributions(group.map((item) => item.attribution)),
    evidenceSegmentIds: [...new Set(group.flatMap((item) => item.evidenceSegmentIds))].sort()
  })).sort((left, right) =>
    left.role.localeCompare(right.role) ||
    (left.attribution.identityId ?? "").localeCompare(right.attribution.identityId ?? "")
  );
}

export function aggregateMemoryOwnerObservations(input: {
  memoryId: string;
  memoryType: MemoryItemType;
  observations: PersistedMemoryOwnerObservation[];
}): MemoryOwnerMetadata | undefined {
  const observations = input.observations.filter((item) => item.memoryId === input.memoryId);
  if (observations.length === 0) return undefined;
  const participants = mergeParticipants(observations);
  const shared = observations.some((item) => item.scope === "shared");
  const ownerGroups = new Map<string, MemoryOwnerAttribution[]>();
  for (const observation of observations) {
    const key = attributionKey(observation.owner);
    if (!key) continue;
    const group = ownerGroups.get(key) ?? [];
    group.push(observation.owner);
    ownerGroups.set(key, group);
  }
  const owner = !shared && ownerGroups.size === 1
    ? mergeAttributions([...ownerGroups.values()][0])
    : unknownOwner();
  const scope = shared ? "shared" : owner.type === "unknown" ? "unknown" : "individual";

  return MemoryOwnerMetadataSchema.parse({
    version: 1,
    memoryId: input.memoryId,
    memoryType: input.memoryType,
    scope,
    owner,
    participants,
    evidenceSegmentIds: [...new Set(observations.flatMap((item) => item.evidenceSegmentIds))].sort(),
    reasons: [...new Set(observations.flatMap((item) => item.reasons))]
  });
}

export function filterMemoryOwnerMetadataByEvidence(
  metadata: MemoryOwnerMetadata,
  allowedEvidenceSegmentIds: ReadonlySet<string>
) {
  const evidenceSegmentIds = metadata.evidenceSegmentIds
    .filter((segmentId) => allowedEvidenceSegmentIds.has(segmentId));
  if (evidenceSegmentIds.length === 0) return undefined;

  const participants = metadata.participants.flatMap((participant) => {
    const supportedIds = participant.evidenceSegmentIds
      .filter((segmentId) => allowedEvidenceSegmentIds.has(segmentId));
    return supportedIds.length > 0 ? [{ ...participant, evidenceSegmentIds: supportedIds }] : [];
  });
  const owner = supportedOwner({ owner: metadata.owner, participants });
  const scope = metadata.scope === "shared"
    ? "shared"
    : owner.type === "unknown"
      ? "unknown"
      : "individual";

  return MemoryOwnerMetadataSchema.parse({
    ...metadata,
    scope,
    owner,
    participants,
    evidenceSegmentIds
  });
}

export function rekeyMemoryOwnerObservations(
  observations: PersistedMemoryOwnerObservation[],
  memoryId: string
) {
  return observations.map((observation) => PersistedMemoryOwnerObservationSchema.parse({
    ...observation,
    memoryId
  }));
}

export function memoryOwnerMergeCompatible(
  memoryType: MemoryItemType,
  primary: MemoryOwnerMetadata | undefined,
  incoming: MemoryOwnerMetadata | undefined
) {
  if (
    memoryType !== "preference" &&
    memoryType !== "commitment" &&
    memoryType !== "event" &&
    memoryType !== "relationship_signal"
  ) return true;
  if (!primary && !incoming) return true;
  if (!primary || !incoming) return false;
  if (memoryType === "event" || memoryType === "relationship_signal") {
    if (primary.scope !== incoming.scope) return false;
    const participantKeys = (metadata: MemoryOwnerMetadata) => new Set(
      metadata.participants.flatMap((participant) => {
        const key = attributionKey(participant.attribution);
        return key ? [key] : [];
      })
    );
    const primaryParticipants = participantKeys(primary);
    const incomingParticipants = participantKeys(incoming);
    return primaryParticipants.size > 0 &&
      primaryParticipants.size === incomingParticipants.size &&
      [...primaryParticipants].every((key) => incomingParticipants.has(key));
  }
  const primaryKey = attributionKey(primary.owner);
  const incomingKey = attributionKey(incoming.owner);
  return primary.scope === "individual" &&
    incoming.scope === "individual" &&
    primaryKey !== null &&
    primaryKey === incomingKey;
}
