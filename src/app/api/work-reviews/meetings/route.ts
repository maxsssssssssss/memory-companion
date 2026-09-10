import { createHash, randomUUID } from "node:crypto";
import { after } from "next/server";

import { isSupportedAudioUpload } from "@/lib/audio/compat";
import {
  CreateWorkMeetingFieldsSchema,
  WorkReviewIdSchema
} from "@/lib/domain/work-review";
import {
  WorkProjectIdsSchema,
  WorkProjectScopeFilterSchema
} from "@/lib/domain/work-project";
import {
  requireAuthContext
} from "@/lib/server/auth/request-context";
import { getWorkReviewDatabase } from "@/lib/server/work-review/db";
import { processWorkMeeting } from "@/lib/server/work-review/orchestrator";
import { WorkReviewRepository } from "@/lib/server/work-review/repository";
import { WorkProjectService } from "@/lib/server/work-review/project-service";
import {
  workReviewFeatureDisabled,
  workReviewPrivateJson,
  workReviewRouteError
} from "@/lib/server/work-review/route-utils";
import {
  isWorkReviewEnabled,
  isWorkReviewProjectsEnabled,
  isWorkReviewUploadEnabled,
  resolveWorkReviewCapacityLimits
} from "@/lib/server/work-review/runtime-config";
import { toWorkMeetingListItem } from "@/lib/server/work-review/view";
import { cleanupWorkReviewUploadArtifacts } from "@/lib/server/work-review/cleanup";
import {
  cleanupPersistedAudioUploadAttempt,
  persistAudioUpload
} from "@/lib/server/uploads/storage";

const MULTIPART_OVERHEAD_ALLOWANCE_BYTES = 1024 * 1024;

function meetingProjectScope(request: Request) {
  const search = new URL(request.url).searchParams;
  for (const key of search.keys()) {
    if (key !== "projectScope" && key !== "projectId") {
      throw new SyntaxError("unknown_query_parameter");
    }
  }
  const scopeKind = search.get("projectScope") ?? "all";
  const projectId = search.get("projectId");
  if (search.getAll("projectScope").length > 1 || search.getAll("projectId").length > 1) {
    throw new SyntaxError("duplicate_query_parameter");
  }
  if ((scopeKind === "project") !== (projectId !== null)) {
    throw new SyntaxError("invalid_project_scope");
  }
  return WorkProjectScopeFilterSchema.parse(scopeKind === "project"
    ? { kind: scopeKind, projectId }
    : { kind: scopeKind });
}

function formProjectIds(formData: FormData) {
  const raw = formData.get("projectIds");
  if (raw === null || raw === "") return [];
  if (typeof raw !== "string") throw new SyntaxError("invalid_project_ids");
  try {
    return WorkProjectIdsSchema.parse(JSON.parse(raw));
  } catch {
    throw new SyntaxError("invalid_project_ids");
  }
}

function formString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function requestBodyExceedsUploadLimit(request: Request, maxUploadBytes: number) {
  const contentLength = Number(request.headers.get("content-length"));
  return Number.isFinite(contentLength)
    && contentLength > maxUploadBytes + MULTIPART_OVERHEAD_ALLOWANCE_BYTES;
}

