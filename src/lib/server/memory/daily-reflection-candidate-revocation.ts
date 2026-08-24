import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

import { MemoryOwnerResolutionSchema } from "./owner-attribution/types";
import { createMemoryRepository } from "./repository";
import { MemoryWriteInputSchema } from "./types";

const ID_PATTERN = /^\S{1,512}$/u;

export type DailyReflectionMemoryCandidateRevocationInput = {
  id: string;
  userId: string;
  reflectionId: string;
  confirmationId: string;
  candidateId: string;
  operationKey: string;
  payloadDigest: string;
  now: string;
};

export type DailyReflectionMemoryCandidateRevocationResult = {
  outcome: "revoked";
  historicalMemoryId: string;
  removedMemoryEvidenceCount: number;
  removedPersonSourceCount: number;
  reused: boolean;
};

export type DailyReflectionMemoryCardAuthority = {
  reflectionId: string;
  confirmationId: string;
  candidateId: string;
  currentMemoryId: string;
  publicationStatus: "unpublished" | "published";
};

export type DailyReflectionMemoryCandidateRevocationErrorCode =
  | "daily_reflection_candidate_revocation_not_found"
  | "daily_reflection_candidate_revocation_conflict"
  | "daily_reflection_candidate_revocation_payload_missing"
  | "daily_reflection_candidate_revocation_upload_deleted";

export class DailyReflectionMemoryCandidateRevocationError extends Error {
  constructor(readonly code: DailyReflectionMemoryCandidateRevocationErrorCode) {
    super(code);
    this.name = "DailyReflectionMemoryCandidateRevocationError";
  }
}

type PublicationRow = {
  id: string;
  user_id: string;
  reflection_id: string;
  confirmation_id: string;
  upload_id: string;
  status: "unpublished" | "published" | "deleted";
};

type PayloadRow = {
  confirmation_id: string;
  candidate_id: string;
  memory_json: string;
  owner_attribution_json: string;
};

type PersonSourceRow = {
  id: string;
  person_id: string;
  person_evidence_id: string;
  subject_admission_id: string;
  subject_observation_id: string;
  owns_person_evidence: 0 | 1;
  owns_subject_admission: 0 | 1;
  owns_subject_observation: 0 | 1;
  previous_subject_admission_json: string | null;
  previous_subject_observation_json: string | null;
};

type RevocationRow = {
  id: string;
  user_id: string;
  reflection_id: string;
  confirmation_id: string;
  candidate_id: string;
  operation_key: string;
  payload_digest: string;
  historical_memory_id: string;
  removed_memory_evidence_count: number;
  removed_person_source_count: number;
};

