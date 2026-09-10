import type Database from "better-sqlite3";
import { WorkWeeklyGenerationQualitySchema } from "@/lib/domain/work-weekly";

/** Remove deleted identities without erasing the fact that the published version needs review. */
export function redactWorkWeeklyGenerationQuality(value: string | null, removedSourceRefs: ReadonlySet<string>) {
  if (value === null) return null;
  try {
    const quality = WorkWeeklyGenerationQualitySchema.parse(JSON.parse(value));
    return JSON.stringify({ ...quality, reviewIssues: quality.reviewIssues.map((issue) =>
      issue.sourceRef !== null && removedSourceRefs.has(issue.sourceRef)
        ? { sourceRef: null, reasonCode: "source_unavailable" } : issue) });
  } catch { return null; }
}

export function redactWorkWeeklyGenerationManifest(
  value: string,
  removedSourceRefs: ReadonlySet<string>
) {
  try {
    const manifest = JSON.parse(value) as Record<string, unknown>;
    if (!Array.isArray(manifest.identities)) return JSON.stringify({ erased: true });
    const identities = manifest.identities.filter((candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      const sourceRef = (candidate as Record<string, unknown>).sourceRef;
      return typeof sourceRef === "string" && !removedSourceRefs.has(sourceRef);
    });
    return identities.length > 0
      ? JSON.stringify({ ...manifest, identities })
      : JSON.stringify({ erased: true });
  } catch {
    return JSON.stringify({ erased: true });
  }
}

export function redactWorkWeeklyQaManifest(
  value: string,
  removedSourceRefs: ReadonlySet<string>
) {
  try {
    const manifest = JSON.parse(value) as Record<string, unknown>;
    if (!Array.isArray(manifest.allowlistedSourceRefs)) return JSON.stringify({ erased: true });
    const allowlistedSourceRefs = manifest.allowlistedSourceRefs.filter((sourceRef) =>
      typeof sourceRef === "string" && !removedSourceRefs.has(sourceRef));
    return allowlistedSourceRefs.length > 0
      ? JSON.stringify({ ...manifest, allowlistedSourceRefs })
      : JSON.stringify({ erased: true });
  } catch {
    return JSON.stringify({ erased: true });
  }
}

