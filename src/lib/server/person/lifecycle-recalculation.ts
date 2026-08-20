import type Database from "better-sqlite3";

type FactRow = {
  id: string;
  account_id: string;
  subject_person_id: string;
  relationship_id: string | null;
  kind: string;
  fact_key: string;
  observed_at: string;
  valid_from: string | null;
};

type FactTransitionRow = {
  id: string;
  from_status: "active";
  to_status: "resolved" | "superseded";
  observed_at: string;
  occurred_at: string;
  valid_to: string | null;
  replacement_fact_id: string | null;
  expected_version: number;
  resulting_version: number;
};

type CommitmentRow = {
  id: string;
  account_id: string;
  relationship_id: string | null;
  promisor_person_id: string;
  promisee_person_id: string;
  observed_at: string;
  occurred_at: string;
};

type CommitmentTransitionRow = {
  id: string;
  from_status: "created" | "active";
  to_status: "active" | "completed" | "cancelled" | "superseded";
  observed_at: string;
  occurred_at: string;
  replacement_commitment_id: string | null;
  expected_version: number;
  resulting_version: number;
};

function milliseconds(value: string | null) {
  return value ? Date.parse(value) : Number.NaN;
}

function factReplacementReason(
  database: Database.Database,
  fact: FactRow,
  transition: FactTransitionRow
) {
  if (!transition.replacement_fact_id) return "replacement_missing";
  const replacement = database.prepare(`
    SELECT id, account_id, subject_person_id, relationship_id, kind, fact_key,
      observed_at, valid_from
    FROM person_facts WHERE id = ? AND account_id = ?
  `).get(transition.replacement_fact_id, fact.account_id) as FactRow | undefined;
  if (!replacement) return "replacement_missing";
  if (
    replacement.subject_person_id !== fact.subject_person_id ||
    replacement.kind !== fact.kind ||
    replacement.fact_key !== fact.fact_key ||
    replacement.relationship_id !== fact.relationship_id
  ) {
    return "replacement_incompatible";
  }
  if (
    !fact.valid_from ||
    !replacement.valid_from ||
    milliseconds(replacement.valid_from) <= milliseconds(fact.valid_from) ||
    milliseconds(replacement.valid_from) > milliseconds(transition.occurred_at) ||
    milliseconds(replacement.observed_at) >= milliseconds(transition.observed_at)
  ) {
    return "replacement_time_order_invalid";
  }
  if (!transition.valid_to || transition.valid_to !== replacement.valid_from) {
    return "replacement_valid_to_invalid";
  }
  return null;
}

function recalculateFacts(database: Database.Database, accountId: string, now: string) {
  const deletedFactCount = database.prepare(`
    DELETE FROM person_facts
    WHERE account_id = ? AND NOT EXISTS (
      SELECT 1 FROM person_fact_evidence evidence
      WHERE evidence.account_id = person_facts.account_id
        AND evidence.fact_id = person_facts.id
    )
  `).run(accountId).changes;
  const facts = database.prepare(`
    SELECT id, account_id, subject_person_id, relationship_id, kind, fact_key,
      observed_at, valid_from
    FROM person_facts WHERE account_id = ? ORDER BY created_at, id
  `).all(accountId) as FactRow[];
  const updateTransition = database.prepare(`
    UPDATE person_fact_transitions
    SET is_applied = ?, invalid_reason = ?, updated_at = ?
    WHERE id = ? AND account_id = ?
  `);
  const updateFact = database.prepare(`
    UPDATE person_facts
    SET status = ?, valid_to = ?, superseded_by = ?, version = ?, updated_at = ?
    WHERE id = ? AND account_id = ?
  `);

  for (const fact of facts) {
    let status: "active" | "resolved" | "superseded" = "active";
    let version = 1;
    let validTo: string | null = null;
    let supersededBy: string | null = null;
    let lastObservedAt = fact.observed_at;
    let lastOccurredAt = fact.valid_from ?? fact.observed_at;
    const transitions = database.prepare(`
      SELECT id, from_status, to_status, observed_at, occurred_at, valid_to,
        replacement_fact_id, expected_version, resulting_version
      FROM person_fact_transitions
      WHERE account_id = ? AND fact_id = ?
      ORDER BY occurred_at, observed_at, created_at, id
    `).all(accountId, fact.id) as FactTransitionRow[];
    for (const transition of transitions) {
      let invalidReason: string | null = null;
      if (status !== transition.from_status) {
        invalidReason = "state_chain_mismatch";
      } else if (
        transition.expected_version !== version ||
        transition.resulting_version !== version + 1
      ) {
        invalidReason = "version_chain_mismatch";
      } else if (
        !lastOccurredAt ||
        milliseconds(transition.occurred_at) <= milliseconds(lastOccurredAt) ||
        milliseconds(transition.observed_at) <= milliseconds(lastObservedAt)
      ) {
        invalidReason = "time_order_invalid";
      } else if (
        transition.valid_to &&
        (
          milliseconds(transition.valid_to) < milliseconds(lastOccurredAt) ||
          milliseconds(transition.valid_to) > milliseconds(transition.occurred_at)
        )
      ) {
        invalidReason = "valid_to_invalid";
      } else if (transition.to_status === "superseded") {
        invalidReason = factReplacementReason(database, fact, transition);
      }
      if (invalidReason) {
        updateTransition.run(0, invalidReason, now, transition.id, accountId);
        continue;
      }
      updateTransition.run(1, null, now, transition.id, accountId);
      status = transition.to_status;
      version = transition.resulting_version;
      validTo = transition.valid_to;
      supersededBy = transition.replacement_fact_id;
      lastObservedAt = transition.observed_at;
      lastOccurredAt = transition.occurred_at;
    }
    updateFact.run(status, validTo, supersededBy, version, now, fact.id, accountId);
  }
  return { deletedFactCount, recalculatedFactCount: facts.length };
}

