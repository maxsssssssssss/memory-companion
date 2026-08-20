import type Database from "better-sqlite3";

import {
  DateCompanionPersonSourceCatalogSchema,
  type DateCompanionPersonSourceCatalog,
  type DateCompanionRelationshipPersonSource
} from "@/lib/domain/date-companion-person-source";
import { getMemoryDatabase } from "@/lib/server/memory/db";
import {
  personQaEvidenceKey,
  resolveTrustedPersonQaEvidence
} from "@/lib/server/person/person-relationship-qa-evidence-resolver";
import type { PersonEvidence } from "@/lib/server/person/types";

import { getDateCompanionDatabase } from "./db";
import { DcNotFoundError } from "./errors";

type RelationshipRow = {
  status: string;
};

type MappingRow = {
  self_person_id: string;
  companion_person_id: string;
  relationship_type: string;
  status: string;
  version: number;
  confirmed_at: string | null;
};

type RelationshipLinkRow = {
  mapping_version: number;
  self_person_id: string;
  companion_person_id: string;
  relationship_type: string;
  status: string;
  person_relationship_status: string;
  explicitly_confirmed: number;
  confirmed_at: string | null;
  person_a_id: string;
  person_b_id: string;
};

type PersonStateRow = {
  id: string;
  status: string;
};

type SelfBindingRow = {
  person_id: string | null;
  status: string;
};

type CandidateLinkRow = PersonEvidence & {
  evidenceSnapshotId: string;
  interactionId: string;
};

type SnapshotPresentationRow = {
  evidence_snapshot_id: string;
  interaction_id: string;
  upload_id: string;
  source_segment_id: string;
  recording_date: string;
  start_seconds: number;
  end_seconds: number;
  speaker_id: string | null;
  quote: string;
  content_digest: string | null;
  subject: "companion" | "both" | "self" | "unknown";
};

function emptyCatalog(input: {
  relationshipId: string;
  mapping?: MappingRow | null;
  status: "needs_review" | "unavailable";
}): DateCompanionPersonSourceCatalog {
  return DateCompanionPersonSourceCatalogSchema.parse({
    relationshipId: input.relationshipId,
    companionPersonId: input.mapping?.companion_person_id ?? null,
    mappingVersion: input.mapping?.version ?? null,
    status: input.status,
    sources: []
  });
}

function mappingIsCurrent(input: {
  mapping: MappingRow;
  relationshipLink: RelationshipLinkRow;
  people: PersonStateRow[];
  selfBinding: SelfBindingRow | undefined;
}) {
  const peopleById = new Map(input.people.map((person) => [person.id, person.status]));
  const expectedEndpoints = [
    input.mapping.self_person_id,
    input.mapping.companion_person_id
  ].sort();
  const actualEndpoints = [
    input.relationshipLink.person_a_id,
    input.relationshipLink.person_b_id
  ].sort();
  return input.mapping.status === "confirmed"
    && Boolean(input.mapping.confirmed_at)
    && input.mapping.self_person_id !== input.mapping.companion_person_id
    && peopleById.get(input.mapping.self_person_id) === "confirmed"
    && peopleById.get(input.mapping.companion_person_id) === "confirmed"
    && input.selfBinding?.status === "active"
    && input.selfBinding.person_id === input.mapping.self_person_id
    && input.relationshipLink.status === "active"
    && input.relationshipLink.person_relationship_status === "confirmed"
    && input.relationshipLink.explicitly_confirmed === 1
    && Boolean(input.relationshipLink.confirmed_at)
    && input.relationshipLink.mapping_version === input.mapping.version
    && input.relationshipLink.self_person_id === input.mapping.self_person_id
    && input.relationshipLink.companion_person_id === input.mapping.companion_person_id
    && input.relationshipLink.relationship_type === input.mapping.relationship_type
    && expectedEndpoints[0] === actualEndpoints[0]
    && expectedEndpoints[1] === actualEndpoints[1];
}

function candidateEvidenceRows(input: {
  memoryDatabase: Database.Database;
  accountId: string;
  relationshipId: string;
}) {
  return input.memoryDatabase.prepare(`
    SELECT e.id, e.account_id AS accountId, e.upload_id AS uploadId,
           e.source_segment_id AS sourceSegmentId, e.quote,
           e.created_at AS createdAt, e.updated_at AS updatedAt,
           l.dc_evidence_snapshot_id AS evidenceSnapshotId,
           l.dc_interaction_id AS interactionId
    FROM person_evidence_dc_links l
    INNER JOIN person_evidence e
      ON e.id = l.person_evidence_id AND e.account_id = l.account_id
    WHERE l.account_id = ? AND l.dc_relationship_id = ?
    ORDER BY e.upload_id, e.source_segment_id,
             l.dc_evidence_snapshot_id, l.dc_interaction_id
  `).all(input.accountId, input.relationshipId) as CandidateLinkRow[];
}