function identifier(value: string, label: string) {
  const normalized = value.normalize("NFKC").trim();
  if (!ID_PATTERN.test(normalized)) throw new Error(`Invalid ${label}`);
  return normalized;
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function resultFromRow(row: RevocationRow, reused: boolean): DailyReflectionMemoryCandidateRevocationResult {
  return {
    outcome: "revoked",
    historicalMemoryId: row.historical_memory_id,
    removedMemoryEvidenceCount: row.removed_memory_evidence_count,
    removedPersonSourceCount: row.removed_person_source_count,
    reused
  };
}

function restoreSubjectAdmission(database: Database.Database, raw: string) {
  const row = JSON.parse(raw) as Record<string, unknown>;
  database.prepare(`
    INSERT INTO person_subject_admissions (
      id, account_id, evidence_id, person_id, subject_key, observation_id,
      disposition, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      observation_id = excluded.observation_id,
      disposition = excluded.disposition,
      version = excluded.version,
      updated_at = excluded.updated_at
  `).run(
    row.id,
    row.account_id,
    row.evidence_id,
    row.person_id,
    row.subject_key,
    row.observation_id,
    row.disposition,
    row.version,
    row.created_at,
    row.updated_at
  );
}

function restoreSubjectObservation(database: Database.Database, raw: string) {
  const row = JSON.parse(raw) as Record<string, unknown>;
  database.prepare(`
    INSERT INTO person_subject_observations (
      id, account_id, person_id, evidence_id, status, source, reason,
      confirmed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      source = excluded.source,
      reason = excluded.reason,
      confirmed_at = excluded.confirmed_at,
      updated_at = excluded.updated_at
  `).run(
    row.id,
    row.account_id,
    row.person_id,
    row.evidence_id,
    row.status,
    row.source,
    row.reason,
    row.confirmed_at,
    row.created_at,
    row.updated_at
  );
}

function personEvidenceHasReferences(
  database: Database.Database,
  userId: string,
  evidenceId: string
) {
  return Boolean(database.prepare(`
    SELECT 1 WHERE
      EXISTS (SELECT 1 FROM person_names WHERE account_id = ? AND evidence_id = ?)
      OR EXISTS (SELECT 1 FROM person_identity_links WHERE account_id = ? AND evidence_id = ?)
      OR EXISTS (SELECT 1 FROM person_subject_observations WHERE account_id = ? AND evidence_id = ?)
      OR EXISTS (SELECT 1 FROM person_subject_resolution_audits WHERE account_id = ? AND evidence_id = ?)
      OR EXISTS (SELECT 1 FROM person_relationship_evidence WHERE account_id = ? AND evidence_id = ?)
      OR EXISTS (SELECT 1 FROM person_fact_evidence WHERE account_id = ? AND evidence_id = ?)
      OR EXISTS (SELECT 1 FROM person_fact_transitions WHERE account_id = ? AND evidence_id = ?)
      OR EXISTS (SELECT 1 FROM person_commitment_evidence WHERE account_id = ? AND evidence_id = ?)
      OR EXISTS (SELECT 1 FROM person_commitment_transitions WHERE account_id = ? AND evidence_id = ?)
      OR EXISTS (SELECT 1 FROM person_evidence_dc_links WHERE account_id = ? AND person_evidence_id = ?)
  `).get(
    userId, evidenceId,
    userId, evidenceId,
    userId, evidenceId,
    userId, evidenceId,
    userId, evidenceId,
    userId, evidenceId,
    userId, evidenceId,
    userId, evidenceId,
    userId, evidenceId,
    userId, evidenceId
  ));
}

export function createDailyReflectionMemoryCandidateRevocationRepository(
  database: Database.Database
) {
  const memoryRepository = createMemoryRepository(database);

  function findActiveAuthority(
    rawUserId: string,
    rawCandidateId: string
  ): DailyReflectionMemoryCardAuthority | null {
    const userId = identifier(rawUserId, "user id");
    const candidateId = identifier(rawCandidateId, "candidate id");
    const rows = database.prepare(`
      SELECT publication.reflection_id, publication.status AS publication_status,
             current.confirmation_id, current.candidate_id,
             current.current_memory_id
      FROM memory_daily_reflection_candidate_current_memories current
      INNER JOIN memory_daily_reflection_publications publication
        ON publication.id = current.publication_id
       AND publication.user_id = current.user_id
       AND publication.status IN ('unpublished', 'published')
      INNER JOIN memory_daily_reflection_candidate_receipts receipt
        ON receipt.user_id = current.user_id
       AND receipt.publication_id = current.publication_id
       AND receipt.candidate_id = current.candidate_id
       AND receipt.status = 'admitted'
      INNER JOIN memory_daily_reflection_candidate_payloads payload
        ON payload.user_id = current.user_id
       AND payload.publication_id = current.publication_id
       AND payload.candidate_id = current.candidate_id
       AND payload.confirmation_id = current.confirmation_id
      WHERE current.user_id = ? AND current.candidate_id = ?
        AND current.status = 'active' AND current.current_memory_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM memory_upload_tombstones tombstone
          WHERE tombstone.user_id = publication.user_id
            AND tombstone.upload_id = publication.upload_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM memory_daily_reflection_candidate_revocations revocation
          WHERE revocation.user_id = current.user_id
            AND revocation.publication_id = current.publication_id
            AND revocation.candidate_id = current.candidate_id
        )
      ORDER BY publication.id
    `).all(userId, candidateId) as Array<{
      reflection_id: string;
      publication_status: "unpublished" | "published";
      confirmation_id: string;
      candidate_id: string;
      current_memory_id: string;
    }>;
    if (rows.length === 0) return null;
    if (rows.length !== 1) {
      throw new DailyReflectionMemoryCandidateRevocationError(
        "daily_reflection_candidate_revocation_conflict"
      );
    }
    const row = rows[0]!;
    return {
      reflectionId: row.reflection_id,
      confirmationId: row.confirmation_id,
      candidateId: row.candidate_id,
      currentMemoryId: row.current_memory_id,
      publicationStatus: row.publication_status
    };
  }

  const apply = database.transaction((rawInput: DailyReflectionMemoryCandidateRevocationInput) => {
    const input = {
      id: identifier(rawInput.id, "revocation id"),
      userId: identifier(rawInput.userId, "user id"),
      reflectionId: identifier(rawInput.reflectionId, "reflection id"),
      confirmationId: identifier(rawInput.confirmationId, "confirmation id"),
      candidateId: identifier(rawInput.candidateId, "candidate id"),
      operationKey: identifier(rawInput.operationKey, "operation key"),
      payloadDigest: identifier(rawInput.payloadDigest, "payload digest"),
      now: rawInput.now
    };
    if (!Number.isFinite(Date.parse(input.now))) throw new Error("Invalid revocation timestamp");

    const replay = database.prepare(`
      SELECT * FROM memory_daily_reflection_candidate_revocations
      WHERE user_id = ? AND operation_key = ?
    `).get(input.userId, input.operationKey) as RevocationRow | undefined;
    if (replay) {
      if (
        replay.id !== input.id
        || replay.reflection_id !== input.reflectionId
        || replay.confirmation_id !== input.confirmationId
        || replay.candidate_id !== input.candidateId
        || replay.payload_digest !== input.payloadDigest
      ) {
        throw new DailyReflectionMemoryCandidateRevocationError(
          "daily_reflection_candidate_revocation_conflict"
        );
      }
      return resultFromRow(replay, true);
    }

    const publication = database.prepare(`
      SELECT id, user_id, reflection_id, confirmation_id, upload_id, status
      FROM memory_daily_reflection_publications
      WHERE user_id = ? AND reflection_id = ?
    `).get(input.userId, input.reflectionId) as PublicationRow | undefined;
    if (
      !publication
      || publication.status === "deleted"
    ) {
      throw new DailyReflectionMemoryCandidateRevocationError(
        "daily_reflection_candidate_revocation_not_found"
      );
    }
    if (database.prepare(`
      SELECT 1 FROM memory_upload_tombstones WHERE user_id = ? AND upload_id = ?
    `).get(input.userId, publication.upload_id)) {
      throw new DailyReflectionMemoryCandidateRevocationError(
        "daily_reflection_candidate_revocation_upload_deleted"
      );
    }
    const receipt = database.prepare(`
      SELECT memory_id FROM memory_daily_reflection_candidate_receipts
      WHERE user_id = ? AND publication_id = ? AND candidate_id = ?
        AND status = 'admitted'
    `).get(input.userId, publication.id, input.candidateId) as
      { memory_id: string } | undefined;
    const payload = database.prepare(`
      SELECT confirmation_id, candidate_id, memory_json, owner_attribution_json
      FROM memory_daily_reflection_candidate_payloads
      WHERE user_id = ? AND publication_id = ? AND candidate_id = ?
    `).get(input.userId, publication.id, input.candidateId) as PayloadRow | undefined;
    const current = database.prepare(`
      SELECT confirmation_id, status, current_memory_id
      FROM memory_daily_reflection_candidate_current_memories
      WHERE user_id = ? AND publication_id = ? AND candidate_id = ?
    `).get(input.userId, publication.id, input.candidateId) as
      {
        confirmation_id: string;
        status: "active" | "revoked";
        current_memory_id: string | null;
      } | undefined;
    if (
      !receipt
      || !payload
      || !current
      || payload.confirmation_id !== input.confirmationId
      || current.confirmation_id !== input.confirmationId
      || current.status !== "active"
    ) {
      throw new DailyReflectionMemoryCandidateRevocationError(
        "daily_reflection_candidate_revocation_payload_missing"
      );
    }

    const targetEvidenceCount = (database.prepare(`
      SELECT COUNT(*) AS count
      FROM memory_daily_reflection_evidence_provenance
      WHERE user_id = ? AND publication_id = ? AND confirmation_id = ?
        AND candidate_id = ?
    `).get(
      input.userId,
      publication.id,
      input.confirmationId,
      input.candidateId
    ) as { count: number }).count;
    if (targetEvidenceCount === 0) {
      throw new DailyReflectionMemoryCandidateRevocationError(
        "daily_reflection_candidate_revocation_payload_missing"
      );
    }

    const personSources = database.prepare(`
      SELECT id, person_id, person_evidence_id, subject_admission_id,
        subject_observation_id, owns_person_evidence, owns_subject_admission,
        owns_subject_observation, previous_subject_admission_json,
        previous_subject_observation_json
      FROM memory_daily_reflection_candidate_person_sources
      WHERE user_id = ? AND publication_id = ? AND confirmation_id = ?
        AND candidate_id = ? AND status = 'active'
      ORDER BY id
    `).all(
      input.userId,
      publication.id,
      input.confirmationId,
      input.candidateId
    ) as PersonSourceRow[];
    database.prepare(`
      UPDATE memory_daily_reflection_candidate_person_sources
      SET status = 'revoked', revocation_id = ?, revoked_at = ?, updated_at = ?
      WHERE user_id = ? AND publication_id = ? AND confirmation_id = ?
        AND candidate_id = ? AND status = 'active'
    `).run(
      input.id,
      input.now,
      input.now,
      input.userId,
      publication.id,
      input.confirmationId,
      input.candidateId
    );

    for (const source of personSources) {
      const activeAdmissionSource = database.prepare(`
        SELECT 1 FROM memory_daily_reflection_candidate_person_sources
        WHERE user_id = ? AND subject_admission_id = ? AND status = 'active'
        LIMIT 1
      `).get(input.userId, source.subject_admission_id);
      if (!activeAdmissionSource) {
        if (source.previous_subject_admission_json) {
          restoreSubjectAdmission(database, source.previous_subject_admission_json);
        } else {
          const owned = database.prepare(`
            SELECT 1 FROM memory_daily_reflection_candidate_person_sources
            WHERE user_id = ? AND subject_admission_id = ? AND owns_subject_admission = 1
            LIMIT 1
          `).get(input.userId, source.subject_admission_id);
          if (owned) {
            database.prepare(`
              DELETE FROM person_subject_admissions WHERE id = ? AND account_id = ?
            `).run(source.subject_admission_id, input.userId);
          }
        }
      }
      const activeObservationSource = database.prepare(`
        SELECT 1 FROM memory_daily_reflection_candidate_person_sources
        WHERE user_id = ? AND subject_observation_id = ? AND status = 'active'
        LIMIT 1
      `).get(input.userId, source.subject_observation_id);
      if (!activeObservationSource) {
        if (source.previous_subject_observation_json) {
          restoreSubjectObservation(database, source.previous_subject_observation_json);
        } else {
          const owned = database.prepare(`
            SELECT 1 FROM memory_daily_reflection_candidate_person_sources
            WHERE user_id = ? AND subject_observation_id = ?
              AND owns_subject_observation = 1 LIMIT 1
          `).get(input.userId, source.subject_observation_id);
          if (owned) {
            database.prepare(`
              DELETE FROM person_subject_observations
              WHERE id = ? AND account_id = ?
                AND NOT EXISTS (
                  SELECT 1 FROM person_subject_admissions admission
                  WHERE admission.account_id = ? AND admission.observation_id = ?
                )
            `).run(
              source.subject_observation_id,
              input.userId,
              input.userId,
              source.subject_observation_id
            );
          }
        }
      }
      const activeEvidenceSource = database.prepare(`
        SELECT 1 FROM memory_daily_reflection_candidate_person_sources
        WHERE user_id = ? AND person_evidence_id = ? AND status = 'active'
        LIMIT 1
      `).get(input.userId, source.person_evidence_id);
      if (!activeEvidenceSource) {
        const owned = database.prepare(`
          SELECT 1 FROM memory_daily_reflection_candidate_person_sources
          WHERE user_id = ? AND person_evidence_id = ? AND owns_person_evidence = 1
          LIMIT 1
        `).get(input.userId, source.person_evidence_id);
        if (
          owned
          && !personEvidenceHasReferences(database, input.userId, source.person_evidence_id)
        ) {
          database.prepare(`
            DELETE FROM person_evidence WHERE id = ? AND account_id = ?
          `).run(source.person_evidence_id, input.userId);
        }
      }
    }

    database.prepare(`
      UPDATE memory_daily_reflection_candidate_current_memories
      SET status = 'revoked', current_memory_id = NULL, revocation_id = ?,
          revoked_at = ?, updated_at = ?
      WHERE user_id = ? AND publication_id = ? AND confirmation_id = ?
        AND candidate_id = ? AND status = 'active'
    `).run(
      input.id,
      input.now,
      input.now,
      input.userId,
      publication.id,
      input.confirmationId,
      input.candidateId
    );

    const remainingPayloads = database.prepare(`
      SELECT payload.confirmation_id, payload.candidate_id, payload.memory_json,
             payload.owner_attribution_json
      FROM memory_daily_reflection_candidate_payloads payload
      INNER JOIN memory_daily_reflection_candidate_current_memories current
        ON current.user_id = payload.user_id
        AND current.publication_id = payload.publication_id
        AND current.candidate_id = payload.candidate_id
        AND current.status = 'active'
      WHERE payload.user_id = ? AND payload.publication_id = ?
      ORDER BY payload.candidate_id
    `).all(input.userId, publication.id) as PayloadRow[];
    memoryRepository.replaceUploadMemories({
      userId: input.userId,
      uploadId: publication.upload_id,
      memories: remainingPayloads.map((row) => MemoryWriteInputSchema.parse(JSON.parse(row.memory_json))),
      ownerAttributions: remainingPayloads.map((row) =>
        MemoryOwnerResolutionSchema.parse(JSON.parse(row.owner_attribution_json)))
    });

    for (const remaining of remainingPayloads) {
      const memoryIds = database.prepare(`
        SELECT DISTINCT evidence.memory_id
        FROM memory_daily_reflection_evidence_provenance provenance
        INNER JOIN memory_evidence evidence ON evidence.id = provenance.memory_evidence_id
        WHERE provenance.user_id = ? AND provenance.publication_id = ?
          AND provenance.candidate_id = ?
        ORDER BY evidence.memory_id
      `).all(input.userId, publication.id, remaining.candidate_id) as Array<{ memory_id: string }>;
      if (memoryIds.length !== 1) {
        throw new DailyReflectionMemoryCandidateRevocationError(
          "daily_reflection_candidate_revocation_payload_missing"
        );
      }
      database.prepare(`
        UPDATE memory_daily_reflection_candidate_current_memories
        SET current_memory_id = ?, updated_at = ?
        WHERE user_id = ? AND publication_id = ? AND candidate_id = ? AND status = 'active'
      `).run(
        memoryIds[0]!.memory_id,
        input.now,
        input.userId,
        publication.id,
        remaining.candidate_id
      );
    }
    database.prepare(`
      DELETE FROM memory_daily_reflection_candidate_payloads
      WHERE user_id = ? AND publication_id = ? AND confirmation_id = ?
        AND candidate_id = ?
    `).run(
      input.userId,
      publication.id,
      input.confirmationId,
      input.candidateId
    );

    database.prepare(`
      INSERT INTO memory_daily_reflection_candidate_revocations (
        id, user_id, publication_id, reflection_id, confirmation_id,
        candidate_id, upload_id, operation_key, payload_digest, outcome,
        historical_memory_id, removed_memory_evidence_count,
        removed_person_source_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'revoked', ?, ?, ?, ?)
    `).run(
      input.id,
      input.userId,
      publication.id,
      input.reflectionId,
      input.confirmationId,
      input.candidateId,
      publication.upload_id,
      input.operationKey,
      input.payloadDigest,
      receipt.memory_id,
      targetEvidenceCount,
      personSources.length,
      input.now
    );
    const inserted = database.prepare(`
      SELECT * FROM memory_daily_reflection_candidate_revocations
      WHERE id = ? AND user_id = ?
    `).get(input.id, input.userId) as RevocationRow;
    return resultFromRow(inserted, false);
  });

  return {
    apply: (input: DailyReflectionMemoryCandidateRevocationInput) => apply.immediate(input),
    findActiveAuthority
  };
}

export function dailyReflectionCandidateRevocationPayloadDigest(input: {
  userId: string;
  reflectionId: string;
  confirmationId: string;
  candidateId: string;
  operationKey: string;
}) {
  return digest({ version: 1, ...input });
}
