import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import {
  WorkWeeklyPublishedItemInputSchema,
  WorkWeeklyQaMessageSchema,
  WorkWeeklyQaRunFenceSchema,
  WorkWeeklyQaRunSchema,
  WorkWeeklyQaThreadSchema,
  WorkWeeklyReviewItemSchema,
  WorkWeeklyReviewSchema,
  WorkWeeklyRunFenceSchema,
  WorkWeeklyLatestGenerationSchema,
  WorkWeeklyDisplayedGenerationSchema,
  WorkWeeklyGenerationQualitySchema,
  WorkWeeklyRunSchema,
  type WorkWeeklyReviewIssue,
  type WorkWeeklyPublishedItemInput,
  type WorkWeeklyQaMessage,
  type WorkWeeklyQaRun,
  type WorkWeeklyQaRunFence,
  type WorkWeeklyQaThread,
  type WorkWeeklyReview,
  type WorkWeeklyReviewItem,
  type WorkWeeklyRun,
  type WorkWeeklyRunFence,
  type WorkWeeklyScope,
  type WorkWeeklySourceIdentity,
  type WorkWeeklySourceSnapshot
} from "@/lib/domain/work-weekly";
import {
  redactWorkWeeklyGenerationManifest,
  redactWorkWeeklyGenerationQuality,
  redactWorkWeeklyQaManifest
} from "./weekly-invalidation";
import { buildWorkWeeklySourceSnapshotWithinTransaction } from "./weekly-source-builder";

export const WORK_WEEKLY_PIPELINE_VERSION = "work_weekly_v1" as const;
// Written only after the new executor supplied an explicit quality assessment.
// Historical/direct legacy publications retain v1 and are never backfilled as passed.
export const WORK_WEEKLY_QUALITY_PIPELINE_VERSION = "work_weekly_v3" as const;

export class WorkWeeklyNotFoundError extends Error {
  readonly code = "weekly_not_found";
  constructor() { super("Work Weekly Review not found"); }
}

export class WorkWeeklyQaNotFoundError extends Error {
  readonly code = "weekly_qa_not_found";
  constructor() { super("Work Weekly QA thread not found"); }
}

export class WorkWeeklyConflictError extends Error {
  constructor(readonly code: string) { super(code); }
}

export class WorkWeeklyVersionConflictError extends Error {
  readonly code = "version_conflict";
  constructor(readonly currentVersion: number) { super("Work Weekly version is stale"); }
}

export class WorkWeeklyLeaseLostError extends Error {
  readonly code = "weekly_lease_lost";
  constructor() { super("Work Weekly lease is no longer owned"); }
}

type Options = {
  now?: () => string;
  idFactory?: () => string;
  currentSnapshotBuilder?: (input: {
    accountId: string;
    scope: WorkWeeklyScope;
    now: Date;
  }) => WorkWeeklySourceSnapshot;
};

type ReviewRow = {
  id: string; account_id: string; week_start: string; week_end: string;
  observed_through: string; window_complete: number; time_zone: string;
  scope_kind: "all" | "project" | "unassigned"; project_id: string | null;
  status: WorkWeeklyReview["status"]; source_snapshot_digest: string;
  source_summary_json: string; current_system_version: number; current_run_version: number;
  version: number; created_at: string; updated_at: string; generated_at: string | null;
  failed_at: string | null; deleted_at: string | null; error_code: string | null;
};

type RunRow = {
  id: string; account_id: string; weekly_review_id: string; run_version: number;
  source_snapshot_digest: string; source_manifest_json: string; state: WorkWeeklyRun["state"];
  lease_owner: string | null; lease_expires_at: string | null; pipeline_version: string;
  synthesizer_profile: string | null; verifier_profile: string | null;
  created_at: string; completed_at: string | null; error_code: string | null;
  quality_assessment_json: string | null;
};

type ItemRow = {
  id: string; account_id: string; weekly_review_id: string;
  section_kind: WorkWeeklyReviewItem["section"]; origin: WorkWeeklyReviewItem["origin"];
  system_text: string | null; user_text: string | null;
  verification_state: WorkWeeklyReviewItem["verificationState"];
  sort_order: number; system_version: number | null; version: number;
  user_edited_at: string | null; hidden_at: string | null; invalidated_at: string | null;
  created_at: string; updated_at: string;
};

type ThreadRow = {
  id: string; account_id: string; weekly_review_id: string; source_snapshot_digest: string;
  current_run_version: number; version: number; created_at: string; updated_at: string;
  cleared_at: string | null; deleted_at: string | null;
};

type MessageRow = {
  id: string; account_id: string; weekly_review_id: string; thread_id: string;
  role: "user" | "assistant"; body_text: string | null;
  answer_status: WorkWeeklyQaMessage["answerStatus"]; source_snapshot_digest: string;
  provider_profile: string | null; prompt_version: string | null;
  verifier_profile: string | null; version: number; created_at: string;
  invalidated_at: string | null;
};

type QaRunRow = {
  id: string; account_id: string; weekly_review_id: string; thread_id: string;
  question_message_id: string; run_version: number; source_snapshot_digest: string;
  source_manifest_json: string;
  state: WorkWeeklyQaRun["state"]; lease_owner: string | null;
  lease_expires_at: string | null; provider_profile: string | null;
  prompt_version: string | null; verifier_profile: string | null;
  created_at: string; completed_at: string | null; error_code: string | null;
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function fingerprint(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function sourcePackManifest(value: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new WorkWeeklyConflictError("weekly_source_manifest_invalid");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new WorkWeeklyConflictError("weekly_source_manifest_invalid");
  }
  const manifest = parsed as Record<string, unknown>;
  if (typeof manifest.inputPackDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(manifest.inputPackDigest)) {
    throw new WorkWeeklyConflictError("weekly_source_manifest_invalid");
  }
  const refs = manifest.allowlistedSourceRefs;
  if (refs !== undefined && (!Array.isArray(refs)
    || refs.some((ref) => typeof ref !== "string"))) {
    throw new WorkWeeklyConflictError("weekly_source_manifest_invalid");
  }
  return {
    inputPackDigest: manifest.inputPackDigest,
    allowlistedSourceRefs: refs as string[] | undefined
  };
}

function sameSourceRefs(left: Iterable<string>, right: Iterable<string>) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size
    && [...leftSet].every((ref) => rightSet.has(ref));
}

function reviewFromRow(row: ReviewRow): WorkWeeklyReview {
  return WorkWeeklyReviewSchema.parse({
    contractVersion: 1,
    id: row.id,
    accountId: row.account_id,
    scope: {
      weekStart: row.week_start,
      weekEnd: row.week_end,
      observedThrough: row.observed_through,
      windowComplete: row.window_complete === 1,
      timeZone: row.time_zone,
      scopeKind: row.scope_kind,
      projectId: row.project_id
    },
    status: row.status,
    sourceSnapshotDigest: row.source_snapshot_digest,
    sourceSummary: JSON.parse(row.source_summary_json),
    currentSystemVersion: row.current_system_version,
    currentRunVersion: row.current_run_version,
    version: row.version,
    generatedAt: row.generated_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  });
}

function runFromRow(row: RunRow): WorkWeeklyRun {
  return WorkWeeklyRunSchema.parse({
    id: row.id, accountId: row.account_id, weeklyReviewId: row.weekly_review_id,
    runVersion: row.run_version, sourceSnapshotDigest: row.source_snapshot_digest,
    state: row.state, leaseOwner: row.lease_owner, leaseExpiresAt: row.lease_expires_at,
    pipelineVersion: row.pipeline_version, synthesizerProfile: row.synthesizer_profile,
    verifierProfile: row.verifier_profile, createdAt: row.created_at,
    completedAt: row.completed_at, errorCode: row.error_code
  });
}

function generationQuality(row: RunRow) {
  if (row.quality_assessment_json !== null) {
    try { return WorkWeeklyGenerationQualitySchema.parse(JSON.parse(row.quality_assessment_json)); }
    catch { throw new WorkWeeklyConflictError("weekly_quality_assessment_invalid"); }
  }
  // Historical v2 assessments remain readable; new v3 success requires persisted metadata.
  const historical = row.pipeline_version === "work_weekly_v2";
  const assessed = historical || row.pipeline_version === WORK_WEEKLY_QUALITY_PIPELINE_VERSION;
  return { status: assessed && row.error_code === "weekly_generation_quality_insufficient"
    ? "insufficient" as const
    : historical && row.state === "completed" && row.verifier_profile !== null
      ? "passed" as const : "not_assessed" as const, reviewIssues: [] as WorkWeeklyReviewIssue[] };
}

function sourceRefs(database: Database.Database, table: string, idColumn: string, id: string) {
  return (database.prepare(`
    SELECT source_ref FROM ${table} WHERE ${idColumn} = ? AND invalidated_at IS NULL
    ORDER BY position
  `).all(id) as Array<{ source_ref: string }>).map((row) => row.source_ref);
}

function itemFromRow(database: Database.Database, row: ItemRow): WorkWeeklyReviewItem {
  return WorkWeeklyReviewItemSchema.parse({
    contractVersion: 1,
    id: row.id, accountId: row.account_id, weeklyReviewId: row.weekly_review_id,
    section: row.section_kind, origin: row.origin, systemText: row.system_text,
    userText: row.user_text, sourceRefs: sourceRefs(
      database, "wr_weekly_item_sources", "item_id", row.id
    ), verificationState: row.verification_state, sortOrder: row.sort_order,
    systemVersion: row.system_version, version: row.version,
    userEditedAt: row.user_edited_at, hiddenAt: row.hidden_at,
    invalidatedAt: row.invalidated_at, createdAt: row.created_at, updatedAt: row.updated_at
  });
}

function threadFromRow(row: ThreadRow): WorkWeeklyQaThread {
  return WorkWeeklyQaThreadSchema.parse({
    id: row.id, accountId: row.account_id, weeklyReviewId: row.weekly_review_id,
    sourceSnapshotDigest: row.source_snapshot_digest, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at, clearedAt: row.cleared_at
  });
}

function messageFromRow(database: Database.Database, row: MessageRow): WorkWeeklyQaMessage {
  return WorkWeeklyQaMessageSchema.parse({
    id: row.id, accountId: row.account_id, weeklyReviewId: row.weekly_review_id,
    threadId: row.thread_id, role: row.role, text: row.body_text,
    answerStatus: row.answer_status, sourceRefs: sourceRefs(
      database, "wr_weekly_qa_message_sources", "message_id", row.id
    ), sourceSnapshotDigest: row.source_snapshot_digest,
    providerProfile: row.provider_profile, promptVersion: row.prompt_version,
    verifierProfile: row.verifier_profile, version: row.version,
    createdAt: row.created_at, invalidatedAt: row.invalidated_at
  });
}

