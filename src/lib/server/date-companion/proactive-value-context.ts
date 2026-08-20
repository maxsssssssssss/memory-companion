import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

import {
  DateCompanionProactiveValueContextSchema,
  type DateCompanionProactiveEvidence,
  type DateCompanionProactiveValueContext
} from "@/lib/domain/date-companion-proactive-value";
import { resolveMemoryRetrievalSource } from "@/lib/server/retrieval/source-awareness";
import { createPersonMemoryRepository } from "@/lib/server/person/memory-repository";
import type { MemoryItem } from "@/lib/server/memory/types";

import {
  DC_EVIDENCE_PROVENANCE_VERSION,
  DC_EVIDENCE_SOURCE_KIND,
  dateCompanionEvidenceDigest,
  stableBridgeDigest
} from "./memory-bridge-digest";
import {
  resolveDateCompanionPersonSourceCatalog,
  type resolveProductionDateCompanionPersonSourceCatalog
} from "./person-source-catalog";
import { DcNotFoundError } from "./errors";

type ContextResolution =
  | { status: "ready"; context: DateCompanionProactiveValueContext }
  | { status: "needs_review" | "unavailable"; context: null };

type InteractionRow = {
  relationship_id: string;
  source_upload_id: string;
  recording_date: string;
  status: string;
  source_state: string;
  version: number;
  confirmed_at: string | null;
  confirmation_fingerprint: string | null;
  relationship_status: string;
};

type OutboxRow = {
  payload_digest: string;
  payload_json: string;
  mapping_version: number | null;
  source_version: number;
  confirmation_fingerprint: string;
  status: string;
};

type MappingRow = {
  self_person_id: string;
  companion_person_id: string;
  status: string;
  version: number;
  confirmed_at: string | null;
};

type SnapshotRow = {
  id: string;
  upload_id: string;
  source_segment_id: string;
  start_seconds: number;
  end_seconds: number;
  speaker_id: string | null;
  quote: string;
  provenance_version: number;
  source_kind: string;
  content_digest: string | null;
  disposition: string;
  subject: string | null;
  selection_version: number | null;
  participant_role: string | null;
  participant_confirmed_by: string | null;
  participant_confirmed_at: string | null;
};

type ReflectionProvenanceRow = {
  content_digest: string;
  candidate_id: string;
  publication_status: string;
  receipt_status: string;
  current_status: string;
  person_source_status: string;
  revocation_id: string | null;
};

type MappingStateRow = MappingRow & {
  self_status: string | null;
  companion_status: string | null;
  self_binding_person_id: string | null;
  self_binding_status: string | null;
};

function normalizedText(value: string) {
  return value.normalize("NFKC").replace(/\r\n?/gu, "\n").replace(/\s+/gu, " ").trim();
}

