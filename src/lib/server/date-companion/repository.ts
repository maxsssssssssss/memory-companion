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

import type {
  DcImportInteractionInput,
  DcParticipantMutation,
  DcRecapMutation
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

function recapConfirmationFingerprint(input: {
  version: number;
  mutations: DcRecapMutation[];
}) {
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
  return createHash("sha256")
    .update(JSON.stringify({ version: input.version, mutations }))
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
    const participants = (this.database.prepare(`
      SELECT speaker_id, role, confirmed_at
      FROM dc_participant_assignments
      WHERE interaction_id = ? AND user_id = ?
      ORDER BY speaker_id
    `).all(row.id, userId) as ParticipantRow[]).map((participant) => ({
      speakerId: participant.speaker_id,
      role: participant.role,
      ...(participant.confirmed_at ? { confirmedAt: participant.confirmed_at } : {})
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
      recapItems
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
          (user_id, interaction_id, speaker_id, role, confirmed_by, confirmed_at)
        VALUES (?, ?, ?, 'unresolved', NULL, NULL)
      `);
      for (const speakerId of [...new Set(input.speakerIds)].sort()) {
        insertParticipant.run(input.userId, interactionId, speakerId);
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

  updateRecap(input: {
    userId: string;
    interactionId: string;
    version: number;
    mutations: DcRecapMutation[];
    finalize: boolean;
  }) {
    const run = this.database.transaction(() => {
      const interaction = this.requireInteraction(input.userId, input.interactionId);
      const confirmationFingerprint = input.finalize
        ? recapConfirmationFingerprint(input)
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

      const now = new Date().toISOString();
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

  getInteractionVersionByUpload(userId: string, sourceUploadId: string) {
    const row = this.database.prepare(`
      SELECT id, version FROM dc_interactions
      WHERE user_id = ? AND source_upload_id = ?
    `).get(userId, sourceUploadId) as { id: string; version: number } | undefined;
    return row ? { interactionId: row.id, version: row.version } : null;
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
}

export function createDateCompanionRepository(database: Database.Database) {
  return new DateCompanionRepository(database);
}
