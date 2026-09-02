import { NextResponse } from "next/server";

import { ResetWorkMeetingFollowUpRequestSchema } from "@/lib/domain/work-follow-up";
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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ meetingId: string }> }
) {
  if (!isWorkReviewFollowUpEnabled()) {
    return workReviewFeatureDisabled("follow_up_disabled");
  }
  const meetingId = WorkReviewIdSchema.safeParse((await params).meetingId);
  if (!meetingId.success) {
    return NextResponse.json({ error: "invalid_meeting_id" }, { status: 400 });
  }
  try {
    const auth = await requireAuthContext(request);
    const body = ResetWorkMeetingFollowUpRequestSchema.parse(await request.json());
    const result = new WorkMeetingFollowUpService(getWorkReviewDatabase()).reset({
      accountId: auth.user.id,
      meetingId: meetingId.data,
      expectedVersion: body.expectedVersion,
      operationKey: body.operationKey
    });
    return workReviewPrivateJson(result);
  } catch (error) {
    return workReviewRouteError(error);
  }
}
