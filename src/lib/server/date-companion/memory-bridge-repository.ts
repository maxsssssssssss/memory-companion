import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { DcMemorySubject } from "@/lib/domain/date-companion-stage2";
import {
  DcConflictError,
  DcNotFoundError,
  DcValidationError,
  DcVersionConflictError
} from "./errors";
import {
  dateCompanionEvidenceDigest,
  stableBridgeDigest
} from "./memory-bridge-digest";
import {
  validateDateCompanionSubjectSuggestionConfirmation,
  type DcSubjectSuggestionConfirmation
} from "./subject-suggestions";

const RelationshipTypeSchema = z.enum(["dating", "partner", "friend", "other"]);
const SubjectSchema = z.enum(["self", "companion", "both", "unknown"]);
const RelationshipReviewSchema = z.object({
  kind: z.literal("reconfirm_archived_relationship"),
  authorizationId: z.string().min(1),
  epoch: z.number().int().positive(),
  personRelationshipId: z.string().min(1),
  expectedAdmissionVersion: z.number().int().positive(),
  expectedSelfBindingVersion: z.number().int().positive(),
  batchId: z.string().min(1),
  evidenceDigest: z.string().length(64),
  proposalDigest: z.string().length(64),
  confirmationFingerprint: z.string().length(64),
  confirmedAt: z.string().datetime()
}).strict();
const BridgePayloadSchema = z.object({
  version: z.literal(1),
  userId: z.string().min(1),
  relationshipId: z.string().min(1),
  interactionId: z.string().min(1),
  sourceUploadId: z.string().min(1),
  sourceVersion: z.number().int().nonnegative(),
  confirmationFingerprint: z.string().min(1),
  relationshipEpoch: z.number().int().nonnegative().optional(),
  mapping: z.object({
    version: z.number().int().positive(),
    selfPersonId: z.string().min(1),
    companionPersonId: z.string().min(1),
    relationshipType: RelationshipTypeSchema
  }).strict().nullable(),
  relationshipReview: RelationshipReviewSchema.optional(),
  selections: z.array(z.object({
    evidenceSnapshotId: z.string().min(1),
    recapItemId: z.string().min(1),
    uploadId: z.string().min(1),
    sourceSegmentId: z.string().min(1),
    contentDigest: z.string().length(64),
    subject: SubjectSchema
  }).strict())
}).strict();

export type DcMemoryAdmissionInput = {
  mappingVersion: number;
  subjectSuggestionConfirmation?: DcSubjectSuggestionConfirmation;
  relationshipReviewFence?: {
    authorizationId: string;
    epoch: number;
    personRelationshipId: string;
    expectedAdmissionVersion: number;
    expectedSelfBindingVersion: number;
  };
  selections: Array<{
    evidenceSnapshotId: string;
    subject: DcMemorySubject;
  }>;
};

export type DcMemoryBridgePayload = z.infer<typeof BridgePayloadSchema>;

type MappingRow = {
  id: string;
  self_person_id: string;
  companion_person_id: string;
  relationship_type: "dating" | "partner" | "friend" | "other";
  status: "confirmed" | "needs_review" | "archived";
  version: number;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
};

type OutboxRow = {
  id: string;
  user_id: string;
  relationship_id: string;
  interaction_id: string;
  idempotency_key: string;
  payload_digest: string;
  payload_json: string;
  mapping_version: number | null;
  source_version: number;
  confirmation_fingerprint: string;
  status: "pending" | "processing" | "completed" | "retryable_failed" | "needs_review" | "cancelled";
  attempt_count: number;
  claim_token: string | null;
  lease_expires_at: string | null;
  last_error_code: string | null;
  requested_at: string;
  updated_at: string;
  completed_at: string | null;
};

type EvidenceRow = {
  id: string;
  recap_item_id: string;
  upload_id: string;
  source_segment_id: string;
  start_seconds: number;
  end_seconds: number;
  speaker_id: string | null;
  quote: string;
  content_digest: string | null;
};

type RelationshipReconfirmationAuthorizationRow = {
  id: string;
  user_id: string;
  relationship_id: string;
  interaction_id: string;
  person_relationship_id: string;
  action: "reconfirm_archived_relationship";
  idempotency_key: string;
  epoch: number;
  expected_admission_version: number;
  expected_self_binding_version: number;
  mapping_version: number;
  interaction_version: number;
  batch_id: string;
  evidence_digest: string;
  proposal_digest: string;
  confirmation_fingerprint: string;
  status: "authorized" | "consumed" | "cancelled";
  created_at: string;
  updated_at: string;
  consumed_at: string | null;
};

function bridgeReview(status: OutboxRow["status"], errorCode: string | null) {
  if (status !== "needs_review") return null;
  if (errorCode === "person_relationship_requires_review") {
    return {
      kind: "relationship_reconfirmation_required" as const,
      canReconfirm: true,
      reason: "relationship_was_archived" as const,
      nextAction: "reconfirm_archived_relationship" as const
    };
  }
  if (
    errorCode === null
    || errorCode === "memory_bridge_mapping_required"
    || errorCode === "memory_bridge_mapping_stale"
    || errorCode === "active_self_binding_required"
    || errorCode === "self_and_companion_must_differ"
  ) {
    return {
      kind: "mapping_review_required" as const,
      canReconfirm: false,
      reason: "person_mapping_changed" as const,
      nextAction: "review_person_mapping" as const
    };
  }
  return {
    kind: "evidence_review_required" as const,
    canReconfirm: false,
    reason: "source_evidence_changed" as const,
    nextAction: "review_source_evidence" as const
  };
}

function stableId(prefix: string, ...values: string[]) {
  return `${prefix}_${createHash("sha256")
    .update(values.join("\u0000"))
    .digest("hex")
    .slice(0, 32)}`;
}

function safeErrorCode(value: string) {
  const normalized = value.trim();
  return /^[A-Za-z0-9_-]{1,120}$/u.test(normalized)
    ? normalized
    : "memory_bridge_failed";
}

function requireRelationship(database: Database.Database, userId: string, relationshipId: string) {
  const row = database.prepare(`
    SELECT status FROM dc_relationships WHERE id = ? AND user_id = ?
  `).get(relationshipId, userId) as { status: "active" | "archived" } | undefined;
  if (!row) throw new DcNotFoundError("Relationship not found");
  if (row.status !== "active") throw new DcConflictError("relationship_archived");
}

