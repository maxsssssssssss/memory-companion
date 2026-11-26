import type { DayPayload } from "./day-payload";
import type { DcInteractionRead } from "./date-companion-stage2";
import { dateCompanionParticipantKey, dateCompanionReadingSpeakerRole } from "./date-companion-speaker";
import type { TranscriptSegment } from "./types";

type RecordingMaterials = Pick<DayPayload, "segments" | "audioInsights" | "briefItems" | "semanticSegments" | "relationshipSignals">;

/** Keep the raw local recording intact. This projection belongs only to single-recording QA. */
export function recordingQaReviewedMaterials(record: DcInteractionRead | null | undefined, input: RecordingMaterials) {
  const changed = new Set<string>();
  const reviewed = new Map<string, "self" | "companion">();
  const groups = new Set(record?.participants.filter(p => p.reviewedSegments !== undefined).map(p => p.speakerId));
  if (!record || !groups.size) return { materials: input, reviewed };
  const wholeGroups = new Set(record.participants.filter(p => p.reviewedSegments === undefined).map(p => p.speakerId));
  const items = "recapItems" in record ? record.recapItems : record.promiseRecapItems;
  const mixedIds = new Set(items.flatMap(item => item.evidence.filter(e => e.speakerId && groups.has(e.speakerId)).map(e => e.sourceSegmentId)));
  const segments: TranscriptSegment[] = [];
  for (const line of input.segments) {
    const speakerId = dateCompanionParticipantKey(line);
    if (!mixedIds.has(line.id) && speakerId && wholeGroups.has(speakerId)) {
      segments.push(line);
      continue;
    }
    changed.add(line.id);
    if (!speakerId || !groups.has(speakerId)) continue;
    const role = dateCompanionReadingSpeakerRole(record, {
      uploadId: line.uploadId, speakerId, segmentIds: [line.id], quote: line.text,
      startSeconds: line.startSeconds, endSeconds: line.endSeconds
    });
    if (!role) continue;
    reviewed.set(line.id, role);
    // The ASR identity and derived notes predate the user's correction.
    segments.push({ ...line, identity: undefined, speaker: role === "self" ? "我" : "Ta" });
  }
  const unchanged = (ids: readonly string[]) => ids.length > 0 && ids.every(id => !changed.has(id) && !mixedIds.has(id));
  const audioInsights = input.audioInsights.filter(insight => unchanged(insight.sourceSegmentIds)
    && (insight.emotionEvidence ?? []).every(evidence => unchanged(evidence.sourceSegmentIds)));
  const soundIds = new Set(audioInsights.map(insight => insight.id));
  const semanticSegments = input.semanticSegments.filter(segment => unchanged(segment.sourceSegmentIds));
  const interpretationIds = new Set([...soundIds, ...semanticSegments.map(s => s.id)]);
  return { reviewed, materials: {
    segments, audioInsights,
    semanticSegments,
    briefItems: input.briefItems.filter(item => unchanged(item.sourceSegmentIds)),
    relationshipSignals: input.relationshipSignals.filter(card => unchanged(card.evidenceSegments.map(s => s.segmentId))
      && (card.acousticEvidence ?? []).every(e => soundIds.has(e.audioInsightId))
      && (card.interactionEvidence ?? []).every(e => interpretationIds.has(e.sourceId)))
  } };
}

export function recordingQaSegmentRevision(segment: TranscriptSegment, reviewedRole?: "self" | "companion") {
  const fields: (string | number | undefined)[] = [
    segment.uploadId, segment.id, segment.text, segment.speaker, segment.startSeconds, segment.endSeconds
  ];
  if (reviewedRole) fields.push("date_companion_reviewed_segment_v1", reviewedRole);
  return JSON.stringify(fields);
}
