// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { openDailyReflectionDatabase } from "./db";
import { createDailyReflectionMemoryProposalRepository } from
  "./memory-proposal-repository";
import {
  DailyReflectionConflictError,
  DailyReflectionNotFoundError,
  createDailyReflectionRepository
} from "./repository";
import { createDailyReflectionWorkingCardMemoryRevocationRepository } from
  "./working-card-memory-revocation-repository";

const NOW = "2026-08-24T08:00:00.000Z";
const LATER = "2026-08-24T08:02:00.000Z";

let database: Database.Database | undefined;

afterEach(() => {
  database?.close();
  database = undefined;
});

function insertCard(input: {
  id?: string;
  accountId?: string;
  reflectionId?: string;
  status?: "saved" | "archived";
  lifecycleStatus?: "not_admitted" | "active" | "revocation_requested" | "revoked";
  lifecycleVersion?: number;
} = {}) {
  const id = input.id ?? "card_1";
  const accountId = input.accountId ?? "account_1";
  const reflectionId = input.reflectionId ?? "reflection_1";
  const status = input.status ?? "saved";
  const lifecycleStatus = input.lifecycleStatus ?? "not_admitted";
  const lifecycleVersion = input.lifecycleVersion ?? 0;
  database!.prepare(`
    INSERT INTO dr_working_cards (
      id, account_id, source_reflection_ids_json, title, content, card_kind,
      evidence_ids_json, status, importance, novelty, related_card_ids_json,
      tags_json, visibility, source_unavailable, saved_at,
      memory_lifecycle_status, memory_lifecycle_version,
      memory_lifecycle_updated_at, version, created_at, updated_at
    ) VALUES (
      ?, ?, ?, '长期偏好', '我平时更喜欢安静的位置。', 'insight',
      '["segment_1"]', ?, 0.9, 0.8, '[]', '[]', 'private', 0, ?,
      ?, ?, ?, 1, ?, ?
    )
  `).run(
    id,
    accountId,
    JSON.stringify([reflectionId]),
    status,
    NOW,
    lifecycleStatus,
    lifecycleVersion,
    lifecycleVersion === 0 ? null : NOW,
    NOW,
    NOW
  );
}

function insertProposal(input: {
  id?: string;
  accountId?: string;
  cardId?: string;
  reflectionId?: string;
  status?: "pending" | "approved" | "rejected" | "admitted";
  memoryId?: string | null;
  leaseOwner?: string | null;
  leaseUntil?: string | null;
  attemptVersion?: number;
} = {}) {
  const id = input.id ?? "proposal_1";
  const accountId = input.accountId ?? "account_1";
  const cardId = input.cardId ?? "card_1";
  const reflectionId = input.reflectionId ?? "reflection_1";
  const status = input.status ?? "pending";
  const memoryId = status === "admitted"
    ? (input.memoryId ?? "memory_1")
    : null;
  const admittedAt = status === "admitted" ? NOW : null;
  const reasons = status === "rejected" ? ["fixture_rejected"] : [];
  database!.prepare(`
    INSERT INTO dr_memory_proposals (
      id, account_id, card_id, reflection_id, title, card_kind,
      action_claimed, memory_type, content, evidence_ids_json,
      evidence_snapshots_json, risk_flags_json, subject_person_id,
      importance, durability, novelty, sensitivity, epistemic_status,
      epistemic_caution, status, policy_version, score, reasons_json,
      operation_key, request_fingerprint, memory_id, source_origin,
      input_adapter, capture_purpose, recording_date, created_by,
      admission_method, card_version, version, lease_owner, lease_until,
      attempt_version, error_code, created_at, updated_at, admitted_at
    ) VALUES (
      @id, @accountId, @cardId, @reflectionId, '长期偏好', 'insight',
      0, 'preference', '我平时更喜欢安静的位置。', '["segment_1"]',
      '[{"sourceSegmentId":"segment_1","uploadId":"upload_1","startSeconds":0,"endSeconds":8,"effectiveOrigin":"user_reflection","contentDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]',
      '[]', NULL, 0.9, 0.9, 0.8, 0.1, 'explicit_user_statement',
      NULL, @status, 'fixture_policy_v1', 0.9, @reasons,
      @operationKey, @requestFingerprint, @memoryId, 'user_reflection',
      'file_picker', 'inspiration_capture', '2026-08-24', 'user',
      'daily_reflection_memory_proposal_v1', 1, 1, @leaseOwner, @leaseUntil,
      @attemptVersion, NULL, @createdAt, @updatedAt, @admittedAt
    )
  `).run({
    id,
    accountId,
    cardId,
    reflectionId,
    status,
    reasons: JSON.stringify(reasons),
    operationKey: `daily-reflection-card:${cardId}`,
    requestFingerprint: "b".repeat(64),
    memoryId,
    leaseOwner: input.leaseOwner ?? null,
    leaseUntil: input.leaseUntil ?? null,
    attemptVersion: input.attemptVersion ?? 0,
    createdAt: NOW,
    updatedAt: NOW,
    admittedAt
  });
  return id;
}

