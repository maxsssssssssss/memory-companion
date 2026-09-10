import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";

import {
  CreateManualWorkTodoRequestSchema,
  CreateWorkTodoFromFindingRequestSchema,
  SetWorkTodoMyDayRequestSchema,
  UpdateWorkTodoRequestSchema,
  WorkTodoDateSchema,
  WorkTodoSchema,
  WorkTodoVersionedOperationRequestSchema,
  WorkTodoViewSchema,
  type CreateManualWorkTodoRequest,
  type CreateWorkTodoFromFindingRequest,
  type SetWorkTodoMyDayRequest,
  type UpdateWorkTodoRequest,
  type WorkTodo,
  type WorkTodoDetail,
  type WorkTodoEventType,
  type WorkTodoResolvedSource,
  type WorkTodoSourceFindingKind,
  type WorkTodoView,
  type WorkTodoVersionedOperationRequest
} from "@/lib/domain/work-todo";
import {
  WorkMeetingCandidateStructuredDataSchema,
  WorkReviewIdSchema,
  type WorkMeetingActionBasis
} from "@/lib/domain/work-review";
import type { WorkProjectScopeFilter } from "@/lib/domain/work-project";

import {
  WorkReviewConflictError,
  WorkReviewVersionConflictError
} from "./repository";
import {
  deleteLinkedMeetingTodosWithinTransaction,
  detachLinkedMeetingTodosWithinTransaction,
  listActiveMeetingTodoIdsWithinTransaction
} from "./todo-meeting-deletion";
import {
  invalidateWorkWeeklySourcesWithinTransaction,
  markWorkWeeklySourceChangedWithinTransaction
} from "./weekly-invalidation";

export class WorkTodoNotFoundError extends Error {
  readonly code = "todo_not_found";
  constructor() {
    super("Work Todo not found");
  }
}

type TodoRepositoryOptions = {
  now?: () => string;
  idFactory?: () => string;
};

type TodoRow = {
  id: string;
  account_id: string;
  kind: "self" | "waiting_for_other";
  status: "open" | "completed";
  origin: "manual" | "meeting_finding" | "detached_meeting_finding";
  title: string;
  notes: string | null;
  owner_label: string | null;
  current_due_date: string | null;
  is_important: number;
  my_day_date: string | null;
  source_meeting_id: string | null;
  source_finding_id: string | null;
  source_finding_version: number | null;
  source_finding_kind: WorkTodoSourceFindingKind | null;
  source_owner_label: string | null;
  source_original_due_at: string | null;
  source_original_due_expression: string | null;
  source_action_basis: WorkMeetingActionBasis | null;
  source_detached_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  reopened_at: string | null;
  deleted_at: string | null;
};

type TodoOperationRow = {
  request_fingerprint: string;
  response_json: string;
};

type FindingSourceRow = {
  id: string;
  account_id: string;
  meeting_id: string;
  kind: string;
  title: string;
  body: string;
  structured_data_json: string;
  user_confirmed_at: string;
  version: number;
};

type EditableTodoFields = Pick<
  WorkTodo,
  "title" | "kind" | "notes" | "ownerLabel" | "currentDueDate" | "isImportant" | "myDayDate"
>;

export type CreateManualWorkTodoInput = CreateManualWorkTodoRequest & { accountId: string };
export type CreateWorkTodoFromFindingInput = CreateWorkTodoFromFindingRequest & {
  accountId: string;
  meetingId: string;
  findingId: string;
};
export type UpdateWorkTodoInput = UpdateWorkTodoRequest & {
  accountId: string;
  todoId: string;
};
export type WorkTodoVersionedOperationInput = WorkTodoVersionedOperationRequest & {
  accountId: string;
  todoId: string;
};
export type SetWorkTodoMyDayInput = SetWorkTodoMyDayRequest & {
  accountId: string;
  todoId: string;
};
export type WorkTodoMutationResult = { todo: WorkTodo; reused: boolean };
export type WorkMeetingTodoProjection = Pick<
  WorkTodo,
  | "id" | "sourceFindingId" | "status" | "title" | "version" | "kind"
  | "currentDueDate" | "sourceOriginalDueAt" | "sourceOriginalDueExpression"
>;

function toTodo(row: TodoRow): WorkTodo {
  return WorkTodoSchema.parse({
    contractVersion: 1,
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    status: row.status,
    origin: row.origin,
    title: row.title,
    notes: row.notes,
    ownerLabel: row.owner_label,
    currentDueDate: row.current_due_date,
    isImportant: row.is_important === 1,
    myDayDate: row.my_day_date,
    sourceMeetingId: row.source_meeting_id,
    sourceFindingId: row.source_finding_id,
    sourceFindingVersion: row.source_finding_version,
    sourceFindingKind: row.source_finding_kind,
    sourceOwnerLabel: row.source_owner_label,
    sourceOriginalDueAt: row.source_original_due_at,
    sourceOriginalDueExpression: row.source_original_due_expression,
    sourceActionBasis: row.source_action_basis,
    sourceDetachedAt: row.source_detached_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    reopenedAt: row.reopened_at,
    deletedAt: row.deleted_at
  });
}

