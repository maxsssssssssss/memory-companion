import { WorkReviewIdSchema } from "@/lib/domain/work-review";
import { WorkWeeklySourceRefSchema } from "@/lib/domain/work-weekly";
import { requireAuthContext } from "@/lib/server/auth/request-context";
import { getWorkReviewDatabase } from "@/lib/server/work-review/db";
import {
  workReviewFeatureDisabled,
  workReviewPrivateJson,
  workReviewRouteError
} from "@/lib/server/work-review/route-utils";
import { isWorkReviewWeeklyEnabled } from "@/lib/server/work-review/runtime-config";
import { WorkWeeklyService } from "@/lib/server/work-review/weekly-service";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ weeklyReviewId: string; sourceRef: string }> }
) {
  if (!isWorkReviewWeeklyEnabled()) return workReviewFeatureDisabled("weekly_disabled");
  try {
    const auth = await requireAuthContext(request);
    const resolved = await params;
    const reviewId = WorkReviewIdSchema.parse(resolved.weeklyReviewId);
    const sourceRef = WorkWeeklySourceRefSchema.parse(resolved.sourceRef);
    const source = new WorkWeeklyService(getWorkReviewDatabase())
      .resolveLiveSource(auth.user.id, reviewId, sourceRef);
    return source
      ? workReviewPrivateJson(source)
      : workReviewPrivateJson({ error: "weekly_source_not_found" }, 404);
  } catch (error) {
    return workReviewRouteError(error);
  }
}
