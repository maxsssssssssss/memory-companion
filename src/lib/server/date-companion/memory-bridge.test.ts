import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import { MEMORY_SCHEMA_VERSION, migrateMemorySchema } from "@/lib/server/memory/schema";
import { createMemoryRepository } from "@/lib/server/memory/repository";
import { createDailyReflectionMemoryPublicationRepository } from "@/lib/server/memory/daily-reflection-publication";
import { validatePersonTranscriptEvidence } from "@/lib/server/person/evidence";
import { createPersonAdmissionRepository } from "@/lib/server/person/admission-repository";
import { createTemporalFactRepository } from "@/lib/server/person/temporal-facts";
import { captureRetainedMemoryEvidenceProvenance } from "@/lib/server/memory/retention-provenance";
import { deleteMemoryUploadAndRefreshIndex } from "@/lib/server/memory/upload-deletion";
import { createPersonMemoryRepository } from "@/lib/server/person/memory-repository";
import type { JsonStore } from "@/lib/server/storage/json-store";
import { openDateCompanionDatabase } from "./db";
import { DateCompanionRepository } from "./repository";
import {
  createDateCompanionMemoryBridgeRepository,
  prepareMemoryBridgeInteractionDeletion
} from "./memory-bridge-repository";
import {
  processNextDateCompanionMemoryBridge,
  processDateCompanionMemoryBridgeInteraction,
  requeueCompletedLegacyMemoryProjections,
  validateMemoryBridgePersonMapping
} from "./memory-bridge-consumer";
import { getDateCompanionWithdrawalPreview, purgeDateCompanionRetainedMemory } from "./memory-bridge-purge";
import {
  cleanupDateCompanionGrantProjection, fenceDateCompanionGrantProjection,
  getFencedDateCompanionGrantCategory, hasDateCompanionGrantProjection
} from "./memory-grant-projection";
import * as grantProjection from "./memory-grant-projection";
import { getOrCreateDateCompanionSubjectSuggestionBatch } from "./subject-suggestions";
import { DATE_COMPANION_SCHEMA_VERSION } from "./schema";
import {
  dateCompanionMemoryProjectionIdempotencyKey,
  stableBridgeDigest
} from "./memory-bridge-digest";

const NOW = "2026-08-11T00:00:00.000Z";

