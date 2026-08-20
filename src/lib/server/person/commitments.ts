import type Database from "better-sqlite3";
import type { ValidatedPersonTranscriptEvidence } from "./evidence";
import {
  PersonCommitmentSchema,
  PersonCommitmentStatusSchema,
  PersonCommitmentTransitionSchema,
  type PersonCommitment,
  type PersonCommitmentStatus,
  type PersonCommitmentTransition
} from "./types";
import {
  PersonLifecycleError,
  assertLifecycleIdentifier,
  assertStrictlyLater,
  loadLifecycleEvidence,
  normalizeLifecycleText,
  normalizeLifecycleTimestamp,
  persistEvidenceForExactSubjects,
  requireConfirmedLifecycleRelationship,
  stableLifecycleId
} from "./lifecycle-support";

type CommitmentRow = {
  id: string;
  account_id: string;
  relationship_id: string | null;
  promisor_person_id: string;
  promisee_person_id: string;
  text: string;
  status: string;
  observed_at: string;
  occurred_at: string;
  resolved_at: string | null;
  superseded_by: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type CommitmentTransitionRow = {
  id: string;
  account_id: string;
  commitment_id: string;
  from_status: "created" | "active";
  to_status: "active" | "completed" | "cancelled" | "superseded";
  observed_at: string;
  occurred_at: string;
  replacement_commitment_id: string | null;
  evidence_id: string;
  expected_version: number;
  resulting_version: number;
  is_applied: number;
  invalid_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type CommitmentUnknownResult = {
  known: false;
  reason: "insufficient_evidence";
  commitment: null;
};

export type CommitmentKnownResult = {
  known: true;
  reason: null;
  commitment: PersonCommitment;
};

function observationAndOccurrence(observedAtInput: string, occurredAtInput: string) {
  const observedAt = normalizeLifecycleTimestamp(observedAtInput, "Commitment observedAt");
  const occurredAt = normalizeLifecycleTimestamp(occurredAtInput, "Commitment occurredAt");
  if (Date.parse(observedAt) < Date.parse(occurredAt)) {
    throw new PersonLifecycleError(
      "invalid_time_order",
      "Commitment Evidence cannot be observed before the event occurred"
    );
  }
  return { observedAt, occurredAt };
}

function allowedTransition(fromStatus: PersonCommitmentStatus, toStatus: PersonCommitmentStatus) {
  return (
    fromStatus === "created" && ["active", "cancelled", "superseded"].includes(toStatus)
  ) || (
    fromStatus === "active" && ["completed", "cancelled", "superseded"].includes(toStatus)
  );
}

export function createPersonCommitmentRepository(database: Database.Database) {
  function loadEvidence(accountId: string, commitmentId: string) {
    return (database.prepare(`
      SELECT evidence.id
      FROM person_commitment_evidence commitment_evidence
      INNER JOIN person_evidence evidence
        ON evidence.id = commitment_evidence.evidence_id
        AND evidence.account_id = commitment_evidence.account_id
      WHERE commitment_evidence.account_id = ?
        AND commitment_evidence.commitment_id = ?
      ORDER BY evidence.created_at, evidence.id
    `).all(accountId, commitmentId) as Array<{ id: string }>)
      .map((row) => loadLifecycleEvidence(database, accountId, row.id));
  }

  function loadTransitions(accountId: string, commitmentId: string): PersonCommitmentTransition[] {
    const rows = database.prepare(`
      SELECT * FROM person_commitment_transitions
      WHERE account_id = ? AND commitment_id = ?
      ORDER BY occurred_at, observed_at, created_at, id
    `).all(accountId, commitmentId) as CommitmentTransitionRow[];
    return rows.map((row) => PersonCommitmentTransitionSchema.parse({
      id: row.id,
      accountId: row.account_id,
      commitmentId: row.commitment_id,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      observedAt: row.observed_at,
      occurredAt: row.occurred_at,
      replacementCommitmentId: row.replacement_commitment_id,
      evidence: loadLifecycleEvidence(database, row.account_id, row.evidence_id),
      expectedVersion: row.expected_version,
      resultingVersion: row.resulting_version,
      applied: row.is_applied === 1,
      invalidReason: row.invalid_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  function commitmentFromRow(row: CommitmentRow): PersonCommitment {
    return PersonCommitmentSchema.parse({
      id: row.id,
      accountId: row.account_id,
      relationshipId: row.relationship_id,
      promisorPersonId: row.promisor_person_id,
      promiseePersonId: row.promisee_person_id,
      text: row.text,
      status: row.status,
      observedAt: row.observed_at,
      occurredAt: row.occurred_at,
      resolvedAt: row.resolved_at,
      supersededBy: row.superseded_by,
      version: row.version,
      evidence: loadEvidence(row.account_id, row.id),
      transitions: loadTransitions(row.account_id, row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }

  function rawCommitment(accountId: string, commitmentId: string) {
    return database.prepare(`
      SELECT * FROM person_commitments WHERE id = ? AND account_id = ?
    `).get(commitmentId, accountId) as CommitmentRow | undefined;
  }

  function requireCommitment(accountId: string, commitmentId: string) {
    const row = rawCommitment(accountId, commitmentId);
    if (!row || loadEvidence(accountId, commitmentId).length === 0) {
      throw new PersonLifecycleError(
        "insufficient_evidence",
        "Commitment is unavailable or unsupported by Evidence"
      );
    }
    return row;
  }

  function createCommitment(input: {
    accountId: string;
    relationshipId?: string | null;
    promisorPersonId?: string | null;
    promiseePersonId?: string | null;
    text: string;
    observedAt: string;
    occurredAt: string;
    evidence?: ValidatedPersonTranscriptEvidence | null;
    now?: string;
  }): CommitmentUnknownResult | CommitmentKnownResult {
    if (
      !input.promisorPersonId ||
      !input.promiseePersonId ||
      input.promisorPersonId === input.promiseePersonId ||
      !input.evidence
    ) {
      return { known: false, reason: "insufficient_evidence", commitment: null };
    }
    const evidence = input.evidence;
    const accountId = assertLifecycleIdentifier(input.accountId, "account id");
    const promisorPersonId = assertLifecycleIdentifier(input.promisorPersonId, "promisor Person id");
    const promiseePersonId = assertLifecycleIdentifier(input.promiseePersonId, "promisee Person id");
    const relationshipId = input.relationshipId
      ? assertLifecycleIdentifier(input.relationshipId, "relationship id")
      : null;
    const text = normalizeLifecycleText(input.text, "Commitment text");
    const { observedAt, occurredAt } = observationAndOccurrence(input.observedAt, input.occurredAt);
    const now = normalizeLifecycleTimestamp(input.now ?? new Date().toISOString(), "Commitment storage time");
    const id = stableLifecycleId(
      "person_commitment",
      accountId,
      relationshipId ?? "none",
      promisorPersonId,
      promiseePersonId,
      text,
      evidence.id
    );
    return database.transaction(() => {
      persistEvidenceForExactSubjects(database, {
        accountId,
        subjectPersonIds: [promisorPersonId, promiseePersonId],
        evidence,
        now
      });
      requireConfirmedLifecycleRelationship(database, {
        accountId,
        relationshipId,
        endpointPersonIds: [promisorPersonId, promiseePersonId],
        requireExactEndpoints: true
      });
      const existing = rawCommitment(accountId, id);
      if (existing) {
        if (
          existing.relationship_id !== relationshipId ||
          existing.promisor_person_id !== promisorPersonId ||
          existing.promisee_person_id !== promiseePersonId ||
          existing.text !== text ||
          existing.observed_at !== observedAt ||
          existing.occurred_at !== occurredAt
        ) {
          throw new PersonLifecycleError(
            "persisted_state_conflict",
            "Idempotent Commitment creation conflicts with persisted state"
          );
        }
        return { known: true as const, reason: null, commitment: commitmentFromRow(existing) };
      }
      database.prepare(`
        INSERT INTO person_commitments (
          id, account_id, relationship_id, promisor_person_id, promisee_person_id,
          text, status, observed_at, occurred_at, resolved_at, superseded_by,
          version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?, NULL, NULL, 1, ?, ?)
      `).run(
        id,
        accountId,
        relationshipId,
        promisorPersonId,
        promiseePersonId,
        text,
        observedAt,
        occurredAt,
        now,
        now
      );
      database.prepare(`
        INSERT INTO person_commitment_evidence (
          id, account_id, commitment_id, evidence_id, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        stableLifecycleId("person_commitment_evidence", accountId, id, evidence.id),
        accountId,
        id,
        evidence.id,
        now
      );
      return {
        known: true as const,
        reason: null,
        commitment: commitmentFromRow(requireCommitment(accountId, id))
      };
    })();
  }

  function transitionCommitment(input: {
    accountId: string;
    commitmentId: string;
    toStatus: "active" | "completed" | "cancelled";
    observedAt: string;
    occurredAt: string;
    expectedVersion: number;
    evidence?: ValidatedPersonTranscriptEvidence | null;
    now?: string;
  }) {
    return transition({ ...input, replacementCommitmentId: null });
  }

  function transition(input: {
    accountId: string;
    commitmentId: string;
    toStatus: "active" | "completed" | "cancelled" | "superseded";
    replacementCommitmentId: string | null;
    observedAt: string;
    occurredAt: string;
    expectedVersion: number;
    evidence?: ValidatedPersonTranscriptEvidence | null;
    now?: string;
  }) {
    if (!input.evidence) {
      throw new PersonLifecycleError(
        "insufficient_evidence",
        "Commitment transition requires canonical Transcript Evidence"
      );
    }
    const evidence = input.evidence;
    const accountId = assertLifecycleIdentifier(input.accountId, "account id");
    const commitmentId = assertLifecycleIdentifier(input.commitmentId, "Commitment id");
    const replacementCommitmentId = input.replacementCommitmentId
      ? assertLifecycleIdentifier(input.replacementCommitmentId, "replacement Commitment id")
      : null;
    const toStatus = PersonCommitmentStatusSchema.parse(input.toStatus);
    const { observedAt, occurredAt } = observationAndOccurrence(input.observedAt, input.occurredAt);
    const now = normalizeLifecycleTimestamp(input.now ?? new Date().toISOString(), "Commitment transition storage time");
    const id = stableLifecycleId(
      "person_commitment_transition",
      accountId,
      commitmentId,
      toStatus,
      replacementCommitmentId ?? "none",
      evidence.id
    );
    return database.transaction(() => {
      const existing = database.prepare(`
        SELECT * FROM person_commitment_transitions WHERE id = ? AND account_id = ?
      `).get(id, accountId) as CommitmentTransitionRow | undefined;
      if (existing) {
        if (
          existing.commitment_id !== commitmentId ||
          existing.to_status !== toStatus ||
          existing.observed_at !== observedAt ||
          existing.occurred_at !== occurredAt ||
          existing.replacement_commitment_id !== replacementCommitmentId ||
          existing.evidence_id !== evidence.id ||
          existing.expected_version !== input.expectedVersion
        ) {
          throw new PersonLifecycleError(
            "persisted_state_conflict",
            "Commitment transition idempotency key already exists with different inputs"
          );
        }
        return commitmentFromRow(requireCommitment(accountId, commitmentId));
      }
      const commitment = requireCommitment(accountId, commitmentId);
      const fromStatus = PersonCommitmentStatusSchema.parse(commitment.status);
      if (!allowedTransition(fromStatus, toStatus)) {
        throw new PersonLifecycleError(
          "invalid_transition",
          `Commitment cannot transition from ${fromStatus} to ${toStatus}`
        );
      }
      if (!Number.isInteger(input.expectedVersion) || input.expectedVersion !== commitment.version) {
        throw new PersonLifecycleError("version_conflict", "Commitment version conflict");
      }
      persistEvidenceForExactSubjects(database, {
        accountId,
        subjectPersonIds: [commitment.promisor_person_id, commitment.promisee_person_id],
        evidence,
        now
      });
      requireConfirmedLifecycleRelationship(database, {
        accountId,
        relationshipId: commitment.relationship_id,
        endpointPersonIds: [commitment.promisor_person_id, commitment.promisee_person_id],
        requireExactEndpoints: true
      });
      const lastApplied = database.prepare(`
        SELECT observed_at, occurred_at
        FROM person_commitment_transitions
        WHERE account_id = ? AND commitment_id = ? AND is_applied = 1
        ORDER BY occurred_at DESC, observed_at DESC, id DESC LIMIT 1
      `).get(accountId, commitmentId) as { observed_at: string; occurred_at: string } | undefined;
      assertStrictlyLater(
        observedAt,
        lastApplied?.observed_at ?? commitment.observed_at,
        "Commitment transition Evidence observation is stale"
      );
      assertStrictlyLater(
        occurredAt,
        lastApplied?.occurred_at ?? commitment.occurred_at,
        "Commitment transition occurrence is stale or unordered"
      );
      if (toStatus === "superseded") {
        if (!replacementCommitmentId) {
          throw new PersonLifecycleError(
            "incompatible_replacement",
            "Commitment supersession requires a replacement Commitment"
          );
        }
        const replacement = requireCommitment(accountId, replacementCommitmentId);
        if (
          replacement.id === commitment.id ||
          replacement.status !== "active" ||
          replacement.relationship_id !== commitment.relationship_id ||
          replacement.promisor_person_id !== commitment.promisor_person_id ||
          replacement.promisee_person_id !== commitment.promisee_person_id ||
          Date.parse(replacement.occurred_at) <= Date.parse(commitment.occurred_at) ||
          Date.parse(replacement.occurred_at) > Date.parse(occurredAt) ||
          Date.parse(replacement.observed_at) >= Date.parse(observedAt)
        ) {
          throw new PersonLifecycleError(
            "incompatible_replacement",
            "Replacement Commitment must be active, later, and preserve explicit roles"
          );
        }
      } else if (replacementCommitmentId) {
        throw new PersonLifecycleError("invalid_transition", "Only supersession accepts a replacement");
      }
      const resultingVersion = commitment.version + 1;
      database.prepare(`
        INSERT INTO person_commitment_transitions (
          id, account_id, commitment_id, from_status, to_status,
          observed_at, occurred_at, replacement_commitment_id, evidence_id,
          expected_version, resulting_version, is_applied, invalid_reason,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)
      `).run(
        id,
        accountId,
        commitmentId,
        fromStatus,
        toStatus,
        observedAt,
        occurredAt,
        replacementCommitmentId,
        evidence.id,
        commitment.version,
        resultingVersion,
        now,
        now
      );
      const resolvedAt = toStatus === "active" ? null : occurredAt;
      database.prepare(`
        UPDATE person_commitments
        SET status = ?, resolved_at = ?, superseded_by = ?,
          version = ?, updated_at = ?
        WHERE id = ? AND account_id = ? AND version = ? AND status = ?
      `).run(
        toStatus,
        resolvedAt,
        replacementCommitmentId,
        resultingVersion,
        now,
        commitmentId,
        accountId,
        commitment.version,
        fromStatus
      );
      return commitmentFromRow(requireCommitment(accountId, commitmentId));
    })();
  }

  function supersedeCommitment(
    input: Omit<Parameters<typeof transition>[0], "toStatus"> & {
      replacementCommitmentId: string;
    }
  ) {
    return transition({ ...input, toStatus: "superseded" });
  }

  function getCommitment(accountIdInput: string, commitmentIdInput: string) {
    const accountId = assertLifecycleIdentifier(accountIdInput, "account id");
    const commitmentId = assertLifecycleIdentifier(commitmentIdInput, "Commitment id");
    const row = rawCommitment(accountId, commitmentId);
    return row && loadEvidence(accountId, commitmentId).length > 0
      ? commitmentFromRow(row)
      : null;
  }

  function listCommitmentsForPerson(accountIdInput: string, personIdInput: string) {
    const accountId = assertLifecycleIdentifier(accountIdInput, "account id");
    const personId = assertLifecycleIdentifier(personIdInput, "Person id");
    const rows = database.prepare(`
      SELECT commitment.*
      FROM person_commitments commitment
      INNER JOIN person_entities promisor
        ON promisor.id = commitment.promisor_person_id
        AND promisor.account_id = commitment.account_id
      INNER JOIN person_entities promisee
        ON promisee.id = commitment.promisee_person_id
        AND promisee.account_id = commitment.account_id
      WHERE commitment.account_id = ?
        AND (commitment.promisor_person_id = ? OR commitment.promisee_person_id = ?)
        AND promisor.status = 'confirmed' AND promisee.status = 'confirmed'
        AND EXISTS (
          SELECT 1 FROM person_commitment_evidence commitment_evidence
          INNER JOIN person_evidence evidence
            ON evidence.id = commitment_evidence.evidence_id
            AND evidence.account_id = commitment_evidence.account_id
          WHERE commitment_evidence.account_id = commitment.account_id
            AND commitment_evidence.commitment_id = commitment.id
        )
        AND EXISTS (
          SELECT 1 FROM person_commitment_evidence commitment_evidence
          INNER JOIN person_subject_observations subject
            ON subject.evidence_id = commitment_evidence.evidence_id
            AND subject.account_id = commitment_evidence.account_id
          WHERE commitment_evidence.account_id = commitment.account_id
            AND commitment_evidence.commitment_id = commitment.id
            AND subject.status = 'confirmed'
            AND subject.person_id = commitment.promisor_person_id
        )
        AND EXISTS (
          SELECT 1 FROM person_commitment_evidence commitment_evidence
          INNER JOIN person_subject_observations subject
            ON subject.evidence_id = commitment_evidence.evidence_id
            AND subject.account_id = commitment_evidence.account_id
          WHERE commitment_evidence.account_id = commitment.account_id
            AND commitment_evidence.commitment_id = commitment.id
            AND subject.status = 'confirmed'
            AND subject.person_id = commitment.promisee_person_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM person_commitment_evidence commitment_evidence
          INNER JOIN person_subject_observations subject
            ON subject.evidence_id = commitment_evidence.evidence_id
            AND subject.account_id = commitment_evidence.account_id
          WHERE commitment_evidence.account_id = commitment.account_id
            AND commitment_evidence.commitment_id = commitment.id
            AND subject.status = 'confirmed'
            AND subject.person_id NOT IN (
              commitment.promisor_person_id, commitment.promisee_person_id
            )
        )
        AND (
          commitment.relationship_id IS NULL OR EXISTS (
            SELECT 1 FROM person_relationships relationship
            WHERE relationship.id = commitment.relationship_id
              AND relationship.account_id = commitment.account_id
              AND relationship.status = 'confirmed'
              AND relationship.explicitly_confirmed = 1
              AND EXISTS (
                SELECT 1 FROM person_relationship_evidence relationship_evidence
                WHERE relationship_evidence.account_id = relationship.account_id
                  AND relationship_evidence.relationship_id = relationship.id
              )
          )
        )
      ORDER BY commitment.occurred_at DESC, commitment.id
    `).all(accountId, personId, personId) as CommitmentRow[];
    return rows.map(commitmentFromRow);
  }

  return {
    createCommitment,
    transitionCommitment,
    supersedeCommitment,
    getCommitment,
    listCommitmentsForPerson
  };
}

export type PersonCommitmentRepository = ReturnType<typeof createPersonCommitmentRepository>;
