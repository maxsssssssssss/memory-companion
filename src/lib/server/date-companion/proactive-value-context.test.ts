// @vitest-environment node

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openMemoryDatabase } from "@/lib/server/memory/db";
import { createMemoryRepository } from "@/lib/server/memory/repository";

import { openDateCompanionDatabase } from "./db";
import { dateCompanionEvidenceDigest, stableBridgeDigest } from "./memory-bridge-digest";
import {
  buildCurrentInteractionProactiveValueContext,
  buildPersonRelationshipProactiveValueContext
} from "./proactive-value-context";

let dateDatabase: Database.Database;
let memoryDatabase: Database.Database;

const now = "2026-08-19T10:00:00.000Z";
const accountId = "account_a";
const relationshipId = "relationship_1";
const interactionId = "interaction_1";
const uploadId = "upload_1";
const segmentId = "segment_1";
const snapshotId = "snapshot_1";
const selfPersonId = "person_self";
const companionPersonId = "person_companion";
const quote = "Ta 说周末想去看展。";

function seedPeopleAndMapping() {
  const insertPerson = memoryDatabase.prepare(`
    INSERT INTO person_entities (
      id, account_id, display_name, source, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'manual_confirmation', 'confirmed', ?, ?)
  `);
  insertPerson.run(selfPersonId, accountId, "Self", now, now);
  insertPerson.run(companionPersonId, accountId, "Ta", now, now);
  memoryDatabase.prepare(`
    INSERT INTO person_self_bindings (
      account_id, person_id, status, version, set_at, cleared_at, created_at, updated_at
    ) VALUES (?, ?, 'active', 1, ?, NULL, ?, ?)
  `).run(accountId, selfPersonId, now, now, now);

  dateDatabase.prepare(`
    INSERT INTO dc_relationships (
      id, user_id, display_name, status, version, created_at, updated_at
    ) VALUES (?, ?, 'Ta', 'active', 1, ?, ?)
  `).run(relationshipId, accountId, now, now);
  dateDatabase.prepare(`
    INSERT INTO dc_relationship_person_mappings (
      id, user_id, relationship_id, self_person_id, companion_person_id,
      relationship_type, status, version, confirmed_at, created_at, updated_at
    ) VALUES ('mapping_1', ?, ?, ?, ?, 'partner', 'confirmed', 1, ?, ?, ?)
  `).run(accountId, relationshipId, selfPersonId, companionPersonId, now, now, now);
}

function seedConfirmedInteraction() {
  dateDatabase.prepare(`
    INSERT INTO dc_interactions (
      id, user_id, relationship_id, source_upload_id, recording_date,
      original_name, duration_seconds, status, source_state, version,
      created_at, updated_at, confirmed_at, confirmation_fingerprint
    ) VALUES (?, ?, ?, ?, '2026-08-19', 'date.wav', 60, 'confirmed',
      'available', 2, ?, ?, ?, ?)
  `).run(interactionId, accountId, relationshipId, uploadId, now, now, now, "a".repeat(64));
  dateDatabase.prepare(`
    INSERT INTO dc_participant_assignments (
      user_id, interaction_id, speaker_id, role, confirmed_by, confirmed_at, continuity_key
    ) VALUES (?, ?, 'speaker_companion', 'companion', 'user', ?, 'continuity_companion')
  `).run(accountId, interactionId, now);
  dateDatabase.prepare(`
    INSERT INTO dc_recap_items (
      id, user_id, interaction_id, kind, proposed_text, user_text,
      disposition, version, sort_order, created_at, updated_at
    ) VALUES ('recap_1', ?, ?, 'mentioned', ?, NULL, 'kept', 1, 0, ?, ?)
  `).run(accountId, interactionId, quote, now, now);
  const digest = dateCompanionEvidenceDigest({
    userId: accountId,
    uploadId,
    sourceSegmentId: segmentId,
    startSeconds: 5,
    endSeconds: 9,
    speakerId: "speaker_companion",
    quote
  });
  dateDatabase.prepare(`
    INSERT INTO dc_evidence_snapshots (
      id, user_id, recap_item_id, upload_id, source_segment_id,
      start_seconds, end_seconds, speaker_id, quote, created_at,
      provenance_version, source_kind, content_digest
    ) VALUES (?, ?, 'recap_1', ?, ?, 5, 9, 'speaker_companion', ?, ?,
      1, 'date_companion_recap', ?)
  `).run(snapshotId, accountId, uploadId, segmentId, quote, now, digest);
  dateDatabase.prepare(`
    INSERT INTO dc_memory_subject_selections (
      id, user_id, relationship_id, interaction_id, recap_item_id,
      evidence_snapshot_id, subject, version, created_at, updated_at
    ) VALUES ('selection_1', ?, ?, ?, 'recap_1', ?, 'companion', 1, ?, ?)
  `).run(accountId, relationshipId, interactionId, snapshotId, now, now);
  const payload = {
    version: 1,
    userId: accountId,
    relationshipId,
    interactionId,
    sourceUploadId: uploadId,
    sourceVersion: 2,
    confirmationFingerprint: "a".repeat(64),
    mapping: {
      version: 1,
      selfPersonId,
      companionPersonId,
      relationshipType: "partner"
    },
    selections: [{
      evidenceSnapshotId: snapshotId,
      recapItemId: "recap_1",
      uploadId,
      sourceSegmentId: segmentId,
      contentDigest: digest,
      subject: "companion"
    }]
  };
  dateDatabase.prepare(`
    INSERT INTO dc_memory_bridge_outbox (
      id, user_id, relationship_id, interaction_id, idempotency_key,
      payload_digest, payload_json, mapping_version, source_version,
      confirmation_fingerprint, status, attempt_count, requested_at, updated_at
    ) VALUES ('outbox_1', ?, ?, ?, 'sync_1', ?, ?, 1, 2, ?,
      'pending', 0, ?, ?)
  `).run(
    accountId,
    relationshipId,
    interactionId,
    stableBridgeDigest(payload),
    JSON.stringify(payload),
    "a".repeat(64),
    now,
    now
  );
}

