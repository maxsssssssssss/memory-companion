import { requireAuthContext } from "@/lib/server/auth/request-context";
import { getWorkReviewDatabase } from "@/lib/server/work-review/db";
import {
  workReviewFeatureDisabled,
  workReviewPrivateJson,
  workReviewRouteError
} from "@/lib/server/work-review/route-utils";
import { isWorkReviewWeeklyEnabled } from "@/lib/server/work-review/runtime-config";
import { WorkWeeklyService } from "@/lib/server/work-review/weekly-service";

import { parseWeeklyScopeQuery } from "./route-helpers";

export async function GET(request: Request) {
  if (!isWorkReviewWeeklyEnabled()) return workReviewFeatureDisabled("weekly_disabled");
  try {
    const auth = await requireAuthContext(request);
    const scope = parseWeeklyScopeQuery(request);
    const result = new WorkWeeklyService(getWorkReviewDatabase()).getByScope(auth.user.id, scope);
    return workReviewPrivateJson(result);
  } catch (error) {
    return workReviewRouteError(error);
  }
}
