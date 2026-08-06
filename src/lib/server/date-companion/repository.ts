import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import {
  DcEvidenceSnapshotSchema,
  DcInteractionDetailSchema,
  DcPromiseSchema,
  DcRelationshipSchema,
  DcRelationshipViewSchema,
  DcSearchResultSchema,
  type DcEvidenceSnapshot,
  type DcInteractionDetail,
  type DcPromiseStatus,
  type DcRelationship,
  type DcRelationshipView,
  type DcSearchResult
} from "@/lib/domain/date-companion-stage2";
import { dateCompanionIdentityContinuityKey } from "@/lib/domain/date-companion-speaker";

import type {
  DcImportInteractionInput,
  DcParticipantAudioSample,
  DcParticipantMutation,
  DcRecapMutation,
  DcVoiceEnrollmentDispatchCandidate,
  DcVoiceEnrollmentDispatchJob,
  DcVoiceEnrollmentIntent,
  DcVoiceEnrollmentSnapshotInput
} from "./types";

export class DcNotFoundError extends Error {
  readonly code = "date_companion_not_found";
}

export class DcVersionConflictError extends Error {
  readonly code = "version_conflict";
  constructor(readonly currentVersion: number) {
    super("Date Companion resource version is stale");
  }
}

export class DcConflictError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export class DcValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export class DcRetryableError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

type RelationshipRow = {
  id: string;
  display_name: string | null;
  status: "active" | "archived";
  version: number;
  created_at: string;
  updated_at: string;
};

type InteractionRow = {
  id: string;
  relationship_id: string;
  source_upload_id: string;
  recording_date: string;
  original_name: string;
  duration_seconds: number | null;
  status: "draft" | "confirmed";
  source_state: "available" | "server_cleaned" | "explicitly_deleted";
  version: number;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
  confirmation_fingerprint: string | null;
};

type ParticipantRow = {
  speaker_id: string;
  role: "self" | "companion" | "unresolved";
  confirmed_at: string | null;
  continuity_key: string | null;
  audio_sample_available: 0 | 1;
  suggested_role: "self" | "companion" | null;
  suggestion_source: "previous_confirmation" | null;
};

type ParticipantAudioRow = {
  mime_type: "audio/mpeg";
  duration_milliseconds: number;
  audio: Buffer;
};

type RecapRow = {
  id: string;
  interaction_id: string;
  kind: "moment" | "mentioned" | "promise" | "continue";
  proposed_text: string;
  user_text: string | null;
  disposition: "pending" | "kept" | "excluded";
  version: number;
  sort_order: number;
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
  created_at: string;
};

type PromiseRow = {
  id: string;
  relationship_id: string;
  originating_recap_item_id: string;
  text: string;
  status: "open" | "done";
  version: number;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

type VoiceEnrollmentSnapshotRow = {
  id: string;
  relationship_id: string;
  interaction_id: string;
  review_group_id: string;
  source_upload_id: string;
  provider_record_id: string;
  chunk_id: string;
  local_speaker: string;
  audit_status: "verified" | "pending" | "unknown";
  audit_reason: string;
  audit_digest: string;
  expires_at: string;
  created_at: string;
};

type VoiceEnrollmentOutboxRow = {
  id: string;
  relationship_id: string;
  interaction_id: string;
  snapshot_id: string;
  idempotency_key: string;
  provider_speaker_id: string;
  expected_global_speaker_id: string;
  status: "pending" | "processing" | "completed" | "failed" | "cancelled";
  attempt_count: number;
  claim_token: string | null;
  lease_expires_at: string | null;
  last_error_code: string | null;
  profile_global_speaker_id: string | null;
  requested_at: string;
  updated_at: string;
  completed_at: string | null;
  expires_at?: string;
};

export const DATE_COMPANION_PARTICIPANT_AUDIO_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

function participantAudioCutoff(now = new Date().toISOString()) {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) throw new DcValidationError("invalid_participant_audio_time");
  return new Date(timestamp - DATE_COMPANION_PARTICIPANT_AUDIO_TTL_MS).toISOString();
}

