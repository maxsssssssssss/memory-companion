import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { DailyReflectionAiReviewCanonicalSource } from
  "@/lib/domain/daily-reflection-ai-review";

import { migrateDailyReflectionSchema } from "./schema";
import { createDailyReflectionAiReviewRepository } from "./ai-review-repository";

const timestamp = "2026-09-01T00:00:00.000Z";
const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function openDatabase() {
  const database = new Database(":memory:");
  databases.push(database);
  database.pragma("foreign_keys = ON");
  migrateDailyReflectionSchema(database);
  return database;
}

function insertAuthority(database: Database.Database, suffix: string) {
  const reflectionId = `reflection_${suffix}`;
  const cardId = `card_${suffix}`;
  database.prepare(`
    INSERT INTO dr_reflections (
      id, account_id, upload_id, input_method, source_origin,
      processing_profile, ingestion_context, status, version,
      idempotency_key, create_fingerprint, error_code, error_message,
      created_at, updated_at
    ) VALUES (?, 'account_1', ?, 'file_upload', 'user_reflection',
      'quick_reflection', 'daily_reflection', 'review_pending', 0,
      NULL, ?, NULL, NULL, ?, ?)
  `).run(
    reflectionId,
    `upload_${suffix}`,
    `fingerprint_${suffix}`,
    timestamp,
    timestamp
  );
  database.prepare(`
    INSERT INTO dr_working_cards (
      id, account_id, source_reflection_ids_json, title, content, card_kind,
      evidence_ids_json, status, importance, novelty, related_card_ids_json,
      tags_json, visibility, source_unavailable, saved_at, version,
      created_at, updated_at
    ) VALUES (?, 'account_1', ?, ?, ?, 'action', ?, 'saved',
      0.8, 0.7, '[]', '[]', 'private', 0, ?, 1, ?, ?)
  `).run(
    cardId,
    JSON.stringify([reflectionId]),
    `Title ${suffix}`,
    `Content ${suffix}`,
    JSON.stringify([`segment_${suffix}`]),
    timestamp,
    timestamp,
    timestamp
  );
  return { reflectionId, cardId };
}

function source(suffix: string): DailyReflectionAiReviewCanonicalSource {
  return {
    sourceId: `source_${suffix}`,
    sourceKind: "open_loop",
    title: `Title ${suffix}`,
    content: `Content ${suffix}`,
    memoryIds: [`memory_${suffix}`],
    cardIds: [`card_${suffix}`],
    recordingDates: ["2026-09-01"],
    evidence: [{
      reflectionId: `reflection_${suffix}`,
      cardId: `card_${suffix}`,
      recordingDate: "2026-09-01",
      sourceOrigin: "user_reflection",
      sourceSegmentId: `segment_${suffix}`,
      startSeconds: 1,
      endSeconds: 2,
      snippet: `Snippet ${suffix}`
    }],
    epistemicStatuses: ["explicit_user_statement"]
  };
}

function readyContent(authority: DailyReflectionAiReviewCanonicalSource) {
  return {
    schemaVersion: 1 as const,
    selectedSourceIds: [authority.sourceId],
    canonicalSources: [authority],
    observations: [{
      sourceIds: [authority.sourceId],
      canonicalSources: [authority],
      modelInterpretation: { kind: "model_inference" as const, text: "推演" },
      followUpQuestion: null
    }]
  };
}

