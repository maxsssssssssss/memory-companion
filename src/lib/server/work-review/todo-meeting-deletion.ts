import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

type ActiveLinkedTodoRow = {
  id: string;
  version: number;
  source_finding_id: string;
};

function activeLinkedTodos(
  database: Database.Database,
  accountId: string,
  meetingId: string
) {
  return database.prepare(`
    SELECT id, version, source_finding_id FROM wr_todos
    WHERE account_id = ? AND source_meeting_id = ?
      AND origin = 'meeting_finding' AND deleted_at IS NULL
    ORDER BY created_at, id
  `).all(accountId, meetingId) as ActiveLinkedTodoRow[];
}

function insertMeetingDeletionTodoEvent(
  database: Database.Database,
  input: {
    eventId: string;
    accountId: string;
    todoId: string;
    eventType: "todo.deleted" | "todo.detached_from_source";
    changedFields: string[];
    sourceFindingId: string;
    oldVersion: number;
    newVersion: number;
    now: string;
  }
) {
  database.prepare(`
    INSERT INTO wr_todo_events (
      event_id, account_id, todo_id, operation_key, event_type, payload_json, created_at
    ) VALUES (?, ?, ?, NULL, ?, ?, ?)
  `).run(
    input.eventId,
    input.accountId,
    input.todoId,
    input.eventType,
    JSON.stringify({
      todoId: input.todoId,
      changedFields: input.changedFields,
      sourceFindingId: input.sourceFindingId,
      oldVersion: input.oldVersion,
      newVersion: input.newVersion,
      occurredAt: input.now
    }),
    input.now
  );
}

/** These helpers never open a transaction; the caller must use the meeting deletion transaction. */
export function listActiveMeetingTodoIdsWithinTransaction(
  database: Database.Database,
  accountId: string,
  meetingId: string
) {
  return activeLinkedTodos(database, accountId, meetingId).map((row) => row.id);
}

export function deleteLinkedMeetingTodosWithinTransaction(
  database: Database.Database,
  input: { accountId: string; meetingId: string; now: string },
  options: { idFactory?: () => string } = {}
) {
  const idFactory = options.idFactory ?? randomUUID;
  const rows = activeLinkedTodos(database, input.accountId, input.meetingId);
  for (const row of rows) {
    const nextVersion = row.version + 1;
    const result = database.prepare(`
      UPDATE wr_todos
      SET deleted_at = ?, updated_at = ?, version = ?
      WHERE id = ? AND account_id = ? AND version = ? AND deleted_at IS NULL
    `).run(input.now, input.now, nextVersion, row.id, input.accountId, row.version);
    if (result.changes !== 1) throw new Error("work_todo_linked_delete_conflict");
    insertMeetingDeletionTodoEvent(database, {
      eventId: `wrte_${idFactory()}`,
      accountId: input.accountId,
      todoId: row.id,
      eventType: "todo.deleted",
      changedFields: ["deletedAt"],
      sourceFindingId: row.source_finding_id,
      oldVersion: row.version,
      newVersion: nextVersion,
      now: input.now
    });
  }
  return rows.map((row) => row.id);
}

export function detachLinkedMeetingTodosWithinTransaction(
  database: Database.Database,
  input: { accountId: string; meetingId: string; now: string },
  options: { idFactory?: () => string } = {}
) {
  const idFactory = options.idFactory ?? randomUUID;
  const rows = activeLinkedTodos(database, input.accountId, input.meetingId);
  for (const row of rows) {
    const nextVersion = row.version + 1;
    const result = database.prepare(`
      UPDATE wr_todos
      SET origin = 'detached_meeting_finding',
          source_meeting_id = NULL,
          source_finding_id = NULL,
          source_finding_version = NULL,
          source_finding_kind = NULL,
          source_owner_label = NULL,
          source_original_due_at = NULL,
          source_original_due_expression = NULL,
          source_action_basis = NULL,
          source_detached_at = ?,
          updated_at = ?, version = ?
      WHERE id = ? AND account_id = ? AND version = ? AND deleted_at IS NULL
    `).run(input.now, input.now, nextVersion, row.id, input.accountId, row.version);
    if (result.changes !== 1) throw new Error("work_todo_linked_detach_conflict");
    insertMeetingDeletionTodoEvent(database, {
      eventId: `wrte_${idFactory()}`,
      accountId: input.accountId,
      todoId: row.id,
      eventType: "todo.detached_from_source",
      changedFields: [
        "origin", "sourceMeetingId", "sourceFindingId", "sourceFindingVersion",
        "sourceFindingKind", "sourceOwnerLabel", "sourceOriginalDueAt",
        "sourceOriginalDueExpression", "sourceActionBasis", "sourceDetachedAt"
      ],
      sourceFindingId: row.source_finding_id,
      oldVersion: row.version,
      newVersion: nextVersion,
      now: input.now
    });
  }
  return rows.map((row) => row.id);
}
