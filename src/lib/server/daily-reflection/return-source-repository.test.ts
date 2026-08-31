import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { DailyReflectionWorkingCard } from
  "@/lib/domain/daily-reflection-working-card";
import type { TranscriptSegment } from "@/lib/domain/types";
import {
  createDailyReflectionProposalAdmissionRepository,
  type DailyReflectionProposalAdmissionInput
} from "@/lib/server/memory/daily-reflection-proposal-admission";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import type { MemoryOwnerResolution } from
  "@/lib/server/memory/owner-attribution/types";
import type { MemoryWriteInput } from "@/lib/server/memory/types";

import { openDailyReflectionDatabase } from "./db";
import {
  createDailyReflectionMemoryProposalRepository
} from "./memory-proposal-repository";
import {
  createDailyReflectionReturnSourceRepository
} from "./return-source-repository";

const NOW = "2026-08-24T08:00:00.000Z";

type HarnessOptions = {
  accountId?: string;
  cardId?: string;
  proposalId?: string;
  memoryType?: MemoryWriteInput["type"];
  cardKind?: DailyReflectionWorkingCard["cardKind"];
  reflectionCardKind?: "insight" | "open_question" | "decision" | "user_action";
  reviewStatus?: "not_proposed" | "pending" | "kept" | "excluded";
  actionClaimed?: boolean;
  epistemicStatus?: "explicit_user_statement" | "reported_event" | "ai_inference" | "unknown";
  recordingDate?: string;
  sourceOrigin?: "user_reflection" | "direct_conversation";
  text?: string;
};

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function owner(memory: MemoryWriteInput): MemoryOwnerResolution {
  return {
    version: 1,
    memoryId: memory.id,
    memoryType: memory.type,
    scope: "unknown",
    owner: { type: "unknown", confidence: 0, source: "unknown" },
    participants: [],
    evidenceSegmentIds: memory.evidence.map((item) => item.sourceId),
    observations: [],
    reasons: ["owner_not_applicable"]
  };
}

