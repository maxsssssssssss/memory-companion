import { NextResponse } from "next/server";

import { CreateWorkTodoFromFindingRequestSchema } from "@/lib/domain/work-todo";
import { WorkReviewIdSchema } from "@/lib/domain/work-review";
import { requireAuthContext } from "@/lib/server/auth/request-context";
import { getWorkReviewDatabase } from "@/lib/server/work-review/db";
import {
  workReviewFeatureDisabled,
  workReviewPrivateJson,
  workReviewRouteError
} from "@/lib/server/work-review/route-utils";
import {
  isWorkReviewTodoMeetingProjectionEnabled
} from "@/lib/server/work-review/runtime-config";
import { WorkTodoRepository } from "@/lib/server/work-review/todo-repository";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ meetingId: string; findingId: string }> }
) {
  if (!isWorkReviewTodoMeetingProjectionEnabled()) {
    return workReviewFeatureDisabled("todo_meeting_projection_disabled");
  }
  const resolved = await params;
  const meetingId = WorkReviewIdSchema.safeParse(resolved.meetingId);
  const findingId = WorkReviewIdSchema.safeParse(resolved.findingId);
  if (!meetingId.success || !findingId.success) {
    return NextResponse.json({ error: "invalid_finding_path" }, { status: 400 });
  }
  try {
    const auth = await requireAuthContext(request);
    const body = CreateWorkTodoFromFindingRequestSchema.parse(await request.json());
    const result = new WorkTodoRepository(getWorkReviewDatabase()).createTodoFromFinding({
      accountId: auth.user.id,
      meetingId: meetingId.data,
      findingId: findingId.data,
      ...body
    });
    return workReviewPrivateJson(result, result.reused ? 200 : 201);
  } catch (error) {
    return workReviewRouteError(error);
  }
}
