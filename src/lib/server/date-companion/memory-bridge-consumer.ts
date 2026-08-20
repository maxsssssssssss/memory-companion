import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { TranscriptSegment } from "@/lib/domain/types";
import { evaluateMemoryAdmission } from "@/lib/server/memory/admission";
import { resolveMemoryOwnerAttribution } from "@/lib/server/memory/owner-attribution";
import { createMemoryRepository } from "@/lib/server/memory/repository";
import { dateCompanionRetainedEvidenceDigest } from "@/lib/server/memory/retention-provenance";
import type { MemoryWriteInput } from "@/lib/server/memory/types";
import type { MemoryOwnerResolution } from "@/lib/server/memory/owner-attribution/types";
import { DcConflictError } from "./errors";
import {
  createDateCompanionMemoryBridgeRepository,
  type DcMemoryBridgePayload
} from "./memory-bridge-repository";
import {
  dateCompanionEvidenceDigest,
  dateCompanionMemoryProjectionIdempotencyKey,
  stableBridgeDigest
} from "./memory-bridge-digest";

type ConfirmedRecapEvidence = {
  id: string;
  recapItemId: string;
  recapKind: "moment" | "mentioned" | "promise" | "continue";
  proposedText: string;
  userText: string | null;
  disposition: "kept";
  recordingDate: string;
  confirmedAt: string;
  uploadId: string;
  sourceSegmentId: string;
  startSeconds: number;
  endSeconds: number;
  speakerId: string;
  participantRole: "self" | "companion";
  quote: string;
  contentDigest: string;
};

type AdmissionCandidate = {
  recapItemId: string;
  originKey: string;
  memory: MemoryWriteInput;
  ownerAttribution: MemoryOwnerResolution;
  evidenceDigest: string;
  decision: ReturnType<typeof evaluateMemoryAdmission>;
};

function stableId(prefix: string, ...values: string[]) {
  return `${prefix}_${createHash("sha256")
    .update(values.join("\u0000"))
    .digest("hex")
    .slice(0, 32)}`;
}

function normalizeText(value: string) {
  return value.normalize("NFKC").replace(/\r\n?/gu, "\n").replace(/\s+/gu, " ").trim();
}

function recapMemoryType(kind: ConfirmedRecapEvidence["recapKind"]): MemoryWriteInput["type"] {
  if (kind === "moment") return "event";
  if (kind === "promise") return "commitment";
  if (kind === "continue") return "question";
  return "summary";
}

function loadConfirmedRecapEvidence(input: {
  database: Database.Database;
  userId: string;
  payload: DcMemoryBridgePayload;
}) {
  const rows = input.database.prepare(`
    SELECT e.id, e.recap_item_id, r.kind AS recap_kind,
           r.proposed_text, r.user_text, r.disposition,
           i.recording_date, i.confirmed_at,
           e.upload_id, e.source_segment_id, e.start_seconds, e.end_seconds,
           e.speaker_id, e.quote, e.content_digest,
           participant.role AS participant_role,
           participant.confirmed_at AS participant_confirmed_at,
           participant.confirmed_by AS participant_confirmed_by
    FROM dc_evidence_snapshots e
    INNER JOIN dc_recap_items r
      ON r.id = e.recap_item_id AND r.user_id = e.user_id
    INNER JOIN dc_interactions i
      ON i.id = r.interaction_id AND i.user_id = r.user_id
    LEFT JOIN dc_participant_assignments participant
      ON participant.user_id = e.user_id
      AND participant.interaction_id = i.id
      AND participant.speaker_id = e.speaker_id
    WHERE e.user_id = ? AND i.id = ? AND r.disposition = 'kept'
    ORDER BY r.sort_order, r.id, e.start_seconds, e.source_segment_id, e.id
  `).all(input.userId, input.payload.interactionId) as Array<{
    id: string;
    recap_item_id: string;
    recap_kind: ConfirmedRecapEvidence["recapKind"];
    proposed_text: string;
    user_text: string | null;
    disposition: string;
    recording_date: string;
    confirmed_at: string | null;
    upload_id: string;
    source_segment_id: string;
    start_seconds: number;
    end_seconds: number;
    speaker_id: string | null;
    quote: string;
    content_digest: string | null;
    participant_role: string | null;
    participant_confirmed_at: string | null;
    participant_confirmed_by: string | null;
  }>;
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (rows.length !== input.payload.selections.length) {
    throw new DcConflictError("memory_bridge_evidence_set_stale");
  }
  const canonicalSignatures = new Map<string, string>();
  return input.payload.selections.map((selection): ConfirmedRecapEvidence => {
    const row = byId.get(selection.evidenceSnapshotId);
    if (
      !row
      || row.recap_item_id !== selection.recapItemId
      || row.upload_id !== selection.uploadId
      || row.upload_id !== input.payload.sourceUploadId
      || row.source_segment_id !== selection.sourceSegmentId
      || row.content_digest !== selection.contentDigest
    ) throw new DcConflictError("memory_bridge_evidence_missing");
    if (
      !row.confirmed_at
      || !row.speaker_id
      || !row.participant_confirmed_at
      || row.participant_confirmed_by !== input.userId
      || !["self", "companion"].includes(row.participant_role ?? "")
    ) throw new DcConflictError("memory_bridge_participant_mapping_stale");
    const digest = dateCompanionEvidenceDigest({
      userId: input.userId,
      uploadId: row.upload_id,
      sourceSegmentId: row.source_segment_id,
      startSeconds: row.start_seconds,
      endSeconds: row.end_seconds,
      speakerId: row.speaker_id,
      quote: row.quote
    });
    if (digest !== selection.contentDigest) {
      throw new DcConflictError("memory_bridge_evidence_digest_conflict");
    }
    const canonicalKey = `${row.upload_id}\u0000${row.source_segment_id}`;
    const canonicalSignature = stableBridgeDigest({
      startSeconds: row.start_seconds,
      endSeconds: row.end_seconds,
      speakerId: row.speaker_id,
      quote: normalizeText(row.quote),
      contentDigest: row.content_digest
    });
    const previous = canonicalSignatures.get(canonicalKey);
    if (previous && previous !== canonicalSignature) {
      throw new DcConflictError("memory_bridge_canonical_evidence_conflict");
    }
    canonicalSignatures.set(canonicalKey, canonicalSignature);
    return {
      id: row.id,
      recapItemId: row.recap_item_id,
      recapKind: row.recap_kind,
      proposedText: row.proposed_text,
      userText: row.user_text,
      disposition: "kept",
      recordingDate: row.recording_date,
      confirmedAt: row.confirmed_at,
      uploadId: row.upload_id,
      sourceSegmentId: row.source_segment_id,
      startSeconds: row.start_seconds,
      endSeconds: row.end_seconds,
      speakerId: row.speaker_id,
      participantRole: row.participant_role as "self" | "companion",
      quote: row.quote,
      contentDigest: row.content_digest as string
    };
  });
}

