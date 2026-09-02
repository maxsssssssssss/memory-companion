import { requireAuthContext } from "@/lib/server/auth/request-context";
import {
  workReviewFeatureDisabled,
  workReviewPrivateJson,
  workReviewRouteError
} from "@/lib/server/work-review/route-utils";
import {
  isWorkReviewEnabled,
  resolveWorkReviewCapacityLimits
} from "@/lib/server/work-review/runtime-config";

export async function GET(request: Request) {
  if (!isWorkReviewEnabled()) return workReviewFeatureDisabled();
  try {
    await requireAuthContext(request);
    return workReviewPrivateJson({ limits: resolveWorkReviewCapacityLimits() });
  } catch (error) {
    return workReviewRouteError(error);
  }
}
