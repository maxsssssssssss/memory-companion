import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { resolve, sep } from "path";
import { Readable } from "stream";
import { NextResponse } from "next/server";
import type { AudioUpload } from "@/lib/domain/types";
import { getUserScopedStore, getUserUploadsRootDir } from "@/lib/server/auth/session";
import {
  getDailyReflectionRepository,
  isDailyReflectionUpload,
  isDailyReflectionUploadEnabled,
  readDailyReflectionPublishedAsset
} from "@/lib/server/daily-reflection";
import {
  getDailyReflectionAudioCapabilitySecret,
  verifyTranscriptionAudioAccessCapability
} from "@/lib/server/transcription/audio-access-capability";
import { readAudioChunkCheckpoint } from "@/lib/server/transcription/chunks/checkpoint-store";

type StoredUpload = AudioUpload & {
  filePath?: string;
};

const AUDIO_ACCESS_TOKEN_ENV = "SPEAKER_ASR_AUDIO_ACCESS_TOKEN";
const SAFE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

function isSafeKey(value: string) {
  return SAFE_KEY_PATTERN.test(value);
}

function configuredToken() {
  const value = process.env[AUDIO_ACCESS_TOKEN_ENV]?.trim();
  return value ? value : undefined;
}

function isUploadFilePath(filePath: string, uploadsRootDir: string) {
  const uploadsRoot = resolve(uploadsRootDir);
  return resolve(filePath).startsWith(`${uploadsRoot}${sep}`);
}

function unauthorized() {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export async function GET(request: Request, { params }: { params: Promise<{ userId: string; uploadId: string }> }) {
  const token = configuredToken();
  const capabilitySecret = getDailyReflectionAudioCapabilitySecret();
  const requestUrl = new URL(request.url);
  const requestToken = requestUrl.searchParams.get("token")?.trim();
  const { userId, uploadId } = await params;
  if (!isSafeKey(userId) || !isSafeKey(uploadId)) {
    return NextResponse.json({ error: "invalid_audio_request" }, { status: 400 });
  }

  const chunkId = requestUrl.searchParams.get("chunkId")?.trim();
  if (chunkId && !isSafeKey(chunkId)) {
    return NextResponse.json({ error: "invalid_audio_request" }, { status: 400 });
  }
  const transcriptionCapabilityValid = Boolean(capabilitySecret) &&
    verifyTranscriptionAudioAccessCapability({
      secret: capabilitySecret!,
      capability: requestUrl.searchParams.get("capability"),
      purpose: requestUrl.searchParams.get("purpose"),
      expiresAtSeconds: Number(requestUrl.searchParams.get("expires")),
      userId,
      uploadId,
      ...(chunkId ? { chunkId } : {})
    });
  const legacyTokenValid = Boolean(token) && requestToken === token;
  if (!transcriptionCapabilityValid && !legacyTokenValid) return unauthorized();

  const store = getUserScopedStore(userId);
  const repository = getDailyReflectionRepository();
  const reflection = repository.findReflectionByUpload(userId, uploadId);
  const upload = reflection
    ? await readDailyReflectionPublishedAsset<StoredUpload>({
        repository,
        store,
        accountId: userId,
        reflectionId: reflection.id,
        uploadId,
        assetKind: "upload"
      })
    : await store.read<StoredUpload>("uploads", uploadId);
  if (!upload?.filePath) {
    return NextResponse.json({ error: "audio_not_found" }, { status: 404 });
  }
  if (
    isDailyReflectionUpload(upload)
    && (
      !isDailyReflectionUploadEnabled()
      || !transcriptionCapabilityValid
      || upload.status !== "transcribing"
      || (() => {
        const reflection = repository.findReflection(userId, upload.reflectionId);
        const plan = reflection
          ? repository.getProcessingPlan(userId, reflection.id)
          : null;
        return reflection?.status !== "transcribing"
          || plan?.ingestionContext !== "daily_reflection"
          || plan.uploadId !== uploadId;
      })()
    )
  ) {
    return NextResponse.json({ error: "audio_not_found" }, { status: 404 });
  }
  const chunk = chunkId ? await readAudioChunkCheckpoint(store, chunkId) : null;
  if (chunkId && (!chunk || chunk.uploadId !== uploadId || !chunk.source.path)) {
    return NextResponse.json({ error: "audio_not_found" }, { status: 404 });
  }
  const filePath = chunk?.source.path ?? upload.filePath;
  const uploadsRootDir = getUserUploadsRootDir(userId);
  if (!isUploadFilePath(filePath, uploadsRootDir)) {
    return NextResponse.json({ error: "invalid_audio_path" }, { status: 403 });
  }

  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat?.isFile()) {
    return NextResponse.json({ error: "audio_not_found" }, { status: 404 });
  }

  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
  const chunkMimeType = typeof chunk?.metadata.mimeType === "string" ? chunk.metadata.mimeType : undefined;

  return new Response(stream, {
    headers: {
      "Content-Type": chunkMimeType || upload.mimeType || "application/octet-stream",
      "Content-Length": String(fileStat.size),
      "Cache-Control": "private, max-age=300"
    }
  });
}
