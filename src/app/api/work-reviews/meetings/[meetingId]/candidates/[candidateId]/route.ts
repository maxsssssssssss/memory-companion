import { NextResponse } from "next/server";

import {
  ReviewWorkCandidateRequestSchema,
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
  { params }: { params: Promise<{ meetingId: string; candidateId: string }> }
) {
  if (!isWorkReviewEnabled()) return workReviewFeatureDisabled();
  const resolved = await params;
  const meetingId = WorkReviewIdSchema.safeParse(resolved.meetingId);
  const candidateId = WorkReviewIdSchema.safeParse(resolved.candidateId);
  if (!meetingId.success || !candidateId.success) {
    return NextResponse.json({ error: "invalid_candidate_path" }, { status: 400 });
  }
  try {
    const auth = await requireAuthContext(request);
    const body = ReviewWorkCandidateRequestSchema.parse(await request.json());
    const repository = new WorkReviewRepository(getWorkReviewDatabase());
    const result = repository.reviewCandidate({
      accountId: auth.user.id,
      meetingId: meetingId.data,
      candidateId: candidateId.data,
      ...body
    });
    return workReviewPrivateJson({
      ok: true,
      reused: result.reused,
      candidateVersion: result.candidate.version,
      findingId: result.finding?.id ?? null
    });
  } catch (error) {
    return workReviewRouteError(error);
  }
}