/** Caller owns the surrounding Meeting/Todo mutation transaction. */
export function invalidateWorkWeeklySourcesWithinTransaction(
  database: Database.Database,
  input: {
    accountId: string;
    now: string;
    meetingId?: string;
    todoId?: string;
  }
) {
  if (!database.inTransaction) {
    throw new Error("work_weekly_invalidation_requires_transaction");
  }
  if ((input.meetingId ? 1 : 0) + (input.todoId ? 1 : 0) !== 1) {
    throw new Error("work_weekly_invalidation_requires_one_source");
  }
  const column = input.meetingId ? "meeting_id" : "todo_id";
  const sourceId = input.meetingId ?? input.todoId!;
  const systemItemRows = database.prepare(`
    SELECT DISTINCT weekly_review_id, system_item_id
    FROM wr_weekly_system_item_sources
    WHERE account_id = ? AND ${column} = ? AND invalidated_at IS NULL
  `).all(input.accountId, sourceId) as Array<{
    weekly_review_id: string; system_item_id: string;
  }>;
  const itemRows = database.prepare(`
    SELECT DISTINCT weekly_review_id, item_id
    FROM wr_weekly_item_sources
    WHERE account_id = ? AND ${column} = ? AND invalidated_at IS NULL
  `).all(input.accountId, sourceId) as Array<{
    weekly_review_id: string; item_id: string;
  }>;
  const messageRows = database.prepare(`
    SELECT DISTINCT weekly_review_id, thread_id, message_id
    FROM wr_weekly_qa_message_sources
    WHERE account_id = ? AND ${column} = ? AND invalidated_at IS NULL
  `).all(input.accountId, sourceId) as Array<{
    weekly_review_id: string; thread_id: string; message_id: string;
  }>;
  const runRows = database.prepare(`
    SELECT DISTINCT weekly_review_id, run_id, source_ref
    FROM wr_weekly_run_sources
    WHERE account_id = ? AND ${column} = ?
  `).all(input.accountId, sourceId) as Array<{
    weekly_review_id: string; run_id: string; source_ref: string;
  }>;
  const matchedSourceRows = database.prepare(`
    SELECT weekly_review_id, source_ref FROM wr_weekly_system_item_sources
    WHERE account_id = ? AND ${column} = ?
    UNION
    SELECT weekly_review_id, source_ref FROM wr_weekly_item_sources
    WHERE account_id = ? AND ${column} = ?
    UNION
    SELECT weekly_review_id, source_ref FROM wr_weekly_qa_message_sources
    WHERE account_id = ? AND ${column} = ?
    UNION
    SELECT weekly_review_id, source_ref FROM wr_weekly_run_sources
    WHERE account_id = ? AND ${column} = ?
  `).all(input.accountId, sourceId, input.accountId, sourceId,
    input.accountId, sourceId, input.accountId, sourceId) as Array<{
      weekly_review_id: string; source_ref: string;
    }>;
  const invalidatedSystemItemIds: string[] = [];
  for (const row of systemItemRows) {
    database.prepare(`
      UPDATE wr_weekly_system_item_sources SET invalidated_at = ?
      WHERE account_id = ? AND system_item_id = ? AND ${column} = ?
        AND invalidated_at IS NULL
    `).run(input.now, input.accountId, row.system_item_id, sourceId);
    const remaining = database.prepare(`
      SELECT count(*) AS count FROM wr_weekly_system_item_sources
      WHERE account_id = ? AND system_item_id = ? AND invalidated_at IS NULL
    `).get(input.accountId, row.system_item_id) as { count: number };
    if (remaining.count === 0) {
      database.prepare(`
        UPDATE wr_weekly_system_items
        SET body_text = '来源已失效，内容不可用', erased_at = ?
        WHERE account_id = ? AND id = ? AND erased_at IS NULL
      `).run(input.now, input.accountId, row.system_item_id);
      invalidatedSystemItemIds.push(row.system_item_id);
    }
  }
  const invalidatedItemIds: string[] = [];
  for (const row of itemRows) {
    database.prepare(`
      UPDATE wr_weekly_item_sources SET invalidated_at = ?
      WHERE account_id = ? AND item_id = ? AND ${column} = ?
        AND invalidated_at IS NULL
    `).run(input.now, input.accountId, row.item_id, sourceId);
    const remaining = database.prepare(`
      SELECT count(*) AS count FROM wr_weekly_item_sources
      WHERE account_id = ? AND item_id = ? AND invalidated_at IS NULL
    `).get(input.accountId, row.item_id) as { count: number };
    if (remaining.count === 0) {
      database.prepare(`
        UPDATE wr_weekly_review_items
        SET system_text = '来源已失效，内容不可用', user_text = NULL,
          verification_state = 'invalidated', hidden_at = ?, invalidated_at = ?,
          version = version + 1, updated_at = ?
        WHERE account_id = ? AND id = ? AND origin = 'gpt' AND invalidated_at IS NULL
      `).run(input.now, input.now, input.now, input.accountId, row.item_id);
      invalidatedItemIds.push(row.item_id);
    } else {
      database.prepare(`
        UPDATE wr_weekly_review_items SET version = version + 1, updated_at = ?
        WHERE account_id = ? AND id = ? AND origin = 'gpt' AND invalidated_at IS NULL
      `).run(input.now, input.accountId, row.item_id);
    }
  }
  const invalidatedMessageIds: string[] = [];
  for (const row of messageRows) {
    database.prepare(`
      UPDATE wr_weekly_qa_message_sources SET invalidated_at = ?
      WHERE account_id = ? AND message_id = ? AND ${column} = ?
        AND invalidated_at IS NULL
    `).run(input.now, input.accountId, row.message_id, sourceId);
    const remaining = database.prepare(`
      SELECT count(*) AS count FROM wr_weekly_qa_message_sources
      WHERE account_id = ? AND message_id = ? AND invalidated_at IS NULL
    `).get(input.accountId, row.message_id) as { count: number };
    if (remaining.count === 0) {
      database.prepare(`
        UPDATE wr_weekly_qa_messages
        SET body_text = NULL, answer_status = 'invalidated', invalidated_at = ?,
          version = version + 1
        WHERE account_id = ? AND id = ? AND role = 'assistant' AND invalidated_at IS NULL
      `).run(input.now, input.accountId, row.message_id);
      invalidatedMessageIds.push(row.message_id);
    } else {
      database.prepare(`
        UPDATE wr_weekly_qa_messages SET version = version + 1
        WHERE account_id = ? AND id = ? AND role = 'assistant' AND invalidated_at IS NULL
      `).run(input.accountId, row.message_id);
    }
  }
  for (const threadId of [...new Set(messageRows.map((row) => row.thread_id))]) {
    database.prepare(`
      UPDATE wr_weekly_qa_threads SET version = version + 1, updated_at = ?
      WHERE account_id = ? AND id = ?
    `).run(input.now, input.accountId, threadId);
  }
  for (const runId of [...new Set(runRows.map((row) => row.run_id))]) {
    const removedSourceRefs = new Set(runRows
      .filter((row) => row.run_id === runId).map((row) => row.source_ref));
    const manifest = database.prepare(`
      SELECT source_manifest_json FROM wr_weekly_review_runs
      WHERE account_id = ? AND id = ?
    `).get(input.accountId, runId) as { source_manifest_json: string } | undefined;
    database.prepare(`
      UPDATE wr_weekly_review_runs
      SET state = 'superseded', lease_owner = NULL, lease_expires_at = NULL,
        completed_at = COALESCE(completed_at, ?), error_code = 'weekly_source_deleted'
      WHERE account_id = ? AND id = ? AND state IN ('queued', 'processing', 'verifying')
    `).run(input.now, input.accountId, runId);
    database.prepare(`
      UPDATE wr_weekly_review_runs SET source_manifest_json = ?
      WHERE account_id = ? AND id = ?
    `).run(manifest
      ? redactWorkWeeklyGenerationManifest(manifest.source_manifest_json, removedSourceRefs)
      : JSON.stringify({ erased: true }), input.accountId, runId);
    database.prepare(`
      DELETE FROM wr_weekly_run_sources
      WHERE account_id = ? AND run_id = ? AND ${column} = ?
    `).run(input.accountId, runId, sourceId);
  }
  const reviewIds = [...new Set([
    ...systemItemRows.map((row) => row.weekly_review_id),
    ...itemRows.map((row) => row.weekly_review_id),
    ...messageRows.map((row) => row.weekly_review_id),
    ...runRows.map((row) => row.weekly_review_id)
  ])];
  for (const reviewId of [...new Set(matchedSourceRows.map((row) => row.weekly_review_id))]) {
    const removedSourceRefs = new Set(matchedSourceRows
      .filter((row) => row.weekly_review_id === reviewId).map((row) => row.source_ref));
    const generationRuns = database.prepare(`
      SELECT id, source_manifest_json, quality_assessment_json FROM wr_weekly_review_runs
      WHERE account_id = ? AND weekly_review_id = ?
    `).all(input.accountId, reviewId) as Array<{
      id: string; source_manifest_json: string; quality_assessment_json: string | null;
    }>;
    for (const generationRun of generationRuns) {
      database.prepare(`
        UPDATE wr_weekly_review_runs SET source_manifest_json = ?, quality_assessment_json = ?
        WHERE account_id = ? AND id = ?
      `).run(redactWorkWeeklyGenerationManifest(
        generationRun.source_manifest_json, removedSourceRefs),
      redactWorkWeeklyGenerationQuality(generationRun.quality_assessment_json, removedSourceRefs),
      input.accountId, generationRun.id);
    }
    const qaRuns = database.prepare(`
      SELECT id, source_manifest_json FROM wr_weekly_qa_runs
      WHERE account_id = ? AND weekly_review_id = ?
    `).all(input.accountId, reviewId) as Array<{
      id: string; source_manifest_json: string;
    }>;
    for (const qaRun of qaRuns) {
      database.prepare(`
        UPDATE wr_weekly_qa_runs SET source_manifest_json = ?
        WHERE account_id = ? AND id = ?
      `).run(redactWorkWeeklyQaManifest(qaRun.source_manifest_json, removedSourceRefs),
        input.accountId, qaRun.id);
    }
  }
  for (const reviewId of reviewIds) {
    database.prepare(`
      UPDATE wr_weekly_qa_runs
      SET state = 'superseded', lease_owner = NULL, lease_expires_at = NULL,
        completed_at = COALESCE(completed_at, ?), error_code = 'weekly_source_deleted'
      WHERE account_id = ? AND weekly_review_id = ?
        AND state IN ('queued', 'processing', 'verifying')
    `).run(input.now, input.accountId, reviewId);
    database.prepare(`
      UPDATE wr_weekly_reviews SET status = 'stale', version = version + 1, updated_at = ?
      WHERE account_id = ? AND id = ? AND deleted_at IS NULL AND status <> 'deleted'
    `).run(input.now, input.accountId, reviewId);
  }
  return {
    reviewIds,
    invalidatedSystemItemIds,
    invalidatedItemIds,
    invalidatedMessageIds
  };
}

