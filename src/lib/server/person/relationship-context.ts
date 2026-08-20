import type Database from "better-sqlite3";
import { createPersonCommitmentRepository } from "./commitments";
import { normalizeLifecycleTimestamp } from "./lifecycle-support";
import { createPersonRelationshipRepository } from "./relationship-repository";
import { createPersonRepository } from "./repository";
import { createTemporalFactRepository } from "./temporal-facts";
import type {
  PersonCommitment,
  PersonCommitmentStatus,
  PersonEvidence,
  PersonFact,
  PersonFactStatus
} from "./types";

export type RelationshipContextChange = {
  kind: "fact" | "commitment";
  entityId: string;
  fromStatus: string;
  toStatus: string;
  observedAt: string;
  occurredAt: string;
  evidence: PersonEvidence;
};

export type RelationshipContextUncertainty = {
  code: "insufficient_evidence";
  reason: "insufficient_evidence";
};

function projectFactAsOf(fact: PersonFact, asOf: string): PersonFact | null {
  if (
    Date.parse(fact.observedAt) > Date.parse(asOf) ||
    fact.validFrom && Date.parse(fact.validFrom) > Date.parse(asOf)
  ) {
    return null;
  }
  let status: PersonFactStatus = "active";
  let validTo: string | null = null;
  let supersededBy: string | null = null;
  let version = 1;
  const transitions = fact.transitions.filter((transition) =>
    transition.applied &&
    Date.parse(transition.observedAt) <= Date.parse(asOf) &&
    Date.parse(transition.occurredAt) <= Date.parse(asOf)
  );
  for (const transition of transitions) {
    if (transition.fromStatus !== status || transition.expectedVersion !== version) {
      continue;
    }
    status = transition.toStatus;
    validTo = transition.validTo;
    supersededBy = transition.replacementFactId;
    version = transition.resultingVersion;
  }
  return {
    ...fact,
    status,
    validTo,
    supersededBy,
    version,
    transitions
  };
}

function projectCommitmentAsOf(commitment: PersonCommitment, asOf: string): PersonCommitment | null {
  if (
    Date.parse(commitment.observedAt) > Date.parse(asOf) ||
    Date.parse(commitment.occurredAt) > Date.parse(asOf)
  ) {
    return null;
  }
  let status: PersonCommitmentStatus = "created";
  let resolvedAt: string | null = null;
  let supersededBy: string | null = null;
  let version = 1;
  const transitions = commitment.transitions.filter((transition) =>
    transition.applied &&
    Date.parse(transition.observedAt) <= Date.parse(asOf) &&
    Date.parse(transition.occurredAt) <= Date.parse(asOf)
  );
  for (const transition of transitions) {
    if (transition.fromStatus !== status || transition.expectedVersion !== version) {
      continue;
    }
    status = transition.toStatus;
    resolvedAt = transition.toStatus === "active" ? null : transition.occurredAt;
    supersededBy = transition.replacementCommitmentId;
    version = transition.resultingVersion;
  }
  return {
    ...commitment,
    status,
    resolvedAt,
    supersededBy,
    version,
    transitions
  };
}

function evidenceReferences(input: {
  relationships: NonNullable<ReturnType<ReturnType<typeof createPersonRelationshipRepository>["listConfirmedForPerson"]>>;
  facts: PersonFact[];
  commitments: PersonCommitment[];
}) {
  const byId = new Map<string, PersonEvidence>();
  for (const relationship of input.relationships) {
    for (const evidence of relationship.evidence) byId.set(evidence.id, evidence);
  }
  for (const fact of input.facts) {
    for (const evidence of fact.evidence) byId.set(evidence.id, evidence);
    for (const transition of fact.transitions) byId.set(transition.evidence.id, transition.evidence);
  }
  for (const commitment of input.commitments) {
    for (const evidence of commitment.evidence) byId.set(evidence.id, evidence);
    for (const transition of commitment.transitions) byId.set(transition.evidence.id, transition.evidence);
  }
  return [...byId.values()].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  );
}

