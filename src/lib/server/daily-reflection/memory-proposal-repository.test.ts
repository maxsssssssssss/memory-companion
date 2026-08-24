import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TranscriptSegment } from "@/lib/domain/types";
import { createDailyReflectionProposalAdmissionRepository } from
  "@/lib/server/memory/daily-reflection-proposal-admission";
import { openMemoryDatabase } from "@/lib/server/memory/db";
import { createMemoryRepository } from "@/lib/server/memory/repository";
import { resolveMemoryRetrievalSource } from
  "@/lib/server/retrieval/source-awareness";

import { openDailyReflectionDatabase } from "./db";
import {
  createDailyReflectionMemoryProposalRepository,
  DailyReflectionMemoryProposalBusyError
} from "./memory-proposal-repository";
import { createDailyReflectionMemoryProposalService } from
  "./memory-proposal-service";
import {
  DailyReflectionConflictError,
  DailyReflectionNotFoundError,
  createDailyReflectionRepository
} from "./repository";

const NOW = "2026-08-24T08:00:00.000Z";

function canonicalSegment(): TranscriptSegment {
  return {
    id: "segment_1",
    uploadId: "upload_1",
    startSeconds: 0,
    endSeconds: 8,
    speaker: "speaker_0",
    identity: {
      globalSpeakerId: "user_1",
      identityType: "known_user",
      confidence: 0.98,
      source: "voiceprint"
    },
    text: "我平时更喜欢安静的位置。",
    confidence: 0.96,
    sceneLabels: [],
    valueLabels: []
  };
}

