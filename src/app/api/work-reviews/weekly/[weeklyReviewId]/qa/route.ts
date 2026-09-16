import { WorkReviewIdSchema } from "@/lib/domain/work-review";
import {
  AskWorkWeeklyQaRequestSchema,
  WorkWeeklyVersionedOperationRequestSchema
} from "@/lib/domain/work-weekly";
import { requireAuthContext } from "@/lib/server/auth/request-context";
import { enqueueWorkWeeklyQaJob } from "@/lib/server/queue/work-weekly-qa-producer";
import { getWorkReviewDatabase } from "@/lib/server/work-review/db";
import {
  workReviewFeatureDisabled,
  workReviewPrivateJson,
  workReviewRouteError
} from "@/lib/server/work-review/route-utils";
import { isWorkReviewWeeklyQaEnabled } from "@/lib/server/work-review/runtime-config";
import { WorkWeeklyService } from "@/lib/server/work-review/weekly-service";
import { workWeeklyQaRunKey } from "@/lib/server/work-review/weekly-qa-diagnostics";

async function reviewId(params: Promise<{ weeklyReviewId: string }>) {
  return WorkReviewIdSchema.parse((await params).weeklyReviewId);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ weeklyReviewId: string }> }
) {
  if (!isWorkReviewWeeklyQaEnabled()) return workReviewFeatureDisabled("weekly_qa_disabled");
  try {
    const auth = await requireAuthContext(request);
    return workReviewPrivateJson(new WorkWeeklyService(getWorkReviewDatabase())
      .getQa(auth.user.id, await reviewId(params)));
  } catch (error) {
    return workReviewRouteError(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ weeklyReviewId: string }> }
) {
  if (!isWorkReviewWeeklyQaEnabled()) return workReviewFeatureDisabled("weekly_qa_disabled");
  try {
    const auth = await requireAuthContext(request);
    const body = AskWorkWeeklyQaRequestSchema.parse(await request.json());
    const result = new WorkWeeklyService(getWorkReviewDatabase())
      .askQa(auth.user.id, await reviewId(params), body);
    if (result.run.state === "queued") {
      const startedAt = performance.now();
      let outcome = "succeeded";
      try {
        const run = result.run;
        await enqueueWorkWeeklyQaJob({ version: 1, kind: "qa", accountId: run.accountId,
          weeklyReviewId: run.weeklyReviewId, runId: run.id, runVersion: run.runVersion,
          sourceSnapshotDigest: run.sourceSnapshotDigest, threadId: run.threadId,
          questionMessageId: run.questionMessageId });
      } catch {
        // The question is committed. Preserve it for recovery, never return a
        // model failure or encourage a second POST for an ambiguous enqueue.
        outcome = "deferred_to_recovery";
      }
      console.info(JSON.stringify({ component: "work-weekly-qa", stage: "dispatch", outcome,
        runKey: workWeeklyQaRunKey(result.run.accountId, result.run.id), runVersion: result.run.runVersion,
        elapsedMs: Math.round(performance.now() - startedAt) }));
    }
    return workReviewPrivateJson(result, result.reused ? 200 : 202);
  } catch (error) {
    return workReviewRouteError(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ weeklyReviewId: string }> }
) {
  if (!isWorkReviewWeeklyQaEnabled()) return workReviewFeatureDisabled("weekly_qa_disabled");
  try {
    const auth = await requireAuthContext(request);
    const body = WorkWeeklyVersionedOperationRequestSchema.parse(await request.json());
    return workReviewPrivateJson(new WorkWeeklyService(getWorkReviewDatabase())
      .clearQa(auth.user.id, await reviewId(params), body));
  } catch (error) {
    return workReviewRouteError(error);
  }
}
