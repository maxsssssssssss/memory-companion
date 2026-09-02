import { after, NextResponse } from "next/server";
import { z } from "zod";

import { WorkReviewIdSchema } from "@/lib/domain/work-review";
import { requireAuthContext } from "@/lib/server/auth/request-context";
import { getWorkReviewDatabase } from "@/lib/server/work-review/db";
import { processWorkMeeting } from "@/lib/server/work-review/orchestrator";
import { WorkReviewRepository } from "@/lib/server/work-review/repository";
import {
  workReviewFeatureDisabled,
  workReviewPrivateJson,
  workReviewRouteError
} from "@/lib/server/work-review/route-utils";
import { resolveWorkReviewFeatureFlags } from "@/lib/server/work-review/runtime-config";

const RetrySchema = z.object({ operationKey: WorkReviewIdSchema }).strict();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ meetingId: string }> }
) {
  const flags = resolveWorkReviewFeatureFlags();
  if (!flags.enabled) return workReviewFeatureDisabled();
  const meetingId = WorkReviewIdSchema.safeParse((await params).meetingId);
  if (!meetingId.success) {
    return NextResponse.json({ error: "invalid_meeting_id" }, { status: 400 });
  }
  try {
    const auth = await requireAuthContext(request);
    const body = RetrySchema.parse(await request.json());
    const repository = new WorkReviewRepository(getWorkReviewDatabase());
    const retry = repository.retryProcessing({
      accountId: auth.user.id,
      meetingId: meetingId.data,
      operationKey: body.operationKey,
      allowTranscription: flags.uploadEnabled,
      allowAnalysis: flags.analysisEnabled
    });
    after(async () => {
      await processWorkMeeting({
        accountId: auth.user.id,
        meetingId: meetingId.data,
        store: auth.store,
        uploadsRootDir: auth.uploadsRootDir
      });
    });
    return workReviewPrivateJson({
      ok: true,
      reused: retry.reused,
      ingestionStatus: retry.meeting.ingestionStatus,
      analysisStatus: retry.meeting.analysisStatus
    }, 202);
  } catch (error) {
    return workReviewRouteError(error);
  }
}