function requireId(value: string, code: string) {
  const parsed = WorkReviewIdSchema.safeParse(value);
  if (!parsed.success) throw new WorkReviewConflictError(code);
  return parsed.data;
}

function parseOrConflict<T>(
  result: { success: true; data: T } | { success: false },
  code = "work_todo_invalid_request"
) {
  if (!result.success) throw new WorkReviewConflictError(code);
  return result.data;
}

function fingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function editableFields(input: {
  title: string;
  kind: "self" | "waiting_for_other";
  notes: string | null;
  ownerLabel: string | null;
  currentDueDate: string | null;
  isImportant: boolean;
  myDayDate: string | null;
}): EditableTodoFields {
  return {
    title: input.title,
    kind: input.kind,
    notes: input.notes,
    ownerLabel: input.ownerLabel,
    currentDueDate: input.currentDueDate,
    isImportant: input.isImportant,
    myDayDate: input.myDayDate
  };
}

function validateEditable(fields: EditableTodoFields) {
  const parsed = CreateManualWorkTodoRequestSchema.safeParse({
    ...fields,
    operationKey: "validation"
  });
  if (!parsed.success) throw new WorkReviewConflictError("work_todo_invalid_fields");
  return editableFields(parsed.data);
}

function eventPayload(input: {
  todoId: string;
  changedFields: string[];
  sourceFindingId?: string | null;
  oldVersion: number | null;
  newVersion: number;
  occurredAt: string;
  stateAfter: Pick<
    WorkTodo,
    "title" | "kind" | "status" | "ownerLabel" | "currentDueDate"
      | "completedAt" | "deletedAt" | "version"
  >;
}) {
  return {
    schemaVersion: 2,
    todoId: input.todoId,
    changedFields: input.changedFields,
    sourceFindingId: input.sourceFindingId ?? null,
    oldVersion: input.oldVersion,
    newVersion: input.newVersion,
    occurredAt: input.occurredAt,
    stateAfter: input.stateAfter
  };
}

