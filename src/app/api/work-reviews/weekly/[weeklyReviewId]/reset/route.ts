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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ weeklyReviewId: string }> }
) {
  if (!isWorkReviewWeeklyEnabled()) return workReviewFeatureDisabled("weekly_disabled");
  try {
    const auth = await requireAuthContext(request);
    const id = WorkReviewIdSchema.parse((await params).weeklyReviewId);
    const body = WorkWeeklyVersionedOperationRequestSchema.parse(await request.json());
    return workReviewPrivateJson(
      new WorkWeeklyService(getWorkReviewDatabase()).reset(auth.user.id, id, body)
    );
  } catch (error) {
    return workReviewRouteError(error);
  }
}
