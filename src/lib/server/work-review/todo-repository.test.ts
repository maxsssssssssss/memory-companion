import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openWorkReviewDatabase } from "./db";
import { WorkReviewConflictError, WorkReviewVersionConflictError } from "./repository";
import { WORK_REVIEW_SCHEMA_VERSION } from "./schema";
import {
  WorkTodoNotFoundError,
  WorkTodoRepository
} from "./todo-repository";

const initialNow = "2026-09-02T08:00:00.000Z";
const canonicalHash = "a".repeat(64);

let database: Database.Database;
let repository: WorkTodoRepository;
let clock = initialNow;
let generatedId = 0;

beforeEach(() => {
  database = openWorkReviewDatabase({ filePath: ":memory:" });
  clock = initialNow;
  generatedId = 0;
  repository = new WorkTodoRepository(database, {
    now: () => clock,
    idFactory: () => `generated_${++generatedId}`
  });
});

afterEach(() => database.close());

function createManual(overrides: Partial<Parameters<WorkTodoRepository["createManualTodo"]>[0]> = {}) {
  return repository.createManualTodo({
    accountId: "account_a",
    operationKey: `manual_${++generatedId}`,
    title: "完成 Todo 页面",
    kind: "self",
    notes: null,
    ownerLabel: null,
    currentDueDate: null,
    isImportant: false,
    myDayDate: null,
    ...overrides
  });
}

function seedFinding(input: {
  accountId?: string;
  meetingId?: string;
  findingId?: string;
  kind?: "action_item" | "commitment" | "decision";
  actionBasis?: "explicit_commitment" | "assignment_without_acceptance" | "suggested_action" | "unowned_follow_up";
  version?: number;
  evidenceIndex?: number;
}) {
  const accountId = input.accountId ?? "account_a";
  const meetingId = input.meetingId ?? `meeting_${++generatedId}`;
  const findingId = input.findingId ?? `finding_${++generatedId}`;
  const kind = input.kind ?? "action_item";
  const actionBasis = input.actionBasis ?? "explicit_commitment";
  const candidateId = `candidate_${findingId}`;
  const publicationId = `publication_${meetingId}`;
  const uploadId = `upload_${meetingId}`;
  const segments = Array.from({ length: 5 }, (_, index) => ({
    id: `segment_${meetingId}_${index}`,
    uploadId,
    startSeconds: index * 10,
    endSeconds: index * 10 + 8,
    speaker: index % 2 === 0 ? "Speaker 1" : "Speaker 2",
    text: index === 0 || index === 4
      ? `不可返回的远端上下文 ${index}`
      : `最小来源上下文 ${index}`,
    confidence: 0.98,
    sceneLabels: [],
    valueLabels: []
  }));
  const structuredData = {
    decisionFinality: null,
    rawActorLabel: "Speaker 1",
    candidateOwner: "Alex",
    dueAt: "2026-09-08T00:00:00.000Z",
    originalDueExpression: "下周二前",
    actionBasis,
    relatedCommitmentCandidateId: null,
    planStages: []
  };
  database.prepare(`
    INSERT INTO wr_meetings (
      id, account_id, product_space, title, meeting_date, source_upload_id,
      ingestion_status, analysis_status, review_status,
      canonical_publication_id, canonical_content_digest, canonical_segment_count,
      version, created_at, updated_at, transcript_ready_at, review_ready_at
    ) VALUES (?, ?, 'office_review', ?, '2026-09-01', ?,
      'transcript_ready', 'review_ready', 'in_progress', ?, ?, ?, 1, ?, ?, ?, ?)
  `).run(
    meetingId,
    accountId,
    `会议 ${meetingId}`,
    uploadId,
    publicationId,
    canonicalHash,
    segments.length,
    initialNow,
    initialNow,
    initialNow,
    initialNow
  );
  database.prepare(`
    INSERT INTO wr_canonical_publications (
      publication_id, account_id, meeting_id, source_upload_id, product_space,
      asset_kind, attempt_version, content_digest, segment_count, payload_json, created_at
    ) VALUES (?, ?, ?, ?, 'office_review', 'segments', 1, ?, ?, ?, ?)
  `).run(
    publicationId,
    accountId,
    meetingId,
    uploadId,
    canonicalHash,
    segments.length,
    JSON.stringify(segments),
    initialNow
  );
  database.prepare(`
    INSERT INTO wr_meeting_candidates (
      id, account_id, meeting_id, publication_id, ordinal, kind, title, body,
      structured_data_json, status, publication_action, risk_level,
      generator_profile, generator_prompt_version, analysis_attempt_version,
      version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, ?, '会议行动', '会议行动正文', ?, 'accepted',
      'show_as_candidate', 'high', 'fixture', 'fixture_v1', 1, 1, ?, ?)
  `).run(
    candidateId,
    accountId,
    meetingId,
    publicationId,
    kind,
    JSON.stringify(structuredData),
    initialNow,
    initialNow
  );
  database.prepare(`
    INSERT INTO wr_findings (
      id, account_id, meeting_id, source_candidate_id, kind, title, body,
      structured_data_json, user_confirmed_at, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, '确认后的行动', '确认后的会议结果', ?, ?, ?, ?, ?)
  `).run(
    findingId,
    accountId,
    meetingId,
    candidateId,
    kind,
    JSON.stringify(structuredData),
    initialNow,
    input.version ?? 2,
    initialNow,
    initialNow
  );
  const evidenceIndex = input.evidenceIndex ?? 2;
  const evidenceSegment = segments[evidenceIndex]!;
  database.prepare(`
    INSERT INTO wr_finding_evidence (
      account_id, meeting_id, finding_id, publication_id, position, segment_id,
      start_seconds, end_seconds, raw_speaker_label, timestamp_quality
    ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 'provider_exact')
  `).run(
    accountId,
    meetingId,
    findingId,
    publicationId,
    evidenceSegment.id,
    evidenceSegment.startSeconds,
    evidenceSegment.endSeconds,
    evidenceSegment.speaker
  );
  database.prepare(`
    INSERT INTO wr_speaker_aliases (
      account_id, meeting_id, raw_label, display_label, version, created_at, updated_at
    ) VALUES (?, ?, 'Speaker 1', 'Alex（会议内）', 0, ?, ?)
  `).run(accountId, meetingId, initialNow, initialNow);
  return { accountId, meetingId, findingId, publicationId, segments, structuredData };
}