function ownerAttributionForRecap(input: {
  mapping: NonNullable<DcMemoryBridgePayload["mapping"]>;
  memoryId: string;
  memoryType: MemoryWriteInput["type"];
  evidence: ConfirmedRecapEvidence[];
}): MemoryOwnerResolution {
  const segments: TranscriptSegment[] = input.evidence.map((item) => {
    const personId = item.participantRole === "self"
      ? input.mapping.selfPersonId
      : input.mapping.companionPersonId;
    return {
      id: item.sourceSegmentId,
      uploadId: item.uploadId,
      startSeconds: item.startSeconds,
      endSeconds: item.endSeconds,
      speaker: item.speakerId,
      identity: {
        globalSpeakerId: personId,
        identityType: item.participantRole === "self" ? "known_user" : "known_contact",
        confidence: 1,
        source: "manual_mapping"
      },
      text: item.quote,
      confidence: 1,
      sceneLabels: [],
      valueLabels: []
    };
  });
  return resolveMemoryOwnerAttribution({
    memoryId: input.memoryId,
    memoryType: input.memoryType,
    evidenceSegments: segments,
    allowManualMappingIdentity: true
  });
}

function buildAdmissionCandidates(input: {
  accountId: string;
  payload: DcMemoryBridgePayload;
  evidence: ConfirmedRecapEvidence[];
}) {
  const mapping = input.payload.mapping;
  if (!mapping) throw new DcConflictError("memory_bridge_mapping_required");
  const byRecap = new Map<string, ConfirmedRecapEvidence[]>();
  for (const evidence of input.evidence) {
    const current = byRecap.get(evidence.recapItemId) ?? [];
    current.push(evidence);
    byRecap.set(evidence.recapItemId, current);
  }
  return [...byRecap.entries()].map(([recapItemId, evidence]): AdmissionCandidate => {
    const first = evidence[0]!;
    const text = normalizeText(first.userText ?? first.proposedText).slice(0, 4_000);
    if (!text) throw new DcConflictError("memory_bridge_candidate_text_missing");
    if (evidence.some((item) =>
      item.recapKind !== first.recapKind
      || item.recordingDate !== first.recordingDate
      || item.confirmedAt !== first.confirmedAt
      || normalizeText(item.userText ?? item.proposedText).slice(0, 4_000) !== text
    )) throw new DcConflictError("memory_bridge_candidate_snapshot_conflict");
    const originKey = stableId(
      "date_companion_memory_origin",
      input.accountId,
      input.payload.relationshipId,
      input.payload.interactionId,
      input.payload.confirmationFingerprint,
      recapItemId
    );
    const memoryType = recapMemoryType(first.recapKind);
    const memoryId = stableId("memory", originKey);
    const memory: MemoryWriteInput = {
      id: memoryId,
      type: memoryType,
      title: text.slice(0, 500),
      summary: text,
      importance: 0.5,
      importanceReasons: ["date_companion_user_confirmed"],
      status: "active",
      date: first.recordingDate,
      createdAt: first.confirmedAt,
      updatedAt: first.confirmedAt,
      evidence: evidence.map((item) => ({
        id: stableId("memory_evidence", originKey, item.id),
        sourceType: "transcript" as const,
        sourceId: item.sourceSegmentId,
        uploadId: item.uploadId,
        date: item.recordingDate,
        quote: item.quote.slice(0, 4_000),
        createdAt: item.confirmedAt
      }))
    };
    const ownerAttribution = ownerAttributionForRecap({
      mapping,
      memoryId,
      memoryType,
      evidence
    });
    const decision = evaluateMemoryAdmission({
      memory,
      ownerAttribution,
      sourceSegmentCount: new Set(evidence.map((item) => item.sourceSegmentId)).size
    });
    return {
      recapItemId,
      originKey,
      memory: {
        ...memory,
        importance: decision.score,
        importanceScore: decision.score,
        importanceReasons: ["date_companion_user_confirmed", ...decision.reasons]
      },
      ownerAttribution,
      evidenceDigest: stableBridgeDigest(evidence.map((item) => ({
        evidenceSnapshotId: item.id,
        uploadId: item.uploadId,
        sourceSegmentId: item.sourceSegmentId,
        contentDigest: item.contentDigest
      }))),
      decision
    };
  });
}

export function validateMemoryBridgePersonMapping(input: {
  memoryDatabase: Database.Database;
  accountId: string;
  selfPersonId: string;
  companionPersonId: string;
}) {
  if (input.selfPersonId === input.companionPersonId) {
    throw new DcConflictError("self_and_companion_must_differ");
  }
  const people = input.memoryDatabase.prepare(`
    SELECT id FROM person_entities
    WHERE account_id = ? AND id IN (?, ?) AND status = 'confirmed'
    ORDER BY id
  `).all(
    input.accountId,
    input.selfPersonId,
    input.companionPersonId
  ) as Array<{ id: string }>;
  if (people.length !== 2) {
    throw new DcConflictError("confirmed_person_mapping_stale");
  }
  const binding = input.memoryDatabase.prepare(`
    SELECT person_id, status FROM person_self_bindings WHERE account_id = ?
  `).get(input.accountId) as { person_id: string | null; status: string } | undefined;
  if (binding?.status !== "active" || binding.person_id !== input.selfPersonId) {
    throw new DcConflictError("active_self_binding_required");
  }
}

