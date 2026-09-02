import { z } from "zod";

import {
  CreateManualWorkTodoRequestSchema,
  WorkTodoDateSchema,
  WorkTodoViewSchema
} from "@/lib/domain/work-todo";
import { requireAuthContext } from "@/lib/server/auth/request-context";
import { getWorkReviewDatabase } from "@/lib/server/work-review/db";
import {
  workReviewFeatureDisabled,
  workReviewPrivateJson,
  workReviewRouteError
} from "@/lib/server/work-review/route-utils";
import { isWorkReviewTodoEnabled } from "@/lib/server/work-review/runtime-config";
import { WorkTodoRepository } from "@/lib/server/work-review/todo-repository";

const WorkTodoListQuerySchema = z.object({
  view: WorkTodoViewSchema.default("all"),
  day: WorkTodoDateSchema.optional()
}).strict().superRefine((value, context) => {
  if (value.view === "today" && !value.day) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["day"],
      message: "Today view requires the caller local calendar day"
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
    const todos = new WorkTodoRepository(getWorkReviewDatabase()).listTodos({
      accountId: auth.user.id,
      view: query.view,
      day: query.day
    });
    return workReviewPrivateJson({ todos });
  } catch (error) {
    return workReviewRouteError(error);
  }
}

export async function POST(request: Request) {
  if (!isWorkReviewTodoEnabled()) return workReviewFeatureDisabled("todo_disabled");
  try {
    const auth = await requireAuthContext(request);
    const body = CreateManualWorkTodoRequestSchema.parse(await request.json());
    const result = new WorkTodoRepository(getWorkReviewDatabase()).createManualTodo({
      accountId: auth.user.id,
      ...body
    });
    return workReviewPrivateJson(result, result.reused ? 200 : 201);
  } catch (error) {
    return workReviewRouteError(error);
  }
}
