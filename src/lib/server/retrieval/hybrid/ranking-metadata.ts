import type { TranscriptSegment } from "@/lib/domain/types";
import type {
  MemoryIndexQaContext
} from "@/lib/server/retrieval/memory-index-evidence";
import type { QaRetrievedEvidence } from "@/lib/server/retrieval/ai-qa";
import type {
  EvidenceRankingMetadata,
  HybridMemoryType
} from "./types";

function dateFromEvidence(evidence: QaRetrievedEvidence) {
  return evidence.relationshipSignal?.recordingDate ??
    /\[?(\d{4}-\d{2}-\d{2})\]?/u.exec(
      `${evidence.title}\n${evidence.text}`
    )?.[1];
}
function preferredMemoryStatus(
  memories: NonNullable<MemoryIndexQaContext["memories"]>
) {
  if (memories.some((memory) => memory.status === "resolved")) return "resolved" as const;
  if (memories.some((memory) => memory.status === "active")) return "active" as const;
  if (memories.some((memory) => memory.status === "superseded")) return "superseded" as const;
  return memories.some((memory) => memory.status === "expired")
    ? "expired" as const
    : undefined;
}

export function buildHybridEvidenceRankingMetadata(input: {
  evidence: readonly QaRetrievedEvidence[];
  segments: readonly TranscriptSegment[];
  memoryContext?: MemoryIndexQaContext;
}) {
  const segmentById = new Map(input.segments.map((segment) => [segment.id, segment]));
  const memoriesBySourceId = new Map<string, MemoryIndexQaContext["memories"]>();
  for (const memory of input.memoryContext?.memories ?? []) {
    for (const sourceId of memory.evidence.map((item) => item.sourceId)) {
      const current = memoriesBySourceId.get(sourceId) ?? [];
      current.push(memory);
      memoriesBySourceId.set(sourceId, current);
    }
  }
  const ownersByMemoryId = new Map(
    (input.memoryContext?.ownerAttributions ?? []).map((metadata) => [
      metadata.memoryId,
      [
        ...(metadata.owner.identityId ? [metadata.owner.identityId] : []),
        ...metadata.participants.flatMap((participant) =>
          participant.attribution.identityId
            ? [participant.attribution.identityId]
            : []
        )
      ]
    ])
  );
  const result = new Map<string, EvidenceRankingMetadata>();
  for (const evidence of input.evidence) {
    const sourceSegments = evidence.sourceSegmentIds.flatMap((sourceId) => {
      const segment = segmentById.get(sourceId);
      return segment ? [segment] : [];
    });
    const firstSource = sourceSegments[0];
    const memories = [...new Map(
      [evidence.id, ...evidence.sourceSegmentIds]
        .flatMap((sourceId) => memoriesBySourceId.get(sourceId) ?? [])
        .map((memory) => [memory.id, memory])
    ).values()];
    const memoryTypes = [...new Set(
      memories.map((memory) => memory.type)
    )] as HybridMemoryType[];
    const speakers = [...new Set(sourceSegments.flatMap((segment) => [
      ...(segment.speaker ? [segment.speaker] : []),
      ...(segment.identity?.globalSpeakerId
        ? [segment.identity.globalSpeakerId]
        : []),
      ...(segment.identity?.displayName ? [segment.identity.displayName] : [])
    ]))];
    const owners = [...new Set(memories.flatMap((memory) =>
      ownersByMemoryId.get(memory.id) ?? []
    ))];
    const entities = [
      ...`${evidence.title} ${evidence.text}`.matchAll(
        /\b[A-Z][A-Za-z0-9_-]{1,31}\b/gu
      )
    ].map((match) => match[0]);
    const status = preferredMemoryStatus(memories);
    result.set(evidence.id, {
      ...(dateFromEvidence(evidence)
        ? { recordingDate: dateFromEvidence(evidence) }
        : {}),
      ...(firstSource?.uploadId ? { recordingId: firstSource.uploadId } : {}),
      ...(firstSource ? { segmentOrder: firstSource.startSeconds } : {}),
      ...(entities.length > 0 ? { entities: [...new Set(entities)] } : {}),
      ...(speakers.length > 0
        ? { speakers, entityAliases: speakers }
        : {}),
      ...(owners.length > 0 ? { owners } : {}),
      relationshipSourceValid:
        evidence.sourceSegmentIds.length > 0 &&
        sourceSegments.length === evidence.sourceSegmentIds.length,
      ...(memoryTypes[0] ? { memoryType: memoryTypes[0], memoryTypes } : {}),
      ...(status ? { memoryStatus: status } : {}),
      ...(memories.length > 0
        ? {
            occurrenceCount: Math.max(
              ...memories.map((memory) => memory.occurrenceCount)
            ),
            distinctDates: Math.max(
              ...memories.map((memory) =>
                new Set(memory.evidence.map((item) => item.date)).size
              )
            ),
            importanceScore: Math.max(
              ...memories.map((memory) => memory.importanceScore)
            )
          }
        : {})
    });
  }
  return result;
}