function insertEvent(
  database: Database.Database,
  input: {
    eventId: string;
    accountId: string;
    todoId: string;
    operationKey?: string | null;
    eventType: WorkTodoEventType;
    payload: ReturnType<typeof eventPayload>;
    now: string;
  }
) {
  database.prepare(`
    INSERT INTO wr_todo_events (
      event_id, account_id, todo_id, operation_key, event_type, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.eventId,
    input.accountId,
    input.todoId,
    input.operationKey ?? null,
    input.eventType,
    JSON.stringify(input.payload),
    input.now
  );
}

function activeMeetingTodoRows(
  database: Database.Database,
  accountId: string,
  meetingId: string
) {
  return database.prepare(`
    SELECT * FROM wr_todos
    WHERE account_id = ? AND source_meeting_id = ?
      AND origin = 'meeting_finding' AND deleted_at IS NULL
    ORDER BY created_at, id
  `).all(accountId, meetingId) as TodoRow[];
}

function insertTodoProjectLinks(
  database: Database.Database,
  input: { accountId: string; todoId: string; projectIds?: string[]; now: string }
) {
  const projectIds = [...(input.projectIds ?? [])].sort();
  if (projectIds.length === 0) return;
  const found = database.prepare(`
    SELECT count(*) AS count FROM wr_projects
    WHERE account_id = ? AND id IN (${projectIds.map(() => "?").join(",")})
  `).get(input.accountId, ...projectIds) as { count: number };
  if (found.count !== projectIds.length) {
    throw new WorkReviewConflictError("work_project_not_found");
  }
  for (const projectId of projectIds) {
    database.prepare(`
      INSERT INTO wr_todo_projects(account_id, todo_id, project_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(input.accountId, input.todoId, projectId, input.now);
  }
}

export class WorkTodoRepository {
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(private readonly database: Database.Database, options: TodoRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  private nextId(prefix: string) {
    return `${prefix}_${this.idFactory()}`;
  }

  private todoRow(accountId: string, todoId: string, includeDeleted = false) {
    const deletedClause = includeDeleted ? "" : "AND deleted_at IS NULL";
    return this.database.prepare(`
      SELECT * FROM wr_todos WHERE id = ? AND account_id = ? ${deletedClause}
    `).get(todoId, accountId) as TodoRow | undefined;
  }

  private requireTodoRow(accountId: string, todoId: string, includeDeleted = false) {
    const row = this.todoRow(accountId, todoId, includeDeleted);
    if (!row) throw new WorkTodoNotFoundError();
    return row;
  }

  private replayOperation(
    accountId: string,
    operationKey: string,
    requestFingerprint: string
  ): WorkTodoMutationResult | null {
    const row = this.database.prepare(`
      SELECT request_fingerprint, response_json
      FROM wr_todo_operations WHERE account_id = ? AND operation_key = ?
    `).get(accountId, operationKey) as TodoOperationRow | undefined;
    if (!row) return null;
    if (row.request_fingerprint !== requestFingerprint) {
      throw new WorkReviewConflictError("work_todo_operation_conflict");
    }
    const response = JSON.parse(row.response_json) as { todo: unknown };
    return { todo: WorkTodoSchema.parse(response.todo), reused: true };
  }

  private recordOperation(input: {
    accountId: string;
    operationKey: string;
    todo: WorkTodo;
    operationType:
      | "create_manual" | "create_from_finding" | "update" | "complete" | "reopen"
      | "add_to_my_day" | "remove_from_my_day" | "delete";
    requestFingerprint: string;
    now: string;
  }) {
    this.database.prepare(`
      INSERT INTO wr_todo_operations (
        account_id, operation_key, todo_id, operation_type, request_fingerprint,
        result_version, response_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.accountId,
      input.operationKey,
      input.todo.id,
      input.operationType,
      input.requestFingerprint,
      input.todo.version,
      JSON.stringify({ todo: input.todo }),
      input.now
    );
  }

  private recordEvent(input: {
    accountId: string;
    todo: WorkTodo;
    operationKey?: string | null;
    eventType: WorkTodoEventType;
    changedFields: string[];
    oldVersion: number | null;
    sourceFindingId?: string | null;
    now: string;
  }) {
    insertEvent(this.database, {
      eventId: this.nextId("wrte"),
      accountId: input.accountId,
      todoId: input.todo.id,
      operationKey: input.operationKey,
      eventType: input.eventType,
      payload: eventPayload({
        todoId: input.todo.id,
        changedFields: input.changedFields,
        sourceFindingId: input.sourceFindingId,
        oldVersion: input.oldVersion,
        newVersion: input.todo.version,
        occurredAt: input.now,
        stateAfter: {
          title: input.todo.title,
          kind: input.todo.kind,
          status: input.todo.status,
          ownerLabel: input.todo.ownerLabel,
          currentDueDate: input.todo.currentDueDate,
          completedAt: input.todo.completedAt,
          deletedAt: input.todo.deletedAt,
          version: input.todo.version
        }
      }),
      now: input.now
    });
    if (input.eventType !== "todo.deleted") {
      markWorkWeeklySourceChangedWithinTransaction(this.database, {
        accountId: input.accountId,
        todoId: input.todo.id,
        now: input.now
      });
    }
  }

  createManualTodo(input: CreateManualWorkTodoInput): WorkTodoMutationResult {
    const accountId = requireId(input.accountId, "work_todo_invalid_account");
    const parsed = parseOrConflict(CreateManualWorkTodoRequestSchema.safeParse({
      operationKey: input.operationKey,
      title: input.title,
      kind: input.kind,
      notes: input.notes,
      ownerLabel: input.ownerLabel,
      currentDueDate: input.currentDueDate,
      isImportant: input.isImportant,
      myDayDate: input.myDayDate,
      projectIds: input.projectIds
    }));
    const { projectIds, ...legacyRequest } = parsed;
    const requestFingerprint = fingerprint({
      type: "create_manual",
      ...legacyRequest,
      ...(projectIds?.length ? { projectIds: [...projectIds].sort() } : {})
    });
    const run = this.database.transaction(() => {
      const replay = this.replayOperation(accountId, parsed.operationKey, requestFingerprint);
      if (replay) return replay;
      const now = this.now();
      const todoId = this.nextId("wrt");
      this.database.prepare(`
        INSERT INTO wr_todos (
          id, account_id, kind, status, origin, title, notes, owner_label,
          current_due_date, is_important, my_day_date, created_at, updated_at
        ) VALUES (?, ?, ?, 'open', 'manual', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        todoId,
        accountId,
        parsed.kind,
        parsed.title,
        parsed.notes,
        parsed.ownerLabel,
        parsed.currentDueDate,
        parsed.isImportant ? 1 : 0,
        parsed.myDayDate,
        now,
        now
      );
      insertTodoProjectLinks(this.database, {
        accountId,
        todoId,
        projectIds,
        now
      });
      const todo = toTodo(this.requireTodoRow(accountId, todoId));
      this.recordEvent({
        accountId,
        todo,
        operationKey: parsed.operationKey,
        eventType: "todo.created_manual",
        changedFields: ["title", "kind", "notes", "ownerLabel", "currentDueDate", "isImportant", "myDayDate"],
        oldVersion: null,
        now
      });
      this.recordOperation({
        accountId,
        operationKey: parsed.operationKey,
        todo,
        operationType: "create_manual",
        requestFingerprint,
        now
      });
      return { todo, reused: false };
    });
    return run.immediate();
  }

  createTodoFromFinding(input: CreateWorkTodoFromFindingInput): WorkTodoMutationResult {
    const accountId = requireId(input.accountId, "work_todo_invalid_account");
    const meetingId = requireId(input.meetingId, "work_todo_invalid_meeting");
    const findingId = requireId(input.findingId, "work_todo_invalid_finding");
    const parsed = parseOrConflict(CreateWorkTodoFromFindingRequestSchema.safeParse({
      operationKey: input.operationKey,
      title: input.title,
      kind: input.kind,
      notes: input.notes,
      ownerLabel: input.ownerLabel,
      currentDueDate: input.currentDueDate,
      isImportant: input.isImportant,
      myDayDate: input.myDayDate,
      projectIds: input.projectIds,
      ownershipOverrideConfirmed: input.ownershipOverrideConfirmed
    }));
    const { projectIds, ...legacyRequest } = parsed;
    const requestFingerprint = fingerprint({
      type: "create_from_finding",
      meetingId,
      findingId,
      ...legacyRequest,
      ...(projectIds?.length ? { projectIds: [...projectIds].sort() } : {})
    });
    const run = this.database.transaction(() => {
      const replay = this.replayOperation(accountId, parsed.operationKey, requestFingerprint);
      if (replay) return replay;
      const finding = this.database.prepare(`
        SELECT f.* FROM wr_findings f
        JOIN wr_meetings m ON m.id = f.meeting_id AND m.account_id = f.account_id
        WHERE f.id = ? AND f.account_id = ? AND f.meeting_id = ?
          AND f.user_confirmed_at IS NOT NULL
          AND m.deleted_at IS NULL AND m.ingestion_status <> 'deleted'
      `).get(findingId, accountId, meetingId) as FindingSourceRow | undefined;
      if (!finding) throw new WorkTodoNotFoundError();
      if (finding.kind !== "action_item" && finding.kind !== "commitment") {
        throw new WorkReviewConflictError("work_todo_finding_kind_not_projectable");
      }
      const structuredData = parseOrConflict(
        WorkMeetingCandidateStructuredDataSchema.safeParse(JSON.parse(finding.structured_data_json)),
        "work_todo_source_metadata_invalid"
      );
      if (structuredData.actionBasis === "assignment_without_acceptance"
        && parsed.kind === "self" && !parsed.ownershipOverrideConfirmed) {
        throw new WorkReviewConflictError("work_todo_ownership_override_required");
      }
      const existing = this.database.prepare(`
        SELECT * FROM wr_todos
        WHERE account_id = ? AND source_finding_id = ? AND deleted_at IS NULL
      `).get(accountId, findingId) as TodoRow | undefined;
      const now = this.now();
      if (existing) {
        const todo = toTodo(existing);
        this.recordOperation({
          accountId,
          operationKey: parsed.operationKey,
          todo,
          operationType: "create_from_finding",
          requestFingerprint,
          now
        });
        return { todo, reused: true };
      }
      const todoId = this.nextId("wrt");
      const sourceOwnerLabel = structuredData.candidateOwner ?? structuredData.rawActorLabel;
      this.database.prepare(`
        INSERT INTO wr_todos (
          id, account_id, kind, status, origin, title, notes, owner_label,
          current_due_date, is_important, my_day_date,
          source_meeting_id, source_finding_id, source_finding_version,
          source_finding_kind, source_owner_label, source_original_due_at,
          source_original_due_expression, source_action_basis, created_at, updated_at
        ) VALUES (?, ?, ?, 'open', 'meeting_finding', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        todoId,
        accountId,
        parsed.kind,
        parsed.title,
        parsed.notes,
        parsed.ownerLabel,
        parsed.currentDueDate,
        parsed.isImportant ? 1 : 0,
        parsed.myDayDate,
        meetingId,
        findingId,
        finding.version,
        finding.kind,
        sourceOwnerLabel,
        structuredData.dueAt,
        structuredData.originalDueExpression,
        structuredData.actionBasis,
        now,
        now
      );
      insertTodoProjectLinks(this.database, {
        accountId,
        todoId,
        projectIds,
        now
      });
      const todo = toTodo(this.requireTodoRow(accountId, todoId));
      this.recordEvent({
        accountId,
        todo,
        operationKey: parsed.operationKey,
        eventType: "todo.created_from_finding",
        changedFields: [
          "title", "kind", "notes", "ownerLabel", "currentDueDate", "isImportant", "myDayDate",
          "sourceMeetingId", "sourceFindingId", "sourceFindingVersion", "sourceFindingKind"
        ],
        sourceFindingId: findingId,
        oldVersion: null,
        now
      });
      this.recordOperation({
        accountId,
        operationKey: parsed.operationKey,
        todo,
        operationType: "create_from_finding",
        requestFingerprint,
        now
      });
      return { todo, reused: false };
    });
    return run.immediate();
  }

  getTodo(accountId: string, todoId: string) {
    return toTodo(this.requireTodoRow(
      requireId(accountId, "work_todo_invalid_account"),
      requireId(todoId, "work_todo_invalid_id")
    ));
  }

  listTodos(input: {
    accountId: string;
    view: WorkTodoView;
    day?: string | null;
    projectScope?: WorkProjectScopeFilter;
  }) {
    const accountId = requireId(input.accountId, "work_todo_invalid_account");
    const view = parseOrConflict(WorkTodoViewSchema.safeParse(input.view), "work_todo_invalid_view");
    const conditions = ["account_id = ?", "deleted_at IS NULL"];
    const parameters: unknown[] = [accountId];
    let orderBy: string;
    switch (view) {
      case "today": {
        const day = parseOrConflict(WorkTodoDateSchema.safeParse(input.day), "work_todo_invalid_day");
        conditions.push("my_day_date = ?", "status = 'open'");
        parameters.push(day);
        orderBy = `is_important DESC,
          CASE WHEN current_due_date IS NULL THEN 1 ELSE 0 END,
          current_due_date, updated_at DESC, id`;
        break;
      }
      case "all":
        conditions.push("kind = 'self'", "status = 'open'");
        orderBy = "is_important DESC, updated_at DESC, id";
        break;
      case "planned":
        conditions.push("current_due_date IS NOT NULL", "status = 'open'");
        orderBy = "current_due_date, is_important DESC, updated_at DESC, id";
        break;
      case "waiting":
        conditions.push("kind = 'waiting_for_other'", "status = 'open'");
        orderBy = `is_important DESC,
          CASE WHEN current_due_date IS NULL THEN 1 ELSE 0 END,
          current_due_date, updated_at DESC, id`;
        break;
      case "completed":
        conditions.push("status = 'completed'");
        orderBy = "completed_at DESC, updated_at DESC, id";
        break;
    }
    const projectScope = input.projectScope ?? { kind: "all" as const };
    if (projectScope.kind === "project") {
      conditions.push(`EXISTS (
        SELECT 1 FROM wr_todo_projects tp
        WHERE tp.account_id = wr_todos.account_id
          AND tp.todo_id = wr_todos.id AND tp.project_id = ?
      )`);
      parameters.push(projectScope.projectId);
    } else if (projectScope.kind === "unassigned") {
      conditions.push(`NOT EXISTS (
        SELECT 1 FROM wr_todo_projects tp
        WHERE tp.account_id = wr_todos.account_id AND tp.todo_id = wr_todos.id
      )`);
    }
    const sql = `SELECT * FROM wr_todos WHERE ${conditions.join(" AND ")} ORDER BY ${orderBy}`;
    return (this.database.prepare(sql).all(...parameters) as TodoRow[]).map(toTodo);
  }

  listMeetingTodoProjections(accountId: string, meetingId: string): WorkMeetingTodoProjection[] {
    const parsedAccountId = requireId(accountId, "work_todo_invalid_account");
    const parsedMeetingId = requireId(meetingId, "work_todo_invalid_meeting");
    return activeMeetingTodoRows(this.database, parsedAccountId, parsedMeetingId).map((row) => ({
      id: row.id,
      sourceFindingId: row.source_finding_id,
      status: row.status,
      title: row.title,
      version: row.version,
      kind: row.kind,
      currentDueDate: row.current_due_date,
      sourceOriginalDueAt: row.source_original_due_at,
      sourceOriginalDueExpression: row.source_original_due_expression
    }));
  }

  listMeetingTodos(accountId: string, meetingId: string): WorkTodo[] {
    const parsedAccountId = requireId(accountId, "work_todo_invalid_account");
    const parsedMeetingId = requireId(meetingId, "work_todo_invalid_meeting");
    return activeMeetingTodoRows(this.database, parsedAccountId, parsedMeetingId).map(toTodo);
  }

  getTodoDetail(accountId: string, todoId: string): WorkTodoDetail {
    const todo = this.getTodo(accountId, todoId);
    if (todo.origin === "manual") {
      return { todo, source: { state: "none", sourceChanged: false, currentFindingVersion: null, meeting: null } };
    }
    if (todo.origin === "detached_meeting_finding") {
      return { todo, source: { state: "detached", sourceChanged: false, currentFindingVersion: null, meeting: null } };
    }
    const row = this.database.prepare(`
      SELECT f.version AS finding_version, m.id AS meeting_id, m.title, m.meeting_date
      FROM wr_findings f
      JOIN wr_meetings m ON m.id = f.meeting_id AND m.account_id = f.account_id
      WHERE f.id = ? AND f.account_id = ? AND f.meeting_id = ?
        AND m.deleted_at IS NULL AND m.ingestion_status <> 'deleted'
    `).get(todo.sourceFindingId, todo.accountId, todo.sourceMeetingId) as {
      finding_version: number;
      meeting_id: string;
      title: string;
      meeting_date: string;
    } | undefined;
    if (!row) {
      return { todo, source: { state: "missing", sourceChanged: true, currentFindingVersion: null, meeting: null } };
    }
    const sourceChanged = row.finding_version !== todo.sourceFindingVersion;
    return {
      todo,
      source: {
        state: sourceChanged ? "changed" : "available",
        sourceChanged,
        currentFindingVersion: row.finding_version,
        meeting: { id: row.meeting_id, title: row.title, meetingDate: row.meeting_date }
      }
    };
  }

  getTodoSource(accountId: string, todoId: string): WorkTodoResolvedSource {
    const todo = this.getTodo(accountId, todoId);
    if (todo.origin !== "meeting_finding" || !todo.sourceFindingId || !todo.sourceMeetingId) {
      throw new WorkReviewConflictError("work_todo_source_unavailable");
    }
    const row = this.database.prepare(`
      SELECT f.id, f.kind, f.title AS finding_title, f.body, f.version,
             f.structured_data_json, m.id AS meeting_id, m.title AS meeting_title,
             m.meeting_date, m.canonical_publication_id,
             p.publication_id, p.payload_json
      FROM wr_findings f
      JOIN wr_meetings m ON m.id = f.meeting_id AND m.account_id = f.account_id
      JOIN wr_canonical_publications p
        ON p.publication_id = m.canonical_publication_id
        AND p.account_id = m.account_id AND p.meeting_id = m.id
      WHERE f.id = ? AND f.account_id = ? AND f.meeting_id = ?
        AND m.deleted_at IS NULL AND m.ingestion_status <> 'deleted'
        AND p.tombstoned_at IS NULL
    `).get(todo.sourceFindingId, todo.accountId, todo.sourceMeetingId) as {
      id: string;
      kind: WorkTodoSourceFindingKind;
      finding_title: string;
      body: string;
      version: number;
      structured_data_json: string;
      meeting_id: string;
      meeting_title: string;
      meeting_date: string;
      canonical_publication_id: string;
      publication_id: string;
      payload_json: string;
    } | undefined;
    if (!row || (row.kind !== "action_item" && row.kind !== "commitment")) {
      throw new WorkTodoNotFoundError();
    }
    const segments = JSON.parse(row.payload_json) as Array<{
      id: string;
      text: string;
      startSeconds: number;
      endSeconds: number;
      speaker?: string | null;
    }>;
    const evidence = this.database.prepare(`
      SELECT e.publication_id, e.segment_id, e.start_seconds, e.end_seconds,
             e.raw_speaker_label, e.timestamp_quality
      FROM wr_finding_evidence e
      WHERE e.account_id = ? AND e.meeting_id = ? AND e.finding_id = ?
      ORDER BY e.position
    `).all(todo.accountId, todo.sourceMeetingId, todo.sourceFindingId) as Array<{
      publication_id: string;
      segment_id: string;
      start_seconds: number;
      end_seconds: number;
      raw_speaker_label: string | null;
      timestamp_quality: "provider_exact" | "provider_estimated" | "synthetic" | "unknown";
    }>;
    const referenceBySegmentId = new Map(evidence.map((reference) => [reference.segment_id, reference]));
    const contextIndexes = new Set<number>();
    for (const reference of evidence) {
      if (reference.publication_id !== row.publication_id) {
        throw new WorkReviewConflictError("work_todo_source_evidence_invalid");
      }
      const index = segments.findIndex((segment) => segment.id === reference.segment_id);
      if (index < 0 || typeof segments[index]?.text !== "string") {
        throw new WorkReviewConflictError("work_todo_source_evidence_invalid");
      }
      for (let candidate = Math.max(0, index - 1); candidate <= Math.min(segments.length - 1, index + 1); candidate += 1) {
        contextIndexes.add(candidate);
      }
    }
    const aliases = this.database.prepare(`
      SELECT raw_label, display_label FROM wr_speaker_aliases
      WHERE account_id = ? AND meeting_id = ?
    `).all(todo.accountId, todo.sourceMeetingId) as Array<{
      raw_label: string;
      display_label: string;
    }>;
    const aliasByRawLabel = new Map(aliases.map((alias) => [alias.raw_label, alias.display_label]));
    const evidenceContexts = [...contextIndexes].sort((left, right) => left - right).map((index) => {
      const segment = segments[index]!;
      const reference = referenceBySegmentId.get(segment.id);
      const rawSpeakerLabel = segment.speaker ?? reference?.raw_speaker_label ?? null;
      return {
        publicationId: row.publication_id,
        segmentId: segment.id,
        isDirectEvidence: Boolean(reference),
        text: segment.text,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
        rawSpeakerLabel,
        displaySpeakerLabel: rawSpeakerLabel ? aliasByRawLabel.get(rawSpeakerLabel) ?? null : null,
        timestampQuality: reference?.timestamp_quality ?? "unknown"
      };
    });
    return {
      todoId: todo.id,
      sourceChanged: row.version !== todo.sourceFindingVersion,
      meeting: { id: row.meeting_id, title: row.meeting_title, meetingDate: row.meeting_date },
      finding: {
        id: row.id,
        kind: row.kind,
        title: row.finding_title,
        body: row.body,
        version: row.version,
        structuredData: JSON.parse(row.structured_data_json)
      },
      evidenceContexts
    };
  }

  updateTodo(input: UpdateWorkTodoInput): WorkTodoMutationResult {
    const accountId = requireId(input.accountId, "work_todo_invalid_account");
    const todoId = requireId(input.todoId, "work_todo_invalid_id");
    const rawPatch: Record<string, unknown> = {
      expectedVersion: input.expectedVersion,
      operationKey: input.operationKey
    };
    for (const key of [
      "title", "kind", "notes", "ownerLabel", "currentDueDate", "isImportant", "myDayDate"
    ] as const) {
      if (Object.prototype.hasOwnProperty.call(input, key)) rawPatch[key] = input[key];
    }
    const parsed = parseOrConflict(UpdateWorkTodoRequestSchema.safeParse(rawPatch));
    const requestFingerprint = fingerprint({ type: "update", todoId, ...parsed });
    const run = this.database.transaction(() => {
      const replay = this.replayOperation(accountId, parsed.operationKey, requestFingerprint);
      if (replay) return replay;
      const row = this.requireTodoRow(accountId, todoId);
      if (row.version !== parsed.expectedVersion) throw new WorkReviewVersionConflictError(row.version);
      const current = toTodo(row);
      const merged = validateEditable({
        title: parsed.title ?? current.title,
        kind: parsed.kind ?? current.kind,
        notes: parsed.notes === undefined ? current.notes : parsed.notes,
        ownerLabel: parsed.ownerLabel === undefined ? current.ownerLabel : parsed.ownerLabel,
        currentDueDate: parsed.currentDueDate === undefined ? current.currentDueDate : parsed.currentDueDate,
        isImportant: parsed.isImportant ?? current.isImportant,
        myDayDate: parsed.myDayDate === undefined ? current.myDayDate : parsed.myDayDate
      });
      const changedFields = (Object.keys(merged) as Array<keyof EditableTodoFields>)
        .filter((key) => merged[key] !== current[key]);
      const now = this.now();
      if (changedFields.length > 0) {
        this.database.prepare(`
          UPDATE wr_todos
          SET title = ?, kind = ?, notes = ?, owner_label = ?, current_due_date = ?,
              is_important = ?, my_day_date = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND account_id = ? AND version = ? AND deleted_at IS NULL
        `).run(
          merged.title,
          merged.kind,
          merged.notes,
          merged.ownerLabel,
          merged.currentDueDate,
          merged.isImportant ? 1 : 0,
          merged.myDayDate,
          now,
          todoId,
          accountId,
          row.version
        );
      }
      const todo = toTodo(this.requireTodoRow(accountId, todoId));
      if (changedFields.length > 0) {
        this.recordEvent({
          accountId,
          todo,
          operationKey: parsed.operationKey,
          eventType: "todo.updated",
          changedFields,
          sourceFindingId: todo.sourceFindingId,
          oldVersion: row.version,
          now
        });
      }
      this.recordOperation({
        accountId,
        operationKey: parsed.operationKey,
        todo,
        operationType: "update",
        requestFingerprint,
        now
      });
      return { todo, reused: false };
    });
    return run.immediate();
  }

  private runStatusOperation(input: WorkTodoVersionedOperationInput, target: "completed" | "open") {
    const accountId = requireId(input.accountId, "work_todo_invalid_account");
    const todoId = requireId(input.todoId, "work_todo_invalid_id");
    const parsed = parseOrConflict(WorkTodoVersionedOperationRequestSchema.safeParse({
      expectedVersion: input.expectedVersion,
      operationKey: input.operationKey
    }));
    const operationType = target === "completed" ? "complete" as const : "reopen" as const;
    const requestFingerprint = fingerprint({ type: operationType, todoId, ...parsed });
    const run = this.database.transaction(() => {
      const replay = this.replayOperation(accountId, parsed.operationKey, requestFingerprint);
      if (replay) return replay;
      const row = this.requireTodoRow(accountId, todoId);
      const now = this.now();
      if (row.status !== target) {
        if (row.version !== parsed.expectedVersion) throw new WorkReviewVersionConflictError(row.version);
        if (target === "completed") {
          this.database.prepare(`
            UPDATE wr_todos SET status = 'completed', completed_at = ?,
              version = version + 1, updated_at = ?
            WHERE id = ? AND account_id = ? AND version = ? AND deleted_at IS NULL
          `).run(now, now, todoId, accountId, row.version);
        } else {
          this.database.prepare(`
            UPDATE wr_todos SET status = 'open', reopened_at = ?,
              version = version + 1, updated_at = ?
            WHERE id = ? AND account_id = ? AND version = ? AND deleted_at IS NULL
          `).run(now, now, todoId, accountId, row.version);
        }
      }
      const todo = toTodo(this.requireTodoRow(accountId, todoId));
      if (row.status !== target) {
        this.recordEvent({
          accountId,
          todo,
          operationKey: parsed.operationKey,
          eventType: target === "completed" ? "todo.completed" : "todo.reopened",
          changedFields: target === "completed"
            ? ["status", "completedAt"]
            : ["status", "reopenedAt"],
          sourceFindingId: todo.sourceFindingId,
          oldVersion: row.version,
          now
        });
      }
      this.recordOperation({
        accountId,
        operationKey: parsed.operationKey,
        todo,
        operationType,
        requestFingerprint,
        now
      });
      return { todo, reused: row.status === target };
    });
    return run.immediate();
  }

  completeTodo(input: WorkTodoVersionedOperationInput) {
    return this.runStatusOperation(input, "completed");
  }

  reopenTodo(input: WorkTodoVersionedOperationInput) {
    return this.runStatusOperation(input, "open");
  }

  private runMyDayOperation(
    input: WorkTodoVersionedOperationInput & { day?: string | null },
    add: boolean
  ) {
    const accountId = requireId(input.accountId, "work_todo_invalid_account");
    const todoId = requireId(input.todoId, "work_todo_invalid_id");
    const parsed = add
      ? parseOrConflict(SetWorkTodoMyDayRequestSchema.safeParse({
        expectedVersion: input.expectedVersion,
        operationKey: input.operationKey,
        day: input.day
      }))
      : parseOrConflict(WorkTodoVersionedOperationRequestSchema.safeParse({
        expectedVersion: input.expectedVersion,
        operationKey: input.operationKey
      }));
    const targetDay = add ? (parsed as SetWorkTodoMyDayRequest).day : null;
    const operationType = add ? "add_to_my_day" as const : "remove_from_my_day" as const;
    const requestFingerprint = fingerprint({ type: operationType, todoId, ...parsed });
    const run = this.database.transaction(() => {
      const replay = this.replayOperation(accountId, parsed.operationKey, requestFingerprint);
      if (replay) return replay;
      const row = this.requireTodoRow(accountId, todoId);
      if (row.status !== "open") throw new WorkReviewConflictError("work_todo_not_open");
      const changed = row.my_day_date !== targetDay;
      const now = this.now();
      if (changed) {
        if (row.version !== parsed.expectedVersion) throw new WorkReviewVersionConflictError(row.version);
        this.database.prepare(`
          UPDATE wr_todos SET my_day_date = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND account_id = ? AND version = ? AND deleted_at IS NULL
        `).run(targetDay, now, todoId, accountId, row.version);
      }
      const todo = toTodo(this.requireTodoRow(accountId, todoId));
      if (changed) {
        this.recordEvent({
          accountId,
          todo,
          operationKey: parsed.operationKey,
          eventType: add ? "todo.added_to_my_day" : "todo.removed_from_my_day",
          changedFields: ["myDayDate"],
          sourceFindingId: todo.sourceFindingId,
          oldVersion: row.version,
          now
        });
      }
      this.recordOperation({
        accountId,
        operationKey: parsed.operationKey,
        todo,
        operationType,
        requestFingerprint,
        now
      });
      return { todo, reused: !changed };
    });
    return run.immediate();
  }

  setMyDay(input: SetWorkTodoMyDayInput) {
    return this.runMyDayOperation(input, true);
  }

  removeFromMyDay(input: WorkTodoVersionedOperationInput) {
    return this.runMyDayOperation(input, false);
  }

  deleteTodo(input: WorkTodoVersionedOperationInput): WorkTodoMutationResult {
    const accountId = requireId(input.accountId, "work_todo_invalid_account");
    const todoId = requireId(input.todoId, "work_todo_invalid_id");
    const parsed = parseOrConflict(WorkTodoVersionedOperationRequestSchema.safeParse({
      expectedVersion: input.expectedVersion,
      operationKey: input.operationKey
    }));
    const requestFingerprint = fingerprint({ type: "delete", todoId, ...parsed });
    const run = this.database.transaction(() => {
      const replay = this.replayOperation(accountId, parsed.operationKey, requestFingerprint);
      if (replay) return replay;
      const row = this.requireTodoRow(accountId, todoId, true);
      const now = this.now();
      if (!row.deleted_at) {
        if (row.version !== parsed.expectedVersion) throw new WorkReviewVersionConflictError(row.version);
        invalidateWorkWeeklySourcesWithinTransaction(this.database, {
          accountId,
          todoId,
          now
        });
        this.database.prepare(`
          UPDATE wr_todos SET deleted_at = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND account_id = ? AND version = ? AND deleted_at IS NULL
        `).run(now, now, todoId, accountId, row.version);
        this.database.prepare(`
          DELETE FROM wr_todo_projects WHERE account_id = ? AND todo_id = ?
        `).run(accountId, todoId);
        this.database.prepare(`
          DELETE FROM wr_project_operations
          WHERE account_id = ? AND target_kind = 'todo_projects' AND target_id = ?
        `).run(accountId, todoId);
      }
      const todo = toTodo(this.requireTodoRow(accountId, todoId, true));
      if (!row.deleted_at) {
        this.recordEvent({
          accountId,
          todo,
          operationKey: parsed.operationKey,
          eventType: "todo.deleted",
          changedFields: ["deletedAt"],
          sourceFindingId: todo.sourceFindingId,
          oldVersion: row.version,
          now
        });
      }
      this.recordOperation({
        accountId,
        operationKey: parsed.operationKey,
        todo,
        operationType: "delete",
        requestFingerprint,
        now
      });
      return { todo, reused: Boolean(row.deleted_at) };
    });
    return run.immediate();
  }

  listActiveMeetingTodoIds(accountId: string, meetingId: string) {
    return listActiveMeetingTodoIdsWithinTransaction(
      this.database,
      requireId(accountId, "work_todo_invalid_account"),
      requireId(meetingId, "work_todo_invalid_meeting")
    );
  }

  deleteLinkedMeetingTodos(accountId: string, meetingId: string, now = this.now()) {
    return deleteLinkedMeetingTodosWithinTransaction(this.database, {
      accountId: requireId(accountId, "work_todo_invalid_account"),
      meetingId: requireId(meetingId, "work_todo_invalid_meeting"),
      now
    }, { idFactory: this.idFactory });
  }

  detachLinkedMeetingTodos(accountId: string, meetingId: string, now = this.now()) {
    return detachLinkedMeetingTodosWithinTransaction(this.database, {
      accountId: requireId(accountId, "work_todo_invalid_account"),
      meetingId: requireId(meetingId, "work_todo_invalid_meeting"),
      now
    }, { idFactory: this.idFactory });
  }
}

export function createWorkTodoRepository(
  database: Database.Database,
  options: TodoRepositoryOptions = {}
) {
  return new WorkTodoRepository(database, options);
}
