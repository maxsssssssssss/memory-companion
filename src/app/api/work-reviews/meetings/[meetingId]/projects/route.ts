import { NextResponse } from "next/server";

import { SetWorkResourceProjectsRequestSchema } from "@/lib/domain/work-project";
import { WorkReviewIdSchema } from "@/lib/domain/work-review";
import { requireAuthContext } from "@/lib/server/auth/request-context";
import { getWorkReviewDatabase } from "@/lib/server/work-review/db";
import { WorkProjectService } from "@/lib/server/work-review/project-service";
import { isWorkReviewProjectsEnabled } from "@/lib/server/work-review/runtime-config";
import {
  workProjectFeatureDisabled,
  workProjectPrivateJson,
  workProjectRouteError
} from "@/app/api/work-reviews/projects/route-utils";

type MeetingProjectsRouteContext = { params: Promise<{ meetingId: string }> };

export async function PATCH(request: Request, { params }: MeetingProjectsRouteContext) {
  if (!isWorkReviewProjectsEnabled()) return workProjectFeatureDisabled();
  const meetingId = WorkReviewIdSchema.safeParse((await params).meetingId);
  if (!meetingId.success) {
    return NextResponse.json(
      { error: "invalid_meeting_id" },
      { status: 400, headers: { "Cache-Control": "private, no-store" } }
    );
  }
  try {
    const auth = await requireAuthContext(request);
    const body = SetWorkResourceProjectsRequestSchema.parse(await request.json());
    const result = new WorkProjectService(getWorkReviewDatabase())
      .setMeetingProjects(auth.user.id, meetingId.data, body);
    return workProjectPrivateJson(result);
  } catch (error) {
    return workProjectRouteError(error);
  }
}
