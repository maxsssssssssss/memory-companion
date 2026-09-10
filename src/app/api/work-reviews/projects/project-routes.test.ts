import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  enabled: true,
  accountId: "account_a",
  database: null as unknown as Database.Database
}));

const mocks = vi.hoisted(() => ({
  requireAuthContext: vi.fn(),
  getWorkReviewDatabase: vi.fn()
}));

vi.mock("@/lib/server/auth/request-context", () => ({
  requireAuthContext: mocks.requireAuthContext,
  isUnauthenticatedError: (error: unknown) =>
    error instanceof Error && error.message === "unauthenticated"
}));

vi.mock("@/lib/server/work-review/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/work-review/db")>();
  return { ...actual, getWorkReviewDatabase: mocks.getWorkReviewDatabase };
});

vi.mock("@/lib/server/work-review/runtime-config", () => ({
  isWorkReviewProjectsEnabled: () => state.enabled
}));

import { PATCH as patchMeetingProjects } from "@/app/api/work-reviews/meetings/[meetingId]/projects/route";
import { PATCH as patchTodoProjects } from "@/app/api/work-reviews/todos/[todoId]/projects/route";
import { GET as getProject, PATCH as patchProject } from "./[projectId]/route";
import { GET as listProjects, POST as createProject } from "./route";
import { openWorkReviewDatabase } from "@/lib/server/work-review/db";

function authContext(accountId: string) {
  return {
    user: { id: accountId, username: accountId },
    store: {},
    dataRootDir: "unused",
    uploadsRootDir: "unused"
  };
}

function jsonRequest(url: string, method: string, body: unknown) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function responseJson(response: Response) {
  return await response.json() as Record<string, unknown>;
}

function projectContext(projectId: string) {
  return { params: Promise.resolve({ projectId }) };
}

function meetingContext(meetingId: string) {
  return { params: Promise.resolve({ meetingId }) };
}

function todoContext(todoId: string) {
  return { params: Promise.resolve({ todoId }) };
}

function seedMeeting(accountId: string, meetingId: string) {
  state.database.prepare(`
    INSERT INTO wr_meetings (
      id, account_id, product_space, title, meeting_date, source_upload_id,
      ingestion_status, analysis_status, review_status, created_at, updated_at
    ) VALUES (?, ?, 'office_review', ?, '2026-09-02', ?,
      'created', 'not_started', 'not_started', ?, ?)
  `).run(
    meetingId,
    accountId,
    `Meeting ${meetingId}`,
    `upload_${meetingId}`,
    "2026-09-02T00:00:00.000Z",
    "2026-09-02T00:00:00.000Z"
  );
}

function seedTodo(accountId: string, todoId: string) {
  state.database.prepare(`
    INSERT INTO wr_todos (
      id, account_id, kind, status, origin, title, is_important, created_at, updated_at
    ) VALUES (?, ?, 'self', 'open', 'manual', ?, 0, ?, ?)
  `).run(
    todoId,
    accountId,
    `Todo ${todoId}`,
    "2026-09-02T00:00:00.000Z",
    "2026-09-02T00:00:00.000Z"
  );
}

beforeEach(() => {
  state.enabled = true;
  state.accountId = "account_a";
  state.database = openWorkReviewDatabase({ filePath: ":memory:" });
  mocks.getWorkReviewDatabase.mockReturnValue(state.database);
  mocks.requireAuthContext.mockImplementation(async () => authContext(state.accountId));
});

afterEach(() => {
  state.database.close();
  vi.clearAllMocks();
});