describe("Daily Reflection AI review repository", () => {
  it("ensures idempotently, claims once, and exposes account-scoped metadata", () => {
    const database = openDatabase();
    insertAuthority(database, "one");
    let nextId = 0;
    const repository = createDailyReflectionAiReviewRepository(database, {
      now: () => new Date(timestamp),
      idFactory: () => `id_${++nextId}`
    });
    const input = {
      accountId: "account_1",
      scope: "daily" as const,
      startDate: "2026-09-01",
      endDate: "2026-09-01",
      sourceFingerprint: "a".repeat(64),
      promptVersion: "review-v1",
      model: "gpt",
      sources: [source("one")]
    };
    const first = repository.ensure(input);
    const replay = repository.ensure(input);
    expect(first.inserted).toBe(true);
    expect(replay).toMatchObject({ inserted: false });
    expect(replay.record.reviewId).toBe(first.record.reviewId);
    expect(repository.get("account_2", first.record.reviewId)).toBeNull();
    expect(repository.listQueued()).toEqual([{
      accountId: "account_1",
      reviewId: first.record.reviewId
    }]);
    database.prepare(`
      UPDATE dr_ai_review_operations SET provider_started_at = ? WHERE id = ?
    `).run(timestamp, first.record.reviewId);
    expect(repository.listQueued()).toEqual([]);
    database.prepare(`
      UPDATE dr_ai_review_operations SET provider_started_at = NULL WHERE id = ?
    `).run(first.record.reviewId);

    const claim = repository.claim({
      accountId: "account_1",
      reviewId: first.record.reviewId,
      workerId: "worker_1",
      leaseMs: 1_000
    });
    expect(claim.claimed).toBe(true);
    expect(repository.claim({
      accountId: "account_1",
      reviewId: first.record.reviewId,
      workerId: "worker_2",
      leaseMs: 1_000
    }).claimed).toBe(false);
    expect(repository.summary("account_1")).toMatchObject({
      pendingCount: 1,
      unseenReadyCount: 0,
      items: []
    });
  });

  it("never repeats a Provider call after its started marker", () => {
    const database = openDatabase();
    insertAuthority(database, "started");
    let clock = Date.parse(timestamp);
    let nextId = 0;
    const repository = createDailyReflectionAiReviewRepository(database, {
      now: () => new Date(clock),
      idFactory: () => `id_${++nextId}`
    });
    const ensured = repository.ensure({
      accountId: "account_1",
      scope: "daily",
      startDate: "2026-09-01",
      endDate: "2026-09-01",
      sourceFingerprint: "b".repeat(64),
      promptVersion: "review-v1",
      model: "gpt",
      sources: [source("started")]
    });
    const claimed = repository.claim({
      accountId: "account_1",
      reviewId: ensured.record.reviewId,
      workerId: "worker_1",
      leaseMs: 1_000
    });
    if (!claimed.claimed) throw new Error("claim failed");
    expect(repository.providerStarted(claimed.claim)).toBe(true);
    clock += 2_000;
    expect(repository.recoverExpiredLeases()).toEqual({
      returnedToQueue: 0,
      providerOutcomeUnknown: 1
    });
    expect(repository.get("account_1", ensured.record.reviewId)).toMatchObject({
      status: "failed",
      failureCode: "provider_outcome_unknown"
    });
    expect(repository.claim({
      accountId: "account_1",
      reviewId: ensured.record.reviewId,
      workerId: "worker_2",
      leaseMs: 1_000
    }).claimed).toBe(false);
  });

  it("recovers only pre-Provider leases and fences late claims", () => {
    const database = openDatabase();
    insertAuthority(database, "recover");
    let clock = Date.parse(timestamp);
    let nextId = 0;
    const repository = createDailyReflectionAiReviewRepository(database, {
      now: () => new Date(clock),
      idFactory: () => `id_${++nextId}`
    });
    const authority = source("recover");
    const ensured = repository.ensure({
      accountId: "account_1",
      scope: "daily",
      startDate: "2026-09-01",
      endDate: "2026-09-01",
      sourceFingerprint: "c".repeat(64),
      promptVersion: "review-v1",
      model: "gpt",
      sources: [authority]
    });
    const first = repository.claim({
      accountId: "account_1",
      reviewId: ensured.record.reviewId,
      workerId: "worker_1",
      leaseMs: 1_000
    });
    if (!first.claimed) throw new Error("claim failed");
    clock += 2_000;
    expect(repository.recoverExpiredLeases()).toEqual({
      returnedToQueue: 1,
      providerOutcomeUnknown: 0
    });
    expect(repository.listQueued()).toHaveLength(1);
    const second = repository.claim({
      accountId: "account_1",
      reviewId: ensured.record.reviewId,
      workerId: "worker_2",
      leaseMs: 1_000
    });
    if (!second.claimed) throw new Error("second claim failed");
    expect(repository.providerStarted(first.claim)).toBe(false);
    expect(repository.providerStarted(second.claim)).toBe(true);
    expect(repository.validating(second.claim)).toBe(true);
    expect(repository.complete({
      claim: second.claim,
      content: readyContent(authority),
      usage: { outputTokenCount: 10, totalTokenCount: 20 }
    })).toBe(true);
    expect(repository.summary("account_1")).toMatchObject({
      pendingCount: 0,
      unseenReadyCount: 1
    });
    expect(repository.listUnseenReady("account_1")).toEqual([{
      reviewId: ensured.record.reviewId,
      scope: "daily",
      startDate: "2026-09-01",
      endDate: "2026-09-01",
      completedAt: new Date(clock).toISOString()
    }]);
    expect(repository.listUnseenReady("account_2")).toEqual([]);
    expect(repository.markSeen("account_1", ensured.record.reviewId)).toBe(true);
    expect(repository.summary("account_1").unseenReadyCount).toBe(0);
    expect(repository.listUnseenReady("account_1")).toEqual([]);
  });

  it("clears late results when canonical source lifecycle changes", () => {
    const database = openDatabase();
    insertAuthority(database, "stale");
    let nextId = 0;
    const repository = createDailyReflectionAiReviewRepository(database, {
      now: () => new Date(timestamp),
      idFactory: () => `id_${++nextId}`
    });
    const authority = source("stale");
    const input = {
      accountId: "account_1",
      scope: "daily" as const,
      startDate: "2026-09-01",
      endDate: "2026-09-01",
      sourceFingerprint: "d".repeat(64),
      promptVersion: "review-v1",
      model: "gpt",
      sources: [authority]
    };
    const ensured = repository.ensure(input);
    const claimed = repository.claim({
      accountId: "account_1",
      reviewId: ensured.record.reviewId,
      workerId: "worker_1",
      leaseMs: 1_000
    });
    if (!claimed.claimed) throw new Error("claim failed");
    repository.providerStarted(claimed.claim);
    repository.validating(claimed.claim);
    repository.complete({ claim: claimed.claim, content: readyContent(authority) });

    database.prepare(`
      UPDATE dr_working_cards SET source_unavailable = 1
      WHERE account_id = 'account_1' AND id = 'card_stale'
    `).run();
    expect(repository.get("account_1", ensured.record.reviewId)).toMatchObject({
      status: "stale",
      content: null,
      seenAt: null
    });
    expect(repository.markSeen("account_1", ensured.record.reviewId)).toBe(false);

    database.prepare(`
      UPDATE dr_working_cards SET source_unavailable = 0
      WHERE account_id = 'account_1' AND id = 'card_stale'
    `).run();
    const replay = repository.ensure(input);
    expect(replay).toMatchObject({ inserted: false });
    expect(replay.record).toMatchObject({ status: "stale", content: null });
    expect(repository.listQueued()).toEqual([]);
  });
});
