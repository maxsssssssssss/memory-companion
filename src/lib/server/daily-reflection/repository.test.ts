import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CreateDailyReflectionInput,
  DailyReflection,
  DailyReflectionStatus
} from "@/lib/domain/daily-reflection";

import { openDailyReflectionDatabase } from "./db";
import {
  DailyReflectionConflictError,
  DailyReflectionLeaseLostError,
  DailyReflectionNotFoundError,
  DailyReflectionRepository
} from "./repository";
import { DailyReflectionTransitionError } from "./state-machine";

const timestamp = "2026-08-13T00:00:00.000Z";

let database: Database.Database;
let repository: DailyReflectionRepository;
let generatedId = 0;

beforeEach(() => {
  database = openDailyReflectionDatabase({ filePath: ":memory:" });
  generatedId = 0;
  repository = new DailyReflectionRepository(database, {
    now: () => timestamp,
    idFactory: () => `generated_${++generatedId}`
  });
});

afterEach(() => {
  database.close();
});

function createInput(
  overrides: Partial<CreateDailyReflectionInput> = {}
): CreateDailyReflectionInput {
  return {
    id: "reflection_1",
    accountId: "account_1",
    uploadId: "upload_1",
    inputMethod: "file_upload",
    sourceOrigin: "unknown",
    processingProfile: "full_recording",
    ingestionContext: "daily_reflection",
    idempotencyKey: "create_1",
    ...overrides
  };
}

function transitionPath(
  reflection: DailyReflection,
  statuses: DailyReflectionStatus[]
) {
  return statuses.reduce((current, status) => repository.transitionStatus({
    accountId: current.accountId,
    reflectionId: current.id,
    expectedVersion: current.version,
    status
  }), reflection);
}

function createReviewPendingCandidateSet() {
  const created = repository.createReflection(createInput({
    sourceOrigin: "user_reflection"
  })).reflection;
  const extracting = transitionPath(created, [
    "uploading",
    "transcribing",
    "extracting"
  ]);
  const fence = repository.claimExecutionLease({
    accountId: extracting.accountId,
    reflectionId: extracting.id,
    leaseOwner: "candidate_builder",
    leaseDurationMs: 60_000,
    allowedStatuses: ["extracting"]
  });
  if (!fence) throw new Error("expected candidate builder lease");
  repository.publishAssetUnderExecutionFence({
    accountId: extracting.accountId,
    reflectionId: extracting.id,
    leaseOwner: fence.leaseOwner,
    attemptVersion: fence.attemptVersion,
    assetKind: "segments",
    payload: [
      {
        id: "segment_1",
        uploadId: "upload_1",
        startSeconds: 0,
        endSeconds: 8,
        text: "Contact Alice before Friday.",
        confidence: 0.98,
        sceneLabels: [],
        valueLabels: []
      },
      {
        id: "segment_2",
        uploadId: "upload_1",
        startSeconds: 8,
        endSeconds: 16,
        text: "Reconsider the travel plan.",
        confidence: 0.97,
        sceneLabels: [],
        valueLabels: []
      }
    ]
  });
  const saved = repository.savePendingCandidates({
    accountId: extracting.accountId,
    reflectionId: extracting.id,
    expectedVersion: extracting.version,
    leaseOwner: fence.leaseOwner,
    attemptVersion: fence.attemptVersion,
    candidates: [
      {
        id: "candidate_1",
        ordinal: 0,
        proposedText: "Contact Alice before Friday.",
        candidateType: "commitment",
        sourceSegmentIds: ["segment_1"]
      },
      {
        id: "candidate_2",
        ordinal: 1,
        proposedText: "Reconsider the travel plan.",
        candidateType: "event",
        sourceSegmentIds: ["segment_2"]
      }
    ]
  });
  const reflection = repository.transitionStatus({
    accountId: saved.reflection.accountId,
    reflectionId: saved.reflection.id,
    expectedVersion: saved.reflection.version,
    status: "review_pending",
    leaseOwner: fence.leaseOwner,
    attemptVersion: fence.attemptVersion
  });
  repository.releaseExecutionLease({
    accountId: reflection.accountId,
    reflectionId: reflection.id,
    leaseOwner: fence.leaseOwner,
    attemptVersion: fence.attemptVersion
  });
  return {
    reflection,
    candidates: repository.listCandidates(reflection.accountId, reflection.id)
  };
}

function createCompletedCandidateSet() {
  const review = createReviewPendingCandidateSet();
  const decided = repository.updateCandidateDecisions({
    accountId: review.reflection.accountId,
    reflectionId: review.reflection.id,
    expectedVersion: review.reflection.version,
    candidates: [
      {
        candidateId: "candidate_1",
        status: "kept",
        userText: null,
        subjectPersonId: null
      },
      {
        candidateId: "candidate_2",
        status: "kept",
        userText: null,
        subjectPersonId: null
      }
    ]
  });
  repository.finalizeReview({
    accountId: review.reflection.accountId,
    reflectionId: review.reflection.id,
    expectedVersion: decided.reflection.version,
    idempotencyKey: "finalize_for_revocation"
  });
  const claim = repository.startAdmissionOperation({
    accountId: review.reflection.accountId,
    reflectionId: review.reflection.id,
    leaseOwner: "admission_for_revocation",
    leaseDurationMs: 60_000,
    now: timestamp
  });
  if (!claim.executionFence) throw new Error("expected admission fence");
  repository.completeAdmissionOperation({
    accountId: review.reflection.accountId,
    reflectionId: review.reflection.id,
    leaseOwner: claim.executionFence.leaseOwner,
    attemptVersion: claim.executionFence.attemptVersion,
    results: [
      {
        candidateId: "candidate_1",
        status: "admitted",
        memoryId: "memory_candidate_1",
        reasonCode: null,
        errorCode: null,
        operationKey: "admission_candidate_1",
        updatedAt: timestamp
      },
      {
        candidateId: "candidate_2",
        status: "rejected",
        memoryId: null,
        reasonCode: "admission_rejected",
        errorCode: null,
        operationKey: "admission_candidate_2",
        updatedAt: timestamp
      }
    ],
    now: timestamp
  });
  return repository.getReflection(review.reflection.accountId, review.reflection.id);
}

function createReviewPendingV2(input: {
  id?: string;
  operationKey?: string;
  sourceOrigin?: "user_reflection" | "direct_conversation";
  candidates?: Array<{
    id: string;
    ordinal: number;
    candidateKind: "insight" | "open_question" | "decision" | "user_action";
    proposedText: string;
    evidenceIds: string[];
    confidence: number;
    caution: string;
    actionClaimed: boolean;
  }>;
} = {}) {
  const reflectionId = input.id ?? "reflection_v2";
  const operationKey = input.operationKey ?? "operation_v2";
  const uploadId = `upload_${reflectionId}`;
  const sourceOrigin = input.sourceOrigin ?? "user_reflection";
  const candidates = input.candidates ?? [{
    id: "candidate_v2",
    ordinal: 0,
    candidateKind: "insight" as const,
    proposedText: "今天最值得记住的是先澄清问题。",
    evidenceIds: ["segment_v2"],
    confidence: 0.82,
    caution: "这是用户复盘中的总结。",
    actionClaimed: false
  }];
  const created = repository.createReflectionV2({
    id: reflectionId,
    accountId: "account_1",
    uploadId,
    operationKey,
    inputAdapter: "file_picker",
    sourceOrigin,
    capturePurpose: "inspiration_capture",
    recordingDate: "2026-08-21",
    contentHash: "c".repeat(64)
  }).reflection;
  const extracting = transitionPath(created, ["uploading", "transcribing", "extracting"]);
  const fence = repository.claimExecutionLease({
    accountId: extracting.accountId,
    reflectionId: extracting.id,
    leaseOwner: `v2-candidate-builder-${reflectionId}`,
    leaseDurationMs: 60_000,
    allowedStatuses: ["extracting"]
  });
  if (!fence) throw new Error("expected V2 candidate builder lease");
  const sourceIds = [...new Set(candidates.flatMap((candidate) => candidate.evidenceIds))];
  if (sourceIds.length > 0) {
    repository.publishAssetUnderExecutionFence({
      accountId: extracting.accountId,
      reflectionId: extracting.id,
      leaseOwner: fence.leaseOwner,
      attemptVersion: fence.attemptVersion,
      assetKind: "segments",
      payload: sourceIds.map((sourceId, index) => ({
        id: sourceId,
        uploadId,
        startSeconds: index * 8,
        endSeconds: index * 8 + 8,
        text: `Canonical reflection evidence ${index + 1}.`,
        confidence: 0.98,
        sceneLabels: [],
        valueLabels: []
      }))
    });
  }
  const saved = repository.savePendingCandidatesV2({
    accountId: extracting.accountId,
    reflectionId: extracting.id,
    expectedVersion: extracting.version,
    leaseOwner: fence.leaseOwner,
    attemptVersion: fence.attemptVersion,
    candidates
  });
  const reflection = repository.transitionStatus({
    accountId: saved.reflection.accountId,
    reflectionId: saved.reflection.id,
    expectedVersion: saved.reflection.version,
    status: "review_pending",
    leaseOwner: fence.leaseOwner,
    attemptVersion: fence.attemptVersion
  });
  repository.releaseExecutionLease({
    accountId: reflection.accountId,
    reflectionId: reflection.id,
    leaseOwner: fence.leaseOwner,
    attemptVersion: fence.attemptVersion
  });
  return {
    reflection,
    operationKey,
    candidates: repository.listCandidates(reflection.accountId, reflection.id)
  };
}

function createReviewPendingCards(input: {
  id?: string;
  operationKey?: string;
  cardKind?: "insight" | "open_question" | "decision" | "user_action";
} = {}) {
  const reflectionId = input.id ?? "reflection_cards";
  const operationKey = input.operationKey ?? "operation_cards";
  let uploadId = `upload_${reflectionId}`;
  const cardKind = input.cardKind ?? "insight";
  const createdResult = repository.createReflectionV2({
    id: reflectionId,
    accountId: "account_1",
    uploadId: null,
    operationKey,
    inputAdapter: "file_picker",
    sourceOrigin: "user_reflection",
    capturePurpose: "inspiration_capture",
    recordingDate: "2026-08-21",
    contentHash: "d".repeat(64)
  });
  const created = createdResult.reflection;
  uploadId = createdResult.receipt?.uploadId ?? uploadId;
  const uploading = repository.transitionStatus({
    accountId: created.accountId,
    reflectionId: created.id,
    expectedVersion: created.version,
    status: "uploading"
  });
  const fence = repository.claimExecutionLease({
    accountId: uploading.accountId,
    reflectionId: uploading.id,
    leaseOwner: `card-builder-${reflectionId}`,
    leaseDurationMs: 60_000,
    allowedStatuses: ["uploading"]
  });
  if (!fence) throw new Error("expected Card pipeline lease");
  const bound = repository.bindUploadAndPlanV2({
    accountId: uploading.accountId,
    reflectionId: uploading.id,
    expectedVersion: repository.getReflection(uploading.accountId, uploading.id).version,
    uploadId,
    inputAdapter: "file_picker",
    processingProfile: "full_recording",
    effectiveDurationMs: 300_000,
    durationSource: "server_ffprobe",
    candidateLimit: 5,
    leaseOwner: fence.leaseOwner,
    attemptVersion: fence.attemptVersion
  });
  const transcribing = repository.transitionStatus({
    accountId: bound.reflection.accountId,
    reflectionId: bound.reflection.id,
    expectedVersion: bound.reflection.version,
    status: "transcribing",
    leaseOwner: fence.leaseOwner,
    attemptVersion: fence.attemptVersion
  });
  const extracting = repository.transitionStatus({
    accountId: transcribing.accountId,
    reflectionId: transcribing.id,
    expectedVersion: transcribing.version,
    status: "extracting",
    leaseOwner: fence.leaseOwner,
    attemptVersion: fence.attemptVersion
  });
  repository.publishAssetUnderExecutionFence({
    accountId: extracting.accountId,
    reflectionId: extracting.id,
    leaseOwner: fence.leaseOwner,
    attemptVersion: fence.attemptVersion,
    assetKind: "segments",
    payload: [
      { id: "segment_card_1", uploadId, startSeconds: 0, endSeconds: 8, text: "第一段原话。", confidence: 0.98, sceneLabels: [], valueLabels: [] },
      { id: "segment_card_2", uploadId, startSeconds: 8, endSeconds: 16, text: "第二段原话。", confidence: 0.98, sceneLabels: [], valueLabels: [] }
    ]
  });
  const saved = repository.saveCardPipelineV2({
    accountId: extracting.accountId,
    reflectionId: extracting.id,
    expectedVersion: extracting.version,
    leaseOwner: fence.leaseOwner,
    attemptVersion: fence.attemptVersion,
    candidates: [
      { id: `${reflectionId}_hidden_1`, ordinal: 0, candidateKind: cardKind, proposedText: "隐藏提取一", evidenceIds: ["segment_card_1"], confidence: 0.9, caution: "audit", actionClaimed: false },
      { id: `${reflectionId}_hidden_2`, ordinal: 1, candidateKind: "insight", proposedText: "隐藏提取二", evidenceIds: ["segment_card_2"], confidence: 0.8, caution: "audit", actionClaimed: false }
    ],
    cards: [
      {
        id: `${reflectionId}_card_primary`,
        cardKind,
        proposedTitle: "主要重点",
        proposedText: "用户看到的主要重点",
        sourceCandidateIds: [`${reflectionId}_hidden_1`],
        evidenceIds: ["segment_card_1"],
        clusterId: `${reflectionId}_cluster_1`,
        clusterTitle: "主题一",
        displayTier: "primary",
        rank: 0,
        confidence: 0.9,
        importance: 0.9,
        durability: 0.8,
        novelty: 0.7,
        epistemicStatus: "explicit_user_statement",
        riskFlags: [],
        actionClaimed: false,
        reviewStatus: "pending"
      },
      {
        id: `${reflectionId}_card_more`,
        cardKind: "insight",
        proposedTitle: "更多内容",
        proposedText: "用户可展开的更多内容",
        sourceCandidateIds: [`${reflectionId}_hidden_2`],
        evidenceIds: ["segment_card_2"],
        clusterId: `${reflectionId}_cluster_2`,
        clusterTitle: "主题二",
        displayTier: "more",
        rank: 1,
        confidence: 0.8,
        importance: 0.6,
        durability: 0.6,
        novelty: 0.5,
        epistemicStatus: "reported_event",
        riskFlags: [],
        actionClaimed: false,
        reviewStatus: "not_proposed"
      }
    ],
    audit: {
      modelName: "test-model",
      promptVersion: "test-prompt-v1",
      policy: { extractionInputTokenBudget: 100 },
      windowCount: 1,
      providerCallCount: 2,
      hiddenCandidateCount: 2,
      clusterCount: 2,
      cardCount: 2,
      inputTokenEstimate: 50,
      outputTokenBudget: 100
    }
  });
  const reflection = repository.transitionStatus({
    accountId: saved.reflection.accountId,
    reflectionId: saved.reflection.id,
    expectedVersion: saved.reflection.version,
    status: "review_pending",
    leaseOwner: fence.leaseOwner,
    attemptVersion: fence.attemptVersion
  });
  repository.releaseExecutionLease({
    accountId: reflection.accountId,
    reflectionId: reflection.id,
    leaseOwner: fence.leaseOwner,
    attemptVersion: fence.attemptVersion
  });
  return { reflection, operationKey };
}

