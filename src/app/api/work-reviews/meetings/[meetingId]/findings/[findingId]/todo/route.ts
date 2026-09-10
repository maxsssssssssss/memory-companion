
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
  isWorkReviewProjectsEnabled,
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
    return workReviewPrivateJson({ error: "invalid_finding_path" }, 400);
  }
  try {
    const auth = await requireAuthContext(request);
    const body = CreateWorkTodoFromFindingRequestSchema.parse(await request.json());
    if ((body.projectIds?.length ?? 0) > 0 && !isWorkReviewProjectsEnabled()) {
      return workReviewFeatureDisabled("projects_disabled");
    }
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