function createRepository(now = NOW) {
  let event = 0;
  return createDailyReflectionWorkingCardMemoryRevocationRepository(database!, {
    now: () => now,
    idFactory: () => `revocation_event_${++event}`
  });
}

function noMemoryResult() {
  return {
    outcome: "no_long_term_object" as const,
    historicalMemoryId: null,
    removedMemoryEvidenceCount: 0,
    removedPersonSourceCount: 0
  };
}

describe("Daily Reflection Working Card Memory revocation repository", () => {
  it("revokes a Card with no Durable Memory and replays one immutable receipt", () => {
    database = openDailyReflectionDatabase({ filePath: ":memory:" });
    insertCard();
    const proposalId = insertProposal();
    const repository = createRepository();

    const prepared = repository.prepare({
      accountId: "account_1",
      cardId: "card_1",
      expectedMemoryLifecycleVersion: 0,
      idempotencyKey: "revoke_card_1",
      authority: null
    });
    expect(prepared).toMatchObject({
      reused: false,
      receipt: null,
      card: { memoryLifecycleStatus: "revocation_requested", memoryLifecycleVersion: 1 },
      operation: { proposalId, status: "ready", authorityMemoryId: null }
    });

    const claimed = repository.start({
      accountId: "account_1",
      cardId: "card_1",
      leaseOwner: "worker_1",
      leaseDurationMs: 60_000,
      now: NOW
    });
    const completed = repository.complete({
      accountId: "account_1",
      cardId: "card_1",
      leaseOwner: claimed.executionFence!.leaseOwner,
      attemptVersion: claimed.executionFence!.attemptVersion,
      result: noMemoryResult(),
      indexRefreshRequired: true,
      now: NOW
    });
    expect(completed).toMatchObject({
      reused: false,
      card: { memoryLifecycleStatus: "revoked", memoryLifecycleVersion: 2 },
      receipt: { outcome: "no_long_term_object", historicalMemoryId: null },
      operation: { status: "completed", indexRefreshStatus: "not_required" }
    });
    expect(database.prepare(
      "SELECT status, reasons_json FROM dr_memory_proposals WHERE id = ?"
    ).get(proposalId)).toEqual({ status: "rejected", reasons_json: '["card_revoked"]' });
    expect(database.prepare(`
      SELECT event_type FROM dr_memory_proposal_events WHERE proposal_id = ?
    `).all(proposalId)).toEqual([{ event_type: "revoked" }]);

    const replay = repository.prepare({
      accountId: "account_1",
      cardId: "card_1",
      expectedMemoryLifecycleVersion: 0,
      idempotencyKey: "revoke_card_1",
      authority: null
    });
    expect(replay).toMatchObject({
      reused: true,
      receipt: { outcome: "no_long_term_object" },
      operation: { status: "completed" }
    });
    expect(repository.complete({
      accountId: "account_1",
      cardId: "card_1",
      leaseOwner: "stale_worker",
      attemptVersion: 99,
      result: noMemoryResult(),
      indexRefreshRequired: false,
      now: NOW
    })).toMatchObject({ reused: true, receipt: completed.receipt });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM dr_working_card_memory_revocation_receipts"
    ).get()).toEqual({ count: 1 });
  });

  it("freezes admitted and legacy Memory authority, including unpublished authority", () => {
    database = openDailyReflectionDatabase({ filePath: ":memory:" });
    insertCard({ lifecycleStatus: "active", lifecycleVersion: 1 });
    const proposalId = insertProposal({ status: "admitted", memoryId: "memory_1" });
    insertCard({
      id: "legacy_card",
      reflectionId: "legacy_reflection",
      lifecycleStatus: "active",
      lifecycleVersion: 1
    });
    const repository = createRepository();

    const admitted = repository.prepare({
      accountId: "account_1",
      cardId: "card_1",
      expectedMemoryLifecycleVersion: 1,
      idempotencyKey: "revoke_admitted",
      authority: {
        reflectionId: "reflection_1",
        confirmationId: proposalId,
        candidateId: "card_1",
        currentMemoryId: "memory_1",
        publicationStatus: "unpublished"
      }
    });
    expect(admitted.operation).toMatchObject({
      proposalId,
      authorityConfirmationId: proposalId,
      authorityMemoryId: "memory_1"
    });

    const legacy = repository.prepare({
      accountId: "account_1",
      cardId: "legacy_card",
      expectedMemoryLifecycleVersion: 1,
      idempotencyKey: "revoke_legacy",
      authority: {
        reflectionId: "legacy_reflection",
        confirmationId: "legacy_confirmation",
        candidateId: "legacy_card",
        currentMemoryId: "legacy_memory",
        publicationStatus: "published"
      }
    });
    expect(legacy.operation).toMatchObject({
      proposalId: null,
      reflectionId: "legacy_reflection",
      authorityConfirmationId: "legacy_confirmation",
      authorityMemoryId: "legacy_memory"
    });
  });

  it("fails closed across accounts and on conflicting replay payloads", () => {
    database = openDailyReflectionDatabase({ filePath: ":memory:" });
    insertCard();
    const repository = createRepository();
    repository.prepare({
      accountId: "account_1",
      cardId: "card_1",
      expectedMemoryLifecycleVersion: 0,
      idempotencyKey: "revoke_card_1",
      authority: null
    });

    expect(repository.get("account_2", "card_1")).toBeNull();
    expect(() => repository.prepare({
      accountId: "account_2",
      cardId: "card_1",
      expectedMemoryLifecycleVersion: 0,
      idempotencyKey: "revoke_card_1",
      authority: null
    })).toThrow(DailyReflectionNotFoundError);
    expect(() => repository.prepare({
      accountId: "account_1",
      cardId: "card_1",
      expectedMemoryLifecycleVersion: 0,
      idempotencyKey: "different_key",
      authority: null
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_card_memory_revocation_idempotency_conflict"
    }));
    expect(() => repository.prepare({
      accountId: "account_1",
      cardId: "card_1",
      expectedMemoryLifecycleVersion: 1,
      idempotencyKey: "revoke_card_1",
      authority: null
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_card_memory_revocation_idempotency_conflict"
    }));
  });

  it("fences concurrent workers and rejects a stale lease after takeover", () => {
    database = openDailyReflectionDatabase({ filePath: ":memory:" });
    insertCard();
    const repository = createRepository();
    repository.prepare({
      accountId: "account_1",
      cardId: "card_1",
      expectedMemoryLifecycleVersion: 0,
      idempotencyKey: "revoke_card_1",
      authority: null
    });
    const first = repository.start({
      accountId: "account_1",
      cardId: "card_1",
      leaseOwner: "worker_1",
      leaseDurationMs: 60_000,
      now: NOW
    });
    expect(() => repository.start({
      accountId: "account_1",
      cardId: "card_1",
      leaseOwner: "worker_2",
      leaseDurationMs: 60_000,
      now: NOW
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_card_memory_revocation_busy"
    }));

    const second = repository.start({
      accountId: "account_1",
      cardId: "card_1",
      leaseOwner: "worker_2",
      leaseDurationMs: 60_000,
      now: LATER
    });
    expect(second.executionFence!.attemptVersion).toBe(2);
    expect(() => repository.complete({
      accountId: "account_1",
      cardId: "card_1",
      leaseOwner: first.executionFence!.leaseOwner,
      attemptVersion: first.executionFence!.attemptVersion,
      result: noMemoryResult(),
      indexRefreshRequired: false,
      now: LATER
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_card_memory_revocation_lease_lost"
    }));
    expect(repository.complete({
      accountId: "account_1",
      cardId: "card_1",
      leaseOwner: second.executionFence!.leaseOwner,
      attemptVersion: second.executionFence!.attemptVersion,
      result: noMemoryResult(),
      indexRefreshRequired: false,
      now: LATER
    })).toMatchObject({ receipt: { outcome: "no_long_term_object" } });
  });

  it("makes Card revocation win the admission fence", () => {
    database = openDailyReflectionDatabase({ filePath: ":memory:" });
    insertCard();
    const proposalId = insertProposal({ status: "approved" });
    const repository = createRepository();
    repository.prepare({
      accountId: "account_1",
      cardId: "card_1",
      expectedMemoryLifecycleVersion: 0,
      idempotencyKey: "revoke_card_1",
      authority: null
    });

    const proposalRepository = createDailyReflectionMemoryProposalRepository(database!);
    expect(() => proposalRepository.startAdmission({
      accountId: "account_1",
      proposalId,
      leaseOwner: "admission_worker",
      leaseDurationMs: 60_000,
      now: NOW
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_card_memory_revocation_requested"
    }));
  });

  it("refuses to start revocation while an admission lease is active", () => {
    database = openDailyReflectionDatabase({ filePath: ":memory:" });
    insertCard();
    insertProposal({
      status: "approved",
      leaseOwner: "admission_worker",
      leaseUntil: "2026-08-24T08:01:00.000Z",
      attemptVersion: 1
    });
    const repository = createRepository();

    expect(() => repository.prepare({
      accountId: "account_1",
      cardId: "card_1",
      expectedMemoryLifecycleVersion: 0,
      idempotencyKey: "revoke_card_1",
      authority: null
    })).toThrowError(expect.objectContaining({
      code: "daily_reflection_memory_proposal_busy"
    }));
    expect(repository.get("account_1", "card_1")).toBeNull();
  });

  it("prevents a late completion from resurrecting a tombstoned Reflection", () => {
    database = openDailyReflectionDatabase({ filePath: ":memory:" });
    insertCard({ lifecycleStatus: "active", lifecycleVersion: 1 });
    const repository = createRepository();
    repository.prepare({
      accountId: "account_1",
      cardId: "card_1",
      expectedMemoryLifecycleVersion: 1,
      idempotencyKey: "revoke_card_1",
      authority: null
    });
    const claimed = repository.start({
      accountId: "account_1",
      cardId: "card_1",
      leaseOwner: "worker_1",
      leaseDurationMs: 60_000,
      now: NOW
    });

    const sourceRepository = createDailyReflectionRepository(database!, {
      now: () => "2026-08-24T08:00:01.000Z"
    });
    expect(sourceRepository.markAdmissionDeleteRequested(
      "account_1",
      "reflection_1"
    )).toBeNull();
    expect(() => repository.complete({
      accountId: "account_1",
      cardId: "card_1",
      leaseOwner: claimed.executionFence!.leaseOwner,
      attemptVersion: claimed.executionFence!.attemptVersion,
      result: noMemoryResult(),
      indexRefreshRequired: false,
      now: "2026-08-24T08:00:02.000Z"
    })).toThrow(DailyReflectionConflictError);
    expect(repository.get("account_1", "card_1")).toMatchObject({
      operation: {
        status: "failed",
        errorCode: "daily_reflection_delete_requested"
      },
      receipt: null,
      card: { memoryLifecycleStatus: "revoked" }
    });
  });
});