function validSha256(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function mappingState(input: {
  dateCompanionDatabase: Database.Database;
  memoryDatabase: Database.Database;
  accountId: string;
  relationshipId: string;
}) {
  const mapping = input.dateCompanionDatabase.prepare(`
    SELECT self_person_id, companion_person_id, status, version, confirmed_at
    FROM dc_relationship_person_mappings
    WHERE user_id = ? AND relationship_id = ?
  `).get(input.accountId, input.relationshipId) as MappingRow | undefined;
  if (!mapping) return null;
  const people = input.memoryDatabase.prepare(`
    SELECT
      MAX(CASE WHEN id = ? THEN status END) AS self_status,
      MAX(CASE WHEN id = ? THEN status END) AS companion_status
    FROM person_entities
    WHERE account_id = ? AND id IN (?, ?)
  `).get(
    mapping.self_person_id,
    mapping.companion_person_id,
    input.accountId,
    mapping.self_person_id,
    mapping.companion_person_id
  ) as { self_status: string | null; companion_status: string | null };
  const selfBinding = input.memoryDatabase.prepare(`
    SELECT person_id, status FROM person_self_bindings WHERE account_id = ?
  `).get(input.accountId) as { person_id: string | null; status: string | null } | undefined;
  return {
    ...mapping,
    self_status: people.self_status,
    companion_status: people.companion_status,
    self_binding_person_id: selfBinding?.person_id ?? null,
    self_binding_status: selfBinding?.status ?? null
  } satisfies MappingStateRow;
}

function mappingIsTrusted(mapping: MappingStateRow | null) {
  return Boolean(
    mapping
    && mapping.status === "confirmed"
    && mapping.confirmed_at
    && mapping.self_person_id !== mapping.companion_person_id
    && mapping.self_status === "confirmed"
    && mapping.companion_status === "confirmed"
    && mapping.self_binding_status === "active"
    && mapping.self_binding_person_id === mapping.self_person_id
  );
}

function evidenceSort(left: DateCompanionProactiveEvidence, right: DateCompanionProactiveEvidence) {
  return left.recordingDate.localeCompare(right.recordingDate)
    || (left.startSeconds ?? 0) - (right.startSeconds ?? 0)
    || left.uploadId.localeCompare(right.uploadId)
    || left.sourceSegmentId.localeCompare(right.sourceSegmentId)
    || left.evidenceId.localeCompare(right.evidenceId);
}

function sourceKey(uploadId: string, sourceSegmentId: string) {
  return `${uploadId}\u0000${sourceSegmentId}`;
}

function currentSnapshotSignature(row: SnapshotRow) {
  return JSON.stringify([
    row.upload_id,
    row.source_segment_id,
    row.start_seconds,
    row.end_seconds,
    row.speaker_id,
    normalizedText(row.quote),
    row.content_digest,
    row.subject,
    row.selection_version,
    row.participant_role,
    row.participant_confirmed_at
  ]);
}

function personRelationshipEvidenceSignature(evidence: DateCompanionProactiveEvidence) {
  return JSON.stringify([
    evidence.uploadId,
    evidence.sourceSegmentId,
    evidence.recordingDate,
    evidence.startSeconds ?? null,
    evidence.endSeconds ?? null,
    evidence.speakerId ?? null,
    normalizedText(evidence.quote),
    evidence.contentDigest,
    evidence.origin,
    evidence.subject,
    evidence.subjectVersion ?? null
  ]);
}

export function buildCurrentInteractionProactiveValueContext(input: {
  dateCompanionDatabase: Database.Database;
  memoryDatabase: Database.Database;
  accountId: string;
  interactionId: string;
}): ContextResolution {
  const interaction = input.dateCompanionDatabase.prepare(`
    SELECT i.relationship_id, i.source_upload_id, i.recording_date, i.status, i.source_state,
           i.version, i.confirmed_at, i.confirmation_fingerprint,
           relationship.status AS relationship_status
    FROM dc_interactions i
    INNER JOIN dc_relationships relationship
      ON relationship.id = i.relationship_id AND relationship.user_id = i.user_id
    WHERE i.user_id = ? AND i.id = ?
  `).get(input.accountId, input.interactionId) as InteractionRow | undefined;
  if (!interaction) throw new DcNotFoundError("Interaction not found");
  if (
    interaction.status !== "confirmed"
    || !interaction.confirmed_at
    || interaction.source_state === "explicitly_deleted"
    || interaction.relationship_status !== "active"
    || !validSha256(interaction.confirmation_fingerprint)
  ) {
    return { status: "unavailable", context: null };
  }
  const mapping = mappingState({
    dateCompanionDatabase: input.dateCompanionDatabase,
    memoryDatabase: input.memoryDatabase,
    accountId: input.accountId,
    relationshipId: interaction.relationship_id
  });
  if (!mappingIsTrusted(mapping)) return { status: "needs_review", context: null };
  const outbox = input.dateCompanionDatabase.prepare(`
    SELECT payload_digest, payload_json, mapping_version, source_version,
           confirmation_fingerprint, status
    FROM dc_memory_bridge_outbox
    WHERE user_id = ? AND interaction_id = ?
  `).get(input.accountId, input.interactionId) as OutboxRow | undefined;
  let outboxSelections = new Map<string, { subject: string; contentDigest: string }>();
  try {
    const payload = outbox ? JSON.parse(outbox.payload_json) as Record<string, unknown> : null;
    const payloadMapping = payload?.mapping as Record<string, unknown> | null | undefined;
    if (
      !outbox
      || !["pending", "processing", "completed", "retryable_failed"].includes(outbox.status)
      || outbox.mapping_version !== mapping!.version
      || outbox.source_version !== interaction.version
      || outbox.confirmation_fingerprint !== interaction.confirmation_fingerprint
      || stableBridgeDigest(payload) !== outbox.payload_digest
      || payload?.userId !== input.accountId
      || payload?.relationshipId !== interaction.relationship_id
      || payload?.interactionId !== input.interactionId
      || payload?.sourceUploadId !== interaction.source_upload_id
      || payloadMapping?.version !== mapping!.version
      || payloadMapping?.selfPersonId !== mapping!.self_person_id
      || payloadMapping?.companionPersonId !== mapping!.companion_person_id
      || !Array.isArray(payload?.selections)
    ) return { status: "needs_review", context: null };
    outboxSelections = new Map((payload.selections as unknown[]).flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const selection = item as Record<string, unknown>;
      return typeof selection.evidenceSnapshotId === "string"
        && typeof selection.subject === "string"
        && typeof selection.contentDigest === "string"
        ? [[selection.evidenceSnapshotId, {
            subject: selection.subject,
            contentDigest: selection.contentDigest
          }] as const]
        : [];
    }));
  } catch {
    return { status: "needs_review", context: null };
  }

  const rows = input.dateCompanionDatabase.prepare(`
    SELECT evidence.id, evidence.upload_id, evidence.source_segment_id,
           evidence.start_seconds, evidence.end_seconds, evidence.speaker_id,
           evidence.quote, evidence.provenance_version, evidence.source_kind,
           evidence.content_digest, recap.disposition,
           selection.subject, selection.version AS selection_version,
           participant.role AS participant_role,
           participant.confirmed_by AS participant_confirmed_by,
           participant.confirmed_at AS participant_confirmed_at
    FROM dc_evidence_snapshots evidence
    INNER JOIN dc_recap_items recap
      ON recap.id = evidence.recap_item_id AND recap.user_id = evidence.user_id
    LEFT JOIN dc_memory_subject_selections selection
      ON selection.evidence_snapshot_id = evidence.id
      AND selection.interaction_id = recap.interaction_id
      AND selection.user_id = evidence.user_id
    LEFT JOIN dc_participant_assignments participant
      ON participant.interaction_id = recap.interaction_id
      AND participant.speaker_id = evidence.speaker_id
      AND participant.user_id = evidence.user_id
    WHERE evidence.user_id = ? AND recap.interaction_id = ?
    ORDER BY evidence.upload_id, evidence.source_segment_id, evidence.id
  `).all(input.accountId, input.interactionId) as SnapshotRow[];

  const signatures = new Map<string, string>();
  const evidence = new Map<string, DateCompanionProactiveEvidence>();
  for (const row of rows) {
    // A canonical source can appear in several recap items. Only the user's
    // final kept set may participate in conflict detection; excluded/pending
    // copies must not make an otherwise valid kept source unavailable.
    if (row.disposition !== "kept") continue;
    const key = sourceKey(row.upload_id, row.source_segment_id);
    const signature = currentSnapshotSignature(row);
    const previousSignature = signatures.get(key);
    if (previousSignature && previousSignature !== signature) {
      return { status: "unavailable", context: null };
    }
    signatures.set(key, signature);
    const frozenSelection = outboxSelections.get(row.id);
    if (
      !["self", "companion", "both"].includes(row.subject ?? "")
      || !row.selection_version
      || !["self", "companion"].includes(row.participant_role ?? "")
      || !row.participant_confirmed_by
      || !row.participant_confirmed_at
      || row.provenance_version !== DC_EVIDENCE_PROVENANCE_VERSION
      || row.source_kind !== DC_EVIDENCE_SOURCE_KIND
      || !validSha256(row.content_digest)
      || row.content_digest !== dateCompanionEvidenceDigest({
        userId: input.accountId,
        uploadId: row.upload_id,
        sourceSegmentId: row.source_segment_id,
        startSeconds: row.start_seconds,
        endSeconds: row.end_seconds,
        speakerId: row.speaker_id,
        quote: row.quote
      })
      || frozenSelection?.subject !== row.subject
      || frozenSelection?.contentDigest !== row.content_digest
    ) continue;
    evidence.set(key, {
      evidenceId: `dc_snapshot:${row.id}`,
      uploadId: row.upload_id,
      sourceSegmentId: row.source_segment_id,
      recordingDate: interaction.recording_date,
      startSeconds: row.start_seconds,
      endSeconds: row.end_seconds,
      ...(row.speaker_id ? { speakerId: row.speaker_id } : {}),
      quote: row.quote,
      contentDigest: row.content_digest,
      origin: "direct_conversation",
      subject: row.subject as "self" | "companion" | "both",
      subjectVersion: row.selection_version
    });
  }
  if (evidence.size === 0) return { status: "unavailable", context: null };
  return {
    status: "ready",
    context: DateCompanionProactiveValueContextSchema.parse({
      schemaVersion: 1,
      scope: "current_interaction",
      relationshipId: interaction.relationship_id,
      interactionId: input.interactionId,
      mappingVersion: mapping!.version,
      interactionVersion: interaction.version,
      confirmationFingerprint: interaction.confirmation_fingerprint,
      evidence: [...evidence.values()].sort(evidenceSort).slice(0, 24)
    })
  };
}

