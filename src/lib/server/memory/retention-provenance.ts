import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  AudioUploadSchema,
  TranscriptSegmentSchema
} from "@/lib/domain/types";
import type { JsonStore } from "@/lib/server/storage/json-store";

export class RetainedMemoryProvenanceError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function normalizeText(value: string) {
  return value.normalize("NFKC").replace(/\r\n?/gu, "\n").replace(/\s+/gu, " ").trim();
}

export function dateCompanionRetainedEvidenceDigest(input: {
  userId: string;
  uploadId: string;
  sourceSegmentId: string;
  startSeconds: number;
  endSeconds: number;
  speakerId?: string | null;
  quote: string;
}) {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    sourceKind: "transcript",
    origin: "date_companion_retention",
    userId: input.userId,
    uploadId: input.uploadId,
    sourceSegmentId: input.sourceSegmentId,
    startSeconds: input.startSeconds,
    endSeconds: input.endSeconds,
    speakerId: input.speakerId?.normalize("NFKC").trim() || null,
    quote: normalizeText(input.quote)
  })).digest("hex");
}

export async function captureRetainedMemoryEvidenceProvenance(input: {
  database: Database.Database;
  store: Pick<JsonStore, "read">;
  userId: string;
  uploadId: string;
  relationshipId: string;
  interactionId: string;
  now?: string;
}) {
  const uploadResult = AudioUploadSchema.safeParse(
    await input.store.read<unknown>("uploads", input.uploadId)
  );
  if (!uploadResult.success || uploadResult.data.id !== input.uploadId) {
    throw new RetainedMemoryProvenanceError("retained_upload_invalid");
  }
  if (uploadResult.data.status !== "ready") {
    throw new RetainedMemoryProvenanceError("retained_upload_not_ready");
  }
  const segmentsResult = z.array(TranscriptSegmentSchema).safeParse(
    await input.store.read<unknown>("segments", input.uploadId)
  );
  if (!segmentsResult.success) {
    throw new RetainedMemoryProvenanceError("retained_segments_invalid");
  }
  const segmentById = new Map(segmentsResult.data.map((segment) => [segment.id, segment]));
  const evidenceRows = input.database.prepare(`
    SELECT e.id, e.source_type, e.source_id, e.upload_id, e.date, e.quote
    FROM memory_evidence e
    INNER JOIN memory_items m ON m.id = e.memory_id
    WHERE m.user_id = ? AND e.upload_id = ? AND e.source_type = 'transcript'
    ORDER BY e.id
  `).all(input.userId, input.uploadId) as Array<{
    id: string;
    source_type: string;
    source_id: string;
    upload_id: string;
    date: string;
    quote: string;
  }>;
  const prepared = evidenceRows.map((evidence) => {
    const segment = segmentById.get(evidence.source_id);
    if (!segment || segment.uploadId !== input.uploadId || evidence.upload_id !== input.uploadId) {
      throw new RetainedMemoryProvenanceError("retained_evidence_segment_mismatch");
    }
    if (evidence.date !== uploadResult.data.recordingDate) {
      throw new RetainedMemoryProvenanceError("retained_evidence_date_mismatch");
    }
    const quote = normalizeText(evidence.quote);
    if (!quote || !normalizeText(segment.text).includes(quote)) {
      throw new RetainedMemoryProvenanceError("retained_evidence_quote_mismatch");
    }
    return {
      evidence,
      segment,
      digest: dateCompanionRetainedEvidenceDigest({
        userId: input.userId,
        uploadId: input.uploadId,
        sourceSegmentId: segment.id,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        speakerId: segment.speaker,
        quote: evidence.quote
      })
    };
  });
  const aggregateDigest = createHash("sha256")
    .update(prepared.map((item) => `${item.evidence.id}:${item.digest}`).join("\n"))
    .digest("hex");
  const now = input.now ?? new Date().toISOString();

  input.database.transaction(() => {
    const insert = input.database.prepare(`
      INSERT INTO memory_evidence_provenance (
        memory_evidence_id, user_id, upload_id, source_segment_id,
        start_seconds, end_seconds, speaker_id, source_kind, origin,
        content_digest, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'transcript', 'date_companion_retention', ?, ?)
      ON CONFLICT(memory_evidence_id) DO NOTHING
    `);
    for (const item of prepared) {
      const existing = input.database.prepare(`
        SELECT user_id, upload_id, source_segment_id, content_digest
        FROM memory_evidence_provenance WHERE memory_evidence_id = ?
      `).get(item.evidence.id) as {
        user_id: string;
        upload_id: string;
        source_segment_id: string;
        content_digest: string;
      } | undefined;
      if (existing && (
        existing.user_id !== input.userId
        || existing.upload_id !== input.uploadId
        || existing.source_segment_id !== item.segment.id
        || existing.content_digest !== item.digest
      )) {
        throw new RetainedMemoryProvenanceError("retained_provenance_conflict");
      }
      insert.run(
        item.evidence.id,
        input.userId,
        input.uploadId,
        item.segment.id,
        item.segment.startSeconds,
        item.segment.endSeconds,
        item.segment.speaker ?? null,
        item.digest,
        now
      );
    }
    const existingUpload = input.database.prepare(`
      SELECT dc_relationship_id, dc_interaction_id, provenance_count, provenance_digest, status
      FROM dc_retained_uploads WHERE user_id = ? AND upload_id = ?
    `).get(input.userId, input.uploadId) as {
      dc_relationship_id: string;
      dc_interaction_id: string;
      provenance_count: number;
      provenance_digest: string;
      status: string;
    } | undefined;
    if (existingUpload && (
      existingUpload.dc_relationship_id !== input.relationshipId
      || existingUpload.dc_interaction_id !== input.interactionId
      || existingUpload.provenance_count !== prepared.length
      || existingUpload.provenance_digest !== aggregateDigest
      || existingUpload.status !== "active"
    )) {
      throw new RetainedMemoryProvenanceError("retained_upload_conflict");
    }
    input.database.prepare(`
      INSERT INTO dc_retained_uploads (
        user_id, upload_id, dc_relationship_id, dc_interaction_id,
        provenance_count, provenance_digest, status, captured_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(user_id, upload_id) DO NOTHING
    `).run(
      input.userId,
      input.uploadId,
      input.relationshipId,
      input.interactionId,
      prepared.length,
      aggregateDigest,
      now,
      now
    );
  })();
  return { provenanceCount: prepared.length, provenanceDigest: aggregateDigest };
}

export function hasRetainedMemoryProvenance(
  database: Database.Database,
  userId: string,
  uploadId: string
) {
  return Boolean(database.prepare(`
    SELECT 1 FROM dc_retained_uploads
    WHERE user_id = ? AND upload_id = ? AND status = 'active'
  `).get(userId, uploadId));
}