function revalidateDcClaim(input: {
  dateCompanionDatabase: Database.Database;
  userId: string;
  outboxId: string;
  claimToken: string;
  payload: DcMemoryBridgePayload;
  payloadDigest: string;
  allowConsumedRelationshipReview?: boolean;
  evidence: Array<{
    id: string;
    recap_item_id: string;
    upload_id: string;
    source_segment_id: string;
    start_seconds: number;
    end_seconds: number;
    speaker_id: string | null;
    quote: string;
    content_digest: string | null;
  }>;
}) {
  if (stableBridgeDigest(input.payload) !== input.payloadDigest) {
    throw new DcConflictError("memory_bridge_payload_digest_conflict");
  }
  if (!input.payload.mapping) throw new DcConflictError("memory_bridge_mapping_required");
  const row = input.dateCompanionDatabase.prepare(`
    SELECT o.payload_digest, o.mapping_version, o.status, o.claim_token,
           i.source_state, i.status AS interaction_status, i.version AS interaction_version,
           m.self_person_id, m.companion_person_id, m.relationship_type,
           m.version AS current_mapping_version, m.status AS mapping_status
    FROM dc_memory_bridge_outbox o
    INNER JOIN dc_interactions i ON i.id = o.interaction_id AND i.user_id = o.user_id
    LEFT JOIN dc_relationship_person_mappings m
      ON m.relationship_id = o.relationship_id AND m.user_id = o.user_id
    WHERE o.id = ? AND o.user_id = ?
  `).get(input.outboxId, input.userId) as {
    payload_digest: string;
    mapping_version: number | null;
    status: string;
    claim_token: string | null;
    source_state: string;
    interaction_status: string;
    interaction_version: number;
    self_person_id: string | null;
    companion_person_id: string | null;
    relationship_type: string | null;
    current_mapping_version: number | null;
    mapping_status: string | null;
  } | undefined;
  if (
    !row
    || row.status !== "processing"
    || row.claim_token !== input.claimToken
  ) throw new DcConflictError("memory_bridge_claim_lost");
  if (row.source_state !== "server_cleaned" || row.interaction_status !== "confirmed") {
    throw new DcConflictError("memory_bridge_source_not_ready");
  }
  if (row.interaction_version !== input.payload.sourceVersion) {
    throw new DcConflictError("memory_bridge_source_version_stale");
  }
  const mapping = input.payload.mapping;
  if (
    row.payload_digest !== input.payloadDigest
    || row.mapping_status !== "confirmed"
    || row.current_mapping_version !== mapping.version
    || row.mapping_version !== mapping.version
    || row.self_person_id !== mapping.selfPersonId
    || row.companion_person_id !== mapping.companionPersonId
    || row.relationship_type !== mapping.relationshipType
  ) throw new DcConflictError("memory_bridge_mapping_stale");

  const relationshipReview = input.payload.relationshipReview;
  if (relationshipReview) {
    if (input.payload.relationshipEpoch !== relationshipReview.epoch) {
      throw new DcConflictError("relationship_reconfirmation_epoch_stale");
    }
    const authorization = input.dateCompanionDatabase.prepare(`
      SELECT relationship_id, interaction_id, person_relationship_id, action, epoch,
             expected_admission_version, expected_self_binding_version,
             mapping_version, interaction_version, batch_id, evidence_digest,
             proposal_digest, confirmation_fingerprint, status
      FROM dc_relationship_reconfirmation_authorizations
      WHERE id = ? AND user_id = ?
    `).get(relationshipReview.authorizationId, input.userId) as {
      relationship_id: string;
      interaction_id: string;
      person_relationship_id: string;
      action: string;
      epoch: number;
      expected_admission_version: number;
      expected_self_binding_version: number;
      mapping_version: number;
      interaction_version: number;
      batch_id: string;
      evidence_digest: string;
      proposal_digest: string;
      confirmation_fingerprint: string;
      status: string;
    } | undefined;
    if (
      !authorization
      || !(
        authorization.status === "authorized"
        || input.allowConsumedRelationshipReview && authorization.status === "consumed"
      )
      || authorization.action !== relationshipReview.kind
      || authorization.relationship_id !== input.payload.relationshipId
      || authorization.interaction_id !== input.payload.interactionId
      || authorization.person_relationship_id !== relationshipReview.personRelationshipId
      || authorization.epoch !== relationshipReview.epoch
      || authorization.expected_admission_version !== relationshipReview.expectedAdmissionVersion
      || authorization.expected_self_binding_version !== relationshipReview.expectedSelfBindingVersion
      || authorization.mapping_version !== mapping.version
      || authorization.interaction_version !== input.payload.sourceVersion
      || authorization.batch_id !== relationshipReview.batchId
      || authorization.evidence_digest !== relationshipReview.evidenceDigest
      || authorization.proposal_digest !== relationshipReview.proposalDigest
      || authorization.confirmation_fingerprint !== relationshipReview.confirmationFingerprint
    ) throw new DcConflictError("relationship_reconfirmation_authorization_stale");
    const latest = input.dateCompanionDatabase.prepare(`
      SELECT COALESCE(MAX(epoch), 0) AS epoch
      FROM dc_relationship_reconfirmation_authorizations
      WHERE user_id = ? AND relationship_id = ? AND status IN ('authorized', 'consumed')
    `).get(input.userId, input.payload.relationshipId) as { epoch: number };
    if (latest.epoch !== relationshipReview.epoch) {
      throw new DcConflictError("relationship_reconfirmation_epoch_stale");
    }
    const batch = input.dateCompanionDatabase.prepare(`
      SELECT interaction_version, mapping_version, evidence_digest, proposal_digest,
             confirmation_fingerprint
      FROM dc_subject_suggestion_batches
      WHERE id = ? AND user_id = ? AND interaction_id = ?
    `).get(
      relationshipReview.batchId,
      input.userId,
      input.payload.interactionId
    ) as {
      interaction_version: number;
      mapping_version: number;
      evidence_digest: string;
      proposal_digest: string;
      confirmation_fingerprint: string;
    } | undefined;
    if (
      !batch
      || batch.interaction_version !== input.payload.sourceVersion
      || batch.mapping_version !== mapping.version
      || batch.evidence_digest !== relationshipReview.evidenceDigest
      || batch.proposal_digest !== relationshipReview.proposalDigest
      || batch.confirmation_fingerprint !== relationshipReview.confirmationFingerprint
    ) throw new DcConflictError("relationship_reconfirmation_batch_stale");
  }

  const evidenceById = new Map(input.evidence.map((item) => [item.id, item]));
  for (const selection of input.payload.selections) {
    const evidence = evidenceById.get(selection.evidenceSnapshotId);
    if (!evidence || evidence.content_digest !== selection.contentDigest) {
      throw new DcConflictError("memory_bridge_evidence_missing");
    }
    const digest = dateCompanionEvidenceDigest({
      userId: input.userId,
      uploadId: evidence.upload_id,
      sourceSegmentId: evidence.source_segment_id,
      startSeconds: evidence.start_seconds,
      endSeconds: evidence.end_seconds,
      speakerId: evidence.speaker_id,
      quote: evidence.quote
    });
    if (digest !== selection.contentDigest) {
      throw new DcConflictError("memory_bridge_evidence_digest_conflict");
    }
  }
}

function ensurePersonEvidence(input: {
  database: Database.Database;
  accountId: string;
  relationshipId: string;
  interactionId: string;
  snapshot: {
    id: string;
    upload_id: string;
    source_segment_id: string;
    quote: string;
    content_digest: string | null;
  };
  now: string;
}) {
  const id = stableId(
    "person_evidence",
    input.accountId,
    input.snapshot.upload_id,
    input.snapshot.source_segment_id
  );
  const existing = input.database.prepare(`
    SELECT id, quote FROM person_evidence
    WHERE account_id = ? AND upload_id = ? AND source_segment_id = ?
  `).get(
    input.accountId,
    input.snapshot.upload_id,
    input.snapshot.source_segment_id
  ) as { id: string; quote: string } | undefined;
  if (existing && existing.id !== id) throw new DcConflictError("person_evidence_id_conflict");
  input.database.prepare(`
    INSERT INTO person_evidence (
      id, account_id, upload_id, source_segment_id, quote, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, upload_id, source_segment_id) DO NOTHING
  `).run(
    id,
    input.accountId,
    input.snapshot.upload_id,
    input.snapshot.source_segment_id,
    input.snapshot.quote,
    input.now,
    input.now
  );
  input.database.prepare(`
    INSERT INTO person_evidence_dc_links (
      id, account_id, person_evidence_id, dc_relationship_id,
      dc_interaction_id, dc_evidence_snapshot_id, snapshot_digest, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, person_evidence_id, dc_evidence_snapshot_id) DO NOTHING
  `).run(
    stableId("person_evidence_dc_link", input.accountId, id, input.snapshot.id),
    input.accountId,
    id,
    input.relationshipId,
    input.interactionId,
    input.snapshot.id,
    input.snapshot.content_digest,
    input.now
  );
  return id;
}

