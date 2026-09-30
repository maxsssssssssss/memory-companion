import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openWorkReviewDatabase } from "./db";
import { WorkProjectRepository } from "./project-repository";
import { WorkReviewRepository } from "./repository";
import { migrateWorkReviewSchema } from "./schema";
import { WorkTodoRepository } from "./todo-repository";
import { WorkWeeklyRepository } from "./weekly-repository";
import { buildWorkWeeklySourceSnapshot } from "./weekly-source-builder";

let db: Database.Database;
let projects: WorkProjectRepository;
let todos: WorkTodoRepository;
const accountId = "account_a";
const now = "2026-09-03T02:00:00.000Z";

beforeEach(() => {
  db = openWorkReviewDatabase({ filePath: ":memory:" });
  projects = new WorkProjectRepository(db, { now: () => now });
  // Create sources before the snapshot's exclusive observation boundary.
  todos = new WorkTodoRepository(db, { now: () => "2026-09-03T01:00:00.000Z" });
});
afterEach(() => db.close());

function archivedProject() {
  const project = projects.createProject({ accountId, name: "Archived project", operationKey: "create" }).project;
  return projects.updateProject({ accountId, projectId: project.id, operationKey: "archive",
    expectedVersion: 0, status: "archived" }).project;
}

function createTodo(projectIds: string[], operationKey = "todo") {
  return todos.createManualTodo({ accountId, operationKey, kind: "self", title: "Prepare draft",
    notes: null, ownerLabel: null, currentDueDate: null, isImportant: false, myDayDate: null,
    projectIds }).todo;
}

function snapshot(projectId: string | null = null) {
  return buildWorkWeeklySourceSnapshot({ database: db, accountId, now: new Date(now), scope: {
    weekStart: "2026-08-31", timeZone: "Asia/Shanghai",
    scopeKind: projectId ? "project" : "all", projectId
  } });
}