function reflectionProvenance(input: {
  database: Database.Database;
  accountId: string;
  personId: string;
  memoryEvidenceId: string;
  personEvidenceId: string;
}) {
  const rows = input.database.prepare(`
    SELECT provenance.content_digest, provenance.candidate_id,
           publication.status AS publication_status,
           receipt.status AS receipt_status,
           current_memory.status AS current_status,
           person_source.status AS person_source_status,
           revocation.id AS revocation_id
    FROM memory_daily_reflection_evidence_provenance provenance
    INNER JOIN memory_daily_reflection_publications publication
      ON publication.id = provenance.publication_id
      AND publication.user_id = provenance.user_id
    INNER JOIN memory_daily_reflection_candidate_receipts receipt
      ON receipt.user_id = provenance.user_id
      AND receipt.publication_id = provenance.publication_id
      AND receipt.candidate_id = provenance.candidate_id
    INNER JOIN memory_daily_reflection_candidate_current_memories current_memory
      ON current_memory.user_id = provenance.user_id
      AND current_memory.publication_id = provenance.publication_id
      AND current_memory.candidate_id = provenance.candidate_id
      AND current_memory.current_memory_id = (
        SELECT memory_id FROM memory_evidence WHERE id = provenance.memory_evidence_id
      )
    INNER JOIN memory_daily_reflection_candidate_person_sources person_source
      ON person_source.user_id = provenance.user_id
      AND person_source.publication_id = provenance.publication_id
      AND person_source.candidate_id = provenance.candidate_id
      AND person_source.person_id = ?
      AND person_source.person_evidence_id = ?
    LEFT JOIN memory_daily_reflection_candidate_revocations revocation
      ON revocation.user_id = provenance.user_id
      AND revocation.publication_id = provenance.publication_id
      AND revocation.candidate_id = provenance.candidate_id
    WHERE provenance.user_id = ? AND provenance.memory_evidence_id = ?
  `).all(
    input.personId,
    input.personEvidenceId,
    input.accountId,
    input.memoryEvidenceId
  ) as ReflectionProvenanceRow[];
  return rows.length === 1 ? rows[0] : null;
}

