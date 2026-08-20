import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  isChunkLocalSpeakerLabel,
  trustedTranscriptSpeakerIdentity
} from "@/lib/domain/speaker-identity";
import {
  assertValidatedPersonTranscriptEvidence,
  type ValidatedPersonTranscriptEvidence
} from "./evidence";
import {
  PersonAssertionStatusSchema,
  PersonEntitySchema,
  PersonIdentityLinkSchema,
  PersonIdentityLinkSourceSchema,
  PersonNameKindSchema,
  PersonNameSchema,
  PersonSourceSchema,
  PersonSubjectObservationSchema,
  type PersonAssertionStatus,
  type PersonEntity,
  type PersonEvidence,
  type PersonIdentityLink,
  type PersonIdentityLinkSource,
  type PersonName,
  type PersonNameKind,
  type PersonSource,
  type PersonSubjectObservation,
  type PersonUploadDeleteResult
} from "./types";
import { recalculatePersonLifecycle } from "./lifecycle-recalculation";

const RECORD_ID_PATTERN = /^[^\s]+$/u;

type PersonEntityRow = {
  id: string;
  account_id: string;
  display_name: string;
  source: string;
  status: string;
  created_at: string;
  updated_at: string;
};

type PersonEntityAdmissionRow = {
  version: number;
  is_unnamed: number;
  explicitly_confirmed: number;
  confirmed_at: string | null;
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

type PersonNameRow = {
  id: string;
  account_id: string;
  person_id: string;
  evidence_id: string;
  name: string;
  normalized_name: string;
  kind: string;
  status: string;
  source: string;
  created_at: string;
  updated_at: string;
};

type PersonIdentityLinkRow = {
  id: string;
  account_id: string;
  person_id: string;
  identity_id: string;
  evidence_id: string;
  status: string;
  source: string;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
};

type PersonSubjectObservationRow = {
  id: string;
  account_id: string;
  person_id: string | null;
  evidence_id: string;
  status: string;
  source: string;
  reason: string;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
};

export class PersonRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonRepositoryError";
  }
}

function assertIdentifier(value: string, label: string) {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > 512 || !RECORD_ID_PATTERN.test(normalized)) {
    throw new PersonRepositoryError(`Invalid ${label}`);
  }
  return normalized;
}

function assertName(value: string) {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > 500) {
    throw new PersonRepositoryError("Invalid person name");
  }
  return normalized;
}

export function normalizePersonName(value: string) {
  return assertName(value).toLocaleLowerCase("und");
}

