import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import { openWorkReviewDatabase } from "./db";
import { WorkProjectRepository } from "./project-repository";
import { WorkReviewConflictError, WorkReviewRepository } from "./repository";
import { WorkTodoRepository } from "./todo-repository";

let databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases) database.close();
  databases = [];
});

function setup() {
  const database = openWorkReviewDatabase({ filePath: ":memory:" });
  databases.push(database);
  let id = 0;
  const options = {
    now: () => "2026-09-03T00:00:00.000Z",
    idFactory: () => `id_${++id}`
  };
  const projects = new WorkProjectRepository(database, options);
  const project = projects.createProject({
    accountId: "account_a", operationKey: "create_project",
    name: "Alpha", description: null
  }).project;
  return { database, options, projects, project };
}

describe("Project creation integration", () => {
  it("reserves Meeting and Project links in one idempotent transaction", () => {
    const { database, options, projects, project } = setup();
    const repository = new WorkReviewRepository(database, options);
    const input = {
      accountId: "account_a", idempotencyKey: "upload_1", operationKey: "upload_1",
      contentHash: "a".repeat(64), sourceUploadId: "source_1",
      meetingDate: "2026-09-03", projectIds: [project.id]
    };
    const first = repository.reserveMeeting(input);
    expect(projects.listMeetingProjects("account_a", first.meeting.id).map((value) => value.id))
      .toEqual([project.id]);
    expect(repository.reserveMeeting(input)).toMatchObject({ reused: true });
    expect(() => repository.reserveMeeting({ ...input, projectIds: [] }))
      .toThrow(WorkReviewConflictError);
  });

  it("creates and deletes Todo links atomically without inheriting Meeting projects", () => {
    const { database, options, projects, project } = setup();
    const todos = new WorkTodoRepository(database, options);
    const beta = projects.createProject({
      accountId: "account_a", operationKey: "create_project_beta",
      name: "Beta", description: null
    }).project;
    const createInput = {
      accountId: "account_a", operationKey: "todo_1", title: "Prepare",
      kind: "self" as const, notes: null, ownerLabel: null, currentDueDate: null,
      isImportant: false, myDayDate: null, projectIds: [project.id, beta.id]
    };
    const created = todos.createManualTodo(createInput).todo;
    expect(todos.createManualTodo({
      ...createInput, projectIds: [beta.id, project.id]
    })).toMatchObject({ todo: { id: created.id }, reused: true });
    expect(projects.listTodoProjects("account_a", created.id).map((value) => value.id).sort())
      .toEqual([project.id, beta.id].sort());
    todos.deleteTodo({
      accountId: "account_a", todoId: created.id,
      expectedVersion: created.version, operationKey: "delete_todo"
    });
    expect(database.prepare(`
      SELECT count(*) AS count FROM wr_todo_projects WHERE account_id = ? AND todo_id = ?
    `).get("account_a", created.id)).toEqual({ count: 0 });
  });
});
