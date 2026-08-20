import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

import type { TranscriptSegment } from "@/lib/domain/types";
import { createPersonAdmissionRepository } from "@/lib/server/person/admission-repository";
import type { ValidatedPersonTranscriptEvidence } from "@/lib/server/person/evidence";

import {
  MemoryOwnerResolutionSchema,
  type MemoryOwnerResolution
} from "./owner-attribution/types";
import { createMemoryRepository } from "./repository";
import { MemoryWriteInputSchema, type MemoryWriteInput } from "./types";

export type DailyReflectionPublicationErrorCode =
  | "daily_reflection_publication_conflict"
  | "daily_reflection_upload_deleted"
  | "daily_reflection_publication_evidence_missing";

export class DailyReflectionPublicationError extends Error {
  constructor(readonly code: DailyReflectionPublicationErrorCode) {
    super(code);
    this.name = "DailyReflectionPublicationError";
  }
}

export type DailyReflectionPublicationCandidate = {
  candidateId: string;
  operationKey: string;
  status: "admitted" | "rejected";
  reasonCode: string | null;
  memory: MemoryWriteInput | null;
  ownerAttribution: MemoryOwnerResolution | null;
  subjectPersonId: string | null;
  subjectEvidence: ValidatedPersonTranscriptEvidence[];
  evidenceDigests: Array<{
    memoryEvidenceId: string;
    sourceSegmentId: string;
    contentDigest: string;
  }>;
};

export type DailyReflectionPublicationInput = {
  id: string;
  userId: string;
  reflectionId: string;
  confirmationId: string;
  confirmationFingerprint: string;
  uploadId: string;
  sourceOrigin: "user_reflection";
  payloadDigest: string;
  sourceSegments: TranscriptSegment[];
  candidates: DailyReflectionPublicationCandidate[];
  now: string;
};

export type DailyReflectionPublicationCandidateResult = {
  candidateId: string;
  operationKey: string;
  status: "admitted" | "already_admitted" | "rejected";
  memoryId: string | null;
  reasonCode: string | null;
};

