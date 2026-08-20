import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { ValidatedPersonTranscriptEvidence } from "./evidence";
import { createPersonRelationshipRepository } from "./relationship-repository";
import {
  createPersonRepository,
  persistValidatedPersonEvidence,
  PersonRepositoryError
} from "./repository";
import {
  PersonRelationshipTypeSchema,
  PersonSelfBindingSchema,
  PersonSubjectAdmissionDispositionSchema,
  PersonSubjectAdmissionSchema,
  type PersonRelationship,
  type PersonSelfBinding,
  type PersonSubjectAdmission,
  type PersonSubjectAdmissionDisposition
} from "./types";

const RECORD_ID_PATTERN = /^[^\s]+$/u;
const UNNAMED_PERSON_STORAGE_NAME = "Unnamed person";

export type PersonAdmissionErrorCode =
  | "not_found"
  | "version_conflict"
  | "conflict"
  | "invalid_request"
  | "invalid_state"
  | "insufficient_evidence";

export class PersonAdmissionError extends Error {
  constructor(
    readonly code: PersonAdmissionErrorCode,
    message: string,
    readonly currentVersion?: number
  ) {
    super(message);
    this.name = "PersonAdmissionError";
  }
}

type EntityAdmissionRow = {
  account_id: string;
  person_id: string;
  version: number;
  is_unnamed: number;
  explicitly_confirmed: number;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
};

type SubjectAdmissionRow = {
  id: string;
  account_id: string;
  evidence_id: string;
  person_id: string | null;
  subject_key: string;
  observation_id: string;
  disposition: string;
  version: number;
  created_at: string;
  updated_at: string;
};

type SelfBindingRow = {
  account_id: string;
  person_id: string | null;
  status: string;
  version: number;
  set_at: string | null;
  cleared_at: string | null;
  created_at: string;
  updated_at: string;
};

type RelationshipAdmissionRow = {
  account_id: string;
  relationship_id: string;
  version: number;
  created_at: string;
  updated_at: string;
};

function identifier(value: string, label: string) {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > 512 || !RECORD_ID_PATTERN.test(normalized)) {
    throw new PersonAdmissionError("invalid_request", `Invalid ${label}`);
  }
  return normalized;
}