describe("Memory-Date Companion bridge", () => {
  let dcDatabase: Database.Database;
  let memoryDatabase: Database.Database;
  let dcRepository: DateCompanionRepository;

  beforeEach(() => {
    dcDatabase = openDateCompanionDatabase({ filePath: ":memory:" });
    memoryDatabase = openMemoryDatabase({ filePath: ":memory:" });
    dcRepository = new DateCompanionRepository(dcDatabase);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dcDatabase.close();
    memoryDatabase.close();
  });

  function seedPeople(userId = "user_a") {
    const insert = memoryDatabase.prepare(`
      INSERT INTO person_entities (
        id, account_id, display_name, source, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'manual_confirmation', 'confirmed', ?, ?)
    `);
    insert.run("person_self", userId, "我", NOW, NOW);
    insert.run("person_ta", userId, "Ta", NOW, NOW);
    memoryDatabase.prepare(`
      INSERT INTO person_self_bindings (
        account_id, person_id, status, version, set_at, cleared_at, created_at, updated_at
      ) VALUES (?, 'person_self', 'active', 1, ?, NULL, ?, ?)
    `).run(userId, NOW, NOW, NOW);
  }

  function seedMemory(userId = "user_a", uploadId = "upload_1") {
    createMemoryRepository(memoryDatabase).replaceUploadMemories({
      userId,
      uploadId,
      memories: [
        {
          id: "memory_companion",
          type: "event",
          title: "Ta 想去看展",
          summary: "Ta 想去看展",
          importance: 0.8,
          date: "2026-08-11",
          createdAt: NOW,
          updatedAt: NOW,
          evidence: [{
            id: "memory_evidence_companion",
            sourceType: "transcript",
            sourceId: "segment_companion",
            uploadId,
            date: "2026-08-11",
            quote: "我最近想去看展",
            createdAt: NOW
          }]
        },
        {
          id: "memory_unknown",
          type: "event",
          title: "未确认内容",
          summary: "未确认内容",
          importance: 0.6,
          date: "2026-08-11",
          createdAt: NOW,
          updatedAt: NOW,
          evidence: [{
            id: "memory_evidence_unknown",
            sourceType: "transcript",
            sourceId: "segment_unknown",
            uploadId,
            date: "2026-08-11",
            quote: "这件事还不确定",
            createdAt: NOW
          }]
        }
      ]
    });
  }

  function transcriptStore(uploadId = "upload_1") {
    const upload = {
      id: uploadId,
      originalName: "date.wav",
      mimeType: "audio/wav",
      sizeBytes: 1024,
      recordingDate: "2026-08-11",
      status: "ready"
    };
    const segments = [
      {
        id: "segment_companion",
        uploadId,
        startSeconds: 0,
        endSeconds: 4,
        speaker: "speaker_1",
        text: "我最近想去看展",
        confidence: 0.99,
        sceneLabels: [],
        valueLabels: []
      },
      {
        id: "segment_unknown",
        uploadId,
        startSeconds: 4,
        endSeconds: 8,
        speaker: "speaker_0",
        text: "这件事还不确定",
        confidence: 0.99,
        sceneLabels: [],
        valueLabels: []
      }
    ];
    return {
      read: vi.fn(async (kind: string) => kind === "uploads" ? upload : kind === "segments" ? segments : null)
    };
  }

  function formalAdmissionTranscriptStore(uploadId = "upload_formal") {
    const upload = {
      id: uploadId,
      originalName: "formal-date.wav",
      mimeType: "audio/wav",
      sizeBytes: 2048,
      recordingDate: "2026-08-11",
      status: "ready"
    };
    const segments = [
      {
        id: "segment_formal_admitted",
        uploadId,
        startSeconds: 0,
        endSeconds: 4,
        speaker: "speaker_1",
        text: "她说她想去看展，想找个周末一起去。",
        confidence: 0.99,
        sceneLabels: [],
        valueLabels: []
      },
      {
        id: "segment_formal_rejected",
        uploadId,
        startSeconds: 4,
        endSeconds: 8,
        speaker: "speaker_1",
        text: "想去看展，也聊了很多别的话题。",
        confidence: 0.99,
        sceneLabels: [],
        valueLabels: []
      },
      {
        id: "segment_formal_excluded",
        uploadId,
        startSeconds: 8,
        endSeconds: 12,
        speaker: "speaker_1",
        text: "下周六之前要完成作品集。",
        confidence: 0.99,
        sceneLabels: [],
        valueLabels: []
      }
    ];
    return {
      read: vi.fn(async (kind: string) => kind === "uploads" ? upload : kind === "segments" ? segments : null)
    };
  }

  function importFormalAdmissionDraft() {
    const relationship = dcRepository.createOrGetRelationship("user_a", "Ta").relationship;
    const imported = dcRepository.importInteraction({
      userId: "user_a",
      relationshipId: relationship.id,
      sourceUploadId: "upload_formal",
      recordingDate: "2026-08-11",
      originalName: "formal-date.wav",
      participants: [{ speakerId: "speaker_0" }, { speakerId: "speaker_1" }],
      recapCandidates: [
        {
          kind: "mentioned",
          proposedText: "Ta 提到想去看展",
          sortOrder: 0,
          evidence: [{
            uploadId: "upload_formal",
            sourceSegmentId: "segment_formal_admitted",
            startSeconds: 0,
            endSeconds: 4,
            speakerId: "speaker_1",
            quote: "她说她想去看展，想找个周末一起去。"
          }]
        },
        {
          kind: "mentioned",
          proposedText: "围绕多个话题展开",
          sortOrder: 1,
          evidence: [{
            uploadId: "upload_formal",
            sourceSegmentId: "segment_formal_rejected",
            startSeconds: 4,
            endSeconds: 8,
            speakerId: "speaker_1",
            quote: "想去看展，也聊了很多别的话题。"
          }]
        },
        {
          kind: "mentioned",
          proposedText: "Ta 下周六之前要完成作品集",
          sortOrder: 2,
          evidence: [{
            uploadId: "upload_formal",
            sourceSegmentId: "segment_formal_excluded",
            startSeconds: 8,
            endSeconds: 12,
            speakerId: "speaker_1",
            quote: "下周六之前要完成作品集。"
          }]
        }
      ]
    });
    return { relationship, imported };
  }

  function importDraft(userId = "user_a", uploadId = "upload_1") {
    const relationship = dcRepository.createOrGetRelationship(userId, "Ta").relationship;
    const imported = dcRepository.importInteraction({
      userId,
      relationshipId: relationship.id,
      sourceUploadId: uploadId,
      recordingDate: "2026-08-11",
      originalName: "date.wav",
      participants: [{ speakerId: "speaker_0" }, { speakerId: "speaker_1" }],
      recapCandidates: [
        {
          kind: "mentioned",
          proposedText: "Ta 想去看展",
          sortOrder: 0,
          evidence: [{
            uploadId,
            sourceSegmentId: "segment_companion",
            startSeconds: 0,
            endSeconds: 4,
            speakerId: "speaker_1",
            quote: "我最近想去看展"
          }]
        },
        {
          kind: "continue",
          proposedText: "这件事还不确定",
          sortOrder: 1,
          evidence: [{
            uploadId,
            sourceSegmentId: "segment_unknown",
            startSeconds: 4,
            endSeconds: 8,
            speakerId: "speaker_0",
            quote: "这件事还不确定"
          }]
        }
      ]
    });
    return { relationship, imported };
  }

  async function subjectConfirmation(interactionId: string, keptIds?: string[]) {
    const interaction = dcDatabase.prepare("SELECT status,version FROM dc_interactions WHERE user_id=? AND id=?")
      .get("user_a", interactionId) as {status:string; version:number};
    const items = dcDatabase.prepare("SELECT id FROM dc_recap_items WHERE user_id=? AND interaction_id=?")
      .all("user_a",interactionId) as Array<{id:string}>;
    const batch = await getOrCreateDateCompanionSubjectSuggestionBatch({
      database: dcDatabase,
      userId: "user_a",
      interactionId,
      draftPreview: interaction.status === "draft" ? {
        version: interaction.version, itemIds: keptIds ?? items.map(i=>i.id),
        assignments: [{speakerId:"speaker_0",role:"self"},{speakerId:"speaker_1",role:"companion"}]
      } : undefined,
      provider: {
        model: "Qwen/Qwen3.6-27B",
        suggest: async (sources) => sources.map((source) => ({
          canonicalSourceKey: source.canonicalSourceKey,
          proposedSubject: source.quote.includes("想去看展")
            ? "companion" as const
            : "unknown" as const,
          confidence: 1,
          reasonCode: source.quote.includes("想去看展")
            ? "explicit_companion_reference" as const
            : "insufficient_context" as const
        }))
      }
    });
    return {
      batchId: batch.batchId,
      evidenceDigest: batch.evidenceDigest,
      proposalDigest: batch.proposalDigest,
      confirmationFingerprint: batch.confirmationFingerprint,
      confirmedVisibleSuggestions: true as const
    };
  }

  async function processSinglePromiseCandidate(input: {
    uploadId: string;
    segmentId: string;
    quote: string;
  }) {
    seedPeople();
    const relationship = dcRepository.createOrGetRelationship("user_a", "Ta").relationship;
    const imported = dcRepository.importInteraction({
      userId: "user_a",
      relationshipId: relationship.id,
      sourceUploadId: input.uploadId,
      recordingDate: "2026-08-11",
      originalName: `${input.uploadId}.wav`,
      participants: [{ speakerId: "speaker_0" }, { speakerId: "speaker_1" }],
      recapCandidates: [{
        kind: "promise",
        proposedText: input.quote,
        sortOrder: 0,
        evidence: [{
          uploadId: input.uploadId,
          sourceSegmentId: input.segmentId,
          startSeconds: 0,
          endSeconds: 5,
          speakerId: "speaker_0",
          quote: input.quote
        }]
      }]
    });
    const bridge = createDateCompanionMemoryBridgeRepository(dcDatabase);
    const mapping = bridge.putPersonMapping({
      userId: "user_a",
      relationshipId: relationship.id,
      selfPersonId: "person_self",
      companionPersonId: "person_ta",
      relationshipType: "dating",
      expectedVersion: 0
    });
    const item = dcRepository.getRelationshipView("user_a", relationship.id)
      .interactions[0]!.recapItems[0]!;
    const confirmation = await subjectConfirmation(imported.interactionId);
    dcRepository.updateRecap({
      userId: "user_a",
      interactionId: imported.interactionId,
      version: 0,
      assignments: [
        { speakerId: "speaker_0", role: "self" },
        { speakerId: "speaker_1", role: "companion" }
      ],
      mutations: [{ id: item.id, version: item.version, disposition: "kept" }],
      memoryAdmission: {
        mappingVersion: mapping.version,
        subjectSuggestionConfirmation: confirmation,
        selections: [{ evidenceSnapshotId: item.evidence[0]!.id, subject: "companion" }]
      },
      finalize: true
    });
    await expect(captureRetainedMemoryEvidenceProvenance({
      database: memoryDatabase,
      store: {
        read: vi.fn(async (kind: string) => kind === "uploads" ? {
          id: input.uploadId,
          originalName: `${input.uploadId}.wav`,
          mimeType: "audio/wav",
          sizeBytes: 1024,
          recordingDate: "2026-08-11",
          status: "ready"
        } : kind === "segments" ? [{
          id: input.segmentId,
          uploadId: input.uploadId,
          startSeconds: 0,
          endSeconds: 5,
          speaker: "speaker_0",
          text: input.quote,
          confidence: 0.99,
          sceneLabels: [],
          valueLabels: []
        }] : null)
      } as unknown as Pick<JsonStore, "read">,
      userId: "user_a",
      uploadId: input.uploadId,
      relationshipId: relationship.id,
      interactionId: imported.interactionId,
      now: NOW
    })).resolves.toMatchObject({ provenanceCount: 0 });
    expect(dcRepository.markUploadSourceState("user_a", input.uploadId, "server_cleaned"))
      .toBe(true);
    await processDateCompanionMemoryBridgeInteraction({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      userId: "user_a",
      interactionId: imported.interactionId
    });
    return { imported, item, relationship };
  }

  async function completeRetainedBridge(afterMemoryCommit?: () => void | Promise<void>, existingPeople = false) {
    if (!existingPeople) seedPeople();
    seedMemory();
    const { relationship, imported } = importDraft();
    const bridge = createDateCompanionMemoryBridgeRepository(dcDatabase);
    bridge.putRetentionSetting({ userId: "user_a", enabled: true, expectedVersion: 0 });
    const mapping = bridge.putPersonMapping({
      userId: "user_a",
      relationshipId: relationship.id,
      selfPersonId: "person_self",
      companionPersonId: "person_ta",
      relationshipType: "dating",
      expectedVersion: 0
    });
    const detail = dcRepository.getRelationshipView("user_a", relationship.id).interactions[0];
    const evidenceBySegment = new Map(
      detail.recapItems.flatMap((item) => item.evidence)
        .map((item) => [item.sourceSegmentId, item.id])
    );
    const confirmation = await subjectConfirmation(imported.interactionId);
    dcRepository.updateRecap({
      userId: "user_a",
      interactionId: imported.interactionId,
      version: 0,
      assignments: [
        { speakerId: "speaker_0", role: "self" },
        { speakerId: "speaker_1", role: "companion" }
      ],
      mutations: detail.recapItems.map((item) => ({
        id: item.id,
        version: item.version,
        disposition: "kept" as const
      })),
      memoryAdmission: {
        mappingVersion: mapping.version,
        subjectSuggestionConfirmation: confirmation,
        selections: [
          {
            evidenceSnapshotId: evidenceBySegment.get("segment_companion")!,
            subject: "companion"
          },
          {
            evidenceSnapshotId: evidenceBySegment.get("segment_unknown")!,
            subject: "unknown"
          }
        ]
      },
      finalize: true
    });
    await captureRetainedMemoryEvidenceProvenance({
      database: memoryDatabase,
      store: transcriptStore() as unknown as Pick<JsonStore, "read">,
      userId: "user_a",
      uploadId: "upload_1",
      relationshipId: relationship.id,
      interactionId: imported.interactionId,
      now: NOW
    });
    dcRepository.markUploadSourceState("user_a", "upload_1", "server_cleaned");
    await processDateCompanionMemoryBridgeInteraction({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      userId: "user_a",
      interactionId: imported.interactionId,
      afterMemoryCommit
    });
    return { relationship, imported, bridge };
  }

  it("R14 fences person timeline, memories and relations before cleanup while preserving another product on the same upload", async () => {
    const { imported, relationship } = await completeRetainedBridge();
    const { id } = dcDatabase.prepare("SELECT id FROM dc_memory_bridge_outbox WHERE interaction_id=?")
      .get(imported.interactionId) as { id: string };
    const grant = { userId: "user_a", uploadId: "upload_1", relationshipId: relationship.id,
      interactionId: imported.interactionId, outboxId: id, generation: 1 };
    const memory = createMemoryRepository(memoryDatabase);
    const person = createPersonMemoryRepository(memoryDatabase);
    const query = { accountId: grant.userId, personId: "person_ta" };
    const getCards = () => memory.getRelevantMemories({ userId: grant.userId, uploadId: grant.uploadId });
    const original = getCards().find((card) => card.evidence.some((e) => e.sourceId === "segment_companion"))!;

    // Same upload, canonical segment and quote, but an independently contributed card/ID.
    const independent = {
      ...original, id: "standalone_memory", title: "独立产品的复盘", summary: "独立产品的复盘",
      evidence: [{ ...original.evidence[0]!, id: "standalone_evidence" }]
    };
    const transcript = await validatePersonTranscriptEvidence({
      store: transcriptStore() as unknown as Pick<JsonStore, "read">,
      authenticatedAccountId: grant.userId, accountId: grant.userId, uploadId: grant.uploadId,
      sourceSegmentId: "segment_companion", quote: independent.evidence[0]!.quote
    });
    const reflection = createDailyReflectionMemoryPublicationRepository(memoryDatabase);
    reflection.publish({
      id: "reflection_publication", userId: grant.userId, uploadId: grant.uploadId,
      reflectionId: "reflection", confirmationId: "confirmation", confirmationFingerprint: "fingerprint",
      payloadDigest: "d".repeat(64), sourceOrigin: "user_reflection", now: NOW,
      contentKind: "user_confirmed_derived_content", sourceSegments: [transcript.segment],
      candidates: [{
        candidateId: "reflection_candidate", operationKey: "reflection_operation",
        status: "admitted", reasonCode: null, memory: independent,
        ownerAttribution: {
          version: 1, memoryId: independent.id, memoryType: independent.type, scope: "unknown",
          owner: { type: "unknown", confidence: 0, source: "unknown" }, participants: [],
          evidenceSegmentIds: [transcript.sourceSegmentId], observations: [], reasons: ["owner_not_applicable"]
        },
        subjectPersonId: "person_self", subjectEvidence: [transcript],
        evidenceDigests: [{ memoryEvidenceId: "standalone_evidence",
          sourceSegmentId: transcript.sourceSegmentId, contentDigest: "e".repeat(64) }]
      }]
    });
    expect(getCards().map((card) => card.id)).toContain(original.id);
    expect(getCards().map((card) => card.id)).not.toContain("standalone_memory");
    expect(person.getPersonTimeline(query)?.timeline.find((entry) => entry.memory.id === original.id)?.sourceAttribution.origin)
      .toBe("direct_conversation");
    // The independently published source has its own explicit subject and receipt.
    reflection.markPublished({ userId: grant.userId, reflectionId: "reflection", now: NOW });
    expect(getCards().map((card) => card.id)).toEqual(expect.arrayContaining([original.id, "standalone_memory"]));
    expect(person.getPersonTimeline(query)?.timeline.some((entry) => entry.memory.id === original.id)).toBe(true);
    expect(hasDateCompanionGrantProjection(memoryDatabase, grant)).toBe(true);

    // Fence alone, before the deferred/outbox-scoped receipt cleanup.
    fenceDateCompanionGrantProjection(memoryDatabase, grant);
    expect(getFencedDateCompanionGrantCategory(memoryDatabase, grant)).toBe("retained");
    expect(getCards().map((card) => card.id)).toEqual(["standalone_memory"]);
    expect(person.getPersonTimeline({ ...query, personId: "person_self" })?.timeline)
      .toEqual([expect.objectContaining({ memory: expect.objectContaining({ id: "standalone_memory" }),
        sourceAttribution: expect.objectContaining({ origin: "user_reflection" }) })]);
    expect(person.getPersonMemories(query)?.memories.some((entry) => entry.memory.id === original.id)).toBe(false);
    expect(person.getPersonTimeline(query)?.timeline.some((entry) => entry.memory.id === original.id)).toBe(false);
    expect(memory.getMemoryRelations(grant.userId).some((edge) => [edge.sourceMemoryId, edge.targetMemoryId].includes(original.id))).toBe(false);
    expect(memoryDatabase.prepare("SELECT 1 FROM person_evidence_dc_links WHERE account_id=?").get(grant.userId)).toBeUndefined();
    expect(memoryDatabase.prepare("SELECT 1 FROM memory_upload_tombstones").get()).toBeUndefined();
    expect(memoryDatabase.prepare("SELECT 1 FROM dc_memory_bridge_receipts WHERE dc_outbox_id=?").get(id)).toBeTruthy();
    expect(hasDateCompanionGrantProjection(memoryDatabase, grant)).toBe(false);
    cleanupDateCompanionGrantProjection(memoryDatabase, grant);
    cleanupDateCompanionGrantProjection(memoryDatabase, grant);
    expect(getCards().map((card) => card.id)).toEqual(["standalone_memory"]);
  });

  it.each(["friend", "dating"] as const)(
    "preserves independently admitted %s evidence with v15 migration defaults", async type => {
      seedPeople();
      const admission = createPersonAdmissionRepository(memoryDatabase);
      const evidence = await validatePersonTranscriptEvidence({
        store: transcriptStore() as unknown as Pick<JsonStore, "read">,
        authenticatedAccountId: "user_a", accountId: "user_a", uploadId: "upload_1",
        sourceSegmentId: "segment_companion", quote: "我最近想去看展"
      });
      const candidate = admission.createRelationshipCandidate({
        accountId: "user_a", personAId: "person_self", personBId: "person_ta",
        type, expectedVersion: 0, evidence, now: NOW
      });
      admission.transitionRelationship({ accountId: "user_a", relationshipId: candidate.id,
        action: "confirm", expectedVersion: candidate.version, now: NOW });
      const { relationship } = await completeRetainedBridge(undefined, true);
      // Migrated pre-v15 links have neither of the newer ownership hints.
      memoryDatabase.prepare(`UPDATE person_evidence_dc_links
        SET independent_person_evidence=0, independent_relationship_edge=0 WHERE account_id=?`).run("user_a");
      const scope = { dateCompanionDatabase: dcDatabase, memoryDatabase, userId: "user_a", relationshipId: relationship.id };
      const { preview } = getDateCompanionWithdrawalPreview(scope);
      expect(purgeDateCompanionRetainedMemory({ ...scope, previewVersion: preview.version }))
        .toMatchObject({ status: "completed", completedCount: 1 });
      expect(memoryDatabase.prepare(`SELECT relationship_id, evidence_id FROM person_relationship_evidence
        WHERE account_id=?`).all("user_a")).toEqual([{ relationship_id: candidate.id, evidence_id: evidence.id }]);
      expect(memoryDatabase.prepare("SELECT quote FROM person_evidence WHERE account_id=? AND id=?")
        .get("user_a", evidence.id)).toEqual({ quote: evidence.quote });
      expect(memoryDatabase.prepare(`SELECT entity_id FROM person_admission_audits WHERE account_id=?
        AND evidence_id=? AND action='relationship_candidate'`).get("user_a", evidence.id)).toEqual({ entity_id: candidate.id });
      expect(memoryDatabase.prepare("SELECT id FROM person_subject_observations WHERE evidence_id=?").all(evidence.id)).toEqual([]);
      expect(memoryDatabase.prepare("SELECT id FROM person_evidence_dc_links WHERE account_id=?").all("user_a")).toEqual([]);
    }
  );

  it("keeps a shared canon and edge until the last supporting bridge grant is withdrawn", async () => {
    const { imported, relationship } = await completeRetainedBridge();
    const { id: outboxId } = dcDatabase.prepare("SELECT id FROM dc_memory_bridge_outbox WHERE interaction_id=?")
      .get(imported.interactionId) as { id: string };
    const first = { userId: "user_a", uploadId: "upload_1", interactionId: imported.interactionId,
      relationshipId: relationship.id, outboxId, generation: 1 };
    const second = { ...first, interactionId: "other_interaction", relationshipId: "other_relationship", outboxId: "other_outbox" };
    // The current Date UI binds an upload to one interaction. Model a second durable
    // grant on the Memory side using its own relationship mapping, receipt and source link.
    memoryDatabase.prepare(`INSERT INTO dc_person_relationship_links
      SELECT account_id, ?, person_relationship_id, mapping_version, self_person_id, companion_person_id,
        relationship_type, status, created_at, updated_at, relationship_epoch
      FROM dc_person_relationship_links WHERE account_id=? AND dc_relationship_id=?`)
      .run(second.relationshipId, first.userId, first.relationshipId);
    memoryDatabase.prepare(`INSERT INTO person_evidence_dc_links
      (id,account_id,person_evidence_id,dc_relationship_id,dc_interaction_id,dc_evidence_snapshot_id,snapshot_digest,created_at)
      SELECT 'second_link',account_id,person_evidence_id,?,?,'second_snapshot',snapshot_digest,created_at
      FROM person_evidence_dc_links WHERE account_id=? AND dc_interaction_id=?`)
      .run(second.relationshipId, second.interactionId, first.userId, first.interactionId);
    memoryDatabase.prepare(`INSERT INTO dc_memory_bridge_receipts
      (id,account_id,idempotency_key,payload_digest,dc_relationship_id,dc_interaction_id,dc_outbox_id,mapping_version,committed_at)
      VALUES ('second_receipt',?,'second_key','second_digest',?,?,?,1,?)`)
      .run(second.userId, second.relationshipId, second.interactionId, second.outboxId, NOW);
    const counts = () => memoryDatabase.prepare(`SELECT
      (SELECT COUNT(*) FROM person_evidence_dc_links WHERE account_id=@userId) AS links,
      (SELECT COUNT(*) FROM person_relationship_evidence WHERE account_id=@userId) AS edges,
      (SELECT COUNT(*) FROM person_subject_observations WHERE account_id=@userId) AS subjects,
      (SELECT COUNT(*) FROM person_evidence WHERE account_id=@userId) AS evidence`).get(first);
    expect(counts()).toEqual({ links: 2, edges: 1, subjects: 1, evidence: 1 });
    fenceDateCompanionGrantProjection(memoryDatabase, first);
    cleanupDateCompanionGrantProjection(memoryDatabase, first);
    fenceDateCompanionGrantProjection(memoryDatabase, first);
    expect(hasDateCompanionGrantProjection(memoryDatabase, second)).toBe(true);
    expect(counts()).toEqual({ links: 1, edges: 1, subjects: 1, evidence: 1 });
    fenceDateCompanionGrantProjection(memoryDatabase, second);
    cleanupDateCompanionGrantProjection(memoryDatabase, second);
    expect(counts()).toEqual({ links: 0, edges: 0, subjects: 0, evidence: 0 });
  });

  it.each([
    { sourceType: "transcript", quote: "我最近想去看展", survives: true },
    { sourceType: "transcript", quote: "同一编号的另一段文字", survives: false },
    { sourceType: "brief", quote: "我最近想去看展", survives: false }
  ] as const)("checks the type and verbatim content of a surviving Memory source: $sourceType / $quote", async source => {
    const { relationship } = await completeRetainedBridge();
    const userId = "user_a";
    const uploadId = "upload_1";
    const memory = createMemoryRepository(memoryDatabase);
    memory.replaceUploadMemories({ userId, uploadId, memories: [{
      id: "unrelated_memory", title: "另一份已保存资料", summary: "另一份已保存资料",
      type: "event", importance: 0.8, date: "2026-08-11", createdAt: NOW, updatedAt: NOW,
      evidence: [{ id: "unrelated_evidence", sourceId: "segment_companion", sourceType: "transcript",
        uploadId, date: "2026-08-11", quote: source.quote, createdAt: NOW }]
    }] });
    // Old Memory DBs can contain a non-transcript source at the same locator.
    memoryDatabase.prepare("UPDATE memory_evidence SET source_type=? WHERE id='unrelated_evidence'").run(source.sourceType);
    const scope = { dateCompanionDatabase: dcDatabase, memoryDatabase, userId, relationshipId: relationship.id };
    const { preview } = getDateCompanionWithdrawalPreview(scope);
    expect(purgeDateCompanionRetainedMemory({ ...scope, previewVersion: preview.version }).status).toBe("completed");
    expect(memoryDatabase.prepare("SELECT quote FROM person_evidence WHERE account_id=?").all(userId))
      .toEqual(source.survives ? [{ quote: source.quote }] : []);
    expect(memory.getRelevantMemories({ userId, uploadId }).flatMap(item => item.evidence))
      .toEqual([expect.objectContaining({ id: "unrelated_evidence", quote: source.quote })]);
  });

  it("rechecks fact support after repair or withdrawal while preserving an independent relationship and fact", async () => {
    const { relationship, imported } = await completeRetainedBridge();
    const accountId = "user_a";
    const subjectPersonId = "person_ta";
    const store = transcriptStore() as unknown as Pick<JsonStore, "read">;
    const source = { store, accountId, authenticatedAccountId: accountId, uploadId: "upload_1" };
    const evidence = await validatePersonTranscriptEvidence({ ...source, sourceSegmentId: "segment_companion", quote: "我最近想去看展" });
    const otherEvidence = await validatePersonTranscriptEvidence({ ...source, sourceSegmentId: "segment_unknown", quote: "这件事还不确定" });
    const people = createPersonAdmissionRepository(memoryDatabase);
    const friend = people.createRelationshipCandidate({ accountId, personAId: "person_self", personBId: subjectPersonId,
      type: "friend", expectedVersion: 0, evidence });
    people.transitionRelationship({ accountId, relationshipId: friend.id, action: "confirm", expectedVersion: friend.version });
    people.recordSubjectAdmission({ accountId, personId: subjectPersonId, disposition: "confirmed", expectedVersion: 0,
      evidence: otherEvidence });
    const facts = createTemporalFactRepository(memoryDatabase);
    const fields = { accountId, subjectPersonId, kind: "preference", observedAt: NOW, validFrom: NOW };
    const dateFact = facts.createFact({ ...fields, factKey: "exhibition", derivedText: "想去看展", evidence });
    const otherFact = facts.createFact({ ...fields, factKey: "undecided", derivedText: "还没有决定", evidence: otherEvidence });
    // Multiple source edges for one fact are supported by the Memory schema.
    memoryDatabase.prepare(`INSERT INTO person_fact_evidence(id,account_id,fact_id,evidence_id,created_at)
      VALUES ('additional_fact_evidence',?,?,?,?)`).run(accountId, otherFact.id, evidence.id, NOW);
    const later = "2026-08-12T12:00:00.000Z";
    facts.resolveFact({ accountId, factId: otherFact.id, observedAt: later, occurredAt: later, expectedVersion: 1, evidence });

    // Replay the formal Worker from the legacy, pre-candidate-receipt shape.
    const { id, idempotency_key: legacyKey } = dcDatabase.prepare(`SELECT id,idempotency_key FROM dc_memory_bridge_outbox
      WHERE user_id=? AND interaction_id=?`).get(accountId, imported.interactionId) as { id: string; idempotency_key: string };
    memoryDatabase.prepare("DELETE FROM dc_memory_bridge_candidate_receipts WHERE account_id=? AND dc_outbox_id=?").run(accountId, id);
    memoryDatabase.prepare("UPDATE dc_memory_bridge_receipts SET id='legacy_operation',idempotency_key=? WHERE account_id=? AND dc_outbox_id=?")
      .run(legacyKey, accountId, id);
    expect(requeueCompletedLegacyMemoryProjections({ dateCompanionDatabase: dcDatabase, memoryDatabase }).requeued).toBe(1);
    await expect(processDateCompanionMemoryBridgeInteraction({ dateCompanionDatabase: dcDatabase,
      memoryDatabase, userId: accountId, interactionId: imported.interactionId })).resolves.toMatchObject({ completed: true });
    expect(facts.getFact(accountId, dateFact.id)?.evidence.map(item => item.id)).toEqual([evidence.id]);
    expect(facts.getFact(accountId, otherFact.id)).toMatchObject({ status: "resolved", version: 2 });

    const scope = { dateCompanionDatabase: dcDatabase, memoryDatabase, userId: accountId, relationshipId: relationship.id };
    const { preview } = getDateCompanionWithdrawalPreview(scope);
    expect(purgeDateCompanionRetainedMemory({ ...scope, previewVersion: preview.version }).status).toBe("completed");
    expect(memoryDatabase.prepare("SELECT evidence_id FROM person_relationship_evidence WHERE account_id=? AND relationship_id=?")
      .all(accountId, friend.id)).toEqual([{ evidence_id: evidence.id }]);
    expect(facts.getFact(accountId, dateFact.id)).toBeNull();
    expect(facts.getFact(accountId, otherFact.id)).toMatchObject({
      evidence: [expect.objectContaining({ id: otherEvidence.id })], status: "active", version: 1, transitions: []
    });
    expect(facts.listFactsForPerson(accountId, subjectPersonId).map(fact => fact.id)).toEqual([otherFact.id]);
  });

  it("R14 preserves the same person's grant from another relationship and another account's card", async () => {
    const other = await processSinglePromiseCandidate({ uploadId: "other_relationship_upload", segmentId: "other_segment",
      quote: "我答应明天联系展览馆，确认想去看展的时间。" });
    const memory = createMemoryRepository(memoryDatabase);
    const original = memory.getRelevantMemories({ userId: "user_a", uploadId: "other_relationship_upload" })[0]!;
    expect(original.evidence[0]!.sourceId).toBe("other_segment");
    // Only one active DC relationship is allowed. Keep the previous one archived
    // with the same pair of confirmed people, then create the current relationship.
    dcDatabase.prepare("UPDATE dc_relationships SET status='archived' WHERE id=?").run(other.relationship.id);
    const { relationship } = await completeRetainedBridge(undefined, true);
    memory.replaceUploadMemories({ userId: "user_b", uploadId: "upload_1", memories: [{
      ...original, id: "other_account_same_upload", evidence: [{ ...original.evidence[0]!,
        id: "other_account_evidence", uploadId: "upload_1" }]
    }] });
    const scope = { dateCompanionDatabase: dcDatabase, memoryDatabase, userId: "user_a", relationshipId: relationship.id };
    const {preview} = getDateCompanionWithdrawalPreview(scope);
    expect(preview).toMatchObject({ totalCount: 1, retainedCount: 1 });
    expect(purgeDateCompanionRetainedMemory({ ...scope, previewVersion: preview.version })).toMatchObject({ completedCount: 1 });
    expect(memory.getRelevantMemories({ userId: "user_b" }).map((m) => m.id)).toEqual(["other_account_same_upload"]);
    expect(memory.getRelevantMemories({ userId: "user_a" }).map((m) => m.id)).toEqual([original.id]);
    expect(memoryDatabase.prepare("SELECT DISTINCT dc_relationship_id FROM person_evidence_dc_links").all())
      .toEqual([{ dc_relationship_id: other.relationship.id }]);
    expect(dcDatabase.prepare("SELECT status FROM dc_memory_bridge_outbox WHERE interaction_id=?")
      .get(other.imported.interactionId)).toEqual({ status: "completed" });
  });

  it("R14 refuses a historical permanent upload tombstone even if a matching worker receipt survived", async () => {
    await expect(completeRetainedBridge(() => {
      throw new Error("simulated_missing_ack");
    })).rejects.toThrow("simulated_missing_ack");
    const original = memoryDatabase.prepare("SELECT dc_interaction_id AS interactionId FROM dc_memory_bridge_receipts")
      .get() as { interactionId: string };
    memoryDatabase.prepare(`INSERT INTO memory_upload_tombstones (user_id,upload_id,reason,deleted_at)
      VALUES ('user_a','upload_1','upload_deleted',?)`).run(NOW);
    await expect(processDateCompanionMemoryBridgeInteraction({
      dateCompanionDatabase: dcDatabase, memoryDatabase, userId: "user_a", interactionId: original.interactionId
    })).rejects.toThrow("memory_bridge_source_deleted");
    expect(dcDatabase.prepare("SELECT status FROM dc_memory_bridge_outbox WHERE interaction_id=?").get(original.interactionId))
      .toEqual({ status: "needs_review" });
  });

  it("R14 withdraws after a real Memory commit before the worker acknowledges the old lease", async () => {
    let receipt;
    await expect(completeRetainedBridge(() => {
      const { relationship_id, status } = dcDatabase.prepare("SELECT relationship_id,status FROM dc_memory_bridge_outbox")
        .get() as { relationship_id: string; status: string };
      expect(status).toBe("processing");
      const scope = { userId: "user_a", relationshipId: relationship_id, dateCompanionDatabase: dcDatabase, memoryDatabase };
      const { preview } = getDateCompanionWithdrawalPreview(scope);
      expect(preview.retainedCount).toBe(1);
      receipt = purgeDateCompanionRetainedMemory({ ...scope, previewVersion: preview.version });
    })).rejects.toThrow();
    expect(receipt).toMatchObject({ usageStopped: true, completedCount: 1 });
    expect(memoryDatabase.prepare("SELECT 1 FROM memory_evidence").get()).toBeUndefined();
    expect(dcDatabase.prepare("SELECT 1 FROM dc_memory_bridge_outbox").get()).toBeUndefined();
    expect(memoryDatabase.prepare("SELECT 1 FROM dc_memory_bridge_receipts").get()).toBeUndefined();
    expect(dcDatabase.prepare("SELECT status FROM dc_interactions").get()).toEqual({ status: "confirmed" });
  });

  async function prepareLegacyCompletedProjection() {
    seedPeople();
    const { relationship, imported } = importDraft();
    const bridge = createDateCompanionMemoryBridgeRepository(dcDatabase);
    bridge.putRetentionSetting({ userId: "user_a", enabled: true, expectedVersion: 0 });
    const mapping = bridge.putPersonMapping({
      userId: "user_a",
      relationshipId: relationship.id,
      selfPersonId: "person_self",
      companionPersonId: "person_ta",
      relationshipType: "dating",
      expectedVersion: 0
    });
    const detail = dcRepository.getRelationshipView("user_a", relationship.id).interactions[0];
    const admittedItem = detail.recapItems.find((item) =>
      item.evidence.some((evidence) => evidence.sourceSegmentId === "segment_companion")
    )!;
    const confirmation = await subjectConfirmation(imported.interactionId, [admittedItem.id]);
    dcRepository.updateRecap({
      userId: "user_a",
      interactionId: imported.interactionId,
      version: 0,
      assignments: [
        { speakerId: "speaker_0", role: "self" },
        { speakerId: "speaker_1", role: "companion" }
      ],
      mutations: detail.recapItems.map((item) => ({
        id: item.id,
        version: item.version,
        disposition: item.id === admittedItem.id ? "kept" as const : "excluded" as const
      })),
      memoryAdmission: {
        mappingVersion: mapping.version,
        subjectSuggestionConfirmation: confirmation,
        selections: [{
          evidenceSnapshotId: admittedItem.evidence[0].id,
          subject: "companion"
        }]
      },
      finalize: true
    });
    await expect(captureRetainedMemoryEvidenceProvenance({
      database: memoryDatabase,
      store: transcriptStore() as unknown as Pick<JsonStore, "read">,
      userId: "user_a",
      uploadId: "upload_1",
      relationshipId: relationship.id,
      interactionId: imported.interactionId,
      now: NOW
    })).resolves.toMatchObject({ provenanceCount: 0 });
    expect(dcRepository.markUploadSourceState("user_a", "upload_1", "server_cleaned"))
      .toBe(true);
    const outbox = dcDatabase.prepare(`
      SELECT id, idempotency_key, payload_digest
      FROM dc_memory_bridge_outbox
      WHERE user_id = 'user_a' AND interaction_id = ?
    `).get(imported.interactionId) as {
      id: string;
      idempotency_key: string;
      payload_digest: string;
    };
    memoryDatabase.prepare(`
      INSERT INTO dc_memory_bridge_receipts (
        id, account_id, idempotency_key, payload_digest, dc_relationship_id,
        dc_interaction_id, dc_outbox_id, mapping_version, committed_at
      ) VALUES (?, 'user_a', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `legacy_receipt_${imported.interactionId}`,
      outbox.idempotency_key,
      outbox.payload_digest,
      relationship.id,
      imported.interactionId,
      outbox.id,
      mapping.version,
      NOW
    );
    dcDatabase.prepare(`
      UPDATE dc_memory_bridge_outbox
      SET status = 'completed', claim_token = NULL, lease_expires_at = NULL,
          last_error_code = NULL, completed_at = ?, updated_at = ?
      WHERE id = ? AND user_id = 'user_a'
    `).run(NOW, NOW, outbox.id);
    return { imported, bridge, outbox };
  }

  it("applies the current bridge schemas additively and keeps foreign keys and integrity healthy", () => {
    expect(dcDatabase.prepare("SELECT MAX(version) AS version FROM dc_schema_migrations").get())
      .toEqual({ version: DATE_COMPANION_SCHEMA_VERSION });
    expect(memoryDatabase.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: MEMORY_SCHEMA_VERSION });
    expect(dcDatabase.pragma("foreign_key_check")).toEqual([]);
    expect(memoryDatabase.pragma("foreign_key_check")).toEqual([]);
    expect(dcDatabase.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(memoryDatabase.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("requeues one completed legacy bridge and projects formal Memory exactly once", async () => {
    const { imported, bridge } = await prepareLegacyCompletedProjection();
    expect(memoryDatabase.prepare(`
      SELECT
        (SELECT COUNT(*) FROM dc_memory_bridge_receipts) AS operation_receipts,
        (SELECT COUNT(*) FROM dc_memory_bridge_candidate_receipts) AS candidate_receipts,
        (SELECT COUNT(*) FROM memory_items WHERE user_id = 'user_a') AS memories
    `).get()).toEqual({ operation_receipts: 1, candidate_receipts: 0, memories: 0 });

    expect(requeueCompletedLegacyMemoryProjections({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      now: "2026-08-11T00:00:01.000Z"
    })).toEqual({ scanned: 1, requeued: 1 });
    expect(bridge.getInteractionBridgeStatus("user_a", imported.interactionId))
      .toMatchObject({ status: "pending" });
    await expect(processNextDateCompanionMemoryBridge({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      now: "2026-08-11T00:00:02.000Z"
    })).resolves.toMatchObject({ completed: true, idempotent: false });
    expect(memoryDatabase.prepare(`
      SELECT
        (SELECT COUNT(*) FROM dc_memory_bridge_receipts) AS operation_receipts,
        (SELECT COUNT(*) FROM dc_memory_bridge_candidate_receipts) AS candidate_receipts,
        (SELECT COUNT(*) FROM memory_items WHERE user_id = 'user_a') AS memories,
        (SELECT COUNT(*) FROM memory_evidence WHERE upload_id = 'upload_1') AS evidence,
        (SELECT COALESCE(SUM(occurrence_count), 0)
          FROM memory_items WHERE user_id = 'user_a') AS occurrences
    `).get()).toEqual({
      operation_receipts: 2,
      candidate_receipts: 1,
      memories: 1,
      evidence: 1,
      occurrences: 1
    });
    expect(requeueCompletedLegacyMemoryProjections({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      now: "2026-08-11T00:00:03.000Z"
    })).toEqual({ scanned: 1, requeued: 0 });
    await expect(processNextDateCompanionMemoryBridge({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      now: "2026-08-11T00:00:04.000Z"
    })).resolves.toBeNull();
    expect(memoryDatabase.prepare(`
      SELECT
        (SELECT COUNT(*) FROM dc_memory_bridge_candidate_receipts) AS candidate_receipts,
        (SELECT COUNT(*) FROM memory_items WHERE user_id = 'user_a') AS memories,
        (SELECT COUNT(*) FROM memory_evidence WHERE upload_id = 'upload_1') AS evidence,
        (SELECT COALESCE(SUM(occurrence_count), 0)
          FROM memory_items WHERE user_id = 'user_a') AS occurrences
    `).get()).toEqual({ candidate_receipts: 1, memories: 1, evidence: 1, occurrences: 1 });
  });

  it("periodically discovers a legacy completion that arrives after the worker's first repair scan", async () => {
    await expect(processNextDateCompanionMemoryBridge({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      now: "2026-08-11T00:00:00.000Z"
    })).resolves.toBeNull();
    const { imported, bridge } = await prepareLegacyCompletedProjection();

    await expect(processNextDateCompanionMemoryBridge({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      now: "2026-08-11T00:00:30.000Z"
    })).resolves.toBeNull();
    expect(bridge.getInteractionBridgeStatus("user_a", imported.interactionId))
      .toMatchObject({ status: "completed" });

    await expect(processNextDateCompanionMemoryBridge({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      now: "2026-08-11T00:01:01.000Z"
    })).resolves.toMatchObject({ completed: true, idempotent: false });
    expect(bridge.getInteractionBridgeStatus("user_a", imported.interactionId))
      .toMatchObject({ status: "completed" });
    expect(memoryDatabase.prepare(`
      SELECT
        (SELECT COUNT(*) FROM dc_memory_bridge_candidate_receipts) AS candidate_receipts,
        (SELECT COUNT(*) FROM memory_items WHERE user_id = 'user_a') AS memories,
        (SELECT COUNT(*) FROM memory_evidence WHERE upload_id = 'upload_1') AS evidence
    `).get()).toEqual({ candidate_receipts: 1, memories: 1, evidence: 1 });
  });

  it("removes a legacy bridge-owned Person projection when formal replay rejects its candidate", async () => {
    seedPeople();
    const { relationship, imported } = importFormalAdmissionDraft();
    const bridge = createDateCompanionMemoryBridgeRepository(dcDatabase);
    const mapping = bridge.putPersonMapping({
      userId: "user_a",
      relationshipId: relationship.id,
      selfPersonId: "person_self",
      companionPersonId: "person_ta",
      relationshipType: "dating",
      expectedVersion: 0
    });
    const detail = dcRepository.getRelationshipView("user_a", relationship.id).interactions[0]!;
    const rejectedItem = detail.recapItems.find((item) =>
      item.evidence.some((evidence) => evidence.sourceSegmentId === "segment_formal_rejected")
    )!;
    const confirmation = await subjectConfirmation(imported.interactionId, [rejectedItem.id]);
    dcRepository.updateRecap({
      userId: "user_a",
      interactionId: imported.interactionId,
      version: 0,
      assignments: [
        { speakerId: "speaker_0", role: "self" },
        { speakerId: "speaker_1", role: "companion" }
      ],
      mutations: detail.recapItems.map((item) => ({
        id: item.id,
        version: item.version,
        disposition: item.id === rejectedItem.id ? "kept" as const : "excluded" as const
      })),
      memoryAdmission: {
        mappingVersion: mapping.version,
        subjectSuggestionConfirmation: confirmation,
        selections: [{
          evidenceSnapshotId: rejectedItem.evidence[0]!.id,
          subject: "companion"
        }]
      },
      finalize: true
    });
    await expect(captureRetainedMemoryEvidenceProvenance({
      database: memoryDatabase,
      store: formalAdmissionTranscriptStore() as unknown as Pick<JsonStore, "read">,
      userId: "user_a",
      uploadId: "upload_formal",
      relationshipId: relationship.id,
      interactionId: imported.interactionId,
      now: NOW
    })).resolves.toMatchObject({ provenanceCount: 0 });
    expect(dcRepository.markUploadSourceState("user_a", "upload_formal", "server_cleaned"))
      .toBe(true);

    const snapshot = dcDatabase.prepare(`
      SELECT id, content_digest, quote FROM dc_evidence_snapshots
      WHERE user_id = 'user_a' AND id = ?
    `).get(rejectedItem.evidence[0]!.id) as {
      id: string;
      content_digest: string;
      quote: string;
    };
    const outbox = dcDatabase.prepare(`
      SELECT id, idempotency_key, payload_digest FROM dc_memory_bridge_outbox
      WHERE user_id = 'user_a' AND interaction_id = ?
    `).get(imported.interactionId) as {
      id: string;
      idempotency_key: string;
      payload_digest: string;
    };
    memoryDatabase.transaction(() => {
      memoryDatabase.prepare(`
        INSERT INTO person_evidence (
          id, account_id, upload_id, source_segment_id, quote, created_at, updated_at
        ) VALUES (
          'legacy_person_evidence', 'user_a', 'upload_formal',
          'segment_formal_rejected', ?, ?, ?
        )
      `).run(snapshot.quote, NOW, NOW);
      memoryDatabase.prepare(`
        INSERT INTO person_evidence_dc_links (
          id, account_id, person_evidence_id, dc_relationship_id,
          dc_interaction_id, dc_evidence_snapshot_id, snapshot_digest, created_at
        ) VALUES (
          'legacy_person_link', 'user_a', 'legacy_person_evidence', ?, ?, ?, ?, ?
        )
      `).run(relationship.id, imported.interactionId, snapshot.id, snapshot.content_digest, NOW);
      memoryDatabase.prepare(`
        INSERT INTO person_evidence (
          id, account_id, upload_id, source_segment_id, quote, created_at, updated_at
        ) VALUES (
          'legacy_person_evidence_preserved', 'user_a', 'upload_formal',
          'segment_formal_preserved', '需要由其他人物资料继续引用的原话', ?, ?
        )
      `).run(NOW, NOW);
      memoryDatabase.prepare(`
        INSERT INTO person_evidence_dc_links (
          id, account_id, person_evidence_id, dc_relationship_id,
          dc_interaction_id, dc_evidence_snapshot_id, snapshot_digest, created_at
        ) VALUES (
          'legacy_person_link_preserved', 'user_a',
          'legacy_person_evidence_preserved', ?, ?, ?, ?, ?
        )
      `).run(relationship.id, imported.interactionId, snapshot.id, snapshot.content_digest, NOW);
      memoryDatabase.prepare(`
        INSERT INTO person_names (
          id, account_id, person_id, evidence_id, name, normalized_name,
          kind, status, source, created_at, updated_at
        ) VALUES (
          'legacy_person_name_preserved', 'user_a', 'person_ta',
          'legacy_person_evidence_preserved', 'Ta 的别名', 'ta 的别名',
          'alias', 'confirmed', 'manual_confirmation', ?, ?
        )
      `).run(NOW, NOW);
      memoryDatabase.prepare(`
        INSERT INTO person_relationships (
          id, account_id, person_a_id, person_b_id, type, status,
          explicitly_confirmed, confirmed_at, created_at, updated_at
        ) VALUES (
          'legacy_person_relationship', 'user_a', 'person_self', 'person_ta',
          'dating', 'confirmed', 1, ?, ?, ?
        )
      `).run(NOW, NOW, NOW);
      memoryDatabase.prepare(`
        INSERT INTO person_relationship_admissions (
          account_id, relationship_id, version, created_at, updated_at
        ) VALUES ('user_a', 'legacy_person_relationship', 1, ?, ?)
      `).run(NOW, NOW);
      memoryDatabase.prepare(`
        INSERT INTO person_relationship_evidence (
          id, account_id, relationship_id, evidence_id, created_at
        ) VALUES (
          'legacy_relationship_evidence', 'user_a', 'legacy_person_relationship',
          'legacy_person_evidence', ?
        )
      `).run(NOW);
      memoryDatabase.prepare(`
        INSERT INTO dc_person_relationship_links (
          account_id, dc_relationship_id, person_relationship_id, mapping_version,
          self_person_id, companion_person_id, relationship_type, status,
          created_at, updated_at, relationship_epoch
        ) VALUES (
          'user_a', ?, 'legacy_person_relationship', ?, 'person_self', 'person_ta',
          'dating', 'active', ?, ?, 0
        )
      `).run(relationship.id, mapping.version, NOW, NOW);
      memoryDatabase.prepare(`
        INSERT INTO person_subject_observations (
          id, account_id, person_id, evidence_id, status, source, reason,
          confirmed_at, created_at, updated_at
        ) VALUES (
          'legacy_subject_observation', 'user_a', 'person_ta',
          'legacy_person_evidence', 'confirmed', 'manual_review',
          'date_companion_qwen_batch_review_v1', ?, ?, ?
        )
      `).run(NOW, NOW, NOW);
      memoryDatabase.prepare(`
        INSERT INTO person_subject_admissions (
          id, account_id, evidence_id, person_id, subject_key, observation_id,
          disposition, version, created_at, updated_at
        ) VALUES (
          'legacy_subject_admission', 'user_a', 'legacy_person_evidence',
          'person_ta', 'person_ta', 'legacy_subject_observation',
          'confirmed', 1, ?, ?
        )
      `).run(NOW, NOW);
      memoryDatabase.prepare(`
        INSERT INTO dc_memory_bridge_receipts (
          id, account_id, idempotency_key, payload_digest, dc_relationship_id,
          dc_interaction_id, dc_outbox_id, mapping_version, committed_at
        ) VALUES (
          'legacy_rejected_operation', 'user_a', ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        outbox.idempotency_key,
        outbox.payload_digest,
        relationship.id,
        imported.interactionId,
        outbox.id,
        mapping.version,
        NOW
      );
    })();
    dcDatabase.prepare(`
      UPDATE dc_memory_bridge_outbox
      SET status = 'completed', claim_token = NULL, lease_expires_at = NULL,
          last_error_code = NULL, completed_at = ?, updated_at = ?
      WHERE id = ? AND user_id = 'user_a'
    `).run(NOW, NOW, outbox.id);

    expect(requeueCompletedLegacyMemoryProjections({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      now: "2026-08-11T00:00:01.000Z"
    })).toEqual({ scanned: 1, requeued: 1 });
    await expect(processDateCompanionMemoryBridgeInteraction({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      userId: "user_a",
      interactionId: imported.interactionId
    })).resolves.toMatchObject({ completed: true, idempotent: false });

    expect(memoryDatabase.prepare(`
      SELECT
        (SELECT COUNT(*) FROM memory_items WHERE user_id = 'user_a') AS memories,
        (SELECT COUNT(*) FROM memory_evidence WHERE upload_id = 'upload_formal') AS memory_evidence,
        (SELECT COUNT(*) FROM person_evidence_dc_links
          WHERE account_id = 'user_a' AND dc_interaction_id = ?) AS person_links,
        (SELECT COUNT(*) FROM person_subject_observations
          WHERE account_id = 'user_a' AND evidence_id = 'legacy_person_evidence') AS subjects,
        (SELECT COUNT(*) FROM person_subject_admissions
          WHERE account_id = 'user_a' AND evidence_id = 'legacy_person_evidence') AS subject_admissions,
        (SELECT COUNT(*) FROM person_relationship_evidence
          WHERE account_id = 'user_a' AND evidence_id = 'legacy_person_evidence') AS relationship_evidence,
        (SELECT COUNT(*) FROM person_evidence
          WHERE account_id = 'user_a' AND id = 'legacy_person_evidence') AS orphan_person_evidence,
        (SELECT COUNT(*) FROM person_evidence
          WHERE account_id = 'user_a'
            AND id = 'legacy_person_evidence_preserved') AS referenced_person_evidence,
        (SELECT COUNT(*) FROM person_names
          WHERE account_id = 'user_a'
            AND evidence_id = 'legacy_person_evidence_preserved') AS retained_non_bridge_reference,
        (SELECT COUNT(*) FROM dc_person_relationship_links
          WHERE account_id = 'user_a' AND dc_relationship_id = ? AND status = 'active') AS active_relationship_links
    `).get(imported.interactionId, relationship.id)).toEqual({
      memories: 0,
      memory_evidence: 0,
      person_links: 0,
      subjects: 0,
      subject_admissions: 0,
      relationship_evidence: 0,
      orphan_person_evidence: 0,
      referenced_person_evidence: 1,
      retained_non_bridge_reference: 1,
      active_relationship_links: 0
    });
    expect(memoryDatabase.prepare(`
      SELECT recap_item_id, status, memory_id FROM dc_memory_bridge_candidate_receipts
      WHERE account_id = 'user_a' AND dc_interaction_id = ?
    `).get(imported.interactionId)).toEqual({
      recap_item_id: rejectedItem.id,
      status: "rejected",
      memory_id: null
    });
    expect(memoryDatabase.prepare(`
      SELECT status FROM person_relationships
      WHERE id = 'legacy_person_relationship' AND account_id = 'user_a'
    `).get()).toEqual({ status: "archived" });
    expect(createPersonMemoryRepository(memoryDatabase)
      .getPersonMemories({ accountId: "user_a", personId: "person_ta" })?.memories ?? [])
      .toEqual([]);
  });

  it("clears the prior Person projection when an allowRepair payload changes key and mapping on the same outbox", async () => {
    const { relationship, imported, bridge } = await completeRetainedBridge();
    const priorOutbox = dcDatabase.prepare(`
      SELECT id, idempotency_key, payload_digest FROM dc_memory_bridge_outbox
      WHERE user_id = 'user_a' AND interaction_id = ?
    `).get(imported.interactionId) as {
      id: string;
      idempotency_key: string;
      payload_digest: string;
    };
    const priorPersonRelationship = memoryDatabase.prepare(`
      SELECT r.id
      FROM person_relationships r
      INNER JOIN dc_person_relationship_links link
        ON link.account_id = r.account_id AND link.person_relationship_id = r.id
      WHERE r.account_id = 'user_a' AND link.dc_relationship_id = ?
    `).get(relationship.id) as { id: string };
    expect(memoryDatabase.prepare(`
      SELECT
        (SELECT COUNT(*) FROM person_subject_observations
          WHERE account_id = 'user_a' AND person_id = 'person_ta'
            AND status = 'confirmed') AS old_subjects,
        (SELECT COUNT(*) FROM person_relationship_evidence
          WHERE account_id = 'user_a' AND relationship_id = ?) AS old_relationship_evidence,
        (SELECT COUNT(*) FROM dc_memory_bridge_receipts
          WHERE account_id = 'user_a' AND dc_outbox_id = ?) AS prior_receipts
    `).get(priorPersonRelationship.id, priorOutbox.id)).toEqual({
      old_subjects: 1,
      old_relationship_evidence: 1,
      prior_receipts: 1
    });

    memoryDatabase.prepare(`
      INSERT INTO person_entities (
        id, account_id, display_name, source, status, created_at, updated_at
      ) VALUES (
        'person_ta_repaired', 'user_a', 'Ta（重新选择）',
        'manual_confirmation', 'confirmed', ?, ?
      )
    `).run(NOW, NOW);
    dcDatabase.prepare(`
      UPDATE dc_memory_bridge_outbox
      SET status = 'needs_review', last_error_code = 'person_mapping_required',
          claim_token = NULL, lease_expires_at = NULL, completed_at = NULL,
          updated_at = ?
      WHERE id = ? AND user_id = 'user_a'
    `).run("2026-08-11T00:00:01.000Z", priorOutbox.id);
    const repairedMapping = bridge.putPersonMapping({
      userId: "user_a",
      relationshipId: relationship.id,
      selfPersonId: "person_self",
      companionPersonId: "person_ta_repaired",
      relationshipType: "dating",
      expectedVersion: 1
    });
    const repairedConfirmation = await subjectConfirmation(imported.interactionId);
    const repairedSelections = dcDatabase.prepare(`
      SELECT evidence_snapshot_id, subject
      FROM dc_memory_subject_selections
      WHERE user_id = 'user_a' AND interaction_id = ?
      ORDER BY evidence_snapshot_id
    `).all(imported.interactionId) as Array<{
      evidence_snapshot_id: string;
      subject: "self" | "companion" | "both" | "unknown";
    }>;
    bridge.queueInteractionSync({
      userId: "user_a",
      interactionId: imported.interactionId,
      mappingVersion: repairedMapping.version,
      subjectSuggestionConfirmation: repairedConfirmation,
      selections: repairedSelections.map((selection) => ({
        evidenceSnapshotId: selection.evidence_snapshot_id,
        subject: selection.subject
      }))
    });
    const repairedOutbox = dcDatabase.prepare(`
      SELECT id, idempotency_key, payload_digest, status, mapping_version
      FROM dc_memory_bridge_outbox
      WHERE user_id = 'user_a' AND interaction_id = ?
    `).get(imported.interactionId) as {
      id: string;
      idempotency_key: string;
      payload_digest: string;
      status: string;
      mapping_version: number;
    };
    expect(repairedOutbox).toMatchObject({
      id: priorOutbox.id,
      status: "pending",
      mapping_version: 2
    });
    expect(repairedOutbox.idempotency_key).not.toBe(priorOutbox.idempotency_key);
    expect(repairedOutbox.payload_digest).not.toBe(priorOutbox.payload_digest);

    await expect(processDateCompanionMemoryBridgeInteraction({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      userId: "user_a",
      interactionId: imported.interactionId
    })).resolves.toMatchObject({ completed: true, idempotent: false });

    const activeLink = memoryDatabase.prepare(`
      SELECT person_relationship_id, mapping_version, self_person_id,
             companion_person_id, status
      FROM dc_person_relationship_links
      WHERE account_id = 'user_a' AND dc_relationship_id = ?
    `).get(relationship.id) as {
      person_relationship_id: string;
      mapping_version: number;
      self_person_id: string;
      companion_person_id: string;
      status: string;
    };
    expect(activeLink).toMatchObject({
      mapping_version: 2,
      self_person_id: "person_self",
      companion_person_id: "person_ta_repaired",
      status: "active"
    });
    expect(activeLink.person_relationship_id).not.toBe(priorPersonRelationship.id);
    expect(memoryDatabase.prepare(`
      SELECT
        (SELECT COUNT(*) FROM person_subject_observations
          WHERE account_id = 'user_a' AND person_id = 'person_ta'
            AND status = 'confirmed') AS old_subjects,
        (SELECT COUNT(*) FROM person_subject_observations
          WHERE account_id = 'user_a' AND person_id = 'person_ta_repaired'
            AND status = 'confirmed') AS repaired_subjects,
        (SELECT COUNT(*) FROM person_relationship_evidence
          WHERE account_id = 'user_a' AND relationship_id = ?) AS old_relationship_evidence,
        (SELECT COUNT(*) FROM person_relationship_evidence
          WHERE account_id = 'user_a' AND relationship_id = ?) AS repaired_relationship_evidence,
        (SELECT COUNT(*) FROM person_evidence_dc_links
          WHERE account_id = 'user_a' AND dc_interaction_id = ?) AS current_person_links
    `).get(
      priorPersonRelationship.id,
      activeLink.person_relationship_id,
      imported.interactionId
    )).toEqual({
      old_subjects: 0,
      repaired_subjects: 1,
      old_relationship_evidence: 0,
      repaired_relationship_evidence: 1,
      current_person_links: 1
    });
    expect(memoryDatabase.prepare(`
      SELECT status FROM person_relationships
      WHERE account_id = 'user_a' AND id = ?
    `).get(priorPersonRelationship.id)).toEqual({ status: "archived" });
    expect(createPersonMemoryRepository(memoryDatabase)
      .getPersonMemories({ accountId: "user_a", personId: "person_ta" })?.memories ?? [])
      .toEqual([]);
    expect(createPersonMemoryRepository(memoryDatabase)
      .getPersonMemories({ accountId: "user_a", personId: "person_ta_repaired" })?.memories)
      .toHaveLength(1);
  });

  it("moves a stale confirmed Person mapping to needs_review and permits an explicit remap repair", async () => {
    const { imported, bridge, outbox } = await prepareLegacyCompletedProjection();
    memoryDatabase.prepare(`
      DELETE FROM dc_memory_bridge_receipts
      WHERE account_id = 'user_a' AND dc_outbox_id = ?
    `).run(outbox.id);
    dcDatabase.prepare(`
      UPDATE dc_memory_bridge_outbox
      SET status = 'pending', claim_token = NULL, lease_expires_at = NULL,
          last_error_code = NULL, completed_at = NULL, updated_at = ?
      WHERE id = ? AND user_id = 'user_a'
    `).run(NOW, outbox.id);
    memoryDatabase.prepare(`
      UPDATE person_entities SET status = 'archived', updated_at = ?
      WHERE id = 'person_ta' AND account_id = 'user_a'
    `).run("2026-08-11T00:00:01.000Z");

    await expect(processDateCompanionMemoryBridgeInteraction({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      userId: "user_a",
      interactionId: imported.interactionId
    })).rejects.toThrow("confirmed_person_mapping_stale");
    expect(bridge.getInteractionBridgeStatus("user_a", imported.interactionId))
      .toMatchObject({ status: "needs_review", attemptCount: 1, retryable: true });
    expect(dcDatabase.prepare(`
      SELECT status, last_error_code FROM dc_memory_bridge_outbox
      WHERE id = ? AND user_id = 'user_a'
    `).get(outbox.id)).toEqual({
      status: "needs_review",
      last_error_code: "confirmed_person_mapping_stale"
    });

    memoryDatabase.prepare(`
      INSERT INTO person_entities (
        id, account_id, display_name, source, status, created_at, updated_at
      ) VALUES (
        'person_ta_after_stale', 'user_a', 'Ta（重新确认）',
        'manual_confirmation', 'confirmed', ?, ?
      )
    `).run(NOW, NOW);
    const repairedMapping = bridge.putPersonMapping({
      userId: "user_a",
      relationshipId: (dcDatabase.prepare(`
        SELECT relationship_id FROM dc_interactions
        WHERE user_id = 'user_a' AND id = ?
      `).get(imported.interactionId) as { relationship_id: string }).relationship_id,
      selfPersonId: "person_self",
      companionPersonId: "person_ta_after_stale",
      relationshipType: "dating",
      expectedVersion: 1
    });
    expect(repairedMapping).toMatchObject({
      status: "confirmed",
      version: 2,
      selfPersonId: "person_self",
      companionPersonId: "person_ta_after_stale"
    });
    const repairedConfirmation = await subjectConfirmation(imported.interactionId);
    const selections = dcDatabase.prepare(`
      SELECT evidence_snapshot_id, subject FROM dc_memory_subject_selections
      WHERE user_id = 'user_a' AND interaction_id = ?
      ORDER BY evidence_snapshot_id
    `).all(imported.interactionId) as Array<{
      evidence_snapshot_id: string;
      subject: "self" | "companion" | "both" | "unknown";
    }>;
    bridge.queueInteractionSync({
      userId: "user_a",
      interactionId: imported.interactionId,
      mappingVersion: repairedMapping.version,
      subjectSuggestionConfirmation: repairedConfirmation,
      selections: selections.map((selection) => ({
        evidenceSnapshotId: selection.evidence_snapshot_id,
        subject: selection.subject
      }))
    });
    expect(dcDatabase.prepare(`
      SELECT status, mapping_version, last_error_code FROM dc_memory_bridge_outbox
      WHERE id = ? AND user_id = 'user_a'
    `).get(outbox.id)).toEqual({
      status: "pending",
      mapping_version: 2,
      last_error_code: null
    });
    await expect(processDateCompanionMemoryBridgeInteraction({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      userId: "user_a",
      interactionId: imported.interactionId
    })).resolves.toMatchObject({ completed: true, idempotent: false });
    expect(createPersonMemoryRepository(memoryDatabase)
      .getPersonMemories({ accountId: "user_a", personId: "person_ta_after_stale" })?.memories)
      .toHaveLength(1);
  });

  it.each(["upload_tombstone", "retained_purged"] as const)(
    "does not requeue a completed legacy bridge guarded by %s",
    async (guard) => {
      const { imported, bridge } = await prepareLegacyCompletedProjection();
      if (guard === "upload_tombstone") {
        memoryDatabase.prepare(`
          INSERT INTO memory_upload_tombstones (user_id, upload_id, reason, deleted_at)
          VALUES ('user_a', 'upload_1', 'upload_deleted', ?)
        `).run(NOW);
      } else {
        memoryDatabase.prepare(`
          UPDATE dc_retained_uploads SET status = 'purged', updated_at = ?
          WHERE user_id = 'user_a' AND upload_id = 'upload_1'
        `).run(NOW);
      }

      expect(requeueCompletedLegacyMemoryProjections({
        dateCompanionDatabase: dcDatabase,
        memoryDatabase,
        now: "2026-08-11T00:00:01.000Z"
      })).toEqual({ scanned: 1, requeued: 0 });
      expect(bridge.getInteractionBridgeStatus("user_a", imported.interactionId))
        .toMatchObject({ status: "completed" });
      expect(memoryDatabase.prepare(`
        SELECT
          (SELECT COUNT(*) FROM dc_memory_bridge_candidate_receipts) AS candidate_receipts,
          (SELECT COUNT(*) FROM memory_items WHERE user_id = 'user_a') AS memories
      `).get()).toEqual({ candidate_receipts: 0, memories: 0 });
    }
  );

  it("migrates v8 to v9 without changing existing Memory retrieval", () => {
    seedMemory();
    const repository = createMemoryRepository(memoryDatabase);
    const before = repository.getRelevantMemories({ userId: "user_a" });
    memoryDatabase.exec(`
      DROP TABLE dc_memory_bridge_receipts;
      DROP TABLE dc_person_relationship_links;
      DROP TABLE person_evidence_dc_links;
      DROP TABLE dc_retained_uploads;
      DROP TABLE memory_evidence_provenance;
      DROP TABLE dc_memory_withdrawn_projections;
      DELETE FROM schema_migrations WHERE version IN (9, 15);
    `);
    migrateMemorySchema(memoryDatabase);
    expect(repository.getRelevantMemories({ userId: "user_a" })).toEqual(before);
    expect(memoryDatabase.prepare("SELECT version FROM schema_migrations WHERE version = 9").get())
      .toEqual({ version: 9 });
    expect(memoryDatabase.pragma("foreign_key_check")).toEqual([]);
  });

  it("requires explicit, account-scoped distinct confirmed self/Ta mapping", () => {
    seedPeople();
    expect(() => validateMemoryBridgePersonMapping({
      memoryDatabase,
      accountId: "user_a",
      selfPersonId: "person_self",
      companionPersonId: "person_ta"
    })).not.toThrow();
    expect(() => validateMemoryBridgePersonMapping({
      memoryDatabase,
      accountId: "user_a",
      selfPersonId: "person_self",
      companionPersonId: "person_self"
    })).toThrowError("self_and_companion_must_differ");
    expect(() => validateMemoryBridgePersonMapping({
      memoryDatabase,
      accountId: "user_b",
      selfPersonId: "person_self",
      companionPersonId: "person_ta"
    })).toThrow();
  });

  it("preserves retained provenance when a later upload rebuilds the user Memory index", async () => {
    seedMemory();
    await captureRetainedMemoryEvidenceProvenance({
      database: memoryDatabase,
      store: transcriptStore() as unknown as Pick<JsonStore, "read">,
      userId: "user_a",
      uploadId: "upload_1",
      relationshipId: "relationship_1",
      interactionId: "interaction_1",
      now: NOW
    });
    createMemoryRepository(memoryDatabase).replaceUploadMemories({
      userId: "user_a",
      uploadId: "upload_2",
      memories: [{
        id: "memory_later",
        type: "summary",
        title: "Later upload",
        summary: "Later upload",
        importance: 0.5,
        date: "2026-08-12",
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
        evidence: [{
          id: "memory_evidence_later",
          sourceType: "transcript",
          sourceId: "segment_later",
          uploadId: "upload_2",
          date: "2026-08-12",
          quote: "later",
          createdAt: "2026-08-12T00:00:00.000Z"
        }]
      }]
    });
    expect(memoryDatabase.prepare("SELECT COUNT(*) AS count FROM memory_evidence_provenance").get())
      .toEqual({ count: 2 });
  });

  it("saves an explicitly recap-only confirmation without queuing memory under an enabled, mapped relationship", () => {
    const { relationship, imported } = importDraft();
    const bridge = createDateCompanionMemoryBridgeRepository(dcDatabase);
    expect(bridge.getRetentionSetting("user_a").enabled).toBe(true);
    const mapping = bridge.putPersonMapping({
      userId:"user_a", relationshipId:relationship.id, selfPersonId:"person_self",
      companionPersonId:"person_ta", relationshipType:"dating", expectedVersion:0
    });
    const detail = dcRepository.getInteractionDetail("user_a",relationship.id,imported.interactionId);
    const confirmation = {
      userId:"user_a", interactionId:imported.interactionId, version:0, finalize:true,
      assignments:[{speakerId:"speaker_0", role:"self" as const},{speakerId:"speaker_1",role:"companion" as const}],
      mutations:detail.recapItems.map(item => ({id:item.id,version:item.version,disposition:"kept" as const})),
    };
    const skip = {...confirmation,skipMemoryAdmission:true as const};
    expect(() => dcRepository.updateRecap({...skip,memoryAdmission:{mappingVersion:mapping.version,selections:[]}}))
      .toThrow("invalid_memory_admission_choice");
    expect(dcRepository.updateRecap(skip)).toEqual({idempotent:false});
    expect(dcRepository.updateRecap(skip)).toEqual({idempotent:true});
    expect(bridge.getInteractionBridgeStatus("user_a",imported.interactionId)).toBeNull();
    expect(dcRepository.getInteractionDetail("user_a",relationship.id,imported.interactionId).status).toBe("confirmed");
    expect(() => dcRepository.updateRecap(confirmation)).toThrow("confirmation_payload_conflict");
    expect(() => dcRepository.updateRecap({...confirmation,memoryAdmission:{mappingVersion:mapping.version,selections:[]}}))
      .toThrow("confirmation_payload_conflict");
  });

  it("keeps an explicit opt-out fail-closed for Memory admission", () => {
    const { relationship, imported } = importDraft();
    const bridge = createDateCompanionMemoryBridgeRepository(dcDatabase);
    expect(bridge.putRetentionSetting({
      userId: "user_a",
      enabled: false,
      expectedVersion: 0
    })).toMatchObject({ enabled: false, version: 1 });
    const mapping = bridge.putPersonMapping({
      userId: "user_a",
      relationshipId: relationship.id,
      selfPersonId: "person_self",
      companionPersonId: "person_ta",
      relationshipType: "dating",
      expectedVersion: 0
    });
    const detail = dcRepository.getRelationshipView("user_a", relationship.id).interactions[0];
    const keptItem = detail.recapItems[0];

    expect(() => dcRepository.updateRecap({
      userId: "user_a",
      interactionId: imported.interactionId,
      version: 0,
      assignments: [
        { speakerId: "speaker_0", role: "self" },
        { speakerId: "speaker_1", role: "companion" }
      ],
      mutations: detail.recapItems.map((item, index) => ({
        id: item.id,
        version: item.version,
        disposition: index === 0 ? "kept" as const : "excluded" as const
      })),
      memoryAdmission: {
        mappingVersion: mapping.version,
        selections: [{
          evidenceSnapshotId: keptItem.evidence[0].id,
          subject: "companion"
        }]
      },
      finalize: true
    })).toThrow("memory_retention_disabled");
    expect(bridge.getInteractionBridgeStatus("user_a", imported.interactionId)).toBeNull();
  });

  it("keeps outbox waiting until cleanup, replays a crash through the Memory receipt, and scopes only explicit Evidence", async () => {
    seedPeople();
    seedMemory();
    const { relationship, imported } = importDraft();
    const bridge = createDateCompanionMemoryBridgeRepository(dcDatabase);
    expect(bridge.getRetentionSetting("user_a")).toMatchObject({ enabled: true, version: 0 });
    const mapping = bridge.putPersonMapping({
      userId: "user_a",
      relationshipId: relationship.id,
      selfPersonId: "person_self",
      companionPersonId: "person_ta",
      relationshipType: "dating",
      expectedVersion: 0
    });
    const detail = dcRepository.getRelationshipView("user_a", relationship.id).interactions[0];
    const evidenceBySegment = new Map(
      detail.recapItems.flatMap((item) => item.evidence).map((item) => [item.sourceSegmentId, item.id])
    );
    const confirmation = await subjectConfirmation(imported.interactionId);
    dcRepository.updateRecap({
      userId: "user_a",
      interactionId: imported.interactionId,
      version: 0,
      assignments: [
        { speakerId: "speaker_0", role: "self" },
        { speakerId: "speaker_1", role: "companion" }
      ],
      mutations: detail.recapItems.map((item) => ({
        id: item.id,
        version: item.version,
        disposition: "kept" as const
      })),
      memoryAdmission: {
        mappingVersion: mapping.version,
        subjectSuggestionConfirmation: confirmation,
        selections: [
          {
            evidenceSnapshotId: evidenceBySegment.get("segment_companion")!,
            subject: "companion"
          },
          {
            evidenceSnapshotId: evidenceBySegment.get("segment_unknown")!,
            subject: "unknown"
          }
        ]
      },
      finalize: true
    });
    expect(bridge.getInteractionBridgeStatus("user_a", imported.interactionId))
      .toMatchObject({ status: "waiting_for_cleanup", attemptCount: 0 });
    expect(bridge.claimNext()).toBeNull();
    // Turning off future grants leaves this already-submitted task and its
    // eventual retained evidence available throughout the rest of the test.
    bridge.putRetentionSetting({userId: "user_a", enabled: false, expectedVersion: 0});

    await captureRetainedMemoryEvidenceProvenance({
      database: memoryDatabase,
      store: transcriptStore() as unknown as Pick<JsonStore, "read">,
      userId: "user_a",
      uploadId: "upload_1",
      relationshipId: relationship.id,
      interactionId: imported.interactionId,
      now: NOW
    });
    expect(dcRepository.markUploadSourceState("user_a", "upload_1", "server_cleaned")).toBe(true);

    await expect(processDateCompanionMemoryBridgeInteraction({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      userId: "user_a",
      interactionId: imported.interactionId,
      afterMemoryCommit: () => {
        throw new Error("simulated_dc_complete_crash");
      }
    })).rejects.toThrow("simulated_dc_complete_crash");
    expect(memoryDatabase.prepare("SELECT COUNT(*) AS count FROM dc_memory_bridge_receipts").get())
      .toEqual({ count: 1 });
    expect(bridge.getInteractionBridgeStatus("user_a", imported.interactionId))
      .toMatchObject({ status: "retryable_failed", attemptCount: 1 });

    await expect(processDateCompanionMemoryBridgeInteraction({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      userId: "user_a",
      interactionId: imported.interactionId
    })).resolves.toMatchObject({ completed: true, idempotent: true });
    expect(bridge.getInteractionBridgeStatus("user_a", imported.interactionId))
      .toMatchObject({ status: "completed", attemptCount: 2 });
    expect(memoryDatabase.prepare("SELECT COUNT(*) AS count FROM dc_memory_bridge_receipts").get())
      .toEqual({ count: 1 });

    const personMemories = createPersonMemoryRepository(memoryDatabase);
    const admittedProjection = memoryDatabase.prepare(`
      SELECT memory_id FROM dc_memory_bridge_candidate_receipts
      WHERE account_id = 'user_a' AND dc_interaction_id = ? AND status = 'admitted'
    `).get(imported.interactionId) as { memory_id: string };
    expect(personMemories.getPersonMemories({ accountId: "user_a", personId: "person_ta" })
      ?.memories.map((item) => item.memory.id)).toEqual([admittedProjection.memory_id]);
    expect(personMemories.getPersonMemories({ accountId: "user_a", personId: "person_self" })
      ?.memories).toEqual([]);
    expect(memoryDatabase.prepare(`
      SELECT person_id, status, source, reason
      FROM person_subject_observations
      ORDER BY person_id
    `).all()).toEqual([{
      person_id: "person_ta",
      status: "confirmed",
      source: "manual_review",
      reason: "date_companion_qwen_batch_review_v1"
    }]);
    expect(memoryDatabase.prepare("SELECT COUNT(*) AS count FROM person_facts").get())
      .toEqual({ count: 0 });
    expect(memoryDatabase.prepare("SELECT COUNT(*) AS count FROM person_commitments").get())
      .toEqual({ count: 0 });

    createMemoryRepository(memoryDatabase).replaceUploadMemories({
      userId: "user_a",
      uploadId: "upload_unretained",
      memories: [{
        id: "memory_unretained",
        type: "summary",
        title: "Unretained interaction",
        summary: "Unretained interaction",
        importance: 0.4,
        date: "2026-08-12",
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
        evidence: [{
          id: "memory_evidence_unretained",
          sourceType: "transcript",
          sourceId: "segment_unretained",
          uploadId: "upload_unretained",
          date: "2026-08-12",
          quote: "Unretained interaction",
          createdAt: "2026-08-12T00:00:00.000Z"
        }]
      }]
    });
    dcRepository.importInteraction({
      userId: "user_a",
      relationshipId: relationship.id,
      sourceUploadId: "upload_unretained",
      recordingDate: "2026-08-12",
      originalName: "unretained.wav",
      participants: [{ speakerId: "speaker_0" }],
      recapCandidates: []
    });

    const scope = {
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      userId: "user_a",
      relationshipId: relationship.id
    };
    const {preview} = getDateCompanionWithdrawalPreview(scope);
    expect(preview).toMatchObject({ retainedCount: 1, processingCount: 0, totalCount: 1 });
    const purged = purgeDateCompanionRetainedMemory({ ...scope, previewVersion: preview.version });
    expect(purged).toMatchObject({
      status: "completed",
      totalCount: 1,
      completedCount: 1,
      failedCount: 0
    });
    expect(createMemoryRepository(memoryDatabase).getRelevantMemories({ userId: "user_a" }))
      .toContainEqual(expect.objectContaining({ id: "memory_unretained" }));
    expect(memoryDatabase.prepare(`
      SELECT upload_id FROM memory_upload_tombstones
      WHERE user_id = 'user_a' ORDER BY upload_id
    `).all()).toEqual([]);
    expect(dcRepository.getRelationshipView("user_a", relationship.id).interactions)
      .toHaveLength(2);
    expect(purgeDateCompanionRetainedMemory({ ...scope, previewVersion: preview.version })).toEqual(purged);
  });

  it("binds withdrawal to the preview, independently retires old grants and accepts a fresh explicit grant", async () => {
    seedPeople();
    const {relationship} = importDraft("user_a", "draft_only");
    importDraft("user_b", "unrelated_account");
    const scope = {dateCompanionDatabase: dcDatabase, memoryDatabase, userId: "user_a", relationshipId: relationship.id};
    const bridge = createDateCompanionMemoryBridgeRepository(dcDatabase);
    const mapping = bridge.putPersonMapping({
      userId: "user_a", relationshipId: relationship.id, selfPersonId: "person_self",
      companionPersonId: "person_ta", relationshipType: "dating", expectedVersion: 0
    });
    function saveOnce(uploadId: string) {
      const {imported} = importDraft("user_a", uploadId);
      const view = dcRepository.getInteractionDetail("user_a", relationship.id, imported.interactionId);
      const keep = view.recapItems.find(item => item.kind === "mentioned")!;
      dcRepository.updateRecap({
        userId: "user_a", interactionId: imported.interactionId, version: 0, finalize: true, skipMemoryAdmission: true,
        assignments: [{speakerId: "speaker_0", role: "self"}, {speakerId: "speaker_1", role: "companion"}],
        mutations: view.recapItems.map(item => ({
          id: item.id, version: 0, disposition: item.id === keep.id ? "kept" : "excluded"
        }))
      });
      return {interactionId: imported.interactionId, selections: [{evidenceSnapshotId: keep.evidence[0].id, subject: "companion" as const}]};
    }
    const operations = {userId: "user_a", memoryDatabase, mappingVersion: mapping.version};
    const onlyHere = saveOnce("only_here");
    const classified = saveOnce("only_suggested");
    await subjectConfirmation(classified.interactionId);
    const first = saveOnce("withdraw_then_readmit");
    const second = saveOnce("added_during_preview");
    const getPreview = () => getDateCompanionWithdrawalPreview(scope).preview;
    const withdraw = (version: string) => purgeDateCompanionRetainedMemory({...scope, previewVersion: version});
    expect(getPreview()).toMatchObject({totalCount: 0});
    expect(() => getDateCompanionWithdrawalPreview({...scope, userId: "user_b"})).toThrow("Relationship not found");
    const originalProof = await subjectConfirmation(first.interactionId);
    const oldRequest = {...operations, ...first, subjectSuggestionConfirmation: originalProof};
    const original = bridge.queueInteractionSync(oldRequest)!;
    const initial = getPreview();
    expect(initial).toMatchObject({totalCount: 1, retainedCount: 0, processingCount: 1});
    expect(dcDatabase.prepare("SELECT COUNT(*) AS n FROM dc_memory_withdrawals").get()).toEqual({n: 0});
    const lateProof = await subjectConfirmation(second.interactionId);
    bridge.queueInteractionSync({...operations, ...second, subjectSuggestionConfirmation: lateProof});
    expect(() => withdraw(initial.version)).toThrow("withdrawal_preview_stale");
    const current = getPreview();
    expect(current).toMatchObject({totalCount: 2, retainedCount: 0, processingCount: 2});

    // Reproduce a commit gap with the original grant already denied in Memory.
    grantProjection.fenceDateCompanionGrantProjection(memoryDatabase, {
      ...scope, uploadId: "withdraw_then_readmit", interactionId: first.interactionId,
      generation: 1, outboxId: original.id, category: "processing"
    });
    expect(getPreview()).toEqual(current);
    const cleanup = vi.spyOn(grantProjection, "cleanupDateCompanionGrantProjection")
      .mockImplementationOnce(() => { throw new Error("isolated_cleanup_failure"); });
    const removed = withdraw(current.version);
    expect(removed).toMatchObject({usageStopped: true, totalCount: 2, completedCount: 1, failedCount: 1, retryable: true});
    expect(getDateCompanionWithdrawalPreview(scope).pendingCleanup?.previewVersion).toBe(current.version);
    expect(getPreview().totalCount).toBe(0);
    expect(dcDatabase.prepare("SELECT upload_id FROM dc_memory_withdrawn_grants ORDER BY upload_id").all())
      .toEqual([{upload_id: "added_during_preview"}, {upload_id: "withdraw_then_readmit"}]);
    expect(memoryDatabase.prepare("SELECT COUNT(*) AS n FROM memory_upload_tombstones").get()).toEqual({n: 0});
    expect(() => bridge.queueInteractionSync({...operations, interactionId: first.interactionId})).toThrow("withdrawn_grant_requires_new_confirmation");
    expect(() => bridge.queueInteractionSync(oldRequest)).toThrow("subject_suggestion_evidence_stale");
    const freshProof = await subjectConfirmation(first.interactionId);
    expect(freshProof.batchId).not.toBe(originalProof.batchId);
    const freshRequest = {...operations, ...first, subjectSuggestionConfirmation: freshProof};
    const fresh = bridge.queueInteractionSync(freshRequest)!;
    expect(fresh.id).not.toBe(original.id);
    expect(fresh.idempotency_key).not.toBe(original.idempotency_key);
    expect(bridge.queueInteractionSync(freshRequest)?.id).toBe(fresh.id);
    bridge.putRetentionSetting({userId: "user_a", enabled: false, expectedVersion: 0});
    expect(bridge.queueInteractionSync(freshRequest)?.id).toBe(fresh.id);
    await expect(subjectConfirmation(onlyHere.interactionId)).rejects.toThrow("memory_retention_disabled");
    dcDatabase.prepare("UPDATE dc_memory_bridge_outbox SET status='retryable_failed' WHERE id=?").run(fresh.id);
    const review = bridge.getMemoryReview("user_a", relationship.id).interactions.find(i => i.interactionId === first.interactionId);
    expect(review?.retryGrantId).toBe(fresh.id);
    expect(() => bridge.queueInteractionSync({...operations, interactionId: first.interactionId, retryGrantId: original.id}))
      .toThrow("memory_bridge_retry_stale");
    expect(bridge.queueInteractionSync({...operations, interactionId: first.interactionId, retryGrantId: fresh.id})?.status).toBe("pending");
    bridge.putRetentionSetting({userId: "user_a", enabled: true, expectedVersion: 1});
    expect(() => bridge.queueInteractionSync(oldRequest)).toThrow("subject_suggestion_evidence_stale");
    expect(() => bridge.queueInteractionSync({...operations, interactionId: first.interactionId})).toThrow("withdrawn_grant_requires_new_confirmation");
    expect(getPreview().totalCount).toBe(1);
    cleanup.mockRestore();
    expect(withdraw(current.version)).toMatchObject({purgeId: removed.purgeId, completedCount: 2, failedCount: 0});
    expect(getDateCompanionWithdrawalPreview(scope).pendingCleanup).toBeUndefined();
    expect(getPreview().totalCount).toBe(1);
    expect(dcRepository.getInteractionDetail("user_a", relationship.id, first.interactionId).recapItems[0].evidence[0].quote)
      .toBe("我最近想去看展");

    // First authorization of a previously local-only recording is still possible.
    const firstEver = await subjectConfirmation(onlyHere.interactionId);
    expect(bridge.queueInteractionSync({...operations, ...onlyHere, subjectSuggestionConfirmation: firstEver})?.status).toBe("pending");
    memoryDatabase.prepare("INSERT INTO memory_upload_tombstones (user_id,upload_id,reason,deleted_at) VALUES (?,?,?,?)")
      .run("user_a", "only_here", "upload_deleted", NOW);
    expect(() => bridge.queueInteractionSync({...operations, ...onlyHere, subjectSuggestionConfirmation: firstEver})).toThrow("memory_bridge_source_deleted");
    await expect(getOrCreateDateCompanionSubjectSuggestionBatch({
      database: dcDatabase, memoryDatabase, userId: "user_a", interactionId: onlyHere.interactionId
    })).rejects.toThrow("memory_bridge_source_deleted");
    expect(dcDatabase.pragma("foreign_key_check")).toEqual([]);
  });

  it("admits edited kept recap content through formal Memory admission exactly once and leaves rejected or excluded content at zero", async () => {
    seedPeople();
    const { relationship, imported } = importFormalAdmissionDraft();
    const bridge = createDateCompanionMemoryBridgeRepository(dcDatabase);
    const mapping = bridge.putPersonMapping({
      userId: "user_a",
      relationshipId: relationship.id,
      selfPersonId: "person_self",
      companionPersonId: "person_ta",
      relationshipType: "dating",
      expectedVersion: 0
    });
    const detail = dcRepository.getRelationshipView("user_a", relationship.id).interactions[0];
    const itemBySegment = new Map(detail.recapItems.map((item) => [
      item.evidence[0].sourceSegmentId,
      item
    ]));
    const admittedItem = itemBySegment.get("segment_formal_admitted")!;
    const rejectedItem = itemBySegment.get("segment_formal_rejected")!;
    const excludedItem = itemBySegment.get("segment_formal_excluded")!;
    const confirmation = await subjectConfirmation(imported.interactionId, [admittedItem.id, rejectedItem.id]);

    dcRepository.updateRecap({
      userId: "user_a",
      interactionId: imported.interactionId,
      version: 0,
      assignments: [
        { speakerId: "speaker_0", role: "self" },
        { speakerId: "speaker_1", role: "companion" }
      ],
      mutations: [
        {
          id: admittedItem.id,
          version: admittedItem.version,
          disposition: "kept",
          userText: "Ta 计划找个周末和我一起去看展"
        },
        {
          id: rejectedItem.id,
          version: rejectedItem.version,
          disposition: "kept",
          userText: "围绕多个话题展开"
        },
        {
          id: excludedItem.id,
          version: excludedItem.version,
          disposition: "excluded",
          userText: "Ta 下周六之前要完成作品集"
        }
      ],
      memoryAdmission: {
        mappingVersion: mapping.version,
        subjectSuggestionConfirmation: confirmation,
        selections: [
          { evidenceSnapshotId: admittedItem.evidence[0].id, subject: "companion" },
          { evidenceSnapshotId: rejectedItem.evidence[0].id, subject: "companion" }
        ]
      },
      finalize: true
    });
    await expect(captureRetainedMemoryEvidenceProvenance({
      database: memoryDatabase,
      store: formalAdmissionTranscriptStore() as unknown as Pick<JsonStore, "read">,
      userId: "user_a",
      uploadId: "upload_formal",
      relationshipId: relationship.id,
      interactionId: imported.interactionId,
      now: NOW
    })).resolves.toMatchObject({ provenanceCount: 0 });
    expect(dcRepository.markUploadSourceState("user_a", "upload_formal", "server_cleaned"))
      .toBe(true);

    await expect(processDateCompanionMemoryBridgeInteraction({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      userId: "user_a",
      interactionId: imported.interactionId,
      afterMemoryCommit: () => {
        throw new Error("simulated_formal_memory_receipt_crash");
      }
    })).rejects.toThrow("simulated_formal_memory_receipt_crash");

    const memoryRepository = createMemoryRepository(memoryDatabase);
    const memoriesAfterCrash = memoryRepository.getRelevantMemories({ userId: "user_a" });
    expect(memoriesAfterCrash).toHaveLength(1);
    expect(memoriesAfterCrash[0]).toMatchObject({
      type: "summary",
      title: "Ta 计划找个周末和我一起去看展",
      summary: "Ta 计划找个周末和我一起去看展",
      occurrenceCount: 1
    });
    expect(memoriesAfterCrash[0].evidence).toEqual([
      expect.objectContaining({
        sourceType: "transcript",
        sourceId: "segment_formal_admitted",
        uploadId: "upload_formal",
        quote: "她说她想去看展，想找个周末一起去。"
      })
    ]);
    expect(memoriesAfterCrash[0].evidence[0].quote)
      .not.toBe("Ta 计划找个周末和我一起去看展");
    expect(memoryRepository.getMemoryOwnerAttributions("user_a", [memoriesAfterCrash[0].id]))
      .toEqual([
        expect.objectContaining({
          memoryId: memoriesAfterCrash[0].id,
          scope: "unknown",
          owner: expect.objectContaining({ type: "unknown" }),
          participants: [expect.objectContaining({
            role: "participant",
            attribution: expect.objectContaining({
              type: "known_identity",
              identityId: "person_ta",
              source: "manual_mapping"
            })
          })],
          evidenceSegmentIds: ["segment_formal_admitted"]
        })
      ]);

    const candidateReceiptsAfterCrash = memoryDatabase.prepare(`
      SELECT recap_item_id, status, memory_id, score, reasons_json,
             evidence_digest, origin_key, operation_receipt_id
      FROM dc_memory_bridge_candidate_receipts
      WHERE account_id = 'user_a' AND dc_interaction_id = ?
      ORDER BY recap_item_id
    `).all(imported.interactionId) as Array<{
      recap_item_id: string;
      status: string;
      memory_id: string | null;
      score: number;
      reasons_json: string;
      evidence_digest: string;
      origin_key: string;
      operation_receipt_id: string;
    }>;
    expect(candidateReceiptsAfterCrash).toHaveLength(2);
    expect(candidateReceiptsAfterCrash.map((row) => row.recap_item_id).sort())
      .toEqual([admittedItem.id, rejectedItem.id].sort());
    const admittedReceipt = candidateReceiptsAfterCrash.find(
      (row) => row.recap_item_id === admittedItem.id
    )!;
    const rejectedReceipt = candidateReceiptsAfterCrash.find(
      (row) => row.recap_item_id === rejectedItem.id
    )!;
    expect(admittedReceipt).toMatchObject({
      status: "admitted",
      memory_id: memoriesAfterCrash[0].id
    });
    expect(rejectedReceipt).toMatchObject({ status: "rejected", memory_id: null });
    expect(JSON.parse(rejectedReceipt.reasons_json)).toContain("generic_summary");
    expect(new Set(candidateReceiptsAfterCrash.map((row) => row.origin_key)).size).toBe(2);
    for (const receipt of candidateReceiptsAfterCrash) {
      expect(receipt.origin_key.length).toBeGreaterThan(0);
      expect(receipt.evidence_digest).toMatch(/^[a-f0-9]{64}$/u);
      expect(receipt.score).toBeGreaterThanOrEqual(0);
      expect(receipt.score).toBeLessThanOrEqual(1);
    }
    expect(memoryDatabase.prepare(`
      SELECT COUNT(*) AS count FROM dc_memory_bridge_receipts
      WHERE account_id = 'user_a' AND dc_interaction_id = ?
    `).get(imported.interactionId)).toEqual({ count: 1 });
    expect(new Set(candidateReceiptsAfterCrash.map((row) => row.operation_receipt_id)))
      .toEqual(new Set([
        (memoryDatabase.prepare(`
          SELECT id FROM dc_memory_bridge_receipts
          WHERE account_id = 'user_a' AND dc_interaction_id = ?
        `).get(imported.interactionId) as { id: string }).id
      ]));
    expect(memoryDatabase.prepare(`
      SELECT source_id, quote FROM memory_evidence
      WHERE upload_id = 'upload_formal' ORDER BY source_id
    `).all()).toEqual([{
      source_id: "segment_formal_admitted",
      quote: "她说她想去看展，想找个周末一起去。"
    }]);
    expect(memoryDatabase.prepare(`
      SELECT source_segment_id, quote FROM person_evidence
      WHERE account_id = 'user_a' AND upload_id = 'upload_formal'
      ORDER BY source_segment_id
    `).all()).toEqual([{
      source_segment_id: "segment_formal_admitted",
      quote: "她说她想去看展，想找个周末一起去。"
    }]);
    expect(createPersonMemoryRepository(memoryDatabase)
      .getPersonMemories({ accountId: "user_a", personId: "person_ta" })
      ?.memories.map((item) => item.memory.id)).toEqual([memoriesAfterCrash[0].id]);
    expect(createPersonMemoryRepository(memoryDatabase)
      .getPersonMemories({ accountId: "user_a", personId: "person_self" })?.memories)
      .toEqual([]);
    expect(memoryDatabase.prepare(`
      SELECT COUNT(*) AS count FROM memory_evidence
      WHERE upload_id = 'upload_formal'
        AND source_id IN ('segment_formal_rejected', 'segment_formal_excluded')
    `).get()).toEqual({ count: 0 });
    expect(memoryDatabase.prepare(`
      SELECT COUNT(*) AS count FROM person_evidence
      WHERE account_id = 'user_a' AND upload_id = 'upload_formal'
        AND source_segment_id IN ('segment_formal_rejected', 'segment_formal_excluded')
    `).get()).toEqual({ count: 0 });

    await expect(processDateCompanionMemoryBridgeInteraction({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      userId: "user_a",
      interactionId: imported.interactionId
    })).resolves.toMatchObject({ completed: true, idempotent: true });
    expect(memoryDatabase.prepare(`
      SELECT
        (SELECT COUNT(*) FROM dc_memory_bridge_receipts
          WHERE account_id = 'user_a' AND dc_interaction_id = ?) AS operation_receipts,
        (SELECT COUNT(*) FROM dc_memory_bridge_candidate_receipts
          WHERE account_id = 'user_a' AND dc_interaction_id = ?) AS candidate_receipts,
        (SELECT COUNT(*) FROM memory_items
          WHERE user_id = 'user_a') AS memories,
        (SELECT COUNT(*) FROM memory_evidence
          WHERE upload_id = 'upload_formal') AS evidence,
        (SELECT COALESCE(SUM(occurrence_count), 0) FROM memory_items
          WHERE user_id = 'user_a') AS occurrences
    `).get(imported.interactionId, imported.interactionId)).toEqual({
      operation_receipts: 1,
      candidate_receipts: 2,
      memories: 1,
      evidence: 1,
      occurrences: 1
    });
    expect(memoryDatabase.prepare(`
      SELECT recap_item_id, status, memory_id, score, reasons_json,
             evidence_digest, origin_key, operation_receipt_id
      FROM dc_memory_bridge_candidate_receipts
      WHERE account_id = 'user_a' AND dc_interaction_id = ?
      ORDER BY recap_item_id
    `).all(imported.interactionId)).toEqual(candidateReceiptsAfterCrash);
  });

  it.each([
    ["another user", "user_b"],
    ["nobody", null]
  ])("fails closed when a participant was confirmed by %s", async (_label, confirmedBy) => {
    seedPeople();
    const { relationship, imported } = importFormalAdmissionDraft();
    const bridge = createDateCompanionMemoryBridgeRepository(dcDatabase);
    const mapping = bridge.putPersonMapping({
      userId: "user_a",
      relationshipId: relationship.id,
      selfPersonId: "person_self",
      companionPersonId: "person_ta",
      relationshipType: "dating",
      expectedVersion: 0
    });
    const detail = dcRepository.getRelationshipView("user_a", relationship.id).interactions[0]!;
    const admittedItem = detail.recapItems.find((item) =>
      item.evidence.some((evidence) => evidence.sourceSegmentId === "segment_formal_admitted")
    )!;
    const confirmation = await subjectConfirmation(imported.interactionId, [admittedItem.id]);
    dcRepository.updateRecap({
      userId: "user_a",
      interactionId: imported.interactionId,
      version: 0,
      assignments: [
        { speakerId: "speaker_0", role: "self" },
        { speakerId: "speaker_1", role: "companion" }
      ],
      mutations: detail.recapItems.map((item) => ({
        id: item.id,
        version: item.version,
        disposition: item.id === admittedItem.id ? "kept" as const : "excluded" as const
      })),
      memoryAdmission: {
        mappingVersion: mapping.version,
        subjectSuggestionConfirmation: confirmation,
        selections: [{
          evidenceSnapshotId: admittedItem.evidence[0]!.id,
          subject: "companion"
        }]
      },
      finalize: true
    });
    dcDatabase.prepare(`
      UPDATE dc_participant_assignments
      SET confirmed_by = ?
      WHERE user_id = 'user_a' AND interaction_id = ? AND speaker_id = 'speaker_1'
    `).run(confirmedBy, imported.interactionId);
    await expect(captureRetainedMemoryEvidenceProvenance({
      database: memoryDatabase,
      store: formalAdmissionTranscriptStore() as unknown as Pick<JsonStore, "read">,
      userId: "user_a",
      uploadId: "upload_formal",
      relationshipId: relationship.id,
      interactionId: imported.interactionId,
      now: NOW
    })).resolves.toMatchObject({ provenanceCount: 0 });
    expect(dcRepository.markUploadSourceState("user_a", "upload_formal", "server_cleaned"))
      .toBe(true);

    await expect(processDateCompanionMemoryBridgeInteraction({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      userId: "user_a",
      interactionId: imported.interactionId
    })).rejects.toThrow("memory_bridge_participant_mapping_stale");
    expect(bridge.getInteractionBridgeStatus("user_a", imported.interactionId))
      .toMatchObject({
        status: "needs_review",
        attemptCount: 1
      });
    expect(dcDatabase.prepare(`
      SELECT last_error_code FROM dc_memory_bridge_outbox
      WHERE user_id = 'user_a' AND interaction_id = ?
    `).get(imported.interactionId)).toEqual({
      last_error_code: "memory_bridge_participant_mapping_stale"
    });
    expect(memoryDatabase.prepare(`
      SELECT
        (SELECT COUNT(*) FROM memory_items WHERE user_id = 'user_a') AS memories,
        (SELECT COUNT(*) FROM memory_evidence WHERE upload_id = 'upload_formal') AS memory_evidence,
        (SELECT COUNT(*) FROM dc_memory_bridge_candidate_receipts
          WHERE account_id = 'user_a' AND dc_interaction_id = ?) AS candidate_receipts,
        (SELECT COUNT(*) FROM person_evidence
          WHERE account_id = 'user_a' AND upload_id = 'upload_formal') AS person_evidence
    `).get(imported.interactionId)).toEqual({
      memories: 0,
      memory_evidence: 0,
      candidate_receipts: 0,
      person_evidence: 0
    });
  });

  it("admits two recap candidates backed by the same canonical segment without failing the batch", async () => {
    seedPeople();
    const uploadId = "upload_shared_canonical";
    const segmentId = "segment_shared_canonical";
    const quote = "她说她想去看展，也已经开始比较近期的展览。";
    const relationship = dcRepository.createOrGetRelationship("user_a", "Ta").relationship;
    const imported = dcRepository.importInteraction({
      userId: "user_a",
      relationshipId: relationship.id,
      sourceUploadId: uploadId,
      recordingDate: "2026-08-11",
      originalName: "shared-canonical.wav",
      participants: [{ speakerId: "speaker_0" }, { speakerId: "speaker_1" }],
      recapCandidates: [
        {
          kind: "mentioned",
          proposedText: "Ta 想找个周末一起去看展",
          sortOrder: 0,
          evidence: [{
            uploadId,
            sourceSegmentId: segmentId,
            startSeconds: 0,
            endSeconds: 5,
            speakerId: "speaker_1",
            quote
          }]
        },
        {
          kind: "mentioned",
          proposedText: "Ta 已经开始比较近期的展览",
          sortOrder: 1,
          evidence: [{
            uploadId,
            sourceSegmentId: segmentId,
            startSeconds: 0,
            endSeconds: 5,
            speakerId: "speaker_1",
            quote
          }]
        }
      ]
    });
    const bridge = createDateCompanionMemoryBridgeRepository(dcDatabase);
    const mapping = bridge.putPersonMapping({
      userId: "user_a",
      relationshipId: relationship.id,
      selfPersonId: "person_self",
      companionPersonId: "person_ta",
      relationshipType: "dating",
      expectedVersion: 0
    });
    const detail = dcRepository.getRelationshipView("user_a", relationship.id).interactions[0]!;
    const confirmation = await subjectConfirmation(imported.interactionId);
    dcRepository.updateRecap({
      userId: "user_a",
      interactionId: imported.interactionId,
      version: 0,
      assignments: [
        { speakerId: "speaker_0", role: "self" },
        { speakerId: "speaker_1", role: "companion" }
      ],
      mutations: detail.recapItems.map((item) => ({
        id: item.id,
        version: item.version,
        disposition: "kept" as const
      })),
      memoryAdmission: {
        mappingVersion: mapping.version,
        subjectSuggestionConfirmation: confirmation,
        selections: detail.recapItems.map((item) => ({
          evidenceSnapshotId: item.evidence[0]!.id,
          subject: "companion" as const
        }))
      },
      finalize: true
    });
    await expect(captureRetainedMemoryEvidenceProvenance({
      database: memoryDatabase,
      store: {
        read: vi.fn(async (kind: string) => kind === "uploads" ? {
          id: uploadId,
          originalName: "shared-canonical.wav",
          mimeType: "audio/wav",
          sizeBytes: 1024,
          recordingDate: "2026-08-11",
          status: "ready"
        } : kind === "segments" ? [{
          id: segmentId,
          uploadId,
          startSeconds: 0,
          endSeconds: 5,
          speaker: "speaker_1",
          text: quote,
          confidence: 0.99,
          sceneLabels: [],
          valueLabels: []
        }] : null)
      } as unknown as Pick<JsonStore, "read">,
      userId: "user_a",
      uploadId,
      relationshipId: relationship.id,
      interactionId: imported.interactionId,
      now: NOW
    })).resolves.toMatchObject({ provenanceCount: 0 });
    expect(dcRepository.markUploadSourceState("user_a", uploadId, "server_cleaned"))
      .toBe(true);

    await expect(processDateCompanionMemoryBridgeInteraction({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      userId: "user_a",
      interactionId: imported.interactionId
    })).resolves.toMatchObject({ completed: true, idempotent: false });
    const receipts = memoryDatabase.prepare(`
      SELECT recap_item_id, status, memory_id
      FROM dc_memory_bridge_candidate_receipts
      WHERE account_id = 'user_a' AND dc_interaction_id = ?
      ORDER BY recap_item_id
    `).all(imported.interactionId) as Array<{
      recap_item_id: string;
      status: string;
      memory_id: string | null;
    }>;
    expect(receipts).toHaveLength(2);
    expect(receipts.map((receipt) => receipt.recap_item_id).sort())
      .toEqual(detail.recapItems.map((item) => item.id).sort());
    expect(receipts.every((receipt) => receipt.status === "admitted" && receipt.memory_id))
      .toBe(true);
    expect(memoryDatabase.prepare(`
      SELECT COUNT(*) AS count FROM memory_evidence
      WHERE upload_id = ? AND source_id = ?
    `).get(uploadId, segmentId)).toEqual({ count: 2 });
    expect(createPersonMemoryRepository(memoryDatabase)
      .getPersonMemories({ accountId: "user_a", personId: "person_ta" })?.memories)
      .toHaveLength(2);
  });

  it("does not let a confirmed speaker mapping become the owner of a non-first-person promise", async () => {
    const { imported, item } = await processSinglePromiseCandidate({
      uploadId: "upload_second_person_promise",
      segmentId: "segment_second_person_promise",
      quote: "你答应明天联系展览馆，确认想去看展的时间。"
    });

    expect(createMemoryRepository(memoryDatabase).getRelevantMemories({ userId: "user_a" }))
      .toEqual([]);
    expect(memoryDatabase.prepare(`
      SELECT recap_item_id, status, memory_id, reasons_json
      FROM dc_memory_bridge_candidate_receipts
      WHERE account_id = 'user_a' AND dc_interaction_id = ?
    `).get(imported.interactionId)).toEqual({
      recap_item_id: item.id,
      status: "rejected",
      memory_id: null,
      reasons_json: JSON.stringify([
        "explicit_future_action",
        "specific_deadline",
        "verified_identity_required_for_long_term_memory"
      ])
    });
    expect(memoryDatabase.prepare(`
      SELECT
        (SELECT COUNT(*) FROM memory_evidence
          WHERE upload_id = 'upload_second_person_promise') AS memory_evidence,
        (SELECT COUNT(*) FROM person_evidence
          WHERE account_id = 'user_a' AND upload_id = 'upload_second_person_promise') AS person_evidence,
        (SELECT COUNT(*) FROM person_evidence_dc_links
          WHERE account_id = 'user_a' AND dc_interaction_id = ?) AS person_links,
        (SELECT COUNT(*) FROM person_subject_observations
          WHERE account_id = 'user_a') AS subject_observations,
        (SELECT COUNT(*) FROM person_relationship_evidence
          WHERE account_id = 'user_a') AS relationship_evidence
    `).get(imported.interactionId)).toEqual({
      memory_evidence: 0,
      person_evidence: 0,
      person_links: 0,
      subject_observations: 0,
      relationship_evidence: 0
    });
    expect(createPersonMemoryRepository(memoryDatabase)
      .getPersonMemories({ accountId: "user_a", personId: "person_ta" })?.memories ?? [])
      .toEqual([]);
  });

  it("admits a promise only when its canonical quote explicitly identifies the mapped speaker as actor", async () => {
    const { imported } = await processSinglePromiseCandidate({
      uploadId: "upload_first_person_promise",
      segmentId: "segment_first_person_promise",
      quote: "我答应明天联系展览馆，确认想去看展的时间。"
    });

    const memories = createMemoryRepository(memoryDatabase)
      .getRelevantMemories({ userId: "user_a" });
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({ type: "commitment", occurrenceCount: 1 });
    expect(createMemoryRepository(memoryDatabase)
      .getMemoryOwnerAttributions("user_a", [memories[0]!.id]))
      .toEqual([expect.objectContaining({
        memoryId: memories[0]!.id,
        scope: "individual",
        owner: expect.objectContaining({
          type: "known_identity",
          identityId: "person_self",
          source: "explicit_statement"
        })
      })]);
    expect(memoryDatabase.prepare(`
      SELECT status FROM dc_memory_bridge_candidate_receipts
      WHERE account_id = 'user_a' AND dc_interaction_id = ?
    `).get(imported.interactionId)).toEqual({ status: "admitted" });
    expect(createPersonMemoryRepository(memoryDatabase)
      .getPersonMemories({ accountId: "user_a", personId: "person_ta" })?.memories)
      .toHaveLength(1);
  });

  it("keeps explicit Subject association separate from participant-derived Memory ownership", async () => {
    seedPeople();
    const relationship = dcRepository.createOrGetRelationship("user_a", "Ta").relationship;
    const imported = dcRepository.importInteraction({
      userId: "user_a",
      relationshipId: relationship.id,
      sourceUploadId: "upload_subject_owner",
      recordingDate: "2026-08-11",
      originalName: "subject-owner.wav",
      participants: [{ speakerId: "speaker_0" }, { speakerId: "speaker_1" }],
      recapCandidates: [{
        kind: "moment",
        proposedText: "我完成了作品集，Ta 还说周末想去看展",
        sortOrder: 0,
        evidence: [{
          uploadId: "upload_subject_owner",
          sourceSegmentId: "segment_subject_owner",
          startSeconds: 0,
          endSeconds: 5,
          speakerId: "speaker_0",
          quote: "我今天完成了作品集，Ta 还说周末想去看展。"
        }]
      }]
    });
    const bridge = createDateCompanionMemoryBridgeRepository(dcDatabase);
    const mapping = bridge.putPersonMapping({
      userId: "user_a",
      relationshipId: relationship.id,
      selfPersonId: "person_self",
      companionPersonId: "person_ta",
      relationshipType: "dating",
      expectedVersion: 0
    });
    const detail = dcRepository.getRelationshipView("user_a", relationship.id).interactions[0];
    const item = detail.recapItems[0];
    const confirmation = await subjectConfirmation(imported.interactionId);
    dcRepository.updateRecap({
      userId: "user_a",
      interactionId: imported.interactionId,
      version: 0,
      assignments: [
        { speakerId: "speaker_0", role: "self" },
        { speakerId: "speaker_1", role: "companion" }
      ],
      mutations: [{ id: item.id, version: item.version, disposition: "kept" }],
      memoryAdmission: {
        mappingVersion: mapping.version,
        subjectSuggestionConfirmation: confirmation,
        selections: [{ evidenceSnapshotId: item.evidence[0].id, subject: "companion" }]
      },
      finalize: true
    });
    await captureRetainedMemoryEvidenceProvenance({
      database: memoryDatabase,
      store: {
        read: vi.fn(async (kind: string) => kind === "uploads" ? {
          id: "upload_subject_owner",
          originalName: "subject-owner.wav",
          mimeType: "audio/wav",
          sizeBytes: 1024,
          recordingDate: "2026-08-11",
          status: "ready"
        } : kind === "segments" ? [{
          id: "segment_subject_owner",
          uploadId: "upload_subject_owner",
          startSeconds: 0,
          endSeconds: 5,
          speaker: "speaker_0",
          text: "我今天完成了作品集，Ta 还说周末想去看展。",
          confidence: 0.99,
          sceneLabels: [],
          valueLabels: []
        }] : null)
      } as unknown as Pick<JsonStore, "read">,
      userId: "user_a",
      uploadId: "upload_subject_owner",
      relationshipId: relationship.id,
      interactionId: imported.interactionId,
      now: NOW
    });
    dcRepository.markUploadSourceState("user_a", "upload_subject_owner", "server_cleaned");
    await processDateCompanionMemoryBridgeInteraction({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      userId: "user_a",
      interactionId: imported.interactionId
    });

    const memoryRepository = createMemoryRepository(memoryDatabase);
    const memories = memoryRepository.getRelevantMemories({ userId: "user_a" });
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      type: "event",
      summary: "我完成了作品集,Ta 还说周末想去看展"
    });
    expect(memoryRepository.getMemoryOwnerAttributions("user_a", [memories[0].id]))
      .toEqual([
        expect.objectContaining({
          memoryId: memories[0].id,
          owner: expect.objectContaining({ type: "unknown" }),
          participants: [expect.objectContaining({
            role: "participant",
            attribution: expect.objectContaining({
              type: "known_identity",
              identityId: "person_self",
              source: "manual_mapping"
            })
          })],
          evidenceSegmentIds: ["segment_subject_owner"]
        })
      ]);
    expect(createPersonMemoryRepository(memoryDatabase)
      .getPersonMemories({ accountId: "user_a", personId: "person_ta" })
      ?.memories.map((personMemory) => personMemory.memory.id)).toEqual([memories[0].id]);
    expect(createPersonMemoryRepository(memoryDatabase)
      .getPersonMemories({ accountId: "user_a", personId: "person_self" })?.memories)
      .toEqual([]);
  });

  it("keeps the current explicit Subject when formal admission merges into a Memory with older Evidence", async () => {
    seedPeople();
    createMemoryRepository(memoryDatabase).replaceUploadMemories({
      userId: "user_a",
      uploadId: "upload_older_evidence",
      memories: [{
        id: "memory_with_older_evidence",
        type: "summary",
        title: "Ta 想去看展",
        summary: "Ta 想去看展",
        importance: 0.5,
        date: "2026-08-10",
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
        evidence: [{
          id: "memory_evidence_older",
          sourceType: "transcript",
          sourceId: "segment_older",
          uploadId: "upload_older_evidence",
          date: "2026-08-10",
          quote: "她前一天也提到想去看展。",
          createdAt: "2026-08-10T00:00:00.000Z"
        }]
      }]
    });
    const { relationship, imported } = importDraft();
    const bridge = createDateCompanionMemoryBridgeRepository(dcDatabase);
    const mapping = bridge.putPersonMapping({
      userId: "user_a",
      relationshipId: relationship.id,
      selfPersonId: "person_self",
      companionPersonId: "person_ta",
      relationshipType: "dating",
      expectedVersion: 0
    });
    const detail = dcRepository.getRelationshipView("user_a", relationship.id).interactions[0]!;
    const admittedItem = detail.recapItems.find((item) =>
      item.evidence.some((evidence) => evidence.sourceSegmentId === "segment_companion")
    )!;
    const confirmation = await subjectConfirmation(imported.interactionId, [admittedItem.id]);
    dcRepository.updateRecap({
      userId: "user_a",
      interactionId: imported.interactionId,
      version: 0,
      assignments: [
        { speakerId: "speaker_0", role: "self" },
        { speakerId: "speaker_1", role: "companion" }
      ],
      mutations: detail.recapItems.map((item) => ({
        id: item.id,
        version: item.version,
        disposition: item.id === admittedItem.id ? "kept" as const : "excluded" as const
      })),
      memoryAdmission: {
        mappingVersion: mapping.version,
        subjectSuggestionConfirmation: confirmation,
        selections: [{
          evidenceSnapshotId: admittedItem.evidence[0]!.id,
          subject: "companion"
        }]
      },
      finalize: true
    });
    await expect(captureRetainedMemoryEvidenceProvenance({
      database: memoryDatabase,
      store: transcriptStore() as unknown as Pick<JsonStore, "read">,
      userId: "user_a",
      uploadId: "upload_1",
      relationshipId: relationship.id,
      interactionId: imported.interactionId,
      now: NOW
    })).resolves.toMatchObject({ provenanceCount: 0 });
    expect(dcRepository.markUploadSourceState("user_a", "upload_1", "server_cleaned"))
      .toBe(true);
    await processDateCompanionMemoryBridgeInteraction({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      userId: "user_a",
      interactionId: imported.interactionId
    });

    const memories = createMemoryRepository(memoryDatabase)
      .getRelevantMemories({ userId: "user_a" });
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      id: "memory_with_older_evidence",
      occurrenceCount: 2
    });
    expect(new Set(memories[0]!.evidence.map((evidence) => evidence.uploadId)))
      .toEqual(new Set(["upload_older_evidence", "upload_1"]));
    expect(memoryDatabase.prepare(`
      SELECT
        (SELECT COUNT(*) FROM person_evidence_dc_links
          WHERE account_id = 'user_a' AND dc_interaction_id = ?) AS current_links,
        (SELECT COUNT(*) FROM person_subject_observations observation
          INNER JOIN person_evidence evidence
            ON evidence.id = observation.evidence_id
            AND evidence.account_id = observation.account_id
          WHERE observation.account_id = 'user_a'
            AND observation.person_id = 'person_ta'
            AND evidence.upload_id = 'upload_1') AS current_subjects
    `).get(imported.interactionId)).toEqual({ current_links: 1, current_subjects: 1 });
    expect(createPersonMemoryRepository(memoryDatabase)
      .getPersonMemories({ accountId: "user_a", personId: "person_ta" })?.memories
      .map((personMemory) => personMemory.memory.id))
      .toEqual(["memory_with_older_evidence"]);
  });

  it("keeps DC snapshots until retained Memory deletion and index refresh have succeeded", async () => {
    const { relationship, imported, bridge } = await completeRetainedBridge();
    expect(bridge.getInteractionBridgeStatus("user_a", imported.interactionId))
      .toMatchObject({ status: "completed" });
    expect(createPersonMemoryRepository(memoryDatabase)
      .getPersonMemories({ accountId: "user_a", personId: "person_ta" })?.memories)
      .toHaveLength(1);
    const snapshotCount = () => (dcDatabase.prepare(`
      SELECT COUNT(*) AS count FROM dc_evidence_snapshots WHERE user_id = 'user_a'
    `).get() as { count: number }).count;
    expect(snapshotCount()).toBe(2);

    const prepared = dcRepository.prepareInteractionDeletion(
      "user_a",
      imported.interactionId,
      1
    );
    expect(prepared).toMatchObject({
      sourceUploadId: "upload_1",
      sourceState: "server_cleaned"
    });
    const enqueueIndexJob = vi.fn(async () => ({ jobId: "index_job", enqueued: true }));
    await deleteMemoryUploadAndRefreshIndex({
      userId: "user_a",
      uploadId: prepared.sourceUploadId,
      indexRefreshFailure: "throw"
    }, {
      getRepository: () => createMemoryRepository(memoryDatabase),
      resolveExecutionMode: () => "queue",
      resolveHybridMode: () => "shadow",
      enqueueIndexJob
    });

    expect(snapshotCount()).toBe(2);
    expect(dcRepository.getRelationshipView("user_a", relationship.id).interactions)
      .toHaveLength(1);
    expect(createMemoryRepository(memoryDatabase).getRelevantMemories({ userId: "user_a" }))
      .toEqual([]);
    expect(memoryDatabase.prepare("SELECT COUNT(*) AS count FROM dc_memory_bridge_receipts").get())
      .toEqual({ count: 0 });
    expect(memoryDatabase.prepare("SELECT COUNT(*) AS count FROM person_evidence_dc_links").get())
      .toEqual({ count: 0 });
    expect(createPersonMemoryRepository(memoryDatabase)
      .getPersonMemories({ accountId: "user_a", personId: "person_ta" }))
      .toBeNull();
    expect(memoryDatabase.prepare(`
      SELECT status FROM person_relationships WHERE account_id = 'user_a'
    `).get()).toEqual({ status: "archived" });
    expect(enqueueIndexJob).toHaveBeenCalledTimes(1);

    dcRepository.deleteInteraction("user_a", imported.interactionId, 1);
    expect(snapshotCount()).toBe(0);
    expect(dcRepository.getRelationshipView("user_a", relationship.id).interactions)
      .toEqual([]);
  });

  it("fails provenance closed before cleanup and cancels non-processing outbox before deletion", async () => {
    seedPeople();
    seedMemory();
    const { relationship, imported } = importDraft();
    const bridge = createDateCompanionMemoryBridgeRepository(dcDatabase);
    bridge.putRetentionSetting({ userId: "user_a", enabled: true, expectedVersion: 0 });
    bridge.putPersonMapping({
      userId: "user_a",
      relationshipId: relationship.id,
      selfPersonId: "person_self",
      companionPersonId: "person_ta",
      relationshipType: "friend",
      expectedVersion: 0
    });
    const detail = dcRepository.getRelationshipView("user_a", relationship.id).interactions[0];
    dcRepository.updateRecap({
      userId: "user_a",
      interactionId: imported.interactionId,
      version: 0,
      assignments: [
        { speakerId: "speaker_0", role: "self" },
        { speakerId: "speaker_1", role: "companion" }
      ],
      mutations: detail.recapItems.map((item) => ({
        id: item.id,
        version: item.version,
        disposition: "kept" as const
      })),
      finalize: true
    });
    const store = transcriptStore();
    store.read.mockImplementation(async (kind: string) => {
      if (kind === "uploads") return {
        id: "upload_1",
        originalName: "date.wav",
        mimeType: "audio/wav",
        sizeBytes: 1024,
        recordingDate: "2026-08-11",
        status: "ready"
      };
      if (kind === "segments") return [];
      return null;
    });
    await expect(captureRetainedMemoryEvidenceProvenance({
      database: memoryDatabase,
      store: store as unknown as Pick<JsonStore, "read">,
      userId: "user_a",
      uploadId: "upload_1",
      relationshipId: relationship.id,
      interactionId: imported.interactionId
    })).rejects.toThrow("retained_evidence_segment_mismatch");
    expect(memoryDatabase.prepare("SELECT COUNT(*) AS count FROM dc_retained_uploads").get())
      .toEqual({ count: 0 });

    dcRepository.markUploadSourceState("user_a", "upload_1", "server_cleaned");
    expect(bridge.claimInteraction({
      userId: "user_a",
      interactionId: imported.interactionId,
      now: NOW,
      leaseMs: 1_000
    })).not.toBeNull();
    expect(() => prepareMemoryBridgeInteractionDeletion(
      dcDatabase,
      "user_a",
      imported.interactionId,
      NOW
    )).toThrow("memory_bridge_in_progress");
    prepareMemoryBridgeInteractionDeletion(
      dcDatabase,
      "user_a",
      imported.interactionId,
      "2026-08-11T00:00:02.000Z"
    );
    expect(bridge.getInteractionBridgeStatus("user_a", imported.interactionId))
      .toMatchObject({ status: "cancelled" });
  });

  it("rejects stale suggestion mappings and rolls forged selection finalization back", async () => {
    seedPeople();
    const { relationship, imported } = importDraft();
    const bridge = createDateCompanionMemoryBridgeRepository(dcDatabase);
    bridge.putRetentionSetting({ userId: "user_a", enabled: true, expectedVersion: 0 });
    bridge.putPersonMapping({
      userId: "user_a",
      relationshipId: relationship.id,
      selfPersonId: "person_self",
      companionPersonId: "person_ta",
      relationshipType: "dating",
      expectedVersion: 0
    });
    bridge.putPersonMapping({
      userId: "user_a",
      relationshipId: relationship.id,
      selfPersonId: "person_self",
      companionPersonId: "person_ta",
      relationshipType: "partner",
      expectedVersion: 1
    });
    const first = dcRepository.getRelationshipView("user_a", relationship.id).interactions[0];
    const staleConfirmation = await subjectConfirmation(imported.interactionId);
    expect(() => dcRepository.updateRecap({
      userId: "user_a",
      interactionId: imported.interactionId,
      version: 0,
      assignments: [
        { speakerId: "speaker_0", role: "self" },
        { speakerId: "speaker_1", role: "companion" }
      ],
      mutations: first.recapItems.map((item) => ({
        id: item.id,
        version: 0,
        disposition: "kept" as const
      })),
      memoryAdmission: {
        mappingVersion: 1,
        subjectSuggestionConfirmation: staleConfirmation,
        selections: first.recapItems.flatMap((item) => item.evidence.map((evidence) => ({
          evidenceSnapshotId: evidence.id,
          subject: "unknown" as const
        })))
      },
      finalize: true
    })).toThrow("subject_suggestion_batch_stale");
    expect(bridge.getInteractionBridgeStatus("user_a", imported.interactionId)).toBeNull();

    const second = dcRepository.importInteraction({
      userId: "user_a",
      relationshipId: relationship.id,
      sourceUploadId: "upload_2",
      recordingDate: "2026-08-11",
      originalName: "date-2.wav",
      participants: [{ speakerId: "speaker_1" }],
      recapCandidates: [{
        kind: "mentioned",
        proposedText: "Ta 想散步",
        sortOrder: 0,
        evidence: [{
          uploadId: "upload_2",
          sourceSegmentId: "segment_2",
          startSeconds: 0,
          endSeconds: 2,
          speakerId: "speaker_1",
          quote: "我想散步"
        }]
      }]
    });
    const secondDetail = dcRepository.getRelationshipView("user_a", relationship.id)
      .interactions.find((item) => item.id === second.interactionId)!;
    const secondConfirmation = await subjectConfirmation(second.interactionId);
    expect(() => dcRepository.updateRecap({
      userId: "user_a",
      interactionId: second.interactionId,
      version: 0,
      assignments: [{ speakerId: "speaker_1", role: "companion" }],
      mutations: [{
        id: secondDetail.recapItems[0].id,
        version: 0,
        disposition: "kept"
      }],
      memoryAdmission: {
        mappingVersion: 2,
        subjectSuggestionConfirmation: secondConfirmation,
        selections: [{ evidenceSnapshotId: "forged_snapshot", subject: "companion" }]
      },
      finalize: true
    })).toThrow("memory_evidence_selection_not_kept");
    const after = dcRepository.getRelationshipView("user_a", relationship.id)
      .interactions.find((item) => item.id === second.interactionId)!;
    expect(after.status).toBe("draft");
    expect(after.recapItems[0].disposition).toBe("pending");
    expect(bridge.getInteractionBridgeStatus("user_a", second.interactionId)).toBeNull();
  });

  it("backfills explicitly selected kept historical snapshots through formal Memory admission", async () => {
    seedPeople();
    const { relationship, imported } = importDraft();
    const draft = dcRepository.getRelationshipView("user_a", relationship.id).interactions[0];
    dcRepository.updateRecap({
      userId: "user_a",
      interactionId: imported.interactionId,
      version: 0,
      assignments: [
        { speakerId: "speaker_0", role: "self" },
        { speakerId: "speaker_1", role: "companion" }
      ],
      mutations: draft.recapItems.map((item) => ({
        id: item.id,
        version: 0,
        disposition: "kept" as const
      })),
      finalize: true
    });
    const bridge = createDateCompanionMemoryBridgeRepository(dcDatabase);
    bridge.putRetentionSetting({ userId: "user_a", enabled: true, expectedVersion: 0 });
    const mapping = bridge.putPersonMapping({
      userId: "user_a",
      relationshipId: relationship.id,
      selfPersonId: "person_self",
      companionPersonId: "person_ta",
      relationshipType: "friend",
      expectedVersion: 0
    });
    const confirmed = dcRepository.getRelationshipView("user_a", relationship.id).interactions[0];
    const companionEvidence = confirmed.recapItems
      .flatMap((item) => item.evidence)
      .find((evidence) => evidence.sourceSegmentId === "segment_companion")!;
    const unknownEvidence = confirmed.recapItems
      .flatMap((item) => item.evidence)
      .find((evidence) => evidence.sourceSegmentId === "segment_unknown")!;
    const confirmation = await subjectConfirmation(imported.interactionId);
    bridge.queueInteractionSync({
      userId: "user_a",
      interactionId: imported.interactionId,
      mappingVersion: mapping.version,
      subjectSuggestionConfirmation: confirmation,
      selections: [
        { evidenceSnapshotId: companionEvidence.id, subject: "companion" },
        { evidenceSnapshotId: unknownEvidence.id, subject: "unknown" }
      ]
    });
    dcRepository.markUploadSourceState("user_a", "upload_1", "server_cleaned");
    await processDateCompanionMemoryBridgeInteraction({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      userId: "user_a",
      interactionId: imported.interactionId
    });
    expect(createMemoryRepository(memoryDatabase).getRelevantMemories({ userId: "user_a" }))
      .toEqual([
        expect.objectContaining({
          type: "summary",
          title: "Ta 想去看展",
          summary: "Ta 想去看展",
          occurrenceCount: 1,
          evidence: [expect.objectContaining({
            sourceId: "segment_companion",
            quote: "我最近想去看展"
          })]
        })
      ]);
    expect(memoryDatabase.prepare(`
      SELECT recap_item_id, status, memory_id IS NOT NULL AS has_memory
      FROM dc_memory_bridge_candidate_receipts
      WHERE account_id = 'user_a' AND dc_interaction_id = ?
      ORDER BY recap_item_id
    `).all(imported.interactionId)).toEqual([
      {
        recap_item_id: confirmed.recapItems[0].id,
        status: "admitted",
        has_memory: 1
      },
      {
        recap_item_id: confirmed.recapItems[1].id,
        status: "rejected",
        has_memory: 0
      }
    ].sort((left, right) => left.recap_item_id.localeCompare(right.recap_item_id)));
    expect(memoryDatabase.prepare("SELECT COUNT(*) AS count FROM person_relationships WHERE status = 'confirmed'").get())
      .toEqual({ count: 1 });
    expect(memoryDatabase.prepare("SELECT COUNT(*) AS count FROM person_relationship_evidence").get())
      .toEqual({ count: 1 });
    expect(memoryDatabase.prepare("SELECT COUNT(*) AS count FROM person_subject_observations").get())
      .toEqual({ count: 1 });
    expect(createPersonMemoryRepository(memoryDatabase)
      .getPersonMemories({ accountId: "user_a", personId: "person_ta" })?.memories)
      .toHaveLength(1);
  });

  it("reconfirms an archived Person relationship through a durable epoch and rejects a late old payload", async () => {
    const { relationship, imported, bridge } = await completeRetainedBridge();
    const oldOutbox = dcDatabase.prepare(`
      SELECT payload_json, payload_digest FROM dc_memory_bridge_outbox
      WHERE user_id = 'user_a' AND interaction_id = ?
    `).get(imported.interactionId) as { payload_json: string; payload_digest: string };
    const selections = dcDatabase.prepare(`
      SELECT evidence_snapshot_id, subject FROM dc_memory_subject_selections
      WHERE user_id = 'user_a' AND interaction_id = ? ORDER BY evidence_snapshot_id
    `).all(imported.interactionId) as Array<{
      evidence_snapshot_id: string;
      subject: "self" | "companion" | "both" | "unknown";
    }>;
    const personRelationship = memoryDatabase.prepare(`
      SELECT id FROM person_relationships WHERE account_id = 'user_a'
    `).get() as { id: string };
    memoryDatabase.transaction(() => {
      memoryDatabase.prepare(`
        DELETE FROM person_relationship_evidence
        WHERE account_id = 'user_a' AND relationship_id = ?
      `).run(personRelationship.id);
      memoryDatabase.prepare(`
        UPDATE person_relationships
        SET status = 'archived', explicitly_confirmed = 0, confirmed_at = NULL
        WHERE id = ? AND account_id = 'user_a'
      `).run(personRelationship.id);
      memoryDatabase.prepare(`
        UPDATE person_relationship_admissions SET version = version + 1
        WHERE account_id = 'user_a' AND relationship_id = ?
      `).run(personRelationship.id);
      memoryDatabase.prepare(`
        UPDATE dc_person_relationship_links SET status = 'archived'
        WHERE account_id = 'user_a' AND dc_relationship_id = ?
      `).run(relationship.id);
    })();
    dcDatabase.prepare(`
      UPDATE dc_memory_bridge_outbox
      SET status = 'needs_review', last_error_code = 'person_relationship_requires_review',
          completed_at = NULL
      WHERE user_id = 'user_a' AND interaction_id = ?
    `).run(imported.interactionId);
    expect(bridge.getInteractionBridgeStatus("user_a", imported.interactionId)).toMatchObject({
      status: "needs_review",
      review: {
        kind: "relationship_reconfirmation_required",
        canReconfirm: true,
        nextAction: "reconfirm_archived_relationship"
      }
    });

    const confirmation = await subjectConfirmation(imported.interactionId);
    bridge.queueInteractionSync({
      userId: "user_a",
      interactionId: imported.interactionId,
      mappingVersion: 1,
      subjectSuggestionConfirmation: confirmation,
      selections: selections.map((selection) => ({
        evidenceSnapshotId: selection.evidence_snapshot_id,
        subject: selection.subject
      })),
      relationshipReconfirmation: {
        action: "reconfirm_archived_relationship",
        idempotencyKey: `relationship-reconfirm-${imported.interactionId}`
      },
      memoryDatabase
    });
    expect(dcDatabase.prepare(`
      SELECT status, epoch, expected_admission_version
      FROM dc_relationship_reconfirmation_authorizations
      WHERE user_id = 'user_a' AND interaction_id = ?
    `).get(imported.interactionId)).toEqual({
      status: "authorized",
      epoch: 1,
      expected_admission_version: 2
    });
    await expect(processDateCompanionMemoryBridgeInteraction({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      userId: "user_a",
      interactionId: imported.interactionId
    })).resolves.toMatchObject({ completed: true, idempotent: false });
    expect(memoryDatabase.prepare(`
      SELECT r.status, l.status AS link_status, l.relationship_epoch,
             a.version AS admission_version
      FROM person_relationships r
      INNER JOIN person_relationship_admissions a
        ON a.account_id = r.account_id AND a.relationship_id = r.id
      INNER JOIN dc_person_relationship_links l
        ON l.account_id = r.account_id AND l.person_relationship_id = r.id
      WHERE r.id = ? AND r.account_id = 'user_a'
    `).get(personRelationship.id)).toEqual({
      status: "confirmed",
      link_status: "active",
      relationship_epoch: 1,
      admission_version: 3
    });
    expect(dcDatabase.prepare(`
      SELECT status, consumed_at IS NOT NULL AS consumed
      FROM dc_relationship_reconfirmation_authorizations
      WHERE user_id = 'user_a' AND interaction_id = ?
    `).get(imported.interactionId)).toEqual({ status: "consumed", consumed: 1 });

    const completedReconfirmationOutbox = dcDatabase.prepare(`
      SELECT id, idempotency_key, payload_digest FROM dc_memory_bridge_outbox
      WHERE user_id = 'user_a' AND interaction_id = ?
    `).get(imported.interactionId) as {
      id: string;
      idempotency_key: string;
      payload_digest: string;
    };
    memoryDatabase.transaction(() => {
      memoryDatabase.prepare(`
        DELETE FROM dc_memory_bridge_receipts
        WHERE account_id = 'user_a' AND idempotency_key = ?
      `).run(dateCompanionMemoryProjectionIdempotencyKey(
        completedReconfirmationOutbox.idempotency_key
      ));
      memoryDatabase.prepare(`
        INSERT INTO dc_memory_bridge_receipts (
          id, account_id, idempotency_key, payload_digest, dc_relationship_id,
          dc_interaction_id, dc_outbox_id, mapping_version, committed_at
        ) VALUES (
          'legacy_consumed_reconfirmation_receipt', 'user_a', ?, ?, ?, ?, ?, 1, ?
        )
      `).run(
        completedReconfirmationOutbox.idempotency_key,
        completedReconfirmationOutbox.payload_digest,
        relationship.id,
        imported.interactionId,
        completedReconfirmationOutbox.id,
        NOW
      );
    })();
    expect(requeueCompletedLegacyMemoryProjections({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      now: "2026-08-11T00:00:01.000Z"
    })).toEqual({ scanned: 1, requeued: 1 });
    await expect(processDateCompanionMemoryBridgeInteraction({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      userId: "user_a",
      interactionId: imported.interactionId
    })).resolves.toMatchObject({ completed: true, idempotent: false });
    expect(dcDatabase.prepare(`
      SELECT status, consumed_at IS NOT NULL AS consumed
      FROM dc_relationship_reconfirmation_authorizations
      WHERE user_id = 'user_a' AND interaction_id = ?
    `).get(imported.interactionId)).toEqual({ status: "consumed", consumed: 1 });
    expect(bridge.getInteractionBridgeStatus("user_a", imported.interactionId))
      .toMatchObject({ status: "completed" });

    const memoryWriteCounts = () => memoryDatabase.prepare(`
      SELECT
        (SELECT COUNT(*) FROM person_evidence) AS person_evidence_count,
        (SELECT COUNT(*) FROM person_relationship_evidence) AS relationship_evidence_count,
        (SELECT COUNT(*) FROM person_subject_observations) AS subject_observation_count,
        (SELECT COUNT(*) FROM person_subject_admissions) AS subject_admission_count,
        (SELECT COUNT(*) FROM dc_memory_bridge_receipts) AS receipt_count
    `).get();
    const beforeLatePayload = memoryWriteCounts();
    const latePayload = JSON.parse(oldOutbox.payload_json) as Record<string, unknown>;
    latePayload.relationshipEpoch = 0;
    const lateDigest = stableBridgeDigest(latePayload);
    dcDatabase.prepare(`
      UPDATE dc_memory_bridge_outbox
      SET payload_json = ?, payload_digest = ?, idempotency_key = ?, status = 'pending',
          attempt_count = 0, claim_token = NULL, lease_expires_at = NULL,
          last_error_code = NULL, completed_at = NULL
      WHERE user_id = 'user_a' AND interaction_id = ?
    `).run(
      JSON.stringify(latePayload),
      lateDigest,
      `late-old-worker-${imported.interactionId}`,
      imported.interactionId
    );
    await expect(processDateCompanionMemoryBridgeInteraction({
      dateCompanionDatabase: dcDatabase,
      memoryDatabase,
      userId: "user_a",
      interactionId: imported.interactionId
    })).rejects.toThrow("relationship_reconfirmation_epoch_stale");
    expect(memoryDatabase.prepare(`
      SELECT status FROM person_relationships WHERE id = ? AND account_id = 'user_a'
    `).get(personRelationship.id)).toEqual({ status: "confirmed" });
    expect(memoryDatabase.prepare(`
      SELECT relationship_epoch FROM dc_person_relationship_links
      WHERE account_id = 'user_a' AND dc_relationship_id = ?
    `).get(relationship.id)).toEqual({ relationship_epoch: 1 });
    expect(memoryWriteCounts()).toEqual(beforeLatePayload);

    memoryDatabase.transaction(() => {
      memoryDatabase.prepare(`
        DELETE FROM person_relationship_evidence
        WHERE account_id = 'user_a' AND relationship_id = ?
      `).run(personRelationship.id);
      memoryDatabase.prepare(`
        UPDATE person_relationships
        SET status = 'archived', explicitly_confirmed = 0, confirmed_at = NULL
        WHERE id = ? AND account_id = 'user_a'
      `).run(personRelationship.id);
      memoryDatabase.prepare(`
        UPDATE person_relationship_admissions SET version = version + 1
        WHERE account_id = 'user_a' AND relationship_id = ?
      `).run(personRelationship.id);
      memoryDatabase.prepare(`
        UPDATE dc_person_relationship_links SET status = 'archived'
        WHERE account_id = 'user_a' AND dc_relationship_id = ?
      `).run(relationship.id);
    })();
    dcDatabase.prepare(`
      UPDATE dc_memory_bridge_outbox
      SET status = 'needs_review', last_error_code = 'person_relationship_requires_review',
          claim_token = NULL, lease_expires_at = NULL, completed_at = NULL
      WHERE user_id = 'user_a' AND interaction_id = ?
    `).run(imported.interactionId);

    const cancelledKey = `relationship-reconfirm-cancelled-${imported.interactionId}`;
    const queueReconfirmation = (idempotencyKey: string) => bridge.queueInteractionSync({
      userId: "user_a",
      interactionId: imported.interactionId,
      mappingVersion: 1,
      subjectSuggestionConfirmation: confirmation,
      selections: selections.map((selection) => ({
        evidenceSnapshotId: selection.evidence_snapshot_id,
        subject: selection.subject
      })),
      relationshipReconfirmation: {
        action: "reconfirm_archived_relationship",
        idempotencyKey
      },
      memoryDatabase
    });
    queueReconfirmation(cancelledKey);
    const cancelledClaim = bridge.claimInteraction({
      userId: "user_a",
      interactionId: imported.interactionId,
      now: NOW,
      leaseMs: 1_000
    });
    expect(cancelledClaim).not.toBeNull();
    bridge.fail({
      userId: "user_a",
      outboxId: cancelledClaim!.outboxId,
      claimToken: cancelledClaim!.claimToken,
      errorCode: "person_relationship_requires_review",
      needsReview: true
    });
    expect(dcDatabase.prepare(`
      SELECT status, epoch FROM dc_relationship_reconfirmation_authorizations
      WHERE user_id = 'user_a' AND idempotency_key = ?
    `).get(cancelledKey)).toEqual({ status: "cancelled", epoch: 2 });
    const failedOutbox = dcDatabase.prepare(`
      SELECT status, attempt_count, last_error_code, updated_at
      FROM dc_memory_bridge_outbox
      WHERE user_id = 'user_a' AND interaction_id = ?
    `).get(imported.interactionId) as {
      status: string;
      attempt_count: number;
      last_error_code: string;
      updated_at: string;
    };
    expect(failedOutbox).toMatchObject({
      status: "needs_review",
      attempt_count: 2,
      last_error_code: "person_relationship_requires_review"
    });
    expect(failedOutbox.updated_at).not.toBe(NOW);
    expect(() => queueReconfirmation(cancelledKey))
      .toThrow("relationship_reconfirmation_idempotency_conflict");

    const replacementKey = `relationship-reconfirm-replacement-${imported.interactionId}`;
    queueReconfirmation(replacementKey);
    expect(dcDatabase.prepare(`
      SELECT status, epoch, expected_admission_version
      FROM dc_relationship_reconfirmation_authorizations
      WHERE user_id = 'user_a' AND idempotency_key = ?
    `).get(replacementKey)).toEqual({
      status: "authorized",
      epoch: 3,
      expected_admission_version: 4
    });
    expect(bridge.getInteractionBridgeStatus("user_a", imported.interactionId))
      .toMatchObject({ status: "pending", attemptCount: 2 });
  });
});
