import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

import {
  TranscriptSegmentSchema,
  type TranscriptSegment
} from "@/lib/domain/types";
import { getDateCompanionDatabase } from "@/lib/server/date-companion/db";
import {
  DC_EVIDENCE_PROVENANCE_VERSION,
  DC_EVIDENCE_SOURCE_KIND,
  dateCompanionEvidenceDigest,
  dateCompanionMemoryProjectionIdempotencyKey,
  isDateCompanionMemoryProjectionIdempotencyKey,
  stableBridgeDigest
} from "@/lib/server/date-companion/memory-bridge-digest";
import { getMemoryDatabase } from "@/lib/server/memory/db";
import { dateCompanionRetainedEvidenceDigest } from "@/lib/server/memory/retention-provenance";
import type { PersonEvidence } from "./types";

export type TrustedPersonQaEvidenceResolution = {
  segments: TranscriptSegment[];
  conflictingEvidenceKeys: string[];
  activeSelfPersonId: string | null;
};

export type TrustedPersonQaEvidenceResolver = (input: {
  accountId: string;
  personId: string;
  evidence: readonly PersonEvidence[];
}) => TrustedPersonQaEvidenceResolution;

type MemoryLinkRow = {
  dc_relationship_id: string;
  dc_interaction_id: string;
  dc_evidence_snapshot_id: string;
  snapshot_digest: string;
};

type SnapshotRow = {
  id: string;
  recap_item_id: string;
  upload_id: string;
  source_segment_id: string;
  start_seconds: number;
  end_seconds: number;
  speaker_id: string | null;
  quote: string;
  provenance_version: number;
  source_kind: string;
  content_digest: string | null;
  recap_interaction_id: string;
  recap_disposition: string;
  relationship_id: string;
  source_upload_id: string;
  interaction_status: string;
  source_state: string;
  interaction_version: number;
  confirmation_fingerprint: string | null;
  confirmed_at: string | null;
  relationship_status: string;
  selection_relationship_id: string | null;
  selection_interaction_id: string | null;
  selection_recap_item_id: string | null;
  selection_subject: string | null;
  selection_version: number | null;
  mapping_self_person_id: string | null;
  mapping_companion_person_id: string | null;
  mapping_relationship_type: string | null;
  mapping_status: string | null;
  mapping_version: number | null;
  mapping_confirmed_at: string | null;
  participant_role: string | null;
  participant_confirmed_by: string | null;
  participant_confirmed_at: string | null;
};

type MemoryRelationshipLinkRow = {
  person_relationship_id: string;
  mapping_version: number;
  self_person_id: string;
  companion_person_id: string;
  relationship_type: string;
  status: string;
  person_a_id: string;
  person_b_id: string;
  person_relationship_status: string;
  explicitly_confirmed: number;
  confirmed_at: string | null;
};

type ReceiptRow = {
  id: string;
  idempotency_key: string;
  payload_digest: string;
  dc_outbox_id: string;
  mapping_version: number;
};

type OutboxRow = {
  id: string;
  idempotency_key: string;
  payload_digest: string;
  payload_json: string;
  mapping_version: number | null;
  source_version: number;
  confirmation_fingerprint: string;
  status: string;
  completed_at: string | null;
};

function normalizedText(value: string) {
  return value.normalize("NFKC").replace(/\r\n?/gu, "\n").replace(/\s+/gu, " ").trim();
}