function optionalDisplayName(value: string | null | undefined) {
  if (value === null || value === undefined) return null;
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > 500) {
    throw new PersonAdmissionError("invalid_request", "Invalid Person display name");
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

function expectedVersion(value: number, current: number) {
  if (!Number.isInteger(value) || value < 0) {
    throw new PersonAdmissionError("invalid_request", "Invalid expected version");
  }
  if (value !== current) {
    throw new PersonAdmissionError(
      "version_conflict",
      "Resource version conflict",
      current
    );
  }
}

function subjectAdmissionFromRow(row: SubjectAdmissionRow): PersonSubjectAdmission {
  return PersonSubjectAdmissionSchema.parse({
    id: row.id,
    accountId: row.account_id,
    evidenceId: row.evidence_id,
    personId: row.person_id,
    subjectKey: row.subject_key,
    observationId: row.observation_id,
    disposition: row.disposition,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function selfBindingFromRow(row: SelfBindingRow): PersonSelfBinding {
  return PersonSelfBindingSchema.parse({
    accountId: row.account_id,
    personId: row.person_id,
    status: row.status,
    version: row.version,
    setAt: row.set_at,
    clearedAt: row.cleared_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

export function createPersonAdmissionRepository(database: Database.Database) {
  const personRepository = createPersonRepository(database);
  const relationshipRepository = createPersonRelationshipRepository(database);

  function insertAudit(input: {
    accountId: string;
    entityType: "person" | "self_binding" | "subject" | "relationship";
    entityId: string;
    action: string;
    fromState: string | null;
    toState: string;
    previousValue?: string | null;
    newValue?: string | null;
    evidenceId?: string | null;
    resultingVersion: number;
    now: string;
  }) {
    const id = stableId(
      "person_admission_audit",
      input.accountId,
      input.entityType,
      input.entityId,
      input.action,
      String(input.resultingVersion)
    );
    database.prepare(`
      INSERT INTO person_admission_audits (
        id, account_id, entity_type, entity_id, action, from_state, to_state,
        previous_value, new_value, evidence_id, resulting_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(
      id,
      input.accountId,
      input.entityType,
      input.entityId,
      input.action,
      input.fromState,
      input.toState,
      input.previousValue ?? null,
      input.newValue ?? null,
      input.evidenceId ?? null,
      input.resultingVersion,
      input.now
    );
  }

  function entityAdmission(accountId: string, personId: string) {
    return database.prepare(`
      SELECT * FROM person_entity_admissions
      WHERE account_id = ? AND person_id = ?
    `).get(accountId, personId) as EntityAdmissionRow | undefined;
  }

  function requirePersonRow(accountId: string, personId: string) {
    const row = database.prepare(`
      SELECT id, display_name, status, source, created_at, updated_at
      FROM person_entities WHERE id = ? AND account_id = ?
    `).get(personId, accountId) as {
      id: string;
      display_name: string;
      status: "candidate" | "confirmed" | "archived";
      source: string;
      created_at: string;
      updated_at: string;
    } | undefined;
    if (!row) {
      throw new PersonAdmissionError("not_found", "Person was not found");
    }
    return row;
  }

  function requireConfirmedPerson(accountId: string, personId: string) {
    const row = requirePersonRow(accountId, personId);
    if (row.status !== "confirmed") {
      throw new PersonAdmissionError("not_found", "Confirmed Person was not found");
    }
    return row;
  }

  function upsertEntityAdmission(input: {
    accountId: string;
    personId: string;
    version: number;
    isUnnamed: boolean;
    explicitlyConfirmed: boolean;
    confirmedAt: string | null;
    createdAt: string;
    updatedAt: string;
  }) {
    database.prepare(`
      INSERT INTO person_entity_admissions (
        account_id, person_id, version, is_unnamed, explicitly_confirmed,
        confirmed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, person_id) DO UPDATE SET
        version = excluded.version,
        is_unnamed = excluded.is_unnamed,
        explicitly_confirmed = excluded.explicitly_confirmed,
        confirmed_at = excluded.confirmed_at,
        updated_at = excluded.updated_at
    `).run(
      input.accountId,
      input.personId,
      input.version,
      input.isUnnamed ? 1 : 0,
      input.explicitlyConfirmed ? 1 : 0,
      input.confirmedAt,
      input.createdAt,
      input.updatedAt
    );
  }

  function createPersonCandidate(input: {
    accountId: string;
    idempotencyKey: string;
    displayName?: string | null;
    now?: string;
  }) {
    const accountId = identifier(input.accountId, "account id");
    const idempotencyKey = identifier(input.idempotencyKey, "idempotency key");
    const displayName = optionalDisplayName(input.displayName);
    const now = input.now ?? new Date().toISOString();
    const personId = stableId("person_explicit", accountId, idempotencyKey);
    return database.transaction(() => {
      const existing = database.prepare(`
        SELECT display_name FROM person_entities WHERE id = ? AND account_id = ?
      `).get(personId, accountId) as { display_name: string } | undefined;
      if (existing) {
        const admission = entityAdmission(accountId, personId);
        const persistedName = admission?.is_unnamed === 1 ? null : existing.display_name;
        if (persistedName !== displayName) {
          throw new PersonAdmissionError(
            "conflict",
            "Person idempotency key already exists with different inputs"
          );
        }
        return personRepository.getPersonForReview(accountId, personId)!;
      }
      database.prepare(`
        INSERT INTO person_entities (
          id, account_id, display_name, source, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'manual_confirmation', 'candidate', ?, ?)
      `).run(
        personId,
        accountId,
        displayName ?? UNNAMED_PERSON_STORAGE_NAME,
        now,
        now
      );
      upsertEntityAdmission({
        accountId,
        personId,
        version: 1,
        isUnnamed: displayName === null,
        explicitlyConfirmed: false,
        confirmedAt: null,
        createdAt: now,
        updatedAt: now
      });
      insertAudit({
        accountId,
        entityType: "person",
        entityId: personId,
        action: "person_created",
        fromState: null,
        toState: "candidate",
        resultingVersion: 1,
        now
      });
      return personRepository.getPersonForReview(accountId, personId)!;
    })();
  }

  function confirmPerson(input: {
    accountId: string;
    personId: string;
    expectedVersion: number;
    now?: string;
  }) {
    const accountId = identifier(input.accountId, "account id");
    const personId = identifier(input.personId, "Person id");
    const now = input.now ?? new Date().toISOString();
    return database.transaction(() => {
      const person = requirePersonRow(accountId, personId);
      const admission = entityAdmission(accountId, personId);
      const currentVersion = admission?.version ?? 1;
      if (person.status === "confirmed" && admission?.explicitly_confirmed === 1) {
        return personRepository.getPersonForReview(accountId, personId)!;
      }
      if (person.status === "archived") {
        throw new PersonAdmissionError("invalid_state", "Archived Person cannot be confirmed");
      }
      expectedVersion(input.expectedVersion, currentVersion);
      const nextVersion = currentVersion + 1;
      database.prepare(`
        UPDATE person_entities
        SET status = 'confirmed', source = 'manual_confirmation', updated_at = ?
        WHERE id = ? AND account_id = ? AND status <> 'archived'
      `).run(now, personId, accountId);
      upsertEntityAdmission({
        accountId,
        personId,
        version: nextVersion,
        isUnnamed: admission?.is_unnamed === 1,
        explicitlyConfirmed: true,
        confirmedAt: now,
        createdAt: admission?.created_at ?? person.created_at,
        updatedAt: now
      });
      insertAudit({
        accountId,
        entityType: "person",
        entityId: personId,
        action: "person_confirmed",
        fromState: person.status,
        toState: "confirmed",
        resultingVersion: nextVersion,
        now
      });
      return personRepository.getPersonForReview(accountId, personId)!;
    })();
  }

  function renamePerson(input: {
    accountId: string;
    personId: string;
    displayName: string | null;
    expectedVersion: number;
    now?: string;
  }) {
    const accountId = identifier(input.accountId, "account id");
    const personId = identifier(input.personId, "Person id");
    const displayName = optionalDisplayName(input.displayName);
    const now = input.now ?? new Date().toISOString();
    return database.transaction(() => {
      const person = requirePersonRow(accountId, personId);
      if (person.status === "archived") {
        throw new PersonAdmissionError("invalid_state", "Archived Person cannot be renamed");
      }
      const admission = entityAdmission(accountId, personId);
      const currentVersion = admission?.version ?? 1;
      const currentName = admission?.is_unnamed === 1 ? null : person.display_name;
      if (currentName === displayName) {
        return personRepository.getPersonForReview(accountId, personId)!;
      }
      expectedVersion(input.expectedVersion, currentVersion);
      const nextVersion = currentVersion + 1;
      database.prepare(`
        UPDATE person_entities SET display_name = ?, updated_at = ?
        WHERE id = ? AND account_id = ?
      `).run(displayName ?? UNNAMED_PERSON_STORAGE_NAME, now, personId, accountId);
      upsertEntityAdmission({
        accountId,
        personId,
        version: nextVersion,
        isUnnamed: displayName === null,
        explicitlyConfirmed: admission?.explicitly_confirmed === 1,
        confirmedAt: admission?.confirmed_at ?? null,
        createdAt: admission?.created_at ?? person.created_at,
        updatedAt: now
      });
      insertAudit({
        accountId,
        entityType: "person",
        entityId: personId,
        action: "person_renamed",
        fromState: person.status,
        toState: person.status,
        resultingVersion: nextVersion,
        now
      });
      return personRepository.getPersonForReview(accountId, personId)!;
    })();
  }

  function clearSelfBindingForArchivedPerson(accountId: string, personId: string, now: string) {
    const binding = database.prepare(`
      SELECT * FROM person_self_bindings
      WHERE account_id = ? AND person_id = ? AND status = 'active'
    `).get(accountId, personId) as SelfBindingRow | undefined;
    if (!binding) return;
    const nextVersion = binding.version + 1;
    database.prepare(`
      UPDATE person_self_bindings
      SET person_id = NULL, status = 'cleared', version = ?, set_at = NULL,
        cleared_at = ?, updated_at = ?
      WHERE account_id = ? AND version = ?
    `).run(nextVersion, now, now, accountId, binding.version);
    insertAudit({
      accountId,
      entityType: "self_binding",
      entityId: accountId,
      action: "self_cleared",
      fromState: "active",
      toState: "cleared",
      previousValue: personId,
      newValue: null,
      resultingVersion: nextVersion,
      now
    });
  }

  function archivePerson(input: {
    accountId: string;
    personId: string;
    expectedVersion: number;
    now?: string;
  }) {
    const accountId = identifier(input.accountId, "account id");
    const personId = identifier(input.personId, "Person id");
    const now = input.now ?? new Date().toISOString();
    return database.transaction(() => {
      const person = requirePersonRow(accountId, personId);
      const admission = entityAdmission(accountId, personId);
      const currentVersion = admission?.version ?? 1;
      if (person.status === "archived") {
        return personRepository.getPersonForReview(accountId, personId)!;
      }
      expectedVersion(input.expectedVersion, currentVersion);
      const nextVersion = currentVersion + 1;
      database.prepare(`
        UPDATE person_entities SET status = 'archived', updated_at = ?
        WHERE id = ? AND account_id = ?
      `).run(now, personId, accountId);
      upsertEntityAdmission({
        accountId,
        personId,
        version: nextVersion,
        isUnnamed: admission?.is_unnamed === 1,
        explicitlyConfirmed: admission?.explicitly_confirmed === 1,
        confirmedAt: admission?.confirmed_at ?? null,
        createdAt: admission?.created_at ?? person.created_at,
        updatedAt: now
      });
      clearSelfBindingForArchivedPerson(accountId, personId, now);
      insertAudit({
        accountId,
        entityType: "person",
        entityId: personId,
        action: "person_archived",
        fromState: person.status,
        toState: "archived",
        resultingVersion: nextVersion,
        now
      });
      return personRepository.getPersonForReview(accountId, personId)!;
    })();
  }

  function getSelfBinding(accountIdInput: string) {
    const accountId = identifier(accountIdInput, "account id");
    const row = database.prepare(`
      SELECT * FROM person_self_bindings WHERE account_id = ?
    `).get(accountId) as SelfBindingRow | undefined;
    return row ? selfBindingFromRow(row) : null;
  }

  function setSelfBinding(input: {
    accountId: string;
    personId: string | null;
    expectedVersion: number;
    now?: string;
  }) {
    const accountId = identifier(input.accountId, "account id");
    const personId = input.personId === null ? null : identifier(input.personId, "Person id");
    const now = input.now ?? new Date().toISOString();
    return database.transaction(() => {
      if (personId) requireConfirmedPerson(accountId, personId);
      const current = database.prepare(`
        SELECT * FROM person_self_bindings WHERE account_id = ?
      `).get(accountId) as SelfBindingRow | undefined;
      if (
        current &&
        ((personId && current.status === "active" && current.person_id === personId) ||
          (!personId && current.status === "cleared"))
      ) {
        return selfBindingFromRow(current);
      }
      const currentVersion = current?.version ?? 0;
      expectedVersion(input.expectedVersion, currentVersion);
      const nextVersion = currentVersion + 1;
      const status = personId ? "active" : "cleared";
      database.prepare(`
        INSERT INTO person_self_bindings (
          account_id, person_id, status, version, set_at, cleared_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          person_id = excluded.person_id,
          status = excluded.status,
          version = excluded.version,
          set_at = excluded.set_at,
          cleared_at = excluded.cleared_at,
          updated_at = excluded.updated_at
      `).run(
        accountId,
        personId,
        status,
        nextVersion,
        personId ? now : null,
        personId ? null : now,
        current?.created_at ?? now,
        now
      );
      const action = personId
        ? current?.status === "active" ? "self_replaced" : "self_set"
        : "self_cleared";
      insertAudit({
        accountId,
        entityType: "self_binding",
        entityId: accountId,
        action,
        fromState: current?.status ?? null,
        toState: status,
        previousValue: current?.person_id ?? null,
        newValue: personId,
        resultingVersion: nextVersion,
        now
      });
      return getSelfBinding(accountId)!;
    })();
  }

  function subjectAdmission(accountId: string, evidenceId: string, subjectKey: string) {
    return database.prepare(`
      SELECT * FROM person_subject_admissions
      WHERE account_id = ? AND evidence_id = ? AND subject_key = ?
    `).get(accountId, evidenceId, subjectKey) as SubjectAdmissionRow | undefined;
  }

  function recordSubjectAdmission(input: {
    accountId: string;
    personId: string | null;
    disposition: PersonSubjectAdmissionDisposition;
    expectedVersion: number;
    evidence: ValidatedPersonTranscriptEvidence;
    now?: string;
  }) {
    const accountId = identifier(input.accountId, "account id");
    const disposition = PersonSubjectAdmissionDispositionSchema.parse(input.disposition);
    const personId = input.personId === null ? null : identifier(input.personId, "Person id");
    if ((disposition === "unknown") !== (personId === null)) {
      throw new PersonAdmissionError(
        "invalid_request",
        "Unknown Subject must omit personId; other dispositions require personId"
      );
    }
    const now = input.now ?? new Date().toISOString();
    return database.transaction(() => {
      if (personId) requireConfirmedPerson(accountId, personId);
      let evidence;
      try {
        evidence = persistValidatedPersonEvidence(database, {
          accountId,
          evidence: input.evidence,
          now
        });
      } catch (error) {
        if (error instanceof PersonRepositoryError) {
          throw new PersonAdmissionError("conflict", error.message);
        }
        throw error;
      }
      const subjectKey = personId ?? "unknown";
      const existingAdmission = subjectAdmission(accountId, evidence.id, subjectKey);
      if (existingAdmission?.disposition === disposition) {
        return subjectAdmissionFromRow(existingAdmission);
      }
      expectedVersion(input.expectedVersion, existingAdmission?.version ?? 0);
      if (disposition === "unknown") {
        const confirmed = database.prepare(`
          SELECT 1 FROM person_subject_observations
          WHERE account_id = ? AND evidence_id = ? AND status = 'confirmed'
          LIMIT 1
        `).get(accountId, evidence.id);
        if (confirmed) {
          throw new PersonAdmissionError(
            "conflict",
            "Confirmed Subjects must be explicitly rejected before marking Evidence unknown"
          );
        }
        database.prepare(`
          DELETE FROM person_subject_observations
          WHERE account_id = ? AND evidence_id = ? AND status <> 'confirmed'
            AND person_id IS NOT NULL
        `).run(accountId, evidence.id);
      } else {
        database.prepare(`
          DELETE FROM person_subject_observations
          WHERE account_id = ? AND evidence_id = ? AND status = 'unknown'
            AND person_id IS NULL
        `).run(accountId, evidence.id);
      }
      if (disposition === "confirmed") {
        const unconfirmedSharedSources = database.prepare(`
          SELECT observation.id
          FROM person_subject_observations observation
          LEFT JOIN person_subject_admissions admission
            ON admission.account_id = observation.account_id
            AND admission.observation_id = observation.id
            AND admission.disposition = 'confirmed'
          WHERE observation.account_id = ? AND observation.evidence_id = ?
            AND observation.status = 'confirmed' AND observation.person_id <> ?
            AND admission.id IS NULL
          LIMIT 1
        `).get(accountId, evidence.id, personId);
        if (unconfirmedSharedSources) {
          throw new PersonAdmissionError(
            "conflict",
            "Shared Subject requires separate explicit confirmation for every Person"
          );
        }
      }

      let observationId = existingAdmission?.observation_id;
      if (!observationId) {
        const existingObservation = database.prepare(`
          SELECT id FROM person_subject_observations
          WHERE account_id = ? AND evidence_id = ?
            AND ${personId ? "person_id = ?" : "person_id IS NULL"}
          ORDER BY CASE status WHEN 'confirmed' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END,
            updated_at DESC, id
          LIMIT 1
        `).get(...(personId
          ? [accountId, evidence.id, personId]
          : [accountId, evidence.id])) as { id: string } | undefined;
        observationId = existingObservation?.id ?? stableId(
          "person_subject_observation_explicit",
          accountId,
          evidence.id,
          subjectKey
        );
      }
      database.prepare(`
        UPDATE person_subject_observations
        SET status = 'rejected', source = 'manual_review',
          reason = 'superseded_by_explicit_user_admission', confirmed_at = NULL,
          updated_at = ?
        WHERE account_id = ? AND evidence_id = ?
          AND ${personId ? "person_id = ?" : "person_id IS NULL"}
          AND id <> ?
      `).run(...(personId
        ? [now, accountId, evidence.id, personId, observationId]
        : [now, accountId, evidence.id, observationId]));
      const source = disposition === "unknown" ? "unknown" : "manual_review";
      const reason = `explicit_user_${disposition}`;
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
        observationId,
        accountId,
        personId,
        evidence.id,
        disposition,
        source,
        reason,
        disposition === "confirmed" ? now : null,
        now,
        now
      );
      const id = existingAdmission?.id ?? stableId(
        "person_subject_admission",
        accountId,
        evidence.id,
        subjectKey
      );
      const nextVersion = (existingAdmission?.version ?? 0) + 1;
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
        id,
        accountId,
        evidence.id,
        personId,
        subjectKey,
        observationId,
        disposition,
        nextVersion,
        existingAdmission?.created_at ?? now,
        now
      );
      insertAudit({
        accountId,
        entityType: "subject",
        entityId: id,
        action: `subject_${disposition}`,
        fromState: existingAdmission?.disposition ?? null,
        toState: disposition,
        newValue: personId,
        evidenceId: evidence.id,
        resultingVersion: nextVersion,
        now
      });
      return subjectAdmissionFromRow(database.prepare(`
        SELECT * FROM person_subject_admissions WHERE id = ? AND account_id = ?
      `).get(id, accountId) as SubjectAdmissionRow);
    })();
  }

  function relationshipAdmission(accountId: string, relationshipId: string) {
    return database.prepare(`
      SELECT * FROM person_relationship_admissions
      WHERE account_id = ? AND relationship_id = ?
    `).get(accountId, relationshipId) as RelationshipAdmissionRow | undefined;
  }

  function upsertRelationshipAdmission(input: {
    accountId: string;
    relationshipId: string;
    version: number;
    createdAt: string;
    updatedAt: string;
  }) {
    database.prepare(`
      INSERT INTO person_relationship_admissions (
        account_id, relationship_id, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, relationship_id) DO UPDATE SET
        version = excluded.version, updated_at = excluded.updated_at
    `).run(
      input.accountId,
      input.relationshipId,
      input.version,
      input.createdAt,
      input.updatedAt
    );
  }

  function createRelationshipCandidate(input: {
    accountId: string;
    personAId: string;
    personBId: string;
    type: string;
    expectedVersion: number;
    evidence: ValidatedPersonTranscriptEvidence;
    now?: string;
  }) {
    const accountId = identifier(input.accountId, "account id");
    const personAId = identifier(input.personAId, "person A id");
    const personBId = identifier(input.personBId, "person B id");
    const type = PersonRelationshipTypeSchema.parse(input.type);
    const now = input.now ?? new Date().toISOString();
    return database.transaction(() => {
      if (personAId === personBId) {
        throw new PersonAdmissionError(
          "invalid_request",
          "Relationship endpoints must be different Persons"
        );
      }
      requireConfirmedPerson(accountId, personAId);
      requireConfirmedPerson(accountId, personBId);
      const [firstEndpointId, secondEndpointId] = [personAId, personBId].sort();
      const existingRelationship = database.prepare(`
        SELECT id, status FROM person_relationships
        WHERE account_id = ? AND person_a_id = ? AND person_b_id = ? AND type = ?
      `).get(accountId, firstEndpointId, secondEndpointId, type) as {
        id: string;
        status: string;
      } | undefined;
      const existingEvidence = existingRelationship
        ? database.prepare(`
          SELECT 1 FROM person_relationship_evidence
          WHERE account_id = ? AND relationship_id = ? AND evidence_id = ?
        `).get(accountId, existingRelationship.id, input.evidence.id)
        : null;
      const existingAdmission = existingRelationship
        ? relationshipAdmission(accountId, existingRelationship.id)
        : undefined;
      if (!existingRelationship) {
        expectedVersion(input.expectedVersion, 0);
      } else if (existingRelationship.status === "candidate" && !existingEvidence) {
        expectedVersion(input.expectedVersion, existingAdmission?.version ?? 1);
      }
      try {
        const relationship = relationshipRepository.createCandidate({
          accountId,
          personAId,
          personBId,
          type,
          evidence: input.evidence,
          now
        });
        const admission = relationshipAdmission(accountId, relationship.id);
        if (relationship.status === "candidate" && (!admission || !existingEvidence)) {
          const nextVersion = admission
            ? admission.version + 1
            : existingRelationship && !existingEvidence ? 2 : 1;
          upsertRelationshipAdmission({
            accountId,
            relationshipId: relationship.id,
            version: nextVersion,
            createdAt: admission?.created_at ?? now,
            updatedAt: now
          });
          insertAudit({
            accountId,
            entityType: "relationship",
            entityId: relationship.id,
            action: "relationship_candidate",
            fromState: existingRelationship?.status ?? null,
            toState: "candidate",
            evidenceId: input.evidence.id,
            resultingVersion: nextVersion,
            now
          });
        }
        return relationshipRepository.getForReview(accountId, relationship.id)!;
      } catch (error) {
        if (error instanceof PersonRepositoryError) {
          throw new PersonAdmissionError("invalid_state", error.message);
        }
        throw error;
      }
    })();
  }

  function requireRelationship(accountId: string, relationshipId: string) {
    const relationship = relationshipRepository.getForReview(accountId, relationshipId);
    if (!relationship) {
      throw new PersonAdmissionError("not_found", "Relationship was not found");
    }
    return relationship;
  }

  function transitionRelationship(input: {
    accountId: string;
    relationshipId: string;
    action: "confirm" | "conflict" | "archive";
    expectedVersion: number;
    now?: string;
  }) {
    const accountId = identifier(input.accountId, "account id");
    const relationshipId = identifier(input.relationshipId, "Relationship id");
    const now = input.now ?? new Date().toISOString();
    return database.transaction(() => {
      const current = requireRelationship(accountId, relationshipId);
      const desired = input.action === "confirm"
        ? "confirmed"
        : input.action === "conflict" ? "conflict" : "archived";
      if (current.status === desired) return current;
      const admission = relationshipAdmission(accountId, relationshipId);
      const currentVersion = admission?.version ?? current.version;
      expectedVersion(input.expectedVersion, currentVersion);
      let transitioned: PersonRelationship;
      try {
        if (input.action === "confirm") {
          transitioned = relationshipRepository.confirmRelationship({ accountId, relationshipId, now });
        } else if (input.action === "conflict") {
          transitioned = relationshipRepository.markConflict({ accountId, relationshipId, now });
        } else {
          database.prepare(`
            UPDATE person_relationships
            SET status = 'archived', explicitly_confirmed = 0,
              confirmed_at = NULL, updated_at = ?
            WHERE id = ? AND account_id = ?
          `).run(now, relationshipId, accountId);
          transitioned = requireRelationship(accountId, relationshipId);
        }
      } catch (error) {
        if (error instanceof PersonRepositoryError) {
          throw new PersonAdmissionError("invalid_state", error.message);
        }
        throw error;
      }
      const nextVersion = currentVersion + 1;
      upsertRelationshipAdmission({
        accountId,
        relationshipId,
        version: nextVersion,
        createdAt: admission?.created_at ?? current.createdAt,
        updatedAt: now
      });
      insertAudit({
        accountId,
        entityType: "relationship",
        entityId: relationshipId,
        action: `relationship_${desired}`,
        fromState: current.status,
        toState: desired,
        evidenceId: current.evidence[0]?.id ?? null,
        resultingVersion: nextVersion,
        now
      });
      return relationshipRepository.getForReview(accountId, transitioned.id)!;
    })();
  }

  function listAudits(accountIdInput: string) {
    const accountId = identifier(accountIdInput, "account id");
    return database.prepare(`
      SELECT entity_type, entity_id, action, from_state, to_state,
        previous_value, new_value, evidence_id, resulting_version, created_at
      FROM person_admission_audits WHERE account_id = ?
      ORDER BY created_at, id
    `).all(accountId) as Array<{
      entity_type: string;
      entity_id: string;
      action: string;
      from_state: string | null;
      to_state: string;
      previous_value: string | null;
      new_value: string | null;
      evidence_id: string | null;
      resulting_version: number;
      created_at: string;
    }>;
  }

  return {
    createPersonCandidate,
    confirmPerson,
    renamePerson,
    archivePerson,
    getSelfBinding,
    setSelfBinding,
    recordSubjectAdmission,
    createRelationshipCandidate,
    transitionRelationship,
    listAudits
  };
}

export type PersonAdmissionRepository = ReturnType<typeof createPersonAdmissionRepository>;