describe("fenced upload failure recovery", () => {
  function staging() {
    const created = repository.createReflectionV2({
      accountId: "account_1", uploadId: null, operationKey: "safe-save", inputAdapter: "browser_recorder",
      sourceOrigin: "user_reflection", capturePurpose: "inspiration_capture", recordingDate: "2026-09-16", contentHash: "a".repeat(64)
    });
    const id = created.reflection.id;
    repository.transitionStatus({ accountId: "account_1", reflectionId: id, expectedVersion: created.reflection.version, status: "uploading" });
    const claim = (owner: string) => repository.claimExecutionLease({
      accountId: "account_1", reflectionId: id, leaseOwner: owner, leaseDurationMs: 60000,
      provisionalUploadId: created.receipt!.uploadId, uploadFingerprint: "a".repeat(64), allowedStatuses: ["uploading"], clearUploadFailure: true
    });
    const fence = claim("writer-1")!;
    return { id, claim, fence, identity: { accountId: "account_1", reflectionId: id } };
  }

  it("stores failure without a plan, atomically clears it on a new claim, and rejects the stale writer", () => {
    const { identity, id, claim, fence } = staging();
    const failure = { code: "daily_reflection_duration_probe_timeout" as const, retryable: true };
    expect(repository.recordUploadFailure({ ...identity, ...fence, failure })).toEqual({ uploadState: "reupload_allowed", uploadFailure: failure });
    expect(repository.getProcessingPlan("account_1", id)).toBeNull();
    expect(repository.getReflection("account_1", id).status).toBe("uploading");
    const next = claim("writer-2")!;
    expect(next.attemptVersion).toBe(fence.attemptVersion + 1);
    expect(repository.getUploadRecovery("account_1", id)).toEqual({ uploadState: "still_persisting", uploadFailure: null });
    expect(() => repository.recordUploadFailure({ ...identity, ...fence, failure })).toThrow(DailyReflectionLeaseLostError);
    expect(claim("loser")).toBeNull();
    expect(repository.getReflection("account_1", id).errorCode).toBeNull();
    expect(() => repository.recordUploadFailure({ ...identity, ...next, accountId: "other-account", failure })).toThrow();
    expect(repository.getOperationLookupV2("other-account", "safe-save")).toEqual({ found: false });
  });

  it("projects an expired lease from durable state without permitting its writer to overwrite a takeover", () => {
    let clock = timestamp;
    repository = new DailyReflectionRepository(database, { now: () => clock });
    const { identity, id, claim, fence } = staging();
    clock = "2026-08-13T00:02:00.000Z";
    expect(repository.getUploadRecovery("account_1", id)).toEqual({ uploadState: "reupload_allowed", uploadFailure: {
      code: "daily_reflection_upload_lease_lost", retryable: true
    } });
    expect(() => repository.recordUploadFailure({ ...identity, ...fence, failure: { code: "daily_reflection_upload_persist_failed", retryable: true } }))
      .toThrow(DailyReflectionLeaseLostError);
    const next = claim("writer-2")!;
    expect(next.attemptVersion).toBe(2);
    expect(repository.getUploadRecovery("account_1", id)).toEqual({ uploadState: "still_persisting", uploadFailure: null });
  });

  it("hides prior failures on terminal records and never accepts a forged retry classification", () => {
    const { identity, id, fence } = staging();
    expect(() => repository.recordUploadFailure({ ...identity, ...fence, failure: { code: "daily_reflection_audio_invalid", retryable: true } })).toThrow();
    repository.recordUploadFailure({ ...identity, ...fence, failure: { code: "daily_reflection_upload_persist_failed", retryable: true } });
    const current = repository.getReflection("account_1", id);
    repository.transitionStatus({ ...identity, expectedVersion: current.version, status: "cancelled" });
    expect(repository.getUploadRecovery("account_1", id)).toEqual({ uploadState: "terminated", uploadFailure: null });
  });
});

