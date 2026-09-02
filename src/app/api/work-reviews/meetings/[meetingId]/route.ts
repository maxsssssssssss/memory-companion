import { after, NextResponse } from "next/server";
import { z } from "zod";

import { WorkReviewIdSchema } from "@/lib/domain/work-review";
import { requireAuthContext } from "@/lib/server/auth/request-context";
import { cleanupWorkReviewUploadArtifacts } from "@/lib/server/work-review/cleanup";
import { getWorkReviewDatabase } from "@/lib/server/work-review/db";
import { processWorkMeeting } from "@/lib/server/work-review/orchestrator";
import { WorkReviewRepository } from "@/lib/server/work-review/repository";
import { WorkTodoRepository } from "@/lib/server/work-review/todo-repository";
import {
  workReviewFeatureDisabled,
  workReviewPrivateJson,
  workReviewRouteError
} from "@/lib/server/work-review/route-utils";
import {
  isWorkReviewEnabled,
  resolveWorkReviewFeatureFlags
} from "@/lib/server/work-review/runtime-config";
import { toWorkMeetingDetailView } from "@/lib/server/work-review/view";

function meetingIdFrom(raw: string) {
  const parsed = WorkReviewIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const DeleteWorkMeetingRequestSchema = z.object({
  policy: z.enum(["delete_linked_todos", "detach_linked_todos"]).optional()
}).strict();

async function deleteRequestBody(request: Request) {
  const raw = await request.text();
  return DeleteWorkMeetingRequestSchema.parse(raw.trim() ? JSON.parse(raw) : {});
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ meetingId: string }> }
) {
  const flags = resolveWorkReviewFeatureFlags();
  if (!flags.enabled) return workReviewFeatureDisabled();
  const meetingId = meetingIdFrom((await params).meetingId);
  if (!meetingId) return NextResponse.json({ error: "invalid_meeting_id" }, { status: 400 });
  try {
    const auth = await requireAuthContext(request);
    const database = getWorkReviewDatabase();
    const repository = new WorkReviewRepository(database);
    const detail = repository.getMeetingDetail(auth.user.id, meetingId);
    const todoProjections = flags.todoEnabled
      ? new WorkTodoRepository(database).listMeetingTodoProjections(auth.user.id, meetingId)
      : [];
    const response = workReviewPrivateJson({
      ...toWorkMeetingDetailView(detail),
      todoProjections,
      linkedTodoCount: todoProjections.length
    });
    const processingShouldResume = flags.uploadEnabled && (
      ["queued", "transcribing"].includes(detail.meeting.ingestionStatus)
      || flags.analysisEnabled && detail.meeting.ingestionStatus === "transcript_ready"
        && ["not_started", "queued", "extracting", "verifying"].includes(
          detail.meeting.analysisStatus
        )
    );
    if (processingShouldResume) {
      after(async () => {
        try {
          await processWorkMeeting({
            accountId: auth.user.id,
            meetingId,
            store: auth.store,
            uploadsRootDir: auth.uploadsRootDir
          });
        } catch {
          console.warn("[work-review] processing recovery state=failed");
        }
      });
    }
    return response;
  } catch (error) {
    return workReviewRouteError(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ meetingId: string }> }
) {
  if (!isWorkReviewEnabled()) return workReviewFeatureDisabled();
  const meetingId = meetingIdFrom((await params).meetingId);
  if (!meetingId) return NextResponse.json({ error: "invalid_meeting_id" }, { status: 400 });
  try {
    const auth = await requireAuthContext(request);
    const body = await deleteRequestBody(request);
    const repository = new WorkReviewRepository(getWorkReviewDatabase());
    const source = repository.readSourceUpload(auth.user.id, meetingId);
    const deletion = repository.deleteMeeting({
      accountId: auth.user.id,
      meetingId,
      linkedTodoPolicy: body.policy
    });
    if (deletion.reused && deletion.cleanupStatus === "completed") {
      return workReviewPrivateJson({
        ok: true,
        cleanupStatus: "completed",
        reused: true,
        linkedTodoIds: deletion.linkedTodoIds
      });
    }
    const cleanup = await cleanupWorkReviewUploadArtifacts({
      store: auth.store,
      uploadsRootDir: auth.uploadsRootDir,
      uploadId: deletion.sourceUploadId,
      filePath: source?.filePath
    });
    const cleanupStatus = repository.markDeletionCleanup({
      accountId: auth.user.id,
      meetingId,
      status: cleanup.ok ? "completed" : "failed",
      errorCode: cleanup.ok ? null : cleanup.failures.join(",")
    });
    if (cleanupStatus !== "completed") {
      return workReviewPrivateJson({
        error: "cleanup_failed",
        cleanupStatus: "failed"
      }, 500);
    }
    return workReviewPrivateJson({
      ok: true,
      cleanupStatus: "completed",
      reused: deletion.reused,
      linkedTodoIds: deletion.linkedTodoIds
    });
  } catch (error) {
    return workReviewRouteError(error);
  }
}
