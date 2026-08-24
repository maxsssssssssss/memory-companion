// @vitest-environment node

import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";

import { openMemoryDatabase } from "./db";
import {
  createDailyReflectionProposalAdmissionRepository,
  DailyReflectionProposalAdmissionError,
  type DailyReflectionProposalAdmissionInput
} from "./daily-reflection-proposal-admission";
import {
  createDailyReflectionMemoryCandidateRevocationRepository,
  dailyReflectionCandidateRevocationPayloadDigest
} from "./daily-reflection-candidate-revocation";
import { createMemoryRepository } from "./repository";
import type { MemoryOwnerResolution } from "./owner-attribution/types";
import type { MemoryWriteInput } from "./types";

let database: Database.Database | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  database?.close();
  database = undefined;
});

function memoryFixture(input: {
  cardId: string;
  segmentId: string;
  text: string;
  type?: MemoryWriteInput["type"];
}): MemoryWriteInput {
  return {
    id: `memory_${input.cardId}`,
    type: input.type ?? "event",
    title: `Card ${input.cardId}`,
    summary: input.text,
    importance: 0.72,
    date: "2026-08-24",
    createdAt: "2026-08-24T08:00:00.000Z",
    updatedAt: "2026-08-24T08:00:00.000Z",
    evidence: [{
      id: `evidence_${input.cardId}`,
      sourceType: "transcript",
      sourceId: input.segmentId,
      uploadId: "upload_1",
      date: "2026-08-24",
      quote: input.text,
      createdAt: "2026-08-24T08:00:00.000Z"
    }]
  };
}

function ownerFixture(memory: MemoryWriteInput): MemoryOwnerResolution {
  return {
    version: 1,
    memoryId: memory.id,
    memoryType: memory.type,
    scope: "unknown",
    owner: {
      type: "unknown",
      confidence: 0,
      source: "unknown"
    },
    participants: [],
    evidenceSegmentIds: memory.evidence.map((evidence) => evidence.sourceId),
    observations: [],
    reasons: ["owner_not_applicable"]
  };
}

function inputFixture(input: {
  cardId?: string;
  proposalId?: string;
  operationKey?: string;
  segmentId?: string;
  text?: string;
  type?: MemoryWriteInput["type"];
  sourceSegments?: DailyReflectionProposalAdmissionInput["sourceSegments"];
} = {}): DailyReflectionProposalAdmissionInput {
  const cardId = input.cardId ?? "card_1";
  const proposalId = input.proposalId ?? "proposal_1";
  const segmentId = input.segmentId ?? "segment_1";
  const text = input.text ?? "我确认下周完成项目复盘。";
  const memory = memoryFixture({ cardId, segmentId, text, type: input.type });
  const sourceOrigin = "user_reflection" as const;
  const contentDigest = createHash("sha256").update(JSON.stringify({
    version: 1,
    accountId: "user_1",
    reflectionId: "reflection_1",
    uploadId: "upload_1",
    sourceSegmentId: segmentId,
    quote: text,
    sourceOrigin
  })).digest("hex");
  return {
    userId: "user_1",
    reflectionId: "reflection_1",
    proposalId,
    cardId,
    operationKey: input.operationKey ?? `daily-reflection-card:${cardId}`,
    payloadDigest: `payload_${cardId}`,
    publicationId: "publication_1",
    publicationFingerprint: "fingerprint_1",
    publicationDigest: "publication_digest_1",
    uploadId: "upload_1",
    sourceOrigin,
    inputAdapter: "file_picker",
    capturePurpose: "inspiration_capture",
    recordingDate: "2026-08-24",
    memory,
    ownerAttribution: ownerFixture(memory),
    evidenceDigests: [{
      memoryEvidenceId: `evidence_${cardId}`,
      sourceSegmentId: segmentId,
      contentDigest
    }],
    sourceSegments: input.sourceSegments ?? [{
      id: segmentId,
      uploadId: "upload_1",
      startSeconds: 0,
      endSeconds: 10,
      speaker: "speaker_1",
      text,
      confidence: 0.95,
      sceneLabels: [],
      valueLabels: []
    }],
    now: "2026-08-24T08:00:00.000Z"
  };
}

