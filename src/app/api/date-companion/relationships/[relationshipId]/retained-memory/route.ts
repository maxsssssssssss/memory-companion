import { DcIdSchema } from "@/lib/domain/date-companion-stage2";
import {
  getDateCompanionDatabase,
  purgeDateCompanionRetainedMemory
} from "@/lib/server/date-companion";
import {
  dateCompanionAuth,
  dateCompanionErrorResponse,
  readJson
} from "@/lib/server/date-companion/http";
import {
  DateCompanionRetainedMemoryPurgeRequestSchema,
  privateMemoryJson,
  privateMemoryResponse
} from "@/lib/server/date-companion/memory-bridge-api";
import { getMemoryDatabase } from "@/lib/server/memory";
import { resolvePipelineExecutionMode } from "@/lib/server/queue/config";
import { enqueueEmbeddingIndexJob } from "@/lib/server/queue/producer";
import { resolveQaHybridRetrievalMode } from "@/lib/server/retrieval/hybrid/runtime-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ relationshipId: string }> }
) {
  const auth = await dateCompanionAuth(request);
  if ("response" in auth) return privateMemoryResponse(auth.response);
  const id = DcIdSchema.safeParse((await params).relationshipId);
  if (!id.success) return privateMemoryJson({ error: "invalid_relationship_id" }, 400);
  const raw = await readJson(request);
  if ("response" in raw && raw.response) return privateMemoryResponse(raw.response);
  const body = DateCompanionRetainedMemoryPurgeRequestSchema.safeParse(raw.value);
  if (!body.success) return privateMemoryJson({ error: "purge_confirmation_required" }, 400);
  try {
    const purge = purgeDateCompanionRetainedMemory({
      dateCompanionDatabase: getDateCompanionDatabase(),
      memoryDatabase: getMemoryDatabase(),
      userId: auth.authContext.user.id,
      relationshipId: id.data
    });
    if (
      purge.completedCount > 0 &&
      resolvePipelineExecutionMode() === "queue" &&
      resolveQaHybridRetrievalMode() !== "off"
    ) {
      await enqueueEmbeddingIndexJob({
        version: 1,
        userRef: auth.authContext.user.id,
        reason: "upload_deleted"
      }).catch((error: unknown) => {
        console.warn(
          `[hybrid-index-worker] enqueue_failed reason=retained_memory_purge ` +
          `error_name=${error instanceof Error ? error.name : "unknown"}`
        );
      });
    }
    return privateMemoryJson({ purge }, purge.retryable ? 503 : 200);
  } catch (error) {
    const response = dateCompanionErrorResponse(error);
    if (response) return privateMemoryResponse(response);
    throw error;
  }
}
