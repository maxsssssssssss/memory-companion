import { NextResponse } from "next/server";

import { sanitizeAudioInsightCorrections, type StoredAudioInsightCorrections } from "@/lib/domain/audio-insight-corrections";
import type { AudioUpload } from "@/lib/domain/types";
import { isUnauthenticatedError, requireAuthContext, unauthorizedResponse, type AuthContext } from "@/lib/server/auth/request-context";
import { resolvePipelineExecutionMode } from "@/lib/server/queue/config";
import { enqueueEmbeddingIndexJob } from "@/lib/server/queue/producer";
import {
  resolveHybridIndexRetentionPolicy,
  resolveQaHybridRetrievalMode
} from "@/lib/server/retrieval/hybrid/runtime-config";
import { uploadCanonicalProjectionBlockReason } from "@/lib/server/upload-deletion-barrier";

const STORE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

async function requireUploadScopedStore(request: Request, uploadId: string): Promise<{ authContext: AuthContext } | { response: Response }> {
  if (!STORE_KEY_PATTERN.test(uploadId)) {
    return { response: NextResponse.json({ error: "invalid_upload_id" }, { status: 400 }) };
  }

  try {
    const authContext = await requireAuthContext(request);
    const upload = await authContext.store.read<AudioUpload>("uploads", uploadId);

    if (!upload) {
      return { response: NextResponse.json({ error: "upload_not_found" }, { status: 404 }) };
    }

    return { authContext };
  } catch (error) {
    if (isUnauthenticatedError(error)) {
      return { response: unauthorizedResponse() };
    }
    throw error;
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ uploadId: string }> }) {
  const { uploadId } = await params;
  const result = await requireUploadScopedStore(request, uploadId);

  if ("response" in result) {
    return result.response;
  }

  const storedCorrections = await result.authContext.store.read<StoredAudioInsightCorrections>("audio-insight-corrections", uploadId);

  return NextResponse.json({ corrections: sanitizeAudioInsightCorrections(storedCorrections?.corrections ?? {}) });
}

export async function PUT(request: Request, { params }: { params: Promise<{ uploadId: string }> }) {
  const { uploadId } = await params;
  const result = await requireUploadScopedStore(request, uploadId);

  if ("response" in result) {
    return result.response;
  }

  let body: { corrections?: unknown };
  try {
    body = (await request.json()) as { corrections?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const corrections = sanitizeAudioInsightCorrections(body.corrections ?? {});
  const updatedAt = new Date().toISOString();
  const [previousCorrections, blockBeforeWrite] = await Promise.all([
    result.authContext.store.read<StoredAudioInsightCorrections>(
      "audio-insight-corrections",
      uploadId
    ),
    uploadCanonicalProjectionBlockReason(result.authContext.store, uploadId)
  ]);
  if (blockBeforeWrite) {
    return NextResponse.json(
      {
        error: blockBeforeWrite === "retention"
          ? "upload_cleanup_in_progress"
          : "upload_deletion_in_progress"
      },
      { status: 409 }
    );
  }

  await result.authContext.store.write("audio-insight-corrections", uploadId, {
    corrections,
    updatedAt
  });

  const [currentUpload, blockAfterWrite] = await Promise.all([
    result.authContext.store.read<AudioUpload>("uploads", uploadId),
    uploadCanonicalProjectionBlockReason(result.authContext.store, uploadId)
  ]);
  if (!currentUpload || blockAfterWrite) {
    if (currentUpload && blockAfterWrite === "retention" && previousCorrections) {
      await result.authContext.store.write(
        "audio-insight-corrections",
        uploadId,
        previousCorrections
      );
    } else {
      await result.authContext.store.delete("audio-insight-corrections", uploadId);
    }
    return NextResponse.json(
      {
        error: blockAfterWrite === "retention"
          ? "upload_cleanup_in_progress"
          : "upload_deletion_in_progress"
      },
      { status: 409 }
    );
  }

  try {
    if (
      resolvePipelineExecutionMode() === "queue" &&
      (
        resolveQaHybridRetrievalMode() !== "off" ||
        resolveHybridIndexRetentionPolicy() !== "off"
      )
    ) {
      await enqueueEmbeddingIndexJob({
        version: 1,
        userRef: result.authContext.user.id,
        reason: "audio_insight_corrections"
      });
    }
  } catch (error) {
    console.warn(
      `[hybrid-index-worker] enqueue_failed reason=audio_insight_corrections ` +
      `error_name=${error instanceof Error ? error.name : "unknown"}`
    );
  }

  return NextResponse.json({ corrections, updatedAt });
}
