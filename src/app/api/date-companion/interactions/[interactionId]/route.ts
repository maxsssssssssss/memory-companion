import { NextResponse } from "next/server";

import {
  DcDeleteInteractionResponseSchema,
  DcIdSchema
} from "@/lib/domain/date-companion-stage2";
import {
  DcNotFoundError,
  getDateCompanionRepository
} from "@/lib/server/date-companion";
import { deleteDateCompanionAudioStaging } from "@/lib/server/date-companion/audio-staging";
import {
  dateCompanionAuth,
  dateCompanionErrorResponse
} from "@/lib/server/date-companion/http";
import { JsonSpeakerIdentityRepository } from "@/lib/server/speaker-identity/repository";
import { resolvePipelineExecutionMode } from "@/lib/server/queue/config";
import { enqueueEmbeddingIndexJob } from "@/lib/server/queue/producer";
import {
  deleteHybridIndexDeletion,
  readHybridIndexDeletion
} from "@/lib/server/retrieval/hybrid/retention-manifest";
import {
  requestHybridPermanentIndexDeletion,
  requiresHybridPermanentIndexDeletion
} from "@/lib/server/retrieval/hybrid/retention-runtime";

export const runtime = "nodejs";
const DELETED_INTERACTION_TOMBSTONES =
  "deleted-date-companion-interactions";

type PendingInteractionDeletionTombstone = {
  status: "pending";
  interactionId: string;
  sourceUploadId: string;
  expectedVersion: number;
  hybridDeletionRequired: boolean;
  requestedAt: string;
};

type CompletedInteractionDeletionTombstone = {
  status: "completed";
  interactionId: string;
  sourceUploadId?: string;
  expectedVersion?: number;
  hybridDeletionRequired?: boolean;
  requestedAt?: string;
  deletedAt: string;
};

type InteractionDeletionTombstone =
  | PendingInteractionDeletionTombstone
  | CompletedInteractionDeletionTombstone;

function parseInteractionDeletionTombstone(
  value: unknown,
  interactionId: string
): InteractionDeletionTombstone | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.interactionId !== interactionId) {
    throw new Error("Interaction deletion tombstone id mismatch");
  }
  // Compatibility with the first local tombstone format, which represented
  // only an already-completed deletion.
  if (record.status === undefined) {
    return {
      status: "completed",
      interactionId,
      deletedAt:
        typeof record.deletedAt === "string"
          ? record.deletedAt
          : new Date(0).toISOString()
    };
  }
  if (record.status === "completed" && typeof record.deletedAt === "string") {
    return record as CompletedInteractionDeletionTombstone;
  }
  if (
    record.status === "pending" &&
    typeof record.sourceUploadId === "string" &&
    DcIdSchema.safeParse(record.sourceUploadId).success &&
    Number.isSafeInteger(record.expectedVersion) &&
    Number(record.expectedVersion) >= 0 &&
    typeof record.hybridDeletionRequired === "boolean" &&
    typeof record.requestedAt === "string"
  ) {
    return record as PendingInteractionDeletionTombstone;
  }
  throw new Error("Interaction deletion tombstone is invalid");
}

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
  const existingTombstone = parseInteractionDeletionTombstone(
    await auth.authContext.store.read<unknown>(
      DELETED_INTERACTION_TOMBSTONES,
      interactionId.data
    ),
    interactionId.data
  );
  if (existingTombstone?.status === "completed") {
    return NextResponse.json(
      DcDeleteInteractionResponseSchema.parse({ deleted: true })
    );
  }
  try {
    const repository = getDateCompanionRepository();
    if (existingTombstone?.status === "pending") {
      if (existingTombstone.expectedVersion !== expectedVersion.version) {
        return NextResponse.json(
          { error: "interaction_delete_replay_conflict" },
          { status: 409 }
        );
      }
      try {
        repository.deleteInteraction(
          auth.authContext.user.id,
          interactionId.data,
          existingTombstone.expectedVersion
        );
      } catch (error) {
        if (!(error instanceof DcNotFoundError)) throw error;
      }
      if (existingTombstone.hybridDeletionRequired) {
        await deleteHybridIndexDeletion(
          auth.authContext.store,
          existingTombstone.sourceUploadId
        );
      }
      await auth.authContext.store.write(
        DELETED_INTERACTION_TOMBSTONES,
        interactionId.data,
        {
          ...existingTombstone,
          status: "completed",
          deletedAt: new Date().toISOString()
        } satisfies CompletedInteractionDeletionTombstone
      );
      return NextResponse.json(
        DcDeleteInteractionResponseSchema.parse({ deleted: true })
      );
    }
    const deletion = repository.prepareInteractionDeletion(
      auth.authContext.user.id,
      interactionId.data,
      expectedVersion.version
    );
    const hybridDeletionRequired = await requiresHybridPermanentIndexDeletion({
      userId: auth.authContext.user.id,
      store: auth.authContext.store,
      uploadId: deletion.sourceUploadId,
      hasLiveUpload: false
    });
    if (hybridDeletionRequired) {
      if (resolvePipelineExecutionMode() !== "queue") {
        return NextResponse.json(
          { error: "hybrid_index_queue_required", deleted: false, retryable: true },
          { status: 503 }
        );
      }
      try {
        const hybridDeletion = await requestHybridPermanentIndexDeletion({
          store: auth.authContext.store,
          uploadId: deletion.sourceUploadId
        });
        if (hybridDeletion.status === "pending") {
          await enqueueEmbeddingIndexJob({
            version: 1,
            userRef: auth.authContext.user.id,
            reason: "permanent_delete"
          });
          return NextResponse.json(
            { error: "hybrid_index_deletion_pending", deleted: false, retryable: true },
            { status: 409, headers: { "Retry-After": "2" } }
          );
        }
        const confirmed = await readHybridIndexDeletion(
          auth.authContext.store,
          deletion.sourceUploadId
        );
        if (confirmed?.status !== "completed") {
          throw new Error("hybrid_index_deletion_not_completed");
        }
      } catch (error) {
        console.error(
          `[date-companion-delete] hybrid_cleanup_failed ` +
          `error_name=${error instanceof Error ? error.name : "unknown"}`
        );
        return NextResponse.json(
          { error: "hybrid_index_deletion_unavailable", deleted: false, retryable: true },
          { status: 503 }
        );
      }
    }
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
    const deletionTombstone = {
      status: "pending",
      interactionId: interactionId.data,
      sourceUploadId: deletion.sourceUploadId,
      expectedVersion: expectedVersion.version,
      hybridDeletionRequired,
      requestedAt: new Date().toISOString()
    } satisfies PendingInteractionDeletionTombstone;
    await auth.authContext.store.write(
      DELETED_INTERACTION_TOMBSTONES,
      interactionId.data,
      deletionTombstone
    );
    repository.deleteInteraction(
      auth.authContext.user.id,
      interactionId.data,
      expectedVersion.version
    );
    if (hybridDeletionRequired) {
      await deleteHybridIndexDeletion(
        auth.authContext.store,
        deletion.sourceUploadId
      );
    }
    await auth.authContext.store.write(
      DELETED_INTERACTION_TOMBSTONES,
      interactionId.data,
      {
        ...deletionTombstone,
        status: "completed",
        deletedAt: new Date().toISOString()
      } satisfies CompletedInteractionDeletionTombstone
    );
    return NextResponse.json(DcDeleteInteractionResponseSchema.parse({ deleted: true }));
  } catch (error) {
    const response = dateCompanionErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