describe("DailyReflectionRepository", () => {
  it("persists idempotent V2 input without merging accounts or operation payloads", () => {
    const input = {
      id: "reflection_v2_create",
      accountId: "account_1",
      uploadId: "upload_v2_create",
      operationKey: "operation_v2_create",
      inputAdapter: "file_picker" as const,
      sourceOrigin: "user_reflection" as const,
      capturePurpose: "inspiration_capture" as const,
      recordingDate: "2026-08-21"
    };
    const first = repository.createReflectionV2(input);
    expect(first).toMatchObject({ reused: false, input: {
      operationKey: input.operationKey,
      recordingDate: input.recordingDate
    } });
    expect(repository.createReflectionV2(input)).toMatchObject({ reused: true });
    expect(() => repository.createReflectionV2({
      ...input,
      recordingDate: "2026-08-20"
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_idempotency_conflict"
    }));
    expect(repository.createReflectionV2({
      ...input,
      id: "reflection_v2_create_other",
      accountId: "account_2",
      uploadId: "upload_v2_create_other"
    })).toMatchObject({
      reused: false,
      reflection: { accountId: "account_2", id: "reflection_v2_create_other" }
    });
    expect(() => repository.getReflectionV2Input("account_2", first.reflection.id))
      .toThrow(DailyReflectionNotFoundError);
  });

  it("persists Cards separately and hides Hidden Candidates from the default detail", () => {
    const review = createReviewPendingCards();
    const detail = repository.getReflectionDetail("account_1", review.reflection.id);
    expect(detail.cards.map((card) => ({
      id: card.id,
      tier: card.displayTier,
      status: card.reviewStatus
    }))).toEqual([
      { id: "reflection_cards_card_primary", tier: "primary", status: "pending" },
      { id: "reflection_cards_card_more", tier: "more", status: "not_proposed" }
    ]);
    expect(detail.candidates.map((candidate) => candidate.id)).toEqual([
      "reflection_cards_card_primary",
      "reflection_cards_card_more"
    ]);
    expect(database.prepare(`
      SELECT candidate_role, COUNT(*) AS count
      FROM dr_candidate_v2_roles
      GROUP BY candidate_role
      ORDER BY candidate_role
    `).all()).toEqual([
      { candidate_role: "card_projection", count: 2 },
      { candidate_role: "hidden_extraction", count: 2 }
    ]);
  });

  it("allows a user to promote a More Card into the Primary review set", () => {
    const review = createReviewPendingCards({
      id: "reflection_card_promotion",
      operationKey: "operation_card_promotion"
    });

    const updated = repository.updateReflectionCards({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      cards: [{
        cardId: "reflection_card_promotion_card_more",
        reviewStatus: "pending",
        userTitle: null,
        userText: null,
        promoteToPrimary: true
      }]
    });

    expect(updated.cards.find((card) => card.id.endsWith("card_more"))).toMatchObject({
      displayTier: "primary",
      reviewStatus: "pending"
    });
  });

  it("keeps Working Card save independent from review and Memory admission", () => {
    const review = createReviewPendingCards({
      id: "reflection_working_save",
      operationKey: "operation_working_save",
      cardKind: "open_question"
    });
    const primaryId = "reflection_working_save_card_primary";
    const moreId = "reflection_working_save_card_more";

    expect(repository.listWorkingCards({ accountId: "account_1" })).toMatchObject({
      cards: [],
      total: 0
    });
    expect(repository.listWorkingCards({
      accountId: "account_1",
      reflectionId: review.reflection.id
    }).cards.map((card) => [card.id, card.status])).toEqual([
      [moreId, "generated"],
      [primaryId, "review_pending"]
    ]);

    const saved = repository.saveWorkingCardFromReflection({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      cardId: primaryId,
      expectedVersion: 0
    });
    expect(saved).toMatchObject({
      id: primaryId,
      cardKind: "question",
      status: "saved",
      evidenceIds: ["segment_card_1"],
      sourceReflectionIds: [review.reflection.id],
      sourceUnavailable: false,
      version: 1
    });
    expect(repository.getWorkingCardWithEvidence("account_1", primaryId).evidence)
      .toEqual([expect.objectContaining({
        sourceSegmentId: "segment_card_1",
        text: "第一段原话。"
      })]);
    expect(repository.listWorkingCards({ accountId: "account_1" }).cards)
      .toHaveLength(1);
    expect(repository.getAdmissionOperation("account_1", review.reflection.id)).toBeNull();
    expect((database.prepare("SELECT count(*) AS count FROM dr_reflection_confirmations").get() as { count: number }).count)
      .toBe(0);
    expect((database.prepare("SELECT count(*) AS count FROM dr_working_card_events").get() as { count: number }).count)
      .toBe(1);

    expect(() => repository.getWorkingCard("account_2", primaryId))
      .toThrow(DailyReflectionNotFoundError);
    expect(() => repository.saveWorkingCardFromReflection({
      accountId: "account_2",
      reflectionId: review.reflection.id,
      cardId: primaryId,
      expectedVersion: 0
    })).toThrow(DailyReflectionNotFoundError);
  });

  it("supports account-scoped metadata retrieval and recoverable lifecycle changes", () => {
    const first = createReviewPendingCards({
      id: "reflection_library_first",
      operationKey: "operation_library_first"
    });
    const second = createReviewPendingCards({
      id: "reflection_library_second",
      operationKey: "operation_library_second",
      cardKind: "decision"
    });
    const firstId = "reflection_library_first_card_primary";
    const secondId = "reflection_library_second_card_primary";
    const firstSaved = repository.saveWorkingCardFromReflection({
      accountId: "account_1",
      reflectionId: first.reflection.id,
      cardId: firstId,
      expectedVersion: 0
    });
    const secondSaved = repository.saveWorkingCardFromReflection({
      accountId: "account_1",
      reflectionId: second.reflection.id,
      cardId: secondId,
      expectedVersion: 0
    });
    const updated = repository.updateWorkingCard({
      accountId: "account_1",
      cardId: firstId,
      expectedVersion: firstSaved.version,
      title: "30% 的复盘洞察",
      content: "用 literal % keyword 检索这张卡。",
      cardKind: "idea",
      relatedCardIds: [secondId],
      tags: ["复盘", "重点"]
    });
    expect(updated).toMatchObject({
      title: "30% 的复盘洞察",
      cardKind: "idea",
      relatedCardIds: [secondId],
      tags: ["复盘", "重点"]
    });
    expect(repository.listWorkingCards({
      accountId: "account_1",
      query: "%",
      cardKind: "idea"
    }).cards.map((card) => card.id)).toEqual([firstId]);
    expect(repository.listWorkingCards({
      accountId: "account_1",
      reflectionId: second.reflection.id,
      status: "saved"
    }).cards.map((card) => card.id)).toEqual([secondId]);
    expect(repository.listWorkingCards({
      accountId: "account_1",
      createdFrom: "2026-08-12T00:00:00.000Z",
      createdTo: "2026-08-14T00:00:00.000Z",
      sort: "title_asc",
      limit: 1,
      offset: 1
    })).toMatchObject({ total: 2, limit: 1, offset: 1 });

    const archived = repository.archiveWorkingCard({
      accountId: "account_1",
      cardId: firstId,
      expectedVersion: updated.version
    });
    expect(archived.status).toBe("archived");
    expect(repository.archiveWorkingCard({
      accountId: "account_1",
      cardId: firstId,
      expectedVersion: updated.version
    })).toEqual(archived);
    const restored = repository.restoreWorkingCard({
      accountId: "account_1",
      cardId: firstId,
      expectedVersion: archived.version
    });
    expect(restored.status).toBe("saved");
    const removed = repository.removeWorkingCard({
      accountId: "account_1",
      cardId: firstId,
      expectedVersion: restored.version
    });
    expect(removed.status).toBe("removed");
    expect(repository.listWorkingCards({ accountId: "account_1" }).cards.map((card) => card.id))
      .toEqual([secondId]);
    expect(repository.restoreWorkingCard({
      accountId: "account_1",
      cardId: firstId,
      expectedVersion: removed.version
    }).status).toBe("saved");
    for (const operation of [
      () => repository.updateWorkingCard({
        accountId: "account_2", cardId: secondId,
        expectedVersion: secondSaved.version, title: "越权"
      }),
      () => repository.archiveWorkingCard({
        accountId: "account_2", cardId: secondId,
        expectedVersion: secondSaved.version
      }),
      () => repository.restoreWorkingCard({
        accountId: "account_2", cardId: secondId,
        expectedVersion: secondSaved.version
      }),
      () => repository.removeWorkingCard({
        accountId: "account_2", cardId: secondId,
        expectedVersion: secondSaved.version
      })
    ]) {
      expect(operation).toThrow(DailyReflectionNotFoundError);
    }
    expect((database.prepare("SELECT count(*) AS count FROM dr_admission_operations").get() as { count: number }).count)
      .toBe(0);
    expect((database.prepare("SELECT count(*) AS count FROM dr_reflection_confirmations").get() as { count: number }).count)
      .toBe(0);
  });

  it("does not let delayed save revive a removed or excluded Working Card", () => {
    const review = createReviewPendingCards({
      id: "reflection_working_delayed_save",
      operationKey: "operation_working_delayed_save"
    });
    const savedId = "reflection_working_delayed_save_card_primary";
    const excludedId = "reflection_working_delayed_save_card_more";
    const saved = repository.saveWorkingCardFromReflection({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      cardId: savedId,
      expectedVersion: 0
    });
    const removed = repository.removeWorkingCard({
      accountId: "account_1",
      cardId: savedId,
      expectedVersion: saved.version
    });
    expect(() => repository.saveWorkingCardFromReflection({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      cardId: savedId,
      expectedVersion: 0
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_working_card_restore_required"
    }));
    expect(repository.getWorkingCard("account_1", savedId)).toMatchObject({
      status: "removed",
      version: removed.version
    });

    const updated = repository.updateReflectionCards({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      cards: [{
        cardId: excludedId,
        reviewStatus: "excluded",
        userTitle: null,
        userText: null
      }]
    });
    const excluded = updated.cards.find((card) => card.id === excludedId)!;
    expect(() => repository.saveWorkingCardFromReflection({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      cardId: excludedId,
      expectedVersion: excluded.version
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_working_card_restore_required"
    }));
    expect(repository.getWorkingCard("account_1", excludedId).status).toBe("removed");
  });

  it("does not let Reflection review edits overwrite a saved Working Card", () => {
    const review = createReviewPendingCards({
      id: "reflection_working_edit_isolation",
      operationKey: "operation_working_edit_isolation"
    });
    const cardId = "reflection_working_edit_isolation_card_primary";
    const saved = repository.saveWorkingCardFromReflection({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      cardId,
      expectedVersion: 0
    });
    const libraryEdit = repository.updateWorkingCard({
      accountId: "account_1",
      cardId,
      expectedVersion: saved.version,
      title: "My Cards 独立标题",
      content: "My Cards 独立内容"
    });

    const reflectionEdit = repository.updateReflectionCards({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      cards: [{
        cardId,
        reviewStatus: "pending",
        userTitle: "复盘页标题",
        userText: "复盘页内容"
      }]
    });

    expect(reflectionEdit.cards.find((card) => card.id === cardId)).toMatchObject({
      userTitle: "复盘页标题",
      userText: "复盘页内容"
    });
    expect(repository.getWorkingCard("account_1", cardId)).toMatchObject({
      title: libraryEdit.title,
      content: libraryEdit.content,
      version: libraryEdit.version
    });
    expect(repository.getAdmissionOperation("account_1", review.reflection.id)).toBeNull();
  });

  it("supports Stage 6 Card content through the 20,000 character boundary", () => {
    const review = createReviewPendingCards({
      id: "reflection_working_long_content",
      operationKey: "operation_working_long_content"
    });
    const cardId = "reflection_working_long_content_card_primary";
    const longContent = "长".repeat(5_000);
    database.prepare(`
      UPDATE dr_reflection_cards SET proposed_text = ? WHERE account_id = ? AND id = ?
    `).run(longContent, "account_1", cardId);
    database.prepare(`
      UPDATE dr_working_cards SET content = ? WHERE account_id = ? AND id = ?
    `).run(longContent, "account_1", cardId);

    const saved = repository.saveWorkingCardFromReflection({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      cardId,
      expectedVersion: 0
    });
    expect(saved.content).toHaveLength(5_000);
    const updated = repository.updateWorkingCard({
      accountId: "account_1",
      cardId,
      expectedVersion: saved.version,
      content: "界".repeat(20_000)
    });
    expect(updated.content).toHaveLength(20_000);
    expect(() => repository.updateWorkingCard({
      accountId: "account_1",
      cardId,
      expectedVersion: updated.version,
      content: "界".repeat(20_001)
    })).toThrow();
  });

  it("rejects save when Canonical Evidence is unavailable", () => {
    const review = createReviewPendingCards({
      id: "reflection_invalid_working_evidence",
      operationKey: "operation_invalid_working_evidence"
    });
    repository.deletePublishedAsset(
      "account_1",
      review.reflection.id,
      "segments"
    );
    expect(() => repository.saveWorkingCardFromReflection({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      cardId: "reflection_invalid_working_evidence_card_primary",
      expectedVersion: 0
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_working_card_evidence_unavailable"
    }));
  });

  it("persists source-unavailable state when Canonical segments are invalidated", () => {
    const review = createReviewPendingCards({
      id: "reflection_working_source_invalidation",
      operationKey: "operation_working_source_invalidation"
    });
    const cardId = "reflection_working_source_invalidation_card_primary";
    const saved = repository.saveWorkingCardFromReflection({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      cardId,
      expectedVersion: 0
    });
    repository.deletePublishedAsset("account_1", review.reflection.id, "segments");

    expect(repository.listWorkingCards({ accountId: "account_1" }).cards)
      .toEqual([expect.objectContaining({
        id: cardId,
        sourceUnavailable: true,
        version: saved.version + 1
      })]);
    expect(repository.getWorkingCardWithEvidence("account_1", cardId)).toMatchObject({
      card: { id: cardId, sourceUnavailable: true },
      evidence: []
    });
    expect(database.prepare(`
      SELECT event_type, count(*) AS count
      FROM dr_working_card_events
      WHERE account_id = ? AND card_id = ?
      GROUP BY event_type
      ORDER BY event_type
    `).all("account_1", cardId)).toEqual([
      { event_type: "saved", count: 1 },
      { event_type: "source_unavailable", count: 1 }
    ]);
  });

  it("can fail closed on missing Working Card Evidence without mutating Card state", () => {
    const review = createReviewPendingCards({
      id: "reflection_working_readonly_evidence",
      operationKey: "operation_working_readonly_evidence"
    });
    const cardId = "reflection_working_readonly_evidence_card_primary";
    const saved = repository.saveWorkingCardFromReflection({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      cardId,
      expectedVersion: 0
    });
    database.prepare(`
      DELETE FROM dr_asset_publications
      WHERE account_id = ? AND reflection_id = ? AND asset_kind = 'segments'
    `).run("account_1", review.reflection.id);

    expect(repository.readWorkingCardWithEvidence("account_1", cardId)).toMatchObject({
      card: {
        id: cardId,
        sourceUnavailable: false,
        version: saved.version
      },
      evidence: []
    });
    expect(repository.getWorkingCard("account_1", cardId)).toMatchObject({
      sourceUnavailable: false,
      version: saved.version
    });
    expect(database.prepare(`
      SELECT event_type, count(*) AS count
      FROM dr_working_card_events
      WHERE account_id = ? AND card_id = ?
      GROUP BY event_type
      ORDER BY event_type
    `).all("account_1", cardId)).toEqual([
      { event_type: "saved", count: 1 }
    ]);
  });

  it("deletes unsaved Cards but preserves saved provenance as source-unavailable", () => {
    const review = createReviewPendingCards({
      id: "reflection_working_delete",
      operationKey: "operation_working_delete"
    });
    const savedId = "reflection_working_delete_card_primary";
    const unsavedId = "reflection_working_delete_card_more";
    repository.saveWorkingCardFromReflection({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      cardId: savedId,
      expectedVersion: 0
    });

    repository.transitionStatus({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      status: "deleted"
    });
    expect(() => repository.saveWorkingCardFromReflection({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      cardId: unsavedId,
      expectedVersion: 0
    })).toThrowError(expect.objectContaining({ code: "daily_reflection_tombstoned" }));
    repository.deletePublishedAssets("account_1", review.reflection.id);
    repository.deleteCandidates("account_1", review.reflection.id);

    expect(() => repository.getWorkingCard("account_1", unsavedId))
      .toThrow(DailyReflectionNotFoundError);
    const preserved = repository.getWorkingCardWithEvidence("account_1", savedId);
    expect(preserved).toMatchObject({
      card: {
        id: savedId,
        status: "saved",
        sourceReflectionIds: [review.reflection.id],
        evidenceIds: ["segment_card_1"],
        sourceUnavailable: true
      },
      evidence: []
    });
    expect(repository.listWorkingCards({ accountId: "account_1" }).cards.map((card) => card.id))
      .toEqual([savedId]);
    expect(repository.getAdmissionOperation("account_1", review.reflection.id)).toBeNull();
    expect((database.prepare("SELECT count(*) AS count FROM dr_candidate_admission_receipts").get() as { count: number }).count)
      .toBe(0);
  });

  it("applies the saved and unsaved Card split to cancellation tombstones", () => {
    const review = createReviewPendingCards({
      id: "reflection_working_cancel",
      operationKey: "operation_working_cancel"
    });
    const savedId = "reflection_working_cancel_card_primary";
    const unsavedId = "reflection_working_cancel_card_more";
    const saved = repository.saveWorkingCardFromReflection({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      cardId: savedId,
      expectedVersion: 0
    });

    repository.transitionStatus({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      status: "cancelled"
    });
    expect(() => repository.getWorkingCard("account_1", unsavedId))
      .toThrow(DailyReflectionNotFoundError);
    expect(repository.getWorkingCard("account_1", savedId)).toMatchObject({
      status: "saved",
      sourceUnavailable: true,
      version: saved.version + 1
    });
    expect(repository.listSavedWorkingCardStatesForReflection(
      "account_1",
      review.reflection.id
    )).toEqual([{
      id: savedId,
      status: "saved",
      memoryLifecycleStatus: "not_admitted",
      version: saved.version + 1
    }]);
    expect(() => repository.saveWorkingCardFromReflection({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      cardId: unsavedId,
      expectedVersion: 0
    })).toThrowError(expect.objectContaining({ code: "daily_reflection_tombstoned" }));
    repository.deletePublishedAssets("account_1", review.reflection.id);
    expect((database.prepare(`
      SELECT count(*) AS count
      FROM dr_working_card_events
      WHERE account_id = ? AND card_id = ? AND event_type = 'source_unavailable'
    `).get("account_1", savedId) as { count: number }).count).toBe(1);
    expect(repository.getAdmissionOperation("account_1", review.reflection.id)).toBeNull();
  });

  it("allows only an explicit user update to claim an evidenced user_action Card", () => {
    const review = createReviewPendingCards({
      id: "reflection_action_card",
      operationKey: "operation_action_card",
      cardKind: "user_action"
    });
    expect(() => repository.updateReflectionCards({
      accountId: "account_2",
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      cards: [{
        cardId: "reflection_action_card_card_primary",
        reviewStatus: "kept",
        userTitle: null,
        userText: null,
        actionClaimed: true
      }]
    })).toThrow(DailyReflectionNotFoundError);
    const updated = repository.updateReflectionCards({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      cards: [{
        cardId: "reflection_action_card_card_primary",
        reviewStatus: "kept",
        userTitle: "我确认的行动",
        userText: null,
        actionClaimed: true
      }]
    });
    expect(updated.cards[0]).toMatchObject({
      cardKind: "user_action",
      actionClaimed: true,
      reviewStatus: "kept",
      userTitle: "我确认的行动"
    });
    expect(repository.getReflectionDetail("account_1", review.reflection.id).candidates)
      .toContainEqual(expect.objectContaining({
        id: "reflection_action_card_card_primary",
        candidateKind: "user_action",
        candidateType: "commitment",
        actionClaimed: true
      }));
    expect(() => repository.updateReflectionCards({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      expectedVersion: updated.reflection.version,
      cards: [{
        cardId: "reflection_action_card_card_more",
        reviewStatus: "kept",
        userTitle: null,
        userText: null,
        actionClaimed: true
      }]
    })).toThrowError(expect.objectContaining({ code: "daily_reflection_action_claim_invalid" }));
  });

  it("finalizes only kept Cards and never admits Hidden or untouched More results", () => {
    const review = createReviewPendingCards({
      id: "reflection_card_finalize",
      operationKey: "operation_card_finalize"
    });
    const updated = repository.updateReflectionCards({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      cards: [{
        cardId: "reflection_card_finalize_card_primary",
        reviewStatus: "kept",
        userTitle: null,
        userText: "用户确认后的重点"
      }]
    });
    const finalized = repository.finalizeReviewV2({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      expectedVersion: updated.reflection.version,
      operationKey: review.operationKey,
      saveIntent: "retain_selected"
    });
    expect(finalized.confirmation.candidateSnapshots).toHaveLength(1);
    expect(finalized.confirmation.candidateSnapshots[0]).toMatchObject({
      candidateId: "reflection_card_finalize_card_primary",
      finalText: "用户确认后的重点",
      status: "kept"
    });
    expect(finalized.confirmation.candidateSnapshots.some((snapshot) =>
      snapshot.candidateId.includes("hidden") || snapshot.candidateId.endsWith("card_more")
    )).toBe(false);
    expect(repository.getAdmissionExecutionMethod(
      "account_1",
      review.reflection.id
    )).toBe("memory_proposal_v1");
    expect(repository.getWorkingCard(
      "account_1",
      "reflection_card_finalize_card_primary"
    )).toMatchObject({
      status: "saved",
      content: "用户确认后的重点",
      memoryLifecycleStatus: "not_admitted"
    });
    const savedEventCount = database.prepare(`
      SELECT COUNT(*) AS count
      FROM dr_working_card_events
      WHERE account_id = 'account_1'
        AND card_id = 'reflection_card_finalize_card_primary'
        AND event_type = 'saved'
    `).get();
    expect(savedEventCount).toEqual({ count: 1 });
    expect(repository.finalizeReviewV2({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      expectedVersion: updated.reflection.version,
      operationKey: review.operationKey,
      saveIntent: "retain_selected"
    }).reused).toBe(true);
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM dr_working_card_events
      WHERE account_id = 'account_1'
        AND card_id = 'reflection_card_finalize_card_primary'
        AND event_type = 'saved'
    `).get()).toEqual({ count: 1 });
  });

  it("counts Proposal-backed memory only while the Working Card lifecycle is active", () => {
    const review = createReviewPendingCards({
      id: "reflection_card_memory_count",
      operationKey: "operation_card_memory_count"
    });
    const updated = repository.updateReflectionCards({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      cards: [{
        cardId: "reflection_card_memory_count_card_primary",
        reviewStatus: "kept",
        userTitle: null,
        userText: null
      }]
    });
    repository.finalizeReviewV2({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      expectedVersion: updated.reflection.version,
      operationKey: review.operationKey,
      saveIntent: "retain_selected"
    });
    const claim = repository.startAdmissionOperation({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      leaseOwner: "proposal-memory-count-worker",
      leaseDurationMs: 60_000,
      now: timestamp
    });
    if (!claim.executionFence) throw new Error("expected admission fence");
    database.prepare(`
      UPDATE dr_working_cards
      SET memory_lifecycle_status = 'active'
      WHERE account_id = ? AND id = ?
    `).run("account_1", "reflection_card_memory_count_card_primary");
    repository.completeAdmissionOperation({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      leaseOwner: claim.executionFence.leaseOwner,
      attemptVersion: claim.executionFence.attemptVersion,
      results: [{
        candidateId: "reflection_card_memory_count_card_primary",
        status: "admitted",
        memoryId: "memory-card-count",
        reasonCode: null,
        errorCode: null,
        operationKey: "daily-reflection-card:reflection_card_memory_count_card_primary",
        updatedAt: timestamp
      }],
      now: timestamp
    });

    expect(repository.getRememberedCandidateCount(
      "account_1",
      review.reflection.id
    )).toBe(1);
    database.prepare(`
      UPDATE dr_working_cards
      SET memory_lifecycle_status = 'revoked'
      WHERE account_id = ? AND id = ?
    `).run("account_1", "reflection_card_memory_count_card_primary");
    expect(repository.getRememberedCandidateCount(
      "account_1",
      review.reflection.id
    )).toBe(0);
  });

  it("stops counting a historical legacy-direct Card after Card lifecycle revocation", () => {
    const review = createReviewPendingCards({
      id: "reflection_legacy_card_memory_count",
      operationKey: "operation_legacy_card_memory_count"
    });
    const cardId = "reflection_legacy_card_memory_count_card_primary";
    const updated = repository.updateReflectionCards({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      cards: [{
        cardId,
        reviewStatus: "kept",
        userTitle: null,
        userText: null
      }]
    });
    repository.finalizeReviewV2({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      expectedVersion: updated.reflection.version,
      operationKey: review.operationKey,
      saveIntent: "retain_selected"
    });
    database.prepare(`
      UPDATE dr_admission_operations
      SET execution_method = 'legacy_direct_v1'
      WHERE account_id = ? AND reflection_id = ?
    `).run("account_1", review.reflection.id);
    const claim = repository.startAdmissionOperation({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      leaseOwner: "legacy-card-count-worker",
      leaseDurationMs: 60_000,
      now: timestamp
    });
    if (!claim.executionFence) throw new Error("expected admission fence");
    database.prepare(`
      UPDATE dr_working_cards
      SET memory_lifecycle_status = 'active'
      WHERE account_id = ? AND id = ?
    `).run("account_1", cardId);
    repository.completeAdmissionOperation({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      leaseOwner: claim.executionFence.leaseOwner,
      attemptVersion: claim.executionFence.attemptVersion,
      results: [{
        candidateId: cardId,
        status: "admitted",
        memoryId: "legacy-card-memory",
        reasonCode: null,
        errorCode: null,
        operationKey: `legacy-card:${cardId}`,
        updatedAt: timestamp
      }],
      now: timestamp
    });

    expect(repository.getRememberedCandidateCount(
      "account_1",
      review.reflection.id
    )).toBe(1);
    database.prepare(`
      UPDATE dr_working_cards
      SET memory_lifecycle_status = 'revoked'
      WHERE account_id = ? AND id = ?
    `).run("account_1", cardId);
    expect(repository.getRememberedCandidateCount(
      "account_1",
      review.reflection.id
    )).toBe(0);
  });

  it("rejects Card edits after a V2 confirmation snapshot is frozen", () => {
    const review = createReviewPendingCards({
      id: "reflection_card_frozen_update",
      operationKey: "operation_card_frozen_update"
    });
    const updated = repository.updateReflectionCards({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      cards: [{
        cardId: "reflection_card_frozen_update_card_primary",
        reviewStatus: "kept",
        userTitle: null,
        userText: null
      }]
    });
    repository.finalizeReviewV2({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      expectedVersion: updated.reflection.version,
      operationKey: review.operationKey,
      saveIntent: "retain_selected"
    });
    const frozen = repository.getReflection("account_1", review.reflection.id);

    expect(() => repository.updateReflectionCards({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      expectedVersion: frozen.version,
      cards: [{
        cardId: "reflection_card_frozen_update_card_primary",
        reviewStatus: "kept",
        userTitle: "确认后不允许改写",
        userText: null
      }]
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_card_update_conflict"
    }));
  });

  it("recap_only completes with unreviewed Primary and More Cards and creates zero admission", () => {
    const review = createReviewPendingCards({
      id: "reflection_card_recap",
      operationKey: "operation_card_recap"
    });
    const finalized = repository.finalizeReviewV2({
      accountId: "account_1",
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      operationKey: review.operationKey,
      saveIntent: "recap_only"
    });
    expect(finalized.operation).toBeNull();
    expect(finalized.confirmation.candidateSnapshots).toHaveLength(2);
    expect(finalized.confirmation.candidateSnapshots.every((snapshot) =>
      snapshot.status === "excluded"
    )).toBe(true);
    expect(repository.getAdmissionOperation("account_1", review.reflection.id)).toBeNull();
  });

  it("completes an Evidence-free V2 recap with no admission operation or Person association", () => {
    const review = createReviewPendingV2({
      candidates: [{
        id: "candidate_v2_recap",
        ordinal: 0,
        candidateKind: "insight",
        proposedText: "这是只保留在复盘里的手写领悟。",
        evidenceIds: [],
        confidence: 0.7,
        caution: "没有 canonical Evidence，不能进入长期 Memory。",
        actionClaimed: false
      }]
    });
    expect(() => repository.updateCandidateDecisions({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      candidates: [{
        candidateId: "candidate_v2_recap",
        status: "kept",
        userText: null,
        subjectPersonId: "person_alice"
      }]
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_v2_subject_not_supported"
    }));
    const decided = repository.updateCandidateDecisions({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      candidates: [{
        candidateId: "candidate_v2_recap",
        status: "kept",
        userText: "这是用户确认后的复盘文本。",
        subjectPersonId: null
      }]
    });
    const finalized = repository.finalizeReviewV2({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: decided.reflection.version,
      operationKey: review.operationKey,
      saveIntent: "recap_only"
    });
    expect(finalized).toMatchObject({
      reused: false,
      operation: null,
      confirmation: {
        contractVersion: 2,
        operationKey: review.operationKey,
        saveIntent: "recap_only",
        candidateSnapshots: [{
          candidateId: "candidate_v2_recap",
          evidenceIds: [],
          subjectPersonId: null
        }]
      }
    });
    expect(repository.getReflection("account_1", review.reflection.id).status).toBe("completed");
    expect(repository.getAdmissionOperation("account_1", review.reflection.id)).toBeNull();
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM dr_candidate_admission_receipts"
    ).get()).toEqual({ count: 0 });
    expect(repository.finalizeReviewV2({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: decided.reflection.version,
      operationKey: review.operationKey,
      saveIntent: "recap_only"
    })).toEqual({ ...finalized, reused: true });
    expect(() => repository.finalizeReviewV2({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: decided.reflection.version,
      operationKey: review.operationKey,
      saveIntent: "retain_selected"
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_finalize_idempotency_conflict"
    }));
    expect(() => repository.finalizeReviewV2({
      accountId: "account_2",
      reflectionId: review.reflection.id,
      expectedVersion: decided.reflection.version,
      operationKey: review.operationKey,
      saveIntent: "recap_only"
    })).toThrow(DailyReflectionNotFoundError);
  });

  it("freezes kept V2 Evidence and maps only claimed actions to commitments", () => {
    const review = createReviewPendingV2({
      candidates: [
        {
          id: "candidate_v2_insight",
          ordinal: 0,
          candidateKind: "insight",
          proposedText: "Insight",
          evidenceIds: ["segment_v2_insight"],
          confidence: 0.8,
          caution: "Reflection summary.",
          actionClaimed: false
        },
        {
          id: "candidate_v2_question",
          ordinal: 1,
          candidateKind: "open_question",
          proposedText: "Question",
          evidenceIds: ["segment_v2_question"],
          confidence: 0.75,
          caution: "Open question.",
          actionClaimed: false
        },
        {
          id: "candidate_v2_action",
          ordinal: 2,
          candidateKind: "user_action",
          proposedText: "Action",
          evidenceIds: ["segment_v2_action"],
          confidence: 0.9,
          caution: "Explicit user action.",
          actionClaimed: true
        }
      ]
    });
    const decided = repository.updateCandidateDecisions({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      candidates: review.candidates.map((candidate) => ({
        candidateId: candidate.id,
        status: "kept" as const,
        userText: null,
        subjectPersonId: null
      }))
    });
    const finalized = repository.finalizeReviewV2({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: decided.reflection.version,
      operationKey: review.operationKey,
      saveIntent: "retain_selected"
    });
    expect(finalized.operation).toMatchObject({ status: "confirmation_ready" });
    expect(repository.getAdmissionExecutionMethod(
      review.reflection.accountId,
      review.reflection.id
    )).toBe("legacy_direct_v1");
    expect(finalized.confirmation.candidateSnapshots.map((candidate) => ({
      kind: candidate.candidateKind,
      type: candidate.candidateType,
      evidenceCount: candidate.evidenceSnapshots.length
    }))).toEqual([
      { kind: "insight", type: "summary", evidenceCount: 1 },
      { kind: "open_question", type: "question", evidenceCount: 1 },
      { kind: "user_action", type: "commitment", evidenceCount: 1 }
    ]);
  });

  it("fails closed for Evidence-free V2 retention and admits sourced direct conversation", () => {
    const evidenceFree = createReviewPendingV2({
      id: "reflection_v2_no_evidence",
      operationKey: "operation_v2_no_evidence",
      candidates: [{
        id: "candidate_v2_no_evidence",
        ordinal: 0,
        candidateKind: "decision",
        proposedText: "No Evidence decision",
        evidenceIds: [],
        confidence: 0.6,
        caution: "No Evidence.",
        actionClaimed: false
      }]
    });
    const evidenceFreeDecided = repository.updateCandidateDecisions({
      accountId: evidenceFree.reflection.accountId,
      reflectionId: evidenceFree.reflection.id,
      expectedVersion: evidenceFree.reflection.version,
      candidates: [{
        candidateId: "candidate_v2_no_evidence",
        status: "kept",
        userText: null,
        subjectPersonId: null
      }]
    });
    expect(() => repository.finalizeReviewV2({
      accountId: "account_1",
      reflectionId: evidenceFree.reflection.id,
      expectedVersion: evidenceFreeDecided.reflection.version,
      operationKey: evidenceFree.operationKey,
      saveIntent: "retain_selected"
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_retain_requires_evidence"
    }));
    expect(repository.getConfirmation("account_1", evidenceFree.reflection.id)).toBeNull();

    const direct = createReviewPendingV2({
      id: "reflection_v2_direct",
      operationKey: "operation_v2_direct",
      sourceOrigin: "direct_conversation"
    });
    const directDecided = repository.updateCandidateDecisions({
      accountId: direct.reflection.accountId,
      reflectionId: direct.reflection.id,
      expectedVersion: direct.reflection.version,
      candidates: [{
        candidateId: "candidate_v2",
        status: "kept",
        userText: null,
        subjectPersonId: null
      }]
    });
    const directFinalized = repository.finalizeReviewV2({
      accountId: "account_1",
      reflectionId: direct.reflection.id,
      expectedVersion: directDecided.reflection.version,
      operationKey: direct.operationKey,
      saveIntent: "retain_selected"
    });
    expect(directFinalized.operation).toMatchObject({ status: "confirmation_ready" });
    expect(directFinalized.confirmation).toMatchObject({
      sourceOrigin: "direct_conversation",
      saveIntent: "retain_selected",
      candidateSnapshots: [expect.objectContaining({
        evidenceSnapshots: [expect.objectContaining({
          effectiveOrigin: "direct_conversation"
        })]
      })]
    });
  });
  it("creates an explicitly sourced reflection with its persisted processing plan", () => {
    const created = repository.createReflection(createInput());

    expect(created.reused).toBe(false);
    expect(created.reflection).toMatchObject({
      id: "reflection_1",
      accountId: "account_1",
      uploadId: "upload_1",
      inputMethod: "file_upload",
      sourceOrigin: "unknown",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      status: "created",
      version: 0,
      idempotencyKey: "create_1",
      errorCode: null,
      errorMessage: null
    });
    expect(created.processingPlan).toEqual({
      planVersion: 1,
      reflectionId: "reflection_1",
      uploadId: "upload_1",
      inputMethod: "file_upload",
      sourceOrigin: "unknown",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      reviewPolicy: "required"
    });

    const input = createInput();
    delete (input as Partial<CreateDailyReflectionInput>).sourceOrigin;
    expect(() => repository.createReflection(input)).toThrow();
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM dr_reflections"
    ).get()).toEqual({ count: 1 });
  });

  it("is idempotent only for the same account, key, and immutable create payload", () => {
    const first = repository.createReflection(createInput());
    const repeated = repository.createReflection(createInput({ id: "ignored_retry_id" }));

    expect(repeated).toEqual({ ...first, reused: true });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM dr_reflections"
    ).get()).toEqual({ count: 1 });
    expect(() => repository.createReflection(createInput({
      id: "reflection_conflict",
      sourceOrigin: "direct_conversation"
    }))).toThrowError(expect.objectContaining({
      code: "daily_reflection_idempotency_conflict"
    }));

    const otherAccount = repository.createReflection(createInput({
      id: "reflection_account_2",
      accountId: "account_2"
    }));
    expect(otherAccount.reflection.accountId).toBe("account_2");
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM dr_reflections"
    ).get()).toEqual({ count: 2 });
  });

  it("binds a delayed upload and all four plan dimensions atomically", () => {
    const created = repository.createReflection(createInput({
      uploadId: null,
      idempotencyKey: "delayed_upload"
    }));
    expect(created.processingPlan).toBeNull();

    const bound = repository.bindUploadAndPlan({
      accountId: "account_1",
      reflectionId: created.reflection.id,
      expectedVersion: 0,
      uploadId: "upload_delayed"
    });
    expect(bound.reused).toBe(false);
    expect(bound.reflection).toMatchObject({ uploadId: "upload_delayed", version: 1 });
    expect(bound.processingPlan).toMatchObject({
      reflectionId: created.reflection.id,
      uploadId: "upload_delayed",
      inputMethod: "file_upload",
      sourceOrigin: "unknown",
      processingProfile: "full_recording",
      ingestionContext: "daily_reflection",
      reviewPolicy: "required"
    });

    expect(repository.bindUploadAndPlan({
      accountId: "account_1",
      reflectionId: created.reflection.id,
      expectedVersion: 0,
      uploadId: "upload_delayed"
    }).reused).toBe(true);
    expect(() => repository.bindUploadAndPlan({
      accountId: "account_1",
      reflectionId: created.reflection.id,
      expectedVersion: 1,
      uploadId: "upload_different"
    })).toThrow(DailyReflectionConflictError);
  });

  it("freezes a browser profile under both the optimistic version and execution fence", () => {
    const created = repository.createReflection(createInput({
      uploadId: null,
      inputMethod: "browser_recording",
      sourceOrigin: "user_reflection",
      processingProfile: "full_recording",
      idempotencyKey: "browser_profile"
    }));
    expect(created.processingPlan).toBeNull();
    expect(() => repository.bindUploadAndPlan({
      accountId: created.reflection.accountId,
      reflectionId: created.reflection.id,
      expectedVersion: created.reflection.version,
      uploadId: "upload_browser",
      processingProfile: "quick_reflection"
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_profile_fence_required"
    }));

    const staleFence = repository.claimExecutionLease({
      accountId: created.reflection.accountId,
      reflectionId: created.reflection.id,
      leaseOwner: "browser_probe_stale",
      leaseDurationMs: 60_000,
      allowedStatuses: ["created"]
    });
    expect(staleFence).not.toBeNull();
    repository.releaseExecutionLease({
      accountId: created.reflection.accountId,
      reflectionId: created.reflection.id,
      leaseOwner: staleFence!.leaseOwner,
      attemptVersion: staleFence!.attemptVersion
    });
    expect(() => repository.bindUploadAndPlan({
      accountId: created.reflection.accountId,
      reflectionId: created.reflection.id,
      expectedVersion: created.reflection.version,
      uploadId: "upload_browser",
      processingProfile: "quick_reflection",
      leaseOwner: staleFence!.leaseOwner,
      attemptVersion: staleFence!.attemptVersion
    })).toThrow(DailyReflectionLeaseLostError);

    const fence = repository.claimExecutionLease({
      accountId: created.reflection.accountId,
      reflectionId: created.reflection.id,
      leaseOwner: "browser_probe_winner",
      leaseDurationMs: 60_000,
      allowedStatuses: ["created"]
    });
    expect(fence).not.toBeNull();
    const bound = repository.bindUploadAndPlan({
      accountId: created.reflection.accountId,
      reflectionId: created.reflection.id,
      expectedVersion: created.reflection.version,
      uploadId: "upload_browser",
      processingProfile: "quick_reflection",
      leaseOwner: fence!.leaseOwner,
      attemptVersion: fence!.attemptVersion
    });
    expect(bound.reflection).toMatchObject({
      uploadId: "upload_browser",
      inputMethod: "browser_recording",
      processingProfile: "quick_reflection",
      version: 1
    });
    expect(bound.processingPlan).toMatchObject({
      uploadId: "upload_browser",
      inputMethod: "browser_recording",
      sourceOrigin: "user_reflection",
      processingProfile: "quick_reflection"
    });
    expect(repository.bindUploadAndPlan({
      accountId: created.reflection.accountId,
      reflectionId: created.reflection.id,
      expectedVersion: created.reflection.version,
      uploadId: "upload_browser",
      processingProfile: "quick_reflection"
    }).reused).toBe(true);
    expect(() => repository.bindUploadAndPlan({
      accountId: created.reflection.accountId,
      reflectionId: created.reflection.id,
      expectedVersion: bound.reflection.version,
      uploadId: "upload_browser",
      processingProfile: "full_recording"
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_plan_binding_conflict"
    }));
  });

  it("atomically reserves and converts account-scoped browser upload ownership", () => {
    const reflectionId = "reflection_browser_provisional";
    const uploadId = `daily-reflection-${reflectionId}`;
    const created = repository.createReflection(createInput({
      id: reflectionId,
      uploadId: null,
      inputMethod: "browser_recording",
      sourceOrigin: "user_reflection",
      processingProfile: "full_recording",
      idempotencyKey: "browser_provisional"
    })).reflection;
    const uploading = repository.transitionStatus({
      accountId: created.accountId,
      reflectionId,
      expectedVersion: created.version,
      status: "uploading"
    });
    const firstFence = repository.claimExecutionLease({
      accountId: created.accountId,
      reflectionId,
      leaseOwner: "browser_provisional_writer_1",
      leaseDurationMs: 60_000,
      uploadFingerprint: "a".repeat(64),
      provisionalUploadId: uploadId,
      allowedStatuses: ["uploading"]
    });

    expect(firstFence).toMatchObject({ attemptVersion: 1 });
    expect(repository.getReflection(created.accountId, reflectionId)).toMatchObject({
      uploadId,
      version: uploading.version + 1,
      processingProfile: "full_recording",
      sourceOrigin: "user_reflection"
    });
    expect(repository.getProcessingPlan(created.accountId, reflectionId)).toBeNull();
    expect(repository.getProvisionalUploadOwnership(created.accountId, reflectionId))
      .toMatchObject({
        accountId: created.accountId,
        reflectionId,
        uploadId,
        uploadFingerprint: "a".repeat(64),
        attemptVersion: 1,
        leaseOwner: firstFence!.leaseOwner,
        status: "uploading"
      });
    expect(repository.findReflectionByUpload(created.accountId, uploadId)).toBeNull();
    expect(() => repository.getProvisionalUploadOwnership("account_2", reflectionId))
      .toThrow(DailyReflectionNotFoundError);
    expect(() => repository.claimExecutionLease({
      accountId: created.accountId,
      reflectionId,
      leaseOwner: "browser_wrong_fingerprint",
      leaseDurationMs: 60_000,
      uploadFingerprint: "b".repeat(64),
      provisionalUploadId: uploadId,
      allowedStatuses: ["uploading"]
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_idempotency_conflict"
    }));

    repository.releaseExecutionLease({
      accountId: created.accountId,
      reflectionId,
      leaseOwner: firstFence!.leaseOwner,
      attemptVersion: firstFence!.attemptVersion
    });
    expect(repository.claimExecutionLease({
      accountId: created.accountId,
      reflectionId,
      leaseOwner: "browser_stale_provisional_writer",
      leaseDurationMs: 60_000,
      uploadFingerprint: "a".repeat(64),
      provisionalUploadId: uploadId,
      expectedAttemptVersion: 0,
      allowedStatuses: ["uploading"]
    })).toBeNull();
    const secondFence = repository.claimExecutionLease({
      accountId: created.accountId,
      reflectionId,
      leaseOwner: "browser_provisional_writer_2",
      leaseDurationMs: 60_000,
      uploadFingerprint: "a".repeat(64),
      provisionalUploadId: uploadId,
      expectedAttemptVersion: 1,
      allowedStatuses: ["uploading"]
    });
    expect(secondFence).toMatchObject({ attemptVersion: 2 });
    expect(repository.getReflection(created.accountId, reflectionId).version)
      .toBe(uploading.version + 1);
    expect(() => repository.bindUploadAndPlan({
      accountId: created.accountId,
      reflectionId,
      expectedVersion: uploading.version + 1,
      uploadId,
      processingProfile: "quick_reflection",
      leaseOwner: firstFence!.leaseOwner,
      attemptVersion: firstFence!.attemptVersion
    })).toThrow(DailyReflectionLeaseLostError);

    const bound = repository.bindUploadAndPlan({
      accountId: created.accountId,
      reflectionId,
      expectedVersion: uploading.version + 1,
      uploadId,
      processingProfile: "quick_reflection",
      leaseOwner: secondFence!.leaseOwner,
      attemptVersion: secondFence!.attemptVersion
    });
    expect(bound.reflection).toMatchObject({
      uploadId,
      processingProfile: "quick_reflection",
      version: uploading.version + 2
    });
    expect(bound.processingPlan).toMatchObject({ uploadId, processingProfile: "quick_reflection" });
    expect(repository.getProvisionalUploadOwnership(created.accountId, reflectionId))
      .toBeNull();
    expect(repository.findReflectionByUpload(created.accountId, uploadId))
      .toMatchObject({ id: reflectionId, accountId: created.accountId });
  });

  it("keeps file uploads full and rejects browser plans without an authoritative bind", () => {
    expect(() => repository.createReflection(createInput({
      processingProfile: "quick_reflection"
    }))).toThrowError(expect.objectContaining({
      code: "daily_reflection_file_upload_requires_full_recording"
    }));
    expect(() => repository.createReflection(createInput({
      inputMethod: "browser_recording",
      sourceOrigin: "user_reflection",
      processingProfile: "quick_reflection",
      uploadId: null
    }))).toThrowError(expect.objectContaining({
      code: "daily_reflection_browser_profile_requires_authoritative_duration"
    }));
    expect(() => repository.createReflection(createInput({
      inputMethod: "browser_recording",
      sourceOrigin: "user_reflection"
    }))).toThrowError(expect.objectContaining({
      code: "daily_reflection_browser_plan_requires_authoritative_duration"
    }));
  });

  it("enforces account isolation and optimistic status versions", () => {
    const created = repository.createReflection(createInput()).reflection;
    expect(repository.findReflection("account_2", created.id)).toBeNull();
    expect(() => repository.getReflection("account_2", created.id))
      .toThrow(DailyReflectionNotFoundError);
    expect(repository.getProcessingPlan("account_2", created.id)).toBeNull();
    expect(() => repository.listCandidates("account_2", created.id))
      .toThrow(DailyReflectionNotFoundError);
    expect(() => repository.transitionStatus({
      accountId: "account_2",
      reflectionId: created.id,
      expectedVersion: 0,
      status: "uploading"
    })).toThrow(DailyReflectionNotFoundError);

    const uploading = repository.transitionStatus({
      accountId: "account_1",
      reflectionId: created.id,
      expectedVersion: 0,
      status: "uploading"
    });
    expect(uploading.version).toBe(1);
    expect(() => repository.transitionStatus({
      accountId: "account_1",
      reflectionId: created.id,
      expectedVersion: 0,
      status: "transcribing"
    })).toThrowError(expect.objectContaining({
      code: "version_conflict",
      currentVersion: 1
    }));
  });

  it("keeps cancelled and deleted records as non-revivable tombstones", () => {
    const created = repository.createReflection(createInput()).reflection;
    const uploading = repository.transitionStatus({
      accountId: created.accountId,
      reflectionId: created.id,
      expectedVersion: created.version,
      status: "uploading"
    });
    const cancelled = repository.transitionStatus({
      accountId: uploading.accountId,
      reflectionId: uploading.id,
      expectedVersion: uploading.version,
      status: "cancelled"
    });
    expect(() => repository.transitionStatus({
      accountId: cancelled.accountId,
      reflectionId: cancelled.id,
      expectedVersion: cancelled.version,
      status: "review_pending"
    })).toThrow(DailyReflectionTransitionError);
    const deleted = repository.transitionStatus({
      accountId: cancelled.accountId,
      reflectionId: cancelled.id,
      expectedVersion: cancelled.version,
      status: "deleted"
    });
    expect(deleted.status).toBe("deleted");
    expect(() => repository.transitionStatus({
      accountId: deleted.accountId,
      reflectionId: deleted.id,
      expectedVersion: deleted.version,
      status: "created"
    })).toThrow(DailyReflectionTransitionError);

    const repeatedCreate = repository.createReflection(createInput({ id: "new_id" }));
    expect(repeatedCreate.reused).toBe(true);
    expect(repeatedCreate.reflection.status).toBe("deleted");
  });

  it("retains processing failure audit fields when the workflow is deleted", () => {
    const created = repository.createReflection(createInput()).reflection;
    const failed = repository.transitionStatus({
      accountId: created.accountId,
      reflectionId: created.id,
      expectedVersion: created.version,
      status: "failed",
      errorCode: "asr_failed",
      errorMessage: "transcription failed"
    });
    const deleted = repository.transitionStatus({
      accountId: failed.accountId,
      reflectionId: failed.id,
      expectedVersion: failed.version,
      status: "deleted"
    });
    expect(deleted).toMatchObject({
      status: "deleted",
      errorCode: "asr_failed",
      errorMessage: "transcription failed"
    });
  });

  it("retries a failed reflection only through the versioned retry entrypoint", () => {
    const created = repository.createReflection(createInput()).reflection;
    const failed = repository.transitionStatus({
      accountId: created.accountId,
      reflectionId: created.id,
      expectedVersion: created.version,
      status: "failed",
      errorCode: "asr_failed",
      errorMessage: "transcription failed"
    });

    expect(() => repository.transitionStatus({
      accountId: failed.accountId,
      reflectionId: failed.id,
      expectedVersion: failed.version,
      status: "transcribing"
    })).toThrow(DailyReflectionTransitionError);
    expect(() => repository.retryFailed({
      accountId: "account_2",
      reflectionId: failed.id,
      expectedVersion: failed.version,
      resumeStatus: "transcribing"
    })).toThrow(DailyReflectionNotFoundError);
    expect(() => repository.retryFailed({
      accountId: failed.accountId,
      reflectionId: failed.id,
      expectedVersion: failed.version - 1,
      resumeStatus: "transcribing"
    })).toThrowError(expect.objectContaining({
      code: "version_conflict",
      currentVersion: failed.version
    }));

    const retried = repository.retryFailed({
      accountId: failed.accountId,
      reflectionId: failed.id,
      expectedVersion: failed.version,
      resumeStatus: "transcribing"
    });
    expect(retried.reflection).toMatchObject({
      status: "transcribing",
      version: failed.version + 1,
      errorCode: null,
      errorMessage: null
    });
    expect(retried.processingPlan.uploadId).toBe("upload_1");
    expect(() => repository.retryFailed({
      accountId: retried.reflection.accountId,
      reflectionId: retried.reflection.id,
      expectedVersion: retried.reflection.version,
      resumeStatus: "extracting"
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_retry_requires_failed"
    }));
  });

  it("stores pending candidates once with fail-closed identity defaults", () => {
    const created = repository.createReflection(createInput()).reflection;
    const extracting = transitionPath(created, [
      "uploading",
      "transcribing",
      "extracting"
    ]);
    const candidateInput = [
      {
        id: "candidate_1",
        ordinal: 0,
        proposedText: "I may need to revisit the plan.",
        candidateType: "event" as const,
        sourceSegmentIds: ["segment_1", "segment_2"]
      },
      {
        id: "candidate_2",
        ordinal: 1,
        proposedText: "Ask whether the timing still works.",
        candidateType: "question" as const,
        sourceSegmentIds: ["segment_3"]
      }
    ];

    const saved = repository.savePendingCandidates({
      accountId: extracting.accountId,
      reflectionId: extracting.id,
      expectedVersion: extracting.version,
      candidates: candidateInput
    });
    expect(saved.reused).toBe(false);
    expect(saved.reflection.version).toBe(extracting.version + 1);
    expect(saved.candidates).toHaveLength(2);
    expect(saved.candidates[0]).toMatchObject({
      proposedText: "I may need to revisit the plan.",
      userText: null,
      status: "pending",
      subjectPersonId: null,
      subjectConfirmed: false,
      version: 0,
      sourceSegmentIds: ["segment_1", "segment_2"]
    });

    const reviewPending = repository.transitionStatus({
      accountId: saved.reflection.accountId,
      reflectionId: saved.reflection.id,
      expectedVersion: saved.reflection.version,
      status: "review_pending"
    });
    const repeated = repository.savePendingCandidates({
      accountId: reviewPending.accountId,
      reflectionId: reviewPending.id,
      expectedVersion: extracting.version,
      candidates: candidateInput
    });
    expect(repeated.reused).toBe(true);
    expect(repeated.candidates).toHaveLength(2);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM dr_candidates"
    ).get()).toEqual({ count: 2 });

    expect(() => database.prepare(`
      UPDATE dr_candidates SET proposed_text = 'overwritten' WHERE id = 'candidate_1'
    `).run()).toThrow(/daily_reflection_candidate_proposed_text_immutable/u);
    expect(repository.listCandidates("account_1", created.id)[0].proposedText)
      .toBe("I may need to revisit the plan.");
    expect(() => repository.savePendingCandidates({
      accountId: reviewPending.accountId,
      reflectionId: reviewPending.id,
      expectedVersion: reviewPending.version,
      candidates: [{ ...candidateInput[0], proposedText: "different" }, candidateInput[1]]
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_candidate_set_conflict"
    }));
  });

  it("rejects evidence-free candidates without partial writes", () => {
    const extracting = transitionPath(
      repository.createReflection(createInput()).reflection,
      ["uploading", "transcribing", "extracting"]
    );
    expect(() => repository.savePendingCandidates({
      accountId: extracting.accountId,
      reflectionId: extracting.id,
      expectedVersion: extracting.version,
      candidates: [{
        ordinal: 0,
        proposedText: "unsupported",
        candidateType: "summary",
        sourceSegmentIds: []
      }]
    })).toThrow();
    expect(repository.getReflection(extracting.accountId, extracting.id).version)
      .toBe(extracting.version);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM dr_candidates"
    ).get()).toEqual({ count: 0 });
  });

  it("enforces the frozen quick-reflection candidate maximum in persistence", () => {
    const created = repository.createReflection(createInput({
      uploadId: null,
      inputMethod: "browser_recording",
      sourceOrigin: "user_reflection",
      idempotencyKey: "quick_candidate_limit"
    })).reflection;
    const fence = repository.claimExecutionLease({
      accountId: created.accountId,
      reflectionId: created.id,
      leaseOwner: "quick_profile_probe",
      leaseDurationMs: 60_000,
      allowedStatuses: ["created"]
    });
    const bound = repository.bindUploadAndPlan({
      accountId: created.accountId,
      reflectionId: created.id,
      expectedVersion: created.version,
      uploadId: "upload_quick",
      processingProfile: "quick_reflection",
      leaseOwner: fence!.leaseOwner,
      attemptVersion: fence!.attemptVersion
    }).reflection;
    repository.releaseExecutionLease({
      accountId: created.accountId,
      reflectionId: created.id,
      leaseOwner: fence!.leaseOwner,
      attemptVersion: fence!.attemptVersion
    });
    const extracting = transitionPath(bound, [
      "uploading",
      "transcribing",
      "extracting"
    ]);
    expect(() => repository.savePendingCandidates({
      accountId: extracting.accountId,
      reflectionId: extracting.id,
      expectedVersion: extracting.version,
      candidates: Array.from({ length: 4 }, (_, ordinal) => ({
        ordinal,
        proposedText: `quick candidate ${ordinal + 1}`,
        candidateType: "summary" as const,
        sourceSegmentIds: [`segment_quick_${ordinal + 1}`]
      }))
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_quick_candidate_limit_exceeded"
    }));
    expect(repository.getReflection(extracting.accountId, extracting.id).version)
      .toBe(extracting.version);
    expect(repository.listCandidates(extracting.accountId, extracting.id)).toEqual([]);
  });

  it("rolls candidate, source, and reflection writes back as one transaction", () => {
    const extracting = transitionPath(
      repository.createReflection(createInput()).reflection,
      ["uploading", "transcribing", "extracting"]
    );
    database.exec(`
      CREATE TRIGGER dr_test_reject_second_source
      BEFORE INSERT ON dr_candidate_sources
      WHEN NEW.position = 1
      BEGIN
        SELECT RAISE(ABORT, 'forced_candidate_source_failure');
      END;
    `);

    expect(() => repository.savePendingCandidates({
      accountId: extracting.accountId,
      reflectionId: extracting.id,
      expectedVersion: extracting.version,
      candidates: [{
        id: "candidate_atomic",
        ordinal: 0,
        proposedText: "atomic candidate",
        candidateType: "summary",
        sourceSegmentIds: ["segment_1", "segment_2"]
      }]
    })).toThrow(/forced_candidate_source_failure/u);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM dr_candidates"
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM dr_candidate_sources"
    ).get()).toEqual({ count: 0 });
    expect(repository.getReflection(extracting.accountId, extracting.id).version)
      .toBe(extracting.version);
  });

  it("blocks candidate writes after a cancellation tombstone", () => {
    const extracting = transitionPath(
      repository.createReflection(createInput()).reflection,
      ["uploading", "transcribing", "extracting"]
    );
    const cancelled = repository.transitionStatus({
      accountId: extracting.accountId,
      reflectionId: extracting.id,
      expectedVersion: extracting.version,
      status: "cancelled"
    });
    expect(() => repository.savePendingCandidates({
      accountId: cancelled.accountId,
      reflectionId: cancelled.id,
      expectedVersion: cancelled.version,
      candidates: [{
        ordinal: 0,
        proposedText: "late candidate",
        candidateType: "event",
        sourceSegmentIds: ["segment_late"]
      }]
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_tombstoned"
    }));
    expect(repository.listCandidates(cancelled.accountId, cancelled.id)).toEqual([]);
  });

  it("lists only the requested account's non-deleted records in stable recent order", () => {
    repository.createReflection(createInput({
      id: "reflection_b",
      uploadId: "upload_b",
      idempotencyKey: "create_b"
    }));
    repository.createReflection(createInput({
      id: "reflection_a",
      uploadId: "upload_a",
      idempotencyKey: "create_a"
    }));
    repository.createReflection(createInput({
      id: "reflection_other",
      accountId: "account_2",
      uploadId: "upload_other",
      idempotencyKey: "create_other"
    }));
    const deleted = repository.createReflection(createInput({
      id: "reflection_deleted",
      uploadId: "upload_deleted",
      idempotencyKey: "create_deleted"
    })).reflection;
    repository.transitionStatus({
      accountId: deleted.accountId,
      reflectionId: deleted.id,
      expectedVersion: deleted.version,
      status: "deleted"
    });

    expect(repository.listAccountReflections("account_1", 2).map((item) => item.id))
      .toEqual(["reflection_b", "reflection_a"]);
    expect(repository.listAccountReflections("account_2").map((item) => item.id))
      .toEqual(["reflection_other"]);
    expect(() => repository.listAccountReflections("account_1", 25)).toThrow();
  });

  it("updates candidate decisions atomically with one optimistic reflection version", () => {
    const review = createReviewPendingCandidateSet();
    const updated = repository.updateCandidateDecisions({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      candidates: [
        {
          candidateId: "candidate_1",
          status: "kept",
          userText: "  I will contact Alice before Friday.  ",
          subjectPersonId: "person_alice"
        },
        {
          candidateId: "candidate_2",
          status: "excluded",
          userText: "   ",
          subjectPersonId: null
        }
      ]
    });

    expect(updated.reflection.version).toBe(review.reflection.version + 1);
    expect(updated.candidates).toEqual([
      expect.objectContaining({
        id: "candidate_1",
        proposedText: "Contact Alice before Friday.",
        userText: "I will contact Alice before Friday.",
        status: "kept",
        subjectPersonId: "person_alice",
        subjectConfirmed: true,
        version: 1
      }),
      expect.objectContaining({
        id: "candidate_2",
        proposedText: "Reconsider the travel plan.",
        userText: null,
        status: "excluded",
        subjectPersonId: null,
        subjectConfirmed: false,
        version: 1
      })
    ]);
    expect(() => repository.updateCandidateDecisions({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      candidates: [{
        candidateId: "candidate_1",
        status: "excluded",
        userText: null,
        subjectPersonId: null
      }]
    })).toThrowError(expect.objectContaining({ code: "version_conflict" }));
  });

  it("rolls back a candidate decision batch containing a foreign candidate", () => {
    const review = createReviewPendingCandidateSet();
    expect(() => repository.updateCandidateDecisions({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      candidates: [
        {
          candidateId: "candidate_1",
          status: "kept",
          userText: null,
          subjectPersonId: null
        },
        {
          candidateId: "candidate_from_another_reflection",
          status: "excluded",
          userText: null,
          subjectPersonId: null
        }
      ]
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_candidate_mismatch"
    }));
    expect(repository.getReflection(review.reflection.accountId, review.reflection.id).version)
      .toBe(review.reflection.version);
    expect(repository.listCandidates(review.reflection.accountId, review.reflection.id))
      .toEqual([
        expect.objectContaining({ id: "candidate_1", status: "pending", version: 0 }),
        expect.objectContaining({ id: "candidate_2", status: "pending", version: 0 })
      ]);
  });

  it("creates one immutable confirmation and reuses the exact finalize request", () => {
    const review = createReviewPendingCandidateSet();
    const decided = repository.updateCandidateDecisions({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      candidates: [
        {
          candidateId: "candidate_1",
          status: "kept",
          userText: "I will contact Alice tomorrow.",
          subjectPersonId: "person_alice"
        },
        {
          candidateId: "candidate_2",
          status: "excluded",
          userText: null,
          subjectPersonId: null
        }
      ]
    });
    const finalized = repository.finalizeReview({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: decided.reflection.version,
      idempotencyKey: "finalize_1"
    });

    expect(finalized.reused).toBe(false);
    expect(finalized.confirmation).toMatchObject({
      reflectionId: review.reflection.id,
      sourceOrigin: "user_reflection",
      idempotencyKey: "finalize_1",
      candidateSnapshots: [
        {
          candidateId: "candidate_1",
          proposedText: "Contact Alice before Friday.",
          userText: "I will contact Alice tomorrow.",
          finalText: "I will contact Alice tomorrow.",
          status: "kept",
          sourceSegmentIds: ["segment_1"],
          subjectPersonId: "person_alice"
        },
        {
          candidateId: "candidate_2",
          proposedText: "Reconsider the travel plan.",
          userText: null,
          finalText: "Reconsider the travel plan.",
          status: "excluded",
          sourceSegmentIds: ["segment_2"],
          subjectPersonId: null
        }
      ]
    });
    expect(finalized.operation).toMatchObject({
      status: "confirmation_ready",
      excludedCount: 1
    });
    expect(repository.getReflection(review.reflection.accountId, review.reflection.id).status)
      .toBe("confirmation_ready");
    expect(repository.finalizeReview({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: decided.reflection.version,
      idempotencyKey: "finalize_1"
    })).toEqual({ ...finalized, reused: true });
    expect(() => repository.finalizeReview({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: decided.reflection.version + 1,
      idempotencyKey: "finalize_1"
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_finalize_idempotency_conflict"
    }));
    expect(() => repository.updateCandidateDecisions({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: decided.reflection.version + 1,
      candidates: [{
        candidateId: "candidate_1",
        status: "excluded",
        userText: null,
        subjectPersonId: null
      }]
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_review_not_editable"
    }));
    expect(() => database.prepare(`
      UPDATE dr_reflection_confirmations SET source_origin = 'unknown'
      WHERE reflection_id = 'reflection_1'
    `).run()).toThrow(/daily_reflection_confirmation_immutable/u);
  });

  it("requires every candidate decision and completes an all-excluded review with zero receipts", () => {
    const review = createReviewPendingCandidateSet();
    expect(() => repository.finalizeReview({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      idempotencyKey: "pending_finalize"
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_candidates_pending"
    }));
    const decided = repository.updateCandidateDecisions({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      candidates: review.candidates.map((candidate) => ({
        candidateId: candidate.id,
        status: "excluded" as const,
        userText: null,
        subjectPersonId: null
      }))
    });
    repository.finalizeReview({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: decided.reflection.version,
      idempotencyKey: "all_excluded"
    });
    const claim = repository.startAdmissionOperation({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      leaseOwner: "admission_worker_1",
      leaseDurationMs: 60_000
    });
    if (!claim.executionFence) throw new Error("expected admission fence");
    const completed = repository.completeAdmissionOperation({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      leaseOwner: claim.executionFence.leaseOwner,
      attemptVersion: claim.executionFence.attemptVersion,
      results: []
    });

    expect(completed).toMatchObject({
      reused: false,
      results: [],
      operation: {
        status: "completed",
        admittedCount: 0,
        rejectedCount: 0,
        excludedCount: 2
      }
    });
    expect(repository.getReflection(review.reflection.accountId, review.reflection.id).status)
      .toBe("completed");
    expect(repository.completeAdmissionOperation({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      leaseOwner: claim.executionFence.leaseOwner,
      attemptVersion: claim.executionFence.attemptVersion,
      results: []
    })).toMatchObject({ reused: true, results: [] });
  });

  it("fences admission retries so stale workers cannot overwrite receipts or terminal state", () => {
    const review = createReviewPendingCandidateSet();
    const decided = repository.updateCandidateDecisions({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: review.reflection.version,
      candidates: [
        {
          candidateId: "candidate_1",
          status: "kept",
          userText: null,
          subjectPersonId: null
        },
        {
          candidateId: "candidate_2",
          status: "excluded",
          userText: null,
          subjectPersonId: null
        }
      ]
    });
    repository.finalizeReview({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      expectedVersion: decided.reflection.version,
      idempotencyKey: "fenced_admission"
    });
    const first = repository.startAdmissionOperation({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      leaseOwner: "admission_worker_old",
      leaseDurationMs: 60_000
    });
    if (!first.executionFence) throw new Error("expected first admission fence");
    const retryableResult = {
      candidateId: "candidate_1",
      status: "retryable_error" as const,
      memoryId: null,
      reasonCode: null,
      errorCode: "memory_unavailable",
      operationKey: "daily-reflection:confirmation:candidate_1",
      updatedAt: timestamp
    };
    repository.failAdmissionOperation({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      leaseOwner: first.executionFence.leaseOwner,
      attemptVersion: first.executionFence.attemptVersion,
      errorCode: "memory_unavailable",
      results: [retryableResult]
    });
    const second = repository.startAdmissionOperation({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      leaseOwner: "admission_worker_new",
      leaseDurationMs: 60_000
    });
    if (!second.executionFence) throw new Error("expected second admission fence");
    expect(second.executionFence.attemptVersion)
      .toBe(first.executionFence.attemptVersion + 1);

    expect(() => repository.failAdmissionOperation({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      leaseOwner: first.executionFence!.leaseOwner,
      attemptVersion: first.executionFence!.attemptVersion,
      errorCode: "stale_failure",
      results: [{ ...retryableResult, errorCode: "stale_failure" }]
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_admission_lease_lost"
    }));
    expect(() => repository.completeAdmissionOperation({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      leaseOwner: first.executionFence!.leaseOwner,
      attemptVersion: first.executionFence!.attemptVersion,
      results: [{
        candidateId: "candidate_1",
        status: "admitted",
        memoryId: "memory_stale",
        reasonCode: null,
        errorCode: null,
        operationKey: retryableResult.operationKey,
        updatedAt: timestamp
      }]
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_admission_lease_lost"
    }));
    expect(repository.getAdmissionOperation(review.reflection.accountId, review.reflection.id))
      .toMatchObject({ status: "admitting" });
    expect(repository.listAdmissionResults(
      review.reflection.accountId,
      second.operation.id
    )).toEqual([expect.objectContaining({ errorCode: "memory_unavailable" })]);

    repository.completeAdmissionOperation({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      leaseOwner: second.executionFence.leaseOwner,
      attemptVersion: second.executionFence.attemptVersion,
      results: [{
        candidateId: "candidate_1",
        status: "admitted",
        memoryId: "memory_1",
        reasonCode: null,
        errorCode: null,
        operationKey: retryableResult.operationKey,
        updatedAt: timestamp
      }]
    });
    repository.failAdmissionOperation({
      accountId: review.reflection.accountId,
      reflectionId: review.reflection.id,
      leaseOwner: first.executionFence.leaseOwner,
      attemptVersion: first.executionFence.attemptVersion,
      errorCode: "very_late_failure",
      results: [{ ...retryableResult, errorCode: "very_late_failure" }]
    });
    expect(repository.getAdmissionOperation(review.reflection.accountId, review.reflection.id))
      .toMatchObject({ status: "completed", admittedCount: 1 });
    expect(repository.listAdmissionResults(
      review.reflection.accountId,
      second.operation.id
    )).toEqual([expect.objectContaining({
      status: "admitted",
      memoryId: "memory_1",
      errorCode: null
    })]);
  });

  it("freezes canonical Evidence at review and rejects late asset publication", () => {
    const created = repository.createReflection(createInput({
      sourceOrigin: "user_reflection",
      idempotencyKey: "evidence_freeze"
    })).reflection;
    const extracting = transitionPath(created, ["uploading", "transcribing", "extracting"]);
    const fence = repository.claimExecutionLease({
      accountId: created.accountId,
      reflectionId: created.id,
      leaseOwner: "late_staging_worker",
      leaseDurationMs: 60_000,
      allowedStatuses: ["extracting"]
    });
    if (!fence) throw new Error("expected staging fence");
    const originalSegment = {
      id: "segment_immutable",
      uploadId: "upload_1",
      startSeconds: 0,
      endSeconds: 9,
      text: "The canonical wording stays unchanged.",
      confidence: 0.99,
      sceneLabels: [],
      valueLabels: []
    };
    repository.publishAssetUnderExecutionFence({
      accountId: created.accountId,
      reflectionId: created.id,
      leaseOwner: fence.leaseOwner,
      attemptVersion: fence.attemptVersion,
      assetKind: "segments",
      payload: [originalSegment]
    });
    const saved = repository.savePendingCandidates({
      accountId: created.accountId,
      reflectionId: created.id,
      expectedVersion: extracting.version,
      leaseOwner: fence.leaseOwner,
      attemptVersion: fence.attemptVersion,
      candidates: [{
        id: "candidate_immutable",
        ordinal: 0,
        proposedText: "The canonical wording stays unchanged.",
        candidateType: "summary",
        sourceSegmentIds: [originalSegment.id]
      }]
    });
    const reviewPending = repository.transitionStatus({
      accountId: created.accountId,
      reflectionId: created.id,
      expectedVersion: saved.reflection.version,
      status: "review_pending",
      leaseOwner: fence.leaseOwner,
      attemptVersion: fence.attemptVersion
    });
    expect(() => repository.publishAssetUnderExecutionFence({
      accountId: created.accountId,
      reflectionId: created.id,
      leaseOwner: fence.leaseOwner,
      attemptVersion: fence.attemptVersion,
      assetKind: "segments",
      payload: [{ ...originalSegment, text: "Late replacement." }]
    })).toThrow(DailyReflectionLeaseLostError);
    const decided = repository.updateCandidateDecisions({
      accountId: created.accountId,
      reflectionId: created.id,
      expectedVersion: reviewPending.version,
      candidates: [{
        candidateId: "candidate_immutable",
        status: "kept",
        userText: null,
        subjectPersonId: null
      }]
    });
    const finalized = repository.finalizeReview({
      accountId: created.accountId,
      reflectionId: created.id,
      expectedVersion: decided.reflection.version,
      idempotencyKey: "evidence_freeze_finalize"
    });
    expect(finalized.confirmation.candidateSnapshots[0].evidenceSnapshots)
      .toEqual([{
        sourceSegmentId: originalSegment.id,
        uploadId: originalSegment.uploadId,
        startSeconds: originalSegment.startSeconds,
        endSeconds: originalSegment.endSeconds,
        text: originalSegment.text,
        effectiveOrigin: "user_reflection"
      }]);
    expect(() => repository.transitionStatus({
      accountId: created.accountId,
      reflectionId: created.id,
      expectedVersion: decided.reflection.version + 1,
      status: "cancelled"
    })).toThrow(DailyReflectionTransitionError);
    expect(() => repository.deleteCandidates(created.accountId, created.id))
      .toThrow(/daily_reflection_candidate_finalized/u);
  });

  it("publishes only the owned failed upload while the failing worker still holds its fence", () => {
    const created = repository.createReflection(createInput({
      sourceOrigin: "user_reflection"
    })).reflection;
    const extracting = transitionPath(created, [
      "uploading",
      "transcribing",
      "extracting"
    ]);
    const fence = repository.claimExecutionLease({
      accountId: created.accountId,
      reflectionId: created.id,
      leaseOwner: "failing_staging_worker",
      leaseDurationMs: 60_000,
      allowedStatuses: ["extracting"]
    });
    if (!fence) throw new Error("expected failing worker fence");
    repository.transitionStatus({
      accountId: created.accountId,
      reflectionId: created.id,
      expectedVersion: extracting.version,
      status: "failed",
      errorCode: "daily_reflection_processing_failed",
      errorMessage: "Daily Reflection staging failed",
      leaseOwner: fence.leaseOwner,
      attemptVersion: fence.attemptVersion
    });
    const failedUpload = {
      id: "upload_1",
      originalName: "reflection.wav",
      mimeType: "audio/wav",
      sizeBytes: 5,
      recordingDate: "2026-08-13",
      createdAt: timestamp,
      status: "failed" as const,
      filePath: "C:/daily-brief/uploads/upload_1.wav",
      ingestionContext: "daily_reflection" as const,
      reflectionId: created.id,
      errorCode: "daily_reflection_processing_failed",
      errorMessage: "Daily Reflection staging failed"
    };
    const publish = (assetKind: "upload" | "segments", payload: unknown) =>
      repository.publishAssetUnderExecutionFence({
        accountId: created.accountId,
        reflectionId: created.id,
        leaseOwner: fence.leaseOwner,
        attemptVersion: fence.attemptVersion,
        assetKind,
        payload
      });

    expect(() => publish("segments", [])).toThrow(DailyReflectionLeaseLostError);
    expect(() => publish("upload", { ...failedUpload, status: "extracting" }))
      .toThrow(DailyReflectionLeaseLostError);
    expect(() => publish("upload", { ...failedUpload, reflectionId: "reflection_other" }))
      .toThrow(DailyReflectionLeaseLostError);
    expect(() => publish("upload", { ...failedUpload, id: "upload_other" }))
      .toThrow(DailyReflectionLeaseLostError);
    expect(() => publish("upload", {
      ...failedUpload,
      errorCode: "daily_reflection_other_failure"
    })).toThrow(DailyReflectionLeaseLostError);

    expect(() => publish("upload", failedUpload)).not.toThrow();
    expect(repository.readPublishedAsset({
      accountId: created.accountId,
      reflectionId: created.id,
      assetKind: "upload"
    })).toEqual(failedUpload);

    repository.releaseExecutionLease({
      accountId: created.accountId,
      reflectionId: created.id,
      leaseOwner: fence.leaseOwner,
      attemptVersion: fence.attemptVersion
    });
    expect(() => publish("upload", failedUpload)).toThrow(DailyReflectionLeaseLostError);
  });

  it("lists unfinished review finalization for recovery but excludes settled states", () => {
    const created = repository.createReflection(createInput()).reflection;
    const reviewPending = transitionPath(created, [
      "uploading",
      "transcribing",
      "extracting",
      "review_pending"
    ]);
    const failed = transitionPath(repository.createReflection(createInput({
      id: "reflection_failed_recovery",
      uploadId: "upload_failed_recovery",
      idempotencyKey: "failed_recovery"
    })).reflection, ["uploading", "failed"]);
    const cancelled = transitionPath(repository.createReflection(createInput({
      id: "reflection_cancelled_recovery",
      uploadId: "upload_cancelled_recovery",
      idempotencyKey: "cancelled_recovery"
    })).reflection, ["cancelled"]);
    const deleted = transitionPath(repository.createReflection(createInput({
      id: "reflection_deleted_recovery",
      uploadId: "upload_deleted_recovery",
      idempotencyKey: "deleted_recovery"
    })).reflection, ["deleted"]);

    const recoverableIds = repository.listRecoverableReflections()
      .map(({ reflection }) => reflection.id);

    expect(recoverableIds).toContain(reviewPending.id);
    expect(recoverableIds).not.toEqual(expect.arrayContaining([
      failed.id,
      cancelled.id,
      deleted.id
    ]));
  });

  it("fences dual repositories and rejects stale writers after an expired takeover", () => {
    const root = mkdtempSync(join(tmpdir(), "daily-reflection-lease-"));
    const filePath = join(root, "daily-reflection.sqlite");
    const databaseA = openDailyReflectionDatabase({ filePath });
    const databaseB = openDailyReflectionDatabase({ filePath });
    try {
      let leaseNow = "2026-08-13T00:00:00.000Z";
      const repositoryA = new DailyReflectionRepository(databaseA, {
        now: () => leaseNow
      });
      const repositoryB = new DailyReflectionRepository(databaseB, {
        now: () => leaseNow
      });
      const created = repositoryA.createReflection(createInput({
        id: "reflection_fenced",
        uploadId: "upload_fenced",
        idempotencyKey: "fenced"
      })).reflection;
      const uploading = repositoryA.transitionStatus({
        accountId: created.accountId,
        reflectionId: created.id,
        expectedVersion: created.version,
        status: "uploading"
      });
      const firstFence = repositoryA.claimExecutionLease({
        accountId: created.accountId,
        reflectionId: created.id,
        leaseOwner: "worker_a",
        leaseDurationMs: 1_000,
        uploadFingerprint: "a".repeat(64),
        allowedStatuses: ["uploading"],
        now: "2026-08-13T00:00:00.000Z"
      });
      expect(firstFence).not.toBeNull();
      expect(repositoryB.claimExecutionLease({
        accountId: created.accountId,
        reflectionId: created.id,
        leaseOwner: "worker_b_early",
        leaseDurationMs: 1_000,
        uploadFingerprint: "a".repeat(64),
        allowedStatuses: ["uploading"],
        now: "2026-08-13T00:00:00.500Z"
      })).toBeNull();

      const secondFence = repositoryB.claimExecutionLease({
        accountId: created.accountId,
        reflectionId: created.id,
        leaseOwner: "worker_b",
        leaseDurationMs: 5_000,
        uploadFingerprint: "a".repeat(64),
        allowedStatuses: ["uploading"],
        now: "2026-08-13T00:00:02.000Z"
      });
      leaseNow = "2026-08-13T00:00:02.100Z";
      expect(secondFence).toMatchObject({
        leaseOwner: "worker_b",
        attemptVersion: firstFence!.attemptVersion + 1
      });
      repositoryB.publishAssetUnderExecutionFence({
        accountId: created.accountId,
        reflectionId: created.id,
        leaseOwner: secondFence!.leaseOwner,
        attemptVersion: secondFence!.attemptVersion,
        assetKind: "upload",
        payload: { id: "upload_fenced", writer: "winner" }
      });
      expect(() => repositoryA.publishAssetUnderExecutionFence({
        accountId: created.accountId,
        reflectionId: created.id,
        leaseOwner: firstFence!.leaseOwner,
        attemptVersion: firstFence!.attemptVersion,
        assetKind: "upload",
        payload: { id: "upload_fenced", writer: "stale" }
      })).toThrow(DailyReflectionLeaseLostError);
      expect(repositoryB.readPublishedAsset({
        accountId: created.accountId,
        reflectionId: created.id,
        assetKind: "upload"
      })).toEqual({ id: "upload_fenced", writer: "winner" });
      expect(repositoryA.getUploadFingerprint(created.accountId, created.id))
        .toBe("a".repeat(64));
      expect(() => repositoryA.transitionStatus({
        accountId: created.accountId,
        reflectionId: created.id,
        expectedVersion: uploading.version,
        status: "transcribing",
        leaseOwner: firstFence!.leaseOwner,
        attemptVersion: firstFence!.attemptVersion
      })).toThrow(DailyReflectionLeaseLostError);
      expect(repositoryA.releaseExecutionLease({
        accountId: created.accountId,
        reflectionId: created.id,
        leaseOwner: firstFence!.leaseOwner,
        attemptVersion: firstFence!.attemptVersion
      })).toBe(false);

      const transcribing = repositoryB.transitionStatus({
        accountId: created.accountId,
        reflectionId: created.id,
        expectedVersion: uploading.version,
        status: "transcribing",
        leaseOwner: secondFence!.leaseOwner,
        attemptVersion: secondFence!.attemptVersion
      });
      const extracting = repositoryB.transitionStatus({
        accountId: created.accountId,
        reflectionId: created.id,
        expectedVersion: transcribing.version,
        status: "extracting",
        leaseOwner: secondFence!.leaseOwner,
        attemptVersion: secondFence!.attemptVersion
      });
      expect(() => repositoryA.savePendingCandidates({
        accountId: created.accountId,
        reflectionId: created.id,
        expectedVersion: extracting.version,
        leaseOwner: firstFence!.leaseOwner,
        attemptVersion: firstFence!.attemptVersion,
        candidates: [{
          ordinal: 0,
          proposedText: "stale candidate",
          candidateType: "summary",
          sourceSegmentIds: ["segment_stale"]
        }]
      })).toThrow(DailyReflectionLeaseLostError);
      expect(repositoryB.listCandidates(created.accountId, created.id)).toEqual([]);
      repositoryB.savePendingCandidates({
        accountId: created.accountId,
        reflectionId: created.id,
        expectedVersion: extracting.version,
        leaseOwner: secondFence!.leaseOwner,
        attemptVersion: secondFence!.attemptVersion,
        candidates: [{
          ordinal: 0,
          proposedText: "winning candidate",
          candidateType: "summary",
          sourceSegmentIds: ["segment_winner"]
        }]
      });
      expect(repositoryB.listCandidates(created.accountId, created.id))
        .toEqual([expect.objectContaining({ proposedText: "winning candidate" })]);
    } finally {
      databaseB.close();
      databaseA.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fences candidate revocation and preserves immutable admission history", () => {
    const completed = createCompletedCandidateSet();
    const request = {
      accountId: completed.accountId,
      reflectionId: completed.id,
      candidateId: "candidate_1",
      expectedVersion: completed.version,
      idempotencyKey: "revoke_candidate_1",
      now: timestamp
    };
    const prepared = repository.prepareCandidateRevocation(request);
    expect(prepared).toMatchObject({
      reused: false,
      receipt: null,
      operation: {
        status: "ready",
        admissionStatus: "admitted",
        memoryId: "memory_candidate_1"
      }
    });
    expect(repository.prepareCandidateRevocation(request)).toMatchObject({ reused: true });
    expect(() => repository.prepareCandidateRevocation({
      ...request,
      expectedVersion: completed.version + 1
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_candidate_revocation_idempotency_conflict"
    }));

    const first = repository.startCandidateRevocation({
      accountId: completed.accountId,
      reflectionId: completed.id,
      candidateId: "candidate_1",
      leaseOwner: "revocation_first",
      leaseDurationMs: 60_000,
      now: timestamp
    });
    expect(first.executionFence).toMatchObject({ attemptVersion: 1 });
    expect(() => repository.startCandidateRevocation({
      accountId: completed.accountId,
      reflectionId: completed.id,
      candidateId: "candidate_1",
      leaseOwner: "revocation_second",
      leaseDurationMs: 60_000,
      now: timestamp
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_candidate_revocation_busy"
    }));
    repository.failCandidateRevocation({
      accountId: completed.accountId,
      reflectionId: completed.id,
      candidateId: "candidate_1",
      leaseOwner: first.executionFence!.leaseOwner,
      attemptVersion: first.executionFence!.attemptVersion,
      errorCode: "memory_apply_interrupted",
      now: timestamp
    });
    const retry = repository.startCandidateRevocation({
      accountId: completed.accountId,
      reflectionId: completed.id,
      candidateId: "candidate_1",
      leaseOwner: "revocation_retry",
      leaseDurationMs: 60_000,
      now: timestamp
    });
    expect(retry.executionFence).toMatchObject({ attemptVersion: 2 });
    expect(() => repository.completeCandidateRevocation({
      accountId: completed.accountId,
      reflectionId: completed.id,
      candidateId: "candidate_1",
      leaseOwner: first.executionFence!.leaseOwner,
      attemptVersion: first.executionFence!.attemptVersion,
      result: {
        outcome: "revoked",
        memoryId: "memory_candidate_1",
        removedMemoryEvidenceCount: 1,
        removedPersonSourceCount: 0
      },
      indexRefreshRequired: false,
      now: timestamp
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_candidate_revocation_lease_lost"
    }));
    const done = repository.completeCandidateRevocation({
      accountId: completed.accountId,
      reflectionId: completed.id,
      candidateId: "candidate_1",
      leaseOwner: retry.executionFence!.leaseOwner,
      attemptVersion: retry.executionFence!.attemptVersion,
      result: {
        outcome: "revoked",
        memoryId: "memory_candidate_1",
        removedMemoryEvidenceCount: 1,
        removedPersonSourceCount: 0
      },
      indexRefreshRequired: true,
      now: timestamp
    });
    expect(done).toMatchObject({
      operation: { status: "completed", indexRefreshStatus: "pending" },
      receipt: { outcome: "revoked", memoryId: "memory_candidate_1" }
    });
    expect(repository.getRememberedCandidateCount(completed.accountId, completed.id)).toBe(0);
    expect(repository.listCandidates(completed.accountId, completed.id))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "candidate_1", status: "kept" })
      ]));
    expect(repository.getConfirmation(completed.accountId, completed.id)?.candidateSnapshots)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ candidateId: "candidate_1", status: "kept" })
      ]));
    expect(repository.getAdmissionOperation(completed.accountId, completed.id))
      .toMatchObject({ status: "completed", admittedCount: 1 });
  });

  it("returns a no-op receipt for rejected candidates and lets whole delete win", () => {
    const completed = createCompletedCandidateSet();
    const noObject = repository.prepareCandidateRevocation({
      accountId: completed.accountId,
      reflectionId: completed.id,
      candidateId: "candidate_2",
      expectedVersion: completed.version,
      idempotencyKey: "revoke_rejected_candidate",
      now: timestamp
    });
    expect(noObject).toMatchObject({
      operation: { status: "completed", admissionStatus: "rejected" },
      receipt: { outcome: "no_long_term_object" }
    });

    const current = repository.getReflection(completed.accountId, completed.id);
    repository.prepareCandidateRevocation({
      accountId: completed.accountId,
      reflectionId: completed.id,
      candidateId: "candidate_1",
      expectedVersion: current.version,
      idempotencyKey: "revoke_then_delete",
      now: timestamp
    });
    repository.markAdmissionDeleteRequested(completed.accountId, completed.id);
    expect(() => repository.startCandidateRevocation({
      accountId: completed.accountId,
      reflectionId: completed.id,
      candidateId: "candidate_1",
      leaseOwner: "late_revocation",
      leaseDurationMs: 60_000,
      now: timestamp
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_delete_requested"
    }));
    expect(() => repository.prepareCandidateRevocation({
      accountId: "account_other",
      reflectionId: completed.id,
      candidateId: "candidate_1",
      expectedVersion: current.version,
      idempotencyKey: "cross_account_revocation",
      now: timestamp
    })).toThrow(DailyReflectionNotFoundError);
  });
});