function seedAdmittedPersonMemory(includeConflictingSource = false) {
  memoryDatabase.prepare(`
    INSERT INTO person_evidence (
      id, account_id, upload_id, source_segment_id, quote, created_at, updated_at
    ) VALUES ('person_evidence_1', ?, ?, ?, ?, ?, ?)
  `).run(accountId, uploadId, segmentId, quote, now, now);
  memoryDatabase.prepare(`
    INSERT INTO person_subject_observations (
      id, account_id, person_id, evidence_id, status, source, reason,
      confirmed_at, created_at, updated_at
    ) VALUES ('subject_1', ?, ?, 'person_evidence_1', 'confirmed',
      'manual_review', 'explicit confirmation', ?, ?, ?)
  `).run(accountId, companionPersonId, now, now, now);
  createMemoryRepository(memoryDatabase).replaceUploadMemories({
    userId: accountId,
    uploadId,
    memories: [
      {
        id: "memory_1",
        type: "event",
        title: "周末看展",
        summary: "Ta 提到周末想去看展。",
        importance: 0.8,
        importanceScore: 0.8,
        status: "active",
        date: "2026-08-19",
        createdAt: now,
        updatedAt: now,
        evidence: [{
          id: "memory_evidence_1",
          sourceType: "transcript",
          sourceId: segmentId,
          uploadId,
          date: "2026-08-19",
          quote,
          createdAt: now
        }]
      },
      ...(includeConflictingSource ? [{
        id: "memory_2",
        type: "event" as const,
        title: "重复来源",
        summary: "同一来源不得携带冲突 digest。",
        importance: 0.7,
        importanceScore: 0.7,
        status: "active" as const,
        date: "2026-08-19",
        createdAt: now,
        updatedAt: now,
        evidence: [{
          id: "memory_evidence_2",
          sourceType: "transcript" as const,
          sourceId: segmentId,
          uploadId,
          date: "2026-08-19",
          quote,
          createdAt: now
        }]
      }] : [])
    ]
  });
}

