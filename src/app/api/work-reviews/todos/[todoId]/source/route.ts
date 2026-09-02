import { NextResponse } from "next/server";

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

export async function GET(
  request: Request,
  { params }: { params: Promise<{ todoId: string }> }
) {
  if (!isWorkReviewTodoEnabled()) return workReviewFeatureDisabled("todo_disabled");
  const todoId = WorkReviewIdSchema.safeParse((await params).todoId);
  if (!todoId.success) return NextResponse.json({ error: "invalid_todo_id" }, { status: 400 });
  try {
    const auth = await requireAuthContext(request);
    const source = new WorkTodoRepository(getWorkReviewDatabase())
      .getTodoSource(auth.user.id, todoId.data);
    return workReviewPrivateJson(source);
  } catch (error) {
    return workReviewRouteError(error);
  }
}