function qaRunFromRow(row: QaRunRow): WorkWeeklyQaRun {
  return WorkWeeklyQaRunSchema.parse({
    id: row.id, accountId: row.account_id, weeklyReviewId: row.weekly_review_id,
    threadId: row.thread_id, questionMessageId: row.question_message_id,
    runVersion: row.run_version, sourceSnapshotDigest: row.source_snapshot_digest,
    state: row.state, leaseOwner: row.lease_owner, leaseExpiresAt: row.lease_expires_at,
    providerProfile: row.provider_profile, promptVersion: row.prompt_version,
    verifierProfile: row.verifier_profile, createdAt: row.created_at,
    completedAt: row.completed_at, errorCode: row.error_code
  });
}

function identityForRef(snapshot: WorkWeeklySourceSnapshot, ref: string) {
  const identity = snapshot.identities.find((candidate) => candidate.sourceRef === ref);
  if (!identity) throw new WorkWeeklyConflictError("weekly_source_not_allowlisted");
  return identity;
}

function meetingIdForIdentity(
  snapshot: WorkWeeklySourceSnapshot,
  identity: WorkWeeklySourceIdentity
) {
  if (identity.sourceKind === "meeting") return identity.sourceId;
  if (identity.sourceKind === "finding") {
    return snapshot.findings.find((source) => source.id === identity.sourceId)?.meetingId ?? null;
  }
  if (identity.sourceKind === "evidence") {
    return snapshot.evidence.find((source) => source.sourceRef === identity.sourceRef)?.meetingId ?? null;
  }
  if (identity.sourceKind === "todo") {
    return snapshot.todos.find((source) => source.id === identity.sourceId)?.sourceMeetingId ?? null;
  }
  if (identity.sourceKind === "todo_event") {
    const event = snapshot.todoEvents.find((source) => source.id === identity.sourceId);
    return event
      ? snapshot.todos.find((source) => source.id === event.todoId)?.sourceMeetingId ?? null
      : null;
  }
  return null;
}

function todoIdForIdentity(
  snapshot: WorkWeeklySourceSnapshot,
  identity: WorkWeeklySourceIdentity
) {
  if (identity.sourceKind === "todo") return identity.sourceId;
  if (identity.sourceKind === "todo_event") {
    return snapshot.todoEvents.find((source) => source.id === identity.sourceId)?.todoId ?? null;
  }
  return null;
}

export class WorkWeeklyRepository {
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private readonly currentSnapshotBuilder: NonNullable<Options["currentSnapshotBuilder"]>;

  constructor(private readonly database: Database.Database, options: Options = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
    this.currentSnapshotBuilder = options.currentSnapshotBuilder ?? ((input) =>
      buildWorkWeeklySourceSnapshotWithinTransaction({
        database: this.database,
        accountId: input.accountId,
        scope: {
          weekStart: input.scope.weekStart,
          timeZone: input.scope.timeZone,
          scopeKind: input.scope.scopeKind,
          projectId: input.scope.projectId
        },
        now: input.now
      }));
  }

  private nextId(prefix: string) { return `${prefix}_${this.idFactory()}`; }

  private liveSnapshot(accountId: string, review: ReviewRow, now: string) {
    const scope = reviewFromRow(review).scope;
    const snapshot = this.currentSnapshotBuilder({
      accountId,
      scope,
      now: new Date(now)
    });
    if (snapshot.accountId !== accountId
      || snapshot.scope.weekStart !== scope.weekStart
      || snapshot.scope.timeZone !== scope.timeZone
      || snapshot.scope.scopeKind !== scope.scopeKind
      || snapshot.scope.projectId !== scope.projectId) {
      throw new WorkWeeklyConflictError("weekly_snapshot_scope_mismatch");
    }
    return snapshot;
  }

  private reviewRow(accountId: string, reviewId: string, includeDeleted = false) {
    return this.database.prepare(`
      SELECT * FROM wr_weekly_reviews WHERE account_id = ? AND id = ?
        ${includeDeleted ? "" : "AND deleted_at IS NULL"}
    `).get(accountId, reviewId) as ReviewRow | undefined;
  }

  private requireReviewRow(accountId: string, reviewId: string) {
    const row = this.reviewRow(accountId, reviewId);
    if (!row) throw new WorkWeeklyNotFoundError();
    return row;
  }

  private findByScope(accountId: string, scope: WorkWeeklyScope) {
    return this.database.prepare(`
      SELECT * FROM wr_weekly_reviews
      WHERE account_id = ? AND week_start = ? AND scope_kind = ?
        AND COALESCE(project_id, '') = COALESCE(?, '') AND deleted_at IS NULL
    `).get(accountId, scope.weekStart, scope.scopeKind, scope.projectId) as ReviewRow | undefined;
  }

  getReview(accountId: string, reviewId: string) {
    return reviewFromRow(this.requireReviewRow(accountId, reviewId));
  }

  getReviewByScope(accountId: string, scope: WorkWeeklyScope) {
    const row = this.findByScope(accountId, scope);
    return row ? reviewFromRow(row) : null;
  }

  listItems(accountId: string, reviewId: string) {
    this.requireReviewRow(accountId, reviewId);
    return (this.database.prepare(`
      SELECT * FROM wr_weekly_review_items
      WHERE account_id = ? AND weekly_review_id = ?
      ORDER BY section_kind, sort_order, id
    `).all(accountId, reviewId) as ItemRow[]).map((row) => itemFromRow(this.database, row));
  }

  getDetail(accountId: string, reviewId: string) {
    return {
      review: this.getReview(accountId, reviewId),
      items: this.listItems(accountId, reviewId),
      latestGeneration: this.getLatestGeneration(accountId, reviewId),
      displayedGeneration: this.getDisplayedGeneration(accountId, reviewId)
    };
  }

  getDisplayedGeneration(accountId: string, reviewId: string) {
    const review = this.requireReviewRow(accountId, reviewId);
    const row = this.database.prepare(`
      SELECT r.* FROM wr_weekly_system_versions s
      JOIN wr_weekly_review_runs r ON r.id = s.run_id AND r.account_id = s.account_id
        AND r.weekly_review_id = s.weekly_review_id
      WHERE s.account_id = ? AND s.weekly_review_id = ? AND s.system_version = ?
    `).get(accountId, reviewId, review.current_system_version) as RunRow | undefined;
    if (!row) return null;
    const quality = generationQuality(row);
    return WorkWeeklyDisplayedGenerationSchema.parse({
      runId: row.id, runVersion: row.run_version, systemVersion: review.current_system_version,
      qualityStatus: quality.status === "insufficient" ? "not_assessed" : quality.status,
      reviewIssues: quality.reviewIssues
    });
  }

  getLatestGeneration(accountId: string, reviewId: string) {
    const review = this.requireReviewRow(accountId, reviewId);
    const row = this.database.prepare(`
      SELECT * FROM wr_weekly_review_runs
      WHERE account_id = ? AND weekly_review_id = ? AND run_version = ?
    `).get(accountId, reviewId, review.current_run_version) as RunRow | undefined;
    if (!row) return null;
    const quality = generationQuality(row);
    const insufficient = quality.status === "insufficient";
    const usable = (quality.status === "passed" || quality.status === "needs_review")
      && row.state === "completed" && row.verifier_profile !== null;
    const published = this.database.prepare(`
      SELECT run_id FROM wr_weekly_system_versions
      WHERE account_id = ? AND weekly_review_id = ? AND system_version = ?
    `).get(accountId, reviewId, review.current_system_version) as { run_id: string } | undefined;
    const unknown = row.error_code === "weekly_generation_provider_outcome_unknown";
    return WorkWeeklyLatestGenerationSchema.parse({
      runId: row.id,
      runVersion: row.run_version,
      executionStatus: unknown ? "unknown" : row.state === "queued" ? "pending"
        : row.state === "processing" || row.state === "verifying" ? "running"
          : row.state === "completed" || insufficient ? "completed" : "failed",
      sourceCheckStatus: usable || insufficient
        || row.state === "completed" && row.verifier_profile !== null ? "completed" : "not_established",
      qualityStatus: insufficient ? "insufficient" : usable ? quality.status : "not_assessed",
      reviewIssues: quality.reviewIssues,
      displayingPreviousVersion: Boolean(published && published.run_id !== row.id),
      errorCode: row.error_code && /^(?:work|weekly)_[a-z0-9_]{1,120}$/u.test(row.error_code)
        ? row.error_code : null
    });
  }

  /** Read-only fence check before capturing an async result; never renews/replays work. */
  canCaptureGeneration(accountId: string, fence: WorkWeeklyRunFence, terminal = false) {
    const row = this.database.prepare(`
      SELECT r.state, r.lease_owner, r.lease_expires_at FROM wr_weekly_review_runs r
      JOIN wr_weekly_reviews w ON w.id = r.weekly_review_id AND w.account_id = r.account_id
      WHERE r.account_id = ? AND r.id = ? AND r.weekly_review_id = ?
        AND r.run_version = ? AND r.source_snapshot_digest = ?
        AND w.current_run_version = r.run_version AND w.deleted_at IS NULL
    `).get(accountId, fence.runId, fence.weeklyReviewId, fence.runVersion,
      fence.sourceSnapshotDigest) as Pick<RunRow, "state" | "lease_owner" | "lease_expires_at"> | undefined;
    if (!row) return false;
    if (terminal) return row.state === "completed" || row.state === "failed";
    return ["processing", "verifying"].includes(row.state)
      && row.lease_owner === fence.leaseOwner && row.lease_expires_at === fence.leaseExpiresAt
      && row.lease_expires_at !== null && row.lease_expires_at > this.now();
  }

  hasActiveSourceReference(accountId: string, reviewId: string, sourceRef: string) {
    this.requireReviewRow(accountId, reviewId);
    return Boolean(this.database.prepare(`
      SELECT 1 FROM (
        SELECT source_ref FROM wr_weekly_item_sources
        WHERE account_id = ? AND weekly_review_id = ? AND source_ref = ?
          AND invalidated_at IS NULL
        UNION ALL
        SELECT source_ref FROM wr_weekly_qa_message_sources
        WHERE account_id = ? AND weekly_review_id = ? AND source_ref = ?
          AND invalidated_at IS NULL
      ) LIMIT 1
    `).get(accountId, reviewId, sourceRef, accountId, reviewId, sourceRef));
  }

  private replayOperation(accountId: string, operationKey: string, expectedFingerprint: string) {
    const row = this.database.prepare(`
      SELECT request_fingerprint, result_json FROM wr_weekly_review_operations
      WHERE account_id = ? AND operation_key = ?
    `).get(accountId, operationKey) as {
      request_fingerprint: string; result_json: string;
    } | undefined;
    if (!row) return null;
    if (row.request_fingerprint !== expectedFingerprint) {
      throw new WorkWeeklyConflictError("weekly_operation_conflict");
    }
    return JSON.parse(row.result_json) as Record<string, unknown>;
  }

