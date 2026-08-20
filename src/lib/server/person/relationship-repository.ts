import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  assertValidatedPersonTranscriptEvidence,
  type ValidatedPersonTranscriptEvidence
} from "./evidence";
import { persistValidatedPersonEvidence, PersonRepositoryError } from "./repository";
import {
  PersonEvidenceSchema,
  PersonRelationshipSchema,
  PersonRelationshipTypeSchema,
  type PersonEvidence,
  type PersonRelationship,
  type PersonRelationshipType
} from "./types";

const RECORD_ID_PATTERN = /^[^\s]+$/u;

type PersonRelationshipRow = {
  id: string;
  account_id: string;
  person_a_id: string;
  person_b_id: string;
  type: string;
  status: string;
  explicitly_confirmed: number;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
};

type PersonRelationshipAdmissionRow = {
  version: number;
};

type PersonEvidenceRow = {
  id: string;
  account_id: string;
  upload_id: string;
  source_segment_id: string;
  quote: string;
  created_at: string;
  updated_at: string;
};

function assertIdentifier(value: string, label: string) {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > 512 || !RECORD_ID_PATTERN.test(normalized)) {
    throw new PersonRepositoryError(`Invalid ${label}`);
  }
  return normalized;
}

function stableId(prefix: string, ...values: string[]) {
  const digest = createHash("sha256")
    .update(values.join("\u0000"))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

function canonicalEndpoints(personAId: string, personBId: string) {
  if (personAId === personBId) {
    throw new PersonRepositoryError("Relationship endpoints must be different Persons");
  }
  return [personAId, personBId].sort() as [string, string];
}

function evidenceFromRow(row: PersonEvidenceRow): PersonEvidence {
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

export function createPersonRelationshipRepository(database: Database.Database) {
  function requireConfirmedPerson(accountId: string, personId: string) {
    const person = database.prepare(`
      SELECT 1
      FROM person_entities
      WHERE id = ? AND account_id = ? AND status = 'confirmed'
    `).get(personId, accountId);
    if (!person) {
      throw new PersonRepositoryError("Relationship endpoint is unavailable or unconfirmed");
    }
  }

  function loadEvidence(accountId: string, relationshipId: string) {
    return (database.prepare(`
      SELECT evidence.*
      FROM person_relationship_evidence relationship_evidence
      INNER JOIN person_evidence evidence
        ON evidence.id = relationship_evidence.evidence_id
        AND evidence.account_id = relationship_evidence.account_id
      WHERE relationship_evidence.account_id = ?
        AND relationship_evidence.relationship_id = ?
      ORDER BY evidence.created_at, evidence.id
    `).all(accountId, relationshipId) as PersonEvidenceRow[]).map(evidenceFromRow);
  }

  function relationshipFromRow(row: PersonRelationshipRow): PersonRelationship {
    const admission = database.prepare(`
      SELECT version FROM person_relationship_admissions
      WHERE account_id = ? AND relationship_id = ?
    `).get(row.account_id, row.id) as PersonRelationshipAdmissionRow | undefined;
    return PersonRelationshipSchema.parse({
      id: row.id,
      accountId: row.account_id,
      personAId: row.person_a_id,
      personBId: row.person_b_id,
      type: row.type,
      status: row.status,
      version: admission?.version ?? 1,
      explicitlyConfirmed: row.explicitly_confirmed === 1,
      confirmedAt: row.confirmed_at,
      evidence: loadEvidence(row.account_id, row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }

  function getForReview(accountIdInput: string, relationshipIdInput: string) {
    const accountId = assertIdentifier(accountIdInput, "account id");
    const relationshipId = assertIdentifier(relationshipIdInput, "relationship id");
    const row = database.prepare(`
      SELECT * FROM person_relationships WHERE id = ? AND account_id = ?
    `).get(relationshipId, accountId) as PersonRelationshipRow | undefined;
    return row ? relationshipFromRow(row) : null;
  }

  function createCandidate(input: {
    accountId: string;
    personAId: string;
    personBId: string;
    type: PersonRelationshipType;
    evidence: ValidatedPersonTranscriptEvidence;
    now?: string;
  }) {
    const accountId = assertIdentifier(input.accountId, "account id");
    const [personAId, personBId] = canonicalEndpoints(
      assertIdentifier(input.personAId, "person A id"),
      assertIdentifier(input.personBId, "person B id")
    );
    const type = PersonRelationshipTypeSchema.parse(input.type);
    const now = input.now ?? new Date().toISOString();
    assertValidatedPersonTranscriptEvidence(input.evidence);
    if (input.evidence.accountId !== accountId) {
      throw new PersonRepositoryError("Relationship Evidence belongs to another account");
    }
    return database.transaction(() => {
      requireConfirmedPerson(accountId, personAId);
      requireConfirmedPerson(accountId, personBId);
      const id = stableId("person_relationship", accountId, personAId, personBId, type);
      const existing = database.prepare(`
        SELECT * FROM person_relationships WHERE id = ? AND account_id = ?
      `).get(id, accountId) as PersonRelationshipRow | undefined;
      if (existing?.status === "confirmed") {
        return relationshipFromRow(existing);
      }
      if (existing && existing.status !== "candidate") {
        throw new PersonRepositoryError("Relationship requires review before it can become a candidate");
      }
      persistValidatedPersonEvidence(database, { accountId, evidence: input.evidence, now });
      database.prepare(`
        INSERT INTO person_relationships (
          id, account_id, person_a_id, person_b_id, type, status,
          explicitly_confirmed, confirmed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'candidate', 0, NULL, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `).run(id, accountId, personAId, personBId, type, now, now);
      const evidenceLinkId = stableId("person_relationship_evidence", accountId, id, input.evidence.id);
      database.prepare(`
        INSERT INTO person_relationship_evidence (
          id, account_id, relationship_id, evidence_id, created_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(account_id, relationship_id, evidence_id) DO NOTHING
      `).run(evidenceLinkId, accountId, id, input.evidence.id, now);
      return relationshipFromRow(database.prepare(`
        SELECT * FROM person_relationships WHERE id = ? AND account_id = ?
      `).get(id, accountId) as PersonRelationshipRow);
    })();
  }

  function confirmRelationship(input: {
    accountId: string;
    relationshipId: string;
    now?: string;
  }) {
    const accountId = assertIdentifier(input.accountId, "account id");
    const relationshipId = assertIdentifier(input.relationshipId, "relationship id");
    const now = input.now ?? new Date().toISOString();
    return database.transaction(() => {
      const row = database.prepare(`
        SELECT * FROM person_relationships WHERE id = ? AND account_id = ?
      `).get(relationshipId, accountId) as PersonRelationshipRow | undefined;
      if (!row) {
        throw new PersonRepositoryError("Relationship is unavailable for this account");
      }
      if (row.status === "confirmed") {
        return relationshipFromRow(row);
      }
      if (row.status !== "candidate") {
        throw new PersonRepositoryError("Conflicted or archived Relationship cannot be confirmed");
      }
      requireConfirmedPerson(accountId, row.person_a_id);
      requireConfirmedPerson(accountId, row.person_b_id);
      const conflict = database.prepare(`
        SELECT 1
        FROM person_relationships
        WHERE account_id = ? AND status = 'conflict' AND id <> ?
          AND (
            (person_a_id = ? AND person_b_id = ?) OR
            (person_a_id = ? AND person_b_id = ?)
          )
        LIMIT 1
      `).get(
        accountId,
        relationshipId,
        row.person_a_id,
        row.person_b_id,
        row.person_b_id,
        row.person_a_id
      );
      if (conflict) {
        throw new PersonRepositoryError("Relationship has an unresolved conflict");
      }
      const evidenceCount = (database.prepare(`
        SELECT COUNT(*) AS count
        FROM person_relationship_evidence relationship_evidence
        INNER JOIN person_evidence evidence
          ON evidence.id = relationship_evidence.evidence_id
          AND evidence.account_id = relationship_evidence.account_id
        WHERE relationship_evidence.account_id = ?
          AND relationship_evidence.relationship_id = ?
      `).get(accountId, relationshipId) as { count: number }).count;
      if (evidenceCount < 1) {
        throw new PersonRepositoryError("Relationship confirmation requires canonical Transcript Evidence");
      }
      database.prepare(`
        UPDATE person_relationships
        SET status = 'confirmed', explicitly_confirmed = 1,
          confirmed_at = ?, updated_at = ?
        WHERE id = ? AND account_id = ? AND status = 'candidate'
      `).run(now, now, relationshipId, accountId);
      return relationshipFromRow(database.prepare(`
        SELECT * FROM person_relationships WHERE id = ? AND account_id = ?
      `).get(relationshipId, accountId) as PersonRelationshipRow);
    })();
  }

  function markConflict(input: {
    accountId: string;
    relationshipId: string;
    now?: string;
  }) {
    const accountId = assertIdentifier(input.accountId, "account id");
    const relationshipId = assertIdentifier(input.relationshipId, "relationship id");
    const now = input.now ?? new Date().toISOString();
    return database.transaction(() => {
      const row = database.prepare(`
        SELECT * FROM person_relationships WHERE id = ? AND account_id = ?
      `).get(relationshipId, accountId) as PersonRelationshipRow | undefined;
      if (!row) {
        throw new PersonRepositoryError("Relationship is unavailable for this account");
      }
      if (row.status === "confirmed") {
        throw new PersonRepositoryError("Conflict review cannot overwrite a confirmed Relationship");
      }
      if (row.status === "archived") {
        throw new PersonRepositoryError("Archived Relationship cannot enter conflict review");
      }
      database.prepare(`
        UPDATE person_relationships
        SET status = 'conflict', explicitly_confirmed = 0,
          confirmed_at = NULL, updated_at = ?
        WHERE id = ? AND account_id = ?
      `).run(now, relationshipId, accountId);
      return relationshipFromRow(database.prepare(`
        SELECT * FROM person_relationships WHERE id = ? AND account_id = ?
      `).get(relationshipId, accountId) as PersonRelationshipRow);
    })();
  }

  function listConfirmedForPerson(accountIdInput: string, personIdInput: string) {
    const accountId = assertIdentifier(accountIdInput, "account id");
    const personId = assertIdentifier(personIdInput, "person id");
    const person = database.prepare(`
      SELECT 1 FROM person_entities
      WHERE id = ? AND account_id = ? AND status = 'confirmed'
    `).get(personId, accountId);
    if (!person) {
      return null;
    }
    const rows = database.prepare(`
      SELECT relationship.*
      FROM person_relationships relationship
      INNER JOIN person_entities person_a
        ON person_a.id = relationship.person_a_id
        AND person_a.account_id = relationship.account_id
      INNER JOIN person_entities person_b
        ON person_b.id = relationship.person_b_id
        AND person_b.account_id = relationship.account_id
      WHERE relationship.account_id = ?
        AND (relationship.person_a_id = ? OR relationship.person_b_id = ?)
        AND relationship.status = 'confirmed'
        AND relationship.explicitly_confirmed = 1
        AND relationship.confirmed_at IS NOT NULL
        AND person_a.status = 'confirmed'
        AND person_b.status = 'confirmed'
        AND EXISTS (
          SELECT 1 FROM person_relationship_evidence relationship_evidence
          INNER JOIN person_evidence evidence
            ON evidence.id = relationship_evidence.evidence_id
            AND evidence.account_id = relationship_evidence.account_id
          WHERE relationship_evidence.account_id = relationship.account_id
            AND relationship_evidence.relationship_id = relationship.id
        )
      ORDER BY relationship.updated_at DESC, relationship.id
    `).all(accountId, personId, personId) as PersonRelationshipRow[];
    return rows.map(relationshipFromRow);
  }

  return {
    createCandidate,
    confirmRelationship,
    markConflict,
    getForReview,
    listConfirmedForPerson
  };
}

export type PersonRelationshipRepository = ReturnType<typeof createPersonRelationshipRepository>;