function getSettingRow(database: Database.Database, userId: string) {
  return database.prepare(`
    SELECT enabled, version, created_at, updated_at, enabled_at, disabled_at
    FROM dc_memory_retention_settings WHERE user_id = ?
  `).get(userId) as {
    enabled: 0 | 1;
    version: number;
    created_at: string;
    updated_at: string;
    enabled_at: string | null;
    disabled_at: string | null;
  } | undefined;
}

function retentionEnabled(row: ReturnType<typeof getSettingRow>) {
  return row ? row.enabled === 1 : true;
}

function settingDto(row: ReturnType<typeof getSettingRow>, now = new Date().toISOString()) {
  return row ? {
    enabled: row.enabled === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    enabledAt: row.enabled_at,
    disabledAt: row.disabled_at
  } : {
    enabled: true,
    version: 0,
    createdAt: now,
    updatedAt: now,
    enabledAt: null,
    disabledAt: null
  };
}

function getMappingRow(
  database: Database.Database,
  userId: string,
  relationshipId: string
) {
  return database.prepare(`
    SELECT id, self_person_id, companion_person_id, relationship_type, status,
           version, confirmed_at, created_at, updated_at
    FROM dc_relationship_person_mappings
    WHERE user_id = ? AND relationship_id = ?
  `).get(userId, relationshipId) as MappingRow | undefined;
}

