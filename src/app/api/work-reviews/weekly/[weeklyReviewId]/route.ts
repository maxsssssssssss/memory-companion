import { WorkReviewIdSchema } from "@/lib/domain/work-review";
import { WorkWeeklyVersionedOperationRequestSchema } from "@/lib/domain/work-weekly";
import { requireAuthContext } from "@/lib/server/auth/request-context";
import { getWorkReviewDatabase } from "@/lib/server/work-review/db";
import {
  workReviewFeatureDisabled,
  workReviewPrivateJson,
  workReviewRouteError
} from "@/lib/server/work-review/route-utils";
import { isWorkReviewWeeklyEnabled } from "@/lib/server/work-review/runtime-config";
import { WorkWeeklyService } from "@/lib/server/work-review/weekly-service";

function reviewId(value: string) {
  const parsed = WorkReviewIdSchema.safeParse(value);
  if (!parsed.success) throw new SyntaxError("invalid_weekly_review_id");
  return parsed.data;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ weeklyReviewId: string }> }
) {
  if (!isWorkReviewWeeklyEnabled()) return workReviewFeatureDisabled("weekly_disabled");
  try {
    const auth = await requireAuthContext(request);
    const id = reviewId((await params).weeklyReviewId);
    return workReviewPrivateJson(
      new WorkWeeklyService(getWorkReviewDatabase()).getDetail(auth.user.id, id)
    );
  } catch (error) {
    return workReviewRouteError(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ weeklyReviewId: string }> }
) {
  if (!isWorkReviewWeeklyEnabled()) return workReviewFeatureDisabled("weekly_disabled");
  try {
    const auth = await requireAuthContext(request);
    const id = reviewId((await params).weeklyReviewId);
    const body = WorkWeeklyVersionedOperationRequestSchema.parse(await request.json());
    return workReviewPrivateJson(
      new WorkWeeklyService(getWorkReviewDatabase()).deleteReview(auth.user.id, id, body)
    );
  } catch (error) {
    return workReviewRouteError(error);
  }
}
