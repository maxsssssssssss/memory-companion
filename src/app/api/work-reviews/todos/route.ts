import { z } from "zod";

import {
  CreateManualWorkTodoRequestSchema,
  WorkTodoDateSchema,
  WorkTodoViewSchema
} from "@/lib/domain/work-todo";
import { WorkProjectScopeFilterSchema } from "@/lib/domain/work-project";
import { requireAuthContext } from "@/lib/server/auth/request-context";
import { getWorkReviewDatabase } from "@/lib/server/work-review/db";
import {
  workReviewFeatureDisabled,
  workReviewPrivateJson,
  workReviewRouteError
} from "@/lib/server/work-review/route-utils";
import {
  isWorkReviewProjectsEnabled,
  isWorkReviewTodoEnabled
} from "@/lib/server/work-review/runtime-config";
import { WorkTodoRepository } from "@/lib/server/work-review/todo-repository";
import { WorkProjectService } from "@/lib/server/work-review/project-service";

const WorkTodoListQuerySchema = z.object({
  view: WorkTodoViewSchema.default("all"),
  day: WorkTodoDateSchema.optional(),
  projectScope: z.enum(["all", "project", "unassigned"]).default("all"),
  projectId: z.string().trim().min(1).optional()
}).strict().superRefine((value, context) => {
  if (value.view === "today" && !value.day) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["day"],
      message: "Today view requires the caller local calendar day"
    });
  }
  if ((value.projectScope === "project") !== Boolean(value.projectId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["projectId"],
      message: "projectId is required only for project scope"
    });
  }
});

function queryObject(request: Request) {
  const search = new URL(request.url).searchParams;
  const result: Record<string, string> = {};
  for (const key of new Set(search.keys())) {
    const values = search.getAll(key);
    if (values.length !== 1) throw new SyntaxError("duplicate_query_parameter");
    result[key] = values[0]!;
  }
  return result;
}

export async function GET(request: Request) {
  if (!isWorkReviewTodoEnabled()) return workReviewFeatureDisabled("todo_disabled");
  try {
    const auth = await requireAuthContext(request);
    const query = WorkTodoListQuerySchema.parse(queryObject(request));
    const projectScope = WorkProjectScopeFilterSchema.parse(query.projectScope === "project"
      ? { kind: query.projectScope, projectId: query.projectId }
      : { kind: query.projectScope });
    if (projectScope.kind !== "all" && !isWorkReviewProjectsEnabled()) {
      return workReviewFeatureDisabled("projects_disabled");
    }
    const todos = new WorkTodoRepository(getWorkReviewDatabase()).listTodos({
      accountId: auth.user.id,
      view: query.view,
      day: query.day,
      projectScope
    });
    const projectService = isWorkReviewProjectsEnabled()
      ? new WorkProjectService(getWorkReviewDatabase())
      : null;
    return workReviewPrivateJson({
      todos: todos.map((todo) => ({
        ...todo,
        projects: projectService?.listTodoProjects(auth.user.id, todo.id) ?? []
      }))
    });
  } catch (error) {
    return workReviewRouteError(error);
  }
}

export async function POST(request: Request) {
  if (!isWorkReviewTodoEnabled()) return workReviewFeatureDisabled("todo_disabled");
  try {
    const auth = await requireAuthContext(request);
    const body = CreateManualWorkTodoRequestSchema.parse(await request.json());
    if ((body.projectIds?.length ?? 0) > 0 && !isWorkReviewProjectsEnabled()) {
      return workReviewFeatureDisabled("projects_disabled");
    }
    const result = new WorkTodoRepository(getWorkReviewDatabase()).createManualTodo({
      accountId: auth.user.id,
      ...body
    });
    return workReviewPrivateJson(result, result.reused ? 200 : 201);
  } catch (error) {
    return workReviewRouteError(error);
  }
}