function projectFinding(
  source: ReturnType<typeof seedFinding>,
  overrides: Partial<Parameters<WorkTodoRepository["createTodoFromFinding"]>[0]> = {}
) {
  return repository.createTodoFromFinding({
    accountId: source.accountId,
    meetingId: source.meetingId,
    findingId: source.findingId,
    operationKey: `project_${++generatedId}`,
    title: "跟进确认后的行动",
    kind: "self",
    notes: "只保存用户 Todo 备注",
    ownerLabel: null,
    currentDueDate: "2026-09-08",
    isImportant: true,
    myDayDate: "2026-09-02",
    ownershipOverrideConfirmed: false,
    ...overrides
  });
}

describe("WorkTodoRepository", () => {
  it("migrates the Work database to v3 with scoped indexes and no extra database", () => {
    expect(database.pragma("user_version", { simple: true })).toBe(WORK_REVIEW_SCHEMA_VERSION);
    expect(WORK_REVIEW_SCHEMA_VERSION).toBe(4);
    const tables = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'wr_todo%'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      "wr_todo_events",
      "wr_todo_operations",
      "wr_todos"
    ]);
    const uniqueIndex = database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_wr_todos_one_active_source'
    `).get() as { sql: string };
    expect(uniqueIndex.sql).toContain("account_id, source_finding_id");
    expect(uniqueIndex.sql).toContain("deleted_at IS NULL");
  });

  it("validates manual fields, isolates accounts, and replays only the same operation", () => {
    const firstInput = {
      accountId: "account_a",
      operationKey: "manual_once",
      title: "  完成 Todo 页面  ",
      kind: "self" as const,
      notes: null,
      ownerLabel: null,
      currentDueDate: "2026-09-08",
      isImportant: false,
      myDayDate: "2026-09-02"
    };
    const first = repository.createManualTodo(firstInput);
    const replay = repository.createManualTodo(firstInput);
    expect(first.reused).toBe(false);
    expect(first.todo.title).toBe("完成 Todo 页面");
    expect(replay).toEqual({ todo: first.todo, reused: true });
    expect(() => repository.createManualTodo({ ...firstInput, title: "不同请求" }))
      .toThrowError(expect.objectContaining({ code: "work_todo_operation_conflict" }));

    expect(() => createManual({
      kind: "waiting_for_other",
      ownerLabel: null
    })).toThrowError(expect.objectContaining({ code: "work_todo_invalid_request" }));
    expect(() => createManual({ title: " ", operationKey: "empty_title" }))
      .toThrow(WorkReviewConflictError);
    expect(() => createManual({ title: "x".repeat(241), operationKey: "long_title" }))
      .toThrow(WorkReviewConflictError);
    expect(() => createManual({ currentDueDate: "2026-02-30", operationKey: "bad_date" }))
      .toThrow(WorkReviewConflictError);

    expect(() => repository.getTodo("account_b", first.todo.id)).toThrow(WorkTodoNotFoundError);
    expect(() => repository.updateTodo({
      accountId: "account_b",
      todoId: first.todo.id,
      expectedVersion: 0,
      operationKey: "cross_update",
      title: "越权"
    })).toThrow(WorkTodoNotFoundError);
    expect(() => repository.completeTodo({
      accountId: "account_b",
      todoId: first.todo.id,
      expectedVersion: 0,
      operationKey: "cross_complete"
    })).toThrow(WorkTodoNotFoundError);
    expect(() => repository.deleteTodo({
      accountId: "account_b",
      todoId: first.todo.id,
      expectedVersion: 0,
      operationKey: "cross_delete"
    })).toThrow(WorkTodoNotFoundError);
  });

  it("keeps omitted patch fields, enforces optimistic versions, and preserves source-independent state", () => {
    const created = createManual({
      operationKey: "manual_patch",
      notes: "保留备注",
      ownerLabel: "我",
      currentDueDate: "2026-09-08",
      myDayDate: "2026-09-02",
      isImportant: true
    }).todo;
    const updated = repository.updateTodo({
      accountId: "account_a",
      todoId: created.id,
      expectedVersion: created.version,
      operationKey: "update_title_only",
      title: "只修改标题"
    }).todo;
    expect(updated).toMatchObject({
      title: "只修改标题",
      notes: "保留备注",
      ownerLabel: "我",
      currentDueDate: "2026-09-08",
      myDayDate: "2026-09-02",
      isImportant: true,
      version: 1
    });
    expect(() => repository.updateTodo({
      accountId: "account_a",
      todoId: created.id,
      expectedVersion: 0,
      operationKey: "stale_update",
      title: "过期写入"
    })).toThrowError(expect.objectContaining({ currentVersion: 1 }));
    expect(() => repository.updateTodo({
      accountId: "account_a",
      todoId: created.id,
      expectedVersion: 0,
      operationKey: "stale_update"
    } as never)).toThrow(WorkReviewConflictError);
    expect(WorkReviewVersionConflictError).toBeDefined();
  });

  it("implements explicit Today plus stable all, planned, waiting, and completed views", () => {
    const todaySelf = createManual({
      operationKey: "today_self",
      title: "今天我的待办",
      myDayDate: "2026-09-02",
      currentDueDate: "2026-09-02"
    }).todo;
    const yesterday = createManual({
      operationKey: "yesterday_self",
      title: "昨天加入今天",
      myDayDate: "2026-09-01",
      currentDueDate: "2026-09-01"
    }).todo;
    const overdueNotToday = createManual({
      operationKey: "overdue_self",
      title: "逾期但未加入今天",
      currentDueDate: "2026-08-30"
    }).todo;
    const waitingToday = createManual({
      operationKey: "waiting_today",
      title: "今天跟进 Alex",
      kind: "waiting_for_other",
      ownerLabel: "Alex",
      myDayDate: "2026-09-02",
      currentDueDate: "2026-09-03"
    }).todo;

    expect(repository.listTodos({ accountId: "account_a", view: "today", day: "2026-09-02" })
      .map((todo) => todo.id)).toEqual([todaySelf.id, waitingToday.id]);
    expect(repository.listTodos({ accountId: "account_a", view: "all" }).map((todo) => todo.id))
      .toEqual(expect.arrayContaining([todaySelf.id, yesterday.id, overdueNotToday.id]));
    expect(repository.listTodos({ accountId: "account_a", view: "all" }))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ id: waitingToday.id })]));
    expect(repository.listTodos({ accountId: "account_a", view: "waiting" }).map((todo) => todo.id))
      .toEqual([waitingToday.id]);
    expect(repository.listTodos({ accountId: "account_a", view: "planned" }).map((todo) => todo.id))
      .toEqual([overdueNotToday.id, yesterday.id, todaySelf.id, waitingToday.id]);

    const completed = repository.completeTodo({
      accountId: "account_a",
      todoId: todaySelf.id,
      expectedVersion: todaySelf.version,
      operationKey: "complete_today"
    });
    expect(repository.listTodos({ accountId: "account_a", view: "today", day: "2026-09-02" })
      .some((todo) => todo.id === todaySelf.id)).toBe(false);
    expect(repository.listTodos({ accountId: "account_a", view: "completed" }).map((todo) => todo.id))
      .toEqual([todaySelf.id]);
    const duplicateComplete = repository.completeTodo({
      accountId: "account_a",
      todoId: todaySelf.id,
      expectedVersion: todaySelf.version,
      operationKey: "complete_again"
    });
    expect(duplicateComplete.reused).toBe(true);
    expect(database.prepare(`
      SELECT count(*) AS count FROM wr_todo_events
      WHERE todo_id = ? AND event_type = 'todo.completed'
    `).get(todaySelf.id)).toEqual({ count: 1 });

    const reopened = repository.reopenTodo({
      accountId: "account_a",
      todoId: todaySelf.id,
      expectedVersion: completed.todo.version,
      operationKey: "reopen_today"
    }).todo;
    expect(reopened.myDayDate).toBe("2026-09-02");
    const removed = repository.removeFromMyDay({
      accountId: "account_a",
      todoId: reopened.id,
      expectedVersion: reopened.version,
      operationKey: "remove_today"
    }).todo;
    expect(removed.myDayDate).toBeNull();
    const added = repository.setMyDay({
      accountId: "account_a",
      todoId: waitingToday.id,
      expectedVersion: waitingToday.version,
      operationKey: "move_waiting_day",
      day: "2026-09-03"
    }).todo;
    expect(added.myDayDate).toBe("2026-09-03");
  });

  it("projects only confirmed action or commitment Findings and preserves action-basis safety", () => {
    const assigned = seedFinding({ actionBasis: "assignment_without_acceptance" });
    expect(() => projectFinding(assigned, {
      operationKey: "assignment_without_override",
      kind: "self",
      ownershipOverrideConfirmed: false
    })).toThrowError(expect.objectContaining({ code: "work_todo_ownership_override_required" }));
    const projected = projectFinding(assigned, {
      operationKey: "assignment_with_override",
      kind: "self",
      ownershipOverrideConfirmed: true,
      sourceOriginalDueAt: "2099-01-01T00:00:00.000Z"
    } as never);
    expect(projected.todo).toMatchObject({
      origin: "meeting_finding",
      sourceMeetingId: assigned.meetingId,
      sourceFindingId: assigned.findingId,
      sourceFindingVersion: 2,
      sourceFindingKind: "action_item",
      sourceOriginalDueAt: assigned.structuredData.dueAt,
      sourceOriginalDueExpression: "下周二前",
      sourceActionBasis: "assignment_without_acceptance"
    });
    const duplicate = projectFinding(assigned, {
      operationKey: "same_finding_second_click",
      kind: "waiting_for_other",
      ownerLabel: "Alex"
    });
    expect(duplicate).toMatchObject({ reused: true, todo: { id: projected.todo.id } });
    expect(database.prepare(`
      SELECT count(*) AS count FROM wr_todos WHERE account_id = ? AND source_finding_id = ?
        AND deleted_at IS NULL
    `).get("account_a", assigned.findingId)).toEqual({ count: 1 });

    const commitment = seedFinding({ kind: "commitment" });
    expect(projectFinding(commitment).todo.sourceFindingKind).toBe("commitment");
    const decision = seedFinding({ kind: "decision" });
    expect(() => projectFinding(decision)).toThrowError(expect.objectContaining({
      code: "work_todo_finding_kind_not_projectable"
    }));
    expect(() => repository.createTodoFromFinding({
      accountId: "account_b",
      meetingId: assigned.meetingId,
      findingId: assigned.findingId,
      operationKey: "cross_projection",
      title: "越权",
      kind: "self",
      notes: null,
      ownerLabel: null,
      currentDueDate: null,
      isImportant: false,
      myDayDate: null,
      ownershipOverrideConfirmed: true
    })).toThrow(WorkTodoNotFoundError);
  });

  it("resolves only minimal canonical source context and reports later Finding versions", () => {
    const source = seedFinding({ kind: "commitment" });
    const projected = projectFinding(source).todo;
    const beforePayload = database.prepare(`
      SELECT payload_json FROM wr_canonical_publications WHERE publication_id = ?
    `).get(source.publicationId) as { payload_json: string };
    const resolved = repository.getTodoSource("account_a", projected.id);
    expect(resolved.evidenceContexts.map((context) => context.segmentId)).toEqual(
      source.segments.slice(1, 4).map((segment) => segment.id)
    );
    expect(resolved.evidenceContexts.filter((context) => context.isDirectEvidence))
      .toEqual([expect.objectContaining({
        segmentId: source.segments[2]!.id,
        displaySpeakerLabel: "Alex（会议内）"
      })]);
    expect(JSON.stringify(resolved)).not.toContain("不可返回的远端上下文");

    database.prepare(`UPDATE wr_findings SET version = 3, title = '后来修改的会议结果' WHERE id = ?`)
      .run(source.findingId);
    const detail = repository.getTodoDetail("account_a", projected.id);
    expect(detail.source).toMatchObject({
      state: "changed",
      sourceChanged: true,
      currentFindingVersion: 3
    });
    expect(detail.todo.title).toBe("跟进确认后的行动");
    const changedSource = repository.getTodoSource("account_a", projected.id);
    expect(changedSource.sourceChanged).toBe(true);
    expect(changedSource.finding.title).toBe("后来修改的会议结果");

    const updated = repository.updateTodo({
      accountId: "account_a",
      todoId: projected.id,
      expectedVersion: projected.version,
      operationKey: "edit_projected_todo",
      title: "用户自己的任务标题",
      currentDueDate: "2026-09-20"
    }).todo;
    expect(updated.sourceOriginalDueAt).toBe(source.structuredData.dueAt);
    expect(updated.currentDueDate).toBe("2026-09-20");
    expect(database.prepare(`SELECT title, version FROM wr_findings WHERE id = ?`).get(source.findingId))
      .toEqual({ title: "后来修改的会议结果", version: 3 });
    expect(database.prepare(`SELECT payload_json FROM wr_canonical_publications WHERE publication_id = ?`)
      .get(source.publicationId)).toEqual(beforePayload);
  });

  it("soft-deletes Todo independently and allows an explicit new projection after deletion", () => {
    const source = seedFinding({});
    const first = projectFinding(source).todo;
    const deleted = repository.deleteTodo({
      accountId: "account_a",
      todoId: first.id,
      expectedVersion: first.version,
      operationKey: "delete_projected"
    });
    expect(deleted.todo.deletedAt).toBe(initialNow);
    expect(() => repository.getTodo("account_a", first.id)).toThrow(WorkTodoNotFoundError);
    expect(database.prepare(`SELECT count(*) AS count FROM wr_findings WHERE id = ?`).get(source.findingId))
      .toEqual({ count: 1 });
    expect(database.prepare(`SELECT count(*) AS count FROM wr_meetings WHERE id = ?`).get(source.meetingId))
      .toEqual({ count: 1 });
    const second = projectFinding(source, { operationKey: "recreate_after_delete" });
    expect(second.todo.id).not.toBe(first.id);
    expect(second.reused).toBe(false);
  });

  it("offers account-scoped meeting projections and transaction-safe detach/delete primitives", () => {
    const detachSource = seedFinding({ meetingId: "meeting_detach", findingId: "finding_detach" });
    const deleteSource = seedFinding({
      meetingId: "meeting_delete",
      findingId: "finding_delete",
      kind: "commitment"
    });
    const detachedTodo = projectFinding(detachSource, { operationKey: "project_detach" }).todo;
    const deletedTodo = projectFinding(deleteSource, { operationKey: "project_delete" }).todo;
    const manualTodo = createManual({ operationKey: "manual_unaffected" }).todo;

    expect(repository.listMeetingTodoProjections("account_a", detachSource.meetingId))
      .toEqual([{
        id: detachedTodo.id,
        sourceFindingId: detachSource.findingId,
        status: "open",
        title: detachedTodo.title,
        version: detachedTodo.version,
        kind: detachedTodo.kind,
        currentDueDate: detachedTodo.currentDueDate,
        sourceOriginalDueAt: detachedTodo.sourceOriginalDueAt,
        sourceOriginalDueExpression: detachedTodo.sourceOriginalDueExpression
      }]);
    expect(repository.listMeetingTodoProjections("account_b", detachSource.meetingId)).toEqual([]);
    expect(repository.listActiveMeetingTodoIds("account_a", detachSource.meetingId))
      .toEqual([detachedTodo.id]);

    const detachTransaction = database.transaction(() => repository.detachLinkedMeetingTodos(
      "account_a",
      detachSource.meetingId,
      "2026-09-02T09:00:00.000Z"
    ));
    expect(detachTransaction.immediate()).toEqual([detachedTodo.id]);
    const detached = repository.getTodo("account_a", detachedTodo.id);
    expect(detached).toMatchObject({
      origin: "detached_meeting_finding",
      sourceMeetingId: null,
      sourceFindingId: null,
      sourceFindingVersion: null,
      sourceFindingKind: null,
      sourceOwnerLabel: null,
      sourceOriginalDueAt: null,
      sourceOriginalDueExpression: null,
      sourceActionBasis: null,
      sourceDetachedAt: "2026-09-02T09:00:00.000Z"
    });
    expect(() => repository.getTodoSource("account_a", detachedTodo.id))
      .toThrowError(expect.objectContaining({ code: "work_todo_source_unavailable" }));

    const deleteTransaction = database.transaction(() => repository.deleteLinkedMeetingTodos(
      "account_a",
      deleteSource.meetingId,
      "2026-09-02T10:00:00.000Z"
    ));
    expect(deleteTransaction.immediate()).toEqual([deletedTodo.id]);
    expect(() => repository.getTodo("account_a", deletedTodo.id)).toThrow(WorkTodoNotFoundError);
    expect(repository.getTodo("account_a", manualTodo.id).origin).toBe("manual");
    const eventPayloads = database.prepare(`SELECT payload_json FROM wr_todo_events`).all() as Array<{
      payload_json: string;
    }>;
    expect(eventPayloads.every((row) => !row.payload_json.includes("最小来源上下文"))).toBe(true);
  });
});
