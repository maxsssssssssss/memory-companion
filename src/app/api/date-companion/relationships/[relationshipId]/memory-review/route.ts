import { DcIdSchema } from "@/lib/domain/date-companion-stage2";
import {
  createDateCompanionMemoryBridgeRepository,
  getDateCompanionDatabase
} from "@/lib/server/date-companion";
import { dateCompanionAuth, dateCompanionErrorResponse } from "@/lib/server/date-companion/http";
import { privateMemoryJson, privateMemoryResponse } from "@/lib/server/date-companion/memory-bridge-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ relationshipId: string }> }
) {
  const auth = await dateCompanionAuth(request);
  if ("response" in auth) return privateMemoryResponse(auth.response);
  const id = DcIdSchema.safeParse((await params).relationshipId);
  if (!id.success) return privateMemoryJson({ error: "invalid_relationship_id" }, 400);
  try {
    const review = createDateCompanionMemoryBridgeRepository(getDateCompanionDatabase())
      .getMemoryReview(auth.authContext.user.id, id.data);
    return privateMemoryJson({ review });
  } catch (error) {
    const response = dateCompanionErrorResponse(error);
    if (response) return privateMemoryResponse(response);
    throw error;
  }
}