function errorCode(error: unknown) {
  expect(error).toBeInstanceOf(DailyReflectionProposalAdmissionError);
  return (error as DailyReflectionProposalAdmissionError).code;
}

describe("daily reflection Working Card proposal admission", () => {
  it("preserves two incremental cards from the same reflection and upload", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createDailyReflectionProposalAdmissionRepository(database);
    const first = inputFixture();
    const secondSegment = {
      id: "segment_2",
      uploadId: "upload_1",
      startSeconds: 10,
      endSeconds: 20,
      speaker: "speaker_1",
      text: "我还需要整理项目风险清单。",
      confidence: 0.94,
      sceneLabels: [],
      valueLabels: []
    };
    const second = inputFixture({
      cardId: "card_2",
      proposalId: "proposal_2",
      segmentId: "segment_2",
      text: secondSegment.text,
      type: "question",
      sourceSegments: [...first.sourceSegments, secondSegment]
    });

    expect(repository.applyProposal(first).status).toBe("admitted");
    expect(repository.applyProposal(second).status).toBe("admitted");

    expect(database.prepare(`
      SELECT candidate_id, confirmation_id, status
      FROM memory_daily_reflection_candidate_current_memories
      ORDER BY candidate_id
    `).all()).toEqual([
      { candidate_id: "card_1", confirmation_id: "proposal_1", status: "active" },
      { candidate_id: "card_2", confirmation_id: "proposal_2", status: "active" }
    ]);
    expect(database.prepare(`
      SELECT candidate_id, confirmation_id
      FROM memory_daily_reflection_candidate_payloads ORDER BY candidate_id
    `).all()).toEqual([
      { candidate_id: "card_1", confirmation_id: "proposal_1" },
      { candidate_id: "card_2", confirmation_id: "proposal_2" }
    ]);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM memory_evidence WHERE upload_id = 'upload_1'"
    ).get()).toEqual({ count: 2 });
  });

  it("revokes a later Card by its own Proposal authority without touching earlier Cards", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const admission = createDailyReflectionProposalAdmissionRepository(database);
    const first = inputFixture();
    const secondSegment = {
      id: "segment_2",
      uploadId: "upload_1",
      startSeconds: 10,
      endSeconds: 20,
      speaker: "speaker_1",
      text: "我还需要整理项目风险清单。",
      confidence: 0.94,
      sceneLabels: [],
      valueLabels: []
    };
    admission.applyProposal(first);
    admission.applyProposal(inputFixture({
      cardId: "card_2",
      proposalId: "proposal_2",
      segmentId: secondSegment.id,
      text: secondSegment.text,
      type: "question",
      sourceSegments: [...first.sourceSegments, secondSegment]
    }));
    admission.markPublished({
      userId: "user_1",
      reflectionId: "reflection_1",
      now: "2026-08-24T09:00:00.000Z"
    });

    const revocation = createDailyReflectionMemoryCandidateRevocationRepository(database);
    const operationKey = "daily-reflection-card-revocation:card_2";
    const wrongPayloadDigest = dailyReflectionCandidateRevocationPayloadDigest({
      userId: "user_1",
      reflectionId: "reflection_1",
      confirmationId: "proposal_1",
      candidateId: "card_2",
      operationKey
    });
    expect(() => revocation.apply({
      id: "revocation_wrong",
      userId: "user_1",
      reflectionId: "reflection_1",
      confirmationId: "proposal_1",
      candidateId: "card_2",
      operationKey,
      payloadDigest: wrongPayloadDigest,
      now: "2026-08-24T09:01:00.000Z"
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_candidate_revocation_payload_missing"
    }));

    const payloadDigest = dailyReflectionCandidateRevocationPayloadDigest({
      userId: "user_1",
      reflectionId: "reflection_1",
      confirmationId: "proposal_2",
      candidateId: "card_2",
      operationKey
    });
    expect(revocation.apply({
      id: "revocation_card_2",
      userId: "user_1",
      reflectionId: "reflection_1",
      confirmationId: "proposal_2",
      candidateId: "card_2",
      operationKey,
      payloadDigest,
      now: "2026-08-24T09:02:00.000Z"
    })).toMatchObject({ outcome: "revoked", reused: false });
    expect(database.prepare(`
      SELECT candidate_id, status FROM memory_daily_reflection_candidate_current_memories
      ORDER BY candidate_id
    `).all()).toEqual([
      { candidate_id: "card_1", status: "active" },
      { candidate_id: "card_2", status: "revoked" }
    ]);
  });

  it("replays the same operation without a second Memory replacement or duplicate rows", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const memoryRepository = createMemoryRepository(database);
    const replace = vi.spyOn(memoryRepository, "replaceUploadMemories");
    const repository = createDailyReflectionProposalAdmissionRepository(database, {
      memoryRepository
    });
    const input = inputFixture();

    const created = repository.applyProposal(input);
    const replayed = repository.applyProposal(input);

    expect(replayed).toMatchObject({
      status: "already_exists",
      memoryId: created.memoryId,
      proposalId: "proposal_1",
      cardId: "card_1"
    });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM memory_daily_reflection_candidate_receipts"
    ).get()).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM memory_daily_reflection_evidence_provenance"
    ).get()).toEqual({ count: 1 });
  });

  it("fails closed when an operation is replayed with a different payload", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createDailyReflectionProposalAdmissionRepository(database);
    const input = inputFixture();
    repository.applyProposal(input);

    expect(() => repository.applyProposal({
      ...input,
      payloadDigest: "changed_payload",
      memory: { ...input.memory, title: "Changed title" }
    })).toThrowError(DailyReflectionProposalAdmissionError);
    try {
      repository.applyProposal({ ...input, payloadDigest: "changed_payload" });
    } catch (error) {
      expect(errorCode(error)).toBe("daily_reflection_proposal_conflict");
    }
  });

  it("keeps operation recovery and provenance account scoped", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createDailyReflectionProposalAdmissionRepository(database);
    repository.applyProposal(inputFixture());

    expect(repository.findByOperationKey({
      userId: "user_1",
      operationKey: "daily-reflection-card:card_1"
    })).toMatchObject({ cardId: "card_1", proposalId: "proposal_1" });
    expect(repository.findByOperationKey({
      userId: "user_2",
      operationKey: "daily-reflection-card:card_1"
    })).toBeNull();
    expect(repository.getProvenance({
      userId: "user_2",
      proposalId: "proposal_1",
      cardId: "card_1"
    })).toEqual([]);
  });

  it("rejects an upload tombstone before creating publication or Memory rows", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    database.prepare(`
      INSERT INTO memory_upload_tombstones (user_id, upload_id, reason, deleted_at)
      VALUES ('user_1', 'upload_1', 'upload_deleted', '2026-08-24T07:00:00.000Z')
    `).run();
    const repository = createDailyReflectionProposalAdmissionRepository(database);

    try {
      repository.applyProposal(inputFixture());
      throw new Error("expected tombstone rejection");
    } catch (error) {
      expect(errorCode(error)).toBe("daily_reflection_proposal_upload_deleted");
    }
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM memory_daily_reflection_publications"
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM memory_items"
    ).get()).toEqual({ count: 0 });
  });

  it("requires proposal provenance to exactly cover every transcript Evidence row", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createDailyReflectionProposalAdmissionRepository(database);
    const input = inputFixture();
    const extraSegment = {
      id: "segment_extra",
      uploadId: "upload_1",
      startSeconds: 10,
      endSeconds: 20,
      text: "额外但未声明 provenance 的片段。",
      confidence: 0.9,
      sceneLabels: [],
      valueLabels: []
    };
    expect(() => repository.applyProposal({
      ...input,
      memory: {
        ...input.memory,
        evidence: [...input.memory.evidence, {
          id: "evidence_extra",
          sourceType: "transcript",
          sourceId: extraSegment.id,
          uploadId: "upload_1",
          date: "2026-08-24",
          quote: extraSegment.text,
          createdAt: input.now
        }]
      },
      sourceSegments: [...input.sourceSegments, extraSegment]
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_proposal_evidence_missing"
    }));
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM memory_items"
    ).get()).toEqual({ count: 0 });
  });

  it("recomputes the canonical quote digest and requires the stable Card operation key", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createDailyReflectionProposalAdmissionRepository(database);
    const input = inputFixture();
    expect(() => repository.applyProposal({
      ...input,
      evidenceDigests: [{
        ...input.evidenceDigests[0]!,
        contentDigest: "f".repeat(64)
      }]
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_proposal_evidence_missing"
    }));
    expect(() => repository.applyProposal({
      ...input,
      operationKey: "unscoped-operation"
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_proposal_conflict"
    }));
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM memory_items"
    ).get()).toEqual({ count: 0 });
  });

  it("restricts owner attribution Evidence to this Memory's exact source set", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createDailyReflectionProposalAdmissionRepository(database);
    const input = inputFixture();
    const unrelatedSegment = {
      id: "segment_unrelated",
      uploadId: "upload_1",
      startSeconds: 10,
      endSeconds: 20,
      text: "同一录音里的无关人物片段。",
      confidence: 0.9,
      sceneLabels: [],
      valueLabels: []
    };
    expect(() => repository.applyProposal({
      ...input,
      ownerAttribution: {
        ...input.ownerAttribution,
        evidenceSegmentIds: [unrelatedSegment.id]
      },
      sourceSegments: [...input.sourceSegments, unrelatedSegment]
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_proposal_conflict"
    }));
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM memory_items"
    ).get()).toEqual({ count: 0 });
  });

  it("fails recovery closed when a tombstone appears after an admitted receipt", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createDailyReflectionProposalAdmissionRepository(database);
    repository.applyProposal(inputFixture());
    database.prepare(`
      INSERT INTO memory_upload_tombstones (user_id, upload_id, reason, deleted_at)
      VALUES ('user_1', 'upload_1', 'upload_deleted', '2026-08-24T09:00:00.000Z')
    `).run();

    expect(repository.findByOperationKey({
      userId: "user_1",
      operationKey: "daily-reflection-card:card_1"
    })).toBeNull();
  });

  it("stores exact proposal/card provenance only after canonical Memory Evidence exists", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createDailyReflectionProposalAdmissionRepository(database);
    const result = repository.applyProposal(inputFixture());

    expect(repository.getProvenance({
      userId: "user_1",
      proposalId: "proposal_1",
      cardId: "card_1"
    })).toEqual([{
      memoryEvidenceId: "evidence_card_1",
      userId: "user_1",
      publicationId: "publication_1",
      reflectionId: "reflection_1",
      proposalId: "proposal_1",
      cardId: "card_1",
      uploadId: "upload_1",
      sourceSegmentId: "segment_1",
      sourceOrigin: "user_reflection",
      contentDigest: inputFixture().evidenceDigests[0]!.contentDigest,
      createdAt: "2026-08-24T08:00:00.000Z"
    }]);
    expect(database.prepare(`
      SELECT current_memory_id FROM memory_daily_reflection_candidate_current_memories
      WHERE user_id = 'user_1' AND confirmation_id = 'proposal_1'
        AND candidate_id = 'card_1'
    `).get()).toEqual({ current_memory_id: result.memoryId });
  });

  it("rejects Person or subject inputs without creating Person writes", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createDailyReflectionProposalAdmissionRepository(database);

    expect(() => repository.applyProposal({
      ...inputFixture(),
      subjectPersonId: "person_1"
    })).toThrowError(DailyReflectionProposalAdmissionError);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM memory_daily_reflection_candidate_person_sources"
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM person_subject_admissions"
    ).get()).toEqual({ count: 0 });
  });

  it("allows publishing once and keeps markPublished idempotent", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const repository = createDailyReflectionProposalAdmissionRepository(database);
    repository.applyProposal(inputFixture());

    expect(repository.markPublished({
      userId: "user_1",
      reflectionId: "reflection_1",
      now: "2026-08-24T09:00:00.000Z"
    })?.status).toBe("published");
    expect(repository.markPublished({
      userId: "user_1",
      reflectionId: "reflection_1",
      now: "2026-08-24T10:00:00.000Z"
    })?.status).toBe("published");
  });
});