function presentationRow(input: {
  dateCompanionDatabase: Database.Database;
  accountId: string;
  relationshipId: string;
  evidenceSnapshotId: string;
}) {
  return input.dateCompanionDatabase.prepare(`
    SELECT e.id AS evidence_snapshot_id, i.id AS interaction_id,
           e.upload_id, e.source_segment_id, i.recording_date,
           e.start_seconds, e.end_seconds, e.speaker_id, e.quote,
           e.content_digest,
           s.subject
    FROM dc_evidence_snapshots e
    INNER JOIN dc_recap_items r
      ON r.id = e.recap_item_id AND r.user_id = e.user_id
    INNER JOIN dc_interactions i
      ON i.id = r.interaction_id AND i.user_id = r.user_id
    INNER JOIN dc_memory_subject_selections s
      ON s.evidence_snapshot_id = e.id AND s.user_id = e.user_id
    WHERE e.id = ? AND e.user_id = ? AND i.relationship_id = ?
  `).get(
    input.evidenceSnapshotId,
    input.accountId,
    input.relationshipId
  ) as SnapshotPresentationRow | undefined;
}

function sameTrustedSegment(
  row: SnapshotPresentationRow,
  segment: ReturnType<typeof resolveTrustedPersonQaEvidence>["segments"][number]
) {
  return row.upload_id === segment.uploadId
    && row.source_segment_id === segment.id
    && row.start_seconds === segment.startSeconds
    && row.end_seconds === segment.endSeconds
    && (row.speaker_id ?? undefined) === segment.speaker
    && row.quote.trim() === segment.text;
}

/**
 * Relationship-only, read-only projection over the Phase 5A trusted snapshot
 * resolver. No Person, Subject, Memory, Fact, or Relationship state is created.
 */