function stableId(prefix: string, ...values: string[]) {
  const digest = createHash("sha256")
    .update(values.join("\u0000"))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

function evidenceFromRow(row: PersonEvidenceRow): PersonEvidence {
  return {
    id: row.id,
    accountId: row.account_id,
    uploadId: row.upload_id,
    sourceSegmentId: row.source_segment_id,
    quote: row.quote,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function nameFromRow(row: PersonNameRow): PersonName {
  return PersonNameSchema.parse({
    id: row.id,
    accountId: row.account_id,
    personId: row.person_id,
    evidenceId: row.evidence_id,
    name: row.name,
    normalizedName: row.normalized_name,
    kind: row.kind,
    status: row.status,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function identityLinkFromRow(row: PersonIdentityLinkRow): PersonIdentityLink {
  return PersonIdentityLinkSchema.parse({
    id: row.id,
    accountId: row.account_id,
    personId: row.person_id,
    identityId: row.identity_id,
    evidenceId: row.evidence_id,
    status: row.status,
    source: row.source,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function subjectObservationFromRow(row: PersonSubjectObservationRow): PersonSubjectObservation {
  return PersonSubjectObservationSchema.parse({
    id: row.id,
    accountId: row.account_id,
    personId: row.person_id,
    evidenceId: row.evidence_id,
    status: row.status,
    source: row.source,
    reason: row.reason,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function assertEvidenceAccount(evidence: ValidatedPersonTranscriptEvidence, accountId: string) {
  assertValidatedPersonTranscriptEvidence(evidence);
  if (evidence.accountId !== accountId) {
    throw new PersonRepositoryError("Person evidence belongs to another account");
  }
}

export function persistValidatedPersonEvidence(
  database: Database.Database,
  input: {
    accountId: string;
    evidence: ValidatedPersonTranscriptEvidence;
    now?: string;
  }
) {
  const accountId = assertIdentifier(input.accountId, "account id");
  const now = input.now ?? new Date().toISOString();
  assertEvidenceAccount(input.evidence, accountId);
  database.prepare(`
    INSERT INTO person_evidence (
      id, account_id, upload_id, source_segment_id, quote, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    input.evidence.id,
    accountId,
    input.evidence.uploadId,
    input.evidence.sourceSegmentId,
    input.evidence.quote,
    now,
    now
  );
  const stored = database.prepare(`
    SELECT * FROM person_evidence WHERE id = ? AND account_id = ?
  `).get(input.evidence.id, accountId) as PersonEvidenceRow | undefined;
  if (
    !stored ||
    stored.upload_id !== input.evidence.uploadId ||
    stored.source_segment_id !== input.evidence.sourceSegmentId ||
    stored.quote !== input.evidence.quote
  ) {
    throw new PersonRepositoryError("Validated Transcript evidence conflicts with persisted Person evidence");
  }
  return evidenceFromRow(stored);
}

function countRows(
  database: Database.Database,
  table: "person_names" | "person_identity_links" | "person_subject_observations",
  accountId: string,
  uploadId: string
) {
  return (database.prepare(`
    SELECT COUNT(*) AS count
    FROM ${table} child
    INNER JOIN person_evidence evidence
      ON evidence.id = child.evidence_id AND evidence.account_id = child.account_id
    WHERE child.account_id = ? AND evidence.upload_id = ?
  `).get(accountId, uploadId) as { count: number }).count;
}

export function deletePersonEvidenceByUpload(
  database: Database.Database,
  input: { accountId: string; uploadId: string; now?: string }
): PersonUploadDeleteResult {
  const accountId = assertIdentifier(input.accountId, "account id");
  const uploadId = assertIdentifier(input.uploadId, "upload id");
  const now = input.now ?? new Date().toISOString();
  const affectedPeople = database.prepare(`
    SELECT DISTINCT child.person_id AS person_id
    FROM (
      SELECT account_id, person_id, evidence_id FROM person_names
      UNION ALL
      SELECT account_id, person_id, evidence_id FROM person_identity_links
      UNION ALL
      SELECT account_id, person_id, evidence_id
      FROM person_subject_observations
      WHERE person_id IS NOT NULL
    ) child
    INNER JOIN person_evidence evidence
      ON evidence.id = child.evidence_id AND evidence.account_id = child.account_id
    WHERE child.account_id = ? AND evidence.upload_id = ?
  `).all(accountId, uploadId) as Array<{ person_id: string }>;
  const relationshipsLosingAllEvidence = database.prepare(`
    SELECT relationship.id
    FROM person_relationships relationship
    WHERE relationship.account_id = ? AND relationship.status <> 'archived'
      AND EXISTS (
        SELECT 1
        FROM person_relationship_evidence relationship_evidence
        INNER JOIN person_evidence evidence
          ON evidence.id = relationship_evidence.evidence_id
          AND evidence.account_id = relationship_evidence.account_id
        WHERE relationship_evidence.account_id = relationship.account_id
          AND relationship_evidence.relationship_id = relationship.id
          AND evidence.upload_id = ?
      )
      AND NOT EXISTS (
        SELECT 1
        FROM person_relationship_evidence relationship_evidence
        INNER JOIN person_evidence evidence
          ON evidence.id = relationship_evidence.evidence_id
          AND evidence.account_id = relationship_evidence.account_id
        WHERE relationship_evidence.account_id = relationship.account_id
          AND relationship_evidence.relationship_id = relationship.id
          AND evidence.upload_id <> ?
      )
    ORDER BY relationship.id
  `).all(accountId, uploadId, uploadId) as Array<{ id: string }>;

  const deletedNameCount = countRows(database, "person_names", accountId, uploadId);
  const deletedIdentityLinkCount = countRows(database, "person_identity_links", accountId, uploadId);
  const deletedSubjectObservationCount = countRows(
    database,
    "person_subject_observations",
    accountId,
    uploadId
  );
  const deletedRelationshipEvidenceCount = (database.prepare(`
    SELECT COUNT(*) AS count
    FROM person_relationship_evidence relationship_evidence
    INNER JOIN person_evidence evidence
      ON evidence.id = relationship_evidence.evidence_id
      AND evidence.account_id = relationship_evidence.account_id
    WHERE relationship_evidence.account_id = ? AND evidence.upload_id = ?
  `).get(accountId, uploadId) as { count: number }).count;
  const deletedFactEvidenceCount = (database.prepare(`
    SELECT COUNT(*) AS count
    FROM person_fact_evidence fact_evidence
    INNER JOIN person_evidence evidence
      ON evidence.id = fact_evidence.evidence_id
      AND evidence.account_id = fact_evidence.account_id
    WHERE fact_evidence.account_id = ? AND evidence.upload_id = ?
  `).get(accountId, uploadId) as { count: number }).count;
  const deletedFactTransitionCount = (database.prepare(`
    SELECT COUNT(*) AS count
    FROM person_fact_transitions transition
    INNER JOIN person_evidence evidence
      ON evidence.id = transition.evidence_id
      AND evidence.account_id = transition.account_id
    WHERE transition.account_id = ? AND evidence.upload_id = ?
  `).get(accountId, uploadId) as { count: number }).count;
  const deletedCommitmentEvidenceCount = (database.prepare(`
    SELECT COUNT(*) AS count
    FROM person_commitment_evidence commitment_evidence
    INNER JOIN person_evidence evidence
      ON evidence.id = commitment_evidence.evidence_id
      AND evidence.account_id = commitment_evidence.account_id
    WHERE commitment_evidence.account_id = ? AND evidence.upload_id = ?
  `).get(accountId, uploadId) as { count: number }).count;
  const deletedCommitmentTransitionCount = (database.prepare(`
    SELECT COUNT(*) AS count
    FROM person_commitment_transitions transition
    INNER JOIN person_evidence evidence
      ON evidence.id = transition.evidence_id
      AND evidence.account_id = transition.account_id
    WHERE transition.account_id = ? AND evidence.upload_id = ?
  `).get(accountId, uploadId) as { count: number }).count;
  const deletedSubjectResolutionAuditCount = database.prepare(`
    DELETE FROM person_subject_resolution_audits
    WHERE account_id = ? AND upload_id = ?
  `).run(accountId, uploadId).changes;
  const deletedEvidenceCount = database.prepare(`
    DELETE FROM person_evidence
    WHERE account_id = ? AND upload_id = ?
  `).run(accountId, uploadId).changes;
  const archivedRelationshipCount = database.prepare(`
    UPDATE person_relationships
    SET status = 'archived', explicitly_confirmed = 0,
        confirmed_at = NULL, updated_at = ?
    WHERE account_id = ? AND status <> 'archived'
      AND NOT EXISTS (
        SELECT 1
        FROM person_relationship_evidence relationship_evidence
        WHERE relationship_evidence.account_id = person_relationships.account_id
          AND relationship_evidence.relationship_id = person_relationships.id
      )
  `).run(now, accountId).changes;
  database.prepare(`
    UPDATE dc_person_relationship_links
    SET status = 'archived', updated_at = ?
    WHERE account_id = ? AND person_relationship_id IN (
      SELECT id FROM person_relationships
      WHERE account_id = ? AND status = 'archived'
    )
  `).run(now, accountId, accountId);
  for (const relationship of relationshipsLosingAllEvidence) {
    database.prepare(`
      UPDATE person_relationship_admissions
      SET version = version + 1, updated_at = ?
      WHERE account_id = ? AND relationship_id = ?
    `).run(now, accountId, relationship.id);
  }
  const lifecycleRecalculation = recalculatePersonLifecycle(database, { accountId, now });

  let archivedPersonCount = 0;
  for (const { person_id: personId } of affectedPeople) {
    const person = database.prepare(`
      SELECT status FROM person_entities WHERE id = ? AND account_id = ?
    `).get(personId, accountId) as { status: string } | undefined;
    if (!person || person.status === "archived") {
      continue;
    }
    const explicitAdmission = database.prepare(`
      SELECT 1 FROM person_entity_admissions
      WHERE account_id = ? AND person_id = ?
    `).get(accountId, personId);
    if (explicitAdmission) {
      continue;
    }
    const supportedName = database.prepare(`
      SELECT name
      FROM person_names
      WHERE account_id = ? AND person_id = ?
        AND status IN (${person.status === "confirmed" ? "'confirmed'" : "'candidate', 'confirmed'"})
      ORDER BY CASE kind WHEN 'display_name' THEN 0 ELSE 1 END, updated_at DESC, id
      LIMIT 1
    `).get(accountId, personId) as { name: string } | undefined;
    if (supportedName) {
      database.prepare(`
        UPDATE person_entities
        SET display_name = ?, updated_at = ?
        WHERE id = ? AND account_id = ?
      `).run(supportedName.name, now, personId, accountId);
      continue;
    }
    archivedPersonCount += database.prepare(`
      UPDATE person_entities
      SET status = 'archived', updated_at = ?
      WHERE id = ? AND account_id = ? AND status <> 'archived'
    `).run(now, personId, accountId).changes;
  }

  return {
    deletedEvidenceCount,
    deletedNameCount,
    deletedIdentityLinkCount,
    deletedSubjectObservationCount,
    deletedSubjectResolutionAuditCount,
    deletedRelationshipEvidenceCount,
    archivedRelationshipCount,
    deletedFactEvidenceCount,
    deletedFactTransitionCount,
    deletedFactCount: lifecycleRecalculation.deletedFactCount,
    recalculatedFactCount: lifecycleRecalculation.recalculatedFactCount,
    deletedCommitmentEvidenceCount,
    deletedCommitmentTransitionCount,
    deletedCommitmentCount: lifecycleRecalculation.deletedCommitmentCount,
    recalculatedCommitmentCount: lifecycleRecalculation.recalculatedCommitmentCount,
    archivedPersonCount
  };
}

export function createPersonRepository(database: Database.Database) {
  function persistEvidence(
    accountId: string,
    evidence: ValidatedPersonTranscriptEvidence,
    now: string
  ) {
    return persistValidatedPersonEvidence(database, { accountId, evidence, now });
  }

  function personRow(accountId: string, personId: string) {
    return database.prepare(`
      SELECT * FROM person_entities WHERE id = ? AND account_id = ?
    `).get(personId, accountId) as PersonEntityRow | undefined;
  }

  function requirePerson(accountId: string, personId: string) {
    const row = personRow(accountId, personId);
    if (!row) {
      throw new PersonRepositoryError("Person is unavailable for this account");
    }
    return row;
  }

  function loadEntity(row: PersonEntityRow, confirmedNamesOnly = false): PersonEntity {
    const names = database.prepare(`
      SELECT * FROM person_names
      WHERE account_id = ? AND person_id = ? AND kind = 'alias'
        ${confirmedNamesOnly ? "AND status = 'confirmed'" : ""}
      ORDER BY created_at, id
    `).all(row.account_id, row.id) as PersonNameRow[];
    const admission = database.prepare(`
      SELECT version, is_unnamed, explicitly_confirmed, confirmed_at
      FROM person_entity_admissions
      WHERE account_id = ? AND person_id = ?
    `).get(row.account_id, row.id) as PersonEntityAdmissionRow | undefined;
    return PersonEntitySchema.parse({
      id: row.id,
      accountId: row.account_id,
      displayName: admission?.is_unnamed === 1 ? null : row.display_name,
      aliases: names.map(nameFromRow),
      source: row.source,
      status: row.status,
      version: admission?.version ?? 1,
      explicitlyConfirmed: admission?.explicitly_confirmed === 1,
      confirmedAt: admission?.confirmed_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    });
  }

  function insertName(input: {
    accountId: string;
    personId: string;
    name: string;
    kind: PersonNameKind;
    status: PersonAssertionStatus;
    source: PersonSource;
    evidence: ValidatedPersonTranscriptEvidence;
    now: string;
  }) {
    const name = assertName(input.name);
    const kind = PersonNameKindSchema.parse(input.kind);
    const status = PersonAssertionStatusSchema.parse(input.status);
    const source = PersonSourceSchema.parse(input.source);
    persistEvidence(input.accountId, input.evidence, input.now);
    requirePerson(input.accountId, input.personId);
    const id = stableId(
      "person_name",
      input.accountId,
      input.personId,
      input.evidence.id,
      normalizePersonName(name),
      kind,
      source
    );
    database.prepare(`
      INSERT INTO person_names (
        id, account_id, person_id, evidence_id, name, normalized_name,
        kind, status, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = CASE
          WHEN person_names.status = 'confirmed' THEN person_names.status
          ELSE excluded.status
        END,
        updated_at = excluded.updated_at
    `).run(
      id,
      input.accountId,
      input.personId,
      input.evidence.id,
      name,
      normalizePersonName(name),
      kind,
      status,
      source,
      input.now,
      input.now
    );
    return nameFromRow(database.prepare("SELECT * FROM person_names WHERE id = ?").get(id) as PersonNameRow);
  }

  function createCandidate(input: {
    accountId: string;
    displayName: string;
    source: PersonSource;
    evidence: ValidatedPersonTranscriptEvidence;
    now?: string;
  }) {
    const accountId = assertIdentifier(input.accountId, "account id");
    const displayName = assertName(input.displayName);
    const source = PersonSourceSchema.parse(input.source);
    const now = input.now ?? new Date().toISOString();
    assertEvidenceAccount(input.evidence, accountId);
    const id = stableId(
      "person",
      accountId,
      input.evidence.id,
      normalizePersonName(displayName),
      source
    );
    return database.transaction(() => {
      persistEvidence(accountId, input.evidence, now);
      database.prepare(`
        INSERT INTO person_entities (
          id, account_id, display_name, source, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'candidate', ?, ?)
        ON CONFLICT(id) DO NOTHING
      `).run(id, accountId, displayName, source, now, now);
      insertName({
        accountId,
        personId: id,
        name: displayName,
        kind: "display_name",
        status: "candidate",
        source,
        evidence: input.evidence,
        now
      });
      return loadEntity(requirePerson(accountId, id));
    })();
  }

  function createAliasCandidate(input: {
    accountId: string;
    personId: string;
    alias: string;
    source: PersonSource;
    evidence: ValidatedPersonTranscriptEvidence;
    now?: string;
  }) {
    const accountId = assertIdentifier(input.accountId, "account id");
    const personId = assertIdentifier(input.personId, "person id");
    const now = input.now ?? new Date().toISOString();
    return database.transaction(() => insertName({
      accountId,
      personId,
      name: input.alias,
      kind: "alias",
      status: "candidate",
      source: PersonSourceSchema.parse(input.source),
      evidence: input.evidence,
      now
    }))();
  }

  function confirmPerson(input: {
    accountId: string;
    personId: string;
    evidence: ValidatedPersonTranscriptEvidence;
    now?: string;
  }) {
    const accountId = assertIdentifier(input.accountId, "account id");
    const personId = assertIdentifier(input.personId, "person id");
    const now = input.now ?? new Date().toISOString();
    return database.transaction(() => {
      const row = requirePerson(accountId, personId);
      if (row.status === "archived") {
        throw new PersonRepositoryError("Archived Person cannot be confirmed without a separate review flow");
      }
      persistEvidence(accountId, input.evidence, now);
      insertName({
        accountId,
        personId,
        name: row.display_name,
        kind: "display_name",
        status: "confirmed",
        source: "manual_confirmation",
        evidence: input.evidence,
        now
      });
      database.prepare(`
        UPDATE person_entities
        SET status = 'confirmed', source = 'manual_confirmation', updated_at = ?
        WHERE id = ? AND account_id = ?
      `).run(now, personId, accountId);
      return loadEntity(requirePerson(accountId, personId), true);
    })();
  }

  function confirmName(input: {
    accountId: string;
    nameId: string;
    evidence: ValidatedPersonTranscriptEvidence;
    now?: string;
  }) {
    const accountId = assertIdentifier(input.accountId, "account id");
    const nameId = assertIdentifier(input.nameId, "name id");
    const now = input.now ?? new Date().toISOString();
    return database.transaction(() => {
      const row = database.prepare(`
        SELECT * FROM person_names WHERE id = ? AND account_id = ?
      `).get(nameId, accountId) as PersonNameRow | undefined;
      if (!row) {
        throw new PersonRepositoryError("Person name is unavailable for this account");
      }
      const person = requirePerson(accountId, row.person_id);
      if (person.status !== "confirmed") {
        throw new PersonRepositoryError("Only a confirmed Person can have a confirmed name");
      }
      persistEvidence(accountId, input.evidence, now);
      database.prepare(`
        UPDATE person_names
        SET evidence_id = ?, status = 'confirmed', source = 'manual_confirmation', updated_at = ?
        WHERE id = ? AND account_id = ?
      `).run(input.evidence.id, now, nameId, accountId);
      return nameFromRow(database.prepare("SELECT * FROM person_names WHERE id = ?").get(nameId) as PersonNameRow);
    })();
  }

  function getPersonForReview(accountIdInput: string, personIdInput: string) {
    const accountId = assertIdentifier(accountIdInput, "account id");
    const personId = assertIdentifier(personIdInput, "person id");
    const row = personRow(accountId, personId);
    return row ? loadEntity(row) : null;
  }

  function getConfirmedPerson(accountIdInput: string, personIdInput: string) {
    const accountId = assertIdentifier(accountIdInput, "account id");
    const personId = assertIdentifier(personIdInput, "person id");
    const row = database.prepare(`
      SELECT * FROM person_entities
      WHERE id = ? AND account_id = ? AND status = 'confirmed'
    `).get(personId, accountId) as PersonEntityRow | undefined;
    return row ? loadEntity(row, true) : null;
  }

  function listPersonsForReview(accountIdInput: string) {
    const accountId = assertIdentifier(accountIdInput, "account id");
    const rows = database.prepare(`
      SELECT * FROM person_entities
      WHERE account_id = ?
      ORDER BY updated_at DESC, id
    `).all(accountId) as PersonEntityRow[];
    return rows.map((row) => loadEntity(row));
  }

  function listConfirmedPersons(accountIdInput: string) {
    const accountId = assertIdentifier(accountIdInput, "account id");
    const rows = database.prepare(`
      SELECT * FROM person_entities
      WHERE account_id = ? AND status = 'confirmed'
      ORDER BY updated_at DESC, id
    `).all(accountId) as PersonEntityRow[];
    return rows.map((row) => loadEntity(row, true));
  }

  function createIdentityLinkCandidate(input: {
    accountId: string;
    personId: string;
    identityId: string;
    source: PersonIdentityLinkSource;
    evidence: ValidatedPersonTranscriptEvidence;
    now?: string;
  }) {
    const accountId = assertIdentifier(input.accountId, "account id");
    const personId = assertIdentifier(input.personId, "person id");
    const identityId = assertIdentifier(input.identityId, "identity id");
    const source = PersonIdentityLinkSourceSchema.parse(input.source);
    const now = input.now ?? new Date().toISOString();
    if (identityId === personId) {
      throw new PersonRepositoryError("Identity id cannot be used as Person id");
    }
    if (isChunkLocalSpeakerLabel(identityId)) {
      throw new PersonRepositoryError("Chunk-local speaker labels cannot identify a Person");
    }
    return database.transaction(() => {
      requirePerson(accountId, personId);
      persistEvidence(accountId, input.evidence, now);
      const id = stableId("person_identity_link", accountId, personId, identityId, input.evidence.id);
      database.prepare(`
        INSERT INTO person_identity_links (
          id, account_id, person_id, identity_id, evidence_id, status, source,
          confirmed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'candidate', ?, NULL, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `).run(id, accountId, personId, identityId, input.evidence.id, source, now, now);
      return identityLinkFromRow(
        database.prepare("SELECT * FROM person_identity_links WHERE id = ?").get(id) as PersonIdentityLinkRow
      );
    })();
  }

  function confirmIdentityLink(input: {
    accountId: string;
    linkId: string;
    evidence: ValidatedPersonTranscriptEvidence;
    now?: string;
  }) {
    const accountId = assertIdentifier(input.accountId, "account id");
    const linkId = assertIdentifier(input.linkId, "identity link id");
    const now = input.now ?? new Date().toISOString();
    return database.transaction(() => {
      const link = database.prepare(`
        SELECT * FROM person_identity_links WHERE id = ? AND account_id = ?
      `).get(linkId, accountId) as PersonIdentityLinkRow | undefined;
      if (!link) {
        throw new PersonRepositoryError("Person identity link is unavailable for this account");
      }
      const person = requirePerson(accountId, link.person_id);
      if (person.status !== "confirmed") {
        throw new PersonRepositoryError("Identity link requires a confirmed Person");
      }
      assertEvidenceAccount(input.evidence, accountId);
      const trustedIdentity = trustedTranscriptSpeakerIdentity(input.evidence.segment);
      if (
        !trustedIdentity ||
        trustedIdentity.globalSpeakerId !== link.identity_id ||
        isChunkLocalSpeakerLabel(trustedIdentity.globalSpeakerId)
      ) {
        throw new PersonRepositoryError("Transcript does not contain the trusted Identity required by this link");
      }
      persistEvidence(accountId, input.evidence, now);
      const conflict = database.prepare(`
        SELECT person_id FROM person_identity_links
        WHERE account_id = ? AND identity_id = ? AND status = 'confirmed' AND id <> ?
      `).get(accountId, link.identity_id, linkId) as { person_id: string } | undefined;
      if (conflict) {
        throw new PersonRepositoryError("Identity is already confirmed for another Person in this account");
      }
      database.prepare(`
        UPDATE person_identity_links
        SET evidence_id = ?, status = 'confirmed', confirmed_at = ?, updated_at = ?
        WHERE id = ? AND account_id = ?
      `).run(input.evidence.id, now, now, linkId, accountId);
      return identityLinkFromRow(
        database.prepare("SELECT * FROM person_identity_links WHERE id = ?").get(linkId) as PersonIdentityLinkRow
      );
    })();
  }

  function insertSubjectObservation(input: {
    accountId: string;
    personId: string | null;
    status: "candidate" | "confirmed" | "unknown";
    source: "manual_review" | "confirmed_identity" | "unknown";
    reason: string;
    evidence: ValidatedPersonTranscriptEvidence;
    now: string;
  }) {
    const reason = input.reason.normalize("NFKC").trim();
    if (!reason || reason.length > 1_000) {
      throw new PersonRepositoryError("Invalid Subject observation reason");
    }
    persistEvidence(input.accountId, input.evidence, input.now);
    if (input.personId) {
      requirePerson(input.accountId, input.personId);
    }
    const id = stableId(
      "person_subject_observation",
      input.accountId,
      input.personId ?? "unknown",
      input.evidence.id,
      input.status
    );
    try {
      database.prepare(`
        INSERT INTO person_subject_observations (
          id, account_id, person_id, evidence_id, status, source, reason,
          confirmed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET reason = excluded.reason, updated_at = excluded.updated_at
      `).run(
        id,
        input.accountId,
        input.personId,
        input.evidence.id,
        input.status,
        input.source,
        reason,
        input.status === "confirmed" ? input.now : null,
        input.now,
        input.now
      );
    } catch (error) {
      throw new PersonRepositoryError(
        error instanceof Error && error.message.includes("idx_person_subject_observations_confirmed_evidence")
          ? "Transcript evidence already has a different confirmed Subject"
          : "Subject observation violates Person evidence constraints"
      );
    }
    return subjectObservationFromRow(
      database.prepare("SELECT * FROM person_subject_observations WHERE id = ?").get(id) as PersonSubjectObservationRow
    );
  }

  function recordUnknownSubject(input: {
    accountId: string;
    reason: string;
    evidence: ValidatedPersonTranscriptEvidence;
    now?: string;
  }) {
    const accountId = assertIdentifier(input.accountId, "account id");
    assertEvidenceAccount(input.evidence, accountId);
    return database.transaction(() => insertSubjectObservation({
      accountId,
      personId: null,
      status: "unknown",
      source: "unknown",
      reason: input.reason,
      evidence: input.evidence,
      now: input.now ?? new Date().toISOString()
    }))();
  }

  function recordCandidateSubject(input: {
    accountId: string;
    personId: string;
    reason: string;
    evidence: ValidatedPersonTranscriptEvidence;
    now?: string;
  }) {
    const accountId = assertIdentifier(input.accountId, "account id");
    const personId = assertIdentifier(input.personId, "person id");
    assertEvidenceAccount(input.evidence, accountId);
    return database.transaction(() => {
      const person = requirePerson(accountId, personId);
      if (person.status === "archived") {
        throw new PersonRepositoryError("Archived Person cannot receive Subject observations");
      }
      return insertSubjectObservation({
        accountId,
        personId,
        status: "candidate",
        source: "manual_review",
        reason: input.reason,
        evidence: input.evidence,
        now: input.now ?? new Date().toISOString()
      });
    })();
  }

  function recordConfirmedSubject(input: {
    accountId: string;
    personId: string;
    identityId: string;
    reason: string;
    evidence: ValidatedPersonTranscriptEvidence;
    now?: string;
  }) {
    const accountId = assertIdentifier(input.accountId, "account id");
    const personId = assertIdentifier(input.personId, "person id");
    const identityId = assertIdentifier(input.identityId, "identity id");
    const now = input.now ?? new Date().toISOString();
    assertEvidenceAccount(input.evidence, accountId);
    return database.transaction(() => {
      const person = requirePerson(accountId, personId);
      if (person.status !== "confirmed") {
        throw new PersonRepositoryError("Confirmed Subject requires a confirmed Person");
      }
      const trustedIdentity = trustedTranscriptSpeakerIdentity(input.evidence.segment);
      if (
        !trustedIdentity ||
        trustedIdentity.globalSpeakerId !== identityId ||
        isChunkLocalSpeakerLabel(identityId)
      ) {
        throw new PersonRepositoryError("Confirmed Subject requires a matching trusted Transcript Identity");
      }
      const link = database.prepare(`
        SELECT 1 FROM person_identity_links
        WHERE account_id = ? AND person_id = ? AND identity_id = ? AND status = 'confirmed'
      `).get(accountId, personId, identityId);
      if (!link) {
        throw new PersonRepositoryError("Confirmed Subject requires a confirmed Person-to-Identity link");
      }
      const existingSubjects = database.prepare(`
        SELECT DISTINCT person_id
        FROM person_subject_observations
        WHERE account_id = ? AND evidence_id = ? AND status = 'confirmed'
      `).all(accountId, input.evidence.id) as Array<{ person_id: string }>;
      if (existingSubjects.some((subject) => subject.person_id !== personId)) {
        throw new PersonRepositoryError(
          "Transcript evidence already has a different confirmed Subject"
        );
      }
      return insertSubjectObservation({
        accountId,
        personId,
        status: "confirmed",
        source: "confirmed_identity",
        reason: input.reason,
        evidence: input.evidence,
        now
      });
    })();
  }

  function getConfirmedSubjectPersonId(input: {
    accountId: string;
    uploadId: string;
    sourceSegmentId: string;
  }) {
    const accountId = assertIdentifier(input.accountId, "account id");
    const uploadId = assertIdentifier(input.uploadId, "upload id");
    const sourceSegmentId = assertIdentifier(input.sourceSegmentId, "source segment id");
    const rows = database.prepare(`
      SELECT DISTINCT observation.person_id AS person_id
      FROM person_subject_observations observation
      INNER JOIN person_evidence evidence
        ON evidence.id = observation.evidence_id AND evidence.account_id = observation.account_id
      INNER JOIN person_entities person
        ON person.id = observation.person_id AND person.account_id = observation.account_id
      WHERE observation.account_id = ?
        AND evidence.upload_id = ?
        AND evidence.source_segment_id = ?
        AND observation.status = 'confirmed'
        AND person.status = 'confirmed'
      ORDER BY observation.person_id
    `).all(accountId, uploadId, sourceSegmentId) as Array<{ person_id: string }>;
    return rows.length === 1 ? rows[0].person_id : null;
  }

  function getConfirmedSubjectPersonIds(input: {
    accountId: string;
    uploadId: string;
    sourceSegmentId: string;
  }) {
    const accountId = assertIdentifier(input.accountId, "account id");
    const uploadId = assertIdentifier(input.uploadId, "upload id");
    const sourceSegmentId = assertIdentifier(input.sourceSegmentId, "source segment id");
    return (database.prepare(`
      SELECT DISTINCT observation.person_id AS person_id
      FROM person_subject_observations observation
      INNER JOIN person_evidence evidence
        ON evidence.id = observation.evidence_id AND evidence.account_id = observation.account_id
      INNER JOIN person_entities person
        ON person.id = observation.person_id AND person.account_id = observation.account_id
      WHERE observation.account_id = ?
        AND evidence.upload_id = ?
        AND evidence.source_segment_id = ?
        AND observation.status = 'confirmed'
        AND person.status = 'confirmed'
      ORDER BY observation.person_id
    `).all(accountId, uploadId, sourceSegmentId) as Array<{ person_id: string }>)
      .map((row) => row.person_id);
  }

  function listSubjectObservations(accountIdInput: string) {
    const accountId = assertIdentifier(accountIdInput, "account id");
    const rows = database.prepare(`
      SELECT * FROM person_subject_observations
      WHERE account_id = ?
      ORDER BY created_at, id
    `).all(accountId) as PersonSubjectObservationRow[];
    return rows.map(subjectObservationFromRow);
  }

  function listIdentityLinks(accountIdInput: string) {
    const accountId = assertIdentifier(accountIdInput, "account id");
    const rows = database.prepare(`
      SELECT * FROM person_identity_links
      WHERE account_id = ?
      ORDER BY created_at, id
    `).all(accountId) as PersonIdentityLinkRow[];
    return rows.map(identityLinkFromRow);
  }

  function deleteByUpload(accountIdInput: string, uploadIdInput: string, now?: string) {
    const accountId = assertIdentifier(accountIdInput, "account id");
    const uploadId = assertIdentifier(uploadIdInput, "upload id");
    return database.transaction(() => deletePersonEvidenceByUpload(database, { accountId, uploadId, now }))();
  }

  return {
    createCandidate,
    createAliasCandidate,
    confirmPerson,
    confirmName,
    getPersonForReview,
    getConfirmedPerson,
    listPersonsForReview,
    listConfirmedPersons,
    createIdentityLinkCandidate,
    confirmIdentityLink,
    recordUnknownSubject,
    recordCandidateSubject,
    recordConfirmedSubject,
    getConfirmedSubjectPersonId,
    getConfirmedSubjectPersonIds,
    listSubjectObservations,
    listIdentityLinks,
    deleteByUpload
  };
}

export type PersonRepository = ReturnType<typeof createPersonRepository>;