function createHarness() {
  const database = openDailyReflectionDatabase({ filePath: ":memory:" });
  database.prepare(`
    INSERT INTO dr_working_cards (
      id, account_id, source_reflection_ids_json, title, content, card_kind,
      evidence_ids_json, status, importance, novelty, related_card_ids_json,
      tags_json, visibility, source_unavailable, saved_at, version,
      created_at, updated_at
    ) VALUES (
      'card_1', 'account_1', '["reflection_1"]', '长期偏好',
      '我平时更喜欢安静的位置。', 'insight', '["segment_1"]',
      'saved', 0.9, 0.8, '[]', '[]', 'private', 0, ?, 1, ?, ?
    )
  `).run(NOW, NOW, NOW);
  let workingVersion = 1;
  let workingStatus = "saved" as "saved" | "archived";
  let cardDurability = 0.9;
  let segment = canonicalSegment();
  const detail = () => ({
    card: {
      id: "card_1",
      accountId: "account_1",
      sourceReflectionIds: ["reflection_1"],
      title: "长期偏好",
      content: "我平时更喜欢安静的位置。",
      cardKind: "insight" as const,
      evidenceIds: ["segment_1"],
      status: workingStatus,
      importance: 0.9,
      novelty: 0.8,
      relatedCardIds: [],
      tags: [],
      visibility: "private" as const,
      sourceUnavailable: false,
      version: workingVersion,
      createdAt: NOW,
      updatedAt: NOW
    },
    evidence: [{
      sourceSegmentId: "segment_1",
      uploadId: "upload_1",
      effectiveOrigin: "user_reflection" as const,
      startSeconds: 0,
      endSeconds: 8,
      text: segment.text
    }]
  });
  const sourceRepository = {
    getWorkingCardWithEvidence: () => detail(),
    getWorkingCard: () => detail().card,
    getReflection: () => ({
      id: "reflection_1",
      accountId: "account_1",
      uploadId: "upload_1",
      status: "completed",
      version: 5
    }),
    getConfirmation: () => ({
      contractVersion: 2,
      id: "confirmation_1",
      reflectionId: "reflection_1",
      accountId: "account_1",
      fingerprint: "a".repeat(64),
      requestFingerprint: "b".repeat(64),
      idempotencyKey: "confirmation_1",
      operationKey: "operation_1",
      sourceOrigin: "user_reflection",
      inputMethod: "file_upload",
      processingProfile: "quick_reflection",
      inputAdapter: "file_picker",
      capturePurpose: "inspiration_capture",
      recordingDate: "2026-08-24",
      saveIntent: "recap_only",
      candidateSnapshots: [{
        contractVersion: 2,
        candidateId: "card_1",
        proposedText: "我平时更喜欢安静的位置。",
        userText: null,
        finalText: "我平时更喜欢安静的位置。",
        status: "excluded",
        candidateKind: "insight",
        candidateType: "summary",
        evidenceIds: ["segment_1"],
        sourceSegmentIds: ["segment_1"],
        evidenceSnapshots: [{
          sourceSegmentId: "segment_1",
          uploadId: "upload_1",
          startSeconds: 0,
          endSeconds: 8,
          text: segment.text,
          effectiveOrigin: "user_reflection"
        }],
        confidence: 0.9,
        caution: "用户明确表达。",
        actionClaimed: false,
        subjectPersonId: null
      }],
      createdAt: NOW
    }),
    getProcessingPlan: () => ({
      planVersion: 2,
      reflectionId: "reflection_1",
      uploadId: "upload_1",
      inputMethod: "file_upload",
      sourceOrigin: "user_reflection",
      processingProfile: "quick_reflection",
      ingestionContext: "daily_reflection",
      reviewPolicy: "required",
      inputAdapter: "file_picker",
      capturePurpose: "inspiration_capture",
      effectiveDurationMs: 120_000,
      durationSource: "server_ffprobe",
      candidateLimit: 3
    }),
    getReflectionV2Input: () => ({
      operationKey: "operation_1",
      inputAdapter: "file_picker",
      sourceOrigin: "user_reflection",
      capturePurpose: "inspiration_capture",
      recordingDate: "2026-08-24"
    }),
    readPublishedAsset: (input: { assetKind: "upload" | "segments" }) =>
      input.assetKind === "upload" ? {
        id: "upload_1",
        recordingDate: "2026-08-24",
        mimeType: "audio/wav",
        originalName: "fixture.wav",
        sizeBytes: 1024,
        status: "ready"
      } : [segment],
    listReflectionCards: () => [{
      id: "card_1",
      cardKind: "insight",
      actionClaimed: false,
      durability: cardDurability,
      epistemicStatus: "explicit_user_statement",
      riskFlags: []
    }],
    listCandidates: () => [{
      id: "card_1",
      subjectConfirmed: false,
      subjectPersonId: null
    }]
  };
  let id = 0;
  const repository = createDailyReflectionMemoryProposalRepository(database, {
    sourceRepository: sourceRepository as never,
    now: () => NOW,
    idFactory: () => `event_${++id}`
  });
  return {
    database,
    repository,
    sourceRepository,
    setWorkingVersion(value: number) {
      workingVersion = value;
    },
    setWorkingStatus(value: "saved" | "archived") {
      workingStatus = value;
    },
    setCardDurability(value: number) {
      cardDurability = value;
    },
    changeCanonicalText(value: string) {
      segment = { ...segment, text: value };
    }
  };
}