function seedPublishedReflectionAdmission() {
  memoryDatabase.prepare(`
    INSERT INTO memory_daily_reflection_publications (
      id, user_id, reflection_id, confirmation_id, upload_id,
      confirmation_fingerprint, payload_digest, source_origin, status,
      created_at, updated_at, deleted_at
    ) VALUES ('publication_1', ?, 'reflection_1', 'confirmation_1', ?,
      ?, ?, 'user_reflection', 'published', ?, ?, NULL)
  `).run(accountId, uploadId, "c".repeat(64), "d".repeat(64), now, now);
  memoryDatabase.prepare(`
    INSERT INTO memory_daily_reflection_candidate_receipts (
      user_id, publication_id, candidate_id, status, memory_id,
      reason_code, operation_key, created_at
    ) VALUES (?, 'publication_1', 'candidate_1', 'admitted', 'memory_1',
      NULL, 'operation_1', ?)
  `).run(accountId, now);
  memoryDatabase.prepare(`
    INSERT INTO memory_daily_reflection_evidence_provenance (
      memory_evidence_id, user_id, publication_id, reflection_id,
      confirmation_id, candidate_id, upload_id, source_segment_id,
      source_origin, content_digest, created_at
    ) VALUES ('memory_evidence_1', ?, 'publication_1', 'reflection_1',
      'confirmation_1', 'candidate_1', ?, ?, 'user_reflection', ?, ?)
  `).run(accountId, uploadId, segmentId, "e".repeat(64), now);
  memoryDatabase.prepare(`
    INSERT INTO memory_daily_reflection_candidate_current_memories (
      user_id, publication_id, reflection_id, confirmation_id, candidate_id,
      status, current_memory_id, revocation_id, created_at, updated_at, revoked_at
    ) VALUES (?, 'publication_1', 'reflection_1', 'confirmation_1', 'candidate_1',
      'active', 'memory_1', NULL, ?, ?, NULL)
  `).run(accountId, now, now);
  memoryDatabase.prepare(`
    INSERT INTO memory_daily_reflection_candidate_person_sources (
      id, user_id, publication_id, reflection_id, confirmation_id,
      candidate_id, person_id, person_evidence_id, subject_admission_id,
      subject_observation_id, source_segment_id, owns_person_evidence,
      owns_subject_admission, owns_subject_observation,
      previous_subject_admission_json, previous_subject_observation_json,
      status, revocation_id, created_at, updated_at, revoked_at
    ) VALUES ('reflection_person_source_1', ?, 'publication_1', 'reflection_1',
      'confirmation_1', 'candidate_1', ?, 'person_evidence_1',
      'subject_admission_1', 'subject_1', ?, 1, 1, 1, NULL, NULL,
      'active', NULL, ?, ?, NULL)
  `).run(accountId, companionPersonId, segmentId, now, now);
}

function seedConflictingReflectionAdmission() {
  memoryDatabase.prepare(`
    INSERT INTO memory_daily_reflection_candidate_receipts (
      user_id, publication_id, candidate_id, status, memory_id,
      reason_code, operation_key, created_at
    ) VALUES (?, 'publication_1', 'candidate_2', 'admitted', 'memory_2',
      NULL, 'operation_2', ?)
  `).run(accountId, now);
  memoryDatabase.prepare(`
    INSERT INTO memory_daily_reflection_evidence_provenance (
      memory_evidence_id, user_id, publication_id, reflection_id,
      confirmation_id, candidate_id, upload_id, source_segment_id,
      source_origin, content_digest, created_at
    ) VALUES ('memory_evidence_2', ?, 'publication_1', 'reflection_1',
      'confirmation_1', 'candidate_2', ?, ?, 'user_reflection', ?, ?)
  `).run(accountId, uploadId, segmentId, "f".repeat(64), now);
  memoryDatabase.prepare(`
    INSERT INTO memory_daily_reflection_candidate_current_memories (
      user_id, publication_id, reflection_id, confirmation_id, candidate_id,
      status, current_memory_id, revocation_id, created_at, updated_at, revoked_at
    ) VALUES (?, 'publication_1', 'reflection_1', 'confirmation_1', 'candidate_2',
      'active', 'memory_2', NULL, ?, ?, NULL)
  `).run(accountId, now, now);
  memoryDatabase.prepare(`
    INSERT INTO memory_daily_reflection_candidate_person_sources (
      id, user_id, publication_id, reflection_id, confirmation_id,
      candidate_id, person_id, person_evidence_id, subject_admission_id,
      subject_observation_id, source_segment_id, owns_person_evidence,
      owns_subject_admission, owns_subject_observation,
      previous_subject_admission_json, previous_subject_observation_json,
      status, revocation_id, created_at, updated_at, revoked_at
    ) VALUES ('reflection_person_source_2', ?, 'publication_1', 'reflection_1',
      'confirmation_1', 'candidate_2', ?, 'person_evidence_1',
      'subject_admission_2', 'subject_1', ?, 0, 0, 0, NULL, NULL,
      'active', NULL, ?, ?, NULL)
  `).run(accountId, companionPersonId, segmentId, now, now);
}

beforeEach(() => {
  dateDatabase = openDateCompanionDatabase({ filePath: ":memory:" });
  memoryDatabase = openMemoryDatabase({ filePath: ":memory:" });
  seedPeopleAndMapping();
  seedConfirmedInteraction();
});

afterEach(() => {
  dateDatabase.close();
  memoryDatabase.close();
});

