import { WorkReviewIdSchema } from "@/lib/domain/work-review";
import {
  UpdateWorkWeeklyItemRequestSchema,
  WorkWeeklyVersionedOperationRequestSchema
} from "@/lib/domain/work-weekly";
import { requireAuthContext } from "@/lib/server/auth/request-context";
import { getWorkReviewDatabase } from "@/lib/server/work-review/db";
import {
  workReviewFeatureDisabled,
  workReviewPrivateJson,
  workReviewRouteError
} from "@/lib/server/work-review/route-utils";
import { isWorkReviewWeeklyEnabled } from "@/lib/server/work-review/runtime-config";
import { WorkWeeklyService } from "@/lib/server/work-review/weekly-service";

async function ids(params: Promise<{ weeklyReviewId: string; itemId: string }>) {
  const resolved = await params;
  return {
    reviewId: WorkReviewIdSchema.parse(resolved.weeklyReviewId),
    itemId: WorkReviewIdSchema.parse(resolved.itemId)
  };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ weeklyReviewId: string; itemId: string }> }
) {
  if (!isWorkReviewWeeklyEnabled()) return workReviewFeatureDisabled("weekly_disabled");
  try {
    const auth = await requireAuthContext(request);
    const path = await ids(params);
    const body = UpdateWorkWeeklyItemRequestSchema.parse(await request.json());
    return workReviewPrivateJson(new WorkWeeklyService(getWorkReviewDatabase()).updateItem(
      auth.user.id, path.reviewId, path.itemId, body
    ));
  } catch (error) {
    return workReviewRouteError(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ weeklyReviewId: string; itemId: string }> }
) {
  if (!isWorkReviewWeeklyEnabled()) return workReviewFeatureDisabled("weekly_disabled");
  try {
    const auth = await requireAuthContext(request);
    const path = await ids(params);
    const body = WorkWeeklyVersionedOperationRequestSchema.parse(await request.json());
    return workReviewPrivateJson(new WorkWeeklyService(getWorkReviewDatabase()).deleteUserNote(
      auth.user.id, path.reviewId, path.itemId, body
    ));
  } catch (error) {
    return workReviewRouteError(error);
  }
}
