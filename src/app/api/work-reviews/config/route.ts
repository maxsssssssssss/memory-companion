import { requireAuthContext } from "@/lib/server/auth/request-context";
import {
  workReviewFeatureDisabled,
  workReviewPrivateJson,
  workReviewRouteError
} from "@/lib/server/work-review/route-utils";
import {
  isWorkReviewEnabled,
  resolveWorkReviewFeatureFlags,
  resolveWorkReviewCapacityLimits
} from "@/lib/server/work-review/runtime-config";

export async function GET(request: Request) {
  if (!isWorkReviewEnabled()) return workReviewFeatureDisabled();
  try {
    await requireAuthContext(request);
    const flags = resolveWorkReviewFeatureFlags();
    return workReviewPrivateJson({
      limits: resolveWorkReviewCapacityLimits(),
      capabilities: {
        projects: flags.projectsEnabled,
        weekly: flags.weeklyEnabled,
        weeklyAi: flags.weeklyAiEnabled,
        weeklyVerifier: flags.weeklyVerifierEnabled,
        weeklyQa: flags.weeklyQaEnabled,
        weeklyQaVerifier: flags.weeklyQaVerifierEnabled
      }
    });
  } catch (error) {
    return workReviewRouteError(error);
  }
}
