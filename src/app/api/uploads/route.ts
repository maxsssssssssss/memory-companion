import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import { extname, join } from "path";
import { after, NextResponse } from "next/server";
import { mimeTypeToAudioExtension, normalizeAudioForTranscription } from "@/lib/audio/compat";
import type { AudioUpload } from "@/lib/domain/types";
import { isUnauthenticatedError, requireAuthContext, unauthorizedResponse } from "@/lib/server/auth/request-context";
import { shouldMarkUploadForEvaluationRetention } from "@/lib/server/evaluation/retention";
import { createJob, updateJob } from "@/lib/server/jobs/job-store";
import { isUploadProcessingCancelled, processUpload } from "@/lib/server/pipeline/process-upload";
import { resolvePipelineExecutionMode } from "@/lib/server/queue/config";
import { enqueuePipelineJob } from "@/lib/server/queue/producer";
import { buildPipelineJobId } from "@/lib/server/queue/types";
import { validateAudioUpload } from "@/lib/server/uploads/validation";

type StoredUpload = AudioUpload & {
  filePath: string;
  evaluationRetention?: boolean;
};

const mimeTypeToExtension: Record<string, string> = {
  "audio/m4a": ".m4a",
  "audio/mp3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/mpga": ".mpga",
  "audio/ogg": ".ogg",
  "audio/opus": ".opus",
  "audio/wav": ".wav",
  "audio/webm": ".webm",
  "audio/x-pcm": ".pcm",
  "video/mp4": ".mp4"
};

function normalizeRecordingDate(value: FormDataEntryValue | null) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  return new Date().toISOString().slice(0, 10);
}

function extensionForUpload(fileName: string, mimeType: string) {
  return extname(fileName) || mimeTypeToAudioExtension(mimeType) || mimeTypeToExtension[mimeType] || ".bin";
}

export async function POST(request: Request) {
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) {
      return unauthorizedResponse();
    }
    throw error;
  }

  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing_file" }, { status: 400 });
  }

  const validation = validateAudioUpload(file);
  if (!validation.ok) {
    return NextResponse.json(
      {
        error: validation.errorCode,
        message: validation.message
      },
      { status: 400 }
    );
  }

  const uploadId = randomUUID();
  const executionMode = resolvePipelineExecutionMode();
  const uploadDir = authContext.uploadsRootDir;
  const originalBytes = new Uint8Array(await file.arrayBuffer());
  const normalizedAudio = normalizeAudioForTranscription({
    name: file.name,
    type: file.type,
    bytes: originalBytes
  });
  const filePath = join(uploadDir, `${uploadId}${extensionForUpload(normalizedAudio.name, normalizedAudio.mimeType)}`);
  const evaluationRetention = shouldMarkUploadForEvaluationRetention(request);
  const upload: StoredUpload = {
    id: uploadId,
    originalName: file.name,
    mimeType: normalizedAudio.mimeType,
    sizeBytes: file.size,
    recordingDate: normalizeRecordingDate(formData.get("recordingDate")),
    createdAt: new Date().toISOString(),
    status: "uploaded",
    filePath,
    ...(evaluationRetention ? { evaluationRetention: true } : {})
  };

  await fs.mkdir(uploadDir, { recursive: true });
  await fs.writeFile(filePath, normalizedAudio.bytes);
  await authContext.store.write("uploads", uploadId, upload);

  if (executionMode === "queue") {
    const queuedAt = new Date().toISOString();
    const queuePayload = {
      version: 1 as const,
      uploadId,
      userRef: authContext.user.id
    };
    const queueJobId = buildPipelineJobId(queuePayload);
    let job = await createJob(authContext.store, uploadId, {
      executionMode: "queue",
      queueJobId,
      queuedAt,
      now: () => queuedAt
    });

    try {
      const queued = await enqueuePipelineJob(queuePayload);
      if (queued.jobId !== queueJobId) {
        throw new Error("Queue returned an unexpected stable job id");
      }
    } catch (error) {
      const failedAt = new Date().toISOString();
      const errorMessage = "Pipeline queue is unavailable";
      job = await updateJob(authContext.store, job, {
        status: "failed",
        errorCode: "queue_unavailable",
        errorMessage,
        finishedAt: failedAt
      });
      await authContext.store.write("uploads", uploadId, {
        ...upload,
        status: "failed",
        errorCode: "queue_unavailable",
        errorMessage
      });
      console.error(
        `[pipeline-queue] enqueue failed upload_id=${uploadId} error_name=${error instanceof Error ? error.name : "unknown"}`
      );
      return NextResponse.json(
        {
          error: "pipeline_queue_unavailable",
          uploadId,
          jobId: job.id,
          status: "failed"
        },
        { status: 503 }
      );
    }

    console.info(`[pipeline-queue] enqueued upload_id=${uploadId} queue_job_id=${queueJobId}`);
    return NextResponse.json(
      {
        uploadId,
        jobId: job.id,
        status: "waiting",
        executionMode: "queue",
        queueJobId,
        ...(evaluationRetention ? { evaluationRetention: true } : {})
      },
      { status: 201 }
    );
  }

  const job = await createJob(authContext.store, uploadId, { executionMode: "inline" });

  console.info(`[pipeline] background scheduled upload_id=${uploadId}`);
  after(async () => {
    const startedAt = Date.now();
    console.info(`[pipeline] background started upload_id=${uploadId}`);
    try {
      await processUpload({ uploadId, store: authContext.store, userId: authContext.user.id });
      console.info(`[pipeline] background completed upload_id=${uploadId} elapsed_ms=${Date.now() - startedAt}`);
    } catch (error) {
      if (isUploadProcessingCancelled(error)) {
        return;
      }
      console.info(
        `[pipeline] background failed upload_id=${uploadId} elapsed_ms=${Date.now() - startedAt} error_name=${error instanceof Error ? error.name : "unknown"}`
      );
      console.error("process upload failed", error);
    }
  });

  return NextResponse.json(
    { uploadId, jobId: job.id, status: "uploaded", ...(evaluationRetention ? { evaluationRetention: true } : {}) },
    { status: 201 }
  );
}
