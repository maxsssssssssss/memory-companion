import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import {
  DAILY_REFLECTION_AI_REVIEW_CONTRACT_VERSION,
  DailyReflectionAiReviewCanonicalSourceSchema,
  DailyReflectionAiReviewOperationViewSchema,
  DailyReflectionAiReviewReadyContentSchema,
  DailyReflectionAiReviewScopeSchema,
  type DailyReflectionAiReviewCanonicalSource,
  type DailyReflectionAiReviewOperationView,
  type DailyReflectionAiReviewReadyContent,
  type DailyReflectionAiReviewScope
} from "@/lib/domain/daily-reflection-ai-review";

type OperationRow = {
  id: string;
  account_id: string;
  scope: DailyReflectionAiReviewScope;
  start_date: string;
  end_date: string;
  source_fingerprint: string;
  prompt_version: string;
  model: string;
  status: DailyReflectionAiReviewOperationView["status"];
  result_json: string | null;
  failure_code: string | null;
  claim_token: string | null;
  lease_until: string | null;
  attempt_version: number;
  provider_started_at: string | null;
  provider_input_tokens: number | null;
  provider_output_tokens: number | null;
  provider_total_tokens: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  seen_at: string | null;
};

export type DailyReflectionAiReviewRecord = DailyReflectionAiReviewOperationView & {
  accountId: string;
  claimToken: string | null;
  leaseUntil: string | null;
  attemptVersion: number;
  usage: {
    inputTokenCount: number | null;
    outputTokenCount: number | null;
    totalTokenCount: number | null;
  };
  createdAt: string;
};

export type DailyReflectionAiReviewClaim = {
  reviewId: string;
  accountId: string;
  claimToken: string;
  attemptVersion: number;
};

function toRecord(row: OperationRow): DailyReflectionAiReviewRecord {
  const view = DailyReflectionAiReviewOperationViewSchema.parse({
    schemaVersion: DAILY_REFLECTION_AI_REVIEW_CONTRACT_VERSION,
    reviewId: row.id,
    scope: row.scope,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    sourceFingerprint: row.source_fingerprint,
    promptVersion: row.prompt_version,
    model: row.model,
    content: row.result_json === null
      ? null
      : DailyReflectionAiReviewReadyContentSchema.parse(JSON.parse(row.result_json)),
    failureCode: row.failure_code,
    providerStartedAt: row.provider_started_at,
    completedAt: row.completed_at,
    seenAt: row.seen_at,
    updatedAt: row.updated_at
  });
  return {
    ...view,
    accountId: row.account_id,
    claimToken: row.claim_token,
    leaseUntil: row.lease_until,
    attemptVersion: row.attempt_version,
    usage: {
      inputTokenCount: row.provider_input_tokens,
      outputTokenCount: row.provider_output_tokens,
      totalTokenCount: row.provider_total_tokens
    },
    createdAt: row.created_at
  };
}

function assertDateKey(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error("daily_reflection_ai_review_invalid_date");
  }
}