export function personQaEvidenceKey(uploadId: string, sourceSegmentId: string) {
  return `${uploadId.trim()}\u0000${sourceSegmentId.trim()}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function snapshotSignature(snapshot: Pick<
  SnapshotRow,
  | "upload_id"
  | "source_segment_id"
  | "start_seconds"
  | "end_seconds"
  | "speaker_id"
  | "quote"
  | "provenance_version"
  | "source_kind"
  | "content_digest"
>) {
  return JSON.stringify([
    snapshot.upload_id,
    snapshot.source_segment_id,
    snapshot.start_seconds,
    snapshot.end_seconds,
    snapshot.speaker_id?.normalize("NFKC").trim() || null,
    normalizedText(snapshot.quote),
    snapshot.provenance_version,
    snapshot.source_kind,
    snapshot.content_digest
  ]);
}

function snapshotDigestIsValid(accountId: string, snapshot: SnapshotRow) {
  return snapshot.provenance_version === DC_EVIDENCE_PROVENANCE_VERSION
    && snapshot.source_kind === DC_EVIDENCE_SOURCE_KIND
    && isSha256(snapshot.content_digest)
    && snapshot.content_digest === dateCompanionEvidenceDigest({
      userId: accountId,
      uploadId: snapshot.upload_id,
      sourceSegmentId: snapshot.source_segment_id,
      startSeconds: snapshot.start_seconds,
      endSeconds: snapshot.end_seconds,
      speakerId: snapshot.speaker_id,
      quote: snapshot.quote
    });
}

function subjectIncludesPerson(
  subject: string | null,
  personId: string,
  selfPersonId: string,
  companionPersonId: string
) {
  return subject === "both"
    || subject === "self" && personId === selfPersonId
    || subject === "companion" && personId === companionPersonId;
}

function bridgePayloadMatches(input: {
  payloadJson: string;
  payloadDigest: string;
  accountId: string;
  relationshipId: string;
  interactionId: string;
  uploadId: string;
  snapshot: SnapshotRow;
  mapping: MemoryRelationshipLinkRow;
}) {
  let value: unknown;
  try {
    value = JSON.parse(input.payloadJson);
  } catch {
    return false;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (stableBridgeDigest(payload) !== input.payloadDigest) return false;
  const mapping = payload.mapping;
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) return false;
  const mappingValue = mapping as Record<string, unknown>;
  if (
    payload.version !== 1
    || payload.userId !== input.accountId
    || payload.relationshipId !== input.relationshipId
    || payload.interactionId !== input.interactionId
    || payload.sourceUploadId !== input.uploadId
    || mappingValue.version !== input.mapping.mapping_version
    || mappingValue.selfPersonId !== input.mapping.self_person_id
    || mappingValue.companionPersonId !== input.mapping.companion_person_id
    || mappingValue.relationshipType !== input.mapping.relationship_type
    || !Array.isArray(payload.selections)
  ) {
    return false;
  }
  const matchingSelections = payload.selections.filter((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const selection = candidate as Record<string, unknown>;
    return selection.evidenceSnapshotId === input.snapshot.id;
  });
  if (matchingSelections.length !== 1) return false;
  const selection = matchingSelections[0] as Record<string, unknown>;
  return selection.recapItemId === input.snapshot.recap_item_id
    && selection.uploadId === input.snapshot.upload_id
    && selection.sourceSegmentId === input.snapshot.source_segment_id
    && selection.contentDigest === input.snapshot.content_digest
    && selection.subject === input.snapshot.selection_subject;
}

function retainedUploadIsCurrent(input: {
  memoryDatabase: Database.Database;
  accountId: string;
  uploadId: string;
  relationshipId: string;
  interactionId: string;
  snapshot: SnapshotRow;
}) {
  const retained = input.memoryDatabase.prepare(`
    SELECT dc_relationship_id, dc_interaction_id,
           provenance_count, provenance_digest, status
    FROM dc_retained_uploads
    WHERE user_id = ? AND upload_id = ?
  `).get(input.accountId, input.uploadId) as {
    dc_relationship_id: string;
    dc_interaction_id: string;
    provenance_count: number;
    provenance_digest: string;
    status: string;
  } | undefined;
  const provenance = input.memoryDatabase.prepare(`
    SELECT p.memory_evidence_id, p.upload_id, p.source_segment_id,
           p.start_seconds, p.end_seconds, p.speaker_id,
           p.source_kind, p.origin, p.content_digest, e.quote
    FROM memory_evidence_provenance p
    INNER JOIN memory_evidence e ON e.id = p.memory_evidence_id
    INNER JOIN memory_items m ON m.id = e.memory_id AND m.user_id = p.user_id
    WHERE p.user_id = ? AND p.upload_id = ?
    ORDER BY p.memory_evidence_id
  `).all(input.accountId, input.uploadId) as Array<{
    memory_evidence_id: string;
    upload_id: string;
    source_segment_id: string;
    start_seconds: number;
    end_seconds: number;
    speaker_id: string | null;
    source_kind: string;
    origin: string;
    content_digest: string;
    quote: string;
  }>;
  if (!retained) return false;
  if (
    retained.status !== "active"
    || retained.dc_relationship_id !== input.relationshipId
    || retained.dc_interaction_id !== input.interactionId
    || !isSha256(retained.provenance_digest)
  ) {
    return false;
  }
  if (
    provenance.length !== retained.provenance_count
    || provenance.some((row) =>
      row.upload_id !== input.uploadId
      || row.source_kind !== "transcript"
      || row.origin !== "date_companion_retention"
      || !isSha256(row.content_digest)
    )
  ) {
    return false;
  }
  const aggregateDigest = createHash("sha256")
    .update(provenance.map((row) => `${row.memory_evidence_id}:${row.content_digest}`).join("\n"))
    .digest("hex");
  if (aggregateDigest !== retained.provenance_digest) return false;
  const matching = provenance.filter((row) =>
    row.source_segment_id === input.snapshot.source_segment_id
  );
  return matching.length > 0 && matching.every((row) =>
    row.start_seconds === input.snapshot.start_seconds
    && row.end_seconds === input.snapshot.end_seconds
    && row.speaker_id === input.snapshot.speaker_id
    && normalizedText(row.quote) === normalizedText(input.snapshot.quote)
    && row.content_digest === dateCompanionRetainedEvidenceDigest({
      userId: input.accountId,
      uploadId: input.snapshot.upload_id,
      sourceSegmentId: input.snapshot.source_segment_id,
      startSeconds: input.snapshot.start_seconds,
      endSeconds: input.snapshot.end_seconds,
      speakerId: input.snapshot.speaker_id,
      quote: row.quote
    })
  );
}

function resolveSnapshotLink(input: {
  memoryDatabase: Database.Database;
  dateCompanionDatabase: Database.Database;
  accountId: string;
  personId: string;
  activeSelfPersonId: string;
  personEvidence: PersonEvidence;
  link: MemoryLinkRow;
}) {
  const relationshipLink = input.memoryDatabase.prepare(`
    SELECT l.person_relationship_id, l.mapping_version, l.self_person_id,
           l.companion_person_id, l.relationship_type, l.status,
           r.person_a_id, r.person_b_id, r.status AS person_relationship_status,
           r.explicitly_confirmed, r.confirmed_at
    FROM dc_person_relationship_links l
    INNER JOIN person_relationships r
      ON r.id = l.person_relationship_id AND r.account_id = l.account_id
    WHERE l.account_id = ? AND l.dc_relationship_id = ?
  `).get(input.accountId, input.link.dc_relationship_id) as MemoryRelationshipLinkRow | undefined;
  if (
    !relationshipLink
    || relationshipLink.status !== "active"
    || relationshipLink.person_relationship_status !== "confirmed"
    || relationshipLink.explicitly_confirmed !== 1
    || !relationshipLink.confirmed_at
    || ![relationshipLink.person_a_id, relationshipLink.person_b_id].includes(input.personId)
    || relationshipLink.self_person_id !== input.activeSelfPersonId
    || ![relationshipLink.self_person_id, relationshipLink.companion_person_id].includes(input.personId)
  ) {
    return null;
  }
  const outbox = input.dateCompanionDatabase.prepare(`
    SELECT id, idempotency_key, payload_digest, payload_json, mapping_version,
           source_version, confirmation_fingerprint, status, completed_at
    FROM dc_memory_bridge_outbox
    WHERE user_id = ? AND relationship_id = ? AND interaction_id = ?
  `).get(
    input.accountId,
    input.link.dc_relationship_id,
    input.link.dc_interaction_id
  ) as OutboxRow | undefined;
  if (!outbox) return null;
  const receipts = input.memoryDatabase.prepare(`
    SELECT id, idempotency_key, payload_digest, dc_outbox_id, mapping_version
    FROM dc_memory_bridge_receipts
    WHERE account_id = ? AND dc_relationship_id = ? AND dc_interaction_id = ?
    ORDER BY id
  `).all(
    input.accountId,
    input.link.dc_relationship_id,
    input.link.dc_interaction_id
  ) as ReceiptRow[];
  const expectedProjectionKey = dateCompanionMemoryProjectionIdempotencyKey(outbox.idempotency_key);
  const projectionReceipts = receipts.filter((receipt) =>
    isDateCompanionMemoryProjectionIdempotencyKey(receipt.idempotency_key)
    && receipt.idempotency_key === expectedProjectionKey
    && receipt.dc_outbox_id === outbox.id
    && receipt.payload_digest === outbox.payload_digest
  );
  if (
    projectionReceipts.length !== 1
    || projectionReceipts[0]?.mapping_version !== relationshipLink.mapping_version
  ) {
    return null;
  }
  const receipt = projectionReceipts[0];
  const snapshot = input.dateCompanionDatabase.prepare(`
    SELECT e.id, e.recap_item_id, e.upload_id, e.source_segment_id,
           e.start_seconds, e.end_seconds, e.speaker_id, e.quote,
           e.provenance_version, e.source_kind, e.content_digest,
           r.interaction_id AS recap_interaction_id, r.disposition AS recap_disposition,
           i.relationship_id, i.source_upload_id, i.status AS interaction_status,
           i.source_state, i.version AS interaction_version,
           i.confirmation_fingerprint, i.confirmed_at,
           rel.status AS relationship_status,
           s.relationship_id AS selection_relationship_id,
           s.interaction_id AS selection_interaction_id,
           s.recap_item_id AS selection_recap_item_id,
           s.subject AS selection_subject, s.version AS selection_version,
           m.self_person_id AS mapping_self_person_id,
           m.companion_person_id AS mapping_companion_person_id,
           m.relationship_type AS mapping_relationship_type,
           m.status AS mapping_status, m.version AS mapping_version,
           m.confirmed_at AS mapping_confirmed_at,
           p.role AS participant_role, p.confirmed_by AS participant_confirmed_by,
           p.confirmed_at AS participant_confirmed_at
    FROM dc_evidence_snapshots e
    INNER JOIN dc_recap_items r ON r.id = e.recap_item_id AND r.user_id = e.user_id
    INNER JOIN dc_interactions i ON i.id = r.interaction_id AND i.user_id = r.user_id
    INNER JOIN dc_relationships rel
      ON rel.id = i.relationship_id AND rel.user_id = i.user_id
    LEFT JOIN dc_memory_subject_selections s
      ON s.evidence_snapshot_id = e.id AND s.user_id = e.user_id
    LEFT JOIN dc_relationship_person_mappings m
      ON m.relationship_id = i.relationship_id AND m.user_id = i.user_id
    LEFT JOIN dc_participant_assignments p
      ON p.interaction_id = i.id AND p.user_id = i.user_id AND p.speaker_id = e.speaker_id
    WHERE e.id = ? AND e.user_id = ?
  `).get(input.link.dc_evidence_snapshot_id, input.accountId) as SnapshotRow | undefined;
  if (!snapshot) return null;
  if (
    snapshot.upload_id !== input.personEvidence.uploadId
    || snapshot.source_segment_id !== input.personEvidence.sourceSegmentId
    || normalizedText(snapshot.quote) !== normalizedText(input.personEvidence.quote)
    || snapshot.content_digest !== input.link.snapshot_digest
    || !snapshotDigestIsValid(input.accountId, snapshot)
  ) {
    return { conflict: true as const, snapshot: null };
  }
  if (
    snapshot.recap_interaction_id !== input.link.dc_interaction_id
    || snapshot.recap_disposition !== "kept"
    || snapshot.relationship_id !== input.link.dc_relationship_id
    || snapshot.source_upload_id !== snapshot.upload_id
    || snapshot.interaction_status !== "confirmed"
    || snapshot.source_state !== "server_cleaned"
    || !snapshot.confirmed_at
    || snapshot.relationship_status !== "active"
    || snapshot.selection_relationship_id !== input.link.dc_relationship_id
    || snapshot.selection_interaction_id !== input.link.dc_interaction_id
    || snapshot.selection_recap_item_id !== snapshot.recap_item_id
    || !snapshot.selection_version
    || !subjectIncludesPerson(
      snapshot.selection_subject,
      input.personId,
      relationshipLink.self_person_id,
      relationshipLink.companion_person_id
    )
    || snapshot.mapping_status !== "confirmed"
    || !snapshot.mapping_confirmed_at
    || snapshot.mapping_version !== relationshipLink.mapping_version
    || snapshot.mapping_self_person_id !== relationshipLink.self_person_id
    || snapshot.mapping_companion_person_id !== relationshipLink.companion_person_id
    || snapshot.mapping_relationship_type !== relationshipLink.relationship_type
    || !isNonEmptyString(snapshot.speaker_id)
    || !["self", "companion"].includes(snapshot.participant_role ?? "")
    || snapshot.participant_confirmed_by !== input.accountId
    || !snapshot.participant_confirmed_at
  ) {
    return null;
  }
  const candidateReceipt = input.memoryDatabase.prepare(`
    SELECT status, memory_id
    FROM dc_memory_bridge_candidate_receipts
    WHERE account_id = ? AND operation_receipt_id = ? AND recap_item_id = ?
  `).get(
    input.accountId,
    receipt.id,
    snapshot.recap_item_id
  ) as { status: string; memory_id: string | null } | undefined;
  if (candidateReceipt?.status !== "admitted" || !candidateReceipt.memory_id) {
    return null;
  }
  if (!retainedUploadIsCurrent({
    memoryDatabase: input.memoryDatabase,
    accountId: input.accountId,
    uploadId: snapshot.upload_id,
    relationshipId: input.link.dc_relationship_id,
    interactionId: input.link.dc_interaction_id,
    snapshot
  })) {
    return null;
  }
  if (
    outbox.status !== "completed"
    || !outbox.completed_at
    || dateCompanionMemoryProjectionIdempotencyKey(outbox.idempotency_key) !== receipt.idempotency_key
    || outbox.payload_digest !== receipt.payload_digest
    || outbox.mapping_version !== receipt.mapping_version
    || outbox.source_version !== snapshot.interaction_version
    || outbox.confirmation_fingerprint !== snapshot.confirmation_fingerprint
    || !bridgePayloadMatches({
      payloadJson: outbox.payload_json,
      payloadDigest: outbox.payload_digest,
      accountId: input.accountId,
      relationshipId: input.link.dc_relationship_id,
      interactionId: input.link.dc_interaction_id,
      uploadId: snapshot.upload_id,
      snapshot,
      mapping: relationshipLink
    })
  ) {
    return null;
  }
  return { conflict: false as const, snapshot };
}

function emptyResolution(activeSelfPersonId: string | null = null): TrustedPersonQaEvidenceResolution {
  return { segments: [], conflictingEvidenceKeys: [], activeSelfPersonId };
}

/**
 * Read-only Phase 5A adapter. It accepts only Person Context evidence keys and
 * revalidates both the Memory receipt/link side and the Date Companion snapshot
 * side before returning canonical raw Transcript segments.
 */
export function resolveTrustedPersonQaEvidence(input: {
  memoryDatabase: Database.Database;
  dateCompanionDatabase: Database.Database;
  accountId: string;
  personId: string;
  evidence: readonly PersonEvidence[];
}): TrustedPersonQaEvidenceResolution {
  try {
    const person = input.memoryDatabase.prepare(`
      SELECT status FROM person_entities WHERE id = ? AND account_id = ?
    `).get(input.personId, input.accountId) as { status: string } | undefined;
    const selfBinding = input.memoryDatabase.prepare(`
      SELECT b.person_id, b.status, p.status AS person_status
      FROM person_self_bindings b
      LEFT JOIN person_entities p ON p.id = b.person_id AND p.account_id = b.account_id
      WHERE b.account_id = ?
    `).get(input.accountId) as {
      person_id: string | null;
      status: string;
      person_status: string | null;
    } | undefined;
    const activeSelfPersonId = selfBinding?.status === "active"
      && selfBinding.person_status === "confirmed"
      && selfBinding.person_id
      ? selfBinding.person_id
      : null;
    if (person?.status !== "confirmed" || !activeSelfPersonId) {
      return emptyResolution(activeSelfPersonId);
    }

    const segments: TranscriptSegment[] = [];
    const conflictingEvidenceKeys = new Set<string>();
    for (const evidence of input.evidence) {
      const key = personQaEvidenceKey(evidence.uploadId, evidence.sourceSegmentId);
      if (
        evidence.accountId !== input.accountId
        || !evidence.uploadId.trim()
        || !evidence.sourceSegmentId.trim()
        || !normalizedText(evidence.quote)
      ) continue;
      const personEvidence = input.memoryDatabase.prepare(`
        SELECT id, account_id AS accountId, upload_id AS uploadId,
               source_segment_id AS sourceSegmentId, quote,
               created_at AS createdAt, updated_at AS updatedAt
        FROM person_evidence WHERE id = ? AND account_id = ?
      `).get(evidence.id, input.accountId) as PersonEvidence | undefined;
      if (
        !personEvidence
        || personEvidence.uploadId !== evidence.uploadId
        || personEvidence.sourceSegmentId !== evidence.sourceSegmentId
        || normalizedText(personEvidence.quote) !== normalizedText(evidence.quote)
      ) continue;
      const links = input.memoryDatabase.prepare(`
        SELECT dc_relationship_id, dc_interaction_id,
               dc_evidence_snapshot_id, snapshot_digest
        FROM person_evidence_dc_links
        WHERE account_id = ? AND person_evidence_id = ?
        ORDER BY dc_evidence_snapshot_id
      `).all(input.accountId, evidence.id) as MemoryLinkRow[];
      if (links.length === 0) continue;

      const duplicateSnapshots = input.dateCompanionDatabase.prepare(`
        SELECT e.id, e.recap_item_id, e.upload_id, e.source_segment_id,
               e.start_seconds, e.end_seconds, e.speaker_id, e.quote,
               e.provenance_version, e.source_kind, e.content_digest,
               '' AS recap_interaction_id, '' AS recap_disposition,
               '' AS relationship_id, '' AS source_upload_id,
               '' AS interaction_status, '' AS source_state, 0 AS interaction_version,
               NULL AS confirmation_fingerprint, NULL AS confirmed_at,
               '' AS relationship_status, NULL AS selection_relationship_id,
               NULL AS selection_interaction_id, NULL AS selection_recap_item_id,
               NULL AS selection_subject, NULL AS selection_version,
               NULL AS mapping_self_person_id, NULL AS mapping_companion_person_id,
               NULL AS mapping_relationship_type, NULL AS mapping_status,
               NULL AS mapping_version, NULL AS mapping_confirmed_at,
               NULL AS participant_role, NULL AS participant_confirmed_by,
               NULL AS participant_confirmed_at
        FROM dc_evidence_snapshots e
        WHERE e.user_id = ? AND e.upload_id = ? AND e.source_segment_id = ?
        ORDER BY e.id
      `).all(input.accountId, evidence.uploadId, evidence.sourceSegmentId) as SnapshotRow[];
      if (
        duplicateSnapshots.length === 0
        || duplicateSnapshots.some((snapshot) => !snapshotDigestIsValid(input.accountId, snapshot))
        || new Set(duplicateSnapshots.map(snapshotSignature)).size !== 1
      ) {
        conflictingEvidenceKeys.add(key);
        continue;
      }

      const resolved = links.map((link) => resolveSnapshotLink({
        memoryDatabase: input.memoryDatabase,
        dateCompanionDatabase: input.dateCompanionDatabase,
        accountId: input.accountId,
        personId: input.personId,
        activeSelfPersonId,
        personEvidence,
        link
      }));
      if (resolved.some((item) => item?.conflict)) {
        conflictingEvidenceKeys.add(key);
        continue;
      }
      if (resolved.some((item) => !item?.snapshot)) continue;
      const snapshots = resolved.map((item) => item?.snapshot as SnapshotRow);
      if (new Set(snapshots.map(snapshotSignature)).size !== 1) {
        conflictingEvidenceKeys.add(key);
        continue;
      }
      const snapshot = snapshots[0];
      segments.push(TranscriptSegmentSchema.parse({
        id: snapshot.source_segment_id,
        uploadId: snapshot.upload_id,
        startSeconds: snapshot.start_seconds,
        endSeconds: snapshot.end_seconds,
        speaker: snapshot.speaker_id ?? undefined,
        text: snapshot.quote.trim(),
        // Phase 5A snapshots retain canonical text/time/speaker provenance, not
        // the original ASR confidence. Zero avoids inventing a confidence value;
        // raw QA ranking does not use this field.
        confidence: 0,
        sceneLabels: [],
        valueLabels: []
      }));
    }
    return {
      segments: segments.sort((left, right) =>
        left.uploadId.localeCompare(right.uploadId)
        || left.startSeconds - right.startSeconds
        || left.id.localeCompare(right.id)
      ),
      conflictingEvidenceKeys: [...conflictingEvidenceKeys].sort(),
      activeSelfPersonId
    };
  } catch {
    return emptyResolution();
  }
}

export const resolveProductionTrustedPersonQaEvidence: TrustedPersonQaEvidenceResolver = (input) =>
  resolveTrustedPersonQaEvidence({
    memoryDatabase: getMemoryDatabase(),
    dateCompanionDatabase: getDateCompanionDatabase(),
    ...input
  });
