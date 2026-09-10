import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openWorkReviewDatabase } from "./db";
import {
  WorkProjectConflictError,
  WorkProjectNotFoundError,
  WorkProjectRepository,
  WorkProjectVersionConflictError
} from "./project-repository";

let database: Database.Database;
let repository: WorkProjectRepository;
let idSequence: number;

function seedMeeting(accountId: string, meetingId: string, version = 0) {
  database.prepare(`
    INSERT INTO wr_meetings (
      id, account_id, product_space, title, meeting_date, source_upload_id,
      ingestion_status, analysis_status, review_status, version, created_at, updated_at
    ) VALUES (?, ?, 'office_review', ?, '2026-09-02', ?,
      'created', 'not_started', 'not_started', ?, ?, ?)
  `).run(
    meetingId,
    accountId,
    `Meeting ${meetingId}`,
    `upload_${meetingId}`,
    version,
    "2026-09-02T00:00:00.000Z",
    "2026-09-02T00:00:00.000Z"
  );
}

function seedTodo(accountId: string, todoId: string, version = 0) {
  database.prepare(`
    INSERT INTO wr_todos (
      id, account_id, kind, status, origin, title, is_important,
      version, created_at, updated_at
    ) VALUES (?, ?, 'self', 'open', 'manual', ?, 0, ?, ?, ?)
  `).run(
    todoId,
    accountId,
    `Todo ${todoId}`,
    version,
    "2026-09-02T00:00:00.000Z",
    "2026-09-02T00:00:00.000Z"
  );
}

function createProject(name: string, operationKey: string, accountId = "account_a") {
  return repository.createProject({ accountId, operationKey, name, description: null });
}

beforeEach(() => {
  database = openWorkReviewDatabase({ filePath: ":memory:" });
  idSequence = 0;
  repository = new WorkProjectRepository(database, {
    now: () => "2026-09-03T02:00:00.000Z",
    idFactory: () => `project-${++idSequence}`
  });
});

afterEach(() => {
  database.close();
});

