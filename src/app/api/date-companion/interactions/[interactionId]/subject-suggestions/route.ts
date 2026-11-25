import {
  DcIdSchema,
  DcSubjectDraftPreviewSchema,
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
import { getMemoryDatabase } from "@/lib/server/memory";
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
      memoryDatabase: getMemoryDatabase(),
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
    // Draft choices go in a private POST body, including status-only reads.
    // Recording text is always resolved from the authenticated repository.
    const body = await request.text();
    let raw: unknown;
    if (body.length > 0) {
      try {
        raw = JSON.parse(body);
      } catch {
        return privateMemoryJson({ error: "invalid_subject_draft_preview" }, 400);
      }
    }
    const preview = raw === undefined ? undefined : DcSubjectDraftPreviewSchema.safeParse(raw);
    if (preview && !preview.success) return privateMemoryJson({ error: "invalid_subject_draft_preview" }, 400);
    const draftPreview = preview?.data;
    if (new URL(request.url).searchParams.get("read") === "status") {
      if (!draftPreview) return privateMemoryJson({ error: "invalid_subject_draft_preview" }, 400);
      const status = getDateCompanionSubjectSuggestionBatchStatus({
        database: getDateCompanionDatabase(), memoryDatabase: getMemoryDatabase(), userId: auth.authContext.user.id,
        interactionId: interactionId.data, draftPreview
      });
      return privateMemoryJson(DcSubjectSuggestionStatusResponseSchema.parse(status));
    }
    const batch = await getOrCreateDateCompanionSubjectSuggestionBatch({
      database: getDateCompanionDatabase(),
      memoryDatabase: getMemoryDatabase(),
      userId: auth.authContext.user.id,
      interactionId: interactionId.data,
      signal: request.signal,
      draftPreview
    });
    return privateMemoryJson(DcSubjectSuggestionResponseSchema.parse({ batch }));
  } catch (error) {
    const response = dateCompanionErrorResponse(error);
    if (response) return privateMemoryResponse(response);
    throw error;
  }
}
