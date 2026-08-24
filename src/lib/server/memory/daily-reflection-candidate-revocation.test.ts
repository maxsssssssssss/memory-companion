// @vitest-environment node

import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import type { MemoryOwnerResolution } from "./owner-attribution/types";
import type { MemoryWriteInput } from "./types";
import {
  createDailyReflectionProposalAdmissionRepository,
  type DailyReflectionProposalAdmissionInput
} from "./daily-reflection-proposal-admission";
import {
  createDailyReflectionMemoryCandidateRevocationRepository,
  dailyReflectionCandidateRevocationPayloadDigest
} from "./daily-reflection-candidate-revocation";
import { openMemoryDatabase } from "./db";

const NOW = "2026-08-24T08:00:00.000Z";

let database: Database.Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

function memoryFixture(input: {
  cardId: string;
  segmentId: string;
  text: string;
}): MemoryWriteInput {
  return {
    id: `memory_${input.cardId}`,
    type: "event",
    title: `Card ${input.cardId}`,
    summary: input.text,
    importance: 0.72,
    date: "2026-08-24",
    createdAt: NOW,
    updatedAt: NOW,
    evidence: [{
      id: `evidence_${input.cardId}`,
      sourceType: "transcript",
      sourceId: input.segmentId,
      uploadId: "upload_1",
      date: "2026-08-24",
      quote: input.text,
      createdAt: NOW
    }]
  };
}

function ownerFixture(memory: MemoryWriteInput): MemoryOwnerResolution {
  return {
    version: 1,
    memoryId: memory.id,
    memoryType: memory.type,
    scope: "unknown",
    owner: { type: "unknown", confidence: 0, source: "unknown" },
    participants: [],
    evidenceSegmentIds: memory.evidence.map((evidence) => evidence.sourceId),
    observations: [],
    reasons: ["owner_not_applicable"]
  };
}

function admissionFixture(input: {
  cardId?: string;
  proposalId?: string;
  segmentId?: string;
  text?: string;
  sourceSegments?: DailyReflectionProposalAdmissionInput["sourceSegments"];
} = {}): DailyReflectionProposalAdmissionInput {
  const cardId = input.cardId ?? "card_1";
  const proposalId = input.proposalId ?? "proposal_1";
  const segmentId = input.segmentId ?? "segment_1";
  const text = input.text ?? "我确认下周完成项目复盘。";
  const memory = memoryFixture({ cardId, segmentId, text });
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
    operationKey: `daily-reflection-card:${cardId}`,
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
    now: NOW
  };
}

function revokeInput(input: {
  cardId: string;
  proposalId: string;
  id?: string;
}) {
  const operationKey = `daily-reflection-card-revocation:${input.cardId}`;
  return {
    id: input.id ?? `revocation_${input.cardId}`,
    userId: "user_1",
    reflectionId: "reflection_1",
    confirmationId: input.proposalId,
    candidateId: input.cardId,
    operationKey,
    payloadDigest: dailyReflectionCandidateRevocationPayloadDigest({
      userId: "user_1",
      reflectionId: "reflection_1",
      confirmationId: input.proposalId,
      candidateId: input.cardId,
      operationKey
    }),
    now: "2026-08-24T09:00:00.000Z"
  };
}

describe("Daily Reflection Working Card authority revocation", () => {
  it("finds and revokes an unpublished legacy authority without a DR Proposal lookup", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const admission = createDailyReflectionProposalAdmissionRepository(database);
    const input = admissionFixture({
      cardId: "legacy_card",
      proposalId: "legacy_confirmation"
    });
    expect(admission.applyProposal(input).status).toBe("admitted");
    const repository = createDailyReflectionMemoryCandidateRevocationRepository(database);

    expect(repository.findActiveAuthority("user_1", "legacy_card")).toEqual({
      reflectionId: "reflection_1",
      confirmationId: "legacy_confirmation",
      candidateId: "legacy_card",
      currentMemoryId: "memory_legacy_card",
      publicationStatus: "unpublished"
    });
    expect(repository.findActiveAuthority("other_user", "legacy_card")).toBeNull();

    const revoked = repository.apply(revokeInput({
      cardId: "legacy_card",
      proposalId: "legacy_confirmation"
    }));
    expect(revoked).toMatchObject({
      outcome: "revoked",
      historicalMemoryId: "memory_legacy_card",
      removedMemoryEvidenceCount: 1,
      reused: false
    });
    expect(repository.findActiveAuthority("user_1", "legacy_card")).toBeNull();
    expect(database.prepare(`
      SELECT status FROM memory_daily_reflection_publications
      WHERE user_id = 'user_1' AND reflection_id = 'reflection_1'
    `).get()).toEqual({ status: "unpublished" });
  });

  it("replays the same authority revocation without duplicate writes", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    createDailyReflectionProposalAdmissionRepository(database)
      .applyProposal(admissionFixture());
    const repository = createDailyReflectionMemoryCandidateRevocationRepository(database);
    const input = revokeInput({ cardId: "card_1", proposalId: "proposal_1" });

    const first = repository.apply(input);
    const replay = repository.apply(input);
    expect(first).toMatchObject({ outcome: "revoked", reused: false });
    expect(replay).toEqual({ ...first, reused: true });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM memory_daily_reflection_candidate_revocations
    `).get()).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM memory_daily_reflection_candidate_payloads
    `).get()).toEqual({ count: 0 });
  });

  it("keeps another Card's active Memory and Evidence when one source is revoked", () => {
    database = openMemoryDatabase({ filePath: ":memory:" });
    const admission = createDailyReflectionProposalAdmissionRepository(database);
    const first = admissionFixture();
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
    const second = admissionFixture({
      cardId: "card_2",
      proposalId: "proposal_2",
      segmentId: secondSegment.id,
      text: secondSegment.text,
      sourceSegments: [...first.sourceSegments, secondSegment]
    });
    admission.applyProposal(first);
    admission.applyProposal(second);
    admission.markPublished({
      userId: "user_1",
      reflectionId: "reflection_1",
      now: "2026-08-24T08:30:00.000Z"
    });
    const repository = createDailyReflectionMemoryCandidateRevocationRepository(database);
    expect(repository.findActiveAuthority("user_1", "card_1")).not.toBeNull();
    expect(repository.findActiveAuthority("user_1", "card_2")).not.toBeNull();

    repository.apply(revokeInput({ cardId: "card_2", proposalId: "proposal_2" }));

    expect(repository.findActiveAuthority("user_1", "card_2")).toBeNull();
    expect(repository.findActiveAuthority("user_1", "card_1")).toMatchObject({
      confirmationId: "proposal_1",
      currentMemoryId: "memory_card_1",
      publicationStatus: "published"
    });
    expect(database.prepare(`
      SELECT candidate_id, status FROM memory_daily_reflection_candidate_current_memories
      ORDER BY candidate_id
    `).all()).toEqual([
      { candidate_id: "card_1", status: "active" },
      { candidate_id: "card_2", status: "revoked" }
    ]);
    expect(database.prepare(`
      SELECT id, source_id, memory_id FROM memory_evidence ORDER BY id
    `).all()).toEqual([{
      id: "evidence_card_1",
      source_id: "segment_1",
      memory_id: "memory_card_1"
    }]);
    expect(database.prepare(`
      SELECT candidate_id FROM memory_daily_reflection_candidate_payloads
      ORDER BY candidate_id
    `).all()).toEqual([{ candidate_id: "card_1" }]);
  });
});