describe("WorkProjectRepository", () => {
  it("creates, replays, archives, restores, and enforces active normalized names", () => {
    const created = createProject(" Project Alpha ", "create-alpha");
    expect(created.project).toMatchObject({
      id: "wrp_project-1",
      accountId: "account_a",
      name: "Project Alpha",
      status: "active",
      version: 0
    });
    expect(createProject(" Project Alpha ", "create-alpha")).toEqual({
      ...created,
      reused: true
    });
    expect(() => createProject("project alpha", "duplicate-alpha"))
      .toThrow(WorkProjectConflictError);
    expect(() => createProject("Different request", "create-alpha"))
      .toThrow(WorkProjectConflictError);

    const archived = repository.updateProject({
      accountId: "account_a",
      projectId: created.project.id,
      expectedVersion: 0,
      operationKey: "archive-alpha",
      status: "archived"
    });
    expect(archived.project).toMatchObject({ status: "archived", version: 1 });
    expect(archived.project.archivedAt).not.toBeNull();

    const replacement = createProject("PROJECT ALPHA", "create-replacement");
    expect(replacement.project.status).toBe("active");
    expect(() => repository.updateProject({
      accountId: "account_a",
      projectId: created.project.id,
      expectedVersion: 1,
      operationKey: "restore-alpha",
      status: "active"
    })).toThrow(WorkProjectConflictError);
    expect(repository.listProjects({ accountId: "account_a", status: "archived" }))
      .toHaveLength(1);
    expect(repository.listProjects({ accountId: "account_a", status: "active" }))
      .toEqual([replacement.project]);
  });

  it("uses NFKC plus caseless matching without rejecting compatibility expansion", () => {
    createProject("ＦＯＯ", "create-fullwidth");
    expect(() => createProject("foo", "duplicate-fullwidth"))
      .toThrow(WorkProjectConflictError);
    createProject("Straße", "create-sharp-s");
    expect(() => createProject("STRASSE", "duplicate-sharp-s"))
      .toThrow(WorkProjectConflictError);
    createProject("ẞ", "create-capital-sharp-s");
    expect(() => createProject("SS", "duplicate-capital-sharp-s"))
      .toThrow(WorkProjectConflictError);
    createProject("ς", "create-final-sigma");
    expect(() => createProject("σ", "duplicate-final-sigma"))
      .toThrow(WorkProjectConflictError);
    expect(() => createProject("ﷺ".repeat(60), "create-expanded-name")).not.toThrow();
  });

  it("enforces account scope and optimistic project versions", () => {
    const project = createProject("Private A", "create-private").project;
    expect(() => repository.getProject("account_b", project.id))
      .toThrow(WorkProjectNotFoundError);
    expect(() => repository.updateProject({
      accountId: "account_a",
      projectId: project.id,
      expectedVersion: 7,
      operationKey: "stale-update",
      name: "Stale"
    })).toThrow(WorkProjectVersionConflictError);
  });

  it("sets zero to three Meeting projects with CAS, replay, and cross-account safety", () => {
    seedMeeting("account_a", "meeting_a", 4);
    seedMeeting("account_b", "meeting_b", 0);
    const projects = [
      createProject("Alpha", "create-a").project,
      createProject("Beta", "create-b").project,
      createProject("Gamma", "create-c").project,
      createProject("Private B", "create-private-b", "account_b").project
    ];
    const linked = repository.setMeetingProjects({
      accountId: "account_a",
      meetingId: "meeting_a",
      expectedVersion: 4,
      operationKey: "set-meeting-projects",
      projectIds: [projects[2]!.id, projects[0]!.id, projects[1]!.id]
    });
    expect(linked).toMatchObject({ resourceId: "meeting_a", resourceVersion: 5, changed: true });
    expect(linked.projects.map((project) => project.id).sort())
      .toEqual(projects.slice(0, 3).map((project) => project.id).sort());
    expect(repository.setMeetingProjects({
      accountId: "account_a",
      meetingId: "meeting_a",
      expectedVersion: 4,
      operationKey: "set-meeting-projects",
      projectIds: [projects[2]!.id, projects[0]!.id, projects[1]!.id]
    }).reused).toBe(true);
    expect(() => repository.setMeetingProjects({
      accountId: "account_a",
      meetingId: "meeting_a",
      expectedVersion: 5,
      operationKey: "cross-account-project",
      projectIds: [projects[3]!.id]
    })).toThrow(WorkProjectNotFoundError);
    expect(() => repository.setMeetingProjects({
      accountId: "account_a",
      meetingId: "meeting_b",
      expectedVersion: 0,
      operationKey: "cross-account-meeting",
      projectIds: []
    })).toThrow(WorkProjectNotFoundError);
    expect(() => repository.setMeetingProjects({
      accountId: "account_a",
      meetingId: "meeting_a",
      expectedVersion: 5,
      operationKey: "too-many",
      projectIds: projects.map((project) => project.id)
    })).toThrow();
    expect(() => repository.setMeetingProjects({
      accountId: "account_a",
      meetingId: "meeting_a",
      expectedVersion: 5,
      operationKey: "duplicate-project",
      projectIds: [projects[0]!.id, projects[0]!.id]
    })).toThrow();

    const unchanged = repository.setMeetingProjects({
      accountId: "account_a",
      meetingId: "meeting_a",
      expectedVersion: 5,
      operationKey: "same-projects-new-operation",
      projectIds: [projects[0]!.id, projects[1]!.id, projects[2]!.id]
    });
    expect(unchanged).toMatchObject({ resourceVersion: 5, changed: false, reused: false });

    const cleared = repository.setMeetingProjects({
      accountId: "account_a",
      meetingId: "meeting_a",
      expectedVersion: 5,
      operationKey: "clear-meeting-projects",
      projectIds: []
    });
    expect(cleared).toMatchObject({ resourceVersion: 6, projects: [], changed: true });
  });

  it("sets Todo projects independently and does not follow later Meeting changes", () => {
    seedMeeting("account_a", "meeting_a");
    seedTodo("account_a", "todo_a", 2);
    const alpha = createProject("Alpha", "alpha").project;
    const beta = createProject("Beta", "beta").project;
    repository.setMeetingProjects({
      accountId: "account_a",
      meetingId: "meeting_a",
      expectedVersion: 0,
      operationKey: "meeting-alpha",
      projectIds: [alpha.id]
    });
    repository.setTodoProjects({
      accountId: "account_a",
      todoId: "todo_a",
      expectedVersion: 2,
      operationKey: "todo-alpha",
      projectIds: [alpha.id]
    });
    repository.setMeetingProjects({
      accountId: "account_a",
      meetingId: "meeting_a",
      expectedVersion: 1,
      operationKey: "meeting-beta",
      projectIds: [beta.id]
    });
    repository.updateProject({
      accountId: "account_a",
      projectId: alpha.id,
      expectedVersion: 0,
      operationKey: "archive-alpha",
      status: "archived"
    });
    expect(repository.listTodoProjects("account_a", "todo_a"))
      .toEqual([expect.objectContaining({ id: alpha.id, status: "archived", version: 1 })]);
  });

  it("filters all, project, and unassigned without duplicating multi-project resources", () => {
    seedMeeting("account_a", "meeting_assigned");
    seedMeeting("account_a", "meeting_unassigned");
    seedMeeting("account_b", "meeting_other");
    seedTodo("account_a", "todo_assigned");
    seedTodo("account_a", "todo_unassigned");
    const alpha = createProject("Alpha", "alpha").project;
    const beta = createProject("Beta", "beta").project;
    repository.setMeetingProjects({
      accountId: "account_a",
      meetingId: "meeting_assigned",
      expectedVersion: 0,
      operationKey: "meeting-multi",
      projectIds: [alpha.id, beta.id]
    });
    repository.setTodoProjects({
      accountId: "account_a",
      todoId: "todo_assigned",
      expectedVersion: 0,
      operationKey: "todo-alpha",
      projectIds: [alpha.id]
    });

    expect(repository.listMeetingIdsByScope("account_a", { kind: "all" }))
      .toEqual(["meeting_assigned", "meeting_unassigned"]);
    expect(repository.listMeetingIdsByScope("account_a", { kind: "project", projectId: beta.id }))
      .toEqual(["meeting_assigned"]);
    expect(repository.listMeetingIdsByScope("account_a", { kind: "unassigned" }))
      .toEqual(["meeting_unassigned"]);
    expect(repository.listTodoIdsByScope("account_a", { kind: "project", projectId: alpha.id }))
      .toEqual(["todo_assigned"]);
    expect(repository.listTodoIdsByScope("account_a", { kind: "unassigned" }))
      .toEqual(["todo_unassigned"]);
  });

  it("fails closed for tombstoned Meetings and soft-deleted Todos", () => {
    seedMeeting("account_a", "meeting_deleted");
    seedTodo("account_a", "todo_deleted");
    const project = createProject("Alpha", "alpha").project;
    database.prepare(`
      INSERT INTO wr_tombstones (
        account_id, meeting_id, source_upload_id, transcription_attempt_version,
        analysis_attempt_version, cleanup_status, deleted_at
      ) VALUES ('account_a', 'meeting_deleted', 'upload_meeting_deleted', 0, 0,
        'pending', '2026-09-03T02:00:00.000Z')
    `).run();
    database.prepare(`
      UPDATE wr_todos SET deleted_at = '2026-09-03T02:00:00.000Z'
      WHERE id = 'todo_deleted' AND account_id = 'account_a'
    `).run();
    expect(() => repository.setMeetingProjects({
      accountId: "account_a",
      meetingId: "meeting_deleted",
      expectedVersion: 0,
      operationKey: "deleted-meeting-link",
      projectIds: [project.id]
    })).toThrow(WorkProjectNotFoundError);
    expect(() => repository.setTodoProjects({
      accountId: "account_a",
      todoId: "todo_deleted",
      expectedVersion: 0,
      operationKey: "deleted-todo-link",
      projectIds: [project.id]
    })).toThrow(WorkProjectNotFoundError);
  });
});
