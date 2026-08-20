import type Database from "better-sqlite3";
import {
  PersonFactKeySchema,
  PersonFactKindSchema,
  PersonFactSchema,
  PersonFactTransitionSchema,
  type PersonFact,
  type PersonFactTransition
} from "./types";
import type { ValidatedPersonTranscriptEvidence } from "./evidence";
import {
  PersonLifecycleError,
  assertLifecycleIdentifier,
  assertStrictlyLater,
  loadLifecycleEvidence,
  normalizeLifecycleText,
  normalizeLifecycleTimestamp,
  normalizeOptionalLifecycleTimestamp,
  persistEvidenceForExactSubjects,
  requireConfirmedLifecycleRelationship,
  stableLifecycleId
} from "./lifecycle-support";

type FactRow = {
  id: string;
  account_id: string;
  subject_person_id: string;
  relationship_id: string | null;
  kind: string;
  fact_key: string;
  derived_text: string;
  observed_at: string;
  valid_from: string | null;
  valid_to: string | null;
  status: string;
  superseded_by: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type FactTransitionRow = {
  id: string;
  account_id: string;
  fact_id: string;
  from_status: "active";
  to_status: "resolved" | "superseded";
  observed_at: string;
  occurred_at: string;
  valid_to: string | null;
  replacement_fact_id: string | null;
  evidence_id: string;
  expected_version: number;
  resulting_version: number;
  is_applied: number;
  invalid_reason: string | null;
  created_at: string;
  updated_at: string;
};

function normalizeObservationAndOccurrence(observedAtInput: string, occurredAtInput: string) {
  const observedAt = normalizeLifecycleTimestamp(observedAtInput, "Fact transition observedAt");
  const occurredAt = normalizeLifecycleTimestamp(occurredAtInput, "Fact transition occurredAt");
  if (Date.parse(observedAt) < Date.parse(occurredAt)) {
    throw new PersonLifecycleError(
      "invalid_time_order",
      "Fact transition cannot be observed before it occurred"
    );
  }
  return { observedAt, occurredAt };
}

export function createTemporalFactRepository(database: Database.Database) {
  function loadTransitions(accountId: string, factId: string): PersonFactTransition[] {
    const rows = database.prepare(`
      SELECT * FROM person_fact_transitions
      WHERE account_id = ? AND fact_id = ?
      ORDER BY occurred_at, observed_at, created_at, id
    `).all(accountId, factId) as FactTransitionRow[];
    return rows.map((row) => PersonFactTransitionSchema.parse({
      id: row.id,
      accountId: row.account_id,
      factId: row.fact_id,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      observedAt: row.observed_at,
      occurredAt: row.occurred_at,
      validTo: row.valid_to,
      replacementFactId: row.replacement_fact_id,
      evidence: loadLifecycleEvidence(database, row.account_id, row.evidence_id),
      expectedVersion: row.expected_version,
      resultingVersion: row.resulting_version,
      applied: row.is_applied === 1,
      invalidReason: row.invalid_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  function loadEvidence(accountId: string, factId: string) {
    return (database.prepare(`
      SELECT evidence.id
      FROM person_fact_evidence fact_evidence
      INNER JOIN person_evidence evidence
        ON evidence.id = fact_evidence.evidence_id
        AND evidence.account_id = fact_evidence.account_id
      WHERE fact_evidence.account_id = ? AND fact_evidence.fact_id = ?
      ORDER BY evidence.created_at, evidence.id
    `).all(accountId, factId) as Array<{ id: string }>)
      .map((row) => loadLifecycleEvidence(database, accountId, row.id));
  }

  function factFromRow(row: FactRow): PersonFact {
    return PersonFactSchema.parse({
      id: row.id,
      accountId: row.account_id,
      subjectPersonId: row.subject_person_id,
      relationshipId: row.relationship_id,
      kind: row.kind,
      factKey: row.fact_key,
      derivedText: row.derived_text,
      observedAt: row.observed_at,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      status: row.status,
      supersededBy: row.superseded_by,
      version: row.version,
      evidence: loadEvidence(row.account_id, row.id),
      transitions: loadTransitions(row.account_id, row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }

  function rawFact(accountId: string, factId: string) {
    return database.prepare(`
      SELECT * FROM person_facts WHERE id = ? AND account_id = ?
    `).get(factId, accountId) as FactRow | undefined;
  }

  function requireFact(accountId: string, factId: string) {
    const row = rawFact(accountId, factId);
    if (!row || loadEvidence(accountId, factId).length === 0) {
      throw new PersonLifecycleError("insufficient_evidence", "Person Fact is unavailable or unsupported");
    }
    return row;
  }

  function createFact(input: {
    accountId: string;
    subjectPersonId: string;
    relationshipId?: string | null;
    kind: string;
    factKey: string;
    derivedText: string;
    observedAt: string;
    validFrom?: string | null;
    evidence?: ValidatedPersonTranscriptEvidence | null;
    now?: string;
  }) {
    if (!input.evidence) {
      throw new PersonLifecycleError("insufficient_evidence", "Person Fact requires canonical Transcript Evidence");
    }
    const evidence = input.evidence;
    const accountId = assertLifecycleIdentifier(input.accountId, "account id");
    const subjectPersonId = assertLifecycleIdentifier(input.subjectPersonId, "subject Person id");
    const relationshipId = input.relationshipId
      ? assertLifecycleIdentifier(input.relationshipId, "relationship id")
      : null;
    const kind = PersonFactKindSchema.parse(input.kind);
    const factKey = PersonFactKeySchema.parse(input.factKey);
    const derivedText = normalizeLifecycleText(input.derivedText, "Fact derived text");
    const observedAt = normalizeLifecycleTimestamp(input.observedAt, "Fact observedAt");
    const validFrom = normalizeOptionalLifecycleTimestamp(input.validFrom, "Fact validFrom");
    const now = normalizeLifecycleTimestamp(input.now ?? new Date().toISOString(), "Fact storage time");
    const id = stableLifecycleId(
      "person_fact",
      accountId,
      subjectPersonId,
      relationshipId ?? "none",
      kind,
      factKey,
      evidence.id
    );
    return database.transaction(() => {
      persistEvidenceForExactSubjects(database, {
        accountId,
        subjectPersonIds: [subjectPersonId],
        evidence,
        now
      });
      requireConfirmedLifecycleRelationship(database, {
        accountId,
        relationshipId,
        endpointPersonIds: [subjectPersonId]
      });
      const existing = rawFact(accountId, id);
      if (existing) {
        if (
          existing.subject_person_id !== subjectPersonId ||
          existing.relationship_id !== relationshipId ||
          existing.kind !== kind ||
          existing.fact_key !== factKey ||
          existing.derived_text !== derivedText ||
          existing.observed_at !== observedAt ||
          existing.valid_from !== validFrom
        ) {
          throw new PersonLifecycleError(
            "persisted_state_conflict",
            "Idempotent Fact creation conflicts with persisted state"
          );
        }
        return factFromRow(existing);
      }
      database.prepare(`
        INSERT INTO person_facts (
          id, account_id, subject_person_id, relationship_id, kind, fact_key,
          derived_text, observed_at, valid_from, valid_to, status,
          superseded_by, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', NULL, 1, ?, ?)
      `).run(
        id,
        accountId,
        subjectPersonId,
        relationshipId,
        kind,
        factKey,
        derivedText,
        observedAt,
        validFrom,
        now,
        now
      );
      database.prepare(`
        INSERT INTO person_fact_evidence (
          id, account_id, fact_id, evidence_id, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        stableLifecycleId("person_fact_evidence", accountId, id, evidence.id),
        accountId,
        id,
        evidence.id,
        now
      );
      return factFromRow(requireFact(accountId, id));
    })();
  }

  function transitionFact(input: {
    accountId: string;
    factId: string;
    toStatus: "resolved" | "superseded";
    replacementFactId?: string | null;
    observedAt: string;
    occurredAt: string;
    validTo?: string | null;
    expectedVersion: number;
    evidence?: ValidatedPersonTranscriptEvidence | null;
    now?: string;
  }) {
    if (!input.evidence) {
      throw new PersonLifecycleError(
        "insufficient_evidence",
        "Fact transition requires canonical Transcript Evidence"
      );
    }
    const evidence = input.evidence;
    const accountId = assertLifecycleIdentifier(input.accountId, "account id");
    const factId = assertLifecycleIdentifier(input.factId, "Fact id");
    const replacementFactId = input.replacementFactId
      ? assertLifecycleIdentifier(input.replacementFactId, "replacement Fact id")
      : null;
    const { observedAt, occurredAt } = normalizeObservationAndOccurrence(
      input.observedAt,
      input.occurredAt
    );
    const validTo = normalizeOptionalLifecycleTimestamp(input.validTo, "Fact validTo");
    const now = normalizeLifecycleTimestamp(input.now ?? new Date().toISOString(), "Fact transition storage time");
    const id = stableLifecycleId(
      "person_fact_transition",
      accountId,
      factId,
      input.toStatus,
      replacementFactId ?? "none",
      evidence.id
    );
    return database.transaction(() => {
      const existing = database.prepare(`
        SELECT * FROM person_fact_transitions WHERE id = ? AND account_id = ?
      `).get(id, accountId) as FactTransitionRow | undefined;
      if (existing) {
        if (
          existing.fact_id !== factId ||
          existing.to_status !== input.toStatus ||
          existing.observed_at !== observedAt ||
          existing.occurred_at !== occurredAt ||
          existing.valid_to !== validTo ||
          existing.replacement_fact_id !== replacementFactId ||
          existing.evidence_id !== evidence.id ||
          existing.expected_version !== input.expectedVersion
        ) {
          throw new PersonLifecycleError(
            "persisted_state_conflict",
            "Fact transition idempotency key already exists with different inputs"
          );
        }
        return factFromRow(requireFact(accountId, factId));
      }
      const fact = requireFact(accountId, factId);
      if (fact.status !== "active") {
        throw new PersonLifecycleError("invalid_transition", "Only an active Fact can transition");
      }
      if (!Number.isInteger(input.expectedVersion) || input.expectedVersion !== fact.version) {
        throw new PersonLifecycleError("version_conflict", "Fact version conflict");
      }
      persistEvidenceForExactSubjects(database, {
        accountId,
        subjectPersonIds: [fact.subject_person_id],
        evidence,
        now
      });
      requireConfirmedLifecycleRelationship(database, {
        accountId,
        relationshipId: fact.relationship_id,
        endpointPersonIds: [fact.subject_person_id]
      });
      assertStrictlyLater(
        observedAt,
        fact.observed_at,
        "Fact transition Evidence must be observed after the base Fact Evidence"
      );
      assertStrictlyLater(
        occurredAt,
        fact.valid_from ?? fact.observed_at,
        "Fact transition occurrence order is not strictly later"
      );
      const lastApplied = database.prepare(`
        SELECT observed_at, occurred_at
        FROM person_fact_transitions
        WHERE account_id = ? AND fact_id = ? AND is_applied = 1
        ORDER BY occurred_at DESC, observed_at DESC, id DESC LIMIT 1
      `).get(accountId, factId) as { observed_at: string; occurred_at: string } | undefined;
      if (lastApplied) {
        assertStrictlyLater(observedAt, lastApplied.observed_at, "Fact observation order is stale");
        assertStrictlyLater(occurredAt, lastApplied.occurred_at, "Fact transition order is stale");
      }
      if (
        validTo &&
        (
          (fact.valid_from && Date.parse(validTo) < Date.parse(fact.valid_from)) ||
          Date.parse(validTo) > Date.parse(occurredAt)
        )
      ) {
        throw new PersonLifecycleError("invalid_time_order", "Fact validTo is outside the supported interval");
      }
      if (input.toStatus === "resolved" && replacementFactId) {
        throw new PersonLifecycleError("invalid_transition", "Resolved Fact cannot name a replacement");
      }
      if (input.toStatus === "superseded") {
        if (!replacementFactId) {
          throw new PersonLifecycleError("incompatible_replacement", "Supersession requires a replacement Fact");
        }
        const replacement = requireFact(accountId, replacementFactId);
        if (
          replacement.id === fact.id ||
          replacement.status !== "active" ||
          replacement.subject_person_id !== fact.subject_person_id ||
          replacement.relationship_id !== fact.relationship_id ||
          replacement.kind !== fact.kind ||
          replacement.fact_key !== fact.fact_key
        ) {
          throw new PersonLifecycleError(
            "incompatible_replacement",
            "Replacement Fact must be an active compatible Fact for the same confirmed Subject and factKey"
          );
        }
        if (
          !fact.valid_from ||
          !replacement.valid_from ||
          Date.parse(replacement.valid_from) <= Date.parse(fact.valid_from) ||
          Date.parse(replacement.valid_from) > Date.parse(occurredAt) ||
          Date.parse(replacement.observed_at) >= Date.parse(observedAt) ||
          validTo !== replacement.valid_from
        ) {
          throw new PersonLifecycleError(
            "invalid_time_order",
            "Supersession requires explicit, strictly ordered replacement validity times"
          );
        }
      }
      const resultingVersion = fact.version + 1;
      database.prepare(`
        INSERT INTO person_fact_transitions (
          id, account_id, fact_id, from_status, to_status, observed_at,
          occurred_at, valid_to, replacement_fact_id, evidence_id,
          expected_version, resulting_version, is_applied, invalid_reason,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)
      `).run(
        id,
        accountId,
        factId,
        input.toStatus,
        observedAt,
        occurredAt,
        validTo,
        replacementFactId,
        evidence.id,
        fact.version,
        resultingVersion,
        now,
        now
      );
      database.prepare(`
        UPDATE person_facts
        SET status = ?, valid_to = ?, superseded_by = ?, version = ?, updated_at = ?
        WHERE id = ? AND account_id = ? AND version = ? AND status = 'active'
      `).run(
        input.toStatus,
        validTo,
        replacementFactId,
        resultingVersion,
        now,
        factId,
        accountId,
        fact.version
      );
      return factFromRow(requireFact(accountId, factId));
    })();
  }

  function resolveFact(input: Omit<Parameters<typeof transitionFact>[0], "toStatus" | "replacementFactId">) {
    return transitionFact({ ...input, toStatus: "resolved", replacementFactId: null });
  }

  function supersedeFact(
    input: Omit<Parameters<typeof transitionFact>[0], "toStatus"> & { replacementFactId: string }
  ) {
    return transitionFact({ ...input, toStatus: "superseded" });
  }

  function getFact(accountIdInput: string, factIdInput: string) {
    const accountId = assertLifecycleIdentifier(accountIdInput, "account id");
    const factId = assertLifecycleIdentifier(factIdInput, "Fact id");
    const row = rawFact(accountId, factId);
    return row && loadEvidence(accountId, factId).length > 0 ? factFromRow(row) : null;
  }

  function listFactsForPerson(accountIdInput: string, personIdInput: string) {
    const accountId = assertLifecycleIdentifier(accountIdInput, "account id");
    const personId = assertLifecycleIdentifier(personIdInput, "Person id");
    const rows = database.prepare(`
      SELECT fact.*
      FROM person_facts fact
      INNER JOIN person_entities person
        ON person.id = fact.subject_person_id AND person.account_id = fact.account_id
      WHERE fact.account_id = ? AND fact.subject_person_id = ?
        AND person.status = 'confirmed'
        AND EXISTS (
          SELECT 1 FROM person_fact_evidence fact_evidence
          INNER JOIN person_evidence evidence
            ON evidence.id = fact_evidence.evidence_id
            AND evidence.account_id = fact_evidence.account_id
          WHERE fact_evidence.account_id = fact.account_id
            AND fact_evidence.fact_id = fact.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM person_fact_evidence fact_evidence
          INNER JOIN person_subject_observations subject
            ON subject.evidence_id = fact_evidence.evidence_id
            AND subject.account_id = fact_evidence.account_id
          INNER JOIN person_entities subject_person
            ON subject_person.id = subject.person_id
            AND subject_person.account_id = subject.account_id
          WHERE fact_evidence.account_id = fact.account_id
            AND fact_evidence.fact_id = fact.id
            AND subject.status = 'confirmed'
            AND subject_person.status = 'confirmed'
            AND subject.person_id <> fact.subject_person_id
        )
        AND (
          fact.relationship_id IS NULL OR EXISTS (
            SELECT 1 FROM person_relationships relationship
            WHERE relationship.id = fact.relationship_id
              AND relationship.account_id = fact.account_id
              AND relationship.status = 'confirmed'
              AND relationship.explicitly_confirmed = 1
              AND EXISTS (
                SELECT 1 FROM person_relationship_evidence relationship_evidence
                WHERE relationship_evidence.account_id = relationship.account_id
                  AND relationship_evidence.relationship_id = relationship.id
              )
          )
        )
      ORDER BY fact.observed_at DESC, fact.id
    `).all(accountId, personId) as FactRow[];
    return rows.map(factFromRow);
  }

  return { createFact, resolveFact, supersedeFact, getFact, listFactsForPerson };
}

export type TemporalFactRepository = ReturnType<typeof createTemporalFactRepository>;