function emptyContext(input: {
  person: ReturnType<ReturnType<typeof createPersonRepository>["getConfirmedPerson"]>;
  asOf: string;
}) {
  return {
    known: false as const,
    reason: "insufficient_evidence" as const,
    asOf: input.asOf,
    person: input.person,
    confirmedRelationships: [],
    recentFacts: [],
    activeFacts: [],
    previousFacts: [],
    recentChanges: [],
    activeCommitments: [],
    completedCommitments: [],
    continuationCandidates: [],
    evidenceReferences: [],
    uncertainties: [{
      code: "insufficient_evidence",
      reason: "insufficient_evidence"
    }] as RelationshipContextUncertainty[]
  };
}

export function createRelationshipContextBuilder(database: Database.Database) {
  const personRepository = createPersonRepository(database);
  const relationshipRepository = createPersonRelationshipRepository(database);
  const factRepository = createTemporalFactRepository(database);
  const commitmentRepository = createPersonCommitmentRepository(database);

  function buildRelationshipContext(input: {
    accountId: string;
    personId: string;
    asOf?: string;
  }) {
    const asOf = normalizeLifecycleTimestamp(
      input.asOf ?? new Date().toISOString(),
      "Relationship context asOf"
    );
    const person = personRepository.getConfirmedPerson(input.accountId, input.personId);
    if (!person) {
      return emptyContext({ person: null, asOf });
    }
    const relationships = (relationshipRepository.listConfirmedForPerson(
      input.accountId,
      input.personId
    ) ?? []).filter((relationship) =>
      Boolean(relationship.confirmedAt) &&
      Date.parse(relationship.confirmedAt!) <= Date.parse(asOf)
    );
    const relationshipIds = new Set(relationships.map((relationship) => relationship.id));
    const facts = factRepository.listFactsForPerson(input.accountId, input.personId)
      .map((fact) => projectFactAsOf(fact, asOf))
      .filter((fact): fact is PersonFact => fact !== null)
      .filter((fact) => !fact.relationshipId || relationshipIds.has(fact.relationshipId))
      .sort((left, right) =>
        right.observedAt.localeCompare(left.observedAt) || left.id.localeCompare(right.id)
      );
    const commitments = commitmentRepository.listCommitmentsForPerson(input.accountId, input.personId)
      .map((commitment) => projectCommitmentAsOf(commitment, asOf))
      .filter((commitment): commitment is PersonCommitment => commitment !== null)
      .filter((commitment) =>
        !commitment.relationshipId || relationshipIds.has(commitment.relationshipId)
      )
      .sort((left, right) =>
        right.occurredAt.localeCompare(left.occurredAt) || left.id.localeCompare(right.id)
      );
    if (relationships.length === 0 && facts.length === 0 && commitments.length === 0) {
      return emptyContext({ person, asOf });
    }
    const recentChanges: RelationshipContextChange[] = [
      ...facts.flatMap((fact) => fact.transitions.map((transition) => ({
        kind: "fact" as const,
        entityId: fact.id,
        fromStatus: transition.fromStatus,
        toStatus: transition.toStatus,
        observedAt: transition.observedAt,
        occurredAt: transition.occurredAt,
        evidence: transition.evidence
      }))),
      ...commitments.flatMap((commitment) => commitment.transitions.map((transition) => ({
        kind: "commitment" as const,
        entityId: commitment.id,
        fromStatus: transition.fromStatus,
        toStatus: transition.toStatus,
        observedAt: transition.observedAt,
        occurredAt: transition.occurredAt,
        evidence: transition.evidence
      })))
    ].sort((left, right) =>
      right.occurredAt.localeCompare(left.occurredAt) || left.entityId.localeCompare(right.entityId)
    );
    const activeCommitments = commitments.filter((commitment) => commitment.status === "active");
    return {
      known: true as const,
      reason: null,
      asOf,
      person,
      confirmedRelationships: relationships,
      recentFacts: facts,
      activeFacts: facts.filter((fact) => fact.status === "active"),
      previousFacts: facts.filter((fact) => fact.status !== "active"),
      recentChanges,
      activeCommitments,
      completedCommitments: commitments.filter((commitment) => commitment.status === "completed"),
      continuationCandidates: activeCommitments.map((commitment) => ({
        kind: "commitment" as const,
        commitment,
        evidence: commitment.evidence
      })),
      evidenceReferences: evidenceReferences({ relationships, facts, commitments }),
      uncertainties: [] as RelationshipContextUncertainty[]
    };
  }

  return { buildRelationshipContext };
}

export type RelationshipContextBuilder = ReturnType<typeof createRelationshipContextBuilder>;
