import { NextResponse } from "next/server";

import {
  UpdateWorkMeetingSpeakerAliasRequestSchema,
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

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ meetingId: string; rawLabel: string }> }
) {
  if (!isWorkReviewEnabled()) return workReviewFeatureDisabled();
  const resolved = await params;
  const meetingId = WorkReviewIdSchema.safeParse(resolved.meetingId);
  const rawLabel = resolved.rawLabel.trim();
  if (!meetingId.success || !rawLabel || rawLabel.length > 512) {
    return NextResponse.json({ error: "invalid_speaker_path" }, { status: 400 });
  }
  try {
    const auth = await requireAuthContext(request);
    const body = UpdateWorkMeetingSpeakerAliasRequestSchema.parse(await request.json());
    const result = new WorkReviewRepository(getWorkReviewDatabase()).setSpeakerAlias({
      accountId: auth.user.id,
      meetingId: meetingId.data,
      rawLabel,
      displayLabel: body.displayName,
      expectedVersion: body.expectedVersion,
      operationKey: body.operationKey
    });
    return workReviewPrivateJson({ ok: true, reused: result.reused, alias: result.alias });
  } catch (error) {
    return workReviewRouteError(error);
  }
}
