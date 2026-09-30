import type Database from "better-sqlite3";

import type {
  CreateWorkProjectRequest,
  DeleteWorkProjectRequest,
  SetWorkResourceProjectsRequest,
  UpdateWorkProjectRequest,
  WorkProjectListStatus,
  WorkProjectScopeFilter
} from "@/lib/domain/work-project";

import {
  WorkProjectRepository,
  type WorkProjectLinkMutationResult,
  type WorkProjectMutationResult
} from "./project-repository";

type WorkProjectServiceOptions = ConstructorParameters<typeof WorkProjectRepository>[1];

/**
 * Account scope is always supplied by a server-authenticated caller. The service
 * deliberately exposes no API that accepts a client-owned account identifier.
 */
export class WorkProjectService {
  private readonly repository: WorkProjectRepository;

  constructor(database: Database.Database, options: WorkProjectServiceOptions = {}) {
    this.repository = new WorkProjectRepository(database, options);
  }

  listProjects(accountId: string, status: WorkProjectListStatus = "active") {
    return this.repository.listProjects({ accountId, status });
  }

  getProject(accountId: string, projectId: string) {
    return this.repository.getProject(accountId, projectId);
  }

  createProject(
    accountId: string,
    request: CreateWorkProjectRequest
  ): WorkProjectMutationResult {
    return this.repository.createProject({ accountId, ...request });
  }

  updateProject(
    accountId: string,
    projectId: string,
    request: UpdateWorkProjectRequest
  ): WorkProjectMutationResult {
    return this.repository.updateProject({ accountId, projectId, ...request });
  }

  deleteProject(accountId: string, projectId: string, request: DeleteWorkProjectRequest) {
    return this.repository.deleteProject({ accountId, projectId, ...request });
  }

  setMeetingProjects(
    accountId: string,
    meetingId: string,
    request: SetWorkResourceProjectsRequest
  ): WorkProjectLinkMutationResult {
    return this.repository.setMeetingProjects({ accountId, meetingId, ...request });
  }

  setTodoProjects(
    accountId: string,
    todoId: string,
    request: SetWorkResourceProjectsRequest
  ): WorkProjectLinkMutationResult {
    return this.repository.setTodoProjects({ accountId, todoId, ...request });
  }

  listMeetingProjects(accountId: string, meetingId: string) {
    return this.repository.listMeetingProjects(accountId, meetingId);
  }

  listTodoProjects(accountId: string, todoId: string) {
    return this.repository.listTodoProjects(accountId, todoId);
  }

  listMeetingIdsByScope(accountId: string, scope: WorkProjectScopeFilter) {
    return this.repository.listMeetingIdsByScope(accountId, scope);
  }

  listTodoIdsByScope(accountId: string, scope: WorkProjectScopeFilter) {
    return this.repository.listTodoIdsByScope(accountId, scope);
  }
}

export function createWorkProjectService(
  database: Database.Database,
  options: WorkProjectServiceOptions = {}
) {
  return new WorkProjectService(database, options);
}