function createHarness(options: HarnessOptions = {}) {
  const accountId = options.accountId ?? "account_1";
  const cardId = options.cardId ?? "card_1";
  const proposalId = options.proposalId ?? "legacy_confirmation_1";
  const memoryType = options.memoryType ?? "commitment";
  const cardKind = options.cardKind ?? "action";
  const reflectionCardKind = options.reflectionCardKind ?? "user_action";
  const reviewStatus = options.reviewStatus ?? "kept";
  const actionClaimed = options.actionClaimed ?? true;
  const epistemicStatus = options.epistemicStatus ?? "explicit_user_statement";
  const recordingDate = options.recordingDate ?? "2026-08-24";
  const sourceOrigin = options.sourceOrigin ?? "user_reflection";
  const text = options.text ?? "我确认本周提交项目复盘。";
  const reflectionId = "reflection_1";
  const uploadId = "upload_1";
  const segmentId = "segment_1";
  const memoryId = "memory_1";
  const evidenceId = "memory_evidence_1";
  const memoryDatabase = openMemoryDatabase({ filePath: ":memory:" });
  const dailyReflectionDatabase = openDailyReflectionDatabase({ filePath: ":memory:" });
  databases.push(memoryDatabase, dailyReflectionDatabase);

  const segment: TranscriptSegment = {
    id: segmentId,
    uploadId,
    startSeconds: 4,
    endSeconds: 12,
    speaker: "speaker_0",
    text,
    confidence: 0.96,
    sceneLabels: [],
    valueLabels: []
  };
  const workingCard: DailyReflectionWorkingCard = {
    id: cardId,
    accountId,
    sourceReflectionIds: [reflectionId],
    title: "提交项目复盘",
    content: text,
    cardKind,
    evidenceIds: [segmentId],
    status: "saved",
    importance: 0.9,
    novelty: 0.8,
    relatedCardIds: [],
    tags: [],
    visibility: "private",
    sourceUnavailable: false,
    memoryLifecycleStatus: "active",
    memoryLifecycleVersion: 1,
    memoryLifecycleUpdatedAt: NOW,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW
  };
  let canonicalText = text;
  let listedWorkingCards: DailyReflectionWorkingCard[] = [];
  let confirmationSnapshotStatus: "kept" | "excluded" =
    reviewStatus === "kept" ? "kept" : "excluded";
  let confirmationSaveIntent: "recap_only" | "retain_selected" = "recap_only";
  let admissionOperationStatus: "admitting" | "completed" = "completed";
  const reflectionCard = {
    id: cardId,
    reflectionId,
    cardKind: reflectionCardKind,
    proposedTitle: workingCard.title,
    proposedText: workingCard.content,
    userTitle: null,
    userText: null,
    actionClaimed,
    epistemicStatus,
    reviewStatus,
    durability: 0.9,
    riskFlags: []
  };
  const sourceRepository = {
    getWorkingCardWithEvidence(requestAccountId: string, requestCardId: string) {
      if (requestAccountId !== accountId || requestCardId !== cardId) {
        throw new Error("not found");
      }
      return {
        card: workingCard,
        evidence: [{
          sourceSegmentId: segmentId,
          uploadId,
          effectiveOrigin: sourceOrigin,
          startSeconds: segment.startSeconds,
          endSeconds: segment.endSeconds,
          text: canonicalText
        }]
      };
    },
    getWorkingCard(requestAccountId: string, requestCardId: string) {
      if (requestAccountId !== accountId || requestCardId !== cardId) {
        throw new Error("not found");
      }
      return workingCard;
    },
    getReflection(requestAccountId: string, requestReflectionId: string) {
      return requestAccountId === accountId && requestReflectionId === reflectionId
        ? { id: reflectionId, accountId, uploadId, status: "completed", version: 1 }
        : null;
    },
    getConfirmation() {
      return {
        contractVersion: 2,
        id: proposalId,
        reflectionId,
        accountId,
        fingerprint: "a".repeat(64),
        requestFingerprint: "b".repeat(64),
        idempotencyKey: "confirmation_1",
        operationKey: "operation_1",
        sourceOrigin,
        inputMethod: "file_upload",
        processingProfile: "quick_reflection",
        inputAdapter: "file_picker",
        capturePurpose: "inspiration_capture",
        recordingDate,
        saveIntent: confirmationSaveIntent,
        candidateSnapshots: [{
          contractVersion: 2,
          candidateId: cardId,
          proposedText: text,
          userText: null,
          finalText: text,
          status: confirmationSnapshotStatus,
          candidateKind: reflectionCardKind,
          candidateType: reflectionCardKind === "open_question"
            ? "question"
            : reflectionCardKind === "user_action" && actionClaimed
              ? "commitment"
              : "summary",
          evidenceIds: [segmentId],
          sourceSegmentIds: [segmentId],
          evidenceSnapshots: [{
            sourceSegmentId: segmentId,
            uploadId,
            startSeconds: segment.startSeconds,
            endSeconds: segment.endSeconds,
            text,
            effectiveOrigin: sourceOrigin
          }],
          confidence: 0.9,
          caution: "fixture",
          actionClaimed,
          subjectPersonId: null
        }],
        createdAt: NOW
      };
    },
    getProcessingPlan() {
      return {
        planVersion: 2,
        reflectionId,
        uploadId,
        inputMethod: "file_upload",
        sourceOrigin,
        processingProfile: "quick_reflection",
        ingestionContext: "daily_reflection",
        reviewPolicy: "required",
        inputAdapter: "file_picker",
        capturePurpose: "inspiration_capture",
        effectiveDurationMs: 120_000,
        durationSource: "server_ffprobe",
        candidateLimit: 3
      };
    },
    getReflectionV2Input() {
      return {
        operationKey: "operation_1",
        inputAdapter: "file_picker",
        sourceOrigin,
        capturePurpose: "inspiration_capture",
        recordingDate
      };
    },
    readPublishedAsset(input: { assetKind: "upload" | "segments" }) {
      return input.assetKind === "upload" ? {
        id: uploadId,
        recordingDate,
        mimeType: "audio/wav",
        originalName: "return-fixture.wav",
        sizeBytes: 1024,
        status: "ready"
      } : [{ ...segment, text: canonicalText }];
    },
    listReflectionCards(requestAccountId: string, requestReflectionId: string) {
      return requestAccountId === accountId && requestReflectionId === reflectionId
        ? [reflectionCard]
        : [];
    },
    listCandidates(requestAccountId: string, requestReflectionId: string) {
      return requestAccountId === accountId && requestReflectionId === reflectionId
        ? [{ id: cardId, subjectConfirmed: false, subjectPersonId: null }]
        : [];
    },
    getAdmissionOperation() {
      return confirmationSaveIntent === "retain_selected"
        ? { status: admissionOperationStatus }
        : null;
    },
    getAdmissionExecutionMethod() {
      return confirmationSaveIntent === "retain_selected"
        ? "memory_proposal_v1"
        : null;
    },
    listWorkingCards(input: { accountId: string }) {
      const cards = input.accountId === accountId ? listedWorkingCards : [];
      return { cards, total: cards.length, limit: 100, offset: 0 };
    }
  };

  dailyReflectionDatabase.prepare(`
    INSERT INTO dr_reflections (
      id, account_id, upload_id, input_method, processing_profile,
      ingestion_context, status, version, idempotency_key,
      create_fingerprint, source_origin, created_at, updated_at
    ) VALUES (?, ?, ?, 'file_upload', 'quick_reflection',
              'daily_reflection', 'review_pending', 1, ?, ?, ?, ?, ?)
  `).run(
    reflectionId,
    accountId,
    uploadId,
    `reflection-operation-${cardId}`,
    "c".repeat(64),
    sourceOrigin,
    NOW,
    NOW
  );
  dailyReflectionDatabase.prepare(`
    INSERT INTO dr_reflection_confirmations (
      id, account_id, reflection_id, idempotency_key,
      request_fingerprint, confirmation_fingerprint, source_origin,
      input_method, processing_profile, candidate_snapshots_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'file_upload', 'quick_reflection', ?, ?)
  `).run(
    `legacy-confirmation-${cardId}`,
    accountId,
    reflectionId,
    `legacy-confirmation-operation-${cardId}`,
    "d".repeat(64),
    "e".repeat(64),
    sourceOrigin,
    JSON.stringify([{ candidateId: cardId, status: reviewStatus }]),
    NOW
  );
  dailyReflectionDatabase.prepare(`
    INSERT INTO dr_working_cards (
      id, account_id, source_reflection_ids_json, title, content, card_kind,
      evidence_ids_json, status, importance, novelty, related_card_ids_json,
      tags_json, visibility, source_unavailable, memory_lifecycle_status,
      memory_lifecycle_version, memory_lifecycle_updated_at, saved_at, version,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'saved', 0.9, 0.8, '[]', '[]',
              'private', 0, 'active', 1, ?, ?, 1, ?, ?)
  `).run(
    cardId,
    accountId,
    JSON.stringify([reflectionId]),
    workingCard.title,
    workingCard.content,
    workingCard.cardKind,
    JSON.stringify(workingCard.evidenceIds),
    NOW,
    NOW,
    NOW,
    NOW
  );

  const memory: MemoryWriteInput = {
    id: memoryId,
    type: memoryType,
    title: workingCard.title,
    summary: text,
    importance: 0.9,
    status: "active",
    date: recordingDate,
    createdAt: NOW,
    updatedAt: NOW,
    evidence: [{
      id: evidenceId,
      sourceType: "transcript",
      sourceId: segmentId,
      uploadId,
      date: recordingDate,
      quote: text,
      createdAt: NOW
    }]
  };
  const admissionInput: DailyReflectionProposalAdmissionInput = {
    userId: accountId,
    reflectionId,
    proposalId,
    cardId,
    operationKey: `daily-reflection-card:${cardId}`,
    payloadDigest: "payload_digest_1",
    publicationId: "publication_1",
    publicationFingerprint: "publication_fingerprint_1",
    publicationDigest: "publication_digest_1",
    uploadId,
    sourceOrigin,
    inputAdapter: "file_picker",
    capturePurpose: "inspiration_capture",
    recordingDate,
    memory,
    ownerAttribution: owner(memory),
    evidenceDigests: [{
      memoryEvidenceId: evidenceId,
      sourceSegmentId: segmentId,
      contentDigest: digest({
        version: 1,
        accountId,
        reflectionId,
        uploadId,
        sourceSegmentId: segmentId,
        quote: text,
        sourceOrigin
      })
    }],
    sourceSegments: [segment],
    now: NOW
  };
  const admission = createDailyReflectionProposalAdmissionRepository(memoryDatabase);
  admission.applyProposal(admissionInput);
  admission.markPublished({ userId: accountId, reflectionId, now: NOW });
  const repository = createDailyReflectionReturnSourceRepository(
    memoryDatabase,
    dailyReflectionDatabase,
    { sourceRepository: sourceRepository as never }
  );

  return {
    accountId,
    cardId,
    proposalId,
    memoryId,
    evidenceId,
    memoryDatabase,
    dailyReflectionDatabase,
    workingCard,
    sourceRepository,
    repository,
    changeCanonicalText(value: string) {
      canonicalText = value;
    },
    showWorkingCard() {
      listedWorkingCards = [workingCard];
    },
    setRetainOperationStatus(status: "admitting" | "completed") {
      confirmationSaveIntent = "retain_selected";
      confirmationSnapshotStatus = "kept";
      admissionOperationStatus = status;
    },
    createProposal(status: "pending" | "rejected") {
      confirmationSnapshotStatus = "excluded";
      const proposalRepository = createDailyReflectionMemoryProposalRepository(
        dailyReflectionDatabase,
        { sourceRepository: sourceRepository as never, now: () => NOW }
      );
      const created = proposalRepository.create({
        accountId,
        cardId,
        expectedCardVersion: 1,
        memoryType: memoryType === "commitment" ? "commitment" : "event"
      }).proposal;
      if (status === "rejected") {
        proposalRepository.evaluate({
          accountId,
          proposalId: created.id,
          expectedVersion: created.version,
          decision: "rejected",
          policyVersion: "test_policy_v1",
          score: 0,
          reasons: ["test_rejected"]
        });
      }
      memoryDatabase.prepare(`
        UPDATE memory_daily_reflection_candidate_payloads
        SET confirmation_id = ?
        WHERE user_id = ? AND candidate_id = ?
      `).run(created.id, accountId, cardId);
      memoryDatabase.prepare(`
        UPDATE memory_daily_reflection_publications
        SET confirmation_id = ?, updated_at = ?
        WHERE user_id = ? AND reflection_id = ?
      `).run(created.id, NOW, accountId, reflectionId);
      memoryDatabase.prepare(`
        UPDATE memory_daily_reflection_candidate_current_memories
        SET confirmation_id = ?
        WHERE user_id = ? AND candidate_id = ?
      `).run(created.id, accountId, cardId);
      memoryDatabase.prepare(`
        UPDATE memory_daily_reflection_evidence_provenance
        SET confirmation_id = ?
        WHERE user_id = ? AND candidate_id = ?
      `).run(created.id, accountId, cardId);
      return created;
    }
  };
}

