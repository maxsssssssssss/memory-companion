import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  assertValidatedPersonTranscriptEvidence,
  type ValidatedPersonTranscriptEvidence
} from "./evidence";
import { persistValidatedPersonEvidence } from "./repository";
import { PersonEvidenceSchema, type PersonEvidence } from "./types";

const RECORD_ID_PATTERN = /^[^\s]+$/u;
const TimestampSchema = z.string().datetime();

export type PersonLifecycleErrorCode =
  | "insufficient_evidence"
  | "unavailable_person"
  | "subject_evidence_mismatch"
  | "unavailable_relationship"
  | "evidence_account_mismatch"
  | "invalid_time"
  | "invalid_time_order"
  | "invalid_transition"
  | "version_conflict"
  | "incompatible_replacement"
  | "persisted_state_conflict";

export class PersonLifecycleError extends Error {
  constructor(readonly code: PersonLifecycleErrorCode, message: string) {
    super(message);
    this.name = "PersonLifecycleError";
  }
}

type PersonEvidenceRow = {
  id: string;
  account_id: string;
  upload_id: string;
  source_segment_id: string;
  quote: string;
  created_at: string;
  updated_at: string;
};

export function assertLifecycleIdentifier(value: string, label: string) {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > 512 || !RECORD_ID_PATTERN.test(normalized)) {
    throw new PersonLifecycleError("persisted_state_conflict", `Invalid ${label}`);
  }
  return normalized;
}

export function normalizeLifecycleTimestamp(value: string, label: string) {
  const parsed = TimestampSchema.safeParse(value);
  if (!parsed.success) {
    throw new PersonLifecycleError("invalid_time", `Invalid ${label}`);
  }
  const milliseconds = Date.parse(parsed.data);
  if (!Number.isFinite(milliseconds)) {
    throw new PersonLifecycleError("invalid_time", `Invalid ${label}`);
  }
  return new Date(milliseconds).toISOString();
}

export function normalizeOptionalLifecycleTimestamp(value: string | null | undefined, label: string) {
  return value === null || value === undefined ? null : normalizeLifecycleTimestamp(value, label);
}

export function normalizeLifecycleText(value: string, label: string, maxLength = 4_000) {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > maxLength) {
    throw new PersonLifecycleError("persisted_state_conflict", `Invalid ${label}`);
  }
  return normalized;
}

