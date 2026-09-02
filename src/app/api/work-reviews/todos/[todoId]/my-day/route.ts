import { NextResponse } from "next/server";

import {
  SetWorkTodoMyDayRequestSchema,
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

async function parsedTodoId(params: Promise<{ todoId: string }>) {
  return WorkReviewIdSchema.safeParse((await params).todoId);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ todoId: string }> }
) {
  if (!isWorkReviewTodoEnabled()) return workReviewFeatureDisabled("todo_disabled");
  const todoId = await parsedTodoId(params);
  if (!todoId.success) return NextResponse.json({ error: "invalid_todo_id" }, { status: 400 });
  try {
    const auth = await requireAuthContext(request);
    const body = SetWorkTodoMyDayRequestSchema.parse(await request.json());
    const result = new WorkTodoRepository(getWorkReviewDatabase()).setMyDay({
      accountId: auth.user.id,
      todoId: todoId.data,
      ...body
    });
    return workReviewPrivateJson(result);
  } catch (error) {
    return workReviewRouteError(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ todoId: string }> }
) {
  if (!isWorkReviewTodoEnabled()) return workReviewFeatureDisabled("todo_disabled");
  const todoId = await parsedTodoId(params);
  if (!todoId.success) return NextResponse.json({ error: "invalid_todo_id" }, { status: 400 });
  try {
    const auth = await requireAuthContext(request);
    const body = WorkTodoVersionedOperationRequestSchema.parse(await request.json());
    const result = new WorkTodoRepository(getWorkReviewDatabase()).removeFromMyDay({
      accountId: auth.user.id,
      todoId: todoId.data,
      ...body
    });
    return workReviewPrivateJson(result);
  } catch (error) {
    return workReviewRouteError(error);
  }
}
