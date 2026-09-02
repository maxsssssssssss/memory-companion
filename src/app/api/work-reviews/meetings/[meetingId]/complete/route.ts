import { NextResponse } from "next/server";

import {
  CompleteWorkMeetingReviewRequestSchema,
  WorkReviewIdSchema
} from "@/lib/domain/work-review";
import { requireAuthContext } from "@/lib/server/auth/request-context";
import { getWorkReviewDatabase } from "@/lib/server/work-review/db";
import { WorkReviewRepository } from "@/lib/server/work-review/repository";
import {
  workReviewFeatureDisabled,
  workReviewPrivateJson,
  workReviewRouteError
} from "@/lib/server/work-review/route-utils";
import { isWorkReviewEnabled } from "@/lib/server/work-review/runtime-config";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ meetingId: string }> }
) {
  if (!isWorkReviewEnabled()) return workReviewFeatureDisabled();
  const meetingId = WorkReviewIdSchema.safeParse((await params).meetingId);
  if (!meetingId.success) {
    return NextResponse.json({ error: "invalid_meeting_id" }, { status: 400 });
  }
  try {
    const auth = await requireAuthContext(request);
    const body = CompleteWorkMeetingReviewRequestSchema.parse(await request.json());
    const result = new WorkReviewRepository(getWorkReviewDatabase()).completeReview({
      accountId: auth.user.id,
      meetingId: meetingId.data,
      expectedVersion: body.expectedVersion,
      operationKey: body.operationKey
    });
    return workReviewPrivateJson({
      ok: true,
      reused: result.reused,
      meetingVersion: result.meeting.version
    });
  } catch (error) {
    return workReviewRouteError(error);
  }
}