export function stableLifecycleId(prefix: string, ...values: string[]) {
  const digest = createHash("sha256")
    .update(values.join("\u0000"))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

export function personEvidenceFromLifecycleRow(row: PersonEvidenceRow): PersonEvidence {
  return PersonEvidenceSchema.parse({
    id: row.id,
    accountId: row.account_id,
    uploadId: row.upload_id,
    sourceSegmentId: row.source_segment_id,
    quote: row.quote,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

export function loadLifecycleEvidence(
  database: Database.Database,
  accountId: string,
  evidenceId: string
) {
  const row = database.prepare(`
    SELECT * FROM person_evidence WHERE id = ? AND account_id = ?
  `).get(evidenceId, accountId) as PersonEvidenceRow | undefined;
  if (!row) {
    throw new PersonLifecycleError("insufficient_evidence", "Canonical Transcript Evidence is unavailable");
  }
  return personEvidenceFromLifecycleRow(row);
}

export function requireConfirmedPeople(
  database: Database.Database,
  accountId: string,
  personIds: string[]
) {
  const uniqueIds = [...new Set(personIds)].sort();
  if (uniqueIds.length !== personIds.length) {
    throw new PersonLifecycleError("insufficient_evidence", "Lifecycle roles require distinct Persons");
  }
  for (const personId of uniqueIds) {
    const row = database.prepare(`
      SELECT 1 FROM person_entities
      WHERE id = ? AND account_id = ? AND status = 'confirmed'
    `).get(personId, accountId);
    if (!row) {
      throw new PersonLifecycleError(
        "unavailable_person",
        "Lifecycle Person is unavailable or unconfirmed for this account"
      );
    }
  }
}

export function persistEvidenceForExactSubjects(
  database: Database.Database,
  input: {
    accountId: string;
    subjectPersonIds: string[];
    evidence: ValidatedPersonTranscriptEvidence;
    now: string;
  }
) {
  assertValidatedPersonTranscriptEvidence(input.evidence);
  if (input.evidence.accountId !== input.accountId) {
    throw new PersonLifecycleError(
      "evidence_account_mismatch",
      "Lifecycle Evidence belongs to another account"
    );
  }
  const expectedSubjectIds = [...new Set(input.subjectPersonIds)].sort();
  if (expectedSubjectIds.length !== input.subjectPersonIds.length || expectedSubjectIds.length === 0) {
    throw new PersonLifecycleError("insufficient_evidence", "Lifecycle Subject roles are incomplete");
  }
  requireConfirmedPeople(database, input.accountId, expectedSubjectIds);
  persistValidatedPersonEvidence(database, {
    accountId: input.accountId,
    evidence: input.evidence,
    now: input.now
  });
  const actualSubjectIds = (database.prepare(`
    SELECT DISTINCT subject.person_id AS person_id
    FROM person_subject_observations subject
    INNER JOIN person_entities person
      ON person.id = subject.person_id AND person.account_id = subject.account_id
    WHERE subject.account_id = ? AND subject.evidence_id = ?
      AND subject.status = 'confirmed' AND person.status = 'confirmed'
    ORDER BY subject.person_id
  `).all(input.accountId, input.evidence.id) as Array<{ person_id: string }>)
    .map((row) => row.person_id);
  if (
    actualSubjectIds.length !== expectedSubjectIds.length ||
    actualSubjectIds.some((personId, index) => personId !== expectedSubjectIds[index])
  ) {
    throw new PersonLifecycleError(
      "subject_evidence_mismatch",
      "Canonical Transcript Evidence does not have the exact confirmed Subjects required"
    );
  }
  return loadLifecycleEvidence(database, input.accountId, input.evidence.id);
}

export function requireConfirmedLifecycleRelationship(
  database: Database.Database,
  input: {
    accountId: string;
    relationshipId: string | null;
    endpointPersonIds: string[];
    requireExactEndpoints?: boolean;
  }
) {
  if (!input.relationshipId) {
    return null;
  }
  const row = database.prepare(`
    SELECT relationship.person_a_id, relationship.person_b_id
    FROM person_relationships relationship
    INNER JOIN person_entities person_a
      ON person_a.id = relationship.person_a_id
      AND person_a.account_id = relationship.account_id
    INNER JOIN person_entities person_b
      ON person_b.id = relationship.person_b_id
      AND person_b.account_id = relationship.account_id
    WHERE relationship.id = ? AND relationship.account_id = ?
      AND relationship.status = 'confirmed'
      AND relationship.explicitly_confirmed = 1
      AND relationship.confirmed_at IS NOT NULL
      AND person_a.status = 'confirmed' AND person_b.status = 'confirmed'
      AND EXISTS (
        SELECT 1 FROM person_relationship_evidence relationship_evidence
        INNER JOIN person_evidence evidence
          ON evidence.id = relationship_evidence.evidence_id
          AND evidence.account_id = relationship_evidence.account_id
        WHERE relationship_evidence.account_id = relationship.account_id
          AND relationship_evidence.relationship_id = relationship.id
      )
  `).get(input.relationshipId, input.accountId) as {
    person_a_id: string;
    person_b_id: string;
  } | undefined;
  if (!row) {
    throw new PersonLifecycleError(
      "unavailable_relationship",
      "Relationship is unavailable, unconfirmed, or unsupported by Evidence"
    );
  }
  const endpoints = [row.person_a_id, row.person_b_id].sort();
  const requested = [...new Set(input.endpointPersonIds)].sort();
  const matches = input.requireExactEndpoints
    ? requested.length === endpoints.length && requested.every((id, index) => id === endpoints[index])
    : requested.every((id) => endpoints.includes(id));
  if (!matches) {
    throw new PersonLifecycleError(
      "unavailable_relationship",
      "Lifecycle Person is not a compatible endpoint of the Relationship"
    );
  }
  return input.relationshipId;
}

export function assertStrictlyLater(
  later: string,
  earlier: string,
  message: string
) {
  if (Date.parse(later) <= Date.parse(earlier)) {
    throw new PersonLifecycleError("invalid_time_order", message);
  }
}