function ensureConfirmedRelationship(input: {
  database: Database.Database;
  accountId: string;
  payload: DcMemoryBridgePayload;
  evidenceIds: string[];
  now: string;
}) {
  const mapping = input.payload.mapping;
  if (!mapping || input.evidenceIds.length === 0) return null;
  const [personAId, personBId] = [mapping.selfPersonId, mapping.companionPersonId].sort();
  const relationshipId = stableId(
    "person_relationship",
    input.accountId,
    personAId,
    personBId,
    mapping.relationshipType
  );
  const existing = input.database.prepare(`
    SELECT r.status, r.person_a_id, r.person_b_id, r.type, r.explicitly_confirmed,
           a.version AS admission_version
    FROM person_relationships r
    LEFT JOIN person_relationship_admissions a
      ON a.account_id = r.account_id AND a.relationship_id = r.id
    WHERE r.id = ? AND r.account_id = ?
  `).get(relationshipId, input.accountId) as {
    status: string;
    person_a_id: string;
    person_b_id: string;
    type: string;
    explicitly_confirmed: number;
    admission_version: number | null;
  } | undefined;
  const link = input.database.prepare(`
    SELECT person_relationship_id, mapping_version, self_person_id,
           companion_person_id, relationship_type, status, relationship_epoch
    FROM dc_person_relationship_links
    WHERE account_id = ? AND dc_relationship_id = ?
  `).get(input.accountId, input.payload.relationshipId) as {
    person_relationship_id: string;
    mapping_version: number;
    self_person_id: string;
    companion_person_id: string;
    relationship_type: string;
    status: string;
    relationship_epoch: number;
  } | undefined;
  const payloadEpoch = input.payload.relationshipEpoch ?? 0;
  if (link && payloadEpoch < link.relationship_epoch) {
    throw new DcConflictError("relationship_reconfirmation_epoch_stale");
  }
  const review = input.payload.relationshipReview;
  if (existing?.status === "archived") {
    if (
      !review
      || review.personRelationshipId !== relationshipId
      || review.epoch !== payloadEpoch
      || !link
      || link.person_relationship_id !== relationshipId
      || link.mapping_version !== mapping.version
      || link.self_person_id !== mapping.selfPersonId
      || link.companion_person_id !== mapping.companionPersonId
      || link.relationship_type !== mapping.relationshipType
      || link.status !== "archived"
      || review.epoch <= link.relationship_epoch
      || existing.admission_version !== review.expectedAdmissionVersion
    ) throw new DcConflictError("person_relationship_requires_review");
    const selfBinding = input.database.prepare(`
      SELECT person_id, status, version FROM person_self_bindings WHERE account_id = ?
    `).get(input.accountId) as { person_id: string | null; status: string; version: number } | undefined;
    if (
      selfBinding?.status !== "active"
      || selfBinding.person_id !== mapping.selfPersonId
      || selfBinding.version !== review.expectedSelfBindingVersion
    ) throw new DcConflictError("active_self_binding_required");
    const admissionUpdated = input.database.prepare(`
      UPDATE person_relationship_admissions
      SET version = version + 1, updated_at = ?
      WHERE account_id = ? AND relationship_id = ? AND version = ?
    `).run(
      input.now,
      input.accountId,
      relationshipId,
      review.expectedAdmissionVersion
    );
    if (admissionUpdated.changes !== 1) {
      throw new DcConflictError("relationship_reconfirmation_admission_stale");
    }
    const reactivated = input.database.prepare(`
      UPDATE person_relationships
      SET status = 'confirmed', explicitly_confirmed = 1,
          confirmed_at = ?, updated_at = ?
      WHERE id = ? AND account_id = ? AND status = 'archived'
        AND explicitly_confirmed = 0
    `).run(input.now, input.now, relationshipId, input.accountId);
    if (reactivated.changes !== 1) {
      throw new DcConflictError("relationship_reconfirmation_state_changed");
    }
  } else {
    if (review) {
      const alreadyReconfirmed = existing?.status === "confirmed"
        && existing.explicitly_confirmed === 1
        && existing.admission_version === review.expectedAdmissionVersion + 1
        && link?.person_relationship_id === relationshipId
        && link.mapping_version === mapping.version
        && link.self_person_id === mapping.selfPersonId
        && link.companion_person_id === mapping.companionPersonId
        && link.relationship_type === mapping.relationshipType
        && link.status === "active"
        && link.relationship_epoch === review.epoch;
      if (!alreadyReconfirmed) {
        throw new DcConflictError("relationship_reconfirmation_state_changed");
      }
    }
    if (existing && !["candidate", "confirmed"].includes(existing.status)) {
      throw new DcConflictError("person_relationship_requires_review");
    }
    if (link && payloadEpoch !== link.relationship_epoch) {
      throw new DcConflictError("relationship_reconfirmation_epoch_stale");
    }
  }
  input.database.prepare(`
    INSERT INTO person_relationships (
      id, account_id, person_a_id, person_b_id, type, status,
      explicitly_confirmed, confirmed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'confirmed', 1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = 'confirmed', explicitly_confirmed = 1,
      confirmed_at = COALESCE(person_relationships.confirmed_at, excluded.confirmed_at),
      updated_at = excluded.updated_at
  `).run(
    relationshipId,
    input.accountId,
    personAId,
    personBId,
    mapping.relationshipType,
    input.now,
    input.now,
    input.now
  );
  for (const evidenceId of [...new Set(input.evidenceIds)]) {
    input.database.prepare(`
      INSERT INTO person_relationship_evidence (
        id, account_id, relationship_id, evidence_id, created_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, relationship_id, evidence_id) DO NOTHING
    `).run(
      stableId("person_relationship_evidence", input.accountId, relationshipId, evidenceId),
      input.accountId,
      relationshipId,
      evidenceId,
      input.now
    );
  }
  input.database.prepare(`
    INSERT INTO person_relationship_admissions (
      account_id, relationship_id, version, created_at, updated_at
    ) VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(account_id, relationship_id) DO UPDATE SET updated_at = excluded.updated_at
  `).run(input.accountId, relationshipId, input.now, input.now);
  input.database.prepare(`
    INSERT INTO dc_person_relationship_links (
      account_id, dc_relationship_id, person_relationship_id, mapping_version,
      self_person_id, companion_person_id, relationship_type, status,
      created_at, updated_at, relationship_epoch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    ON CONFLICT(account_id, dc_relationship_id) DO UPDATE SET
      person_relationship_id = excluded.person_relationship_id,
      mapping_version = excluded.mapping_version,
      self_person_id = excluded.self_person_id,
      companion_person_id = excluded.companion_person_id,
      relationship_type = excluded.relationship_type,
      status = 'active', updated_at = excluded.updated_at,
      relationship_epoch = excluded.relationship_epoch
  `).run(
    input.accountId,
    input.payload.relationshipId,
    relationshipId,
    mapping.version,
    mapping.selfPersonId,
    mapping.companionPersonId,
    mapping.relationshipType,
    input.now,
    input.now,
    payloadEpoch
  );
  return relationshipId;
}

function addConfirmedSubject(input: {
  database: Database.Database;
  accountId: string;
  personId: string;
  evidenceId: string;
  now: string;
}) {
  const observationId = stableId(
    "person_subject_observation",
    input.accountId,
    input.personId,
    input.evidenceId,
    "confirmed"
  );
  input.database.prepare(`
    INSERT INTO person_subject_observations (
      id, account_id, person_id, evidence_id, status, source, reason,
      confirmed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'confirmed', 'manual_review',
      'date_companion_qwen_batch_review_v1', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at
  `).run(
    observationId,
    input.accountId,
    input.personId,
    input.evidenceId,
    input.now,
    input.now,
    input.now
  );
  const admissionId = stableId(
    "person_subject_admission",
    input.accountId,
    input.evidenceId,
    input.personId
  );
  input.database.prepare(`
    INSERT INTO person_subject_admissions (
      id, account_id, evidence_id, person_id, subject_key, observation_id,
      disposition, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'confirmed', 1, ?, ?)
    ON CONFLICT(account_id, evidence_id, subject_key) DO NOTHING
  `).run(
    admissionId,
    input.accountId,
    input.evidenceId,
    input.personId,
    input.personId,
    observationId,
    input.now,
    input.now
  );
}

