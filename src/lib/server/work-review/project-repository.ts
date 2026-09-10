import { createHash, randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { z } from "zod";

import {
  CreateWorkProjectRequestSchema,
  SetWorkResourceProjectsRequestSchema,
  UpdateWorkProjectRequestSchema,
  WorkProjectListStatusSchema,
  WorkProjectReferenceSchema,
  WorkProjectSchema,
  WorkProjectScopeFilterSchema,
  normalizeWorkProjectName,
  type CreateWorkProjectRequest,
  type SetWorkResourceProjectsRequest,
  type UpdateWorkProjectRequest,
  type WorkProject,
  type WorkProjectListStatus,
  type WorkProjectReference,
  type WorkProjectScopeFilter
} from "@/lib/domain/work-project";
import { WorkReviewIdSchema } from "@/lib/domain/work-review";
import { markWorkWeeklySourceChangedWithinTransaction } from "./weekly-invalidation";

type ProjectRepositoryOptions = {
  now?: () => string;
  idFactory?: () => string;
};

type ProjectRow = {
  id: string;
  account_id: string;
  name: string;
  name_key: string;
  description: string | null;
  status: "active" | "archived";
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type ProjectOperationRow = {
  target_kind: ProjectOperationTargetKind;
  target_id: string;
  request_fingerprint: string;
  response_json: string;
};

type ResourceVersionRow = { version: number };

type ProjectOperationTargetKind = "project" | "meeting_projects" | "todo_projects";
type ProjectOperationType = "create" | "update" | "set_meeting_projects" | "set_todo_projects";
type ProjectLinkedResourceKind = "meeting" | "todo";

export type WorkProjectMutationResult = {
  project: WorkProject;
  reused: boolean;
};

export type WorkProjectLinkMutationResult = {
  resourceId: string;
  resourceVersion: number;
  projects: WorkProjectReference[];
  changed: boolean;
  reused: boolean;
};

export type WorkProjectReferenceMap = Record<string, WorkProjectReference[]>;

const ProjectOperationResponseSchema = z.object({
  project: WorkProjectSchema
}).strict();

const ProjectLinkOperationResponseSchema = z.object({
  resourceId: WorkReviewIdSchema,
  resourceVersion: z.number().int().nonnegative(),
  projects: z.array(WorkProjectReferenceSchema).max(3),
  changed: z.boolean()
}).strict();

export class WorkProjectNotFoundError extends Error {
  readonly code: "project_not_found" | "meeting_not_found" | "todo_not_found";

  constructor(resource: "project" | "meeting" | "todo") {
    super(`${resource}_not_found`);
    this.name = "WorkProjectNotFoundError";
    this.code = `${resource}_not_found`;
  }
}

export class WorkProjectConflictError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WorkProjectConflictError";
  }
}

export class WorkProjectVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super("version_conflict");
    this.name = "WorkProjectVersionConflictError";
  }
}

function projectFromRow(row: ProjectRow): WorkProject {
  return WorkProjectSchema.parse({
    contractVersion: 1,
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    description: row.description,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at
  });
}

