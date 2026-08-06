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
    try {
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
    repository.deleteInteraction(
      auth.authContext.user.id,
      interactionId.data,
      expectedVersion.version
    );
    return NextResponse.json(DcDeleteInteractionResponseSchema.parse({ deleted: true }));
  } catch (error) {
    const response = dateCompanionErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