describe("Date Companion proactive value contexts", () => {
  it("accepts only confirmed kept canonical current-interaction Evidence with a non-unknown Subject", () => {
    const ready = buildCurrentInteractionProactiveValueContext({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      accountId,
      interactionId
    });
    expect(ready.status).toBe("ready");
    expect(ready.context?.scope).toBe("current_interaction");
    expect(ready.context?.evidence).toEqual([
      expect.objectContaining({
        evidenceId: `dc_snapshot:${snapshotId}`,
        origin: "direct_conversation",
        subject: "companion",
        subjectVersion: 1,
        quote
      })
    ]);

    dateDatabase.prepare("UPDATE dc_recap_items SET disposition = 'excluded'").run();
    expect(buildCurrentInteractionProactiveValueContext({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      accountId,
      interactionId
    }).status).toBe("unavailable");
    dateDatabase.prepare("UPDATE dc_recap_items SET disposition = 'pending'").run();
    expect(buildCurrentInteractionProactiveValueContext({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      accountId,
      interactionId
    }).status).toBe("unavailable");
    dateDatabase.prepare("UPDATE dc_recap_items SET disposition = 'kept'").run();
    dateDatabase.prepare("UPDATE dc_memory_subject_selections SET subject = 'unknown'").run();
    expect(buildCurrentInteractionProactiveValueContext({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      accountId,
      interactionId
    }).status).toBe("unavailable");
  });

  it("ignores excluded duplicates before canonical conflict detection but still rejects kept conflicts", () => {
    dateDatabase.prepare(`
      INSERT INTO dc_recap_items (
        id, user_id, interaction_id, kind, proposed_text, user_text,
        disposition, version, sort_order, created_at, updated_at
      ) VALUES ('recap_excluded', ?, ?, 'mentioned', ?, NULL, 'excluded', 1, 1, ?, ?)
    `).run(accountId, interactionId, quote, now, now);
    const digest = dateCompanionEvidenceDigest({
      userId: accountId,
      uploadId,
      sourceSegmentId: segmentId,
      startSeconds: 5,
      endSeconds: 9,
      speakerId: "speaker_companion",
      quote
    });
    dateDatabase.prepare(`
      INSERT INTO dc_evidence_snapshots (
        id, user_id, recap_item_id, upload_id, source_segment_id,
        start_seconds, end_seconds, speaker_id, quote, created_at,
        provenance_version, source_kind, content_digest
      ) VALUES ('snapshot_excluded', ?, 'recap_excluded', ?, ?, 5, 9,
        'speaker_companion', ?, ?, 1, 'date_companion_recap', ?)
    `).run(accountId, uploadId, segmentId, quote, now, digest);
    dateDatabase.prepare(`
      INSERT INTO dc_memory_subject_selections (
        id, user_id, relationship_id, interaction_id, recap_item_id,
        evidence_snapshot_id, subject, version, created_at, updated_at
      ) VALUES ('selection_excluded', ?, ?, ?, 'recap_excluded',
        'snapshot_excluded', 'self', 1, ?, ?)
    `).run(accountId, relationshipId, interactionId, now, now);

    const ready = buildCurrentInteractionProactiveValueContext({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      accountId,
      interactionId
    });
    expect(ready.status).toBe("ready");
    expect(ready.context?.evidence).toHaveLength(1);
    expect(ready.context?.evidence[0]?.evidenceId).toBe(`dc_snapshot:${snapshotId}`);

    dateDatabase.prepare(`
      UPDATE dc_recap_items SET disposition = 'kept' WHERE id = 'recap_excluded'
    `).run();
    expect(buildCurrentInteractionProactiveValueContext({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      accountId,
      interactionId
    }).status).toBe("unavailable");
  });

  it("fails closed for digest drift, archived Person, and cross-account interaction IDs", () => {
    dateDatabase.prepare("UPDATE dc_evidence_snapshots SET quote = 'drifted'").run();
    expect(buildCurrentInteractionProactiveValueContext({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      accountId,
      interactionId
    }).status).toBe("unavailable");
    dateDatabase.prepare("UPDATE dc_evidence_snapshots SET quote = ?").run(quote);
    dateDatabase.prepare("UPDATE dc_relationship_person_mappings SET version = 2").run();
    expect(buildCurrentInteractionProactiveValueContext({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      accountId,
      interactionId
    }).status).toBe("needs_review");
    dateDatabase.prepare("UPDATE dc_relationship_person_mappings SET version = 1").run();
    memoryDatabase.prepare("UPDATE person_entities SET status = 'archived' WHERE id = ?").run(companionPersonId);
    expect(buildCurrentInteractionProactiveValueContext({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      accountId,
      interactionId
    }).status).toBe("needs_review");
    expect(() => buildCurrentInteractionProactiveValueContext({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      accountId: "account_b",
      interactionId
    })).toThrow("Interaction not found");
  });

  it("requires admitted Person Memory intersected with the trusted relationship catalog", () => {
    seedAdmittedPersonMemory();
    const catalog = () => ({
      relationshipId,
      companionPersonId,
      mappingVersion: 1,
      status: "ready" as const,
      sources: [{
        evidenceSnapshotId: snapshotId,
        interactionId,
        uploadId,
        sourceSegmentId: segmentId,
        recordingDate: "2026-08-19",
        startSeconds: 5,
        endSeconds: 9,
        speakerId: "speaker_companion",
        quote,
        subject: "companion" as const
      }]
    });
    const ready = buildPersonRelationshipProactiveValueContext({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      accountId,
      relationshipId,
      resolveCatalog: catalog,
      resolveMemorySource: () => ({ eligible: true, origin: "direct_conversation" })
    });
    expect(ready.status).toBe("ready");
    expect(ready.context).toMatchObject({
      scope: "person_relationship",
      personId: companionPersonId,
      mappingVersion: 1
    });
    expect(ready.context?.evidence).toHaveLength(1);

    memoryDatabase.prepare("DELETE FROM memory_evidence WHERE id = 'memory_evidence_1'").run();
    expect(buildPersonRelationshipProactiveValueContext({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      accountId,
      relationshipId,
      resolveCatalog: catalog,
      resolveMemorySource: () => ({ eligible: true, origin: "direct_conversation" })
    }).status).toBe("unavailable");
  });

  it("does not admit an unpublished/reflection-like Person Memory without active canonical provenance", () => {
    seedAdmittedPersonMemory();
    const resolution = buildPersonRelationshipProactiveValueContext({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      accountId,
      relationshipId,
      resolveCatalog: () => ({
        relationshipId,
        companionPersonId,
        mappingVersion: 1,
        status: "ready",
        sources: []
      }),
      resolveMemorySource: () => ({ eligible: true, origin: "user_reflection" })
    });
    expect(resolution.status).toBe("unavailable");
    expect(resolution.context).toBeNull();
  });

  it("accepts only published admitted Reflection provenance and hides it after unpublish or candidate revocation", () => {
    seedAdmittedPersonMemory();
    seedPublishedReflectionAdmission();
    const build = () => buildPersonRelationshipProactiveValueContext({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      accountId,
      relationshipId,
      resolveCatalog: () => ({
        relationshipId,
        companionPersonId,
        mappingVersion: 1,
        status: "ready",
        sources: []
      }),
      resolveMemorySource: () => ({ eligible: true, origin: "user_reflection" })
    });
    expect(build()).toMatchObject({
      status: "ready",
      context: {
        evidence: [expect.objectContaining({
          origin: "user_reflection",
          subject: "companion"
        })]
      }
    });

    memoryDatabase.prepare(`
      UPDATE memory_daily_reflection_publications SET status = 'unpublished'
      WHERE id = 'publication_1'
    `).run();
    expect(build().status).toBe("unavailable");

    memoryDatabase.prepare(`
      UPDATE memory_daily_reflection_publications SET status = 'published'
      WHERE id = 'publication_1'
    `).run();
    memoryDatabase.prepare(`
      UPDATE memory_daily_reflection_candidate_current_memories
      SET status = 'revoked', current_memory_id = NULL,
          revocation_id = 'revocation_1', revoked_at = ?
      WHERE candidate_id = 'candidate_1'
    `).run(now);
    memoryDatabase.prepare(`
      UPDATE memory_daily_reflection_candidate_person_sources
      SET status = 'revoked', revocation_id = 'revocation_1', revoked_at = ?
      WHERE candidate_id = 'candidate_1'
    `).run(now);
    expect(build().status).toBe("unavailable");
  });

  it("excludes a canonical Reflection key when the same quote has conflicting digests", () => {
    seedAdmittedPersonMemory(true);
    seedPublishedReflectionAdmission();
    const build = () => buildPersonRelationshipProactiveValueContext({
      dateCompanionDatabase: dateDatabase,
      memoryDatabase,
      accountId,
      relationshipId,
      resolveCatalog: () => ({
        relationshipId,
        companionPersonId,
        mappingVersion: 1,
        status: "ready",
        sources: []
      }),
      resolveMemorySource: () => ({ eligible: true, origin: "user_reflection" })
    });
    expect(build()).toMatchObject({
      status: "ready",
      context: {
        evidence: [expect.objectContaining({ contentDigest: "e".repeat(64) })]
      }
    });

    seedConflictingReflectionAdmission();
    expect(build()).toEqual({ status: "unavailable", context: null });
  });
});
