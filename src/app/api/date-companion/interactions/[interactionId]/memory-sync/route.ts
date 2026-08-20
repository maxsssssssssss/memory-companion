import { DcIdSchema } from "@/lib/domain/date-companion-stage2";
import {
  createDateCompanionMemoryBridgeRepository,
  getDateCompanionDatabase
} from "@/lib/server/date-companion";
import {
  dateCompanionAuth,
  dateCompanionErrorResponse,
  readJson
} from "@/lib/server/date-companion/http";
import {
  DateCompanionMemorySyncRequestSchema,
  privateMemoryJson,
  privateMemoryResponse
} from "@/lib/server/date-companion/memory-bridge-api";
import { getMemoryDatabase } from "@/lib/server/memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ interactionId: string }> }
) {
  const auth = await dateCompanionAuth(request);
  if ("response" in auth) return privateMemoryResponse(auth.response);
  const id = DcIdSchema.safeParse((await params).interactionId);
  if (!id.success) return privateMemoryJson({ error: "invalid_interaction_id" }, 400);
  const raw = await readJson(request);
  if ("response" in raw && raw.response) return privateMemoryResponse(raw.response);
  const body = DateCompanionMemorySyncRequestSchema.safeParse(raw.value);
  if (!body.success) return privateMemoryJson({ error: "invalid_memory_sync_request" }, 400);
  try {
    const dateCompanionDatabase = getDateCompanionDatabase();
    const repository = createDateCompanionMemoryBridgeRepository(dateCompanionDatabase);
    repository.queueInteractionSync({
      userId: auth.authContext.user.id,
      interactionId: id.data,
      mappingVersion: body.data.mappingVersion,
      selections: body.data.selections,
      subjectSuggestionConfirmation: body.data.subjectSuggestionConfirmation,
      relationshipReconfirmation: body.data.relationshipReconfirmation,
      ...(body.data.relationshipReconfirmation ? { memoryDatabase: getMemoryDatabase() } : {})
    });
    const bridge = repository.getInteractionBridgeStatus(auth.authContext.user.id, id.data);
    return privateMemoryJson({ bridge });
  } catch (error) {
    const response = dateCompanionErrorResponse(error);
    if (response) return privateMemoryResponse(response);
    throw error;
  }
}
