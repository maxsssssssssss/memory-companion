import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import { extname, join } from "path";
import { after, NextResponse } from "next/server";
import { mimeTypeToAudioExtension, normalizeAudioForTranscription } from "@/lib/audio/compat";
import type { AudioUpload } from "@/lib/domain/types";
import { isUnauthenticatedError, requireAuthContext, unauthorizedResponse } from "@/lib/server/auth/request-context";
import { createJob } from "@/lib/server/jobs/job-store";
import { isUploadProcessingCancelled, processUpload } from "@/lib/server/pipeline/process-upload";
import { validateAudioUpload } from "@/lib/server/uploads/validation";

type StoredUpload = AudioUpload & {
  filePath: string;
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
  const uploadDir = authContext.uploadsRootDir;
  const originalBytes = new Uint8Array(await file.arrayBuffer());
  const normalizedAudio = normalizeAudioForTranscription({
    name: file.name,
    type: file.type,
    bytes: originalBytes
  });
  const filePath = join(uploadDir, `${uploadId}${extensionForUpload(normalizedAudio.name, normalizedAudio.mimeType)}`);
  const upload: StoredUpload = {
    id: uploadId,
    originalName: file.name,
    mimeType: normalizedAudio.mimeType,
    sizeBytes: file.size,
    recordingDate: normalizeRecordingDate(formData.get("recordingDate")),
    createdAt: new Date().toISOString(),
    status: "uploaded",
    filePath
  };

  await fs.mkdir(uploadDir, { recursive: true });
  await fs.writeFile(filePath, normalizedAudio.bytes);
  await authContext.store.write("uploads", uploadId, upload);
  const job = await createJob(authContext.store, uploadId);

  console.info(`[pipeline] background scheduled upload_id=${uploadId}`);
  after(() => {
    const startedAt = Date.now();
    console.info(`[pipeline] background started upload_id=${uploadId}`);
    void processUpload({ uploadId, store: authContext.store, userId: authContext.user.id })
      .then(() => {
        console.info(`[pipeline] background completed upload_id=${uploadId} elapsed_ms=${Date.now() - startedAt}`);
      })
      .catch((error) => {
        if (isUploadProcessingCancelled(error)) {
          return;
        }
        console.info(
          `[pipeline] background failed upload_id=${uploadId} elapsed_ms=${Date.now() - startedAt} error_name=${error instanceof Error ? error.name : "unknown"}`
        );
        console.error("process upload failed", error);
      });
  });

  return NextResponse.json({ uploadId, jobId: job.id, status: "uploaded" }, { status: 201 });
}
