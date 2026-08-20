import { readFile, stat } from "node:fs/promises";
import { NextResponse } from "next/server";

import {
  isUnauthenticatedError,
  requireAuthContext,
  unauthorizedResponse
} from "@/lib/server/auth/request-context";
import { isDailyReflectionUpload } from "@/lib/server/daily-reflection/upload-record";
import {
  VoiceprintTrainingCandidateRepository,
  isVoiceprintCandidateFilePath,
  isVoiceprintSelfEnrollmentEnabled
} from "@/lib/server/speaker-identity/voiceprint-training-candidates";

export const runtime = "nodejs";

const SAFE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

type ByteRange = {
  start: number;
  end: number;
};

function parseByteRange(value: string, fileSize: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/iu.exec(value.trim());
  if (!match || (!match[1] && !match[2])) {
    return null;
  }
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return null;
    }
    return {
      start: Math.max(0, fileSize - suffixLength),
      end: fileSize - 1
    };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : fileSize - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= fileSize ||
    requestedEnd < start
  ) {
    return null;
  }
  return {
    start,
    end: Math.min(requestedEnd, fileSize - 1)
  };
}

export async function GET(
  request: Request,
  {
    params
  }: {
    params: Promise<{ candidateId: string }>;
  }
) {
  let authContext;
  try {
    authContext = await requireAuthContext(request);
  } catch (error) {
    if (isUnauthenticatedError(error)) {
      return unauthorizedResponse();
    }
    throw error;
  }
  if (!isVoiceprintSelfEnrollmentEnabled()) {
    return NextResponse.json({ error: "feature_disabled" }, { status: 404 });
  }
  const { candidateId } = await params;
  if (!SAFE_KEY_PATTERN.test(candidateId)) {
    return NextResponse.json(
      { error: "invalid_candidate_id" },
      { status: 400 }
    );
  }
  const repository = new VoiceprintTrainingCandidateRepository(
    authContext.store
  );
  await repository.cleanupExpired(authContext.uploadsRootDir);
  const candidate = await repository.get(candidateId);
  const upload = candidate
    ? await authContext.store.read<unknown>("uploads", candidate.uploadId)
    : null;
  if (
    !candidate?.audioFilePath ||
    !upload ||
    isDailyReflectionUpload(upload) ||
    candidate.status === "expired" ||
    !isVoiceprintCandidateFilePath(
      candidate.audioFilePath,
      authContext.uploadsRootDir
    )
  ) {
    return NextResponse.json({ error: "audio_not_found" }, { status: 404 });
  }
  const file = await stat(candidate.audioFilePath).catch(() => null);
  if (!file?.isFile() || file.size <= 0) {
    return NextResponse.json({ error: "audio_not_found" }, { status: 404 });
  }
  const audio = await readFile(candidate.audioFilePath)
    .then((value) => new Uint8Array(value))
    .catch(() => null);
  if (!audio || audio.byteLength === 0) {
    return NextResponse.json({ error: "audio_not_found" }, { status: 404 });
  }
  const commonHeaders = {
    "Content-Type": "audio/mpeg",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=300"
  };
  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    const range = parseByteRange(rangeHeader, audio.byteLength);
    if (!range) {
      return new Response(null, {
        status: 416,
        headers: {
          ...commonHeaders,
          "Content-Range": `bytes */${audio.byteLength}`
        }
      });
    }
    return new Response(
      audio.slice(range.start, range.end + 1),
      {
        status: 206,
        headers: {
          ...commonHeaders,
          "Content-Length": String(range.end - range.start + 1),
          "Content-Range": `bytes ${range.start}-${range.end}/${audio.byteLength}`
        }
      }
    );
  }
  return new Response(
    audio,
    {
      headers: {
        ...commonHeaders,
        "Content-Length": String(audio.byteLength)
      }
    }
  );
}