/** Marks only freshness/active runs; it never removes published text. */
export function markWorkWeeklySourceChangedWithinTransaction(
  database: Database.Database,
  input: {
    accountId: string;
    now: string;
    meetingId?: string;
    todoId?: string;
    projectId?: string;
  }
) {
  const supplied = [input.meetingId, input.todoId, input.projectId].filter(Boolean);
  if (supplied.length !== 1) throw new Error("work_weekly_change_requires_one_source");
  let predicate: string;
  let sourceId: string;
  if (input.meetingId) {
    predicate = "meeting_id = ?";
    sourceId = input.meetingId;
  } else if (input.todoId) {
    predicate = "todo_id = ?";
    sourceId = input.todoId;
  } else {
    predicate = "source_kind = 'project' AND source_entity_id = ?";
    sourceId = input.projectId!;
  }
  const rows = database.prepare(`
    SELECT DISTINCT weekly_review_id, run_id FROM wr_weekly_run_sources
    WHERE account_id = ? AND ${predicate}
  `).all(input.accountId, sourceId) as Array<{
    weekly_review_id: string;
    run_id: string;
  }>;
  for (const row of rows) {
    database.prepare(`
      UPDATE wr_weekly_review_runs
      SET state = 'superseded', lease_owner = NULL, lease_expires_at = NULL,
        completed_at = COALESCE(completed_at, ?), error_code = 'weekly_source_changed'
      WHERE account_id = ? AND id = ? AND state IN ('queued', 'processing', 'verifying')
    `).run(input.now, input.accountId, row.run_id);
  }
  const reviewIds = [...new Set(rows.map((row) => row.weekly_review_id))];
  for (const reviewId of reviewIds) {
    database.prepare(`
      UPDATE wr_weekly_qa_runs
      SET state = 'superseded', lease_owner = NULL, lease_expires_at = NULL,
        completed_at = COALESCE(completed_at, ?), error_code = 'weekly_source_changed'
      WHERE account_id = ? AND weekly_review_id = ?
        AND state IN ('queued', 'processing', 'verifying')
    `).run(input.now, input.accountId, reviewId);
    database.prepare(`
      UPDATE wr_weekly_reviews SET status = 'stale', version = version + 1, updated_at = ?
      WHERE account_id = ? AND id = ? AND deleted_at IS NULL
    `).run(input.now, input.accountId, reviewId);
  }
  return reviewIds;
}
