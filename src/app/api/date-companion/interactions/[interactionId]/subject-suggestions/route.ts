import {
  DcIdSchema,
  DcSubjectSuggestionResponseSchema,
  DcSubjectSuggestionStatusResponseSchema
} from "@/lib/domain/date-companion-stage2";
import {
  getDateCompanionDatabase,
  getDateCompanionSubjectSuggestionBatchStatus,
  getOrCreateDateCompanionSubjectSuggestionBatch
} from "@/lib/server/date-companion";
import {
  dateCompanionAuth,
  dateCompanionErrorResponse
} from "@/lib/server/date-companion/http";
import {
  privateMemoryJson,
  privateMemoryResponse
} from "@/lib/server/date-companion/memory-bridge-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ interactionId: string }> }
) {
  const auth = await dateCompanionAuth(request);
  if ("response" in auth) return privateMemoryResponse(auth.response);
  const interactionId = DcIdSchema.safeParse((await params).interactionId);
  if (!interactionId.success) return privateMemoryJson({ error: "invalid_interaction_id" }, 400);
  try {
    const status = getDateCompanionSubjectSuggestionBatchStatus({
      database: getDateCompanionDatabase(),
      userId: auth.authContext.user.id,
      interactionId: interactionId.data
    });
    return privateMemoryJson(DcSubjectSuggestionStatusResponseSchema.parse(status));
  } catch (error) {
    const response = dateCompanionErrorResponse(error);
    if (response) return privateMemoryResponse(response);
    throw error;
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ interactionId: string }> }
) {
  const auth = await dateCompanionAuth(request);
  if ("response" in auth) return privateMemoryResponse(auth.response);
  const interactionId = DcIdSchema.safeParse((await params).interactionId);
  if (!interactionId.success) return privateMemoryJson({ error: "invalid_interaction_id" }, 400);
  try {
    const batch = await getOrCreateDateCompanionSubjectSuggestionBatch({
      database: getDateCompanionDatabase(),
      userId: auth.authContext.user.id,
      interactionId: interactionId.data,
      signal: request.signal
    });
    return privateMemoryJson(DcSubjectSuggestionResponseSchema.parse({ batch }));
  } catch (error) {
    const response = dateCompanionErrorResponse(error);
    if (response) return privateMemoryResponse(response);
    throw error;
  }
}