describe("Daily Reflection Return source authority", () => {
  it("returns a non-empty account-scoped active admitted source with exact Canonical Evidence", () => {
    const fixture = createHarness();

    const result = fixture.repository.snapshot(
      fixture.accountId,
      "2026-08-18",
      "2026-08-24"
    );

    expect(result.admitted).toEqual([expect.objectContaining({
      memoryId: fixture.memoryId,
      cardId: fixture.cardId,
      memoryType: "commitment",
      actionClaimed: true,
      epistemicStatus: "explicit_user_statement",
      evidence: [expect.objectContaining({
        sourceSegmentId: "segment_1",
        recordingDate: "2026-08-24",
        snippet: "我确认本周提交项目复盘。"
      })]
    })]);
    expect(fixture.repository.snapshot(
      "account_2",
      "2026-08-18",
      "2026-08-24"
    )).toEqual({
      admitted: [],
      workingCards: [],
      emergingCards: [],
      relations: []
    });
  });

  it("returns direct-conversation Memory using effective source provenance", () => {
    const fixture = createHarness({ sourceOrigin: "direct_conversation" });

    const result = fixture.repository.snapshot(
      fixture.accountId,
      "2026-08-18",
      "2026-08-24"
    );

    expect(result.admitted).toEqual([expect.objectContaining({
      memoryId: fixture.memoryId,
      cardId: fixture.cardId,
      evidence: [expect.objectContaining({
        sourceOrigin: "direct_conversation",
        sourceSegmentId: "segment_1"
      })]
    })]);
  });

  it("returns every admitted Proposal from one Reflection even when publication keeps the first Proposal id", () => {
    const fixture = createHarness();
    const firstProposal = fixture.createProposal("pending");
    fixture.dailyReflectionDatabase.prepare(`
      UPDATE dr_memory_proposals
      SET status = 'admitted', memory_id = ?, admitted_at = ?,
          version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(fixture.memoryId, NOW, NOW, firstProposal.id);

    const secondCardId = "card_2";
    const secondMemoryId = "memory_2";
    const secondEvidenceId = "memory_evidence_2";
    const secondText = "我确认下周整理项目风险清单。";
    const secondSegment: TranscriptSegment = {
      id: "segment_2",
      uploadId: "upload_1",
      startSeconds: 14,
      endSeconds: 22,
      speaker: "speaker_0",
      text: secondText,
      confidence: 0.95,
      sceneLabels: [],
      valueLabels: []
    };
    const secondWorkingCard: DailyReflectionWorkingCard = {
      ...fixture.workingCard,
      id: secondCardId,
      title: "整理项目风险清单",
      content: secondText,
      evidenceIds: [secondSegment.id]
    };
    const secondReflectionCard = {
      id: secondCardId,
      reflectionId: "reflection_1",
      cardKind: "user_action" as const,
      proposedTitle: secondWorkingCard.title,
      proposedText: secondWorkingCard.content,
      userTitle: null,
      userText: null,
      actionClaimed: true,
      epistemicStatus: "explicit_user_statement" as const,
      reviewStatus: "kept" as const,
      durability: 0.9,
      riskFlags: []
    };
    const firstGetWithEvidence = fixture.sourceRepository
      .getWorkingCardWithEvidence.bind(fixture.sourceRepository);
    fixture.sourceRepository.getWorkingCardWithEvidence = ((accountId, cardId) => (
      cardId === secondCardId
        ? {
            card: secondWorkingCard,
            evidence: [{
              sourceSegmentId: secondSegment.id,
              uploadId: secondSegment.uploadId,
              effectiveOrigin: "user_reflection" as const,
              startSeconds: secondSegment.startSeconds,
              endSeconds: secondSegment.endSeconds,
              text: secondSegment.text
            }]
          }
        : firstGetWithEvidence(accountId, cardId)
    )) as typeof fixture.sourceRepository.getWorkingCardWithEvidence;
    const firstGetWorkingCard = fixture.sourceRepository.getWorkingCard
      .bind(fixture.sourceRepository);
    fixture.sourceRepository.getWorkingCard = ((accountId, cardId) => (
      cardId === secondCardId
        ? secondWorkingCard
        : firstGetWorkingCard(accountId, cardId)
    )) as typeof fixture.sourceRepository.getWorkingCard;
    const firstListReflectionCards = fixture.sourceRepository.listReflectionCards
      .bind(fixture.sourceRepository);
    fixture.sourceRepository.listReflectionCards = ((accountId, reflectionId) => [
      ...firstListReflectionCards(accountId, reflectionId),
      secondReflectionCard
    ]) as typeof fixture.sourceRepository.listReflectionCards;
    const firstListCandidates = fixture.sourceRepository.listCandidates
      .bind(fixture.sourceRepository);
    fixture.sourceRepository.listCandidates = ((accountId, reflectionId) => [
      ...firstListCandidates(accountId, reflectionId),
      { id: secondCardId, subjectConfirmed: false, subjectPersonId: null }
    ]) as typeof fixture.sourceRepository.listCandidates;
    const firstReadPublishedAsset = fixture.sourceRepository.readPublishedAsset
      .bind(fixture.sourceRepository);
    const firstSegments = firstReadPublishedAsset({ assetKind: "segments" }) as
      TranscriptSegment[];
    fixture.sourceRepository.readPublishedAsset = ((input) => (
      input.assetKind === "segments"
        ? [...firstSegments, secondSegment]
        : firstReadPublishedAsset(input)
    )) as typeof fixture.sourceRepository.readPublishedAsset;

    fixture.dailyReflectionDatabase.prepare(`
      INSERT INTO dr_working_cards (
        id, account_id, source_reflection_ids_json, title, content, card_kind,
        evidence_ids_json, status, importance, novelty, related_card_ids_json,
        tags_json, visibility, source_unavailable, memory_lifecycle_status,
        memory_lifecycle_version, memory_lifecycle_updated_at, saved_at, version,
        created_at, updated_at
      ) VALUES (?, ?, '["reflection_1"]', ?, ?, 'action', ?, 'saved', 0.9,
                0.8, '[]', '[]', 'private', 0, 'active', 1, ?, ?, 1, ?, ?)
    `).run(
      secondCardId,
      fixture.accountId,
      secondWorkingCard.title,
      secondWorkingCard.content,
      JSON.stringify(secondWorkingCard.evidenceIds),
      NOW,
      NOW,
      NOW,
      NOW
    );
    const proposalRepository = createDailyReflectionMemoryProposalRepository(
      fixture.dailyReflectionDatabase,
      { sourceRepository: fixture.sourceRepository as never, now: () => NOW }
    );
    const secondProposal = proposalRepository.create({
      accountId: fixture.accountId,
      cardId: secondCardId,
      expectedCardVersion: secondWorkingCard.version,
      memoryType: "commitment"
    }).proposal;
    const secondMemory: MemoryWriteInput = {
      id: secondMemoryId,
      type: "commitment",
      title: secondWorkingCard.title,
      summary: secondText,
      importance: 0.9,
      status: "active",
      date: "2026-08-24",
      createdAt: NOW,
      updatedAt: NOW,
      evidence: [{
        id: secondEvidenceId,
        sourceType: "transcript",
        sourceId: secondSegment.id,
        uploadId: secondSegment.uploadId,
        date: "2026-08-24",
        quote: secondText,
        createdAt: NOW
      }]
    };
    createDailyReflectionProposalAdmissionRepository(fixture.memoryDatabase)
      .applyProposal({
        userId: fixture.accountId,
        reflectionId: "reflection_1",
        proposalId: secondProposal.id,
        cardId: secondCardId,
        operationKey: `daily-reflection-card:${secondCardId}`,
        payloadDigest: "payload_digest_2",
        publicationId: "publication_1",
        publicationFingerprint: "publication_fingerprint_1",
        publicationDigest: "publication_digest_1",
        uploadId: "upload_1",
        sourceOrigin: "user_reflection",
        inputAdapter: "file_picker",
        capturePurpose: "inspiration_capture",
        recordingDate: "2026-08-24",
        memory: secondMemory,
        ownerAttribution: owner(secondMemory),
        evidenceDigests: [{
          memoryEvidenceId: secondEvidenceId,
          sourceSegmentId: secondSegment.id,
          contentDigest: digest({
            version: 1,
            accountId: fixture.accountId,
            reflectionId: "reflection_1",
            uploadId: "upload_1",
            sourceSegmentId: secondSegment.id,
            quote: secondText,
            sourceOrigin: "user_reflection"
          })
        }],
        sourceSegments: [...firstSegments, secondSegment],
        now: NOW
      });
    fixture.dailyReflectionDatabase.prepare(`
      UPDATE dr_memory_proposals
      SET status = 'admitted', memory_id = ?, admitted_at = ?,
          version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(secondMemoryId, NOW, NOW, secondProposal.id);

    const publication = fixture.memoryDatabase.prepare(`
      SELECT confirmation_id FROM memory_daily_reflection_publications
      WHERE user_id = ? AND reflection_id = 'reflection_1'
    `).get(fixture.accountId) as { confirmation_id: string };
    expect(publication.confirmation_id).toBe(firstProposal.id);
    expect(fixture.repository.snapshot(
      fixture.accountId,
      "2026-08-18",
      "2026-08-24"
    ).admitted.map((source) => source.memoryId)).toEqual([
      fixture.memoryId,
      secondMemoryId
    ]);
  });

  it("hides retain-selected Proposal publication until the outer receipt is completed", () => {
    const fixture = createHarness();
    const created = fixture.createProposal("pending");
    fixture.dailyReflectionDatabase.prepare(`
      UPDATE dr_memory_proposals
      SET status = 'admitted', memory_id = ?, admitted_at = ?,
          version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(fixture.memoryId, NOW, NOW, created.id);

    fixture.setRetainOperationStatus("admitting");
    expect(fixture.repository.snapshot(
      fixture.accountId,
      "2026-08-18",
      "2026-08-24"
    ).admitted).toEqual([]);

    fixture.setRetainOperationStatus("completed");
    expect(fixture.repository.snapshot(
      fixture.accountId,
      "2026-08-18",
      "2026-08-24"
    ).admitted).toEqual([expect.objectContaining({
      memoryId: fixture.memoryId,
      cardId: fixture.cardId
    })]);
  });

  it("fails closed when a legacy current authority no longer matches publication confirmation", () => {
    const fixture = createHarness();
    fixture.memoryDatabase.prepare(`
      UPDATE memory_daily_reflection_publications
      SET confirmation_id = 'legacy_confirmation_drift'
      WHERE user_id = ? AND reflection_id = 'reflection_1'
    `).run(fixture.accountId);

    expect(fixture.repository.snapshot(
      fixture.accountId,
      "2026-08-18",
      "2026-08-24"
    ).admitted).toEqual([]);
  });

  it.each([
    ["unpublished publication", (fixture: ReturnType<typeof createHarness>) => {
      fixture.memoryDatabase.prepare(`
        UPDATE memory_daily_reflection_publications SET status = 'unpublished'
      `).run();
    }],
    ["resolved Memory", (fixture: ReturnType<typeof createHarness>) => {
      fixture.memoryDatabase.prepare(`
        UPDATE memory_items SET status = 'resolved' WHERE id = ?
      `).run(fixture.memoryId);
    }],
    ["revoked current authority", (fixture: ReturnType<typeof createHarness>) => {
      fixture.memoryDatabase.prepare(`
        UPDATE memory_daily_reflection_candidate_current_memories
        SET status = 'revoked', current_memory_id = NULL,
            revocation_id = 'revocation_1', revoked_at = ?, updated_at = ?
      `).run(NOW, NOW);
    }],
    ["Card revocation requested", (fixture: ReturnType<typeof createHarness>) => {
      fixture.workingCard.memoryLifecycleStatus = "revocation_requested";
    }],
    ["revoked Card", (fixture: ReturnType<typeof createHarness>) => {
      fixture.workingCard.memoryLifecycleStatus = "revoked";
    }]
  ])("ignores %s", (_label, mutate) => {
    const fixture = createHarness();
    mutate(fixture);
    expect(fixture.repository.snapshot(
      fixture.accountId,
      "2026-08-18",
      "2026-08-24"
    ).admitted).toEqual([]);
  });

  it.each(["pending", "rejected"] as const)(
    "ignores a %s Proposal even if a cross-database Memory authority exists",
    (status) => {
      const fixture = createHarness();
      fixture.createProposal(status);
      expect(fixture.repository.snapshot(
        fixture.accountId,
        "2026-08-18",
        "2026-08-24"
      ).admitted).toEqual([]);
    }
  );

  it("fails closed when the Canonical Transcript no longer matches immutable provenance", () => {
    const fixture = createHarness();
    fixture.changeCanonicalText("被修改后的文字不应进入 Return。");
    expect(fixture.repository.snapshot(
      fixture.accountId,
      "2026-08-18",
      "2026-08-24"
    ).admitted).toEqual([]);
  });

  it("requires the immutable Candidate payload authority", () => {
    const fixture = createHarness();
    fixture.memoryDatabase.prepare(`
      DELETE FROM memory_daily_reflection_candidate_payloads
      WHERE user_id = ? AND candidate_id = ?
    `).run(fixture.accountId, fixture.cardId);
    expect(fixture.repository.snapshot(
      fixture.accountId,
      "2026-08-18",
      "2026-08-24"
    ).admitted).toEqual([]);
  });

  it("requires an admitted Proposal to point at the current Memory and exact Evidence", () => {
    const fixture = createHarness();
    const proposal = fixture.createProposal("pending");
    fixture.dailyReflectionDatabase.prepare(`
      UPDATE dr_memory_proposals
      SET status = 'admitted', memory_id = ?, admitted_at = ?, version = version + 1,
          updated_at = ?
      WHERE id = ?
    `).run(fixture.memoryId, NOW, NOW, proposal.id);
    expect(fixture.repository.snapshot(
      fixture.accountId,
      "2026-08-18",
      "2026-08-24"
    ).admitted).toHaveLength(1);

    fixture.dailyReflectionDatabase.prepare(`
      UPDATE dr_memory_proposals SET memory_id = 'memory_drift' WHERE id = ?
    `).run(proposal.id);
    expect(fixture.repository.snapshot(
      fixture.accountId,
      "2026-08-18",
      "2026-08-24"
    ).admitted).toEqual([]);
  });

  it.each([
    ["current reflection", `
      UPDATE memory_daily_reflection_candidate_current_memories
      SET reflection_id = 'reflection_drift'
    `],
    ["provenance confirmation", `
      UPDATE memory_daily_reflection_evidence_provenance
      SET confirmation_id = 'confirmation_drift'
    `],
    ["provenance upload", `
      UPDATE memory_daily_reflection_evidence_provenance
      SET upload_id = 'upload_drift'
    `]
  ])("fails closed on %s metadata drift", (_label, sql) => {
    const fixture = createHarness();
    fixture.memoryDatabase.exec(sql);
    expect(fixture.repository.snapshot(
      fixture.accountId,
      "2026-08-18",
      "2026-08-24"
    ).admitted).toEqual([]);
  });

  it("drops the whole admitted projection when DR authority changes mid-read", () => {
    const fixture = createHarness();
    const read = fixture.sourceRepository.getWorkingCard.bind(fixture.sourceRepository);
    let reads = 0;
    fixture.sourceRepository.getWorkingCard = (...args) => {
      const card = read(...args);
      reads += 1;
      if (reads === 2) card.memoryLifecycleStatus = "revocation_requested";
      return card;
    };
    expect(fixture.repository.snapshot(
      fixture.accountId,
      "2026-08-18",
      "2026-08-24"
    ).admitted).toEqual([]);
  });

  it("does not treat an excluded legacy Reflection Card as an admitted Return source", () => {
    const fixture = createHarness({ reviewStatus: "excluded" });
    expect(fixture.repository.snapshot(
      fixture.accountId,
      "2026-08-18",
      "2026-08-24"
    ).admitted).toEqual([]);
  });

  it("uses a saved, Evidence-linked idea Card only for Emerging Ideas", () => {
    const fixture = createHarness({
      cardKind: "idea",
      reflectionCardKind: "insight",
      memoryType: "event"
    });
    fixture.showWorkingCard();
    const result = fixture.repository.snapshot(
      fixture.accountId,
      "2026-08-18",
      "2026-08-24"
    );
    expect(result.emergingCards).toEqual([expect.objectContaining({
      cardId: fixture.cardId,
      cardKind: "idea",
      recordingDates: ["2026-08-24"],
      evidence: [expect.objectContaining({ sourceSegmentId: "segment_1" })]
    })]);
    expect(result.workingCards).toEqual([expect.objectContaining({
      cardId: fixture.cardId,
      relatedCardIds: [],
      tags: [],
      riskFlags: []
    })]);
  });

  it("keeps a saved decision Card queryable without misclassifying it as Emerging Ideas", () => {
    const fixture = createHarness({
      cardKind: "decision",
      reflectionCardKind: "decision",
      memoryType: "summary"
    });
    fixture.showWorkingCard();
    const result = fixture.repository.snapshot(
      fixture.accountId,
      "2026-08-18",
      "2026-08-24"
    );
    expect(result.workingCards).toEqual([
      expect.objectContaining({ cardId: fixture.cardId, cardKind: "decision" })
    ]);
    expect(result.emergingCards).toEqual([]);
  });

  it("excludes a revoked Working Card from Emerging Ideas", () => {
    const fixture = createHarness({
      cardKind: "idea",
      reflectionCardKind: "insight",
      memoryType: "event"
    });
    fixture.showWorkingCard();
    fixture.workingCard.memoryLifecycleStatus = "revoked";
    expect(fixture.repository.snapshot(
      fixture.accountId,
      "2026-08-18",
      "2026-08-24"
    ).emergingCards).toEqual([]);
  });

  it("rechecks the saved Card detail instead of trusting a stale list summary", () => {
    const fixture = createHarness({ cardKind: "idea", reflectionCardKind: "insight" });
    fixture.showWorkingCard();
    fixture.workingCard.status = "archived";
    const result = fixture.repository.snapshot(
      fixture.accountId,
      "2026-08-18",
      "2026-08-24"
    );
    expect(result.workingCards).toEqual([]);
    expect(result.emergingCards).toEqual([]);
  });
});
