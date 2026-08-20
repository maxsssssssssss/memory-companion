import { NextResponse } from "next/server";

import {
  DcDeleteInteractionResponseSchema,
  DcIdSchema
} from "@/lib/domain/date-companion-stage2";
import { getDateCompanionRepository } from "@/lib/server/date-companion";
import { deleteDateCompanionAudioStaging } from "@/lib/server/date-companion/audio-staging";
import {
  dateCompanionAuth,
  dateCompanionErrorResponse
} from "@/lib/server/date-companion/http";
import {
  deleteMemoryUploadAndRefreshIndex,
  MemoryUploadDeletionError
} from "@/lib/server/memory/upload-deletion";
import { deleteMemoryOwnerReviewCandidatesForUpload } from "@/lib/server/memory/owner-review";
import { deleteVoiceprintTrainingCandidatesForUpload } from "@/lib/server/speaker-identity/voiceprint-training-candidates";
import { JsonSpeakerIdentityRepository } from "@/lib/server/speaker-identity/repository";

export const runtime = "nodejs";

function expectedVersionFromIfMatch(request: Request) {
  const value = request.headers.get("if-match");
  if (value === null) {
    return {
      response: NextResponse.json(
        { error: "interaction_version_required" },
        { status: 428 }
      )
    } as const;
  }
  const match = /^(?:"(\d+)"|(\d+))$/u.exec(value.trim());
  const version = match ? Number(match[1] ?? match[2]) : Number.NaN;
  if (!Number.isSafeInteger(version) || version < 0) {
    return {
      response: NextResponse.json(
        { error: "invalid_interaction_version" },
        { status: 400 }
      )
    } as const;
  }
  return { version } as const;
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ interactionId: string }> }
) {
  const auth = await dateCompanionAuth(request);
  if ("response" in auth) return auth.response;
  const interactionId = DcIdSchema.safeParse((await params).interactionId);
  if (!interactionId.success) {
    return NextResponse.json({ error: "invalid_interaction_id" }, { status: 400 });
  }
  const expectedVersion = expectedVersionFromIfMatch(request);
  if ("response" in expectedVersion) return expectedVersion.response;
  try {
    const repository = getDateCompanionRepository();
    const deletion = repository.prepareInteractionDeletion(
      auth.authContext.user.id,
      interactionId.data,
      expectedVersion.version
    );
    if (deletion.sourceState === "server_cleaned") {
      try {
        await deleteMemoryUploadAndRefreshIndex({
          userId: auth.authContext.user.id,
          uploadId: deletion.sourceUploadId,
          indexRefreshFailure: "throw"
        });
      } catch (error) {
        const errorCode = error instanceof MemoryUploadDeletionError
          && error.code === "memory_index_refresh_failed"
          ? "interaction_memory_index_refresh_failed"
          : "interaction_memory_cleanup_failed";
        console.error(
          `[date-companion-delete] memory_cleanup_failed `
          + `error_code=${errorCode}`
        );
        return NextResponse.json(
          { error: errorCode, deleted: false, retryable: true },
          { status: 500 }
        );
      }
    }
    try {
      await deleteMemoryOwnerReviewCandidatesForUpload({
        store: auth.authContext.store,
        uploadId: deletion.sourceUploadId,
        uploadsRootDir: auth.authContext.uploadsRootDir
      });
    } catch (error) {
      console.error(
        `[date-companion-delete] owner_cleanup_failed `
        + `error_name=${error instanceof Error ? error.name : "unknown"}`
      );
      return NextResponse.json(
        { error: "interaction_owner_cleanup_failed", deleted: false, retryable: true },
        { status: 500 }
      );
    }
    try {
      await deleteVoiceprintTrainingCandidatesForUpload({
        store: auth.authContext.store,
        uploadId: deletion.sourceUploadId,
        uploadsRootDir: auth.authContext.uploadsRootDir
      });
      await deleteDateCompanionAudioStaging(
        auth.authContext.store,
        deletion.sourceUploadId
      );
      await new JsonSpeakerIdentityRepository(
        auth.authContext.store
      ).deleteUploadMappings(deletion.sourceUploadId);
    } catch (error) {
      console.error(
        `[date-companion-delete] voice_cleanup_failed upload_id=${deletion.sourceUploadId} `
        + `error_name=${error instanceof Error ? error.name : "unknown"}`
      );
      return NextResponse.json(
        { error: "interaction_voice_cleanup_failed", deleted: false, retryable: true },
        { status: 500 }
      );
    }
    try {
      repository.deleteInteraction(
        auth.authContext.user.id,
        interactionId.data,
        expectedVersion.version
      );
    } catch (error) {
      const response = dateCompanionErrorResponse(error);
      if (response) return response;
      console.error(
        `[date-companion-delete] interaction_delete_failed `
        + `error_name=${error instanceof Error ? error.name : "unknown"}`
      );
      return NextResponse.json(
        { error: "interaction_delete_failed", deleted: false, retryable: true },
        { status: 500 }
      );
    }
    return NextResponse.json(DcDeleteInteractionResponseSchema.parse({ deleted: true }));
  } catch (error) {
    const response = dateCompanionErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