describe("Work Project routes", () => {
  it("fails closed before auth and applies private no-store to disabled and auth errors", async () => {
    state.enabled = false;
    const disabled = await listProjects(new Request("http://localhost/api/work-reviews/projects"));
    expect(disabled.status).toBe(404);
    expect(disabled.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.requireAuthContext).not.toHaveBeenCalled();

    state.enabled = true;
    mocks.requireAuthContext.mockRejectedValueOnce(new Error("unauthenticated"));
    const unauthorized = await listProjects(new Request("http://localhost/api/work-reviews/projects"));
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("cache-control")).toBe("private, no-store");
  });

  it("creates, lists, reads, archives, and restores an account-scoped Project", async () => {
    const created = await createProject(jsonRequest(
      "http://localhost/api/work-reviews/projects",
      "POST",
      { name: "Project Alpha", description: "Private", operationKey: "create-alpha" }
    ));
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("private, no-store");
    const createdProject = (await responseJson(created)).project as {
      id: string;
      version: number;
    };

    const listed = await listProjects(new Request("http://localhost/api/work-reviews/projects"));
    expect(((await responseJson(listed)).projects as unknown[])).toHaveLength(1);
    const read = await getProject(
      new Request(`http://localhost/api/work-reviews/projects/${createdProject.id}`),
      projectContext(createdProject.id)
    );
    expect(read.status).toBe(200);

    const archived = await patchProject(jsonRequest(
      `http://localhost/api/work-reviews/projects/${createdProject.id}`,
      "PATCH",
      { status: "archived", expectedVersion: 0, operationKey: "archive-alpha" }
    ), projectContext(createdProject.id));
    const archivedProject = (await responseJson(archived)).project as { version: number };
    expect(archivedProject.version).toBe(1);
    expect(((await responseJson(await listProjects(new Request(
      "http://localhost/api/work-reviews/projects?status=archived"
    )))).projects as unknown[])).toHaveLength(1);

    const restored = await patchProject(jsonRequest(
      `http://localhost/api/work-reviews/projects/${createdProject.id}`,
      "PATCH",
      { status: "active", expectedVersion: 1, operationKey: "restore-alpha" }
    ), projectContext(createdProject.id));
    expect(((await responseJson(restored)).project as { status: string }).status).toBe("active");
  });

  it("rejects forged account scope and maps operation/version conflicts", async () => {
    const forged = await createProject(jsonRequest(
      "http://localhost/api/work-reviews/projects",
      "POST",
      {
        accountId: "account_b",
        name: "Forged",
        operationKey: "forged-project"
      }
    ));
    expect(forged.status).toBe(400);
    expect(forged.headers.get("cache-control")).toBe("private, no-store");

    const created = await createProject(jsonRequest(
      "http://localhost/api/work-reviews/projects",
      "POST",
      { name: "Alpha", operationKey: "same-key" }
    ));
    const project = (await responseJson(created)).project as { id: string };
    const collision = await createProject(jsonRequest(
      "http://localhost/api/work-reviews/projects",
      "POST",
      { name: "Beta", operationKey: "same-key" }
    ));
    expect(collision.status).toBe(409);
    expect(await responseJson(collision)).toEqual({ error: "project_operation_conflict" });

    const stale = await patchProject(jsonRequest(
      `http://localhost/api/work-reviews/projects/${project.id}`,
      "PATCH",
      { name: "Updated", expectedVersion: 9, operationKey: "stale" }
    ), projectContext(project.id));
    expect(stale.status).toBe(409);
    expect(await responseJson(stale)).toEqual({ error: "version_conflict", currentVersion: 0 });

    state.accountId = "account_b";
    const hidden = await getProject(
      new Request(`http://localhost/api/work-reviews/projects/${project.id}`),
      projectContext(project.id)
    );
    expect(hidden.status).toBe(404);
  });

  it("sets Meeting and Todo projects with server-derived account scope", async () => {
    seedMeeting("account_a", "meeting_a");
    seedTodo("account_a", "todo_a");
    const created = await createProject(jsonRequest(
      "http://localhost/api/work-reviews/projects",
      "POST",
      { name: "Alpha", operationKey: "create-alpha" }
    ));
    const project = (await responseJson(created)).project as { id: string };

    const meeting = await patchMeetingProjects(jsonRequest(
      "http://localhost/api/work-reviews/meetings/meeting_a/projects",
      "PATCH",
      { projectIds: [project.id], expectedVersion: 0, operationKey: "meeting-projects" }
    ), meetingContext("meeting_a"));
    expect(meeting.status).toBe(200);
    expect(await responseJson(meeting)).toMatchObject({
      resourceId: "meeting_a",
      resourceVersion: 1,
      changed: true,
      reused: false
    });

    const todo = await patchTodoProjects(jsonRequest(
      "http://localhost/api/work-reviews/todos/todo_a/projects",
      "PATCH",
      { projectIds: [project.id], expectedVersion: 0, operationKey: "todo-projects" }
    ), todoContext("todo_a"));
    expect(todo.status).toBe(200);
    expect(await responseJson(todo)).toMatchObject({
      resourceId: "todo_a",
      resourceVersion: 1,
      changed: true,
      reused: false
    });

    state.accountId = "account_b";
    const hidden = await patchMeetingProjects(jsonRequest(
      "http://localhost/api/work-reviews/meetings/meeting_a/projects",
      "PATCH",
      { projectIds: [], expectedVersion: 1, operationKey: "cross-account" }
    ), meetingContext("meeting_a"));
    expect(hidden.status).toBe(404);
  });
});