type PublicationRow = {
  id: string;
  user_id: string;
  reflection_id: string;
  confirmation_id: string;
  upload_id: string;
  confirmation_fingerprint: string;
  payload_digest: string;
  source_origin: "user_reflection";
  status: "unpublished" | "published" | "deleted";
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type ReceiptRow = {
  candidate_id: string;
  status: "admitted" | "rejected";
  memory_id: string | null;
  reason_code: string | null;
  operation_key: string;
};

function publicationResults(rows: ReceiptRow[], replay: boolean) {
  return rows.map((row): DailyReflectionPublicationCandidateResult => ({
    candidateId: row.candidate_id,
    operationKey: row.operation_key,
    status: row.status === "admitted" && replay ? "already_admitted" : row.status,
    memoryId: row.memory_id,
    reasonCode: row.reason_code
  }));
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, 32)}`;
}

export function createDailyReflectionMemoryPublicationRepository(
  database: Database.Database
) {
  const memoryRepository = createMemoryRepository(database);
  const personAdmissionRepository = createPersonAdmissionRepository(database);

  function getPublication(userId: string, reflectionId: string) {
    return database.prepare(`
      SELECT * FROM memory_daily_reflection_publications
      WHERE user_id = ? AND reflection_id = ?
    `).get(userId, reflectionId) as PublicationRow | undefined;
  }

  function listResults(userId: string, publicationId: string) {
    return database.prepare(`
      SELECT candidate_id, status, memory_id, reason_code, operation_key
      FROM memory_daily_reflection_candidate_receipts
      WHERE user_id = ? AND publication_id = ?
      ORDER BY candidate_id
    `).all(userId, publicationId) as ReceiptRow[];
  }

  const publish = database.transaction((input: DailyReflectionPublicationInput) => {
    const tombstone = database.prepare(`
      SELECT 1 FROM memory_upload_tombstones
      WHERE user_id = ? AND upload_id = ?
    `).get(input.userId, input.uploadId);
    if (tombstone) {
      throw new DailyReflectionPublicationError("daily_reflection_upload_deleted");
    }

    const existing = getPublication(input.userId, input.reflectionId);
    if (existing) {
      if (existing.status === "deleted") {
        throw new DailyReflectionPublicationError("daily_reflection_upload_deleted");
      }
      if (
        existing.id !== input.id
        || existing.confirmation_id !== input.confirmationId
        || existing.upload_id !== input.uploadId
        || existing.confirmation_fingerprint !== input.confirmationFingerprint
        || existing.payload_digest !== input.payloadDigest
        || existing.source_origin !== input.sourceOrigin
      ) {
        throw new DailyReflectionPublicationError("daily_reflection_publication_conflict");
      }
      return {
        publication: existing,
        results: publicationResults(listResults(input.userId, existing.id), true),
        reused: true
      };
    }

    const admitted = input.candidates.filter(
      (candidate): candidate is DailyReflectionPublicationCandidate & {
        status: "admitted";
        memory: MemoryWriteInput;
        ownerAttribution: MemoryOwnerResolution;
      } => candidate.status === "admitted"
        && candidate.memory !== null
        && candidate.ownerAttribution !== null
    );
    if (admitted.length === 0) {
      throw new DailyReflectionPublicationError("daily_reflection_publication_conflict");
    }

    database.prepare(`
      INSERT INTO memory_daily_reflection_publications (
        id, user_id, reflection_id, confirmation_id, upload_id,
        confirmation_fingerprint, payload_digest, source_origin, status,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unpublished', ?, ?, NULL)
    `).run(
      input.id,
      input.userId,
      input.reflectionId,
      input.confirmationId,
      input.uploadId,
      input.confirmationFingerprint,
      input.payloadDigest,
      input.sourceOrigin,
      input.now,
      input.now
    );

    const insertPayload = database.prepare(`
      INSERT INTO memory_daily_reflection_candidate_payloads (
        user_id, publication_id, reflection_id, confirmation_id, candidate_id,
        memory_json, owner_attribution_json, subject_person_id,
        payload_digest, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const candidate of admitted) {
      const memory = MemoryWriteInputSchema.parse(candidate.memory);
      const ownerAttribution = MemoryOwnerResolutionSchema.parse(candidate.ownerAttribution);
      insertPayload.run(
        input.userId,
        input.id,
        input.reflectionId,
        input.confirmationId,
        candidate.candidateId,
        JSON.stringify(memory),
        JSON.stringify(ownerAttribution),
        candidate.subjectPersonId,
        digest({
          memory,
          ownerAttribution,
          subjectPersonId: candidate.subjectPersonId,
          evidenceDigests: candidate.evidenceDigests
        }),
        input.now
      );
    }

    memoryRepository.replaceUploadMemories({
      userId: input.userId,
      uploadId: input.uploadId,
      memories: admitted.map((candidate) => candidate.memory),
      sourceSegments: input.sourceSegments,
      ownerAttributions: admitted.map((candidate) => candidate.ownerAttribution)
    });

    const insertReceipt = database.prepare(`
      INSERT INTO memory_daily_reflection_candidate_receipts (
        user_id, publication_id, candidate_id, status, memory_id,
        reason_code, operation_key, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertProvenance = database.prepare(`
      INSERT INTO memory_daily_reflection_evidence_provenance (
        memory_evidence_id, user_id, publication_id, reflection_id,
        confirmation_id, candidate_id, upload_id, source_segment_id,
        source_origin, content_digest, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const evidenceMemory = database.prepare(`
      SELECT memory_id, upload_id, source_id
      FROM memory_evidence WHERE id = ?
    `);
    const insertCurrentMemory = database.prepare(`
      INSERT INTO memory_daily_reflection_candidate_current_memories (
        user_id, publication_id, reflection_id, confirmation_id, candidate_id,
        status, current_memory_id, revocation_id, created_at, updated_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?, NULL)
    `);
    const insertPersonSource = database.prepare(`
      INSERT INTO memory_daily_reflection_candidate_person_sources (
        id, user_id, publication_id, reflection_id, confirmation_id, candidate_id,
        person_id, person_evidence_id, subject_admission_id,
        subject_observation_id, source_segment_id,
        owns_person_evidence, owns_subject_admission, owns_subject_observation,
        previous_subject_admission_json, previous_subject_observation_json,
        status, revocation_id, created_at, updated_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'active', NULL, ?, ?, NULL)
    `);
    const results: DailyReflectionPublicationCandidateResult[] = [];
    for (const candidate of input.candidates) {
      let memoryId: string | null = null;
      if (candidate.status === "admitted") {
        const evidenceMemoryIds = new Set<string>();
        for (const provenance of candidate.evidenceDigests) {
          const evidence = evidenceMemory.get(provenance.memoryEvidenceId) as {
            memory_id: string;
            upload_id: string;
            source_id: string;
          } | undefined;
          if (
            !evidence
            || evidence.upload_id !== input.uploadId
            || evidence.source_id !== provenance.sourceSegmentId
          ) {
            throw new DailyReflectionPublicationError(
              "daily_reflection_publication_evidence_missing"
            );
          }
          evidenceMemoryIds.add(evidence.memory_id);
          insertProvenance.run(
            provenance.memoryEvidenceId,
            input.userId,
            input.id,
            input.reflectionId,
            input.confirmationId,
            candidate.candidateId,
            input.uploadId,
            provenance.sourceSegmentId,
            input.sourceOrigin,
            provenance.contentDigest,
            input.now
          );
        }
        if (evidenceMemoryIds.size !== 1) {
          throw new DailyReflectionPublicationError(
            "daily_reflection_publication_evidence_missing"
          );
        }
        memoryId = [...evidenceMemoryIds][0] ?? null;
        if (!memoryId) {
          throw new DailyReflectionPublicationError(
            "daily_reflection_publication_evidence_missing"
          );
        }
        insertCurrentMemory.run(
          input.userId,
          input.id,
          input.reflectionId,
          input.confirmationId,
          candidate.candidateId,
          memoryId,
          input.now,
          input.now
        );
        if (candidate.subjectPersonId) {
          for (const evidence of candidate.subjectEvidence) {
            const previousEvidence = database.prepare(`
              SELECT * FROM person_evidence WHERE id = ? AND account_id = ?
            `).get(evidence.id, input.userId);
            const previousAdmission = database.prepare(`
              SELECT * FROM person_subject_admissions
              WHERE account_id = ? AND evidence_id = ? AND subject_key = ?
            `).get(input.userId, evidence.id, candidate.subjectPersonId);
            const previousObservation = database.prepare(`
              SELECT * FROM person_subject_observations
              WHERE account_id = ? AND evidence_id = ? AND person_id = ?
              ORDER BY CASE status WHEN 'confirmed' THEN 0 ELSE 1 END, updated_at DESC, id
              LIMIT 1
            `).get(input.userId, evidence.id, candidate.subjectPersonId);
            const previousAdmissionManaged = previousAdmission && database.prepare(`
              SELECT 1 FROM memory_daily_reflection_candidate_person_sources
              WHERE user_id = ? AND subject_admission_id = ? AND status = 'active'
              LIMIT 1
            `).get(
              input.userId,
              (previousAdmission as { id: string }).id
            );
            const previousObservationManaged = previousObservation && database.prepare(`
              SELECT 1 FROM memory_daily_reflection_candidate_person_sources
              WHERE user_id = ? AND subject_observation_id = ? AND status = 'active'
              LIMIT 1
            `).get(
              input.userId,
              (previousObservation as { id: string }).id
            );
            const admission = personAdmissionRepository.recordSubjectAdmission({
              accountId: input.userId,
              personId: candidate.subjectPersonId,
              disposition: "confirmed",
              expectedVersion: 0,
              evidence,
              now: input.now
            });
            insertPersonSource.run(
              stableId(
                "memory_daily_reflection_person_source",
                input.userId,
                input.id,
                candidate.candidateId,
                evidence.id,
                candidate.subjectPersonId
              ),
              input.userId,
              input.id,
              input.reflectionId,
              input.confirmationId,
              candidate.candidateId,
              candidate.subjectPersonId,
              evidence.id,
              admission.id,
              admission.observationId,
              evidence.sourceSegmentId,
              previousEvidence ? 0 : 1,
              previousAdmission ? 0 : 1,
              previousObservation ? 0 : 1,
              previousAdmission && !previousAdmissionManaged
                ? JSON.stringify(previousAdmission)
                : null,
              previousObservation && !previousObservationManaged
                ? JSON.stringify(previousObservation)
                : null,
              input.now,
              input.now
            );
          }
        }
      }
      insertReceipt.run(
        input.userId,
        input.id,
        candidate.candidateId,
        candidate.status,
        memoryId,
        candidate.reasonCode,
        candidate.operationKey,
        input.now
      );
      results.push({
        candidateId: candidate.candidateId,
        operationKey: candidate.operationKey,
        status: candidate.status,
        memoryId,
        reasonCode: candidate.reasonCode
      });
    }

    return {
      publication: getPublication(input.userId, input.reflectionId)!,
      results: results.sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
      reused: false
    };
  });

  const markPublished = database.transaction((input: {
    userId: string;
    reflectionId: string;
    now: string;
  }) => {
    const existing = getPublication(input.userId, input.reflectionId);
    if (!existing) return null;
    if (existing.status === "deleted") {
      throw new DailyReflectionPublicationError("daily_reflection_upload_deleted");
    }
    if (existing.status === "unpublished") {
      database.prepare(`
        UPDATE memory_daily_reflection_publications
        SET status = 'published', updated_at = ?
        WHERE id = ? AND user_id = ? AND reflection_id = ?
          AND status = 'unpublished'
      `).run(input.now, existing.id, input.userId, input.reflectionId);
    }
    return getPublication(input.userId, input.reflectionId) ?? null;
  });

  return {
    publish: (input: DailyReflectionPublicationInput) => publish.immediate(input),
    markPublished: (input: { userId: string; reflectionId: string; now: string }) =>
      markPublished.immediate(input),
    getPublication,
    listResults
  };
}

export type DailyReflectionMemoryPublicationRepository = ReturnType<
  typeof createDailyReflectionMemoryPublicationRepository
>;