function persistFormalDateCompanionMemories(input: {
  database: Database.Database;
  accountId: string;
  payload: DcMemoryBridgePayload;
  recapEvidence: ConfirmedRecapEvidence[];
  candidates: AdmissionCandidate[];
  now: string;
}) {
  const tombstone = input.database.prepare(`
    SELECT 1 FROM memory_upload_tombstones
    WHERE user_id = ? AND upload_id = ?
  `).get(input.accountId, input.payload.sourceUploadId);
  if (tombstone) throw new DcConflictError("memory_bridge_source_deleted");
  const retainedBefore = input.database.prepare(`
    SELECT dc_relationship_id, dc_interaction_id, status
    FROM dc_retained_uploads WHERE user_id = ? AND upload_id = ?
  `).get(input.accountId, input.payload.sourceUploadId) as {
    dc_relationship_id: string;
    dc_interaction_id: string;
    status: string;
  } | undefined;
  if (retainedBefore && (
    retainedBefore.dc_relationship_id !== input.payload.relationshipId
    || retainedBefore.dc_interaction_id !== input.payload.interactionId
    || retainedBefore.status === "purged"
  )) throw new DcConflictError("retained_upload_conflict");

  const admitted = input.candidates.filter((candidate) => candidate.decision.shouldPersist);
  const admittedRecapIds = new Set(admitted.map((candidate) => candidate.recapItemId));
  const admittedEvidence = input.recapEvidence.filter((evidence) =>
    admittedRecapIds.has(evidence.recapItemId)
  );
  const sourceSegmentsByKey = new Map<string, TranscriptSegment>();
  for (const evidence of admittedEvidence) {
    const key = `${evidence.uploadId}\u0000${evidence.sourceSegmentId}`;
    if (!sourceSegmentsByKey.has(key)) {
      sourceSegmentsByKey.set(key, {
        id: evidence.sourceSegmentId,
        uploadId: evidence.uploadId,
        startSeconds: evidence.startSeconds,
        endSeconds: evidence.endSeconds,
        speaker: evidence.speakerId,
        text: evidence.quote,
        confidence: 1,
        sceneLabels: [],
        valueLabels: []
      });
    }
  }
  createMemoryRepository(input.database).replaceUploadMemories({
    userId: input.accountId,
    uploadId: input.payload.sourceUploadId,
    memories: admitted.map((candidate) => candidate.memory),
    sourceSegments: [...sourceSegmentsByKey.values()],
    ownerAttributions: admitted.map((candidate) => candidate.ownerAttribution)
  });

  const canonicalByKey = new Map<string, ConfirmedRecapEvidence>();
  for (const evidence of admittedEvidence) {
    canonicalByKey.set(`${evidence.uploadId}\u0000${evidence.sourceSegmentId}`, evidence);
  }
  const writtenEvidence = input.database.prepare(`
    SELECT e.id, e.memory_id, e.upload_id, e.source_id, e.date, e.quote
    FROM memory_evidence e
    INNER JOIN memory_items m ON m.id = e.memory_id
    WHERE m.user_id = ? AND e.upload_id = ? AND e.source_type = 'transcript'
    ORDER BY e.id
  `).all(input.accountId, input.payload.sourceUploadId) as Array<{
    id: string;
    memory_id: string;
    upload_id: string;
    source_id: string;
    date: string;
    quote: string;
  }>;
  const provenanceRows: Array<{ evidenceId: string; digest: string }> = [];
  const insertProvenance = input.database.prepare(`
    INSERT INTO memory_evidence_provenance (
      memory_evidence_id, user_id, upload_id, source_segment_id,
      start_seconds, end_seconds, speaker_id, source_kind, origin,
      content_digest, captured_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'transcript', 'date_companion_retention', ?, ?)
    ON CONFLICT(memory_evidence_id) DO NOTHING
  `);
  for (const written of writtenEvidence) {
    const canonical = canonicalByKey.get(`${written.upload_id}\u0000${written.source_id}`);
    if (
      !canonical
      || written.date !== canonical.recordingDate
      || normalizeText(written.quote) !== normalizeText(canonical.quote.slice(0, 4_000))
    ) throw new DcConflictError("retained_memory_evidence_provenance_conflict");
    const digest = dateCompanionRetainedEvidenceDigest({
      userId: input.accountId,
      uploadId: canonical.uploadId,
      sourceSegmentId: canonical.sourceSegmentId,
      startSeconds: canonical.startSeconds,
      endSeconds: canonical.endSeconds,
      speakerId: canonical.speakerId,
      quote: written.quote
    });
    const existing = input.database.prepare(`
      SELECT user_id, upload_id, source_segment_id, start_seconds, end_seconds,
             speaker_id, origin, content_digest
      FROM memory_evidence_provenance WHERE memory_evidence_id = ?
    `).get(written.id) as {
      user_id: string;
      upload_id: string;
      source_segment_id: string;
      start_seconds: number;
      end_seconds: number;
      speaker_id: string | null;
      origin: string;
      content_digest: string;
    } | undefined;
    if (existing && (
      existing.user_id !== input.accountId
      || existing.upload_id !== canonical.uploadId
      || existing.source_segment_id !== canonical.sourceSegmentId
      || existing.start_seconds !== canonical.startSeconds
      || existing.end_seconds !== canonical.endSeconds
      || existing.speaker_id !== canonical.speakerId
      || existing.origin !== "date_companion_retention"
      || existing.content_digest !== digest
    )) throw new DcConflictError("retained_provenance_conflict");
    insertProvenance.run(
      written.id,
      input.accountId,
      canonical.uploadId,
      canonical.sourceSegmentId,
      canonical.startSeconds,
      canonical.endSeconds,
      canonical.speakerId,
      digest,
      input.now
    );
    provenanceRows.push({ evidenceId: written.id, digest });
  }
  const provenanceDigest = createHash("sha256")
    .update(provenanceRows.map((row) => `${row.evidenceId}:${row.digest}`).join("\n"))
    .digest("hex");
  input.database.prepare(`
    INSERT INTO dc_retained_uploads (
      user_id, upload_id, dc_relationship_id, dc_interaction_id,
      provenance_count, provenance_digest, status, captured_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(user_id, upload_id) DO UPDATE SET
      provenance_count = excluded.provenance_count,
      provenance_digest = excluded.provenance_digest,
      status = 'active', updated_at = excluded.updated_at
  `).run(
    input.accountId,
    input.payload.sourceUploadId,
    input.payload.relationshipId,
    input.payload.interactionId,
    provenanceRows.length,
    provenanceDigest,
    input.now,
    input.now
  );

  // The immutable candidate receipt records the admitted candidate's historical
  // identity. Canonical provenance resolves the current Memory after repository
  // consolidation, so one transcript source may safely support multiple recap
  // candidates without imposing a false source-to-single-Memory invariant.
  const candidateMemoryIds = new Map(
    admitted.map((candidate) => [candidate.recapItemId, candidate.memory.id])
  );
  return { admittedRecapIds, candidateMemoryIds };
}

