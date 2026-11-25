import type Database from "better-sqlite3";
import { buildTranscriptChunkId } from "@/lib/domain/chunks/transcript-chunk";
import { dateCompanionParticipantKey } from "@/lib/domain/date-companion-speaker";
import { mapUnquotedQaText } from "@/lib/domain/qa-citation-text";
import { stableUnknownSpeakerId } from "../speaker-identity/matching";
import { dateCompanionEvidenceDigest } from "./memory-bridge-digest";

type Source = {
  uploadId: string;
  sourceSegmentId: string;
  startSeconds: number;
  endSeconds: number;
  speakerId: string | null;
  quote: string;
  contentDigest: string | null;
  role: string | null;
};

function matchesLocalSpeaker(source: Source, label: string) {
  if (source.speakerId === label || source.speakerId === dateCompanionParticipantKey({ id: source.sourceSegmentId, speaker: label })) return true;
  // The ASR keeps anonymous IDs local to their recording and chunk. Verify that
  // specific derivation before projecting a human-reviewed role in older material.
  if (!source.sourceSegmentId.startsWith(source.uploadId + "_chunk_")) return false;
  const chunk = /^_chunk_(\d{5})_seg_\d+$/u.exec(source.sourceSegmentId.slice(source.uploadId.length));
  if (!chunk) return false;
  const globalSpeakerId = stableUnknownSpeakerId({
    uploadId: source.uploadId, chunkId: buildTranscriptChunkId(source.uploadId, Number(chunk[1])), localSpeaker: label
  });
  return source.speakerId === dateCompanionParticipantKey({
    id: source.sourceSegmentId, speaker: label,
    identity: { globalSpeakerId, identityType: "unknown_person", confidence: 0, source: "cross_chunk_matching" }
  });
}

/** Only model prose is projected. The raw proposal, snapshots and user's text remain separately available. */
export function displayedRecapText(database: Database.Database, userId: string, itemId: string, proposed: string, edited: string | null) {
  if (edited !== null || !/\bspeaker_\d+\b/u.test(proposed)) return edited ?? proposed;
  const sources = database.prepare(`
    SELECT e.upload_id AS uploadId, e.source_segment_id AS sourceSegmentId, e.quote,
           e.start_seconds AS startSeconds, e.end_seconds AS endSeconds,
           e.speaker_id AS speakerId, e.content_digest AS contentDigest,
           CASE WHEN e.upload_id=i.source_upload_id AND i.source_state<>'explicitly_deleted'
                  AND v.confirmed_at IS NOT NULL AND v.confirmed_by=e.user_id THEN v.role END AS role
    FROM dc_evidence_snapshots e JOIN dc_recap_items r ON r.id=e.recap_item_id AND r.user_id=e.user_id
    JOIN dc_interactions i ON i.id=r.interaction_id AND i.user_id=r.user_id
    LEFT JOIN dc_evidence_speaker_reviews v ON v.evidence_id=e.id AND v.user_id=e.user_id
    WHERE e.user_id=? AND e.recap_item_id=?
  `).all(userId, itemId) as Source[];
  return reviewedSpeakerText(userId, proposed, sources);
}

/** A saved promise may itself be a verbatim quote or have different wording from its recap. */
export function displayedPromiseText(database: Database.Database, userId: string, itemId: string, text: string, proposed: string, edited: string | null) {
  return edited === null && text === proposed ? displayedRecapText(database, userId, itemId, text, null) : text;
}

/** Only use evidence available to this particular reader (or selected for this grant). */
export function reviewedSpeakerText(userId: string, proposed: string, sources: Source[]) {
  if (!/\bspeaker_\d+\b/u.test(proposed) || sources.some(source => source.quote.trim() === proposed.trim())) return proposed;
  return mapUnquotedQaText(proposed, part => part.replace(/\b(speaker_\d+)\b(?:[ \t]+(?=\p{Script=Han}))?/gu, (_, label: string) => {
    const roles = new Set(sources.filter(source => matchesLocalSpeaker(source, label)).map(source =>
      source.contentDigest === dateCompanionEvidenceDigest({ userId, ...source }) ? source.role : null
    ));
    if (roles.size === 1 && roles.has("self")) return "我";
    if (roles.size === 1 && roles.has("companion")) return "Ta";
    return "说话人";
  }));
}