async function sha256File(file: File) {
  const hash = createHash("sha256");
  const reader = file.stream().getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      hash.update(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return hash.digest("hex");
}

async function recoverWorkReviewCleanup(input: {
  accountId: string;
  repository: WorkReviewRepository;
  store: Parameters<typeof cleanupWorkReviewUploadArtifacts>[0]["store"];
  uploadsRootDir: string;
}) {
  const liveTasks = input.repository.listPendingSourceUploadCleanups(input.accountId);
  const deletionTasks = input.repository.listPendingDeletionCleanups(input.accountId);
  const tasks = [
    ...liveTasks.map((task) => ({ ...task, kind: "canonical_source" as const })),
    ...deletionTasks.map((task) => ({ ...task, kind: "deleted_source" as const }))
  ];
  for (const [index, task] of tasks.entries()) {
    try {
      const cleanup = await cleanupWorkReviewUploadArtifacts({
        store: input.store,
        uploadsRootDir: input.uploadsRootDir,
        uploadId: task.uploadId,
        filePath: task.filePath
      });
      if (task.kind === "deleted_source") {
        input.repository.markDeletionCleanup({
          accountId: input.accountId,
          meetingId: task.meetingId,
          status: cleanup.ok ? "completed" : "failed",
          errorCode: cleanup.ok ? null : cleanup.failures.join(",")
        });
      } else if (cleanup.ok && task.filePath) {
        input.repository.clearSourceUploadPath({
          accountId: input.accountId,
          meetingId: task.meetingId,
          expectedFilePath: task.filePath
        });
      }
      console.info(
        `[work-review] cleanup progress=${index + 1}/${tasks.length} state=${cleanup.ok ? "completed" : "failed"}`
      );
    } catch {
      console.warn(
        `[work-review] cleanup progress=${index + 1}/${tasks.length} state=failed`
      );
    }
  }
}

export async function GET(request: Request) {
  if (!isWorkReviewEnabled()) return workReviewFeatureDisabled();
  try {
    const auth = await requireAuthContext(request);
    const repository = new WorkReviewRepository(getWorkReviewDatabase());
    const projectScope = meetingProjectScope(request);
    if (projectScope.kind !== "all" && !isWorkReviewProjectsEnabled()) {
      return workReviewFeatureDisabled("projects_disabled");
    }
    const response = workReviewPrivateJson({
      meetings: repository.listMeetings(auth.user.id, projectScope).map((meeting) =>
        toWorkMeetingListItem({
          repository,
          accountId: auth.user.id,
          meeting,
          projects: isWorkReviewProjectsEnabled()
            ? new WorkProjectService(getWorkReviewDatabase())
              .listMeetingProjects(auth.user.id, meeting.id)
            : []
        })
      )
    });
    after(async () => {
      await recoverWorkReviewCleanup({
        accountId: auth.user.id,
        repository,
        store: auth.store,
        uploadsRootDir: auth.uploadsRootDir
      });
    });
    return response;
  } catch (error) {
    return workReviewRouteError(error);
  }
}

export async function POST(request: Request) {
  if (!isWorkReviewEnabled()) return workReviewFeatureDisabled();
  if (!isWorkReviewUploadEnabled()) return workReviewFeatureDisabled("upload_disabled");
  try {
    const auth = await requireAuthContext(request);
    const rawKey = request.headers.get("Idempotency-Key")?.trim();
    const idempotencyKey = WorkReviewIdSchema.safeParse(rawKey);
    if (!idempotencyKey.success) {
      return workReviewPrivateJson({ error: "idempotency_key_required" }, 400);
    }
    const { maxUploadBytes } = resolveWorkReviewCapacityLimits();
    if (requestBodyExceedsUploadLimit(request, maxUploadBytes)) {
      return workReviewPrivateJson({ error: "file_too_large" }, 413);
    }
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return workReviewPrivateJson({ error: "invalid_multipart" }, 400);
    }
    const files = formData.getAll("file");
    const file = files[0];
    if (files.length !== 1 || !(file instanceof File)) {
      return workReviewPrivateJson({ error: "invalid_upload" }, 400);
    }
    if (file.size <= 0) {
      return workReviewPrivateJson({ error: "empty_file" }, 400);
    }
    if (file.size > maxUploadBytes) {
      return workReviewPrivateJson({ error: "file_too_large" }, 413);
    }
    if (!isSupportedAudioUpload(file)) {
      return workReviewPrivateJson({ error: "unsupported_audio_format" }, 400);
    }
    const fields = CreateWorkMeetingFieldsSchema.safeParse({
      title: formString(formData, "title"),
      meetingDate: formString(formData, "meetingDate")
    });
    if (!fields.success) {
      return workReviewPrivateJson({ error: "invalid_meeting_fields" }, 400);
    }
    const projectIds = formProjectIds(formData);
    if (projectIds.length > 0 && !isWorkReviewProjectsEnabled()) {
      return workReviewFeatureDisabled("projects_disabled");
    }
    const contentHash = await sha256File(file);
    const repository = new WorkReviewRepository(getWorkReviewDatabase());
    const reserved = repository.reserveMeeting({
      accountId: auth.user.id,
      idempotencyKey: idempotencyKey.data,
      operationKey: idempotencyKey.data,
      contentHash,
      meetingId: `wrm_${randomUUID()}`,
      sourceUploadId: `work-meeting-${randomUUID()}`,
      title: fields.data.title,
      meetingDate: fields.data.meetingDate,
      projectIds
    });
    let sourceUpload = repository.readSourceUpload(auth.user.id, reserved.meeting.id);
    if (!sourceUpload) {
      const persisted = await persistAudioUpload({
        store: auth.store,
        uploadId: reserved.meeting.sourceUploadId,
        attemptSuffix: `request-${randomUUID()}`,
        uploadDir: auth.uploadsRootDir,
        file,
        recordingDate: fields.data.meetingDate,
        publishUpload: (upload) => {
          repository.publishSourceUpload({
            accountId: auth.user.id,
            meetingId: reserved.meeting.id,
            uploadId: upload.id,
            originalName: upload.originalName,
            mimeType: upload.mimeType,
            sizeBytes: upload.sizeBytes,
            recordingDate: upload.recordingDate,
            filePath: upload.filePath,
            contentHash
          });
        }
      });
      sourceUpload = repository.readSourceUpload(auth.user.id, reserved.meeting.id);
      if (!sourceUpload) {
        throw new Error("work_review_source_upload_publication_failed");
      }
      if (sourceUpload.filePath !== persisted.filePath) {
        await cleanupPersistedAudioUploadAttempt({
          store: auth.store,
          upload: persisted,
          removeProjection: false
        });
      }
    }
    const current = repository.getMeeting(auth.user.id, reserved.meeting.id);
    if (current.ingestionStatus === "created" || current.ingestionStatus === "failed") {
      repository.queueStage({
        accountId: auth.user.id,
        meetingId: current.id,
        stage: "transcription"
      });
    }
    after(async () => {
      await processWorkMeeting({
        accountId: auth.user.id,
        meetingId: reserved.meeting.id,
        store: auth.store,
        uploadsRootDir: auth.uploadsRootDir
      });
    });
    const accepted = repository.getMeeting(auth.user.id, reserved.meeting.id);
    return workReviewPrivateJson({
      meetingId: accepted.id,
      receiptId: reserved.receipt.receiptId,
      ingestionStatus: accepted.ingestionStatus,
      analysisStatus: accepted.analysisStatus,
      reused: reserved.reused
    }, 202);
  } catch (error) {
    return workReviewRouteError(error);
  }
}