function clearLegacyDateCompanionPersonProjection(input: {
  database: Database.Database;
  accountId: string;
  relationshipId: string;
  interactionId: string;
}) {
  const linkedEvidence = input.database.prepare(`
    SELECT DISTINCT person_evidence_id
    FROM person_evidence_dc_links
    WHERE account_id = ? AND dc_relationship_id = ? AND dc_interaction_id = ?
    ORDER BY person_evidence_id
  `).all(input.accountId, input.relationshipId, input.interactionId) as Array<{
    person_evidence_id: string;
  }>;
  const relationshipLink = input.database.prepare(`
    SELECT person_relationship_id
    FROM dc_person_relationship_links
    WHERE account_id = ? AND dc_relationship_id = ?
  `).get(input.accountId, input.relationshipId) as {
    person_relationship_id: string;
  } | undefined;
  const deleteBridgeSubjects = input.database.prepare(`
    DELETE FROM person_subject_observations
    WHERE account_id = ? AND evidence_id = ? AND source = 'manual_review'
      AND reason IN (
        'date_companion_explicit_subject_v1',
        'date_companion_qwen_batch_review_v1'
      )
  `);
  const deleteRelationshipEvidence = input.database.prepare(`
    DELETE FROM person_relationship_evidence
    WHERE account_id = ? AND relationship_id = ? AND evidence_id = ?
  `);
  for (const row of linkedEvidence) {
    deleteBridgeSubjects.run(input.accountId, row.person_evidence_id);
    if (relationshipLink) {
      deleteRelationshipEvidence.run(
        input.accountId,
        relationshipLink.person_relationship_id,
        row.person_evidence_id
      );
    }
  }
  input.database.prepare(`
    DELETE FROM person_evidence_dc_links
    WHERE account_id = ? AND dc_relationship_id = ? AND dc_interaction_id = ?
  `).run(input.accountId, input.relationshipId, input.interactionId);
  const hasRemainingReference = input.database.prepare(`
    SELECT (
      EXISTS(SELECT 1 FROM person_names
        WHERE account_id = @accountId AND evidence_id = @evidenceId)
      OR EXISTS(SELECT 1 FROM person_identity_links
        WHERE account_id = @accountId AND evidence_id = @evidenceId)
      OR EXISTS(SELECT 1 FROM person_subject_observations
        WHERE account_id = @accountId AND evidence_id = @evidenceId)
      OR EXISTS(SELECT 1 FROM person_subject_resolution_audits
        WHERE account_id = @accountId AND evidence_id = @evidenceId)
      OR EXISTS(SELECT 1 FROM person_relationship_evidence
        WHERE account_id = @accountId AND evidence_id = @evidenceId)
      OR EXISTS(SELECT 1 FROM person_fact_evidence
        WHERE account_id = @accountId AND evidence_id = @evidenceId)
      OR EXISTS(SELECT 1 FROM person_fact_transitions
        WHERE account_id = @accountId AND evidence_id = @evidenceId)
      OR EXISTS(SELECT 1 FROM person_commitment_evidence
        WHERE account_id = @accountId AND evidence_id = @evidenceId)
      OR EXISTS(SELECT 1 FROM person_commitment_transitions
        WHERE account_id = @accountId AND evidence_id = @evidenceId)
      OR EXISTS(SELECT 1 FROM person_subject_admissions
        WHERE account_id = @accountId AND evidence_id = @evidenceId)
      OR EXISTS(SELECT 1 FROM person_admission_audits
        WHERE account_id = @accountId AND evidence_id = @evidenceId)
      OR EXISTS(SELECT 1 FROM person_evidence_dc_links
        WHERE account_id = @accountId AND person_evidence_id = @evidenceId)
      OR EXISTS(SELECT 1 FROM memory_daily_reflection_candidate_person_sources
        WHERE user_id = @accountId AND person_evidence_id = @evidenceId)
    ) AS referenced
  `);
  const deleteOrphanEvidence = input.database.prepare(`
    DELETE FROM person_evidence WHERE account_id = ? AND id = ?
  `);
  for (const row of linkedEvidence) {
    const remaining = hasRemainingReference.get({
      accountId: input.accountId,
      evidenceId: row.person_evidence_id
    }) as { referenced: number };
    if (remaining.referenced === 0) {
      deleteOrphanEvidence.run(input.accountId, row.person_evidence_id);
    }
  }
  return relationshipLink?.person_relationship_id ?? null;
}

function archiveUnreferencedDateCompanionRelationship(input: {
  database: Database.Database;
  accountId: string;
  relationshipId: string;
  personRelationshipId: string | null;
  now: string;
}) {
  if (!input.personRelationshipId) return;
  const evidence = input.database.prepare(`
    SELECT 1 FROM person_relationship_evidence
    WHERE account_id = ? AND relationship_id = ? LIMIT 1
  `).get(input.accountId, input.personRelationshipId);
  if (evidence) return;
  const archived = input.database.prepare(`
    UPDATE person_relationships
    SET status = 'archived', explicitly_confirmed = 0, confirmed_at = NULL, updated_at = ?
    WHERE id = ? AND account_id = ? AND status <> 'archived'
  `).run(input.now, input.personRelationshipId, input.accountId);
  if (archived.changes === 1) {
    input.database.prepare(`
      UPDATE person_relationship_admissions
      SET version = version + 1, updated_at = ?
      WHERE account_id = ? AND relationship_id = ?
    `).run(input.now, input.accountId, input.personRelationshipId);
  }
  input.database.prepare(`
    UPDATE dc_person_relationship_links
    SET status = 'archived', updated_at = ?
    WHERE account_id = ? AND dc_relationship_id = ?
      AND person_relationship_id = ?
  `).run(
    input.now,
    input.accountId,
    input.relationshipId,
    input.personRelationshipId
  );
}