describe("archived project deletion", () => {
  it("unlinks only the deleted project, preserves resources and makes repeat deletion harmless", () => {
    const project = archivedProject();
    const other = projects.createProject({ accountId, name: "Keep", operationKey: "other" }).project;
    const todo = createTodo([project.id, other.id]);
    const meetings = new WorkReviewRepository(db, { now: () => now });
    const meeting = meetings.reserveMeeting({ accountId, idempotencyKey: "upload", operationKey: "upload",
      contentHash: "a".repeat(64), sourceUploadId: "upload", meetingDate: "2026-09-03",
      projectIds: [project.id] }).meeting;
    const todoEvents = db.prepare("SELECT * FROM wr_todo_events").all();
    const beforeTodo = todos.getTodo(accountId, todo.id);
    const beforeMeeting = db.prepare("SELECT * FROM wr_meetings WHERE id = ?").get(meeting.id);
    const request = { accountId, projectId: project.id, expectedVersion: project.version };
    expect(projects.deleteProject(request)).toEqual({ deleted: true });
    expect(projects.deleteProject(request)).toEqual({ deleted: true });
    expect(projects.listProjects({ accountId, status: "all" })).toEqual([other]);
    expect(projects.listTodoProjects(accountId, todo.id).map((item) => item.id)).toEqual([other.id]);
    expect(projects.listMeetingProjects(accountId, meeting.id)).toEqual([]);
    expect(projects.listMeetingIdsByScope(accountId, { kind: "unassigned" })).toContain(meeting.id);
    expect(todos.getTodo(accountId, todo.id)).toEqual({ ...beforeTodo, version: todo.version + 1, updatedAt: now });
    expect(db.prepare("SELECT * FROM wr_meetings WHERE id = ?").get(meeting.id))
      .toEqual({ ...beforeMeeting as object, version: meeting.version + 1, updated_at: now });
    expect(db.prepare("SELECT * FROM wr_todo_events").all()).toEqual(todoEvents);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("requires the owning account, the current version and archived status", () => {
    const project = archivedProject();
    const request = { accountId, projectId: project.id, expectedVersion: project.version };
    expect(() => projects.deleteProject({ ...request, accountId: "account_b" })).toThrow("project_not_found");
    expect(() => projects.deleteProject({ ...request, expectedVersion: 0 })).toThrow("version_conflict");
    projects.updateProject({ ...request, status: "active", operationKey: "restore" });
    expect(() => projects.deleteProject(request)).toThrow("version_conflict");
    expect(() => projects.deleteProject({ ...request, expectedVersion: 2 })).toThrow("project_not_archived");
    expect(projects.getProject(accountId, project.id).status).toBe("active");
  });

  it("blocks stale create, restore, association replay and new links without resurrection", () => {
    const project = archivedProject();
    const todo = createTodo([]);
    const link = { accountId, todoId: todo.id, projectIds: [project.id],
      operationKey: "link", expectedVersion: todo.version };
    projects.setTodoProjects(link);
    projects.deleteProject({ accountId, projectId: project.id, expectedVersion: project.version });
    expect(() => projects.getProject(accountId, project.id)).toThrow("project_not_found");
    expect(() => projects.createProject({ accountId, name: "Archived project", operationKey: "create" }))
      .toThrow("project_not_found");
    expect(() => projects.updateProject({ accountId, projectId: project.id, operationKey: "late-restore",
      expectedVersion: project.version, status: "active" })).toThrow("project_not_found");
    expect(() => projects.setTodoProjects(link)).toThrow("project_not_found");
    expect(() => projects.setTodoProjects({ ...link, operationKey: "new-link", expectedVersion: 2 }))
      .toThrow("project_not_found");
    expect(() => createTodo([project.id], "new-todo")).toThrow("work_project_not_found");
    expect(() => new WorkReviewRepository(db).reserveMeeting({ accountId, idempotencyKey: "late",
      operationKey: "late", sourceUploadId: "late", contentHash: "b".repeat(64),
      meetingDate: "2026-09-03", projectIds: [project.id] })).toThrow("work_project_not_found");
    expect(projects.listTodoProjects(accountId, todo.id)).toEqual([]);
    expect(db.prepare("SELECT count(*) AS n FROM wr_todos").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM wr_meetings").get()).toEqual({ n: 0 });
  });

  it("rolls back link cleanup and versions if deletion fails inside the transaction", () => {
    const project = archivedProject();
    const todo = createTodo([project.id]);
    db.exec(`CREATE TRIGGER fail_project_delete BEFORE UPDATE OF deleted_at ON wr_projects
      BEGIN SELECT RAISE(ABORT, 'injected_failure'); END;`);
    expect(() => projects.deleteProject({ accountId, projectId: project.id, expectedVersion: project.version }))
      .toThrow("injected_failure");
    expect(projects.getProject(accountId, project.id)).toEqual(project);
    expect(todos.getTodo(accountId, todo.id).version).toBe(todo.version);
    expect(projects.listTodoProjects(accountId, todo.id).map((item) => item.id)).toEqual([project.id]);
  });

  it("preserves an existing v8 database when applying the idempotent migration", () => {
    const project = archivedProject();
    const todo = createTodo([project.id]);
    db.exec("ALTER TABLE wr_projects DROP COLUMN deleted_at; DELETE FROM wr_schema_migrations WHERE version = 9; PRAGMA user_version = 8;");
    migrateWorkReviewSchema(db);
    migrateWorkReviewSchema(db);
    expect(db.pragma("user_version", { simple: true })).toBe(9);
    expect(projects.getProject(accountId, project.id)).toEqual(project);
    expect(projects.listTodoProjects(accountId, todo.id)).toHaveLength(1);
    expect(db.prepare("SELECT count(*) AS n FROM wr_schema_migrations WHERE version = 9").get()).toEqual({ n: 1 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("supersedes even an empty project-scoped run and rejects its late publication", () => {
    const project = archivedProject();
    const source = snapshot(project.id);
    const weekly = new WorkWeeklyRepository(db, { now: () => now });
    const queued = weekly.queueGeneration({ accountId, snapshot: source,
      operationKey: "weekly", expectedVersion: null, kind: "generate" });
    const fence = weekly.claimGenerationRun({ accountId, runId: queued.run.id, leaseOwner: "test", leaseMs: 60_000 });
    projects.deleteProject({ accountId, projectId: project.id, expectedVersion: project.version });
    expect(weekly.getReview(accountId, queued.review.id).status).toBe("stale");
    expect(() => weekly.publishSystemVersion({ accountId, fence, currentSnapshot: source,
      synthesizerProfile: "fixture", verifierProfile: "fixture", items: [] }))
      .toThrow("Work Weekly lease is no longer owned");
    expect(() => snapshot(project.id)).toThrow("work_weekly_project_not_found");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("keeps published Weekly text and source records while cancelling pending QA", () => {
    const project = archivedProject();
    createTodo([project.id]);
    const source = snapshot();
    const weekly = new WorkWeeklyRepository(db, { now: () => now });
    const queued = weekly.queueGeneration({ accountId, snapshot: source, operationKey: "weekly",
      expectedVersion: null, kind: "generate" });
    const fence = weekly.claimGenerationRun({ accountId, runId: queued.run.id, leaseOwner: "test", leaseMs: 60_000 });
    const published = weekly.publishSystemVersion({ accountId, fence, currentSnapshot: source,
      synthesizerProfile: "fixture", verifierProfile: "fixture", items: [{ section: "overview",
        text: "Prepare draft", sourceRefs: [source.todos[0]!.sourceRef], verificationState: "verified", sortOrder: 0 }] });
    const qa = weekly.queueQuestion({ accountId, reviewId: published.review.id, snapshot: source,
      question: "What remains?", operationKey: "qa", expectedVersion: null });
    const qaFence = weekly.claimQaRun({ accountId, runId: qa.run.id, leaseOwner: "qa-test", leaseMs: 60_000 });
    const items = weekly.listItems(accountId, published.review.id);
    const sources = db.prepare("SELECT * FROM wr_weekly_item_sources").all();
    projects.deleteProject({ accountId, projectId: project.id, expectedVersion: project.version });
    expect(weekly.listItems(accountId, published.review.id)).toEqual(items);
    expect(db.prepare("SELECT * FROM wr_weekly_item_sources").all()).toEqual(sources);
    expect(db.prepare("SELECT state, lease_owner FROM wr_weekly_qa_runs WHERE id = ?").get(qa.run.id))
      .toEqual({ state: "superseded", lease_owner: null });
    expect(() => weekly.publishQaAnswer({ accountId, fence: qaFence, currentSnapshot: source,
      text: "Late answer", answerStatus: "answered", sourceRefs: [source.todos[0]!.sourceRef],
      providerProfile: "fixture", verifierProfile: "fixture", promptVersion: "fixture" }))
      .toThrow("Work Weekly lease is no longer owned");
    expect(weekly.getReview(accountId, published.review.id).status).toBe("stale");
    expect(snapshot().projects).toEqual([]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