export class DailyReflectionAiReviewRepository {
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(
    private readonly database: Database.Database,
    options: { now?: () => Date; idFactory?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  private read(accountId: string, reviewId: string) {
    const row = this.database.prepare(`
      SELECT * FROM dr_ai_review_operations
      WHERE account_id = ? AND id = ?
    `).get(accountId, reviewId) as OperationRow | undefined;
    return row ? toRecord(row) : null;
  }

  get(accountId: string, reviewId: string) {
    return this.read(accountId, reviewId);
  }

  getLatest(input: {
    accountId: string;
    scope: DailyReflectionAiReviewScope;
    startDate: string;
    endDate: string;
  }) {
    const row = this.database.prepare(`
      SELECT * FROM dr_ai_review_operations
      WHERE account_id = ? AND scope = ? AND start_date = ? AND end_date = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(
      input.accountId,
      DailyReflectionAiReviewScopeSchema.parse(input.scope),
      input.startDate,
      input.endDate
    ) as OperationRow | undefined;
    return row ? toRecord(row) : null;
  }

  ensure(input: {
    accountId: string;
    scope: DailyReflectionAiReviewScope;
    startDate: string;
    endDate: string;
    sourceFingerprint: string;
    promptVersion: string;
    model: string;
    sources: DailyReflectionAiReviewCanonicalSource[];
  }) {
    const scope = DailyReflectionAiReviewScopeSchema.parse(input.scope);
    assertDateKey(input.startDate);
    assertDateKey(input.endDate);
    if (input.startDate > input.endDate) {
      throw new Error("daily_reflection_ai_review_invalid_window");
    }
    if (!/^[a-f0-9]{64}$/u.test(input.sourceFingerprint)) {
      throw new Error("daily_reflection_ai_review_invalid_fingerprint");
    }
    const sources = input.sources.map((source) =>
      DailyReflectionAiReviewCanonicalSourceSchema.parse(source)
    );
    const now = this.now().toISOString();
    const reviewId = `dr_ai_review_${this.idFactory()}`;
    let inserted = false;
    const write = this.database.transaction(() => {
      const result = this.database.prepare(`
        INSERT INTO dr_ai_review_operations (
          id, account_id, scope, start_date, end_date, source_fingerprint,
          prompt_version, model, status, result_json, failure_code,
          claim_token, lease_until, attempt_version, provider_started_at,
          provider_input_tokens, provider_output_tokens, provider_total_tokens,
          created_at, updated_at, completed_at, seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL,
                  NULL, NULL, 0, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)
        ON CONFLICT (
          account_id, scope, start_date, end_date, source_fingerprint,
          prompt_version, model
        ) DO NOTHING
      `).run(
        reviewId,
        input.accountId,
        scope,
        input.startDate,
        input.endDate,
        input.sourceFingerprint,
        input.promptVersion,
        input.model,
        now,
        now
      );
      inserted = result.changes === 1;
      if (!inserted) return;
      const insertLink = this.database.prepare(`
        INSERT INTO dr_ai_review_source_links (
          account_id, review_id, source_id, reflection_id, card_id,
          evidence_id, position
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      let position = 0;
      for (const source of sources) {
        for (const evidence of source.evidence) {
          insertLink.run(
            input.accountId,
            reviewId,
            source.sourceId,
            evidence.reflectionId,
            evidence.cardId,
            evidence.sourceSegmentId,
            position++
          );
        }
      }
    });
    write.immediate();
    const row = this.database.prepare(`
      SELECT * FROM dr_ai_review_operations
      WHERE account_id = ? AND scope = ? AND start_date = ? AND end_date = ?
        AND source_fingerprint = ? AND prompt_version = ? AND model = ?
    `).get(
      input.accountId,
      scope,
      input.startDate,
      input.endDate,
      input.sourceFingerprint,
      input.promptVersion,
      input.model
    ) as OperationRow | undefined;
    if (!row) throw new Error("daily_reflection_ai_review_ensure_failed");
    return { record: toRecord(row), inserted };
  }

  claim(input: {
    accountId: string;
    reviewId: string;
    workerId: string;
    leaseMs: number;
  }): { claimed: false; record: DailyReflectionAiReviewRecord | null } | {
    claimed: true;
    record: DailyReflectionAiReviewRecord;
    claim: DailyReflectionAiReviewClaim;
  } {
    if (!Number.isFinite(input.leaseMs) || input.leaseMs <= 0) {
      throw new Error("daily_reflection_ai_review_invalid_lease");
    }
    const now = this.now();
    const nowIso = now.toISOString();
    const claimToken = `${input.workerId}:${this.idFactory()}`;
    const leaseUntil = new Date(now.getTime() + input.leaseMs).toISOString();
    const result = this.database.prepare(`
      UPDATE dr_ai_review_operations
      SET status = 'processing', claim_token = ?, lease_until = ?,
          attempt_version = attempt_version + 1, updated_at = ?
      WHERE account_id = ? AND id = ? AND provider_started_at IS NULL
        AND (
          status = 'queued'
          OR (status = 'processing' AND lease_until <= ?)
        )
    `).run(
      claimToken,
      leaseUntil,
      nowIso,
      input.accountId,
      input.reviewId,
      nowIso
    );
    const record = this.read(input.accountId, input.reviewId);
    if (result.changes !== 1 || !record) return { claimed: false, record };
    return {
      claimed: true,
      record,
      claim: {
        reviewId: record.reviewId,
        accountId: record.accountId,
        claimToken,
        attemptVersion: record.attemptVersion
      }
    };
  }

  providerStarted(claim: DailyReflectionAiReviewClaim) {
    const now = this.now().toISOString();
    return this.database.prepare(`
      UPDATE dr_ai_review_operations
      SET provider_started_at = ?, updated_at = ?
      WHERE account_id = ? AND id = ? AND status = 'processing'
        AND claim_token = ? AND attempt_version = ?
        AND provider_started_at IS NULL
    `).run(
      now,
      now,
      claim.accountId,
      claim.reviewId,
      claim.claimToken,
      claim.attemptVersion
    ).changes === 1;
  }

  validating(claim: DailyReflectionAiReviewClaim) {
    const now = this.now().toISOString();
    return this.database.prepare(`
      UPDATE dr_ai_review_operations
      SET status = 'validating', updated_at = ?
      WHERE account_id = ? AND id = ? AND status = 'processing'
        AND claim_token = ? AND attempt_version = ?
        AND provider_started_at IS NOT NULL
    `).run(
      now,
      claim.accountId,
      claim.reviewId,
      claim.claimToken,
      claim.attemptVersion
    ).changes === 1;
  }

  complete(input: {
    claim: DailyReflectionAiReviewClaim;
    content: DailyReflectionAiReviewReadyContent;
    usage?: {
      inputTokenCount?: number | null;
      outputTokenCount?: number | null;
      totalTokenCount?: number | null;
    };
  }) {
    const content = DailyReflectionAiReviewReadyContentSchema.parse(input.content);
    const now = this.now().toISOString();
    return this.database.prepare(`
      UPDATE dr_ai_review_operations
      SET status = 'ready', result_json = ?, failure_code = NULL,
          claim_token = NULL, lease_until = NULL,
          provider_input_tokens = ?, provider_output_tokens = ?,
          provider_total_tokens = ?, completed_at = ?, updated_at = ?
      WHERE account_id = ? AND id = ? AND status = 'validating'
        AND claim_token = ? AND attempt_version = ?
        AND provider_started_at IS NOT NULL
    `).run(
      JSON.stringify(content),
      input.usage?.inputTokenCount ?? null,
      input.usage?.outputTokenCount ?? null,
      input.usage?.totalTokenCount ?? null,
      now,
      now,
      input.claim.accountId,
      input.claim.reviewId,
      input.claim.claimToken,
      input.claim.attemptVersion
    ).changes === 1;
  }

  fail(input: { claim: DailyReflectionAiReviewClaim; failureCode: string }) {
    const now = this.now().toISOString();
    return this.database.prepare(`
      UPDATE dr_ai_review_operations
      SET status = 'failed', result_json = NULL, failure_code = ?,
          claim_token = NULL, lease_until = NULL, completed_at = NULL,
          seen_at = NULL, updated_at = ?
      WHERE account_id = ? AND id = ?
        AND status IN ('processing', 'validating')
        AND claim_token = ? AND attempt_version = ?
    `).run(
      input.failureCode,
      now,
      input.claim.accountId,
      input.claim.reviewId,
      input.claim.claimToken,
      input.claim.attemptVersion
    ).changes === 1;
  }

  stale(accountId: string, reviewId: string, _reason?: string) {
    const now = this.now().toISOString();
    return this.database.prepare(`
      UPDATE dr_ai_review_operations
      SET status = 'stale', result_json = NULL, failure_code = NULL,
          claim_token = NULL, lease_until = NULL, completed_at = NULL,
          seen_at = NULL, updated_at = ?
      WHERE account_id = ? AND id = ? AND status <> 'stale'
    `).run(now, accountId, reviewId).changes === 1;
  }

  markSeen(accountId: string, reviewId: string) {
    const now = this.now().toISOString();
    return this.database.prepare(`
      UPDATE dr_ai_review_operations
      SET seen_at = COALESCE(seen_at, ?), updated_at = ?
      WHERE account_id = ? AND id = ? AND status = 'ready'
    `).run(now, now, accountId, reviewId).changes === 1;
  }

  listUnseenReady(accountId: string) {
    return (this.database.prepare(`
      SELECT id, scope, start_date, end_date, completed_at
      FROM dr_ai_review_operations
      WHERE account_id = ? AND status = 'ready' AND seen_at IS NULL
      ORDER BY completed_at DESC, id DESC
    `).all(accountId) as Array<{
      id: string;
      scope: DailyReflectionAiReviewScope;
      start_date: string;
      end_date: string;
      completed_at: string;
    }>).map((item) => ({
      reviewId: item.id,
      scope: item.scope,
      startDate: item.start_date,
      endDate: item.end_date,
      completedAt: item.completed_at
    }));
  }

  summary(accountId: string, limit = 20) {
    const pending = this.database.prepare(`
      SELECT COUNT(*) AS count FROM dr_ai_review_operations
      WHERE account_id = ? AND status IN ('queued', 'processing', 'validating')
    `).get(accountId) as { count: number };
    const unseen = this.database.prepare(`
      SELECT COUNT(*) AS count FROM dr_ai_review_operations
      WHERE account_id = ? AND status = 'ready' AND seen_at IS NULL
    `).get(accountId) as { count: number };
    const items = this.database.prepare(`
      SELECT id, scope, start_date, end_date, completed_at
      FROM dr_ai_review_operations
      WHERE account_id = ? AND status = 'ready' AND seen_at IS NULL
      ORDER BY completed_at DESC, id DESC LIMIT ?
    `).all(accountId, Math.max(0, Math.min(100, Math.trunc(limit)))) as Array<{
      id: string;
      scope: DailyReflectionAiReviewScope;
      start_date: string;
      end_date: string;
      completed_at: string;
    }>;
    return {
      pendingCount: pending.count,
      unseenReadyCount: unseen.count,
      items: items.map((item) => ({
        reviewId: item.id,
        scope: item.scope,
        startDate: item.start_date,
        endDate: item.end_date,
        completedAt: item.completed_at
      }))
    };
  }

  listQueued(limit = 100) {
    return (this.database.prepare(`
      SELECT account_id, id FROM dr_ai_review_operations
      WHERE status = 'queued' AND provider_started_at IS NULL
      ORDER BY created_at, id LIMIT ?
    `).all(Math.max(0, Math.min(1_000, Math.trunc(limit)))) as Array<{
      account_id: string;
      id: string;
    }>).map((row) => ({ accountId: row.account_id, reviewId: row.id }));
  }

  recoverExpiredLeases() {
    const now = this.now().toISOString();
    let returnedToQueue = 0;
    let providerOutcomeUnknown = 0;
    const recover = this.database.transaction(() => {
      providerOutcomeUnknown = this.database.prepare(`
        UPDATE dr_ai_review_operations
        SET status = 'failed', result_json = NULL,
            failure_code = 'provider_outcome_unknown',
            claim_token = NULL, lease_until = NULL, completed_at = NULL,
            seen_at = NULL, updated_at = ?
        WHERE status IN ('processing', 'validating')
          AND lease_until <= ? AND provider_started_at IS NOT NULL
      `).run(now, now).changes;
      returnedToQueue = this.database.prepare(`
        UPDATE dr_ai_review_operations
        SET status = 'queued', claim_token = NULL, lease_until = NULL,
            failure_code = NULL, updated_at = ?
        WHERE status = 'processing' AND lease_until <= ?
          AND provider_started_at IS NULL
      `).run(now, now).changes;
    });
    recover.immediate();
    return { returnedToQueue, providerOutcomeUnknown };
  }
}

export function createDailyReflectionAiReviewRepository(
  database: Database.Database,
  options: { now?: () => Date; idFactory?: () => string } = {}
) {
  return new DailyReflectionAiReviewRepository(database, options);
}