export function resolveDateCompanionPersonSourceCatalog(input: {
  memoryDatabase: Database.Database;
  dateCompanionDatabase: Database.Database;
  accountId: string;
  relationshipId: string;
}): DateCompanionPersonSourceCatalog {
  const relationship = input.dateCompanionDatabase.prepare(`
    SELECT status FROM dc_relationships WHERE id = ? AND user_id = ?
  `).get(input.relationshipId, input.accountId) as RelationshipRow | undefined;
  if (!relationship) throw new DcNotFoundError("Relationship not found");

  const mapping = input.dateCompanionDatabase.prepare(`
    SELECT self_person_id, companion_person_id, relationship_type,
           status, version, confirmed_at
    FROM dc_relationship_person_mappings
    WHERE user_id = ? AND relationship_id = ?
  `).get(input.accountId, input.relationshipId) as MappingRow | undefined;
  if (relationship.status !== "active" || mapping?.status === "archived") {
    return emptyCatalog({ relationshipId: input.relationshipId, mapping, status: "unavailable" });
  }
  if (!mapping) {
    return emptyCatalog({ relationshipId: input.relationshipId, status: "unavailable" });
  }
  if (mapping.status !== "confirmed" || !mapping.confirmed_at) {
    return emptyCatalog({ relationshipId: input.relationshipId, mapping, status: "needs_review" });
  }

  try {
    const relationshipLink = input.memoryDatabase.prepare(`
      SELECT l.mapping_version, l.self_person_id, l.companion_person_id,
             l.relationship_type, l.status,
             r.status AS person_relationship_status, r.explicitly_confirmed,
             r.confirmed_at, r.person_a_id, r.person_b_id
      FROM dc_person_relationship_links l
      INNER JOIN person_relationships r
        ON r.id = l.person_relationship_id AND r.account_id = l.account_id
      WHERE l.account_id = ? AND l.dc_relationship_id = ?
    `).get(input.accountId, input.relationshipId) as RelationshipLinkRow | undefined;
    if (!relationshipLink) {
      return emptyCatalog({ relationshipId: input.relationshipId, mapping, status: "unavailable" });
    }
    const people = input.memoryDatabase.prepare(`
      SELECT id, status FROM person_entities
      WHERE account_id = ? AND id IN (?, ?)
      ORDER BY id
    `).all(
      input.accountId,
      mapping.self_person_id,
      mapping.companion_person_id
    ) as PersonStateRow[];
    const selfBinding = input.memoryDatabase.prepare(`
      SELECT person_id, status FROM person_self_bindings WHERE account_id = ?
    `).get(input.accountId) as SelfBindingRow | undefined;
    if (!mappingIsCurrent({ mapping, relationshipLink, people, selfBinding })) {
      return emptyCatalog({ relationshipId: input.relationshipId, mapping, status: "needs_review" });
    }

    const candidateLinks = candidateEvidenceRows(input);
    const evidenceById = new Map<string, PersonEvidence>();
    for (const candidate of candidateLinks) {
      evidenceById.set(candidate.id, {
        id: candidate.id,
        accountId: candidate.accountId,
        uploadId: candidate.uploadId,
        sourceSegmentId: candidate.sourceSegmentId,
        quote: candidate.quote,
        createdAt: candidate.createdAt,
        updatedAt: candidate.updatedAt
      });
    }
    const resolution = resolveTrustedPersonQaEvidence({
      memoryDatabase: input.memoryDatabase,
      dateCompanionDatabase: input.dateCompanionDatabase,
      accountId: input.accountId,
      personId: mapping.companion_person_id,
      evidence: [...evidenceById.values()]
    });
    if (resolution.activeSelfPersonId !== mapping.self_person_id) {
      return emptyCatalog({ relationshipId: input.relationshipId, mapping, status: "needs_review" });
    }

    const linksByEvidenceKey = new Map<string, CandidateLinkRow[]>();
    for (const candidate of candidateLinks) {
      const key = personQaEvidenceKey(candidate.uploadId, candidate.sourceSegmentId);
      const links = linksByEvidenceKey.get(key) ?? [];
      links.push(candidate);
      linksByEvidenceKey.set(key, links);
    }
    const conflicts = new Set(resolution.conflictingEvidenceKeys);
    const sources = new Map<string, DateCompanionRelationshipPersonSource>();
    for (const segment of resolution.segments) {
      const key = personQaEvidenceKey(segment.uploadId, segment.id);
      if (conflicts.has(key) || sources.has(key)) continue;
      const candidate = linksByEvidenceKey.get(key)?.[0];
      if (!candidate) continue;
      const row = presentationRow({
        dateCompanionDatabase: input.dateCompanionDatabase,
        accountId: input.accountId,
        relationshipId: input.relationshipId,
        evidenceSnapshotId: candidate.evidenceSnapshotId
      });
      if (
        !row
        || !["companion", "both"].includes(row.subject)
        || !sameTrustedSegment(row, segment)
      ) continue;
      sources.set(key, {
        evidenceSnapshotId: row.evidence_snapshot_id,
        interactionId: row.interaction_id,
        uploadId: row.upload_id,
        sourceSegmentId: row.source_segment_id,
        recordingDate: row.recording_date,
        startSeconds: row.start_seconds,
        endSeconds: row.end_seconds,
        ...(row.speaker_id ? { speakerId: row.speaker_id } : {}),
        quote: row.quote,
        ...(row.content_digest ? { contentDigest: row.content_digest } : {}),
        subject: row.subject as "companion" | "both"
      });
    }

    const currentMapping = input.dateCompanionDatabase.prepare(`
      SELECT self_person_id, companion_person_id, relationship_type,
             status, version, confirmed_at
      FROM dc_relationship_person_mappings
      WHERE user_id = ? AND relationship_id = ?
    `).get(input.accountId, input.relationshipId) as MappingRow | undefined;
    if (
      !currentMapping
      || currentMapping.status !== "confirmed"
      || currentMapping.version !== mapping.version
      || currentMapping.self_person_id !== mapping.self_person_id
      || currentMapping.companion_person_id !== mapping.companion_person_id
      || currentMapping.relationship_type !== mapping.relationship_type
    ) {
      return emptyCatalog({
        relationshipId: input.relationshipId,
        mapping: currentMapping ?? mapping,
        status: "needs_review"
      });
    }

    return DateCompanionPersonSourceCatalogSchema.parse({
      relationshipId: input.relationshipId,
      companionPersonId: mapping.companion_person_id,
      mappingVersion: mapping.version,
      status: "ready",
      sources: [...sources.values()].sort((left, right) =>
        left.recordingDate.localeCompare(right.recordingDate)
        || left.startSeconds - right.startSeconds
        || left.endSeconds - right.endSeconds
        || left.uploadId.localeCompare(right.uploadId)
        || left.sourceSegmentId.localeCompare(right.sourceSegmentId)
        || left.evidenceSnapshotId.localeCompare(right.evidenceSnapshotId)
      )
    });
  } catch {
    return emptyCatalog({ relationshipId: input.relationshipId, mapping, status: "unavailable" });
  }
}

export function resolveProductionDateCompanionPersonSourceCatalog(input: {
  accountId: string;
  relationshipId: string;
}) {
  return resolveDateCompanionPersonSourceCatalog({
    dateCompanionDatabase: getDateCompanionDatabase(),
    memoryDatabase: getMemoryDatabase(),
    ...input
  });
}