function relationshipFromRow(row: RelationshipRow): DcRelationship {
  return DcRelationshipSchema.parse({
    id: row.id,
    ...(row.display_name ? { displayName: row.display_name } : {}),
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function evidenceFromRow(row: EvidenceRow): DcEvidenceSnapshot {
  return DcEvidenceSnapshotSchema.parse({
    id: row.id,
    recapItemId: row.recap_item_id,
    uploadId: row.upload_id,
    sourceSegmentId: row.source_segment_id,
    startSeconds: row.start_seconds,
    endSeconds: row.end_seconds,
    ...(row.speaker_id ? { speakerId: row.speaker_id } : {}),
    quote: row.quote,
    createdAt: row.created_at
  });
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/gu, (match) => `\\${match}`);
}

function participantReviewGroupId(interactionId: string, continuityKey: string) {
  return `review_${createHash("sha256")
    .update(`${interactionId}\u0000${continuityKey}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function stableVoiceEnrollmentId(prefix: string, values: string[]) {
  return `${prefix}_${createHash("sha256")
    .update(values.join("\u0000"))
    .digest("hex")
    .slice(0, 32)}`;
}

function normalizedSpeakerSet(speakerIds: string[]) {
  const normalized = speakerIds.map((speakerId) => speakerId.trim()).sort();
  if (
    normalized.length === 0
    || normalized.some((speakerId) => !speakerId || speakerId.length > 512)
    || new Set(normalized).size !== normalized.length
  ) {
    throw new DcValidationError("invalid_voice_enrollment_speaker_set");
  }
  return normalized;
}

function sameStringSet(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function safeOutboxErrorCode(value: string) {
  const normalized = value.trim();
  return /^[A-Za-z0-9_-]{1,120}$/u.test(normalized)
    ? normalized
    : "voice_enrollment_failed";
}

const VOICE_ENROLLMENT_CLAIM_LEASE_MS = 5 * 60 * 1_000;

function recapConfirmationFingerprint(input: {
  version: number;
  assignments?: DcParticipantMutation[];
  mutations: DcRecapMutation[];
  voiceEnrollmentIntents?: DcVoiceEnrollmentIntent[];
}) {
  const assignments = (input.assignments ?? [])
    .map((assignment) => ({ speakerId: assignment.speakerId, role: assignment.role }))
    .sort((left, right) => left.speakerId.localeCompare(right.speakerId));
  const mutations = input.mutations
    .map((mutation) => {
      const hasUserText = Object.prototype.hasOwnProperty.call(mutation, "userText");
      return {
        id: mutation.id,
        version: mutation.version,
        userTextPresent: hasUserText,
        userText: hasUserText ? mutation.userText?.trim() || null : null,
        disposition: mutation.disposition
      };
    })
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const voiceEnrollmentIntents = (input.voiceEnrollmentIntents ?? [])
    .map((intent) => ({ speakerIds: normalizedSpeakerSet(intent.speakerIds) }))
    .sort((left, right) => left.speakerIds.join("\u0000").localeCompare(right.speakerIds.join("\u0000")));
  return createHash("sha256")
    .update(JSON.stringify({ version: input.version, assignments, mutations, voiceEnrollmentIntents }))
    .digest("hex");
}

export class DateCompanionRepository {
  constructor(private readonly database: Database.Database) {}

  private findRelationship(userId: string, relationshipId: string) {
    return this.database.prepare(`
      SELECT id, display_name, status, version, created_at, updated_at
      FROM dc_relationships
      WHERE id = ? AND user_id = ?
    `).get(relationshipId, userId) as RelationshipRow | undefined;
  }

  private requireRelationship(userId: string, relationshipId: string) {
    const row = this.findRelationship(userId, relationshipId);
    if (!row) throw new DcNotFoundError("Relationship not found");
    return row;
  }

  private findInteraction(userId: string, interactionId: string) {
    return this.database.prepare(`
      SELECT id, relationship_id, source_upload_id, recording_date, original_name,
             duration_seconds, status, source_state, version, created_at, updated_at,
             confirmed_at, confirmation_fingerprint
      FROM dc_interactions
      WHERE id = ? AND user_id = ?
    `).get(interactionId, userId) as InteractionRow | undefined;
  }

  private requireInteraction(userId: string, interactionId: string) {
    const row = this.findInteraction(userId, interactionId);
    if (!row) throw new DcNotFoundError("Interaction not found");
    return row;
  }

  private evidenceForRecap(userId: string, recapItemId: string) {
    const rows = this.database.prepare(`
      SELECT id, recap_item_id, upload_id, source_segment_id, start_seconds,
             end_seconds, speaker_id, quote, created_at
      FROM dc_evidence_snapshots
      WHERE recap_item_id = ? AND user_id = ?
      ORDER BY start_seconds, source_segment_id, id
    `).all(recapItemId, userId) as EvidenceRow[];
    return rows.map(evidenceFromRow);
  }

  private interactionDetail(userId: string, row: InteractionRow): DcInteractionDetail {
    const enrollment = this.database.prepare(`
      SELECT o.status, s.expires_at
      FROM dc_voice_enrollment_outbox o
      JOIN dc_voice_enrollment_snapshots s
        ON s.id = o.snapshot_id AND s.user_id = o.user_id
      WHERE o.interaction_id = ? AND o.user_id = ?
    `).get(row.id, userId) as Pick<VoiceEnrollmentOutboxRow, "status"> & {
      expires_at: string;
    } | undefined;
    const voiceEnrollmentStatus = enrollment
      ? (
          (enrollment.status === "pending" || enrollment.status === "processing")
          && Date.parse(enrollment.expires_at) <= Date.now()
            ? "expired" as const
            : enrollment.status
        )
      : undefined;
    const participantRows = this.database.prepare(`
      SELECT p.speaker_id, p.role, p.confirmed_at, p.continuity_key,
              EXISTS(
               SELECT 1
               FROM dc_participant_audio_samples a
               WHERE a.user_id = p.user_id
                  AND a.interaction_id = p.interaction_id
                  AND a.speaker_id = p.speaker_id
                  AND a.created_at > ?
              ) AS audio_sample_available,
             b.role AS suggested_role,
             CASE WHEN b.role IS NOT NULL THEN 'previous_confirmation' END AS suggestion_source
      FROM dc_participant_assignments p
      LEFT JOIN dc_relationship_speaker_bindings b
        ON b.user_id = p.user_id
       AND b.relationship_id = ?
       AND b.continuity_key = p.continuity_key
      WHERE p.interaction_id = ? AND p.user_id = ?
      ORDER BY p.speaker_id
    `).all(
      participantAudioCutoff(),
      row.relationship_id,
      row.id,
      userId
    ) as ParticipantRow[];
    const expectedGroups = new Map<string, string[]>();
    for (const participant of participantRows) {
      const key = participant.continuity_key ?? `speaker:${participant.speaker_id}`;
      const group = expectedGroups.get(key) ?? [];
      group.push(participant.speaker_id);
      expectedGroups.set(key, group);
    }
    const eligibleSpeakerIds = new Set<string>();
    const activeSnapshots = this.database.prepare(`
      SELECT id
      FROM dc_voice_enrollment_snapshots
      WHERE user_id = ? AND interaction_id = ? AND expires_at > ?
      ORDER BY id
    `).all(userId, row.id, new Date().toISOString()) as Array<{ id: string }>;
    for (const snapshot of activeSnapshots) {
      const members = (this.database.prepare(`
        SELECT speaker_id
        FROM dc_voice_enrollment_snapshot_members
        WHERE user_id = ? AND snapshot_id = ?
        ORDER BY speaker_id
      `).all(userId, snapshot.id) as Array<{ speaker_id: string }>).map(
        (member) => member.speaker_id
      );
      const complete = [...expectedGroups.values()].some((group) =>
        sameStringSet([...group].sort(), members)
      );
      const bootstrapOnly = members.every((speakerId) =>
        participantRows.find((participant) => participant.speaker_id === speakerId)
          ?.continuity_key === null
      );
      if (complete && bootstrapOnly) {
        members.forEach((speakerId) => eligibleSpeakerIds.add(speakerId));
      }
    }
    const participants = participantRows.map((participant) => ({
      speakerId: participant.speaker_id,
      ...(participant.continuity_key ? {
        reviewGroupId: participantReviewGroupId(row.id, participant.continuity_key)
      } : {}),
      ...(participant.audio_sample_available === 1 ? { audioSampleAvailable: true as const } : {}),
      ...(eligibleSpeakerIds.has(participant.speaker_id)
        ? { voiceEnrollmentEligible: true as const }
        : {}),
      role: participant.role,
      ...(participant.confirmed_at ? { confirmedAt: participant.confirmed_at } : {}),
      ...(row.status === "draft"
        && !participant.confirmed_at
        && participant.suggested_role
        && participant.suggestion_source
        ? {
            roleSuggestion: {
              role: participant.suggested_role,
              source: participant.suggestion_source
            }
          }
        : {})
    }));
    const recapRows = this.database.prepare(`
      SELECT id, interaction_id, kind, proposed_text, user_text, disposition,
             version, sort_order
      FROM dc_recap_items
      WHERE interaction_id = ? AND user_id = ?
      ORDER BY sort_order, id
    `).all(row.id, userId) as RecapRow[];
    const recapItems = recapRows.map((item) => ({
      id: item.id,
      interactionId: item.interaction_id,
      kind: item.kind,
      proposedText: item.proposed_text,
      ...(item.user_text ? { userText: item.user_text } : {}),
      displayedText: item.user_text ?? item.proposed_text,
      disposition: item.disposition,
      version: item.version,
      sortOrder: item.sort_order,
      evidence: this.evidenceForRecap(userId, item.id)
    }));

    return DcInteractionDetailSchema.parse({
      id: row.id,
      relationshipId: row.relationship_id,
      sourceUploadId: row.source_upload_id,
      recordingDate: row.recording_date,
      originalName: row.original_name,
      ...(row.duration_seconds !== null ? { durationSeconds: row.duration_seconds } : {}),
      status: row.status,
      sourceState: row.source_state,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.confirmed_at ? { confirmedAt: row.confirmed_at } : {}),
      participants,
      recapItems,
      ...(voiceEnrollmentStatus
        ? { voiceEnrollment: { status: voiceEnrollmentStatus } }
        : {})
    });
  }

  listRelationships(userId: string) {
    const rows = this.database.prepare(`
      SELECT id, display_name, status, version, created_at, updated_at
      FROM dc_relationships
      WHERE user_id = ? AND status = 'active'
      ORDER BY updated_at DESC, id
    `).all(userId) as RelationshipRow[];
    return rows.map(relationshipFromRow);
  }

  getInteractionRelationshipId(userId: string, interactionId: string) {
    return this.requireInteraction(userId, interactionId).relationship_id;
  }

  createOrGetRelationship(userId: string, displayName?: string) {
    const run = this.database.transaction(() => {
      const existing = this.database.prepare(`
        SELECT id, display_name, status, version, created_at, updated_at
        FROM dc_relationships
        WHERE user_id = ? AND status = 'active'
      `).get(userId) as RelationshipRow | undefined;
      if (existing) return { relationship: relationshipFromRow(existing), reused: true };

      const now = new Date().toISOString();
      const id = randomUUID();
      this.database.prepare(`
        INSERT INTO dc_relationships
          (id, user_id, display_name, status, version, created_at, updated_at)
        VALUES (?, ?, ?, 'active', 0, ?, ?)
      `).run(id, userId, displayName?.trim() || null, now, now);
      return {
        relationship: relationshipFromRow(this.requireRelationship(userId, id)),
        reused: false
      };
    });
    return run();
  }

  getRelationshipView(userId: string, relationshipId: string): DcRelationshipView {
    const relationship = relationshipFromRow(this.requireRelationship(userId, relationshipId));
    const interactionRows = this.database.prepare(`
      SELECT id, relationship_id, source_upload_id, recording_date, original_name,
             duration_seconds, status, source_state, version, created_at, updated_at,
             confirmed_at, confirmation_fingerprint
      FROM dc_interactions
      WHERE relationship_id = ? AND user_id = ?
      ORDER BY recording_date DESC, created_at DESC, id
    `).all(relationshipId, userId) as InteractionRow[];
    const promiseRows = this.database.prepare(`
      SELECT id, relationship_id, originating_recap_item_id, text, status, version,
             resolved_at, created_at, updated_at
      FROM dc_promises
      WHERE relationship_id = ? AND user_id = ?
      ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, updated_at DESC, id
    `).all(relationshipId, userId) as PromiseRow[];
    const promises = promiseRows.map((item) => DcPromiseSchema.parse({
      id: item.id,
      relationshipId: item.relationship_id,
      originatingRecapItemId: item.originating_recap_item_id,
      text: item.text,
      status: item.status,
      version: item.version,
      ...(item.resolved_at ? { resolvedAt: item.resolved_at } : {}),
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      evidence: this.evidenceForRecap(userId, item.originating_recap_item_id)
    }));

    return DcRelationshipViewSchema.parse({
      relationship,
      interactions: interactionRows.map((row) => this.interactionDetail(userId, row)),
      promises
    });
  }

  importInteraction(input: DcImportInteractionInput) {
    const run = this.database.transaction(() => {
      this.requireRelationship(input.userId, input.relationshipId);
      const existing = this.database.prepare(`
        SELECT id, relationship_id
        FROM dc_interactions
        WHERE user_id = ? AND source_upload_id = ?
      `).get(input.userId, input.sourceUploadId) as { id: string; relationship_id: string } | undefined;
      if (existing) {
        if (existing.relationship_id !== input.relationshipId) {
          throw new DcConflictError("interaction_relationship_conflict");
        }
        return { interactionId: existing.id, reused: true };
      }

      const now = new Date().toISOString();
      const interactionId = randomUUID();
      this.database.prepare(`
        INSERT INTO dc_interactions
          (id, user_id, relationship_id, source_upload_id, recording_date,
           original_name, duration_seconds, status, source_state, version,
           created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 'available', 0, ?, ?)
      `).run(
        interactionId,
        input.userId,
        input.relationshipId,
        input.sourceUploadId,
        input.recordingDate,
        input.originalName,
        input.durationSeconds ?? null,
        now,
        now
      );

      const insertParticipant = this.database.prepare(`
        INSERT INTO dc_participant_assignments
          (user_id, interaction_id, speaker_id, role, confirmed_by, confirmed_at,
           continuity_key)
        VALUES (?, ?, ?, 'unresolved', NULL, NULL, ?)
      `);
      const participants = [...input.participants]
        .sort((left, right) => left.speakerId.localeCompare(right.speakerId));
      if (new Set(participants.map((participant) => participant.speakerId)).size !== participants.length) {
        throw new DcValidationError("duplicate_speaker_id");
      }
      for (const participant of participants) {
        const speakerId = participant.speakerId.trim();
        const continuityKey = participant.continuityKey?.trim() || null;
        if (!speakerId || speakerId.length > 512 || (continuityKey && continuityKey.length > 512)) {
          throw new DcValidationError("invalid_speaker_id");
        }
        insertParticipant.run(
          input.userId,
          interactionId,
          speakerId,
          continuityKey
        );
      }

      const insertRecap = this.database.prepare(`
        INSERT INTO dc_recap_items
          (id, user_id, interaction_id, kind, proposed_text, user_text,
           disposition, version, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, 'pending', 0, ?, ?, ?)
      `);
      const insertEvidence = this.database.prepare(`
        INSERT INTO dc_evidence_snapshots
          (id, user_id, recap_item_id, upload_id, source_segment_id,
           start_seconds, end_seconds, speaker_id, quote, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const candidate of input.recapCandidates) {
        if (candidate.evidence.length === 0) {
          throw new DcValidationError("recap_item_missing_evidence");
        }
        const recapItemId = randomUUID();
        insertRecap.run(
          recapItemId,
          input.userId,
          interactionId,
          candidate.kind,
          candidate.proposedText,
          candidate.sortOrder,
          now,
          now
        );
        const seen = new Set<string>();
        for (const evidence of candidate.evidence) {
          if (evidence.uploadId !== input.sourceUploadId) {
            throw new DcValidationError("evidence_upload_mismatch");
          }
          const evidenceKey = `${evidence.uploadId}\u0000${evidence.sourceSegmentId}`;
          if (seen.has(evidenceKey)) continue;
          seen.add(evidenceKey);
          insertEvidence.run(
            randomUUID(),
            input.userId,
            recapItemId,
            evidence.uploadId,
            evidence.sourceSegmentId,
            evidence.startSeconds,
            evidence.endSeconds,
            evidence.speakerId ?? null,
            evidence.quote,
            now
          );
        }
      }
      this.database.prepare(`
        UPDATE dc_relationships SET updated_at = ? WHERE id = ? AND user_id = ?
      `).run(now, input.relationshipId, input.userId);
      return { interactionId, reused: false };
    });
    return run();
  }

  saveVoiceEnrollmentSnapshots(input: {
    userId: string;
    relationshipId: string;
    interactionId: string;
    snapshots: DcVoiceEnrollmentSnapshotInput[];
  }) {
    const run = this.database.transaction(() => {
      const interaction = this.requireInteraction(input.userId, input.interactionId);
      if (interaction.relationship_id !== input.relationshipId) {
        throw new DcConflictError("interaction_relationship_conflict");
      }
      const participantRows = this.database.prepare(`
        SELECT speaker_id, continuity_key
        FROM dc_participant_assignments
        WHERE user_id = ? AND interaction_id = ?
      `).all(input.userId, input.interactionId) as Array<{
        speaker_id: string;
        continuity_key: string | null;
      }>;
      const participantIds = new Set(participantRows.map((row) => row.speaker_id));
      const legalGroups = new Map<string, string[]>();
      for (const participant of participantRows) {
        const key = participant.continuity_key ?? `speaker:${participant.speaker_id}`;
        const group = legalGroups.get(key) ?? [];
        group.push(participant.speaker_id);
        legalGroups.set(key, group);
      }
      const seenMembers = new Set<string>();
      const insertSnapshot = this.database.prepare(`
        INSERT INTO dc_voice_enrollment_snapshots
          (id, user_id, relationship_id, interaction_id, review_group_id,
           source_upload_id, provider_record_id, chunk_id, local_speaker,
           audit_status, audit_reason, audit_digest, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertMember = this.database.prepare(`
        INSERT INTO dc_voice_enrollment_snapshot_members
          (user_id, snapshot_id, interaction_id, speaker_id)
        VALUES (?, ?, ?, ?)
      `);
      const now = new Date().toISOString();

      for (const snapshot of input.snapshots) {
        const speakerIds = normalizedSpeakerSet(snapshot.speakerIds);
        if (speakerIds.some((speakerId) => !participantIds.has(speakerId))) {
          throw new DcValidationError("voice_enrollment_snapshot_participant_mismatch");
        }
        if (![...legalGroups.values()].some((group) =>
          sameStringSet([...group].sort(), speakerIds)
        )) {
          throw new DcValidationError("invalid_voice_enrollment_candidate_group");
        }
        if (speakerIds.some((speakerId) => seenMembers.has(speakerId))) {
          throw new DcValidationError("voice_enrollment_snapshot_group_overlap");
        }
        speakerIds.forEach((speakerId) => seenMembers.add(speakerId));
        const values = [
          snapshot.reviewGroupId,
          snapshot.sourceUploadId,
          snapshot.providerRecordId,
          snapshot.chunkId,
          snapshot.localSpeaker,
          snapshot.auditReason,
          snapshot.auditDigest
        ];
        if (
          values.some((value) => !value.trim() || value.trim().length > 512)
          || !/^[A-Fa-f0-9]{64}$/u.test(snapshot.auditDigest)
          || !Number.isFinite(Date.parse(snapshot.expiresAt))
          || snapshot.sourceUploadId !== interaction.source_upload_id
        ) {
          throw new DcValidationError("invalid_voice_enrollment_snapshot");
        }
        const snapshotId = stableVoiceEnrollmentId(
          "voice_snapshot",
          [input.userId, input.interactionId, ...speakerIds]
        );
        const existing = this.database.prepare(`
          SELECT id, relationship_id, interaction_id, review_group_id,
                 source_upload_id, provider_record_id, chunk_id, local_speaker,
                 audit_status, audit_reason, audit_digest, expires_at, created_at
          FROM dc_voice_enrollment_snapshots
          WHERE id = ? AND user_id = ?
        `).get(snapshotId, input.userId) as VoiceEnrollmentSnapshotRow | undefined;
        if (existing) {
          const existingMembers = (this.database.prepare(`
            SELECT speaker_id
            FROM dc_voice_enrollment_snapshot_members
            WHERE user_id = ? AND snapshot_id = ?
            ORDER BY speaker_id
          `).all(input.userId, snapshotId) as Array<{ speaker_id: string }>)
            .map((row) => row.speaker_id);
          if (
            existing.relationship_id !== input.relationshipId
            || existing.interaction_id !== input.interactionId
            || existing.review_group_id !== snapshot.reviewGroupId
            || existing.source_upload_id !== snapshot.sourceUploadId
            || existing.provider_record_id !== snapshot.providerRecordId
            || existing.chunk_id !== snapshot.chunkId
            || existing.local_speaker !== snapshot.localSpeaker
            || existing.audit_status !== snapshot.auditStatus
            || existing.audit_reason !== snapshot.auditReason
            || existing.audit_digest !== snapshot.auditDigest
            || existing.expires_at !== snapshot.expiresAt
            || !sameStringSet(existingMembers, speakerIds)
          ) {
            throw new DcConflictError("voice_enrollment_snapshot_conflict");
          }
          continue;
        }
        insertSnapshot.run(
          snapshotId,
          input.userId,
          input.relationshipId,
          input.interactionId,
          snapshot.reviewGroupId.trim(),
          snapshot.sourceUploadId.trim(),
          snapshot.providerRecordId.trim(),
          snapshot.chunkId.trim(),
          snapshot.localSpeaker.trim(),
          snapshot.auditStatus,
          snapshot.auditReason.trim(),
          snapshot.auditDigest,
          snapshot.expiresAt,
          now
        );
        for (const speakerId of speakerIds) {
          insertMember.run(input.userId, snapshotId, input.interactionId, speakerId);
        }
      }
      return input.snapshots.length;
    });
    return run();
  }

  updateParticipants(input: {
    userId: string;
    interactionId: string;
    version: number;
    assignments: DcParticipantMutation[];
  }) {
    const run = this.database.transaction(() => {
      const interaction = this.requireInteraction(input.userId, input.interactionId);
      if (interaction.status === "confirmed") {
        throw new DcConflictError("interaction_already_confirmed");
      }
      if (interaction.version !== input.version) {
        throw new DcVersionConflictError(interaction.version);
      }
      if (new Set(input.assignments.map((item) => item.speakerId)).size !== input.assignments.length) {
        throw new DcValidationError("duplicate_speaker_id");
      }

      const now = new Date().toISOString();
      const findSpeaker = this.database.prepare(`
        SELECT 1 FROM dc_participant_assignments
        WHERE interaction_id = ? AND speaker_id = ? AND user_id = ?
      `);
      const updateSpeaker = this.database.prepare(`
        UPDATE dc_participant_assignments
        SET role = ?, confirmed_by = ?, confirmed_at = ?
        WHERE interaction_id = ? AND speaker_id = ? AND user_id = ?
      `);
      for (const assignment of input.assignments) {
        if (!findSpeaker.get(input.interactionId, assignment.speakerId, input.userId)) {
          throw new DcValidationError("invalid_speaker_id");
        }
        const confirmed = assignment.role !== "unresolved";
        updateSpeaker.run(
          assignment.role,
          confirmed ? input.userId : null,
          confirmed ? now : null,
          input.interactionId,
          assignment.speakerId,
          input.userId
        );
      }
      const update = this.database.prepare(`
        UPDATE dc_interactions
        SET version = version + 1, updated_at = ?
        WHERE id = ? AND user_id = ? AND version = ?
      `).run(now, input.interactionId, input.userId, input.version);
      if (update.changes !== 1) {
        throw new DcVersionConflictError(this.requireInteraction(input.userId, input.interactionId).version);
      }
    });
    run();
  }

  saveParticipantAudioSamples(input: {
    userId: string;
    interactionId: string;
    samples: DcParticipantAudioSample[];
  }) {
    const run = this.database.transaction(() => {
      this.requireInteraction(input.userId, input.interactionId);
      if (new Set(input.samples.map((sample) => sample.speakerId)).size !== input.samples.length) {
        throw new DcValidationError("duplicate_participant_audio_speaker");
      }
      const findSpeaker = this.database.prepare(`
        SELECT 1 FROM dc_participant_assignments
        WHERE user_id = ? AND interaction_id = ? AND speaker_id = ?
      `);
      const save = this.database.prepare(`
        INSERT INTO dc_participant_audio_samples
          (user_id, interaction_id, speaker_id, mime_type,
           duration_milliseconds, audio, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, interaction_id, speaker_id) DO UPDATE SET
          mime_type = excluded.mime_type,
          duration_milliseconds = excluded.duration_milliseconds,
          audio = excluded.audio,
          created_at = excluded.created_at
      `);
      const now = new Date().toISOString();
      for (const sample of input.samples) {
        if (!findSpeaker.get(input.userId, input.interactionId, sample.speakerId)) {
          throw new DcValidationError("invalid_participant_audio_speaker");
        }
        if (
          sample.mimeType !== "audio/mpeg"
          || !Number.isSafeInteger(sample.durationMilliseconds)
          || sample.durationMilliseconds <= 0
          || sample.audio.byteLength === 0
        ) {
          throw new DcValidationError("invalid_participant_audio_sample");
        }
        save.run(
          input.userId,
          input.interactionId,
          sample.speakerId,
          sample.mimeType,
          sample.durationMilliseconds,
          Buffer.from(sample.audio),
          now
        );
      }
    });
    run();
  }

  participantAudioSpeakerIds(userId: string, interactionId: string) {
    this.requireInteraction(userId, interactionId);
    const rows = this.database.prepare(`
      SELECT speaker_id
      FROM dc_participant_audio_samples
      WHERE user_id = ? AND interaction_id = ? AND created_at > ?
      ORDER BY speaker_id
    `).all(
      userId,
      interactionId,
      participantAudioCutoff()
    ) as Array<{ speaker_id: string }>;
    return rows.map((row) => row.speaker_id);
  }

  getParticipantAudioSample(userId: string, interactionId: string, speakerId: string) {
    const row = this.database.prepare(`
      SELECT mime_type, duration_milliseconds, audio
      FROM dc_participant_audio_samples
      WHERE user_id = ? AND interaction_id = ? AND speaker_id = ? AND created_at > ?
    `).get(
      userId,
      interactionId,
      speakerId,
      participantAudioCutoff()
    ) as ParticipantAudioRow | undefined;
    return row ? {
      mimeType: row.mime_type,
      durationMilliseconds: row.duration_milliseconds,
      audio: new Uint8Array(row.audio)
    } : null;
  }

  cleanupExpiredParticipantAudioSamples(now = new Date().toISOString()) {
    return this.database.prepare(`
      DELETE FROM dc_participant_audio_samples
      WHERE created_at <= ?
    `).run(participantAudioCutoff(now)).changes;
  }

  updateRecap(input: {
    userId: string;
    interactionId: string;
    version: number;
    assignments?: DcParticipantMutation[];
    mutations: DcRecapMutation[];
    voiceEnrollmentIntents?: DcVoiceEnrollmentIntent[];
    voiceEnrollmentEnabled?: boolean;
    finalize: boolean;
  }) {
    const run = this.database.transaction(() => {
      const interaction = this.requireInteraction(input.userId, input.interactionId);
      const confirmationFingerprint = input.finalize
        ? recapConfirmationFingerprint({
            ...input,
            voiceEnrollmentIntents: input.voiceEnrollmentIntents
          })
        : null;
      if (interaction.status === "confirmed") {
        if (
          input.finalize
          && interaction.confirmation_fingerprint !== null
          && interaction.confirmation_fingerprint === confirmationFingerprint
        ) {
          return { idempotent: true };
        }
        if (input.finalize) throw new DcConflictError("confirmation_payload_conflict");
        throw new DcConflictError("interaction_already_confirmed");
      }
      if (interaction.version !== input.version) {
        throw new DcVersionConflictError(interaction.version);
      }
      if (new Set(input.mutations.map((item) => item.id)).size !== input.mutations.length) {
        throw new DcValidationError("duplicate_recap_item_id");
      }
      const assignments = input.assignments ?? [];
      const voiceEnrollmentIntents = input.voiceEnrollmentIntents ?? [];
      if (assignments.length > 0 && !input.finalize) {
        throw new DcValidationError("participant_assignments_require_finalize");
      }
      if (voiceEnrollmentIntents.length > 0 && !input.finalize) {
        throw new DcValidationError("voice_enrollment_intents_require_finalize");
      }
      if (voiceEnrollmentIntents.length > 1) {
        throw new DcValidationError("voice_enrollment_intent_limit");
      }
      if (voiceEnrollmentIntents.length > 0 && input.voiceEnrollmentEnabled !== true) {
        throw new DcConflictError("voice_enrollment_disabled");
      }
      if (new Set(assignments.map((item) => item.speakerId)).size !== assignments.length) {
        throw new DcValidationError("duplicate_speaker_id");
      }
      if (input.finalize && assignments.length === 0) {
        const participantCount = this.database.prepare(`
          SELECT COUNT(*) AS count
          FROM dc_participant_assignments
          WHERE interaction_id = ? AND user_id = ?
        `).get(input.interactionId, input.userId) as { count: number };
        if (participantCount.count > 0) {
          throw new DcValidationError("participant_assignment_required");
        }
      }

      const now = new Date().toISOString();
      if (assignments.length > 0) {
        const participantRows = this.database.prepare(`
          SELECT speaker_id
          FROM dc_participant_assignments
          WHERE interaction_id = ? AND user_id = ?
          ORDER BY speaker_id
        `).all(input.interactionId, input.userId) as Array<{ speaker_id: string }>;
        const expectedSpeakerIds = participantRows.map((row) => row.speaker_id);
        const assignedSpeakerIds = assignments.map((assignment) => assignment.speakerId).sort();
        if (
          expectedSpeakerIds.length !== assignedSpeakerIds.length
          || expectedSpeakerIds.some((speakerId, index) => speakerId !== assignedSpeakerIds[index])
        ) {
          throw new DcValidationError("participant_assignment_set_mismatch");
        }
        const updateSpeaker = this.database.prepare(`
          UPDATE dc_participant_assignments
          SET role = ?, confirmed_by = ?, confirmed_at = ?
          WHERE interaction_id = ? AND speaker_id = ? AND user_id = ?
        `);
        for (const assignment of assignments) {
          const confirmed = assignment.role !== "unresolved";
          updateSpeaker.run(
            assignment.role,
            confirmed ? input.userId : null,
            confirmed ? now : null,
            input.interactionId,
            assignment.speakerId,
            input.userId
          );
        }

        const continuityRows = this.database.prepare(`
          SELECT speaker_id, continuity_key
          FROM dc_participant_assignments
          WHERE interaction_id = ? AND user_id = ? AND continuity_key IS NOT NULL
          ORDER BY speaker_id
        `).all(input.interactionId, input.userId) as Array<{
          speaker_id: string;
          continuity_key: string;
        }>;
        const assignmentBySpeaker = new Map(
          assignments.map((assignment) => [assignment.speakerId, assignment.role])
        );
        const rolesByContinuityKey = new Map<
          string,
          Set<"self" | "companion" | "unresolved">
        >();
        for (const row of continuityRows) {
          const role = assignmentBySpeaker.get(row.speaker_id);
          if (!role) throw new DcValidationError("participant_assignment_set_mismatch");
          const roles = rolesByContinuityKey.get(row.continuity_key) ?? new Set();
          roles.add(role);
          rolesByContinuityKey.set(row.continuity_key, roles);
        }
        const upsertBinding = this.database.prepare(`
          INSERT INTO dc_relationship_speaker_bindings
            (user_id, relationship_id, continuity_key, source_interaction_id,
             role, confirmed_by, confirmed_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, relationship_id, continuity_key) DO UPDATE SET
            source_interaction_id = excluded.source_interaction_id,
            role = excluded.role,
            confirmed_by = excluded.confirmed_by,
            confirmed_at = excluded.confirmed_at,
            updated_at = excluded.updated_at
        `);
        const deleteAmbiguousBinding = this.database.prepare(`
          DELETE FROM dc_relationship_speaker_bindings
          WHERE user_id = ? AND relationship_id = ? AND continuity_key = ?
        `);
        for (const [continuityKey, roles] of rolesByContinuityKey) {
          const role = roles.size === 1 ? [...roles][0] : undefined;
          if (!role || role === "unresolved") {
            deleteAmbiguousBinding.run(
              input.userId,
              interaction.relationship_id,
              continuityKey
            );
            continue;
          }
          upsertBinding.run(
            input.userId,
            interaction.relationship_id,
            continuityKey,
            input.interactionId,
            role,
            input.userId,
            now,
            now
          );
        }
      }
      for (const mutation of input.mutations) {
        const row = this.database.prepare(`
          SELECT id, interaction_id, kind, proposed_text, user_text, disposition,
                 version, sort_order
          FROM dc_recap_items
          WHERE id = ? AND interaction_id = ? AND user_id = ?
        `).get(mutation.id, input.interactionId, input.userId) as RecapRow | undefined;
        if (!row) throw new DcNotFoundError("Recap item not found");
        if (row.version !== mutation.version) throw new DcVersionConflictError(row.version);
        const hasUserText = Object.prototype.hasOwnProperty.call(mutation, "userText");
        const userText = hasUserText ? mutation.userText?.trim() || null : row.user_text;
        const update = this.database.prepare(`
          UPDATE dc_recap_items
          SET user_text = ?, disposition = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND interaction_id = ? AND user_id = ? AND version = ?
        `).run(
          userText,
          mutation.disposition,
          now,
          mutation.id,
          input.interactionId,
          input.userId,
          mutation.version
        );
        if (update.changes !== 1) throw new DcVersionConflictError(row.version + 1);
      }

      if (input.finalize) {
        const recapRows = this.database.prepare(`
          SELECT id, interaction_id, kind, proposed_text, user_text, disposition,
                 version, sort_order
          FROM dc_recap_items
          WHERE interaction_id = ? AND user_id = ?
          ORDER BY sort_order, id
        `).all(input.interactionId, input.userId) as RecapRow[];
        if (recapRows.some((row) => row.disposition === "pending")) {
          throw new DcValidationError("recap_items_pending");
        }
        const keptRows = recapRows.filter((item) => item.disposition === "kept");
        if (keptRows.length === 0) {
          throw new DcValidationError("recap_confirmation_empty");
        }

        const evidenceRoles = this.database.prepare(`
          SELECT e.speaker_id, p.role
          FROM dc_evidence_snapshots e
          LEFT JOIN dc_participant_assignments p
            ON p.user_id = e.user_id
           AND p.interaction_id = ?
           AND p.speaker_id = e.speaker_id
          WHERE e.recap_item_id = ? AND e.user_id = ?
          ORDER BY e.start_seconds, e.source_segment_id
        `);
        const insertPromise = this.database.prepare(`
          INSERT OR IGNORE INTO dc_promises
            (id, user_id, relationship_id, originating_recap_item_id, text,
             status, version, resolved_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'open', 0, NULL, ?, ?)
        `);
        for (const row of keptRows) {
          const roles = evidenceRoles.all(
            input.interactionId,
            row.id,
            input.userId
          ) as Array<{ speaker_id: string | null; role: string | null }>;
          if (roles.length === 0) throw new DcValidationError("recap_item_missing_evidence");
          if (roles.some((role) => !role.speaker_id || !role.role || role.role === "unresolved")) {
            throw new DcValidationError("participant_assignment_required");
          }
          if (row.kind === "mentioned" && roles.some((role) => role.role !== "companion")) {
            throw new DcValidationError("mentioned_requires_companion_speaker");
          }
          if (row.kind === "promise" && roles.some((role) => role.role !== "self")) {
            throw new DcValidationError("promise_requires_self_speaker");
          }
          if (row.kind === "promise") {
            insertPromise.run(
              randomUUID(),
              input.userId,
              interaction.relationship_id,
              row.id,
              row.user_text ?? row.proposed_text,
              now,
              now
            );
          }
        }

        if (voiceEnrollmentIntents.length === 1) {
          const requestedSpeakerIds = normalizedSpeakerSet(
            voiceEnrollmentIntents[0].speakerIds
          );
          const snapshots = this.database.prepare(`
            SELECT id, relationship_id, interaction_id, review_group_id,
                   source_upload_id, provider_record_id, chunk_id, local_speaker,
                   audit_status, audit_reason, audit_digest, expires_at, created_at
            FROM dc_voice_enrollment_snapshots
            WHERE user_id = ? AND interaction_id = ?
            ORDER BY id
          `).all(input.userId, input.interactionId) as VoiceEnrollmentSnapshotRow[];
          const matchingSnapshots = snapshots.filter((snapshot) => {
            const members = (this.database.prepare(`
              SELECT speaker_id
              FROM dc_voice_enrollment_snapshot_members
              WHERE user_id = ? AND snapshot_id = ?
              ORDER BY speaker_id
            `).all(input.userId, snapshot.id) as Array<{ speaker_id: string }>)
              .map((member) => member.speaker_id);
            return sameStringSet(members, requestedSpeakerIds);
          });
          if (matchingSnapshots.length !== 1) {
            throw new DcValidationError("invalid_voice_enrollment_candidate_group");
          }
          const snapshot = matchingSnapshots[0];
          if (Date.parse(snapshot.expires_at) <= Date.parse(now)) {
            throw new DcConflictError("voice_enrollment_snapshot_expired");
          }
          const assignmentBySpeaker = new Map(
            assignments.map((assignment) => [assignment.speakerId, assignment.role])
          );
          if (requestedSpeakerIds.some(
            (speakerId) => assignmentBySpeaker.get(speakerId) !== "companion"
          )) {
            throw new DcValidationError("voice_enrollment_requires_companion_role");
          }
          const existingContinuity = this.database.prepare(`
            SELECT speaker_id, continuity_key
            FROM dc_participant_assignments
            WHERE user_id = ? AND interaction_id = ? AND speaker_id IN (
              ${requestedSpeakerIds.map(() => "?").join(", ")}
            )
            ORDER BY speaker_id
          `).all(
            input.userId,
            input.interactionId,
            ...requestedSpeakerIds
          ) as Array<{ speaker_id: string; continuity_key: string | null }>;
          if (
            existingContinuity.length !== requestedSpeakerIds.length
            || existingContinuity.some((participant) => participant.continuity_key !== null)
          ) {
            throw new DcConflictError("voice_enrollment_bootstrap_requires_empty_profile");
          }
          const idempotencyKey = stableVoiceEnrollmentId(
            "voice_enrollment",
            [input.userId, interaction.relationship_id, input.interactionId, snapshot.id]
          );
          const outboxId = stableVoiceEnrollmentId(
            "voice_outbox",
            [input.userId, idempotencyKey]
          );
          const providerSpeakerId = stableVoiceEnrollmentId(
            "dcv",
            [input.userId, interaction.relationship_id]
          );
          const expectedGlobalSpeakerId = stableVoiceEnrollmentId(
            "dc_partner",
            [input.userId, interaction.relationship_id]
          );
          this.database.prepare(`
            INSERT INTO dc_voice_enrollment_outbox
              (id, user_id, relationship_id, interaction_id, snapshot_id,
               idempotency_key, provider_speaker_id, expected_global_speaker_id,
               status, attempt_count, requested_by, requested_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
            ON CONFLICT(user_id, idempotency_key) DO NOTHING
          `).run(
            outboxId,
            input.userId,
            interaction.relationship_id,
            input.interactionId,
            snapshot.id,
            idempotencyKey,
            providerSpeakerId,
            expectedGlobalSpeakerId,
            input.userId,
            now,
            now
          );
        }
      }

      const update = this.database.prepare(`
        UPDATE dc_interactions
        SET status = ?, confirmed_at = ?, confirmation_fingerprint = ?,
            version = version + 1, updated_at = ?
        WHERE id = ? AND user_id = ? AND version = ?
      `).run(
        input.finalize ? "confirmed" : "draft",
        input.finalize ? now : null,
        confirmationFingerprint,
        now,
        input.interactionId,
        input.userId,
        input.version
      );
      if (update.changes !== 1) {
        throw new DcVersionConflictError(this.requireInteraction(input.userId, input.interactionId).version);
      }
      this.database.prepare(`
        UPDATE dc_relationships SET updated_at = ? WHERE id = ? AND user_id = ?
      `).run(now, interaction.relationship_id, input.userId);
      return { idempotent: false };
    });
    return run();
  }

  getVoiceEnrollmentDispatchJob(
    userId: string,
    outboxId: string
  ): DcVoiceEnrollmentDispatchJob | null {
    const row = this.database.prepare(`
      SELECT o.id, o.relationship_id, o.interaction_id, o.snapshot_id,
             o.idempotency_key, o.provider_speaker_id,
             o.expected_global_speaker_id, o.attempt_count,
             o.claim_token, o.lease_expires_at,
             s.source_upload_id, s.provider_record_id, s.chunk_id,
             s.local_speaker, s.expires_at
      FROM dc_voice_enrollment_outbox o
      JOIN dc_voice_enrollment_snapshots s
        ON s.id = o.snapshot_id AND s.user_id = o.user_id
      WHERE o.id = ? AND o.user_id = ?
    `).get(outboxId, userId) as {
      id: string;
      relationship_id: string;
      interaction_id: string;
      snapshot_id: string;
      idempotency_key: string;
      provider_speaker_id: string;
      expected_global_speaker_id: string;
      attempt_count: number;
      claim_token: string | null;
      lease_expires_at: string | null;
      source_upload_id: string;
      provider_record_id: string;
      chunk_id: string;
      local_speaker: string;
      expires_at: string;
    } | undefined;
    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.now()) {
      throw new DcConflictError("voice_enrollment_snapshot_expired");
    }
    const speakerIds = (this.database.prepare(`
      SELECT speaker_id
      FROM dc_voice_enrollment_snapshot_members
      WHERE user_id = ? AND snapshot_id = ?
      ORDER BY speaker_id
    `).all(userId, row.snapshot_id) as Array<{ speaker_id: string }>)
      .map((member) => member.speaker_id);
    if (speakerIds.length === 0) {
      throw new DcConflictError("voice_enrollment_snapshot_incomplete");
    }
    if (!row.claim_token || !row.lease_expires_at) {
      throw new DcConflictError("voice_enrollment_not_claimed");
    }
    return {
      id: row.id,
      userId,
      relationshipId: row.relationship_id,
      interactionId: row.interaction_id,
      snapshotId: row.snapshot_id,
      idempotencyKey: row.idempotency_key,
      providerSpeakerId: row.provider_speaker_id,
      expectedGlobalSpeakerId: row.expected_global_speaker_id,
      sourceUploadId: row.source_upload_id,
      providerRecordId: row.provider_record_id,
      chunkId: row.chunk_id,
      localSpeaker: row.local_speaker,
      speakerIds,
      attemptCount: row.attempt_count,
      claimToken: row.claim_token,
      leaseExpiresAt: row.lease_expires_at
    };
  }

  listVoiceEnrollmentDispatchCandidates(input: {
    now: string;
    limit: number;
    maxAttempts: number;
  }): DcVoiceEnrollmentDispatchCandidate[] {
    if (!Number.isFinite(Date.parse(input.now))) {
      throw new DcValidationError("invalid_voice_enrollment_scan_time");
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new DcValidationError("invalid_voice_enrollment_scan_limit");
    }
    if (
      !Number.isSafeInteger(input.maxAttempts)
      || input.maxAttempts < 1
      || input.maxAttempts > 10
    ) {
      throw new DcValidationError("invalid_voice_enrollment_max_attempts");
    }
    const rows = this.database.prepare(`
      SELECT o.id, o.user_id, o.status, o.attempt_count,
             o.updated_at, o.lease_expires_at
      FROM dc_voice_enrollment_outbox o
      JOIN dc_voice_enrollment_snapshots s
        ON s.id = o.snapshot_id AND s.user_id = o.user_id
      WHERE o.status IN ('pending', 'processing', 'failed')
        AND o.attempt_count < ?
        AND s.expires_at > ?
        AND (
          o.status != 'processing'
          OR o.lease_expires_at IS NULL
          OR o.lease_expires_at <= ?
        )
      ORDER BY CASE o.status
        WHEN 'pending' THEN 0
        WHEN 'processing' THEN 1
        ELSE 2
      END, o.updated_at, o.id
      LIMIT ?
    `).all(input.maxAttempts, input.now, input.now, input.limit) as Array<{
      id: string;
      user_id: string;
      status: DcVoiceEnrollmentDispatchCandidate["status"];
      attempt_count: number;
      updated_at: string;
      lease_expires_at: string | null;
    }>;
    return rows.map((row) => ({
      outboxId: row.id,
      userId: row.user_id,
      status: row.status,
      attemptCount: row.attempt_count,
      updatedAt: row.updated_at,
      ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {})
    }));
  }

  claimVoiceEnrollment(userId: string, outboxId: string) {
    const run = this.database.transaction(() => {
      const row = this.database.prepare(`
        SELECT o.status, o.lease_expires_at, s.expires_at
        FROM dc_voice_enrollment_outbox o
        JOIN dc_voice_enrollment_snapshots s
          ON s.id = o.snapshot_id AND s.user_id = o.user_id
        WHERE o.id = ? AND o.user_id = ?
      `).get(outboxId, userId) as {
        status: VoiceEnrollmentOutboxRow["status"];
        lease_expires_at: string | null;
        expires_at: string;
      } | undefined;
      if (!row) throw new DcNotFoundError("Voice enrollment job not found");
      if (Date.parse(row.expires_at) <= Date.now()) {
        throw new DcConflictError("voice_enrollment_snapshot_expired");
      }
      if (row.status === "completed" || row.status === "cancelled") {
        throw new DcConflictError(`voice_enrollment_${row.status}`);
      }
      const now = new Date().toISOString();
      if (
        row.status === "processing"
        && row.lease_expires_at
        && Date.parse(row.lease_expires_at) > Date.parse(now)
      ) {
        throw new DcConflictError("voice_enrollment_already_claimed");
      }
      const claimToken = randomUUID();
      const leaseExpiresAt = new Date(
        Date.parse(now) + VOICE_ENROLLMENT_CLAIM_LEASE_MS
      ).toISOString();
      const update = this.database.prepare(`
        UPDATE dc_voice_enrollment_outbox
        SET status = 'processing', attempt_count = attempt_count + 1,
            claim_token = ?, lease_expires_at = ?, last_error_code = NULL,
            updated_at = ?
        WHERE id = ? AND user_id = ?
          AND (
            status IN ('pending', 'failed')
            OR (
              status = 'processing'
              AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
            )
          )
      `).run(claimToken, leaseExpiresAt, now, outboxId, userId, now);
      if (update.changes !== 1) {
        throw new DcConflictError("voice_enrollment_already_claimed");
      }
      return this.getVoiceEnrollmentDispatchJob(userId, outboxId)!;
    });
    return run();
  }

  failVoiceEnrollment(input: {
    userId: string;
    outboxId: string;
    claimToken: string;
    errorCode: string;
  }) {
    const now = new Date().toISOString();
    const result = this.database.prepare(`
      UPDATE dc_voice_enrollment_outbox
      SET status = 'failed', lease_expires_at = NULL,
          last_error_code = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND status = 'processing' AND claim_token = ?
    `).run(
      safeOutboxErrorCode(input.errorCode),
      now,
      input.outboxId,
      input.userId,
      input.claimToken
    );
    if (result.changes !== 1) {
      const row = this.database.prepare(`
        SELECT status, claim_token FROM dc_voice_enrollment_outbox
        WHERE id = ? AND user_id = ?
      `).get(input.outboxId, input.userId) as {
        status: string;
        claim_token: string | null;
      } | undefined;
      if (!row) throw new DcNotFoundError("Voice enrollment job not found");
      if (row.status !== "failed" || row.claim_token !== input.claimToken) {
        throw new DcConflictError("voice_enrollment_stale_claim");
      }
    }
  }

  completeVoiceEnrollment(input: {
    userId: string;
    outboxId: string;
    claimToken: string;
    profileGlobalSpeakerId: string;
  }) {
    const run = this.database.transaction(() => {
      const row = this.database.prepare(`
        SELECT o.id, o.relationship_id, o.interaction_id, o.snapshot_id,
               o.status, o.profile_global_speaker_id,
               o.expected_global_speaker_id, o.claim_token, s.expires_at
        FROM dc_voice_enrollment_outbox o
        JOIN dc_voice_enrollment_snapshots s
          ON s.id = o.snapshot_id AND s.user_id = o.user_id
        WHERE o.id = ? AND o.user_id = ?
      `).get(input.outboxId, input.userId) as VoiceEnrollmentOutboxRow | undefined;
      if (!row) throw new DcNotFoundError("Voice enrollment job not found");
      if (input.profileGlobalSpeakerId !== row.expected_global_speaker_id) {
        throw new DcConflictError("voice_enrollment_profile_mismatch");
      }
      const continuityKey = dateCompanionIdentityContinuityKey(
        row.expected_global_speaker_id
      );
      if (!continuityKey) throw new DcValidationError("invalid_voice_enrollment_profile");
      if (row.status === "completed") {
        if (
          row.profile_global_speaker_id === row.expected_global_speaker_id
          && row.claim_token === input.claimToken
        ) {
          return { idempotent: true, continuityKey };
        }
        throw new DcConflictError("voice_enrollment_completion_conflict");
      }
      if (row.status !== "processing") {
        throw new DcConflictError("voice_enrollment_not_completable");
      }
      if (row.claim_token !== input.claimToken) {
        throw new DcConflictError("voice_enrollment_stale_claim");
      }
      if (!row.expires_at || Date.parse(row.expires_at) <= Date.now()) {
        throw new DcConflictError("voice_enrollment_snapshot_expired");
      }
      const interaction = this.requireInteraction(input.userId, row.interaction_id);
      if (
        interaction.relationship_id !== row.relationship_id
        || interaction.status !== "confirmed"
      ) {
        throw new DcConflictError("voice_enrollment_interaction_not_confirmed");
      }
      const members = this.database.prepare(`
        SELECT m.speaker_id, p.role, p.continuity_key
        FROM dc_voice_enrollment_snapshot_members m
        JOIN dc_participant_assignments p
          ON p.user_id = m.user_id
         AND p.interaction_id = m.interaction_id
         AND p.speaker_id = m.speaker_id
        WHERE m.user_id = ? AND m.snapshot_id = ?
        ORDER BY m.speaker_id
      `).all(input.userId, row.snapshot_id) as Array<{
        speaker_id: string;
        role: "self" | "companion" | "unresolved";
        continuity_key: string | null;
      }>;
      if (
        members.length === 0
        || members.some((member) => member.role !== "companion")
        || members.some(
          (member) => member.continuity_key !== null && member.continuity_key !== continuityKey
        )
      ) {
        throw new DcConflictError("voice_enrollment_group_conflict");
      }
      const existingBinding = this.database.prepare(`
        SELECT role FROM dc_relationship_speaker_bindings
        WHERE user_id = ? AND relationship_id = ? AND continuity_key = ?
      `).get(input.userId, row.relationship_id, continuityKey) as {
        role: "self" | "companion";
      } | undefined;
      if (existingBinding && existingBinding.role !== "companion") {
        throw new DcConflictError("voice_enrollment_binding_conflict");
      }
      const now = new Date().toISOString();
      const updateParticipant = this.database.prepare(`
        UPDATE dc_participant_assignments
        SET continuity_key = ?
        WHERE user_id = ? AND interaction_id = ? AND speaker_id = ?
      `);
      for (const member of members) {
        updateParticipant.run(
          continuityKey,
          input.userId,
          row.interaction_id,
          member.speaker_id
        );
      }
      this.database.prepare(`
        INSERT INTO dc_relationship_speaker_bindings
          (user_id, relationship_id, continuity_key, source_interaction_id,
           role, confirmed_by, confirmed_at, updated_at)
        VALUES (?, ?, ?, ?, 'companion', ?, ?, ?)
        ON CONFLICT(user_id, relationship_id, continuity_key) DO UPDATE SET
          source_interaction_id = excluded.source_interaction_id,
          role = excluded.role,
          confirmed_by = excluded.confirmed_by,
          confirmed_at = excluded.confirmed_at,
          updated_at = excluded.updated_at
      `).run(
        input.userId,
        row.relationship_id,
        continuityKey,
        row.interaction_id,
        input.userId,
        now,
        now
      );
      this.database.prepare(`
        UPDATE dc_voice_enrollment_outbox
        SET status = 'completed', profile_global_speaker_id = ?,
            lease_expires_at = NULL, last_error_code = NULL,
            completed_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND status = 'processing' AND claim_token = ?
      `).run(
        row.expected_global_speaker_id,
        now,
        now,
        input.outboxId,
        input.userId,
        input.claimToken
      );
      return { idempotent: false, continuityKey };
    });
    return run();
  }

  patchPromise(input: {
    userId: string;
    promiseId: string;
    version: number;
    status: DcPromiseStatus;
  }) {
    const run = this.database.transaction(() => {
      const row = this.database.prepare(`
        SELECT id, relationship_id, originating_recap_item_id, text, status,
               version, resolved_at, created_at, updated_at
        FROM dc_promises
        WHERE id = ? AND user_id = ?
      `).get(input.promiseId, input.userId) as PromiseRow | undefined;
      if (!row) throw new DcNotFoundError("Promise not found");
      if (row.version !== input.version) throw new DcVersionConflictError(row.version);
      const now = new Date().toISOString();
      const update = this.database.prepare(`
        UPDATE dc_promises
        SET status = ?, resolved_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND user_id = ? AND version = ?
      `).run(
        input.status,
        input.status === "done" ? now : null,
        now,
        input.promiseId,
        input.userId,
        input.version
      );
      if (update.changes !== 1) throw new DcVersionConflictError(row.version + 1);
      this.database.prepare(`
        UPDATE dc_relationships SET updated_at = ? WHERE id = ? AND user_id = ?
      `).run(now, row.relationship_id, input.userId);
      return row.relationship_id;
    });
    return run();
  }

  search(userId: string, relationshipId: string, query: string, limit = 50): DcSearchResult[] {
    this.requireRelationship(userId, relationshipId);
    const pattern = `%${escapeLike(query.trim())}%`;
    const rows = this.database.prepare(`
      SELECT DISTINCT r.id, r.interaction_id, r.kind, r.proposed_text,
             r.user_text, i.recording_date
      FROM dc_recap_items r
      JOIN dc_interactions i
        ON i.id = r.interaction_id AND i.user_id = r.user_id
      WHERE r.user_id = ?
        AND i.relationship_id = ?
        AND i.status = 'confirmed'
        AND r.disposition = 'kept'
        AND (
          COALESCE(r.user_text, r.proposed_text) LIKE ? ESCAPE '\\'
          OR EXISTS (
            SELECT 1 FROM dc_evidence_snapshots e
            WHERE e.recap_item_id = r.id
              AND e.user_id = r.user_id
              AND e.quote LIKE ? ESCAPE '\\'
          )
        )
      ORDER BY i.recording_date DESC, r.sort_order, r.id
      LIMIT ?
    `).all(userId, relationshipId, pattern, pattern, Math.max(1, Math.min(100, limit))) as Array<{
      id: string;
      interaction_id: string;
      kind: RecapRow["kind"];
      proposed_text: string;
      user_text: string | null;
      recording_date: string;
    }>;
    return rows.map((row) => DcSearchResultSchema.parse({
      recapItemId: row.id,
      interactionId: row.interaction_id,
      kind: row.kind,
      text: row.user_text ?? row.proposed_text,
      recordingDate: row.recording_date,
      evidence: this.evidenceForRecap(userId, row.id)
    }));
  }

  markSourceServerCleaned(userId: string, sourceUploadId: string) {
    const result = this.database.prepare(`
      UPDATE dc_interactions
      SET source_state = 'server_cleaned', updated_at = ?
      WHERE user_id = ? AND source_upload_id = ?
    `).run(new Date().toISOString(), userId, sourceUploadId);
    return result.changes > 0;
  }

  hasInteractionForUpload(userId: string, sourceUploadId: string) {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM dc_interactions
      WHERE user_id = ? AND source_upload_id = ?
    `).get(userId, sourceUploadId));
  }

  hasVoiceEnrollmentSnapshots(userId: string, interactionId: string) {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM dc_voice_enrollment_snapshots
      WHERE user_id = ? AND interaction_id = ?
      LIMIT 1
    `).get(userId, interactionId));
  }

  getInteractionVersionByUpload(userId: string, sourceUploadId: string) {
    const row = this.database.prepare(`
      SELECT id, version FROM dc_interactions
      WHERE user_id = ? AND source_upload_id = ?
    `).get(userId, sourceUploadId) as { id: string; version: number } | undefined;
    return row ? { interactionId: row.id, version: row.version } : null;
  }

  listInteractionSourceMetadata(userId: string) {
    const rows = this.database.prepare(`
      SELECT id, source_upload_id, source_state
      FROM dc_interactions
      WHERE user_id = ?
      ORDER BY id ASC
    `).all(userId) as Array<{
      id: string;
      source_upload_id: string;
      source_state: "available" | "server_cleaned" | "explicitly_deleted";
    }>;
    return rows.map((row) => ({
      interactionId: row.id,
      sourceUploadId: row.source_upload_id,
      sourceState: row.source_state
    }));
  }

  markUploadSourceState(
    userId: string,
    sourceUploadId: string,
    sourceState: "server_cleaned"
  ) {
    const result = this.database.prepare(`
      UPDATE dc_interactions
      SET source_state = ?, updated_at = ?
      WHERE user_id = ? AND source_upload_id = ?
    `).run(sourceState, new Date().toISOString(), userId, sourceUploadId);
    return result.changes > 0;
  }

  deleteInteractionByUpload(
    userId: string,
    sourceUploadId: string,
    expectedInteractionId: string,
    expectedVersion: number
  ) {
    const run = this.database.transaction(() => {
      const row = this.database.prepare(`
        SELECT id, relationship_id, version FROM dc_interactions
        WHERE source_upload_id = ? AND user_id = ?
      `).get(sourceUploadId, userId) as {
        id: string;
        relationship_id: string;
        version: number;
      } | undefined;
      if (!row) return false;
      if (row.id !== expectedInteractionId) {
        throw new DcConflictError("interaction_source_mismatch");
      }
      if (row.version !== expectedVersion) {
        throw new DcVersionConflictError(row.version);
      }
      const result = this.database.prepare(`
        DELETE FROM dc_interactions
        WHERE id = ? AND user_id = ? AND source_upload_id = ? AND version = ?
      `).run(expectedInteractionId, userId, sourceUploadId, expectedVersion);
      if (result.changes !== 1) {
        throw new DcVersionConflictError(
          this.requireInteraction(userId, expectedInteractionId).version
        );
      }
      this.database.prepare(`
        UPDATE dc_relationships SET updated_at = ? WHERE id = ? AND user_id = ?
      `).run(new Date().toISOString(), row.relationship_id, userId);
      return true;
    });
    return run();
  }

  deleteInteraction(userId: string, interactionId: string, expectedVersion: number) {
    const run = this.database.transaction(() => {
      const row = this.requireInteraction(userId, interactionId);
      if (row.version !== expectedVersion) {
        throw new DcVersionConflictError(row.version);
      }
      const result = this.database.prepare(`
        DELETE FROM dc_interactions WHERE id = ? AND user_id = ? AND version = ?
      `).run(interactionId, userId, expectedVersion);
      if (result.changes !== 1) {
        throw new DcVersionConflictError(
          this.requireInteraction(userId, interactionId).version
        );
      }
      this.database.prepare(`
        UPDATE dc_relationships SET updated_at = ? WHERE id = ? AND user_id = ?
      `).run(new Date().toISOString(), row.relationship_id, userId);
      return row.relationship_id;
    });
    return run();
  }

  prepareInteractionDeletion(
    userId: string,
    interactionId: string,
    expectedVersion: number
  ) {
    const run = this.database.transaction(() => {
      const row = this.requireInteraction(userId, interactionId);
      if (row.version !== expectedVersion) {
        throw new DcVersionConflictError(row.version);
      }
      const enrollment = this.database.prepare(`
        SELECT status
        FROM dc_voice_enrollment_outbox
        WHERE user_id = ? AND interaction_id = ?
      `).get(userId, interactionId) as {
        status: VoiceEnrollmentOutboxRow["status"];
      } | undefined;
      if (enrollment?.status === "processing") {
        throw new DcConflictError("voice_enrollment_in_progress");
      }
      if (enrollment?.status === "pending" || enrollment?.status === "failed") {
        const cancelledAt = new Date().toISOString();
        const cancelled = this.database.prepare(`
          UPDATE dc_voice_enrollment_outbox
          SET status = 'cancelled', claim_token = NULL, lease_expires_at = NULL,
              last_error_code = NULL, updated_at = ?
          WHERE user_id = ? AND interaction_id = ? AND status IN ('pending', 'failed')
        `).run(cancelledAt, userId, interactionId);
        if (cancelled.changes !== 1) {
          throw new DcConflictError("voice_enrollment_delete_conflict");
        }
      }
      return {
        interactionId: row.id,
        relationshipId: row.relationship_id,
        sourceUploadId: row.source_upload_id,
        version: row.version
      };
    });
    return run();
  }
}

export function createDateCompanionRepository(database: Database.Database) {
  return new DateCompanionRepository(database);
}