function commitmentReplacementReason(
  database: Database.Database,
  commitment: CommitmentRow,
  transition: CommitmentTransitionRow
) {
  if (!transition.replacement_commitment_id) return "replacement_missing";
  const replacement = database.prepare(`
    SELECT id, account_id, relationship_id, promisor_person_id, promisee_person_id,
      observed_at, occurred_at
    FROM person_commitments WHERE id = ? AND account_id = ?
  `).get(transition.replacement_commitment_id, commitment.account_id) as CommitmentRow | undefined;
  if (!replacement) return "replacement_missing";
  if (
    replacement.promisor_person_id !== commitment.promisor_person_id ||
    replacement.promisee_person_id !== commitment.promisee_person_id ||
    replacement.relationship_id !== commitment.relationship_id
  ) {
    return "replacement_incompatible";
  }
  if (
    milliseconds(replacement.occurred_at) <= milliseconds(commitment.occurred_at) ||
    milliseconds(replacement.occurred_at) > milliseconds(transition.occurred_at) ||
    milliseconds(replacement.observed_at) >= milliseconds(transition.observed_at)
  ) {
    return "replacement_time_order_invalid";
  }
  return null;
}

function allowedCommitmentTransition(fromStatus: string, toStatus: string) {
  return (
    fromStatus === "created" && ["active", "cancelled", "superseded"].includes(toStatus)
  ) || (
    fromStatus === "active" && ["completed", "cancelled", "superseded"].includes(toStatus)
  );
}

function recalculateCommitments(database: Database.Database, accountId: string, now: string) {
  const deletedCommitmentCount = database.prepare(`
    DELETE FROM person_commitments
    WHERE account_id = ? AND NOT EXISTS (
      SELECT 1 FROM person_commitment_evidence evidence
      WHERE evidence.account_id = person_commitments.account_id
        AND evidence.commitment_id = person_commitments.id
    )
  `).run(accountId).changes;
  const commitments = database.prepare(`
    SELECT id, account_id, relationship_id, promisor_person_id, promisee_person_id,
      observed_at, occurred_at
    FROM person_commitments WHERE account_id = ? ORDER BY created_at, id
  `).all(accountId) as CommitmentRow[];
  const updateTransition = database.prepare(`
    UPDATE person_commitment_transitions
    SET is_applied = ?, invalid_reason = ?, updated_at = ?
    WHERE id = ? AND account_id = ?
  `);
  const updateCommitment = database.prepare(`
    UPDATE person_commitments
    SET status = ?, resolved_at = ?, superseded_by = ?, version = ?, updated_at = ?
    WHERE id = ? AND account_id = ?
  `);

  for (const commitment of commitments) {
    let status: "created" | "active" | "completed" | "cancelled" | "superseded" = "created";
    let version = 1;
    let resolvedAt: string | null = null;
    let supersededBy: string | null = null;
    let lastObservedAt = commitment.observed_at;
    let lastOccurredAt = commitment.occurred_at;
    const transitions = database.prepare(`
      SELECT id, from_status, to_status, observed_at, occurred_at,
        replacement_commitment_id, expected_version, resulting_version
      FROM person_commitment_transitions
      WHERE account_id = ? AND commitment_id = ?
      ORDER BY occurred_at, observed_at, created_at, id
    `).all(accountId, commitment.id) as CommitmentTransitionRow[];
    for (const transition of transitions) {
      let invalidReason: string | null = null;
      if (
        status !== transition.from_status ||
        !allowedCommitmentTransition(transition.from_status, transition.to_status)
      ) {
        invalidReason = "state_chain_mismatch";
      } else if (
        transition.expected_version !== version ||
        transition.resulting_version !== version + 1
      ) {
        invalidReason = "version_chain_mismatch";
      } else if (
        milliseconds(transition.occurred_at) <= milliseconds(lastOccurredAt) ||
        milliseconds(transition.observed_at) <= milliseconds(lastObservedAt)
      ) {
        invalidReason = "time_order_invalid";
      } else if (transition.to_status === "superseded") {
        invalidReason = commitmentReplacementReason(database, commitment, transition);
      }
      if (invalidReason) {
        updateTransition.run(0, invalidReason, now, transition.id, accountId);
        continue;
      }
      updateTransition.run(1, null, now, transition.id, accountId);
      status = transition.to_status;
      version = transition.resulting_version;
      resolvedAt = transition.to_status === "active" ? null : transition.occurred_at;
      supersededBy = transition.replacement_commitment_id;
      lastObservedAt = transition.observed_at;
      lastOccurredAt = transition.occurred_at;
    }
    updateCommitment.run(
      status,
      resolvedAt,
      supersededBy,
      version,
      now,
      commitment.id,
      accountId
    );
  }
  return { deletedCommitmentCount, recalculatedCommitmentCount: commitments.length };
}

export function recalculatePersonLifecycle(
  database: Database.Database,
  input: { accountId: string; now?: string }
) {
  const now = input.now ?? new Date().toISOString();
  return database.transaction(() => ({
    ...recalculateFacts(database, input.accountId, now),
    ...recalculateCommitments(database, input.accountId, now)
  }))();
}