  private recordOperation(input: {
    accountId: string; operationKey: string; reviewId: string; targetId?: string | null;
    operationType: "generate" | "regenerate" | "update_item" | "create_note"
      | "delete_note" | "reset" | "delete_review";
    requestFingerprint: string; result: Record<string, unknown>; now: string;
  }) {
    this.database.prepare(`
      INSERT INTO wr_weekly_review_operations(
        account_id, operation_key, weekly_review_id, target_id, operation_type,
        request_fingerprint, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.accountId, input.operationKey, input.reviewId, input.targetId ?? null,
      input.operationType, input.requestFingerprint, JSON.stringify(input.result), input.now);
  }

  queueGeneration(input: {
    accountId: string;
    snapshot: WorkWeeklySourceSnapshot;
    operationKey: string;
    expectedVersion: number | null;
    kind: "generate" | "regenerate";
  }) {
    if (input.snapshot.accountId !== input.accountId) {
      throw new WorkWeeklyConflictError("weekly_snapshot_account_mismatch");
    }
    const requestFingerprint = fingerprint({
      type: input.kind,
      scope: {
        weekStart: input.snapshot.scope.weekStart,
        timeZone: input.snapshot.scope.timeZone,
        scopeKind: input.snapshot.scope.scopeKind,
        projectId: input.snapshot.scope.projectId
      },
      expectedVersion: input.expectedVersion
    });
    const run = this.database.transaction(() => {
      const replay = this.replayOperation(input.accountId, input.operationKey, requestFingerprint);
      if (replay) {
        const reviewId = String(replay.reviewId);
        const runId = String(replay.runId);
        const row = this.requireReviewRow(input.accountId, reviewId);
        const runRow = this.database.prepare(`
          SELECT * FROM wr_weekly_review_runs WHERE account_id = ? AND id = ?
        `).get(input.accountId, runId) as RunRow | undefined;
        if (!runRow) throw new WorkWeeklyConflictError("weekly_operation_tombstoned");
        return { review: reviewFromRow(row), run: runFromRow(runRow), reused: true };
      }
      const now = this.now();
      let review = this.findByScope(input.accountId, input.snapshot.scope);
      if (!review) {
        if (input.kind !== "generate" || input.expectedVersion !== null) {
          throw new WorkWeeklyNotFoundError();
        }
        const reviewId = this.nextId("wrw");
        this.database.prepare(`
          INSERT INTO wr_weekly_reviews(
            id, account_id, week_start, week_end, observed_through, window_complete,
            time_zone, scope_kind, project_id, status, source_snapshot_digest,
            source_summary_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
        `).run(reviewId, input.accountId, input.snapshot.scope.weekStart,
          input.snapshot.scope.weekEnd, input.snapshot.scope.observedThrough,
          input.snapshot.scope.windowComplete ? 1 : 0, input.snapshot.scope.timeZone,
          input.snapshot.scope.scopeKind, input.snapshot.scope.projectId,
          input.snapshot.digest, JSON.stringify(input.snapshot.summary), now, now);
        review = this.requireReviewRow(input.accountId, reviewId);
      } else {
        if (review.time_zone !== input.snapshot.scope.timeZone) {
          throw new WorkWeeklyConflictError("weekly_time_zone_conflict");
        }
        if (input.expectedVersion === null || review.version !== input.expectedVersion) {
          throw new WorkWeeklyVersionConflictError(review.version);
        }
      }
      this.database.prepare(`
        UPDATE wr_weekly_review_runs
        SET state = 'superseded', lease_owner = NULL, lease_expires_at = NULL,
          completed_at = COALESCE(completed_at, ?), error_code = 'weekly_superseded'
        WHERE account_id = ? AND weekly_review_id = ?
          AND state IN ('queued', 'processing', 'verifying')
      `).run(now, input.accountId, review.id);
      const nextRunVersion = review.current_run_version + 1;
      const runId = this.nextId("wrwr");
      this.database.prepare(`
        INSERT INTO wr_weekly_review_runs(
          id, account_id, weekly_review_id, run_version, run_kind,
          source_snapshot_digest, source_manifest_json, source_summary_json,
          state, pipeline_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
      `).run(runId, input.accountId, review.id, nextRunVersion, input.kind,
        input.snapshot.digest, JSON.stringify({
          contractVersion: input.snapshot.contractVersion,
          inputPackDigest: input.snapshot.inputPackDigest,
          scope: input.snapshot.scope,
          identities: input.snapshot.identities.map(({ included, ...identity }) => ({
            ...identity, included
          }))
        }), JSON.stringify(input.snapshot.summary), WORK_WEEKLY_PIPELINE_VERSION, now);
      for (const identity of input.snapshot.identities) {
        this.database.prepare(`
          INSERT INTO wr_weekly_run_sources(
            account_id, weekly_review_id, run_id, source_ref, source_kind,
            source_entity_id, source_version, source_digest, meeting_id, todo_id,
            publication_id, segment_id, included
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(input.accountId, review.id, runId, identity.sourceRef,
          identity.sourceKind, identity.sourceId, identity.version, identity.digest,
          meetingIdForIdentity(input.snapshot, identity),
          todoIdForIdentity(input.snapshot, identity), identity.publicationId,
          identity.segmentId, identity.included ? 1 : 0);
      }
      this.database.prepare(`
        UPDATE wr_weekly_reviews
        SET current_run_version = ?, status = 'queued', observed_through = ?,
          window_complete = ?, version = version + 1, updated_at = ?,
          failed_at = NULL, error_code = NULL
        WHERE account_id = ? AND id = ?
      `).run(nextRunVersion, input.snapshot.scope.observedThrough,
        input.snapshot.scope.windowComplete ? 1 : 0, now, input.accountId, review.id);
      this.recordOperation({
        accountId: input.accountId, operationKey: input.operationKey,
        reviewId: review.id, targetId: runId, operationType: input.kind,
        requestFingerprint, result: { reviewId: review.id, runId, runVersion: nextRunVersion }, now
      });
      return {
        review: reviewFromRow(this.requireReviewRow(input.accountId, review.id)),
        run: runFromRow(this.database.prepare(`SELECT * FROM wr_weekly_review_runs WHERE id = ?`)
          .get(runId) as RunRow),
        reused: false
      };
    });
    return run.immediate();
  }

  claimGenerationRun(input: { accountId: string; runId: string; leaseOwner: string; leaseMs: number }) {
    const now = this.now();
    const leaseExpiresAt = new Date(Date.parse(now) + input.leaseMs).toISOString();
    const run = this.database.transaction(() => {
      const row = this.database.prepare(`
        SELECT * FROM wr_weekly_review_runs WHERE account_id = ? AND id = ?
      `).get(input.accountId, input.runId) as RunRow | undefined;
      if (!row) throw new WorkWeeklyNotFoundError();
      this.requireReviewRow(input.accountId, row.weekly_review_id);
      const result = this.database.prepare(`
        UPDATE wr_weekly_review_runs
        SET state = 'processing', lease_owner = ?, lease_expires_at = ?, started_at = ?
        WHERE account_id = ? AND id = ?
          AND (state = 'queued'
            OR (state IN ('processing', 'verifying') AND lease_expires_at <= ?))
      `).run(input.leaseOwner, leaseExpiresAt, now, input.accountId, input.runId, now);
      if (result.changes !== 1) throw new WorkWeeklyLeaseLostError();
      this.database.prepare(`
        UPDATE wr_weekly_reviews SET status = 'generating', version = version + 1, updated_at = ?
        WHERE account_id = ? AND id = ? AND current_run_version = ?
      `).run(now, input.accountId, row.weekly_review_id, row.run_version);
      return WorkWeeklyRunFenceSchema.parse({
        weeklyReviewId: row.weekly_review_id, runId: row.id, runVersion: row.run_version,
        leaseOwner: input.leaseOwner, leaseExpiresAt, sourceSnapshotDigest: row.source_snapshot_digest
      });
    });
    return run.immediate();
  }

  renewGenerationLease(input: WorkWeeklyRunFence & { leaseMs: number }) {
    const now = this.now();
    const leaseExpiresAt = new Date(Date.parse(now) + input.leaseMs).toISOString();
    const result = this.database.prepare(`
      UPDATE wr_weekly_review_runs SET lease_expires_at = ?
      WHERE id = ? AND weekly_review_id = ? AND run_version = ?
        AND lease_owner = ? AND lease_expires_at = ?
        AND state IN ('processing', 'verifying') AND lease_expires_at > ?
    `).run(leaseExpiresAt, input.runId, input.weeklyReviewId, input.runVersion,
      input.leaseOwner, input.leaseExpiresAt, now);
    if (result.changes !== 1) throw new WorkWeeklyLeaseLostError();
    return WorkWeeklyRunFenceSchema.parse({ ...input, leaseExpiresAt });
  }

  markGenerationVerifying(input: WorkWeeklyRunFence) {
    const now = this.now();
    const run = this.database.transaction(() => {
      const result = this.database.prepare(`
        UPDATE wr_weekly_review_runs SET state = 'verifying'
        WHERE id = ? AND weekly_review_id = ? AND run_version = ?
          AND lease_owner = ? AND lease_expires_at = ? AND state = 'processing'
          AND lease_expires_at > ?
      `).run(input.runId, input.weeklyReviewId, input.runVersion,
        input.leaseOwner, input.leaseExpiresAt, now);
      if (result.changes !== 1) throw new WorkWeeklyLeaseLostError();
      const review = this.database.prepare(`
        UPDATE wr_weekly_reviews SET status = 'verifying', version = version + 1, updated_at = ?
        WHERE id = ? AND current_run_version = ? AND deleted_at IS NULL
      `).run(now, input.weeklyReviewId, input.runVersion);
      if (review.changes !== 1) throw new WorkWeeklyLeaseLostError();
    });
    run.immediate();
  }

  publishSystemVersion(input: {
    accountId: string;
    fence: WorkWeeklyRunFence;
    currentSnapshot: WorkWeeklySourceSnapshot;
    items: WorkWeeklyPublishedItemInput[];
    synthesizerProfile: string;
    verifierProfile: string | null;
    qualityAssessment?: { status: "passed" | "needs_review" | "insufficient"; reviewIssues?: WorkWeeklyReviewIssue[] };
  }) {
    if (input.currentSnapshot.accountId !== input.accountId) {
      throw new WorkWeeklyConflictError("weekly_snapshot_account_mismatch");
    }
    const publishedItems = input.items.map((item) => WorkWeeklyPublishedItemInputSchema.parse(item));
    const quality = input.qualityAssessment ? WorkWeeklyGenerationQualitySchema.safeParse({
      status: input.qualityAssessment.status, reviewIssues: input.qualityAssessment.reviewIssues ?? []
    }) : null;
    if (quality && !quality.success) throw new WorkWeeklyConflictError("weekly_quality_assessment_invalid");
    const assessment = quality?.success ? quality.data : null;
    if (assessment && (assessment.status === "insufficient"
      || publishedItems.length === 0 || input.verifierProfile === null)) {
      throw new WorkWeeklyConflictError("weekly_generation_quality_insufficient");
    }
    const run = this.database.transaction(() => {
      const now = this.now();
      const review = this.requireReviewRow(input.accountId, input.fence.weeklyReviewId);
      const row = this.database.prepare(`
        SELECT * FROM wr_weekly_review_runs
        WHERE account_id = ? AND id = ? AND weekly_review_id = ?
      `).get(input.accountId, input.fence.runId, input.fence.weeklyReviewId) as RunRow | undefined;
      if (!row || row.run_version !== input.fence.runVersion
        || row.lease_owner !== input.fence.leaseOwner
        || row.lease_expires_at !== input.fence.leaseExpiresAt
        || !["processing", "verifying"].includes(row.state)
        || row.lease_expires_at <= now) throw new WorkWeeklyLeaseLostError();
      const liveSnapshot = this.liveSnapshot(input.accountId, review, now);
      const storedManifest = sourcePackManifest(row.source_manifest_json);
      const queuedAllowlist = (this.database.prepare(`
        SELECT source_ref FROM wr_weekly_run_sources
        WHERE account_id = ? AND weekly_review_id = ? AND run_id = ? AND included = 1
        ORDER BY source_ref
      `).all(input.accountId, review.id, row.id) as Array<{ source_ref: string }>)
        .map((source) => source.source_ref);
      if (input.currentSnapshot.inputPackDigest !== storedManifest.inputPackDigest
        || !sameSourceRefs(input.currentSnapshot.allowlistedSourceRefs, queuedAllowlist)) {
        throw new WorkWeeklyConflictError("weekly_input_pack_mismatch");
      }
      if (review.current_run_version !== input.fence.runVersion
        || row.source_snapshot_digest !== input.fence.sourceSnapshotDigest
        || input.currentSnapshot.digest !== input.fence.sourceSnapshotDigest
        || liveSnapshot.digest !== input.fence.sourceSnapshotDigest
        || liveSnapshot.inputPackDigest !== storedManifest.inputPackDigest
        || !sameSourceRefs(liveSnapshot.allowlistedSourceRefs, queuedAllowlist)) {
        this.database.prepare(`
          UPDATE wr_weekly_review_runs SET state = 'superseded', lease_owner = NULL,
            lease_expires_at = NULL, completed_at = ?, error_code = 'weekly_source_changed'
          WHERE id = ?
        `).run(now, row.id);
        this.database.prepare(`
          UPDATE wr_weekly_reviews SET status = 'stale', version = version + 1, updated_at = ?
          WHERE id = ? AND account_id = ?
        `).run(now, review.id, input.accountId);
        return { sourceChanged: true as const };
      }
      const callerAllowlist = new Set(input.currentSnapshot.allowlistedSourceRefs);
      const liveAllowlist = new Set(liveSnapshot.allowlistedSourceRefs);
      const storedAllowlist = new Set(queuedAllowlist);
      for (const item of publishedItems) {
        if (item.sourceRefs.some((ref) => !callerAllowlist.has(ref)
          || !liveAllowlist.has(ref) || !storedAllowlist.has(ref))) {
          throw new WorkWeeklyConflictError("weekly_source_not_allowlisted");
        }
      }
      for (const issue of assessment?.reviewIssues ?? []) {
        if (issue.reasonCode === "source_unavailable" || (issue.sourceRef !== null
          && (!callerAllowlist.has(issue.sourceRef) || !liveAllowlist.has(issue.sourceRef)
            || !storedAllowlist.has(issue.sourceRef)))) {
          throw new WorkWeeklyConflictError("weekly_source_not_allowlisted");
        }
      }
      const systemVersion = review.current_system_version + 1;
      this.database.prepare(`
        INSERT INTO wr_weekly_system_versions(
          account_id, weekly_review_id, system_version, run_id,
          source_snapshot_digest, source_summary_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(input.accountId, review.id, systemVersion, row.id,
        liveSnapshot.digest, JSON.stringify(liveSnapshot.summary), now);
      this.database.prepare(`
        DELETE FROM wr_weekly_review_items
        WHERE account_id = ? AND weekly_review_id = ? AND origin = 'gpt'
          AND (
            invalidated_at IS NOT NULL
            OR (
              user_text IS NULL AND user_edited_at IS NULL AND hidden_at IS NULL
              AND sort_order = (
                SELECT sort_order FROM wr_weekly_system_items s
                WHERE s.id = wr_weekly_review_items.system_item_id
              )
            )
          )
      `).run(input.accountId, review.id);
      const createdItems: WorkWeeklyReviewItem[] = [];
      for (const item of publishedItems) {
        const systemItemId = this.nextId("wrwsi");
        const itemId = this.nextId("wrwi");
        this.database.prepare(`
          INSERT INTO wr_weekly_system_items(
            id, account_id, weekly_review_id, system_version, section_kind,
            body_text, verification_state, sort_order, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(systemItemId, input.accountId, review.id, systemVersion,
          item.section, item.text, item.verificationState, item.sortOrder, now);
        for (const [position, ref] of item.sourceRefs.entries()) {
          const identity = identityForRef(liveSnapshot, ref);
          this.insertSystemItemSource({
            accountId: input.accountId,
            reviewId: review.id,
            systemItemId,
            position,
            identity,
            meetingId: meetingIdForIdentity(liveSnapshot, identity),
            todoId: todoIdForIdentity(liveSnapshot, identity)
          });
        }
        this.database.prepare(`
          INSERT INTO wr_weekly_review_items(
            id, account_id, weekly_review_id, system_item_id, section_kind, origin,
            system_text, verification_state, sort_order, system_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'gpt', ?, ?, ?, ?, ?, ?)
        `).run(itemId, input.accountId, review.id, systemItemId, item.section,
          item.text, item.verificationState, item.sortOrder, systemVersion, now, now);
        for (const [position, ref] of item.sourceRefs.entries()) {
          const identity = identityForRef(liveSnapshot, ref);
          this.insertItemSource({
            accountId: input.accountId, reviewId: review.id, itemId, position, identity,
            meetingId: meetingIdForIdentity(liveSnapshot, identity),
            todoId: todoIdForIdentity(liveSnapshot, identity)
          });
        }
        createdItems.push(itemFromRow(this.database, this.database.prepare(`
          SELECT * FROM wr_weekly_review_items WHERE id = ?
        `).get(itemId) as ItemRow));
      }
      this.database.prepare(`
        UPDATE wr_weekly_review_runs
        SET state = 'completed', lease_owner = NULL, lease_expires_at = NULL,
          synthesizer_profile = ?, verifier_profile = ?, completed_at = ?, error_code = NULL,
          pipeline_version = CASE WHEN ? = 1 THEN ? ELSE pipeline_version END,
          quality_assessment_json = ?
        WHERE id = ?
      `).run(input.synthesizerProfile, input.verifierProfile, now,
        assessment ? 1 : 0, WORK_WEEKLY_QUALITY_PIPELINE_VERSION,
        assessment ? JSON.stringify(assessment) : null, row.id);
      this.database.prepare(`
        UPDATE wr_weekly_reviews
        SET status = 'ready', source_snapshot_digest = ?, source_summary_json = ?,
          observed_through = ?, window_complete = ?, current_system_version = ?,
          generated_at = ?, version = version + 1, updated_at = ?, failed_at = NULL,
          error_code = NULL
        WHERE id = ? AND account_id = ?
      `).run(liveSnapshot.digest, JSON.stringify(liveSnapshot.summary),
        liveSnapshot.scope.observedThrough,
        liveSnapshot.scope.windowComplete ? 1 : 0, systemVersion,
        now, now, review.id, input.accountId);
      return {
        sourceChanged: false as const,
        review: reviewFromRow(this.requireReviewRow(input.accountId, review.id)),
        items: createdItems
      };
    });
    const result = run.immediate();
    if (result.sourceChanged) {
      throw new WorkWeeklyConflictError("weekly_source_changed");
    }
    return { review: result.review, items: result.items };
  }

  private insertItemSource(input: {
    accountId: string; reviewId: string; itemId: string; position: number;
    identity: WorkWeeklySourceIdentity;
    meetingId: string | null;
    todoId: string | null;
  }) {
    this.database.prepare(`
      INSERT INTO wr_weekly_item_sources(
        account_id, weekly_review_id, item_id, position, source_ref, source_kind,
        source_entity_id, source_version, meeting_id, todo_id, publication_id, segment_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.accountId, input.reviewId, input.itemId, input.position,
      input.identity.sourceRef, input.identity.sourceKind, input.identity.sourceId,
      input.identity.version, input.meetingId, input.todoId, input.identity.publicationId,
      input.identity.segmentId);
  }

  private insertSystemItemSource(input: {
    accountId: string; reviewId: string; systemItemId: string; position: number;
    identity: WorkWeeklySourceIdentity;
    meetingId: string | null;
    todoId: string | null;
  }) {
    this.database.prepare(`
      INSERT INTO wr_weekly_system_item_sources(
        account_id, weekly_review_id, system_item_id, position, source_ref, source_kind,
        source_entity_id, source_version, meeting_id, todo_id, publication_id, segment_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.accountId, input.reviewId, input.systemItemId, input.position,
      input.identity.sourceRef, input.identity.sourceKind, input.identity.sourceId,
      input.identity.version, input.meetingId, input.todoId, input.identity.publicationId,
      input.identity.segmentId);
  }

  markGenerationFailed(input: {
    accountId: string; fence: WorkWeeklyRunFence; errorCode: string;
    qualityAssessment?: { status: "insufficient" };
  }) {
    const now = this.now();
    const run = this.database.transaction(() => {
      const result = this.database.prepare(`
        UPDATE wr_weekly_review_runs
        SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL,
          completed_at = ?, error_code = ?,
          pipeline_version = CASE WHEN ? = 1 THEN ? ELSE pipeline_version END
      WHERE account_id = ? AND id = ? AND weekly_review_id = ? AND run_version = ?
        AND lease_owner = ? AND lease_expires_at = ?
        AND state IN ('processing', 'verifying') AND lease_expires_at > ?
    `).run(now, input.errorCode,
      input.qualityAssessment?.status === "insufficient"
        && input.errorCode === "weekly_generation_quality_insufficient" ? 1 : 0,
      WORK_WEEKLY_QUALITY_PIPELINE_VERSION, input.accountId, input.fence.runId,
      input.fence.weeklyReviewId, input.fence.runVersion, input.fence.leaseOwner,
      input.fence.leaseExpiresAt, now);
      if (result.changes !== 1) throw new WorkWeeklyLeaseLostError();
      this.database.prepare(`
        UPDATE wr_weekly_reviews SET status = 'failed', failed_at = ?, error_code = ?,
          version = version + 1, updated_at = ?
        WHERE account_id = ? AND id = ? AND current_run_version = ?
      `).run(now, input.errorCode, now, input.accountId,
        input.fence.weeklyReviewId, input.fence.runVersion);
    });
    run.immediate();
  }

  listRecoverableGenerationRuns(now = this.now(), limit = 100) {
    return (this.database.prepare(`
      SELECT * FROM wr_weekly_review_runs
      WHERE state = 'queued' OR (state IN ('processing', 'verifying') AND lease_expires_at <= ?)
      ORDER BY created_at, id LIMIT ?
    `).all(now, limit) as RunRow[]).map(runFromRow);
  }

  reconcileSourceValidity(input: {
    accountId: string; reviewId: string; snapshot: WorkWeeklySourceSnapshot;
  }) {
    if (input.snapshot.accountId !== input.accountId) {
      throw new WorkWeeklyConflictError("weekly_snapshot_account_mismatch");
    }
    const run = this.database.transaction(() => {
      const review = this.requireReviewRow(input.accountId, input.reviewId);
      const now = this.now();
      const eligible = new Set(input.snapshot.identities.map((identity) => identity.sourceRef));
      const runSources = this.database.prepare(`
        SELECT run_id, source_ref FROM wr_weekly_run_sources
        WHERE account_id = ? AND weekly_review_id = ?
      `).all(input.accountId, input.reviewId) as Array<{
        run_id: string; source_ref: string;
      }>;
      const invalidRunSources = runSources.filter((source) => !eligible.has(source.source_ref));
      const invalidRunIds = [...new Set(invalidRunSources.map((source) => source.run_id))];
      for (const runId of invalidRunIds) {
        const removedSourceRefs = new Set(invalidRunSources
          .filter((source) => source.run_id === runId).map((source) => source.source_ref));
        const manifest = this.database.prepare(`
          SELECT source_manifest_json, quality_assessment_json FROM wr_weekly_review_runs
          WHERE account_id = ? AND id = ?
        `).get(input.accountId, runId) as { source_manifest_json: string; quality_assessment_json: string | null } | undefined;
        this.database.prepare(`
          UPDATE wr_weekly_review_runs
          SET state = CASE WHEN state IN ('queued', 'processing', 'verifying')
              THEN 'superseded' ELSE state END,
            lease_owner = CASE WHEN state IN ('queued', 'processing', 'verifying')
              THEN NULL ELSE lease_owner END,
            lease_expires_at = CASE WHEN state IN ('queued', 'processing', 'verifying')
              THEN NULL ELSE lease_expires_at END,
            completed_at = CASE WHEN state IN ('queued', 'processing', 'verifying')
              THEN COALESCE(completed_at, ?) ELSE completed_at END,
            error_code = CASE WHEN state IN ('queued', 'processing', 'verifying')
              THEN 'weekly_source_deleted' ELSE error_code END,
            source_manifest_json = ?, quality_assessment_json = ?
          WHERE account_id = ? AND id = ?
        `).run(now, manifest
          ? redactWorkWeeklyGenerationManifest(manifest.source_manifest_json, removedSourceRefs)
          : JSON.stringify({ erased: true }),
          redactWorkWeeklyGenerationQuality(manifest?.quality_assessment_json ?? null, removedSourceRefs),
          input.accountId, runId);
        for (const source of invalidRunSources.filter((candidate) => candidate.run_id === runId)) {
          this.database.prepare(`
            DELETE FROM wr_weekly_run_sources
            WHERE account_id = ? AND run_id = ? AND source_ref = ?
          `).run(input.accountId, runId, source.source_ref);
        }
      }
      const systemSources = this.database.prepare(`
        SELECT system_item_id, source_ref FROM wr_weekly_system_item_sources
        WHERE account_id = ? AND weekly_review_id = ? AND invalidated_at IS NULL
      `).all(input.accountId, input.reviewId) as Array<{
        system_item_id: string; source_ref: string;
      }>;
      const invalidSystemSources = systemSources
        .filter((source) => !eligible.has(source.source_ref));
      const affectedSystemItemIds = [...new Set(invalidSystemSources
        .map((source) => source.system_item_id))];
      for (const source of invalidSystemSources) {
        this.database.prepare(`
          UPDATE wr_weekly_system_item_sources SET invalidated_at = ?
          WHERE account_id = ? AND system_item_id = ? AND source_ref = ?
            AND invalidated_at IS NULL
        `).run(now, input.accountId, source.system_item_id, source.source_ref);
      }
      const invalidSystemItemIds: string[] = [];
      for (const systemItemId of affectedSystemItemIds) {
        const remaining = this.database.prepare(`
          SELECT count(*) AS count FROM wr_weekly_system_item_sources
          WHERE account_id = ? AND system_item_id = ? AND invalidated_at IS NULL
        `).get(input.accountId, systemItemId) as { count: number };
        if (remaining.count === 0) {
          this.database.prepare(`
            UPDATE wr_weekly_system_items
            SET body_text = '来源已失效，内容不可用', erased_at = ?
            WHERE account_id = ? AND id = ? AND erased_at IS NULL
          `).run(now, input.accountId, systemItemId);
          invalidSystemItemIds.push(systemItemId);
        }
      }
      const itemSources = this.database.prepare(`
        SELECT item_id, source_ref FROM wr_weekly_item_sources
        WHERE account_id = ? AND weekly_review_id = ? AND invalidated_at IS NULL
      `).all(input.accountId, input.reviewId) as Array<{ item_id: string; source_ref: string }>;
      const invalidItemSources = itemSources.filter((source) => !eligible.has(source.source_ref));
      const affectedItemIds = [...new Set(invalidItemSources.map((source) => source.item_id))];
      for (const source of invalidItemSources) {
        this.database.prepare(`
          UPDATE wr_weekly_item_sources SET invalidated_at = ?
          WHERE account_id = ? AND item_id = ? AND source_ref = ?
            AND invalidated_at IS NULL
        `).run(now, input.accountId, source.item_id, source.source_ref);
      }
      const invalidItemIds: string[] = [];
      for (const itemId of affectedItemIds) {
        const remaining = this.database.prepare(`
          SELECT count(*) AS count FROM wr_weekly_item_sources
          WHERE account_id = ? AND item_id = ? AND invalidated_at IS NULL
        `).get(input.accountId, itemId) as { count: number };
        if (remaining.count === 0) {
          this.database.prepare(`
            UPDATE wr_weekly_review_items
            SET system_text = '来源已失效，内容不可用', user_text = NULL,
              verification_state = 'invalidated', invalidated_at = ?, hidden_at = ?,
              version = version + 1, updated_at = ?
            WHERE account_id = ? AND id = ? AND origin = 'gpt' AND invalidated_at IS NULL
          `).run(now, now, now, input.accountId, itemId);
          invalidItemIds.push(itemId);
        } else {
          this.database.prepare(`
            UPDATE wr_weekly_review_items SET version = version + 1, updated_at = ?
            WHERE account_id = ? AND id = ? AND origin = 'gpt' AND invalidated_at IS NULL
          `).run(now, input.accountId, itemId);
        }
      }
      const messageSources = this.database.prepare(`
        SELECT thread_id, message_id, source_ref FROM wr_weekly_qa_message_sources
        WHERE account_id = ? AND weekly_review_id = ? AND invalidated_at IS NULL
      `).all(input.accountId, input.reviewId) as Array<{
        thread_id: string; message_id: string; source_ref: string;
      }>;
      const invalidMessageSources = messageSources
        .filter((source) => !eligible.has(source.source_ref));
      const affectedMessageIds = [...new Set(invalidMessageSources
        .map((source) => source.message_id))];
      for (const source of invalidMessageSources) {
        this.database.prepare(`
          UPDATE wr_weekly_qa_message_sources SET invalidated_at = ?
          WHERE account_id = ? AND message_id = ? AND source_ref = ?
            AND invalidated_at IS NULL
        `).run(now, input.accountId, source.message_id, source.source_ref);
      }
      const invalidMessageIds: string[] = [];
      for (const messageId of affectedMessageIds) {
        const remaining = this.database.prepare(`
          SELECT count(*) AS count FROM wr_weekly_qa_message_sources
          WHERE account_id = ? AND message_id = ? AND invalidated_at IS NULL
        `).get(input.accountId, messageId) as { count: number };
        if (remaining.count === 0) {
          this.database.prepare(`
            UPDATE wr_weekly_qa_messages
            SET body_text = NULL, answer_status = 'invalidated', invalidated_at = ?,
              version = version + 1
            WHERE account_id = ? AND id = ? AND role = 'assistant' AND invalidated_at IS NULL
          `).run(now, input.accountId, messageId);
          invalidMessageIds.push(messageId);
        } else {
          this.database.prepare(`
            UPDATE wr_weekly_qa_messages SET version = version + 1
            WHERE account_id = ? AND id = ? AND role = 'assistant' AND invalidated_at IS NULL
          `).run(input.accountId, messageId);
        }
      }
      for (const threadId of [...new Set(invalidMessageSources
        .map((source) => source.thread_id))]) {
        this.database.prepare(`
          UPDATE wr_weekly_qa_threads SET version = version + 1, updated_at = ?
          WHERE account_id = ? AND id = ?
        `).run(now, input.accountId, threadId);
      }
      const stale = review.current_system_version > 0
        && review.source_snapshot_digest !== input.snapshot.digest;
      const canRestoreReady = review.current_system_version > 0
        && review.source_snapshot_digest === input.snapshot.digest;
      const nextStatus = stale ? "stale"
        : review.status === "stale" && canRestoreReady ? "ready" : review.status;
      if (stale || invalidRunSources.length > 0 || invalidSystemSources.length > 0
        || invalidItemSources.length > 0 || invalidMessageSources.length > 0) {
        const removedSourceRefs = new Set([
          ...invalidRunSources.map((source) => source.source_ref),
          ...invalidSystemSources.map((source) => source.source_ref),
          ...invalidItemSources.map((source) => source.source_ref),
          ...invalidMessageSources.map((source) => source.source_ref)
        ]);
        this.database.prepare(`
          UPDATE wr_weekly_qa_runs
          SET state = 'superseded', lease_owner = NULL, lease_expires_at = NULL,
            completed_at = COALESCE(completed_at, ?), error_code = 'weekly_source_changed'
          WHERE account_id = ? AND weekly_review_id = ?
            AND state IN ('queued', 'processing', 'verifying')
        `).run(now, input.accountId, input.reviewId);
        const qaRuns = this.database.prepare(`
          SELECT id, source_manifest_json FROM wr_weekly_qa_runs
          WHERE account_id = ? AND weekly_review_id = ?
        `).all(input.accountId, input.reviewId) as Array<{
          id: string; source_manifest_json: string;
        }>;
        for (const qaRun of qaRuns) {
          this.database.prepare(`
            UPDATE wr_weekly_qa_runs SET source_manifest_json = ?
            WHERE account_id = ? AND id = ?
          `).run(redactWorkWeeklyQaManifest(qaRun.source_manifest_json, removedSourceRefs),
            input.accountId, qaRun.id);
        }
      }
      if (nextStatus !== review.status || invalidItemSources.length > 0
        || invalidMessageSources.length > 0 || invalidSystemSources.length > 0
        || invalidRunSources.length > 0
        || review.observed_through !== input.snapshot.scope.observedThrough
        || review.window_complete !== (input.snapshot.scope.windowComplete ? 1 : 0)) {
        this.database.prepare(`
          UPDATE wr_weekly_reviews SET status = ?, observed_through = ?, window_complete = ?,
            version = version + 1, updated_at = ? WHERE account_id = ? AND id = ?
        `).run(nextStatus, input.snapshot.scope.observedThrough,
          input.snapshot.scope.windowComplete ? 1 : 0, now, input.accountId, input.reviewId);
      }
      return {
        review: reviewFromRow(this.requireReviewRow(input.accountId, input.reviewId)),
        stale,
        invalidatedRunIds: invalidRunIds,
        invalidatedSystemItemIds: invalidSystemItemIds,
        invalidatedItemIds: invalidItemIds,
        invalidatedMessageIds: invalidMessageIds
      };
    });
    return run.immediate();
  }

  updateItem(input: {
    accountId: string; reviewId: string; itemId: string; operationKey: string;
    expectedVersion: number; text?: string; hidden?: boolean; sortOrder?: number;
  }) {
    const requestFingerprint = fingerprint({ type: "update_item", ...input,
      accountId: undefined });
    const run = this.database.transaction(() => {
      const replay = this.replayOperation(input.accountId, input.operationKey, requestFingerprint);
      if (replay) {
        const row = this.database.prepare(`SELECT * FROM wr_weekly_review_items WHERE id = ? AND account_id = ?`)
          .get(input.itemId, input.accountId) as ItemRow | undefined;
        if (!row) throw new WorkWeeklyNotFoundError();
        return { item: itemFromRow(this.database, row), reused: true };
      }
      this.requireReviewRow(input.accountId, input.reviewId);
      const row = this.database.prepare(`
        SELECT * FROM wr_weekly_review_items
        WHERE id = ? AND account_id = ? AND weekly_review_id = ?
      `).get(input.itemId, input.accountId, input.reviewId) as ItemRow | undefined;
      if (!row) throw new WorkWeeklyNotFoundError();
      if (row.version !== input.expectedVersion) throw new WorkWeeklyVersionConflictError(row.version);
      if (row.invalidated_at && input.hidden === false) {
        throw new WorkWeeklyConflictError("weekly_item_invalidated");
      }
      const now = this.now();
      this.database.prepare(`
        UPDATE wr_weekly_review_items
        SET user_text = CASE WHEN ? IS NULL THEN user_text ELSE ? END,
          verification_state = CASE
            WHEN ? IS NULL OR origin = 'user_note' THEN verification_state
            ELSE 'qualified'
          END,
          user_edited_at = CASE WHEN ? IS NULL THEN user_edited_at ELSE ? END,
          hidden_at = CASE WHEN ? IS NULL THEN hidden_at WHEN ? = 1 THEN ? ELSE NULL END,
          sort_order = COALESCE(?, sort_order), version = version + 1, updated_at = ?
        WHERE id = ? AND account_id = ? AND weekly_review_id = ? AND version = ?
      `).run(input.text ?? null, input.text ?? null, input.text ?? null,
        input.text ?? null, now, input.hidden === undefined ? null : input.hidden ? 1 : 0,
        input.hidden ? 1 : 0, now, input.sortOrder ?? null, now,
        input.itemId, input.accountId, input.reviewId, input.expectedVersion);
      this.database.prepare(`
        UPDATE wr_weekly_reviews SET version = version + 1, updated_at = ?
        WHERE account_id = ? AND id = ?
      `).run(now, input.accountId, input.reviewId);
      const item = itemFromRow(this.database, this.database.prepare(`
        SELECT * FROM wr_weekly_review_items WHERE id = ?
      `).get(input.itemId) as ItemRow);
      this.recordOperation({
        accountId: input.accountId, operationKey: input.operationKey,
        reviewId: input.reviewId, targetId: input.itemId, operationType: "update_item",
        requestFingerprint, result: { reviewId: input.reviewId, itemId: input.itemId,
          itemVersion: item.version }, now
      });
      return { item, reused: false };
    });
    return run.immediate();
  }

  createUserNote(input: {
    accountId: string; reviewId: string; operationKey: string; expectedVersion: number;
    section: WorkWeeklyReviewItem["section"]; text: string; sortOrder: number;
  }) {
    const requestFingerprint = fingerprint({ type: "create_note", ...input,
      accountId: undefined });
    const run = this.database.transaction(() => {
      const replay = this.replayOperation(input.accountId, input.operationKey, requestFingerprint);
      if (replay) {
        const itemId = String(replay.itemId);
        const row = this.database.prepare(`SELECT * FROM wr_weekly_review_items WHERE id = ? AND account_id = ?`)
          .get(itemId, input.accountId) as ItemRow | undefined;
        if (!row) throw new WorkWeeklyNotFoundError();
        return { item: itemFromRow(this.database, row), reused: true };
      }
      const review = this.requireReviewRow(input.accountId, input.reviewId);
      if (review.version !== input.expectedVersion) throw new WorkWeeklyVersionConflictError(review.version);
      const now = this.now();
      const itemId = this.nextId("wrwin");
      this.database.prepare(`
        INSERT INTO wr_weekly_review_items(
          id, account_id, weekly_review_id, section_kind, origin, user_text,
          verification_state, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'user_note', ?, 'user_authored', ?, ?, ?)
      `).run(itemId, input.accountId, input.reviewId, input.section,
        input.text, input.sortOrder, now, now);
      this.database.prepare(`
        UPDATE wr_weekly_reviews SET version = version + 1, updated_at = ?
        WHERE account_id = ? AND id = ? AND version = ?
      `).run(now, input.accountId, input.reviewId, input.expectedVersion);
      this.recordOperation({
        accountId: input.accountId, operationKey: input.operationKey,
        reviewId: input.reviewId, targetId: itemId, operationType: "create_note",
        requestFingerprint, result: { reviewId: input.reviewId, itemId }, now
      });
      return { item: itemFromRow(this.database, this.database.prepare(`
        SELECT * FROM wr_weekly_review_items WHERE id = ?
      `).get(itemId) as ItemRow), reused: false };
    });
    return run.immediate();
  }

  resetToCurrentSystemVersion(input: {
    accountId: string; reviewId: string; operationKey: string; expectedVersion: number;
  }) {
    return this.reviewOperation(input, "reset", (review) => {
      const now = this.now();
      this.database.prepare(`
        DELETE FROM wr_weekly_review_items
        WHERE account_id = ? AND weekly_review_id = ? AND origin = 'gpt'
          AND system_version <> ?
      `).run(input.accountId, input.reviewId, review.current_system_version);
      this.database.prepare(`
        UPDATE wr_weekly_review_items
        SET user_text = NULL, user_edited_at = NULL, hidden_at = NULL,
          verification_state = (
            SELECT verification_state FROM wr_weekly_system_items s
            WHERE s.id = wr_weekly_review_items.system_item_id
          ), sort_order = (
            SELECT sort_order FROM wr_weekly_system_items s
            WHERE s.id = wr_weekly_review_items.system_item_id
          ), version = version + 1, updated_at = ?
        WHERE account_id = ? AND weekly_review_id = ? AND origin = 'gpt'
          AND system_version = ? AND invalidated_at IS NULL
      `).run(now, input.accountId, input.reviewId, review.current_system_version);
    });
  }

  deleteUserNote(input: {
    accountId: string; reviewId: string; itemId: string; operationKey: string;
    expectedVersion: number;
  }) {
    const requestFingerprint = fingerprint({ type: "delete_note", ...input,
      accountId: undefined });
    const run = this.database.transaction(() => {
      const replay = this.replayOperation(input.accountId, input.operationKey, requestFingerprint);
      if (replay) return { deleted: true, reused: true };
      this.requireReviewRow(input.accountId, input.reviewId);
      const row = this.database.prepare(`
        SELECT * FROM wr_weekly_review_items WHERE account_id = ? AND weekly_review_id = ? AND id = ?
      `).get(input.accountId, input.reviewId, input.itemId) as ItemRow | undefined;
      if (!row || row.origin !== "user_note") throw new WorkWeeklyNotFoundError();
      if (row.version !== input.expectedVersion) throw new WorkWeeklyVersionConflictError(row.version);
      const now = this.now();
      this.database.prepare(`DELETE FROM wr_weekly_review_items WHERE id = ? AND account_id = ?`)
        .run(input.itemId, input.accountId);
      this.database.prepare(`
        UPDATE wr_weekly_reviews SET version = version + 1, updated_at = ?
        WHERE account_id = ? AND id = ?
      `).run(now, input.accountId, input.reviewId);
      this.recordOperation({
        accountId: input.accountId, operationKey: input.operationKey,
        reviewId: input.reviewId, targetId: input.itemId, operationType: "delete_note",
        requestFingerprint, result: { reviewId: input.reviewId, itemId: input.itemId,
          deleted: true }, now
      });
      return { deleted: true, reused: false };
    });
    return run.immediate();
  }

  private reviewOperation(
    input: { accountId: string; reviewId: string; operationKey: string; expectedVersion: number },
    operationType: "reset",
    mutation: (review: ReviewRow) => void
  ) {
    const requestFingerprint = fingerprint({ type: operationType, ...input, accountId: undefined });
    const run = this.database.transaction(() => {
      const replay = this.replayOperation(input.accountId, input.operationKey, requestFingerprint);
      if (replay) return { review: this.getReview(input.accountId, input.reviewId), reused: true };
      const review = this.requireReviewRow(input.accountId, input.reviewId);
      if (review.version !== input.expectedVersion) throw new WorkWeeklyVersionConflictError(review.version);
      mutation(review);
      const now = this.now();
      this.database.prepare(`
        UPDATE wr_weekly_reviews SET version = version + 1, updated_at = ?
        WHERE account_id = ? AND id = ? AND version = ?
      `).run(now, input.accountId, input.reviewId, input.expectedVersion);
      this.recordOperation({
        accountId: input.accountId, operationKey: input.operationKey,
        reviewId: input.reviewId, operationType, requestFingerprint,
        result: { reviewId: input.reviewId }, now
      });
      return { review: this.getReview(input.accountId, input.reviewId), reused: false };
    });
    return run.immediate();
  }

  deleteReview(input: {
    accountId: string; reviewId: string; operationKey: string; expectedVersion: number;
  }) {
    const requestFingerprint = fingerprint({ type: "delete_review", ...input,
      accountId: undefined });
    const run = this.database.transaction(() => {
      const replay = this.replayOperation(input.accountId, input.operationKey, requestFingerprint);
      if (replay) return { deleted: true, reused: true };
      const review = this.requireReviewRow(input.accountId, input.reviewId);
      if (review.version !== input.expectedVersion) throw new WorkWeeklyVersionConflictError(review.version);
      const now = this.now();
      this.recordOperation({
        accountId: input.accountId, operationKey: input.operationKey,
        reviewId: input.reviewId, operationType: "delete_review", requestFingerprint,
        result: { reviewId: input.reviewId, deleted: true }, now
      });
      this.database.prepare(`DELETE FROM wr_weekly_qa_threads WHERE account_id = ? AND weekly_review_id = ?`)
        .run(input.accountId, input.reviewId);
      this.database.prepare(`DELETE FROM wr_weekly_review_items WHERE account_id = ? AND weekly_review_id = ?`)
        .run(input.accountId, input.reviewId);
      this.database.prepare(`DELETE FROM wr_weekly_system_versions WHERE account_id = ? AND weekly_review_id = ?`)
        .run(input.accountId, input.reviewId);
      this.database.prepare(`DELETE FROM wr_weekly_run_sources WHERE account_id = ? AND weekly_review_id = ?`)
        .run(input.accountId, input.reviewId);
      this.database.prepare(`
        DELETE FROM wr_weekly_review_runs WHERE account_id = ? AND weekly_review_id = ?
      `).run(input.accountId, input.reviewId);
      this.database.prepare(`
        UPDATE wr_weekly_reviews SET status = 'deleted', deleted_at = ?, version = version + 1,
          updated_at = ? WHERE account_id = ? AND id = ?
      `).run(now, now, input.accountId, input.reviewId);
      this.database.prepare(`
        INSERT INTO wr_weekly_tombstones(account_id, weekly_review_id, last_version, deleted_at)
        VALUES (?, ?, ?, ?)
      `).run(input.accountId, input.reviewId, review.version + 1, now);
      return { deleted: true, reused: false };
    });
    return run.immediate();
  }

  getQaThread(accountId: string, reviewId: string) {
    this.requireReviewRow(accountId, reviewId);
    const row = this.database.prepare(`
      SELECT * FROM wr_weekly_qa_threads
      WHERE account_id = ? AND weekly_review_id = ? AND deleted_at IS NULL
    `).get(accountId, reviewId) as ThreadRow | undefined;
    if (!row) return null;
    const messages = (this.database.prepare(`
      SELECT * FROM wr_weekly_qa_messages
      WHERE account_id = ? AND weekly_review_id = ? AND thread_id = ?
      ORDER BY created_at, id
    `).all(accountId, reviewId, row.id) as MessageRow[])
      .map((message) => messageFromRow(this.database, message));
    return { thread: threadFromRow(row), messages };
  }

  private replayQaOperation(accountId: string, operationKey: string, expectedFingerprint: string) {
    const row = this.database.prepare(`
      SELECT request_fingerprint, result_json FROM wr_weekly_qa_operations
      WHERE account_id = ? AND operation_key = ?
    `).get(accountId, operationKey) as {
      request_fingerprint: string; result_json: string;
    } | undefined;
    if (!row) return null;
    if (row.request_fingerprint !== expectedFingerprint) {
      throw new WorkWeeklyConflictError("weekly_qa_operation_conflict");
    }
    return JSON.parse(row.result_json) as Record<string, unknown>;
  }

  queueQuestion(input: {
    accountId: string; reviewId: string; snapshot: WorkWeeklySourceSnapshot;
    question: string; operationKey: string; expectedVersion: number | null;
  }) {
    if (input.snapshot.accountId !== input.accountId) {
      throw new WorkWeeklyConflictError("weekly_snapshot_account_mismatch");
    }
    const requestFingerprint = fingerprint({
      type: "ask", reviewId: input.reviewId, question: input.question,
      expectedVersion: input.expectedVersion
    });
    const run = this.database.transaction(() => {
      const replay = this.replayQaOperation(input.accountId, input.operationKey, requestFingerprint);
      if (replay) {
        const current = this.getQaThread(input.accountId, input.reviewId);
        if (!current) throw new WorkWeeklyQaNotFoundError();
        const runRow = this.database.prepare(`SELECT * FROM wr_weekly_qa_runs WHERE id = ?`)
          .get(String(replay.runId)) as QaRunRow | undefined;
        if (!runRow) throw new WorkWeeklyQaNotFoundError();
        return { ...current, run: qaRunFromRow(runRow), reused: true };
      }
      const review = this.requireReviewRow(input.accountId, input.reviewId);
      if (review.status !== "ready") throw new WorkWeeklyConflictError("weekly_not_ready");
      if (review.source_snapshot_digest !== input.snapshot.digest) {
        throw new WorkWeeklyConflictError("weekly_source_changed");
      }
      const now = this.now();
      let thread = this.database.prepare(`
        SELECT * FROM wr_weekly_qa_threads WHERE account_id = ? AND weekly_review_id = ?
      `).get(input.accountId, input.reviewId) as ThreadRow | undefined;
      if (!thread) {
        if (input.expectedVersion !== null) throw new WorkWeeklyVersionConflictError(0);
        const threadId = this.nextId("wrwqt");
        this.database.prepare(`
          INSERT INTO wr_weekly_qa_threads(
            id, account_id, weekly_review_id, source_snapshot_digest, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(threadId, input.accountId, input.reviewId, input.snapshot.digest, now, now);
        thread = this.database.prepare(`SELECT * FROM wr_weekly_qa_threads WHERE id = ?`)
          .get(threadId) as ThreadRow;
      } else if (input.expectedVersion === null || thread.version !== input.expectedVersion) {
        throw new WorkWeeklyVersionConflictError(thread.version);
      }
      this.database.prepare(`
        UPDATE wr_weekly_qa_runs SET state = 'superseded', lease_owner = NULL,
          lease_expires_at = NULL, completed_at = COALESCE(completed_at, ?),
          error_code = 'weekly_qa_superseded'
        WHERE account_id = ? AND thread_id = ? AND state IN ('queued', 'processing', 'verifying')
      `).run(now, input.accountId, thread.id);
      const questionId = this.nextId("wrwqm");
      this.database.prepare(`
        INSERT INTO wr_weekly_qa_messages(
          id, account_id, weekly_review_id, thread_id, role, body_text,
          source_snapshot_digest, created_at
        ) VALUES (?, ?, ?, ?, 'user', ?, ?, ?)
      `).run(questionId, input.accountId, input.reviewId, thread.id,
        input.question, input.snapshot.digest, now);
      const runVersion = thread.current_run_version + 1;
      const runId = this.nextId("wrwqr");
      this.database.prepare(`
        INSERT INTO wr_weekly_qa_runs(
          id, account_id, weekly_review_id, thread_id, question_message_id,
          run_version, source_snapshot_digest, source_manifest_json, state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
      `).run(runId, input.accountId, input.reviewId, thread.id, questionId,
        runVersion, input.snapshot.digest, JSON.stringify({
          inputPackDigest: input.snapshot.inputPackDigest,
          allowlistedSourceRefs: [...input.snapshot.allowlistedSourceRefs].sort()
        }), now);
      this.database.prepare(`
        UPDATE wr_weekly_qa_threads SET current_run_version = ?, source_snapshot_digest = ?,
          version = version + 1, updated_at = ? WHERE id = ?
      `).run(runVersion, input.snapshot.digest, now, thread.id);
      this.database.prepare(`
        INSERT INTO wr_weekly_qa_operations(
          account_id, operation_key, weekly_review_id, thread_id, operation_type,
          request_fingerprint, result_json, created_at
        ) VALUES (?, ?, ?, ?, 'ask', ?, ?, ?)
      `).run(input.accountId, input.operationKey, input.reviewId, thread.id,
        requestFingerprint, JSON.stringify({ threadId: thread.id, questionId, runId, runVersion }), now);
      const current = this.getQaThread(input.accountId, input.reviewId)!;
      return {
        ...current,
        run: qaRunFromRow(this.database.prepare(`SELECT * FROM wr_weekly_qa_runs WHERE id = ?`)
          .get(runId) as QaRunRow),
        reused: false
      };
    });
    return run.immediate();
  }

  claimQaRun(input: { accountId: string; runId: string; leaseOwner: string; leaseMs: number }) {
    const now = this.now();
    const leaseExpiresAt = new Date(Date.parse(now) + input.leaseMs).toISOString();
    const run = this.database.transaction(() => {
      const row = this.database.prepare(`SELECT * FROM wr_weekly_qa_runs WHERE account_id = ? AND id = ?`)
        .get(input.accountId, input.runId) as QaRunRow | undefined;
      if (!row) throw new WorkWeeklyQaNotFoundError();
      this.requireReviewRow(input.accountId, row.weekly_review_id);
      const result = this.database.prepare(`
        UPDATE wr_weekly_qa_runs SET state = 'processing', lease_owner = ?,
          lease_expires_at = ?, started_at = ? WHERE account_id = ? AND id = ?
          AND (state = 'queued'
            OR (state IN ('processing', 'verifying') AND lease_expires_at <= ?))
      `).run(input.leaseOwner, leaseExpiresAt, now, input.accountId, input.runId, now);
      if (result.changes !== 1) throw new WorkWeeklyLeaseLostError();
      return WorkWeeklyQaRunFenceSchema.parse({
        weeklyReviewId: row.weekly_review_id, threadId: row.thread_id,
        runId: row.id, runVersion: row.run_version, leaseOwner: input.leaseOwner,
        leaseExpiresAt, sourceSnapshotDigest: row.source_snapshot_digest
      });
    });
    return run.immediate();
  }

  renewQaLease(input: WorkWeeklyQaRunFence & { leaseMs: number }) {
    const now = this.now();
    const leaseExpiresAt = new Date(Date.parse(now) + input.leaseMs).toISOString();
    const result = this.database.prepare(`
      UPDATE wr_weekly_qa_runs SET lease_expires_at = ?
      WHERE id = ? AND thread_id = ? AND run_version = ? AND lease_owner = ?
        AND lease_expires_at = ? AND state IN ('processing', 'verifying')
        AND lease_expires_at > ?
    `).run(leaseExpiresAt, input.runId, input.threadId, input.runVersion,
      input.leaseOwner, input.leaseExpiresAt, now);
    if (result.changes !== 1) throw new WorkWeeklyLeaseLostError();
    return WorkWeeklyQaRunFenceSchema.parse({ ...input, leaseExpiresAt });
  }

  publishQaAnswer(input: {
    accountId: string; fence: WorkWeeklyQaRunFence; currentSnapshot: WorkWeeklySourceSnapshot;
    text: string; answerStatus: "answered" | "partially_answered" | "insufficient_evidence";
    sourceRefs: string[]; providerProfile: string; promptVersion: string;
    verifierProfile: string | null;
  }) {
    if (input.currentSnapshot.accountId !== input.accountId) {
      throw new WorkWeeklyConflictError("weekly_snapshot_account_mismatch");
    }
    const run = this.database.transaction(() => {
      const now = this.now();
      const review = this.requireReviewRow(input.accountId, input.fence.weeklyReviewId);
      const row = this.database.prepare(`SELECT * FROM wr_weekly_qa_runs WHERE account_id = ? AND id = ?`)
        .get(input.accountId, input.fence.runId) as QaRunRow | undefined;
      if (!row || row.thread_id !== input.fence.threadId
        || row.run_version !== input.fence.runVersion
        || row.lease_owner !== input.fence.leaseOwner
        || row.lease_expires_at !== input.fence.leaseExpiresAt
        || !["processing", "verifying"].includes(row.state)
        || row.lease_expires_at <= now) throw new WorkWeeklyLeaseLostError();
      const liveSnapshot = this.liveSnapshot(input.accountId, review, now);
      const storedManifest = sourcePackManifest(row.source_manifest_json);
      if (!storedManifest.allowlistedSourceRefs
        || input.currentSnapshot.inputPackDigest !== storedManifest.inputPackDigest
        || !sameSourceRefs(input.currentSnapshot.allowlistedSourceRefs,
          storedManifest.allowlistedSourceRefs)) {
        throw new WorkWeeklyConflictError("weekly_input_pack_mismatch");
      }
      if (review.source_snapshot_digest !== input.currentSnapshot.digest
        || input.currentSnapshot.digest !== input.fence.sourceSnapshotDigest
        || liveSnapshot.digest !== input.fence.sourceSnapshotDigest
        || liveSnapshot.inputPackDigest !== storedManifest.inputPackDigest
        || !sameSourceRefs(liveSnapshot.allowlistedSourceRefs,
          storedManifest.allowlistedSourceRefs)) {
        this.database.prepare(`
          UPDATE wr_weekly_qa_runs SET state = 'superseded', lease_owner = NULL,
            lease_expires_at = NULL, completed_at = ?, error_code = 'weekly_source_changed'
          WHERE id = ?
        `).run(now, row.id);
        this.database.prepare(`
          UPDATE wr_weekly_reviews SET status = 'stale', version = version + 1, updated_at = ?
          WHERE id = ? AND account_id = ?
        `).run(now, review.id, input.accountId);
        return { sourceChanged: true as const };
      }
      const callerAllowlist = new Set(input.currentSnapshot.allowlistedSourceRefs);
      const liveAllowlist = new Set(liveSnapshot.allowlistedSourceRefs);
      const storedAllowlist = new Set(storedManifest.allowlistedSourceRefs);
      if (input.sourceRefs.some((ref) => !callerAllowlist.has(ref)
        || !liveAllowlist.has(ref) || !storedAllowlist.has(ref))) {
        throw new WorkWeeklyConflictError("weekly_source_not_allowlisted");
      }
      const messageId = this.nextId("wrwqm");
      this.database.prepare(`
        INSERT INTO wr_weekly_qa_messages(
          id, account_id, weekly_review_id, thread_id, question_message_id,
          role, body_text, answer_status, source_snapshot_digest,
          provider_profile, prompt_version, verifier_profile, created_at
        ) VALUES (?, ?, ?, ?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?)
      `).run(messageId, input.accountId, review.id, row.thread_id,
        row.question_message_id, input.text, input.answerStatus, liveSnapshot.digest,
        input.providerProfile, input.promptVersion, input.verifierProfile, now);
      for (const [position, ref] of input.sourceRefs.entries()) {
        const identity = identityForRef(liveSnapshot, ref);
        this.database.prepare(`
          INSERT INTO wr_weekly_qa_message_sources(
            account_id, weekly_review_id, thread_id, message_id, position,
            source_ref, source_kind, source_entity_id, source_version,
            meeting_id, todo_id, publication_id, segment_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(input.accountId, review.id, row.thread_id, messageId, position,
          identity.sourceRef, identity.sourceKind, identity.sourceId, identity.version,
          meetingIdForIdentity(liveSnapshot, identity),
          todoIdForIdentity(liveSnapshot, identity), identity.publicationId,
          identity.segmentId);
      }
      this.database.prepare(`
        UPDATE wr_weekly_qa_runs SET state = 'completed', lease_owner = NULL,
          lease_expires_at = NULL, provider_profile = ?, prompt_version = ?,
          verifier_profile = ?, completed_at = ?, error_code = NULL WHERE id = ?
      `).run(input.providerProfile, input.promptVersion, input.verifierProfile, now, row.id);
      this.database.prepare(`
        UPDATE wr_weekly_qa_threads SET version = version + 1, updated_at = ? WHERE id = ?
      `).run(now, row.thread_id);
      return { sourceChanged: false as const, message: messageFromRow(this.database, this.database.prepare(`
        SELECT * FROM wr_weekly_qa_messages WHERE id = ?
      `).get(messageId) as MessageRow) };
    });
    const result = run.immediate();
    if (result.sourceChanged) throw new WorkWeeklyConflictError("weekly_source_changed");
    return result.message;
  }

  markQaRunFailed(input: {
    accountId: string; fence: WorkWeeklyQaRunFence; errorCode: string;
  }) {
    const now = this.now();
    const run = this.database.transaction(() => {
      const row = this.database.prepare(`
        SELECT * FROM wr_weekly_qa_runs WHERE account_id = ? AND id = ?
      `).get(input.accountId, input.fence.runId) as QaRunRow | undefined;
      if (!row) throw new WorkWeeklyLeaseLostError();
      const result = this.database.prepare(`
        UPDATE wr_weekly_qa_runs SET state = 'failed', lease_owner = NULL,
          lease_expires_at = NULL, completed_at = ?, error_code = ?
        WHERE account_id = ? AND id = ? AND thread_id = ? AND run_version = ?
          AND lease_owner = ? AND lease_expires_at = ?
          AND state IN ('processing', 'verifying') AND lease_expires_at > ?
      `).run(now, input.errorCode, input.accountId, input.fence.runId,
        input.fence.threadId, input.fence.runVersion, input.fence.leaseOwner,
        input.fence.leaseExpiresAt, now);
      if (result.changes !== 1) throw new WorkWeeklyLeaseLostError();
      this.database.prepare(`
        INSERT INTO wr_weekly_qa_messages(
          id, account_id, weekly_review_id, thread_id, question_message_id,
          role, body_text, answer_status, source_snapshot_digest, created_at
        ) VALUES (?, ?, ?, ?, ?, 'assistant', '回答生成失败，请重试。', 'failed', ?, ?)
      `).run(this.nextId("wrwqm"), input.accountId, row.weekly_review_id, row.thread_id,
        row.question_message_id, row.source_snapshot_digest, now);
      this.database.prepare(`
        UPDATE wr_weekly_qa_threads SET version = version + 1, updated_at = ?
        WHERE account_id = ? AND id = ?
      `).run(now, input.accountId, row.thread_id);
    });
    run.immediate();
  }

  listRecoverableQaRuns(now = this.now(), limit = 100) {
    return (this.database.prepare(`
      SELECT * FROM wr_weekly_qa_runs
      WHERE state = 'queued' OR (state IN ('processing', 'verifying') AND lease_expires_at <= ?)
      ORDER BY created_at, id LIMIT ?
    `).all(now, limit) as QaRunRow[]).map(qaRunFromRow);
  }

  clearQaThread(input: {
    accountId: string; reviewId: string; operationKey: string; expectedVersion: number;
  }) {
    const requestFingerprint = fingerprint({ type: "clear", reviewId: input.reviewId,
      expectedVersion: input.expectedVersion });
    const run = this.database.transaction(() => {
      const replay = this.replayQaOperation(input.accountId, input.operationKey, requestFingerprint);
      if (replay) return { cleared: true, reused: true };
      this.requireReviewRow(input.accountId, input.reviewId);
      const thread = this.database.prepare(`
        SELECT * FROM wr_weekly_qa_threads WHERE account_id = ? AND weekly_review_id = ?
      `).get(input.accountId, input.reviewId) as ThreadRow | undefined;
      if (!thread) throw new WorkWeeklyQaNotFoundError();
      if (thread.version !== input.expectedVersion) throw new WorkWeeklyVersionConflictError(thread.version);
      const now = this.now();
      this.database.prepare(`DELETE FROM wr_weekly_qa_messages WHERE account_id = ? AND thread_id = ?`)
        .run(input.accountId, thread.id);
      this.database.prepare(`
        DELETE FROM wr_weekly_qa_runs WHERE account_id = ? AND thread_id = ?
      `).run(input.accountId, thread.id);
      this.database.prepare(`
        DELETE FROM wr_weekly_qa_operations WHERE account_id = ? AND thread_id = ?
      `).run(input.accountId, thread.id);
      this.database.prepare(`
        UPDATE wr_weekly_qa_threads SET cleared_at = ?, version = version + 1, updated_at = ?
        WHERE account_id = ? AND id = ? AND version = ?
      `).run(now, now, input.accountId, thread.id, input.expectedVersion);
      this.database.prepare(`
        INSERT INTO wr_weekly_qa_operations(
          account_id, operation_key, weekly_review_id, thread_id, operation_type,
          request_fingerprint, result_json, created_at
        ) VALUES (?, ?, ?, ?, 'clear', ?, ?, ?)
      `).run(input.accountId, input.operationKey, input.reviewId, thread.id,
        requestFingerprint, JSON.stringify({ threadId: thread.id, cleared: true }), now);
      return { cleared: true, reused: false };
    });
    return run.immediate();
  }
}

export function createWorkWeeklyRepository(
  database: Database.Database,
  options?: Options
) {
  return new WorkWeeklyRepository(database, options);
}
