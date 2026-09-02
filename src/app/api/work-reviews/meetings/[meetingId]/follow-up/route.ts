import { NextResponse } from "next/server";

import { UpdateWorkMeetingFollowUpRequestSchema } from "@/lib/domain/work-follow-up";
import { WorkReviewIdSchema } from "@/lib/domain/work-review";
import { requireAuthContext } from "@/lib/server/auth/request-context";
import { getWorkReviewDatabase } from "@/lib/server/work-review/db";
import { WorkMeetingFollowUpService } from "@/lib/server/work-review/follow-up-service";
import {
  workReviewFeatureDisabled,
  workReviewPrivateJson,
  workReviewRouteError
} from "@/lib/server/work-review/route-utils";
import { isWorkReviewFollowUpEnabled } from "@/lib/server/work-review/runtime-config";

type FollowUpRouteContext = { params: Promise<{ meetingId: string }> };

async function meetingIdFrom(context: FollowUpRouteContext) {
  const parsed = WorkReviewIdSchema.safeParse((await context.params).meetingId);
  return parsed.success ? parsed.data : null;
}

export async function GET(request: Request, context: FollowUpRouteContext) {
  if (!isWorkReviewFollowUpEnabled()) {
    return workReviewFeatureDisabled("follow_up_disabled");
  }
  const meetingId = await meetingIdFrom(context);
  if (!meetingId) return NextResponse.json({ error: "invalid_meeting_id" }, { status: 400 });
  try {
    const auth = await requireAuthContext(request);
    const result = new WorkMeetingFollowUpService(getWorkReviewDatabase())
      .get(auth.user.id, meetingId);
    return workReviewPrivateJson(result);
  } catch (error) {
    return workReviewRouteError(error);
  }
}

export async function PATCH(request: Request, context: FollowUpRouteContext) {
  if (!isWorkReviewFollowUpEnabled()) {
    return workReviewFeatureDisabled("follow_up_disabled");
  }
  const meetingId = await meetingIdFrom(context);
  if (!meetingId) return NextResponse.json({ error: "invalid_meeting_id" }, { status: 400 });
  try {
    const auth = await requireAuthContext(request);
    const body = UpdateWorkMeetingFollowUpRequestSchema.parse(await request.json());
    const result = new WorkMeetingFollowUpService(getWorkReviewDatabase()).update({
      accountId: auth.user.id,
      meetingId,
      ...body
    });
    return workReviewPrivateJson(result);
  } catch (error) {
    return workReviewRouteError(error);
  }
}