function projectReference(project: WorkProject): WorkProjectReference {
  return WorkProjectReferenceSchema.parse({
    id: project.id,
    name: project.name,
    status: project.status,
    version: project.version
  });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function fingerprint(value: unknown) {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function requireId(value: string, code: string) {
  const parsed = WorkReviewIdSchema.safeParse(value);
  if (!parsed.success) throw new WorkProjectConflictError(code);
  return parsed.data;
}

function isActiveNameConstraint(error: unknown) {
  if (!(error instanceof Error)) return false;
  return error.message.includes("idx_wr_projects_active_name")
    || error.message.includes("wr_projects.account_id, wr_projects.name_key");
}

function isProjectLinkLimitConstraint(error: unknown) {
  return error instanceof Error && error.message.includes("work_project_link_limit");
}

function sortedProjectIds(projectIds: string[]) {
  return [...projectIds].sort();
}

export class WorkProjectRepository {
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(private readonly database: Database.Database, options: ProjectRepositoryOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  private nextId() {
    return `wrp_${this.idFactory()}`;
  }

  private projectRow(accountId: string, projectId: string) {
    return this.database.prepare(`
      SELECT * FROM wr_projects WHERE id = ? AND account_id = ?
    `).get(projectId, accountId) as ProjectRow | undefined;
  }

  private requireProjectRow(accountId: string, projectId: string) {
    const row = this.projectRow(accountId, projectId);
    if (!row) throw new WorkProjectNotFoundError("project");
    return row;
  }

  private assertActiveNameAvailable(input: {
    accountId: string;
    nameKey: string;
    excludeProjectId?: string;
  }) {
    const existing = this.database.prepare(`
      SELECT id FROM wr_projects
      WHERE account_id = ? AND name_key = ? AND status = 'active'
        AND (? IS NULL OR id <> ?)
      LIMIT 1
    `).get(
      input.accountId,
      input.nameKey,
      input.excludeProjectId ?? null,
      input.excludeProjectId ?? null
    ) as { id: string } | undefined;
    if (existing) throw new WorkProjectConflictError("project_name_conflict");
  }

  private operationRow(accountId: string, operationKey: string) {
    return this.database.prepare(`
      SELECT target_kind, target_id, request_fingerprint, response_json
      FROM wr_project_operations
      WHERE account_id = ? AND operation_key = ?
    `).get(accountId, operationKey) as ProjectOperationRow | undefined;
  }

  private replayProjectOperation(input: {
    accountId: string;
    operationKey: string;
    requestFingerprint: string;
    targetKind: "project";
  }): WorkProjectMutationResult | null {
    const row = this.operationRow(input.accountId, input.operationKey);
    if (!row) return null;
    if (row.request_fingerprint !== input.requestFingerprint || row.target_kind !== input.targetKind) {
      throw new WorkProjectConflictError("project_operation_conflict");
    }
    this.requireProjectRow(input.accountId, row.target_id);
    const response = ProjectOperationResponseSchema.parse(JSON.parse(row.response_json));
    return { project: response.project, reused: true };
  }

  private recordOperation(input: {
    accountId: string;
    operationKey: string;
    targetKind: ProjectOperationTargetKind;
    targetId: string;
    operationType: ProjectOperationType;
    requestFingerprint: string;
    response: unknown;
    now: string;
  }) {
    this.database.prepare(`
      INSERT INTO wr_project_operations (
        account_id, operation_key, target_kind, target_id, operation_type,
        request_fingerprint, response_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.accountId,
      input.operationKey,
      input.targetKind,
      input.targetId,
      input.operationType,
      input.requestFingerprint,
      JSON.stringify(input.response),
      input.now
    );
  }

  getProject(accountId: string, projectId: string) {
    return projectFromRow(this.requireProjectRow(
      requireId(accountId, "project_invalid_account"),
      requireId(projectId, "project_invalid_id")
    ));
  }

  listProjects(input: { accountId: string; status?: WorkProjectListStatus }) {
    const accountId = requireId(input.accountId, "project_invalid_account");
    const status = WorkProjectListStatusSchema.parse(input.status ?? "active");
    const statusClause = status === "all" ? "" : "AND status = ?";
    const parameters = status === "all" ? [accountId] : [accountId, status];
    return (this.database.prepare(`
      SELECT * FROM wr_projects
      WHERE account_id = ? ${statusClause}
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,
        name_key, created_at, id
    `).all(...parameters) as ProjectRow[]).map(projectFromRow);
  }

  createProject(input: CreateWorkProjectRequest & { accountId: string }): WorkProjectMutationResult {
    const accountId = requireId(input.accountId, "project_invalid_account");
    const parsed = CreateWorkProjectRequestSchema.parse({
      operationKey: input.operationKey,
      name: input.name,
      description: input.description
    });
    const nameKey = normalizeWorkProjectName(parsed.name);
    const requestFingerprint = fingerprint({
      type: "create",
      name: parsed.name,
      nameKey,
      description: parsed.description ?? null
    });
    const run = this.database.transaction(() => {
      const replay = this.replayProjectOperation({
        accountId,
        operationKey: parsed.operationKey,
        requestFingerprint,
        targetKind: "project"
      });
      if (replay) return replay;
      this.assertActiveNameAvailable({ accountId, nameKey });
      const now = this.now();
      const projectId = this.nextId();
      try {
        this.database.prepare(`
          INSERT INTO wr_projects (
            id, account_id, name, name_key, description, status, version,
            created_at, updated_at, archived_at
          ) VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?, NULL)
        `).run(
          projectId,
          accountId,
          parsed.name,
          nameKey,
          parsed.description ?? null,
          now,
          now
        );
      } catch (error) {
        if (isActiveNameConstraint(error)) {
          throw new WorkProjectConflictError("project_name_conflict");
        }
        throw error;
      }
      const project = projectFromRow(this.requireProjectRow(accountId, projectId));
      const response = { project };
      this.recordOperation({
        accountId,
        operationKey: parsed.operationKey,
        targetKind: "project",
        targetId: projectId,
        operationType: "create",
        requestFingerprint,
        response,
        now
      });
      return { project, reused: false };
    });
    return run.immediate();
  }

  updateProject(input: UpdateWorkProjectRequest & {
    accountId: string;
    projectId: string;
  }): WorkProjectMutationResult {
    const accountId = requireId(input.accountId, "project_invalid_account");
    const projectId = requireId(input.projectId, "project_invalid_id");
    const parsed = UpdateWorkProjectRequestSchema.parse({
      operationKey: input.operationKey,
      expectedVersion: input.expectedVersion,
      name: input.name,
      description: input.description,
      status: input.status
    });
    const requestFingerprint = fingerprint({ type: "update", projectId, ...parsed });
    const run = this.database.transaction(() => {
      const replay = this.replayProjectOperation({
        accountId,
        operationKey: parsed.operationKey,
        requestFingerprint,
        targetKind: "project"
      });
      if (replay) return replay;
      const row = this.requireProjectRow(accountId, projectId);
      if (row.version !== parsed.expectedVersion) {
        throw new WorkProjectVersionConflictError(row.version);
      }
      const name = parsed.name ?? row.name;
      const nameKey = parsed.name === undefined ? row.name_key : normalizeWorkProjectName(name);
      const description = parsed.description === undefined ? row.description : parsed.description;
      const status = parsed.status ?? row.status;
      const changed = name !== row.name
        || nameKey !== row.name_key
        || description !== row.description
        || status !== row.status;
      if (status === "active") {
        this.assertActiveNameAvailable({ accountId, nameKey, excludeProjectId: projectId });
      }
      const now = this.now();
      if (changed) {
        const archivedAt = status === "archived"
          ? row.status === "archived" ? row.archived_at : now
          : null;
        try {
          const update = this.database.prepare(`
            UPDATE wr_projects
            SET name = ?, name_key = ?, description = ?, status = ?, archived_at = ?,
                version = version + 1, updated_at = ?
            WHERE id = ? AND account_id = ? AND version = ?
          `).run(
            name,
            nameKey,
            description,
            status,
            archivedAt,
            now,
            projectId,
            accountId,
            row.version
          );
          if (update.changes !== 1) {
            const current = this.projectRow(accountId, projectId);
            if (!current) throw new WorkProjectNotFoundError("project");
            throw new WorkProjectVersionConflictError(current.version);
          }
        } catch (error) {
          if (isActiveNameConstraint(error)) {
            throw new WorkProjectConflictError("project_name_conflict");
          }
          throw error;
        }
        markWorkWeeklySourceChangedWithinTransaction(this.database, {
          accountId,
          projectId,
          now
        });
      }
      const project = projectFromRow(this.requireProjectRow(accountId, projectId));
      const response = { project };
      this.recordOperation({
        accountId,
        operationKey: parsed.operationKey,
        targetKind: "project",
        targetId: projectId,
        operationType: "update",
        requestFingerprint,
        response,
        now
      });
      return { project, reused: false };
    });
    return run.immediate();
  }

  private resourceVersionRow(
    accountId: string,
    resourceId: string,
    resourceKind: ProjectLinkedResourceKind
  ) {
    if (resourceKind === "meeting") {
      return this.database.prepare(`
        SELECT m.version
        FROM wr_meetings m
        WHERE m.id = ? AND m.account_id = ?
          AND m.deleted_at IS NULL AND m.ingestion_status <> 'deleted'
          AND NOT EXISTS (
            SELECT 1 FROM wr_tombstones t
            WHERE t.account_id = m.account_id AND t.meeting_id = m.id
          )
      `).get(resourceId, accountId) as ResourceVersionRow | undefined;
    }
    return this.database.prepare(`
      SELECT version FROM wr_todos
      WHERE id = ? AND account_id = ? AND deleted_at IS NULL
    `).get(resourceId, accountId) as ResourceVersionRow | undefined;
  }

  private requireResourceVersionRow(
    accountId: string,
    resourceId: string,
    resourceKind: ProjectLinkedResourceKind
  ) {
    const row = this.resourceVersionRow(accountId, resourceId, resourceKind);
    if (!row) throw new WorkProjectNotFoundError(resourceKind);
    return row;
  }

  private referencesForIds(accountId: string, projectIds: string[]) {
    if (projectIds.length === 0) return [];
    const placeholders = projectIds.map(() => "?").join(", ");
    const rows = this.database.prepare(`
      SELECT * FROM wr_projects
      WHERE account_id = ? AND id IN (${placeholders})
      ORDER BY name_key, id
    `).all(accountId, ...projectIds) as ProjectRow[];
    if (rows.length !== projectIds.length) throw new WorkProjectNotFoundError("project");
    return rows.map((row) => projectReference(projectFromRow(row)));
  }

  private currentResourceProjectIds(input: {
    accountId: string;
    resourceId: string;
    resourceKind: ProjectLinkedResourceKind;
  }) {
    const linkTable = input.resourceKind === "meeting" ? "wr_meeting_projects" : "wr_todo_projects";
    const idColumn = input.resourceKind === "meeting" ? "meeting_id" : "todo_id";
    return (this.database.prepare(`
      SELECT project_id FROM ${linkTable}
      WHERE account_id = ? AND ${idColumn} = ?
      ORDER BY project_id
    `).all(input.accountId, input.resourceId) as Array<{ project_id: string }>)
      .map((row) => row.project_id);
  }

  private replayLinkOperation(input: {
    accountId: string;
    operationKey: string;
    requestFingerprint: string;
    targetKind: "meeting_projects" | "todo_projects";
    resourceKind: ProjectLinkedResourceKind;
  }): WorkProjectLinkMutationResult | null {
    const row = this.operationRow(input.accountId, input.operationKey);
    if (!row) return null;
    if (row.request_fingerprint !== input.requestFingerprint || row.target_kind !== input.targetKind) {
      throw new WorkProjectConflictError("project_operation_conflict");
    }
    this.requireResourceVersionRow(input.accountId, row.target_id, input.resourceKind);
    const response = ProjectLinkOperationResponseSchema.parse(JSON.parse(row.response_json));
    return { ...response, reused: true };
  }

  private setResourceProjects(input: SetWorkResourceProjectsRequest & {
    accountId: string;
    resourceId: string;
    resourceKind: ProjectLinkedResourceKind;
  }): WorkProjectLinkMutationResult {
    const accountId = requireId(input.accountId, "project_invalid_account");
    const resourceId = requireId(input.resourceId, `project_invalid_${input.resourceKind}_id`);
    const parsed = SetWorkResourceProjectsRequestSchema.parse({
      operationKey: input.operationKey,
      expectedVersion: input.expectedVersion,
      projectIds: input.projectIds
    });
    const projectIds = sortedProjectIds(parsed.projectIds);
    const targetKind = input.resourceKind === "meeting" ? "meeting_projects" as const : "todo_projects" as const;
    const operationType = input.resourceKind === "meeting"
      ? "set_meeting_projects" as const
      : "set_todo_projects" as const;
    const requestFingerprint = fingerprint({
      type: operationType,
      resourceId,
      expectedVersion: parsed.expectedVersion,
      projectIds
    });
    const run = this.database.transaction(() => {
      const replay = this.replayLinkOperation({
        accountId,
        operationKey: parsed.operationKey,
        requestFingerprint,
        targetKind,
        resourceKind: input.resourceKind
      });
      if (replay) return replay;
      const row = this.requireResourceVersionRow(accountId, resourceId, input.resourceKind);
      if (row.version !== parsed.expectedVersion) {
        throw new WorkProjectVersionConflictError(row.version);
      }
      const projects = this.referencesForIds(accountId, projectIds);
      const currentIds = this.currentResourceProjectIds({
        accountId,
        resourceId,
        resourceKind: input.resourceKind
      });
      const changed = currentIds.length !== projectIds.length
        || currentIds.some((projectId) => !projectIds.includes(projectId));
      const now = this.now();
      let resourceVersion = row.version;
      if (changed) {
        const linkTable = input.resourceKind === "meeting" ? "wr_meeting_projects" : "wr_todo_projects";
        const idColumn = input.resourceKind === "meeting" ? "meeting_id" : "todo_id";
        const removals = currentIds.filter((projectId) => !projectIds.includes(projectId));
        const additions = projectIds.filter((projectId) => !currentIds.includes(projectId));
        for (const projectId of removals) {
          this.database.prepare(`
            DELETE FROM ${linkTable}
            WHERE account_id = ? AND ${idColumn} = ? AND project_id = ?
          `).run(accountId, resourceId, projectId);
        }
        try {
          for (const projectId of additions) {
            this.database.prepare(`
              INSERT INTO ${linkTable} (account_id, ${idColumn}, project_id, created_at)
              VALUES (?, ?, ?, ?)
            `).run(accountId, resourceId, projectId, now);
          }
        } catch (error) {
          if (isProjectLinkLimitConstraint(error)) {
            throw new WorkProjectConflictError("project_link_limit");
          }
          throw error;
        }
        const update = input.resourceKind === "meeting"
          ? this.database.prepare(`
            UPDATE wr_meetings SET version = version + 1, updated_at = ?
            WHERE id = ? AND account_id = ? AND version = ?
              AND deleted_at IS NULL AND ingestion_status <> 'deleted'
              AND NOT EXISTS (
                SELECT 1 FROM wr_tombstones t
                WHERE t.account_id = wr_meetings.account_id
                  AND t.meeting_id = wr_meetings.id
              )
          `).run(now, resourceId, accountId, row.version)
          : this.database.prepare(`
            UPDATE wr_todos SET version = version + 1, updated_at = ?
            WHERE id = ? AND account_id = ? AND version = ? AND deleted_at IS NULL
          `).run(now, resourceId, accountId, row.version);
        if (update.changes !== 1) {
          const current = this.resourceVersionRow(accountId, resourceId, input.resourceKind);
          if (!current) throw new WorkProjectNotFoundError(input.resourceKind);
          throw new WorkProjectVersionConflictError(current.version);
        }
        resourceVersion += 1;
        markWorkWeeklySourceChangedWithinTransaction(this.database, {
          accountId,
          now,
          ...(input.resourceKind === "meeting"
            ? { meetingId: resourceId }
            : { todoId: resourceId })
        });
      }
      const response = { resourceId, resourceVersion, projects, changed };
      this.recordOperation({
        accountId,
        operationKey: parsed.operationKey,
        targetKind,
        targetId: resourceId,
        operationType,
        requestFingerprint,
        response,
        now
      });
      return { ...response, reused: false };
    });
    return run.immediate();
  }

  setMeetingProjects(input: SetWorkResourceProjectsRequest & {
    accountId: string;
    meetingId: string;
  }) {
    return this.setResourceProjects({
      ...input,
      resourceId: input.meetingId,
      resourceKind: "meeting"
    });
  }

  setTodoProjects(input: SetWorkResourceProjectsRequest & {
    accountId: string;
    todoId: string;
  }) {
    return this.setResourceProjects({
      ...input,
      resourceId: input.todoId,
      resourceKind: "todo"
    });
  }

  private listResourceProjectReferences(
    accountId: string,
    resourceId: string,
    resourceKind: ProjectLinkedResourceKind
  ) {
    const parsedAccountId = requireId(accountId, "project_invalid_account");
    const parsedResourceId = requireId(resourceId, `project_invalid_${resourceKind}_id`);
    this.requireResourceVersionRow(parsedAccountId, parsedResourceId, resourceKind);
    const linkTable = resourceKind === "meeting" ? "wr_meeting_projects" : "wr_todo_projects";
    const idColumn = resourceKind === "meeting" ? "meeting_id" : "todo_id";
    return (this.database.prepare(`
      SELECT p.* FROM ${linkTable} links
      JOIN wr_projects p
        ON p.account_id = links.account_id AND p.id = links.project_id
      WHERE links.account_id = ? AND links.${idColumn} = ?
      ORDER BY p.name_key, p.id
    `).all(parsedAccountId, parsedResourceId) as ProjectRow[])
      .map((row) => projectReference(projectFromRow(row)));
  }

  listMeetingProjects(accountId: string, meetingId: string) {
    return this.listResourceProjectReferences(accountId, meetingId, "meeting");
  }

  listTodoProjects(accountId: string, todoId: string) {
    return this.listResourceProjectReferences(accountId, todoId, "todo");
  }

  private listResourceIdsByScope(input: {
    accountId: string;
    scope: WorkProjectScopeFilter;
    resourceKind: ProjectLinkedResourceKind;
  }) {
    const accountId = requireId(input.accountId, "project_invalid_account");
    const scope = WorkProjectScopeFilterSchema.parse(input.scope);
    const resourceTable = input.resourceKind === "meeting" ? "wr_meetings" : "wr_todos";
    const resourceAlias = input.resourceKind === "meeting" ? "m" : "t";
    const resourceIdColumn = input.resourceKind === "meeting" ? "meeting_id" : "todo_id";
    const linkTable = input.resourceKind === "meeting" ? "wr_meeting_projects" : "wr_todo_projects";
    const liveClause = input.resourceKind === "meeting"
      ? `m.deleted_at IS NULL AND m.ingestion_status <> 'deleted'
        AND NOT EXISTS (
          SELECT 1 FROM wr_tombstones tombstone
          WHERE tombstone.account_id = m.account_id AND tombstone.meeting_id = m.id
        )`
      : "t.deleted_at IS NULL";
    if (scope.kind === "project") {
      this.requireProjectRow(accountId, scope.projectId);
      return (this.database.prepare(`
        SELECT ${resourceAlias}.id
        FROM ${resourceTable} ${resourceAlias}
        WHERE ${resourceAlias}.account_id = ? AND ${liveClause}
          AND EXISTS (
            SELECT 1 FROM ${linkTable} links
            WHERE links.account_id = ${resourceAlias}.account_id
              AND links.${resourceIdColumn} = ${resourceAlias}.id
              AND links.project_id = ?
          )
        ORDER BY ${resourceAlias}.id
      `).all(accountId, scope.projectId) as Array<{ id: string }>).map((row) => row.id);
    }
    const linkPredicate = scope.kind === "unassigned" ? "NOT EXISTS" : null;
    return (this.database.prepare(`
      SELECT ${resourceAlias}.id
      FROM ${resourceTable} ${resourceAlias}
      WHERE ${resourceAlias}.account_id = ? AND ${liveClause}
        ${linkPredicate ? `AND ${linkPredicate} (
          SELECT 1 FROM ${linkTable} links
          WHERE links.account_id = ${resourceAlias}.account_id
            AND links.${resourceIdColumn} = ${resourceAlias}.id
        )` : ""}
      ORDER BY ${resourceAlias}.id
    `).all(accountId) as Array<{ id: string }>).map((row) => row.id);
  }

  listMeetingIdsByScope(accountId: string, scope: WorkProjectScopeFilter) {
    return this.listResourceIdsByScope({ accountId, scope, resourceKind: "meeting" });
  }

  listTodoIdsByScope(accountId: string, scope: WorkProjectScopeFilter) {
    return this.listResourceIdsByScope({ accountId, scope, resourceKind: "todo" });
  }
}

export function createWorkProjectRepository(
  database: Database.Database,
  options: ProjectRepositoryOptions = {}
) {
  return new WorkProjectRepository(database, options);
}