function fallbackDigest(input: {
  accountId: string;
  uploadId: string;
  sourceSegmentId: string;
  quote: string;
  origin: string;
}) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function buildPersonRelationshipProactiveValueContext(input: {
  dateCompanionDatabase: Database.Database;
  memoryDatabase: Database.Database;
  accountId: string;
  relationshipId: string;
  resolveCatalog?: typeof resolveProductionDateCompanionPersonSourceCatalog;
  resolveMemorySource?: (input: { accountId: string; memory: MemoryItem }) => {
    eligible: boolean;
    origin: "direct_conversation" | "user_reflection" | "unknown";
  };
}): ContextResolution {
  const catalog = input.resolveCatalog
    ? input.resolveCatalog({ accountId: input.accountId, relationshipId: input.relationshipId })
    : resolveDateCompanionPersonSourceCatalog({
        dateCompanionDatabase: input.dateCompanionDatabase,
        memoryDatabase: input.memoryDatabase,
        accountId: input.accountId,
        relationshipId: input.relationshipId
      });
  if (catalog.status !== "ready" || !catalog.companionPersonId || !catalog.mappingVersion) {
    return {
      status: catalog.status === "needs_review" ? "needs_review" : "unavailable",
      context: null
    };
  }
  const mapping = mappingState({
    dateCompanionDatabase: input.dateCompanionDatabase,
    memoryDatabase: input.memoryDatabase,
    accountId: input.accountId,
    relationshipId: input.relationshipId
  });
  if (
    !mappingIsTrusted(mapping)
    || mapping!.version !== catalog.mappingVersion
    || mapping!.companion_person_id !== catalog.companionPersonId
  ) return { status: "needs_review", context: null };

  const personMemories = createPersonMemoryRepository(input.memoryDatabase).getPersonMemories({
    accountId: input.accountId,
    personId: catalog.companionPersonId,
    limit: 200
  });
  if (!personMemories) return { status: "unavailable", context: null };
  const catalogByKey = new Map(catalog.sources.map((source) => [
    sourceKey(source.uploadId, source.sourceSegmentId),
    source
  ]));
  const evidence = new Map<string, DateCompanionProactiveEvidence>();
  const evidenceSignatures = new Map<string, string>();
  const conflictingEvidenceKeys = new Set<string>();
  const admitEvidence = (key: string, candidate: DateCompanionProactiveEvidence) => {
    if (conflictingEvidenceKeys.has(key)) return;
    const signature = personRelationshipEvidenceSignature(candidate);
    const existingSignature = evidenceSignatures.get(key);
    if (existingSignature && existingSignature !== signature) {
      conflictingEvidenceKeys.add(key);
      evidenceSignatures.delete(key);
      evidence.delete(key);
      return;
    }
    if (!existingSignature) {
      evidenceSignatures.set(key, signature);
      evidence.set(key, candidate);
    }
  };
  for (const scoped of personMemories.memories) {
    const sourceResolution = input.resolveMemorySource
      ? input.resolveMemorySource({ accountId: input.accountId, memory: scoped.memory })
      : (() => {
          const resolution = resolveMemoryRetrievalSource({
            userId: input.accountId,
            memory: scoped.memory
          });
          return {
            eligible: resolution.eligible,
            origin: resolution.attribution.origin
          };
        })();
    for (const link of scoped.evidenceLinks) {
      const key = sourceKey(link.memoryEvidence.uploadId, link.memoryEvidence.sourceId);
      const dateCompanionSource = catalogByKey.get(key);
      if (dateCompanionSource) {
        if (normalizedText(link.memoryEvidence.quote) !== normalizedText(dateCompanionSource.quote)) continue;
        admitEvidence(key, {
          evidenceId: `memory_evidence:${link.memoryEvidence.id}`,
          uploadId: dateCompanionSource.uploadId,
          sourceSegmentId: dateCompanionSource.sourceSegmentId,
          recordingDate: dateCompanionSource.recordingDate,
          startSeconds: dateCompanionSource.startSeconds,
          endSeconds: dateCompanionSource.endSeconds,
          ...(dateCompanionSource.speakerId ? { speakerId: dateCompanionSource.speakerId } : {}),
          quote: dateCompanionSource.quote,
          contentDigest: dateCompanionEvidenceDigest({
            userId: input.accountId,
            uploadId: dateCompanionSource.uploadId,
            sourceSegmentId: dateCompanionSource.sourceSegmentId,
            startSeconds: dateCompanionSource.startSeconds,
            endSeconds: dateCompanionSource.endSeconds,
            speakerId: dateCompanionSource.speakerId ?? null,
            quote: dateCompanionSource.quote
          }),
          origin: "direct_conversation",
          subject: dateCompanionSource.subject
        });
        continue;
      }
      if (!sourceResolution.eligible || sourceResolution.origin !== "user_reflection") continue;
      const provenance = reflectionProvenance({
        database: input.memoryDatabase,
        accountId: input.accountId,
        personId: catalog.companionPersonId,
        memoryEvidenceId: link.memoryEvidence.id,
        personEvidenceId: link.personEvidence.id
      });
      if (
        !provenance
        || provenance.publication_status !== "published"
        || provenance.receipt_status !== "admitted"
        || provenance.current_status !== "active"
        || provenance.person_source_status !== "active"
        || provenance.revocation_id
        || !validSha256(provenance.content_digest)
        || normalizedText(link.memoryEvidence.quote) !== normalizedText(link.personEvidence.quote)
      ) continue;
      const subjectIds = scoped.subjectPersonIds;
      if (subjectIds.some((personId) => ![
        mapping!.self_person_id,
        mapping!.companion_person_id
      ].includes(personId))) continue;
      admitEvidence(key, {
        evidenceId: `reflection_candidate:${provenance.candidate_id}:${link.memoryEvidence.id}`,
        uploadId: link.memoryEvidence.uploadId,
        sourceSegmentId: link.memoryEvidence.sourceId,
        recordingDate: link.memoryEvidence.date,
        quote: link.memoryEvidence.quote,
        contentDigest: provenance.content_digest || fallbackDigest({
          accountId: input.accountId,
          uploadId: link.memoryEvidence.uploadId,
          sourceSegmentId: link.memoryEvidence.sourceId,
          quote: link.memoryEvidence.quote,
          origin: "user_reflection"
        }),
        origin: "user_reflection",
        subject: subjectIds.includes(mapping!.self_person_id) ? "both" : "companion"
      });
    }
  }
  const currentMapping = mappingState({
    dateCompanionDatabase: input.dateCompanionDatabase,
    memoryDatabase: input.memoryDatabase,
    accountId: input.accountId,
    relationshipId: input.relationshipId
  });
  if (
    !mappingIsTrusted(currentMapping)
    || currentMapping!.version !== mapping!.version
    || currentMapping!.companion_person_id !== mapping!.companion_person_id
  ) return { status: "needs_review", context: null };
  if (evidence.size === 0) return { status: "unavailable", context: null };
  return {
    status: "ready",
    context: DateCompanionProactiveValueContextSchema.parse({
      schemaVersion: 1,
      scope: "person_relationship",
      relationshipId: input.relationshipId,
      personId: catalog.companionPersonId,
      mappingVersion: mapping!.version,
      evidence: [...evidence.values()].sort(evidenceSort).slice(-24)
    })
  };
}