describe("Daily Reflection Memory Proposal repository", () => {
  let fixture: ReturnType<typeof createHarness>;

  beforeEach(() => {
    fixture = createHarness();
  });

  afterEach(() => {
    fixture.database.close();
  });

  it("freezes one saved Card and canonical Evidence with stable idempotency", () => {
    const created = fixture.repository.create({
      accountId: "account_1",
      cardId: "card_1",
      expectedCardVersion: 1,
      memoryType: "preference"
    });
    const replay = fixture.repository.create({
      accountId: "account_1",
      cardId: "card_1",
      expectedCardVersion: 1,
      memoryType: "preference"
    });

    expect(created.reused).toBe(false);
    expect(replay).toEqual({ proposal: created.proposal, reused: true });
    expect(created.proposal).toMatchObject({
      accountId: "account_1",
      cardId: "card_1",
      reflectionId: "reflection_1",
      status: "pending",
      evidenceIds: ["segment_1"],
      operationKey: "daily-reflection-card:card_1"
    });
    const frozen = fixture.database.prepare(`
      SELECT evidence_snapshots_json FROM dr_memory_proposals WHERE id = ?
    `).get(created.proposal.id) as { evidence_snapshots_json: string };
    expect(frozen.evidence_snapshots_json).not.toContain("我平时更喜欢");
    expect(frozen.evidence_snapshots_json).toContain("contentDigest");
    expect(fixture.repository.listEvents("account_1", created.proposal.id))
      .toHaveLength(1);
    expect(() => fixture.repository.get("account_2", created.proposal.id))
      .toThrow(DailyReflectionNotFoundError);
    expect(() => fixture.repository.create({
      accountId: "account_1",
      cardId: "card_1",
      expectedCardVersion: 1,
      memoryType: "event"
    })).toThrow(DailyReflectionConflictError);
  });

  it("revalidates the current Card and canonical Transcript before admission", () => {
    const created = fixture.repository.create({
      accountId: "account_1",
      cardId: "card_1",
      expectedCardVersion: 1,
      memoryType: "preference"
    });
    expect(fixture.repository.getAdmissionSource("account_1", created.proposal.id))
      .toMatchObject({ sourceValid: true, sourceInvalidReason: null });

    fixture.changeCanonicalText("已被篡改的文本");
    expect(fixture.repository.getAdmissionSource("account_1", created.proposal.id))
      .toMatchObject({
        sourceValid: false,
        sourceInvalidReason: "daily_reflection_memory_proposal_source_changed"
      });
  });

  it("fences Working Card mutation during admission and rejects late completion after delete", () => {
    const created = fixture.repository.create({
      accountId: "account_1",
      cardId: "card_1",
      expectedCardVersion: 1,
      memoryType: "preference"
    });
    const approved = fixture.repository.evaluate({
      accountId: "account_1",
      proposalId: created.proposal.id,
      expectedVersion: 0,
      decision: "approved",
      policyVersion: "daily_reflection_memory_proposal_policy_v1",
      score: 0.9,
      reasons: ["policy_threshold_met"]
    }).proposal;
    const claim = fixture.repository.startAdmission({
      accountId: "account_1",
      proposalId: created.proposal.id,
      leaseOwner: "worker_1",
      leaseDurationMs: 60_000,
      now: NOW
    });
    expect(() => fixture.repository.startAdmission({
      accountId: "account_1",
      proposalId: created.proposal.id,
      leaseOwner: "worker_2",
      leaseDurationMs: 60_000,
      now: NOW
    })).toThrow(DailyReflectionMemoryProposalBusyError);
    const baseRepository = createDailyReflectionRepository(fixture.database, {
      now: () => "2026-08-24T08:00:01.000Z",
      idFactory: () => "delete_event"
    });
    expect(() => baseRepository.updateWorkingCard({
      accountId: "account_1",
      cardId: "card_1",
      expectedVersion: 1,
      title: "竞态更新"
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_memory_proposal_busy"
    }));

    expect(baseRepository.markAdmissionDeleteRequested("account_1", "reflection_1"))
      .toBeNull();
    expect(fixture.repository.get("account_1", created.proposal.id)).toMatchObject({
      status: "rejected",
      reasons: ["reflection_deleted"]
    });
    expect(() => fixture.repository.completeAdmission({
      accountId: "account_1",
      proposalId: created.proposal.id,
      leaseOwner: claim.executionFence!.leaseOwner,
      attemptVersion: claim.executionFence!.attemptVersion,
      memoryId: "memory_late",
      now: NOW
    })).toThrow();
    expect(approved.status).toBe("approved");
    expect(fixture.repository.listEvents("account_1", created.proposal.id)
      .map((event) => event.event_type)).toEqual([
      "created",
      "evaluated",
      "admission_started",
      "revoked"
    ]);
  });

  it("freezes unresolved Proposal Cards and requires revocation before Card removal", () => {
    const created = fixture.repository.create({
      accountId: "account_1",
      cardId: "card_1",
      expectedCardVersion: 1,
      memoryType: "preference"
    });
    let id = 0;
    const baseRepository = createDailyReflectionRepository(fixture.database, {
      now: () => NOW,
      idFactory: () => `base_event_${++id}`
    });
    expect(() => baseRepository.updateWorkingCard({
      accountId: "account_1",
      cardId: "card_1",
      expectedVersion: 1,
      title: "不应覆盖已冻结 Proposal"
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_memory_proposal_busy"
    }));

    const approved = fixture.repository.evaluate({
      accountId: "account_1",
      proposalId: created.proposal.id,
      expectedVersion: created.proposal.version,
      decision: "approved",
      policyVersion: "daily_reflection_memory_proposal_policy_v1",
      score: 0.9,
      reasons: ["policy_threshold_met"]
    }).proposal;
    const claim = fixture.repository.startAdmission({
      accountId: "account_1",
      proposalId: created.proposal.id,
      leaseOwner: "worker_1",
      leaseDurationMs: 60_000,
      now: NOW
    });
    fixture.repository.completeAdmission({
      accountId: "account_1",
      proposalId: created.proposal.id,
      leaseOwner: claim.executionFence!.leaseOwner,
      attemptVersion: claim.executionFence!.attemptVersion,
      memoryId: "memory_1",
      now: NOW
    });
    expect(() => baseRepository.removeWorkingCard({
      accountId: "account_1",
      cardId: "card_1",
      expectedVersion: 1
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_working_card_memory_revocation_required"
    }));

    baseRepository.markAdmissionDeleteRequested("account_1", "reflection_1");
    expect(baseRepository.removeWorkingCard({
      accountId: "account_1",
      cardId: "card_1",
      expectedVersion: 1
    }).status).toBe("removed");
    expect(approved.status).toBe("approved");
  });

  it("persists one Durable Memory with exact Proposal/Card/Reflection provenance and replays idempotently", async () => {
    const memoryDatabase = openMemoryDatabase({ filePath: ":memory:" });
    try {
      const admissionRepository = createDailyReflectionProposalAdmissionRepository(
        memoryDatabase
      );
      const service = createDailyReflectionMemoryProposalService({
        proposalRepository: fixture.repository,
        admissionRepository,
        personRepository: { getConfirmedPerson: () => null } as never,
        now: () => NOW,
        leaseOwnerFactory: () => "worker_integration"
      });
      const created = service.create({
        accountId: "account_1",
        cardId: "card_1",
        expectedCardVersion: 1,
        memoryType: "preference"
      });
      const admitted = await service.admit({
        accountId: "account_1",
        proposalId: created.proposal.id,
        expectedVersion: created.proposal.version
      });
      const replayed = await service.admit({
        accountId: "account_1",
        proposalId: created.proposal.id,
        expectedVersion: admitted.proposal.version
      });

      expect(admitted.status).toBe("admitted");
      expect(replayed.status).toBe("already_exists");
      expect(replayed.memoryId).toBe(admitted.memoryId);
      expect(memoryDatabase.prepare(
        "SELECT COUNT(*) AS count FROM memory_items WHERE user_id = 'account_1'"
      ).get()).toEqual({ count: 1 });
      expect(memoryDatabase.prepare(
        "SELECT COUNT(*) AS count FROM memory_evidence"
      ).get()).toEqual({ count: 1 });
      expect(admissionRepository.getProvenance({
        userId: "account_1",
        proposalId: created.proposal.id,
        cardId: "card_1"
      })).toEqual([
        expect.objectContaining({
          reflectionId: "reflection_1",
          proposalId: created.proposal.id,
          cardId: "card_1",
          uploadId: "upload_1",
          sourceSegmentId: "segment_1"
        })
      ]);
      expect(admissionRepository.getPublication("account_1", "reflection_1"))
        .toMatchObject({ status: "published" });
      const storedMemory = createMemoryRepository(memoryDatabase)
        .getRelevantMemories({ userId: "account_1", uploadId: "upload_1" })[0]!;
      expect(resolveMemoryRetrievalSource({
        userId: "account_1",
        memory: storedMemory,
        dependencies: {
          memoryDatabase,
          sourceRepository: fixture.sourceRepository as never
        }
      })).toMatchObject({
        eligible: true,
        attribution: {
          origin: "user_reflection",
          reflectionId: "reflection_1",
          sourceSegmentIds: ["segment_1"]
        }
      });
    } finally {
      memoryDatabase.close();
    }
  });

  it("recovers when Durable Memory commits but the Proposal completion response is lost", async () => {
    const memoryDatabase = openMemoryDatabase({ filePath: ":memory:" });
    try {
      const admissionRepository = createDailyReflectionProposalAdmissionRepository(
        memoryDatabase
      );
      let failCompletion = true;
      const proposalRepository = new Proxy(fixture.repository, {
        get(target, property) {
          if (property === "completeAdmission") {
            return (...args: Parameters<typeof target.completeAdmission>) => {
              if (failCompletion) {
                failCompletion = false;
                throw new Error("simulated_response_loss_after_memory_commit");
              }
              return target.completeAdmission(...args);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
      const service = createDailyReflectionMemoryProposalService({
        proposalRepository,
        admissionRepository,
        personRepository: { getConfirmedPerson: () => null } as never,
        now: () => NOW,
        leaseOwnerFactory: () => "worker_recovery"
      });
      const created = service.create({
        accountId: "account_1",
        cardId: "card_1",
        expectedCardVersion: 1,
        memoryType: "preference"
      });
      await expect(service.admit({
        accountId: "account_1",
        proposalId: created.proposal.id,
        expectedVersion: created.proposal.version
      })).rejects.toThrow("simulated_response_loss_after_memory_commit");
      expect(fixture.repository.get("account_1", created.proposal.id).status)
        .toBe("approved");
      expect(memoryDatabase.prepare(
        "SELECT COUNT(*) AS count FROM memory_daily_reflection_candidate_receipts"
      ).get()).toEqual({ count: 1 });

      const recovered = await service.admit({
        accountId: "account_1",
        proposalId: created.proposal.id,
        expectedVersion: created.proposal.version
      });
      expect(recovered.status).toBe("already_exists");
      expect(memoryDatabase.prepare(
        "SELECT COUNT(*) AS count FROM memory_items WHERE user_id = 'account_1'"
      ).get()).toEqual({ count: 1 });
      expect(memoryDatabase.prepare(
        "SELECT COUNT(*) AS count FROM memory_evidence"
      ).get()).toEqual({ count: 1 });
      expect(fixture.repository.listEvents("account_1", created.proposal.id)
        .map((event) => event.event_type)).toContain("recovered");
    } finally {
      memoryDatabase.close();
    }
  });

  it("keeps a rejected Proposal at zero Memory, Evidence, Person, publication, and index writes", async () => {
    const memoryDatabase = openMemoryDatabase({ filePath: ":memory:" });
    try {
      fixture.setCardDurability(0.2);
      const onPublicationVisible = vi.fn();
      const service = createDailyReflectionMemoryProposalService({
        proposalRepository: fixture.repository,
        admissionRepository: createDailyReflectionProposalAdmissionRepository(memoryDatabase),
        personRepository: { getConfirmedPerson: () => null } as never,
        now: () => NOW,
        leaseOwnerFactory: () => "worker_rejected",
        onPublicationVisible
      });
      const created = service.create({
        accountId: "account_1",
        cardId: "card_1",
        expectedCardVersion: 1,
        memoryType: "preference"
      });
      const rejected = await service.admit({
        accountId: "account_1",
        proposalId: created.proposal.id,
        expectedVersion: created.proposal.version
      });
      expect(rejected.status).toBe("rejected");
      for (const table of [
        "memory_items",
        "memory_evidence",
        "memory_daily_reflection_publications",
        "memory_daily_reflection_candidate_receipts",
        "memory_daily_reflection_evidence_provenance",
        "person_evidence"
      ]) {
        expect(memoryDatabase.prepare(
          `SELECT COUNT(*) AS count FROM ${table}`
        ).get()).toEqual({ count: 0 });
      }
      expect(onPublicationVisible).not.toHaveBeenCalled();
    } finally {
      memoryDatabase.close();
    }
  });
});