function applyBridgeToMemory(input: {
  database: Database.Database;
  accountId: string;
  outboxId: string;
  idempotencyKey: string;
  payloadDigest: string;
  payload: DcMemoryBridgePayload;
  recapEvidence: ConfirmedRecapEvidence[];
  candidates: AdmissionCandidate[];
  legacyProjectionReplay: boolean;
  evidence: Array<{
    id: string;
    upload_id: string;
    source_segment_id: string;
    quote: string;
    content_digest: string | null;
  }>;
}) {
  return input.database.transaction(() => {
    const projectionKey = dateCompanionMemoryProjectionIdempotencyKey(input.idempotencyKey);
    const existingReceipt = input.database.prepare(`
      SELECT payload_digest FROM dc_memory_bridge_receipts
      WHERE account_id = ? AND idempotency_key = ?
    `).get(input.accountId, projectionKey) as { payload_digest: string } | undefined;
    if (existingReceipt) {
      if (existingReceipt.payload_digest !== input.payloadDigest) {
        throw new DcConflictError("memory_bridge_receipt_conflict");
      }
      return { idempotent: true };
    }
    const mapping = input.payload.mapping;
    if (!mapping) throw new DcConflictError("memory_bridge_mapping_required");
    validateMemoryBridgePersonMapping({
      memoryDatabase: input.database,
      accountId: input.accountId,
      selfPersonId: mapping.selfPersonId,
      companionPersonId: mapping.companionPersonId
    });
    const now = new Date().toISOString();
    const legacyRelationshipId = input.legacyProjectionReplay
      ? clearLegacyDateCompanionPersonProjection({
          database: input.database,
          accountId: input.accountId,
          relationshipId: input.payload.relationshipId,
          interactionId: input.payload.interactionId
        })
      : null;
    const formalProjection = persistFormalDateCompanionMemories({
      database: input.database,
      accountId: input.accountId,
      payload: input.payload,
      recapEvidence: input.recapEvidence,
      candidates: input.candidates,
      now
    });
    const snapshotById = new Map(input.evidence.map((item) => [item.id, item]));
    const canonicalEvidenceById = new Map(input.recapEvidence.map((item) => [item.id, item]));
    const subjectBySegment = new Map<string, string>();
    const personEvidenceBySnapshot = new Map<string, string>();
    for (const selection of input.payload.selections) {
      if (
        selection.subject === "unknown"
        || !formalProjection.admittedRecapIds.has(selection.recapItemId)
      ) continue;
      const snapshot = snapshotById.get(selection.evidenceSnapshotId);
      const canonical = canonicalEvidenceById.get(selection.evidenceSnapshotId);
      if (!snapshot || !canonical) throw new DcConflictError("memory_bridge_evidence_missing");
      const key = `${selection.uploadId}\u0000${selection.sourceSegmentId}`;
      const previousSubject = subjectBySegment.get(key);
      if (previousSubject && previousSubject !== selection.subject) {
        throw new DcConflictError("memory_bridge_subject_conflict");
      }
      subjectBySegment.set(key, selection.subject);
      const retainedMemoryEvidence = input.database.prepare(`
        SELECT e.quote, p.content_digest
        FROM memory_evidence e
        INNER JOIN memory_items m ON m.id = e.memory_id
        LEFT JOIN memory_evidence_provenance p
          ON p.memory_evidence_id = e.id AND p.user_id = m.user_id
        WHERE m.user_id = ? AND e.upload_id = ? AND e.source_type = 'transcript'
          AND e.source_id = ?
        ORDER BY e.id
      `).all(
        input.accountId,
        snapshot.upload_id,
        snapshot.source_segment_id
      ) as Array<{ quote: string; content_digest: string | null }>;
      const expectedProvenanceDigest = (quote: string) => dateCompanionRetainedEvidenceDigest({
        userId: input.accountId,
        uploadId: canonical.uploadId,
        sourceSegmentId: canonical.sourceSegmentId,
        startSeconds: canonical.startSeconds,
        endSeconds: canonical.endSeconds,
        speakerId: canonical.speakerId,
        quote
      });
      if (
        retainedMemoryEvidence.length === 0
        || retainedMemoryEvidence.some((evidence) =>
          normalizeText(evidence.quote) !== normalizeText(snapshot.quote)
          || evidence.content_digest !== expectedProvenanceDigest(evidence.quote)
        )
      ) {
        throw new DcConflictError("retained_memory_evidence_provenance_conflict");
      }
      const evidenceId = ensurePersonEvidence({
        database: input.database,
        accountId: input.accountId,
        relationshipId: input.payload.relationshipId,
        interactionId: input.payload.interactionId,
        snapshot,
        now
      });
      personEvidenceBySnapshot.set(selection.evidenceSnapshotId, evidenceId);
    }
    const relationshipEvidenceIds = [...new Set(personEvidenceBySnapshot.values())];
    if (input.payload.relationshipReview && relationshipEvidenceIds.length === 0) {
      throw new DcConflictError("relationship_reconfirmation_evidence_required");
    }
    ensureConfirmedRelationship({
      database: input.database,
      accountId: input.accountId,
      payload: input.payload,
      evidenceIds: relationshipEvidenceIds,
      now
    });
    for (const selection of input.payload.selections) {
      if (
        selection.subject === "unknown"
        || !formalProjection.admittedRecapIds.has(selection.recapItemId)
      ) continue;
      const personEvidenceId = personEvidenceBySnapshot.get(selection.evidenceSnapshotId);
      if (!personEvidenceId) throw new DcConflictError("person_evidence_missing");
      const roles = selection.subject === "both"
        ? ["self", "companion"] as const
        : [selection.subject] as const;
      for (const role of roles) {
        addConfirmedSubject({
          database: input.database,
          accountId: input.accountId,
          personId: role === "self" ? mapping.selfPersonId : mapping.companionPersonId,
          evidenceId: personEvidenceId,
          now
        });
      }
    }
    if (input.legacyProjectionReplay) {
      archiveUnreferencedDateCompanionRelationship({
        database: input.database,
        accountId: input.accountId,
        relationshipId: input.payload.relationshipId,
        personRelationshipId: legacyRelationshipId,
        now
      });
    }
    const operationReceiptId = stableId("dc_memory_receipt", input.accountId, projectionKey);
    input.database.prepare(`
      INSERT INTO dc_memory_bridge_receipts (
        id, account_id, idempotency_key, payload_digest, dc_relationship_id,
        dc_interaction_id, dc_outbox_id, mapping_version, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      operationReceiptId,
      input.accountId,
      projectionKey,
      input.payloadDigest,
      input.payload.relationshipId,
      input.payload.interactionId,
      input.outboxId,
      mapping.version,
      now
    );
    const insertCandidateReceipt = input.database.prepare(`
      INSERT INTO dc_memory_bridge_candidate_receipts (
        id, account_id, operation_receipt_id, dc_outbox_id, dc_interaction_id,
        recap_item_id, origin_key, status, memory_id, score, reasons_json,
        evidence_digest, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const candidate of input.candidates) {
      const admitted = candidate.decision.shouldPersist;
      insertCandidateReceipt.run(
        stableId(
          "dc_memory_candidate_receipt",
          input.accountId,
          operationReceiptId,
          candidate.recapItemId
        ),
        input.accountId,
        operationReceiptId,
        input.outboxId,
        input.payload.interactionId,
        candidate.recapItemId,
        candidate.originKey,
        admitted ? "admitted" : "rejected",
        admitted ? formalProjection.candidateMemoryIds.get(candidate.recapItemId) ?? null : null,
        candidate.decision.score,
        JSON.stringify(candidate.decision.reasons),
        candidate.evidenceDigest,
        now
      );
    }
    return {
      idempotent: false,
      admittedCount: input.candidates.filter((candidate) => candidate.decision.shouldPersist).length,
      rejectedCount: input.candidates.filter((candidate) => !candidate.decision.shouldPersist).length
    };
  })();
}

const LEGACY_PROJECTION_SCAN_INTERVAL_MS = 60_000;
const legacyProjectionScanTimes = new WeakMap<Database.Database, number>();

function legacyProjectionScanTime(now?: string) {
  const parsed = now ? Date.parse(now) : Date.now();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function requeueCompletedLegacyMemoryProjections(input: {
  dateCompanionDatabase: Database.Database;
  memoryDatabase: Database.Database;
  now?: string;
}) {
  const candidates = input.dateCompanionDatabase.prepare(`
    SELECT o.id, o.user_id, o.idempotency_key, o.payload_digest,
           i.source_upload_id
    FROM dc_memory_bridge_outbox o
    INNER JOIN dc_interactions i
      ON i.id = o.interaction_id AND i.user_id = o.user_id
    WHERE o.status = 'completed'
      AND i.status = 'confirmed'
      AND i.source_state = 'server_cleaned'
    ORDER BY o.updated_at, o.id
  `).all() as Array<{
    id: string;
    user_id: string;
    idempotency_key: string;
    payload_digest: string;
    source_upload_id: string;
  }>;
  const pendingIds: Array<{ id: string; userId: string }> = [];
  for (const candidate of candidates) {
    const projected = input.memoryDatabase.prepare(`
      SELECT payload_digest FROM dc_memory_bridge_receipts
      WHERE account_id = ? AND idempotency_key = ?
    `).get(
      candidate.user_id,
      dateCompanionMemoryProjectionIdempotencyKey(candidate.idempotency_key)
    ) as { payload_digest: string } | undefined;
    if (projected) {
      if (projected.payload_digest !== candidate.payload_digest) {
        throw new DcConflictError("memory_bridge_receipt_conflict");
      }
      continue;
    }
    const legacyReceipt = input.memoryDatabase.prepare(`
      SELECT payload_digest FROM dc_memory_bridge_receipts
      WHERE account_id = ? AND idempotency_key = ?
    `).get(candidate.user_id, candidate.idempotency_key) as {
      payload_digest: string;
    } | undefined;
    if (!legacyReceipt || legacyReceipt.payload_digest !== candidate.payload_digest) continue;
    if (input.memoryDatabase.prepare(`
      SELECT 1 FROM memory_upload_tombstones WHERE user_id = ? AND upload_id = ?
    `).get(candidate.user_id, candidate.source_upload_id)) continue;
    const retained = input.memoryDatabase.prepare(`
      SELECT status FROM dc_retained_uploads WHERE user_id = ? AND upload_id = ?
    `).get(candidate.user_id, candidate.source_upload_id) as { status: string } | undefined;
    if (retained?.status === "purged") continue;
    pendingIds.push({ id: candidate.id, userId: candidate.user_id });
  }
  if (pendingIds.length === 0) return { scanned: candidates.length, requeued: 0 };
  const now = input.now ?? new Date().toISOString();
  const requeued = input.dateCompanionDatabase.transaction(() => {
    let count = 0;
    const update = input.dateCompanionDatabase.prepare(`
      UPDATE dc_memory_bridge_outbox
      SET status = 'pending', claim_token = NULL, lease_expires_at = NULL,
          last_error_code = NULL, completed_at = NULL, updated_at = ?
      WHERE id = ? AND user_id = ? AND status = 'completed'
    `);
    for (const candidate of pendingIds) {
      count += update.run(now, candidate.id, candidate.userId).changes;
    }
    return count;
  })();
  if (requeued > 0) {
    console.info(
      `[date-companion-memory-bridge] projection_repair_requeued=${requeued} scanned=${candidates.length}`
    );
  }
  return { scanned: candidates.length, requeued };
}

function isLegacyProjectionReplay(input: {
  memoryDatabase: Database.Database;
  userId: string;
  outboxId: string;
  idempotencyKey: string;
}) {
  const receipts = input.memoryDatabase.prepare(`
    SELECT idempotency_key
    FROM dc_memory_bridge_receipts
    WHERE account_id = ? AND dc_outbox_id = ?
  `).all(input.userId, input.outboxId) as Array<{
    idempotency_key: string;
  }>;
  const currentProjectionKey = dateCompanionMemoryProjectionIdempotencyKey(input.idempotencyKey);
  const currentProjection = receipts.find((receipt) =>
    receipt.idempotency_key === currentProjectionKey
  );
  if (currentProjection) {
    return false;
  }
  // A prior legacy or formal projection for this durable outbox means a repair
  // must first remove bridge-owned Person/Relationship projections. The
  // current key/digest may legitimately differ after a reviewed mapping repair.
  return receipts.length > 0;
}

export async function processNextDateCompanionMemoryBridge(input: {
  dateCompanionDatabase: Database.Database;
  memoryDatabase: Database.Database;
  now?: string;
  leaseMs?: number;
  afterMemoryCommit?: () => void | Promise<void>;
}) {
  const scanTime = legacyProjectionScanTime(input.now);
  const previousScanTime = legacyProjectionScanTimes.get(input.dateCompanionDatabase);
  if (
    previousScanTime === undefined
    || scanTime < previousScanTime
    || scanTime - previousScanTime >= LEGACY_PROJECTION_SCAN_INTERVAL_MS
  ) {
    requeueCompletedLegacyMemoryProjections(input);
    legacyProjectionScanTimes.set(input.dateCompanionDatabase, scanTime);
  }
  const repository = createDateCompanionMemoryBridgeRepository(input.dateCompanionDatabase);
  const claim = repository.claimNext({ now: input.now, leaseMs: input.leaseMs });
  return processClaim({ ...input, repository, claim });
}

export async function processDateCompanionMemoryBridgeInteraction(input: {
  dateCompanionDatabase: Database.Database;
  memoryDatabase: Database.Database;
  userId: string;
  interactionId: string;
  now?: string;
  leaseMs?: number;
  afterMemoryCommit?: () => void | Promise<void>;
}) {
  const repository = createDateCompanionMemoryBridgeRepository(input.dateCompanionDatabase);
  const claim = repository.claimInteraction({
    userId: input.userId,
    interactionId: input.interactionId,
    now: input.now,
    leaseMs: input.leaseMs
  });
  return processClaim({ ...input, repository, claim });
}

async function processClaim(input: {
  dateCompanionDatabase: Database.Database;
  memoryDatabase: Database.Database;
  repository: ReturnType<typeof createDateCompanionMemoryBridgeRepository>;
  claim: ReturnType<ReturnType<typeof createDateCompanionMemoryBridgeRepository>["claimNext"]>;
  afterMemoryCommit?: () => void | Promise<void>;
}) {
  const { repository, claim } = input;
  if (!claim) return null;
  try {
    const legacyProjectionReplay = isLegacyProjectionReplay({
      memoryDatabase: input.memoryDatabase,
      userId: claim.userId,
      outboxId: claim.outboxId,
      idempotencyKey: claim.idempotencyKey
    });
    revalidateDcClaim({
      dateCompanionDatabase: input.dateCompanionDatabase,
      userId: claim.userId,
      outboxId: claim.outboxId,
      claimToken: claim.claimToken,
      payload: claim.payload,
      payloadDigest: claim.payloadDigest,
      allowConsumedRelationshipReview: legacyProjectionReplay,
      evidence: claim.evidence
    });
    const recapEvidence = loadConfirmedRecapEvidence({
      database: input.dateCompanionDatabase,
      userId: claim.userId,
      payload: claim.payload
    });
    const candidates = buildAdmissionCandidates({
      accountId: claim.userId,
      payload: claim.payload,
      evidence: recapEvidence
    });
    const result = applyBridgeToMemory({
      database: input.memoryDatabase,
      accountId: claim.userId,
      outboxId: claim.outboxId,
      idempotencyKey: claim.idempotencyKey,
      payloadDigest: claim.payloadDigest,
      payload: claim.payload,
      recapEvidence,
      candidates,
      legacyProjectionReplay,
      evidence: claim.evidence
    });
    await input.afterMemoryCommit?.();
    repository.complete({
      userId: claim.userId,
      outboxId: claim.outboxId,
      claimToken: claim.claimToken
    });
    return { outboxId: claim.outboxId, completed: true, idempotent: result.idempotent };
  } catch (error) {
    const code = error instanceof DcConflictError ? error.code : "memory_bridge_failed";
    repository.fail({
      userId: claim.userId,
      outboxId: claim.outboxId,
      claimToken: claim.claimToken,
      errorCode: code,
      needsReview: error instanceof DcConflictError
    });
    throw error;
  }
}