function mappingDto(row: MappingRow) {
  return {
    id: row.id,
    selfPersonId: row.self_person_id,
    companionPersonId: row.companion_person_id,
    relationshipType: row.relationship_type,
    status: row.status,
    version: row.version,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function verifiedKeptEvidence(
  database: Database.Database,
  userId: string,
  interactionId: string
) {
  const rows = database.prepare(`
    SELECT e.id, e.recap_item_id, e.upload_id, e.source_segment_id,
           e.start_seconds, e.end_seconds, e.speaker_id, e.quote, e.content_digest
    FROM dc_evidence_snapshots e
    INNER JOIN dc_recap_items r
      ON r.id = e.recap_item_id AND r.user_id = e.user_id
    WHERE e.user_id = ? AND r.interaction_id = ? AND r.disposition = 'kept'
    ORDER BY e.id
  `).all(userId, interactionId) as EvidenceRow[];
  for (const row of rows) {
    const digest = dateCompanionEvidenceDigest({
      userId,
      uploadId: row.upload_id,
      sourceSegmentId: row.source_segment_id,
      startSeconds: row.start_seconds,
      endSeconds: row.end_seconds,
      speakerId: row.speaker_id,
      quote: row.quote
    });
    if (!row.content_digest || row.content_digest !== digest) {
      throw new DcConflictError("evidence_digest_conflict");
    }
  }
  return rows;
}

function authorizeArchivedRelationshipReconfirmation(input: {
  database: Database.Database;
  memoryDatabase: Database.Database;
  userId: string;
  relationshipId: string;
  interactionId: string;
  interactionVersion: number;
  mapping: MappingRow;
  existingOutbox: OutboxRow;
  idempotencyKey: string;
  confirmation: DcSubjectSuggestionConfirmation;
  selections: DcMemoryAdmissionInput["selections"];
}) {
  if (
    input.existingOutbox.status !== "needs_review"
    || input.existingOutbox.last_error_code !== "person_relationship_requires_review"
  ) {
    throw new DcConflictError("relationship_reconfirmation_not_available");
  }
  if (input.selections.every((selection) => selection.subject === "unknown")) {
    throw new DcConflictError("relationship_reconfirmation_evidence_required");
  }
  if (input.mapping.status !== "confirmed") {
    throw new DcConflictError("memory_bridge_mapping_stale");
  }
  const evidenceRows = verifiedKeptEvidence(input.database, input.userId, input.interactionId);
  const batch = validateDateCompanionSubjectSuggestionConfirmation({
    database: input.database,
    userId: input.userId,
    interactionId: input.interactionId,
    interactionVersion: input.interactionVersion,
    mappingVersion: input.mapping.version,
    confirmation: input.confirmation,
    selections: input.selections,
    keptEvidenceSnapshotIds: evidenceRows.map((row) => row.id)
  });
  const people = input.memoryDatabase.prepare(`
    SELECT id FROM person_entities
    WHERE account_id = ? AND id IN (?, ?) AND status = 'confirmed'
    ORDER BY id
  `).all(
    input.userId,
    input.mapping.self_person_id,
    input.mapping.companion_person_id
  ) as Array<{ id: string }>;
  if (people.length !== 2) throw new DcConflictError("memory_bridge_mapping_stale");
  const selfBinding = input.memoryDatabase.prepare(`
    SELECT person_id, status, version FROM person_self_bindings WHERE account_id = ?
  `).get(input.userId) as { person_id: string | null; status: string; version: number } | undefined;
  if (
    selfBinding?.status !== "active"
    || selfBinding.person_id !== input.mapping.self_person_id
  ) throw new DcConflictError("active_self_binding_required");

  const [personAId, personBId] = [
    input.mapping.self_person_id,
    input.mapping.companion_person_id
  ].sort();
  const personRelationshipId = stableId(
    "person_relationship",
    input.userId,
    personAId,
    personBId,
    input.mapping.relationship_type
  );
  const relationship = input.memoryDatabase.prepare(`
    SELECT r.person_a_id, r.person_b_id, r.type, r.status, r.explicitly_confirmed,
           a.version AS admission_version,
           l.person_relationship_id AS linked_relationship_id,
           l.mapping_version AS linked_mapping_version,
           l.self_person_id AS linked_self_person_id,
           l.companion_person_id AS linked_companion_person_id,
           l.relationship_type AS linked_relationship_type,
           l.status AS link_status
    FROM person_relationships r
    INNER JOIN person_relationship_admissions a
      ON a.account_id = r.account_id AND a.relationship_id = r.id
    LEFT JOIN dc_person_relationship_links l
      ON l.account_id = r.account_id AND l.dc_relationship_id = ?
    WHERE r.id = ? AND r.account_id = ?
  `).get(
    input.relationshipId,
    personRelationshipId,
    input.userId
  ) as {
    person_a_id: string;
    person_b_id: string;
    type: string;
    status: string;
    explicitly_confirmed: number;
    admission_version: number;
    linked_relationship_id: string | null;
    linked_mapping_version: number | null;
    linked_self_person_id: string | null;
    linked_companion_person_id: string | null;
    linked_relationship_type: string | null;
    link_status: string | null;
  } | undefined;
  if (
    !relationship
    || relationship.person_a_id !== personAId
    || relationship.person_b_id !== personBId
    || relationship.type !== input.mapping.relationship_type
    || relationship.status !== "archived"
    || relationship.explicitly_confirmed !== 0
    || relationship.linked_relationship_id !== personRelationshipId
    || relationship.linked_mapping_version !== input.mapping.version
    || relationship.linked_self_person_id !== input.mapping.self_person_id
    || relationship.linked_companion_person_id !== input.mapping.companion_person_id
    || relationship.linked_relationship_type !== input.mapping.relationship_type
    || relationship.link_status !== "archived"
  ) throw new DcConflictError("relationship_reconfirmation_state_changed");

  const existing = input.database.prepare(`
    SELECT * FROM dc_relationship_reconfirmation_authorizations
    WHERE user_id = ? AND idempotency_key = ?
  `).get(input.userId, input.idempotencyKey) as RelationshipReconfirmationAuthorizationRow | undefined;
  if (existing) {
    if (
      existing.status !== "authorized"
      || existing.relationship_id !== input.relationshipId
      || existing.interaction_id !== input.interactionId
      || existing.person_relationship_id !== personRelationshipId
      || existing.expected_admission_version !== relationship.admission_version
      || existing.expected_self_binding_version !== selfBinding.version
      || existing.mapping_version !== input.mapping.version
      || existing.interaction_version !== input.interactionVersion
      || existing.batch_id !== batch.batchId
      || existing.evidence_digest !== batch.evidenceDigest
      || existing.proposal_digest !== batch.proposalDigest
      || existing.confirmation_fingerprint !== batch.confirmationFingerprint
    ) throw new DcConflictError("relationship_reconfirmation_idempotency_conflict");
    return {
      authorizationId: existing.id,
      epoch: existing.epoch,
      personRelationshipId,
      expectedAdmissionVersion: existing.expected_admission_version,
      expectedSelfBindingVersion: existing.expected_self_binding_version
    };
  }
  const active = input.database.prepare(`
    SELECT 1 FROM dc_relationship_reconfirmation_authorizations
    WHERE user_id = ? AND relationship_id = ? AND status = 'authorized'
  `).get(input.userId, input.relationshipId);
  if (active) throw new DcConflictError("relationship_reconfirmation_in_progress");
  const epochRow = input.database.prepare(`
    SELECT COALESCE(MAX(epoch), 0) + 1 AS epoch
    FROM dc_relationship_reconfirmation_authorizations
    WHERE user_id = ? AND relationship_id = ?
  `).get(input.userId, input.relationshipId) as { epoch: number };
  const now = new Date().toISOString();
  const authorizationId = stableId(
    "dc_relationship_reconfirmation",
    input.userId,
    input.relationshipId,
    String(epochRow.epoch),
    input.idempotencyKey
  );
  input.database.prepare(`
    INSERT INTO dc_relationship_reconfirmation_authorizations (
      id, user_id, relationship_id, interaction_id, person_relationship_id,
      action, idempotency_key, epoch, expected_admission_version,
      expected_self_binding_version, mapping_version, interaction_version,
      batch_id, evidence_digest, proposal_digest, confirmation_fingerprint,
      status, created_at, updated_at, consumed_at
    ) VALUES (?, ?, ?, ?, ?, 'reconfirm_archived_relationship', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      'authorized', ?, ?, NULL)
  `).run(
    authorizationId,
    input.userId,
    input.relationshipId,
    input.interactionId,
    personRelationshipId,
    input.idempotencyKey,
    epochRow.epoch,
    relationship.admission_version,
    selfBinding.version,
    input.mapping.version,
    input.interactionVersion,
    batch.batchId,
    batch.evidenceDigest,
    batch.proposalDigest,
    batch.confirmationFingerprint,
    now,
    now
  );
  return {
    authorizationId,
    epoch: epochRow.epoch,
    personRelationshipId,
    expectedAdmissionVersion: relationship.admission_version,
    expectedSelfBindingVersion: selfBinding.version
  };
}

function createFrozenOutbox(input: {
  database: Database.Database;
  userId: string;
  relationshipId: string;
  interactionId: string;
  sourceUploadId: string;
  sourceVersion: number;
  confirmationFingerprint: string;
  memoryAdmission?: DcMemoryAdmissionInput;
  allowRepair?: boolean;
}) {
  const setting = getSettingRow(input.database, input.userId);
  if (!retentionEnabled(setting)) {
    if (input.memoryAdmission) throw new DcConflictError("memory_retention_disabled");
    return null;
  }
  const evidenceRows = verifiedKeptEvidence(input.database, input.userId, input.interactionId);
  const submitted = new Map<string, DcMemorySubject>();
  for (const selection of input.memoryAdmission?.selections ?? []) {
    if (submitted.has(selection.evidenceSnapshotId)) {
      throw new DcValidationError("duplicate_memory_evidence_selection");
    }
    submitted.set(selection.evidenceSnapshotId, SubjectSchema.parse(selection.subject));
  }
  const evidenceById = new Map(evidenceRows.map((row) => [row.id, row]));
  for (const evidenceSnapshotId of submitted.keys()) {
    if (!evidenceById.has(evidenceSnapshotId)) {
      throw new DcValidationError("memory_evidence_selection_not_kept");
    }
  }

  if (input.memoryAdmission) {
    const confirmation = input.memoryAdmission.subjectSuggestionConfirmation;
    if (!confirmation && !input.allowRepair) {
      throw new DcConflictError("subject_suggestion_confirmation_required");
    }
    if (confirmation) {
      const interactionVersion = input.database.prepare(`
        SELECT version FROM dc_interactions WHERE user_id = ? AND id = ?
      `).get(input.userId, input.interactionId) as { version: number } | undefined;
      if (!interactionVersion) throw new DcNotFoundError("Interaction not found");
      validateDateCompanionSubjectSuggestionConfirmation({
        database: input.database,
        userId: input.userId,
        interactionId: input.interactionId,
        interactionVersion: interactionVersion.version,
        mappingVersion: input.memoryAdmission.mappingVersion,
        confirmation,
        selections: input.memoryAdmission.selections,
        keptEvidenceSnapshotIds: evidenceRows.map((row) => row.id)
      });
    }
    if (input.memoryAdmission.relationshipReviewFence && !confirmation) {
      throw new DcConflictError("subject_suggestion_confirmation_required");
    }
  }

  const mapping = getMappingRow(input.database, input.userId, input.relationshipId);
  const mappingCurrent = mapping?.status === "confirmed"
    && (!input.memoryAdmission || mapping.version === input.memoryAdmission.mappingVersion);
  const selections = evidenceRows.map((row) => ({
    evidenceSnapshotId: row.id,
    recapItemId: row.recap_item_id,
    uploadId: row.upload_id,
    sourceSegmentId: row.source_segment_id,
    contentDigest: row.content_digest as string,
    subject: submitted.get(row.id) ?? "unknown" as const
  }));
  const now = new Date().toISOString();
  const relationshipReview = input.memoryAdmission?.relationshipReviewFence
    && input.memoryAdmission.subjectSuggestionConfirmation
    ? {
        kind: "reconfirm_archived_relationship" as const,
        authorizationId: input.memoryAdmission.relationshipReviewFence.authorizationId,
        epoch: input.memoryAdmission.relationshipReviewFence.epoch,
        personRelationshipId: input.memoryAdmission.relationshipReviewFence.personRelationshipId,
        expectedAdmissionVersion: input.memoryAdmission.relationshipReviewFence.expectedAdmissionVersion,
        expectedSelfBindingVersion: input.memoryAdmission.relationshipReviewFence.expectedSelfBindingVersion,
        batchId: input.memoryAdmission.subjectSuggestionConfirmation.batchId,
        evidenceDigest: input.memoryAdmission.subjectSuggestionConfirmation.evidenceDigest,
        proposalDigest: input.memoryAdmission.subjectSuggestionConfirmation.proposalDigest,
        confirmationFingerprint: input.memoryAdmission.subjectSuggestionConfirmation.confirmationFingerprint,
        confirmedAt: now
      }
    : undefined;
  const relationshipEpoch = (input.database.prepare(`
    SELECT COALESCE(MAX(epoch), 0) AS epoch
    FROM dc_relationship_reconfirmation_authorizations
    WHERE user_id = ? AND relationship_id = ? AND status IN ('authorized', 'consumed')
  `).get(input.userId, input.relationshipId) as { epoch: number }).epoch;
  const payload = BridgePayloadSchema.parse({
    version: 1,
    userId: input.userId,
    relationshipId: input.relationshipId,
    interactionId: input.interactionId,
    sourceUploadId: input.sourceUploadId,
    sourceVersion: input.sourceVersion,
    confirmationFingerprint: input.confirmationFingerprint,
    relationshipEpoch,
    mapping: mappingCurrent && mapping ? {
      version: mapping.version,
      selfPersonId: mapping.self_person_id,
      companionPersonId: mapping.companion_person_id,
      relationshipType: mapping.relationship_type
    } : null,
    ...(relationshipReview ? { relationshipReview } : {}),
    selections
  });
  const payloadDigest = stableBridgeDigest(payload);
  const idempotencyKey = stableId(
    "dc_memory_sync",
    input.userId,
    input.interactionId,
    input.confirmationFingerprint,
    String(payload.mapping?.version ?? input.memoryAdmission?.mappingVersion ?? 0),
    String(relationshipEpoch)
  );
  const outboxId = stableId("dc_memory_outbox", input.userId, input.interactionId);
  const existing = input.database.prepare(`
    SELECT * FROM dc_memory_bridge_outbox WHERE user_id = ? AND interaction_id = ?
  `).get(input.userId, input.interactionId) as OutboxRow | undefined;
  if (existing) {
    if (existing.payload_digest === payloadDigest) return existing;
    if (!input.allowRepair || existing.status !== "needs_review") {
      throw new DcConflictError("memory_bridge_payload_conflict");
    }
    input.database.prepare(`
      UPDATE dc_memory_bridge_outbox
      SET idempotency_key = ?, payload_digest = ?, payload_json = ?, mapping_version = ?,
          source_version = ?, confirmation_fingerprint = ?, status = ?,
          claim_token = NULL, lease_expires_at = NULL, last_error_code = NULL,
          updated_at = ?
      WHERE id = ? AND user_id = ? AND status = 'needs_review'
    `).run(
      idempotencyKey,
      payloadDigest,
      JSON.stringify(payload),
      payload.mapping?.version ?? null,
      input.sourceVersion,
      input.confirmationFingerprint,
      payload.mapping ? "pending" : "needs_review",
      now,
      existing.id,
      input.userId
    );
  } else {
    input.database.prepare(`
      INSERT INTO dc_memory_bridge_outbox (
        id, user_id, relationship_id, interaction_id, idempotency_key,
        payload_digest, payload_json, mapping_version, source_version,
        confirmation_fingerprint, status, attempt_count, requested_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      outboxId,
      input.userId,
      input.relationshipId,
      input.interactionId,
      idempotencyKey,
      payloadDigest,
      JSON.stringify(payload),
      payload.mapping?.version ?? null,
      input.sourceVersion,
      input.confirmationFingerprint,
      payload.mapping ? "pending" : "needs_review",
      now,
      now
    );
  }

  const insertSelection = input.database.prepare(`
    INSERT INTO dc_memory_subject_selections (
      id, user_id, relationship_id, interaction_id, recap_item_id,
      evidence_snapshot_id, subject, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(user_id, evidence_snapshot_id) DO NOTHING
  `);
  for (const selection of selections) {
    const existingSelection = input.database.prepare(`
      SELECT subject, version FROM dc_memory_subject_selections
      WHERE user_id = ? AND evidence_snapshot_id = ?
    `).get(input.userId, selection.evidenceSnapshotId) as {
      subject: string;
      version: number;
    } | undefined;
    if (existingSelection && existingSelection.subject !== selection.subject) {
      if (!input.allowRepair || existingSelection.subject !== "unknown") {
        throw new DcConflictError("memory_subject_selection_conflict");
      }
      input.database.prepare(`
        UPDATE dc_memory_subject_selections
        SET subject = ?, version = version + 1, updated_at = ?
        WHERE user_id = ? AND evidence_snapshot_id = ?
          AND subject = 'unknown' AND version = ?
      `).run(
        selection.subject,
        now,
        input.userId,
        selection.evidenceSnapshotId,
        existingSelection.version
      );
      continue;
    }
    insertSelection.run(
      stableId("dc_memory_subject", input.userId, selection.evidenceSnapshotId),
      input.userId,
      input.relationshipId,
      input.interactionId,
      selection.recapItemId,
      selection.evidenceSnapshotId,
      selection.subject,
      now,
      now
    );
  }
  return input.database.prepare(`
    SELECT * FROM dc_memory_bridge_outbox WHERE id = ? AND user_id = ?
  `).get(outboxId, input.userId) as OutboxRow;
}

export function finalizeDateCompanionMemoryAdmission(input: {
  database: Database.Database;
  userId: string;
  relationshipId: string;
  interactionId: string;
  sourceUploadId: string;
  sourceVersion: number;
  confirmationFingerprint: string;
  memoryAdmission?: DcMemoryAdmissionInput;
}) {
  return createFrozenOutbox(input);
}

export function prepareMemoryBridgeInteractionDeletion(
  database: Database.Database,
  userId: string,
  interactionId: string,
  now = new Date().toISOString()
) {
  const row = database.prepare(`
    SELECT status, lease_expires_at
    FROM dc_memory_bridge_outbox
    WHERE user_id = ? AND interaction_id = ?
  `).get(userId, interactionId) as Pick<OutboxRow, "status" | "lease_expires_at"> | undefined;
  if (!row || row.status === "completed" || row.status === "cancelled") return;
  if (
    row.status === "processing"
    && row.lease_expires_at
    && Date.parse(row.lease_expires_at) > Date.parse(now)
  ) {
    throw new DcConflictError("memory_bridge_in_progress");
  }
  const result = database.prepare(`
    UPDATE dc_memory_bridge_outbox
    SET status = 'cancelled', claim_token = NULL, lease_expires_at = NULL,
        last_error_code = NULL, updated_at = ?
    WHERE user_id = ? AND interaction_id = ? AND status <> 'completed'
  `).run(now, userId, interactionId);
  if (result.changes !== 1) throw new DcConflictError("memory_bridge_delete_conflict");
  database.prepare(`
    UPDATE dc_relationship_reconfirmation_authorizations
    SET status = 'cancelled', updated_at = ?
    WHERE user_id = ? AND interaction_id = ? AND status = 'authorized'
  `).run(now, userId, interactionId);
}

export class DateCompanionMemoryBridgeRepository {
  constructor(private readonly database: Database.Database) {}

  getRetentionSetting(userId: string) {
    return settingDto(getSettingRow(this.database, userId));
  }

  putRetentionSetting(input: { userId: string; enabled: boolean; expectedVersion: number }) {
    return this.database.transaction(() => {
      const row = getSettingRow(this.database, input.userId);
      const currentVersion = row?.version ?? 0;
      if (input.expectedVersion !== currentVersion) {
        throw new DcVersionConflictError(currentVersion);
      }
      if (row && retentionEnabled(row) === input.enabled) return settingDto(row);
      const now = new Date().toISOString();
      const nextVersion = currentVersion + 1;
      this.database.prepare(`
        INSERT INTO dc_memory_retention_settings (
          user_id, enabled, version, created_at, updated_at, enabled_at, disabled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          enabled = excluded.enabled, version = excluded.version,
          updated_at = excluded.updated_at, enabled_at = excluded.enabled_at,
          disabled_at = excluded.disabled_at
      `).run(
        input.userId,
        input.enabled ? 1 : 0,
        nextVersion,
        row?.created_at ?? now,
        now,
        input.enabled ? now : null,
        input.enabled ? null : now
      );
      this.database.prepare(`
        INSERT INTO dc_memory_retention_setting_audits (
          id, user_id, previous_enabled, enabled, resulting_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        stableId("dc_memory_setting_audit", input.userId, String(nextVersion)),
        input.userId,
        retentionEnabled(row) ? 1 : 0,
        input.enabled ? 1 : 0,
        nextVersion,
        now
      );
      return settingDto(getSettingRow(this.database, input.userId));
    })();
  }

  getPersonMapping(userId: string, relationshipId: string) {
    requireRelationship(this.database, userId, relationshipId);
    const row = getMappingRow(this.database, userId, relationshipId);
    return row ? mappingDto(row) : null;
  }

  putPersonMapping(input: {
    userId: string;
    relationshipId: string;
    selfPersonId: string;
    companionPersonId: string;
    relationshipType: "dating" | "partner" | "friend" | "other";
    expectedVersion: number;
  }) {
    return this.database.transaction(() => {
      requireRelationship(this.database, input.userId, input.relationshipId);
      if (input.selfPersonId === input.companionPersonId) {
        throw new DcValidationError("self_and_companion_must_differ");
      }
      const relationshipType = RelationshipTypeSchema.parse(input.relationshipType);
      const row = getMappingRow(this.database, input.userId, input.relationshipId);
      const currentVersion = row?.version ?? 0;
      if (input.expectedVersion !== currentVersion) {
        throw new DcVersionConflictError(currentVersion);
      }
      if (
        row?.status === "confirmed"
        && row.self_person_id === input.selfPersonId
        && row.companion_person_id === input.companionPersonId
        && row.relationship_type === relationshipType
      ) return mappingDto(row);
      const frozenProjection = this.database.prepare(`
        SELECT o.status
        FROM dc_memory_bridge_outbox o
        INNER JOIN dc_interactions i
          ON i.id = o.interaction_id AND i.user_id = o.user_id
        WHERE o.user_id = ? AND i.relationship_id = ?
          AND o.status IN ('pending', 'processing', 'retryable_failed', 'completed')
        LIMIT 1
      `).get(input.userId, input.relationshipId);
      if (frozenProjection) {
        throw new DcConflictError("person_mapping_change_requires_review");
      }
      const now = new Date().toISOString();
      const version = currentVersion + 1;
      const id = row?.id ?? stableId("dc_person_mapping", input.userId, input.relationshipId);
      this.database.prepare(`
        INSERT INTO dc_relationship_person_mappings (
          id, user_id, relationship_id, self_person_id, companion_person_id,
          relationship_type, status, version, confirmed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?)
        ON CONFLICT(user_id, relationship_id) DO UPDATE SET
          self_person_id = excluded.self_person_id,
          companion_person_id = excluded.companion_person_id,
          relationship_type = excluded.relationship_type,
          status = 'confirmed', version = excluded.version,
          confirmed_at = excluded.confirmed_at, updated_at = excluded.updated_at
      `).run(
        id,
        input.userId,
        input.relationshipId,
        input.selfPersonId,
        input.companionPersonId,
        relationshipType,
        version,
        now,
        row?.created_at ?? now,
        now
      );
      this.database.prepare(`
        INSERT INTO dc_relationship_person_mapping_audits (
          id, user_id, relationship_id, mapping_id, self_person_id,
          companion_person_id, relationship_type, status, resulting_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)
      `).run(
        stableId("dc_person_mapping_audit", input.userId, input.relationshipId, String(version)),
        input.userId,
        input.relationshipId,
        id,
        input.selfPersonId,
        input.companionPersonId,
        relationshipType,
        version,
        now
      );
      return mappingDto(getMappingRow(this.database, input.userId, input.relationshipId) as MappingRow);
    })();
  }

  getInteractionBridgeStatus(userId: string, interactionId: string) {
    const row = this.database.prepare(`
      SELECT o.*, i.source_state
      FROM dc_memory_bridge_outbox o
      INNER JOIN dc_interactions i ON i.id = o.interaction_id AND i.user_id = o.user_id
      WHERE o.user_id = ? AND o.interaction_id = ?
    `).get(userId, interactionId) as (OutboxRow & { source_state: string }) | undefined;
    if (!row) return null;
    const status = row.status === "pending" && row.source_state === "available"
      ? "waiting_for_cleanup" as const
      : row.status;
    const review = bridgeReview(row.status, row.last_error_code);
    return {
      status,
      attemptCount: row.attempt_count,
      updatedAt: row.updated_at,
      retryable: status === "retryable_failed" || status === "needs_review",
      ...(review ? { review } : {})
    };
  }

  getMemoryReview(userId: string, relationshipId: string) {
    requireRelationship(this.database, userId, relationshipId);
    const interactions = this.database.prepare(`
      SELECT i.id, i.source_upload_id, i.recording_date, i.source_state,
             o.status, o.attempt_count, o.updated_at, o.last_error_code,
             SUM(CASE WHEN s.subject = 'unknown' THEN 1 ELSE 0 END) AS unknown_count,
             COUNT(s.id) AS selection_count
      FROM dc_interactions i
      LEFT JOIN dc_memory_bridge_outbox o
        ON o.interaction_id = i.id AND o.user_id = i.user_id
      LEFT JOIN dc_memory_subject_selections s
        ON s.interaction_id = i.id AND s.user_id = i.user_id
      WHERE i.user_id = ? AND i.relationship_id = ? AND i.status = 'confirmed'
      GROUP BY i.id, o.id
      ORDER BY i.recording_date DESC, i.id
    `).all(userId, relationshipId) as Array<Record<string, string | number | null>>;
    return {
      retention: this.getRetentionSetting(userId),
      mapping: this.getPersonMapping(userId, relationshipId),
      interactions: interactions.map((row) => {
        const review = bridgeReview(
          (row.status ?? "pending") as OutboxRow["status"],
          typeof row.last_error_code === "string" ? row.last_error_code : null
        );
        return {
          interactionId: row.id,
          sourceUploadId: row.source_upload_id,
          recordingDate: row.recording_date,
          sourceState: row.source_state,
          status: row.status ?? "not_queued",
          attemptCount: Number(row.attempt_count ?? 0),
          selectionCount: Number(row.selection_count ?? 0),
          unknownCount: Number(row.unknown_count ?? 0),
          updatedAt: row.updated_at ?? null,
          ...(review ? { review } : {})
        };
      })
    };
  }

  queueInteractionSync(input: {
    userId: string;
    interactionId: string;
    mappingVersion: number;
    selections?: DcMemoryAdmissionInput["selections"];
    subjectSuggestionConfirmation?: DcSubjectSuggestionConfirmation;
    relationshipReconfirmation?: {
      action: "reconfirm_archived_relationship";
      idempotencyKey: string;
    };
    memoryDatabase?: Database.Database;
  }) {
    return this.database.transaction(() => {
      if (input.selections && !input.subjectSuggestionConfirmation) {
        throw new DcConflictError("subject_suggestion_confirmation_required");
      }
      if (
        input.relationshipReconfirmation
        && (!input.memoryDatabase || !input.selections || !input.subjectSuggestionConfirmation)
      ) throw new DcConflictError("relationship_reconfirmation_context_required");
      const interaction = this.database.prepare(`
        SELECT id, relationship_id, source_upload_id, status, source_state,
               version, confirmation_fingerprint, confirmed_at
        FROM dc_interactions WHERE id = ? AND user_id = ?
      `).get(input.interactionId, input.userId) as {
        id: string;
        relationship_id: string;
        source_upload_id: string;
        status: string;
        source_state: string;
        version: number;
        confirmation_fingerprint: string | null;
        confirmed_at: string | null;
      } | undefined;
      if (!interaction) throw new DcNotFoundError("Interaction not found");
      if (interaction.status !== "confirmed" || interaction.source_state === "explicitly_deleted") {
        throw new DcConflictError("interaction_not_syncable");
      }
      const existingOutbox = this.database.prepare(`
        SELECT * FROM dc_memory_bridge_outbox
        WHERE user_id = ? AND interaction_id = ?
      `).get(input.userId, input.interactionId) as OutboxRow | undefined;
      if (existingOutbox?.status === "completed" || existingOutbox?.status === "pending") {
        const existingPayload = BridgePayloadSchema.parse(JSON.parse(existingOutbox.payload_json));
        const requestedSelections = input.selections
          ? [...input.selections]
            .map((selection) => ({
              evidenceSnapshotId: selection.evidenceSnapshotId,
              subject: selection.subject
            }))
            .sort((left, right) => left.evidenceSnapshotId.localeCompare(right.evidenceSnapshotId))
          : null;
        const currentSelections = existingPayload.selections
          .map((selection) => ({
            evidenceSnapshotId: selection.evidenceSnapshotId,
            subject: selection.subject
          }))
          .sort((left, right) => left.evidenceSnapshotId.localeCompare(right.evidenceSnapshotId));
        if (
          existingPayload.mapping?.version !== input.mappingVersion
          || requestedSelections && stableBridgeDigest(requestedSelections) !== stableBridgeDigest(currentSelections)
        ) {
          throw new DcConflictError("memory_bridge_payload_conflict");
        }
        if (input.relationshipReconfirmation) {
          const authorization = this.database.prepare(`
            SELECT id FROM dc_relationship_reconfirmation_authorizations
            WHERE user_id = ? AND idempotency_key = ?
          `).get(input.userId, input.relationshipReconfirmation.idempotencyKey) as {
            id: string;
          } | undefined;
          if (!authorization || existingPayload.relationshipReview?.authorizationId !== authorization.id) {
            throw new DcConflictError("relationship_reconfirmation_idempotency_conflict");
          }
        }
        return existingOutbox;
      }
      if (existingOutbox?.status === "processing") {
        throw new DcConflictError("memory_bridge_in_progress");
      }
      if (existingOutbox?.status === "cancelled") {
        throw new DcConflictError("memory_bridge_cancelled");
      }
      if (existingOutbox?.status === "retryable_failed") {
        if (input.relationshipReconfirmation) {
          throw new DcConflictError("relationship_reconfirmation_not_available");
        }
        this.database.prepare(`
          UPDATE dc_memory_bridge_outbox
          SET status = 'pending', last_error_code = NULL, updated_at = ?
          WHERE id = ? AND user_id = ? AND status = 'retryable_failed'
        `).run(new Date().toISOString(), existingOutbox.id, input.userId);
        return this.database.prepare(`
          SELECT * FROM dc_memory_bridge_outbox WHERE id = ? AND user_id = ?
        `).get(existingOutbox.id, input.userId) as OutboxRow;
      }
      const fingerprint = interaction.confirmation_fingerprint
        ?? stableBridgeDigest({
          interactionId: interaction.id,
          confirmedAt: interaction.confirmed_at,
          version: interaction.version
        });
      const persistedSelections = this.database.prepare(`
        SELECT evidence_snapshot_id, subject
        FROM dc_memory_subject_selections
        WHERE user_id = ? AND interaction_id = ?
        ORDER BY evidence_snapshot_id
      `).all(input.userId, input.interactionId) as Array<{
        evidence_snapshot_id: string;
        subject: DcMemorySubject;
      }>;
      const mapping = getMappingRow(this.database, input.userId, interaction.relationship_id);
      if (input.relationshipReconfirmation && (!mapping || !existingOutbox)) {
        throw new DcConflictError("relationship_reconfirmation_not_available");
      }
      const relationshipReviewFence = input.relationshipReconfirmation
        ? authorizeArchivedRelationshipReconfirmation({
            database: this.database,
            memoryDatabase: input.memoryDatabase as Database.Database,
            userId: input.userId,
            relationshipId: interaction.relationship_id,
            interactionId: interaction.id,
            interactionVersion: interaction.version,
            mapping: mapping as MappingRow,
            existingOutbox: existingOutbox as OutboxRow,
            idempotencyKey: input.relationshipReconfirmation.idempotencyKey,
            confirmation: input.subjectSuggestionConfirmation as DcSubjectSuggestionConfirmation,
            selections: input.selections as DcMemoryAdmissionInput["selections"]
          })
        : undefined;
      return createFrozenOutbox({
        database: this.database,
        userId: input.userId,
        relationshipId: interaction.relationship_id,
        interactionId: interaction.id,
        sourceUploadId: interaction.source_upload_id,
        sourceVersion: interaction.version,
        confirmationFingerprint: fingerprint,
        memoryAdmission: {
          mappingVersion: input.mappingVersion,
          ...(input.subjectSuggestionConfirmation
            ? { subjectSuggestionConfirmation: input.subjectSuggestionConfirmation }
            : {}),
          ...(relationshipReviewFence
            ? { relationshipReviewFence }
            : {}),
          selections: input.selections ?? persistedSelections.map((selection) => ({
              evidenceSnapshotId: selection.evidence_snapshot_id,
              subject: selection.subject
            }))
        },
        allowRepair: true
      });
    })();
  }

  claimNext(input: { now?: string; leaseMs?: number } = {}) {
    return this.database.transaction(() => {
      const now = input.now ?? new Date().toISOString();
      const leaseMs = input.leaseMs ?? 5 * 60 * 1_000;
      const candidate = this.database.prepare(`
        SELECT o.*
        FROM dc_memory_bridge_outbox o
        INNER JOIN dc_interactions i
          ON i.id = o.interaction_id AND i.user_id = o.user_id
        WHERE i.source_state = 'server_cleaned'
          AND (
            o.status IN ('pending', 'retryable_failed') OR
            (o.status = 'processing' AND o.lease_expires_at <= ?)
          )
        ORDER BY o.updated_at, o.id
        LIMIT 1
      `).get(now) as OutboxRow | undefined;
      if (!candidate) return null;
      const claimToken = randomUUID();
      const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
      const claimed = this.database.prepare(`
        UPDATE dc_memory_bridge_outbox
        SET status = 'processing', attempt_count = attempt_count + 1,
            claim_token = ?, lease_expires_at = ?, last_error_code = NULL,
            updated_at = ?
        WHERE id = ? AND user_id = ? AND (
          status IN ('pending', 'retryable_failed') OR
          (status = 'processing' AND lease_expires_at <= ?)
        )
      `).run(
        claimToken,
        leaseExpiresAt,
        now,
        candidate.id,
        candidate.user_id,
        now
      );
      if (claimed.changes !== 1) return null;
      const evidence = this.database.prepare(`
        SELECT id, recap_item_id, upload_id, source_segment_id, start_seconds,
               end_seconds, speaker_id, quote, content_digest
        FROM dc_evidence_snapshots
        WHERE user_id = ? AND id IN (
          SELECT evidence_snapshot_id FROM dc_memory_subject_selections
          WHERE user_id = ? AND interaction_id = ?
        )
        ORDER BY id
      `).all(candidate.user_id, candidate.user_id, candidate.interaction_id) as EvidenceRow[];
      return {
        outboxId: candidate.id,
        userId: candidate.user_id,
        claimToken,
        leaseExpiresAt,
        idempotencyKey: candidate.idempotency_key,
        payloadDigest: candidate.payload_digest,
        payload: BridgePayloadSchema.parse(JSON.parse(candidate.payload_json)),
        evidence
      };
    })();
  }

  claimInteraction(input: {
    userId: string;
    interactionId: string;
    now?: string;
    leaseMs?: number;
  }) {
    return this.database.transaction(() => {
      const now = input.now ?? new Date().toISOString();
      const candidate = this.database.prepare(`
        SELECT o.*
        FROM dc_memory_bridge_outbox o
        INNER JOIN dc_interactions i
          ON i.id = o.interaction_id AND i.user_id = o.user_id
        WHERE o.user_id = ? AND o.interaction_id = ?
          AND i.source_state = 'server_cleaned'
          AND (
            o.status IN ('pending', 'retryable_failed') OR
            (o.status = 'processing' AND o.lease_expires_at <= ?)
          )
      `).get(input.userId, input.interactionId, now) as OutboxRow | undefined;
      if (!candidate) return null;
      const claimToken = randomUUID();
      const leaseExpiresAt = new Date(
        Date.parse(now) + (input.leaseMs ?? 5 * 60 * 1_000)
      ).toISOString();
      const claimed = this.database.prepare(`
        UPDATE dc_memory_bridge_outbox
        SET status = 'processing', attempt_count = attempt_count + 1,
            claim_token = ?, lease_expires_at = ?, last_error_code = NULL,
            updated_at = ?
        WHERE id = ? AND user_id = ? AND (
          status IN ('pending', 'retryable_failed') OR
          (status = 'processing' AND lease_expires_at <= ?)
        )
      `).run(
        claimToken,
        leaseExpiresAt,
        now,
        candidate.id,
        candidate.user_id,
        now
      );
      if (claimed.changes !== 1) return null;
      const evidence = this.database.prepare(`
        SELECT id, recap_item_id, upload_id, source_segment_id, start_seconds,
               end_seconds, speaker_id, quote, content_digest
        FROM dc_evidence_snapshots
        WHERE user_id = ? AND id IN (
          SELECT evidence_snapshot_id FROM dc_memory_subject_selections
          WHERE user_id = ? AND interaction_id = ?
        )
        ORDER BY id
      `).all(candidate.user_id, candidate.user_id, candidate.interaction_id) as EvidenceRow[];
      return {
        outboxId: candidate.id,
        userId: candidate.user_id,
        claimToken,
        leaseExpiresAt,
        idempotencyKey: candidate.idempotency_key,
        payloadDigest: candidate.payload_digest,
        payload: BridgePayloadSchema.parse(JSON.parse(candidate.payload_json)),
        evidence
      };
    })();
  }

  complete(input: { userId: string; outboxId: string; claimToken: string }) {
    return this.database.transaction(() => {
      const row = this.database.prepare(`
        SELECT payload_json FROM dc_memory_bridge_outbox
        WHERE id = ? AND user_id = ? AND status = 'processing' AND claim_token = ?
      `).get(input.outboxId, input.userId, input.claimToken) as { payload_json: string } | undefined;
      if (!row) throw new DcConflictError("memory_bridge_claim_lost");
      const payload = BridgePayloadSchema.parse(JSON.parse(row.payload_json));
      const now = new Date().toISOString();
      const result = this.database.prepare(`
        UPDATE dc_memory_bridge_outbox
        SET status = 'completed', claim_token = NULL, lease_expires_at = NULL,
            last_error_code = NULL, completed_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND status = 'processing' AND claim_token = ?
      `).run(now, now, input.outboxId, input.userId, input.claimToken);
      if (result.changes !== 1) throw new DcConflictError("memory_bridge_claim_lost");
      if (payload.relationshipReview) {
        const consumed = this.database.prepare(`
          UPDATE dc_relationship_reconfirmation_authorizations
          SET status = 'consumed', consumed_at = ?, updated_at = ?
          WHERE id = ? AND user_id = ? AND epoch = ? AND status = 'authorized'
        `).run(
          now,
          now,
          payload.relationshipReview.authorizationId,
          input.userId,
          payload.relationshipReview.epoch
        );
        if (consumed.changes !== 1) {
          const existing = this.database.prepare(`
            SELECT status FROM dc_relationship_reconfirmation_authorizations
            WHERE id = ? AND user_id = ? AND epoch = ?
          `).get(
            payload.relationshipReview.authorizationId,
            input.userId,
            payload.relationshipReview.epoch
          ) as { status: string } | undefined;
          if (existing?.status !== "consumed") {
            throw new DcConflictError("relationship_reconfirmation_claim_lost");
          }
        }
      }
    })();
  }

  fail(input: { userId: string; outboxId: string; claimToken: string; errorCode: string; needsReview?: boolean }) {
    return this.database.transaction(() => {
      const row = this.database.prepare(`
        SELECT payload_json FROM dc_memory_bridge_outbox
        WHERE id = ? AND user_id = ? AND status = 'processing' AND claim_token = ?
      `).get(input.outboxId, input.userId, input.claimToken) as { payload_json: string } | undefined;
      if (!row) throw new DcConflictError("memory_bridge_claim_lost");
      const payload = BridgePayloadSchema.parse(JSON.parse(row.payload_json));
      const now = new Date().toISOString();
      const result = this.database.prepare(`
        UPDATE dc_memory_bridge_outbox
        SET status = ?, claim_token = NULL, lease_expires_at = NULL,
            last_error_code = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND status = 'processing' AND claim_token = ?
      `).run(
        input.needsReview ? "needs_review" : "retryable_failed",
        safeErrorCode(input.errorCode),
        now,
        input.outboxId,
        input.userId,
        input.claimToken
      );
      if (result.changes !== 1) throw new DcConflictError("memory_bridge_claim_lost");
      if (input.needsReview && payload.relationshipReview) {
        this.database.prepare(`
          UPDATE dc_relationship_reconfirmation_authorizations
          SET status = 'cancelled', updated_at = ?
          WHERE id = ? AND user_id = ? AND status = 'authorized'
        `).run(now, payload.relationshipReview.authorizationId, input.userId);
      }
    })();
  }
}

export function createDateCompanionMemoryBridgeRepository(database: Database.Database) {
  return new DateCompanionMemoryBridgeRepository(database);
}
