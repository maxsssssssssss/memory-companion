import { WorkReviewIdSchema } from "@/lib/domain/work-review";
import { RegenerateWorkWeeklyReviewRequestSchema } from "@/lib/domain/work-weekly";
import { requireAuthContext } from "@/lib/server/auth/request-context";
import { getWorkReviewDatabase } from "@/lib/server/work-review/db";
import {
  workReviewFeatureDisabled,
  workReviewPrivateJson,
  workReviewRouteError
} from "@/lib/server/work-review/route-utils";
import { isWorkReviewWeeklyAiEnabled } from "@/lib/server/work-review/runtime-config";
import { WorkWeeklyService } from "@/lib/server/work-review/weekly-service";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ weeklyReviewId: string }> }
) {
  if (!isWorkReviewWeeklyAiEnabled()) return workReviewFeatureDisabled("weekly_ai_disabled");
  try {
    const auth = await requireAuthContext(request);
    const id = WorkReviewIdSchema.parse((await params).weeklyReviewId);
    const body = RegenerateWorkWeeklyReviewRequestSchema.parse(await request.json());
    const result = new WorkWeeklyService(getWorkReviewDatabase())
      .regenerate(auth.user.id, id, body);
    return workReviewPrivateJson(result, result.reused ? 200 : 202);
  } catch (error) {
    return workReviewRouteError(error);
  }
}
