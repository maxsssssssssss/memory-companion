
import {
  UpdateWorkTodoRequestSchema,
  WorkTodoVersionedOperationRequestSchema
} from "@/lib/domain/work-todo";
import { WorkReviewIdSchema } from "@/lib/domain/work-review";
import { requireAuthContext } from "@/lib/server/auth/request-context";
import { getWorkReviewDatabase } from "@/lib/server/work-review/db";
import {
  workReviewFeatureDisabled,
  workReviewPrivateJson,
  workReviewRouteError
} from "@/lib/server/work-review/route-utils";
import { isWorkReviewTodoEnabled } from "@/lib/server/work-review/runtime-config";
import { WorkTodoRepository } from "@/lib/server/work-review/todo-repository";
import { WorkProjectService } from "@/lib/server/work-review/project-service";
import { isWorkReviewProjectsEnabled } from "@/lib/server/work-review/runtime-config";

function todoIdFrom(raw: string) {
  const parsed = WorkReviewIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

type TodoRouteContext = { params: Promise<{ todoId: string }> };

export async function GET(request: Request, { params }: TodoRouteContext) {
  if (!isWorkReviewTodoEnabled()) return workReviewFeatureDisabled("todo_disabled");
  const todoId = todoIdFrom((await params).todoId);
  if (!todoId) return workReviewPrivateJson({ error: "invalid_todo_id" }, 400);
  try {
    const auth = await requireAuthContext(request);
    const detail = new WorkTodoRepository(getWorkReviewDatabase())
      .getTodoDetail(auth.user.id, todoId);
    return workReviewPrivateJson({
      ...detail,
      todo: {
        ...detail.todo,
        projects: isWorkReviewProjectsEnabled()
          ? new WorkProjectService(getWorkReviewDatabase()).listTodoProjects(auth.user.id, todoId)
          : []
      }
    });
  } catch (error) {
    return workReviewRouteError(error);
  }
}

export async function PATCH(request: Request, { params }: TodoRouteContext) {
  if (!isWorkReviewTodoEnabled()) return workReviewFeatureDisabled("todo_disabled");
  const todoId = todoIdFrom((await params).todoId);
  if (!todoId) return workReviewPrivateJson({ error: "invalid_todo_id" }, 400);
  try {
    const auth = await requireAuthContext(request);
    const body = UpdateWorkTodoRequestSchema.parse(await request.json());
    const result = new WorkTodoRepository(getWorkReviewDatabase()).updateTodo({
      accountId: auth.user.id,
      todoId,
      ...body
    });
    return workReviewPrivateJson(result);
  } catch (error) {
    return workReviewRouteError(error);
  }
}

export async function DELETE(request: Request, { params }: TodoRouteContext) {
  if (!isWorkReviewTodoEnabled()) return workReviewFeatureDisabled("todo_disabled");
  const todoId = todoIdFrom((await params).todoId);
  if (!todoId) return workReviewPrivateJson({ error: "invalid_todo_id" }, 400);
  try {
    const auth = await requireAuthContext(request);
    const body = WorkTodoVersionedOperationRequestSchema.parse(await request.json());
    const result = new WorkTodoRepository(getWorkReviewDatabase()).deleteTodo({
      accountId: auth.user.id,
      todoId,
      ...body
    });
    return workReviewPrivateJson(result);
  } catch (error) {
    return workReviewRouteError(error);
  }
}
